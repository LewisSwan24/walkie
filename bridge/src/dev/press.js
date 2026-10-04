// press <script>: the S3's keys, pressed by the firmware itself (TEST KEYS), so that the gestures can be tried with no hand on the
// device. The S3 logs what it does with them ("act ...", "screen ...") and walkie-dev prints those lines.
//   front:<ms> | side:<ms> | both:<ms>    press, hold for that long, release
//   down:<key> | up:<key>                 press or release without a hold (key is front, side or both)
//   wait:<ms>                             nothing for a while
// Words are separated by spaces or commas. --snap file.png saves a picture of the screen when the script is over. Examples:
//   front:600                             a talk take of 0.6 s
//   side:1100                             the 1 s hold that stops Claude
//   down:front wait:100 down:side wait:3100 up:both     a chord held for 3 s: SWITCH_CONFIRM
import { TYPE } from '../link/frame.js';
import { KEY, LIMITS, testKeysPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { snapTo } from './snap.js';

const BITS = { front: KEY.FRONT, side: KEY.SIDE, both: KEY.FRONT | KEY.SIDE };
const MAX_MS = 0xffff;
const SETTLE_MS = 1500; // for the S3 to finish and say what it did

export class ScriptError extends Error {}

function millis(text, word) {
  if (!/^\d+$/.test(text ?? '')) throw new ScriptError(`${word} needs a time in milliseconds, like ${word.split(':')[0]}:500`);
  return Number(text);
}

// -> {steps: [{delayMs, mask}], totalMs}: each step is "after delayMs, the keys held are mask".
export function parseKeyScript(text) {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) throw new ScriptError('the script is empty: front:600, side:1100, down:front wait:100 up:front ...');
  const steps = [];
  let held = 0;
  let wait = 0;
  let totalMs = 0;
  const set = (mask) => {
    steps.push({ delayMs: wait, mask });
    totalMs += wait;
    wait = 0;
    held = mask;
  };
  const delay = (ms, word) => {
    wait += ms;
    if (wait > MAX_MS) throw new ScriptError(`${word}: at most ${MAX_MS} ms between two key changes`);
  };
  for (const word of words) {
    const colon = word.indexOf(':');
    const name = colon < 0 ? word : word.slice(0, colon);
    const arg = colon < 0 ? undefined : word.slice(colon + 1);
    if (Object.hasOwn(BITS, name)) {
      const ms = millis(arg, word);
      if (ms === 0) throw new ScriptError(`${word}: a hold is for more than 0 ms`);
      set(held | BITS[name]);
      delay(ms, word);
      set(held & ~BITS[name]);
    } else if (name === 'wait') {
      delay(millis(arg, word), word);
    } else if (name === 'down' || name === 'up') {
      if (!Object.hasOwn(BITS, arg ?? '')) throw new ScriptError(`${word}: ${name} is followed by front, side or both`);
      if (name === 'down') set(held | BITS[arg]);
      else if ((held & BITS[arg]) === 0) throw new ScriptError(`${word}: ${arg} is not held`);
      else set(held & ~BITS[arg]);
    } else {
      throw new ScriptError(`unknown word "${word}" (front, side, both, down, up, wait)`);
    }
    if (steps.length > LIMITS.keySteps) throw new ScriptError(`a script has at most ${LIMITS.keySteps} steps`);
  }
  return { steps, totalMs };
}

// connectFn and sleep are for tests. With --snap file.png the screen is saved once the script has played out.
export default async function press(args, opts, connectFn = connect, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const { steps, totalMs } = parseKeyScript(args.join(' '));
  const link = await connectFn(opts);
  try {
    link.send(TYPE.TEST, testKeysPayload(steps));
    console.log(`keys: ${steps.length} steps over ${totalMs} ms`);
    await sleep(totalMs + SETTLE_MS);
    if (opts.snap) await snapTo(link, opts.snap);
  } finally {
    link.close();
  }
}
