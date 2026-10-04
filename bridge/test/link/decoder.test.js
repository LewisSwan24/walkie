import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import { FrameDecoder } from '../../src/link/decoder.js';

const summary = (frames) => frames.map((f) => `${f.type.toString(16).padStart(2, '0')}:${f.seq}`).join(',');

test('stream vectors: the right frames come out and bad chunks are counted', () => {
  for (const s of vectors.streams) {
    const d = new FrameDecoder();
    const frames = s.chunks.flatMap((c) => d.push(hex(c)));
    assert.equal(summary(frames), s.expect, s.name);
    assert.equal(d.bad, s.bad, s.name);
  }
});

test('a frame fed one byte at a time still comes out once', () => {
  const wire = hex(vectors.frames.find((f) => f.name === 'audio down, largest payload').wire);
  const d = new FrameDecoder();
  const frames = [];
  for (const b of wire) frames.push(...d.push(Uint8Array.of(b)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 1024);
  assert.equal(d.bad, 0);
});
