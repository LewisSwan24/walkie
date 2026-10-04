// audio.h: the audio task owns the mic and the speaker, which share the codec, so one runs at a time.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace audio {
const uint32_t RING_BYTES = 1u << 21;  // 2 MiB of PSRAM: 43.7 s at 24 kHz (the spec asks for 30 s or more)
static_assert((RING_BYTES & (RING_BYTES - 1)) == 0, "proto::ByteRing's index math needs a power-of-two capacity");

bool begin();                          // false when PSRAM for the playback ring is missing
void requestPattern(uint16_t frames);  // RX task: TEST UP_PATTERN

// UI loop, for a take. The mic starts filling a 400 ms pre-roll when the front key goes down (if no reply is playing),
// so the first 300 ms of speech, which pass before the hold is long enough to count, are not lost; the pre-roll goes
// out when the take is committed. A take that is ended before it is committed is dropped without a frame.
void prepareTalk();
void commitTalk(bool reason);  // reason: the take is the spoken reason for a denial (the EOS frame carries F_REASON)
void endTalk();                // released, or cancelled
bool replyBusy();              // a reply is arriving or playing; thread-safe
void requestStop();            // cut the reply that is playing; the RX task turns it into a stop at its next idle pass

// RX task, for the TEST hooks: while the mic source is on, takes read their audio from a FIFO instead of the mic.
void micSource(bool on);
size_t micPcm(const uint8_t* pcm, size_t len);  // PCM16 at 16 kHz into the FIFO; returns the bytes that fitted

// RX task, for replies:
void onHello();                        // the bridge (re)connected: drop any reply, start credit over
void onAudioDown(const uint8_t* payload, size_t len, uint8_t flags);  // decodes by the codec bits of the flags
void setUpCodec(uint8_t codec);        // CMD SET_CODEC: the codec of AUDIO_UP from now on
void stopFromPc();                     // CMD STOP_AUDIO
void rxIdle();                         // grants credit, carries out stops the audio task asks for
}  // namespace audio
