// pattern.h: the uplink test pattern (protocol/frames.md, TEST UP_PATTERN).
#pragma once
#include <stdint.h>

namespace proto {
inline uint16_t patternSample(uint32_t k) { return (uint16_t)(k * 1103u + 12345u); }
}  // namespace proto
