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
- `seq` counts the frames sent in each direction, from 0 at start-up, wrapping at 65536. A receiver counts a gap whenever a frame's seq is not the previous one plus 1. Gaps are for diagnosis only: nothing is sent again. At every HELLO the receiver takes the HELLO's seq as its new baseline (the next frame is expected at seq + 1) and zeroes its seq-gap count (on the S3 that is the seq_gaps reported in PONG). The S3 does this for every HELLO from the PC; the PC does it for the S3's answer to its current nonce, not for a boot HELLO or an answer to an earlier nonce. Bad-chunk counts are not reset, and the sender's own numbering carries on.

## Flags

| Bit | Meaning |
|---|---|
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec of an AUDIO_UP or AUDIO_DOWN frame. 0 is PCM16, little endian, mono; 1 is IMA-ADPCM (see Audio codec); 2 and 3 are reserved. |
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
| 7 | Sealed: the payload is `counter, ciphertext, tag` (see Sealed frames). |

All other bits are 0.

## Sealed frames

A device that has been paired (see Pairing, below) and the bridge that holds its key seal every frame except HELLO. `protocol/gen_seal_vectors.mjs` writes `seal-vectors.json`, which the bridge's tests and the firmware's host tests both pass.

- A sealed frame has flags bit 7 set, and its payload is `counter:u32, ciphertext, tag:16`. The ciphertext is as long as the plain payload, so a sealed payload is 20 bytes longer than the plain one, and the plain payload is at most 1004 bytes (the 1024-byte limit of a frame is unchanged).
- Cipher: AES-256-GCM. The nonce is 12 bytes: the direction as u32 (1 for PC to S3, 2 for S3 to PC), then the counter as u64, little endian. The additional authenticated data is the frame's type, flags (bit 7 set), seq and len as they are on the wire (len is the sealed length), then the counter, 10 bytes in all. The tag is 16 bytes.
- Session keys: one for each direction, `HKDF-SHA256(ikm = K, salt = empty, info = "walkie-session-v1" || nonceP:u32 || nonceS:u32 || direction:u8, 32 bytes)`. `K` is the 32-byte key made at pairing; nonceP and nonceS are the two nonces of the HELLO that began the link, so every link has new keys and a counter that starts at 0 never repeats a nonce under a key.
- Counters start at 0 at each HELLO and go up by 1 for every sealed frame a side sends. A receiver accepts a frame only when its counter is above that of every frame it has accepted since the HELLO and the tag is right; a frame that fails either is dropped and counted, and moves nothing. Gaps are normal (frames are lost); going back is not. The counter after 2^32 - 1 does not exist: the sender starts the link over.
- Eight refused frames in a row mean the link is broken: the bridge says HELLO again, and the S3 treats the session as lost until the next HELLO.
- The CRC-16 stays outside the seal, so a frame damaged on the wire is dropped before any decryption and is not counted as an attack.

## Audio codec

A receiver decodes an audio frame by its codec flag, so nothing is negotiated. `vectors.json` holds the step tables and encoded and decoded cases that the bridge's tests and the firmware's host tests both pass; the reference is `protocol/gen_vectors.py`.

- IMA-ADPCM, 4 bits a sample, integer arithmetic only, so every decoder gives the same bits. Both tables (89 steps, and the index adjustments -1, -1, -1, -1, 2, 4, 6, 8) are in the vectors.
- A frame is self-contained: `pred:s16, index:u8, pad:u8`, then the nibbles of samples 1 to n-1, two to a byte, the first in the low half. `pred` is sample 0 and is not coded. `index` is the step index in effect for sample 1 (0 to 88). `pad` is 1 when n - 1 is odd and the last nibble is padding. The sample count is `1 + 2 * (len - 4) - pad`. A lost frame costs only that frame.
- An encoder carries the step index from one frame to the next of a stream (the next frame's header says it), so a frame is not coded from the smallest step. The first frame of a stream starts at index 0.
- 20 ms is 320 samples up (640 bytes become 164) and 480 samples down (960 bytes become 244). An empty AUDIO frame (the EOS) stays empty.
- Credit, the S3's ring and PLAYED all count decoded PCM bytes, so they mean what they meant before. PLAYED's crc32 is over the PCM the S3 decoded; the bridge decodes its own frames to know what to expect.

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
| 0x20 | UI | PC to S3 | u8 state, then fields: see UI |
| 0x21 | BUTTON | S3 to PC | u8 event: see BUTTON |
| 0x22 | APPROVAL_REQ | PC to S3 | u16 id, u8 tool_len, tool, preview: see APPROVAL |
| 0x23 | APPROVAL_RES | S3 to PC | u16 id, u8 verdict, u8 reason_follows: see APPROVAL |
| 0x30 | CMD | PC to S3 | u8 op, then its argument |
| 0x31 | TEST | PC to S3, and SNAP chunks S3 to PC | u8 op, then its arguments |
| 0x32 | PAIR | both | u8 op, then its argument: see Pairing |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |

A receiver ignores types it does not know.

### HELLO

- PC to S3: `u8 proto (1), u32 nonce`. The PC picks a new non-zero nonce for each handshake, sends HELLO when it opens the port, and repeats it once a second until the S3 answers. On every PC HELLO the S3 starts the link over: seq counting, credit, and any reply it was playing, which it drops without a PLAYED.
- S3 to PC: `u8 proto (1), u8 reserved (0), u16 up_rate (16000), u16 down_rate (24000), u32 ring_bytes, u32 uptime_ms, u32 nonce`, then the firmware version as UTF-8 to the end of the payload. In an answer, the nonce is the one from the PC's HELLO; in the HELLO the S3 sends at boot, it is 0.
- S3 to PC, proto 2 (a walkie that can seal frames): the same fields, then `u32 nonceS` and `u8 flags` before the version string. `nonceS` is the S3's fresh random half of the session keys. Flags: bit 0 set when the S3 is paired, bit 1 set when it takes ADPCM (see Audio codec). The S3 answers a PC HELLO with proto 2 and starts a new session (keys from the PC's nonce and its `nonceS`, counters at 0) at every HELLO it gets, so a repeated HELLO gives a second answer with another `nonceS`.
- A PC with no key takes a proto 2 answer that says unpaired exactly like a proto 1 answer: plain frames. It refuses a paired S3 and says to run `walkie pair`.
- A PC with a key accepts only an answer that says paired, and then derives the session keys from its nonce and `nonceS`. The link is not ready yet: it becomes ready when the first frame from the S3 opens under those keys (any frame; the PC also sends a sealed PING at once), because only an S3 that holds the same key can make one. HELLO goes on every second until then; if nothing has opened after 3 s the PC says the key is probably wrong. An answer that says unpaired, or proto 1, is refused with a message to run `walkie pair`. Once the link is ready, a further answer with the same nonce starts a new session on the new `nonceS` and sets the credit to 0 again.
- The PC ignores every frame until an S3 HELLO that carries its current nonce. That HELLO makes the link ready and sets the PC's credit to 0. A second answer with the same nonce (to a repeated HELLO) sets the credit to 0 again, because the S3 started over again. Once the link is ready, a HELLO with nonce 0 means the S3 restarted: the reply being sent fails, and the PC shakes hands again with a new nonce. Any other HELLO was queued before the PC opened the port, and is ignored. The S3's USB port holds output until someone reads it, so a stale HELLO from boot is normal.

### PING and PONG

The PC pings once a second, and once at once when the S3's HELLO answer makes the link ready (the S3 shows OFFLINE until it has had a PING, so a bridge that waited for the first tick left it offline for a second). The S3 answers with the same token, its uptime, and its counts of bad chunks and seq gaps. The PC considers the link down after 3 s without a PONG and goes back to saying HELLO. The S3 shows the PC as offline after 3 s without a PING.

### Pairing (PAIR)

PAIR, type 0x32, is never sealed, in either direction. Its payload is `u8 op`, then: 1 SET (`key:32`), 2 FORGET, 3 OK (`op`: the op it answers), 4 DENIED (`op`).

- `walkie pair` makes a random 32-byte `K`, writes it to `pair.key.new`, and sends SET. The S3 shows a confirmation on its own screen (front key yes, side key no, no answer in 30 s is no). On yes it stores `K` and answers OK, and the PC then renames `pair.key.new` to `pair.key`. On no or a timeout the S3 answers DENIED and the PC deletes `pair.key.new`.
- SET with the key the S3 already holds is answered OK at once, without asking, so that a PC that lost the OK can try again.
- FORGET, after the same confirmation, makes the S3 erase its key and answer OK. The PC then deletes `pair.key`.
- A paired S3 takes SET and FORGET in plain frames, though it refuses every other plain frame: the key press on the device is the authority, and without this a lost key file would lock walkie out of pairing for good. They are accepted on the USB link only.
- The bridge's `Link` has a pairing mode for this: it holds no key, does not ping (a paired S3 would not answer a plain PING) and hands up only PAIR frames.

### Credit: flow control for AUDIO_DOWN

- The PC sends AUDIO_DOWN payload only against credit. Its credit starts at 0, returns to 0 at every S3 HELLO, grows by each CREDIT, and shrinks by each AUDIO_DOWN payload it sends. It sends a frame only when the frame's whole payload is covered.
- The S3 grants no more than it has room for. Credit it has granted but not yet received never exceeds the free space in its playback ring, nor a window of 12,288 bytes. The window is what protects the S3's 16,384-byte USB receive queue, which drops bytes when it is full. The S3 grants in steps of at least 1,920 bytes, grants nothing while it is emptying its ring after a stop, and counts AUDIO_DOWN bytes it discards as received.
- The PC sends AUDIO_DOWN frames of 960 bytes except the last frame of a reply, and never a non-final frame under 320 bytes. Credit counts payload bytes, but the 16,384-byte receive queue fills with wire bytes, at least 11 bytes of overhead per frame (the 8-byte envelope around the payload, one COBS byte and two delimiters), so a full 12,288-byte window spent on tiny frames could overflow it.
- The other frame types are small and are not counted.

### Audio streams

- A stream is a run of frames of one type that ends with an EOS frame (an AUDIO_UP take that is a reason has REASON on that frame too). AUDIO_UP: one take per hold of the talk key, or per TEST UP_PATTERN. AUDIO_DOWN: one spoken reply.
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
| 6 | SET_CODEC | u8: 0 PCM16, 1 ADPCM | the codec of AUDIO_UP from now on (see Audio codec); a HELLO puts it back to PCM16, so the PC sends it again after every HELLO answer. Anything else than 0 or 1 is refused with a LOG line. AUDIO_DOWN needs no such command: its frames carry their codec |

The S3 answers each with a LOG line.

### UI

PC to S3: `u8 state`, then fields, each `u8 tag, u16 len, len bytes`. A field that is absent is empty. A reader skips a tag it does not know and refuses a payload whose last field runs past its end. The S3 draws a UI frame as soon as it arrives. The bridge sends one whenever the screen changes, and again after every HELLO, so that a restarted S3 shows the right screen.

| state | Name | The S3 shows |
|---|---|---|
| 0 | IDLE | the project, the link, the battery |
| 1 | TRANSCRIBING | that the bridge is working out what was said |
| 2 | CONFIRM | the transcript; a short press of the side key cancels it |
| 3 | WORKING | the status line and the time since the turn began |
| 4 | REPLY | the text of the reply, in pages |
| 5 | ERROR | a plain message |

| tag | Name | Value |
|---|---|---|
| 1 | PROJECT | UTF-8, at most 60 bytes |
| 2 | TEXT | UTF-8, at most 900 bytes: the transcript in CONFIRM, the status line in WORKING, the reply in REPLY, the message in ERROR |
| 3 | ELAPSED_MS | u32: how long the turn had been running when the frame was sent; the S3 counts on from the frame's arrival |

Text that is too long is cut by the bridge on a character, with an ellipsis; the full text is for the bridge's console. The S3 enters four more states by itself, which the bridge never sets: OFFLINE (no PING for 3 s), LISTENING (the front key is held), APPROVAL (an APPROVAL_REQ is on screen) and SWITCH_CONFIRM (both keys held for 3 s).

### BUTTON

S3 to PC, `u8 event`:

| event | Name | Sent when |
|---|---|---|
| 1 | CANCEL | the side key is pressed briefly while CONFIRM shows |
| 2 | STOP | the side key has been held for 1 s while WORKING shows |
| 3 | DISMISS | the side key is pressed briefly on the last page of a reply, once its audio has finished |
| 4 | SWITCHING | the front key confirmed SWITCH_CONFIRM: the S3 is about to select app0 and restart |

### APPROVAL

- APPROVAL_REQ, PC to S3: `u16 id, u8 tool_len, tool, preview`. The tool is UTF-8, at most 64 bytes; the preview is UTF-8 to the end of the payload, at most 900 bytes. The S3 shows it until it answers or any UI frame arrives. The bridge sends one request at a time and keeps the others waiting.
- APPROVAL_RES, S3 to PC: `u16 id, u8 verdict (1 allow, 0 deny), u8 reason_follows (1 or 0)`. With reason_follows 1 the S3 has recorded a spoken reason: its AUDIO_UP take, ended with EOS, went out before this frame. The bridge answers the request only once it has read the take.

### TEST

| op | Name | Arguments | Effect |
|---|---|---|---|
| 1 | UP_PATTERN | u16 frames | the S3 sends a take of that many 640-byte AUDIO_UP frames of the test pattern, one every 20 ms, EOS on the last |
| 2 | KEYS | u8 count (1 to 16), then count steps of u16 delay_ms, u8 mask | a key script: after delay_ms (counted from the previous step, or from the frame's arrival) the keys held are the mask (bit 0 the front key, bit 1 the side key). The S3 treats them as pressed together with the real keys. The frame is refused when its length is not what count announces |
| 3 | MIC_SOURCE | u8 on | with 1, a take is recorded from the PCM of MIC_PCM instead of the mic (silence when it has run out); with 0, from the mic again and the PCM queued is emptied |
| 4 | MIC_PCM | PCM16 at 16 kHz, 2 to 1000 bytes | queued for MIC_SOURCE; what does not fit in the S3's queue (2^19 bytes, 16.4 s) is dropped, and a LOG line says so. Send them paced: the S3's receive queue is 16 KB and 283 frames handed to the port at once lost 50 of them on the way (its PONG counted 83 more bad chunks and 50 sequence gaps), the KEYS frame that follows among the likely ones. Four frames and then a pause of 5 ms lost none in 283 (`walkie-dev inject` does that) |
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |
| 6 | SELFTEST | none | the S3 checks its own HKDF, AES-GCM and sealed-session code against published vectors (RFC 5869, NIST) and answers with one LOG line that starts with `selftest ok` or `selftest FAILED`. It reads and writes no pairing key |

SNAP chunk, S3 to PC, a TEST frame of op 5: `u8 5, u16 index, u16 count, u16 width, u16 height`, then RGB565 little endian, row by row, two rows (960 bytes) to a chunk. A 240 by 135 screen is 68 chunks. The S3 sends them as its TX queue allows, so a chunk can arrive a few milliseconds after the one before it. A new SNAP while one is being sent starts again from chunk 0. About one S3-to-PC frame in a thousand of about 1 KB reaches the bridge damaged (measured on 2 Oct 2026: about one snapshot in twenty loses a chunk, the same at half the sending rate, with the S3's TX ring not full), so the bridge asks for a snapshot again, up to three times with 3 s for each; the CRC makes a damaged frame a lost one.

Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.

## Relay (plan 6)

Away from the cable the same frames travel through a relay that both ends dial out to. The relay is blind: it forwards bytes and cannot read or forge a frame, because every frame of a paired link is sealed.

- Address: `wss://<host>/r/<room>?role=pc` for the bridge and `role=device` for the S3. `<room>` is the first 16 bytes of HKDF-SHA256 of the pairing key (empty salt, info `walkie-room-v1`) in lower-case hex, 32 characters. Only the two holders of the key can work it out.
- One WebSocket binary message is one frame: its envelope, which is the bytes that COBS carries on USB (type, flags, seq u16 LE, len u16 LE, payload, CRC-16), without COBS and without the 0x00 delimiters. At most 1032 bytes; the relay refuses a message over 1100 and any text message.
- A room holds at most one PC and one device. A second connection of the same role replaces the first, which is closed with code 4000.
- The relay forwards each message to the peer unchanged and drops it when there is no peer. It keeps nothing, so a peer that arrives later sees nothing of what was sent before.
- HELLO, sealing, PING and PONG are as on USB. A PONG is expected within 10 s on this carrier, and the bridge sends PING every 5 s, so that a phone's hotspot jitter does not read as a disconnect.
- A device joins the relay only when it holds a pairing key.

### The S3 on two transports

- The S3 joins Wi-Fi and the relay only while it holds a pairing key, at least one network and a relay host (NET, below); otherwise its Wi-Fi is off. It tries the networks in the order they were added, 10 s each, and between failed attempts waits 1, 2, 4 s and so on up to 30 s.
- TLS to the relay is verified against two roots only, ISRG Root X1 and ISRG Root X2 (`firmware/src/relay_roots.h`, made by `tools/gen-relay-roots.mjs`). A relay must present a chain to one of them, as `*.fly.dev` does; `tools/check-relay-roots.mjs <host>` checks a host. There is no way to turn the check off. The S3 does not check `Sec-WebSocket-Accept`: the TLS check names the relay, and the relay can neither read nor forge a sealed frame.
- The S3 is a WebSocket client: every frame it sends is masked, every frame it takes is unmasked. The relay sends an empty ping every 30 s and drops a client that does not answer; the S3 answers with an empty pong. The S3 hangs up when nothing at all has come from the relay for 70 s, and dials again.
- The S3 starts on USB. It sends on the transport where it last took a HELLO, and a HELLO on the other transport moves it there. Any other frame that arrives on the transport not in use is dropped before it is opened, so it spends no replay counter. Online means a PING came within 3 s on USB and 10 s on the relay.
- PAIR is taken over USB only; one that arrives from the relay is dropped. Pairing stays a matter of the cable and the key press.
- On OFFLINE the S3 says which link it lacks: no network set up (plug in USB and run walkie, as before), no Wi-Fi joined, no relay reached, or a relay with no PC on it.

## Network settings (plan 6)

Type `0x33`, NET. The PC sets the Wi-Fi networks and the relay host that a paired S3 uses when it is not on the cable. It is **only ever accepted sealed**: a plain NET frame, and any NET frame on an S3 that holds no pairing key, is dropped and counted as refused, so a Wi-Fi password never crosses a link in the clear and nobody who lacks the key can point the S3 at a relay of their own. The S3 answers with one NET frame, sealed like the request.

Every text is led by its length in one byte. Lengths are bytes of UTF-8.

| Op | Request payload | Notes |
|---|---|---|
| `01` WIFI_ADD | `01, ssidLen, ssid, passLen, pass` | SSID 1 to 32 bytes; password none (an open network) or 8 to 63 bytes. A network already held under that SSID takes the new password. At most 4 networks; a fifth is refused FULL. Order of adding is the order of trying. |
| `02` WIFI_REMOVE | `02, ssidLen, ssid` | UNKNOWN when not held. |
| `03` WIFI_LIST | `03` | |
| `04` RELAY_SET | `04, hostLen, host` | 1 to 63 bytes of letters, digits, dots and hyphens: the host name goes into an HTTP request line, and nothing else may. |
| `05` RELAY_CLEAR | `05` | Nothing set is fine. |

An SSID or password with a NUL byte is refused: the Wi-Fi library takes C strings.

| Reply | Payload |
|---|---|
| `80` OK | `80, answered` |
| `81` ERR | `81, answered, reason`: 1 BAD (a request that breaks the limits), 2 FULL, 3 UNKNOWN, 4 STORE (it could not be saved, so nothing changed) |
| `82` LIST | `82, count, (ssidLen, ssid) x count, hostLen, host`: the SSIDs and the relay host (hostLen 0: none). **Never a password.** |

`protocol/` has no vector file for this: the same hex strings are in `bridge/test/link/net-messages.test.js` and `firmware/host/test_net_messages.cpp`, and each end checks them.
