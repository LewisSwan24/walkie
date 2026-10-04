// test_codec.cpp: CRC, COBS, frames and the stream decoder against protocol/vectors.json.
#include <string.h>
#include "check.h"
#include "proto/cobs.h"
#include "proto/crc.h"
#include "proto/frame.h"
#include "vectors.h"

TEST(crcMatchesVectors) {
  for (const HexU32& v : kCrc16) {
    std::vector<uint8_t> b = unhex(v.hex);
    CHECK(proto::crc16(b.data(), b.size()) == v.value, "crc16");
  }
  for (const HexU32& v : kCrc32) {
    std::vector<uint8_t> b = unhex(v.hex);
    CHECK(proto::crc32Update(0, b.data(), b.size()) == v.value, "crc32");
  }
  std::vector<uint8_t> d = unhex(kCrc32[0].hex);
  uint32_t c = proto::crc32Update(0, d.data(), 4);
  CHECK(proto::crc32Update(c, d.data() + 4, d.size() - 4) == kCrc32[0].value, "crc32 in two parts");
}

TEST(cobsMatchesVectors) {
  static uint8_t out[2048];
  for (const CobsVec& v : kCobs) {
    std::vector<uint8_t> dec = unhex(v.decoded), enc = unhex(v.encoded);
    size_t m = proto::cobsEncode(dec.data(), dec.size(), out, sizeof out);
    CHECK(m != proto::COBS_ERROR && tohex(out, m) == v.encoded, "cobs encode");
    size_t k = proto::cobsDecode(enc.data(), enc.size(), out, sizeof out);
    CHECK(k != proto::COBS_ERROR && tohex(out, k) == v.decoded, "cobs decode");
  }
  for (const char* bad : kCobsInvalid) {
    std::vector<uint8_t> enc = unhex(bad);
    CHECK(proto::cobsDecode(enc.data(), enc.size(), out, sizeof out) == proto::COBS_ERROR, bad);
  }
  const uint8_t five[5] = {1, 2, 3, 4, 5};
  uint8_t small[4];
  CHECK(proto::cobsEncode(five, 5, small, sizeof small) == proto::COBS_ERROR, "encode into a short buffer");
}

TEST(framesMatchVectors) {
  static uint8_t wire[proto::MAX_WIRE];
  for (const FrameVec& v : kFrames) {
    std::vector<uint8_t> p = unhex(v.payload);
    size_t n = proto::encodeFrame(v.type, v.flags, v.seq, p.data(), (uint16_t)p.size(), wire, sizeof wire);
    CHECK(n > 0 && tohex(wire, n) == v.wire, v.name);
    std::vector<uint8_t> w = unhex(v.wire);
    proto::FrameDecoder d;
    int seen = 0;
    d.push(w.data(), w.size(), [&](const proto::Frame& f) {
      seen++;
      CHECK(f.type == v.type && f.flags == v.flags && f.seq == v.seq && tohex(f.payload, f.len) == v.payload,
            v.name);
    });
    CHECK(seen == 1 && d.bad() == 0, v.name);
  }
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  CHECK(proto::encodeFrame(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, wire, sizeof wire) == 0, "payload over 1024");
  CHECK(proto::encodeFrame(0x11, 0, 0, big, 16, wire, 20) == 0, "output buffer too small");
}

TEST(streamsMatchVectors) {
  for (const StreamVec& s : kStreams) {
    proto::FrameDecoder d;
    std::string got, chunks = s.chunks;
    size_t start = 0;
    while (start <= chunks.size()) {
      size_t comma = chunks.find(',', start);
      if (comma == std::string::npos) comma = chunks.size();
      std::vector<uint8_t> b = unhex(chunks.substr(start, comma - start).c_str());
      d.push(b.data(), b.size(), [&](const proto::Frame& f) {
        char item[24];
        snprintf(item, sizeof item, "%s%02x:%u", got.empty() ? "" : ",", (unsigned)f.type, (unsigned)f.seq);
        got += item;
      });
      start = comma + 1;
    }
    CHECK(got == s.expect, s.name);
    CHECK((int)d.bad() == s.bad, s.name);
  }
}

// Hard-coded from protocol/frames.md, not derived from the code under test.
TEST(frameConstantsMatchSpec) {
  CHECK((unsigned)proto::T_HELLO == 0x01u, "T_HELLO");
  CHECK((unsigned)proto::T_PING == 0x02u, "T_PING");
  CHECK((unsigned)proto::T_PONG == 0x03u, "T_PONG");
  CHECK((unsigned)proto::T_AUDIO_UP == 0x10u, "T_AUDIO_UP");
  CHECK((unsigned)proto::T_AUDIO_DOWN == 0x11u, "T_AUDIO_DOWN");
  CHECK((unsigned)proto::T_CREDIT == 0x12u, "T_CREDIT");
  CHECK((unsigned)proto::T_PLAYED == 0x13u, "T_PLAYED");
  CHECK((unsigned)proto::T_CMD == 0x30u, "T_CMD");
  CHECK((unsigned)proto::T_TEST == 0x31u, "T_TEST");
  CHECK((unsigned)proto::T_LOG == 0x3Fu, "T_LOG");
  CHECK((unsigned)proto::F_EOS == 0x01u, "F_EOS");
  CHECK(proto::MAX_PAYLOAD == 1024, "MAX_PAYLOAD");
  CHECK(proto::MAX_CHUNK == 1100, "MAX_CHUNK");
}


// The relay carries the envelope alone (protocol/frames.md, "Relay"): the same bytes COBS carries on USB.
TEST(envelopesAreTheBytesCobsCarries) {
  static uint8_t env[proto::ENVELOPE_MAX];
  static uint8_t dec[proto::ENVELOPE_MAX + 8];
  for (const FrameVec& v : kFrames) {
    std::vector<uint8_t> p = unhex(v.payload);
    size_t n = proto::encodeEnvelope(v.type, v.flags, v.seq, p.data(), (uint16_t)p.size(), env, sizeof env);
    std::vector<uint8_t> w = unhex(v.wire);
    size_t m = proto::cobsDecode(w.data() + 1, w.size() - 2, dec, sizeof dec);
    CHECK(n == p.size() + 8 && n == m && memcmp(env, dec, n) == 0, v.name);
    proto::Frame f = proto::Frame();
    CHECK(proto::parseEnvelope(env, n, f) && f.type == v.type && f.flags == v.flags && f.seq == v.seq && tohex(f.payload, f.len) == v.payload,
          v.name);
  }
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, env, sizeof env) == 0, "payload over 1024");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD, env, sizeof env) == proto::ENVELOPE_MAX, "1024 is the largest");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, 16, env, 23) == 0, "a buffer one short");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, 16, env, 24) == 24, "exactly enough");
  proto::Frame empty = proto::Frame();
  CHECK(proto::encodeEnvelope(0x11, 0, 0, nullptr, 0, env, 8) == 8 && proto::parseEnvelope(env, 8, empty) && empty.len == 0, "an empty payload");
}


TEST(envelopeOverTheLimitIsRefusedEvenWithRoomForIt) {
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  static uint8_t roomy[proto::ENVELOPE_MAX + 64];
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, roomy, sizeof roomy) == 0,
        "1025 bytes is no frame (the S3 would refuse it), whatever the buffer");
}
