// Gate L against a relay on this machine: every scene holds through the relay's keep-alive pings, and each scene fails, and stops the
// gate, when what it checks is not so: no relay, the wrong key, a silent S3, a link that drops, a loss noticed too late, an S3 that does
// not come back, a relay that goes away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/src/server.js';
import { FakeS3 } from '../../bridge/test/helpers/fake-s3.js';
import { runGateL } from '../lib/gate-l.mjs';

const FAST = { pingEveryMs: 100, pongTimeoutMs: 400 };
const SLOW_LOSS = { pingEveryMs: 100, pongTimeoutMs: 10_000 };

// Runs the gate against a fresh local relay; `onLine(line, ctx)` sees each line as it is said, with the relay and the stand-in S3.
async function gate(t, { holdMs = 1000, waitMs = 3000, clock = FAST, s3Options = {}, onLine = () => {} } = {}) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  t.after(() => relay.close());
  const lines = [];
  const ctx = { relay, s3: null };
  const ok = await runGateL({
    host: `ws://127.0.0.1:${relay.port}`,
    holdMs,
    waitMs,
    clock,
    say: (l) => {
      lines.push(l);
      onLine(l, ctx);
    },
    standIn: (master) => (ctx.s3 = new FakeS3({ proto: 2, master, ...s3Options })),
  });
  return { ok, lines, last: lines.at(-1) };
}

test('gate L passes every scene against a working relay, through its keep-alive pings', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  t.after(() => relay.close());
  const lines = [];
  const ok = await runGateL({ host: `ws://127.0.0.1:${relay.port}`, holdMs: 1000, waitMs: 5000, clock: FAST, say: (l) => lines.push(l) });
  assert.equal(ok, true, lines.join('\n'));
  assert.deepEqual(
    lines.map((l) => l.split(' (')[0]),
    [
      'PASS the S3 joins its room on the relay',
      'PASS the PC reaches it and the link is sealed',
      'PASS it stays up for 1 s with nobody talking',
      'PASS the PC notices when the S3 leaves',
      'PASS and is sealed again when it comes back',
      'PASS a second PC in the room replaces the first',
    ],
  );
  assert.match(lines[2], /\(\d+ PONGs, 0 drops\)/);
  assert.match(lines[5], /\(close code 4000\)$/);
});

test('gate L fails at the first scene, quickly, when no relay answers', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const host = `ws://127.0.0.1:${relay.port}`;
  await relay.close();
  const lines = [];
  const started = Date.now();
  const ok = await runGateL({ host, holdMs: 1000, waitMs: 2000, clock: FAST, say: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL the S3 joins its room on the relay \(/);
  assert.ok(Date.now() - started < 5000, 'no hang');
});

test('gate L fails the hold when the relay goes away while the link is up', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  const lines = [];
  const say = (l) => {
    lines.push(l);
    if (l.startsWith('PASS the PC reaches it')) relay.close(); // a relay restarted, or a network gone, in the middle of the hold
  };
  const ok = await runGateL({ host: `ws://127.0.0.1:${relay.port}`, holdMs: 1500, waitMs: 5000, clock: FAST, say });
  assert.equal(ok, false);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[2], /^FAIL it stays up for 1\.5 s with nobody talking \(\d+ PONGs, [1-9]\d* drops\)$/);
});

test('gate L stops at the sealed link when the S3 holds another key', async (t) => {
  const { ok, lines, last } = await gate(t, { waitMs: 1500, s3Options: { master: Buffer.alloc(32, 7) } });
  assert.equal(ok, false);
  assert.equal(lines.length, 2);
  assert.equal(last, 'FAIL the PC reaches it and the link is sealed');
});

test('gate L fails the hold when the S3 answers no PING, even before the PC gives up on it', async (t) => {
  const { ok, lines, last } = await gate(t, { clock: SLOW_LOSS, onLine: (l, c) => l.startsWith('PASS the PC reaches') && (c.s3.answerPings = false) });
  assert.equal(ok, false);
  assert.equal(lines.length, 3);
  assert.equal(last, 'FAIL it stays up for 1 s with nobody talking (0 PONGs, 0 drops)');
});

test('gate L fails the hold when the link dropped in it, even though it came back', async (t) => {
  const onLine = (l, c) => {
    if (!l.startsWith('PASS the PC reaches')) return;
    c.s3.answerPings = false;
    setTimeout(() => (c.s3.answerPings = true), 700);
  };
  const { ok, lines, last } = await gate(t, { holdMs: 4000, onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 3);
  assert.match(last, /^FAIL it stays up for 4 s with nobody talking \([1-9]\d* PONGs, [1-9]\d* drops\)$/);
});

test('gate L fails when the PC is slower to notice the S3 leaving than the gate waits', async (t) => {
  const { ok, lines, last } = await gate(t, { holdMs: 300, waitMs: 1500, clock: SLOW_LOSS });
  assert.equal(ok, false);
  assert.equal(lines.length, 4);
  assert.equal(last, 'FAIL the PC notices when the S3 leaves (still ready)');
});

test('gate L fails when the S3 that comes back does not answer', async (t) => {
  const onLine = (l, c) => l.startsWith('PASS the PC notices') && (c.s3.write = () => {});
  const { ok, lines, last } = await gate(t, { waitMs: 1500, onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 5);
  assert.equal(last, 'FAIL and is sealed again when it comes back');
});

test('gate L says FAIL, and does not throw, when the relay goes away before the S3 comes back', async (t) => {
  const onLine = (l, c) => l.startsWith('PASS the PC notices') && c.relay.close();
  const { ok, lines, last } = await gate(t, { onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 5);
  assert.match(last, /^FAIL and is sealed again when it comes back \(.+\)$/);
});
