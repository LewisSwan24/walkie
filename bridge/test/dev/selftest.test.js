import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selftest } from '../../src/dev/selftest.js';
import { TYPE } from '../../src/link/frame.js';
import { Link } from '../../src/link/link.js';
import { TEST_OP } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

// selftest() reaches the S3 through connect(); the fake link records what is sent and lets the test choose the answer.
function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.closed = false;
  link.send = (type, payload) => link.sent.push({ type, payload });
  link.close = () => { link.closed = true; };
  return link;
}
const settle = () => new Promise((r) => setImmediate(r));

test('it asks the S3 to check its own crypto and prints the answer', async () => {
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual([...link.sent[0].payload], [TEST_OP.SELFTEST]);
  link.emit('log', 'unrelated line');
  link.emit('log', 'selftest ok: hkdf gcm-seal gcm-open gcm-tamper session');
  assert.equal(await done, 0);
  assert.deepEqual(lines, ['selftest ok: hkdf gcm-seal gcm-open gcm-tamper session']);
  assert.equal(link.closed, true);
});

test('a failed check is exit code 1 and says which', async () => {
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  link.emit('log', 'selftest FAILED, mask 0x02 (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)');
  assert.equal(await done, 1);
  assert.match(lines[0], /FAILED, mask 0x02/);
});

test('no answer within the time allowed is exit code 1 and the link is closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(await done, 1);
  assert.match(lines.join('\n'), /no answer/);
  assert.equal(link.closed, true);
});

// Through a real Link and the stand-in S3, so the TEST frame and the LOG answer are the real ones.
async function realLink(t, device) {
  const link = new Link({ openPort: async () => device, makeNonce: () => 0x5eed1234 });
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return link;
}

test('over a real link: the stand-in S3 gets TEST SELFTEST once and its answer is what is printed', async (t) => {
  const device = new FakeS3({ proto: 2 });
  const lines = [];
  assert.equal(await selftest([], {}, async () => realLink(t, device), (l) => lines.push(l)), 0);
  assert.equal(device.selftests, 1);
  assert.match(lines[0], /^selftest ok/);
});

test('over a real link: a FAILED answer from the S3 is exit code 1', async (t) => {
  const device = new FakeS3({ proto: 2 });
  device.selftestAnswer = 'selftest FAILED, mask 0x10 (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)';
  const lines = [];
  assert.equal(await selftest([], {}, async () => realLink(t, device), (l) => lines.push(l)), 1);
  assert.match(lines[0], /mask 0x10/);
});
