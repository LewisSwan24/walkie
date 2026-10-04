import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovals, DENY_ABORTED, DENY_DEFAULT, DENY_SHUTDOWN, DENY_TIMEOUT, denyWithReason } from '../../src/perm/approvals.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// An approvals queue with its events written down, on mock timers.
function setup(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const approvals = createApprovals(options);
  const log = [];
  approvals.on('show', (v) => log.push(['show', v.id]));
  approvals.on('clear', (v) => log.push(['clear', v.id, v.outcome]));
  const shown = [];
  approvals.on('show', (v) => shown.push(v));
  return { approvals, log, shown };
}
const ask = (approvals, tool = 'Write', input = { file_path: 'a.txt', content: 'x' }, extra = {}) => {
  let verdict = null;
  const done = approvals.request({ tool, input, toolUseId: 'toolu_1', ...extra }).then((v) => (verdict = v));
  return { done, get verdict() { return verdict; } };
};

test('the first request is shown at once, with its tool, preview and tool use id, and allowing it resolves the call', async (t) => {
  const { approvals, log, shown } = setup(t);
  const a = ask(approvals, 'Bash', { command: 'npm test' });
  assert.deepEqual(shown, [{ id: 1, tool: 'Bash', preview: 'npm test', toolUseId: 'toolu_1' }]);
  assert.deepEqual(approvals.current(), shown[0]);
  assert.equal(approvals.pending(), 1);
  assert.equal(approvals.answer(1, { allow: true }), true);
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'allow' });
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']]);
  assert.equal(approvals.current(), null);
  assert.equal(approvals.pending(), 0);
});

test('a denial says who refused and not to try again, and carries the reason he spoke, if he did', async (t) => {
  const { approvals } = setup(t);
  const plain = ask(approvals);
  approvals.answer(1, { allow: false });
  await plain.done;
  assert.deepEqual(plain.verdict, { behavior: 'deny', message: DENY_DEFAULT });
  assert.match(DENY_DEFAULT, /不要重试/);
  const spoken = ask(approvals);
  approvals.answer(2, { reason: '  先别动 package.json  ' });
  await spoken.done;
  assert.deepEqual(spoken.verdict, { behavior: 'deny', message: '用户在手腕上拒绝了这个操作，理由：先别动 package.json' });
  assert.equal(denyWithReason('x'), '用户在手腕上拒绝了这个操作，理由：x');
  const blank = ask(approvals);
  approvals.answer(3, { allow: false, reason: '   ' });
  await blank.done;
  assert.equal(blank.verdict.message, DENY_DEFAULT);
  const odd = ask(approvals);
  approvals.answer(4, { reason: 7 });
  await odd.done;
  assert.equal(odd.verdict.message, DENY_DEFAULT);
  const bare = ask(approvals);
  approvals.answer(5);
  await bare.done;
  assert.equal(bare.verdict.message, DENY_DEFAULT);
});

test('with no answer it is denied after the timeout with the words of the spec, and the screen is told', async (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 55_000 });
  const a = ask(approvals);
  t.mock.timers.tick(54_999);
  await settle();
  assert.equal(a.verdict, null);
  t.mock.timers.tick(1);
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: '手腕上没人回应，先别做。' });
  assert.equal(DENY_TIMEOUT, '手腕上没人回应，先别做。');
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'timeout']]);
});

test('the wait is 55 s unless told otherwise, and an answer stops the clock', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals);
  t.mock.timers.tick(54_000);
  approvals.answer(1, { allow: true });
  await a.done;
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']], 'nothing happens after the answer');
  const b = ask(approvals);
  t.mock.timers.tick(55_000);
  await b.done;
  assert.equal(b.verdict.message, DENY_TIMEOUT);
});

test('every way a request ends stops its clock', async (t) => {
  const { approvals } = setup(t);
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const gone = new AbortController();
  const list = [ask(approvals), ask(approvals, 'Write', {}, { signal: gone.signal }), ask(approvals), ask(approvals)];
  approvals.answer(1, { allow: true });
  gone.abort();
  approvals.denyAll();
  await Promise.all(list.map((x) => x.done));
  assert.equal(cleared.mock.callCount(), 4);
});

test('requests wait their turn: one on the screen, the next shown when it is answered, in the order they came', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals, 'Write', { file_path: 'one' });
  const b = ask(approvals, 'Write', { file_path: 'two' });
  const c = ask(approvals, 'Write', { file_path: 'three' });
  assert.deepEqual(log, [['show', 1]], 'only the first is shown');
  assert.equal(approvals.pending(), 3);
  assert.equal(approvals.answer(2, { allow: true }), false, 'the one that is not on the screen cannot be answered');
  assert.equal(approvals.answer(1, { allow: true }), true);
  await a.done;
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed'], ['show', 2]]);
  assert.match(approvals.current().preview, /^two/);
  approvals.answer(2, { allow: false });
  approvals.answer(3, { allow: true });
  await Promise.all([b.done, c.done]);
  assert.deepEqual(log.slice(3), [['clear', 2, 'denied'], ['show', 3], ['clear', 3, 'allowed']]);
  assert.deepEqual([a.verdict.behavior, b.verdict.behavior, c.verdict.behavior], ['allow', 'deny', 'allow']);
});

test('each request has its own clock, from the moment it arrived', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals);
  t.mock.timers.tick(30_000);
  const b = ask(approvals);
  t.mock.timers.tick(25_000); // 55 s since a, 25 since b
  await a.done;
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'timeout'], ['show', 2]]);
  assert.equal(b.verdict, null);
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(b.verdict, null);
  t.mock.timers.tick(1);
  await b.done;
  assert.equal(b.verdict.message, DENY_TIMEOUT);
});

test('an answer that is late, unknown or for a request that is not on the screen changes nothing', async (t) => {
  const { approvals, log } = setup(t);
  assert.equal(approvals.answer(1, { allow: true }), false);
  const a = ask(approvals);
  assert.equal(approvals.answer(99, { allow: true }), false);
  assert.equal(approvals.answer('1', { allow: true }), false);
  approvals.answer(1, { allow: true });
  await a.done;
  assert.equal(approvals.answer(1, { allow: false }), false, 'the same request answered twice');
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']]);
});

test('a client that goes away takes its request off the screen, and the next one comes up', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  const a = ask(approvals, 'Write', { file_path: 'one' }, { signal: gone.signal });
  const b = ask(approvals, 'Write', { file_path: 'two' });
  gone.abort();
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: DENY_ABORTED });
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'aborted'], ['show', 2]]);
  assert.equal(b.verdict, null);
  assert.equal(approvals.pending(), 1);
});

test('a request that is waiting behind another and is abandoned leaves quietly', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  ask(approvals, 'Write', { file_path: 'one' });
  const b = ask(approvals, 'Write', { file_path: 'two' }, { signal: gone.signal });
  gone.abort();
  await b.done;
  assert.deepEqual(log, [['show', 1], ['clear', 2, 'aborted']], 'the screen is not touched');
  assert.equal(approvals.current().id, 1);
  assert.equal(approvals.pending(), 1);
});

test('a request whose client is already gone is denied without ever being shown', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  gone.abort();
  const a = ask(approvals, 'Write', {}, { signal: gone.signal });
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: DENY_ABORTED });
  assert.deepEqual(log, []);
  assert.equal(approvals.pending(), 0);
});

test('an answer takes the abort listener off the signal, so a client that lives long does not collect them', async (t) => {
  const { approvals } = setup(t);
  const controller = new AbortController();
  let removed = 0;
  const original = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => (removed++, original(...args));
  const a = ask(approvals, 'Write', {}, { signal: controller.signal });
  approvals.answer(1, { allow: true });
  await a.done;
  assert.equal(removed, 1);
  controller.abort();
  await settle();
  assert.equal(a.verdict.behavior, 'allow', 'an abort after the answer does nothing');
});

test('denyAll refuses everything that is waiting, the one on the screen last, with the message given', async (t) => {
  const { approvals, log } = setup(t);
  const list = [ask(approvals), ask(approvals), ask(approvals)];
  approvals.denyAll('关机了');
  await Promise.all(list.map((x) => x.done));
  assert.deepEqual(list.map((x) => x.verdict), Array(3).fill({ behavior: 'deny', message: '关机了' }));
  assert.deepEqual(log, [['show', 1], ['clear', 3, 'denied'], ['clear', 2, 'denied'], ['clear', 1, 'denied']], 'no request is shown on the way');
  assert.equal(approvals.pending(), 0);
  const later = ask(approvals);
  approvals.denyAll();
  await later.done;
  assert.equal(later.verdict.message, DENY_SHUTDOWN);
  approvals.denyAll();
});

test('the ids count up from 1, wrap round at 65535 and skip one that is still waiting', (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 10 ** 9 });
  ask(approvals); // id 1 stays waiting at the head
  const passThrough = () => {
    const gone = new AbortController();
    ask(approvals, 'Write', {}, { signal: gone.signal });
    gone.abort(); // a request that waits behind the head can leave on its own
    return log.at(-1)[1];
  };
  let expected = 2;
  for (; expected <= 65534; expected++) {
    const id = passThrough();
    if (id !== expected) assert.fail(`the id after ${expected - 1} was ${id}, not ${expected}`);
  }
  assert.equal(passThrough(), 65535);
  assert.equal(passThrough(), 2, 'it went round, and passed the 1 that is still waiting');
  assert.equal(passThrough(), 3);
  assert.equal(approvals.current().id, 1);
});

test('when the one that waited is gone its id comes round again', async (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 10 ** 9 });
  const first = ask(approvals);
  approvals.answer(1, { allow: true });
  await first.done;
  const second = ask(approvals);
  assert.equal(approvals.current().id, 2);
  approvals.answer(2, { allow: true });
  await second.done;
  assert.deepEqual(log.filter((e) => e[0] === 'show').map((e) => e[1]), [1, 2]);
});

test('a request with no tool or input is shown as it came, and its fields are text', (t) => {
  const { approvals, shown } = setup(t);
  approvals.request({});
  assert.deepEqual(shown[0], { id: 1, tool: '', preview: '{}', toolUseId: '' });
  approvals.denyAll();
});

test('a tool use id that is missing, null or not text is shown as no id, and a tool name that is not text as text', (t) => {
  const { approvals, shown } = setup(t);
  for (const toolUseId of [undefined, null, 5, {}]) {
    approvals.request({ tool: 'Write', input: {}, toolUseId });
    approvals.denyAll();
  }
  approvals.request({ tool: 'Write', input: {}, toolUseId: 'toolu_7' });
  approvals.denyAll();
  assert.deepEqual(shown.map((v) => v.toolUseId), ['', '', '', '', 'toolu_7']);
  approvals.request({ tool: 5, input: {} });
  assert.equal(shown.at(-1).tool, '5');
  approvals.denyAll();
});
