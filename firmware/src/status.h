// status.h: counters and settings shared between tasks; the screen shows them.
#pragma once
#include <atomic>
#include <stdint.h>

struct Status {
  std::atomic<uint32_t> rxBad{0};      // bad chunks from the PC
  std::atomic<uint32_t> rxGaps{0};     // gaps in the PC's seq since its last HELLO
  std::atomic<uint32_t> txDropped{0};  // frames the TX queue had no room for, or that a paired S3 had no session to seal with
  std::atomic<uint32_t> rxRefused{0};  // frames refused for being plain when sealed was required, or for failing their tag or counter
  std::atomic<uint32_t> rxOther{0};    // frames from the transport not in use (spec 5.3)
  std::atomic<uint32_t> relayLost{0};  // frames from the relay there was no room for
  std::atomic<uint8_t> volume{255};    // speaker volume (spec D9)
  std::atomic<uint8_t> micGain{2};     // mic magnification (spec §6.2)
  std::atomic<uint32_t> takes{0};
  std::atomic<uint32_t> lastTakeMs{0};
  std::atomic<bool> playing{false};
  std::atomic<uint32_t> ringFill{0};
  std::atomic<uint32_t> underruns{0};
  std::atomic<uint8_t> micLevel{0};    // peak of the last 20 ms of a take, 0 to 255 of full scale
};

extern Status g_status;
