// test_gate.cpp: the S3's policy for sealed frames and pairing (protocol/frames.md, "Sealed frames" and "Pairing"), without a
// device: the primitives are host/ref_crypto.cpp's, the key store is a variable, the "PC" is a second Session.
#include <string.h>
#include "check.h"
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/messages.h"
#include "proto/router.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
using proto::Gate;
using proto::Session;

struct Store {
  static bool has;
  static uint8_t key[32];
  static int saves, erases;
  static bool failSave;
  static bool load(uint8_t* k) {
    if (!has) return false;
    memcpy(k, key, 32);
    return true;
  }
  static bool save(const uint8_t* k) {
    if (failSave) return false;
    memcpy(key, k, 32);
    has = true;
    saves++;
    return true;
  }
  static bool erase() {
    has = false;
    memset(key, 0, 32);
    erases++;
    return true;
  }
  static void reset(bool withKey) {
    has = withKey;
    failSave = false;
    saves = erases = 0;
    std::vector<uint8_t> m = unhex(kSealMaster);
    memset(key, 0, 32);
    if (withKey) memcpy(key, m.data(), 32);
  }
};
bool Store::has = false;
uint8_t Store::key[32];
int Store::saves = 0;
int Store::erases = 0;
bool Store::failSave = false;

const char* msgHexOf(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(m.name, name) == 0) return m.hex;
  CHECK(false, name);
  return "";
}

uint32_t g_nonceS = 0;
uint32_t rnd() { return g_nonceS++; }
const uint32_t kP = 0x11223344u;

proto::KeyStore store() {
  proto::KeyStore s;
  s.load = Store::load;
  s.save = Store::save;
  s.erase = Store::erase;
  return s;
}

// A gate that starts paired (with the vector's master key) or not, and the PC's session for the link its HELLO begins.
struct Rig {
  Gate gate;
  Session pc;
  uint8_t plain[1100];
  explicit Rig(bool paired, const proto::Crypto& crypto = refCrypto()) {
    Store::reset(paired);
    g_nonceS = kSealNonceS;
    CHECK(gate.begin(crypto, store(), rnd), "begin");
  }
  proto::Frame frame(uint8_t type, uint8_t flags, uint16_t seq, const std::vector<uint8_t>& payload) {
    proto::Frame f = proto::Frame();
    f.type = type;
    f.flags = flags;
    f.seq = seq;
    f.len = (uint16_t)payload.size();
    f.payload = payload.data();
    return f;
  }
  // The PC says HELLO with nonce kP; returns what the gate made of it.
  Gate::Rx hello(uint32_t nonceP = kP) {
    std::vector<uint8_t> p = {1, (uint8_t)nonceP, (uint8_t)(nonceP >> 8), (uint8_t)(nonceP >> 16), (uint8_t)(nonceP >> 24)};
    proto::Frame out;
    return gate.receive(frame(proto::T_HELLO, 0, 0, p), out);
  }
  // The PC's session for the HELLO just made (the gate drew `nonceS`).
  void pcBegin(uint32_t nonceP = kP) {
    std::vector<uint8_t> m = unhex(kSealMaster);
    CHECK(pc.begin(refCrypto(), m.data(), nonceP, gate.nonceS(), proto::ROLE_PC), "pc session");
  }
  // A frame as the PC sends it sealed.
  std::vector<uint8_t> sealed(uint8_t type, uint16_t seq, const std::vector<uint8_t>& payload, uint8_t* flagsOut = nullptr) {
    std::vector<uint8_t> out(payload.size() + proto::SEAL_OVERHEAD);
    size_t n = pc.seal(type, 0, seq, payload.data(), payload.size(), out.data(), out.size());
    out.resize(n);
    if (flagsOut) *flagsOut = proto::F_SEALED;
    return out;
  }
};
}  // namespace

TEST(gateAnUnpairedGateDeliversPlainFramesAndDropsSealedOnes) {
  Rig r(false);
  CHECK(!r.gate.paired() && r.gate.helloFlags() == 0, "unpaired");
  std::vector<uint8_t> p = {1, 0, 0, 0};
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_PING, 0, 5, p), out) == Gate::Deliver && out.type == proto::T_PING && out.seq == 5 &&
            out.len == 4 && memcmp(out.payload, p.data(), 4) == 0,
        "a plain PING goes through untouched");
  std::vector<uint8_t> junk(24, 1);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 6, junk), out) == Gate::Drop, "a sealed frame means nothing to an unpaired S3");
}

TEST(gateAHelloAnswersWithTheNoncesAndStartsASessionOnlyWhenPaired) {
  Rig un(false);
  CHECK(un.hello() == Gate::Hello && un.gate.helloNonce() == kP, "the nonce to echo");
  Rig r(true);
  CHECK(r.gate.paired() && (r.gate.helloFlags() & proto::HELLO_PAIRED), "paired flag");
  CHECK(r.hello() == Gate::Hello && r.gate.helloNonce() == kP, "the nonce to echo");
  CHECK(r.gate.nonceS() == kSealNonceS, "nonceS comes from the generator");
  proto::Frame out;
  std::vector<uint8_t> bad = {1, 2};
  CHECK(r.gate.receive(r.frame(proto::T_HELLO, 0, 0, bad), out) == Gate::Drop, "a HELLO too short to carry a nonce");
}

TEST(gateAPairedGateOpensSealedFramesAndRefusesPlainOnes) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 9, p);
  proto::Frame in = r.frame(proto::T_PING, proto::F_SEALED, 9, s), out;
  CHECK(r.gate.receive(in, out) == Gate::Deliver, "the sealed PING opens");
  CHECK(out.type == proto::T_PING && out.seq == 9 && !(out.flags & proto::F_SEALED) && out.len == 4 && memcmp(out.payload, p.data(), 4) == 0,
        "type and seq as sent, the seal bit gone, the plain payload");
  CHECK(r.gate.receive(r.frame(proto::T_PING, 0, 10, p), out) == Gate::Drop, "a plain frame is refused once paired");
  CHECK(r.gate.receive(in, out) == Gate::Drop, "a replay is refused");
}

TEST(gateEightRefusalsInARowEndTheSessionUntilTheNextHello) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  proto::Frame out;
  for (int i = 0; i < 8; i++) CHECK(r.gate.receive(r.frame(proto::T_PING, 0, (uint16_t)i, p), out) == Gate::Drop, "refused");
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 20, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 20, s), out) == Gate::Drop, "even a good frame is dropped now");
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Blocked, "and nothing goes out");
  r.hello(0x55);
  r.pcBegin(0x55);
  s = r.sealed(proto::T_PING, 21, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 21, s), out) == Gate::Deliver, "a new HELLO starts a new session");
}

TEST(gateSevenRefusalsAreNotTheEnd) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  proto::Frame out;
  for (int i = 0; i < 7; i++) r.gate.receive(r.frame(proto::T_PING, 0, (uint16_t)i, p), out);
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 20, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 20, s), out) == Gate::Deliver, "the session is still there");
}

TEST(gateAPairedGateSendsNothingPlainExceptHelloAndPair) {
  Rig r(true);
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Blocked, "no session yet: blocked, never plain");
  CHECK(r.gate.wrap(proto::T_LOG, 0, 1, p.data(), 4, w) == Gate::Blocked, "a LOG too");
  CHECK(r.gate.wrap(proto::T_HELLO, 0, 1, p.data(), 4, w) == Gate::Plain && w.len == 4 && w.payload == p.data() && w.flags == 0, "HELLO stays plain");
  CHECK(r.gate.wrap(proto::T_PAIR, 0, 1, p.data(), 4, w) == Gate::Plain && !(w.flags & proto::F_SEALED), "PAIR stays plain");
}

TEST(gateSealsWhatItSendsAndThePcOpensIt) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {9, 8, 7, 6, 5};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, proto::F_EOS, 3, p.data(), p.size(), w) == Gate::Sealed, "sealed");
  CHECK((w.flags & proto::F_SEALED) && (w.flags & proto::F_EOS) && w.len == p.size() + proto::SEAL_OVERHEAD, "the seal bit is set, the other flags stay");
  proto::Frame f = proto::Frame();
  f.type = proto::T_PONG;
  f.flags = w.flags;
  f.seq = 3;
  f.len = w.len;
  f.payload = w.payload;
  uint8_t out[64];
  size_t n = 0;
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == p.size() && memcmp(out, p.data(), n) == 0, "the PC opens it");
  std::vector<uint8_t> big(proto::MAX_PLAIN + 1, 1);
  CHECK(r.gate.wrap(proto::T_PONG, 0, 4, big.data(), big.size(), w) == Gate::Blocked, "too big to seal: blocked");
}

TEST(gateAnUnpairedGateSendsPlain) {
  Rig r(false);
  r.hello();
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Plain && w.payload == p.data() && w.len == 4 && w.flags == 0, "plain");
}

TEST(gateEveryHelloIsANewSession) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  uint32_t first = r.gate.nonceS();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> old = r.sealed(proto::T_PING, 1, p);
  r.hello();
  CHECK(r.gate.nonceS() != first, "another nonceS");
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 1, old), out) == Gate::Drop, "a frame of the old session does not open");
  r.pcBegin();
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 2, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 2, s), out) == Gate::Deliver, "the new one does");
}

TEST(gatePairSetAsksAndYesStoresTheKeyAndEndsTheSession) {
  Rig r(false);
  r.hello();
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk && op == proto::PAIR_SET, "asks");
  CHECK(Store::saves == 0 && !r.gate.paired(), "nothing stored before the answer");
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_OK && rep.answered == proto::PAIR_SET, "OK for the SET");
  CHECK(Store::saves == 1 && Store::has && memcmp(Store::key, k.data() + 1, 32) == 0, "the key is in the store");
  CHECK(r.gate.paired() && (r.gate.helloFlags() & proto::HELLO_PAIRED), "paired now");
  CHECK(!r.gate.answer(true).send, "the same answer twice does nothing");
  // The next HELLO starts a session under the key that was just paired.
  r.hello();
  Session pc;
  CHECK(pc.begin(refCrypto(), k.data() + 1, kP, r.gate.nonceS(), proto::ROLE_PC), "pc session under the new key");
  uint8_t sealedFrame[32];
  uint8_t body[4] = {7, 0, 0, 0};
  size_t n = pc.seal(proto::T_PING, 0, 1, body, 4, sealedFrame, sizeof sealedFrame);
  proto::Frame in = proto::Frame(), out;
  in.type = proto::T_PING;
  in.flags = proto::F_SEALED;
  in.seq = 1;
  in.len = (uint16_t)n;
  in.payload = sealedFrame;
  CHECK(r.gate.receive(in, out) == Gate::Deliver, "a frame sealed under the new key opens");
}

TEST(gateAPairedGateTakesAReplacementKeyOnlyAfterTheKeyPress) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  proto::Frame out;
  std::vector<uint8_t> pairFrame = k;
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, 0, 1, pairFrame), out) == Gate::Pair, "PAIR is taken plain, though the gate is paired and in a session");
  CHECK(r.gate.onPair(out.payload, out.len, op) == Gate::PairAsk, "asks");
  CHECK(memcmp(Store::key, unhex(kSealMaster).data(), 32) == 0, "the old key stays until yes");
  CHECK(r.gate.answer(true).op == proto::PAIR_OK, "yes");
  CHECK(memcmp(Store::key, k.data() + 1, 32) == 0, "replaced");
  std::vector<uint8_t> p = {7, 0, 0, 0}, s = r.sealed(proto::T_PING, 5, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 5, s), out) == Gate::Drop, "the old session ended with the old key");
}

TEST(gateNoAnswerDeniesAndChangesNothing) {
  Rig r(false);
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "asks");
  Gate::PairReply rep = r.gate.answer(false);
  CHECK(rep.send && rep.op == proto::PAIR_DENIED && rep.answered == proto::PAIR_SET, "DENIED for the SET");
  CHECK(Store::saves == 0 && !Store::has && !r.gate.paired(), "nothing stored");
}

TEST(gateASaveThatFailsDenies) {
  Rig r(false);
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  r.gate.onPair(k.data(), k.size(), op);
  Store::failSave = true;
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_DENIED && !r.gate.paired(), "denied, still unpaired");
}

TEST(gateSetWithTheKeyItAlreadyHoldsIsAnsweredWithoutAsking) {
  Rig r(true);
  std::vector<uint8_t> k(33);
  k[0] = proto::PAIR_SET;
  memcpy(k.data() + 1, Store::key, 32);
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairReplyOk && op == proto::PAIR_SET, "answered at once");
  CHECK(!r.gate.answer(true).send && Store::saves == 0, "and there is nothing to answer");
  k[5] ^= 1;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "one different byte asks");
  k[5] ^= 1;
  k[32] ^= 1;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "and so does a different last byte");
}

TEST(gateForgetAsksWhenPairedAndErasesOnYes) {
  Rig r(true);
  r.hello();
  uint8_t forget[1] = {proto::PAIR_FORGET}, op = 0;
  CHECK(r.gate.onPair(forget, 1, op) == Gate::PairAsk && op == proto::PAIR_FORGET, "asks");
  CHECK(Store::erases == 0 && r.gate.paired(), "not before yes");
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_OK && rep.answered == proto::PAIR_FORGET, "OK for the FORGET");
  CHECK(Store::erases == 1 && !Store::has && !r.gate.paired() && r.gate.helloFlags() == 0, "forgotten");
  CHECK(r.gate.onPair(forget, 1, op) == Gate::PairReplyOk, "forgetting nothing is answered OK at once");
}

TEST(gatePairIgnoresWhatItDoesNotUnderstandAndSealedPairFrames) {
  Rig r(false);
  uint8_t op = 0;
  uint8_t bad[2] = {proto::PAIR_FORGET, 0};
  CHECK(r.gate.onPair(bad, 2, op) == Gate::PairIgnore, "FORGET with a tail");
  uint8_t ok[2] = {proto::PAIR_OK, 1};
  CHECK(r.gate.onPair(ok, 2, op) == Gate::PairIgnore, "a reply is not a request");
  CHECK(r.gate.onPair(bad, 0, op) == Gate::PairIgnore, "empty");
  CHECK(!r.gate.answer(true).send, "and none of it left anything pending");
  proto::Frame out;
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, proto::F_SEALED, 1, k), out) == Gate::Drop, "PAIR is never sealed");
}

TEST(gateTheKeyInTheStoreIsTheOneItStartsWith) {
  Rig r(true);
  CHECK(r.gate.paired(), "paired at begin");
  Store::reset(false);
  Gate g2;
  g_nonceS = kSealNonceS;
  CHECK(g2.begin(refCrypto(), store(), rnd) && !g2.paired(), "unpaired when the store is empty");
}

bool g_failSeal = false;
bool flakySeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
               uint8_t* tag) {
  return !g_failSeal && refCrypto().gcmSeal(key, nonce, aad, aadLen, in, len, out, tag);
}
const proto::Crypto& flakyCrypto() {
  static proto::Crypto c;
  c = refCrypto();
  c.gcmSeal = flakySeal;
  return c;
}

// A seal that fails for any reason but the counter (a busy or faulty GCM) costs that one frame, not the session: ending it would make the
// S3 go quiet until the PC's PONG timeout says HELLO again.
TEST(gateASealThatFailsDropsTheFrameAndKeepsTheSession) {
  Rig r(true, flakyCrypto());
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  g_failSeal = true;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Blocked, "the frame is dropped and nothing goes out plain");
  g_failSeal = false;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 2, p.data(), 4, w) == Gate::Sealed, "the next frame seals: the session is still there");
}

TEST(gateTheSendCounterEndingEndsTheSession) {
  Rig r(true);
  r.gate.setFirstCounter(0xFFFFFFFFu);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Sealed, "the last counter seals");
  CHECK(r.gate.wrap(proto::T_PONG, 0, 2, p.data(), 4, w) == Gate::Blocked, "the next does not, and nothing goes out plain");
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 3, s), out) == Gate::Drop, "the session is over until the next HELLO");
}


TEST(gateSaysWhetherTheFrameItDeliveredCameSealed) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  CHECK(!r.gate.lastSealed(), "nothing delivered yet");
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_NET, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_NET, proto::F_SEALED, 3, s), out) == Gate::Deliver, "the sealed NET frame opens");
  CHECK(r.gate.lastSealed() && out.type == proto::T_NET && out.len == 1 && out.payload[0] == 3, "and it says it came sealed");
  CHECK(r.gate.receive(r.frame(proto::T_NET, 0, 4, p), out) == Gate::Drop, "the same frame plain is dropped");
  CHECK(!r.gate.lastSealed(), "and a drop is not sealed: the answer is about the last frame only");
}

TEST(gateAnUnpairedGateDeliversPlainAndSaysItWasNotSealed) {
  Rig r(false);
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_NET, 0, 1, p), out) == Gate::Deliver, "delivered");
  CHECK(!r.gate.lastSealed(), "but plain, so NET handling has to refuse it");
}

TEST(gateHelloAndPairAreNeverSealedEvenRightAfterASealedFrame) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_NET, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_NET, proto::F_SEALED, 3, s), out) == Gate::Deliver && r.gate.lastSealed(), "sealed");
  std::vector<uint8_t> forget = {proto::PAIR_FORGET};
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, 0, 5, forget), out) == Gate::Pair && !r.gate.lastSealed(), "PAIR");
  CHECK(r.hello() == Gate::Hello && !r.gate.lastSealed(), "HELLO");
}

TEST(gateNetIsSealedWhenSentAndNeverPlainOnAPairedGate) {
  Rig r(true);
  std::vector<uint8_t> p = {0x80, 1};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_NET, 0, 1, p.data(), 2, w) == Gate::Blocked, "no session: blocked, never plain");
  r.hello();
  r.pcBegin();
  CHECK(r.gate.wrap(proto::T_NET, 0, 2, p.data(), 2, w) == Gate::Sealed && (w.flags & proto::F_SEALED) && w.len == 2 + proto::SEAL_OVERHEAD,
        "sealed");
  proto::Frame f = proto::Frame();
  f.type = proto::T_NET;
  f.flags = w.flags;
  f.seq = 2;
  f.len = w.len;
  f.payload = w.payload;
  uint8_t out[16];
  size_t n = 0;
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == 2 && out[0] == 0x80 && out[1] == 1, "the PC opens it");
}


// The Router (proto/router.h): frames from the cable and from the relay into this one Gate (spec 5.3). The Rig above is the gate.
namespace {
std::vector<uint8_t> helloPayload(uint32_t nonceP) {
  return {1, (uint8_t)nonceP, (uint8_t)(nonceP >> 8), (uint8_t)(nonceP >> 16), (uint8_t)(nonceP >> 24)};
}
}  // namespace

TEST(routerAtBootTheCableIsHeardAsItAlwaysWas) {
  Rig r(false);
  proto::Router router(r.gate);
  CHECK(router.selector().active() == proto::TR_USB, "USB until a HELLO says otherwise");
  std::vector<uint8_t> p = {1, 0, 0, 0};
  proto::Frame out;
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 100) == Gate::Deliver, "a plain PING on USB, before any HELLO");
  CHECK(router.selector().online(100), "and it counts");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, 0, 2, p), out, 100) == Gate::Drop && router.otherTransport() == 1,
        "the same on the relay is dropped, and counted");
}

TEST(routerAHelloOnTheRelaySwitchesAndTheCableIsThenDropped) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 10) == Gate::Hello, "HELLO on the relay");
  CHECK(router.selector().active() == proto::TR_WSS && r.gate.helloNonce() == kP, "the relay is in use, with the session of that HELLO");
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  uint8_t flags = 0;
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 1, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 1, s), out, 20) == Gate::Drop, "the same sealed PING on USB is dropped");
  CHECK(router.otherTransport() == 1, "as from the transport not in use");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, flags, 1, s), out, 30) == Gate::Deliver && out.type == proto::T_PING,
        "and on the relay it opens: the drop on USB did not spend its counter");
  CHECK(router.selector().online(30) && router.selector().online(10029) && !router.selector().online(10030), "online, 10 s on the relay");
}

TEST(routerOnlyADeliveredPingMakesItOnline) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 5) == Gate::Drop, "a plain PING to a paired S3");
  CHECK(!router.selector().online(5), "is not online");
  uint8_t flags = 0;
  std::vector<uint8_t> cmd = r.sealed(proto::T_CMD, 2, std::vector<uint8_t>{1, 0}, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_CMD, flags, 2, cmd), out, 6) == Gate::Deliver && !router.selector().online(6),
        "nor is a sealed frame that is not a PING");
  std::vector<uint8_t> ping = r.sealed(proto::T_PING, 3, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 3, ping), out, 7) == Gate::Deliver && router.selector().online(7),
        "a sealed PING is");
}

TEST(routerPairingIsOnlyEverOverTheCable) {
  Rig r(false);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  std::vector<uint8_t> set = unhex(msgHexOf("pair_set"));
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PAIR, 0, 1, set), out, 1) == Gate::Drop, "a PAIR on the relay, the transport in use");
  CHECK(router.selector().active() == proto::TR_WSS, "changes nothing");
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 2);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PAIR, 0, 1, set), out, 3) == Gate::Pair, "over the cable it is a PAIR");
}

TEST(routerAHelloTheGateRefusesSwitchesNothing) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> shortHello = {1, 2};
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, shortHello), out, 0) == Gate::Drop, "too short to carry a nonce");
  CHECK(router.selector().active() == proto::TR_USB && router.selector().switches() == 0, "still the cable");
}

TEST(routerAFrameFromNoTransportNeverReachesTheGate) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  uint32_t nonceS = r.gate.nonceS();
  std::vector<uint8_t> other = helloPayload(kP + 1);
  CHECK(router.receive(proto::TR_NONE, r.frame(proto::T_HELLO, 0, 0, other), out, 1) == Gate::Drop, "TR_NONE");
  CHECK(router.receive(9, r.frame(proto::T_HELLO, 0, 0, other), out, 1) == Gate::Drop, "a transport that does not exist");
  CHECK(r.gate.helloNonce() == kP && r.gate.nonceS() == nonceS, "the session is the one the cable's HELLO began");
}

TEST(routerWhenTheRelayGoesAwayNothingIsTakenUntilTheNextHello) {
  Rig r(false);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  std::vector<uint8_t> p = {1, 0, 0, 0};
  router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  router.selector().onDown(proto::TR_WSS);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 1) == Gate::Drop, "not the cable");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, 0, 2, p), out, 1) == Gate::Drop, "not the relay");
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 2) == Gate::Hello &&
            router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 3, p), out, 3) == Gate::Deliver,
        "a HELLO on the cable brings it back");
}


TEST(routerOrdinaryFramesOnTheTransportInUseChangeNothingAboutIt) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  r.pcBegin();
  uint8_t flags = 0;
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> ping = r.sealed(proto::T_PING, 1, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 1, ping), out, 5) == Gate::Deliver && router.selector().online(5),
        "online after a sealed PING");
  uint32_t switches = router.selector().switches();
  std::vector<uint8_t> cmd = r.sealed(proto::T_CMD, 2, std::vector<uint8_t>{1, 0}, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_CMD, flags, 2, cmd), out, 6) == Gate::Deliver, "a sealed CMD on USB");
  CHECK(router.selector().online(6), "leaves it online: only a HELLO starts the transport over");
  CHECK(router.selector().switches() == switches && router.selector().active() == proto::TR_USB, "and is no switch");
}
