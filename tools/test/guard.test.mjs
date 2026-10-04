import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PYTHON } from '../lib/esptool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(root, 'firmware', 'guard.py');

// Runs firmware/guard.py the way PlatformIO would, with SCons stubbed out, and reports the exit code it asked for.
const SNIPPET = `
import sys, types, json
targets = json.loads(sys.argv[2])
scons = types.ModuleType('SCons'); script = types.ModuleType('SCons.Script')
script.COMMAND_LINE_TARGETS = targets; scons.Script = script
sys.modules['SCons'] = scons; sys.modules['SCons.Script'] = script
class Env:
    code = None
    def Exit(self, code):
        self.code = code
        raise SystemExit(code)
env = Env()
try:
    exec(open(sys.argv[1], encoding='utf-8').read(), {'Import': lambda *a: None, 'env': env})
except SystemExit:
    pass
print('EXIT', env.code)
`;

function runGuard(targets) {
  const r = spawnSync(PYTHON, ['-c', SNIPPET, GUARD, JSON.stringify(targets)], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.stdout;
}

const skip = existsSync(PYTHON) ? false : `PlatformIO's Python not found at ${PYTHON}`;

test('guard refuses erase and uploadfs', { skip }, () => {
  for (const targets of [['erase'], ['uploadfs'], ['uploadfsota'], ['erase', 'upload']]) {
    const out = runGuard(targets);
    assert.match(out, /EXIT 1/, JSON.stringify(targets));
    assert.match(out, /walkie: refusing/, JSON.stringify(targets));
  }
});

test('guard lets build, upload and envdump through', { skip }, () => {
  for (const targets of [[], ['upload'], ['buildprog'], ['envdump']]) {
    const out = runGuard(targets);
    assert.match(out, /EXIT None/, JSON.stringify(targets));
    assert.doesNotMatch(out, /refusing/, JSON.stringify(targets));
  }
});
