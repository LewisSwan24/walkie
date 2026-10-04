#include "proto/gate.h"
#include <string.h>
#include "proto/messages.h"

namespace proto {
namespace {
const uint32_t REFUSALS_IN_A_ROW = 8;

// The two types that are never sealed.
bool neverSealed(uint8_t type) { return type == T_HELLO || type == T_PAIR; }

// Does not stop at the first difference.
bool sameKey(const uint8_t* a, const uint8_t* b) {
  uint8_t diff = 0;
  for (size_t i = 0; i < KEY_BYTES; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}
}  // namespace

Gate::Gate()
    : c_(nullptr), store_(), random32_(nullptr), pending_(0), paired_(false), adpcm_(false), lastSealed_(false), nonceP_(0), nonceS_(0), firstCounter_(0) {
  memset(key_, 0, sizeof key_);
  memset(candidate_, 0, sizeof candidate_);
}

bool Gate::begin(const Crypto& c, const KeyStore& store, uint32_t (*random32)()) {
  if (!store.load || !store.save || !store.erase || !random32) return false;
  c_ = &c;
  store_ = store;
  random32_ = random32;
  session_.end();
  pending_ = 0;
  paired_ = store_.load(key_);
  if (!paired_) memset(key_, 0, sizeof key_);
  return true;
}

uint8_t Gate::helloFlags() const { return (uint8_t)((paired_ ? HELLO_PAIRED : 0) | (adpcm_ ? HELLO_ADPCM : 0)); }

Gate::Rx Gate::receive(const Frame& in, Frame& out) {
  lastSealed_ = false;
  if (in.type == T_HELLO) {
    uint32_t nonce = 0;
    if (!parseHello(in.payload, in.len, nonce)) return Drop;
    nonceP_ = nonce;
    nonceS_ = random32_();
    session_.end();
    if (paired_ && !session_.begin(*c_, key_, nonceP_, nonceS_, ROLE_S3, firstCounter_)) return Drop;
    out = in;
    return Hello;
  }
  if (in.type == T_PAIR) {
    if (in.flags & F_SEALED) return Drop;
    out = in;
    return Pair;
  }
  if (!paired_) {
    if (in.flags & F_SEALED) return Drop;
    out = in;
    return Deliver;
  }
  size_t n = 0;
  if (session_.open(in, rx_, sizeof rx_, n) != Session::Ok) {
    if (session_.failures() >= REFUSALS_IN_A_ROW) session_.end();
    return Drop;
  }
  out = in;
  out.flags = (uint8_t)(in.flags & ~F_SEALED);
  out.len = (uint16_t)n;
  out.payload = rx_;
  lastSealed_ = true;
  return Deliver;
}

Gate::Tx Gate::wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out) {
  if (neverSealed(type) || !paired_) {
    out.flags = flags;
    out.payload = payload;
    out.len = (uint16_t)len;
    return Plain;
  }
  if (!session_.active() || len > MAX_PLAIN) return Blocked;
  size_t n = session_.seal(type, flags, seq, payload, len, tx_, sizeof tx_);
  if (n == 0) {
    if (session_.exhausted()) session_.end();  // the counter is used up: the PC's refusals will make it say HELLO again
    return Blocked;                            // any other failure costs this frame only
  }
  out.flags = (uint8_t)(flags | F_SEALED);
  out.payload = tx_;
  out.len = (uint16_t)n;
  return Sealed;
}

Gate::PairAction Gate::onPair(const uint8_t* payload, size_t len, uint8_t& op) {
  PairMsg m = PairMsg();
  if (!parsePair(payload, len, m)) return PairIgnore;
  op = m.op;
  if (m.op == PAIR_SET) {
    if (paired_ && sameKey(key_, m.key)) {
      pending_ = 0;
      return PairReplyOk;
    }
    memcpy(candidate_, m.key, KEY_BYTES);
    pending_ = PAIR_SET;
    return PairAsk;
  }
  if (!paired_) {
    pending_ = 0;
    return PairReplyOk;
  }
  pending_ = PAIR_FORGET;
  return PairAsk;
}

Gate::PairReply Gate::answer(bool yes) {
  PairReply r = PairReply();
  if (pending_ == 0) return r;
  uint8_t op = pending_;
  pending_ = 0;
  r.send = true;
  r.answered = op;
  r.op = PAIR_DENIED;
  if (yes) {
    if (op == PAIR_SET) {
      if (store_.save(candidate_)) {
        memcpy(key_, candidate_, KEY_BYTES);
        paired_ = true;
        r.op = PAIR_OK;
      }
    } else if (store_.erase()) {
      memset(key_, 0, sizeof key_);
      paired_ = false;
      r.op = PAIR_OK;
    }
  }
  memset(candidate_, 0, sizeof candidate_);
  if (r.op == PAIR_OK) session_.end();  // the old keys came from the old key
  return r;
}
}  // namespace proto
