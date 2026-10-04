import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/esptool.mjs';

const saved = process.env.WALKIE_PORT;
beforeEach(() => { delete process.env.WALKIE_PORT; });
after(() => {
  if (saved === undefined) delete process.env.WALKIE_PORT;
  else process.env.WALKIE_PORT = saved;
});

test('defaults to COM8, no build skip, nothing left over', () => {
  assert.deepEqual(parseArgs([]), { port: 'COM8', skipBuild: false, rest: [] });
});

test('WALKIE_PORT sets the default port', () => {
  process.env.WALKIE_PORT = 'COM7';
  assert.equal(parseArgs([]).port, 'COM7');
});

test('--port COMn and --port=COMn', () => {
  assert.equal(parseArgs(['--port', 'COM3']).port, 'COM3');
  assert.equal(parseArgs(['--port=COM3']).port, 'COM3');
});

test('--port without a value is an error, not a port', () => {
  for (const argv of [['--port'], ['--port', '--skip-build'], ['--port=']]) {
    assert.throws(() => parseArgs(argv), /--port/, JSON.stringify(argv));
  }
});

test('unknown options are errors', () => {
  for (const argv of [['--bogus'], ['-x']]) {
    assert.throws(() => parseArgs(argv), /unknown option/, JSON.stringify(argv));
  }
});

test('positional arguments come back in rest', () => {
  const opts = parseArgs(['app1', '--skip-build']);
  assert.deepEqual(opts.rest, ['app1']);
  assert.equal(opts.skipBuild, true);
});
