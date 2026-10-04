// arrivesWithin and askOnce: waiting for an event, and sending one frame and waiting for its answer, without leaving a timer or a
// listener behind (the commands that use them are short-lived processes, but a test process and a long-lived caller are not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { arrivesWithin, askOnce } from '../../src/link/exchange.js';

const PICK = (p) => (p[0] === 1 ? { got: p[0] } : null);

function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.send = (type, payload) => link.sent.push({ type, payload });
  return link;
}

test('arrivesWithin is true when the event comes, and leaves no timer and no listener', async (t) => {
  const e = new EventEmitter();
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const result = arrivesWithin(e, 'hello', 5000);
  assert.equal(e.listenerCount('hello'), 1);
  e.emit('hello');
  assert.equal(await result, true);
  assert.equal(e.listenerCount('hello'), 0);
  assert.equal(cleared.mock.callCount(), 1, 'the timer was cleared');
});

test('arrivesWithin is false when the time runs out, and leaves no listener', async () => {
  const e = new EventEmitter();
  assert.equal(await arrivesWithin(e, 'hello', 20), false);
  assert.equal(e.listenerCount('hello'), 0);
});

test('askOnce sends the frame once, and resolves with what pick makes of the first answer it accepts', async () => {
  const link = fakeLink();
  const answer = askOnce(link, 0x33, Buffer.from([9]), PICK, 5000);
  assert.deepEqual(link.sent, [{ type: 0x33, payload: Buffer.from([9]) }]);
  link.emit('frame', { type: 0x33, payload: Buffer.from([2]) }); // not an answer
  link.emit('frame', { type: 0x33, payload: Buffer.from([1]) });
  link.emit('frame', { type: 0x33, payload: Buffer.from([1, 5]) }); // a second one changes nothing
  assert.deepEqual(await answer, { got: 1 });
  assert.equal(link.sent.length, 1, 'never sent again');
});

test('a frame of another type is not an answer, whatever pick would make of it', async () => {
  const link = fakeLink();
  const answer = askOnce(link, 0x33, Buffer.from([9]), PICK, 60);
  link.emit('frame', { type: 0x32, payload: Buffer.from([1]) });
  assert.equal(await answer, null);
});

test('askOnce is null after answerMs, and either way leaves no listener and no timer', async (t) => {
  const link = fakeLink();
  assert.equal(await askOnce(link, 0x33, Buffer.alloc(1), PICK, 20), null);
  assert.equal(link.listenerCount('frame'), 0);
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const answer = askOnce(link, 0x33, Buffer.alloc(1), PICK, 5000);
  link.emit('frame', { type: 0x33, payload: Buffer.from([1]) });
  await answer;
  assert.equal(link.listenerCount('frame'), 0);
  assert.equal(cleared.mock.callCount(), 1);
});
