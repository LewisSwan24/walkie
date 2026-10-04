// The voice turn (spec 4): everything between the front key and Claude, and between Claude and the speaker. It listens to the
// device (takes, keys, answers to approvals), to the speech chain, to the session manager and to the approvals queue, and
// decides what the screen shows and what is said. How a provider is asked and how a process is run are not its business.
//
//   a take      TRANSCRIBING, then CONFIRM (the words for confirmMs while the intent is worked out; the side key cancels),
//               then manager.handle
//   the manager WORKING, REPLY (and the voice), ERROR, IDLE
//   approvals   the APPROVAL screen; the keys answer it, and a held front key adds a spoken reason to a denial
//
// It says one thing about itself: 'heard', with the speech chain's result for each take that was heard ({status: 'ok', transcript,
// intent, ...} or {status: 'unclear', reason}); a take that was cancelled is not heard.
//
// Takes are heard one at a time, in the order they were made. A reply that is being spoken ends when he starts to talk, and
// one that comes in while he talks waits for him to finish: the mic would hear it.
import { EventEmitter } from 'node:events';
import { TakeCollector } from '../audio/takes.js';
import { UI_STATE } from '../link/messages.js';
import { isAbort } from '../speech/errors.js';
import { failureTone } from '../speech/speech.js';

export const SAY_AGAIN = '没听清，再说一次';
const THINKING = '思考中';

// Resolves true after `ms`, or false at once when `signal` aborts.
export const sleepMs = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// link: the S3. speech: createSpeech's hear and say. manager: the session manager. approvals: the queue of tool calls waiting
// for a yes. ui: createUi over the same link. `sleep` and `now` are the clocks; `tone` is the sound for a reply that has no voice.
export function createTurn({ link, speech, manager, approvals, ui, log = () => {}, now = () => Date.now(), sleep = sleepMs, idleSleep = sleepMs, takeIdleMs = 500, confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, tone = failureTone }) {
  const collector = new TakeCollector();
  const events = new EventEmitter();
  const life = new AbortController(); // close() ends everything that is waiting
  const work = { busy: false, tool: null, summary: '', startedAt: 0 }; // what Claude is doing, for the WORKING screen
  let shown = 'idle'; // what this module last put on the screen: idle | transcribing | confirm | working | reply | error
  let epoch = 0; // counts the screens put up, so that a timer can tell whether its screen is still the one showing
  let current = null; // the take being heard: {ctl, phase: 'hearing' | 'confirm'}
  let held = null; // the screen Claude asked for while CONFIRM was up: it waits for the take to leave CONFIRM
  let idle = null; // the wait that ends a take whose last frame never came
  let speechCtl = new AbortController(); // everything queued to be spoken, and what is being spoken
  let turnTail = Promise.resolve();
  let speakTail = Promise.resolve();
  const talkWaiters = new Set(); // replies waiting for the take that is open to end
  const reasons = new Map(); // approval id -> {text}: a spoken reason; text is null while it is being transcribed
  const verdicts = new Map(); // approval id -> {ctl}: a denial that waits for its spoken reason
  const closed = () => life.signal.aborted;
  // A listener that throws must not take the turn down with it.
  function tell(name, payload) {
    try {
      events.emit(name, payload);
    } catch (err) {
      log(`turn: a ${name} listener failed: ${err?.message ?? err}`);
    }
  }

  // ---- the screen

  function show(kind, state, fields = {}) {
    if (closed()) return;
    shown = kind;
    epoch++;
    ui.show(state, { project: manager.project(), ...fields });
  }
  const showIdle = () => show('idle', UI_STATE.IDLE);
  const workingText = () => (work.tool ? `${work.tool}${work.summary ? `: ${work.summary}` : ''}` : THINKING);
  const showWorking = () => show('working', UI_STATE.WORKING, { text: workingText(), elapsedMs: Math.max(0, now() - work.startedAt) });
  const restore = () => (work.busy ? showWorking() : showIdle());
  // A screen that Claude's events ask for. While the words he may still cancel are on the S3 it keeps them: replacing
  // CONFIRM would take the side key's cancel away (the S3 sends BUTTON_CANCEL only over CONFIRM). The latest one waits.
  function driven(fn) {
    if (current?.phase === 'confirm') held = fn;
    else fn();
  }
  function flushHeld() {
    const fn = held;
    held = null;
    if (fn && !closed()) fn();
  }
  const showError = (text) => show('error', UI_STATE.ERROR, { text });

  // A line for him to read, and the same line spoken.
  function announce(text) {
    show('reply', UI_STATE.REPLY, { text });
    speak(text);
  }

  // ---- the voice

  const cancelSpeech = () => {
    speechCtl.abort();
    speechCtl = new AbortController();
  };

  function afterTalk(signal) {
    if (!collector.open) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        talkWaiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      talkWaiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  const releaseTalk = () => {
    for (const done of [...talkWaiters]) done();
  };

  function speak(text) {
    const { signal } = speechCtl;
    speakTail = speakTail.then(() => play(text, signal)).catch((err) => log(`turn: speaking failed: ${err?.message ?? err}`));
  }

  async function play(text, signal) {
    await afterTalk(signal);
    if (signal.aborted) return;
    let audio;
    try {
      ({ audio } = await speech.say(text, { signal }));
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      log(`turn: ${err.message}`);
      if (err.kind === 'unavailable') await link.playAudio(tone(), { signal }).catch((e) => log(`turn: the tone could not be played: ${e.message}`));
      return;
    }
    try {
      await link.playStream(audio, { signal });
    } catch (err) {
      if (!isAbort(err) && !signal.aborted) log(`turn: the reply could not be played: ${err.message}`);
    }
  }

  // ---- a take

  function onUp(frame) {
    if (closed()) return;
    const wasOpen = collector.open;
    const pcm = collector.push(frame);
    if (!wasOpen) cancelSpeech(); // he is talking: what is being said, or waits to be, ends
    watchTake();
    if (!pcm) return;
    releaseTalk();
    const approval = collector.lastReason ? approvals.current() : null;
    if (approval) void reasonTake(pcm, approval.id);
    else enqueue(pcm);
  }

  // About one S3-to-PC frame in a thousand arrives damaged, and the last frame of a take may be that one. A take that goes
  // quiet for takeIdleMs is dropped, so that replies are not held for ever and the next take does not start from half of it.
  function watchTake() {
    idle?.abort();
    idle = null;
    if (!collector.open || closed()) return;
    const ctl = new AbortController();
    idle = ctl;
    void idleSleep(takeIdleMs, ctl.signal).then((expired) => {
      if (!expired || idle !== ctl) return;
      idle = null;
      if (!collector.open) return;
      log('turn: a take went quiet without its last frame and is dropped');
      collector.reset();
      releaseTalk();
    });
  }

  function enqueue(pcm) {
    turnTail = turnTail.then(() => ordinaryTake(pcm)).catch((err) => log(`turn: ${err?.stack ?? err}`));
  }

  async function ordinaryTake(pcm) {
    if (closed()) return;
    const ctl = new AbortController();
    const onLife = () => ctl.abort();
    life.signal.addEventListener('abort', onLife, { once: true });
    const mine = { ctl, phase: 'hearing' };
    current = mine;
    show('transcribing', UI_STATE.TRANSCRIBING);
    let window = null;
    try {
      const heard = await speech.hear(pcm, {
        currentProject: manager.project(),
        busy: work.busy,
        signal: ctl.signal,
        onTranscript: (text) => {
          mine.phase = 'confirm';
          show('confirm', UI_STATE.CONFIRM, { text });
          window = sleep(confirmMs, ctl.signal);
        },
      });
      tell('heard', heard);
      if (heard.status !== 'ok') return unclear();
      await window;
      if (ctl.signal.aborted) return cancelled();
      current = null; // from here the words are Claude's
      flushHeld();
      const done = await manager.handle({ intent: heard.intent, project: heard.project, text: heard.text });
      if (done?.speak) announce(done.speak);
      else if (shown === 'confirm') restore();
    } catch (err) {
      if (isAbort(err)) return cancelled();
      log(`turn: ${err?.message ?? err}`);
      tell('heard', { status: 'unclear', reason: 'failed', transcript: '' });
      unclear();
    } finally {
      life.signal.removeEventListener('abort', onLife);
      if (current === mine) current = null;
      flushHeld();
    }
  }

  function cancelled() {
    if (closed()) return;
    log('turn: the take was cancelled from the device');
    current = null;
    if (held) flushHeld();
    else restore();
  }

  function unclear() {
    showError(SAY_AGAIN);
    const mine = epoch;
    void sleep(unclearMs, life.signal).then((elapsed) => {
      if (elapsed && epoch === mine) restore();
    });
  }

  // ---- a spoken reason for a denial. The device sends the answer (APPROVAL_RES) when he lets go of the key, and the take
  // ends a moment later or a moment sooner, so the two meet here in either order.

  async function reasonTake(pcm, id) {
    reasons.set(id, { text: null });
    let text = '';
    try {
      const heard = await speech.hear(pcm, { currentProject: manager.project(), busy: work.busy, classify: false, signal: life.signal });
      if (heard.status === 'ok') text = heard.transcript;
    } catch (err) {
      if (!isAbort(err)) log(`turn: the reason could not be heard: ${err?.message ?? err}`);
    }
    const reason = reasons.get(id);
    if (!reason) return; // its approval ended while it was being heard
    reason.text = text;
    settle(id);
  }

  // Answers the denial of `id` once both the verdict and the words are in.
  function settle(id) {
    const verdict = verdicts.get(id);
    const reason = reasons.get(id);
    if (!verdict || !reason || reason.text === null) return;
    verdict.ctl.abort();
    verdicts.delete(id);
    reasons.delete(id);
    approvals.answer(id, { allow: false, reason: reason.text });
  }

  function onVerdict({ id, allow, reasonFollows }) {
    if (allow || !reasonFollows) {
      if (!approvals.answer(id, { allow })) log(`turn: an answer came for approval ${id}, which is not the one on the screen`);
      return;
    }
    verdicts.get(id)?.ctl.abort();
    const verdict = { ctl: new AbortController() };
    verdicts.set(id, verdict);
    void sleep(reasonWaitMs, verdict.ctl.signal).then((elapsed) => {
      if (!elapsed || reasons.has(id)) return; // answered, or the words are on their way
      verdicts.delete(id);
      log(`turn: no spoken reason came for approval ${id}`);
      approvals.answer(id, { allow: false });
    });
    settle(id);
  }

  function forget(id) {
    verdicts.get(id)?.ctl.abort();
    verdicts.delete(id);
    reasons.delete(id);
  }

  // ---- wiring

  manager.on('working', (w) => {
    Object.assign(work, { busy: true, tool: w.tool, summary: w.summary, startedAt: w.startedAt });
    driven(showWorking);
  });
  manager.on('idle', () => {
    work.busy = false;
    if (shown === 'working') showIdle();
  });
  manager.on('reply', (r) => {
    driven(() => show('reply', UI_STATE.REPLY, { project: r.project, text: r.screen || r.voice }));
    if (r.voice?.trim()) speak(r.voice);
  });
  manager.on('failure', (f) => driven(() => showError(f.message)));
  manager.on('notice', (n) => driven(() => showError(n.text)));
  manager.on('project', () => {
    if (shown === 'idle') showIdle();
  });

  approvals.on('show', (r) => ui.approval({ id: r.id, tool: r.tool, preview: r.preview }));
  approvals.on('clear', ({ id }) => {
    forget(id);
    ui.approvalClear(id);
  });

  ui.on('cancel', () => {
    if (current?.phase === 'confirm') current.ctl.abort();
  });
  ui.on('stop', () => {
    manager
      .handle({ intent: 'stop' })
      .then((done) => done?.speak && announce(done.speak))
      .catch((err) => log(`turn: stopping failed: ${err?.message ?? err}`));
  });
  ui.on('dismiss', () => {
    if (shown === 'reply' || shown === 'error') restore();
  });
  ui.on('switching', () => {
    log('turn: the device is switching to its other firmware');
    cancelSpeech();
  });
  ui.on('verdict', onVerdict);

  link.on('audio-up', onUp);
  link.on('played', (p) => {
    if (p.reason === 1) cancelSpeech(); // stopped from the S3's key: nothing more of it, nor of what waits behind it
  });
  link.on('down', () => {
    idle?.abort();
    collector.reset();
    releaseTalk();
    cancelSpeech();
  });
  link.on('hello', () => {
    idle?.abort();
    collector.reset();
    releaseTalk();
  });

  async function settled() {
    let tails;
    do {
      tails = [turnTail, speakTail];
      await Promise.all(tails);
    } while (tails[0] !== turnTail || tails[1] !== speakTail);
  }

  return {
    settled,
    on(name, fn) {
      events.on(name, fn);
      return () => events.off(name, fn);
    },
    // Ends the take that is being heard and the speech, and resolves when they have let go.
    async close() {
      life.abort();
      idle?.abort();
      cancelSpeech();
      for (const verdict of verdicts.values()) verdict.ctl.abort();
      verdicts.clear();
      reasons.clear();
      releaseTalk();
      await settled();
    },
  };
}
