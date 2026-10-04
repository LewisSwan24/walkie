// test_selftest.cpp: the known-answer test the S3 runs on itself (TEST SELFTEST), here against the host's reference primitives, which must
// pass it, and against primitives with one fault each, which must not. The vectors are the RFC 5869 and NIST ones, so a pass here means
// the expected values are right, and a pass on the device means mbedtls agrees with them.
#include <string.h>
#include "check.h"
#include "proto/crypto.h"
#include "proto/selftest.h"
#include "ref_crypto.h"

namespace {
proto::Crypto base() { return refCrypto(); }

bool brokenHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen, uint8_t* okm,
                size_t okmLen) {
  bool ok = refCrypto().hkdf(ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
  okm[okmLen - 1] ^= 1;
  return ok;
}
bool brokenSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
                uint8_t* tag) {
  bool ok = refCrypto().gcmSeal(key, nonce, aad, aadLen, in, len, out, tag);
  out[0] ^= 1;
  return ok;
}
bool openNothing(const uint8_t*, const uint8_t*, const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, uint8_t*) { return false; }
bool openAnything(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out) {
  refCrypto().gcmOpen(key, nonce, aad, aadLen, in, len, tag, out);
  return true;
}
}  // namespace

TEST(theReferencePrimitivesPassTheSelfTest) { CHECK(proto::selfTest(base()) == 0, "every known answer matches"); }

TEST(aWrongHkdfFailsTheHkdfCheck) {
  proto::Crypto c = base();
  c.hkdf = brokenHkdf;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_HKDF, "the RFC 5869 answer differs");
}

TEST(aWrongGcmSealFailsTheSealCheck) {
  proto::Crypto c = base();
  c.gcmSeal = brokenSeal;
  CHECK(proto::selfTest(c) & proto::ST_GCM_SEAL, "the NIST ciphertext differs");
}

TEST(aGcmOpenThatRefusesEverythingFailsTheOpenCheck) {
  proto::Crypto c = base();
  c.gcmOpen = openNothing;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_GCM_OPEN, "a good frame was refused");
  CHECK(!(failed & proto::ST_GCM_TAMPER), "refusing a bad one is not what failed");
}

TEST(aGcmOpenThatAcceptsEverythingFailsTheTamperCheck) {
  proto::Crypto c = base();
  c.gcmOpen = openAnything;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_GCM_TAMPER, "a damaged tag or ciphertext was accepted");
  CHECK(!(failed & proto::ST_GCM_OPEN), "accepting a good one is not what failed");
}

TEST(aSessionBetweenTwoRolesSealsOpensAndRefusesAReplay) {
  proto::Crypto c = base();
  c.gcmOpen = openAnything;  // a session that accepts forgeries must show in the session check as well
  CHECK(proto::selfTest(c) & proto::ST_SESSION, "a tampered frame opened");
}

// The S3 seals its own empty EOS and opens the PC's empty EOS of every stopped reply, so a chip whose GCM refuses zero bytes must show.
bool sealNotEmpty(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
                  uint8_t* tag) {
  return len != 0 && refCrypto().gcmSeal(key, nonce, aad, aadLen, in, len, out, tag);
}
bool openNotEmpty(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out) {
  return len != 0 && refCrypto().gcmOpen(key, nonce, aad, aadLen, in, len, tag, out);
}

TEST(aGcmThatRefusesAZeroLengthSealFailsTheSessionCheck) {
  proto::Crypto c = base();
  c.gcmSeal = sealNotEmpty;
  CHECK(proto::selfTest(c) & proto::ST_SESSION, "an empty payload was not sealed");
}

TEST(aGcmThatRefusesAZeroLengthOpenFailsTheSessionCheck) {
  proto::Crypto c = base();
  c.gcmOpen = openNotEmpty;
  CHECK(proto::selfTest(c) & proto::ST_SESSION, "an empty payload was not opened");
}

TEST(primitivesThatAreMissingFailEverything) {
  proto::Crypto c = base();
  c.hkdf = nullptr;
  CHECK(proto::selfTest(c) == proto::ST_ALL, "nothing can be checked");
  c = base();
  c.gcmOpen = nullptr;
  CHECK(proto::selfTest(c) == proto::ST_ALL, "nothing can be checked");
}
