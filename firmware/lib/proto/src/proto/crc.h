// crc.h: checksums of the link (protocol/frames.md).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
// CRC-16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, no final XOR.
uint16_t crc16(const uint8_t* p, size_t n);
// CRC-32 as zlib computes it. Start from 0; pass the previous result to continue.
uint32_t crc32Update(uint32_t crc, const uint8_t* p, size_t n);
}  // namespace proto
