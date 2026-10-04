// Reads the S3's partition table and stops unless it is the layout walkie was designed for.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { esptool } from './esptool.mjs';
import { checkPartitionTable, parsePartitionTable } from './partitions.mjs';

export function verifyLayout(port, dir) {
  const file = path.join(dir, 'partitions.bin');
  esptool(port, ['--before', 'default_reset', '--after', 'hard_reset', 'read_flash', '0x8000', '0xc00', file]);
  const problems = checkPartitionTable(parsePartitionTable(readFileSync(file)));
  if (problems.length > 0) {
    throw new Error(`The S3's partition table is not the one walkie expects, so nothing was written:\n  ${problems.join('\n  ')}`);
  }
}
