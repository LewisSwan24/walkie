#include "ui/machine.h"

namespace ui {
namespace {
// Counts of lines that fit in a view, however many the text has.
size_t atMost(size_t n, size_t cap) { return n < cap ? n : cap; }
}  // namespace

const char* screenName(Screen s) {
  switch (s) {
    case Screen::Idle: return "idle";
    case Screen::Transcribing: return "transcribing";
    case Screen::Confirm: return "confirm";
    case Screen::Working: return "working";
    case Screen::Reply: return "reply";
    case Screen::Error: return "error";
    case Screen::Approval: return "approval";
    case Screen::Listening: return "listening";
    case Screen::SwitchConfirm: return "switch-confirm";
    case Screen::Offline: return "offline";
    case Screen::PairConfirm: return "pair-confirm";
  }
  return "?";
}

Machine::Machine()
    : base_(Screen::Idle),
      offline_(true),
      talk_(Talk::Off),
      reasonTake_(false),
      reasonId_(0),
      speakerBusy_(false),
      approval_(false),
      approvalId_(0),
      frontSawApproval_(false),
      frontApprovalId_(0),
      nPreview_(0),
      nLines_(0),
      page_(0),
      hasElapsed_(false),
      elapsedMs_(0),
      elapsedAt_(0),
      switchOpen_(false),
      switching_(false),
      switchDeadline_(0),
      pairOpen_(false),
      pairOp_(0),
      pairDeadline_(0),
      frontSawPair_(false),
      head_(0),
      count_(0) {
  tool_[0] = preview_[0] = project_[0] = text_[0] = 0;
}

void Machine::push(Act act, uint8_t arg, uint8_t arg2, uint16_t id) {
  const size_t cap = sizeof(queue_) / sizeof(queue_[0]);
  if (count_ == cap) return;  // the loop drains the queue every turn; a full one means it stopped, and the newest is lost
  queue_[(head_ + count_) % cap] = Action{act, arg, arg2, id};
  count_++;
}

bool Machine::next(Action& a) {
  if (count_ == 0) return false;
  a = queue_[head_];
  head_ = (head_ + 1) % (sizeof(queue_) / sizeof(queue_[0]));
  count_--;
  return true;
}

Screen Machine::screen() const {
  if (pairOpen_) return Screen::PairConfirm;
  if (switchOpen_) return Screen::SwitchConfirm;
  if (offline_) return Screen::Offline;
  if (talk_ == Talk::Live) return Screen::Listening;
  if (approval_) return Screen::Approval;
  return base_;
}

bool Machine::canTalk() const {
  if (offline_ || switchOpen_ || pairOpen_) return false;
  if (approval_) return true;  // a front hold is the spoken reason
  return base_ == Screen::Idle || base_ == Screen::Working || base_ == Screen::Reply || base_ == Screen::Error;
}

void Machine::answer(bool allow, bool reasonFollows) {
  push(Act::SendApproval, allow ? 1 : 0, reasonFollows ? 1 : 0, approvalId_);
  approval_ = false;
}

void Machine::answerPair(bool yes) {
  push(Act::PairAnswer, yes ? 1 : 0);
  pairOpen_ = false;
}

void Machine::dropTalk() {
  if (talk_ != Talk::Off) push(Act::EndTalk);
  talk_ = Talk::Off;
}

void Machine::clearBase() {
  base_ = Screen::Idle;
  project_[0] = text_[0] = 0;
  nLines_ = 0;
  page_ = 0;
  hasElapsed_ = false;
}

void Machine::onGesture(Ev ev, uint32_t now) {
  switch (ev) {
    case Ev::FrontDown:
      // A front press answers an approval only if the approval was there when the press began: one that began earlier was
      // meant for something else, and an allow is not undone.
      frontSawApproval_ = approval_;
      frontApprovalId_ = approvalId_;
      frontSawPair_ = pairOpen_;
      if (talk_ == Talk::Off && canTalk()) {
        talk_ = Talk::Prepared;
        push(Act::PrepareTalk);
      }
      break;

    case Ev::FrontShort:
      if (talk_ == Talk::Prepared) dropTalk();
      if (pairOpen_) {
        if (frontSawPair_) answerPair(true);  // a press that began before the request was not meant for it
      } else if (switchOpen_) {
        if (!switching_) {
          switching_ = true;
          push(Act::SendButton, proto::BTN_SWITCHING);
          push(Act::BootApp0);
        }
      } else if (approval_ && frontSawApproval_ && frontApprovalId_ == approvalId_) {
        answer(true, false);
      }
      break;

    case Ev::TalkStart:
      if (talk_ == Talk::Prepared) {
        talk_ = Talk::Live;
        reasonTake_ = approval_ && frontSawApproval_ && frontApprovalId_ == approvalId_;
        reasonId_ = approvalId_;
        push(Act::CommitTalk, reasonTake_ ? 1 : 0);
      }
      break;

    case Ev::TalkEnd:
      if (talk_ != Talk::Off) {
        bool wasReason = talk_ == Talk::Live && reasonTake_;
        talk_ = Talk::Off;
        push(Act::EndTalk);
        if (wasReason) {
          push(Act::SendApproval, 0, 1, reasonId_);
          if (approval_ && approvalId_ == reasonId_) approval_ = false;
        }
      }
      break;

    case Ev::SideShort:
      if (pairOpen_) {
        answerPair(false);
      } else if (switchOpen_) {
        if (!switching_) switchOpen_ = false;
      } else if (offline_) {
        // nothing to act on
      } else if (approval_) {
        answer(false, false);
      } else if (base_ == Screen::Confirm) {
        push(Act::SendButton, proto::BTN_CANCEL);
      } else if (speakerBusy_) {
        push(Act::StopAudio);
      } else if (base_ == Screen::Reply) {
        size_t pages = nLines_ ? (nLines_ + BODY_LINES - 1) / BODY_LINES : 1;
        if ((size_t)page_ + 1 < pages)
          page_++;
        else
          push(Act::SendButton, proto::BTN_DISMISS);
      } else if (base_ == Screen::Error) {
        push(Act::SendButton, proto::BTN_DISMISS);
      }
      break;

    case Ev::SideHold:
      if (!switchOpen_ && !offline_ && !approval_ && base_ == Screen::Working) push(Act::SendButton, proto::BTN_STOP);
      break;

    case Ev::ChordStart:
      dropTalk();
      break;

    case Ev::ChordHold:
      if (!switchOpen_ && !pairOpen_) {
        switchOpen_ = true;
        switching_ = false;
        switchDeadline_ = now + SWITCH_TIMEOUT_MS;
      }
      break;

    case Ev::None:
      break;
  }
}

void Machine::onUi(const proto::UiView& v, uint32_t now) {
  if (v.state > proto::UI_ERROR) return;
  base_ = (Screen)v.state;
  approval_ = false;  // a UI frame from the bridge means that the approval is over
  sanitize(v.project.p, v.project.n, project_, sizeof(project_));
  size_t n = sanitize(v.text.p, v.text.n, text_, sizeof(text_));
  nLines_ = wrap(text_, n, COLS, lines_, MAX_LINES);
  page_ = 0;
  hasElapsed_ = v.hasElapsed;
  elapsedMs_ = v.elapsedMs;
  elapsedAt_ = now;
}

void Machine::onApprovalReq(const proto::ApprovalReq& r, uint32_t) {
  approval_ = true;
  approvalId_ = r.id;
  sanitize(r.tool.p, r.tool.n, tool_, sizeof(tool_));
  size_t n = sanitize(r.preview.p, r.preview.n, preview_, sizeof(preview_));
  nPreview_ = wrap(preview_, n, COLS, previewLines_, MAX_LINES);
}

void Machine::onPairRequest(uint8_t op, uint32_t now) {
  if (pairOpen_ && pairOp_ == op) return;
  dropTalk();
  pairOpen_ = true;
  pairOp_ = op;
  pairDeadline_ = now + PAIR_TIMEOUT_MS;
  frontSawPair_ = false;
}

void Machine::tick(uint32_t now, bool linkUp, bool speakerBusy) {
  speakerBusy_ = speakerBusy;
  if (!linkUp) {
    if (!offline_) {
      offline_ = true;
      dropTalk();
      approval_ = false;
      clearBase();  // whatever the old bridge showed means nothing to the next one
    }
  } else {
    offline_ = false;
  }
  if (switchOpen_ && !switching_ && (int32_t)(now - switchDeadline_) >= 0) switchOpen_ = false;
  if (pairOpen_ && (int32_t)(now - pairDeadline_) >= 0) answerPair(false);
}

View Machine::view(uint32_t now) const {
  View v;
  v.screen = screen();
  v.project = project_;
  v.tool = tool_;
  v.text = text_;
  v.nLines = 0;
  v.more = false;
  v.page = 0;
  v.pages = 1;
  v.hasElapsed = false;
  v.elapsedMs = 0;
  v.switching = switching_;
  v.pairOp = pairOp_;
  v.pairLeftMs = pairOpen_ && (int32_t)(pairDeadline_ - now) > 0 ? pairDeadline_ - now : 0;
  const Line* from = lines_;
  size_t total = nLines_, show = BODY_LINES;
  if (v.screen == Screen::Approval) {
    v.text = preview_;
    from = previewLines_;
    total = nPreview_;
    show = APPROVAL_LINES;
  }
  if (v.screen == Screen::Reply) {
    v.pages = (uint8_t)(total ? (total + BODY_LINES - 1) / BODY_LINES : 1);
    v.page = page_;
    size_t start = (size_t)page_ * BODY_LINES;
    from += start;
    total = total > start ? total - start : 0;
  } else {
    v.more = total > show;
  }
  v.nLines = (uint8_t)atMost(total, show);
  for (uint8_t i = 0; i < v.nLines; i++) v.lines[i] = from[i];
  if (base_ == Screen::Working && hasElapsed_) {
    v.hasElapsed = true;
    v.elapsedMs = elapsedMs_ + (now - elapsedAt_);
  }
  return v;
}

}  // namespace ui
