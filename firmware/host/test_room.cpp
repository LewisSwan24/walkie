// test_room.cpp: the room id (protocol/frames.md, "Relay") against protocol/seal-vectors.json, which the bridge's tests pass as well.
#include <string.h>
#include "check.h"
#include "proto/room.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
bool failingHkdf(const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, size_t, uint8_t*, size_t) { return false; }
// An HKDF that has written part of the key when it fails.
bool halfwayHkdf(const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, size_t, uint8_t* okm, size_t okmLen) {
  memset(okm, 0xaa, okmLen / 2);
  return false;
}
std::string zeros() { return std::string(32, '0'); }
}  // namespace

TEST(roomEachVectorKeyHasTheVectorsRoom) {
  CHECK(strcmp(kRoomInfo, "walkie-room-v1") == 0, "the info string is the one the vectors name");
  for (const RoomVec& r : kRooms) {
    std::vector<uint8_t> master = unhex(r.master);
    uint8_t id[proto::ROOM_BYTES];
    CHECK(proto::roomId(refCrypto(), master.data(), id), "derived");
    CHECK(tohex(id, sizeof id) == r.id, r.id);
    char text[proto::ROOM_HEX_BYTES];
    proto::roomIdHex(id, text);
    CHECK(strcmp(text, r.id) == 0, "as hex it is the vector's text");
  }
}

TEST(roomAnHkdfThatFailsGivesNoRoom) {
  proto::Crypto c = refCrypto();
  c.hkdf = failingHkdf;
  std::vector<uint8_t> master = unhex(kRooms[0].master);
  uint8_t id[proto::ROOM_BYTES];
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "failed");
  CHECK(tohex(id, sizeof id) == zeros(), "and nothing is left in the output");
  c.hkdf = halfwayHkdf;
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "failed halfway");
  CHECK(tohex(id, sizeof id) == zeros(), "and the half that was written is wiped");
  c.hkdf = nullptr;
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "no HKDF at all");
  CHECK(tohex(id, sizeof id) == zeros(), "nothing in the output");
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(refCrypto(), nullptr, id), "no key");
  CHECK(tohex(id, sizeof id) == zeros(), "nothing in the output");
}

TEST(roomHexIsLowerCaseAndTerminated) {
  uint8_t id[proto::ROOM_BYTES];
  for (size_t i = 0; i < sizeof id; i++) id[i] = (uint8_t)(0xa0 + i * 0x0b);
  char text[proto::ROOM_HEX_BYTES];
  memset(text, 'x', sizeof text);
  proto::roomIdHex(id, text);
  CHECK(strlen(text) == 32, "32 characters");
  CHECK(std::string(text) == tohex(id, sizeof id), "the same digits as the helper's, lower case");
}
