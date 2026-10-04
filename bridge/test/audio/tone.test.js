import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone } from '../../src/audio/tone.js';
import { levels } from '../../src/audio/wav.js';

test('a tone has the requested length and amplitude', () => {
  const pcm = tone(440, 0.5, 2000);
  assert.equal(pcm.length, 24000);
  const l = levels(pcm, 24000);
  assert.equal(l.durationMs, 500);
  assert.ok(l.peak >= 1990 && l.peak <= 2000, `peak ${l.peak}`);
  assert.ok(Math.abs(l.rms - 1414) <= 5, `rms ${l.rms}`);
});
