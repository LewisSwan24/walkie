import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROOM_BYTES, ROOM_INFO, roomId } from '../../src/link/room.js';
import { deriveKeys } from '../../src/link/session.js';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/seal-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');

test('the room id of each vector key is the vector, 32 lower-case hex characters', () => {
  assert.equal(ROOM_INFO, vectors.room.info);
  assert.equal(vectors.room.cases.length, 2);
  for (const c of vectors.room.cases) {
    assert.equal(roomId(hex(c.master)), c.id);
    assert.match(c.id, /^[0-9a-f]{32}$/);
  }
  assert.equal(ROOM_BYTES * 2, 32);
});

test('another key is another room, and the room is not a piece of a session key', () => {
  const [a, b] = vectors.room.cases;
  assert.notEqual(a.id, b.id);
  const { master, nonceP, nonceS } = vectors.session;
  const keys = deriveKeys(hex(master), nonceP, nonceS);
  assert.notEqual(roomId(hex(master)), keys.pcToS3.subarray(0, 16).toString('hex'));
  assert.notEqual(roomId(hex(master)), keys.s3ToPc.subarray(0, 16).toString('hex'));
});

test('a key that is not 32 bytes has no room', () => {
  assert.throws(() => roomId(Buffer.alloc(31)), RangeError);
  assert.throws(() => roomId(Buffer.alloc(33)), RangeError);
  assert.throws(() => roomId('00'.repeat(32)), RangeError);
  assert.throws(() => roomId(null), RangeError);
});
