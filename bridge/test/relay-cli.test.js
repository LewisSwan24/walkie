// walkie relay: the relay host on this PC, set, shown and forgotten, with the console around it and an exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRelayHost } from '../src/config/relay.js';
import { relayChange, relayCommand } from '../src/relay-cli.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-relaycli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'relay.txt');
  const said = [];
  const errs = [];
  const run = (opts) => relayCommand({ file, say: (s) => said.push(s), err: (s) => errs.push(s), ...opts });
  return { file, said, errs, run };
}

test('with no host and no --forget it shows what is set, or says none is and how to set one', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: null, forget: false }), 0);
  assert.deepEqual(f.said, ['relay: none set (node bridge/bin/walkie.js relay <host>)']);
  f.run({ host: 'walkie-relay.fly.dev', forget: false });
  f.said.length = 0;
  assert.equal(f.run({ host: null, forget: false }), 0);
  assert.deepEqual(f.said, ['relay: walkie-relay.fly.dev']);
});

test('a host is kept, as normalised, and said back', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: ' walkie-relay.fly.dev/ ', forget: false }), 0);
  assert.deepEqual(f.said, ['relay set on this PC: walkie-relay.fly.dev']);
  assert.equal(loadRelayHost({ file: f.file }), 'walkie-relay.fly.dev');
});

test('a host that is not one is exit 2 with the reason, and nothing changes', (t) => {
  const f = fixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(f.run({ host: 'ws://relay.fly.dev', forget: false }), 2);
  assert.match(f.errs[0], /^walkie: not a relay host name/);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
});

test('an empty host is not a request to show: it is a host that is not one, exit 2', (t) => {
  const f = fixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(f.run({ host: '', forget: false }), 2);
  assert.match(f.errs[0], /not a relay host name/);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
});

test('--forget removes it, and forgetting what is not there is fine', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: null, forget: true }), 0);
  f.run({ host: 'one.fly.dev', forget: false });
  f.said.length = 0;
  assert.equal(f.run({ host: null, forget: true }), 0);
  assert.deepEqual(f.said, ['relay forgotten on this PC']);
  assert.equal(loadRelayHost({ file: f.file }), null);
});

test('a file that cannot be read or a place that cannot be written is exit 1 with the message', (t) => {
  const f = fixture(t);
  assert.equal(relayCommand({ file: null, host: 'one.fly.dev', forget: false, say: () => {}, err: (s) => f.errs.push(s) }), 1);
  assert.match(f.errs[0], /nowhere to keep a relay host/);
  const unreadable = () => {
    throw Object.assign(new Error('x'), { code: 'EACCES' });
  };
  assert.equal(relayCommand({ file: f.file, host: null, forget: false, say: () => {}, err: (s) => f.errs.push(s), read: unreadable }), 1);
  assert.match(f.errs[1], /cannot read the relay file .* \(EACCES\)/);
});

// With a pairing key, a change goes to the S3 first, over the relay it is on now, and this PC changes only once the S3 has it.
function changeFixture(t, { code = 0, key = Buffer.alloc(32, 1) } = {}) {
  const f = fixture(t);
  f.pushes = [];
  const push = async (p) => {
    f.pushes.push({ ...p, onPc: loadRelayHost({ file: f.file }) });
    return code;
  };
  f.change = (opts) => relayChange({ file: f.file, say: (s) => f.said.push(s), err: (s) => f.errs.push(s), loadKey: () => key, push, ...opts });
  return f;
}

test('a new host goes to the S3 over the relay it is on now, and is kept on this PC once the S3 has it', async (t) => {
  const f = changeFixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(await f.change({ host: ' two.fly.dev/ ' }), 0);
  assert.equal(f.pushes.length, 1);
  assert.deepEqual([f.pushes[0].host, f.pushes[0].forget, f.pushes[0].via], ['two.fly.dev', false, 'one.fly.dev']);
  assert.equal(f.pushes[0].onPc, 'one.fly.dev', 'this PC had not changed when the S3 was asked');
  assert.equal(loadRelayHost({ file: f.file }), 'two.fly.dev');
});

test('--forget is said to the S3 over the relay it is on, then forgotten here', async (t) => {
  const f = changeFixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(await f.change({ forget: true }), 0);
  assert.deepEqual([f.pushes[0].host, f.pushes[0].forget, f.pushes[0].via], [null, true, 'one.fly.dev']);
  assert.equal(loadRelayHost({ file: f.file }), null);
});

test('when the S3 is not told, this PC keeps the relay it had, and says how to change it here alone', async (t) => {
  const f = changeFixture(t, { code: 1 });
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(await f.change({ host: 'two.fly.dev' }), 1);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
  assert.match(f.errs.at(-1), /unchanged \(one\.fly\.dev\).*--pc-only/);
});

test('a host that is not one is exit 2 before the S3 is asked anything', async (t) => {
  const f = changeFixture(t);
  assert.equal(await f.change({ host: 'ws://relay.fly.dev' }), 2);
  assert.match(f.errs[0], /^walkie: not a relay host name/);
  assert.equal(f.pushes.length, 0);
});

test('--pc-only, or no pairing key, changes this PC without asking the S3', async (t) => {
  const f = changeFixture(t);
  assert.equal(await f.change({ host: 'one.fly.dev', pcOnly: true }), 0);
  const g = changeFixture(t, { key: null });
  assert.equal(await g.change({ host: 'two.fly.dev' }), 0);
  assert.equal(f.pushes.length + g.pushes.length, 0);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
  assert.equal(loadRelayHost({ file: g.file }), 'two.fly.dev');
  assert.match(g.said.at(-1), /not paired, so the S3 was not told/);
});
