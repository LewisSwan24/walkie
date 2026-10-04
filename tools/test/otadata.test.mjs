import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { otaEntry, otadataImage } from '../lib/otadata.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

test('the images match the otadata bytes read from the S3 in Stage 0', () => {
  // app0: read from the S3 before walkie existed. app1: the image that booted the Stage 0 spike.
  assert.equal(sha256(otadataImage('app0')), 'f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0');
  assert.equal(sha256(otadataImage('app1')), '1948f69d226fea36612358041ed24eda23c2f013c0f9759f14ee8284eeeb1767');
});

test('an entry carries the CRC of its ota_seq', () => {
  assert.equal(otaEntry(1).toString('hex'), '01000000' + 'ff'.repeat(24) + '9a984347');
  assert.equal(otaEntry(2).toString('hex'), '02000000' + 'ff'.repeat(24) + '7437f655');
});

test('other slots are refused', () => {
  assert.throws(() => otadataImage('app2'), /unknown slot/);
});
