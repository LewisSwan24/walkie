// room.h: the room a device meets its PC in at the relay (protocol/frames.md, "Relay"). The same 16 bytes as bridge/src/link/room.js,
// checked against protocol/seal-vectors.json: HKDF-SHA256 of the pairing key with an empty salt and the info "walkie-room-v1".
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"

namespace proto {
const size_t ROOM_BYTES = 16;
const size_t ROOM_HEX_BYTES = ROOM_BYTES * 2 + 1;  // lower-case hex and the terminating NUL

// Writes ROOM_BYTES to out from the KEY_BYTES-byte master key. False when c has no HKDF or it fails (out is then zeroed).
bool roomId(const Crypto& c, const uint8_t* master, uint8_t* out);

// The id as lower-case hex with a terminating NUL (ROOM_HEX_BYTES bytes), the form the relay's path wants.
void roomIdHex(const uint8_t* id, char* out);
}  // namespace proto
