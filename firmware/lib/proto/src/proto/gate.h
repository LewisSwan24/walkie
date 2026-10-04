// gate.h: what the S3 does with sealed frames and with pairing (protocol/frames.md, "Sealed frames" and "Pairing"), apart from the
// serial port and the screen, so that the host tests can run all of it. usblink.cpp owns one Gate: every received frame goes
// through receive(), every frame to send through wrap(), and PAIR frames and the key press through onPair() and answer().
//
// Threads: begin(), receive(), onPair() and answer() belong to the RX task. wrap() is called under the TX lock, and so must
// anything that changes the session, which receive() does when it sees a HELLO or the eighth refusal in a row: the caller
// holds the TX lock around receive() for those two cases (usblink.cpp takes it for every receive() call; it is cheap).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"
#include "proto/frame.h"
#include "proto/session.h"

namespace proto {
// Where the pairing key lives. The device keeps it in NVS; the host tests keep it in a variable.
struct KeyStore {
  bool (*load)(uint8_t* key);        // KEY_BYTES into key; false when there is none
  bool (*save)(const uint8_t* key);  // false when it could not be stored
  bool (*erase)();
};

class Gate {
 public:
  enum Rx {
    Drop,     // not for anyone: refused, or no good
    Hello,    // a PC HELLO: a session has been started if paired; answer with helloNonce(), nonceS() and helloFlags()
    Pair,     // a PAIR frame, plain as it must be: hand its payload to onPair()
    Deliver,  // an ordinary frame, opened if it was sealed: `out` holds it
  };
  enum Tx {
    Plain,    // send the frame as it is (an unpaired S3, or HELLO and PAIR)
    Sealed,   // send Wire: sealed
    Blocked,  // send nothing: a paired S3 never sends a plain frame, and there is no session to seal with
  };
  struct Wire {
    uint8_t flags;
    const uint8_t* payload;  // valid until the next wrap()
    uint16_t len;
  };
  enum PairAction {
    PairIgnore,   // not a request this S3 understands
    PairAsk,      // show the confirmation, then call answer()
    PairReplyOk,  // nothing to ask: answer OK now (the key is already the one held, or there is nothing to forget)
  };
  struct PairReply {
    bool send;         // false when no request was waiting
    uint8_t op;        // PAIR_OK or PAIR_DENIED
    uint8_t answered;  // the PC's op
  };

  Gate();
  // Loads the key, if the store has one. `random32` makes the S3's half of every session's keys.
  bool begin(const Crypto& c, const KeyStore& store, uint32_t (*random32)());

  bool paired() const { return paired_; }
  uint8_t helloFlags() const;  // HELLO_PAIRED when paired, HELLO_ADPCM when setAdpcm(true)
  void setAdpcm(bool on) { adpcm_ = on; }
  uint32_t helloNonce() const { return nonceP_; }  // the PC's nonce from the last HELLO
  uint32_t nonceS() const { return nonceS_; }      // this S3's half for the same session

  Rx receive(const Frame& in, Frame& out);
  // Whether the frame the last receive() delivered had come sealed. Plain on an unpaired S3, false after anything that was not
  // delivered: what is only to be done over a sealed link (NET) asks this, so that an unpaired S3 never takes it.
  bool lastSealed() const { return lastSealed_; }
  Tx wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out);

  PairAction onPair(const uint8_t* payload, size_t len, uint8_t& op);
  PairReply answer(bool yes);

  // For tests: the first send counter of the next session.
  void setFirstCounter(uint32_t c) { firstCounter_ = c; }

 private:
  const Crypto* c_;
  KeyStore store_;
  uint32_t (*random32_)();
  Session session_;
  uint8_t key_[KEY_BYTES];
  uint8_t candidate_[KEY_BYTES];
  uint8_t rx_[MAX_PAYLOAD];
  uint8_t tx_[MAX_PAYLOAD];
  uint8_t pending_;  // PAIR_SET or PAIR_FORGET while a request waits for the key press, else 0
  bool paired_;
  bool adpcm_;
  bool lastSealed_;
  uint32_t nonceP_, nonceS_, firstCounter_;
};
}  // namespace proto
