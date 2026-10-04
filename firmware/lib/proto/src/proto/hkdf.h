// hkdf.h: HKDF-SHA256 (RFC 5869) over any HMAC-SHA256, so that the same code runs on the device (mbedtls's HMAC, since the
// framework's build leaves out its HKDF) and in the host tests (a plain C++ HMAC) against the same vectors.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t HKDF_MAX_INFO = 64;

// HMAC-SHA256 of the concatenation of n parts (n <= 3) under key; writes 32 bytes to out. False on failure.
typedef bool (*HmacSha256)(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out);

// okmLen bytes (at most 255 * 32) into okm. An empty salt means 32 zero bytes. False when a length is out of range
// (info over HKDF_MAX_INFO included) or the HMAC fails.
bool hkdfSha256(HmacSha256 hmac, const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info,
                size_t infoLen, uint8_t* okm, size_t okmLen);
}  // namespace proto
