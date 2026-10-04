// Saves every talk-key take as a 16 kHz WAV and prints its levels, the first 250 ms (the mic's start-up
// transient) and the last 100 ms (the talk-key release click) left out of them; the saved WAV keeps both.
// Runs until Ctrl+C.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TakeCollector } from '../audio/takes.js';
import { encodeWav, levels } from '../audio/wav.js';
import { connect } from './connect.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../takes/', import.meta.url));

export default async function listen(args, opts) {
  const dir = path.resolve(opts.out ?? DEFAULT_DIR);
  mkdirSync(dir, { recursive: true });
  const link = await connect(opts);
  const takes = new TakeCollector();
  let count = 0;
  link.on('hello', () => takes.reset());
  link.on('audio-up', (f) => {
    const pcm = takes.push(f);
    if (!pcm) return;
    const file = path.join(dir, `take-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
    writeFileSync(file, encodeWav(pcm, 16000));
    const l = levels(pcm, 16000, 250, 100);
    console.log(`take ${++count}: ${(l.durationMs / 1000).toFixed(2)} s, peak ${l.peak} (${Math.round((l.peak / 32768) * 100)}% of full scale), rms ${l.rms}, clipped ${l.clippedPct.toFixed(2)}% -> ${file}`);
  });
  console.log('Hold the front key and talk. Ctrl+C to stop.');
  await new Promise(() => {});
}
