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
