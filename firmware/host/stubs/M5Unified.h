// Host stub of M5.Speaker and M5.Mic with the queue semantics of M5Unified 0.2.23: isPlaying(ch) counts the occupied
// request slots (playing plus queued, at most 2). The knobs let a test make begin() or playRaw() or record() fail.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <vector>
#include <Arduino.h>

struct SpkCfg {
  uint8_t magnification = 1;
};
struct MicCfg {
  uint8_t magnification = 16;
};

struct FakeSpeaker {
  SpkCfg cfg;
  bool begun = false, beginOk = true, playOk = true;
  int queued = 0;
  std::vector<size_t> played;   // samples per accepted request
  std::function<void()> onEnd;  // runs inside end()
  int ends = 0;
  mutable std::function<void()> onIsPlaying;  // runs once, inside the next isPlaying()
  SpkCfg config() const { return cfg; }
  void config(const SpkCfg& c) { cfg = c; }
  bool begin() {
    begun = beginOk;
    return beginOk;
  }
  void end() {
    ends++;
    if (onEnd) onEnd();
    begun = false;
    queued = 0;
  }
  void stop() { queued = 0; }
  size_t isPlaying(uint8_t) const {
    if (onIsPlaying) {
      auto f = onIsPlaying;
      onIsPlaying = nullptr;
      f();
    }
    return (size_t)queued;
  }
  bool playRaw(const int16_t*, size_t n, uint32_t, bool, uint32_t, int, bool) {
    if (!playOk) return false;
    queued++;
    played.push_back(n);
    return true;
  }
  void setVolume(uint8_t) {}
  void finishOne() {  // the speaker task has read one request
    if (queued) queued--;
  }
};

struct FakeMic {
  MicCfg cfg;
  bool beginOk = true, recordOk = true;
  int begins = 0, ends = 0, records = 0;
  int16_t fixed = 0;  // when not 0, every sample of a chunk is this; otherwise the number of the chunk, counting from 1
  MicCfg config() const { return cfg; }
  void config(const MicCfg& c) { cfg = c; }
  bool begin() {
    begins++;
    return beginOk;
  }
  void end() { ends++; }
  bool record(int16_t* buf, size_t n, uint32_t) {
    records++;
    if (recordOk)
      for (size_t i = 0; i < n; i++) buf[i] = fixed ? fixed : (int16_t)records;
    if (g_onDelay) g_onDelay();  // a real record() blocks: the key can be released meanwhile
    return recordOk;
  }
  size_t isRecording() const { return 0; }
};

struct FakeM5 {
  FakeSpeaker Speaker;
  FakeMic Mic;
};
extern FakeM5 M5;
