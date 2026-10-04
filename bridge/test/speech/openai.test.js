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
