// test_netconf.cpp: the networks and relay host the S3 holds, and what a NET request does to them, without a device: the store is a
// variable. The hex strings are the replies bridge/test/link/net-messages.test.js parses.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "proto/messages.h"
#include "proto/netconf.h"
#include "vectors.h"

namespace {
using proto::NetConf;
using proto::NetMsg;
using proto::Text;

struct Mem {
  static bool has;
  static std::vector<uint8_t> blob;
  static int saves;
  static bool failSave;
  static bool load(uint8_t* buf, size_t cap, size_t& n) {
    if (!has) return false;
    n = blob.size() < cap ? blob.size() : cap;
    memcpy(buf, blob.data(), n);
    return true;
  }
  static bool save(const uint8_t* buf, size_t n) {
    if (failSave) return false;
    blob.assign(buf, buf + n);
    has = true;
    saves++;
    return true;
  }
  static void reset() {
    has = false;
    blob.clear();
    saves = 0;
    failSave = false;
  }
  static proto::NetStore store() {
    proto::NetStore s;
    s.load = load;
    s.save = save;
    return s;
  }
};
bool Mem::has = false;
std::vector<uint8_t> Mem::blob;
int Mem::saves = 0;
bool Mem::failSave = false;

std::string str(const Text& t) { return t.n ? std::string((const char*)t.p, t.n) : std::string(); }
std::string hexOf(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += d[p[i] >> 4];
    s += d[p[i] & 15];
  }
  return s;
}

struct Rig {
  NetConf c;
  Rig() {
    Mem::reset();
    CHECK(c.begin(Mem::store()), "begin");
  }
  // A request given as the bytes the PC sends; the reply as hex.
  std::string ask(const char* hex) {
    std::vector<uint8_t> p = unhex(hex);
    NetMsg m = NetMsg();
    CHECK(proto::parseNet(p.data(), p.size(), m), hex);
    uint8_t out[1100];
    size_t n = c.handle(m, out, sizeof out);
    return hexOf(out, n);
  }
};
}  // namespace

TEST(netconfStartsEmptyAndSaysSo) {
  Rig r;
  CHECK(r.c.count() == 0 && r.c.relay().n == 0 && r.c.generation() == 0, "nothing held");
  CHECK(r.ask("03") == "820000", "an empty list, no host");
  CHECK(r.c.ssid(0).n == 0 && r.c.pass(0).n == 0, "past the last is empty");
  proto::NetConf none;
  proto::NetStore broken = Mem::store();
  broken.save = nullptr;
  CHECK(!none.begin(broken), "a store without a save is refused");
}

TEST(netconfAddKeepsNetworksInTheOrderTheyCame) {
  Rig r;
  CHECK(r.ask("0104686f6d6509736563726574313233") == "8001", "home added");
  CHECK(r.ask("01046361666500") == "8001", "an open network: cafe");
  CHECK(r.c.count() == 2 && str(r.c.ssid(0)) == "home" && str(r.c.pass(0)) == "secret123" && str(r.c.ssid(1)) == "cafe" && r.c.pass(1).n == 0,
        "both held, in order");
  CHECK(r.ask("03") == "820204686f6d650463616665" "00", "the list names them");
  CHECK(r.c.generation() == 2 && Mem::saves == 2, "two changes, two writes");
}

TEST(netconfAListNeverCarriesAPassword) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  std::vector<uint8_t> p = unhex(r.ask("03").c_str());
  std::string all((const char*)p.data(), p.size());
  CHECK(all.find("secret") == std::string::npos, "no password in the list");
}

TEST(netconfAnSsidAlreadyHeldTakesTheNewPasswordWithoutAFifthSlot) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  CHECK(r.ask("0104686f6d6509736563726574343536") == "8001", "home again, another password");
  CHECK(r.c.count() == 1 && str(r.c.pass(0)) == "secret456", "replaced, still one");
  int saves = Mem::saves;
  uint32_t gen = r.c.generation();
  CHECK(r.ask("0104686f6d6509736563726574343536") == "8001", "the same again is fine");
  CHECK(Mem::saves == saves && r.c.generation() == gen, "and writes nothing");
  CHECK(r.ask("0104686f6d6500") == "8001" && r.c.pass(0).n == 0, "a password can become none");
}

TEST(netconfAFifthNetworkIsFullButAHeldOneStillTakesAPassword) {
  Rig r;
  CHECK(r.ask("0101" "61" "00") == "8001" && r.ask("0101" "62" "00") == "8001" && r.ask("0101" "63" "00") == "8001" &&
            r.ask("0101" "64" "00") == "8001",
        "four held");
  CHECK(r.ask("0101" "65" "00") == "810102", "a fifth is ERR FULL");
  CHECK(r.c.count() == 4 && str(r.c.ssid(3)) == "d", "unchanged");
  CHECK(r.ask("0101" "62" "08" "3132333435363738") == "8001" && str(r.c.pass(1)) == "12345678", "b takes a password while full");
}

TEST(netconfRemoveShiftsTheOthersUpAndSaysWhenItIsNotHeld) {
  Rig r;
  r.ask("0101" "61" "00");
  r.ask("0101" "62" "00");
  r.ask("0101" "63" "00");
  CHECK(r.ask("0201" "62") == "8002", "b removed");
  CHECK(r.c.count() == 2 && str(r.c.ssid(0)) == "a" && str(r.c.ssid(1)) == "c", "a and c, in order");
  CHECK(r.ask("0201" "62") == "810203", "b again is ERR UNKNOWN");
  CHECK(r.ask("0201" "61") == "8002" && r.ask("0201" "63") == "8002" && r.c.count() == 0, "all gone");
  CHECK(r.ask("0201" "61") == "810203", "nothing to remove");
  CHECK(r.ask("0101" "64" "00") == "8001" && str(r.c.ssid(0)) == "d", "a slot comes free again");
}

TEST(netconfTheRelayHostIsSetClearedAndReported) {
  Rig r;
  CHECK(r.ask("041477616c6b69652d72656c61792e666c792e646576") == "8004", "set");
  CHECK(str(r.c.relay()) == "walkie-relay.fly.dev", "held");
  CHECK(r.ask("03") == "820014" "77616c6b69652d72656c61792e666c792e646576", "LIST names it");
  int saves = Mem::saves;
  CHECK(r.ask("041477616c6b69652d72656c61792e666c792e646576") == "8004" && Mem::saves == saves, "the same host writes nothing");
  CHECK(r.ask("0409782e666c792e646576") == "8004" && str(r.c.relay()) == "x.fly.dev", "another replaces it");
  CHECK(r.ask("05") == "8005" && r.c.relay().n == 0, "cleared");
  saves = Mem::saves;
  CHECK(r.ask("05") == "8005" && Mem::saves == saves, "clearing nothing is fine and writes nothing");
}

TEST(netconfWhatIsHeldSurvivesARestart) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  r.ask("01046361666500");
  r.ask("0409782e666c792e646576");
  NetConf again;
  CHECK(again.begin(Mem::store()), "begin");
  CHECK(again.count() == 2 && str(again.ssid(0)) == "home" && str(again.pass(0)) == "secret123" && str(again.ssid(1)) == "cafe" &&
            again.pass(1).n == 0 && str(again.relay()) == "x.fly.dev",
        "the same");
  CHECK(again.generation() == 0, "a fresh start is generation 0 again");
}

TEST(netconfAChangeThatCannotBeSavedIsNotMade) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  r.ask("0409782e666c792e646576");
  uint32_t gen = r.c.generation();
  Mem::failSave = true;
  CHECK(r.ask("01046361666500") == "810104", "add: ERR STORE");
  CHECK(r.ask("0104686f6d6509736563726574343536") == "810104", "a new password: ERR STORE");
  CHECK(r.ask("0204686f6d65") == "810204", "remove: ERR STORE");
  CHECK(r.ask("0409612e666c792e646576") == "810404", "relay set: ERR STORE");
  CHECK(r.ask("05") == "810504", "relay clear: ERR STORE");
  CHECK(r.c.count() == 1 && str(r.c.ssid(0)) == "home" && str(r.c.pass(0)) == "secret123" && str(r.c.relay()) == "x.fly.dev", "nothing changed");
  CHECK(r.c.generation() == gen, "no generation either");
  Mem::failSave = false;
  CHECK(r.ask("01046361666500") == "8001" && r.c.count() == 2, "and it works again once the store does");
}

TEST(netconfABlobThatIsNotExactlyWhatWasWrittenIsAsGoodAsNone) {
  const char* bad[] = {
      "",
      "01",                               // no count
      "0200" "00",                        // another version
      "0100",                             // no host length
      "0100" "00" "00",                   // trailing byte
      "0105" "00",                        // five networks
      "0101" "00" "00",                   // SSID of 0 bytes
      "0101" "0161" "01" "62" "00",       // a password of 1 byte
      "0101" "0161" "08" "31323334353637",  // a password that runs past the end
      "0101" "0161" "00",                 // the host length is missing
      "0100" "03" "6120" "62",            // a host with a space
      "0100" "40" "",                     // a host of 64 bytes announced, none there
  };
  for (const char* h : bad) {
    Mem::reset();
    Mem::has = true;
    Mem::blob = unhex(h);
    NetConf c;
    CHECK(c.begin(Mem::store()), h);
    CHECK(c.count() == 0 && c.relay().n == 0, h);
  }
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex("0101" "0161" "00" "00");
  NetConf ok;
  CHECK(ok.begin(Mem::store()) && ok.count() == 1 && str(ok.ssid(0)) == "a" && ok.relay().n == 0, "the well-formed one loads");
  Mem::blob.assign(proto::NETCONF_BLOB_MAX + 5, 1);
  NetConf big;
  CHECK(big.begin(Mem::store()) && big.count() == 0, "a blob longer than any that is written");
}

TEST(netconfAFullBlobFitsTheBound) {
  Rig r;
  std::string pass63(126, '7');
  for (char c = 'a'; c < 'e'; c++) {
    std::string ssid32(64, '6');
    ssid32[0] = (char)('0' + (c - 'a'));  // four different 32-byte SSIDs
    std::string hex = "01" "20" + ssid32 + "3f" + pass63;
    CHECK(r.ask(hex.c_str()) == "8001", "a full-size network");
  }
  std::string host = "04" "3f" + std::string(126, '6');
  CHECK(r.ask(host.c_str()) == "8004", "a full-size host");
  CHECK(Mem::blob.size() == proto::NETCONF_BLOB_MAX, "the biggest blob is the bound");
  NetConf again;
  CHECK(again.begin(Mem::store()) && again.count() == 4 && again.relay().n == 63 && again.pass(3).n == 63, "and it loads back");
}

TEST(netconfAReplyThatDoesNotFitIsNotBuilt) {
  Rig r;
  std::vector<uint8_t> p = unhex("03");
  NetMsg m = NetMsg();
  CHECK(proto::parseNet(p.data(), p.size(), m), "parse");
  uint8_t out[1];
  CHECK(r.c.handle(m, out, sizeof out) == 0, "a LIST that does not fit");
  std::vector<uint8_t> q = unhex("05");
  CHECK(proto::parseNet(q.data(), q.size(), m) && r.c.handle(m, out, sizeof out) == 0, "an OK that does not fit");
}


namespace {
std::string rep(const char* hex, int n) {
  std::string s;
  for (int i = 0; i < n; i++) s += hex;
  return s;
}
Text T(const char* s) { return Text{(const uint8_t*)s, strlen(s)}; }
bool loadsEmpty(const std::string& hex) {
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex(hex.c_str());
  NetConf c;
  return c.begin(Mem::store()) && c.count() == 0 && c.relay().n == 0;
}
}  // namespace

TEST(netconfABlobThatBreaksOneLimitLoadsNothingEvenWhenTheRestIsFine) {
  CHECK(loadsEmpty("0201" "016100" "00"), "another version, with a network in it");
  CHECK(loadsEmpty("0105" + rep("016100", 5) + "00"), "five networks");
  CHECK(loadsEmpty("0101" "21" + rep("61", 33) + "00" "00"), "an SSID of 33 bytes");
  CHECK(loadsEmpty("0101" "0161" "40" + rep("37", 64) + "00"), "a password of 64 bytes");
  CHECK(loadsEmpty("0101" "0161" "07" + rep("37", 7) + "00"), "a password of 7 bytes");
  CHECK(loadsEmpty("0100" "01" "61" "00"), "a byte after the host");
  CHECK(loadsEmpty("0100" "40" + rep("61", 64)), "a host of 64 bytes");
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex(("0104" + rep("016100", 4) + "01" "61").c_str());
  NetConf four;
  CHECK(four.begin(Mem::store()) && four.count() == 4 && str(four.relay()) == "a", "four networks and a host of 1 byte are fine");
}

TEST(netconfRefusesWhatTheFrameParserWouldHaveRefusedEvenWhenAskedDirectly) {
  Rig r;
  uint8_t big[70];
  memset(big, 'a', sizeof big);
  CHECK(r.c.add(Text{big, 0}, Text{nullptr, 0}) == proto::NETERR_BAD, "an empty SSID");
  CHECK(r.c.add(Text{big, 33}, Text{nullptr, 0}) == proto::NETERR_BAD, "an SSID of 33");
  CHECK(r.c.add(Text{big, 32}, Text{nullptr, 0}) == 0, "an SSID of 32");
  CHECK(r.c.add(Text{big, 31}, Text{big, 64}) == proto::NETERR_BAD, "a password of 64");
  CHECK(r.c.add(Text{big, 31}, Text{big, 7}) == proto::NETERR_BAD, "a password of 7");
  CHECK(r.c.add(Text{big, 31}, Text{big, 63}) == 0, "a password of 63");
  CHECK(r.c.add(Text{big, 30}, Text{big, 8}) == 0, "a password of 8");
  CHECK(r.c.count() == 3 && Mem::saves == 3, "only the three that were fine were kept and written");
  CHECK(r.c.setRelay(Text{big, 0}) == proto::NETERR_BAD, "an empty host");
  CHECK(r.c.setRelay(Text{big, 64}) == proto::NETERR_BAD, "a host of 64");
  CHECK(r.c.setRelay(Text{big, 63}) == 0, "a host of 63");
  CHECK(r.c.setRelay(T("a b")) == proto::NETERR_BAD, "a space");
  CHECK(r.c.setRelay(T("a\r\nb")) == proto::NETERR_BAD, "a line break");
  CHECK(r.c.setRelay(T("a/b")) == proto::NETERR_BAD, "a slash");
  CHECK(Mem::saves == 4 && r.c.relay().n == 63, "the host that was fine is the one held");
}

TEST(netconfAnOpItDoesNotKnowIsAnErrorReplyNotSilence) {
  Rig r;
  NetMsg m = NetMsg();
  m.op = proto::NET_OK;  // a reply op where a request belongs
  uint8_t out[16];
  size_t n = r.c.handle(m, out, sizeof out);
  CHECK(hexOf(out, n) == "818001", "ERR BAD, answering the op as given");
}


namespace {
bool zeroFrom(const uint8_t* p, size_t from, size_t to) {
  for (size_t i = from; i < to; i++)
    if (p[i]) return false;
  return true;
}
}  // namespace

TEST(netconfWhatWasReplacedOrRemovedLeavesNothingInMemory) {
  Rig r;
  CHECK(r.ask("0104686f6d6509736563726574313233") == "8001", "home, with a 9-byte password");
  const uint8_t* pass = r.c.pass(0).p;
  CHECK(r.ask("0104686f6d6508" "3132333435363738") == "8001" && r.c.pass(0).n == 8, "a shorter one replaces it");
  CHECK(zeroFrom(pass, 8, 9), "the ninth byte of the old password is gone");
  CHECK(r.ask("0104686f6d6500") == "8001" && r.c.pass(0).n == 0, "and now none");
  CHECK(zeroFrom(pass, 0, 9), "no byte of any password is left");

  CHECK(r.ask("01016208" "3132333435363738") == "8001", "b");
  CHECK(r.ask("010163" "00") == "8001", "c");
  const uint8_t* lastSsid = r.c.ssid(2).p;
  const uint8_t* lastPass = r.c.pass(2).p;
  CHECK(r.ask("0204686f6d65") == "8002" && r.c.count() == 2, "home removed");
  CHECK(zeroFrom(lastSsid, 0, 1) && zeroFrom(lastPass, 0, 8), "the slot that came free holds nothing");

  CHECK(r.ask("0409782e666c792e646576") == "8004", "a host of 9 bytes");
  const uint8_t* host = r.c.relay().p;
  CHECK(r.ask("04" "03" "612e62") == "8004" && r.c.relay().n == 3, "a host of 3 bytes");
  CHECK(zeroFrom(host, 3, 9), "the rest of the old host is gone");
}
