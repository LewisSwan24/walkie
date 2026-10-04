import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCmdArgs } from '../../src/dev/cmd-args.js';
import { CMD } from '../../src/link/messages.js';

test('parseCmdArgs maps names and values to an op and its argument', () => {
  assert.deepEqual(parseCmdArgs(['vol', '200']), { op: CMD.SET_VOLUME, arg: 200 });
  assert.deepEqual(parseCmdArgs(['gain', '16']), { op: CMD.SET_MIC_GAIN, arg: 16 });
  assert.deepEqual(parseCmdArgs(['stop']), { op: CMD.STOP_AUDIO, arg: undefined });
  assert.deepEqual(parseCmdArgs(['boot-app0']), { op: CMD.BOOT_APP0, arg: undefined });
  assert.deepEqual(parseCmdArgs(['reboot']), { op: CMD.REBOOT, arg: undefined });
});

test('parseCmdArgs throws on bad names and values', () => {
  assert.throws(() => parseCmdArgs(['vol', 'loud']), RangeError);
  assert.throws(() => parseCmdArgs(['vol']), RangeError);
  assert.throws(() => parseCmdArgs(['gain', '100']), RangeError);
  assert.throws(() => parseCmdArgs(['stop', '5']), RangeError);
  assert.throws(() => parseCmdArgs(['toString']), /cmd vol <0-255>/);
  assert.throws(() => parseCmdArgs([undefined]), /cmd vol <0-255>/);
  assert.throws(() => parseCmdArgs([]), /cmd vol <0-255>/);
});
