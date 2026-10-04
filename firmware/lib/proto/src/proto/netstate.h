// netstate.h: what the S3 decides about its links, apart from the radio and the sockets, so that the host tests can run all of it
// (spec 5.2 to 5.4). Backoff spaces the Wi-Fi and relay reconnects; TransportSelector says which of USB and the relay the S3 sends on
// and whether it is online; offlineReason() says which link OFFLINE names.
//
// Not thread safe: the device puts one lock around a TransportSelector, as it does around the Gate.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
// Reconnect delays: firstMs, then double each time, never past maxMs. 1, 2, 4 ... 30 s by default.
class Backoff {
 public:
  explicit Backoff(uint32_t firstMs = 1000, uint32_t maxMs = 30000);
  uint32_t next();  // the delay before the next attempt
  void reset();     // after a success: the next delay is firstMs again

 private:
  uint32_t first_, max_, next_;
};

enum : uint8_t { TR_NONE = 0, TR_USB = 1, TR_WSS = 2 };
// How long after a PING the S3 is still online: 3 s on USB, 10 s on the relay; 0 for TR_NONE.
uint32_t onlineWindowMs(uint8_t transport);

// The S3 sends on the transport where it last saw a HELLO. A HELLO on the other one switches it over, and from then on frames that
// still come on the first are dropped (the PC that sent them has moved, or is another one). Online means a PING came on the active
// transport within its window. Times are millis(), and may wrap.
class TransportSelector {
 public:
  TransportSelector();
  // A frame arrived on `transport`. True when it is to be taken; false when it is to be dropped. A HELLO is always taken.
  bool onFrame(uint8_t transport, bool hello, bool ping, uint32_t now);
  // `transport` is gone (the relay connection closed). When it was the active one, nothing is sent until the next HELLO.
  void onDown(uint8_t transport);

  uint8_t active() const { return active_; }
  bool online(uint32_t now) const;
  uint32_t switches() const { return switches_; }  // how many HELLOs moved it to the other transport

 private:
  uint8_t active_;
  bool pinged_;
  uint32_t lastPing_;
  uint32_t switches_;
};

enum : uint8_t { LINK_ONLINE = 0, LINK_NO_WIFI = 1, LINK_RELAY_DOWN = 2, LINK_PC_OFFLINE = 3 };
struct LinkView {
  bool online;     // TransportSelector::online()
  bool netWanted;  // paired, with a network and a relay host set: the S3 is trying the relay
  bool wifiUp;     // joined a network
  bool relayUp;    // the relay connection is open
};
// Which link is down, for OFFLINE: LINK_ONLINE when none is.
uint8_t offlineReason(const LinkView& v);

// The health line the S3 logs every 5 minutes, which gates M and N read: the battery, the heap now, its lowest since boot and the
// largest free internal block (a TLS handshake wants its records in one piece, and is over long before the next sample), RSSI and the
// link. Returns the length, or 0 when it does not fit in cap.
struct Health {
  uint8_t battery;
  uint32_t heap;
  uint32_t minHeap;
  uint32_t largest;
  int rssi;
  const char* link;
};
size_t healthLine(const Health& h, char* out, size_t cap);
}  // namespace proto
