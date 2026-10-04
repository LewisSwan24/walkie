import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgs, spawnClaude } from '../../src/claude/process.js';
import { createPermServer } from '../../src/perm/server.js';

const FAKE = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const until = async (ok, what, ms = 8000) => {
  for (let waited = 0; !ok() && waited < ms; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ok(), what);
};

// spawnClaude on a real process (the fake claude) with real pipes; the stand-in child of process.test.js cannot show these.
async function realStart(t, { fakeConfig = {}, resume = null, command = [process.execPath, FAKE] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-proc-'));
  const server = createPermServer({ decide: async () => ({ behavior: 'allow' }) });
  const { url, token } = await server.start();
  const seen = { events: [], junk: [], exits: [] };
  const proc = spawnClaude(
    { command, args: claudeArgs({ model: 'claude-opus-5-5', mcpUrl: url, mcpToken: token, resume }), cwd: dir, env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: path.join(dir, 'state'), ...fakeConfig }) } },
    { onEvent: (e) => seen.events.push(e), onJunk: (l) => seen.junk.push(l), onExit: (i) => seen.exits.push(i) },
  );
  t.after(async () => {
    await proc.kill();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const results = () => seen.events.filter((e) => e.type === 'result');
  return { proc, server, dir, results, ...seen };
}

test('a real process: a message in, events out, and closing stdin ends it with code 0', async (t) => {
  const { proc, events, exits, results } = await realStart(t);
  assert.equal(proc.send('hello'), true);
  await until(() => results().length === 1, 'a result');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.mcp_servers[0].status, 'connected');
  assert.match(results()[0].result, /I heard: hello \(turn 1\)/);
  assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'hook_started'), 'noise arrives too; deciding what matters is not this layer\'s job');
  proc.closeInput();
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].code, 0);
  assert.equal(exits[0].signal, null);
});

test('a real process: a line of 3 MB arrives whole, and a line that is no event is told apart', async (t) => {
  const { proc, junk, results } = await realStart(t);
  proc.send('!junk');
  await until(() => results().length === 1, 'the first result');
  proc.send('!big 3000000');
  await until(() => results().length === 2, 'the second result');
  assert.deepEqual(junk, ['warning: this line is not an event']);
  assert.ok(results()[1].result.length > 3_000_000);
});

test('a real process: kill ends it in the middle of a turn, and nothing is reported after the exit', async (t) => {
  const { proc, events, exits } = await realStart(t);
  proc.send('!sleep 60000');
  await until(() => events.some((e) => e.type === 'assistant' && JSON.stringify(e).includes('"Bash"')), 'the long tool started');
  await proc.kill();
  await until(() => exits.length === 1, 'the exit');
  assert.ok(exits[0].code !== 0 || exits[0].signal !== null, 'it did not leave cleanly');
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(events.length, count);
  assert.equal(exits.length, 1);
  assert.equal(proc.send('anyone there?'), false);
});

test('a real process: asked to resume a session that is not there, it says so on both outputs and ends with code 1', async (t) => {
  const { exits, events } = await realStart(t, { resume: '11111111-2222-4333-8444-555555555555' });
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].code, 1);
  assert.match(exits[0].stderr, /No conversation found with session ID: 11111111-2222-4333-8444-555555555555/);
  const result = events.find((e) => e.type === 'result');
  assert.equal(result.subtype, 'error_during_execution');
  assert.deepEqual(result.errors, ['No conversation found with session ID: 11111111-2222-4333-8444-555555555555']);
});

test('a program that does not exist is an exit with an error, not a crash', async (t) => {
  const { proc, exits } = await realStart(t, { command: ['walkie-no-such-program-xyz'] });
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].error.code, 'ENOENT');
  assert.equal(proc.send('hello'), false);
});

test('a real process that is stopped and started again with --resume carries on in the same session', async (t) => {
  const first = await realStart(t);
  first.proc.send('one');
  await until(() => first.results().length === 1, 'the first result');
  const sessionId = first.results()[0].session_id;
  first.proc.closeInput();
  await until(() => first.exits.length === 1, 'the first exit');
  const second = await realStart(t, { resume: sessionId, fakeConfig: { stateDir: path.join(first.dir, 'state') } });
  second.proc.send('two');
  await until(() => second.results().length === 1, 'the second result');
  assert.equal(second.results()[0].session_id, sessionId);
  assert.match(second.results()[0].result, /\(turn 2\)/);
});
