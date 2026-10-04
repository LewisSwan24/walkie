import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../src/audio/wav.js';

const BIN = fileURLToPath(new URL('../bin/walkie.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./claude/fake-claude.js', import.meta.url));

// The real bin in a private %APPDATA% (no keys, no state of the real bridge), with nothing that could reach a provider or the S3.
const env = (appdata) => ({ ...process.env, APPDATA: appdata, OPENAI_API_KEY: '', GEMINI_API_KEY: '' });

function run(...args) {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  try {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(appdata, { recursive: true, force: true });
  }
}

test('a flag it does not know, or a word it has no use for, stops it with exit 2 and the usage', () => {
  for (const args of [['--provder', 'openai'], ['listen'], ['--port']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out, /usage: node bridge\/bin\/walkie\.js/, args.join(' '));
  }
});

test('pair takes only --forget and --port, --forget is only for pair, and --codec is pcm or adpcm', () => {
  for (const args of [['pair', '--bogus'], ['pair', 'now'], ['pair', '--clean-env'], ['pair', '--codec', 'adpcm'], ['--forget'], ['--codec', 'opus'], ['--codec']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out, /usage: node bridge\/bin\/walkie\.js/, args.join(' '));
  }
});

test('a --command that is not a JSON array stops it before anything is started', () => {
  const r = run('--command', 'claude --verbose');
  assert.equal(r.status, 1);
  assert.match(r.err, /--command is the program and its leading arguments as a JSON array/);
  assert.ok(!r.out.includes('[walkie]'), 'it never got as far as the banner');
});

test('it starts, says what is missing, waits for the S3, and the stand-in for claude comes up with it', async () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const child = spawn(process.execPath, [BIN, '--port', 'NOT-A-PORT', '--command', JSON.stringify([process.execPath, FAKE_CLAUDE])], { env: env(appdata), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // Made before anything can go wrong: a child that has already exited never says 'exit' again, and waiting for it would hang.
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try {
    const end = Date.now() + 15_000;
    while (!/Ctrl\+C/.test(out) || !/\[link\] cannot open the S3/.test(out)) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`it stopped (exit ${child.exitCode}) before the banner:\n${out}`);
      if (Date.now() > end) assert.fail(`no banner within 15 s:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(out, /\[keys\] /);
    assert.match(out, /\[walkie\] .*projects?.*active/s);
    assert.equal(child.exitCode, null, 'it keeps running while there is no S3');
  } finally {
    child.kill();
    await gone;
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('--inject with a file that is missing or not 16 kHz stops it before anything is started', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  try {
    const slow = path.join(dir, 'slow.wav');
    writeFileSync(slow, encodeWav(Buffer.alloc(3200), 8000));
    for (const [file, pattern] of [[path.join(dir, 'nope.wav'), /ENOENT/], [slow, /8000 Hz, the S3 records 16000 Hz/]]) {
      const r = run('--inject', file);
      assert.equal(r.status, 1, file);
      assert.match(r.err, pattern, file);
      assert.ok(!r.out.includes('[walkie]') && !r.out.includes('[keys]'), 'it never got as far as starting');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relay sets, shows and forgets the relay host in %APPDATA%, and refuses what is not a host', () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const go = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    assert.match(go('relay').out, /relay: none set/);
    const set = go('relay', 'walkie-relay.fly.dev');
    assert.equal(set.status, 0);
    assert.match(set.out, /relay set on this PC: walkie-relay.fly.dev/);
    assert.match(go('relay').out, /relay: walkie-relay.fly.dev/);
    for (const bad of ['a b', 'ws://relay.fly.dev']) {
      const r = go('relay', bad);
      assert.equal(r.status, 2, bad);
      assert.match(r.err, /walkie: /);
    }
    assert.match(go('relay').out, /relay: walkie-relay.fly.dev/, 'a refused host changed nothing');
    const forget = go('relay', '--forget');
    assert.equal(forget.status, 0);
    assert.match(forget.out, /relay forgotten on this PC/);
    assert.match(go('relay').out, /relay: none set/);
    assert.equal(go('relay', 'a.fly.dev', 'b.fly.dev').status, 2);
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('wifi without an action is exit 2 and the usage; with no pairing key it stops before asking for a password or opening a port', () => {
  const bare = run('wifi');
  assert.equal(bare.status, 2);
  assert.match(bare.out, /usage: node bridge\/bin\/walkie\.js/);
  assert.match(bare.out, /wifi add <ssid>/);
  for (const args of [['wifi', 'add', 'home'], ['wifi', 'list'], ['wifi', 'remove', 'home']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.err, /pairing key comes first/, args.join(' '));
    assert.doesNotMatch(r.err + r.out, /password/i, 'nothing was asked');
  }
  assert.equal(run('wifi', 'add').status, 2);
});

test('relay <host> without a pairing key sets the PC and says that the S3 was not told; --pc-only says nothing of it', () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const go = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    const set = go('relay', 'a.fly.dev');
    assert.equal(set.status, 0);
    assert.match(set.out, /relay set on this PC: a.fly.dev/);
    assert.match(set.out, /not paired, so the S3 was not told/);
    const only = go('relay', 'b.fly.dev', '--pc-only');
    assert.equal(only.status, 0);
    assert.doesNotMatch(only.out, /not told/);
    assert.match(go('relay').out, /relay: b.fly.dev/);
    assert.match(go('relay', '--forget').out, /not paired, so the S3 was not told/);
    assert.equal(go('relay', '--pc-only').status, 2);
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
