// ring.h: a single-producer, single-consumer byte ring with a power-of-two capacity.
// write() belongs to the producer task; read() and clear() to the consumer task. size() and space() may be
// called from either; each can only understate what its caller may use: the producer never sees more free
// space than there is, and the consumer never sees more data than there is.
#pragma once
#include <atomic>
#include <stdint.h>
#include <string.h>

namespace proto {
class ByteRing {
 public:
  ByteRing() : buf_(nullptr), cap_(0), head_(0), tail_(0) {}

  // start places both counters, so a test can run them across their 2^32 wrap.
  void attach(uint8_t* mem, uint32_t capacity, uint32_t start = 0) {
    buf_ = mem;
    cap_ = capacity;
    head_.store(start);
    tail_.store(start);
  }
  uint32_t capacity() const { return cap_; }
  uint32_t size() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
  uint32_t space() const { return cap_ - size(); }

  uint32_t write(const uint8_t* src, uint32_t n) {
    uint32_t h = head_.load(std::memory_order_relaxed);
    uint32_t room = cap_ - (h - tail_.load(std::memory_order_acquire));
    if (n > room) n = room;
    if (n == 0) return 0;
    uint32_t pos = h & (cap_ - 1);
    uint32_t first = n < cap_ - pos ? n : cap_ - pos;
    memcpy(buf_ + pos, src, first);
    memcpy(buf_, src + first, n - first);
    head_.store(h + n, std::memory_order_release);
    return n;
  }

  uint32_t read(uint8_t* dst, uint32_t n) {
    uint32_t t = tail_.load(std::memory_order_relaxed);
    uint32_t avail = head_.load(std::memory_order_acquire) - t;
    if (n > avail) n = avail;
    if (n == 0) return 0;
    uint32_t pos = t & (cap_ - 1);
    uint32_t first = n < cap_ - pos ? n : cap_ - pos;
    memcpy(dst, buf_ + pos, first);
    memcpy(dst + first, buf_, n - first);
    tail_.store(t + n, std::memory_order_release);
    return n;
  }

  // Drops everything written so far.
  void clear() { tail_.store(head_.load(std::memory_order_acquire), std::memory_order_release); }

 private:
  uint8_t* buf_;
  uint32_t cap_;
  std::atomic<uint32_t> head_;
  std::atomic<uint32_t> tail_;
};
}  // namespace proto
