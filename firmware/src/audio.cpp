// audio.cpp: the audio task. Mic and speaker share the ES8311 codec, so one task runs them in turn:
// talk-key takes and TEST patterns go up as AUDIO_UP, and replies play from a PSRAM ring that the
// link RX task fills from AUDIO_DOWN under credit (protocol/frames.md).
#include "audio.h"
#include <Arduino.h>
#include <M5Unified.h>
#include <atomic>
#include "proto/adpcm.h"
#include "proto/audiocodec.h"
#include "proto/crc.h"
#include "proto/credit.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "proto/pattern.h"
#include "proto/ring.h"
#include "status.h"
#include "usblink.h"

namespace audio {
namespace {
// Uplink: 20 ms requests, two queued with M5.Mic at any time.
const uint32_t UP_RATE = 16000;
const size_t UP_SAMPLES = 320;
const int UP_BUFS = 4;
int16_t upBuf[UP_BUFS][UP_SAMPLES];
const int PRE_CHUNKS = 20;  // 400 ms of pre-roll
int16_t pre[PRE_CHUNKS][UP_SAMPLES];
int preHead = 0, preCount = 0;  // audio task only
std::atomic<uint16_t> patternFrames{0};

// The UI loop's side of a take. A key press is prepareTalk(), commitTalk(), endTalk() in that order. The committed flag
// is kept until the audio task has dealt with the take, so a hold that the UI loop saw only at its release (commit and end
// together) still gives a take, and the audio task reads talkOn before talkCommitted: if it sees the end, the commit before
// it is visible too.
std::atomic<bool> talkOn{false};
std::atomic<bool> talkCommitted{false};
std::atomic<bool> talkReason{false};

// TEST MIC_SOURCE and MIC_PCM: 16 s of 16 kHz PCM16, written by the RX task and read, paced at the mic's speed, by the
// audio task, which also clears it.
const uint32_t INJECT_BYTES = 1u << 19;
proto::ByteRing injectRing;
std::atomic<bool> injectOn{false};
std::atomic<bool> injectClear{false};
bool takeInject = false;  // audio task: this take reads the FIFO
TickType_t injectLast = 0;

// Downlink: the RX task writes the ring; this task reads it into 100 ms speaker requests.
const uint32_t DOWN_RATE = 24000;
const uint32_t START_BYTES = 14400;  // 300 ms buffered before playing, unless the reply has ended
const size_t CHUNK_SAMPLES = 2400;   // 100 ms per playRaw request
// isPlaying() == 0 means the speaker task has read the last request, not that it was heard: the I2S DMA still holds
// 8 buffers of 256 frames (about 93 ms at 22,050 Hz). The speaker stays on that long, plus a margin, after a reply ends.
const uint32_t DMA_TAIL_MS = 120;
const int CHUNKS = 4;                // M5.Speaker queues two, so a chunk is never refilled while queued
const uint8_t SPK_CH = 0;
int16_t chunk[CHUNKS][CHUNK_SAMPLES];
proto::ByteRing ring;
proto::CreditLedger ledger(12288, 1920);  // window below the 16,384-byte USB receive queue
proto::DownDecoder downDecoder;  // RX task
proto::UpEncoder upEncoder;      // the audio task encodes; the RX task sets the codec at CMD SET_CODEC and HELLO

enum : uint8_t { FLUSH_NONE, FLUSH_STOP, FLUSH_RESET };
// RX task only
bool streamOpen = false;  // AUDIO_DOWN frames arrived since the last EOS
bool discarding = false;  // drop AUDIO_DOWN until the stopped reply's EOS
// Shared
std::atomic<bool> eosReceived{false};    // set by the RX task, cleared by the audio task
std::atomic<uint8_t> flush{FLUSH_NONE};  // set by the RX task, cleared by the audio task
std::atomic<bool> flushOpen{false};      // with a flush: frames of the reply were still arriving
std::atomic<bool> stopWanted{false};     // the audio task asks the RX task to stop the reply
// Audio task only
bool active = false, buffering = true, starving = false, speakerOn = false;
int nextChunk = 0;
proto::Played stats = {};

void sendUp(const int16_t* pcm, size_t samples, bool eos, bool reason = false) {
  uint8_t enc[proto::ADPCM_HEADER + UP_SAMPLES / 2 + 1];
  const uint8_t* payload = nullptr;
  size_t len = 0;
  uint8_t codecBits = 0;
  if (!upEncoder.encode(pcm, samples, eos, enc, sizeof enc, payload, len, codecBits)) {
    usblink::logf("uplink frame did not encode: dropped");
    return;
  }
  uint8_t flags = (uint8_t)(codecBits | (eos ? (proto::F_EOS | (reason ? proto::F_REASON : 0)) : 0));
  usblink::send(proto::T_AUDIO_UP, flags, payload, (uint16_t)len);
}

// Takes the counters by value: the caller resets its state before this goes out (see finishReply).
void sendPlayed(proto::Played done, uint8_t reason) {
  done.reason = reason;
  uint8_t p[17];
  size_t n = proto::buildPlayed(done, p, sizeof p);
  usblink::send(proto::T_PLAYED, 0, p, (uint16_t)n);
}

void speakerOff() {
  if (!speakerOn) return;
  M5.Speaker.stop();
  M5.Speaker.end();
  speakerOn = false;
}

void speakerOnNow() {
  if (speakerOn) return;
  M5.Mic.end();
  speakerOn = M5.Speaker.begin();
  if (!speakerOn) {
    usblink::logf("speaker did not start; stopping the reply");
    stopWanted.store(true);
    return;
  }
  M5.Speaker.setVolume(g_status.volume.load());
}

void endReply() {
  active = false;
  buffering = true;
  starving = false;
  stats = proto::Played();
  g_status.playing = false;
  g_status.ringFill = 0;
}

// The reply played to its end. PLAYED is the PC's cue to start the next reply, so everything the RX task can see (the
// ring and the EOS flag) is reset before it goes out, or a short next reply could be wiped as it arrives. The speaker
// stays on for the DMA tail first, or the last 90 ms would be cut off.
void finishReply() {
  if (speakerOn) vTaskDelay(pdMS_TO_TICKS(DMA_TAIL_MS));
  speakerOff();
  proto::Played done = stats;
  eosReceived.store(false);
  endReply();
  sendPlayed(done, proto::PLAYED_FINISHED);
}

// RX task: stop the reply. The audio task empties the ring and reports it. Calling it twice for one reply is safe, and
// a pending RESET (a HELLO) is never downgraded to a STOP, which would send a PLAYED after the HELLO.
void stopStream(uint8_t how) {
  uint8_t pending = flush.load();
  if (pending == FLUSH_RESET) how = FLUSH_RESET;
  bool open = streamOpen || (pending != FLUSH_NONE && flushOpen.load());
  flushOpen.store(open);
  discarding = discarding || (how == FLUSH_STOP && open);
  streamOpen = false;
  flush.store(how);
}

void handleFlush() {
  uint8_t how = flush.load();
  if (how == FLUSH_NONE) return;
  bool started = active || ring.size() > 0 || eosReceived.load() || flushOpen.load();
  speakerOff();
  ring.clear();
  eosReceived.store(false);
  if (how == FLUSH_STOP && started) sendPlayed(stats, proto::PLAYED_STOPPED);
  endReply();
  // A flush the RX task stored while this ran is still pending, and is handled on the next pass.
  flush.compare_exchange_strong(how, FLUSH_NONE);
}

// The RX task writes the ring first and sets the EOS flag after, so this task reads the flag first: with EOS seen, every
// byte of the reply is already in the ring.
void playStep() {
  bool eos = eosReceived.load();
  uint32_t avail = ring.size();
  if (!active) {
    if (avail == 0 && !eos) return;
    active = true;
    buffering = true;
  }
  if (avail > stats.maxFill) stats.maxFill = avail;
  g_status.ringFill = avail;
  if (buffering) {
    if (avail < START_BYTES && !eos) return;
    buffering = false;
    if (avail > 0) speakerOnNow();
    g_status.playing = true;
  }
  while (speakerOn && M5.Speaker.isPlaying(SPK_CH) < 2) {
    bool eosNow = eosReceived.load();
    uint32_t n = ring.size();
    if (n == 0 || (n < CHUNK_SAMPLES * 2 && !eosNow)) break;
    if (n > CHUNK_SAMPLES * 2) n = CHUNK_SAMPLES * 2;
    uint8_t* dst = (uint8_t*)chunk[nextChunk];
    ring.read(dst, n);
    if (!M5.Speaker.playRaw(chunk[nextChunk], n / 2, DOWN_RATE, false, 1, SPK_CH, false)) {
      usblink::logf("speaker refused audio; stopping the reply");
      stopWanted.store(true);
      break;
    }
    stats.bytes += n;
    stats.crc32 = proto::crc32Update(stats.crc32, dst, n);
    nextChunk = (nextChunk + 1) % CHUNKS;
    starving = false;
  }
  // Only this task queues speaker requests, so an idle speaker stays idle while the flag and the ring are read.
  bool idle = !speakerOn || M5.Speaker.isPlaying(SPK_CH) == 0;
  bool eosNow = eosReceived.load();
  uint32_t left = ring.size();
  if (idle && eosNow && left == 0) {  // played to the end
    finishReply();
  } else if (idle && !eosNow && left < CHUNK_SAMPLES * 2 && !starving) {  // ran dry before the end: buffer 300 ms again
    starving = true;
    buffering = true;
    stats.underruns++;
    g_status.underruns++;
  }
}

// The audio task's own view of whether a reply is arriving or playing.
bool speakerBusy() { return active || speakerOn || ring.size() > 0; }

// A take wants the mic when it has been committed, or when it has been prepared and no reply is using the codec.
bool talkWanted() { return talkCommitted.load() || (talkOn.load() && !speakerBusy()); }

// The mic, or the TEST FIFO standing in for it. record() queues buf and returns once the buffer queued before it is full;
// the FIFO fills buf at once, 20 ms after the last one, with zeros for what has not arrived.
bool micBegin() {
  takeInject = injectOn.load();
  if (takeInject) {
    injectLast = xTaskGetTickCount();
    return true;
  }
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  return M5.Mic.begin();
}
bool micRecord(int16_t* buf) {
  if (!takeInject) return M5.Mic.record(buf, UP_SAMPLES, UP_RATE);
  vTaskDelayUntil(&injectLast, pdMS_TO_TICKS(20));
  uint32_t got = injectRing.read((uint8_t*)buf, UP_SAMPLES * 2);
  memset((uint8_t*)buf + got, 0, UP_SAMPLES * 2 - got);
  return true;
}
bool micRecording() { return !takeInject && M5.Mic.isRecording(); }
void micEnd() {
  if (!takeInject) M5.Mic.end();
}

void handleInjectClear() {
  if (injectClear.exchange(false)) injectRing.clear();
}

void setLevel(const int16_t* pcm, size_t samples) {
  int peak = 0;
  for (size_t i = 0; i < samples; i++) {
    int a = pcm[i] < 0 ? -(int)pcm[i] : pcm[i];
    if (a > peak) peak = a;
  }
  int level = peak >> 7;
  g_status.micLevel = (uint8_t)(level > 255 ? 255 : level);
}

void keepPre(const int16_t* pcm) {
  memcpy(pre[preHead], pcm, sizeof pre[0]);
  preHead = (preHead + 1) % PRE_CHUNKS;
  if (preCount < PRE_CHUNKS) preCount++;
}

void sendPre() {
  int at = (preHead + PRE_CHUNKS - preCount) % PRE_CHUNKS;
  for (int i = 0; i < preCount; i++) sendUp(pre[(at + i) % PRE_CHUNKS], UP_SAMPLES, false);
  preCount = 0;
}

// The mic failed: end the take for the PC with an empty EOS (once the take has been committed; before that, nobody is
// waiting for it), then wait for the key, so talk() is not re-entered in a tight loop that would starve the UI loop.
void abandonTake(const char* why) {
  usblink::logf("%s", why);
  micEnd();
  g_status.micLevel = 0;
  for (;;) {
    bool on = talkOn.load();
    if (talkCommitted.load()) {
      sendUp(upBuf[0], 0, true, talkReason.load());
      break;
    }
    if (!on) break;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  while (talkOn.load()) vTaskDelay(pdMS_TO_TICKS(20));
  talkCommitted.store(false);
}

// A take, from the key going down to its release. Until the take is committed the chunks only fill the pre-roll; a reply
// that is playing stops when the take is committed, not before.
void talk() {
  if (speakerBusy()) {
    if (!talkCommitted.load()) return;  // prepared only: the reply plays on
    stopWanted.store(true);
    uint32_t t0 = millis();
    while (flush.load() == FLUSH_NONE && millis() - t0 < 50) vTaskDelay(1);  // the RX task turns it into a stop
    handleFlush();
  }
  speakerOff();
  if (!micBegin()) {
    abandonTake("mic did not start");
    return;
  }
  preHead = preCount = 0;
  uint32_t t0 = millis();
  bool live = false;
  bool ok = micRecord(upBuf[0]) && micRecord(upBuf[1]);
  int oldest = 0;
  while (ok) {
    bool on = talkOn.load();
    bool committed = talkCommitted.load();
    if (committed && !live) {
      live = true;
      sendPre();
    }
    if (!on) break;
    ok = micRecord(upBuf[(oldest + 2) % UP_BUFS]);  // returns once upBuf[oldest] is full
    if (!ok) break;
    setLevel(upBuf[oldest], UP_SAMPLES);
    if (live) sendUp(upBuf[oldest], UP_SAMPLES, false);
    else keepPre(upBuf[oldest]);
    oldest = (oldest + 1) % UP_BUFS;
  }
  if (!ok) {
    abandonTake("mic stopped recording");
    return;
  }
  if (live) {
    uint32_t w0 = millis();
    while (micRecording() && millis() - w0 < 200) vTaskDelay(1);
    sendUp(upBuf[oldest], UP_SAMPLES, false);
    sendUp(upBuf[(oldest + 1) % UP_BUFS], UP_SAMPLES, true, talkReason.load());
    g_status.takes++;
    g_status.lastTakeMs = millis() - t0;
  }
  micEnd();
  g_status.micLevel = 0;
  talkCommitted.store(false);
}

void pattern(uint16_t frames) {
  static int16_t buf[UP_SAMPLES];
  uint32_t k = 0;
  TickType_t last = xTaskGetTickCount();
  for (uint16_t f = 0; f < frames; f++) {
    for (size_t i = 0; i < UP_SAMPLES; i++) buf[i] = (int16_t)proto::patternSample(k++);
    sendUp(buf, UP_SAMPLES, f + 1 == frames);
    vTaskDelayUntil(&last, pdMS_TO_TICKS(20));
  }
}

void task(void*) {
  for (;;) {
    handleFlush();
    handleInjectClear();
    if (talkWanted()) {
      talk();
      if (!talkCommitted.load() && speakerBusy()) vTaskDelay(pdMS_TO_TICKS(5));  // prepared with a reply playing: no spin
      else continue;
    }
    uint16_t n = patternFrames.exchange(0);
    if (n) {
      pattern(n);
      continue;
    }
    playStep();
    if (speakerOn) M5.Speaker.setVolume(g_status.volume.load());
    vTaskDelay(pdMS_TO_TICKS(active ? 2 : 5));
  }
}
}  // namespace

bool begin() {
  M5.Speaker.end();
  auto sc = M5.Speaker.config();
  sc.magnification = 2;  // with volume 255, the loudest of the variants he compared (spec D9)
  M5.Speaker.config(sc);
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  uint8_t* mem = (uint8_t*)heap_caps_malloc(RING_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (mem) ring.attach(mem, RING_BYTES);
  uint8_t* fifo = (uint8_t*)heap_caps_malloc(INJECT_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (fifo) injectRing.attach(fifo, INJECT_BYTES);
  xTaskCreatePinnedToCore(task, "audio", 8192, nullptr, 3, nullptr, 1);
  return mem != nullptr;
}

void prepareTalk() {
  talkCommitted.store(false);
  talkReason.store(false);
  talkOn.store(true);
}

void commitTalk(bool reason) {
  talkReason.store(reason);
  talkCommitted.store(true);
}

void endTalk() { talkOn.store(false); }

bool replyBusy() { return g_status.playing.load() || ring.size() > 0; }

void requestStop() { stopWanted.store(true); }

void micSource(bool on) {
  injectOn.store(on);
  if (!on) injectClear.store(true);
}

size_t micPcm(const uint8_t* pcm, size_t len) {
  if (!injectRing.capacity()) return 0;
  return injectRing.write(pcm, (uint32_t)(len & ~(size_t)1));
}

void requestPattern(uint16_t frames) {
  if (frames) patternFrames.store(frames);
}

void onHello() {
  upEncoder.reset();  // every link starts in PCM16: the bridge asks again if it wants ADPCM
  ledger.reset();
  stopStream(FLUSH_RESET);
  discarding = false;
  micSource(false);  // a recording the old bridge pushed is of no use to a new one
}

void setUpCodec(uint8_t codec) {
  if (upEncoder.setCodec(codec)) usblink::logf("uplink codec %u", (unsigned)codec);
  else usblink::logf("bad codec %u", (unsigned)codec);
}

// Credit counts decoded PCM bytes whatever the codec, so a frame that does not decode counts for nothing (and still ends a reply if it
// carries EOS): the bridge's credit for it is only given back at the next HELLO, like that of a frame lost on the wire.
void onAudioDown(const uint8_t* payload, size_t len, uint8_t flags) {
  bool eos = (flags & proto::F_EOS) != 0;
  const uint8_t* pcm = nullptr;
  size_t n = 0;
  if (!downDecoder.decode(flags, payload, len, pcm, n)) {
    usblink::logf("bad AUDIO_DOWN frame (codec %u, %u bytes): dropped", (unsigned)proto::codecOf(flags), (unsigned)len);
  }
  ledger.received(proto::codecOf(flags) == proto::CODEC_PCM16 ? (uint32_t)len : (uint32_t)n);
  if (discarding) {
    if (eos) discarding = false;
    return;
  }
  streamOpen = !eos;
  if (n) ring.write(pcm, (uint32_t)n);
  if (eos) eosReceived.store(true);
}

void stopFromPc() { stopStream(FLUSH_STOP); }

void rxIdle() {
  if (stopWanted.exchange(false)) stopStream(FLUSH_STOP);
  if (flush.load() != FLUSH_NONE) return;  // no credit until the audio task has emptied the ring
  uint32_t g = ledger.grantable(ring.space());
  if (!g) return;
  uint8_t p[4];
  size_t n = proto::buildCredit(g, p, sizeof p);
  if (usblink::send(proto::T_CREDIT, 0, p, (uint16_t)n)) ledger.granted(g);
}
}  // namespace audio
