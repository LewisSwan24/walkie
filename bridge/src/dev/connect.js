// Shared by the dev commands: find and open the S3, and wait for walkie's HELLO.
import { Link } from '../link/link.js';
import { findS3Port, openS3Port } from '../link/serial.js';

export function portOpener(portPath) {
  return async () => {
    const path = portPath ?? (await findS3Port());
    if (!path) throw new Error('no S3 on USB (303A:1001)');
    return openS3Port(path);
  };
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function connect(opts) {
  // `opts.master` is the pairing key, which bin/walkie-dev.js loads: this file reads no key of its own, so that a test never finds the
  // real one.
  const link = new Link({ openPort: portOpener(opts.port), master: opts.master ?? null, adpcm: opts.codec === 'adpcm' });
  link.on('status', (s) => console.log(`[link] ${s}`));
  link.on('log', (s) => console.log(`[S3] ${s}`));
  link.on('down', (r) => console.log(`[link] down: ${r}`));
  const hello = new Promise((resolve) => link.once('hello', resolve));
  await link.start();
  const h = await withTimeout(hello, 5000, 'no HELLO from walkie within 5 s. Is the S3 running walkie? (node tools/boot.mjs app1)');
  console.log(`[link] walkie ${h.version}: up ${(h.uptimeMs / 1000).toFixed(1)} s, ring ${h.ringBytes} bytes, ${h.upRate}/${h.downRate} Hz`);
  return link;
}
