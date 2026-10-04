// machine.h: what is on the screen and what the keys do about it (spec 6.2 and 6.3). Pure logic, compiled on the PC by
// firmware/host. It owns no hardware: gestures, frames from the PC and the clock go in; actions for the main loop to carry
// out come out, and view() says what to draw.
//
// Six screens come from the PC as UI frames (Idle to Error). The rest are the device's own and sit above them:
//   PairConfirm > SwitchConfirm > Offline > Listening > Approval > the PC's screen.
// SwitchConfirm is above Offline so that the device can be switched back to app0 when the bridge is not running. PairConfirm is
// above both: `walkie pair` runs with the bridge not pinging, and a request for a key must be answered on the device.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"
#include "ui/gesture.h"
#include "ui/text.h"

namespace ui {

const uint8_t COLS = 30;                           // a 240-pixel line in cells (text.h)
const uint8_t BODY_LINES = 6;                      // lines of text under the header
const uint8_t APPROVAL_LINES = BODY_LINES - 1;     // the hint line takes one
const size_t MAX_LINES = 64;                       // lines kept of a text, however long it is
const size_t TEXT_CAP = 1024;                      // bytes kept of a text
const uint32_t SWITCH_TIMEOUT_MS = 10000;
const uint32_t PAIR_TIMEOUT_MS = 30000;  // no answer is no

enum class Screen : uint8_t {
  Idle = proto::UI_IDLE,
  Transcribing = proto::UI_TRANSCRIBING,
  Confirm = proto::UI_CONFIRM,
  Working = proto::UI_WORKING,
  Reply = proto::UI_REPLY,
  Error = proto::UI_ERROR,
  Approval = 6,
  Listening = 7,
  SwitchConfirm = 8,
  Offline = 9,
  PairConfirm = 10,
};

// For logs: "idle", "approval" and so on.
const char* screenName(Screen s);

enum class Act : uint8_t {
  PrepareTalk,   // the front key went down: the mic may start filling its pre-roll
  CommitTalk,    // the hold reached 300 ms: the take is on; arg 1 when it is a spoken reason for a denial
  EndTalk,       // the take is over, or was never committed (then it is dropped without a word)
  StopAudio,     // cut the reply that is playing
  SendButton,    // arg: proto::BTN_*
  SendApproval,  // id; arg 1 allow; arg2 1 when the spoken reason follows
  BootApp0,      // restart into app0
  PairAnswer,    // arg 1 yes, 0 no (also when the time ran out): tell the link
};
struct Action {
  Act act;
  uint8_t arg;
  uint8_t arg2;
  uint16_t id;
};

struct View {
  Screen screen;
  const char* project;  // sanitized
  const char* tool;     // Approval
  const char* text;     // the body lines index into this
  Line lines[BODY_LINES];  // what to draw of the body
  uint8_t nLines;
  bool more;            // the text goes on beyond what is shown (not on Reply, which pages)
  uint8_t page, pages;  // Reply: from 0
  bool hasElapsed;
  uint32_t elapsedMs;   // Working: as of this call, counted on from the PC's last figure
  bool switching;       // SwitchConfirm after the front key: the device is about to restart
  uint8_t pairOp;       // PairConfirm: proto::PAIR_SET or PAIR_FORGET
  uint32_t pairLeftMs;  // PairConfirm: until it counts as no
};

class Machine {
 public:
  Machine();

  void onGesture(Ev ev, uint32_t now);
  void onUi(const proto::UiView& v, uint32_t now);
  void onApprovalReq(const proto::ApprovalReq& r, uint32_t now);
  // A PAIR request (proto::PAIR_SET or PAIR_FORGET) from the link: front key yes, side key no, 30 s is no. The same request again
  // changes nothing; another op replaces it and starts the 30 s over.
  void onPairRequest(uint8_t op, uint32_t now);
  // Every loop: whether pings still arrive, and whether a reply is playing.
  void tick(uint32_t now, bool linkUp, bool speakerBusy);

  bool next(Action& a);  // the actions in the order they were decided; false when there are none
  Screen screen() const;
  View view(uint32_t now) const;

 private:
  enum class Talk : uint8_t { Off, Prepared, Live };

  bool canTalk() const;
  void push(Act act, uint8_t arg = 0, uint8_t arg2 = 0, uint16_t id = 0);
  void answer(bool allow, bool reasonFollows);
  void answerPair(bool yes);
  void dropTalk();
  void clearBase();

  Screen base_;
  bool offline_;
  Talk talk_;
  bool reasonTake_;
  uint16_t reasonId_;
  bool speakerBusy_;

  bool approval_;
  uint16_t approvalId_;
  bool frontSawApproval_;  // the approval was on the screen when the front key went down
  uint16_t frontApprovalId_;
  char tool_[72];
  char preview_[TEXT_CAP];
  Line previewLines_[MAX_LINES];
  size_t nPreview_;

  char project_[72];
  char text_[TEXT_CAP];
  Line lines_[MAX_LINES];
  size_t nLines_;
  uint8_t page_;
  bool hasElapsed_;
  uint32_t elapsedMs_, elapsedAt_;

  bool switchOpen_, switching_;
  uint32_t switchDeadline_;

  bool pairOpen_;
  uint8_t pairOp_;
  uint32_t pairDeadline_;
  bool frontSawPair_;  // the request was on the screen when the front key went down

  Action queue_[16];
  size_t head_, count_;
};

}  // namespace ui
