// Consistent Overhead Byte Stuffing (Cheshire and Baker): the encoded form contains no 0x00.

export function cobsEncode(data) {
  const out = new Uint8Array(data.length + Math.floor(data.length / 254) + 2);
  let enc = 1;
  let codep = 0;
  let code = 1;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b !== 0) {
      out[enc++] = b;
      code++;
    }
    if (b === 0 || code === 0xff) {
      out[codep] = code;
      code = 1;
      codep = enc;
      if (b === 0 || i < data.length - 1) enc++;
    }
  }
  out[codep] = code;
  return out.subarray(0, enc);
}

// Returns the decoded bytes, or null when the input is not valid COBS.
export function cobsDecode(enc) {
  const out = new Uint8Array(enc.length);
  let r = 0;
  let w = 0;
  while (r < enc.length) {
    const code = enc[r++];
    if (code === 0) return null;
    for (let i = 1; i < code; i++) {
      if (r >= enc.length || enc[r] === 0) return null;
      out[w++] = enc[r++];
    }
    if (code !== 0xff && r < enc.length) out[w++] = 0;
  }
  return out.subarray(0, w);
}
