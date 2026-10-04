// Sends one CMD and prints the S3's LOG answer.
// The answer can lag: boot-app0 acks only after the otadata flash write, and sector
// erase time varies (seen on the board: 48-485 ms, and twice past the old fixed 600 ms
// window, so the port closed first and the answer was lost). Wait for the first LOG,
// or the link going down (the restart beat the answer), or 3 s.
import { parseCmdArgs } from './cmd-args.js';
import { connect } from './connect.js';

const ACK_TIMEOUT_MS = 3000;

// connectFn is injectable so tests never touch a real serial port.
export default async function cmd(args, opts, connectFn = connect) {
  const { op, arg } = parseCmdArgs(args);
  const link = await connectFn(opts);
  const answered = new Promise((resolve) => {
    link.once('log', resolve);
    link.once('down', resolve);
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ACK_TIMEOUT_MS);
  });
  link.cmd(op, arg);
  try {
    await Promise.race([answered, timeout]);
  } finally {
    clearTimeout(timer);
    link.close();
  }
}
