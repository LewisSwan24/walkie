// gesture.h: turns the two keys' states into the gestures of spec 6.2. Pure logic, compiled on the PC by firmware/host.
//
// The key that goes down first owns the gesture. A second key that comes down within CHORD_WINDOW_MS of the first makes
// a chord, which can only lead to SWITCH_CONFIRM; a second key that comes down later is ignored until it is released,
// so a finger resting on the side key never turns the front key's talk into something else.
#pragma once
#include <stdint.h>

namespace ui {

enum class Ev : uint8_t {
  None,
  FrontDown,   // the front key went down on its own: a talk may start, the mic can begin to fill its pre-roll
  FrontShort,  // released within HOLD_MS
  TalkStart,   // held for HOLD_MS: the talk begins (the pre-roll goes out)
  TalkEnd,     // released after TalkStart
  SideShort,   // released within HOLD_MS
  SideHold,    // held for SIDE_HOLD_MS; once per press, and the release after it is no event
  ChordStart,  // both keys down within CHORD_WINDOW_MS of each other: any talk that FrontDown prepared is off
  ChordHold,   // both keys held for CHORD_HOLD_MS, counted from the later key's press; once per chord
};

// One update has at most two events: TalkStart and TalkEnd together, when the loop saw a hold only at its release.
struct Events {
  Ev ev[2];
  uint8_t n;
};

class Gesture {
 public:
  static const uint32_t HOLD_MS = 300;
  static const uint32_t CHORD_WINDOW_MS = 150;
  static const uint32_t SIDE_HOLD_MS = 1000;
  static const uint32_t CHORD_HOLD_MS = 3000;

  Gesture() : state_(Idle), t0_(0), blockFront_(false), blockSide_(false), holdSent_(false) {}

  // Call every few milliseconds with the keys as they are now; `now` is in milliseconds and may wrap.
  Events update(uint32_t now, bool front, bool side);

 private:
  enum State : uint8_t { Idle, Front, Talk, Side, Chord };
  State state_;
  uint32_t t0_;         // when the owner key went down, or when the second key of a chord did
  bool blockFront_;     // down, and ignored until it is released
  bool blockSide_;
  bool holdSent_;       // SideHold or ChordHold has been sent for this press
};

}  // namespace ui
