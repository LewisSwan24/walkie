#include "proto/router.h"

namespace proto {
Router::Router(Gate& gate) : gate_(gate), sel_(), other_(0) { sel_.onFrame(TR_USB, true, false, 0); }

Gate::Rx Router::receive(uint8_t transport, const Frame& in, Frame& out, uint32_t now) {
  if (transport != TR_USB && transport != TR_WSS) return Gate::Drop;
  if (in.type == T_PAIR && transport != TR_USB) return Gate::Drop;
  bool hello = in.type == T_HELLO;
  if (!hello && !sel_.onFrame(transport, false, false, now)) {
    other_++;
    return Gate::Drop;
  }
  Gate::Rx rx = gate_.receive(in, out);
  if (rx == Gate::Hello) sel_.onFrame(transport, true, false, now);
  if (rx == Gate::Deliver && out.type == T_PING) sel_.onFrame(transport, false, true, now);
  return rx;
}
}  // namespace proto
