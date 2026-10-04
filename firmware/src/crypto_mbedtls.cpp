// crypto_mbedtls.cpp: see crypto_mbedtls.h.
#include "crypto_mbedtls.h"
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>
#include <mutex>
#include "proto/hkdf.h"

namespace {
mbedtls_gcm_context g_gcm;  // one context for every call: a stack one would cost the callers' tasks about 500 bytes each
std::mutex g_gcmLock;       // the link's TX lock covers seal and open, but not the self-test on the RX task: one call at a time
uint8_t g_empty[1];         // what an empty payload points at: the hardware GCM is not promised to take a null buffer

// The framework's mbedtls is built without HKDF, so proto/hkdf.cpp does it over mbedtls's HMAC.
bool hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!md) return false;
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  bool ok = mbedtls_md_setup(&ctx, md, 1) == 0 && mbedtls_md_hmac_starts(&ctx, key, keyLen) == 0;
  for (int i = 0; ok && i < n; i++) ok = lens[i] == 0 || mbedtls_md_hmac_update(&ctx, parts[i], lens[i]) == 0;
  ok = ok && mbedtls_md_hmac_finish(&ctx, out) == 0;
  mbedtls_md_free(&ctx);
  return ok;
}

bool hkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen, uint8_t* okm,
          size_t okmLen) {
  return proto::hkdfSha256(hmacSha256, ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
}

bool gcmSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
             uint8_t* tag) {
  std::lock_guard<std::mutex> hold(g_gcmLock);
  if (!in) in = g_empty;
  if (!out) out = g_empty;
  mbedtls_gcm_init(&g_gcm);
  bool ok = mbedtls_gcm_setkey(&g_gcm, MBEDTLS_CIPHER_ID_AES, key, 256) == 0 &&
            mbedtls_gcm_crypt_and_tag(&g_gcm, MBEDTLS_GCM_ENCRYPT, len, nonce, proto::GCM_NONCE_BYTES, aad, aadLen, in, out,
                                      proto::GCM_TAG_BYTES, tag) == 0;
  mbedtls_gcm_free(&g_gcm);
  return ok;
}

bool gcmOpen(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
             const uint8_t* tag, uint8_t* out) {
  std::lock_guard<std::mutex> hold(g_gcmLock);
  if (!in) in = g_empty;
  if (!out) out = g_empty;
  mbedtls_gcm_init(&g_gcm);
  bool ok = mbedtls_gcm_setkey(&g_gcm, MBEDTLS_CIPHER_ID_AES, key, 256) == 0 &&
            mbedtls_gcm_auth_decrypt(&g_gcm, len, nonce, proto::GCM_NONCE_BYTES, aad, aadLen, tag, proto::GCM_TAG_BYTES, in, out) == 0;
  mbedtls_gcm_free(&g_gcm);
  return ok;
}
}  // namespace

const proto::Crypto& mbedtlsCrypto() {
  static const proto::Crypto c = {hkdf, gcmSeal, gcmOpen};
  return c;
}
