# Walkie Stage 3: using it away from the cable (design)

- Date: 2026-10-03
- Status: design approved in conversation, awaiting written review
- Builds on: `2026-09-29-walkie-design.md` (§5 Stage 3, §6.6 link protocol, §7 Stage 3 boundary). Where this document is more specific than §7, this one wins; §7 stays as the short statement of intent.
- Scope: how the S3 talks to the bridge without the USB cable, from home or from another network. It is split into two plan cycles (§2).

## 1. Goal

Wear the S3 without the cable and still talk to Claude Code on the PC: the same hold-to-talk turn, spoken replies and button approvals as over USB. The PC stays on, awake, with the bridge running (§7.4).

The device can approve tool use on the PC (a Bash call, a file write). So the link must be authenticated end to end: whoever hosts the relay or sits on the network must be unable to forge an APPROVAL_RES. Confidentiality of the audio matters too, but forgery is the threat that decides the design.

## 2. Decomposition

| Plan | Contents | Link while it is built |
|---|---|---|
| 5 | Frame sealing (AES-256-GCM), session keys, pairing over USB, ADPCM, a transport seam on both sides | USB only, so every existing gate and test vector still applies |
| 6 | Wi-Fi on the S3, WSS client, the Fly relay, the bridge's network transport, reconnect behaviour | USB and network |

Plan 5 is complete and gated before Plan 6 starts, so Plan 6 adds only the network leg and can trust the layers beneath it.

## 3. Decisions made in design

| Decision | Choice | Reason |
|---|---|---|
| Frame carrier | The existing frame, one per WebSocket binary message, payload sealed with AES-GCM, header authenticated | Relay stays blind and cannot forge; USB and WSS share one format, so Plan 5 is testable at the desk |
| TLS only (no sealing) | Rejected | The relay could read audio and forge APPROVAL_RES |
| COBS stream tunnelled through WSS | Rejected | WebSocket already has message boundaries; COBS would be cost without benefit |
| Wi-Fi credentials | Written over USB into walkie's own NVS namespace, up to 4 networks | Keeps the key and the passwords off the network; does not touch on-the-beat's data (§6.7) |
| Connection policy | Stay connected, modem sleep, screen always shows online state | No wait before a turn; standby drain is measured in Plan 6, not assumed |
| Hosting | A separate Fly app, as §7 says | A device cannot join a VPN; it needs a public endpoint it dials out to |

## 4. Plan 5 design

### 4.1 Layers

```
firmware                                              bridge
  link task -- Transport (USB | WSS) --+       +-- Transport (serial | WSS) -- Link
  seal/open (key in NVS)               |       |   seal/open (key in %APPDATA%\walkie)
  ADPCM encode/decode                  +-relay-+   ADPCM encode/decode
                                        (Plan 6, blind)
```

The firmware's `usblink` splits into a frame layer and a transport. The bridge's `Link` already takes an `openPort` that returns something with `write`, `data`, `close` and `error`; the same seam takes the network transport in Plan 6. A device that has never been paired behaves exactly as it does today, in plaintext over USB.

### 4.2 Keys

- `K` is 32 random bytes made at pairing.
- Session keys: one per direction, `HKDF-SHA256(K, "session" || nonceP || nonceS)` with a direction label. A new session key at every HELLO means a counter that restarts at zero never reuses a nonce under the same key.
- Room id (Plan 6): the first 16 bytes of `HKDF-SHA256(K, "room")`, 128 bits, not guessable.
- `nonceS` comes from `esp_random`. `nonceP` comes from `crypto.randomBytes`; today's HELLO uses `randomInt`, which is replaced once a key exists.

### 4.3 Sealed frame

`type | flags (bit 7 set) | seq | len | counter:u32 | ciphertext | tag:16 | crc16`

- GCM nonce: 4 bytes of direction, then the 8-byte counter with the high bytes zero.
- Additional authenticated data: the header and the counter.
- Overhead is 20 bytes a frame. The 1024-byte limit applies to the plaintext; a sealed payload is at most 1044. The decoder limit and `protocol/frames.md` change with it.
- **Amended in plan 5:** the frame limit stays 1024 for the whole payload, sealed or not, so a sealed frame carries at most 1004 bytes of plaintext. Every frame the firmware and the bridge send is far below that (the largest, audio, is 964 bytes plain), and a limit that does not move leaves the existing decoders, vectors and gates untouched.
- The CRC stays so that the damaged USB frames (about 1 in 1000) are dropped before decryption and are not mistaken for an attack.

### 4.4 Handshake

1. The PC sends a plaintext HELLO carrying `nonceP`.
2. The S3 answers in plaintext: it echoes `nonceP` and adds `nonceS`, the ring size and its capabilities.
3. Both derive the session keys. The PC sends a sealed PING and the S3 answers with a sealed PONG.
4. `Link` is ready only after that PONG has opened. A tampered nonce gives different keys, so the link fails to come up rather than failing quietly.

### 4.5 Receive rules

- The counter must be strictly greater than the last accepted one. Gaps are allowed because frames are lost; going backwards is not, so replays and reordering are rejected.
- A bad tag or a counter that goes back is dropped and counted. Eight in a row mean the link is broken: the bridge sends HELLO again and the S3 returns to OFFLINE. Logging is rate limited.
- No downgrade: once paired, every frame except HELLO must be sealed, on every transport. That includes CMD (boot app0) and TEST.
- **Amended in plan 5:** PAIR frames are the second exception, on USB. A PC that has lost its key (a reinstall, a wiped `%APPDATA%`) could not otherwise ask the S3 to take a new one, and the person's key press on the S3 is what authorises SET and FORGET, not secrecy of the frame. PAIR is never accepted over any other transport.
- At counter 2^32 - 1 the link reconnects. This is a backstop; at 50 frames a second it is more than two years away.
- A wrong key (another PC, a re-pair) means the link never becomes ready. The bridge says: the S3 does not answer to this key, run `walkie pair` again.

### 4.6 Key storage

- PC: `%APPDATA%\walkie\pair.key`, beside `keys.env` and under the same rules: created only from the user's own terminal, never read or logged by an agent, and never written by a process running inside the Claude desktop app, which sees a private `%APPDATA%`. Tests inject a test key.
- S3: walkie's own NVS namespace. NVS is not flash-encrypted, so anyone with the device and a cable can read the key. The device defends against the network, not against someone who holds it. If it is lost, pair again on the PC and the old key is dead.

### 4.7 ADPCM

- IMA-ADPCM, 4 bits a sample. Each frame carries its own header (predictor s16, step index u8, 4 bytes) so a lost frame cannot corrupt the next ones.
- Up: 20 ms is 320 samples, 640 bytes become 164. Down: 20 ms is 480 samples, 960 bytes become 244.
- `flags` bits 1-2 select the codec (0 PCM16, 1 IMA-ADPCM). A receiver decodes by the flag, so nothing is negotiated.
  - Down: the bridge chooses.
  - Up: a new `CMD` op `SET_CODEC` chooses; every HELLO resets it to PCM16.
- Default: USB uses PCM16, WSS uses ADPCM. In Plan 5 the bridge takes `--codec adpcm` to exercise the codec over USB.
- Credits and the S3 ring count decoded PCM bytes. `PLAYED`'s CRC-32 stays over PCM; the bridge decodes its own encoded frames with the same decoder and compares. The two decoders must agree bit for bit (integer arithmetic only).
- `protocol/vectors.json` gains encode and decode pairs that both implementations pass.
- Speech quality is measured, not assumed: the twelve takes in `bridge/takes/` are encoded, decoded and sent through `gpt-transcribe` again and compared with the earlier 11 of 12. This calls the OpenAI API and needs the user's yes first.

### 4.8 Pairing: `walkie pair`

Run from the user's own terminal.

1. Find the S3 on USB. It must be running walkie (app1); under on-the-beat the command refuses and says why.
2. Generate `K` and write it to `pair.key.new`. The old `pair.key` is untouched.
3. Send `PAIR_SET(K)`. It is accepted on USB only and never over WSS.
4. The S3 shows a confirmation, built like SWITCH_CONFIRM: front key yes, side key no, no answer in 30 s counts as no. This is the control that stops a stranger's USB port from re-pairing the device to their own key and Wi-Fi.
5. On yes the S3 stores `K` in NVS and answers `PAIR_OK`; the PC renames `pair.key.new` to `pair.key`.
6. Both sides HELLO again and a sealed PING/PONG confirms it. The command prints that the S3 answers to the key. It never prints the key, and no log line, console line or LOG frame contains it.

If `PAIR_OK` is lost, `PAIR_SET` is resent for the same `K` (idempotent) up to three times, and then a sealed PING with the new key decides. On any failure the old `pair.key` stays, so the two sides cannot end up with different keys.

`walkie pair --forget` needs the same confirmation on the S3, erases the key there and deletes `pair.key`; the device then returns to unpaired plaintext operation.

### 4.9 Plan 5 deliverables and tests

Sealing and opening on both sides, session key derivation, the transport seam, ADPCM on both sides, the `PAIR_SET`/`PAIR_OK`/`SET_CODEC` operations, the confirmation screen, `walkie pair`, new vectors.

- Vectors for sealing and ADPCM, generated by Node's `crypto` and a reference encoder, pass in the bridge and the firmware host tests. How the host build gets an AES-GCM implementation (mbedtls is not on the PC) is a plan decision.
- Machine tests for the confirmation screen's priority and timeout.
- A device gate: a TEST op makes the real S3 run the vectors through mbedtls, then a full turn runs sealed over USB, once with PCM16 and once with ADPCM. It needs the user's yes before COM8 is opened.

## 5. Plan 6 design

### 5.1 Relay (`relay/`)

- A small Node app with its own `package.json` (`ws`) and `fly.toml`, deployed as a separate Fly app.
- `wss://<app>.fly.dev/r/<room id>?role=pc|device`. A room holds at most one PC and one device; a second connection of the same role replaces the first.
- It forwards each binary message unchanged to the peer and drops it if the peer is absent. It does not buffer and does not parse.
- Limits on total connections and per IP.
- The bridge uses Node 24's built-in `WebSocket`, so its only dependency stays `serialport`.

### 5.2 S3: Wi-Fi and WSS

- Paired and with at least one saved network, the S3 joins Wi-Fi and the relay in the background and stays connected. Reconnect backoff is 1, 2, 4 seconds and so on up to 30.
- The relay's certificate is verified against a root bundle. There is no insecure mode. *Amended in Plan 6:* the bundle is two pinned roots, ISRG Root X1 and ISRG Root X2 (`firmware/src/relay_roots.h`), so the relay must present a Let's Encrypt chain to one of them, as `*.fly.dev` does. If Let's Encrypt stops cross-signing its newer roots to these, the S3 needs the new root and a flash; `tools/check-relay-roots.mjs` shows it first. The S3 does not check `Sec-WebSocket-Accept`: TLS names the relay, and the relay can neither read nor forge a sealed frame.
- TLS memory on top of the audio tasks is the main risk. Heap is measured on the device; if it does not fit, the ring size changes, not the verification.
- `walkie wifi add|list|remove` takes the password in the user's terminal without echo and sends it through the sealed USB link, so it is never in plaintext. At most four networks.

### 5.3 USB and network together

- The S3 keeps both transports. It sends on the one where it last saw a HELLO, and a HELLO on the other transport switches it over and marks the first down.
- The bridge prefers USB: if it finds the S3's serial port it uses it, and only then the relay. When the port appears while on the relay it switches to USB.
- A switch is not seamless. A turn in progress is abandoned, as on any link loss.
- *Amended in Plan 6:* the S3 starts on USB. A frame other than HELLO that arrives on the transport not in use is dropped before it is opened, so it spends no replay counter. PAIR is taken over USB only.

### 5.4 Not connected

- OFFLINE says which link is down: no Wi-Fi, relay unreachable, PC offline.
- Online still means a sealed PONG arrived. The PING timeout is 3 s on USB (as today) and 10 s on WSS, so a phone hotspot's jitter does not read as a disconnect. The PING interval on WSS is chosen against battery in Plan 6. *Plan 6:* the bridge pings every 5 s on the relay, with the 10 s timeout; the S3 hangs up a relay that has sent nothing for 70 s (the relay pings every 30 s) and dials again.
- When the PC sleeps the bridge stops and the S3 shows PC offline. Windows power settings and starting the bridge at login are not changed by this work; both are the user's to ask for.

### 5.5 Over a WAN

- Round trips of 100-300 ms: the credit window and the S3 ring must cover them. Downstream ADPCM is about 12 KB/s; the sizes are measured on the device.
- The 55 s approval deny stays; it is watched, not tuned in advance.

### 5.6 Plan 6 tests

- Relay: `node:test`, the relay in process with fake clients: pairing, replacement, no buffering, limits.
- Bridge: a WSS variant of `fake-s3`; the existing turn tests run again over it.
- Firmware host tests: reconnect backoff and transport choice, which are plain logic. Wi-Fi and WSS themselves can only be exercised on the device.
- Device gates, each needing the user's yes at that moment:
  - L: against the deployed relay, a software S3 from the PC over `wss://` proves TLS, sealing and room pairing.
  - M: the real S3 on the home Wi-Fi with the cable out, one full turn including an approval, and a mid-session USB unplug and replug.
  - N: the user takes it to another network (a phone hotspot) and uses it, and measures an hour of standby drain. Only the user can do this one.

## 6. Actions that are the user's call

Each is asked when it comes up; none is assumed from approval of this document.

- Logging in to Fly, choosing the app name and region, reading the cost estimate.
- `fly deploy`: it publishes a public service.
- Typing Wi-Fi passwords in their own terminal.
- Flashing the S3 and opening COM8.
- Calls to the OpenAI API (the ADPCM quality check).

## 7. Open questions and limits

1. **Where it will be used.** If any of those networks blocks `fly.dev` (for example inside mainland China), the relay cannot be reached there and the hosting choice or domain must change. *Answered 3 Oct 2026:* only networks that can reach `fly.dev` are in scope. The relay host is a setting (`walkie relay <host>`, on the PC and the S3), so moving the relay needs no new firmware.
2. `esp_websocket_client` or another WebSocket library, and whether the host build can use mbedtls: both are verified in the plans, not decided here. *Answered in Plan 6:* the S3 uses its own WebSocket codec (`proto/ws`, host-tested and checked against the relay byte for byte) over the Arduino core's `WiFiClientSecure`, which is mbedtls; the host build keeps the reference crypto of Plan 5.
3. Standby battery cost of staying connected is unknown until measured (gate N).
4. A device in the wrong hands exposes `K` and the saved Wi-Fi passwords (§4.6). Re-pairing revokes `K`; there is no remote wipe.
5. Seamless handover between USB and network, and several devices per PC, are out of scope.
