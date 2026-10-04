import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { assertSafeWrites } from './partitions.mjs';

const made = new WeakSet();
export const isMadeByWriteFlashArgs = (argv) => made.has(argv);

// The app1 image must be an ESP32-S3 app image: magic 0xE9 at byte 0, chip id 9 (uint16 LE) at byte 12.
export function assertAppImage(file) {
  const fd = openSync(file, 'r');
  const head = Buffer.alloc(16);
  try { readSync(fd, head, 0, 16, 0); } finally { closeSync(fd); }
  if (head[0] !== 0xe9) throw new Error(`${file} is not an ESP image (first byte 0x${head[0].toString(16)}, expected 0xe9)`);
  if (head.readUInt16LE(12) !== 9) throw new Error(`${file} is not an ESP32-S3 image (chip id ${head.readUInt16LE(12)}, expected 9)`);
}

// writes: [{ addr, file }]. Sizes are read from the files, so the check binds the bytes esptool will write.
export function writeFlashArgs(writes) {
  const sized = writes.map(({ addr, file }) => ({ addr, file, size: statSync(file).size }));
  assertSafeWrites(sized);
  for (const w of sized) if (w.addr === 0x340000) assertAppImage(w.file);
  const argv = ['--before', 'default_reset', '--after', 'hard_reset', 'write_flash', ...sized.flatMap((w) => ['0x' + w.addr.toString(16), w.file])];
  made.add(argv);
  return argv;
}
