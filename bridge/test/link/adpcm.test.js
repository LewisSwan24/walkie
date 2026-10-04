import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import { INDEX_TABLE, STEP_TABLE, decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';

const toHex = (b) => Buffer.from(b).toString('hex');
const pcmOf = (samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const tone = (n, hz, rate, amp) => pcmOf(Array.from({ length: n }, (_, k) => Math.round(amp * Math.sin((2 * Math.PI * hz * k) / rate))));

test('the step and index tables are the reference tables', () => {
  assert.deepEqual([...STEP_TABLE], vectors.adpcm.steps);
  assert.deepEqual([...INDEX_TABLE], vectors.adpcm.indexTable);
});

test('encoding gives the vector frame and the vector step index, for every case', () => {
  for (const c of vectors.adpcm.cases) {
    const r = encodeAdpcm(hex(c.pcm), c.indexIn);
    assert.equal(toHex(r.frame), c.frame, c.name);
    assert.equal(r.index, c.indexOut, c.name);
  }
});

test('decoding gives the vector samples, bit for bit, for every case', () => {
  for (const c of vectors.adpcm.cases) assert.equal(toHex(decodeAdpcm(hex(c.frame))), c.decoded, c.name);
});

test('20 ms of speech is 164 bytes at 16 kHz and 244 at 24 kHz, and decodes to as many samples as went in', () => {
  const up = encodeAdpcm(tone(320, 440, 16000, 8000), 0);
  assert.equal(up.frame.length, 164);
  assert.equal(decodeAdpcm(up.frame).length, 640);
  const down = encodeAdpcm(tone(480, 300, 24000, 8000), 0);
  assert.equal(down.frame.length, 244);
  assert.equal(decodeAdpcm(down.frame).length, 960);
});

test('a decoded tone stays close to the original once the step index has settled: the error is well under the signal', () => {
  const both = tone(640, 440, 16000, 12000);
  const settled = encodeAdpcm(both.subarray(0, 640), 0).index; // the index the encoder carries from the frame before
  const pcm = both.subarray(640);
  const back = decodeAdpcm(encodeAdpcm(pcm, settled).frame);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < 320; i++) {
    const a = pcm.readInt16LE(i * 2);
    const d = a - back.readInt16LE(i * 2);
    sig += a * a;
    err += d * d;
  }
  assert.ok(10 * Math.log10(sig / err) > 20, `${(10 * Math.log10(sig / err)).toFixed(1)} dB`);
});

test('a frame decodes without the one before it: the header carries the sample and the index', () => {
  const pcm = tone(640, 300, 16000, 10000);
  const a = encodeAdpcm(pcm.subarray(0, 640), 0);
  const b = encodeAdpcm(pcm.subarray(640), a.index);
  assert.equal(decodeAdpcm(b.frame).length, 640);
  assert.equal(toHex(decodeAdpcm(b.frame)), toHex(decodeAdpcm(Buffer.from(b.frame))));
  assert.equal(b.frame[2], a.index);
});

test('the first sample goes through unchanged, whatever the index', () => {
  for (const index of [0, 44, 88]) {
    const back = decodeAdpcm(encodeAdpcm(pcmOf([-32768, 5, 7]), index).frame);
    assert.equal(back.readInt16LE(0), -32768);
  }
});

test('encoding refuses what is not whole PCM16 samples, or a step index outside 0 to 88', () => {
  assert.throws(() => encodeAdpcm(Buffer.alloc(3), 0), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(0), 0), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(4), 89), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(4), -1), RangeError);
});

test('decoding refuses a frame that is shorter than its header, has an index above 88 or a bad pad flag', () => {
  assert.equal(decodeAdpcm(Buffer.alloc(3)), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 89, 0])), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 0, 2])), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 0, 1])), null); // padding with no nibble to pad
  assert.equal(decodeAdpcm(Buffer.from([1, 0, 0, 0])).length, 2); // one sample, no nibbles
});
