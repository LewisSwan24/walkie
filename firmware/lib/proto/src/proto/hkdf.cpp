#include "proto/hkdf.h"
#include <string.h>

namespace proto {
bool hkdfSha256(HmacSha256 hmac, const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info,
                size_t infoLen, uint8_t* okm, size_t okmLen) {
  if (!hmac || okmLen > 255 * 32 || infoLen > HKDF_MAX_INFO) return false;
  uint8_t zeros[32] = {0}, prk[32];
  const uint8_t* ikmParts[1] = {ikm};
  size_t ikmLens[1] = {ikmLen};
  if (saltLen == 0) {
    if (!hmac(zeros, sizeof zeros, ikmParts, ikmLens, 1, prk)) return false;
  } else if (!hmac(salt, saltLen, ikmParts, ikmLens, 1, prk)) {
    return false;
  }
  uint8_t t[32];
  size_t tLen = 0;
  for (size_t done = 0, i = 1; done < okmLen; i++) {
    uint8_t counter = (uint8_t)i;
    const uint8_t* parts[3] = {t, info, &counter};
    size_t lens[3] = {tLen, infoLen, 1};
    if (!hmac(prk, sizeof prk, parts, lens, 3, t)) return false;
    tLen = sizeof t;
    size_t take = okmLen - done < sizeof t ? okmLen - done : sizeof t;
    memcpy(okm + done, t, take);
    done += take;
  }
  return true;
}
}  // namespace proto
