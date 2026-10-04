// runNet: one sealed NET request to the S3 and its answer (protocol/frames.md, "Network settings (plan 6)"). The stand-in S3 keeps the
// networks the way the firmware does (test/helpers/fake-net.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNet } from '../src/net.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from '../src/link/messages.js';
import { SEALED } from '../src/link/session.js';
import { FakeNetConf } from './helpers/fake-net.js';
import { FakeS3 } from './helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 0x42);
const FAST = { helloMs: 3000, answerMs: 3000, retryMs: 20, makeNonce: () => 0x1234abcd };

function setup(deviceOptions = {}) {
  const device = new FakeS3({ proto: 2, master: KEY, ...deviceOptions });
  const run = (request, options = {}) => runNet({ openPort: async () => device, master: KEY, request, ...FAST, ...options });
  return { device, run };
}

test('WIFI_ADD is taken by a paired S3 over the sealed link, and answered OK', async () => {
  const { device, run } = setup();
  const { reply } = await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual(reply, { kind: 'ok', answered: NET_OP.WIFI_ADD });
  assert.deepEqual(device.net.nets, [{ ssid: 'home', pass: 'secret123' }]);
  assert.equal(device.netRequests.length, 1);
  assert.equal(device.netRefused, 0);
});

test('the request travelled sealed: on the wire it is not the plain bytes, and no password is in it', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  const net = device.raw.find((f) => f.type === 0x33);
  assert.ok(net.flags & SEALED, 'the seal bit is set');
  assert.ok(!net.payload.includes(Buffer.from('secret123')), 'the password is not in the clear');
  assert.ok(!net.payload.includes(Buffer.from('home')), 'nor is the SSID');
});

test('LIST names the networks in the order they were added and the relay host, and never a password', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  await run(netWifiAddPayload('cafe', ''));
  await run(netRelaySetPayload('walkie-relay.fly.dev'));
  const { reply } = await run(netWifiListPayload());
  assert.deepEqual(reply, { kind: 'list', ssids: ['home', 'cafe'], host: 'walkie-relay.fly.dev' });
  assert.deepEqual(device.net.nets.map((n) => n.ssid), ['home', 'cafe']);
});

test('REMOVE, and an SSID that is not held is ERR UNKNOWN', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual((await run(netWifiRemovePayload('home'))).reply, { kind: 'ok', answered: NET_OP.WIFI_REMOVE });
  assert.deepEqual(device.net.nets, []);
  assert.deepEqual((await run(netWifiRemovePayload('home'))).reply, { kind: 'err', answered: NET_OP.WIFI_REMOVE, reason: NET_ERR.UNKNOWN });
});

test('a fifth network is ERR FULL', async () => {
  const { run } = setup();
  for (const ssid of ['a', 'b', 'c', 'd']) assert.equal((await run(netWifiAddPayload(ssid, ''))).reply.kind, 'ok');
  assert.deepEqual((await run(netWifiAddPayload('e', ''))).reply, { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.FULL });
});

test('a change the S3 cannot save is ERR STORE and changes nothing', async () => {
  const { device, run } = setup();
  device.net.failSave = true;
  assert.deepEqual((await run(netWifiAddPayload('home', 'secret123'))).reply, { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.STORE });
  assert.deepEqual(device.net.nets, []);
});

test('the relay host is set and cleared', async () => {
  const { device, run } = setup();
  assert.equal((await run(netRelaySetPayload('walkie-relay.fly.dev'))).reply.kind, 'ok');
  assert.equal(device.net.relay, 'walkie-relay.fly.dev');
  assert.equal((await run(netRelayClearPayload())).reply.kind, 'ok');
  assert.equal(device.net.relay, null);
});

test('only the answer to the request that was asked counts', async () => {
  const { device, run } = setup();
  // Another op's answer comes first (sealed, as the S3 would send it), then the one asked for.
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([NET_OP.OK, NET_OP.RELAY_SET]));
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiListPayload());
  assert.equal(reply.kind, 'list');
});

test('an S3 with no key never takes NET: a sealed request cannot even be made, and the S3 says nothing', async () => {
  const device = new FakeS3({ proto: 2 }); // no key
  await assert.rejects(runNet({ openPort: async () => device, master: null, request: netWifiListPayload(), ...FAST }), /pairing key/);
  assert.equal(device.sent.filter((f) => f.type === 0x33).length, 0);
});

test('with the wrong key there is no sealed link, so no answer and no request taken', async () => {
  const device = new FakeS3({ proto: 2, master: Buffer.alloc(32, 0x5a) });
  await assert.rejects(
    runNet({ openPort: async () => device, master: KEY, request: netWifiListPayload(), ...FAST, helloMs: 300 }),
    /no walkie answered within 0.3 s/,
  );
  assert.equal(device.netRequests.length, 0);
});

test('no walkie at all is an error that says what to check', async () => {
  const device = new FakeS3({ proto: 2, master: KEY });
  device.write = () => true; // a port nobody answers on
  await assert.rejects(
    runNet({ openPort: async () => device, master: KEY, request: netWifiListPayload(), ...FAST, helloMs: 200 }),
    /no walkie answered within 0.2 s: is it plugged in/,
  );
});

test('an S3 that takes the request and says nothing is null after answerMs, and the link is closed', async () => {
  const { device, run } = setup();
  device.net.handle = () => null; // taken as far as the frame goes, never answered
  const { reply } = await run(netWifiListPayload(), { answerMs: 200 });
  assert.equal(reply, null);
  assert.equal(device.listenerCount('data'), 0, 'the link let go of the port');
});

test('the link is closed after an answer too', async () => {
  const { device, run } = setup();
  await run(netWifiListPayload());
  assert.equal(device.listenerCount('data'), 0);
});


test('a LIST reply is not the answer to a request that was not LIST', async () => {
  const { device, run } = setup();
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([0x82, 0, 0])); // an empty list, as if for another request
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual(reply, { kind: 'ok', answered: NET_OP.WIFI_ADD });
});

test('a NET frame that is not a reply at all is passed over, and the real answer still counts', async () => {
  const { device, run } = setup();
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([0x7f, 1, 2]));
    device.feed(0x33, Buffer.alloc(0));
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiListPayload());
  assert.equal(reply.kind, 'list');
});

test('the wait for the answer is answerMs, not the wait for HELLO', async () => {
  const { device, run } = setup();
  device.net.handle = () => null;
  const started = Date.now();
  const { reply } = await run(netWifiListPayload(), { helloMs: 5000, answerMs: 150 });
  assert.equal(reply, null);
  assert.ok(Date.now() - started < 2500, `gave up after ${Date.now() - started} ms`);
});
