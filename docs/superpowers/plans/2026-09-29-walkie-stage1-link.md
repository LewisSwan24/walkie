# Walkie Stage 1, plan 1 of 4: the link. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Framed, CRC-checked, flow-controlled traffic between the StickS3 (walkie firmware in app1) and the PC over USB. A held front key streams the mic to the PC as a WAV. PC audio plays on the S3 with nothing lost. Tools flash app1 and switch boot slots without touching on-the-beat.

**Architecture:** One wire format (`protocol/frames.md`) is implemented twice: in Node 24 under `bridge/src/link/` and in portable C++ under `firmware/lib/proto/`. Shared test vectors from a small Python reference hold the two together. On the S3, a link RX task, a link TX task and an audio task sit around M5Unified. On the PC, a `Link` class wraps `serialport` and handles HELLO, PING, credit and replies. `tools/` wraps PlatformIO's esptool and refuses any write outside app1 and otadata.

**Tech Stack:** Node 24 (ESM, `node:test`) with `serialport` 13; PlatformIO `espressif32@6.13.0` (Arduino-ESP32 2.0.17) with M5Unified 0.2.23 and M5GFX 0.2.30; WinLibs g++ 16.1 for the firmware's host tests; esptool 4.11 from PlatformIO; ffmpeg for the dev CLI's `play`.

**Spec:** `docs/superpowers/specs/2026-09-29-walkie-design.md`. This plan implements §6.1, the transport parts of §6.2 and §6.3, §6.6 and §6.7, and settles the mic-gain item of §10.

**Stage 1 is four plans.** Each one leaves working, tested software:

1. **The link** (this plan): the protocol, the firmware's link and audio transport, the bridge's `link`, the flash and boot tools, a developer CLI, and mic gain calibration.
2. **Speech**: the OpenAI and Gemini adapters, the provider chain, the loudness chain, intent. Bridge only; it runs against WAV files.
3. **Claude**: the session manager, the permission MCP over HTTP, `<voice>` extraction. Bridge only; it runs against a fake `claude` and then the real one.
4. **The device experience**: the firmware's state machine, screens, key gestures, approvals and SWITCH_CONFIRM, the remaining TEST hooks, and the bridge's `main`, which joins everything into one voice turn.

Plans 2 to 4 are written once the plan before them has landed, so that each can use what the previous one measured.

## Global Constraints

- **on-the-beat lives in app0 and must survive.** Never run `pio run -t upload` or `pio test` against the S3 for this firmware: PlatformIO's upload writes the bootloader, the partition table and app0. The S3 is written only through `tools/flash.mjs` (0x340000 and 0xE000) and `tools/boot.mjs` (0xE000). Never write 0x0, 0x8000, 0x9000 (NVS) or 0x10000-0x33FFFF (app0). (Spec §2 D2, §6.7.)
- The S3 is COM8, USB `303A:1001`. COM9 is a different board (an M5StickC Plus); never flash it.
- Only one program can hold COM8 at a time. Stop the dev CLI before running `tools/flash.mjs` or `tools/boot.mjs`, and the other way round.
- Firmware build, exactly: `platform = espressif32@6.13.0`, `board = esp32-s3-devkitc-1`, `board_build.arduino.memory_type = qio_opi`, `board_upload.flash_size = 8MB`, `board_build.partitions = default_8MB.csv`, `-DBOARD_HAS_PSRAM -DARDUINO_USB_CDC_ON_BOOT=1`, `m5stack/M5Unified@0.2.23`, `m5stack/M5GFX@0.2.30`.
- Firmware boot: `cfg.output_power = false` before `M5.begin()` (charging); `esp_ota_mark_app_valid_cancel_rollback()`; rotation 3 (USB on the left); font `efontCN_16`.
- The firmware's portable code (`firmware/lib/proto/`) compiles as `-std=gnu++11` with `-Wall -Wextra -Werror`, because Arduino-ESP32 2.0.17 builds C++ as gnu++11.
- Wire format, from spec §6.6: `type:u8 | flags:u8 | seq:u16 | len:u16 | payload | crc16:u16`, CRC-16/CCITT-FALSE, little endian, COBS, 0x00-delimited; payloads at most 1024 bytes; flags bit 0 = EOS, bits 1-2 = codec (0 = PCM16), bit 7 reserved.
- Audio: up, 16 kHz mono PCM16 in 640-byte frames; down, 24 kHz mono PCM16 in frames of at most 960 bytes. The playback ring is at least 30 s at 24 kHz, in PSRAM. Playback starts once 300 ms is buffered or the stream has ended. Speaker volume 255 and `magnification` 2 (spec D9).
- The bridge opens the port with DTR and RTS low (`hupcl: false`, `rtscts: false`), so opening it never resets the S3, and keeps it open while it runs.
- Node 24, ESM, `node:test`. In this plan the bridge depends on `serialport` only.
- The global Python stays standard-library only (it is the watermarks-remover interpreter). pyserial and esptool exist only in PlatformIO's Python, `%USERPROFILE%\.platformio\penv\Scripts\python.exe`.
- Recorded takes are his voice. They go to `bridge/takes/`, which is gitignored, and are never committed.
- `%APPDATA%\walkie\keys.env` holds API keys; nothing in this plan reads it.
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Files

```
.gitignore, README.md, package.json         repo root: ignores, how to run things, one `npm test` for all
protocol/frames.md                          the wire contract
protocol/gen_vectors.py                     Python reference; writes protocol/vectors.json
bridge/package.json
bridge/src/link/crc16.js, cobs.js, frame.js      encoding one frame
bridge/src/link/decoder.js                  splitting a byte stream into frames
bridge/src/link/messages.js                 payloads of each frame type
bridge/src/link/pattern.js                  the uplink test pattern
bridge/src/link/credits.js                  spending the S3's credit
bridge/src/link/link.js                     Link: HELLO, PING, credit, replies, reconnecting
bridge/src/link/serial.js                   finding and opening the S3 without resetting it
bridge/src/audio/takes.js, wav.js, tone.js  collecting takes, WAV files and levels, test tones
bridge/src/dev/*.js, bridge/bin/walkie-dev.js    developer commands
bridge/test/**                              node:test suites
firmware/platformio.ini
firmware/lib/proto/src/proto/*              portable C++: crc, cobs, frame, messages, ring, credit, pattern
firmware/host/run.mjs, check.h, test_*.cpp  host tests of lib/proto against protocol/vectors.json
firmware/src/main.cpp                       boot, screen, keys, commands
firmware/src/usblink.h, usblink.cpp         link RX and TX tasks
firmware/src/audio.h, audio.cpp             the audio task: talk key up, replies down
firmware/src/status.h, version.h            shared counters, version string
tools/flash.mjs, tools/boot.mjs             writing app1 and choosing the boot slot
tools/lib/otadata.mjs, partitions.mjs, esptool.mjs, device.mjs
tools/test/*.test.mjs
```

---

### Task 1: Protocol document and test vectors

**Files:**
- Create: `.gitignore`
- Create: `protocol/frames.md`
- Create: `protocol/gen_vectors.py`
- Create (generated): `protocol/vectors.json`

**Interfaces:**
- Produces: `protocol/vectors.json` with keys `crc16`, `crc32` (`[{hex, crc}]`), `cobs` (`[{decoded, encoded}]`), `cobsInvalid` (`[hex]`), `frames` (`[{name, type, flags, seq, payload, wire}]`, `wire` including both 0x00), `streams` (`[{name, chunks: [hex], expect, bad}]`, where `expect` is `"tt:seq,..."` with the type in two hex digits and seq in decimal), `messages` (`[{name, type, dir: "up"|"down", hex, fields}]`), `pattern` (`{first8, at80000}`). Tasks 2, 3, 5 and 6 test against it.

- [ ] **Step 1: Write `.gitignore`**

```
node_modules/
firmware/.pio/
firmware/host/build/
bridge/takes/
*.log
```

- [ ] **Step 2: Write `protocol/frames.md`**

```markdown
# Walkie link protocol, version 1

The StickS3 (walkie firmware in app1) and the PC bridge talk over the S3's USB-Serial-JTAG port (COM8, USB 303A:1001). This file is the wire contract. `vectors.json`, written by the reference implementation in `gen_vectors.py`, holds cases that the bridge's tests and the firmware's host tests must both pass.

## Frames

Before encoding, a frame (the envelope) is, with every integer little endian:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | type |
| 1 | 1 | flags |
| 2 | 2 | seq |
| 4 | 2 | len: payload length, 0 to 1024 |
| 6 | len | payload |
| 6 + len | 2 | CRC-16 of bytes 0 to 5 + len |

- CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR. ASCII `123456789` gives 0x29B1.
- On the wire a frame is `0x00`, COBS(envelope), `0x00`. COBS is Cheshire and Baker's byte stuffing: the encoded envelope contains no 0x00 and is at most one byte per 254 longer, plus one.
- A receiver splits the stream on 0x00 and ignores empty chunks. Every other chunk is one candidate frame. It is bad when it is longer than 1100 bytes, is not valid COBS, decodes to fewer than 8 bytes, has a `len` other than its decoded length minus 8, has `len` above 1024, or fails the CRC. A bad chunk is dropped and counted; nothing else happens. Because every frame starts with its own 0x00, text printed before it (the ROM's boot banner, a crash message) costs only that text.
- `seq` counts the frames sent in each direction, from 0 at start-up, wrapping at 65536. A receiver counts a gap whenever a frame's seq is not the previous one plus 1. Gaps are for diagnosis only: nothing is sent again. Counting restarts at every HELLO.

## Flags

| Bit | Meaning |
|---|---|
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec. 0 is PCM16, little endian, mono; the other values are reserved (ADPCM, Stage 3). |
| 7 | Reserved for encryption (Stage 3). |

All other bits are 0.

## Types

| Code | Name | Direction | Payload |
|---|---|---|---|
| 0x01 | HELLO | both | see HELLO |
| 0x02 | PING | PC to S3 | u32 token |
| 0x03 | PONG | S3 to PC | u32 token, u32 uptime_ms, u32 bad_chunks, u32 seq_gaps |
| 0x10 | AUDIO_UP | S3 to PC | PCM16 at 16 kHz: 640 bytes (20 ms) per frame |
| 0x11 | AUDIO_DOWN | PC to S3 | PCM16 at 24 kHz: at most 960 bytes (20 ms) per frame, even length |
| 0x12 | CREDIT | S3 to PC | u32 bytes |
| 0x13 | PLAYED | S3 to PC | u32 bytes, u32 crc32, u32 underruns, u32 max_fill, u8 reason |
| 0x20-0x23 | UI, BUTTON, APPROVAL_REQ, APPROVAL_RES | | reserved; Stage 1 plan 4 defines them |
| 0x30 | CMD | PC to S3 | u8 op, then its argument |
| 0x31 | TEST | PC to S3 | u8 op, then its arguments |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |

A receiver ignores types it does not know.

### HELLO

- PC to S3: `u8 proto (1), u32 nonce`. The PC picks a new non-zero nonce for each handshake, sends HELLO when it opens the port, and repeats it once a second until the S3 answers. On every PC HELLO the S3 starts the link over: seq counting, credit, and any reply it was playing, which it drops without a PLAYED.
- S3 to PC: `u8 proto (1), u8 reserved (0), u16 up_rate (16000), u16 down_rate (24000), u32 ring_bytes, u32 uptime_ms, u32 nonce`, then the firmware version as UTF-8 to the end of the payload. In an answer, the nonce is the one from the PC's HELLO; in the HELLO the S3 sends at boot, it is 0.
- The PC ignores every frame until an S3 HELLO that carries its current nonce. That HELLO makes the link ready and sets the PC's credit to 0. A second answer with the same nonce (to a repeated HELLO) sets the credit to 0 again, because the S3 started over again. Once the link is ready, a HELLO with nonce 0 means the S3 restarted: the reply being sent fails, and the PC shakes hands again with a new nonce. Any other HELLO was queued before the PC opened the port, and is ignored. The S3's USB port holds output until someone reads it, so a stale HELLO from boot is normal.

### PING and PONG

The PC pings once a second. The S3 answers with the same token, its uptime, and its counts of bad chunks and seq gaps. The PC considers the link down after 3 s without a PONG and goes back to saying HELLO. The S3 shows the PC as offline after 3 s without a PING.

### Credit: flow control for AUDIO_DOWN

- The PC sends AUDIO_DOWN payload only against credit. Its credit starts at 0, returns to 0 at every S3 HELLO, grows by each CREDIT, and shrinks by each AUDIO_DOWN payload it sends. It sends a frame only when the frame's whole payload is covered.
- The S3 grants no more than it has room for. Credit it has granted but not yet received never exceeds the free space in its playback ring, nor a window of 12,288 bytes. The window is what protects the S3's 16,384-byte USB receive queue, which drops bytes when it is full. The S3 grants in steps of at least 1,920 bytes, grants nothing while it is emptying its ring after a stop, and counts AUDIO_DOWN bytes it discards as received.
- The other frame types are small and are not counted.

### Audio streams

- A stream is a run of frames of one type that ends with an EOS frame. AUDIO_UP: one take per hold of the talk key, or per TEST UP_PATTERN. AUDIO_DOWN: one spoken reply.
- The S3 starts playing a reply once 300 ms (14,400 bytes) is buffered or its EOS has arrived. If the ring runs dry before the EOS, that is an underrun, and it buffers 300 ms again before going on. Once the reply has played to the end, it sends PLAYED with reason 0.
- One reply at a time: the PC starts the next AUDIO_DOWN stream only after the PLAYED that ended the previous one.
- Stopping. On STOP_AUDIO, or on its own when the talk key is pressed during a reply, the S3 cuts the speaker and empties its ring. If a reply had started (audio buffered or playing, or frames still arriving), it sends PLAYED with reason 1; if nothing had started, it sends nothing. If frames of that reply were still arriving, it discards AUDIO_DOWN until the reply's EOS.
- The PC sends STOP_AUDIO only for a reply of which it has sent some audio. When it stops a reply, or gets PLAYED with reason 1 while still sending one, it stops sending and sends an empty EOS frame, which ends the S3's discarding. If it stops before sending any audio, the S3 knows nothing of the reply and nothing is sent.

### PLAYED

| Field | Meaning |
|---|---|
| bytes | PCM bytes of the reply handed to the speaker |
| crc32 | CRC-32 of those bytes in order, as zlib computes it (ASCII `123456789` gives 0xCBF43926) |
| underruns | times the ring ran dry before the EOS |
| max_fill | the most bytes the ring held during the reply |
| reason | 0 = played to the end, 1 = stopped |

### CMD

| op | Name | Argument | Effect |
|---|---|---|---|
| 1 | SET_VOLUME | u8, 0-255 | speaker volume, at once |
| 2 | SET_MIC_GAIN | u8, 1-64 | mic magnification, from the next take |
| 3 | STOP_AUDIO | none | stops the reply (see Audio streams) |
| 4 | BOOT_APP0 | none | selects app0 (on-the-beat) and restarts |
| 5 | REBOOT | none | restarts walkie |

The S3 answers each with a LOG line.

### TEST

| op | Name | Arguments | Effect |
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian. Stage 1 plan 4 adds key presses, mic injection and screen capture.
```

- [ ] **Step 3: Write `protocol/gen_vectors.py`**

```python
# Reference implementation of the walkie link (frames.md). Writes vectors.json beside this file;
# the bridge's tests and the firmware's host tests both check themselves against it.
# Standard library only: python protocol/gen_vectors.py
import binascii
import json
import pathlib
import struct

MAX_PAYLOAD, MAX_CHUNK = 1024, 1100


def cobs_encode(data):
    out = bytearray(len(data) + len(data) // 254 + 2)
    enc, codep, code = 1, 0, 1
    for i, b in enumerate(data):
        if b:
            out[enc] = b
            enc += 1
            code += 1
        if not b or code == 0xFF:
            out[codep] = code
            code, codep = 1, enc
            if not b or i < len(data) - 1:
                enc += 1
    out[codep] = code
    return bytes(out[:enc])


def cobs_decode(enc):
    out, r = bytearray(), 0
    while r < len(enc):
        code = enc[r]
        r += 1
        if code == 0:
            return None
        for _ in range(code - 1):
            if r >= len(enc) or enc[r] == 0:
                return None
            out.append(enc[r])
            r += 1
        if code != 0xFF and r < len(enc):
            out.append(0)
    return bytes(out)


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def envelope(t, flags, seq, payload):
    head = struct.pack('<BBHH', t, flags, seq, len(payload)) + payload
    return head + struct.pack('<H', crc16(head))


def wire(t, flags, seq, payload):
    return b'\x00' + cobs_encode(envelope(t, flags, seq, payload)) + b'\x00'


def decode_chunk(chunk):
    if len(chunk) > MAX_CHUNK:
        return None
    env = cobs_decode(chunk)
    if env is None or len(env) < 8:
        return None
    t, flags, seq, n = struct.unpack_from('<BBHH', env)
    if n > MAX_PAYLOAD or n != len(env) - 8:
        return None
    if struct.unpack_from('<H', env, 6 + n)[0] != crc16(env[:6 + n]):
        return None
    return t, flags, seq, env[6:6 + n]


def decode_stream(chunks):
    frames, bad, cur = [], 0, bytearray()
    for data in chunks:
        for b in data:
            if b:
                cur.append(b)
                continue
            if cur:
                f = decode_chunk(bytes(cur))
                if f:
                    frames.append(f)
                else:
                    bad += 1
            cur = bytearray()
    return ','.join('%02x:%d' % (f[0], f[2]) for f in frames), bad


def h(b):
    return b.hex()


# COBS examples from the Wikipedia article (delimiter removed); the encoder must reproduce them.
run = lambda a, b: bytes(range(a, b))
wiki = [
    ('00', '0101'), ('0000', '010101'), ('001100', '01021101'), ('11220033', '0311220233'),
    ('11223344', '0511223344'), ('11000000', '0211010101'),
    (h(run(1, 255)), 'ff' + h(run(1, 255))),
    ('00' + h(run(1, 255)), '01ff' + h(run(1, 255))),
    (h(run(1, 256)), 'ff' + h(run(1, 255)) + '02ff'),
    (h(run(2, 256)) + '00', 'ff' + h(run(2, 256)) + '0101'),
    (h(run(3, 256)) + '0001', 'fe' + h(run(3, 256)) + '0201'),
]
cobs = [{'decoded': '', 'encoded': '01'}]
for dec, enc in wiki:
    assert h(cobs_encode(bytes.fromhex(dec))) == enc, dec[:16]
    assert h(cobs_decode(bytes.fromhex(enc))) == dec, enc[:16]
    cobs.append({'decoded': dec, 'encoded': enc})
cobs_invalid = ['051122', '0200', '03110022', '00']
assert all(cobs_decode(bytes.fromhex(x)) is None for x in cobs_invalid)

big = bytes((i * 37) & 0xFF for i in range(1024))  # zeros every 256 bytes, runs of 255 non-zero bytes
NONCE = 0x5EED1234
frames = []
for name, t, f, s, p in [
    ('hello from bridge', 0x01, 0, 0, bytes([1]) + struct.pack('<I', NONCE)),
    ('ping', 0x02, 0, 7, struct.pack('<I', 0x12345678)),
    ('audio down end of stream, empty', 0x11, 1, 65535, b''),
    ('credit', 0x12, 0, 42, struct.pack('<I', 12288)),
    ('log in utf-8', 0x3F, 0, 3, '你好 walkie'.encode('utf-8')),
    ('audio down, largest payload', 0x11, 0, 513, big),
]:
    w = wire(t, f, s, p)
    assert decode_stream([w]) == ('%02x:%d' % (t, s), 0)
    frames.append({'name': name, 'type': t, 'flags': f, 'seq': s, 'payload': h(p), 'wire': h(w)})

pong = wire(0x03, 0, 8, struct.pack('<IIII', 0x12345678, 5000, 1, 2))
log = wire(0x3F, 0, 9, b'boot')
up = wire(0x10, 1, 10, run(1, 11))
bad_pong = bytearray(pong)
bad_pong[len(pong) // 2] ^= 0x40  # a flipped bit inside the COBS body
rom = b'ESP-ROM:esp32s3-20210327\r\nrst:0x15 (USB_UART_CHIP_RESET)\r\n'
bad_len = struct.pack('<BBHH', 0x3F, 0, 1, 5) + b'ab'
streams = []
for name, chunks, expect, bad in [
    ('boot text before a frame', [rom + pong], '03:8', 1),
    ('frame split across three reads', [pong[:3], pong[3:11], pong[11:]], '03:8', 0),
    ('three frames in one read', [pong + log + up], '03:8,3f:9,10:10', 0),
    ('corrupted frame then a good one', [bytes(bad_pong) + log], '3f:9', 1),
    ('oversized garbage then a good frame', [b'\x00' + b'\x41' * 1200 + log], '3f:9', 1),
    ('only delimiters', [b'\x00\x00\x00', b'\x00'], '', 0),
    ('valid COBS but too short for a frame', [bytes.fromhex('0003010200')], '', 1),
    ('length field disagrees with the data',
     [b'\x00' + cobs_encode(bad_len + struct.pack('<H', crc16(bad_len))) + b'\x00'], '', 1),
]:
    assert decode_stream(chunks) == (expect, bad), name
    streams.append({'name': name, 'chunks': [h(c) for c in chunks], 'expect': expect, 'bad': bad})

messages = []
for name, t, d, p, fields in [
    ('hello_bridge', 0x01, 'down', bytes([1]) + struct.pack('<I', NONCE), {'proto': 1, 'nonce': NONCE}),
    ('hello_device', 0x01, 'up', struct.pack('<BBHHIII', 1, 0, 16000, 24000, 2097152, 123456, NONCE) + b'0.1.0',
     {'proto': 1, 'upRate': 16000, 'downRate': 24000, 'ringBytes': 2097152, 'uptimeMs': 123456, 'nonce': NONCE,
      'version': '0.1.0'}),
    ('ping', 0x02, 'down', struct.pack('<I', 0x12345678), {'token': 0x12345678}),
    ('pong', 0x03, 'up', struct.pack('<IIII', 0x12345678, 5000, 1, 2),
     {'token': 0x12345678, 'uptimeMs': 5000, 'badChunks': 1, 'seqGaps': 2}),
    ('credit', 0x12, 'up', struct.pack('<I', 12288), {'bytes': 12288}),
    ('played', 0x13, 'up', struct.pack('<IIIIB', 480000, 0xCBF43926, 3, 12288, 1),
     {'bytes': 480000, 'crc32': 0xCBF43926, 'underruns': 3, 'maxFill': 12288, 'reason': 1}),
    ('cmd_set_volume', 0x30, 'down', bytes([1, 200]), {'op': 1, 'arg': 200}),
    ('cmd_set_mic_gain', 0x30, 'down', bytes([2, 4]), {'op': 2, 'arg': 4}),
    ('cmd_stop_audio', 0x30, 'down', bytes([3]), {'op': 3, 'arg': 0}),
    ('cmd_boot_app0', 0x30, 'down', bytes([4]), {'op': 4, 'arg': 0}),
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
]:
    messages.append({'name': name, 'type': t, 'dir': d, 'hex': h(p), 'fields': fields})

digits = b'123456789'
ping_head = envelope(0x02, 0, 7, struct.pack('<I', 0x12345678))[:-2]
vectors = {
    'crc16': [{'hex': h(digits), 'crc': crc16(digits)}, {'hex': '', 'crc': 0xFFFF},
              {'hex': h(ping_head), 'crc': crc16(ping_head)}],
    'crc32': [{'hex': h(digits), 'crc': binascii.crc32(digits)}, {'hex': '', 'crc': 0},
              {'hex': h(big), 'crc': binascii.crc32(big)}],
    'cobs': cobs,
    'cobsInvalid': cobs_invalid,
    'frames': frames,
    'streams': streams,
    'messages': messages,
    'pattern': {'first8': h(b''.join(struct.pack('<H', (k * 1103 + 12345) & 0xFFFF) for k in range(8))),
                'at80000': (80000 * 1103 + 12345) & 0xFFFF},
}
assert vectors['crc16'][0]['crc'] == 0x29B1 and vectors['crc32'][0]['crc'] == 0xCBF43926
out = pathlib.Path(__file__).with_name('vectors.json')
out.write_text(json.dumps(vectors, indent=1) + '\n', encoding='utf-8', newline='\n')
print('wrote %s: %d cobs, %d frames, %d streams, %d messages'
      % (out.name, len(cobs), len(frames), len(streams), len(messages)))
```

- [ ] **Step 4: Generate the vectors**

Run: `python protocol/gen_vectors.py`
Expected: `wrote vectors.json: 12 cobs, 6 frames, 8 streams, 12 messages` (the script's own asserts check the Wikipedia COBS cases, both CRC check values and every stream case).

- [ ] **Step 5: Spot-check three values**

Run: `python -c "import json; v=json.load(open('protocol/vectors.json', encoding='utf-8')); print(v['crc16'][0]['crc'], v['crc32'][0]['crc'], v['pattern']['first8'], v['messages'][1]['hex'])"`
Expected: `10673 3421780262 39308834d738263d7541c445134a624e 0100803ec05d0000200040e201003412ed5e302e312e30`

- [ ] **Step 6: Commit**

```bash
git add .gitignore protocol
git commit -m "Add the link protocol and its test vectors" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bridge package and frame codec

**Files:**
- Create: `bridge/package.json`
- Create: `bridge/src/link/crc16.js`
- Create: `bridge/src/link/cobs.js`
- Create: `bridge/src/link/frame.js`
- Create: `bridge/test/vectors.js`
- Test: `bridge/test/link/codec.test.js`

**Interfaces:**
- Consumes: `protocol/vectors.json` (Task 1).
- Produces:
  - `crc16(bytes: Uint8Array): number`
  - `cobsEncode(data: Uint8Array): Uint8Array`, `cobsDecode(enc: Uint8Array): Uint8Array | null`
  - `TYPE` (`HELLO 0x01, PING 0x02, PONG 0x03, AUDIO_UP 0x10, AUDIO_DOWN 0x11, CREDIT 0x12, PLAYED 0x13, UI 0x20, BUTTON 0x21, APPROVAL_REQ 0x22, APPROVAL_RES 0x23, CMD 0x30, TEST 0x31, LOG 0x3f`), `FLAG` (`EOS 0x01`), `MAX_PAYLOAD` (1024), `MAX_CHUNK` (1100)
  - `encodeFrame({type, flags = 0, seq, payload}): Uint8Array`: the wire bytes, both 0x00 included; throws `RangeError` past 1024 bytes of payload
  - `decodeChunk(chunk: Uint8Array): {type, flags, seq, payload: Buffer} | null`: `chunk` is the bytes between two 0x00
  - test helpers `vectors` (the parsed JSON) and `hex(s): Buffer`

- [ ] **Step 1: Write `bridge/package.json` and install**

```json
{
  "name": "walkie-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test \"test/**/*.test.js\""
  },
  "dependencies": {
    "serialport": "^13.0.0"
  }
}
```

Run: `npm --prefix bridge install`
Expected: `added N packages`, with `bridge/package-lock.json` created and no errors.

- [ ] **Step 2: Write the test helper `bridge/test/vectors.js`**

```js
// Loads protocol/vectors.json, the cases the firmware's host tests also run.
import { readFileSync } from 'node:fs';

export const vectors = JSON.parse(readFileSync(new URL('../../protocol/vectors.json', import.meta.url), 'utf8'));
export const hex = (s) => Buffer.from(s, 'hex');
```

- [ ] **Step 3: Write the failing test `bridge/test/link/codec.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { vectors, hex } from '../vectors.js';
import { crc16 } from '../../src/link/crc16.js';
import { cobsEncode, cobsDecode } from '../../src/link/cobs.js';
import { encodeFrame, decodeChunk } from '../../src/link/frame.js';

const toHex = (b) => Buffer.from(b).toString('hex');

test('crc16 matches the vectors', () => {
  for (const v of vectors.crc16) assert.equal(crc16(hex(v.hex)), v.crc);
});

test('zlib crc32 matches the vectors the firmware also checks', () => {
  for (const v of vectors.crc32) assert.equal(crc32(hex(v.hex)), v.crc);
});

test('cobs encodes and decodes every vector', () => {
  for (const v of vectors.cobs) {
    assert.equal(toHex(cobsEncode(hex(v.decoded))), v.encoded);
    assert.equal(toHex(cobsDecode(hex(v.encoded))), v.decoded);
  }
});

test('cobs rejects malformed input', () => {
  for (const e of vectors.cobsInvalid) assert.equal(cobsDecode(hex(e)), null, e);
});

test('frames encode to the vector wire bytes and decode back', () => {
  for (const f of vectors.frames) {
    const wire = encodeFrame({ type: f.type, flags: f.flags, seq: f.seq, payload: hex(f.payload) });
    assert.equal(toHex(wire), f.wire, f.name);
    const got = decodeChunk(hex(f.wire).subarray(1, -1));
    assert.deepEqual(
      { type: got.type, flags: got.flags, seq: got.seq, payload: got.payload.toString('hex') },
      { type: f.type, flags: f.flags, seq: f.seq, payload: f.payload },
      f.name,
    );
  }
});

test('encodeFrame refuses more than 1024 bytes of payload', () => {
  assert.throws(() => encodeFrame({ type: 0x11, seq: 0, payload: new Uint8Array(1025) }), RangeError);
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `node --test bridge/test/link/codec.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/link/crc16.js`.

- [ ] **Step 5: Write `bridge/src/link/crc16.js`**

```js
// CRC-16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, no final XOR.
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
```

- [ ] **Step 6: Write `bridge/src/link/cobs.js`**

```js
// Consistent Overhead Byte Stuffing (Cheshire and Baker): the encoded form contains no 0x00.

export function cobsEncode(data) {
  const out = new Uint8Array(data.length + Math.floor(data.length / 254) + 2);
  let enc = 1;
  let codep = 0;
  let code = 1;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b !== 0) {
      out[enc++] = b;
      code++;
    }
    if (b === 0 || code === 0xff) {
      out[codep] = code;
      code = 1;
      codep = enc;
      if (b === 0 || i < data.length - 1) enc++;
    }
  }
  out[codep] = code;
  return out.subarray(0, enc);
}

// Returns the decoded bytes, or null when the input is not valid COBS.
export function cobsDecode(enc) {
  const out = new Uint8Array(enc.length);
  let r = 0;
  let w = 0;
  while (r < enc.length) {
    const code = enc[r++];
    if (code === 0) return null;
    for (let i = 1; i < code; i++) {
      if (r >= enc.length || enc[r] === 0) return null;
      out[w++] = enc[r++];
    }
    if (code !== 0xff && r < enc.length) out[w++] = 0;
  }
  return out.subarray(0, w);
}
```

- [ ] **Step 7: Write `bridge/src/link/frame.js`**

```js
// One frame of the link (protocol/frames.md): type, flags, seq, len, payload, CRC-16, all little endian,
// then COBS, with a 0x00 before and after.
import { crc16 } from './crc16.js';
import { cobsEncode, cobsDecode } from './cobs.js';

export const TYPE = Object.freeze({
  HELLO: 0x01,
  PING: 0x02,
  PONG: 0x03,
  AUDIO_UP: 0x10,
  AUDIO_DOWN: 0x11,
  CREDIT: 0x12,
  PLAYED: 0x13,
  UI: 0x20,
  BUTTON: 0x21,
  APPROVAL_REQ: 0x22,
  APPROVAL_RES: 0x23,
  CMD: 0x30,
  TEST: 0x31,
  LOG: 0x3f,
});
export const FLAG = Object.freeze({ EOS: 0x01 });
export const MAX_PAYLOAD = 1024;
export const MAX_CHUNK = 1100;

export function encodeFrame({ type, flags = 0, seq, payload = new Uint8Array(0) }) {
  if (payload.length > MAX_PAYLOAD) throw new RangeError(`payload of ${payload.length} bytes, the limit is ${MAX_PAYLOAD}`);
  const env = new Uint8Array(8 + payload.length);
  const dv = new DataView(env.buffer);
  env[0] = type;
  env[1] = flags;
  dv.setUint16(2, seq & 0xffff, true);
  dv.setUint16(4, payload.length, true);
  env.set(payload, 6);
  dv.setUint16(6 + payload.length, crc16(env.subarray(0, 6 + payload.length)), true);
  const body = cobsEncode(env);
  const wire = new Uint8Array(body.length + 2);
  wire.set(body, 1);
  return wire;
}

export function decodeChunk(chunk) {
  if (chunk.length > MAX_CHUNK) return null;
  const env = cobsDecode(chunk);
  if (!env || env.length < 8) return null;
  const dv = new DataView(env.buffer, env.byteOffset, env.length);
  const len = dv.getUint16(4, true);
  if (len > MAX_PAYLOAD || len !== env.length - 8) return null;
  if (dv.getUint16(6 + len, true) !== crc16(env.subarray(0, 6 + len))) return null;
  return { type: env[0], flags: env[1], seq: dv.getUint16(2, true), payload: Buffer.from(env.subarray(6, 6 + len)) };
}
```

- [ ] **Step 8: Run the test to see it pass**

Run: `node --test bridge/test/link/codec.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add bridge/package.json bridge/package-lock.json bridge/src/link/crc16.js bridge/src/link/cobs.js bridge/src/link/frame.js bridge/test/vectors.js bridge/test/link/codec.test.js
git commit -m "Bridge: frame codec (CRC-16, COBS, envelope)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Bridge stream decoder, payloads and test pattern

**Files:**
- Create: `bridge/src/link/decoder.js`
- Create: `bridge/src/link/messages.js`
- Create: `bridge/src/link/pattern.js`
- Test: `bridge/test/link/decoder.test.js`
- Test: `bridge/test/link/messages.test.js`

**Interfaces:**
- Consumes: `decodeChunk`, `MAX_CHUNK` (Task 2); `vectors`, `hex` (Task 2).
- Produces:
  - `class FrameDecoder { push(data: Uint8Array): Frame[]; bad: number }`
  - `PROTO` (1), `CMD` (`SET_VOLUME 1, SET_MIC_GAIN 2, STOP_AUDIO 3, BOOT_APP0 4, REBOOT 5`), `TEST_OP` (`UP_PATTERN 1`)
  - builders `helloPayload(nonce)`, `pingPayload(token)`, `cmdPayload(op, arg?)`, `testPayload(op, frames)`, each returning a `Buffer`
  - parsers, each returning an object or `null` when the payload is too short: `parseHello(p) → {proto, upRate, downRate, ringBytes, uptimeMs, nonce, version}`, `parsePong(p) → {token, uptimeMs, badChunks, seqGaps}`, `parseCredit(p) → {bytes}`, `parsePlayed(p) → {bytes, crc32, underruns, maxFill, reason}`
  - `patternBytes(firstSample, samples): Buffer`

- [ ] **Step 1: Write the failing test `bridge/test/link/decoder.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import { FrameDecoder } from '../../src/link/decoder.js';

const summary = (frames) => frames.map((f) => `${f.type.toString(16).padStart(2, '0')}:${f.seq}`).join(',');

test('stream vectors: the right frames come out and bad chunks are counted', () => {
  for (const s of vectors.streams) {
    const d = new FrameDecoder();
    const frames = s.chunks.flatMap((c) => d.push(hex(c)));
    assert.equal(summary(frames), s.expect, s.name);
    assert.equal(d.bad, s.bad, s.name);
  }
});

test('a frame fed one byte at a time still comes out once', () => {
  const wire = hex(vectors.frames.find((f) => f.name === 'audio down, largest payload').wire);
  const d = new FrameDecoder();
  const frames = [];
  for (const b of wire) frames.push(...d.push(Uint8Array.of(b)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 1024);
  assert.equal(d.bad, 0);
});
```

- [ ] **Step 2: Write the failing test `bridge/test/link/messages.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import {
  helloPayload, pingPayload, cmdPayload, testPayload,
  parseHello, parsePong, parseCredit, parsePlayed,
} from '../../src/link/messages.js';
import { patternBytes } from '../../src/link/pattern.js';

const build = {
  hello_bridge: (f) => helloPayload(f.nonce),
  ping: (f) => pingPayload(f.token),
  cmd_set_volume: (f) => cmdPayload(f.op, f.arg),
  cmd_set_mic_gain: (f) => cmdPayload(f.op, f.arg),
  cmd_stop_audio: (f) => cmdPayload(f.op),
  cmd_boot_app0: (f) => cmdPayload(f.op),
  cmd_reboot: (f) => cmdPayload(f.op),
  test_up_pattern: (f) => testPayload(f.op, f.frames),
};
const parse = { hello_device: parseHello, pong: parsePong, credit: parseCredit, played: parsePlayed };

test('payloads the bridge builds match the vectors', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'down')) {
    assert.equal(build[m.name](m.fields).toString('hex'), m.hex, m.name);
  }
});

test('payloads from the S3 parse to the vector fields', () => {
  for (const m of vectors.messages.filter((m) => m.dir === 'up')) {
    assert.deepEqual(parse[m.name](hex(m.hex)), m.fields, m.name);
  }
});

test('payloads that are too short parse to null', () => {
  assert.equal(parseHello(Buffer.alloc(17)), null);
  assert.equal(parsePong(Buffer.alloc(15)), null);
  assert.equal(parseCredit(Buffer.alloc(3)), null);
  assert.equal(parsePlayed(Buffer.alloc(16)), null);
});

test('the test pattern matches the vectors', () => {
  assert.equal(patternBytes(0, 8).toString('hex'), vectors.pattern.first8);
  assert.equal(patternBytes(80000, 1).readUInt16LE(0), vectors.pattern.at80000);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test bridge/test/link/decoder.test.js bridge/test/link/messages.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/link/decoder.js` and `src/link/messages.js`.

- [ ] **Step 4: Write `bridge/src/link/decoder.js`**

```js
// Splits the byte stream on 0x00 and returns the valid frames; counts the chunks that were not frames.
import { decodeChunk, MAX_CHUNK } from './frame.js';

export class FrameDecoder {
  #buf = Buffer.alloc(MAX_CHUNK);
  #len = 0;
  #overflow = false;
  bad = 0;

  push(data) {
    const frames = [];
    for (const b of data) {
      if (b === 0) {
        if (this.#overflow) {
          this.bad++;
        } else if (this.#len > 0) {
          const f = decodeChunk(this.#buf.subarray(0, this.#len));
          if (f) frames.push(f);
          else this.bad++;
        }
        this.#len = 0;
        this.#overflow = false;
      } else if (this.#len < MAX_CHUNK) {
        this.#buf[this.#len++] = b;
      } else {
        this.#overflow = true;
      }
    }
    return frames;
  }
}
```

- [ ] **Step 5: Write `bridge/src/link/messages.js`**

```js
// Payloads of the link's frame types (protocol/frames.md). Integers are little endian.
export const PROTO = 1;
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1 });

export function helloPayload(nonce) {
  const b = Buffer.alloc(5);
  b[0] = PROTO;
  b.writeUInt32LE(nonce >>> 0, 1);
  return b;
}

export function pingPayload(token) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(token >>> 0);
  return b;
}

export function cmdPayload(op, arg) {
  return arg === undefined ? Buffer.from([op]) : Buffer.from([op, arg]);
}

export function testPayload(op, frames) {
  const b = Buffer.alloc(3);
  b[0] = op;
  b.writeUInt16LE(frames, 1);
  return b;
}

export function parseHello(p) {
  if (p.length < 18) return null;
  return {
    proto: p[0],
    upRate: p.readUInt16LE(2),
    downRate: p.readUInt16LE(4),
    ringBytes: p.readUInt32LE(6),
    uptimeMs: p.readUInt32LE(10),
    nonce: p.readUInt32LE(14),
    version: p.subarray(18).toString('utf8'),
  };
}

export function parsePong(p) {
  if (p.length < 16) return null;
  return { token: p.readUInt32LE(0), uptimeMs: p.readUInt32LE(4), badChunks: p.readUInt32LE(8), seqGaps: p.readUInt32LE(12) };
}

export function parseCredit(p) {
  return p.length < 4 ? null : { bytes: p.readUInt32LE(0) };
}

export function parsePlayed(p) {
  if (p.length < 17) return null;
  return {
    bytes: p.readUInt32LE(0),
    crc32: p.readUInt32LE(4),
    underruns: p.readUInt32LE(8),
    maxFill: p.readUInt32LE(12),
    reason: p[16],
  };
}
```

- [ ] **Step 6: Write `bridge/src/link/pattern.js`**

```js
// The uplink test pattern (protocol/frames.md, TEST UP_PATTERN): sample k is (k * 1103 + 12345) mod 65536, u16 LE.
export function patternBytes(firstSample, samples) {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeUInt16LE(((firstSample + i) * 1103 + 12345) & 0xffff, i * 2);
  return b;
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `node --test bridge/test/link/decoder.test.js bridge/test/link/messages.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 8: Commit**

```bash
git add bridge/src/link/decoder.js bridge/src/link/messages.js bridge/src/link/pattern.js bridge/test/link/decoder.test.js bridge/test/link/messages.test.js
git commit -m "Bridge: stream decoder, payloads and test pattern" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Bridge credit, takes and WAV helpers

**Files:**
- Create: `bridge/src/link/credits.js`
- Create: `bridge/src/audio/takes.js`
- Create: `bridge/src/audio/wav.js`
- Test: `bridge/test/link/credits.test.js`
- Test: `bridge/test/audio/takes.test.js`
- Test: `bridge/test/audio/wav.test.js`

**Interfaces:**
- Consumes: `FLAG` (Task 2).
- Produces:
  - `class CreditGate { available: number; grant(bytes); reset(); acquire(bytes, signal?): Promise<void> }`. `acquire` spends the bytes when it resolves, serves waiters first come first served, and rejects with the signal's reason when the signal aborts.
  - `class TakeCollector { push(frame): Buffer | null; open: boolean; reset() }`. `push` returns the whole take, PCM16 at 16 kHz, on the frame that carries EOS.
  - `encodeWav(pcm: Buffer, rate: number): Buffer` (PCM16 mono)
  - `levels(pcm: Buffer, rate: number, skipMs = 0): {durationMs, peak, rms, clippedPct}`. A sample counts as clipped from |32700| up; `durationMs` covers the whole clip, the other three only what follows the skipped start.

- [ ] **Step 1: Write the failing test `bridge/test/link/credits.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CreditGate } from '../../src/link/credits.js';

const settle = () => new Promise((r) => setImmediate(r));

test('acquire waits for a grant and spends exactly what it asked for', async () => {
  const g = new CreditGate();
  let done = false;
  const p = g.acquire(960).then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  g.grant(1000);
  await p;
  assert.equal(g.available, 40);
});

test('waiters are served in order, each only when it fits', async () => {
  const g = new CreditGate();
  const order = [];
  const a = g.acquire(960).then(() => order.push('a'));
  const b = g.acquire(960).then(() => order.push('b'));
  g.grant(1500);
  await settle();
  assert.deepEqual(order, ['a']);
  g.grant(500);
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(g.available, 80);
});

test('an aborted acquire rejects and leaves the queue', async () => {
  const g = new CreditGate();
  const ac = new AbortController();
  const p = g.acquire(960, ac.signal);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  g.grant(960);
  await g.acquire(960);
  assert.equal(g.available, 0);
});

test('reset forgets all credit', () => {
  const g = new CreditGate();
  g.grant(5000);
  g.reset();
  assert.equal(g.available, 0);
});
```

- [ ] **Step 2: Write the failing test `bridge/test/audio/takes.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TakeCollector } from '../../src/audio/takes.js';
import { FLAG } from '../../src/link/frame.js';

const frame = (bytes, flags = 0) => ({ type: 0x10, flags, seq: 0, payload: Buffer.alloc(bytes, 7) });

test('frames collect into one take that ends at EOS', () => {
  const t = new TakeCollector();
  assert.equal(t.push(frame(640)), null);
  assert.equal(t.open, true);
  const take = t.push(frame(640, FLAG.EOS));
  assert.equal(take.length, 1280);
  assert.equal(t.open, false);
});

test('an empty EOS frame still ends the take', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  assert.equal(t.push(frame(0, FLAG.EOS)).length, 640);
});

test('reset drops a take in progress', () => {
  const t = new TakeCollector();
  t.push(frame(640));
  t.reset();
  assert.equal(t.push(frame(320, FLAG.EOS)).length, 320);
});
```

- [ ] **Step 3: Write the failing test `bridge/test/audio/wav.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, levels } from '../../src/audio/wav.js';

test('encodeWav writes a 44-byte PCM16 mono header', () => {
  const w = encodeWav(Buffer.alloc(320), 16000);
  assert.equal(w.length, 364);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), 356);
  assert.equal(w.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(w.readUInt16LE(20), 1);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt32LE(28), 32000);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString('ascii', 36, 40), 'data');
  assert.equal(w.readUInt32LE(40), 320);
});

test('levels skips the start and reports peak, rms and clipping', () => {
  const samples = [30000, 30000, 30000, 30000, 100, -200, 32767, -32768];
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
  // 16 samples a second, so 250 ms skips the first 4
  const rms = Math.round(Math.sqrt((100 ** 2 + 200 ** 2 + 32767 ** 2 + 32768 ** 2) / 4));
  assert.deepEqual(levels(pcm, 16, 250), { durationMs: 500, peak: 32768, rms, clippedPct: 50 });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `node --test bridge/test/link/credits.test.js bridge/test/audio/takes.test.js bridge/test/audio/wav.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the three modules.

- [ ] **Step 5: Write `bridge/src/link/credits.js`**

```js
// The PC's side of AUDIO_DOWN flow control: audio goes out only against credit the S3 has granted.
export class CreditGate {
  #credit = 0;
  #waiters = [];

  get available() {
    return this.#credit;
  }

  grant(bytes) {
    this.#credit += bytes;
    this.#wake();
  }

  // Forgets all credit (the S3 said HELLO). Waiters keep waiting for new grants.
  reset() {
    this.#credit = 0;
  }

  acquire(bytes, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#waiters.length === 0 && this.#credit >= bytes) {
      this.#credit -= bytes;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { bytes, resolve, signal, onAbort: null };
      if (signal) {
        w.onAbort = () => {
          this.#waiters = this.#waiters.filter((x) => x !== w);
          reject(signal.reason);
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.#waiters.push(w);
    });
  }

  #wake() {
    while (this.#waiters.length > 0 && this.#credit >= this.#waiters[0].bytes) {
      const w = this.#waiters.shift();
      this.#credit -= w.bytes;
      w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
  }
}
```

- [ ] **Step 6: Write `bridge/src/audio/takes.js`**

```js
// Collects AUDIO_UP frames into takes: one take per hold of the talk key, ended by the EOS flag.
import { FLAG } from '../link/frame.js';

export class TakeCollector {
  #parts = [];
  #open = false;

  get open() {
    return this.#open;
  }

  // Returns the finished take (PCM16 at 16 kHz) on the frame that ends it, otherwise null.
  push(frame) {
    if (frame.payload.length > 0) this.#parts.push(frame.payload);
    this.#open = true;
    if (!(frame.flags & FLAG.EOS)) return null;
    const take = Buffer.concat(this.#parts);
    this.reset();
    return take;
  }

  reset() {
    this.#parts = [];
    this.#open = false;
  }
}
```

- [ ] **Step 7: Write `bridge/src/audio/wav.js`**

```js
// PCM16 mono WAV files and simple level measurements.

export function encodeWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Peak, RMS and share of clipped samples after skipping the first skipMs (the mic's start-up transient).
export function levels(pcm, rate, skipMs = 0) {
  const total = pcm.length >> 1;
  const start = Math.min(total, Math.round((rate * skipMs) / 1000));
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = start; i < total; i++) {
    const v = pcm.readInt16LE(i * 2);
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if (a >= 32700) clipped++;
  }
  const n = total - start;
  return {
    durationMs: Math.round((total * 1000) / rate),
    peak,
    rms: n ? Math.round(Math.sqrt(sum / n)) : 0,
    clippedPct: n ? (clipped * 100) / n : 0,
  };
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `node --test bridge/test/link/credits.test.js bridge/test/audio/takes.test.js bridge/test/audio/wav.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 9: Run the whole bridge suite**

Run: `npm --prefix bridge test`
Expected: PASS, 21 tests.

- [ ] **Step 10: Commit**

```bash
git add bridge/src/link/credits.js bridge/src/audio bridge/test/link/credits.test.js bridge/test/audio
git commit -m "Bridge: credit gate, take collector, WAV and levels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Firmware protocol library, part 1: CRC, COBS and frames, with host tests

The same C++ builds for the S3 (PlatformIO picks up `firmware/lib/proto/`) and for the PC (`firmware/host/run.mjs` compiles it with g++). Headers live under `proto/` so that nothing clashes with ESP-IDF's own `crc.h`.

**Files:**
- Create: `firmware/lib/proto/src/proto/crc.h`, `firmware/lib/proto/src/proto/crc.cpp`
- Create: `firmware/lib/proto/src/proto/cobs.h`, `firmware/lib/proto/src/proto/cobs.cpp`
- Create: `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/frame.cpp`
- Create: `firmware/host/run.mjs`, `firmware/host/check.h`, `firmware/host/test_main.cpp`
- Test: `firmware/host/test_codec.cpp`

**Interfaces:**
- Consumes: `protocol/vectors.json` (Task 1).
- Produces, in namespace `proto`:
  - `uint16_t crc16(const uint8_t* p, size_t n)`; `uint32_t crc32Update(uint32_t crc, const uint8_t* p, size_t n)` (zlib-compatible, start from 0)
  - `COBS_ERROR`, `cobsMaxEncoded(n)`, `size_t cobsEncode(in, n, out, cap)`, `size_t cobsDecode(in, n, out, cap)`
  - type constants `T_HELLO, T_PING, T_PONG, T_AUDIO_UP, T_AUDIO_DOWN, T_CREDIT, T_PLAYED, T_CMD, T_TEST, T_LOG`; `F_EOS`; `MAX_PAYLOAD` (1024), `MAX_CHUNK` (1100), `MAX_WIRE` (1040)
  - `struct Frame { uint8_t type, flags; uint16_t seq, len; const uint8_t* payload; }`
  - `size_t encodeFrame(type, flags, seq, payload, len, out, cap)`: 0 on error
  - `class FrameDecoder { template <F> void push(const uint8_t*, size_t, F onFrame); uint32_t bad() const; }`
  - host harness: `TEST(name) { ... }` registers a case; `CHECK(cond, what)`; `unhex(const char*)`, `tohex(p, n)`; `build/vectors.h` with `kCrc16, kCrc32, kCobs, kCobsInvalid, kFrames, kStreams, kMsgs, kPatternFirst8, kPatternAt80000`

- [ ] **Step 1: Write the harness `firmware/host/check.h`**

```cpp
// check.h: a minimal harness for the firmware's host tests (built and run by run.mjs).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>

struct TestCase {
  const char* name;
  void (*fn)();
  TestCase* next;
  TestCase(const char* n, void (*f)());
};

// TEST(name) { ... } defines a case that test_main.cpp runs.
#define TEST(name)                          \
  static void name();                       \
  static TestCase name##_case(#name, name); \
  static void name()

extern int g_pass, g_fail;
#define CHECK(cond, what)                                             \
  do {                                                                \
    if (cond) {                                                       \
      g_pass++;                                                       \
    } else {                                                          \
      g_fail++;                                                       \
      printf("FAIL %s:%d %s\n", __FILE__, __LINE__, (const char*)(what)); \
    }                                                                 \
  } while (0)

std::vector<uint8_t> unhex(const char* h);
std::string tohex(const uint8_t* p, size_t n);
```

- [ ] **Step 2: Write `firmware/host/test_main.cpp`**

```cpp
// test_main.cpp: runs every TEST() defined in the other host test files.
#include "check.h"

int g_pass = 0, g_fail = 0;
static TestCase* g_first = nullptr;

TestCase::TestCase(const char* n, void (*f)()) : name(n), fn(f), next(g_first) { g_first = this; }

std::vector<uint8_t> unhex(const char* h) {
  std::vector<uint8_t> out;
  for (size_t i = 0; h[i] && h[i + 1]; i += 2) {
    unsigned v = 0;
    sscanf(h + i, "%2x", &v);
    out.push_back((uint8_t)v);
  }
  return out;
}

std::string tohex(const uint8_t* p, size_t n) {
  static const char* digits = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += digits[p[i] >> 4];
    s += digits[p[i] & 15];
  }
  return s;
}

int main() {
  int cases = 0;
  for (TestCase* t = g_first; t; t = t->next, cases++) t->fn();
  printf("%d cases, %d checks passed, %d failed\n", cases, g_pass, g_fail);
  return g_fail ? 1 : 0;
}
```

- [ ] **Step 3: Write the runner `firmware/host/run.mjs`**

```js
// Builds and runs the firmware's host tests: writes build/vectors.h from protocol/vectors.json, compiles
// host/*.cpp with firmware/lib/proto using g++ (WinLibs, on PATH), and runs the result.
// Usage, from the repo root: node firmware/host/run.mjs
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const libDir = path.join(root, 'firmware', 'lib', 'proto', 'src');
const buildDir = path.join(here, 'build');
mkdirSync(buildDir, { recursive: true });

const v = JSON.parse(readFileSync(path.join(root, 'protocol', 'vectors.json'), 'utf8'));
const str = (s) => JSON.stringify(s); // the vectors' strings are ASCII, so a JSON string is a valid C literal
const list = (items) => items.join(',\n  ');
writeFileSync(path.join(buildDir, 'vectors.h'), `// Generated by firmware/host/run.mjs from protocol/vectors.json. Do not edit.
#pragma once
#include <stdint.h>
struct HexU32 { const char* hex; uint32_t value; };
struct CobsVec { const char* decoded; const char* encoded; };
struct FrameVec { const char* name; uint8_t type; uint8_t flags; uint16_t seq; const char* payload; const char* wire; };
struct StreamVec { const char* name; const char* chunks; const char* expect; int bad; };
struct MsgVec { const char* name; const char* hex; };
static const HexU32 kCrc16[] = {
  ${list(v.crc16.map((c) => `{${str(c.hex)}, ${c.crc}u}`))}};
static const HexU32 kCrc32[] = {
  ${list(v.crc32.map((c) => `{${str(c.hex)}, ${c.crc}u}`))}};
static const CobsVec kCobs[] = {
  ${list(v.cobs.map((c) => `{${str(c.decoded)}, ${str(c.encoded)}}`))}};
static const char* const kCobsInvalid[] = {${v.cobsInvalid.map(str).join(', ')}};
static const FrameVec kFrames[] = {
  ${list(v.frames.map((f) => `{${str(f.name)}, ${f.type}, ${f.flags}, ${f.seq}, ${str(f.payload)}, ${str(f.wire)}}`))}};
static const StreamVec kStreams[] = {
  ${list(v.streams.map((s) => `{${str(s.name)}, ${str(s.chunks.join(','))}, ${str(s.expect)}, ${s.bad}}`))}};
static const MsgVec kMsgs[] = {
  ${list(v.messages.map((m) => `{${str(m.name)}, ${str(m.hex)}}`))}};
static const char* const kPatternFirst8 = ${str(v.pattern.first8)};
static const uint16_t kPatternAt80000 = ${v.pattern.at80000};
`);

const cpp = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.cpp')).map((f) => path.join(dir, f)) : []);
const exe = path.join(buildDir, 'test_proto.exe');
const cc = spawnSync('g++', ['-std=gnu++11', '-O1', '-Wall', '-Wextra', '-Werror', `-I${libDir}`, `-I${buildDir}`,
  ...cpp(here), ...cpp(path.join(libDir, 'proto')), '-o', exe], { stdio: 'inherit' });
if (cc.error || cc.status !== 0) {
  console.error(cc.error ? `g++ could not start: ${cc.error.message}` : 'compile failed');
  process.exit(1);
}
const run = spawnSync(exe, [], { stdio: 'inherit' });
process.exit(run.status ?? 1);
```

- [ ] **Step 4: Write the failing test `firmware/host/test_codec.cpp`**

```cpp
// test_codec.cpp: CRC, COBS, frames and the stream decoder against protocol/vectors.json.
#include <string.h>
#include "check.h"
#include "proto/cobs.h"
#include "proto/crc.h"
#include "proto/frame.h"
#include "vectors.h"

TEST(crcMatchesVectors) {
  for (const HexU32& v : kCrc16) {
    std::vector<uint8_t> b = unhex(v.hex);
    CHECK(proto::crc16(b.data(), b.size()) == v.value, "crc16");
  }
  for (const HexU32& v : kCrc32) {
    std::vector<uint8_t> b = unhex(v.hex);
    CHECK(proto::crc32Update(0, b.data(), b.size()) == v.value, "crc32");
  }
  std::vector<uint8_t> d = unhex(kCrc32[0].hex);
  uint32_t c = proto::crc32Update(0, d.data(), 4);
  CHECK(proto::crc32Update(c, d.data() + 4, d.size() - 4) == kCrc32[0].value, "crc32 in two parts");
}

TEST(cobsMatchesVectors) {
  static uint8_t out[2048];
  for (const CobsVec& v : kCobs) {
    std::vector<uint8_t> dec = unhex(v.decoded), enc = unhex(v.encoded);
    size_t m = proto::cobsEncode(dec.data(), dec.size(), out, sizeof out);
    CHECK(m != proto::COBS_ERROR && tohex(out, m) == v.encoded, "cobs encode");
    size_t k = proto::cobsDecode(enc.data(), enc.size(), out, sizeof out);
    CHECK(k != proto::COBS_ERROR && tohex(out, k) == v.decoded, "cobs decode");
  }
  for (const char* bad : kCobsInvalid) {
    std::vector<uint8_t> enc = unhex(bad);
    CHECK(proto::cobsDecode(enc.data(), enc.size(), out, sizeof out) == proto::COBS_ERROR, bad);
  }
  const uint8_t five[5] = {1, 2, 3, 4, 5};
  uint8_t small[4];
  CHECK(proto::cobsEncode(five, 5, small, sizeof small) == proto::COBS_ERROR, "encode into a short buffer");
}

TEST(framesMatchVectors) {
  static uint8_t wire[proto::MAX_WIRE];
  for (const FrameVec& v : kFrames) {
    std::vector<uint8_t> p = unhex(v.payload);
    size_t n = proto::encodeFrame(v.type, v.flags, v.seq, p.data(), (uint16_t)p.size(), wire, sizeof wire);
    CHECK(n > 0 && tohex(wire, n) == v.wire, v.name);
    std::vector<uint8_t> w = unhex(v.wire);
    proto::FrameDecoder d;
    int seen = 0;
    d.push(w.data(), w.size(), [&](const proto::Frame& f) {
      seen++;
      CHECK(f.type == v.type && f.flags == v.flags && f.seq == v.seq && tohex(f.payload, f.len) == v.payload,
            v.name);
    });
    CHECK(seen == 1 && d.bad() == 0, v.name);
  }
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  CHECK(proto::encodeFrame(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, wire, sizeof wire) == 0, "payload over 1024");
  CHECK(proto::encodeFrame(0x11, 0, 0, big, 16, wire, 20) == 0, "output buffer too small");
}

TEST(streamsMatchVectors) {
  for (const StreamVec& s : kStreams) {
    proto::FrameDecoder d;
    std::string got, chunks = s.chunks;
    size_t start = 0;
    while (start <= chunks.size()) {
      size_t comma = chunks.find(',', start);
      if (comma == std::string::npos) comma = chunks.size();
      std::vector<uint8_t> b = unhex(chunks.substr(start, comma - start).c_str());
      d.push(b.data(), b.size(), [&](const proto::Frame& f) {
        char item[24];
        snprintf(item, sizeof item, "%s%02x:%u", got.empty() ? "" : ",", (unsigned)f.type, (unsigned)f.seq);
        got += item;
      });
      start = comma + 1;
    }
    CHECK(got == s.expect, s.name);
    CHECK((int)d.bad() == s.bad, s.name);
  }
}
```

- [ ] **Step 5: Run it to see it fail**

Run: `node firmware/host/run.mjs`
Expected: g++ fails with `proto/cobs.h: No such file or directory`, then `compile failed`.

- [ ] **Step 6: Write `firmware/lib/proto/src/proto/crc.h` and `crc.cpp`**

`crc.h`:

```cpp
// crc.h: checksums of the link (protocol/frames.md).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
// CRC-16/CCITT-FALSE: polynomial 0x1021, initial 0xFFFF, no reflection, no final XOR.
uint16_t crc16(const uint8_t* p, size_t n);
// CRC-32 as zlib computes it. Start from 0; pass the previous result to continue.
uint32_t crc32Update(uint32_t crc, const uint8_t* p, size_t n);
}  // namespace proto
```

`crc.cpp`:

```cpp
#include "proto/crc.h"

namespace proto {
uint16_t crc16(const uint8_t* p, size_t n) {
  uint16_t crc = 0xFFFF;
  while (n--) {
    crc ^= (uint16_t)(*p++ << 8);
    for (int i = 0; i < 8; i++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

uint32_t crc32Update(uint32_t crc, const uint8_t* p, size_t n) {
  crc = ~crc;
  while (n--) {
    crc ^= *p++;
    for (int i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}
}  // namespace proto
```

- [ ] **Step 7: Write `firmware/lib/proto/src/proto/cobs.h` and `cobs.cpp`**

`cobs.h`:

```cpp
// cobs.h: Consistent Overhead Byte Stuffing (Cheshire and Baker). The encoded form contains no 0x00.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t COBS_ERROR = (size_t)-1;
// Room cobsEncode() needs for n bytes: the worst case plus one byte it may use as scratch.
inline size_t cobsMaxEncoded(size_t n) { return n + n / 254 + 2; }
// Returns the encoded length (no delimiter), or COBS_ERROR when cap < cobsMaxEncoded(n).
size_t cobsEncode(const uint8_t* in, size_t n, uint8_t* out, size_t cap);
// Returns the decoded length, or COBS_ERROR when the input is malformed or does not fit in cap.
size_t cobsDecode(const uint8_t* in, size_t n, uint8_t* out, size_t cap);
}  // namespace proto
```

`cobs.cpp`:

```cpp
#include "proto/cobs.h"

namespace proto {
size_t cobsEncode(const uint8_t* in, size_t n, uint8_t* out, size_t cap) {
  if (cap < cobsMaxEncoded(n)) return COBS_ERROR;
  size_t enc = 1, codep = 0;
  uint8_t code = 1;
  for (size_t i = 0; i < n; i++) {
    uint8_t b = in[i];
    if (b) {
      out[enc++] = b;
      code++;
    }
    if (!b || code == 0xFF) {
      out[codep] = code;
      code = 1;
      codep = enc;
      if (!b || i + 1 < n) enc++;
    }
  }
  out[codep] = code;
  return enc;
}

size_t cobsDecode(const uint8_t* in, size_t n, uint8_t* out, size_t cap) {
  size_t r = 0, w = 0;
  while (r < n) {
    uint8_t code = in[r++];
    if (code == 0) return COBS_ERROR;
    for (uint8_t i = 1; i < code; i++) {
      if (r >= n || in[r] == 0 || w >= cap) return COBS_ERROR;
      out[w++] = in[r++];
    }
    if (code != 0xFF && r < n) {
      if (w >= cap) return COBS_ERROR;
      out[w++] = 0;
    }
  }
  return w;
}
}  // namespace proto
```

- [ ] **Step 8: Write `firmware/lib/proto/src/proto/frame.h` and `frame.cpp`**

`frame.h`:

```cpp
// frame.h: frames of the link (protocol/frames.md): encoding one, and finding them in a byte stream.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
enum : uint8_t {
  T_HELLO = 0x01,
  T_PING = 0x02,
  T_PONG = 0x03,
  T_AUDIO_UP = 0x10,
  T_AUDIO_DOWN = 0x11,
  T_CREDIT = 0x12,
  T_PLAYED = 0x13,
  T_CMD = 0x30,
  T_TEST = 0x31,
  T_LOG = 0x3F,
};
enum : uint8_t { F_EOS = 0x01 };

const uint16_t MAX_PAYLOAD = 1024;
const size_t MAX_CHUNK = 1100;
const size_t ENVELOPE_MAX = MAX_PAYLOAD + 8;
// The most encodeFrame() writes: two delimiters around COBS of the largest envelope, plus scratch.
const size_t MAX_WIRE = 2 + ENVELOPE_MAX + ENVELOPE_MAX / 254 + 2;

struct Frame {
  uint8_t type;
  uint8_t flags;
  uint16_t seq;
  uint16_t len;
  const uint8_t* payload;  // valid only during the callback that receives the frame
};

// Writes 0x00, COBS(envelope), 0x00 to out. Returns its length, or 0 if len > MAX_PAYLOAD or cap is too small.
size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
                   size_t cap);
// Checks a decoded envelope; on success fills f, whose payload points into env.
bool parseEnvelope(const uint8_t* env, size_t n, Frame& f);

// Splits a byte stream on 0x00, hands every valid frame to a callback and counts the bad chunks.
class FrameDecoder {
 public:
  FrameDecoder() : len_(0), overflow_(false), bad_(0) {}

  template <typename F>
  void push(const uint8_t* data, size_t n, F onFrame) {
    for (size_t i = 0; i < n; i++) {
      uint8_t b = data[i];
      if (b != 0) {
        if (len_ < MAX_CHUNK) chunk_[len_++] = b;
        else overflow_ = true;
        continue;
      }
      if (overflow_) {
        bad_++;
      } else if (len_ > 0) {
        Frame f = Frame();
        if (finish(f)) onFrame(f);
        else bad_++;
      }
      len_ = 0;
      overflow_ = false;
    }
  }
  uint32_t bad() const { return bad_; }

 private:
  bool finish(Frame& f);
  uint8_t chunk_[MAX_CHUNK];
  uint8_t env_[MAX_CHUNK];
  size_t len_;
  bool overflow_;
  uint32_t bad_;
};
}  // namespace proto
```

`frame.cpp`:

```cpp
#include "proto/frame.h"
#include <string.h>
#include "proto/cobs.h"
#include "proto/crc.h"

namespace proto {
namespace {
void put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}
uint16_t get16(const uint8_t* p) { return (uint16_t)(p[0] | (p[1] << 8)); }
}  // namespace

size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
                   size_t cap) {
  if (len > MAX_PAYLOAD) return 0;
  size_t n = (size_t)len + 8;
  if (cap < 2 + cobsMaxEncoded(n)) return 0;
  uint8_t env[ENVELOPE_MAX];
  env[0] = type;
  env[1] = flags;
  put16(env + 2, seq);
  put16(env + 4, len);
  if (len) memcpy(env + 6, payload, len);
  put16(env + 6 + len, crc16(env, 6 + (size_t)len));
  out[0] = 0;
  size_t m = cobsEncode(env, n, out + 1, cap - 2);
  if (m == COBS_ERROR) return 0;
  out[1 + m] = 0;
  return m + 2;
}

bool parseEnvelope(const uint8_t* env, size_t n, Frame& f) {
  if (n < 8) return false;
  uint16_t len = get16(env + 4);
  if (len > MAX_PAYLOAD || (size_t)len != n - 8) return false;
  if (get16(env + 6 + len) != crc16(env, 6 + (size_t)len)) return false;
  f.type = env[0];
  f.flags = env[1];
  f.seq = get16(env + 2);
  f.len = len;
  f.payload = env + 6;
  return true;
}

bool FrameDecoder::finish(Frame& f) {
  size_t n = cobsDecode(chunk_, len_, env_, sizeof env_);
  return n != COBS_ERROR && parseEnvelope(env_, n, f);
}
}  // namespace proto
```

- [ ] **Step 9: Run the host tests to see them pass**

Run: `node firmware/host/run.mjs`
Expected: `4 cases, N checks passed, 0 failed` and exit code 0.

- [ ] **Step 10: Commit**

```bash
git add firmware/lib/proto firmware/host/run.mjs firmware/host/check.h firmware/host/test_main.cpp firmware/host/test_codec.cpp
git commit -m "Firmware: portable frame codec with host tests" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Firmware protocol library, part 2: payloads, ring, credit ledger and test pattern

**Files:**
- Create: `firmware/lib/proto/src/proto/messages.h`, `firmware/lib/proto/src/proto/messages.cpp`
- Create: `firmware/lib/proto/src/proto/ring.h`
- Create: `firmware/lib/proto/src/proto/credit.h`
- Create: `firmware/lib/proto/src/proto/pattern.h`
- Test: `firmware/host/test_state.cpp`

**Interfaces:**
- Consumes: the host harness and `vectors.h` (Task 5).
- Produces, in namespace `proto`:
  - `PROTO_VERSION`; `CMD_SET_VOLUME 1, CMD_SET_MIC_GAIN 2, CMD_STOP_AUDIO 3, CMD_BOOT_APP0 4, CMD_REBOOT 5`; `TEST_UP_PATTERN 1`; `PLAYED_FINISHED 0, PLAYED_STOPPED 1`
  - `struct Played { uint32_t bytes, crc32, underruns, maxFill; uint8_t reason; }`, `struct Command { uint8_t op, arg; }`, `struct TestOp { uint8_t op; uint16_t frames; }`
  - `buildHello(upRate, downRate, ringBytes, uptimeMs, nonce, version, out, cap)`, `buildPong(token, uptimeMs, badChunks, seqGaps, out, cap)`, `buildCredit(bytes, out, cap)`, `buildPlayed(const Played&, out, cap)`: each returns the length, 0 when `cap` is too small
  - `parseHello(p, n, uint32_t& nonce)` (a PC HELLO), `parsePing(p, n, uint32_t& token)`, `parseCmd(p, n, Command&)`, `parseTest(p, n, TestOp&)`: each returns false when too short
  - `class ByteRing { attach(mem, capacity, start = 0); capacity(); size(); space(); write(src, n); read(dst, n); clear(); }`: single producer, single consumer, power-of-two capacity; unattached, it holds nothing
  - `class CreditLedger { CreditLedger(window, step); reset(); received(n); grantable(ringSpace) const; granted(g); outstanding() const; violations() const; }`
  - `uint16_t patternSample(uint32_t k)`

- [ ] **Step 1: Write the failing test `firmware/host/test_state.cpp`**

```cpp
// test_state.cpp: payloads, the ring, the credit ledger and the test pattern.
#include <string.h>
#include "check.h"
#include "proto/credit.h"
#include "proto/messages.h"
#include "proto/pattern.h"
#include "proto/ring.h"
#include "vectors.h"

static std::string msgHex(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(m.name, name) == 0) return m.hex;
  printf("no vector named %s\n", name);
  g_fail++;
  return "";
}

TEST(builtPayloadsMatchVectors) {
  uint8_t out[64];
  size_t n = proto::buildHello(16000, 24000, 2097152, 123456, 0x5EED1234u, "0.1.0", out, sizeof out);
  CHECK(tohex(out, n) == msgHex("hello_device"), "hello_device");
  n = proto::buildPong(0x12345678u, 5000, 1, 2, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pong"), "pong");
  n = proto::buildCredit(12288, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("credit"), "credit");
  proto::Played pl = {480000, 0xCBF43926u, 3, 12288, proto::PLAYED_STOPPED};
  n = proto::buildPlayed(pl, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("played"), "played");
  CHECK(proto::buildPong(1, 2, 3, 4, out, 15) == 0, "pong into a short buffer");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, "0.1.0", out, 22) == 0, "hello into a short buffer");
}

TEST(parsedPayloadsMatchVectors) {
  std::vector<uint8_t> b = unhex(msgHex("hello_bridge").c_str());
  uint32_t nonce = 0;
  CHECK(proto::parseHello(b.data(), b.size(), nonce) && nonce == 0x5EED1234u, "hello_bridge");
  CHECK(!proto::parseHello(b.data(), 4, nonce), "short hello");
  b = unhex(msgHex("ping").c_str());
  uint32_t token = 0;
  CHECK(proto::parsePing(b.data(), b.size(), token) && token == 0x12345678u, "ping");
  CHECK(!proto::parsePing(b.data(), 3, token), "short ping");
  struct {
    const char* name;
    uint8_t op, arg;
  } cmds[] = {{"cmd_set_volume", 1, 200},
              {"cmd_set_mic_gain", 2, 4},
              {"cmd_stop_audio", 3, 0},
              {"cmd_boot_app0", 4, 0},
              {"cmd_reboot", 5, 0}};
  for (auto& c : cmds) {
    b = unhex(msgHex(c.name).c_str());
    proto::Command cmd = {0, 0};
    CHECK(proto::parseCmd(b.data(), b.size(), cmd) && cmd.op == c.op && cmd.arg == c.arg, c.name);
  }
  b = unhex(msgHex("test_up_pattern").c_str());
  proto::TestOp t = {0, 0};
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_UP_PATTERN && t.frames == 250,
        "test_up_pattern");
}

TEST(ringWrapsAcrossTheCounterLimit) {
  static uint8_t mem[16];
  proto::ByteRing r;
  r.attach(mem, 16, 0xFFFFFFF8u);
  uint8_t in[20], out[20];
  for (int i = 0; i < 20; i++) in[i] = (uint8_t)(i + 1);
  CHECK(r.write(in, 10) == 10 && r.size() == 10 && r.space() == 6, "write 10");
  CHECK(r.read(out, 4) == 4 && memcmp(out, in, 4) == 0, "read 4");
  CHECK(r.write(in + 10, 10) == 10 && r.size() == 16 && r.space() == 0, "fill across the wrap");
  CHECK(r.write(in, 1) == 0, "full");
  CHECK(r.read(out, 20) == 16 && memcmp(out, in + 4, 16) == 0, "read back in order");
  CHECK(r.write(in, 3) == 3, "write again");
  r.clear();
  CHECK(r.size() == 0 && r.space() == 16, "clear");
  proto::ByteRing none;
  CHECK(none.space() == 0 && none.write(in, 4) == 0, "an unattached ring takes nothing");
}

TEST(creditLedgerGrantsWhatFits) {
  proto::CreditLedger c(12288, 1920);
  CHECK(c.grantable(2097152) == 12288, "the first grant is the window");
  c.granted(12288);
  CHECK(c.grantable(2097152) == 0, "nothing while the window is out");
  c.received(960);
  CHECK(c.grantable(2097152) == 0, "960 back is below the step");
  c.received(960);
  CHECK(c.grantable(2097152) == 1920, "1920 back is granted again");
  CHECK(c.grantable(12288) == 1920, "ring space counts what is still outstanding");
  CHECK(c.grantable(11000) == 0, "no grant the ring could not hold");
  c.received(20000);
  CHECK(c.violations() == 1 && c.outstanding() == 0, "overspending is counted");
  c.reset();
  CHECK(c.grantable(4000) == 4000, "after a reset the ring limits the grant");
}

TEST(patternMatchesVectors) {
  uint8_t b[16];
  for (uint32_t k = 0; k < 8; k++) {
    uint16_t s = proto::patternSample(k);
    b[2 * k] = (uint8_t)s;
    b[2 * k + 1] = (uint8_t)(s >> 8);
  }
  CHECK(tohex(b, 16) == kPatternFirst8, "first 8 samples");
  CHECK(proto::patternSample(80000) == kPatternAt80000, "sample 80000");
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `node firmware/host/run.mjs`
Expected: g++ fails with `proto/credit.h: No such file or directory`, then `compile failed`.

- [ ] **Step 3: Write `firmware/lib/proto/src/proto/messages.h`**

```cpp
// messages.h: payloads the S3 builds and parses (protocol/frames.md). Integers are little endian.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const uint8_t PROTO_VERSION = 1;
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5 };
enum : uint8_t { TEST_UP_PATTERN = 1 };
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
  uint16_t frames;
};

// Builders write the payload to out and return its length, or 0 when cap is too small.
// nonce: the one from the PC's HELLO being answered, or 0 for the HELLO sent at boot.
size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce,
                  const char* version, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
size_t buildCredit(uint32_t bytes, uint8_t* out, size_t cap);
size_t buildPlayed(const Played& p, uint8_t* out, size_t cap);

// Parsers return false when the payload is too short.
bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce);  // a HELLO from the PC
bool parsePing(const uint8_t* p, size_t n, uint32_t& token);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
bool parseTest(const uint8_t* p, size_t n, TestOp& t);
}  // namespace proto
```

- [ ] **Step 4: Write `firmware/lib/proto/src/proto/messages.cpp`**

```cpp
#include "proto/messages.h"
#include <string.h>

namespace proto {
namespace {
uint8_t* put16(uint8_t* p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  return p + 2;
}
uint8_t* put32(uint8_t* p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> (8 * i));
  return p + 4;
}
uint32_t get32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
}  // namespace

size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce,
                  const char* version, uint8_t* out, size_t cap) {
  size_t vlen = strlen(version);
  if (cap < 18 + vlen) return 0;
  uint8_t* p = out;
  *p++ = PROTO_VERSION;
  *p++ = 0;
  p = put16(p, upRate);
  p = put16(p, downRate);
  p = put32(p, ringBytes);
  p = put32(p, uptimeMs);
  p = put32(p, nonce);
  memcpy(p, version, vlen);
  return 18 + vlen;
}

size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap) {
  if (cap < 16) return 0;
  put32(put32(put32(put32(out, token), uptimeMs), badChunks), seqGaps);
  return 16;
}

size_t buildCredit(uint32_t bytes, uint8_t* out, size_t cap) {
  if (cap < 4) return 0;
  put32(out, bytes);
  return 4;
}

size_t buildPlayed(const Played& pl, uint8_t* out, size_t cap) {
  if (cap < 17) return 0;
  uint8_t* p = put32(put32(put32(put32(out, pl.bytes), pl.crc32), pl.underruns), pl.maxFill);
  *p = pl.reason;
  return 17;
}

bool parseHello(const uint8_t* p, size_t n, uint32_t& nonce) {
  if (n < 5) return false;
  nonce = get32(p + 1);
  return true;
}

bool parsePing(const uint8_t* p, size_t n, uint32_t& token) {
  if (n < 4) return false;
  token = get32(p);
  return true;
}

bool parseCmd(const uint8_t* p, size_t n, Command& c) {
  if (n < 1) return false;
  c.op = p[0];
  c.arg = n >= 2 ? p[1] : 0;
  return true;
}

bool parseTest(const uint8_t* p, size_t n, TestOp& t) {
  if (n < 1) return false;
  t.op = p[0];
  t.frames = n >= 3 ? (uint16_t)(p[1] | (p[2] << 8)) : 0;
  return true;
}
}  // namespace proto
```

- [ ] **Step 5: Write `firmware/lib/proto/src/proto/ring.h`**

```cpp
// ring.h: a single-producer, single-consumer byte ring with a power-of-two capacity.
// write() belongs to the producer task; read() and clear() to the consumer task.
#pragma once
#include <atomic>
#include <stdint.h>
#include <string.h>

namespace proto {
class ByteRing {
 public:
  ByteRing() : buf_(nullptr), cap_(0), head_(0), tail_(0) {}

  // start places both counters, so a test can run them across their 2^32 wrap.
  void attach(uint8_t* mem, uint32_t capacity, uint32_t start = 0) {
    buf_ = mem;
    cap_ = capacity;
    head_.store(start);
    tail_.store(start);
  }
  uint32_t capacity() const { return cap_; }
  uint32_t size() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
  uint32_t space() const { return cap_ - size(); }

  uint32_t write(const uint8_t* src, uint32_t n) {
    uint32_t h = head_.load(std::memory_order_relaxed);
    uint32_t room = cap_ - (h - tail_.load(std::memory_order_acquire));
    if (n > room) n = room;
    if (n == 0) return 0;
    uint32_t pos = h & (cap_ - 1);
    uint32_t first = n < cap_ - pos ? n : cap_ - pos;
    memcpy(buf_ + pos, src, first);
    memcpy(buf_, src + first, n - first);
    head_.store(h + n, std::memory_order_release);
    return n;
  }

  uint32_t read(uint8_t* dst, uint32_t n) {
    uint32_t t = tail_.load(std::memory_order_relaxed);
    uint32_t avail = head_.load(std::memory_order_acquire) - t;
    if (n > avail) n = avail;
    if (n == 0) return 0;
    uint32_t pos = t & (cap_ - 1);
    uint32_t first = n < cap_ - pos ? n : cap_ - pos;
    memcpy(dst, buf_ + pos, first);
    memcpy(dst + first, buf_, n - first);
    tail_.store(t + n, std::memory_order_release);
    return n;
  }

  // Drops everything written so far.
  void clear() { tail_.store(head_.load(std::memory_order_acquire), std::memory_order_release); }

 private:
  uint8_t* buf_;
  uint32_t cap_;
  std::atomic<uint32_t> head_;
  std::atomic<uint32_t> tail_;
};
}  // namespace proto
```

- [ ] **Step 6: Write `firmware/lib/proto/src/proto/credit.h`**

```cpp
// credit.h: the S3's side of AUDIO_DOWN flow control (protocol/frames.md, Credit).
#pragma once
#include <stdint.h>

namespace proto {
class CreditLedger {
 public:
  CreditLedger(uint32_t window, uint32_t step) : window_(window), step_(step), outstanding_(0), violations_(0) {}

  void reset() { outstanding_ = 0; }

  // An AUDIO_DOWN payload of n bytes arrived (played or discarded).
  void received(uint32_t n) {
    if (n > outstanding_) {
      violations_++;
      outstanding_ = 0;
    } else {
      outstanding_ -= n;
    }
  }

  // Credit to grant now, given the ring's free space, or 0. The caller sends it, then calls granted().
  uint32_t grantable(uint32_t ringSpace) const {
    if (ringSpace <= outstanding_ || window_ <= outstanding_) return 0;
    uint32_t g = ringSpace - outstanding_;
    if (g > window_ - outstanding_) g = window_ - outstanding_;
    return g >= step_ ? g : 0;
  }
  void granted(uint32_t g) { outstanding_ += g; }

  uint32_t outstanding() const { return outstanding_; }
  uint32_t violations() const { return violations_; }

 private:
  uint32_t window_, step_, outstanding_, violations_;
};
}  // namespace proto
```

- [ ] **Step 7: Write `firmware/lib/proto/src/proto/pattern.h`**

```cpp
// pattern.h: the uplink test pattern (protocol/frames.md, TEST UP_PATTERN).
#pragma once
#include <stdint.h>

namespace proto {
inline uint16_t patternSample(uint32_t k) { return (uint16_t)(k * 1103u + 12345u); }
}  // namespace proto
```

- [ ] **Step 8: Run the host tests to see them pass**

Run: `node firmware/host/run.mjs`
Expected: `9 cases, N checks passed, 0 failed` and exit code 0.

- [ ] **Step 9: Commit**

```bash
git add firmware/lib/proto firmware/host/test_state.cpp
git commit -m "Firmware: payloads, playback ring, credit ledger and test pattern" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Coexistence tools: otadata, partition check, flash and boot

**Files:**
- Create: `tools/lib/otadata.mjs`
- Create: `tools/lib/partitions.mjs`
- Create: `tools/lib/esptool.mjs`
- Create: `tools/lib/device.mjs`
- Create: `tools/flash.mjs`
- Create: `tools/boot.mjs`
- Test: `tools/test/otadata.test.mjs`
- Test: `tools/test/partitions.test.mjs`

**Interfaces:**
- Produces:
  - `otaEntry(seq): Buffer` (32 bytes), `otadataImage('app0' | 'app1'): Buffer` (8 KB), `OTADATA_ADDR` (0xe000), `OTADATA_SIZE` (0x2000)
  - `EXPECTED` (the six partitions), `parsePartitionTable(buf) → [{label, type, subtype, offset, size}]`, `checkPartitionTable(entries) → string[]` (empty when it matches), `assertSafeWrites([{addr, size}])`, which throws unless every write is app1 (0x340000, at most 0x330000 bytes) or otadata (0xe000, exactly 0x2000 bytes)
  - `PYTHON`, `ESPTOOL`, `PIO`, `esptool(port, args)`, `parseArgs(argv) → {port, skipBuild, rest}`; `verifyLayout(port, dir)`
  - commands: `node tools/flash.mjs [--port COMx] [--skip-build]` and `node tools/boot.mjs app0|app1 [--port COMx]`

- [ ] **Step 1: Write the failing test `tools/test/otadata.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { otaEntry, otadataImage } from '../lib/otadata.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

test('the images match the otadata bytes read from the S3 in Stage 0', () => {
  // app0: read from the S3 before walkie existed. app1: the image that booted the Stage 0 spike.
  assert.equal(sha256(otadataImage('app0')), 'f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0');
  assert.equal(sha256(otadataImage('app1')), '1948f69d226fea36612358041ed24eda23c2f013c0f9759f14ee8284eeeb1767');
});

test('an entry carries the CRC of its ota_seq', () => {
  assert.equal(otaEntry(1).toString('hex'), '01000000' + 'ff'.repeat(24) + '9a984347');
  assert.equal(otaEntry(2).toString('hex'), '02000000' + 'ff'.repeat(24) + '7437f655');
});

test('other slots are refused', () => {
  assert.throws(() => otadataImage('app2'), /unknown slot/);
});
```

- [ ] **Step 2: Write the failing test `tools/test/partitions.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeWrites, checkPartitionTable, parsePartitionTable } from '../lib/partitions.mjs';

// The partition table read from the S3 in Stage 0: six entries, the MD5 entry, then 0xFF.
const DEVICE_TABLE = Buffer.from([
  'aa50010200900000005000006e76730000000000000000000000000000000000',
  'aa50010000e00000002000006f74616461746100000000000000000000000000',
  'aa50001000000100000033006170703000000000000000000000000000000000',
  'aa50001100003400000033006170703100000000000000000000000000000000',
  'aa50018200006700000018007370696666730000000000000000000000000000',
  'aa50010300007f0000000100636f726564756d70000000000000000000000000',
  'ebebffffffffffffffffffffffffffff467eb896e29d1aa938c557f4cdfc4c5b',
].join('') + 'ff'.repeat(3072 - 224), 'hex');

test("the S3's table parses and passes", () => {
  const entries = parsePartitionTable(DEVICE_TABLE);
  assert.deepEqual(entries.map((e) => e.label), ['nvs', 'otadata', 'app0', 'app1', 'spiffs', 'coredump']);
  assert.deepEqual(checkPartitionTable(entries), []);
});

test('a different layout is reported', () => {
  const t = Buffer.from(DEVICE_TABLE);
  t.writeUInt32LE(0x300000, 3 * 32 + 8); // app1's size
  assert.deepEqual(checkPartitionTable(parsePartitionTable(t)), ['app1: size is 0x300000, expected 0x330000']);
  assert.deepEqual(checkPartitionTable(parsePartitionTable(Buffer.alloc(3072, 0xff))), ['expected 6 partitions, found 0']);
});

test('only app1 and otadata may be written', () => {
  assert.doesNotThrow(() => assertSafeWrites([{ addr: 0x340000, size: 900000 }, { addr: 0xe000, size: 0x2000 }]));
  for (const w of [
    { addr: 0x0, size: 4096 },
    { addr: 0x8000, size: 3072 },
    { addr: 0x9000, size: 4096 },
    { addr: 0x10000, size: 4096 },
    { addr: 0x340000, size: 0x330001 },
    { addr: 0xe000, size: 4096 },
  ]) {
    assert.throws(() => assertSafeWrites([w]), /refusing/, JSON.stringify(w));
  }
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `node --test "tools/test/*.test.mjs"`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/otadata.mjs` and `lib/partitions.mjs`.

- [ ] **Step 4: Write `tools/lib/otadata.mjs`**

```js
// Boot-slot selection (ESP-IDF otadata: two 4 KB sectors at 0xE000). The bootloader boots
// ota_{(seq - 1) % 2} for the highest valid ota_seq (spec §3).
import { crc32 } from 'node:zlib';

export const OTADATA_ADDR = 0xe000;
export const OTADATA_SIZE = 0x2000;

// ota_seq, 20 label bytes and 4 state bytes left at 0xFF, then crc32(ota_seq) started from 0xFFFFFFFF.
export function otaEntry(seq) {
  const e = Buffer.alloc(32, 0xff);
  e.writeUInt32LE(seq, 0);
  e.writeUInt32LE(crc32(e.subarray(0, 4), 0xffffffff), 28);
  return e;
}

// app0 is exactly what the S3 held before walkie (sector 0 seq 1, sector 1 seq 0);
// app1 keeps sector 0 and puts seq 2 in sector 1.
export function otadataImage(slot) {
  if (slot !== 'app0' && slot !== 'app1') throw new Error(`unknown slot ${slot}`);
  const img = Buffer.alloc(OTADATA_SIZE, 0xff);
  otaEntry(1).copy(img, 0);
  otaEntry(slot === 'app0' ? 0 : 2).copy(img, 0x1000);
  return img;
}
```

- [ ] **Step 5: Write `tools/lib/partitions.mjs`**

```js
// The S3's partition table (read from 0x8000), the layout walkie was designed for, and the only writes allowed.
export const EXPECTED = [
  { label: 'nvs', type: 1, subtype: 0x02, offset: 0x9000, size: 0x5000 },
  { label: 'otadata', type: 1, subtype: 0x00, offset: 0xe000, size: 0x2000 },
  { label: 'app0', type: 0, subtype: 0x10, offset: 0x10000, size: 0x330000 },
  { label: 'app1', type: 0, subtype: 0x11, offset: 0x340000, size: 0x330000 },
  { label: 'spiffs', type: 1, subtype: 0x82, offset: 0x670000, size: 0x180000 },
  { label: 'coredump', type: 1, subtype: 0x03, offset: 0x7f0000, size: 0x10000 },
];

export function parsePartitionTable(buf) {
  const entries = [];
  for (let off = 0; off + 32 <= buf.length; off += 32) {
    if (buf.readUInt16LE(off) !== 0x50aa) break; // 0xEBEB is the MD5 entry, 0xFFFF the end
    entries.push({
      label: buf.toString('ascii', off + 12, off + 28).replace(/\0.*$/s, ''),
      type: buf[off + 2],
      subtype: buf[off + 3],
      offset: buf.readUInt32LE(off + 4),
      size: buf.readUInt32LE(off + 8),
    });
  }
  return entries;
}

const show = (v) => (typeof v === 'number' ? `0x${v.toString(16)}` : v);

export function checkPartitionTable(entries) {
  const problems = [];
  if (entries.length !== EXPECTED.length) problems.push(`expected ${EXPECTED.length} partitions, found ${entries.length}`);
  EXPECTED.forEach((want, i) => {
    const got = entries[i];
    if (!got) return;
    for (const key of Object.keys(want)) {
      if (got[key] !== want[key]) problems.push(`${want.label}: ${key} is ${show(got[key])}, expected ${show(want[key])}`);
    }
  });
  return problems;
}

export function assertSafeWrites(writes) {
  for (const { addr, size } of writes) {
    const app1 = addr === 0x340000 && size > 0 && size <= 0x330000;
    const otadata = addr === 0xe000 && size === 0x2000;
    if (!app1 && !otadata) {
      throw new Error(`refusing to write ${size} bytes at 0x${addr.toString(16)}: walkie writes only app1 (0x340000) and otadata (0xe000)`);
    }
  }
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `node --test "tools/test/*.test.mjs"`
Expected: PASS, 6 tests.

- [ ] **Step 7: Write `tools/lib/esptool.mjs`**

```js
// Runs PlatformIO's esptool (on this machine pyserial and esptool live only in PlatformIO's Python).
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const pioHome = process.env.PLATFORMIO_CORE_DIR ?? path.join(os.homedir(), '.platformio');
export const PYTHON = path.join(pioHome, 'penv', 'Scripts', 'python.exe');
export const ESPTOOL = path.join(pioHome, 'packages', 'tool-esptoolpy', 'esptool.py');
export const PIO = path.join(pioHome, 'penv', 'Scripts', 'pio.exe');

export function esptool(port, args) {
  const r = spawnSync(PYTHON, [ESPTOOL, '--chip', 'esp32s3', '--port', port, ...args], { stdio: 'inherit' });
  if (r.error) throw new Error(`could not start esptool: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`esptool failed (exit ${r.status})`);
}

// --port COMx (default WALKIE_PORT, else COM8) and --skip-build; other arguments come back in rest.
export function parseArgs(argv) {
  const opts = { port: process.env.WALKIE_PORT ?? 'COM8', skipBuild: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = argv[++i];
    else if (argv[i] === '--skip-build') opts.skipBuild = true;
    else opts.rest.push(argv[i]);
  }
  return opts;
}
```

- [ ] **Step 8: Write `tools/lib/device.mjs`**

```js
// Reads the S3's partition table and stops unless it is the layout walkie was designed for.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { esptool } from './esptool.mjs';
import { checkPartitionTable, parsePartitionTable } from './partitions.mjs';

export function verifyLayout(port, dir) {
  const file = path.join(dir, 'partitions.bin');
  esptool(port, ['--before', 'default_reset', '--after', 'hard_reset', 'read_flash', '0x8000', '0xc00', file]);
  const problems = checkPartitionTable(parsePartitionTable(readFileSync(file)));
  if (problems.length > 0) {
    throw new Error(`The S3's partition table is not the one walkie expects, so nothing was written:\n  ${problems.join('\n  ')}`);
  }
}
```

- [ ] **Step 9: Write `tools/flash.mjs`**

```js
// Builds the walkie firmware, writes it to app1 and selects app1. Never touches app0 (on-the-beat).
// Usage: node tools/flash.mjs [--port COMx] [--skip-build]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIO, esptool, parseArgs } from './lib/esptool.mjs';
import { verifyLayout } from './lib/device.mjs';
import { OTADATA_ADDR, OTADATA_SIZE, otadataImage } from './lib/otadata.mjs';
import { assertSafeWrites } from './lib/partitions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = parseArgs(process.argv.slice(2));
const image = path.join(root, 'firmware', '.pio', 'build', 'sticks3', 'firmware.bin');

if (!opts.skipBuild) {
  const b = spawnSync(PIO, ['run', '-d', path.join(root, 'firmware'), '-e', 'sticks3'], { stdio: 'inherit' });
  if (b.error || b.status !== 0) {
    console.error('The build failed; nothing was written.');
    process.exit(1);
  }
}
if (!existsSync(image)) {
  console.error(`No firmware image at ${image}.`);
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'walkie-flash-'));
try {
  const size = statSync(image).size;
  const ota = path.join(dir, 'otadata-app1.bin');
  writeFileSync(ota, otadataImage('app1'));
  assertSafeWrites([{ addr: 0x340000, size }, { addr: OTADATA_ADDR, size: OTADATA_SIZE }]);
  verifyLayout(opts.port, dir);
  esptool(opts.port, ['--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '0x340000', image, '0xe000', ota]);
  console.log(`walkie (${size} bytes) is in app1 and selected; the S3 is restarting into it.`);
  console.log('Back to on-the-beat: node tools/boot.mjs app0');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 10: Write `tools/boot.mjs`**

```js
// Chooses which app the S3 boots: app0 is on-the-beat, app1 is walkie. Writes only otadata (0xE000).
// Usage: node tools/boot.mjs app0|app1 [--port COMx]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { esptool, parseArgs } from './lib/esptool.mjs';
import { verifyLayout } from './lib/device.mjs';
import { OTADATA_ADDR, OTADATA_SIZE, otadataImage } from './lib/otadata.mjs';
import { assertSafeWrites } from './lib/partitions.mjs';

const opts = parseArgs(process.argv.slice(2));
const slot = opts.rest[0];
if (slot !== 'app0' && slot !== 'app1') {
  console.error('usage: node tools/boot.mjs app0|app1 [--port COMx]');
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'walkie-boot-'));
try {
  const file = path.join(dir, `otadata-${slot}.bin`);
  writeFileSync(file, otadataImage(slot));
  assertSafeWrites([{ addr: OTADATA_ADDR, size: OTADATA_SIZE }]);
  verifyLayout(opts.port, dir);
  esptool(opts.port, ['--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '0xe000', file]);
  console.log(slot === 'app0' ? 'The S3 is restarting into app0 (on-the-beat).' : 'The S3 is restarting into app1 (walkie).');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 11: Prove `boot.mjs` on the S3 with the Stage 0 spike, which is still in app1**

Nothing else may hold COM8. Run: `node tools/boot.mjs app1`
Expected: esptool reads 3072 bytes at 0x8000, then writes 8192 bytes at 0xe000 with `Hash of data verified.`, then `The S3 is restarting into app1 (walkie).`

Then ask the spike which slot it runs from:

```powershell
Start-Sleep -Seconds 3
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" -c "import serial,time; s=serial.Serial(); s.port='COM8'; s.baudrate=115200; s.timeout=0.1; s.dtr=False; s.rts=False; s.open(); time.sleep(0.5); s.reset_input_buffer(); s.write(b'info\n'); time.sleep(1.5); print(s.read(8192).decode('utf-8','replace')); s.close()"
```

Expected: a line containing `running=app1`.

- [ ] **Step 12: Return to on-the-beat and check it answers**

Run: `node tools/boot.mjs app0`
Expected: `The S3 is restarting into app0 (on-the-beat).`

Then run the same one-liner with `b'show\n'` in place of `b'info\n'`.
Expected: on-the-beat's status lines, including `relay` and `battery`. on-the-beat and its settings survived.

- [ ] **Step 13: Commit**

```bash
git add tools
git commit -m "Tools: flash walkie into app1 and switch boot slots, refusing anything else" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Firmware skeleton in app1

**Files:**
- Create: `firmware/platformio.ini`
- Create: `firmware/src/version.h`
- Create: `firmware/src/main.cpp`

**Interfaces:**
- Consumes: `tools/flash.mjs`, `tools/boot.mjs` (Task 7).
- Produces: `WALKIE_VERSION` ("0.1.0"); an image that boots from app1 and prints `walkie 0.1.0 running from app1` every 2 s. Task 10 replaces `main.cpp`.

- [ ] **Step 1: Write `firmware/platformio.ini`**

```ini
; walkie firmware for the M5StickS3. It lives in app1 (ota_1); on-the-beat keeps app0.
; Never `pio run -t upload` or `pio test` against the S3: that writes app0. Use tools/flash.mjs.
[env:sticks3]
platform = espressif32@6.13.0
board = esp32-s3-devkitc-1
framework = arduino
board_build.arduino.memory_type = qio_opi
board_build.flash_mode = qio
board_upload.flash_size = 8MB
board_build.partitions = default_8MB.csv
build_flags =
  -DBOARD_HAS_PSRAM
  -DARDUINO_USB_CDC_ON_BOOT=1
lib_deps =
  m5stack/M5Unified@0.2.23
  m5stack/M5GFX@0.2.30
```

- [ ] **Step 2: Write `firmware/src/version.h`**

```cpp
#pragma once
#define WALKIE_VERSION "0.1.0"
```

- [ ] **Step 3: Write `firmware/src/main.cpp`**

```cpp
// walkie firmware for the M5StickS3. It runs from app1; on-the-beat keeps app0 (spec §6.7).
#include <M5Unified.h>
#include <esp_ota_ops.h>
#include "version.h"

static const char* runningFrom() {
  const esp_partition_t* p = esp_ota_get_running_partition();
  return p ? p->label : "?";
}

void setup() {
  auto cfg = M5.config();
  cfg.output_power = false;  // the StickS3 does not charge with the PM1 boost on
  M5.begin(cfg);
  esp_ota_mark_app_valid_cancel_rollback();
  Serial.begin(115200);
  M5.Display.setRotation(3);
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setCursor(0, 2);
  M5.Display.printf("walkie %s\n运行于 %s\n", WALKIE_VERSION, runningFrom());
}

void loop() {
  static uint32_t last = 0;
  M5.update();
  if (millis() - last >= 2000) {
    last = millis();
    Serial.printf("walkie %s running from %s\n", WALKIE_VERSION, runningFrom());
  }
  delay(10);
}
```

- [ ] **Step 4: Build**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `SUCCESS`, with M5Unified 0.2.23 and M5GFX 0.2.30 in the dependency graph and flash use near 26% of 3,342,336 bytes.

- [ ] **Step 5: Flash it into app1**

Run: `node tools/flash.mjs --skip-build`
Expected: esptool reads the partition table, writes `firmware.bin` at 0x340000 and 8192 bytes at 0xe000, `Hash of data verified.` for both, then `walkie (N bytes) is in app1 and selected; the S3 is restarting into it.`

- [ ] **Step 6: Check it runs from app1**

```powershell
Start-Sleep -Seconds 3
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" -c "import serial,time; s=serial.Serial(); s.port='COM8'; s.baudrate=115200; s.timeout=0.1; s.dtr=False; s.rts=False; s.open(); time.sleep(3); print(s.read(8192).decode('utf-8','replace')); s.close()"
```

Expected: `walkie 0.1.0 running from app1`. His screen shows 「walkie 0.1.0」 and 「运行于 app1」.

- [ ] **Step 7: Round trip through on-the-beat**

Run: `node tools/boot.mjs app0`, then the `show` one-liner from Task 7 Step 12.
Expected: on-the-beat's status lines.

Run: `node tools/boot.mjs app1`, then the one-liner from Step 6.
Expected: `walkie 0.1.0 running from app1` again.

- [ ] **Step 8: Commit**

```bash
git add firmware/platformio.ini firmware/src
git commit -m "Firmware: skeleton that boots from app1" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Bridge `Link` and the serial port opener

**Files:**
- Create: `bridge/src/link/link.js`
- Create: `bridge/src/link/serial.js`
- Test: `bridge/test/link/link.test.js`

**Interfaces:**
- Consumes: `encodeFrame`, `TYPE`, `FLAG` (Task 2); `FrameDecoder`, `CMD`, `TEST_OP`, the payload builders and parsers (Task 3); `CreditGate` (Task 4).
- Produces:
  - `new Link({ openPort: () => Promise<port>, retryMs = 1000, makeNonce = random non-zero u32 })`, where `port` is an EventEmitter with `write(buf)` and `close()` that emits `data`, `close` and `error`
  - `link.start()`, `link.close()`, `link.ready`, `link.credit`, `link.seqGaps`, `link.badChunks`
  - `link.send(type, payload?, flags?) → boolean`, `link.cmd(op, arg?)`, `link.testUpPattern(frames)`
  - `link.playAudio(pcm: Buffer, { signal }?) → Promise<{bytes, crc32, underruns, maxFill, reason}>`. It resolves with the S3's PLAYED; when stopped before any audio went out, it resolves at once with zeros and reason 1. It rejects when the S3 restarts, the port closes or the link is lost.
  - events: `hello` (the S3's HELLO fields, each time the link becomes ready), `pong` (the PONG fields plus `rttMs`), `audio-up` (frame), `played`, `log` (text), `down` (reason), `status` (text), `frame` (any other type)
  - `S3_USB`, `findS3Port() → Promise<string | null>`, `openS3Port(path) → Promise<SerialPort>`

- [ ] **Step 1: Write the failing test `bridge/test/link/link.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Link } from '../../src/link/link.js';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
import { vectors, hex } from '../vectors.js';

// Stands in for the S3's serial port: records what the Link writes, and feeds it frames.
class FakePort extends EventEmitter {
  written = [];
  #seq = 0;
  write(buf) {
    this.written.push(Buffer.from(buf));
    return true;
  }
  close() {
    this.emit('close');
  }
  feed(type, payload = Buffer.alloc(0), flags = 0) {
    this.emit('data', Buffer.from(encodeFrame({ type, flags, seq: this.#seq++, payload })));
  }
  sent() {
    const d = new FrameDecoder();
    return this.written.flatMap((b) => d.push(b));
  }
}

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
// The vector's HELLO answers nonce 0x5eed1234; the Links under test pick that nonce.
const NONCE = 0x5eed1234;
const HELLO = hex(vectors.messages.find((m) => m.name === 'hello_device').hex);
const helloWithNonce = (nonce) => {
  const p = Buffer.from(HELLO);
  p.writeUInt32LE(nonce, 14);
  return p;
};
const played = (bytes, reason) => Buffer.concat([u32(bytes), u32(0), u32(0), u32(0), Buffer.from([reason])]);
const audio = (port) => port.sent().filter((f) => f.type === TYPE.AUDIO_DOWN).map((f) => [f.payload.length, f.flags]);
const settle = () => new Promise((r) => setImmediate(r));

async function readyLink(t) {
  const port = new FakePort();
  const link = new Link({ openPort: async () => port, makeNonce: () => NONCE });
  t.after(() => link.close());
  await link.start();
  port.feed(TYPE.HELLO, HELLO);
  return { port, link };
}

test('says HELLO every second until walkie answers it, ignoring what came before', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const port = new FakePort();
  const link = new Link({ openPort: async () => port, makeNonce: () => NONCE });
  t.after(() => link.close());
  const logs = [];
  link.on('log', (s) => logs.push(s));
  await link.start();
  port.feed(TYPE.LOG, Buffer.from('from before the bridge connected'));
  port.feed(TYPE.HELLO, helloWithNonce(0)); // queued at boot
  port.feed(TYPE.HELLO, helloWithNonce(7)); // an answer to some earlier bridge
  assert.equal(link.ready, false);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => [f.type, f.payload.toString('hex')]), [
    [TYPE.HELLO, '013412ed5e'],
    [TYPE.HELLO, '013412ed5e'],
  ]);
  let hello = null;
  link.on('hello', (h) => { hello = h; });
  port.feed(TYPE.HELLO, HELLO);
  assert.equal(link.ready, true);
  assert.equal(hello.version, '0.1.0');
  assert.deepEqual(logs, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO, TYPE.HELLO, TYPE.PING]);
});

test('a second answer to the same HELLO starts credit over, as the S3 did', async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.CREDIT, u32(12288));
  assert.equal(link.credit, 12288);
  port.feed(TYPE.HELLO, HELLO);
  assert.equal(link.ready, true);
  assert.equal(link.credit, 0);
});

test('reports the link down after 3 s without a PONG, then says HELLO again', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  t.mock.timers.tick(3000);
  assert.deepEqual(downs, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(downs, ['no PONG for 3 s']);
  assert.equal(link.ready, false);
  assert.equal(port.sent().at(-1).type, TYPE.HELLO);
});

test('a PONG reports the round trip and the S3 counters', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { port, link } = await readyLink(t);
  t.mock.timers.tick(1000);
  const ping = port.sent().at(-1);
  assert.equal(ping.type, TYPE.PING);
  let pong = null;
  link.on('pong', (p) => { pong = p; });
  t.mock.timers.tick(20);
  port.feed(TYPE.PONG, Buffer.concat([ping.payload, u32(5000), u32(1), u32(2)]));
  assert.deepEqual(pong, { token: ping.payload.readUInt32LE(0), uptimeMs: 5000, badChunks: 1, seqGaps: 2, rttMs: 20 });
});

test('audio goes out only against credit, EOS on the last frame, and resolves on PLAYED', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(2500, 1));
  await settle();
  assert.deepEqual(audio(port), []);
  port.feed(TYPE.CREDIT, u32(1920));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0]]);
  port.feed(TYPE.CREDIT, u32(4000));
  await settle();
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [580, FLAG.EOS]]);
  assert.equal(link.credit, 4000 - 580);
  port.feed(TYPE.PLAYED, played(2500, 0));
  const p = await done;
  assert.equal(p.bytes, 2500);
  assert.equal(p.reason, 0);
});

test('when the S3 stops a reply, sending stops and an empty EOS closes the stream', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(9600));
  port.feed(TYPE.CREDIT, u32(1920));
  await settle();
  port.feed(TYPE.PLAYED, played(1920, 1));
  assert.equal((await done).reason, 1);
  assert.deepEqual(audio(port), [[960, 0], [960, 0], [0, FLAG.EOS]]);
});

test('stopping a reply sends STOP_AUDIO, then an empty EOS, and waits for PLAYED', async (t) => {
  const { port, link } = await readyLink(t);
  const ac = new AbortController();
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  port.feed(TYPE.CREDIT, u32(960));
  await settle();
  ac.abort();
  await settle();
  const tail = port.sent().slice(-2).map((f) => [f.type, f.payload.toString('hex'), f.flags]);
  assert.deepEqual(tail, [[TYPE.CMD, '03', 0], [TYPE.AUDIO_DOWN, '', FLAG.EOS]]);
  port.feed(TYPE.PLAYED, played(960, 1));
  assert.equal((await done).reason, 1);
});

test('stopping before any audio went out resolves at once and tells the S3 nothing', async (t) => {
  const { port, link } = await readyLink(t);
  const ac = new AbortController();
  const done = link.playAudio(Buffer.alloc(9600), { signal: ac.signal });
  ac.abort();
  assert.deepEqual(await done, { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 });
  assert.deepEqual(port.sent().map((f) => f.type), [TYPE.HELLO]);
});

test('the S3 restarting during a reply fails it, clears credit and shakes hands again', async (t) => {
  const { port, link } = await readyLink(t);
  const done = link.playAudio(Buffer.alloc(9600));
  port.feed(TYPE.CREDIT, u32(5000));
  await settle();
  const downs = [];
  link.on('down', (r) => downs.push(r));
  port.feed(TYPE.HELLO, helloWithNonce(0));
  await assert.rejects(done, /restarted/);
  assert.equal(link.credit, 0);
  assert.equal(link.ready, false);
  assert.deepEqual(downs, ['the S3 restarted']);
  assert.equal(port.sent().at(-1).type, TYPE.HELLO);
});

test('AUDIO_UP frames are passed on with their flags', async (t) => {
  const { port, link } = await readyLink(t);
  const got = [];
  link.on('audio-up', (f) => got.push([f.payload.length, f.flags]));
  port.feed(TYPE.AUDIO_UP, Buffer.alloc(640));
  port.feed(TYPE.AUDIO_UP, Buffer.alloc(0), FLAG.EOS);
  assert.deepEqual(got, [[640, 0], [0, FLAG.EOS]]);
});

test('counts gaps in the S3 sequence numbers', async (t) => {
  const { port, link } = await readyLink(t);
  port.feed(TYPE.LOG, Buffer.from('a'));
  port.emit('data', Buffer.from(encodeFrame({ type: TYPE.LOG, seq: 40, payload: Buffer.from('b') })));
  assert.equal(link.seqGaps, 1);
});

test('reopens the port after it closes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const ports = [];
  const link = new Link({ openPort: async () => ports[ports.push(new FakePort()) - 1], retryMs: 500, makeNonce: () => NONCE });
  t.after(() => link.close());
  await link.start();
  ports[0].feed(TYPE.HELLO, HELLO);
  const downs = [];
  link.on('down', (r) => downs.push(r));
  ports[0].emit('close');
  assert.deepEqual(downs, ['port closed']);
  t.mock.timers.tick(500);
  await settle();
  assert.equal(ports.length, 2);
  assert.equal(ports[1].sent()[0].type, TYPE.HELLO);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test bridge/test/link/link.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/link/link.js`.

- [ ] **Step 3: Write `bridge/src/link/link.js`**

```js
// The bridge's end of the USB link (protocol/frames.md). HELLO finds walkie, PING watches it,
// CREDIT paces AUDIO_DOWN, and PLAYED ends each reply.
import { randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CreditGate } from './credits.js';
import { FrameDecoder } from './decoder.js';
import { FLAG, TYPE, encodeFrame } from './frame.js';
import {
  CMD, TEST_OP, cmdPayload, helloPayload, parseCredit, parseHello, parsePlayed, parsePong, pingPayload, testPayload,
} from './messages.js';

const DOWN_FRAME = 960; // 20 ms at 24 kHz
const HELLO_EVERY_MS = 1000;
const PING_EVERY_MS = 1000;
const PONG_TIMEOUT_MS = 3000;
const PLAYED_GRACE_MS = 10_000;

export class Link extends EventEmitter {
  #openPort;
  #retryMs;
  #makeNonce;
  #nonce = 0;
  #port = null;
  #decoder = new FrameDecoder();
  #credits = new CreditGate();
  #seq = 0;
  #rxSeq = null;
  #gaps = 0;
  #ready = false;
  #closing = false;
  #openFailures = 0;
  #helloTimer = null;
  #pingTimer = null;
  #retryTimer = null;
  #lastPong = 0;
  #token = 0;
  #pingSent = new Map();
  #stream = null;

  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000) }) {
    super();
    this.#openPort = openPort;
    this.#retryMs = retryMs;
    this.#makeNonce = makeNonce;
  }

  get ready() {
    return this.#ready;
  }
  get credit() {
    return this.#credits.available;
  }
  get seqGaps() {
    return this.#gaps;
  }
  get badChunks() {
    return this.#decoder.bad;
  }

  async start() {
    this.#closing = false;
    await this.#connect();
  }

  close() {
    this.#closing = true;
    clearTimeout(this.#retryTimer);
    this.#stopTimers();
    this.#port?.close();
  }

  send(type, payload = Buffer.alloc(0), flags = 0) {
    if (!this.#port) return false;
    this.#port.write(encodeFrame({ type, flags, seq: this.#seq, payload }));
    this.#seq = (this.#seq + 1) & 0xffff;
    return true;
  }

  cmd(op, arg) {
    return this.send(TYPE.CMD, cmdPayload(op, arg));
  }

  testUpPattern(frames) {
    return this.send(TYPE.TEST, testPayload(TEST_OP.UP_PATTERN, frames));
  }

  // Sends one reply as AUDIO_DOWN under credit and resolves with the S3's PLAYED.
  async playAudio(pcm, { signal } = {}) {
    if (!this.#ready) throw new Error('the S3 is not connected');
    if (this.#stream) throw new Error('another reply is still playing');
    const stop = new AbortController();
    const stream = { stop, sent: 0, error: null };
    stream.played = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
    stream.played.catch(() => {}); // failures reach the caller through the await below
    this.#stream = stream;
    const onAbort = () => {
      if (stop.signal.aborted) return;
      stop.abort();
      if (stream.sent > 0) this.cmd(CMD.STOP_AUDIO); // the S3 answers with PLAYED, reason 1
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let timer;
    try {
      let eos = false;
      while (!eos && !stop.signal.aborted) {
        const n = Math.min(DOWN_FRAME, pcm.length - stream.sent);
        try {
          await this.#credits.acquire(n, stop.signal);
        } catch {
          break;
        }
        eos = stream.sent + n >= pcm.length;
        this.send(TYPE.AUDIO_DOWN, pcm.subarray(stream.sent, stream.sent + n), eos ? FLAG.EOS : 0);
        stream.sent += n;
      }
      if (stream.error) throw stream.error;
      if (!eos) {
        if (stream.sent === 0) return { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 };
        this.send(TYPE.AUDIO_DOWN, Buffer.alloc(0), FLAG.EOS); // ends the S3's discarding
      }
      timer = setTimeout(
        () => this.#failStream(new Error('the S3 never reported the end of playback')),
        Math.ceil(pcm.length / 48) + PLAYED_GRACE_MS,
      );
      return await stream.played;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.#stream === stream) this.#stream = null;
    }
  }

  async #connect() {
    if (this.#closing) return;
    let port;
    try {
      port = await this.#openPort();
    } catch (err) {
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
      return;
    }
    if (this.#closing) {
      port.close();
      return;
    }
    this.#openFailures = 0;
    this.#port = port;
    this.#decoder = new FrameDecoder();
    this.#rxSeq = null;
    port.on('data', (buf) => {
      for (const f of this.#decoder.push(buf)) this.#onFrame(f);
    });
    port.on('close', () => this.#onClose(port));
    port.on('error', (err) => this.emit('status', `port error: ${err.message}`));
    this.#startHello();
  }

  #onClose(port) {
    if (port !== this.#port) return;
    this.#port = null;
    const wasReady = this.#ready;
    this.#ready = false;
    this.#stopTimers();
    this.#credits.reset();
    this.#failStream(new Error('the S3 port closed'));
    if (wasReady && !this.#closing) this.emit('down', 'port closed');
    if (!this.#closing) this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
  }

  // A new handshake: a new nonce, HELLO now and once a second until the S3 answers it.
  #startHello() {
    this.#nonce = this.#makeNonce();
    clearInterval(this.#helloTimer);
    this.#sayHello();
    this.#helloTimer = setInterval(() => this.#sayHello(), HELLO_EVERY_MS);
  }

  #sayHello() {
    this.send(TYPE.HELLO, helloPayload(this.#nonce));
  }

  #onFrame(f) {
    if (f.type === TYPE.HELLO) {
      const hello = parseHello(f.payload);
      if (hello) this.#onDeviceHello(hello, f.seq);
      return;
    }
    if (!this.#ready) return; // left over from before walkie answered
    if (this.#rxSeq !== null && f.seq !== ((this.#rxSeq + 1) & 0xffff)) this.#gaps++;
    this.#rxSeq = f.seq;
    switch (f.type) {
      case TYPE.PONG:
        this.#onPong(parsePong(f.payload));
        break;
      case TYPE.CREDIT: {
        const c = parseCredit(f.payload);
        if (c) this.#credits.grant(c.bytes);
        break;
      }
      case TYPE.AUDIO_UP:
        this.emit('audio-up', f);
        break;
      case TYPE.PLAYED: {
        const p = parsePlayed(f.payload);
        if (p) this.#onPlayed(p);
        break;
      }
      case TYPE.LOG:
        this.emit('log', f.payload.toString('utf8'));
        break;
      default:
        this.emit('frame', f);
    }
  }

  #onDeviceHello(hello, seq) {
    if (hello.nonce === this.#nonce) {
      // An answer to this handshake: the S3 has just started the link over.
      const already = this.#ready;
      this.#ready = true;
      this.#rxSeq = seq;
      this.#gaps = 0;
      this.#credits.reset();
      this.#failStream(new Error('the S3 started the link over'));
      clearInterval(this.#helloTimer);
      this.#helloTimer = null;
      clearInterval(this.#pingTimer);
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      if (!already) this.emit('hello', hello);
      return;
    }
    if (hello.nonce === 0 && this.#ready) this.#lost('the S3 restarted'); // its boot HELLO
    // Anything else was queued before this bridge opened the port.
  }

  #ping() {
    if (Date.now() - this.#lastPong > PONG_TIMEOUT_MS) {
      this.#lost('no PONG for 3 s');
      return;
    }
    this.#token = (this.#token + 1) >>> 0;
    this.#pingSent.set(this.#token, Date.now());
    if (this.#pingSent.size > 8) this.#pingSent.delete(this.#pingSent.keys().next().value);
    this.send(TYPE.PING, pingPayload(this.#token));
  }

  #onPong(p) {
    if (!p) return;
    this.#lastPong = Date.now();
    const sent = this.#pingSent.get(p.token);
    this.#pingSent.delete(p.token);
    this.emit('pong', { ...p, rttMs: sent === undefined ? null : Date.now() - sent });
  }

  #onPlayed(p) {
    this.emit('played', p);
    const s = this.#stream;
    if (!s) return;
    if (p.reason === 1) s.stop.abort(); // the S3 stopped it: stop sending
    s.resolve(p);
  }

  #lost(reason) {
    this.#ready = false;
    this.#stopTimers();
    this.#credits.reset();
    this.#failStream(new Error(`lost the S3: ${reason}`));
    this.emit('down', reason);
    if (this.#port) this.#startHello();
  }

  #failStream(err) {
    const s = this.#stream;
    if (!s) return;
    s.error = err;
    s.stop.abort();
    s.reject(err);
  }

  #stopTimers() {
    clearInterval(this.#helloTimer);
    clearInterval(this.#pingTimer);
    this.#helloTimer = null;
    this.#pingTimer = null;
  }
}
```

- [ ] **Step 4: Write `bridge/src/link/serial.js`**

```js
// Finds the S3 by its USB IDs and opens it without resetting it. With hupcl and rtscts off, Windows keeps
// DTR and RTS low; on the ESP32-S3's USB-Serial-JTAG a raised RTS holds the chip in reset.
import { SerialPort } from 'serialport';

export const S3_USB = Object.freeze({ vendorId: '303a', productId: '1001' });

export async function findS3Port() {
  const ports = await SerialPort.list();
  const hit = ports.find(
    (p) => p.vendorId?.toLowerCase() === S3_USB.vendorId && p.productId?.toLowerCase() === S3_USB.productId,
  );
  return hit ? hit.path : null;
}

export function openS3Port(path) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate: 115200, hupcl: false, rtscts: false, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `node --test bridge/test/link/link.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 6: Run the whole bridge suite**

Run: `npm --prefix bridge test`
Expected: PASS, 33 tests.

- [ ] **Step 7: Commit**

```bash
git add bridge/src/link/link.js bridge/src/link/serial.js bridge/test/link/link.test.js
git commit -m "Bridge: Link with HELLO, PING, credit-paced replies and reconnecting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Firmware link tasks and the dev CLI

**Files:**
- Create: `firmware/src/status.h`
- Create: `firmware/src/usblink.h`, `firmware/src/usblink.cpp`
- Modify (replace): `firmware/src/main.cpp`
- Create: `bridge/src/dev/connect.js`, `bridge/src/dev/ping.js`, `bridge/src/dev/cmd.js`, `bridge/src/dev/term.js`
- Create: `bridge/bin/walkie-dev.js`

**Interfaces:**
- Consumes: `proto::*` (Tasks 5 and 6); `Link`, `findS3Port`, `openS3Port` (Task 9); `CMD` (Task 3).
- Produces:
  - `struct Status` and `g_status` (atomics: `rxBad, rxGaps, txDropped, volume (255), micGain (4), takes, lastTakeMs, playing, ringFill, underruns`)
  - `usblink::Handlers { onHello(), onAudioDown(pcm, len, eos), onCommand(op, arg), onTest(op, frames), idle(), ringBytes }`; every callback runs on the RX task and may be null
  - `usblink::begin(const Handlers&)`, `usblink::send(type, flags, payload, len) → bool` (never blocks), `usblink::logf(fmt, ...)`, `usblink::msSincePing()`
  - dev CLI `node bridge/bin/walkie-dev.js ping [n] | cmd … | term [text] [--secs n]`, with `--port COMx` on any command; `connect(opts) → Promise<Link>` (ready, HELLO printed), `withTimeout(promise, ms, message)`, `portOpener(path?)`

- [ ] **Step 1: Write `firmware/src/status.h`**

```cpp
// status.h: counters and settings shared between tasks; the screen shows them.
#pragma once
#include <atomic>
#include <stdint.h>

struct Status {
  std::atomic<uint32_t> rxBad{0};      // bad chunks from the PC
  std::atomic<uint32_t> rxGaps{0};     // gaps in the PC's seq since its last HELLO
  std::atomic<uint32_t> txDropped{0};  // frames the TX queue had no room for
  std::atomic<uint8_t> volume{255};    // speaker volume (spec D9)
  std::atomic<uint8_t> micGain{4};     // mic magnification (spec §6.2)
  std::atomic<uint32_t> takes{0};
  std::atomic<uint32_t> lastTakeMs{0};
  std::atomic<bool> playing{false};
  std::atomic<uint32_t> ringFill{0};
  std::atomic<uint32_t> underruns{0};
};

extern Status g_status;
```

- [ ] **Step 2: Write `firmware/src/usblink.h`**

```cpp
// usblink.h: the S3's end of the USB link (protocol/frames.md). The RX task decodes frames and
// dispatches them; the TX task is the only writer to USB.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace usblink {
// Called from the RX task. Any of them may be null.
struct Handlers {
  void (*onHello)();                                        // the bridge (re)connected
  void (*onAudioDown)(const uint8_t* pcm, size_t len, bool eos);
  void (*onCommand)(uint8_t op, uint8_t arg);
  void (*onTest)(uint8_t op, uint16_t frames);
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for USB and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// Milliseconds since the bridge's last PING, or UINT32_MAX before the first.
uint32_t msSincePing();
}  // namespace usblink
```

- [ ] **Step 3: Write `firmware/src/usblink.cpp`**

```cpp
// usblink.cpp: see usblink.h.
#include "usblink.h"
#include <Arduino.h>
#include <atomic>
#include <freertos/ringbuf.h>
#include <stdarg.h>
#include <stdio.h>
#include "proto/frame.h"
#include "proto/messages.h"
#include "status.h"
#include "version.h"

namespace usblink {
namespace {
const size_t RX_QUEUE = 16384;  // the USB driver drops bytes beyond this; credit keeps audio below it
const size_t TX_RING = 32768;   // encoded frames waiting for USB
const size_t RX_READ = 1024;
Handlers handlers;
RingbufHandle_t txRing = nullptr;
SemaphoreHandle_t txLock = nullptr;
uint16_t txSeq = 0;               // under txLock
proto::FrameDecoder decoder;      // RX task only
bool haveRxSeq = false;           // RX task only
uint16_t rxSeq = 0;               // RX task only
std::atomic<uint32_t> lastPing{0};

// nonce: the one from the bridge's HELLO being answered, or 0 at boot.
void sayHello(uint32_t nonce) {
  uint8_t p[48];
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, WALKIE_VERSION, p, sizeof p);
  send(proto::T_HELLO, 0, p, (uint16_t)n);
}

void onFrame(const proto::Frame& f) {
  if (f.type == proto::T_HELLO) {
    uint32_t nonce = 0;
    if (!proto::parseHello(f.payload, f.len, nonce)) return;
    haveRxSeq = true;
    rxSeq = f.seq;
    g_status.rxGaps = 0;
    if (handlers.onHello) handlers.onHello();
    sayHello(nonce);
    return;
  }
  if (haveRxSeq && f.seq != (uint16_t)(rxSeq + 1)) g_status.rxGaps++;
  haveRxSeq = true;
  rxSeq = f.seq;
  switch (f.type) {
    case proto::T_PING: {
      uint32_t token;
      if (!proto::parsePing(f.payload, f.len, token)) return;
      uint32_t now = millis();
      lastPing = now ? now : 1;
      uint8_t p[16];
      size_t n = proto::buildPong(token, now, decoder.bad(), g_status.rxGaps, p, sizeof p);
      send(proto::T_PONG, 0, p, (uint16_t)n);
      return;
    }
    case proto::T_AUDIO_DOWN:
      if (handlers.onAudioDown) handlers.onAudioDown(f.payload, f.len, (f.flags & proto::F_EOS) != 0);
      return;
    case proto::T_CMD: {
      proto::Command c;
      if (proto::parseCmd(f.payload, f.len, c) && handlers.onCommand) handlers.onCommand(c.op, c.arg);
      return;
    }
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.frames);
      return;
    }
    default:
      return;
  }
}

void rxTask(void*) {
  static uint8_t buf[RX_READ];
  for (;;) {
    int avail = Serial.available();
    if (avail > 0) {
      size_t n = Serial.read(buf, (size_t)avail < RX_READ ? (size_t)avail : RX_READ);
      if (n <= RX_READ) decoder.push(buf, n, onFrame);
      g_status.rxBad = decoder.bad();
    }
    if (handlers.idle) handlers.idle();
    vTaskDelay(1);  // always: a busy link must not starve core 0's idle task (task watchdog)
  }
}

void txTask(void*) {
  for (;;) {
    size_t n = 0;
    uint8_t* item = (uint8_t*)xRingbufferReceive(txRing, &n, portMAX_DELAY);
    if (!item) continue;
    for (size_t off = 0; off < n;) {
      size_t w = Serial.write(item + off, n - off);
      if (w == 0) break;  // nobody is reading the port: the rest of this frame is lost
      off += w;
    }
    vRingbufferReturnItem(txRing, item);
  }
}
}  // namespace

void begin(const Handlers& h) {
  handlers = h;
  Serial.setRxBufferSize(RX_QUEUE);  // both before begin(), or they do not take effect
  Serial.setTxBufferSize(4096);
  Serial.begin(115200);
  txRing = xRingbufferCreate(TX_RING, RINGBUF_TYPE_NOSPLIT);
  txLock = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(txTask, "linkTx", 4096, nullptr, 4, nullptr, 0);
  xTaskCreatePinnedToCore(rxTask, "linkRx", 6144, nullptr, 5, nullptr, 0);
  sayHello(0);  // tells a bridge that is already connected that walkie has (re)started
}

bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  static uint8_t wire[proto::MAX_WIRE];  // under txLock
  if (!txRing) return false;
  xSemaphoreTake(txLock, portMAX_DELAY);
  size_t n = proto::encodeFrame(type, flags, txSeq++, payload, len, wire, sizeof wire);
  bool ok = n > 0 && xRingbufferSend(txRing, wire, n, 0) == pdTRUE;
  xSemaphoreGive(txLock);
  if (!ok) g_status.txDropped++;
  return ok;
}

void logf(const char* fmt, ...) {
  char text[201];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(text, sizeof text, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if (n >= (int)sizeof text) n = sizeof text - 1;
  send(proto::T_LOG, 0, (const uint8_t*)text, (uint16_t)n);
}

uint32_t msSincePing() {
  uint32_t t = lastPing.load();
  return t ? millis() - t : UINT32_MAX;
}
}  // namespace usblink
```

- [ ] **Step 4: Replace `firmware/src/main.cpp`**

```cpp
// walkie firmware for the M5StickS3. It runs from app1; on-the-beat keeps app0 (spec §6.7).
#include <M5Unified.h>
#include <esp_ota_ops.h>
#include "proto/messages.h"
#include "status.h"
#include "usblink.h"
#include "version.h"

Status g_status;

namespace {
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
void command(uint8_t op, uint8_t arg) {
  switch (op) {
    case proto::CMD_SET_VOLUME:
      g_status.volume = arg;
      usblink::logf("volume %u", arg);
      break;
    case proto::CMD_SET_MIC_GAIN:
      g_status.micGain = arg ? arg : 1;
      usblink::logf("mic gain %u from the next take", (unsigned)g_status.micGain.load());
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

void render() {
  static char shown[320];
  char text[320];
  snprintf(text, sizeof text,
           "walkie %s  电量 %d%%\n"
           "电脑 %s\n"
           "录音 %u 段  上一段 %.1f 秒\n"
           "播放 %s  缓冲 %u KB  欠载 %u\n"
           "坏帧 %u  断号 %u  丢帧 %u\n"
           "麦克风 %u  音量 %u",
           WALKIE_VERSION, (int)M5.Power.getBatteryLevel(), usblink::msSincePing() < 3000 ? "已连接" : "未连接",
           (unsigned)g_status.takes, g_status.lastTakeMs / 1000.0, g_status.playing ? "中" : "停",
           (unsigned)(g_status.ringFill / 1024), (unsigned)g_status.underruns, (unsigned)g_status.rxBad,
           (unsigned)g_status.rxGaps, (unsigned)g_status.txDropped, (unsigned)g_status.micGain,
           (unsigned)g_status.volume);
  if (strcmp(text, shown) == 0) return;
  strcpy(shown, text);
  M5.Display.startWrite();
  M5.Display.fillScreen(TFT_BLACK);
  M5.Display.setCursor(0, 2);
  M5.Display.print(text);
  M5.Display.endWrite();
}
}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.output_power = false;  // the StickS3 does not charge with the PM1 boost on
  M5.begin(cfg);
  esp_ota_mark_app_valid_cancel_rollback();
  M5.Display.setRotation(3);
  M5.Display.setFont(&fonts::efontCN_16);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  usblink::Handlers h = {};
  h.onCommand = command;
  usblink::begin(h);
}

void loop() {
  static uint32_t lastDraw = 0;
  M5.update();
  if (millis() - lastDraw >= 250) {
    lastDraw = millis();
    render();
  }
  delay(10);
}
```

- [ ] **Step 5: Write `bridge/src/dev/connect.js`**

```js
// Shared by the dev commands: find and open the S3, and wait for walkie's HELLO.
import { Link } from '../link/link.js';
import { findS3Port, openS3Port } from '../link/serial.js';

export function portOpener(portPath) {
  return async () => {
    const path = portPath ?? (await findS3Port());
    if (!path) throw new Error('no S3 on USB (303A:1001)');
    return openS3Port(path);
  };
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function connect(opts) {
  const link = new Link({ openPort: portOpener(opts.port) });
  link.on('status', (s) => console.log(`[link] ${s}`));
  link.on('log', (s) => console.log(`[S3] ${s}`));
  link.on('down', (r) => console.log(`[link] down: ${r}`));
  const hello = new Promise((resolve) => link.once('hello', resolve));
  await link.start();
  const h = await withTimeout(hello, 5000, 'no HELLO from walkie within 5 s. Is the S3 running walkie? (node tools/boot.mjs app1)');
  console.log(`[link] walkie ${h.version}: up ${(h.uptimeMs / 1000).toFixed(1)} s, ring ${h.ringBytes} bytes, ${h.upRate}/${h.downRate} Hz`);
  return link;
}
```

- [ ] **Step 6: Write `bridge/src/dev/ping.js`, `cmd.js` and `term.js`**

`ping.js`:

```js
// Says HELLO, then prints n PONGs: round trip, the S3's uptime, and both ends' link counters.
import { connect, withTimeout } from './connect.js';

export default async function ping([n = '5'], opts) {
  const link = await connect(opts);
  for (let i = 0; i < Number(n); i++) {
    const p = await withTimeout(new Promise((r) => link.once('pong', r)), 3000, 'no PONG within 3 s');
    console.log(`pong: ${p.rttMs} ms round trip, S3 up ${(p.uptimeMs / 1000).toFixed(1)} s, S3 saw ${p.badChunks} bad chunks and ${p.seqGaps} gaps`);
  }
  console.log(`bridge saw ${link.badChunks} bad chunks and ${link.seqGaps} gaps`);
  link.close();
}
```

`cmd.js`:

```js
// Sends one CMD and prints the S3's LOG answer.
import { CMD } from '../link/messages.js';
import { connect } from './connect.js';

const OPS = { vol: CMD.SET_VOLUME, gain: CMD.SET_MIC_GAIN, stop: CMD.STOP_AUDIO, 'boot-app0': CMD.BOOT_APP0, reboot: CMD.REBOOT };

export default async function cmd([name, value], opts) {
  if (!(name in OPS)) throw new Error('cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot');
  const link = await connect(opts);
  link.cmd(OPS[name], value === undefined ? undefined : Number(value));
  await new Promise((r) => setTimeout(r, 600));
  link.close();
}
```

`term.js`:

```js
// A plain-text console that does not reset the S3: sends one line and prints what comes back.
// For on-the-beat's console; walkie itself only speaks frames.
import { findS3Port, openS3Port } from '../link/serial.js';

export default async function term(words, opts) {
  const path = opts.port ?? (await findS3Port());
  if (!path) throw new Error('no S3 on USB (303A:1001)');
  const port = await openS3Port(path);
  port.on('data', (b) => process.stdout.write(b.toString('utf8')));
  if (words.length > 0) port.write(`${words.join(' ')}\n`);
  await new Promise((r) => setTimeout(r, Number(opts.secs ?? 3) * 1000));
  await new Promise((r) => port.close(r));
}
```

- [ ] **Step 7: Write `bridge/bin/walkie-dev.js`**

```js
#!/usr/bin/env node
// Developer commands for the S3 link.
const USAGE = `usage: node bridge/bin/walkie-dev.js <command> [args] [--port COMx]
  ping [n]                 say HELLO, then show n PONGs (default 5)
  cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot
  term [text] [--secs n]   plain-text console without resetting the S3 (for on-the-beat)`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
  cmd: () => import('../src/dev/cmd.js'),
  term: () => import('../src/dev/term.js'),
};

const argv = process.argv.slice(2);
const opts = {};
for (const flag of ['--port', '--secs', '--out']) {
  const i = argv.indexOf(flag);
  if (i >= 0) opts[flag.slice(2)] = argv.splice(i, 2)[1];
}
const [name, ...args] = argv;
if (!commands[name]) {
  console.log(USAGE);
  process.exit(name ? 2 : 0);
}
const { default: run } = await commands[name]();
try {
  await run(args, opts);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
process.exit();
```

- [ ] **Step 8: Flash**

Run: `node tools/flash.mjs`
Expected: `SUCCESS` from the build, then `walkie (N bytes) is in app1 and selected; the S3 is restarting into it.`

- [ ] **Step 9: Ping the S3**

Run: `node bridge/bin/walkie-dev.js ping 5`
Expected: `[link] walkie 0.1.0: up … s, ring 0 bytes, 16000/24000 Hz`, then five `pong:` lines with round trips under 20 ms and `S3 saw 0 bad chunks and 0 gaps`, then `bridge saw … bad chunks and 0 gaps`. The bridge may count a bad chunk or two from text the S3 printed before the bridge connected; that is expected.

- [ ] **Step 10: Show that opening the port never resets the S3**

Run `node bridge/bin/walkie-dev.js ping 2` three times, a few seconds apart.
Expected: the uptime in the `[link] walkie` and `pong:` lines keeps growing from run to run and never drops back towards 0. His screen shows 「电脑 已连接」 while a command runs and 「电脑 未连接」 3 s after it ends.

- [ ] **Step 11: Commands**

Run: `node bridge/bin/walkie-dev.js cmd vol 200`, then `node bridge/bin/walkie-dev.js cmd gain 6`
Expected: `[S3] volume 200`, then `[S3] mic gain 6 from the next take`; the screen shows 「麦克风 6  音量 200」.

Run: `node bridge/bin/walkie-dev.js cmd reboot`, then `node bridge/bin/walkie-dev.js ping 1`
Expected: `[S3] rebooting`; then a PONG with an uptime of a few seconds, and the screen back at 「麦克风 4  音量 255」.

- [ ] **Step 12: Back to on-the-beat by command, and return**

Run: `node bridge/bin/walkie-dev.js cmd boot-app0`
Expected: `[S3] boot app0: ESP_OK`.

Run: `node bridge/bin/walkie-dev.js term show --secs 3`
Expected: on-the-beat's status lines, including `relay` and `battery`.

Run: `node tools/boot.mjs app1`, then `node bridge/bin/walkie-dev.js ping 1`
Expected: a PONG from walkie 0.1.0.

- [ ] **Step 13: Commit**

```bash
git add firmware/src bridge/src/dev bridge/bin
git commit -m "Firmware link tasks, and a dev CLI to ping, command and switch the S3" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Uplink: the talk key and the test pattern

**Files:**
- Create: `firmware/src/audio.h`, `firmware/src/audio.cpp`
- Modify: `firmware/src/main.cpp` (include, `test()`, `setup()`, `loop()`)
- Create: `bridge/src/dev/listen.js`, `bridge/src/dev/loopback.js`
- Modify: `bridge/bin/walkie-dev.js` (`USAGE`, `commands`)

**Interfaces:**
- Consumes: `usblink::send`, `g_status` (Task 10); `proto::patternSample`, `T_AUDIO_UP`, `F_EOS` (Tasks 5 and 6); `TakeCollector`, `encodeWav`, `levels` (Task 4); `patternBytes` (Task 3); `connect`, `withTimeout` (Task 10).
- Produces:
  - `audio::begin()`, `audio::setTalk(bool held)` (UI loop), `audio::requestPattern(uint16_t frames)` (RX task). Task 12 replaces `audio.h` and `audio.cpp`.
  - dev commands `listen [--out dir]` (default `bridge/takes/`) and `loopback [up|all]`; Task 12 adds `down` and `stop`.

- [ ] **Step 1: Write `firmware/src/audio.h`**

```cpp
// audio.h: the audio task. It owns the mic; talk-key takes and test patterns go up as AUDIO_UP.
#pragma once
#include <stdint.h>

namespace audio {
void begin();                          // sets up the mic and starts the task
void setTalk(bool held);               // UI loop: the talk key's state
void requestPattern(uint16_t frames);  // RX task: TEST UP_PATTERN
}  // namespace audio
```

- [ ] **Step 2: Write `firmware/src/audio.cpp`**

```cpp
// audio.cpp: the audio task. Talk-key takes and TEST patterns go up as AUDIO_UP frames of 20 ms.
#include "audio.h"
#include <Arduino.h>
#include <M5Unified.h>
#include <atomic>
#include "proto/frame.h"
#include "proto/pattern.h"
#include "status.h"
#include "usblink.h"

namespace audio {
namespace {
const uint32_t UP_RATE = 16000;
const size_t UP_SAMPLES = 320;  // 20 ms
const int UP_BUFS = 4;          // two queued with M5.Mic, the others being sent or free
int16_t upBuf[UP_BUFS][UP_SAMPLES];
std::atomic<bool> talkHeld{false};
std::atomic<uint16_t> patternFrames{0};

void sendUp(const int16_t* pcm, size_t samples, bool eos) {
  usblink::send(proto::T_AUDIO_UP, eos ? proto::F_EOS : 0, (const uint8_t*)pcm, (uint16_t)(samples * 2));
}

// Streams the mic while the talk key is held. Two requests stay queued with M5.Mic; record() waits for
// a free slot, so when it returns the older request is full and that buffer goes to the bridge.
void talk() {
  M5.Speaker.end();  // mic and speaker share the codec
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  M5.Mic.begin();
  uint32_t t0 = millis();
  M5.Mic.record(upBuf[0], UP_SAMPLES, UP_RATE);
  M5.Mic.record(upBuf[1], UP_SAMPLES, UP_RATE);
  int oldest = 0;
  while (talkHeld.load()) {
    M5.Mic.record(upBuf[(oldest + 2) % UP_BUFS], UP_SAMPLES, UP_RATE);
    sendUp(upBuf[oldest], UP_SAMPLES, false);
    oldest = (oldest + 1) % UP_BUFS;
  }
  uint32_t w0 = millis();
  while (M5.Mic.isRecording() && millis() - w0 < 200) vTaskDelay(1);
  sendUp(upBuf[oldest], UP_SAMPLES, false);
  sendUp(upBuf[(oldest + 1) % UP_BUFS], UP_SAMPLES, true);
  M5.Mic.end();
  g_status.takes++;
  g_status.lastTakeMs = millis() - t0;
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
    if (talkHeld.load()) {
      talk();
      continue;
    }
    uint16_t n = patternFrames.exchange(0);
    if (n) {
      pattern(n);
      continue;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
}  // namespace

void begin() {
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  xTaskCreatePinnedToCore(task, "audio", 8192, nullptr, 3, nullptr, 1);
}

void setTalk(bool held) { talkHeld.store(held); }

void requestPattern(uint16_t frames) {
  if (frames) patternFrames.store(frames);
}
}  // namespace audio
```

- [ ] **Step 3: Wire the audio task into `firmware/src/main.cpp`**

Add the include after `#include <esp_ota_ops.h>`:

```cpp
#include "audio.h"
```

Add this function inside the anonymous namespace, after `command()`:

```cpp
// Runs on the link RX task.
void test(uint8_t op, uint16_t frames) {
  if (op == proto::TEST_UP_PATTERN) audio::requestPattern(frames);
  else usblink::logf("test %u is not handled", op);
}
```

In `setup()`, replace the last three lines

```cpp
  usblink::Handlers h = {};
  h.onCommand = command;
  usblink::begin(h);
```

with

```cpp
  usblink::Handlers h = {};
  h.onCommand = command;
  h.onTest = test;
  usblink::begin(h);
  audio::begin();
```

In `loop()`, add this line right after `M5.update();`:

```cpp
  audio::setTalk(M5.BtnA.isPressed());
```

- [ ] **Step 4: Write `bridge/src/dev/listen.js`**

```js
// Saves every talk-key take as a 16 kHz WAV and prints its levels, the first 250 ms (the mic's start-up
// transient) left out of them. Runs until Ctrl+C.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TakeCollector } from '../audio/takes.js';
import { encodeWav, levels } from '../audio/wav.js';
import { connect } from './connect.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../takes/', import.meta.url));

export default async function listen(args, opts) {
  const dir = path.resolve(opts.out ?? DEFAULT_DIR);
  mkdirSync(dir, { recursive: true });
  const link = await connect(opts);
  const takes = new TakeCollector();
  let count = 0;
  link.on('hello', () => takes.reset());
  link.on('audio-up', (f) => {
    const pcm = takes.push(f);
    if (!pcm) return;
    const file = path.join(dir, `take-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
    writeFileSync(file, encodeWav(pcm, 16000));
    const l = levels(pcm, 16000, 250);
    console.log(`take ${++count}: ${(l.durationMs / 1000).toFixed(2)} s, peak ${l.peak} (${Math.round((l.peak / 32768) * 100)}% of full scale), rms ${l.rms}, clipped ${l.clippedPct.toFixed(2)}% -> ${file}`);
  });
  console.log('Hold the front key and talk. Ctrl+C to stop.');
  await new Promise(() => {});
}
```

- [ ] **Step 5: Write `bridge/src/dev/loopback.js`**

```js
// Proves the link loses nothing.
//   up: the S3 sends a 5 s take of the test pattern; every byte is compared.
import { TakeCollector } from '../audio/takes.js';
import { patternBytes } from '../link/pattern.js';
import { connect, withTimeout } from './connect.js';

export default async function loopback([which = 'all'], opts) {
  const checks = {
    up: (link) => up(link),
  };
  const names = which === 'all' ? Object.keys(checks) : [which];
  for (const name of names) {
    if (!checks[name]) throw new Error(`loopback ${name}? Use ${Object.keys(checks).join(', ')} or all.`);
  }
  const link = await connect(opts);
  let ok = true;
  for (const name of names) ok = (await checks[name](link)) && ok;
  link.close();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
}

async function up(link, frames = 250) {
  const takes = new TakeCollector();
  let first = 0;
  let last = 0;
  const take = new Promise((resolve) => {
    const onFrame = (f) => {
      last = Date.now();
      if (!first) first = last;
      const pcm = takes.push(f);
      if (!pcm) return;
      link.off('audio-up', onFrame);
      resolve(pcm);
    };
    link.on('audio-up', onFrame);
  });
  link.testUpPattern(frames);
  const pcm = await withTimeout(take, frames * 20 + 5000, 'the pattern take did not arrive');
  const want = patternBytes(0, frames * 320);
  const same = pcm.equals(want);
  console.log(`up: ${pcm.length} of ${want.length} bytes, ${same ? 'identical' : 'DIFFERENT'}; ${frames} frames arrived over ${((last - first) / 1000).toFixed(2)} s (sent over ${((frames - 1) * 0.02).toFixed(2)} s)`);
  return same;
}
```

- [ ] **Step 6: Add the commands to `bridge/bin/walkie-dev.js`**

Replace the `USAGE` constant with:

```js
const USAGE = `usage: node bridge/bin/walkie-dev.js <command> [args] [--port COMx]
  ping [n]                 say HELLO, then show n PONGs (default 5)
  cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot
  term [text] [--secs n]   plain-text console without resetting the S3 (for on-the-beat)
  listen [--out dir]       save each talk-key take as a WAV and print its levels
  loopback [up|all]        check that the link loses nothing`;
```

and the `commands` object with:

```js
const commands = {
  ping: () => import('../src/dev/ping.js'),
  cmd: () => import('../src/dev/cmd.js'),
  term: () => import('../src/dev/term.js'),
  listen: () => import('../src/dev/listen.js'),
  loopback: () => import('../src/dev/loopback.js'),
};
```

- [ ] **Step 7: Flash, then check the uplink loses nothing**

Run: `node tools/flash.mjs`, then `node bridge/bin/walkie-dev.js loopback up`
Expected: `up: 160000 of 160000 bytes, identical; 250 frames arrived over 4.9x s (sent over 4.98 s)`, then `PASS`.

- [ ] **Step 8: A real take (needs him)**

Run: `node bridge/bin/walkie-dev.js listen`. He holds the front key, says a sentence and lets go.
Expected: one line `take 1: … s, peak … (…% of full scale), rms …, clipped …% -> …\bridge\takes\take-….wav`, and 「录音 1 段」 on the screen. The WAV plays back as his voice in any player. End with Ctrl+C.

- [ ] **Step 9: Commit**

```bash
git add firmware/src bridge/src/dev bridge/bin
git commit -m "Uplink: talk-key takes and the test pattern reach the PC intact" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Downlink: the playback ring, credit, PLAYED and stopping

**Files:**
- Modify (replace): `firmware/src/audio.h`, `firmware/src/audio.cpp`
- Modify: `firmware/src/main.cpp` (`command()`, `setup()`)
- Create: `bridge/src/audio/tone.js`
- Test: `bridge/test/audio/tone.test.js`
- Create: `bridge/src/dev/play.js`
- Modify (replace): `bridge/src/dev/loopback.js`
- Modify: `bridge/bin/walkie-dev.js` (`USAGE`, `commands`)

**Interfaces:**
- Consumes: `proto::ByteRing`, `CreditLedger`, `crc32Update`, `buildCredit`, `buildPlayed` (Tasks 5 and 6); `usblink::*` (Task 10); `Link.playAudio` (Task 9).
- Produces:
  - `audio::RING_BYTES` (2 MiB), `bool audio::begin()` (false without PSRAM for the ring), `audio::setTalk`, `audio::requestPattern`, and for the RX task `audio::onHello()`, `audio::onAudioDown(pcm, len, eos)`, `audio::stopFromPc()`, `audio::rxIdle()`
  - `tone(hz, secs, amplitude = 2000, rate = 24000): Buffer`
  - dev commands `play <file>`, `play tone <hz> <secs>`, `loopback [up|down|stop|all] [secs]`

- [ ] **Step 1: Write the failing test `bridge/test/audio/tone.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tone } from '../../src/audio/tone.js';
import { levels } from '../../src/audio/wav.js';

test('a tone has the requested length and amplitude', () => {
  const pcm = tone(440, 0.5, 2000);
  assert.equal(pcm.length, 24000);
  const l = levels(pcm, 24000);
  assert.equal(l.durationMs, 500);
  assert.ok(l.peak >= 1990 && l.peak <= 2000, `peak ${l.peak}`);
  assert.ok(Math.abs(l.rms - 1414) <= 5, `rms ${l.rms}`);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test bridge/test/audio/tone.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/audio/tone.js`.

- [ ] **Step 3: Write `bridge/src/audio/tone.js`**

```js
// A sine tone as PCM16 mono, for playback tests.
export function tone(hz, secs, amplitude = 2000, rate = 24000) {
  const n = Math.round(rate * secs);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test bridge/test/audio/tone.test.js`
Expected: PASS, 1 test.

- [ ] **Step 5: Replace `firmware/src/audio.h`**

```cpp
// audio.h: the audio task owns the mic and the speaker, which share the codec, so one runs at a time.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace audio {
const uint32_t RING_BYTES = 1u << 21;  // 2 MiB of PSRAM: 43.7 s at 24 kHz (the spec asks for 30 s or more)

bool begin();                          // false when PSRAM for the playback ring is missing
void setTalk(bool held);               // UI loop: the talk key's state
void requestPattern(uint16_t frames);  // RX task: TEST UP_PATTERN

// RX task, for replies:
void onHello();                        // the bridge (re)connected: drop any reply, start credit over
void onAudioDown(const uint8_t* pcm, size_t len, bool eos);
void stopFromPc();                     // CMD STOP_AUDIO
void rxIdle();                         // grants credit, carries out stops the audio task asks for
}  // namespace audio
```

- [ ] **Step 6: Replace `firmware/src/audio.cpp`**

```cpp
// audio.cpp: the audio task. Mic and speaker share the ES8311 codec, so one task runs them in turn:
// talk-key takes and TEST patterns go up as AUDIO_UP, and replies play from a PSRAM ring that the
// link RX task fills from AUDIO_DOWN under credit (protocol/frames.md).
#include "audio.h"
#include <Arduino.h>
#include <M5Unified.h>
#include <atomic>
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
std::atomic<bool> talkHeld{false};
std::atomic<uint16_t> patternFrames{0};

// Downlink: the RX task writes the ring; this task reads it into 100 ms speaker requests.
const uint32_t DOWN_RATE = 24000;
const uint32_t START_BYTES = 14400;  // 300 ms buffered before playing, unless the reply has ended
const size_t CHUNK_SAMPLES = 2400;   // 100 ms per playRaw request
const int CHUNKS = 4;                // M5.Speaker queues two, so a chunk is never refilled while queued
const uint8_t SPK_CH = 0;
int16_t chunk[CHUNKS][CHUNK_SAMPLES];
proto::ByteRing ring;
proto::CreditLedger ledger(12288, 1920);  // window below the 16,384-byte USB receive queue

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

void sendUp(const int16_t* pcm, size_t samples, bool eos) {
  usblink::send(proto::T_AUDIO_UP, eos ? proto::F_EOS : 0, (const uint8_t*)pcm, (uint16_t)(samples * 2));
}

void sendPlayed(uint8_t reason) {
  stats.reason = reason;
  uint8_t p[17];
  size_t n = proto::buildPlayed(stats, p, sizeof p);
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
  M5.Speaker.begin();
  M5.Speaker.setVolume(g_status.volume.load());
  speakerOn = true;
}

void endReply() {
  active = false;
  buffering = true;
  starving = false;
  stats = proto::Played();
  g_status.playing = false;
  g_status.ringFill = 0;
}

// RX task: stop the reply. The audio task empties the ring and reports it.
void stopStream(uint8_t how) {
  flushOpen.store(streamOpen);
  discarding = how == FLUSH_STOP && streamOpen;
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
  if (how == FLUSH_STOP && started) sendPlayed(proto::PLAYED_STOPPED);
  endReply();
  flush.store(FLUSH_NONE);
}

void playStep() {
  uint32_t avail = ring.size();
  bool eos = eosReceived.load();
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
    uint32_t n = ring.size();
    if (n == 0 || (n < CHUNK_SAMPLES * 2 && !eosReceived.load())) break;
    if (n > CHUNK_SAMPLES * 2) n = CHUNK_SAMPLES * 2;
    uint8_t* dst = (uint8_t*)chunk[nextChunk];
    ring.read(dst, n);
    stats.bytes += n;
    stats.crc32 = proto::crc32Update(stats.crc32, dst, n);
    M5.Speaker.playRaw(chunk[nextChunk], n / 2, DOWN_RATE, false, 1, SPK_CH, false);
    nextChunk = (nextChunk + 1) % CHUNKS;
    starving = false;
  }
  bool empty = ring.size() == 0;
  bool idle = !speakerOn || M5.Speaker.isPlaying(SPK_CH) == 0;
  if (empty && idle && eosReceived.load()) {  // played to the end
    sendPlayed(proto::PLAYED_FINISHED);
    speakerOff();
    eosReceived.store(false);
    endReply();
  } else if (empty && idle && !starving) {  // ran dry before the end: buffer 300 ms again
    starving = true;
    buffering = true;
    stats.underruns++;
    g_status.underruns++;
  }
}

// Streams the mic while the talk key is held; a reply that is playing stops first.
void talk() {
  if (active || speakerOn || ring.size() > 0) {
    stopWanted.store(true);
    uint32_t t0 = millis();
    while (flush.load() == FLUSH_NONE && millis() - t0 < 50) vTaskDelay(1);  // the RX task turns it into a stop
    handleFlush();
  }
  speakerOff();
  auto mc = M5.Mic.config();
  mc.magnification = g_status.micGain.load();
  M5.Mic.config(mc);
  M5.Mic.begin();
  uint32_t t0 = millis();
  M5.Mic.record(upBuf[0], UP_SAMPLES, UP_RATE);
  M5.Mic.record(upBuf[1], UP_SAMPLES, UP_RATE);
  int oldest = 0;
  while (talkHeld.load()) {
    M5.Mic.record(upBuf[(oldest + 2) % UP_BUFS], UP_SAMPLES, UP_RATE);  // returns once upBuf[oldest] is full
    sendUp(upBuf[oldest], UP_SAMPLES, false);
    oldest = (oldest + 1) % UP_BUFS;
  }
  uint32_t w0 = millis();
  while (M5.Mic.isRecording() && millis() - w0 < 200) vTaskDelay(1);
  sendUp(upBuf[oldest], UP_SAMPLES, false);
  sendUp(upBuf[(oldest + 1) % UP_BUFS], UP_SAMPLES, true);
  M5.Mic.end();
  g_status.takes++;
  g_status.lastTakeMs = millis() - t0;
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
    if (talkHeld.load()) {
      talk();
      continue;
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
  xTaskCreatePinnedToCore(task, "audio", 8192, nullptr, 3, nullptr, 1);
  return mem != nullptr;
}

void setTalk(bool held) { talkHeld.store(held); }

void requestPattern(uint16_t frames) {
  if (frames) patternFrames.store(frames);
}

void onHello() {
  ledger.reset();
  stopStream(FLUSH_RESET);
  discarding = false;
}

void onAudioDown(const uint8_t* pcm, size_t len, bool eos) {
  ledger.received(len);
  if (discarding) {
    if (eos) discarding = false;
    return;
  }
  streamOpen = !eos;
  size_t even = len & ~(size_t)1;
  if (even) ring.write(pcm, (uint32_t)even);
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
```

- [ ] **Step 7: Wire the downlink into `firmware/src/main.cpp`**

In `command()`, add this case before `case proto::CMD_BOOT_APP0:`:

```cpp
    case proto::CMD_STOP_AUDIO:
      audio::stopFromPc();
      break;
```

In `setup()`, replace

```cpp
  usblink::Handlers h = {};
  h.onCommand = command;
  h.onTest = test;
  usblink::begin(h);
  audio::begin();
```

with

```cpp
  bool audioOk = audio::begin();
  usblink::Handlers h = {};
  h.onHello = audio::onHello;
  h.onAudioDown = audio::onAudioDown;
  h.onCommand = command;
  h.onTest = test;
  h.idle = audio::rxIdle;
  h.ringBytes = audioOk ? audio::RING_BYTES : 0;
  usblink::begin(h);
  if (!audioOk) usblink::logf("no PSRAM for the playback ring: replies cannot play");
```

- [ ] **Step 8: Write `bridge/src/dev/play.js`**

```js
// Plays a file (anything ffmpeg reads, converted to 24 kHz mono PCM16) or a test tone on the S3.
// Ctrl+C stops it the way the bridge will stop a reply.
import { spawnSync } from 'node:child_process';
import { tone } from '../audio/tone.js';
import { connect } from './connect.js';

export default async function play([what, a, b], opts) {
  const pcm = what === 'tone' ? tone(Number(a ?? 440), Number(b ?? 3)) : readAudio(what);
  const link = await connect(opts);
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  const t0 = Date.now();
  const p = await link.playAudio(pcm, { signal: ac.signal });
  console.log(`${p.reason === 0 ? 'played' : 'stopped'}: ${p.bytes} of ${pcm.length} bytes in ${((Date.now() - t0) / 1000).toFixed(2)} s, ${p.underruns} underruns, ring peak ${p.maxFill} bytes`);
  link.close();
}

function readAudio(file) {
  if (!file) throw new Error('play <file> | play tone <hz> <secs>');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '24000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  if (r.error) throw new Error(`could not start ffmpeg: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${file}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}
```

- [ ] **Step 9: Replace `bridge/src/dev/loopback.js`**

```js
// Proves the link loses nothing.
//   up:   the S3 sends a 5 s take of the test pattern; every byte is compared.
//   down: a quiet tone plays; the S3's count and CRC-32 of what reached its speaker are compared.
//   stop: a 10 s tone is stopped after 2 s; the next 1 s tone must then play in full.
import { crc32 } from 'node:zlib';
import { TakeCollector } from '../audio/takes.js';
import { tone } from '../audio/tone.js';
import { patternBytes } from '../link/pattern.js';
import { connect, withTimeout } from './connect.js';

export default async function loopback([which = 'all', secs = '10'], opts) {
  const checks = {
    up: (link) => up(link),
    down: (link) => down(link, Number(secs)),
    stop: (link) => stop(link),
  };
  const names = which === 'all' ? Object.keys(checks) : [which];
  for (const name of names) {
    if (!checks[name]) throw new Error(`loopback ${name}? Use ${Object.keys(checks).join(', ')} or all.`);
  }
  const link = await connect(opts);
  let ok = true;
  for (const name of names) ok = (await checks[name](link)) && ok;
  link.close();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
}

async function up(link, frames = 250) {
  const takes = new TakeCollector();
  let first = 0;
  let last = 0;
  const take = new Promise((resolve) => {
    const onFrame = (f) => {
      last = Date.now();
      if (!first) first = last;
      const pcm = takes.push(f);
      if (!pcm) return;
      link.off('audio-up', onFrame);
      resolve(pcm);
    };
    link.on('audio-up', onFrame);
  });
  link.testUpPattern(frames);
  const pcm = await withTimeout(take, frames * 20 + 5000, 'the pattern take did not arrive');
  const want = patternBytes(0, frames * 320);
  const same = pcm.equals(want);
  console.log(`up: ${pcm.length} of ${want.length} bytes, ${same ? 'identical' : 'DIFFERENT'}; ${frames} frames arrived over ${((last - first) / 1000).toFixed(2)} s (sent over ${((frames - 1) * 0.02).toFixed(2)} s)`);
  return same;
}

async function down(link, secs) {
  const pcm = tone(523.25, secs); // a quiet C5
  const t0 = Date.now();
  const p = await link.playAudio(pcm);
  const crcOk = p.crc32 === crc32(pcm);
  console.log(`down: ${p.bytes} of ${pcm.length} bytes played, CRC ${crcOk ? 'matches' : 'DIFFERS'}, ${p.underruns} underruns, ring peak ${p.maxFill} bytes, ${((Date.now() - t0) / 1000).toFixed(2)} s for ${secs} s of audio`);
  return p.reason === 0 && p.bytes === pcm.length && crcOk && p.underruns === 0;
}

async function stop(link) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  const cut = await link.playAudio(tone(440, 10), { signal: ac.signal });
  clearTimeout(timer);
  const next = await link.playAudio(tone(660, 1));
  console.log(`stop: cut after ${(cut.bytes / 48000).toFixed(2)} s of audio (reason ${cut.reason}); the next 1 s tone played ${next.bytes} of 48000 bytes`);
  return cut.reason === 1 && cut.bytes > 0 && cut.bytes < 480000 && next.reason === 0 && next.bytes === 48000;
}
```

- [ ] **Step 10: Add `play` to `bridge/bin/walkie-dev.js`**

Replace the `USAGE` constant with:

```js
const USAGE = `usage: node bridge/bin/walkie-dev.js <command> [args] [--port COMx]
  ping [n]                 say HELLO, then show n PONGs (default 5)
  cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot
  term [text] [--secs n]   plain-text console without resetting the S3 (for on-the-beat)
  listen [--out dir]       save each talk-key take as a WAV and print its levels
  loopback [up|down|stop|all] [secs]   check that the link loses nothing (down plays secs of tone, default 10)
  play <file> | play tone <hz> <secs>  play audio on the S3; Ctrl+C stops it`;
```

and add this line to the `commands` object:

```js
  play: () => import('../src/dev/play.js'),
```

- [ ] **Step 11: Run the bridge suite**

Run: `npm --prefix bridge test`
Expected: PASS, 34 tests.

- [ ] **Step 12: Flash, then check the downlink loses nothing**

Run: `node tools/flash.mjs`, then `node bridge/bin/walkie-dev.js loopback`
Expected, with a quiet tone audible for 10 s and then for about 2 s and 1 s:
- `up: 160000 of 160000 bytes, identical; …`
- `down: 480000 of 480000 bytes played, CRC matches, 0 underruns, ring peak … bytes, 10.x s for 10 s of audio`
- `stop: cut after 2.x s of audio (reason 1); the next 1 s tone played 48000 of 48000 bytes`
- `PASS`

- [ ] **Step 13: A reply longer than the ring**

Run: `node bridge/bin/walkie-dev.js loopback down 60`
Expected: `down: 2880000 of 2880000 bytes played, CRC matches, 0 underruns, ring peak` close to 2,097,152 bytes, then `PASS`. Once the ring is full, credit follows playback, so nothing overflows.

- [ ] **Step 14: Stops from both ends (needs him for the second)**

Run: `node bridge/bin/walkie-dev.js play tone 440 10` and press Ctrl+C after about 3 s.
Expected: the tone stops at once and the CLI prints `stopped: …` with a byte count near 3 s × 48,000.

Run it again; this time he presses and holds the front key after about 3 s.
Expected: the tone stops at once and the CLI prints `stopped: …`; when he lets go, the screen's take count goes up by one.

- [ ] **Step 15: Commit**

```bash
git add firmware/src bridge/src bridge/test/audio/tone.test.js bridge/bin
git commit -m "Downlink: credit-paced replies play from a PSRAM ring, report PLAYED and stop from either end" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Mic gain calibration, README and one test command

**Files:**
- Create: `package.json` (repo root)
- Create: `README.md`
- Modify: `firmware/src/status.h` (the `micGain` default)
- Modify: `docs/superpowers/specs/2026-09-29-walkie-design.md` (§6.2 mic gain, §10)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm test` at the repo root runs all three suites; the measured mic gain as the firmware default.

- [ ] **Step 1: Write the root `package.json`**

```json
{
  "name": "walkie",
  "private": true,
  "scripts": {
    "test": "npm --prefix bridge test && node --test \"tools/test/*.test.mjs\" && node firmware/host/run.mjs"
  }
}
```

- [ ] **Step 2: Run everything**

Run: `npm test`
Expected: the bridge's 34 tests pass, the tools' 6 tests pass, and the host tests print `9 cases, N checks passed, 0 failed`.

- [ ] **Step 3: Write `README.md`**

````markdown
# walkie

Talk to Claude Code on the PC through the M5StickS3 on the wrist. The design is in
`docs/superpowers/specs/2026-09-29-walkie-design.md`; the plans are in `docs/superpowers/plans/`.

The S3 also runs on-the-beat. on-the-beat keeps app0 and walkie lives in app1, so never run
`pio run -t upload` or `pio test` for this firmware against the S3: both write app0.

## Layout

| Folder | What it holds |
|---|---|
| `protocol/` | the USB wire format (`frames.md`), its Python reference and the shared test vectors |
| `firmware/` | the S3 firmware (PlatformIO). `lib/proto` is portable C++ that `host/run.mjs` also builds and tests on the PC |
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `bin/walkie-dev.js` and `src/dev` are developer commands |
| `tools/` | writing walkie into app1, and choosing which app the S3 boots |

## Commands

From the repo root:

```bash
npm test
```

```bash
node tools/flash.mjs
```

```bash
node tools/boot.mjs app0
```

```bash
node tools/boot.mjs app1
```

```bash
node bridge/bin/walkie-dev.js
```

`npm test` runs the bridge, tools and firmware host tests. `flash.mjs` builds walkie, writes it to app1 and boots it.
`boot.mjs app0` boots on-the-beat and `boot.mjs app1` boots walkie. `walkie-dev.js` with no arguments lists the
developer commands: ping, cmd, term, listen, loopback, play.

Only one program can hold the S3's port (COM8) at a time: stop the dev CLI before flashing or switching.
Takes recorded by `listen` are voice recordings; they go to `bridge/takes/`, which git ignores.
````

- [ ] **Step 4: Calibrate the mic gain (needs him)**

The S3 is on his wrist, or held where a watch sits when he looks at it. For each gain to try:

Run: `node bridge/bin/walkie-dev.js cmd gain 4`, then `node bridge/bin/walkie-dev.js listen`
He holds the front key and says 「帮我跑一下 npm test，然后 commit」 at his normal loudness, three times, then Ctrl+C.

The aim is every peak between 25% and 50% of full scale, with `clipped 0.00%` on every take. If a peak is above 50% or anything clipped, try gain 3, then 2. If every peak is below 25%, try 6, then 8. Stop at the first gain whose three takes all land in the band.

- [ ] **Step 5: Make that gain the default**

In `firmware/src/status.h`, change `std::atomic<uint8_t> micGain{4};` to the chosen value (for example `micGain{3};`). Run `node tools/flash.mjs`, then `node bridge/bin/walkie-dev.js listen` without any `cmd gain`, and have him record one more take.
Expected: that take also lands in the band, and the screen shows the new value after 「麦克风」.

- [ ] **Step 6: Record the result in the spec**

In `docs/superpowers/specs/2026-09-29-walkie-design.md` §6.2, replace the bullet that begins `- Mic gain: lower \`magnification\`` with one line holding the measured values:

```markdown
- Mic gain: `magnification` <gain>, calibrated on <date> in Stage 1 plan 1. At wrist distance his normal speech peaked at <lowest>-<highest>% of full scale over three takes, with nothing clipped.
```

In §10, delete the bullet `- The mic gain value, starting from the estimate of 4.`

- [ ] **Step 7: Commit**

```bash
git add package.json README.md firmware/src/status.h docs/superpowers/specs/2026-09-29-walkie-design.md
git commit -m "Calibrate the mic gain; add the README and one command for every test suite" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After this plan

- The link is done when `npm test` passes and `node bridge/bin/walkie-dev.js loopback` prints `PASS` on the S3.
- Plan 2 (speech) starts from the takes in `bridge/takes/`. Its first check is §10's open question: does `gpt-transcribe` still get his sentence right at wrist distance with the new gain? Plan 2 also calibrates the loudness chain's makeup gain with `marin` through `walkie-dev play`, and settles the Gemini fallback.
- Plan 3 (Claude) owns §10's HTTP permission MCP and the ~40K cache re-writes.
- Plan 4 defines the reserved frame types (UI, BUTTON, APPROVAL_REQ, APPROVAL_RES) and the TEST ops spec §6.2 lists (press, hold, inject audio, snap the screen), and replaces the diagnostic screen and the talk-key handling in `main.cpp` with the state machine from spec §6.2.
