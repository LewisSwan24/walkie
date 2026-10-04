import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreditGate } from '../../src/link/credits.js';

const settle = () => new Promise((r) => setImmediate(r));

test('acquire waits for a grant and spends exactly what it asked for', async () => {
  const g = new CreditGate();
  let done = false;
  const p = g.acquire(960).then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  g.grant(1000);
  await p;
  assert.equal(g.available, 40);
});

test('waiters are served in order, each only when it fits', async () => {
  const g = new CreditGate();
  const order = [];
  const a = g.acquire(960).then(() => order.push('a'));
  const b = g.acquire(960).then(() => order.push('b'));
  g.grant(1500);
  await settle();
  assert.deepEqual(order, ['a']);
  g.grant(500);
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(g.available, 80);
});

test('an aborted acquire rejects and leaves the queue', async () => {
  const g = new CreditGate();
  const ac = new AbortController();
  const p = g.acquire(960, ac.signal);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  g.grant(960);
  await g.acquire(960);
  assert.equal(g.available, 0);
});

test('when the first waiter aborts, the next one that fits is served at once', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  const ac = new AbortController();
  const head = g.acquire(960, ac.signal);
  let served = false;
  const next = g.acquire(320).then(() => { served = true; });
  g.grant(500);
  await settle();
  assert.equal(served, false);
  ac.abort();
  await assert.rejects(head, { name: 'AbortError' });
  await next;
  assert.equal(g.available, 180);
});

test('waiters that share an aborted signal all reject and spend nothing', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  const ac = new AbortController();
  const a = g.acquire(960, ac.signal);
  const b = g.acquire(320, ac.signal);
  g.grant(500);
  ac.abort();
  await assert.rejects(a, { name: 'AbortError' });
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(g.available, 500);
});

test('reset forgets all credit', () => {
  const g = new CreditGate();
  g.grant(5000);
  g.reset();
  assert.equal(g.available, 0);
});

test('a later, smaller acquire does not jump the queue', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  const order = [];
  const a = g.acquire(960).then(() => order.push(960));
  g.grant(500);
  const b = g.acquire(320).then(() => order.push(320));
  await settle();
  assert.deepEqual(order, []);
  assert.equal(g.available, 500);
  g.grant(780);
  await Promise.all([a, b]);
  assert.deepEqual(order, [960, 320]);
  assert.equal(g.available, 0);
});

test('an acquire with an already aborted signal rejects and spends nothing', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  g.grant(1000);
  await assert.rejects(g.acquire(960, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(g.available, 1000);
});

test('a queued waiter survives reset and is served by a later grant', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  g.grant(500);
  const p = g.acquire(960);
  g.reset();
  assert.equal(g.available, 0);
  g.grant(960);
  await p;
  assert.equal(g.available, 0);
});

test('aborting the head of the queue lets the waiters behind it through', { timeout: 2000 }, async () => {
  const g = new CreditGate();
  const ac = new AbortController();
  const a = g.acquire(960, ac.signal);
  const b = g.acquire(320, ac.signal);
  const c = g.acquire(100);
  g.grant(500);
  ac.abort();
  await assert.rejects(a, { name: 'AbortError' });
  await assert.rejects(b, { name: 'AbortError' });
  await c;
  assert.equal(g.available, 400);
});
