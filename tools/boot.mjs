// Chooses which app the S3 boots: app0 is on-the-beat, app1 is walkie. Writes only otadata (0xE000).
// Usage: node tools/boot.mjs app0|app1 [--port COMx]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { esptool, parseArgs } from './lib/esptool.mjs';
import { verifyLayout } from './lib/device.mjs';
import { OTADATA_ADDR, otadataImage } from './lib/otadata.mjs';
import { writeFlashArgs } from './lib/writeflash.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const slot = opts.rest[0];
if (slot !== 'app0' && slot !== 'app1') {
  console.error('usage: node tools/boot.mjs app0|app1 [--port COMx]');
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'walkie-boot-'));
try {
  const file = path.join(dir, `otadata-${slot}.bin`);
  writeFileSync(file, otadataImage(slot));
  const args = writeFlashArgs([{ addr: OTADATA_ADDR, file }]);
  verifyLayout(opts.port, dir);
  esptool(opts.port, args);
  console.log(slot === 'app0' ? 'The S3 is restarting into app0 (on-the-beat).' : 'The S3 is restarting into app1 (walkie).');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
