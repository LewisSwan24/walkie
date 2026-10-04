// The pairing key (protocol/frames.md, "Pairing"): 32 bytes in %APPDATA%\walkie\pair.key, written as 64 hex characters and a newline. It
// goes nowhere else: not into errors, not into logs, and nothing here says what it is, only where it lives and whether it is usable.
//
// A new key is written first as a candidate, pair.key.new, and renamed over pair.key only once the walkie has said OK. A key that was
// never accepted does not replace one that works, and a crash between the walkie's OK and the rename leaves the candidate behind, so
// the next `walkie pair` can offer the very same key again and the walkie accepts it without asking.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const KEY_BYTES = 32;

export function defaultPairKeyFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'pair.key') : null;
}

const candidateOf = (file) => `${file}.new`;

function parse(text, file) {
  const hex = text.trim(); // trim() drops a BOM and CRLF too
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`the pairing key file ${file} is not a key (64 hex characters expected)`);
  return Buffer.from(hex, 'hex');
}

function load(file, read) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read the pairing key file ${file} (${err.code ?? 'error'})`);
  }
  return parse(text, file);
}

// The key as 32 bytes, or null when this PC has none.
export function loadPairKey({ file = defaultPairKeyFile(), read = readFileSync } = {}) {
  return file ? load(file, read) : null;
}

// The candidate an earlier `walkie pair` left, or null.
export function loadPairCandidate({ file = defaultPairKeyFile(), read = readFileSync } = {}) {
  return file ? load(candidateOf(file), read) : null;
}

export function writePairCandidate(key, { file = defaultPairKeyFile() } = {}) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new RangeError(`a pairing key is ${KEY_BYTES} bytes`);
  if (!file) throw new Error('there is nowhere to keep a pairing key: %APPDATA% is not set');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(candidateOf(file), `${Buffer.from(key).toString('hex')}\n`, { mode: 0o600 });
}

// The rename replaces pair.key in one step: there is never a moment with no key, or with half of one.
export function commitPairKey({ file = defaultPairKeyFile() } = {}) {
  try {
    renameSync(candidateOf(file), file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no pairing key to commit: ${candidateOf(file)} is not there`);
    throw err;
  }
}

function remove(file) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function discardPairCandidate({ file = defaultPairKeyFile() } = {}) {
  remove(candidateOf(file));
}

export function forgetPairKey({ file = defaultPairKeyFile() } = {}) {
  remove(candidateOf(file));
  remove(file);
}
