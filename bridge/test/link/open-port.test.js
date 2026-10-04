// The openPort that `walkie` gives the Link: the cable alone unless there is a pairing key and a relay, then the transport chooser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bridgeOpenPort, describeTransport } from '../../src/link/open-port.js';
import { Link } from '../../src/link/link.js';
import { roomId } from '../../src/link/room.js';
import { FakeS3, until } from '../helpers/fake-s3.js';
import { relayedS3 } from '../helpers/relay-s3.js';

const KEY = Buffer.alloc(32, 0x42);

class StubPort extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
  }
  close() {
    this.emit('close');
  }
}

// `usb` is the path the search finds now, and may be changed.
function deps(over = {}) {
  const d = {
    calls: { found: 0, usb: [], relay: [] },
    usb: over.usb ?? null,
    findS3Port: async () => {
      d.calls.found++;
      return d.usb;
    },
    openS3Port: async (path) => {
      d.calls.usb.push(path);
      if (over.usbError) throw over.usbError;
      return new StubPort(`usb ${path}`);
    },
    openRelayPort: async (o) => {
      d.calls.relay.push(o);
      return new StubPort('relay');
    },
  };
  return d;
}

test('--port COM8 is the cable and only the cable, whatever else is configured', async () => {
  const d = deps();
  const open = bridgeOpenPort({ port: 'COM8', master: KEY, relayHost: () => 'walkie.fly.dev', ...d });
  const port = await open();
  assert.equal(port.label, 'usb COM8');
  assert.deepEqual(d.calls.usb, ['COM8']);
  assert.deepEqual(d.calls.relay, []);
  assert.equal(d.calls.found, 0, 'it was told which port, so it does not look');
});

test('with no relay set it is the cable alone: the S3 found, or an error whose message is as it always was, retried at the short wait', async () => {
  const found = deps({ usb: 'COM9' });
  assert.equal((await bridgeOpenPort({ master: KEY, relayHost: () => null, ...found })()).label, 'usb COM9');
  const none = deps();
  await assert.rejects(bridgeOpenPort({ master: KEY, relayHost: () => null, ...none })(), (err) => err.message === 'no S3 on USB (303A:1001)' && err.retryInMs === 1000);
});

test('a cable that is there but cannot be opened is an error the Link retries at the short wait', async () => {
  const d = deps({ usb: 'COM9', usbError: new Error('Access denied') });
  await assert.rejects(bridgeOpenPort({ relayHost: () => null, ...d })(), (err) => /Access denied/.test(err.message) && err.retryInMs === 1000);
});

test('a relay without a pairing key is not used: nothing names the room but the key', async () => {
  const d = deps();
  await assert.rejects(bridgeOpenPort({ master: null, relayHost: () => 'walkie.fly.dev', ...d })(), /no S3 on USB \(303A:1001\)/);
  assert.deepEqual(d.calls.relay, []);
});

test('with a key and a relay and no cable it joins the room the key names, as the PC, at the host in the file now', async () => {
  const d = deps();
  let host = 'one.fly.dev';
  const open = bridgeOpenPort({ master: KEY, relayHost: () => host, ...d });
  const port = await open();
  assert.equal(port.label, 'relay');
  assert.deepEqual(d.calls.relay, [{ host: 'one.fly.dev', room: roomId(KEY) }]);
  host = 'two.fly.dev';
  await open();
  assert.equal(d.calls.relay[1].host, 'two.fly.dev', 'the file is read on every open');
  host = null;
  await assert.rejects(open(), /no S3 on USB \(303A:1001\)/, 'a relay that was taken out of the file is no longer tried');
});

test('with a key and a relay the cable still comes first', async () => {
  const d = deps({ usb: 'COM9' });
  const port = await bridgeOpenPort({ master: KEY, relayHost: () => 'walkie.fly.dev', ...d })();
  assert.equal(port.label, 'usb COM9');
  assert.deepEqual(d.calls.relay, []);
});

test('what the chooser says goes to the log', async () => {
  const lines = [];
  const d = deps();
  const open = bridgeOpenPort({ master: KEY, relayHost: () => 'walkie.fly.dev', log: (s) => lines.push(s), pollMs: 20, ...d });
  const relay = await open();
  d.usb = 'COM9';
  try {
    await until(() => lines.length > 0, 'a line about leaving the relay', 1500);
  } finally {
    relay.close();
  }
  assert.deepEqual(lines, ['the S3 is on USB: leaving the relay']);
});

test('describeTransport says in one line which way the bridge will go', () => {
  assert.equal(describeTransport({ master: KEY, host: 'walkie.fly.dev', port: null }), 'USB when the S3 is on it, else the relay at walkie.fly.dev');
  assert.equal(describeTransport({ master: KEY, host: null, port: null }), 'USB only (no relay set: node bridge/bin/walkie.js relay <host>)');
  assert.equal(describeTransport({ master: null, host: 'walkie.fly.dev', port: null }), 'USB only: the relay at walkie.fly.dev needs a pairing key (node bridge/bin/walkie.js pair)');
  assert.equal(describeTransport({ master: null, host: null, port: null }), 'USB only');
  assert.equal(describeTransport({ master: KEY, host: 'walkie.fly.dev', port: 'COM8' }), 'USB only, on COM8 as asked');
});

// The real relay, a stand-in S3 behind it, and a stand-in S3 on the cable: the Link starts on the relay and moves to the cable.
test('on the relay, plugging the cable in moves the link to it, sealed, without anyone restarting anything', async (t) => {
  const behind = new FakeS3({ proto: 2, master: KEY });
  const relayed = await relayedS3(t, behind, { master: KEY });
  const onCable = new FakeS3({ proto: 2, master: KEY });
  let cable = null;
  const opened = [];
  const open = bridgeOpenPort({
    master: KEY,
    relayHost: () => relayed.host,
    pollMs: 30,
    findS3Port: async () => cable,
    openS3Port: async (path) => {
      opened.push(path);
      return onCable;
    },
    openRelayPort: (o) => relayed.openPort(o),
  });
  const link = new Link({ openPort: open, master: KEY, makeNonce: () => 5, retryMs: 20 });
  const down = [];
  link.on('down', (r) => down.push(r));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'ready over the relay');
  assert.deepEqual(opened, []);
  const pingsBefore = onCable.sent.length;
  cable = 'COM9';
  await until(() => opened.length === 1, 'the cable to be opened', 1500);
  await until(() => link.ready && onCable.sent.length > pingsBefore, 'ready again, over the cable');
  assert.deepEqual(opened, ['COM9']);
  assert.equal(onCable.refused.length, 0, 'the cable end opened everything it was sent');
  assert.ok(down.length >= 1, 'the move was a down and an up, not a silent swap');
});
