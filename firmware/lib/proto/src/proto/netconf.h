// netconf.h: the Wi-Fi networks and the relay host the S3 holds (protocol/frames.md, "Network settings (plan 6)"), apart from where
// they are kept, so that the host tests can run all of it. The PC sets them with sealed NET frames; handle() does what a request asks
// and builds the reply; the connection code reads them back with count(), ssid(), pass() and relay().
//
// Not thread safe: netconf_nvs.cpp puts one lock around every use on the device.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"

namespace proto {
// Everything is kept as one blob: version, count, (ssid length, ssid, password length, password) x count, host length, host.
const size_t NETCONF_BLOB_MAX = 2 + NET_NETWORKS_MAX * (2 + NET_SSID_MAX + NET_PASS_MAX) + 1 + NET_HOST_MAX;

// Where the blob lives. The device keeps it in NVS; the host tests keep it in a variable.
struct NetStore {
  bool (*load)(uint8_t* buf, size_t cap, size_t& n);  // the blob into buf; false when there is none
  bool (*save)(const uint8_t* buf, size_t n);         // false when it could not be stored
};

class NetConf {
 public:
  NetConf();
  // Loads what the store holds. A blob that is not exactly what save() writes is the same as none: nothing is held.
  // False when the store has no functions.
  bool begin(const NetStore& store);

  // Each returns 0, or the NETERR_* reason. A change that cannot be saved is not made.
  uint8_t add(Text ssid, Text pass);  // a network already held (same SSID) takes the new password; a fifth network is NETERR_FULL
  uint8_t remove(Text ssid);          // NETERR_UNKNOWN when it is not held
  uint8_t setRelay(Text host);
  uint8_t clearRelay();               // nothing set is fine

  size_t count() const { return s_.n; }
  Text ssid(size_t i) const;   // empty past the last
  Text pass(size_t i) const;
  Text relay() const;          // empty when none is set
  // Goes up by one for every change that was made, so a reader can tell that what it holds is old.
  uint32_t generation() const { return generation_; }

  // Does a request and writes the reply payload: OK, ERR, or for LIST the SSIDs and the host (never a password).
  // Returns its length, or 0 when cap is too small.
  size_t handle(const NetMsg& m, uint8_t* out, size_t cap);

 private:
  struct Net {
    uint8_t sl, pl;
    uint8_t ssid[NET_SSID_MAX];
    uint8_t pass[NET_PASS_MAX];
  };
  struct State {
    uint8_t n;
    Net nets[NET_NETWORKS_MAX];
    uint8_t hl;
    uint8_t host[NET_HOST_MAX];
  };
  size_t encode(uint8_t* buf) const;
  static bool decode(const uint8_t* buf, size_t n, State& s);
  uint8_t commit(const State& old);  // saves s_; puts old back and says NETERR_STORE when that fails
  int find(Text ssid) const;

  NetStore store_;
  State s_;
  uint32_t generation_;
};
}  // namespace proto
