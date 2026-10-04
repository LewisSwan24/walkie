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
