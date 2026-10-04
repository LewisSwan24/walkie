import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  commitPairKey, defaultPairKeyFile, discardPairCandidate, forgetPairKey, loadPairCandidate, loadPairKey, writePairCandidate,
} from '../../src/config/pairkey.js';

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pairkey-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'pair.key'); // the folder does not exist yet
}
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
const OTHER = Buffer.alloc(32, 0x11);

test('the key lives beside keys.env in %APPDATA%\\walkie, and there is no default without APPDATA', () => {
  assert.equal(defaultPairKeyFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'walkie', 'pair.key'));
  assert.equal(defaultPairKeyFile({}), null);
});

test('with no file there is no key, and that is not an error', (t) => {
  const file = tempFile(t);
  assert.equal(loadPairKey({ file }), null);
  assert.equal(loadPairCandidate({ file }), null);
});

test('a key is written as a candidate first and becomes the key only when it is committed', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  assert.equal(loadPairKey({ file }), null, 'a candidate is not the key');
  assert.equal(loadPairCandidate({ file }).compare(KEY), 0);
  assert.equal(readFileSync(`${file}.new`, 'utf8'), `${KEY.toString('hex')}\n`, '64 hex characters and a newline');
  commitPairKey({ file });
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
  assert.equal(loadPairCandidate({ file }), null, 'and the candidate is gone');
  assert.deepEqual(readdirSync(path.dirname(file)), ['pair.key'], 'nothing else is left beside it');
});

test('committing replaces the key that was there, and a stale candidate is replaced by a new one', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  writePairCandidate(KEY, { file });
  writePairCandidate(OTHER, { file });
  assert.equal(loadPairKey({ file }).compare(KEY), 0, 'the old key stands until the new one is committed');
  commitPairKey({ file });
  assert.equal(loadPairKey({ file }).compare(OTHER), 0);
});

test('discarding a candidate leaves the key, and discarding when there is none is quiet', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  discardPairCandidate({ file });
  assert.equal(loadPairCandidate({ file }), null);
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
  assert.doesNotThrow(() => discardPairCandidate({ file }));
});

test('forgetting removes the key and any candidate, and is quiet when there is nothing', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  forgetPairKey({ file });
  assert.equal(loadPairKey({ file }), null);
  assert.equal(loadPairCandidate({ file }), null);
  assert.doesNotThrow(() => forgetPairKey({ file }));
});

test('a file that is not 64 hex characters is refused, and the error never holds what the file said', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  for (const bad of ['', '#!#', 'zz'.repeat(32), `${KEY.toString('hex')}00`, 'my secret passphrase', `${KEY.toString('hex').slice(0, 62)}`]) {
    writeFileSync(file, bad);
    assert.throws(
      () => loadPairKey({ file }),
      (err) => err instanceof Error && err.message.includes(file) && !err.message.includes(bad.slice(0, 8) || '\0'),
      JSON.stringify(bad.length),
    );
  }
});

test('an editor that added a BOM, CRLF or capitals is forgiven', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writeFileSync(file, `\uFEFF${KEY.toString('hex').toUpperCase()}\r\n`);
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
});

test('only a 32-byte key can be written, and committing with no candidate says so', (t) => {
  const file = tempFile(t);
  assert.throws(() => writePairCandidate(Buffer.alloc(31), { file }), RangeError);
  assert.throws(() => writePairCandidate(Buffer.alloc(33), { file }), RangeError);
  assert.throws(() => writePairCandidate('a'.repeat(64), { file }), RangeError);
  assert.equal(existsSync(path.dirname(file)), false, 'a refused key leaves nothing behind');
  assert.throws(() => commitPairKey({ file }), /no pairing key to commit/);
});

test('a file that cannot be read for another reason than being absent is an error', (t) => {
  const file = tempFile(t);
  assert.throws(
    () =>
      loadPairKey({
        file,
        read: () => {
          throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
        },
      }),
    (err) => /cannot read/.test(err.message) && err.message.includes(file) && !err.message.includes('denied'),
  );
});
