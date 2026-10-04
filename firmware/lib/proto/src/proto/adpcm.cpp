#include "proto/adpcm.h"

namespace proto {
const int16_t ADPCM_STEPS[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,    25,    28,    31,    34,
    37,    41,    45,    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,   130,   143,   157,   173,
    190,   209,   230,   253,   279,   307,   337,   371,   408,   449,   494,   544,   598,   658,   724,   796,   876,
    963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,  2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,
    4871,  5358,  5894,  6484,  7132,  7845,  8630,  9493,  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385,
    24623, 27086, 29794, 32767};
const int8_t ADPCM_INDEX[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

namespace {
int clampInt(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

// The change in the predictor that a nibble stands for, with the step it was coded at.
int delta(uint8_t nibble, int step) {
  int d = step >> 3;
  if (nibble & 4) d += step;
  if (nibble & 2) d += step >> 1;
  if (nibble & 1) d += step >> 2;
  return nibble & 8 ? -d : d;
}
}  // namespace

size_t adpcmFrameBytes(size_t n) { return ADPCM_HEADER + n / 2; }

size_t adpcmSampleCount(const uint8_t* frame, size_t len) {
  if (len < ADPCM_HEADER) return 0;
  uint8_t index = frame[2], pad = frame[3];
  if (index > ADPCM_MAX_INDEX || pad > 1 || (pad == 1 && len == ADPCM_HEADER)) return 0;
  return 1 + (len - ADPCM_HEADER) * 2 - pad;
}

size_t adpcmEncode(const int16_t* pcm, size_t n, uint8_t& index, uint8_t* out, size_t cap) {
  if (n == 0 || index > ADPCM_MAX_INDEX) return 0;
  size_t bytes = adpcmFrameBytes(n);
  if (cap < bytes) return 0;
  int pred = pcm[0];
  int idx = index;
  out[0] = (uint8_t)pred;
  out[1] = (uint8_t)((uint16_t)pcm[0] >> 8);
  out[2] = index;
  out[3] = (uint8_t)((n - 1) % 2);
  for (size_t i = 0; i + ADPCM_HEADER < bytes; i++) out[ADPCM_HEADER + i] = 0;
  for (size_t i = 1; i < n; i++) {
    int step = ADPCM_STEPS[idx];
    int diff = pcm[i] - pred;
    uint8_t nib = 0;
    if (diff < 0) {
      nib = 8;
      diff = -diff;
    }
    if (diff >= step) {
      nib |= 4;
      diff -= step;
    }
    if (diff >= (step >> 1)) {
      nib |= 2;
      diff -= step >> 1;
    }
    if (diff >= (step >> 2)) nib |= 1;
    pred = clampInt(pred + delta(nib, step), -32768, 32767);
    idx = clampInt(idx + ADPCM_INDEX[nib & 7], 0, ADPCM_MAX_INDEX);
    out[ADPCM_HEADER + ((i - 1) >> 1)] |= (uint8_t)(((i - 1) & 1) ? nib << 4 : nib);
  }
  index = (uint8_t)idx;
  return bytes;
}

size_t adpcmDecode(const uint8_t* frame, size_t len, int16_t* pcm, size_t cap) {
  size_t n = adpcmSampleCount(frame, len);
  if (n == 0 || n > cap) return 0;
  int pred = (int16_t)(frame[0] | (frame[1] << 8));
  int idx = frame[2];
  pcm[0] = (int16_t)pred;
  for (size_t i = 1; i < n; i++) {
    uint8_t byte = frame[ADPCM_HEADER + ((i - 1) >> 1)];
    uint8_t nib = ((i - 1) & 1) ? (uint8_t)(byte >> 4) : (uint8_t)(byte & 15);
    pred = clampInt(pred + delta(nib, ADPCM_STEPS[idx]), -32768, 32767);
    idx = clampInt(idx + ADPCM_INDEX[nib & 7], 0, ADPCM_MAX_INDEX);
    pcm[i] = (int16_t)pred;
  }
  return n;
}
}  // namespace proto
