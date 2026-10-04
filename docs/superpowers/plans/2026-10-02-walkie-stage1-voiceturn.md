# Walkie Stage 1, plan 4 of 4: The voice turn. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One whole voice turn on the S3, from the key to the speaker. He holds the front key and speaks; the S3 shows that it is listening, what it heard and what Claude is doing; the reply is shown as text and spoken; a tool call that needs his yes or no asks on the screen and the two keys answer it, a held front key adding a spoken reason to a no; and both keys held for three seconds switch the S3 back to on-the-beat. The last tasks run all of it on the real S3, ending with a recorded utterance fed in as the microphone through OpenAI and the real `claude`.

**Architecture:** On the firmware, the screen logic is pure C++ in `firmware/lib/ui` and is compiled and tested on the PC like the protocol is: `gesture` and `keyscript` turn the two key states into taps, holds and chords, `text` makes any bytes into lines of at most 30 cells, and `machine` is the state machine that decides the screen and the actions (talk, stop, answer, switch) from gestures and from what the PC sent. `screen.cpp` draws a `ui::View` through an off-screen canvas, which TEST SNAP can read back, and `main.cpp`'s UI loop joins keys, machine, link and audio. On the bridge, `ui` owns what the S3's screen shows and the approval over it, `turn` joins the device, the speech chain, the session manager and the approvals queue into one voice turn, `startBridge` wires everything and `bin/walkie.js` runs it, `console` prints it, and `walkie-dev` gains `press`, `ui`, `snap` and `inject` so that every screen and a whole turn can be driven and looked at with nobody touching the S3.

**Tech Stack:** C++11 on PlatformIO (`espressif32@6.13.0`, Arduino, `M5Unified@0.2.23`, `M5GFX@0.2.30`, font `efontCN_16`), the pure logic compiled by `g++ -std=gnu++11 -Wall -Wextra -Werror` through `firmware/host/run.mjs`; Node 24 (ESM, `node:test`, `node:zlib` for the PNG); `serialport` stays the bridge's only dependency; Python 3 standard library for `protocol/gen_vectors.py`. No new dependency anywhere.

**Spec:** `docs/superpowers/specs/2026-09-29-walkie-design.md`. This plan implements §6.2 (states, buttons, test hooks), the `ui`, `console` and `main` parts of §6.3, the UI, BUTTON and APPROVAL frames of §6.6, the one voice turn of §4 (all six steps), the error rows of §8 that concern the device, and the end-to-end line of §9. It needs plans 1 to 3: the `Link`, the take collector and the audio transport (plan 1), `createSpeech` (plan 2), and the session manager, the approvals queue and the permission server (plan 3). It changes them only by addition, with four exceptions it makes on purpose: `FLAG.REASON` in `frame.js` and `frame.h` with `TakeCollector.lastReason` (Task 1), the `onTranscript` hook of `speech.hear` (Task 8), the firmware's `onTest` handler, which now gets the op's argument bytes instead of a frame count (Task 1), and the `Link`, which pings at once when the S3's HELLO arrives (Task 12).

**Stage 1 is four plans.** Each one leaves working, tested software:

1. **The link** (landed 2026-09-30): the protocol, the firmware's link and audio transport, the bridge's `link`, the flash and boot tools, a developer CLI, and mic gain calibration.
2. **Speech** (landed 2026-10-01): the OpenAI and Gemini adapters, the provider chain, the loudness chain, intent, configuration and the keys.
3. **Claude** (landed 2026-10-01): the session manager, the permission MCP over HTTP, `<voice>` extraction.
4. **The voice turn** (this plan): the firmware's state machine, screens, key gestures, approvals and SWITCH_CONFIRM, the remaining TEST hooks, and the bridge's `ui`, `turn`, `console` and `main`, which join everything into one voice turn.

Tasks 1 to 11 are code, host tests and a firmware build: they need no S3, no network and no `claude`, and each can go to a worker. Task 12 puts the firmware on the real S3 and runs the screens and keys on it; Task 13 is the end-to-end gates and is mostly him. Both are main-thread work. Task 14 edits the README, the spec and `frames.md`.

**How this plan was checked.** Plan 4 was built once, task by task, before it was written down. The code blocks below are those commits' files, and each task's *Expected* lines are what the commands printed when its tests were put on the commit before it (red) and the rest of its files after them (green) in a clean clone. Replaying the whole plan onto the commit that plan 3 landed on (`bd36963`) gives, task by task, the tree of the original commits, and the S3 has run the result: gate H (Task 12, 11 scenes), gate I (the whole turn through OpenAI and the real `claude`), gate J (the same through Gemini with OpenAI refused) and gate K (SWITCH_CONFIRM by hand), each with his fresh yes. Task 13 records what they printed so that they can be run again.

The new code was also attacked by hand: a condition inverted, a boundary moved by one, a step left out, one mutant at a time, and the tests run against each. Every mutant that survived got a test, in the task that owns the code, before this plan was written, except nine in the firmware that change nothing a test can see. Four are guards that only keep a read inside the buffer while the check after them refuses the same payload (`parseKeys`' `n < 1`, the two header-length forms in `parseUi`, `parseApprovalReq`'s `n < 3`). Five are in the state machine: `Listening` above `Offline` in `screen()` (a live talk cannot exist offline, the link loss drops it), `answer`'s `reasonFollows` (no caller passes true: the reason's verdict is pushed by the end of the take), the resets of `page_` and `hasElapsed_` in `clearBase` (`onUi` sets both before anything reads them) and `switching_ = false` on opening SWITCH_CONFIRM (switching implies it is open).

## Global Constraints

- **The S3, the network and the real `claude` are touched only in Tasks 12 and 13, and each action only with his fresh yes.** Opening COM8 or writing to it, a live OpenAI or Gemini call, and a run of the real `claude` each use his hardware, his keys or his quota. Before each such step ask him with the AskUserQuestion tool and say exactly what will be called, what it costs and which session it leaves in history. Only a clear yes in that answer counts: not 「继续」, not an earlier yes, not a yes for another run. A re-run after a fix is a new question. Tasks 1 to 11 contain no step that does any of this.
- **`%APPDATA%\walkie\keys.env` is never read, listed or printed.** `OPENAI_API_KEY` and `GEMINI_API_KEY` of the same name in the environment win over the file (`loadKeys`), which is how gate J refuses OpenAI without touching the file.
- **The S3 is flashed only by `node tools/flash.mjs`** (spec 6.7), which reads the partition table first, refuses unless it matches §3 and writes app1 and otadata only; `pio run -t upload` is routed to it, `-t erase` and `uploadfs` are refused, and `pio test` is never run against the S3. Nothing writes 0x0, 0x8000, app0 or NVS. A step that leaves the S3 in app0 ends with `node tools/boot.mjs app1`.
- **Keys and screens, from spec 6.2.** KEY1 is the front key (G11), KEY2 the side key (G12). A press released within 300 ms is short; 300 ms or more is a hold. Both keys down within 150 ms of each other is a chord, which never starts a talk. Side held 1 s in WORKING stops Claude. Both keys held 3 s open SWITCH_CONFIRM and the front key confirms. In APPROVAL the front key allows, the side key denies, and a held front key denies and records a spoken reason. The display is 240x135 with the font `efontCN_16`: 8 pixels to an ASCII character, 16 to a Chinese one, so a line is 30 cells; the layout is a 16-pixel header, six lines of body (five in APPROVAL) and a 16-pixel hint line.
- **Limits on the wire.** A payload is at most 1024 bytes (`MAX_PAYLOAD`). UI text is cut at 900 bytes, an approval preview at 900 bytes (spec: 300 characters), a tool name at 64 and a project name at 60; a cut is made on a character and ends with `…`. A key script has 1 to 16 steps of at most 65535 ms. TEST MIC_PCM carries 2 to 1000 bytes, an even number. The firmware's inject FIFO holds `1u << 19` bytes, 16.4 s at 16 kHz.
- **The S3 never parses free text.** UI, APPROVAL_REQ and the TEST payloads are binary with fixed layouts (`protocol/frames.md`, `protocol/vectors.json`); its own logs leave as LOG frames. Every parser refuses a payload that is cut short and skips a field it does not know.
- **The firmware's pure code (`firmware/lib/ui`, `firmware/lib/proto`) includes no Arduino or M5 header, allocates nothing, writes only into buffers it is given and never writes past them.** It compiles under `-Wall -Wextra -Werror` as C++11. Time is `uint32_t` milliseconds and may wrap: every comparison is `(int32_t)(a - b)`.
- **What he says does not reach a log line.** Log lines (`log()`, the S3's LOG frames) carry what happened, with ids, sizes and times, never his words or Claude's text. His words and the replies reach the screen, the speaker and the console's own `[heard]`, `[reply]` and `[approval]` lines, which exist to show them.
- **Frames are lost on this link, and the code expects it** (measured 2 Oct 2026, Task 13): PC to S3, 283 MIC_PCM frames handed to the port at once lost 50 (the S3's receive queue is 16 KB), four frames then a 5 ms pause lost none; S3 to PC, about one frame of about 1 KB in a thousand arrives damaged, for a cause that was not found. So the recording is paced into the S3 (`injectTake`, Task 11) and a snapshot is asked for again (`takeSnap`, Task 12). A lost BUTTON or APPROVAL_RES is not recovered: an approval then falls back on its 55 s deny.
- **`walkie` is never run without `--command` in a test or a smoke run.** `claude.prewarm` defaults to true, so a bare `bridge/bin/walkie.js` starts the real `claude` for the active project. The stand-in is `bridge/test/claude/fake-claude.js`, and its path is given to node as `C:/…`, not the `/c/…` that Git Bash prints.
- Node 24, ESM, `node:test`. The bridge's dependencies stay `serialport` alone. A test that depends on a time limit uses an injected clock or `sleep`, or `t.mock.timers`; no unit test waits in real time. The one exception is `bridge/test/claude/process-real.test.js`, from plan 3, whose 3 MB test now and then fails with `EPERM` while it removes its temporary folder when the whole suite runs at once; it passes alone and on a second run (deferred in plan 3).
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise. Commit by explicit path (`git add <files>`), never `git add -A` or `git commit -a`. No push and no amend. The commands below name the commit's model as Claude Sonnet 5.5 in the `Co-Authored-By:` line; change the name if another model writes the commit, and a session on a model that is not Claude leaves the line out.

### Where this plan decides what the spec leaves open

Task 14 records each of these in the spec.

1. **A UI frame is a state byte plus tagged fields** (project, text, elapsed ms), not JSON as spec 6.6 first said: the S3 needs no parser for it, and a tag it does not know is skipped. Pinned in Task 1.
2. **A take recorded as the reason for a denial is marked by flag bit 3 (`REASON`, 0x08) on its last frame.** The bridge pairs it with the approval's answer in either order (Task 8).
3. **SWITCH_CONFIRM is above OFFLINE** in the priority `SwitchConfirm > Offline > Listening > Approval > the PC's screen`, so the S3 can always be switched back to on-the-beat, bridge or no bridge; it confirms on a front tap. A UI frame from the bridge ends an approval, and while one is up the bridge holds screen changes back (Tasks 4 and 7).
4. **Takes are processed one at a time, in the order they were made.** A reply that is being spoken ends at the first frame of a new take, and a reply that arrives while a take is open waits for it: the mic would hear the speaker (Task 8).
5. **A REASON take with no approval waiting is an ordinary take** (Task 8).
6. **An approval preview too long for the screen shows its head and says that there is more**; the console shows all of it (Task 4).
7. **The first 300 ms of a take are kept.** The mic starts filling a 400 ms pre-roll when the front key goes down, and the take is committed when the key has been held 300 ms; a take ended before that is dropped without a frame. With a reply playing there is no pre-roll, because the speaker owns the codec (Task 5).

## Review Focus

What a person using this is most likely to meet, that the spec does not spell out. Each line names the tests that pin it, titled in the task that owns the code.

1. **Text that does not fit or cannot be drawn:** a reply of thousands of characters, a long word with no space, emoji and symbols the font lacks, control characters, malformed UTF-8, a character of four bytes at the cut. He sees the head of it cut on a character, a `?` for what the font cannot draw, a REPLY in pages he turns with the side key, and the console has all of it; nothing overruns a buffer or throws. Pinned in Task 1 by `text that fits is left alone, and text that does not is cut on a character with an ellipsis` and `a character of four bytes is never split`; in Task 3 by `sanitizeTurnsWhatTheFontCannotDrawIntoAQuestionMark`, `sanitizeNeverWritesPastItsBufferOrEndsInHalfACharacter` and `wrapAlwaysMakesProgressEvenWhenACharacterIsWiderThanTheLine`; in Task 4 by `aHugeTextIsKeptWithinTheBuffersAndTheLineLimit`; in Task 7 by `text that is too long for a frame is cut on a character and never makes show throw`.
2. **The cable comes out, or the S3 restarts, in the middle of a take, a reply or an approval.** The S3 shows OFFLINE and drops the talk and the approval it had; the bridge does not glue the half take to the next one, a reply that cannot be played does not stop the next, and when the S3 is back it is sent the screen again, the approval included. With no S3 on USB the bridge runs on and says so once. Pinned in Task 4 by `loosingTheLinkEndsATalkClearsAnApprovalAndForgetsTheOldScreen` and `anApprovalIsClearedWhenTheLinkGoes`; in Task 7 by `when the device (re)connects, the screen is sent again, the approval if there is one`; in Task 8 by `a take that was cut off by the link going down, or by the S3 starting over, is not glued to the next one` and `a reply that cannot be played because the S3 went away is logged and does not stop the next`; in Task 9 by `with no S3 on USB the bridge runs on, says so once, and closes cleanly`.
3. **He talks while a reply is being spoken, or says two things quickly.** The reply stops at his first frame and the ones queued behind it are dropped; a reply that arrives while he is talking waits for him to finish; two takes are heard one after the other and answered in order; the S3 reporting that its key stopped a reply lets go of the speech and the queue. A prepared take does not cut a reply that is playing until the take is committed. Pinned in Task 8 by `a new take ends the reply that is being spoken and drops the ones queued behind it`, `a reply that comes in while he is talking waits until he has finished`, `takes are heard in the order they were made, one at a time` and `the S3 reporting a reply stopped by its key lets go of the speech request and the queue`; in Task 5 by `audioAPreparedTakeLeavesAPlayingReplyAloneUntilItIsCommitted`.
4. **A no with a spoken reason, in every order it can arrive.** The verdict can come before or after the take, while the reason is still being transcribed, or the reason is not understood, or never comes: it is a plain denial after `reasonWaitMs`, and Claude is never left holding the approval. A reason that comes after its approval was answered, or with no approval waiting, is an ordinary take. Pinned in Task 8 by `denying with a spoken reason: the verdict first, then the take`, `denying with a spoken reason: the take first, then the verdict`, `the verdict can come while the reason is still being transcribed`, `a reason that was not heard denies without one`, `a reason that never comes does not hold the approval: after reasonWaitMs it is denied without one`, `a reason that comes after its approval was answered is an ordinary take` and `a REASON take with no approval waiting is an ordinary take`; in Task 4 by `aReasonTakeKeepsTheIdItStartedWithEvenIfTheApprovalWasClearedMeanwhile`.
5. **A screen change arrives while an approval is on the screen** (Claude's status moves on, a reply lands). The S3 takes any UI frame as the end of an approval, so the bridge holds the change back and sends the screen as it is by then when the approval is over; an answer for an approval that is not the one on the screen changes nothing. Pinned in Task 7 by `a screen change while an approval is on the screen is kept back, not sent`, `when the approval is over, the screen as it is now is sent, not the one from before` and `clearing an approval that is not the one on the screen changes nothing`; in Task 4 by `aUiFrameFromTheBridgeEndsAnApproval`; in Task 8 by `a screen change while an approval is up reaches the device when the approval is over, not before` and `an answer for an approval that is not the one on the screen changes nothing`.

## Files

```
README.md                                          Layout rows, the voice turn, the developer commands, the gates
.gitignore                                         + bridge/snaps/
protocol/frames.md, gen_vectors.py, vectors.json   UI, BUTTON, APPROVAL_REQ/RES, the TEST ops, the REASON flag
firmware/lib/proto/src/proto/*                     the new frame types, flags and payload builders and parsers
firmware/lib/ui/src/ui/gesture.*                   two key states to taps, holds and chords
firmware/lib/ui/src/ui/keyscript.*                 a TEST KEYS script played into the gesture
firmware/lib/ui/src/ui/text.*                      sanitize, wrap and clip UTF-8 for 30-cell lines
firmware/lib/ui/src/ui/machine.*                   the screens, the key actions, approvals, SWITCH_CONFIRM
firmware/src/audio.*, status.h                     takes with a pre-roll, the REASON flag, a test mic source, the mic level
firmware/src/screen.*                              draws a ui::View; TEST SNAP reads the canvas back
firmware/src/main.cpp, usblink.*                   the UI loop; UI and APPROVAL_REQ from the link; the TEST hooks
firmware/host/**                                   host tests for all of the above, stubs for Arduino.h and M5Unified.h
bridge/src/link/{frame,messages,link}.js           the new types, payloads and parsers; the link pings at once on HELLO
bridge/src/audio/takes.js                          TakeCollector.lastReason
bridge/src/speech/speech.js                        hear() tells the words as soon as they are known
bridge/src/ui/ui.js                                what the device shows, the approval over it, its buttons and verdicts
bridge/src/turn/turn.js                            the voice turn
bridge/src/{console,main}.js, bin/walkie.js        what is printed; the bridge wired; the program
bridge/src/dev/{png,press,snap,ui,inject}.js       walkie-dev press, snap, ui and inject; args.js and bin/walkie-dev.js take them
bridge/test/**                                     new suites; test/helpers/ holds a fake link and a stand-in S3 that behaves like the firmware
tools/gate-h.mjs                                   the screens and keys on the real S3, 11 scenes
docs/superpowers/specs/2026-09-29-walkie-design.md §6.6 and §10 record what this plan decided and measured
```

---

### Task 1: Payloads of UI, BUTTON, APPROVAL and the TEST hooks

Everything else in this plan speaks through these bytes, so they come first and are written down once, in `protocol/frames.md`, and generated once, in `protocol/vectors.json`, which both sides test themselves against. UI is a state byte plus tagged fields (project, text, elapsed ms), BUTTON is one event byte, APPROVAL_REQ carries an id, a tool and a preview and APPROVAL_RES an id, a verdict and whether a spoken reason follows. The TEST frame learns four ops (key script, mic source, mic PCM, screen snapshot). The REASON flag marks the last frame of a take that is the spoken reason for a denial. The firmware's `onTest` handler stops taking a frame count and takes the op's argument bytes, because every op now has its own layout.

**Files:**
- Modify: `bridge/src/audio/takes.js`, `bridge/src/link/frame.js`, `bridge/src/link/messages.js`, `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/main.cpp`, `firmware/src/usblink.cpp`, `firmware/src/usblink.h`, `protocol/frames.md`
- Test (new): `bridge/test/link/ui-messages.test.js`, `firmware/host/test_ui_messages.cpp`
- Test (changed): `bridge/test/audio/takes.test.js`, `bridge/test/link/messages.test.js`, `firmware/host/test_state.cpp`, `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**
- Consumes (plans 1 to 3): in `frame.js` and `frame.h`, `TYPE`/`T_*`, `FLAG`/`F_EOS`; in `messages.js`, `TEST_OP`, `testPayload`, `isInt`; in `messages.h`, `parseTest` and `TestOp`; `TakeCollector.push(frame)` in `takes.js`; the generator `protocol/gen_vectors.py` and the host runner, which writes `build/vectors.h` from `vectors.json`.
- Produces, bridge (`bridge/src/link/messages.js`):
  - `UI_STATE {IDLE 0, TRANSCRIBING 1, CONFIRM 2, WORKING 3, REPLY 4, ERROR 5}`, `BUTTON {CANCEL 1, STOP 2, DISMISS 3, SWITCHING 4}`, `KEY {FRONT 1, SIDE 2}` (the bits of a key mask), `LIMITS {project 60, tool 64, text 900, preview 900, keySteps 16, micPcm 1000}`.
  - `clipUtf8(text, max): string`: at most `max` UTF-8 bytes, cut on a character (a surrogate pair is never split), an ellipsis when cut.
  - `uiPayload({state, project, text, elapsedMs}): Buffer`, `approvalReqPayload({id, tool, preview}): Buffer`, `testKeysPayload(steps: {delayMs, mask}[]): Buffer`, `testMicSourcePayload(on): Buffer`, `testSnapPayload(): Buffer`, `testMicPcmPayload(pcm: Buffer): Buffer`. All throw `RangeError` for a value the S3 would misread.
  - `parseButton(p): {event} | null`, `parseApprovalRes(p): {id, allow, reasonFollows} | null`, `parseSnapChunk(p): {op, index, count, width, height, pixels} | null`, and, for the stand-in S3 in tests and for `walkie-dev`, `parseUi(p): {state, project?, text?, elapsedMs?} | null`, `parseApprovalReq(p): {id, tool, preview} | null`, `parseTestKeys(p): {op, steps} | null`.
  - `FLAG.REASON` (0x08) in `frame.js`, and `TakeCollector.lastReason`: true when the take last returned ended with REASON.
- Produces, firmware (`proto::` in `messages.h`): `UI_*`, `BTN_*`, `KEY_*` and `KEY_STEPS_MAX`; `struct Text {p, n}`, `UiView {state, project, text, hasElapsed, elapsedMs}`, `ApprovalReq {id, tool, preview}`, `KeyStep {delayMs, mask}`; `TestOp` now `{op, args, len}`; `buildButton`, `buildApprovalRes`, `buildSnapChunk`; `parseUi`, `parseApprovalReq`, `parseKeys`, `parseMicSource`, `parseUpPattern`; `T_UI`, `T_BUTTON`, `T_APPROVAL_REQ`, `T_APPROVAL_RES` and `F_REASON` in `frame.h`; `usblink`'s `onTest(op, args, len)`.

- [ ] **Step 1: Write the failing tests**

In `bridge/test/audio/takes.test.js`, replace:

```js
  assert.equal(t.push(frame(0, FLAG.EOS)).length, 640);
});

test('reset drops a take in progress', () => {
  const t = new TakeCollector();
  t.push(frame(640));
```

with:

```js
  assert.equal(t.push(frame(0, FLAG.EOS)).length, 640);
});

test('a take whose last frame carries REASON says so, and the next take does not', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  assert.equal(t.push(frame(640, FLAG.EOS | FLAG.REASON)).length, 1280);
  assert.equal(t.lastReason, true);
  t.push(frame(640, FLAG.EOS));
  assert.equal(t.lastReason, false);
});

test('REASON on a frame that does not end the take does not make it a reason', () => {
  const t = new TakeCollector();
  t.push(frame(640, FLAG.REASON));
  t.push(frame(640, FLAG.EOS));
  assert.equal(t.lastReason, false);
});

test('reset drops a take in progress', () => {
  const t = new TakeCollector();
  t.push(frame(640));
```

Replace the whole of `bridge/test/link/messages.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import {
  helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload,
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
  parseUi, parseApprovalReq, parseTestKeys,
} from '../../src/link/messages.js';
import { patternBytes } from '../../src/link/pattern.js';

const build = {
  hello_bridge: (f) => helloPayload(f.nonce),
  ping: (f) => pingPayload(f.token),
  cmd_set_volume: (f) => cmdPayload(f.op, f.arg),
  cmd_set_mic_gain: (f) => cmdPayload(f.op, f.arg),
  cmd_stop_audio: (f) => cmdPayload(f.op),
  cmd_boot_app0: (f) => cmdPayload(f.op),
  cmd_reboot: (f) => cmdPayload(f.op),
  test_up_pattern: (f) => testPayload(f.op, f.frames),
  ui_idle: (f) => uiPayload(f),
  ui_confirm: (f) => uiPayload(f),
  ui_working: (f) => uiPayload(f),
  ui_error: (f) => uiPayload(f),
  approval_req: (f) => approvalReqPayload(f),
  test_keys: (f) => testKeysPayload(f.steps),
  test_mic_source_on: (f) => testMicSourcePayload(f.on),
  test_mic_pcm: (f) => testMicPcmPayload(hex(f.pcm)),
  test_snap: () => testSnapPayload(),
};
const parse = {
  hello_device: parseHello,
  pong: parsePong,
  credit: parseCredit,
  played: parsePlayed,
  button_cancel: parseButton,
  button_stop: parseButton,
  button_dismiss: parseButton,
  button_switching: parseButton,
  approval_res_allow: parseApprovalRes,
  approval_res_deny_reason: parseApprovalRes,
  test_snap_chunk: (p) => ({ ...parseSnapChunk(p), pixels: parseSnapChunk(p).pixels.toString('hex') }),
};
// What the PC sends, read back by the readers a stand-in S3 uses: the vectors must survive the round trip.
const readBack = {
  ui_idle: parseUi,
  ui_confirm: parseUi,
  ui_working: parseUi,
  ui_error: parseUi,
  approval_req: parseApprovalReq,
  test_keys: parseTestKeys,
};

test('payloads the bridge builds match the vectors', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'down')) {
    assert.equal(build[m.name](m.fields).toString('hex'), m.hex, m.name);
  }
});

test('payloads from the S3 parse to the vector fields', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'up')) {
    assert.deepEqual(parse[m.name](hex(m.hex)), m.fields, m.name);
  }
});

test('what the PC sends reads back to the vector fields', () => {
  for (const [name, read] of Object.entries(readBack)) {
    const m = vectors.messages.find((v) => v.name === name);
    assert.deepEqual(read(hex(m.hex)), m.fields, name);
  }
});

test('payloads that are too short parse to null', () => {
  assert.equal(parseHello(Buffer.alloc(17)), null);
  assert.equal(parsePong(Buffer.alloc(15)), null);
  assert.equal(parseCredit(Buffer.alloc(3)), null);
  assert.equal(parsePlayed(Buffer.alloc(16)), null);
  assert.equal(parseButton(Buffer.alloc(0)), null);
  assert.equal(parseApprovalRes(Buffer.alloc(3)), null);
  assert.equal(parseSnapChunk(Buffer.alloc(8)), null);
});

test('the test pattern matches the vectors', () => {
  assert.equal(patternBytes(0, 8).toString('hex'), vectors.pattern.first8);
  assert.equal(patternBytes(80000, 1).readUInt16LE(0), vectors.pattern.at80000);
});

test('cmdPayload refuses arguments the S3 would misread', async () => {
  const { CMD } = await import('../../src/link/messages.js');
  for (const v of [-1, 256, 1.5, NaN]) assert.throws(() => cmdPayload(CMD.SET_VOLUME, v), RangeError, `vol ${v}`);
  for (const g of [0, 65]) assert.throws(() => cmdPayload(CMD.SET_MIC_GAIN, g), RangeError, `gain ${g}`);
  assert.throws(() => cmdPayload(CMD.SET_VOLUME), RangeError);
  assert.throws(() => cmdPayload(CMD.SET_MIC_GAIN), RangeError);
  assert.throws(() => cmdPayload(CMD.STOP_AUDIO, 5), RangeError);
  assert.throws(() => cmdPayload(256), RangeError);
  assert.throws(() => cmdPayload(-1), RangeError);
});

test('cmdPayload accepts the ends of each range', async () => {
  const { CMD } = await import('../../src/link/messages.js');
  assert.equal(cmdPayload(CMD.SET_VOLUME, 0).toString('hex'), '0100');
  assert.equal(cmdPayload(CMD.SET_VOLUME, 255).toString('hex'), '01ff');
  assert.equal(cmdPayload(CMD.SET_MIC_GAIN, 1).toString('hex'), '0201');
  assert.equal(cmdPayload(CMD.SET_MIC_GAIN, 64).toString('hex'), '0240');
});

test('helloPayload refuses nonce 0 and anything outside 32 bits', () => {
  for (const n of [0, 2 ** 32, 1.5]) assert.throws(() => helloPayload(n), RangeError, `nonce ${n}`);
  assert.equal(helloPayload(1).toString('hex'), '0101000000');
  assert.equal(helloPayload(0xffffffff).toString('hex'), '01ffffffff');
});

test('message constants match protocol/frames.md', async () => {
  const { PROTO, CMD, TEST_OP } = await import('../../src/link/messages.js');
  assert.equal(PROTO, 1);
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
});
```

Create `bridge/test/link/ui-messages.test.js`:

```js
// The payloads of UI, APPROVAL_REQ and TEST that the screens and the test hooks use: what they hold at most, and what a
// reader makes of a payload that is not what the writer would have sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, UI_STATE, clipUtf8, uiPayload, approvalReqPayload, testKeysPayload, testMicPcmPayload,
  parseUi, parseApprovalReq, parseTestKeys,
} from '../../src/link/messages.js';

test('text that fits is left alone, and text that does not is cut on a character with an ellipsis', () => {
  assert.equal(clipUtf8('你好', 6), '你好');
  assert.equal(clipUtf8('你好吗', 6), '你…'); // 3 bytes of room for text, 3 for the ellipsis
  assert.equal(clipUtf8('', 5), '');
  assert.equal(clipUtf8(undefined, 5), '');
  const long = '嗯'.repeat(2000);
  const cut = clipUtf8(long, LIMITS.text);
  assert.ok(Buffer.byteLength(cut) <= LIMITS.text);
  assert.equal(cut, `${'嗯'.repeat(299)}…`);
});

test('a character of four bytes is never split', () => {
  const faces = '😀'.repeat(300); // 4 bytes each, a surrogate pair in JavaScript
  const cut = clipUtf8(faces, 10);
  assert.equal(cut, '😀…'); // 4 + 3 = 7 bytes; a second face would make 11
  assert.equal(Buffer.from(cut).toString('utf8'), cut, 'it survives the trip through UTF-8');
});

test('a UI frame with every field at its limit still fits in one frame', () => {
  const p = uiPayload({ state: UI_STATE.WORKING, project: 'p'.repeat(500), text: '字'.repeat(2000), elapsedMs: 0xffffffff });
  assert.ok(p.length <= 1024, `${p.length} bytes`);
  const view = parseUi(p);
  assert.equal(view.project.length, LIMITS.project - 3 + 1);
  assert.ok(view.text.endsWith('…') && Buffer.byteLength(view.text) <= LIMITS.text);
  assert.equal(view.elapsedMs, 0xffffffff);
});

test('empty fields are left out, so a bare state is one byte', () => {
  assert.equal(uiPayload({ state: UI_STATE.TRANSCRIBING }).toString('hex'), '01');
  assert.equal(uiPayload({ state: UI_STATE.IDLE, project: '', text: '' }).toString('hex'), '00');
  assert.deepEqual(parseUi(Buffer.from([1])), { state: 1 });
});

test('a state or a time the S3 would misread is refused', () => {
  for (const state of [-1, 6, 1.5, undefined, '3']) assert.throws(() => uiPayload({ state }), RangeError, `state ${state}`);
  for (const elapsedMs of [-1, 2 ** 32, 1.5]) assert.throws(() => uiPayload({ state: 3, elapsedMs }), RangeError, `elapsed ${elapsedMs}`);
});

test('an approval request with the longest tool and preview still fits in one frame', () => {
  const p = approvalReqPayload({ id: 65535, tool: 'T'.repeat(200), preview: '改'.repeat(1000) });
  assert.ok(p.length <= 1024, `${p.length} bytes`);
  const req = parseApprovalReq(p);
  assert.equal(req.id, 65535);
  assert.equal(req.tool, 'T'.repeat(LIMITS.tool - 3) + '…');
  assert.ok(req.preview.endsWith('…') && Buffer.byteLength(req.preview) <= LIMITS.preview);
});

test('an approval id outside 16 bits is refused', () => {
  for (const id of [-1, 65536, 1.5, undefined]) assert.throws(() => approvalReqPayload({ id, tool: 'Bash', preview: '' }), RangeError, `id ${id}`);
});

test('a key script of nothing, of too many steps, or with a key that does not exist is refused', () => {
  assert.throws(() => testKeysPayload([]), RangeError);
  assert.throws(() => testKeysPayload(Array.from({ length: 17 }, () => ({ delayMs: 0, mask: 0 }))), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: 0, mask: 4 }]), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: 65536, mask: 1 }]), RangeError);
  assert.throws(() => testKeysPayload([{ delayMs: -1, mask: 1 }]), RangeError);
  assert.equal(testKeysPayload(Array.from({ length: 16 }, () => ({ delayMs: 65535, mask: 3 }))).length, 2 + 16 * 3);
});

test('mic PCM that is empty, odd or longer than one frame can carry is refused', () => {
  assert.throws(() => testMicPcmPayload(Buffer.alloc(0)), RangeError);
  assert.throws(() => testMicPcmPayload(Buffer.alloc(3)), RangeError);
  assert.throws(() => testMicPcmPayload(Buffer.alloc(1002)), RangeError);
  assert.throws(() => testMicPcmPayload('abcd'), RangeError);
  assert.equal(testMicPcmPayload(Buffer.alloc(1000)).length, 1001);
});

test('a reader skips a field it does not know and refuses a payload that is cut short', () => {
  const unknown = Buffer.from([2, 9, 2, 0, 0xaa, 0xbb, 1, 2, 0, 0x68, 0x69]); // CONFIRM, tag 9 (2 bytes), tag 1 "hi"
  assert.deepEqual(parseUi(unknown), { state: 2, project: 'hi' });
  assert.equal(parseUi(Buffer.from([2, 1, 5, 0, 0x68])), null, 'a field that runs past the end');
  assert.equal(parseUi(Buffer.from([2, 1, 5])), null, 'a field header that runs past the end');
  assert.equal(parseUi(Buffer.alloc(0)), null);
  assert.equal(parseUi(Buffer.from([6])), null, 'a state that does not exist');
  assert.deepEqual(parseUi(Buffer.from([3, 3, 2, 0, 1, 2])), { state: 3 }, 'a time that is not 4 bytes is ignored');
  assert.equal(parseApprovalReq(Buffer.from([1, 0, 9, 0x61])), null, 'a tool name longer than the payload');
  assert.equal(parseTestKeys(Buffer.from([2, 2, 0, 0, 1])), null, 'two steps announced, one sent');
  assert.equal(parseTestKeys(Buffer.from([2, 0])), null);
});
```

In `firmware/host/test_state.cpp`, replace:

```cpp
    CHECK(proto::parseCmd(b.data(), b.size(), cmd) && cmd.op == c.op && cmd.arg == c.arg, c.name);
  }
  b = unhex(msgHex("test_up_pattern").c_str());
  proto::TestOp t = {0, 0};
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_UP_PATTERN && t.frames == 250,
        "test_up_pattern");
}

TEST(ringWrapsAcrossTheCounterLimit) {
```

with:

```cpp
    CHECK(proto::parseCmd(b.data(), b.size(), cmd) && cmd.op == c.op && cmd.arg == c.arg, c.name);
  }
  b = unhex(msgHex("test_up_pattern").c_str());
  proto::TestOp t = {0, nullptr, 0};
  uint16_t frames = 0;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_UP_PATTERN &&
            proto::parseUpPattern(t.args, t.len, frames) && frames == 250,
        "test_up_pattern");
  CHECK(!proto::parseUpPattern(t.args, 1, frames), "a pattern length cut short");
  CHECK(!proto::parseTest(b.data(), 0, t), "an empty TEST payload");
}

TEST(ringWrapsAcrossTheCounterLimit) {
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK(!proto::parseCmd(gain, 1, cmd), "SET_MIC_GAIN without its argument");
  const uint8_t stop[] = {proto::CMD_STOP_AUDIO};
  CHECK(proto::parseCmd(stop, 1, cmd) && cmd.op == proto::CMD_STOP_AUDIO && cmd.arg == 0, "STOP_AUDIO needs no argument");
  proto::TestOp t = {0, 0};
  const uint8_t pat[] = {proto::TEST_UP_PATTERN, 0xFA, 0x00};
  CHECK(!proto::parseTest(pat, 1, t), "UP_PATTERN with no frame count");
  CHECK(!proto::parseTest(pat, 2, t), "UP_PATTERN with half a frame count");
}

TEST(creditLedgerEdges) {
```

with:

```cpp
  CHECK(!proto::parseCmd(gain, 1, cmd), "SET_MIC_GAIN without its argument");
  const uint8_t stop[] = {proto::CMD_STOP_AUDIO};
  CHECK(proto::parseCmd(stop, 1, cmd) && cmd.op == proto::CMD_STOP_AUDIO && cmd.arg == 0, "STOP_AUDIO needs no argument");
  proto::TestOp t = {0, nullptr, 0};
  uint16_t frames = 0;
  const uint8_t pat[] = {proto::TEST_UP_PATTERN, 0xFA, 0x00};
  CHECK(proto::parseTest(pat, 1, t) && t.len == 0 && !proto::parseUpPattern(t.args, t.len, frames), "UP_PATTERN with no frame count");
  CHECK(proto::parseTest(pat, 2, t) && t.len == 1 && !proto::parseUpPattern(t.args, t.len, frames), "UP_PATTERN with half a frame count");
}

TEST(creditLedgerEdges) {
```

Create `firmware/host/test_ui_messages.cpp`:

```cpp
// test_ui_messages.cpp: the payloads of UI, BUTTON, APPROVAL and the TEST hooks, against protocol/vectors.json, and what
// the parsers make of payloads that are cut short or carry what this version does not know.
#include <string.h>
#include <string>
#include "check.h"
#include "proto/messages.h"
#include "vectors.h"

static std::string vec(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(name, m.name) == 0) return m.hex;
  printf("no vector named %s\n", name);
  g_fail++;
  return "";
}
static std::string str(proto::Text t) { return std::string((const char*)t.p, t.n); }

TEST(buttonAndApprovalAnswersMatchVectors) {
  uint8_t out[64];
  size_t n = proto::buildButton(proto::BTN_CANCEL, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_cancel"), "button_cancel");
  n = proto::buildButton(proto::BTN_STOP, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_stop"), "button_stop");
  n = proto::buildButton(proto::BTN_DISMISS, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_dismiss"), "button_dismiss");
  n = proto::buildButton(proto::BTN_SWITCHING, out, sizeof out);
  CHECK(tohex(out, n) == vec("button_switching"), "button_switching");
  n = proto::buildApprovalRes(7, true, false, out, sizeof out);
  CHECK(tohex(out, n) == vec("approval_res_allow"), "approval_res_allow");
  n = proto::buildApprovalRes(7, false, true, out, sizeof out);
  CHECK(tohex(out, n) == vec("approval_res_deny_reason"), "approval_res_deny_reason");
  CHECK(proto::buildApprovalRes(7, true, false, out, 3) == 0, "an answer into a short buffer");
  CHECK(proto::buildButton(1, out, 0) == 0, "a button into no buffer");
}

TEST(snapChunkMatchesTheVector) {
  uint8_t out[64];
  const uint8_t px[4] = {0x1F, 0x00, 0xE0, 0x07};
  size_t n = proto::buildSnapChunk(3, 65, 240, 135, px, 4, out, sizeof out);
  CHECK(tohex(out, n) == vec("test_snap_chunk"), "test_snap_chunk");
  CHECK(proto::buildSnapChunk(3, 65, 240, 135, px, 4, out, 12) == 0, "a chunk into a short buffer");
  uint8_t big[9 + 1000];
  uint8_t pix[1000] = {0};
  CHECK(proto::buildSnapChunk(0, 1, 240, 135, pix, 1000, big, sizeof big) == 1009, "a full chunk is 1009 bytes");
}

TEST(uiPayloadsParseToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("ui_idle").c_str());
  proto::UiView v;
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_IDLE && str(v.project) == "walkie" && v.text.n == 0 &&
            !v.hasElapsed,
        "ui_idle");
  b = unhex(vec("ui_confirm").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_CONFIRM &&
            str(v.text) == "\xe6\x8a\x8a\xe8\xbf\x99\xe4\xb8\xaa\xe6\x89\x8b\xe7\x8e\xaf\xe9\xa1\xb9\xe7\x9b\xae\xe7\x9a\x84\xe4\xbb\xa3\xe7\xa0\x81\xe4\xbc\x98\xe5\x8c\x96\xe4\xb8\x80\xe4\xb8\x8b",
        "ui_confirm");
  b = unhex(vec("ui_working").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_WORKING && str(v.text) == "Bash: npm test" &&
            v.hasElapsed && v.elapsedMs == 12500,
        "ui_working");
  b = unhex(vec("ui_error").c_str());
  CHECK(proto::parseUi(b.data(), b.size(), v) && v.state == proto::UI_ERROR && v.project.n == 0 && v.text.n > 0, "ui_error");
}

TEST(uiParserSkipsWhatItDoesNotKnowAndRefusesWhatIsCutShort) {
  proto::UiView v;
  const uint8_t unknown[] = {2, 9, 2, 0, 0xAA, 0xBB, 1, 2, 0, 'h', 'i'};  // CONFIRM, tag 9, then PROJECT "hi"
  CHECK(proto::parseUi(unknown, sizeof unknown, v) && v.state == proto::UI_CONFIRM && str(v.project) == "hi", "unknown tag");
  const uint8_t pastEnd[] = {2, 1, 5, 0, 'h'};
  CHECK(!proto::parseUi(pastEnd, sizeof pastEnd, v), "a field that runs past the end");
  const uint8_t oneTooLong[] = {2, 1, 2, 0, 'h'};
  CHECK(!proto::parseUi(oneTooLong, sizeof oneTooLong, v), "a field that is one byte longer than what is left");
  const uint8_t justFits[] = {2, 1, 1, 0, 'h'};
  CHECK(proto::parseUi(justFits, sizeof justFits, v) && str(v.project) == "h", "and one that is exactly what is left");
  const uint8_t shortHead[] = {2, 1, 5};
  CHECK(!proto::parseUi(shortHead, sizeof shortHead, v), "a field header that runs past the end");
  CHECK(!proto::parseUi(unknown, 0, v), "an empty payload");
  const uint8_t badState[] = {6};
  CHECK(!proto::parseUi(badState, 1, v), "a state that does not exist");
  const uint8_t oddTime[] = {3, 3, 2, 0, 1, 2};
  CHECK(proto::parseUi(oddTime, sizeof oddTime, v) && !v.hasElapsed, "a time that is not 4 bytes is ignored");
  const uint8_t bare[] = {1};
  v.project = {bare, 9};
  CHECK(proto::parseUi(bare, 1, v) && v.project.n == 0, "a bare state clears what the view held before");
}

TEST(approvalRequestParsesToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("approval_req").c_str());
  proto::ApprovalReq r;
  CHECK(proto::parseApprovalReq(b.data(), b.size(), r) && r.id == 7 && str(r.tool) == "Write" &&
            str(r.preview) == "\xe5\x86\x99\xe5\x85\xa5 out.txt\n\xe5\x86\x85\xe5\xae\xb9: ok",
        "approval_req");
  const uint8_t longTool[] = {1, 0, 9, 'a'};
  CHECK(!proto::parseApprovalReq(longTool, sizeof longTool, r), "a tool name longer than the payload");
  CHECK(!proto::parseApprovalReq(longTool, 2, r), "a payload without a tool length");
  const uint8_t noPreview[] = {1, 0, 1, 'x'};
  CHECK(proto::parseApprovalReq(noPreview, sizeof noPreview, r) && r.preview.n == 0, "no preview is fine");
}

TEST(testHooksParseToTheVectorFields) {
  std::vector<uint8_t> b = unhex(vec("test_keys").c_str());
  proto::TestOp t = {0, nullptr, 0};
  proto::KeyStep steps[proto::KEY_STEPS_MAX];
  size_t count = 0;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_KEYS &&
            proto::parseKeys(t.args, t.len, steps, proto::KEY_STEPS_MAX, count) && count == 3 && steps[0].delayMs == 0 &&
            steps[0].mask == 1 && steps[1].delayMs == 50 && steps[1].mask == 3 && steps[2].delayMs == 3000 && steps[2].mask == 0,
        "test_keys");
  b = unhex(vec("test_mic_source_on").c_str());
  bool on = false;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_MIC_SOURCE && proto::parseMicSource(t.args, t.len, on) && on,
        "test_mic_source_on");
  b = unhex(vec("test_mic_pcm").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_MIC_PCM && t.len == 8 && t.args[2] == 0xFF, "test_mic_pcm");
  b = unhex(vec("test_snap").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_SNAP && t.len == 0, "test_snap");
}

TEST(keyScriptsOfTheWrongLengthAreRefused) {
  proto::KeyStep steps[proto::KEY_STEPS_MAX];
  size_t count = 0;
  const uint8_t none[] = {0};
  CHECK(!proto::parseKeys(none, sizeof none, steps, proto::KEY_STEPS_MAX, count), "no steps");
  const uint8_t oneShort[] = {2, 0, 0, 1};
  CHECK(!proto::parseKeys(oneShort, sizeof oneShort, steps, proto::KEY_STEPS_MAX, count), "two steps announced, one sent");
  const uint8_t extra[] = {1, 0, 0, 1, 0};
  CHECK(!proto::parseKeys(extra, sizeof extra, steps, proto::KEY_STEPS_MAX, count), "a byte too many");
  uint8_t seventeen[1 + 17 * 3] = {17};
  CHECK(!proto::parseKeys(seventeen, sizeof seventeen, steps, proto::KEY_STEPS_MAX, count), "more steps than the buffer");
  CHECK(!proto::parseKeys(none, 0, steps, proto::KEY_STEPS_MAX, count), "nothing at all");
  uint8_t sixteen[1 + 16 * 3] = {16};
  CHECK(proto::parseKeys(sixteen, sizeof sixteen, steps, proto::KEY_STEPS_MAX, count) && count == 16, "as many steps as the buffer holds");
  bool on = true;
  CHECK(!proto::parseMicSource(none, 0, on), "a mic source switch without its byte");
}

TEST(numbersAndFlagsAreReadWholeNotJustTheirLowByte) {
  const uint8_t pattern[] = {0x34, 0x12};
  uint16_t frames = 0;
  CHECK(proto::parseUpPattern(pattern, sizeof pattern, frames) && frames == 0x1234, "an up pattern of 4660 frames");
  CHECK(!proto::parseUpPattern(pattern, 1, frames), "half of one");
  const uint8_t two[] = {2}, zero[] = {0};
  bool on = false;
  CHECK(proto::parseMicSource(two, 1, on) && on, "any byte but 0 turns the source on");
  CHECK(proto::parseMicSource(zero, 1, on) && !on, "and 0 turns it off");
  const uint8_t req[] = {0x07, 0x01, 1, 'x'};
  proto::ApprovalReq r;
  CHECK(proto::parseApprovalReq(req, sizeof req, r) && r.id == 263, "an approval id above 255");
  std::vector<uint8_t> long300 = {2, 2, 0x2C, 0x01};  // TEXT, 300 bytes
  long300.insert(long300.end(), 300, 'a');
  proto::UiView v;
  CHECK(proto::parseUi(long300.data(), long300.size(), v) && v.text.n == 300, "a field of 300 bytes");
  proto::TestOp t = {0, nullptr, 0};
  CHECK(!proto::parseTest(zero, 0, t), "an empty TEST frame names no operation");
}
```

In `protocol/gen_vectors.py`, replace:

```python
    ('hello from bridge', 0x01, 0, 0, bytes([1]) + struct.pack('<I', NONCE)),
    ('ping', 0x02, 0, 7, struct.pack('<I', 0x12345678)),
    ('audio down end of stream, empty', 0x11, 1, 65535, b''),
    ('credit', 0x12, 0, 42, struct.pack('<I', 12288)),
    ('log in utf-8', 0x3F, 0, 3, '你好 walkie'.encode('utf-8')),
    ('audio down, largest payload', 0x11, 0, 513, big),
```

with:

```python
    ('hello from bridge', 0x01, 0, 0, bytes([1]) + struct.pack('<I', NONCE)),
    ('ping', 0x02, 0, 7, struct.pack('<I', 0x12345678)),
    ('audio down end of stream, empty', 0x11, 1, 65535, b''),
    ('audio up end of a spoken reason', 0x10, 9, 300, run(1, 21)),
    ('credit', 0x12, 0, 42, struct.pack('<I', 12288)),
    ('log in utf-8', 0x3F, 0, 3, '你好 walkie'.encode('utf-8')),
    ('audio down, largest payload', 0x11, 0, 513, big),
```

In `protocol/gen_vectors.py`, replace:

```python
    assert decode_stream(chunks) == (expect, bad), name
    streams.append({'name': name, 'chunks': [h(c) for c in chunks], 'expect': expect, 'bad': bad})

messages = []
for name, t, d, p, fields in [
    ('hello_bridge', 0x01, 'down', bytes([1]) + struct.pack('<I', NONCE), {'proto': 1, 'nonce': NONCE}),
```

with:

```python
    assert decode_stream(chunks) == (expect, bad), name
    streams.append({'name': name, 'chunks': [h(c) for c in chunks], 'expect': expect, 'bad': bad})

def ui(state, project=None, text=None, elapsed=None):
    # state, then the fields that are present, in tag order: 1 PROJECT, 2 TEXT (UTF-8), 3 ELAPSED_MS (u32)
    out = bytes([state])
    for tag, body in [(1, project and project.encode()), (2, text and text.encode()),
                      (3, None if elapsed is None else struct.pack('<I', elapsed))]:
        if body is not None:
            out += bytes([tag]) + struct.pack('<H', len(body)) + body
    return out


def approval_req(id_, tool, preview):
    t = tool.encode()
    return struct.pack('<HB', id_, len(t)) + t + preview.encode()


def test_keys(steps):
    return bytes([2, len(steps)]) + b''.join(struct.pack('<HB', d, m) for d, m in steps)


PCM8 = bytes([0x01, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x34, 0x12])
PIX4 = bytes([0x1F, 0x00, 0xE0, 0x07])
messages = []
for name, t, d, p, fields in [
    ('hello_bridge', 0x01, 'down', bytes([1]) + struct.pack('<I', NONCE), {'proto': 1, 'nonce': NONCE}),
```

In `protocol/gen_vectors.py`, replace:

```python
    ('cmd_boot_app0', 0x30, 'down', bytes([4]), {'op': 4, 'arg': 0}),
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
]:
    messages.append({'name': name, 'type': t, 'dir': d, 'hex': h(p), 'fields': fields})

```

with:

```python
    ('cmd_boot_app0', 0x30, 'down', bytes([4]), {'op': 4, 'arg': 0}),
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
    ('ui_idle', 0x20, 'down', ui(0, project='walkie'), {'state': 0, 'project': 'walkie'}),
    ('ui_confirm', 0x20, 'down', ui(2, project='walkie', text='把这个手环项目的代码优化一下'),
     {'state': 2, 'project': 'walkie', 'text': '把这个手环项目的代码优化一下'}),
    ('ui_working', 0x20, 'down', ui(3, project='walkie', text='Bash: npm test', elapsed=12500),
     {'state': 3, 'project': 'walkie', 'text': 'Bash: npm test', 'elapsedMs': 12500}),
    ('ui_error', 0x20, 'down', ui(5, text='Claude 登录过期，回电脑上登录'),
     {'state': 5, 'text': 'Claude 登录过期，回电脑上登录'}),
    ('approval_req', 0x22, 'down', approval_req(7, 'Write', '写入 out.txt\n内容: ok'),
     {'id': 7, 'tool': 'Write', 'preview': '写入 out.txt\n内容: ok'}),
    ('test_keys', 0x31, 'down', test_keys([(0, 1), (50, 3), (3000, 0)]),
     {'op': 2, 'steps': [{'delayMs': 0, 'mask': 1}, {'delayMs': 50, 'mask': 3}, {'delayMs': 3000, 'mask': 0}]}),
    ('test_mic_source_on', 0x31, 'down', bytes([3, 1]), {'op': 3, 'on': True}),
    ('test_mic_pcm', 0x31, 'down', bytes([4]) + PCM8, {'op': 4, 'pcm': h(PCM8)}),
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('button_cancel', 0x21, 'up', bytes([1]), {'event': 1}),
    ('button_stop', 0x21, 'up', bytes([2]), {'event': 2}),
    ('button_dismiss', 0x21, 'up', bytes([3]), {'event': 3}),
    ('button_switching', 0x21, 'up', bytes([4]), {'event': 4}),
    ('approval_res_allow', 0x23, 'up', struct.pack('<HBB', 7, 1, 0), {'id': 7, 'allow': True, 'reasonFollows': False}),
    ('approval_res_deny_reason', 0x23, 'up', struct.pack('<HBB', 7, 0, 1), {'id': 7, 'allow': False, 'reasonFollows': True}),
    ('test_snap_chunk', 0x31, 'up', bytes([5]) + struct.pack('<HHHH', 3, 65, 240, 135) + PIX4,
     {'op': 5, 'index': 3, 'count': 65, 'width': 240, 'height': 135, 'pixels': h(PIX4)}),
]:
    messages.append({'name': name, 'type': t, 'dir': d, 'hex': h(p), 'fields': fields})

```

Regenerate `protocol/vectors.json` by running `python protocol/gen_vectors.py` from the repo root.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/audio/takes.test.js bridge/test/link/messages.test.js bridge/test/link/ui-messages.test.js`
Expected: FAIL, 2 tests fail: `a take whose last frame carries REASON says so, and the next take does not`, `REASON on a frame that does not end the take does not make it a reason`; the files `bridge/test/link/messages.test.js`, `bridge/test/link/ui-messages.test.js` cannot load, because they import what the source does not have yet.

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `too many initializers for 'proto::TestOp'`, `'parseUpPattern' is not a member of 'proto'`, and 2 more.

- [ ] **Step 3: Write the implementation**

Replace the whole of `bridge/src/audio/takes.js` with:

```js
// Collects AUDIO_UP frames into takes: one take per hold of the talk key, ended by the EOS flag.
import { FLAG } from '../link/frame.js';

export class TakeCollector {
  #parts = [];
  #open = false;
  #reason = false;

  get open() {
    return this.#open;
  }

  // True when the take that was last returned was recorded to give the reason for denying an approval (REASON on its last frame).
  get lastReason() {
    return this.#reason;
  }

  // Returns the finished take (PCM16 at 16 kHz) on the frame that ends it, otherwise null.
  push(frame) {
    if (frame.payload.length > 0) this.#parts.push(frame.payload);
    this.#open = true;
    if (!(frame.flags & FLAG.EOS)) return null;
    this.#reason = (frame.flags & FLAG.REASON) !== 0;
    const take = Buffer.concat(this.#parts);
    this.reset();
    return take;
  }

  reset() {
    this.#parts = [];
    this.#open = false;
  }
}
```

In `bridge/src/link/frame.js`, replace:

```js
  TEST: 0x31,
  LOG: 0x3f,
});
export const FLAG = Object.freeze({ EOS: 0x01 });
export const MAX_PAYLOAD = 1024;
export const MAX_CHUNK = 1100;

```

with:

```js
  TEST: 0x31,
  LOG: 0x3f,
});
export const FLAG = Object.freeze({ EOS: 0x01, REASON: 0x08 });
export const MAX_PAYLOAD = 1024;
export const MAX_CHUNK = 1100;

```

Replace the whole of `bridge/src/link/messages.js` with:

```js
// Payloads of the link's frame types (protocol/frames.md). Integers are little endian.
export const PROTO = 1;
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
export const UI_STATE = Object.freeze({ IDLE: 0, TRANSCRIBING: 1, CONFIRM: 2, WORKING: 3, REPLY: 4, ERROR: 5 });
export const BUTTON = Object.freeze({ CANCEL: 1, STOP: 2, DISMISS: 3, SWITCHING: 4 });
export const KEY = Object.freeze({ FRONT: 1, SIDE: 2 }); // the bits of a TEST KEYS mask
// What one UI or APPROVAL_REQ field may hold, in UTF-8 bytes, so that a frame stays within 1024 bytes.
export const LIMITS = Object.freeze({ project: 60, tool: 64, text: 900, preview: 900, keySteps: 16, micPcm: 1000 });

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// nonce 0 is reserved for the S3's boot HELLO.
export function helloPayload(nonce) {
  if (!isInt(nonce, 1, 0xffffffff)) throw new RangeError(`HELLO nonce must be an integer 1..0xFFFFFFFF, not ${nonce}`);
  const b = Buffer.alloc(5);
  b[0] = PROTO;
  b.writeUInt32LE(nonce >>> 0, 1);
  return b;
}

export function pingPayload(token) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(token >>> 0);
  return b;
}

export function cmdPayload(op, arg) {
  if (!isInt(op, 0, 255)) throw new RangeError(`CMD op must be an integer 0..255, not ${op}`);
  switch (op) {
    case CMD.SET_VOLUME:
      if (!isInt(arg, 0, 255)) throw new RangeError(`volume must be an integer 0..255, not ${arg}`);
      break;
    case CMD.SET_MIC_GAIN:
      if (!isInt(arg, 1, 64)) throw new RangeError(`mic gain must be an integer 1..64, not ${arg}`);
      break;
    case CMD.STOP_AUDIO:
    case CMD.BOOT_APP0:
    case CMD.REBOOT:
      if (arg !== undefined) throw new RangeError(`CMD ${op} takes no argument`);
      break;
    default:
      if (arg !== undefined && !isInt(arg, 0, 255)) throw new RangeError(`CMD argument must be an integer 0..255, not ${arg}`);
  }
  return arg === undefined ? Buffer.from([op]) : Buffer.from([op, arg]);
}

export function testPayload(op, frames) {
  const b = Buffer.alloc(3);
  b[0] = op;
  b.writeUInt16LE(frames, 1);
  return b;
}

export function parseHello(p) {
  if (p.length < 18) return null;
  return {
    proto: p[0],
    upRate: p.readUInt16LE(2),
    downRate: p.readUInt16LE(4),
    ringBytes: p.readUInt32LE(6),
    uptimeMs: p.readUInt32LE(10),
    nonce: p.readUInt32LE(14),
    version: p.subarray(18).toString('utf8'),
  };
}

export function parsePong(p) {
  if (p.length < 16) return null;
  return { token: p.readUInt32LE(0), uptimeMs: p.readUInt32LE(4), badChunks: p.readUInt32LE(8), seqGaps: p.readUInt32LE(12) };
}

export function parseCredit(p) {
  return p.length < 4 ? null : { bytes: p.readUInt32LE(0) };
}

export function parsePlayed(p) {
  if (p.length < 17) return null;
  return {
    bytes: p.readUInt32LE(0),
    crc32: p.readUInt32LE(4),
    underruns: p.readUInt32LE(8),
    maxFill: p.readUInt32LE(12),
    reason: p[16],
  };
}

const TAG = Object.freeze({ PROJECT: 1, TEXT: 2, ELAPSED_MS: 3 });

// `text` cut to at most `max` UTF-8 bytes on a character boundary (a surrogate pair is never split). A cut ends with an
// ellipsis, so that a reader can tell it was cut.
export function clipUtf8(text, max) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max - 3) break; // the ellipsis is 3 bytes
    out += ch;
    bytes += n;
  }
  return `${out}…`;
}

function field(tag, body) {
  const head = Buffer.alloc(3);
  head[0] = tag;
  head.writeUInt16LE(body.length, 1);
  return Buffer.concat([head, body]);
}

// UI (PC to S3): the state, then the fields that are present. Text that is too long is cut (LIMITS); the full text is for
// the console.
export function uiPayload({ state, project, text, elapsedMs } = {}) {
  if (!Object.values(UI_STATE).includes(state)) throw new RangeError(`UI state must be one of 0..5, not ${state}`);
  const parts = [Buffer.from([state])];
  if (project) parts.push(field(TAG.PROJECT, Buffer.from(clipUtf8(project, LIMITS.project))));
  if (text) parts.push(field(TAG.TEXT, Buffer.from(clipUtf8(text, LIMITS.text))));
  if (elapsedMs !== undefined && elapsedMs !== null) {
    if (!isInt(elapsedMs, 0, 0xffffffff)) throw new RangeError(`elapsedMs must be an integer 0..0xFFFFFFFF, not ${elapsedMs}`);
    const b = Buffer.alloc(4);
    b.writeUInt32LE(elapsedMs);
    parts.push(field(TAG.ELAPSED_MS, b));
  }
  return Buffer.concat(parts);
}

// APPROVAL_REQ (PC to S3): the id the answer must carry, the tool's name and the preview of what it would do.
export function approvalReqPayload({ id, tool, preview }) {
  if (!isInt(id, 0, 0xffff)) throw new RangeError(`approval id must be an integer 0..65535, not ${id}`);
  const name = Buffer.from(clipUtf8(tool, LIMITS.tool));
  const head = Buffer.alloc(3);
  head.writeUInt16LE(id, 0);
  head[2] = name.length;
  return Buffer.concat([head, name, Buffer.from(clipUtf8(preview, LIMITS.preview))]);
}

// TEST KEYS: the keys' states over time, each step "after delayMs, the keys held are `mask`" (KEY bits).
export function testKeysPayload(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > LIMITS.keySteps) {
    throw new RangeError(`a key script has 1 to ${LIMITS.keySteps} steps`);
  }
  const b = Buffer.alloc(2 + steps.length * 3);
  b[0] = TEST_OP.KEYS;
  b[1] = steps.length;
  steps.forEach(({ delayMs, mask }, i) => {
    if (!isInt(delayMs, 0, 0xffff)) throw new RangeError(`step ${i}: delayMs must be an integer 0..65535, not ${delayMs}`);
    if (!isInt(mask, 0, KEY.FRONT | KEY.SIDE)) throw new RangeError(`step ${i}: mask must be 0..3, not ${mask}`);
    b.writeUInt16LE(delayMs, 2 + i * 3);
    b[4 + i * 3] = mask;
  });
  return b;
}

export const testMicSourcePayload = (on) => Buffer.from([TEST_OP.MIC_SOURCE, on ? 1 : 0]);
export const testSnapPayload = () => Buffer.from([TEST_OP.SNAP]);

// TEST MIC_PCM: PCM16 at 16 kHz that the S3 uses as the mic's output while MIC_SOURCE is on.
export function testMicPcmPayload(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length > LIMITS.micPcm || pcm.length % 2) {
    throw new RangeError(`mic PCM is 2 to ${LIMITS.micPcm} bytes, an even number`);
  }
  return Buffer.concat([Buffer.from([TEST_OP.MIC_PCM]), pcm]);
}

// BUTTON (S3 to PC).
export function parseButton(p) {
  return p.length < 1 ? null : { event: p[0] };
}

// APPROVAL_RES (S3 to PC).
export function parseApprovalRes(p) {
  return p.length < 4 ? null : { id: p.readUInt16LE(0), allow: p[2] === 1, reasonFollows: p[3] === 1 };
}

// TEST SNAP, from the S3: one slice of the screen, RGB565 little endian, row by row.
export function parseSnapChunk(p) {
  if (p.length < 9 || p[0] !== TEST_OP.SNAP) return null;
  return {
    op: TEST_OP.SNAP,
    index: p.readUInt16LE(1),
    count: p.readUInt16LE(3),
    width: p.readUInt16LE(5),
    height: p.readUInt16LE(7),
    pixels: p.subarray(9),
  };
}

// What the PC sends, read back: for the stand-in S3 in tests, and for `walkie-dev` to show.
export function parseUi(p) {
  if (p.length < 1 || p[0] > UI_STATE.ERROR) return null;
  const view = { state: p[0] };
  for (let at = 1; at < p.length; ) {
    if (at + 3 > p.length) return null;
    const tag = p[at];
    const len = p.readUInt16LE(at + 1);
    if (at + 3 + len > p.length) return null;
    const body = p.subarray(at + 3, at + 3 + len);
    if (tag === TAG.PROJECT) view.project = body.toString('utf8');
    else if (tag === TAG.TEXT) view.text = body.toString('utf8');
    else if (tag === TAG.ELAPSED_MS && len === 4) view.elapsedMs = body.readUInt32LE(0);
    at += 3 + len; // a tag this version does not know is skipped
  }
  return view;
}

export function parseApprovalReq(p) {
  if (p.length < 3 || 3 + p[2] > p.length) return null;
  return { id: p.readUInt16LE(0), tool: p.subarray(3, 3 + p[2]).toString('utf8'), preview: p.subarray(3 + p[2]).toString('utf8') };
}

export function parseTestKeys(p) {
  if (p.length < 2 || p[0] !== TEST_OP.KEYS || p[1] < 1 || p.length !== 2 + p[1] * 3) return null;
  return { op: TEST_OP.KEYS, steps: Array.from({ length: p[1] }, (_, i) => ({ delayMs: p.readUInt16LE(2 + i * 3), mask: p[4 + i * 3] })) };
}
```

In `firmware/lib/proto/src/proto/frame.h`, replace:

```cpp
  T_AUDIO_DOWN = 0x11,
  T_CREDIT = 0x12,
  T_PLAYED = 0x13,
  T_CMD = 0x30,
  T_TEST = 0x31,
  T_LOG = 0x3F,
};
enum : uint8_t { F_EOS = 0x01 };

const uint16_t MAX_PAYLOAD = 1024;
const size_t MAX_CHUNK = 1100;
```

with:

```cpp
  T_AUDIO_DOWN = 0x11,
  T_CREDIT = 0x12,
  T_PLAYED = 0x13,
  T_UI = 0x20,
  T_BUTTON = 0x21,
  T_APPROVAL_REQ = 0x22,
  T_APPROVAL_RES = 0x23,
  T_CMD = 0x30,
  T_TEST = 0x31,
  T_LOG = 0x3F,
};
enum : uint8_t { F_EOS = 0x01, F_REASON = 0x08 };

const uint16_t MAX_PAYLOAD = 1024;
const size_t MAX_CHUNK = 1100;
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp
  return 17;
}

bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce) {
  if (n < 5) return false;
  nonce = get32(p + 1);
```

with:

```cpp
  return 17;
}

size_t buildButton(uint8_t event, uint8_t* out, size_t cap) {
  if (cap < 1) return 0;
  out[0] = event;
  return 1;
}

size_t buildApprovalRes(uint16_t id, bool allow, bool reasonFollows, uint8_t* out, size_t cap) {
  if (cap < 4) return 0;
  put16(out, id);
  out[2] = allow ? 1 : 0;
  out[3] = reasonFollows ? 1 : 0;
  return 4;
}

size_t buildSnapChunk(uint16_t index, uint16_t count, uint16_t width, uint16_t height, const uint8_t* pixels,
                      size_t pixelBytes, uint8_t* out, size_t cap) {
  if (cap < 9 + pixelBytes) return 0;
  out[0] = TEST_SNAP;
  put16(put16(put16(put16(out + 1, index), count), width), height);
  memcpy(out + 9, pixels, pixelBytes);
  return 9 + pixelBytes;
}

bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce) {
  if (n < 5) return false;
  nonce = get32(p + 1);
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp

bool parseTest(const uint8_t* p, size_t n, TestOp& t) {
  if (n < 1) return false;
  if (p[0] == TEST_UP_PATTERN && n < 3) return false;
  t.op = p[0];
  t.frames = n >= 3 ? (uint16_t)(p[1] | (p[2] << 8)) : 0;
  return true;
}
}  // namespace proto
```

with:

```cpp

bool parseTest(const uint8_t* p, size_t n, TestOp& t) {
  if (n < 1) return false;
  t.op = p[0];
  t.args = p + 1;
  t.len = n - 1;
  return true;
}

bool parseUpPattern(const uint8_t* args, size_t n, uint16_t& frames) {
  if (n < 2) return false;
  frames = (uint16_t)(args[0] | (args[1] << 8));
  return true;
}

bool parseMicSource(const uint8_t* args, size_t n, bool& on) {
  if (n < 1) return false;
  on = args[0] != 0;
  return true;
}

bool parseKeys(const uint8_t* args, size_t n, KeyStep* out, size_t cap, size_t& count) {
  if (n < 1 || args[0] < 1 || args[0] > cap || n != 1 + (size_t)args[0] * 3) return false;
  count = args[0];
  for (size_t i = 0; i < count; i++) {
    const uint8_t* s = args + 1 + i * 3;
    out[i].delayMs = (uint16_t)(s[0] | (s[1] << 8));
    out[i].mask = s[2];
  }
  return true;
}

bool parseUi(const uint8_t* p, size_t n, UiView& v) {
  if (n < 1 || p[0] > UI_ERROR) return false;
  v = UiView();
  v.state = p[0];
  for (size_t at = 1; at < n;) {
    if (at + 3 > n) return false;
    uint8_t tag = p[at];
    size_t len = (size_t)(p[at + 1] | (p[at + 2] << 8));
    if (at + 3 + len > n) return false;
    const uint8_t* body = p + at + 3;
    if (tag == 1) v.project = {body, len};
    else if (tag == 2) v.text = {body, len};
    else if (tag == 3 && len == 4) {
      v.hasElapsed = true;
      v.elapsedMs = get32(body);
    }
    at += 3 + len;
  }
  return true;
}

bool parseApprovalReq(const uint8_t* p, size_t n, ApprovalReq& r) {
  if (n < 3 || 3 + (size_t)p[2] > n) return false;
  r.id = (uint16_t)(p[0] | (p[1] << 8));
  r.tool = {p + 3, p[2]};
  r.preview = {p + 3 + p[2], n - 3 - p[2]};
  return true;
}
}  // namespace proto
```

Replace the whole of `firmware/lib/proto/src/proto/messages.h` with:

```cpp
// messages.h: payloads the S3 builds and parses (protocol/frames.md). Integers are little endian.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const uint8_t PROTO_VERSION = 1;
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5 };
enum : uint8_t { UI_IDLE = 0, UI_TRANSCRIBING = 1, UI_CONFIRM = 2, UI_WORKING = 3, UI_REPLY = 4, UI_ERROR = 5 };
enum : uint8_t { BTN_CANCEL = 1, BTN_STOP = 2, BTN_DISMISS = 3, BTN_SWITCHING = 4 };
enum : uint8_t { KEY_FRONT = 1, KEY_SIDE = 2 };  // the bits of a TEST KEYS mask
const size_t KEY_STEPS_MAX = 16;
enum : uint8_t { PLAYED_FINISHED = 0, PLAYED_STOPPED = 1 };

struct Played {
  uint32_t bytes;
  uint32_t crc32;
  uint32_t underruns;
  uint32_t maxFill;
  uint8_t reason;
};
struct Command {
  uint8_t op;
  uint8_t arg;  // 0 for ops without one
};
struct TestOp {
  uint8_t op;
  const uint8_t* args;  // into the payload, valid only while the frame is
  size_t len;
};
struct KeyStep {
  uint16_t delayMs;  // after the step before it (the first: after the frame arrived)
  uint8_t mask;      // the keys held from then on
};
// UTF-8 text inside a payload. Not terminated, and not checked: whoever draws it must cope with bad bytes.
struct Text {
  const uint8_t* p;
  size_t n;
};
struct UiView {
  uint8_t state;
  Text project, text;
  bool hasElapsed;
  uint32_t elapsedMs;
};
struct ApprovalReq {
  uint16_t id;
  Text tool, preview;
};

// Builders write the payload to out and return its length, or 0 when cap is too small.
// nonce: the one from the PC's HELLO being answered, or 0 for the HELLO sent at boot.
size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce,
                  const char* version, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
size_t buildCredit(uint32_t bytes, uint8_t* out, size_t cap);
size_t buildPlayed(const Played& p, uint8_t* out, size_t cap);
size_t buildButton(uint8_t event, uint8_t* out, size_t cap);
size_t buildApprovalRes(uint16_t id, bool allow, bool reasonFollows, uint8_t* out, size_t cap);
// One slice of the screen for TEST SNAP: RGB565 little endian, pixelBytes of them.
size_t buildSnapChunk(uint16_t index, uint16_t count, uint16_t width, uint16_t height, const uint8_t* pixels,
                      size_t pixelBytes, uint8_t* out, size_t cap);

// Parsers return false when the payload is too short for its op: SET_VOLUME and SET_MIC_GAIN need their
// argument byte; every other CMD op needs only the op byte.
bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce);  // a HELLO from the PC
bool parsePing(const uint8_t* p, size_t n, uint32_t& token);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
bool parseTest(const uint8_t* p, size_t n, TestOp& t);  // splits the op from its arguments; each op's own parser checks them
bool parseUpPattern(const uint8_t* args, size_t n, uint16_t& frames);
bool parseMicSource(const uint8_t* args, size_t n, bool& on);
// A key script: out holds up to cap steps, count is how many. False unless the length is exactly what the script announces.
bool parseKeys(const uint8_t* args, size_t n, KeyStep* out, size_t cap, size_t& count);
// UI and APPROVAL_REQ: false when a field runs past the end of the payload. A tag this version does not know is skipped.
bool parseUi(const uint8_t* p, size_t n, UiView& v);
bool parseApprovalReq(const uint8_t* p, size_t n, ApprovalReq& r);
}  // namespace proto
```

In `firmware/src/main.cpp`, replace:

```cpp
}

// Runs on the link RX task.
void test(uint8_t op, uint16_t frames) {
  if (op == proto::TEST_UP_PATTERN) audio::requestPattern(frames);
  else usblink::logf("test %u is not handled", op);
}

```

with:

```cpp
}

// Runs on the link RX task.
void test(uint8_t op, const uint8_t* args, size_t len) {
  uint16_t frames = 0;
  if (op == proto::TEST_UP_PATTERN && proto::parseUpPattern(args, len, frames)) audio::requestPattern(frames);
  else usblink::logf("test %u is not handled", op);
}

```

In `firmware/src/usblink.cpp`, replace:

```cpp
    }
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.frames);
      return;
    }
    default:
```

with:

```cpp
    }
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.args, t.len);
      return;
    }
    default:
```

Replace the whole of `firmware/src/usblink.h` with:

```cpp
// usblink.h: the S3's end of the USB link (protocol/frames.md). The RX task decodes frames and
// dispatches them; the TX task is the only writer to USB.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace usblink {
// Called from the RX task. Any of them may be null.
struct Handlers {
  void (*onHello)();                                        // the bridge (re)connected
  void (*onAudioDown)(const uint8_t* pcm, size_t len, bool eos);
  void (*onCommand)(uint8_t op, uint8_t arg);
  void (*onTest)(uint8_t op, const uint8_t* args, size_t len);
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for USB and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// Milliseconds since the bridge's last PING, or UINT32_MAX before the first.
uint32_t msSincePing();
}  // namespace usblink
```

In `protocol/frames.md`, replace:

```markdown
|---|---|
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec. 0 is PCM16, little endian, mono; the other values are reserved (ADPCM, Stage 3). |
| 7 | Reserved for encryption (Stage 3). |

All other bits are 0.
```

with:

```markdown
|---|---|
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec. 0 is PCM16, little endian, mono; the other values are reserved (ADPCM, Stage 3). |
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
| 7 | Reserved for encryption (Stage 3). |

All other bits are 0.
```

In `protocol/frames.md`, replace:

```markdown
| 0x11 | AUDIO_DOWN | PC to S3 | PCM16 at 24 kHz: at most 960 bytes (20 ms) per frame, even length |
| 0x12 | CREDIT | S3 to PC | u32 bytes |
| 0x13 | PLAYED | S3 to PC | u32 bytes, u32 crc32, u32 underruns, u32 max_fill, u8 reason |
| 0x20-0x23 | UI, BUTTON, APPROVAL_REQ, APPROVAL_RES | | reserved; Stage 1 plan 4 defines them |
| 0x30 | CMD | PC to S3 | u8 op, then its argument |
| 0x31 | TEST | PC to S3 | u8 op, then its arguments |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |

A receiver ignores types it does not know.
```

with:

```markdown
| 0x11 | AUDIO_DOWN | PC to S3 | PCM16 at 24 kHz: at most 960 bytes (20 ms) per frame, even length |
| 0x12 | CREDIT | S3 to PC | u32 bytes |
| 0x13 | PLAYED | S3 to PC | u32 bytes, u32 crc32, u32 underruns, u32 max_fill, u8 reason |
| 0x20 | UI | PC to S3 | u8 state, then fields: see UI |
| 0x21 | BUTTON | S3 to PC | u8 event: see BUTTON |
| 0x22 | APPROVAL_REQ | PC to S3 | u16 id, u8 tool_len, tool, preview: see APPROVAL |
| 0x23 | APPROVAL_RES | S3 to PC | u16 id, u8 verdict, u8 reason_follows: see APPROVAL |
| 0x30 | CMD | PC to S3 | u8 op, then its argument |
| 0x31 | TEST | PC to S3, and SNAP chunks S3 to PC | u8 op, then its arguments |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |

A receiver ignores types it does not know.
```

In `protocol/frames.md`, replace:

```markdown

### Audio streams

- A stream is a run of frames of one type that ends with an EOS frame. AUDIO_UP: one take per hold of the talk key, or per TEST UP_PATTERN. AUDIO_DOWN: one spoken reply.
- The S3 starts playing a reply once 300 ms (14,400 bytes) is buffered or its EOS has arrived. If the ring runs dry before the EOS, that is an underrun, and it buffers 300 ms again before going on. Once the reply has played to the end, it sends PLAYED with reason 0.
- One reply at a time: the PC starts the next AUDIO_DOWN stream only after the PLAYED that ended the previous one.
- Stopping. On STOP_AUDIO, or on its own when the talk key is pressed during a reply, the S3 cuts the speaker and empties its ring. If a reply had started (audio buffered or playing, or frames still arriving), it sends PLAYED with reason 1; if nothing had started, it sends nothing. If frames of that reply were still arriving, it discards AUDIO_DOWN until the reply's EOS.
```

with:

```markdown

### Audio streams

- A stream is a run of frames of one type that ends with an EOS frame (an AUDIO_UP take that is a reason has REASON on that frame too). AUDIO_UP: one take per hold of the talk key, or per TEST UP_PATTERN. AUDIO_DOWN: one spoken reply.
- The S3 starts playing a reply once 300 ms (14,400 bytes) is buffered or its EOS has arrived. If the ring runs dry before the EOS, that is an underrun, and it buffers 300 ms again before going on. Once the reply has played to the end, it sends PLAYED with reason 0.
- One reply at a time: the PC starts the next AUDIO_DOWN stream only after the PLAYED that ended the previous one.
- Stopping. On STOP_AUDIO, or on its own when the talk key is pressed during a reply, the S3 cuts the speaker and empties its ring. If a reply had started (audio buffered or playing, or frames still arriving), it sends PLAYED with reason 1; if nothing had started, it sends nothing. If frames of that reply were still arriving, it discards AUDIO_DOWN until the reply's EOS.
```

In `protocol/frames.md`, replace:

```markdown

The S3 answers each with a LOG line.

### TEST

| op | Name | Arguments | Effect |
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian. Stage 1 plan 4 adds key presses, mic injection and screen capture.
```

with:

```markdown

The S3 answers each with a LOG line.

### UI

PC to S3: `u8 state`, then fields, each `u8 tag, u16 len, len bytes`. A field that is absent is empty. A reader skips a tag it does not know and refuses a payload whose last field runs past its end. The S3 draws a UI frame as soon as it arrives. The bridge sends one whenever the screen changes, and again after every HELLO, so that a restarted S3 shows the right screen.

| state | Name | The S3 shows |
|---|---|---|
| 0 | IDLE | the project, the link, the battery |
| 1 | TRANSCRIBING | that the bridge is working out what was said |
| 2 | CONFIRM | the transcript; a short press of the side key cancels it |
| 3 | WORKING | the status line and the time since the turn began |
| 4 | REPLY | the text of the reply, in pages |
| 5 | ERROR | a plain message |

| tag | Name | Value |
|---|---|---|
| 1 | PROJECT | UTF-8, at most 60 bytes |
| 2 | TEXT | UTF-8, at most 900 bytes: the transcript in CONFIRM, the status line in WORKING, the reply in REPLY, the message in ERROR |
| 3 | ELAPSED_MS | u32: how long the turn had been running when the frame was sent; the S3 counts on from the frame's arrival |

Text that is too long is cut by the bridge on a character, with an ellipsis; the full text is for the bridge's console. The S3 enters four more states by itself, which the bridge never sets: OFFLINE (no PING for 3 s), LISTENING (the front key is held), APPROVAL (an APPROVAL_REQ is on screen) and SWITCH_CONFIRM (both keys held for 3 s).

### BUTTON

S3 to PC, `u8 event`:

| event | Name | Sent when |
|---|---|---|
| 1 | CANCEL | the side key is pressed briefly while CONFIRM shows |
| 2 | STOP | the side key has been held for 1 s while WORKING shows |
| 3 | DISMISS | the side key is pressed briefly on the last page of a reply, once its audio has finished |
| 4 | SWITCHING | the front key confirmed SWITCH_CONFIRM: the S3 is about to select app0 and restart |

### APPROVAL

- APPROVAL_REQ, PC to S3: `u16 id, u8 tool_len, tool, preview`. The tool is UTF-8, at most 64 bytes; the preview is UTF-8 to the end of the payload, at most 900 bytes. The S3 shows it until it answers or any UI frame arrives. The bridge sends one request at a time and keeps the others waiting.
- APPROVAL_RES, S3 to PC: `u16 id, u8 verdict (1 allow, 0 deny), u8 reason_follows (1 or 0)`. With reason_follows 1 the S3 has recorded a spoken reason: its AUDIO_UP take, ended with EOS, went out before this frame. The bridge answers the request only once it has read the take.

### TEST

| op | Name | Arguments | Effect |
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |
| 2 | KEYS | u8 count (1 to 16), then count steps of u16 delay_ms, u8 mask | a key script: after delay_ms (counted from the previous step, or from the frame's arrival) the keys held are the mask (bit 0 the front key, bit 1 the side key). The S3 treats them as pressed together with the real keys. The frame is refused when its length is not what count announces |
| 3 | MIC_SOURCE | u8 on | with 1, a take is recorded from the PCM of MIC_PCM instead of the mic (silence when it has run out); with 0, from the mic again. Either way it empties the PCM queued |
| 4 | MIC_PCM | PCM16 at 16 kHz, 2 to 1000 bytes | queued for MIC_SOURCE; what does not fit in the S3's queue (about 12 s) is dropped, and a LOG line says so |
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |

SNAP chunk, S3 to PC, a TEST frame of op 5: `u8 5, u16 index, u16 count, u16 width, u16 height`, then RGB565 little endian, row by row, at most 1000 bytes. A 240 by 135 screen is 65 chunks. The S3 sends them as its TX queue allows, so a chunk can arrive a few milliseconds after the one before it. A new SNAP while one is being sent starts again from chunk 0.

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/audio/takes.test.js bridge/test/link/messages.test.js bridge/test/link/ui-messages.test.js`
Expected: PASS, 24 tests, 0 fail.

Run: `node firmware/host/run.mjs`
Expected: `32 cases, 230 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 15.3%, Flash 26.2%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `32 cases, 230 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/audio/takes.js bridge/src/link/frame.js bridge/src/link/messages.js bridge/test/audio/takes.test.js bridge/test/link/messages.test.js bridge/test/link/ui-messages.test.js firmware/host/test_state.cpp firmware/host/test_ui_messages.cpp firmware/lib/proto/src/proto/frame.h firmware/lib/proto/src/proto/messages.cpp firmware/lib/proto/src/proto/messages.h firmware/src/main.cpp firmware/src/usblink.cpp firmware/src/usblink.h protocol/frames.md protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 1: payloads of UI, BUTTON, APPROVAL and the TEST hooks" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Key gestures and key scripts

Two keys and a clock are all the device has. `Gesture` turns their states into the events of spec 6.2: a talk (held 300 ms), a short press, the side key's 1 s hold, and the chord. The key that goes down first owns the gesture; a second key within 150 ms makes a chord, which can only lead to SWITCH_CONFIRM and never to a talk; a second key that comes later is ignored until it is released, so a finger resting on the side key does not turn a talk into something else. `KeyScript` plays a TEST KEYS script into the same two inputs, so the real firmware path is exercised with no finger on the device. Both are pure logic, compiled on the PC; `run.mjs` learns the `firmware/lib/ui` folder.

**Files:**
- Create: `firmware/lib/ui/src/ui/gesture.cpp`, `firmware/lib/ui/src/ui/gesture.h`, `firmware/lib/ui/src/ui/keyscript.cpp`, `firmware/lib/ui/src/ui/keyscript.h`
- Test (new): `firmware/host/test_gesture.cpp`
- Test (changed): `firmware/host/run.mjs`

**Interfaces:**
- Consumes (Task 1): `proto::KeyStep {delayMs, mask}`, `proto::KEY_FRONT`, `KEY_SIDE`, `KEY_STEPS_MAX`. From plan 1, the host harness: `TEST(name)`, `CHECK(cond, message)` in `firmware/host/check.h`.
- Produces (`firmware/lib/ui/src/ui/gesture.h`, `keyscript.h`, namespace `ui`):
  - `enum class Ev {None, FrontDown, FrontShort, TalkStart, TalkEnd, SideShort, SideHold, ChordStart, ChordHold}`; `struct Events {Ev ev[2]; uint8_t n;}`: an update has at most two events, `TalkStart` and `TalkEnd` together when the loop only saw the hold at its release.
  - `class Gesture`: constants `HOLD_MS` 300, `CHORD_WINDOW_MS` 150, `SIDE_HOLD_MS` 1000, `CHORD_HOLD_MS` 3000; `Events update(uint32_t now, bool front, bool side)`, called every few milliseconds, `now` may wrap.
  - `class KeyScript`: `void load(const proto::KeyStep* steps, size_t n, uint32_t now)` (drops the script that was running, its keys released; at most 16 steps; each delay counts from the step before it), `uint8_t mask(uint32_t now)` (`KEY_FRONT | KEY_SIDE` bits; after the last step the mask stays, so a script ends with 0), `bool running() const`.

- [ ] **Step 1: Write the failing tests**

In `firmware/host/run.mjs`, replace:

```js
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const libDir = path.join(root, 'firmware', 'lib', 'proto', 'src');
const buildDir = path.join(here, 'build');
mkdirSync(buildDir, { recursive: true });

```

with:

```js
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const libDir = path.join(root, 'firmware', 'lib', 'proto', 'src');
const uiDir = path.join(root, 'firmware', 'lib', 'ui', 'src'); // the screen logic, as pure as the protocol is
const buildDir = path.join(here, 'build');
mkdirSync(buildDir, { recursive: true });

```

In `firmware/host/run.mjs`, replace:

```js
const cpp = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cpp')).map((f) => path.join(dir, f)) : []);
const exe = path.join(buildDir, 'test_proto.exe');
// test_audio.cpp includes firmware/src/audio.cpp itself, against the stubs in host/stubs.
const cc = spawnSync('g++', ['-std=gnu++11', '-O1', '-Wall', '-Wextra', '-Werror', `-I${libDir}`, `-I${buildDir}`,
  `-I${path.join(here, 'stubs')}`, `-I${path.join(root, 'firmware', 'src')}`,
  ...cpp(here), ...cpp(path.join(libDir, 'proto')), '-o', exe], { stdio: 'inherit' });
if (cc.error || cc.status !== 0) {
  console.error(cc.error ? `g++ could not start: ${cc.error.message}` : 'compile failed');
  process.exit(1);
```

with:

```js
const cpp = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cpp')).map((f) => path.join(dir, f)) : []);
const exe = path.join(buildDir, 'test_proto.exe');
// test_audio.cpp includes firmware/src/audio.cpp itself, against the stubs in host/stubs.
const cc = spawnSync('g++', ['-std=gnu++11', '-O1', '-Wall', '-Wextra', '-Werror', `-I${libDir}`, `-I${uiDir}`, `-I${buildDir}`,
  `-I${path.join(here, 'stubs')}`, `-I${path.join(root, 'firmware', 'src')}`,
  ...cpp(here), ...cpp(path.join(libDir, 'proto')), ...cpp(path.join(uiDir, 'ui')), '-o', exe], { stdio: 'inherit' });
if (cc.error || cc.status !== 0) {
  console.error(cc.error ? `g++ could not start: ${cc.error.message}` : 'compile failed');
  process.exit(1);
```

Create `firmware/host/test_gesture.cpp`:

```cpp
// test_gesture.cpp: the key gestures of spec 6.2 and the key scripts that stand in for fingers. A timeline is a list of
// "at t ms the keys are f, s"; the detector is updated every 10 ms, as the UI loop does, and the events come out as text:
// "0:FrontDown 300:TalkStart 500:TalkEnd".
#include <string>
#include <vector>
#include "check.h"
#include "ui/gesture.h"
#include "ui/keyscript.h"

namespace {
struct At {
  uint32_t t;
  bool front, side;
};

const char* name(ui::Ev e) {
  switch (e) {
    case ui::Ev::FrontDown: return "FrontDown";
    case ui::Ev::FrontShort: return "FrontShort";
    case ui::Ev::TalkStart: return "TalkStart";
    case ui::Ev::TalkEnd: return "TalkEnd";
    case ui::Ev::SideShort: return "SideShort";
    case ui::Ev::SideHold: return "SideHold";
    case ui::Ev::ChordStart: return "ChordStart";
    case ui::Ev::ChordHold: return "ChordHold";
    default: return "None";
  }
}

// Updates every 10 ms from `start` to `end` (relative times); the keys are those of the last change at or before the time.
std::string run(const std::vector<At>& timeline, uint32_t end, uint32_t start = 0) {
  ui::Gesture g;
  std::string out;
  bool f = false, s = false;
  for (uint32_t t = 0; t <= end; t += 10) {
    for (const At& a : timeline)
      if (a.t <= t) f = a.front, s = a.side;
    ui::Events ev = g.update(start + t, f, s);
    for (int i = 0; i < ev.n; i++) {
      if (!out.empty()) out += ' ';
      out += std::to_string(t) + ":" + name(ev.ev[i]);
    }
  }
  return out;
}
const bool F = true, S = true, N = false;
}  // namespace

TEST(aShortFrontPressIsNotATalk) {
  CHECK(run({{0, F, N}, {100, N, N}}, 600) == "0:FrontDown 100:FrontShort", "100 ms");
  CHECK(run({{0, F, N}, {290, N, N}}, 600) == "0:FrontDown 290:FrontShort", "290 ms is still short");
}

TEST(aFrontHoldIsATalkFromThreeHundredMilliseconds) {
  CHECK(run({{0, F, N}, {500, N, N}}, 800) == "0:FrontDown 300:TalkStart 500:TalkEnd", "500 ms");
  CHECK(run({{0, F, N}, {310, N, N}}, 800) == "0:FrontDown 300:TalkStart 310:TalkEnd", "just past 300 ms");
  CHECK(run({{0, F, N}, {5000, N, N}}, 6000) == "0:FrontDown 300:TalkStart 5000:TalkEnd", "a long take");
}

TEST(aHoldThatTheLoopOnlySeesAtItsReleaseIsStillATalk) {
  CHECK(run({{0, F, N}, {300, N, N}}, 600) == "0:FrontDown 300:TalkStart 300:TalkEnd", "released on the update that reaches 300 ms");
}

TEST(theSideKeyShortHoldAndTheMiddle) {
  CHECK(run({{0, N, S}, {100, N, N}}, 600) == "100:SideShort", "short");
  CHECK(run({{0, N, S}, {290, N, N}}, 600) == "290:SideShort", "290 ms is still short");
  CHECK(run({{0, N, S}, {300, N, N}}, 600) == "", "300 ms is not");
  CHECK(run({{0, N, S}, {500, N, N}}, 1500) == "", "between a short press and the 1 s hold is nothing");
  CHECK(run({{0, N, S}, {1500, N, N}}, 2000) == "1000:SideHold", "held 1 s: once, and the release is no event");
  CHECK(run({{0, N, S}, {4000, N, N}}, 5000) == "1000:SideHold", "held for longer: still once");
}

TEST(bothKeysWithinTheWindowAreAChordAndNeverATalk) {
  CHECK(run({{0, F, N}, {100, F, S}, {3500, N, N}}, 4000) == "0:FrontDown 100:ChordStart 3100:ChordHold",
        "front, then side 100 ms later; the hold counts from the later key");
  CHECK(run({{0, N, S}, {100, F, S}, {3500, N, N}}, 4000) == "100:ChordStart 3100:ChordHold", "side first");
  CHECK(run({{0, F, S}, {3500, N, N}}, 4000) == "0:ChordStart 3000:ChordHold", "both in the same update");
}

TEST(aChordReleasedEarlyIsNothingAndTheKeysWorkAgainAfterwards) {
  CHECK(run({{0, F, S}, {1000, N, N}, {1500, F, N}, {1600, N, N}}, 2000) == "0:ChordStart 1500:FrontDown 1600:FrontShort",
        "released before 3 s");
  CHECK(run({{0, F, S}, {500, F, N}, {2000, N, N}}, 3000) == "0:ChordStart", "one key let go and the other kept: still the chord's");
  CHECK(run({{0, F, S}, {500, F, N}, {4000, N, N}}, 5000) == "0:ChordStart", "and kept past 3 s it is still no hold: the hold takes both keys");
}

TEST(aSecondKeyAfterTheWindowIsIgnoredUntilItIsReleased) {
  CHECK(run({{0, F, N}, {140, F, S}, {500, N, N}}, 3500) == "0:FrontDown 140:ChordStart", "140 ms is inside the window");
  CHECK(run({{0, F, N}, {150, F, S}, {600, N, N}}, 3500) == "0:FrontDown 300:TalkStart 600:TalkEnd",
        "150 ms is outside it: the talk goes on and the side key does nothing");
  CHECK(run({{0, F, N}, {200, F, S}, {250, N, S}, {400, N, N}}, 1500) == "0:FrontDown 250:FrontShort",
        "the late side key's own release is no event");
  CHECK(run({{0, N, S}, {200, F, S}, {250, F, N}, {400, N, N}}, 1500) == "250:SideShort", "a front key that is late is ignored too");
  CHECK(run({{0, N, S}, {200, F, S}, {1500, N, N}}, 2000) == "1000:SideHold", "and the side key's hold still counts");
  CHECK(run({{0, N, S}, {140, F, S}, {500, N, N}}, 3500) == "140:ChordStart", "the window is the same when the side key comes first");
  CHECK(run({{0, N, S}, {150, F, S}, {250, N, N}}, 600) == "250:SideShort", "and 150 ms is outside it there too");
}

TEST(aKeyThatWasIgnoredForBeingLateWorksAgainOnceItIsLetGo) {
  CHECK(run({{0, N, S}, {200, F, S}, {250, F, N}, {400, N, N}, {600, F, N}, {700, N, N}}, 1500) == "250:SideShort 600:FrontDown 700:FrontShort",
        "the late front key, pressed again");
  CHECK(run({{0, F, N}, {200, F, S}, {250, N, S}, {400, N, N}, {600, N, S}, {700, N, N}}, 1500) == "0:FrontDown 250:FrontShort 700:SideShort",
        "the late side key, pressed again");
}

TEST(theSideKeyPressedInTheMiddleOfATalkDoesNothing) {
  CHECK(run({{0, F, N}, {400, F, S}, {600, F, N}, {800, N, N}}, 1500) == "0:FrontDown 300:TalkStart 800:TalkEnd", "side pressed and released during a talk");
  CHECK(run({{0, F, N}, {400, F, S}, {800, N, S}, {1000, F, S}}, 1500) == "0:FrontDown 300:TalkStart 800:TalkEnd 1000:FrontDown 1300:TalkStart",
        "a side key still resting does not stop the next press of the front key");
}

TEST(timeMayWrapAroundWhileAKeyIsHeld) {
  CHECK(run({{0, F, N}, {500, N, N}}, 800, 0xFFFFFF00u) == "0:FrontDown 300:TalkStart 500:TalkEnd", "a talk across the wrap");
  CHECK(run({{0, F, S}, {3500, N, N}}, 4000, 0xFFFFFF00u) == "0:ChordStart 3000:ChordHold", "a chord across the wrap");
}

TEST(aKeyScriptPressesTheKeysAtTheTimesItNames) {
  ui::KeyScript k;
  proto::KeyStep steps[] = {{0, 1}, {50, 3}, {3000, 0}};
  CHECK(k.mask(500) == 0 && !k.running(), "nothing runs before a script is loaded");
  k.load(steps, 3, 1000);
  CHECK(k.running(), "running");
  CHECK(k.mask(1000) == 1, "the first step, with no delay, applies at once");
  CHECK(k.mask(1049) == 1 && k.mask(1050) == 3, "the second step is 50 ms after the first");
  CHECK(k.mask(4049) == 3 && k.running(), "the third waits 3000 ms after the second");
  CHECK(k.mask(4050) == 0 && !k.running(), "and then the keys are up and the script is over");
  CHECK(k.mask(99999) == 0, "it stays so");
}

TEST(aKeyScriptSurvivesTheClockWrapping) {
  ui::KeyScript k;
  proto::KeyStep steps[] = {{0, 1}, {100, 0}};
  k.load(steps, 2, 0xFFFFFFF0u);
  CHECK(k.mask(0xFFFFFFF0u) == 1 && k.mask(0x53) == 1 && k.mask(0x54) == 0, "100 ms from 0xFFFFFFF0 is 0x54");
}

TEST(aNewKeyScriptReplacesTheOldOneAndReleasesItsKeys) {
  ui::KeyScript k;
  proto::KeyStep a[] = {{0, 3}, {10000, 0}};
  proto::KeyStep b[] = {{500, 1}, {100, 0}};
  k.load(a, 2, 0);
  CHECK(k.mask(0) == 3, "the first script holds both keys");
  k.load(b, 2, 100);
  CHECK(k.mask(100) == 0 && k.mask(599) == 0 && k.mask(600) == 1 && k.mask(700) == 0, "the second starts from its own load time, keys up");
}

TEST(aKeyScriptLongerThanTheBufferIsCutNotOverrun) {
  ui::KeyScript k;
  proto::KeyStep many[40];
  for (int i = 0; i < 40; i++) many[i] = {10, (uint8_t)(i % 2 ? 0 : 1)};
  k.load(many, 40, 0);
  CHECK(k.mask(10 * 16) == 0 && !k.running(), "only 16 steps are kept: the sixteenth is the last");
}

TEST(aKeyScriptDrivesTheGestureLikeFingers) {
  ui::KeyScript k;
  ui::Gesture g;
  proto::KeyStep steps[] = {{0, proto::KEY_FRONT}, {500, 0}};
  k.load(steps, 2, 0);
  std::string out;
  for (uint32_t t = 0; t <= 800; t += 10) {
    uint8_t m = k.mask(t);
    ui::Events ev = g.update(t, (m & proto::KEY_FRONT) != 0, (m & proto::KEY_SIDE) != 0);
    for (int i = 0; i < ev.n; i++) out += (out.empty() ? "" : " ") + std::to_string(t) + ":" + name(ev.ev[i]);
  }
  CHECK(out == "0:FrontDown 300:TalkStart 500:TalkEnd", out.c_str());
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `ui/gesture.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/ui/src/ui/gesture.cpp`:

```cpp
#include "ui/gesture.h"

namespace ui {
namespace {
void add(Events& e, Ev ev) { e.ev[e.n++] = ev; }
}  // namespace

Events Gesture::update(uint32_t now, bool rawFront, bool rawSide) {
  Events out = {{Ev::None, Ev::None}, 0};
  if (blockFront_ && !rawFront) blockFront_ = false;
  if (blockSide_ && !rawSide) blockSide_ = false;
  bool front = rawFront && !blockFront_;
  bool side = rawSide && !blockSide_;
  uint32_t held = now - t0_;

  switch (state_) {
    case Idle:
      if (front && side) {
        state_ = Chord;
        t0_ = now;
        holdSent_ = false;
        add(out, Ev::ChordStart);
      } else if (front) {
        state_ = Front;
        t0_ = now;
        add(out, Ev::FrontDown);
      } else if (side) {
        state_ = Side;
        t0_ = now;
        holdSent_ = false;
      }
      break;

    case Front:
      if (!front) {
        if (held >= Gesture::HOLD_MS) {  // the loop was late: a hold that was only seen at its release
          add(out, Ev::TalkStart);
          add(out, Ev::TalkEnd);
        } else {
          add(out, Ev::FrontShort);
        }
        state_ = Idle;
      } else if (side) {
        if (held < Gesture::CHORD_WINDOW_MS) {
          state_ = Chord;
          t0_ = now;
          holdSent_ = false;
          add(out, Ev::ChordStart);
        } else {
          blockSide_ = true;
        }
      } else if (held >= Gesture::HOLD_MS) {
        state_ = Talk;
        add(out, Ev::TalkStart);
      }
      break;

    case Talk:
      if (!front) {
        state_ = Idle;
        add(out, Ev::TalkEnd);
      } else if (side) {
        blockSide_ = true;
      }
      break;

    case Side:
      if (!side) {
        if (held < Gesture::HOLD_MS) add(out, Ev::SideShort);
        state_ = Idle;
      } else if (front) {
        if (held < Gesture::CHORD_WINDOW_MS) {
          state_ = Chord;
          t0_ = now;
          holdSent_ = false;
          add(out, Ev::ChordStart);
        } else {
          blockFront_ = true;
        }
      } else if (!holdSent_ && held >= Gesture::SIDE_HOLD_MS) {
        holdSent_ = true;
        add(out, Ev::SideHold);
      }
      break;

    case Chord:
      if (!front && !side) {
        state_ = Idle;
      } else if (front && side && !holdSent_ && held >= Gesture::CHORD_HOLD_MS) {
        holdSent_ = true;
        add(out, Ev::ChordHold);
      }
      break;
  }
  return out;
}

}  // namespace ui
```

Create `firmware/lib/ui/src/ui/gesture.h`:

```cpp
// gesture.h: turns the two keys' states into the gestures of spec 6.2. Pure logic, compiled on the PC by firmware/host.
//
// The key that goes down first owns the gesture. A second key that comes down within CHORD_WINDOW_MS of the first makes
// a chord, which can only lead to SWITCH_CONFIRM; a second key that comes down later is ignored until it is released,
// so a finger resting on the side key never turns the front key's talk into something else.
#pragma once
#include <stdint.h>

namespace ui {

enum class Ev : uint8_t {
  None,
  FrontDown,   // the front key went down on its own: a talk may start, the mic can begin to fill its pre-roll
  FrontShort,  // released within HOLD_MS
  TalkStart,   // held for HOLD_MS: the talk begins (the pre-roll goes out)
  TalkEnd,     // released after TalkStart
  SideShort,   // released within HOLD_MS
  SideHold,    // held for SIDE_HOLD_MS; once per press, and the release after it is no event
  ChordStart,  // both keys down within CHORD_WINDOW_MS of each other: any talk that FrontDown prepared is off
  ChordHold,   // both keys held for CHORD_HOLD_MS, counted from the later key's press; once per chord
};

// One update has at most two events: TalkStart and TalkEnd together, when the loop saw a hold only at its release.
struct Events {
  Ev ev[2];
  uint8_t n;
};

class Gesture {
 public:
  static const uint32_t HOLD_MS = 300;
  static const uint32_t CHORD_WINDOW_MS = 150;
  static const uint32_t SIDE_HOLD_MS = 1000;
  static const uint32_t CHORD_HOLD_MS = 3000;

  Gesture() : state_(Idle), t0_(0), blockFront_(false), blockSide_(false), holdSent_(false) {}

  // Call every few milliseconds with the keys as they are now; `now` is in milliseconds and may wrap.
  Events update(uint32_t now, bool front, bool side);

 private:
  enum State : uint8_t { Idle, Front, Talk, Side, Chord };
  State state_;
  uint32_t t0_;         // when the owner key went down, or when the second key of a chord did
  bool blockFront_;     // down, and ignored until it is released
  bool blockSide_;
  bool holdSent_;       // SideHold or ChordHold has been sent for this press
};

}  // namespace ui
```

Create `firmware/lib/ui/src/ui/keyscript.cpp`:

```cpp
#include "ui/keyscript.h"

namespace ui {

void KeyScript::load(const proto::KeyStep* steps, size_t n, uint32_t now) {
  if (n > proto::KEY_STEPS_MAX) n = proto::KEY_STEPS_MAX;
  uint32_t at = now;
  for (size_t i = 0; i < n; i++) {
    at += steps[i].delayMs;
    due_[i] = at;
    masks_[i] = steps[i].mask;
  }
  n_ = n;
  next_ = 0;
  mask_ = 0;
}

uint8_t KeyScript::mask(uint32_t now) {
  while (next_ < n_ && (int32_t)(now - due_[next_]) >= 0) mask_ = masks_[next_++];
  return mask_;
}

}  // namespace ui
```

Create `firmware/lib/ui/src/ui/keyscript.h`:

```cpp
// keyscript.h: the keys a TEST KEYS frame presses, over time. The UI loop ORs the mask with the real keys.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"

namespace ui {

class KeyScript {
 public:
  KeyScript() : n_(0), next_(0), mask_(0) {}

  // Starts a script and drops the one that was running, with its keys released. Each step's delay counts from the step
  // before it (the first from `now`), so a script is the same whenever the loop happens to run. At most KEY_STEPS_MAX.
  void load(const proto::KeyStep* steps, size_t n, uint32_t now);

  // The keys the script holds at `now`: KEY_FRONT and KEY_SIDE bits. After its last step the script keeps that step's
  // mask, so a script has to end with 0.
  uint8_t mask(uint32_t now);

  bool running() const { return next_ < n_; }

 private:
  uint32_t due_[proto::KEY_STEPS_MAX];
  uint8_t masks_[proto::KEY_STEPS_MAX];
  size_t n_, next_;
  uint8_t mask_;
};

}  // namespace ui
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `47 cases, 273 checks passed, 0 failed`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `47 cases, 273 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/run.mjs firmware/host/test_gesture.cpp firmware/lib/ui/src/ui/gesture.cpp firmware/lib/ui/src/ui/gesture.h firmware/lib/ui/src/ui/keyscript.cpp firmware/lib/ui/src/ui/keyscript.h
git commit -m "Task 2: key gestures and key scripts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Text for the screen: sanitize, wrap and clip

A reply, a tool preview or a project name arrives as bytes from outside and has to end up as lines of at most 30 cells on a 240-pixel screen, whatever they are. `sanitize` makes bytes that are safe to draw (a malformed sequence or a character beyond U+FFFF becomes `?`, a control character a space, zero-width and bidirectional format characters go), `wrap` breaks them into lines of whole characters, and `clip` cuts one line to the room it has with an ellipsis. A cell is one for printable ASCII and two for anything else, which wastes a little room on an accented letter and never overflows.

**Files:**
- Create: `firmware/lib/ui/src/ui/text.cpp`, `firmware/lib/ui/src/ui/text.h`
- Test (new): `firmware/host/test_text.cpp`

**Interfaces:**
- Consumes: nothing from earlier tasks; `firmware/host/run.mjs` already compiles `firmware/lib/ui` (Task 2).
- Produces (`firmware/lib/ui/src/ui/text.h`, namespace `ui`):
  - `uint8_t cellsOf(uint32_t codePoint)`: 1 for printable ASCII, 2 otherwise.
  - `size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap)`: UTF-8 into `dst`, NUL-terminated, at most `cap - 1` bytes, ending on a character boundary; returns the length without the NUL (0 when `cap` is 0).
  - `struct Line {uint16_t start, len;}`: byte offsets into the text that was wrapped.
  - `size_t wrap(const char* text, size_t n, uint8_t cells, Line* out, size_t cap)`: breaks sanitized text after each `\n` (blank lines are kept, a trailing `\n` adds none), at the last space before the limit when there is one, otherwise at the limit; always makes progress, even when one character is wider than the line; writes at most `cap` lines and returns how many.
  - `size_t clip(const char* text, size_t n, uint8_t cells, char* dst, size_t cap)`: one line cut to `cells` cells, unchanged when it fits, else its beginning and `…`; NUL-terminated within `cap`; returns the length without the NUL.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_text.cpp`:

```cpp
// test_text.cpp: what the screen does with text that comes from outside: sanitize it, break it into lines of whole
// characters, cut a line to its room. Lines come out joined with '|' so that a wrap reads as one string.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "ui/text.h"

namespace {
std::string san(const std::vector<uint8_t>& in, size_t cap = 4096) {
  std::vector<char> out(cap);
  size_t n = ui::sanitize(in.data(), in.size(), out.data(), cap);
  return std::string(out.data(), n);
}
std::string san(const char* s, size_t cap = 4096) { return san(std::vector<uint8_t>(s, s + std::string(s).size()), cap); }

std::string wrapped(const std::string& text, unsigned cells = 30, size_t cap = 64) {
  std::vector<ui::Line> lines(cap);
  size_t n = ui::wrap(text.data(), text.size(), (uint8_t)cells, lines.data(), cap);
  std::string out;
  for (size_t i = 0; i < n; i++) {
    if (i) out += '|';
    out += text.substr(lines[i].start, lines[i].len);
  }
  return out;
}
size_t lineCount(const std::string& text, unsigned cells = 30, size_t cap = 64) {
  std::vector<ui::Line> lines(cap);
  return ui::wrap(text.data(), text.size(), (uint8_t)cells, lines.data(), cap);
}

std::string clipped(const std::string& text, unsigned cells, size_t cap = 256) {
  std::vector<char> out(cap);
  size_t n = ui::clip(text.data(), text.size(), (uint8_t)cells, out.data(), cap);
  return std::string(out.data(), n);
}

std::string repeat(const char* s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}
const char* ELLIPSIS = "\xE2\x80\xA6";

// The UTF-8 bytes of a code point, as a string.
std::string utf8(uint32_t cp) {
  std::string s;
  if (cp < 0x80) {
    s += (char)cp;
  } else if (cp < 0x800) {
    s += (char)(0xC0 | (cp >> 6));
    s += (char)(0x80 | (cp & 0x3F));
  } else {
    s += (char)(0xE0 | (cp >> 12));
    s += (char)(0x80 | ((cp >> 6) & 0x3F));
    s += (char)(0x80 | (cp & 0x3F));
  }
  return s;
}
}  // namespace

TEST(cellsAreOneForPrintableAsciiAndTwoForTheRest) {
  CHECK(ui::cellsOf('a') == 1 && ui::cellsOf(' ') == 1 && ui::cellsOf('~') == 1, "printable ASCII");
  CHECK(ui::cellsOf(0x597D) == 2, "a Chinese character");
  CHECK(ui::cellsOf(0xE9) == 2, "an accented Latin letter is counted as wide, so it never overflows a line");
  CHECK(ui::cellsOf(0x1F) == 2 && ui::cellsOf(0x7F) == 2, "so is a byte just outside printable ASCII, on either side");
}

TEST(sanitizeKeepsWhatCanBeDrawnAsItIs) {
  CHECK(san("hello, world") == "hello, world", "ASCII");
  CHECK(san("\xE5\xA5\xBD\xE7\x9A\x84") == "\xE5\xA5\xBD\xE7\x9A\x84", "Chinese");
  CHECK(san("a\nb") == "a\nb", "a newline stays");
  CHECK(san("caf\xC3\xA9") == "caf\xC3\xA9", "two-byte letters");
}

TEST(sanitizeReplacesMalformedBytesOneByOne) {
  CHECK(san({0x61, 0x80, 0x62}) == "a?b", "a lone continuation byte");
  CHECK(san({0xE5, 0xA5}) == "??", "a three-byte sequence cut after two bytes");
  CHECK(san({0xE5, 0xA5, 0x61}) == "??a", "a cut sequence does not swallow the character after it");
  CHECK(san({0xC0, 0x80}) == "??", "an overlong form");
  CHECK(san({0xED, 0xA0, 0x80}) == "???", "a surrogate");
  CHECK(san({0xFF, 0xFE}) == "??", "bytes that never occur in UTF-8");
  CHECK(san({0xF4, 0x90, 0x80, 0x80}) == "????", "beyond U+10FFFF");
  CHECK(san({0xE0, 0x9F, 0xBF}) == "???", "an overlong form of a three-byte character");
  CHECK(san({0xF0, 0x8F, 0xBF, 0xBF}) == "????", "an overlong form of a four-byte character");
  CHECK(san({0xF5, 0x80, 0x80, 0x80}) == "????", "a lead byte past F4");
  CHECK(san({0xE0, 0xA0, 0x80}) == "\xE0\xA0\x80", "the first three-byte character that is not overlong");
  CHECK(san({0xF0, 0x90, 0x80, 0x80}) == "?", "the first four-byte character that is not overlong, one the font cannot draw");
  const uint8_t cut[] = {0xE5, 0xA5, 0xBD};
  char out[16];
  CHECK(ui::sanitize(cut, 2, out, sizeof out) == 2 && std::string(out, 2) == "??", "a character that n cuts short is not read past n");
}

TEST(sanitizeTurnsWhatTheFontCannotDrawIntoAQuestionMark) {
  CHECK(san({0xF0, 0x9F, 0x98, 0x80}) == "?", "an emoji is one character, so one question mark");
  CHECK(san({0x61, 0xF0, 0x9F, 0x98, 0x80, 0x62}) == "a?b", "among text");
}

TEST(sanitizeDropsControlAndInvisibleCharacters) {
  CHECK(san({0x61, 0x01, 0x62}) == "a b", "a control character becomes a space");
  CHECK(san({0x61, 0x09, 0x62}) == "a b", "a tab too");
  CHECK(san({0x61, 0x0D, 0x0A, 0x62}) == "a\nb", "CR LF is one newline");
  CHECK(san({0x61, 0x7F, 0x62}) == "a b", "DEL");
  CHECK(san({0x61, 0xC2, 0x85, 0x62}) == "a b", "a C1 control (NEL)");
  CHECK(san({0x61, 0xE2, 0x80, 0x8B, 0x62}) == "ab", "zero width space goes");
  CHECK(san({0x61, 0xE2, 0x80, 0xAE, 0x62}) == "ab", "a right-to-left override goes: it would reverse the lines after it");
  CHECK(san({0xEF, 0xBB, 0xBF, 0x61}) == "a", "a byte order mark goes");
  CHECK(san({0x61, 0xC2, 0xAD, 0x62}) == "ab", "a soft hyphen goes");
  CHECK(san({0x61, 0xC2, 0x9F, 0x62}) == "a b", "the last C1 control");
  CHECK(san({0x61, 0xC2, 0xA0, 0x62}) == "a\xC2\xA0" "b", "and the no-break space after it is text");
}

TEST(sanitizeDropsExactlyTheInvisibleRunsAndNothingNextToThem) {
  const uint32_t gone[] = {0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
                           0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x00AD};
  for (uint32_t cp : gone) {
    char what[40];
    snprintf(what, sizeof what, "U+%04X goes", (unsigned)cp);
    CHECK(san(("a" + utf8(cp) + "b").c_str()) == "ab", what);
  }
  const uint32_t kept[] = {0x200A, 0x2010, 0x2029, 0x202F, 0x205F, 0x2065, 0xFEFE, 0xFF00, 0x00AC, 0x00AE};
  for (uint32_t cp : kept) {
    char what[40];
    snprintf(what, sizeof what, "U+%04X stays", (unsigned)cp);
    CHECK(san(("a" + utf8(cp) + "b").c_str()) == "a" + utf8(cp) + "b", what);
  }
}

TEST(sanitizeNeverWritesPastItsBufferOrEndsInHalfACharacter) {
  const char* two = "\xE5\xA5\xBD\xE5\xA5\xBD";
  CHECK(san(std::vector<uint8_t>(two, two + 6), 4) == "\xE5\xA5\xBD", "room for one of two three-byte characters");
  CHECK(san(std::vector<uint8_t>(two, two + 6), 3) == "", "two bytes of room hold none");
  CHECK(san(std::vector<uint8_t>(two, two + 6), 7) == two, "exactly enough room");
  char untouched = 'x';
  CHECK(ui::sanitize((const uint8_t*)"abc", 3, &untouched, 0) == 0 && untouched == 'x', "no room at all writes nothing");
  CHECK(san("abcdef", 4) == "abc", "ASCII is cut at the buffer");
  char buf[8];
  memset(buf, 'x', sizeof buf);
  CHECK(ui::sanitize((const uint8_t*)"ab", 2, buf, sizeof buf) == 2 && buf[2] == 0, "the text ends in a terminator");
  memset(buf, 'x', sizeof buf);
  CHECK(ui::sanitize((const uint8_t*)"", 0, buf, sizeof buf) == 0 && buf[0] == 0, "so does no text at all");
}

TEST(wrapKeepsShortTextOnOneLine) {
  CHECK(wrapped("hello world") == "hello world", "short");
  CHECK(lineCount("") == 0, "nothing");
  CHECK(lineCount(std::string(30, 'a')) == 1, "exactly 30 cells");
  CHECK(lineCount(std::string(31, 'a')) == 2, "31 cells");
}

TEST(wrapBreaksAfterANewlineAndKeepsBlankLines) {
  CHECK(wrapped("a\nb") == "a|b", "a newline");
  CHECK(wrapped("a\n\nb") == "a||b", "a blank line stays");
  CHECK(wrapped("a\n") == "a", "a trailing newline adds no line");
  CHECK(lineCount("\n") == 1, "a lone newline is one empty line");
}

TEST(wrapBreaksChineseAtAnyCharacterAndCountsTwoCells) {
  std::string forty = repeat("\xE5\xA5\xBD", 40);  // 40 characters, 80 cells
  std::vector<ui::Line> lines(64);
  size_t n = ui::wrap(forty.data(), forty.size(), 30, lines.data(), 64);
  CHECK(n == 3, "80 cells over 30-cell lines: 15, 15 and 10 characters");
  CHECK(lines[0].len == 45 && lines[1].len == 45 && lines[2].len == 30, "in bytes");
  CHECK(lineCount(repeat("\xE5\xA5\xBD", 15)) == 1 && lineCount(repeat("\xE5\xA5\xBD", 16)) == 2, "15 characters fit, 16 do not");
}

TEST(wrapBreaksAsciiAtSpacesWhenItCan) {
  CHECK(wrapped("aaaa bbbb", 6) == "aaaa|bbbb", "at the space");
  CHECK(wrapped("aaaa   bbbb", 5) == "aaaa|bbbb", "spaces left at the start of the next line are dropped");
  CHECK(wrapped("aaaaa bbbbb", 5) == "aaaaa|bbbbb", "a space right at the limit");
  CHECK(wrapped("abcdefghij", 4) == "abcd|efgh|ij", "a word longer than a line is cut at the limit");
  CHECK(wrapped("ab \xE5\xA5\xBD\xE5\xA5\xBD\xE5\xA5\xBD", 6) == "ab|\xE5\xA5\xBD\xE5\xA5\xBD\xE5\xA5\xBD", "ASCII then Chinese: the space is the break");
  CHECK(wrapped("one two three four", 9) == "one two|three|four", "words fill the line");
  CHECK(wrapped("a\n  b") == "a|  b", "an indent after a newline is kept: a preview is often code");
  CHECK(wrapped("aaaa bbbb", 4) == "aaaa|bbbb", "a break at a space leaves it out of both lines");
}

TEST(wrapKeepsAtMostTheLinesItIsGiven) {
  std::string many = repeat("x\n", 100);
  CHECK(lineCount(many, 30, 64) == 64, "100 lines into 64");
  CHECK(lineCount(many, 30, 5) == 5, "or 5");
  CHECK(lineCount(repeat("a", 5000), 30, 64) == 64, "5000 characters into 30-cell lines are cut at 64 lines");
}

TEST(wrapAlwaysMakesProgressEvenWhenACharacterIsWiderThanTheLine) {
  CHECK(wrapped("\xE5\xA5\xBD\xE5\xA5\xBD", 1) == "\xE5\xA5\xBD|\xE5\xA5\xBD", "a wide character on a one-cell line takes a line to itself");
}

TEST(clipLeavesWhatFitsAndEllipsesWhatDoesNot) {
  CHECK(clipped("hello", 30) == "hello", "fits");
  CHECK(clipped("abcdef", 1) == ELLIPSIS && clipped("abcdef", 0) == ELLIPSIS, "less room than the ellipsis takes: the ellipsis alone");
  CHECK(clipped("", 0) == "", "no text in no room is no text");
  CHECK(clipped(std::string(10, 'a'), 10) == std::string(10, 'a'), "exactly fits");
  CHECK(clipped(std::string(40, 'a'), 10) == std::string(8, 'a') + ELLIPSIS, "the ellipsis takes two cells");
  CHECK(clipped(repeat("\xE5\xA5\xBD", 10), 10) == repeat("\xE5\xA5\xBD", 4) + ELLIPSIS, "Chinese: 4 characters and the ellipsis is 10 cells");
  CHECK(clipped(repeat("\xE5\xA5\xBD", 5), 10) == repeat("\xE5\xA5\xBD", 5), "5 characters are 10 cells and fit");
}

TEST(clipNeverWritesPastItsBuffer) {
  CHECK(clipped("abcdef", 3, 5) == "a" + std::string(ELLIPSIS), "room for exactly that");
  CHECK(clipped("abcdefghijklmnop", 10, 3) == "ab", "too little room for an ellipsis: cut, within the buffer");
  CHECK(clipped("abcdefgh", 5, 6) == "abc", "an ellipsis that would leave no room for the terminator is left out");
  CHECK(clipped("abcdefgh", 5, 7) == "abc" + std::string(ELLIPSIS), "and one that just leaves it is kept");
  char buf[8];
  memset(buf, 'x', sizeof buf);
  CHECK(ui::clip("", 0, 4, buf, sizeof buf) == 0 && buf[0] == 0, "no text is a terminator and nothing else");
  char untouched = 'x';
  CHECK(ui::clip("abc", 3, 5, &untouched, 0) == 0 && untouched == 'x', "no room at all writes nothing");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `ui/text.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/ui/src/ui/text.cpp`:

```cpp
#include "ui/text.h"

namespace ui {
namespace {

// The length of the well-formed UTF-8 sequence at p (RFC 3629: no overlong forms, no surrogates, nothing past U+10FFFF)
// and its code point, or 0 when there is none.
size_t decode(const uint8_t* p, size_t n, uint32_t& cp) {
  if (n == 0) return 0;
  uint8_t b = p[0];
  if (b < 0x80) {
    cp = b;
    return 1;
  }
  size_t len;
  uint8_t lo = 0x80, hi = 0xBF;  // the range of the second byte
  if (b >= 0xC2 && b <= 0xDF) {
    len = 2;
    cp = b & 0x1F;
  } else if (b >= 0xE0 && b <= 0xEF) {
    len = 3;
    cp = b & 0x0F;
    if (b == 0xE0) lo = 0xA0;  // not overlong
    if (b == 0xED) hi = 0x9F;  // not a surrogate
  } else if (b >= 0xF0 && b <= 0xF4) {
    len = 4;
    cp = b & 0x07;
    if (b == 0xF0) lo = 0x90;
    if (b == 0xF4) hi = 0x8F;
  } else {
    return 0;
  }
  if (n < len) return 0;
  for (size_t i = 1; i < len; i++) {
    uint8_t c = p[i];
    if (c < (i == 1 ? lo : 0x80) || c > (i == 1 ? hi : 0xBF)) return 0;
    cp = (cp << 6) | (c & 0x3F);
  }
  return len;
}

bool invisible(uint32_t cp) {
  return (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2060 && cp <= 0x2064) || cp == 0xFEFF ||
         cp == 0x00AD;
}

}  // namespace

uint8_t cellsOf(uint32_t cp) { return cp >= 0x20 && cp <= 0x7E ? 1 : 2; }

size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap) {
  if (cap == 0) return 0;
  size_t out = 0, i = 0;
  while (i < n) {
    uint32_t cp = 0;
    size_t len = decode(src + i, n - i, cp);
    const char* put = nullptr;  // what replaces the character, when it is not copied as it is
    size_t putLen = 0;
    char one = 0;
    if (len == 0) {
      len = 1;  // one bad byte at a time, so that a bad lead byte does not swallow the good text after it
      one = '?';
    } else if (cp > 0xFFFF) {
      one = '?';
    } else if (cp == '\n') {
      one = '\n';
    } else if (cp == '\r' || invisible(cp)) {
      i += len;
      continue;
    } else if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) {
      one = ' ';
    }
    if (one) {
      put = &one;
      putLen = 1;
    } else {
      put = (const char*)src + i;
      putLen = len;
    }
    if (out + putLen > cap - 1) break;  // never half a character
    for (size_t k = 0; k < putLen; k++) dst[out++] = put[k];
    i += len;
  }
  dst[out] = 0;
  return out;
}

size_t wrap(const char* text, size_t n, uint8_t cells, Line* out, size_t cap) {
  size_t lines = 0, i = 0;
  const uint8_t* t = (const uint8_t*)text;
  while (i < n && lines < cap) {
    size_t start = i, j = i;
    unsigned width = 0;
    size_t lastSpace = 0;  // where the last space in this line is, 0 for none (a space at `start` is never a break)
    bool broke = false;    // the line ended at the limit, not at a '\n' or the end of the text
    size_t next = n;
    while (j < n) {
      if (t[j] == '\n') {
        next = j + 1;
        break;
      }
      uint32_t cp = 0;
      size_t len = decode(t + j, n - j, cp);
      if (len == 0) len = 1;  // sanitized text has none; be safe all the same
      unsigned w = len == 1 ? cellsOf(t[j]) : 2;
      if (width + w > cells) {
        broke = true;
        if (lastSpace > start) {  // break at the space; the line is what is before it
          next = lastSpace + 1;
          j = lastSpace;
        } else if (j > start) {
          next = j;
        } else {  // not even one character fits: take it anyway, so that every line makes progress
          j += len;
          next = j;
        }
        break;
      }
      if (t[j] == ' ') lastSpace = j;
      width += w;
      j += len;
    }
    out[lines].start = (uint16_t)start;
    out[lines].len = (uint16_t)(j - start);
    lines++;
    i = next;
    if (broke)
      while (i < n && t[i] == ' ') i++;
    if (i >= n) break;
  }
  return lines;
}

size_t clip(const char* text, size_t n, uint8_t cells, char* dst, size_t cap) {
  if (cap == 0) return 0;
  const uint8_t* t = (const uint8_t*)text;
  unsigned total = 0;
  for (size_t i = 0; i < n;) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    total += len == 1 ? cellsOf(t[i]) : 2;
    i += len;
  }
  bool cut = total > cells;
  unsigned room = cut ? (cells >= 2 ? cells - 2u : 0u) : cells;  // the ellipsis takes two cells
  size_t out = 0, i = 0;
  unsigned width = 0;
  while (i < n) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    unsigned w = len == 1 ? cellsOf(t[i]) : 2;
    if (width + w > room || out + len > cap - 1) break;
    for (size_t k = 0; k < len; k++) dst[out++] = (char)t[i + k];
    width += w;
    i += len;
  }
  if (cut && out + 3 <= cap - 1) {  // U+2026 HORIZONTAL ELLIPSIS
    dst[out++] = (char)0xE2;
    dst[out++] = (char)0x80;
    dst[out++] = (char)0xA6;
  }
  dst[out] = 0;
  return out;
}

}  // namespace ui
```

Create `firmware/lib/ui/src/ui/text.h`:

```cpp
// text.h: what the screen needs to do with text that comes from outside: make it safe to draw, break it into lines of
// whole characters, and cut a line to the room it has. Pure logic, compiled on the PC by firmware/host.
//
// Widths are counted in cells: efontCN_16 draws ASCII 8 pixels wide and a Chinese character 16, so a 240-pixel screen is 30
// cells. A character the font draws narrower than two cells (an accented Latin letter) is counted as two, which wastes a
// little room and never overflows the line.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ui {

// 1 for printable ASCII, 2 for everything else.
uint8_t cellsOf(uint32_t codePoint);

// Copies UTF-8 into dst, NUL-terminated and at most cap - 1 bytes, keeping only what can be drawn: a malformed sequence
// (a lone continuation byte, a cut one, an overlong form, a surrogate) and any character beyond U+FFFF become '?'; a
// control character other than '\n' becomes a space, except '\r', which goes; zero-width and bidirectional format
// characters go. The copy ends on a character boundary. Returns the length without the NUL (0 when cap is 0).
size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap);

struct Line {
  uint16_t start;  // byte offsets into the text that was wrapped
  uint16_t len;
};

// Breaks sanitized text into lines of at most `cells` cells: after each '\n' (blank lines are kept, a trailing '\n' adds
// none), at the last space before the limit when there is one, otherwise at the limit. Spaces that a break would leave at
// the start of the next line are dropped. Writes at most cap lines and returns how many; text beyond them is not shown.
size_t wrap(const char* text, size_t n, uint8_t cells, Line* out, size_t cap);

// One line cut to `cells` cells: unchanged when it fits, otherwise its beginning and an ellipsis. NUL-terminated within
// cap; returns the length without the NUL.
size_t clip(const char* text, size_t n, uint8_t cells, char* dst, size_t cap);

}  // namespace ui
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `62 cases, 377 checks passed, 0 failed`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `62 cases, 377 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_text.cpp firmware/lib/ui/src/ui/text.cpp firmware/lib/ui/src/ui/text.h
git commit -m "Task 3: text for the screen: sanitize, wrap and clip" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The state machine: screens, key actions, approvals, switch confirm

What is on the screen, and what each gesture does about it, in one pure state machine. Six screens come from the bridge as UI frames (IDLE to ERROR); the device adds four of its own that sit above them: `SwitchConfirm > Offline > Listening > Approval > the PC's screen`. SwitchConfirm is above Offline so that the S3 can be switched back to on-the-beat when the bridge is not running. Gestures, frames and the clock go in; `Action`s for the main loop to carry out come out in the order they were decided, and `view()` says what to draw: the screen, the sanitized project and text, up to six wrapped lines, whether the text goes on, the page of a long reply, and the elapsed time counted on from the bridge's last figure.

What the keys do, from spec 6.2: a talk is prepared at the front key's first contact, committed at 300 ms and ended at the release, and is allowed in IDLE, WORKING, REPLY and ERROR but not while transcribing, confirming, offline or switching; in an approval a front tap allows, a side tap denies, and a held front key records a reason and denies at the release; side tap cancels in CONFIRM, turns the pages of a long reply and then dismisses it, and closes an error; side held 1 s in WORKING stops Claude; both keys held 3 s open SWITCH_CONFIRM, a front tap confirms it (BUTTON SWITCHING, then BootApp0), a side tap or 10 s cancels it. A UI frame from the bridge ends an approval; so does losing the link, which also ends a talk and forgets the screen that was up.

**Files:**
- Create: `firmware/lib/ui/src/ui/machine.cpp`, `firmware/lib/ui/src/ui/machine.h`
- Test (new): `firmware/host/test_machine.cpp`

**Interfaces:**
- Consumes: `ui::Ev` (Task 2), `ui::Line`, `wrap`, `sanitize` (Task 3), `proto::UiView`, `proto::ApprovalReq`, `proto::UI_*`, `proto::BTN_*` (Task 1).
- Produces (`firmware/lib/ui/src/ui/machine.h`, namespace `ui`):
  - Constants `COLS` 30, `BODY_LINES` 6, `APPROVAL_LINES` 5, `MAX_LINES` 64, `TEXT_CAP` 1024, `SWITCH_TIMEOUT_MS` 10000.
  - `enum class Screen {Idle = proto::UI_IDLE, Transcribing, Confirm, Working, Reply, Error, Approval = 6, Listening = 7, SwitchConfirm = 8, Offline = 9}`.
  - `enum class Act {PrepareTalk, CommitTalk, EndTalk, StopAudio, SendButton, SendApproval, BootApp0}` and `struct Action {Act act; uint8_t arg; uint8_t arg2; uint16_t id;}`: `CommitTalk` has `arg` 1 for a spoken reason; `SendButton`'s `arg` is a `proto::BTN_*`; `SendApproval` has the `id`, `arg` 1 to allow and `arg2` 1 when a spoken reason follows.
  - `struct View {Screen screen; const char* project; const char* tool; const char* text; Line lines[BODY_LINES]; uint8_t nLines; bool more; uint8_t page, pages; bool hasElapsed; uint32_t elapsedMs; bool switching;}`.
  - `class Machine`: `void onGesture(Ev, uint32_t now)`, `void onUi(const proto::UiView&, uint32_t now)`, `void onApprovalReq(const proto::ApprovalReq&, uint32_t now)`, `void tick(uint32_t now, bool linkUp, bool speakerBusy)` (every loop: whether pings still arrive and whether a reply is playing), `bool next(Action&)`, `Screen screen() const`, `View view(uint32_t now) const`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_machine.cpp`:

```cpp
// test_machine.cpp: the screens and what the keys do on each (spec 6.2 and 6.3). A Sim wires a Gesture to a Machine the
// way the UI loop does: every 10 ms the keys are read, the machine is ticked, and the gesture's events go in. The actions
// that come out are read as text: "Prepare Commit0 End".
#include <string>
#include "check.h"
#include "ui/gesture.h"
#include "ui/machine.h"

namespace {
using ui::Screen;

const char* screenName(Screen s) {
  switch (s) {
    case Screen::Idle: return "Idle";
    case Screen::Transcribing: return "Transcribing";
    case Screen::Confirm: return "Confirm";
    case Screen::Working: return "Working";
    case Screen::Reply: return "Reply";
    case Screen::Error: return "Error";
    case Screen::Approval: return "Approval";
    case Screen::Listening: return "Listening";
    case Screen::SwitchConfirm: return "SwitchConfirm";
    case Screen::Offline: return "Offline";
  }
  return "?";
}

std::string actions(ui::Machine& m) {
  std::string out;
  ui::Action a;
  while (m.next(a)) {
    if (!out.empty()) out += ' ';
    switch (a.act) {
      case ui::Act::PrepareTalk: out += "Prepare"; break;
      case ui::Act::CommitTalk: out += a.arg ? "Commit1" : "Commit0"; break;
      case ui::Act::EndTalk: out += "End"; break;
      case ui::Act::StopAudio: out += "Stop"; break;
      case ui::Act::SendButton: out += "Btn" + std::to_string(a.arg); break;
      case ui::Act::SendApproval:
        out += std::string(a.arg ? "Allow" : (a.arg2 ? "DenyReason" : "Deny")) + std::to_string(a.id);
        break;
      case ui::Act::BootApp0: out += "Boot"; break;
    }
  }
  return out;
}

proto::UiView uiFrame(uint8_t state, const std::string& project = "", const std::string& text = "", int elapsed = -1) {
  static std::string keepProject, keepText;  // the view points into them until the next call
  keepProject = project;
  keepText = text;
  proto::UiView v;
  v.state = state;
  v.project = {(const uint8_t*)keepProject.data(), keepProject.size()};
  v.text = {(const uint8_t*)keepText.data(), keepText.size()};
  v.hasElapsed = elapsed >= 0;
  v.elapsedMs = elapsed >= 0 ? (uint32_t)elapsed : 0;
  return v;
}

proto::ApprovalReq request(uint16_t id, const std::string& tool, const std::string& preview) {
  static std::string keepTool, keepPreview;
  keepTool = tool;
  keepPreview = preview;
  proto::ApprovalReq r;
  r.id = id;
  r.tool = {(const uint8_t*)keepTool.data(), keepTool.size()};
  r.preview = {(const uint8_t*)keepPreview.data(), keepPreview.size()};
  return r;
}

struct Sim {
  ui::Machine m;
  ui::Gesture g;
  uint32_t now = 1000;
  bool link = true, busy = false;

  Sim() { m.tick(now, link, busy); }

  void step(bool front, bool side) {
    now += 10;
    m.tick(now, link, busy);
    ui::Events ev = g.update(now, front, side);
    for (int i = 0; i < ev.n; i++) m.onGesture(ev.ev[i], now);
  }
  void hold(uint32_t ms, bool front, bool side) {
    for (uint32_t t = 0; t < ms; t += 10) step(front, side);
  }
  // A key pressed for `ms` and let go, then a pause that lets the gesture settle.
  void front(uint32_t ms) { hold(ms, true, false), hold(20, false, false); }
  void side(uint32_t ms) { hold(ms, false, true), hold(20, false, false); }
  void show(const proto::UiView& v) { m.onUi(v, now); }
  Screen screen() const { return m.screen(); }
  std::string acts() { return actions(m); }
};
}  // namespace

TEST(theMachineIsOfflineUntilTheLinkIsUpThenShowsTheBridgeScreen) {
  ui::Machine m;
  CHECK(m.screen() == Screen::Offline, "a machine nobody has pinged yet");
  m.tick(100, true, false);
  CHECK(m.screen() == Screen::Idle, "pings arrive");
  m.tick(200, false, false);
  CHECK(m.screen() == Screen::Offline, "and stop");
}

TEST(aUiFrameSetsTheScreenAndAnUnknownStateIsIgnored) {
  Sim s;
  const Screen all[] = {Screen::Idle, Screen::Transcribing, Screen::Confirm, Screen::Working, Screen::Reply, Screen::Error};
  for (uint8_t i = 0; i < 6; i++) {
    s.show(uiFrame(i, "walkie"));
    CHECK(s.screen() == all[i], screenName(all[i]));
  }
  s.show(uiFrame(3));
  s.show(uiFrame(9));
  CHECK(s.screen() == Screen::Working, "state 9 changes nothing");
}

TEST(aTalkIsPreparedAtFrontDownCommittedAtTheHoldAndEndedAtTheRelease) {
  Sim s;
  s.hold(100, true, false);
  CHECK(s.acts() == "Prepare" && s.screen() == Screen::Idle, "down: the mic may start its pre-roll, nothing on screen yet");
  s.hold(300, true, false);
  CHECK(s.acts() == "Commit0" && s.screen() == Screen::Listening, "300 ms: the take is on");
  s.hold(20, false, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Idle, "release");
}

TEST(aShortFrontPressOutsideAnApprovalPreparesThenDropsTheTalk) {
  Sim s;
  s.front(100);
  CHECK(s.acts() == "Prepare End", "no take, nothing sent, nothing on screen");
  CHECK(s.screen() == Screen::Idle, "still idle");
}

TEST(talkingIsAllowedInIdleWorkingReplyAndError) {
  const uint8_t ok[] = {proto::UI_IDLE, proto::UI_WORKING, proto::UI_REPLY, proto::UI_ERROR};
  for (uint8_t st : ok) {
    Sim s;
    s.show(uiFrame(st));
    s.hold(400, true, false);
    CHECK(s.acts() == "Prepare Commit0", "allowed");
  }
}

TEST(talkingIsRefusedWhileTranscribingConfirmingOfflineOrSwitching) {
  const uint8_t no[] = {proto::UI_TRANSCRIBING, proto::UI_CONFIRM};
  for (uint8_t st : no) {
    Sim s;
    s.show(uiFrame(st));
    s.hold(400, true, false);
    CHECK(s.acts() == "", "the bridge is busy with the last take");
  }
  Sim off;
  off.link = false;
  off.hold(400, true, false);
  CHECK(off.acts() == "", "offline");
  Sim sw;
  sw.hold(3100, true, true);
  sw.hold(20, false, false);
  sw.acts();
  sw.hold(400, true, false);
  CHECK(sw.acts() == "", "switch confirm");
}

TEST(anApprovalIsShownOverTheScreenBeforeItAndFrontShortAllowsIt) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash", 4000));
  s.m.onApprovalReq(request(7, "Bash", "rm -rf build"), s.now);
  CHECK(s.screen() == Screen::Approval, "over working");
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.tool) == "Bash" && std::string(v.text, v.lines[0].start, v.lines[0].len) == "rm -rf build", "tool and preview");
  s.front(100);
  CHECK(s.acts() == "Prepare End Allow7", "a front tap allows");
  CHECK(s.screen() == Screen::Working, "and the approval is gone from the screen at once");
}

TEST(sideShortDeniesAnApproval) {
  Sim s;
  s.m.onApprovalReq(request(8, "Edit", "x"), s.now);
  s.side(100);
  CHECK(s.acts() == "Deny8" && s.screen() == Screen::Idle, "denied, no reason");
}

TEST(frontHeldInAnApprovalRecordsTheReasonAndDeniesAtTheRelease) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit1" && s.screen() == Screen::Listening, "the take is flagged as a reason");
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9", "the take ends, then the denial that says a reason follows");
  CHECK(s.screen() == Screen::Idle, "the approval is over");
}

TEST(aReasonTakeKeepsTheIdItStartedWithEvenIfTheApprovalWasClearedMeanwhile) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  s.acts();
  s.show(uiFrame(proto::UI_WORKING));
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9", "the bridge ignores an id it no longer knows; the take is flagged all the same");
}

TEST(aTakeThatStartedBeforeTheApprovalIsNotAReason) {
  Sim s;
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit0", "a normal take");
  s.m.onApprovalReq(request(5, "Bash", "ls"), s.now);
  s.hold(20, false, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Approval, "it ends as one, and the approval waits");
}

TEST(aUiFrameFromTheBridgeEndsAnApproval) {
  Sim s;
  s.m.onApprovalReq(request(7, "Bash", "ls"), s.now);
  s.show(uiFrame(proto::UI_WORKING));
  CHECK(s.screen() == Screen::Working, "the bridge answered or timed it out");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and a tap no longer answers anything");
}

TEST(sideShortDependsOnTheScreen) {
  Sim cf;
  cf.show(uiFrame(proto::UI_CONFIRM, "p", "hello"));
  cf.side(100);
  CHECK(cf.acts() == "Btn1", "cancel in CONFIRM");

  Sim pl;
  pl.show(uiFrame(proto::UI_REPLY, "p", "hello"));
  pl.busy = true;
  pl.side(100);
  CHECK(pl.acts() == "Stop", "stop the audio while it plays");
  pl.busy = false;
  pl.side(100);
  CHECK(pl.acts() == "Btn3", "a one-page reply: dismiss when the audio is over");

  Sim er;
  er.show(uiFrame(proto::UI_ERROR, "p", "no network"));
  er.side(100);
  CHECK(er.acts() == "Btn3", "dismiss an error");

  Sim id;
  id.show(uiFrame(proto::UI_IDLE, "p"));
  id.side(100);
  CHECK(id.acts() == "", "nothing to do in IDLE");
  Sim wk;
  wk.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  wk.side(100);
  CHECK(wk.acts() == "", "nothing in WORKING either: a short press does not stop it");
  Sim tr;
  tr.show(uiFrame(proto::UI_TRANSCRIBING, "p"));
  tr.side(100);
  CHECK(tr.acts() == "", "nor in TRANSCRIBING");
}

TEST(sideShortTurnsThePagesOfALongReplyThenDismisses) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 14; i++) text += "line " + std::to_string(i) + (i < 14 ? "\n" : "");  // 14 lines: 3 pages of 6, 6, 2
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  ui::View v = s.m.view(s.now);
  CHECK(v.pages == 3 && v.page == 0 && v.nLines == 6, "page 1 of 3");
  CHECK(std::string(v.text, v.lines[0].start, v.lines[0].len) == "line 1", "from the first line");
  s.side(100);
  v = s.m.view(s.now);
  CHECK(s.acts() == "" && v.page == 1 && std::string(v.text, v.lines[0].start, v.lines[0].len) == "line 7", "page 2");
  s.side(100);
  v = s.m.view(s.now);
  CHECK(v.page == 2 && v.nLines == 2 && std::string(v.text, v.lines[1].start, v.lines[1].len) == "line 14", "page 3 has what is left");
  s.side(100);
  CHECK(s.acts() == "Btn3", "past the last page: dismiss");
}

TEST(aNewUiFrameStartsTheReplyOnItsFirstPage) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 14; i++) text += "line\n";
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  s.side(100);
  CHECK(s.m.view(s.now).page == 1, "turned");
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  CHECK(s.m.view(s.now).page == 0, "a frame, say the resend after a reconnect, starts over");
}

TEST(sideHeldInWorkingStopsTheTurnAndNowhereElse) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  s.hold(1100, false, true);
  CHECK(s.acts() == "Btn2", "stop");
  s.hold(20, false, false);
  CHECK(s.acts() == "", "and the release adds nothing");
  Sim r;
  r.show(uiFrame(proto::UI_REPLY, "p", "x"));
  r.hold(1100, false, true);
  CHECK(r.acts() == "", "no stop in REPLY");
  Sim a;
  a.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  a.m.onApprovalReq(request(1, "Bash", "ls"), a.now);
  a.hold(1100, false, true);
  CHECK(a.acts() == "", "no stop over an approval: the deny key is a short press");
}

TEST(bothKeysHeldForThreeSecondsOpenSwitchConfirmAndTheFrontKeyConfirms) {
  Sim s;
  s.hold(3100, true, true);
  CHECK(s.screen() == Screen::SwitchConfirm && s.acts() == "", "open, with nothing sent yet");
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot" && s.m.view(s.now).switching, "the bridge is told, then the device restarts");
  s.side(100);
  CHECK(s.screen() == Screen::SwitchConfirm, "no way back once confirmed");
}

TEST(sideShortOrTenSecondsCancelSwitchConfirm) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.side(100);
  CHECK(s.screen() == Screen::Idle && s.acts() == "", "cancelled by the side key");
  Sim t;
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(9800, false, false);
  CHECK(t.screen() == Screen::SwitchConfirm, "just under 10 s after it opened it is still waiting");
  t.hold(200, false, false);
  CHECK(t.screen() == Screen::Idle && t.acts() == "", "10 s: gone, and nothing was sent");
}

TEST(aChordNeverStartsATalkAndDropsTheOnePreparedByTheFirstKey) {
  Sim s;
  s.hold(100, true, false);
  s.hold(100, true, true);
  CHECK(s.acts() == "Prepare End", "the front key prepared, the second key within 150 ms cancels it");
  s.hold(400, true, true);
  CHECK(s.acts() == "" && s.screen() == Screen::Idle, "and holding both is no talk");
}

TEST(switchConfirmIsReachableWhileOfflineSoTheDeviceCanAlwaysBeSwitchedBack) {
  Sim s;
  s.link = false;
  s.hold(3100, true, true);
  CHECK(s.screen() == Screen::SwitchConfirm, "above OFFLINE");
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot", "confirmed");
}

TEST(loosingTheLinkEndsATalkClearsAnApprovalAndForgetsTheOldScreen) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash"));
  s.hold(400, true, false);
  s.acts();
  s.link = false;
  s.hold(10, true, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Offline, "the take ends and OFFLINE shows");
  s.hold(20, false, false);
  s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
  s.link = true;
  s.hold(10, false, false);
  s.show(uiFrame(proto::UI_IDLE, "walkie"));
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Idle, "back online, with nothing left of the old WORKING screen");
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.project) == "", "nor of the project name");
}

TEST(anApprovalIsClearedWhenTheLinkGoes) {
  Sim s;
  s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Idle, "a bridge that restarted knows nothing of it");
}

TEST(aTalkIsPreparedEvenWhileAReplyPlaysTheAudioDecidesWhatToDoAboutIt) {
  Sim s;
  s.show(uiFrame(proto::UI_REPLY, "p", "hello"));
  s.busy = true;
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit0", "the machine does not know about pre-roll");
}

TEST(workingCountsTheElapsedTimeOnFromTheBridgesLastFigure) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash", 5000));
  ui::View v = s.m.view(s.now);
  CHECK(v.hasElapsed && v.elapsedMs == 5000, "as sent");
  v = s.m.view(s.now + 2500);
  CHECK(v.elapsedMs == 7500, "2.5 s later");
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  CHECK(!s.m.view(s.now).hasElapsed, "no figure, none shown");
  s.show(uiFrame(proto::UI_REPLY, "p", "x", 5000));
  CHECK(!s.m.view(s.now).hasElapsed, "only WORKING shows one");
}

TEST(textFromTheBridgeIsSanitizedBeforeItIsDrawn) {
  Sim s;
  std::string bad = "ok";
  bad += (char)0xFF;
  bad += "\xE5\xA5";  // a cut character
  bad += "end";
  s.show(uiFrame(proto::UI_ERROR, "p", bad));
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.text, v.lines[0].start, v.lines[0].len) == "ok???end", "each bad byte one question mark");
}

TEST(aLongTextOnANonReplyScreenShowsItsHeadAndSaysThereIsMore) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 20; i++) text += "line " + std::to_string(i) + "\n";
  s.show(uiFrame(proto::UI_WORKING, "p", text));
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && v.more, "six lines and a mark");
  s.show(uiFrame(proto::UI_WORKING, "p", "short"));
  v = s.m.view(s.now);
  CHECK(v.nLines == 1 && !v.more, "short text: no mark");
}

TEST(anApprovalPreviewLongerThanTheScreenShowsItsHeadAndSaysThereIsMore) {
  Sim s;
  std::string preview;
  for (int i = 1; i <= 12; i++) preview += "cmd " + std::to_string(i) + "\n";
  s.m.onApprovalReq(request(4, "Bash", preview), s.now);
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::APPROVAL_LINES && v.more, "the hint line takes one, so five");
  CHECK(std::string(v.text, v.lines[4].start, v.lines[4].len) == "cmd 5", "the head, not the tail");
}

TEST(aHugeTextIsKeptWithinTheBuffersAndTheLineLimit) {
  Sim s;
  std::string huge(5000, 'a');
  s.show(uiFrame(proto::UI_REPLY, "p", huge));
  ui::View v = s.m.view(s.now);
  CHECK(v.pages >= 1 && v.nLines <= ui::BODY_LINES, "no overrun, and the pages the kept text makes");
  s.m.onApprovalReq(request(1, std::string(500, 't'), huge), s.now);
  CHECK(s.m.view(s.now).nLines == ui::APPROVAL_LINES, "an approval too");
}

TEST(aSpokenReasonIsAllowedOverAnyScreenAnApprovalIsOn) {
  const uint8_t base[] = {proto::UI_TRANSCRIBING, proto::UI_CONFIRM};
  for (uint8_t st : base) {
    Sim s;
    s.show(uiFrame(st));
    s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
    s.hold(400, true, false);
    CHECK(s.acts() == "Prepare Commit1", "the approval is what the front key answers, whatever is behind it");
  }
}

TEST(aDroppedTalkCanBePreparedAgain) {
  Sim s;
  s.front(100);
  CHECK(s.acts() == "Prepare End", "dropped at the release");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and the next tap starts from nothing");
  Sim c;
  c.hold(100, true, false);
  c.hold(100, true, true);
  c.hold(20, false, false);
  CHECK(c.acts() == "Prepare End", "dropped by a chord");
  c.front(100);
  CHECK(c.acts() == "Prepare End", "and the same after it");
}

TEST(aSecondFrontDownPreparesNothingAndLeavesALiveTakeAlone) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  CHECK(actions(m) == "Prepare", "one preparation");
  m.onGesture(ui::Ev::TalkStart, 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  CHECK(actions(m) == "Commit0" && m.screen() == Screen::Listening, "a take that is on keeps going");
}

TEST(aTalkEndThatFindsNoLiveTakeEndsWhatWasPreparedAndSendsNoVerdict) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onApprovalReq(request(9, "Bash", "ls"), 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::TalkStart, 0);
  m.onGesture(ui::Ev::TalkEnd, 0);
  CHECK(actions(m) == "Prepare Commit1 End DenyReason9", "a reason take, as before");
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::TalkEnd, 0);
  CHECK(actions(m) == "Prepare End", "a talk that was only prepared ends, and the old reason is not sent again");
}

TEST(aReasonIsForTheApprovalItStartedWithNotForOneThatCameDuringTheTake) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit1", "a reason for 9");
  s.m.onApprovalReq(request(10, "Edit", "x"), s.now);
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9" && s.screen() == Screen::Approval, "9 is denied with it, and 10 is still waiting");
  s.front(100);
  CHECK(s.acts() == "Prepare End Allow10", "a tap answers 10");
}

TEST(aSecondFrontTapWhileSwitchingDoesNotBootAgain) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot", "confirmed");
  s.front(100);
  CHECK(s.acts() == "" && s.m.view(s.now).switching, "a second tap does nothing");
}

TEST(aSecondChordWhileSwitchConfirmIsOpenChangesNothing) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.front(100);
  s.acts();
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.m.view(s.now).switching && s.screen() == Screen::SwitchConfirm, "still switching");
  s.front(100);
  CHECK(s.acts() == "", "and a tap does not boot twice");
  Sim t;
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(4000, false, false);
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(3000, false, false);
  CHECK(t.screen() == Screen::Idle, "the 10 s count from the first chord, not from a later one");
}

TEST(theSideKeyHeldDoesNotStopTheTurnBehindTheSwitchScreenOrWhileOffline) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.acts();
  s.hold(1100, false, true);
  CHECK(s.acts() == "", "behind the switch screen");
  Sim o;
  o.link = false;
  o.hold(10, false, false);
  o.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  o.hold(1100, false, true);
  CHECK(o.acts() == "", "offline");
}

TEST(theSideKeyDoesNothingWhileOffline) {
  Sim a;
  a.link = false;
  a.hold(10, false, false);
  a.m.onApprovalReq(request(2, "Bash", "ls"), a.now);
  a.side(100);
  CHECK(a.acts() == "", "no verdict to a bridge that is not there");
  Sim b;
  b.link = false;
  b.busy = true;
  b.hold(10, false, false);
  b.side(100);
  CHECK(b.acts() == "", "no stop either");
}

TEST(theSideKeyInConfirmCancelsEvenWhileTheLastReplyStillPlays) {
  Sim s;
  s.show(uiFrame(proto::UI_CONFIRM, "p", "hello"));
  s.busy = true;
  s.side(100);
  CHECK(s.acts() == "Btn1", "cancel, not stop");
}

TEST(aLinkThatGoesAndComesBackShowsNothingOfTheScreenBefore) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash: npm test", 4000));
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  ui::View v = s.m.view(s.now);
  CHECK(s.screen() == Screen::Idle, "the screen");
  CHECK(std::string(v.project) == "" && std::string(v.text) == "" && v.nLines == 0 && !v.hasElapsed, "and what it showed");
}

TEST(aScreenThatArrivesWhileTheLinkIsStillDownIsKeptForWhenItComesBack) {
  Sim s;
  s.link = false;
  s.hold(10, false, false);
  s.show(uiFrame(proto::UI_REPLY, "walkie", "hello"));
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Offline, "no link yet");
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Reply && std::string(s.m.view(s.now).project) == "walkie", "the bridge's first frame was not thrown away");
}

TEST(theProjectNameIsTheOneTheLastUiFrameSent) {
  Sim s;
  s.show(uiFrame(proto::UI_IDLE, "walkie"));
  CHECK(std::string(s.m.view(s.now).project) == "walkie", "named");
  s.show(uiFrame(proto::UI_IDLE, "other"));
  CHECK(std::string(s.m.view(s.now).project) == "other", "renamed");
  s.show(uiFrame(proto::UI_IDLE));
  CHECK(std::string(s.m.view(s.now).project) == "", "a frame without one clears it");
}

TEST(switchConfirmClosesAtExactlyTenSecondsAndNeverOnceConfirmed) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onGesture(ui::Ev::ChordHold, 1000);
  m.tick(10999, true, false);
  CHECK(m.screen() == Screen::SwitchConfirm, "a millisecond short");
  m.tick(11000, true, false);
  CHECK(m.screen() == Screen::Idle, "ten seconds");
  m.onGesture(ui::Ev::ChordHold, 20000);
  m.onGesture(ui::Ev::FrontShort, 20100);
  actions(m);
  m.tick(60000, true, false);
  CHECK(m.screen() == Screen::SwitchConfirm, "once confirmed it stays: the device is restarting");
  ui::Machine w;
  w.tick(0xFFFFFF00u, true, false);
  w.onGesture(ui::Ev::ChordHold, 0xFFFFFF00u);
  w.tick(0xFFFFFF10u, true, false);
  CHECK(w.screen() == Screen::SwitchConfirm, "across the clock wrapping it is still open");
  w.tick(9743, true, false);
  CHECK(w.screen() == Screen::SwitchConfirm, "just short of ten seconds after the wrap");
  w.tick(9744, true, false);
  CHECK(w.screen() == Screen::Idle, "and closed at ten");
}

TEST(aTextThatJustFitsHasNoMoreMarkAndOneLineMoreHasOne) {
  Sim s;
  std::string six;
  for (int i = 1; i <= 6; i++) six += "line " + std::to_string(i) + (i < 6 ? "\n" : "");
  std::string seven = six + "\nline 7";
  s.show(uiFrame(proto::UI_WORKING, "p", six));
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && !v.more, "six lines fill the body");
  s.show(uiFrame(proto::UI_WORKING, "p", seven));
  v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && v.more, "a seventh does not fit");
  std::string five = "cmd 1\ncmd 2\ncmd 3\ncmd 4\ncmd 5";
  s.m.onApprovalReq(request(1, "Bash", five), s.now);
  v = s.m.view(s.now);
  CHECK(v.nLines == ui::APPROVAL_LINES && !v.more, "five lines fill an approval");
  s.m.onApprovalReq(request(1, "Bash", five + "\ncmd 6"), s.now);
  CHECK(s.m.view(s.now).more, "a sixth does not fit");
}

TEST(theActionQueueKeepsOrderAndDropsTheNewestWhenFull) {
  ui::Machine m;
  m.tick(0, true, false);
  for (int i = 0; i < 40; i++) m.onGesture(ui::Ev::FrontDown, 0), m.onGesture(ui::Ev::FrontShort, 0);
  int n = 0;
  ui::Action a;
  while (m.next(a)) n++;
  CHECK(n == 16, "16 is the most it holds, and it does not overrun");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `ui/machine.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/ui/src/ui/machine.cpp`:

```cpp
#include "ui/machine.h"

namespace ui {
namespace {
// Counts of lines that fit in a view, however many the text has.
size_t atMost(size_t n, size_t cap) { return n < cap ? n : cap; }
}  // namespace

Machine::Machine()
    : base_(Screen::Idle),
      offline_(true),
      talk_(Talk::Off),
      reasonTake_(false),
      reasonId_(0),
      speakerBusy_(false),
      approval_(false),
      approvalId_(0),
      nPreview_(0),
      nLines_(0),
      page_(0),
      hasElapsed_(false),
      elapsedMs_(0),
      elapsedAt_(0),
      switchOpen_(false),
      switching_(false),
      switchDeadline_(0),
      head_(0),
      count_(0) {
  tool_[0] = preview_[0] = project_[0] = text_[0] = 0;
}

void Machine::push(Act act, uint8_t arg, uint8_t arg2, uint16_t id) {
  const size_t cap = sizeof(queue_) / sizeof(queue_[0]);
  if (count_ == cap) return;  // the loop drains the queue every turn; a full one means it stopped, and the newest is lost
  queue_[(head_ + count_) % cap] = Action{act, arg, arg2, id};
  count_++;
}

bool Machine::next(Action& a) {
  if (count_ == 0) return false;
  a = queue_[head_];
  head_ = (head_ + 1) % (sizeof(queue_) / sizeof(queue_[0]));
  count_--;
  return true;
}

Screen Machine::screen() const {
  if (switchOpen_) return Screen::SwitchConfirm;
  if (offline_) return Screen::Offline;
  if (talk_ == Talk::Live) return Screen::Listening;
  if (approval_) return Screen::Approval;
  return base_;
}

bool Machine::canTalk() const {
  if (offline_ || switchOpen_) return false;
  if (approval_) return true;  // a front hold is the spoken reason
  return base_ == Screen::Idle || base_ == Screen::Working || base_ == Screen::Reply || base_ == Screen::Error;
}

void Machine::answer(bool allow, bool reasonFollows) {
  push(Act::SendApproval, allow ? 1 : 0, reasonFollows ? 1 : 0, approvalId_);
  approval_ = false;
}

void Machine::dropTalk() {
  if (talk_ != Talk::Off) push(Act::EndTalk);
  talk_ = Talk::Off;
}

void Machine::clearBase() {
  base_ = Screen::Idle;
  project_[0] = text_[0] = 0;
  nLines_ = 0;
  page_ = 0;
  hasElapsed_ = false;
}

void Machine::onGesture(Ev ev, uint32_t now) {
  switch (ev) {
    case Ev::FrontDown:
      if (talk_ == Talk::Off && canTalk()) {
        talk_ = Talk::Prepared;
        push(Act::PrepareTalk);
      }
      break;

    case Ev::FrontShort:
      if (talk_ == Talk::Prepared) dropTalk();
      if (switchOpen_) {
        if (!switching_) {
          switching_ = true;
          push(Act::SendButton, proto::BTN_SWITCHING);
          push(Act::BootApp0);
        }
      } else if (approval_) {
        answer(true, false);
      }
      break;

    case Ev::TalkStart:
      if (talk_ == Talk::Prepared) {
        talk_ = Talk::Live;
        reasonTake_ = approval_;
        reasonId_ = approvalId_;
        push(Act::CommitTalk, reasonTake_ ? 1 : 0);
      }
      break;

    case Ev::TalkEnd:
      if (talk_ != Talk::Off) {
        bool wasReason = talk_ == Talk::Live && reasonTake_;
        talk_ = Talk::Off;
        push(Act::EndTalk);
        if (wasReason) {
          push(Act::SendApproval, 0, 1, reasonId_);
          if (approval_ && approvalId_ == reasonId_) approval_ = false;
        }
      }
      break;

    case Ev::SideShort:
      if (switchOpen_) {
        if (!switching_) switchOpen_ = false;
      } else if (offline_) {
        // nothing to act on
      } else if (approval_) {
        answer(false, false);
      } else if (base_ == Screen::Confirm) {
        push(Act::SendButton, proto::BTN_CANCEL);
      } else if (speakerBusy_) {
        push(Act::StopAudio);
      } else if (base_ == Screen::Reply) {
        size_t pages = nLines_ ? (nLines_ + BODY_LINES - 1) / BODY_LINES : 1;
        if ((size_t)page_ + 1 < pages)
          page_++;
        else
          push(Act::SendButton, proto::BTN_DISMISS);
      } else if (base_ == Screen::Error) {
        push(Act::SendButton, proto::BTN_DISMISS);
      }
      break;

    case Ev::SideHold:
      if (!switchOpen_ && !offline_ && !approval_ && base_ == Screen::Working) push(Act::SendButton, proto::BTN_STOP);
      break;

    case Ev::ChordStart:
      dropTalk();
      break;

    case Ev::ChordHold:
      if (!switchOpen_) {
        switchOpen_ = true;
        switching_ = false;
        switchDeadline_ = now + SWITCH_TIMEOUT_MS;
      }
      break;

    case Ev::None:
      break;
  }
}

void Machine::onUi(const proto::UiView& v, uint32_t now) {
  if (v.state > proto::UI_ERROR) return;
  base_ = (Screen)v.state;
  approval_ = false;  // a UI frame from the bridge means that the approval is over
  sanitize(v.project.p, v.project.n, project_, sizeof(project_));
  size_t n = sanitize(v.text.p, v.text.n, text_, sizeof(text_));
  nLines_ = wrap(text_, n, COLS, lines_, MAX_LINES);
  page_ = 0;
  hasElapsed_ = v.hasElapsed;
  elapsedMs_ = v.elapsedMs;
  elapsedAt_ = now;
}

void Machine::onApprovalReq(const proto::ApprovalReq& r, uint32_t) {
  approval_ = true;
  approvalId_ = r.id;
  sanitize(r.tool.p, r.tool.n, tool_, sizeof(tool_));
  size_t n = sanitize(r.preview.p, r.preview.n, preview_, sizeof(preview_));
  nPreview_ = wrap(preview_, n, COLS, previewLines_, MAX_LINES);
}

void Machine::tick(uint32_t now, bool linkUp, bool speakerBusy) {
  speakerBusy_ = speakerBusy;
  if (!linkUp) {
    if (!offline_) {
      offline_ = true;
      dropTalk();
      approval_ = false;
      clearBase();  // whatever the old bridge showed means nothing to the next one
    }
  } else {
    offline_ = false;
  }
  if (switchOpen_ && !switching_ && (int32_t)(now - switchDeadline_) >= 0) switchOpen_ = false;
}

View Machine::view(uint32_t now) const {
  View v;
  v.screen = screen();
  v.project = project_;
  v.tool = tool_;
  v.text = text_;
  v.nLines = 0;
  v.more = false;
  v.page = 0;
  v.pages = 1;
  v.hasElapsed = false;
  v.elapsedMs = 0;
  v.switching = switching_;
  const Line* from = lines_;
  size_t total = nLines_, show = BODY_LINES;
  if (v.screen == Screen::Approval) {
    v.text = preview_;
    from = previewLines_;
    total = nPreview_;
    show = APPROVAL_LINES;
  }
  if (v.screen == Screen::Reply) {
    v.pages = (uint8_t)(total ? (total + BODY_LINES - 1) / BODY_LINES : 1);
    v.page = page_;
    size_t start = (size_t)page_ * BODY_LINES;
    from += start;
    total = total > start ? total - start : 0;
  } else {
    v.more = total > show;
  }
  v.nLines = (uint8_t)atMost(total, show);
  for (uint8_t i = 0; i < v.nLines; i++) v.lines[i] = from[i];
  if (base_ == Screen::Working && hasElapsed_) {
    v.hasElapsed = true;
    v.elapsedMs = elapsedMs_ + (now - elapsedAt_);
  }
  return v;
}

}  // namespace ui
```

Create `firmware/lib/ui/src/ui/machine.h`:

```cpp
// machine.h: what is on the screen and what the keys do about it (spec 6.2 and 6.3). Pure logic, compiled on the PC by
// firmware/host. It owns no hardware: gestures, frames from the PC and the clock go in; actions for the main loop to carry
// out come out, and view() says what to draw.
//
// Six screens come from the PC as UI frames (Idle to Error). The rest are the device's own and sit above them:
//   SwitchConfirm > Offline > Listening > Approval > the PC's screen.
// SwitchConfirm is above Offline so that the device can be switched back to app0 when the bridge is not running.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"
#include "ui/gesture.h"
#include "ui/text.h"

namespace ui {

const uint8_t COLS = 30;                           // a 240-pixel line in cells (text.h)
const uint8_t BODY_LINES = 6;                      // lines of text under the header
const uint8_t APPROVAL_LINES = BODY_LINES - 1;     // the hint line takes one
const size_t MAX_LINES = 64;                       // lines kept of a text, however long it is
const size_t TEXT_CAP = 1024;                      // bytes kept of a text
const uint32_t SWITCH_TIMEOUT_MS = 10000;

enum class Screen : uint8_t {
  Idle = proto::UI_IDLE,
  Transcribing = proto::UI_TRANSCRIBING,
  Confirm = proto::UI_CONFIRM,
  Working = proto::UI_WORKING,
  Reply = proto::UI_REPLY,
  Error = proto::UI_ERROR,
  Approval = 6,
  Listening = 7,
  SwitchConfirm = 8,
  Offline = 9,
};

enum class Act : uint8_t {
  PrepareTalk,   // the front key went down: the mic may start filling its pre-roll
  CommitTalk,    // the hold reached 300 ms: the take is on; arg 1 when it is a spoken reason for a denial
  EndTalk,       // the take is over, or was never committed (then it is dropped without a word)
  StopAudio,     // cut the reply that is playing
  SendButton,    // arg: proto::BTN_*
  SendApproval,  // id; arg 1 allow; arg2 1 when the spoken reason follows
  BootApp0,      // restart into app0
};
struct Action {
  Act act;
  uint8_t arg;
  uint8_t arg2;
  uint16_t id;
};

struct View {
  Screen screen;
  const char* project;  // sanitized
  const char* tool;     // Approval
  const char* text;     // the body lines index into this
  Line lines[BODY_LINES];  // what to draw of the body
  uint8_t nLines;
  bool more;            // the text goes on beyond what is shown (not on Reply, which pages)
  uint8_t page, pages;  // Reply: from 0
  bool hasElapsed;
  uint32_t elapsedMs;   // Working: as of this call, counted on from the PC's last figure
  bool switching;       // SwitchConfirm after the front key: the device is about to restart
};

class Machine {
 public:
  Machine();

  void onGesture(Ev ev, uint32_t now);
  void onUi(const proto::UiView& v, uint32_t now);
  void onApprovalReq(const proto::ApprovalReq& r, uint32_t now);
  // Every loop: whether pings still arrive, and whether a reply is playing.
  void tick(uint32_t now, bool linkUp, bool speakerBusy);

  bool next(Action& a);  // the actions in the order they were decided; false when there are none
  Screen screen() const;
  View view(uint32_t now) const;

 private:
  enum class Talk : uint8_t { Off, Prepared, Live };

  bool canTalk() const;
  void push(Act act, uint8_t arg = 0, uint8_t arg2 = 0, uint16_t id = 0);
  void answer(bool allow, bool reasonFollows);
  void dropTalk();
  void clearBase();

  Screen base_;
  bool offline_;
  Talk talk_;
  bool reasonTake_;
  uint16_t reasonId_;
  bool speakerBusy_;

  bool approval_;
  uint16_t approvalId_;
  char tool_[72];
  char preview_[TEXT_CAP];
  Line previewLines_[MAX_LINES];
  size_t nPreview_;

  char project_[72];
  char text_[TEXT_CAP];
  Line lines_[MAX_LINES];
  size_t nLines_;
  uint8_t page_;
  bool hasElapsed_;
  uint32_t elapsedMs_, elapsedAt_;

  bool switchOpen_, switching_;
  uint32_t switchDeadline_;

  Action queue_[16];
  size_t head_, count_;
};

}  // namespace ui
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `106 cases, 498 checks passed, 0 failed`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `106 cases, 498 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_machine.cpp firmware/lib/ui/src/ui/machine.cpp firmware/lib/ui/src/ui/machine.h
git commit -m "Task 4: the state machine: screens, key actions, approvals, switch confirm" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Takes with a pre-roll, the REASON flag and a test mic source

The audio task so far started recording when the talk key was held. A hold only counts after 300 ms, and the first words of a request pass in that time. So the mic now starts filling a 400 ms pre-roll when the front key first goes down, the take is committed when the hold counts (the pre-roll goes out first, then the live chunks) and a take that ends before that is dropped without a frame. A take can be committed as the spoken reason for a denial, and its EOS frame then carries `F_REASON`. A reply that is playing is left alone until a take is committed, and `replyBusy()` tells the UI loop whether one is arriving or playing. For the TEST hooks, the mic's output can be replaced by a FIFO of injected PCM (`1u << 19` bytes, 16.4 s), and the level of the last 20 ms of a take is published for the LISTENING bar. The tests drive the real `audio.cpp` against the host stubs, one task's action at a time, so that they can put the other task's action at the instant that matters.

**Files:**
- Modify: `firmware/src/audio.cpp`, `firmware/src/audio.h`, `firmware/src/main.cpp`, `firmware/src/status.h`
- Test (changed): `firmware/host/stubs/Arduino.h`, `firmware/host/stubs/M5Unified.h`, `firmware/host/test_audio.cpp`

**Interfaces:**
- Consumes: `proto::F_REASON`, `proto::F_EOS` (Task 1); the stubs `firmware/host/stubs/Arduino.h` and `M5Unified.h` and the harness of `test_audio.cpp` (plan 1); `g_status` in `status.h`.
- Produces (`firmware/src/audio.h`, namespace `audio`, replacing `setTalk(bool)`):
  - UI loop: `void prepareTalk()`, `void commitTalk(bool reason)`, `void endTalk()`, `bool replyBusy()` (thread-safe), `void requestStop()` (cuts the reply that is playing; the RX task turns it into a stop at its next idle pass).
  - RX task, for the TEST hooks: `void micSource(bool on)` (switching it off empties the FIFO) and `size_t micPcm(const uint8_t* pcm, size_t len)` (PCM16 at 16 kHz into the FIFO; an odd last byte is dropped; returns the bytes that fitted).
  - `g_status.micLevel` (`std::atomic<uint8_t>`): the peak of the last chunk of a take, 0 to 255 of full scale.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `firmware/host/stubs/Arduino.h` with:

```cpp
// Host stub of the bits of Arduino and FreeRTOS that firmware/src/audio.cpp uses. Single-threaded: the tests drive the
// RX-task and audio-task functions by hand, in the interleavings they want to check.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef uint32_t TickType_t;
typedef void (*TaskFunction_t)(void*);

extern uint32_t g_ms;              // the fake clock, in milliseconds
extern void (*g_onDelay)();        // runs inside vTaskDelay and Mic.record: stands for another task or the key being released

inline uint32_t millis() { return g_ms; }
inline void vTaskDelay(uint32_t t) {
  g_ms += t;
  if (g_onDelay) g_onDelay();
}
inline TickType_t xTaskGetTickCount() { return g_ms; }
inline void vTaskDelayUntil(TickType_t* last, TickType_t inc) {
  *last += inc;
  if (g_ms < *last) g_ms = *last;
  if (g_onDelay) g_onDelay();
}
#define pdMS_TO_TICKS(x) (x)
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
inline void* heap_caps_malloc(size_t n, int) { return malloc(n); }
inline int xTaskCreatePinnedToCore(TaskFunction_t, const char*, int, void*, int, void*, int) { return 1; }
```

In `firmware/host/stubs/M5Unified.h`, replace:

```cpp
struct FakeMic {
  MicCfg cfg;
  bool beginOk = true, recordOk = true;
  MicCfg config() const { return cfg; }
  void config(const MicCfg& c) { cfg = c; }
  bool begin() { return beginOk; }
  void end() {}
  bool record(int16_t*, size_t, uint32_t) {
    if (g_onDelay) g_onDelay();  // a real record() blocks: the key can be released meanwhile
    return recordOk;
  }
```

with:

```cpp
struct FakeMic {
  MicCfg cfg;
  bool beginOk = true, recordOk = true;
  int begins = 0, ends = 0, records = 0;
  int16_t fixed = 0;  // when not 0, every sample of a chunk is this; otherwise the number of the chunk, counting from 1
  MicCfg config() const { return cfg; }
  void config(const MicCfg& c) { cfg = c; }
  bool begin() {
    begins++;
    return beginOk;
  }
  void end() { ends++; }
  bool record(int16_t* buf, size_t n, uint32_t) {
    records++;
    if (recordOk)
      for (size_t i = 0; i < n; i++) buf[i] = fixed ? fixed : (int16_t)records;
    if (g_onDelay) g_onDelay();  // a real record() blocks: the key can be released meanwhile
    return recordOk;
  }
```

In `firmware/host/test_audio.cpp`, replace:

```cpp
static void reset() {
  static bool attached = false;
  if (!attached) {
    audio::ring.attach((uint8_t*)malloc(audio::RING_BYTES), audio::RING_BYTES);
    attached = true;
  }
  for (int i = 0; i < 960; i++) pcm[i] = (uint8_t)(i * 7 + 1);
  M5.Speaker = FakeSpeaker();
  M5.Mic = FakeMic();
  g_onDelay = nullptr;
  onPlayed = nullptr;
  audio::stopWanted.store(false);
  audio::talkHeld.store(false);
  audio::onHello();
  audio::handleFlush();
  sent.clear();
}

// F1: PLAYED is the PC's cue to start the next reply, so everything the RX task can see must be reset before it goes out.
```

with:

```cpp
static void reset() {
  static bool attached = false;
  if (!attached) {
    audio::ring.attach((uint8_t*)malloc(audio::RING_BYTES), audio::RING_BYTES);
    attached = true;
  }
  static bool injectAttached = false;
  if (!injectAttached) {
    audio::injectRing.attach((uint8_t*)malloc(audio::INJECT_BYTES), audio::INJECT_BYTES);
    injectAttached = true;
  }
  for (int i = 0; i < 960; i++) pcm[i] = (uint8_t)(i * 7 + 1);
  M5.Speaker = FakeSpeaker();
  M5.Mic = FakeMic();
  g_onDelay = nullptr;
  onPlayed = nullptr;
  audio::stopWanted.store(false);
  audio::endTalk();
  audio::talkCommitted.store(false);
  audio::talkReason.store(false);
  audio::injectOn.store(false);
  audio::injectClear.store(false);
  audio::injectRing.clear();
  g_status.micLevel = 0;
  g_status.takes = 0;
  audio::onHello();
  audio::handleFlush();
  sent.clear();
}

// F1: PLAYED is the PC's cue to start the next reply, so everything the RX task can see must be reset before it goes out.
```

In `firmware/host/test_audio.cpp`, replace:

```cpp
  runAudio(400);
  CHECK(audio::speakerOn && audio::stats.bytes > 0, "the reply is playing");
  CHECK(count(proto::T_PLAYED) == 0, "nothing is reported while it plays");
  uint32_t playedBefore = audio::stats.bytes, takesBefore = g_status.takes;
  static int hookCalls;
  hookCalls = 0;
  audio::talkHeld.store(true);  // the key goes down
  g_onDelay = [] {
    if (audio::stopWanted.load()) audio::rxIdle();  // RX task: turns the audio task's request into a stop
    else if (++hookCalls >= 4) audio::talkHeld.store(false);  // the key is released after a few mic buffers, stop or no stop
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1 && p[0].reason == proto::PLAYED_STOPPED, "one PLAYED, and it says stopped");
  if (p.size() == 1) CHECK(p[0].bytes == playedBefore, "it counts what played, not the rest of the reply");
```

with:

```cpp
  runAudio(400);
  CHECK(audio::speakerOn && audio::stats.bytes > 0, "the reply is playing");
  CHECK(count(proto::T_PLAYED) == 0, "nothing is reported while it plays");
  uint32_t playedBefore = audio::stats.bytes, takesBefore = g_status.takes;
  static int hookCalls;
  hookCalls = 0;
  audio::prepareTalk();  // the key went down and was held
  audio::commitTalk(false);
  g_onDelay = [] {
    if (audio::stopWanted.load()) audio::rxIdle();  // RX task: turns the audio task's request into a stop
    else if (++hookCalls >= 4) audio::endTalk();  // the key is released after a few mic buffers, stop or no stop
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1 && p[0].reason == proto::PLAYED_STOPPED, "one PLAYED, and it says stopped");
  if (p.size() == 1) CHECK(p[0].bytes == playedBefore, "it counts what played, not the rest of the reply");
```

In `firmware/host/test_audio.cpp`, replace:

```cpp
}

// F8: a mic that will not start ends the take with an empty EOS and waits for the key.
TEST(audioMicThatWillNotStartEndsTheTake) {
  reset();
  M5.Mic.beginOk = false;
  audio::talkHeld.store(true);
  g_onDelay = [] { audio::talkHeld.store(false); };  // the key is released while the take waits
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}

TEST(audioMicThatStopsRecordingEndsTheTake) {
  reset();
  M5.Mic.recordOk = false;
  audio::talkHeld.store(true);
  g_onDelay = [] { audio::talkHeld.store(false); };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}
```

with:

```cpp
}

// F8: a mic that will not start ends the take with an empty EOS and waits for the key.
TEST(audioMicThatWillNotStartEndsTheTake) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] { audio::endTalk(); };  // the key is released while the take waits
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}

TEST(audioMicThatStopsRecordingEndsTheTake) {
  reset();
  M5.Mic.recordOk = false;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] { audio::endTalk(); };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}

// ---- plan 4: takes with a pre-roll, the REASON flag, and the TEST mic source -------------------------------------------

// The first sample of each AUDIO_UP frame that has audio: the fake mic fills chunk n with the value n, so this is the order
// and the numbers of the chunks that went out.
static std::vector<int> upSeq() {
  std::vector<int> out;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP && s.p.size() >= 2) out.push_back((int16_t)(s.p[0] | s.p[1] << 8));
  return out;
}
static const Sent* lastUp() {
  const Sent* last = nullptr;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP) last = &s;
  return last;
}
static int calls;

TEST(audioPreRollGoesOutWhenTheTakeIsCommitted) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 30) audio::commitTalk(false);  // the hold reached 300 ms
    if (calls == 40) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  CHECK(seq.size() == 32, "chunks 9 to 40: the 20 before the commit and everything after it");
  bool inOrder = !seq.empty() && seq.front() == 9 && seq.back() == 40;
  for (size_t i = 1; i < seq.size(); i++) inOrder = inOrder && seq[i] == seq[i - 1] + 1;
  CHECK(inOrder, "the pre-roll is the 20 chunks before the commit, oldest first, and no chunk is lost or sent twice");
  const Sent* last = lastUp();
  CHECK(last && last->flags == proto::F_EOS, "the take ends with a plain EOS");
  CHECK(g_status.takes == 1, "one take");
}

TEST(audioPreRollIsWholeWhenTheCommitComesEarly) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 8) audio::commitTalk(false);
    if (calls == 12) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  CHECK(!seq.empty() && seq.front() == 1 && seq.back() == 12 && seq.size() == 12, "from the very first chunk to the last");
}

TEST(audioTakeEndedBeforeItsCommitIsDroppedWithoutAFrame) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    if (++calls == 10) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 0, "nothing was sent: the PC never hears of a take that was only a press");
  CHECK(g_status.takes == 0 && M5.Mic.ends == 1 && g_status.micLevel == 0, "not counted, and the mic is closed again");
  CHECK(!audio::talkWanted(), "and the task does not start another");
}

TEST(audioCommitAndEndSeenTogetherStillGiveATake) {
  reset();
  audio::prepareTalk();
  audio::commitTalk(false);
  audio::endTalk();  // the UI loop saw the hold only at its release
  CHECK(audio::talkWanted(), "the committed take is still wanted although the key is up");
  audio::talk();
  CHECK(count(proto::T_AUDIO_UP) == 2, "the two chunks that were already recording");
  const Sent* last = lastUp();
  CHECK(last && (last->flags & proto::F_EOS), "and an EOS");
  CHECK(g_status.takes == 1 && !audio::talkWanted(), "counted once, and over");
}

TEST(audioSpokenReasonFlagsOnlyTheEosFrame) {
  reset();
  calls = 0;
  audio::prepareTalk();
  audio::commitTalk(true);
  g_onDelay = [] {
    if (++calls == 6) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  int plain = 0;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP && s.flags == 0) plain++;
  const Sent* last = lastUp();
  CHECK(last && last->flags == (proto::F_EOS | proto::F_REASON), "the EOS frame carries REASON");
  CHECK(plain == count(proto::T_AUDIO_UP) - 1, "no other frame does");
}

TEST(audioReasonTakeThatCouldNotRecordStillEndsFlaggedAsAReason) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  audio::commitTalk(true);
  g_onDelay = [] { audio::endTalk(); };
  audio::talk();
  g_onDelay = nullptr;
  const Sent* last = lastUp();
  CHECK(count(proto::T_AUDIO_UP) == 1 && last && last->flags == (proto::F_EOS | proto::F_REASON) && last->p.empty(),
        "one empty EOS, flagged, so the bridge pairs it with the denial");
}

TEST(audioMicThatWillNotStartForAPressThatNeverCommitsIsSilent) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  g_onDelay = [] { audio::endTalk(); };  // released within 300 ms
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 0 && !audio::talkWanted(), "nothing sent, and the task is not stuck on the key");
}

TEST(audioMicThatWillNotStartEndsEmptyWhenTheTakeIsCommittedLater) {
  reset();
  M5.Mic.beginOk = false;
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 1) audio::commitTalk(false);
    if (calls == 3) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  const Sent* last = lastUp();
  CHECK(count(proto::T_AUDIO_UP) == 1 && last && last->flags == proto::F_EOS && last->p.empty(), "the commit makes it a take, and it ends empty");
}

TEST(audioAPreparedTakeLeavesAPlayingReplyAloneUntilItIsCommitted) {
  reset();
  for (int i = 0; i < 100; i++) frame(false);
  runAudio(400);
  CHECK(audio::speakerOn && audio::replyBusy(), "a reply is playing");
  audio::prepareTalk();
  CHECK(!audio::talkWanted(), "a prepared take does not want the codec while a reply uses it");
  audio::talk();
  CHECK(!audio::stopWanted.load() && audio::speakerOn && M5.Mic.begins == 0, "talk() does nothing about it");
  audio::commitTalk(false);
  CHECK(audio::talkWanted(), "the commit does");
}

TEST(audioReplyBusyIsTrueFromTheFirstByteToTheLastSoundAndFalseAfter) {
  reset();
  CHECK(!audio::replyBusy(), "idle");
  frame(false);
  CHECK(audio::replyBusy(), "audio has arrived");
  for (int i = 0; i < 14; i++) frame(i == 13);
  runAudio(3000);
  CHECK(!audio::replyBusy(), "played out");
}

TEST(audioLevelIsThePeakOfAChunkInHundredsAndTwentiethsOfFullScale) {
  reset();
  M5.Mic.fixed = 16384;
  calls = 0;
  static int seen;
  seen = -1;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    calls++;
    if (calls == 6) seen = g_status.micLevel;
    if (calls == 8) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(seen == 128, "half of full scale is 128 of 255");
  CHECK(g_status.micLevel == 0, "and the bar is empty again after the take");
  reset();
  M5.Mic.fixed = -32768;
  calls = 0;
  seen = -1;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    calls++;
    if (calls == 6) seen = g_status.micLevel;
    if (calls == 8) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(seen == 255, "the most negative sample does not wrap");
}

TEST(audioInjectedPcmIsTheTakeAndTheMicStaysClosed) {
  reset();
  audio::micSource(true);
  uint8_t bytes[5 * 640];
  for (int k = 0; k < 5; k++)
    for (int i = 0; i < 320; i++) {
      int16_t v = (int16_t)((k + 1) * 100);
      bytes[k * 640 + i * 2] = (uint8_t)(v & 0xFF);
      bytes[k * 640 + i * 2 + 1] = (uint8_t)(v >> 8);
    }
  CHECK(audio::micPcm(bytes, sizeof bytes) == sizeof bytes, "the FIFO takes it");
  calls = 0;
  uint32_t t0 = g_ms;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    if (++calls == 9) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  const int want[] = {100, 200, 300, 400, 500, 0, 0, 0, 0};
  bool same = seq.size() == 9;
  for (size_t i = 0; same && i < 9; i++) same = seq[i] == want[i];
  CHECK(same, "the five chunks in order, then silence for what had not arrived");
  CHECK(M5.Mic.begins == 0 && M5.Mic.records == 0, "the real mic was never opened");
  CHECK(g_ms - t0 >= 9 * 20, "paced at the mic's speed: 20 ms a chunk");
}

TEST(audioMicSourceOffClearsTheFifoAndAnOddByteIsDropped) {
  reset();
  audio::micSource(true);
  uint8_t b[641] = {};
  CHECK(audio::micPcm(b, 641) == 640, "an odd byte count loses the half sample");
  audio::micSource(false);
  audio::handleInjectClear();
  CHECK(audio::injectRing.size() == 0, "switching it off empties the FIFO");
  std::vector<uint8_t> big(audio::INJECT_BYTES + 100);
  CHECK(audio::micPcm(big.data(), big.size()) == audio::INJECT_BYTES, "a FIFO that is full takes what fits");
}

TEST(audioRequestStopFromTheUiLoopStopsThePlayingReplyOnce) {
  reset();
  for (int i = 0; i < 100; i++) frame(false);  // 96,000 bytes and no EOS: the reply is still arriving
  runAudio(400);
  CHECK(audio::speakerOn, "the reply is playing");
  audio::requestStop();  // the side key, in the UI loop
  audio::rxIdle();       // RX task: turns the request into a stop
  runAudio(10);          // audio task: reports it
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1 && p[0].reason == proto::PLAYED_STOPPED, "one PLAYED, and it says stopped");
  CHECK(!audio::speakerOn && audio::ring.size() == 0, "the speaker is off and the ring is empty");
  audio::requestStop();  // an impatient second press
  audio::rxIdle();
  runAudio(10);
  CHECK(played().size() == 1, "reported once");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `'injectRing' is not a member of 'audio'`, `'INJECT_BYTES' is not a member of 'audio'`, and 2 more.

- [ ] **Step 3: Write the implementation**

In `firmware/src/audio.cpp`, replace:

```cpp
const size_t UP_SAMPLES = 320;
const int UP_BUFS = 4;
int16_t upBuf[UP_BUFS][UP_SAMPLES];
std::atomic<bool> talkHeld{false};
std::atomic<uint16_t> patternFrames{0};

// Downlink: the RX task writes the ring; this task reads it into 100 ms speaker requests.
const uint32_t DOWN_RATE = 24000;
const uint32_t START_BYTES = 14400;  // 300 ms buffered before playing, unless the reply has ended
```

with:

```cpp
const size_t UP_SAMPLES = 320;
const int UP_BUFS = 4;
int16_t upBuf[UP_BUFS][UP_SAMPLES];
const int PRE_CHUNKS = 20;  // 400 ms of pre-roll
int16_t pre[PRE_CHUNKS][UP_SAMPLES];
int preHead = 0, preCount = 0;  // audio task only
std::atomic<uint16_t> patternFrames{0};

// The UI loop's side of a take. A key press is prepareTalk(), commitTalk(), endTalk() in that order. The committed flag
// is kept until the audio task has dealt with the take, so a hold that the UI loop saw only at its release (commit and end
// together) still gives a take, and the audio task reads talkOn before talkCommitted: if it sees the end, the commit before
// it is visible too.
std::atomic<bool> talkOn{false};
std::atomic<bool> talkCommitted{false};
std::atomic<bool> talkReason{false};

// TEST MIC_SOURCE and MIC_PCM: 16 s of 16 kHz PCM16, written by the RX task and read, paced at the mic's speed, by the
// audio task, which also clears it.
const uint32_t INJECT_BYTES = 1u << 19;
proto::ByteRing injectRing;
std::atomic<bool> injectOn{false};
std::atomic<bool> injectClear{false};
bool takeInject = false;  // audio task: this take reads the FIFO
TickType_t injectLast = 0;

// Downlink: the RX task writes the ring; this task reads it into 100 ms speaker requests.
const uint32_t DOWN_RATE = 24000;
const uint32_t START_BYTES = 14400;  // 300 ms buffered before playing, unless the reply has ended
```

In `firmware/src/audio.cpp`, replace:

```cpp
int nextChunk = 0;
proto::Played stats = {};

void sendUp(const int16_t* pcm, size_t samples, bool eos) {
  usblink::send(proto::T_AUDIO_UP, eos ? proto::F_EOS : 0, (const uint8_t*)pcm, (uint16_t)(samples * 2));
}

// Takes the counters by value: the caller resets its state before this goes out (see finishReply).
```

with:

```cpp
int nextChunk = 0;
proto::Played stats = {};

void sendUp(const int16_t* pcm, size_t samples, bool eos, bool reason = false) {
  uint8_t flags = eos ? (uint8_t)(proto::F_EOS | (reason ? proto::F_REASON : 0)) : 0;
  usblink::send(proto::T_AUDIO_UP, flags, (const uint8_t*)pcm, (uint16_t)(samples * 2));
}

// Takes the counters by value: the caller resets its state before this goes out (see finishReply).
```

In `firmware/src/audio.cpp`, replace:

```cpp
  }
}

// The mic failed: end the take for the PC with an empty EOS, then wait for the key, so talk() is not re-entered in a
// tight loop that would starve the task that clears talkHeld.
void abandonTake(const char* why) {
  usblink::logf("%s", why);
  M5.Mic.end();
  sendUp(upBuf[0], 0, true);
  while (talkHeld.load()) vTaskDelay(pdMS_TO_TICKS(20));
}

// Streams the mic while the talk key is held; a reply that is playing stops first.
void talk() {
  if (active || speakerOn || ring.size() > 0) {
    stopWanted.store(true);
    uint32_t t0 = millis();
    while (flush.load() == FLUSH_NONE && millis() - t0 < 50) vTaskDelay(1);  // the RX task turns it into a stop
    handleFlush();
  }
  speakerOff();
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  if (!M5.Mic.begin()) {
    abandonTake("mic did not start");
    return;
  }
  uint32_t t0 = millis();
  bool ok = M5.Mic.record(upBuf[0], UP_SAMPLES, UP_RATE) && M5.Mic.record(upBuf[1], UP_SAMPLES, UP_RATE);
  int oldest = 0;
  while (ok && talkHeld.load()) {
    ok = M5.Mic.record(upBuf[(oldest + 2) % UP_BUFS], UP_SAMPLES, UP_RATE);  // returns once upBuf[oldest] is full
    if (!ok) break;
    sendUp(upBuf[oldest], UP_SAMPLES, false);
    oldest = (oldest + 1) % UP_BUFS;
  }
  if (!ok) {
    abandonTake("mic stopped recording");
    return;
  }
  uint32_t w0 = millis();
  while (M5.Mic.isRecording() && millis() - w0 < 200) vTaskDelay(1);
  sendUp(upBuf[oldest], UP_SAMPLES, false);
  sendUp(upBuf[(oldest + 1) % UP_BUFS], UP_SAMPLES, true);
  M5.Mic.end();
  g_status.takes++;
  g_status.lastTakeMs = millis() - t0;
}

void pattern(uint16_t frames) {
```

with:

```cpp
  }
}

// The audio task's own view of whether a reply is arriving or playing.
bool speakerBusy() { return active || speakerOn || ring.size() > 0; }

// A take wants the mic when it has been committed, or when it has been prepared and no reply is using the codec.
bool talkWanted() { return talkCommitted.load() || (talkOn.load() && !speakerBusy()); }

// The mic, or the TEST FIFO standing in for it. record() queues buf and returns once the buffer queued before it is full;
// the FIFO fills buf at once, 20 ms after the last one, with zeros for what has not arrived.
bool micBegin() {
  takeInject = injectOn.load();
  if (takeInject) {
    injectLast = xTaskGetTickCount();
    return true;
  }
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  return M5.Mic.begin();
}
bool micRecord(int16_t* buf) {
  if (!takeInject) return M5.Mic.record(buf, UP_SAMPLES, UP_RATE);
  vTaskDelayUntil(&injectLast, pdMS_TO_TICKS(20));
  uint32_t got = injectRing.read((uint8_t*)buf, UP_SAMPLES * 2);
  memset((uint8_t*)buf + got, 0, UP_SAMPLES * 2 - got);
  return true;
}
bool micRecording() { return !takeInject && M5.Mic.isRecording(); }
void micEnd() {
  if (!takeInject) M5.Mic.end();
}

void handleInjectClear() {
  if (injectClear.exchange(false)) injectRing.clear();
}

void setLevel(const int16_t* pcm, size_t samples) {
  int peak = 0;
  for (size_t i = 0; i < samples; i++) {
    int a = pcm[i] < 0 ? -(int)pcm[i] : pcm[i];
    if (a > peak) peak = a;
  }
  int level = peak >> 7;
  g_status.micLevel = (uint8_t)(level > 255 ? 255 : level);
}

void keepPre(const int16_t* pcm) {
  memcpy(pre[preHead], pcm, sizeof pre[0]);
  preHead = (preHead + 1) % PRE_CHUNKS;
  if (preCount < PRE_CHUNKS) preCount++;
}

void sendPre() {
  int at = (preHead + PRE_CHUNKS - preCount) % PRE_CHUNKS;
  for (int i = 0; i < preCount; i++) sendUp(pre[(at + i) % PRE_CHUNKS], UP_SAMPLES, false);
  preCount = 0;
}

// The mic failed: end the take for the PC with an empty EOS (once the take has been committed; before that, nobody is
// waiting for it), then wait for the key, so talk() is not re-entered in a tight loop that would starve the UI loop.
void abandonTake(const char* why) {
  usblink::logf("%s", why);
  micEnd();
  g_status.micLevel = 0;
  for (;;) {
    bool on = talkOn.load();
    if (talkCommitted.load()) {
      sendUp(upBuf[0], 0, true, talkReason.load());
      break;
    }
    if (!on) break;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  while (talkOn.load()) vTaskDelay(pdMS_TO_TICKS(20));
  talkCommitted.store(false);
}

// A take, from the key going down to its release. Until the take is committed the chunks only fill the pre-roll; a reply
// that is playing stops when the take is committed, not before.
void talk() {
  if (speakerBusy()) {
    if (!talkCommitted.load()) return;  // prepared only: the reply plays on
    stopWanted.store(true);
    uint32_t t0 = millis();
    while (flush.load() == FLUSH_NONE && millis() - t0 < 50) vTaskDelay(1);  // the RX task turns it into a stop
    handleFlush();
  }
  speakerOff();
  if (!micBegin()) {
    abandonTake("mic did not start");
    return;
  }
  preHead = preCount = 0;
  uint32_t t0 = millis();
  bool live = false;
  bool ok = micRecord(upBuf[0]) && micRecord(upBuf[1]);
  int oldest = 0;
  while (ok) {
    bool on = talkOn.load();
    bool committed = talkCommitted.load();
    if (committed && !live) {
      live = true;
      sendPre();
    }
    if (!on) break;
    ok = micRecord(upBuf[(oldest + 2) % UP_BUFS]);  // returns once upBuf[oldest] is full
    if (!ok) break;
    setLevel(upBuf[oldest], UP_SAMPLES);
    if (live) sendUp(upBuf[oldest], UP_SAMPLES, false);
    else keepPre(upBuf[oldest]);
    oldest = (oldest + 1) % UP_BUFS;
  }
  if (!ok) {
    abandonTake("mic stopped recording");
    return;
  }
  if (live) {
    uint32_t w0 = millis();
    while (micRecording() && millis() - w0 < 200) vTaskDelay(1);
    sendUp(upBuf[oldest], UP_SAMPLES, false);
    sendUp(upBuf[(oldest + 1) % UP_BUFS], UP_SAMPLES, true, talkReason.load());
    g_status.takes++;
    g_status.lastTakeMs = millis() - t0;
  }
  micEnd();
  g_status.micLevel = 0;
  talkCommitted.store(false);
}

void pattern(uint16_t frames) {
```

In `firmware/src/audio.cpp`, replace:

```cpp
void task(void*) {
  for (;;) {
    handleFlush();
    if (talkHeld.load()) {
      talk();
      continue;
    }
    uint16_t n = patternFrames.exchange(0);
    if (n) {
```

with:

```cpp
void task(void*) {
  for (;;) {
    handleFlush();
    handleInjectClear();
    if (talkWanted()) {
      talk();
      if (!talkCommitted.load() && speakerBusy()) vTaskDelay(pdMS_TO_TICKS(5));  // prepared with a reply playing: no spin
      else continue;
    }
    uint16_t n = patternFrames.exchange(0);
    if (n) {
```

In `firmware/src/audio.cpp`, replace:

```cpp
  M5.Mic.config(mc);
  uint8_t* mem = (uint8_t*)heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (mem) ring.attach(mem, RING_BYTES);
  xTaskCreatePinnedToCore(task, "audio", 8192, nullptr, 3, nullptr, 1);
  return mem != nullptr;
}

void setTalk(bool held) { talkHeld.store(held); }

void requestPattern(uint16_t frames) {
  if (frames) patternFrames.store(frames);
```

with:

```cpp
  M5.Mic.config(mc);
  uint8_t* mem = (uint8_t*)heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (mem) ring.attach(mem, RING_BYTES);
  uint8_t* fifo = (uint8_t*)heap_caps_malloc(INJECT_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (fifo) injectRing.attach(fifo, INJECT_BYTES);
  xTaskCreatePinnedToCore(task, "audio", 8192, nullptr, 3, nullptr, 1);
  return mem != nullptr;
}

void prepareTalk() {
  talkCommitted.store(false);
  talkReason.store(false);
  talkOn.store(true);
}

void commitTalk(bool reason) {
  talkReason.store(reason);
  talkCommitted.store(true);
}

void endTalk() { talkOn.store(false); }

bool replyBusy() { return g_status.playing.load() || ring.size() > 0; }

void requestStop() { stopWanted.store(true); }

void micSource(bool on) {
  injectOn.store(on);
  if (!on) injectClear.store(true);
}

size_t micPcm(const uint8_t* pcm, size_t len) {
  if (!injectRing.capacity()) return 0;
  return injectRing.write(pcm, (uint32_t)(len & ~(size_t)1));
}

void requestPattern(uint16_t frames) {
  if (frames) patternFrames.store(frames);
```

Replace the whole of `firmware/src/audio.h` with:

```cpp
// audio.h: the audio task owns the mic and the speaker, which share the codec, so one runs at a time.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace audio {
const uint32_t RING_BYTES = 1u << 21;  // 2 MiB of PSRAM: 43.7 s at 24 kHz (the spec asks for 30 s or more)
static_assert((RING_BYTES & (RING_BYTES - 1)) == 0, "proto::ByteRing's index math needs a power-of-two capacity");

bool begin();                          // false when PSRAM for the playback ring is missing
void requestPattern(uint16_t frames);  // RX task: TEST UP_PATTERN

// UI loop, for a take. The mic starts filling a 400 ms pre-roll when the front key goes down (if no reply is playing),
// so the first 300 ms of speech, which pass before the hold is long enough to count, are not lost; the pre-roll goes
// out when the take is committed. A take that is ended before it is committed is dropped without a frame.
void prepareTalk();
void commitTalk(bool reason);  // reason: the take is the spoken reason for a denial (the EOS frame carries F_REASON)
void endTalk();                // released, or cancelled
bool replyBusy();              // a reply is arriving or playing; thread-safe
void requestStop();            // cut the reply that is playing; the RX task turns it into a stop at its next idle pass

// RX task, for the TEST hooks: while the mic source is on, takes read their audio from a FIFO instead of the mic.
void micSource(bool on);
size_t micPcm(const uint8_t* pcm, size_t len);  // PCM16 at 16 kHz into the FIFO; returns the bytes that fitted

// RX task, for replies:
void onHello();                        // the bridge (re)connected: drop any reply, start credit over
void onAudioDown(const uint8_t* pcm, size_t len, bool eos);
void stopFromPc();                     // CMD STOP_AUDIO
void rxIdle();                         // grants credit, carries out stops the audio task asks for
}  // namespace audio
```

In `firmware/src/main.cpp`, replace:

```cpp
void loop() {
  static uint32_t lastDraw = 0;
  M5.update();
  audio::setTalk(M5.BtnA.isPressed());
  if (millis() - lastDraw >= 250) {
    lastDraw = millis();
    render();
```

with:

```cpp
void loop() {
  static uint32_t lastDraw = 0;
  M5.update();
  // Until the state machine drives it (plan 4, task 6): holding the front key is a take, committed at once.
  static bool wasDown = false;
  bool down = M5.BtnA.isPressed();
  if (down && !wasDown) {
    audio::prepareTalk();
    audio::commitTalk(false);
  }
  if (!down && wasDown) audio::endTalk();
  wasDown = down;
  if (millis() - lastDraw >= 250) {
    lastDraw = millis();
    render();
```

Replace the whole of `firmware/src/status.h` with:

```cpp
// status.h: counters and settings shared between tasks; the screen shows them.
#pragma once
#include <atomic>
#include <stdint.h>

struct Status {
  std::atomic<uint32_t> rxBad{0};      // bad chunks from the PC
  std::atomic<uint32_t> rxGaps{0};     // gaps in the PC's seq since its last HELLO
  std::atomic<uint32_t> txDropped{0};  // frames the TX queue had no room for
  std::atomic<uint8_t> volume{255};    // speaker volume (spec D9)
  std::atomic<uint8_t> micGain{2};     // mic magnification (spec §6.2)
  std::atomic<uint32_t> takes{0};
  std::atomic<uint32_t> lastTakeMs{0};
  std::atomic<bool> playing{false};
  std::atomic<uint32_t> ringFill{0};
  std::atomic<uint32_t> underruns{0};
  std::atomic<uint8_t> micLevel{0};    // peak of the last 20 ms of a take, 0 to 255 of full scale
};

extern Status g_status;
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `120 cases, 536 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 19.2%, Flash 26.2%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `120 cases, 536 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/stubs/Arduino.h firmware/host/stubs/M5Unified.h firmware/host/test_audio.cpp firmware/src/audio.cpp firmware/src/audio.h firmware/src/main.cpp firmware/src/status.h
git commit -m "Task 5: takes with a pre-roll, the REASON flag and a test mic source" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The screens and the main loop

Everything so far was testable on the PC. This task joins it to the hardware, and its proof is the firmware build here and the real S3 in Task 12. `screen.cpp` draws a `ui::View` through an off-screen canvas of 240x135: a 16-pixel header, six lines of body (five in an approval), a 16-pixel hint line, a header colour for each screen and the battery and elapsed time on the right. It draws only when something it shows has changed, and it can freeze the canvas and send it to the PC as RGB565 chunks of two rows (TEST SNAP), so that a screen can be looked at with nobody holding the S3. `main.cpp` becomes the UI loop: every pass it reads the real keys ORed with the key script's, runs `Gesture` and `Machine`, carries out the machine's actions on the audio task and the link (logging each, so a run of the keys can be read back from LOG frames) and draws. The link's RX task hands UI frames, approval requests, key scripts and snapshot requests to the loop through a four-message queue, because the machine belongs to the UI loop alone. `usblink` routes UI and APPROVAL_REQ to the handlers that post to that queue.

Two small additions come with it so that the loop can be written against them: `ui::screenName` for the log lines (`screen listening`) and `ui::cells`, the width of a string in cells, for the header's right-hand part.

**Files:**
- Create: `firmware/src/screen.cpp`, `firmware/src/screen.h`
- Modify: `firmware/lib/ui/src/ui/machine.cpp`, `firmware/lib/ui/src/ui/machine.h`, `firmware/lib/ui/src/ui/text.cpp`, `firmware/lib/ui/src/ui/text.h`, `firmware/src/main.cpp`, `firmware/src/usblink.cpp`, `firmware/src/usblink.h`
- Test (changed): `firmware/host/test_machine.cpp`, `firmware/host/test_text.cpp`

**Interfaces:**
- Consumes: `ui::Machine`, `ui::View`, `ui::Action` (Task 4); `ui::Gesture`, `ui::KeyScript` (Task 2); `ui::clip`, `ui::COLS` (Task 3); `audio::prepareTalk`, `commitTalk`, `endTalk`, `replyBusy`, `requestStop`, `micSource`, `micPcm` and `g_status.micLevel` (Task 5); `proto::buildButton`, `buildApprovalRes`, `buildSnapChunk`, `parseUi`, `parseApprovalReq`, `parseKeys`, `parseMicSource` and the `T_*` types (Task 1); `usblink::send`, `logf`, `msSincePing`, `Handlers` (plan 1).
- Produces:
  - `ui::screenName(Screen): const char*` ("idle", "approval", "switch-confirm" and so on) and `ui::cells(const char* text, size_t n): size_t` (text.h).
  - `usblink::Handlers` gains `onUi(const uint8_t* payload, size_t len)` and `onApprovalReq(...)`; both payloads are valid only during the call.
  - `screen::Extras {battery, micLevel, playing}`, `screen::begin(): bool` (false when the canvas could not be allocated: nothing is drawn then), `screen::draw(const ui::View&, const Extras&)`, `screen::snapStart(): bool` and `screen::snapNext(uint8_t* out, size_t cap, size_t& len): bool` (writes a TEST payload with `proto::buildSnapChunk` and returns true until the last chunk has gone).

- [ ] **Step 1: Write the failing tests**

In `firmware/host/test_machine.cpp`, replace:

```cpp
namespace {
using ui::Screen;

const char* screenName(Screen s) {
  switch (s) {
    case Screen::Idle: return "Idle";
    case Screen::Transcribing: return "Transcribing";
    case Screen::Confirm: return "Confirm";
    case Screen::Working: return "Working";
    case Screen::Reply: return "Reply";
    case Screen::Error: return "Error";
    case Screen::Approval: return "Approval";
    case Screen::Listening: return "Listening";
    case Screen::SwitchConfirm: return "SwitchConfirm";
    case Screen::Offline: return "Offline";
  }
  return "?";
}

std::string actions(ui::Machine& m) {
  std::string out;
  ui::Action a;
```

with:

```cpp
namespace {
using ui::Screen;

std::string actions(ui::Machine& m) {
  std::string out;
  ui::Action a;
```

In `firmware/host/test_machine.cpp`, replace:

```cpp
  const Screen all[] = {Screen::Idle, Screen::Transcribing, Screen::Confirm, Screen::Working, Screen::Reply, Screen::Error};
  for (uint8_t i = 0; i < 6; i++) {
    s.show(uiFrame(i, "walkie"));
    CHECK(s.screen() == all[i], screenName(all[i]));
  }
  s.show(uiFrame(3));
  s.show(uiFrame(9));
```

with:

```cpp
  const Screen all[] = {Screen::Idle, Screen::Transcribing, Screen::Confirm, Screen::Working, Screen::Reply, Screen::Error};
  for (uint8_t i = 0; i < 6; i++) {
    s.show(uiFrame(i, "walkie"));
    CHECK(s.screen() == all[i], ui::screenName(all[i]));
  }
  s.show(uiFrame(3));
  s.show(uiFrame(9));
```

In `firmware/host/test_machine.cpp`, replace:

```cpp
  while (m.next(a)) n++;
  CHECK(n == 16, "16 is the most it holds, and it does not overrun");
}
```

with:

```cpp
  while (m.next(a)) n++;
  CHECK(n == 16, "16 is the most it holds, and it does not overrun");
}

TEST(everyScreenHasADistinctNameForTheLog) {
  const ui::Screen all[] = {ui::Screen::Idle,     ui::Screen::Transcribing, ui::Screen::Confirm,       ui::Screen::Working,
                            ui::Screen::Reply,    ui::Screen::Error,        ui::Screen::Approval,      ui::Screen::Listening,
                            ui::Screen::SwitchConfirm, ui::Screen::Offline};
  for (size_t i = 0; i < 10; i++)
    for (size_t j = i + 1; j < 10; j++) CHECK(std::string(ui::screenName(all[i])) != ui::screenName(all[j]), "distinct");
  CHECK(std::string(ui::screenName(ui::Screen::SwitchConfirm)) == "switch-confirm", "spelled as the plan's gates expect");
}
```

Append to the end of `firmware/host/test_text.cpp`:

```cpp

TEST(cellsMeasuresAStringInCells) {
  CHECK(ui::cells("", 0) == 0, "nothing");
  CHECK(ui::cells("abc", 3) == 3, "ASCII");
  CHECK(ui::cells("\xE5\xA5\xBD" "a", 4) == 3, "one wide character and one narrow");
  CHECK(ui::cells("a\xE5\xA5", 3) == 5, "each byte of a cut character counts two: never too small");
  CHECK(ui::cells("abcdef", 3) == 3, "only the first n bytes");
  CHECK(ui::cells("\xE5\xA5\xBD", 2) == 4, "a character that n cuts is not read past n: its two bytes are bad ones");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `'screenName' is not a member of 'ui'`, `'cells' is not a member of 'ui'; did you mean 'cellsOf'?`.

- [ ] **Step 3: Write the implementation**

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
size_t atMost(size_t n, size_t cap) { return n < cap ? n : cap; }
}  // namespace

Machine::Machine()
    : base_(Screen::Idle),
      offline_(true),
```

with:

```cpp
size_t atMost(size_t n, size_t cap) { return n < cap ? n : cap; }
}  // namespace

const char* screenName(Screen s) {
  switch (s) {
    case Screen::Idle: return "idle";
    case Screen::Transcribing: return "transcribing";
    case Screen::Confirm: return "confirm";
    case Screen::Working: return "working";
    case Screen::Reply: return "reply";
    case Screen::Error: return "error";
    case Screen::Approval: return "approval";
    case Screen::Listening: return "listening";
    case Screen::SwitchConfirm: return "switch-confirm";
    case Screen::Offline: return "offline";
  }
  return "?";
}

Machine::Machine()
    : base_(Screen::Idle),
      offline_(true),
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  Offline = 9,
};

enum class Act : uint8_t {
  PrepareTalk,   // the front key went down: the mic may start filling its pre-roll
  CommitTalk,    // the hold reached 300 ms: the take is on; arg 1 when it is a spoken reason for a denial
```

with:

```cpp
  Offline = 9,
};

// For logs: "idle", "approval" and so on.
const char* screenName(Screen s);

enum class Act : uint8_t {
  PrepareTalk,   // the front key went down: the mic may start filling its pre-roll
  CommitTalk,    // the hold reached 300 ms: the take is on; arg 1 when it is a spoken reason for a denial
```

In `firmware/lib/ui/src/ui/text.cpp`, replace:

```cpp

uint8_t cellsOf(uint32_t cp) { return cp >= 0x20 && cp <= 0x7E ? 1 : 2; }

size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap) {
  if (cap == 0) return 0;
  size_t out = 0, i = 0;
```

with:

```cpp

uint8_t cellsOf(uint32_t cp) { return cp >= 0x20 && cp <= 0x7E ? 1 : 2; }

size_t cells(const char* text, size_t n) {
  const uint8_t* t = (const uint8_t*)text;
  size_t total = 0;
  for (size_t i = 0; i < n;) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    total += len == 1 ? cellsOf(t[i]) : 2;
    i += len;
  }
  return total;
}

size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap) {
  if (cap == 0) return 0;
  size_t out = 0, i = 0;
```

In `firmware/lib/ui/src/ui/text.h`, replace:

```cpp
// 1 for printable ASCII, 2 for everything else.
uint8_t cellsOf(uint32_t codePoint);

// Copies UTF-8 into dst, NUL-terminated and at most cap - 1 bytes, keeping only what can be drawn: a malformed sequence
// (a lone continuation byte, a cut one, an overlong form, a surrogate) and any character beyond U+FFFF become '?'; a
// control character other than '\n' becomes a space, except '\r', which goes; zero-width and bidirectional format
```

with:

```cpp
// 1 for printable ASCII, 2 for everything else.
uint8_t cellsOf(uint32_t codePoint);

// The width of UTF-8 text in cells. A malformed byte counts two cells, although sanitize() would make it a one-cell '?', so
// for text that has been sanitized this is exact, and for text that has not it is never too small.
size_t cells(const char* text, size_t n);

// Copies UTF-8 into dst, NUL-terminated and at most cap - 1 bytes, keeping only what can be drawn: a malformed sequence
// (a lone continuation byte, a cut one, an overlong form, a surrogate) and any character beyond U+FFFF become '?'; a
// control character other than '\n' becomes a space, except '\r', which goes; zero-width and bidirectional format
```

Replace the whole of `firmware/src/main.cpp` with:

```cpp
// walkie firmware for the M5StickS3. It runs from app1; on-the-beat keeps app0 (spec §6.7).
#include <M5Unified.h>
#include <esp_ota_ops.h>
#include <freertos/queue.h>
#include "audio.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "screen.h"
#include "status.h"
#include "ui/gesture.h"
#include "ui/keyscript.h"
#include "ui/machine.h"
#include "usblink.h"
#include "version.h"

Status g_status;

namespace {
// The machine, the gesture detector and the key script belong to the UI loop alone. What the link RX task has for them
// comes through this queue.
ui::Machine machine;
ui::Gesture gesture;
ui::KeyScript keyScript;

enum Kind : uint8_t { K_UI, K_APPROVAL, K_KEYS, K_SNAP };
struct Msg {
  uint8_t kind;
  uint16_t len;
  uint8_t data[proto::MAX_PAYLOAD];
};
QueueHandle_t inbox = nullptr;

void bootApp0() {
  const esp_partition_t* p0 =
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr);
  esp_err_t e = p0 ? esp_ota_set_boot_partition(p0) : ESP_ERR_NOT_FOUND;
  usblink::logf("boot app0: %s", esp_err_to_name(e));
  if (e != ESP_OK) return;
  delay(300);  // lets the LOG frame out
  esp_restart();
}

// Runs on the link RX task.
void post(Kind kind, const uint8_t* p, size_t n) {
  static Msg m;
  if (!inbox || n > sizeof m.data) return;
  m.kind = kind;
  m.len = (uint16_t)n;
  memcpy(m.data, p, n);
  if (xQueueSend(inbox, &m, 0) != pdTRUE) usblink::logf("ui queue full: a frame was dropped");
}

void onUiFrame(const uint8_t* p, size_t n) { post(K_UI, p, n); }
void onApprovalFrame(const uint8_t* p, size_t n) { post(K_APPROVAL, p, n); }

// Runs on the link RX task.
void command(uint8_t op, uint8_t arg) {
  switch (op) {
    case proto::CMD_SET_VOLUME:
      g_status.volume = arg;
      usblink::logf("volume %u", arg);
      break;
    case proto::CMD_SET_MIC_GAIN: {
      uint8_t gain = arg < 1 ? 1 : arg > 64 ? 64 : arg;  // the contract is 1 to 64
      g_status.micGain = gain;
      usblink::logf("mic gain %u from the next take", (unsigned)gain);
      break;
    }
    case proto::CMD_STOP_AUDIO:
      audio::stopFromPc();
      usblink::logf("stop audio");
      break;
    case proto::CMD_BOOT_APP0:
      bootApp0();
      break;
    case proto::CMD_REBOOT:
      usblink::logf("rebooting");
      delay(300);
      esp_restart();
      break;
    default:
      usblink::logf("command %u is not handled yet", op);
  }
}

// Runs on the link RX task.
void test(uint8_t op, const uint8_t* args, size_t len) {
  switch (op) {
    case proto::TEST_UP_PATTERN: {
      uint16_t frames = 0;
      if (proto::parseUpPattern(args, len, frames)) audio::requestPattern(frames);
      else usblink::logf("bad UP_PATTERN");
      break;
    }
    case proto::TEST_KEYS:
      post(K_KEYS, args, len);
      break;
    case proto::TEST_MIC_SOURCE: {
      bool on = false;
      if (proto::parseMicSource(args, len, on)) {
        audio::micSource(on);
        usblink::logf("mic source %s", on ? "test fifo" : "mic");
      } else {
        usblink::logf("bad MIC_SOURCE");
      }
      break;
    }
    case proto::TEST_MIC_PCM:
      if (len < 2 || len > 1000 || (len & 1)) {
        usblink::logf("bad MIC_PCM of %u bytes", (unsigned)len);
      } else if (audio::micPcm(args, len) < len) {
        usblink::logf("mic fifo full: part of a MIC_PCM was dropped");
      }
      break;
    case proto::TEST_SNAP:
      post(K_SNAP, args, len);
      break;
    default:
      usblink::logf("test %u is not handled", op);
  }
}

// UI loop.
void handle(const Msg& m, uint32_t now) {
  switch (m.kind) {
    case K_UI: {
      proto::UiView v;
      if (proto::parseUi(m.data, m.len, v)) machine.onUi(v, now);
      else usblink::logf("bad UI frame");
      break;
    }
    case K_APPROVAL: {
      proto::ApprovalReq r;
      if (proto::parseApprovalReq(m.data, m.len, r)) machine.onApprovalReq(r, now);
      else usblink::logf("bad APPROVAL_REQ frame");
      break;
    }
    case K_KEYS: {
      proto::KeyStep steps[proto::KEY_STEPS_MAX];
      size_t n = 0;
      if (proto::parseKeys(m.data, m.len, steps, proto::KEY_STEPS_MAX, n)) {
        keyScript.load(steps, n, now);
        usblink::logf("key script of %u steps", (unsigned)n);
      } else {
        usblink::logf("bad KEYS");
      }
      break;
    }
    case K_SNAP:
      if (!screen::snapStart()) usblink::logf("snap: there is no canvas");
      break;
  }
}

// UI loop. Every action is logged, so a run of the keys can be read back from the LOG frames.
void carryOut(const ui::Action& a) {
  uint8_t p[16];
  size_t n;
  switch (a.act) {
    case ui::Act::PrepareTalk:
      usblink::logf("act prepare");
      audio::prepareTalk();
      break;
    case ui::Act::CommitTalk:
      usblink::logf("act commit reason=%u", a.arg);
      audio::commitTalk(a.arg != 0);
      break;
    case ui::Act::EndTalk:
      usblink::logf("act end");
      audio::endTalk();
      break;
    case ui::Act::StopAudio:
      usblink::logf("act stop audio");
      audio::requestStop();
      break;
    case ui::Act::SendButton:
      usblink::logf("act button %u", a.arg);
      n = proto::buildButton(a.arg, p, sizeof p);
      if (n) usblink::send(proto::T_BUTTON, 0, p, (uint16_t)n);
      break;
    case ui::Act::SendApproval:
      usblink::logf("act approval id=%u allow=%u reason=%u", a.id, a.arg, a.arg2);
      n = proto::buildApprovalRes(a.id, a.arg != 0, a.arg2 != 0, p, sizeof p);
      if (n) usblink::send(proto::T_APPROVAL_RES, 0, p, (uint16_t)n);
      break;
    case ui::Act::BootApp0:
      usblink::logf("act boot app0");
      bootApp0();
      break;
  }
}

// One chunk of a snapshot per turn of the loop: 68 chunks in under a second, and the TX ring never fills.
void sendSnapChunk() {
  static uint8_t buf[proto::MAX_PAYLOAD];
  size_t len = 0;
  if (screen::snapNext(buf, sizeof buf, len)) usblink::send(proto::T_TEST, 0, buf, (uint16_t)len);
}
}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.output_power = false;  // the StickS3 does not charge with the PM1 boost on
  M5.begin(cfg);
  esp_ota_mark_app_valid_cancel_rollback();
  M5.Display.setRotation(3);
  bool screenOk = screen::begin();
  bool audioOk = audio::begin();
  inbox = xQueueCreate(4, sizeof(Msg));
  usblink::Handlers h = {};
  h.onHello = audio::onHello;
  h.onAudioDown = audio::onAudioDown;
  h.onCommand = command;
  h.onTest = test;
  h.onUi = onUiFrame;
  h.onApprovalReq = onApprovalFrame;
  h.idle = audio::rxIdle;
  h.ringBytes = audioOk ? audio::RING_BYTES : 0;
  usblink::begin(h);
  if (!audioOk) usblink::logf("no PSRAM for the playback ring: replies cannot play");
  if (!screenOk) usblink::logf("no memory for the screen canvas: nothing will be drawn");
}

void loop() {
  static uint32_t lastBattery = 0;
  static uint8_t battery = 0;
  static ui::Screen shown = ui::Screen::Offline;
  M5.update();
  uint32_t now = millis();

  static Msg m;
  while (inbox && xQueueReceive(inbox, &m, 0) == pdTRUE) handle(m, now);

  uint8_t scripted = keyScript.mask(now);
  bool front = M5.BtnA.isPressed() || (scripted & proto::KEY_FRONT);
  bool side = M5.BtnB.isPressed() || (scripted & proto::KEY_SIDE);
  machine.tick(now, usblink::msSincePing() < 3000, audio::replyBusy());
  ui::Events ev = gesture.update(now, front, side);
  for (uint8_t i = 0; i < ev.n; i++) machine.onGesture(ev.ev[i], now);
  ui::Action a;
  while (machine.next(a)) carryOut(a);

  ui::Screen s = machine.screen();
  if (s != shown) {
    shown = s;
    usblink::logf("screen %s", ui::screenName(s));
  }
  if (battery == 0 || now - lastBattery >= 5000) {
    lastBattery = now;
    int level = M5.Power.getBatteryLevel();
    battery = (uint8_t)(level < 0 ? 0 : level > 100 ? 100 : level);
  }
  screen::Extras x = {battery, g_status.micLevel.load(), g_status.playing.load()};
  screen::draw(machine.view(now), x);
  sendSnapChunk();
  delay(10);
}
```

Create `firmware/src/screen.cpp`:

```cpp
// screen.cpp: see screen.h.
#include "screen.h"
#include <M5Unified.h>
#include <stdio.h>
#include <string.h>
#include "proto/messages.h"
#include "ui/text.h"

namespace screen {
namespace {
const int W = 240, H = 135;
const int HEADER_H = 16, BODY_Y = 19, ROW = 16, FOOTER_Y = 119;
const int SNAP_ROWS = 2;  // rows to a chunk: 960 bytes of pixels

const uint16_t BLACK = 0x0000, WHITE = 0xFFFF, GREY = 0x8410;
const uint16_t NAVY = 0x0010, GREEN = 0x03A0, AMBER = 0xFBE0, RED = 0xC000, MAGENTA = 0x8010;

M5Canvas canvas(&M5.Display);
bool ready = false;
bool haveSig = false;
uint32_t lastSig = 0;
bool frozen = false;  // a snapshot is being sent: the canvas must not change under it
int snapIndex = 0;

uint32_t mix(uint32_t h, const void* p, size_t n) {
  const uint8_t* b = (const uint8_t*)p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 16777619u;
  return h;
}
uint32_t mix(uint32_t h, uint32_t v) { return mix(h, &v, sizeof v); }

// Everything that is drawn goes into the hash, so a frame that would look the same is not drawn again.
uint32_t signature(const ui::View& v, const Extras& x) {
  uint32_t h = 2166136261u;
  h = mix(h, (uint32_t)v.screen);
  h = mix(h, v.project, strlen(v.project));
  h = mix(h, v.tool, strlen(v.tool));
  h = mix(h, (uint32_t)v.nLines);
  for (uint8_t i = 0; i < v.nLines; i++) h = mix(h, v.text + v.lines[i].start, v.lines[i].len);
  h = mix(h, (uint32_t)(v.more | v.switching << 1 | x.playing << 2 | v.hasElapsed << 3));
  h = mix(h, (uint32_t)v.page << 8 | v.pages);
  h = mix(h, v.hasElapsed ? v.elapsedMs / 1000 : 0);
  h = mix(h, (uint32_t)x.battery);
  h = mix(h, v.screen == ui::Screen::Listening ? (uint32_t)(x.micLevel / 6) : 0);
  return h;
}

void put(int x, int y, const char* s, size_t n, uint16_t color) {
  char buf[160];
  if (n > sizeof buf - 1) n = sizeof buf - 1;
  memcpy(buf, s, n);
  buf[n] = 0;
  canvas.setTextColor(color);
  canvas.drawString(buf, x, y);
}
void put(int x, int y, const char* s, uint16_t color) { put(x, y, s, strlen(s), color); }

void centered(int y, const char* s, uint16_t color, int size) {
  canvas.setTextSize(size);
  canvas.setTextColor(color);
  canvas.setTextDatum(top_center);
  canvas.drawString(s, W / 2, y);
  canvas.setTextDatum(top_left);
  canvas.setTextSize(1);
}

// A header bar with the title clipped so that the right-hand part always fits.
void header(uint16_t bar, const char* left, const char* right) {
  canvas.fillRect(0, 0, W, HEADER_H, bar);
  char shown[96];
  size_t rightCells = ui::cells(right, strlen(right));
  size_t room = ui::COLS > rightCells + 1 ? ui::COLS - rightCells - 1 : 0;
  size_t n = ui::clip(left, strlen(left), (uint8_t)room, shown, sizeof shown);
  put(2, 0, shown, n, WHITE);
  canvas.setTextDatum(top_right);
  canvas.setTextColor(WHITE);
  canvas.drawString(right, W - 2, 0);
  canvas.setTextDatum(top_left);
}

void footer(const char* hint) { put(0, FOOTER_Y, hint, GREY); }

void body(const ui::View& v, uint16_t color) {
  for (uint8_t i = 0; i < v.nLines; i++) put(0, BODY_Y + i * ROW, v.text + v.lines[i].start, v.lines[i].len, color);
}

void elapsedText(uint32_t ms, char* out, size_t cap) {
  uint32_t s = ms / 1000;
  if (s < 60) snprintf(out, cap, "%us", (unsigned)s);
  else snprintf(out, cap, "%um%02us", (unsigned)(s / 60), (unsigned)(s % 60));
}

void render(const ui::View& v, const Extras& x) {
  canvas.fillScreen(BLACK);
  char right[24];
  snprintf(right, sizeof right, "%u%%", (unsigned)x.battery);
  const char* project = v.project[0] ? v.project : "walkie";
  switch (v.screen) {
    case ui::Screen::Offline:
      header(RED, "walkie", right);
      centered(34, "未连接", WHITE, 2);
      centered(82, "插好 USB，运行 walkie", GREY, 1);
      footer("两键同按 3 秒：切换固件");
      break;
    case ui::Screen::Idle:
      header(NAVY, project, right);
      centered(40, "待命", WHITE, 2);
      footer("按住前键说话");
      break;
    case ui::Screen::Listening: {
      header(GREEN, "聆听中", right);
      int w = x.micLevel >= 110 ? W - 20 : x.micLevel * (W - 20) / 110;  // 110 of 255 is about 43% of full scale
      canvas.drawRect(9, 50, W - 18, 32, GREY);
      if (w > 0) canvas.fillRect(10, 51, w, 30, WHITE);
      footer("松开发送");
      break;
    }
    case ui::Screen::Transcribing:
      header(NAVY, project, right);
      centered(40, "识别中…", WHITE, 2);
      break;
    case ui::Screen::Confirm:
      header(AMBER, "确认", right);
      body(v, WHITE);
      footer("侧键取消");
      break;
    case ui::Screen::Working: {
      char el[16] = "";
      if (v.hasElapsed) elapsedText(v.elapsedMs, el, sizeof el);
      header(NAVY, project, el);
      body(v, WHITE);
      footer("按住侧键 1 秒：停止");
      break;
    }
    case ui::Screen::Reply: {
      char pg[16];
      snprintf(pg, sizeof pg, "%u/%u", (unsigned)v.page + 1, (unsigned)v.pages);
      header(NAVY, project, v.pages > 1 ? pg : right);
      body(v, WHITE);
      footer(x.playing ? "侧键停止播放" : (v.page + 1 < v.pages ? "侧键翻页" : "侧键完成"));
      break;
    }
    case ui::Screen::Error:
      header(RED, "出错了", right);
      body(v, WHITE);
      footer("侧键关闭");
      break;
    case ui::Screen::Approval: {
      char title[96];
      snprintf(title, sizeof title, "允许 %s ？", v.tool);
      header(AMBER, title, "");
      body(v, WHITE);
      if (v.more) put(0, BODY_Y + ui::APPROVAL_LINES * ROW, "…", GREY);
      footer("前键允许 侧键拒绝 按住说原因");
      break;
    }
    case ui::Screen::SwitchConfirm:
      header(MAGENTA, "切换固件", right);
      if (v.switching) {
        centered(40, "切换中…", WHITE, 2);
      } else {
        put(0, BODY_Y, "按前键：重启到 app0", WHITE);
        put(0, BODY_Y + ROW, "按侧键或等 10 秒：取消", GREY);
      }
      break;
  }
}
}  // namespace

bool begin() {
  canvas.setPsram(true);
  canvas.setColorDepth(16);
  canvas.setFont(&fonts::efontCN_16);
  ready = canvas.createSprite(W, H) != nullptr;
  return ready;
}

void draw(const ui::View& v, const Extras& x) {
  if (!ready || frozen) return;
  uint32_t sig = signature(v, x);
  if (haveSig && sig == lastSig) return;
  haveSig = true;
  lastSig = sig;
  render(v, x);
  M5.Display.startWrite();
  canvas.pushSprite(0, 0);
  M5.Display.endWrite();
}

bool snapStart() {
  if (!ready) return false;
  frozen = true;
  snapIndex = 0;
  return true;
}

bool snapNext(uint8_t* out, size_t cap, size_t& len) {
  const int count = (H + SNAP_ROWS - 1) / SNAP_ROWS;
  len = 0;
  if (!frozen) return false;
  if (snapIndex >= count) {
    frozen = false;
    haveSig = false;  // the next draw repaints, whatever it was
    return false;
  }
  int y = snapIndex * SNAP_ROWS;
  int rows = H - y < SNAP_ROWS ? H - y : SNAP_ROWS;
  static uint8_t bgr[W * SNAP_ROWS * 3];
  static uint8_t px[W * SNAP_ROWS * 2];
  canvas.readRectRGB(0, y, W, rows, bgr);  // blue, green, red
  for (int i = 0; i < W * rows; i++) {
    uint16_t c = (uint16_t)(((bgr[i * 3 + 2] & 0xF8) << 8) | ((bgr[i * 3 + 1] & 0xFC) << 3) | (bgr[i * 3] >> 3));
    px[i * 2] = (uint8_t)(c & 0xFF);
    px[i * 2 + 1] = (uint8_t)(c >> 8);
  }
  len = proto::buildSnapChunk((uint16_t)snapIndex, (uint16_t)count, W, H, px, (size_t)W * rows * 2, out, cap);
  snapIndex++;
  return len > 0;
}

}  // namespace screen
```

Create `firmware/src/screen.h`:

```cpp
// screen.h: draws a ui::View on the 240x135 display through an off-screen canvas, and can send that canvas to the PC (TEST
// SNAP). The layout is a 16-pixel header, six 16-pixel lines of body and a 16-pixel hint line; efontCN_16 draws 8 pixels
// to an ASCII character and 16 to a Chinese one, so a line is 30 cells (ui/text.h).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "ui/machine.h"

namespace screen {

struct Extras {
  uint8_t battery;   // percent
  uint8_t micLevel;  // g_status.micLevel
  bool playing;      // a reply is playing: the hint on REPLY changes
};

bool begin();  // false when the canvas could not be allocated: nothing is drawn then
// Redraws only when something it shows has changed since the last call.
void draw(const ui::View& v, const Extras& x);

// TEST SNAP: freezes the picture, then hands the canvas out as RGB565 chunks, two rows to a chunk, for the main loop to send
// at its own pace. snapNext() writes a TEST payload (proto::buildSnapChunk) and returns true until the last chunk has gone;
// after that, drawing goes on.
bool snapStart();
bool snapNext(uint8_t* out, size_t cap, size_t& len);

}  // namespace screen
```

In `firmware/src/usblink.cpp`, replace:

```cpp
      if (proto::parseCmd(f.payload, f.len, c) && handlers.onCommand) handlers.onCommand(c.op, c.arg);
      return;
    }
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.args, t.len);
```

with:

```cpp
      if (proto::parseCmd(f.payload, f.len, c) && handlers.onCommand) handlers.onCommand(c.op, c.arg);
      return;
    }
    case proto::T_UI:
      if (handlers.onUi) handlers.onUi(f.payload, f.len);
      return;
    case proto::T_APPROVAL_REQ:
      if (handlers.onApprovalReq) handlers.onApprovalReq(f.payload, f.len);
      return;
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.args, t.len);
```

Replace the whole of `firmware/src/usblink.h` with:

```cpp
// usblink.h: the S3's end of the USB link (protocol/frames.md). The RX task decodes frames and
// dispatches them; the TX task is the only writer to USB.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace usblink {
// Called from the RX task. Any of them may be null.
struct Handlers {
  void (*onHello)();                                        // the bridge (re)connected
  void (*onAudioDown)(const uint8_t* pcm, size_t len, bool eos);
  void (*onCommand)(uint8_t op, uint8_t arg);
  void (*onTest)(uint8_t op, const uint8_t* args, size_t len);
  void (*onUi)(const uint8_t* payload, size_t len);           // UI: valid only during the call
  void (*onApprovalReq)(const uint8_t* payload, size_t len);  // APPROVAL_REQ: likewise
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for USB and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// Milliseconds since the bridge's last PING, or UINT32_MAX before the first.
uint32_t msSincePing();
}  // namespace usblink
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `122 cases, 588 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 556 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_machine.cpp firmware/host/test_text.cpp firmware/lib/ui/src/ui/machine.cpp firmware/lib/ui/src/ui/machine.h firmware/lib/ui/src/ui/text.cpp firmware/lib/ui/src/ui/text.h firmware/src/main.cpp firmware/src/screen.cpp firmware/src/screen.h firmware/src/usblink.cpp firmware/src/usblink.h
git commit -m "Task 6: the screens and the main loop: canvas, snapshot, key script, queue from the link" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The bridge's view of the device screen

The bridge owns what the S3 shows (spec 4): the device draws, the bridge decides. `createUi` keeps the screen that is up (a state with its project, text and elapsed time) and the approval over it, sends UI and APPROVAL_REQ frames, and turns the device's BUTTON and APPROVAL_RES frames into events. The S3 takes any UI frame as the end of an approval, so while an approval is on the screen a change of screen is kept back and goes out when the approval is over, as it is by then. When the device (re)connects it knows nothing of what came before, so the screen, or the approval if one is up, is sent again.

**Files:**
- Create: `bridge/src/ui/ui.js`
- Test (new): `bridge/test/ui/ui.test.js`

**Interfaces:**
- Consumes: `TYPE`, `FLAG` from `bridge/src/link/frame.js` and `UI_STATE`, `BUTTON`, `uiPayload`, `approvalReqPayload`, `parseButton`, `parseApprovalRes` (Task 1); from plan 1's `Link`: `link.send(type, payload)`, and its `'hello'` and `'frame'` events (`{type, flags, seq, payload}`).
- Produces (`bridge/src/ui/ui.js`): `createUi({link, log = () => {}})` returning:
  - `show(state: UI_STATE, fields: {project?, text?, elapsedMs?} = {})`: the screen as it is now; sent at once unless an approval is up.
  - `approval({id, tool, preview})`: sends APPROVAL_REQ; `approvalClear(id)`: when `id` is the one on the screen, ends it and sends the screen as it is now; any other `id` changes nothing.
  - `current(): {base, approval}`: copies of what is up.
  - `on(name, listener)` for `'cancel'`, `'stop'`, `'dismiss'`, `'switching'` (a BUTTON), and `'verdict'` with `{id, allow, reasonFollows}` (an APPROVAL_RES). A button this version does not know and a short APPROVAL_RES are logged and ignored.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/ui/ui.test.js`:

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/ui/ui.test.js`
Expected: FAIL, the test file cannot load: `Cannot find module 'bridge/src/ui/ui.js'`; 1 failure in all.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/ui/ui.js`:

```js
// The device's screen as the bridge sees it (spec 6.3): which of the six UI states is showing, and the approval over it. It sends
// UI and APPROVAL_REQ frames and turns the device's BUTTON and APPROVAL_RES frames into events:
//
//   'cancel' 'stop' 'dismiss' 'switching'          a key press that the bridge acts on (BUTTON)
//   'verdict' {id, allow, reasonFollows}           his answer to the approval on the screen (APPROVAL_RES)
//
// The device takes any UI frame as the end of an approval, so while one is on the screen a screen change is kept back and sent
// when the approval is over. When the device (re)connects, the current screen is sent again: it knows nothing of what came before.
import { EventEmitter } from 'node:events';
import { TYPE } from '../link/frame.js';
import { BUTTON, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, uiPayload } from '../link/messages.js';

const BUTTON_EVENT = new Map([
  [BUTTON.CANCEL, 'cancel'],
  [BUTTON.STOP, 'stop'],
  [BUTTON.DISMISS, 'dismiss'],
  [BUTTON.SWITCHING, 'switching'],
]);

export function createUi({ link, log = () => {} }) {
  const events = new EventEmitter();
  let base = { state: UI_STATE.IDLE }; // what the screen shows when nothing is over it
  let approval = null; // {id, tool, preview} while one is on the screen

  const sendBase = () => link.send(TYPE.UI, uiPayload(base));
  const sendApproval = () => link.send(TYPE.APPROVAL_REQ, approvalReqPayload(approval));

  // `fields`: project, text, elapsedMs.
  function show(state, fields = {}) {
    base = { state, ...fields };
    if (!approval) sendBase();
  }

  function showApproval({ id, tool, preview }) {
    approval = { id, tool, preview };
    sendApproval();
  }

  // The approval `id` is over, answered or not. The screen it covered goes out as it is now.
  function clearApproval(id) {
    if (!approval || approval.id !== id) return;
    approval = null;
    sendBase();
  }

  link.on('hello', () => (approval ? sendApproval() : sendBase()));

  link.on('frame', (f) => {
    if (f.type === TYPE.BUTTON) {
      const button = parseButton(f.payload);
      const name = button && BUTTON_EVENT.get(button.event);
      if (name) events.emit(name);
      else log(`ui: button ${button ? button.event : '(empty)'} is not one this bridge knows`);
    } else if (f.type === TYPE.APPROVAL_RES) {
      const res = parseApprovalRes(f.payload);
      if (res) events.emit('verdict', res);
      else log('ui: a short APPROVAL_RES was ignored');
    }
  });

  return {
    show,
    approval: showApproval,
    approvalClear: clearApproval,
    current: () => ({ base: { ...base }, approval: approval ? { ...approval } : null }),
    on: (name, listener) => events.on(name, listener),
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/ui/ui.test.js`
Expected: PASS, 14 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 570 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/ui/ui.js bridge/test/ui/ui.test.js
git commit -m "Task 7: the bridge's view of the device screen: UI and approval frames, buttons and verdicts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The voice turn

The module that makes the pieces one conversation. `createTurn` listens to the device (takes, keys, answers to approvals), to the speech chain, to the session manager and to the approvals queue, and decides what the screen shows and what is said. A take goes TRANSCRIBING, then CONFIRM with the words for a second while the intent is worked out (the side key cancels it, and nothing reaches Claude), then to the manager. The manager's events become WORKING (the tool and the time), REPLY (the text, with its voice spoken), ERROR and IDLE. Nothing heard is 「没听清，再说一次」 for 2 s. Approvals come up on the device, and the keys answer them: a held front key records a spoken reason, and the verdict and the take, which arrive in either order, are paired (waiting at most `reasonWaitMs`) before the approvals queue is answered with a denial that carries the words.

The rules that a talking person needs, each pinned below: takes are heard one at a time and in the order they were made; a reply that is being spoken ends at the first frame of a new take and the ones queued behind it are dropped; a reply that arrives while he is talking waits for him to finish (the mic would hear the speaker); a cancel with nothing on the screen to cancel does nothing; and `close()` ends what is being heard or said and settles.

`speech.hear` gets one small addition for this: an `onTranscript(text)` hook, called as soon as the words are known and there is something to act on, before the classifier is asked, so that CONFIRM shows while the intent is still being worked out. A hook that throws does not lose the utterance.

**Files:**
- Create: `bridge/src/turn/turn.js`
- Modify: `bridge/src/speech/speech.js`
- Test (new): `bridge/test/turn/turn.test.js`
- Test (changed): `bridge/test/speech/speech.test.js`

**Interfaces:**
- Consumes:
  - Task 7's `createUi`: `ui.show(state, fields)`, `ui.approval({id, tool, preview})`, `ui.approvalClear(id)`, and the events `'cancel'`, `'stop'`, `'dismiss'`, `'switching'`, `'verdict'`.
  - Task 1's `TakeCollector` (`push(frame)` returns the PCM on the frame that ends a take; `open`, `lastReason`) and `UI_STATE`.
  - Plan 2's `createSpeech`: `hear(pcm, {currentProject, busy, classify = true, only, signal, onTranscript})` resolving to `{status: 'ok', transcript, intent, project, text, ...}` or `{status: 'unclear', reason}`, and `say(text, {signal})` resolving to `{audio}`; `failureTone()` and `isAbort(err)`.
  - Plan 3's manager: `handle({intent, project, text})` resolving to `{speak?}`, `project()`, and the events `'working'` `{tool, summary, startedAt}`, `'idle'`, `'reply'` `{project, screen, voice}`, `'failure'` `{message}`, `'notice'` `{text}`, `'project'`; the approvals queue: `answer(id, {allow, reason?})` returning whether the id was the one on the screen, `current()`, and the events `'show'` `{id, tool, preview}` and `'clear'` `{id}`.
  - Plan 1's `Link`: the events `'audio-up'`, `'played'`, `'down'`, `'hello'`; `playStream(audio, {signal})` and `playAudio(buffer, {signal})`.
- Produces:
  - `bridge/src/speech/speech.js`: `hear(..., {onTranscript})` as above.
  - `bridge/src/turn/turn.js`: `SAY_AGAIN` (`没听清，再说一次`), `sleepMs(ms, signal): Promise<boolean>` (true after `ms`, false at once when `signal` aborts), and `createTurn({link, speech, manager, approvals, ui, log = () => {}, now = Date.now, sleep = sleepMs, confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, tone = failureTone})` returning `{settled(): Promise<void>, close(): Promise<void>}` (`settled` resolves when no take is being heard and nothing is being said).

- [ ] **Step 1: Write the failing tests**

Append to the end of `bridge/test/speech/speech.test.js`:

```js

// ---- onTranscript ----------------------------------------------------------------------------------------------

test('onTranscript is told the words as soon as they are known, before the classifier is asked', async () => {
  const order = [];
  const openai = fake('openai', {
    transcribe: async () => '继续',
    classify: async () => {
      order.push('classify');
      return answer('continue');
    },
  });
  const { speech } = make([openai]);
  const heard = await speech.hear(clip(1000), { onTranscript: (text) => order.push(`transcript:${text}`) });
  assert.deepEqual(order, ['transcript:继续', 'classify']);
  assert.equal(heard.intent, 'continue');
});

test('onTranscript is told what Gemini heard, and what is heard with classify off', async () => {
  const told = [];
  const gemini = fake('gemini', { hear: async () => ({ transcript: '换到 on the beat', intent: 'switch_project', project: 'on-the-beat', text: '' }) });
  await make([gemini]).speech.hear(clip(1000), { onTranscript: (t) => told.push(t) });
  const openai = fake('openai', { transcribe: async () => '因为要兼容' });
  await make([openai]).speech.hear(clip(1000), { classify: false, onTranscript: (t) => told.push(t) });
  assert.deepEqual(told, ['换到 on the beat', '因为要兼容']);
});

test('onTranscript is not told when there is nothing to act on', async () => {
  const told = [];
  const onTranscript = (t) => told.push(t);
  assert.equal((await make([fake('openai', { transcribe: async () => '嗯。' })]).speech.hear(clip(1000), { onTranscript })).status, 'unclear');
  assert.equal((await make([fake('openai', { transcribe: async () => '继续' })]).speech.hear(clip(100), { onTranscript })).reason, 'too-short');
  assert.equal((await make([]).speech.hear(clip(1000), { onTranscript })).reason, 'unavailable');
  assert.deepEqual(told, []);
});

test('a hook that throws does not stop the utterance, and the console is told', async () => {
  const openai = fake('openai', { transcribe: async () => '继续', classify: async () => answer('continue') });
  const { speech, lines } = make([openai]);
  const heard = await speech.hear(clip(1000), { onTranscript: () => { throw new Error('screen broke'); } });
  assert.equal(heard.status, 'ok');
  assert.equal(heard.intent, 'continue');
  assert.ok(lines.some((l) => l.includes('screen broke')), lines.join('\n'));
});
```

Create `bridge/test/turn/turn.test.js`:

```js
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
function setup({ confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000 } = {}) {
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

  const approvals = createApprovals({ timeoutMs: 55_000 });
  const ui = createUi({ link, log: (l) => logs.push(l) });
  const turn = createTurn({ link, speech, manager, approvals, ui, log: (l) => logs.push(l), now: () => clock.t, sleep, confirmMs, unclearMs, reasonWaitMs, tone: () => Buffer.from('tone') });

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
  return { clock, logs, link, speech, manager, approvals, ui, turn, waits, screen, press, verdict, up, take, reasonTake, ask };
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/speech/speech.test.js bridge/test/turn/turn.test.js`
Expected: FAIL, the test file cannot load: `Cannot find module 'bridge/src/turn/turn.js'`; 4 failures in all.

- [ ] **Step 3: Write the implementation**

In `bridge/src/speech/speech.js`, replace:

```js
    // which is 「没听清，再说一次」 on the device and nothing sent to Claude. With `classify: false` (a reason spoken while
    // an approval waits) the intent is null and `text` is the transcript. `busy` and `currentProject` go into the
    // classifier's prompt. The caller aborting `signal` rejects with an AbortError and starts no skip window.
    async hear(pcm, { currentProject = null, busy = false, classify = true, only = null, signal } = {}) {
      if (signal?.aborted) throw abortError();
      const even = pcm.subarray(0, pcm.length - (pcm.length % 2));
      const clip = even.subarray(Math.min(even.length, config.trimStartMs * CLIP_BYTES_PER_MS));
```

with:

```js
    // which is 「没听清，再说一次」 on the device and nothing sent to Claude. With `classify: false` (a reason spoken while
    // an approval waits) the intent is null and `text` is the transcript. `busy` and `currentProject` go into the
    // classifier's prompt. The caller aborting `signal` rejects with an AbortError and starts no skip window.
    // `onTranscript(text)` is called once the words are known and there is something to act on, before the classifier
    // is asked: the device shows them while the intent is still being worked out (spec 4, step 3).
    async hear(pcm, { currentProject = null, busy = false, classify = true, only = null, signal, onTranscript } = {}) {
      if (signal?.aborted) throw abortError();
      const even = pcm.subarray(0, pcm.length - (pcm.length % 2));
      const clip = even.subarray(Math.min(even.length, config.trimStartMs * CLIP_BYTES_PER_MS));
```

In `bridge/src/speech/speech.js`, replace:

```js
      }
      if (!hasWords(heard.transcript) || isFiller(heard.transcript)) return { status: 'unclear', reason: 'empty', transcript: '' };
      const transcribed = now();
      const base = { status: 'ok', transcript: heard.transcript, transcribedBy: heard.by };
      if (!classify) return { ...base, intent: null, project: null, text: heard.transcript, classifiedBy: null, ms: { transcribe: transcribed - started, classify: null } };
      const verdict = await classifyText(heard.transcript, { currentProject, busy, only, signal, answer: heard.answer, by: heard.by });
```

with:

```js
      }
      if (!hasWords(heard.transcript) || isFiller(heard.transcript)) return { status: 'unclear', reason: 'empty', transcript: '' };
      const transcribed = now();
      try {
        onTranscript?.(heard.transcript);
      } catch (err) {
        log(`speech: the onTranscript hook threw: ${err?.message ?? err}`); // a broken screen must not lose the utterance
      }
      const base = { status: 'ok', transcript: heard.transcript, transcribedBy: heard.by };
      if (!classify) return { ...base, intent: null, project: null, text: heard.transcript, classifiedBy: null, ms: { transcribe: transcribed - started, classify: null } };
      const verdict = await classifyText(heard.transcript, { currentProject, busy, only, signal, answer: heard.answer, by: heard.by });
```

Create `bridge/src/turn/turn.js`:

```js
// The voice turn (spec 4): everything between the front key and Claude, and between Claude and the speaker. It listens to the
// device (takes, keys, answers to approvals), to the speech chain, to the session manager and to the approvals queue, and
// decides what the screen shows and what is said. How a provider is asked and how a process is run are not its business.
//
//   a take      TRANSCRIBING, then CONFIRM (the words for confirmMs while the intent is worked out; the side key cancels),
//               then manager.handle
//   the manager WORKING, REPLY (and the voice), ERROR, IDLE
//   approvals   the APPROVAL screen; the keys answer it, and a held front key adds a spoken reason to a denial
//
// Takes are heard one at a time, in the order they were made. A reply that is being spoken ends when he starts to talk, and
// one that comes in while he talks waits for him to finish: the mic would hear it.
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
export function createTurn({ link, speech, manager, approvals, ui, log = () => {}, now = () => Date.now(), sleep = sleepMs, confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, tone = failureTone }) {
  const collector = new TakeCollector();
  const life = new AbortController(); // close() ends everything that is waiting
  const work = { busy: false, tool: null, summary: '', startedAt: 0 }; // what Claude is doing, for the WORKING screen
  let shown = 'idle'; // what this module last put on the screen: idle | transcribing | confirm | working | reply | error
  let epoch = 0; // counts the screens put up, so that a timer can tell whether its screen is still the one showing
  let current = null; // the take being heard: {ctl, phase: 'hearing' | 'confirm'}
  let speechCtl = new AbortController(); // everything queued to be spoken, and what is being spoken
  let turnTail = Promise.resolve();
  let speakTail = Promise.resolve();
  const talkWaiters = new Set(); // replies waiting for the take that is open to end
  const reasons = new Map(); // approval id -> {text}: a spoken reason; text is null while it is being transcribed
  const verdicts = new Map(); // approval id -> {ctl}: a denial that waits for its spoken reason
  const closed = () => life.signal.aborted;

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
    if (!pcm) return;
    releaseTalk();
    const approval = collector.lastReason ? approvals.current() : null;
    if (approval) void reasonTake(pcm, approval.id);
    else enqueue(pcm);
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
      if (heard.status !== 'ok') return unclear();
      await window;
      if (ctl.signal.aborted) return cancelled();
      current = null; // from here the words are Claude's
      const done = await manager.handle({ intent: heard.intent, project: heard.project, text: heard.text });
      if (done?.speak) announce(done.speak);
      else if (shown === 'confirm') restore();
    } catch (err) {
      if (isAbort(err)) return cancelled();
      log(`turn: ${err?.message ?? err}`);
      unclear();
    } finally {
      life.signal.removeEventListener('abort', onLife);
      if (current === mine) current = null;
    }
  }

  function cancelled() {
    if (closed()) return;
    log('turn: the take was cancelled from the device');
    restore();
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
    showWorking();
  });
  manager.on('idle', () => {
    work.busy = false;
    if (shown === 'working') showIdle();
  });
  manager.on('reply', (r) => {
    show('reply', UI_STATE.REPLY, { project: r.project, text: r.screen || r.voice });
    if (r.voice?.trim()) speak(r.voice);
  });
  manager.on('failure', (f) => showError(f.message));
  manager.on('notice', (n) => showError(n.text));
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
    collector.reset();
    releaseTalk();
    cancelSpeech();
  });
  link.on('hello', () => {
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
    // Ends the take that is being heard and the speech, and resolves when they have let go.
    async close() {
      life.abort();
      cancelSpeech();
      for (const verdict of verdicts.values()) verdict.ctl.abort();
      verdicts.clear();
      reasons.clear();
      releaseTalk();
      await settled();
    },
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/speech/speech.test.js bridge/test/turn/turn.test.js`
Expected: PASS, 87 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 617 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/speech/speech.js bridge/src/turn/turn.js bridge/test/speech/speech.test.js bridge/test/turn/turn.test.js
git commit -m "Task 8: the voice turn: a take through TRANSCRIBING and CONFIRM to Claude, replies spoken, approvals with a spoken reason" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The bridge, wired

`startBridge` joins the link, the UI, the turn, the session manager, the speech chain, the approvals queue and the permission server, and `bin/walkie.js` is the program he runs. The order of closing matters: the turn first, so that nothing new starts; the approvals are denied before the manager is closed, so that `claude` is never left holding a request; the permission server and the link go last, so that the final frames still reach the device. A bridge that cannot start does not leave the permission server listening. With no S3 on USB it runs on, says so once, and connects when one appears. `createConsole` prints one timestamped line per event, and every reply in full, with its time, its cost and what Claude wrote, because the device shows only a few lines of it.

The tests use a stand-in S3 (`test/helpers/fake-s3.js`) that sits on the far end of the real `Link` and answers like the firmware does, and the stand-in `claude` from plan 3. Never start `bin/walkie.js` without `--command` in a test or a smoke run: `claude.prewarm` would start the real `claude`.

**Files:**
- Create: `bridge/bin/walkie.js`, `bridge/src/console.js`, `bridge/src/main.js`
- Test (new): `bridge/test/console.test.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/main.test.js`, `bridge/test/walkie-bin.test.js`

**Interfaces:**
- Consumes: `createTurn` (Task 8), `createUi` (Task 7); plan 3's `createManager({config, projects, store, mcp, start, env, log})`, `createApprovals({timeoutMs})` with `request`, `denyAll`, `createPermServer({decide, log})` with `start()` (resolving to the `mcp` settings the manager needs) and `close()`, `createStateStore`; plan 2's `createSpeech({adapters, config, projects, log})`, `createAdapters`, `loadConfig`, `loadKeys`, `loadProjects`; plan 1's `Link({openPort, makeNonce})`, `link.start()`, `link.close()`, `portOpener`, `connect`, `parseArgs`, `UsageError`; plan 3's `commandFrom`, `cleanEnv`.
- Produces:
  - `bridge/src/console.js`: `createConsole({out = console.log, now = () => new Date()})` returning `{log(line), reply(r), attach({manager, approvals, link})}`. `log` writes `HH:MM:SS line`; `reply` prints `[reply]` (or `[compact]`) with its turn, time and cost, the `<voice>` text and what Claude wrote; `attach` prints the manager's, the approvals queue's and the link's events as `[working]`, `[notice]`, `[failure]`, `[project]`, `[approval]`, `[link]` and `[S3]` lines.
  - `bridge/src/main.js`: `startBridge({config, projects, adapters, openPort, store, console, start, env, makeNonce, turn})` resolving to `{link, manager, approvals, speech, ui, turn, console, close}`; `close()` is safe to call twice and does the work once. `turn` overrides the turn's timings, `start` is the program that stands in for `claude`, `makeNonce` the link's HELLO nonce.
  - `bridge/bin/walkie.js`: `node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env]`, running until Ctrl+C; a flag it does not know, or a word it has no use for, stops it with exit code 2 and the usage before any key is loaded or any port opened.
  - `bridge/test/helpers/fake-s3.js`: the stand-in S3 for the tests of this and the next tasks.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/console.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConsole } from '../src/console.js';

const at = (h, m, s) => () => new Date(2026, 9, 1, h, m, s);

function make() {
  const lines = [];
  const con = createConsole({ out: (line) => lines.push(line), now: at(9, 5, 7) });
  return { con, lines };
}

test('every line starts with the time of day, to the second', () => {
  const { con, lines } = make();
  con.log('claude: starting walkie');
  assert.deepEqual(lines, ['09:05:07 claude: starting walkie']);
});

test('a reply is printed in full: its numbers, the voice text and everything Claude wrote', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'reply', voice: '测试都过了。', screen: '570 个测试通过。', text: '一共 570 个测试，\n全部通过。', tagged: true, turns: 3, ms: 12_340, costUsd: 0.0421 });
  assert.equal(lines[0], '09:05:07 [reply] walkie turn 3, 12.3 s, $0.042');
  assert.equal(lines[1], '  voice: 测试都过了。');
  assert.equal(lines.slice(2).join('\n'), '  一共 570 个测试，\n  全部通过。');
});

test('a reply that has no <voice> tag says so', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'reply', voice: '好了', screen: '好了', text: '好了', tagged: false, turns: 1, ms: 900, costUsd: 0 });
  assert.match(lines[0], /\[reply\] walkie turn 1, 0\.9 s, \$0\.000, no <voice> tag$/);
});

test('a compaction is printed as one, with what was said of it', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'compact', voice: '压缩完了。', screen: '压缩完了，上下文少了60%。', text: '', tagged: false, turns: 3, ms: 30_000, costUsd: 0.5 });
  assert.match(lines[0], /\[compact\] walkie, 30\.0 s, \$0\.500$/);
  assert.equal(lines[1], '  压缩完了，上下文少了60%。');
});

test('attach prints what the manager, the approvals and the link say', () => {
  const { con, lines } = make();
  const manager = new EventEmitter();
  const approvals = new EventEmitter();
  const link = new EventEmitter();
  con.attach({ manager: { on: (n, f) => manager.on(n, f) }, approvals: { on: (n, f) => approvals.on(n, f) }, link });
  manager.emit('working', { project: 'walkie', tool: null, summary: '', startedAt: 0 });
  manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'npm test', startedAt: 0 });
  manager.emit('notice', { kind: 'exited', text: 'Claude 退出了' });
  manager.emit('failure', { kind: 'login', message: '登录过期' });
  manager.emit('project', { name: 'on-the-beat' });
  approvals.emit('show', { id: 4, tool: 'Bash', preview: 'rm -rf build\nand more', toolUseId: 't' });
  approvals.emit('clear', { id: 4, outcome: 'denied' });
  link.emit('status', 'cannot open the S3 (no S3 on USB); retrying');
  link.emit('hello', { version: '0.4.0', ringBytes: 262144, upRate: 16000, downRate: 24000 });
  link.emit('log', 'screen idle');
  link.emit('down', 'no PONG for 3 s');
  assert.deepEqual(lines.map((l) => l.replace(/^\d\d:\d\d:\d\d /, '')), [
    '[working] thinking',
    '[working] Bash: npm test',
    '[notice] exited: Claude 退出了',
    '[failure] login: 登录过期',
    '[project] on-the-beat',
    '[approval] #4 Bash',
    '    rm -rf build',
    '    and more',
    '[approval] #4 denied',
    '[link] cannot open the S3 (no S3 on USB); retrying',
    '[link] walkie 0.4.0 is connected (ring 262144 bytes)',
    '[S3] screen idle',
    '[link] down: no PONG for 3 s',
  ]);
});
```

Create `bridge/test/helpers/fake-s3.js`:

```js
// A stand-in for the S3 on the serial port, for tests that run the whole bridge. The Link writes frames to it and it answers the
// way walkie's firmware does: HELLO with the nonce echoed, a PONG for every PING, CREDIT for the audio it is sent, and PLAYED when
// a reply ends or is stopped. The test plays the device's own side with take(), button() and answer().
import { EventEmitter } from 'node:events';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { CMD, parseApprovalReq, parseUi } from '../../src/link/messages.js';

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

export class FakeS3 extends EventEmitter {
  sent = []; // every frame the bridge wrote, decoded, in order
  #decoder = new FrameDecoder();
  #seq = 0;
  #downBytes = 0;
  #ringBytes;
  #version;

  constructor({ ringBytes = 262144, version = '0.0.0-fake' } = {}) {
    super();
    this.#ringBytes = ringBytes;
    this.#version = version;
  }

  // ---- the port, as the Link sees it

  write(buf) {
    for (const f of this.#decoder.push(buf)) {
      this.sent.push(f);
      setImmediate(() => this.#answer(f));
    }
    return true;
  }

  close() {
    this.emit('close');
  }

  // ---- the firmware's answers

  #answer(f) {
    switch (f.type) {
      case TYPE.HELLO: {
        const hello = Buffer.alloc(18 + this.#version.length);
        hello[0] = 1;
        hello.writeUInt16LE(16000, 2);
        hello.writeUInt16LE(24000, 4);
        hello.writeUInt32LE(this.#ringBytes, 6);
        hello.writeUInt32LE(1234, 10);
        hello.writeUInt32LE(f.payload.readUInt32LE(1), 14);
        hello.write(this.#version, 18);
        this.feed(TYPE.HELLO, hello);
        this.feed(TYPE.CREDIT, u32(12288));
        break;
      }
      case TYPE.PING:
        this.feed(TYPE.PONG, Buffer.concat([f.payload, u32(1234), u32(0), u32(0)]));
        break;
      case TYPE.AUDIO_DOWN:
        this.#downBytes += f.payload.length;
        if (f.payload.length > 0) this.feed(TYPE.CREDIT, u32(f.payload.length));
        if (f.flags & FLAG.EOS) this.#played(0);
        break;
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        break;
      default:
    }
  }

  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(0), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
  }

  // ---- what the test plays

  feed(type, payload = Buffer.alloc(0), flags = 0) {
    this.emit('data', Buffer.from(encodeFrame({ type, flags, seq: this.#seq++, payload })));
  }

  // One take as the talk key would make it: 20 ms frames of 16 kHz PCM16, the last one carrying EOS (and REASON).
  take(pcm, { reason = false } = {}) {
    const FRAME = 640;
    for (let at = 0; at < pcm.length; at += FRAME) {
      const last = at + FRAME >= pcm.length;
      this.feed(TYPE.AUDIO_UP, pcm.subarray(at, at + FRAME), last ? FLAG.EOS | (reason ? FLAG.REASON : 0) : 0);
    }
  }

  button(code) {
    this.feed(TYPE.BUTTON, Buffer.from([code]));
  }

  answer(id, allow, reasonFollows = false) {
    const p = Buffer.alloc(4);
    p.writeUInt16LE(id, 0);
    p[2] = allow ? 1 : 0;
    p[3] = reasonFollows ? 1 : 0;
    this.feed(TYPE.APPROVAL_RES, p);
  }

  // ---- what the bridge sent, read back

  frames(type) {
    return this.sent.filter((f) => f.type === type);
  }

  // The screens in the order they were sent: {state, project, text, elapsedMs} for a UI frame, {approval: {...}} for an approval.
  screens() {
    return this.sent.flatMap((f) => {
      if (f.type === TYPE.UI) return [parseUi(f.payload)];
      if (f.type === TYPE.APPROVAL_REQ) return [{ approval: parseApprovalReq(f.payload) }];
      return [];
    });
  }

  // Bytes of reply audio the bridge has sent, and whether the last of it carried EOS.
  audioDown() {
    const frames = this.frames(TYPE.AUDIO_DOWN);
    return { bytes: frames.reduce((n, f) => n + f.payload.length, 0), ended: frames.some((f) => f.flags & FLAG.EOS) };
  }
}

export async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

Create `bridge/test/main.test.js`:

```js
// The whole bridge, with only the two ends stood in for: the S3 (FakeS3, on the real Link) and the speech providers. Claude is
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const FAKE_CLAUDE = join(import.meta.dirname, 'claude', 'fake-claude.js');
const speechPcm = Buffer.alloc(16000 * 2 * 1.2, 1); // 1.2 s of 16 kHz PCM16: more than the 250 ms that are trimmed and the 300 ms that are needed

// The providers: the transcripts come from `said` one call at a time, every utterance is a request for Claude, and every
// reply is a short tone, with the text it was asked to say written down in `spoken`.
function providers(said, spoken) {
  return [
    {
      name: 'openai',
      limits: { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: 3000, speakIdleMs: 3000, hearMs: 8000 },
      transcribe: async () => said.shift() ?? '',
      classify: async (text) => JSON.stringify({ intent: 'to_claude', project: null, text }),
      speak: async function* (text) {
        spoken.push(text);
        yield tone(330, 0.3, 4000);
      },
    },
  ];
}

async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const s3 = new FakeS3();
  const lines = [];
  const spoken = [];
  const store = createStateStore({ file: null });
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command: [process.execPath, FAKE_CLAUDE], prewarm: false, approvalTimeoutSec } },
    projects: [{ name: 'proj', aliases: [], path: project }],
    adapters: adapters ?? providers(said, spoken),
    openPort: openPort ?? (async () => s3),
    store,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: join(dir, 'sessions') }) },
    console: createConsole({ out: (line) => lines.push(line) }),
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => bridge.link.ready, 'the S3 to answer HELLO');
  const shown = (state) => s3.screens().find((s) => s.state === state);
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order };
}

test('a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'] });
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.equal(w.shown(UI_STATE.CONFIRM).text, '你好');
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
```

Create `bridge/test/walkie-bin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/walkie.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./claude/fake-claude.js', import.meta.url));

// The real bin in a private %APPDATA% (no keys, no state of the real bridge), with nothing that could reach a provider or the S3.
const env = (appdata) => ({ ...process.env, APPDATA: appdata, OPENAI_API_KEY: '', GEMINI_API_KEY: '' });

function run(...args) {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  try {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(appdata, { recursive: true, force: true });
  }
}

test('a flag it does not know, or a word it has no use for, stops it with exit 2 and the usage', () => {
  for (const args of [['--provder', 'openai'], ['listen'], ['--port']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out, /usage: node bridge\/bin\/walkie\.js/, args.join(' '));
  }
});

test('a --command that is not a JSON array stops it before anything is started', () => {
  const r = run('--command', 'claude --verbose');
  assert.equal(r.status, 1);
  assert.match(r.err, /--command is the program and its leading arguments as a JSON array/);
  assert.ok(!r.out.includes('[walkie]'), 'it never got as far as the banner');
});

test('it starts, says what is missing, waits for the S3, and the stand-in for claude comes up with it', async () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const child = spawn(process.execPath, [BIN, '--port', 'NOT-A-PORT', '--command', JSON.stringify([process.execPath, FAKE_CLAUDE])], { env: env(appdata), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // Made before anything can go wrong: a child that has already exited never says 'exit' again, and waiting for it would hang.
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try {
    const end = Date.now() + 15_000;
    while (!/Ctrl\+C/.test(out) || !/\[link\] cannot open the S3/.test(out)) {
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`it stopped (exit ${child.exitCode}) before the banner:\n${out}`);
      if (Date.now() > end) assert.fail(`no banner within 15 s:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(out, /\[keys\] /);
    assert.match(out, /\[walkie\] .*projects?.*active/s);
    assert.equal(child.exitCode, null, 'it keeps running while there is no S3');
  } finally {
    child.kill();
    await gone;
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/console.test.js bridge/test/main.test.js bridge/test/walkie-bin.test.js`
Expected: FAIL, the test file cannot load: `Cannot find module 'bridge/src/console.js'`; 5 failures in all.

- [ ] **Step 3: Write the implementation**

Create `bridge/bin/walkie.js`:

```js
#!/usr/bin/env node
// walkie: the bridge between the S3 and Claude Code. It runs until Ctrl+C.
import { loadConfig } from '../src/config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../src/config/keys.js';
import { loadProjects } from '../src/config/projects.js';
import { createConsole } from '../src/console.js';
import { parseArgs, UsageError } from '../src/dev/args.js';
import { cleanEnv, commandFrom } from '../src/dev/claude.js';
import { portOpener } from '../src/dev/connect.js';
import { startBridge } from '../src/main.js';
import { createAdapters } from '../src/speech/speech.js';

const USAGE = `usage: node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
  whose keys are in %APPDATA%\\walkie\\keys.env. With no S3 plugged in it waits and connects when one appears.
  --port COMx       the S3's serial port (default: the one with USB id 303A:1001)
  --command json    the program and its leading arguments as a JSON array, for a stand-in for claude: '["node","fake-claude.js"]'
  --clean-env       claude is given the environment without CLAUDE* and ANTHROPIC* variables; needed inside the Claude app's
                    own shell, whose variables point a nested claude at the app instead of at the login`;

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
  const words = [parsed.name, ...parsed.args].filter((w) => w !== undefined);
  if (words.some((w) => w !== '--clean-env')) throw new UsageError(`${words.find((w) => w !== '--clean-env')} is not something walkie takes`);
  parsed.cleanEnv = words.includes('--clean-env');
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`walkie: ${err.message}`);
  console.log(USAGE);
  process.exit(2); // before any key is loaded or any port opened
}
const { opts } = parsed;

let bridge;
try {
  const con = createConsole();
  const config = loadConfig();
  const keys = loadKeys();
  con.log(`[keys] ${describeKeys(keys)}`);
  const why = whyKeysMissing(keys);
  if (why) con.log(`[keys] ${why}`);
  const projects = loadProjects();
  const settings = { ...config, claude: { ...config.claude, ...(opts.command ? { command: commandFrom(opts.command) } : {}) } };
  bridge = await startBridge({
    config: settings,
    projects,
    adapters: createAdapters({ keys, config }),
    openPort: portOpener(opts.port),
    console: con,
    env: parsed.cleanEnv ? cleanEnv(process.env) : process.env,
  });
  con.log(`[walkie] ${projects.length} project${projects.length === 1 ? '' : 's'}, active ${bridge.manager.project()}; waiting for the S3. Ctrl+C to stop.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let stopping = false;
function stop(signal) {
  if (stopping) process.exit(130); // a second Ctrl+C does not wait
  stopping = true;
  bridge.console.log(`[walkie] ${signal}: closing`);
  bridge
    .close()
    .catch((err) => console.error(err.message))
    .finally(() => setTimeout(() => process.exit(), 1000).unref()); // process.exit() right after a fetch can trip a libuv assertion on Node 24 for Windows; this ends when the loop empties
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
```

Create `bridge/src/console.js`:

```js
// What the bridge prints: one timestamped line per event, and every reply in full (spec 4, step 6; the device shows only a few
// lines of it).
const pad = (n) => String(n).padStart(2, '0');
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const indent = (text, by = '  ') => text.split('\n').map((line) => `${by}${line}`);

// `out(line)` writes one line; `now()` is the clock. Nothing here knows about the screen or the speaker.
export function createConsole({ out = (line) => console.log(line), now = () => new Date() } = {}) {
  const log = (line) => {
    const t = now();
    out(`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${line}`);
  };

  // What Claude answered: kind 'reply' or 'compact' (the manager's `reply` event).
  function reply(r) {
    const cost = `${seconds(r.ms)}, $${r.costUsd.toFixed(3)}`;
    if (r.kind === 'compact') {
      log(`[compact] ${r.project}, ${cost}`);
      for (const line of indent(r.screen)) out(line);
      return;
    }
    log(`[reply] ${r.project} turn ${r.turns}, ${cost}${r.tagged ? '' : ', no <voice> tag'}`);
    out(`  voice: ${r.voice}`);
    for (const line of indent(r.text || r.screen)) out(line);
  }

  // Prints what the manager, the approvals queue and the link say. `manager` and `approvals` have `on(name, fn)`; `link` is an
  // EventEmitter.
  function attach({ manager, approvals, link }) {
    manager.on('working', (w) => log(`[working] ${w.tool ? `${w.tool}${w.summary ? `: ${w.summary}` : ''}` : 'thinking'}`));
    manager.on('reply', reply);
    manager.on('notice', (n) => log(`[notice] ${n.kind}: ${n.text}`));
    manager.on('failure', (f) => log(`[failure] ${f.kind}: ${f.message}`));
    manager.on('project', (p) => log(`[project] ${p.name}`));
    approvals.on('show', (r) => {
      log(`[approval] #${r.id} ${r.tool}`);
      for (const line of indent(r.preview, '    ')) out(line);
    });
    approvals.on('clear', (c) => log(`[approval] #${c.id} ${c.outcome}`));
    link.on('status', (s) => log(`[link] ${s}`));
    link.on('hello', (h) => log(`[link] walkie ${h.version} is connected (ring ${h.ringBytes} bytes)`));
    link.on('log', (s) => log(`[S3] ${s}`));
    link.on('down', (reason) => log(`[link] down: ${reason}`));
  }

  return { log, reply, attach };
}
```

Create `bridge/src/main.js`:

```js
// The bridge, wired (spec 4 and 6): the S3 over USB serial on one side, Claude Code on the other, and the speech providers
// between them. This file only joins the parts; what each does is in its own module.
//
//   Link ── ui ──┐
//    │           ├── turn ── speech (OpenAI, Gemini)
//    │           ├── manager ── claude -p ──(MCP)── permission server ── approvals
//    └ console   └──────────────────────────────────────────────────────────┘
import { createManager } from './claude/manager.js';
import { createStateStore } from './config/state.js';
import { createConsole } from './console.js';
import { Link } from './link/link.js';
import { createApprovals } from './perm/approvals.js';
import { createPermServer } from './perm/server.js';
import { createSpeech } from './speech/speech.js';
import { createTurn } from './turn/turn.js';
import { createUi } from './ui/ui.js';

// config: the settings (loadConfig). projects: bridge/projects.json, validated. adapters: the speech providers that have a key
// (createAdapters). openPort: opens the S3's serial port, or throws while there is none; the link tries again every second.
// The rest are for tests and the dev commands: `start` is the program that stands in for claude, `turn` overrides the turn's
// timings, `makeNonce` the link's HELLO nonce.
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
  const server = createPermServer({ decide: (request) => approvals.request(request), log: con.log });
  let manager = null;
  let speech = null;
  let ui = null;
  let turn = null;
  let closing = null;

  // Deny what waits first, so that Claude is not left holding a request while it is ended; the link goes last, so that the
  // last frames still reach the device.
  async function close() {
    closing ??= (async () => {
      await turn?.close();
      approvals.denyAll();
      await manager?.close();
      await server.close();
      link.close();
    })();
    return closing;
  }

  try {
    const mcp = await server.start();
    const state = store ?? createStateStore({ report: con.log });
    manager = createManager({ config: config.claude, projects, store: state, mcp, start, env, log: con.log });
    speech = createSpeech({ adapters, config, projects, log: con.log });
    ui = createUi({ link, log: con.log });
    turn = createTurn({ link, speech, manager, approvals, ui, log: con.log, ...turnOptions });
    con.attach({ manager, approvals, link });
    await link.start();
    manager.start();
  } catch (err) {
    await close();
    throw err;
  }
  return { link, manager, approvals, speech, ui, turn, console: con, close };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/console.test.js bridge/test/main.test.js bridge/test/walkie-bin.test.js`
Expected: PASS, 21 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 638 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie.js bridge/src/console.js bridge/src/main.js bridge/test/console.test.js bridge/test/helpers/fake-s3.js bridge/test/main.test.js bridge/test/walkie-bin.test.js
git commit -m @'
Task 9: the bridge, wired: console, startBridge and bin/walkie.js

startBridge joins link, ui, turn, manager, speech, approvals and the permission server and closes them in the order that leaves Claude no request held. bin/walkie.js is the program he runs; the console prints what happens, with timestamps. Twelve mutants of main.js: all killed.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
'@
```

---

### Task 10: `walkie-dev press`, `ui` and `snap`

Three developer commands that let every key gesture and every screen be tried and looked at with nobody touching the S3. `press` plays a key script on the firmware itself (TEST KEYS), in a small language (`front:600`, `side:1100`, `both:3200`, `down:front`, `up:side`, `wait:300`), and prints the lines the S3 logs about what it did with them. `ui` puts a screen or an approval on the device as the bridge would, prints the keys' answers, and stays up until Ctrl+C, `--secs`, or `--snap`. `snap` reads the S3's display back (TEST SNAP), puts the chunks together, turns RGB565 into RGB and writes a PNG, so that the screen can be opened and looked at; `png.js` writes it with `node:zlib` and nothing else. A screen only lasts while a bridge is pinging, which is why `ui` and `press` take `--snap` themselves instead of leaving it to a second process.

**Files:**
- Create: `bridge/src/dev/png.js`, `bridge/src/dev/press.js`, `bridge/src/dev/snap.js`, `bridge/src/dev/ui.js`
- Modify: `.gitignore`, `bridge/bin/walkie-dev.js`, `bridge/src/dev/args.js`
- Test (new): `bridge/test/dev/png.test.js`, `bridge/test/dev/press.test.js`, `bridge/test/dev/snap.test.js`, `bridge/test/dev/ui.test.js`, `bridge/test/helpers/fake-link.js`
- Test (changed): `bridge/test/dev/walkie-dev.test.js`

**Interfaces:**
- Consumes: `TYPE` (plan 1); `testKeysPayload`, `testSnapPayload`, `parseSnapChunk`, `uiPayload`, `approvalReqPayload`, `parseButton`, `parseApprovalRes`, `UI_STATE`, `KEY`, `LIMITS` (Task 1); plan 1's `connect(opts)` from `bridge/src/dev/connect.js` (resolves to a `Link` that has seen the S3's HELLO) and the dev commands' `parseArgs`; the `walkie-dev` dispatch table (`bin/walkie-dev.js`).
- Produces:
  - `bridge/src/dev/png.js`: `encodePng(width, height, rgb: Buffer): Buffer` (8-bit RGB, row by row; pixels that do not fit the size are refused, not padded).
  - `bridge/src/dev/press.js`: `ScriptError`, `parseKeyScript(text): {steps: {delayMs, mask}[], totalMs}` (a hold is a press, a wait of its length and a release; waits add up in front of the next step; `down:`/`up:` of a key already in that state change nothing), and the default export `press(args, opts, connectFn = connect, sleep)`; with `--snap file.png` the screen is saved after the script has played out.
  - `bridge/src/dev/snap.js`: `assembleSnap(chunks): {width, height, rgb}` (chunks in any order; refuses a snapshot that is not whole, naming what is missing), `takeSnap(link, {timeoutMs = 3000}): Promise<{width, height, rgb}>`, `snapTo(link, file, options): Promise<file>` (makes the folder), and the default export `snap(args, opts, connectFn, {timeoutMs, dir})`; without `--out` the PNG goes to `bridge/snaps/` with the time in its name.
  - `bridge/src/dev/ui.js`: `UiArgsError`, `parseUiArgs(args, opts): {kind: 'screen' | 'approval', ...}` and the default export `ui(args, opts, connectFn, sleep)`.
  - `bridge/test/helpers/fake-link.js`: `fakeLink()`, a stand-in for the `Link` that records what is sent and lets the test emit what the S3 would say.
  - `walkie-dev press|ui|snap`, `--elapsed` and `--snap` as value flags of `args.js`, and `bridge/snaps/` in `.gitignore`.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/dev/png.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';
import { encodePng } from '../../src/dev/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A reader that trusts nothing: the signature, every chunk's CRC, the header, and the rows with their filter byte.
function decode(png) {
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `${type} CRC`);
    chunks.push({ type, data });
    at += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  assert.deepEqual([...ihdr.subarray(8)], [8, 2, 0, 0, 0], '8 bits, truecolour, no interlace');
  const raw = inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (1 + width * 3));
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + width * 3)], 0, 'filter none');
    raw.copy(rgb, y * width * 3, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
  }
  return { width, height, rgb };
}

test('a PNG that is read back has the size and the pixels it was given', () => {
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const out = decode(encodePng(3, 2, rgb));
  assert.equal(out.width, 3);
  assert.equal(out.height, 2);
  assert.deepEqual(out.rgb, rgb);
});

test('the size of the S3 screen goes through, and a big flat one is small', () => {
  const rgb = Buffer.alloc(240 * 135 * 3, 0x20);
  const png = encodePng(240, 135, rgb);
  const out = decode(png);
  assert.deepEqual([out.width, out.height], [240, 135]);
  assert.deepEqual(out.rgb, rgb);
  assert.ok(png.length < 1000, `deflated: ${png.length} bytes`);
});

test('pixels that do not fit the size are refused, not padded', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(11)), /12 bytes/);
  assert.throws(() => encodePng(0, 2, Buffer.alloc(0)), /size/);
});
```

Create `bridge/test/dev/press.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import press, { parseKeyScript, ScriptError } from '../../src/dev/press.js';
import { TYPE } from '../../src/link/frame.js';
import { KEY, TEST_OP, parseTestKeys } from '../../src/link/messages.js';
import { fakeLink, fakeLinkWithScreen } from '../helpers/fake-link.js';

const F = KEY.FRONT;
const S = KEY.SIDE;

test('a hold is a press, a wait of its length, and a release', () => {
  assert.deepEqual(parseKeyScript('front:500'), { steps: [{ delayMs: 0, mask: F }, { delayMs: 500, mask: 0 }], totalMs: 500 });
  assert.deepEqual(parseKeyScript('side:1100').steps, [{ delayMs: 0, mask: S }, { delayMs: 1100, mask: 0 }]);
  assert.deepEqual(parseKeyScript('both:3200').steps, [{ delayMs: 0, mask: F | S }, { delayMs: 3200, mask: 0 }]);
});

test('waits add up in front of the next step, and commas are spaces', () => {
  assert.deepEqual(parseKeyScript('front:120, wait:300 wait:200, side:90'), {
    steps: [
      { delayMs: 0, mask: F },
      { delayMs: 120, mask: 0 },
      { delayMs: 500, mask: S },
      { delayMs: 90, mask: 0 },
    ],
    totalMs: 710,
  });
});

test('down and up make a chord with the second key a moment after the first', () => {
  assert.deepEqual(parseKeyScript('down:front wait:100 down:side wait:3100 up:both'), {
    steps: [
      { delayMs: 0, mask: F },
      { delayMs: 100, mask: F | S },
      { delayMs: 3100, mask: 0 },
    ],
    totalMs: 3200,
  });
});

test('releasing one key of two leaves the other held', () => {
  assert.deepEqual(parseKeyScript('down:both wait:50 up:front wait:50 up:side').steps.map((s) => s.mask), [F | S, S, 0]);
});

test('anything that is not a script is an error that says what, never a guess', () => {
  const bad = (text, pattern) => assert.throws(() => parseKeyScript(text), (err) => err instanceof ScriptError && pattern.test(err.message), text);
  bad('', /the script is empty/);
  bad('front', /front needs a time/);
  bad('front:abc', /milliseconds/);
  bad('front:-5', /milliseconds/);
  bad('front:0', /more than 0/);
  bad('front:70000', /65535/);
  bad('wait:70000', /65535/);
  bad('thumb:100', /unknown/);
  bad('down:thumb', /front, side or both/);
  bad('up:front', /is not held/);
  bad(Array.from({ length: 9 }, () => 'front:10').join(' '), /at most 16 steps/);
});

test('press sends the script as TEST KEYS and waits for it to play out, with a margin for the S3 to answer', async (t) => {
  const link = fakeLink();
  const slept = [];
  t.mock.method(console, 'log', () => {});
  await press(['front:600', 'wait:200', 'side:100'], {}, async () => link, async (ms) => slept.push(ms));
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual(parseTestKeys(link.sent[0].payload).steps, [
    { delayMs: 0, mask: F },
    { delayMs: 600, mask: 0 },
    { delayMs: 200, mask: S },
    { delayMs: 100, mask: 0 },
  ]);
  assert.deepEqual(slept, [900 + 1500]);
  assert.equal(link.closed, true);
});

test('a bad script stops press before it connects', async () => {
  let connected = false;
  await assert.rejects(press(['front'], {}, async () => (connected = true)), ScriptError);
  assert.equal(connected, false);
});

test('with --snap the screen is saved after the script, and not before it has played out', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-press-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = fakeLinkWithScreen(12, 4, () => 0x07e0);
  const order = [];
  const answer = link.onSend;
  link.onSend = (type, payload) => {
    order.push(payload[0] === TEST_OP.SNAP ? 'snap' : 'keys');
    answer(type, payload);
  };
  const file = path.join(dir, 'after.png');
  await press(['both:3300'], { snap: file }, async () => link, async () => order.push('slept'));
  assert.deepEqual(order, ['keys', 'slept', 'snap']);
  assert.ok(statSync(file).size > 0);
  assert.equal(link.closed, true);
});

test('without --snap press asks for no picture', async (t) => {
  t.mock.method(console, 'log', () => {});
  const link = fakeLink();
  await press(['front:100'], {}, async () => link, async () => {});
  assert.equal(link.sent.length, 1);
});

test('the limits are those of the firmware: 16 steps and 65535 ms to a step, and not one more of either', () => {
  assert.equal(parseKeyScript(Array.from({ length: 8 }, () => 'front:10').join(' ')).steps.length, 16);
  assert.equal(parseKeyScript('wait:65535 front:10').steps[0].delayMs, 65535);
  assert.equal(parseKeyScript('front:65535').steps[1].delayMs, 65535);
  const bad = (text, pattern) => assert.throws(() => parseKeyScript(text), (err) => err instanceof ScriptError && pattern.test(err.message), text);
  bad('wait:65536 front:10', /65535/);
  bad('front:65536', /65535/);
  bad('wait:65535 wait:1 front:10', /between two key changes/);
});

test('a hold leaves a key that is already down down', () => {
  assert.deepEqual(parseKeyScript('down:side wait:50 front:100').steps, [
    { delayMs: 0, mask: S },
    { delayMs: 50, mask: S | F },
    { delayMs: 100, mask: S },
  ]);
});
```

Create `bridge/test/dev/snap.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import snap, { assembleSnap, snapTo, takeSnap } from '../../src/dev/snap.js';
import { TYPE } from '../../src/link/frame.js';
import { TEST_OP, parseSnapChunk } from '../../src/link/messages.js';
import { fakeLink, fakeLinkWithScreen, frameOf, snapFrames } from '../helpers/fake-link.js';

const RED = 0xf800;
const GREEN = 0x07e0;
const BLUE = 0x001f;
const GREY = 0x8410; // r 16, g 32, b 16: the fives and the six must be spread over 0..255, not shifted

const chunksOf = (frames) => frames.map((f) => parseSnapChunk(f.payload));
const pngSize = (file) => {
  const png = readFileSync(file);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

test('RGB565 pixels become RGB with the low bits spread, so white is white and black is black', () => {
  const colours = [0x0000, 0xffff, RED, GREEN, BLUE, GREY];
  const { width, height, rgb } = assembleSnap(chunksOf(snapFrames(6, 1, (x) => colours[x])));
  assert.deepEqual([width, height], [6, 1]);
  assert.deepEqual([...rgb], [0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 132, 130, 132]);
});

test('chunks that arrive out of order still make the screen in order', () => {
  const chunks = chunksOf(snapFrames(2, 5, (x, y) => (y < 2 ? RED : y < 4 ? GREEN : BLUE))).reverse();
  assert.equal(chunks.length, 3);
  const { rgb } = assembleSnap(chunks);
  assert.deepEqual([...rgb.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...rgb.subarray(2 * 2 * 3, 2 * 2 * 3 + 3)], [0, 255, 0]);
  assert.deepEqual([...rgb.subarray(4 * 2 * 3, 4 * 2 * 3 + 3)], [0, 0, 255], 'the one-row last chunk');
});

test('a snapshot that is not whole is refused, and says why', () => {
  const whole = chunksOf(snapFrames(4, 6, () => RED));
  assert.throws(() => assembleSnap([]), /no chunks/);
  assert.throws(() => assembleSnap(whole.slice(1)), /2 of 3 chunks/);
  assert.throws(() => assembleSnap([...whole, whole[0]]), /chunk 0 came twice/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], width: 5 }, whole[2]]), /size changed/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], count: 4 }, whole[2]]), /count changed/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], index: 3 }, whole[2]]), /index 3 .* 3 chunks/);
  assert.throws(() => assembleSnap([whole[0], { ...whole[1], pixels: whole[1].pixels.subarray(2) }, whole[2]]), /pixel bytes/);
  assert.throws(() => assembleSnap(chunksOf(snapFrames(4, 6, () => RED)).map((c) => ({ ...c, width: 0 }))), /size/);
});

test('takeSnap asks for the screen and returns it when the last chunk is in', async () => {
  const link = fakeLinkWithScreen(8, 4, (x) => (x < 4 ? RED : BLUE));
  const shot = await takeSnap(link);
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual([...link.sent[0].payload], [TEST_OP.SNAP]);
  assert.deepEqual([shot.width, shot.height], [8, 4]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [255, 0, 0]);
  assert.deepEqual([...shot.rgb.subarray(7 * 3, 7 * 3 + 3)], [0, 0, 255]);
  assert.equal(link.listenerCount('frame'), 0, 'it stops listening');
});

test('frames that are not chunks of the screen are not counted', async () => {
  const link = fakeLink();
  link.onSend = () => {
    link.emit('frame', frameOf(TYPE.BUTTON, Buffer.from([1])));
    link.emit('frame', frameOf(TYPE.APPROVAL_RES, snapFrames(2, 2, () => BLUE)[0].payload)); // the right bytes, from the wrong kind of frame
    link.emit('frame', frameOf(TYPE.TEST, Buffer.from([TEST_OP.UP_PATTERN, 1, 2, 3])));
    for (const f of snapFrames(2, 2, () => RED)) link.emit('frame', f);
  };
  const shot = await takeSnap(link);
  assert.deepEqual([shot.width, shot.height], [2, 2]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [255, 0, 0]);
});

test('a snapshot that does not come is an error that says how much did', async () => {
  const link = fakeLink();
  link.onSend = () => link.emit('frame', snapFrames(2, 6, () => RED)[0]);
  await assert.rejects(takeSnap(link, { timeoutMs: 30 }), /1 of 3 snapshot chunks within 0\.03 s/);
  assert.equal(link.listenerCount('frame'), 0);
  const silent = fakeLink();
  await assert.rejects(takeSnap(silent, { timeoutMs: 30 }), /0 snapshot chunks/);
});

test('a snapshot that is whole but wrong rejects instead of hanging', async () => {
  const link = fakeLink();
  link.onSend = () => {
    for (const f of snapFrames(4, 4, () => RED)) {
      f.payload.writeUInt16LE(9, 5); // a width the pixels do not make
      link.emit('frame', f);
    }
  };
  await assert.rejects(takeSnap(link, { timeoutMs: 1000 }), /pixel bytes/);
});

test('snapTo writes the screen as a PNG of the right size, in a folder that did not exist', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = fakeLinkWithScreen(240, 135, () => GREEN);
  const file = path.join(dir, 'a', 'b', 'screen.png');
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  assert.equal(await snapTo(link, file), file);
  assert.deepEqual(pngSize(file), [240, 135]);
  assert.match(lines.join('\n'), /snap: 240x135 -> /);
});

test('the snap command saves to --out, or to a stamped file in the default folder, and closes the link', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const link = fakeLinkWithScreen(10, 4, () => RED);
  await snap([], { out: path.join(dir, 'x.png') }, async () => link, { dir: path.join(dir, 'unused') });
  assert.deepEqual(pngSize(path.join(dir, 'x.png')), [10, 4]);
  assert.equal(link.closed, true);
  assert.deepEqual(readdirSync(dir), ['x.png'], 'the default folder was not touched');

  const stamped = fakeLinkWithScreen(10, 4, () => BLUE);
  await snap([], {}, async () => stamped, { dir: path.join(dir, 'snaps') });
  const [name, ...others] = readdirSync(path.join(dir, 'snaps'));
  assert.match(name, /^snap-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.png$/);
  assert.deepEqual(others, []);
  assert.equal(stamped.closed, true);
});

test('snap closes the link when the snapshot fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  const link = fakeLink();
  await assert.rejects(snap([], { out: path.join(tmpdir(), 'never.png') }, async () => link, { timeoutMs: 20 }), /snapshot chunks/);
  assert.equal(link.closed, true);
});

test('a snapshot that arrived does not leave its timeout running', async (t) => {
  const cleared = [];
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    cleared.push(id);
    clear(id);
  });
  await takeSnap(fakeLinkWithScreen(2, 2, () => RED), { timeoutMs: 2000 });
  assert.equal(cleared.length, 1);
});
```

Create `bridge/test/dev/ui.test.js`:

```js
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
```

In `bridge/test/dev/walkie-dev.test.js`, replace:

```js
test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});
```

with:

```js
test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});
```

In `bridge/test/dev/walkie-dev.test.js`, replace:

```js
  assert.equal(code, 0, err);
  assert.ok(!err.includes('process.exit() was called'), 'the loop was not empty: the cut-off had to end it');
});
```

with:

```js
  assert.equal(code, 0, err);
  assert.ok(!err.includes('process.exit() was called'), 'the loop was not empty: the cut-off had to end it');
});

test('press and ui stop on a script or a screen they cannot read, before they open any port', () => {
  const press = walkieDev('press', 'front');
  assert.equal(press.status, 1);
  assert.match(press.err, /front needs a time/);
  assert.ok(!press.out.includes('[link]'), 'it never tried the S3');
  const ui = walkieDev('ui', 'sleeping');
  assert.equal(ui.status, 1);
  assert.match(ui.err, /unknown screen "sleeping"/);
  assert.ok(!ui.out.includes('[link]'), 'it never tried the S3');
});

test('--snap and --elapsed take a value like the other options', () => {
  const run = walkieDev('ui', 'reply', 'x', '--snap');
  assert.equal(run.status, 2);
  assert.match(run.err, /--snap needs a value/);
});
```

Create `bridge/test/helpers/fake-link.js`:

```js
// A stand-in for the Link that the dev commands are given: it records what is sent, and the test emits what the S3 would say.
import { EventEmitter } from 'node:events';
import { TYPE } from '../../src/link/frame.js';
import { TEST_OP } from '../../src/link/messages.js';

export function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.closed = false;
  link.onSend = null; // (type, payload) => void, to answer at once
  link.send = (type, payload = Buffer.alloc(0), flags = 0) => {
    link.sent.push({ type, payload, flags });
    link.onSend?.(type, payload);
    return true;
  };
  link.close = () => {
    link.closed = true;
  };
  return link;
}

export const frameOf = (type, payload) => ({ type, flags: 0, seq: 0, payload });

// What the S3 answers TEST SNAP with: the screen as RGB565 little endian, `rowsPerChunk` rows to a chunk.
// `pixelAt(x, y)` is the 16-bit colour of a pixel.
export function snapFrames(width, height, pixelAt, rowsPerChunk = 2) {
  const count = Math.ceil(height / rowsPerChunk);
  return Array.from({ length: count }, (_, index) => {
    const rows = Math.min(rowsPerChunk, height - index * rowsPerChunk);
    const pixels = Buffer.alloc(rows * width * 2);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < width; x++) pixels.writeUInt16LE(pixelAt(x, index * rowsPerChunk + r), (r * width + x) * 2);
    }
    const head = Buffer.alloc(9);
    head[0] = TEST_OP.SNAP;
    head.writeUInt16LE(index, 1);
    head.writeUInt16LE(count, 3);
    head.writeUInt16LE(width, 5);
    head.writeUInt16LE(height, 7);
    return frameOf(TYPE.TEST, Buffer.concat([head, pixels]));
  });
}

// A link that answers TEST SNAP with a screen of `pixelAt`.
export function fakeLinkWithScreen(width, height, pixelAt) {
  const link = fakeLink();
  link.onSend = (type, payload) => {
    if (type === TYPE.TEST && payload[0] === TEST_OP.SNAP) {
      for (const f of snapFrames(width, height, pixelAt)) link.emit('frame', f);
    }
  };
  return link;
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/dev/png.test.js bridge/test/dev/press.test.js bridge/test/dev/snap.test.js bridge/test/dev/ui.test.js bridge/test/dev/walkie-dev.test.js`
Expected: FAIL, the test file cannot load: `Cannot find module 'bridge/src/dev/png.js'`; 7 failures in all.

- [ ] **Step 3: Write the implementation**

Append to the end of `.gitignore`:

```
bridge/snaps/
```

In `bridge/bin/walkie-dev.js`, replace:

```js
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)
  claude [--cwd dir | --project name] [--command json] [--clean-env]   the session manager from a terminal: it reads
                           commands on stdin (say, continue, compact, new, stop, status, switch, yes, no, wait, sleep, quit)
                           and runs the real claude (Claude's quota) unless --command names a stand-in`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
```

with:

```js
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)
  claude [--cwd dir | --project name] [--command json] [--clean-env]   the session manager from a terminal: it reads
                           commands on stdin (say, continue, compact, new, stop, status, switch, yes, no, wait, sleep, quit)
                           and runs the real claude (Claude's quota) unless --command names a stand-in
  press <script> [--snap file.png]   press the S3's keys from the firmware: front:600 side:1100 both:3200 wait:300 down:front up:front
  ui <idle|transcribing|confirm|working|reply|error> [text...] [--project name] [--elapsed secs] [--secs n | --snap file.png]
  ui approval <tool> <preview...> [--secs n | --snap file.png]   show a screen, or a request for a yes or no, as the bridge would
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
```

In `bridge/bin/walkie-dev.js`, replace:

```js
  say: () => import('../src/dev/say.js'),
  classify: () => import('../src/dev/classify.js'),
  claude: () => import('../src/dev/claude.js'),
};

let parsed;
```

with:

```js
  say: () => import('../src/dev/say.js'),
  classify: () => import('../src/dev/classify.js'),
  claude: () => import('../src/dev/claude.js'),
  press: () => import('../src/dev/press.js'),
  ui: () => import('../src/dev/ui.js'),
  snap: () => import('../src/dev/snap.js'),
};

let parsed;
```

Replace the whole of `bridge/src/dev/args.js` with:

```js
// The command line of walkie-dev.js: <command> [arguments] [--flag value]... A flag that is misspelled, has no value or is
// given twice is an error, never a silent default: a `--provider=openai` that quietly meant "auto" could send a
// recording to a provider nobody agreed to.
export class UsageError extends Error {}

const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider', '--cwd', '--project', '--command', '--elapsed', '--snap'];
const SWITCHES = ['--all', '--clean-env']; // stay among the arguments, for the command that reads them
const FLAG_LIKE = /^--[A-Za-z][\w-]*(=|$)/; // anything else that starts with -- is text

export function parseArgs(argv) {
  const rest = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAG_LIKE.test(arg) || SWITCHES.includes(arg)) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq); // what follows an equals sign is never repeated: it may be a key
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const name = flag.slice(2);
    if (name in opts) throw new UsageError(`${flag} was given twice`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || FLAG_LIKE.test(value)) throw new UsageError(`${flag} needs a value`);
    opts[name] = value;
  }
  const [name, ...args] = rest;
  return { name, args, opts };
}
```

Create `bridge/src/dev/png.js`:

```js
// A PNG from 8-bit RGB pixels, with nothing but zlib: the screen of the S3 as a picture that can be opened and looked at.
import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

// rgb: width * height * 3 bytes, row by row.
export function encodePng(width, height, rgb) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError(`PNG size must be positive integers, not ${width}x${height}`);
  if (rgb.length !== width * height * 3) throw new RangeError(`a ${width}x${height} PNG is ${width * height * 3} bytes of RGB, not ${rgb.length}`);
  const row = width * 3;
  const raw = Buffer.alloc(height * (1 + row)); // each row starts with its filter byte, 0 = none
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (1 + row) + 1, y * row, (y + 1) * row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, truecolour, deflate, no filter, no interlace
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
```

Create `bridge/src/dev/press.js`:

```js
// press <script>: the S3's keys, pressed by the firmware itself (TEST KEYS), so that the gestures can be tried with no hand on the
// device. The S3 logs what it does with them ("act ...", "screen ...") and walkie-dev prints those lines.
//   front:<ms> | side:<ms> | both:<ms>    press, hold for that long, release
//   down:<key> | up:<key>                 press or release without a hold (key is front, side or both)
//   wait:<ms>                             nothing for a while
// Words are separated by spaces or commas. --snap file.png saves a picture of the screen when the script is over. Examples:
//   front:600                             a talk take of 0.6 s
//   side:1100                             the 1 s hold that stops Claude
//   down:front wait:100 down:side wait:3100 up:both     a chord held for 3 s: SWITCH_CONFIRM
import { TYPE } from '../link/frame.js';
import { KEY, LIMITS, testKeysPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { snapTo } from './snap.js';

const BITS = { front: KEY.FRONT, side: KEY.SIDE, both: KEY.FRONT | KEY.SIDE };
const MAX_MS = 0xffff;
const SETTLE_MS = 1500; // for the S3 to finish and say what it did

export class ScriptError extends Error {}

function millis(text, word) {
  if (!/^\d+$/.test(text ?? '')) throw new ScriptError(`${word} needs a time in milliseconds, like ${word.split(':')[0]}:500`);
  return Number(text);
}

// -> {steps: [{delayMs, mask}], totalMs}: each step is "after delayMs, the keys held are mask".
export function parseKeyScript(text) {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) throw new ScriptError('the script is empty: front:600, side:1100, down:front wait:100 up:front ...');
  const steps = [];
  let held = 0;
  let wait = 0;
  let totalMs = 0;
  const set = (mask) => {
    steps.push({ delayMs: wait, mask });
    totalMs += wait;
    wait = 0;
    held = mask;
  };
  const delay = (ms, word) => {
    wait += ms;
    if (wait > MAX_MS) throw new ScriptError(`${word}: at most ${MAX_MS} ms between two key changes`);
  };
  for (const word of words) {
    const colon = word.indexOf(':');
    const name = colon < 0 ? word : word.slice(0, colon);
    const arg = colon < 0 ? undefined : word.slice(colon + 1);
    if (Object.hasOwn(BITS, name)) {
      const ms = millis(arg, word);
      if (ms === 0) throw new ScriptError(`${word}: a hold is for more than 0 ms`);
      set(held | BITS[name]);
      delay(ms, word);
      set(held & ~BITS[name]);
    } else if (name === 'wait') {
      delay(millis(arg, word), word);
    } else if (name === 'down' || name === 'up') {
      if (!Object.hasOwn(BITS, arg ?? '')) throw new ScriptError(`${word}: ${name} is followed by front, side or both`);
      if (name === 'down') set(held | BITS[arg]);
      else if ((held & BITS[arg]) === 0) throw new ScriptError(`${word}: ${arg} is not held`);
      else set(held & ~BITS[arg]);
    } else {
      throw new ScriptError(`unknown word "${word}" (front, side, both, down, up, wait)`);
    }
    if (steps.length > LIMITS.keySteps) throw new ScriptError(`a script has at most ${LIMITS.keySteps} steps`);
  }
  return { steps, totalMs };
}

// connectFn and sleep are for tests. With --snap file.png the screen is saved once the script has played out.
export default async function press(args, opts, connectFn = connect, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const { steps, totalMs } = parseKeyScript(args.join(' '));
  const link = await connectFn(opts);
  try {
    link.send(TYPE.TEST, testKeysPayload(steps));
    console.log(`keys: ${steps.length} steps over ${totalMs} ms`);
    await sleep(totalMs + SETTLE_MS);
    if (opts.snap) await snapTo(link, opts.snap);
  } finally {
    link.close();
  }
}
```

Create `bridge/src/dev/snap.js`:

```js
// snap [--out file.png]: what the S3's screen shows right now, as a PNG. The firmware reads its own display back (TEST SNAP) and
// sends it in chunks of a few rows; this puts them together. Without --out the file goes to bridge/snaps/ with the time in its
// name. ui and press take --snap file.png to look at the screen they have just changed: the screen only lasts while a bridge
// is pinging, so another process could not.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE } from '../link/frame.js';
import { parseSnapChunk, testSnapPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { encodePng } from './png.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../snaps/', import.meta.url));
const SNAP_TIMEOUT_MS = 5000;

// Five-bit and six-bit channels spread over 0..255 (the top bits repeated in the bottom), so that full is 255 and not 248.
const spread5 = (v) => (v << 3) | (v >> 2);
const spread6 = (v) => (v << 2) | (v >> 4);

// chunks: the parsed TEST SNAP frames (parseSnapChunk), in any order. -> {width, height, rgb} with 8-bit RGB.
export function assembleSnap(chunks) {
  if (chunks.length === 0) throw new Error('the snapshot has no chunks');
  const { count, width, height } = chunks[0];
  if (!(width >= 1 && height >= 1 && count >= 1)) throw new Error(`the snapshot is ${width}x${height} in ${count} chunks: not a size`);
  const byIndex = new Map();
  for (const c of chunks) {
    if (c.count !== count) throw new Error(`the snapshot's chunk count changed from ${count} to ${c.count}`);
    if (c.width !== width || c.height !== height) throw new Error(`the snapshot's size changed from ${width}x${height} to ${c.width}x${c.height}`);
    if (c.index >= count) throw new Error(`a chunk has index ${c.index} in a snapshot of ${count} chunks`);
    if (byIndex.has(c.index)) throw new Error(`chunk ${c.index} came twice`);
    byIndex.set(c.index, c.pixels);
  }
  if (byIndex.size !== count) throw new Error(`the snapshot has ${byIndex.size} of ${count} chunks`);
  const rgb565 = Buffer.concat(Array.from({ length: count }, (_, i) => byIndex.get(i)));
  if (rgb565.length !== width * height * 2) throw new Error(`the snapshot has ${rgb565.length} pixel bytes, a ${width}x${height} screen is ${width * height * 2}`);
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const px = rgb565.readUInt16LE(i * 2);
    rgb[i * 3] = spread5(px >> 11);
    rgb[i * 3 + 1] = spread6((px >> 5) & 0x3f);
    rgb[i * 3 + 2] = spread5(px & 0x1f);
  }
  return { width, height, rgb };
}

// Asks for the screen and waits for all of it.
export function takeSnap(link, { timeoutMs = SNAP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      link.off('frame', onFrame);
      settle(value);
    };
    function onFrame(f) {
      if (f.type !== TYPE.TEST) return;
      const chunk = parseSnapChunk(f.payload);
      if (!chunk) return;
      chunks.push(chunk);
      if (chunks.length < chunk.count) return;
      try {
        finish(resolve, assembleSnap(chunks));
      } catch (err) {
        finish(reject, err);
      }
    }
    timer = setTimeout(() => {
      const of = chunks.length > 0 ? ` of ${chunks[0].count}` : '';
      finish(reject, new Error(`the S3 sent ${chunks.length}${of} snapshot chunks within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    link.on('frame', onFrame);
    link.send(TYPE.TEST, testSnapPayload());
  });
}

// The screen, written to `file` as a PNG; resolves the file.
export async function snapTo(link, file, options) {
  const { width, height, rgb } = await takeSnap(link, options);
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, encodePng(width, height, rgb));
  console.log(`snap: ${width}x${height} -> ${file}`);
  return file;
}

// connectFn and `options` ({timeoutMs, dir}) are for tests.
export default async function snap(args, opts, connectFn = connect, { timeoutMs, dir = DEFAULT_DIR } = {}) {
  const file = opts.out ?? path.join(dir, `snap-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  const link = await connectFn(opts);
  try {
    await snapTo(link, file, { timeoutMs });
  } finally {
    link.close();
  }
}
```

Create `bridge/src/dev/ui.js`:

```js
// ui <screen> [text...] [--project name] [--elapsed secs]     put a screen on the S3 as the bridge would
// ui approval <tool> <preview...>                              ask for a yes or no, as the permission server would
//   screens: idle, transcribing, confirm, working, reply, error
// The S3 shows it for as long as this stays connected (a screen is only kept up by a bridge that is pinging): until Ctrl+C,
// or --secs n, or --snap file.png, which waits for the screen to be drawn, saves a picture of it and ends. Meanwhile the
// keys' answers are printed: BUTTON events and the verdict of the approval.
import { TYPE } from '../link/frame.js';
import { BUTTON, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, uiPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { snapTo } from './snap.js';

export class UiArgsError extends Error {}

const SCREENS = Object.keys(UI_STATE).map((name) => name.toLowerCase());
const BUTTON_NAMES = Object.fromEntries(Object.entries(BUTTON).map(([name, code]) => [code, name]));
const DRAW_MS = 700; // for the S3 to draw what it was sent before its display is read back
const MAX_ELAPSED_MS = 0xffffffff;
const SECONDS = /^\d+(\.\d+)?$/;

function seconds(text, flag, what) {
  if (!SECONDS.test(text ?? '')) throw new UiArgsError(`${flag} needs a number of seconds${what}`);
  return Number(text);
}

// -> {kind: 'ui', view: {state, project?, text?, elapsedMs?}, waitMs?} or {kind: 'approval', approval: {id, tool, preview}, waitMs?}
export function parseUiArgs(args, opts) {
  if (args.length === 0) throw new UiArgsError(`ui needs a screen: ${SCREENS.join(', ')} or approval`);
  const [first, ...rest] = args;
  const name = first.toLowerCase();
  let result;
  if (name === 'approval') {
    if (rest.length < 2) throw new UiArgsError('ui approval <tool> <preview...>: a tool name, then what it would do');
    result = { kind: 'approval', approval: { id: 1, tool: rest[0], preview: rest.slice(1).join(' ') } };
  } else {
    if (!SCREENS.includes(name)) throw new UiArgsError(`unknown screen "${first}": ${SCREENS.join(', ')} or approval`);
    const view = { state: UI_STATE[name.toUpperCase()] };
    if (opts.project) view.project = opts.project;
    if (rest.length > 0) view.text = rest.join(' ');
    if (opts.elapsed !== undefined) {
      const ms = Math.round(seconds(opts.elapsed, '--elapsed', ', like 12.5') * 1000);
      if (ms > MAX_ELAPSED_MS) throw new UiArgsError(`--elapsed is too long: at most ${Math.floor(MAX_ELAPSED_MS / 1000)} seconds`);
      view.elapsedMs = ms;
    }
    result = { kind: 'ui', view };
  }
  if (opts.secs !== undefined) {
    const secs = seconds(opts.secs, '--secs', ', more than 0');
    if (secs <= 0) throw new UiArgsError('--secs needs a number of seconds, more than 0');
    result.waitMs = Math.round(secs * 1000);
  }
  return result;
}

// connectFn and sleep are for tests.
export default async function ui(args, opts, connectFn = connect, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const what = parseUiArgs(args, opts);
  const link = await connectFn(opts);
  try {
    link.on('frame', (f) => {
      if (f.type === TYPE.BUTTON) {
        const b = parseButton(f.payload);
        if (b) console.log(`button: ${BUTTON_NAMES[b.event] ?? b.event}`);
      } else if (f.type === TYPE.APPROVAL_RES) {
        const r = parseApprovalRes(f.payload);
        if (r) console.log(`approval #${r.id}: ${r.allow ? 'allowed' : 'denied'}${r.reasonFollows ? ', a reason follows' : ''}`);
      }
    });
    if (what.kind === 'approval') {
      link.send(TYPE.APPROVAL_REQ, approvalReqPayload(what.approval));
      console.log(`sent: approval #${what.approval.id} ${what.approval.tool}`);
    } else {
      link.send(TYPE.UI, uiPayload(what.view));
      console.log(`sent: ${SCREENS[what.view.state]}${what.view.text ? ` "${what.view.text}"` : ''}`);
    }
    if (opts.snap) {
      await sleep(DRAW_MS);
      await snapTo(link, opts.snap);
    } else if (what.waitMs !== undefined) {
      await sleep(what.waitMs);
    } else {
      console.log('Keys are printed as they are pressed. Ctrl+C to stop.');
      await new Promise(() => {});
    }
  } finally {
    link.close();
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/dev/png.test.js bridge/test/dev/press.test.js bridge/test/dev/snap.test.js bridge/test/dev/ui.test.js bridge/test/dev/walkie-dev.test.js`
Expected: PASS, 53 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 673 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore bridge/bin/walkie-dev.js bridge/src/dev/args.js bridge/src/dev/png.js bridge/src/dev/press.js bridge/src/dev/snap.js bridge/src/dev/ui.js bridge/test/dev/png.test.js bridge/test/dev/press.test.js bridge/test/dev/snap.test.js bridge/test/dev/ui.test.js bridge/test/dev/walkie-dev.test.js bridge/test/helpers/fake-link.js
git commit -m @'
Task 10: walkie-dev press, ui and snap: the S3's keys and screens from a terminal, and its display as a PNG

press plays a key script on the firmware (TEST KEYS), ui puts a screen or an approval on it as the bridge would, snap reads the display back (TEST SNAP) and writes a PNG; ui and press take --snap to look at what they just did. Mutants: press 17, ui 24, snap 30, png 9, none survive.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
'@
```

---

### Task 11: `inject`: a recording as the S3's microphone

The end-to-end test of spec 9 needs nobody to speak. The firmware's TEST hooks give the S3 a recording as its microphone and hold the front key for as long as it lasts, so a whole voice turn runs with no one there. `injectTake` feeds a 16 kHz recording to the S3 (a lead-in of silence in front, because the first 250 ms of a take are trimmed, and a tail after) and holds the key by a key script; `walkie-dev inject <wav>` shows the take that came back (its levels, and a WAV with `--out`); `walkie --inject <wav>` runs the whole bridge through it with the real speech chain and Claude, and says what became of the utterance (`reply`, `failure`, `handled`, `unclear`, `timeout` or `no-device`). The turn announces `heard` for each ordinary take, with the speech chain's result, and the console prints it, so that a run shows what was understood and where it went.

The recording goes into the S3 four chunks at a time with a 5 ms pause, not all at once. Measured on the real S3 in Task 13: 283 chunks handed to the port at once lost 50 frames (its receive queue is 16 KB), the key script among the likely ones, and a take that never started; four and a pause lost none in 283. That is why the test `the recording is paced into the S3, never more than four chunks without a pause, and the key script comes after the last of them` exists.

**Files:**
- Create: `bridge/src/dev/inject.js`
- Modify: `bridge/bin/walkie-dev.js`, `bridge/bin/walkie.js`, `bridge/src/console.js`, `bridge/src/dev/args.js`, `bridge/src/main.js`, `bridge/src/turn/turn.js`
- Test (new): `bridge/test/dev/inject.test.js`, `bridge/test/helpers/world.js`
- Test (changed): `bridge/test/console.test.js`, `bridge/test/dev/walkie-dev.test.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/main.test.js`, `bridge/test/turn/turn.test.js`, `bridge/test/walkie-bin.test.js`

**Interfaces:**
- Consumes: `testMicSourcePayload`, `testMicPcmPayload`, `testKeysPayload`, `KEY`, `TYPE` (Tasks 1 and plan 1); `decodeWav`, `encodeWav`, `levels` (`bridge/src/audio/wav.js`) and `TakeCollector` (plan 1); `startBridge`'s result (Task 9): `link.ready`, `turn.settled()`, `manager.on('reply' | 'failure')`; `createConsole` (Task 9); `createTurn` (Task 8); the stand-in S3 `FakeS3` (Task 9), which learns the TEST hooks in this task.
- Produces:
  - `bridge/src/dev/inject.js`: `readRecording(file): Buffer` (PCM16 at 16 kHz; any other rate is an error that says how to convert it); `injectTake(link, pcm, {leadInMs = 500, tailMs = 300, sleep}): Promise<{holdMs, chunks}>` (refuses an empty or odd recording and one that does not fit the S3's 16 s FIFO with its lead-in and tail; always gives the microphone back); `runInjected(bridge, pcm, {timeoutMs = 180000, readyMs = 30000, inject = injectTake, ...options}): Promise<{outcome, heard, reply, failure}>` (the time allowed is counted from the end of the injection; it stops listening for what it listened for however it ended); the default export `inject([file], opts, connectFn, {sleep, takeWaitMs})`.
  - `createTurn(...)` now also returns `on(name, listener): () => void`, and emits `'heard'` with `{status: 'ok', transcript, intent, project, text, ...}` or `{status: 'unclear', reason}` for each ordinary take that was heard; a spoken reason for a denial is not one, a cancelled take is not heard, a listener that throws does not stop the take.
  - `createConsole(...)` now also returns `heard(h)`: `[heard] 「words」 → intent project (provider)` or `[heard] nothing clear (reason)`.
  - `walkie --inject file.wav` and `walkie-dev inject <wav> [--out dir]`; `bridge/test/helpers/world.js`: the whole bridge with only the two ends stood in for (the S3 and the providers).

- [ ] **Step 1: Write the failing tests**

Append to the end of `bridge/test/console.test.js`:

```js

test('what was heard is printed with its words and where they go, and a take nobody could hear says why', () => {
  const { con, lines } = make();
  con.heard({ status: 'ok', transcript: '看一下测试', transcribedBy: 'openai', intent: 'to_claude', project: null, text: '看一下测试' });
  con.heard({ status: 'ok', transcript: '切到 walkie', transcribedBy: 'gemini', intent: 'switch_project', project: 'walkie', text: '' });
  con.heard({ status: 'ok', transcript: '你好', transcribedBy: 'openai', intent: null });
  con.heard({ status: 'ok', transcript: '继续', intent: 'continue' }); // no provider named
  con.heard({ status: 'unclear', reason: 'too-short', transcript: '' });
  assert.deepEqual(lines, [
    '09:05:07 [heard] 「看一下测试」 → to_claude (openai)',
    '09:05:07 [heard] 「切到 walkie」 → switch_project walkie (gemini)',
    '09:05:07 [heard] 「你好」 (openai)',
    '09:05:07 [heard] 「继续」 → continue',
    '09:05:07 [heard] nothing clear (too-short)',
  ]);
});
```

Create `bridge/test/dev/inject.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decodeWav, encodeWav } from '../../src/audio/wav.js';
import injectCommand, { injectTake, runInjected } from '../../src/dev/inject.js';
import { FLAG, TYPE } from '../../src/link/frame.js';
import { KEY, TEST_OP, parseTestKeys } from '../../src/link/messages.js';
import { until } from '../helpers/fake-s3.js';
import { fakeLink } from '../helpers/fake-link.js';
import { providers, speechPcm, world } from '../helpers/world.js';
import { tone } from '../../src/audio/tone.js';

const pcmOf = (ms, byte = 5) => Buffer.alloc((ms * 16000 * 2) / 1000, byte);

// What the S3 was sent, as one word per frame, with the pauses in between.
function recorded() {
  const link = fakeLink();
  const order = [];
  const send = link.send;
  link.send = (type, payload, flags) => {
    const op = payload[0];
    order.push(type !== TYPE.TEST ? `type ${type}` : op === TEST_OP.MIC_SOURCE ? `source ${payload[1] ? 'on' : 'off'}` : op === TEST_OP.MIC_PCM ? 'pcm' : op === TEST_OP.KEYS ? 'keys' : `op ${op}`);
    return send(type, payload, flags);
  };
  const sleep = async (ms) => void order.push(`sleep ${ms}`);
  return { link, order, sleep };
}
// The chunks as injectTake paces them: a pause of 5 ms after every fourth.
const paced = (chunks) => Array.from({ length: chunks }, (_, i) => (i % 4 === 3 ? ['pcm', 'sleep 5'] : ['pcm'])).flat();
const pcmSent = (link) => Buffer.concat(link.sent.filter((s) => s.payload[0] === TEST_OP.MIC_PCM).map((s) => s.payload.subarray(1)));

// ---- injectTake ---------------------------------------------------------------------------------------------------------

test('a recording goes in as the microphone: source on, all of it into the FIFO, the front key held for as long as it lasts, source off', async () => {
  const { link, order, sleep } = recorded();
  const { holdMs, chunks } = await injectTake(link, pcmOf(1000), { sleep });
  assert.equal(holdMs, 500 + 1000 + 300);
  assert.equal(chunks, Math.ceil((pcmOf(1800).length) / 640));
  const pcmWords = order.filter((o) => o === 'pcm').length;
  assert.equal(pcmWords, chunks);
  assert.deepEqual(order, ['source off', 'sleep 150', 'source on', ...paced(chunks), 'keys', `sleep ${1800 + 800}`, 'source off']);
});

// Measured on the real S3 (gate I): 283 chunks handed to the link at once lost 50 frames on the way (the S3 counted 83 more
// damaged chunks and 50 sequence gaps), and the first run lost the key script, so no take was ever made. Four chunks and a
// pause of 5 ms in all of them lost none.
test('the recording is paced into the S3, never more than four chunks without a pause, and the key script comes after the last of them', async () => {
  const { link, order, sleep } = recorded();
  await injectTake(link, pcmOf(3000), { sleep });
  let run = 0;
  let longest = 0;
  for (const word of order) {
    run = word === 'pcm' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  assert.ok(longest > 0 && longest <= 4, `${longest} chunks in a row`);
  assert.ok(order.filter((word) => word === 'sleep 5').length >= 40, 'a pause every fourth chunk');
  assert.ok(order.indexOf('keys') > order.lastIndexOf('pcm'), 'the key script is the last thing into the S3');
});

test('the FIFO gets silence for the lead-in, then the recording unchanged, then silence for the tail, in even chunks that fit a frame', async () => {
  const { link, sleep } = recorded();
  const pcm = pcmOf(700, 9);
  await injectTake(link, pcm, { sleep, leadInMs: 200, tailMs: 100 });
  const sent = pcmSent(link);
  assert.deepEqual(sent, Buffer.concat([Buffer.alloc(6400), pcm, Buffer.alloc(3200)]));
  for (const s of link.sent.filter((f) => f.payload[0] === TEST_OP.MIC_PCM)) {
    const n = s.payload.length - 1;
    assert.ok(n >= 2 && n <= 640 && n % 2 === 0, `a chunk of ${n} bytes`);
  }
});

test('the key goes down at once and up when the lead-in, the recording and the tail are over', async () => {
  const { link, sleep } = recorded();
  await injectTake(link, pcmOf(2000), { sleep, leadInMs: 400, tailMs: 250 });
  const keys = link.sent.find((s) => s.payload[0] === TEST_OP.KEYS);
  assert.deepEqual(parseTestKeys(keys.payload).steps, [
    { delayMs: 0, mask: KEY.FRONT },
    { delayMs: 2650, mask: 0 },
  ]);
});

test('what does not fit the S3 is refused before anything is sent: nothing, an odd length, or more than its 16 s FIFO holds', async () => {
  for (const [pcm, pattern] of [
    [Buffer.alloc(0), /PCM16/],
    [Buffer.alloc(3), /PCM16/],
    [pcmOf(15_300), /16 s/],
  ]) {
    const { link, sleep } = recorded();
    await assert.rejects(injectTake(link, pcm, { sleep }), pattern);
    assert.deepEqual(link.sent, []);
  }
  const { link, sleep } = recorded();
  await injectTake(link, pcmOf(15_100), { sleep }); // 15.1 s and the lead-in and tail: 15.9 s
  assert.ok(link.sent.length > 0);
  for (const options of [{ leadInMs: -1 }, { leadInMs: 1.5 }, { tailMs: -1 }]) {
    const fresh = recorded();
    await assert.rejects(injectTake(fresh.link, pcmOf(500), { sleep: fresh.sleep, ...options }), /lead-in|tail/);
    assert.deepEqual(fresh.link.sent, []);
  }
});

test('the microphone is given back even when the script cannot be sent', async () => {
  const { link, order, sleep } = recorded();
  const send = link.send;
  link.send = (type, payload, flags) => {
    if (payload[0] === TEST_OP.KEYS) throw new Error('link is down');
    return send(type, payload, flags);
  };
  await assert.rejects(injectTake(link, pcmOf(500), { sleep }), /link is down/);
  assert.equal(order.at(-1), 'source off');
});

test('through the real link to a device that behaves like the firmware, the bridge gets the recording back as a take', async (t) => {
  const w = await world(t);
  const pcm = pcmOf(100, 7);
  const taken = [];
  w.bridge.link.on('audio-up', (f) => taken.push(f.payload));
  const done = await injectTake(w.bridge.link, pcm, { leadInMs: 40, tailMs: 20 });
  assert.equal(done.holdMs, 160);
  await until(() => w.s3.injected.length === 1, 'the take');
  assert.deepEqual(w.s3.injected[0], Buffer.concat([Buffer.alloc(1280), pcm, Buffer.alloc(640)]));
  await until(() => !w.s3.micSource, 'the microphone to be the real one again');
  await until(() => Buffer.concat(taken).length === w.s3.injected[0].length, 'the take to reach the bridge');
});

// ---- runInjected: what became of the utterance --------------------------------------------------------------------------

const feed = (w) => async () => w.s3.take(speechPcm);

test('a request that Claude answers: the words, the reply, and the voice spoken to the end', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w) });
  assert.equal(run.outcome, 'reply');
  assert.equal(run.heard.transcript, '你好');
  assert.match(run.reply.text, /I heard: 你好/);
  assert.equal(w.s3.audioDown().ended, true, 'it waited for the speech');
  assert.equal(w.spoken.length, 1);
});

test('a take nobody could hear ends the run at once as unclear', async (t) => {
  const w = await world(t, { adapters: [] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 10_000 });
  assert.equal(run.outcome, 'unclear');
  assert.equal(run.heard.status, 'unclear');
  assert.equal(run.reply, null);
});

test('words that were a command for walkie itself are handled without Claude, and what it said is spoken', async (t) => {
  const w = await world(t, { said: ['现在什么状态'], intent: 'status' });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 10_000 });
  assert.equal(run.outcome, 'handled');
  assert.equal(run.heard.intent, 'status');
  assert.equal(w.spoken.length, 1);
  assert.equal(w.s3.audioDown().ended, true);
});

test('Claude that cannot be started is a failure, with what it was', async (t) => {
  const w = await world(t, { said: ['你好'], command: ['walkie-no-such-program-xyz'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 20_000 });
  assert.equal(run.outcome, 'failure');
  assert.ok(run.failure.kind);
  assert.equal(run.reply, null);
});

test('a reply that does not come in time ends the run as a timeout, with what was heard', async (t) => {
  const w = await world(t, { said: ['!sleep 20000'] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 1500 });
  assert.equal(run.outcome, 'timeout');
  assert.equal(run.heard.transcript, '!sleep 20000');
});

test('a take that never reaches the bridge is a timeout too, with nothing heard', async (t) => {
  const w = await world(t);
  const run = await runInjected(w.bridge, speechPcm, { inject: async () => {}, timeoutMs: 300 });
  assert.equal(run.outcome, 'timeout');
  assert.equal(run.heard, null);
});

test('the recording and the options are handed to the injection as they were given', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const seen = [];
  await runInjected(w.bridge, speechPcm, {
    leadInMs: 123,
    inject: async (link, pcm, options) => {
      seen.push([link === w.bridge.link, pcm === speechPcm, options.leadInMs]);
      w.s3.take(speechPcm);
    },
  });
  assert.deepEqual(seen, [[true, true, 123]]);
});

test('a run that is over does not leave its deadline ticking, which would keep the process alive for minutes', async (t) => {
  const w = await world(t, { said: ['你好'] });
  const long = [];
  const cleared = [];
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    const id = set(fn, ms, ...rest);
    if (ms > 90_000 && ms <= 100_000) long.push(id); // the deadline: 100 s less what has gone by
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    cleared.push(id);
    clear(id);
  });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 100_000 });
  assert.equal(run.outcome, 'reply');
  assert.equal(long.length, 1);
  assert.ok(cleared.includes(long[0]));
});

// ---- walkie-dev inject ----------------------------------------------------------------------------------------------------

// A link to a device that gives the recording back as the take, as the firmware does; 'tamper' changes what comes back.
function linkWithMic({ tamper = (pcm) => pcm } = {}) {
  const link = fakeLink();
  let fifo = Buffer.alloc(0);
  link.onSend = (type, payload) => {
    if (payload[0] === TEST_OP.MIC_PCM) fifo = Buffer.concat([fifo, payload.subarray(1)]);
    if (payload[0] === TEST_OP.KEYS) {
      const pcm = tamper(fifo);
      for (let at = 0; at < pcm.length; at += 640) {
        const last = at + 640 >= pcm.length;
        link.emit('audio-up', { type: TYPE.AUDIO_UP, flags: last ? FLAG.EOS : 0, seq: 0, payload: pcm.subarray(at, at + 640) });
      }
    }
  };
  return link;
}

function recordingFile(t, ms = 1000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pcm = Buffer.alloc((ms * 16000 * 2) / 1000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(i === 100 ? 12_000 : (i % 7) * 100, i * 2);
  const file = path.join(dir, 'said.wav');
  writeFileSync(file, encodeWav(pcm, 16000));
  return { dir, file, pcm };
}

test('inject says what it sent and what came back, and that the recording is in the take', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const { file } = recordingFile(t);
  const link = linkWithMic();
  await injectCommand([file], {}, async () => link, { sleep: async () => {} });
  const text = lines.join('\n');
  assert.match(text, /said\.wav: 1\.00 s, peak 12000/);
  assert.match(text, /take: 1\.80 s \(the key was held 1\.80 s\), peak 12000, the recording is in it/);
  assert.equal(link.closed, true);
});

test('a take that does not hold the recording is said so, and the exit code is 1', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const exit = process.exitCode;
  t.after(() => (process.exitCode = exit));
  const { file } = recordingFile(t);
  await injectCommand([file], {}, async () => linkWithMic({ tamper: (pcm) => Buffer.alloc(pcm.length) }), { sleep: async () => {} });
  assert.match(lines.join('\n'), /NOT the recording's peak 12000/);
  assert.equal(process.exitCode, 1);
});

test('--out keeps the take that came back as a WAV', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { dir, file } = recordingFile(t);
  const out = path.join(dir, 'takes', 'here');
  await injectCommand([file], { out }, async () => linkWithMic(), { sleep: async () => {} });
  const [name] = readdirSync(out);
  assert.match(name, /^inject-.*\.wav$/);
  const { rate, pcm } = decodeWav(readFileSync(path.join(out, name)));
  assert.equal(rate, 16000);
  assert.equal(pcm.length, 1800 * 32);
});

test('no take coming back is an error that says where to look, and the link is closed', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { file } = recordingFile(t);
  const link = fakeLink(); // a device that does nothing
  await assert.rejects(injectCommand([file], {}, async () => link, { sleep: async () => {}, takeWaitMs: 30 }), /no take came back within 0\.03 s/);
  assert.equal(link.closed, true);
});

test('a file that is not 16 kHz, or no file, stops inject before it connects', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const slow = path.join(dir, 'slow.wav');
  writeFileSync(slow, encodeWav(Buffer.alloc(3200), 8000));
  let connected = false;
  const connect = async () => (connected = true);
  await assert.rejects(injectCommand([slow], {}, connect), /8000 Hz, the S3 records 16000 Hz/);
  await assert.rejects(injectCommand([], {}, connect), /inject <wav>/);
  assert.equal(connected, false);
});

test('with no S3 answering, nothing is injected and the run says so', async () => {
  const stub = { link: { ready: false }, turn: { on: () => () => {}, settled: async () => {} }, manager: { on: () => () => {} } };
  let injected = false;
  const run = await runInjected(stub, speechPcm, { readyMs: 100, inject: async () => (injected = true) });
  assert.equal(run.outcome, 'no-device');
  assert.equal(injected, false);
});

test('the S3 that answers late is waited for', async () => {
  const stub = { link: { ready: false }, turn: { on: () => () => {}, settled: async () => {} }, manager: { on: () => () => {} } };
  setTimeout(() => (stub.link.ready = true), 100);
  const run = await runInjected(stub, speechPcm, { readyMs: 5000, timeoutMs: 100, inject: async () => {} });
  assert.equal(run.outcome, 'timeout', 'it got as far as injecting and waiting for the words');
});

// ---- more of the edges --------------------------------------------------------------------------------------------------

test('a recording that is not a whole number of milliseconds is held for the part of a millisecond too, not cut short', async () => {
  const { link, sleep } = recorded();
  const { holdMs } = await injectTake(link, Buffer.alloc(100, 3), { sleep, leadInMs: 500, tailMs: 300 }); // 100 bytes are 3.125 ms
  assert.equal(holdMs, 804);
});

test('the FIFO holds 16 s, with the lead-in and the tail in it: exactly 16 s goes in and a millisecond more does not', async () => {
  const fits = recorded();
  assert.equal((await injectTake(fits.link, pcmOf(15_200), { sleep: fits.sleep })).holdMs, 16_000);
  const over = recorded();
  await assert.rejects(injectTake(over.link, pcmOf(15_201), { sleep: over.sleep }), /16 s/);
});

test('words that continue or compact are work for Claude too, and the run waits for its answer', async (t) => {
  for (const intent of ['continue', 'compact']) {
    const w = await world(t, { said: ['好'], intent });
    const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 20_000 });
    assert.ok(run.outcome === 'reply', `${intent}: ${run.outcome}`);
    assert.ok(run.reply, intent);
  }
});

test('the time allowed is counted from the end of the injection, which can itself take a while', async (t) => {
  const w = await world(t, { said: ['现在什么状态'], intent: 'status' });
  const run = await runInjected(w.bridge, speechPcm, {
    timeoutMs: 1500,
    inject: async () => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      w.s3.take(speechPcm);
    },
  });
  assert.equal(run.outcome, 'handled');
});

test('a voice that is still being spoken at the deadline is a timeout, not a reply', async (t) => {
  const [provider] = providers(['你好'], []);
  const slow = {
    ...provider,
    speak: async function* () {
      for (let i = 0; i < 100; i++) {
        yield tone(330, 0.1, 4000);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  const w = await world(t, { adapters: [slow] });
  const run = await runInjected(w.bridge, speechPcm, { inject: feed(w), timeoutMs: 1500 });
  assert.equal(run.outcome, 'timeout');
  assert.ok(run.reply, 'Claude had answered');
});

test('what a run listened for it stops listening for, however it ended', async () => {
  const offs = [];
  const on = () => () => offs.push('off');
  const make = (ready) => ({ link: { ready }, turn: { on, settled: async () => {} }, manager: { on } });
  await runInjected(make(false), speechPcm, { readyMs: 50, inject: async () => {} });
  assert.equal(offs.length, 3, 'no device');
  await runInjected(make(true), speechPcm, { timeoutMs: 50, inject: async () => {} });
  assert.equal(offs.length, 6, 'nothing heard');
  await assert.rejects(runInjected(make(true), speechPcm, { inject: async () => Promise.reject(new Error('link is down')) }), /link is down/);
  assert.equal(offs.length, 9, 'the injection failed');
});

test('inject waits for the take only as long as it was told to', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { file } = recordingFile(t);
  const started = Date.now();
  await assert.rejects(injectCommand([file], {}, async () => fakeLink(), { sleep: async () => {}, takeWaitMs: 30 }), /no take came back/);
  assert.ok(Date.now() - started < 2000, 'not the five seconds of the default');
});
```

In `bridge/test/dev/walkie-dev.test.js`, replace:

```js
test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});
```

with:

```js
test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap', 'inject']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
// A stand-in for the S3 on the serial port, for tests that run the whole bridge. The Link writes frames to it and it answers the
// way walkie's firmware does: HELLO with the nonce echoed, a PONG for every PING, CREDIT for the audio it is sent, and PLAYED when
// a reply ends or is stopped. The test plays the device's own side with take(), button() and answer().
import { EventEmitter } from 'node:events';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { CMD, parseApprovalReq, parseUi } from '../../src/link/messages.js';

const u32 = (v) => {
  const b = Buffer.alloc(4);
```

with:

```js
// A stand-in for the S3 on the serial port, for tests that run the whole bridge. The Link writes frames to it and it answers the
// way walkie's firmware does: HELLO with the nonce echoed, a PONG for every PING, CREDIT for the audio it is sent, and PLAYED when
// a reply ends or is stopped. The test plays the device's own side with take(), button() and answer(). It also does what the
// firmware's TEST hooks do for a recording that is fed in as the microphone: MIC_SOURCE on, MIC_PCM into a FIFO, and KEYS with the
// front key held for a while, which makes a take of that long out of the FIFO (zeros for what has not arrived).
import { EventEmitter } from 'node:events';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { CMD, KEY, TEST_OP, parseApprovalReq, parseTestKeys, parseUi } from '../../src/link/messages.js';

const u32 = (v) => {
  const b = Buffer.alloc(4);
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  #downBytes = 0;
  #ringBytes;
  #version;

  constructor({ ringBytes = 262144, version = '0.0.0-fake' } = {}) {
    super();
```

with:

```js
  #downBytes = 0;
  #ringBytes;
  #version;
  #fifo = Buffer.alloc(0);
  micSource = false; // TEST MIC_SOURCE
  injected = []; // the takes that TEST KEYS made out of the FIFO

  constructor({ ringBytes = 262144, version = '0.0.0-fake' } = {}) {
    super();
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        break;
      default:
    }
  }

  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(0), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
```

with:

```js
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        break;
      case TYPE.TEST:
        this.#test(f.payload);
        break;
      default:
    }
  }

  #test(p) {
    if (p[0] === TEST_OP.MIC_SOURCE) {
      this.micSource = p[1] === 1;
      if (!this.micSource) this.#fifo = Buffer.alloc(0);
    } else if (p[0] === TEST_OP.MIC_PCM) {
      if (this.micSource) this.#fifo = Buffer.concat([this.#fifo, p.subarray(1)]);
    } else if (p[0] === TEST_OP.KEYS) {
      const { steps } = parseTestKeys(p);
      let at = 0;
      let pressedAt = null;
      for (const step of steps) {
        at += step.delayMs;
        if (step.mask & KEY.FRONT) pressedAt ??= at;
        else if (pressedAt !== null) {
          const bytes = ((at - pressedAt) * 16000 * 2) / 1000;
          const pcm = Buffer.concat([this.#fifo.subarray(0, bytes), Buffer.alloc(Math.max(0, bytes - this.#fifo.length))]);
          this.#fifo = this.#fifo.subarray(bytes);
          setTimeout(() => {
            this.injected.push(pcm);
            this.take(pcm);
          }, at - pressedAt);
          pressedAt = null;
        }
      }
    }
  }

  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(0), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
```

Create `bridge/test/helpers/world.js`:

```js
// The whole bridge, with only the two ends stood in for: the S3 (FakeS3, on the real Link) and the speech providers. Claude is
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../../src/main.js';
import { createConsole } from '../../src/console.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { createStateStore } from '../../src/config/state.js';
import { tone } from '../../src/audio/tone.js';
import { FakeS3, until } from './fake-s3.js';

export const FAKE_CLAUDE = join(import.meta.dirname, '..', 'claude', 'fake-claude.js');
export const speechPcm = Buffer.alloc(16000 * 2 * 1.2, 1); // 1.2 s of 16 kHz PCM16: more than the 250 ms that are trimmed and the 300 ms that are needed

// The providers: the transcripts come from `said` one call at a time, every utterance is a request for Claude (or the `intent`
// given), and every reply is a short tone, with the text it was asked to say written down in `spoken`.
export function providers(said, spoken, { intent = 'to_claude' } = {}) {
  return [
    {
      name: 'openai',
      limits: { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: 3000, speakIdleMs: 3000, hearMs: 8000 },
      transcribe: async () => said.shift() ?? '',
      classify: async (text) => JSON.stringify({ intent, project: null, text }),
      speak: async function* (text) {
        spoken.push(text);
        yield tone(330, 0.3, 4000);
      },
    },
  ];
}

// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const s3 = new FakeS3();
  const lines = [];
  const spoken = [];
  const store = createStateStore({ file: null });
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command, prewarm: false, approvalTimeoutSec } },
    projects: [{ name: 'proj', aliases: [], path: project }],
    adapters: adapters ?? providers(said, spoken, { intent }),
    openPort: openPort ?? (async () => s3),
    store,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: join(dir, 'sessions') }) },
    console: createConsole({ out: (line) => lines.push(line) }),
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => bridge.link.ready, 'the S3 to answer HELLO');
  const shown = (state) => s3.screens().find((s) => s.state === state);
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order };
}
```

In `bridge/test/main.test.js`, replace:

```js
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../src/main.js';
import { createConsole } from '../src/console.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
```

with:

```js
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { startBridge } from '../src/main.js';
import { createConsole } from '../src/console.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
```

In `bridge/test/main.test.js`, replace:

```js
import { SAY_AGAIN } from '../src/turn/turn.js';
import { tone } from '../src/audio/tone.js';
import { FakeS3, until } from './helpers/fake-s3.js';

const FAKE_CLAUDE = join(import.meta.dirname, 'claude', 'fake-claude.js');
const speechPcm = Buffer.alloc(16000 * 2 * 1.2, 1); // 1.2 s of 16 kHz PCM16: more than the 250 ms that are trimmed and the 300 ms that are needed

// The providers: the transcripts come from `said` one call at a time, every utterance is a request for Claude, and every
// reply is a short tone, with the text it was asked to say written down in `spoken`.
function providers(said, spoken) {
  return [
    {
      name: 'openai',
      limits: { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: 3000, speakIdleMs: 3000, hearMs: 8000 },
      transcribe: async () => said.shift() ?? '',
      classify: async (text) => JSON.stringify({ intent: 'to_claude', project: null, text }),
      speak: async function* (text) {
        spoken.push(text);
        yield tone(330, 0.3, 4000);
      },
    },
  ];
}

async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const s3 = new FakeS3();
  const lines = [];
  const spoken = [];
  const store = createStateStore({ file: null });
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command: [process.execPath, FAKE_CLAUDE], prewarm: false, approvalTimeoutSec } },
    projects: [{ name: 'proj', aliases: [], path: project }],
    adapters: adapters ?? providers(said, spoken),
    openPort: openPort ?? (async () => s3),
    store,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: join(dir, 'sessions') }) },
    console: createConsole({ out: (line) => lines.push(line) }),
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => bridge.link.ready, 'the S3 to answer HELLO');
  const shown = (state) => s3.screens().find((s) => s.state === state);
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order };
}

test('a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'] });
```

with:

```js
import { SAY_AGAIN } from '../src/turn/turn.js';
import { tone } from '../src/audio/tone.js';
import { FakeS3, until } from './helpers/fake-s3.js';
import { FAKE_CLAUDE, providers, speechPcm, world } from './helpers/world.js';

test('a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'] });
```

In `bridge/test/main.test.js`, replace:

```js
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.equal(w.shown(UI_STATE.CONFIRM).text, '你好');
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  assert.equal(w.shown(UI_STATE.REPLY).project, 'proj');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
```

with:

```js
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.equal(w.shown(UI_STATE.CONFIRM).text, '你好');
  assert.ok(w.lines.some((l) => l.endsWith('[heard] 「你好」 → to_claude (openai)')), 'the console says what was heard');
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  assert.equal(w.shown(UI_STATE.REPLY).project, 'proj');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
```

In `bridge/test/main.test.js`, replace:

```js
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.ERROR), 'the error screen');
  assert.equal(w.shown(UI_STATE.ERROR).text, SAY_AGAIN);
  assert.equal(w.lines.some((l) => l.includes('[working]')), false);
});

test('with no S3 on USB the bridge runs on, says so once, and closes cleanly', async (t) => {
```

with:

```js
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.ERROR), 'the error screen');
  assert.equal(w.shown(UI_STATE.ERROR).text, SAY_AGAIN);
  assert.equal(w.lines.some((l) => l.includes('[working]')), false);
  assert.ok(w.lines.some((l) => l.includes('[heard] nothing clear')), 'the console says nothing was clear');
});

test('with no S3 on USB the bridge runs on, says so once, and closes cleanly', async (t) => {
```

Append to the end of `bridge/test/turn/turn.test.js`:

```js

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
```

In `bridge/test/walkie-bin.test.js`, replace:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/walkie.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./claude/fake-claude.js', import.meta.url));
```

with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '../src/audio/wav.js';

const BIN = fileURLToPath(new URL('../bin/walkie.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./claude/fake-claude.js', import.meta.url));
```

In `bridge/test/walkie-bin.test.js`, replace:

```js
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

with:

```js
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('--inject with a file that is missing or not 16 kHz stops it before anything is started', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-inject-'));
  try {
    const slow = path.join(dir, 'slow.wav');
    writeFileSync(slow, encodeWav(Buffer.alloc(3200), 8000));
    for (const [file, pattern] of [[path.join(dir, 'nope.wav'), /ENOENT/], [slow, /8000 Hz, the S3 records 16000 Hz/]]) {
      const r = run('--inject', file);
      assert.equal(r.status, 1, file);
      assert.match(r.err, pattern, file);
      assert.ok(!r.out.includes('[walkie]') && !r.out.includes('[keys]'), 'it never got as far as starting');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/console.test.js bridge/test/dev/inject.test.js bridge/test/dev/walkie-dev.test.js bridge/test/main.test.js bridge/test/turn/turn.test.js bridge/test/walkie-bin.test.js`
Expected: FAIL, the test file cannot load: `Cannot find module 'bridge/src/dev/inject.js'`; 11 failures in all.

- [ ] **Step 3: Write the implementation**

In `bridge/bin/walkie-dev.js`, replace:

```js
  press <script> [--snap file.png]   press the S3's keys from the firmware: front:600 side:1100 both:3200 wait:300 down:front up:front
  ui <idle|transcribing|confirm|working|reply|error> [text...] [--project name] [--elapsed secs] [--secs n | --snap file.png]
  ui approval <tool> <preview...> [--secs n | --snap file.png]   show a screen, or a request for a yes or no, as the bridge would
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
```

with:

```js
  press <script> [--snap file.png]   press the S3's keys from the firmware: front:600 side:1100 both:3200 wait:300 down:front up:front
  ui <idle|transcribing|confirm|working|reply|error> [text...] [--project name] [--elapsed secs] [--secs n | --snap file.png]
  ui approval <tool> <preview...> [--secs n | --snap file.png]   show a screen, or a request for a yes or no, as the bridge would
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)
  inject <wav> [--out dir]   feed a 16 kHz recording to the S3 as its microphone and print the take that comes back`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
```

In `bridge/bin/walkie-dev.js`, replace:

```js
  press: () => import('../src/dev/press.js'),
  ui: () => import('../src/dev/ui.js'),
  snap: () => import('../src/dev/snap.js'),
};

let parsed;
```

with:

```js
  press: () => import('../src/dev/press.js'),
  ui: () => import('../src/dev/ui.js'),
  snap: () => import('../src/dev/snap.js'),
  inject: () => import('../src/dev/inject.js'),
};

let parsed;
```

Replace the whole of `bridge/bin/walkie.js` with:

```js
#!/usr/bin/env node
// walkie: the bridge between the S3 and Claude Code. It runs until Ctrl+C.
import { loadConfig } from '../src/config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../src/config/keys.js';
import { loadProjects } from '../src/config/projects.js';
import { createConsole } from '../src/console.js';
import { parseArgs, UsageError } from '../src/dev/args.js';
import { cleanEnv, commandFrom } from '../src/dev/claude.js';
import { portOpener } from '../src/dev/connect.js';
import { readRecording, runInjected } from '../src/dev/inject.js';
import { startBridge } from '../src/main.js';
import { createAdapters } from '../src/speech/speech.js';

const USAGE = `usage: node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env] [--inject file.wav]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
  whose keys are in %APPDATA%\\walkie\\keys.env. With no S3 plugged in it waits and connects when one appears.
  --port COMx       the S3's serial port (default: the one with USB id 303A:1001)
  --command json    the program and its leading arguments as a JSON array, for a stand-in for claude: '["node","fake-claude.js"]'
  --clean-env       claude is given the environment without CLAUDE* and ANTHROPIC* variables; needed inside the Claude app's
                    own shell, whose variables point a nested claude at the app instead of at the login
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
                    it was said, wait for the whole turn (speech, Claude, the reply spoken) and stop. Calls the speech APIs
                    and runs the real claude. Exit code 0 when Claude replied or the words were a command for walkie.`;

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
  const words = [parsed.name, ...parsed.args].filter((w) => w !== undefined);
  if (words.some((w) => w !== '--clean-env')) throw new UsageError(`${words.find((w) => w !== '--clean-env')} is not something walkie takes`);
  parsed.cleanEnv = words.includes('--clean-env');
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`walkie: ${err.message}`);
  console.log(USAGE);
  process.exit(2); // before any key is loaded or any port opened
}
const { opts } = parsed;

let injected = null;
if (opts.inject) {
  try {
    injected = readRecording(opts.inject);
  } catch (err) {
    console.error(err.message);
    process.exit(1); // before anything is started
  }
}

let bridge;
try {
  const con = createConsole();
  const config = loadConfig();
  const keys = loadKeys();
  con.log(`[keys] ${describeKeys(keys)}`);
  const why = whyKeysMissing(keys);
  if (why) con.log(`[keys] ${why}`);
  const projects = loadProjects();
  const settings = { ...config, claude: { ...config.claude, ...(opts.command ? { command: commandFrom(opts.command) } : {}) } };
  bridge = await startBridge({
    config: settings,
    projects,
    adapters: createAdapters({ keys, config }),
    openPort: portOpener(opts.port),
    console: con,
    env: parsed.cleanEnv ? cleanEnv(process.env) : process.env,
  });
  con.log(`[walkie] ${projects.length} project${projects.length === 1 ? '' : 's'}, active ${bridge.manager.project()}; waiting for the S3. Ctrl+C to stop.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (injected) {
  bridge.console.log(`[inject] feeding ${opts.inject} to the S3 as its microphone`);
  runInjected(bridge, injected).then(
    (run) => {
      bridge.console.log(`[inject] ${run.outcome}`);
      process.exitCode = run.outcome === 'reply' || run.outcome === 'handled' ? 0 : 1;
      stop('inject finished');
    },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
      stop('inject failed');
    },
  );
}

let stopping = false;
function stop(signal) {
  if (stopping) process.exit(130); // a second Ctrl+C does not wait
  stopping = true;
  bridge.console.log(`[walkie] ${signal}: closing`);
  bridge
    .close()
    .catch((err) => console.error(err.message))
    .finally(() => setTimeout(() => process.exit(), 1000).unref()); // process.exit() right after a fetch can trip a libuv assertion on Node 24 for Windows; this ends when the loop empties
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
```

In `bridge/src/console.js`, replace:

```js
    for (const line of indent(r.text || r.screen)) out(line);
  }

  // Prints what the manager, the approvals queue and the link say. `manager` and `approvals` have `on(name, fn)`; `link` is an
  // EventEmitter.
  function attach({ manager, approvals, link }) {
```

with:

```js
    for (const line of indent(r.text || r.screen)) out(line);
  }

  // What the speech chain made of a take (the turn's 'heard' event): the words and where they go, or why there were none.
  function heard(h) {
    if (h.status !== 'ok') return log(`[heard] nothing clear (${h.reason})`);
    const goes = h.intent ? ` → ${h.intent}${h.project ? ` ${h.project}` : ''}` : '';
    log(`[heard] 「${h.transcript}」${goes}${h.transcribedBy ? ` (${h.transcribedBy})` : ''}`);
  }

  // Prints what the manager, the approvals queue and the link say. `manager` and `approvals` have `on(name, fn)`; `link` is an
  // EventEmitter.
  function attach({ manager, approvals, link }) {
```

In `bridge/src/console.js`, replace:

```js
    link.on('down', (reason) => log(`[link] down: ${reason}`));
  }

  return { log, reply, attach };
}
```

with:

```js
    link.on('down', (reason) => log(`[link] down: ${reason}`));
  }

  return { log, reply, heard, attach };
}
```

Replace the whole of `bridge/src/dev/args.js` with:

```js
// The command line of walkie-dev.js: <command> [arguments] [--flag value]... A flag that is misspelled, has no value or is
// given twice is an error, never a silent default: a `--provider=openai` that quietly meant "auto" could send a
// recording to a provider nobody agreed to.
export class UsageError extends Error {}

const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider', '--cwd', '--project', '--command', '--elapsed', '--snap', '--inject'];
const SWITCHES = ['--all', '--clean-env']; // stay among the arguments, for the command that reads them
const FLAG_LIKE = /^--[A-Za-z][\w-]*(=|$)/; // anything else that starts with -- is text

export function parseArgs(argv) {
  const rest = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAG_LIKE.test(arg) || SWITCHES.includes(arg)) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq); // what follows an equals sign is never repeated: it may be a key
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const name = flag.slice(2);
    if (name in opts) throw new UsageError(`${flag} was given twice`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || FLAG_LIKE.test(value)) throw new UsageError(`${flag} needs a value`);
    opts[name] = value;
  }
  const [name, ...args] = rest;
  return { name, args, opts };
}
```

Create `bridge/src/dev/inject.js`:

```js
// A recording fed to the S3 as its microphone, so that a whole voice turn can be run with nobody speaking: the firmware's TEST
// hooks make the front key go down and give it the recording instead of the mic (spec 7).
//   walkie-dev inject <wav> [--out dir]    the take comes back to this terminal as a talk-key take would: its levels, and a WAV
//   walkie --inject <wav>                  the same take goes through the whole bridge: speech, Claude, the reply spoken
// The WAV is 16 kHz mono PCM16, like the ones `listen` saves.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TakeCollector } from '../audio/takes.js';
import { decodeWav, encodeWav, levels } from '../audio/wav.js';
import { TYPE } from '../link/frame.js';
import { KEY, testKeysPayload, testMicPcmPayload, testMicSourcePayload } from '../link/messages.js';
import { connect } from './connect.js';

const BYTES_PER_MS = 32; // 16 kHz PCM16
const CHUNK_BYTES = 640; // 20 ms, what the S3 takes from the FIFO at a time
const MAX_HOLD_MS = 16_000; // the FIFO holds 2^19 bytes: 16.4 s
const CLEAR_MS = 150; // the S3 empties the FIFO when the source goes off, in its audio task, a moment later
const SETTLE_MS = 800; // after the key is up, for the take to end before the source is switched back
// The S3 cannot take the recording as fast as the port can carry it (gate I: 283 chunks at once lost 50 frames, the key script
// among the likely ones, and with it the whole take), so four chunks go in and then a pause: no frame lost in 283 that way.
const PACE_CHUNKS = 4;
const PACE_MS = 5;
const TAKE_WAIT_MS = 5000;
const WORKS_FOR_CLAUDE = new Set(['to_claude', 'continue', 'compact']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The recording in `file`, as PCM16 at 16 kHz; anything else is an error that says what to do about it.
export function readRecording(file) {
  const { rate, pcm } = decodeWav(readFileSync(file));
  if (rate !== 16000) throw new Error(`${file} is ${rate} Hz, the S3 records 16000 Hz (ffmpeg -i in.wav -ac 1 -ar 16000 out.wav)`);
  return pcm;
}

// Feeds `pcm` (PCM16 at 16 kHz) to the S3 as the mic and holds the front key for as long as it lasts, with `leadInMs` of silence
// in front (the first moments of a take are trimmed away) and `tailMs` after. The recording goes into the FIFO first, all of it
// (paced, see PACE_CHUNKS), and then the key goes down: the S3 reads it at the mic's pace, so the timing is the firmware's. Resolves when the key is up and
// the microphone is the real one again: {holdMs, chunks}.
export async function injectTake(link, pcm, { leadInMs = 500, tailMs = 300, sleep = defaultSleep } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2) throw new RangeError('the recording must be PCM16: a whole number of 16-bit samples, and not none');
  if (!Number.isInteger(leadInMs) || leadInMs < 0) throw new RangeError(`the lead-in must be whole milliseconds, not ${leadInMs}`);
  if (!Number.isInteger(tailMs) || tailMs < 0) throw new RangeError(`the tail must be whole milliseconds, not ${tailMs}`);
  const stream = Buffer.concat([Buffer.alloc(leadInMs * BYTES_PER_MS), pcm, Buffer.alloc(tailMs * BYTES_PER_MS)]);
  const holdMs = Math.ceil(stream.length / BYTES_PER_MS);
  if (holdMs > MAX_HOLD_MS) throw new RangeError(`a take of ${(holdMs / 1000).toFixed(1)} s (with the lead-in and the tail) does not fit the S3's 16 s test FIFO`);
  let chunks = 0;
  try {
    link.send(TYPE.TEST, testMicSourcePayload(false)); // so that nothing is left in the FIFO from before
    await sleep(CLEAR_MS);
    link.send(TYPE.TEST, testMicSourcePayload(true));
    for (let at = 0; at < stream.length; at += CHUNK_BYTES) {
      link.send(TYPE.TEST, testMicPcmPayload(stream.subarray(at, at + CHUNK_BYTES)));
      chunks++;
      if (chunks % PACE_CHUNKS === 0) await sleep(PACE_MS);
    }
    link.send(TYPE.TEST, testKeysPayload([{ delayMs: 0, mask: KEY.FRONT }, { delayMs: holdMs, mask: 0 }]));
    await sleep(holdMs + SETTLE_MS);
  } finally {
    try {
      link.send(TYPE.TEST, testMicSourcePayload(false));
    } catch {
      // the link is gone, and with it the S3's test mode
    }
  }
  return { holdMs, chunks };
}

const poll = async (check, deadline) => {
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await defaultSleep(25);
  }
  return true;
};

// Runs the bridge through one injected utterance and says what became of it. `bridge` is startBridge's result; the rest of the
// options go to the injection. Resolves {outcome, heard, reply, failure}; outcome is one of
//   reply      Claude answered, and the voice was spoken to the end
//   failure    Claude could not answer (failure says why)
//   handled    the words were a command for walkie itself, and what it said was spoken
//   unclear    the speech chain could not make anything of the take
//   timeout    something did not happen within `timeoutMs` (counted from the end of the injection): the take never arrived, or
//              Claude was still at it
//   no-device  the S3 did not answer HELLO within `readyMs`, so nothing was injected
export async function runInjected(bridge, pcm, { timeoutMs = 180_000, readyMs = 30_000, inject = injectTake, ...options } = {}) {
  const found = { heard: null, reply: null, failure: null };
  const offs = [
    bridge.turn.on('heard', (h) => (found.heard = found.heard ?? h)),
    bridge.manager.on('reply', (r) => (found.reply = r)),
    bridge.manager.on('failure', (f) => (found.failure = f)),
  ];
  const result = (outcome) => ({ outcome, ...found });
  try {
    if (!(await poll(() => bridge.link.ready, Date.now() + readyMs))) return result('no-device');
    await inject(bridge.link, pcm, options);
    const deadline = Date.now() + timeoutMs;
    if (!(await poll(() => found.heard, deadline))) return result('timeout');
    if (found.heard.status !== 'ok') return result('unclear');
    if (WORKS_FOR_CLAUDE.has(found.heard.intent) && !(await poll(() => found.reply || found.failure, deadline))) return result('timeout');
    let expire;
    const expired = new Promise((resolve) => (expire = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))));
    const spoken = await Promise.race([bridge.turn.settled().then(() => true), expired]);
    clearTimeout(expire); // or the run would last until the deadline, with nothing left to do
    if (!spoken) return result('timeout');
    return result(found.reply ? 'reply' : found.failure ? 'failure' : 'handled');
  } finally {
    for (const off of offs) off();
  }
}

// connectFn, sleep and takeWaitMs are for tests.
export default async function inject([file], opts, connectFn = connect, { sleep = defaultSleep, takeWaitMs = TAKE_WAIT_MS } = {}) {
  if (!file) throw new Error('inject <wav> [--out dir]: a 16 kHz mono PCM16 WAV');
  const pcm = readRecording(file);
  const link = await connectFn(opts);
  try {
    const takes = new TakeCollector();
    const back = new Promise((resolve) => {
      link.on('audio-up', (f) => {
        const take = takes.push(f);
        if (take) resolve(take);
      });
    });
    const sent = levels(pcm, 16000);
    console.log(`${file}: ${(sent.durationMs / 1000).toFixed(2)} s, peak ${sent.peak}`);
    const { holdMs } = await injectTake(link, pcm, { sleep });
    const take = await Promise.race([back, defaultSleep(takeWaitMs).then(() => null)]);
    if (!take) throw new Error(`no take came back within ${takeWaitMs / 1000} s of the key going up: is the S3 running walkie with the TEST hooks?`);
    const l = levels(take, 16000);
    console.log(`take: ${(l.durationMs / 1000).toFixed(2)} s (the key was held ${(holdMs / 1000).toFixed(2)} s), peak ${l.peak}${l.peak === sent.peak ? ', the recording is in it' : ` - NOT the recording's peak ${sent.peak}`}`);
    if (opts.out) {
      mkdirSync(path.resolve(opts.out), { recursive: true });
      const saved = path.join(opts.out, `inject-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
      writeFileSync(saved, encodeWav(take, 16000));
      console.log(`saved ${saved}`);
    }
    if (l.peak !== sent.peak) process.exitCode = 1;
  } finally {
    link.close();
  }
}
```

In `bridge/src/main.js`, replace:

```js
    ui = createUi({ link, log: con.log });
    turn = createTurn({ link, speech, manager, approvals, ui, log: con.log, ...turnOptions });
    con.attach({ manager, approvals, link });
    await link.start();
    manager.start();
  } catch (err) {
```

with:

```js
    ui = createUi({ link, log: con.log });
    turn = createTurn({ link, speech, manager, approvals, ui, log: con.log, ...turnOptions });
    con.attach({ manager, approvals, link });
    turn.on('heard', con.heard);
    await link.start();
    manager.start();
  } catch (err) {
```

In `bridge/src/turn/turn.js`, replace:

```js
//   the manager WORKING, REPLY (and the voice), ERROR, IDLE
//   approvals   the APPROVAL screen; the keys answer it, and a held front key adds a spoken reason to a denial
//
// Takes are heard one at a time, in the order they were made. A reply that is being spoken ends when he starts to talk, and
// one that comes in while he talks waits for him to finish: the mic would hear it.
import { TakeCollector } from '../audio/takes.js';
import { UI_STATE } from '../link/messages.js';
import { isAbort } from '../speech/errors.js';
```

with:

```js
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
```

In `bridge/src/turn/turn.js`, replace:

```js
// for a yes. ui: createUi over the same link. `sleep` and `now` are the clocks; `tone` is the sound for a reply that has no voice.
export function createTurn({ link, speech, manager, approvals, ui, log = () => {}, now = () => Date.now(), sleep = sleepMs, confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, tone = failureTone }) {
  const collector = new TakeCollector();
  const life = new AbortController(); // close() ends everything that is waiting
  const work = { busy: false, tool: null, summary: '', startedAt: 0 }; // what Claude is doing, for the WORKING screen
  let shown = 'idle'; // what this module last put on the screen: idle | transcribing | confirm | working | reply | error
```

with:

```js
// for a yes. ui: createUi over the same link. `sleep` and `now` are the clocks; `tone` is the sound for a reply that has no voice.
export function createTurn({ link, speech, manager, approvals, ui, log = () => {}, now = () => Date.now(), sleep = sleepMs, confirmMs = 1000, unclearMs = 2000, reasonWaitMs = 10_000, tone = failureTone }) {
  const collector = new TakeCollector();
  const events = new EventEmitter();
  const life = new AbortController(); // close() ends everything that is waiting
  const work = { busy: false, tool: null, summary: '', startedAt: 0 }; // what Claude is doing, for the WORKING screen
  let shown = 'idle'; // what this module last put on the screen: idle | transcribing | confirm | working | reply | error
```

In `bridge/src/turn/turn.js`, replace:

```js
  const reasons = new Map(); // approval id -> {text}: a spoken reason; text is null while it is being transcribed
  const verdicts = new Map(); // approval id -> {ctl}: a denial that waits for its spoken reason
  const closed = () => life.signal.aborted;

  // ---- the screen

```

with:

```js
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

```

In `bridge/src/turn/turn.js`, replace:

```js
          window = sleep(confirmMs, ctl.signal);
        },
      });
      if (heard.status !== 'ok') return unclear();
      await window;
      if (ctl.signal.aborted) return cancelled();
```

with:

```js
          window = sleep(confirmMs, ctl.signal);
        },
      });
      tell('heard', heard);
      if (heard.status !== 'ok') return unclear();
      await window;
      if (ctl.signal.aborted) return cancelled();
```

In `bridge/src/turn/turn.js`, replace:

```js
    } catch (err) {
      if (isAbort(err)) return cancelled();
      log(`turn: ${err?.message ?? err}`);
      unclear();
    } finally {
      life.signal.removeEventListener('abort', onLife);
```

with:

```js
    } catch (err) {
      if (isAbort(err)) return cancelled();
      log(`turn: ${err?.message ?? err}`);
      tell('heard', { status: 'unclear', reason: 'failed', transcript: '' });
      unclear();
    } finally {
      life.signal.removeEventListener('abort', onLife);
```

In `bridge/src/turn/turn.js`, replace:

```js

  return {
    settled,
    // Ends the take that is being heard and the speech, and resolves when they have let go.
    async close() {
      life.abort();
```

with:

```js

  return {
    settled,
    on(name, fn) {
      events.on(name, fn);
      return () => events.off(name, fn);
    },
    // Ends the take that is being heard and the speech, and resolves when they have let go.
    async close() {
      life.abort();
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/console.test.js bridge/test/dev/inject.test.js bridge/test/dev/walkie-dev.test.js bridge/test/main.test.js bridge/test/turn/turn.test.js bridge/test/walkie-bin.test.js`
Expected: PASS, 120 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 709 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie-dev.js bridge/bin/walkie.js bridge/src/console.js bridge/src/dev/args.js bridge/src/dev/inject.js bridge/src/main.js bridge/src/turn/turn.js bridge/test/console.test.js bridge/test/dev/inject.test.js bridge/test/dev/walkie-dev.test.js bridge/test/helpers/fake-s3.js bridge/test/helpers/world.js bridge/test/main.test.js bridge/test/turn/turn.test.js bridge/test/walkie-bin.test.js
git commit -m @'
Task 11: inject: a recording as the S3's microphone, walkie-dev inject and walkie with a recording, and the turn's heard event

The firmware's TEST hooks feed a 16 kHz WAV to the S3 as its mic and hold the front key for as long as it lasts, so a whole voice
turn runs with nobody speaking. runInjected drives startBridge through one utterance and says what became of it (reply, failure,
handled, unclear, timeout, no-device). The turn emits 'heard' for each ordinary take and the console prints it.

The recording goes into the S3 four chunks at a time with a 5 ms pause, not all at once: on the real S3 283 chunks handed to the
port at once lost 50 frames (the S3's receive queue is 16 KB), the key script among the likely ones, and a take that never started.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
'@
```

---

### Task 12: Gate H on the real S3, and what it found

The first time the firmware of Tasks 2 to 6 meets the hardware. `tools/gate-h.mjs` is a list of eleven scenes that need no one at the device and no API: each puts a screen on the S3 as the bridge would, presses keys with TEST KEYS, and checks what comes back (the buttons, the approval verdicts, the take's frames, the S3's own LOG lines) or what the display shows (TEST SNAP). It found three things, and this task is those three fixes and the gate itself:

1. **The snapshot had red and blue swapped.** M5GFX calls its 24-bit type `bgr888_t` but lays it out r, g, b; the header colours read back wrong until the readback was taken as r, g, b.
2. **The S3 stayed on its OFFLINE screen for a second after the bridge connected**, because the `Link`'s first PING came on its next tick, not with the HELLO answer. The first PING now goes out at once.
3. **About one snapshot in twenty loses a chunk of its 68.** One S3-to-PC frame of about 1 KB in a thousand arrives damaged; it is not rate dependent (half the rate lost as often) and the TX ring is not full, and the cause was not found. `takeSnap` therefore asks for the screen again, up to three times, when chunks are missing; a snapshot that arrives whole but wrong is an error at once.

Steps 1 to 6 are code and need no S3. Step 7 flashes the S3 and runs the gate, and needs his yes.

**Files:**
- Create: `tools/gate-h.mjs`
- Modify: `bridge/src/dev/snap.js`, `bridge/src/link/link.js`, `firmware/src/main.cpp`, `firmware/src/screen.cpp`
- Test (changed): `bridge/test/dev/snap.test.js`, `bridge/test/link/link.test.js`

**Interfaces:**
- Consumes: `takeSnap(link, {timeoutMs})` and `snapTo` (Task 10); `Link`'s `'hello'` handling and `#ping()` (plan 1); `screen::snapNext` (Task 6); `connect`, `FLAG`, `TYPE`, `BUTTON`, `KEY`, `UI_STATE`, `uiPayload`, `approvalReqPayload`, `testKeysPayload`, `parseButton`, `parseApprovalRes` (earlier tasks); `tools/flash.mjs` and `tools/boot.mjs` (plan 1).
- Produces:
  - `takeSnap(link, {timeoutMs = 3000, attempts = 3})`: asks again when the picture did not come whole in time, and says how much came when the last attempt fails.
  - The `Link` pings at once when the S3's HELLO answer makes it ready.
  - `tools/gate-h.mjs [--port COMx] [--only "scene;scene"]`: prints `PASS <scene>` or `FAIL <scene>: <what is wrong>` and the S3's own log lines for each scene, then `gate H: every scene held`; exit code 0 when every scene held, 1 when one did not.

- [ ] **Step 1: Write the failing tests**

Append to the end of `bridge/test/dev/snap.test.js`:

```js

// ---- a chunk lost on the way: at gate H about one snapshot in twenty lost one to a frame that arrived damaged -------------------

// A link that answers the n-th request with the screen minus the chunks whose indexes are in lost[n] (all of it once the list is used up).
function lossyLink(lost) {
  const link = fakeLink();
  let request = 0;
  link.onSend = () => {
    const drop = lost[request++] ?? [];
    for (const f of snapFrames(8, 8, () => GREEN)) {
      if (!drop.includes(parseSnapChunk(f.payload).index)) link.emit('frame', f);
    }
  };
  return link;
}

test('a chunk lost on the way is not the end of the picture: the screen is asked for again', async () => {
  const link = lossyLink([[2]]);
  const shot = await takeSnap(link, { timeoutMs: 50 });
  assert.equal(link.sent.length, 2);
  assert.deepEqual([shot.width, shot.height], [8, 8]);
  assert.deepEqual([...shot.rgb.subarray(0, 3)], [0, 255, 0]);
  assert.equal(link.listenerCount('frame'), 0);
});

test('a screen that never comes whole is asked for three times, and then the error says how much came', async () => {
  const link = lossyLink([[1], [1], [1], [1]]);
  await assert.rejects(takeSnap(link, { timeoutMs: 20 }), /3 of 4 snapshot chunks within 0\.02 s/);
  assert.equal(link.sent.length, 3);
  assert.equal(link.listenerCount('frame'), 0);
});

test('attempts says how many times to ask', async () => {
  const once = lossyLink([[0], [0]]);
  await assert.rejects(takeSnap(once, { timeoutMs: 20, attempts: 1 }), /3 of 4/);
  assert.equal(once.sent.length, 1);
  const thrice = lossyLink([[0], [0], []]);
  await takeSnap(thrice, { timeoutMs: 20, attempts: 3 });
  assert.equal(thrice.sent.length, 3);
});

test('a screen that arrived whole but wrong is an error at once, not a reason to ask again', async () => {
  const link = fakeLink();
  link.onSend = () => {
    for (const f of snapFrames(4, 4, () => RED)) {
      f.payload.writeUInt16LE(9, 5);
      link.emit('frame', f);
    }
  };
  await assert.rejects(takeSnap(link, { timeoutMs: 1000 }), /pixel bytes/);
  assert.equal(link.sent.length, 1);
});

test('snapTo asks again for a lost chunk too, and writes the picture', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = lossyLink([[3]]);
  const file = await snapTo(link, path.join(dir, 'lossy.png'), { timeoutMs: 50 });
  assert.deepEqual(pngSize(file), [8, 8]);
  assert.equal(link.sent.length, 2);
});
```

In `bridge/test/link/link.test.js`, replace:

```js
  assert.equal(link.ready, true);
  assert.equal(hello.version, '0.1.0');
  assert.deepEqual(logs, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING]);
});

test('a second answer to the same HELLO starts credit over, as the S3 did', async (t) => {
```

with:

```js
  assert.equal(link.ready, true);
  assert.equal(hello.version, '0.1.0');
  assert.deepEqual(logs, []);
  // The first PING goes with the answer, not a second later: until the S3 has had one it shows its offline screen.
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING]);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING, TYPE.PING]);
});

test('a second answer to the same HELLO starts credit over, as the S3 did', async (t) => {
```

In `bridge/test/link/link.test.js`, replace:

```js
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO]);
});

test('the S3 restarting during a reply fails it, clears credit and shakes hands again', async (t) => {
```

with:

```js
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.PING]); // the S3 was told nothing about audio
});

test('the S3 restarting during a reply fails it, clears credit and shakes hands again', async (t) => {
```

In `bridge/test/link/link.test.js`, replace:

```js
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  await settle();
  assert.equal(src.state.returned, true);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO]);
});

test('stopping a reply that is playing sends STOP_AUDIO and an EOS, and lets go of the source', { timeout: 2000 }, async (t) => {
```

with:

```js
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  await settle();
  assert.equal(src.state.returned, true);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.PING]); // the S3 was told nothing about audio
});

test('stopping a reply that is playing sends STOP_AUDIO and an EOS, and lets go of the source', { timeout: 2000 }, async (t) => {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/dev/snap.test.js bridge/test/link/link.test.js`
Expected: FAIL, 7 tests fail: `a chunk lost on the way is not the end of the picture: the screen is asked for again`, `a screen that never comes whole is asked for three times, and then the error says how much came`, `attempts says how many times to ask`, `snapTo asks again for a lost chunk too, and writes the picture`, and 3 more.

- [ ] **Step 3: Write the implementation**

In `bridge/src/dev/snap.js`, replace:

```js
import { encodePng } from './png.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../snaps/', import.meta.url));
const SNAP_TIMEOUT_MS = 5000;

// Five-bit and six-bit channels spread over 0..255 (the top bits repeated in the bottom), so that full is 255 and not 248.
const spread5 = (v) => (v << 3) | (v >> 2);
```

with:

```js
import { encodePng } from './png.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../snaps/', import.meta.url));
const SNAP_TIMEOUT_MS = 3000; // a whole snapshot takes about a second
const SNAP_ATTEMPTS = 3;

// Five-bit and six-bit channels spread over 0..255 (the top bits repeated in the bottom), so that full is 255 and not 248.
const spread5 = (v) => (v << 3) | (v >> 2);
```

In `bridge/src/dev/snap.js`, replace:

```js
  return { width, height, rgb };
}

// Asks for the screen and waits for all of it.
export function takeSnap(link, { timeoutMs = SNAP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
```

with:

```js
  return { width, height, rgb };
}

// One request for the screen, and a wait for all of it. A timeout rejects with `timedOut` set.
function takeSnapOnce(link, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
```

In `bridge/src/dev/snap.js`, replace:

```js
    }
    timer = setTimeout(() => {
      const of = chunks.length > 0 ? ` of ${chunks[0].count}` : '';
      finish(reject, new Error(`the S3 sent ${chunks.length}${of} snapshot chunks within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    link.on('frame', onFrame);
    link.send(TYPE.TEST, testSnapPayload());
  });
}

// The screen, written to `file` as a PNG; resolves the file.
export async function snapTo(link, file, options) {
  const { width, height, rgb } = await takeSnap(link, options);
```

with:

```js
    }
    timer = setTimeout(() => {
      const of = chunks.length > 0 ? ` of ${chunks[0].count}` : '';
      finish(reject, Object.assign(new Error(`the S3 sent ${chunks.length}${of} snapshot chunks within ${timeoutMs / 1000} s`), { timedOut: true }));
    }, timeoutMs);
    link.on('frame', onFrame);
    link.send(TYPE.TEST, testSnapPayload());
  });
}

// Asks for the screen and waits for all of it. A chunk that went missing on the way (at gate H about one snapshot in twenty lost
// one to a frame that arrived damaged) is not waited for any longer: the screen is asked for again, `attempts` times in all. The
// error of the last try is the one that is thrown; a screen that arrived whole but wrong is thrown at once.
export async function takeSnap(link, { timeoutMs = SNAP_TIMEOUT_MS, attempts = SNAP_ATTEMPTS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await takeSnapOnce(link, timeoutMs);
    } catch (err) {
      if (!err.timedOut || attempt >= attempts) throw err;
    }
  }
}

// The screen, written to `file` as a PNG; resolves the file.
export async function snapTo(link, file, options) {
  const { width, height, rgb } = await takeSnap(link, options);
```

In `bridge/src/link/link.js`, replace:

```js
      clearInterval(this.#pingTimer);
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      if (!already) this.emit('hello', hello);
      return;
    }
```

with:

```js
      clearInterval(this.#pingTimer);
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
      if (!already) this.emit('hello', hello);
      return;
    }
```

In `firmware/src/main.cpp`, replace:

```cpp
  }
}

// One chunk of a snapshot per turn of the loop: 68 chunks in under a second, and the TX ring never fills.
void sendSnapChunk() {
  static uint8_t buf[proto::MAX_PAYLOAD];
  size_t len = 0;
```

with:

```cpp
  }
}

// One chunk of a snapshot per turn of the loop: 68 chunks in under a second. A chunk can still be lost on the way (gate H: about
// one snapshot in twenty, one frame in a thousand reaching the bridge damaged, at half the rate as often as at full speed, with the
// TX ring not full): the bridge asks again.
void sendSnapChunk() {
  static uint8_t buf[proto::MAX_PAYLOAD];
  size_t len = 0;
```

In `firmware/src/screen.cpp`, replace:

```cpp
  }
  int y = snapIndex * SNAP_ROWS;
  int rows = H - y < SNAP_ROWS ? H - y : SNAP_ROWS;
  static uint8_t bgr[W * SNAP_ROWS * 3];
  static uint8_t px[W * SNAP_ROWS * 2];
  canvas.readRectRGB(0, y, W, rows, bgr);  // blue, green, red
  for (int i = 0; i < W * rows; i++) {
    uint16_t c = (uint16_t)(((bgr[i * 3 + 2] & 0xF8) << 8) | ((bgr[i * 3 + 1] & 0xFC) << 3) | (bgr[i * 3] >> 3));
    px[i * 2] = (uint8_t)(c & 0xFF);
    px[i * 2 + 1] = (uint8_t)(c >> 8);
  }
```

with:

```cpp
  }
  int y = snapIndex * SNAP_ROWS;
  int rows = H - y < SNAP_ROWS ? H - y : SNAP_ROWS;
  static uint8_t rgb[W * SNAP_ROWS * 3];
  static uint8_t px[W * SNAP_ROWS * 2];
  // M5GFX calls the 24-bit type bgr888_t but lays it out r, g, b; gate H showed red and blue swapped when it was read as b, g, r
  canvas.readRectRGB(0, y, W, rows, rgb);
  for (int i = 0; i < W * rows; i++) {
    uint16_t c = (uint16_t)(((rgb[i * 3] & 0xF8) << 8) | ((rgb[i * 3 + 1] & 0xFC) << 3) | (rgb[i * 3 + 2] >> 3));
    px[i * 2] = (uint8_t)(c & 0xFF);
    px[i * 2 + 1] = (uint8_t)(c >> 8);
  }
```

Create `tools/gate-h.mjs`:

```js
// Gate H, on the real S3: the screens and the keys of plan 4, without anyone touching the device and without any API. One link, a list
// of scenes; each puts a screen on the S3 as the bridge would, presses keys with TEST KEYS, and checks what comes back (the
// buttons, the approval verdicts, the take's frames, the S3's own LOG lines) or what the display shows (TEST SNAP).
// Usage: node tools/gate-h.mjs [--port COMx] [--only "scene name;scene name"]
// Exit code 0 when every scene held, 1 when one did not. walkie must be running on the S3 (node tools/flash.mjs). The last scene
// opens the firmware switch and closes it again; if it is interrupted with the screen open, a tap on the front key reboots the S3
// into on-the-beat (node tools/boot.mjs app1 brings walkie back).
import { FLAG, TYPE } from '../bridge/src/link/frame.js';
import { BUTTON, KEY, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, testKeysPayload, uiPayload } from '../bridge/src/link/messages.js';
import { connect } from '../bridge/src/dev/connect.js';
import { takeSnap } from '../bridge/src/dev/snap.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = flag('--only')?.split(';');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUTTON_NAMES = Object.fromEntries(Object.entries(BUTTON).map(([name, code]) => [code, name]));
const { FRONT, SIDE } = KEY;

const link = await connect({ port: flag('--port') });
let seen;
const reset = () => (seen = { logs: [], buttons: [], verdicts: [], takeFrames: 0, takeEnds: [] });
reset();
link.on('log', (line) => seen.logs.push(line));
link.on('audio-up', (f) => {
  seen.takeFrames++;
  if (f.flags & FLAG.EOS) seen.takeEnds.push(f.flags & FLAG.REASON ? 'EOS+REASON' : 'EOS');
});
link.on('frame', (f) => {
  if (f.type === TYPE.BUTTON) seen.buttons.push(BUTTON_NAMES[parseButton(f.payload)?.event]);
  if (f.type === TYPE.APPROVAL_RES) {
    const r = parseApprovalRes(f.payload);
    seen.verdicts.push(`#${r.id} ${r.allow ? 'allow' : 'deny'}${r.reasonFollows ? '+reason' : ''}`);
  }
});

const ui = (view) => link.send(TYPE.UI, uiPayload(view));
const approval = (tool, preview) => link.send(TYPE.APPROVAL_REQ, approvalReqPayload({ id: 1, tool, preview }));
const keys = (steps) => link.send(TYPE.TEST, testKeysPayload(steps));
const tap = (mask, holdMs) => keys([{ delayMs: 0, mask }, { delayMs: holdMs, mask: 0 }]);
const screens = () => seen.logs.filter((l) => l.startsWith('screen ')).map((l) => l.slice(7));
const waitFor = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 50) await sleep(50);
  return check();
};

// The colour of a pixel in the header bar, where there is no text: x 130, y 2.
async function headerColour() {
  const { width, rgb } = await takeSnap(link);
  const at = (2 * width + 130) * 3;
  return [rgb[at], rgb[at + 1], rgb[at + 2]];
}
const near = ([r, g, b], [wr, wg, wb]) => Math.abs(r - wr) < 24 && Math.abs(g - wg) < 24 && Math.abs(b - wb) < 24;

const REPLY_16_LINES = Array.from({ length: 16 }, (_, i) => `第${i + 1}行：这一行有二十个汉字左右用来占满一行的宽度`).join('\n');

// Each scene returns what it found wanting, as a list of sentences; an empty list is a pass.
const scenes = {
  'confirm: the side key cancels': async () => {
    ui({ state: UI_STATE.CONFIRM, project: 'walkie', text: '取消键' });
    await sleep(500);
    tap(SIDE, 150);
    await waitFor(() => seen.buttons.length > 0, 1500);
    return seen.buttons.join() === 'CANCEL' ? [] : [`buttons ${seen.buttons.join() || 'none'}, wanted CANCEL`];
  },
  'working: the side key held for a second stops, a tap does not': async () => {
    ui({ state: UI_STATE.WORKING, project: 'walkie', elapsedMs: 83_000 });
    await sleep(500);
    tap(SIDE, 150);
    await sleep(700);
    const afterTap = seen.buttons.join();
    tap(SIDE, 1300);
    await waitFor(() => seen.buttons.length > 0, 2500);
    return [...(afterTap ? [`a tap sent ${afterTap}`] : []), ...(seen.buttons.join() === 'STOP' ? [] : [`the hold sent ${seen.buttons.join() || 'nothing'}, wanted STOP`])];
  },
  'reply: five pages, the side key turns four and the last one dismisses': async () => {
    ui({ state: UI_STATE.REPLY, project: 'walkie', text: REPLY_16_LINES });
    await sleep(600);
    const bad = [];
    for (let page = 1; page <= 5; page++) {
      tap(SIDE, 150);
      await sleep(600);
      const dismissed = seen.buttons.length > 0;
      if (page < 5 && dismissed) bad.push(`page ${page} dismissed the reply`);
      if (page === 5 && seen.buttons.join() !== 'DISMISS') bad.push(`page 5 sent ${seen.buttons.join() || 'nothing'}, wanted DISMISS`);
    }
    return bad;
  },
  'error: the side key dismisses': async () => {
    ui({ state: UI_STATE.ERROR, text: '没听清，再说一次' });
    await sleep(500);
    tap(SIDE, 150);
    await waitFor(() => seen.buttons.length > 0, 1500);
    return seen.buttons.join() === 'DISMISS' ? [] : [`buttons ${seen.buttons.join() || 'none'}, wanted DISMISS`];
  },
  'approval: the front key allows': async () => {
    approval('Bash', 'npm test');
    await sleep(600);
    tap(FRONT, 150);
    await waitFor(() => seen.verdicts.length > 0, 1500);
    return seen.verdicts.join() === '#1 allow' ? [] : [`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 allow`];
  },
  'approval: the side key denies': async () => {
    approval('Bash', 'rm -rf build');
    await sleep(600);
    tap(SIDE, 150);
    await waitFor(() => seen.verdicts.length > 0, 1500);
    return seen.verdicts.join() === '#1 deny' ? [] : [`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 deny`];
  },
  'approval: the front key held records a reason, which ends the take with the REASON flag': async () => {
    approval('Bash', 'git push --force');
    await sleep(600);
    tap(FRONT, 1500);
    await waitFor(() => seen.verdicts.length > 0 && seen.takeEnds.length > 0, 4000);
    const bad = [];
    if (seen.verdicts.join() !== '#1 deny+reason') bad.push(`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 deny+reason`);
    if (seen.takeEnds.join() !== 'EOS+REASON') bad.push(`the take ended ${seen.takeEnds.join() || 'never'}, wanted EOS+REASON`);
    if (seen.takeFrames < 40) bad.push(`only ${seen.takeFrames} take frames for a 1.5 s hold`);
    return bad;
  },
  'talking while working: the take ends with EOS and the working screen is back': async () => {
    ui({ state: UI_STATE.WORKING, project: 'walkie', elapsedMs: 5000 });
    await sleep(500);
    tap(FRONT, 1200);
    await waitFor(() => seen.takeEnds.length > 0, 3000);
    await sleep(300);
    const bad = [];
    if (seen.takeEnds.join() !== 'EOS') bad.push(`the take ended ${seen.takeEnds.join() || 'never'}, wanted EOS`);
    if (screens().at(-1) !== 'working') bad.push(`the screen after the take was ${screens().at(-1)}`);
    return bad;
  },
  'a tap on the front key is not a take': async () => {
    ui({ state: UI_STATE.IDLE, project: 'walkie' });
    await sleep(500);
    tap(FRONT, 150);
    await sleep(900);
    return seen.takeFrames === 0 ? [] : [`${seen.takeFrames} take frames from a tap`];
  },
  'the header colours are the ones the screens ask for (red and blue are not swapped)': async () => {
    const bad = [];
    const want = [
      [UI_STATE.ERROR, '出错了', [197, 0, 0], 'error red'],
      [UI_STATE.CONFIRM, '确认', [255, 125, 0], 'confirm amber'],
      [UI_STATE.WORKING, '', [0, 0, 132], 'working navy'],
    ];
    for (const [state, text, colour, name] of want) {
      ui({ state, project: 'walkie', text: text ? '颜色' : undefined });
      await sleep(900);
      const got = await headerColour();
      if (!near(got, colour)) bad.push(`${name}: the header is ${got.join(',')}, wanted about ${colour.join(',')}`);
    }
    return bad;
  },
  // Last, because a screen left open here turns the next front tap into a reboot of the S3 into app0 (it is the confirm key).
  'chord: both keys held 3 s open the firmware switch and the side key closes it': async () => {
    ui({ state: UI_STATE.IDLE, project: 'walkie' });
    await sleep(500);
    keys([{ delayMs: 0, mask: FRONT | SIDE }, { delayMs: 3300, mask: 0 }]);
    await waitFor(() => screens().includes('switch-confirm'), 5000);
    await sleep(600); // until both keys are up: a key press while they are down is part of the chord and means nothing
    tap(SIDE, 150);
    if (!(await waitFor(() => screens().at(-1) === 'idle', 2000))) {
      await sleep(10_500); // the switch screen closes itself after 10 s
      return [`the side key did not close the switch screen (screens ${screens().join()})`];
    }
    return screens().join() === 'idle,switch-confirm,idle' || screens().join() === 'switch-confirm,idle' ? [] : [`screens ${screens().join()}`];
  },
};

let failed = 0;
try {
  await sleep(300);
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    reset();
    let bad;
    try {
      bad = await run();
    } catch (err) {
      bad = [`threw: ${err.message}`];
    }
    if (bad.length === 0) console.log(`PASS ${name}`);
    else {
      failed++;
      console.log(`FAIL ${name}: ${bad.join('; ')}`);
      console.log(`     the S3 said: ${seen.logs.filter((l) => !l.startsWith('key script')).join(' | ')}`);
    }
  }
} finally {
  link.close();
}
console.log(failed === 0 ? 'gate H: every scene held' : `gate H: ${failed} scene(s) did not hold`);
process.exitCode = failed === 0 ? 0 : 1;
```

- [ ] **Step 4: Run them and watch them pass, and build the firmware**

Run: `node --test bridge/test/dev/snap.test.js bridge/test/link/link.test.js`
Expected: PASS, 50 tests, 0 fail.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 714 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/dev/snap.js bridge/src/link/link.js bridge/test/dev/snap.test.js bridge/test/link/link.test.js firmware/src/main.cpp firmware/src/screen.cpp tools/gate-h.mjs
git commit -m @'
Task 12: gate H on the real S3: tools/gate-h.mjs, and what it found

Eleven scenes press keys with TEST KEYS and check the buttons, approval verdicts, takes and header colours. They found three things:
the snapshot had red and blue swapped (M5GFX lays bgr888_t out r, g, b), the Link's first PING came a second after HELLO so the S3
showed its offline screen for that second (it goes with the answer now), and about one snapshot in twenty loses a chunk to a frame
that arrives damaged (not rate dependent, TX ring not full), so takeSnap asks again, up to three times.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
'@
```

- [ ] **Step 7: Gate H on the real S3**

Ask him first, with the AskUserQuestion tool, and say exactly this: the S3's serial port (COM8 on his PC) will be opened and written to; the firmware built in Step 4 is flashed to app1 with `node tools/flash.mjs` (it reads the partition table first and writes only app1 and otadata, and the S3 restarts into walkie); then `node tools/gate-h.mjs` presses keys by TEST frames, changes the S3's screen and, in its last scene, opens the firmware-switch screen and closes it again; no network, no API, no `claude`, nothing left in any history; for this session only. Go on only with a clear yes in that answer.

Run: `node tools/flash.mjs`
Expected: it ends with `walkie (<bytes> bytes) is in app1 and selected; the S3 is restarting into it.` (the byte count is that of the image built in Step 4) and exit code 0.

Run: `node tools/gate-h.mjs`
Expected: eleven lines that begin with `PASS`, in this order, then `gate H: every scene held`, exit code 0:

```
PASS confirm: the side key cancels
PASS working: the side key held for a second stops, a tap does not
PASS reply: five pages, the side key turns four and the last one dismisses
PASS error: the side key dismisses
PASS approval: the front key allows
PASS approval: the side key denies
PASS approval: the front key held records a reason, which ends the take with the REASON flag
PASS talking while working: the take ends with EOS and the working screen is back
PASS a tap on the front key is not a take
PASS the header colours are the ones the screens ask for (red and blue are not swapped)
PASS chord: both keys held 3 s open the firmware switch and the side key closes it
```

A `FAIL` line says what was wrong and prints what the S3 said, which is where to look first. Run one scene again with `--only "<scene name>"`. If a run is interrupted while the chord scene has the switch screen open, a tap on the front key restarts the S3 into on-the-beat, and `node tools/boot.mjs app1` brings walkie back.

---

### Task 13: The whole turn on the real S3: gates I, J and K

No file changes here, and no commit: this task runs what Tasks 1 to 12 built, three ways, on the real S3. Gate I is the whole turn through OpenAI and the real `claude`. Gate J is the same turn with OpenAI refused, so that it goes through Gemini (with a stand-in for `claude`, which is not what is being tested). Gate K is the firmware switch by hand, with him at the S3. Each one is a separate action on his hardware, his keys or his quota, so each needs its own fresh yes from him, asked with the AskUserQuestion tool, and a re-run after a fix is a new question. Do not read `%APPDATA%\walkie\keys.env` at any point.

**Files:** none.

**Interfaces:**
- Consumes: everything above, flashed to the S3 (Task 12, Step 7); `walkie --inject` and `walkie-dev inject` (Task 11); `tools/boot.mjs` (plan 1).
- Produces: the measurements below, which Task 14 writes into the spec.

- [ ] **Step 1: Make the recording**

Windows speech synthesis makes a 16 kHz mono PCM16 recording of the request locally, with no network. Write this to a scratch file (not in the repo), for example `make-utterance.ps1`, and run it with an output folder outside the repo:

```powershell
param([string]$OutDir)
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$path = Join-Path $OutDir 'ask-one-plus-one.wav'
$s.SetOutputToWaveFile($path, $fmt)
$s.Speak('一加一等于几？请只回答一个数字。')
$s.Dispose()
"$path $((Get-Item $path).Length) bytes"
```

Run: `powershell -File make-utterance.ps1 -OutDir C:\Users\you\utter`
Expected: one line, the path and a size of about 155,000 bytes (about 4.8 s at 32,000 bytes a second). `Microsoft Huihui Desktop` is the Chinese voice that Windows ships.

- [ ] **Step 2: Gate I, through OpenAI and the real `claude`**

Ask him first, and say exactly this: the S3's serial port will be opened and written to; the recording is fed to the S3 as its microphone; the bridge sends it to OpenAI (`gpt-transcribe`, `gpt-6-luna`, and `gpt-4o-mini-tts` for the reply, a few cents) with his key from `keys.env`; and it starts the real `claude` (Opus 5.5) in the active project, `on-the-beat`, with his Claude login, asking it only 「一加一等于几？请只回答一个数字。」; that costs about $0.36 (the first turn of a process writes the whole cache) and leaves one session in that project's history; for this run only. `--clean-env` is needed inside the Claude desktop app's shell and does no harm outside it.

Run: `node bridge/bin/walkie.js --clean-env --inject C:\Users\you\utter\ask-one-plus-one.wav`
Expected, within about 20 s and with times that differ: the exit code is 0 and the console shows, in this order, `[link] walkie 0.1.0 is connected`, `[S3] mic source test fifo`, `[S3] act commit reason=0`, `[S3] act end`, `[S3] screen transcribing`, `[S3] screen confirm`, a `[heard]` line with the words and `→ to_claude (openai)`, `[working] thinking`, a `[reply] on-the-beat turn 1, 5.5 s, $0.359` line with `voice: 二`, `[S3] screen reply`, and last `[inject] reply` and `[walkie] inject finished: closing`. Recorded on 2 Oct 2026: the take ended at 02:14:03, CONFIRM showed at 02:14:05, the transcript came at 02:14:08, Claude answered in 5.5 s, the reply was spoken to the end and the run finished at 02:14:16, 13 s after the key came up. A `[S3] screen listening` line can be missing: about one S3-to-PC frame in a thousand arrives damaged, a LOG line included.

If `[inject] timeout` or `no take came back` is printed instead, the recording did not reach the S3 whole: `injectTake` paces it four chunks at a time (see Task 11), so check that nothing else is writing to the port and read `[S3]` lines for `bad MIC_PCM` or `mic fifo full`.

- [ ] **Step 3: Gate J, through Gemini with OpenAI refused**

Ask him first, and say exactly this: the S3's serial port will be opened and written to; the recording is fed to the S3; the bridge calls OpenAI once with a key that is invalid on purpose (it answers 401 and is skipped for 5 minutes; `OPENAI_API_KEY=blocked` in the environment wins over `keys.env`, which is not touched), then Gemini with his key (`gemini-3.8-flash` and `gemini-3.1-flash-lite` for hearing, `gemini-3.8-flash-tts` for speaking, a few cents); `claude` is the stand-in `fake-claude.js`, so no quota is used and no session is created; and his `%APPDATA%\walkie\state.json` is moved aside for the run and put back afterwards, because the stand-in cannot resume the real session whose id it holds; for this run only.

```powershell
$state = "$env:APPDATA\walkie\state.json"
Copy-Item $state "$env:TEMP\walkie-state.backup.json"
Move-Item $state "$state.aside"
$env:OPENAI_API_KEY = 'blocked'
node bridge/bin/walkie.js --command '["node","C:/Users/you/Documents/walkie/bridge/test/claude/fake-claude.js"]' --inject C:\Users\you\utter\ask-one-plus-one.wav
Remove-Item Env:OPENAI_API_KEY
Remove-Item $state -ErrorAction SilentlyContinue
Move-Item "$state.aside" $state
Compare-Object (Get-Content $state) (Get-Content "$env:TEMP\walkie-state.backup.json")
```

The stand-in is given to node as `C:/…`; the `/c/…` form that Git Bash prints is not found by node, and the stand-in then exits with code 1.
Expected: the exit code of `walkie.js` is 0 and `Compare-Object` prints nothing (the state file is as it was). The console shows `speech: openai transcribe: HTTP 401 …; skipping openai transcribe for 5 min`, then a Gemini hear (one of the two models may answer first; on 2 Oct 2026 `gemini-3.8-flash` gave no answer within 8 s and was skipped, `gemini-3.1-flash-lite` heard the words 12 s after the take ended), a `[heard]` line ending `→ to_claude (gemini)`, a `[reply]` line whose `voice:` says `I heard: ` and the words (that is what the stand-in answers), `speech: openai speak: HTTP 401 …` (the reply is spoken by Gemini's voice instead), and `[inject] reply`, 26 s after the key came up (32 s from the start of the run). Gemini answers `503` now and then: if both models do, the run ends `[inject] unclear` with exit code 1, which is a provider failure and not a bug here; put the state file back as above and ask again.

- [ ] **Step 4: Gate K, the firmware switch by hand**

This one is his hands: the S3 has to be held. Ask him first, and say exactly this: the S3's serial port will be opened to watch its log (pings only), and when he has confirmed the switch on the S3 itself, `node tools/boot.mjs app1` writes the otadata image to bring walkie back; no network, no API, no `claude`; he must be at the S3 with the bridge not running.

Write this to a scratch file, for example `watch-s3.mjs`. It prints the S3's own log lines with a time and ends when the link goes down (the S3 restarted into on-the-beat) or after the number of seconds given:

```js
// Watches the S3 while a person works its keys: its LOG lines with a time, until the link goes down or the time is up.
const repo = 'C:/Users/you/Documents/walkie';
const { connect } = await import(`file:///${repo}/bridge/src/dev/connect.js`);

const maxSecs = Number(process.argv[2] ?? 150);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const link = await connect({});
const done = new Promise((resolve) => {
  link.on('down', (reason) => {
    console.log(`${at()} LINK DOWN: ${reason}`);
    resolve('down');
  });
  setTimeout(() => resolve('time'), maxSecs * 1000);
});
link.on('log', (line) => console.log(`${at()} S3 ${line}`));
console.log(`${at()} watching; hold both keys 3 s, then tap the front key`);
const why = await done;
console.log(`${at()} end: ${why}`);
try {
  link.close();
} catch {
  // already gone
}
process.exit(0);
```

Run: `node watch-s3.mjs 150`, and then he holds both keys for 3 s and taps the front key.
Expected, with times that differ: `S3 act prepare` and `S3 act end` for the first key (a chord never commits a take: there is no `act commit`), then `S3 screen switch-confirm` 3 s after both keys were down, and after his tap `S3 act button 4`, `S3 act boot app0`, `S3 boot app0: ESP_OK`, `LINK DOWN: no PONG for 3 s` and `end: down`. The S3 is now running on-the-beat. A side tap, or 10 s with no tap, closes the switch screen instead (`screen idle`) and nothing restarts.

Run: `node tools/boot.mjs app1`
Expected: `The S3 is restarting into app1 (walkie).` and, a few seconds later, `node bridge/bin/walkie-dev.js ping 3` prints three `pong:` lines.

- [ ] **Step 5: What is left for him**

The whole thing by hand, once, with his own voice at wrist distance, is spec 9's last line and is his to do: hold the front key, say a request, read the screen, hear the reply, answer an approval with the keys and once with a spoken reason. This plan does not do it for him.

---

### Task 14: Docs: the README, the spec and `frames.md` say what plan 4 built and measured

Last, the three documents say what the code and the S3 have shown. The README gets the voice turn, the new developer commands and the gates; the spec gets §6.6's UI frame as it was built, and §10 gets the three measurements of Task 13 and Task 12 (the whole turn, the screens and keys, and the frames lost on the link) with what stays open; `frames.md` gets the corrections that the measurements made (the snapshot is 68 chunks of two rows, the S3's FIFO is 16.4 s, the first PING comes with the HELLO answer, the recording is sent paced, and MIC_SOURCE empties the FIFO when it is switched off).

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-walkie-design.md`, `protocol/frames.md`, `README.md`

**Interfaces:**
- Consumes: the measurements of Tasks 12 and 13.
- Produces: documentation only.

- [ ] **Step 1: Edit the documents**

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace:

```markdown
### 6.6 Link protocol

- Frame: `type:u8 | flags:u8 | seq:u16 | len:u16 | payload | crc16:u16` (CRC-16/CCITT-FALSE, little endian), COBS-encoded, delimited by 0x00. `flags` bit 0 marks end of stream; bits 1-2 hold the audio codec (0 = PCM16; ADPCM is reserved for Stage 3); bit 7 is reserved for encryption. Payloads are at most 1024 bytes.
- Types: HELLO (the PC's carries a random nonce and the S3's answer echoes it, so a HELLO the S3 sent at boot is never taken for the answer), PING, PONG, AUDIO_UP (640 B = 20 ms at 16 kHz), AUDIO_DOWN (up to 960 B = 20 ms at 24 kHz), CREDIT (u32 bytes), PLAYED (how a reply ended: bytes played, their CRC-32, underruns, peak ring fill, finished or stopped), UI (state plus UTF-8 JSON fields), BUTTON (event), APPROVAL_REQ (id, tool, preview up to 300 characters), APPROVAL_RES (id, verdict, whether a voice reason follows), CMD (volume, mic gain, stop audio, boot app0, reboot), TEST, LOG.
- `protocol/frames.md` is the detailed contract: payload layouts, credit flow control, how a reply is stopped, and sequence numbers.
- Bytes outside frames (ROM and boot text) are skipped until the next delimiter.
- `protocol/vectors.json` holds encoded and decoded pairs that both implementations must pass.
```

with:

```markdown
### 6.6 Link protocol

- Frame: `type:u8 | flags:u8 | seq:u16 | len:u16 | payload | crc16:u16` (CRC-16/CCITT-FALSE, little endian), COBS-encoded, delimited by 0x00. `flags` bit 0 marks end of stream; bits 1-2 hold the audio codec (0 = PCM16; ADPCM is reserved for Stage 3); bit 7 is reserved for encryption. Payloads are at most 1024 bytes.
- Types: HELLO (the PC's carries a random nonce and the S3's answer echoes it, so a HELLO the S3 sent at boot is never taken for the answer), PING, PONG, AUDIO_UP (640 B = 20 ms at 16 kHz), AUDIO_DOWN (up to 960 B = 20 ms at 24 kHz), CREDIT (u32 bytes), PLAYED (how a reply ended: bytes played, their CRC-32, underruns, peak ring fill, finished or stopped), UI (a state byte plus tagged fields: project, text, elapsed time; the first draft said JSON, and the tagged form needs no parser on the S3), BUTTON (event), APPROVAL_REQ (id, tool, preview up to 300 characters), APPROVAL_RES (id, verdict, whether a voice reason follows), CMD (volume, mic gain, stop audio, boot app0, reboot), TEST, LOG.
- `protocol/frames.md` is the detailed contract: payload layouts, credit flow control, how a reply is stopped, and sequence numbers.
- Bytes outside frames (ROM and boot text) are skipped until the next delimiter.
- `protocol/vectors.json` holds encoded and decoded pairs that both implementations must pass.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace:

```markdown
- What `claude.prewarm` saves (plan 3). A message sent at once to a prewarmed process waited for the rest of the boot: the run took 11.1 s in all (the turn itself 5.1 s); with a 30 s head start it took 37.1 s, that is 7.1 s after the head start (the turn 5.7 s), so the boot that waiting hides is about 4 s (the boot itself, measured that evening; it was 14 to 23 s when first measured).
- Stopping, resuming, `/compact` and a message in the middle of a turn, against the real `claude` (plan 3, 1 Oct 2026). `stop` 20 s into a long answer (counting to 1500) ended the process at once and no `claude` was left running; `continue` resumed session 3977649d, no second transcript was made, the transcript held the interrupted request, a stub "No response requested." and then the `continue`, and `claude` wrote the whole answer again (36.2 s, $0.459): what was already written when it was stopped is lost. A `stop` sent before the process had printed `init` (5 s after the message) left no session to resume, and the `continue` started a new one. Two messages sent one right after the other, before the first turn began, were answered as two turns of their own (6.9 s and 6.3 s, $0.429 and $0.017). Not checked: a message sent while an answer is being written; what is still untested is whether `claude` merges that one into the running turn. `/compact` took 10.7 s and made the context 88% shorter (70,055 tokens to 8,077) and cost $0.039.

## 11. Out of scope

Wake words; local speech engines; attaching to desktop-app sessions; channels; more than one device; typing into the session from the bridge console; everything in Stage 3 beyond its boundary.
```

with:

```markdown
- What `claude.prewarm` saves (plan 3). A message sent at once to a prewarmed process waited for the rest of the boot: the run took 11.1 s in all (the turn itself 5.1 s); with a 30 s head start it took 37.1 s, that is 7.1 s after the head start (the turn 5.7 s), so the boot that waiting hides is about 4 s (the boot itself, measured that evening; it was 14 to 23 s when first measured).
- Stopping, resuming, `/compact` and a message in the middle of a turn, against the real `claude` (plan 3, 1 Oct 2026). `stop` 20 s into a long answer (counting to 1500) ended the process at once and no `claude` was left running; `continue` resumed session 3977649d, no second transcript was made, the transcript held the interrupted request, a stub "No response requested." and then the `continue`, and `claude` wrote the whole answer again (36.2 s, $0.459): what was already written when it was stopped is lost. A `stop` sent before the process had printed `init` (5 s after the message) left no session to resume, and the `continue` started a new one. Two messages sent one right after the other, before the first turn began, were answered as two turns of their own (6.9 s and 6.3 s, $0.429 and $0.017). Not checked: a message sent while an answer is being written; what is still untested is whether `claude` merges that one into the running turn. `/compact` took 10.7 s and made the context 88% shorter (70,055 tokens to 8,077) and cost $0.039.

- The whole turn on the real S3 (plan 4, 2 Oct 2026). A recorded utterance (Windows speech synthesis, 16 kHz, 「一加一等于几？请只回答一个数字。」) was fed to the S3 as its mic by `walkie.js --inject`, which holds the front key by TEST frames. With OpenAI and the real `claude` (Opus 5.5, project on-the-beat): the take ended at 02:14:03 and the screen showed CONFIRM at 02:14:05; the console printed the transcript and `to_claude (openai)` at 02:14:08; Claude answered in 5.5 s ($0.359, the first turn of a process); the reply, with `<voice>二</voice>`, was spoken to the end and the run finished at 02:14:16, 13 s after the key came up. With OpenAI refused (an invalid key: HTTP 401, skipped for 5 minutes) and a stand-in for `claude`: `gemini-3.8-flash` did not answer within 8 s, `gemini-3.1-flash-lite` gave the transcript 12 s after the take ended, and the reply was spoken in the Gemini voice, 32 s in all. A run of the same with `gemini-3.8-flash` and `gemini-3.1-flash-lite` both answering 503 sent nothing to Claude: the console said `nothing clear (unavailable)` and the run ended as unclear. Not checked: how either reply sounded (the run reads PLAYED and does not hear), and the whole thing by hand at wrist distance with his own voice, which is still his to do.
- The screens and the keys on the real S3 without anyone touching it (plan 4, `tools/gate-h.mjs`, 11 scenes, all held): the side key cancels in CONFIRM, a hold of a second stops in WORKING and a tap does not, a reply of 16 lines turns four pages and the fifth side tap dismisses it, the side key dismisses an error, an approval is allowed by a front tap and denied by a side tap, a front hold records a reason (the take ends with EOS and REASON), talking while WORKING ends with EOS and the working screen is back, a front tap is not a take, the header colours (checked from `TEST SNAP` pixels) are the ones asked for, and both keys held 3 s open SWITCH_CONFIRM, which the side key closes. It found two faults, both fixed: `TEST SNAP` showed red and blue swapped (M5GFX's `readRectRGB` fills r, g, b although its type is called bgr888_t), and the S3 stayed on its OFFLINE screen until its first PING (the bridge now pings at once on HELLO). The switch to app0 was also done by hand with the real keys (both held 3 s, then a front tap): `boot app0: ESP_OK`, and `tools/boot.mjs app1` brought walkie back.
- Frames lost on the link (plan 4, 2 Oct 2026). PC to S3: 283 MIC_PCM frames handed to the port at once lost 50 (the S3's PONG counted 83 more bad chunks and 50 sequence gaps; its receive queue is 16 KB), and the first end-to-end run lost its key script that way and made no take; four frames and a 5 ms pause lost none in 283, so `walkie-dev inject` and `--inject` pace the recording. S3 to PC: about one frame in a thousand of about 1 KB arrives damaged (about one snapshot in twenty loses a chunk of 68; the same at half the rate, with the TX ring not full; the audio at 33 KB/s was clean in plans 1 and 2), so `takeSnap` asks again. Open: a BUTTON or an APPROVAL_RES lost that way (rare) leaves the bridge waiting, and an approval then falls back on its 55 s deny; a lost LOG line is why a run's log can lack a line such as `screen listening`. The cause of the S3-to-PC damage was not found.

## 11. Out of scope

Wake words; local speech engines; attaching to desktop-app sessions; channels; more than one device; typing into the session from the bridge console; everything in Stage 3 beyond its boundary.
```

In `protocol/frames.md`, replace:

```markdown

### PING and PONG

The PC pings once a second. The S3 answers with the same token, its uptime, and its counts of bad chunks and seq gaps. The PC considers the link down after 3 s without a PONG and goes back to saying HELLO. The S3 shows the PC as offline after 3 s without a PING.

### Credit: flow control for AUDIO_DOWN

```

with:

```markdown

### PING and PONG

The PC pings once a second, and once at once when the S3's HELLO answer makes the link ready (the S3 shows OFFLINE until it has had a PING, so a bridge that waited for the first tick left it offline for a second). The S3 answers with the same token, its uptime, and its counts of bad chunks and seq gaps. The PC considers the link down after 3 s without a PONG and goes back to saying HELLO. The S3 shows the PC as offline after 3 s without a PING.

### Credit: flow control for AUDIO_DOWN

```

In `protocol/frames.md`, replace:

```markdown
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |
| 2 | KEYS | u8 count (1 to 16), then count steps of u16 delay_ms, u8 mask | a key script: after delay_ms (counted from the previous step, or from the frame's arrival) the keys held are the mask (bit 0 the front key, bit 1 the side key). The S3 treats them as pressed together with the real keys. The frame is refused when its length is not what count announces |
| 3 | MIC_SOURCE | u8 on | with 1, a take is recorded from the PCM of MIC_PCM instead of the mic (silence when it has run out); with 0, from the mic again. Either way it empties the PCM queued |
| 4 | MIC_PCM | PCM16 at 16 kHz, 2 to 1000 bytes | queued for MIC_SOURCE; what does not fit in the S3's queue (about 12 s) is dropped, and a LOG line says so |
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |

SNAP chunk, S3 to PC, a TEST frame of op 5: `u8 5, u16 index, u16 count, u16 width, u16 height`, then RGB565 little endian, row by row, at most 1000 bytes. A 240 by 135 screen is 65 chunks. The S3 sends them as its TX queue allows, so a chunk can arrive a few milliseconds after the one before it. A new SNAP while one is being sent starts again from chunk 0.

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.
```

with:

```markdown
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |
| 2 | KEYS | u8 count (1 to 16), then count steps of u16 delay_ms, u8 mask | a key script: after delay_ms (counted from the previous step, or from the frame's arrival) the keys held are the mask (bit 0 the front key, bit 1 the side key). The S3 treats them as pressed together with the real keys. The frame is refused when its length is not what count announces |
| 3 | MIC_SOURCE | u8 on | with 1, a take is recorded from the PCM of MIC_PCM instead of the mic (silence when it has run out); with 0, from the mic again and the PCM queued is emptied |
| 4 | MIC_PCM | PCM16 at 16 kHz, 2 to 1000 bytes | queued for MIC_SOURCE; what does not fit in the S3's queue (2^19 bytes, 16.4 s) is dropped, and a LOG line says so. Send them paced: the S3's receive queue is 16 KB and 283 frames handed to the port at once lost 50 of them on the way (its PONG counted 83 more bad chunks and 50 sequence gaps), the KEYS frame that follows among the likely ones. Four frames and then a pause of 5 ms lost none in 283 (`walkie-dev inject` does that) |
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |

SNAP chunk, S3 to PC, a TEST frame of op 5: `u8 5, u16 index, u16 count, u16 width, u16 height`, then RGB565 little endian, row by row, two rows (960 bytes) to a chunk. A 240 by 135 screen is 68 chunks. The S3 sends them as its TX queue allows, so a chunk can arrive a few milliseconds after the one before it. A new SNAP while one is being sent starts again from chunk 0. About one S3-to-PC frame in a thousand of about 1 KB reaches the bridge damaged (measured on 2 Oct 2026: about one snapshot in twenty loses a chunk, the same at half the sending rate, with the S3's TX ring not full), so the bridge asks for a snapshot again, up to three times with 3 s for each; the CRC makes a damaged frame a lost one.

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.
```

Replace the whole of `README.md` with:

````markdown
# walkie

Talk to Claude Code on the PC through the M5StickS3 on the wrist. The design is in
`docs/superpowers/specs/2026-09-29-walkie-design.md`; the plans are in `docs/superpowers/plans/`.

The S3 also runs on-the-beat. on-the-beat keeps app0 and walkie lives in app1, so never run
`pio test` for this firmware against the S3. `pio run -t upload` is routed to `tools/flash.mjs`, and `-t erase` /
`-t uploadfs` are refused by `firmware/guard.py`; use `tools/flash.mjs` and `tools/boot.mjs` for everything that
touches the S3.

## Layout

| Folder | What it holds |
|---|---|
| `protocol/` | the USB wire format (`frames.md`), its Python reference and the shared test vectors |
| `firmware/` | the S3 firmware (PlatformIO). `lib/proto` (frames and payloads) and `lib/ui` (key gestures, key scripts, text paging, the state machine) are portable C++ that `host/run.mjs` also builds and tests on the PC; `src/` holds what needs the hardware: the USB link, audio, the screen |
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `src/speech` talks to OpenAI and Gemini; `src/intent` and `src/config` decide what was said and read the settings; `src/claude` runs Claude Code, one process per project, resumed, stopped and switched, and `src/perm` is the permission endpoint it asks and the queue of approvals waiting for the wrist; `src/turn` takes a recording through speech and Claude and back (approvals, replies, the take that is a reason for a deny), `src/ui` decides what the S3 shows, `src/console.js` is the log and `src/main.js` wires it all together; `bin/walkie.js` is the bridge itself, `bin/walkie-dev.js` and `src/dev` are developer commands |
| `tools/` | writing walkie into app1, choosing which app the S3 boots, and `gate-h.mjs`, the check of the screens and keys on the S3 |

## Prerequisites

- Node 24. Run `npm --prefix bridge install` once, or the dev CLI cannot load serialport.
- g++ (WinLibs) on PATH, for the firmware host tests that `npm test` runs.
- PlatformIO, for building the firmware: the tools use the `pio` in `%USERPROFILE%\.platformio\penv\Scripts` (under `PLATFORMIO_CORE_DIR` instead, when that is set).
- ffmpeg on PATH, for `walkie-dev play <file>`.
- Claude Code (`claude` on PATH, logged in), for `walkie-dev claude` against the real thing and for the bridge itself. The tests never start it: they run a stand-in, `bridge/test/claude/fake-claude.js`.
- API keys for the speech commands: `OPENAI_API_KEY` and `GEMINI_API_KEY`, one `NAME=value` per line in `%APPDATA%\walkie\keys.env` (outside the repo), or environment variables of the same names, which win. The bridge never prints a key. When a speech command finds one missing, its `[keys]` line says where it looked and whether the file names the key with no value, which is what an edit that was never saved looks like.

## Commands

From the repo root:

```bash
npm test
```

```bash
node tools/flash.mjs
```

```bash
node tools/boot.mjs app0
```

```bash
node tools/boot.mjs app1
```

```bash
node bridge/bin/walkie-dev.js
```

`npm test` runs the bridge, tools and firmware host tests. `flash.mjs` builds walkie, writes it to app1 and boots it.
`boot.mjs app0` boots on-the-beat and `boot.mjs app1` boots walkie. `walkie-dev.js` with no arguments lists the
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify, claude, press, ui, snap, inject. `hear`, `say` and `classify` send text or recordings to OpenAI (and to Gemini when OpenAI fails), so they need the keys above and cost a little each time. `--provider openai` or `--provider gemini` (or `--provider=openai`) uses that provider alone. An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.

`claude` runs the session manager from a terminal, with no S3. It reads one command per line on stdin (`say <text>`, `yes`, `no [reason]`, `stop`, `continue`, `compact`, `new`, `status`, `switch <project>`, `wait idle`, `wait approval`, `sleep <s>`, `quit`; the header of `bridge/src/dev/claude.js` lists them all) and prints what the device would show. It starts the real `claude`, with his login and his quota, in the folder of `--cwd <dir>` (default: the current one) or in a project of `projects.json` with `--project <name>`; the permission server and the approvals are the real ones. Inside the Claude desktop app's own shell it needs `--clean-env`, because the variables of that shell point a nested `claude` at the app. `--command '<json array>'` replaces the program, for the stand-in of the tests. It keeps its state in memory and never touches `%APPDATA%\walkie\state.json`.

`press`, `ui`, `snap` and `inject` use the S3's TEST hooks, so nobody has to touch it: `press` presses its keys, `ui` shows a screen or an approval as the bridge would, `snap` saves what the screen shows as a PNG, and `inject <wav>` feeds a 16 kHz recording to it as its microphone and prints the take that comes back (no API, no Claude).

`node bridge/bin/walkie.js` is the bridge itself. It runs until Ctrl+C, starts Claude Code in the active project of `bridge/projects.json` ahead of the first message (`claude.prewarm`) and waits for the S3 on USB. Hold the front key to talk and release it to send; both keys together for 3 s open the switch to on-the-beat. It runs the real `claude` (his login and quota) and calls the speech APIs, so there is no dry run except with `--command '<json array>'`, a stand-in for `claude` such as `'["node","C:/path/to/bridge/test/claude/fake-claude.js"]'` (a Windows path: the `/c/...` form of Git Bash is one node cannot open, and the stand-in then exits at once). `--port COMx` names the port and `--clean-env` is needed inside the Claude desktop app's own shell, as for `claude` above. `--inject <wav>` feeds a recording to the S3 as its microphone, as if the front key were held while it was said, waits for the whole turn (speech, Claude, the reply spoken) and stops: exit code 0 when Claude replied or the words were a command for walkie, 1 for unclear, a failure, a timeout or no S3. It calls the APIs and runs the real `claude`, so the first turn of a process costs about $0.4 and the session stays in the project's history. The bridge keeps the active project and the last session of each project in `%APPDATA%\walkie\state.json`; a stand-in cannot resume a real session, so set that file aside for a run with `--command`.

`node tools/gate-h.mjs [--port COMx] [--only "scene;scene"]` checks the screens and keys on the S3 with no hands and no API: 11 scenes that show a screen as the bridge would, press keys by TEST frames and check the buttons, verdicts, takes and header colours that come back. walkie must be running on the S3. Its last scene opens the switch to on-the-beat and closes it again; if it is interrupted with that screen open, a tap on the front key reboots the S3 into on-the-beat, and `node tools/boot.mjs app1` brings walkie back.

`flash.mjs` and `boot.mjs` take `--port COMx` (or `--port=COMx`); without it they use the `WALKIE_PORT` environment variable, else
COM8. `flash.mjs --skip-build` writes the last build without running PlatformIO first.

Only one program can hold the S3's port (COM8) at a time: stop the dev CLI before flashing or switching.
Takes recorded by `listen` are voice recordings; they go to `bridge/takes/`, which git ignores.
````

- [ ] **Step 2: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 714 tests, the tools' 17, and `122 cases, 588 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 3: Commit**

```powershell
git add docs/superpowers/specs/2026-09-29-walkie-design.md protocol/frames.md README.md
git commit -m @'
Task 14: docs: the README, the spec and frames.md say what plan 4 built and measured

The end-to-end runs on the real S3 (OpenAI and the real claude, then Gemini with OpenAI refused), gate H and the hand switch, the frames lost on the link and the pacing that follows from it; frames.md loses two stale numbers (the test FIFO is 16.4 s, a snapshot is 68 chunks of 960 bytes) and the UI frame is described as the tagged form it is.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
'@
```
