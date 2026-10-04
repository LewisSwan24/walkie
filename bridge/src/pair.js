// `walkie pair` and `walkie pair --forget` (protocol/frames.md, "Pairing"). Pairing happens over the cable: this PC offers a key, the
// person presses the front key on walkie to accept (the side key, or 30 s of nothing, refuses), and only when walkie has said OK does
// the key become this PC's. The key is never printed.
import { randomBytes } from 'node:crypto';
import {
  commitPairKey, defaultPairKeyFile, discardPairCandidate, forgetPairKey, loadPairCandidate, writePairCandidate,
} from './config/pairkey.js';
import { arrivesWithin } from './link/exchange.js';
import { TYPE } from './link/frame.js';
import { Link } from './link/link.js';
import { PAIR_OP, pairForgetPayload, pairSetPayload, parsePairReply } from './link/messages.js';

// The walkie gives up on its confirm screen 30 s after it opened it, a few ms after the first SET, so no repeat may fall within a second
// of that (a repeat after its DENIED opens the screen again for a key no PC waits to keep). 3.5 s puts repeats at 28 s and 31.5 s.
export const RESEND_MS = 3500;

// Sends `payload` every `resendMs` until walkie answers that very op (a repeated request changes nothing on walkie), or null after `answerMs`.
function ask(link, op, payload, { resendMs, answerMs }) {
  return new Promise((resolve) => {
    let resend;
    let giveUp;
    const finish = (reply) => {
      clearInterval(resend);
      clearTimeout(giveUp);
      link.off('frame', onFrame);
      resolve(reply);
    };
    const onFrame = (f) => {
      if (f.type !== TYPE.PAIR) return;
      const reply = parsePairReply(f.payload);
      if (reply && reply.answered === op) finish(reply);
    };
    link.on('frame', onFrame);
    resend = setInterval(() => link.send(TYPE.PAIR, payload), resendMs);
    giveUp = setTimeout(() => finish(null), answerMs);
    link.send(TYPE.PAIR, payload);
  });
}

// Resolves with { outcome }: 'paired', 'forgotten', 'denied', 'no-answer' or 'unverified' (walkie took the key but a sealed link with it
// did not come up). Rejects when no walkie answers HELLO at all. Everything the person should read goes through `say`.
export async function runPair({
  openPort,
  forget = false,
  file = defaultPairKeyFile(),
  say = console.log,
  makeKey = () => randomBytes(32),
  makeNonce,
  helloMs = 10_000,
  answerMs = 40_000,
  resendMs = RESEND_MS,
  verifyMs = 5000,
  retryMs = 1000,
}) {
  if (!file) throw new Error('there is nowhere to keep a pairing key: %APPDATA% is not set');
  const linkOptions = { openPort, retryMs, ...(makeNonce ? { makeNonce } : {}) };
  const link = new Link({ ...linkOptions, pairing: true });
  link.on('status', (s) => say(`[link] ${s}`));
  let reply;
  let key = null;
  try {
    const up = arrivesWithin(link, 'hello', helloMs);
    await link.start();
    if (!(await up)) throw new Error(`no walkie answered within ${helloMs / 1000} s: is it plugged in and running walkie?`);
    if (forget) {
      say('Press the front key on walkie to let it forget this PC (the side key refuses).');
    } else {
      try {
        key = loadPairCandidate({ file }); // an earlier attempt that never heard back: the same key again
      } catch {
        discardPairCandidate({ file });
      }
      key ??= makeKey();
      writePairCandidate(key, { file });
      say('Press the front key on walkie to accept this PC (the side key refuses). walkie waits 30 s.');
    }
    const op = forget ? PAIR_OP.FORGET : PAIR_OP.SET;
    reply = await ask(link, op, forget ? pairForgetPayload() : pairSetPayload(key), { resendMs, answerMs });
  } finally {
    link.close();
  }
  if (reply === null) {
    say(`No answer from walkie. Run \`walkie pair${forget ? ' --forget' : ''}\` again${forget ? '' : ': the same key is offered again, so a key walkie did take is not lost'}.`);
    return { outcome: 'no-answer' };
  }
  if (reply.op === PAIR_OP.DENIED) {
    if (!forget) discardPairCandidate({ file });
    say('walkie refused: the side key was pressed, or 30 s went by. Nothing changed.');
    return { outcome: 'denied' };
  }
  if (forget) {
    forgetPairKey({ file });
    say('walkie no longer holds a pairing key, and this PC has let go of its key.');
    return { outcome: 'forgotten' };
  }
  commitPairKey({ file });
  const sealed = new Link({ ...linkOptions, master: key });
  try {
    const up = arrivesWithin(sealed, 'hello', verifyMs);
    await sealed.start();
    if (await up) {
      say('Paired. A sealed link to walkie came up with the new key: verified.');
      return { outcome: 'paired' };
    }
  } finally {
    sealed.close();
  }
  say('walkie accepted the key, but a sealed link with it did not come up. Run `walkie pair` again.');
  return { outcome: 'unverified' };
}
