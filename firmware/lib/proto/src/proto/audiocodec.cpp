#include "proto/audiocodec.h"
#include "proto/adpcm.h"

namespace proto {
bool DownDecoder::decode(uint8_t flags, const uint8_t* in, size_t len, const uint8_t*& pcm, size_t& pcmLen) {
  pcm = nullptr;
  pcmLen = 0;
  if (len == 0) return true;
  switch (codecOf(flags)) {
    case CODEC_PCM16:
      pcm = in;
      pcmLen = len & ~(size_t)1;
      return true;
    case CODEC_ADPCM: {
      size_t n = adpcmDecode(in, len, buf_, DOWN_PCM_MAX / 2);
      if (n == 0) return false;
      pcm = (const uint8_t*)buf_;
      pcmLen = n * 2;
      return true;
    }
    default:
      return false;
  }
}

UpEncoder::UpEncoder() : codec_(CODEC_PCM16), index_(0) {}

bool UpEncoder::setCodec(uint8_t codec) {
  if (codec != CODEC_PCM16 && codec != CODEC_ADPCM) return false;
  codec_ = codec;
  index_ = 0;
  return true;
}

void UpEncoder::reset() {
  codec_ = CODEC_PCM16;
  index_ = 0;
}

bool UpEncoder::encode(const int16_t* pcm, size_t samples, bool eos, uint8_t* out, size_t cap, const uint8_t*& payload, size_t& len,
                       uint8_t& codecBits) {
  payload = nullptr;
  len = 0;
  codecBits = 0;
  if (samples == 0) {
    if (eos) index_ = 0;
    return true;
  }
  if (codec_ == CODEC_PCM16) {
    payload = (const uint8_t*)pcm;
    len = samples * 2;
    return true;
  }
  uint8_t idx = index_;
  size_t n = adpcmEncode(pcm, samples, idx, out, cap);
  if (n == 0) return false;
  index_ = eos ? 0 : idx;
  payload = out;
  len = n;
  codecBits = codecFlags(CODEC_ADPCM);
  return true;
}
}  // namespace proto
