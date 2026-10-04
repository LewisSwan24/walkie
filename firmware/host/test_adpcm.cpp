// test_adpcm.cpp: IMA-ADPCM frames (protocol/frames.md, "Audio codec") against the "adpcm" vectors of protocol/vectors.json, which
// the bridge's tests pass as well and a Python reference made.
#include <string.h>
#include "check.h"
#include "proto/adpcm.h"
#include "vectors.h"

namespace {
std::vector<int16_t> samplesOf(const std::vector<uint8_t>& b) {
  std::vector<int16_t> s(b.size() / 2);
  for (size_t i = 0; i < s.size(); i++) s[i] = (int16_t)(b[i * 2] | (b[i * 2 + 1] << 8));
  return s;
}
}  // namespace

TEST(adpcmTablesAreTheReferenceTables) {
  CHECK(sizeof kAdpcmSteps / sizeof kAdpcmSteps[0] == 89, "89 steps");
  for (size_t i = 0; i < 89; i++) CHECK(proto::ADPCM_STEPS[i] == kAdpcmSteps[i], "step");
  for (size_t i = 0; i < 8; i++) CHECK(proto::ADPCM_INDEX[i] == kAdpcmIndex[i], "index adjustment");
}

TEST(adpcmEncodesEveryVectorCaseToItsFrameAndStepIndex) {
  for (const AdpcmVec& v : kAdpcm) {
    std::vector<int16_t> pcm = samplesOf(unhex(v.pcm));
    uint8_t out[400];
    uint8_t index = v.indexIn;
    size_t n = proto::adpcmEncode(pcm.data(), pcm.size(), index, out, sizeof out);
    CHECK(tohex(out, n) == v.frame, v.name);
    CHECK(index == v.indexOut, v.name);
  }
}

TEST(adpcmDecodesEveryVectorCaseBitForBit) {
  for (const AdpcmVec& v : kAdpcm) {
    std::vector<uint8_t> frame = unhex(v.frame);
    int16_t out[500];
    size_t n = proto::adpcmDecode(frame.data(), frame.size(), out, 500);
    std::vector<uint8_t> got;
    for (size_t i = 0; i < n; i++) {
      got.push_back((uint8_t)out[i]);
      got.push_back((uint8_t)((uint16_t)out[i] >> 8));
    }
    CHECK(tohex(got.data(), got.size()) == v.decoded, v.name);
  }
}

TEST(adpcmCountsTheSamplesAFrameHoldsAndRejectsWhatCannotBeAFrame) {
  CHECK(proto::adpcmSampleCount(unhex("00000000").data(), 4) == 1, "a bare header holds the one sample it carries");
  CHECK(proto::adpcmSampleCount(unhex("0000000011").data(), 5) == 3, "one byte, two nibbles");
  CHECK(proto::adpcmSampleCount(unhex("0000000111").data(), 5) == 2, "padded: the last nibble is not a sample");
  CHECK(proto::adpcmSampleCount(unhex("000000").data(), 3) == 0, "shorter than its header");
  CHECK(proto::adpcmSampleCount(unhex("00005800").data(), 4) == 1, "index 88 is the largest");
  CHECK(proto::adpcmSampleCount(unhex("00005900").data(), 4) == 0, "index 89 is out of range");
  CHECK(proto::adpcmSampleCount(unhex("00000002").data(), 4) == 0, "a pad flag is 0 or 1");
  CHECK(proto::adpcmSampleCount(unhex("00000001").data(), 4) == 0, "padding with no nibble to pad");
  int16_t out[8];
  CHECK(proto::adpcmDecode(unhex("00005900").data(), 4, out, 8) == 0, "a decode of a bad frame gives nothing");
  std::vector<uint8_t> big = unhex("00000000112233");
  CHECK(proto::adpcmDecode(big.data(), big.size(), out, 4) == 0, "and so does one that does not fit the buffer");
}

TEST(adpcmEncodeRefusesWhatItCannotHold) {
  int16_t pcm[4] = {1, 2, 3, 4};
  uint8_t out[16], index = 0;
  CHECK(proto::adpcmEncode(pcm, 0, index, out, sizeof out) == 0, "no samples");
  CHECK(proto::adpcmEncode(pcm, 4, index, out, 5) == 0, "a buffer too small for the frame");
  CHECK(proto::adpcmEncode(pcm, 4, index, out, 6) == 6, "and one that just fits");
  uint8_t bad = 89;
  CHECK(proto::adpcmEncode(pcm, 4, bad, out, sizeof out) == 0, "a step index out of range");
}

TEST(adpcmTheStepIndexCarriesFromOneFrameToTheNext) {
  std::vector<int16_t> loud(320);
  for (size_t i = 0; i < loud.size(); i++) loud[i] = (i / 8) % 2 ? 12000 : -12000;
  uint8_t a[200], b[200], index = 0;
  size_t na = proto::adpcmEncode(loud.data(), loud.size(), index, a, sizeof a);
  CHECK(na == 164 && index > 0, "a loud frame leaves the index raised");
  uint8_t carried = index;
  size_t nb = proto::adpcmEncode(loud.data(), loud.size(), carried, b, sizeof b);
  CHECK(nb == 164 && b[2] == index, "the next frame states the index it started from");
}

TEST(adpcmFrameSizes) {
  CHECK(proto::adpcmFrameBytes(320) == 164, "20 ms at 16 kHz");
  CHECK(proto::adpcmFrameBytes(480) == 244, "20 ms at 24 kHz");
  CHECK(proto::adpcmFrameBytes(1) == 4, "one sample");
  CHECK(proto::adpcmFrameBytes(2) == 5, "two");
}
