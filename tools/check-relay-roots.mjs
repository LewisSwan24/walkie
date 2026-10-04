// node tools/check-relay-roots.mjs <host>: connects to <host>:443 trusting only the roots in firmware/src/relay_roots.h, as the S3
// does, and says whether the relay's certificate checks out against them. Exit 0 when it does, 1 when it does not.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelayRoots, parseRootsHeader } from './lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.argv[2];
if (!host) {
  console.error('usage: node tools/check-relay-roots.mjs <relay host>');
  process.exit(2);
}
const ca = parseRootsHeader(readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8'));
const r = await checkRelayRoots(host, ca);
if (r.ok) console.log(`${host}: trusted by the pinned roots (${r.chain.join(' <- ')})`);
else console.error(`${host}: NOT trusted by the pinned roots, or not reached: ${r.error}`);
process.exitCode = r.ok ? 0 : 1;
