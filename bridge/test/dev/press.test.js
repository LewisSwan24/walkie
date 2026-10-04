import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import press, { parseKeyScript, ScriptError } from '../../src/dev/press.js';
import { TYPE } from '../../src/link/frame.js';
import { KEY, TEST_OP, parseTestKeys } from '../../src/link/messages.js';
import { fakeLink, fakeLinkWithScreen } from '../helpers/fake-link.js';

const F = KEY.FRONT;
const S = KEY.SIDE;

test('a hold is a press, a wait of its length, and a release', () => {
  assert.deepEqual(parseKeyScript('front:500'), { steps: [{ delayMs: 0, mask: F }, { delayMs: 500, mask: 0 }], totalMs: 500 });
  assert.deepEqual(parseKeyScript('side:1100').steps, [{ delayMs: 0, mask: S }, { delayMs: 1100, mask: 0 }]);
  assert.deepEqual(parseKeyScript('both:3200').steps, [{ delayMs: 0, mask: F | S }, { delayMs: 3200, mask: 0 }]);
});

test('waits add up in front of the next step, and commas are spaces', () => {
  assert.deepEqual(parseKeyScript('front:120, wait:300 wait:200, side:90'), {
    steps: [
      { delayMs: 0, mask: F },
      { delayMs: 120, mask: 0 },
      { delayMs: 500, mask: S },
      { delayMs: 90, mask: 0 },
    ],
    totalMs: 710,
  });
});

test('down and up make a chord with the second key a moment after the first', () => {
  assert.deepEqual(parseKeyScript('down:front wait:100 down:side wait:3100 up:both'), {
    steps: [
      { delayMs: 0, mask: F },
      { delayMs: 100, mask: F | S },
      { delayMs: 3100, mask: 0 },
    ],
    totalMs: 3200,
  });
});

test('releasing one key of two leaves the other held', () => {
  assert.deepEqual(parseKeyScript('down:both wait:50 up:front wait:50 up:side').steps.map((s) => s.mask), [F | S, S, 0]);
});

test('anything that is not a script is an error that says what, never a guess', () => {
  const bad = (text, pattern) => assert.throws(() => parseKeyScript(text), (err) => err instanceof ScriptError && pattern.test(err.message), text);
  bad('', /the script is empty/);
  bad('front', /front needs a time/);
  bad('front:abc', /milliseconds/);
  bad('front:-5', /milliseconds/);
  bad('front:0', /more than 0/);
  bad('front:70000', /65535/);
  bad('wait:70000', /65535/);
  bad('thumb:100', /unknown/);
  bad('down:thumb', /front, side or both/);
  bad('up:front', /is not held/);
  bad(Array.from({ length: 9 }, () => 'front:10').join(' '), /at most 16 steps/);
});

test('press sends the script as TEST KEYS and waits for it to play out, with a margin for the S3 to answer', async (t) => {
  const link = fakeLink();
  const slept = [];
  t.mock.method(console, 'log', () => {});
  await press(['front:600', 'wait:200', 'side:100'], {}, async () => link, async (ms) => slept.push(ms));
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual(parseTestKeys(link.sent[0].payload).steps, [
    { delayMs: 0, mask: F },
    { delayMs: 600, mask: 0 },
    { delayMs: 200, mask: S },
    { delayMs: 100, mask: 0 },
  ]);
  assert.deepEqual(slept, [900 + 1500]);
  assert.equal(link.closed, true);
});

test('a bad script stops press before it connects', async () => {
  let connected = false;
  await assert.rejects(press(['front'], {}, async () => (connected = true)), ScriptError);
  assert.equal(connected, false);
});

test('with --snap the screen is saved after the script, and not before it has played out', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-press-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = fakeLinkWithScreen(12, 4, () => 0x07e0);
  const order = [];
  const answer = link.onSend;
  link.onSend = (type, payload) => {
    order.push(payload[0] === TEST_OP.SNAP ? 'snap' : 'keys');
    answer(type, payload);
  };
  const file = path.join(dir, 'after.png');
  await press(['both:3300'], { snap: file }, async () => link, async () => order.push('slept'));
  assert.deepEqual(order, ['keys', 'slept', 'snap']);
  assert.ok(statSync(file).size > 0);
  assert.equal(link.closed, true);
});

test('without --snap press asks for no picture', async (t) => {
  t.mock.method(console, 'log', () => {});
  const link = fakeLink();
  await press(['front:100'], {}, async () => link, async () => {});
  assert.equal(link.sent.length, 1);
});

test('the limits are those of the firmware: 16 steps and 65535 ms to a step, and not one more of either', () => {
  assert.equal(parseKeyScript(Array.from({ length: 8 }, () => 'front:10').join(' ')).steps.length, 16);
  assert.equal(parseKeyScript('wait:65535 front:10').steps[0].delayMs, 65535);
  assert.equal(parseKeyScript('front:65535').steps[1].delayMs, 65535);
  const bad = (text, pattern) => assert.throws(() => parseKeyScript(text), (err) => err instanceof ScriptError && pattern.test(err.message), text);
  bad('wait:65536 front:10', /65535/);
  bad('front:65536', /65535/);
  bad('wait:65535 wait:1 front:10', /between two key changes/);
});

test('a hold leaves a key that is already down down', () => {
  assert.deepEqual(parseKeyScript('down:side wait:50 front:100').steps, [
    { delayMs: 0, mask: S },
    { delayMs: 50, mask: S | F },
    { delayMs: 100, mask: S },
  ]);
});
