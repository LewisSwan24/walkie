// offline.h: what the OFFLINE screen says about which link is down (spec 5.4), and the word the log uses for it.
#pragma once
#include <stdint.h>
#include "proto/netstate.h"

namespace ui {
// The line under 未连接: what to check, for the link offlineReason() names. An S3 with no network set up still says to plug in USB.
const char* offlineHint(const proto::LinkView& v);
// "online", "no-wifi", "relay-down" or "pc-offline": for the LOG line when it changes.
const char* offlineName(uint8_t reason);
}  // namespace ui
