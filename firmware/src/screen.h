// screen.h: draws a ui::View on the 240x135 display through an off-screen canvas, and can send that canvas to the PC (TEST
// SNAP). The layout is a 16-pixel header, six 16-pixel lines of body and a 16-pixel hint line; efontCN_16 draws 8 pixels
// to an ASCII character and 16 to a Chinese one, so a line is 30 cells (ui/text.h).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "ui/machine.h"

namespace screen {

struct Extras {
  uint8_t battery;   // percent
  uint8_t micLevel;  // g_status.micLevel
  bool playing;      // a reply is playing: the hint on REPLY changes
  const char* offline;  // the line under 未连接 on OFFLINE: ui::offlineHint()
};

bool begin();  // false when the canvas could not be allocated: nothing is drawn then
// Redraws only when something it shows has changed since the last call.
void draw(const ui::View& v, const Extras& x);

// TEST SNAP: freezes the picture, then hands the canvas out as RGB565 chunks, two rows to a chunk, for the main loop to send
// at its own pace. snapNext() writes a TEST payload (proto::buildSnapChunk) and returns true until the last chunk has gone;
// after that, drawing goes on.
bool snapStart();
bool snapNext(uint8_t* out, size_t cap, size_t& len);

}  // namespace screen
