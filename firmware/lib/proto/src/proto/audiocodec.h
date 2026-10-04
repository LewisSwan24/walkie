// audiocodec.h: what the S3 does with the codec flag of an AUDIO frame (protocol/frames.md, "Audio codec"). A receiver decodes by
// the flag, so nothing is negotiated for the downlink; the uplink codec is whatever the PC last asked for with CMD SET_CODEC, and
// goes back to PCM16 at every HELLO. Pure, so the host tests run all of it.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
enum : uint8_t { CODEC_PCM16 = 0, CODEC_ADPCM = 1 };
const uint8_t F_CODEC_MASK = 0x06;  // frame flags bits 1-2
const size_t DOWN_PCM_MAX = 960;    // 20 ms at 24 kHz: no downlink frame decodes to more

inline uint8_t codecOf(uint8_t flags) { return (uint8_t)((flags & F_CODEC_MASK) >> 1); }
inline uint8_t codecFlags(uint8_t codec) { return (uint8_t)((codec << 1) & F_CODEC_MASK); }

// AUDIO_DOWN payload to the PCM16 bytes to play.
class DownDecoder {
 public:
  // PCM16 frames pass through (a stray odd byte is dropped); ADPCM frames are decoded into an internal buffer, valid until the next
  // call. An empty frame (the EOS) is good whatever its flag says. False, with pcmLen 0, for a frame that is no good: a reserved
  // codec, ADPCM that does not parse, or one that decodes to more than DOWN_PCM_MAX bytes.
  bool decode(uint8_t flags, const uint8_t* in, size_t len, const uint8_t*& pcm, size_t& pcmLen);

 private:
  int16_t buf_[DOWN_PCM_MAX / 2];
};

// AUDIO_UP: PCM16 samples to the payload and codec flag bits to send.
class UpEncoder {
 public:
  UpEncoder();
  // The RX task's: CMD SET_CODEC (false for a codec this does not know, which changes nothing) and HELLO. Both start a new stream.
  bool setCodec(uint8_t codec);
  void reset();
  // The audio task's. `payload` is `pcm` itself for PCM16, else a frame in `out`; `codecBits` are for the frame flags. The step index
  // is carried from frame to frame, and the frame with `eos` ends the stream. False, with len 0, when `out` is too small.
  bool encode(const int16_t* pcm, size_t samples, bool eos, uint8_t* out, size_t cap, const uint8_t*& payload, size_t& len,
              uint8_t& codecBits);

 private:
  volatile uint8_t codec_;
  volatile uint8_t index_;
};
}  // namespace proto
