// Host stub of the bits of Arduino and FreeRTOS that firmware/src/audio.cpp uses. Single-threaded: the tests drive the
// RX-task and audio-task functions by hand, in the interleavings they want to check.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef uint32_t TickType_t;
typedef void (*TaskFunction_t)(void*);

extern uint32_t g_ms;              // the fake clock, in milliseconds
extern void (*g_onDelay)();        // runs inside vTaskDelay and Mic.record: stands for another task or the key being released

inline uint32_t millis() { return g_ms; }
inline void vTaskDelay(uint32_t t) {
  g_ms += t;
  if (g_onDelay) g_onDelay();
}
inline TickType_t xTaskGetTickCount() { return g_ms; }
inline void vTaskDelayUntil(TickType_t* last, TickType_t inc) {
  *last += inc;
  if (g_ms < *last) g_ms = *last;
  if (g_onDelay) g_onDelay();
}
#define pdMS_TO_TICKS(x) (x)
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
inline void* heap_caps_malloc(size_t n, int) { return malloc(n); }
inline int xTaskCreatePinnedToCore(TaskFunction_t, const char*, int, void*, int, void*, int) { return 1; }
