import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TakeCollector } from '../../src/audio/takes.js';
import { FLAG } from '../../src/link/frame.js';

const frame = (bytes, flags = 0) => ({ type: 0x10, flags, seq: 0, payload: Buffer.alloc(bytes, 7) });

test('frames collect into one take that ends at EOS', () => {
  const t = new TakeCollector();
  assert.equal(t.push(frame(640)), null);
  assert.equal(t.open, true);
  const take = t.push(frame(640, FLAG.EOS));
  assert.equal(take.length, 1280);
  assert.equal(t.open, false);
});

test('an empty EOS frame still ends the take', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  assert.equal(t.push(frame(0, FLAG.EOS)).length, 640);
});

test('a take whose last frame carries REASON says so, and the next take does not', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  assert.equal(t.push(frame(640, FLAG.EOS | FLAG.REASON)).length, 1280);
  assert.equal(t.lastReason, true);
  t.push(frame(640, FLAG.EOS));
  assert.equal(t.lastReason, false);
});

test('REASON on a frame that does not end the take does not make it a reason', () => {
  const t = new TakeCollector();
  t.push(frame(640, FLAG.REASON));
  t.push(frame(640, FLAG.EOS));
  assert.equal(t.lastReason, false);
});

test('reset drops a take in progress', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  t.reset();
  assert.equal(t.push(frame(320, FLAG.EOS)).length, 320);
});
