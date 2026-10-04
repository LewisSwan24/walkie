// test_netstate.cpp: how the S3 waits between reconnects, which transport it sends on when the cable and the relay are both up, and
// which link OFFLINE names (spec 5.2 to 5.4), without a device: time is a number the test moves.
#include "check.h"
#include <cstring>

#include "proto/netstate.h"

using proto::Backoff;
using proto::LinkView;
using proto::TransportSelector;

TEST(backoffDoublesFromOneSecondAndStopsAtThirty) {
  Backoff b;
  const uint32_t want[] = {1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000};
  for (uint32_t w : want) CHECK(b.next() == w, "1, 2, 4, 8, 16, then 30 s and no more");
  b.reset();
  CHECK(b.next() == 1000 && b.next() == 2000, "a success starts it again from 1 s");
}

TEST(backoffTakesOtherBoundsButNeverZeroOrAMaxBelowTheFirst) {
  Backoff b(500, 1500);
  CHECK(b.next() == 500 && b.next() == 1000 && b.next() == 1500 && b.next() == 1500, "500, 1000, then the cap");
  Backoff zero(0, 4);
  CHECK(zero.next() == 1 && zero.next() == 2 && zero.next() == 4 && zero.next() == 4, "a first delay of 0 is 1 ms: never a busy loop");
  Backoff odd(1000, 2001);
  CHECK(odd.next() == 1000 && odd.next() == 2000 && odd.next() == 2001, "it doubles while that stays under the cap, then takes the cap");
  Backoff upside(3000, 1000);
  CHECK(upside.next() == 3000 && upside.next() == 3000, "a max below the first is the first");
  Backoff big(0x80000000u, 0xffffffffu);
  CHECK(big.next() == 0x80000000u && big.next() == 0xffffffffu && big.next() == 0xffffffffu, "doubling past 32 bits stops at the max");
}

TEST(onlineWindowsAreThreeSecondsOnUsbAndTenOnTheRelay) {
  CHECK(proto::onlineWindowMs(proto::TR_USB) == 3000, "USB, as before");
  CHECK(proto::onlineWindowMs(proto::TR_WSS) == 10000, "the relay: a hotspot's jitter is not a disconnect");
  CHECK(proto::onlineWindowMs(proto::TR_NONE) == 0, "nothing");
}

TEST(selectorSendsNowhereAndIsOfflineUntilAHello) {
  TransportSelector s;
  CHECK(s.active() == proto::TR_NONE && !s.online(5), "nothing yet");
  CHECK(!s.onFrame(proto::TR_USB, false, true, 10), "a PING before any HELLO is not taken");
  CHECK(!s.online(20), "and does not make it online");
  CHECK(!s.onFrame(proto::TR_NONE, true, false, 30) && s.active() == proto::TR_NONE, "a HELLO from no transport is not taken");
  CHECK(!s.onFrame(7, true, false, 30) && s.active() == proto::TR_NONE, "nor from one that is not USB or the relay");
  s.onFrame(proto::TR_USB, true, false, 40);
  CHECK(!s.onFrame(proto::TR_NONE, false, true, 50) && !s.onFrame(7, true, false, 50) && s.active() == proto::TR_USB, "and they change nothing later");
}

TEST(selectorOnlineMeansAPingOnTheActiveTransportWithinItsWindow) {
  TransportSelector s;
  CHECK(s.onFrame(proto::TR_USB, true, false, 1000), "HELLO on USB");
  CHECK(s.active() == proto::TR_USB && !s.online(1000), "sending on USB; a HELLO alone is not online");
  CHECK(s.onFrame(proto::TR_USB, false, true, 2000), "a PING");
  CHECK(s.online(2000) && s.online(4999) && !s.online(5000), "online for 3 s after it");
  CHECK(s.onFrame(proto::TR_USB, false, false, 4000), "another frame on USB is taken");
  CHECK(!s.online(5000), "but only a PING keeps it online");

  TransportSelector w;
  w.onFrame(proto::TR_WSS, true, false, 0);
  w.onFrame(proto::TR_WSS, false, true, 100);
  CHECK(w.online(10099) && !w.online(10100), "10 s on the relay");
}

TEST(selectorAHelloOnTheOtherTransportSwitchesAndTheOldOneIsDown) {
  TransportSelector s;
  s.onFrame(proto::TR_WSS, true, false, 0);
  s.onFrame(proto::TR_WSS, false, true, 500);
  CHECK(s.online(600), "online on the relay");
  CHECK(s.onFrame(proto::TR_USB, true, false, 700), "the cable goes in: HELLO on USB");
  CHECK(s.active() == proto::TR_USB && s.switches() == 1, "sending on USB now");
  CHECK(!s.online(700), "the relay's PING does not count for USB");
  CHECK(!s.onFrame(proto::TR_WSS, false, true, 800), "a PING still coming on the relay is dropped");
  CHECK(!s.onFrame(proto::TR_WSS, false, false, 800), "and so is anything else on it");
  CHECK(!s.online(800), "and it did not make it online");
  CHECK(s.onFrame(proto::TR_USB, false, true, 900) && s.online(900), "a PING on USB does");
  CHECK(s.onFrame(proto::TR_WSS, true, false, 1000) && s.active() == proto::TR_WSS && s.switches() == 2, "and back, by a HELLO on the relay");
  CHECK(!s.online(1000), "the USB PING does not carry over");
}

TEST(selectorAHelloOnTheSameTransportKeepsItAndItsPing) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0);
  s.onFrame(proto::TR_USB, false, true, 100);
  CHECK(s.onFrame(proto::TR_USB, true, false, 200), "a new HELLO on USB");
  CHECK(s.active() == proto::TR_USB && s.switches() == 0 && s.online(200), "nothing moved");
}

TEST(selectorATransportThatGoesAwayStopsBeingSentOn) {
  TransportSelector s;
  s.onFrame(proto::TR_WSS, true, false, 0);
  s.onFrame(proto::TR_WSS, false, true, 10);
  s.onDown(proto::TR_USB);
  CHECK(s.active() == proto::TR_WSS && s.online(20), "the other one going away changes nothing");
  s.onDown(proto::TR_WSS);
  CHECK(s.active() == proto::TR_NONE && !s.online(20), "the relay connection closed: nowhere to send, offline at once");
  CHECK(!s.onFrame(proto::TR_WSS, false, true, 30), "a PING after it, without a HELLO, is not taken");
  CHECK(s.onFrame(proto::TR_WSS, true, false, 40) && s.active() == proto::TR_WSS, "a HELLO brings it back");
}

TEST(selectorSurvivesTheMillisecondCounterWrapping) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0xfffffc00u);
  s.onFrame(proto::TR_USB, false, true, 0xfffffc00u);
  CHECK(s.online(0xfffffc00u + 2999u) && !s.online(0xfffffc00u + 3000u), "3 s, across the wrap");
}

TEST(selectorAPingAtTimeZeroStillCounts) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0);
  s.onFrame(proto::TR_USB, false, true, 0);
  CHECK(s.online(0) && s.online(2999), "a PING at 0 ms is a PING");
}

TEST(offlineSaysWhichLinkIsDown) {
  LinkView v = {};
  v.online = true;
  CHECK(proto::offlineReason(v) == proto::LINK_ONLINE, "online, whatever else");
  v.online = false;
  CHECK(proto::offlineReason(v) == proto::LINK_PC_OFFLINE, "no network set up: the cable's PC is the only way, and it is not there");
  v.netWanted = true;
  CHECK(proto::offlineReason(v) == proto::LINK_NO_WIFI, "networks set, none joined");
  v.relayUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_NO_WIFI, "a relay link without Wi-Fi under it is still no Wi-Fi");
  v.relayUp = false;
  v.wifiUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_RELAY_DOWN, "Wi-Fi joined, relay not reached");
  v.relayUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_PC_OFFLINE, "relay reached, no PC pinging");
  v.online = true;
  CHECK(proto::offlineReason(v) == proto::LINK_ONLINE, "and then it is");
}

TEST(healthLineCarriesTheHeapLowWaterMarkAndTheLargestBlock) {
  char out[160];
  proto::Health h = {87, 123456, 98765, 45056, -60, "online"};
  size_t n = proto::healthLine(h, out, sizeof out);
  CHECK(n == strlen(out), "the length it returns is the line's");
  CHECK(strcmp(out, "health battery 87% heap 123456 min 98765 block 45056 rssi -60 link online") == 0,
        "the heap now, its lowest since boot (a TLS handshake falls between two samples) and the largest free block");
  CHECK(proto::healthLine(h, out, 20) == 0, "a line that does not fit is not cut short");
}
