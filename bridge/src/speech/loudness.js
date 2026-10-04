// The loudness chain for spoken replies (spec 6.5): high-pass, feed-forward compressor, constant makeup gain,
// lookahead limiter. It works on a stream: PCM16 little-endian mono in any chunk sizes (a chunk may even split
// a sample), whole samples out. The limiter delays the audio by `lookaheadMs`; flush() returns that tail.

export const DEFAULT_LOUDNESS = {
  highpassHz: 300,
  thresholdDb: -34,
  ratio: 12,
  attackMs: 1,
  releaseMs: 40,
  makeupDb: 27.5, // calibrated on the Stage 0 marin sample: RMS 7526, peak 32113 (the offline chain gave 7561 and 32000)
  ceiling: 0.98,
  lookaheadMs: 5,
};

const FULL_SCALE = 32768;

export class LoudnessChain {
  #rate;
  #s;
  // high-pass biquad
  #b0; #b1; #b2; #a1; #a2;
  #x1 = 0; #x2 = 0; #y1 = 0; #y2 = 0;
  // compressor
  #atk; #rel; #env = 0; #makeup;
  // limiter: delay line, needed-gain window, and its moving average
  #ceilingAbs;
  #len; // window length in samples; the audio is delayed by len - 1
  #delay; #need; #avg; #pos = 0; #avgSum;
  #seen = 0; // samples pushed so far
  #carry = null; // a dangling odd byte between chunks

  constructor(settings = {}, rate = 24000) {
    this.#rate = rate;
    this.#s = { ...DEFAULT_LOUDNESS, ...settings };
    const s = this.#s;
    const w0 = (2 * Math.PI * s.highpassHz) / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const c = Math.cos(w0);
    const a0 = 1 + alpha;
    this.#b0 = (1 + c) / 2 / a0;
    this.#b1 = -(1 + c) / a0;
    this.#b2 = this.#b0;
    this.#a1 = (-2 * c) / a0;
    this.#a2 = (1 - alpha) / a0;
    this.#atk = Math.exp(-1 / ((s.attackMs / 1000) * rate));
    this.#rel = Math.exp(-1 / ((s.releaseMs / 1000) * rate));
    this.#makeup = 10 ** (s.makeupDb / 20);
    this.#ceilingAbs = s.ceiling * FULL_SCALE;
    this.#len = Math.max(1, Math.round((s.lookaheadMs / 1000) * rate));
    this.#delay = new Float64Array(this.#len);
    this.#need = new Float64Array(this.#len).fill(1);
    this.#avg = new Float64Array(this.#len).fill(1);
    this.#avgSum = this.#len;
  }

  // One sample through the chain. Returns the delayed, limited sample, or null while the delay line fills.
  #step(x) {
    const s = this.#s;
    // high-pass (direct form 1)
    const hp = this.#b0 * x + this.#b1 * this.#x1 + this.#b2 * this.#x2 - this.#a1 * this.#y1 - this.#a2 * this.#y2;
    this.#x2 = this.#x1;
    this.#x1 = x;
    this.#y2 = this.#y1;
    this.#y1 = hp;
    // compressor: a peak envelope with separate attack and release, gain computed in dB
    const a = Math.abs(hp) / FULL_SCALE;
    const k = a > this.#env ? this.#atk : this.#rel;
    this.#env = k * this.#env + (1 - k) * a;
    const levelDb = this.#env > 1e-6 ? 20 * Math.log10(this.#env) : -120;
    const over = levelDb - s.thresholdDb;
    const gain = over > 0 ? 10 ** ((-over * (1 - 1 / s.ratio)) / 20) : 1;
    const y = hp * gain * this.#makeup;
    // limiter: the gain each sample needs, its minimum over the window, then the average of that minimum,
    // so the gain is already down when the sample that needs it leaves the delay line
    const p = this.#pos;
    const ay = Math.abs(y);
    this.#need[p] = ay > this.#ceilingAbs ? this.#ceilingAbs / ay : 1;
    let min = 1;
    for (let i = 0; i < this.#len; i++) if (this.#need[i] < min) min = this.#need[i];
    this.#avgSum += min - this.#avg[p];
    this.#avg[p] = min;
    this.#delay[p] = y;
    const out = this.#delay[(p + 1) % this.#len] * (this.#avgSum / this.#len); // the sample pushed len - 1 steps ago
    this.#pos = (p + 1) % this.#len;
    this.#seen++;
    return this.#seen >= this.#len ? out : null;
  }

  #toBytes(samples) {
    const b = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), i * 2);
    }
    return b;
  }

  push(chunk) {
    let buf = chunk;
    if (this.#carry !== null) {
      buf = Buffer.concat([Buffer.from([this.#carry]), chunk]);
      this.#carry = null;
    }
    if (buf.length % 2 === 1) {
      this.#carry = buf[buf.length - 1];
      buf = buf.subarray(0, buf.length - 1);
    }
    const out = [];
    for (let i = 0; i < buf.length; i += 2) {
      const v = this.#step(buf.readInt16LE(i));
      if (v !== null) out.push(v);
    }
    return this.#toBytes(out);
  }

  // The samples still inside the limiter's delay line. A dangling odd byte is dropped.
  flush() {
    const out = [];
    for (let i = 0; i < this.#len - 1; i++) {
      const v = this.#step(0);
      if (v !== null) out.push(v);
    }
    this.#carry = null;
    return this.#toBytes(out);
  }
}

// The same chain over a whole buffer (offline calibration and tests).
export function processAll(pcm, settings, rate = 24000) {
  const chain = new LoudnessChain(settings, rate);
  return Buffer.concat([chain.push(pcm), chain.flush()]);
}

// The chain over an async stream of PCM16 chunks.
export async function* applyLoudness(source, settings, rate = 24000) {
  const chain = new LoudnessChain(settings, rate);
  for await (const chunk of source) {
    const out = chain.push(chunk);
    if (out.length > 0) yield out;
  }
  const tail = chain.flush();
  if (tail.length > 0) yield tail;
}
