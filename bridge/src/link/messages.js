// Payloads of the link's frame types (protocol/frames.md). Integers are little endian.
export const PROTO = 1;
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5, SELFTEST: 6 });
export const PAIR_OP = Object.freeze({ SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
export const UI_STATE = Object.freeze({ IDLE: 0, TRANSCRIBING: 1, CONFIRM: 2, WORKING: 3, REPLY: 4, ERROR: 5 });
export const BUTTON = Object.freeze({ CANCEL: 1, STOP: 2, DISMISS: 3, SWITCHING: 4 });
export const KEY = Object.freeze({ FRONT: 1, SIDE: 2 }); // the bits of a TEST KEYS mask
// What one UI or APPROVAL_REQ field may hold, in UTF-8 bytes, so that a frame stays within 1024 bytes.
export const LIMITS = Object.freeze({ project: 60, tool: 64, text: 900, preview: 900, keySteps: 16, micPcm: 1000 });

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// nonce 0 is reserved for the S3's boot HELLO.
export function helloPayload(nonce) {
  if (!isInt(nonce, 1, 0xffffffff)) throw new RangeError(`HELLO nonce must be an integer 1..0xFFFFFFFF, not ${nonce}`);
  const b = Buffer.alloc(5);
  b[0] = PROTO;
  b.writeUInt32LE(nonce >>> 0, 1);
  return b;
}

export function pingPayload(token) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(token >>> 0);
  return b;
}

export function cmdPayload(op, arg) {
  if (!isInt(op, 0, 255)) throw new RangeError(`CMD op must be an integer 0..255, not ${op}`);
  switch (op) {
    case CMD.SET_VOLUME:
      if (!isInt(arg, 0, 255)) throw new RangeError(`volume must be an integer 0..255, not ${arg}`);
      break;
    case CMD.SET_MIC_GAIN:
      if (!isInt(arg, 1, 64)) throw new RangeError(`mic gain must be an integer 1..64, not ${arg}`);
      break;
    case CMD.SET_CODEC:
      if (!isInt(arg, 0, 1)) throw new RangeError(`codec must be 0 (PCM16) or 1 (ADPCM), not ${arg}`);
      break;
    case CMD.STOP_AUDIO:
    case CMD.BOOT_APP0:
    case CMD.REBOOT:
      if (arg !== undefined) throw new RangeError(`CMD ${op} takes no argument`);
      break;
    default:
      if (arg !== undefined && !isInt(arg, 0, 255)) throw new RangeError(`CMD argument must be an integer 0..255, not ${arg}`);
  }
  return arg === undefined ? Buffer.from([op]) : Buffer.from([op, arg]);
}

export function testPayload(op, frames) {
  const b = Buffer.alloc(3);
  b[0] = op;
  b.writeUInt16LE(frames, 1);
  return b;
}

// PAIR (protocol/frames.md, "Pairing"): SET carries the 32-byte key, FORGET nothing; the S3 answers OK or DENIED with the op it answers.
export function pairSetPayload(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new RangeError('a pairing key is 32 bytes');
  return Buffer.concat([Buffer.from([PAIR_OP.SET]), key]);
}

export function pairForgetPayload() {
  return Buffer.from([PAIR_OP.FORGET]);
}

export function parsePairReply(p) {
  if (p.length < 2 || (p[0] !== PAIR_OP.OK && p[0] !== PAIR_OP.DENIED)) return null;
  return { op: p[0], answered: p[1] };
}

// NET (protocol/frames.md, "Network settings (plan 6)"): the Wi-Fi networks and the relay host of a paired S3, set over a sealed link.
// A request is the op and its arguments, each text led by its length in one byte. The S3 answers OK, ERR or LIST.
export const NET_OP = Object.freeze({ WIFI_ADD: 1, WIFI_REMOVE: 2, WIFI_LIST: 3, RELAY_SET: 4, RELAY_CLEAR: 5, OK: 0x80, ERR: 0x81, LIST: 0x82 });
export const NET_ERR = Object.freeze({ BAD: 1, FULL: 2, UNKNOWN: 3, STORE: 4 });
// Bytes: an SSID is 1 to 32, a password 8 to 63 (or none, an open network), a host 1 to 63 of letters, digits, dots and hyphens.
export const NET_LIMITS = Object.freeze({ ssid: 32, pass: 63, host: 63, networks: 4 });
const HOST_RE = /^[A-Za-z0-9.-]+$/;

function netText(value, what, min, max) {
  if (typeof value !== 'string') throw new TypeError(`the ${what} must be a string`);
  const b = Buffer.from(value, 'utf8');
  if (b.includes(0)) throw new RangeError(`the ${what} must not hold a NUL byte`);
  if (b.length < min || b.length > max) throw new RangeError(`the ${what} must be ${min === 0 ? 'at most' : `${min} to`} ${max} bytes (it is ${b.length})`);
  return Buffer.concat([Buffer.from([b.length]), b]);
}

export function netWifiAddPayload(ssid, pass) {
  const s = netText(ssid, 'ssid', 1, NET_LIMITS.ssid);
  const p = netText(pass, 'password', 0, NET_LIMITS.pass);
  if (p[0] > 0 && p[0] < 8) throw new RangeError(`the password must be 8 to ${NET_LIMITS.pass} bytes, or empty for an open network (it is ${p[0]})`);
  return Buffer.concat([Buffer.from([NET_OP.WIFI_ADD]), s, p]);
}

export function netWifiRemovePayload(ssid) {
  return Buffer.concat([Buffer.from([NET_OP.WIFI_REMOVE]), netText(ssid, 'ssid', 1, NET_LIMITS.ssid)]);
}

export function netWifiListPayload() {
  return Buffer.from([NET_OP.WIFI_LIST]);
}

export function netRelaySetPayload(host) {
  const h = netText(host, 'relay host', 1, NET_LIMITS.host);
  if (!HOST_RE.test(host)) throw new RangeError('the relay host may hold only letters, digits, dots and hyphens');
  return Buffer.concat([Buffer.from([NET_OP.RELAY_SET]), h]);
}

export function netRelayClearPayload() {
  return Buffer.from([NET_OP.RELAY_CLEAR]);
}

// OK is [0x80, answered], ERR is [0x81, answered, reason], LIST is [0x82, count, (len, ssid) x count, hostLen, host]: exactly that, or null.
export function parseNetReply(p) {
  if (p.length < 1) return null;
  if (p[0] === NET_OP.OK) return p.length === 2 ? { kind: 'ok', answered: p[1] } : null;
  if (p[0] === NET_OP.ERR) return p.length === 3 ? { kind: 'err', answered: p[1], reason: p[2] } : null;
  if (p[0] !== NET_OP.LIST || p.length < 3 || p[1] > NET_LIMITS.networks) return null;
  const ssids = [];
  let at = 2;
  for (let i = 0; i < p[1]; i++) {
    const n = p[at];
    if (n === undefined || n < 1 || n > NET_LIMITS.ssid || at + 1 + n > p.length) return null;
    ssids.push(p.subarray(at + 1, at + 1 + n).toString('utf8'));
    at += 1 + n;
  }
  const hn = p[at];
  if (hn === undefined || hn > NET_LIMITS.host || at + 1 + hn !== p.length) return null;
  return { kind: 'list', ssids, host: hn === 0 ? null : p.subarray(at + 1).toString('latin1') };
}

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
// keys, and a flags byte: bit 0 is set when it is paired, bit 1 when it takes ADPCM.
export const HELLO_FLAG = Object.freeze({ PAIRED: 1, ADPCM: 2 });
export function parseHello(p) {
  if (p.length < 18) return null;
  const hello = {
    proto: p[0],
    upRate: p.readUInt16LE(2),
    downRate: p.readUInt16LE(4),
    ringBytes: p.readUInt32LE(6),
    uptimeMs: p.readUInt32LE(10),
    nonce: p.readUInt32LE(14),
  };
  if (p[0] < 2) return { ...hello, version: p.subarray(18).toString('utf8') };
  if (p.length < 23) return null;
  return {
    ...hello,
    nonceS: p.readUInt32LE(18),
    paired: (p[22] & HELLO_FLAG.PAIRED) !== 0,
    adpcm: (p[22] & HELLO_FLAG.ADPCM) !== 0,
    version: p.subarray(23).toString('utf8'),
  };
}

export function parsePong(p) {
  if (p.length < 16) return null;
  return { token: p.readUInt32LE(0), uptimeMs: p.readUInt32LE(4), badChunks: p.readUInt32LE(8), seqGaps: p.readUInt32LE(12) };
}

export function parseCredit(p) {
  return p.length < 4 ? null : { bytes: p.readUInt32LE(0) };
}

export function parsePlayed(p) {
  if (p.length < 17) return null;
  return {
    bytes: p.readUInt32LE(0),
    crc32: p.readUInt32LE(4),
    underruns: p.readUInt32LE(8),
    maxFill: p.readUInt32LE(12),
    reason: p[16],
  };
}

const TAG = Object.freeze({ PROJECT: 1, TEXT: 2, ELAPSED_MS: 3 });

// `text` cut to at most `max` UTF-8 bytes on a character boundary (a surrogate pair is never split). A cut ends with an
// ellipsis, so that a reader can tell it was cut.
export function clipUtf8(text, max) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max - 3) break; // the ellipsis is 3 bytes
    out += ch;
    bytes += n;
  }
  return `${out}…`;
}

function field(tag, body) {
  const head = Buffer.alloc(3);
  head[0] = tag;
  head.writeUInt16LE(body.length, 1);
  return Buffer.concat([head, body]);
}

// UI (PC to S3): the state, then the fields that are present. Text that is too long is cut (LIMITS); the full text is for
// the console.
export function uiPayload({ state, project, text, elapsedMs } = {}) {
  if (!Object.values(UI_STATE).includes(state)) throw new RangeError(`UI state must be one of 0..5, not ${state}`);
  const parts = [Buffer.from([state])];
  if (project) parts.push(field(TAG.PROJECT, Buffer.from(clipUtf8(project, LIMITS.project))));
  if (text) parts.push(field(TAG.TEXT, Buffer.from(clipUtf8(text, LIMITS.text))));
  if (elapsedMs !== undefined && elapsedMs !== null) {
    if (!isInt(elapsedMs, 0, 0xffffffff)) throw new RangeError(`elapsedMs must be an integer 0..0xFFFFFFFF, not ${elapsedMs}`);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(elapsedMs);
    parts.push(field(TAG.ELAPSED_MS, b));
  }
  return Buffer.concat(parts);
}

// APPROVAL_REQ (PC to S3): the id the answer must carry, the tool's name and the preview of what it would do.
export function approvalReqPayload({ id, tool, preview }) {
  if (!isInt(id, 0, 0xffff)) throw new RangeError(`approval id must be an integer 0..65535, not ${id}`);
  const name = Buffer.from(clipUtf8(tool, LIMITS.tool));
  const head = Buffer.alloc(3);
  head.writeUInt16LE(id, 0);
  head[2] = name.length;
  return Buffer.concat([head, name, Buffer.from(clipUtf8(preview, LIMITS.preview))]);
}

// TEST KEYS: the keys' states over time, each step "after delayMs, the keys held are `mask`" (KEY bits).
export function testKeysPayload(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > LIMITS.keySteps) {
    throw new RangeError(`a key script has 1 to ${LIMITS.keySteps} steps`);
  }
  const b = Buffer.alloc(2 + steps.length * 3);
  b[0] = TEST_OP.KEYS;
  b[1] = steps.length;
  steps.forEach(({ delayMs, mask }, i) => {
    if (!isInt(delayMs, 0, 0xffff)) throw new RangeError(`step ${i}: delayMs must be an integer 0..65535, not ${delayMs}`);
    if (!isInt(mask, 0, KEY.FRONT | KEY.SIDE)) throw new RangeError(`step ${i}: mask must be 0..3, not ${mask}`);
    b.writeUInt16LE(delayMs, 2 + i * 3);
    b[4 + i * 3] = mask;
  });
  return b;
}

export const testMicSourcePayload = (on) => Buffer.from([TEST_OP.MIC_SOURCE, on ? 1 : 0]);
export const testSnapPayload = () => Buffer.from([TEST_OP.SNAP]);
export const testSelftestPayload = () => Buffer.from([TEST_OP.SELFTEST]);

// TEST MIC_PCM: PCM16 at 16 kHz that the S3 uses as the mic's output while MIC_SOURCE is on.
export function testMicPcmPayload(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length > LIMITS.micPcm || pcm.length % 2) {
    throw new RangeError(`mic PCM is 2 to ${LIMITS.micPcm} bytes, an even number`);
  }
  return Buffer.concat([Buffer.from([TEST_OP.MIC_PCM]), pcm]);
}

// BUTTON (S3 to PC).
export function parseButton(p) {
  return p.length < 1 ? null : { event: p[0] };
}

// APPROVAL_RES (S3 to PC).
export function parseApprovalRes(p) {
  return p.length < 4 ? null : { id: p.readUInt16LE(0), allow: p[2] === 1, reasonFollows: p[3] === 1 };
}

// TEST SNAP, from the S3: one slice of the screen, RGB565 little endian, row by row.
export function parseSnapChunk(p) {
  if (p.length < 9 || p[0] !== TEST_OP.SNAP) return null;
  return {
    op: TEST_OP.SNAP,
    index: p.readUInt16LE(1),
    count: p.readUInt16LE(3),
    width: p.readUInt16LE(5),
    height: p.readUInt16LE(7),
    pixels: p.subarray(9),
  };
}

// What the PC sends, read back: for the stand-in S3 in tests, and for `walkie-dev` to show.
export function parseUi(p) {
  if (p.length < 1 || p[0] > UI_STATE.ERROR) return null;
  const view = { state: p[0] };
  for (let at = 1; at < p.length; ) {
    if (at + 3 > p.length) return null;
    const tag = p[at];
    const len = p.readUInt16LE(at + 1);
    if (at + 3 + len > p.length) return null;
    const body = p.subarray(at + 3, at + 3 + len);
    if (tag === TAG.PROJECT) view.project = body.toString('utf8');
    else if (tag === TAG.TEXT) view.text = body.toString('utf8');
    else if (tag === TAG.ELAPSED_MS && len === 4) view.elapsedMs = body.readUInt32LE(0);
    at += 3 + len; // a tag this version does not know is skipped
  }
  return view;
}

export function parseApprovalReq(p) {
  if (p.length < 3 || 3 + p[2] > p.length) return null;
  return { id: p.readUInt16LE(0), tool: p.subarray(3, 3 + p[2]).toString('utf8'), preview: p.subarray(3 + p[2]).toString('utf8') };
}

export function parseTestKeys(p) {
  if (p.length < 2 || p[0] !== TEST_OP.KEYS || p[1] < 1 || p.length !== 2 + p[1] * 3) return null;
  return { op: TEST_OP.KEYS, steps: Array.from({ length: p[1] }, (_, i) => ({ delayMs: p.readUInt16LE(2 + i * 3), mask: p[4 + i * 3] })) };
}
