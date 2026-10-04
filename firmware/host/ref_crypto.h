// ref_crypto.h: AES-256-GCM and HKDF-SHA256 in plain C++, for the host tests only. The device uses mbedtls (src/crypto_mbedtls.cpp);
// this exists so that the session logic, which is the same code on both, can run on the PC against vectors made by Node's OpenSSL.
#pragma once
#include "proto/crypto.h"

const proto::Crypto& refCrypto();
// The reference HMAC-SHA256 under proto::HmacSha256's signature, for testing proto::hkdfSha256 by itself.
bool refHmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out);
