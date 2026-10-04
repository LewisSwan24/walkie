import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOUDNESS, LoudnessChain, applyLoudness, processAll } from '../../src/speech/loudness.js';

const RATE = 24000;

function sine(hz, amplitude, secs) {
  const n = Math.round(RATE * secs);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2);
  return b;
}

// Peak and RMS of the last `secs` seconds, after the filters have settled.
function tailStats(pcm, secs) {
  const n = Math.round(RATE * secs);
  let peak = 0;
  let sum = 0;
  for (let i = pcm.length / 2 - n; i < pcm.length / 2; i++) {
    const v = pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}
const db = (ratio) => 20 * Math.log10(ratio);

// A chain with the compressor and limiter out of the way, so one stage can be measured alone.
const FLAT = { ratio: 1, makeupDb: 0, ceiling: 1, highpassHz: 20 };

test('the high-pass cuts 50 Hz by about 31 dB and leaves 3 kHz alone', () => {
  const settings = { ...FLAT, highpassHz: 300 };
  const low = tailStats(processAll(sine(50, 8000, 0.5), settings), 0.25).rms / tailStats(sine(50, 8000, 0.5), 0.25).rms;
  const high = tailStats(processAll(sine(3000, 8000, 0.5), settings), 0.25).rms / tailStats(sine(3000, 8000, 0.5), 0.25).rms;
  assert.ok(Math.abs(db(low) + 31) < 1.5, `50 Hz changed by ${db(low).toFixed(1)} dB`);
  assert.ok(Math.abs(db(high)) < 0.3, `3 kHz changed by ${db(high).toFixed(1)} dB`);
});

test('the compressor takes a loud tone down by (level - threshold) x (1 - 1/ratio)', () => {
  // 10000 is -10.3 dBFS, 23.7 dB over the -34 dB threshold: 21.7 dB of reduction, so a peak near -32 dBFS (823)
  const out = tailStats(processAll(sine(1000, 10000, 0.5), { ...FLAT, ratio: 12, thresholdDb: -34 }), 0.25);
  assert.ok(Math.abs(db(out.peak / 823)) < 1.5, `peak ${out.peak}, expected about 823`);
});

test('below the threshold the compressor does nothing, and makeup gain is a constant', () => {
  const quiet = sine(1000, 300, 0.5); // -40.8 dBFS
  const same = tailStats(processAll(quiet, { ...FLAT, ratio: 12, thresholdDb: -34 }), 0.25);
  assert.ok(Math.abs(db(same.peak / 300)) < 0.3, `peak ${same.peak}, expected about 300`);
  const louder = tailStats(processAll(quiet, { ...FLAT, ratio: 12, thresholdDb: -34, makeupDb: 20 }), 0.25);
  assert.ok(Math.abs(db(louder.peak / 3000)) < 0.3, `peak ${louder.peak}, expected about 3000`);
});

// Deterministic noise bursts that start and stop abruptly, so the limiter sees hard onsets.
function bursts(secs) {
  const n = Math.round(RATE * secs);
  const b = Buffer.alloc(n * 2);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const loud = Math.floor(i / 1200) % 3 === 1;
    b.writeInt16LE(loud ? (seed % 40001) - 20000 : (seed % 201) - 100, i * 2);
  }
  return b;
}

test('the limiter never passes its ceiling, even when a burst needs 40 dB of reduction', () => {
  const out = processAll(bursts(1), { ...FLAT, makeupDb: 40, ceiling: 0.98 });
  let peak = 0;
  for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out.readInt16LE(i)));
  assert.ok(peak <= Math.ceil(0.98 * 32768), `peak ${peak}`); // rounding can land half a step over
  assert.ok(peak > 30000, `the limiter should use the headroom, peak ${peak}`);
});

test('the default chain keeps every sample under 0.98 of full scale', () => {
  const out = processAll(bursts(1));
  for (let i = 0; i < out.length; i += 2) assert.ok(Math.abs(out.readInt16LE(i)) <= Math.ceil(0.98 * 32768));
});

test('the output is as long as the input, for lengths shorter and longer than the lookahead', () => {
  for (const samples of [0, 1, 50, 119, 120, 121, 1000, 4801]) {
    const input = sine(440, 5000, samples / RATE);
    assert.equal(processAll(input, DEFAULT_LOUDNESS).length, input.length, `${samples} samples`);
  }
});

test('chunk sizes do not change the result, even chunks that split a sample', () => {
  const input = Buffer.concat([sine(200, 6000, 0.1), bursts(0.1), sine(1500, 300, 0.1)]);
  const whole = processAll(input);
  for (const size of [1, 2, 3, 7, 960, 4801]) {
    const chain = new LoudnessChain();
    const parts = [];
    for (let i = 0; i < input.length; i += size) parts.push(chain.push(input.subarray(i, i + size)));
    parts.push(chain.flush());
    assert.ok(Buffer.concat(parts).equals(whole), `chunks of ${size} bytes differ`);
  }
});

test('silence in, silence out', () => {
  const out = processAll(Buffer.alloc(9600));
  assert.equal(out.length, 9600);
  assert.ok(out.equals(Buffer.alloc(9600)));
});

test('applyLoudness yields whole samples and the same audio as processAll', async () => {
  const input = Buffer.concat([sine(300, 4000, 0.2), bursts(0.1)]);
  async function* source() {
    for (let i = 0; i < input.length; i += 1001) yield input.subarray(i, i + 1001); // odd sizes
  }
  const chunks = [];
  for await (const c of applyLoudness(source())) {
    assert.equal(c.length % 2, 0);
    chunks.push(c);
  }
  assert.ok(Buffer.concat(chunks).equals(processAll(input)));
});

test('a dangling odd byte at the end of the stream is dropped, not turned into noise', () => {
  const chain = new LoudnessChain();
  const a = chain.push(Buffer.alloc(9601));
  const b = chain.flush();
  assert.equal(a.length + b.length, 9600);
});
