import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTurn, SAY_AGAIN } from '../../src/turn/turn.js';
import { createUi } from '../../src/ui/ui.js';
import { createApprovals, DENY_DEFAULT, denyWithReason } from '../../src/perm/approvals.js';
import { FLAG, TYPE } from '../../src/link/frame.js';
import { BUTTON, UI_STATE, parseApprovalReq, parseUi } from '../../src/link/messages.js';
import { SpeechError, abortError } from '../../src/speech/errors.js';

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

// Everything the turn talks to, with the device played by the test: frames go in on the link, and what the S3 would be
// sent is read back from what the link was asked to send.
function setup({ confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, takeIdleMs = 500 } = {}) {
  const clock = { t: 100_000 };
  const logs = [];

  const link = new EventEmitter();
  link.sent = [];
  link.plays = [];
  link.tones = [];
  link.holdPlays = false;
  link.send = (type, payload) => (link.sent.push({ type, payload }), true);
  link.playStream = async (chunks, { signal } = {}) => {
    const play = { chunks: [], signal, release: null };
    link.plays.push(play);
    const held = new Promise((resolve) => (play.release = () => resolve({ reason: 1 })));
    signal?.addEventListener('abort', () => play.release(), { once: true });
    const read = (async () => {
      for await (const chunk of chunks) play.chunks.push(chunk);
      return { reason: 0 };
    })();
    return link.holdPlays ? held : Promise.race([read, held]); // held: the S3 is still playing until the test or an abort says not
  };
  link.playAudio = async (pcm) => {
    link.tones.push(pcm);
    return { reason: 0 };
  };

  const speech = { hears: [], says: [], sayError: null, sayAudio: () => (async function* () { yield Buffer.alloc(480); })() };
  speech.hear = (pcm, opts) =>
    new Promise((resolve, reject) => {
      const call = {
        pcm,
        opts,
        words(text) {
          opts.onTranscript?.(text);
        },
        ok(transcript, { intent = 'to_claude', project = null, text = transcript } = {}) {
          call.words(transcript);
          resolve({ status: 'ok', transcript, transcribedBy: 'openai', intent, project, text, classifiedBy: 'openai', ms: { transcribe: 1, classify: 1 } });
        },
        unclear(reason = 'empty') {
          resolve({ status: 'unclear', reason, transcript: '' });
        },
        fail: reject,
      };
      speech.hears.push(call);
      opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  speech.say = async (text, { signal } = {}) => {
    speech.says.push({ text, signal });
    if (speech.sayError) throw speech.sayError;
    return { provider: 'openai', audio: speech.sayAudio() };
  };

  const events = new EventEmitter();
  const manager = {
    active: 'walkie',
    handled: [],
    result: {},
    onHandle: null,
    project: () => manager.active,
    on: (name, fn) => events.on(name, fn),
    emit: (name, payload) => events.emit(name, payload),
    handle: async (message) => {
      manager.handled.push(message);
      manager.onHandle?.(message);
      return manager.result;
    },
  };

  const waits = [];
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      waits.push({ ms, resolve: (v = true) => resolve(v) });
      if (signal?.aborted) return resolve(false);
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    });

  // The wait that ends a take whose last frame never came; kept apart from `waits` so that it never shows up as the last one.
  const idles = [];
  const idleSleep = (ms, signal) =>
    new Promise((resolve) => {
      idles.push({ ms, resolve: (v = true) => resolve(v) });
      if (signal?.aborted) return resolve(false);
      signal?.addEventListener('abort', () => resolve(false), { once: true });
    });

  const approvals = createApprovals({ timeoutMs: 55_000 });
  const ui = createUi({ link, log: (l) => logs.push(l) });
  const turn = createTurn({ link, speech, manager, approvals, ui, log: (l) => logs.push(l), now: () => clock.t, sleep, idleSleep, takeIdleMs, confirmMs, unclearMs, reasonWaitMs, tone: () => Buffer.from('tone') });

  // What the device would show of what was sent: the last UI frame, with the approval over it if one came after it.
  const screen = () => {
    let shown = null;
    for (const s of link.sent) {
      if (s.type === TYPE.UI) shown = { ...parseUi(s.payload), approval: null };
      if (s.type === TYPE.APPROVAL_REQ) shown = { ...shown, approval: parseApprovalReq(s.payload) };
    }
    return shown;
  };
  const press = (button) => link.emit('frame', { type: TYPE.BUTTON, flags: 0, seq: 1, payload: Buffer.from([button]) });
  const verdict = (id, allow, reasonFollows = false) => {
    const p = Buffer.alloc(4);
    p.writeUInt16LE(id, 0);
    p[2] = allow ? 1 : 0;
    p[3] = reasonFollows ? 1 : 0;
    link.emit('frame', { type: TYPE.APPROVAL_RES, flags: 0, seq: 2, payload: p });
  };
  const up = (flags = 0, bytes = 640) => link.emit('audio-up', { type: TYPE.AUDIO_UP, flags, seq: 1, payload: Buffer.alloc(bytes, 7) });
  const take = (flags = 0) => {
    up(0);
    up(FLAG.EOS | flags);
  };
  const reasonTake = () => take(FLAG.REASON);
  const ask = (tool = 'Bash', input = { command: 'rm -rf build' }) => approvals.request({ tool, input, toolUseId: 't1' });
  return { clock, logs, link, speech, manager, approvals, ui, turn, waits, idles, screen, press, verdict, up, take, reasonTake, ask };
}

// ---- a take ------------------------------------------------------------------------------------------------------

test('a take shows TRANSCRIBING, then the words as CONFIRM while the intent is worked out, then goes to the manager', async () => {
  const t = setup();
  t.take();
  await settle();
  assert.equal(t.screen().state, UI_STATE.TRANSCRIBING);
  assert.equal(t.screen().project, 'walkie');
  assert.equal(t.speech.hears.length, 1);
  assert.equal(t.speech.hears[0].pcm.length, 1280, 'both frames of the take');

  t.speech.hears[0].words('帮我跑一下测试');
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.CONFIRM, '帮我跑一下测试'], 'shown before the intent is known');
  assert.deepEqual(t.manager.handled, []);

  t.speech.hears[0].ok('帮我跑一下测试');
  await settle();
  assert.deepEqual(t.manager.handled, [], 'the words stay up for confirmMs');
  assert.equal(t.waits.at(-1).ms, 1000);
  t.waits.at(-1).resolve();
  await settle();
  assert.deepEqual(t.manager.handled, [{ intent: 'to_claude', project: null, text: '帮我跑一下测试' }]);
  await t.turn.close();
});

test('hear is told the project and whether Claude is busy', async () => {
  const t = setup();
  t.manager.active = 'on-the-beat';
  t.manager.emit('working', { project: 'on-the-beat', tool: null, summary: '', startedAt: t.clock.t });
  t.take();
  await settle();
  const { opts } = t.speech.hears[0];
  assert.deepEqual([opts.currentProject, opts.busy], ['on-the-beat', true]);
  assert.notEqual(opts.classify, false, 'a take is a request: it is classified');
  await t.turn.close();
});

test('the side key in CONFIRM, while the intent is still being worked out, cancels the take: nothing reaches Claude', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].words('删掉整个目录');
  t.press(BUTTON.CANCEL);
  await settle();
  assert.equal(t.speech.hears[0].opts.signal.aborted, true, 'classification is given up');
  assert.deepEqual(t.manager.handled, []);
  assert.equal(t.screen().state, UI_STATE.IDLE);
  await t.turn.close();
});

test('the side key during the confirm window cancels it too', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].ok('删掉整个目录');
  await settle();
  t.press(BUTTON.CANCEL);
  await settle();
  t.waits.at(-1).resolve(); // too late: the window was ended by the cancel
  await settle();
  assert.deepEqual(t.manager.handled, []);
  assert.equal(t.screen().state, UI_STATE.IDLE);
  await t.turn.close();
});

test('a cancel that arrives after the words were handed over, or when no take is waiting, does nothing', async () => {
  const t = setup();
  t.press(BUTTON.CANCEL);
  t.take();
  await settle();
  t.speech.hears[0].ok('继续', { intent: 'continue', text: '' });
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  t.press(BUTTON.CANCEL);
  await settle();
  assert.deepEqual(t.manager.handled, [{ intent: 'continue', project: null, text: '' }]);
  await t.turn.close();
});

test('nothing heard is 没听清，再说一次 for 2 s and nothing for Claude, then the screen goes back to IDLE', async () => {
  for (const reason of ['empty', 'too-short', 'unavailable']) {
    const t = setup();
    t.take();
    await settle();
    t.speech.hears[0].unclear(reason);
    await settle();
    assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.ERROR, SAY_AGAIN], reason);
    assert.deepEqual(t.manager.handled, [], reason);
    assert.equal(t.waits.at(-1).ms, 2000);
    t.waits.at(-1).resolve();
    await settle();
    assert.equal(t.screen().state, UI_STATE.IDLE, reason);
    await t.turn.close();
  }
});

test('the 2 s that follow 没听清 do not wipe a screen that came after it', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].unclear();
  await settle();
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '', screen: '测试都过了', text: '', tagged: true, turns: 1, ms: 1, costUsd: 0 });
  t.waits.at(-1).resolve();
  await settle();
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.REPLY, '测试都过了']);
  await t.turn.close();
});

test('a hear that fails outright is 没听清 too, and the console is told', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].fail(new Error('boom'));
  await settle();
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.ERROR, SAY_AGAIN]);
  assert.ok(t.logs.some((l) => l.includes('boom')), t.logs.join('\n'));
  await t.turn.close();
});

test('takes are heard in the order they were made, one at a time', async () => {
  const t = setup();
  t.take();
  t.take();
  await settle();
  assert.equal(t.speech.hears.length, 1, 'the second waits for the first');
  t.speech.hears[0].ok('第一句');
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(t.speech.hears.length, 2);
  t.speech.hears[1].ok('第二句');
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.deepEqual(t.manager.handled.map((m) => m.text), ['第一句', '第二句']);
  await t.turn.close();
});

test('a take that was cut off by the link going down, or by the S3 starting over, is not glued to the next one', async () => {
  for (const event of ['down', 'hello']) {
    const t = setup();
    t.up(0);
    t.link.emit(event, {});
    t.take();
    await settle();
    assert.equal(t.speech.hears[0].pcm.length, 1280, event);
    await t.turn.close();
  }
});

test('what he says is passed on as classified: a switch carries its project, a speech result is shown and spoken', async () => {
  const t = setup();
  t.manager.result = { speak: '切到on-the-beat了。' };
  t.take();
  await settle();
  t.speech.hears[0].ok('换到 on the beat', { intent: 'switch_project', project: 'on-the-beat', text: '' });
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.deepEqual(t.manager.handled, [{ intent: 'switch_project', project: 'on-the-beat', text: '' }]);
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.REPLY, '切到on-the-beat了。']);
  assert.equal(t.speech.says[0].text, '切到on-the-beat了。');
  await t.turn.close();
});

test('words Claude does not act on leave the screen where it was, not on CONFIRM', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].ok('好的', { intent: 'to_claude', text: '' });
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(t.screen().state, UI_STATE.IDLE);
  await t.turn.close();
});

// ---- the manager's side ------------------------------------------------------------------------------------------

test('WORKING shows the tool and the elapsed time, and thinking when there is no tool yet', async () => {
  const t = setup();
  t.manager.emit('working', { project: 'walkie', tool: null, summary: '', startedAt: t.clock.t - 3000 });
  assert.deepEqual({ ...t.screen() }, { state: UI_STATE.WORKING, project: 'walkie', text: '思考中', elapsedMs: 3000, approval: null });
  t.clock.t += 4000;
  t.manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'npm test', startedAt: t.clock.t - 7000 });
  assert.deepEqual({ ...t.screen() }, { state: UI_STATE.WORKING, project: 'walkie', text: 'Bash: npm test', elapsedMs: 7000, approval: null });
  t.manager.emit('working', { project: 'walkie', tool: 'Read', summary: '', startedAt: t.clock.t });
  assert.equal(t.screen().text, 'Read');
  await t.turn.close();
});

test('a reply is shown as text in the REPLY screen and its voice is spoken; the idle after it leaves it up', async () => {
  const t = setup();
  t.manager.emit('working', { project: 'walkie', tool: null, summary: '', startedAt: t.clock.t });
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '测试都过了。', screen: '一共 570 个测试，全部通过。', text: '', tagged: true, turns: 1, ms: 1000, costUsd: 0.01 });
  t.manager.emit('idle', { project: 'walkie' });
  await settle();
  assert.deepEqual([t.screen().state, t.screen().project, t.screen().text], [UI_STATE.REPLY, 'walkie', '一共 570 个测试，全部通过。']);
  assert.equal(t.speech.says[0].text, '测试都过了。');
  assert.equal(t.link.plays.length, 1);
  assert.equal(t.link.plays[0].chunks.length, 1);
  await t.turn.close();
});

test('idle with no reply goes back to IDLE, and idle never covers a reply or an error', async () => {
  const t = setup();
  t.manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'ls', startedAt: t.clock.t });
  t.manager.emit('idle', { project: 'walkie' });
  assert.equal(t.screen().state, UI_STATE.IDLE);
  t.manager.emit('working', { project: 'walkie', tool: null, summary: '', startedAt: t.clock.t });
  t.manager.emit('failure', { kind: 'login', message: 'Claude 登录过期，回电脑上登录' });
  t.manager.emit('idle', { project: 'walkie' });
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.ERROR, 'Claude 登录过期，回电脑上登录']);
  await t.turn.close();
});

test('a notice is shown like a failure', async () => {
  const t = setup();
  t.manager.emit('notice', { kind: 'exited', text: 'Claude 退出了，再说话会自动接上。' });
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.ERROR, 'Claude 退出了，再说话会自动接上。']);
  await t.turn.close();
});

test('a change of project shows on the IDLE screen', async () => {
  const t = setup();
  t.manager.active = 'on-the-beat';
  t.manager.emit('project', { name: 'on-the-beat' });
  assert.deepEqual([t.screen().state, t.screen().project], [UI_STATE.IDLE, 'on-the-beat']);
  await t.turn.close();
});

test('the side key on a REPLY or an ERROR closes it: to IDLE, or back to WORKING when Claude is still at it', async () => {
  const t = setup();
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '', screen: '好了', text: '', tagged: true, turns: 1, ms: 1, costUsd: 0 });
  t.press(BUTTON.DISMISS);
  assert.equal(t.screen().state, UI_STATE.IDLE);
  t.manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'ls', startedAt: t.clock.t });
  t.manager.emit('failure', { kind: 'other', message: '出错了' });
  t.press(BUTTON.DISMISS);
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.WORKING, 'Bash: ls']);
  t.press(BUTTON.DISMISS); // nothing to close any more
  assert.equal(t.screen().state, UI_STATE.WORKING);
  await t.turn.close();
});

test('holding the side key in WORKING stops Claude, and what the manager says about it is shown and spoken', async () => {
  const t = setup();
  t.manager.result = { speak: '已停止。' };
  t.press(BUTTON.STOP);
  await settle();
  assert.deepEqual(t.manager.handled, [{ intent: 'stop' }]);
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.REPLY, '已停止。']);
  assert.equal(t.speech.says[0].text, '已停止。');
  await t.turn.close();
});

test('a reply with no voice text is shown but not spoken', async () => {
  const t = setup();
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '  ', screen: '好了', text: '', tagged: false, turns: 1, ms: 1, costUsd: 0 });
  await settle();
  assert.equal(t.screen().text, '好了');
  assert.equal(t.speech.says.length, 0);
  await t.turn.close();
});

// ---- the voice ---------------------------------------------------------------------------------------------------

const reply = (t, voice = '好了。') => t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice, screen: voice, text: '', tagged: true, turns: 1, ms: 1, costUsd: 0 });

test('replies are spoken one after the other, never two at once', async () => {
  const t = setup();
  t.link.holdPlays = true;
  reply(t, '第一条。');
  reply(t, '第二条。');
  await settle();
  assert.equal(t.link.plays.length, 1);
  t.link.plays[0].release();
  await settle();
  assert.deepEqual(t.speech.says.map((s) => s.text), ['第一条。', '第二条。']);
  assert.equal(t.link.plays.length, 2);
  await t.turn.close();
});

test('a new take ends the reply that is being spoken and drops the ones queued behind it', async () => {
  const t = setup();
  t.link.holdPlays = true;
  reply(t, '第一条。');
  reply(t, '第二条。');
  await settle();
  t.up(0); // he starts to talk
  await settle();
  assert.equal(t.speech.says[0].signal.aborted, true);
  assert.equal(t.speech.says.length, 1, 'the second one is never asked for');
  assert.equal(t.link.plays.length, 1);
  await t.turn.close();
});

test('the S3 reporting a reply stopped by its key lets go of the speech request and the queue', async () => {
  const t = setup();
  t.link.holdPlays = true;
  reply(t, '第一条。');
  reply(t, '第二条。');
  await settle();
  t.link.emit('played', { reason: 0, token: 1 });
  assert.equal(t.speech.says[0].signal.aborted, false, 'a reply that ended by itself is nothing to stop');
  t.link.emit('played', { reason: 1, token: 1 });
  await settle();
  assert.equal(t.speech.says[0].signal.aborted, true);
  assert.equal(t.speech.says.length, 1);
  await t.turn.close();
});

test('a reply that comes in while he is talking waits until he has finished', async () => {
  const t = setup();
  t.up(0);
  reply(t, '好了。');
  await settle();
  assert.equal(t.speech.says.length, 0, 'not while the mic is open');
  assert.equal(t.screen().text, '好了。', 'the text is shown at once');
  t.up(FLAG.EOS);
  await settle();
  assert.equal(t.speech.says.length, 1);
  await t.turn.close();
});

test('when no voice can speak, the text stays and a short tone plays', async () => {
  const t = setup();
  t.speech.sayError = new SpeechError('no provider could speak: openai: 429', { kind: 'unavailable', step: 'speak' });
  reply(t, '好了。');
  await settle();
  assert.equal(t.screen().text, '好了。');
  assert.deepEqual(t.link.tones, [Buffer.from('tone')]);
  assert.ok(t.logs.some((l) => l.includes('no provider could speak')), t.logs.join('\n'));
  await t.turn.close();
});

test('a reply that cannot be played because the S3 went away is logged and does not stop the next', async () => {
  const t = setup();
  const original = t.link.playStream;
  let first = true;
  t.link.playStream = async (...args) => {
    if (first) {
      first = false;
      throw new Error('the S3 is not connected');
    }
    return original(...args);
  };
  reply(t, '一。');
  reply(t, '二。');
  await settle();
  assert.deepEqual(t.speech.says.map((s) => s.text), ['一。', '二。']);
  assert.ok(t.logs.some((l) => l.includes('the S3 is not connected')), t.logs.join('\n'));
  await t.turn.close();
});

// ---- approvals ---------------------------------------------------------------------------------------------------

test('an approval is shown on the device and cleared from it when it is answered', async () => {
  const t = setup();
  t.manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'rm', startedAt: t.clock.t });
  const decided = t.ask();
  assert.deepEqual(t.screen().approval, { id: 1, tool: 'Bash', preview: t.screen().approval.preview });
  assert.match(t.screen().approval.preview, /rm -rf build/);
  t.verdict(1, true);
  assert.deepEqual(await decided, { behavior: 'allow' });
  assert.equal(t.screen().approval, null);
  assert.equal(t.screen().state, UI_STATE.WORKING, 'back to what was on the screen');
  await t.turn.close();
});

test('a screen change while an approval is up reaches the device when the approval is over, not before', async () => {
  const t = setup();
  const decided = t.ask();
  const before = t.link.sent.length;
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '', screen: '好了', text: '', tagged: true, turns: 1, ms: 1, costUsd: 0 });
  assert.equal(t.link.sent.length, before);
  t.verdict(1, false);
  assert.equal((await decided).behavior, 'deny');
  assert.deepEqual([t.screen().state, t.screen().text, t.screen().approval], [UI_STATE.REPLY, '好了', null]);
  await t.turn.close();
});

test('a plain denial carries no reason', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, false);
  assert.deepEqual(await decided, { behavior: 'deny', message: DENY_DEFAULT });
  await t.turn.close();
});

test('denying with a spoken reason: the verdict first, then the take', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  await settle();
  t.reasonTake();
  await settle();
  const call = t.speech.hears[0];
  assert.equal(call.opts.classify, false, 'the reason is not a command');
  call.ok('因为这个目录有没提交的东西');
  assert.deepEqual(await decided, { behavior: 'deny', message: denyWithReason('因为这个目录有没提交的东西') });
  await settle();
  assert.equal(t.speech.hears.length, 1, 'the take is heard once, as a reason');
  assert.deepEqual(t.manager.handled, [], 'and it does not go to Claude as a message');
  await t.turn.close();
});

test('denying with a spoken reason: the take first, then the verdict', async () => {
  const t = setup();
  const decided = t.ask();
  t.reasonTake();
  await settle();
  t.speech.hears[0].ok('因为这个目录有没提交的东西');
  await settle();
  t.verdict(1, false, true);
  assert.deepEqual(await decided, { behavior: 'deny', message: denyWithReason('因为这个目录有没提交的东西') });
  await t.turn.close();
});

test('the verdict can come while the reason is still being transcribed', async () => {
  const t = setup();
  const decided = t.ask();
  t.reasonTake();
  await settle();
  t.verdict(1, false, true);
  await settle();
  assert.equal(t.approvals.pending(), 1, 'it waits for the words');
  t.speech.hears[0].ok('先别删');
  assert.deepEqual(await decided, { behavior: 'deny', message: denyWithReason('先别删') });
  await t.turn.close();
});

test('a reason that was not heard denies without one', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  t.reasonTake();
  await settle();
  t.speech.hears[0].unclear();
  assert.deepEqual(await decided, { behavior: 'deny', message: DENY_DEFAULT });
  await t.turn.close();
});

test('a reason that never comes does not hold the approval: after reasonWaitMs it is denied without one', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  await settle();
  assert.equal(t.approvals.pending(), 1);
  assert.equal(t.waits.at(-1).ms, 10_000);
  t.waits.at(-1).resolve();
  assert.deepEqual(await decided, { behavior: 'deny', message: DENY_DEFAULT });
  await t.turn.close();
});

test('a reason that comes after its approval was answered is an ordinary take', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  await settle();
  t.waits.at(-1).resolve(); // nobody spoke in time: denied without a reason
  await decided;
  t.reasonTake();
  await settle();
  assert.notEqual(t.speech.hears[0].opts.classify, false, 'heard as a request');
  assert.equal(t.screen().state, UI_STATE.TRANSCRIBING);
  await t.turn.close();
});

test('a REASON take with no approval waiting is an ordinary take', async () => {
  const t = setup();
  t.reasonTake();
  await settle();
  assert.equal(t.screen().state, UI_STATE.TRANSCRIBING);
  assert.notEqual(t.speech.hears[0].opts.classify, false);
  await t.turn.close();
});

test('an approval timing out while its reason is awaited drops the reason instead of keeping it for the next approval', async () => {
  const t = setup();
  const first = t.ask('Bash', { command: 'ls' });
  t.reasonTake();
  await settle();
  t.approvals.denyAll('x'); // the first is over (timeout, abort, shutdown)
  await first;
  const second = t.ask('Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' });
  t.speech.hears[0].ok('这是给第一个的');
  await settle();
  t.verdict(2, false, true);
  await settle();
  assert.equal(t.approvals.pending(), 1, 'the second is still waiting for a reason of its own');
  t.waits.at(-1).resolve();
  assert.deepEqual(await second, { behavior: 'deny', message: DENY_DEFAULT });
  await t.turn.close();
});

test('an answer for an approval that is not the one on the screen changes nothing', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(9, true);
  await settle();
  assert.equal(t.approvals.pending(), 1);
  t.verdict(1, true);
  assert.equal((await decided).behavior, 'allow');
  await t.turn.close();
});

// ---- the device --------------------------------------------------------------------------------------------------

test('the device announcing it is switching firmware is logged and ends any speech', async () => {
  const t = setup();
  t.link.holdPlays = true;
  reply(t, '第一条。');
  await settle();
  t.press(BUTTON.SWITCHING);
  await settle();
  assert.equal(t.speech.says[0].signal.aborted, true);
  assert.ok(t.logs.some((l) => /switch/i.test(l)), t.logs.join('\n'));
  await t.turn.close();
});

test('close ends a take that is being heard and a reply that is being spoken, and settles', async () => {
  const t = setup();
  t.link.holdPlays = true;
  t.take();
  reply(t, '好了。');
  await settle();
  await t.turn.close();
  assert.equal(t.speech.hears[0].opts.signal.aborted, true);
  assert.equal(t.speech.says[0].signal.aborted, true);
  t.take();
  t.ask();
  t.reasonTake();
  await settle();
  assert.equal(t.speech.hears.length, 1, 'a closed turn takes no more, reasons included');
  t.approvals.denyAll(); // so that its 55 s timer does not keep the test process waiting
});

test('the side key before the words are known is not a cancel: there is nothing on the screen to cancel yet', async () => {
  const t = setup();
  t.take();
  await settle();
  t.press(BUTTON.CANCEL);
  await settle();
  assert.equal(t.speech.hears[0].opts.signal.aborted, false);
  assert.equal(t.screen().state, UI_STATE.TRANSCRIBING);
  t.speech.hears[0].ok('继续', { intent: 'continue', text: '' });
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(t.manager.handled.length, 1);
  await t.turn.close();
});

test('an approval that ends while its denial waits for a reason takes the wait with it', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  await settle();
  const wait = t.waits.at(-1);
  t.approvals.denyAll('x'); // timed out, aborted or shut down meanwhile
  await decided;
  wait.resolve(); // the wait must already have ended with it
  await settle();
  assert.equal(t.logs.some((l) => l.includes('no spoken reason')), false, t.logs.join('\n'));
  await t.turn.close();
});

test('the reason wait does not give up on a reason that has arrived and is being transcribed', async () => {
  const t = setup();
  const decided = t.ask();
  t.verdict(1, false, true);
  t.reasonTake();
  await settle();
  t.waits.at(-1).resolve(); // the 10 s are up, but the words are on their way
  await settle();
  assert.equal(t.approvals.pending(), 1);
  t.speech.hears[0].ok('先别删');
  assert.deepEqual(await decided, { behavior: 'deny', message: denyWithReason('先别删') });
  await t.turn.close();
});

// ---- what was heard, for whoever is watching (the console, a run that feeds the bridge a recording) ----------------------

test('every take says what the speech chain made of it: the words and the intent, or that nothing was clear', async () => {
  const t = setup();
  const heard = [];
  t.turn.on('heard', (h) => heard.push(h));
  t.take();
  await settle();
  t.speech.hears[0].ok('你好', { intent: 'to_claude' });
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(heard.length, 1);
  assert.deepEqual([heard[0].status, heard[0].transcript, heard[0].intent], ['ok', '你好', 'to_claude']);
  t.take();
  await settle();
  t.speech.hears[1].unclear('too-short');
  await settle();
  assert.equal(heard.length, 2);
  assert.deepEqual([heard[1].status, heard[1].reason], ['unclear', 'too-short']);
  await t.turn.close();
});

test('a hear that fails outright is heard as unclear, and one that was cancelled is not heard at all', async () => {
  const t = setup();
  const heard = [];
  t.turn.on('heard', (h) => heard.push(h));
  t.take();
  await settle();
  t.speech.hears[0].fail(new Error('network down'));
  await settle();
  assert.deepEqual(heard, [{ status: 'unclear', reason: 'failed', transcript: '' }]); // the shape speech.hear gives an unclear take
  t.take();
  await settle();
  await t.turn.close(); // aborts the hear that is waiting
  assert.equal(heard.length, 1);
});

test('a spoken reason for a denial is not a take that was heard', async () => {
  const t = setup();
  const heard = [];
  t.turn.on('heard', (h) => heard.push(h));
  const pending = t.ask();
  await settle();
  t.verdict(1, false, true);
  t.reasonTake();
  await settle();
  t.speech.hears[0].ok('因为不想改');
  await settle();
  await pending;
  assert.deepEqual(heard, []);
  await t.turn.close();
});

test('a listener that throws does not stop the take, and the console is told', async () => {
  const t = setup();
  t.turn.on('heard', () => {
    throw new Error('listener bug');
  });
  t.take();
  await settle();
  t.speech.hears[0].ok('你好');
  await settle();
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(t.manager.handled.length, 1);
  assert.ok(t.logs.some((l) => /heard listener failed: listener bug/.test(l)));
  await t.turn.close();
});

test('on() gives back the way to stop listening', async () => {
  const t = setup();
  const heard = [];
  const off = t.turn.on('heard', (h) => heard.push(h));
  off();
  t.take();
  await settle();
  t.speech.hears[0].unclear();
  await settle();
  assert.deepEqual(heard, []);
  await t.turn.close();
});

// ---- review fixes ------------------------------------------------------------------------------------------------

test('a screen Claude asks for while CONFIRM is up is held back, so the side key still cancels, and it shows when the take is over', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].ok('别改那个文件');
  await settle();
  t.manager.emit('working', { project: 'walkie', tool: 'Edit', summary: 'a.js', startedAt: t.clock.t });
  assert.equal(t.screen().state, UI_STATE.CONFIRM, 'the words he may still cancel stay on the screen');
  t.press(BUTTON.CANCEL);
  await settle();
  assert.deepEqual(t.manager.handled, [], 'nothing reaches Claude');
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.WORKING, 'Edit: a.js'], 'the screen Claude asked for comes up when the take is over');
  await t.turn.close();
});

test('a screen held back during CONFIRM comes up as soon as the words are handed over, not after Claude has answered', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].ok('继续');
  await settle();
  t.manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'npm test', startedAt: t.clock.t });
  assert.equal(t.screen().state, UI_STATE.CONFIRM);
  let release;
  t.manager.handle = async (m) => (t.manager.handled.push(m), new Promise((resolve) => (release = () => resolve({}))));
  t.waits.at(-1).resolve();
  await settle();
  assert.equal(t.manager.handled.length, 1);
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.WORKING, 'Bash: npm test'], 'shown while Claude is still at it');
  release();
  await t.turn.close();
});

test('a reply that lands during CONFIRM is shown after the cancel, with its text', async () => {
  const t = setup();
  t.take();
  await settle();
  t.speech.hears[0].ok('算了');
  await settle();
  t.manager.emit('reply', { project: 'walkie', kind: 'reply', voice: '做完了。', screen: '做完了。', text: '', tagged: true, turns: 1, ms: 1, costUsd: 0 });
  assert.equal(t.screen().state, UI_STATE.CONFIRM);
  t.press(BUTTON.CANCEL);
  await settle();
  assert.deepEqual([t.screen().state, t.screen().text], [UI_STATE.REPLY, '做完了。']);
  await t.turn.close();
});

test('a take whose last frame never came is dropped after takeIdleMs: a reply that waits for it is spoken, and the next take is not glued to it', async () => {
  const t = setup();
  t.up(0);
  reply(t, '先说这个。');
  await settle();
  assert.equal(t.speech.says.length, 0, 'the reply waits for the take that is open');
  assert.equal(t.idles.at(-1).ms, 500);
  t.idles.at(-1).resolve();
  await settle();
  assert.deepEqual(t.speech.says.map((s) => s.text), ['先说这个。'], 'the take went quiet, so the reply is let through');
  assert.ok(t.logs.some((l) => /went quiet/.test(l)), 'and it is logged');
  t.take();
  await settle();
  assert.equal(t.speech.hears.length, 1);
  assert.equal(t.speech.hears[0].pcm.length, 1280, 'two frames, not the half take and then two');
  await t.turn.close();
});

test('every frame of a take starts the wait again, and the last frame ends it', async () => {
  const t = setup();
  t.up(0);
  const first = t.idles.at(-1);
  t.up(0);
  assert.equal(t.idles.length, 2);
  first.resolve(); // the first wait was replaced: it must not end the take
  await settle();
  assert.equal(t.speech.hears.length, 0);
  t.up(FLAG.EOS);
  await settle();
  assert.equal(t.speech.hears.length, 1, 'the take still ends normally');
  assert.equal(t.speech.hears[0].pcm.length, 1920);
  t.idles.at(-1).resolve(); // a wait that outlived its take does nothing
  await settle();
  assert.equal(t.logs.some((l) => /went quiet/.test(l)), false);
  await t.turn.close();
});
