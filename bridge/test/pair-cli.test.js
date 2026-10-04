// The part of `walkie pair` between the command line and runPair: what it is given, what it says, and the exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairCommand } from '../src/pair-cli.js';

const run = async (outcome, { forget = false } = {}) => {
  const calls = [];
  const lines = [];
  const code = await pairCommand({
    forget,
    openPort: 'the opener',
    say: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    run: async (options) => {
      calls.push(options);
      if (outcome instanceof Error) throw outcome;
      return { outcome };
    },
  });
  return { code, calls, lines };
};

test('it hands runPair the port opener and whether to forget, and says what runPair says', async () => {
  const a = await run('paired');
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].openPort, 'the opener');
  assert.equal(a.calls[0].forget, false);
  assert.equal(typeof a.calls[0].say, 'function');
  const b = await run('forgotten', { forget: true });
  assert.equal(b.calls[0].forget, true);
});

test('paired and forgotten are exit 0, and anything else is exit 1', async () => {
  assert.equal((await run('paired')).code, 0);
  assert.equal((await run('forgotten', { forget: true })).code, 0);
  for (const outcome of ['denied', 'no-answer', 'unverified']) assert.equal((await run(outcome)).code, 1, outcome);
});

test('a walkie that is not there is exit 1 with the reason, not a stack trace', async () => {
  const r = await run(new Error('no walkie answered within 10 s'));
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, ['ERR no walkie answered within 10 s']);
});
