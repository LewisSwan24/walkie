// netconf_nvs.h: the S3's one NetConf (proto/netconf.h), kept in NVS. The link task writes it when a sealed NET frame asks; the
// connection code reads it. One lock covers both, and the readers get a copy, never a pointer into what the link task may change.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"
#include "proto/netconf.h"

namespace netconf {
// SSIDs and passwords are C strings, because that is what the Wi-Fi library takes (a NET request cannot hold a NUL).
struct Net {
  char ssid[proto::NET_SSID_MAX + 1];
  char pass[proto::NET_PASS_MAX + 1];
};
struct Snapshot {
  uint8_t count;
  Net nets[proto::NET_NETWORKS_MAX];
  char host[proto::NET_HOST_MAX + 1];  // empty when no relay is set
  uint32_t generation;                 // NetConf::generation() at the time of the copy
};

// Loads what NVS holds. Call once at boot, before usblink::begin().
void begin();
// A NET request that came sealed: does it and writes the reply payload. Returns its length, or 0.
size_t handle(const proto::NetMsg& m, uint8_t* out, size_t cap);
void snapshot(Snapshot& s);
uint32_t generation();
}  // namespace netconf
