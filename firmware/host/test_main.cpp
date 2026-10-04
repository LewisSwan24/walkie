// test_main.cpp: runs every TEST() defined in the other host test files.
#include "check.h"

int g_pass = 0, g_fail = 0;
static TestCase* g_first = nullptr;

TestCase::TestCase(const char* n, void (*f)()) : name(n), fn(f), next(g_first) { g_first = this; }

std::vector<uint8_t> unhex(const char* h) {
  std::vector<uint8_t> out;
  for (size_t i = 0; h[i] && h[i + 1]; i += 2) {
    unsigned v = 0;
    sscanf(h + i, "%2x", &v);
    out.push_back((uint8_t)v);
  }
  return out;
}

std::string tohex(const uint8_t* p, size_t n) {
  static const char* digits = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += digits[p[i] >> 4];
    s += digits[p[i] & 15];
  }
  return s;
}

int main() {
  int cases = 0;
  for (TestCase* t = g_first; t; t = t->next, cases++) t->fn();
  printf("%d cases, %d checks passed, %d failed\n", cases, g_pass, g_fail);
  return g_fail ? 1 : 0;
}
