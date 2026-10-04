// netlink.h: the S3's way to the PC away from the cable (spec 5.2): Wi-Fi, then a WebSocket over TLS to the relay, in its own task.
// It runs only while the S3 holds a pairing key, a network and a relay host (netconf); otherwise Wi-Fi is off. Frames from the relay go
// to usblink, which takes them as it takes the cable's; usblink's TX task hands it the frames to send while the relay is in use.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace netlink {
void begin();
// One link frame's envelope (protocol/frames.md, "Relay") as one binary message. False when the relay is not connected or the
// write failed; the frame is then lost, as on a cable nobody reads.
bool sendEnvelope(const uint8_t* env, size_t n);

bool wanted();   // paired, with a network and a relay host set
bool wifiUp();   // joined one of the networks
bool relayUp();  // the WebSocket to the relay is open
int rssi();      // the joined network's signal in dBm, 0 when none
}  // namespace netlink
