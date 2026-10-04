// ws.h: the S3's side of a WebSocket to the relay (RFC 6455, client role; protocol/frames.md, "Relay"), apart from the socket, so that
// the host tests can run all of it. The relay carries one link frame per binary message and nothing else, so this takes only what it
// sends: whole (FIN) unmasked frames, binary, ping, pong and close, none longer than WS_MAX_PAYLOAD.
//
// Sec-WebSocket-Accept is not checked: the connection is TLS to a verified relay certificate, and every link frame on it is sealed
// with the pairing key, so a server that skipped the handshake could still read and change nothing.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
enum : uint8_t { WS_CONT = 0x0, WS_TEXT = 0x1, WS_BINARY = 0x2, WS_CLOSE = 0x8, WS_PING = 0x9, WS_PONG = 0xa };
const size_t WS_MAX_PAYLOAD = 1100;  // the relay's MAX_MESSAGE (relay/src/server.js)
const size_t WS_CONTROL_MAX = 125;
const size_t WS_KEY_BYTES = 16;
const size_t WS_HTTP_MAX = 1024;     // the most the relay's 101 answer can be; longer is refused

// The upgrade request for `path` on `host`, with the 16 random bytes `key` as its Sec-WebSocket-Key, NUL-terminated. Returns its
// length without the NUL, or 0 when it does not fit in cap, or host or path is empty, has a byte outside printable ASCII, or the path
// does not start with '/'.
size_t wsRequest(const char* host, const char* path, const uint8_t key[WS_KEY_BYTES], char* out, size_t cap);

enum : int { WS_HTTP_BAD = -1, WS_HTTP_MORE = 0, WS_HTTP_OK = 1 };
// The server's answer to the request, from the start of buf. WS_HTTP_MORE: the headers have not all come yet. WS_HTTP_OK: an HTTP/1.1
// 101 with Upgrade: websocket and Connection: upgrade; headerLen is how many bytes the headers took (frames may follow in the same read).
// WS_HTTP_BAD: anything else, with the status code in `status` (0 when there was none).
int wsResponse(const uint8_t* buf, size_t n, size_t& headerLen, int& status);

// One client frame: FIN, masked with `mask`. Returns its length, or 0 when n is over WS_MAX_PAYLOAD or it does not fit in cap.
size_t wsEncode(uint8_t opcode, const uint8_t* payload, size_t n, const uint8_t mask[4], uint8_t* out, size_t cap);

struct WsFrame {
  uint8_t opcode;
  const uint8_t* payload;  // points into the buffer that was decoded
  size_t n;
};
// One server frame from the start of buf. Returns the bytes it took (f is filled), 0 when not all of it has come yet, or -1 for a
// frame the S3 does not take: fragmented, a reserved bit set, masked, text or an unknown opcode, longer than WS_MAX_PAYLOAD (or a
// control frame over 125 bytes). After -1 the connection is to be closed.
int wsDecode(const uint8_t* buf, size_t n, WsFrame& f);

// The status code in a CLOSE frame, or 1005 when it carries none.
uint16_t wsCloseCode(const WsFrame& f);
}  // namespace proto
