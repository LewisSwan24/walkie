// bin/relay.js reads its settings from the environment and serves the same relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'relay.js');

function run(t, env) {
  const child = spawn(process.execPath, [bin], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const listening = new Promise((resolve) => {
    const timer = setInterval(() => {
      const m = /listening on port (\d+)/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(Number(m[1]));
      }
    }, 20);
    exited.then(() => clearInterval(timer));
  });
  return { listening, exited, err: () => err };
}

test('it listens on PORT and answers /healthz', async (t) => {
  const { listening } = run(t, { PORT: '0', HOST: '127.0.0.1' });
  const port = await Promise.race([listening, new Promise((_, no) => setTimeout(() => no(new Error('no start-up line')), 5000))]);
  assert.ok(port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

test('a setting that is not a whole number stops it with a message that names the setting', async (t) => {
  const { exited, err } = run(t, { PORT: '0', HOST: '127.0.0.1', MAX_PER_IP: 'many' });
  assert.notEqual(await exited, 0);
  assert.match(err(), /MAX_PER_IP must be a whole number/);
});
