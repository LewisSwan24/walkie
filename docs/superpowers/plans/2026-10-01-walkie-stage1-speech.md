# Walkie Stage 1, plan 2 of 4: speech. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge turns a recorded take into words and an intent, and a line of text into loud, streamed speech on the S3, through OpenAI first and Gemini as the fallback, and every failure is handled and named on the console. It runs against WAV files and through developer commands (`hear`, `say`, `classify`); the firmware does not change.

**Architecture:** `bridge/src/speech` holds two adapters behind one small interface (OpenAI: transcribe, classify, speak; Gemini: hear-and-classify, speak) and a provider chain that applies the spec's per-step time limits, 5-minute skip windows and last resorts. `bridge/src/intent` validates what a model answers, holds the fixed-phrase fallback and writes the prompts. `bridge/src/config` reads the keys, `config.json` and `projects.json`. A streaming loudness chain sits between the speaking provider and `Link.playStream`, a new streaming form of `Link.playAudio`, so a reply starts playing on its first audio instead of after the last. Everything talks to the providers with plain `fetch`: no new dependency.

**Tech Stack:** Node 24 (ESM, `node:test`, global `fetch`); OpenAI `gpt-transcribe`, `gpt-6-luna` and `gpt-4o-mini-tts`; Gemini `gemini-3.8-flash`, `gemini-3.1-flash-lite` and `gemini-3.8-flash-tts` through `generateContent`. ffmpeg is used only by hand, to convert a WAV to 16 kHz.

**Spec:** `docs/superpowers/specs/2026-09-29-walkie-design.md`. This plan implements the `speech`, `intent` and configuration parts of §6.3, §6.5 and the speech rows of §8, and settles the three speech items of §10 (recognition at wrist distance, the Gemini fallback, loudness calibration). It needs the link of plan 1 (`Link`, `encodeWav`, `levels`, the recorded takes) and changes `Link` only by adding `playStream`.

**Stage 1 is four plans.** Each one leaves working, tested software:

1. **The link** (landed 2026-09-30): the protocol, the firmware's link and audio transport, the bridge's `link`, the flash and boot tools, a developer CLI, and mic gain calibration.
2. **Speech** (this plan): the OpenAI and Gemini adapters, the provider chain, the loudness chain, intent. Bridge only; it runs against WAV files.
3. **Claude**: the session manager, the permission MCP over HTTP, `<voice>` extraction. Bridge only; it runs against a fake `claude` and then the real one.
4. **The device experience**: the firmware's state machine, screens, key gestures, approvals and SWITCH_CONFIRM, the remaining TEST hooks, and the bridge's `main`, which joins everything into one voice turn.

Plans 3 and 4 are written once the plan before them has landed, so that each can use what the previous one measured.

Tasks 1, 11 and 12 are live: they call a provider for real, or open the S3's port, and they need him. Run them on the main thread. Tasks 2 to 10 are pure code and tests, and each can go to a worker.

## Global Constraints

- **Live steps need his fresh yes.** Only Tasks 1, 11 and 12 call OpenAI or Gemini for real or open COM8. Before each such step, ask him with the AskUserQuestion tool and say exactly what leaves the PC, where it goes, and which port opens. Only a clear yes in that answer counts. Not 「继续」 in chat, and not a yes given for a different step. Nothing in Tasks 2 to 10 touches the network, the keys file or a serial port: their tests run on a scripted `fetch`.
- **The keys are never read or printed by whoever runs this plan.** `%APPDATA%\walkie\keys.env` holds `OPENAI_API_KEY` and `GEMINI_API_KEY`; an environment variable of the same name overrides the file. The file sits outside every repo and its values are never logged. Only the programs in this plan read it, and they print which keys are present, never what they are. Never `cat` it, never paste it, never put a key in a commit, a test or a message. (Spec §6.3.)
- **Recordings are his voice.** `bridge/takes/` is gitignored and its files are never committed. A recording leaves this PC only in Task 11, only the twelve takes named there, and only after his yes for that step.
- Node 24, ESM, `node:test`. The bridge's dependencies stay `serialport` alone in this plan; OpenAI and Gemini are called with `fetch`. (Spec §6.3.)
- Provider chain, from spec §6.5:
  - Transcribe: `gpt-transcribe`, timeout 3 s plus 10% of the clip's length. Fallback `gemini-3.8-flash`, then `gemini-3.1-flash-lite`, hearing and classifying in one call, 8 s. Last resort 「没听清，再说一次」 and nothing sent.
  - Classify: `gpt-6-luna` with `reasoning_effort: "none"`, 3.5 s. Skipped when the transcript came from Gemini, which already classified it. Last resort: fixed phrases, then `to_claude`.
  - Speak: `gpt-4o-mini-tts`, voice `marin`, streamed, 3 s to first byte. Fallback `gemini-3.8-flash-tts`, 10 s. Last resort: text only, with a short tone.
  - A provider that fails is skipped for 5 minutes, and the console says which one and why.
- Transcribe: the WAV (16 kHz mono PCM16) minus the first 250 ms, with a `prompt` listing project names and common terms (Claude, npm, git, commit, PlatformIO, on-the-beat). Clips under 300 ms of speech, or an empty transcript, become 「没听清」 and go nowhere. While an approval is pending, a spoken reason is transcribed and never classified.
- Classify: a strict JSON schema `{intent, project, text}`; the intents are `to_claude`, `stop`, `continue`, `compact`, `new_session`, `switch_project`, `status`. The Gemini fallback uses the same prompt with the audio attached and a `transcript` field added.
- Speak: `response_format=pcm` (24 kHz), with `instructions` asking for natural, concise Mandarin at a slightly quick pace. Every chunk passes the loudness chain and then becomes AUDIO_DOWN frames under credit flow control (24 kHz mono PCM16, at most 960 bytes a frame). Gemini returns one WAV, which goes through the same chain.
- Loudness chain (streaming, plain JS): high-pass at 300 Hz; feed-forward compressor at about -34 dBFS, ratio 12, attack 1 ms, release 40 ms; fixed makeup gain; limiter at 0.98 of full scale with a few milliseconds of lookahead. The makeup gain is a constant calibrated to bring `marin` to the level of variant 5 (RMS about 5800 with peaks near full scale; the offline chain gave `marin` RMS 7561). Speaker volume 255 and `magnification` 2 on the device (spec D9).
- The S3 is COM8. Only one program can hold it at a time, and `say` holds it while it plays. Never flash it from this plan; `tools/flash.mjs` and `tools/boot.mjs` are the only tools that write to it, and only the boot slot (`boot.mjs app1`, and `app0` to put it back) is ever needed here.
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise. Commit by explicit path (`git add <files>`), never `git add -A` or `git commit -a`. No push and no amend.
- The `Co-Authored-By:` line of a commit names the model that actually wrote it. The commands below say Claude Sonnet 5.5; change the name if another model writes the commit, and a session on a model that is not Claude leaves the line out.

## Review Focus

What a person using this is most likely to meet, that the spec does not spell out. Each line names the tests that pin it (a test titled in a task below), and Task 11 checks the first against the real provider.

1. **A key held with nothing said** (a breath, a cough, the transcriber's 「嗯」): the device shows 「没听清，再说一次」 and nothing reaches Claude. Pinned in Task 9 by `a clip with under 300 ms left after the trim goes nowhere`, `an empty transcript is 没听清 and goes nowhere, not even to the fallback` and `a lone filler sound is 没听清 too, and a filler in front of a request is not`, and in Task 4 by `a lone filler sound is not an instruction, and a word after it is`.
2. **A command word inside a real request.** 「停止服务之前先备份数据库」 goes to Claude; it is never taken for a stop, even when no model can classify. A model answer that invents an intent, names a project that does not exist, or rewrites what he said is not trusted either. Pinned in Task 4 by `a command word inside a request is not a command`, `answers that are not answers are refused` and `to_claude falls back to the transcript when the text is empty or adds something`, and in Task 9 by `the work request that contains 停止 is never taken for a stop, even when no model can classify` and `an answer the validator rejects is not trusted: a fixed phrase decides, and the provider is not skipped`.
3. **A provider that hangs or answers 503.** One time limit is spent, then that one step of that one provider is skipped for 5 minutes (a failing voice must not silence the transcriber), and the console line names the provider and the reason without any key in it. Pinned in Task 9 by `a classifier that does not answer in 3.5 s is skipped for 5 minutes, then asked again`, `an OpenAI voice with no audio after 3 s gives way to Gemini, and only its speaking is skipped` and `when nobody can transcribe, the clip is 没听清 and the console says so, with no key in it`, and in Tasks 7 and 8 by `an error that echoes the key back leaves no key in the message`.
4. **The side key pressed while a reply is still streaming.** The provider's request is let go of at once, no more audio is queued, and the S3 is told to stop. Pinned in Task 5 by `stopping a reply that is playing sends STOP_AUDIO and an EOS, and lets go of the source` and in Task 9 by `stopping a reply that is playing lets go of the provider at once` and `a player that stops reading lets go of the provider too`.
5. **Audio that arrives in pieces of any size.** HTTP chunks do not respect 16-bit samples, and one stray byte must not turn every later sample into noise. Pinned in Task 2 by `chunk sizes do not change the result, even chunks that split a sample` and in Task 5 by `chunks that split samples still reach the S3 byte for byte, in even frames`.

## Files

```
README.md                                   Layout row, Prerequisites (the keys), the developer command list
bridge/config.json                          voice, models, time limits, loudness: the spec's numbers
bridge/projects.json                        the projects he can switch to by voice (a draft from his folders; he confirms it)
bridge/src/config/keys.js                   keys.env plus environment variables; never printed
bridge/src/config/config.js                 config.json over defaults, checked strictly
bridge/src/config/projects.js               projects.json: names, aliases, paths
bridge/src/intent/intent.js                 the answer schema; parsing and validating a model's answer
bridge/src/intent/phrases.js                fixed phrases (whole utterances only) and lone fillers
bridge/src/intent/prompts.js                the transcription, classification and Gemini hearing prompts
bridge/src/speech/errors.js, deadline.js    SpeechError and key redaction; time limits
bridge/src/speech/openai.js                 gpt-transcribe, gpt-6-luna, gpt-4o-mini-tts over fetch
bridge/src/speech/gemini.js                 hearing and classifying in one call, and speaking, over fetch
bridge/src/speech/loudness.js               the streaming loudness chain
bridge/src/speech/speech.js                 the provider chain: limits, skip windows, last resorts
bridge/src/audio/wav.js                     + decodeWav
bridge/src/link/link.js                     + playStream; playAudio is rebuilt on it
bridge/src/dev/speech-setup.js, hear.js, say.js, classify.js   developer commands
bridge/bin/walkie-dev.js                    + hear, say, classify and --provider
bridge/test/**                              new suites; test/fixtures/utterances.js is the classification set and test/speech/fake-fetch.js scripts `fetch`
docs/superpowers/specs/2026-09-29-walkie-design.md   §6.5 records three decisions of this plan; §10 closes its first three open items
```

---

### Task 1: Is Gemini answering? (live, gated)

**Files:**
- Create: `gemini-probe.mjs`, in the session's scratchpad directory (or any folder outside the repo). It is a one-off check and is never committed.

**Interfaces:**
- Consumes: nothing from the repo. The script reads `GEMINI_API_KEY` from the environment or from `%APPDATA%\walkie\keys.env` by itself and prints no key.
- Produces: one line per call (model, try, HTTP status, time, a short note) and one summary line per model. Task 12 copies the summary lines into spec §10.

**Why it is first.** On 29 Sep every Gemini flash model except `gemini-3.1-flash-lite` answered 503, and flash-lite took 7 s (spec §3, D6). He approved this plan on the condition that its first step measures whether that is still so. The answer tells you how far to trust the fallback while you build it. It changes no code unless a model name turns out to be wrong (Step 5).

- [ ] **Step 1: Write the probe**

It sends fixed English and Chinese sentences to `generateContent` on the three models the spec names (two to hear with, one to speak with), three tries each, and never a recording or a project name. The text models are asked for the word OK; the speech model is asked to say one short sentence, and the script only counts the bytes that come back.

```js
// Is Gemini's generateContent answering right now? Calls each model walkie may use a few times with a fixed
// sentence and prints the status and the time of every call. Nothing of his is sent: no recording, no project name.
// The key comes from GEMINI_API_KEY or from %APPDATA%\walkie\keys.env. It is never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const MODELS = [
  { name: 'gemini-3.8-flash', kind: 'text' },
  { name: 'gemini-3.1-flash-lite', kind: 'text' },
  { name: 'gemini-3.8-flash-tts', kind: 'speech' },
];

export function findKey(env = process.env, read = readFileSync) {
  if (env.GEMINI_API_KEY?.trim()) return env.GEMINI_API_KEY.trim();
  if (!env.APPDATA) return null;
  let text;
  try {
    text = read(join(env.APPDATA, 'walkie', 'keys.env'), 'utf8');
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1].replace(/^(["'])(.*)\1$/, '$2') || null;
  }
  return null;
}

function requestBody(kind) {
  if (kind === 'text') return { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] };
  return {
    contents: [{ role: 'user', parts: [{ text: '用自然、简洁、语速稍快的普通话说：你好，这是一次测试。' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  };
}

function describe(kind, ok, data, key) {
  if (!ok) return String(data?.error?.message ?? '').split(key).join('[key]').replace(/\s+/g, ' ').slice(0, 80);
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.text ?? p.inlineData);
  if (kind === 'text') return `answer: ${JSON.stringify(String(part?.text ?? '').trim().slice(0, 30))}`;
  const audio = part?.inlineData;
  return audio ? `audio: ${Buffer.from(audio.data, 'base64').length} bytes, ${audio.mimeType}` : 'no audio in the answer';
}

export async function probe({ key, fetch = globalThis.fetch, models = MODELS, tries = 3, timeoutMs = 20000, now = Date.now, log = console.log }) {
  const results = [];
  for (const { name, kind } of models) {
    for (let n = 1; n <= tries; n++) {
      const started = now();
      let status;
      let note = '';
      try {
        const res = await fetch(`${BASE}/models/${encodeURIComponent(name)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(requestBody(kind)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        note = describe(kind, res.ok, await res.json().catch(() => null), key);
      } catch (err) {
        status = err?.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : 'network error';
        note = String(err?.cause?.code ?? '').slice(0, 40);
      }
      const ms = now() - started;
      results.push({ model: name, try: n, status, ms, note });
      log(`${name.padEnd(22)} try ${n}: ${String(status).padEnd(16)} ${String(ms).padStart(6)} ms  ${note}`);
    }
  }
  return results;
}

export function summarise(results) {
  const byModel = new Map();
  for (const r of results) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel].map(([model, rs]) => {
    const good = rs.filter((r) => r.status === 200).map((r) => r.ms).sort((a, b) => a - b);
    const other = [...new Set(rs.filter((r) => r.status !== 200).map((r) => r.status))];
    const median = good.length ? `, median ${good[Math.floor(good.length / 2)]} ms` : '';
    return `${model}: ${good.length} of ${rs.length} answered 200${median}${other.length ? `; otherwise ${other.join(', ')}` : ''}`;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = findKey();
  if (!key) {
    console.log('GEMINI_API_KEY is not set (environment variable or %APPDATA%\\walkie\\keys.env). Nothing was sent.');
    process.exit(2);
  }
  console.log('GEMINI_API_KEY is set. Three tries per model, fixed test sentences only.');
  const results = await probe({ key });
  console.log('');
  for (const line of summarise(results)) console.log(line);
}
```

- [ ] **Step 2: Check the syntax**

Run: `node --check <scratchpad>\gemini-probe.mjs`
Expected: no output and exit code 0. This step sends nothing.

- [ ] **Step 3: Ask for his yes**

Ask him with the AskUserQuestion tool. What leaves the PC: 9 small requests to Google's Gemini API (three tries on each of `gemini-3.8-flash`, `gemini-3.1-flash-lite` and `gemini-3.8-flash-tts`), each carrying a fixed test sentence, with his `GEMINI_API_KEY` in the request header. Nothing recorded and nothing about his projects. It costs a few cents at most. Suggested question: 「现在对 Gemini 发 9 次固定的测试句子（不含你的录音和项目信息），看它还是不是 503，可以吗？」 Do not run Step 4 without a yes.

- [ ] **Step 4: Run the probe**

Run: `node <scratchpad>\gemini-probe.mjs`
Allow up to four minutes: a call that hangs is cut off after 20 s.
Expected: a line `GEMINI_API_KEY is set. Three tries per model, fixed test sentences only.`, nine lines of the form `gemini-3.8-flash       try 1: 503                  1432 ms  …`, a blank line, then one summary line per model, for example `gemini-3.1-flash-lite: 3 of 3 answered 200, median 6900 ms`. If the first line says the key is not set, nothing was sent: tell him, and go on to Task 3, because nothing before Task 11 needs Gemini.

- [ ] **Step 5: Read the result, and keep the three summary lines**

- Some 200s: the fallback is usable. Go on.
- 503s or timeouts on the flash models and 200s on `gemini-3.1-flash-lite`: the same picture as 29 Sep. Go on; the chain is built for exactly this (hear with the flash model, then flash-lite).
- 404 on a model: that name in spec §6.5 is out of date. Stop and ask him which model to use instead. Do not guess a name. The names are in `bridge/config.json` (Task 3), under `models`, and Task 12 fixes the spec.
- 400, 401 or 403: the key is wrong or has no access to that model. Tell him, then go on; nothing before Task 11 needs Gemini.

There is no commit in this task: the repo has not changed. Keep the summary lines for Task 12.

---

### Task 2: The loudness chain

**Files:**
- Create: `bridge/src/speech/loudness.js`
- Test: `bridge/test/speech/loudness.test.js`

**Interfaces:**
- Consumes: nothing. The chain is plain JS with no imports.
- Produces:
  - `DEFAULT_LOUDNESS`: `{highpassHz: 300, thresholdDb: -34, ratio: 12, attackMs: 1, releaseMs: 40, makeupDb: 27.5, ceiling: 0.98, lookaheadMs: 5}`, the same numbers as `loudness` in `bridge/config.json` (Task 3), which copies them from here
  - `class LoudnessChain` with `constructor(settings = {}, rate = 24000)`, `push(chunk: Uint8Array): Buffer` and `flush(): Buffer`. It takes PCM16 little-endian mono in chunks of any size, even a chunk that splits a sample, and returns whole samples. The limiter delays the audio by `lookaheadMs`, and `flush()` returns that tail, so the output is exactly as long as the input (a dangling odd byte at the very end is dropped).
  - `processAll(pcm, settings, rate = 24000): Buffer`: the chain over one buffer (offline use and tests)
  - `applyLoudness(source, settings, rate = 24000): AsyncGenerator<Buffer>`: the chain over an async or sync iterable of chunks; Task 9 puts it after the speaking provider

The spec's chain is high-pass at 300 Hz, a feed-forward compressor at about -34 dBFS (ratio 12, attack 1 ms, release 40 ms), a fixed makeup gain and a limiter at 0.98 of full scale with a few milliseconds of lookahead. A stream cannot be normalised to its own peak the way ffmpeg's `normalize` step did for variant 5, so the makeup gain is a constant. 27.5 dB was calibrated on the Stage 0 `marin` sample (6.55 s at 24 kHz): this chain gives RMS 7526 and peak 32113, where the offline chain behind variant 5 gave RMS 7561 and peak 32000. Variant 5 itself was a quieter normalisation (RMS 5802), and he judges by ear, so Task 12 measures a fresh `marin` reply and has him listen on the S3 with magnification 2; if it distorts, `makeupDb` is the one number to lower, in `bridge/config.json` and in `DEFAULT_LOUDNESS` above (Task 12 says how).

- [ ] **Step 1: Write the failing test**

Create `bridge/test/speech/loudness.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOUDNESS, LoudnessChain, applyLoudness, processAll } from '../../src/speech/loudness.js';

const RATE = 24000;

function sine(hz, amplitude, secs) {
  const n = Math.round(RATE * secs);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)), i * 2);
  return b;
}

// Peak and RMS of the last `secs` seconds, after the filters have settled.
function tailStats(pcm, secs) {
  const n = Math.round(RATE * secs);
  let peak = 0;
  let sum = 0;
  for (let i = pcm.length / 2 - n; i < pcm.length / 2; i++) {
    const v = pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return { peak, rms: Math.sqrt(sum / n) };
}
const db = (ratio) => 20 * Math.log10(ratio);

// A chain with the compressor and limiter out of the way, so one stage can be measured alone.
const FLAT = { ratio: 1, makeupDb: 0, ceiling: 1, highpassHz: 20 };

test('the high-pass cuts 50 Hz by about 31 dB and leaves 3 kHz alone', () => {
  const settings = { ...FLAT, highpassHz: 300 };
  const low = tailStats(processAll(sine(50, 8000, 0.5), settings), 0.25).rms / tailStats(sine(50, 8000, 0.5), 0.25).rms;
  const high = tailStats(processAll(sine(3000, 8000, 0.5), settings), 0.25).rms / tailStats(sine(3000, 8000, 0.5), 0.25).rms;
  assert.ok(Math.abs(db(low) + 31) < 1.5, `50 Hz changed by ${db(low).toFixed(1)} dB`);
  assert.ok(Math.abs(db(high)) < 0.3, `3 kHz changed by ${db(high).toFixed(1)} dB`);
});

test('the compressor takes a loud tone down by (level - threshold) x (1 - 1/ratio)', () => {
  // 10000 is -10.3 dBFS, 23.7 dB over the -34 dB threshold: 21.7 dB of reduction, so a peak near -32 dBFS (823)
  const out = tailStats(processAll(sine(1000, 10000, 0.5), { ...FLAT, ratio: 12, thresholdDb: -34 }), 0.25);
  assert.ok(Math.abs(db(out.peak / 823)) < 1.5, `peak ${out.peak}, expected about 823`);
});

test('below the threshold the compressor does nothing, and makeup gain is a constant', () => {
  const quiet = sine(1000, 300, 0.5); // -40.8 dBFS
  const same = tailStats(processAll(quiet, { ...FLAT, ratio: 12, thresholdDb: -34 }), 0.25);
  assert.ok(Math.abs(db(same.peak / 300)) < 0.3, `peak ${same.peak}, expected about 300`);
  const louder = tailStats(processAll(quiet, { ...FLAT, ratio: 12, thresholdDb: -34, makeupDb: 20 }), 0.25);
  assert.ok(Math.abs(db(louder.peak / 3000)) < 0.3, `peak ${louder.peak}, expected about 3000`);
});

// Deterministic noise bursts that start and stop abruptly, so the limiter sees hard onsets.
function bursts(secs) {
  const n = Math.round(RATE * secs);
  const b = Buffer.alloc(n * 2);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const loud = Math.floor(i / 1200) % 3 === 1;
    b.writeInt16LE(loud ? (seed % 40001) - 20000 : (seed % 201) - 100, i * 2);
  }
  return b;
}

test('the limiter never passes its ceiling, even when a burst needs 40 dB of reduction', () => {
  const out = processAll(bursts(1), { ...FLAT, makeupDb: 40, ceiling: 0.98 });
  let peak = 0;
  for (let i = 0; i < out.length; i += 2) peak = Math.max(peak, Math.abs(out.readInt16LE(i)));
  assert.ok(peak <= Math.ceil(0.98 * 32768), `peak ${peak}`); // rounding can land half a step over
  assert.ok(peak > 30000, `the limiter should use the headroom, peak ${peak}`);
});

test('the default chain keeps every sample under 0.98 of full scale', () => {
  const out = processAll(bursts(1));
  for (let i = 0; i < out.length; i += 2) assert.ok(Math.abs(out.readInt16LE(i)) <= Math.ceil(0.98 * 32768));
});

test('the output is as long as the input, for lengths shorter and longer than the lookahead', () => {
  for (const samples of [0, 1, 50, 119, 120, 121, 1000, 4801]) {
    const input = sine(440, 5000, samples / RATE);
    assert.equal(processAll(input, DEFAULT_LOUDNESS).length, input.length, `${samples} samples`);
  }
});

test('chunk sizes do not change the result, even chunks that split a sample', () => {
  const input = Buffer.concat([sine(200, 6000, 0.1), bursts(0.1), sine(1500, 300, 0.1)]);
  const whole = processAll(input);
  for (const size of [1, 2, 3, 7, 960, 4801]) {
    const chain = new LoudnessChain();
    const parts = [];
    for (let i = 0; i < input.length; i += size) parts.push(chain.push(input.subarray(i, i + size)));
    parts.push(chain.flush());
    assert.ok(Buffer.concat(parts).equals(whole), `chunks of ${size} bytes differ`);
  }
});

test('silence in, silence out', () => {
  const out = processAll(Buffer.alloc(9600));
  assert.equal(out.length, 9600);
  assert.ok(out.equals(Buffer.alloc(9600)));
});

test('applyLoudness yields whole samples and the same audio as processAll', async () => {
  const input = Buffer.concat([sine(300, 4000, 0.2), bursts(0.1)]);
  async function* source() {
    for (let i = 0; i < input.length; i += 1001) yield input.subarray(i, i + 1001); // odd sizes
  }
  const chunks = [];
  for await (const c of applyLoudness(source())) {
    assert.equal(c.length % 2, 0);
    chunks.push(c);
  }
  assert.ok(Buffer.concat(chunks).equals(processAll(input)));
});

test('a dangling odd byte at the end of the stream is dropped, not turned into noise', () => {
  const chain = new LoudnessChain();
  const a = chain.push(Buffer.alloc(9601));
  const b = chain.flush();
  assert.equal(a.length + b.length, 9600);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test bridge/test/speech/loudness.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/speech/loudness.js`.

- [ ] **Step 3: Write the chain**

Create `bridge/src/speech/loudness.js`:

```js
// The loudness chain for spoken replies (spec 6.5): high-pass, feed-forward compressor, constant makeup gain,
// lookahead limiter. It works on a stream: PCM16 little-endian mono in any chunk sizes (a chunk may even split
// a sample), whole samples out. The limiter delays the audio by `lookaheadMs`; flush() returns that tail.

export const DEFAULT_LOUDNESS = {
  highpassHz: 300,
  thresholdDb: -34,
  ratio: 12,
  attackMs: 1,
  releaseMs: 40,
  makeupDb: 27.5, // calibrated on the Stage 0 marin sample: RMS 7526, peak 32113 (the offline chain gave 7561 and 32000)
  ceiling: 0.98,
  lookaheadMs: 5,
};

const FULL_SCALE = 32768;

export class LoudnessChain {
  #rate;
  #s;
  // high-pass biquad
  #b0; #b1; #b2; #a1; #a2;
  #x1 = 0; #x2 = 0; #y1 = 0; #y2 = 0;
  // compressor
  #atk; #rel; #env = 0; #makeup;
  // limiter: delay line, needed-gain window, and its moving average
  #ceilingAbs;
  #len; // window length in samples; the audio is delayed by len - 1
  #delay; #need; #avg; #pos = 0; #avgSum;
  #seen = 0; // samples pushed so far
  #carry = null; // a dangling odd byte between chunks

  constructor(settings = {}, rate = 24000) {
    this.#rate = rate;
    this.#s = { ...DEFAULT_LOUDNESS, ...settings };
    const s = this.#s;
    const w0 = (2 * Math.PI * s.highpassHz) / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const c = Math.cos(w0);
    const a0 = 1 + alpha;
    this.#b0 = (1 + c) / 2 / a0;
    this.#b1 = -(1 + c) / a0;
    this.#b2 = this.#b0;
    this.#a1 = (-2 * c) / a0;
    this.#a2 = (1 - alpha) / a0;
    this.#atk = Math.exp(-1 / ((s.attackMs / 1000) * rate));
    this.#rel = Math.exp(-1 / ((s.releaseMs / 1000) * rate));
    this.#makeup = 10 ** (s.makeupDb / 20);
    this.#ceilingAbs = s.ceiling * FULL_SCALE;
    this.#len = Math.max(1, Math.round((s.lookaheadMs / 1000) * rate));
    this.#delay = new Float64Array(this.#len);
    this.#need = new Float64Array(this.#len).fill(1);
    this.#avg = new Float64Array(this.#len).fill(1);
    this.#avgSum = this.#len;
  }

  // One sample through the chain. Returns the delayed, limited sample, or null while the delay line fills.
  #step(x) {
    const s = this.#s;
    // high-pass (direct form 1)
    const hp = this.#b0 * x + this.#b1 * this.#x1 + this.#b2 * this.#x2 - this.#a1 * this.#y1 - this.#a2 * this.#y2;
    this.#x2 = this.#x1;
    this.#x1 = x;
    this.#y2 = this.#y1;
    this.#y1 = hp;
    // compressor: a peak envelope with separate attack and release, gain computed in dB
    const a = Math.abs(hp) / FULL_SCALE;
    const k = a > this.#env ? this.#atk : this.#rel;
    this.#env = k * this.#env + (1 - k) * a;
    const levelDb = this.#env > 1e-6 ? 20 * Math.log10(this.#env) : -120;
    const over = levelDb - s.thresholdDb;
    const gain = over > 0 ? 10 ** ((-over * (1 - 1 / s.ratio)) / 20) : 1;
    const y = hp * gain * this.#makeup;
    // limiter: the gain each sample needs, its minimum over the window, then the average of that minimum,
    // so the gain is already down when the sample that needs it leaves the delay line
    const p = this.#pos;
    const ay = Math.abs(y);
    this.#need[p] = ay > this.#ceilingAbs ? this.#ceilingAbs / ay : 1;
    let min = 1;
    for (let i = 0; i < this.#len; i++) if (this.#need[i] < min) min = this.#need[i];
    this.#avgSum += min - this.#avg[p];
    this.#avg[p] = min;
    this.#delay[p] = y;
    const out = this.#delay[(p + 1) % this.#len] * (this.#avgSum / this.#len); // the sample pushed len - 1 steps ago
    this.#pos = (p + 1) % this.#len;
    this.#seen++;
    return this.#seen >= this.#len ? out : null;
  }

  #toBytes(samples) {
    const b = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), i * 2);
    }
    return b;
  }

  push(chunk) {
    let buf = chunk;
    if (this.#carry !== null) {
      buf = Buffer.concat([Buffer.from([this.#carry]), chunk]);
      this.#carry = null;
    }
    if (buf.length % 2 === 1) {
      this.#carry = buf[buf.length - 1];
      buf = buf.subarray(0, buf.length - 1);
    }
    const out = [];
    for (let i = 0; i < buf.length; i += 2) {
      const v = this.#step(buf.readInt16LE(i));
      if (v !== null) out.push(v);
    }
    return this.#toBytes(out);
  }

  // The samples still inside the limiter's delay line. A dangling odd byte is dropped.
  flush() {
    const out = [];
    for (let i = 0; i < this.#len - 1; i++) {
      const v = this.#step(0);
      if (v !== null) out.push(v);
    }
    this.#carry = null;
    return this.#toBytes(out);
  }
}

// The same chain over a whole buffer (offline calibration and tests).
export function processAll(pcm, settings, rate = 24000) {
  const chain = new LoudnessChain(settings, rate);
  return Buffer.concat([chain.push(pcm), chain.flush()]);
}

// The chain over an async stream of PCM16 chunks.
export async function* applyLoudness(source, settings, rate = 24000) {
  const chain = new LoudnessChain(settings, rate);
  for await (const chunk of source) {
    const out = chain.push(chunk);
    if (out.length > 0) yield out;
  }
  const tail = chain.flush();
  if (tail.length > 0) yield tail;
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/speech/loudness.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/speech/loudness.js bridge/test/speech/loudness.test.js
git commit -m "Bridge: streaming loudness chain for spoken replies" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Keys, settings and projects

**Files:**
- Create: `bridge/src/config/keys.js`
- Create: `bridge/src/config/config.js`
- Create: `bridge/src/config/projects.js`
- Create: `bridge/config.json`
- Create: `bridge/projects.json`
- Test: `bridge/test/config/keys.test.js`
- Test: `bridge/test/config/config.test.js`
- Test: `bridge/test/config/projects.test.js`

**Interfaces:**
- Consumes: `DEFAULT_LOUDNESS` (Task 2): `DEFAULT_CONFIG.loudness` is a copy of it, which is why the chain comes first.
- Produces:
  - `KEY_NAMES` (`['OPENAI_API_KEY', 'GEMINI_API_KEY']`)
  - `defaultKeysFile(env = process.env): string | null` (`%APPDATA%\walkie\keys.env`, or `null` without `APPDATA`)
  - `parseKeysEnv(text): {NAME: value}` (`KEY=value` lines; blank lines, `#` comments, CRLF and a BOM are fine; values may be quoted)
  - `loadKeys({env, file, read}?): {OPENAI_API_KEY?: string, GEMINI_API_KEY?: string}`: only the keys that are present, an environment variable winning over the file, a missing file meaning no keys, and an unreadable file an `Error` that names the file and never shows content
  - `describeKeys(keys): string`, for example `OPENAI_API_KEY set, GEMINI_API_KEY missing`
  - `DEFAULT_CONFIG`, `defaultConfigFile()`, `loadConfig({file, read}?): config`, where `config` has `voice`, `geminiVoice`, `ttsInstructions`, `models {transcribe, classify, classifyEffort, tts, geminiHear[], geminiTts}`, `timeoutsMs {transcribeBase, classify, speakFirstByte, speakIdle, geminiHear, geminiSpeak}`, `transcribeClipFraction`, `trimStartMs`, `minSpeechMs`, `cooldownMs` and `loudness {highpassHz, thresholdDb, ratio, attackMs, releaseMs, makeupDb, ceiling, lookaheadMs}`. A setting the code does not know, one of the wrong type, or one out of range is an `Error` that names it.
  - `defaultProjectsFile()`, `normalizeName(text)`, `validateProjects(list): [{name, aliases, path}]`, `loadProjects({file, read}?)`, `findProject(projects, text): project | null` (by name or alias; case, spaces, hyphens and underscores do not count), `projectTable(projects): string` (`on-the-beat: 手环项目, on the beat; …`, for the classifier prompt) and `projectWords(projects): string[]` (every name and alias, for the transcription prompt)

Every number in `bridge/config.json` is the spec's (§6.5) except `speakIdle`: a voice that goes silent for this long in the middle of a reply ends the reply with a timeout (Task 9), a limit the spec leaves out. `makeupDb` is calibrated in Task 2 and checked against the real `marin` in Task 12.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/config/keys.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultKeysFile, describeKeys, loadKeys, parseKeysEnv } from '../../src/config/keys.js';

const OPENAI = 'sk-test-openai-0123456789';
const GEMINI = 'AIza-test-gemini-0123456789';

test('parses KEY=value lines, skipping comments, blanks, CRLF and a BOM', () => {
  const BOM = String.fromCharCode(0xfeff);
  // the BOM sits in front of the first assignment, where a parser that does not strip it would lose the key
  const text = `${BOM}OPENAI_API_KEY=${OPENAI}\r\n# keys for walkie\r\n\r\n  GEMINI_API_KEY = ${GEMINI}  \r\n`;
  assert.deepEqual(parseKeysEnv(text), { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI });
});

test('quotes and an export prefix are accepted, and an unquoted trailing comment is cut', () => {
  const text = `export OPENAI_API_KEY="${OPENAI}"\nGEMINI_API_KEY='${GEMINI}'\nOTHER=abc # note\nQUOTED="a # b"\n`;
  assert.deepEqual(parseKeysEnv(text), { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI, OTHER: 'abc', QUOTED: 'a # b' });
});

test('lines that are not assignments are ignored', () => {
  assert.deepEqual(parseKeysEnv('just some words\n=novalue\nA=1\n'), { A: '1' });
});

test('an environment variable overrides the file, and only the two keys are returned', () => {
  const file = `OPENAI_API_KEY=from-file\nGEMINI_API_KEY=${GEMINI}\nUNRELATED=x\n`;
  const keys = loadKeys({ env: { OPENAI_API_KEY: OPENAI }, file: 'keys.env', read: () => file });
  assert.deepEqual(keys, { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI });
});

test('an empty environment variable does not hide the file', () => {
  const keys = loadKeys({ env: { OPENAI_API_KEY: '  ' }, file: 'keys.env', read: () => `OPENAI_API_KEY=${OPENAI}\n` });
  assert.deepEqual(keys, { OPENAI_API_KEY: OPENAI });
});

test('a missing keys file is not an error: no keys', () => {
  const read = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };
  assert.deepEqual(loadKeys({ env: {}, file: 'nope.env', read }), {});
});

test('an unreadable keys file is an error that names the file and never shows content', () => {
  const read = () => {
    throw Object.assign(new Error(`EACCES while reading ${OPENAI}`), { code: 'EACCES' });
  };
  assert.throws(
    () => loadKeys({ env: {}, file: 'C:/x/keys.env', read }),
    (err) => err.message.includes('C:/x/keys.env') && err.message.includes('EACCES') && !err.message.includes(OPENAI),
  );
});

test('no APPDATA means no default keys file', () => {
  assert.equal(defaultKeysFile({}), null);
  assert.match(defaultKeysFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), /walkie[\\/]keys\.env$/);
  assert.deepEqual(loadKeys({ env: {} }), {});
});

test('describeKeys says which keys are present and never what they are', () => {
  const said = describeKeys({ OPENAI_API_KEY: OPENAI });
  assert.equal(said, 'OPENAI_API_KEY set, GEMINI_API_KEY missing');
  assert.ok(!said.includes(OPENAI));
});
```

Create `bridge/test/config/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, defaultConfigFile, loadConfig } from '../../src/config/config.js';

const fileWith = (object) => ({ read: () => JSON.stringify(object) });
const missing = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
const shape = (o) => Object.entries(o).map(([k, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? [k, shape(v)] : k));

test('without a config file every setting has its default', () => {
  assert.deepEqual(loadConfig({ read: missing }), DEFAULT_CONFIG);
});

test('the spec numbers are the defaults', () => {
  assert.equal(DEFAULT_CONFIG.models.transcribe, 'gpt-transcribe');
  assert.equal(DEFAULT_CONFIG.models.classify, 'gpt-6-luna');
  assert.equal(DEFAULT_CONFIG.models.classifyEffort, 'none');
  assert.equal(DEFAULT_CONFIG.models.tts, 'gpt-4o-mini-tts');
  assert.deepEqual(DEFAULT_CONFIG.models.geminiHear, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  assert.equal(DEFAULT_CONFIG.models.geminiTts, 'gemini-3.8-flash-tts');
  assert.equal(DEFAULT_CONFIG.voice, 'marin');
  assert.deepEqual(DEFAULT_CONFIG.timeoutsMs, { transcribeBase: 3000, classify: 3500, speakFirstByte: 3000, speakIdle: 3000, geminiHear: 8000, geminiSpeak: 10000 });
  assert.equal(DEFAULT_CONFIG.transcribeClipFraction, 0.1);
  assert.equal(DEFAULT_CONFIG.trimStartMs, 250);
  assert.equal(DEFAULT_CONFIG.minSpeechMs, 300);
  assert.equal(DEFAULT_CONFIG.cooldownMs, 5 * 60 * 1000);
  assert.deepEqual(
    { ...DEFAULT_CONFIG.loudness, makeupDb: 0 },
    { highpassHz: 300, thresholdDb: -34, ratio: 12, attackMs: 1, releaseMs: 40, makeupDb: 0, ceiling: 0.98, lookaheadMs: 5 },
  );
});

test('the committed bridge/config.json is valid and lists every setting', () => {
  const text = readFileSync(defaultConfigFile(), 'utf8');
  assert.deepEqual(shape(JSON.parse(text)), shape(DEFAULT_CONFIG));
  assert.doesNotThrow(() => loadConfig());
});

test('a file overrides single settings and leaves the rest alone', () => {
  const c = loadConfig(fileWith({ voice: 'cedar', timeoutsMs: { classify: 5000 }, loudness: { makeupDb: 24 } }));
  assert.equal(c.voice, 'cedar');
  assert.equal(c.timeoutsMs.classify, 5000);
  assert.equal(c.timeoutsMs.transcribeBase, 3000);
  assert.equal(c.loudness.makeupDb, 24);
  assert.equal(c.loudness.ratio, 12);
});

test('a setting the code does not know is an error that names it', () => {
  assert.throws(() => loadConfig(fileWith({ voce: 'cedar' })), /unknown setting voce/);
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { clasify: 1 } })), /unknown setting timeoutsMs\.clasify/);
});

test('a setting of the wrong type is an error', () => {
  assert.throws(() => loadConfig(fileWith({ voice: 7 })), /voice must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ voice: '' })), /voice must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { classify: '3500' } })), /timeoutsMs\.classify must be a number/);
  assert.throws(() => loadConfig(fileWith({ models: { geminiHear: 'gemini-3.8-flash' } })), /models\.geminiHear must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ models: { geminiHear: [] } })), /models\.geminiHear must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ loudness: 5 })), /loudness must be an object/);
});

test('numbers outside their range are errors that show the value', () => {
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { classify: 0 } })), /timeoutsMs\.classify must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ loudness: { ratio: 0.5 } })), /loudness\.ratio must be 1 or more/);
  assert.throws(() => loadConfig(fileWith({ loudness: { ceiling: 1.5 } })), /loudness\.ceiling/);
  assert.throws(() => loadConfig(fileWith({ transcribeClipFraction: 2 })), /transcribeClipFraction/);
  assert.throws(() => loadConfig(fileWith({ cooldownMs: -1 })), /cooldownMs/);
});

test('a file that is not JSON is an error that names the file but not its content', () => {
  assert.throws(
    () => loadConfig({ file: 'C:/x/config.json', read: () => '{ "voice": "secret-ish", ' }),
    (err) => err.message.includes('C:/x/config.json') && err.message.includes('not valid JSON') && !err.message.includes('secret-ish'),
  );
});

test('an unreadable config file is an error', () => {
  const read = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => loadConfig({ file: 'C:/x/config.json', read }), /cannot read the config file C:\/x\/config\.json \(EACCES\)/);
});
```

Create `bridge/test/config/projects.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProject, loadProjects, normalizeName, projectTable, projectWords, validateProjects } from '../../src/config/projects.js';

const LIST = [
  { name: 'on-the-beat', aliases: ['手环项目', 'on the beat'], path: 'C:/p/on-the-beat' },
  { name: 'verbatim', aliases: [], path: 'C:/p/verbatim' },
  { name: 'walkie', aliases: ['语音助手'], path: 'C:/p/walkie' },
];

test('the committed bridge/projects.json is valid', () => {
  const projects = loadProjects();
  assert.ok(projects.length >= 1);
  assert.ok(projects.some((p) => p.name === 'walkie'));
});

test('names are compared without case, spaces, hyphens or underscores', () => {
  assert.equal(normalizeName('On The Beat'), 'onthebeat');
  assert.equal(normalizeName('on-the-beat'), 'onthebeat');
  assert.equal(normalizeName('on_the_beat.'), 'onthebeat');
});

test('findProject answers to the name and to every alias, and to nothing else', () => {
  const projects = validateProjects(LIST);
  assert.equal(findProject(projects, 'on the beat').name, 'on-the-beat');
  assert.equal(findProject(projects, 'On-The-Beat').name, 'on-the-beat');
  assert.equal(findProject(projects, '手环项目').name, 'on-the-beat');
  assert.equal(findProject(projects, '语音助手').name, 'walkie');
  assert.equal(findProject(projects, 'verbatim').name, 'verbatim');
  assert.equal(findProject(projects, 'beat'), null);
  assert.equal(findProject(projects, ''), null);
  assert.equal(findProject(projects, null), null);
});

test('projectTable and projectWords feed the prompts', () => {
  const projects = validateProjects(LIST);
  assert.equal(projectTable(projects), 'on-the-beat: 手环项目, on the beat; verbatim; walkie: 语音助手');
  assert.deepEqual(projectWords(projects), ['on-the-beat', '手环项目', 'on the beat', 'verbatim', 'walkie', '语音助手']);
});

test('bad project lists are refused with the project named', () => {
  assert.throws(() => validateProjects([]), /at least one project/);
  assert.throws(() => validateProjects({}), /at least one project/);
  assert.throws(() => validateProjects([{ name: 'a b', aliases: [], path: 'C:/x' }]), /projects\[0\]\.name/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: 'x', path: 'C:/x' }]), /a\.aliases/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: [''], path: 'C:/x' }]), /a\.aliases/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: [], path: 'relative/dir' }]), /a\.path must be an absolute path/);
});

test('one word may not name two projects', () => {
  const clash = [
    { name: 'alpha', aliases: ['the tool'], path: 'C:/a' },
    { name: 'beta', aliases: ['The-Tool'], path: 'C:/b' },
  ];
  assert.throws(() => validateProjects(clash), /"The-Tool" names both alpha and beta/);
  assert.throws(() => validateProjects([{ name: 'alpha', aliases: [], path: 'C:/a' }, { name: 'Alpha', aliases: [], path: 'C:/b' }]), /names both/);
});

test('loadProjects reports unreadable and malformed files without echoing content', () => {
  const eacces = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => loadProjects({ file: 'C:/x/projects.json', read: eacces }), /cannot read the projects file C:\/x\/projects\.json \(EACCES\)/);
  assert.throws(() => loadProjects({ file: 'C:/x/projects.json', read: () => '[ {' }), /C:\/x\/projects\.json is not valid JSON/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/config/keys.test.js bridge/test/config/config.test.js bridge/test/config/projects.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config/keys.js`, `src/config/config.js` and `src/config/projects.js`.

- [ ] **Step 3: Write the modules and the two settings files**

Create `bridge/src/config/keys.js`:

```js
// API keys: %APPDATA%\walkie\keys.env, where an environment variable of the same name wins (spec 6.3).
// The values are returned to the code that calls the providers and go nowhere else: not into errors, not into logs.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const KEY_NAMES = ['OPENAI_API_KEY', 'GEMINI_API_KEY'];

export function defaultKeysFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'keys.env') : null;
}

// KEY=value lines (trim() also drops a BOM in front of the first one); blank lines and # comments are skipped; a value may be quoted, and an unquoted one may end in a # comment.
export function parseKeysEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    value = quoted ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

export function loadKeys({ env = process.env, file = defaultKeysFile(env), read = readFileSync } = {}) {
  let fromFile = {};
  if (file) {
    try {
      fromFile = parseKeysEnv(read(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read the keys file ${file} (${err.code ?? 'error'})`);
    }
  }
  const keys = {};
  for (const name of KEY_NAMES) {
    const value = (env[name] ?? '').trim() || (fromFile[name] ?? '').trim();
    if (value) keys[name] = value;
  }
  return keys;
}

// What the console may say about the keys: which are present, never what they are.
export function describeKeys(keys) {
  return KEY_NAMES.map((name) => `${name} ${keys[name] ? 'set' : 'missing'}`).join(', ');
}
```

Create `bridge/src/config/config.js`:

```js
// bridge/config.json: voice, models, timeouts and loudness settings (spec 6.3). Every setting has a default here,
// the file only overrides, and a setting the code does not know is an error, so a typo cannot pass silently.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOUDNESS } from '../speech/loudness.js';

export const DEFAULT_CONFIG = {
  voice: 'marin',
  geminiVoice: 'Kore',
  ttsInstructions: '用自然、亲切、简洁的普通话说，语速稍快。',
  models: {
    transcribe: 'gpt-transcribe',
    classify: 'gpt-6-luna',
    classifyEffort: 'none',
    tts: 'gpt-4o-mini-tts',
    geminiHear: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    geminiTts: 'gemini-3.8-flash-tts',
  },
  timeoutsMs: {
    transcribeBase: 3000, // plus transcribeClipFraction of the clip's length
    classify: 3500,
    speakFirstByte: 3000,
    speakIdle: 3000, // the longest silence tolerated between two chunks of a streaming reply
    geminiHear: 8000, // per model
    geminiSpeak: 10000,
  },
  transcribeClipFraction: 0.1,
  trimStartMs: 250, // the mic's start-up transient
  minSpeechMs: 300,
  cooldownMs: 300_000, // a provider that fails is skipped this long
  loudness: { ...DEFAULT_LOUDNESS },
};

// Checks on the merged settings, by dotted path. `*` stands for any key of that group.
const RULES = [
  ['timeoutsMs.*', (v) => v > 0, 'must be more than 0'],
  ['transcribeClipFraction', (v) => v >= 0 && v <= 1, 'must be between 0 and 1'],
  ['trimStartMs', (v) => v >= 0, 'must be 0 or more'],
  ['minSpeechMs', (v) => v >= 0, 'must be 0 or more'],
  ['cooldownMs', (v) => v >= 0, 'must be 0 or more'],
  ['loudness.highpassHz', (v) => v > 0 && v < 12000, 'must be between 0 and 12000'],
  ['loudness.ratio', (v) => v >= 1, 'must be 1 or more'],
  ['loudness.attackMs', (v) => v > 0, 'must be more than 0'],
  ['loudness.releaseMs', (v) => v > 0, 'must be more than 0'],
  ['loudness.ceiling', (v) => v > 0 && v <= 1, 'must be more than 0 and at most 1'],
  ['loudness.lookaheadMs', (v) => v >= 0, 'must be 0 or more'],
];

export function defaultConfigFile() {
  return fileURLToPath(new URL('../../config.json', import.meta.url));
}

function merge(defaults, override, at) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error(`config: ${at || 'the file'} must be an object`);
  }
  const out = {};
  for (const key of Object.keys(override)) {
    if (!(key in defaults)) throw new Error(`config: unknown setting ${at ? `${at}.` : ''}${key}`);
  }
  for (const [key, base] of Object.entries(defaults)) {
    const path = at ? `${at}.${key}` : key;
    const value = key in override ? override[key] : base;
    if (Array.isArray(base)) {
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || !v)) {
        throw new Error(`config: ${path} must be a list of names`);
      }
      out[key] = [...value];
    } else if (base !== null && typeof base === 'object') {
      out[key] = merge(base, value, path);
    } else {
      if (typeof value !== typeof base || (typeof value === 'number' && !Number.isFinite(value)) || value === '') {
        throw new Error(`config: ${path} must be ${typeof base === 'number' ? 'a number' : 'a non-empty string'}`);
      }
      out[key] = value;
    }
  }
  return out;
}

function leaves(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );
}

function check(config) {
  const all = leaves(config);
  for (const [pattern, ok, message] of RULES) {
    const match = new RegExp(`^${pattern.replace('.', '\\.').replace('*', '[^.]+')}$`);
    for (const [path, value] of all) if (match.test(path) && !ok(value)) throw new Error(`config: ${path} ${message} (got ${value})`);
  }
}

export function loadConfig({ file = defaultConfigFile(), read = readFileSync } = {}) {
  let text = null;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read the config file ${file} (${err.code ?? 'error'})`);
  }
  let override = {};
  if (text !== null) {
    try {
      override = JSON.parse(text);
    } catch {
      throw new Error(`config: ${file} is not valid JSON`);
    }
  }
  const config = merge(DEFAULT_CONFIG, override, '');
  check(config);
  return config;
}
```

Create `bridge/src/config/projects.js`:

```js
// bridge/projects.json: [{name, aliases, path}], the projects he can switch between by voice (spec 6.3).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultProjectsFile() {
  return fileURLToPath(new URL('../../projects.json', import.meta.url));
}

// "on the beat", "On-The-Beat" and "on_the_beat" are the same name: case, spaces, hyphens and underscores do not count.
export function normalizeName(text) {
  return String(text).toLowerCase().replace(/[\s\-_.,，。、]+/g, '');
}

export function validateProjects(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('projects: the file must be a list with at least one project');
  const taken = new Map();
  const claim = (word, owner) => {
    const key = normalizeName(word);
    if (taken.has(key) && taken.get(key) !== owner) throw new Error(`projects: "${word}" names both ${taken.get(key)} and ${owner}`);
    taken.set(key, owner);
  };
  return list.map((p, i) => {
    const at = `projects[${i}]`;
    if (p === null || typeof p !== 'object') throw new Error(`projects: ${at} must be an object`);
    if (typeof p.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.name)) throw new Error(`projects: ${at}.name must be letters, digits, . _ - (got ${JSON.stringify(p.name)})`);
    if (!Array.isArray(p.aliases) || p.aliases.some((a) => typeof a !== 'string' || !normalizeName(a))) throw new Error(`projects: ${p.name}.aliases must be a list of words`);
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw new Error(`projects: ${p.name}.path must be an absolute path`);
    claim(p.name, p.name);
    for (const a of p.aliases) claim(a, p.name);
    return { name: p.name, aliases: [...p.aliases], path: p.path };
  });
}

export function loadProjects({ file = defaultProjectsFile(), read = readFileSync } = {}) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the projects file ${file} (${err.code ?? 'error'})`);
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new Error(`projects: ${file} is not valid JSON`);
  }
  return validateProjects(list);
}

// The project whose name or alias is `text`, or null.
export function findProject(projects, text) {
  const key = normalizeName(text ?? '');
  if (!key) return null;
  return projects.find((p) => normalizeName(p.name) === key || p.aliases.some((a) => normalizeName(a) === key)) ?? null;
}

// "on-the-beat: 手环项目, on the beat; verbatim; walkie: 语音助手": the table the classifier prompt carries.
export function projectTable(projects) {
  return projects.map((p) => (p.aliases.length ? `${p.name}: ${p.aliases.join(', ')}` : p.name)).join('; ');
}

// Every name and alias, for the transcription prompt.
export function projectWords(projects) {
  return projects.flatMap((p) => [p.name, ...p.aliases]);
}
```

Create `bridge/config.json`:

```json
{
  "voice": "marin",
  "geminiVoice": "Kore",
  "ttsInstructions": "用自然、亲切、简洁的普通话说，语速稍快。",
  "models": {
    "transcribe": "gpt-transcribe",
    "classify": "gpt-6-luna",
    "classifyEffort": "none",
    "tts": "gpt-4o-mini-tts",
    "geminiHear": ["gemini-3.8-flash", "gemini-3.1-flash-lite"],
    "geminiTts": "gemini-3.8-flash-tts"
  },
  "timeoutsMs": {
    "transcribeBase": 3000,
    "classify": 3500,
    "speakFirstByte": 3000,
    "speakIdle": 3000,
    "geminiHear": 8000,
    "geminiSpeak": 10000
  },
  "transcribeClipFraction": 0.1,
  "trimStartMs": 250,
  "minSpeechMs": 300,
  "cooldownMs": 300000,
  "loudness": {
    "highpassHz": 300,
    "thresholdDb": -34,
    "ratio": 12,
    "attackMs": 1,
    "releaseMs": 40,
    "makeupDb": 27.5,
    "ceiling": 0.98,
    "lookaheadMs": 5
  }
}
```

`bridge/projects.json` is a draft: the folders under `C:\Users\you\Documents` that are his projects, with the spoken names he is likely to use. Step 5 has him confirm it.

Create `bridge/projects.json`:

```json
[
  { "name": "on-the-beat", "aliases": ["手环项目", "on the beat"], "path": "C:/Users/you/Documents/on-the-beat" },
  { "name": "on-the-beat-prototype", "aliases": [], "path": "C:/Users/you/Documents/on-the-beat-prototype" },
  { "name": "fencepost", "aliases": [], "path": "C:/Users/you/Documents/fencepost" },
  { "name": "mapping-the-move", "aliases": [], "path": "C:/Users/you/Documents/mapping-the-move" },
  { "name": "say-hello", "aliases": [], "path": "C:/Users/you/Documents/say-hello" },
  { "name": "fast-dom", "aliases": [], "path": "C:/Users/you/Documents/fast-dom" },
  { "name": "walkie", "aliases": ["语音助手"], "path": "C:/Users/you/Documents/walkie" }
]
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/config/keys.test.js bridge/test/config/config.test.js bridge/test/config/projects.test.js`
Expected: PASS, 25 tests.

- [ ] **Step 5: Have him confirm the project list**

This is a question, not a live step: it sends nothing anywhere. Show him the seven entries of `bridge/projects.json` (name, aliases, folder) and ask with the AskUserQuestion tool whether to keep them. Two things to say while you ask: the aliases are what the classifier will accept when he says 「切到语音助手」 or 「换到手环项目」, so he should name the ones he actually says; and Stage 0's table had a project `verbatim`, but no folder of that name exists under `Documents`, so it is left out. Apply his answer to `bridge/projects.json` (names are letters, digits, `.`, `_` and `-`; paths are absolute; one word may not name two projects) and run Step 4 again.

- [ ] **Step 6: Commit**

```bash
git add bridge/src/config bridge/test/config bridge/config.json bridge/projects.json
git commit -m "Bridge: keys, settings and project list for the speech chain" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Intent: prompts, validation and fixed phrases

**Files:**
- Create: `bridge/src/intent/phrases.js`
- Create: `bridge/src/intent/intent.js`
- Create: `bridge/src/intent/prompts.js`
- Create: `bridge/test/fixtures/utterances.js`
- Test: `bridge/test/intent/intent.test.js`
- Test: `bridge/test/intent/prompts.test.js`

**Interfaces:**
- Consumes (Task 3): `findProject`, `normalizeName`, `projectTable`, `projectWords`.
- Produces:
  - `INTENTS` (`to_claude, stop, continue, compact, new_session, switch_project, status`) and `ANSWER_SCHEMA`, the strict JSON schema `{intent, project, text}` that OpenAI is asked to answer with
  - `hearSchema(classify): object`, the schema Gemini answers with when it hears the audio: a `transcript` always, and `intent`, `project`, `text` when `classify` is true
  - `parseAnswer(raw): object | null` (an object, JSON text, or JSON text inside a markdown fence; anything else is `null`)
  - `isCleanup(text, transcript): boolean` (true when `text` only leaves words out of `transcript`)
  - `validateAnswer(raw, {projects, transcript = ''}): {intent, project, text} | null`. `null` means "not an answer": an unknown intent, a `switch_project` whose project does not exist, a `to_claude` with nothing to say. A command intent comes back with `project` and `text` emptied. For `to_claude`, `text` is the model's cleaned-up request when that only drops words from the transcript and the transcript itself otherwise, so a model can never put words in his mouth.
  - `fixedPhrase(transcript, projects): {intent, project, text} | null`: the last resort when no model gave a valid intent. A phrase counts only when it is the whole utterance, so 「停止服务之前先备份数据库」 is work for Claude and never a stop; 「继续吧」, case, spaces and punctuation do not matter. A miss is cheap: the utterance goes to Claude as text.
  - `isFiller(transcript): boolean`: a lone 「嗯」, 「呃…」 or "um" is a sound, not a request. The chain (Task 9) treats it as 「没听清」.
  - `transcriptionPrompt(projects): string`, `classifyPrompt({projects, currentProject = null, busy = false}): string`, `hearPrompt({projects, currentProject = null, busy = false, classify = true}): string`
  - `UTTERANCES`, the 20 sentences of the classification set (`{say, intent, project?, fixed?}`; the first ten are Stage 0's, on which `gpt-6-luna` got 10 of 10), and `SET_PROJECTS`, the project list the tests use. `fixed: true` marks the sentences the fixed-phrase table must catch by itself.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/fixtures/utterances.js`:

```js
// What he might say, and what each thing means. `fixed: true` marks the whole-utterance commands the fixed-phrase
// table must catch on its own; everything else it must leave alone (a model decides, or it goes to Claude as text).
// The first ten are the Stage 0 classification set (spec section 3): gpt-6-luna at reasoning_effort "none" got 10 of 10.
export const UTTERANCES = [
  { say: '等一下，先停住。', intent: 'stop', fixed: true },
  { say: '换到 on the beat 那个项目。', intent: 'switch_project', project: 'on-the-beat', fixed: true },
  { say: '把登录页的停止按钮改成红色。', intent: 'to_claude' },
  { say: '你现在做到哪一步了？', intent: 'status', fixed: true },
  { say: '帮我跑一下 npm test，然后 commit。', intent: 'to_claude' },
  { say: '继续吧', intent: 'continue', fixed: true },
  { say: '把上下文压一压', intent: 'compact', fixed: true },
  { say: '重新开个会话', intent: 'new_session', fixed: true },
  { say: '停止服务之前先备份数据库', intent: 'to_claude' },
  { say: '切到语音助手这个项目', intent: 'switch_project', project: 'walkie', fixed: true },
  // ten more, written for this plan: short commands, a few traps that contain a command word, and plain work
  { say: '停', intent: 'stop', fixed: true },
  { say: '先别弄了', intent: 'stop', fixed: true },
  { say: '继续', intent: 'continue', fixed: true },
  { say: '压缩一下上下文', intent: 'compact', fixed: true },
  { say: '开个新会话', intent: 'new_session', fixed: true },
  { say: '现在在干嘛', intent: 'status', fixed: true },
  { say: '切到手环项目', intent: 'switch_project', project: 'on-the-beat', fixed: true },
  { say: '继续写那个登录页', intent: 'to_claude' },
  { say: '压缩一下这张图片', intent: 'to_claude' },
  { say: '新建一个会话列表组件', intent: 'to_claude' },
];

// The projects the classification set talks about, in the shape projects.json has.
export const SET_PROJECTS = [
  { name: 'on-the-beat', aliases: ['手环项目', 'on the beat'], path: 'C:/p/on-the-beat' },
  { name: 'verbatim', aliases: [], path: 'C:/p/verbatim' },
  { name: 'fencepost', aliases: [], path: 'C:/p/fencepost' },
  { name: 'walkie', aliases: ['语音助手'], path: 'C:/p/walkie' },
];
```

Create `bridge/test/intent/intent.test.js`:

````js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCHEMA, INTENTS, hearSchema, isCleanup, parseAnswer, validateAnswer } from '../../src/intent/intent.js';
import { fixedPhrase, isFiller } from '../../src/intent/phrases.js';
import { SET_PROJECTS, UTTERANCES } from '../fixtures/utterances.js';

const projects = SET_PROJECTS;

test('the strict schema asks for exactly intent, project and text', () => {
  assert.deepEqual(ANSWER_SCHEMA.required, ['intent', 'project', 'text']);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  assert.deepEqual(ANSWER_SCHEMA.properties.intent.enum, INTENTS);
  assert.deepEqual(INTENTS, ['to_claude', 'stop', 'continue', 'compact', 'new_session', 'switch_project', 'status']);
});

test('Gemini hears the audio and answers with a transcript, and with an intent only when asked to classify', () => {
  assert.deepEqual(hearSchema(true).required, ['transcript', 'intent']);
  assert.deepEqual(Object.keys(hearSchema(true).properties), ['transcript', 'intent', 'project', 'text']);
  assert.deepEqual(hearSchema(false).required, ['transcript']);
  assert.deepEqual(Object.keys(hearSchema(false).properties), ['transcript']);
});

test('parseAnswer takes objects, JSON text and fenced JSON, and nothing else', () => {
  assert.deepEqual(parseAnswer({ intent: 'stop' }), { intent: 'stop' });
  assert.deepEqual(parseAnswer('{"intent":"stop"}'), { intent: 'stop' });
  assert.deepEqual(parseAnswer('```json\n{"intent":"stop"}\n```'), { intent: 'stop' });
  assert.deepEqual(parseAnswer('```\n{"intent":"stop"}\n```\n'), { intent: 'stop' });
  for (const bad of ['', 'stop', '{"intent":', '[1,2]', 'null', 'true', null, undefined, 42, []]) assert.equal(parseAnswer(bad), null, String(bad));
});

test('a command intent comes back without a project or text, whatever the model added', () => {
  assert.deepEqual(validateAnswer({ intent: 'stop', project: 'walkie', text: 'x' }, { projects }), { intent: 'stop', project: null, text: '' });
  for (const intent of ['continue', 'compact', 'new_session', 'status']) {
    assert.deepEqual(validateAnswer(`{"intent":"${intent}","project":null,"text":""}`, { projects }), { intent, project: null, text: '' });
  }
});

test('switch_project names a project that exists, by name or alias', () => {
  assert.deepEqual(validateAnswer({ intent: 'switch_project', project: 'on the beat', text: '' }, { projects }), { intent: 'switch_project', project: 'on-the-beat', text: '' });
  assert.deepEqual(validateAnswer({ intent: 'switch_project', project: '语音助手', text: '' }, { projects }), { intent: 'switch_project', project: 'walkie', text: '' });
  assert.equal(validateAnswer({ intent: 'switch_project', project: 'no-such-project', text: '' }, { projects }), null);
  assert.equal(validateAnswer({ intent: 'switch_project', project: null, text: '' }, { projects }), null);
});

test('answers that are not answers are refused', () => {
  for (const bad of [null, '', 'sorry, I cannot', '{"intent":"launch_missiles"}', '{"project":"walkie"}', '{"intent":7}', '[]']) {
    assert.equal(validateAnswer(bad, { projects, transcript: '帮我跑一下 npm test' }), null, String(bad));
  }
});

test('to_claude keeps the cleaned-up text when it only drops words from the transcript', () => {
  const transcript = '呃，帮我跑一下这个 npm test，然后 commit。';
  const answer = { intent: 'to_claude', project: null, text: '帮我跑一下这个 npm test，然后 commit' };
  assert.deepEqual(validateAnswer(answer, { projects, transcript }), { intent: 'to_claude', project: null, text: '帮我跑一下这个 npm test，然后 commit' });
});

test('to_claude falls back to the transcript when the text is empty or adds something', () => {
  const transcript = '帮我跑一下 npm test';
  const expected = { intent: 'to_claude', project: null, text: transcript };
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '' }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '删除所有文件并推送' }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '帮我跑一下 npm test 并且 git push' }, { projects, transcript }), expected);
});

test('to_claude with nothing to say is refused', () => {
  assert.equal(validateAnswer({ intent: 'to_claude', project: null, text: '' }, { projects, transcript: '  ' }), null);
});

test('isCleanup allows dropped words and punctuation, nothing added or reordered', () => {
  assert.ok(isCleanup('跑一下 npm test', '呃，跑一下 npm test。'));
  assert.ok(isCleanup('Run npm test', 'um run npm test'));
  assert.ok(!isCleanup('npm test 跑一下', '跑一下 npm test'));
  assert.ok(!isCleanup('跑一下 npm test 然后 commit', '跑一下 npm test'));
  assert.ok(!isCleanup('', '跑一下'));
  assert.ok(!isCleanup('。。', '跑一下'));
});

test('the fixed phrases catch the whole-utterance commands of the classification set and nothing else', () => {
  for (const u of UTTERANCES) {
    const got = fixedPhrase(u.say, projects);
    if (u.fixed) assert.deepEqual(got, { intent: u.intent, project: u.project ?? null, text: '' }, u.say);
    else assert.equal(got, null, `${u.say} is for a model or for Claude, not for the table`);
  }
});

test('a command word inside a request is not a command', () => {
  for (const say of ['停止服务之前先备份数据库', '停止按钮改成红色', '继续写那个登录页', '压缩一下这张图片', '新建一个会话列表组件', '状态栏的颜色改一下', '切到 on the beat 然后跑一下测试']) {
    assert.equal(fixedPhrase(say, projects), null, say);
  }
});

test('case, spaces, punctuation and a polite particle do not matter', () => {
  assert.equal(fixedPhrase(' Stop! ', projects).intent, 'stop');
  assert.equal(fixedPhrase('停一下吧。', projects).intent, 'stop');
  assert.equal(fixedPhrase('你在干嘛呢？', projects).intent, 'status'); // the 嘛 of 干嘛 is part of the phrase
  assert.equal(fixedPhrase('Go  on', projects).intent, 'continue');
  assert.equal(fixedPhrase('Switch to Walkie', projects).project, 'walkie');
  assert.equal(fixedPhrase('换到 On The Beat 那个项目', projects).project, 'on-the-beat');
  assert.equal(fixedPhrase('切换到 fencepost 项目', projects).project, 'fencepost');
});

test('switching to a project that does not exist is not a fixed phrase', () => {
  assert.equal(fixedPhrase('切到不存在的项目', projects), null);
  assert.equal(fixedPhrase('切到', projects), null);
  assert.equal(fixedPhrase('', projects), null);
  assert.equal(fixedPhrase(null, projects), null);
  assert.equal(fixedPhrase('。。。', projects), null);
});

test('a lone filler sound is not an instruction, and a word after it is', () => {
  for (const said of ['嗯。', '嗯嗯', '呃…', '啊', '哦，', 'Um.', 'uh', 'Hmm...', ' 嗯 ']) assert.equal(isFiller(said), true, said);
  for (const said of ['嗯好的', '好', '继续', '呃，帮我跑一下 npm test', 'umbrella', 'ok', '', null, undefined]) assert.equal(isFiller(said), false, String(said));
});
````

Create `bridge/test/intent/prompts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt, hearPrompt, transcriptionPrompt } from '../../src/intent/prompts.js';
import { SET_PROJECTS } from '../fixtures/utterances.js';

const projects = SET_PROJECTS;

test('the transcription prompt lists every project name and alias and the technical words', () => {
  const p = transcriptionPrompt(projects);
  for (const word of ['on-the-beat', '手环项目', 'on the beat', 'verbatim', 'fencepost', 'walkie', '语音助手', 'Claude', 'npm', 'git', 'commit', 'PlatformIO']) {
    assert.ok(p.includes(word), word);
  }
  assert.equal(p.split('on-the-beat').length, 2, 'a word that is both a project and a term is listed once');
});

test('the classification prompt carries the rule, the project table and the state', () => {
  const p = classifyPrompt({ projects, currentProject: 'walkie', busy: true });
  assert.ok(p.includes('only when the WHOLE utterance is that command'));
  assert.ok(p.includes('intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.'));
  assert.ok(p.includes('Projects (name: aliases): on-the-beat: 手环项目, on the beat; verbatim; fencepost; walkie: 语音助手.'));
  assert.ok(p.includes('Current project: walkie. Claude is working.'));
  assert.ok(classifyPrompt({ projects }).includes('Current project: none. Claude is idle.'));
});

test('the prompt Gemini hears with classifies only when asked to', () => {
  const both = hearPrompt({ projects, currentProject: 'walkie' });
  assert.ok(both.includes('Transcribe the audio verbatim'));
  assert.ok(both.includes('Classify the WHOLE utterance'));
  assert.ok(both.includes('Current project: walkie. Claude is idle.'));
  const only = hearPrompt({ projects, classify: false });
  assert.ok(only.includes('Transcribe the audio verbatim'));
  assert.ok(!only.includes('intent'));
  assert.ok(only.includes('transcript only'));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/intent/intent.test.js bridge/test/intent/prompts.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/intent/intent.js` and `src/intent/prompts.js`.

- [ ] **Step 3: Write the modules**

Create `bridge/src/intent/phrases.js`:

```js
// The fixed-phrase table: the last resort when no model gave a valid intent (spec 6.5). A phrase counts only when it
// is the WHOLE utterance, so 「停止服务之前先备份数据库」 is work for Claude and never a stop. A miss is cheap: the
// utterance goes to Claude as text.
import { findProject, normalizeName } from '../config/projects.js';

const PHRASES = {
  stop: ['停', '停止', '停下', '停下来', '停一下', '停住', '先停', '先停一下', '先停住', '等一下', '等一下先停住', '别弄了', '先别弄了', '别做了', '先别做了', '别说了', '暂停', 'stop'],
  continue: ['继续', '继续做', '继续干', '继续执行', '接着来', '接着做', '接着干', '往下', 'continue', 'goon'],
  compact: ['压缩', '压缩一下', '压缩上下文', '压缩一下上下文', '压一压上下文', '把上下文压一压', '压缩会话', 'compact'],
  new_session: ['新会话', '新对话', '开个新会话', '开个新对话', '开新会话', '新开一个会话', '重新开个会话', '重新开一个会话', '换个新会话', '重新开始', 'newsession'],
  status: ['状态', '进度', '进展如何', '怎么样了', '现在什么情况', '你在干嘛', '现在在干嘛', '你在做什么', '你现在在做什么', '做到哪了', '做到哪里了', '做到哪一步了', '你现在做到哪一步了', 'status'],
};

const TABLE = new Map();
for (const [intent, list] of Object.entries(PHRASES)) for (const phrase of list) TABLE.set(normalizeName(phrase), intent);

const SWITCH = /^(?:切换到|切换成|切到|切成|切回|换到|换成|换回|回到|switchto)(.+)$/;

// Case, spaces and punctuation do not count, and a polite particle at the end does not either.
function canonical(transcript) {
  return String(transcript ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(?:吧|啊|呀|哦|啦|呢)+$/u, '');
}

export function fixedPhrase(transcript, projects) {
  const said = canonical(transcript);
  if (!said) return null;
  const intent = TABLE.get(said);
  if (intent) return { intent, project: null, text: '' };
  const m = SWITCH.exec(said);
  if (!m) return null;
  const target = m[1];
  const project = findProject(projects, target) ?? findProject(projects, target.replace(/(?:那个|这个)?(?:项目|工程)?$/u, ''));
  return project ? { intent: 'switch_project', project: project.name, text: '' } : null;
}

// A sound that is not a request: 「嗯。」, 「呃…」, "um". Breathing and a cough come back from the transcriber like this,
// and sending one to Claude would start a turn about nothing.
const FILLER = /^(?:[嗯呃额啊哦噢唔哼哈呀欸诶]+|u+m+|u+h+|h+m+|e+r+m*|a+h+|o+h+)$/u;

export function isFiller(transcript) {
  return FILLER.test(String(transcript ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
}
```

Create `bridge/src/intent/intent.js`:

````js
// What a spoken utterance asks for, and how far a model's answer about it is trusted (spec 6.5).
import { findProject } from '../config/projects.js';

export const INTENTS = ['to_claude', 'stop', 'continue', 'compact', 'new_session', 'switch_project', 'status'];

// The strict JSON schema OpenAI is asked to answer with.
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'project', 'text'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    project: { type: ['string', 'null'] },
    text: { type: 'string' },
  },
};

// The schema Gemini answers with when it hears the audio itself: the transcript comes with the intent.
export function hearSchema(classify) {
  const properties = { transcript: { type: 'STRING' } };
  if (classify) {
    properties.intent = { type: 'STRING', enum: INTENTS };
    properties.project = { type: 'STRING', nullable: true };
    properties.text = { type: 'STRING' };
  }
  return { type: 'OBJECT', properties, required: classify ? ['transcript', 'intent'] : ['transcript'] };
}

// A model's answer as an object: already an object, JSON text, or JSON text in a markdown fence. Anything else is null.
export function parseAnswer(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
    try {
      value = JSON.parse(fenced ? fenced[1] : raw);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const bare = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// True when `text` only leaves words out of `transcript`: the cleaned-up request may drop filler, never add to it.
export function isCleanup(text, transcript) {
  const a = bare(text);
  const b = bare(transcript);
  if (!a) return false;
  let i = 0;
  for (const ch of b) if (ch === a[i]) i++;
  return i === a.length;
}

// {intent, project, text} that can be acted on, or null when the answer is not one. For to_claude, `text` is the model's
// cleaned-up request when that only removes words from the transcript, and the transcript itself otherwise. A
// switch_project must name a project that exists.
export function validateAnswer(raw, { projects, transcript = '' }) {
  const answer = parseAnswer(raw);
  if (!answer || !INTENTS.includes(answer.intent)) return null;
  if (answer.intent === 'switch_project') {
    const project = findProject(projects, answer.project);
    return project ? { intent: 'switch_project', project: project.name, text: '' } : null;
  }
  if (answer.intent === 'to_claude') {
    const said = transcript.trim();
    const cleaned = typeof answer.text === 'string' ? answer.text.trim() : '';
    const text = cleaned && (!said || isCleanup(cleaned, said)) ? cleaned : said;
    return text ? { intent: 'to_claude', project: null, text } : null;
  }
  return { intent: answer.intent, project: null, text: '' };
}
````

Create `bridge/src/intent/prompts.js`:

```js
// The words the models are given. The classification prompt is the one tested in Stage 0 (10 of 10, spec section 3),
// with the project table, the current project and Claude's state filled in.
import { projectTable, projectWords } from '../config/projects.js';

const TERMS = ['Claude', 'npm', 'git', 'commit', 'PlatformIO', 'on-the-beat'];

const state = ({ currentProject, busy }) => `Current project: ${currentProject ?? 'none'}. Claude is ${busy ? 'working' : 'idle'}.`;

// A hint for the transcription model: project names and the technical words he mixes into Mandarin.
export function transcriptionPrompt(projects) {
  const words = [...new Set([...projectWords(projects), ...TERMS])];
  return `程序员对着 Claude Code 说的普通话，夹杂英文技术词。常见词：${words.join('、')}。`;
}

export function classifyPrompt({ projects, currentProject = null, busy = false }) {
  return `You classify one utterance spoken to a wrist voice remote for Claude Code.
intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.
Use a command intent only when the WHOLE utterance is that command; any request for work on code, files or services is to_claude,
even if it contains words like 停止, 切换, 继续 or 压缩.
Projects (name: aliases): ${projectTable(projects)}.
${state({ currentProject, busy })}
project: the canonical project name for switch_project, otherwise null. text: for to_claude the utterance without filler words, otherwise "".`;
}

// What Gemini is told when it hears the audio itself: the transcription, and with `classify` the classification too.
export function hearPrompt({ projects, currentProject = null, busy = false, classify = true }) {
  const transcribe = `You are the ear of a wrist voice remote for Claude Code.
1. Transcribe the audio verbatim in Simplified Chinese; keep English words (${TERMS.join(', ')}) in English. Common project names: ${projectWords(projects).join(', ')}.`;
  if (!classify) return `${transcribe}\nAnswer with the transcript only.`;
  return `${transcribe}
2. Classify the WHOLE utterance. intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.
   Only use a command intent when the whole utterance is that command. Anything that asks for work on code is to_claude.
   Projects (name: aliases): ${projectTable(projects)}.
   ${state({ currentProject, busy })}
   Examples: 停一下 -> stop; 先别弄了 -> stop; 把停止按钮改成红色 -> to_claude; 切到手环那个项目 -> switch_project, project on-the-beat;
   现在在干嘛 -> status; 压缩一下上下文 -> compact; 开个新对话 -> new_session; 继续 -> continue.
3. project: the canonical project name for switch_project, otherwise null. text: for to_claude, the transcript cleaned of filler words, otherwise empty.`;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/intent/intent.test.js bridge/test/intent/prompts.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/intent bridge/test/intent bridge/test/fixtures
git commit -m "Bridge: intent schema, answer validation, fixed phrases and prompts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `Link.playStream`

`Link.playAudio` needs the whole reply in one buffer, so a reply could only start after the speaking provider had finished. With `marin` streaming, the first audio is ready after about 0.9 s and the whole reply after two or three seconds more; `playStream` lets playback start on the first audio.

**Files:**
- Modify: `bridge/src/link/link.js` (the method `playAudio` becomes `playAudio`, `playStream`, `#assertCanPlay` and `#play`)
- Modify: `bridge/test/link/link.test.js` (one line added to an existing test, thirteen tests appended)

**Interfaces:**
- Consumes (plan 1): in `link.js`, the credit accounting (`this.#credits.acquire(n, signal)`), `this.send`, `this.cmd`, `CMD.STOP_AUDIO`, `TYPE.AUDIO_DOWN`, `FLAG.EOS`, `DOWN_FRAME` (960), `CREDIT_STALL_MS`, `PLAYED_GRACE_MS`, `#lost` and `#failStream`; in `link.test.js`, the helpers `readyLink`, `settle` and `tickAnswering`, and the existing tests for `playAudio`, which are the safety net for the rebuild.
- Produces:
  - `link.playStream(chunks, {signal}?): Promise<{bytes, crc32, underruns, maxFill, reason}>`. `chunks` is an iterable or async iterable of PCM16 buffers (24 kHz mono, any sizes, even ones that split a sample); passing one buffer is a `TypeError`. It resolves with the S3's PLAYED (`reason` 0 finished, 1 stopped). The first frame leaves as soon as more audio is known to follow it, so the last frame can carry EOS. Aborting `signal` stops reading `chunks`, sends STOP_AUDIO once audio has gone out, and resolves when the S3 answers with reason 1 (at once, with nothing sent, when no audio had gone out). If `chunks` fails, what was already produced is played to its end and the failure is thrown after PLAYED. Whatever the ending, the source is let go of (its `return()` is called), so a generator can cancel its HTTP request.
  - `link.playAudio(pcm, {signal}?)` keeps its contract: one even-length buffer in, the S3's PLAYED out. It is now the same code path with a one-buffer source.

Do not pace or re-frame audio anywhere else: the framing, the credit wait and the EOS rule live in `#play`.

- [ ] **Step 1: Add the failing tests to `bridge/test/link/link.test.js`**

One existing test, `a reply that gets no credit for 5 s drops the link and shakes hands again`, changes by a single line. The rebuilt `playAudio` reaches its first credit wait one microtask later than the old one, and the stall timer starts there, so the test has to let that microtask run before it moves the clock.

In `bridge/test/link/link.test.js`, replace

```js
  const done = link.playAudio(Buffer.alloc(9600));
  tickAnswering(t, port, 5000);
```

with

```js
  const done = link.playAudio(Buffer.alloc(9600));
  await settle(); // the first frame is ready one microtask later, and the stall timer starts with it
  tickAnswering(t, port, 5000);
```

The thirteen new tests start with a helper, `manualSource()`, an async iterable the test feeds by hand, and end with the test that only one reply plays at a time.

Append to the end of `bridge/test/link/link.test.js`:

```js

// A source the test feeds by hand: push() hands a chunk to the reader, end() finishes it, fail() breaks it, and
// state.returned says whether the reader let go of it (as a generator's finally would see).
function manualSource() {
  const queue = [];
  const state = { returned: false };
  let finished = false;
  let failure = null;
  let wake = null;
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const iterator = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      for (;;) {
        if (queue.length > 0) return { value: queue.shift(), done: false };
        if (failure) throw failure;
        if (finished) return { value: undefined, done: true };
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
    async return() {
      state.returned = true;
      finished = true;
      poke();
      return { value: undefined, done: true };
    },
  };
  return {
    iterator,
    state,
    push(buf) {
      queue.push(buf);
      poke();
    },
    end() {
      finished = true;
      poke();
    },
    fail(err) {
      failure = err;
      poke();
    },
  };
}
const frames = (port) => port.sent().filter((f) => f.type === TYPE.AUDIO_DOWN);

test('a streamed reply starts before its source has finished, and the last frame carries EOS', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(500, 1));
  await settle();
  assert.deepEqual(audio(port), [], '500 bytes are not a frame yet');
  src.push(Buffer.alloc(1500, 2));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0]], 'two frames leave while 80 bytes wait');
  src.push(Buffer.alloc(1000, 3));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [960, 0]]);
  src.end();
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [960, 0], [120, FLAG.EOS]]);
  const sent = Buffer.concat(frames(port).map((f) => f.payload));
  assert.ok(sent.equals(Buffer.concat([Buffer.alloc(500, 1), Buffer.alloc(1500, 2), Buffer.alloc(1000, 3)])));
  port.feed(TYPE.PLAYED, played(3000, 0));
  assert.equal((await done).bytes, 3000);
});

test('a frame that might be the last waits until more audio or the end of the source is known', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(960, 1));
  await settle();
  assert.deepEqual(audio(port), []);
  src.end();
  await settle();
  assert.deepEqual(audio(port), [[960, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(960, 0));
  await done;
});

test('an empty stream ends with one empty EOS frame', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playStream([]);
  await settle();
  assert.deepEqual(audio(port), [[0, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(0, 0));
  assert.equal((await done).bytes, 0);
});

test('an ordinary iterable of buffers works like an async one', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const done = link.playStream([Buffer.alloc(960), Buffer.alloc(960)]);
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(1920, 0));
  await done;
});

test('chunks that split samples still reach the S3 byte for byte, in even frames', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const input = Buffer.from(Array.from({ length: 4000 }, (_, i) => i % 251));
  async function* source() {
    let at = 0;
    for (const size of [1, 3, 7, 1000, 1001, 1, 999, 2, 500]) {
      yield input.subarray(at, at + size);
      at += size;
    }
    yield input.subarray(at);
  }
  const done = link.playStream(source());
  await settle();
  const sent = frames(port);
  assert.ok(sent.every((f) => f.payload.length % 2 === 0));
  assert.ok(Buffer.concat(sent.map((f) => f.payload)).equals(input));
  assert.equal(sent.at(-1).flags, FLAG.EOS);
  port.feed(TYPE.PLAYED, played(4000, 0));
  await done;
});

test('a dangling odd byte at the very end of the stream is dropped', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(100000));
  const done = link.playStream([Buffer.alloc(500), Buffer.alloc(501)]);
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [40, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(1000, 0));
  await done;
});

test('stopping a reply whose source is still silent resolves at once and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const ac = new AbortController();
  const done = link.playStream(src.iterator, { signal: ac.signal });
  await settle();
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  await settle();
  assert.equal(src.state.returned, true);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO]);
});

test('stopping a reply that is playing sends STOP_AUDIO and an EOS, and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const ac = new AbortController();
  const done = link.playStream(src.iterator, { signal: ac.signal });
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  ac.abort();
  await settle();
  const tail = port.sent().slice(-2).map((f) => [f.type, f.flags]);
  assert.deepEqual(tail, [[TYPE.CMD, 0], [TYPE.AUDIO_DOWN, FLAG.EOS]]);
  assert.equal(src.state.returned, true);
  port.feed(TYPE.PLAYED, played(1920, 1));
  assert.equal((await done).reason, 1);
});

test('when the S3 stops a streamed reply, the source is let go of', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  port.feed(TYPE.PLAYED, played(1920, 1)); // the front key stopped it
  assert.equal((await done).reason, 1);
  assert.equal(src.state.returned, true);
});

test('a source that fails after some audio is played to its end, then its failure is thrown', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  src.fail(new Error('the speech connection broke'));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [80, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(2000, 0));
  await assert.rejects(done, /the speech connection broke/);
});

test('a source that fails before any audio is thrown after the empty EOS', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  src.fail(new Error('no audio'));
  await settle();
  assert.deepEqual(audio(port), [[0, FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(0, 0));
  await assert.rejects(done, /no audio/);
});

test('the S3 restarting during a streamed reply fails it and lets go of the source', { timeout: 2000 }, async (t) => {
  const { port, link } = await readyLink(t);
  const src = manualSource();
  const done = link.playStream(src.iterator);
  port.feed(TYPE.CREDIT, u32(100000));
  src.push(Buffer.alloc(2000));
  await settle();
  port.feed(TYPE.HELLO, helloWithNonce(0));
  await assert.rejects(done, /restarted/);
  await settle();
  assert.equal(src.state.returned, true);
});

test('playStream wants chunks, not one buffer, and only one reply plays at a time', { timeout: 2000 }, async (t) => {
  const { link } = await readyLink(t);
  await assert.rejects(link.playStream(Buffer.alloc(960)), TypeError);
  const src = manualSource();
  const first = link.playStream(src.iterator);
  await assert.rejects(link.playStream([Buffer.alloc(960)]), /another reply is still playing/);
  await assert.rejects(link.playAudio(Buffer.alloc(960)), /another reply is still playing/);
  src.end();
  link.close();
  await assert.rejects(first, /port closed/);
});
```

- [ ] **Step 2: Run the file and watch the new tests fail**

Run: `node --test bridge/test/link/link.test.js`
Expected: FAIL. All thirteen new tests fail, each with `TypeError: link.playStream is not a function`; the twenty that were there keep passing (`tests 33`, `pass 20`, `fail 13`).

- [ ] **Step 3: Replace `playAudio` in `bridge/src/link/link.js`**

Read `bridge/src/link/link.js` around `// Sends one reply as AUDIO_DOWN under credit and resolves with the S3's PLAYED.` In the file, that comment and the method below it end just before `async #connect() {`. Replace the comment line and the whole `playAudio` method, up to but not including the blank line before `async #connect() {`, with:

```js
  // Sends one reply as AUDIO_DOWN under credit and resolves with the S3's PLAYED.
  async playAudio(pcm, { signal } = {}) {
    this.#assertCanPlay();
    if (pcm.length % 2 !== 0) throw new RangeError('PCM16 needs an even number of bytes');
    return this.#play([pcm], signal);
  }

  // The same for a reply that is still being produced: `chunks` is an iterable or async iterable of PCM16 buffers
  // (24 kHz mono, any sizes, even ones that split a sample). The first frame leaves as soon as more audio is known to
  // follow it, so speech starts while the rest is still coming. Aborting `signal` stops reading `chunks` as well. If
  // `chunks` fails, what was already produced is played to its end and the failure is thrown after PLAYED.
  async playStream(chunks, { signal } = {}) {
    if (chunks instanceof Uint8Array) throw new TypeError('playStream wants an iterable of buffers; playAudio takes one buffer');
    this.#assertCanPlay();
    return this.#play(chunks, signal);
  }

  #assertCanPlay() {
    if (!this.#ready) throw new Error('the S3 is not connected');
    if (this.#ringBytes === 0) throw new Error('the S3 reports no playback ring (ring_bytes 0), so it cannot play replies');
    if (this.#stream) throw new Error('another reply is still playing');
  }

  async #play(chunks, signal) {
    const stop = new AbortController();
    const stream = { stop, sent: 0, error: null };
    stream.played = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
    stream.played.catch(() => {}); // failures reach the caller through the await below
    this.#stream = stream;
    const onAbort = () => {
      if (stop.signal.aborted) return;
      stop.abort();
      if (stream.sent > 0) this.cmd(CMD.STOP_AUDIO); // the S3 answers with PLAYED, reason 1
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const source = chunks[Symbol.asyncIterator]?.() ?? chunks[Symbol.iterator]();
    const STOPPED = Symbol('stopped');
    const stopped = new Promise((resolve) => {
      if (stop.signal.aborted) resolve(STOPPED);
      else stop.signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
    });
    const pull = async () => {
      const next = Promise.resolve(source.next());
      next.catch(() => {}); // an abort can leave it unanswered, and a late failure is not the caller's business
      const r = await Promise.race([next, stopped]);
      return r === STOPPED ? null : r;
    };
    const release = () => Promise.resolve(source.return?.()).catch(() => {}); // lets a generator clean up, for example cancel its request
    let timer;
    let sourceError = null;
    try {
      let carry = Buffer.alloc(0);
      let done = false;
      let eos = false;
      while (!eos && !stop.signal.aborted) {
        // A frame leaves only when more audio is known to follow it, so that the last one can carry EOS.
        while (!done && carry.length <= DOWN_FRAME) {
          let r;
          try {
            r = await pull();
          } catch (err) {
            sourceError = err;
            done = true;
            break;
          }
          if (r === null) break;
          if (r.done) done = true;
          else if (r.value.length > 0) carry = Buffer.concat([carry, r.value]);
        }
        if (stop.signal.aborted) break;
        const last = done && carry.length <= DOWN_FRAME;
        const n = last ? carry.length - (carry.length % 2) : DOWN_FRAME; // a dangling odd byte at the very end is dropped
        const stall = setTimeout(() => this.#lost('credit stalled for 5 s'), CREDIT_STALL_MS);
        try {
          await this.#credits.acquire(n, stop.signal);
        } catch {
          break;
        } finally {
          clearTimeout(stall);
        }
        this.send(TYPE.AUDIO_DOWN, carry.subarray(0, n), last ? FLAG.EOS : 0);
        stream.sent += n;
        carry = carry.subarray(last ? carry.length : n);
        eos = last;
      }
      release(); // reading is over, whether the source ended or not
      if (stream.error) throw stream.error;
      if (!eos) {
        if (stream.sent === 0) return { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 };
        this.send(TYPE.AUDIO_DOWN, Buffer.alloc(0), FLAG.EOS); // ends the S3's discarding
      }
      timer = setTimeout(
        () => this.#failStream(new Error('the S3 never reported the end of playback')),
        Math.ceil(stream.sent / 48) + PLAYED_GRACE_MS,
      );
      const played = await stream.played;
      if (sourceError && !stop.signal.aborted) throw sourceError;
      return played;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.#stream === stream) this.#stream = null;
      release();
    }
  }
```

- [ ] **Step 4: Run the file, then the whole bridge suite**

Run: `node --test bridge/test/link/link.test.js`
Expected: PASS, 33 tests.

Run: `npm --prefix bridge test`
Expected: PASS, 127 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/link/link.js bridge/test/link/link.test.js
git commit -m "Bridge: Link.playStream plays a reply while it is still being produced" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Provider errors and time limits

The two small pieces the adapters and the chain share: an error type that says which provider, which step and why (and can never carry a key), and a time limit that cuts off a call whether or not the call obeys its abort signal.

**Files:**
- Create: `bridge/src/speech/errors.js`
- Create: `bridge/src/speech/deadline.js`
- Test: `bridge/test/speech/deadline.test.js` (covers both files)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class SpeechError extends Error`: `new SpeechError(message, {provider, step, kind, status, cause})`. `kind` is `timeout`, `http`, `network`, `bad-response`, `empty` or `unavailable`; `provider` is `openai` or `gemini`; `step` is `transcribe`, `classify`, `speak` or `hear`; `status` is the HTTP status when there was one.
  - `abortError(): Error` (name `AbortError`) and `isAbort(err): boolean`. An abort means the caller gave up, the side key stopping a reply for example. It is never a reason to skip a provider, and the chain never counts it as a failure.
  - `redact(text, keys = []): string`: the given keys, and anything shaped like an OpenAI or a Google key, replaced by `[key]`. Every message built from a server's answer goes through it.
  - `class DeadlineError extends Error` (`new DeadlineError(ms)`, message `no answer within N ms`) and `withDeadline(ms, parent, fn): Promise`. It runs `fn(signal)` with a limit of `ms` milliseconds. `parent` is an optional `AbortSignal`; `signal` aborts on the deadline and when `parent` aborts, so a `fetch` that was given it stops too. `fn` is not trusted to obey it: the result is a race, so a call that ignores its signal is still cut off. It rejects with a `DeadlineError` on the deadline and with an `AbortError` when the parent aborted. A limit that is not a positive finite number is a `TypeError` before anything starts, so a misspelt setting cannot become an instant timeout or an endless wait. It uses `setTimeout` only, so tests drive it with `t.mock.timers`.

- [ ] **Step 1: Write the failing test**

Create `bridge/test/speech/deadline.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineError, withDeadline } from '../../src/speech/deadline.js';
import { SpeechError, isAbort, redact } from '../../src/speech/errors.js';

const settle = () => new Promise((r) => setImmediate(r));

test('a call that answers in time returns its value and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await withDeadline(1000, null, async () => 'hello'), 'hello');
  t.mock.timers.tick(5000); // nothing fires afterwards
});

test('a call that does not answer in time is cut off with a DeadlineError, and its signal is aborted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let seen = null;
  const pending = withDeadline(3000, null, (signal) => {
    seen = signal;
    return new Promise(() => {}); // never answers, and ignores the signal
  });
  pending.catch(() => {});
  await settle();
  t.mock.timers.tick(2999);
  assert.equal(seen.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, (err) => err instanceof DeadlineError && err.ms === 3000 && /3000 ms/.test(err.message));
  assert.equal(seen.aborted, true);
});

test('a call that obeys its signal, as fetch does, still ends with a DeadlineError, not its own AbortError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = withDeadline(3000, null, (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  }));
  pending.catch(() => {});
  await settle();
  t.mock.timers.tick(3000);
  await assert.rejects(pending, (err) => err instanceof DeadlineError);
});

test('a parent abort ends the call with an AbortError, not a DeadlineError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  let seen = null;
  const pending = withDeadline(3000, parent.signal, (signal) => {
    seen = signal;
    return new Promise(() => {});
  });
  pending.catch(() => {});
  await settle();
  parent.abort();
  await assert.rejects(pending, (err) => isAbort(err));
  assert.equal(seen.aborted, true);
});

test('a parent that is already aborted never starts the work', async () => {
  const parent = new AbortController();
  parent.abort();
  await assert.rejects(withDeadline(3000, parent.signal, async () => 'late'), (err) => isAbort(err));
});

test('a deadline that is not a positive number is refused before anything starts', async () => {
  let started = false;
  for (const ms of [undefined, null, NaN, 0, -5, Infinity, '3000']) {
    await assert.rejects(withDeadline(ms, null, async () => { started = true; }), (err) => err instanceof TypeError && /positive number/.test(err.message), String(ms));
  }
  assert.equal(started, false);
});

test('an error from the call comes through as it is', async () => {
  await assert.rejects(withDeadline(1000, null, async () => { throw new RangeError('boom'); }), RangeError);
});

test('redact removes the configured keys and anything shaped like one', () => {
  const key = 'sk-proj-abcdef0123456789';
  const said = redact(`Incorrect API key provided: ${key}. Also sk-abc***xyz and AIzaSyA1234567890abcdef, plus a-secret-word.`, [key, 'a-secret-word']);
  assert.ok(!said.includes(key));
  assert.ok(!said.includes('sk-abc'));
  assert.ok(!said.includes('AIzaSy'));
  assert.ok(!said.includes('a-secret-word'));
  assert.equal(redact(undefined), '');
  assert.equal(redact('nothing to hide', ['']), 'nothing to hide');
});

test('a SpeechError carries which provider, which step and what kind of failure', () => {
  const err = new SpeechError('openai transcribe: HTTP 503', { provider: 'openai', step: 'transcribe', kind: 'http', status: 503 });
  assert.equal(err.name, 'SpeechError');
  assert.deepEqual([err.provider, err.step, err.kind, err.status], ['openai', 'transcribe', 'http', 503]);
  assert.equal(isAbort(err), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test bridge/test/speech/deadline.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/speech/deadline.js`.

- [ ] **Step 3: Write the two modules**

Create `bridge/src/speech/errors.js`:

```js
// A provider call that did not work, described so the console can say which one and why, and so that nothing in the
// description can leak an API key.

// kind: timeout | http | network | bad-response | empty | unavailable
export class SpeechError extends Error {
  constructor(message, { provider = null, step = null, kind, status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpeechError';
    this.provider = provider;
    this.step = step;
    this.kind = kind;
    this.status = status;
  }
}

// The caller (not a provider) gave up: the front key stopped a reply, for example. Never a reason to skip a provider.
export function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
export const isAbort = (err) => err?.name === 'AbortError';

// Text that may come back from a server or an error, with anything key-shaped, and the keys themselves, removed.
export function redact(text, keys = []) {
  let out = String(text ?? '');
  for (const key of keys) if (key) out = out.split(key).join('[key]');
  return out.replace(/sk-[A-Za-z0-9_*.-]{6,}/g, '[key]').replace(/AIza[A-Za-z0-9_*.-]{10,}/g, '[key]');
}
```

Create `bridge/src/speech/deadline.js`:

```js
// Time limits for provider calls. They use setTimeout, so tests can drive them with mock timers.
import { abortError } from './errors.js';

export class DeadlineError extends Error {
  constructor(ms) {
    super(`no answer within ${ms} ms`);
    this.name = 'DeadlineError';
    this.ms = ms;
  }
}

// Runs fn(signal) and gives up after `ms`. `signal` is aborted on the deadline and when `parent` aborts, so a fetch
// that was given it stops too; fn is not trusted to honour it, so the result is a race. Rejects with a DeadlineError
// on the deadline and with an AbortError when the parent aborted.
export async function withDeadline(ms, parent, fn) {
  // A missing or misspelt limit must not turn into an instant or an endless wait.
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError(`a deadline needs a positive number of milliseconds, got ${ms}`);
  const ac = new AbortController();
  let timer;
  let onParent;
  const cut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new DeadlineError(ms));
    }, ms);
    onParent = () => {
      ac.abort();
      reject(abortError());
    };
    if (parent?.aborted) onParent();
    else parent?.addEventListener('abort', onParent, { once: true });
  });
  cut.catch(() => {}); // when fn wins, a later cut is not an unhandled rejection
  const work = Promise.resolve().then(() => fn(ac.signal));
  work.catch(() => {}); // the same, the other way round
  try {
    return await Promise.race([work, cut]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/speech/deadline.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/speech/errors.js bridge/src/speech/deadline.js bridge/test/speech/deadline.test.js
git commit -m "Bridge: SpeechError, key redaction and provider time limits" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The OpenAI adapter

The adapter only talks to OpenAI. The time limits, the fallbacks and the 5-minute skip belong to the chain (Task 9), which reads the adapter's `limits`. Keeping them apart lets the tests here stay short and lets the chain be tested with fake adapters.

**Files:**
- Create: `bridge/src/speech/openai.js`
- Create: `bridge/test/speech/fake-fetch.js` (a scripted `fetch`, also used by Tasks 8 and 9)
- Test: `bridge/test/speech/openai.test.js`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG` (Task 3); `ANSWER_SCHEMA` (Task 4); `SpeechError`, `isAbort`, `redact` (Task 6).
- Produces:
  - `fakeFetch(handler): fetch` with `fetch.calls` (`[{url, init}]`); `handler(url, init, n)` returns a `Response` or throws, and an already-aborted `init.signal` throws an `AbortError` before the handler runs. `jsonResponse(value, status = 200)`. `streamResponse(chunks, then = 'end', status = 200)`: a streaming body that hands out `chunks` one by one, then closes (`'end'`), stays open and silent (`'hang'`) or breaks (an `Error`).
  - `OPENAI_URL` and `createOpenAI({key, config, fetch = globalThis.fetch, baseUrl = OPENAI_URL})`, which returns:
    - `name: 'openai'`
    - `limits: {transcribeBaseMs, classifyMs, speakFirstByteMs, speakIdleMs}`, the config's numbers under the names the chain reads
    - `transcribe(wav: Buffer, {prompt, signal}?): Promise<string>`: a multipart POST of the WAV, the model and, when there is one, the prompt to `/audio/transcriptions`
    - `classify(transcript: string, {prompt, signal}?): Promise<string>`: a POST to `/chat/completions` with the prompt as system message, the transcript as user message, `reasoning_effort` from the config and the strict JSON schema; it returns the model's answer text untouched, and `validateAnswer` (Task 4) decides whether to trust it
    - `speak(text: string, {signal}?): AsyncGenerator<Buffer>`: a POST to `/audio/speech` for raw 24 kHz PCM, handed on chunk by chunk as it arrives. Nothing is requested until the first chunk is asked for, and letting go of the iterator cancels the download.
  - Failures are always a `SpeechError` with `provider: 'openai'`, the `step`, a `kind` (`http` with the status, `network`, `bad-response`) and a message in which the key cannot appear, even if the server echoes it. An abort from the caller passes through as it is: it is not the provider's failure.

These request shapes are the ones that worked in Stage 0 (29 Sep). The first real use is Task 11.

- [ ] **Step 1: Write the test helper and the failing test**

Create `bridge/test/speech/fake-fetch.js`:

```js
// A fetch that answers from a script and remembers what it was asked, for the provider tests.

// handler(url, init, n) returns a Response, or throws. calls collects {url, init}.
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

export const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// A streaming body that hands out `chunks` one by one; `then` decides what happens after the last one:
// 'end' closes the stream, 'hang' leaves it open and silent, an Error breaks it.
export function streamResponse(chunks, then = 'end', status = 200) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) return void controller.enqueue(new Uint8Array(chunks[i++]));
      if (then === 'end') return controller.close();
      if (then instanceof Error) return controller.error(then);
      return new Promise(() => {});
    },
  });
  return new Response(body, { status });
}
```

Create `bridge/test/speech/openai.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAI } from '../../src/speech/openai.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { ANSWER_SCHEMA } from '../../src/intent/intent.js';
import { SpeechError, isAbort } from '../../src/speech/errors.js';
import { fakeFetch, jsonResponse, streamResponse } from './fake-fetch.js';

const KEY = 'sk-test-0123456789abcdefghij';
const make = (fetch) => createOpenAI({ key: KEY, config: DEFAULT_CONFIG, fetch });

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test('transcribe posts the WAV, the model and the prompt as a form, and returns the text', async () => {
  const fetch = fakeFetch(() => jsonResponse({ text: '换到 on the beat 那个项目' }));
  const wav = Buffer.from('RIFF....WAVEdata-bytes');
  const text = await make(fetch).transcribe(wav, { prompt: '常见词：Claude' });
  assert.equal(text, '换到 on the beat 那个项目');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'gpt-transcribe');
  assert.equal(init.body.get('prompt'), '常见词：Claude');
  const file = init.body.get('file');
  assert.equal(file.name, 'clip.wav');
  assert.equal(file.type, 'audio/wav');
  assert.ok(Buffer.from(await file.arrayBuffer()).equals(wav));
  assert.ok(!url.includes(KEY));
});

test('transcribe without a prompt sends none', async () => {
  const fetch = fakeFetch(() => jsonResponse({ text: 'hi' }));
  await make(fetch).transcribe(Buffer.alloc(10));
  assert.equal(fetch.calls[0].init.body.has('prompt'), false);
});

test('classify asks for the strict schema with reasoning off and returns the answer text untouched', async () => {
  const answer = '{"intent":"stop","project":null,"text":""}';
  const fetch = fakeFetch(() => jsonResponse({ choices: [{ message: { content: answer } }] }));
  const got = await make(fetch).classify('等一下，先停住。', { prompt: 'SYSTEM PROMPT' });
  assert.equal(got, answer);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['content-type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning_effort, 'none');
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: '等一下，先停住。' },
  ]);
  assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: ANSWER_SCHEMA } });
});

test('speak asks for raw 24 kHz PCM and hands the audio on as it arrives, byte for byte', async () => {
  const chunks = [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6, 7, 8]), Buffer.from([9, 10])];
  const fetch = fakeFetch(() => streamResponse(chunks));
  const got = await collect(make(fetch).speak('好的，已经停住了。'));
  assert.deepEqual(got.map((b) => [...b]), chunks.map((b) => [...b]));
  assert.ok(got.every((b) => Buffer.isBuffer(b)));
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    input: '好的，已经停住了。',
    response_format: 'pcm',
    instructions: '用自然、亲切、简洁的普通话说，语速稍快。',
  });
});

test('speak asks for nothing until the first chunk is wanted', async () => {
  const fetch = fakeFetch(() => streamResponse([Buffer.alloc(4)]));
  const audio = make(fetch).speak('hi');
  assert.equal(fetch.calls.length, 0);
  await audio.next();
  assert.equal(fetch.calls.length, 1);
  await audio.return();
});

test('settings come from the config: model, voice and instructions', async () => {
  const config = { ...DEFAULT_CONFIG, voice: 'cedar', ttsInstructions: 'slowly', models: { ...DEFAULT_CONFIG.models, tts: 'tts-x', transcribe: 'stt-x', classify: 'llm-x', classifyEffort: 'low' } };
  const fetch = fakeFetch((url) =>
    url.endsWith('/speech') ? streamResponse([]) : url.endsWith('/transcriptions') ? jsonResponse({ text: 'a' }) : jsonResponse({ choices: [{ message: { content: '{}' } }] }),
  );
  const ai = createOpenAI({ key: KEY, config, fetch });
  await ai.transcribe(Buffer.alloc(2));
  await ai.classify('x', { prompt: 'p' });
  await collect(ai.speak('y'));
  assert.equal(fetch.calls[0].init.body.get('model'), 'stt-x');
  assert.deepEqual([JSON.parse(fetch.calls[1].init.body).model, JSON.parse(fetch.calls[1].init.body).reasoning_effort], ['llm-x', 'low']);
  const speech = JSON.parse(fetch.calls[2].init.body);
  assert.deepEqual([speech.model, speech.voice, speech.instructions], ['tts-x', 'cedar', 'slowly']);
});

test('an HTTP error says which provider, which step and which status', async () => {
  const fetch = fakeFetch(() => jsonResponse({ error: { message: 'The server is overloaded' } }, 503));
  await assert.rejects(make(fetch).transcribe(Buffer.alloc(2)), (err) => {
    assert.ok(err instanceof SpeechError);
    assert.deepEqual([err.provider, err.step, err.kind, err.status], ['openai', 'transcribe', 'http', 503]);
    assert.match(err.message, /openai transcribe: HTTP 503 The server is overloaded/);
    return true;
  });
});

test('an error that echoes the key back leaves no key in the message', async () => {
  const fetch = fakeFetch(() => jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}. You can find yours at platform.openai.com.` } }, 401));
  for (const run of [
    (ai) => ai.transcribe(Buffer.alloc(2)),
    (ai) => ai.classify('x', { prompt: 'p' }),
    (ai) => collect(ai.speak('x')),
  ]) {
    await assert.rejects(run(make(fetch)), (err) => {
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes(KEY), err.message);
      assert.ok(!err.message.includes('sk-test'), err.message);
      return true;
    });
  }
});

test('a dropped connection is a network error and names the cause', async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  });
  await assert.rejects(make(fetch).classify('x', { prompt: 'p' }), (err) => {
    assert.deepEqual([err.provider, err.step, err.kind], ['openai', 'classify', 'network']);
    assert.match(err.message, /ECONNRESET/);
    return true;
  });
});

test('a reply that is not what was asked for is a bad-response', async () => {
  const notJson = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 200 }));
  await assert.rejects(make(notJson).transcribe(Buffer.alloc(2)), (err) => err.kind === 'bad-response' && /not JSON/.test(err.message));
  const noText = fakeFetch(() => jsonResponse({ result: 1 }));
  await assert.rejects(make(noText).transcribe(Buffer.alloc(2)), (err) => err.kind === 'bad-response' && /no text/.test(err.message));
  const noAnswer = fakeFetch(() => jsonResponse({ choices: [] }));
  await assert.rejects(make(noAnswer).classify('x', { prompt: 'p' }), (err) => err.kind === 'bad-response' && /no answer/.test(err.message));
  const emptyAnswer = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(make(emptyAnswer).classify('x', { prompt: 'p' }), (err) => err.kind === 'bad-response');
});

test('an abort from the caller comes through as an AbortError, never as a provider failure', async () => {
  const ac = new AbortController();
  ac.abort();
  const fetch = fakeFetch(() => jsonResponse({ text: 'late' }));
  await assert.rejects(make(fetch).transcribe(Buffer.alloc(2), { signal: ac.signal }), (err) => isAbort(err) && !(err instanceof SpeechError));
  await assert.rejects(collect(make(fetch).speak('x', { signal: ac.signal })), (err) => isAbort(err) && !(err instanceof SpeechError));
});

test('an abort while the audio is still arriving is an AbortError too', async () => {
  const ac = new AbortController();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(960)); // what fetch does: the body errors when the signal aborts
      ac.signal.addEventListener('abort', () => controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    },
  });
  const audio = make(fakeFetch(() => new Response(body))).speak('x', { signal: ac.signal });
  await audio.next();
  const waiting = audio.next();
  ac.abort();
  await assert.rejects(waiting, (err) => isAbort(err) && !(err instanceof SpeechError));
});

test('a speech stream that breaks after some audio delivers it, then fails as a network error', async () => {
  const fetch = fakeFetch(() => streamResponse([Buffer.alloc(960, 7)], new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })));
  const audio = make(fetch).speak('x');
  const first = await audio.next();
  assert.equal(first.value.length, 960);
  await assert.rejects(audio.next(), (err) => err.kind === 'network' && err.step === 'speak' && /UND_ERR_SOCKET/.test(err.message));
});

test('letting go of a speech stream cancels the download', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(960));
    },
    cancel() {
      cancelled = true;
    },
  });
  const audio = make(fakeFetch(() => new Response(body))).speak('x');
  await audio.next();
  await audio.return();
  assert.equal(cancelled, true);
});

test('a reply with no audio body, and an error status on speak, both fail on the first chunk', async () => {
  await assert.rejects(collect(make(fakeFetch(() => new Response(null, { status: 200 }))).speak('x')), (err) => err.kind === 'bad-response');
  await assert.rejects(collect(make(fakeFetch(() => new Response('quota', { status: 429 }))).speak('x')), (err) => err.kind === 'http' && err.status === 429 && /quota/.test(err.message));
});

test('a different base URL is honoured, and the key still travels only in the header', async () => {
  const fetch = fakeFetch(() => jsonResponse({ text: 'ok' }));
  const ai = createOpenAI({ key: KEY, config: DEFAULT_CONFIG, fetch, baseUrl: 'http://127.0.0.1:9/v1' });
  await ai.transcribe(Buffer.alloc(2));
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:9/v1/audio/transcriptions');
  assert.ok(!fetch.calls[0].url.includes(KEY));
});

test('the time limits are the ones in the config, for the chain to enforce', () => {
  assert.deepEqual(make(fakeFetch(() => jsonResponse({}))).limits, { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: 3000, speakIdleMs: 3000 });
  const slow = createOpenAI({ key: KEY, config: { ...DEFAULT_CONFIG, timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs, classify: 9000 } }, fetch: fakeFetch(() => jsonResponse({})) });
  assert.equal(slow.limits.classifyMs, 9000);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --test bridge/test/speech/openai.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/speech/openai.js`.

- [ ] **Step 3: Write the adapter**

Create `bridge/src/speech/openai.js`:

```js
// The OpenAI provider: transcribe, classify and speak over plain fetch. It only talks; deadlines, fallbacks and the
// 5-minute skip belong to the chain in speech.js. Every failure is a SpeechError that says which step and why, with
// the key taken out of anything a server sent back.
import { ANSWER_SCHEMA } from '../intent/intent.js';
import { SpeechError, isAbort, redact } from './errors.js';

export const OPENAI_URL = 'https://api.openai.com/v1';

export function createOpenAI({ key, config, fetch: doFetch = globalThis.fetch, baseUrl = OPENAI_URL }) {
  const fail = (step, message, extra) => new SpeechError(`openai ${step}: ${redact(message, [key])}`, { provider: 'openai', step, ...extra });

  // What the server said was wrong, in one line: its error message when it sent one.
  async function reason(res) {
    let text = '';
    try {
      text = await res.text();
      text = JSON.parse(text)?.error?.message ?? text;
    } catch {
      // not JSON, or unreadable: what we have will do
    }
    return String(text).replace(/\s+/g, ' ').slice(0, 200);
  }

  async function call(step, path, init) {
    let res;
    try {
      res = await doFetch(`${baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw fail(step, `network error (${err.cause?.code ?? err.message})`, { kind: 'network', cause: err });
    }
    if (!res.ok) throw fail(step, `HTTP ${res.status} ${await reason(res)}`.trim(), { kind: 'http', status: res.status });
    return res;
  }

  async function json(res, step) {
    try {
      return await res.json();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw fail(step, 'the reply is not JSON', { kind: 'bad-response', cause: err });
    }
  }

  const t = config.timeoutsMs;
  return {
    name: 'openai',
    // The time limits of the spec's table, which the chain enforces: transcribe is transcribeBaseMs plus a share of the
    // clip's length (config.transcribeClipFraction).
    limits: { transcribeBaseMs: t.transcribeBase, classifyMs: t.classify, speakFirstByteMs: t.speakFirstByte, speakIdleMs: t.speakIdle },

    // The words in a 16 kHz mono PCM16 WAV.
    async transcribe(wav, { prompt = '', signal } = {}) {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
      form.append('model', config.models.transcribe);
      if (prompt) form.append('prompt', prompt);
      const res = await call('transcribe', '/audio/transcriptions', { method: 'POST', body: form, signal });
      const body = await json(res, 'transcribe');
      if (typeof body?.text !== 'string') throw fail('transcribe', 'the reply has no text', { kind: 'bad-response' });
      return body.text;
    },

    // The model's answer as the text it wrote, which is JSON in the shape of ANSWER_SCHEMA; validateAnswer() decides
    // whether it can be trusted.
    async classify(transcript, { prompt, signal } = {}) {
      const res = await call('classify', '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: config.models.classify,
          reasoning_effort: config.models.classifyEffort,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: transcript },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'intent', strict: true, schema: ANSWER_SCHEMA } },
        }),
      });
      const body = await json(res, 'classify');
      const answer = body?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string' || !answer) throw fail('classify', 'the reply has no answer', { kind: 'bad-response' });
      return answer;
    },

    // 24 kHz mono PCM16 as it arrives. Nothing is requested until the first chunk is asked for, and letting go of the
    // iterator cancels the request.
    async *speak(text, { signal } = {}) {
      const res = await call('speak', '/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: config.models.tts,
          voice: config.voice,
          input: text,
          response_format: 'pcm',
          instructions: config.ttsInstructions,
        }),
      });
      if (!res.body) throw fail('speak', 'the reply has no audio', { kind: 'bad-response' });
      try {
        for await (const chunk of res.body) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } catch (err) {
        if (isAbort(err)) throw err;
        throw fail('speak', `the audio stream broke (${err.cause?.code ?? err.message})`, { kind: 'network', cause: err });
      }
    },
  };
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/speech/openai.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/speech/openai.js bridge/test/speech/openai.test.js bridge/test/speech/fake-fetch.js
git commit -m "Bridge: OpenAI adapter for transcribing, classifying and speaking" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: WAV decoding and the Gemini adapter

Gemini is the fallback: it hears the audio itself and answers with the transcript and the intent in one call, and it speaks. It answers a spoken line with one WAV (or raw PCM), which `decodeWav` opens. Only `generateContent` is used (spec §10 leaves open whether to use it or the Interactions API; Stage 0 verified `generateContent`, and keeping Gemini in this one file means a later switch touches nothing else).

**Files:**
- Modify: `bridge/src/audio/wav.js` (add `decodeWav` at the end)
- Create: `bridge/src/speech/gemini.js`
- Modify: `bridge/test/audio/wav.test.js` (the import line, and four tests appended)
- Test: `bridge/test/speech/gemini.test.js`

**Interfaces:**
- Consumes: `encodeWav` and `levels` (plan 1, same file); `DEFAULT_CONFIG` (Task 3); `hearSchema` and `parseAnswer` (Task 4); `SpeechError`, `isAbort`, `redact` (Task 6); `fakeFetch` and `jsonResponse` (Task 7).
- Produces:
  - `decodeWav(buf: Buffer): {rate: number, pcm: Buffer}`: reads a PCM16 mono WAV. The `fmt ` and `data` chunks are found wherever they sit (a `LIST` chunk in front, an odd-sized chunk with its pad byte), and a `data` chunk that claims more than the file holds stops at the end of the file. Anything that is not PCM16 mono, and anything that is not a WAV, is an `Error` that says why.
  - `GEMINI_URL` and `createGemini({key, config, fetch = globalThis.fetch, baseUrl = GEMINI_URL})`, which returns:
    - `name: 'gemini'`
    - `hearModels: string[]`: `config.models.geminiHear`, in the order to try
    - `limits: {hearMs, speakFirstByteMs, speakIdleMs}`, the config's numbers under the names the chain reads
    - `hear(wav: Buffer, {prompt, classify = true, model, signal}?): Promise<{transcript, intent?, project?, text?}>`: one `generateContent` call on `model` with the WAV inline and the prompt, asking for JSON in the `hearSchema`. The answer is returned as the model wrote it (a fenced JSON answer and text split over parts are accepted); `validateAnswer` decides whether the intent can be trusted. A reply without a transcript is a `bad-response`.
    - `speak(text: string, {signal}?): AsyncGenerator<Buffer>`: one call with the style sentence 「用自然、简洁、语速稍快的普通话说：」 in front of the text and the configured voice (Kore). A WAV reply is decoded and raw PCM is taken as it is (a `rate=` in the type is honoured); anything that is not 24 kHz is refused, because the S3 plays exactly 24 kHz. It yields the samples as one chunk (an odd byte dropped), or nothing at all when the reply holds no samples. Nothing is requested until the chunk is asked for.
  - The model name goes into the URL path through `encodeURIComponent`, and the key travels only in the `x-goog-api-key` header. Errors follow Task 7's rules.

- [ ] **Step 1: Write the failing tests**

The four `decodeWav` tests go at the end of the existing `wav.test.js`, and its import line gains `decodeWav`.

In `bridge/test/audio/wav.test.js`, replace

```js
import { encodeWav, levels } from '../../src/audio/wav.js';
```

with

```js
import { decodeWav, encodeWav, levels } from '../../src/audio/wav.js';
```

Append to the end of `bridge/test/audio/wav.test.js`:

```js

function chunk(id, body) {
  const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, pad]);
}
const fmtBody = (format, channels, rate, bits) => {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
};
const riff = (...chunks) => {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

test('decodeWav reads what encodeWav wrote', () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
  const d = decodeWav(encodeWav(pcm, 24000));
  assert.equal(d.rate, 24000);
  assert.ok(d.pcm.equals(pcm));
});

test('decodeWav skips chunks it does not need, including an odd-sized one', () => {
  const pcm = Buffer.from([9, 0, 8, 0]);
  const wav = riff(chunk('LIST', Buffer.from('abc')), chunk('fmt ', fmtBody(1, 1, 16000, 16)), chunk('junk', Buffer.alloc(5)), chunk('data', pcm));
  const d = decodeWav(wav);
  assert.equal(d.rate, 16000);
  assert.ok(d.pcm.equals(pcm));
});

test('decodeWav stops a data chunk at the end of the file when it claims more', () => {
  const wav = encodeWav(Buffer.alloc(100, 7), 16000);
  wav.writeUInt32LE(0xffffffff, 40);
  assert.equal(decodeWav(wav).pcm.length, 100);
  const cut = encodeWav(Buffer.alloc(101, 7), 16000).subarray(0, 44 + 101); // a half sample at the end is dropped
  cut.writeUInt32LE(0xffffffff, 40);
  assert.equal(decodeWav(cut).pcm.length, 100);
});

test('decodeWav refuses anything but PCM16 mono, and files that are not WAVs', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav file at all')), /not a WAV file/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(1, 2, 16000, 16)), chunk('data', Buffer.alloc(8)))), /PCM16 mono, got format 1, 16 bits, 2 channels/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(3, 1, 16000, 32)), chunk('data', Buffer.alloc(8)))), /PCM16 mono, got format 3, 32 bits/);
  assert.throws(() => decodeWav(riff(chunk('data', Buffer.alloc(8)))), /data before its fmt/);
  assert.throws(() => decodeWav(riff(chunk('fmt ', fmtBody(1, 1, 16000, 16)))), /no data chunk/);
});
```

Create `bridge/test/speech/gemini.test.js`:

````js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGemini } from '../../src/speech/gemini.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { hearSchema } from '../../src/intent/intent.js';
import { encodeWav } from '../../src/audio/wav.js';
import { SpeechError, isAbort } from '../../src/speech/errors.js';
import { fakeFetch, jsonResponse } from './fake-fetch.js';

const KEY = 'AIzaSyTestKey0123456789abcdefghij';
const make = (fetch) => createGemini({ key: KEY, config: DEFAULT_CONFIG, fetch });

const reply = (text) => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
const audioReply = (buf, mimeType) => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data: buf.toString('base64') } }] } }] });

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test('hear sends the audio and the prompt, asks for JSON in the schema, and returns the answer', async () => {
  const answer = { transcript: '换到 on the beat 那个项目', intent: 'switch_project', project: 'on-the-beat', text: '' };
  const fetch = fakeFetch(() => reply(JSON.stringify(answer)));
  const wav = Buffer.from('RIFF....WAVEdata-bytes');
  const got = await make(fetch).hear(wav, { prompt: 'HEAR PROMPT', model: 'gemini-3.8-flash' });
  assert.deepEqual(got, answer);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.ok(!url.includes(KEY));
  const body = JSON.parse(init.body);
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }, { text: 'HEAR PROMPT' }] },
  ]);
  assert.deepEqual(body.generationConfig, { responseMimeType: 'application/json', responseSchema: hearSchema(true) });
});

test('hear without classification asks for the transcript alone', async () => {
  const fetch = fakeFetch(() => reply('{"transcript":"因为接口要向后兼容"}'));
  const got = await make(fetch).hear(Buffer.alloc(8), { prompt: 'p', classify: false, model: 'gemini-3.1-flash-lite' });
  assert.deepEqual(got, { transcript: '因为接口要向后兼容' });
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body).generationConfig.responseSchema, hearSchema(false));
  assert.match(fetch.calls[0].url, /models\/gemini-3\.1-flash-lite:generateContent$/);
});

test('the models to try come from the config, in order', () => {
  assert.deepEqual(make(fakeFetch(() => reply('{}'))).hearModels, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
});

test('hear accepts JSON inside a markdown fence, and text split over parts', async () => {
  const fenced = fakeFetch(() => reply('```json\n{"transcript":"你好"}\n```'));
  assert.deepEqual(await make(fenced).hear(Buffer.alloc(8), { prompt: 'p', model: 'm' }), { transcript: '你好' });
  const parts = fakeFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '{"transcript":' }, { text: '"你好"}' }] } }] }));
  assert.deepEqual(await make(parts).hear(Buffer.alloc(8), { prompt: 'p', model: 'm' }), { transcript: '你好' });
});

test('a reply without a usable transcript is a bad-response', async () => {
  for (const fetch of [
    fakeFetch(() => jsonResponse({ candidates: [] })),
    fakeFetch(() => jsonResponse({ promptFeedback: { blockReason: 'OTHER' } })),
    fakeFetch(() => reply('I could not hear anything.')),
    fakeFetch(() => reply('{"intent":"stop"}')),
    fakeFetch(() => reply('{"transcript":3}')),
    fakeFetch(() => new Response('oops', { status: 200 })),
  ]) {
    await assert.rejects(make(fetch).hear(Buffer.alloc(8), { prompt: 'p', model: 'm' }), (err) => err instanceof SpeechError && err.kind === 'bad-response' && err.step === 'hear');
  }
});

test('an HTTP error says which provider, which step and which status', async () => {
  const fetch = fakeFetch(() => jsonResponse({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }, 503));
  await assert.rejects(make(fetch).hear(Buffer.alloc(8), { prompt: 'p', model: 'gemini-3.8-flash' }), (err) => {
    assert.deepEqual([err.provider, err.step, err.kind, err.status], ['gemini', 'hear', 'http', 503]);
    assert.match(err.message, /gemini hear: HTTP 503 The model is overloaded/);
    return true;
  });
});

test('an error that echoes the key back leaves no key in the message', async () => {
  const fetch = fakeFetch(() => jsonResponse({ error: { message: `API key not valid: ${KEY}. Please pass a valid API key.` } }, 400));
  for (const run of [
    (g) => g.hear(Buffer.alloc(8), { prompt: 'p', model: 'm' }),
    (g) => collect(g.speak('x')),
  ]) {
    await assert.rejects(run(make(fetch)), (err) => {
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes(KEY), err.message);
      assert.ok(!err.message.includes('AIza'), err.message);
      return true;
    });
  }
});

test('a dropped connection is a network error and names the cause', async () => {
  const fetch = fakeFetch(() => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  });
  await assert.rejects(make(fetch).hear(Buffer.alloc(8), { prompt: 'p', model: 'm' }), (err) => err.kind === 'network' && /ETIMEDOUT/.test(err.message));
});

test('an abort from the caller comes through as an AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  const fetch = fakeFetch(() => reply('{"transcript":"x"}'));
  await assert.rejects(make(fetch).hear(Buffer.alloc(8), { prompt: 'p', model: 'm', signal: ac.signal }), (err) => isAbort(err) && !(err instanceof SpeechError));
  await assert.rejects(collect(make(fetch).speak('x', { signal: ac.signal })), (err) => isAbort(err) && !(err instanceof SpeechError));
});

test('speak asks for audio in the configured voice with the style in front of the text', async () => {
  const pcm = Buffer.alloc(9600, 3);
  const fetch = fakeFetch(() => audioReply(encodeWav(pcm, 24000), 'audio/wav'));
  await collect(make(fetch).speak('好的，已经停住了。'));
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(JSON.parse(init.body), {
    contents: [{ role: 'user', parts: [{ text: '用自然、简洁、语速稍快的普通话说：好的，已经停住了。' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  });
});

test('speak returns the samples of a WAV reply without its header, as a single chunk', async () => {
  const pcm = Buffer.from(Array.from({ length: 4800 }, (_, i) => i % 251));
  const chunks = await collect(make(fakeFetch(() => audioReply(encodeWav(pcm, 24000), 'audio/wav'))).speak('x'));
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].equals(pcm));
});

test('speak takes raw PCM as it is, with or without a rate in the type', async () => {
  const pcm = Buffer.alloc(4800, 9);
  for (const mime of ['audio/L16;codec=pcm;rate=24000', 'audio/pcm', undefined]) {
    const chunks = await collect(make(fakeFetch(() => audioReply(pcm, mime))).speak('x'));
    assert.ok(Buffer.concat(chunks).equals(pcm), String(mime));
  }
});

test('speak refuses audio that is not 24 kHz, because the S3 plays exactly that', async () => {
  const pcm = Buffer.alloc(4800);
  await assert.rejects(collect(make(fakeFetch(() => audioReply(pcm, 'audio/L16;codec=pcm;rate=16000'))).speak('x')), (err) => err.kind === 'bad-response' && /16000 Hz/.test(err.message));
  await assert.rejects(collect(make(fakeFetch(() => audioReply(encodeWav(pcm, 44100), 'audio/wav'))).speak('x')), (err) => err.kind === 'bad-response' && /44100 Hz/.test(err.message));
});

test('speak refuses a WAV it cannot read, and a reply with no audio part', async () => {
  const stereo = encodeWav(Buffer.alloc(4800), 24000);
  stereo.writeUInt16LE(2, 22); // two channels
  await assert.rejects(collect(make(fakeFetch(() => audioReply(stereo, 'audio/wav'))).speak('x')), (err) => err.kind === 'bad-response' && /mono/.test(err.message));
  await assert.rejects(collect(make(fakeFetch(() => reply('no audio here'))).speak('x')), (err) => err.kind === 'bad-response' && /no audio/.test(err.message));
});

test('a reply with no samples at all yields nothing, and an odd byte is dropped', async () => {
  assert.deepEqual(await collect(make(fakeFetch(() => audioReply(encodeWav(Buffer.alloc(0), 24000), 'audio/wav'))).speak('x')), []);
  const odd = Buffer.alloc(4801, 1);
  const chunks = await collect(make(fakeFetch(() => audioReply(odd, 'audio/pcm'))).speak('x'));
  assert.equal(Buffer.concat(chunks).length, 4800);
});

test('speak asks for nothing until the audio is wanted', async () => {
  const fetch = fakeFetch(() => audioReply(Buffer.alloc(4800), 'audio/pcm'));
  const audio = make(fetch).speak('x');
  assert.equal(fetch.calls.length, 0);
  await audio.next();
  assert.equal(fetch.calls.length, 1);
});

test('a model name cannot change the path it is requested from', async () => {
  const fetch = fakeFetch(() => reply('{"transcript":"x"}'));
  await make(fetch).hear(Buffer.alloc(8), { prompt: 'p', model: 'a/b?c' });
  assert.equal(fetch.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/a%2Fb%3Fc:generateContent');
});

test('the time limits are the ones in the config, for the chain to enforce', () => {
  assert.deepEqual(make(fakeFetch(() => reply('{}'))).limits, { hearMs: 8000, speakFirstByteMs: 10000, speakIdleMs: 10000 });
});
````

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/audio/wav.test.js bridge/test/speech/gemini.test.js`
Expected: FAIL. `wav.test.js` cannot load (`SyntaxError`: the module `src/audio/wav.js` does not provide an export named `decodeWav`), and `gemini.test.js` fails with `ERR_MODULE_NOT_FOUND` for `src/speech/gemini.js`.

- [ ] **Step 3: Write `decodeWav` and the adapter**

Append to the end of `bridge/src/audio/wav.js`:

```js

// Reads a PCM16 mono WAV. The fmt and data chunks are found wherever they sit (LIST and other chunks are skipped),
// and a data chunk that claims more than the file holds (streamed WAVs say 0xFFFFFFFF) ends at the end of the file.
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('the WAV fmt chunk is too short');
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('the WAV has its data before its fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(`need PCM16 mono, got format ${fmt.format}, ${fmt.bits} bits, ${fmt.channels} channels`);
      }
      const end = Math.min(buf.length, body + size);
      return { rate: fmt.rate, pcm: buf.subarray(body, end - ((end - body) % 2)) };
    }
    pos = body + size + (size % 2); // chunks are padded to an even size
  }
  throw new Error('the WAV has no data chunk');
}
```

Create `bridge/src/speech/gemini.js`:

```js
// The Gemini provider, the fallback: it hears the audio itself (transcript and classification in one call) and it
// speaks. Like openai.js it only talks; deadlines and the 5-minute skip belong to the chain in speech.js.
import { decodeWav } from '../audio/wav.js';
import { hearSchema, parseAnswer } from '../intent/intent.js';
import { SpeechError, isAbort, redact } from './errors.js';

export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const SPEAK_STYLE = '用自然、简洁、语速稍快的普通话说：';
const SPEAK_RATE = 24000;

export function createGemini({ key, config, fetch: doFetch = globalThis.fetch, baseUrl = GEMINI_URL }) {
  const fail = (step, message, extra) => new SpeechError(`gemini ${step}: ${redact(message, [key])}`, { provider: 'gemini', step, ...extra });

  async function reason(res) {
    let text = '';
    try {
      text = await res.text();
      text = JSON.parse(text)?.error?.message ?? text;
    } catch {
      // not JSON, or unreadable: what we have will do
    }
    return String(text).replace(/\s+/g, ' ').slice(0, 200);
  }

  async function generate(step, model, body, signal) {
    let res;
    try {
      res = await doFetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw fail(step, `network error (${err.cause?.code ?? err.message})`, { kind: 'network', cause: err });
    }
    if (!res.ok) throw fail(step, `HTTP ${res.status} ${await reason(res)}`.trim(), { kind: 'http', status: res.status });
    try {
      return await res.json();
    } catch (err) {
      if (isAbort(err)) throw err;
      throw fail(step, 'the reply is not JSON', { kind: 'bad-response', cause: err });
    }
  }

  const t = config.timeoutsMs;
  return {
    name: 'gemini',
    hearModels: config.models.geminiHear,
    // hearMs is per model; Gemini's reply is one piece, so the first byte and the pause between chunks are the whole wait.
    limits: { hearMs: t.geminiHear, speakFirstByteMs: t.geminiSpeak, speakIdleMs: t.geminiSpeak },

    // {transcript} and, with `classify`, {intent, project, text} as the model wrote them; validateAnswer() decides
    // whether the classification can be trusted. `model` is one of hearModels.
    async hear(wav, { prompt, classify = true, model, signal } = {}) {
      const reply = await generate(
        'hear',
        model,
        {
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }, { text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: hearSchema(classify) },
        },
        signal,
      );
      const text = reply?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const answer = parseAnswer(text);
      if (!answer || typeof answer.transcript !== 'string') throw fail('hear', 'the reply has no transcript', { kind: 'bad-response' });
      return answer;
    },

    // The whole reply, as one chunk of 24 kHz mono PCM16: Gemini does not stream it. Nothing is requested until the
    // chunk is asked for.
    async *speak(text, { signal } = {}) {
      const reply = await generate(
        'speak',
        config.models.geminiTts,
        {
          contents: [{ role: 'user', parts: [{ text: SPEAK_STYLE + text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.geminiVoice } } },
          },
        },
        signal,
      );
      const part = reply?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part) throw fail('speak', 'the reply has no audio', { kind: 'bad-response' });
      let pcm = Buffer.from(part.inlineData.data, 'base64');
      let rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? SPEAK_RATE);
      if (pcm.length >= 4 && pcm.toString('ascii', 0, 4) === 'RIFF') {
        try {
          ({ pcm, rate } = decodeWav(pcm));
        } catch (err) {
          throw fail('speak', `the audio is not usable (${err.message})`, { kind: 'bad-response', cause: err });
        }
      }
      if (rate !== SPEAK_RATE) throw fail('speak', `the audio is ${rate} Hz, ${SPEAK_RATE} Hz is needed`, { kind: 'bad-response' });
      if (pcm.length > 1) yield pcm.subarray(0, pcm.length - (pcm.length % 2));
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/audio/wav.test.js bridge/test/speech/gemini.test.js`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/audio/wav.js bridge/src/speech/gemini.js bridge/test/audio/wav.test.js bridge/test/speech/gemini.test.js
git commit -m "Bridge: decodeWav and the Gemini adapter for hearing and speaking" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The provider chain

This is the file that knows the order, the limits and the last resorts of spec §6.5. How to talk to a provider stays in the adapters.

**Files:**
- Create: `bridge/src/speech/speech.js`
- Test: `bridge/test/speech/speech.test.js` (the chain on fake adapters and mock timers)
- Test: `bridge/test/speech/chain.test.js` (the real adapters under the real chain, on a scripted `fetch`)

**Interfaces:**
- Consumes: `DEFAULT_CONFIG` (Task 3); `validateAnswer`, `fixedPhrase`, `isFiller`, `transcriptionPrompt`, `classifyPrompt`, `hearPrompt`, `SET_PROJECTS` (Task 4); `applyLoudness`, `processAll` (Task 2); `SpeechError`, `abortError`, `isAbort`, `redact`, `DeadlineError`, `withDeadline` (Task 6); `createOpenAI`, `fakeFetch`, `jsonResponse`, `streamResponse` (Task 7); `createGemini`, `encodeWav`, `decodeWav` (Task 8); `tone` (plan 1).
- Produces:
  - `createAdapters({keys, config, fetch}): adapter[]`: the providers that have a key, OpenAI first and Gemini second, on the given `fetch`.
  - `failureTone(): Buffer`: a soft 330 Hz tone of 0.3 s, 24 kHz PCM16, with 10 ms fades at both ends. It is the short tone for a reply that can only be shown as text.
  - `createSpeech({adapters, config, projects, log = () => {}, now = () => Date.now()}): {hear, classify, say}`. `log(line)` is told which candidate failed and why, and what is skipped; `now()` is the clock the skip windows run on.
    - `hear(pcm, {currentProject = null, busy = false, classify = true, only = null, signal}?)`: `pcm` is 16 kHz mono PCM16 as the S3 recorded it, the start-up transient still in front (the first 250 ms are dropped here). It resolves with `{status: 'ok', transcript, intent, project, text, transcribedBy, classifiedBy, ms: {transcribe, classify}}`, where `classifiedBy` is `openai`, `gemini`, `phrase` (the fixed-phrase table) or `default` (nothing decided, so `to_claude` with the transcript), or with `{status: 'unclear', reason: 'too-short' | 'empty' | 'unavailable', transcript: ''}`, which is 「没听清，再说一次」 on the device and nothing sent to Claude. With `classify: false` (a reason spoken while an approval waits) `intent` is `null`, `classifiedBy` is `null` and `text` is the transcript.
    - `classify(transcript, {currentProject, busy, only, signal}?)`: the same classification for a transcript that is already text, `{intent, project, text, classifiedBy}`.
    - `say(text, {only, signal}?)`: resolves as soon as a provider has produced its first audio, with `{provider, audio}`. `audio` is an async iterable of 24 kHz PCM16 chunks that have been through the loudness chain, ready for `Link.playStream`. The caller must play it to the end or abort `signal`; either lets go of the provider's request. It rejects with a `SpeechError` of kind `unavailable` when nobody can speak: the caller shows the text and plays `failureTone()`.
  - `only` names one provider (`'openai'` or `'gemini'`) to use and nothing else. The developer commands use it to test a provider on purpose: it ignores the skip windows and never starts one.

**Decisions made here, for him to overrule:**
- Skip windows are per candidate and step (`openai:transcribe`, `openai:classify`, `openai:speak`, `gemini:hear:<model>`, `gemini:speak`), not per provider. A voice that fails must not silence the transcriber, and the two Gemini hearing models each get their own window.
- A model whose answer cannot be used (an unknown intent, a project that does not exist) is not skipped: that is the model's fault and the next answer may be fine. The chain falls back to the fixed phrases and then to Claude.
- A provider that fails after its first audio ends the reply with the error. There is no replay on the other voice, because a second voice in the middle of a sentence is worse than a short reply. The failing candidate is skipped from the next reply on.
- A voice that goes silent for `speakIdle` (3 s) in the middle of a reply counts as failed. The spec has no such limit; without one a stalled download would hold the S3's playback open forever.
- A lone filler (「嗯」, "um") is 「没听清」, like an empty transcript (Task 4's `isFiller`).

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/speech/speech.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, createSpeech, failureTone } from '../../src/speech/speech.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { SET_PROJECTS } from '../fixtures/utterances.js';
import { SpeechError, isAbort } from '../../src/speech/errors.js';
import { processAll } from '../../src/speech/loudness.js';
import { decodeWav } from '../../src/audio/wav.js';
import { tone } from '../../src/audio/tone.js';
import { fakeFetch, jsonResponse } from './fake-fetch.js';

const settle = () => new Promise((r) => setImmediate(r));

// A provider whose steps are scripted: each method runs the function it was given and remembers its arguments.
function fake(name, steps, limits = {}) {
  const gemini = name === 'gemini';
  const calls = {};
  const adapter = {
    name,
    calls,
    limits: { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: gemini ? 10000 : 3000, speakIdleMs: gemini ? 10000 : 3000, hearMs: 8000, ...limits },
  };
  if (gemini) adapter.hearModels = ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  for (const [step, run] of Object.entries(steps)) {
    calls[step] = [];
    adapter[step] =
      step === 'speak'
        ? async function* (...args) {
            calls[step].push(args);
            yield* run(...args);
          }
        : async (...args) => {
            calls[step].push(args);
            return run(...args);
          };
  }
  return adapter;
}

function make(adapters, extra = {}) {
  const lines = [];
  const speech = createSpeech({ adapters, config: DEFAULT_CONFIG, projects: SET_PROJECTS, log: (line) => lines.push(line), ...extra });
  return { speech, lines };
}

// What the S3 sends: 250 ms of start-up transient, then `ms` of speech, 16 kHz PCM16.
const clip = (ms) => Buffer.alloc((250 + ms) * 32, 1);
const answer = (intent, project = null, text = '') => JSON.stringify({ intent, project, text });
const httpError = (provider, step, status) => new SpeechError(`${provider} ${step}: HTTP ${status} overloaded`, { provider, step, kind: 'http', status });
const never = () => new Promise(() => {});

async function drain(iterable) {
  const chunks = [];
  try {
    for await (const chunk of iterable) chunks.push(chunk);
  } catch (error) {
    return { chunks, error };
  }
  return { chunks, error: null };
}

// ---- hear ----------------------------------------------------------------------------------------------------

test('hear drops the start-up transient, transcribes, classifies, and says who did what', async () => {
  const openai = fake('openai', { transcribe: async () => '等一下，先停住。', classify: async () => answer('stop') });
  const { speech } = make([openai]);
  const pcm = Buffer.concat([Buffer.alloc(8000, 1), Buffer.alloc(32000, 2)]); // 250 ms of transient, then 1 s
  const heard = await speech.hear(pcm, { currentProject: 'walkie', busy: true });
  assert.deepEqual({ ...heard, ms: null }, {
    status: 'ok',
    transcript: '等一下，先停住。',
    transcribedBy: 'openai',
    intent: 'stop',
    project: null,
    text: '',
    classifiedBy: 'openai',
    ms: null,
  });
  assert.equal(typeof heard.ms.transcribe, 'number');
  assert.equal(typeof heard.ms.classify, 'number');
  const [wav, ask] = openai.calls.transcribe[0];
  const { rate, pcm: sent } = decodeWav(wav);
  assert.equal(rate, 16000);
  assert.equal(sent.length, 32000);
  assert.ok(sent.every((b) => b === 2), 'the first 250 ms are gone');
  assert.match(ask.prompt, /on-the-beat/);
  assert.match(openai.calls.classify[0][1].prompt, /Current project: walkie\. Claude is working\./);
  assert.equal(openai.calls.classify[0][0], '等一下，先停住。');
});

test('a clip with under 300 ms left after the trim goes nowhere', async () => {
  const openai = fake('openai', { transcribe: async () => '好', classify: async () => answer('to_claude', null, '好') });
  const { speech } = make([openai]);
  const tooShort = { status: 'unclear', reason: 'too-short', transcript: '' };
  for (const ms of [0, 100, 299]) assert.deepEqual(await speech.hear(clip(ms)), tooShort, `${ms} ms`);
  assert.deepEqual(await speech.hear(Buffer.alloc(100)), tooShort, 'shorter than the trim itself');
  assert.deepEqual(await speech.hear(Buffer.alloc(0)), tooShort);
  assert.equal(openai.calls.transcribe.length, 0);
  assert.equal((await speech.hear(clip(300))).status, 'ok');
});

test('an empty transcript is 没听清 and goes nowhere, not even to the fallback', async () => {
  const openai = fake('openai', { transcribe: async () => ' \n ', classify: async () => answer('stop') });
  const gemini = fake('gemini', { hear: async () => ({ transcript: '继续', intent: 'continue' }) });
  const { speech } = make([openai, gemini]);
  assert.deepEqual(await speech.hear(clip(1000)), { status: 'unclear', reason: 'empty', transcript: '' });
  assert.equal(openai.calls.classify?.length ?? 0, 0);
  assert.equal(gemini.calls.hear.length, 0);
});

test('a lone filler sound is 没听清 too, and a filler in front of a request is not', async () => {
  for (const said of ['嗯。', 'Um.', '呃…']) {
    const openai = fake('openai', { transcribe: async () => said, classify: async () => answer('to_claude', null, said) });
    assert.deepEqual(await make([openai]).speech.hear(clip(1000)), { status: 'unclear', reason: 'empty', transcript: '' }, said);
    assert.equal(openai.calls.classify.length, 0);
  }
  const openai = fake('openai', { transcribe: async () => '呃，继续', classify: async () => answer('continue') });
  assert.equal((await make([openai]).speech.hear(clip(1000))).status, 'ok');
});

test('with classify off, as while an approval waits, the words are all that comes back', async () => {
  const openai = fake('openai', { transcribe: async () => '因为接口要向后兼容', classify: async () => answer('stop') });
  const { speech } = make([openai]);
  const heard = await speech.hear(clip(1000), { classify: false });
  assert.deepEqual({ ...heard, ms: null }, {
    status: 'ok',
    transcript: '因为接口要向后兼容',
    transcribedBy: 'openai',
    intent: null,
    project: null,
    text: '因为接口要向后兼容',
    classifiedBy: null,
    ms: null,
  });
  assert.equal(heard.ms.classify, null);
  assert.equal(openai.calls.classify.length, 0);

  const gemini = fake('gemini', { hear: async () => ({ transcript: '因为接口要向后兼容' }) });
  const viaGemini = await make([gemini]).speech.hear(clip(1000), { classify: false });
  assert.equal(viaGemini.intent, null);
  assert.equal(gemini.calls.hear[0][1].classify, false);
});

test('an answer the validator rejects is not trusted: a fixed phrase decides, and the provider is not skipped', async () => {
  const openai = fake('openai', { transcribe: async () => '停一下', classify: async () => '{"intent":"dance","project":null,"text":""}' });
  const { speech, lines } = make([openai]);
  const heard = await speech.hear(clip(1000));
  assert.deepEqual([heard.intent, heard.classifiedBy], ['stop', 'phrase']);
  assert.ok(lines.some((l) => /openai classify gave an answer that cannot be used/.test(l)));
  assert.ok(!lines.some((l) => /skipping/.test(l)));
  await speech.hear(clip(1000));
  assert.equal(openai.calls.classify.length, 2);
});

test('a switch to a project that does not exist is not one', async () => {
  const openai = fake('openai', { transcribe: async () => '切到手环项目', classify: async () => answer('switch_project', 'no-such-project') });
  const heard = await make([openai]).speech.hear(clip(1000));
  assert.deepEqual([heard.intent, heard.project, heard.classifiedBy], ['switch_project', 'on-the-beat', 'phrase']);
});

test('the work request that contains 停止 is never taken for a stop, even when no model can classify', async () => {
  const transcript = '停止服务之前先备份数据库';
  const openai = fake('openai', { transcribe: async () => transcript, classify: async () => { throw httpError('openai', 'classify', 503); } });
  const heard = await make([openai]).speech.hear(clip(1000));
  assert.deepEqual([heard.intent, heard.text, heard.classifiedBy], ['to_claude', transcript, 'default']);
});

test('a classifier that does not answer in 3.5 s is skipped for 5 minutes, then asked again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let hang = true;
  const transcript = '帮我跑一下 npm test，然后 commit。';
  const openai = fake('openai', {
    transcribe: async () => transcript,
    classify: () => (hang ? never() : Promise.resolve(answer('to_claude', null, transcript))),
  });
  const { speech, lines } = make([openai]);
  const pending = speech.hear(clip(1000));
  await settle();
  t.mock.timers.tick(3499);
  await settle();
  assert.equal(openai.calls.classify.length, 1);
  t.mock.timers.tick(1);
  const heard = await pending;
  assert.deepEqual([heard.intent, heard.text, heard.classifiedBy], ['to_claude', transcript, 'default']);
  assert.ok(lines.includes('speech: openai classify: no answer within 3500 ms; skipping openai classify for 5 min'), lines.join('\n'));
  assert.equal(openai.calls.classify[0][1].signal.aborted, true, 'the request is cancelled');

  hang = false;
  t.mock.timers.tick(299_999); // 3500 ms + 5 min - 1 ms: still skipped
  await speech.hear(clip(1000));
  assert.equal(openai.calls.classify.length, 1);
  t.mock.timers.tick(1);
  const again = await speech.hear(clip(1000));
  assert.equal(openai.calls.classify.length, 2);
  assert.equal(again.classifiedBy, 'openai');
});

test('when OpenAI cannot transcribe, Gemini hears and classifies in one call, and OpenAI is skipped next time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const openai = fake('openai', { transcribe: async () => { throw httpError('openai', 'transcribe', 503); }, classify: async () => answer('stop') });
  const gemini = fake('gemini', { hear: async () => ({ transcript: '换到 on the beat 那个项目', intent: 'switch_project', project: 'on-the-beat', text: '' }) });
  const { speech, lines } = make([openai, gemini]);
  const heard = await speech.hear(clip(1000), { currentProject: 'walkie' });
  assert.deepEqual({ ...heard, ms: null }, {
    status: 'ok',
    transcript: '换到 on the beat 那个项目',
    transcribedBy: 'gemini',
    intent: 'switch_project',
    project: 'on-the-beat',
    text: '',
    classifiedBy: 'gemini',
    ms: null,
  });
  assert.equal(openai.calls.classify.length, 0, 'Gemini already classified it');
  const [wav, ask] = gemini.calls.hear[0];
  assert.equal(decodeWav(wav).pcm.length, 32000);
  assert.deepEqual([ask.model, ask.classify], ['gemini-3.8-flash', true]);
  assert.match(ask.prompt, /Current project: walkie/);
  assert.ok(lines.includes('speech: openai transcribe: HTTP 503 overloaded; skipping openai transcribe for 5 min'), lines.join('\n'));

  await speech.hear(clip(1000));
  assert.equal(openai.calls.transcribe.length, 1, 'skipped: one timeout per bad spell, not one per utterance');
  assert.equal(gemini.calls.hear.length, 2);
});

test('each Gemini model has its own skip window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gemini = fake('gemini', {
    hear: async (wav, { model }) => {
      if (model === 'gemini-3.8-flash') throw httpError('gemini', 'hear', 503);
      return { transcript: '继续', intent: 'continue', project: null, text: '' };
    },
  });
  const { speech, lines } = make([gemini]);
  assert.equal((await speech.hear(clip(1000))).intent, 'continue');
  assert.deepEqual(gemini.calls.hear.map((c) => c[1].model), ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  assert.ok(lines.some((l) => /skipping gemini hear \(gemini-3\.8-flash\) for 5 min/.test(l)), lines.join('\n'));
  await speech.hear(clip(1000));
  assert.deepEqual(gemini.calls.hear.map((c) => c[1].model), ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite']);
});

test('a transcription is given up on after 3 s plus 10% of the clip, and the fallback answers', async (t) => {
  for (const [ms, limit] of [[1000, 3100], [10000, 4000]]) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const openai = fake('openai', { transcribe: never });
    const gemini = fake('gemini', { hear: async () => ({ transcript: '继续', intent: 'continue', project: null, text: '' }) });
    const { speech, lines } = make([openai, gemini]);
    const pending = speech.hear(clip(ms));
    await settle();
    t.mock.timers.tick(limit - 1);
    await settle();
    assert.equal(gemini.calls.hear.length, 0, `${ms} ms clip, at ${limit - 1} ms`);
    t.mock.timers.tick(1);
    assert.equal((await pending).transcribedBy, 'gemini');
    assert.ok(lines.some((l) => l.includes(`openai transcribe: no answer within ${limit} ms`)), lines.join('\n'));
    t.mock.timers.reset();
  }
});

test('a Gemini call that does not answer in 8 s moves on to the next model', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const gemini = fake('gemini', { hear: (wav, { model }) => (model === 'gemini-3.8-flash' ? never() : Promise.resolve({ transcript: '继续', intent: 'continue', project: null, text: '' })) });
  const pending = make([gemini]).speech.hear(clip(1000));
  await settle();
  t.mock.timers.tick(7999);
  await settle();
  assert.equal(gemini.calls.hear.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).transcribedBy, 'gemini');
  assert.equal(gemini.calls.hear.length, 2);
});

test('when nobody can transcribe, the clip is 没听清 and the console says so, with no key in it', async () => {
  const openai = fake('openai', { transcribe: async () => { throw new Error('boom sk-proj-abcdefghijklmnop'); } });
  const gemini = fake('gemini', { hear: async () => { throw httpError('gemini', 'hear', 500); } });
  const { speech, lines } = make([openai, gemini]);
  assert.deepEqual(await speech.hear(clip(1000)), { status: 'unclear', reason: 'unavailable', transcript: '' });
  assert.ok(lines.includes('speech: no provider could transcribe this clip'));
  assert.ok(lines.some((l) => l.startsWith('speech: openai transcribe: boom [key]')), lines.join('\n'));
  assert.ok(!lines.join('\n').includes('sk-proj'));
  assert.equal(gemini.calls.hear.length, 2, 'both Gemini models were tried');
});

test('a rejected key is reported as such, and skipped like any other failure', async () => {
  const openai = fake('openai', { transcribe: async () => { throw new SpeechError('openai transcribe: HTTP 401 Incorrect API key', { kind: 'http', status: 401 }); } });
  const { speech, lines } = make([openai]);
  await speech.hear(clip(1000));
  assert.ok(lines.includes('speech: openai transcribe: HTTP 401 Incorrect API key (check the API key); skipping openai transcribe for 5 min'), lines.join('\n'));
});

test('the caller giving up ends hear with an AbortError and starts no skip window', async () => {
  let hang = true;
  const openai = fake('openai', { transcribe: () => (hang ? never() : Promise.resolve('继续')), classify: async () => answer('continue') });
  const { speech, lines } = make([openai]);
  const ac = new AbortController();
  const pending = speech.hear(clip(1000), { signal: ac.signal });
  await settle();
  ac.abort();
  await assert.rejects(pending, (err) => isAbort(err));
  assert.equal(openai.calls.transcribe[0][1].signal.aborted, true);
  assert.deepEqual(lines, []);
  hang = false;
  assert.equal((await speech.hear(clip(1000))).transcribedBy, 'openai');

  const gone = new AbortController();
  gone.abort();
  await assert.rejects(speech.hear(clip(1000), { signal: gone.signal }), (err) => isAbort(err));
  assert.equal(openai.calls.transcribe.length, 2, 'an abort that came first starts nothing');
});

test('an intent Gemini gives that cannot be used falls back to a fixed phrase, then to Claude', async () => {
  const bad = { transcript: '切到手环项目', intent: 'switch_project', project: 'no-such-project', text: '' };
  const gemini = fake('gemini', { hear: async () => bad });
  const { speech, lines } = make([gemini]);
  const heard = await speech.hear(clip(1000));
  assert.deepEqual([heard.intent, heard.project, heard.classifiedBy, heard.transcribedBy], ['switch_project', 'on-the-beat', 'phrase', 'gemini']);
  assert.ok(lines.some((l) => /gemini gave an intent that cannot be used/.test(l)));
  bad.transcript = '把登录页的停止按钮改成红色';
  bad.intent = 'dance';
  const other = await speech.hear(clip(1000));
  assert.deepEqual([other.intent, other.text, other.classifiedBy], ['to_claude', '把登录页的停止按钮改成红色', 'default']);
});

test('Gemini hearing nothing is 没听清 too', async () => {
  const gemini = fake('gemini', { hear: async () => ({ transcript: '  ', intent: 'to_claude', text: '' }) });
  assert.deepEqual(await make([gemini]).speech.hear(clip(1000)), { status: 'unclear', reason: 'empty', transcript: '' });
});

test('only: uses that provider alone, and neither honours nor starts skip windows', async () => {
  let broken = true;
  const openai = fake('openai', { transcribe: async () => '继续', classify: async () => answer('continue') });
  const gemini = fake('gemini', { hear: async () => { if (broken) throw httpError('gemini', 'hear', 503); return { transcript: '继续', intent: 'continue', project: null, text: '' }; } });
  const { speech, lines } = make([openai, gemini]);
  const heard = await speech.hear(clip(1000), { only: 'gemini' });
  assert.deepEqual([heard.status, heard.reason], ['unclear', 'unavailable']);
  assert.equal(openai.calls.transcribe.length, 0);
  assert.ok(!lines.some((l) => /skipping/.test(l)), lines.join('\n'));
  assert.equal(gemini.calls.hear.length, 2);
  broken = false;
  assert.equal((await speech.hear(clip(1000), { only: 'gemini' })).transcribedBy, 'gemini');
  assert.equal((await speech.hear(clip(1000))).transcribedBy, 'openai', 'nothing was skipped');
});

test('classify decides the intent of a transcript that is already text', async () => {
  const openai = fake('openai', { classify: async () => answer('to_claude', null, '把登录页的停止按钮改成红色') });
  const { speech } = make([openai]);
  const got = await speech.classify('嗯 把登录页的停止按钮改成红色', { currentProject: 'walkie' });
  assert.deepEqual(got, { intent: 'to_claude', project: null, text: '把登录页的停止按钮改成红色', classifiedBy: 'openai' });
  openai.classify = async () => { throw httpError('openai', 'classify', 503); };
  assert.deepEqual(await speech.classify('继续'), { intent: 'continue', project: null, text: '', classifiedBy: 'phrase' });
});

// ---- say -----------------------------------------------------------------------------------------------------

test('say hands the audio on through the loudness chain, and the reply can start before it has ended', async () => {
  const input = [tone(300, 0.1, 2000), tone(300, 0.1, 2000)];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const openai = fake('openai', { speak: async function* () { yield input[0]; await gate; yield input[1]; } });
  const { speech } = make([openai]);
  const { provider, audio } = await speech.say('好的，已经停住了。'); // resolves with the first audio in hand
  assert.equal(provider, 'openai');
  assert.equal(openai.calls.speak[0][0], '好的，已经停住了。');
  const it = audio[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.done, false);
  release();
  const rest = await drain({ [Symbol.asyncIterator]: () => it });
  assert.equal(rest.error, null);
  const all = Buffer.concat([first.value, ...rest.chunks]);
  assert.ok(all.equals(processAll(Buffer.concat(input), DEFAULT_CONFIG.loudness)));
  assert.ok(all.length % 2 === 0);
});

test('an OpenAI voice with no audio after 3 s gives way to Gemini, and only its speaking is skipped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const openai = fake('openai', { speak: async function* () { await never(); }, transcribe: async () => '继续', classify: async () => answer('continue') });
  const gemini = fake('gemini', { speak: async function* () { yield tone(300, 0.1, 2000); } });
  const { speech, lines } = make([openai, gemini]);
  const pending = speech.say('你好');
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(gemini.calls.speak.length, 0);
  t.mock.timers.tick(1);
  assert.equal((await pending).provider, 'gemini');
  assert.ok(lines.includes('speech: openai speak: no answer within 3000 ms; skipping openai speak for 5 min'), lines.join('\n'));
  assert.equal(openai.calls.speak[0][1].signal.aborted, true, 'the stalled request is cancelled');

  assert.equal((await speech.say('再来')).provider, 'gemini');
  assert.equal(openai.calls.speak.length, 1, 'skipped');
  assert.equal((await speech.hear(clip(1000))).transcribedBy, 'openai', 'but still used to transcribe');
});

test('a voice that ends without a single sample counts as failed', async () => {
  const openai = fake('openai', { speak: async function* () { yield Buffer.alloc(0); } });
  const gemini = fake('gemini', { speak: async function* () { yield tone(300, 0.1, 2000); } });
  const { speech, lines } = make([openai, gemini]);
  assert.equal((await speech.say('你好')).provider, 'gemini');
  assert.ok(lines.includes('speech: openai speak: the reply had no audio; skipping openai speak for 5 min'), lines.join('\n'));
});

test('when no voice works, say rejects as unavailable and says why, with no key in it', async () => {
  const openai = fake('openai', { speak: async function* () { throw httpError('openai', 'speak', 429); } });
  const gemini = fake('gemini', { speak: async function* () { throw new Error('boom sk-proj-abcdefghijklmnop'); } });
  const { speech } = make([openai, gemini]);
  await assert.rejects(speech.say('你好'), (err) => {
    assert.ok(err instanceof SpeechError);
    assert.deepEqual([err.kind, err.step], ['unavailable', 'speak']);
    assert.match(err.message, /openai speak: HTTP 429 overloaded; gemini speak: boom \[key\]/);
    assert.ok(!err.message.includes('sk-proj'));
    return true;
  });
  await assert.rejects(speech.say('你好'), /openai speak is being skipped after an earlier failure; gemini speak is being skipped/);
  assert.equal(openai.calls.speak.length, 1);
});

test('a voice that fails after it started ends the reply; Gemini does not repeat it', async () => {
  const cut = new SpeechError('openai speak: the audio stream broke (ECONNRESET)', { provider: 'openai', step: 'speak', kind: 'network' });
  const openai = fake('openai', { speak: async function* () { yield tone(300, 0.1, 2000); throw cut; } });
  const gemini = fake('gemini', { speak: async function* () { yield tone(300, 0.1, 2000); } });
  const { speech, lines } = make([openai, gemini]);
  const { provider, audio } = await speech.say('你好');
  assert.equal(provider, 'openai');
  const { chunks, error } = await drain(audio);
  assert.ok(chunks.length > 0, 'what arrived was delivered');
  assert.equal(error, cut);
  assert.equal(gemini.calls.speak.length, 0);
  assert.ok(lines.some((l) => /openai speak: the audio stream broke \(ECONNRESET\); skipping openai speak/.test(l)));
  assert.equal((await speech.say('再来')).provider, 'gemini', 'and the next reply uses Gemini');
});

test('a voice that goes silent for 3 s in the middle of a reply ends it with a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const openai = fake('openai', { speak: async function* () { yield tone(300, 0.1, 2000); await never(); } });
  const { speech, lines } = make([openai]);
  const { audio } = await speech.say('你好');
  const drained = drain(audio);
  await settle();
  t.mock.timers.tick(2999);
  await settle();
  assert.equal(lines.length, 0);
  t.mock.timers.tick(1);
  const { error } = await drained;
  assert.ok(error instanceof SpeechError);
  assert.deepEqual([error.kind, error.provider, error.step], ['timeout', 'openai', 'speak']);
  assert.match(error.message, /openai speak: no audio for 3000 ms/);
  assert.ok(lines.includes('speech: openai speak: no audio for 3000 ms; skipping openai speak for 5 min'), lines.join('\n'));
});

test('the caller stopping a reply that is still being waited for ends say with an AbortError and starts no skip window', async () => {
  const openai = fake('openai', { speak: async function* () { await never(); } });
  const { speech, lines } = make([openai]);
  const ac = new AbortController();
  const pending = speech.say('你好', { signal: ac.signal });
  await settle();
  ac.abort();
  await assert.rejects(pending, (err) => isAbort(err));
  assert.equal(openai.calls.speak[0][1].signal.aborted, true);
  assert.deepEqual(lines, []);
  await assert.rejects(speech.say('你好', { signal: ac.signal }), (err) => isAbort(err));
  assert.equal(openai.calls.speak.length, 1);
});

test('stopping a reply that is playing lets go of the provider at once', async () => {
  let released = false;
  const openai = fake('openai', {
    speak: async function* (text, { signal }) {
      try {
        yield tone(300, 0.1, 2000);
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      } finally {
        released = true;
      }
    },
  });
  const { speech, lines } = make([openai]);
  const ac = new AbortController();
  const { audio } = await speech.say('你好', { signal: ac.signal });
  const drained = drain(audio);
  await settle();
  ac.abort();
  const { error } = await drained;
  assert.ok(isAbort(error));
  await settle();
  assert.equal(released, true);
  assert.deepEqual(lines, []);
});

test('stopping a reply that nobody has started playing lets go of the provider as well', async () => {
  const openai = fake('openai', { speak: async function* () { yield tone(300, 0.1, 2000); yield tone(300, 0.1, 2000); } });
  const { speech } = make([openai]);
  const ac = new AbortController();
  await speech.say('你好', { signal: ac.signal });
  assert.equal(openai.calls.speak[0][1].signal.aborted, false);
  ac.abort();
  assert.equal(openai.calls.speak[0][1].signal.aborted, true);
});

test('a player that stops reading lets go of the provider too', async () => {
  let released = false;
  const openai = fake('openai', {
    speak: async function* () {
      try {
        yield tone(300, 0.1, 2000);
        yield tone(300, 0.1, 2000);
      } finally {
        released = true;
      }
    },
  });
  const { speech } = make([openai]);
  const { audio } = await speech.say('你好');
  const it = audio[Symbol.asyncIterator]();
  await it.next();
  await it.return();
  await settle();
  assert.equal(released, true);
  assert.equal(openai.calls.speak[0][1].signal.aborted, true);
});

test('say with only: uses that provider and ignores skip windows', async () => {
  const openai = fake('openai', { speak: async function* () { yield tone(300, 0.1, 2000); } });
  const gemini = fake('gemini', { speak: async function* () { throw httpError('gemini', 'speak', 503); } });
  const { speech, lines } = make([openai, gemini]);
  await assert.rejects(speech.say('你好', { only: 'gemini' }), /no provider could speak: gemini speak: HTTP 503/);
  assert.equal(openai.calls.speak.length, 0);
  assert.ok(!lines.some((l) => /skipping/.test(l)));
  await assert.rejects(speech.say('你好', { only: 'gemini' }), /HTTP 503/);
  assert.equal(gemini.calls.speak.length, 2, 'not skipped');
  assert.equal((await speech.say('你好', { only: 'openai' })).provider, 'openai');
});

test('with nothing set up, hear is 没听清 and say is unavailable', async () => {
  const { speech, lines } = make([]);
  assert.deepEqual(await speech.hear(clip(1000)), { status: 'unclear', reason: 'unavailable', transcript: '' });
  assert.ok(lines.includes('speech: no provider could transcribe this clip'));
  await assert.rejects(speech.say('你好'), /none is set up for speaking/);
  assert.equal((await speech.classify('继续')).classifiedBy, 'phrase');
});

test('say wants something to say', async () => {
  const { speech } = make([fake('openai', { speak: async function* () { yield tone(300, 0.1, 2000); } })]);
  for (const text of ['', '  ', undefined, null]) await assert.rejects(speech.say(text), TypeError);
});

// ---- the rest --------------------------------------------------------------------------------------------------

test('failureTone is a short, soft, even-length tone that starts and ends at silence', () => {
  const pcm = failureTone();
  assert.equal(pcm.length, 14400); // 0.3 s at 24 kHz
  assert.equal(pcm.length % 2, 0);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 4000 && peak <= 5000, `peak ${peak}`);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(pcm.length - 2), 0);
});

test('createAdapters builds the providers that have a key, OpenAI first, on the fetch it is given', async () => {
  const fetch = fakeFetch(() => jsonResponse({ choices: [{ message: { content: answer('stop') } }] }));
  const both = createAdapters({ keys: { OPENAI_API_KEY: 'k-openai', GEMINI_API_KEY: 'k-gemini' }, config: DEFAULT_CONFIG, fetch });
  assert.deepEqual(both.map((a) => a.name), ['openai', 'gemini']);
  await both[0].classify('x', { prompt: 'p' });
  assert.equal(fetch.calls[0].init.headers.authorization, 'Bearer k-openai');
  assert.deepEqual(createAdapters({ keys: { GEMINI_API_KEY: 'k' }, config: DEFAULT_CONFIG, fetch }).map((a) => a.name), ['gemini']);
  assert.deepEqual(createAdapters({ keys: { OPENAI_API_KEY: 'k' }, config: DEFAULT_CONFIG, fetch }).map((a) => a.name), ['openai']);
  assert.deepEqual(createAdapters({ keys: {}, config: DEFAULT_CONFIG, fetch }), []);
});
```

Create `bridge/test/speech/chain.test.js`:

```js
// The real adapters under the real chain, on a scripted fetch: what speech.test.js and the adapter tests prove
// separately, proven together, so that a name or a shape that differs between the two cannot hide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, createSpeech } from '../../src/speech/speech.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { SET_PROJECTS } from '../fixtures/utterances.js';
import { encodeWav } from '../../src/audio/wav.js';
import { tone } from '../../src/audio/tone.js';
import { processAll } from '../../src/speech/loudness.js';
import { fakeFetch, jsonResponse, streamResponse } from './fake-fetch.js';

const KEYS = { OPENAI_API_KEY: 'sk-test-0123456789abcdefghij', GEMINI_API_KEY: 'AIzaSyTestKey0123456789abcdefghij' };
const clip = Buffer.alloc((250 + 1000) * 32, 1);
const reply = (text) => jsonResponse({ candidates: [{ content: { parts: [{ text }] } }] });
const pcm = tone(300, 0.2, 2000);

// One script for all four endpoints; `broken` lists the ones that answer 503.
function script(broken = []) {
  return fakeFetch((url) => {
    const endpoint = ['audio/transcriptions', 'chat/completions', 'audio/speech', 'gemini-3.8-flash:generateContent', 'gemini-3.8-flash-tts:generateContent'].find((e) => url.endsWith(e));
    if (broken.includes(endpoint)) return jsonResponse({ error: { message: 'overloaded' } }, 503);
    switch (endpoint) {
      case 'audio/transcriptions':
        return jsonResponse({ text: '切到语音助手这个项目' });
      case 'chat/completions':
        return jsonResponse({ choices: [{ message: { content: '{"intent":"switch_project","project":"walkie","text":""}' } }] });
      case 'audio/speech':
        return streamResponse([pcm.subarray(0, 3000), pcm.subarray(3000)]);
      case 'gemini-3.8-flash:generateContent':
        return reply('{"transcript":"切到语音助手这个项目","intent":"switch_project","project":"walkie","text":""}');
      case 'gemini-3.8-flash-tts:generateContent':
        return jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: encodeWav(pcm, 24000).toString('base64') } }] } }] });
      default:
        throw new Error(`unexpected request to ${url}`);
    }
  });
}

function make(fetch) {
  const lines = [];
  const adapters = createAdapters({ keys: KEYS, config: DEFAULT_CONFIG, fetch });
  const speech = createSpeech({ adapters, config: DEFAULT_CONFIG, projects: SET_PROJECTS, log: (line) => lines.push(line) });
  return { speech, lines };
}

async function collect(audio) {
  const out = [];
  for await (const chunk of audio) out.push(chunk);
  return Buffer.concat(out);
}

test('OpenAI hears: transcription then classification, two calls', async () => {
  const fetch = script();
  const heard = await make(fetch).speech.hear(clip, { currentProject: 'on-the-beat' });
  assert.deepEqual([heard.status, heard.transcript, heard.intent, heard.project, heard.transcribedBy, heard.classifiedBy], ['ok', '切到语音助手这个项目', 'switch_project', 'walkie', 'openai', 'openai']);
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/').slice(-2).join('/')), ['audio/transcriptions', 'chat/completions']);
});

test('OpenAI down: Gemini hears and classifies in one call, and the keys stay out of the console', async () => {
  const fetch = script(['audio/transcriptions']);
  const { speech, lines } = make(fetch);
  const heard = await speech.hear(clip);
  assert.deepEqual([heard.transcribedBy, heard.classifiedBy, heard.intent, heard.project], ['gemini', 'gemini', 'switch_project', 'walkie']);
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[1].url, /gemini-3\.8-flash:generateContent$/);
  assert.ok(lines.some((l) => /openai transcribe: HTTP 503 overloaded; skipping openai transcribe for 5 min/.test(l)), lines.join('\n'));
  for (const key of Object.values(KEYS)) assert.ok(!lines.join('\n').includes(key));
});

test('OpenAI speaks: the audio arrives through the loudness chain', async () => {
  const { provider, audio } = await make(script()).speech.say('好的，已经切过去了。');
  assert.equal(provider, 'openai');
  assert.ok((await collect(audio)).equals(processAll(pcm, DEFAULT_CONFIG.loudness)));
});

test('OpenAI down: Gemini speaks, and its WAV goes through the same chain', async () => {
  const fetch = script(['audio/speech']);
  const { speech, lines } = make(fetch);
  const { provider, audio } = await speech.say('好的，已经切过去了。');
  assert.equal(provider, 'gemini');
  assert.ok((await collect(audio)).equals(processAll(pcm, DEFAULT_CONFIG.loudness)));
  assert.ok(lines.some((l) => /openai speak: HTTP 503 overloaded; skipping openai speak for 5 min/.test(l)), lines.join('\n'));
});

test('everything down: 没听清 for a clip, unavailable for a reply', async () => {
  const fetch = script(['audio/transcriptions', 'gemini-3.8-flash:generateContent', 'audio/speech', 'gemini-3.8-flash-tts:generateContent']);
  const { speech } = make(fetch);
  assert.deepEqual(await speech.hear(clip), { status: 'unclear', reason: 'unavailable', transcript: '' });
  await assert.rejects(speech.say('你好'), (err) => err.kind === 'unavailable' && /openai speak: HTTP 503/.test(err.message) && /gemini speak: HTTP 503/.test(err.message));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/speech/speech.test.js bridge/test/speech/chain.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/speech/speech.js`.

- [ ] **Step 3: Write the chain**

Create `bridge/src/speech/speech.js`:

```js
// The provider chain (spec 6.5): hear an utterance, speak a reply. Each step tries the providers in order, every try
// under a time limit. A candidate that fails is skipped for config.cooldownMs, so a bad spell costs one timeout rather
// than one per utterance, and the console is told which one failed and why. This file knows the order, the limits and
// the last resorts; how to talk to a provider is the adapters' business (openai.js, gemini.js).
import { tone } from '../audio/tone.js';
import { encodeWav } from '../audio/wav.js';
import { validateAnswer } from '../intent/intent.js';
import { fixedPhrase, isFiller } from '../intent/phrases.js';
import { classifyPrompt, hearPrompt, transcriptionPrompt } from '../intent/prompts.js';
import { DeadlineError, withDeadline } from './deadline.js';
import { SpeechError, abortError, isAbort, redact } from './errors.js';
import { createGemini } from './gemini.js';
import { applyLoudness } from './loudness.js';
import { createOpenAI } from './openai.js';

const CLIP_RATE = 16000; // what the S3 records
const CLIP_BYTES_PER_MS = (CLIP_RATE * 2) / 1000;
const REPLY_RATE = 24000; // what the S3 plays

// The providers that have a key, in the order they are tried: OpenAI first, Gemini as the fallback.
export function createAdapters({ keys, config, fetch }) {
  const adapters = [];
  if (keys.OPENAI_API_KEY) adapters.push(createOpenAI({ key: keys.OPENAI_API_KEY, config, fetch }));
  if (keys.GEMINI_API_KEY) adapters.push(createGemini({ key: keys.GEMINI_API_KEY, config, fetch }));
  return adapters;
}

// A short, soft tone for a reply that can only be shown as text (spec 6.5), 24 kHz PCM16 for Link.playAudio.
export function failureTone() {
  const pcm = tone(330, 0.3, 5000);
  const fade = 240; // 10 ms at each end, so it does not click
  const samples = pcm.length / 2;
  for (let i = 0; i < fade; i++) {
    const gain = i / fade;
    for (const at of [i, samples - 1 - i]) pcm.writeInt16LE(Math.round(pcm.readInt16LE(at * 2) * gain), at * 2);
  }
  return pcm;
}

const span = (ms) => (ms >= 60_000 ? `${+(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

// Why a candidate failed, in one line for the console.
function describe(err, label, stalled = 'no answer within') {
  if (err instanceof DeadlineError) return `${label}: ${stalled} ${err.ms} ms`;
  const text = err instanceof SpeechError ? err.message : `${label}: ${err?.message ?? err}`;
  return redact(err?.status === 401 || err?.status === 403 ? `${text} (check the API key)` : text);
}

// The next chunk of a reply that has something in it, or {done: true}.
async function nextAudio(it) {
  for (;;) {
    const r = await it.next();
    if (r.done || r.value.length > 0) return r;
  }
}

// adapters: from createAdapters (or fakes in tests). log(line) is told which candidate failed and why, and what is
// being skipped; now() is the clock the skip windows run on.
export function createSpeech({ adapters, config, projects, log = () => {}, now = () => Date.now() }) {
  const skipUntil = new Map(); // candidate key -> time it is tried again

  // `only` names one provider to use and nothing else: the dev commands use it to test a provider on purpose, so it
  // ignores the skip windows and does not start any.
  const usable = (adapter, key, only) => (only ? adapter.name === only : (skipUntil.get(key) ?? 0) <= now());

  function fail(key, label, reason, only) {
    if (only) {
      log(`speech: ${reason}`);
      return;
    }
    skipUntil.set(key, now() + config.cooldownMs);
    log(`speech: ${reason}; skipping ${label} for ${span(config.cooldownMs)}`);
  }

  // One try of one candidate under its time limit: {value} or {reason}. The caller giving up is thrown on, because
  // nothing failed.
  async function attempt(key, label, ms, { signal, only }, run) {
    try {
      return { value: await withDeadline(ms, signal, run) };
    } catch (err) {
      if (isAbort(err)) throw err;
      const reason = describe(err, label);
      fail(key, label, reason, only);
      return { reason };
    }
  }

  // The words of the clip from the first provider that can give them: {transcript, by, answer?} or null. A provider
  // that hears the audio itself (Gemini) brings its classification along as `answer`.
  async function transcribe(wav, clipMs, ask) {
    const { only, classify, currentProject, busy } = ask;
    for (const a of adapters) {
      if (a.transcribe) {
        const key = `${a.name}:transcribe`;
        if (!usable(a, key, only)) continue;
        const ms = Math.round(a.limits.transcribeBaseMs + config.transcribeClipFraction * clipMs);
        const r = await attempt(key, `${a.name} transcribe`, ms, ask, (signal) => a.transcribe(wav, { prompt: transcriptionPrompt(projects), signal }));
        if ('value' in r) return { transcript: String(r.value ?? '').trim(), by: a.name };
      } else if (a.hear) {
        for (const model of a.hearModels) {
          const key = `${a.name}:hear:${model}`;
          if (!usable(a, key, only)) continue;
          const prompt = hearPrompt({ projects, currentProject, busy, classify });
          const r = await attempt(key, `${a.name} hear (${model})`, a.limits.hearMs, ask, (signal) => a.hear(wav, { prompt, classify, model, signal }));
          if ('value' in r) return { transcript: String(r.value.transcript ?? '').trim(), by: a.name, answer: r.value };
        }
      }
    }
    return null;
  }

  // What an utterance asks for: the model's answer when it can be trusted, else a fixed phrase, else work for Claude.
  async function classifyText(transcript, { currentProject, busy, only, signal, answer = null, by = null }) {
    let verdict = null;
    let classifiedBy = by;
    if (answer) {
      verdict = validateAnswer(answer, { projects, transcript });
      if (!verdict) log(`speech: ${by} gave an intent that cannot be used`);
    } else {
      for (const a of adapters) {
        if (!a.classify) continue;
        const key = `${a.name}:classify`;
        if (!usable(a, key, only)) continue;
        const prompt = classifyPrompt({ projects, currentProject, busy });
        const r = await attempt(key, `${a.name} classify`, a.limits.classifyMs, { signal, only }, (s) => a.classify(transcript, { prompt, signal: s }));
        if (!('value' in r)) continue;
        verdict = validateAnswer(r.value, { projects, transcript });
        if (verdict) {
          classifiedBy = a.name;
          break;
        }
        log(`speech: ${a.name} classify gave an answer that cannot be used`); // the model's fault, not the provider's: no skip window
      }
    }
    if (verdict) return { ...verdict, classifiedBy };
    const phrase = fixedPhrase(transcript, projects);
    if (phrase) return { ...phrase, classifiedBy: 'phrase' };
    return { intent: 'to_claude', project: null, text: transcript, classifiedBy: 'default' };
  }

  // Asks one provider to speak and waits for its first audio: {audio}, an async iterable of PCM16 chunks, or {reason}.
  async function open(a, key, text, { signal, only }) {
    const label = `${a.name} speak`;
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal?.addEventListener('abort', stop, { once: true }); // the caller's stop reaches the request
    const it = a.speak(text, { signal: ac.signal })[Symbol.asyncIterator]();
    const release = () => {
      signal?.removeEventListener('abort', stop);
      ac.abort();
      Promise.resolve(it.return?.()).catch(() => {}); // lets an adapter close its download
    };
    let first;
    try {
      first = await attempt(key, label, a.limits.speakFirstByteMs, { signal, only }, () => nextAudio(it));
    } catch (err) {
      release();
      throw err;
    }
    if (!('value' in first) || first.value.done) {
      let reason = first.reason;
      if ('value' in first) {
        reason = `${label}: the reply had no audio`;
        fail(key, label, reason, only);
      }
      release();
      return { reason };
    }
    async function* chunks() {
      try {
        yield first.value.value;
        for (;;) {
          const r = await withDeadline(a.limits.speakIdleMs, signal, () => nextAudio(it));
          if (r.done) return;
          yield r.value;
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        // Too late for a second voice: the reply ends here, and the provider is skipped from the next one on.
        const reason = describe(err, label, 'no audio for');
        fail(key, label, reason, only);
        throw err instanceof SpeechError
          ? err
          : new SpeechError(reason, { provider: a.name, step: 'speak', kind: err instanceof DeadlineError ? 'timeout' : 'network', cause: err });
      } finally {
        release();
      }
    }
    return { audio: chunks() };
  }

  return {
    // `pcm` is what the S3 recorded: 16 kHz mono PCM16, the start-up transient still in front. Resolves with
    //   {status: 'ok', transcript, intent, project, text, transcribedBy, classifiedBy, ms: {transcribe, classify}}
    // or, when there is nothing to act on,
    //   {status: 'unclear', reason: 'too-short' | 'empty' | 'unavailable', transcript: ''}
    // which is 「没听清，再说一次」 on the device and nothing sent to Claude. With `classify: false` (a reason spoken while
    // an approval waits) the intent is null and `text` is the transcript. `busy` and `currentProject` go into the
    // classifier's prompt. The caller aborting `signal` rejects with an AbortError and starts no skip window.
    async hear(pcm, { currentProject = null, busy = false, classify = true, only = null, signal } = {}) {
      if (signal?.aborted) throw abortError();
      const even = pcm.subarray(0, pcm.length - (pcm.length % 2));
      const clip = even.subarray(Math.min(even.length, config.trimStartMs * CLIP_BYTES_PER_MS));
      const clipMs = Math.floor(clip.length / CLIP_BYTES_PER_MS);
      if (clipMs < config.minSpeechMs) return { status: 'unclear', reason: 'too-short', transcript: '' };
      const started = now();
      const heard = await transcribe(encodeWav(clip, CLIP_RATE), clipMs, { currentProject, busy, classify, only, signal });
      if (!heard) {
        log('speech: no provider could transcribe this clip');
        return { status: 'unclear', reason: 'unavailable', transcript: '' };
      }
      if (!heard.transcript || isFiller(heard.transcript)) return { status: 'unclear', reason: 'empty', transcript: '' };
      const transcribed = now();
      const base = { status: 'ok', transcript: heard.transcript, transcribedBy: heard.by };
      if (!classify) return { ...base, intent: null, project: null, text: heard.transcript, classifiedBy: null, ms: { transcribe: transcribed - started, classify: null } };
      const verdict = await classifyText(heard.transcript, { currentProject, busy, only, signal, answer: heard.answer, by: heard.by });
      return { ...base, ...verdict, ms: { transcribe: transcribed - started, classify: now() - transcribed } };
    },

    // The intent of a transcript that is already text: {intent, project, text, classifiedBy}.
    async classify(transcript, { currentProject = null, busy = false, only = null, signal } = {}) {
      if (signal?.aborted) throw abortError();
      return classifyText(transcript, { currentProject, busy, only, signal });
    },

    // Starts speaking `text`. Resolves as soon as a provider has produced its first audio, with
    //   {provider, audio}
    // where `audio` is the reply as 24 kHz PCM16 chunks through the loudness chain, ready for Link.playStream. Play
    // it to the end, or abort `signal`: either lets go of the request. A provider that fails before its first audio is
    // skipped and the next is tried; one that fails after it ends the reply with an error, because a second voice
    // in the middle of a sentence is worse than a short reply. Rejects with kind 'unavailable' when nobody can speak:
    // show the text, and play failureTone().
    async say(text, { only = null, signal } = {}) {
      if (!String(text ?? '').trim()) throw new TypeError('say needs some text to speak');
      if (signal?.aborted) throw abortError();
      const reasons = [];
      for (const a of adapters) {
        if (!a.speak) continue;
        const key = `${a.name}:speak`;
        if (!usable(a, key, only)) {
          if (!only) reasons.push(`${a.name} speak is being skipped after an earlier failure`);
          continue;
        }
        const opened = await open(a, key, text, { signal, only });
        if (opened.audio) return { provider: a.name, audio: applyLoudness(opened.audio, config.loudness, REPLY_RATE) };
        reasons.push(opened.reason);
      }
      throw new SpeechError(`no provider could speak: ${reasons.join('; ') || 'none is set up for speaking'}`, { kind: 'unavailable', step: 'speak' });
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/speech/speech.test.js bridge/test/speech/chain.test.js`
Expected: PASS, 40 tests.

Run: `npm --prefix bridge test`
Expected: PASS, 215 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/speech/speech.js bridge/test/speech/speech.test.js bridge/test/speech/chain.test.js
git commit -m "Bridge: the provider chain with limits, skip windows and last resorts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Developer commands: `hear`, `say`, `classify`

**Files:**
- Create: `bridge/src/dev/speech-setup.js`
- Create: `bridge/src/dev/hear.js`
- Create: `bridge/src/dev/say.js`
- Create: `bridge/src/dev/classify.js`
- Modify: `bridge/bin/walkie-dev.js` (three single-line edits)
- Modify: `README.md` (three single-line edits)
- Test: `bridge/test/dev/hear.test.js`
- Test: `bridge/test/dev/say.test.js`
- Test: `bridge/test/dev/classify.test.js`

**Interfaces:**
- Consumes: `loadConfig` (Task 3), `loadKeys` and `describeKeys` (Task 3), `loadProjects` (Task 3), `createAdapters` and `createSpeech` (Task 9), `decodeWav`, `encodeWav` and `levels` (Task 8 and plan 1), `Link.playStream` through `connect` (Task 5 and plan 1), `UTTERANCES` (Task 4).
- Produces:
  - `speechFromFiles(opts): {speech, only, config}` in `speech-setup.js`: loads the keys (printing `[keys] OPENAI_API_KEY set, GEMINI_API_KEY set`, never a value), the config and the projects, builds the chain with the console as its log, and turns `--provider auto|openai|gemini` into `only` (`null` for auto). A provider without a key is an error. Also `PROVIDERS`, `seconds(ms)` and `abortOnSigint()`, whose `AbortSignal` is aborted by Ctrl+C, the way the side key will stop a reply.
  - `walkie-dev hear <wav> [--provider auto|openai|gemini]`: runs a recorded take through `speech.hear`, as the bridge will when the talk key is released, without the S3. The WAV must be 16 kHz mono PCM16, like the takes `listen` saves (start-up transient included: the chain trims it). It prints the transcript and who heard it, the intent and who decided it and, for work, what would be sent to Claude; or why the take would be 「没听清」. `formatHeard(heard): string[]` is the printing.
  - `walkie-dev say <text...> [--out file.wav] [--provider auto|openai|gemini] [--port COMx]`: speaks the text through `speech.say` and plays it on the S3 with `Link.playStream` (connecting first, so that playing starts the moment audio does), or, with `--out`, saves the loudness-processed reply as a 24 kHz WAV without touching the port. It prints which provider answered and after how long, what the S3 reported (bytes, underruns, ring peak) and a level line; Ctrl+C stops the reply. `formatLevels({durationMs, peak, rms, clippedPct}): string` is the level line.
  - `walkie-dev classify <text...> | classify --all [--provider auto|openai|gemini]`: the intent of a sentence, or of the 20 sentences of the classification set with a verdict line for each and `correct N/20` at the end (exit code 1 when any is wrong). `isCorrect(expected, got)` and `formatVerdict(expected, got)` are the scoring and the printing.

All three commands call the real APIs, so nothing here runs them. The tests pin only the printed formats; Tasks 11 and 12 run the commands for real.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/dev/hear.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeard } from '../../src/dev/hear.js';

const ok = { status: 'ok', transcribedBy: 'openai', classifiedBy: 'openai', project: null, text: '', ms: { transcribe: 1234, classify: 567 } };

test('a command shows the words, who heard them, the intent and who decided it', () => {
  const heard = { ...ok, transcript: '换到 on the beat 那个项目。', intent: 'switch_project', project: 'on-the-beat' };
  assert.deepEqual(formatHeard(heard), ['transcript: 「换到 on the beat 那个项目。」 (openai, 1.2 s)', 'intent: switch_project -> on-the-beat (openai, 0.6 s)']);
});

test('work for Claude also shows what would be sent', () => {
  const heard = { ...ok, transcript: '嗯 帮我跑一下 npm test', intent: 'to_claude', text: '帮我跑一下 npm test', transcribedBy: 'gemini', classifiedBy: 'default' };
  assert.deepEqual(formatHeard(heard), ['transcript: 「嗯 帮我跑一下 npm test」 (gemini, 1.2 s)', 'intent: to_claude (default, 0.6 s)', 'to Claude: 「帮我跑一下 npm test」']);
});

test('an approval reason is transcribed and never classified', () => {
  const heard = { ...ok, transcript: '因为接口要向后兼容', intent: null, classifiedBy: null, ms: { transcribe: 900, classify: null } };
  assert.deepEqual(formatHeard(heard), ['transcript: 「因为接口要向后兼容」 (openai, 0.9 s)', 'not classified']);
});

test('a clip that goes nowhere says why, and what the device would do', () => {
  for (const [reason, why] of [['too-short', 'the clip is too short'], ['empty', 'nothing was transcribed'], ['unavailable', 'no provider could transcribe it']]) {
    assert.deepEqual(formatHeard({ status: 'unclear', reason, transcript: '' }), [`unclear: ${why}. The device would say 「没听清，再说一次」 and send nothing.`]);
  }
});
```

Create `bridge/test/dev/classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVerdict, isCorrect } from '../../src/dev/classify.js';

test('a verdict is right when the intent is, and the project too when one is expected', () => {
  assert.equal(isCorrect({ intent: 'stop' }, { intent: 'stop', project: null }), true);
  assert.equal(isCorrect({ intent: 'stop' }, { intent: 'to_claude', project: null }), false);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: 'walkie' }), true);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: 'on-the-beat' }), false);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: null }), false);
});

test('a verdict line says how it was decided, and what was expected when it was wrong', () => {
  const right = formatVerdict({ say: '停', intent: 'stop' }, { intent: 'stop', project: null, classifiedBy: 'openai' });
  assert.equal(right, 'ok   停  ->  stop (openai)');
  const wrong = formatVerdict({ say: '切到语音助手这个项目', intent: 'switch_project', project: 'walkie' }, { intent: 'to_claude', project: null, classifiedBy: 'default' });
  assert.equal(wrong, 'BAD  切到语音助手这个项目  ->  to_claude (default), expected switch_project walkie');
});
```

Create `bridge/test/dev/say.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLevels } from '../../src/dev/say.js';

test('the level line shows the peak as a share of full scale', () => {
  assert.equal(
    formatLevels({ durationMs: 6500, peak: 32113, rms: 7526, clippedPct: 0 }),
    'level: 6.5 s, peak 32113 (98% of full scale), rms 7526, 0.0% of samples at the limit',
  );
  assert.equal(formatLevels({ durationMs: 500, peak: 32767, rms: 20000, clippedPct: 12.34 }), 'level: 0.5 s, peak 32767 (100% of full scale), rms 20000, 12.3% of samples at the limit');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/dev/hear.test.js bridge/test/dev/classify.test.js bridge/test/dev/say.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/dev/hear.js`, `src/dev/classify.js` and `src/dev/say.js`.

- [ ] **Step 3: Write the four modules**

`say.js` loads `connect.js` only when it is going to use the S3, so that `--out` and the tests never need `serialport`.

Create `bridge/src/dev/speech-setup.js`:

```js
// Shared by the speech dev commands: the keys, the settings and the provider chain, with the console as its log.
import { loadConfig } from '../config/config.js';
import { describeKeys, loadKeys } from '../config/keys.js';
import { loadProjects } from '../config/projects.js';
import { createAdapters, createSpeech } from '../speech/speech.js';

export const PROVIDERS = ['auto', 'openai', 'gemini'];

// `--provider openai|gemini` tests one provider on purpose: it is used alone, whatever was skipped before.
export function speechFromFiles(opts) {
  const provider = opts.provider ?? 'auto';
  if (!PROVIDERS.includes(provider)) throw new Error(`--provider is one of ${PROVIDERS.join(', ')}`);
  const keys = loadKeys();
  console.log(`[keys] ${describeKeys(keys)}`);
  const config = loadConfig();
  const adapters = createAdapters({ keys, config });
  if (provider !== 'auto' && !adapters.some((a) => a.name === provider)) throw new Error(`--provider ${provider}: its API key is not set`);
  const speech = createSpeech({ adapters, config, projects: loadProjects(), log: (line) => console.log(line) });
  return { speech, only: provider === 'auto' ? null : provider, config };
}

export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Ctrl+C aborts what is running, the way the bridge will stop a reply.
export function abortOnSigint() {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  return ac.signal;
}
```

Create `bridge/src/dev/hear.js`:

```js
// Runs a recorded take through the provider chain, as the bridge will when the talk key is released, without the S3:
//   hear <wav> [--provider auto|openai|gemini]
// The WAV is 16 kHz mono PCM16, like the takes `listen` saves (start-up transient included: the bridge trims it).
import { readFileSync } from 'node:fs';
import { decodeWav } from '../audio/wav.js';
import { abortOnSigint, seconds, speechFromFiles } from './speech-setup.js';

const WHY_UNCLEAR = {
  'too-short': 'the clip is too short',
  empty: 'nothing was transcribed',
  unavailable: 'no provider could transcribe it',
};

export function formatHeard(heard) {
  if (heard.status !== 'ok') return [`unclear: ${WHY_UNCLEAR[heard.reason] ?? heard.reason}. The device would say 「没听清，再说一次」 and send nothing.`];
  const lines = [`transcript: 「${heard.transcript}」 (${heard.transcribedBy}, ${seconds(heard.ms.transcribe)})`];
  if (heard.intent === null) return [...lines, 'not classified'];
  lines.push(`intent: ${heard.intent}${heard.project ? ` -> ${heard.project}` : ''} (${heard.classifiedBy}, ${seconds(heard.ms.classify)})`);
  if (heard.intent === 'to_claude') lines.push(`to Claude: 「${heard.text}」`);
  return lines;
}

export default async function hear([file], opts) {
  if (!file) throw new Error('hear <wav> [--provider auto|openai|gemini]');
  const { rate, pcm } = decodeWav(readFileSync(file));
  if (rate !== 16000) throw new Error(`${file} is ${rate} Hz, the S3 records 16000 Hz (ffmpeg -i in.wav -ac 1 -ar 16000 out.wav)`);
  const { speech, only } = speechFromFiles(opts);
  console.log(`${file}: ${seconds((pcm.length / 2 / rate) * 1000)}`);
  for (const line of formatHeard(await speech.hear(pcm, { only, signal: abortOnSigint() }))) console.log(line);
}
```

Create `bridge/src/dev/classify.js`:

```js
// The intent of a transcript, from the model:
//   classify <text...> [--provider auto|openai|gemini]
//   classify --all                      the 20 sample utterances, scored (Stage 0 got the first ten 10 of 10)
import { UTTERANCES } from '../../test/fixtures/utterances.js';
import { abortOnSigint, speechFromFiles } from './speech-setup.js';

// Right when the intent is, and the project too when one is expected.
export const isCorrect = (expected, got) => got.intent === expected.intent && (expected.project === undefined || got.project === expected.project);

const named = (x) => `${x.intent}${x.project ? ` ${x.project}` : ''}`;

export function formatVerdict(expected, got) {
  const ok = isCorrect(expected, got);
  return `${ok ? 'ok ' : 'BAD'}  ${expected.say}  ->  ${named(got)} (${got.classifiedBy})${ok ? '' : `, expected ${named(expected)}`}`;
}

export default async function classify(args, opts) {
  const all = args.includes('--all');
  const text = args.filter((a) => a !== '--all').join(' ').trim();
  if (!all && !text) throw new Error('classify <text...> | classify --all  [--provider auto|openai|gemini]');
  const { speech, only } = speechFromFiles(opts);
  const signal = abortOnSigint();
  if (!all) {
    const got = await speech.classify(text, { only, signal });
    console.log(`intent: ${named(got)} (${got.classifiedBy})`);
    if (got.intent === 'to_claude') console.log(`to Claude: 「${got.text}」`);
    return;
  }
  let right = 0;
  for (const u of UTTERANCES) {
    const got = await speech.classify(u.say, { only, signal });
    if (isCorrect(u, got)) right++;
    console.log(formatVerdict(u, got));
  }
  console.log(`correct ${right}/${UTTERANCES.length}`);
  if (right < UTTERANCES.length) process.exitCode = 1;
}
```

Create `bridge/src/dev/say.js`:

```js
// Speaks a line through the provider chain and either plays it on the S3 or saves it as a WAV:
//   say <text...> [--out file.wav] [--provider auto|openai|gemini] [--port COMx]
// Ctrl+C stops it the way the front key will stop a reply. The level line shows what the loudness chain made of it.
import { writeFileSync } from 'node:fs';
import { encodeWav, levels } from '../audio/wav.js';
import { abortOnSigint, seconds, speechFromFiles } from './speech-setup.js';

export function formatLevels({ durationMs, peak, rms, clippedPct }) {
  return `level: ${seconds(durationMs)}, peak ${peak} (${((peak / 32768) * 100).toFixed(0)}% of full scale), rms ${rms}, ${clippedPct.toFixed(1)}% of samples at the limit`;
}

export default async function say(args, opts) {
  const text = args.join(' ').trim();
  if (!text) throw new Error('say <text...> [--out file.wav] [--provider auto|openai|gemini]');
  const { speech, only } = speechFromFiles(opts);
  const signal = abortOnSigint();
  const link = opts.out ? null : await (await import('./connect.js')).connect(opts); // connected first, so that playing starts the moment audio does
  const started = Date.now();
  const { provider, audio } = await speech.say(text, { only, signal });
  console.log(`first audio from ${provider} after ${seconds(Date.now() - started)}`);
  const kept = [];
  async function* tee() {
    for await (const chunk of audio) {
      kept.push(chunk);
      yield chunk;
    }
  }
  if (link) {
    const played = await link.playStream(tee(), { signal });
    console.log(`${played.reason === 0 ? 'played' : 'stopped'}: ${played.bytes} bytes, ${played.underruns} underruns, ring peak ${played.maxFill} bytes`);
    link.close();
  } else {
    for await (const chunk of audio) kept.push(chunk);
  }
  const pcm = Buffer.concat(kept);
  console.log(formatLevels(levels(pcm, 24000)));
  if (opts.out) {
    writeFileSync(opts.out, encodeWav(pcm, 24000));
    console.log(`saved ${opts.out}`);
  }
}
```

- [ ] **Step 4: Register the commands in `bridge/bin/walkie-dev.js`**

Three edits: the usage text, the command table and the list of flags that take a value.

In `bridge/bin/walkie-dev.js`, replace

```js
  play <file> | play tone <hz> <secs>  play audio on the S3; Ctrl+C stops it`;
```

with

```js
  play <file> | play tone <hz> <secs>  play audio on the S3; Ctrl+C stops it
  hear <wav> [--provider auto|openai|gemini]        run a recorded take through the speech chain (calls the APIs)
  say <text...> [--out file.wav] [--provider ...]    speak through the chain: play on the S3, or save a WAV (calls the APIs)
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)`;
```

In `bridge/bin/walkie-dev.js`, replace

```js
  play: () => import('../src/dev/play.js'),
```

with

```js
  play: () => import('../src/dev/play.js'),
  hear: () => import('../src/dev/hear.js'),
  say: () => import('../src/dev/say.js'),
  classify: () => import('../src/dev/classify.js'),
```

In `bridge/bin/walkie-dev.js`, replace

```js
for (const flag of ['--port', '--secs', '--out']) {
```

with

```js
for (const flag of ['--port', '--secs', '--out', '--provider']) {
```

- [ ] **Step 5: Run the new tests and the whole bridge suite**

Run: `node --test bridge/test/dev/hear.test.js bridge/test/dev/classify.test.js bridge/test/dev/say.test.js`
Expected: PASS, 7 tests.

Run: `npm --prefix bridge test`
Expected: PASS, 222 tests.

- [ ] **Step 6: Look at the commands without calling anything**

Run: `node bridge/bin/walkie-dev.js`
Expected: the usage text, now ending with the `hear`, `say` and `classify` lines.

Run: `node bridge/bin/walkie-dev.js hear`, then `node bridge/bin/walkie-dev.js say`, then `node bridge/bin/walkie-dev.js classify`
Expected: each prints its own usage line (`hear <wav> [--provider auto|openai|gemini]`, `say <text...> [--out file.wav] [--provider auto|openai|gemini]`, `classify <text...> | classify --all  [--provider auto|openai|gemini]`) and exits with code 1. A command without its argument fails before it loads any key, so nothing is read or sent.

- [ ] **Step 7: Update the README**

Three edits: the layout row, the prerequisites and the list of commands.

In `README.md`, replace

```markdown
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `bin/walkie-dev.js` and `src/dev` are developer commands |
```

with

```markdown
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `src/speech` talks to OpenAI and Gemini; `src/intent` and `src/config` decide what was said and read the settings; `bin/walkie-dev.js` and `src/dev` are developer commands |
```

In `README.md`, replace

```markdown
- ffmpeg on PATH, for `walkie-dev play <file>`.
```

with

```markdown
- ffmpeg on PATH, for `walkie-dev play <file>`.
- API keys for the speech commands: `OPENAI_API_KEY` and `GEMINI_API_KEY`, one `NAME=value` per line in `%APPDATA%\walkie\keys.env` (outside the repo), or environment variables of the same names, which win. The bridge never prints a key.
```

In `README.md`, replace

```markdown
developer commands: ping, cmd, term, listen, loopback, play.
```

with

```markdown
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify. `hear`, `say` and `classify` send text or recordings to OpenAI (and to Gemini when OpenAI fails), so they need the keys above and cost a little each time.
```

- [ ] **Step 8: Commit**

```bash
git add bridge/src/dev bridge/test/dev bridge/bin/walkie-dev.js README.md
git commit -m "Bridge: hear, say and classify developer commands" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Live: the classifier and the recorded takes (gated)

The first real use of the adapters. It settles the first item of spec §10 (recognition of his own voice at wrist distance, after the gain change and the start-up trim), checks Review Focus 1 against the real transcriber, and shows how the Gemini fallback does today.

**Files:**
- Create: `bridge/takes/make-silence.mjs` and, by running it, `bridge/takes/silence.wav`. `bridge/takes/` is gitignored: neither file is ever committed.
- Nothing else changes. The results are written into the spec in Task 12.

**Interfaces:**
- Consumes: `walkie-dev classify` and `walkie-dev hear` (Task 10); the twelve `take-*.wav` files that `walkie-dev listen` saved in `bridge/takes/` during plan 1 (16 kHz mono PCM16).
- Produces: numbers for Task 12: `correct N/20`, how many of the twelve takes were transcribed as he said them and which were not, what the noise clip came back as, and how Gemini did on one take.

Each of the three gates below is asked separately, with the AskUserQuestion tool, and only a clear yes for that gate counts (Global Constraints). If he says no to one, skip its steps, say so in Task 12's spec text, and go on.

- [ ] **Step 1: Ask gate A: the classification set**

What leaves the PC: the 20 fixed sentences of `bridge/test/fixtures/utterances.js` (text only; none is his recording), each sent once to OpenAI `gpt-6-luna`, with his `OPENAI_API_KEY`. It costs a fraction of a cent. Suggested question: 「把 20 句固定的测试句子（纯文字，不含你的录音）发给 OpenAI 的 gpt-6-luna 分类，可以吗？」

- [ ] **Step 2: Run the classification set**

Run: `node bridge/bin/walkie-dev.js classify --all`
Expected: `[keys] OPENAI_API_KEY set, GEMINI_API_KEY set`, then 20 lines such as `ok   等一下，先停住。  ->  stop (openai)`, then `correct 20/20`. A wrong verdict prints `BAD` with what was expected, and the command exits with code 1.

Stage 0 got 10 of 10 on the first ten sentences with the same model and effort, so 20 of 20 is the expectation. If one or two sentences are wrong, show him the `BAD` lines and stop there. Do not edit `bridge/src/intent/prompts.js` to fit a single sentence: a prompt change needs a test in `prompts.test.js` and a fresh run of this step, and it is his call.

- [ ] **Step 3: Generate the noise clip**

This checks Review Focus 1 on the real transcriber. A front key held with nothing said records room noise, and models are known to invent words for noise; digital silence would not show that. The clip is three seconds of faint noise (RMS near 87, which is what a quiet room gives) and it is not his voice.

```js
// Writes bridge/takes/silence.wav: 3 s of faint room noise at 16 kHz, what a front key held with nothing said records
// (a microphone never hears digital zero). It is not his voice, and bridge/takes/ is gitignored.
import { writeFileSync } from 'node:fs';
import { encodeWav } from '../src/audio/wav.js';

const SECONDS = 3;
const pcm = Buffer.alloc(16000 * 2 * SECONDS);
let seed = 12345;
for (let i = 0; i < pcm.length; i += 2) {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  pcm.writeInt16LE(((seed >>> 16) % 301) - 150, i); // about +-150, RMS near 87: a quiet room
}
writeFileSync(new URL('./silence.wav', import.meta.url), encodeWav(pcm, 16000));
console.log(`wrote silence.wav: ${SECONDS} s, 16 kHz`);
```

Write that to `bridge/takes/make-silence.mjs`, then run: `node bridge/takes/make-silence.mjs`
Expected: `wrote silence.wav: 3 s, 16 kHz`.

- [ ] **Step 4: Ask gate B: his recordings**

List the takes first: `Get-ChildItem bridge\takes\take-*.wav | Sort-Object Name | Select-Object Name, Length`. There are twelve (plan 1 saved them on 29 and 30 Sep); if there are not, say the real number in the question. A take is about 32 KB per second.

What leaves the PC: those recordings of his voice, about `<total> s` in all, sent once each to OpenAI `gpt-transcribe`, and the resulting sentences to `gpt-6-luna`; plus the generated noise clip. `--provider openai` keeps them off Google. Cost: about 0.45 US cents per minute of audio, under one cent in all. Suggested question: 「把 bridge/takes 里你录的 12 段声音（共约 N 秒）各发给 OpenAI 转写一次，再加 1 段程序生成的噪声（不是你的声音）。只发给 OpenAI，不发给 Google。可以吗？」

- [ ] **Step 5: Hear the takes and the noise clip**

Run: `Get-ChildItem bridge\takes\take-*.wav | Sort-Object Name | ForEach-Object { node bridge/bin/walkie-dev.js hear $_.FullName --provider openai }`
Expected, for each take: the `[keys]` line, `<path>: 5.3 s`, `transcript: 「帮我跑一下 npm test，然后 commit。」 (openai, 1.6 s)`, `intent: to_claude (openai, 1.2 s)` and, for work, `to Claude: 「…」` (the sentences and times here are examples). A transcription slower than the limit (3 s plus 10% of the clip) prints the provider's failure instead, and the take comes out as `unclear: no provider could transcribe it`.

Run: `node bridge/bin/walkie-dev.js hear bridge/takes/silence.wav --provider openai`
Expected, the good outcome: `unclear: nothing was transcribed. The device would say 「没听清，再说一次」 and send nothing.` If the noise comes back as words (a phantom transcript, often a stock phrase), do not add a gate in this plan. One sample cannot say whether the right gate is an energy floor or a list of phrases; report the exact transcript to him, and record it in Task 12.

- [ ] **Step 6: Show him the results and have him judge**

Put the twelve results in one table in chat (take name, duration, transcript, intent) and ask, with the AskUserQuestion tool, two questions in one call. First: is every transcript what he said? Second: were the takes recorded holding the S3 at wrist distance, the way he will use it (all of them, some, or not sure)? He alone knows both: do not judge for him. Note which takes he says are wrong, by name. The takes span plan 1's gain experiments (29 and 30 Sep); the `listen-*.log` files next to them say which take was recorded at which gain. Do not guess a take's gain.

- [ ] **Step 7: Ask gate C: one take to Gemini**

This is the only step in which his voice goes to Google. What leaves the PC: the shortest take (`Get-ChildItem bridge\takes\take-*.wav | Sort-Object Length | Select-Object -First 1`), sent once to Gemini `gemini-3.8-flash` and, if that fails, to `gemini-3.1-flash-lite`, with his `GEMINI_API_KEY`. Google's documentation says paid-tier content is not used for its product training (spec §3); whether his key is on the paid tier is his to say. Suggested question: 「把最短的那一段你的录音发给 Google 的 Gemini 听一次，看备用通道现在能不能用，可以吗？」

- [ ] **Step 8: Hear one take with Gemini**

Run: `node bridge/bin/walkie-dev.js hear <the shortest take> --provider gemini`
Expected: `transcript: 「…」 (gemini, 7.0 s)` and `intent: … (gemini, 0.0 s)`, where the intent comes from the same call. Each hearing model that fails first leaves one console line, `speech: gemini hear: HTTP 503 …` (a timeout reads `speech: gemini hear (gemini-3.8-flash): no answer within 8000 ms`). The line for a failed reply does not name the model, and neither does the `transcript:` line, so work out who answered: no failure line means `gemini-3.8-flash` heard it, one failure line means `gemini-3.1-flash-lite` did. If both fail, the take comes out as `unclear: no provider could transcribe it`: record that, because it is the honest state of the fallback today.

Keep these for Task 12: `correct N/20`; N of 12 takes right, with the wrong ones by name and what came back for each; whether the takes were at wrist distance, in his words; the noise clip's result; Gemini's transcript, model and time. There is no commit in this task.

---

### Task 12: Live: marin's loudness, the S3, and the spec (gated)

The last task: the voice through the loudness chain, first as a file and then on the S3, and then the spec records what this plan measured. Everything here is a live check (Global Constraints: each one is asked first, with AskUserQuestion, and only a clear yes counts).

**Files:**
- Modify (only if the calibration moves): `bridge/config.json` and `bridge/src/speech/loudness.js`, the same `makeupDb` in both.
- Modify: `docs/superpowers/specs/2026-09-29-walkie-design.md` (§6.5 and the first three items of §10).
- Create, never committed: `bridge/takes/marin.wav` (gitignored).

**Interfaces:**
- Consumes: `walkie-dev say`, `ping` and `play` (Task 10 and plan 1); the numbers kept from Tasks 1 and 11.
- Produces: the calibrated `makeupDb`, the S3 results and his verdict on the sound, and a spec that says what is now known.

**Where the gain lives.** `bridge/config.json` holds `loudness.makeupDb` for him to edit. `DEFAULT_LOUDNESS` in `bridge/src/speech/loudness.js` holds the same number as the code's default, and `DEFAULT_CONFIG` copies it from there. No test compares the two values (`config.test.js` compares only the shape of the two files), so a change is made in both files or the code and the file disagree silently.

- [ ] **Step 1: Ask gate D: one spoken sentence, saved as a file**

What leaves the PC: one fixed sentence (`好的，已经切到语音助手这个项目了。接下来要我做什么？`, about 25 characters, nothing of his), sent once to OpenAI `gpt-4o-mini-tts` with his `OPENAI_API_KEY`. The S3 is not touched: the audio is only saved. Cost: a fraction of a cent. Suggested question: 「把一句固定的话（不含你的信息）发给 OpenAI 合成一次语音，只存成文件，不接 S3，可以吗？」

- [ ] **Step 2: Speak it and read the levels**

Run: `node bridge/bin/walkie-dev.js say "好的，已经切到语音助手这个项目了。接下来要我做什么？" --provider openai --out bridge/takes/marin.wav`
Expected: the `[keys]` line, `first audio from openai after 0.9 s`, a line such as `level: 4.6 s, peak 32113 (98% of full scale), rms 7350, 0.0% of samples at the limit`, and `saved bridge/takes/marin.wav` (the numbers here are examples).

How to read the `level:` line:
- `peak` cannot pass `Math.ceil(0.98 * 32768)` = 32113, because the limiter's ceiling is 0.98 of full scale. A peak above 32113 is a bug in the chain: stop and report it.
- `rms` is the number to judge. Variant 5 of the Stage 0 listening test had RMS 5802, and the offline chain on the Stage 0 `marin` sample gave 7561; the shipped gain (27.5 dB) gave 7526 on that sample. A different sentence has a different crest factor, so accept an RMS from 5800 to 8500.
- `% of samples at the limit` counts samples at 32700 or more, above the limiter's ceiling, so it reads 0.0 by construction. It does not measure distortion: distortion is judged by ear in Step 6.

If `rms` is outside 5800 to 8500, move `makeupDb` by `20 * log10(7000 / rms)` dB, rounded to 0.5, in `bridge/config.json` and in `DEFAULT_LOUDNESS` in `bridge/src/speech/loudness.js` (update the calibration comment on that line with the new numbers), and ask gate D again before repeating this step: the second run sends the sentence once more. The second run must land inside the band. If it does not, stop and report both runs to him; do not keep iterating.

- [ ] **Step 3: Ask gate E: the S3 (COM8), a test tone and two voices**

This step runs on the real device, so the device rule applies in full (Global Constraints): ask once, name everything that runs, and never pass `--port COM9`, which is a different board. Suggested question, with an unambiguous yes and a not-now: 「接上 S3（COM8）做四次操作：ping 两次、放一个 2 秒的测试音、再让它读那句固定的话两遍（一遍 OpenAI 的声音，一遍 Gemini 的声音，只发这句文字）。不写闪存。声音会比较响，按你在 Stage 0 选的那个响度。可以吗？」

What runs: `ping 2`, `play tone 440 2`, `say … --provider openai` and `say … --provider gemini`, one after the other. Nothing is flashed, and only one program can hold COM8 at a time, so close any other terminal that has it open.

- [ ] **Step 4: Check the link and the rebuilt playback**

Run: `node bridge/bin/walkie-dev.js ping 2`
Expected: two lines `pong: 12 ms round trip, S3 up 431.6 s, S3 saw 0 bad chunks and 0 gaps`, then `bridge saw 0 bad chunks and 0 gaps`.

If there is no PONG within 3 s, the S3 may be booted into on-the-beat (app0). Do not retry and do not switch it yourself. Tell him, and ask separately for `node tools/boot.mjs app1`, which writes only otadata (0xE000); ask again, separately, before putting it back with `node tools/boot.mjs app0` at the end of this task.

Run: `node bridge/bin/walkie-dev.js play tone 440 2`
Expected: `played: 96000 of 96000 bytes in 2.05 s, 0 underruns, ring peak <n> bytes` (the time is a little over 2 s). This is the regression check for Task 5, which rebuilt `playAudio` on `playStream`: plan 1 printed the same line for the same command. Any underruns, or fewer than 96000 bytes, stop the task: report the line.

- [ ] **Step 5: Speak on the S3 with each voice**

Run: `node bridge/bin/walkie-dev.js say "好的，已经切到语音助手这个项目了。接下来要我做什么？" --provider openai`
Expected: the `[keys]` line, `first audio from openai after 0.9 s`, `played: <bytes> bytes, 0 underruns, ring peak <n> bytes`, then the `level:` line. The S3 speaks the sentence while the audio is still arriving.

Run: `node bridge/bin/walkie-dev.js say "好的，已经切到语音助手这个项目了。接下来要我做什么？" --provider gemini`
Expected: `first audio from gemini after 5.1 s` (Gemini sends one whole WAV, so nothing is heard before it is complete), then the same `played:` and `level:` lines. If Gemini's speech model fails, the console shows a line such as `speech: gemini speak: HTTP 503 …` and the command ends with an error that starts `no provider could speak:` and lists the failure: that is the honest state of the fallback voice today; record it and go on.

- [ ] **Step 6: Ask him what he heard**

Ask, with the AskUserQuestion tool, about the OpenAI voice at the loudness the chain produced: loud enough, and clean? Options: 「响度和音质都可以」, 「太小声」, 「太响，或者有破音」. One question about the Gemini voice is enough as well: usable, or not. He alone can judge the sound; do not guess from the numbers.

- 「响度和音质都可以」: no change.
- 「太小声」: raise `makeupDb` by 2 dB in both files. 「太响，或者有破音」: lower it by 3 dB in both files. Then ask gate E again and repeat Step 5's OpenAI run once. If the second run is still not right, stop and report both numbers and his words: from here the lever is the firmware's speaker magnification (plan 4), not this plan.

If he wants to try stopping a reply from the keyboard, he runs this himself in his own terminal, because Ctrl+C has to be pressed by a person: `node bridge/bin/walkie-dev.js say "这是一段比较长的测试语音，用来检查中途按 Ctrl+C 能不能立刻停下来。我会一直说下去，所以请在听到声音以后马上按下去。" --provider openai`. Expected: the sound stops within about half a second of the key press and the console prints `stopped: <bytes> bytes, 0 underruns, ring peak <n> bytes`. It is a live check of the abort path (Tasks 5 and 9) through a real TTS stream; report what he says he saw and heard.

If you switched the S3 to walkie in Step 4, ask him whether to put it back (`node tools/boot.mjs app0`). Do not do it without a yes.

- [ ] **Step 7: Commit the calibration, if it moved**

Only if `makeupDb` changed in Step 2 or Step 6. Run `npm --prefix bridge test` first: expected PASS, 222 tests (no test compares the two values, so this only proves the edit did not break anything else).

```bash
git add bridge/config.json bridge/src/speech/loudness.js
git commit -m "Bridge: makeup gain recalibrated on live marin output" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Record what was measured in the spec**

Three edits to §6.5, which write down the decisions Tasks 4 and 9 made, and three to §10, which turn its first three open items into what was found. In the §10 texts, each `<…>` is a value kept from Tasks 1, 11 and 12: replace it with that value and leave nothing in angle brackets. A check he declined, or one that could not run, is written as `Not checked: <why>.` in place of its numbers, and the item then says what is still untested. If Task 1 found a model name that is out of date and he chose a replacement, change that name in §6.5's table too.

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- Provider chain. Each step has a primary and a fallback; a provider that fails is skipped for 5 minutes, so a bad spell costs one timeout rather than one per utterance.
```

with

```markdown
- Provider chain. Each step has a primary and a fallback; a candidate that fails (one model at one step, so a voice that fails does not silence the transcriber) is skipped for 5 minutes, so a bad spell costs one timeout rather than one per utterance.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
Clips under 300 ms of speech, or an empty transcript, become 「没听清」
```

with

```markdown
Clips under 300 ms of speech, an empty transcript, or a lone filler (「嗯」, "um"), become 「没听清」
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
The Gemini fallback returns one WAV, which goes through the same chain.
```

with

```markdown
The Gemini fallback returns one WAV, which goes through the same chain. A voice that falls silent for 3 s in the middle of a reply counts as failed; the reply ends there and is not repeated in the other voice.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- Recognition of his own voice through the S3 mic at wrist distance, after the gain change and the start-up trim. Stage 0 got one exact transcript at the default gain with the S3 held as he naturally held it; wrist distance and the lower gain are still untested.
```

with

```markdown
- Recognition of his own voice through the S3 mic, after the gain change and the start-up trim. Checked on <date> (plan 2) on the twelve takes that `walkie-dev listen` saved on 29 and 30 Sep at several gain settings, each sent once to `gpt-transcribe` by `walkie-dev hear --provider openai`: <N> of 12 came back as he said them. <The wrong ones, each as "name: what came back", or "None was wrong.">. He said the takes were <all / partly / not> held at wrist distance. Three seconds of generated room noise came back as <the transcript, or "an empty transcript, which the chain turns into 「没听清」">.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- The Gemini fallback: whether the flash models are back from their 503s, and whether to call generateContent or the Interactions API.
```

with

```markdown
- The Gemini fallback. On <date> (plan 2) the probe of Task 1 got: <its three summary lines, joined with semicolons>. One recorded take through the real adapter: <"`gemini-3.8-flash` heard it as 「…」 in N s", or "both hearing models failed: why">. `generateContent` stays: the adapter is one file (`bridge/src/speech/gemini.js`), so a move to the Interactions API would touch nothing else.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- Loudness chain calibration against variant 5 with `marin`, and whether magnification 2 makes it distort.
```

with

```markdown
- Loudness chain calibration against variant 5 with `marin`. `makeupDb` is <27.5, or the new value> (`bridge/config.json`). The sentence 「好的，已经切到语音助手这个项目了。接下来要我做什么？」 spoken by `marin` came out at RMS <rms>, peak <peak> (variant 5: RMS 5802; the offline chain on the Stage 0 `marin` sample: 7561). Played on the S3 at magnification 2, he judged it: <his verdict in his words>. The Gemini voice: <his verdict, or the failure>.
```

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: exit code 0. The bridge part reports `tests 222`, `pass 222` and `fail 0` (Tasks 11 and 12 add no tests), and the tools and firmware host parts pass as they did at the end of plan 1.

- [ ] **Step 10: Commit the spec**

```bash
git add docs/superpowers/specs/2026-09-29-walkie-design.md
git commit -m "Docs: spec records the plan 2 measurements and the speech chain's decisions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Report to him**

Report in Chinese, as in every reply to him, and say plainly which checks ran and which did not. Give: `correct N/20`; N of 12 takes right, with the wrong ones by name and what came back; whether the noise clip produced words; Gemini's state (the probe lines and the recorded take); marin's RMS and peak, the final `makeupDb` and his verdict on the S3; and whether the S3 was left in walkie or put back to on-the-beat. Say what is still open in §10: the permission MCP over HTTP and the cache re-writes belong to plan 3. `bridge/takes/marin.wav`, `silence.wav` and `make-silence.mjs` stay in the gitignored folder. Then stop: plans 3 (the Claude session manager and the permission server) and 4 (the firmware screens, keys and `main` wiring) each start with their own plan.
