import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import {
  CMD, helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload, testSelftestPayload,
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
  parseUi, parseApprovalReq, parseTestKeys, pairSetPayload, pairForgetPayload, parsePairReply, PAIR_OP,
} from '../../src/link/messages.js';
import { patternBytes } from '../../src/link/pattern.js';

const build = {
  hello_bridge: (f) => helloPayload(f.nonce),
  ping: (f) => pingPayload(f.token),
  cmd_set_volume: (f) => cmdPayload(f.op, f.arg),
  cmd_set_mic_gain: (f) => cmdPayload(f.op, f.arg),
  cmd_stop_audio: (f) => cmdPayload(f.op),
  cmd_boot_app0: (f) => cmdPayload(f.op),
  cmd_reboot: (f) => cmdPayload(f.op),
  cmd_set_codec: (f) => cmdPayload(f.op, f.arg),
  test_up_pattern: (f) => testPayload(f.op, f.frames),
  ui_idle: (f) => uiPayload(f),
  ui_confirm: (f) => uiPayload(f),
  ui_working: (f) => uiPayload(f),
  ui_error: (f) => uiPayload(f),
  approval_req: (f) => approvalReqPayload(f),
  test_keys: (f) => testKeysPayload(f.steps),
  test_mic_source_on: (f) => testMicSourcePayload(f.on),
  test_mic_pcm: (f) => testMicPcmPayload(hex(f.pcm)),
  test_snap: () => testSnapPayload(),
  test_selftest: () => testSelftestPayload(),
  pair_set: (f) => pairSetPayload(hex(f.key)),
  pair_forget: () => pairForgetPayload(),
};
const parse = {
  hello_device: parseHello,
  hello_device_v2: parseHello,
  pair_ok_set: parsePairReply,
  pair_denied_forget: parsePairReply,
  pong: parsePong,
  credit: parseCredit,
  played: parsePlayed,
  button_cancel: parseButton,
  button_stop: parseButton,
  button_dismiss: parseButton,
  button_switching: parseButton,
  approval_res_allow: parseApprovalRes,
  approval_res_deny_reason: parseApprovalRes,
  test_snap_chunk: (p) => ({ ...parseSnapChunk(p), pixels: parseSnapChunk(p).pixels.toString('hex') }),
};
// What the PC sends, read back by the readers a stand-in S3 uses: the vectors must survive the round trip.
const readBack = {
  ui_idle: parseUi,
  ui_confirm: parseUi,
  ui_working: parseUi,
  ui_error: parseUi,
  approval_req: parseApprovalReq,
  test_keys: parseTestKeys,
};

test('payloads the bridge builds match the vectors', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'down')) {
    assert.equal(build[m.name](m.fields).toString('hex'), m.hex, m.name);
  }
});

test('payloads from the S3 parse to the vector fields', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'up')) {
    assert.deepEqual(parse[m.name](hex(m.hex)), m.fields, m.name);
  }
});

test('what the PC sends reads back to the vector fields', () => {
  for (const [name, read] of Object.entries(readBack)) {
    const m = vectors.messages.find((v) => v.name === name);
    assert.deepEqual(read(hex(m.hex)), m.fields, name);
  }
});

test('a pairing key is exactly 32 bytes, and a PAIR reply needs its op and the op it answers', () => {
  assert.throws(() => pairSetPayload(Buffer.alloc(31)), RangeError);
  assert.throws(() => pairSetPayload(Buffer.alloc(33)), RangeError);
  assert.equal(pairSetPayload(Buffer.alloc(32, 1)).length, 33);
  assert.equal(parsePairReply(Buffer.from([3])), null);
  assert.equal(parsePairReply(Buffer.from([1, 1])), null, 'a SET is not a reply');
});

test('payloads that are too short parse to null', () => {
  assert.equal(parseHello(Buffer.alloc(17)), null);
  const v2 = Buffer.alloc(22);
  v2[0] = 2;
  assert.equal(parseHello(v2), null, 'a proto 2 HELLO carries nonceS and flags, 23 bytes before the version');
  v2[0] = 1;
  assert.notEqual(parseHello(v2), null, 'the same bytes are a fine proto 1 HELLO');
  assert.equal(parsePong(Buffer.alloc(15)), null);
  assert.equal(parseCredit(Buffer.alloc(3)), null);
  assert.equal(parsePlayed(Buffer.alloc(16)), null);
  assert.equal(parseButton(Buffer.alloc(0)), null);
  assert.equal(parseApprovalRes(Buffer.alloc(3)), null);
  assert.equal(parseSnapChunk(Buffer.alloc(8)), null);
});

test('the test pattern matches the vectors', () => {
  assert.equal(patternBytes(0, 8).toString('hex'), vectors.pattern.first8);
  assert.equal(patternBytes(80000, 1).readUInt16LE(0), vectors.pattern.at80000);
});

test('cmdPayload refuses arguments the S3 would misread', async () => {
  const { CMD } = await import('../../src/link/messages.js');
  for (const v of [-1, 256, 1.5, NaN]) assert.throws(() => cmdPayload(CMD.SET_VOLUME, v), RangeError, `vol ${v}`);
  for (const g of [0, 65]) assert.throws(() => cmdPayload(CMD.SET_MIC_GAIN, g), RangeError, `gain ${g}`);
  assert.throws(() => cmdPayload(CMD.SET_VOLUME), RangeError);
  assert.throws(() => cmdPayload(CMD.SET_MIC_GAIN), RangeError);
  assert.throws(() => cmdPayload(CMD.STOP_AUDIO, 5), RangeError);
  assert.throws(() => cmdPayload(256), RangeError);
  assert.throws(() => cmdPayload(-1), RangeError);
});

test('cmdPayload accepts the ends of each range', async () => {
  const { CMD } = await import('../../src/link/messages.js');
  assert.equal(cmdPayload(CMD.SET_VOLUME, 0).toString('hex'), '0100');
  assert.equal(cmdPayload(CMD.SET_VOLUME, 255).toString('hex'), '01ff');
  assert.equal(cmdPayload(CMD.SET_MIC_GAIN, 1).toString('hex'), '0201');
  assert.equal(cmdPayload(CMD.SET_MIC_GAIN, 64).toString('hex'), '0240');
});

test('helloPayload refuses nonce 0 and anything outside 32 bits', () => {
  for (const n of [0, 2 ** 32, 1.5]) assert.throws(() => helloPayload(n), RangeError, `nonce ${n}`);
  assert.equal(helloPayload(1).toString('hex'), '0101000000');
  assert.equal(helloPayload(0xffffffff).toString('hex'), '01ffffffff');
});

test('message constants match protocol/frames.md', async () => {
  const { PROTO, CMD, TEST_OP } = await import('../../src/link/messages.js');
  assert.equal(PROTO, 1);
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5, SELFTEST: 6 });
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
});

test('SET_CODEC takes 0 (PCM16) or 1 (ADPCM) and nothing else', () => {
  assert.equal(cmdPayload(CMD.SET_CODEC, 1).toString('hex'), '0601');
  assert.equal(cmdPayload(CMD.SET_CODEC, 0).toString('hex'), '0600');
  for (const arg of [2, 255, -1, 0.5, undefined]) assert.throws(() => cmdPayload(CMD.SET_CODEC, arg), RangeError, `codec ${arg}`);
});
