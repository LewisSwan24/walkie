// selftest: the S3 checks its own crypto against published vectors (RFC 5869 HKDF, NIST AES-GCM) and a sealed session, and says so in one
// LOG line. The firmware's adapter over mbedtls is the one part of the sealed link the host tests cannot reach; this is how it is checked
// on the chip. It reads and writes no pairing key.
import { TYPE } from '../link/frame.js';
import { testSelftestPayload } from '../link/messages.js';
import { connect } from './connect.js';

const ANSWER_TIMEOUT_MS = 5000;

// 0 when the S3 says `selftest ok`, 1 for a failed check or no answer. connectFn and say are injectable so tests never touch a port.
export async function selftest(args, opts, connectFn = connect, say = console.log) {
  const link = await connectFn(opts);
  let timer;
  try {
    const answer = new Promise((resolve) => {
      link.on('log', (line) => {
        if (String(line).startsWith('selftest')) resolve(String(line));
      });
    });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
    });
    link.send(TYPE.TEST, testSelftestPayload());
    const line = await Promise.race([answer, timeout]);
    if (line === null) {
      say('selftest: no answer from the S3 within 5 s (is it running firmware with the self-test?)');
      return 1;
    }
    say(line);
    return line.startsWith('selftest ok') ? 0 : 1;
  } finally {
    clearTimeout(timer);
    link.close();
  }
}

export default async function run(args, opts) {
  process.exitCode = await selftest(args, opts);
}
