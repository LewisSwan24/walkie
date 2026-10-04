// test_session.cpp: sealed frames (protocol/frames.md, "Sealed frames") against protocol/seal-vectors.json, which the bridge's
// tests pass as well. The primitives are host/ref_crypto.cpp's; the device's mbedtls ones are checked on the device itself.
#include <string.h>
#include "check.h"
#include "proto/crc.h"
#include "proto/frame.h"
#include "proto/session.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
using proto::Session;

std::vector<uint8_t> master() { return unhex(kSealMaster); }

bool begin(Session& s, proto::Role role, uint32_t counter = 0, uint32_t nonceS = kSealNonceS) {
  std::vector<uint8_t> m = master();
  return s.begin(refCrypto(), m.data(), kSealNonceP, nonceS, role, counter);
}

// A frame as the wire layer would hand it over: header fields and the sealed payload.
struct Wire {
  uint8_t type, flags;
  uint16_t seq;
  std::vector<uint8_t> payload;
};

proto::Frame asFrame(const Wire& w) {
  proto::Frame f = proto::Frame();
  f.type = w.type;
  f.flags = w.flags;
  f.seq = w.seq;
  f.len = (uint16_t)w.payload.size();
  f.payload = w.payload.data();
  return f;
}

// The envelope bytes of a sealed frame: type, flags, seq, len, payload, CRC-16.
std::string envelopeHex(const Wire& w) {
  std::vector<uint8_t> e;
  e.push_back(w.type);
  e.push_back(w.flags);
  e.push_back((uint8_t)w.seq);
  e.push_back((uint8_t)(w.seq >> 8));
  e.push_back((uint8_t)w.payload.size());
  e.push_back((uint8_t)(w.payload.size() >> 8));
  e.insert(e.end(), w.payload.begin(), w.payload.end());
  uint16_t crc = proto::crc16(e.data(), e.size());
  e.push_back((uint8_t)crc);
  e.push_back((uint8_t)(crc >> 8));
  return tohex(e.data(), e.size());
}

Wire sealOne(Session& s, uint8_t type, uint8_t flags, uint16_t seq, const std::vector<uint8_t>& plain) {
  Wire w;
  w.type = type;
  w.flags = (uint8_t)(flags | proto::F_SEALED);
  w.seq = seq;
  w.payload.resize(plain.size() + proto::SEAL_OVERHEAD);
  size_t n = s.seal(type, flags, seq, plain.data(), plain.size(), w.payload.data(), w.payload.size());
  w.payload.resize(n);
  return w;
}

Session::Open openOne(Session& s, const Wire& w, std::vector<uint8_t>* plain = nullptr) {
  std::vector<uint8_t> out(w.payload.size() + 1);
  size_t n = 0;
  proto::Frame f = asFrame(w);
  Session::Open r = s.open(f, out.data(), out.size(), n);
  if (plain) plain->assign(out.begin(), out.begin() + (long)n);
  return r;
}

Wire fromEnvelope(const std::string& hex) {
  std::vector<uint8_t> e = unhex(hex.c_str());
  Wire w;
  w.type = e[0];
  w.flags = e[1];
  w.seq = (uint16_t)(e[2] | (e[3] << 8));
  w.payload.assign(e.begin() + 6, e.end() - 2);
  return w;
}
}  // namespace

TEST(sessionHkdfMatchesTheRfcAndTheVectors) {
  CHECK(tohex(unhex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865").data(), 42) ==
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        "the helper itself");
  for (const HkdfVec& v : kHkdf) {
    std::vector<uint8_t> ikm = unhex(v.ikm), salt = unhex(v.salt), info = unhex(v.info), okm((size_t)v.length);
    CHECK(refCrypto().hkdf(ikm.data(), ikm.size(), salt.data(), salt.size(), info.data(), info.size(), okm.data(), okm.size()),
          v.name);
    CHECK(tohex(okm.data(), okm.size()) == v.okm, v.name);
  }
  CHECK(strcmp(kHkdf[0].okm, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865") == 0,
        "RFC 5869 test case 1");
}

TEST(sessionSealsTheVectorEnvelopesByteForByte) {
  for (const SealVec& v : kSealFrames) {
    Session s;
    CHECK(begin(s, v.dir == 1 ? proto::ROLE_PC : proto::ROLE_S3, v.counter), "begin");
    Wire w = sealOne(s, v.type, v.flags, v.seq, unhex(v.plain));
    CHECK(envelopeHex(w) == v.envelope, "sealed envelope");
  }
}

TEST(sessionOpensTheVectorEnvelopesAtTheOtherEnd) {
  for (const SealVec& v : kSealFrames) {
    Session s;
    CHECK(begin(s, v.dir == 1 ? proto::ROLE_S3 : proto::ROLE_PC), "begin");
    std::vector<uint8_t> plain;
    CHECK(openOne(s, fromEnvelope(v.envelope), &plain) == Session::Ok, "opens");
    CHECK(tohex(plain.data(), plain.size()) == v.plain, "the plain payload comes out as it went in");
  }
}

TEST(sessionACrossingRoundTripInBothDirections) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  std::vector<uint8_t> got;
  CHECK(openOne(s3, sealOne(pc, 0x02, 0, 1, unhex("01020304")), &got) == Session::Ok && tohex(got.data(), got.size()) == "01020304",
        "PC to S3");
  CHECK(openOne(pc, sealOne(s3, 0x03, 0, 1, unhex("70"))) == Session::Ok, "S3 to PC");
}

TEST(sessionAChangedByteAnywhereIsRefused) {
  const SealVec& v = kSealFrames[2];
  std::vector<uint8_t> env = unhex(v.envelope);
  size_t spots[] = {0, 1, 2, 6, 10, env.size() - 3};  // type, flags, seq, counter, a ciphertext byte, the tag's last byte
  for (size_t at : spots) {
    Session s;
    CHECK(begin(s, proto::ROLE_PC), "begin");
    std::vector<uint8_t> bad = env;
    bad[at] ^= 1;
    Wire w;
    w.type = bad[0];
    w.flags = bad[1];
    w.seq = (uint16_t)(bad[2] | (bad[3] << 8));
    w.payload.assign(bad.begin() + 6, bad.end() - 2);
    CHECK(openOne(s, w) != Session::Ok, "refused");
  }
}

TEST(sessionTheReceiveRuleAcceptsOnlyACounterAboveEveryAcceptedOne) {
  Session s3;
  CHECK(begin(s3, proto::ROLE_S3), "begin");
  for (size_t i = 0; i < sizeof kReplayCounters / sizeof kReplayCounters[0]; i++) {
    Session pc;
    CHECK(begin(pc, proto::ROLE_PC, kReplayCounters[i]), "begin");
    bool ok = openOne(s3, sealOne(pc, 0x02, 0, 0, unhex("00000000"))) == Session::Ok;
    CHECK(ok == (kReplayAccepted[i] != 0), "accepted or not, as the vector says");
  }
}

TEST(sessionAReplayIsRefusedAsReplayAndDoesNotMoveTheCounter) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire f1 = sealOne(pc, 0x02, 0, 1, unhex("01000000"));
  Wire f2 = sealOne(pc, 0x02, 0, 2, unhex("02000000"));
  CHECK(openOne(s3, f2) == Session::Ok, "the later one opens");
  CHECK(openOne(s3, f2) == Session::Replay, "again: replay");
  CHECK(openOne(s3, f1) == Session::Replay, "the earlier one: replay");
}

TEST(sessionAFrameThatFailsTheTagDoesNotMoveTheCounter) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire f = sealOne(pc, 0x02, 0, 1, unhex("01000000"));
  Wire forged = f;
  forged.payload.back() ^= 0xFF;
  CHECK(openOne(s3, forged) == Session::Tag, "the forgery fails the tag");
  CHECK(openOne(s3, f) == Session::Ok, "the real frame still opens");
}

TEST(sessionAFrameWithoutTheSealBitOrTooShortIsRefused) {
  Session s3;
  CHECK(begin(s3, proto::ROLE_S3), "begin");
  Wire plain;
  plain.type = 0x02;
  plain.flags = 0;
  plain.seq = 0;
  plain.payload = unhex("01000000");
  CHECK(openOne(s3, plain) == Session::Plain, "no seal bit");
  Wire shortFrame = plain;
  shortFrame.flags = proto::F_SEALED;
  shortFrame.payload.assign(proto::SEAL_OVERHEAD - 1, 0);
  CHECK(openOne(s3, shortFrame) == Session::Short, "too short for a counter and a tag");
}

TEST(sessionCannotOpenWhatItSealedItself) {
  Session pc;
  CHECK(begin(pc, proto::ROLE_PC), "begin");
  CHECK(openOne(pc, sealOne(pc, 0x02, 0, 0, unhex("01000000"))) == Session::Tag, "the two directions have two keys");
}

TEST(sessionFailuresCountsRefusalsInARowAndRestartsAtTheFirstFrameThatOpens) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire plain;
  plain.type = 0x02;
  plain.flags = 0;
  plain.seq = 0;
  plain.payload = unhex("01000000");
  openOne(s3, plain);
  openOne(s3, plain);
  CHECK(s3.failures() == 2, "two refusals");
  CHECK(openOne(s3, sealOne(pc, 0x02, 0, 1, unhex("01000000"))) == Session::Ok, "a good frame");
  CHECK(s3.failures() == 0, "back to zero");
}

TEST(sessionOtherNoncesOrAnotherKeyCannotOpenTheFrame) {
  Session pc, other, wrong;
  CHECK(begin(pc, proto::ROLE_PC) && begin(other, proto::ROLE_S3, 0, kSealNonceS + 1), "begin");
  uint8_t zeros[32];
  memset(zeros, 9, sizeof zeros);
  CHECK(wrong.begin(refCrypto(), zeros, kSealNonceP, kSealNonceS, proto::ROLE_S3), "begin with another key");
  CHECK(openOne(other, sealOne(pc, 0x02, 0, 0, unhex("01000000"))) != Session::Ok, "another S3 nonce");
  CHECK(openOne(wrong, sealOne(pc, 0x02, 0, 1, unhex("01000000"))) != Session::Ok, "another master key");
}

TEST(sessionTheLargestPayloadThatSealsIs1004BytesAndOneMoreIsRefused) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  CHECK(proto::MAX_PLAIN == 1004, "the constant");
  std::vector<uint8_t> big(1004, 7);
  Wire w = sealOne(pc, 0x11, 0, 0, big);
  CHECK(w.payload.size() == 1024, "1004 plain bytes seal to the 1024 a frame may hold");
  CHECK(openOne(s3, w) == Session::Ok, "and open");
  std::vector<uint8_t> tooBig(1005, 7), out(1100);
  CHECK(pc.seal(0x11, 0, 1, tooBig.data(), tooBig.size(), out.data(), out.size()) == 0, "one more is refused");
}

TEST(sessionTheSendCounterEndsAt2To32Minus1) {
  Session pc;
  CHECK(begin(pc, proto::ROLE_PC, 0xFFFFFFFFu), "begin");
  uint8_t plain[4] = {1, 0, 0, 0}, out[64];
  CHECK(pc.seal(0x02, 0, 0, plain, 4, out, sizeof out) == 24, "the last counter still seals");
  CHECK(pc.seal(0x02, 0, 1, plain, 4, out, sizeof out) == 0, "the next is refused");
}

TEST(sessionAnEmptyPayloadSealsAndOpens) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  std::vector<uint8_t> got(1, 1);
  CHECK(openOne(s3, sealOne(pc, 0x3F, 0, 3, std::vector<uint8_t>()), &got) == Session::Ok && got.empty(), "empty in, empty out");
}

TEST(sessionAnInactiveOrEndedSessionSealsNothingAndOpensNothing) {
  Session s;
  uint8_t plain[4] = {1, 0, 0, 0}, out[64];
  CHECK(!s.active() && s.seal(0x02, 0, 0, plain, 4, out, sizeof out) == 0, "never begun");
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire w = sealOne(pc, 0x02, 0, 0, unhex("01000000"));
  s3.end();
  CHECK(!s3.active() && openOne(s3, w) == Session::Inactive, "ended: nothing opens");
}
