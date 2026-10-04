#include "proto/session.h"
#include <string.h>

namespace proto {
namespace {
const char kInfo[] = "walkie-session-v1";
const size_t kInfoLen = sizeof kInfo - 1;

void put32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

// HKDF info: "walkie-session-v1" | nonceP u32 LE | nonceS u32 LE | dir u8. Empty salt.
bool deriveKey(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, uint8_t dir, uint8_t* key) {
  uint8_t info[kInfoLen + 9];
  memcpy(info, kInfo, kInfoLen);
  put32(info + kInfoLen, nonceP);
  put32(info + kInfoLen + 4, nonceS);
  info[kInfoLen + 8] = dir;
  return c.hkdf(master, KEY_BYTES, nullptr, 0, info, sizeof info, key, KEY_BYTES);
}

// Nonce: dir u32 LE | counter u64 LE. AAD: type | flags (bit 7 set) | seq u16 LE | sealed length u16 LE | counter u32 LE.
void gcmNonce(uint8_t* n, uint32_t dir, uint32_t counter) {
  put32(n, dir);
  put32(n + 4, counter);
  put32(n + 8, 0);
}

void gcmAad(uint8_t* a, uint8_t type, uint8_t flags, uint16_t seq, uint16_t sealedLen, uint32_t counter) {
  a[0] = type;
  a[1] = (uint8_t)(flags | F_SEALED);
  a[2] = (uint8_t)seq;
  a[3] = (uint8_t)(seq >> 8);
  a[4] = (uint8_t)sealedLen;
  a[5] = (uint8_t)(sealedLen >> 8);
  put32(a + 6, counter);
}
}  // namespace

Session::Session()
    : c_(nullptr), sendDir_(0), recvDir_(0), next_(0), haveRecv_(false), lastRecv_(0), failures_(0), active_(false) {
  memset(sendKey_, 0, sizeof sendKey_);
  memset(recvKey_, 0, sizeof recvKey_);
}

bool Session::begin(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, Role role, uint32_t counter) {
  end();
  if (!c.hkdf || !c.gcmSeal || !c.gcmOpen || !master) return false;
  sendDir_ = role == ROLE_PC ? 1 : 2;
  recvDir_ = role == ROLE_PC ? 2 : 1;
  if (!deriveKey(c, master, nonceP, nonceS, (uint8_t)sendDir_, sendKey_) ||
      !deriveKey(c, master, nonceP, nonceS, (uint8_t)recvDir_, recvKey_)) {
    end();
    return false;
  }
  c_ = &c;
  next_ = counter;
  active_ = true;
  return true;
}

void Session::end() {
  memset(sendKey_, 0, sizeof sendKey_);
  memset(recvKey_, 0, sizeof recvKey_);
  c_ = nullptr;
  next_ = 0;
  haveRecv_ = false;
  lastRecv_ = 0;
  failures_ = 0;
  active_ = false;
}

size_t Session::seal(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* plain, size_t len, uint8_t* out, size_t cap) {
  if (!active_ || len > MAX_PLAIN || cap < len + SEAL_OVERHEAD || next_ > 0xFFFFFFFFull) return 0;
  uint32_t counter = (uint32_t)next_;
  uint8_t nonce[GCM_NONCE_BYTES], aad[10];
  gcmNonce(nonce, sendDir_, counter);
  gcmAad(aad, type, flags, seq, (uint16_t)(len + SEAL_OVERHEAD), counter);
  put32(out, counter);
  if (!c_->gcmSeal(sendKey_, nonce, aad, sizeof aad, plain, len, out + 4, out + 4 + len)) return 0;
  next_++;
  return len + SEAL_OVERHEAD;
}

Session::Open Session::open(const Frame& f, uint8_t* out, size_t cap, size_t& outLen) {
  outLen = 0;
  if (!active_) return Inactive;
  Open r = Ok;
  if (!(f.flags & F_SEALED)) {
    r = Plain;
  } else if (f.len < SEAL_OVERHEAD) {
    r = Short;
  } else {
    const uint8_t* p = f.payload;
    uint32_t counter = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    size_t plainLen = f.len - SEAL_OVERHEAD;
    if (haveRecv_ && counter <= lastRecv_) {
      r = Replay;
    } else if (cap < plainLen) {
      r = Short;
    } else {
      uint8_t nonce[GCM_NONCE_BYTES], aad[10];
      gcmNonce(nonce, recvDir_, counter);
      gcmAad(aad, f.type, f.flags, f.seq, f.len, counter);
      if (!c_->gcmOpen(recvKey_, nonce, aad, sizeof aad, p + 4, plainLen, p + 4 + plainLen, out)) {
        r = Tag;
      } else {
        haveRecv_ = true;
        lastRecv_ = counter;
        outLen = plainLen;
      }
    }
  }
  if (r == Ok) failures_ = 0;
  else failures_++;
  return r;
}
}  // namespace proto
