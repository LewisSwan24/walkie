// Boot-slot selection (ESP-IDF otadata: two 4 KB sectors at 0xE000). The bootloader boots
// ota_{(seq - 1) % 2} for the highest valid ota_seq (spec §3).
import { crc32 } from 'node:zlib';

export const OTADATA_ADDR = 0xe000;
export const OTADATA_SIZE = 0x2000;

// ota_seq, 20 label bytes and 4 state bytes left at 0xFF, then crc32(ota_seq) started from 0xFFFFFFFF.
export function otaEntry(seq) {
  const e = Buffer.alloc(32, 0xff);
  e.writeUInt32LE(seq, 0);
  e.writeUInt32LE(crc32(e.subarray(0, 4), 0xffffffff), 28);
  return e;
}

// app0 is exactly what the S3 held before walkie (sector 0 seq 1, sector 1 seq 0);
// app1 keeps sector 0 and puts seq 2 in sector 1.
export function otadataImage(slot) {
  if (slot !== 'app0' && slot !== 'app1') throw new Error(`unknown slot ${slot}`);
  const img = Buffer.alloc(OTADATA_SIZE, 0xff);
  otaEntry(1).copy(img, 0);
  otaEntry(slot === 'app0' ? 0 : 2).copy(img, 0x1000);
  return img;
}
