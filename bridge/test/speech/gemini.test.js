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
