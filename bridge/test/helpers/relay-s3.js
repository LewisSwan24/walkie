// The stand-in S3 behind a real relay. The relay is relay/src/server.js on a local port; the S3 joins its room as a device through the
// same port code the bridge uses (role 'device'), and hands every frame to a FakeS3 and every FakeS3 frame back. The bridge opens the
// other end with `openPort`. The S3 can be taken away and put back, as a power cycle or a lost Wi-Fi would.
import { startRelay } from '../../../relay/src/server.js';
import { openRelayPort } from '../../src/link/relay-port.js';
import { roomId } from '../../src/link/room.js';

// `master`: the pairing key, which names the room as it does for real. `clock`: a port clock for the bridge's end, e.g.
// { pingEveryMs: 100, pongTimeoutMs: 400 }, so a test need not wait out a relay's 5 s. `relay`: an already running relay to join.
export async function relayedS3(t, s3, { master = null, clock = null, relay = null, rejoinMs = 50 } = {}) {
  const owned = relay === null;
  const server = relay ?? (await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 }));
  const room = master ? roomId(master) : 'd'.repeat(32);
  const host = `ws://127.0.0.1:${server.port}`;
  let present = true;
  let device = null;

  s3.on('data', (wire) => device?.write(wire)); // an S3 that is not in the room says nothing to anyone

  async function join() {
    if (!present || device) return;
    let port;
    try {
      port = await openRelayPort({ host, room, role: 'device', connectTimeoutMs: 1000 });
    } catch {
      if (present) setTimeout(join, rejoinMs); // the relay is not there (yet)
      return;
    }
    if (!present) {
      port.close();
      return;
    }
    device = port;
    port.on('data', (wire) => s3.write(wire));
    port.on('close', () => {
      if (device === port) device = null;
      if (present) setTimeout(join, rejoinMs);
    });
  }
  await join();

  const handle = {
    relay: server,
    room,
    host,
    // The bridge's end of the relay.
    openPort: async () => {
      const port = await openRelayPort({ host, room, connectTimeoutMs: 1000 });
      return clock ? Object.assign(port, clock) : port;
    },
    // The S3 goes away (no more frames either way) and comes back.
    unplug() {
      present = false;
      device?.close();
      device = null;
    },
    plug() {
      present = true;
      return join();
    },
    get joined() {
      return device !== null;
    },
  };
  t.after(async () => {
    present = false;
    device?.close();
    if (owned) await server.close();
  });
  return handle;
}
