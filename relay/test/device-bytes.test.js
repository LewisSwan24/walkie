// The S3 talks to the relay through its own WebSocket client (firmware/lib/proto/src/proto/ws.cpp), which only the device runs. These
// are the bytes that code is tested to produce and take in firmware/host/test_ws.cpp, sent over a plain socket, so a change on
// either side that the other would not survive fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startRelay } from '../src/server.js';

const ROOM = '00112233445566778899aabbccddeeff';
// wsRequest("walkie-relay.fly.dev", "/r/<ROOM>?role=device", "the sample nonce"), as test_ws.cpp has it.
const REQUEST =
  `GET /r/${ROOM}?role=device HTTP/1.1\r\n` +
  'Host: walkie-relay.fly.dev\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  '\r\n';
// The answer test_ws.cpp's wsResponse() takes.
const RESPONSE =
  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
const MASKED_HELLO = Buffer.from('828537fa213d7f9f4d5158', 'hex'); // wsEncode(WS_BINARY, "Hello", 37fa213d)
const EMPTY_PONG = Buffer.from('8a8037fa213d', 'hex'); // wsEncode(WS_PONG, nothing, 37fa213d): what the S3 answers the relay's ping with

async function device(t, port) {
  const sock = net.connect(port, '127.0.0.1');
  t.after(() => sock.destroy());
  const s = { sock, got: Buffer.alloc(0), closed: false };
  sock.on('data', (d) => {
    s.got = Buffer.concat([s.got, d]);
  });
  sock.on('close', () => {
    s.closed = true;
  });
  await new Promise((resolve) => sock.once('connect', resolve));
  return s;
}

async function pcPeer(t, port) {
  const pc = new WebSocket(`ws://127.0.0.1:${port}/r/${ROOM}?role=pc`);
  pc.binaryType = 'arraybuffer';
  t.after(() => pc.close());
  const messages = [];
  pc.addEventListener('message', (e) => messages.push(Buffer.from(e.data).toString('hex')));
  await new Promise((resolve) => pc.addEventListener('open', resolve));
  return { pc, messages };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the S3's upgrade request is taken, and the answer is the one its parser is tested on", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  assert.equal(s.got.toString('latin1'), RESPONSE);
});

test("the S3's masked binary frame reaches the PC as the bytes it carried", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const { messages } = await pcPeer(t, relay.port);
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  s.sock.write(MASKED_HELLO);
  await until(() => messages.length === 1);
  assert.deepEqual(messages, ['48656c6c6f']);
});

test("the relay's ping is an empty one the S3 decodes, and an S3 that answers it stays", async (t) => {
  const relay = await startRelay({ pingEveryMs: 100 });
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  s.got = Buffer.alloc(0);
  for (let i = 0; i < 4; i++) {
    await until(() => s.got.length >= 2);
    assert.equal(s.got.subarray(0, 2).toString('hex'), '8900', 'an empty ping, FIN, unmasked');
    s.got = s.got.subarray(2);
    s.sock.write(EMPTY_PONG);
  }
  assert.equal(s.closed, false, 'still connected after four pings');
});

test('an S3 that does not answer the ping is dropped', async (t) => {
  const relay = await startRelay({ pingEveryMs: 100 });
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  await until(() => s.closed, 2000);
});
