// screen.cpp: see screen.h.
#include "screen.h"
#include <M5Unified.h>
#include <stdio.h>
#include <string.h>
#include "proto/messages.h"
#include "ui/text.h"

namespace screen {
namespace {
const int W = 240, H = 135;
const int HEADER_H = 16, BODY_Y = 19, ROW = 16, FOOTER_Y = 119;
const int SNAP_ROWS = 2;  // rows to a chunk: 960 bytes of pixels

const uint16_t BLACK = 0x0000, WHITE = 0xFFFF, GREY = 0x8410;
const uint16_t NAVY = 0x0010, GREEN = 0x03A0, AMBER = 0xFBE0, RED = 0xC000, MAGENTA = 0x8010;

M5Canvas canvas(&M5.Display);
bool ready = false;
bool haveSig = false;
uint32_t lastSig = 0;
bool frozen = false;  // a snapshot is being sent: the canvas must not change under it
int snapIndex = 0;

uint32_t mix(uint32_t h, const void* p, size_t n) {
  const uint8_t* b = (const uint8_t*)p;
  for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 16777619u;
  return h;
}
uint32_t mix(uint32_t h, uint32_t v) { return mix(h, &v, sizeof v); }

// Everything that is drawn goes into the hash, so a frame that would look the same is not drawn again.
uint32_t signature(const ui::View& v, const Extras& x) {
  uint32_t h = 2166136261u;
  h = mix(h, (uint32_t)v.screen);
  h = mix(h, v.project, strlen(v.project));
  h = mix(h, v.tool, strlen(v.tool));
  h = mix(h, (uint32_t)v.nLines);
  for (uint8_t i = 0; i < v.nLines; i++) h = mix(h, v.text + v.lines[i].start, v.lines[i].len);
  h = mix(h, (uint32_t)(v.more | v.switching << 1 | x.playing << 2 | v.hasElapsed << 3));
  h = mix(h, (uint32_t)v.page << 8 | v.pages);
  h = mix(h, v.hasElapsed ? v.elapsedMs / 1000 : 0);
  h = mix(h, v.screen == ui::Screen::PairConfirm ? (uint32_t)v.pairOp << 16 | (v.pairLeftMs + 999) / 1000 : 0);
  h = mix(h, (uint32_t)x.battery);
  if (v.screen == ui::Screen::Offline) h = mix(h, x.offline, strlen(x.offline));
  h = mix(h, v.screen == ui::Screen::Listening ? (uint32_t)(x.micLevel / 6) : 0);
  return h;
}

void put(int x, int y, const char* s, size_t n, uint16_t color) {
  char buf[160];
  if (n > sizeof buf - 1) n = sizeof buf - 1;
  memcpy(buf, s, n);
  buf[n] = 0;
  canvas.setTextColor(color);
  canvas.drawString(buf, x, y);
}
void put(int x, int y, const char* s, uint16_t color) { put(x, y, s, strlen(s), color); }

void centered(int y, const char* s, uint16_t color, int size) {
  canvas.setTextSize(size);
  canvas.setTextColor(color);
  canvas.setTextDatum(top_center);
  canvas.drawString(s, W / 2, y);
  canvas.setTextDatum(top_left);
  canvas.setTextSize(1);
}

// A header bar with the title clipped so that the right-hand part always fits.
void header(uint16_t bar, const char* left, const char* right) {
  canvas.fillRect(0, 0, W, HEADER_H, bar);
  char shown[96];
  size_t rightCells = ui::cells(right, strlen(right));
  size_t room = ui::COLS > rightCells + 1 ? ui::COLS - rightCells - 1 : 0;
  size_t n = ui::clip(left, strlen(left), (uint8_t)room, shown, sizeof shown);
  put(2, 0, shown, n, WHITE);
  canvas.setTextDatum(top_right);
  canvas.setTextColor(WHITE);
  canvas.drawString(right, W - 2, 0);
  canvas.setTextDatum(top_left);
}

void footer(const char* hint) { put(0, FOOTER_Y, hint, GREY); }

void body(const ui::View& v, uint16_t color) {
  for (uint8_t i = 0; i < v.nLines; i++) put(0, BODY_Y + i * ROW, v.text + v.lines[i].start, v.lines[i].len, color);
}

void elapsedText(uint32_t ms, char* out, size_t cap) {
  uint32_t s = ms / 1000;
  if (s < 60) snprintf(out, cap, "%us", (unsigned)s);
  else snprintf(out, cap, "%um%02us", (unsigned)(s / 60), (unsigned)(s % 60));
}

void render(const ui::View& v, const Extras& x) {
  canvas.fillScreen(BLACK);
  char right[24];
  snprintf(right, sizeof right, "%u%%", (unsigned)x.battery);
  const char* project = v.project[0] ? v.project : "walkie";
  switch (v.screen) {
    case ui::Screen::Offline:
      header(RED, "walkie", right);
      centered(34, "未连接", WHITE, 2);
      centered(82, x.offline, GREY, 1);
      footer("两键同按 3 秒：切换固件");
      break;
    case ui::Screen::Idle:
      header(NAVY, project, right);
      centered(40, "待命", WHITE, 2);
      footer("按住前键说话");
      break;
    case ui::Screen::Listening: {
      header(GREEN, "聆听中", right);
      int w = x.micLevel >= 110 ? W - 20 : x.micLevel * (W - 20) / 110;  // 110 of 255 is about 43% of full scale
      canvas.drawRect(9, 50, W - 18, 32, GREY);
      if (w > 0) canvas.fillRect(10, 51, w, 30, WHITE);
      footer("松开发送");
      break;
    }
    case ui::Screen::Transcribing:
      header(NAVY, project, right);
      centered(40, "识别中…", WHITE, 2);
      break;
    case ui::Screen::Confirm:
      header(AMBER, "确认", right);
      body(v, WHITE);
      footer("侧键取消");
      break;
    case ui::Screen::Working: {
      char el[16] = "";
      if (v.hasElapsed) elapsedText(v.elapsedMs, el, sizeof el);
      header(NAVY, project, el);
      body(v, WHITE);
      footer("按住侧键 1 秒：停止");
      break;
    }
    case ui::Screen::Reply: {
      char pg[16];
      snprintf(pg, sizeof pg, "%u/%u", (unsigned)v.page + 1, (unsigned)v.pages);
      header(NAVY, project, v.pages > 1 ? pg : right);
      body(v, WHITE);
      footer(x.playing ? "侧键停止播放" : (v.page + 1 < v.pages ? "侧键翻页" : "侧键完成"));
      break;
    }
    case ui::Screen::Error:
      header(RED, "出错了", right);
      body(v, WHITE);
      footer("侧键关闭");
      break;
    case ui::Screen::Approval: {
      char title[96];
      snprintf(title, sizeof title, "允许 %s ？", v.tool);
      header(AMBER, title, "");
      body(v, WHITE);
      if (v.more) put(0, BODY_Y + ui::APPROVAL_LINES * ROW, "…", GREY);
      footer("前键允许 侧键拒绝 按住说原因");
      break;
    }
    case ui::Screen::PairConfirm: {
      char line[48];
      header(MAGENTA, v.pairOp == proto::PAIR_FORGET ? "解除配对" : "配对", right);
      put(0, BODY_Y, v.pairOp == proto::PAIR_FORGET ? "电脑要忘记这个密钥" : "电脑要设置一个新密钥", WHITE);
      snprintf(line, sizeof line, "%u 秒后算拒绝", (unsigned)((v.pairLeftMs + 999) / 1000));
      put(0, BODY_Y + ROW, line, GREY);
      footer("前键同意 侧键拒绝");
      break;
    }
    case ui::Screen::SwitchConfirm:
      header(MAGENTA, "切换固件", right);
      if (v.switching) {
        centered(40, "切换中…", WHITE, 2);
      } else {
        put(0, BODY_Y, "按前键：重启到 app0", WHITE);
        put(0, BODY_Y + ROW, "按侧键或等 10 秒：取消", GREY);
      }
      break;
  }
}
}  // namespace

bool begin() {
  canvas.setPsram(true);
  canvas.setColorDepth(16);
  canvas.setFont(&fonts::efontCN_16);
  ready = canvas.createSprite(W, H) != nullptr;
  return ready;
}

void draw(const ui::View& v, const Extras& x) {
  if (!ready || frozen) return;
  uint32_t sig = signature(v, x);
  if (haveSig && sig == lastSig) return;
  haveSig = true;
  lastSig = sig;
  render(v, x);
  M5.Display.startWrite();
  canvas.pushSprite(0, 0);
  M5.Display.endWrite();
}

bool snapStart() {
  if (!ready) return false;
  frozen = true;
  snapIndex = 0;
  return true;
}

bool snapNext(uint8_t* out, size_t cap, size_t& len) {
  const int count = (H + SNAP_ROWS - 1) / SNAP_ROWS;
  len = 0;
  if (!frozen) return false;
  if (snapIndex >= count) {
    frozen = false;
    haveSig = false;  // the next draw repaints, whatever it was
    return false;
  }
  int y = snapIndex * SNAP_ROWS;
  int rows = H - y < SNAP_ROWS ? H - y : SNAP_ROWS;
  static uint8_t rgb[W * SNAP_ROWS * 3];
  static uint8_t px[W * SNAP_ROWS * 2];
  // M5GFX calls the 24-bit type bgr888_t but lays it out r, g, b; gate H showed red and blue swapped when it was read as b, g, r
  canvas.readRectRGB(0, y, W, rows, rgb);
  for (int i = 0; i < W * rows; i++) {
    uint16_t c = (uint16_t)(((rgb[i * 3] & 0xF8) << 8) | ((rgb[i * 3 + 1] & 0xFC) << 3) | (rgb[i * 3 + 2] >> 3));
    px[i * 2] = (uint8_t)(c & 0xFF);
    px[i * 2 + 1] = (uint8_t)(c >> 8);
  }
  len = proto::buildSnapChunk((uint16_t)snapIndex, (uint16_t)count, W, H, px, (size_t)W * rows * 2, out, cap);
  snapIndex++;
  return len > 0;
}

}  // namespace screen
