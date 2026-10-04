// The S3's partition table (read from 0x8000), the layout walkie was designed for, and the only writes allowed.
export const EXPECTED = [
  { label: 'nvs', type: 1, subtype: 0x02, offset: 0x9000, size: 0x5000 },
  { label: 'otadata', type: 1, subtype: 0x00, offset: 0xe000, size: 0x2000 },
  { label: 'app0', type: 0, subtype: 0x10, offset: 0x10000, size: 0x330000 },
  { label: 'app1', type: 0, subtype: 0x11, offset: 0x340000, size: 0x330000 },
  { label: 'spiffs', type: 1, subtype: 0x82, offset: 0x670000, size: 0x180000 },
  { label: 'coredump', type: 1, subtype: 0x03, offset: 0x7f0000, size: 0x10000 },
];

export function parsePartitionTable(buf) {
  const entries = [];
  for (let off = 0; off + 32 <= buf.length; off += 32) {
    if (buf.readUInt16LE(off) !== 0x50aa) break; // 0xEBEB is the MD5 entry, 0xFFFF the end
    entries.push({
      label: buf.toString('ascii', off + 12, off + 28).replace(/\0.*$/s, ''),
      type: buf[off + 2],
      subtype: buf[off + 3],
      offset: buf.readUInt32LE(off + 4),
      size: buf.readUInt32LE(off + 8),
    });
  }
  return entries;
}

const show = (v) => (typeof v === 'number' ? `0x${v.toString(16)}` : v);

export function checkPartitionTable(entries) {
  const problems = [];
  if (entries.length !== EXPECTED.length) problems.push(`expected ${EXPECTED.length} partitions, found ${entries.length}`);
  EXPECTED.forEach((want, i) => {
    const got = entries[i];
    if (!got) return;
    for (const key of Object.keys(want)) {
      if (got[key] !== want[key]) problems.push(`${want.label}: ${key} is ${show(got[key])}, expected ${show(want[key])}`);
    }
  });
  return problems;
}

export function assertSafeWrites(writes) {
  for (const { addr, size } of writes) {
    const app1 = addr === 0x340000 && size > 0 && size <= 0x330000;
    const otadata = addr === 0xe000 && size === 0x2000;
    if (!app1 && !otadata) {
      throw new Error(`refusing to write ${size} bytes at 0x${addr.toString(16)}: walkie writes only app1 (0x340000) and otadata (0xe000)`);
    }
  }
}
