// usblink.cpp: see usblink.h.
#include "usblink.h"
#include <Arduino.h>
#include <atomic>
#include <freertos/ringbuf.h>
#include <stdarg.h>
#include <stdio.h>
#include <esp_system.h>
#include "crypto_mbedtls.h"
#include "keystore_nvs.h"
#include "netconf_nvs.h"
#include "netlink.h"
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/messages.h"
#include "proto/router.h"
#include "status.h"
#include "version.h"

namespace usblink {
namespace {
const size_t RX_QUEUE = 16384;  // the USB driver drops bytes beyond this; credit keeps audio below it
const size_t TX_RING = 32768;   // frames waiting to go: each item is a TX_* byte, then the COBS wire (USB) or the envelope (relay)
const size_t RELAY_RX = 8192;   // envelopes from the relay waiting for the RX task
const size_t RX_READ = 1024;
const uint32_t RX_STACK = 8192;  // 6144 before the gate: it opens frames and derives keys on this task
const uint32_t TX_STACK = 8192;  // 4096 before the relay: a TLS write runs on this task
enum : uint8_t { TX_USB = 1, TX_RELAY = 2 };
Handlers handlers;
RingbufHandle_t txRing = nullptr;
RingbufHandle_t relayRx = nullptr;
SemaphoreHandle_t txLock = nullptr;
uint16_t txSeq = 0;               // under txLock
proto::FrameDecoder decoder;      // RX task only
bool haveRxSeq = false;           // RX task only
uint16_t rxSeq = 0;               // RX task only
proto::Gate gate;                 // sealing and pairing; the RX task and txLock take turns (see gate.h)
proto::Router router(gate);       // which of USB and the relay is in use (spec 5.3); under txLock, as the gate is
std::atomic<int> pairAnswerPending{0};  // 0 nothing, 1 yes, 2 no: from the key press to the RX task

uint32_t randomNonce() { return esp_random(); }

// Queues one frame for `transport` (proto::TR_*, or ACTIVE: the one in use, read under the same lock): the relay gets the bare
// envelope, anything else the COBS wire on USB.
const uint8_t ACTIVE = 0xff;
bool sendVia(uint8_t transport, uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  static uint8_t item[1 + proto::MAX_WIRE];  // under txLock
  if (!txRing) return false;
  xSemaphoreTake(txLock, portMAX_DELAY);
  proto::Gate::Wire w;
  uint16_t seq = txSeq;
  bool ok = false;
  if (transport == ACTIVE) transport = router.selector().active();
  if (gate.wrap(type, flags, seq, payload, len, w) != proto::Gate::Blocked) {
    txSeq++;
    bool relay = transport == proto::TR_WSS;
    item[0] = relay ? TX_RELAY : TX_USB;
    size_t n = relay ? proto::encodeEnvelope(type, w.flags, seq, w.payload, w.len, item + 1, sizeof item - 1)
                     : proto::encodeFrame(type, w.flags, seq, w.payload, w.len, item + 1, sizeof item - 1);
    ok = n > 0 && xRingbufferSend(txRing, item, n + 1, 0) == pdTRUE;
  }
  xSemaphoreGive(txLock);
  if (!ok) g_status.txDropped++;
  return ok;
}

uint8_t activeTransport() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  uint8_t t = router.selector().active();
  xSemaphoreGive(txLock);
  return t;
}

// nonce: the one from the bridge's HELLO being answered, or 0 at boot. The S3's half of the session numbers and the flags come
// from the gate; read under the lock, since the RX task changes them at a HELLO. It goes on `transport`: an answer goes where the
// HELLO came from, which the router has just made the one in use.
void sayHello(uint32_t nonce, uint8_t transport) {
  uint8_t p[56];
  xSemaphoreTake(txLock, portMAX_DELAY);
  uint32_t nonceS = nonce ? gate.nonceS() : 0;
  uint8_t flags = gate.helloFlags();
  xSemaphoreGive(txLock);
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, nonceS, flags, WALKIE_VERSION, p, sizeof p);
  sendVia(transport, proto::T_HELLO, 0, p, (uint16_t)n);
}

void sendPairReply(const proto::Gate::PairReply& r) {
  uint8_t p[2];
  size_t n = proto::buildPairReply(r.op, r.answered, p, sizeof p);
  if (n) send(proto::T_PAIR, 0, p, (uint16_t)n);
}

void onPair(const proto::Frame& f) {
  uint8_t op = 0;
  xSemaphoreTake(txLock, portMAX_DELAY);
  proto::Gate::PairAction a = gate.onPair(f.payload, f.len, op);
  proto::Gate::PairReply denied = a == proto::Gate::PairAsk && !handlers.onPairRequest ? gate.answer(false) : proto::Gate::PairReply();
  xSemaphoreGive(txLock);
  if (a == proto::Gate::PairReplyOk) {
    proto::Gate::PairReply ok = {true, proto::PAIR_OK, op};
    sendPairReply(ok);
  } else if (denied.send) {
    sendPairReply(denied);
  } else if (a == proto::Gate::PairAsk) {
    handlers.onPairRequest(op);
  }
}

// NET (protocol/frames.md, "Network settings (plan 6)") counts only over a sealed link: a Wi-Fi password never travels in the
// clear, and nobody without the pairing key can set the networks or the relay. A request that is not sealed, or is not one, is refused.
void onNet(const proto::Frame& f, bool sealed) {
  proto::NetMsg m;
  if (!sealed || !proto::parseNet(f.payload, f.len, m)) {
    g_status.rxRefused++;
    return;
  }
  uint8_t p[200];  // the longest reply is a LIST: 2 + 4 x 33 + 1 + 63 = 198
  size_t n = netconf::handle(m, p, sizeof p);
  if (n) send(proto::T_NET, 0, p, (uint16_t)n);
}

void onFrame(const proto::Frame& raw, uint8_t transport) {
  proto::Frame f;
  xSemaphoreTake(txLock, portMAX_DELAY);  // a HELLO, or the eighth refusal, changes the session that send() seals with
  uint32_t other = router.otherTransport();
  proto::Gate::Rx rx = router.receive(transport, raw, f, millis());
  bool fromOther = router.otherTransport() != other;
  uint32_t nonce = gate.helloNonce();
  bool sealed = gate.lastSealed();
  xSemaphoreGive(txLock);
  if (rx == proto::Gate::Drop) {
    if (fromOther) g_status.rxOther++;
    else g_status.rxRefused++;
    return;
  }
  if (rx == proto::Gate::Pair) {
    onPair(f);
    return;
  }
  if (rx == proto::Gate::Hello) {
    haveRxSeq = true;
    rxSeq = f.seq;
    g_status.rxGaps = 0;
    if (handlers.onHello) handlers.onHello();
    sayHello(nonce, transport);
    return;
  }
  if (haveRxSeq && f.seq != (uint16_t)(rxSeq + 1)) g_status.rxGaps++;
  haveRxSeq = true;
  rxSeq = f.seq;
  switch (f.type) {
    case proto::T_PING: {
      uint32_t token;
      if (!proto::parsePing(f.payload, f.len, token)) return;
      uint32_t now = millis();
      uint8_t p[16];
      size_t n = proto::buildPong(token, now, decoder.bad(), g_status.rxGaps, p, sizeof p);
      send(proto::T_PONG, 0, p, (uint16_t)n);
      return;
    }
    case proto::T_NET:
      onNet(f, sealed);
      return;
    case proto::T_AUDIO_DOWN:
      if (handlers.onAudioDown) handlers.onAudioDown(f.payload, f.len, f.flags);
      return;
    case proto::T_CMD: {
      proto::Command c;
      if (proto::parseCmd(f.payload, f.len, c) && handlers.onCommand) handlers.onCommand(c.op, c.arg);
      return;
    }
    case proto::T_UI:
      if (handlers.onUi) handlers.onUi(f.payload, f.len);
      return;
    case proto::T_APPROVAL_REQ:
      if (handlers.onApprovalReq) handlers.onApprovalReq(f.payload, f.len);
      return;
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.args, t.len);
      return;
    }
    default:
      return;
  }
}

void onUsbFrame(const proto::Frame& f) { onFrame(f, proto::TR_USB); }

void rxTask(void*) {
  static uint8_t buf[RX_READ];
  for (;;) {
    int avail = Serial.available();
    if (avail > 0) {
      size_t n = Serial.read(buf, (size_t)avail < RX_READ ? (size_t)avail : RX_READ);
      if (n <= RX_READ) decoder.push(buf, n, onUsbFrame);
      g_status.rxBad = decoder.bad();
    }
    size_t en = 0;
    uint8_t* env;
    while ((env = (uint8_t*)xRingbufferReceive(relayRx, &en, 0)) != nullptr) {
      proto::Frame f = proto::Frame();
      if (proto::parseEnvelope(env, en, f)) onFrame(f, proto::TR_WSS);
      else g_status.rxBad++;
      vRingbufferReturnItem(relayRx, env);
    }
    int answer = pairAnswerPending.exchange(0);
    if (answer != 0) {
      xSemaphoreTake(txLock, portMAX_DELAY);
      proto::Gate::PairReply r = gate.answer(answer == 1);
      xSemaphoreGive(txLock);
      if (r.send) sendPairReply(r);
    }
    if (handlers.idle) handlers.idle();
    vTaskDelay(1);  // always: a busy link must not starve core 0's idle task (task watchdog)
  }
}

void txTask(void*) {
  for (;;) {
    size_t n = 0;
    uint8_t* item = (uint8_t*)xRingbufferReceive(txRing, &n, portMAX_DELAY);
    if (!item) continue;
    if (n > 1 && item[0] == TX_RELAY) {
      if (!netlink::sendEnvelope(item + 1, n - 1)) g_status.txDropped++;  // the relay went away under it
    } else {
      for (size_t off = 1; off < n;) {
        size_t w = Serial.write(item + off, n - off);
        if (w == 0) break;  // nobody is reading the port: the rest of this frame is lost
        off += w;
      }
    }
    vRingbufferReturnItem(txRing, item);
  }
}
}  // namespace

void begin(const Handlers& h) {
  handlers = h;
  Serial.setRxBufferSize(RX_QUEUE);  // both before begin(), or they do not take effect
  Serial.setTxBufferSize(4096);
  Serial.begin(115200);
  txRing = xRingbufferCreate(TX_RING, RINGBUF_TYPE_NOSPLIT);
  relayRx = xRingbufferCreate(RELAY_RX, RINGBUF_TYPE_NOSPLIT);
  txLock = xSemaphoreCreateMutex();
  gate.begin(mbedtlsCrypto(), nvsKeyStore(), randomNonce);
  gate.setAdpcm(true);  // HELLO says this S3 takes ADPCM
  xTaskCreatePinnedToCore(txTask, "linkTx", TX_STACK, nullptr, 4, nullptr, 0);
  // Tells a bridge that is already connected that walkie has (re)started. It is queued before the RX task exists, so no
  // answer to a HELLO that is already waiting in the USB FIFO, and no CREDIT, can go out ahead of it.
  sayHello(0, proto::TR_USB);
  xTaskCreatePinnedToCore(rxTask, "linkRx", RX_STACK, nullptr, 5, nullptr, 0);
}

bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  return sendVia(ACTIVE, type, flags, payload, len);
}

void logf(const char* fmt, ...) {
  char text[201];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(text, sizeof text, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n >= (int)sizeof text) n = sizeof text - 1;
  send(proto::T_LOG, 0, (const uint8_t*)text, (uint16_t)n);
}

void pairAnswer(bool yes) { pairAnswerPending = yes ? 1 : 2; }

bool online() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  bool on = router.selector().online(millis());
  xSemaphoreGive(txLock);
  return on;
}

uint8_t transport() { return activeTransport(); }

void fromRelay(const uint8_t* env, size_t n) {
  if (!relayRx || xRingbufferSend(relayRx, env, n, 0) != pdTRUE) g_status.relayLost++;
}

void relayConnected() { sayHello(0, proto::TR_WSS); }

void relayDown() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  router.selector().onDown(proto::TR_WSS);
  xSemaphoreGive(txLock);
}
}  // namespace usblink
