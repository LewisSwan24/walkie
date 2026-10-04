// PCM16 mono WAV files and simple level measurements.

export function encodeWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Peak, RMS and share of clipped samples of the measurement window: the first skipMs (the mic's
// start-up transient at gate open) and the last tailSkipMs (the talk-key release click, gain-
// independent, observed 26-51 ms before the end of takes) left out. durationMs stays the full take.
export function levels(pcm, rate, skipMs = 0, tailSkipMs = 0) {
  const total = pcm.length >> 1;
  const start = Math.min(total, Math.round((rate * skipMs) / 1000));
  const end = Math.max(start, total - Math.round((rate * tailSkipMs) / 1000));
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = start; i < end; i++) {
    const v = pcm.readInt16LE(i * 2);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (a >= 32700) clipped++;
  }
  const n = end - start;
  return {
    durationMs: Math.round((total * 1000) / rate),
    peak,
    rms: n ? Math.round(Math.sqrt(sum / n)) : 0,
    clippedPct: n ? (clipped * 100) / n : 0,
  };
}

// Reads a PCM16 mono WAV. The fmt and data chunks are found wherever they sit (LIST and other chunks are skipped),
// and a data chunk that claims more than the file holds (streamed WAVs say 0xFFFFFFFF) ends at the end of the file.
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('the WAV fmt chunk is too short');
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('the WAV has its data before its fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1) {
        throw new Error(`need PCM16 mono, got format ${fmt.format}, ${fmt.bits} bits, ${fmt.channels} channels`);
      }
      const end = Math.min(buf.length, body + size);
      return { rate: fmt.rate, pcm: buf.subarray(body, end - ((end - body) % 2)) };
    }
    pos = body + size + (size % 2); // chunks are padded to an even size
  }
  throw new Error('the WAV has no data chunk');
}
