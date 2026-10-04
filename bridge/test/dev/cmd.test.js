import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import cmd from '../../src/dev/cmd.js';

// cmd() reaches the S3 through connect(); the fake link records the command and lets
// the test choose when the answer (or the loss of the link) happens.
function fakeLink() {
  const link = new EventEmitter();
  link.cmds = [];
  link.closed = false;
  link.cmd = (op, arg) => link.cmds.push([op, arg]);
  link.close = () => { link.closed = true; };
  return link;
}
const settle = () => new Promise((r) => setImmediate(r));

// The boot-app0 ack only leaves the S3 after the otadata flash write, and sector erase
// time varies: on the board acks arrived 48-485 ms late, and twice later than the old
// fixed 600 ms window, so the port closed first and the answer was silently lost.
test('a late answer still ends the wait: cmd does not close on a fixed window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const done = cmd(['boot-app0'], {}, async () => link);
  await settle();
  assert.equal(link.cmds.length, 1);
  t.mock.timers.tick(900); // past the old fixed 600 ms window
  await settle(); // let a premature close run before asserting it did not happen
  assert.equal(link.closed, false); // the answer may still come
  link.emit('log', 'boot app0: ESP_OK');
  await settle();
  assert.equal(link.closed, true);
  await done;
});

test('the first answer ends the wait, so a fast command returns fast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const done = cmd(['vol', '200'], {}, async () => link);
  await settle();
  link.emit('log', 'volume 200');
  await settle();
  assert.equal(link.closed, true);
  await done;
});

test('the link going down ends the wait: the restart happened without an ack', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const done = cmd(['boot-app0'], {}, async () => link);
  await settle();
  link.emit('down', 'port closed');
  await settle();
  assert.equal(link.closed, true);
  await done;
});

test('with no answer and no down, cmd gives up after 3 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const done = cmd(['boot-app0'], {}, async () => link);
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(link.closed, false);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(link.closed, true);
  await done;
});
