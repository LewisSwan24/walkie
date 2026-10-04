import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ui, { UiArgsError, parseUiArgs } from '../../src/dev/ui.js';
import { TYPE } from '../../src/link/frame.js';
import { BUTTON, UI_STATE, parseApprovalReq, parseUi } from '../../src/link/messages.js';
import { fakeLink, fakeLinkWithScreen, frameOf } from '../helpers/fake-link.js';

const approvalRes = (id, allow, reasonFollows) => {
  const p = Buffer.alloc(4);
  p.writeUInt16LE(id, 0);
  p[2] = allow ? 1 : 0;
  p[3] = reasonFollows ? 1 : 0;
  return frameOf(TYPE.APPROVAL_RES, p);
};
const settle = () => new Promise((r) => setImmediate(r));
const quiet = (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  return lines;
};

test('the screen is named by state, with the text after it, and the project and the time as options', () => {
  assert.deepEqual(parseUiArgs(['idle'], {}), { kind: 'ui', view: { state: UI_STATE.IDLE } });
  assert.deepEqual(parseUiArgs(['Reply', 'Done', 'it', 'works'], { project: 'walkie', elapsed: '12.5' }), {
    kind: 'ui',
    view: { state: UI_STATE.REPLY, project: 'walkie', text: 'Done it works', elapsedMs: 12500 },
  });
  for (const [name, state] of Object.entries({ idle: 0, transcribing: 1, confirm: 2, working: 3, reply: 4, error: 5 })) {
    assert.equal(parseUiArgs([name], {}).view.state, state, name);
  }
});

test('ui approval takes the tool and the preview, and numbers it 1', () => {
  assert.deepEqual(parseUiArgs(['approval', 'Bash', 'rm', '-rf', 'build'], {}), { kind: 'approval', approval: { id: 1, tool: 'Bash', preview: 'rm -rf build' } });
});

test('what is not a screen is an error that says what the screens are', () => {
  const bad = (args, opts, pattern) => assert.throws(() => parseUiArgs(args, opts), (e) => e instanceof UiArgsError && pattern.test(e.message), JSON.stringify([args, opts]));
  bad([], {}, /idle, transcribing, confirm, working, reply, error or approval/);
  bad(['sleeping'], {}, /unknown screen "sleeping"/);
  bad(['approval'], {}, /approval <tool> <preview/);
  bad(['approval', 'Bash'], {}, /approval <tool> <preview/);
  bad(['reply', 'x'], { elapsed: 'soon' }, /--elapsed .*seconds/);
  bad(['reply', 'x'], { elapsed: '-3' }, /--elapsed .*seconds/);
  bad(['reply', 'x'], { elapsed: '99999999999' }, /--elapsed .*too long/);
  bad(['reply', 'x'], { secs: '0' }, /--secs .*more than 0/);
  bad(['reply', 'x'], { secs: 'a while' }, /--secs .*more than 0/);
});

test('ui sends the screen, says what the keys do while it is up, and stops after --secs', async (t) => {
  const lines = quiet(t);
  const link = fakeLink();
  const slept = [];
  const done = ui(['working', 'Bash', 'ls'], { project: 'walkie', elapsed: '3', secs: '2' }, async () => link, async (ms) => slept.push(ms));
  await settle();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.UI);
  assert.deepEqual(parseUi(link.sent[0].payload), { state: UI_STATE.WORKING, project: 'walkie', text: 'Bash ls', elapsedMs: 3000 });
  link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([BUTTON.STOP])));
  link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([BUTTON.CANCEL])));
  link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([BUTTON.DISMISS])));
  link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([BUTTON.SWITCHING])));
  link.emit('frame', frameOf(TYPE.PONG, Buffer.alloc(0)));
  await done;
  assert.deepEqual(slept, [2000]);
  assert.equal(link.closed, true);
  const text = lines.join('\n');
  for (const name of ['STOP', 'CANCEL', 'DISMISS', 'SWITCHING']) assert.match(text, new RegExp(`button: ${name}`));
  assert.match(text, /sent: working/);
});

test('ui approval sends APPROVAL_REQ and prints the verdict the keys give, and the reason that follows', async (t) => {
  const lines = quiet(t);
  const link = fakeLink();
  const done = ui(['approval', 'Bash', 'ls -la'], { secs: '1' }, async () => link, async () => {});
  await settle();
  assert.equal(link.sent[0].type, TYPE.APPROVAL_REQ);
  assert.deepEqual(parseApprovalReq(link.sent[0].payload), { id: 1, tool: 'Bash', preview: 'ls -la' });
  link.emit('frame', approvalRes(1, true, false));
  link.emit('frame', approvalRes(1, false, false));
  link.emit('frame', approvalRes(1, false, true));
  await done;
  const text = lines.join('\n');
  assert.match(text, /approval #1: allowed/);
  assert.match(text, /approval #1: denied\b(?!, )/);
  assert.match(text, /approval #1: denied, a reason follows/);
});

test('with --snap the screen is looked at once it has been drawn, and that is all it waits for', async (t) => {
  quiet(t);
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = fakeLinkWithScreen(20, 6, () => 0xf800);
  const slept = [];
  const file = path.join(dir, 'reply.png');
  await ui(['reply', 'hi'], { snap: file, secs: '30' }, async () => link, async (ms) => slept.push(ms));
  assert.ok(statSync(file).size > 0);
  assert.deepEqual(link.sent.map((s) => s.type), [TYPE.UI, TYPE.TEST]);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 300 && slept[0] <= 1500, `a moment for the S3 to draw: ${slept[0]}`);
  assert.equal(link.closed, true);
});

test('with neither --secs nor --snap it stays until it is stopped, and does not close the link behind the screen', async (t) => {
  quiet(t);
  const link = fakeLink();
  let finished = false;
  ui(['idle'], {}, async () => link, async () => {}).then(() => (finished = true));
  await settle();
  await settle();
  assert.equal(finished, false);
  assert.equal(link.closed, false);
});

test('a bad screen stops ui before it connects', async () => {
  let connected = false;
  await assert.rejects(ui(['sleeping'], {}, async () => (connected = true)), UiArgsError);
  assert.equal(connected, false);
});
