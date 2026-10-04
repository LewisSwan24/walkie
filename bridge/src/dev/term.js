// A plain-text console that does not reset the S3: sends one line and prints what comes back.
// For on-the-beat's console; walkie itself only speaks frames.
import { findS3Port, openS3Port } from '../link/serial.js';

export default async function term(words, opts) {
  const path = opts.port ?? (await findS3Port());
  if (!path) throw new Error('no S3 on USB (303A:1001)');
  const port = await openS3Port(path);
  port.on('data', (b) => process.stdout.write(b.toString('utf8')));
  if (words.length > 0) port.write(`${words.join(' ')}\n`);
  await new Promise((r) => setTimeout(r, Number(opts.secs ?? 3) * 1000));
  await new Promise((r) => port.close(r));
}
