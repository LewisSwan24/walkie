// IMA-ADPCM, 4 bits a sample (protocol/frames.md, "Audio codec"). A frame is self-contained: a 4-byte header (sample 0 as s16,
// the step index in effect for sample 1, a pad flag), then the nibbles of samples 1 to n-1, the first one in the low half
// of a byte. Integer arithmetic only, so every implementation decodes to the same bits.
export const STEP_TABLE = Object.freeze([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
  9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);
export const INDEX_TABLE = Object.freeze([-1, -1, -1, -1, 2, 4, 6, 8]);
export const HEADER_BYTES = 4;
const MAX_INDEX = 88;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The change in the predictor that a nibble stands for, with the step it was coded at.
function delta(nibble, step) {
  let d = step >> 3;
  if (nibble & 4) d += step;
  if (nibble & 2) d += step >> 1;
  if (nibble & 1) d += step >> 2;
  return nibble & 8 ? -d : d;
}

// `pcm`: PCM16 little endian, at least one sample. `index`: the step index to start from. Returns { frame, index }, where
// index is the one to start the next frame from.
export function encodeAdpcm(pcm, index) {
  if (pcm.length < 2 || pcm.length % 2) throw new RangeError('ADPCM needs whole PCM16 samples, at least one');
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new RangeError(`step index must be 0..${MAX_INDEX}, not ${index}`);
  const n = pcm.length / 2;
  const nibbles = [];
  let pred = pcm.readInt16LE(0);
  let idx = index;
  for (let i = 1; i < n; i++) {
    const step = STEP_TABLE[idx];
    let diff = pcm.readInt16LE(i * 2) - pred;
    let nib = 0;
    if (diff < 0) {
      nib = 8;
      diff = -diff;
    }
    if (diff >= step) {
      nib |= 4;
      diff -= step;
    }
    if (diff >= step >> 1) {
      nib |= 2;
      diff -= step >> 1;
    }
    if (diff >= step >> 2) nib |= 1;
    pred = clamp(pred + delta(nib, step), -32768, 32767);
    idx = clamp(idx + INDEX_TABLE[nib & 7], 0, MAX_INDEX);
    nibbles.push(nib);
  }
  const pad = nibbles.length % 2;
  if (pad) nibbles.push(0);
  const frame = Buffer.alloc(HEADER_BYTES + nibbles.length / 2);
  frame.writeInt16LE(pcm.readInt16LE(0), 0);
  frame[2] = index;
  frame[3] = pad;
  for (let i = 0; i < nibbles.length; i += 2) frame[HEADER_BYTES + i / 2] = nibbles[i] | (nibbles[i + 1] << 4);
  return { frame, index: idx };
}

// PCM16 little endian, or null when the frame cannot be one: shorter than its header, an index above 88, a pad flag that is
// not 0 or 1, or padding with no nibble to pad.
export function decodeAdpcm(frame) {
  if (frame.length < HEADER_BYTES) return null;
  const index = frame[2];
  const pad = frame[3];
  if (index > MAX_INDEX || pad > 1 || (pad === 1 && frame.length === HEADER_BYTES)) return null;
  const count = 1 + (frame.length - HEADER_BYTES) * 2 - pad;
  const out = Buffer.alloc(count * 2);
  let pred = frame.readInt16LE(0);
  let idx = index;
  out.writeInt16LE(pred, 0);
  for (let i = 1; i < count; i++) {
    const byte = frame[HEADER_BYTES + ((i - 1) >> 1)];
    const nib = (i - 1) & 1 ? byte >> 4 : byte & 15;
    pred = clamp(pred + delta(nib, STEP_TABLE[idx]), -32768, 32767);
    idx = clamp(idx + INDEX_TABLE[nib & 7], 0, MAX_INDEX);
    out.writeInt16LE(pred, i * 2);
  }
  return out;
}
