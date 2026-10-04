// adpcm.h: IMA-ADPCM, 4 bits a sample (protocol/frames.md, "Audio codec"). A frame is self-contained: a 4-byte header (sample 0
// as s16 LE, the step index in effect for sample 1, a pad flag), then the nibbles of samples 1 to n-1, the first one in the low
// half of a byte. Integer arithmetic only, so every implementation decodes to the same bits as bridge/src/link/adpcm.js.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t ADPCM_HEADER = 4;
const uint8_t ADPCM_MAX_INDEX = 88;
extern const int16_t ADPCM_STEPS[89];
extern const int8_t ADPCM_INDEX[8];

// Bytes a frame of n samples (n >= 1) takes.
size_t adpcmFrameBytes(size_t n);

// Samples a frame holds, or 0 when it cannot be a frame: shorter than its header, an index above 88, a pad flag that is not 0 or
// 1, or padding with no nibble to pad.
size_t adpcmSampleCount(const uint8_t* frame, size_t len);

// Encodes n >= 1 samples into out and returns the frame's length; 0 when n is 0, cap is too small or index is above 88. index
// goes in as the step index to start from and comes out as the one to start the next frame from.
size_t adpcmEncode(const int16_t* pcm, size_t n, uint8_t& index, uint8_t* out, size_t cap);

// Decodes a frame into pcm and returns the sample count; 0 when the frame is invalid or more than cap samples.
size_t adpcmDecode(const uint8_t* frame, size_t len, int16_t* pcm, size_t cap);
}  // namespace proto
