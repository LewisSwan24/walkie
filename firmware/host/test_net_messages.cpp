// test_net_messages.cpp: the NET frame (protocol/frames.md, "Network settings (plan 6)") as the S3 parses requests and builds replies.
// The hex strings are the ones bridge/test/link/net-messages.test.js checks, so the two ends cannot drift apart.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "vectors.h"

namespace {
using proto::NetMsg;
using proto::Text;

std::vector<uint8_t> bytes(const char* hex) { return unhex(hex); }
std::string str(const Text& t) { return std::string((const char*)t.p, t.n); }

bool parse(const char* hex, NetMsg& m) {
  std::vector<uint8_t> p = bytes(hex);
  m = NetMsg();
  return proto::parseNet(p.data(), p.size(), m);
}
std::string hexOf(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += d[p[i] >> 4];
    s += d[p[i] & 15];
  }
  return s;
}
}  // namespace

TEST(netTheTypeAndTheOpsAreTheOnesTheBridgeUses) {
  CHECK(proto::T_NET == 0x33, "NET is 0x33");
  CHECK(proto::NET_WIFI_ADD == 1 && proto::NET_WIFI_REMOVE == 2 && proto::NET_WIFI_LIST == 3 && proto::NET_RELAY_SET == 4 &&
            proto::NET_RELAY_CLEAR == 5,
        "request ops");
  CHECK(proto::NET_OK == 0x80 && proto::NET_ERR == 0x81 && proto::NET_LIST == 0x82, "reply ops");
  CHECK(proto::NETERR_BAD == 1 && proto::NETERR_FULL == 2 && proto::NETERR_UNKNOWN == 3 && proto::NETERR_STORE == 4, "reasons");
  CHECK(proto::NET_SSID_MAX == 32 && proto::NET_PASS_MAX == 63 && proto::NET_HOST_MAX == 63 && proto::NET_NETWORKS_MAX == 4, "limits");
}

TEST(netWifiAddCarriesTheSsidAndThePassword) {
  NetMsg m;
  CHECK(parse("0104686f6d6509736563726574313233", m), "parses");
  CHECK(m.op == proto::NET_WIFI_ADD && str(m.ssid) == "home" && str(m.pass) == "secret123", "the fields");
  CHECK(parse("01046361666500", m) && str(m.ssid) == "cafe" && m.pass.n == 0, "an open network has no password");
}

TEST(netWifiRemoveRelaySetAndTheOpsWithNoArguments) {
  NetMsg m;
  CHECK(parse("0204686f6d65", m) && m.op == proto::NET_WIFI_REMOVE && str(m.ssid) == "home", "remove");
  CHECK(parse("03", m) && m.op == proto::NET_WIFI_LIST, "list");
  CHECK(parse("041477616c6b69652d72656c61792e666c792e646576", m) && m.op == proto::NET_RELAY_SET && str(m.host) == "walkie-relay.fly.dev",
        "relay set");
  CHECK(parse("05", m) && m.op == proto::NET_RELAY_CLEAR, "relay clear");
}

TEST(netLimitsAreExactAtTheEdgesOnly) {
  NetMsg m;
  std::string ssid32 = "01" "20" + std::string(64, '6') + "00";
  CHECK(parse(ssid32.c_str(), m) && m.ssid.n == 32, "32 bytes of SSID");
  std::string ssid33 = "01" "21" + std::string(66, '6') + "00";
  CHECK(!parse(ssid33.c_str(), m), "33 bytes of SSID");
  CHECK(!parse("0103" "610062" "00", m), "a NUL inside an SSID");
  CHECK(!parse("0101" "61" "08" "3100333435363738", m), "a NUL inside a password");
  CHECK(!parse("0203" "610062", m), "a NUL inside an SSID to remove");
  CHECK(!parse("0101" "00" "00", m) && !parse("0201" "00", m), "an SSID that is one NUL");
  CHECK(!parse("010004", m) && !parse("0100" "00", m), "an empty SSID");
  std::string pass63 = "010161" "3f" + std::string(126, '7');
  CHECK(parse(pass63.c_str(), m) && m.pass.n == 63, "63 bytes of password");
  std::string pass64 = "010161" "40" + std::string(128, '7');
  CHECK(!parse(pass64.c_str(), m), "64 bytes of password");
  CHECK(!parse("010161" "07" "37373737373737", m), "7 bytes: shorter than WPA allows");
  CHECK(parse("010161" "08" "3737373737373737", m), "8 bytes");
  std::string host63 = "04" "3f" + std::string(126, '6');
  CHECK(parse(host63.c_str(), m) && m.host.n == 63, "63 bytes of host");
  std::string host64 = "04" "40" + std::string(128, '6');
  CHECK(!parse(host64.c_str(), m), "64 bytes of host");
}

TEST(netAHostHoldsOnlyLettersDigitsDotsAndHyphens) {
  NetMsg m;
  CHECK(parse("0409782e666c792e646576", m) && str(m.host) == "x.fly.dev", "ordinary");
  CHECK(!parse("04" "01" "20", m), "a space");
  CHECK(!parse("04" "03" "610d0a", m), "a line break: it would end the HTTP request line");
  CHECK(!parse("04" "03" "612f62", m), "a slash");
  CHECK(!parse("04" "03" "613a62", m), "a colon");
  CHECK(!parse("04" "02" "c3a9", m), "a byte above 127");
  CHECK(!parse("0400", m), "no host at all");
  CHECK(parse("0408" "415a617a30392e2d", m) && str(m.host) == "AZaz09.-", "the first and last of every kind that is allowed");
  CHECK(!parse("0401" "40", m) && !parse("0401" "5b", m), "the bytes either side of A to Z");
  CHECK(!parse("0401" "60", m) && !parse("0401" "7b", m), "the bytes either side of a to z");
  CHECK(!parse("0401" "2f", m) && !parse("0401" "3a", m), "the bytes either side of 0 to 9");
  CHECK(!parse("0401" "00", m), "a NUL");
}

TEST(netARequestThatIsNotExactlyOneIsRefused) {
  NetMsg m;
  const char* bad[] = {"",
                       "00",
                       "06",
                       "80",
                       "0104686f6d65",          // no password length
                       "0104686f6d650008",      // short
                       "0104686f6d650000" "00", // trailing byte
                       "0204686f6d65" "00",
                       "0204686f6d",            // SSID runs past the end
                       "0300",
                       "0500",
                       "0414" "77616c6b69652d72656c61792e666c792e6465",  // host runs past the end
                       "0409782e666c792e646576" "00"};
  for (const char* h : bad) CHECK(!parse(h, m), h);
}

TEST(netRepliesAreBuiltAsTheBridgeParsesThem) {
  uint8_t out[1100];
  size_t n = proto::buildNetOk(proto::NET_WIFI_ADD, out, sizeof out);
  CHECK(hexOf(out, n) == "8001", "ok");
  n = proto::buildNetErr(proto::NET_WIFI_ADD, proto::NETERR_FULL, out, sizeof out);
  CHECK(hexOf(out, n) == "810102", "err");
  CHECK(proto::buildNetOk(1, out, 1) == 0 && proto::buildNetErr(1, 1, out, 2) == 0, "too small a buffer is 0");

  const uint8_t home[] = {'h', 'o', 'm', 'e'}, cafe[] = {'c', 'a', 'f', 'e'}, host[] = {'x', '.', 'f', 'l', 'y', '.', 'd', 'e', 'v'};
  Text two[2] = {{home, 4}, {cafe, 4}};
  Text h = {host, 9};
  n = proto::buildNetList(two, 2, h, out, sizeof out);
  CHECK(hexOf(out, n) == "820204686f6d650463616665" "09782e666c792e646576", "two networks and a host");
  n = proto::buildNetList(nullptr, 0, Text{nullptr, 0}, out, sizeof out);
  CHECK(hexOf(out, n) == "820000", "nothing held");
  n = proto::buildNetList(two, 1, Text{nullptr, 0}, out, sizeof out);
  CHECK(hexOf(out, n) == "820104686f6d6500", "one network, no host");
}

TEST(netAListThatCannotBeBuiltIsNotBuilt) {
  uint8_t out[1100];
  uint8_t big[64];
  memset(big, 'a', sizeof big);
  Text five[5];
  for (int i = 0; i < 5; i++) five[i] = Text{big, 4};
  CHECK(proto::buildNetList(five, 5, Text{nullptr, 0}, out, sizeof out) == 0, "five networks");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, sizeof out) != 0, "four networks");
  Text long33[1] = {Text{big, 33}};
  CHECK(proto::buildNetList(long33, 1, Text{nullptr, 0}, out, sizeof out) == 0, "an SSID of 33 bytes");
  Text empty[1] = {Text{big, 0}};
  CHECK(proto::buildNetList(empty, 1, Text{nullptr, 0}, out, sizeof out) == 0, "an empty SSID");
  CHECK(proto::buildNetList(nullptr, 0, Text{big, 64}, out, sizeof out) == 0, "a host of 64 bytes");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 10) == 0, "a buffer that is too small");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 4 * 5 + 3) != 0, "a buffer that is exactly enough");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 4 * 5 + 2) == 0, "a buffer one short");
}
