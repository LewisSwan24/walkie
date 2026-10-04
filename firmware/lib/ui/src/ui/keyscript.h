// keyscript.h: the keys a TEST KEYS frame presses, over time. The UI loop ORs the mask with the real keys.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"

namespace ui {

class KeyScript {
 public:
  KeyScript() : n_(0), next_(0), mask_(0) {}

  // Starts a script and drops the one that was running, with its keys released. Each step's delay counts from the step
  // before it (the first from `now`), so a script is the same whenever the loop happens to run. At most KEY_STEPS_MAX.
  void load(const proto::KeyStep* steps, size_t n, uint32_t now);

  // The keys the script holds at `now`: KEY_FRONT and KEY_SIDE bits. After its last step the script keeps that step's
  // mask, so a script has to end with 0.
  uint8_t mask(uint32_t now);

  bool running() const { return next_ < n_; }

 private:
  uint32_t due_[proto::KEY_STEPS_MAX];
  uint8_t masks_[proto::KEY_STEPS_MAX];
  size_t n_, next_;
  uint8_t mask_;
};

}  // namespace ui
