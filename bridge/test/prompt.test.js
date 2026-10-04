// readSecret: a password typed at the person's own terminal, with nothing echoed, never put on a command line or in a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSecret } from '../src/prompt.js';

function terminal({ tty = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = tty;
  input.isRaw = false;
  input.raw = [];
  input.setRawMode = (on) => {
    input.raw.push(on);
    input.isRaw = on;
  };
  input.setEncoding = () => {};
  input.paused = true;
  input.resume = () => {
    input.paused = false;
  };
  input.pause = () => {
    input.paused = true;
  };
  const written = [];
  const output = { write: (s) => written.push(s) };
  return { input, output, written, type: (s) => input.emit('data', s) };
}

test('what is typed up to Enter is the secret, and it is never written back', async () => {
  const t = terminal();
  const result = readSecret('password: ', { input: t.input, output: t.output });
  t.type('hun');
  t.type('ter2\r');
  assert.equal(await result, 'hunter2');
  assert.equal(t.written.join(''), 'password: \n');
});

test('raw mode is on while typing and back as it was after, and the input is let go', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  assert.deepEqual(t.input.raw, [true]);
  assert.equal(t.input.paused, false);
  t.type('x\n');
  await result;
  assert.deepEqual(t.input.raw, [true, false]);
  assert.equal(t.input.paused, true);
  assert.equal(t.input.listenerCount('data'), 0);
});

test('a terminal that was already raw is left raw', async () => {
  const t = terminal();
  t.input.isRaw = true;
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('x\r');
  await result;
  assert.deepEqual(t.input.raw, [true, true]);
});

test('Backspace takes off a whole character, even one that is more than a byte', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('ab咖啡\u007f\u007f');
  t.type('c\b');
  t.type('d\r');
  assert.equal(await result, 'abd');
});

test('Backspace on nothing does nothing', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('\u007f\u007fa\r');
  assert.equal(await result, 'a');
});

test('Ctrl+C cancels: it rejects, and the terminal is put back', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('abc\u0003');
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(t.input.raw, [true, false]);
  assert.equal(t.written.join(''), 'p: \n');
});

test('an arrow key or another escape sequence adds nothing', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\u001b[Ab\u001b[1;5Cc\u001b[3~d\r');
  assert.equal(await result, 'abcd');
});

test('other control characters add nothing, and a pasted line is taken to its end', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\tb\u0001c\r');
  assert.equal(await result, 'abc');
});

test('what comes after Enter in the same chunk is not part of it', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('abc\rdef');
  assert.equal(await result, 'abc');
});

test('Enter with nothing typed is an empty secret: an open network', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('\r');
  assert.equal(await result, '');
});

test('input that is not a terminal is refused before anything is written: a password is typed, not piped', async () => {
  const t = terminal({ tty: false });
  await assert.rejects(readSecret('p: ', { input: t.input, output: t.output }), /this is not one/);
  assert.deepEqual(t.written, []);
  assert.deepEqual(t.input.raw, []);
});

test('an input that cannot go raw is refused too', async () => {
  const t = terminal();
  t.input.setRawMode = undefined;
  await assert.rejects(readSecret('p: ', { input: t.input, output: t.output }), /this is not one/);
});


test('a character outside the BMP is one character: one Backspace takes all of it', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\u{1F600}\u007f\r');
  assert.equal(await result, 'a');
});
