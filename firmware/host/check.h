// check.h: a minimal harness for the firmware's host tests (built and run by run.mjs).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

struct TestCase {
  const char* name;
  void (*fn)();
  TestCase* next;
  TestCase(const char* n, void (*f)());
};

// TEST(name) { ... } defines a case that test_main.cpp runs.
#define TEST(name)                          \
  static void name();                       \
  static TestCase name##_case(#name, name); \
  static void name()

extern int g_pass, g_fail;
#define CHECK(cond, what)                                             \
  do {                                                                \
    if (cond) {                                                       \
      g_pass++;                                                       \
    } else {                                                          \
      g_fail++;                                                       \
      printf("FAIL %s:%d %s\n", __FILE__, __LINE__, (const char*)(what)); \
    }                                                                 \
  } while (0)

std::vector<uint8_t> unhex(const char* h);
std::string tohex(const uint8_t* p, size_t n);
