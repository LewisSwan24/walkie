import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanEnv, CommandError, commandFrom, ctrlC, parseLine, projectsFor, queueFor, runSession, settingsFor, stateFor, WAIT_SECONDS } from '../../src/dev/claude.js';
import { createApprovals } from '../../src/perm/approvals.js';

// ---- parseLine

test('every command word becomes what the manager or the queue is told', () => {
  assert.deepEqual(parseLine('say 帮我跑一下测试'), { do: 'handle', message: { intent: 'to_claude', text: '帮我跑一下测试' } });
  assert.deepEqual(parseLine('  say   two   spaces inside  '), { do: 'handle', message: { intent: 'to_claude', text: 'two   spaces inside' } });
  assert.deepEqual(parseLine('say\t你好'), { do: 'handle', message: { intent: 'to_claude', text: '你好' } }, 'a tab separates like a space');
  for (const [word, intent] of [['continue', 'continue'], ['compact', 'compact'], ['new', 'new_session'], ['stop', 'stop'], ['status', 'status']]) {
    assert.deepEqual(parseLine(word), { do: 'handle', message: { intent } }, word);
  }
  assert.deepEqual(parseLine('switch walkie'), { do: 'handle', message: { intent: 'switch_project', project: 'walkie' } });
  assert.deepEqual(parseLine('yes'), { do: 'answer', allow: true, reason: '' });
  assert.deepEqual(parseLine('no'), { do: 'answer', allow: false, reason: '' });
  assert.deepEqual(parseLine('no not in that folder'), { do: 'answer', allow: false, reason: 'not in that folder' });
  assert.deepEqual(parseLine('quit'), { do: 'quit' });
});

test('wait and sleep take seconds; a wait with none gets the default', () => {
  assert.deepEqual(parseLine('wait idle'), { do: 'wait', what: 'idle', seconds: WAIT_SECONDS });
  assert.equal(WAIT_SECONDS, 120);
  assert.deepEqual(parseLine('wait approval 30'), { do: 'wait', what: 'approval', seconds: 30 });
  assert.deepEqual(parseLine('wait working 0.5'), { do: 'wait', what: 'working', seconds: 0.5 });
  assert.deepEqual(parseLine('sleep 2'), { do: 'sleep', seconds: 2 });
  assert.deepEqual(parseLine('sleep 3600'), { do: 'sleep', seconds: 3600 });
});

test('a blank line and a comment are nothing', () => {
  for (const line of ['', '   ', '\t', '# say hello', '   # wait idle']) assert.equal(parseLine(line), null, JSON.stringify(line));
});

test('a line that is not a command is an error naming it, never a guess', () => {
  const bad = (line, pattern) => assert.throws(() => parseLine(line), (err) => err instanceof CommandError && pattern.test(err.message), line);
  bad('say', /say needs the words to say/);
  bad('say   ', /say needs the words to say/);
  bad('switch', /switch needs a project name/);
  bad('wait', /wait is followed by idle, working, approval/);
  bad('wait soon', /wait is followed by idle, working, approval/);
  bad('wait idle 5 6', /wait is followed by idle, working, approval/);
  bad('wait idle 0', /wait needs a number of seconds/);
  bad('wait idle -3', /wait needs a number of seconds/);
  bad('wait idle soon', /wait needs a number of seconds/);
  bad('wait idle 3601', /at most 3600/);
  bad('sleep', /sleep needs a number of seconds/);
  bad('sleep 0', /sleep needs a number of seconds/);
  bad('sleep Infinity', /sleep needs a number of seconds/);
  bad('sleep 3601', /sleep needs a number of seconds/);
  bad('sy hello', /unknown command "sy" \(continue, compact, new, stop, status, say, switch, yes, no, wait, sleep, quit\)/);
  bad('Say hello', /unknown command "Say"/);
});

test('a word that Object.prototype also has is unknown, not a command', () => {
  for (const word of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => parseLine(word), (err) => err instanceof CommandError && err.message.startsWith(`unknown command "${word}"`), word);
  }
});

// ---- runSession, with a manager that is only an emitter and the real approvals queue

function stage({ timeoutMs = 10_000 } = {}) {
  const manager = new EventEmitter();
  manager.started = 0;
  manager.handled = [];
  manager.start = () => {
    manager.started += 1;
  };
  manager.handle = async (message) => {
    manager.handled.push(message);
    return manager.answer(message);
  };
  manager.answer = () => ({});
  const approvals = createApprovals({ timeoutMs });
  const printed = [];
  const print = (text) => printed.push(text);
  return { manager, approvals, printed, print };
}

async function* script(...lines) {
  yield* lines;
}

test('a script is run line by line against the manager, which is started first', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = (message) => (message.intent === 'status' ? { speak: '空闲。' } : {});
  const done = await runSession({ manager, approvals, print, lines: script('# a comment', '', 'say 你好', 'continue', 'status', 'quit', 'say never') });
  assert.equal(done, true);
  assert.equal(manager.started, 1);
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: '你好' }, { intent: 'continue' }, { intent: 'status' }]);
  assert.deepEqual(printed, ['[says] 空闲。']);
});

test('the manager is started before the first line is read', async () => {
  const { manager, approvals, print } = stage();
  let startedWhenRead = null;
  async function* lines() {
    startedWhenRead = manager.started;
    yield 'quit';
  }
  await runSession({ manager, approvals, print, lines: lines() });
  assert.equal(startedWhenRead, 1);
});

test('what the manager reports is printed the way a person reads it', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    manager.emit('working', { tool: 'Bash', summary: 'npm test' });
    manager.emit('working', { tool: 'Read' });
    manager.emit('reply', { kind: 'reply', voice: '好了。', screen: 'line one\nline two', tagged: true, turns: 3, ms: 12_345, costUsd: 0.0264 });
    manager.emit('reply', { kind: 'compact', voice: '压缩完了。', screen: '压缩完了。', tagged: false, turns: 0, ms: 16_000, costUsd: 0 });
    manager.emit('reply', { kind: 'reply', voice: '随便。', screen: '随便。', tagged: false, turns: 1, ms: 900, costUsd: 0.5 });
    manager.emit('notice', { kind: 'new_session', text: '新会话' });
    manager.emit('failure', { kind: 'login', message: '登录过期了' });
    manager.emit('project', { name: 'walkie' });
    manager.emit('idle', { project: 'walkie' });
    return {};
  };
  await runSession({ manager, approvals, print, lines: script('say hi') });
  assert.deepEqual(printed, [
    '[working] thinking',
    '[working] Bash: npm test',
    '[working] Read',
    '[reply] reply, turn 3, 12.3 s, $0.026\n  voice: 好了。\n  screen:\n    line one\n    line two',
    '[reply] compact, 16.0 s, $0.000, no <voice> tag\n  voice: 压缩完了。\n  screen:\n    压缩完了。',
    '[reply] reply, turn 1, 0.9 s, $0.500, no <voice> tag\n  voice: 随便。\n  screen:\n    随便。',
    '[notice] new_session: 新会话',
    '[failure] login: 登录过期了',
    '[project] walkie',
    '[idle]',
  ]);
});

test('an approval is shown with its preview, answered with yes or no, and its outcome printed', async () => {
  const { manager, approvals, print, printed } = stage();
  let first;
  let second;
  setTimeout(() => {
    first = approvals.request({ tool: 'Write', input: { file_path: 'C:\\w\\note.txt', content: 'walkie' }, toolUseId: 'toolu_1' });
    second = approvals.request({ tool: 'Bash', input: { command: 'npm test' }, toolUseId: 'toolu_2' });
  }, 20);
  const done = await runSession({ manager, approvals, print, lines: script('wait approval 5', 'yes', 'no too risky', 'quit') });
  assert.equal(done, true);
  const verdicts = await Promise.all([first, second]);
  assert.deepEqual(verdicts.map((v) => v.behavior), ['allow', 'deny']);
  assert.match(verdicts[1].message, /too risky/);
  assert.equal(printed.length, 4, printed.join('\n'));
  const [shown1, cleared1, shown2, cleared2] = printed;
  const id1 = /^\[approval\] #(\d+) Write\n {4}\S/.exec(shown1)?.[1];
  const id2 = /^\[approval\] #(\d+) Bash\n {4}\S/.exec(shown2)?.[1];
  assert.ok(id1 && id2 && id1 !== id2, `${shown1}\n${shown2}`);
  assert.ok(shown1.endsWith('\n  answer: yes | no [reason]'), shown1);
  assert.ok(shown2.endsWith('\n  answer: yes | no [reason]'), shown2);
  assert.equal(cleared1, `[approval] #${id1} allowed`);
  assert.equal(cleared2, `[approval] #${id2} denied`);
});

test('yes or no with nothing on the screen says so and goes on', async () => {
  const { manager, approvals, print, printed } = stage();
  const done = await runSession({ manager, approvals, print, lines: script('yes', 'no', 'say after') });
  assert.equal(done, true);
  assert.deepEqual(printed, ['[approval] nothing is waiting', '[approval] nothing is waiting']);
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: 'after' }]);
});

test('wait idle goes on at once when nothing is running, and waits for the idle event while a turn is', async () => {
  const { manager, approvals, print } = stage();
  const order = [];
  manager.answer = (message) => {
    if (message.text === 'slow') {
      manager.emit('working', {});
      setTimeout(() => {
        order.push('idle');
        manager.emit('idle', {});
      }, 40);
    }
    return {};
  };
  async function* lines() {
    yield 'wait idle 5'; // nothing is running yet
    yield 'say slow';
    yield 'wait idle 5';
    order.push('after the wait');
  }
  const done = await runSession({ manager, approvals, print, lines: lines() });
  assert.equal(done, true);
  assert.deepEqual(order, ['idle', 'after the wait']);
});

test('wait working goes on when the next turn starts, wait approval when one is on the screen', async () => {
  const { manager, approvals, print, printed } = stage();
  setTimeout(() => manager.emit('working', {}), 30);
  setTimeout(() => approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'x' }, toolUseId: 'toolu_9' }), 60);
  const done = await runSession({ manager, approvals, print, lines: script('wait working 5', 'wait approval 5', 'no', 'quit') });
  assert.equal(done, true);
  assert.equal(printed[0], '[working] thinking');
  assert.match(printed[1], /^\[approval\] #\d+ Write/);
  assert.match(printed[2], /^\[approval\] #\d+ denied$/);
});

test('wait working and wait approval go on at once when it is already so', async () => {
  const { manager, approvals, print } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'x' }, toolUseId: 'toolu_9' });
  // the 0.05 s is the whole wait: a script that had to wait for something new would run out
  const done = await runSession({ manager, approvals, print, lines: script('wait approval 0.05', 'say go', 'wait working 0.05', 'no', 'quit') });
  assert.equal(done, true);
});

test('wait idle does not go on while a turn is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say go', 'wait idle 0.05', 'quit') }), false);
  assert.deepEqual(printed, ['[working] thinking', '[wait] idle did not happen in 0.05 s']);
});

test('a wait that runs out says what did not happen and ends the run without reading on', async () => {
  const { manager, approvals, print, printed } = stage();
  const done = await runSession({ manager, approvals, print, lines: script('wait working 0.05', 'say never') });
  assert.equal(done, false);
  assert.deepEqual(printed, ['[wait] working did not happen in 0.05 s']);
  assert.deepEqual(manager.handled, []);
});

test('the end of the input waits for the turn that is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    setTimeout(() => manager.emit('idle', {}), 40);
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say slow') }), true);
  assert.deepEqual(printed, ['[working] thinking', '[idle]']);
});

test('a turn that never ends fails the run, after the 120 s the end of the input waits', async (t) => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  const waits = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    waits.push(ms);
    return real(fn, ms >= WAIT_SECONDS * 1000 ? 30 : ms, ...rest); // the 120 s, shortened to get on with it
  });
  assert.equal(await runSession({ manager, approvals, print, lines: script('say stuck') }), false);
  assert.ok(waits.includes(WAIT_SECONDS * 1000), `a wait of ${WAIT_SECONDS} s was set: ${waits}`);
  assert.deepEqual(printed, ['[working] thinking', `[wait] idle did not happen in ${WAIT_SECONDS} s`]);
});

test('a wait runs out when its seconds are over, not before and not after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  let result;
  const run = runSession({ manager, approvals, print, lines: script('say go', 'wait idle 5') }).then((done) => (result = done));
  const settle = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate is not mocked: what is waiting on promises has run
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(result, undefined, 'it is still waiting after 4.999 s');
  t.mock.timers.tick(1);
  await run;
  assert.equal(result, false);
  assert.deepEqual(printed, ['[working] thinking', '[wait] idle did not happen in 5 s']);
});

test('quit ends the run at once, without waiting for the turn that is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say go', 'quit') }), true);
  assert.deepEqual(printed, ['[working] thinking']);
});

test('sleep waits through the injected clock for as long as it was told', async () => {
  const { manager, approvals, print } = stage();
  const slept = [];
  const done = await runSession({ manager, approvals, print, sleep: async (ms) => slept.push(ms), lines: script('sleep 2', 'sleep 0.25') });
  assert.equal(done, true);
  assert.deepEqual(slept, [2000, 250]);
});

test('a line that is not a command stops the script after the lines before it have run', async () => {
  const { manager, approvals, print } = stage();
  await assert.rejects(runSession({ manager, approvals, print, lines: script('say one', 'sya two', 'say three') }), (err) => err instanceof CommandError && /unknown command "sya"/.test(err.message));
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: 'one' }]);
});

test('Ctrl+C ends a wait and the run, and prints no complaint about it', async () => {
  const { manager, approvals, print, printed } = stage();
  const ctrlC = new AbortController();
  setTimeout(() => ctrlC.abort(), 30);
  const done = await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('wait working 60', 'say never') });
  assert.equal(done, false);
  assert.deepEqual(printed, []);
  assert.deepEqual(manager.handled, []);
});

test('a signal that is aborted before the first line is read ends the run at once', async () => {
  const { manager, approvals, print } = stage();
  const ctrlC = new AbortController();
  ctrlC.abort();
  assert.equal(await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('say never') }), false);
  assert.deepEqual(manager.handled, []);
});

test('a signal aborted at the end of the input ends the wait for idle without a complaint', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  const ctrlC = new AbortController();
  setTimeout(() => ctrlC.abort(), 30);
  assert.equal(await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('say stuck') }), false);
  assert.deepEqual(printed, ['[working] thinking']);
});

test('Ctrl+C while the last command runs ends the run at once, not after the 120 s the end of the input waits', async () => {
  const { manager, approvals, print, printed } = stage();
  const abort = new AbortController();
  manager.answer = () => {
    manager.emit('working', {});
    abort.abort();
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, signal: abort.signal, lines: script('say last') }), false);
  assert.deepEqual(printed, ['[working] thinking']);
});

// ---- the pieces around it

test('ctrlC turns the first SIGINT into an aborted signal and closes the input; a second one is left alone', () => {
  const emitter = new EventEmitter();
  let closed = 0;
  const signal = ctrlC(emitter, { close: () => (closed += 1) });
  assert.equal(signal.aborted, false);
  assert.equal(closed, 0);
  emitter.emit('SIGINT');
  assert.equal(signal.aborted, true);
  assert.equal(closed, 1);
  assert.equal(emitter.listenerCount('SIGINT'), 0, 'with no listener left a second Ctrl+C ends the process, if shutting down hangs');
});

test('stateFor: a developer run starts in the project it was given, and its state is its own, in memory', () => {
  const store = stateFor('ontheBeat');
  assert.equal(store.project(), 'ontheBeat');
  store.setSession('ontheBeat', '6a1f4c2e-0d3b-4c5a-8f7e-123456789abc');
  assert.equal(store.sessionId('ontheBeat'), '6a1f4c2e-0d3b-4c5a-8f7e-123456789abc');
  assert.equal(stateFor('walkie').project(), 'walkie');
  assert.equal(stateFor('walkie').sessionId('ontheBeat'), null, 'nothing of it reaches another run');
});

test('settingsFor: the claude section of the config, with the program replaced by --command', () => {
  const config = { claude: { command: ['claude'], model: 'm', approvalTimeoutSec: 55 }, voice: 'marin' };
  assert.deepEqual(settingsFor(config, {}), { command: ['claude'], model: 'm', approvalTimeoutSec: 55 });
  assert.deepEqual(settingsFor(config, { command: '["node","fake.js"]' }), { command: ['node', 'fake.js'], model: 'm', approvalTimeoutSec: 55 });
  assert.throws(() => settingsFor(config, { command: 'node fake.js' }), /--command is the program/);
  assert.deepEqual(config.claude.command, ['claude'], 'the config itself is not changed');
});

test('queueFor: a request nobody answers is denied after approvalTimeoutSec, counted in seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const approvals = queueFor({ approvalTimeoutSec: 2 });
  const outcomes = [];
  approvals.on('clear', (c) => outcomes.push(c.outcome));
  const verdict = approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'b' }, toolUseId: 'toolu_1' });
  t.mock.timers.tick(1999);
  assert.deepEqual(outcomes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(outcomes, ['timeout']);
  assert.equal((await verdict).behavior, 'deny');
});

test('cleanEnv takes out what points a nested claude at the Claude app, and nothing else', () => {
  const env = { PATH: 'p', HOME: 'h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', claude_lower: 'y', ANTHROPIC_API_KEY: 'k', Anthropic_Base: 'b', MY_CLAUDE: 'keep', NOT_ANTHROPIC: 'keep' };
  assert.deepEqual(cleanEnv(env), { PATH: 'p', HOME: 'h', MY_CLAUDE: 'keep', NOT_ANTHROPIC: 'keep' });
  assert.equal(env.CLAUDECODE, '1', 'the original is not changed');
});

test('--command is a JSON array of non-empty strings, otherwise an error that shows the form', () => {
  assert.deepEqual(commandFrom('["node","fake-claude.js"]'), ['node', 'fake-claude.js']);
  assert.deepEqual(commandFrom('["claude"]'), ['claude']);
  for (const text of ['node fake.js', '[]', '{"a":1}', '["node",3]', '["node",""]', '"node"', 'null', '[', '']) {
    assert.throws(() => commandFrom(text), /--command is the program and its leading arguments as a JSON array of strings/, JSON.stringify(text));
  }
});

test('projectsFor: one folder, called dev, is the default; --cwd names another', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(projectsFor({}, { cwd: dir }), { projects: [{ name: 'dev', aliases: [], path: dir }], active: 'dev' });
  assert.deepEqual(projectsFor({ cwd: dir }, { cwd: 'C:\\somewhere\\else' }), { projects: [{ name: 'dev', aliases: [], path: dir }], active: 'dev' });
  assert.equal(projectsFor({ cwd: '.' }).projects[0].path, process.cwd(), 'a relative folder is made absolute: claude is started in it from another folder');
  assert.throws(() => projectsFor({ cwd: path.join(dir, 'nope') }, { cwd: dir }), /--cwd .*nope: not a folder/);
  const file = path.join(dir, 'a-file.txt');
  writeFileSync(file, 'x');
  assert.throws(() => projectsFor({ cwd: file }, { cwd: dir }), /a-file\.txt: not a folder/);
});

test('projectsFor: --project uses projects.json and must name one of its projects; it cannot be mixed with --cwd', () => {
  const projects = [{ name: 'walkie', aliases: ['沃奇'], path: 'C:\\w' }, { name: 'ontheBeat', aliases: [], path: 'C:\\b' }];
  assert.deepEqual(projectsFor({ project: 'ontheBeat' }, { load: () => projects }), { projects, active: 'ontheBeat' });
  assert.throws(() => projectsFor({ project: 'nope' }, { load: () => projects }), /--project nope: not in projects\.json \(walkie, ontheBeat\)/);
  assert.throws(() => projectsFor({ project: 'walkie', cwd: 'C:\\w' }, { load: () => projects }), /--cwd and --project cannot be used together/);
});
