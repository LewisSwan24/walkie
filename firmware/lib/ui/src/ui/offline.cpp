#include "ui/offline.h"

namespace ui {
const char* offlineHint(const proto::LinkView& v) {
  switch (proto::offlineReason(v)) {
    case proto::LINK_ONLINE:
      return "";
    case proto::LINK_NO_WIFI:
      return "连不上 Wi-Fi";
    case proto::LINK_RELAY_DOWN:
      return "连不上中继";
    default:
      return v.netWanted ? "电脑没在线：运行 walkie" : "插好 USB，运行 walkie";
  }
}

const char* offlineName(uint8_t reason) {
  switch (reason) {
    case proto::LINK_ONLINE:
      return "online";
    case proto::LINK_NO_WIFI:
      return "no-wifi";
    case proto::LINK_RELAY_DOWN:
      return "relay-down";
    case proto::LINK_PC_OFFLINE:
      return "pc-offline";
    default:
      return "?";
  }
}
}  // namespace ui
