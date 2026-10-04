#include "ui/gesture.h"

namespace ui {
namespace {
void add(Events& e, Ev ev) { e.ev[e.n++] = ev; }
}  // namespace

Events Gesture::update(uint32_t now, bool rawFront, bool rawSide) {
  Events out = {{Ev::None, Ev::None}, 0};
  if (blockFront_ && !rawFront) blockFront_ = false;
  if (blockSide_ && !rawSide) blockSide_ = false;
  bool front = rawFront && !blockFront_;
  bool side = rawSide && !blockSide_;
  uint32_t held = now - t0_;

  switch (state_) {
    case Idle:
      if (front && side) {
        state_ = Chord;
        t0_ = now;
        holdSent_ = false;
        add(out, Ev::ChordStart);
      } else if (front) {
        state_ = Front;
        t0_ = now;
        add(out, Ev::FrontDown);
      } else if (side) {
        state_ = Side;
        t0_ = now;
        holdSent_ = false;
      }
      break;

    case Front:
      if (!front) {
        if (held >= Gesture::HOLD_MS) {  // the loop was late: a hold that was only seen at its release
          add(out, Ev::TalkStart);
          add(out, Ev::TalkEnd);
        } else {
          add(out, Ev::FrontShort);
        }
        state_ = Idle;
      } else if (side) {
        if (held < Gesture::CHORD_WINDOW_MS) {
          state_ = Chord;
          t0_ = now;
          holdSent_ = false;
          add(out, Ev::ChordStart);
        } else {
          blockSide_ = true;
        }
      } else if (held >= Gesture::HOLD_MS) {
        state_ = Talk;
        add(out, Ev::TalkStart);
      }
      break;

    case Talk:
      if (!front) {
        state_ = Idle;
        add(out, Ev::TalkEnd);
      } else if (side) {
        blockSide_ = true;
      }
      break;

    case Side:
      if (!side) {
        if (held < Gesture::HOLD_MS) add(out, Ev::SideShort);
        state_ = Idle;
      } else if (front) {
        if (held < Gesture::CHORD_WINDOW_MS) {
          state_ = Chord;
          t0_ = now;
          holdSent_ = false;
          add(out, Ev::ChordStart);
        } else {
          blockFront_ = true;
        }
      } else if (!holdSent_ && held >= Gesture::SIDE_HOLD_MS) {
        holdSent_ = true;
        add(out, Ev::SideHold);
      }
      break;

    case Chord:
      if (!front && !side) {
        state_ = Idle;
      } else if (front && side && !holdSent_ && held >= Gesture::CHORD_HOLD_MS) {
        holdSent_ = true;
        add(out, Ev::ChordHold);
      }
      break;
  }
  return out;
}

}  // namespace ui
