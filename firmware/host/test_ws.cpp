// test_ws.cpp: the S3's side of a WebSocket to the relay (RFC 6455, client role), without a socket. The vectors in section 1.3 and
// 5.7 of the RFC are used where it gives them.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "proto/ws.h"
#include "vectors.h"

using proto::WsFrame;

namespace {
const uint8_t SAMPLE_NONCE[16] = {'t', 'h', 'e', ' ', 's', 'a', 'm', 'p', 'l', 'e', ' ', 'n', 'o', 'n', 'c', 'e'};
const uint8_t MASK[4] = {0x37, 0xfa, 0x21, 0x3d};

std::vector<uint8_t> bytes(const char* s) { return std::vector<uint8_t>(s, s + strlen(s)); }
int response(const char* text, size_t& headerLen, int& status) {
  std::vector<uint8_t> b = bytes(text);
  return proto::wsResponse(b.data(), b.size(), headerLen, status);
}
}  // namespace

TEST(wsRequestIsTheUpgradeTheRelayTakes) {
  char out[300];
  size_t n = proto::wsRequest("walkie-relay.fly.dev", "/r/00112233445566778899aabbccddeeff?role=device", SAMPLE_NONCE, out, sizeof out);
  const char* want =
      "GET /r/00112233445566778899aabbccddeeff?role=device HTTP/1.1\r\n"
      "Host: walkie-relay.fly.dev\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "\r\n";
  CHECK(n == strlen(want) && std::string(out, n) == want, "the RFC's sample nonce, as its key");
  CHECK(out[n] == 0, "and it ends in a NUL past the length");
  CHECK(proto::wsRequest("walkie-relay.fly.dev", "/r/00112233445566778899aabbccddeeff?role=device", SAMPLE_NONCE, out, n) == 0,
        "a buffer one short of it and the NUL");
  CHECK(proto::wsRequest("walkie-relay.fly.dev", "/r/00112233445566778899aabbccddeeff?role=device", SAMPLE_NONCE, out, n + 1) == n,
        "exactly enough");
}

TEST(wsRequestRefusesAHostOrPathThatWouldBreakTheRequest) {
  char out[300];
  CHECK(proto::wsRequest("a\r\nX: y", "/", SAMPLE_NONCE, out, sizeof out) == 0, "a line break in the host");
  CHECK(proto::wsRequest("a b", "/", SAMPLE_NONCE, out, sizeof out) == 0, "a space in the host");
  CHECK(proto::wsRequest("a", "/x y", SAMPLE_NONCE, out, sizeof out) == 0, "a space in the path");
  CHECK(proto::wsRequest("a", "/\x7f", SAMPLE_NONCE, out, sizeof out) == 0, "DEL in the path");
  CHECK(proto::wsRequest("", "/", SAMPLE_NONCE, out, sizeof out) == 0, "no host");
  CHECK(proto::wsRequest("a", "", SAMPLE_NONCE, out, sizeof out) == 0, "no path");
  CHECK(proto::wsRequest("a", "x", SAMPLE_NONCE, out, sizeof out) == 0, "a path that does not start with /");
  CHECK(proto::wsRequest("a", "/~", SAMPLE_NONCE, out, sizeof out) > 0, "~ is printable, and fine");
}

TEST(wsKeyIsBase64OfAllSixteenBytes) {
  const uint8_t ff[16] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfb};
  char out[300];
  size_t n = proto::wsRequest("h", "/", ff, out, sizeof out);
  CHECK(std::string(out, n).find("Sec-WebSocket-Key: ////////////////////+w==\r\n") != std::string::npos, "+ and / and the padding");
  const uint8_t ramp[16] = {0xf8, 0x00, 0x3e, 0x0f, 0x80, 0x00, 0xfb, 0xef, 0xbe, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  n = proto::wsRequest("h", "/", ramp, out, sizeof out);
  CHECK(std::string(out, n).find("Sec-WebSocket-Key: +AA+D4AA++++AAAAAAAAAA==\r\n") != std::string::npos, "62 is +, 63 is /, 0 is A");
}

TEST(wsResponseTakesA101WithTheUpgradeAndSaysWhereFramesStart) {
  size_t len = 99;
  int status = 0;
  const char* ok =
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
      "\r\n";
  CHECK(response(ok, len, status) == proto::WS_HTTP_OK && len == strlen(ok) && status == 101, "the RFC's answer");
  std::string withFrame = std::string(ok) + "\x82\x01\x05";
  std::vector<uint8_t> b(withFrame.begin(), withFrame.end());
  CHECK(proto::wsResponse(b.data(), b.size(), len, status) == proto::WS_HTTP_OK && len == strlen(ok), "a frame in the same read is not part of it");
  CHECK(response("HTTP/1.1 101 OK\r\nupgrade: WebSocket\r\nconnection: keep-alive, upgrade\r\n\r\n", len, status) == proto::WS_HTTP_OK,
        "header names and the token are not case sensitive, and Connection is a list");
}

TEST(wsResponseWaitsForAllOfTheHeaders) {
  size_t len = 0;
  int status = 0;
  CHECK(response("", len, status) == proto::WS_HTTP_MORE, "nothing yet");
  CHECK(response("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n", len, status) == proto::WS_HTTP_MORE, "no blank line yet");
  CHECK(response("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r", len, status) == proto::WS_HTTP_MORE,
        "one byte short");
  std::string huge = "HTTP/1.1 101 Switching Protocols\r\nX: " + std::string(proto::WS_HTTP_MAX, 'a');
  CHECK(response(huge.c_str(), len, status) == proto::WS_HTTP_BAD, "headers longer than any relay sends are refused, not waited for");
  std::string fits = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX: ";
  fits += std::string(proto::WS_HTTP_MAX - fits.size() - 4, 'a') + "\r\n\r\n";
  CHECK(fits.size() == proto::WS_HTTP_MAX && response(fits.c_str(), len, status) == proto::WS_HTTP_OK, "WS_HTTP_MAX bytes exactly is fine");
}

TEST(wsResponseRefusesAnythingButTheUpgrade) {
  size_t len = 0;
  int status = 0;
  CHECK(response("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", len, status) == proto::WS_HTTP_BAD &&
            status == 400,
        "the relay's refusal, with its code");
  CHECK(response("HTTP/1.1 200 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD && status == 200,
        "a 200 is not an upgrade");
  CHECK(response("HTTP/1.1 101 OK\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "no Upgrade header");
  CHECK(response("HTTP/1.1 101 OK\r\nUpgrade: h2c\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "an upgrade to something else");
  CHECK(response("HTTP/1.1 101 OK\r\nUpgrade: websocket\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "no Connection header");
  CHECK(response("HTTP/1.1 101 OK\r\nUpgrade: websocket\r\nConnection: close\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "Connection without upgrade");
  CHECK(response("HTTP/1.1 101 OK\r\nUpgrade: websocketx\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "websocketx");
  CHECK(response("HTTP/1.1 101 OK\r\nConnection: upgrades\r\nUpgrade: websocket\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "upgrades");
  CHECK(response("HTTP/1.0 101 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "HTTP/1.0");
  CHECK(response("HTTP/1.1 1010 OK\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "a four-digit code");
  CHECK(response("garbage\r\n\r\n", len, status) == proto::WS_HTTP_BAD && status == 0, "not HTTP at all");
  CHECK(response("X-Upgrade: websocket\r\n\r\n", len, status) == proto::WS_HTTP_BAD, "no status line");
}

TEST(wsEncodeMasksAsTheRfcShows) {
  uint8_t out[32];
  size_t n = proto::wsEncode(proto::WS_TEXT, (const uint8_t*)"Hello", 5, MASK, out, sizeof out);
  CHECK(tohex(out, n) == "818537fa213d7f9f4d5158", "RFC 6455 5.7: a masked Hello");
  n = proto::wsEncode(proto::WS_BINARY, nullptr, 0, MASK, out, sizeof out);
  CHECK(tohex(out, n) == "828037fa213d", "an empty binary frame still carries its mask");
  n = proto::wsEncode(proto::WS_PONG, (const uint8_t*)"Hello", 5, MASK, out, sizeof out);
  CHECK(tohex(out, n).substr(0, 4) == "8a85", "a PONG");
  CHECK(proto::wsEncode(proto::WS_TEXT, (const uint8_t*)"Hello", 5, MASK, out, 10) == 0, "one byte short");
  CHECK(proto::wsEncode(proto::WS_TEXT, (const uint8_t*)"Hello", 5, MASK, out, 11) == 11, "exactly enough");
}

TEST(wsEncodeUsesTheSixteenBitLengthFrom126Bytes) {
  std::vector<uint8_t> payload(proto::WS_MAX_PAYLOAD, 0);
  std::vector<uint8_t> out(proto::WS_MAX_PAYLOAD + 8);
  const uint8_t zero[4] = {0, 0, 0, 0};
  CHECK(proto::wsEncode(proto::WS_BINARY, payload.data(), 125, zero, out.data(), out.size()) == 2 + 4 + 125 && out[1] == (0x80 | 125),
        "125 fits in seven bits");
  CHECK(proto::wsEncode(proto::WS_BINARY, payload.data(), 126, zero, out.data(), out.size()) == 4 + 4 + 126 && out[1] == (0x80 | 126) &&
            out[2] == 0 && out[3] == 126,
        "126 takes the 16-bit form");
  size_t n = proto::wsEncode(proto::WS_BINARY, payload.data(), proto::WS_MAX_PAYLOAD, zero, out.data(), out.size());
  CHECK(n == 4 + 4 + proto::WS_MAX_PAYLOAD && out[2] == (proto::WS_MAX_PAYLOAD >> 8) && out[3] == (proto::WS_MAX_PAYLOAD & 0xff),
        "the largest the relay takes");
  CHECK(proto::wsEncode(proto::WS_BINARY, payload.data(), proto::WS_MAX_PAYLOAD + 1, zero, out.data(), out.size() + 1) == 0,
        "one more is refused: the relay would close on it");
  for (size_t i = 0; i < 200; i++) payload[i] = (uint8_t)i;
  n = proto::wsEncode(proto::WS_BINARY, payload.data(), 200, MASK, out.data(), out.size());
  bool masked = true;
  for (size_t i = 0; i < 200; i++) masked = masked && out[8 + i] == (uint8_t)(i ^ MASK[i % 4]);
  CHECK(n == 208 && masked, "each byte is masked by the key byte at its position mod 4");
}

TEST(wsDecodeTakesTheRfcsUnmaskedFrames) {
  WsFrame f;
  std::vector<uint8_t> b = unhex("820548656c6c6f");
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 7 && f.opcode == proto::WS_BINARY && f.n == 5 && memcmp(f.payload, "Hello", 5) == 0,
        "a binary Hello");
  b = unhex("890548656c6c6f");
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 7 && f.opcode == proto::WS_PING && f.n == 5, "a ping, as the RFC shows it");
  b = unhex("8a00");
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 2 && f.opcode == proto::WS_PONG && f.n == 0, "an empty pong");
  b = unhex("820548656c6c6f" "8200");
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 7, "only the first of two frames is taken");
  b = unhex("827e0100");
  b.resize(4 + 256, 0x5a);
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 260 && f.n == 256 && f.payload == b.data() + 4, "the RFC's 256-byte frame");
}

TEST(wsDecodeWaitsForAWholeFrame) {
  WsFrame f;
  std::vector<uint8_t> b = unhex("820548656c6c6f");
  for (size_t n = 0; n < b.size(); n++) CHECK(proto::wsDecode(b.data(), n, f) == 0, "part of a frame");
  b = unhex("827e01");
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 0, "half of the 16-bit length");
  b = unhex("827e0100");
  b.resize(4 + 255);
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 0, "one byte of 256 short");
}

TEST(wsDecodeRefusesWhatTheRelayNeverSends) {
  WsFrame f;
  const char* bad[] = {
      "02056869",                       // FIN clear: a fragment
      "0003486566",                     // a continuation
      "c20548656c6c6f",                 // RSV1 set
      "a20548656c6c6f",                 // RSV2 set
      "920548656c6c6f",                 // RSV3 set
      "828537fa213d7f9f4d5158",         // masked: a server never masks
      "810548656c6c6f",                 // text: the relay carries binary only
      "830548656c6c6f",                 // an opcode with no meaning
      "8b00",                           // a reserved control opcode
      "827f0000000000000100",           // the 64-bit length
  };
  for (const char* h : bad) {
    std::vector<uint8_t> b = unhex(h);
    CHECK(proto::wsDecode(b.data(), b.size(), f) < 0, h);
  }
  std::vector<uint8_t> big = unhex("827e044d");  // 1101 bytes
  big.resize(4 + 1101);
  CHECK(proto::wsDecode(big.data(), 4, f) < 0, "longer than the relay's limit: refused from the header, without waiting for it");
  std::vector<uint8_t> max = unhex("827e044c");  // 1100 bytes
  max.resize(4 + 1100);
  CHECK(proto::wsDecode(max.data(), max.size(), f) == 1104 && f.n == 1100, "the limit itself is fine");
  std::vector<uint8_t> ping = unhex("897e007e");  // a ping of 126 bytes
  ping.resize(4 + 126);
  CHECK(proto::wsDecode(ping.data(), ping.size(), f) < 0, "a control frame over 125 bytes");
  std::vector<uint8_t> ping125(2 + 125, 0);
  ping125[0] = 0x89;
  ping125[1] = 125;
  CHECK(proto::wsDecode(ping125.data(), ping125.size(), f) == 127, "125 is fine");
}

TEST(wsCloseCodeIsTheFirstTwoBytesOrNone) {
  WsFrame f;
  std::vector<uint8_t> b = unhex("8809" "0fa0" "7265706c61636564");  // 4000 "replaced"
  CHECK(proto::wsDecode(b.data(), b.size(), f) == 11 && f.opcode == proto::WS_CLOSE, "a close");
  CHECK(proto::wsCloseCode(f) == 4000, "replaced by another device with the same key");
  b = unhex("8800");
  proto::wsDecode(b.data(), b.size(), f);
  CHECK(proto::wsCloseCode(f) == 1005, "no code given");
  b = unhex("880103");
  proto::wsDecode(b.data(), b.size(), f);
  CHECK(proto::wsCloseCode(f) == 1005, "one byte is no code");
  b = unhex("880203e8");
  proto::wsDecode(b.data(), b.size(), f);
  CHECK(proto::wsCloseCode(f) == 1000, "1000");
}


TEST(wsRequestEndsInANulEvenInABufferThatHeldSomethingElse) {
  char out[300];
  memset(out, 'x', sizeof out);
  size_t n = proto::wsRequest("h", "/", SAMPLE_NONCE, out, sizeof out);
  CHECK(n > 0 && out[n] == 0 && strlen(out) == n, "a C string the TLS client can be given as is");
}

TEST(wsResponseLongerThanTheLimitIsRefusedEvenWhenItEnds) {
  size_t len = 0;
  int status = 0;
  std::string over = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX: ";
  over += std::string(proto::WS_HTTP_MAX - over.size() - 3, 'a') + "\r\n\r\n";
  CHECK(over.size() == proto::WS_HTTP_MAX + 1, "one byte over");
  CHECK(response(over.c_str(), len, status) == proto::WS_HTTP_BAD, "refused, though its blank line has come");
}

TEST(wsResponseStatusIsZeroWhenTheCodeIsNotThreeDigits) {
  size_t len = 0;
  int status = 7;
  CHECK(response("HTTP/1.1 40x Bad\r\n\r\n", len, status) == proto::WS_HTTP_BAD && status == 0, "40x is no code");
  status = 7;
  CHECK(response("HTTP/1.1 4x0 Bad\r\n\r\n", len, status) == proto::WS_HTTP_BAD && status == 0, "4x0 is no code");
  CHECK(response("HTTP/1.1 503\r\n\r\n", len, status) == proto::WS_HTTP_BAD && status == 503, "a code with no reason phrase");
}

TEST(wsTheRelaysKeepAliveIsAnsweredAsTheRelayTakesIt) {
  // relay/test/device-bytes.test.js sends the relay these bytes and sees it keep the S3.
  WsFrame f;
  std::vector<uint8_t> ping = unhex("8900");
  CHECK(proto::wsDecode(ping.data(), ping.size(), f) == 2 && f.opcode == proto::WS_PING && f.n == 0, "the relay's ping: empty");
  uint8_t out[16];
  size_t n = proto::wsEncode(proto::WS_PONG, f.payload, f.n, MASK, out, sizeof out);
  CHECK(tohex(out, n) == "8a8037fa213d", "the S3's pong: empty, masked");
}
