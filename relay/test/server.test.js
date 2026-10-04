// The relay with real WebSocket clients on a local port: rooms, replacement, no buffering, limits. It never parses what it forwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { WebSocket } from 'ws';
import { CLOSE_REPLACED, MAX_MESSAGE, startRelay } from '../src/server.js';

const ROOM = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

async function relayFor(t, options = {}) {
  const relay = await startRelay(options);
  t.after(() => relay.close());
  return relay;
}

// A client with everything it received, resolved once it is open.
async function client(relay, role, { room = ROOM, headers } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${room}?role=${role}`, { headers });
  ws.got = [];
  ws.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (data, isBinary) => ws.got.push({ data: Buffer.from(data), isBinary }));
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}

// What a refused upgrade answered: the status line's code.
async function refusedWith(relay, pathAndQuery, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${pathAndQuery}`, { headers });
  ws.on('error', () => {});
  const [, res] = await once(ws, 'unexpected-response');
  res.resume();
  return res.statusCode;
}

// An upgrade written by hand, for requests no WebSocket client would send: what came back before the relay hung up.
async function rawUpgrade(relay, requestLine) {
  const socket = net.connect(relay.port, '127.0.0.1');
  await once(socket, 'connect');
  let answer = '';
  socket.on('data', (d) => {
    answer += d;
  });
  socket.on('error', () => {});
  socket.write(`${requestLine}\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
  await once(socket, 'close', { signal: AbortSignal.timeout(3000) }); // a relay that threw never hangs up
  return answer;
}

const until = async (check, what, ms = 3000) => {
  for (let waited = 0; !check() && waited < ms; waited += 10) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), what);
};

test('a PC and a device in one room hear each other, and the bytes arrive as they were sent', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  const down = Buffer.from(Array.from({ length: 1032 }, (_, i) => (i * 7) & 0xff));
  const up = Buffer.from([0, 1, 2, 3, 0, 255]);
  pc.send(down);
  device.send(up);
  await until(() => device.got.length === 1 && pc.got.length === 1, 'both messages arrive');
  assert.deepEqual(device.got[0], { data: down, isBinary: true });
  assert.deepEqual(pc.got[0], { data: up, isBinary: true });
  assert.equal(relay.stats().forwarded, 2);
});

test('nothing is kept for a peer that is not there: a message sent early is gone when the peer arrives', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  pc.send(Buffer.from('early'));
  await until(() => relay.stats().dropped === 1, 'the relay dropped it');
  const device = await client(relay, 'device');
  pc.send(Buffer.from('late'));
  await until(() => device.got.length === 1, 'the later one arrives');
  assert.equal(device.got[0].data.toString(), 'late');
  assert.equal(device.got.length, 1);
});

test('a second connection of the same role replaces the first, which is told so, and traffic goes to the new one', async (t) => {
  const relay = await relayFor(t);
  const first = await client(relay, 'device');
  const pc = await client(relay, 'pc');
  const second = await client(relay, 'device');
  assert.equal(await first.closed, CLOSE_REPLACED);
  pc.send(Buffer.from('hello'));
  await until(() => second.got.length === 1, 'the new device hears it');
  assert.equal(first.got.length, 0);
  assert.equal(relay.stats().replaced, 1);
  assert.equal(relay.stats().connections, 2);
});

test('rooms are separate: a message in one never reaches another', async (t) => {
  const relay = await relayFor(t);
  const deviceB = await client(relay, 'device', { room: OTHER }); // first, so a message that went to "any device" would find it
  const pcA = await client(relay, 'pc', { room: ROOM });
  const deviceA = await client(relay, 'device', { room: ROOM });
  pcA.send(Buffer.from('for A'));
  await until(() => deviceA.got.length === 1, 'A hears it');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(deviceB.got.length, 0);
  assert.equal(relay.stats().rooms, 2);
});

test('a room is forgotten when both have gone, and a peer that leaves is not written to', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  device.close();
  await device.closed;
  pc.send(Buffer.from('anyone?'));
  await until(() => relay.stats().dropped === 1, 'dropped, not sent to a closed socket');
  pc.close();
  await pc.closed;
  await until(() => relay.stats().rooms === 0, 'the room is gone');
  assert.equal(relay.stats().connections, 0);
});

test('only /r/<32 hex>?role=pc|device is let in: anything else is a 400 and holds no slot', async (t) => {
  const relay = await relayFor(t);
  assert.equal(await refusedWith(relay, `/r/${'a'.repeat(31)}?role=pc`), 400, 'short id');
  assert.equal(await refusedWith(relay, `/r/${'A'.repeat(32)}?role=pc`), 400, 'upper case id');
  assert.equal(await refusedWith(relay, `/r/${ROOM}?role=phone`), 400, 'unknown role');
  assert.equal(await refusedWith(relay, `/r/${ROOM}`), 400, 'no role');
  assert.equal(await refusedWith(relay, `/x/${ROOM}?role=pc`), 400, 'wrong path');
  assert.equal(relay.stats().connections, 0);
  assert.equal(relay.stats().refused, 5);
});

test('the total number of connections is limited, and a slot comes back when one closes', async (t) => {
  const relay = await relayFor(t, { maxConnections: 2, maxPerIp: 99 });
  const a = await client(relay, 'pc', { room: ROOM });
  await client(relay, 'device', { room: ROOM });
  assert.equal(await refusedWith(relay, `/r/${OTHER}?role=pc`), 503);
  a.close();
  await a.closed;
  await until(() => relay.stats().connections === 1, 'a slot is free');
  await client(relay, 'pc', { room: OTHER });
});

test('each address is limited, by the address the proxy reports when the relay trusts it', async (t) => {
  const direct = await relayFor(t, { maxPerIp: 1 });
  const first = await client(direct, 'pc', { room: ROOM });
  assert.equal(await refusedWith(direct, `/r/${OTHER}?role=pc`), 429, 'one address, one connection');
  first.close();
  await first.closed;
  await until(() => direct.stats().connections === 0, 'the connection is gone');
  await client(direct, 'pc', { room: OTHER }); // the address has its slot back

  const proxied = await relayFor(t, { maxPerIp: 1, trustProxy: true });
  await client(proxied, 'pc', { room: ROOM, headers: { 'fly-client-ip': '203.0.113.1' } });
  await client(proxied, 'pc', { room: OTHER, headers: { 'fly-client-ip': '203.0.113.2' } });
  assert.equal(await refusedWith(proxied, `/r/${'c'.repeat(32)}?role=pc`, { 'fly-client-ip': '203.0.113.1' }), 429);

  const untrusting = await relayFor(t, { maxPerIp: 1 });
  await client(untrusting, 'pc', { room: ROOM, headers: { 'fly-client-ip': '203.0.113.1' } });
  assert.equal(await refusedWith(untrusting, `/r/${OTHER}?role=pc`, { 'fly-client-ip': '203.0.113.2' }), 429, 'the header is ignored');
});

test('a message over the frame limit closes the sender and goes nowhere; a text message is refused', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  assert.equal(MAX_MESSAGE, 1100, 'the largest frame the link carries');
  pc.send(Buffer.alloc(1100));
  await until(() => device.got.length === 1, 'the largest frame goes through');
  pc.send(Buffer.alloc(1101));
  assert.equal(await pc.closed, 1009);
  device.send('text, not a frame');
  assert.equal(await device.closed, 1003);
  assert.equal(device.got.length, 1);
});

test('GET /healthz answers ok, and anything else that is not an upgrade is a 404', async (t) => {
  const relay = await relayFor(t);
  const ok = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}?role=pc`)).status, 404);
});

test('a peer that stops answering pings is dropped from its room', async (t) => {
  const relay = await relayFor(t, { pingEveryMs: 40 });
  const device = await client(relay, 'device');
  device._socket.pause(); // reads nothing, so it never says pong
  await until(() => relay.stats().connections === 0, 'the silent peer was reaped', 2000);
});

test('an upgrade the WebSocket handshake itself turns down (no Sec-WebSocket-Key) gives its slot back', async (t) => {
  const relay = await relayFor(t, { maxPerIp: 1 });
  assert.match(await rawUpgrade(relay, `GET /r/${ROOM}?role=pc HTTP/1.1`), /^HTTP\/1\.1 400/);
  await until(() => relay.stats().connections === 0, 'no slot is held by it');
  await client(relay, 'pc'); // the one this address may have
});

test('a request line that is not a URL is a 400, and the relay goes on', async (t) => {
  const relay = await relayFor(t);
  assert.match(await rawUpgrade(relay, 'GET http://[ HTTP/1.1'), /^HTTP\/1\.1 400/);
  assert.equal(relay.stats().refused, 1);
  await client(relay, 'pc');
});
