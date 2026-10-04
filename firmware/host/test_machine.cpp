// test_machine.cpp: the screens and what the keys do on each (spec 6.2 and 6.3). A Sim wires a Gesture to a Machine the
// way the UI loop does: every 10 ms the keys are read, the machine is ticked, and the gesture's events go in. The actions
// that come out are read as text: "Prepare Commit0 End".
#include <string>
#include "check.h"
#include "ui/gesture.h"
#include "ui/machine.h"

namespace {
using ui::Screen;

std::string actions(ui::Machine& m) {
  std::string out;
  ui::Action a;
  while (m.next(a)) {
    if (!out.empty()) out += ' ';
    switch (a.act) {
      case ui::Act::PrepareTalk: out += "Prepare"; break;
      case ui::Act::CommitTalk: out += a.arg ? "Commit1" : "Commit0"; break;
      case ui::Act::EndTalk: out += "End"; break;
      case ui::Act::StopAudio: out += "Stop"; break;
      case ui::Act::SendButton: out += "Btn" + std::to_string(a.arg); break;
      case ui::Act::SendApproval:
        out += std::string(a.arg ? "Allow" : (a.arg2 ? "DenyReason" : "Deny")) + std::to_string(a.id);
        break;
      case ui::Act::BootApp0: out += "Boot"; break;
      case ui::Act::PairAnswer: out += a.arg ? "PairYes" : "PairNo"; break;
    }
  }
  return out;
}

proto::UiView uiFrame(uint8_t state, const std::string& project = "", const std::string& text = "", int elapsed = -1) {
  static std::string keepProject, keepText;  // the view points into them until the next call
  keepProject = project;
  keepText = text;
  proto::UiView v;
  v.state = state;
  v.project = {(const uint8_t*)keepProject.data(), keepProject.size()};
  v.text = {(const uint8_t*)keepText.data(), keepText.size()};
  v.hasElapsed = elapsed >= 0;
  v.elapsedMs = elapsed >= 0 ? (uint32_t)elapsed : 0;
  return v;
}

proto::ApprovalReq request(uint16_t id, const std::string& tool, const std::string& preview) {
  static std::string keepTool, keepPreview;
  keepTool = tool;
  keepPreview = preview;
  proto::ApprovalReq r;
  r.id = id;
  r.tool = {(const uint8_t*)keepTool.data(), keepTool.size()};
  r.preview = {(const uint8_t*)keepPreview.data(), keepPreview.size()};
  return r;
}

struct Sim {
  ui::Machine m;
  ui::Gesture g;
  uint32_t now = 1000;
  bool link = true, busy = false;

  Sim() { m.tick(now, link, busy); }

  void step(bool front, bool side) {
    now += 10;
    m.tick(now, link, busy);
    ui::Events ev = g.update(now, front, side);
    for (int i = 0; i < ev.n; i++) m.onGesture(ev.ev[i], now);
  }
  void hold(uint32_t ms, bool front, bool side) {
    for (uint32_t t = 0; t < ms; t += 10) step(front, side);
  }
  // A key pressed for `ms` and let go, then a pause that lets the gesture settle.
  void front(uint32_t ms) { hold(ms, true, false), hold(20, false, false); }
  void side(uint32_t ms) { hold(ms, false, true), hold(20, false, false); }
  void show(const proto::UiView& v) { m.onUi(v, now); }
  Screen screen() const { return m.screen(); }
  std::string acts() { return actions(m); }
};
}  // namespace

TEST(theMachineIsOfflineUntilTheLinkIsUpThenShowsTheBridgeScreen) {
  ui::Machine m;
  CHECK(m.screen() == Screen::Offline, "a machine nobody has pinged yet");
  m.tick(100, true, false);
  CHECK(m.screen() == Screen::Idle, "pings arrive");
  m.tick(200, false, false);
  CHECK(m.screen() == Screen::Offline, "and stop");
}

TEST(aUiFrameSetsTheScreenAndAnUnknownStateIsIgnored) {
  Sim s;
  const Screen all[] = {Screen::Idle, Screen::Transcribing, Screen::Confirm, Screen::Working, Screen::Reply, Screen::Error};
  for (uint8_t i = 0; i < 6; i++) {
    s.show(uiFrame(i, "walkie"));
    CHECK(s.screen() == all[i], ui::screenName(all[i]));
  }
  s.show(uiFrame(3));
  s.show(uiFrame(9));
  CHECK(s.screen() == Screen::Working, "state 9 changes nothing");
}

TEST(aTalkIsPreparedAtFrontDownCommittedAtTheHoldAndEndedAtTheRelease) {
  Sim s;
  s.hold(100, true, false);
  CHECK(s.acts() == "Prepare" && s.screen() == Screen::Idle, "down: the mic may start its pre-roll, nothing on screen yet");
  s.hold(300, true, false);
  CHECK(s.acts() == "Commit0" && s.screen() == Screen::Listening, "300 ms: the take is on");
  s.hold(20, false, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Idle, "release");
}

TEST(aShortFrontPressOutsideAnApprovalPreparesThenDropsTheTalk) {
  Sim s;
  s.front(100);
  CHECK(s.acts() == "Prepare End", "no take, nothing sent, nothing on screen");
  CHECK(s.screen() == Screen::Idle, "still idle");
}

TEST(talkingIsAllowedInIdleWorkingReplyAndError) {
  const uint8_t ok[] = {proto::UI_IDLE, proto::UI_WORKING, proto::UI_REPLY, proto::UI_ERROR};
  for (uint8_t st : ok) {
    Sim s;
    s.show(uiFrame(st));
    s.hold(400, true, false);
    CHECK(s.acts() == "Prepare Commit0", "allowed");
  }
}

TEST(talkingIsRefusedWhileTranscribingConfirmingOfflineOrSwitching) {
  const uint8_t no[] = {proto::UI_TRANSCRIBING, proto::UI_CONFIRM};
  for (uint8_t st : no) {
    Sim s;
    s.show(uiFrame(st));
    s.hold(400, true, false);
    CHECK(s.acts() == "", "the bridge is busy with the last take");
  }
  Sim off;
  off.link = false;
  off.hold(400, true, false);
  CHECK(off.acts() == "", "offline");
  Sim sw;
  sw.hold(3100, true, true);
  sw.hold(20, false, false);
  sw.acts();
  sw.hold(400, true, false);
  CHECK(sw.acts() == "", "switch confirm");
}

TEST(anApprovalIsShownOverTheScreenBeforeItAndFrontShortAllowsIt) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash", 4000));
  s.m.onApprovalReq(request(7, "Bash", "rm -rf build"), s.now);
  CHECK(s.screen() == Screen::Approval, "over working");
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.tool) == "Bash" && std::string(v.text, v.lines[0].start, v.lines[0].len) == "rm -rf build", "tool and preview");
  s.front(100);
  CHECK(s.acts() == "Prepare End Allow7", "a front tap allows");
  CHECK(s.screen() == Screen::Working, "and the approval is gone from the screen at once");
}

TEST(sideShortDeniesAnApproval) {
  Sim s;
  s.m.onApprovalReq(request(8, "Edit", "x"), s.now);
  s.side(100);
  CHECK(s.acts() == "Deny8" && s.screen() == Screen::Idle, "denied, no reason");
}

TEST(frontHeldInAnApprovalRecordsTheReasonAndDeniesAtTheRelease) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit1" && s.screen() == Screen::Listening, "the take is flagged as a reason");
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9", "the take ends, then the denial that says a reason follows");
  CHECK(s.screen() == Screen::Idle, "the approval is over");
}

TEST(aReasonTakeKeepsTheIdItStartedWithEvenIfTheApprovalWasClearedMeanwhile) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  s.acts();
  s.show(uiFrame(proto::UI_WORKING));
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9", "the bridge ignores an id it no longer knows; the take is flagged all the same");
}

TEST(aTakeThatStartedBeforeTheApprovalIsNotAReason) {
  Sim s;
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit0", "a normal take");
  s.m.onApprovalReq(request(5, "Bash", "ls"), s.now);
  s.hold(20, false, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Approval, "it ends as one, and the approval waits");
}

TEST(aUiFrameFromTheBridgeEndsAnApproval) {
  Sim s;
  s.m.onApprovalReq(request(7, "Bash", "ls"), s.now);
  s.show(uiFrame(proto::UI_WORKING));
  CHECK(s.screen() == Screen::Working, "the bridge answered or timed it out");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and a tap no longer answers anything");
}

TEST(sideShortDependsOnTheScreen) {
  Sim cf;
  cf.show(uiFrame(proto::UI_CONFIRM, "p", "hello"));
  cf.side(100);
  CHECK(cf.acts() == "Btn1", "cancel in CONFIRM");

  Sim pl;
  pl.show(uiFrame(proto::UI_REPLY, "p", "hello"));
  pl.busy = true;
  pl.side(100);
  CHECK(pl.acts() == "Stop", "stop the audio while it plays");
  pl.busy = false;
  pl.side(100);
  CHECK(pl.acts() == "Btn3", "a one-page reply: dismiss when the audio is over");

  Sim er;
  er.show(uiFrame(proto::UI_ERROR, "p", "no network"));
  er.side(100);
  CHECK(er.acts() == "Btn3", "dismiss an error");

  Sim id;
  id.show(uiFrame(proto::UI_IDLE, "p"));
  id.side(100);
  CHECK(id.acts() == "", "nothing to do in IDLE");
  Sim wk;
  wk.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  wk.side(100);
  CHECK(wk.acts() == "", "nothing in WORKING either: a short press does not stop it");
  Sim tr;
  tr.show(uiFrame(proto::UI_TRANSCRIBING, "p"));
  tr.side(100);
  CHECK(tr.acts() == "", "nor in TRANSCRIBING");
}

TEST(sideShortTurnsThePagesOfALongReplyThenDismisses) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 14; i++) text += "line " + std::to_string(i) + (i < 14 ? "\n" : "");  // 14 lines: 3 pages of 6, 6, 2
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  ui::View v = s.m.view(s.now);
  CHECK(v.pages == 3 && v.page == 0 && v.nLines == 6, "page 1 of 3");
  CHECK(std::string(v.text, v.lines[0].start, v.lines[0].len) == "line 1", "from the first line");
  s.side(100);
  v = s.m.view(s.now);
  CHECK(s.acts() == "" && v.page == 1 && std::string(v.text, v.lines[0].start, v.lines[0].len) == "line 7", "page 2");
  s.side(100);
  v = s.m.view(s.now);
  CHECK(v.page == 2 && v.nLines == 2 && std::string(v.text, v.lines[1].start, v.lines[1].len) == "line 14", "page 3 has what is left");
  s.side(100);
  CHECK(s.acts() == "Btn3", "past the last page: dismiss");
}

TEST(aNewUiFrameStartsTheReplyOnItsFirstPage) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 14; i++) text += "line\n";
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  s.side(100);
  CHECK(s.m.view(s.now).page == 1, "turned");
  s.show(uiFrame(proto::UI_REPLY, "p", text));
  CHECK(s.m.view(s.now).page == 0, "a frame, say the resend after a reconnect, starts over");
}

TEST(sideHeldInWorkingStopsTheTurnAndNowhereElse) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  s.hold(1100, false, true);
  CHECK(s.acts() == "Btn2", "stop");
  s.hold(20, false, false);
  CHECK(s.acts() == "", "and the release adds nothing");
  Sim r;
  r.show(uiFrame(proto::UI_REPLY, "p", "x"));
  r.hold(1100, false, true);
  CHECK(r.acts() == "", "no stop in REPLY");
  Sim a;
  a.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  a.m.onApprovalReq(request(1, "Bash", "ls"), a.now);
  a.hold(1100, false, true);
  CHECK(a.acts() == "", "no stop over an approval: the deny key is a short press");
}

TEST(bothKeysHeldForThreeSecondsOpenSwitchConfirmAndTheFrontKeyConfirms) {
  Sim s;
  s.hold(3100, true, true);
  CHECK(s.screen() == Screen::SwitchConfirm && s.acts() == "", "open, with nothing sent yet");
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot" && s.m.view(s.now).switching, "the bridge is told, then the device restarts");
  s.side(100);
  CHECK(s.screen() == Screen::SwitchConfirm, "no way back once confirmed");
}

TEST(sideShortOrTenSecondsCancelSwitchConfirm) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.side(100);
  CHECK(s.screen() == Screen::Idle && s.acts() == "", "cancelled by the side key");
  Sim t;
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(9800, false, false);
  CHECK(t.screen() == Screen::SwitchConfirm, "just under 10 s after it opened it is still waiting");
  t.hold(200, false, false);
  CHECK(t.screen() == Screen::Idle && t.acts() == "", "10 s: gone, and nothing was sent");
}

TEST(aChordNeverStartsATalkAndDropsTheOnePreparedByTheFirstKey) {
  Sim s;
  s.hold(100, true, false);
  s.hold(100, true, true);
  CHECK(s.acts() == "Prepare End", "the front key prepared, the second key within 150 ms cancels it");
  s.hold(400, true, true);
  CHECK(s.acts() == "" && s.screen() == Screen::Idle, "and holding both is no talk");
}

TEST(switchConfirmIsReachableWhileOfflineSoTheDeviceCanAlwaysBeSwitchedBack) {
  Sim s;
  s.link = false;
  s.hold(3100, true, true);
  CHECK(s.screen() == Screen::SwitchConfirm, "above OFFLINE");
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot", "confirmed");
}

TEST(loosingTheLinkEndsATalkClearsAnApprovalAndForgetsTheOldScreen) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash"));
  s.hold(400, true, false);
  s.acts();
  s.link = false;
  s.hold(10, true, false);
  CHECK(s.acts() == "End" && s.screen() == Screen::Offline, "the take ends and OFFLINE shows");
  s.hold(20, false, false);
  s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
  s.link = true;
  s.hold(10, false, false);
  s.show(uiFrame(proto::UI_IDLE, "walkie"));
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Idle, "back online, with nothing left of the old WORKING screen");
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.project) == "", "nor of the project name");
}

TEST(anApprovalIsClearedWhenTheLinkGoes) {
  Sim s;
  s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Idle, "a bridge that restarted knows nothing of it");
}

TEST(aTalkIsPreparedEvenWhileAReplyPlaysTheAudioDecidesWhatToDoAboutIt) {
  Sim s;
  s.show(uiFrame(proto::UI_REPLY, "p", "hello"));
  s.busy = true;
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit0", "the machine does not know about pre-roll");
}

TEST(workingCountsTheElapsedTimeOnFromTheBridgesLastFigure) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash", 5000));
  ui::View v = s.m.view(s.now);
  CHECK(v.hasElapsed && v.elapsedMs == 5000, "as sent");
  v = s.m.view(s.now + 2500);
  CHECK(v.elapsedMs == 7500, "2.5 s later");
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  CHECK(!s.m.view(s.now).hasElapsed, "no figure, none shown");
  s.show(uiFrame(proto::UI_REPLY, "p", "x", 5000));
  CHECK(!s.m.view(s.now).hasElapsed, "only WORKING shows one");
}

TEST(textFromTheBridgeIsSanitizedBeforeItIsDrawn) {
  Sim s;
  std::string bad = "ok";
  bad += (char)0xFF;
  bad += "\xE5\xA5";  // a cut character
  bad += "end";
  s.show(uiFrame(proto::UI_ERROR, "p", bad));
  ui::View v = s.m.view(s.now);
  CHECK(std::string(v.text, v.lines[0].start, v.lines[0].len) == "ok???end", "each bad byte one question mark");
}

TEST(aLongTextOnANonReplyScreenShowsItsHeadAndSaysThereIsMore) {
  Sim s;
  std::string text;
  for (int i = 1; i <= 20; i++) text += "line " + std::to_string(i) + "\n";
  s.show(uiFrame(proto::UI_WORKING, "p", text));
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && v.more, "six lines and a mark");
  s.show(uiFrame(proto::UI_WORKING, "p", "short"));
  v = s.m.view(s.now);
  CHECK(v.nLines == 1 && !v.more, "short text: no mark");
}

TEST(anApprovalPreviewLongerThanTheScreenShowsItsHeadAndSaysThereIsMore) {
  Sim s;
  std::string preview;
  for (int i = 1; i <= 12; i++) preview += "cmd " + std::to_string(i) + "\n";
  s.m.onApprovalReq(request(4, "Bash", preview), s.now);
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::APPROVAL_LINES && v.more, "the hint line takes one, so five");
  CHECK(std::string(v.text, v.lines[4].start, v.lines[4].len) == "cmd 5", "the head, not the tail");
}

TEST(aHugeTextIsKeptWithinTheBuffersAndTheLineLimit) {
  Sim s;
  std::string huge(5000, 'a');
  s.show(uiFrame(proto::UI_REPLY, "p", huge));
  ui::View v = s.m.view(s.now);
  CHECK(v.pages >= 1 && v.nLines <= ui::BODY_LINES, "no overrun, and the pages the kept text makes");
  s.m.onApprovalReq(request(1, std::string(500, 't'), huge), s.now);
  CHECK(s.m.view(s.now).nLines == ui::APPROVAL_LINES, "an approval too");
}

TEST(aSpokenReasonIsAllowedOverAnyScreenAnApprovalIsOn) {
  const uint8_t base[] = {proto::UI_TRANSCRIBING, proto::UI_CONFIRM};
  for (uint8_t st : base) {
    Sim s;
    s.show(uiFrame(st));
    s.m.onApprovalReq(request(3, "Bash", "ls"), s.now);
    s.hold(400, true, false);
    CHECK(s.acts() == "Prepare Commit1", "the approval is what the front key answers, whatever is behind it");
  }
}

TEST(aDroppedTalkCanBePreparedAgain) {
  Sim s;
  s.front(100);
  CHECK(s.acts() == "Prepare End", "dropped at the release");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and the next tap starts from nothing");
  Sim c;
  c.hold(100, true, false);
  c.hold(100, true, true);
  c.hold(20, false, false);
  CHECK(c.acts() == "Prepare End", "dropped by a chord");
  c.front(100);
  CHECK(c.acts() == "Prepare End", "and the same after it");
}

TEST(aSecondFrontDownPreparesNothingAndLeavesALiveTakeAlone) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  CHECK(actions(m) == "Prepare", "one preparation");
  m.onGesture(ui::Ev::TalkStart, 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  CHECK(actions(m) == "Commit0" && m.screen() == Screen::Listening, "a take that is on keeps going");
}

TEST(aTalkEndThatFindsNoLiveTakeEndsWhatWasPreparedAndSendsNoVerdict) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onApprovalReq(request(9, "Bash", "ls"), 0);
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::TalkStart, 0);
  m.onGesture(ui::Ev::TalkEnd, 0);
  CHECK(actions(m) == "Prepare Commit1 End DenyReason9", "a reason take, as before");
  m.onGesture(ui::Ev::FrontDown, 0);
  m.onGesture(ui::Ev::TalkEnd, 0);
  CHECK(actions(m) == "Prepare End", "a talk that was only prepared ends, and the old reason is not sent again");
}

TEST(aReasonIsForTheApprovalItStartedWithNotForOneThatCameDuringTheTake) {
  Sim s;
  s.m.onApprovalReq(request(9, "Bash", "git push"), s.now);
  s.hold(400, true, false);
  CHECK(s.acts() == "Prepare Commit1", "a reason for 9");
  s.m.onApprovalReq(request(10, "Edit", "x"), s.now);
  s.hold(20, false, false);
  CHECK(s.acts() == "End DenyReason9" && s.screen() == Screen::Approval, "9 is denied with it, and 10 is still waiting");
  s.front(100);
  CHECK(s.acts() == "Prepare End Allow10", "a tap answers 10");
}

TEST(aSecondFrontTapWhileSwitchingDoesNotBootAgain) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.front(100);
  CHECK(s.acts() == "Btn4 Boot", "confirmed");
  s.front(100);
  CHECK(s.acts() == "" && s.m.view(s.now).switching, "a second tap does nothing");
}

TEST(aSecondChordWhileSwitchConfirmIsOpenChangesNothing) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.front(100);
  s.acts();
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.m.view(s.now).switching && s.screen() == Screen::SwitchConfirm, "still switching");
  s.front(100);
  CHECK(s.acts() == "", "and a tap does not boot twice");
  Sim t;
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(4000, false, false);
  t.hold(3100, true, true);
  t.hold(20, false, false);
  t.hold(3000, false, false);
  CHECK(t.screen() == Screen::Idle, "the 10 s count from the first chord, not from a later one");
}

TEST(theSideKeyHeldDoesNotStopTheTurnBehindTheSwitchScreenOrWhileOffline) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.acts();
  s.hold(1100, false, true);
  CHECK(s.acts() == "", "behind the switch screen");
  Sim o;
  o.link = false;
  o.hold(10, false, false);
  o.show(uiFrame(proto::UI_WORKING, "p", "Bash"));
  o.hold(1100, false, true);
  CHECK(o.acts() == "", "offline");
}

TEST(theSideKeyDoesNothingWhileOffline) {
  Sim a;
  a.link = false;
  a.hold(10, false, false);
  a.m.onApprovalReq(request(2, "Bash", "ls"), a.now);
  a.side(100);
  CHECK(a.acts() == "", "no verdict to a bridge that is not there");
  Sim b;
  b.link = false;
  b.busy = true;
  b.hold(10, false, false);
  b.side(100);
  CHECK(b.acts() == "", "no stop either");
}

TEST(theSideKeyInConfirmCancelsEvenWhileTheLastReplyStillPlays) {
  Sim s;
  s.show(uiFrame(proto::UI_CONFIRM, "p", "hello"));
  s.busy = true;
  s.side(100);
  CHECK(s.acts() == "Btn1", "cancel, not stop");
}

TEST(aLinkThatGoesAndComesBackShowsNothingOfTheScreenBefore) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash: npm test", 4000));
  s.link = false;
  s.hold(10, false, false);
  s.link = true;
  s.hold(10, false, false);
  ui::View v = s.m.view(s.now);
  CHECK(s.screen() == Screen::Idle, "the screen");
  CHECK(std::string(v.project) == "" && std::string(v.text) == "" && v.nLines == 0 && !v.hasElapsed, "and what it showed");
}

TEST(aScreenThatArrivesWhileTheLinkIsStillDownIsKeptForWhenItComesBack) {
  Sim s;
  s.link = false;
  s.hold(10, false, false);
  s.show(uiFrame(proto::UI_REPLY, "walkie", "hello"));
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Offline, "no link yet");
  s.link = true;
  s.hold(10, false, false);
  CHECK(s.screen() == Screen::Reply && std::string(s.m.view(s.now).project) == "walkie", "the bridge's first frame was not thrown away");
}

TEST(theProjectNameIsTheOneTheLastUiFrameSent) {
  Sim s;
  s.show(uiFrame(proto::UI_IDLE, "walkie"));
  CHECK(std::string(s.m.view(s.now).project) == "walkie", "named");
  s.show(uiFrame(proto::UI_IDLE, "other"));
  CHECK(std::string(s.m.view(s.now).project) == "other", "renamed");
  s.show(uiFrame(proto::UI_IDLE));
  CHECK(std::string(s.m.view(s.now).project) == "", "a frame without one clears it");
}

TEST(switchConfirmClosesAtExactlyTenSecondsAndNeverOnceConfirmed) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onGesture(ui::Ev::ChordHold, 1000);
  m.tick(10999, true, false);
  CHECK(m.screen() == Screen::SwitchConfirm, "a millisecond short");
  m.tick(11000, true, false);
  CHECK(m.screen() == Screen::Idle, "ten seconds");
  m.onGesture(ui::Ev::ChordHold, 20000);
  m.onGesture(ui::Ev::FrontShort, 20100);
  actions(m);
  m.tick(60000, true, false);
  CHECK(m.screen() == Screen::SwitchConfirm, "once confirmed it stays: the device is restarting");
  ui::Machine w;
  w.tick(0xFFFFFF00u, true, false);
  w.onGesture(ui::Ev::ChordHold, 0xFFFFFF00u);
  w.tick(0xFFFFFF10u, true, false);
  CHECK(w.screen() == Screen::SwitchConfirm, "across the clock wrapping it is still open");
  w.tick(9743, true, false);
  CHECK(w.screen() == Screen::SwitchConfirm, "just short of ten seconds after the wrap");
  w.tick(9744, true, false);
  CHECK(w.screen() == Screen::Idle, "and closed at ten");
}

TEST(aTextThatJustFitsHasNoMoreMarkAndOneLineMoreHasOne) {
  Sim s;
  std::string six;
  for (int i = 1; i <= 6; i++) six += "line " + std::to_string(i) + (i < 6 ? "\n" : "");
  std::string seven = six + "\nline 7";
  s.show(uiFrame(proto::UI_WORKING, "p", six));
  ui::View v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && !v.more, "six lines fill the body");
  s.show(uiFrame(proto::UI_WORKING, "p", seven));
  v = s.m.view(s.now);
  CHECK(v.nLines == ui::BODY_LINES && v.more, "a seventh does not fit");
  std::string five = "cmd 1\ncmd 2\ncmd 3\ncmd 4\ncmd 5";
  s.m.onApprovalReq(request(1, "Bash", five), s.now);
  v = s.m.view(s.now);
  CHECK(v.nLines == ui::APPROVAL_LINES && !v.more, "five lines fill an approval");
  s.m.onApprovalReq(request(1, "Bash", five + "\ncmd 6"), s.now);
  CHECK(s.m.view(s.now).more, "a sixth does not fit");
}

TEST(theActionQueueKeepsOrderAndDropsTheNewestWhenFull) {
  ui::Machine m;
  m.tick(0, true, false);
  for (int i = 0; i < 40; i++) m.onGesture(ui::Ev::FrontDown, 0), m.onGesture(ui::Ev::FrontShort, 0);
  int n = 0;
  ui::Action a;
  while (m.next(a)) n++;
  CHECK(n == 16, "16 is the most it holds, and it does not overrun");
}

TEST(everyScreenHasADistinctNameForTheLog) {
  const ui::Screen all[] = {ui::Screen::Idle,     ui::Screen::Transcribing, ui::Screen::Confirm,       ui::Screen::Working,
                            ui::Screen::Reply,    ui::Screen::Error,        ui::Screen::Approval,      ui::Screen::Listening,
                            ui::Screen::SwitchConfirm, ui::Screen::Offline};
  for (size_t i = 0; i < 10; i++)
    for (size_t j = i + 1; j < 10; j++) CHECK(std::string(ui::screenName(all[i])) != ui::screenName(all[j]), "distinct");
  CHECK(std::string(ui::screenName(ui::Screen::SwitchConfirm)) == "switch-confirm", "spelled as the plan's gates expect");
}

TEST(aFrontTapThatBeganBeforeTheApprovalWasOnTheScreenDoesNotAllowIt) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash", 4000));
  s.hold(50, true, false);
  CHECK(s.acts() == "Prepare", "he pressed the front key to talk");
  s.m.onApprovalReq(request(3, "Bash", "rm -rf build"), s.now);
  s.hold(20, false, false);
  CHECK(s.acts() == "End", "the tap ends the talk and answers nothing: he never saw the request");
  CHECK(s.screen() == Screen::Approval, "the request is still waiting for him");
  s.front(100);
  CHECK(s.acts() == "Prepare End Allow3", "a tap that began with the request on the screen allows it");
}

TEST(aFrontHoldThatBeganBeforeTheApprovalWasOnTheScreenIsNotItsReason) {
  Sim s;
  s.show(uiFrame(proto::UI_WORKING, "walkie", "Bash", 4000));
  s.hold(100, true, false);
  s.acts();
  s.m.onApprovalReq(request(4, "Bash", "git push"), s.now);
  s.hold(300, true, false);
  CHECK(s.acts() == "Commit0", "the take is an ordinary one: he began it to tell Claude something");
  s.hold(20, false, false);
  CHECK(s.acts() == "End", "and it does not deny the request");
  CHECK(s.screen() == Screen::Approval, "which waits for him");
}

// ---- pairing confirmation (protocol/frames.md, "Pairing"): the key press on the device is the authority for a key.

TEST(aPairRequestOpensPairConfirmAboveEverythingEvenWhileOffline) {
  Sim s;
  s.link = false;
  s.step(false, false);
  CHECK(s.screen() == Screen::Offline, "no bridge: pairing runs over a link that does not ping");
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.screen() == Screen::PairConfirm, "above OFFLINE");
  CHECK(s.m.view(s.now).pairOp == proto::PAIR_SET, "the view says which request it is");
  CHECK(std::string(ui::screenName(Screen::PairConfirm)) == "pair-confirm", "its name");
  s.m.onPairRequest(proto::PAIR_FORGET, s.now);
  CHECK(s.m.view(s.now).pairOp == proto::PAIR_FORGET, "and shows the latest one");
}

TEST(aShortFrontPressAnswersYesAndAShortSidePressAnswersNo) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.step(false, false);
  s.front(100);
  CHECK(s.acts() == "PairYes" && s.screen() == Screen::Idle, "yes closes it");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and nothing answers twice");
  Sim t;
  t.m.onPairRequest(proto::PAIR_SET, t.now);
  t.step(false, false);
  t.side(100);
  CHECK(t.acts() == "PairNo" && t.screen() == Screen::Idle, "a short side press is no");
}

TEST(aFrontPressThatBeganBeforeTheRequestIsNotAnAnswer) {
  Sim s;
  s.hold(100, true, false);
  s.acts();
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.acts() == "End", "the talk the press had begun is dropped");
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "released: not a yes");
  s.front(100);
  CHECK(s.acts() == "PairYes", "a press that began on the screen is");
}

TEST(aLongFrontHoldNeitherAnswersNorTalksWhilePairConfirmIsOpen) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.step(false, false);
  s.hold(500, true, false);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "nothing: neither a yes nor a spoken reason");
  s.hold(1200, false, true);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "a long side press is not a no either");
}

TEST(noAnswerIn30SecondsIsNoAtExactlyThirtySeconds) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onPairRequest(proto::PAIR_SET, 1000);
  m.tick(30999, true, false);
  CHECK(m.screen() == Screen::PairConfirm && actions(m) == "", "a millisecond short");
  CHECK(m.view(30999).pairLeftMs == 1, "and the view counts down");
  m.tick(31000, true, false);
  CHECK(m.screen() == Screen::Idle && actions(m) == "PairNo", "thirty seconds");
  ui::Machine w;
  w.tick(0xFFFFFF00u, true, false);
  w.onPairRequest(proto::PAIR_SET, 0xFFFFFF00u);
  w.tick(0xFFFFFF00u + 29999u, true, false);
  CHECK(w.screen() == Screen::PairConfirm, "across the wrap: still open");
  w.tick(0xFFFFFF00u + 30000u, true, false);
  CHECK(w.screen() == Screen::Idle, "across the wrap: closed");
}

TEST(aRepeatedRequestKeepsTheTimeButAChangedOneRestartsItAndNeedsANewPress) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  uint32_t first = s.now;
  s.hold(10000, false, false);
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.m.view(s.now).pairLeftMs <= 20100, "the same request again does not buy more time");
  s.hold(100, true, false);
  s.m.onPairRequest(proto::PAIR_FORGET, s.now);
  s.hold(20, false, false);
  CHECK(s.acts().find("PairYes") == std::string::npos && s.screen() == Screen::PairConfirm, "a press made for the old request does not answer the new one");
  CHECK(s.m.view(s.now).pairLeftMs > 29000 && s.now - first > 10000, "the new one has its own 30 seconds");
}

TEST(pairConfirmSitsAboveSwitchConfirmAndLeavesItWhereItWas) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.screen() == Screen::SwitchConfirm, "open");
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.screen() == Screen::PairConfirm, "pairing is above it");
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "a chord does not open or confirm anything meanwhile");
  s.m.tick(s.now + 40000, true, false);
  CHECK(actions(s.m) == "PairNo" && s.screen() != Screen::PairConfirm, "closed by the timeout");
}

TEST(aLostLinkDoesNotCloseAPairRequest) {
  Sim s;
  s.link = false;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.hold(5000, false, false);
  CHECK(s.screen() == Screen::PairConfirm, "pairing runs with the bridge not pinging");
}

TEST(aChordHeldDuringAPairRequestOpensNoSwitchConfirmBehindIt) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.m.onGesture(ui::Ev::SideShort, s.now);
  CHECK(actions(s.m) == "PairNo", "the side key said no");
  CHECK(s.screen() != Screen::SwitchConfirm && s.screen() != Screen::PairConfirm, "and no switch confirmation waits behind it");
}
