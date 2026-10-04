#include "proto/netconf.h"
#include <string.h>

namespace proto {
namespace {
const uint8_t BLOB_VERSION = 1;

bool sameText(const uint8_t* a, size_t an, Text b) { return an == b.n && (an == 0 || memcmp(a, b.p, an) == 0); }

bool hostChar(uint8_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
}
}  // namespace

NetConf::NetConf() : store_(), s_(), generation_(0) {
  memset(&s_, 0, sizeof s_);
  store_.load = nullptr;
  store_.save = nullptr;
}

bool NetConf::begin(const NetStore& store) {
  if (!store.load || !store.save) return false;
  store_ = store;
  memset(&s_, 0, sizeof s_);
  uint8_t buf[NETCONF_BLOB_MAX + 1];
  size_t n = 0;
  State loaded;
  if (store_.load(buf, sizeof buf, n) && n <= NETCONF_BLOB_MAX && decode(buf, n, loaded)) s_ = loaded;
  return true;
}

size_t NetConf::encode(uint8_t* buf) const {
  uint8_t* p = buf;
  *p++ = BLOB_VERSION;
  *p++ = s_.n;
  for (uint8_t i = 0; i < s_.n; i++) {
    *p++ = s_.nets[i].sl;
    memcpy(p, s_.nets[i].ssid, s_.nets[i].sl);
    p += s_.nets[i].sl;
    *p++ = s_.nets[i].pl;
    memcpy(p, s_.nets[i].pass, s_.nets[i].pl);
    p += s_.nets[i].pl;
  }
  *p++ = s_.hl;
  memcpy(p, s_.host, s_.hl);
  p += s_.hl;
  return (size_t)(p - buf);
}

bool NetConf::decode(const uint8_t* buf, size_t n, State& s) {
  memset(&s, 0, sizeof s);
  if (n < 2 || buf[0] != BLOB_VERSION || buf[1] > NET_NETWORKS_MAX) return false;
  s.n = buf[1];
  size_t at = 2;
  for (uint8_t i = 0; i < s.n; i++) {
    if (at >= n) return false;
    size_t sl = buf[at++];
    if (sl < 1 || sl > NET_SSID_MAX || at + sl + 1 > n) return false;
    memcpy(s.nets[i].ssid, buf + at, sl);
    s.nets[i].sl = (uint8_t)sl;
    at += sl;
    size_t pl = buf[at++];
    if (pl > NET_PASS_MAX || (pl != 0 && pl < 8) || at + pl > n) return false;
    memcpy(s.nets[i].pass, buf + at, pl);
    s.nets[i].pl = (uint8_t)pl;
    at += pl;
  }
  if (at >= n) return false;
  size_t hl = buf[at++];
  if (hl > NET_HOST_MAX || at + hl != n) return false;
  for (size_t i = 0; i < hl; i++)
    if (!hostChar(buf[at + i])) return false;
  memcpy(s.host, buf + at, hl);
  s.hl = (uint8_t)hl;
  return true;
}

uint8_t NetConf::commit(const State& old) {
  uint8_t buf[NETCONF_BLOB_MAX];
  size_t n = encode(buf);
  if (!store_.save || !store_.save(buf, n)) {
    s_ = old;
    return NETERR_STORE;
  }
  generation_++;
  return 0;
}

int NetConf::find(Text ssid) const {
  for (uint8_t i = 0; i < s_.n; i++)
    if (sameText(s_.nets[i].ssid, s_.nets[i].sl, ssid)) return i;
  return -1;
}

uint8_t NetConf::add(Text ssid, Text pass) {
  if (ssid.n < 1 || ssid.n > NET_SSID_MAX || pass.n > NET_PASS_MAX || (pass.n != 0 && pass.n < 8)) return NETERR_BAD;
  State old = s_;
  int at = find(ssid);
  if (at >= 0) {
    if (sameText(s_.nets[at].pass, s_.nets[at].pl, pass)) return 0;  // as it was: nothing to write
  } else {
    if (s_.n >= NET_NETWORKS_MAX) return NETERR_FULL;
    at = s_.n++;
    memcpy(s_.nets[at].ssid, ssid.p, ssid.n);
    s_.nets[at].sl = (uint8_t)ssid.n;
  }
  memset(s_.nets[at].pass, 0, sizeof s_.nets[at].pass);
  if (pass.n) memcpy(s_.nets[at].pass, pass.p, pass.n);
  s_.nets[at].pl = (uint8_t)pass.n;
  return commit(old);
}

uint8_t NetConf::remove(Text ssid) {
  int at = find(ssid);
  if (at < 0) return NETERR_UNKNOWN;
  State old = s_;
  for (uint8_t i = (uint8_t)at; i + 1 < s_.n; i++) s_.nets[i] = s_.nets[i + 1];
  memset(&s_.nets[s_.n - 1], 0, sizeof s_.nets[0]);
  s_.n--;
  return commit(old);
}

uint8_t NetConf::setRelay(Text host) {
  if (host.n < 1 || host.n > NET_HOST_MAX) return NETERR_BAD;
  for (size_t i = 0; i < host.n; i++)
    if (!hostChar(host.p[i])) return NETERR_BAD;
  if (sameText(s_.host, s_.hl, host)) return 0;
  State old = s_;
  memset(s_.host, 0, sizeof s_.host);
  memcpy(s_.host, host.p, host.n);
  s_.hl = (uint8_t)host.n;
  return commit(old);
}

uint8_t NetConf::clearRelay() {
  if (s_.hl == 0) return 0;
  State old = s_;
  memset(s_.host, 0, sizeof s_.host);
  s_.hl = 0;
  return commit(old);
}

Text NetConf::ssid(size_t i) const { return i < s_.n ? Text{s_.nets[i].ssid, s_.nets[i].sl} : Text{nullptr, 0}; }
Text NetConf::pass(size_t i) const { return i < s_.n ? Text{s_.nets[i].pass, s_.nets[i].pl} : Text{nullptr, 0}; }
Text NetConf::relay() const { return s_.hl ? Text{s_.host, s_.hl} : Text{nullptr, 0}; }

size_t NetConf::handle(const NetMsg& m, uint8_t* out, size_t cap) {
  uint8_t err = 0;
  switch (m.op) {
    case NET_WIFI_ADD:
      err = add(m.ssid, m.pass);
      break;
    case NET_WIFI_REMOVE:
      err = remove(m.ssid);
      break;
    case NET_RELAY_SET:
      err = setRelay(m.host);
      break;
    case NET_RELAY_CLEAR:
      err = clearRelay();
      break;
    case NET_WIFI_LIST: {
      Text names[NET_NETWORKS_MAX];
      for (size_t i = 0; i < s_.n; i++) names[i] = ssid(i);
      return buildNetList(names, s_.n, relay(), out, cap);
    }
    default:
      err = NETERR_BAD;
      break;
  }
  return err ? buildNetErr(m.op, err, out, cap) : buildNetOk(m.op, out, cap);
}
}  // namespace proto
