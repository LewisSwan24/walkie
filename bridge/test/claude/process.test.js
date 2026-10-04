import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { claudeArgs, DRAIN_MS, killTree, PERMISSION_TOOL, spawnClaude, STDERR_TAIL } from '../../src/claude/process.js';
import { userLine } from '../../src/claude/stream.js';
import { VOICE_RULES } from '../../src/claude/voice.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const until = async (ok, what, ms = 8000) => {
  for (let waited = 0; !ok() && waited < ms; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ok(), what);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- the command line

const ARGS = { model: 'claude-opus-5-5', mcpUrl: 'http://127.0.0.1:5123/mcp', mcpToken: 'abc123' };

test('the arguments are the ones in spec 6.4, and the MCP config is one JSON argument', () => {
  assert.deepEqual(claudeArgs(ARGS), [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-opus-5-5',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{"walkie":{"type":"http","url":"http://127.0.0.1:5123/mcp","headers":{"Authorization":"Bearer abc123"}}}}',
    '--permission-prompt-tool', 'mcp__walkie__approve',
    '--append-system-prompt', VOICE_RULES,
  ]);
  assert.equal(PERMISSION_TOOL, 'mcp__walkie__approve');
});

test('a session to resume is added at the end and changes nothing else; none, null or an empty id adds nothing', () => {
  const plain = claudeArgs(ARGS);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: 'abc-123' }), [...plain, '--resume', 'abc-123']);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: null }), plain);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: '' }), plain);
});

test('nothing is quoted for a shell: a value with spaces and quotes stays one argument, and JSON escapes it', () => {
  const args = claudeArgs({ model: 'a b "c"', mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 'to"ken with space' });
  assert.equal(args[args.indexOf('--model') + 1], 'a b "c"');
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers.walkie.headers.Authorization, 'Bearer to"ken with space');
});

// ---- ending a process and what it started

test('on Windows the whole tree is ended with taskkill, and the call waits for taskkill to finish', { timeout: 3000 }, async () => {
  const calls = [];
  const killer = new EventEmitter();
  let finished = false;
  const done = killTree(4242, { platform: 'win32', spawn: (...call) => (calls.push(call), killer) }).then(() => (finished = true));
  await settle();
  assert.deepEqual(calls, [['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]]);
  assert.equal(finished, false);
  killer.emit('exit', 0, null);
  await done;
  assert.equal(finished, true);
});

test('if taskkill cannot be started the call still ends', { timeout: 3000 }, async () => {
  const killer = new EventEmitter();
  const done = killTree(4242, { platform: 'win32', spawn: () => killer });
  killer.emit('error', new Error('spawn taskkill ENOENT'));
  await done;
});

test('a pid that is not a positive whole number starts nothing and ends at once', async () => {
  const never = () => assert.fail('taskkill must not be started');
  for (const pid of [undefined, null, 0, -5, 1.5, '12', Number.NaN]) await killTree(pid, { platform: 'win32', spawn: never });
});

test('elsewhere the one process is killed for good (SIGKILL: it cannot ignore that), and a pid that is already gone is no error', { timeout: 8000 }, async () => {
  const child = realSpawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try {
    await killTree(child.pid, { platform: 'linux' });
    await gone;
    assert.equal(alive(child.pid), false);
  } finally {
    child.kill();
  }
  await killTree(2147483646, { platform: 'linux' });
});

test('on Windows a grandchild dies with the process that started it', { skip: process.platform !== 'win32' }, async (t) => {
  const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
  const parent = realSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let grandchild = 0;
  t.after(() => {
    parent.kill();
    if (grandchild) {
      try {
        process.kill(grandchild);
      } catch {
        // already gone
      }
    }
  });
  let printed = '';
  parent.stdout.on('data', (chunk) => (printed += chunk));
  await until(() => printed.includes('\n'), 'the child printed its own child');
  grandchild = Number(printed);
  assert.equal(alive(grandchild), true);
  await killTree(parent.pid);
  await until(() => !alive(grandchild), 'the grandchild is gone');
  await until(() => !alive(parent.pid), 'the parent is gone');
});

// ---- one process, with a stand-in for what child_process gives back

function start(overrides = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.endCalls = 0;
  child.stdin = new Writable({ write(chunk, _encoding, done) { child.written.push(chunk.toString('utf8')); done(); } });
  const end = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...rest) => (child.endCalls++, end(...rest));
  const spawned = [];
  const seen = { events: [], junk: [], exits: [], order: [] };
  const killed = [];
  const proc = spawnClaude(
    { command: ['claude'], args: ['-p'], cwd: 'C:\\proj', env: { A: '1' }, ...overrides },
    {
      onEvent: (event) => (seen.events.push(event), seen.order.push(['event', event])),
      onJunk: (line) => (seen.junk.push(line), seen.order.push(['junk', line])),
      onExit: (info) => (seen.exits.push(info), seen.order.push(['exit'])),
    },
    { spawn: (program, args, options) => (spawned.push({ program, args, options }), child), kill: (pid) => (killed.push(pid), Promise.resolve()) },
  );
  return { child, proc, spawned, killed, ...seen };
}

test('the program and its leading arguments come from `command`, then the arguments, with the folder, the environment and three pipes', () => {
  const { spawned } = start({ command: ['node', 'C:\\x\\fake.js'], args: ['-p', '--verbose'] });
  assert.deepEqual(spawned, [{ program: 'node', args: ['C:\\x\\fake.js', '-p', '--verbose'], options: { cwd: 'C:\\proj', env: { A: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true } }]);
});

test('each line of stdout is one event, however the bytes are cut', async () => {
  const { child, events } = start();
  child.stdout.write('{"type":"sys');
  child.stdout.write('tem","n":1}\n{"type":"result","n":2}\n{"type":');
  child.stdout.write('"x"}\n\n');
  await settle();
  assert.deepEqual(events, [{ type: 'system', n: 1 }, { type: 'result', n: 2 }, { type: 'x' }]);
});

test('a character cut in two between chunks arrives whole', async () => {
  const { child, events } = start();
  const bytes = Buffer.from('{"t":"你好"}\n', 'utf8');
  child.stdout.write(bytes.subarray(0, 8)); // inside the first character
  child.stdout.write(bytes.subarray(8));
  await settle();
  assert.deepEqual(events, [{ t: '你好' }]);
});

test('a line that is not a JSON object is junk and never an event', async () => {
  const { child, events, junk } = start();
  child.stdout.write('warning: something\n[1,2]\nnull\n42\n"text"\n{"type":"ok"}\n');
  await settle();
  assert.deepEqual(events, [{ type: 'ok' }]);
  assert.deepEqual(junk, ['warning: something', '[1,2]', 'null', '42', '"text"']);
});

test('stderr is kept, its last 4000 characters, and handed over at the exit', async () => {
  const { child, proc, exits } = start();
  child.stderr.write('a'.repeat(3000));
  child.stderr.write('b'.repeat(3000));
  await settle();
  assert.equal(STDERR_TAIL, 4000);
  assert.equal(proc.stderrTail(), 'a'.repeat(1000) + 'b'.repeat(3000));
  child.emit('close', 1, null);
  assert.equal(exits[0].stderr, 'a'.repeat(1000) + 'b'.repeat(3000));
});

test('the exit is reported once, with its code and stderr, after the last event, even a last line with no newline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, order, exits } = start();
  child.stdout.write('{"n":1}\n{"n":2}');
  child.stderr.write('boom\n');
  await settle();
  child.emit('exit', 3, null);
  child.emit('close', 3, null);
  t.mock.timers.tick(DRAIN_MS * 5);
  assert.deepEqual(order, [['event', { n: 1 }], ['event', { n: 2 }], ['exit']]);
  assert.deepEqual(exits, [{ code: 3, signal: null, stderr: 'boom\n' }]);
});

test('a process that has exited but whose pipes stay open is reported after a short wait, with what still came out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, order, exits } = start();
  child.emit('exit', 1, null);
  await settle();
  child.stdout.write('{"late":true}\n');
  await settle();
  t.mock.timers.tick(DRAIN_MS - 1);
  assert.equal(exits.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(order, [['event', { late: true }], ['exit']]);
  assert.deepEqual(exits, [{ code: 1, signal: null, stderr: '' }]);
  child.emit('close', 1, null);
  assert.equal(exits.length, 1);
});

test('a close that follows the exit does not wait for the pause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, exits } = start();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(exits.length, 1);
});

test('a signal that ended the process is reported', () => {
  const { child, exits } = start();
  child.emit('close', null, 'SIGKILL');
  assert.deepEqual(exits, [{ code: null, signal: 'SIGKILL', stderr: '' }]);
});

test('a program that cannot start is reported as an error, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, exits, proc } = start();
  const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  child.emit('error', error);
  child.emit('close', -4058, null);
  t.mock.timers.tick(DRAIN_MS * 5);
  assert.deepEqual(exits, [{ code: null, signal: null, error, stderr: '' }]);
  assert.equal(proc.send('hello'), false);
});

test('send writes the user message as one stream-json line; closeInput ends stdin once, and after it nothing is written', async () => {
  const { child, proc } = start();
  assert.equal(proc.send('你好'), true);
  assert.equal(proc.send('second'), true);
  await settle();
  assert.deepEqual(child.written, [userLine('你好'), userLine('second')]);
  proc.closeInput();
  proc.closeInput();
  assert.equal(child.endCalls, 1);
  assert.equal(proc.send('too late'), false);
  await settle();
  assert.equal(child.written.length, 2);
});

test('nothing is written to a process that has ended, and its stdin is not closed again', () => {
  const { child, proc } = start();
  child.emit('close', 0, null);
  assert.equal(proc.send('hello'), false);
  proc.closeInput();
  assert.deepEqual(child.written, []);
  assert.equal(child.endCalls, 0);
});

test('a character cut in two between chunks of stderr is kept whole', async () => {
  const { child, proc } = start();
  const bytes = Buffer.from('错误：坏了', 'utf8');
  child.stderr.write(bytes.subarray(0, 4)); // inside the second character
  child.stderr.write(bytes.subarray(4));
  await settle();
  assert.equal(proc.stderrTail(), '错误：坏了');
});

test('a broken pipe on stdin throws nothing, and sends after it say no', async () => {
  const { child, proc } = start();
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(proc.send('hello'), false);
  proc.closeInput();
  assert.equal(child.endCalls, 0);
});

test('kill ends the tree of this pid, and the pid is the child\'s', async () => {
  const { proc, killed } = start();
  assert.equal(proc.pid, 4242);
  await proc.kill();
  assert.deepEqual(killed, [4242]);
});
