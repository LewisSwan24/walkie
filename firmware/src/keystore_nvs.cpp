// keystore_nvs.cpp: see keystore_nvs.h.
#include "keystore_nvs.h"
#include <Preferences.h>

namespace {
const char* const NS = "walkie";
const char* const KEY = "pairkey";

bool load(uint8_t* key) {
  Preferences p;
  if (!p.begin(NS, true)) return false;
  bool ok = p.getBytesLength(KEY) == proto::KEY_BYTES && p.getBytes(KEY, key, proto::KEY_BYTES) == proto::KEY_BYTES;
  p.end();
  return ok;
}

bool save(const uint8_t* key) {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = p.putBytes(KEY, key, proto::KEY_BYTES) == proto::KEY_BYTES;
  p.end();
  return ok;
}

bool erase() {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = !p.isKey(KEY) || p.remove(KEY);
  p.end();
  return ok;
}
}  // namespace

const proto::KeyStore& nvsKeyStore() {
  static const proto::KeyStore s = {load, save, erase};
  return s;
}
