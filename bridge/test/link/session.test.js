import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cobsDecode, cobsEncode } from '../../src/link/cobs.js';
import { decodeChunk, encodeFrame } from '../../src/link/frame.js';
import { DIR, MAX_PLAIN, OVERHEAD, SEALED, Session, deriveKeys, hkdf } from '../../src/link/session.js';

const sealVectors = JSON.parse(readFileSync(new URL('../../../protocol/seal-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const { master, nonceP, nonceS } = sealVectors.session;

const pair = (opts = {}) => ({
  pc: new Session({ master: hex(master), nonceP, nonceS, role: 'pc', ...opts }),
  s3: new Session({ master: hex(master), nonceP, nonceS, role: 's3', ...opts }),
});
// What the wire carries for a sealed frame, back as a decoded frame (COBS and the CRC included).
const overWire = (frame) => decodeChunk(encodeFrame(frame).subarray(1, -1));
const envelopeOf = (frame) => Buffer.from(cobsDecode(encodeFrame(frame).subarray(1, -1))).toString('hex');
const asFrame = (envelopeHex) => decodeChunk(cobsEncode(hex(envelopeHex)));

test('hkdf gives the two RFC 5869 outputs that were written down by hand', () => {
  const [a, b] = sealVectors.hkdf;
  assert.equal(hkdf(hex(a.ikm), hex(a.salt), hex(a.info), a.length).toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  assert.equal(hkdf(hex(b.ikm), hex(b.salt), hex(b.info), b.length).toString('hex'), '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  for (const v of sealVectors.hkdf) assert.equal(hkdf(hex(v.ikm), hex(v.salt), hex(v.info), v.length).toString('hex'), v.okm, v.name);
});

test('the session keys are the vector keys, one for each direction', () => {
  const k = deriveKeys(hex(master), nonceP, nonceS);
  assert.equal(k.pcToS3.toString('hex'), sealVectors.session.pcToS3);
  assert.equal(k.s3ToPc.toString('hex'), sealVectors.session.s3ToPc);
  assert.notEqual(k.pcToS3.toString('hex'), k.s3ToPc.toString('hex'));
});

test('another nonce on either side gives other keys', () => {
  const a = deriveKeys(hex(master), nonceP, nonceS).pcToS3.toString('hex');
  assert.notEqual(deriveKeys(hex(master), nonceP + 1, nonceS).pcToS3.toString('hex'), a);
  assert.notEqual(deriveKeys(hex(master), nonceP, nonceS + 1).pcToS3.toString('hex'), a);
});

test('sealing builds the vector envelope byte for byte', () => {
  for (const v of sealVectors.frames) {
    const s = new Session({ master: hex(master), nonceP, nonceS, role: v.dir === DIR.PC_TO_S3 ? 'pc' : 's3', counter: v.counter });
    const frame = s.seal({ type: v.type, flags: v.flags, seq: v.seq, payload: hex(v.plain) });
    assert.equal(frame.flags & SEALED, SEALED);
    assert.equal(envelopeOf(frame), v.envelope, `type ${v.type} counter ${v.counter}`);
  }
});

test('the other end opens every vector envelope, and the frame comes out as it went in', () => {
  for (const v of sealVectors.frames) {
    const s = new Session({ master: hex(master), nonceP, nonceS, role: v.dir === DIR.PC_TO_S3 ? 's3' : 'pc' });
    const r = s.open(asFrame(v.envelope));
    assert.equal(r.ok, true, `type ${v.type}`);
    assert.equal(r.frame.type, v.type);
    assert.equal(r.frame.flags, v.flags);
    assert.equal(r.frame.seq, v.seq);
    assert.equal(r.frame.payload.toString('hex'), v.plain);
  }
});

test('a frame sealed here crosses the wire and opens at the other end', () => {
  const { pc, s3 } = pair();
  const r = s3.open(overWire(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 2, 3, 4]) })));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.frame.payload], [1, 2, 3, 4]);
  const back = pc.open(overWire(s3.seal({ type: 0x03, seq: 1, payload: Buffer.from('pong') })));
  assert.equal(back.ok, true);
  assert.equal(back.frame.payload.toString(), 'pong');
});

test('a changed byte anywhere in a sealed frame is refused', () => {
  const v = sealVectors.frames[2];
  const env = hex(v.envelope);
  // type, flags, seq, counter, a ciphertext byte, and the last byte of the tag. (len and the CRC are the wire layer's.)
  for (const at of [0, 1, 2, 6, 10, env.length - 3]) {
    const bad = Buffer.from(env);
    bad[at] ^= 0x01;
    const s = new Session({ master: hex(master), nonceP, nonceS, role: 'pc' });
    const frame = { type: bad[0], flags: bad[1], seq: bad.readUInt16LE(2), payload: bad.subarray(6, bad.length - 2) };
    const r = s.open(frame);
    assert.equal(r.ok, false, `byte ${at}`);
  }
});

test('the receive rule accepts a counter only when it is above every one accepted before', () => {
  const s = new Session({ master: hex(master), nonceP, nonceS, role: 's3' });
  const got = sealVectors.replay.counters.map((counter) => {
    const f = new Session({ master: hex(master), nonceP, nonceS, role: 'pc', counter }).seal({ type: 0x02, seq: 0, payload: Buffer.from([0, 0, 0, 0]) });
    return s.open(f).ok ? 1 : 0;
  });
  assert.deepEqual(got, sealVectors.replay.accepted);
});

test('a replayed frame is refused with the reason replay, and does not move the counter', () => {
  const { pc, s3 } = pair();
  const f1 = pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) });
  const f2 = pc.seal({ type: 0x02, seq: 2, payload: Buffer.from([2, 0, 0, 0]) });
  assert.equal(s3.open(f2).ok, true);
  const again = s3.open(f2);
  assert.deepEqual([again.ok, again.reason], [false, 'replay']);
  const late = s3.open(f1);
  assert.deepEqual([late.ok, late.reason], [false, 'replay']);
});

test('a frame that fails the tag does not move the counter, so the real one still opens', () => {
  const { pc, s3 } = pair();
  const f = pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) });
  const forged = { ...f, payload: Buffer.from(f.payload) };
  forged.payload[forged.payload.length - 1] ^= 0xff;
  const bad = s3.open(forged);
  assert.deepEqual([bad.ok, bad.reason], [false, 'tag']);
  assert.equal(s3.open(f).ok, true);
});

test('a frame without the seal bit, or too short to hold a counter and a tag, is refused', () => {
  const { s3 } = pair();
  const plain = s3.open({ type: 0x02, flags: 0, seq: 0, payload: Buffer.from([1, 0, 0, 0]) });
  assert.deepEqual([plain.ok, plain.reason], [false, 'plain']);
  const short = s3.open({ type: 0x02, flags: SEALED, seq: 0, payload: Buffer.alloc(OVERHEAD - 1) });
  assert.deepEqual([short.ok, short.reason], [false, 'short']);
});

test('a session cannot open what it sealed itself: the two directions have two keys', () => {
  const { pc } = pair();
  const r = pc.open(pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) }));
  assert.deepEqual([r.ok, r.reason], [false, 'tag']);
});

test('failures counts the refusals in a row and goes back to zero at the first frame that opens', () => {
  const { pc, s3 } = pair();
  const bad = { type: 0x02, flags: 0, seq: 0, payload: Buffer.from([1, 0, 0, 0]) };
  s3.open(bad);
  s3.open(bad);
  assert.equal(s3.failures, 2);
  assert.equal(s3.open(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) })).ok, true);
  assert.equal(s3.failures, 0);
});

test('a session of other nonces cannot open the frames of this one', () => {
  const { pc } = pair();
  const other = new Session({ master: hex(master), nonceP, nonceS: nonceS + 1, role: 's3' });
  assert.equal(other.open(pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) })).ok, false);
  const wrongKey = new Session({ master: Buffer.alloc(32, 9), nonceP, nonceS, role: 's3' });
  assert.equal(wrongKey.open(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) })).ok, false);
});

test('the largest payload that seals is 1004 bytes, and one more is refused', () => {
  const { pc, s3 } = pair();
  assert.equal(MAX_PLAIN, 1004);
  assert.equal(s3.open(overWire(pc.seal({ type: 0x11, seq: 0, payload: Buffer.alloc(1004, 7) }))).ok, true);
  assert.throws(() => pc.seal({ type: 0x11, seq: 1, payload: Buffer.alloc(1005) }), RangeError);
});

test('the send counter ends at 2^32 - 1: that one frame goes, and the next is refused', () => {
  const { pc } = pair({ counter: 0xffffffff });
  assert.doesNotThrow(() => pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) }));
  assert.throws(() => pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) }), /counter/);
});

test('an empty payload seals and opens', () => {
  const { pc, s3 } = pair();
  const r = s3.open(overWire(pc.seal({ type: 0x3f, seq: 3 })));
  assert.equal(r.ok, true);
  assert.equal(r.frame.payload.length, 0);
});
