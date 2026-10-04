// A recording fed to the S3 as its microphone, so that a whole voice turn can be run with nobody speaking: the firmware's TEST
// hooks make the front key go down and give it the recording instead of the mic (spec 7).
//   walkie-dev inject <wav> [--out dir]    the take comes back to this terminal as a talk-key take would: its levels, and a WAV
//   walkie --inject <wav>                  the same take goes through the whole bridge: speech, Claude, the reply spoken
// The WAV is 16 kHz mono PCM16, like the ones `listen` saves.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TakeCollector } from '../audio/takes.js';
import { decodeWav, encodeWav, levels } from '../audio/wav.js';
import { TYPE } from '../link/frame.js';
import { KEY, testKeysPayload, testMicPcmPayload, testMicSourcePayload } from '../link/messages.js';
import { connect } from './connect.js';

const BYTES_PER_MS = 32; // 16 kHz PCM16
const CHUNK_BYTES = 640; // 20 ms, what the S3 takes from the FIFO at a time
const MAX_HOLD_MS = 16_000; // the FIFO holds 2^19 bytes: 16.4 s
const CLEAR_MS = 150; // the S3 empties the FIFO when the source goes off, in its audio task, a moment later
const SETTLE_MS = 800; // after the key is up, for the take to end before the source is switched back
// The S3 cannot take the recording as fast as the port can carry it (gate I: 283 chunks at once lost 50 frames, the key script
// among the likely ones, and with it the whole take), so four chunks go in and then a pause: no frame lost in 283 that way.
const PACE_CHUNKS = 4;
const PACE_MS = 5;
const TAKE_WAIT_MS = 5000;
const WORKS_FOR_CLAUDE = new Set(['to_claude', 'continue', 'compact']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The recording in `file`, as PCM16 at 16 kHz; anything else is an error that says what to do about it.
export function readRecording(file) {
  const { rate, pcm } = decodeWav(readFileSync(file));
  if (rate !== 16000) throw new Error(`${file} is ${rate} Hz, the S3 records 16000 Hz (ffmpeg -i in.wav -ac 1 -ar 16000 out.wav)`);
  return pcm;
}

// Feeds `pcm` (PCM16 at 16 kHz) to the S3 as the mic and holds the front key for as long as it lasts, with `leadInMs` of silence
// in front (the first moments of a take are trimmed away) and `tailMs` after. The recording goes into the FIFO first, all of it
// (paced, see PACE_CHUNKS), and then the key goes down: the S3 reads it at the mic's pace, so the timing is the firmware's. Resolves when the key is up and
// the microphone is the real one again: {holdMs, chunks}.
export async function injectTake(link, pcm, { leadInMs = 500, tailMs = 300, sleep = defaultSleep } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2) throw new RangeError('the recording must be PCM16: a whole number of 16-bit samples, and not none');
  if (!Number.isInteger(leadInMs) || leadInMs < 0) throw new RangeError(`the lead-in must be whole milliseconds, not ${leadInMs}`);
  if (!Number.isInteger(tailMs) || tailMs < 0) throw new RangeError(`the tail must be whole milliseconds, not ${tailMs}`);
  const stream = Buffer.concat([Buffer.alloc(leadInMs * BYTES_PER_MS), pcm, Buffer.alloc(tailMs * BYTES_PER_MS)]);
  const holdMs = Math.ceil(stream.length / BYTES_PER_MS);
  if (holdMs > MAX_HOLD_MS) throw new RangeError(`a take of ${(holdMs / 1000).toFixed(1)} s (with the lead-in and the tail) does not fit the S3's 16 s test FIFO`);
  let chunks = 0;
  try {
    link.send(TYPE.TEST, testMicSourcePayload(false)); // so that nothing is left in the FIFO from before
    await sleep(CLEAR_MS);
    link.send(TYPE.TEST, testMicSourcePayload(true));
    for (let at = 0; at < stream.length; at += CHUNK_BYTES) {
      link.send(TYPE.TEST, testMicPcmPayload(stream.subarray(at, at + CHUNK_BYTES)));
      chunks++;
      if (chunks % PACE_CHUNKS === 0) await sleep(PACE_MS);
    }
    link.send(TYPE.TEST, testKeysPayload([{ delayMs: 0, mask: KEY.FRONT }, { delayMs: holdMs, mask: 0 }]));
    await sleep(holdMs + SETTLE_MS);
  } finally {
    try {
      link.send(TYPE.TEST, testMicSourcePayload(false));
    } catch {
      // the link is gone, and with it the S3's test mode
    }
  }
  return { holdMs, chunks };
}

const poll = async (check, deadline) => {
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await defaultSleep(25);
  }
  return true;
};

// Runs the bridge through one injected utterance and says what became of it. `bridge` is startBridge's result; the rest of the
// options go to the injection. Resolves {outcome, heard, reply, failure}; outcome is one of
//   reply      Claude answered, and the voice was spoken to the end
//   failure    Claude could not answer (failure says why)
//   handled    the words were a command for walkie itself, and what it said was spoken
//   unclear    the speech chain could not make anything of the take
//   timeout    something did not happen within `timeoutMs` (counted from the end of the injection): the take never arrived, or
//              Claude was still at it
//   no-device  the S3 did not answer HELLO within `readyMs`, so nothing was injected
export async function runInjected(bridge, pcm, { timeoutMs = 180_000, readyMs = 30_000, inject = injectTake, ...options } = {}) {
  const found = { heard: null, reply: null, failure: null };
  const offs = [
    bridge.turn.on('heard', (h) => (found.heard = found.heard ?? h)),
    bridge.manager.on('reply', (r) => (found.reply = r)),
    bridge.manager.on('failure', (f) => (found.failure = f)),
  ];
  const result = (outcome) => ({ outcome, ...found });
  try {
    if (!(await poll(() => bridge.link.ready, Date.now() + readyMs))) return result('no-device');
    await inject(bridge.link, pcm, options);
    const deadline = Date.now() + timeoutMs;
    if (!(await poll(() => found.heard, deadline))) return result('timeout');
    if (found.heard.status !== 'ok') return result('unclear');
    if (WORKS_FOR_CLAUDE.has(found.heard.intent) && !(await poll(() => found.reply || found.failure, deadline))) return result('timeout');
    let expire;
    const expired = new Promise((resolve) => (expire = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))));
    const spoken = await Promise.race([bridge.turn.settled().then(() => true), expired]);
    clearTimeout(expire); // or the run would last until the deadline, with nothing left to do
    if (!spoken) return result('timeout');
    return result(found.reply ? 'reply' : found.failure ? 'failure' : 'handled');
  } finally {
    for (const off of offs) off();
  }
}

// connectFn, sleep and takeWaitMs are for tests.
export default async function inject([file], opts, connectFn = connect, { sleep = defaultSleep, takeWaitMs = TAKE_WAIT_MS } = {}) {
  if (!file) throw new Error('inject <wav> [--out dir]: a 16 kHz mono PCM16 WAV');
  const pcm = readRecording(file);
  const link = await connectFn(opts);
  try {
    const takes = new TakeCollector();
    const back = new Promise((resolve) => {
      link.on('audio-up', (f) => {
        const take = takes.push(f);
        if (take) resolve(take);
      });
    });
    const sent = levels(pcm, 16000);
    console.log(`${file}: ${(sent.durationMs / 1000).toFixed(2)} s, peak ${sent.peak}`);
    const { holdMs } = await injectTake(link, pcm, { sleep });
    const take = await Promise.race([back, defaultSleep(takeWaitMs).then(() => null)]);
    if (!take) throw new Error(`no take came back within ${takeWaitMs / 1000} s of the key going up: is the S3 running walkie with the TEST hooks?`);
    const l = levels(take, 16000);
    console.log(`take: ${(l.durationMs / 1000).toFixed(2)} s (the key was held ${(holdMs / 1000).toFixed(2)} s), peak ${l.peak}${l.peak === sent.peak ? ', the recording is in it' : ` - NOT the recording's peak ${sent.peak}`}`);
    if (opts.out) {
      mkdirSync(path.resolve(opts.out), { recursive: true });
      const saved = path.join(opts.out, `inject-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
      writeFileSync(saved, encodeWav(take, 16000));
      console.log(`saved ${saved}`);
    }
    if (l.peak !== sent.peak) process.exitCode = 1;
  } finally {
    link.close();
  }
}
