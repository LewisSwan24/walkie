// session.h: sealed frames (protocol/frames.md, "Sealed frames"). One Session holds the two direction keys derived from the paired
// master key and both nonces of a HELLO, the send counter and the highest counter accepted so far. It is the same logic as
// bridge/src/link/session.js, and both are checked against protocol/seal-vectors.json.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"
#include "proto/frame.h"

namespace proto {
const uint8_t F_SEALED = 0x80;              // flags bit 7: the payload is counter | ciphertext | tag
const size_t SEAL_OVERHEAD = 4 + GCM_TAG_BYTES;  // counter u32 LE plus the tag
const size_t MAX_PLAIN = MAX_PAYLOAD - SEAL_OVERHEAD;

enum Role : uint8_t { ROLE_PC = 1, ROLE_S3 = 2 };

class Session {
 public:
  enum Open { Ok, Plain, Short, Replay, Tag, Inactive };

  Session();
  // Derives both keys. False when the primitives fail or c is null. counter is the first send counter (0 except in tests).
  bool begin(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, Role role, uint32_t counter = 0);
  // Forgets the keys and every counter.
  void end();
  bool active() const { return active_; }
  // True once 2^32 - 1 has been used: nothing more can be sealed under these keys.
  bool exhausted() const { return next_ > 0xFFFFFFFFull; }

  // Seals len bytes into out as counter | ciphertext | tag and returns len + SEAL_OVERHEAD. 0 when inactive, len > MAX_PLAIN, cap
  // is too small or the counter is used up (2^32 - 1 was the last). The caller sets F_SEALED on the frame it sends.
  size_t seal(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* plain, size_t len, uint8_t* out, size_t cap);

  // Opens a received frame into out (cap bytes) and sets outLen. A refused frame changes nothing but failures().
  Open open(const Frame& f, uint8_t* out, size_t cap, size_t& outLen);

  // Refusals in a row; any frame that opens sets it back to 0.
  uint32_t failures() const { return failures_; }

 private:
  const Crypto* c_;
  uint8_t sendKey_[KEY_BYTES];
  uint8_t recvKey_[KEY_BYTES];
  uint32_t sendDir_, recvDir_;
  uint64_t next_;  // the next send counter; above 0xFFFFFFFF means used up
  bool haveRecv_;
  uint32_t lastRecv_;
  uint32_t failures_;
  bool active_;
};
}  // namespace proto
