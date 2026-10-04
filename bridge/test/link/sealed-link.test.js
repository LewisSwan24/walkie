// The Link with a pairing key: the handshake that proves both ends hold it, sealed frames both ways, and no way back to plaintext.
// The stand-in S3 (test/helpers/fake-s3.js) keeps the other end of the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { pingPayload } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const pong = (token) => Buffer.concat([u32(token), u32(1), u32(0), u32(0)]);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const settleFor = async (n = 5) => {
  for (let i = 0; i < n; i++) await settle();
};

async function connect(t, { s3 = {}, link: linkOptions = {}, nonces = [0x5eed1234] } = {}) {
  const device = new FakeS3({ proto: 2, ...s3 });
  let next = 0;
  const link = new Link({ openPort: async () => device, makeNonce: () => nonces[Math.min(next++, nonces.length - 1)], ...linkOptions });
  const seen = { status: [], down: [], hello: [], pong: [], frame: [] };
  for (const name of Object.keys(seen)) link.on(name, (x) => seen[name].push(x));
  t.after(() => link.close());
  await link.start();
  return { device, link, seen };
}

test('a paired walkie and a bridge with its key: ready once the first sealed frame opens, and every frame after HELLO is sealed', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'the link to be ready');
  assert.equal(seen.hello.length, 1);
  assert.equal(seen.hello[0].paired, true);
  assert.equal(link.credit, 12288, 'the sealed CREDIT that proved the key was still counted');
  await until(() => seen.pong.length > 0, 'a PONG to the sealed PING');
  const raw = device.raw.filter((f) => f.type !== TYPE.HELLO);
  assert.ok(raw.length > 0);
  assert.ok(raw.every((f) => f.flags & 0x80), 'every frame after HELLO carries the seal bit');
  assert.equal(device.refused.length, 0, 'and the S3 opened all of them');
  assert.ok(device.raw.filter((f) => f.type === TYPE.HELLO).every((f) => !(f.flags & 0x80)), 'HELLO stays plain');
});

test('the link is not ready until a sealed frame opens: with another key it never is, and after 3 s it says to pair again, once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { device, link, seen } = await connect(t, { s3: { master: OTHER }, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(device.refused.length > 0, 'the S3 refused the PING sealed under the wrong key');
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await settleFor();
  }
  assert.equal(link.ready, false);
  const said = seen.status.filter((s) => /walkie pair/.test(s));
  assert.equal(said.length, 1, `one message about the key: ${JSON.stringify(seen.status)}`);
  assert.ok(device.frames(TYPE.HELLO).length >= 4, 'and HELLO carries on');
});

test('a plain frame on a sealed link is refused, and 8 refusals in a row start the handshake over with a new nonce', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY }, nonces: [0x11, 0x22, 0x33] });
  await until(() => link.ready, 'ready');
  const before = seen.pong.length;
  device.feed(TYPE.PONG, pong(5), 0, { plain: true });
  await settleFor();
  assert.equal(seen.pong.length, before, 'the plain PONG was not taken');
  assert.equal(link.ready, true, 'one refusal is not the end of the link');
  for (let i = 0; i < 7; i++) device.feed(TYPE.PONG, pong(5), 0, { plain: true });
  await until(() => seen.down.length > 0, 'the link to be called down');
  assert.match(seen.down[0], /refused/);
  await until(() => device.frames(TYPE.HELLO).some((f) => f.payload.readUInt32LE(1) === 0x22), 'a HELLO with the next nonce');
  await until(() => link.ready, 'ready again under a new session');
});

test('a sealed frame replayed is refused', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  link.send(TYPE.PING, pingPayload(5));
  await until(() => seen.pong.some((p) => p.token === 5), 'PONG for token 5');
  const wire = device.out.at(-1);
  const n = seen.pong.length;
  device.emit('data', wire);
  await settleFor();
  assert.equal(seen.pong.length, n, 'the replayed PONG was not taken');
});

test('a walkie that is not paired is not talked to by a bridge that has a key, and nothing but HELLO is sent', async (t) => {
  const { device, link, seen } = await connect(t, { s3: {}, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /not paired/.test(s) && /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO], 'no PING, no plain frame of any kind');
});

test('an older walkie (proto 1) is treated the same way when the bridge has a key', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { proto: 1 }, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO]);
});

test('a walkie that is paired is not talked to by a bridge with no key, and it says why', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: {} });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /paired/.test(s) && /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO]);
});

test('with no key on either side the link is plain, proto 2 or not', async (t) => {
  const { device, link, seen } = await connect(t, { s3: {}, link: {} });
  await until(() => link.ready, 'ready');
  assert.equal(seen.hello[0].proto, 2);
  assert.equal(seen.hello[0].paired, false);
  await until(() => seen.pong.length > 0, 'PONG');
  assert.ok(device.raw.every((f) => !(f.flags & 0x80)), 'nothing is sealed');
});

test('a second HELLO answer with new session numbers while ready: the link keeps going on the new keys', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  device.rehello();
  await settleFor();
  assert.equal(link.ready, true);
  assert.equal(link.credit, 12288, 'credit started over and the new CREDIT was counted');
  link.send(TYPE.PING, pingPayload(9));
  await until(() => seen.pong.some((p) => p.token === 9), 'a PONG on the new session');
  assert.equal(seen.hello.length, 1, 'one hello event for the link');
});

test('pairing mode: plain HELLO, no PING, frames of type PAIR only', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { pairing: true } });
  await until(() => link.ready, 'ready, though the walkie is paired and there is no key');
  device.feed(TYPE.PAIR, Buffer.from([3, 1]), 0, { plain: true });
  await until(() => seen.frame.some((f) => f.type === TYPE.PAIR), 'the PAIR frame');
  assert.deepEqual([...seen.frame.find((f) => f.type === TYPE.PAIR).payload], [3, 1]);
  assert.equal(link.credit, 0, 'a sealed CREDIT it cannot open grants nothing');
  assert.equal(device.raw.filter((f) => f.type === TYPE.PING).length, 0, 'a paired walkie would not answer a plain PING, so none is sent');
  link.send(TYPE.PAIR, Buffer.from([2]));
  await until(() => device.frames(TYPE.PAIR).length === 1, 'the PAIR frame reaching the S3');
  assert.ok(!(device.raw.find((f) => f.type === TYPE.PAIR).flags & 0x80), 'PAIR goes out plain');
});

test('PAIR goes out plain even on a sealed link: the type is never sealed', async (t) => {
  const { device, link } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  link.send(TYPE.PAIR, Buffer.from([2]));
  await until(() => device.raw.some((f) => f.type === TYPE.PAIR), 'the PAIR frame');
  assert.ok(!(device.raw.find((f) => f.type === TYPE.PAIR).flags & 0x80));
});

test('a key that is not 32 bytes, or a key together with pairing mode, is refused', () => {
  const openPort = async () => new FakeS3();
  assert.throws(() => new Link({ openPort, master: Buffer.alloc(5) }), TypeError);
  assert.throws(() => new Link({ openPort, master: KEY, pairing: true }), TypeError);
  assert.doesNotThrow(() => new Link({ openPort, master: KEY }));
});

test('a frame that cannot be sealed any more takes the link down instead of going out plain', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY, firstCounter: 0xfffffffe } });
  await until(() => link.ready, 'ready');
  await settleFor();
  let sent = 0;
  for (let i = 0; i < 5; i++) if (link.send(TYPE.PING, pingPayload(100 + i))) sent++;
  assert.ok(sent < 5, 'the counter ran out');
  assert.ok(seen.down.some((d) => /counter/.test(d)), JSON.stringify(seen.down));
  assert.ok(device.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'and nothing went out plain');
});
