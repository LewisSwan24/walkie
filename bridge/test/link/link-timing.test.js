// The Link's clocks: how often it pings and how long it waits for a PONG is the port's to say (a cable and a relay differ), and a
// port that will not open, or keeps closing, is retried more slowly each time up to a ceiling, starting over once a link is ready.
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { FakeS3 } from '../helpers/fake-s3.js';

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Mock time moves a second at a time with the I/O of the stand-in S3 flushed in between.
async function advance(t, ms, step = 1000) {
  for (let left = ms; left > 0; left -= step) {
    t.mock.timers.tick(Math.min(step, left));
    await flush();
  }
}

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}

async function start(t, { s3 = {}, ports = {}, link: options = {} } = {}) {
  const device = new FakeS3(s3);
  Object.assign(device, ports);
  const link = new Link({ openPort: async () => device, makeNonce: () => 7, ...options });
  const seen = { down: [], status: [] };
  link.on('down', (r) => seen.down.push(r));
  link.on('status', (s) => seen.status.push(s));
  t.after(() => link.close());
  await link.start();
  await flush();
  return { device, link, seen };
}

const pings = (device) => device.sent.filter((f) => f.type === TYPE.PING).length;

test('a port with no clock of its own is pinged every second, and given 3 s to answer', async (t) => {
  clock(t);
  const { device, link, seen } = await start(t);
  assert.equal(link.ready, true);
  device.answerPings = false;
  const before = pings(device);
  await advance(t, 3000);
  assert.equal(seen.down.length, 0, 'not yet');
  assert.equal(pings(device) - before, 3, 'a PING a second');
  await advance(t, 1000);
  assert.deepEqual(seen.down, ['no PONG for 3 s']);
});

test('a port that asks for the slow clock is pinged every 5 s and given 10 s, and the reason says 10 s', async (t) => {
  clock(t);
  const { device, link, seen } = await start(t, { ports: { pingEveryMs: 5000, pongTimeoutMs: 10_000 } });
  assert.equal(link.ready, true);
  device.answerPings = false;
  const before = pings(device);
  await advance(t, 10_000);
  assert.equal(seen.down.length, 0, 'ten silent seconds are still inside the window');
  assert.equal(pings(device) - before, 2, 'a PING every 5 s');
  await advance(t, 5000);
  assert.deepEqual(seen.down, ['no PONG for 10 s']);
});

test('a PONG inside the window keeps a slow port up for as long as they keep coming', async (t) => {
  clock(t);
  const { link, seen } = await start(t, { ports: { pingEveryMs: 5000, pongTimeoutMs: 10_000 } });
  await advance(t, 60_000);
  assert.equal(link.ready, true);
  assert.equal(seen.down.length, 0);
});

test('a port whose clock is nonsense gets the default one', async (t) => {
  clock(t);
  for (const bad of [{ pingEveryMs: 0, pongTimeoutMs: -1 }, { pingEveryMs: NaN, pongTimeoutMs: 'x' }, { pingEveryMs: Infinity, pongTimeoutMs: null }]) {
    const { device, seen } = await start(t, { ports: bad });
    device.answerPings = false;
    const before = pings(device);
    await advance(t, 3000);
    assert.equal(pings(device) - before, 3, `a PING a second: ${JSON.stringify(bad)}`);
    await advance(t, 1000);
    assert.deepEqual(seen.down, ['no PONG for 3 s'], JSON.stringify(bad));
  }
});

test('the clock of one port does not stay on the next: a relay at 5 s, then a cable at 1 s', async (t) => {
  clock(t);
  const ports = [Object.assign(new FakeS3(), { pingEveryMs: 5000, pongTimeoutMs: 10_000 }), new FakeS3()];
  let n = 0;
  const link = new Link({ openPort: async () => ports[n++], makeNonce: () => 7 });
  const down = [];
  link.on('down', (r) => down.push(r));
  t.after(() => link.close());
  await link.start();
  await flush();
  assert.equal(link.ready, true);
  ports[0].close(); // the relay goes; the Link opens the next port after its retry
  await advance(t, 1000);
  await flush();
  assert.equal(n, 2);
  assert.equal(link.ready, true);
  ports[1].answerPings = false;
  const before = pings(ports[1]);
  await advance(t, 3000);
  assert.equal(pings(ports[1]) - before, 3, 'the cable is pinged every second');
  await advance(t, 1000);
  assert.deepEqual(down.filter((r) => r.startsWith('no PONG')), ['no PONG for 3 s']);
});

// A port that cannot be opened: the times at which the Link tried.
function failingOpen(t, options) {
  const tries = [];
  const link = new Link({
    openPort: async () => {
      tries.push(Date.now());
      throw new Error('no route');
    },
    ...options,
  });
  t.after(() => link.close());
  return { link, tries };
}

test('without a ceiling the retry is flat, as it always was', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000 });
  await link.start();
  await advance(t, 5000);
  assert.deepEqual(tries, [0, 1000, 2000, 3000, 4000, 5000]);
});

test('with a ceiling the retry doubles up to it: 1, 2, 4, 8, 16, 30, 30 s', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000, retryMaxMs: 30_000 });
  await link.start();
  await advance(t, 91_000, 500);
  assert.deepEqual(tries, [0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000]);
});

test('a ceiling below the first delay is no ceiling at all, the first delay holds', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 2000, retryMaxMs: 500 });
  await link.start();
  await advance(t, 6000, 500);
  assert.deepEqual(tries, [0, 2000, 4000, 6000]);
});

test('the delay starts over once a link has been ready, and not before: a port that opens and closes is still failing', async (t) => {
  clock(t);
  const opened = [];
  const devices = [];
  // The first port is an S3 that answers; the rest never answer HELLO, so a link on them is never ready.
  let refusals = 2; // the first two opens fail: the delay has grown to 4 s by the time a port opens
  const silent = () => Object.assign(new EventEmitter(), { write: () => true, close() { this.emit('close'); } });
  const link = new Link({
    openPort: async () => {
      opened.push(Date.now());
      if (refusals-- > 0) throw new Error('no route');
      const d = devices.length === 0 ? new FakeS3({ proto: 1 }) : silent();
      devices.push(d);
      return d;
    },
    retryMs: 1000,
    retryMaxMs: 30_000,
    makeNonce: () => 7,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 3000); // tries at 0, 1 s and 3 s; the third opens
  assert.deepEqual(opened, [0, 1000, 3000]);
  assert.equal(link.ready, true);
  devices[0].close();
  await advance(t, 1000);
  assert.deepEqual(opened, [0, 1000, 3000, 4000], 'after a ready link the wait is 1 s again, not the 4 s the failures had built up');
  // Close it again before it was ever ready (the HELLO has not been answered yet): 2 s, then 4 s.
  const mute = devices[1];
  mute.close();
  await advance(t, 1000);
  assert.equal(opened.length, 4, 'not after 1 s, the delay is now 2 s');
  await advance(t, 1000);
  assert.equal(opened.length, 5);
  devices[2].close();
  await advance(t, 3000);
  assert.equal(opened.length, 5, 'and now 4 s');
  await advance(t, 1000);
  assert.equal(opened.length, 6);
});

test('close() ends the retries', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000, retryMaxMs: 30_000 });
  await link.start();
  link.close();
  await advance(t, 60_000);
  assert.deepEqual(tries, [0]);
});

test('an open that fails with a wait of its own is retried after that wait, and does not push the backoff on', async (t) => {
  clock(t);
  const tries = [];
  const link = new Link({
    openPort: async () => {
      tries.push(Date.now());
      const err = new Error('no S3');
      if (tries.length <= 3) err.retryInMs = 500;
      throw err;
    },
    retryMs: 1000,
    retryMaxMs: 30_000,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 4500, 500);
  assert.deepEqual(tries, [0, 500, 1000, 1500, 2500, 4500], 'three short waits, then the backoff from where it was: 1 s, 2 s');
});

test('a wait that is not a positive number is no wait of its own', async (t) => {
  clock(t);
  const hints = [0, -5, NaN, Infinity, '500', null, undefined];
  const tries = [];
  const link = new Link({
    openPort: async () => {
      const err = new Error('no S3');
      err.retryInMs = hints[tries.length];
      tries.push(Date.now());
      throw err;
    },
    retryMs: 1000,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 6000, 500);
  assert.deepEqual(tries, [0, 1000, 2000, 3000, 4000, 5000, 6000]);
});
