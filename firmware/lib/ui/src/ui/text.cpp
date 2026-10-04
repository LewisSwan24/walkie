#include "ui/text.h"

namespace ui {
namespace {

// The length of the well-formed UTF-8 sequence at p (RFC 3629: no overlong forms, no surrogates, nothing past U+10FFFF)
// and its code point, or 0 when there is none.
size_t decode(const uint8_t* p, size_t n, uint32_t& cp) {
  if (n == 0) return 0;
  uint8_t b = p[0];
  if (b < 0x80) {
    cp = b;
    return 1;
  }
  size_t len;
  uint8_t lo = 0x80, hi = 0xBF;  // the range of the second byte
  if (b >= 0xC2 && b <= 0xDF) {
    len = 2;
    cp = b & 0x1F;
  } else if (b >= 0xE0 && b <= 0xEF) {
    len = 3;
    cp = b & 0x0F;
    if (b == 0xE0) lo = 0xA0;  // not overlong
    if (b == 0xED) hi = 0x9F;  // not a surrogate
  } else if (b >= 0xF0 && b <= 0xF4) {
    len = 4;
    cp = b & 0x07;
    if (b == 0xF0) lo = 0x90;
    if (b == 0xF4) hi = 0x8F;
  } else {
    return 0;
  }
  if (n < len) return 0;
  for (size_t i = 1; i < len; i++) {
    uint8_t c = p[i];
    if (c < (i == 1 ? lo : 0x80) || c > (i == 1 ? hi : 0xBF)) return 0;
    cp = (cp << 6) | (c & 0x3F);
  }
  return len;
}

bool invisible(uint32_t cp) {
  return (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2060 && cp <= 0x2064) || cp == 0xFEFF ||
         cp == 0x00AD;
}

}  // namespace

uint8_t cellsOf(uint32_t cp) { return cp >= 0x20 && cp <= 0x7E ? 1 : 2; }

size_t cells(const char* text, size_t n) {
  const uint8_t* t = (const uint8_t*)text;
  size_t total = 0;
  for (size_t i = 0; i < n;) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    total += len == 1 ? cellsOf(t[i]) : 2;
    i += len;
  }
  return total;
}

size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap) {
  if (cap == 0) return 0;
  size_t out = 0, i = 0;
  while (i < n) {
    uint32_t cp = 0;
    size_t len = decode(src + i, n - i, cp);
    const char* put = nullptr;  // what replaces the character, when it is not copied as it is
    size_t putLen = 0;
    char one = 0;
    if (len == 0) {
      len = 1;  // one bad byte at a time, so that a bad lead byte does not swallow the good text after it
      one = '?';
    } else if (cp > 0xFFFF) {
      one = '?';
    } else if (cp == '\n') {
      one = '\n';
    } else if (cp == '\r' || invisible(cp)) {
      i += len;
      continue;
    } else if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) {
      one = ' ';
    }
    if (one) {
      put = &one;
      putLen = 1;
    } else {
      put = (const char*)src + i;
      putLen = len;
    }
    if (out + putLen > cap - 1) break;  // never half a character
    for (size_t k = 0; k < putLen; k++) dst[out++] = put[k];
    i += len;
  }
  dst[out] = 0;
  return out;
}

size_t wrap(const char* text, size_t n, uint8_t cells, Line* out, size_t cap) {
  size_t lines = 0, i = 0;
  const uint8_t* t = (const uint8_t*)text;
  while (i < n && lines < cap) {
    size_t start = i, j = i;
    unsigned width = 0;
    size_t lastSpace = 0;  // where the last space in this line is, 0 for none (a space at `start` is never a break)
    bool broke = false;    // the line ended at the limit, not at a '\n' or the end of the text
    size_t next = n;
    while (j < n) {
      if (t[j] == '\n') {
        next = j + 1;
        break;
      }
      uint32_t cp = 0;
      size_t len = decode(t + j, n - j, cp);
      if (len == 0) len = 1;  // sanitized text has none; be safe all the same
      unsigned w = len == 1 ? cellsOf(t[j]) : 2;
      if (width + w > cells) {
        broke = true;
        if (lastSpace > start) {  // break at the space; the line is what is before it
          next = lastSpace + 1;
          j = lastSpace;
        } else if (j > start) {
          next = j;
        } else {  // not even one character fits: take it anyway, so that every line makes progress
          j += len;
          next = j;
        }
        break;
      }
      if (t[j] == ' ') lastSpace = j;
      width += w;
      j += len;
    }
    out[lines].start = (uint16_t)start;
    out[lines].len = (uint16_t)(j - start);
    lines++;
    i = next;
    if (broke)
      while (i < n && t[i] == ' ') i++;
    if (i >= n) break;
  }
  return lines;
}

size_t clip(const char* text, size_t n, uint8_t cells, char* dst, size_t cap) {
  if (cap == 0) return 0;
  const uint8_t* t = (const uint8_t*)text;
  unsigned total = 0;
  for (size_t i = 0; i < n;) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    total += len == 1 ? cellsOf(t[i]) : 2;
    i += len;
  }
  bool cut = total > cells;
  unsigned room = cut ? (cells >= 2 ? cells - 2u : 0u) : cells;  // the ellipsis takes two cells
  size_t out = 0, i = 0;
  unsigned width = 0;
  while (i < n) {
    uint32_t cp = 0;
    size_t len = decode(t + i, n - i, cp);
    if (len == 0) len = 1;
    unsigned w = len == 1 ? cellsOf(t[i]) : 2;
    if (width + w > room || out + len > cap - 1) break;
    for (size_t k = 0; k < len; k++) dst[out++] = (char)t[i + k];
    width += w;
    i += len;
  }
  if (cut && out + 3 <= cap - 1) {  // U+2026 HORIZONTAL ELLIPSIS
    dst[out++] = (char)0xE2;
    dst[out++] = (char)0x80;
    dst[out++] = (char)0xA6;
  }
  dst[out] = 0;
  return out;
}

}  // namespace ui
