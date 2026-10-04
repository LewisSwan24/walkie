// The provider chain (spec 6.5): hear an utterance, speak a reply. Each step tries the providers in order, every try
// under a time limit. A candidate that fails is skipped for config.cooldownMs, so a bad spell costs one timeout rather
// than one per utterance, and the console is told which one failed and why. This file knows the order, the limits and
// the last resorts; how to talk to a provider is the adapters' business (openai.js, gemini.js).
import { tone } from '../audio/tone.js';
import { encodeWav } from '../audio/wav.js';
import { validateAnswer } from '../intent/intent.js';
import { fixedPhrase, hasWords, isFiller } from '../intent/phrases.js';
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
  const skipped = new Map(); // candidate key -> {until: the time it is tried again, label}
  const ready = (key) => (skipped.get(key)?.until ?? 0) <= now();

  // `only` names one provider to use and nothing else: the dev commands use it to test a provider on purpose, so it
  // ignores the skip windows and does not start any. `force` is the one skipped candidate tried anyway (see soonest).
  const usable = (adapter, key, only, force = null) => (only ? adapter.name === only : key === force || ready(key));

  // The candidate to try although it is skipped, when every candidate of a step is: the one whose window ends first, and
  // the console says so. A window saves a timeout per utterance only while another candidate is left to ask; once none
  // is, a single hiccup would leave the device deaf, or mute, for the whole window. Null when one candidate is ready.
  // Classifying never asks for this: the fixed phrases and Claude are what it falls back on.
  function soonest(keys, only, step) {
    if (only || !keys.length || keys.some(ready)) return null;
    const key = keys.reduce((x, y) => (skipped.get(y).until < skipped.get(x).until ? y : x));
    log(`speech: every ${step} candidate is being skipped; trying ${skipped.get(key).label} anyway`);
    return key;
  }

  function fail(key, label, reason, only) {
    if (only) {
      log(`speech: ${reason}`);
      return;
    }
    skipped.set(key, { until: now() + config.cooldownMs, label });
    log(`speech: ${reason}; skipping ${label} for ${span(config.cooldownMs)}`);
  }

  // One try of one candidate under its time limit: {value} or {reason}. The caller giving up is thrown on, because
  // nothing failed.
  async function attempt(key, label, ms, { signal, only }, run) {
    try {
      const value = await withDeadline(ms, signal, run);
      if (!only) skipped.delete(key); // it answered: whatever kept it out is over
      return { value };
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
    const keys = adapters.flatMap((a) => (a.transcribe ? [`${a.name}:transcribe`] : a.hear ? a.hearModels.map((m) => `${a.name}:hear:${m}`) : []));
    const force = soonest(keys, only, 'transcription');
    for (const a of adapters) {
      if (a.transcribe) {
        const key = `${a.name}:transcribe`;
        if (!usable(a, key, only, force)) continue;
        const ms = Math.round(a.limits.transcribeBaseMs + config.transcribeClipFraction * clipMs);
        const r = await attempt(key, `${a.name} transcribe`, ms, ask, (signal) => a.transcribe(wav, { prompt: transcriptionPrompt(projects), signal }));
        if ('value' in r) return { transcript: String(r.value ?? '').trim(), by: a.name };
      } else if (a.hear) {
        for (const model of a.hearModels) {
          const key = `${a.name}:hear:${model}`;
          if (!usable(a, key, only, force)) continue;
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
    // `onTranscript(text)` is called once the words are known and there is something to act on, before the classifier
    // is asked: the device shows them while the intent is still being worked out (spec 4, step 3).
    async hear(pcm, { currentProject = null, busy = false, classify = true, only = null, signal, onTranscript } = {}) {
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
      const force = soonest(adapters.filter((a) => a.speak).map((a) => `${a.name}:speak`), only, 'speaking');
      for (const a of adapters) {
        if (!a.speak) continue;
        const key = `${a.name}:speak`;
        if (!usable(a, key, only, force)) {
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
