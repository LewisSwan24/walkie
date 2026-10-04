// netconf_nvs.cpp: see netconf_nvs.h.
#include "netconf_nvs.h"
#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

namespace netconf {
namespace {
const char* const NS = "walkie";
const char* const KEY = "netconf";

proto::NetConf conf;
SemaphoreHandle_t lock = nullptr;

bool load(uint8_t* buf, size_t cap, size_t& n) {
  Preferences p;
  if (!p.begin(NS, true)) return false;
  size_t len = p.getBytesLength(KEY);
  bool ok = len > 0 && len <= cap && p.getBytes(KEY, buf, len) == len;
  p.end();
  if (ok) n = len;
  return ok;
}

bool save(const uint8_t* buf, size_t n) {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = p.putBytes(KEY, buf, n) == n;
  p.end();
  return ok;
}

void copy(char* to, size_t cap, proto::Text t) {
  size_t n = t.n < cap - 1 ? t.n : cap - 1;
  if (n) memcpy(to, t.p, n);
  to[n] = 0;
}
}  // namespace

void begin() {
  lock = xSemaphoreCreateMutex();
  proto::NetStore s;
  s.load = load;
  s.save = save;
  conf.begin(s);
}

size_t handle(const proto::NetMsg& m, uint8_t* out, size_t cap) {
  xSemaphoreTake(lock, portMAX_DELAY);
  size_t n = conf.handle(m, out, cap);
  xSemaphoreGive(lock);
  return n;
}

void snapshot(Snapshot& s) {
  memset(&s, 0, sizeof s);
  xSemaphoreTake(lock, portMAX_DELAY);
  s.count = (uint8_t)conf.count();
  for (size_t i = 0; i < conf.count(); i++) {
    copy(s.nets[i].ssid, sizeof s.nets[i].ssid, conf.ssid(i));
    copy(s.nets[i].pass, sizeof s.nets[i].pass, conf.pass(i));
  }
  copy(s.host, sizeof s.host, conf.relay());
  s.generation = conf.generation();
  xSemaphoreGive(lock);
}

uint32_t generation() {
  xSemaphoreTake(lock, portMAX_DELAY);
  uint32_t g = conf.generation();
  xSemaphoreGive(lock);
  return g;
}
}  // namespace netconf
