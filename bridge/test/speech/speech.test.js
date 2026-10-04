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

test('one failure does not leave the device deaf for 5 minutes: with every transcriber skipped, one is asked anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let broken = true;
  const openai = fake('openai', {
    transcribe: async () => { if (broken) throw httpError('openai', 'transcribe', 503); return '继续'; },
    classify: async () => answer('continue'),
  });
  const { speech, lines } = make([openai]);
  assert.deepEqual(await speech.hear(clip(1000)), { status: 'unclear', reason: 'unavailable', transcript: '' });

  broken = false;
  t.mock.timers.tick(60_000); // a minute into a 5 minute window
  const heard = await speech.hear(clip(1000));
  assert.deepEqual([heard.status, heard.intent, heard.transcribedBy], ['ok', 'continue', 'openai']);
  assert.equal(openai.calls.transcribe.length, 2);
  assert.ok(lines.includes('speech: every transcription candidate is being skipped; trying openai transcribe anyway'), lines.join('\n'));

  await speech.hear(clip(1000));
  assert.equal(openai.calls.transcribe.length, 3);
  assert.equal(lines.filter((l) => l.includes('anyway')).length, 1, 'it answered, so its window is over and nothing is forced any more');
});

test('when every transcriber is skipped, the one whose window ends first is the one asked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let geminiBroken = true;
  const openai = fake('openai', { transcribe: async () => { throw httpError('openai', 'transcribe', 503); }, classify: async () => answer('continue') });
  const gemini = fake('gemini', {
    hear: async () => {
      if (geminiBroken) throw httpError('gemini', 'hear', 503);
      return { transcript: '继续', intent: 'continue', project: null, text: '' };
    },
  });
  const { speech } = make([openai, gemini]);
  await speech.hear(clip(1000)); // all three candidates fail at t = 0 and are skipped until 5 min
  t.mock.timers.tick(10_000);
  await speech.hear(clip(1000)); // every window ends together: the first candidate is asked, fails again, and its window moves out to 5 min 10 s
  assert.deepEqual([openai.calls.transcribe.length, gemini.calls.hear.length], [2, 2]);

  geminiBroken = false;
  t.mock.timers.tick(10_000);
  assert.equal((await speech.hear(clip(1000))).transcribedBy, 'gemini', 'its window now ends before OpenAI’s');
  assert.deepEqual([openai.calls.transcribe.length, gemini.calls.hear.length], [2, 3]);
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
  await assert.rejects(speech.say('你好'), /openai speak: HTTP 429 overloaded; gemini speak is being skipped after an earlier failure/);
  assert.deepEqual([openai.calls.speak.length, gemini.calls.speak.length], [2, 1], 'the voice whose window ends first is tried anyway, the other is not');
});

test('one failed reply does not leave the device mute for 5 minutes: with every voice skipped, one is tried anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let broken = true;
  const openai = fake('openai', { speak: async function* () { if (broken) throw httpError('openai', 'speak', 503); yield tone(300, 0.1, 2000); } });
  const { speech, lines } = make([openai]);
  await assert.rejects(speech.say('你好'), (err) => err.kind === 'unavailable');

  broken = false;
  t.mock.timers.tick(60_000); // a minute into a 5 minute window
  assert.equal((await speech.say('你好')).provider, 'openai');
  assert.equal(openai.calls.speak.length, 2);
  assert.ok(lines.includes('speech: every speaking candidate is being skipped; trying openai speak anyway'), lines.join('\n'));

  await speech.say('再来');
  assert.equal(openai.calls.speak.length, 3);
  assert.equal(lines.filter((l) => l.includes('anyway')).length, 1, 'it spoke, so its window is over and nothing is forced any more');
});

test('only: ignores skip windows, so it is never told that a candidate is being skipped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const openai = fake('openai', {
    transcribe: async () => { throw httpError('openai', 'transcribe', 503); },
    speak: async function* () { throw httpError('openai', 'speak', 503); },
  });
  const { speech, lines } = make([openai]);
  await speech.hear(clip(1000));
  await assert.rejects(speech.say('你好'));
  await speech.hear(clip(1000), { only: 'openai' });
  await assert.rejects(speech.say('你好', { only: 'openai' }));
  assert.deepEqual([openai.calls.transcribe.length, openai.calls.speak.length], [2, 2], 'only asked it again, windows or not');
  assert.ok(!lines.some((l) => l.includes('anyway')), lines.join('\n'));
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

test('a transcript of nothing but punctuation is 没听清 too, and goes nowhere', async () => {
  for (const said of ['。', '...', '…', '？']) {
    const openai = fake('openai', { transcribe: async () => said, classify: async () => answer('stop') });
    const { speech } = make([openai]);
    assert.deepEqual(await speech.hear(clip(1000)), { status: 'unclear', reason: 'empty', transcript: '' }, said);
    assert.equal(openai.calls.classify?.length ?? 0, 0, said);
  }
});

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
