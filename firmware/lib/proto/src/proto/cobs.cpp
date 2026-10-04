#include "proto/cobs.h"

namespace proto {
size_t cobsEncode(const uint8_t* in, size_t n, uint8_t* out, size_t cap) {
  if (cap < cobsMaxEncoded(n)) return COBS_ERROR;
  size_t enc = 1, codep = 0;
  uint8_t code = 1;
  for (size_t i = 0; i < n; i++) {
    uint8_t b = in[i];
    if (b) {
      out[enc++] = b;
      code++;
    }
    if (!b || code == 0xFF) {
      out[codep] = code;
      code = 1;
      codep = enc;
      if (!b || i + 1 < n) enc++;
    }
  }
  out[codep] = code;
  return enc;
}

size_t cobsDecode(const uint8_t* in, size_t n, uint8_t* out, size_t cap) {
  size_t r = 0, w = 0;
  while (r < n) {
    uint8_t code = in[r++];
    if (code == 0) return COBS_ERROR;
    for (uint8_t i = 1; i < code; i++) {
      if (r >= n || in[r] == 0 || w >= cap) return COBS_ERROR;
      out[w++] = in[r++];
    }
    if (code != 0xFF && r < n) {
      if (w >= cap) return COBS_ERROR;
      out[w++] = 0;
    }
  }
  return w;
}
}  // namespace proto
