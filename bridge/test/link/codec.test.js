import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { vectors, hex } from '../vectors.js';
import { crc16 } from '../../src/link/crc16.js';
import { cobsEncode, cobsDecode } from '../../src/link/cobs.js';
import { encodeFrame, decodeChunk } from '../../src/link/frame.js';

const toHex = (b) => Buffer.from(b).toString('hex');

test('crc16 matches the vectors', () => {
  for (const v of vectors.crc16) assert.equal(crc16(hex(v.hex)), v.crc);
});

test('zlib crc32 matches the vectors the firmware also checks', () => {
  for (const v of vectors.crc32) assert.equal(crc32(hex(v.hex)), v.crc);
});

test('cobs encodes and decodes every vector', () => {
  for (const v of vectors.cobs) {
    assert.equal(toHex(cobsEncode(hex(v.decoded))), v.encoded);
    assert.equal(toHex(cobsDecode(hex(v.encoded))), v.decoded);
  }
});

test('cobs rejects malformed input', () => {
  for (const e of vectors.cobsInvalid) assert.equal(cobsDecode(hex(e)), null, e);
});

test('frames encode to the vector wire bytes and decode back', () => {
  for (const f of vectors.frames) {
    const wire = encodeFrame({ type: f.type, flags: f.flags, seq: f.seq, payload: hex(f.payload) });
    assert.equal(toHex(wire), f.wire, f.name);
    const got = decodeChunk(hex(f.wire).subarray(1, -1));
    assert.deepEqual(
      { type: got.type, flags: got.flags, seq: got.seq, payload: got.payload.toString('hex') },
      { type: f.type, flags: f.flags, seq: f.seq, payload: f.payload },
      f.name,
    );
  }
});

test('encodeFrame refuses more than 1024 bytes of payload', () => {
  assert.throws(() => encodeFrame({ type: 0x11, seq: 0, payload: new Uint8Array(1025) }), RangeError);
});

test('frame constants match protocol/frames.md', async () => {
  const { TYPE, FLAG, MAX_PAYLOAD, MAX_CHUNK } = await import('../../src/link/frame.js');
  assert.deepEqual({ ...TYPE }, {
    HELLO: 0x01, PING: 0x02, PONG: 0x03,
    AUDIO_UP: 0x10, AUDIO_DOWN: 0x11, CREDIT: 0x12, PLAYED: 0x13,
    UI: 0x20, BUTTON: 0x21, APPROVAL_REQ: 0x22, APPROVAL_RES: 0x23,
    CMD: 0x30, TEST: 0x31, PAIR: 0x32, NET: 0x33, LOG: 0x3f,
  });
  assert.equal(FLAG.EOS, 1);
  assert.equal(MAX_PAYLOAD, 1024);
  assert.equal(MAX_CHUNK, 1100);
});
