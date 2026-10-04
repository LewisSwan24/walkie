// usblink.h: the S3's end of the link (protocol/frames.md), on USB and, through netlink, on the relay (spec 5.3). The RX task decodes
// frames from both and dispatches them; the TX task is the only writer to USB, and hands frames for the relay to netlink. Frames go
// on the transport where the last HELLO came from (proto/router.h).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace usblink {
// Called from the RX task. Any of them may be null.
struct Handlers {
  void (*onHello)();                                        // the bridge (re)connected
  void (*onAudioDown)(const uint8_t* payload, size_t len, uint8_t flags);
  void (*onCommand)(uint8_t op, uint8_t arg);
  void (*onTest)(uint8_t op, const uint8_t* args, size_t len);
  void (*onUi)(const uint8_t* payload, size_t len);           // UI: valid only during the call
  void (*onApprovalReq)(const uint8_t* payload, size_t len);  // APPROVAL_REQ: likewise
  void (*onPairRequest)(uint8_t op);                          // PAIR SET or FORGET (proto::PAIR_*): show it; answer with pairAnswer()
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for the transport in use and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// The key press on a pairing request: true is yes. Any task may call it; the answer is acted on by the RX task. With no request
// waiting it does nothing.
void pairAnswer(bool yes);
// A PING came on the transport in use within its window: 3 s on USB, 10 s on the relay (spec 5.4).
bool online();
// The transport in use: proto::TR_USB, proto::TR_WSS, or proto::TR_NONE after the relay went away until the next HELLO.
uint8_t transport();
// From netlink: one envelope from the relay (copied; any task), the relay connection opened (a HELLO goes out on it), or closed.
void fromRelay(const uint8_t* env, size_t n);
void relayConnected();
void relayDown();
}  // namespace usblink
