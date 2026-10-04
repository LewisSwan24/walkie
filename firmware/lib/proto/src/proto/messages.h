// messages.h: payloads the S3 builds and parses (protocol/frames.md). Integers are little endian.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const uint8_t PROTO_VERSION = 2;  // what the S3 says in HELLO; the PC's HELLO is still proto 1
enum : uint8_t { HELLO_PAIRED = 1, HELLO_ADPCM = 2 };  // the flags byte of a proto 2 HELLO
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
// NET (protocol/frames.md, "Network settings (plan 6)"): requests from the PC, replies from the S3.
enum : uint8_t { NET_WIFI_ADD = 1, NET_WIFI_REMOVE = 2, NET_WIFI_LIST = 3, NET_RELAY_SET = 4, NET_RELAY_CLEAR = 5, NET_OK = 0x80, NET_ERR = 0x81, NET_LIST = 0x82 };
enum : uint8_t { NETERR_BAD = 1, NETERR_FULL = 2, NETERR_UNKNOWN = 3, NETERR_STORE = 4 };
const size_t NET_SSID_MAX = 32, NET_PASS_MAX = 63, NET_HOST_MAX = 63, NET_NETWORKS_MAX = 4;
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5, TEST_SELFTEST = 6 };
enum : uint8_t { UI_IDLE = 0, UI_TRANSCRIBING = 1, UI_CONFIRM = 2, UI_WORKING = 3, UI_REPLY = 4, UI_ERROR = 5 };
enum : uint8_t { BTN_CANCEL = 1, BTN_STOP = 2, BTN_DISMISS = 3, BTN_SWITCHING = 4 };
enum : uint8_t { KEY_FRONT = 1, KEY_SIDE = 2 };  // the bits of a TEST KEYS mask
const size_t KEY_STEPS_MAX = 16;
enum : uint8_t { PLAYED_FINISHED = 0, PLAYED_STOPPED = 1 };

struct Played {
  uint32_t bytes;
  uint32_t crc32;
  uint32_t underruns;
  uint32_t maxFill;
  uint8_t reason;
};
struct Command {
  uint8_t op;
  uint8_t arg;  // 0 for ops without one
};
struct TestOp {
  uint8_t op;
  const uint8_t* args;  // into the payload, valid only while the frame is
  size_t len;
};
struct KeyStep {
  uint16_t delayMs;  // after the step before it (the first: after the frame arrived)
  uint8_t mask;      // the keys held from then on
};
// UTF-8 text inside a payload. Not terminated, and not checked: whoever draws it must cope with bad bytes.
struct Text {
  const uint8_t* p;
  size_t n;
};
struct UiView {
  uint8_t state;
  Text project, text;
  bool hasElapsed;
  uint32_t elapsedMs;
};
struct PairMsg {
  uint8_t op;           // PAIR_SET or PAIR_FORGET
  const uint8_t* key;   // SET: the 32 key bytes, inside the payload; FORGET: null
};
struct NetMsg {
  uint8_t op;
  Text ssid, pass, host;  // only the ones the op carries are set; the others are empty
};
struct ApprovalReq {
  uint16_t id;
  Text tool, preview;
};

// Builders write the payload to out and return its length, or 0 when cap is too small.
// nonce: the one from the PC's HELLO being answered, or 0 for the HELLO sent at boot. nonceS: this S3's half of the session keys
// (0 at boot, when there is no session). flags: HELLO_PAIRED, HELLO_ADPCM.
size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce, uint32_t nonceS,
                  uint8_t flags, const char* version, uint8_t* out, size_t cap);
// op: PAIR_OK or PAIR_DENIED; answered: the PC's op it answers.
size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap);
// NET replies. OK and ERR say which op they answer; LIST holds the SSIDs (never a password) and the relay host, empty when none is set.
size_t buildNetOk(uint8_t answered, uint8_t* out, size_t cap);
size_t buildNetErr(uint8_t answered, uint8_t reason, uint8_t* out, size_t cap);
size_t buildNetList(const Text* ssids, size_t count, Text host, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
size_t buildCredit(uint32_t bytes, uint8_t* out, size_t cap);
size_t buildPlayed(const Played& p, uint8_t* out, size_t cap);
size_t buildButton(uint8_t event, uint8_t* out, size_t cap);
size_t buildApprovalRes(uint16_t id, bool allow, bool reasonFollows, uint8_t* out, size_t cap);
// One slice of the screen for TEST SNAP: RGB565 little endian, pixelBytes of them.
size_t buildSnapChunk(uint16_t index, uint16_t count, uint16_t width, uint16_t height, const uint8_t* pixels,
                      size_t pixelBytes, uint8_t* out, size_t cap);

// Parsers return false when the payload is too short for its op: SET_VOLUME and SET_MIC_GAIN need their
// argument byte; every other CMD op needs only the op byte.
bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce);  // a HELLO from the PC
bool parsePing(const uint8_t* p, size_t n, uint32_t& token);
// A PAIR request from the PC: SET with exactly 32 key bytes, or FORGET with nothing after the op. False for anything else.
bool parsePair(const uint8_t* p, size_t n, PairMsg& m);
// A NET request from the PC, exactly as the op lays it out: SSID 1 to 32 bytes, password none or 8 to 63, host 1 to 63 of letters,
// digits, dots and hyphens (a host goes into an HTTP request line). False for anything else.
bool parseNet(const uint8_t* p, size_t n, NetMsg& m);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
bool parseTest(const uint8_t* p, size_t n, TestOp& t);  // splits the op from its arguments; each op's own parser checks them
bool parseUpPattern(const uint8_t* args, size_t n, uint16_t& frames);
bool parseMicSource(const uint8_t* args, size_t n, bool& on);
// A key script: out holds up to cap steps, count is how many. False unless the length is exactly what the script announces.
bool parseKeys(const uint8_t* args, size_t n, KeyStep* out, size_t cap, size_t& count);
// UI and APPROVAL_REQ: false when a field runs past the end of the payload. A tag this version does not know is skipped.
bool parseUi(const uint8_t* p, size_t n, UiView& v);
bool parseApprovalReq(const uint8_t* p, size_t n, ApprovalReq& r);
}  // namespace proto
