import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Link } from '../../src/link/link.js';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { vectors, hex } from '../vectors.js';

// Stands in for the S3's serial port: records what the Link writes, and feeds it frames.
class FakePort extends EventEmitter {
  written = [];
  #seq = 0;
  write(buf) {
    this.written.push(Buffer.from(buf));
    return true;
  }
  close() {
    this.emit('close');
  }
  feed(type, payload = Buffer.alloc(0), flags = 0) {
    this.emit('data', Buffer.from(encodeFrame({ type, flags, seq: this.#seq++, payload })));
  }
  sent() {
    const d = new FrameDecoder();
    return this.written.flatMap((b) => d.push(b));
  }
}

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
// The vector's HELLO answers nonce 0x5eed1234; the Links under test pick that nonce.
const NONCE = 0x5eed1234;
const HELLO = hex(vectors.messages.find((m) => m.name === 'hello_device').hex);
const helloWithNonce = (nonce) => {
  const p = Buffer.from(HELLO);
  p.writeUInt32LE(nonce, 14);
  return p;
};
const played = (bytes, reason) => Buffer.concat([u32(bytes), u32(0), u32(0), u32(0), Buffer.from([reason])]);
const audio = (port) => port.sent().filter((f) => f.type === TYPE.AUDIO_DOWN).map((f) => [f.payload.length, f.flags]);
const settle = () => new Promise((r) => setImmediate(r));

async function readyLink(t) {
  const port = new FakePort();
  const link = new Link({ openPort: async () => port, makeNonce: () => NONCE });
  t.after(() => link.close());
  await link.start();
  port.feed(TYPE.HELLO, HELLO);
  return { port, link };
}

test('says HELLO every second until walkie answers it, ignoring what came before', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const port = new FakePort();
  const link = new Link({ openPort: async () => port, makeNonce: () => NONCE });
  t.after(() => link.close());
  const logs = [];
  link.on('log', (s) => logs.push(s));
  await link.start();
  port.feed(TYPE.LOG, Buffer.from('from before the bridge connected'));
  port.feed(TYPE.HELLO, helloWithNonce(0)); // queued at boot
  port.feed(TYPE.HELLO, helloWithNonce(7)); // an answer to some earlier bridge
  assert.equal(link.ready, false);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => [f.type, f.payload.toString('hex')]), [
    [TYPE.HELLO, '013412ed5e'],
    [TYPE.HELLO, '013412ed5e'],
  ]);
  let hello = null;
  link.on('hello', (h) => { hello = h; });
  port.feed(TYPE.HELLO, HELLO);
  assert.equal(link.ready, true);
  assert.equal(hello.version, '0.1.0');
  assert.deepEqual(logs, []);
  // The first PING goes with the answer, not a second later: until the S3 has had one it shows its offline screen.
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING]);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING, TYPE.PING]);
});

test('a second answer to the same HELLO starts credit over, as the S3 did', async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(12288));
  assert.equal(link.credit, 12288);
  port.feed(TYPE.HELLO, HELLO);
  assert.equal(link.ready, true);
  assert.equal(link.credit, 0);
});

test('reports the link down after 3 s without a PONG, then says HELLO again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  t.mock.timers.tick(3000);
  assert.deepEqual(downs, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(downs, ['no PONG for 3 s']);
  assert.equal(link.ready, false);
  assert.equal(port.sent().at(-1).type, TYPE.HELLO);
});

test('a PONG reports the round trip and the S3 counters', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  t.mock.timers.tick(1000);
  const ping = port.sent().at(-1);
  assert.equal(ping.type, TYPE.PING);
  let pong = null;
  link.on('pong', (p) => { pong = p; });
  t.mock.timers.tick(20);
  port.feed(TYPE.PONG, Buffer.concat([ping.payload, u32(5000), u32(1), u32(2)]));
  assert.deepEqual(pong, { token: ping.payload.readUInt32LE(0), uptimeMs: 5000, badChunks: 1, seqGaps: 2, rttMs: 20 });
});

test('audio goes out only against credit, EOS on the last frame, and resolves on PLAYED', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(2500, 1));
  await settle();
  assert.deepEqual(audio(port), []);
  port.feed(TYPE.CREDIT, u32(1920));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0]]);
  port.feed(TYPE.CREDIT, u32(4000));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [580, FLAG.EOS]]);
  assert.equal(link.credit, 4000 - 580);
  port.feed(TYPE.PLAYED, played(2500, 0));
  const p = await done;
  assert.equal(p.bytes, 2500);
  assert.equal(p.reason, 0);
});

test('when the S3 stops a reply, sending stops and an empty EOS closes the stream', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(9600));
  port.feed(TYPE.CREDIT, u32(1920));
  await settle();
  port.feed(TYPE.PLAYED, played(1920, 1));
  assert.equal((await done).reason, 1);
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [0, FLAG.EOS]]);
});

test('stopping a reply sends STOP_AUDIO, then an empty EOS, and waits for PLAYED', async (t) => {
  const { port, link } = await readyLink(t);
  const ac = new AbortController();
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  port.feed(TYPE.CREDIT, u32(960));
  await settle();
  ac.abort();
  await settle();
  const tail = port.sent().slice(-2).map((f) => [f.type, f.payload.toString('hex'), f.flags]);
  assert.deepEqual(tail, [[TYPE.CMD, '03', 0], [TYPE.AUDIO_DOWN, '', FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(960, 1));
  assert.equal((await done).reason, 1);
});

test('stopping before any audio went out resolves at once and tells the S3 nothing', async (t) => {
  const { port, link } = await readyLink(t);
  const ac = new AbortController();
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.PING]); // the S3 was told nothing about audio
});

test('the S3 restarting during a reply fails it, clears credit and shakes hands again', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(9600));
  port.feed(TYPE.CREDIT, u32(5000));
  await settle();
  const downs = [];
  link.on('down', (r) => downs.push(r));
  port.feed(TYPE.HELLO, helloWithNonce(0));
  await assert.rejects(done, /restarted/);
  assert.equal(link.credit, 0);
  assert.equal(link.ready, false);
  assert.deepEqual(downs, ['the S3 restarted']);
  assert.equal(port.sent().at(-1).type, TYPE.HELLO);
});

test('AUDIO_UP frames are passed on with their flags', async (t) => {
  const { port, link } = await readyLink(t);
  const got = [];
  link.on('audio-up', (f) => got.push([f.payload.length, f.flags]));
  port.feed(TYPE.AUDIO_UP, Buffer.alloc(640));
  port.feed(TYPE.AUDIO_UP, Buffer.alloc(0), FLAG.EOS);
  assert.deepEqual(got, [[640, 0], [0, FLAG.EOS]]);
});

test('counts gaps in the S3 sequence numbers', async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.LOG, Buffer.from('a'));
  port.emit('data', Buffer.from(encodeFrame({ type: TYPE.LOG, seq: 40, payload: Buffer.from('b') })));
  assert.equal(link.seqGaps, 1);
});

test('reopens the port after it closes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const ports = [];
  const link = new Link({ openPort: async () => ports[ports.push(new FakePort()) - 1], retryMs: 500, makeNonce: () => NONCE });
  t.after(() => link.close());
  await link.start();
  ports[0].feed(TYPE.HELLO, HELLO);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  ports[0].emit('close');
  assert.deepEqual(downs, ['port closed']);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(ports.length, 2);
  assert.equal(ports[1].sent()[0].type, TYPE.HELLO);
});

// Advances mock time a second at a time, answering every PING with a PONG so 'no PONG' stays quiet.
function tickAnswering(t, port, ms, each = () => {}) {
  for (let i = 0; i < ms; i += 1000) {
    t.mock.timers.tick(1000);
    const last = port.sent().at(-1);
    if (last?.type === TYPE.PING) port.feed(TYPE.PONG, Buffer.concat([last.payload, u32(0), u32(0), u32(0)]));
    each();
  }
}

test('a reply that gets no credit for 5 s drops the link and shakes hands again', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  const done = link.playAudio(Buffer.alloc(9600));
  await settle(); // the first frame is ready one microtask later, and the stall timer starts with it
  tickAnswering(t, port, 5000);
  await assert.rejects(done, /credit stalled/);
  assert.equal(downs.length, 1);
  assert.match(downs[0], /credit stalled/);
  assert.equal(link.ready, false);
  assert.equal(port.sent().at(-1).type, TYPE.HELLO);
});

test('credit that keeps arriving never counts as a stall', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  const done = link.playAudio(Buffer.alloc(9600));
  for (let i = 0; i < 10; i++) {
    tickAnswering(t, port, 1000, () => port.feed(TYPE.CREDIT, u32(960)));
    await settle();
  }
  assert.equal(audio(port).length, 10);
  port.feed(TYPE.PLAYED, played(9600, 0));
  assert.equal((await done).bytes, 9600);
  assert.deepEqual(downs, []);
});

test('an S3 without a playback ring refuses replies', { timeout: 2000 }, async (t) => {
  const port = new FakePort();
  const link = new Link({ openPort: async () => port, makeNonce: () => NONCE });
  t.after(() => link.close());
  await link.start();
  const hello = Buffer.from(HELLO);
  hello.writeUInt32LE(0, 6); // ring_bytes
  port.feed(TYPE.HELLO, hello);
  assert.equal(link.ready, true);
  await assert.rejects(link.playAudio(Buffer.alloc(960)), /no playback ring/);
});

test('PCM16 with an odd number of bytes is refused', { timeout: 2000 }, async (t) => {
  const { link } = await readyLink(t);
  await assert.rejects(link.playAudio(Buffer.alloc(101)), RangeError);
});

test('a fresh answer counts as a PONG, so the link is not dropped early', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 10_000 });
  const { port, link } = await readyLink(t);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  t.mock.timers.tick(3000);
  assert.equal(port.sent().at(-1).type, TYPE.PING);
  assert.deepEqual(downs, []);
});

test('two replies back to back each resolve with their own PLAYED', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const first = link.playAudio(Buffer.alloc(960));
  port.feed(TYPE.CREDIT, u32(960));
  await settle();
  port.feed(TYPE.PLAYED, played(960, 0));
  assert.equal((await first).bytes, 960);
  const second = link.playAudio(Buffer.alloc(1920));
  port.feed(TYPE.CREDIT, u32(1920));
  await settle();
  port.feed(TYPE.PLAYED, played(1920, 0));
  assert.equal((await second).bytes, 1920);
});

test('a new answer to the HELLO zeroes the gap count', async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.LOG, Buffer.from('a'));
  port.emit('data', Buffer.from(encodeFrame({ type: TYPE.LOG, seq: 40, payload: Buffer.from('b') })));
  assert.equal(link.seqGaps, 1);
  port.feed(TYPE.HELLO, HELLO);
  assert.equal(link.seqGaps, 0);
});

test('closing the link fails a reply that is waiting for credit', { timeout: 2000 }, async (t) => {
  const { link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(9600));
  await settle();
  link.close();
  await assert.rejects(done, /port closed/);
});

// A source the test feeds by hand: push() hands a chunk to the reader, end() finishes it, fail() breaks it, and
// state.returned says whether the reader let go of it (as a generator's finally would see).
function manualSource() {
  const queue = [];
  const state = { returned: false };
  let finished = false;
  let failure = null;
  let wake = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const iterator = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      for (;;) {
        if (queue.length > 0) return { value: queue.shift(), done: false };
        if (failure) throw failure;
        if (finished) return { value: undefined, done: true };
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
    async return() {
      state.returned = true;
      finished = true;
      poke();
      return { value: undefined, done: true };
    },
  };
  return {
    iterator,
    state,
    push(buf) {
      queue.push(buf);
      poke();
    },
    end() {
      finished = true;
      poke();
    },
    fail(err) {
      failure = err;
      poke();
    },
  };
}
const frames = (port) => port.sent().filter((f) => f.type === TYPE.AUDIO_DOWN);

test('a streamed reply starts before its source has finished, and the last frame carries EOS', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(500, 1));
  await settle();
  assert.deepEqual(audio(port), [], '500 bytes are not a frame yet');
  src.push(Buffer.alloc(1500, 2));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0]], 'two frames leave while 80 bytes wait');
  src.push(Buffer.alloc(1000, 3));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [960, 0]]);
  src.end();
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [960, 0], [120, FLAG.EOS]]);
  const sent = Buffer.concat(frames(port).map((f) => f.payload));
  assert.ok(sent.equals(Buffer.concat([Buffer.alloc(500, 1), Buffer.alloc(1500, 2), Buffer.alloc(1000, 3)])));
  port.feed(TYPE.PLAYED, played(3000, 0));
  assert.equal((await done).bytes, 3000);
});

test('a frame that might be the last waits until more audio or the end of the source is known', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(960, 1));
  await settle();
  assert.deepEqual(audio(port), []);
  src.end();
  await settle();
  assert.deepEqual(audio(port), [[960, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(960, 0));
  await done;
});

test('an empty stream ends with one empty EOS frame', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playStream([]);
  await settle();
  assert.deepEqual(audio(port), [[0, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(0, 0));
  assert.equal((await done).bytes, 0);
});

test('an ordinary iterable of buffers works like an async one', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const done = link.playStream([Buffer.alloc(960), Buffer.alloc(960)]);
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(1920, 0));
  await done;
});

test('chunks that split samples still reach the S3 byte for byte, in even frames', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const input = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));
  async function* source() {
    let at = 0;
    for (const size of [1, 3, 7, 1000, 1001, 1, 999, 2, 500]) {
      yield input.subarray(at, at + size);
      at += size;
    }
    yield input.subarray(at);
  }
  const done = link.playStream(source());
  await settle();
  const sent = frames(port);
  assert.ok(sent.every((f) => f.payload.length % 2 === 0));
  assert.ok(Buffer.concat(sent.map((f) => f.payload)).equals(input));
  assert.equal(sent.at(-1).flags, FLAG.EOS);
  port.feed(TYPE.PLAYED, played(4000, 0));
  await done;
});

test('a dangling odd byte at the very end of the stream is dropped', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const done = link.playStream([Buffer.alloc(500), Buffer.alloc(501)]);
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [40, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(1000, 0));
  await done;
});

test('stopping a reply whose source is still silent resolves at once and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const ac = new AbortController();
  const done = link.playStream(src.iterator, { signal: ac.signal });
  await settle();
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  await settle();
  assert.equal(src.state.returned, true);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.PING]); // the S3 was told nothing about audio
});

test('stopping a reply that is playing sends STOP_AUDIO and an EOS, and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const ac = new AbortController();
  const done = link.playStream(src.iterator, { signal: ac.signal });
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  ac.abort();
  await settle();
  const tail = port.sent().slice(-2).map((f) => [f.type, f.flags]);
  assert.deepEqual(tail, [[TYPE.CMD, 0], [TYPE.AUDIO_DOWN, FLAG.EOS]]);
  assert.equal(src.state.returned, true);
  port.feed(TYPE.PLAYED, played(1920, 1));
  assert.equal((await done).reason, 1);
});

test('when the S3 stops a streamed reply, the source is let go of', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  port.feed(TYPE.PLAYED, played(1920, 1)); // the front key stopped it
  assert.equal((await done).reason, 1);
  assert.equal(src.state.returned, true);
});

test('a source that fails after some audio is played to its end, then its failure is thrown', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  src.fail(new Error('the speech connection broke'));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [80, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(2000, 0));
  await assert.rejects(done, /the speech connection broke/);
});

test('a source that fails before any audio is thrown after the empty EOS', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  src.fail(new Error('no audio'));
  await settle();
  assert.deepEqual(audio(port), [[0, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(0, 0));
  await assert.rejects(done, /no audio/);
});

test('the S3 restarting during a streamed reply fails it and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  port.feed(TYPE.HELLO, helloWithNonce(0));
  await assert.rejects(done, /restarted/);
  await settle();
  assert.equal(src.state.returned, true);
});

test('playStream wants chunks, not one buffer, and only one reply plays at a time', { timeout: 2000 }, async (t) => {
  const { link } = await readyLink(t);
  await assert.rejects(link.playStream(Buffer.alloc(960)), TypeError);
  const src = manualSource();
  const first = link.playStream(src.iterator);
  await assert.rejects(link.playStream([Buffer.alloc(960)]), /another reply is still playing/);
  await assert.rejects(link.playAudio(Buffer.alloc(960)), /another reply is still playing/);
  src.end();
  link.close();
  await assert.rejects(first, /port closed/);
});

test('something that is not iterable is a TypeError that leaves the link free for the next reply', { timeout: 2000 }, async (t) => {
  const { link } = await readyLink(t);
  await assert.rejects(link.playStream({ provider: 'openai', audio: [] }), TypeError); // say()'s whole result, passed by mistake
  await assert.rejects(link.playStream(null), TypeError);
  const src = manualSource();
  const first = link.playStream(src.iterator); // rejects at once with "still playing" if a failed call left the link busy
  await settle();
  src.end();
  link.close();
  await assert.rejects(first, /port closed/);
});
