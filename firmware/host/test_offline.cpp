// test_offline.cpp: the OFFLINE screen's line for each link that can be down (spec 5.4), and the names the log gives them.
#include <string.h>
#include "check.h"
#include "ui/offline.h"

namespace {
proto::LinkView view(bool online, bool wanted, bool wifi, bool relay) {
  proto::LinkView v;
  v.online = online;
  v.netWanted = wanted;
  v.wifiUp = wifi;
  v.relayUp = relay;
  return v;
}
bool is(const char* got, const char* want) { return strcmp(got, want) == 0; }
}  // namespace

TEST(offlineHintNamesTheLinkThatIsDown) {
  CHECK(is(ui::offlineHint(view(false, false, false, false)), "插好 USB，运行 walkie"), "no network set up: the cable, as before");
  CHECK(is(ui::offlineHint(view(false, true, false, false)), "连不上 Wi-Fi"), "networks set, none joined");
  CHECK(is(ui::offlineHint(view(false, true, true, false)), "连不上中继"), "Wi-Fi, but no relay");
  CHECK(is(ui::offlineHint(view(false, true, true, true)), "电脑没在线：运行 walkie"), "the relay, but no PC on it");
  CHECK(is(ui::offlineHint(view(true, true, true, true)), ""), "online: nothing to say");
}

TEST(offlineNamesAreTheLogsWords) {
  CHECK(is(ui::offlineName(proto::LINK_ONLINE), "online"), "online");
  CHECK(is(ui::offlineName(proto::LINK_NO_WIFI), "no-wifi"), "no-wifi");
  CHECK(is(ui::offlineName(proto::LINK_RELAY_DOWN), "relay-down"), "relay-down");
  CHECK(is(ui::offlineName(proto::LINK_PC_OFFLINE), "pc-offline"), "pc-offline");
  CHECK(is(ui::offlineName(9), "?"), "anything else");
}
