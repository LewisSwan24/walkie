// `walkie relay`: the relay host on this PC. With a host it sets it, with --forget it clears it, with neither it says what is set.
import { clearRelayHost, defaultRelayFile, loadRelayHost, normalizeRelayHost, saveRelayHost } from './config/relay.js';

// `walkie relay <host>` or `--forget` with the S3 told too: the S3 first, over the relay it is on now (`via`), and this PC only once the
// S3 has said yes. The other way round leaves the PC on the new relay and the S3 on the old one, with only the cable to bring them back.
// `push({ host, forget, master, via })` resolves with an exit code. With --pc-only, or no pairing key, only this PC changes.
export async function relayChange({ host = null, forget = false, pcOnly = false, file = defaultRelayFile(), read, loadKey, push, say = console.log, err = console.error }) {
  if (pcOnly || (host === null && !forget)) return relayCommand({ host, forget, file, read, say, err });
  let wanted = null;
  let master;
  try {
    if (!forget) wanted = normalizeRelayHost(host);
  } catch (e) {
    err(`walkie: ${e.message}`);
    return 2;
  }
  try {
    master = loadKey();
  } catch (e) {
    err(e.message);
    return 1;
  }
  if (!master) {
    const code = relayCommand({ host, forget, file, read, say, err });
    if (code === 0) say('not paired, so the S3 was not told (node bridge/bin/walkie.js pair, then this again)');
    return code;
  }
  let via = null;
  try {
    via = loadRelayHost({ file, read });
  } catch {} // a relay file that cannot be read: the S3 can still be told over the cable
  let code;
  try {
    code = await push({ host: wanted, forget, master, via });
  } catch (e) {
    err(e.message);
    code = 1;
  }
  if (code !== 0) {
    err(`the relay on this PC is unchanged (${via ?? 'none'}); --pc-only changes it here alone`);
    return code;
  }
  return relayCommand({ host: wanted, forget, file, read, say, err });
}

export function relayCommand({ host = null, forget = false, file = defaultRelayFile(), read, say = console.log, err = console.error }) {
  try {
    if (forget) {
      clearRelayHost({ file });
      say('relay forgotten on this PC');
      return 0;
    }
    if (host !== null) {
      say(`relay set on this PC: ${saveRelayHost(host, { file })}`);
      return 0;
    }
    const current = loadRelayHost({ file, read });
    say(current ? `relay: ${current}` : 'relay: none set (node bridge/bin/walkie.js relay <host>)');
    return 0;
  } catch (e) {
    const usage = e instanceof RangeError; // what was typed is not a host name
    err(usage ? `walkie: ${e.message}` : e.message);
    return usage ? 2 : 1;
  }
}
