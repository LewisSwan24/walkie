// credit.h: the S3's side of AUDIO_DOWN flow control (protocol/frames.md, Credit).
#pragma once
#include <stdint.h>

namespace proto {
// Owned by one task, the link RX task; nothing else may call it. violations_ is a lifetime count that
// reset() does not clear.
class CreditLedger {
 public:
  CreditLedger(uint32_t window, uint32_t step) : window_(window), step_(step), outstanding_(0), violations_(0) {}

  void reset() { outstanding_ = 0; }

  // An AUDIO_DOWN payload of n bytes arrived (played or discarded).
  void received(uint32_t n) {
    if (n > outstanding_) {
      violations_++;
      outstanding_ = 0;
    } else {
      outstanding_ -= n;
    }
  }

  // Credit to grant now, given the ring's free space, or 0. The caller sends it, then calls granted().
  uint32_t grantable(uint32_t ringSpace) const {
    if (ringSpace <= outstanding_ || window_ <= outstanding_) return 0;
    uint32_t g = ringSpace - outstanding_;
    if (g > window_ - outstanding_) g = window_ - outstanding_;
    return g >= step_ ? g : 0;
  }
  void granted(uint32_t g) { outstanding_ += g; }

  uint32_t outstanding() const { return outstanding_; }
  uint32_t violations() const { return violations_; }

 private:
  uint32_t window_, step_, outstanding_, violations_;
};
}  // namespace proto
