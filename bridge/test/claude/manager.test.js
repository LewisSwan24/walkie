import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStateStore } from '../../src/config/state.js';
import { MESSAGES } from '../../src/claude/errors.js';
import { COMPACT_TEXT, CONTINUE_TEXT, createManager, NOTICE, SAY } from '../../src/claude/manager.js';
import { claudeArgs } from '../../src/claude/process.js';
import { statusText } from '../../src/claude/status.js';
import { createProcs, ev, SESSION } from './fake-proc.js';

const PROJECTS = [
  { name: 'alpha', aliases: ['阿尔法'], path: 'C:\\work\\alpha' },
  { name: 'beta', aliases: [], path: 'C:\\work\\beta' },
];
const CONFIG = { command: ['claude-test', '--flag'], model: 'claude-test-model', idleMinutes: 60, approvalTimeoutSec: 55, prewarm: true };
const MCP = { url: 'http://127.0.0.1:5123/mcp', token: 'tok' };
const ARGS = { model: CONFIG.model, mcpUrl: MCP.url, mcpToken: MCP.token };
const MINUTE = 60_000;
const OTHER = '22222222-3333-4444-8555-666666666666';
const settle = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate is not one of the mocked timers

// A manager on a double of the process, mock timers and an in-memory state store; `seen` is every event it emitted.
function setup(t, { config = {}, store = createStateStore({ file: null }), isDir = () => true, start } = {}) {
  t.mock.timers.reset(); // a test may set up more than one manager
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const procs = createProcs();
  const logs = [];
  const manager = createManager({ config: { ...CONFIG, ...config }, projects: PROJECTS, store, mcp: MCP, start: start ? (spec, handlers) => start(procs, spec, handlers) : procs.start, env: { E: '1' }, log: (line) => logs.push(line), isDir });
  const seen = [];
  for (const name of ['working', 'reply', 'idle', 'notice', 'failure', 'project']) manager.on(name, (payload) => seen.push([name, payload]));
  const names = () => seen.map(([name]) => name);
  const say = (text) => manager.handle({ intent: 'to_claude', text });
  const speak = async (intent, extra = {}) => (await manager.handle({ intent, ...extra })).speak;
  return { manager, procs, store, logs, seen, names, say, speak };
}

// A whole turn as the process prints it.
function answer(proc, { text = '好了\n\n<voice>好了。</voice>', ms = 1500, sessionId = SESSION } = {}) {
  proc.print(ev.init({ sessionId }));
  proc.print(ev.text(text));
  proc.print(ev.result({ text, ms, sessionId }));
}

test('start() with prewarm starts the active project\'s process: the configured command, the spec\'s arguments, its folder, the given environment', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  assert.equal(procs.procs.length, 1);
  const { spec } = procs.last();
  assert.deepEqual(spec.command, ['claude-test', '--flag']);
  assert.deepEqual(spec.args, claudeArgs(ARGS));
  assert.equal(spec.cwd, 'C:\\work\\alpha');
  assert.deepEqual(spec.env, { E: '1' });
});

test('without prewarm start() starts nothing, and the first message starts the process and goes to it', async (t) => {
  const { manager, procs, names, say } = setup(t, { config: { prewarm: false } });
  manager.start();
  assert.equal(procs.procs.length, 0);
  await say('你好');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['你好']);
  assert.deepEqual(names(), ['working']);
});

test('a message goes to the process that was started ahead, not to a second one, and is sent as it was said', async (t) => {
  const { manager, procs, say } = setup(t);
  manager.start();
  await say('  把 README 改一下  ');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['  把 README 改一下  ']);
});

test('the active project is the stored one when it exists, else the first, and start() stores it', (t) => {
  const known = createStateStore({ file: null });
  known.setProject('beta');
  const a = setup(t, { store: known });
  assert.equal(a.manager.project(), 'beta');
  a.manager.start();
  assert.equal(a.procs.last().spec.cwd, 'C:\\work\\beta');

  const unknown = createStateStore({ file: null });
  unknown.setProject('renamed-away');
  const b = setup(t, { store: unknown });
  assert.equal(b.manager.project(), 'alpha');
  b.manager.start();
  assert.equal(unknown.project(), 'alpha');
});

test('a turn: working, working with the tool in use, the reply with its voice, then idle', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  const proc = procs.last();
  await say('看一下测试');
  proc.print(ev.init());
  proc.print(ev.tool('Bash', { command: 'npm test' }));
  const text = '干完了\n\n<voice>测试都通过了。</voice>';
  proc.print(ev.text(text));
  proc.print(ev.result({ text, ms: 45_000, cost: 0.1234 }));
  assert.deepEqual(seen, [
    ['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }],
    ['working', { project: 'alpha', tool: 'Bash', summary: 'npm test', startedAt: 0 }],
    ['reply', { project: 'alpha', kind: 'reply', voice: '测试都通过了。', screen: '干完了', text, tagged: true, turns: 1, ms: 45_000, costUsd: 0.1234 }],
    ['idle', { project: 'alpha' }],
  ]);
});

// claude's total_cost_usd is the running total of the process, not of the turn, so a reply carries the difference.
test('a reply carries what its turn cost, not the process\'s running total', async (t) => {
  const { manager, procs, seen, logs, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 0.5 }));
  await say('二');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 0.75 }));
  const costs = seen.filter(([name]) => name === 'reply').map(([, reply]) => reply.costUsd);
  assert.deepEqual(costs, [0.5, 0.25]);
  assert.ok(logs.some((line) => line.includes('turn 2') && line.includes('0.250 USD')), logs.join('\n'));
});

test('a process started later counts its cost from zero, and a turn that failed is not charged to the next one', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 0.5 }));
  await say('二');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', cost: 0.75 }));
  await say('三');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 1 }));
  procs.last().exit({ code: 1 });
  await say('四');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 0.125 }));
  const costs = seen.filter(([name]) => name === 'reply').map(([, reply]) => reply.costUsd);
  assert.deepEqual(costs, [0.5, 0.25, 0.125]);
});

test('a /compact is billed what it cost, not the running total either', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ text: '好', cost: 0.5 }));
  await manager.handle({ intent: 'compact' });
  procs.last().print(ev.compacting());
  procs.last().print(ev.init());
  procs.last().print(ev.compacted({ pre: 55111, post: 6566 }));
  procs.last().print(ev.result({ text: '', turns: 0, cost: 0.75 }));
  const compact = seen.find(([name, reply]) => name === 'reply' && reply.kind === 'compact')[1];
  assert.equal(compact.costUsd, 0.25);
});

test('the session id is stored when claude says it, and a process started later resumes that session', async (t) => {
  const { manager, procs, store, say } = setup(t, { config: { prewarm: false } });
  await say('一');
  procs.last().print(ev.init());
  assert.equal(store.sessionId('alpha'), SESSION);
  procs.last().exit({ code: 1 });
  await say('二');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.equal(manager.project(), 'alpha');
});

test('a reply without the voice tag is untagged and speaks its first sentence', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('嗯');
  answer(procs.last(), { text: '已经改好了。另外还有一个小问题。' });
  const reply = seen.find(([name]) => name === 'reply')[1];
  assert.equal(reply.tagged, false);
  assert.equal(reply.voice, '已经改好了。');
  assert.equal(reply.screen, '已经改好了。另外还有一个小问题。');
});

// The test below is a shape that was not measured with the real claude (a message that arrives while an answer is being written, merged
// into it); the one after it is the shape that was (1 Oct 2026, claude 2.1.285): two messages sent before the first turn has begun are
// answered as two turns, each with its own `init` and `result`.
test('however many messages are sent during a turn, working is announced once and the one result is one reply', async (t) => {
  const { manager, procs, names, say } = setup(t);
  manager.start();
  await say('第一句');
  await say('第二句');
  assert.deepEqual(procs.last().sent, ['第一句', '第二句']);
  procs.last().print(ev.init());
  answer(procs.last());
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
});

test('two messages answered as two turns: each turn is announced, spoken and ended on its own, and costs its own difference', async (t) => {
  const { manager, procs, seen, names, say } = setup(t);
  manager.start();
  await say('第一句');
  await say('第二句');
  const proc = procs.last();
  proc.print(ev.init());
  proc.print(ev.tool('Bash', { command: 'npm test' }));
  proc.print(ev.result({ text: '第一个答案', cost: 0.5 }));
  proc.print(ev.init());
  proc.print(ev.result({ text: '第二个答案', cost: 0.75 }));
  assert.deepEqual(proc.sent, ['第一句', '第二句']);
  assert.deepEqual(names(), ['working', 'working', 'reply', 'idle', 'working', 'reply', 'idle']);
  const replies = seen.filter(([name]) => name === 'reply').map(([, reply]) => [reply.screen, reply.turns, reply.costUsd]);
  assert.deepEqual(replies, [['第一个答案', 1, 0.5], ['第二个答案', 2, 0.25]]);
});

test('a turn that begins without a message from here is a working turn too', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().print(ev.init());
  assert.deepEqual(seen, [['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }]]);
});

test('status says what the process is doing: nothing running, ready, thinking, using a tool and for how long, idle, stopped', async (t) => {
  const { manager, procs, store, speak, say } = setup(t, { config: { prewarm: false } });
  const base = { project: 'alpha', running: false, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false };
  assert.equal(await speak('status'), statusText(base));
  await say('做点事');
  const proc = procs.last();
  proc.print(ev.init());
  t.mock.timers.tick(10_000);
  assert.equal(await speak('status'), statusText({ ...base, running: true, busy: true, elapsedMs: 10_000, turns: 1, resumable: true }));
  proc.print(ev.tool('Bash', { command: 'npm test' }));
  t.mock.timers.tick(35_000);
  assert.equal(await speak('status'), statusText({ ...base, running: true, busy: true, tool: 'Bash', summary: 'npm test', elapsedMs: 45_000, turns: 1, resumable: true }));
  answer(proc, { ms: 45_000 });
  assert.equal(await speak('status'), statusText({ ...base, running: true, elapsedMs: 45_000, turns: 1, resumable: true }));
  proc.exit({ code: 1 });
  assert.equal(await speak('status'), statusText({ ...base, elapsedMs: 45_000, turns: 1, resumable: true }));
  assert.equal(store.sessionId('alpha'), SESSION);
});

test('a process that is ready and has done nothing is "standing by"', async (t) => {
  const { manager, speak } = setup(t);
  manager.start();
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
});

test('stop ends a busy process, says so, keeps the session, and the exit that follows is no news', async (t) => {
  const { manager, procs, store, seen, say, speak } = setup(t);
  manager.start();
  await say('做个很长的事');
  procs.last().print(ev.init());
  seen.length = 0;
  assert.equal(await speak('stop'), SAY.stopped);
  assert.equal(procs.last().killed, true);
  assert.deepEqual(seen, [['idle', { project: 'alpha' }]]);
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: false, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: true }));
});

test('stop with nothing to stop leaves the process alone', async (t) => {
  const { manager, procs, say, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('stop'), SAY.nothingToStop);
  manager.start();
  await say('一');
  answer(procs.last());
  assert.equal(await speak('stop'), SAY.nothingToStop);
  assert.equal(procs.last().killed, false);
});

test('after a stop the next message starts a new process that resumes the same session', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('慢活');
  procs.last().print(ev.init());
  await speak('stop');
  await say('继续吧');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.deepEqual(procs.last().sent, ['继续吧']);
});

test('continue sends the word for it and compact sends the command', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  assert.deepEqual(await manager.handle({ intent: 'continue' }), {});
  assert.deepEqual(await manager.handle({ intent: 'compact' }), {});
  assert.deepEqual(procs.last().sent, [CONTINUE_TEXT, COMPACT_TEXT]);
  assert.equal(CONTINUE_TEXT, '继续');
  assert.equal(COMPACT_TEXT, '/compact');
});

test('a /compact is answered with how much shorter the context got, not with an empty reply', async (t) => {
  const { manager, procs, seen, names } = setup(t);
  manager.start();
  await manager.handle({ intent: 'compact' });
  const proc = procs.last();
  proc.print(ev.compacting());
  proc.print(ev.init());
  proc.print(ev.compacted({ pre: 55111, post: 6566 }));
  proc.print(ev.result({ text: '', ms: 18_000, turns: 0 }));
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
  assert.deepEqual(seen[1][1], { project: 'alpha', kind: 'compact', voice: '压缩完了，上下文少了88%。', screen: '压缩完了，上下文少了88%。', text: '', tagged: false, turns: 0, ms: 18_000, costUsd: 0.05 });
});

test('a compaction that claude does by itself in the middle of a turn does not change that turn\'s reply', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('长任务');
  procs.last().print(ev.init());
  procs.last().print(ev.compacted({ trigger: 'auto' }));
  const text = '做完了\n\n<voice>做完了。</voice>';
  procs.last().print(ev.result({ text }));
  const reply = seen.find(([name]) => name === 'reply')[1];
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.voice, '做完了。');
  assert.equal(reply.turns, 1);
});

test('the compaction speech copes with numbers that make no sense', async (t) => {
  for (const [pre, post, spoken] of [[0, 0, '压缩完了。'], [1000, 2000, '压缩完了。'], [1000, 1000, '压缩完了，上下文少了0%。'], [1000, 0, '压缩完了，上下文少了100%。']]) {
    const { manager, procs, seen } = setup(t);
    manager.start();
    await manager.handle({ intent: 'compact' });
    procs.last().print(ev.compacted({ pre, post }));
    procs.last().print(ev.result({ text: '', turns: 0 }));
    assert.equal(seen.find(([name]) => name === 'reply')[1].voice, spoken, `${pre} -> ${post}`);
  }
});

test('new_session ends the process, forgets the session, counts turns from zero again and starts a fresh process', async (t) => {
  const { manager, procs, store, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.equal(await speak('new_session'), SAY.newSession);
  assert.equal(procs.procs[0].killed, true);
  assert.equal(store.sessionId('alpha'), null);
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
});

test('new_session without prewarm starts nothing until he speaks', async (t) => {
  const { procs, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('new_session'), SAY.newSession);
  assert.equal(procs.procs.length, 0);
});

test('switch_project: an unknown project and the active one change nothing; another ends the process, starts that project\'s, resumes its session, and keeps the other\'s', async (t) => {
  const { manager, procs, store, seen, speak } = setup(t);
  store.setSession('alpha', SESSION);
  store.setSession('beta', OTHER);
  manager.start();
  assert.equal(await speak('switch_project', { project: 'nope' }), SAY.noProject);
  assert.equal(await speak('switch_project', { project: 'alpha' }), SAY.sameProject('alpha'));
  assert.equal(procs.procs.length, 1);
  assert.equal(procs.procs[0].killed, false);

  assert.equal(await speak('switch_project', { project: 'beta' }), SAY.switched('beta'));
  assert.equal(procs.procs[0].killed, true);
  assert.equal(procs.procs.length, 2);
  assert.equal(procs.last().spec.cwd, 'C:\\work\\beta');
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: OTHER }));
  assert.equal(manager.project(), 'beta');
  assert.equal(store.project(), 'beta');
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.deepEqual(seen, [['project', { name: 'beta' }]]);

  await speak('switch_project', { project: 'alpha' });
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
});

test('switching away from a busy project ends its run of working', async (t) => {
  const { manager, names, say, speak } = setup(t);
  manager.start();
  await say('一');
  await speak('switch_project', { project: 'beta' });
  assert.deepEqual(names(), ['working', 'idle', 'project']);
});

test('a failed turn is a failure of the kind it was, with the sentence for the screen, then idle', async (t) => {
  const login = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
  const model = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
  const cases = [
    [[ev.apiError('authentication_failed', login)], ev.result({ ok: false, text: login, status: 401 }), { kind: 'login', message: MESSAGES.login }],
    [[ev.apiError('model_not_found', model)], ev.result({ ok: false, text: model, status: 404 }), { kind: 'model', message: MESSAGES.model }],
    [[], ev.result({ ok: false, text: 'Something odd went wrong\nsecond line' }), { kind: 'other', message: 'Claude 出错了：Something odd went wrong' }],
  ];
  for (const [before, result, failure] of cases) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('hi');
    procs.last().print(ev.init());
    for (const e of before) procs.last().print(e);
    procs.last().print(result);
    assert.deepEqual(seen.slice(1), [['failure', failure], ['idle', { project: 'alpha' }]], failure.kind);
  }
});

test('the process stays usable after a failed turn, and the turn count does not include it', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('hi');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, text: 'boom' }));
  await say('again');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['hi', 'again']);
  answer(procs.last());
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: 1500, turns: 1, resumable: true }));
});

test('a session that cannot be resumed at start: the id is forgotten, he is told, and a fresh process takes over', (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, seen } = setup(t, { store });
  manager.start();
  const first = procs.last();
  assert.deepEqual(first.spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  first.print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0, ms: 0 }));
  first.exit({ code: 1 });
  assert.equal(store.sessionId('alpha'), null);
  assert.equal(first.killed, true);
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.deepEqual(seen, [['notice', { kind: 'no-session', text: MESSAGES['no-session'] }]]);
});

test('a session that cannot be resumed when a message was already sent: the message goes to the fresh process, and the run of working goes on', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, names, say } = setup(t, { store, config: { prewarm: false } });
  await say('帮我看看');
  const first = procs.last();
  assert.deepEqual(first.sent, ['帮我看看']);
  first.print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0, ms: 0 }));
  first.exit({ code: 1 });
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().sent, ['帮我看看']);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.deepEqual(names(), ['working', 'notice']);
  answer(procs.last(), { sessionId: OTHER });
  assert.deepEqual(names(), ['working', 'notice', 'reply', 'idle']);
  assert.equal(store.sessionId('alpha'), OTHER);
});

test('the missing-session answer is only believed for a process that was asked to resume something', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('hi');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: ['No conversation found with session ID: x'], turns: 0 }));
  assert.equal(procs.procs.length, 1);
  assert.equal(seen.at(-2)[0], 'failure');
});

// An EventEmitter throws when it emits 'error' and nobody listens: the failure event has another name, so that a manager that
// nothing listens to yet (the bridge before the device layer is up) cannot be brought down by what Claude says or does.
test('with nobody listening, a failed turn, an unexpected exit and a program that is missing throw nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const procs = createProcs();
  const missing = () => {
    throw Object.assign(new Error('spawn claude-test ENOENT'), { code: 'ENOENT' });
  };
  const manager = createManager({ config: { ...CONFIG, prewarm: false }, projects: PROJECTS, store: createStateStore({ file: null }), mcp: MCP, start: procs.start, env: {}, isDir: () => true });
  await manager.handle({ intent: 'to_claude', text: 'hi' });
  procs.last().print(ev.init());
  assert.doesNotThrow(() => procs.last().print(ev.result({ ok: false, text: 'Something odd went wrong' })), 'a failed turn');
  await manager.handle({ intent: 'to_claude', text: 'again' });
  assert.doesNotThrow(() => procs.last().exit({ code: 1 }), 'an unexpected exit');
  const lost = createManager({ config: { ...CONFIG, prewarm: false }, projects: PROJECTS, store: createStateStore({ file: null }), mcp: MCP, start: missing, env: {}, isDir: () => true });
  await assert.doesNotReject(lost.handle({ intent: 'to_claude', text: 'hi' }), 'a program that is missing');
});

test('an unexpected exit in the middle of a turn: he is told, the run of working ends, and the next message starts a process that resumes; the lost message is not sent again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('做一件事');
  procs.last().print(ev.init());
  procs.last().stderr = 'TypeError: something broke\n    at foo (bar.js:1:1)';
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen.slice(1), [['notice', { kind: 'exited', text: NOTICE.exitedBusy }], ['idle', { project: 'alpha' }]]);
  await say('再来');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.deepEqual(procs.last().sent, ['再来']);
});

test('an unexpected exit of a process that was only waiting says so in other words', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen, [['notice', { kind: 'exited', text: NOTICE.exitedIdle }]]);
});

test('an exit whose stderr names a login problem is that failure, not a vague notice', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().stderr = 'Invalid API key · Please run /login';
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen, [['failure', { kind: 'login', message: MESSAGES.login }]]);
});

test('a program that cannot be started is a failure of kind missing, and a message after it tries again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  procs.last().exit({ code: null, error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
  assert.deepEqual(seen, [['failure', { kind: 'missing', message: MESSAGES.missing }]]);
  await say('hi');
  assert.equal(procs.procs.length, 2);
});

test('after an hour of nothing the input is closed, not the process killed; the exit is no news and the next message starts again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  seen.length = 0;
  t.mock.timers.tick(59 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(MINUTE);
  assert.equal(procs.last().inputClosed, true);
  assert.equal(procs.last().killed, false);
  procs.last().exit({ code: 0 });
  assert.deepEqual(seen, []);
  await say('二');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
});

test('the hour starts again after each turn, and a process that is busy is never closed for being idle', async (t) => {
  const { manager, procs, say } = setup(t);
  manager.start();
  await say('一');
  t.mock.timers.tick(5 * 60 * MINUTE); // a very long turn
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(59 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  await say('二');
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('the idle limit is the configured one', (t) => {
  const { manager, procs } = setup(t, { config: { idleMinutes: 5 } });
  manager.start();
  t.mock.timers.tick(4 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a permission server that did not connect is a notice, once per process', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init({ walkie: 'failed' }));
  answer(procs.last());
  assert.deepEqual(seen.filter(([name]) => name === 'notice'), [['notice', { kind: 'mcp', text: NOTICE.mcp }]]);
  procs.last().print(ev.init({ walkie: null }));
  assert.equal(seen.filter(([name]) => name === 'notice').length, 1);
});

test('a project whose folder is missing is a failure of kind cwd, and nothing is started', async (t) => {
  const { manager, procs, seen, say } = setup(t, { isDir: () => false });
  manager.start();
  await say('hi');
  assert.equal(procs.procs.length, 0);
  assert.deepEqual(seen.map(([name, payload]) => [name, payload.kind]), [['failure', 'cwd'], ['failure', 'cwd']]);
  assert.match(seen[0][1].message, /alpha/);
});

test('a start that throws is a failure, not a crash', async (t) => {
  const { manager, seen, say } = setup(t, { start: () => { throw Object.assign(new Error('bad arguments'), { code: 'EINVAL' }); } });
  manager.start();
  await say('hi');
  assert.deepEqual(seen.map(([name, payload]) => [name, payload.kind, payload.message]), [
    ['failure', 'other', 'Claude 出错了：bad arguments'],
    ['failure', 'other', 'Claude 出错了：bad arguments'],
  ]);
});

test('a screen that throws while being told does not break the session', async (t) => {
  const { manager, procs, logs, names, say } = setup(t);
  manager.on('reply', () => {
    throw new Error('screen broke');
  });
  manager.start();
  await say('hi');
  answer(procs.last());
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
  assert.ok(logs.some((line) => line.includes('a listener of reply threw: screen broke')));
  await say('again');
  assert.deepEqual(procs.last().sent, ['hi', 'again']);
});

test('what a process that was ended says afterwards is ignored', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  const old = procs.last();
  old.print(ev.init());
  await speak('stop');
  seen.length = 0;
  old.print(ev.tool('Bash', { command: 'x' }));
  answer(old);
  old.exit({ code: 1 });
  assert.deepEqual(seen, []);
});

test('close() ends every process, and nothing is said or timed after it', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  const proc = procs.last();
  await manager.close();
  assert.equal(proc.killed, true);
  seen.length = 0;
  proc.print(ev.init());
  answer(proc);
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.deepEqual(seen, []);
  assert.equal(proc.inputClosed, false);
  assert.deepEqual(await manager.handle({ intent: 'to_claude', text: 'hello?' }), {});
  assert.equal(procs.procs.length, 1);
});

test('close() also ends a process that was let go but has not exited yet', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().kill = () => {
    procs.last().killed = true; // does not exit by itself this time
    return Promise.resolve();
  };
  const old = procs.last();
  await speak('stop');
  old.killed = false;
  await manager.close();
  assert.equal(old.killed, true);
});

test('a process that has silently gone is replaced once; if that one is gone too, it is a failure and nothing is announced as working', async (t) => {
  const first = setup(t);
  first.manager.start();
  first.procs.last().ended = true;
  await first.say('hi');
  assert.equal(first.procs.procs.length, 2);
  assert.equal(first.procs.procs[0].killed, true);
  assert.deepEqual(first.procs.last().sent, ['hi']);

  const second = setup(t, { start: (procs, spec, handlers) => Object.assign(procs.start(spec, handlers), { ended: true }) });
  second.manager.start();
  await second.say('hi');
  assert.equal(second.procs.procs.length, 2); // the one started ahead and its one replacement
  assert.deepEqual(second.seen, [['failure', { kind: 'other', message: NOTICE.notReceived }]]);
});

test('lines that are not events go to the log, cut to 200 characters, and nothing else', (t) => {
  const { manager, procs, logs, seen } = setup(t);
  manager.start();
  const line = `warning: ${'x'.repeat(500)}`;
  procs.last().junk(line);
  assert.ok(logs.includes(`claude: ${line.slice(0, 200)}`), logs.join(' | '));
  assert.deepEqual(seen, []);
});

test('what he said and what Claude answered never reach the log', async (t) => {
  const { manager, procs, logs, say } = setup(t);
  manager.start();
  await say('密码是 hunter2');
  answer(procs.last(), { text: '好的，不会记住 hunter2\n\n<voice>好的，不记。</voice>' });
  procs.last().exit({ code: 1 });
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => !/hunter2|密码|不记/.test(line)), logs.join(' | '));
});

test('intents with nothing to do: an empty message, an unknown intent, a missing text', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  for (const intent of [{ intent: 'to_claude', text: '   ' }, { intent: 'to_claude' }, { intent: 'dance' }, {}]) assert.deepEqual(await manager.handle(intent), {});
  assert.deepEqual(procs.last().sent, []);
});

// ---- the cases the first version of these tests did not pin, found by changing the code and watching what still passed

test('the words he hears and reads', () => {
  assert.deepEqual(
    [SAY.stopped, SAY.nothingToStop, SAY.newSession, SAY.noProject, SAY.sameProject('alpha'), SAY.switched('beta')],
    ['已停止。', '现在没有在做事。', '好的，开了新的对话。', '没有这个项目。', '已经在alpha了。', '切到beta了。'],
  );
  assert.deepEqual(NOTICE, {
    exitedBusy: 'Claude 意外退出了，刚才的事没做完，再说一句就会接着做。',
    exitedIdle: 'Claude 退出了，再说话会自动接上。',
    mcp: '审批通道没连上，Claude 要做的事都会被拒绝。',
    notReceived: 'Claude 没有收到这句话，再说一遍。',
  });
});

test('a result that arrives when no turn was begun here still starts the hour again', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  t.mock.timers.tick(30 * MINUTE);
  procs.last().print(ev.result({ text: '好了' }));
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a process that was ended is not touched by its idle timer afterwards', async (t) => {
  const { manager, procs, speak } = setup(t);
  manager.start();
  await speak('switch_project', { project: 'beta' });
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.procs[0].inputClosed, false);
  assert.equal(procs.procs[1].inputClosed, true); // the new one runs out its own hour
});

test('a second turn is its own: thinking until a tool is used, timed from when it began, counted as the second', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.tool('Bash', { command: 'npm test' }));
  procs.last().print(ev.result({ text: '好了', ms: 2000 }));
  t.mock.timers.tick(7_000);
  seen.length = 0;
  await say('二');
  procs.last().print(ev.init());
  t.mock.timers.tick(3_000);
  assert.deepEqual(seen, [['working', { project: 'alpha', tool: null, summary: '', startedAt: 7_000 }]]);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: true, tool: null, summary: '', elapsedMs: 3_000, turns: 2, resumable: true }));
});

test('turns are counted for each project, and the count of one is there when he comes back to it', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  await speak('switch_project', { project: 'beta' });
  assert.equal(await speak('status'), statusText({ project: 'beta', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
  await speak('switch_project', { project: 'alpha' });
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: 1500, turns: 1, resumable: true }));
});

test('a tool in use with no turn announced before it begins the turn', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().print(ev.tool('Bash', { command: 'ls' }));
  assert.deepEqual(seen, [
    ['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }],
    ['working', { project: 'alpha', tool: 'Bash', summary: 'ls', startedAt: 0 }],
  ]);
});

test('a turn after a compaction is a reply again; the compaction itself was not a turn, and the percentage is rounded', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  await speak('compact');
  procs.last().print(ev.compacted({ pre: 1000, post: 204 }));
  procs.last().print(ev.result({ text: '', turns: 0 }));
  await say('二');
  answer(procs.last());
  const replies = seen.filter(([name]) => name === 'reply').map(([, reply]) => [reply.kind, reply.turns, reply.voice]);
  assert.deepEqual(replies, [['reply', 1, '好了。'], ['compact', 1, '压缩完了，上下文少了80%。'], ['reply', 2, '好了。']]);
});

test('what claude said about one failed turn does not colour the next failed turn', async (t) => {
  const login = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.apiError('authentication_failed', login));
  procs.last().print(ev.result({ ok: false, text: login, status: 401 }));
  await say('二');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, text: 'Something odd went wrong' }));
  assert.deepEqual(seen.filter(([name]) => name === 'failure').map(([, failure]) => failure.kind), ['login', 'other']);
});

test('a failed turn is read from whichever of the error code, the status, the errors list, stderr or the api message says what happened', async (t) => {
  const cases = [
    ['the code', [ev.apiError('rate_limit', 'x')], ev.result({ ok: false, text: 'x' }), '', 'rate'],
    ['the status', [], ev.result({ ok: false, text: 'x', status: 429 }), '', 'rate'],
    ['the errors list', [], ev.result({ ok: false, text: '', subtype: 'error_during_execution', errors: ['Not logged in · Please run /login'] }), '', 'login'],
    ['stderr', [], ev.result({ ok: false, text: '' }), 'Invalid API key · Please run /login', 'login'],
    ['the api message, when the result has no text', [ev.apiError('x', 'Claude usage limit reached')], ev.result({ ok: false, text: '' }), '', 'rate'],
  ];
  for (const [what, before, result, stderr, kind] of cases) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('hi');
    procs.last().stderr = stderr;
    procs.last().print(ev.init());
    for (const e of before) procs.last().print(e);
    procs.last().print(result);
    assert.equal(seen.find(([name]) => name === 'failure')[1].kind, kind, what);
  }
});

test('the permission server counts as connected only when claude says so: left out of the list, pending and failed are each a notice, and a new process is told about again', async (t) => {
  for (const [walkie, notices] of [['connected', 0], [null, 1], ['pending', 1], ['failed', 1]]) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('一');
    procs.last().print(ev.init({ walkie }));
    assert.equal(seen.filter(([name]) => name === 'notice').length, notices, String(walkie));
  }
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init({ walkie: 'failed' }));
  procs.last().exit({ code: 1 });
  await say('二');
  procs.last().print(ev.init({ walkie: 'failed' }));
  assert.equal(seen.filter(([name, payload]) => name === 'notice' && payload.kind === 'mcp').length, 2);
});

test('the missing-session answer is recognised in the errors list and in the result text', (t) => {
  for (const result of [
    ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }),
    ev.result({ ok: false, text: `No conversation found with session ID: ${SESSION}`, turns: 0 }),
  ]) {
    const store = createStateStore({ file: null });
    store.setSession('alpha', SESSION);
    const { manager, procs } = setup(t, { store });
    manager.start();
    procs.last().print(result);
    assert.equal(procs.procs.length, 2);
    assert.equal(store.sessionId('alpha'), null);
  }
});

test('a successful answer that happens to quote the missing-session sentence is just an answer', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, names, say } = setup(t, { store, config: { prewarm: false } });
  await say('这句话是什么意思：No conversation found');
  answer(procs.last(), { text: '意思是 No conversation found with session ID，找不到会话。\n\n<voice>找不到会话。</voice>' });
  assert.equal(procs.procs.length, 1);
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
});

test('when a resumed process turns out to have no session, only what was not answered yet is sent again', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, say } = setup(t, { store, config: { prewarm: false } });
  await say('一');
  answer(procs.last());
  await say('二');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().sent, ['二']);
});

test('the process that takes over for a session that could not be resumed is timed from the first message, and is not closed for idleness while it works', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, say, speak } = setup(t, { store, config: { prewarm: false } });
  t.mock.timers.tick(5_000);
  await say('帮我看看');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  t.mock.timers.tick(2_000);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: true, tool: null, summary: '', elapsedMs: 2_000, turns: 1, resumable: false }));
  t.mock.timers.tick(2 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a session that cannot be resumed, when the process for a new one cannot be started either: he is told, and the run of working ends', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  let starts = 0;
  const start = (procs, spec, handlers) => {
    if (++starts > 1) throw Object.assign(new Error('no more'), { code: 'EINVAL' });
    return procs.start(spec, handlers);
  };
  const { manager, procs, names, say } = setup(t, { store, start, config: { prewarm: false } });
  await say('帮我看看');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  assert.deepEqual(names(), ['working', 'notice', 'failure', 'idle']);
});

test('close() does not kill a process that has already exited', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  procs.last().exit({ code: 1 });
  await manager.close();
  assert.equal(procs.last().killed, false);
});

test('stop, new_session, switch_project and close answer only when the old process is gone', async (t) => {
  for (const [intent, extra] of [['stop', {}], ['new_session', {}], ['switch_project', { project: 'beta' }], ['close', {}]]) {
    const { manager, procs, say, speak } = setup(t);
    manager.start();
    await say('一');
    procs.last().print(ev.init());
    const proc = procs.procs[0];
    let gone = null;
    proc.kill = () => {
      proc.killed = true;
      return new Promise((resolve) => {
        gone = resolve;
      });
    };
    let answered = false;
    const pending = (intent === 'close' ? manager.close() : speak(intent, extra)).then(() => {
      answered = true;
    });
    await settle();
    assert.equal(answered, false, `${intent} answered while the process was still there`);
    gone();
    await pending;
    assert.equal(answered, true, intent);
  }
});

test('a process that could not be started for some other reason is a failure that says why', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().exit({ code: null, error: Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }) });
  assert.deepEqual(seen, [['failure', { kind: 'other', message: 'Claude 出错了：spawn E2BIG' }]]);
});

test('close() leaves no timer and no exit behind that could say anything later', async (t) => {
  const { manager, procs, logs } = setup(t);
  manager.start();
  await manager.close();
  const before = logs.length;
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  assert.equal(logs.length, before);
  assert.ok(!logs.some((line) => line.includes('exited')), logs.join(' | '));
});

test('the idle timer does not keep the bridge alive', (t) => {
  const { manager } = setup(t);
  const mocked = globalThis.setTimeout;
  const unrefs = [];
  globalThis.setTimeout = (...args) => {
    const handle = mocked(...args);
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      unrefs.push(handle);
      return unref();
    };
    return handle;
  };
  t.after(() => {
    globalThis.setTimeout = mocked;
  });
  manager.start();
  assert.equal(unrefs.length, 1);
});

test('a start that throws because the program is not there is a failure of kind missing', (t) => {
  const { manager, seen } = setup(t, { start: () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } });
  manager.start();
  assert.deepEqual(seen, [['failure', { kind: 'missing', message: MESSAGES.missing }]]);
});

test('switch_project without prewarm starts nothing until he speaks, and then starts that project\'s process', async (t) => {
  const { manager, procs, say, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('switch_project', { project: 'beta' }), SAY.switched('beta'));
  assert.equal(procs.procs.length, 0);
  await say('hi');
  assert.equal(procs.last().spec.cwd, 'C:\\work\\beta');
});

test('start() twice starts one process, and a listener that has been taken off hears nothing more', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  manager.start();
  assert.equal(procs.procs.length, 1);
  const heard = [];
  const off = manager.on('working', (payload) => heard.push(payload.tool));
  procs.last().print(ev.init());
  off();
  procs.last().print(ev.tool('Bash', { command: 'x' }));
  assert.deepEqual(heard, [null]);
});

test('without a folder check or an environment of its own the manager asks the file system and passes on its own environment: a folder is a place to start in; a file and a missing path are not', async () => {
  const procs = createProcs();
  const failures = [];
  const projects = [
    { name: 'here', aliases: [], path: import.meta.dirname },
    { name: 'file', aliases: [], path: import.meta.filename },
    { name: 'gone', aliases: [], path: join(import.meta.dirname, 'no-such-folder') },
  ];
  const manager = createManager({ config: CONFIG, projects, store: createStateStore({ file: null }), mcp: MCP, start: procs.start });
  manager.on('failure', (failure) => failures.push(failure.kind));
  manager.start();
  assert.equal(procs.procs.length, 1);
  assert.equal(procs.last().spec.env, process.env); // the bridge's own environment unless it is told another
  await manager.handle({ intent: 'switch_project', project: 'file' });
  await manager.handle({ intent: 'switch_project', project: 'gone' });
  assert.deepEqual(failures, ['cwd', 'cwd']);
  assert.equal(procs.procs.length, 1);
  await manager.close();
});
