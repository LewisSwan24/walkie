import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeWav, encodeWav } from '../../src/audio/wav.js';
import injectCommand, { injectTake, runInjected } from '../../src/dev/inject.js';
import { FLAG, TYPE } from '../../src/link/frame.js';
import { KEY, TEST_OP, parseTestKeys } from '../../src/link/messages.js';
import { until } from '../helpers/fake-s3.js';
import { fakeLink } from '../helpers/fake-link.js';
import { providers, speechPcm, world } from '../helpers/world.js';
import { tone } from '../../src/audio/tone.js';

const pcmOf = (ms, byte = 5) => Buffer.alloc((ms * 16000 * 2) / 1000, byte);

// What the S3 was sent, as one word per frame, with the pauses in between.
function recorded() {
  const link = fakeLink();
  const order = [];
  const send = link.send;
  link.send = (type, payload, flags) => {
    const op = payload[0];
    order.push(type !== TYPE.TEST ? `type ${type}` : op === TEST_OP.MIC_SOURCE ? `source ${payload[1] ? 'on' : 'off'}` : op === TEST_OP.MIC_PCM ? 'pcm' : op === TEST_OP.KEYS ? 'keys' : `op ${op}`);
    return send(type, payload, flags);
  };
  const sleep = async (ms) => void order.push(`sleep ${ms}`);
  return { link, order, sleep };
}
// The chunks as injectTake paces them: a pause of 5 ms after every fourth.
const paced = (chunks) => Array.from({ length: chunks }, (_, i) => (i % 4 === 3 ? ['pcm', 'sleep 5'] : ['pcm'])).flat();
const pcmSent = (link) => Buffer.concat(link.sent.filter((s) => s.payload[0] === TEST_OP.MIC_PCM).map((s) => s.payload.subarray(1)));

// ---- injectTake ---------------------------------------------------------------------------------------------------------

test('a recording goes in as the microphone: source on, all of it into the FIFO, the front key held for as long as it lasts, source off', async () => {
  const { link, order, sleep } = recorded();
  const { holdMs, chunks } = await injectTake(link, pcmOf(1000), { sleep });
  assert.equal(holdMs, 500 + 1000 + 300);
  assert.equal(chunks, Math.ceil((pcmOf(1800).length) / 640));
  const pcmWords = order.filter((o) => o === 'pcm').length;
  assert.equal(pcmWords, chunks);
  assert.deepEqual(order, ['source off', 'sleep 150', 'source on', ...paced(chunks), 'keys', `sleep ${1800 + 800}`, 'source off']);
});

// Measured on the real S3 (gate I): 283 chunks handed to the link at once lost 50 frames on the way (the S3 counted 83 more
// damaged chunks and 50 sequence gaps), and the first run lost the key script, so no take was ever made. Four chunks and a
// pause of 5 ms in all of them lost none.
test('the recording is paced into the S3, never more than four chunks without a pause, and the key script comes after the last of them', async () => {
  const { link, order, sleep } = recorded();
  await injectTake(link, pcmOf(3000), { sleep });
  let run = 0;
  let longest = 0;
  for (const word of order) {
    run = word === 'pcm' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  assert.ok(longest > 0 && longest <= 4, `${longest} chunks in a row`);
  assert.ok(order.filter((word) => word === 'sleep 5').length >= 40, 'a pause every fourth chunk');
  assert.ok(order.indexOf('keys') > order.lastIndexOf('pcm'), 'the key script is the last thing into the S3');
});

test('the FIFO gets silence for the lead-in, then the recording unchanged, then silence for the tail, in even chunks that fit a frame', async () => {
  const { link, sleep } = recorded();
  const pcm = pcmOf(700, 9);
  await injectTake(link, pcm, { sleep, leadInMs: 200, tailMs: 100 });
  const sent = pcmSent(link);
  assert.deepEqual(sent, Buffer.concat([Buffer.alloc(6400), pcm, Buffer.alloc(3200)]));
  for (const s of link.sent.filter((f) => f.payload[0] === TEST_OP.MIC_PCM)) {
    const n = s.payload.length - 1;
    assert.ok(n >= 2 && n <= 640 && n % 2 === 0, `a chunk of ${n} bytes`);
  }
});

test('the key goes down at once and up when the lead-in, the recording and the tail are over', async () => {
  const { link, sleep } = recorded();
  await injectTake(link, pcmOf(2000), { sleep, leadInMs: 400, tailMs: 250 });
  const keys = link.sent.find((s) => s.payload[0] === TEST_OP.KEYS);
  assert.deepEqual(parseTestKeys(keys.payload).steps, [
    { delayMs: 0, mask: KEY.FRONT },
    { delayMs: 2650, mask: 0 },
  ]);
});

test('what does not fit the S3 is refused before anything is sent: nothing, an odd length, or more than its 16 s FIFO holds', async () => {
  for (const [pcm, pattern] of [
    [Buffer.alloc(0), /PCM16/],
    [Buffer.alloc(3), /PCM16/],
    [pcmOf(15_300), /16 s/],
  ]) {
    const { link, sleep } = recorded();
    await assert.rejects(injectTake(link, pcm, { sleep }), pattern);
    assert.deepEqual(link.sent, []);
  }
  const { link, sleep } = recorded();
  await injectTake(link, pcmOf(15_100), { sleep }); // 15.1 s and the lead-in and tail: 15.9 s
  assert.ok(link.sent.length > 0);
  for (const options of [{ leadInMs: -1 }, { leadInMs: 1.5 }, { tailMs: -1 }]) {
    const fresh = recorded();
    await assert.rejects(injectTake(fresh.link, pcmOf(500), { sleep: fresh.sleep, ...options }), /lead-in|tail/);
    assert.deepEqual(fresh.link.sent, []);
  }
});

test('the microphone is given back even when the script cannot be sent', async () => {
  const { link, order, sleep } = recorded();
  const send = link.send;
  link.send = (type, payload, flags) => {
    if (payload[0] === TEST_OP.KEYS) throw new Error('link is down');
    return send(type, payload, flags);
  };
  await assert.rejects(injectTake(link, pcmOf(500), { sleep }), /link is down/);
  assert.equal(order.at(-1), 'source off');
});

test('through the real link to a device that behaves like the firmware, the bridge gets the recording back as a take', async (t) => {
  const w = await world(t);
  const pcm = pcmOf(100, 7);
  const taken = [];
  w.bridge.link.on('audio-up', (f) => taken.push(f.payload));
  const done = await injectTake(w.bridge.link, pcm, { leadInMs: 40, tailMs: 20 });
  assert.equal(done.holdMs, 160);
  await until(() => w.s3.injected.length === 1, 'the take');
  assert.deepEqual(w.s3.injected[0], Buffer.concat([Buffer.alloc(1280), pcm, Buffer.alloc(640)]));
  await until(() => !w.s3.micSource, 'the microphone to be the real one again');
  await until(() => Buffer.concat(taken).length === w.s3.injected[0].length, 'the take to reach the bridge');
});

// ---- runInjected: what became of the utterance --------------------------------------------------------------------------

const feed = (w) => async () => w.s3.take(speechPcm);

test('a request that Claude answers: the words, the reply, and the voice spoken to the end', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w) });
  assert.equal(run.outcome, 'reply');
  assert.equal(run.heard.transcript, '你好');
  assert.match(run.reply.text, /I heard: 你好/);
  assert.equal(w.s3.audioDown().ended, true, 'it waited for the speech');
  assert.equal(w.spoken.length, 1);
});

test('a take nobody could hear ends the run at once as unclear', async (t) => {
  const w = await world(t, { adapters: [] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 10_000 });
  assert.equal(run.outcome, 'unclear');
  assert.equal(run.heard.status, 'unclear');
  assert.equal(run.reply, null);
});

test('words that were a command for walkie itself are handled without Claude, and what it said is spoken', async (t) => {
  const w = await world(t, { said: ['现在什么状态'], intent: 'status' });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 10_000 });
  assert.equal(run.outcome, 'handled');
  assert.equal(run.heard.intent, 'status');
  assert.equal(w.spoken.length, 1);
  assert.equal(w.s3.audioDown().ended, true);
});

test('Claude that cannot be started is a failure, with what it was', async (t) => {
  const w = await world(t, { said: ['你好'], command: ['walkie-no-such-program-xyz'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 20_000 });
  assert.equal(run.outcome, 'failure');
  assert.ok(run.failure.kind);
  assert.equal(run.reply, null);
});

test('a reply that does not come in time ends the run as a timeout, with what was heard', async (t) => {
  const w = await world(t, { said: ['!sleep 20000'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 1500 });
  assert.equal(run.outcome, 'timeout');
  assert.equal(run.heard.transcript, '!sleep 20000');
});

test('a take that never reaches the bridge is a timeout too, with nothing heard', async (t) => {
  const w = await world(t);
  const run = await runInjected(w.bridge, speechPcm, { inject: async () => {}, timeoutMs: 300 });
  assert.equal(run.outcome, 'timeout');
  assert.equal(run.heard, null);
});

test('the recording and the options are handed to the injection as they were given', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const seen = [];
  await runInjected(w.bridge, speechPcm, {
    leadInMs: 123,
    inject: async (link, pcm, options) => {
      seen.push([link === w.bridge.link, pcm === speechPcm, options.leadInMs]);
      w.s3.take(speechPcm);
    },
  });
  assert.deepEqual(seen, [[true, true, 123]]);
});

test('a run that is over does not leave its deadline ticking, which would keep the process alive for minutes', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const long = [];
  const cleared = [];
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    const id = set(fn, ms, ...rest);
    if (ms > 90_000 && ms <= 100_000) long.push(id); // the deadline: 100 s less what has gone by
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    cleared.push(id);
    clear(id);
  });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 100_000 });
  assert.equal(run.outcome, 'reply');
  assert.equal(long.length, 1);
  assert.ok(cleared.includes(long[0]));
});

// ---- walkie-dev inject ----------------------------------------------------------------------------------------------------

// A link to a device that gives the recording back as the take, as the firmware does; 'tamper' changes what comes back.
function linkWithMic({ tamper = (pcm) => pcm } = {}) {
  const link = fakeLink();
  let fifo = Buffer.alloc(0);
  link.onSend = (type, payload) => {
    if (payload[0] === TEST_OP.MIC_PCM) fifo = Buffer.concat([fifo, payload.subarray(1)]);
    if (payload[0] === TEST_OP.KEYS) {
      const pcm = tamper(fifo);
      for (let at = 0; at < pcm.length; at += 640) {
        const last = at + 640 >= pcm.length;
        link.emit('audio-up', { type: TYPE.AUDIO_UP, flags: last ? FLAG.EOS : 0, seq: 0, payload: pcm.subarray(at, at + 640) });
      }
    }
  };
  return link;
}

function recordingFile(t, ms = 1000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pcm = Buffer.alloc((ms * 16000 * 2) / 1000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i === 100 ? 12_000 : (i % 7) * 100, i * 2);
  const file = path.join(dir, 'said.wav');
  writeFileSync(file, encodeWav(pcm, 16000));
  return { dir, file, pcm };
}

test('inject says what it sent and what came back, and that the recording is in the take', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const { file } = recordingFile(t);
  const link = linkWithMic();
  await injectCommand([file], {}, async () => link, { sleep: async () => {} });
  const text = lines.join('\n');
  assert.match(text, /said\.wav: 1\.00 s, peak 12000/);
  assert.match(text, /take: 1\.80 s \(the key was held 1\.80 s\), peak 12000, the recording is in it/);
  assert.equal(link.closed, true);
});

test('a take that does not hold the recording is said so, and the exit code is 1', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const exit = process.exitCode;
  t.after(() => (process.exitCode = exit));
  const { file } = recordingFile(t);
  await injectCommand([file], {}, async () => linkWithMic({ tamper: (pcm) => Buffer.alloc(pcm.length) }), { sleep: async () => {} });
  assert.match(lines.join('\n'), /NOT the recording's peak 12000/);
  assert.equal(process.exitCode, 1);
});

test('--out keeps the take that came back as a WAV', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { dir, file } = recordingFile(t);
  const out = path.join(dir, 'takes', 'here');
  await injectCommand([file], { out }, async () => linkWithMic(), { sleep: async () => {} });
  const [name] = readdirSync(out);
  assert.match(name, /^inject-.*\.wav$/);
  const { rate, pcm } = decodeWav(readFileSync(path.join(out, name)));
  assert.equal(rate, 16000);
  assert.equal(pcm.length, 1800 * 32);
});

test('no take coming back is an error that says where to look, and the link is closed', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { file } = recordingFile(t);
  const link = fakeLink(); // a device that does nothing
  await assert.rejects(injectCommand([file], {}, async () => link, { sleep: async () => {}, takeWaitMs: 30 }), /no take came back within 0\.03 s/);
  assert.equal(link.closed, true);
});

test('a file that is not 16 kHz, or no file, stops inject before it connects', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slow = path.join(dir, 'slow.wav');
  writeFileSync(slow, encodeWav(Buffer.alloc(3200), 8000));
  let connected = false;
  const connect = async () => (connected = true);
  await assert.rejects(injectCommand([slow], {}, connect), /8000 Hz, the S3 records 16000 Hz/);
  await assert.rejects(injectCommand([], {}, connect), /inject <wav>/);
  assert.equal(connected, false);
});

test('with no S3 answering, nothing is injected and the run says so', async () => {
  const stub = { link: { ready: false }, turn: { on: () => () => {}, settled: async () => {} }, manager: { on: () => () => {} } };
  let injected = false;
  const run = await runInjected(stub, speechPcm, { readyMs: 100, inject: async () => (injected = true) });
  assert.equal(run.outcome, 'no-device');
  assert.equal(injected, false);
});

test('the S3 that answers late is waited for', async () => {
  const stub = { link: { ready: false }, turn: { on: () => () => {}, settled: async () => {} }, manager: { on: () => () => {} } };
  setTimeout(() => (stub.link.ready = true), 100);
  const run = await runInjected(stub, speechPcm, { readyMs: 5000, timeoutMs: 100, inject: async () => {} });
  assert.equal(run.outcome, 'timeout', 'it got as far as injecting and waiting for the words');
});

// ---- more of the edges --------------------------------------------------------------------------------------------------

test('a recording that is not a whole number of milliseconds is held for the part of a millisecond too, not cut short', async () => {
  const { link, sleep } = recorded();
  const { holdMs } = await injectTake(link, Buffer.alloc(100, 3), { sleep, leadInMs: 500, tailMs: 300 }); // 100 bytes are 3.125 ms
  assert.equal(holdMs, 804);
});

test('the FIFO holds 16 s, with the lead-in and the tail in it: exactly 16 s goes in and a millisecond more does not', async () => {
  const fits = recorded();
  assert.equal((await injectTake(fits.link, pcmOf(15_200), { sleep: fits.sleep })).holdMs, 16_000);
  const over = recorded();
  await assert.rejects(injectTake(over.link, pcmOf(15_201), { sleep: over.sleep }), /16 s/);
});

test('words that continue or compact are work for Claude too, and the run waits for its answer', async (t) => {
  for (const intent of ['continue', 'compact']) {
    const w = await world(t, { said: ['好'], intent });
    const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 20_000 });
    assert.ok(run.outcome === 'reply', `${intent}: ${run.outcome}`);
    assert.ok(run.reply, intent);
  }
});

test('the time allowed is counted from the end of the injection, which can itself take a while', async (t) => {
  const w = await world(t, { said: ['现在什么状态'], intent: 'status' });
  const run = await runInjected(w.bridge, speechPcm, {
    timeoutMs: 1500,
    inject: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      w.s3.take(speechPcm);
    },
  });
  assert.equal(run.outcome, 'handled');
});

test('a voice that is still being spoken at the deadline is a timeout, not a reply', async (t) => {
  const [provider] = providers(['你好'], []);
  const slow = {
    ...provider,
    speak: async function* () {
      for (let i = 0; i < 100; i++) {
        yield tone(330, 0.1, 4000);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  const w = await world(t, { adapters: [slow] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 1500 });
  assert.equal(run.outcome, 'timeout');
  assert.ok(run.reply, 'Claude had answered');
});

test('what a run listened for it stops listening for, however it ended', async () => {
  const offs = [];
  const on = () => () => offs.push('off');
  const make = (ready) => ({ link: { ready }, turn: { on, settled: async () => {} }, manager: { on } });
  await runInjected(make(false), speechPcm, { readyMs: 50, inject: async () => {} });
  assert.equal(offs.length, 3, 'no device');
  await runInjected(make(true), speechPcm, { timeoutMs: 50, inject: async () => {} });
  assert.equal(offs.length, 6, 'nothing heard');
  await assert.rejects(runInjected(make(true), speechPcm, { inject: async () => Promise.reject(new Error('link is down')) }), /link is down/);
  assert.equal(offs.length, 9, 'the injection failed');
});

test('inject waits for the take only as long as it was told to', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { file } = recordingFile(t);
  const started = Date.now();
  await assert.rejects(injectCommand([file], {}, async () => fakeLink(), { sleep: async () => {}, takeWaitMs: 30 }), /no take came back/);
  assert.ok(Date.now() - started < 2000, 'not the five seconds of the default');
});
