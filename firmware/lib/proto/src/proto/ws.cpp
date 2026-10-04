#include "proto/ws.h"
#include <string.h>

namespace proto {
namespace {
const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 16 bytes as 24 base64 characters (the last two are padding).
void base64Key(const uint8_t* in, char* out) {
  size_t o = 0;
  for (size_t i = 0; i < WS_KEY_BYTES; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < WS_KEY_BYTES) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < WS_KEY_BYTES) v |= in[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = i + 1 < WS_KEY_BYTES ? B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < WS_KEY_BYTES ? B64[v & 63] : '=';
  }
}

bool printable(const char* s) {
  if (!s || !*s) return false;
  for (; *s; s++)
    if ((uint8_t)*s < 0x21 || (uint8_t)*s > 0x7e) return false;
  return true;
}

char lower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c; }

// a[0..an) equals the NUL-terminated word, ignoring case.
bool same(const char* a, size_t an, const char* word) {
  size_t wn = strlen(word);
  if (an != wn) return false;
  for (size_t i = 0; i < an; i++)
    if (lower(a[i]) != word[i]) return false;
  return true;
}

void trim(const char*& p, size_t& n) {
  while (n && (*p == ' ' || *p == '\t')) p++, n--;
  while (n && (p[n - 1] == ' ' || p[n - 1] == '\t')) n--;
}

// A comma-separated header value has `word` as one of its tokens.
bool hasToken(const char* v, size_t n, const char* word) {
  size_t start = 0;
  for (size_t i = 0; i <= n; i++) {
    if (i == n || v[i] == ',') {
      const char* t = v + start;
      size_t tn = i - start;
      trim(t, tn);
      if (same(t, tn, word)) return true;
      start = i + 1;
    }
  }
  return false;
}
}  // namespace

size_t wsRequest(const char* host, const char* path, const uint8_t key[WS_KEY_BYTES], char* out, size_t cap) {
  if (!printable(host) || !printable(path) || path[0] != '/') return 0;
  char k[25];
  base64Key(key, k);
  k[24] = 0;
  const char* parts[] = {"GET ", path, " HTTP/1.1\r\nHost: ", host,
                         "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ", k,
                         "\r\nSec-WebSocket-Version: 13\r\n\r\n"};
  size_t n = 0;
  for (const char* p : parts) {
    size_t pn = strlen(p);
    if (n + pn + 1 > cap) return 0;
    memcpy(out + n, p, pn);
    n += pn;
  }
  out[n] = 0;
  return n;
}

int wsResponse(const uint8_t* buf, size_t n, size_t& headerLen, int& status) {
  status = 0;
  const char* s = (const char*)buf;
  size_t limit = n < WS_HTTP_MAX ? n : WS_HTTP_MAX;
  size_t end = 0;
  for (size_t i = 0; i + 4 <= limit; i++) {
    if (memcmp(s + i, "\r\n\r\n", 4) == 0) {
      end = i + 4;
      break;
    }
  }
  if (!end) return n >= WS_HTTP_MAX ? WS_HTTP_BAD : WS_HTTP_MORE;
  // The status line: HTTP/1.1, a space, three digits, then a space or the end of the line.
  if (end < 14 || memcmp(s, "HTTP/1.1 ", 9) != 0) return WS_HTTP_BAD;
  for (size_t i = 9; i < 12; i++)
    if (s[i] < '0' || s[i] > '9') return WS_HTTP_BAD;
  if (s[12] != ' ' && s[12] != '\r') return WS_HTTP_BAD;
  status = (s[9] - '0') * 100 + (s[10] - '0') * 10 + (s[11] - '0');
  bool upgrade = false, connection = false;
  size_t at = 0;
  while (memcmp(s + at, "\r\n", 2) != 0) at++;
  at += 2;
  while (at + 2 <= end - 2) {  // each header line, up to the blank line
    size_t eol = at;
    while (memcmp(s + eol, "\r\n", 2) != 0) eol++;
    const char* colon = (const char*)memchr(s + at, ':', eol - at);
    if (colon) {
      const char* name = s + at;
      size_t nn = (size_t)(colon - name);
      const char* v = colon + 1;
      size_t vn = (size_t)(s + eol - v);
      trim(v, vn);
      if (same(name, nn, "upgrade")) upgrade = same(v, vn, "websocket");
      if (same(name, nn, "connection")) connection = hasToken(v, vn, "upgrade");
    }
    at = eol + 2;
  }
  if (status != 101 || !upgrade || !connection) return WS_HTTP_BAD;
  headerLen = end;
  return WS_HTTP_OK;
}

size_t wsEncode(uint8_t opcode, const uint8_t* payload, size_t n, const uint8_t mask[4], uint8_t* out, size_t cap) {
  if (n > WS_MAX_PAYLOAD) return 0;
  size_t head = n < 126 ? 2 : 4;
  if (head + 4 + n > cap) return 0;
  out[0] = (uint8_t)(0x80 | (opcode & 0x0f));
  if (n < 126) {
    out[1] = (uint8_t)(0x80 | n);
  } else {
    out[1] = 0x80 | 126;
    out[2] = (uint8_t)(n >> 8);
    out[3] = (uint8_t)n;
  }
  memcpy(out + head, mask, 4);
  for (size_t i = 0; i < n; i++) out[head + 4 + i] = (uint8_t)(payload[i] ^ mask[i % 4]);
  return head + 4 + n;
}

int wsDecode(const uint8_t* buf, size_t n, WsFrame& f) {
  if (n < 2) return 0;
  uint8_t op = buf[0] & 0x0f;
  if (!(buf[0] & 0x80) || (buf[0] & 0x70) || (buf[1] & 0x80)) return -1;
  if (op != WS_BINARY && op != WS_CLOSE && op != WS_PING && op != WS_PONG) return -1;
  size_t len = buf[1] & 0x7f, head = 2;
  if (len == 127) return -1;
  if (len == 126) {
    if (n < 4) return 0;
    len = ((size_t)buf[2] << 8) | buf[3];
    head = 4;
  }
  if (len > WS_MAX_PAYLOAD || (op != WS_BINARY && len > WS_CONTROL_MAX)) return -1;
  if (n < head + len) return 0;
  f.opcode = op;
  f.payload = buf + head;
  f.n = len;
  return (int)(head + len);
}

uint16_t wsCloseCode(const WsFrame& f) { return f.n >= 2 ? (uint16_t)((f.payload[0] << 8) | f.payload[1]) : 1005; }
}  // namespace proto
