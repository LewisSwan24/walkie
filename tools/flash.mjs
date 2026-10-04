// Builds the walkie firmware, writes it to app1 and selects app1. Never touches app0 (on-the-beat).
// Usage: node tools/flash.mjs [--port COMx] [--skip-build]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIO, esptool, parseArgs } from './lib/esptool.mjs';
import { verifyLayout } from './lib/device.mjs';
import { OTADATA_ADDR, otadataImage } from './lib/otadata.mjs';
import { writeFlashArgs } from './lib/writeflash.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const image = path.join(root, 'firmware', '.pio', 'build', 'sticks3', 'firmware.bin');

if (!opts.skipBuild) {
  const b = spawnSync(PIO, ['run', '-d', path.join(root, 'firmware'), '-e', 'sticks3'], { stdio: 'inherit' });
  if (b.error || b.status !== 0) {
    console.error('The build failed; nothing was written.');
    process.exit(1);
  }
}
if (!existsSync(image)) {
  console.error(`No firmware image at ${image}.`);
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'walkie-flash-'));
try {
  const size = statSync(image).size;
  const ota = path.join(dir, 'otadata-app1.bin');
  writeFileSync(ota, otadataImage('app1'));
  const args = writeFlashArgs([{ addr: 0x340000, file: image }, { addr: OTADATA_ADDR, file: ota }]);
  verifyLayout(opts.port, dir);
  esptool(opts.port, args);
  console.log(`walkie (${size} bytes) is in app1 and selected; the S3 is restarting into it.`);
  console.log('Back to on-the-beat: node tools/boot.mjs app0');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
