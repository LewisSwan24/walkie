// The uplink test pattern (protocol/frames.md, TEST UP_PATTERN): sample k is (k * 1103 + 12345) mod 65536, u16 LE.
export function patternBytes(firstSample, samples) {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeUInt16LE(((firstSample + i) * 1103 + 12345) & 0xffff, i * 2);
  return b;
}
