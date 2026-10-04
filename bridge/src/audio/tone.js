// A sine tone as PCM16 mono, for playback tests.
export function tone(hz, secs, amplitude = 2000, rate = 24000) {
  const n = Math.round(rate * secs);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
}
