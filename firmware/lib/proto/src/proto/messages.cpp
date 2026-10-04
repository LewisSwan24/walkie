#include "proto/messages.h"
#include <string.h>

namespace proto {
namespace {
uint8_t* put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  return p + 2;
}
uint8_t* put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
  return p + 4;
}
// An SSID or password goes to WiFi.begin() as a C string, so a NUL in one cannot be honoured.
bool hasNul(Text t) { return t.n != 0 && memchr(t.p, 0, t.n) != nullptr; }
uint32_t get32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
}  // namespace

size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce, uint32_t nonceS,
                  uint8_t flags, const char* version, uint8_t* out, size_t cap) {
  size_t vlen = strlen(version);
  if (cap < 23 + vlen) return 0;
  uint8_t* p = out;
  *p++ = PROTO_VERSION;
  *p++ = 0;
  p = put16(p, upRate);
  p = put16(p, downRate);
  p = put32(p, ringBytes);
  p = put32(p, uptimeMs);
  p = put32(p, nonce);
  p = put32(p, nonceS);
  *p++ = flags;
  memcpy(p, version, vlen);
  return 23 + vlen;
}

size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap) {
  if (cap < 2) return 0;
  out[0] = op;
  out[1] = answered;
  return 2;
}

size_t buildNetOk(uint8_t answered, uint8_t* out, size_t cap) {
  if (cap < 2) return 0;
  out[0] = NET_OK;
  out[1] = answered;
  return 2;
}

size_t buildNetErr(uint8_t answered, uint8_t reason, uint8_t* out, size_t cap) {
  if (cap < 3) return 0;
  out[0] = NET_ERR;
  out[1] = answered;
  out[2] = reason;
  return 3;
}

size_t buildNetList(const Text* ssids, size_t count, Text host, uint8_t* out, size_t cap) {
  if (count > NET_NETWORKS_MAX || host.n > NET_HOST_MAX) return 0;
  size_t need = 2 + 1 + host.n;
  for (size_t i = 0; i < count; i++) {
    if (ssids[i].n < 1 || ssids[i].n > NET_SSID_MAX) return 0;
    need += 1 + ssids[i].n;
  }
  if (cap < need) return 0;
  uint8_t* p = out;
  *p++ = NET_LIST;
  *p++ = (uint8_t)count;
  for (size_t i = 0; i < count; i++) {
    *p++ = (uint8_t)ssids[i].n;
    memcpy(p, ssids[i].p, ssids[i].n);
    p += ssids[i].n;
  }
  *p++ = (uint8_t)host.n;
  if (host.n) memcpy(p, host.p, host.n);
  return need;
}

size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap) {
  if (cap < 16) return 0;
  put32(put32(put32(put32(out, token), uptimeMs), badChunks), seqGaps);
  return 16;
}

size_t buildCredit(uint32_t bytes, uint8_t* out, size_t cap) {
  if (cap < 4) return 0;
  put32(out, bytes);
  return 4;
}

size_t buildPlayed(const Played& pl, uint8_t* out, size_t cap) {
  if (cap < 17) return 0;
  uint8_t* p = put32(put32(put32(put32(out, pl.bytes), pl.crc32), pl.underruns), pl.maxFill);
  *p = pl.reason;
  return 17;
}

size_t buildButton(uint8_t event, uint8_t* out, size_t cap) {
  if (cap < 1) return 0;
  out[0] = event;
  return 1;
}

size_t buildApprovalRes(uint16_t id, bool allow, bool reasonFollows, uint8_t* out, size_t cap) {
  if (cap < 4) return 0;
  put16(out, id);
  out[2] = allow ? 1 : 0;
  out[3] = reasonFollows ? 1 : 0;
  return 4;
}

size_t buildSnapChunk(uint16_t index, uint16_t count, uint16_t width, uint16_t height, const uint8_t* pixels,
                      size_t pixelBytes, uint8_t* out, size_t cap) {
  if (cap < 9 + pixelBytes) return 0;
  out[0] = TEST_SNAP;
  put16(put16(put16(put16(out + 1, index), count), width), height);
  memcpy(out + 9, pixels, pixelBytes);
  return 9 + pixelBytes;
}

bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce) {
  if (n < 5) return false;
  nonce = get32(p + 1);
  return true;
}

bool parsePair(const uint8_t* p, size_t n, PairMsg& m) {
  if (n == 33 && p[0] == PAIR_SET) {
    m.op = PAIR_SET;
    m.key = p + 1;
    return true;
  }
  if (n == 1 && p[0] == PAIR_FORGET) {
    m.op = PAIR_FORGET;
    m.key = nullptr;
    return true;
  }
  return false;
}

bool parsePing(const uint8_t* p, size_t n, uint32_t& token) {
  if (n < 4) return false;
  token = get32(p);
  return true;
}

bool parseNet(const uint8_t* p, size_t n, NetMsg& m) {
  if (n < 1) return false;
  m.op = p[0];
  m.ssid = Text{nullptr, 0};
  m.pass = Text{nullptr, 0};
  m.host = Text{nullptr, 0};
  switch (p[0]) {
    case NET_WIFI_ADD: {
      if (n < 2 || p[1] < 1 || p[1] > NET_SSID_MAX || n < (size_t)2 + p[1] + 1) return false;
      size_t pl = p[2 + p[1]];
      if (n != (size_t)2 + p[1] + 1 + pl || pl > NET_PASS_MAX || (pl != 0 && pl < 8)) return false;
      m.ssid = Text{p + 2, p[1]};
      m.pass = Text{p + 3 + p[1], pl};
      return !hasNul(m.ssid) && !hasNul(m.pass);
    }
    case NET_WIFI_REMOVE:
      if (n < 2 || p[1] < 1 || p[1] > NET_SSID_MAX || n != (size_t)2 + p[1]) return false;
      m.ssid = Text{p + 2, p[1]};
      return !hasNul(m.ssid);
    case NET_RELAY_SET:
      if (n < 2 || p[1] < 1 || p[1] > NET_HOST_MAX || n != (size_t)2 + p[1]) return false;
      for (size_t i = 0; i < p[1]; i++) {
        uint8_t c = p[2 + i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
        if (!ok) return false;
      }
      m.host = Text{p + 2, p[1]};
      return true;
    case NET_WIFI_LIST:
    case NET_RELAY_CLEAR:
      return n == 1;
    default:
      return false;
  }
}

bool parseCmd(const uint8_t* p, size_t n, Command& c) {
  if (n < 1) return false;
  if ((p[0] == CMD_SET_VOLUME || p[0] == CMD_SET_MIC_GAIN || p[0] == CMD_SET_CODEC) && n < 2) return false;
  c.op = p[0];
  c.arg = n >= 2 ? p[1] : 0;
  return true;
}

bool parseTest(const uint8_t* p, size_t n, TestOp& t) {
  if (n < 1) return false;
  t.op = p[0];
  t.args = p + 1;
  t.len = n - 1;
  return true;
}

bool parseUpPattern(const uint8_t* args, size_t n, uint16_t& frames) {
  if (n < 2) return false;
  frames = (uint16_t)(args[0] | (args[1] << 8));
  return true;
}

bool parseMicSource(const uint8_t* args, size_t n, bool& on) {
  if (n < 1) return false;
  on = args[0] != 0;
  return true;
}

bool parseKeys(const uint8_t* args, size_t n, KeyStep* out, size_t cap, size_t& count) {
  if (n < 1 || args[0] < 1 || args[0] > cap || n != 1 + (size_t)args[0] * 3) return false;
  count = args[0];
  for (size_t i = 0; i < count; i++) {
    const uint8_t* s = args + 1 + i * 3;
    out[i].delayMs = (uint16_t)(s[0] | (s[1] << 8));
    out[i].mask = s[2];
  }
  return true;
}

bool parseUi(const uint8_t* p, size_t n, UiView& v) {
  if (n < 1 || p[0] > UI_ERROR) return false;
  v = UiView();
  v.state = p[0];
  for (size_t at = 1; at < n;) {
    if (at + 3 > n) return false;
    uint8_t tag = p[at];
    size_t len = (size_t)(p[at + 1] | (p[at + 2] << 8));
    if (at + 3 + len > n) return false;
    const uint8_t* body = p + at + 3;
    if (tag == 1) v.project = {body, len};
    else if (tag == 2) v.text = {body, len};
    else if (tag == 3 && len == 4) {
      v.hasElapsed = true;
      v.elapsedMs = get32(body);
    }
    at += 3 + len;
  }
  return true;
}

bool parseApprovalReq(const uint8_t* p, size_t n, ApprovalReq& r) {
  if (n < 3 || 3 + (size_t)p[2] > n) return false;
  r.id = (uint16_t)(p[0] | (p[1] << 8));
  r.tool = {p + 3, p[2]};
  r.preview = {p + 3 + p[2], n - 3 - p[2]};
  return true;
}
}  // namespace proto
