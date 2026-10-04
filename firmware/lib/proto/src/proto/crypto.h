// crypto.h: the primitives a link session needs (protocol/frames.md, "Sealed frames"). The device binds them to mbedtls
// (src/crypto_mbedtls.cpp, with the S3's AES hardware); the host tests bind them to a plain C++ version
// (host/ref_crypto.cpp), so the session logic runs on the PC against the same vectors as the bridge.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t KEY_BYTES = 32;
const size_t GCM_NONCE_BYTES = 12;
const size_t GCM_TAG_BYTES = 16;

struct Crypto {
  // HKDF-SHA256 (RFC 5869): okmLen bytes into okm, at most 255 * 32. An empty salt means 32 zero bytes. False on failure.
  bool (*hkdf)(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
               uint8_t* okm, size_t okmLen);
  // AES-256-GCM. gcmSeal writes len bytes of ciphertext to out (which may be the input) and the 16-byte tag; gcmOpen returns false
  // when the tag is wrong, and then out holds nothing worth reading.
  bool (*gcmSeal)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  uint8_t* out, uint8_t* tag);
  bool (*gcmOpen)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out);
};
}  // namespace proto
