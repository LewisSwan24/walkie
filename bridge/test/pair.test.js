// `walkie pair` (protocol/frames.md, "Pairing"): put a new key on the walkie over the cable, with a key press on the walkie as the
// yes, and keep it on this PC only once the walkie has said so. The stand-in S3 plays the person at the walkie (test/helpers/fake-s3.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPairCandidate, loadPairKey, writePairCandidate, commitPairKey } from '../src/config/pairkey.js';
import { RESEND_MS, runPair } from '../src/pair.js';
import { TYPE } from '../src/link/frame.js';
import { FakeS3, until } from './helpers/fake-s3.js';

const OLD = Buffer.alloc(32, 0x33);
// Generous where something is expected to happen, because a busy machine runs these beside the rest of the suite; a test that expects a
// time to run out says so in its own options.
const FAST = { helloMs: 3000, answerMs: 3000, resendMs: 40, verifyMs: 3000, retryMs: 20 };

function setup(t, deviceOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pair.key');
  const device = new FakeS3({ proto: 2, adpcm: true, ...deviceOptions });
  const said = [];
  const run = (options = {}) =>
    runPair({ openPort: async () => device, file, say: (line) => said.push(line), makeNonce: () => 0x1234abcd, ...FAST, ...options });
  return { dir, file, device, said, run };
}
const files = (dir) => readdirSync(dir).sort();

// The walkie gives up on its confirm screen 30 s after it opened it, a few ms after the first SET. A repeat that lands within a second
// of that comes after the walkie's DENIED and opens the screen again, for a key no PC is waiting to keep.
test('the default repeat never falls within a second of the 30 s the walkie waits for a key press', () => {
  assert.ok(Number.isInteger(RESEND_MS) && RESEND_MS > 0 && RESEND_MS <= 5000, `RESEND_MS is ${RESEND_MS}`);
  for (let t = RESEND_MS; t <= 40_000; t += RESEND_MS) assert.ok(t < 29_000 || t > 31_000, `a repeat at ${t} ms`);
});

test('the person presses yes: the walkie holds the key, this PC keeps it, and a sealed link proves it', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'yes' });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  const kept = loadPairKey({ file });
  assert.equal(kept.compare(device.heldKey), 0, 'the same key on both sides');
  assert.deepEqual(files(dir), ['pair.key'], 'no candidate left behind');
  assert.ok(device.raw.some((f) => f.type !== TYPE.HELLO && f.type !== TYPE.PAIR && f.flags & 0x80), 'the check ran over a sealed link');
  assert.ok(said.some((l) => /front key/.test(l)), 'it tells the person what to press');
  assert.ok(said.some((l) => /verified|sealed/.test(l)), JSON.stringify(said));
  assert.ok(!said.join('\n').includes(kept.toString('hex')), 'and never says the key');
});

test('the person presses no: nothing is kept and a key that worked is not touched', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'no' });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run();
  assert.equal(result.outcome, 'denied');
  assert.equal(loadPairKey({ file }).compare(OLD), 0);
  assert.deepEqual(files(dir), ['pair.key'], 'the candidate was thrown away');
  assert.equal(device.heldKey, null);
  assert.ok(said.some((l) => /refused|side key|30 s/.test(l)), JSON.stringify(said));
});

test('a walkie that is paired already can be paired again: the key press is what counts', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'yes', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  const kept = loadPairKey({ file });
  assert.notEqual(kept.compare(OLD), 0, 'a new key');
  assert.equal(kept.compare(device.heldKey), 0);
});

test('the request is repeated until it is answered, and the answer can come late', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'ask' });
  const done = run();
  await until(() => device.pairRequests.length >= 3, 'the request three times');
  assert.ok(device.pairRequests.every((r) => r.key.compare(device.pairRequests[0].key) === 0), 'always the same key');
  device.confirmPair(true);
  assert.equal((await done).outcome, 'paired');
  assert.equal(loadPairKey({ file }).compare(device.heldKey), 0);
});

test('an answer to another request is not an answer', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'ask' });
  const done = run();
  await until(() => device.pairRequests.length >= 1, 'the request');
  device.feed(TYPE.PAIR, Buffer.from([3, 2]), 0, { plain: true }); // OK to a FORGET
  device.feed(TYPE.PAIR, Buffer.from([4, 2]), 0, { plain: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(loadPairKey({ file }), null, 'nothing was kept for an answer that was not to this');
  device.confirmPair(false);
  assert.equal((await done).outcome, 'denied');
});

test('no answer: the candidate stays, and the next run offers the same key, which the walkie takes without asking', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'lose-reply' });
  const first = await run({ resendMs: 10_000, answerMs: 300 }); // no repeat inside the time allowed: the one answer was lost
  assert.equal(first.outcome, 'no-answer');
  assert.deepEqual(files(dir), ['pair.key.new'], 'the key the walkie may hold is still on this PC');
  assert.ok(device.heldKey, 'the walkie did take it: only the answer was lost');
  assert.ok(said.some((l) => /run .*pair.* again|no answer/i.test(l)), JSON.stringify(said));
  const offered = loadPairCandidate({ file });
  const second = await run();
  assert.equal(second.outcome, 'paired');
  assert.equal(device.pairRequests.at(-1).key.compare(offered), 0, 'the same key again');
  assert.equal(loadPairKey({ file }).compare(offered), 0);
});

test('a walkie that took the key but cannot be reached with it is reported, not called paired', async (t) => {
  const { file, run } = setup(t, { pairing: 'wrong-key' });
  const result = await run({ verifyMs: 400 });
  assert.equal(result.outcome, 'unverified');
  assert.ok(loadPairKey({ file }), 'the key was accepted, so it is kept: the next `walkie pair` can put it right');
});

test('forgetting: the walkie says OK, and then this PC lets go of the key', async (t) => {
  const { dir, file, device, run } = setup(t, { pairing: 'yes', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'forgotten');
  assert.equal(device.heldKey, null);
  assert.deepEqual(files(dir), []);
  assert.equal(device.pairRequests.at(-1).op, 2);
});

test('forgetting is refused at the walkie: the key stays on both sides', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'no', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'denied');
  assert.equal(device.heldKey.compare(OLD), 0);
  assert.equal(loadPairKey({ file }).compare(OLD), 0);
});

test('forgetting at a walkie that holds no key: it says OK at once, and this PC still lets go of its key', async (t) => {
  const { dir, file, run } = setup(t, { pairing: null });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'forgotten');
  assert.deepEqual(files(dir), []);
});

test('no walkie on the cable: it says so and leaves nothing on disk', async (t) => {
  const { dir, file, said } = setup(t);
  await assert.rejects(
    runPair({ openPort: async () => { throw new Error('no S3 on USB (303A:1001)'); }, file, say: (l) => said.push(l), ...FAST, helloMs: 300 }),
    /no walkie answered/,
  );
  assert.equal(existsSync(file), false);
  assert.deepEqual(existsSync(dir) ? files(dir) : [], []);
});

test('a repeated request rescues a lost OK: the walkie holds the key already and says OK at once', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'lose-reply' });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  assert.ok(device.pairRequests.length >= 2);
  assert.equal(loadPairKey({ file }).compare(device.heldKey), 0);
});

test('a walkie that never answers: no-answer, nothing is held, and the candidate waits for the next run', async (t) => {
  const { dir, device, run } = setup(t, { pairing: null });
  const result = await run({ answerMs: 300 });
  assert.equal(result.outcome, 'no-answer');
  assert.equal(device.heldKey, null);
  assert.deepEqual(files(dir), ['pair.key.new']);
});
