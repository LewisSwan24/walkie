import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeWrites, checkPartitionTable, parsePartitionTable } from '../lib/partitions.mjs';

// The partition table read from the S3 in Stage 0: six entries, the MD5 entry, then 0xFF.
const DEVICE_TABLE = Buffer.from([
  'aa50010200900000005000006e76730000000000000000000000000000000000',
  'aa50010000e00000002000006f74616461746100000000000000000000000000',
  'aa50001000000100000033006170703000000000000000000000000000000000',
  'aa50001100003400000033006170703100000000000000000000000000000000',
  'aa50018200006700000018007370696666730000000000000000000000000000',
  'aa50010300007f0000000100636f726564756d70000000000000000000000000',
  'ebebffffffffffffffffffffffffffff467eb896e29d1aa938c557f4cdfc4c5b',
].join('') + 'ff'.repeat(3072 - 224), 'hex');

test("the S3's table parses and passes", () => {
  const entries = parsePartitionTable(DEVICE_TABLE);
  assert.deepEqual(entries.map((e) => e.label), ['nvs', 'otadata', 'app0', 'app1', 'spiffs', 'coredump']);
  assert.deepEqual(checkPartitionTable(entries), []);
});

test('a different layout is reported', () => {
  const t = Buffer.from(DEVICE_TABLE);
  t.writeUInt32LE(0x300000, 3 * 32 + 8); // app1's size
  assert.deepEqual(checkPartitionTable(parsePartitionTable(t)), ['app1: size is 0x300000, expected 0x330000']);
  assert.deepEqual(checkPartitionTable(parsePartitionTable(Buffer.alloc(3072, 0xff))), ['expected 6 partitions, found 0']);
});

test('only app1 and otadata may be written', () => {
  assert.doesNotThrow(() => assertSafeWrites([{ addr: 0x340000, size: 900000 }, { addr: 0xe000, size: 0x2000 }]));
  for (const w of [
    { addr: 0x0, size: 4096 },
    { addr: 0x8000, size: 3072 },
    { addr: 0x9000, size: 4096 },
    { addr: 0x10000, size: 4096 },
    { addr: 0x340000, size: 0x330001 },
    { addr: 0xe000, size: 4096 },
  ]) {
    assert.throws(() => assertSafeWrites([w]), /refusing/, JSON.stringify(w));
  }
});
