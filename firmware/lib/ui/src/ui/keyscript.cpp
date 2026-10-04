#include "ui/keyscript.h"

namespace ui {

void KeyScript::load(const proto::KeyStep* steps, size_t n, uint32_t now) {
  if (n > proto::KEY_STEPS_MAX) n = proto::KEY_STEPS_MAX;
  uint32_t at = now;
  for (size_t i = 0; i < n; i++) {
    at += steps[i].delayMs;
    due_[i] = at;
    masks_[i] = steps[i].mask;
  }
  n_ = n;
  next_ = 0;
  mask_ = 0;
}

uint8_t KeyScript::mask(uint32_t now) {
  while (next_ < n_ && (int32_t)(now - due_[next_]) >= 0) mask_ = masks_[next_++];
  return mask_;
}

}  // namespace ui
