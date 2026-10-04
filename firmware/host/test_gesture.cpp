// test_gesture.cpp: the key gestures of spec 6.2 and the key scripts that stand in for fingers. A timeline is a list of
// "at t ms the keys are f, s"; the detector is updated every 10 ms, as the UI loop does, and the events come out as text:
// "0:FrontDown 300:TalkStart 500:TalkEnd".
#include <string>
#include <vector>
#include "check.h"
#include "ui/gesture.h"
#include "ui/keyscript.h"

namespace {
struct At {
  uint32_t t;
  bool front, side;
};

const char* name(ui::Ev e) {
  switch (e) {
    case ui::Ev::FrontDown: return "FrontDown";
    case ui::Ev::FrontShort: return "FrontShort";
    case ui::Ev::TalkStart: return "TalkStart";
    case ui::Ev::TalkEnd: return "TalkEnd";
    case ui::Ev::SideShort: return "SideShort";
    case ui::Ev::SideHold: return "SideHold";
    case ui::Ev::ChordStart: return "ChordStart";
    case ui::Ev::ChordHold: return "ChordHold";
    default: return "None";
  }
}

// Updates every 10 ms from `start` to `end` (relative times); the keys are those of the last change at or before the time.
std::string run(const std::vector<At>& timeline, uint32_t end, uint32_t start = 0) {
  ui::Gesture g;
  std::string out;
  bool f = false, s = false;
  for (uint32_t t = 0; t <= end; t += 10) {
    for (const At& a : timeline)
      if (a.t <= t) f = a.front, s = a.side;
    ui::Events ev = g.update(start + t, f, s);
    for (int i = 0; i < ev.n; i++) {
      if (!out.empty()) out += ' ';
      out += std::to_string(t) + ":" + name(ev.ev[i]);
    }
  }
  return out;
}
const bool F = true, S = true, N = false;
}  // namespace

TEST(aShortFrontPressIsNotATalk) {
  CHECK(run({{0, F, N}, {100, N, N}}, 600) == "0:FrontDown 100:FrontShort", "100 ms");
  CHECK(run({{0, F, N}, {290, N, N}}, 600) == "0:FrontDown 290:FrontShort", "290 ms is still short");
}

TEST(aFrontHoldIsATalkFromThreeHundredMilliseconds) {
  CHECK(run({{0, F, N}, {500, N, N}}, 800) == "0:FrontDown 300:TalkStart 500:TalkEnd", "500 ms");
  CHECK(run({{0, F, N}, {310, N, N}}, 800) == "0:FrontDown 300:TalkStart 310:TalkEnd", "just past 300 ms");
  CHECK(run({{0, F, N}, {5000, N, N}}, 6000) == "0:FrontDown 300:TalkStart 5000:TalkEnd", "a long take");
}

TEST(aHoldThatTheLoopOnlySeesAtItsReleaseIsStillATalk) {
  CHECK(run({{0, F, N}, {300, N, N}}, 600) == "0:FrontDown 300:TalkStart 300:TalkEnd", "released on the update that reaches 300 ms");
}

TEST(theSideKeyShortHoldAndTheMiddle) {
  CHECK(run({{0, N, S}, {100, N, N}}, 600) == "100:SideShort", "short");
  CHECK(run({{0, N, S}, {290, N, N}}, 600) == "290:SideShort", "290 ms is still short");
  CHECK(run({{0, N, S}, {300, N, N}}, 600) == "", "300 ms is not");
  CHECK(run({{0, N, S}, {500, N, N}}, 1500) == "", "between a short press and the 1 s hold is nothing");
  CHECK(run({{0, N, S}, {1500, N, N}}, 2000) == "1000:SideHold", "held 1 s: once, and the release is no event");
  CHECK(run({{0, N, S}, {4000, N, N}}, 5000) == "1000:SideHold", "held for longer: still once");
}

TEST(bothKeysWithinTheWindowAreAChordAndNeverATalk) {
  CHECK(run({{0, F, N}, {100, F, S}, {3500, N, N}}, 4000) == "0:FrontDown 100:ChordStart 3100:ChordHold",
        "front, then side 100 ms later; the hold counts from the later key");
  CHECK(run({{0, N, S}, {100, F, S}, {3500, N, N}}, 4000) == "100:ChordStart 3100:ChordHold", "side first");
  CHECK(run({{0, F, S}, {3500, N, N}}, 4000) == "0:ChordStart 3000:ChordHold", "both in the same update");
}

TEST(aChordReleasedEarlyIsNothingAndTheKeysWorkAgainAfterwards) {
  CHECK(run({{0, F, S}, {1000, N, N}, {1500, F, N}, {1600, N, N}}, 2000) == "0:ChordStart 1500:FrontDown 1600:FrontShort",
        "released before 3 s");
  CHECK(run({{0, F, S}, {500, F, N}, {2000, N, N}}, 3000) == "0:ChordStart", "one key let go and the other kept: still the chord's");
  CHECK(run({{0, F, S}, {500, F, N}, {4000, N, N}}, 5000) == "0:ChordStart", "and kept past 3 s it is still no hold: the hold takes both keys");
}

TEST(aSecondKeyAfterTheWindowIsIgnoredUntilItIsReleased) {
  CHECK(run({{0, F, N}, {140, F, S}, {500, N, N}}, 3500) == "0:FrontDown 140:ChordStart", "140 ms is inside the window");
  CHECK(run({{0, F, N}, {150, F, S}, {600, N, N}}, 3500) == "0:FrontDown 300:TalkStart 600:TalkEnd",
        "150 ms is outside it: the talk goes on and the side key does nothing");
  CHECK(run({{0, F, N}, {200, F, S}, {250, N, S}, {400, N, N}}, 1500) == "0:FrontDown 250:FrontShort",
        "the late side key's own release is no event");
  CHECK(run({{0, N, S}, {200, F, S}, {250, F, N}, {400, N, N}}, 1500) == "250:SideShort", "a front key that is late is ignored too");
  CHECK(run({{0, N, S}, {200, F, S}, {1500, N, N}}, 2000) == "1000:SideHold", "and the side key's hold still counts");
  CHECK(run({{0, N, S}, {140, F, S}, {500, N, N}}, 3500) == "140:ChordStart", "the window is the same when the side key comes first");
  CHECK(run({{0, N, S}, {150, F, S}, {250, N, N}}, 600) == "250:SideShort", "and 150 ms is outside it there too");
}

TEST(aKeyThatWasIgnoredForBeingLateWorksAgainOnceItIsLetGo) {
  CHECK(run({{0, N, S}, {200, F, S}, {250, F, N}, {400, N, N}, {600, F, N}, {700, N, N}}, 1500) == "250:SideShort 600:FrontDown 700:FrontShort",
        "the late front key, pressed again");
  CHECK(run({{0, F, N}, {200, F, S}, {250, N, S}, {400, N, N}, {600, N, S}, {700, N, N}}, 1500) == "0:FrontDown 250:FrontShort 700:SideShort",
        "the late side key, pressed again");
}

TEST(theSideKeyPressedInTheMiddleOfATalkDoesNothing) {
  CHECK(run({{0, F, N}, {400, F, S}, {600, F, N}, {800, N, N}}, 1500) == "0:FrontDown 300:TalkStart 800:TalkEnd", "side pressed and released during a talk");
  CHECK(run({{0, F, N}, {400, F, S}, {800, N, S}, {1000, F, S}}, 1500) == "0:FrontDown 300:TalkStart 800:TalkEnd 1000:FrontDown 1300:TalkStart",
        "a side key still resting does not stop the next press of the front key");
}

TEST(timeMayWrapAroundWhileAKeyIsHeld) {
  CHECK(run({{0, F, N}, {500, N, N}}, 800, 0xFFFFFF00u) == "0:FrontDown 300:TalkStart 500:TalkEnd", "a talk across the wrap");
  CHECK(run({{0, F, S}, {3500, N, N}}, 4000, 0xFFFFFF00u) == "0:ChordStart 3000:ChordHold", "a chord across the wrap");
}

TEST(aKeyScriptPressesTheKeysAtTheTimesItNames) {
  ui::KeyScript k;
  proto::KeyStep steps[] = {{0, 1}, {50, 3}, {3000, 0}};
  CHECK(k.mask(500) == 0 && !k.running(), "nothing runs before a script is loaded");
  k.load(steps, 3, 1000);
  CHECK(k.running(), "running");
  CHECK(k.mask(1000) == 1, "the first step, with no delay, applies at once");
  CHECK(k.mask(1049) == 1 && k.mask(1050) == 3, "the second step is 50 ms after the first");
  CHECK(k.mask(4049) == 3 && k.running(), "the third waits 3000 ms after the second");
  CHECK(k.mask(4050) == 0 && !k.running(), "and then the keys are up and the script is over");
  CHECK(k.mask(99999) == 0, "it stays so");
}

TEST(aKeyScriptSurvivesTheClockWrapping) {
  ui::KeyScript k;
  proto::KeyStep steps[] = {{0, 1}, {100, 0}};
  k.load(steps, 2, 0xFFFFFFF0u);
  CHECK(k.mask(0xFFFFFFF0u) == 1 && k.mask(0x53) == 1 && k.mask(0x54) == 0, "100 ms from 0xFFFFFFF0 is 0x54");
}

TEST(aNewKeyScriptReplacesTheOldOneAndReleasesItsKeys) {
  ui::KeyScript k;
  proto::KeyStep a[] = {{0, 3}, {10000, 0}};
  proto::KeyStep b[] = {{500, 1}, {100, 0}};
  k.load(a, 2, 0);
  CHECK(k.mask(0) == 3, "the first script holds both keys");
  k.load(b, 2, 100);
  CHECK(k.mask(100) == 0 && k.mask(599) == 0 && k.mask(600) == 1 && k.mask(700) == 0, "the second starts from its own load time, keys up");
}

TEST(aKeyScriptLongerThanTheBufferIsCutNotOverrun) {
  ui::KeyScript k;
  proto::KeyStep many[40];
  for (int i = 0; i < 40; i++) many[i] = {10, (uint8_t)(i % 2 ? 0 : 1)};
  k.load(many, 40, 0);
  CHECK(k.mask(10 * 16) == 0 && !k.running(), "only 16 steps are kept: the sixteenth is the last");
}

TEST(aKeyScriptDrivesTheGestureLikeFingers) {
  ui::KeyScript k;
  ui::Gesture g;
  proto::KeyStep steps[] = {{0, proto::KEY_FRONT}, {500, 0}};
  k.load(steps, 2, 0);
  std::string out;
  for (uint32_t t = 0; t <= 800; t += 10) {
    uint8_t m = k.mask(t);
    ui::Events ev = g.update(t, (m & proto::KEY_FRONT) != 0, (m & proto::KEY_SIDE) != 0);
    for (int i = 0; i < ev.n; i++) out += (out.empty() ? "" : " ") + std::to_string(t) + ":" + name(ev.ev[i]);
  }
  CHECK(out == "0:FrontDown 300:TalkStart 500:TalkEnd", out.c_str());
}
