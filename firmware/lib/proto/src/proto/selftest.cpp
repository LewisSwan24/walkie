#include "proto/selftest.h"
#include <string.h>
#include "proto/frame.h"
#include "proto/session.h"

namespace proto {
namespace {
size_t unhex(const char* s, uint8_t* out) {
  size_t n = 0;
  for (; s[0] && s[1]; s += 2) {
    int v = 0;
    for (int i = 0; i < 2; i++) {
      char c = s[i];
      v = v * 16 + (c >= 'a' ? c - 'a' + 10 : c >= 'A' ? c - 'A' + 10 : c - '0');
    }
    out[n++] = (uint8_t)v;
  }
  return n;
}

// RFC 5869, appendix A.1.
const char* HKDF_IKM = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const char* HKDF_SALT = "000102030405060708090a0b0c";
const char* HKDF_INFO = "f0f1f2f3f4f5f6f7f8f9";
const char* HKDF_OKM = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

// The GCM specification's test case 16 (AES-256, 96-bit nonce, 60 bytes of plaintext and 20 of additional data).
const char* GCM_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const char* GCM_NONCE = "cafebabefacedbaddecaf888";
const char* GCM_AAD = "feedfacedeadbeeffeedfacedeadbeefabaddad2";
const char* GCM_PLAIN =
    "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
const char* GCM_CIPHER =
    "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662";
const char* GCM_TAG = "76fc6ece0f4e1768cddf8853bb2d551b";

uint8_t checkHkdf(const Crypto& c) {
  uint8_t ikm[22], salt[13], info[10], want[42], got[42];
  unhex(HKDF_IKM, ikm);
  unhex(HKDF_SALT, salt);
  unhex(HKDF_INFO, info);
  unhex(HKDF_OKM, want);
  bool ok = c.hkdf(ikm, sizeof ikm, salt, sizeof salt, info, sizeof info, got, sizeof got);
  return ok && memcmp(got, want, sizeof want) == 0 ? 0 : ST_HKDF;
}

struct Gcm {
  uint8_t key[32], nonce[12], aad[20], plain[60], cipher[60], tag[16];
  Gcm() {
    unhex(GCM_KEY, key);
    unhex(GCM_NONCE, nonce);
    unhex(GCM_AAD, aad);
    unhex(GCM_PLAIN, plain);
    unhex(GCM_CIPHER, cipher);
    unhex(GCM_TAG, tag);
  }
};

uint8_t checkSeal(const Crypto& c, const Gcm& g) {
  uint8_t ct[60], tag[16];
  bool ok = c.gcmSeal(g.key, g.nonce, g.aad, sizeof g.aad, g.plain, sizeof g.plain, ct, tag);
  return ok && memcmp(ct, g.cipher, sizeof ct) == 0 && memcmp(tag, g.tag, sizeof tag) == 0 ? 0 : ST_GCM_SEAL;
}

uint8_t checkOpen(const Crypto& c, const Gcm& g) {
  uint8_t pt[60];
  bool ok = c.gcmOpen(g.key, g.nonce, g.aad, sizeof g.aad, g.cipher, sizeof g.cipher, g.tag, pt);
  return ok && memcmp(pt, g.plain, sizeof pt) == 0 ? 0 : ST_GCM_OPEN;
}

uint8_t checkTamper(const Crypto& c, const Gcm& g) {
  uint8_t pt[60];
  uint8_t tag[16], ct[60], aad[20];
  memcpy(tag, g.tag, sizeof tag);
  memcpy(ct, g.cipher, sizeof ct);
  memcpy(aad, g.aad, sizeof aad);
  tag[15] ^= 0x80;
  if (c.gcmOpen(g.key, g.nonce, g.aad, sizeof aad, g.cipher, sizeof ct, tag, pt)) return ST_GCM_TAMPER;
  ct[30] ^= 1;
  if (c.gcmOpen(g.key, g.nonce, g.aad, sizeof aad, ct, sizeof ct, g.tag, pt)) return ST_GCM_TAMPER;
  aad[0] ^= 1;
  if (c.gcmOpen(g.key, g.nonce, aad, sizeof aad, g.cipher, sizeof ct, g.tag, pt)) return ST_GCM_TAMPER;
  return 0;
}

uint8_t checkSession(const Crypto& c) {
  uint8_t master[KEY_BYTES];
  for (size_t i = 0; i < sizeof master; i++) master[i] = (uint8_t)(0x40 + i);
  Session pc, s3;
  if (!pc.begin(c, master, 0x11111111u, 0x22222222u, ROLE_PC) || !s3.begin(c, master, 0x11111111u, 0x22222222u, ROLE_S3)) return ST_SESSION;
  const uint8_t plain[6] = {'w', 'a', 'l', 'k', 'i', 'e'};
  uint8_t wire[64], out[64];  // small: this runs on the link's RX task
  size_t n = pc.seal(T_PING, 0, 5, plain, sizeof plain, wire, sizeof wire);
  if (n != sizeof plain + SEAL_OVERHEAD) return ST_SESSION;
  Frame f = {T_PING, (uint8_t)F_SEALED, 5, (uint16_t)n, wire};
  size_t got = 0;
  if (s3.open(f, out, sizeof out, got) != Session::Ok || got != sizeof plain || memcmp(out, plain, got) != 0) return ST_SESSION;
  if (s3.open(f, out, sizeof out, got) == Session::Ok) return ST_SESSION;  // the same frame again
  n = pc.seal(T_PING, 0, 6, plain, sizeof plain, wire, sizeof wire);
  wire[5] ^= 1;  // a bit of the ciphertext
  Frame forged = {T_PING, (uint8_t)F_SEALED, 6, (uint16_t)n, wire};
  if (s3.open(forged, out, sizeof out, got) == Session::Ok) return ST_SESSION;
  // Empty payloads, both ways: the S3 seals its own empty EOS and opens the PC's empty EOS of every stopped reply.
  n = pc.seal(T_PING, 0, 7, nullptr, 0, wire, sizeof wire);
  Frame empty = {T_PING, (uint8_t)F_SEALED, 7, (uint16_t)n, wire};
  if (n != SEAL_OVERHEAD || s3.open(empty, out, sizeof out, got) != Session::Ok || got != 0) return ST_SESSION;
  n = s3.seal(T_PONG, 0, 8, nullptr, 0, wire, sizeof wire);
  Frame emptyBack = {T_PONG, (uint8_t)F_SEALED, 8, (uint16_t)n, wire};
  if (n != SEAL_OVERHEAD || pc.open(emptyBack, out, sizeof out, got) != Session::Ok || got != 0) return ST_SESSION;
  return 0;
}
}  // namespace

uint8_t selfTest(const Crypto& c) {
  if (!c.hkdf || !c.gcmSeal || !c.gcmOpen) return ST_ALL;
  Gcm g;
  return (uint8_t)(checkHkdf(c) | checkSeal(c, g) | checkOpen(c, g) | checkTamper(c, g) | checkSession(c));
}
}  // namespace proto
