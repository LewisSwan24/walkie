// walkie firmware for the M5StickS3. It runs from app1; on-the-beat keeps app0 (spec §6.7).
#include <M5Unified.h>
#include <esp_heap_caps.h>
#include <esp_ota_ops.h>
#include <atomic>
#include <freertos/queue.h>
#include "audio.h"
#include "crypto_mbedtls.h"
#include "netconf_nvs.h"
#include "netlink.h"
#include "proto/netstate.h"
#include "ui/offline.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "proto/selftest.h"
#include "screen.h"
#include "status.h"
#include "ui/gesture.h"
#include "ui/keyscript.h"
#include "ui/machine.h"
#include "usblink.h"
#include "version.h"

Status g_status;

namespace {
// The machine, the gesture detector and the key script belong to the UI loop alone. What the link RX task has for them
// comes through this queue.
ui::Machine machine;
ui::Gesture gesture;
ui::KeyScript keyScript;
// Set by the link RX task when the bridge (re)connects: a script the old bridge loaded is dropped by the UI loop.
std::atomic<bool> scriptReset{false};

enum Kind : uint8_t { K_UI, K_APPROVAL, K_KEYS, K_SNAP, K_PAIR };
struct Msg {
  uint8_t kind;
  uint16_t len;
  uint8_t data[proto::MAX_PAYLOAD];
};
QueueHandle_t inbox = nullptr;

void bootApp0() {
  const esp_partition_t* p0 =
      esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, nullptr);
  esp_err_t e = p0 ? esp_ota_set_boot_partition(p0) : ESP_ERR_NOT_FOUND;
  usblink::logf("boot app0: %s", esp_err_to_name(e));
  if (e != ESP_OK) return;
  delay(300);  // lets the LOG frame out
  esp_restart();
}

// Runs on the link RX task.
void post(Kind kind, const uint8_t* p, size_t n) {
  static Msg m;
  if (!inbox || n > sizeof m.data) return;
  m.kind = kind;
  m.len = (uint16_t)n;
  memcpy(m.data, p, n);
  if (xQueueSend(inbox, &m, 0) != pdTRUE) usblink::logf("ui queue full: a frame was dropped");
}

void onUiFrame(const uint8_t* p, size_t n) { post(K_UI, p, n); }
void onApprovalFrame(const uint8_t* p, size_t n) { post(K_APPROVAL, p, n); }

// Link RX task: the PC asks to set or forget the pairing key. The answer comes from a key press on the UI loop.
void onPairRequest(uint8_t op) { post(K_PAIR, &op, 1); }

// Runs on the link RX task.
void command(uint8_t op, uint8_t arg) {
  switch (op) {
    case proto::CMD_SET_VOLUME:
      g_status.volume = arg;
      usblink::logf("volume %u", arg);
      break;
    case proto::CMD_SET_MIC_GAIN: {
      uint8_t gain = arg < 1 ? 1 : arg > 64 ? 64 : arg;  // the contract is 1 to 64
      g_status.micGain = gain;
      usblink::logf("mic gain %u from the next take", (unsigned)gain);
      break;
    }
    case proto::CMD_STOP_AUDIO:
      audio::stopFromPc();
      usblink::logf("stop audio");
      break;
    case proto::CMD_SET_CODEC:
      audio::setUpCodec(arg);
      break;
    case proto::CMD_BOOT_APP0:
      bootApp0();
      break;
    case proto::CMD_REBOOT:
      usblink::logf("rebooting");
      delay(300);
      esp_restart();
      break;
    default:
      usblink::logf("command %u is not handled yet", op);
  }
}

// Runs on the link RX task.
void test(uint8_t op, const uint8_t* args, size_t len) {
  switch (op) {
    case proto::TEST_UP_PATTERN: {
      uint16_t frames = 0;
      if (proto::parseUpPattern(args, len, frames)) audio::requestPattern(frames);
      else usblink::logf("bad UP_PATTERN");
      break;
    }
    case proto::TEST_KEYS:
      post(K_KEYS, args, len);
      break;
    case proto::TEST_MIC_SOURCE: {
      bool on = false;
      if (proto::parseMicSource(args, len, on)) {
        audio::micSource(on);
        usblink::logf("mic source %s", on ? "test fifo" : "mic");
      } else {
        usblink::logf("bad MIC_SOURCE");
      }
      break;
    }
    case proto::TEST_MIC_PCM:
      if (len < 2 || len > 1000 || (len & 1)) {
        usblink::logf("bad MIC_PCM of %u bytes", (unsigned)len);
      } else if (audio::micPcm(args, len) < len) {
        usblink::logf("mic fifo full: part of a MIC_PCM was dropped");
      }
      break;
    case proto::TEST_SNAP:
      post(K_SNAP, args, len);
      break;
    case proto::TEST_SELFTEST: {
      // The mbedtls adapter against the RFC 5869 and NIST vectors, on this chip. It reads and writes no pairing key.
      uint8_t failed = proto::selfTest(mbedtlsCrypto());
      if (failed == 0) usblink::logf("selftest ok: hkdf gcm-seal gcm-open gcm-tamper session");
      else usblink::logf("selftest FAILED, mask 0x%02x (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)", (unsigned)failed);
      break;
    }
    default:
      usblink::logf("test %u is not handled", op);
  }
}

// Link RX task.
void onHello() {
  audio::onHello();
  scriptReset.store(true);
}

// UI loop.
void handle(const Msg& m, uint32_t now) {
  switch (m.kind) {
    case K_UI: {
      proto::UiView v;
      if (proto::parseUi(m.data, m.len, v)) machine.onUi(v, now);
      else usblink::logf("bad UI frame");
      break;
    }
    case K_APPROVAL: {
      proto::ApprovalReq r;
      if (proto::parseApprovalReq(m.data, m.len, r)) machine.onApprovalReq(r, now);
      else usblink::logf("bad APPROVAL_REQ frame");
      break;
    }
    case K_KEYS: {
      proto::KeyStep steps[proto::KEY_STEPS_MAX];
      size_t n = 0;
      if (proto::parseKeys(m.data, m.len, steps, proto::KEY_STEPS_MAX, n)) {
        keyScript.load(steps, n, now);
        usblink::logf("key script of %u steps", (unsigned)n);
      } else {
        usblink::logf("bad KEYS");
      }
      break;
    }
    case K_PAIR:
      if (m.len == 1) machine.onPairRequest(m.data[0], now);
      break;
    case K_SNAP:
      if (!screen::snapStart()) usblink::logf("snap: there is no canvas");
      break;
  }
}

// UI loop. Every action is logged, so a run of the keys can be read back from the LOG frames.
void carryOut(const ui::Action& a) {
  uint8_t p[16];
  size_t n;
  switch (a.act) {
    case ui::Act::PrepareTalk:
      usblink::logf("act prepare");
      audio::prepareTalk();
      break;
    case ui::Act::CommitTalk:
      usblink::logf("act commit reason=%u", a.arg);
      audio::commitTalk(a.arg != 0);
      break;
    case ui::Act::EndTalk:
      usblink::logf("act end");
      audio::endTalk();
      break;
    case ui::Act::StopAudio:
      usblink::logf("act stop audio");
      audio::requestStop();
      break;
    case ui::Act::SendButton:
      usblink::logf("act button %u", a.arg);
      n = proto::buildButton(a.arg, p, sizeof p);
      if (n) usblink::send(proto::T_BUTTON, 0, p, (uint16_t)n);
      break;
    case ui::Act::SendApproval:
      usblink::logf("act approval id=%u allow=%u reason=%u", a.id, a.arg, a.arg2);
      n = proto::buildApprovalRes(a.id, a.arg != 0, a.arg2 != 0, p, sizeof p);
      if (n) usblink::send(proto::T_APPROVAL_RES, 0, p, (uint16_t)n);
      break;
    case ui::Act::PairAnswer:
      usblink::logf("act pair answer %u", a.arg);
      usblink::pairAnswer(a.arg != 0);
      break;
    case ui::Act::BootApp0:
      usblink::logf("act boot app0");
      bootApp0();
      break;
  }
}

// One chunk of a snapshot per turn of the loop: 68 chunks in under a second. A chunk can still be lost on the way (gate H: about
// one snapshot in twenty, one frame in a thousand reaching the bridge damaged, at half the rate as often as at full speed, with the
// TX ring not full): the bridge asks again.
void sendSnapChunk() {
  static uint8_t buf[proto::MAX_PAYLOAD];
  size_t len = 0;
  if (screen::snapNext(buf, sizeof buf, len)) usblink::send(proto::T_TEST, 0, buf, (uint16_t)len);
}
}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.output_power = false;  // the StickS3 does not charge with the PM1 boost on
  M5.begin(cfg);
  esp_ota_mark_app_valid_cancel_rollback();
  M5.Display.setRotation(3);
  bool screenOk = screen::begin();
  bool audioOk = audio::begin();
  inbox = xQueueCreate(4, sizeof(Msg));
  usblink::Handlers h = {};
  h.onHello = onHello;
  h.onAudioDown = audio::onAudioDown;
  h.onCommand = command;
  h.onTest = test;
  h.onUi = onUiFrame;
  h.onApprovalReq = onApprovalFrame;
  h.onPairRequest = onPairRequest;
  h.idle = audio::rxIdle;
  h.ringBytes = audioOk ? audio::RING_BYTES : 0;
  netconf::begin();  // before the link: a NET frame may be the first thing it hears
  usblink::begin(h);
  netlink::begin();  // after the link: it reports through it, and hands it what the relay sends
  if (!audioOk) usblink::logf("no PSRAM for the playback ring: replies cannot play");
  if (!screenOk) usblink::logf("no memory for the screen canvas: nothing will be drawn");
}

void loop() {
  static uint32_t lastBattery = 0;
  static uint8_t battery = 0;
  static ui::Screen shown = ui::Screen::Offline;
  M5.update();
  uint32_t now = millis();

  static Msg m;
  while (inbox && xQueueReceive(inbox, &m, 0) == pdTRUE) handle(m, now);

  if (scriptReset.exchange(false)) keyScript.load(nullptr, 0, now);
  uint8_t scripted = keyScript.mask(now);
  bool front = M5.BtnA.isPressed() || (scripted & proto::KEY_FRONT);
  bool side = M5.BtnB.isPressed() || (scripted & proto::KEY_SIDE);
  machine.tick(now, usblink::online(), audio::replyBusy());
  ui::Events ev = gesture.update(now, front, side);
  for (uint8_t i = 0; i < ev.n; i++) machine.onGesture(ev.ev[i], now);
  ui::Action a;
  while (machine.next(a)) carryOut(a);

  ui::Screen s = machine.screen();
  if (s != shown) {
    shown = s;
    usblink::logf("screen %s", ui::screenName(s));
  }
  if (battery == 0 || now - lastBattery >= 5000) {
    lastBattery = now;
    int level = M5.Power.getBatteryLevel();
    battery = (uint8_t)(level < 0 ? 0 : level > 100 ? 100 : level);
  }
  static uint8_t reason = 0xff;
  proto::LinkView link = {usblink::online(), netlink::wanted(), netlink::wifiUp(), netlink::relayUp()};
  if (proto::offlineReason(link) != reason) {
    reason = proto::offlineReason(link);
    usblink::logf("link %s", ui::offlineName(reason));
  }
  static uint8_t carrier = proto::TR_USB;
  if (usblink::transport() != carrier) {  // a HELLO on the other transport, or the relay gone: gate M watches for these
    carrier = usblink::transport();
    usblink::logf("transport %s", carrier == proto::TR_USB ? "usb" : carrier == proto::TR_WSS ? "relay" : "none");
  }
  static uint32_t lastHealth = 0;
  if (now - lastHealth >= 300000) {  // every 5 min: what gate N reads an hour of standby from
    lastHealth = now;
    proto::Health h = {battery, ESP.getFreeHeap(), ESP.getMinFreeHeap(),
                       (uint32_t)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT), netlink::rssi(),
                       ui::offlineName(reason)};
    char line[128];
    if (proto::healthLine(h, line, sizeof line)) usblink::logf("%s", line);
  }
  screen::Extras x = {battery, g_status.micLevel.load(), g_status.playing.load(), ui::offlineHint(link)};
  screen::draw(machine.view(now), x);
  sendSnapChunk();
  delay(10);
}
