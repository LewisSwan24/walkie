import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearRelayHost, defaultRelayFile, loadRelayHost, normalizeRelayHost, saveRelayHost } from '../../src/config/relay.js';

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'relay.txt'); // the folder does not exist yet
}

test('the relay host lives beside the pairing key in %APPDATA%\\walkie, and there is no default without APPDATA', () => {
  assert.equal(defaultRelayFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'walkie', 'relay.txt'));
  assert.equal(defaultRelayFile({}), null);
});

test('a host name is what a person types: trimmed, a trailing slash dropped, wss:// and a port allowed', () => {
  assert.equal(normalizeRelayHost('  walkie-relay.fly.dev \r\n'), 'walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('walkie-relay.fly.dev/'), 'walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('wss://walkie-relay.fly.dev'), 'wss://walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('relay.example.com:8443'), 'relay.example.com:8443');
  assert.equal(normalizeRelayHost('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
  for (const bad of ['', '   ', 'a b', 'ws://relay.fly.dev', 'http://relay.fly.dev', 'relay.fly.dev/path', 'user@relay.fly.dev', 'relay.fly.dev?x=1']) {
    assert.throws(() => normalizeRelayHost(bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => normalizeRelayHost(undefined), RangeError);
});

test('with no file there is no relay, and that is not an error', (t) => {
  assert.equal(loadRelayHost({ file: tempFile(t) }), null);
  assert.equal(loadRelayHost({ file: null }), null);
});

test('a host is saved and loaded back, the folder is made, and nothing else is left beside it', (t) => {
  const file = tempFile(t);
  saveRelayHost(' walkie-relay.fly.dev/ ', { file });
  assert.equal(readFileSync(file, 'utf8'), 'walkie-relay.fly.dev\n');
  assert.equal(loadRelayHost({ file }), 'walkie-relay.fly.dev');
  saveRelayHost('other.fly.dev', { file });
  assert.equal(loadRelayHost({ file }), 'other.fly.dev', 'saving again replaces it');
  assert.deepEqual(readdirSync(path.dirname(file)), ['relay.txt']);
});

test('a host that is not a host is refused before anything is written', (t) => {
  const file = tempFile(t);
  assert.throws(() => saveRelayHost('ws://relay.fly.dev', { file }), RangeError);
  assert.equal(existsSync(path.dirname(file)), false, 'not even the folder');
  assert.throws(() => saveRelayHost('x.fly.dev', { file: null }), /nowhere to keep a relay host: %APPDATA% is not set/);
});

test('a file written by hand is read with its BOM and CRLF, and one that is not a host is an error naming the file', (t) => {
  const file = tempFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '\ufeffwalkie-relay.fly.dev\r\n');
  assert.equal(loadRelayHost({ file }), 'walkie-relay.fly.dev');
  writeFileSync(file, 'not a host name\n');
  assert.throws(() => loadRelayHost({ file }), (err) => err.message.includes(file) && /does not hold a host name/.test(err.message));
  writeFileSync(file, '\n');
  assert.equal(loadRelayHost({ file }), null, 'an empty file is no relay');
});

test('a file that cannot be read says so with its code and not its content', (t) => {
  const file = tempFile(t);
  const unreadable = () => {
    throw Object.assign(new Error('boom walkie.fly.dev'), { code: 'EACCES' });
  };
  assert.throws(
    () => loadRelayHost({ file, read: unreadable }),
    (err) => err.message === `cannot read the relay file ${file} (EACCES)`,
  );
});

test('clearing removes the file, and clearing what is not there is fine', (t) => {
  const file = tempFile(t);
  clearRelayHost({ file });
  saveRelayHost('walkie-relay.fly.dev', { file });
  clearRelayHost({ file });
  assert.equal(loadRelayHost({ file }), null);
  assert.equal(existsSync(file), false);
});
