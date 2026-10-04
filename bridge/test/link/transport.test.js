// Which carrier the Link gets: the cable when the S3 is on it, the relay when it is not, and back to the cable when it appears while
// the bridge is on the relay. All three ways of opening a port are stubs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chooseTransport } from '../../src/link/transport.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

class StubPort extends EventEmitter {
  closed = 0;
  constructor(kind) {
    super();
    this.kind = kind;
  }
  close() {
    this.closed++;
    this.emit('close');
  }
}

// `usb`: the path findUsb answers with (changeable); `host`: what the relay config holds (changeable).
function setup(t, { usb = null, host = null, ...options } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const s = {
    usb,
    host,
    finds: 0,
    usbOpens: [],
    relayOpens: [],
    ports: [],
    said: [],
    findUsb: async () => {
      s.finds++;
      if (s.findError) throw s.findError;
      return s.usb;
    },
    openUsb: async (path) => {
      s.usbOpens.push(path);
      if (s.usbError) throw s.usbError;
      const p = new StubPort(undefined);
      s.ports.push(p);
      return p;
    },
    openRelay: async (h) => {
      s.relayOpens.push(h);
      if (s.relayError) throw s.relayError;
      const p = new StubPort('relay');
      s.ports.push(p);
      return p;
    },
  };
  s.openPort = chooseTransport({
    findUsb: s.findUsb,
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => s.host,
    status: (text) => s.said.push(text),
    ...options,
  });
  t.after(() => s.ports.forEach((p) => p.removeAllListeners()));
  return s;
}

test('the S3 on USB is opened, and the relay is not touched even when one is set', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  const port = await s.openPort();
  assert.deepEqual(s.usbOpens, ['COM8']);
  assert.deepEqual(s.relayOpens, []);
  assert.equal(port, s.ports[0]);
  assert.equal(port.kind, 'usb');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(s.finds, 1, 'a cable needs no watching');
});

test('no S3 on USB and a relay set: the relay is opened, with the host as it is now', async (t) => {
  const s = setup(t, { host: 'one.fly.dev' });
  const port = await s.openPort();
  assert.deepEqual(s.relayOpens, ['one.fly.dev']);
  assert.equal(port.kind, 'relay');
  s.host = 'two.fly.dev';
  port.close();
  await s.openPort();
  assert.deepEqual(s.relayOpens, ['one.fly.dev', 'two.fly.dev'], 'the config is read on every open');
});

test('no S3 on USB and no relay set: it fails saying how to set one, and opens nothing', async (t) => {
  const s = setup(t);
  await assert.rejects(s.openPort(), /no S3 on USB, and no relay set \(walkie relay <host>\)/);
  assert.deepEqual([s.usbOpens, s.relayOpens], [[], []]);
  s.host = '';
  await assert.rejects(s.openPort(), /no relay set/, 'an empty host is no host');
});

test('the S3 is on USB but cannot be opened: that is the answer, not a reason to go round by the relay', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.usbError = new Error('Access denied');
  await assert.rejects(s.openPort(), /cannot open the S3 on USB \(Access denied\)/);
  assert.deepEqual(s.relayOpens, []);
});

test('a failure of the port search counts as no S3 on USB', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.findError = new Error('list failed');
  const port = await s.openPort();
  assert.equal(port.kind, 'relay');
});

test('a relay that cannot be reached is the open failing, with its own message', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  s.relayError = new Error('could not reach the relay at walkie.fly.dev');
  await assert.rejects(s.openPort(), /could not reach the relay at walkie\.fly\.dev/);
});

test('on the relay it looks for the S3 on USB every 3 s, and when it is there the relay is let go, so the next open is the cable', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const relay = await s.openPort();
  assert.equal(s.finds, 1);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(s.finds, 1, 'not before 3 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(s.finds, 2);
  assert.equal(relay.closed, 0, 'no cable yet');
  s.usb = 'COM8';
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(relay.closed, 1, 'the cable is in: the relay is let go');
  assert.deepEqual(s.said, ['the S3 is on USB: leaving the relay']);
  const next = await s.openPort();
  assert.deepEqual(s.usbOpens, ['COM8']);
  assert.equal(next.kind, 'usb');
});

test('the looking stops when the relay port is gone, and starts again with the next one', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const relay = await s.openPort();
  relay.close();
  const finds = s.finds;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(s.finds, finds, 'nothing is watched');
  await s.openPort();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(s.finds, finds + 2, 'one for the open, one for the first look');
});

test('a slow search is not run twice at once', async (t) => {
  const s = setup(t);
  let calls = 0;
  let running = 0;
  let most = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const open = chooseTransport({
    findUsb: async () => {
      if (++calls === 1) return null; // the open itself
      running++;
      most = Math.max(most, running);
      await gate;
      running--;
      return null;
    },
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => 'walkie.fly.dev',
  });
  await open();
  t.mock.timers.tick(9000); // three polls come due while the first search is still running
  await flush();
  assert.equal(calls, 2, 'only the first poll started a search');
  assert.equal(most, 1);
  release();
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls, 3, 'the next poll runs once the search is over');
});

test('a search that finishes after the relay port closed on its own does not close anything again', async (t) => {
  const s = setup(t);
  let calls = 0;
  let finish;
  const lateUsb = new Promise((resolve) => (finish = resolve));
  const open = chooseTransport({
    findUsb: async () => {
      if (++calls === 1) return null;
      await lateUsb;
      return 'COM8';
    },
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => 'walkie.fly.dev',
    status: (x) => s.said.push(x),
  });
  const port = await open();
  t.mock.timers.tick(3000); // a search starts and waits
  await flush();
  assert.equal(calls, 2);
  port.close(); // the relay hangs up first
  finish();
  await flush();
  assert.equal(port.closed, 1, 'closed once, by the relay');
  assert.deepEqual(s.said, [], 'and no claim that it left the relay');
});

test('a bridge replaced in the room by another does not take the room back for 5 minutes, and says so once', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.closeCode = 4000;
  first.replaced = true;
  first.close();
  assert.equal(s.said.length, 1);
  assert.match(s.said[0], /^another walkie run took the relay room; not going back to it for 5 min$/);
  await assert.rejects(s.openPort(), /another walkie run holds the relay room/);
  t.mock.timers.tick(299_000);
  await assert.rejects(s.openPort(), /another walkie run holds the relay room/);
  assert.equal(s.relayOpens.length, 1, 'the relay is not dialled in the meantime');
  t.mock.timers.tick(1000);
  const again = await s.openPort();
  assert.equal(again.kind, 'relay');
  assert.equal(s.said.length, 1, 'nothing more was said');
});

test('the cable is still taken during the penalty: only the relay is held back', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.replaced = true;
  first.close();
  s.usb = 'COM8';
  const port = await s.openPort();
  assert.equal(port.kind, 'usb');
});

test('a relay port that closed for another reason carries no penalty', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.replaced = false;
  first.close();
  const second = await s.openPort();
  assert.equal(second.kind, 'relay');
  assert.deepEqual(s.said, []);
});

test('the penalty and the poll are settable', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev', pollMs: 100, replacedPenaltyMs: 1000 });
  const first = await s.openPort();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(s.finds, 2, 'a poll every 100 ms');
  first.replaced = true;
  first.close();
  await assert.rejects(s.openPort(), /another walkie run/);
  t.mock.timers.tick(1000);
  await s.openPort();
});

test('a cable that cannot be opened, and a relay that is not set, are errors for the short wait: the cable may be plugged in any moment', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.usbError = new Error('Access denied');
  await assert.rejects(s.openPort(), (err) => err.retryInMs === 1000);
  s.usb = null;
  s.host = null;
  await assert.rejects(s.openPort(), (err) => /no relay set/.test(err.message) && err.retryInMs === 1000);
});

test('a relay held back, and a relay that cannot be reached, are left to the backoff', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  s.relayError = new Error('could not reach the relay');
  await assert.rejects(s.openPort(), (err) => err.retryInMs === undefined);
  s.relayError = null;
  const first = await s.openPort();
  first.replaced = true;
  first.close();
  await assert.rejects(s.openPort(), (err) => err.retryInMs === undefined);
});
