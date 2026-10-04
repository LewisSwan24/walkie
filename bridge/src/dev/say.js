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
