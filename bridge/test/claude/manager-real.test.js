// The manager against a real process (fake-claude.js, which speaks claude's stream-json and uses the permission server over
// HTTP the way the real client does) and the real permission server and approvals queue. Everything here takes real time,
// so every wait names what it waits for and gives up after 20 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../src/config/state.js';
import { MESSAGES } from '../../src/claude/errors.js';
import { createManager, NOTICE } from '../../src/claude/manager.js';
import { createApprovals } from '../../src/perm/approvals.js';
import { createPermServer } from '../../src/perm/server.js';
import { SESSION } from './fake-proc.js';

const FAKE = join(import.meta.dirname, 'fake-claude.js');

async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A project folder, the permission server and the approvals queue behind it, and a manager that starts the fake claude.
async function world(t, { fake = {}, config = {}, token = null, store = createStateStore({ file: null }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-real-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const argsFile = join(dir, 'starts.jsonl');
  const approvals = createApprovals({ timeoutMs: 10_000 });
  const shown = [];
  approvals.on('show', (request) => shown.push(request));
  const server = createPermServer({ decide: (request) => approvals.request(request) });
  const mcp = await server.start();
  const manager = createManager({
    config: { command: [process.execPath, FAKE], model: 'fake-model', idleMinutes: 60, approvalTimeoutSec: 10, prewarm: false, ...config },
    projects: [{ name: 'proj', aliases: [], path: project }],
    store,
    mcp: token ? { url: mcp.url, token } : mcp,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ bootMs: 0, turnMs: 0, stateDir: join(dir, 'sessions'), argsFile, ...fake }) },
  });
  const seen = [];
  for (const name of ['working', 'reply', 'idle', 'notice', 'failure', 'project']) manager.on(name, (payload) => seen.push([name, payload]));
  t.after(async () => {
    await manager.close();
    approvals.denyAll();
    await server.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // a process that was just killed may still hold its folder
    }
  });
  const of = (name) => seen.filter(([n]) => n === name).map(([, payload]) => payload);
  return {
    manager,
    approvals,
    shown,
    store,
    project,
    seen,
    of,
    names: () => seen.map(([name]) => name),
    starts: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    say: (text) => manager.handle({ intent: 'to_claude', text }),
    speak: async (intent, extra = {}) => (await manager.handle({ intent, ...extra })).speak,
    idles: (n) => () => of('idle').length >= n,
  };
}

test('a message is answered by a real process: working, the reply with its voice, idle; the session is kept', async (t) => {
  const { manager, seen, of, store, say, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  assert.deepEqual(seen.map(([name]) => name), ['working', 'reply', 'idle']);
  const [reply] = of('reply');
  assert.equal(reply.voice, 'I heard: 你好');
  assert.equal(reply.screen, 'I heard: 你好 (turn 1)');
  assert.equal(reply.turns, 1);
  assert.match(store.sessionId('proj'), /^[0-9a-f-]{36}$/);
  assert.equal(manager.project(), 'proj');
});

test('with prewarm the process is started before the first message, and the message does not start a second', async (t) => {
  const { manager, starts, say, idles } = await world(t, { config: { prewarm: true } });
  manager.start();
  await until(() => starts().length === 1, 'the process that is started ahead');
  await say('你好');
  await until(idles(1), 'the answer');
  assert.equal(starts().length, 1);
});

test('a Write is asked about on the wrist, and happens only if he allows it', async (t) => {
  const { approvals, shown, of, project, say, idles } = await world(t);
  await say('!write out.txt');
  await until(() => shown.length === 1, 'the approval request');
  assert.equal(shown[0].tool, 'Write');
  assert.match(shown[0].preview, /out\.txt/);
  assert.equal(existsSync(join(project, 'out.txt')), false);
  assert.equal(approvals.answer(shown[0].id, { allow: true }), true);
  await until(idles(1), 'the answer');
  assert.equal(existsSync(join(project, 'out.txt')), true);
  assert.ok(of('working').some((w) => w.tool === 'Write'));
});

test('a Write he refuses does not happen, and Claude is told', async (t) => {
  const { approvals, shown, of, project, say, idles } = await world(t);
  await say('!write out.txt');
  await until(() => shown.length === 1, 'the approval request');
  approvals.answer(shown[0].id, { allow: false, reason: '不要写' });
  await until(idles(1), 'the answer');
  assert.equal(existsSync(join(project, 'out.txt')), false);
  assert.match(of('reply')[0].screen, /refused/);
});

test('stop kills the process in the middle of a long tool, and the next message resumes the same session', async (t) => {
  const { of, starts, store, say, speak, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  const session = store.sessionId('proj');
  await say('!sleep 30000');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the long tool');
  const [{ pid }] = starts();
  assert.equal(alive(pid), true);
  assert.equal(await speak('stop'), '已停止。');
  await until(() => !alive(pid), 'the process to be gone', 5_000);
  assert.equal(of('idle').length, 2);
  await say('再来一次');
  await until(idles(3), 'the answer after the stop');
  assert.equal(starts().length, 2);
  assert.equal(store.sessionId('proj'), session);
  assert.equal(of('reply').at(-1).screen, 'I heard: 再来一次 (turn 3)');
});

test('a message sent while a turn is running is part of that turn: one reply for both', async (t) => {
  const { of, names, say, idles } = await world(t);
  await say('!sleep 1500');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the tool');
  await say('第二句');
  await until(idles(1), 'the answer');
  assert.deepEqual(names(), ['working', 'working', 'reply', 'idle']);
  assert.match(of('reply')[0].screen, /第二句/);
});

// The stand-in merges a message that arrives while it works (a shape not measured with the real claude); two messages that are in
// before the first turn has begun, as in the measurement of 1 Oct 2026 (claude 2.1.285), it answers as two turns.
test('two messages sent before the first turn has begun are answered as two turns, each announced and ended on its own', async (t) => {
  const { of, names, say, idles } = await world(t, { fake: { bootMs: 400 } });
  await say('一');
  await say('二');
  await until(idles(2), 'both answers');
  assert.deepEqual(names(), ['working', 'reply', 'idle', 'working', 'reply', 'idle']);
  assert.deepEqual(of('reply').map((r) => r.screen), ['I heard: 一 (turn 1)', 'I heard: 二 (turn 2)']);
});

test('/compact is answered with how much shorter the context got', async (t) => {
  const { of, speak, idles } = await world(t);
  await speak('compact');
  await until(idles(1), 'the compaction');
  assert.deepEqual(of('reply').map((r) => [r.kind, r.voice, r.turns]), [['compact', '压缩完了，上下文少了88%。', 0]]);
});

test('a login that has run out is a failure with the sentence for the screen, and the process goes on', async (t) => {
  const { of, say, idles } = await world(t);
  await say('!login');
  await until(idles(1), 'the failure');
  assert.deepEqual(of('failure'), [{ kind: 'login', message: MESSAGES.login }]);
  await say('在吗');
  await until(idles(2), 'the next answer');
  assert.equal(of('reply').length, 1);
});

test('a model claude does not know is a failure of kind model', async (t) => {
  const { of, say, idles } = await world(t);
  await say('!model');
  await until(idles(1), 'the failure');
  assert.deepEqual(of('failure'), [{ kind: 'model', message: MESSAGES.model }]);
});

test('a process that dies in the middle of a turn: he is told once, and the next message resumes', async (t) => {
  const { of, names, starts, store, say, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  const session = store.sessionId('proj');
  await say('!crash');
  await until(idles(2), 'the end of the crashed turn');
  assert.deepEqual(of('notice'), [{ kind: 'exited', text: NOTICE.exitedBusy }]);
  assert.deepEqual(names().slice(-2), ['notice', 'idle']);
  await say('还在吗');
  await until(idles(3), 'the answer after the crash');
  assert.equal(starts().length, 2);
  assert.equal(store.sessionId('proj'), session);
  assert.equal(of('reply').at(-1).screen, 'I heard: 还在吗 (turn 3)');
});

test('a permission server that refuses the token is a notice, once, and the work goes on', async (t) => {
  const { of, say, idles } = await world(t, { token: 'not-the-token' });
  await say('你好');
  await until(idles(1), 'the answer');
  await say('再说一句');
  await until(idles(2), 'the second answer');
  assert.deepEqual(of('notice'), [{ kind: 'mcp', text: NOTICE.mcp }]);
  assert.equal(of('reply').length, 2);
});

test('after the idle time the input is closed, the exit is no news, and the next message resumes', async (t) => {
  const { of, starts, store, say, idles } = await world(t, { config: { idleMinutes: 0.02 } });
  await say('你好');
  await until(idles(1), 'the first answer');
  const [{ pid }] = starts();
  await until(() => !alive(pid), 'the idle process to leave by itself', 10_000);
  assert.deepEqual(of('notice'), []);
  assert.deepEqual(of('failure'), []);
  await say('我回来了');
  await until(idles(2), 'the answer after the idle close');
  assert.equal(starts().length, 2);
  assert.equal(of('reply').at(-1).screen, 'I heard: 我回来了 (turn 2)');
  assert.ok(store.sessionId('proj'));
});

test('a session that is no longer there: he is told, and the message is answered in a new one', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('proj', SESSION);
  const { of, say, idles } = await world(t, { store });
  await say('你好');
  await until(idles(1), 'the answer in the new session');
  assert.deepEqual(of('notice'), [{ kind: 'no-session', text: MESSAGES['no-session'] }]);
  assert.equal(of('reply')[0].screen, 'I heard: 你好 (turn 1)');
  assert.notEqual(store.sessionId('proj'), SESSION);
});

test('close() ends the process that is running', async (t) => {
  const { manager, of, starts, say } = await world(t);
  await say('!sleep 30000');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the long tool');
  const [{ pid }] = starts();
  assert.equal(alive(pid), true);
  await manager.close();
  await until(() => !alive(pid), 'the process to be gone', 5_000);
});
