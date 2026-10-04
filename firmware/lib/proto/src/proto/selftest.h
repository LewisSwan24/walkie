// selftest.h: known-answer tests of a Crypto (proto/crypto.h), for the S3 to run on itself (TEST SELFTEST) so that the mbedtls adapter,
// which no host test reaches, is checked against published vectors on the real chip. The host tests run the same code against the
// reference primitives, which is what proves the expected values themselves.
#pragma once
#include <stdint.h>
#include "proto/crypto.h"

namespace proto {
enum : uint8_t {
  ST_HKDF = 1,         // RFC 5869 test case 1
  ST_GCM_SEAL = 2,     // NIST AES-256-GCM test case 16: ciphertext and tag
  ST_GCM_OPEN = 4,     // the same frame opens, to the plaintext
  ST_GCM_TAMPER = 8,   // a flipped bit in the tag, the ciphertext or the additional data is refused
  ST_SESSION = 16,     // a Session from the PC's role to the S3's: opens, a replay and a forgery are refused
  ST_ALL = 31,
};

// The bits of the checks that failed, 0 when all passed. A Crypto with a missing primitive fails them all.
uint8_t selfTest(const Crypto& c);
}  // namespace proto
