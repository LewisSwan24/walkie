import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLevels } from '../../src/dev/say.js';

test('the level line shows the peak as a share of full scale', () => {
  assert.equal(
    formatLevels({ durationMs: 6500, peak: 32113, rms: 7526, clippedPct: 0 }),
    'level: 6.5 s, peak 32113 (98% of full scale), rms 7526, 0.0% of samples at the limit',
  );
  assert.equal(formatLevels({ durationMs: 500, peak: 32767, rms: 20000, clippedPct: 12.34 }), 'level: 0.5 s, peak 32767 (100% of full scale), rms 20000, 12.3% of samples at the limit');
});
