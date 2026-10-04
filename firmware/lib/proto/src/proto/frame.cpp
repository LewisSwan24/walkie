#include "proto/frame.h"
#include <string.h>
#include "proto/cobs.h"
#include "proto/crc.h"

namespace proto {
namespace {
void put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
uint16_t get16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
}  // namespace

size_t encodeEnvelope(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out, size_t cap) {
  if (len > MAX_PAYLOAD || cap < (size_t)len + 8) return 0;
  out[0] = type;
  out[1] = flags;
  put16(out + 2, seq);
  put16(out + 4, len);
  if (len) memcpy(out + 6, payload, len);
  put16(out + 6 + len, crc16(out, 6 + (size_t)len));
  return (size_t)len + 8;
}

size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
                   size_t cap) {
  if (len > MAX_PAYLOAD) return 0;
  size_t n = (size_t)len + 8;
  if (cap < 2 + cobsMaxEncoded(n)) return 0;
  uint8_t env[ENVELOPE_MAX];
  encodeEnvelope(type, flags, seq, payload, len, env, sizeof env);
  out[0] = 0;
  size_t m = cobsEncode(env, n, out + 1, cap - 2);
  if (m == COBS_ERROR) return 0;
  out[1 + m] = 0;
  return m + 2;
}

bool parseEnvelope(const uint8_t* env, size_t n, Frame& f) {
  if (n < 8) return false;
  uint16_t len = get16(env + 4);
  if (len > MAX_PAYLOAD || (size_t)len != n - 8) return false;
  if (get16(env + 6 + len) != crc16(env, 6 + (size_t)len)) return false;
  f.type = env[0];
  f.flags = env[1];
  f.seq = get16(env + 2);
  f.len = len;
  f.payload = env + 6;
  return true;
}

bool FrameDecoder::finish(Frame& f) {
  size_t n = cobsDecode(chunk_, len_, env_, sizeof env_);
  return n != COBS_ERROR && parseEnvelope(env_, n, f);
}
}  // namespace proto
