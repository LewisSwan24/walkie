// test_state.cpp: payloads, the ring, the credit ledger and the test pattern.
#include <string.h>
#include "check.h"
#include "proto/credit.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "proto/pattern.h"
#include "proto/ring.h"
#include "vectors.h"

static std::string msgHex(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(m.name, name) == 0) return m.hex;
  printf("no vector named %s\n", name);
  g_fail++;
  return "";
}

TEST(builtPayloadsMatchVectors) {
  uint8_t out[64];
  size_t n = proto::buildHello(16000, 24000, 2097152, 123456, 0x5EED1234u, 0x0A0B0C0Du, proto::HELLO_PAIRED | proto::HELLO_ADPCM, "0.2.0",
                               out, sizeof out);
  CHECK(tohex(out, n) == msgHex("hello_device_v2"), "hello_device_v2");
  n = proto::buildPairReply(proto::PAIR_OK, proto::PAIR_SET, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pair_ok_set"), "pair_ok_set");
  n = proto::buildPairReply(proto::PAIR_DENIED, proto::PAIR_FORGET, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pair_denied_forget"), "pair_denied_forget");
  CHECK(proto::buildPairReply(proto::PAIR_OK, proto::PAIR_SET, out, 1) == 0, "a pair reply into a short buffer");
  n = proto::buildPong(0x12345678u, 5000, 1, 2, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pong"), "pong");
  n = proto::buildCredit(12288, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("credit"), "credit");
  proto::Played pl = {480000, 0xCBF43926u, 3, 12288, proto::PLAYED_STOPPED};
  n = proto::buildPlayed(pl, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("played"), "played");
  CHECK(proto::buildPong(1, 2, 3, 4, out, 15) == 0, "pong into a short buffer");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, 6, 0, "0.1.0", out, 27) == 0, "hello into a short buffer: 23 bytes and the version");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, 6, 0, "0.1.0", out, 28) == 28, "and just enough");
}

TEST(parsedPayloadsMatchVectors) {
  std::vector<uint8_t> b = unhex(msgHex("hello_bridge").c_str());
  uint32_t nonce = 0;
  CHECK(proto::parseHello(b.data(), b.size(), nonce) && nonce == 0x5EED1234u, "hello_bridge");
  CHECK(!proto::parseHello(b.data(), 4, nonce), "short hello");
  proto::PairMsg pm = proto::PairMsg();
  b = unhex(msgHex("pair_set").c_str());
  CHECK(proto::parsePair(b.data(), b.size(), pm) && pm.op == proto::PAIR_SET && pm.key && tohex(pm.key, 32) == tohex(b.data() + 1, 32),
        "pair_set");
  CHECK(!proto::parsePair(b.data(), 32, pm), "a SET one byte short");
  b.push_back(0);
  CHECK(!proto::parsePair(b.data(), b.size(), pm), "a SET one byte long");
  b = unhex(msgHex("pair_forget").c_str());
  CHECK(proto::parsePair(b.data(), b.size(), pm) && pm.op == proto::PAIR_FORGET && pm.key == nullptr, "pair_forget");
  b = unhex(msgHex("pair_ok_set").c_str());
  CHECK(!proto::parsePair(b.data(), b.size(), pm), "a reply is not a request");
  CHECK(!proto::parsePair(b.data(), 0, pm), "empty");
  b = unhex(msgHex("ping").c_str());
  uint32_t token = 0;
  CHECK(proto::parsePing(b.data(), b.size(), token) && token == 0x12345678u, "ping");
  CHECK(!proto::parsePing(b.data(), 3, token), "short ping");
  struct {
    const char* name;
    uint8_t op, arg;
  } cmds[] = {{"cmd_set_volume", 1, 200},
              {"cmd_set_mic_gain", 2, 4},
              {"cmd_stop_audio", 3, 0},
              {"cmd_boot_app0", 4, 0},
              {"cmd_reboot", 5, 0},
              {"cmd_set_codec", 6, 1}};
  for (auto& c : cmds) {
    b = unhex(msgHex(c.name).c_str());
    proto::Command cmd = {0, 0};
    CHECK(proto::parseCmd(b.data(), b.size(), cmd) && cmd.op == c.op && cmd.arg == c.arg, c.name);
  }
  b = unhex(msgHex("test_up_pattern").c_str());
  proto::TestOp t = {0, nullptr, 0};
  uint16_t frames = 0;
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_UP_PATTERN &&
            proto::parseUpPattern(t.args, t.len, frames) && frames == 250,
        "test_up_pattern");
  CHECK(!proto::parseUpPattern(t.args, 1, frames), "a pattern length cut short");
  b = unhex(msgHex("test_selftest").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_SELFTEST && t.len == 0, "test_selftest");
  CHECK(!proto::parseTest(b.data(), 0, t), "an empty TEST payload");
}

TEST(ringWrapsAcrossTheCounterLimit) {
  static uint8_t mem[16];
  proto::ByteRing r;
  r.attach(mem, 16, 0xFFFFFFF8u);
  uint8_t in[20], out[20];
  for (int i = 0; i < 20; i++) in[i] = (uint8_t)(i + 1);
  CHECK(r.write(in, 10) == 10 && r.size() == 10 && r.space() == 6, "write 10");
  CHECK(r.read(out, 4) == 4 && memcmp(out, in, 4) == 0, "read 4");
  CHECK(r.write(in + 10, 10) == 10 && r.size() == 16 && r.space() == 0, "fill across the wrap");
  CHECK(r.write(in, 1) == 0, "full");
  CHECK(r.read(out, 20) == 16 && memcmp(out, in + 4, 16) == 0, "read back in order");
  CHECK(r.write(in, 3) == 3, "write again");
  r.clear();
  CHECK(r.size() == 0 && r.space() == 16, "clear");
  proto::ByteRing none;
  CHECK(none.space() == 0 && none.write(in, 4) == 0, "an unattached ring takes nothing");
}

TEST(creditLedgerGrantsWhatFits) {
  proto::CreditLedger c(12288, 1920);
  CHECK(c.grantable(2097152) == 12288, "the first grant is the window");
  c.granted(12288);
  CHECK(c.grantable(2097152) == 0, "nothing while the window is out");
  c.received(960);
  CHECK(c.grantable(2097152) == 0, "960 back is below the step");
  c.received(960);
  CHECK(c.grantable(2097152) == 1920, "1920 back is granted again");
  CHECK(c.grantable(12288) == 1920, "ring space counts what is still outstanding");
  CHECK(c.grantable(11000) == 0, "no grant the ring could not hold");
  c.received(20000);
  CHECK(c.violations() == 1 && c.outstanding() == 0, "overspending is counted");
  c.reset();
  CHECK(c.grantable(4000) == 4000, "after a reset the ring limits the grant");
}

TEST(patternMatchesVectors) {
  uint8_t b[16];
  for (uint32_t k = 0; k < 8; k++) {
    uint16_t s = proto::patternSample(k);
    b[2 * k] = (uint8_t)s;
    b[2 * k + 1] = (uint8_t)(s >> 8);
  }
  CHECK(tohex(b, 16) == kPatternFirst8, "first 8 samples");
  CHECK(proto::patternSample(80000) == kPatternAt80000, "sample 80000");
}

// Hard-coded from protocol/frames.md, not derived from the code under test.
TEST(messageConstantsMatchSpec) {
  CHECK((unsigned)proto::PROTO_VERSION == 2u, "PROTO_VERSION: what the S3 says in HELLO");
  CHECK((unsigned)proto::HELLO_PAIRED == 1u && (unsigned)proto::HELLO_ADPCM == 2u, "HELLO flags");
  CHECK((unsigned)proto::PAIR_SET == 1u && (unsigned)proto::PAIR_FORGET == 2u && (unsigned)proto::PAIR_OK == 3u &&
            (unsigned)proto::PAIR_DENIED == 4u,
        "PAIR ops");
  CHECK((unsigned)proto::T_PAIR == 0x32u, "T_PAIR");
  CHECK((unsigned)proto::CMD_SET_VOLUME == 1u, "CMD_SET_VOLUME");
  CHECK((unsigned)proto::CMD_SET_MIC_GAIN == 2u, "CMD_SET_MIC_GAIN");
  CHECK((unsigned)proto::CMD_STOP_AUDIO == 3u, "CMD_STOP_AUDIO");
  CHECK((unsigned)proto::CMD_BOOT_APP0 == 4u, "CMD_BOOT_APP0");
  CHECK((unsigned)proto::CMD_REBOOT == 5u, "CMD_REBOOT");
  CHECK((unsigned)proto::CMD_SET_CODEC == 6u, "CMD_SET_CODEC");
  CHECK((unsigned)proto::TEST_UP_PATTERN == 1u, "TEST_UP_PATTERN");
  CHECK((unsigned)proto::TEST_SELFTEST == 6u, "TEST_SELFTEST");
  CHECK((unsigned)proto::PLAYED_FINISHED == 0u, "PLAYED_FINISHED");
  CHECK((unsigned)proto::PLAYED_STOPPED == 1u, "PLAYED_STOPPED");
}

TEST(parsersRejectMissingArguments) {
  proto::Command cmd = {0, 0};
  const uint8_t vol[] = {proto::CMD_SET_VOLUME};
  CHECK(!proto::parseCmd(vol, 1, cmd), "SET_VOLUME without its argument");
  const uint8_t gain[] = {proto::CMD_SET_MIC_GAIN};
  CHECK(!proto::parseCmd(gain, 1, cmd), "SET_MIC_GAIN without its argument");
  const uint8_t codec[] = {proto::CMD_SET_CODEC};
  CHECK(!proto::parseCmd(codec, 1, cmd), "SET_CODEC without its argument");
  const uint8_t stop[] = {proto::CMD_STOP_AUDIO};
  CHECK(proto::parseCmd(stop, 1, cmd) && cmd.op == proto::CMD_STOP_AUDIO && cmd.arg == 0, "STOP_AUDIO needs no argument");
  proto::TestOp t = {0, nullptr, 0};
  uint16_t frames = 0;
  const uint8_t pat[] = {proto::TEST_UP_PATTERN, 0xFA, 0x00};
  CHECK(proto::parseTest(pat, 1, t) && t.len == 0 && !proto::parseUpPattern(t.args, t.len, frames), "UP_PATTERN with no frame count");
  CHECK(proto::parseTest(pat, 2, t) && t.len == 1 && !proto::parseUpPattern(t.args, t.len, frames), "UP_PATTERN with half a frame count");
}

TEST(creditLedgerEdges) {
  proto::CreditLedger a(12288, 1920);
  a.granted(4000);
  CHECK(a.grantable(10000) == 6000, "ring-limited after 4000 out");
  CHECK(a.grantable(2097152) == 8288, "window-limited after 4000 out");
  proto::CreditLedger b(12288, 1920);
  b.granted(12288);
  CHECK(b.grantable(5000) == 0, "ring space below outstanding grants nothing");
  CHECK(b.grantable(12288) == 0, "ring space equal to outstanding grants nothing");
  proto::CreditLedger c(12288, 1920);
  c.granted(4000);
  c.received(4000);
  CHECK(c.violations() == 0 && c.outstanding() == 0, "spending exactly what is outstanding is no violation");
}
