// Gate L: walkie away from the cable, through a real relay (normally the deployed one), with no S3, no COM port and no API. A stand-in
// S3 (the tests' FakeS3) holding a throwaway pairing key joins the relay as the device, as the S3's netlink does, and a Link with the same
// key joins as the PC, as the bridge does. Neither touches %APPDATA%\walkie\pair.key; the room is one nobody else will ever use.
import { randomBytes } from 'node:crypto';
import { Link } from '../../bridge/src/link/link.js';
import { openRelayPort } from '../../bridge/src/link/relay-port.js';
import { roomId } from '../../bridge/src/link/room.js';
import { FakeS3 } from '../../bridge/test/helpers/fake-s3.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(50);
  return check();
};

// Runs the scenes in order and stops at the first that fails, since the ones after it build on it. `holdMs`: how long the link must stay
// up untouched (past two of the relay's 30 s keep-alive pings by default). `clock`: the PC end's ping clock, for a test that cannot wait
// out the relay port's 5 s / 10 s. `standIn(master)`: the S3 to use. Resolves with true when every scene held; a relay that goes away
// in the middle is a failed scene, never a throw.
export async function runGateL({
  host,
  holdMs = 75_000,
  waitMs = 20_000,
  clock = null,
  say = console.log,
  standIn = (master) => new FakeS3({ proto: 2, master }),
}) {
  const master = randomBytes(32);
  const room = roomId(master);
  const s3 = standIn(master);
  let device = null;
  let link = null;
  const pass = (name, ok, detail = '') => {
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    return ok;
  };

  s3.on('data', (wire) => device?.write(wire));
  const join = async () => {
    const port = await openRelayPort({ host, room, role: 'device' });
    port.on('data', (wire) => s3.write(wire));
    port.on('close', () => {
      if (device === port) device = null;
    });
    device = port;
  };

  try {
    try {
      await join();
    } catch (err) {
      return pass('the S3 joins its room on the relay', false, err.message);
    }
    pass('the S3 joins its room on the relay', true, `room ${room.slice(0, 6)}…`);

    const down = [];
    let pongs = 0;
    const openPort = async () => {
      const port = await openRelayPort({ host, room });
      return clock ? Object.assign(port, clock) : port;
    };
    link = new Link({ openPort, master, retryMs: 1000, retryMaxMs: 4000 });
    link.on('down', (reason) => down.push(reason));
    link.on('pong', () => pongs++);
    link.on('status', () => {});
    await link.start();
    if (!pass('the PC reaches it and the link is sealed', await waitFor(() => link.ready, waitMs))) return false;

    const before = pongs;
    await sleep(holdMs);
    const held = down.length === 0 && device !== null && pongs > before; // a ready link only stops being ready by dropping
    if (!pass(`it stays up for ${holdMs / 1000} s with nobody talking`, held, `${pongs - before} PONGs, ${down.length} drops`)) return false;

    device.close();
    if (!pass('the PC notices when the S3 leaves', await waitFor(() => !link.ready, waitMs), down[0] ?? 'still ready')) return false;
    try {
      await join();
    } catch (err) {
      return pass('and is sealed again when it comes back', false, err.message);
    }
    if (!pass('and is sealed again when it comes back', await waitFor(() => link.ready, waitMs))) return false;

    link.close();
    link = null;
    try {
      const first = await openRelayPort({ host, room });
      const second = await openRelayPort({ host, room });
      const replaced = await waitFor(() => first.replaced, waitMs);
      second.close();
      return pass('a second PC in the room replaces the first', replaced, `close code ${first.closeCode}`);
    } catch (err) {
      return pass('a second PC in the room replaces the first', false, err.message);
    }
  } finally {
    link?.close();
    device?.close();
  }
}
