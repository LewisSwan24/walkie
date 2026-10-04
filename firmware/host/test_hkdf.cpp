// test_hkdf.cpp: the HKDF that runs on the device (proto/hkdf.cpp), over the host's reference HMAC, against RFC 5869 and the vectors.
#include <string.h>
#include "check.h"
#include "proto/hkdf.h"
#include "ref_crypto.h"
#include "vectors.h"

TEST(hkdfMatchesTheRfcAndTheVectorsOverTheReferenceHmac) {
  for (const HkdfVec& v : kHkdf) {
    std::vector<uint8_t> ikm = unhex(v.ikm), salt = unhex(v.salt), info = unhex(v.info), okm((size_t)v.length);
    CHECK(proto::hkdfSha256(refHmacSha256, ikm.data(), ikm.size(), salt.data(), salt.size(), info.data(), info.size(), okm.data(),
                            okm.size()),
          v.name);
    CHECK(tohex(okm.data(), okm.size()) == v.okm, v.name);
  }
}

TEST(hkdfAnEmptySaltIsThirtyTwoZeroBytes) {
  uint8_t ikm[22], zeros[32] = {0}, a[42], b[42];
  memset(ikm, 0x0b, sizeof ikm);
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, sizeof ikm, nullptr, 0, nullptr, 0, a, sizeof a), "empty");
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, sizeof ikm, zeros, sizeof zeros, nullptr, 0, b, sizeof b), "zeros");
  CHECK(memcmp(a, b, sizeof a) == 0, "the same output");
}

TEST(hkdfRefusesWhatItCannotMakeAndWhatTheHmacRefuses) {
  uint8_t ikm[4] = {1, 2, 3, 4}, out[32];
  CHECK(!proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, nullptr, 0, out, 255 * 32 + 1), "more than 255 blocks");
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, nullptr, 0, out, 0), "nothing to make is fine");
  uint8_t info[65] = {0};
  CHECK(!proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, info, sizeof info, out, 32), "an info longer than 64 bytes is out of range");
  CHECK(!proto::hkdfSha256(nullptr, ikm, 4, nullptr, 0, nullptr, 0, out, 32), "no HMAC");
}
