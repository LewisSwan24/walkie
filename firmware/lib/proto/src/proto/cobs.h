// cobs.h: Consistent Overhead Byte Stuffing (Cheshire and Baker). The encoded form contains no 0x00.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t COBS_ERROR = (size_t)-1;
// A safe capacity to give cobsEncode() for n bytes. The worst-case encoded length is n + n/254 + 1, and the
// scratch byte the encoder writes always lies within that length, so the extra byte here is only a margin.
inline size_t cobsMaxEncoded(size_t n) { return n + n / 254 + 2; }
// Returns the encoded length (no delimiter), or COBS_ERROR when cap < cobsMaxEncoded(n).
size_t cobsEncode(const uint8_t* in, size_t n, uint8_t* out, size_t cap);
// Returns the decoded length, or COBS_ERROR when the input is malformed or does not fit in cap.
size_t cobsDecode(const uint8_t* in, size_t n, uint8_t* out, size_t cap);
}  // namespace proto
