import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUi } from '../../src/ui/ui.js';
import { TYPE } from '../../src/link/frame.js';
import { BUTTON, UI_STATE, parseApprovalReq, parseUi } from '../../src/link/messages.js';

// A link that writes down what is sent to it and lets a test play the device's frames.
function setup({ accept = true } = {}) {
  const link = new EventEmitter();
  link.sent = [];
  link.send = (type, payload) => {
    link.sent.push({ type, payload });
    return accept;
  };
  const ui = createUi({ link, log: () => {} });
  const events = [];
  for (const name of ['cancel', 'stop', 'dismiss', 'switching', 'verdict']) ui.on(name, (e) => events.push([name, e]));
  // What the device would show of what was sent: the last UI frame, the approval over it if one is after it.
  const screen = () => {
    let shown = null;
    for (const s of link.sent) {
      if (s.type === TYPE.UI) shown = { base: parseUi(s.payload) };
      if (s.type === TYPE.APPROVAL_REQ) shown = { ...shown, approval: parseApprovalReq(s.payload) };
      if (s.type === TYPE.UI) delete shown.approval; // any UI frame ends the approval on the device
    }
    return shown;
  };
  return { link, ui, events, screen };
}
const press = (link, button) => link.emit('frame', { type: TYPE.BUTTON, flags: 0, seq: 1, payload: Buffer.from([button]) });
const answer = (link, id, allow, reasonFollows) => {
  const p = Buffer.alloc(4);
  p.writeUInt16LE(id, 0);
  p[2] = allow ? 1 : 0;
  p[3] = reasonFollows ? 1 : 0;
  link.emit('frame', { type: TYPE.APPROVAL_RES, flags: 0, seq: 2, payload: p });
};

test('show sends a UI frame with the state, project, text and elapsed time', () => {
  const { link, ui } = setup();
  ui.show(UI_STATE.WORKING, { project: 'walkie', text: 'Bash: npm test', elapsedMs: 4000 });
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.UI);
  assert.deepEqual(parseUi(link.sent[0].payload), { state: UI_STATE.WORKING, project: 'walkie', text: 'Bash: npm test', elapsedMs: 4000 });
});

test('a UI frame with nothing but a state is a state alone', () => {
  const { link, ui } = setup();
  ui.show(UI_STATE.IDLE);
  assert.deepEqual(parseUi(link.sent[0].payload), { state: UI_STATE.IDLE });
});

test('an approval is sent as APPROVAL_REQ and shown over the screen', () => {
  const { link, ui, screen } = setup();
  ui.show(UI_STATE.WORKING, { project: 'walkie' });
  ui.approval({ id: 7, tool: 'Bash', preview: 'rm -rf build' });
  assert.equal(link.sent.at(-1).type, TYPE.APPROVAL_REQ);
  assert.deepEqual(screen().approval, { id: 7, tool: 'Bash', preview: 'rm -rf build' });
  assert.deepEqual(ui.current().approval, { id: 7, tool: 'Bash', preview: 'rm -rf build' });
});

// The device takes any UI frame as the end of the approval, so a screen change while one is pending must not be sent.
test('a screen change while an approval is on the screen is kept back, not sent', () => {
  const { link, ui, screen } = setup();
  ui.approval({ id: 7, tool: 'Bash', preview: 'ls' });
  const before = link.sent.length;
  ui.show(UI_STATE.WORKING, { project: 'walkie', text: 'Bash', elapsedMs: 1000 });
  assert.equal(link.sent.length, before, 'nothing went out');
  assert.equal(screen().approval.id, 7, 'the approval is still there');
});

test('when the approval is over, the screen as it is now is sent, not the one from before', () => {
  const { link, ui, screen } = setup();
  ui.show(UI_STATE.WORKING, { project: 'walkie', text: 'first' });
  ui.approval({ id: 7, tool: 'Bash', preview: 'ls' });
  ui.show(UI_STATE.REPLY, { project: 'walkie', text: 'second' });
  ui.approvalClear(7);
  assert.equal(link.sent.at(-1).type, TYPE.UI);
  assert.deepEqual(screen().base, { state: UI_STATE.REPLY, project: 'walkie', text: 'second' });
  assert.equal(screen().approval, undefined);
});

test('clearing an approval that is not the one on the screen changes nothing', () => {
  const { link, ui } = setup();
  ui.approval({ id: 7, tool: 'Bash', preview: 'ls' });
  const before = link.sent.length;
  ui.approvalClear(8);
  ui.approvalClear(7);
  assert.equal(link.sent.length, before + 1, 'only the clear of 7 sent the screen');
  ui.approvalClear(7);
  assert.equal(link.sent.length, before + 1, 'and a second clear of it does nothing');
  assert.equal(ui.current().approval, null);
});

test('a next approval replaces the one before it on the device', () => {
  const { ui, screen } = setup();
  ui.approval({ id: 7, tool: 'Bash', preview: 'ls' });
  ui.approvalClear(7);
  ui.approval({ id: 8, tool: 'Edit', preview: 'a.txt' });
  assert.equal(screen().approval.id, 8);
});

test('when the device (re)connects, the screen is sent again, the approval if there is one', () => {
  const { link, ui } = setup();
  ui.show(UI_STATE.REPLY, { project: 'walkie', text: 'hello' });
  link.sent.length = 0;
  link.emit('hello', {});
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.UI);
  assert.equal(parseUi(link.sent[0].payload).text, 'hello');
  ui.approval({ id: 3, tool: 'Bash', preview: 'ls' });
  link.sent.length = 0;
  link.emit('hello', {});
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.APPROVAL_REQ);
});

test('buttons become events', () => {
  const { link, events } = setup();
  press(link, BUTTON.CANCEL);
  press(link, BUTTON.STOP);
  press(link, BUTTON.DISMISS);
  press(link, BUTTON.SWITCHING);
  assert.deepEqual(events.map((e) => e[0]), ['cancel', 'stop', 'dismiss', 'switching']);
});

test('a button this version does not know, and an empty one, are ignored', () => {
  const { link, events } = setup();
  press(link, 99);
  link.emit('frame', { type: TYPE.BUTTON, flags: 0, seq: 1, payload: Buffer.alloc(0) });
  assert.deepEqual(events, []);
});

test('an approval answer becomes a verdict with its id, whether it allows and whether a spoken reason follows', () => {
  const { link, events } = setup();
  answer(link, 7, true, false);
  answer(link, 8, false, true);
  assert.deepEqual(events, [
    ['verdict', { id: 7, allow: true, reasonFollows: false }],
    ['verdict', { id: 8, allow: false, reasonFollows: true }],
  ]);
});

test('a short APPROVAL_RES is ignored, and frames of other types are not for this module', () => {
  const { link, events } = setup();
  link.emit('frame', { type: TYPE.APPROVAL_RES, flags: 0, seq: 1, payload: Buffer.from([1, 0]) });
  link.emit('frame', { type: TYPE.TEST, flags: 0, seq: 1, payload: Buffer.from([5, 0]) });
  assert.deepEqual(events, []);
});

test('a link that has no port to write to does not make show or approval throw', () => {
  const { ui } = setup({ accept: false });
  ui.show(UI_STATE.IDLE);
  ui.approval({ id: 1, tool: 'Bash', preview: 'ls' });
  ui.approvalClear(1);
});

test('text that is too long for a frame is cut on a character and never makes show throw', () => {
  const { link, ui } = setup();
  ui.show(UI_STATE.REPLY, { project: 'p', text: '好'.repeat(2000) });
  const view = parseUi(link.sent[0].payload);
  assert.ok(view.text.length > 0 && Buffer.byteLength(view.text) <= 900);
  assert.ok(!view.text.includes('�'), 'no half character');
});
