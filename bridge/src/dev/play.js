// Plays a file (anything ffmpeg reads, converted to 24 kHz mono PCM16) or a test tone on the S3.
// Ctrl+C stops it the way the bridge will stop a reply.
import { spawnSync } from 'node:child_process';
import { tone } from '../audio/tone.js';
import { connect } from './connect.js';

export default async function play([what, a, b], opts) {
  const pcm = what === 'tone' ? tone(Number(a ?? 440), Number(b ?? 3)) : readAudio(what);
  const link = await connect(opts);
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const t0 = Date.now();
  const p = await link.playAudio(pcm, { signal: ac.signal });
  console.log(`${p.reason === 0 ? 'played' : 'stopped'}: ${p.bytes} of ${pcm.length} bytes in ${((Date.now() - t0) / 1000).toFixed(2)} s, ${p.underruns} underruns, ring peak ${p.maxFill} bytes`);
  link.close();
}

function readAudio(file) {
  if (!file) throw new Error('play <file> | play tone <hz> <secs>');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`could not start ffmpeg: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${file}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}
