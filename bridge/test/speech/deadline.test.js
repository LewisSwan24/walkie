import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError, withDeadline } from '../../src/speech/deadline.js';
import { SpeechError, isAbort, redact } from '../../src/speech/errors.js';

const settle = () => new Promise((r) => setImmediate(r));

test('a call that answers in time returns its value and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withDeadline(1000, null, async () => 'hello'), 'hello');
  t.mock.timers.tick(5000); // nothing fires afterwards
});

test('a call that does not answer in time is cut off with a DeadlineError, and its signal is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let seen = null;
  const pending = withDeadline(3000, null, (signal) => {
    seen = signal;
    return new Promise(() => {}); // never answers, and ignores the signal
  });
  pending.catch(() => {});
  await settle();
  t.mock.timers.tick(2999);
  assert.equal(seen.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (err) => err instanceof DeadlineError && err.ms === 3000 && /3000 ms/.test(err.message));
  assert.equal(seen.aborted, true);
});

test('a call that obeys its signal, as fetch does, still ends with a DeadlineError, not its own AbortError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = withDeadline(3000, null, (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));
  pending.catch(() => {});
  await settle();
  t.mock.timers.tick(3000);
  await assert.rejects(pending, (err) => err instanceof DeadlineError);
});

test('a parent abort ends the call with an AbortError, not a DeadlineError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  let seen = null;
  const pending = withDeadline(3000, parent.signal, (signal) => {
    seen = signal;
    return new Promise(() => {});
  });
  pending.catch(() => {});
  await settle();
  parent.abort();
  await assert.rejects(pending, (err) => isAbort(err));
  assert.equal(seen.aborted, true);
});

test('a parent that is already aborted never starts the work', async () => {
  const parent = new AbortController();
  parent.abort();
  await assert.rejects(withDeadline(3000, parent.signal, async () => 'late'), (err) => isAbort(err));
});

test('a deadline that is not a positive number is refused before anything starts', async () => {
  let started = false;
  for (const ms of [undefined, null, NaN, 0, -5, Infinity, '3000']) {
    await assert.rejects(withDeadline(ms, null, async () => { started = true; }), (err) => err instanceof TypeError && /positive number/.test(err.message), String(ms));
  }
  assert.equal(started, false);
});

test('an error from the call comes through as it is', async () => {
  await assert.rejects(withDeadline(1000, null, async () => { throw new RangeError('boom'); }), RangeError);
});

test('redact removes the configured keys and anything shaped like one', () => {
  const key = 'sk-proj-abcdef0123456789';
  const said = redact(`Incorrect API key provided: ${key}. Also sk-abc***xyz and AIzaSyA1234567890abcdef, plus a-secret-word.`, [key, 'a-secret-word']);
  assert.ok(!said.includes(key));
  assert.ok(!said.includes('sk-abc'));
  assert.ok(!said.includes('AIzaSy'));
  assert.ok(!said.includes('a-secret-word'));
  assert.equal(redact(undefined), '');
  assert.equal(redact('nothing to hide', ['']), 'nothing to hide');
});

test('a SpeechError carries which provider, which step and what kind of failure', () => {
  const err = new SpeechError('openai transcribe: HTTP 503', { provider: 'openai', step: 'transcribe', kind: 'http', status: 503 });
  assert.equal(err.name, 'SpeechError');
  assert.deepEqual([err.provider, err.step, err.kind, err.status], ['openai', 'transcribe', 'http', 503]);
  assert.equal(isAbort(err), false);
});
