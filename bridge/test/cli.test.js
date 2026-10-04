// The command line of `walkie`: what it takes and what it makes of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../src/dev/args.js';
import { parseWalkieCommand } from '../src/cli.js';

test('no words runs the bridge; --clean-env, --port, --command, --inject and --codec are its options', () => {
  assert.deepEqual(parseWalkieCommand([]), { command: 'run', cleanEnv: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['--clean-env', '--port', 'COM8', '--codec', 'adpcm']), {
    command: 'run', cleanEnv: true, opts: { port: 'COM8', codec: 'adpcm' },
  });
});

test('pair, and pair --forget, are the pairing commands, and take --port', () => {
  assert.deepEqual(parseWalkieCommand(['pair']), { command: 'pair', forget: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['pair', '--forget', '--port', 'COM8']), { command: 'pair', forget: true, opts: { port: 'COM8' } });
  assert.deepEqual(parseWalkieCommand(['--port', 'COM8', 'pair']), { command: 'pair', forget: false, opts: { port: 'COM8' } });
});

test('anything else is a usage error: a word, --forget without pair, --codec or --clean-env with pair', () => {
  for (const argv of [['listen'], ['--forget'], ['pair', 'now'], ['pair', '--bogus'], ['pair', '--clean-env'], ['pair', '--codec', 'pcm'], ['pair', '--inject', 'a.wav'], ['pair', '--command', '[]'], ['--codec', 'opus']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});

test('relay shows the relay set on this PC, relay <host> sets it, relay --forget clears it', () => {
  assert.deepEqual(parseWalkieCommand(['relay']), { command: 'relay', host: null, forget: false, pcOnly: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', 'walkie-relay.fly.dev']), { command: 'relay', host: 'walkie-relay.fly.dev', forget: false, pcOnly: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', '--forget']), { command: 'relay', host: null, forget: true, pcOnly: false, opts: {} });
});

test('relay --pc-only keeps the host on this PC, and --port names the cable that the S3 is told over', () => {
  assert.deepEqual(parseWalkieCommand(['relay', 'a.fly.dev', '--pc-only']), { command: 'relay', host: 'a.fly.dev', forget: false, pcOnly: true, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', '--pc-only', '--forget']), { command: 'relay', host: null, forget: true, pcOnly: true, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', 'a.fly.dev', '--port', 'COM8']).opts, { port: 'COM8' });
  assert.throws(() => parseWalkieCommand(['relay', '--pc-only']), /goes with a host or --forget/);
  assert.throws(() => parseWalkieCommand(['--pc-only']), UsageError);
  assert.throws(() => parseWalkieCommand(['pair', '--pc-only']), UsageError);
});

test('relay takes one host or --forget, and --pc-only and --port, and no other option', () => {
  for (const argv of [['relay', 'a.fly.dev', 'b.fly.dev'], ['relay', 'a.fly.dev', '--forget'], ['relay', '--codec', 'adpcm'], ['relay', '--clean-env'], ['relay', '--inject', 'a.wav']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});

test('wifi is add <ssid>, list or remove <ssid>, and takes --port', () => {
  assert.deepEqual(parseWalkieCommand(['wifi', 'add', 'home']), { command: 'wifi', action: 'add', ssid: 'home', opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'remove', 'home']), { command: 'wifi', action: 'remove', ssid: 'home', opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'list']), { command: 'wifi', action: 'list', ssid: null, opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'list', '--port', 'COM8']).opts, { port: 'COM8' });
  assert.deepEqual(parseWalkieCommand(['wifi', 'add', 'my network']).ssid, 'my network');
});

test('wifi without an action, with another, with a name missing or too many, or with an option it does not take, is a usage error', () => {
  const bad = [
    ['wifi'],
    ['wifi', 'join', 'home'],
    ['wifi', 'add'],
    ['wifi', 'remove'],
    ['wifi', 'list', 'home'],
    ['wifi', 'add', 'home', 'cafe'],
    ['wifi', 'add', 'home', '--forget'],
    ['wifi', 'add', 'home', '--codec', 'pcm'],
    ['wifi', 'list', '--clean-env'],
  ];
  for (const argv of bad) assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
});

test('a password is not something wifi takes on the command line: it is typed at the prompt, so it never reaches a history file', () => {
  for (const argv of [['wifi', 'add', 'home', '--pass', 'secret123'], ['wifi', 'add', 'home', '--password=secret123'], ['wifi', 'add', 'home', 'secret123']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});
