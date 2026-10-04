// The relay as a port: the Link keeps speaking COBS-framed bytes, and each frame crosses the relay as one WebSocket message
// holding the raw envelope. The relay is the real one (relay/src/server.js) on a local port; the S3 is a bare WebSocket client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../../relay/src/server.js';
import { openRelayPort, relayUrl, RELAY_PING_EVERY_MS, RELAY_PONG_TIMEOUT_MS, CLOSE_REPLACED } from '../../src/link/relay-port.js';
import { encodeFrame, TYPE } from '../../src/link/frame.js';
import { cobsDecode, cobsEncode } from '../../src/link/cobs.js';
import { until } from '../helpers/fake-s3.js';

const ROOM = 'c'.repeat(32);

async function relayFor(t) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 });
  t.after(() => relay.close());
  return { relay, host: `ws://127.0.0.1:${relay.port}` };
}

// The S3's side: a WebSocket in the same room that keeps what it was sent.
async function device(t, host, room = ROOM) {
  const ws = new WebSocket(`${host}/r/${room}?role=device`);
  ws.binaryType = 'arraybuffer';
  ws.got = [];
  ws.addEventListener('message', (e) => ws.got.push(Buffer.from(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('the test device could not join')), { once: true });
  });
  t.after(() => ws.close());
  return ws;
}

const wire = (type, payload = Buffer.alloc(0), seq = 1) => Buffer.from(encodeFrame({ type, seq, payload }));
const inner = (w) => Buffer.from(cobsDecode(w.subarray(1, w.length - 1)));

async function port(t, host, options = {}) {
  const p = await openRelayPort({ host, room: ROOM, ...options });
  p.data = [];
  p.on('data', (d) => p.data.push(Buffer.from(d)));
  p.closes = 0;
  p.on('close', () => p.closes++);
  p.on('error', () => {});
  t.after(() => p.close());
  return p;
}

test('relayUrl: wss for a host, plain ws only for this machine, and nothing that is not a host name', () => {
  assert.equal(relayUrl('walkie-relay.fly.dev', ROOM, 'pc'), `wss://walkie-relay.fly.dev/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('relay.example.com:8443', ROOM, 'device'), `wss://relay.example.com:8443/r/${ROOM}?role=device`);
  assert.equal(relayUrl('ws://127.0.0.1:9000', ROOM, 'pc'), `ws://127.0.0.1:9000/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('ws://localhost:9000/', ROOM, 'pc'), `ws://localhost:9000/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('wss://relay.fly.dev', ROOM, 'pc'), `wss://relay.fly.dev/r/${ROOM}?role=pc`);
  for (const bad of ['ws://relay.fly.dev', '', 'a b', 'relay.fly.dev/x', 'relay.fly.dev?x=1', 'user@relay.fly.dev', 'http://relay.fly.dev', '-x.dev']) {
    assert.throws(() => relayUrl(bad, ROOM, 'pc'), RangeError, `refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => relayUrl('relay.fly.dev', 'abc', 'pc'), RangeError, 'a room is 32 lower-case hex digits');
  assert.throws(() => relayUrl('relay.fly.dev', ROOM, 'both'), RangeError, 'a role is pc or device');
});

test('what the Link writes reaches the S3 as the raw envelope, and what the S3 sends comes back as the COBS bytes the Link reads', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const down = wire(TYPE.PING, Buffer.from([1, 2, 3, 0, 4]), 7);
  p.write(down);
  await until(() => s3.got.length === 1, 'the S3 hears the frame');
  assert.deepEqual(s3.got[0], inner(down), 'one message, the envelope without COBS or delimiters');
  assert.equal(s3.got[0].length, 8 + 5);
  const up = wire(TYPE.PONG, Buffer.from([9, 0, 0, 9]), 8);
  s3.send(inner(up));
  await until(() => p.data.length === 1, 'the Link hears the frame');
  assert.deepEqual(p.data[0], up, 'identical to what the USB side would have delivered');
});

test('two frames in one write are two messages, and a write that is not a frame is not sent', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const a = wire(TYPE.PING, Buffer.from('a'), 1);
  const b = wire(TYPE.PING, Buffer.from('bb'), 2);
  p.write(Buffer.concat([a, b]));
  p.write(Buffer.from([0, 0xff, 0xff, 0xff, 0]));
  p.write(Buffer.alloc(0));
  p.write(Buffer.from([0]));
  p.write(wire(TYPE.PING, Buffer.from('c'), 3));
  await until(() => s3.got.length === 3, 'three frames and nothing else');
  assert.deepEqual(s3.got, [inner(a), inner(b), inner(wire(TYPE.PING, Buffer.from('c'), 3))]);
});

test('a frame with no payload is the smallest frame, and crosses both ways; a write that decodes to less or more than a frame is not sent', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const empty = wire(TYPE.PING, Buffer.alloc(0), 1);
  assert.equal(inner(empty).length, 8);
  p.write(empty);
  const bare = (n) => Buffer.concat([Buffer.from([0]), Buffer.from(cobsEncode(Buffer.alloc(n, 1))), Buffer.from([0])]);
  p.write(bare(7));
  p.write(bare(1033));
  p.write(wire(TYPE.PING, Buffer.alloc(1024, 3), 2));
  await until(() => s3.got.length === 2, 'the empty frame and the full one, nothing in between');
  assert.deepEqual(s3.got.map((g) => g.length), [8, 1032]);
  const back = wire(TYPE.PONG, Buffer.alloc(0), 3);
  s3.send(inner(back));
  await until(() => p.data.length === 1, 'the empty frame comes back');
  assert.deepEqual(p.data[0], back);
});

test('a message that cannot be a frame (too short, or longer than any frame) is dropped; the next one still comes through', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  s3.send(Buffer.alloc(7, 1));
  s3.send(Buffer.alloc(0));
  s3.send(Buffer.alloc(1033, 1));
  const good = wire(TYPE.PONG, Buffer.from('x'), 4);
  s3.send(inner(good));
  await until(() => p.data.length === 1, 'the good frame arrives');
  assert.deepEqual(p.data[0], good);
  assert.equal(p.data.length, 1, 'and only that');
  s3.send(Buffer.alloc(1032, 1));
  await until(() => p.data.length === 2, 'the largest envelope is carried (the decoder judges its CRC)');
});

test('the S3 not being there is not an error: the write goes nowhere, and nothing is kept for later', async (t) => {
  const { host } = await relayFor(t);
  const p = await port(t, host);
  p.write(wire(TYPE.PING, Buffer.from('early'), 1));
  await new Promise((r) => setTimeout(r, 50));
  const s3 = await device(t, host);
  p.write(wire(TYPE.PING, Buffer.from('late'), 2));
  await until(() => s3.got.length === 1, 'only the late frame');
  assert.deepEqual(s3.got[0], inner(wire(TYPE.PING, Buffer.from('late'), 2)));
});

test('close() closes once, a write after it is quiet, and the relay hanging up is a single close event', async (t) => {
  const { host, relay } = await relayFor(t);
  const p = await port(t, host);
  p.close();
  p.close();
  await until(() => p.closes === 1, 'one close event');
  p.write(wire(TYPE.PING, Buffer.alloc(0), 1));
  await until(() => relay.stats().connections === 0, 'the relay let go of it');
  const q = await port(t, host);
  relay.close();
  await until(() => q.closes === 1, 'the relay going away is a close');
  q.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q.closes, 1, 'never twice');
});

test('a second bridge in the room replaces the first, and the first is told why', async (t) => {
  const { host } = await relayFor(t);
  const first = await port(t, host);
  const second = await port(t, host);
  await until(() => first.closes === 1, 'the first is closed');
  assert.equal(first.closeCode, CLOSE_REPLACED);
  assert.equal(CLOSE_REPLACED, 4000);
  assert.equal(first.replaced, true);
  assert.equal(second.replaced, false);
  assert.equal(second.closes, 0);
});

test('a relay that is not there rejects the open, with the host in the message and no secret in it', async () => {
  await assert.rejects(
    openRelayPort({ host: 'ws://127.0.0.1:1', room: ROOM, connectTimeoutMs: 2000 }),
    (err) => err instanceof Error && /127\.0\.0\.1:1/.test(err.message) && !err.message.includes(ROOM),
  );
});

test('a relay that accepts the connection and never answers does not hang the open', async (t) => {
  const { createServer } = await import('node:net');
  const silent = createServer((s) => s.on('error', () => {}));
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => silent.close());
  const started = Date.now();
  await assert.rejects(openRelayPort({ host: `ws://127.0.0.1:${silent.address().port}`, room: ROOM, connectTimeoutMs: 200 }), /relay/);
  assert.ok(Date.now() - started < 2000, 'gave up at the timeout');
});

test('the relay port asks the Link for the slower clock of a network: ping every 5 s, a reply within 10 s', async (t) => {
  const { host } = await relayFor(t);
  const p = await port(t, host);
  assert.equal(RELAY_PING_EVERY_MS, 5000);
  assert.equal(RELAY_PONG_TIMEOUT_MS, 10_000);
  assert.equal(p.pingEveryMs, 5000);
  assert.equal(p.pongTimeoutMs, 10_000);
  assert.equal(p.kind, 'relay');
});
