import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../../src/dev/args.js';

test('a command, its arguments and its flags, wherever the flags are', () => {
  assert.deepEqual(parseArgs(['say', '好的', '继续', '--provider', 'openai', '--out', 'a.wav']), { name: 'say', args: ['好的', '继续'], opts: { provider: 'openai', out: 'a.wav' } });
  assert.deepEqual(parseArgs(['--port', 'COM8', 'ping', '3']), { name: 'ping', args: ['3'], opts: { port: 'COM8' } });
  assert.deepEqual(parseArgs([]), { name: undefined, args: [], opts: {} });
});

test('--flag=value means --flag value', () => {
  assert.deepEqual(parseArgs(['hear', 'a.wav', '--provider=openai']), { name: 'hear', args: ['a.wav'], opts: { provider: 'openai' } });
  assert.deepEqual(parseArgs(['term', '--secs=5']).opts, { secs: '5' });
});

test('--all stays with the arguments, for the command that reads it', () => {
  assert.deepEqual(parseArgs(['classify', '--all', '--provider', 'openai']), { name: 'classify', args: ['--all'], opts: { provider: 'openai' } });
});

test('a flag with no value is an error, never a default', () => {
  for (const argv of [['say', 'hi', '--provider'], ['say', 'hi', '--provider', '--out', 'a.wav'], ['say', 'hi', '--provider=']]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && err.message === '--provider needs a value', argv.join(' '));
  }
});

test('an option nobody defined is an error, and what follows its equals sign is not repeated', () => {
  assert.throws(() => parseArgs(['say', 'hi', '--provder', 'openai']), (err) => err instanceof UsageError && err.message === 'unknown option --provder');
  assert.throws(() => parseArgs(['say', 'hi', '--api-key=sk-secret']), (err) => err.message === 'unknown option --api-key' && !err.message.includes('sk-secret'));
});

test('a flag given twice is an error', () => {
  assert.throws(() => parseArgs(['say', 'hi', '--provider', 'openai', '--provider=gemini']), (err) => err instanceof UsageError && err.message === '--provider was given twice');
});

test('--cwd, --project and --command take a value, and --clean-env stays with the arguments', () => {
  assert.deepEqual(parseArgs(['claude', '--cwd', 'C:\\w', '--command', '["node","fake.js"]', '--clean-env']), { name: 'claude', args: ['--clean-env'], opts: { cwd: 'C:\\w', command: '["node","fake.js"]' } });
  assert.deepEqual(parseArgs(['claude', '--project=walkie']), { name: 'claude', args: [], opts: { project: 'walkie' } });
  for (const argv of [['claude', '--cwd'], ['claude', '--cwd', '--clean-env'], ['claude', '--project='], ['claude', '--command']]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && /needs a value/.test(err.message), argv.join(' '));
  }
  assert.throws(() => parseArgs(['claude', '--cwd', 'a', '--cwd=b']), (err) => err instanceof UsageError && err.message === '--cwd was given twice');
});

test('text that only looks like a flag is text', () => {
  assert.deepEqual(parseArgs(['say', '--help me', '--', '---', '--5']).args, ['--help me', '--', '---', '--5']);
});

test('--codec takes pcm or adpcm and nothing else, and --forget stays among the arguments', () => {
  assert.deepEqual(parseArgs(['--codec', 'adpcm', 'play', 'x.wav']), { name: 'play', args: ['x.wav'], opts: { codec: 'adpcm' } });
  assert.deepEqual(parseArgs(['play', '--codec=pcm']).opts, { codec: 'pcm' });
  for (const argv of [['--codec', 'opus'], ['--codec=ADPCM'], ['--codec', '']]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && /--codec/.test(err.message), argv.join(' '));
  }
  assert.deepEqual(parseArgs(['pair', '--forget']), { name: 'pair', args: ['--forget'], opts: {} });
});
