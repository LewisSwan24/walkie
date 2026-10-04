// Runs PlatformIO's esptool (on this machine pyserial and esptool live only in PlatformIO's Python).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isMadeByWriteFlashArgs } from './writeflash.mjs';

const pioHome = process.env.PLATFORMIO_CORE_DIR ?? path.join(os.homedir(), '.platformio');
export const PYTHON = path.join(pioHome, 'penv', 'Scripts', 'python.exe');
export const ESPTOOL = path.join(pioHome, 'packages', 'tool-esptoolpy', 'esptool.py');
export const PIO = path.join(pioHome, 'penv', 'Scripts', 'pio.exe');

// verifyLayout's partition-table read: the only argv esptool may run that writeFlashArgs did not build.
const READ_ONLY = ['--before', 'default_reset', '--after', 'hard_reset', 'read_flash'];
const isReadOnly = (args) =>
  Array.isArray(args) && args.length === 8 && READ_ONLY.every((a, i) => args[i] === a) && args.slice(5).every((a) => typeof a === 'string');

// Refuses before spawning, so a hand-written write_flash or erase_flash can never reach the S3.
export function esptool(port, args) {
  if (typeof port !== 'string' || !/^COM\d+$/i.test(port)) throw new Error(`refusing to run esptool on port ${port}: expected COMn`);
  if (!isMadeByWriteFlashArgs(args) && !isReadOnly(args)) {
    throw new Error('refusing to run esptool: the arguments are neither from writeFlashArgs nor the partition-table read');
  }
  const r = spawnSync(PYTHON, [ESPTOOL, '--chip', 'esp32s3', '--port', port, ...args], { stdio: 'inherit' });
  if (r.error) throw new Error(`could not start esptool: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`esptool failed (exit ${r.status})`);
}

// --port COMx or --port=COMx (default WALKIE_PORT, else COM8) and --skip-build; positional arguments come back in rest.
// Throws on a missing port value or an unknown option, so a typo never falls back to the default port.
export function parseArgs(argv) {
  const opts = { port: process.env.WALKIE_PORT ?? 'COM8', skipBuild: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) throw new Error('--port needs a value, e.g. --port COM8');
      opts.port = v;
      i++;
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      if (v === '') throw new Error('--port= needs a value, e.g. --port=COM8');
      opts.port = v;
    } else if (a === '--skip-build') opts.skipBuild = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else opts.rest.push(a);
  }
  return opts;
}
