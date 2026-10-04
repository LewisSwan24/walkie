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
