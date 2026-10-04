// netlink.cpp: see netlink.h. Only the device runs this file; what it decides is in proto/netstate.h and proto/ws.h, which the host
// tests run.
#include "netlink.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <atomic>
#include <esp_random.h>
#include <string.h>
#include "crypto_mbedtls.h"
#include "keystore_nvs.h"
#include "netconf_nvs.h"
#include "proto/netstate.h"
#include "proto/room.h"
#include "proto/ws.h"
#include "relay_roots.h"
#include "usblink.h"

namespace netlink {
namespace {
const uint32_t JOIN_MS = 10000;     // per network
const uint32_t ANSWER_MS = 10000;   // for the relay's 101
const int32_t CONNECT_MS = 10000;   // TCP and TLS
const uint32_t SILENT_MS = 70000;   // the relay pings every 30 s; nothing at all for this long means the path is gone
const uint32_t STACK = 12288;       // the TLS handshake runs on this task
std::atomic<bool> g_wanted{false}, g_wifi{false}, g_relay{false};
SemaphoreHandle_t sockLock = nullptr;  // the read side (this task) and the write side (usblink's TX task) take turns
WiFiClientSecure client;
proto::Backoff backoff;
uint8_t rx[2 * (4 + proto::WS_MAX_PAYLOAD)];  // this task only
size_t rxLen = 0;

void wifiOff() {
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  }
  g_wifi = false;
}

void hangUp() {
  xSemaphoreTake(sockLock, portMAX_DELAY);
  bool was = g_relay.exchange(false);
  client.stop();
  xSemaphoreGive(sockLock);
  rxLen = 0;
  if (was) usblink::relayDown();
}

bool joinAny(const netconf::Snapshot& s) {
  WiFi.mode(WIFI_STA);
  for (uint8_t i = 0; i < s.count; i++) {
    WiFi.begin(s.nets[i].ssid, s.nets[i].pass[0] ? s.nets[i].pass : nullptr);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < JOIN_MS) vTaskDelay(pdMS_TO_TICKS(100));
    if (WiFi.status() == WL_CONNECTED) {
      usblink::logf("wifi: joined %s", s.nets[i].ssid);  // never the password
      return true;
    }
    WiFi.disconnect();
  }
  return false;
}

// Writes one client frame; the caller holds sockLock.
bool writeFrame(uint8_t opcode, const uint8_t* payload, size_t n) {
  static uint8_t out[8 + proto::WS_MAX_PAYLOAD];  // under sockLock
  uint8_t mask[4];
  esp_fill_random(mask, sizeof mask);
  size_t m = proto::wsEncode(opcode, payload, n, mask, out, sizeof out);
  return m && client.write(out, m) == m;
}

// TLS to the relay, verified against the pinned roots, then the upgrade to /r/<room>?role=device.
bool dial(const char* host) {
  uint8_t master[proto::KEY_BYTES], id[proto::ROOM_BYTES];
  char roomHex[proto::ROOM_HEX_BYTES];
  bool haveKey = nvsKeyStore().load(master) && proto::roomId(mbedtlsCrypto(), master, id);
  memset(master, 0, sizeof master);
  if (!haveKey) return false;
  proto::roomIdHex(id, roomHex);
  char path[64];
  snprintf(path, sizeof path, "/r/%s?role=device", roomHex);
  uint8_t key[proto::WS_KEY_BYTES];
  esp_fill_random(key, sizeof key);
  char request[256];
  size_t n = proto::wsRequest(host, path, key, request, sizeof request);
  if (!n) return false;

  xSemaphoreTake(sockLock, portMAX_DELAY);
  client.setCACert(RELAY_ROOTS_PEM);
  bool ok = client.connect(host, 443, CONNECT_MS) && client.write((const uint8_t*)request, n) == n;
  char why[64] = "";
  int err = ok ? 0 : client.lastError(why, sizeof why);  // mbedtls's own: a certificate, no memory, a timeout and a portal differ here
  xSemaphoreGive(sockLock);
  if (!ok) {
    usblink::logf("relay: no TLS connection to %s (%d %s)", host, err, why);
    hangUp();
    return false;
  }
  rxLen = 0;
  uint32_t start = millis();
  for (;;) {
    xSemaphoreTake(sockLock, portMAX_DELAY);
    int got = client.available() > 0 ? client.read(rx + rxLen, sizeof rx - rxLen) : 0;
    bool open = client.connected();
    xSemaphoreGive(sockLock);
    if (got > 0) rxLen += (size_t)got;
    size_t headerLen = 0;
    int status = 0;
    int r = proto::wsResponse(rx, rxLen, headerLen, status);
    if (r == proto::WS_HTTP_OK) {
      memmove(rx, rx + headerLen, rxLen - headerLen);  // frames that came in the same read
      rxLen -= headerLen;
      return true;
    }
    if (r == proto::WS_HTTP_BAD || !open || millis() - start > ANSWER_MS || rxLen == sizeof rx) {
      usblink::logf("relay: refused the upgrade (HTTP %d)", status);
      hangUp();
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// Takes frames until the connection ends, Wi-Fi goes, or the settings change.
void pump(uint32_t generation) {
  uint32_t heard = millis();
  for (;;) {
    xSemaphoreTake(sockLock, portMAX_DELAY);
    int got = client.available() > 0 ? client.read(rx + rxLen, sizeof rx - rxLen) : 0;
    bool open = client.connected();
    xSemaphoreGive(sockLock);
    if (got > 0) {
      rxLen += (size_t)got;
      heard = millis();
    }
    for (;;) {
      proto::WsFrame f;
      int k = proto::wsDecode(rx, rxLen, f);
      if (k == 0) break;
      if (k < 0) {
        usblink::logf("relay: a frame walkie does not take; closing");
        return;
      }
      if (f.opcode == proto::WS_BINARY) {
        usblink::fromRelay(f.payload, f.n);
      } else if (f.opcode == proto::WS_PING) {
        xSemaphoreTake(sockLock, portMAX_DELAY);
        writeFrame(proto::WS_PONG, f.payload, f.n);
        xSemaphoreGive(sockLock);
      } else if (f.opcode == proto::WS_CLOSE) {
        usblink::logf("relay: closed (%u)", (unsigned)proto::wsCloseCode(f));  // 4000: another walkie with this key took the room
        return;
      }
      memmove(rx, rx + k, rxLen - (size_t)k);
      rxLen -= (size_t)k;
    }
    if (millis() - heard > SILENT_MS) {
      usblink::logf("relay: nothing for %u s; closing", (unsigned)(SILENT_MS / 1000));
      return;
    }
    if (!open || WiFi.status() != WL_CONNECTED || netconf::generation() != generation) return;
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void task(void*) {
  static netconf::Snapshot s;
  uint32_t joinedFor = 0;  // the settings generation the current Wi-Fi was joined under
  for (;;) {
    netconf::snapshot(s);
    if (WiFi.status() == WL_CONNECTED && s.generation != joinedFor) wifiOff();  // a network removed or added: choose again
    uint8_t key[proto::KEY_BYTES];
    bool paired = nvsKeyStore().load(key);
    memset(key, 0, sizeof key);
    bool want = paired && s.count > 0 && s.host[0];
    g_wanted = want;
    if (!want) {
      wifiOff();
      backoff.reset();
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      g_wifi = false;
      if (!joinAny(s)) {
        vTaskDelay(pdMS_TO_TICKS(backoff.next()));
        continue;
      }
      joinedFor = s.generation;
    }
    g_wifi = true;
    if (!dial(s.host)) {
      vTaskDelay(pdMS_TO_TICKS(backoff.next()));
      continue;
    }
    backoff.reset();
    g_relay = true;
    usblink::logf("relay: connected to %s", s.host);
    usblink::relayConnected();  // HELLO on the relay, so that a PC already waiting there starts a session
    pump(s.generation);
    hangUp();
  }
}
}  // namespace

void begin() {
  sockLock = xSemaphoreCreateMutex();
  WiFi.persistent(false);  // the networks are netconf's, never the Wi-Fi library's own flash
  WiFi.mode(WIFI_OFF);
  xTaskCreatePinnedToCore(task, "netlink", STACK, nullptr, 2, nullptr, 0);
}

bool sendEnvelope(const uint8_t* env, size_t n) {
  if (!sockLock || !g_relay) return false;
  xSemaphoreTake(sockLock, portMAX_DELAY);
  bool ok = g_relay && writeFrame(proto::WS_BINARY, env, n);
  xSemaphoreGive(sockLock);
  return ok;
}

bool wanted() { return g_wanted; }
bool wifiUp() { return g_wifi; }
bool relayUp() { return g_relay; }
int rssi() { return g_wifi ? WiFi.RSSI() : 0; }
}  // namespace netlink
