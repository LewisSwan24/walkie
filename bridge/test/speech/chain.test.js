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
