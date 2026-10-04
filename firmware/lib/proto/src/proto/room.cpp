// room.cpp: see room.h.
#include "proto/room.h"
#include <string.h>

namespace proto {
bool roomId(const Crypto& c, const uint8_t* master, uint8_t* out) {
  static const uint8_t info[] = {'w', 'a', 'l', 'k', 'i', 'e', '-', 'r', 'o', 'o', 'm', '-', 'v', '1'};
  memset(out, 0, ROOM_BYTES);
  if (!c.hkdf || !master) return false;
  if (!c.hkdf(master, KEY_BYTES, nullptr, 0, info, sizeof info, out, ROOM_BYTES)) {
    memset(out, 0, ROOM_BYTES);
    return false;
  }
  return true;
}

void roomIdHex(const uint8_t* id, char* out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < ROOM_BYTES; i++) {
    out[2 * i] = digits[id[i] >> 4];
    out[2 * i + 1] = digits[id[i] & 15];
  }
  out[2 * ROOM_BYTES] = 0;
}
}  // namespace proto
