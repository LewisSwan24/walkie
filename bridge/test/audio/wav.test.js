import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav, levels } from '../../src/audio/wav.js';

test('encodeWav writes a 44-byte PCM16 mono header', () => {
  const w = encodeWav(Buffer.alloc(320), 16000);
  assert.equal(w.length, 364);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), 356);
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(w.readUInt16LE(20), 1);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(28), 32000);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString('ascii', 36, 40), 'data');
  assert.equal(w.readUInt32LE(40), 320);
});

test('levels skips the start and reports peak, rms and clipping', () => {
  const samples = [30000, 30000, 30000, 30000, 100, -200, 32767, -32768];
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  // 16 samples a second, so 250 ms skips the first 4
  const rms = Math.round(Math.sqrt((100 ** 2 + 200 ** 2 + 32767 ** 2 + 32768 ** 2) / 4));
  assert.deepEqual(levels(pcm, 16, 250), { durationMs: 500, peak: 32768, rms, clippedPct: 50 });
});

test('levels skips the tail too: the key-release click stays out of the stats', () => {
  // 16 samples at 16 Hz = 1 s. Head transient (first 250 ms = 4 samples), quiet body with one
  // loud speech sample, and a full-scale release click in the last 100 ms (= 2 samples).
  const samples = [
    30000, 30000, 30000, 30000,
    100, -200, 150, -150,
    12000, -120, 100, -100,
    110, -110,
    32767, -32768,
  ];
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  const rms = Math.round(Math.sqrt(
    (100 ** 2 + 200 ** 2 + 150 ** 2 + 150 ** 2 + 12000 ** 2 +
     120 ** 2 + 100 ** 2 + 100 ** 2 + 110 ** 2 + 110 ** 2) / 10));
  assert.deepEqual(levels(pcm, 16, 250, 100), { durationMs: 1000, peak: 12000, rms, clippedPct: 0 });
  // Without the tail skip the click dominates, as it did on the calibration takes.
  assert.equal(levels(pcm, 16, 250).peak, 32768);
});

test('levels: a tail skip overlapping the head skip gives an empty window, not a negative one', () => {
  const pcm = Buffer.alloc(32); // 16 samples at 16 Hz = 1 s, all zeros
  assert.deepEqual(levels(pcm, 16, 250, 900), { durationMs: 1000, peak: 0, rms: 0, clippedPct: 0 });
});

function chunk(id, body) {
  const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, pad]);
}
const fmtBody = (format, channels, rate, bits) => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
};
const riff = (...chunks) => {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

test('decodeWav reads what encodeWav wrote', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const d = decodeWav(encodeWav(pcm, 24000));
  assert.equal(d.rate, 24000);
  assert.ok(d.pcm.equals(pcm));
});

test('decodeWav skips chunks it does not need, including an odd-sized one', () => {
  const pcm = Buffer.from([9, 0, 8, 0]);
  const wav = riff(chunk('LIST', Buffer.from('abc')), chunk('fmt ', fmtBody(1, 1, 16000, 16)), chunk('junk', Buffer.alloc(5)), chunk('data', pcm));
  const d = decodeWav(wav);
  assert.equal(d.rate, 16000);
  assert.ok(d.pcm.equals(pcm));
});

test('decodeWav stops a data chunk at the end of the file when it claims more', () => {
  const wav = encodeWav(Buffer.alloc(100, 7), 16000);
  wav.writeUInt32LE(0xffffffff, 40);
  assert.equal(decodeWav(wav).pcm.length, 100);
  const cut = encodeWav(Buffer.alloc(101, 7), 16000).subarray(0, 44 + 101); // a half sample at the end is dropped
  cut.writeUInt32LE(0xffffffff, 40);
  assert.equal(decodeWav(cut).pcm.length, 100);
});

test('decodeWav refuses anything but PCM16 mono, and files that are not WAVs', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav file at all')), /not a WAV file/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(1, 2, 16000, 16)), chunk('data', Buffer.alloc(8)))), /PCM16 mono, got format 1, 16 bits, 2 channels/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(3, 1, 16000, 32)), chunk('data', Buffer.alloc(8)))), /PCM16 mono, got format 3, 32 bits/);
  assert.throws(() => decodeWav(riff(chunk('data', Buffer.alloc(8)))), /data before its fmt/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)))), /no data chunk/);
});
