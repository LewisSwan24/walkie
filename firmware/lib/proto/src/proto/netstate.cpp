#include "proto/netstate.h"

#include <stdio.h>

namespace proto {
Backoff::Backoff(uint32_t firstMs, uint32_t maxMs) : first_(firstMs ? firstMs : 1), max_(maxMs < first_ ? first_ : maxMs), next_(first_) {}

uint32_t Backoff::next() {
  uint32_t now = next_;
  next_ = now > max_ / 2 ? max_ : now * 2;
  return now;
}

void Backoff::reset() { next_ = first_; }

uint32_t onlineWindowMs(uint8_t transport) {
  switch (transport) {
    case TR_USB:
      return 3000;
    case TR_WSS:
      return 10000;
    default:
      return 0;
  }
}

TransportSelector::TransportSelector() : active_(TR_NONE), pinged_(false), lastPing_(0), switches_(0) {}

bool TransportSelector::onFrame(uint8_t transport, bool hello, bool ping, uint32_t now) {
  if (transport != TR_USB && transport != TR_WSS) return false;
  if (hello) {
    if (transport != active_) {
      if (active_ != TR_NONE) switches_++;
      active_ = transport;
      pinged_ = false;
    }
    return true;
  }
  if (transport != active_) return false;
  if (ping) {
    pinged_ = true;
    lastPing_ = now;
  }
  return true;
}

void TransportSelector::onDown(uint8_t transport) {
  if (transport == active_) active_ = TR_NONE;  // online() is then false: TR_NONE has no window
}

bool TransportSelector::online(uint32_t now) const {
  return pinged_ && now - lastPing_ < onlineWindowMs(active_);
}

uint8_t offlineReason(const LinkView& v) {
  if (v.online) return LINK_ONLINE;
  if (!v.netWanted) return LINK_PC_OFFLINE;
  if (!v.wifiUp) return LINK_NO_WIFI;
  if (!v.relayUp) return LINK_RELAY_DOWN;
  return LINK_PC_OFFLINE;
}

size_t healthLine(const Health& h, char* out, size_t cap) {
  int n = snprintf(out, cap, "health battery %u%% heap %lu min %lu block %lu rssi %d link %s", (unsigned)h.battery, (unsigned long)h.heap,
                   (unsigned long)h.minHeap, (unsigned long)h.largest, h.rssi, h.link ? h.link : "?");
  return n > 0 && (size_t)n < cap ? (size_t)n : 0;
}
}  // namespace proto
