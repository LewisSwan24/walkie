// Proves the link loses nothing.
//   up:   the S3 sends a 5 s take of the test pattern; every byte is compared.
//   down: a quiet tone plays; the S3's count and CRC-32 of what reached its speaker are compared.
//   stop: a 10 s tone is stopped after 2 s; the next 1 s tone must then play in full.
import { crc32 } from 'node:zlib';
import { TakeCollector } from '../audio/takes.js';
import { tone } from '../audio/tone.js';
import { patternBytes } from '../link/pattern.js';
import { connect, withTimeout } from './connect.js';

export default async function loopback([which = 'all', secs = '10'], opts) {
  const checks = {
    up: (link) => up(link),
    down: (link) => down(link, Number(secs)),
    stop: (link) => stop(link),
  };
  const names = which === 'all' ? Object.keys(checks) : [which];
  for (const name of names) {
    if (!checks[name]) throw new Error(`loopback ${name}? Use ${Object.keys(checks).join(', ')} or all.`);
  }
  const link = await connect(opts);
  let ok = true;
  for (const name of names) ok = (await checks[name](link)) && ok;
  link.close();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
}

async function up(link, frames = 250) {
  const takes = new TakeCollector();
  let first = 0;
  let last = 0;
  const take = new Promise((resolve) => {
    const onFrame = (f) => {
      last = Date.now();
      if (!first) first = last;
      const pcm = takes.push(f);
      if (!pcm) return;
      link.off('audio-up', onFrame);
      resolve(pcm);
    };
    link.on('audio-up', onFrame);
  });
  link.testUpPattern(frames);
  const pcm = await withTimeout(take, frames * 20 + 5000, 'the pattern take did not arrive');
  const want = patternBytes(0, frames * 320);
  const same = pcm.equals(want);
  console.log(`up: ${pcm.length} of ${want.length} bytes, ${same ? 'identical' : 'DIFFERENT'}; ${frames} frames arrived over ${((last - first) / 1000).toFixed(2)} s (sent over ${((frames - 1) * 0.02).toFixed(2)} s)`);
  return same;
}

async function down(link, secs) {
  const pcm = tone(523.25, secs); // a quiet C5
  const t0 = Date.now();
  const p = await link.playAudio(pcm);
  const crcOk = p.crc32 === crc32(pcm);
  console.log(`down: ${p.bytes} of ${pcm.length} bytes played, CRC ${crcOk ? 'matches' : 'DIFFERS'}, ${p.underruns} underruns, ring peak ${p.maxFill} bytes, ${((Date.now() - t0) / 1000).toFixed(2)} s for ${secs} s of audio`);
  return p.reason === 0 && p.bytes === pcm.length && crcOk && p.underruns === 0;
}

async function stop(link) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  const cut = await link.playAudio(tone(440, 10), { signal: ac.signal });
  clearTimeout(timer);
  const next = await link.playAudio(tone(660, 1));
  console.log(`stop: cut after ${(cut.bytes / 48000).toFixed(2)} s of audio (reason ${cut.reason}); the next 1 s tone played ${next.bytes} of 48000 bytes`);
  return cut.reason === 1 && cut.bytes > 0 && cut.bytes < 480000 && next.reason === 0 && next.bytes === 48000;
}
