// test_text.cpp: what the screen does with text that comes from outside: sanitize it, break it into lines of whole
// characters, cut a line to its room. Lines come out joined with '|' so that a wrap reads as one string.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "ui/text.h"

namespace {
std::string san(const std::vector<uint8_t>& in, size_t cap = 4096) {
  std::vector<char> out(cap);
  size_t n = ui::sanitize(in.data(), in.size(), out.data(), cap);
  return std::string(out.data(), n);
}
std::string san(const char* s, size_t cap = 4096) { return san(std::vector<uint8_t>(s, s + std::string(s).size()), cap); }

std::string wrapped(const std::string& text, unsigned cells = 30, size_t cap = 64) {
  std::vector<ui::Line> lines(cap);
  size_t n = ui::wrap(text.data(), text.size(), (uint8_t)cells, lines.data(), cap);
  std::string out;
  for (size_t i = 0; i < n; i++) {
    if (i) out += '|';
    out += text.substr(lines[i].start, lines[i].len);
  }
  return out;
}
size_t lineCount(const std::string& text, unsigned cells = 30, size_t cap = 64) {
  std::vector<ui::Line> lines(cap);
  return ui::wrap(text.data(), text.size(), (uint8_t)cells, lines.data(), cap);
}

std::string clipped(const std::string& text, unsigned cells, size_t cap = 256) {
  std::vector<char> out(cap);
  size_t n = ui::clip(text.data(), text.size(), (uint8_t)cells, out.data(), cap);
  return std::string(out.data(), n);
}

std::string repeat(const char* s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}
const char* ELLIPSIS = "\xE2\x80\xA6";

// The UTF-8 bytes of a code point, as a string.
std::string utf8(uint32_t cp) {
  std::string s;
  if (cp < 0x80) {
    s += (char)cp;
  } else if (cp < 0x800) {
    s += (char)(0xC0 | (cp >> 6));
    s += (char)(0x80 | (cp & 0x3F));
  } else {
    s += (char)(0xE0 | (cp >> 12));
    s += (char)(0x80 | ((cp >> 6) & 0x3F));
    s += (char)(0x80 | (cp & 0x3F));
  }
  return s;
}
}  // namespace

TEST(cellsAreOneForPrintableAsciiAndTwoForTheRest) {
  CHECK(ui::cellsOf('a') == 1 && ui::cellsOf(' ') == 1 && ui::cellsOf('~') == 1, "printable ASCII");
  CHECK(ui::cellsOf(0x597D) == 2, "a Chinese character");
  CHECK(ui::cellsOf(0xE9) == 2, "an accented Latin letter is counted as wide, so it never overflows a line");
  CHECK(ui::cellsOf(0x1F) == 2 && ui::cellsOf(0x7F) == 2, "so is a byte just outside printable ASCII, on either side");
}

TEST(sanitizeKeepsWhatCanBeDrawnAsItIs) {
  CHECK(san("hello, world") == "hello, world", "ASCII");
  CHECK(san("\xE5\xA5\xBD\xE7\x9A\x84") == "\xE5\xA5\xBD\xE7\x9A\x84", "Chinese");
  CHECK(san("a\nb") == "a\nb", "a newline stays");
  CHECK(san("caf\xC3\xA9") == "caf\xC3\xA9", "two-byte letters");
}

TEST(sanitizeReplacesMalformedBytesOneByOne) {
  CHECK(san({0x61, 0x80, 0x62}) == "a?b", "a lone continuation byte");
  CHECK(san({0xE5, 0xA5}) == "??", "a three-byte sequence cut after two bytes");
  CHECK(san({0xE5, 0xA5, 0x61}) == "??a", "a cut sequence does not swallow the character after it");
  CHECK(san({0xC0, 0x80}) == "??", "an overlong form");
  CHECK(san({0xED, 0xA0, 0x80}) == "???", "a surrogate");
  CHECK(san({0xFF, 0xFE}) == "??", "bytes that never occur in UTF-8");
  CHECK(san({0xF4, 0x90, 0x80, 0x80}) == "????", "beyond U+10FFFF");
  CHECK(san({0xE0, 0x9F, 0xBF}) == "???", "an overlong form of a three-byte character");
  CHECK(san({0xF0, 0x8F, 0xBF, 0xBF}) == "????", "an overlong form of a four-byte character");
  CHECK(san({0xF5, 0x80, 0x80, 0x80}) == "????", "a lead byte past F4");
  CHECK(san({0xE0, 0xA0, 0x80}) == "\xE0\xA0\x80", "the first three-byte character that is not overlong");
  CHECK(san({0xF0, 0x90, 0x80, 0x80}) == "?", "the first four-byte character that is not overlong, one the font cannot draw");
  const uint8_t cut[] = {0xE5, 0xA5, 0xBD};
  char out[16];
  CHECK(ui::sanitize(cut, 2, out, sizeof out) == 2 && std::string(out, 2) == "??", "a character that n cuts short is not read past n");
}

TEST(sanitizeTurnsWhatTheFontCannotDrawIntoAQuestionMark) {
  CHECK(san({0xF0, 0x9F, 0x98, 0x80}) == "?", "an emoji is one character, so one question mark");
  CHECK(san({0x61, 0xF0, 0x9F, 0x98, 0x80, 0x62}) == "a?b", "among text");
}

TEST(sanitizeDropsControlAndInvisibleCharacters) {
  CHECK(san({0x61, 0x01, 0x62}) == "a b", "a control character becomes a space");
  CHECK(san({0x61, 0x09, 0x62}) == "a b", "a tab too");
  CHECK(san({0x61, 0x0D, 0x0A, 0x62}) == "a\nb", "CR LF is one newline");
  CHECK(san({0x61, 0x7F, 0x62}) == "a b", "DEL");
  CHECK(san({0x61, 0xC2, 0x85, 0x62}) == "a b", "a C1 control (NEL)");
  CHECK(san({0x61, 0xE2, 0x80, 0x8B, 0x62}) == "ab", "zero width space goes");
  CHECK(san({0x61, 0xE2, 0x80, 0xAE, 0x62}) == "ab", "a right-to-left override goes: it would reverse the lines after it");
  CHECK(san({0xEF, 0xBB, 0xBF, 0x61}) == "a", "a byte order mark goes");
  CHECK(san({0x61, 0xC2, 0xAD, 0x62}) == "ab", "a soft hyphen goes");
  CHECK(san({0x61, 0xC2, 0x9F, 0x62}) == "a b", "the last C1 control");
  CHECK(san({0x61, 0xC2, 0xA0, 0x62}) == "a\xC2\xA0" "b", "and the no-break space after it is text");
}

TEST(sanitizeDropsExactlyTheInvisibleRunsAndNothingNextToThem) {
  const uint32_t gone[] = {0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
                           0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x00AD};
  for (uint32_t cp : gone) {
    char what[40];
    snprintf(what, sizeof what, "U+%04X goes", (unsigned)cp);
    CHECK(san(("a" + utf8(cp) + "b").c_str()) == "ab", what);
  }
  const uint32_t kept[] = {0x200A, 0x2010, 0x2029, 0x202F, 0x205F, 0x2065, 0xFEFE, 0xFF00, 0x00AC, 0x00AE};
  for (uint32_t cp : kept) {
    char what[40];
    snprintf(what, sizeof what, "U+%04X stays", (unsigned)cp);
    CHECK(san(("a" + utf8(cp) + "b").c_str()) == "a" + utf8(cp) + "b", what);
  }
}

TEST(sanitizeNeverWritesPastItsBufferOrEndsInHalfACharacter) {
  const char* two = "\xE5\xA5\xBD\xE5\xA5\xBD";
  CHECK(san(std::vector<uint8_t>(two, two + 6), 4) == "\xE5\xA5\xBD", "room for one of two three-byte characters");
  CHECK(san(std::vector<uint8_t>(two, two + 6), 3) == "", "two bytes of room hold none");
  CHECK(san(std::vector<uint8_t>(two, two + 6), 7) == two, "exactly enough room");
  char untouched = 'x';
  CHECK(ui::sanitize((const uint8_t*)"abc", 3, &untouched, 0) == 0 && untouched == 'x', "no room at all writes nothing");
  CHECK(san("abcdef", 4) == "abc", "ASCII is cut at the buffer");
  char buf[8];
  memset(buf, 'x', sizeof buf);
  CHECK(ui::sanitize((const uint8_t*)"ab", 2, buf, sizeof buf) == 2 && buf[2] == 0, "the text ends in a terminator");
  memset(buf, 'x', sizeof buf);
  CHECK(ui::sanitize((const uint8_t*)"", 0, buf, sizeof buf) == 0 && buf[0] == 0, "so does no text at all");
}

TEST(wrapKeepsShortTextOnOneLine) {
  CHECK(wrapped("hello world") == "hello world", "short");
  CHECK(lineCount("") == 0, "nothing");
  CHECK(lineCount(std::string(30, 'a')) == 1, "exactly 30 cells");
  CHECK(lineCount(std::string(31, 'a')) == 2, "31 cells");
}

TEST(wrapBreaksAfterANewlineAndKeepsBlankLines) {
  CHECK(wrapped("a\nb") == "a|b", "a newline");
  CHECK(wrapped("a\n\nb") == "a||b", "a blank line stays");
  CHECK(wrapped("a\n") == "a", "a trailing newline adds no line");
  CHECK(lineCount("\n") == 1, "a lone newline is one empty line");
}

TEST(wrapBreaksChineseAtAnyCharacterAndCountsTwoCells) {
  std::string forty = repeat("\xE5\xA5\xBD", 40);  // 40 characters, 80 cells
  std::vector<ui::Line> lines(64);
  size_t n = ui::wrap(forty.data(), forty.size(), 30, lines.data(), 64);
  CHECK(n == 3, "80 cells over 30-cell lines: 15, 15 and 10 characters");
  CHECK(lines[0].len == 45 && lines[1].len == 45 && lines[2].len == 30, "in bytes");
  CHECK(lineCount(repeat("\xE5\xA5\xBD", 15)) == 1 && lineCount(repeat("\xE5\xA5\xBD", 16)) == 2, "15 characters fit, 16 do not");
}

TEST(wrapBreaksAsciiAtSpacesWhenItCan) {
  CHECK(wrapped("aaaa bbbb", 6) == "aaaa|bbbb", "at the space");
  CHECK(wrapped("aaaa   bbbb", 5) == "aaaa|bbbb", "spaces left at the start of the next line are dropped");
  CHECK(wrapped("aaaaa bbbbb", 5) == "aaaaa|bbbbb", "a space right at the limit");
  CHECK(wrapped("abcdefghij", 4) == "abcd|efgh|ij", "a word longer than a line is cut at the limit");
  CHECK(wrapped("ab \xE5\xA5\xBD\xE5\xA5\xBD\xE5\xA5\xBD", 6) == "ab|\xE5\xA5\xBD\xE5\xA5\xBD\xE5\xA5\xBD", "ASCII then Chinese: the space is the break");
  CHECK(wrapped("one two three four", 9) == "one two|three|four", "words fill the line");
  CHECK(wrapped("a\n  b") == "a|  b", "an indent after a newline is kept: a preview is often code");
  CHECK(wrapped("aaaa bbbb", 4) == "aaaa|bbbb", "a break at a space leaves it out of both lines");
}

TEST(wrapKeepsAtMostTheLinesItIsGiven) {
  std::string many = repeat("x\n", 100);
  CHECK(lineCount(many, 30, 64) == 64, "100 lines into 64");
  CHECK(lineCount(many, 30, 5) == 5, "or 5");
  CHECK(lineCount(repeat("a", 5000), 30, 64) == 64, "5000 characters into 30-cell lines are cut at 64 lines");
}

TEST(wrapAlwaysMakesProgressEvenWhenACharacterIsWiderThanTheLine) {
  CHECK(wrapped("\xE5\xA5\xBD\xE5\xA5\xBD", 1) == "\xE5\xA5\xBD|\xE5\xA5\xBD", "a wide character on a one-cell line takes a line to itself");
}

TEST(clipLeavesWhatFitsAndEllipsesWhatDoesNot) {
  CHECK(clipped("hello", 30) == "hello", "fits");
  CHECK(clipped("abcdef", 1) == ELLIPSIS && clipped("abcdef", 0) == ELLIPSIS, "less room than the ellipsis takes: the ellipsis alone");
  CHECK(clipped("", 0) == "", "no text in no room is no text");
  CHECK(clipped(std::string(10, 'a'), 10) == std::string(10, 'a'), "exactly fits");
  CHECK(clipped(std::string(40, 'a'), 10) == std::string(8, 'a') + ELLIPSIS, "the ellipsis takes two cells");
  CHECK(clipped(repeat("\xE5\xA5\xBD", 10), 10) == repeat("\xE5\xA5\xBD", 4) + ELLIPSIS, "Chinese: 4 characters and the ellipsis is 10 cells");
  CHECK(clipped(repeat("\xE5\xA5\xBD", 5), 10) == repeat("\xE5\xA5\xBD", 5), "5 characters are 10 cells and fit");
}

TEST(clipNeverWritesPastItsBuffer) {
  CHECK(clipped("abcdef", 3, 5) == "a" + std::string(ELLIPSIS), "room for exactly that");
  CHECK(clipped("abcdefghijklmnop", 10, 3) == "ab", "too little room for an ellipsis: cut, within the buffer");
  CHECK(clipped("abcdefgh", 5, 6) == "abc", "an ellipsis that would leave no room for the terminator is left out");
  CHECK(clipped("abcdefgh", 5, 7) == "abc" + std::string(ELLIPSIS), "and one that just leaves it is kept");
  char buf[8];
  memset(buf, 'x', sizeof buf);
  CHECK(ui::clip("", 0, 4, buf, sizeof buf) == 0 && buf[0] == 0, "no text is a terminator and nothing else");
  char untouched = 'x';
  CHECK(ui::clip("abc", 3, 5, &untouched, 0) == 0 && untouched == 'x', "no room at all writes nothing");
}

TEST(cellsMeasuresAStringInCells) {
  CHECK(ui::cells("", 0) == 0, "nothing");
  CHECK(ui::cells("abc", 3) == 3, "ASCII");
  CHECK(ui::cells("\xE5\xA5\xBD" "a", 4) == 3, "one wide character and one narrow");
  CHECK(ui::cells("a\xE5\xA5", 3) == 5, "each byte of a cut character counts two: never too small");
  CHECK(ui::cells("abcdef", 3) == 3, "only the first n bytes");
  CHECK(ui::cells("\xE5\xA5\xBD", 2) == 4, "a character that n cuts is not read past n: its two bytes are bad ones");
}
