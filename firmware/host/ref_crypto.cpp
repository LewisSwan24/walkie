// ref_crypto.cpp: see ref_crypto.h. Short and slow on purpose: nothing here is constant time, and it never ships.
#include "ref_crypto.h"
#include <string.h>
#include "proto/hkdf.h"

namespace {
// ---- AES-256 ----
uint8_t sbox[256];
bool sboxReady = false;

uint8_t rotl8(uint8_t x, int n) { return (uint8_t)((x << n) | (x >> (8 - n))); }

void initSbox() {
  if (sboxReady) return;
  uint8_t p = 1, q = 1;
  do {
    p = (uint8_t)(p ^ (uint8_t)(p << 1) ^ ((p & 0x80) ? 0x1B : 0));  // p times 3
    q = (uint8_t)(q ^ (uint8_t)(q << 1));                            // q divided by 3
    q = (uint8_t)(q ^ (uint8_t)(q << 2));
    q = (uint8_t)(q ^ (uint8_t)(q << 4));
    if (q & 0x80) q = (uint8_t)(q ^ 0x09);
    sbox[p] = (uint8_t)(q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63);
  } while (p != 1);
  sbox[0] = 0x63;
  sboxReady = true;
}

uint8_t xtime(uint8_t x) { return (uint8_t)((x << 1) ^ ((x & 0x80) ? 0x1B : 0)); }

struct Aes {
  uint8_t rk[15 * 16];
  explicit Aes(const uint8_t* key) {
    initSbox();
    memcpy(rk, key, 32);
    uint8_t rcon = 1;
    for (int i = 8; i < 60; i++) {
      uint8_t t[4];
      memcpy(t, rk + 4 * (i - 1), 4);
      if (i % 8 == 0) {
        uint8_t u = t[0];
        t[0] = (uint8_t)(sbox[t[1]] ^ rcon);
        t[1] = sbox[t[2]];
        t[2] = sbox[t[3]];
        t[3] = sbox[u];
        rcon = xtime(rcon);
      } else if (i % 8 == 4) {
        for (int k = 0; k < 4; k++) t[k] = sbox[t[k]];
      }
      for (int k = 0; k < 4; k++) rk[4 * i + k] = (uint8_t)(rk[4 * (i - 8) + k] ^ t[k]);
    }
  }
  void encrypt(const uint8_t* in, uint8_t* out) const {
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = (uint8_t)(in[i] ^ rk[i]);
    for (int round = 1; round <= 14; round++) {
      uint8_t t[16];
      for (int c = 0; c < 4; c++)  // SubBytes and ShiftRows
        for (int r = 0; r < 4; r++) t[4 * c + r] = sbox[s[4 * ((c + r) % 4) + r]];
      if (round < 14) {
        for (int c = 0; c < 4; c++) {  // MixColumns
          uint8_t* a = t + 4 * c;
          uint8_t a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
          a[0] = (uint8_t)(xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3);
          a[1] = (uint8_t)(a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3);
          a[2] = (uint8_t)(a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3));
          a[3] = (uint8_t)((xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3));
        }
      }
      for (int i = 0; i < 16; i++) s[i] = (uint8_t)(t[i] ^ rk[16 * round + i]);
    }
    memcpy(out, s, 16);
  }
};

// ---- GCM ----
void gmul(uint8_t* x, const uint8_t* h) {  // x = x * h in GF(2^128), the bit order of the GCM specification
  uint8_t z[16] = {0}, v[16];
  memcpy(v, h, 16);
  for (int i = 0; i < 128; i++) {
    if ((x[i / 8] >> (7 - i % 8)) & 1)
      for (int k = 0; k < 16; k++) z[k] ^= v[k];
    uint8_t lsb = v[15] & 1;
    for (int k = 15; k > 0; k--) v[k] = (uint8_t)((v[k] >> 1) | (v[k - 1] << 7));
    v[0] = (uint8_t)(v[0] >> 1);
    if (lsb) v[0] ^= 0xE1;
  }
  memcpy(x, z, 16);
}

void ghashUpdate(uint8_t* y, const uint8_t* h, const uint8_t* data, size_t len) {
  for (size_t off = 0; off < len; off += 16) {
    size_t n = len - off < 16 ? len - off : 16;
    for (size_t k = 0; k < n; k++) y[k] ^= data[off + k];
    gmul(y, h);
  }
}

void putBe64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (56 - 8 * i));
}

// The tag for (aad, ciphertext) under key and a 96-bit nonce.
void gcmTag(const Aes& aes, const uint8_t* h, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* ct,
            size_t len, uint8_t* tag) {
  uint8_t y[16] = {0}, lens[16], j0[16], e[16];
  ghashUpdate(y, h, aad, aadLen);
  ghashUpdate(y, h, ct, len);
  putBe64(lens, (uint64_t)aadLen * 8);
  putBe64(lens + 8, (uint64_t)len * 8);
  ghashUpdate(y, h, lens, 16);
  memcpy(j0, nonce, 12);
  j0[12] = j0[13] = j0[14] = 0;
  j0[15] = 1;
  aes.encrypt(j0, e);
  for (int k = 0; k < 16; k++) tag[k] = (uint8_t)(y[k] ^ e[k]);
}

void gcmCtr(const Aes& aes, const uint8_t* nonce, const uint8_t* in, size_t len, uint8_t* out) {
  uint8_t cb[16], ks[16];
  memcpy(cb, nonce, 12);
  uint32_t ctr = 2;  // 1 is for the tag
  for (size_t off = 0; off < len; off += 16) {
    cb[12] = (uint8_t)(ctr >> 24);
    cb[13] = (uint8_t)(ctr >> 16);
    cb[14] = (uint8_t)(ctr >> 8);
    cb[15] = (uint8_t)ctr;
    aes.encrypt(cb, ks);
    size_t n = len - off < 16 ? len - off : 16;
    for (size_t k = 0; k < n; k++) out[off + k] = (uint8_t)(in[off + k] ^ ks[k]);
    ctr++;
  }
}

bool refGcmSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                uint8_t* out, uint8_t* tag) {
  Aes aes(key);
  uint8_t zero[16] = {0}, h[16];
  aes.encrypt(zero, h);
  gcmCtr(aes, nonce, in, len, out);
  gcmTag(aes, h, nonce, aad, aadLen, out, len, tag);
  return true;
}

bool refGcmOpen(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                const uint8_t* tag, uint8_t* out) {
  Aes aes(key);
  uint8_t zero[16] = {0}, h[16], want[16];
  aes.encrypt(zero, h);
  gcmTag(aes, h, nonce, aad, aadLen, in, len, want);
  uint8_t diff = 0;
  for (int k = 0; k < 16; k++) diff |= (uint8_t)(want[k] ^ tag[k]);
  if (diff) return false;
  gcmCtr(aes, nonce, in, len, out);
  return true;
}

// ---- SHA-256, HMAC, HKDF ----
const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

struct Sha256 {
  uint32_t h[8];
  uint8_t buf[64];
  size_t used;
  uint64_t total;
  Sha256() : used(0), total(0) {
    static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(h, init, sizeof h);
  }
  void block(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) | ((uint32_t)p[4 * i + 2] << 8) | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
      uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  void update(const uint8_t* p, size_t n) {
    total += n;
    while (n) {
      size_t take = 64 - used < n ? 64 - used : n;
      memcpy(buf + used, p, take);
      used += take;
      p += take;
      n -= take;
      if (used == 64) {
        block(buf);
        used = 0;
      }
    }
  }
  void finish(uint8_t* out) {
    uint64_t bits = total * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (used != 56) update(&zero, 1);
    uint8_t len[8];
    putBe64(len, bits);
    update(len, 8);
    for (int i = 0; i < 8; i++) {
      out[4 * i] = (uint8_t)(h[i] >> 24);
      out[4 * i + 1] = (uint8_t)(h[i] >> 16);
      out[4 * i + 2] = (uint8_t)(h[i] >> 8);
      out[4 * i + 3] = (uint8_t)h[i];
    }
  }
};

void hmac(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  uint8_t k[64] = {0}, ipad[64], opad[64], inner[32];
  if (keyLen > 64) {
    Sha256 s;
    s.update(key, keyLen);
    s.finish(k);
  } else {
    memcpy(k, key, keyLen);
  }
  for (int i = 0; i < 64; i++) {
    ipad[i] = (uint8_t)(k[i] ^ 0x36);
    opad[i] = (uint8_t)(k[i] ^ 0x5c);
  }
  Sha256 a;
  a.update(ipad, 64);
  for (int i = 0; i < n; i++) a.update(parts[i], lens[i]);
  a.finish(inner);
  Sha256 b;
  b.update(opad, 64);
  b.update(inner, 32);
  b.finish(out);
}

}  // namespace

bool refHmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  hmac(key, keyLen, parts, lens, n, out);
  return true;
}

namespace {
// The same HKDF code as the device's, over the reference HMAC.
bool refHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
             uint8_t* okm, size_t okmLen) {
  return proto::hkdfSha256(refHmacSha256, ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
}
}  // namespace

const proto::Crypto& refCrypto() {
  static const proto::Crypto c = {refHkdf, refGcmSeal, refGcmOpen};
  return c;
}
