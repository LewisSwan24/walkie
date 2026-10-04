// Gate L: walkie through the deployed relay, before any S3 goes near it (tools/lib/gate-l.mjs says what each scene checks). First it
// checks that the relay's certificate is one the S3 will trust (the pinned roots in firmware/src/relay_roots.h), then it runs a stand-in
// S3 and a PC through the relay with a throwaway key. No COM port, no API, no pair.key; deploying the relay is not part of it.
// Usage: node tools/gate-l.mjs [--host <relay host>] [--hold <seconds>]   (the host defaults to the one `walkie relay` saved)
// Exit code 0 when every scene held, 1 when one did not, 2 for a usage error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelayHost } from '../bridge/src/config/relay.js';
import { runGateL } from './lib/gate-l.mjs';
import { checkRelayRoots, parseRootsHeader } from './lib/roots.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const host = flag('--host') ?? loadRelayHost();
const hold = Number(flag('--hold') ?? 75);
if (!host || !Number.isFinite(hold) || hold <= 0) {
  console.error('usage: node tools/gate-l.mjs [--host <relay host>] [--hold <seconds>]  (no --host: run `walkie relay <host>` first)');
  process.exit(2);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)) {
  const ca = parseRootsHeader(readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8'));
  const r = await checkRelayRoots(host, ca);
  console.log(r.ok ? `PASS the S3 will trust ${host} (${r.chain.join(' <- ')})` : `FAIL the S3 will trust ${host} (${r.error})`);
  if (!r.ok) process.exitCode = 1;
}
// process.exitCode, never process.exit(): exiting with WebSocket handles still closing aborts Node on Windows (libuv async.c).
if (process.exitCode !== 1) {
  const ok = await runGateL({ host, holdMs: hold * 1000 });
  console.log(ok ? 'gate L: every scene held' : 'gate L: a scene did not hold');
  process.exitCode = ok ? 0 : 1;
}
