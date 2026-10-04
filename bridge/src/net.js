// One NET request to the S3 (protocol/frames.md, "Network settings (plan 6)"): bring up a sealed link, send it, wait for the answer.
// The S3 takes NET only over a sealed link, so a pairing key is a must; the way to the S3 is whatever `openPort` gives (the cable, or
// the relay when the S3 is away from it).
import { TYPE } from './link/frame.js';
import { arrivesWithin, askOnce } from './link/exchange.js';
import { Link } from './link/link.js';
import { NET_OP, parseNetReply } from './link/messages.js';

// Resolves with { reply }: the S3's answer as parseNetReply() has it, or null when it said nothing within answerMs (the request may
// or may not have been taken). Rejects when there is no pairing key, or no walkie answers HELLO.
export async function runNet({
  openPort,
  master,
  request,
  helloMs = 10_000,
  answerMs = 10_000,
  makeNonce,
  retryMs = 1000,
  retryMaxMs = 30_000,
}) {
  if (!master) throw new Error('Wi-Fi and relay settings go to walkie sealed, so a pairing key comes first (node bridge/bin/walkie.js pair)');
  const op = request[0];
  const link = new Link({ openPort, master, retryMs, retryMaxMs, ...(makeNonce ? { makeNonce } : {}) });
  try {
    const up = arrivesWithin(link, 'hello', helloMs);
    await link.start();
    if (!(await up)) throw new Error(`no walkie answered within ${helloMs / 1000} s: is it plugged in and running walkie, or on Wi-Fi with a relay set?`);
    const pick = (payload) => {
      const reply = parseNetReply(payload);
      if (!reply) return null;
      return (reply.kind === 'list' ? op === NET_OP.WIFI_LIST : reply.answered === op) ? reply : null;
    };
    return { reply: await askOnce(link, TYPE.NET, request, pick, answerMs) };
  } finally {
    link.close();
  }
}
