// text.h: what the screen needs to do with text that comes from outside: make it safe to draw, break it into lines of
// whole characters, and cut a line to the room it has. Pure logic, compiled on the PC by firmware/host.
//
// Widths are counted in cells: efontCN_16 draws ASCII 8 pixels wide and a Chinese character 16, so a 240-pixel screen is 30
// cells. A character the font draws narrower than two cells (an accented Latin letter) is counted as two, which wastes a
// little room and never overflows the line.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ui {

// 1 for printable ASCII, 2 for everything else.
uint8_t cellsOf(uint32_t codePoint);

// The width of UTF-8 text in cells. A malformed byte counts two cells, although sanitize() would make it a one-cell '?', so
// for text that has been sanitized this is exact, and for text that has not it is never too small.
size_t cells(const char* text, size_t n);

// Copies UTF-8 into dst, NUL-terminated and at most cap - 1 bytes, keeping only what can be drawn: a malformed sequence
// (a lone continuation byte, a cut one, an overlong form, a surrogate) and any character beyond U+FFFF become '?'; a
// control character other than '\n' becomes a space, except '\r', which goes; zero-width and bidirectional format
// characters go. The copy ends on a character boundary. Returns the length without the NUL (0 when cap is 0).
size_t sanitize(const uint8_t* src, size_t n, char* dst, size_t cap);

struct Line {
  uint16_t start;  // byte offsets into the text that was wrapped
  uint16_t len;
};

// Breaks sanitized text into lines of at most `cells` cells: after each '\n' (blank lines are kept, a trailing '\n' adds
// none), at the last space before the limit when there is one, otherwise at the limit. Spaces that a break would leave at
// the start of the next line are dropped. Writes at most cap lines and returns how many; text beyond them is not shown.
size_t wrap(const char* text, size_t n, uint8_t cells, Line* out, size_t cap);

// One line cut to `cells` cells: unchanged when it fits, otherwise its beginning and an ellipsis. NUL-terminated within
// cap; returns the length without the NUL.
size_t clip(const char* text, size_t n, uint8_t cells, char* dst, size_t cap);

}  // namespace ui
