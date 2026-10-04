// node tools/gen-relay-roots.mjs [<ca bundle>]: writes firmware/src/relay_roots.h from a CA bundle on this machine. The default is the
// certifi bundle in PlatformIO's own Python, which every machine that builds the firmware has; nothing is downloaded.
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickRoots, rootsHeader } from './lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = process.argv[2] ?? path.join(os.homedir(), '.platformio', 'penv', 'Lib', 'site-packages', 'certifi', 'cacert.pem');
const out = path.join(root, 'firmware', 'src', 'relay_roots.h');
try {
  const roots = pickRoots(readFileSync(bundle, 'utf8'));
  writeFileSync(out, rootsHeader(roots));
  for (const r of roots) console.log(`${r.label}  ${r.cert.fingerprint256}`);
  console.log(`wrote ${path.relative(root, out)}`);
} catch (e) {
  console.error(`gen-relay-roots: ${e.message}`);
  process.exit(1);
}
