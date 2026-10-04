// The relay host (protocol/frames.md, "Relay"): a host name in %APPDATA%\walkie\relay.txt, beside the pairing key. Without one the bridge
// goes by the cable alone. It is not a secret (the room is, and the room comes from the key), so it may appear in errors and logs.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { relayUrl } from '../link/relay-port.js';

export function defaultRelayFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'relay.txt') : null;
}

// What a person typed, as it is kept: trimmed, one trailing slash dropped. Throws RangeError unless it is a host name the relay port
// accepts (wss for a host, plain ws only for this machine).
export function normalizeRelayHost(text) {
  const host = String(text ?? '').trim().replace(/\/$/, '');
  relayUrl(host, '0'.repeat(32), 'pc'); // the one place that knows what a host may look like
  return host;
}

// The host, or null when none is set.
export function loadRelayHost({ file = defaultRelayFile(), read = readFileSync } = {}) {
  if (!file) return null;
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read the relay file ${file} (${err.code ?? 'error'})`);
  }
  if (text.trim() === '') return null;
  try {
    return normalizeRelayHost(text);
  } catch {
    throw new Error(`the relay file ${file} does not hold a host name`);
  }
}

// Written beside itself and renamed over, so that a reader never meets half a host. Returns the host as kept.
export function saveRelayHost(text, { file = defaultRelayFile() } = {}) {
  const host = normalizeRelayHost(text);
  if (!file) throw new Error('there is nowhere to keep a relay host: %APPDATA% is not set');
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${host}\n`);
  renameSync(tmp, file);
  return host;
}

export function clearRelayHost({ file = defaultRelayFile() } = {}) {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
