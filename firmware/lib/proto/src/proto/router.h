// router.h: frames from the cable and from the relay into one Gate (spec 5.3). The S3 takes frames from the transport where it last
// saw a HELLO and drops what still comes on the other; it takes PAIR only from the cable, so a pairing key is never set or replaced
// from the network; and a PING the gate delivers is what makes it online. At boot the cable is the one in use, as it always was.
//
// Not thread safe: usblink.cpp calls it under the same lock as the Gate.
#pragma once
#include <stdint.h>
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/netstate.h"

namespace proto {
class Router {
 public:
  explicit Router(Gate& gate);
  // Gate::receive() for a frame that came on `transport`, or Drop without asking the gate: a frame other than HELLO from the
  // transport not in use, a PAIR that did not come on USB, anything from a transport that is neither.
  Gate::Rx receive(uint8_t transport, const Frame& in, Frame& out, uint32_t now);

  TransportSelector& selector() { return sel_; }
  const TransportSelector& selector() const { return sel_; }
  uint32_t otherTransport() const { return other_; }  // frames dropped because they came on the transport not in use

 private:
  Gate& gate_;
  TransportSelector sel_;
  uint32_t other_;
};
}  // namespace proto
