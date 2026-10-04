// test_audio.cpp: drives the real firmware/src/audio.cpp (with the Arduino and M5Unified stubs in stubs/) through the
// interleavings of the RX task and the audio task that the final review found broken (findings F1 to F5 and F8 in
// .superpowers/sdd/2026-09-29-walkie-stage1-link/final-review-firmware.md). Single-threaded: each call below is one
// task's action, so a test can put the other task's action at exactly the instant that matters.
#include <functional>
#include <vector>
#include "audio.cpp"
#include "check.h"
#include "status.h"

uint32_t g_ms = 0;
void (*g_onDelay)() = nullptr;
FakeM5 M5;
Status g_status;

struct Sent {
  uint8_t type, flags;
  std::vector<uint8_t> p;
};
static std::vector<Sent> sent;
static std::function<void()> onPlayed;  // runs when a PLAYED is queued: the PC starts its next reply the moment it reads it

namespace usblink {
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  sent.push_back({type, flags, std::vector<uint8_t>(payload, payload + len)});
  if (type == proto::T_PLAYED && onPlayed) {
    auto f = onPlayed;
    onPlayed = nullptr;
    f();
  }
  return true;
}
void logf(const char*, ...) {}
uint32_t msSincePing() { return 0; }
}  // namespace usblink

struct PlayedInfo {
  uint32_t bytes, underruns;
  uint8_t reason;
};
static uint32_t u32(const std::vector<uint8_t>& p, size_t o) {
  return p[o] | p[o + 1] << 8 | p[o + 2] << 16 | (uint32_t)p[o + 3] << 24;
}
static int count(uint8_t type) {
  int n = 0;
  for (const Sent& s : sent) n += s.type == type;
  return n;
}
static std::vector<PlayedInfo> played() {
  std::vector<PlayedInfo> out;
  for (const Sent& s : sent)
    if (s.type == proto::T_PLAYED && s.p.size() >= 17) out.push_back({u32(s.p, 0), u32(s.p, 8), s.p[16]});
  return out;
}

static uint8_t pcm[960];
static uint32_t lastFinish = 0;  // when the speaker last read a request
static void frame(bool eos, size_t n = 960) { audio::onAudioDown(pcm, n, eos); }
// The audio task's loop for ms milliseconds; the fake speaker task reads one request every 100 ms.
static void runAudio(int ms) {
  for (int t = 0; t < ms; t += 2) {
    audio::handleFlush();
    audio::playStep();
    g_ms += 2;
    if (g_ms / 100 != (g_ms - 2) / 100) {  // a 100 ms boundary was crossed, whatever the clock's parity
      if (M5.Speaker.queued) lastFinish = g_ms;
      M5.Speaker.finishOne();
    }
  }
}
static void reset() {
  static bool attached = false;
  if (!attached) {
    audio::ring.attach((uint8_t*)malloc(audio::RING_BYTES), audio::RING_BYTES);
    attached = true;
  }
  static bool injectAttached = false;
  if (!injectAttached) {
    audio::injectRing.attach((uint8_t*)malloc(audio::INJECT_BYTES), audio::INJECT_BYTES);
    injectAttached = true;
  }
  for (int i = 0; i < 960; i++) pcm[i] = (uint8_t)(i * 7 + 1);
  M5.Speaker = FakeSpeaker();
  M5.Mic = FakeMic();
  g_onDelay = nullptr;
  onPlayed = nullptr;
  audio::stopWanted.store(false);
  audio::endTalk();
  audio::talkCommitted.store(false);
  audio::talkReason.store(false);
  audio::injectOn.store(false);
  audio::injectClear.store(false);
  audio::injectRing.clear();
  g_status.micLevel = 0;
  g_status.takes = 0;
  audio::onHello();
  audio::handleFlush();
  sent.clear();
}

// F1: PLAYED is the PC's cue to start the next reply, so everything the RX task can see must be reset before it goes out.
TEST(audioNextReplyStartsCleanRightAfterPlayed) {
  reset();
  for (int i = 0; i < 15; i++) frame(i == 14);  // reply A: 14,400 bytes, EOS on its last frame
  onPlayed = [] { frame(true); };               // reply B: 960 bytes and EOS, sent the moment PLAYED is read
  runAudio(3000);
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 2, "each of the two replies gets a PLAYED");
  if (p.size() == 2) {
    CHECK(p[0].bytes == 14400 && p[0].reason == proto::PLAYED_FINISHED, "reply A: 14,400 bytes, finished");
    CHECK(p[1].bytes == 960 && p[1].reason == proto::PLAYED_FINISHED, "reply B: 960 bytes, finished");
  }
  CHECK(audio::ring.size() == 0 && !audio::eosReceived.load() && !audio::active, "nothing is left over");
}

// F2: isPlaying() == 0 comes before the DMA queue has been heard, so the speaker stays on for a tail.
TEST(audioSpeakerStaysOnForTheDmaTail) {
  reset();
  static uint32_t endedAt;
  endedAt = 0;
  M5.Speaker.onEnd = [] { endedAt = g_ms; };
  for (int i = 0; i < 15; i++) frame(i == 14);
  runAudio(3000);
  CHECK(endedAt != 0, "the speaker was turned off");
  // 8 DMA buffers of 256 frames at 22,050 Hz = 92.9 ms are still to be heard when the speaker task has read the last request
  CHECK(endedAt - lastFinish >= 93, "the speaker stays on at least 93 ms after the last request was read");
}

// F4: a partial chunk in the ring while the speaker is dry is an underrun, and 300 ms are buffered again.
TEST(audioUnderrunCountsAndRebuffers) {
  reset();
  for (int i = 0; i < 16; i++) frame(false);  // 15,360 bytes, no EOS, then the sender pauses
  runAudio(1000);
  CHECK(audio::stats.underruns == 1, "the speaker ran dry once");
  CHECK(audio::buffering, "buffering again");
  CHECK(count(proto::T_PLAYED) == 0, "no PLAYED yet");
  size_t before = M5.Speaker.played.size();
  for (int i = 0; i < 4; i++) frame(false);  // 960 + 3,840 = one full chunk, but not the 300 ms the re-buffer wants
  runAudio(20);
  CHECK(M5.Speaker.played.size() == before, "no request is handed over while buffering");
  frame(true);  // the end of the reply
  runAudio(3000);
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1, "one PLAYED");
  if (p.size() == 1) {
    CHECK(p[0].bytes == 20160, "every byte was played");
    CHECK(p[0].underruns == 1 && p[0].reason == proto::PLAYED_FINISHED, "PLAYED reports the underrun");
  }
}

// F3: the S3's own stop (talk key) and the PC's STOP_AUDIO for the same reply report once, and the EOS is swallowed.
TEST(audioStopTwiceReportsOnce) {
  reset();
  for (int i = 0; i < 5; i++) frame(false);
  runAudio(10);
  audio::stopWanted.store(true);  // the talk key was pressed
  audio::rxIdle();                // RX task: stopStream(FLUSH_STOP)
  audio::handleFlush();           // audio task, inside talk(): PLAYED(STOPPED)
  CHECK(audio::discarding, "discarding until the stopped reply's EOS");
  audio::stopFromPc();  // the PC's STOP_AUDIO, sent before it saw PLAYED
  CHECK(audio::discarding, "a second stop does not end the discarding");
  frame(true, 0);        // the PC's empty EOS
  audio::handleFlush();  // audio task, once the key is released
  runAudio(100);
  CHECK(count(proto::T_PLAYED) == 1, "one PLAYED for the one reply");
  CHECK(!audio::discarding && !audio::eosReceived.load(), "the empty EOS was swallowed");
}

// F3: a HELLO reset that is pending is never downgraded to a stop, so no PLAYED follows a HELLO.
TEST(audioResetIsNotDowngradedToStop) {
  reset();
  for (int i = 0; i < 5; i++) frame(false);
  runAudio(10);
  audio::onHello();     // RX task: FLUSH_RESET
  audio::stopFromPc();  // RX task, before the audio task ran: must not turn the reset into a stop
  audio::handleFlush();
  CHECK(count(proto::T_PLAYED) == 0, "no PLAYED after a HELLO");
  CHECK(audio::flush.load() == audio::FLUSH_NONE, "the flush was consumed");
}

// F5: the last frame of a reply lands between the end check's reads.
TEST(audioLastFrameLandingAtTheEndCheckIsNotLost) {
  reset();
  for (int i = 0; i < 15; i++) frame(false);
  while (audio::ring.size() > 0) runAudio(2);  // 14,400 bytes handed over as three chunks, no EOS yet
  while (M5.Speaker.queued) M5.Speaker.finishOne();
  // the first isPlaying() call is the chunk loop's condition; the second is the end check, and the last frame lands there
  M5.Speaker.onIsPlaying = [] { M5.Speaker.onIsPlaying = [] { frame(true); }; };
  audio::playStep();
  CHECK(count(proto::T_PLAYED) == 0, "the reply is not declared finished with a frame in the ring");
  runAudio(3000);
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1, "one PLAYED once the frame has played");
  if (p.size() == 1) CHECK(p[0].bytes == 15360, "the last frame is in PLAYED's byte count");
}

// F8: a speaker that will not start, or refuses audio, stops the reply instead of counting bytes as played.
TEST(audioSpeakerThatRefusesAudioStopsTheReply) {
  reset();
  M5.Speaker.playOk = false;
  for (int i = 0; i < 15; i++) frame(false);
  runAudio(50);
  CHECK(audio::stopWanted.load(), "the RX task is asked to stop the reply");
  CHECK(audio::stats.bytes == 0, "refused bytes are not counted as played");
}

TEST(audioSpeakerThatWillNotStartStopsTheReply) {
  reset();
  M5.Speaker.beginOk = false;
  for (int i = 0; i < 15; i++) frame(false);
  runAudio(50);
  CHECK(!audio::speakerOn, "speakerOn is not set when begin() failed");
  CHECK(audio::stopWanted.load(), "the RX task is asked to stop the reply");
}

// S14 run 2: the talk key while a reply plays. The F3 test above calls the stop's steps by hand; this one runs talk()
// itself, which asks for the stop, waits for the RX task to turn it into one, reports PLAYED(STOPPED) once and only then
// opens the mic.
TEST(audioTalkKeyStopsAPlayingReplyThenRecords) {
  reset();
  for (int i = 0; i < 100; i++) frame(false);  // 96,000 bytes and no EOS: the reply is still arriving
  runAudio(400);
  CHECK(audio::speakerOn && audio::stats.bytes > 0, "the reply is playing");
  CHECK(count(proto::T_PLAYED) == 0, "nothing is reported while it plays");
  uint32_t playedBefore = audio::stats.bytes, takesBefore = g_status.takes;
  static int hookCalls;
  hookCalls = 0;
  audio::prepareTalk();  // the key went down and was held
  audio::commitTalk(false);
  g_onDelay = [] {
    if (audio::stopWanted.load()) audio::rxIdle();  // RX task: turns the audio task's request into a stop
    else if (++hookCalls >= 4) audio::endTalk();  // the key is released after a few mic buffers, stop or no stop
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1 && p[0].reason == proto::PLAYED_STOPPED, "one PLAYED, and it says stopped");
  if (p.size() == 1) CHECK(p[0].bytes == playedBefore, "it counts what played, not the rest of the reply");
  CHECK(!audio::speakerOn && !audio::active && audio::ring.size() == 0, "the speaker is off and the ring is empty");
  CHECK(audio::discarding, "the rest of the stopped reply is dropped until its EOS");
  CHECK(count(proto::T_AUDIO_UP) >= 3, "the mic streamed after the stop");
  const Sent* last = nullptr;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP) last = &s;
  CHECK(last && (last->flags & proto::F_EOS) != 0, "the take ends with an EOS");
  CHECK(g_status.takes == takesBefore + 1, "the take is counted");
}

// F8: a mic that will not start ends the take with an empty EOS and waits for the key.
TEST(audioMicThatWillNotStartEndsTheTake) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] { audio::endTalk(); };  // the key is released while the take waits
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}

TEST(audioMicThatStopsRecordingEndsTheTake) {
  reset();
  M5.Mic.recordOk = false;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] { audio::endTalk(); };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 1, "exactly one AUDIO_UP frame");
  if (!sent.empty()) {
    CHECK((sent.back().flags & proto::F_EOS) != 0 && sent.back().p.empty(), "an empty EOS");
  }
}

// ---- plan 4: takes with a pre-roll, the REASON flag, and the TEST mic source -------------------------------------------

// The first sample of each AUDIO_UP frame that has audio: the fake mic fills chunk n with the value n, so this is the order
// and the numbers of the chunks that went out.
static std::vector<int> upSeq() {
  std::vector<int> out;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP && s.p.size() >= 2) out.push_back((int16_t)(s.p[0] | s.p[1] << 8));
  return out;
}
static const Sent* lastUp() {
  const Sent* last = nullptr;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP) last = &s;
  return last;
}
static int calls;

TEST(audioPreRollGoesOutWhenTheTakeIsCommitted) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 30) audio::commitTalk(false);  // the hold reached 300 ms
    if (calls == 40) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  CHECK(seq.size() == 32, "chunks 9 to 40: the 20 before the commit and everything after it");
  bool inOrder = !seq.empty() && seq.front() == 9 && seq.back() == 40;
  for (size_t i = 1; i < seq.size(); i++) inOrder = inOrder && seq[i] == seq[i - 1] + 1;
  CHECK(inOrder, "the pre-roll is the 20 chunks before the commit, oldest first, and no chunk is lost or sent twice");
  const Sent* last = lastUp();
  CHECK(last && last->flags == proto::F_EOS, "the take ends with a plain EOS");
  CHECK(g_status.takes == 1, "one take");
}

TEST(audioPreRollIsWholeWhenTheCommitComesEarly) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 8) audio::commitTalk(false);
    if (calls == 12) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  CHECK(!seq.empty() && seq.front() == 1 && seq.back() == 12 && seq.size() == 12, "from the very first chunk to the last");
}

TEST(audioTakeEndedBeforeItsCommitIsDroppedWithoutAFrame) {
  reset();
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    if (++calls == 10) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 0, "nothing was sent: the PC never hears of a take that was only a press");
  CHECK(g_status.takes == 0 && M5.Mic.ends == 1 && g_status.micLevel == 0, "not counted, and the mic is closed again");
  CHECK(!audio::talkWanted(), "and the task does not start another");
}

TEST(audioCommitAndEndSeenTogetherStillGiveATake) {
  reset();
  audio::prepareTalk();
  audio::commitTalk(false);
  audio::endTalk();  // the UI loop saw the hold only at its release
  CHECK(audio::talkWanted(), "the committed take is still wanted although the key is up");
  audio::talk();
  CHECK(count(proto::T_AUDIO_UP) == 2, "the two chunks that were already recording");
  const Sent* last = lastUp();
  CHECK(last && (last->flags & proto::F_EOS), "and an EOS");
  CHECK(g_status.takes == 1 && !audio::talkWanted(), "counted once, and over");
}

TEST(audioSpokenReasonFlagsOnlyTheEosFrame) {
  reset();
  calls = 0;
  audio::prepareTalk();
  audio::commitTalk(true);
  g_onDelay = [] {
    if (++calls == 6) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  int plain = 0;
  for (const Sent& s : sent)
    if (s.type == proto::T_AUDIO_UP && s.flags == 0) plain++;
  const Sent* last = lastUp();
  CHECK(last && last->flags == (proto::F_EOS | proto::F_REASON), "the EOS frame carries REASON");
  CHECK(plain == count(proto::T_AUDIO_UP) - 1, "no other frame does");
}

TEST(audioReasonTakeThatCouldNotRecordStillEndsFlaggedAsAReason) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  audio::commitTalk(true);
  g_onDelay = [] { audio::endTalk(); };
  audio::talk();
  g_onDelay = nullptr;
  const Sent* last = lastUp();
  CHECK(count(proto::T_AUDIO_UP) == 1 && last && last->flags == (proto::F_EOS | proto::F_REASON) && last->p.empty(),
        "one empty EOS, flagged, so the bridge pairs it with the denial");
}

TEST(audioMicThatWillNotStartForAPressThatNeverCommitsIsSilent) {
  reset();
  M5.Mic.beginOk = false;
  audio::prepareTalk();
  g_onDelay = [] { audio::endTalk(); };  // released within 300 ms
  audio::talk();
  g_onDelay = nullptr;
  CHECK(count(proto::T_AUDIO_UP) == 0 && !audio::talkWanted(), "nothing sent, and the task is not stuck on the key");
}

TEST(audioMicThatWillNotStartEndsEmptyWhenTheTakeIsCommittedLater) {
  reset();
  M5.Mic.beginOk = false;
  calls = 0;
  audio::prepareTalk();
  g_onDelay = [] {
    calls++;
    if (calls == 1) audio::commitTalk(false);
    if (calls == 3) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  const Sent* last = lastUp();
  CHECK(count(proto::T_AUDIO_UP) == 1 && last && last->flags == proto::F_EOS && last->p.empty(), "the commit makes it a take, and it ends empty");
}

TEST(audioAPreparedTakeLeavesAPlayingReplyAloneUntilItIsCommitted) {
  reset();
  for (int i = 0; i < 100; i++) frame(false);
  runAudio(400);
  CHECK(audio::speakerOn && audio::replyBusy(), "a reply is playing");
  audio::prepareTalk();
  CHECK(!audio::talkWanted(), "a prepared take does not want the codec while a reply uses it");
  audio::talk();
  CHECK(!audio::stopWanted.load() && audio::speakerOn && M5.Mic.begins == 0, "talk() does nothing about it");
  audio::commitTalk(false);
  CHECK(audio::talkWanted(), "the commit does");
}

TEST(audioReplyBusyIsTrueFromTheFirstByteToTheLastSoundAndFalseAfter) {
  reset();
  CHECK(!audio::replyBusy(), "idle");
  frame(false);
  CHECK(audio::replyBusy(), "audio has arrived");
  for (int i = 0; i < 14; i++) frame(i == 13);
  runAudio(3000);
  CHECK(!audio::replyBusy(), "played out");
}

TEST(audioLevelIsThePeakOfAChunkInHundredsAndTwentiethsOfFullScale) {
  reset();
  M5.Mic.fixed = 16384;
  calls = 0;
  static int seen;
  seen = -1;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    calls++;
    if (calls == 6) seen = g_status.micLevel;
    if (calls == 8) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(seen == 128, "half of full scale is 128 of 255");
  CHECK(g_status.micLevel == 0, "and the bar is empty again after the take");
  reset();
  M5.Mic.fixed = -32768;
  calls = 0;
  seen = -1;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    calls++;
    if (calls == 6) seen = g_status.micLevel;
    if (calls == 8) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  CHECK(seen == 255, "the most negative sample does not wrap");
}

TEST(audioInjectedPcmIsTheTakeAndTheMicStaysClosed) {
  reset();
  audio::micSource(true);
  uint8_t bytes[5 * 640];
  for (int k = 0; k < 5; k++)
    for (int i = 0; i < 320; i++) {
      int16_t v = (int16_t)((k + 1) * 100);
      bytes[k * 640 + i * 2] = (uint8_t)(v & 0xFF);
      bytes[k * 640 + i * 2 + 1] = (uint8_t)(v >> 8);
    }
  CHECK(audio::micPcm(bytes, sizeof bytes) == sizeof bytes, "the FIFO takes it");
  calls = 0;
  uint32_t t0 = g_ms;
  audio::prepareTalk();
  audio::commitTalk(false);
  g_onDelay = [] {
    if (++calls == 9) audio::endTalk();
  };
  audio::talk();
  g_onDelay = nullptr;
  std::vector<int> seq = upSeq();
  const int want[] = {100, 200, 300, 400, 500, 0, 0, 0, 0};
  bool same = seq.size() == 9;
  for (size_t i = 0; same && i < 9; i++) same = seq[i] == want[i];
  CHECK(same, "the five chunks in order, then silence for what had not arrived");
  CHECK(M5.Mic.begins == 0 && M5.Mic.records == 0, "the real mic was never opened");
  CHECK(g_ms - t0 >= 9 * 20, "paced at the mic's speed: 20 ms a chunk");
}

TEST(audioMicSourceOffClearsTheFifoAndAnOddByteIsDropped) {
  reset();
  audio::micSource(true);
  uint8_t b[641] = {};
  CHECK(audio::micPcm(b, 641) == 640, "an odd byte count loses the half sample");
  audio::micSource(false);
  audio::handleInjectClear();
  CHECK(audio::injectRing.size() == 0, "switching it off empties the FIFO");
  std::vector<uint8_t> big(audio::INJECT_BYTES + 100);
  CHECK(audio::micPcm(big.data(), big.size()) == audio::INJECT_BYTES, "a FIFO that is full takes what fits");
}

TEST(audioAHelloTakesTheTestMicAwayAndEmptiesItsFifo) {
  reset();
  audio::micSource(true);
  uint8_t b[640] = {};
  CHECK(audio::micPcm(b, sizeof b) == sizeof b, "the FIFO holds a recording");
  audio::onHello();  // RX task: the bridge came back; it never heard of the recording
  CHECK(!audio::injectOn.load(), "the real mic is back");
  audio::handleInjectClear();  // audio task
  CHECK(audio::injectRing.size() == 0, "the FIFO is empty");
}

TEST(audioRequestStopFromTheUiLoopStopsThePlayingReplyOnce) {
  reset();
  for (int i = 0; i < 100; i++) frame(false);  // 96,000 bytes and no EOS: the reply is still arriving
  runAudio(400);
  CHECK(audio::speakerOn, "the reply is playing");
  audio::requestStop();  // the side key, in the UI loop
  audio::rxIdle();       // RX task: turns the request into a stop
  runAudio(10);          // audio task: reports it
  std::vector<PlayedInfo> p = played();
  CHECK(p.size() == 1 && p[0].reason == proto::PLAYED_STOPPED, "one PLAYED, and it says stopped");
  CHECK(!audio::speakerOn && audio::ring.size() == 0, "the speaker is off and the ring is empty");
  audio::requestStop();  // an impatient second press
  audio::rxIdle();
  runAudio(10);
  CHECK(played().size() == 1, "reported once");
}
