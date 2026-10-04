// test_audiocodec.cpp: what the S3 does with the codec flag of an AUDIO frame (protocol/frames.md, "Audio codec"): decode what comes
// down, and choose and carry the encoder for what goes up.
#include <string.h>
#include <vector>
#include "check.h"
#include "proto/adpcm.h"
#include "proto/audiocodec.h"

namespace {
std::vector<int16_t> ramp(size_t n, int step) {
  std::vector<int16_t> v(n);
  for (size_t i = 0; i < n; i++) v[i] = (int16_t)(((int)i * step) % 20000 - 10000);
  return v;
}
}  // namespace

TEST(codecFlagIsBitsOneAndTwoOfTheFrameFlags) {
  CHECK(proto::codecOf(0x00) == proto::CODEC_PCM16, "no bits: PCM16");
  CHECK(proto::codecOf(0x02) == proto::CODEC_ADPCM, "bit 1: ADPCM");
  CHECK(proto::codecOf(0x01 | 0x08 | 0x80) == proto::CODEC_PCM16, "EOS, REASON and SEALED are not codec bits");
  CHECK(proto::codecOf(0x04) == 2 && proto::codecOf(0x06) == 3, "2 and 3 are read as they are, so they can be refused");
  CHECK(proto::codecFlags(proto::CODEC_ADPCM) == 0x02 && proto::codecFlags(proto::CODEC_PCM16) == 0, "and the other way");
}

TEST(aPcmFrameGoesDownUntouchedWithAnOddByteDropped) {
  proto::DownDecoder d;
  uint8_t in[7] = {1, 2, 3, 4, 5, 6, 7};
  const uint8_t* pcm = nullptr;
  size_t n = 99;
  CHECK(d.decode(0, in, 7, pcm, n) && pcm == in && n == 6, "the same bytes, whole samples only");
}

TEST(anAdpcmFrameGoesDownAsItsPcm) {
  std::vector<int16_t> src = ramp(480, 37);
  uint8_t frame[300];
  uint8_t index = 0;
  size_t flen = proto::adpcmEncode(src.data(), src.size(), index, frame, sizeof frame);
  CHECK(flen == 244, "480 samples are 244 bytes");
  int16_t want[480];
  CHECK(proto::adpcmDecode(frame, flen, want, 480) == 480, "the reference decode");
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 0;
  CHECK(d.decode(proto::codecFlags(proto::CODEC_ADPCM), frame, flen, pcm, n), "decoded");
  CHECK(n == 960 && memcmp(pcm, want, 960) == 0, "960 bytes of the reference PCM, so credit counts what it always counted");
}

TEST(aFrameThatIsNotGoodDecodesToNothingAndSaysSo) {
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 5;
  uint8_t shortFrame[3] = {0, 0, 0};
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), shortFrame, 3, pcm, n) && n == 0, "shorter than its header");
  uint8_t badIndex[8] = {0, 0, 89, 0, 0, 0, 0, 0};
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), badIndex, 8, pcm, n) && n == 0, "a step index above 88");
  uint8_t big[1000];
  memset(big, 0, sizeof big);
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), big, 500, pcm, n) && n == 0, "more than 20 ms (480 samples) of audio");
  uint8_t some[8] = {0, 0, 0, 0, 1, 2, 3, 4};
  CHECK(!d.decode(2 << 1, some, 8, pcm, n) && n == 0, "codec 2 is reserved");
  CHECK(!d.decode(3 << 1, some, 8, pcm, n) && n == 0, "codec 3 is reserved");
}

TEST(anEmptyFrameIsGoodWhateverItsCodecFlag) {
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 7;
  CHECK(d.decode(proto::codecFlags(proto::CODEC_ADPCM), nullptr, 0, pcm, n) && n == 0, "the EOS frame stays empty");
  CHECK(d.decode(0, nullptr, 0, pcm, n) && n == 0, "in PCM16 too");
}

TEST(theUpEncoderIsPcmUntilToldAndGoesBackAtHello) {
  proto::UpEncoder e;
  std::vector<int16_t> src = ramp(320, 11);
  uint8_t out[200];
  const uint8_t* payload = nullptr;
  size_t n = 0;
  uint8_t flags = 0;
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(payload == (const uint8_t*)src.data() && n == 640 && flags == 0, "PCM16 goes out as it is");
  CHECK(e.setCodec(proto::CODEC_ADPCM), "ADPCM accepted");
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(payload == out && n == 164 && flags == proto::codecFlags(proto::CODEC_ADPCM), "now 164 bytes with the codec flag");
  e.reset();
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(n == 640 && flags == 0, "a HELLO puts it back to PCM16");
  CHECK(!e.setCodec(2) && !e.setCodec(255), "codecs 2 and up are refused");
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(n == 640, "and a refusal changes nothing");
}

TEST(theUpEncoderCarriesTheStepIndexThroughATakeAndStartsTheNextAtZero) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200], b[200], c[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "the first frame of a take starts at index 0");
  uint8_t idx = 0;
  uint8_t ref[200];
  proto::adpcmEncode(loud.data(), 320, idx, ref, sizeof ref);
  CHECK(idx > 0, "(the loud ramp does move the index)");
  e.encode(loud.data(), 320, false, b, sizeof b, p, n, flags);
  CHECK(b[2] == idx, "the second frame starts where the first ended");
  e.encode(loud.data(), 320, true, c, sizeof c, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "after the EOS frame the next take starts at 0 again");
}

TEST(theEmptyEosFrameStaysEmptyAndCarriesNoCodecFlag) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  uint8_t out[200];
  const uint8_t* p = nullptr;
  size_t n = 9;
  uint8_t flags = 0xff;
  e.encode(nullptr, 0, true, out, sizeof out, p, n, flags);
  CHECK(n == 0 && flags == 0, "no payload, no codec flag");
}

TEST(theUpEncoderRefusesABufferThatIsTooSmallInsteadOfSendingHalfAFrame) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> src = ramp(320, 11);
  uint8_t small[100];
  const uint8_t* p = nullptr;
  size_t n = 5;
  uint8_t flags = 0;
  CHECK(!e.encode(src.data(), 320, false, small, sizeof small, p, n, flags) && n == 0, "false and nothing to send");
}

TEST(aTakeThatEndsWithAnEmptyEosFrameStartsTheNextOneAtZero) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200], b[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] > 0, "(the index has moved)");
  e.encode(nullptr, 0, true, b, sizeof b, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "a talk key released gives an empty EOS frame, and the next take starts at 0");
}

TEST(askingForTheCodecAgainStartsANewStream) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] > 0, "(the index has moved)");
  e.setCodec(proto::CODEC_ADPCM);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "SET_CODEC begins at index 0");
}
