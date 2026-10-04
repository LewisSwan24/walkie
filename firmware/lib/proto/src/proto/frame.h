// frame.h: frames of the link (protocol/frames.md): encoding one, and finding them in a byte stream.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
enum : uint8_t {
  T_HELLO = 0x01,
  T_PING = 0x02,
  T_PONG = 0x03,
  T_AUDIO_UP = 0x10,
  T_AUDIO_DOWN = 0x11,
  T_CREDIT = 0x12,
  T_PLAYED = 0x13,
  T_UI = 0x20,
  T_BUTTON = 0x21,
  T_APPROVAL_REQ = 0x22,
  T_APPROVAL_RES = 0x23,
  T_CMD = 0x30,
  T_TEST = 0x31,
  T_PAIR = 0x32,
  T_NET = 0x33,
  T_LOG = 0x3F,
};
enum : uint8_t { F_EOS = 0x01, F_REASON = 0x08 };

const uint16_t MAX_PAYLOAD = 1024;
const size_t MAX_CHUNK = 1100;
const size_t ENVELOPE_MAX = MAX_PAYLOAD + 8;
// A safe buffer for encodeFrame(): two delimiters plus cobsMaxEncoded(ENVELOPE_MAX). The COBS body is at most
// ENVELOPE_MAX + ENVELOPE_MAX/254 + 1 bytes and the encoder's scratch byte always lies within that length.
const size_t MAX_WIRE = 2 + ENVELOPE_MAX + ENVELOPE_MAX / 254 + 2;

struct Frame {
  uint8_t type;
  uint8_t flags;
  uint16_t seq;
  uint16_t len;
  const uint8_t* payload;  // valid only during the callback that receives the frame
};

// Writes 0x00, COBS(envelope), 0x00 to out. Returns its length, or 0 if len > MAX_PAYLOAD or cap is too small.
// Needs about 1 KB of the caller's stack (1,072 bytes measured at -Os); size the calling task's stack for it.
size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
                   size_t cap);
// Writes the envelope alone (what COBS carries on USB, and one relay message carries): type, flags, seq, len, payload, CRC-16.
// Returns its length, len + 8, or 0 if len > MAX_PAYLOAD or cap is too small.
size_t encodeEnvelope(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out, size_t cap);
// Checks a decoded envelope; on success fills f, whose payload points into env.
bool parseEnvelope(const uint8_t* env, size_t n, Frame& f);

// Splits a byte stream on 0x00, hands every valid frame to a callback and counts the bad chunks.
// About 2.2 KB (two MAX_CHUNK buffers): make it static or a member, never a local on a task's stack.
class FrameDecoder {
 public:
  FrameDecoder() : len_(0), overflow_(false), bad_(0) {}

  template <typename F>
  void push(const uint8_t* data, size_t n, F onFrame) {
    for (size_t i = 0; i < n; i++) {
      uint8_t b = data[i];
      if (b != 0) {
        if (len_ < MAX_CHUNK) chunk_[len_++] = b;
        else overflow_ = true;
        continue;
      }
      if (overflow_) {
        bad_++;
      } else if (len_ > 0) {
        Frame f = Frame();
        if (finish(f)) onFrame(f);
        else bad_++;
      }
      len_ = 0;
      overflow_ = false;
    }
  }
  uint32_t bad() const { return bad_; }

 private:
  bool finish(Frame& f);
  uint8_t chunk_[MAX_CHUNK];
  uint8_t env_[MAX_CHUNK];
  size_t len_;
  bool overflow_;
  uint32_t bad_;
};
}  // namespace proto
