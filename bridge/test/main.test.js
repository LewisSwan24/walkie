// The whole bridge, with only the two ends stood in for: the S3 (FakeS3, on the real Link) and the speech providers. Claude is
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { startBridge } from '../src/main.js';
import { createConsole } from '../src/console.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { createStateStore } from '../src/config/state.js';
import { TYPE } from '../src/link/frame.js';
import { BUTTON, UI_STATE } from '../src/link/messages.js';
import { denyWithReason } from '../src/perm/approvals.js';
import { SAY_AGAIN } from '../src/turn/turn.js';
import { tone } from '../src/audio/tone.js';
import { FakeS3, until } from './helpers/fake-s3.js';
import { FAKE_CLAUDE, providers, speechPcm, world } from './helpers/world.js';

test('a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'] });
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.equal(w.shown(UI_STATE.CONFIRM).text, '你好');
  assert.ok(w.lines.some((l) => l.endsWith('[heard] 「你好」 → to_claude (openai)')), 'the console says what was heard');
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  assert.equal(w.shown(UI_STATE.REPLY).project, 'proj');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.equal(w.spoken.length, 1);
  assert.match(w.spoken[0], /I heard: 你好/);
  assert.ok(w.s3.audioDown().bytes > 0);
  assert.ok(w.lines.some((l) => l.includes('[reply] proj turn 1')), 'the reply is printed in full on the console');
});

test('a tool call that needs approval is shown on the S3, and the key that allows it lets Claude go on', async (t) => {
  const w = await world(t, { said: ['!write note.txt'] });
  w.s3.take(speechPcm);
  await until(() => w.s3.frames(TYPE.APPROVAL_REQ).length === 1, 'the approval on the S3');
  const shown = w.s3.screens().find((s) => s.approval).approval;
  assert.equal(shown.tool, 'Write');
  assert.match(shown.preview, /note\.txt/);
  w.s3.answer(shown.id, true);
  await until(() => w.s3.screens().some((s) => s.text === 'Created note.txt.'), 'Claude to go on');
});

test('a denial with a spoken reason gives the reason to the approvals and does not go to Claude as a request', async (t) => {
  const w = await world(t, { said: ['!write note.txt', '因为我不想改这个文件'] });
  const verdicts = [];
  const answer = w.bridge.approvals.answer;
  w.bridge.approvals.answer = (id, v) => (verdicts.push(v), answer(id, v));
  w.s3.take(speechPcm);
  await until(() => w.s3.frames(TYPE.APPROVAL_REQ).length === 1, 'the approval on the S3');
  const { id } = w.s3.screens().find((s) => s.approval).approval;
  w.s3.answer(id, false, true);
  w.s3.take(speechPcm, { reason: true });
  await until(() => w.s3.screens().some((s) => /You refused the write/.test(s.text ?? '')), 'Claude to report the refusal');
  assert.deepEqual(verdicts, [{ allow: false, reason: '因为我不想改这个文件' }]);
  assert.equal(w.lines.filter((l) => l.includes('[reply]')).length, 1, 'one turn: the reason was not a request');
  assert.ok(denyWithReason('x').includes('x'));
});

test('holding the side key while Claude works stops it, and the S3 is told and spoken to', async (t) => {
  const w = await world(t, { said: ['!sleep 20000'] });
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.WORKING && /^Bash/.test(s.text ?? '')), 'a tool to run');
  w.s3.button(BUTTON.STOP);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY && s.text === '已停止。'), 'the stop to be announced');
  await until(() => w.spoken.includes('已停止。'), '已停止。 to be spoken');
});

test('a take nobody can hear is 没听清 on the S3 and nothing for Claude', async (t) => {
  const w = await world(t, { adapters: [] });
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.ERROR), 'the error screen');
  assert.equal(w.shown(UI_STATE.ERROR).text, SAY_AGAIN);
  assert.equal(w.lines.some((l) => l.includes('[working]')), false);
  assert.ok(w.lines.some((l) => l.includes('[heard] nothing clear')), 'the console says nothing was clear');
});

test('with no S3 on USB the bridge runs on, says so once, and closes cleanly', async (t) => {
  const lines = [];
  let tries = 0;
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command: [process.execPath, FAKE_CLAUDE], prewarm: false } },
    projects: [{ name: 'proj', aliases: [], path: tmpdir() }],
    adapters: [],
    openPort: async () => {
      tries++;
      throw new Error('no S3 on USB (303A:1001)');
    },
    store: createStateStore({ file: null }),
    console: createConsole({ out: (line) => lines.push(line) }),
  });
  assert.equal(bridge.link.ready, false);
  assert.equal(tries, 1);
  assert.ok(lines.some((l) => l.includes('[link] cannot open the S3') && l.includes('no S3 on USB')), lines.join('\n'));
  await bridge.close();
  await bridge.close(); // twice is the same as once
});

test('closing the bridge denies what is waiting for a yes, so that Claude is not left holding it', async (t) => {
  const w = await world(t, { said: ['!write note.txt'] });
  w.s3.take(speechPcm);
  await until(() => w.s3.frames(TYPE.APPROVAL_REQ).length === 1, 'the approval on the S3');
  assert.equal(w.bridge.approvals.pending(), 1);
  await w.bridge.close();
  assert.equal(w.bridge.approvals.pending(), 0);
  assert.ok(w.lines.some((l) => /\[approval\] #\d+ denied/.test(l)), 'denied by the shutdown, not left to fail when Claude is ended');
});

test('a bridge that cannot start does not leave the permission server listening', async () => {
  await assert.rejects(
    startBridge({
      config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, prewarm: false } },
      projects: [], // the manager needs a project to start in
      adapters: [],
      openPort: async () => new FakeS3(),
      store: createStateStore({ file: null }),
      console: createConsole({ out: () => {} }),
    }),
  );
});

test('starting the bridge makes the active project the remembered one', async (t) => {
  const w = await world(t);
  assert.equal(w.store.project(), 'proj');
});

test('the turn timings given to the bridge are the turn\'s', async (t) => {
  const slept = [];
  const w = await world(t, { said: ['你好'], turn: { confirmMs: 123, sleep: async (ms) => void slept.push(ms) } });
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.ok(slept.includes(123), 'the CONFIRM hold is confirmMs: ' + slept.join(','));
});

test('an approval nobody answers is denied after the configured time, not the default one', async (t) => {
  const w = await world(t, { said: ['!write note.txt'], approvalTimeoutSec: 0.2 });
  w.s3.take(speechPcm);
  await until(() => w.lines.some((l) => /\[approval\] #\d+ timeout/.test(l)), 'the approval to time out');
  assert.equal(w.bridge.approvals.pending(), 0);
});

test('closing the bridge stops a reply that is being spoken, instead of leaving it to run on after the link is gone', async (t) => {
  let started = false;
  let ended = false;
  const [provider] = providers(['你好'], []);
  const slow = {
    ...provider,
    speak: async function* () {
      started = true;
      try {
        for (let i = 0; i < 100; i++) {
          yield tone(330, 0.1, 4000);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        ended = true;
      }
    },
  };
  const w = await world(t, { adapters: [slow] });
  w.s3.take(speechPcm);
  await until(() => started, 'the reply to start');
  await w.bridge.close();
  assert.equal(ended, true);
});

test('closing the bridge twice does the work once', async (t) => {
  const w = await world(t);
  let denies = 0;
  const denyAll = w.bridge.approvals.denyAll;
  w.bridge.approvals.denyAll = (...args) => (denies++, denyAll(...args));
  await Promise.all([w.bridge.close(), w.bridge.close()]);
  await w.bridge.close();
  assert.equal(denies, 1);
});

const KEY = Buffer.alloc(32, 0x42);

test('with the pairing key and ADPCM, a whole turn runs sealed: the take comes up as ADPCM and the reply goes down as ADPCM', async (t) => {
  const w = await world(t, { said: ['你好'], s3: { proto: 2, master: KEY, adpcm: true }, link: { master: KEY, adpcm: true } });
  await until(() => w.s3.upCodec === 1, 'the S3 asked for ADPCM takes');
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  assert.ok(w.s3.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'every frame after HELLO was sealed');
  assert.equal(w.s3.refused.length, 0);
  assert.ok(w.s3.frames(TYPE.AUDIO_DOWN).every((f) => !f.payload.length || (f.flags & 0x06) === 0x02), 'the reply went down as ADPCM');
  assert.equal(w.s3.badDown, 0);
});

test("the retry settings given to the bridge are the link's", async (t) => {
  let tries = 0;
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command: [process.execPath, FAKE_CLAUDE], prewarm: false } },
    projects: [{ name: 'proj', aliases: [], path: tmpdir() }],
    adapters: [],
    openPort: async () => {
      tries++;
      throw new Error('no S3');
    },
    retry: { retryMs: 20, retryMaxMs: 20 },
    store: createStateStore({ file: null }),
    console: createConsole({ out: () => {} }),
  });
  t.after(() => bridge.close());
  await until(() => tries >= 4, 'several tries in a moment (the default is one a second)');
});
