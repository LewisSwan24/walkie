// Gate P5, on the real S3: the sealed link, pairing and ADPCM of plan 5, without any API.
// A person must be at the S3 for two presses: the side key in the scene 'pair again', and the front key at the end, when the S3 forgets
// the gate's key. Both say so on the screen and wait 35 s. Once the S3 is paired it drops every plain frame, TEST KEYS included, so the
// gate cannot press for it; only the first pairing, on an unpaired S3, is pressed with TEST KEYS. It pairs with a throwaway key made for
// this run, never with %APPDATA%\walkie\pair.key; an S3 that already holds a key is refused at the start, because pairing here would
// replace the one that is in use.
// Usage: node tools/gate-p5.mjs [--port COMx] [--only "scene name;scene name"]
// Exit code 0 when every scene held, 1 when one did not. The S3 must run the plan 5 firmware (node tools/flash.mjs) and nothing else
// may hold its port (not walkie, not walkie-dev). It opens COM8 and writes the S3's NVS (the key, then its removal): run it only
// when the person at the machine has said so.
import { randomBytes } from 'node:crypto';
import { FLAG, TYPE } from '../bridge/src/link/frame.js';
import { Link } from '../bridge/src/link/link.js';
import { KEY, PAIR_OP, pairForgetPayload, pairSetPayload, parsePairReply, testKeysPayload, testSelftestPayload } from '../bridge/src/link/messages.js';
import { portOpener } from '../bridge/src/dev/connect.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = flag('--only')?.split(';');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const openPort = portOpener(flag('--port'));
const { FRONT, SIDE } = KEY;

const waitFor = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 50) await sleep(50);
  return check();
};

// A link with what it saw. `master` null is a plain link; `pairing` is the plain link that holds no key and does not refuse a paired S3.
async function open({ master = null, pairing = false, adpcm = false, helloMs = 6000 } = {}) {
  const link = new Link({ openPort, master, pairing, adpcm });
  const seen = { logs: [], statuses: [], pongs: 0, takeFrames: 0, takeEnds: 0, hello: null };
  link.on('log', (l) => seen.logs.push(l));
  link.on('status', (s) => seen.statuses.push(s));
  link.on('pong', () => seen.pongs++);
  link.on('audio-up', (f) => {
    seen.takeFrames++;
    if (f.flags & FLAG.EOS) seen.takeEnds++;
  });
  const hello = new Promise((resolve) => link.once('hello', resolve));
  await link.start();
  seen.hello = await Promise.race([hello, sleep(helloMs).then(() => null)]);
  return { link, seen, close: async () => { link.close(); await sleep(900); } }; // the port needs a moment before the next open
}

const tap = (link, mask, holdMs) => link.send(TYPE.TEST, testKeysPayload([{ delayMs: 0, mask }, { delayMs: holdMs, mask: 0 }]));

// Offers `key` (or asks to forget, with key null) and presses `button` at the S3 once its confirm screen is up: with TEST KEYS on a plain
// link (an unpaired S3), or, with `manual`, by asking the person at the S3 to press it (a paired S3 drops TEST KEYS).
// Resolves with the S3's answer: 'ok', 'denied' or 'none'.
async function pairWith(link, seen, key, button, { manual = false } = {}) {
  const answers = [];
  link.on('frame', (f) => {
    if (f.type !== TYPE.PAIR) return;
    const reply = parsePairReply(f.payload);
    if (reply) answers.push(reply);
  });
  const op = key ? PAIR_OP.SET : PAIR_OP.FORGET;
  const payload = key ? pairSetPayload(key) : pairForgetPayload();
  link.send(TYPE.PAIR, payload);
  if (manual) console.log(`>>> press the ${button === FRONT ? 'FRONT' : 'SIDE'} key on the S3 now (you have 30 s)`);
  else {
    const asked = await waitFor(() => seen.logs.some((l) => /^screen pair/.test(l)), 3000);
    if (asked && button) {
      await sleep(700); // the front key counts only after it has been seen up on the confirm screen
      tap(link, button, 150);
    }
  }
  const resend = setInterval(() => link.send(TYPE.PAIR, payload), 3500); // the S3 gives up at 30 s: no repeat near it (bridge/src/pair.js)
  try {
    await waitFor(() => answers.some((a) => a.answered === op), manual ? 35_000 : 8000);
  } finally {
    clearInterval(resend);
  }
  const answer = answers.find((a) => a.answered === op);
  return !answer ? 'none' : answer.op === PAIR_OP.OK ? 'ok' : 'denied';
}

const selftestIn = async (link, seen) => {
  const before = seen.logs.length;
  link.send(TYPE.TEST, testSelftestPayload());
  await waitFor(() => seen.logs.slice(before).some((l) => l.startsWith('selftest')), 5000);
  return seen.logs.slice(before).find((l) => l.startsWith('selftest')) ?? 'no answer';
};

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
let paired = false;

// Each scene returns what it found wanting, as a list of sentences; an empty list is a pass.
const scenes = {
  'selftest: the mbedtls adapter agrees with the RFC 5869 and NIST vectors on the chip': async () => {
    const { link, seen, close } = await open();
    try {
      if (!seen.hello) return [`no HELLO: ${seen.statuses.join(' | ')}`];
      const answer = await selftestIn(link, seen);
      return answer.startsWith('selftest ok') ? [] : [answer];
    } finally {
      await close();
    }
  },
  'pair: the front key accepts, and the S3 answers OK': async () => {
    const { link, seen, close } = await open(); // plain: the S3 is unpaired here, and a plain link gets its LOG lines and can send TEST KEYS
    try {
      if (!seen.hello) return [`no HELLO: ${seen.statuses.join(' | ')}`];
      if (seen.hello.paired) return ['the S3 already holds a pairing key: this gate would replace it, so it stops (walkie pair --forget first)'];
      const answer = await pairWith(link, seen, KEY_A, FRONT);
      paired = answer === 'ok';
      return answer === 'ok' ? [] : [`the answer was ${answer}, wanted ok`];
    } finally {
      await close();
    }
  },
  'sealed: with the key the link comes up, pings are answered and the self-test runs sealed': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { link, seen, close } = await open({ master: KEY_A });
    try {
      if (!seen.hello) return [`no sealed HELLO: ${seen.statuses.join(' | ')}`];
      const bad = [];
      if (!(await waitFor(() => seen.pongs >= 3, 5000))) bad.push(`${seen.pongs} PONGs in 5 s`);
      const answer = await selftestIn(link, seen);
      if (!answer.startsWith('selftest ok')) bad.push(answer);
      if (link.badChunks || link.seqGaps) bad.push(`${link.badChunks} bad chunks, ${link.seqGaps} gaps`);
      return bad;
    } finally {
      await close();
    }
  },
  'plain refused: a bridge with no key gets no link from a paired S3': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { seen, close } = await open({ helloMs: 4000 });
    try {
      return seen.hello ? ['a plain link came up on a paired S3'] : [];
    } finally {
      await close();
    }
  },
  'wrong key: another key gets no link, and says so': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { seen, close } = await open({ master: KEY_B, helloMs: 5000 });
    try {
      if (seen.hello) return ['a link came up under a key the S3 does not hold'];
      return seen.statuses.some((s) => /pair/.test(s)) ? [] : [`no word about pairing in: ${seen.statuses.join(' | ')}`];
    } finally {
      await close();
    }
  },
  'pair again: the side key refuses, and the first key still works': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const bad = [];
    const offer = await open({ pairing: true });
    try {
      if (!offer.seen.hello) return [`no HELLO: ${offer.seen.statuses.join(' | ')}`];
      const answer = await pairWith(offer.link, offer.seen, KEY_B, SIDE, { manual: true });
      if (answer !== 'denied') bad.push(`the answer was ${answer}, wanted denied`);
    } finally {
      await offer.close();
    }
    const again = await open({ master: KEY_A });
    try {
      if (!again.seen.hello) bad.push('the first key no longer opens a link after a refused re-pair');
    } finally {
      await again.close();
    }
    return bad;
  },
  'adpcm: a 1.2 s take comes back as PCM, whole, with an EOS': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { link, seen, close } = await open({ master: KEY_A, adpcm: true });
    try {
      if (!seen.hello) return [`no sealed HELLO: ${seen.statuses.join(' | ')}`];
      await sleep(600); // the S3 is told to send ADPCM once the link is ready
      tap(link, FRONT, 1200);
      await waitFor(() => seen.takeEnds > 0, 4000);
      const bad = [];
      if (seen.takeEnds !== 1) bad.push(`${seen.takeEnds} EOS`);
      if (seen.takeFrames < 30) bad.push(`only ${seen.takeFrames} take frames for 1.2 s`);
      if (link.badAudioFrames) bad.push(`${link.badAudioFrames} audio frames the link could not decode`);
      return bad;
    } finally {
      await close();
    }
  },
};

let failed = 0;
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    let bad;
    try {
      bad = await run();
    } catch (err) {
      bad = [`threw: ${err.message}`];
    }
    if (bad.length === 0) console.log(`PASS ${name}`);
    else {
      failed++;
      console.log(`FAIL ${name}: ${bad.join('; ')}`);
    }
  }
} finally {
  if (paired) {
    // Leave the S3 as it was found: unpaired. It is paired now, so the person at the S3 presses the front key.
    const { link, seen, close } = await open({ pairing: true });
    try {
      const answer = seen.hello ? await pairWith(link, seen, null, FRONT, { manual: true }) : 'none';
      if (answer !== 'ok') {
        failed++;
        console.log(`FAIL cleanup: the S3 did not forget the gate's key (${answer}). Run: node bridge/bin/walkie.js pair --forget`);
      }
    } finally {
      await close();
    }
  }
}
console.log(failed === 0 ? 'gate P5: every scene held' : `gate P5: ${failed} scene(s) did not hold`);
process.exitCode = failed === 0 ? 0 : 1;
