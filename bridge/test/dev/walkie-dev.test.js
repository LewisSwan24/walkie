import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../../src/audio/wav.js';

const BIN = fileURLToPath(new URL('../../bin/walkie-dev.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../claude/fake-claude.js', import.meta.url));
const EXIT_PRELOAD = new URL('./exit-preload.mjs', import.meta.url).href; // --import takes a URL, not a Windows path

// The real bin with no keys anywhere, and a command that never opens the S3: nothing it is asked to do can reach a provider.
const walkieDev = (...args) => walkieDevWith({}, ...args);

// `nodeArgs` go to node in front of the bin, `env` over the environment it is given, `input` to its stdin. `files` is what the
// run left in its %APPDATA% (an empty folder that is thrown away afterwards).
function walkieDevWith({ nodeArgs = [], env = {}, input }, ...args) {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  try {
    const run = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      input,
      env: { ...process.env, APPDATA: appdata, OPENAI_API_KEY: '', GEMINI_API_KEY: '', ...env },
    });
    return { status: run.status, out: run.stdout, err: run.stderr, files: readdirSync(appdata, { recursive: true }) };
  } finally {
    rmSync(appdata, { recursive: true, force: true });
  }
}

test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap', 'inject', 'selftest']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});

test('a flag with no value stops the command with exit 2 before any key is loaded', () => {
  const run = walkieDev('classify', 'hello', '--provider');
  assert.equal(run.status, 2);
  assert.match(run.err, /--provider needs a value/);
  assert.ok(!run.out.includes('[keys]'), 'it never got as far as the keys');
});

test('a misspelled option stops the command with exit 2 before any key is loaded', () => {
  const run = walkieDev('classify', 'hello', '--provder', 'openai');
  assert.equal(run.status, 2);
  assert.match(run.err, /unknown option --provder/);
  assert.ok(!run.out.includes('[keys]'), 'it never got as far as the keys');
});

test('--provider=openai is read as --provider openai, not as auto', () => {
  const run = walkieDev('classify', 'hello', '--provider=openai');
  assert.equal(run.status, 1);
  assert.match(run.err, /--provider openai: its API key is not set/);
});

test('--all still reaches classify', () => {
  const run = walkieDev('classify', '--all', '--provider', 'openai');
  assert.equal(run.status, 1);
  assert.match(run.err, /--provider openai: its API key is not set/);
});

// hear, say and classify call the providers. On Node 24 for Windows, process.exit() just after a fetch can trip a libuv
// assertion ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", exit code 127, printed after the right output), seen on a
// clip that came back unclear. They end when the loop empties instead. A stub answers every fetch and reports process.exit().
for (const name of ['hear', 'say', 'classify']) {
  test(`${name} ends by itself: it does not call process.exit() straight after a fetch`, (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'walkie-exit-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const wav = path.join(dir, 'take.wav');
    writeFileSync(wav, encodeWav(Buffer.alloc(16000 * 2 * 2), 16000)); // two seconds of silence: the stub does not listen
    const args = {
      hear: ['hear', wav],
      say: ['say', 'hello there', '--out', path.join(dir, 'say.wav')],
      classify: ['classify', 'hello'],
    }[name];
    const run = walkieDevWith({ nodeArgs: ['--import', EXIT_PRELOAD], env: { OPENAI_API_KEY: 'sk-test' } }, ...args, '--provider', 'openai');
    assert.equal(run.status, 0, run.err);
    assert.ok(!run.err.includes('process.exit() was called'), `${name} called process.exit()`);
  });
}

// ---- claude: the session manager from a terminal, run against the stand-in for claude (test/claude/fake-claude.js)

// A project folder and the stand-in's settings; the stand-in writes a line to `starts` for every process it is.
function claudeWorld(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-devclaude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const project = path.join(dir, 'proj');
  mkdirSync(project);
  const argsFile = path.join(dir, 'starts.jsonl');
  const fake = JSON.stringify({ bootMs: 0, turnMs: 0, stateDir: path.join(dir, 'sessions'), argsFile });
  const argv = (extra = []) => ['claude', '--cwd', project, '--command', JSON.stringify([process.execPath, FAKE_CLAUDE]), ...extra];
  return {
    project,
    argv,
    env: { FAKE_CLAUDE: fake },
    run: (script, { extra = [], env = {}, nodeArgs = [] } = {}) => walkieDevWith({ input: script, nodeArgs, env: { FAKE_CLAUDE: fake, ...env } }, ...argv(extra)),
    starts: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

// The permission server's token, as the stand-in was given it on its command line.
function tokenOf(start) {
  const config = JSON.parse(start.argv[start.argv.indexOf('--mcp-config') + 1]);
  return config.mcpServers.walkie.headers.Authorization.replace(/^Bearer /, '');
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('claude: a script on stdin is run against the stand-in, and what happens is printed', (t) => {
  const { run, project, starts } = claudeWorld(t);
  const result = run('# the first words\nsay 你好\nwait idle 20\nquit\n');
  assert.equal(result.status, 0, result.err);
  const [first] = result.out.split('\n');
  assert.ok(first.startsWith(`[claude] ${project}, starting in dev; permission server on http://127.0.0.1:`), first);
  assert.match(first, /:\d+\/mcp$/);
  assert.match(result.out, /\[working\] thinking\n/);
  assert.match(result.out, /\[reply\] reply, turn 1, [\d.]+ s, \$0\.012\n {2}voice: I heard: 你好\n {2}screen:\n {4}I heard: 你好 \(turn 1\)\n/);
  assert.match(result.out, /\[idle\]\n$/);
  const token = tokenOf(starts()[0]);
  assert.ok(token.length >= 16, 'the stand-in was given a token');
  assert.ok(!(result.out + result.err).includes(token), "the permission server's token is never printed");
  assert.deepEqual(result.files, [], "a developer run keeps no session ids: nothing of it is written to the bridge's own folder");
});

test('claude: the end of the input waits for the turn that is running, then ends', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say 你好\n');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /voice: I heard: 你好/);
  assert.match(result.out, /\[idle\]\n$/);
});

test('claude: a Write is asked for on the screen, and yes lets it through, no keeps it out', (t) => {
  const { run, project } = claudeWorld(t);
  const yes = run('say !write note.txt\nwait approval 20\nyes\nwait idle 20\nquit\n');
  assert.equal(yes.status, 0, yes.err);
  assert.match(yes.out, /\[approval\] #(\d+) Write\n[\s\S]*?\n {2}answer: yes \| no \[reason\]\n[\s\S]*?\[approval\] #\1 allowed\n/);
  assert.match(yes.out, /voice: I made note\.txt\./);
  assert.equal(readFileSync(path.join(project, 'note.txt'), 'utf8'), 'walkie');

  rmSync(path.join(project, 'note.txt'));
  const no = run('say !write note.txt\nwait approval 20\nno 先别写\nwait idle 20\nquit\n');
  assert.equal(no.status, 0, no.err);
  assert.match(no.out, /\[approval\] #(\d+) denied\n/);
  assert.match(no.out, /voice: You refused it, so note\.txt was not made\./);
  assert.ok(!existsSync(path.join(project, 'note.txt')), 'a refused Write wrote nothing');
});

test('claude: --clean-env takes the CLAUDE* and ANTHROPIC* variables out of what claude is given', (t) => {
  const { run, starts } = claudeWorld(t);
  const env = { CLAUDE_WALKIE_MARK: '1', ANTHROPIC_WALKIE_MARK: '1' };
  const marks = (record) => record.claudeVars.filter((name) => name.endsWith('_WALKIE_MARK'));
  assert.equal(run('say hi\nwait idle 20\nquit\n', { env }).status, 0);
  assert.deepEqual(marks(starts()[0]), ['ANTHROPIC_WALKIE_MARK', 'CLAUDE_WALKIE_MARK'], 'without the switch claude is given them');
  // FAKE_CLAUDE, which the stand-in cannot start without, is neither CLAUDE* nor ANTHROPIC*: it gets through
  assert.equal(run('say hi\nwait idle 20\nquit\n', { env, extra: ['--clean-env'] }).status, 0);
  assert.equal(starts().length, 2);
  assert.deepEqual(marks(starts()[1]), [], 'with it, it is not');
});

test('claude: a wait that runs out ends the run with exit 1 and leaves no claude behind', (t) => {
  const { run, starts } = claudeWorld(t);
  const result = run('say !sleep 8000\nwait idle 0.5\nsay never\n');
  assert.equal(result.status, 1, result.err);
  assert.match(result.out, /\[wait\] idle did not happen in 0\.5 s\n/);
  assert.ok(!result.out.includes('never'), 'the script was not read on');
  const [{ pid }] = starts();
  assert.ok(!alive(pid), 'the process of the turn that was still running was killed');
});

test('claude: a line that is not a command ends the run with exit 2, after the lines before it have run', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say first\nwait idle 20\nsya second\nsay third\n');
  assert.equal(result.status, 2, result.err);
  assert.match(result.err, /walkie-dev claude: unknown command "sya"/);
  assert.match(result.out, /voice: I heard: first/);
  assert.ok(!result.out.includes('third'));
});

test('claude: what cannot be used is refused before anything is started', (t) => {
  const { project, starts, env } = claudeWorld(t);
  const standIn = ['--command', JSON.stringify([process.execPath, FAKE_CLAUDE])]; // whatever goes wrong, it is never the real claude
  const refused = (args, pattern) => {
    const result = walkieDevWith({ input: 'say never\n', env }, 'claude', ...args);
    assert.equal(result.status, 1, result.err);
    assert.match(result.err, pattern);
    assert.ok(!result.out.includes('[claude]'), result.out);
  };
  refused(['--cwd', project, '--project', 'walkie', ...standIn], /--cwd and --project cannot be used together/);
  refused(['--cwd', path.join(project, 'nope'), ...standIn], /nope: not a folder/);
  refused(['--cwd', project, ...standIn, 'extra'], /the commands are read from stdin/);
  refused(['--project', 'no-such-project', ...standIn], /--project no-such-project: not in projects\.json/);
  refused(['--cwd', project, '--command', 'node fake.js'], /--command is the program and its leading arguments as a JSON array of strings/);
  assert.deepEqual(starts(), []);
});

test('claude: quit with an approval still on the screen denies it, and nothing is written', (t) => {
  const { run, project } = claudeWorld(t);
  const result = run('say !write note.txt\nwait approval 20\nquit\n');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /\[approval\] #(\d+) Write[\s\S]*\[approval\] #\1 denied\n/);
  assert.ok(!existsSync(path.join(project, 'note.txt')), 'the Write that was waiting for his answer did not happen');
});

test('claude ends by itself: it does not call process.exit() after closing its server and killing claude', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say hi\nwait idle 20\nquit\n', { nodeArgs: ['--import', EXIT_PRELOAD] });
  assert.equal(result.status, 0, result.err);
  assert.ok(!result.err.includes('process.exit() was called'), 'claude called process.exit()');
});

// In a terminal the input does not end after `quit`: the process has to let go of it itself.
test('claude: quit ends the run although its input stays open', async (t) => {
  const { argv, env } = claudeWorld(t);
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  t.after(() => rmSync(appdata, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', EXIT_PRELOAD, BIN, ...argv()], { env: { ...process.env, APPDATA: appdata, OPENAI_API_KEY: '', GEMINI_API_KEY: '', ...env } });
  let err = '';
  child.stderr.on('data', (chunk) => (err += chunk));
  child.stdout.resume();
  child.stdin.write('say hi\nwait idle 20\nquit\n'); // and no end(): the terminal is still there
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('it did not end by itself'));
    }, 15_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(code, 0, err);
  assert.ok(!err.includes('process.exit() was called'), 'the loop was not empty: the cut-off had to end it');
});

test('press and ui stop on a script or a screen they cannot read, before they open any port', () => {
  const press = walkieDev('press', 'front');
  assert.equal(press.status, 1);
  assert.match(press.err, /front needs a time/);
  assert.ok(!press.out.includes('[link]'), 'it never tried the S3');
  const ui = walkieDev('ui', 'sleeping');
  assert.equal(ui.status, 1);
  assert.match(ui.err, /unknown screen "sleeping"/);
  assert.ok(!ui.out.includes('[link]'), 'it never tried the S3');
});

test('--snap and --elapsed take a value like the other options', () => {
  const run = walkieDev('ui', 'reply', 'x', '--snap');
  assert.equal(run.status, 2);
  assert.match(run.err, /--snap needs a value/);
});
