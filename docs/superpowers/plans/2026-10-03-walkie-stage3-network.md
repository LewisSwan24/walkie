# Walkie Stage 3, plan 6 of 6: Outside. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use walkie away from the cable. A paired S3 that holds a Wi-Fi network and a relay host joins the network and dials the relay over TLS; the bridge dials the same relay when the S3 is not on USB; the relay passes the sealed frames of plan 5 between them without being able to read or forge one. The cable still wins whenever it is there, the S3's OFFLINE screen says which link is missing, and the networks and the relay host are set over the sealed USB link by `walkie wifi` and `walkie relay`.

**Architecture:** The relay (`relay/`, Node 24 and `ws`, one always-on Fly.io machine) keeps rooms of at most one PC and one device and forwards each WebSocket binary message unchanged; one message is one link frame's envelope (the bytes COBS carries on USB, without COBS). A room is named by HKDF of the pairing key, so only the two holders of the key can find it. On the bridge, `openRelayPort` makes the relay look like a serial port to the `Link` (COBS in and out), the `Link` takes its ping clock from the port (1 s / 3 s on USB, 5 s / 10 s on the relay) and backs its reconnects off from 1 s to 30 s, and `chooseTransport` uses the cable when the S3 is on it, the relay when not, and moves back to the cable when it appears. Settings travel in a new NET frame (0x33) that a paired S3 takes only sealed. On the firmware the decisions are pure, host-tested C++ in `firmware/lib/proto`: `NetConf` (the settings and their NVS blob), `Backoff`, `TransportSelector` and `offlineReason` (`netstate`), the WebSocket client codec (`ws`), and the `Router` that sends every frame to the gate from the transport of the last HELLO. The device side is thin: `netconf_nvs.cpp`, `netlink.cpp` (Wi-Fi, `WiFiClientSecure` against two pinned roots, the WebSocket over it) and `usblink.cpp`, which now carries frames on either transport.

**Tech Stack:** Node 24 (ESM, `node:test`, the built-in `WebSocket` on the bridge, so `serialport` stays its only dependency); the relay is its own package with `ws` as its only dependency, a `Dockerfile` and a `fly.toml`; C++11 on PlatformIO (`espressif32@6.13.0`, Arduino `WiFi` and `WiFiClientSecure`, which is mbedtls, and Preferences for NVS), the pure logic compiled by `g++ -std=gnu++11 -Wall -Wextra -Werror` through `firmware/host/run.mjs`; Fly.io for the relay (the person's account, deployed by the person).

**Spec:** `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`. This plan implements §5 (5.1 to 5.6) and runs the plan 5 gate that §4.9 left for the device. The person answered §7.1 on 3 Oct 2026: only networks that can reach `fly.dev` are in scope, and the relay host is a setting rather than a constant. Task 16 writes that answer into §7, and writes into §5 what building this plan decided: the roots are two pinned ones, PAIR stays on USB, frames from the transport not in use are dropped before they are opened, the WSS ping is 5 s with a 10 s timeout, and a silent relay is hung up after 70 s. Plan 5's §4.1 split of `usblink.cpp` into a frame layer and a transport is made here in the smallest form that carries a second transport: the `Router` and a tagged TX queue, rather than a new module.

**Task 1 comes first and needs the S3.** Plan 5 has never run on the real S3. Task 1 flashes it and runs its gate, each with the person's yes at that moment. Tasks 2 to 16 need no S3, no network beyond `localhost`, no API and no `claude`, and each can go to a worker; they may run before Task 1 if the person prefers, since none depends on the device. After Task 16 come gates L, M and N (README, "Away from the cable"): L needs a relay the person has deployed, M and N need the S3 and the person.

**How this plan was checked.** Plan 6 was built once, task by task, before it was written down. The code blocks below are those commits' files, and each task's *Expected* lines are what the commands printed when its tests were put on the commit before it (red) and the rest of its files after them (green) in a clean worktree, with the whole suite and the firmware build run on every commit. That worktree checks files out with CRLF, as this repo does (`core.autocrlf`), and it caught one test that had passed where it was written: Task 14's check of `relay_roots.h` expected an LF ending, and now takes either. Replaying the whole plan onto the commit that holds the spec and plan 5 (`6372918`) gives, task by task, the tree of the original commits; that was done with the plan's own blocks, by a script that applies each *In, replace*, *Replace the whole of*, *Create* and *Append to the end of* block exactly as written. **Nothing in this plan has run on the real S3, and nothing has run against a deployed relay.** The device code (`netlink.cpp`, `netconf_nvs.cpp`, the new paths of `usblink.cpp`, the screen) was only compiled. The relay ran in process and from `relay/bin/relay.js`, never in its Docker image or on Fly. The S3's WebSocket bytes were checked against the relay byte for byte (`relay/test/device-bytes.test.js`), and the pinned roots against `debug.fly.dev` with `tools/check-relay-roots.mjs`.

The new code was also attacked by hand: a condition inverted, a boundary moved by one, a step left out, one mutant at a time, and the tests run against each. Every mutant that survived got a test, in the task that owns the code, before this plan was written, except these, which change nothing a test can see: in `NetConf`, the size bound in `begin()` and four overrun checks in `decode()` that a second check repeats, and two "past the last" clears that `remove()`'s `memset` repeats (Task 10); in `ws.cpp`, a length check that the NUL terminator check repeats and a wait for 16 header bytes that only avoids reading past the buffer with the same result (Task 13); in the `Router`, treating every delivered frame as a HELLO, since a HELLO on the transport in use changes nothing (Task 14); in the room id, an empty HKDF salt against a one-byte one in JavaScript's own check (Task 3); in `openRelayPort`, skipping an empty chunk (Task 4); and in gate L, the check that the stand-in S3 is still in the room at the end of the hold, which only a relay that drops it in the last half second would show (Task 16). Review Focus lists what the tests do not reach.

## Global Constraints

- **The S3, the serial port and flashing are touched only in Task 1 and in gates M and N, and each action only with the person's fresh yes.** Before each such step ask with the AskUserQuestion tool and say exactly what will be done and how the S3 is put back. Only a clear yes in that answer counts: not 「继续」, not an earlier yes, not a yes for another run; a re-run after a fix is a new question. No test in this plan opens a serial port: the tests use the stand-in S3 (`bridge/test/helpers/fake-s3.js`), alone or behind a relay on `127.0.0.1`. The parts of `bridge/bin/walkie.js` that look for the S3 (`findS3Port`) cannot be tested without opening its port and are covered by the gates only. Gates M and N begin by putting this plan's firmware on the S3 (`node tools/flash.mjs`), pairing it (`node bridge/bin/walkie.js pair`, a key press) and setting the relay and a network (`node bridge/bin/walkie.js relay <host>`, then `node bridge/bin/walkie.js wifi add <network>`, where the person types the password), and they run real turns, so they also use the real `claude` and the speech API: each of these is its own question.
- **Fly.io is the person's.** Logging in, the app name, the region and `fly deploy` are theirs; no step of this plan logs in to Fly or deploys anything. Gate L runs against a relay they have deployed, or against `node relay/bin/relay.js` on this machine.
- **Wi-Fi passwords are typed only by the person, in their own terminal** (`walkie wifi add`, no echo, twice). A password never appears in a test, a log line, a LOG frame, a LIST reply, a file on the PC or a commit; tests use made-up networks. On the S3 the networks live in NVS, namespace `walkie`, key `netconf`, written only by the firmware when a sealed NET frame asks.
- **The pairing key stays as plan 5 left it:** never read, listed, logged or printed; `%APPDATA%\walkie\pair.key` is read only by the two bins. The room id is derived from it and is not secret from the relay, which logs only its first characters. `%APPDATA%\walkie\keys.env` stays untouchable.
- **TLS has no insecure mode.** The S3 trusts exactly the PEMs in `firmware/src/relay_roots.h` (ISRG Root X1 and X2) through `setCACert`; nothing calls `setInsecure`, and no option turns verification off. The bridge uses `wss://` for every host except a loopback address (`127.0.0.1`, `localhost`, `[::1]`), where tests use `ws://`.
- **The wire, from `protocol/frames.md` ("Relay", "The S3 on two transports", "Network settings").** One WebSocket binary message is one frame's envelope, at most 1032 bytes; the relay refuses a message over 1100 bytes and closes on a text message with 1003; a second connection of the same role in a room closes the first with 4000. Over the relay the bridge pings every 5 s and gives up after 10 s without a PONG; the S3 counts itself online for 3 s after a PING on USB and 10 s on the relay. NET (0x33) is taken only sealed. Reconnects on both sides wait 1, 2, 4 s and so on up to 30 s.
- **The firmware's pure code (`firmware/lib/proto`, `firmware/lib/ui`) includes no Arduino, M5, WiFi or mbedtls header, allocates nothing and writes only into buffers it is given**, and compiles under `-Wall -Wextra -Werror` as C++11, as in plan 5. Time is `uint32_t` milliseconds compared as `a - b`.
- **The S3 is flashed only by `node tools/flash.mjs`**, as before; NVS is written only by the firmware.
- **`walkie` is never run without `--command` in a test or a smoke run**, as before; nothing in this plan runs the real `claude` or a speech API.
- Node 24, ESM, `node:test`. The bridge's dependencies stay `serialport` alone; the relay's are `ws` alone. A test that depends on a time limit uses an injected clock, a short port clock (`{ pingEveryMs: 100, pongTimeoutMs: 400 }`) or `t.mock.timers`. A command-line tool ends with `process.exitCode`, never `process.exit()` after a socket was used: on Windows that aborts Node in libuv (`async.c`).
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise. Commit by explicit path (`git add <files>`), never `git add -A` or `git commit -a`. No push and no amend. The commands below name the commit's model as Claude Opus 5.5 in the `Co-Authored-By:` line; change the name if another model writes the commit, and a session on a model that is not Claude leaves the line out.

### Where this plan decides what the spec leaves open

The spec leaves these open; this plan decides them, and the tests pin each one.

- **The carrier.** One WebSocket binary message is one envelope: type, flags, seq u16 LE, len u16 LE, payload, CRC-16, as COBS carries it on USB but without COBS and the 0x00 delimiters. The bridge's relay port converts to and from COBS, so the `Link` is unchanged; the S3 hands envelopes from the relay to the same frame handler as USB's.
- **The room.** The first 16 bytes of `HKDF-SHA256(K, empty salt, "walkie-room-v1")` in lower-case hex: `wss://<host>/r/<room>?role=pc|device`. A shared vector (`room` in `protocol/seal-vectors.json`) pins both implementations.
- **The relay.** Rooms live in memory on one machine that never stops (`fly.toml`: `auto_stop_machines = "off"`, `min_machines_running = 1`). Limits: 64 connections in all and 8 per address (`Fly-Client-IP` when `TRUST_PROXY=1`). It pings every client every 30 s and drops one that does not answer; `/healthz` answers `ok`. It logs only that rooms were joined, with the first characters of the id.
- **The bridge's choice of transport.** The cable when the S3's port is there; if the port is there but will not open, that is the error, with no fall-back to the relay. The relay only when there is no cable and both a `pair.key` and a relay host are set. While on the relay it looks for the cable every 3 s and closes the relay port when it appears, and the `Link` opens again on USB. A relay port closed by a second bridge with the same key holds the relay back for 5 minutes, so two PCs do not take the room from each other forever. A failed open of the cable is retried in 1 s rather than backed off.
- **Settings.** The relay host lives in `%APPDATA%\walkie\relay.txt` on the PC and in the S3's NVS; `walkie relay <host>` writes both (the S3's over a sealed NET frame, so it needs the S3 on the cable and paired), `--pc-only` only the PC's, `--forget` removes them. A host is 1 to 63 characters of `A-Z a-z 0-9 . -`, without scheme or path. `walkie wifi add <ssid>` asks for the password twice without echo (empty means an open network), `list` shows the names and the S3's relay host, `remove <ssid>` forgets one. The S3 keeps at most four networks, tries them in the order they were added, and keeps its old settings if writing NVS fails.
- **The NET frame (0x33).** Requests: `1` WIFI_ADD (`ssidLen, ssid, passLen, pass`), `2` WIFI_REMOVE (`ssidLen, ssid`), `3` WIFI_LIST, `4` RELAY_SET (`hostLen, host`), `5` RELAY_CLEAR. Replies: `0x80` OK (the op answered), `0x81` ERR (the op answered, a reason: 1 bad, 2 full, 3 unknown network, 4 storage), `0x82` LIST (`count, (len, ssid)*, hostLen, host`). An SSID is 1 to 32 bytes without NUL, a password empty or 8 to 63 bytes without NUL. A paired S3 drops a plain NET frame; an unpaired S3 takes none.
- **The S3's WebSocket client.** Its own codec (`proto/ws`): the upgrade request, the 101 answer read up to its blank line (at most 1024 bytes), masked frames out, unmasked frames in, ping answered with pong, close read for its code. It does not check `Sec-WebSocket-Accept`: the TLS check has already named the relay, and the relay can neither read nor forge a sealed frame. It hangs up when nothing has come from the relay for 70 s.
- **The roots.** ISRG Root X1 and X2, taken by `tools/gen-relay-roots.mjs` from the certifi bundle PlatformIO installs and checked by SHA-256 fingerprint, written to `firmware/src/relay_roots.h`. `*.fly.dev` chains to X2 through Let's Encrypt's Root YE, cross-signed by X2 and X1 (checked 3 Oct 2026).
- **The S3's two transports.** It starts on USB, as before. It sends on the transport where it last took a HELLO, and a HELLO on the other transport moves it there. A frame other than HELLO from the transport not in use is dropped before the gate opens it, so it spends no replay counter, and counted apart (`rxOther`). PAIR is taken over USB only. The TX queue tags each frame with its transport when it is queued.
- **What OFFLINE says.** No network or no relay host set: 「插好 USB，运行 walkie」, as before; networks set but none joined: 「连不上 Wi-Fi」; joined but no relay: 「连不上中继」; the relay but no PC: 「电脑没在线：运行 walkie」. The S3 logs `link <state>` when that changes, `transport usb|relay|none` when it moves, and every 5 minutes `health battery <n>% heap <bytes> rssi <dBm> link <state>`, which gate N reads.
- **What changes in earlier plans:** `TYPE` gains `NET`; the `Link` takes `retryMaxMs` and reads `pingEveryMs` and `pongTimeoutMs` from the port; a failed open may carry `retryInMs`; `startBridge` takes `retry`; `parseWalkieCommand` knows `relay` and `wifi`; `usblink::online()` replaces `msSincePing()`; `Gate` says whether the last delivered frame came sealed (`lastSealed()`); `encodeFrame` is now COBS around the new `encodeEnvelope`; `fake-s3.js` learns NET, `answerPings` and the relay; `world()` takes `relay`. Nothing is removed, and every earlier test passes unchanged.

## Review Focus

These are the input classes and failure modes the plan's tests do not exercise. The final reviewer checks each deliberately.

1. **The device paths have only been compiled.** `netlink.cpp` (the join loop, the TLS handshake, the read pump, `sockLock` shared between the netlink task and the link's TX task), `usblink.cpp`'s routing (a frame queued for the relay just before the relay drops goes nowhere and is counted; frames tagged for USB while the relay is in use), `netconf_nvs.cpp` and the screen. Look for a lock held across a blocking TLS call that the other task needs, a frame written to the socket while it is being reopened, and anything that touches `WiFi` from two tasks at once (`netlink::rssi()` is called from the main loop).
2. **Memory for TLS next to audio.** The handshake needs tens of kilobytes of internal heap on top of the audio tasks, the RX task's 8192-byte stack and the new 12288-byte netlink stack. Static RAM went from 23.0% to 32.4% and flash from 27.5% to 43.8%; the heap during a handshake is unmeasured until gate M reads the health line. The spec's rule holds: if it does not fit, ring sizes change, not the verification. Latency is untested in the same way: every relay test runs on `127.0.0.1`, so whether the credit window and the S3's audio ring cover 100 to 300 ms round trips (spec §5.5), and whether the 55 s approval deny still leaves time, is first seen in gate M.
3. **A switch in the middle of a turn.** The cable plugged in while a reply streams over the relay: the turn is abandoned, as on any lost link. Check that the S3 does not keep an audio stream half on one transport and half on the other, that credit restarts from the HELLO, and that the bridge's 3 s cable poll cannot close a relay port that a turn is still waiting on without the `Link` saying so.
4. **A relay or network that comes and goes.** A Fly machine restart, a phone hotspot that drops for a minute, a captive portal that lets Wi-Fi join but not TLS: both ends must come back on their own with the 1 to 30 s backoff, the S3 must show 连不上中继 rather than nothing, and a TLS failure must never lead to a plain or unverified connection.
5. **Two bridges, one key.** A second `node bridge/bin/walkie.js` with the same `pair.key` (another PC) takes the room; the first holds back 5 minutes and says so. Check what the S3 sees across the swap (a new HELLO, a new session) and that nothing loops faster than the hold-back.
6. **Settings changed while connected.** `walkie wifi remove` of the network in use, or `walkie relay` to a new host, bumps the settings generation: netlink must hang up and choose again, and a removed network must not stay joined.
7. **Secrets in logs.** Search `netlink.cpp`, `net-cli.js`, `prompt.js`, `net.js` and the relay's log lines for a password byte, a password's length in a message, or more of the room id than its first characters.
8. **The pinned roots ageing.** If Let's Encrypt stops the cross-signs that let Root YE chain to X2 and X1, every S3 stops reaching the relay until it is flashed with the new root. `tools/check-relay-roots.mjs` is the early warning; nothing runs it on a schedule.
9. **The equivalent mutants listed in "How this plan was checked."** Check that none of them is in fact observable.
10. **Not done, on purpose.** No seamless handover and no more than one S3 per key (spec §7.5); the bridge does not start at login and Windows power settings are untouched (spec §5.4); the tools that open the link (`gate-h.mjs`, `gate-p5.mjs`, the dev CLI) stay USB-only; the relay keeps nothing and has no accounts, so anyone who knew a room id could take the PC's place in it, though not read or forge a frame.

## Files

Every file this plan touches, by what it does to it (the tasks list them again, each with its tests).

- Create (65): `relay/.dockerignore`, `relay/Dockerfile`, `relay/bin/relay.js`, `relay/fly.toml`, `relay/package-lock.json`, `relay/package.json`, `relay/src/server.js`, `relay/test/bin.test.js`, `relay/test/server.test.js`, `bridge/src/link/room.js`, `bridge/test/link/room.test.js`, `firmware/host/test_room.cpp`, `firmware/lib/proto/src/proto/room.cpp`, `firmware/lib/proto/src/proto/room.h`, `bridge/src/link/relay-port.js`, `bridge/test/link/relay-port.test.js`, `bridge/test/link/link-timing.test.js`, `bridge/test/helpers/relay-s3.js`, `bridge/test/relay-turn.test.js`, `bridge/src/link/transport.js`, `bridge/test/link/transport.test.js`, `bridge/src/config/relay.js`, `bridge/src/link/open-port.js`, `bridge/src/relay-cli.js`, `bridge/test/config/relay.test.js`, `bridge/test/link/open-port.test.js`, `bridge/test/relay-cli.test.js`, `bridge/test/link/net-messages.test.js`, `firmware/host/test_net_messages.cpp`, `firmware/host/test_netconf.cpp`, `firmware/lib/proto/src/proto/netconf.cpp`, `firmware/lib/proto/src/proto/netconf.h`, `firmware/src/netconf_nvs.cpp`, `firmware/src/netconf_nvs.h`, `bridge/src/link/exchange.js`, `bridge/src/net-cli.js`, `bridge/src/net.js`, `bridge/src/prompt.js`, `bridge/test/helpers/fake-net.js`, `bridge/test/link/exchange.test.js`, `bridge/test/net-cli.test.js`, `bridge/test/net.test.js`, `bridge/test/prompt.test.js`, `firmware/host/test_netstate.cpp`, `firmware/lib/proto/src/proto/netstate.cpp`, `firmware/lib/proto/src/proto/netstate.h`, `firmware/host/test_ws.cpp`, `firmware/lib/proto/src/proto/ws.cpp`, `firmware/lib/proto/src/proto/ws.h`, `relay/test/device-bytes.test.js`, `firmware/lib/proto/src/proto/router.cpp`, `firmware/lib/proto/src/proto/router.h`, `firmware/src/netlink.cpp`, `firmware/src/netlink.h`, `firmware/src/relay_roots.h`, `tools/check-relay-roots.mjs`, `tools/gen-relay-roots.mjs`, `tools/lib/roots.mjs`, `tools/test/roots.test.mjs`, `firmware/host/test_offline.cpp`, `firmware/lib/ui/src/ui/offline.cpp`, `firmware/lib/ui/src/ui/offline.h`, `tools/gate-l.mjs`, `tools/lib/gate-l.mjs`, `tools/test/gate-l.test.mjs`
- Modify (35): `package.json`, `firmware/host/run.mjs`, `protocol/frames.md`, `protocol/gen_seal_vectors.mjs`, `protocol/seal-vectors.json`, `bridge/src/link/link.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/helpers/world.js`, `bridge/bin/walkie.js`, `bridge/src/cli.js`, `bridge/src/main.js`, `bridge/test/cli.test.js`, `bridge/test/main.test.js`, `bridge/test/walkie-bin.test.js`, `bridge/src/link/frame.js`, `bridge/src/link/messages.js`, `bridge/test/link/codec.test.js`, `firmware/host/test_gate.cpp`, `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/gate.cpp`, `firmware/lib/proto/src/proto/gate.h`, `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/main.cpp`, `firmware/src/usblink.cpp`, `bridge/src/dev/args.js`, `bridge/src/pair.js`, `firmware/host/test_codec.cpp`, `firmware/lib/proto/src/proto/frame.cpp`, `firmware/src/status.h`, `firmware/src/usblink.h`, `firmware/src/screen.cpp`, `firmware/src/screen.h`, `README.md`, `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`

---

### Task 1: Gate P5 on the real S3 (no code, no commit)

Plan 5 sealed the link, but its firmware has never run on the S3, and everything this plan puts on the S3 sits on top of it. This task flashes the plan 5 firmware, which is what the repo's `main` holds at `6372918`, and runs `tools/gate-p5.mjs`, which checks on the chip the self-test, pairing by a key press, the sealed link, a refused plain link and wrong key, a refused re-pair and an ADPCM take. It uses no API and a throwaway key, and ends with the S3 unpaired. Each command below touches the S3 and needs the person's yes at that moment (Global Constraints). The person must be at the S3 for two presses.

**Files:** none. This task changes nothing in the repo.

**Interfaces:**
- Consumes: `tools/flash.mjs`, `tools/gate-p5.mjs`, `node bridge/bin/walkie.js pair --forget` (plan 5).
- Produces: No files. A result: every scene of gate P5 held on the real S3, or a list of the scenes that did not, which stops this plan's device work until it is fixed.

- [ ] **Step 1: Ask, then flash the plan 5 firmware**

Ask the person with AskUserQuestion: "Flash the plan 5 firmware onto the S3 (COM8, app1 and otadata only, via `node tools/flash.mjs`)? It replaces the plan 4 firmware; `node tools/boot.mjs app0` still boots on-the-beat." Only on a clear yes:

Run: `node tools/flash.mjs`
Expected: the build succeeds, the partition layout is checked, and the last lines are `walkie (<n> bytes) is in app1 and selected; the S3 is restarting into it.` and `Back to on-the-beat: node tools/boot.mjs app0`; the S3 then shows the OFFLINE screen (「插好 USB，运行 walkie」). Nothing else may hold COM8: stop any `walkie` or `walkie-dev` first.

- [ ] **Step 2: Ask, then run gate P5**

Ask the person with AskUserQuestion: "Run gate P5 on the S3 (COM8)? It pairs the S3 with a throwaway key, then makes it forget that key; you need to be at the S3 for two presses: the side key in 'pair again' and the front key at the end, each asked for on the screen and in this terminal, 35 s each." Only on a clear yes:

Run: `node tools/gate-p5.mjs`
Expected: seven `PASS` lines, in this order: `selftest: the mbedtls adapter agrees with the RFC 5869 and NIST vectors on the chip`, `pair: the front key accepts, and the S3 answers OK`, `sealed: with the key the link comes up, pings are answered and the self-test runs sealed`, `plain refused: a bridge with no key gets no link from a paired S3`, `wrong key: another key gets no link, and says so`, `pair again: the side key refuses, and the first key still works`, `adpcm: a 1.2 s take comes back as PCM, whole, with an EOS`; then `gate P5: every scene held` and exit code 0. A `FAIL cleanup` line means the S3 kept the throwaway key: ask before running `node bridge/bin/walkie.js pair --forget` (front key on the S3).

- [ ] **Step 3: Record the result**

If every scene held, write that down with the date for the final report and go on to Task 2. If a scene failed, stop: report the `FAIL` lines to the person, and do not start gates L, M or N until the failure is understood and fixed (a fix to plan 5's code is its own change, with its own test first). Tasks 2 to 16 change no device behaviour that gate P5 checks, so they may continue only if the person says so.

---

### Task 2: The relay

The relay is a separate package, `relay/`, with `ws` as its only dependency, deployed by the person as one always-on Fly.io machine. `startRelay` takes WebSocket upgrades at `/r/<room>?role=pc|device` (a room is 32 lower-case hex characters), keeps at most one PC and one device per room (a second of the same role closes the first with 4000), forwards each binary message unchanged to the other end and drops it when there is none, refuses messages over 1100 bytes and text messages, enforces the connection limits, pings every client every `pingEveryMs` and drops those that do not answer, and answers `GET /healthz`. `relay/bin/relay.js` starts it from the environment. The tests run the relay in process on `127.0.0.1` with `ws` clients. The package files come first and `npm ci --prefix relay` installs `ws`, so that the tests fail for the reason they should; the bridge's tests import the relay from Task 4 on, so this install is needed for the rest of the plan.

**Files:**
- Create: `relay/package.json`, `relay/package-lock.json`, `relay/.dockerignore`, `relay/Dockerfile`, `relay/bin/relay.js`, `relay/fly.toml`, `relay/src/server.js`
- Modify: `package.json`
- Test (new): `relay/test/bin.test.js`, `relay/test/server.test.js`

**Interfaces:**
- Consumes: Nothing from earlier tasks.
- Produces: `relay/src/server.js`: `MAX_MESSAGE` (1100), `CLOSE_REPLACED` (4000), `startRelay({ port = 0, host = '127.0.0.1', maxConnections = 64, maxPerIp = 8, trustProxy = false, pingEveryMs = 30_000, log }): Promise<{ port, stats(), close() }>`.
- Produces: `relay/bin/relay.js` (env `PORT`, `HOST`, `TRUST_PROXY`, `MAX_CONNECTIONS`, `MAX_PER_IP`), `relay/Dockerfile`, `relay/fly.toml`, `relay/package.json`; the root `npm test` runs `npm --prefix relay test`.

- [ ] **Step 1: Write the relay's package files and install its dependency**

Create `relay/package.json`:

```json
{
  "name": "walkie-relay",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "A blind relay for walkie: forwards sealed frames between a PC and a device that both dial out to it.",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "start": "node bin/relay.js",
    "test": "node --test \"test/*.test.js\""
  },
  "dependencies": {
    "ws": "^8.22.0"
  }
}
```

Create `relay/package-lock.json`:

```json
{
  "name": "walkie-relay",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "walkie-relay",
      "version": "0.1.0",
      "dependencies": {
        "ws": "^8.22.0"
      },
      "engines": {
        "node": ">=24"
      }
    },
    "node_modules/ws": {
      "version": "8.22.0",
      "resolved": "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
      "integrity": "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==",
      "license": "MIT",
      "engines": {
        "node": ">=10.0.0"
      },
      "peerDependencies": {
        "bufferutil": "^4.0.1",
        "utf-8-validate": ">=5.0.2"
      },
      "peerDependenciesMeta": {
        "bufferutil": {
          "optional": true
        },
        "utf-8-validate": {
          "optional": true
        }
      }
    }
  }
}
```

Then install the relay's one dependency, which the tests import:

Run: `npm ci --prefix relay`
Expected: `added 1 package`, no error.

- [ ] **Step 2: Write the failing tests**

Create `relay/test/bin.test.js`:

```js
// bin/relay.js reads its settings from the environment and serves the same relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'relay.js');

function run(t, env) {
  const child = spawn(process.execPath, [bin], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const listening = new Promise((resolve) => {
    const timer = setInterval(() => {
      const m = /listening on port (\d+)/.exec(out);
      if (m) {
        clearInterval(timer);
        resolve(Number(m[1]));
      }
    }, 20);
    exited.then(() => clearInterval(timer));
  });
  return { listening, exited, err: () => err };
}

test('it listens on PORT and answers /healthz', async (t) => {
  const { listening } = run(t, { PORT: '0', HOST: '127.0.0.1' });
  const port = await Promise.race([listening, new Promise((_, no) => setTimeout(() => no(new Error('no start-up line')), 5000))]);
  assert.ok(port > 0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});

test('a setting that is not a whole number stops it with a message that names the setting', async (t) => {
  const { exited, err } = run(t, { PORT: '0', HOST: '127.0.0.1', MAX_PER_IP: 'many' });
  assert.notEqual(await exited, 0);
  assert.match(err(), /MAX_PER_IP must be a whole number/);
});
```

Create `relay/test/server.test.js`:

```js
// The relay with real WebSocket clients on a local port: rooms, replacement, no buffering, limits. It never parses what it forwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { CLOSE_REPLACED, MAX_MESSAGE, startRelay } from '../src/server.js';

const ROOM = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

async function relayFor(t, options = {}) {
  const relay = await startRelay(options);
  t.after(() => relay.close());
  return relay;
}

// A client with everything it received, resolved once it is open.
async function client(relay, role, { room = ROOM, headers } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${room}?role=${role}`, { headers });
  ws.got = [];
  ws.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.on('message', (data, isBinary) => ws.got.push({ data: Buffer.from(data), isBinary }));
  ws.on('error', () => {});
  await once(ws, 'open');
  return ws;
}

// What a refused upgrade answered: the status line's code.
async function refusedWith(relay, pathAndQuery, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}${pathAndQuery}`, { headers });
  ws.on('error', () => {});
  const [, res] = await once(ws, 'unexpected-response');
  res.resume();
  return res.statusCode;
}

const until = async (check, what, ms = 3000) => {
  for (let waited = 0; !check() && waited < ms; waited += 10) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), what);
};

test('a PC and a device in one room hear each other, and the bytes arrive as they were sent', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  const down = Buffer.from(Array.from({ length: 1032 }, (_, i) => (i * 7) & 0xff));
  const up = Buffer.from([0, 1, 2, 3, 0, 255]);
  pc.send(down);
  device.send(up);
  await until(() => device.got.length === 1 && pc.got.length === 1, 'both messages arrive');
  assert.deepEqual(device.got[0], { data: down, isBinary: true });
  assert.deepEqual(pc.got[0], { data: up, isBinary: true });
  assert.equal(relay.stats().forwarded, 2);
});

test('nothing is kept for a peer that is not there: a message sent early is gone when the peer arrives', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  pc.send(Buffer.from('early'));
  await until(() => relay.stats().dropped === 1, 'the relay dropped it');
  const device = await client(relay, 'device');
  pc.send(Buffer.from('late'));
  await until(() => device.got.length === 1, 'the later one arrives');
  assert.equal(device.got[0].data.toString(), 'late');
  assert.equal(device.got.length, 1);
});

test('a second connection of the same role replaces the first, which is told so, and traffic goes to the new one', async (t) => {
  const relay = await relayFor(t);
  const first = await client(relay, 'device');
  const pc = await client(relay, 'pc');
  const second = await client(relay, 'device');
  assert.equal(await first.closed, CLOSE_REPLACED);
  pc.send(Buffer.from('hello'));
  await until(() => second.got.length === 1, 'the new device hears it');
  assert.equal(first.got.length, 0);
  assert.equal(relay.stats().replaced, 1);
  assert.equal(relay.stats().connections, 2);
});

test('rooms are separate: a message in one never reaches another', async (t) => {
  const relay = await relayFor(t);
  const deviceB = await client(relay, 'device', { room: OTHER }); // first, so a message that went to "any device" would find it
  const pcA = await client(relay, 'pc', { room: ROOM });
  const deviceA = await client(relay, 'device', { room: ROOM });
  pcA.send(Buffer.from('for A'));
  await until(() => deviceA.got.length === 1, 'A hears it');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(deviceB.got.length, 0);
  assert.equal(relay.stats().rooms, 2);
});

test('a room is forgotten when both have gone, and a peer that leaves is not written to', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  device.close();
  await device.closed;
  pc.send(Buffer.from('anyone?'));
  await until(() => relay.stats().dropped === 1, 'dropped, not sent to a closed socket');
  pc.close();
  await pc.closed;
  await until(() => relay.stats().rooms === 0, 'the room is gone');
  assert.equal(relay.stats().connections, 0);
});

test('only /r/<32 hex>?role=pc|device is let in: anything else is a 400 and holds no slot', async (t) => {
  const relay = await relayFor(t);
  assert.equal(await refusedWith(relay, `/r/${'a'.repeat(31)}?role=pc`), 400, 'short id');
  assert.equal(await refusedWith(relay, `/r/${'A'.repeat(32)}?role=pc`), 400, 'upper case id');
  assert.equal(await refusedWith(relay, `/r/${ROOM}?role=phone`), 400, 'unknown role');
  assert.equal(await refusedWith(relay, `/r/${ROOM}`), 400, 'no role');
  assert.equal(await refusedWith(relay, `/x/${ROOM}?role=pc`), 400, 'wrong path');
  assert.equal(relay.stats().connections, 0);
  assert.equal(relay.stats().refused, 5);
});

test('the total number of connections is limited, and a slot comes back when one closes', async (t) => {
  const relay = await relayFor(t, { maxConnections: 2, maxPerIp: 99 });
  const a = await client(relay, 'pc', { room: ROOM });
  await client(relay, 'device', { room: ROOM });
  assert.equal(await refusedWith(relay, `/r/${OTHER}?role=pc`), 503);
  a.close();
  await a.closed;
  await until(() => relay.stats().connections === 1, 'a slot is free');
  await client(relay, 'pc', { room: OTHER });
});

test('each address is limited, by the address the proxy reports when the relay trusts it', async (t) => {
  const direct = await relayFor(t, { maxPerIp: 1 });
  const first = await client(direct, 'pc', { room: ROOM });
  assert.equal(await refusedWith(direct, `/r/${OTHER}?role=pc`), 429, 'one address, one connection');
  first.close();
  await first.closed;
  await until(() => direct.stats().connections === 0, 'the connection is gone');
  await client(direct, 'pc', { room: OTHER }); // the address has its slot back

  const proxied = await relayFor(t, { maxPerIp: 1, trustProxy: true });
  await client(proxied, 'pc', { room: ROOM, headers: { 'fly-client-ip': '203.0.113.1' } });
  await client(proxied, 'pc', { room: OTHER, headers: { 'fly-client-ip': '203.0.113.2' } });
  assert.equal(await refusedWith(proxied, `/r/${'c'.repeat(32)}?role=pc`, { 'fly-client-ip': '203.0.113.1' }), 429);

  const untrusting = await relayFor(t, { maxPerIp: 1 });
  await client(untrusting, 'pc', { room: ROOM, headers: { 'fly-client-ip': '203.0.113.1' } });
  assert.equal(await refusedWith(untrusting, `/r/${OTHER}?role=pc`, { 'fly-client-ip': '203.0.113.2' }), 429, 'the header is ignored');
});

test('a message over the frame limit closes the sender and goes nowhere; a text message is refused', async (t) => {
  const relay = await relayFor(t);
  const pc = await client(relay, 'pc');
  const device = await client(relay, 'device');
  assert.equal(MAX_MESSAGE, 1100, 'the largest frame the link carries');
  pc.send(Buffer.alloc(1100));
  await until(() => device.got.length === 1, 'the largest frame goes through');
  pc.send(Buffer.alloc(1101));
  assert.equal(await pc.closed, 1009);
  device.send('text, not a frame');
  assert.equal(await device.closed, 1003);
  assert.equal(device.got.length, 1);
});

test('GET /healthz answers ok, and anything else that is not an upgrade is a 404', async (t) => {
  const relay = await relayFor(t);
  const ok = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
  assert.equal((await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}?role=pc`)).status, 404);
});

test('a peer that stops answering pings is dropped from its room', async (t) => {
  const relay = await relayFor(t, { pingEveryMs: 40 });
  const device = await client(relay, 'device');
  device._socket.pause(); // reads nothing, so it never says pong
  await until(() => relay.stats().connections === 0, 'the silent peer was reaped', 2000);
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `node --test relay/test/bin.test.js relay/test/server.test.js`
Expected: FAIL, 2 tests fail: `it listens on PORT and answers /healthz`, `a setting that is not a whole number stops it with a message that names the setting`; the file `relay/test/server.test.js` cannot load, because it imports `relay/src/server.js`, which does not exist yet.

- [ ] **Step 4: Write the implementation**

Replace the whole of `package.json` with:

```json
{
  "name": "walkie",
  "private": true,
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "npm --prefix bridge test && node --test \"tools/test/*.test.mjs\" && npm --prefix relay test && node firmware/host/run.mjs"
  }
}
```

Create `relay/.dockerignore`:

```
node_modules
npm-debug.log
.git
```

Create `relay/Dockerfile`:

```
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "bin/relay.js"]
```

Create `relay/bin/relay.js`:

```js
#!/usr/bin/env node
// Starts the relay from the environment: PORT (default 8080), HOST (default 0.0.0.0), TRUST_PROXY=1 behind Fly's proxy, MAX_CONNECTIONS,
// MAX_PER_IP. It logs only that rooms were joined, and only the first characters of a room id.
import { startRelay } from '../src/server.js';

const env = process.env;
const number = (name, fallback) => {
  const n = Number(env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
  return n;
};

const relay = await startRelay({
  port: number('PORT', 8080),
  host: env.HOST ?? '0.0.0.0',
  trustProxy: env.TRUST_PROXY === '1',
  maxConnections: number('MAX_CONNECTIONS', 64),
  maxPerIp: number('MAX_PER_IP', 8),
  log: (line) => console.log(line),
});
console.log(`walkie relay listening on port ${relay.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await relay.close();
    process.exit(0);
  });
}
```

Create `relay/fly.toml`:

```toml
# Fly.io settings for the relay. The app name and region are the person's to choose when they run
# `fly launch --no-deploy --copy-config --name <name> --region <region>` in this directory, which adds them here.
# One machine that never stops: rooms live in memory, and a stopped or second machine would split or drop them.
[build]

[env]
  PORT = "8080"
  TRUST_PROXY = "1"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = false
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/healthz"
    interval = "15s"
    timeout = "3s"
    grace_period = "5s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Create `relay/src/server.js`:

```js
// The relay: a blind pipe between a PC and a device that both dial out to it (docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md, 5.1).
// wss://<host>/r/<room id>?role=pc|device. A room holds at most one PC and one device, and a second connection of the same role replaces
// the first. Every binary message goes to the peer unchanged, and is dropped when the peer is not there: nothing is parsed or kept.
// The relay never sees a key. It cannot read the frames (they are sealed) and cannot forge one; it can only drop or delay them.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export const MAX_MESSAGE = 1100; // the largest frame the link carries (MAX_CHUNK in bridge/src/link/frame.js)
export const CLOSE_REPLACED = 4000;
const PATH = /^\/r\/([0-9a-f]{32})$/;
const PEER = { pc: 'device', device: 'pc' };

const refuse = (socket, status, text) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

// Resolves with { port, close(), stats() } once it is listening. `trustProxy` reads the client's address from Fly-Client-IP, which is
// what a proxy in front of the relay (Fly's) sets; without it the socket's own address is used.
export async function startRelay({
  port = 0,
  host = '127.0.0.1',
  maxConnections = 64,
  maxPerIp = 8,
  trustProxy = false,
  pingEveryMs = 30_000,
  log = () => {},
} = {}) {
  const rooms = new Map(); // id -> { pc, device }
  const perIp = new Map();
  const stats = { connections: 0, forwarded: 0, dropped: 0, replaced: 0, refused: 0 };

  const http = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/healthz';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'ok' : 'not found');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://relay');
    const match = PATH.exec(url.pathname);
    const role = url.searchParams.get('role');
    if (!match || !PEER[role]) {
      stats.refused++;
      return refuse(socket, 400, 'Bad Request');
    }
    const ip = (trustProxy && req.headers['fly-client-ip']) || req.socket.remoteAddress || '?';
    if (stats.connections >= maxConnections) {
      stats.refused++;
      return refuse(socket, 503, 'Service Unavailable');
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      stats.refused++;
      return refuse(socket, 429, 'Too Many Requests');
    }
    stats.connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, match[1], role, ip));
  });

  function join(ws, id, role, ip) {
    const room = rooms.get(id) ?? {};
    rooms.set(id, room);
    if (room[role]) {
      stats.replaced++;
      room[role].close(CLOSE_REPLACED, 'replaced');
    }
    room[role] = ws;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return ws.close(1003, 'binary frames only');
      const peer = rooms.get(id)?.[PEER[role]];
      if (peer && peer.readyState === peer.OPEN) {
        stats.forwarded++;
        peer.send(data, { binary: true });
      } else {
        stats.dropped++;
      }
    });
    ws.on('error', () => {}); // the close event follows
    ws.on('close', () => {
      stats.connections--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
      if (rooms.get(id)?.[role] === ws) delete rooms.get(id)[role];
      const now = rooms.get(id);
      if (now && !now.pc && !now.device) rooms.delete(id);
    });
    log(`${role} joined room ${id.slice(0, 4)}...`); // never the whole id: it is the way in
  }

  // A peer that went away without saying so (a phone leaving Wi-Fi) would hold its place in the room until the TCP timeout.
  const reaper = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, pingEveryMs);
  reaper.unref();

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });

  return {
    port: http.address().port,
    stats: () => ({ ...stats, rooms: rooms.size }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(reaper);
        for (const ws of wss.clients) ws.terminate();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };
}
```

- [ ] **Step 5: Run them and watch them pass**

Run: `node --test relay/test/bin.test.js relay/test/server.test.js`
Expected: PASS, 13 tests, 0 fail.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 808 tests, the tools' 17, the relay's 13, and `199 cases, 1050 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add package.json relay/.dockerignore relay/Dockerfile relay/bin/relay.js relay/fly.toml relay/package-lock.json relay/package.json relay/src/server.js relay/test/bin.test.js relay/test/server.test.js
git commit -m "Task 2: the relay: rooms for one PC and one device, blind forwarding, limits, health check, Fly files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The room id, in both implementations

A room is named by the pairing key, so that only the PC and the S3 that share a key meet: the first 16 bytes of `HKDF-SHA256(K, empty salt, "walkie-room-v1")`, as 32 lower-case hex characters. `protocol/gen_seal_vectors.mjs` adds a `room` vector computed with `node:crypto` directly, and both `bridge/src/link/room.js` and the firmware's `proto/room` pass it; the firmware's goes through plan 5's `Crypto` seam, so it runs on the reference crypto in the host tests and on mbedtls on the S3. `protocol/frames.md` gains its "Relay (plan 6)" section.

**Files:**
- Create: `bridge/src/link/room.js`, `firmware/lib/proto/src/proto/room.cpp`, `firmware/lib/proto/src/proto/room.h`
- Modify: `protocol/frames.md`
- Test (new): `bridge/test/link/room.test.js`, `firmware/host/test_room.cpp`
- Test (changed): `firmware/host/run.mjs`, `protocol/gen_seal_vectors.mjs`, `protocol/seal-vectors.json`

**Interfaces:**
- Consumes: `bridge/src/link/session.js`: `hkdf(ikm, salt, info, length)` (plan 5). Firmware: `proto::Crypto` (plan 5), `firmware/host/ref_crypto.h`.
- Produces: `bridge/src/link/room.js`: `ROOM_INFO` (`'walkie-room-v1'`), `ROOM_BYTES` (16), `roomId(master: Buffer): string` (32 hex characters; `RangeError` unless the key is 32 bytes).
- Produces: `firmware/lib/proto/src/proto/room.h`: `ROOM_BYTES`, `ROOM_HEX_BYTES` (33), `bool roomId(const Crypto&, const uint8_t* master, uint8_t* out)`, `void roomIdHex(const uint8_t* id, char* out)`.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/link/room.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROOM_BYTES, ROOM_INFO, roomId } from '../../src/link/room.js';
import { deriveKeys } from '../../src/link/session.js';

const vectors = JSON.parse(readFileSync(new URL('../../../protocol/seal-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');

test('the room id of each vector key is the vector, 32 lower-case hex characters', () => {
  assert.equal(ROOM_INFO, vectors.room.info);
  assert.equal(vectors.room.cases.length, 2);
  for (const c of vectors.room.cases) {
    assert.equal(roomId(hex(c.master)), c.id);
    assert.match(c.id, /^[0-9a-f]{32}$/);
  }
  assert.equal(ROOM_BYTES * 2, 32);
});

test('another key is another room, and the room is not a piece of a session key', () => {
  const [a, b] = vectors.room.cases;
  assert.notEqual(a.id, b.id);
  const { master, nonceP, nonceS } = vectors.session;
  const keys = deriveKeys(hex(master), nonceP, nonceS);
  assert.notEqual(roomId(hex(master)), keys.pcToS3.subarray(0, 16).toString('hex'));
  assert.notEqual(roomId(hex(master)), keys.s3ToPc.subarray(0, 16).toString('hex'));
});

test('a key that is not 32 bytes has no room', () => {
  assert.throws(() => roomId(Buffer.alloc(31)), RangeError);
  assert.throws(() => roomId(Buffer.alloc(33)), RangeError);
  assert.throws(() => roomId('00'.repeat(32)), RangeError);
  assert.throws(() => roomId(null), RangeError);
});
```

In `firmware/host/run.mjs`, replace:

```js
struct AdpcmVec { const char* name; const char* pcm; uint8_t indexIn; const char* frame; uint8_t indexOut; const char* decoded; };
struct SealVec { uint8_t dir; uint8_t type; uint8_t flags; uint16_t seq; uint32_t counter; const char* plain; const char* envelope; };
```

with:

```js
struct AdpcmVec { const char* name; const char* pcm; uint8_t indexIn; const char* frame; uint8_t indexOut; const char* decoded; };
struct RoomVec { const char* master; const char* id; };
struct SealVec { uint8_t dir; uint8_t type; uint8_t flags; uint16_t seq; uint32_t counter; const char* plain; const char* envelope; };
```

In `firmware/host/run.mjs`, replace:

```js
  ${list(sv.frames.map((f) => `{${f.dir}, ${f.type}, ${f.flags}, ${f.seq}, ${f.counter}u, ${str(f.plain)}, ${str(f.envelope)}}`))}};
static const uint32_t kReplayCounters[] = {${sv.replay.counters.map((c) => `${c}u`).join(', ')}};
```

with:

```js
  ${list(sv.frames.map((f) => `{${f.dir}, ${f.type}, ${f.flags}, ${f.seq}, ${f.counter}u, ${str(f.plain)}, ${str(f.envelope)}}`))}};
static const char* const kRoomInfo = ${str(sv.room.info)};
static const RoomVec kRooms[] = {
  ${list(sv.room.cases.map((r) => `{${str(r.master)}, ${str(r.id)}}`))}};
static const uint32_t kReplayCounters[] = {${sv.replay.counters.map((c) => `${c}u`).join(', ')}};
```

Create `firmware/host/test_room.cpp`:

```cpp
// test_room.cpp: the room id (protocol/frames.md, "Relay") against protocol/seal-vectors.json, which the bridge's tests pass as well.
#include <string.h>
#include "check.h"
#include "proto/room.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
bool failingHkdf(const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, size_t, uint8_t*, size_t) { return false; }
// An HKDF that has written part of the key when it fails.
bool halfwayHkdf(const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, size_t, uint8_t* okm, size_t okmLen) {
  memset(okm, 0xaa, okmLen / 2);
  return false;
}
std::string zeros() { return std::string(32, '0'); }
}  // namespace

TEST(roomEachVectorKeyHasTheVectorsRoom) {
  CHECK(strcmp(kRoomInfo, "walkie-room-v1") == 0, "the info string is the one the vectors name");
  for (const RoomVec& r : kRooms) {
    std::vector<uint8_t> master = unhex(r.master);
    uint8_t id[proto::ROOM_BYTES];
    CHECK(proto::roomId(refCrypto(), master.data(), id), "derived");
    CHECK(tohex(id, sizeof id) == r.id, r.id);
    char text[proto::ROOM_HEX_BYTES];
    proto::roomIdHex(id, text);
    CHECK(strcmp(text, r.id) == 0, "as hex it is the vector's text");
  }
}

TEST(roomAnHkdfThatFailsGivesNoRoom) {
  proto::Crypto c = refCrypto();
  c.hkdf = failingHkdf;
  std::vector<uint8_t> master = unhex(kRooms[0].master);
  uint8_t id[proto::ROOM_BYTES];
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "failed");
  CHECK(tohex(id, sizeof id) == zeros(), "and nothing is left in the output");
  c.hkdf = halfwayHkdf;
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "failed halfway");
  CHECK(tohex(id, sizeof id) == zeros(), "and the half that was written is wiped");
  c.hkdf = nullptr;
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(c, master.data(), id), "no HKDF at all");
  CHECK(tohex(id, sizeof id) == zeros(), "nothing in the output");
  memset(id, 0x55, sizeof id);
  CHECK(!proto::roomId(refCrypto(), nullptr, id), "no key");
  CHECK(tohex(id, sizeof id) == zeros(), "nothing in the output");
}

TEST(roomHexIsLowerCaseAndTerminated) {
  uint8_t id[proto::ROOM_BYTES];
  for (size_t i = 0; i < sizeof id; i++) id[i] = (uint8_t)(0xa0 + i * 0x0b);
  char text[proto::ROOM_HEX_BYTES];
  memset(text, 'x', sizeof text);
  proto::roomIdHex(id, text);
  CHECK(strlen(text) == 32, "32 characters");
  CHECK(std::string(text) == tohex(id, sizeof id), "the same digits as the helper's, lower case");
}
```

In `protocol/gen_seal_vectors.mjs`, replace:

```js

const out = {
```

with:

```js

// The room a PC and a device meet in at the relay (plan 6): the first 16 bytes of HKDF-SHA256(master, empty salt, "walkie-room-v1").
const roomOf = (key) => hex(hkdf(key, Buffer.alloc(0), Buffer.from('walkie-room-v1'), 16));
const otherMaster = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const room = { info: 'walkie-room-v1', cases: [master, otherMaster].map((key) => ({ master: hex(key), id: roomOf(key) })) };

const out = {
```

In `protocol/gen_seal_vectors.mjs`, replace:

```js
  replay,
};
```

with:

```js
  replay,
  room,
};
```

In `protocol/seal-vectors.json`, replace:

```json
  ]
 }
```

with:

```json
  ]
 },
 "room": {
  "info": "walkie-room-v1",
  "cases": [
   {
    "master": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "id": "fe763d41d34a08c30e764e69a7f7db6a"
   },
   {
    "master": "fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0",
    "id": "190e52180418316fc8c2375f807df175"
   }
  ]
 }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `proto/room.h: No such file or directory`.

Run: `node --test bridge/test/link/room.test.js`
Expected: FAIL, the file `bridge/test/link/room.test.js` cannot load, because it imports `bridge/src/link/room.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/link/room.js`:

```js
// The room a PC and a device meet in at the relay (protocol/frames.md, "Relay"): 16 bytes that only the two holders of the pairing key can
// work out, in lower-case hex for the relay's URL. The relay learns the room and nothing else; it cannot read or forge a frame.
import { KEY_BYTES } from '../config/pairkey.js';
import { hkdf } from './session.js';

export const ROOM_INFO = 'walkie-room-v1';
export const ROOM_BYTES = 16;

export function roomId(master) {
  if (!Buffer.isBuffer(master) || master.length !== KEY_BYTES) throw new RangeError(`the pairing key is ${KEY_BYTES} bytes`);
  return hkdf(master, Buffer.alloc(0), Buffer.from(ROOM_INFO), ROOM_BYTES).toString('hex');
}
```

Create `firmware/lib/proto/src/proto/room.cpp`:

```cpp
// room.cpp: see room.h.
#include "proto/room.h"
#include <string.h>

namespace proto {
bool roomId(const Crypto& c, const uint8_t* master, uint8_t* out) {
  static const uint8_t info[] = {'w', 'a', 'l', 'k', 'i', 'e', '-', 'r', 'o', 'o', 'm', '-', 'v', '1'};
  memset(out, 0, ROOM_BYTES);
  if (!c.hkdf || !master) return false;
  if (!c.hkdf(master, KEY_BYTES, nullptr, 0, info, sizeof info, out, ROOM_BYTES)) {
    memset(out, 0, ROOM_BYTES);
    return false;
  }
  return true;
}

void roomIdHex(const uint8_t* id, char* out) {
  static const char digits[] = "0123456789abcdef";
  for (size_t i = 0; i < ROOM_BYTES; i++) {
    out[2 * i] = digits[id[i] >> 4];
    out[2 * i + 1] = digits[id[i] & 15];
  }
  out[2 * ROOM_BYTES] = 0;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/room.h`:

```cpp
// room.h: the room a device meets its PC in at the relay (protocol/frames.md, "Relay"). The same 16 bytes as bridge/src/link/room.js,
// checked against protocol/seal-vectors.json: HKDF-SHA256 of the pairing key with an empty salt and the info "walkie-room-v1".
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"

namespace proto {
const size_t ROOM_BYTES = 16;
const size_t ROOM_HEX_BYTES = ROOM_BYTES * 2 + 1;  // lower-case hex and the terminating NUL

// Writes ROOM_BYTES to out from the KEY_BYTES-byte master key. False when c has no HKDF or it fails (out is then zeroed).
bool roomId(const Crypto& c, const uint8_t* master, uint8_t* out);

// The id as lower-case hex with a terminating NUL (ROOM_HEX_BYTES bytes), the form the relay's path wants.
void roomIdHex(const uint8_t* id, char* out);
}  // namespace proto
```

In `protocol/frames.md`, replace:

```markdown
Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.
```

with:

```markdown
Test pattern: sample k of the take, counting from 0, is `(k * 1103 + 12345) mod 65536`, written as u16 little endian.

## Relay (plan 6)

Away from the cable the same frames travel through a relay that both ends dial out to. The relay is blind: it forwards bytes and cannot read or forge a frame, because every frame of a paired link is sealed.

- Address: `wss://<host>/r/<room>?role=pc` for the bridge and `role=device` for the S3. `<room>` is the first 16 bytes of HKDF-SHA256 of the pairing key (empty salt, info `walkie-room-v1`) in lower-case hex, 32 characters. Only the two holders of the key can work it out.
- One WebSocket binary message is one frame: its envelope, which is the bytes that COBS carries on USB (type, flags, seq u16 LE, len u16 LE, payload, CRC-16), without COBS and without the 0x00 delimiters. At most 1032 bytes; the relay refuses a message over 1100 and any text message.
- A room holds at most one PC and one device. A second connection of the same role replaces the first, which is closed with code 4000.
- The relay forwards each message to the peer unchanged and drops it when there is no peer. It keeps nothing, so a peer that arrives later sees nothing of what was sent before.
- HELLO, sealing, PING and PONG are as on USB. A PONG is expected within 10 s on this carrier, and the bridge sends PING every 5 s, so that a phone's hotspot jitter does not read as a disconnect.
- A device joins the relay only when it holds a pairing key.
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `202 cases, 1067 checks passed, 0 failed`.

Run: `node --test bridge/test/link/room.test.js`
Expected: PASS, 3 tests, 0 fail.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.0%, Flash 27.4%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 811 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add bridge/src/link/room.js bridge/test/link/room.test.js firmware/host/run.mjs firmware/host/test_room.cpp firmware/lib/proto/src/proto/room.cpp firmware/lib/proto/src/proto/room.h protocol/frames.md protocol/gen_seal_vectors.mjs protocol/seal-vectors.json
git commit -m "Task 3: room id: HKDF of the pairing key names the relay room, in the bridge and the firmware, with a shared vector and the Relay section of frames.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The relay as a port for the Link

The `Link` talks to a port: an object with `write(Buffer)` of COBS-framed bytes, `close()`, and `'data'` and `'close'` events. `openRelayPort` is that port over a WebSocket to the relay: it decodes the COBS stream the `Link` writes into envelopes and sends each as one binary message, and turns each message it receives back into a COBS frame. It uses Node 24's built-in `WebSocket`. It never emits `'error'` (a failed open rejects; a lost connection is a `'close'`), says why it closed (`closeCode`, and `replaced` for 4000), and carries the relay's ping clock (`pingEveryMs` 5000, `pongTimeoutMs` 10000) for Task 5 to read. `relayUrl` refuses plain `ws://` for any host that is not a loopback address.

**Files:**
- Create: `bridge/src/link/relay-port.js`
- Test (new): `bridge/test/link/relay-port.test.js`

**Interfaces:**
- Consumes: `relay/src/server.js` `startRelay` (Task 2), in the tests. `bridge/src/link/frame.js`: the COBS encoder and decoder (plan 1).
- Produces: `bridge/src/link/relay-port.js`: `CLOSE_REPLACED` (4000), `RELAY_PING_EVERY_MS` (5000), `RELAY_PONG_TIMEOUT_MS` (10000), `relayUrl(host, room, role): string` (`RangeError` for a bad host, room or role), `openRelayPort({ host, room, role = 'pc', connectTimeoutMs = 10_000, WebSocketImpl = WebSocket }): Promise<port>`; the port has `kind` (`'relay'`), `pingEveryMs`, `pongTimeoutMs`, `closeCode`, `replaced`, `write(buf)`, `close()`, and emits `'data'` and `'close'` once.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/link/relay-port.test.js`:

```js
// The relay as a port: the Link keeps speaking COBS-framed bytes, and each frame crosses the relay as one WebSocket message
// holding the raw envelope. The relay is the real one (relay/src/server.js) on a local port; the S3 is a bare WebSocket client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../../relay/src/server.js';
import { openRelayPort, relayUrl, RELAY_PING_EVERY_MS, RELAY_PONG_TIMEOUT_MS, CLOSE_REPLACED } from '../../src/link/relay-port.js';
import { encodeFrame, TYPE } from '../../src/link/frame.js';
import { cobsDecode, cobsEncode } from '../../src/link/cobs.js';
import { until } from '../helpers/fake-s3.js';

const ROOM = 'c'.repeat(32);

async function relayFor(t) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 });
  t.after(() => relay.close());
  return { relay, host: `ws://127.0.0.1:${relay.port}` };
}

// The S3's side: a WebSocket in the same room that keeps what it was sent.
async function device(t, host, room = ROOM) {
  const ws = new WebSocket(`${host}/r/${room}?role=device`);
  ws.binaryType = 'arraybuffer';
  ws.got = [];
  ws.addEventListener('message', (e) => ws.got.push(Buffer.from(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('the test device could not join')), { once: true });
  });
  t.after(() => ws.close());
  return ws;
}

const wire = (type, payload = Buffer.alloc(0), seq = 1) => Buffer.from(encodeFrame({ type, seq, payload }));
const inner = (w) => Buffer.from(cobsDecode(w.subarray(1, w.length - 1)));

async function port(t, host, options = {}) {
  const p = await openRelayPort({ host, room: ROOM, ...options });
  p.data = [];
  p.on('data', (d) => p.data.push(Buffer.from(d)));
  p.closes = 0;
  p.on('close', () => p.closes++);
  p.on('error', () => {});
  t.after(() => p.close());
  return p;
}

test('relayUrl: wss for a host, plain ws only for this machine, and nothing that is not a host name', () => {
  assert.equal(relayUrl('walkie-relay.fly.dev', ROOM, 'pc'), `wss://walkie-relay.fly.dev/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('relay.example.com:8443', ROOM, 'device'), `wss://relay.example.com:8443/r/${ROOM}?role=device`);
  assert.equal(relayUrl('ws://127.0.0.1:9000', ROOM, 'pc'), `ws://127.0.0.1:9000/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('ws://localhost:9000/', ROOM, 'pc'), `ws://localhost:9000/r/${ROOM}?role=pc`);
  assert.equal(relayUrl('wss://relay.fly.dev', ROOM, 'pc'), `wss://relay.fly.dev/r/${ROOM}?role=pc`);
  for (const bad of ['ws://relay.fly.dev', '', 'a b', 'relay.fly.dev/x', 'relay.fly.dev?x=1', 'user@relay.fly.dev', 'http://relay.fly.dev', '-x.dev']) {
    assert.throws(() => relayUrl(bad, ROOM, 'pc'), RangeError, `refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => relayUrl('relay.fly.dev', 'abc', 'pc'), RangeError, 'a room is 32 lower-case hex digits');
  assert.throws(() => relayUrl('relay.fly.dev', ROOM, 'both'), RangeError, 'a role is pc or device');
});

test('what the Link writes reaches the S3 as the raw envelope, and what the S3 sends comes back as the COBS bytes the Link reads', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const down = wire(TYPE.PING, Buffer.from([1, 2, 3, 0, 4]), 7);
  p.write(down);
  await until(() => s3.got.length === 1, 'the S3 hears the frame');
  assert.deepEqual(s3.got[0], inner(down), 'one message, the envelope without COBS or delimiters');
  assert.equal(s3.got[0].length, 8 + 5);
  const up = wire(TYPE.PONG, Buffer.from([9, 0, 0, 9]), 8);
  s3.send(inner(up));
  await until(() => p.data.length === 1, 'the Link hears the frame');
  assert.deepEqual(p.data[0], up, 'identical to what the USB side would have delivered');
});

test('two frames in one write are two messages, and a write that is not a frame is not sent', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const a = wire(TYPE.PING, Buffer.from('a'), 1);
  const b = wire(TYPE.PING, Buffer.from('bb'), 2);
  p.write(Buffer.concat([a, b]));
  p.write(Buffer.from([0, 0xff, 0xff, 0xff, 0]));
  p.write(Buffer.alloc(0));
  p.write(Buffer.from([0]));
  p.write(wire(TYPE.PING, Buffer.from('c'), 3));
  await until(() => s3.got.length === 3, 'three frames and nothing else');
  assert.deepEqual(s3.got, [inner(a), inner(b), inner(wire(TYPE.PING, Buffer.from('c'), 3))]);
});

test('a frame with no payload is the smallest frame, and crosses both ways; a write that decodes to less or more than a frame is not sent', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  const empty = wire(TYPE.PING, Buffer.alloc(0), 1);
  assert.equal(inner(empty).length, 8);
  p.write(empty);
  const bare = (n) => Buffer.concat([Buffer.from([0]), Buffer.from(cobsEncode(Buffer.alloc(n, 1))), Buffer.from([0])]);
  p.write(bare(7));
  p.write(bare(1033));
  p.write(wire(TYPE.PING, Buffer.alloc(1024, 3), 2));
  await until(() => s3.got.length === 2, 'the empty frame and the full one, nothing in between');
  assert.deepEqual(s3.got.map((g) => g.length), [8, 1032]);
  const back = wire(TYPE.PONG, Buffer.alloc(0), 3);
  s3.send(inner(back));
  await until(() => p.data.length === 1, 'the empty frame comes back');
  assert.deepEqual(p.data[0], back);
});

test('a message that cannot be a frame (too short, or longer than any frame) is dropped; the next one still comes through', async (t) => {
  const { host } = await relayFor(t);
  const s3 = await device(t, host);
  const p = await port(t, host);
  s3.send(Buffer.alloc(7, 1));
  s3.send(Buffer.alloc(0));
  s3.send(Buffer.alloc(1033, 1));
  const good = wire(TYPE.PONG, Buffer.from('x'), 4);
  s3.send(inner(good));
  await until(() => p.data.length === 1, 'the good frame arrives');
  assert.deepEqual(p.data[0], good);
  assert.equal(p.data.length, 1, 'and only that');
  s3.send(Buffer.alloc(1032, 1));
  await until(() => p.data.length === 2, 'the largest envelope is carried (the decoder judges its CRC)');
});

test('the S3 not being there is not an error: the write goes nowhere, and nothing is kept for later', async (t) => {
  const { host } = await relayFor(t);
  const p = await port(t, host);
  p.write(wire(TYPE.PING, Buffer.from('early'), 1));
  await new Promise((r) => setTimeout(r, 50));
  const s3 = await device(t, host);
  p.write(wire(TYPE.PING, Buffer.from('late'), 2));
  await until(() => s3.got.length === 1, 'only the late frame');
  assert.deepEqual(s3.got[0], inner(wire(TYPE.PING, Buffer.from('late'), 2)));
});

test('close() closes once, a write after it is quiet, and the relay hanging up is a single close event', async (t) => {
  const { host, relay } = await relayFor(t);
  const p = await port(t, host);
  p.close();
  p.close();
  await until(() => p.closes === 1, 'one close event');
  p.write(wire(TYPE.PING, Buffer.alloc(0), 1));
  await until(() => relay.stats().connections === 0, 'the relay let go of it');
  const q = await port(t, host);
  relay.close();
  await until(() => q.closes === 1, 'the relay going away is a close');
  q.close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q.closes, 1, 'never twice');
});

test('a second bridge in the room replaces the first, and the first is told why', async (t) => {
  const { host } = await relayFor(t);
  const first = await port(t, host);
  const second = await port(t, host);
  await until(() => first.closes === 1, 'the first is closed');
  assert.equal(first.closeCode, CLOSE_REPLACED);
  assert.equal(CLOSE_REPLACED, 4000);
  assert.equal(first.replaced, true);
  assert.equal(second.replaced, false);
  assert.equal(second.closes, 0);
});

test('a relay that is not there rejects the open, with the host in the message and no secret in it', async () => {
  await assert.rejects(
    openRelayPort({ host: 'ws://127.0.0.1:1', room: ROOM, connectTimeoutMs: 2000 }),
    (err) => err instanceof Error && /127\.0\.0\.1:1/.test(err.message) && !err.message.includes(ROOM),
  );
});

test('a relay that accepts the connection and never answers does not hang the open', async (t) => {
  const { createServer } = await import('node:net');
  const silent = createServer((s) => s.on('error', () => {}));
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => silent.close());
  const started = Date.now();
  await assert.rejects(openRelayPort({ host: `ws://127.0.0.1:${silent.address().port}`, room: ROOM, connectTimeoutMs: 200 }), /relay/);
  assert.ok(Date.now() - started < 2000, 'gave up at the timeout');
});

test('the relay port asks the Link for the slower clock of a network: ping every 5 s, a reply within 10 s', async (t) => {
  const { host } = await relayFor(t);
  const p = await port(t, host);
  assert.equal(RELAY_PING_EVERY_MS, 5000);
  assert.equal(RELAY_PONG_TIMEOUT_MS, 10_000);
  assert.equal(p.pingEveryMs, 5000);
  assert.equal(p.pongTimeoutMs, 10_000);
  assert.equal(p.kind, 'relay');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/relay-port.test.js`
Expected: FAIL, the file `bridge/test/link/relay-port.test.js` cannot load, because it imports `bridge/src/link/relay-port.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/link/relay-port.js`:

```js
// The relay as a port. The Link writes and reads COBS-framed bytes, as it does on USB; across the relay each frame is one
// WebSocket binary message holding the raw envelope (protocol/frames.md, "Relay"). This file converts between the two, so
// the Link does not know which carrier it is on.
import { EventEmitter } from 'node:events';
import { cobsDecode, cobsEncode } from './cobs.js';

export const CLOSE_REPLACED = 4000;
// The slower clock of a network: a phone's hotspot stalls for seconds without being gone.
export const RELAY_PING_EVERY_MS = 5000;
export const RELAY_PONG_TIMEOUT_MS = 10_000;
const ENVELOPE_MIN = 8;
const ENVELOPE_MAX = 8 + 1024;

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const HOST = `${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?`;
const SECURE = new RegExp(`^(?:wss://)?(${HOST})/?$`);
// Plain ws:// is for a relay on this machine only; a network gets TLS.
const LOCAL = /^ws:\/\/((?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?)\/?$/;

// wss://<host>/r/<room>?role=<pc|device>. Throws RangeError for anything that is not a plain host name.
export function relayUrl(host, room, role) {
  if (!/^[0-9a-f]{32}$/.test(room)) throw new RangeError('a room is 32 lower-case hex digits');
  if (role !== 'pc' && role !== 'device') throw new RangeError('a role is pc or device');
  const text = String(host ?? '').trim();
  const local = LOCAL.exec(text);
  if (local) return `ws://${local[1]}/r/${room}?role=${role}`;
  const secure = SECURE.exec(text);
  if (!secure) throw new RangeError(`not a relay host name: ${JSON.stringify(text)}`);
  return `wss://${secure[1]}/r/${room}?role=${role}`;
}

class RelayPort extends EventEmitter {
  kind = 'relay';
  pingEveryMs = RELAY_PING_EVERY_MS;
  pongTimeoutMs = RELAY_PONG_TIMEOUT_MS;
  closeCode = null;
  bad = 0;
  #ws;
  #closed = false;

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.addEventListener('message', (e) => this.#onMessage(e.data));
    ws.addEventListener('close', (e) => this.#onClose(e.code));
  }

  get replaced() {
    return this.closeCode === CLOSE_REPLACED;
  }

  write(bytes) {
    if (this.#closed || this.#ws.readyState !== 1) return;
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i < bytes.length && bytes[i] !== 0) continue;
      const chunk = bytes.subarray(start, i);
      start = i + 1;
      if (chunk.length === 0) continue;
      const env = cobsDecode(chunk);
      if (env && env.length >= ENVELOPE_MIN && env.length <= ENVELOPE_MAX) this.#ws.send(env);
    }
  }

  close() {
    if (this.#closed) return;
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
  }

  #onMessage(data) {
    if (typeof data === 'string') return;
    const env = Buffer.from(data);
    if (env.length < ENVELOPE_MIN || env.length > ENVELOPE_MAX) {
      this.bad++;
      return;
    }
    const body = cobsEncode(env);
    const wire = Buffer.alloc(body.length + 2);
    wire.set(body, 1);
    this.emit('data', wire);
  }

  #onClose(code) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeCode = code;
    this.emit('close');
  }
}

// Joins the room as the PC. Resolves with the port once the relay has accepted the connection; rejects when it has not
// within connectTimeoutMs. The room is a secret of the pairing key, so no message here names it.
export function openRelayPort({ host, room, role = 'pc', connectTimeoutMs = 10_000, WebSocketImpl = WebSocket }) {
  const url = relayUrl(host, room, role);
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url);
    ws.binaryType = 'arraybuffer';
    const port = new RelayPort(ws);
    const fail = () => {
      clearTimeout(timer);
      port.close();
      reject(new Error(`could not reach the relay at ${String(host).trim()}`));
    };
    const timer = setTimeout(fail, connectTimeoutMs);
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        ws.removeEventListener('close', fail);
        resolve(port);
      },
      { once: true },
    );
    ws.addEventListener('close', fail, { once: true });
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/relay-port.test.js`
Expected: PASS, 11 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 822 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/relay-port.js bridge/test/link/relay-port.test.js
git commit -m "Task 4: the relay as a bridge port: COBS bytes in and out for the Link, one raw envelope per WebSocket message, the room's URL, replacement told by close code 4000" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Link's clock from its port, and reconnect backoff

Over the relay a PONG may take longer than the cable's 3 s, so the `Link` takes its ping interval and PONG timeout from the port it has open (`port.pingEveryMs`, `port.pongTimeoutMs`, 1000 and 3000 when the port does not say), afresh for every port. A new option, `retryMaxMs`, makes reconnects back off: the wait doubles after every failed open or lost port, up to `retryMaxMs`, and starts again from `retryMs` once a link is ready; left out, it equals `retryMs` and the wait stays flat, as before. The stand-in S3 gains `answerPings` (false: PINGs go unanswered) for these tests, which run on mock timers.

**Files:**
- Modify: `bridge/src/link/link.js`
- Test (new): `bridge/test/link/link-timing.test.js`
- Test (changed): `bridge/test/helpers/fake-s3.js`

**Interfaces:**
- Consumes: `bridge/src/link/link.js` (plans 1 and 5): the `Link` constructor and its ping loop. `bridge/test/helpers/fake-s3.js`.
- Produces: `new Link({ ..., retryMs = 1000, retryMaxMs = retryMs })`; the reason for a lost link reads `no PONG for <pongTimeoutMs/1000> s`.
- Produces: `FakeS3#answerPings` (default true).

- [ ] **Step 1: Write the failing tests**

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  #fifo = Buffer.alloc(0);
  micSource = false; // TEST MIC_SOURCE
```

with:

```js
  #fifo = Buffer.alloc(0);
  answerPings = true; // false: a PING gets no PONG, as when the cable or the network has gone quiet
  micSource = false; // TEST MIC_SOURCE
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      case TYPE.PING:
        this.feed(TYPE.PONG, Buffer.concat([f.payload, u32(1234), u32(0), u32(0)]));
        break;
```

with:

```js
      case TYPE.PING:
        if (this.answerPings) this.feed(TYPE.PONG, Buffer.concat([f.payload, u32(1234), u32(0), u32(0)]));
        break;
```

Create `bridge/test/link/link-timing.test.js`:

```js
// The Link's clocks: how often it pings and how long it waits for a PONG is the port's to say (a cable and a relay differ), and a
// port that will not open, or keeps closing, is retried more slowly each time up to a ceiling, starting over once a link is ready.
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { FakeS3 } from '../helpers/fake-s3.js';

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Mock time moves a second at a time with the I/O of the stand-in S3 flushed in between.
async function advance(t, ms, step = 1000) {
  for (let left = ms; left > 0; left -= step) {
    t.mock.timers.tick(Math.min(step, left));
    await flush();
  }
}

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
}

async function start(t, { s3 = {}, ports = {}, link: options = {} } = {}) {
  const device = new FakeS3(s3);
  Object.assign(device, ports);
  const link = new Link({ openPort: async () => device, makeNonce: () => 7, ...options });
  const seen = { down: [], status: [] };
  link.on('down', (r) => seen.down.push(r));
  link.on('status', (s) => seen.status.push(s));
  t.after(() => link.close());
  await link.start();
  await flush();
  return { device, link, seen };
}

const pings = (device) => device.sent.filter((f) => f.type === TYPE.PING).length;

test('a port with no clock of its own is pinged every second, and given 3 s to answer', async (t) => {
  clock(t);
  const { device, link, seen } = await start(t);
  assert.equal(link.ready, true);
  device.answerPings = false;
  const before = pings(device);
  await advance(t, 3000);
  assert.equal(seen.down.length, 0, 'not yet');
  assert.equal(pings(device) - before, 3, 'a PING a second');
  await advance(t, 1000);
  assert.deepEqual(seen.down, ['no PONG for 3 s']);
});

test('a port that asks for the slow clock is pinged every 5 s and given 10 s, and the reason says 10 s', async (t) => {
  clock(t);
  const { device, link, seen } = await start(t, { ports: { pingEveryMs: 5000, pongTimeoutMs: 10_000 } });
  assert.equal(link.ready, true);
  device.answerPings = false;
  const before = pings(device);
  await advance(t, 10_000);
  assert.equal(seen.down.length, 0, 'ten silent seconds are still inside the window');
  assert.equal(pings(device) - before, 2, 'a PING every 5 s');
  await advance(t, 5000);
  assert.deepEqual(seen.down, ['no PONG for 10 s']);
});

test('a PONG inside the window keeps a slow port up for as long as they keep coming', async (t) => {
  clock(t);
  const { link, seen } = await start(t, { ports: { pingEveryMs: 5000, pongTimeoutMs: 10_000 } });
  await advance(t, 60_000);
  assert.equal(link.ready, true);
  assert.equal(seen.down.length, 0);
});

test('a port whose clock is nonsense gets the default one', async (t) => {
  clock(t);
  for (const bad of [{ pingEveryMs: 0, pongTimeoutMs: -1 }, { pingEveryMs: NaN, pongTimeoutMs: 'x' }, { pingEveryMs: Infinity, pongTimeoutMs: null }]) {
    const { device, seen } = await start(t, { ports: bad });
    device.answerPings = false;
    const before = pings(device);
    await advance(t, 3000);
    assert.equal(pings(device) - before, 3, `a PING a second: ${JSON.stringify(bad)}`);
    await advance(t, 1000);
    assert.deepEqual(seen.down, ['no PONG for 3 s'], JSON.stringify(bad));
  }
});

test('the clock of one port does not stay on the next: a relay at 5 s, then a cable at 1 s', async (t) => {
  clock(t);
  const ports = [Object.assign(new FakeS3(), { pingEveryMs: 5000, pongTimeoutMs: 10_000 }), new FakeS3()];
  let n = 0;
  const link = new Link({ openPort: async () => ports[n++], makeNonce: () => 7 });
  const down = [];
  link.on('down', (r) => down.push(r));
  t.after(() => link.close());
  await link.start();
  await flush();
  assert.equal(link.ready, true);
  ports[0].close(); // the relay goes; the Link opens the next port after its retry
  await advance(t, 1000);
  await flush();
  assert.equal(n, 2);
  assert.equal(link.ready, true);
  ports[1].answerPings = false;
  const before = pings(ports[1]);
  await advance(t, 3000);
  assert.equal(pings(ports[1]) - before, 3, 'the cable is pinged every second');
  await advance(t, 1000);
  assert.deepEqual(down.filter((r) => r.startsWith('no PONG')), ['no PONG for 3 s']);
});

// A port that cannot be opened: the times at which the Link tried.
function failingOpen(t, options) {
  const tries = [];
  const link = new Link({
    openPort: async () => {
      tries.push(Date.now());
      throw new Error('no route');
    },
    ...options,
  });
  t.after(() => link.close());
  return { link, tries };
}

test('without a ceiling the retry is flat, as it always was', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000 });
  await link.start();
  await advance(t, 5000);
  assert.deepEqual(tries, [0, 1000, 2000, 3000, 4000, 5000]);
});

test('with a ceiling the retry doubles up to it: 1, 2, 4, 8, 16, 30, 30 s', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000, retryMaxMs: 30_000 });
  await link.start();
  await advance(t, 91_000, 500);
  assert.deepEqual(tries, [0, 1000, 3000, 7000, 15_000, 31_000, 61_000, 91_000]);
});

test('a ceiling below the first delay is no ceiling at all, the first delay holds', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 2000, retryMaxMs: 500 });
  await link.start();
  await advance(t, 6000, 500);
  assert.deepEqual(tries, [0, 2000, 4000, 6000]);
});

test('the delay starts over once a link has been ready, and not before: a port that opens and closes is still failing', async (t) => {
  clock(t);
  const opened = [];
  const devices = [];
  // The first port is an S3 that answers; the rest never answer HELLO, so a link on them is never ready.
  let refusals = 2; // the first two opens fail: the delay has grown to 4 s by the time a port opens
  const silent = () => Object.assign(new EventEmitter(), { write: () => true, close() { this.emit('close'); } });
  const link = new Link({
    openPort: async () => {
      opened.push(Date.now());
      if (refusals-- > 0) throw new Error('no route');
      const d = devices.length === 0 ? new FakeS3({ proto: 1 }) : silent();
      devices.push(d);
      return d;
    },
    retryMs: 1000,
    retryMaxMs: 30_000,
    makeNonce: () => 7,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 3000); // tries at 0, 1 s and 3 s; the third opens
  assert.deepEqual(opened, [0, 1000, 3000]);
  assert.equal(link.ready, true);
  devices[0].close();
  await advance(t, 1000);
  assert.deepEqual(opened, [0, 1000, 3000, 4000], 'after a ready link the wait is 1 s again, not the 4 s the failures had built up');
  // Close it again before it was ever ready (the HELLO has not been answered yet): 2 s, then 4 s.
  const mute = devices[1];
  mute.close();
  await advance(t, 1000);
  assert.equal(opened.length, 4, 'not after 1 s, the delay is now 2 s');
  await advance(t, 1000);
  assert.equal(opened.length, 5);
  devices[2].close();
  await advance(t, 3000);
  assert.equal(opened.length, 5, 'and now 4 s');
  await advance(t, 1000);
  assert.equal(opened.length, 6);
});

test('close() ends the retries', async (t) => {
  clock(t);
  const { link, tries } = failingOpen(t, { retryMs: 1000, retryMaxMs: 30_000 });
  await link.start();
  link.close();
  await advance(t, 60_000);
  assert.deepEqual(tries, [0]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/link-timing.test.js`
Expected: FAIL, 3 tests fail: `a port that asks for the slow clock is pinged every 5 s and given 10 s, and the reason says 10 s`, `with a ceiling the retry doubles up to it: 1, 2, 4, 8, 16, 30, 30 s`, `the delay starts over once a link has been ready, and not before: a port that opens and closes is still failing`.

- [ ] **Step 3: Write the implementation**

In `bridge/src/link/link.js`, replace:

```js
const PONG_TIMEOUT_MS = 3000;
const PLAYED_GRACE_MS = 10_000;
```

with:

```js
const PONG_TIMEOUT_MS = 3000;
// A port's own clock, when it is a usable number of milliseconds.
const clockOf = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
const PLAYED_GRACE_MS = 10_000;
```

In `bridge/src/link/link.js`, replace:

```js
  #retryMs;
  #makeNonce;
```

with:

```js
  #retryMs;
  #retryMaxMs;
  #retryDelay;
  #pingEveryMs = PING_EVERY_MS;
  #pongTimeoutMs = PONG_TIMEOUT_MS;
  #makeNonce;
```

In `bridge/src/link/link.js`, replace:

```js
  // ask the walkie for ADPCM takes, when the walkie says it takes it (protocol/frames.md, "Audio codec"); listeners get PCM16 either way.
  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0, adpcm = false }) {
    super();
```

with:

```js
  // ask the walkie for ADPCM takes, when the walkie says it takes it (protocol/frames.md, "Audio codec"); listeners get PCM16 either way.
  // `retryMs` is the first wait before the port is opened again; with `retryMaxMs` above it each wait doubles up to that, and starts over at
  // `retryMs` once a link is ready. A port may carry its own clock: `pingEveryMs` and `pongTimeoutMs` (a relay is slower than a cable).
  constructor({ openPort, retryMs = 1000, retryMaxMs = retryMs, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0, adpcm = false }) {
    super();
```

In `bridge/src/link/link.js`, replace:

```js
    this.#retryMs = retryMs;
    this.#makeNonce = makeNonce;
```

with:

```js
    this.#retryMs = retryMs;
    this.#retryMaxMs = Math.max(retryMs, retryMaxMs);
    this.#retryDelay = retryMs;
    this.#makeNonce = makeNonce;
```

In `bridge/src/link/link.js`, replace:

```js
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
      return;
```

with:

```js
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      this.#scheduleRetry();
      return;
```

In `bridge/src/link/link.js`, replace:

```js
    this.#port = port;
    this.#decoder = new FrameDecoder();
```

with:

```js
    this.#port = port;
    this.#pingEveryMs = clockOf(port.pingEveryMs, PING_EVERY_MS);
    this.#pongTimeoutMs = clockOf(port.pongTimeoutMs, PONG_TIMEOUT_MS);
    this.#decoder = new FrameDecoder();
```

In `bridge/src/link/link.js`, replace:

```js
    if (wasReady && !this.#closing) this.emit('down', 'port closed');
    if (!this.#closing) this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
  }
```

with:

```js
    if (wasReady && !this.#closing) this.emit('down', 'port closed');
    if (!this.#closing) this.#scheduleRetry();
  }

  #scheduleRetry() {
    this.#retryTimer = setTimeout(() => this.#connect(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryMaxMs, this.#retryDelay * 2);
  }
```

In `bridge/src/link/link.js`, replace:

```js
    this.#ready = true;
    this.#ringBytes = hello.ringBytes;
```

with:

```js
    this.#ready = true;
    this.#retryDelay = this.#retryMs;
    this.#ringBytes = hello.ringBytes;
```

In `bridge/src/link/link.js`, replace:

```js
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
```

with:

```js
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), this.#pingEveryMs);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
```

In `bridge/src/link/link.js`, replace:

```js
  #ping() {
    if (Date.now() - this.#lastPong > PONG_TIMEOUT_MS) {
      this.#lost('no PONG for 3 s');
      return;
```

with:

```js
  #ping() {
    if (Date.now() - this.#lastPong > this.#pongTimeoutMs) {
      this.#lost(`no PONG for ${this.#pongTimeoutMs / 1000} s`);
      return;
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/link-timing.test.js`
Expected: PASS, 10 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 832 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/link.js bridge/test/helpers/fake-s3.js bridge/test/link/link-timing.test.js
git commit -m "Task 5: the Link takes its ping clock from the port and backs its reconnects off up to a ceiling, starting over once a link is ready" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Whole turns through a relay

This task adds tests only, over what Tasks 2 to 5 built: the stand-in S3 behind a real relay on `127.0.0.1`, joined as the device through `openRelayPort`, so that the bridge's existing turn tests can run with the relay in between. `relayedS3` connects a `FakeS3` to a room and lets a test take the S3 away and put it back; `world()` takes `relay: true` (or options) and returns the handle. The tests run a plain turn, an approval, a sealed ADPCM turn in the room the key names, the S3 leaving and coming back, the relay going away and coming back on the same port, and an empty room. They pass as soon as they are written, because the code under them exists: they are the spec's "the existing turn tests run again over it" (§5.6).

**Files:**
- Test (new): `bridge/test/helpers/relay-s3.js`, `bridge/test/relay-turn.test.js`
- Test (changed): `bridge/test/helpers/world.js`

**Interfaces:**
- Consumes: `startRelay` (Task 2), `openRelayPort` (Task 4), `roomId` (Task 3), the `Link`'s per-port clock (Task 5), `world()` and `FakeS3` (plans 1 to 5).
- Produces: `bridge/test/helpers/relay-s3.js`: `relayedS3(t, s3, { master = null, clock = null, relay = null, rejoinMs = 50 }): Promise<{ relay, room, host, openPort, unplug(), plug(), joined }>`.
- Produces: `world(t, { relay: true | opts })` returns `relayed` beside what it returned before.

- [ ] **Step 1: Write the tests**

Create `bridge/test/helpers/relay-s3.js`:

```js
// The stand-in S3 behind a real relay. The relay is relay/src/server.js on a local port; the S3 joins its room as a device through the
// same port code the bridge uses (role 'device'), and hands every frame to a FakeS3 and every FakeS3 frame back. The bridge opens the
// other end with `openPort`. The S3 can be taken away and put back, as a power cycle or a lost Wi-Fi would.
import { startRelay } from '../../../relay/src/server.js';
import { openRelayPort } from '../../src/link/relay-port.js';
import { roomId } from '../../src/link/room.js';

// `master`: the pairing key, which names the room as it does for real. `clock`: a port clock for the bridge's end, e.g.
// { pingEveryMs: 100, pongTimeoutMs: 400 }, so a test need not wait out a relay's 5 s. `relay`: an already running relay to join.
export async function relayedS3(t, s3, { master = null, clock = null, relay = null, rejoinMs = 50 } = {}) {
  const owned = relay === null;
  const server = relay ?? (await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 }));
  const room = master ? roomId(master) : 'd'.repeat(32);
  const host = `ws://127.0.0.1:${server.port}`;
  let present = true;
  let device = null;

  s3.on('data', (wire) => device?.write(wire)); // an S3 that is not in the room says nothing to anyone

  async function join() {
    if (!present || device) return;
    let port;
    try {
      port = await openRelayPort({ host, room, role: 'device', connectTimeoutMs: 1000 });
    } catch {
      if (present) setTimeout(join, rejoinMs); // the relay is not there (yet)
      return;
    }
    if (!present) {
      port.close();
      return;
    }
    device = port;
    port.on('data', (wire) => s3.write(wire));
    port.on('close', () => {
      if (device === port) device = null;
      if (present) setTimeout(join, rejoinMs);
    });
  }
  await join();

  const handle = {
    relay: server,
    room,
    host,
    // The bridge's end of the relay.
    openPort: async () => {
      const port = await openRelayPort({ host, room, connectTimeoutMs: 1000 });
      return clock ? Object.assign(port, clock) : port;
    },
    // The S3 goes away (no more frames either way) and comes back.
    unplug() {
      present = false;
      device?.close();
      device = null;
    },
    plug() {
      present = true;
      return join();
    },
    get joined() {
      return device !== null;
    },
  };
  t.after(async () => {
    present = false;
    device?.close();
    if (owned) await server.close();
  });
  return handle;
}
```

In `bridge/test/helpers/world.js`, replace:

```js
import { FakeS3, until } from './fake-s3.js';

```

with:

```js
import { FakeS3, until } from './fake-s3.js';
import { relayedS3 } from './relay-s3.js';

```

In `bridge/test/helpers/world.js`, replace:

```js
// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
// `s3` is the stand-in S3's options, `link` those of startBridge that belong to the link (master, adpcm).
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent, s3: s3Options = {}, link: linkOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
```

with:

```js
// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
// `s3` is the stand-in S3's options, `link` those of startBridge that belong to the link (master, adpcm). `relay`: the S3 is behind a real
// relay instead of on a cable (true, or the options of relayedS3); the bridge then opens the relay port, and `relayed` is its handle.
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent, s3: s3Options = {}, link: linkOptions = {}, relay = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
```

In `bridge/test/helpers/world.js`, replace:

```js
  const s3 = new FakeS3(s3Options);
  const lines = [];
```

with:

```js
  const s3 = new FakeS3(s3Options);
  const relayed = relay ? await relayedS3(t, s3, { master: linkOptions.master ?? null, ...(relay === true ? {} : relay) }) : null;
  const lines = [];
```

In `bridge/test/helpers/world.js`, replace:

```js
    adapters: adapters ?? providers(said, spoken, { intent }),
    openPort: openPort ?? (async () => s3),
    store,
```

with:

```js
    adapters: adapters ?? providers(said, spoken, { intent }),
    openPort: openPort ?? relayed?.openPort ?? (async () => s3),
    store,
```

In `bridge/test/helpers/world.js`, replace:

```js
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order };
}
```

with:

```js
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order, relayed };
}
```

Create `bridge/test/relay-turn.test.js`:

```js
// The whole bridge with the S3 on the far side of a real relay instead of a cable: the same turns as in main.test.js, sealed and plain,
// and the two ways a network differs from USB: the S3 leaves and comes back, and the relay itself goes away and comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/src/server.js';
import { Link } from '../src/link/link.js';
import { TYPE } from '../src/link/frame.js';
import { UI_STATE } from '../src/link/messages.js';
import { FakeS3, until } from './helpers/fake-s3.js';
import { relayedS3 } from './helpers/relay-s3.js';
import { speechPcm, world } from './helpers/world.js';

const KEY = Buffer.alloc(32, 0x42);
const FAST = { pingEveryMs: 100, pongTimeoutMs: 400 };

test('over the relay, a spoken request goes through the screens, to Claude, and its reply is shown and spoken on the S3', async (t) => {
  const w = await world(t, { said: ['你好'], relay: true });
  assert.equal(w.bridge.link.ready, true);
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  assert.deepEqual(w.order(), [UI_STATE.IDLE, UI_STATE.TRANSCRIBING, UI_STATE.CONFIRM, UI_STATE.WORKING, UI_STATE.REPLY]);
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.ok(w.s3.audioDown().bytes > 0);
  assert.equal(w.s3.badDown, 0);
});

test('over the relay, a tool call that needs approval is shown on the S3, and the key that allows it lets Claude go on', async (t) => {
  const w = await world(t, { said: ['!write note.txt'], relay: true });
  w.s3.take(speechPcm);
  await until(() => w.s3.frames(TYPE.APPROVAL_REQ).length === 1, 'the approval on the S3');
  const shown = w.s3.screens().find((s) => s.approval).approval;
  w.s3.answer(shown.id, true);
  await until(() => w.s3.screens().some((s) => s.text === 'Created note.txt.'), 'Claude to go on');
});

test('over the relay, with the pairing key and ADPCM, a whole turn runs sealed, and the room is the one the key names', async (t) => {
  const w = await world(t, { said: ['你好'], relay: true, s3: { proto: 2, master: KEY, adpcm: true }, link: { master: KEY, adpcm: true } });
  await until(() => w.s3.upCodec === 1, 'the S3 asked for ADPCM takes');
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.ok(w.s3.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'every frame after HELLO was sealed');
  assert.equal(w.s3.refused.length, 0);
  assert.ok(w.s3.frames(TYPE.AUDIO_DOWN).every((f) => !f.payload.length || (f.flags & 0x06) === 0x02), 'the reply went down as ADPCM');
  assert.match(w.relayed.room, /^[0-9a-f]{32}$/);
  assert.notEqual(w.relayed.room, 'd'.repeat(32), 'a paired link is not in the test room');
});

// A Link on the relay with the fast clock, and what it said.
async function linkOnRelay(t, { master = null, s3Options = {}, relay = null } = {}) {
  const s3 = new FakeS3(s3Options);
  const relayed = await relayedS3(t, s3, { master, clock: FAST, relay });
  const link = new Link({ openPort: relayed.openPort, master, makeNonce: () => 9, retryMs: 50, retryMaxMs: 200 });
  const seen = { down: [], hello: [] };
  link.on('down', (r) => seen.down.push(r));
  link.on('hello', (h) => seen.hello.push(h));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return { s3, relayed, link, seen };
}

test('the S3 leaves the room and comes back: the link says it lost the S3, and is ready again when it is back, sealed as before', async (t) => {
  const { s3, relayed, link, seen } = await linkOnRelay(t, { master: KEY, s3Options: { proto: 2, master: KEY } });
  relayed.unplug();
  await until(() => !link.ready, 'the link to notice the S3 is gone');
  assert.match(seen.down[0], /^no PONG for 0\.4 s$/);
  await relayed.plug();
  await until(() => link.ready, 'the link to be ready again');
  const before = s3.sent.length;
  link.send(TYPE.PING, Buffer.alloc(8));
  await until(() => s3.sent.length > before, 'a frame to reach the S3 again');
  assert.equal(s3.refused.length, 0, 'and the S3 opened everything it was sent');
});

test('the relay goes away and comes back: the link, and the S3, find their way back by themselves', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 60_000 });
  const { link, seen, relayed } = await linkOnRelay(t, { relay });
  const port = relay.port;
  await relay.close();
  await until(() => !link.ready && !relayed.joined, 'both ends to notice');
  assert.equal(seen.down.length, 1);
  const back = await startRelay({ port, host: '127.0.0.1', pingEveryMs: 60_000 });
  t.after(() => back.close());
  await until(() => link.ready, 'the link to be ready through the relay that came back');
  assert.equal(relayed.joined, true);
});

test('a relay with nobody in the room is no S3: the link opens, is not ready, and says nothing is wrong with the relay', async (t) => {
  const s3 = new FakeS3();
  const relayed = await relayedS3(t, s3, { clock: FAST });
  relayed.unplug();
  const link = new Link({ openPort: relayed.openPort, makeNonce: () => 9 });
  const status = [];
  link.on('status', (s) => status.push(s));
  t.after(() => link.close());
  await link.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(link.ready, false);
  assert.deepEqual(status, [], 'the port opened, so there is nothing to report but silence');
  await relayed.plug();
  await until(() => link.ready, 'the S3 arriving later is found by the next HELLO');
});
```

- [ ] **Step 2: Run them**

Run: `node --test bridge/test/relay-turn.test.js`
Expected: PASS, 6 tests, 0 fail. They pass as soon as they are written: the code under them is Tasks 2 to 5's, and this task is the proof that it carries whole turns.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 838 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 4: Commit**

```powershell
git add bridge/test/helpers/relay-s3.js bridge/test/helpers/world.js bridge/test/relay-turn.test.js
git commit -m "Task 6: the stand-in S3 behind a real relay: whole turns over it, sealed and plain, the S3 leaving and returning, the relay going away and returning" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Choosing the transport

`chooseTransport` returns the `openPort` the `Link` calls on every (re)connect. It opens the cable when `findUsb()` finds the S3; if the port is there but will not open, that is the error, with no fall-back. With no cable it reads the relay host (each time, so a host set later is used) and opens the relay, or throws a message that says what to run. While a relay port is open it polls for the cable every `pollMs`, without overlapping polls, and when the cable appears it says so and closes the relay port, so the `Link` opens again and gets the cable. A relay port closed as `replaced` holds the relay back for `replacedPenaltyMs`; the cable is never held back.

**Files:**
- Create: `bridge/src/link/transport.js`
- Test (new): `bridge/test/link/transport.test.js`

**Interfaces:**
- Consumes: `openRelayPort`'s port shape and `replaced` (Task 4). Nothing else; every dependency is passed in.
- Produces: `bridge/src/link/transport.js`: `chooseTransport({ findUsb, openUsb, openRelay, relayHost, status, pollMs = 3000, replacedPenaltyMs = 300_000, now }): openPort`; errors `cannot open the S3 on USB (...)` and `no S3 on USB, and no relay set (walkie relay <host>)`.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/link/transport.test.js`:

```js
// Which carrier the Link gets: the cable when the S3 is on it, the relay when it is not, and back to the cable when it appears while
// the bridge is on the relay. All three ways of opening a port are stubs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chooseTransport } from '../../src/link/transport.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

class StubPort extends EventEmitter {
  closed = 0;
  constructor(kind) {
    super();
    this.kind = kind;
  }
  close() {
    this.closed++;
    this.emit('close');
  }
}

// `usb`: the path findUsb answers with (changeable); `host`: what the relay config holds (changeable).
function setup(t, { usb = null, host = null, ...options } = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const s = {
    usb,
    host,
    finds: 0,
    usbOpens: [],
    relayOpens: [],
    ports: [],
    said: [],
    findUsb: async () => {
      s.finds++;
      if (s.findError) throw s.findError;
      return s.usb;
    },
    openUsb: async (path) => {
      s.usbOpens.push(path);
      if (s.usbError) throw s.usbError;
      const p = new StubPort(undefined);
      s.ports.push(p);
      return p;
    },
    openRelay: async (h) => {
      s.relayOpens.push(h);
      if (s.relayError) throw s.relayError;
      const p = new StubPort('relay');
      s.ports.push(p);
      return p;
    },
  };
  s.openPort = chooseTransport({
    findUsb: s.findUsb,
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => s.host,
    status: (text) => s.said.push(text),
    ...options,
  });
  t.after(() => s.ports.forEach((p) => p.removeAllListeners()));
  return s;
}

test('the S3 on USB is opened, and the relay is not touched even when one is set', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  const port = await s.openPort();
  assert.deepEqual(s.usbOpens, ['COM8']);
  assert.deepEqual(s.relayOpens, []);
  assert.equal(port, s.ports[0]);
  assert.equal(port.kind, 'usb');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(s.finds, 1, 'a cable needs no watching');
});

test('no S3 on USB and a relay set: the relay is opened, with the host as it is now', async (t) => {
  const s = setup(t, { host: 'one.fly.dev' });
  const port = await s.openPort();
  assert.deepEqual(s.relayOpens, ['one.fly.dev']);
  assert.equal(port.kind, 'relay');
  s.host = 'two.fly.dev';
  port.close();
  await s.openPort();
  assert.deepEqual(s.relayOpens, ['one.fly.dev', 'two.fly.dev'], 'the config is read on every open');
});

test('no S3 on USB and no relay set: it fails saying how to set one, and opens nothing', async (t) => {
  const s = setup(t);
  await assert.rejects(s.openPort(), /no S3 on USB, and no relay set \(walkie relay <host>\)/);
  assert.deepEqual([s.usbOpens, s.relayOpens], [[], []]);
  s.host = '';
  await assert.rejects(s.openPort(), /no relay set/, 'an empty host is no host');
});

test('the S3 is on USB but cannot be opened: that is the answer, not a reason to go round by the relay', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.usbError = new Error('Access denied');
  await assert.rejects(s.openPort(), /cannot open the S3 on USB \(Access denied\)/);
  assert.deepEqual(s.relayOpens, []);
});

test('a failure of the port search counts as no S3 on USB', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.findError = new Error('list failed');
  const port = await s.openPort();
  assert.equal(port.kind, 'relay');
});

test('a relay that cannot be reached is the open failing, with its own message', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  s.relayError = new Error('could not reach the relay at walkie.fly.dev');
  await assert.rejects(s.openPort(), /could not reach the relay at walkie\.fly\.dev/);
});

test('on the relay it looks for the S3 on USB every 3 s, and when it is there the relay is let go, so the next open is the cable', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const relay = await s.openPort();
  assert.equal(s.finds, 1);
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(s.finds, 1, 'not before 3 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(s.finds, 2);
  assert.equal(relay.closed, 0, 'no cable yet');
  s.usb = 'COM8';
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(relay.closed, 1, 'the cable is in: the relay is let go');
  assert.deepEqual(s.said, ['the S3 is on USB: leaving the relay']);
  const next = await s.openPort();
  assert.deepEqual(s.usbOpens, ['COM8']);
  assert.equal(next.kind, 'usb');
});

test('the looking stops when the relay port is gone, and starts again with the next one', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const relay = await s.openPort();
  relay.close();
  const finds = s.finds;
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(s.finds, finds, 'nothing is watched');
  await s.openPort();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(s.finds, finds + 2, 'one for the open, one for the first look');
});

test('a slow search is not run twice at once', async (t) => {
  const s = setup(t);
  let calls = 0;
  let running = 0;
  let most = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const open = chooseTransport({
    findUsb: async () => {
      if (++calls === 1) return null; // the open itself
      running++;
      most = Math.max(most, running);
      await gate;
      running--;
      return null;
    },
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => 'walkie.fly.dev',
  });
  await open();
  t.mock.timers.tick(9000); // three polls come due while the first search is still running
  await flush();
  assert.equal(calls, 2, 'only the first poll started a search');
  assert.equal(most, 1);
  release();
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(calls, 3, 'the next poll runs once the search is over');
});

test('a search that finishes after the relay port closed on its own does not close anything again', async (t) => {
  const s = setup(t);
  let calls = 0;
  let finish;
  const lateUsb = new Promise((resolve) => (finish = resolve));
  const open = chooseTransport({
    findUsb: async () => {
      if (++calls === 1) return null;
      await lateUsb;
      return 'COM8';
    },
    openUsb: s.openUsb,
    openRelay: s.openRelay,
    relayHost: () => 'walkie.fly.dev',
    status: (x) => s.said.push(x),
  });
  const port = await open();
  t.mock.timers.tick(3000); // a search starts and waits
  await flush();
  assert.equal(calls, 2);
  port.close(); // the relay hangs up first
  finish();
  await flush();
  assert.equal(port.closed, 1, 'closed once, by the relay');
  assert.deepEqual(s.said, [], 'and no claim that it left the relay');
});

test('a bridge replaced in the room by another does not take the room back for 5 minutes, and says so once', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.closeCode = 4000;
  first.replaced = true;
  first.close();
  assert.equal(s.said.length, 1);
  assert.match(s.said[0], /^another walkie run took the relay room; not going back to it for 5 min$/);
  await assert.rejects(s.openPort(), /another walkie run holds the relay room/);
  t.mock.timers.tick(299_000);
  await assert.rejects(s.openPort(), /another walkie run holds the relay room/);
  assert.equal(s.relayOpens.length, 1, 'the relay is not dialled in the meantime');
  t.mock.timers.tick(1000);
  const again = await s.openPort();
  assert.equal(again.kind, 'relay');
  assert.equal(s.said.length, 1, 'nothing more was said');
});

test('the cable is still taken during the penalty: only the relay is held back', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.replaced = true;
  first.close();
  s.usb = 'COM8';
  const port = await s.openPort();
  assert.equal(port.kind, 'usb');
});

test('a relay port that closed for another reason carries no penalty', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  const first = await s.openPort();
  first.replaced = false;
  first.close();
  const second = await s.openPort();
  assert.equal(second.kind, 'relay');
  assert.deepEqual(s.said, []);
});

test('the penalty and the poll are settable', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev', pollMs: 100, replacedPenaltyMs: 1000 });
  const first = await s.openPort();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(s.finds, 2, 'a poll every 100 ms');
  first.replaced = true;
  first.close();
  await assert.rejects(s.openPort(), /another walkie run/);
  t.mock.timers.tick(1000);
  await s.openPort();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/transport.test.js`
Expected: FAIL, the file `bridge/test/link/transport.test.js` cannot load, because it imports `bridge/src/link/transport.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/link/transport.js`:

```js
// Which carrier the Link gets. The cable wins: when the S3 is on USB that is the port. Without it the bridge goes by the relay, and
// while it is there it looks for the S3 on USB every few seconds and lets the relay go when it appears, so that the Link's next open
// is the cable. Only the relay is held back when another walkie run takes the room; the cable never is.

// `findUsb()` answers the S3's USB path or null, `openUsb(path)` and `openRelay(host)` open a port, `relayHost()` is the relay in the
// config now (read on every open), `status(text)` is told what is worth a line on the console. Returns the `openPort` the Link wants.
export function chooseTransport({
  findUsb,
  openUsb,
  openRelay,
  relayHost,
  status = () => {},
  pollMs = 3000,
  replacedPenaltyMs = 5 * 60_000,
  now = Date.now,
}) {
  let relayHeldBackUntil = 0;

  const usbPath = async () => {
    try {
      return (await findUsb()) ?? null;
    } catch {
      return null; // a search that fails is an S3 that was not found
    }
  };

  function watch(port) {
    let searching = false;
    let gone = false;
    const timer = setInterval(async () => {
      if (searching) return;
      searching = true;
      try {
        if ((await usbPath()) && !gone) {
          status('the S3 is on USB: leaving the relay');
          port.close();
        }
      } finally {
        searching = false;
      }
    }, pollMs);
    port.on('close', () => {
      gone = true;
      clearInterval(timer);
      if (port.replaced) {
        relayHeldBackUntil = now() + replacedPenaltyMs;
        status(`another walkie run took the relay room; not going back to it for ${Math.round(replacedPenaltyMs / 60_000)} min`);
      }
    });
  }

  return async function openPort() {
    const path = await usbPath();
    if (path) {
      let port;
      try {
        port = await openUsb(path);
      } catch (err) {
        throw new Error(`cannot open the S3 on USB (${err.message})`); // it is there; the relay is no answer to a port that is busy
      }
      port.kind ??= 'usb';
      return port;
    }
    const host = relayHost();
    if (!host) throw new Error('no S3 on USB, and no relay set (walkie relay <host>)');
    if (now() < relayHeldBackUntil) throw new Error('another walkie run holds the relay room');
    const port = await openRelay(host);
    watch(port);
    return port;
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/transport.test.js`
Expected: PASS, 14 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 852 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/transport.js bridge/test/link/transport.test.js
git commit -m "Task 7: the transport chooser: the cable when the S3 is on it, the relay when not, back to the cable when it appears, the relay held back after another bridge takes the room" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The relay host on the PC, and the bridge on either transport

The relay host is a setting: `%APPDATA%\walkie\relay.txt`, written atomically, checked by `normalizeRelayHost` (which accepts what `relayUrl` accepts). `walkie relay <host>`, `walkie relay` and `walkie relay --forget` set, show and forget it on this PC (Task 11 adds the S3's half). `bridgeOpenPort` is what `bin/walkie.js` now gives the `Link`: the cable alone unless both a key and a host are set, else `chooseTransport` over the cable and the relay; `describeTransport` is the one line the bin prints about it. A failed open of the cable carries `retryInMs` (1000) and the `Link` takes it as is instead of backing off, and `startBridge` passes a `retry` option (`{ retryMs, retryMaxMs }`) to the `Link`; the bin uses 1 s to 30 s.

**Files:**
- Create: `bridge/src/config/relay.js`, `bridge/src/link/open-port.js`, `bridge/src/relay-cli.js`
- Modify: `bridge/bin/walkie.js`, `bridge/src/cli.js`, `bridge/src/link/link.js`, `bridge/src/link/transport.js`, `bridge/src/main.js`
- Test (new): `bridge/test/config/relay.test.js`, `bridge/test/link/open-port.test.js`, `bridge/test/relay-cli.test.js`
- Test (changed): `bridge/test/cli.test.js`, `bridge/test/link/link-timing.test.js`, `bridge/test/link/transport.test.js`, `bridge/test/main.test.js`, `bridge/test/walkie-bin.test.js`

**Interfaces:**
- Consumes: `chooseTransport` (Task 7), `openRelayPort` and `relayUrl` (Task 4), `roomId` (Task 3), the `Link`'s `retryMaxMs` (Task 5), `findS3Port` and `openS3Port` (plan 1), `loadPairKey` (plan 5).
- Produces: `bridge/src/config/relay.js`: `defaultRelayFile(env)`, `normalizeRelayHost(text)` (`RangeError`), `loadRelayHost({ file, read }): string | null`, `saveRelayHost(text, { file }): string`, `clearRelayHost({ file })`.
- Produces: `bridge/src/relay-cli.js`: `relayCommand({ host, forget, file, read, say, err }): 0 | 1 | 2`.
- Produces: `bridge/src/link/open-port.js`: `bridgeOpenPort({ port, master, relayHost, log, pollMs, findS3Port, openS3Port, openRelayPort })`, `describeTransport({ master, host, port }): string`.
- Produces: `bridge/src/link/transport.js`: `CABLE_WAIT_MS` (1000). `parseWalkieCommand` returns `{ command: 'relay', host, forget, opts }`. `startBridge({ ..., retry })`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `bridge/test/cli.test.js` with:

```js
// The command line of `walkie`: what it takes and what it makes of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../src/dev/args.js';
import { parseWalkieCommand } from '../src/cli.js';

test('no words runs the bridge; --clean-env, --port, --command, --inject and --codec are its options', () => {
  assert.deepEqual(parseWalkieCommand([]), { command: 'run', cleanEnv: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['--clean-env', '--port', 'COM8', '--codec', 'adpcm']), {
    command: 'run', cleanEnv: true, opts: { port: 'COM8', codec: 'adpcm' },
  });
});

test('pair, and pair --forget, are the pairing commands, and take --port', () => {
  assert.deepEqual(parseWalkieCommand(['pair']), { command: 'pair', forget: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['pair', '--forget', '--port', 'COM8']), { command: 'pair', forget: true, opts: { port: 'COM8' } });
  assert.deepEqual(parseWalkieCommand(['--port', 'COM8', 'pair']), { command: 'pair', forget: false, opts: { port: 'COM8' } });
});

test('anything else is a usage error: a word, --forget without pair, --codec or --clean-env with pair', () => {
  for (const argv of [['listen'], ['--forget'], ['pair', 'now'], ['pair', '--bogus'], ['pair', '--clean-env'], ['pair', '--codec', 'pcm'], ['pair', '--inject', 'a.wav'], ['pair', '--command', '[]'], ['--codec', 'opus']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});

test('relay shows the relay set on this PC, relay <host> sets it, relay --forget clears it', () => {
  assert.deepEqual(parseWalkieCommand(['relay']), { command: 'relay', host: null, forget: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', 'walkie-relay.fly.dev']), { command: 'relay', host: 'walkie-relay.fly.dev', forget: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', '--forget']), { command: 'relay', host: null, forget: true, opts: {} });
});

test('relay takes one host or --forget and no option', () => {
  for (const argv of [['relay', 'a.fly.dev', 'b.fly.dev'], ['relay', 'a.fly.dev', '--forget'], ['relay', '--port', 'COM8'], ['relay', '--codec', 'adpcm'], ['relay', '--clean-env'], ['relay', '--inject', 'a.wav']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});
```

Create `bridge/test/config/relay.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearRelayHost, defaultRelayFile, loadRelayHost, normalizeRelayHost, saveRelayHost } from '../../src/config/relay.js';

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'relay.txt'); // the folder does not exist yet
}

test('the relay host lives beside the pairing key in %APPDATA%\\walkie, and there is no default without APPDATA', () => {
  assert.equal(defaultRelayFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'walkie', 'relay.txt'));
  assert.equal(defaultRelayFile({}), null);
});

test('a host name is what a person types: trimmed, a trailing slash dropped, wss:// and a port allowed', () => {
  assert.equal(normalizeRelayHost('  walkie-relay.fly.dev \r\n'), 'walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('walkie-relay.fly.dev/'), 'walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('wss://walkie-relay.fly.dev'), 'wss://walkie-relay.fly.dev');
  assert.equal(normalizeRelayHost('relay.example.com:8443'), 'relay.example.com:8443');
  assert.equal(normalizeRelayHost('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
  for (const bad of ['', '   ', 'a b', 'ws://relay.fly.dev', 'http://relay.fly.dev', 'relay.fly.dev/path', 'user@relay.fly.dev', 'relay.fly.dev?x=1']) {
    assert.throws(() => normalizeRelayHost(bad), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => normalizeRelayHost(undefined), RangeError);
});

test('with no file there is no relay, and that is not an error', (t) => {
  assert.equal(loadRelayHost({ file: tempFile(t) }), null);
  assert.equal(loadRelayHost({ file: null }), null);
});

test('a host is saved and loaded back, the folder is made, and nothing else is left beside it', (t) => {
  const file = tempFile(t);
  saveRelayHost(' walkie-relay.fly.dev/ ', { file });
  assert.equal(readFileSync(file, 'utf8'), 'walkie-relay.fly.dev\n');
  assert.equal(loadRelayHost({ file }), 'walkie-relay.fly.dev');
  saveRelayHost('other.fly.dev', { file });
  assert.equal(loadRelayHost({ file }), 'other.fly.dev', 'saving again replaces it');
  assert.deepEqual(readdirSync(path.dirname(file)), ['relay.txt']);
});

test('a host that is not a host is refused before anything is written', (t) => {
  const file = tempFile(t);
  assert.throws(() => saveRelayHost('ws://relay.fly.dev', { file }), RangeError);
  assert.equal(existsSync(path.dirname(file)), false, 'not even the folder');
  assert.throws(() => saveRelayHost('x.fly.dev', { file: null }), /nowhere to keep a relay host: %APPDATA% is not set/);
});

test('a file written by hand is read with its BOM and CRLF, and one that is not a host is an error naming the file', (t) => {
  const file = tempFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '\ufeffwalkie-relay.fly.dev\r\n');
  assert.equal(loadRelayHost({ file }), 'walkie-relay.fly.dev');
  writeFileSync(file, 'not a host name\n');
  assert.throws(() => loadRelayHost({ file }), (err) => err.message.includes(file) && /does not hold a host name/.test(err.message));
  writeFileSync(file, '\n');
  assert.equal(loadRelayHost({ file }), null, 'an empty file is no relay');
});

test('a file that cannot be read says so with its code and not its content', (t) => {
  const file = tempFile(t);
  const unreadable = () => {
    throw Object.assign(new Error('boom walkie.fly.dev'), { code: 'EACCES' });
  };
  assert.throws(
    () => loadRelayHost({ file, read: unreadable }),
    (err) => err.message === `cannot read the relay file ${file} (EACCES)`,
  );
});

test('clearing removes the file, and clearing what is not there is fine', (t) => {
  const file = tempFile(t);
  clearRelayHost({ file });
  saveRelayHost('walkie-relay.fly.dev', { file });
  clearRelayHost({ file });
  assert.equal(loadRelayHost({ file }), null);
  assert.equal(existsSync(file), false);
});
```

In `bridge/test/link/link-timing.test.js`, replace:

```js
  assert.deepEqual(tries, [0]);
});
```

with:

```js
  assert.deepEqual(tries, [0]);
});

test('an open that fails with a wait of its own is retried after that wait, and does not push the backoff on', async (t) => {
  clock(t);
  const tries = [];
  const link = new Link({
    openPort: async () => {
      tries.push(Date.now());
      const err = new Error('no S3');
      if (tries.length <= 3) err.retryInMs = 500;
      throw err;
    },
    retryMs: 1000,
    retryMaxMs: 30_000,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 4500, 500);
  assert.deepEqual(tries, [0, 500, 1000, 1500, 2500, 4500], 'three short waits, then the backoff from where it was: 1 s, 2 s');
});

test('a wait that is not a positive number is no wait of its own', async (t) => {
  clock(t);
  const hints = [0, -5, NaN, Infinity, '500', null, undefined];
  const tries = [];
  const link = new Link({
    openPort: async () => {
      const err = new Error('no S3');
      err.retryInMs = hints[tries.length];
      tries.push(Date.now());
      throw err;
    },
    retryMs: 1000,
  });
  t.after(() => link.close());
  await link.start();
  await advance(t, 6000, 500);
  assert.deepEqual(tries, [0, 1000, 2000, 3000, 4000, 5000, 6000]);
});
```

Create `bridge/test/link/open-port.test.js`:

```js
// The openPort that `walkie` gives the Link: the cable alone unless there is a pairing key and a relay, then the transport chooser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bridgeOpenPort, describeTransport } from '../../src/link/open-port.js';
import { Link } from '../../src/link/link.js';
import { roomId } from '../../src/link/room.js';
import { FakeS3, until } from '../helpers/fake-s3.js';
import { relayedS3 } from '../helpers/relay-s3.js';

const KEY = Buffer.alloc(32, 0x42);

class StubPort extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
  }
  close() {
    this.emit('close');
  }
}

// `usb` is the path the search finds now, and may be changed.
function deps(over = {}) {
  const d = {
    calls: { found: 0, usb: [], relay: [] },
    usb: over.usb ?? null,
    findS3Port: async () => {
      d.calls.found++;
      return d.usb;
    },
    openS3Port: async (path) => {
      d.calls.usb.push(path);
      if (over.usbError) throw over.usbError;
      return new StubPort(`usb ${path}`);
    },
    openRelayPort: async (o) => {
      d.calls.relay.push(o);
      return new StubPort('relay');
    },
  };
  return d;
}

test('--port COM8 is the cable and only the cable, whatever else is configured', async () => {
  const d = deps();
  const open = bridgeOpenPort({ port: 'COM8', master: KEY, relayHost: () => 'walkie.fly.dev', ...d });
  const port = await open();
  assert.equal(port.label, 'usb COM8');
  assert.deepEqual(d.calls.usb, ['COM8']);
  assert.deepEqual(d.calls.relay, []);
  assert.equal(d.calls.found, 0, 'it was told which port, so it does not look');
});

test('with no relay set it is the cable alone: the S3 found, or an error whose message is as it always was, retried at the short wait', async () => {
  const found = deps({ usb: 'COM9' });
  assert.equal((await bridgeOpenPort({ master: KEY, relayHost: () => null, ...found })()).label, 'usb COM9');
  const none = deps();
  await assert.rejects(bridgeOpenPort({ master: KEY, relayHost: () => null, ...none })(), (err) => err.message === 'no S3 on USB (303A:1001)' && err.retryInMs === 1000);
});

test('a cable that is there but cannot be opened is an error the Link retries at the short wait', async () => {
  const d = deps({ usb: 'COM9', usbError: new Error('Access denied') });
  await assert.rejects(bridgeOpenPort({ relayHost: () => null, ...d })(), (err) => /Access denied/.test(err.message) && err.retryInMs === 1000);
});

test('a relay without a pairing key is not used: nothing names the room but the key', async () => {
  const d = deps();
  await assert.rejects(bridgeOpenPort({ master: null, relayHost: () => 'walkie.fly.dev', ...d })(), /no S3 on USB \(303A:1001\)/);
  assert.deepEqual(d.calls.relay, []);
});

test('with a key and a relay and no cable it joins the room the key names, as the PC, at the host in the file now', async () => {
  const d = deps();
  let host = 'one.fly.dev';
  const open = bridgeOpenPort({ master: KEY, relayHost: () => host, ...d });
  const port = await open();
  assert.equal(port.label, 'relay');
  assert.deepEqual(d.calls.relay, [{ host: 'one.fly.dev', room: roomId(KEY) }]);
  host = 'two.fly.dev';
  await open();
  assert.equal(d.calls.relay[1].host, 'two.fly.dev', 'the file is read on every open');
  host = null;
  await assert.rejects(open(), /no S3 on USB \(303A:1001\)/, 'a relay that was taken out of the file is no longer tried');
});

test('with a key and a relay the cable still comes first', async () => {
  const d = deps({ usb: 'COM9' });
  const port = await bridgeOpenPort({ master: KEY, relayHost: () => 'walkie.fly.dev', ...d })();
  assert.equal(port.label, 'usb COM9');
  assert.deepEqual(d.calls.relay, []);
});

test('what the chooser says goes to the log', async () => {
  const lines = [];
  const d = deps();
  const open = bridgeOpenPort({ master: KEY, relayHost: () => 'walkie.fly.dev', log: (s) => lines.push(s), pollMs: 20, ...d });
  const relay = await open();
  d.usb = 'COM9';
  try {
    await until(() => lines.length > 0, 'a line about leaving the relay', 1500);
  } finally {
    relay.close();
  }
  assert.deepEqual(lines, ['the S3 is on USB: leaving the relay']);
});

test('describeTransport says in one line which way the bridge will go', () => {
  assert.equal(describeTransport({ master: KEY, host: 'walkie.fly.dev', port: null }), 'USB when the S3 is on it, else the relay at walkie.fly.dev');
  assert.equal(describeTransport({ master: KEY, host: null, port: null }), 'USB only (no relay set: node bridge/bin/walkie.js relay <host>)');
  assert.equal(describeTransport({ master: null, host: 'walkie.fly.dev', port: null }), 'USB only: the relay at walkie.fly.dev needs a pairing key (node bridge/bin/walkie.js pair)');
  assert.equal(describeTransport({ master: null, host: null, port: null }), 'USB only');
  assert.equal(describeTransport({ master: KEY, host: 'walkie.fly.dev', port: 'COM8' }), 'USB only, on COM8 as asked');
});

// The real relay, a stand-in S3 behind it, and a stand-in S3 on the cable: the Link starts on the relay and moves to the cable.
test('on the relay, plugging the cable in moves the link to it, sealed, without anyone restarting anything', async (t) => {
  const behind = new FakeS3({ proto: 2, master: KEY });
  const relayed = await relayedS3(t, behind, { master: KEY });
  const onCable = new FakeS3({ proto: 2, master: KEY });
  let cable = null;
  const opened = [];
  const open = bridgeOpenPort({
    master: KEY,
    relayHost: () => relayed.host,
    pollMs: 30,
    findS3Port: async () => cable,
    openS3Port: async (path) => {
      opened.push(path);
      return onCable;
    },
    openRelayPort: (o) => relayed.openPort(o),
  });
  const link = new Link({ openPort: open, master: KEY, makeNonce: () => 5, retryMs: 20 });
  const down = [];
  link.on('down', (r) => down.push(r));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'ready over the relay');
  assert.deepEqual(opened, []);
  const pingsBefore = onCable.sent.length;
  cable = 'COM9';
  await until(() => opened.length === 1, 'the cable to be opened', 1500);
  await until(() => link.ready && onCable.sent.length > pingsBefore, 'ready again, over the cable');
  assert.deepEqual(opened, ['COM9']);
  assert.equal(onCable.refused.length, 0, 'the cable end opened everything it was sent');
  assert.ok(down.length >= 1, 'the move was a down and an up, not a silent swap');
});
```

In `bridge/test/link/transport.test.js`, replace:

```js
  await s.openPort();
});
```

with:

```js
  await s.openPort();
});

test('a cable that cannot be opened, and a relay that is not set, are errors for the short wait: the cable may be plugged in any moment', async (t) => {
  const s = setup(t, { usb: 'COM8', host: 'walkie.fly.dev' });
  s.usbError = new Error('Access denied');
  await assert.rejects(s.openPort(), (err) => err.retryInMs === 1000);
  s.usb = null;
  s.host = null;
  await assert.rejects(s.openPort(), (err) => /no relay set/.test(err.message) && err.retryInMs === 1000);
});

test('a relay held back, and a relay that cannot be reached, are left to the backoff', async (t) => {
  const s = setup(t, { host: 'walkie.fly.dev' });
  s.relayError = new Error('could not reach the relay');
  await assert.rejects(s.openPort(), (err) => err.retryInMs === undefined);
  s.relayError = null;
  const first = await s.openPort();
  first.replaced = true;
  first.close();
  await assert.rejects(s.openPort(), (err) => err.retryInMs === undefined);
});
```

In `bridge/test/main.test.js`, replace:

```js
  assert.equal(w.s3.badDown, 0);
});
```

with:

```js
  assert.equal(w.s3.badDown, 0);
});

test("the retry settings given to the bridge are the link's", async (t) => {
  let tries = 0;
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command: [process.execPath, FAKE_CLAUDE], prewarm: false } },
    projects: [{ name: 'proj', aliases: [], path: tmpdir() }],
    adapters: [],
    openPort: async () => {
      tries++;
      throw new Error('no S3');
    },
    retry: { retryMs: 20, retryMaxMs: 20 },
    store: createStateStore({ file: null }),
    console: createConsole({ out: () => {} }),
  });
  t.after(() => bridge.close());
  await until(() => tries >= 4, 'several tries in a moment (the default is one a second)');
});
```

Create `bridge/test/relay-cli.test.js`:

```js
// walkie relay: the relay host on this PC, set, shown and forgotten, with the console around it and an exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRelayHost } from '../src/config/relay.js';
import { relayCommand } from '../src/relay-cli.js';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-relaycli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'relay.txt');
  const said = [];
  const errs = [];
  const run = (opts) => relayCommand({ file, say: (s) => said.push(s), err: (s) => errs.push(s), ...opts });
  return { file, said, errs, run };
}

test('with no host and no --forget it shows what is set, or says none is and how to set one', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: null, forget: false }), 0);
  assert.deepEqual(f.said, ['relay: none set (node bridge/bin/walkie.js relay <host>)']);
  f.run({ host: 'walkie-relay.fly.dev', forget: false });
  f.said.length = 0;
  assert.equal(f.run({ host: null, forget: false }), 0);
  assert.deepEqual(f.said, ['relay: walkie-relay.fly.dev']);
});

test('a host is kept, as normalised, and said back', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: ' walkie-relay.fly.dev/ ', forget: false }), 0);
  assert.deepEqual(f.said, ['relay set on this PC: walkie-relay.fly.dev']);
  assert.equal(loadRelayHost({ file: f.file }), 'walkie-relay.fly.dev');
});

test('a host that is not one is exit 2 with the reason, and nothing changes', (t) => {
  const f = fixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(f.run({ host: 'ws://relay.fly.dev', forget: false }), 2);
  assert.match(f.errs[0], /^walkie: not a relay host name/);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
});

test('an empty host is not a request to show: it is a host that is not one, exit 2', (t) => {
  const f = fixture(t);
  f.run({ host: 'one.fly.dev', forget: false });
  assert.equal(f.run({ host: '', forget: false }), 2);
  assert.match(f.errs[0], /not a relay host name/);
  assert.equal(loadRelayHost({ file: f.file }), 'one.fly.dev');
});

test('--forget removes it, and forgetting what is not there is fine', (t) => {
  const f = fixture(t);
  assert.equal(f.run({ host: null, forget: true }), 0);
  f.run({ host: 'one.fly.dev', forget: false });
  f.said.length = 0;
  assert.equal(f.run({ host: null, forget: true }), 0);
  assert.deepEqual(f.said, ['relay forgotten on this PC']);
  assert.equal(loadRelayHost({ file: f.file }), null);
});

test('a file that cannot be read or a place that cannot be written is exit 1 with the message', (t) => {
  const f = fixture(t);
  assert.equal(relayCommand({ file: null, host: 'one.fly.dev', forget: false, say: () => {}, err: (s) => f.errs.push(s) }), 1);
  assert.match(f.errs[0], /nowhere to keep a relay host/);
  const unreadable = () => {
    throw Object.assign(new Error('x'), { code: 'EACCES' });
  };
  assert.equal(relayCommand({ file: f.file, host: null, forget: false, say: () => {}, err: (s) => f.errs.push(s), read: unreadable }), 1);
  assert.match(f.errs[1], /cannot read the relay file .* \(EACCES\)/);
});
```

In `bridge/test/walkie-bin.test.js`, replace:

```js
    rmSync(dir, { recursive: true, force: true });
  }
});
```

with:

```js
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relay sets, shows and forgets the relay host in %APPDATA%, and refuses what is not a host', () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const go = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    assert.match(go('relay').out, /relay: none set/);
    const set = go('relay', 'walkie-relay.fly.dev');
    assert.equal(set.status, 0);
    assert.match(set.out, /relay set on this PC: walkie-relay.fly.dev/);
    assert.match(go('relay').out, /relay: walkie-relay.fly.dev/);
    for (const bad of ['a b', 'ws://relay.fly.dev']) {
      const r = go('relay', bad);
      assert.equal(r.status, 2, bad);
      assert.match(r.err, /walkie: /);
    }
    assert.match(go('relay').out, /relay: walkie-relay.fly.dev/, 'a refused host changed nothing');
    const forget = go('relay', '--forget');
    assert.equal(forget.status, 0);
    assert.match(forget.out, /relay forgotten on this PC/);
    assert.match(go('relay').out, /relay: none set/);
    assert.equal(go('relay', 'a.fly.dev', 'b.fly.dev').status, 2);
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/cli.test.js bridge/test/config/relay.test.js bridge/test/link/link-timing.test.js bridge/test/link/open-port.test.js bridge/test/link/transport.test.js bridge/test/main.test.js bridge/test/relay-cli.test.js bridge/test/walkie-bin.test.js`
Expected: FAIL, 4 tests fail: `relay shows the relay set on this PC, relay <host> sets it, relay --forget clears it`, `an open that fails with a wait of its own is retried after that wait, and does not push the backoff on`, `a cable that cannot be opened, and a relay that is not set, are errors for the short wait: the cable may be plugged in any moment`, `relay sets, shows and forgets the relay host in %APPDATA%, and refuses what is not a host`; the files `bridge/test/config/relay.test.js`, `bridge/test/link/open-port.test.js`, `bridge/test/relay-cli.test.js` cannot load, because they import `bridge/src/config/relay.js`, `bridge/src/link/open-port.js`, which do not exist yet.

- [ ] **Step 3: Write the implementation**

In `bridge/bin/walkie.js`, replace:

```js
import { loadPairKey } from '../src/config/pairkey.js';
import { loadProjects } from '../src/config/projects.js';
```

with:

```js
import { loadPairKey } from '../src/config/pairkey.js';
import { loadRelayHost } from '../src/config/relay.js';
import { loadProjects } from '../src/config/projects.js';
```

In `bridge/bin/walkie.js`, replace:

```js
import { readRecording, runInjected } from '../src/dev/inject.js';
import { startBridge } from '../src/main.js';
import { pairCommand } from '../src/pair-cli.js';
import { createAdapters } from '../src/speech/speech.js';
```

with:

```js
import { readRecording, runInjected } from '../src/dev/inject.js';
import { bridgeOpenPort, describeTransport } from '../src/link/open-port.js';
import { startBridge } from '../src/main.js';
import { pairCommand } from '../src/pair-cli.js';
import { relayCommand } from '../src/relay-cli.js';
import { createAdapters } from '../src/speech/speech.js';
```

In `bridge/bin/walkie.js`, replace:

```js
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
  whose keys are in %APPDATA%\\walkie\\keys.env. With no S3 plugged in it waits and connects when one appears.
  --port COMx       the S3's serial port (default: the one with USB id 303A:1001)
```

with:

```js
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
       node bridge/bin/walkie.js relay [<host> | --forget]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
  whose keys are in %APPDATA%\\walkie\\keys.env. With no S3 plugged in it waits and connects when one appears; with a pairing key and a
  relay set (walkie relay), it goes by the relay while there is no cable.
  --port COMx       the S3's serial port (default: the one with USB id 303A:1001)
```

In `bridge/bin/walkie.js`, replace:

```js
                    pair --forget makes the S3 forget its key and this PC delete its own.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

with:

```js
                    pair --forget makes the S3 forget its key and this PC delete its own.
  relay             show the relay host of this PC; relay <host> sets it (a name such as walkie-relay.fly.dev); relay --forget clears it.
                    The relay is used only with a pairing key, which names the room, and never with --port.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

In `bridge/bin/walkie.js`, replace:

```js

let injected = null;
```

with:

```js

if (parsed.command === 'relay') {
  const code = relayCommand({ host: parsed.host, forget: parsed.forget });
  await new Promise((resolve) => setTimeout(resolve, 100)); // lets the output flush
  process.exit(code);
}

let injected = null;
```

In `bridge/bin/walkie.js`, replace:

```js
  if (why) con.log(`[keys] ${why}`);
  const projects = loadProjects();
```

with:

```js
  if (why) con.log(`[keys] ${why}`);
  const relayHost = () => loadRelayHost();
  con.log(`[transport] ${describeTransport({ master, host: relayHost(), port: opts.port ?? null })}`);
  const projects = loadProjects();
```

In `bridge/bin/walkie.js`, replace:

```js
    adapters: createAdapters({ keys, config }),
    openPort: portOpener(opts.port),
    master,
```

with:

```js
    adapters: createAdapters({ keys, config }),
    openPort: bridgeOpenPort({ port: opts.port ?? null, master, relayHost, log: (line) => con.log(`[transport] ${line}`) }),
    retry: { retryMs: 1000, retryMaxMs: 30_000 },
    master,
```

Replace the whole of `bridge/src/cli.js` with:

```js
// The command line of bin/walkie.js, apart from the process: `walkie [options]` runs the bridge, `walkie pair [--forget] [--port COMx]`
// pairs (or unpairs) the S3 over the cable, and `walkie relay [<host>|--forget]` sets, shows or forgets this PC's relay host.
import { UsageError, parseArgs } from './dev/args.js';

export function parseWalkieCommand(argv) {
  const { name, args, opts } = parseArgs(argv);
  if (name === 'pair') {
    const extra = args.find((word) => word !== '--forget');
    if (extra !== undefined) throw new UsageError(`${extra} is not something walkie pair takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie pair takes`);
    return { command: 'pair', forget: args.includes('--forget'), opts };
  }
  if (name === 'relay') {
    const stray = args.find((word) => word.startsWith('--') && word !== '--forget');
    if (stray !== undefined) throw new UsageError(`${stray} is not something walkie relay takes`);
    for (const option of Object.keys(opts)) throw new UsageError(`--${option} is not something walkie relay takes`);
    const forget = args.includes('--forget');
    const hosts = args.filter((word) => word !== '--forget');
    if (hosts.length > 1) throw new UsageError(`${hosts[1]} is not something walkie relay takes`);
    if (forget && hosts.length > 0) throw new UsageError('walkie relay --forget takes no host');
    return { command: 'relay', host: hosts[0] ?? null, forget, opts };
  }
  const words = [name, ...args].filter((word) => word !== undefined);
  const stray = words.find((word) => word !== '--clean-env');
  if (stray !== undefined) throw new UsageError(`${stray} is not something walkie takes`);
  return { command: 'run', cleanEnv: words.includes('--clean-env'), opts };
}
```

Create `bridge/src/config/relay.js`:

```js
// The relay host (protocol/frames.md, "Relay"): a host name in %APPDATA%\walkie\relay.txt, beside the pairing key. Without one the bridge
// goes by the cable alone. It is not a secret (the room is, and the room comes from the key), so it may appear in errors and logs.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { relayUrl } from '../link/relay-port.js';

export function defaultRelayFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'relay.txt') : null;
}

// What a person typed, as it is kept: trimmed, one trailing slash dropped. Throws RangeError unless it is a host name the relay port
// accepts (wss for a host, plain ws only for this machine).
export function normalizeRelayHost(text) {
  const host = String(text ?? '').trim().replace(/\/$/, '');
  relayUrl(host, '0'.repeat(32), 'pc'); // the one place that knows what a host may look like
  return host;
}

// The host, or null when none is set.
export function loadRelayHost({ file = defaultRelayFile(), read = readFileSync } = {}) {
  if (!file) return null;
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read the relay file ${file} (${err.code ?? 'error'})`);
  }
  if (text.trim() === '') return null;
  try {
    return normalizeRelayHost(text);
  } catch {
    throw new Error(`the relay file ${file} does not hold a host name`);
  }
}

// Written beside itself and renamed over, so that a reader never meets half a host. Returns the host as kept.
export function saveRelayHost(text, { file = defaultRelayFile() } = {}) {
  const host = normalizeRelayHost(text);
  if (!file) throw new Error('there is nowhere to keep a relay host: %APPDATA% is not set');
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${host}\n`);
  renameSync(tmp, file);
  return host;
}

export function clearRelayHost({ file = defaultRelayFile() } = {}) {
  if (!file) return;
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
```

In `bridge/src/link/link.js`, replace:

```js
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      this.#scheduleRetry();
      return;
```

with:

```js
      if (this.#openFailures++ === 0) this.emit('status', `cannot open the S3's port (${err.message}); retrying`);
      const wait = err?.retryInMs;
      this.#scheduleRetry(Number.isFinite(wait) && wait > 0 ? wait : null); // an open may say how soon to try again
      return;
```

In `bridge/src/link/link.js`, replace:

```js

  #scheduleRetry() {
    this.#retryTimer = setTimeout(() => this.#connect(), this.#retryDelay);
    this.#retryDelay = Math.min(this.#retryMaxMs, this.#retryDelay * 2);
  }
```

with:

```js

  // `fixed`: a wait the failed open asked for. It is taken as it is and does not count towards the backoff.
  #scheduleRetry(fixed = null) {
    this.#retryTimer = setTimeout(() => this.#connect(), fixed ?? this.#retryDelay);
    if (fixed === null) this.#retryDelay = Math.min(this.#retryMaxMs, this.#retryDelay * 2);
  }
```

Create `bridge/src/link/open-port.js`:

```js
// The openPort that `walkie` gives the Link. The cable alone, unless there is a pairing key (it names the room) and a relay host in the
// config; then the transport chooser: the cable when the S3 is on it, the relay when not. `--port COMx` is always the cable alone.
import { findS3Port as defaultFindS3Port, openS3Port as defaultOpenS3Port } from './serial.js';
import { openRelayPort as defaultOpenRelayPort } from './relay-port.js';
import { roomId } from './room.js';
import { CABLE_WAIT_MS, chooseTransport } from './transport.js';

// Everything but the cable is injectable, for tests.
export function bridgeOpenPort({
  port = null,
  master = null,
  relayHost = () => null,
  log = () => {},
  pollMs,
  findS3Port = defaultFindS3Port,
  openS3Port = defaultOpenS3Port,
  openRelayPort = defaultOpenRelayPort,
}) {
  // The cable may be plugged in any moment, so what goes wrong here is retried soon whatever the Link's backoff has reached.
  const cable = async () => {
    try {
      const path = port ?? (await findS3Port());
      if (!path) throw new Error('no S3 on USB (303A:1001)');
      return await openS3Port(path);
    } catch (err) {
      err.retryInMs = CABLE_WAIT_MS;
      throw err;
    }
  };
  if (port) return cable;
  const room = master ? roomId(master) : null;
  let host = null;
  const chooser = chooseTransport({
    findUsb: findS3Port,
    openUsb: openS3Port,
    openRelay: (h) => openRelayPort({ host: h, room }),
    relayHost: () => host,
    status: log,
    pollMs,
  });
  return async () => {
    host = master ? relayHost() : null; // the config is read afresh: a relay set while the bridge runs is used from the next open
    return host ? chooser() : cable();
  };
}

// One line for the console at start: which way the bridge will go.
export function describeTransport({ master, host, port }) {
  if (port) return `USB only, on ${port} as asked`;
  if (master && host) return `USB when the S3 is on it, else the relay at ${host}`;
  if (host) return `USB only: the relay at ${host} needs a pairing key (node bridge/bin/walkie.js pair)`;
  if (master) return 'USB only (no relay set: node bridge/bin/walkie.js relay <host>)';
  return 'USB only';
}
```

In `bridge/src/link/transport.js`, replace:

```js

// `findUsb()` answers the S3's USB path or null, `openUsb(path)` and `openRelay(host)` open a port, `relayHost()` is the relay in the
```

with:

```js

// The wait after a failure on the cable side (a port that is busy, a relay not set) is short, whatever backoff the Link has reached: the
// cable may be plugged in any moment. A relay that cannot be reached, or is held back, is left to the backoff.
export const CABLE_WAIT_MS = 1000;
const cableError = (message) => Object.assign(new Error(message), { retryInMs: CABLE_WAIT_MS });

// `findUsb()` answers the S3's USB path or null, `openUsb(path)` and `openRelay(host)` open a port, `relayHost()` is the relay in the
```

In `bridge/src/link/transport.js`, replace:

```js
    }, pollMs);
    port.on('close', () => {
```

with:

```js
    }, pollMs);
    timer.unref?.();
    port.on('close', () => {
```

In `bridge/src/link/transport.js`, replace:

```js
      } catch (err) {
        throw new Error(`cannot open the S3 on USB (${err.message})`); // it is there; the relay is no answer to a port that is busy
      }
```

with:

```js
      } catch (err) {
        throw cableError(`cannot open the S3 on USB (${err.message})`); // it is there; the relay is no answer to a port that is busy
      }
```

In `bridge/src/link/transport.js`, replace:

```js
    const host = relayHost();
    if (!host) throw new Error('no S3 on USB, and no relay set (walkie relay <host>)');
    if (now() < relayHeldBackUntil) throw new Error('another walkie run holds the relay room');
```

with:

```js
    const host = relayHost();
    if (!host) throw cableError('no S3 on USB, and no relay set (walkie relay <host>)');
    if (now() < relayHeldBackUntil) throw new Error('another walkie run holds the relay room');
```

In `bridge/src/main.js`, replace:

```js
// timings, `makeNonce` the link's HELLO nonce. `master` is the pairing key, `adpcm` asks for ADPCM audio (see Link).
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, master, adpcm, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce, master, adpcm });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
```

with:

```js
// timings, `makeNonce` the link's HELLO nonce. `master` is the pairing key, `adpcm` asks for ADPCM audio (see Link).
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, master, adpcm, retry = {}, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce, master, adpcm, ...retry });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
```

Create `bridge/src/relay-cli.js`:

```js
// `walkie relay`: the relay host on this PC. With a host it sets it, with --forget it clears it, with neither it says what is set.
import { clearRelayHost, defaultRelayFile, loadRelayHost, saveRelayHost } from './config/relay.js';

export function relayCommand({ host = null, forget = false, file = defaultRelayFile(), read, say = console.log, err = console.error }) {
  try {
    if (forget) {
      clearRelayHost({ file });
      say('relay forgotten on this PC');
      return 0;
    }
    if (host !== null) {
      say(`relay set on this PC: ${saveRelayHost(host, { file })}`);
      return 0;
    }
    const current = loadRelayHost({ file, read });
    say(current ? `relay: ${current}` : 'relay: none set (node bridge/bin/walkie.js relay <host>)');
    return 0;
  } catch (e) {
    const usage = e instanceof RangeError; // what was typed is not a host name
    err(usage ? `walkie: ${e.message}` : e.message);
    return usage ? 2 : 1;
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/cli.test.js bridge/test/config/relay.test.js bridge/test/link/link-timing.test.js bridge/test/link/open-port.test.js bridge/test/link/transport.test.js bridge/test/main.test.js bridge/test/relay-cli.test.js bridge/test/walkie-bin.test.js`
Expected: PASS, 77 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 883 tests, the tools' 17, the relay's 13, and `202 cases, 1067 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie.js bridge/src/cli.js bridge/src/config/relay.js bridge/src/link/link.js bridge/src/link/open-port.js bridge/src/link/transport.js bridge/src/main.js bridge/src/relay-cli.js bridge/test/cli.test.js bridge/test/config/relay.test.js bridge/test/link/link-timing.test.js bridge/test/link/open-port.test.js bridge/test/link/transport.test.js bridge/test/main.test.js bridge/test/relay-cli.test.js bridge/test/walkie-bin.test.js
git commit -m "Task 8: the relay on the PC: relay.txt, walkie relay, the cable alone unless a key and a relay are set, retry settings into the Link, and a failed open may say how soon to retry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The NET frame in both implementations

Wi-Fi networks and the relay host reach the S3 in a new frame, NET (0x33), specified in `protocol/frames.md` ("Network settings (plan 6)") and built and parsed on both sides from the shared vectors. A request is one of five ops; a reply is OK, ERR with a reason, or LIST with the SSIDs and the host (never a password). The firmware's `Gate` now says whether the last frame it delivered came sealed (`lastSealed()`), because a NET request is taken only sealed; that rule is applied in Task 10.

**Files:**
- Modify: `bridge/src/link/frame.js`, `bridge/src/link/messages.js`, `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/gate.cpp`, `firmware/lib/proto/src/proto/gate.h`, `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `protocol/frames.md`
- Test (new): `bridge/test/link/net-messages.test.js`, `firmware/host/test_net_messages.cpp`
- Test (changed): `bridge/test/link/codec.test.js`, `firmware/host/test_gate.cpp`

**Interfaces:**
- Consumes: `bridge/src/link/messages.js` and `frame.js` (`TYPE`); firmware `proto/messages`, `proto/gate` (plans 1 and 5).
- Produces: `bridge/src/link/messages.js`: `NET_OP`, `NET_ERR`, `NET_LIMITS` (`ssid` 32, `pass` 63, `host` 63, `networks` 4), `netWifiAddPayload(ssid, pass)`, `netWifiRemovePayload(ssid)`, `netWifiListPayload()`, `netRelaySetPayload(host)`, `netRelayClearPayload()` (each `RangeError` outside the limits), `parseNetReply(p): { kind: 'ok' | 'err' | 'list', ... } | null`; `TYPE.NET` (0x33).
- Produces: Firmware: `T_NET`, `NET_*` and `NETERR_*` ops and reasons, `NET_SSID_MAX`, `NET_PASS_MAX`, `NET_HOST_MAX`, `NET_NETWORKS_MAX`, `struct NetMsg { op, ssid, pass, host }`, `parseNet`, `buildNetOk`, `buildNetErr`, `buildNetList`; `Gate::lastSealed()`.

- [ ] **Step 1: Write the failing tests**

In `bridge/test/link/codec.test.js`, replace:

```js
    UI: 0x20, BUTTON: 0x21, APPROVAL_REQ: 0x22, APPROVAL_RES: 0x23,
    CMD: 0x30, TEST: 0x31, PAIR: 0x32, LOG: 0x3f,
  });
```

with:

```js
    UI: 0x20, BUTTON: 0x21, APPROVAL_REQ: 0x22, APPROVAL_RES: 0x23,
    CMD: 0x30, TEST: 0x31, PAIR: 0x32, NET: 0x33, LOG: 0x3f,
  });
```

Create `bridge/test/link/net-messages.test.js`:

```js
// NET (protocol/frames.md, "Network settings (plan 6)"): the PC sets the S3's Wi-Fi networks and relay host over a sealed link.
// The hex strings here are the same ones firmware/host/test_net_messages.cpp checks, so the two ends cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPE } from '../../src/link/frame.js';
import {
  NET_OP,
  NET_ERR,
  NET_LIMITS,
  netWifiAddPayload,
  netWifiRemovePayload,
  netWifiListPayload,
  netRelaySetPayload,
  netRelayClearPayload,
  parseNetReply,
} from '../../src/link/messages.js';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');

test('the NET frame type and its ops are the ones the S3 uses', () => {
  assert.equal(TYPE.NET, 0x33);
  assert.deepEqual({ ...NET_OP }, { WIFI_ADD: 1, WIFI_REMOVE: 2, WIFI_LIST: 3, RELAY_SET: 4, RELAY_CLEAR: 5, OK: 0x80, ERR: 0x81, LIST: 0x82 });
  assert.deepEqual({ ...NET_ERR }, { BAD: 1, FULL: 2, UNKNOWN: 3, STORE: 4 });
  assert.deepEqual({ ...NET_LIMITS }, { ssid: 32, pass: 63, host: 63, networks: 4 });
});

test('requests are laid out as the S3 parses them', () => {
  assert.equal(hex(netWifiAddPayload('home', 'secret123')), '0104686f6d6509736563726574313233');
  assert.equal(hex(netWifiAddPayload('cafe', '')), '01046361666500');
  assert.equal(hex(netWifiRemovePayload('home')), '0204686f6d65');
  assert.equal(hex(netWifiListPayload()), '03');
  assert.equal(hex(netRelaySetPayload('walkie-relay.fly.dev')), '041477616c6b69652d72656c61792e666c792e646576');
  assert.equal(hex(netRelayClearPayload()), '05');
});

test('an SSID is counted in UTF-8 bytes, not characters', () => {
  const p = netWifiAddPayload('咖啡', 'password1');
  assert.equal(p[1], 6);
  assert.equal(p.subarray(2, 8).toString('utf8'), '咖啡');
  assert.throws(() => netWifiAddPayload('咖'.repeat(11), 'password1'), RangeError); // 33 bytes
  assert.equal(netWifiAddPayload('咖'.repeat(10), 'password1')[1], 30);
});

test('what the S3 would refuse is refused here, with the reason, before it is sent', () => {
  assert.throws(() => netWifiAddPayload('', 'password1'), /ssid/);
  assert.throws(() => netWifiAddPayload('x'.repeat(33), 'password1'), /ssid/);
  assert.throws(() => netWifiAddPayload('home', 'short'), /password/); // WPA needs 8 to 63; none at all is an open network
  assert.throws(() => netWifiAddPayload('home', 'x'.repeat(7)), /password/);
  assert.equal(netWifiAddPayload('home', 'x'.repeat(8))[6], 8);
  assert.throws(() => netWifiAddPayload('home', 'x'.repeat(64)), /password/);
  assert.equal(netWifiAddPayload('home', 'x'.repeat(63)).length, 2 + 4 + 1 + 63);
  assert.equal(netWifiAddPayload('x'.repeat(32), 'x'.repeat(8))[1], 32);
  assert.throws(() => netWifiAddPayload('home', null), TypeError);
  assert.throws(() => netWifiAddPayload(7, 'password1'), TypeError);
  assert.throws(() => netWifiRemovePayload(''), /ssid/);
  assert.throws(() => netWifiAddPayload('a\0b', 'password1'), /ssid.*NUL/);
  assert.throws(() => netWifiAddPayload('home', 'pass\0word'), /password.*NUL/);
  assert.throws(() => netWifiRemovePayload('a\0'), /ssid.*NUL/);
  for (const bad of ['', 'a b', 'a/b', 'a\r\nb', 'http://x.dev', 'x.dev:443', 'x'.repeat(64), 'é.dev']) {
    assert.throws(() => netRelaySetPayload(bad), RangeError, JSON.stringify(bad));
  }
  assert.equal(netRelaySetPayload('x'.repeat(63))[1], 63);
});

test('replies: OK, ERR and the list, and nothing that is not exactly one of them', () => {
  assert.deepEqual(parseNetReply(unhex('8001')), { kind: 'ok', answered: NET_OP.WIFI_ADD });
  assert.deepEqual(parseNetReply(unhex('810102')), { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.FULL });
  assert.deepEqual(parseNetReply(unhex('820004')), null, 'a list that stops short of its host length');
  assert.deepEqual(parseNetReply(unhex('8200' + '00')), { kind: 'list', ssids: [], host: null });
  assert.deepEqual(parseNetReply(unhex('8202' + '04686f6d65' + '0463616665' + '09782e666c792e646576')), {
    kind: 'list',
    ssids: ['home', 'cafe'],
    host: 'x.fly.dev',
  });
  assert.deepEqual(parseNetReply(unhex('820104686f6d6500')), { kind: 'list', ssids: ['home'], host: null });
  assert.deepEqual(parseNetReply(unhex('8204' + '0161' + '0162' + '0163' + '0164' + '00')).ssids, ['a', 'b', 'c', 'd'], 'four is the most');
});

test('a reply that is the wrong length, or unknown, is null', () => {
  for (const h of ['', '80', '8001ff', '81', '8101', '810102ff', '82', '8205' + '00', '8201' + '05686f6d65' + '00', '8201' + '04686f6d65', '8200' + '0000', '8200' + '40', '7f01', '01', '8201' + '00' + '00']) {
    assert.equal(parseNetReply(unhex(h)), null, h);
  }
  // five networks cannot be, and an SSID of 33 bytes cannot be
  assert.equal(parseNetReply(unhex('8205' + '01610161016101610161' + '00')), null);
  assert.equal(parseNetReply(unhex('8201' + '21' + '61'.repeat(33) + '00')), null);
});
```

In `firmware/host/test_gate.cpp`, replace:

```cpp
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 3, s), out) == Gate::Drop, "the session is over until the next HELLO");
}
```

with:

```cpp
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 3, s), out) == Gate::Drop, "the session is over until the next HELLO");
}


TEST(gateSaysWhetherTheFrameItDeliveredCameSealed) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  CHECK(!r.gate.lastSealed(), "nothing delivered yet");
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_NET, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_NET, proto::F_SEALED, 3, s), out) == Gate::Deliver, "the sealed NET frame opens");
  CHECK(r.gate.lastSealed() && out.type == proto::T_NET && out.len == 1 && out.payload[0] == 3, "and it says it came sealed");
  CHECK(r.gate.receive(r.frame(proto::T_NET, 0, 4, p), out) == Gate::Drop, "the same frame plain is dropped");
  CHECK(!r.gate.lastSealed(), "and a drop is not sealed: the answer is about the last frame only");
}

TEST(gateAnUnpairedGateDeliversPlainAndSaysItWasNotSealed) {
  Rig r(false);
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_NET, 0, 1, p), out) == Gate::Deliver, "delivered");
  CHECK(!r.gate.lastSealed(), "but plain, so NET handling has to refuse it");
}

TEST(gateHelloAndPairAreNeverSealedEvenRightAfterASealedFrame) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {3};
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_NET, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_NET, proto::F_SEALED, 3, s), out) == Gate::Deliver && r.gate.lastSealed(), "sealed");
  std::vector<uint8_t> forget = {proto::PAIR_FORGET};
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, 0, 5, forget), out) == Gate::Pair && !r.gate.lastSealed(), "PAIR");
  CHECK(r.hello() == Gate::Hello && !r.gate.lastSealed(), "HELLO");
}

TEST(gateNetIsSealedWhenSentAndNeverPlainOnAPairedGate) {
  Rig r(true);
  std::vector<uint8_t> p = {0x80, 1};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_NET, 0, 1, p.data(), 2, w) == Gate::Blocked, "no session: blocked, never plain");
  r.hello();
  r.pcBegin();
  CHECK(r.gate.wrap(proto::T_NET, 0, 2, p.data(), 2, w) == Gate::Sealed && (w.flags & proto::F_SEALED) && w.len == 2 + proto::SEAL_OVERHEAD,
        "sealed");
  proto::Frame f = proto::Frame();
  f.type = proto::T_NET;
  f.flags = w.flags;
  f.seq = 2;
  f.len = w.len;
  f.payload = w.payload;
  uint8_t out[16];
  size_t n = 0;
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == 2 && out[0] == 0x80 && out[1] == 1, "the PC opens it");
}
```

Create `firmware/host/test_net_messages.cpp`:

```cpp
// test_net_messages.cpp: the NET frame (protocol/frames.md, "Network settings (plan 6)") as the S3 parses requests and builds replies.
// The hex strings are the ones bridge/test/link/net-messages.test.js checks, so the two ends cannot drift apart.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "vectors.h"

namespace {
using proto::NetMsg;
using proto::Text;

std::vector<uint8_t> bytes(const char* hex) { return unhex(hex); }
std::string str(const Text& t) { return std::string((const char*)t.p, t.n); }

bool parse(const char* hex, NetMsg& m) {
  std::vector<uint8_t> p = bytes(hex);
  m = NetMsg();
  return proto::parseNet(p.data(), p.size(), m);
}
std::string hexOf(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += d[p[i] >> 4];
    s += d[p[i] & 15];
  }
  return s;
}
}  // namespace

TEST(netTheTypeAndTheOpsAreTheOnesTheBridgeUses) {
  CHECK(proto::T_NET == 0x33, "NET is 0x33");
  CHECK(proto::NET_WIFI_ADD == 1 && proto::NET_WIFI_REMOVE == 2 && proto::NET_WIFI_LIST == 3 && proto::NET_RELAY_SET == 4 &&
            proto::NET_RELAY_CLEAR == 5,
        "request ops");
  CHECK(proto::NET_OK == 0x80 && proto::NET_ERR == 0x81 && proto::NET_LIST == 0x82, "reply ops");
  CHECK(proto::NETERR_BAD == 1 && proto::NETERR_FULL == 2 && proto::NETERR_UNKNOWN == 3 && proto::NETERR_STORE == 4, "reasons");
  CHECK(proto::NET_SSID_MAX == 32 && proto::NET_PASS_MAX == 63 && proto::NET_HOST_MAX == 63 && proto::NET_NETWORKS_MAX == 4, "limits");
}

TEST(netWifiAddCarriesTheSsidAndThePassword) {
  NetMsg m;
  CHECK(parse("0104686f6d6509736563726574313233", m), "parses");
  CHECK(m.op == proto::NET_WIFI_ADD && str(m.ssid) == "home" && str(m.pass) == "secret123", "the fields");
  CHECK(parse("01046361666500", m) && str(m.ssid) == "cafe" && m.pass.n == 0, "an open network has no password");
}

TEST(netWifiRemoveRelaySetAndTheOpsWithNoArguments) {
  NetMsg m;
  CHECK(parse("0204686f6d65", m) && m.op == proto::NET_WIFI_REMOVE && str(m.ssid) == "home", "remove");
  CHECK(parse("03", m) && m.op == proto::NET_WIFI_LIST, "list");
  CHECK(parse("041477616c6b69652d72656c61792e666c792e646576", m) && m.op == proto::NET_RELAY_SET && str(m.host) == "walkie-relay.fly.dev",
        "relay set");
  CHECK(parse("05", m) && m.op == proto::NET_RELAY_CLEAR, "relay clear");
}

TEST(netLimitsAreExactAtTheEdgesOnly) {
  NetMsg m;
  std::string ssid32 = "01" "20" + std::string(64, '6') + "00";
  CHECK(parse(ssid32.c_str(), m) && m.ssid.n == 32, "32 bytes of SSID");
  std::string ssid33 = "01" "21" + std::string(66, '6') + "00";
  CHECK(!parse(ssid33.c_str(), m), "33 bytes of SSID");
  CHECK(!parse("0103" "610062" "00", m), "a NUL inside an SSID");
  CHECK(!parse("0101" "61" "08" "3100333435363738", m), "a NUL inside a password");
  CHECK(!parse("0203" "610062", m), "a NUL inside an SSID to remove");
  CHECK(!parse("0101" "00" "00", m) && !parse("0201" "00", m), "an SSID that is one NUL");
  CHECK(!parse("010004", m) && !parse("0100" "00", m), "an empty SSID");
  std::string pass63 = "010161" "3f" + std::string(126, '7');
  CHECK(parse(pass63.c_str(), m) && m.pass.n == 63, "63 bytes of password");
  std::string pass64 = "010161" "40" + std::string(128, '7');
  CHECK(!parse(pass64.c_str(), m), "64 bytes of password");
  CHECK(!parse("010161" "07" "37373737373737", m), "7 bytes: shorter than WPA allows");
  CHECK(parse("010161" "08" "3737373737373737", m), "8 bytes");
  std::string host63 = "04" "3f" + std::string(126, '6');
  CHECK(parse(host63.c_str(), m) && m.host.n == 63, "63 bytes of host");
  std::string host64 = "04" "40" + std::string(128, '6');
  CHECK(!parse(host64.c_str(), m), "64 bytes of host");
}

TEST(netAHostHoldsOnlyLettersDigitsDotsAndHyphens) {
  NetMsg m;
  CHECK(parse("0409782e666c792e646576", m) && str(m.host) == "x.fly.dev", "ordinary");
  CHECK(!parse("04" "01" "20", m), "a space");
  CHECK(!parse("04" "03" "610d0a", m), "a line break: it would end the HTTP request line");
  CHECK(!parse("04" "03" "612f62", m), "a slash");
  CHECK(!parse("04" "03" "613a62", m), "a colon");
  CHECK(!parse("04" "02" "c3a9", m), "a byte above 127");
  CHECK(!parse("0400", m), "no host at all");
  CHECK(parse("0408" "415a617a30392e2d", m) && str(m.host) == "AZaz09.-", "the first and last of every kind that is allowed");
  CHECK(!parse("0401" "40", m) && !parse("0401" "5b", m), "the bytes either side of A to Z");
  CHECK(!parse("0401" "60", m) && !parse("0401" "7b", m), "the bytes either side of a to z");
  CHECK(!parse("0401" "2f", m) && !parse("0401" "3a", m), "the bytes either side of 0 to 9");
  CHECK(!parse("0401" "00", m), "a NUL");
}

TEST(netARequestThatIsNotExactlyOneIsRefused) {
  NetMsg m;
  const char* bad[] = {"",
                       "00",
                       "06",
                       "80",
                       "0104686f6d65",          // no password length
                       "0104686f6d650008",      // short
                       "0104686f6d650000" "00", // trailing byte
                       "0204686f6d65" "00",
                       "0204686f6d",            // SSID runs past the end
                       "0300",
                       "0500",
                       "0414" "77616c6b69652d72656c61792e666c792e6465",  // host runs past the end
                       "0409782e666c792e646576" "00"};
  for (const char* h : bad) CHECK(!parse(h, m), h);
}

TEST(netRepliesAreBuiltAsTheBridgeParsesThem) {
  uint8_t out[1100];
  size_t n = proto::buildNetOk(proto::NET_WIFI_ADD, out, sizeof out);
  CHECK(hexOf(out, n) == "8001", "ok");
  n = proto::buildNetErr(proto::NET_WIFI_ADD, proto::NETERR_FULL, out, sizeof out);
  CHECK(hexOf(out, n) == "810102", "err");
  CHECK(proto::buildNetOk(1, out, 1) == 0 && proto::buildNetErr(1, 1, out, 2) == 0, "too small a buffer is 0");

  const uint8_t home[] = {'h', 'o', 'm', 'e'}, cafe[] = {'c', 'a', 'f', 'e'}, host[] = {'x', '.', 'f', 'l', 'y', '.', 'd', 'e', 'v'};
  Text two[2] = {{home, 4}, {cafe, 4}};
  Text h = {host, 9};
  n = proto::buildNetList(two, 2, h, out, sizeof out);
  CHECK(hexOf(out, n) == "820204686f6d650463616665" "09782e666c792e646576", "two networks and a host");
  n = proto::buildNetList(nullptr, 0, Text{nullptr, 0}, out, sizeof out);
  CHECK(hexOf(out, n) == "820000", "nothing held");
  n = proto::buildNetList(two, 1, Text{nullptr, 0}, out, sizeof out);
  CHECK(hexOf(out, n) == "820104686f6d6500", "one network, no host");
}

TEST(netAListThatCannotBeBuiltIsNotBuilt) {
  uint8_t out[1100];
  uint8_t big[64];
  memset(big, 'a', sizeof big);
  Text five[5];
  for (int i = 0; i < 5; i++) five[i] = Text{big, 4};
  CHECK(proto::buildNetList(five, 5, Text{nullptr, 0}, out, sizeof out) == 0, "five networks");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, sizeof out) != 0, "four networks");
  Text long33[1] = {Text{big, 33}};
  CHECK(proto::buildNetList(long33, 1, Text{nullptr, 0}, out, sizeof out) == 0, "an SSID of 33 bytes");
  Text empty[1] = {Text{big, 0}};
  CHECK(proto::buildNetList(empty, 1, Text{nullptr, 0}, out, sizeof out) == 0, "an empty SSID");
  CHECK(proto::buildNetList(nullptr, 0, Text{big, 64}, out, sizeof out) == 0, "a host of 64 bytes");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 10) == 0, "a buffer that is too small");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 4 * 5 + 3) != 0, "a buffer that is exactly enough");
  CHECK(proto::buildNetList(five, 4, Text{nullptr, 0}, out, 4 * 5 + 2) == 0, "a buffer one short");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `'class proto::Gate' has no member named 'lastSealed'; did you mean 'Sealed'?`, `'T_NET' is not a member of 'proto'; did you mean 'T_TEST'?`, `'NetMsg' has not been declared in 'proto'`, and 26 more.

Run: `node --test bridge/test/link/codec.test.js bridge/test/link/net-messages.test.js`
Expected: FAIL, 1 test fails: `frame constants match protocol/frames.md`; the file `bridge/test/link/net-messages.test.js` cannot load, because it imports what the source does not have yet.

- [ ] **Step 3: Write the implementation**

In `bridge/src/link/frame.js`, replace:

```js
  PAIR: 0x32,
  LOG: 0x3f,
```

with:

```js
  PAIR: 0x32,
  NET: 0x33,
  LOG: 0x3f,
```

In `bridge/src/link/messages.js`, replace:

```js

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
```

with:

```js

// NET (protocol/frames.md, "Network settings (plan 6)"): the Wi-Fi networks and the relay host of a paired S3, set over a sealed link.
// A request is the op and its arguments, each text led by its length in one byte. The S3 answers OK, ERR or LIST.
export const NET_OP = Object.freeze({ WIFI_ADD: 1, WIFI_REMOVE: 2, WIFI_LIST: 3, RELAY_SET: 4, RELAY_CLEAR: 5, OK: 0x80, ERR: 0x81, LIST: 0x82 });
export const NET_ERR = Object.freeze({ BAD: 1, FULL: 2, UNKNOWN: 3, STORE: 4 });
// Bytes: an SSID is 1 to 32, a password 8 to 63 (or none, an open network), a host 1 to 63 of letters, digits, dots and hyphens.
export const NET_LIMITS = Object.freeze({ ssid: 32, pass: 63, host: 63, networks: 4 });
const HOST_RE = /^[A-Za-z0-9.-]+$/;

function netText(value, what, min, max) {
  if (typeof value !== 'string') throw new TypeError(`the ${what} must be a string`);
  const b = Buffer.from(value, 'utf8');
  if (b.includes(0)) throw new RangeError(`the ${what} must not hold a NUL byte`);
  if (b.length < min || b.length > max) throw new RangeError(`the ${what} must be ${min === 0 ? 'at most' : `${min} to`} ${max} bytes (it is ${b.length})`);
  return Buffer.concat([Buffer.from([b.length]), b]);
}

export function netWifiAddPayload(ssid, pass) {
  const s = netText(ssid, 'ssid', 1, NET_LIMITS.ssid);
  const p = netText(pass, 'password', 0, NET_LIMITS.pass);
  if (p[0] > 0 && p[0] < 8) throw new RangeError(`the password must be 8 to ${NET_LIMITS.pass} bytes, or empty for an open network (it is ${p[0]})`);
  return Buffer.concat([Buffer.from([NET_OP.WIFI_ADD]), s, p]);
}

export function netWifiRemovePayload(ssid) {
  return Buffer.concat([Buffer.from([NET_OP.WIFI_REMOVE]), netText(ssid, 'ssid', 1, NET_LIMITS.ssid)]);
}

export function netWifiListPayload() {
  return Buffer.from([NET_OP.WIFI_LIST]);
}

export function netRelaySetPayload(host) {
  const h = netText(host, 'relay host', 1, NET_LIMITS.host);
  if (!HOST_RE.test(host)) throw new RangeError('the relay host may hold only letters, digits, dots and hyphens');
  return Buffer.concat([Buffer.from([NET_OP.RELAY_SET]), h]);
}

export function netRelayClearPayload() {
  return Buffer.from([NET_OP.RELAY_CLEAR]);
}

// OK is [0x80, answered], ERR is [0x81, answered, reason], LIST is [0x82, count, (len, ssid) x count, hostLen, host]: exactly that, or null.
export function parseNetReply(p) {
  if (p.length < 1) return null;
  if (p[0] === NET_OP.OK) return p.length === 2 ? { kind: 'ok', answered: p[1] } : null;
  if (p[0] === NET_OP.ERR) return p.length === 3 ? { kind: 'err', answered: p[1], reason: p[2] } : null;
  if (p[0] !== NET_OP.LIST || p.length < 3 || p[1] > NET_LIMITS.networks) return null;
  const ssids = [];
  let at = 2;
  for (let i = 0; i < p[1]; i++) {
    const n = p[at];
    if (n === undefined || n < 1 || n > NET_LIMITS.ssid || at + 1 + n > p.length) return null;
    ssids.push(p.subarray(at + 1, at + 1 + n).toString('utf8'));
    at += 1 + n;
  }
  const hn = p[at];
  if (hn === undefined || hn > NET_LIMITS.host || at + 1 + hn !== p.length) return null;
  return { kind: 'list', ssids, host: hn === 0 ? null : p.subarray(at + 1).toString('latin1') };
}

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
```

In `firmware/lib/proto/src/proto/frame.h`, replace:

```cpp
  T_PAIR = 0x32,
  T_LOG = 0x3F,
```

with:

```cpp
  T_PAIR = 0x32,
  T_NET = 0x33,
  T_LOG = 0x3F,
```

In `firmware/lib/proto/src/proto/gate.cpp`, replace:

```cpp
Gate::Gate()
    : c_(nullptr), store_(), random32_(nullptr), pending_(0), paired_(false), adpcm_(false), nonceP_(0), nonceS_(0), firstCounter_(0) {
  memset(key_, 0, sizeof key_);
```

with:

```cpp
Gate::Gate()
    : c_(nullptr), store_(), random32_(nullptr), pending_(0), paired_(false), adpcm_(false), lastSealed_(false), nonceP_(0), nonceS_(0), firstCounter_(0) {
  memset(key_, 0, sizeof key_);
```

In `firmware/lib/proto/src/proto/gate.cpp`, replace:

```cpp
Gate::Rx Gate::receive(const Frame& in, Frame& out) {
  if (in.type == T_HELLO) {
```

with:

```cpp
Gate::Rx Gate::receive(const Frame& in, Frame& out) {
  lastSealed_ = false;
  if (in.type == T_HELLO) {
```

In `firmware/lib/proto/src/proto/gate.cpp`, replace:

```cpp
  out.payload = rx_;
  return Deliver;
```

with:

```cpp
  out.payload = rx_;
  lastSealed_ = true;
  return Deliver;
```

In `firmware/lib/proto/src/proto/gate.h`, replace:

```cpp
  Rx receive(const Frame& in, Frame& out);
  Tx wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out);
```

with:

```cpp
  Rx receive(const Frame& in, Frame& out);
  // Whether the frame the last receive() delivered had come sealed. Plain on an unpaired S3, false after anything that was not
  // delivered: what is only to be done over a sealed link (NET) asks this, so that an unpaired S3 never takes it.
  bool lastSealed() const { return lastSealed_; }
  Tx wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out);
```

In `firmware/lib/proto/src/proto/gate.h`, replace:

```cpp
  bool adpcm_;
  uint32_t nonceP_, nonceS_, firstCounter_;
```

with:

```cpp
  bool adpcm_;
  bool lastSealed_;
  uint32_t nonceP_, nonceS_, firstCounter_;
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp
}
uint32_t get32(const uint8_t* p) {
```

with:

```cpp
}
// An SSID or password goes to WiFi.begin() as a C string, so a NUL in one cannot be honoured.
bool hasNul(Text t) { return t.n != 0 && memchr(t.p, 0, t.n) != nullptr; }
uint32_t get32(const uint8_t* p) {
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp

size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap) {
```

with:

```cpp

size_t buildNetOk(uint8_t answered, uint8_t* out, size_t cap) {
  if (cap < 2) return 0;
  out[0] = NET_OK;
  out[1] = answered;
  return 2;
}

size_t buildNetErr(uint8_t answered, uint8_t reason, uint8_t* out, size_t cap) {
  if (cap < 3) return 0;
  out[0] = NET_ERR;
  out[1] = answered;
  out[2] = reason;
  return 3;
}

size_t buildNetList(const Text* ssids, size_t count, Text host, uint8_t* out, size_t cap) {
  if (count > NET_NETWORKS_MAX || host.n > NET_HOST_MAX) return 0;
  size_t need = 2 + 1 + host.n;
  for (size_t i = 0; i < count; i++) {
    if (ssids[i].n < 1 || ssids[i].n > NET_SSID_MAX) return 0;
    need += 1 + ssids[i].n;
  }
  if (cap < need) return 0;
  uint8_t* p = out;
  *p++ = NET_LIST;
  *p++ = (uint8_t)count;
  for (size_t i = 0; i < count; i++) {
    *p++ = (uint8_t)ssids[i].n;
    memcpy(p, ssids[i].p, ssids[i].n);
    p += ssids[i].n;
  }
  *p++ = (uint8_t)host.n;
  if (host.n) memcpy(p, host.p, host.n);
  return need;
}

size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap) {
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp

bool parseCmd(const uint8_t* p, size_t n, Command& c) {
```

with:

```cpp

bool parseNet(const uint8_t* p, size_t n, NetMsg& m) {
  if (n < 1) return false;
  m.op = p[0];
  m.ssid = Text{nullptr, 0};
  m.pass = Text{nullptr, 0};
  m.host = Text{nullptr, 0};
  switch (p[0]) {
    case NET_WIFI_ADD: {
      if (n < 2 || p[1] < 1 || p[1] > NET_SSID_MAX || n < (size_t)2 + p[1] + 1) return false;
      size_t pl = p[2 + p[1]];
      if (n != (size_t)2 + p[1] + 1 + pl || pl > NET_PASS_MAX || (pl != 0 && pl < 8)) return false;
      m.ssid = Text{p + 2, p[1]};
      m.pass = Text{p + 3 + p[1], pl};
      return !hasNul(m.ssid) && !hasNul(m.pass);
    }
    case NET_WIFI_REMOVE:
      if (n < 2 || p[1] < 1 || p[1] > NET_SSID_MAX || n != (size_t)2 + p[1]) return false;
      m.ssid = Text{p + 2, p[1]};
      return !hasNul(m.ssid);
    case NET_RELAY_SET:
      if (n < 2 || p[1] < 1 || p[1] > NET_HOST_MAX || n != (size_t)2 + p[1]) return false;
      for (size_t i = 0; i < p[1]; i++) {
        uint8_t c = p[2 + i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
        if (!ok) return false;
      }
      m.host = Text{p + 2, p[1]};
      return true;
    case NET_WIFI_LIST:
    case NET_RELAY_CLEAR:
      return n == 1;
    default:
      return false;
  }
}

bool parseCmd(const uint8_t* p, size_t n, Command& c) {
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
```

with:

```cpp
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
// NET (protocol/frames.md, "Network settings (plan 6)"): requests from the PC, replies from the S3.
enum : uint8_t { NET_WIFI_ADD = 1, NET_WIFI_REMOVE = 2, NET_WIFI_LIST = 3, NET_RELAY_SET = 4, NET_RELAY_CLEAR = 5, NET_OK = 0x80, NET_ERR = 0x81, NET_LIST = 0x82 };
enum : uint8_t { NETERR_BAD = 1, NETERR_FULL = 2, NETERR_UNKNOWN = 3, NETERR_STORE = 4 };
const size_t NET_SSID_MAX = 32, NET_PASS_MAX = 63, NET_HOST_MAX = 63, NET_NETWORKS_MAX = 4;
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
};
struct ApprovalReq {
```

with:

```cpp
};
struct NetMsg {
  uint8_t op;
  Text ssid, pass, host;  // only the ones the op carries are set; the others are empty
};
struct ApprovalReq {
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
```

with:

```cpp
size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap);
// NET replies. OK and ERR say which op they answer; LIST holds the SSIDs (never a password) and the relay host, empty when none is set.
size_t buildNetOk(uint8_t answered, uint8_t* out, size_t cap);
size_t buildNetErr(uint8_t answered, uint8_t reason, uint8_t* out, size_t cap);
size_t buildNetList(const Text* ssids, size_t count, Text host, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
bool parsePair(const uint8_t* p, size_t n, PairMsg& m);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
```

with:

```cpp
bool parsePair(const uint8_t* p, size_t n, PairMsg& m);
// A NET request from the PC, exactly as the op lays it out: SSID 1 to 32 bytes, password none or 8 to 63, host 1 to 63 of letters,
// digits, dots and hyphens (a host goes into an HTTP request line). False for anything else.
bool parseNet(const uint8_t* p, size_t n, NetMsg& m);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
```

In `protocol/frames.md`, replace:

```markdown
- A device joins the relay only when it holds a pairing key.
```

with:

```markdown
- A device joins the relay only when it holds a pairing key.

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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `214 cases, 1151 checks passed, 0 failed`.

Run: `node --test bridge/test/link/codec.test.js bridge/test/link/net-messages.test.js`
Expected: PASS, 13 tests, 0 fail.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.0%, Flash 27.4%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 889 tests, the tools' 17, the relay's 13, and `214 cases, 1151 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add bridge/src/link/frame.js bridge/src/link/messages.js bridge/test/link/codec.test.js bridge/test/link/net-messages.test.js firmware/host/test_gate.cpp firmware/host/test_net_messages.cpp firmware/lib/proto/src/proto/frame.h firmware/lib/proto/src/proto/gate.cpp firmware/lib/proto/src/proto/gate.h firmware/lib/proto/src/proto/messages.cpp firmware/lib/proto/src/proto/messages.h protocol/frames.md
git commit -m "Task 9: the NET frame (0x33): Wi-Fi networks and the relay host set over a sealed link, in both ends, and the Gate says whether a delivered frame came sealed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The S3 keeps its networks and relay host

`NetConf` is the S3's settings, pure and host-tested over a two-function store: at most four networks in the order they were added, a relay host, a generation number that changes with every change, and one NVS blob (version, count, the networks, the host). A request that cannot be stored leaves the old settings in place. `handle()` answers a NET request with the reply payload. On the device `netconf_nvs.cpp` holds the one `NetConf` behind a lock, loads it at boot and hands readers a copy (`Snapshot`), and `usblink.cpp` answers NET frames, only those that came sealed; a plain one is counted as refused.

**Files:**
- Create: `firmware/lib/proto/src/proto/netconf.cpp`, `firmware/lib/proto/src/proto/netconf.h`, `firmware/src/netconf_nvs.cpp`, `firmware/src/netconf_nvs.h`
- Modify: `firmware/src/main.cpp`, `firmware/src/usblink.cpp`
- Test (new): `firmware/host/test_netconf.cpp`

**Interfaces:**
- Consumes: `NetMsg`, `parseNet`, `buildNet*`, `Gate::lastSealed()` (Task 9).
- Produces: `firmware/lib/proto/src/proto/netconf.h`: `NETCONF_BLOB_MAX`, `struct NetStore { load, save }`, `class NetConf` (`begin(const NetStore&)`, `handle(const NetMsg&, out, cap)`, `add(ssid, pass)`, `remove(ssid)`, `setRelay(host)`, `clearRelay()` (each a `NETERR_*` reason or 0), `count()`, `ssid(i)`, `pass(i)`, `host()`, `generation()`).
- Produces: `firmware/src/netconf_nvs.h`: `netconf::begin()`, `netconf::handle(m, out, cap)`, `struct Net`, `struct Snapshot { count, nets[], host, generation }`, `netconf::snapshot(Snapshot&)`, `netconf::generation()`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_netconf.cpp`:

```cpp
// test_netconf.cpp: the networks and relay host the S3 holds, and what a NET request does to them, without a device: the store is a
// variable. The hex strings are the replies bridge/test/link/net-messages.test.js parses.
#include <string.h>
#include <string>
#include <vector>
#include "check.h"
#include "proto/messages.h"
#include "proto/netconf.h"
#include "vectors.h"

namespace {
using proto::NetConf;
using proto::NetMsg;
using proto::Text;

struct Mem {
  static bool has;
  static std::vector<uint8_t> blob;
  static int saves;
  static bool failSave;
  static bool load(uint8_t* buf, size_t cap, size_t& n) {
    if (!has) return false;
    n = blob.size() < cap ? blob.size() : cap;
    memcpy(buf, blob.data(), n);
    return true;
  }
  static bool save(const uint8_t* buf, size_t n) {
    if (failSave) return false;
    blob.assign(buf, buf + n);
    has = true;
    saves++;
    return true;
  }
  static void reset() {
    has = false;
    blob.clear();
    saves = 0;
    failSave = false;
  }
  static proto::NetStore store() {
    proto::NetStore s;
    s.load = load;
    s.save = save;
    return s;
  }
};
bool Mem::has = false;
std::vector<uint8_t> Mem::blob;
int Mem::saves = 0;
bool Mem::failSave = false;

std::string str(const Text& t) { return t.n ? std::string((const char*)t.p, t.n) : std::string(); }
std::string hexOf(const uint8_t* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string s;
  for (size_t i = 0; i < n; i++) {
    s += d[p[i] >> 4];
    s += d[p[i] & 15];
  }
  return s;
}

struct Rig {
  NetConf c;
  Rig() {
    Mem::reset();
    CHECK(c.begin(Mem::store()), "begin");
  }
  // A request given as the bytes the PC sends; the reply as hex.
  std::string ask(const char* hex) {
    std::vector<uint8_t> p = unhex(hex);
    NetMsg m = NetMsg();
    CHECK(proto::parseNet(p.data(), p.size(), m), hex);
    uint8_t out[1100];
    size_t n = c.handle(m, out, sizeof out);
    return hexOf(out, n);
  }
};
}  // namespace

TEST(netconfStartsEmptyAndSaysSo) {
  Rig r;
  CHECK(r.c.count() == 0 && r.c.relay().n == 0 && r.c.generation() == 0, "nothing held");
  CHECK(r.ask("03") == "820000", "an empty list, no host");
  CHECK(r.c.ssid(0).n == 0 && r.c.pass(0).n == 0, "past the last is empty");
  proto::NetConf none;
  proto::NetStore broken = Mem::store();
  broken.save = nullptr;
  CHECK(!none.begin(broken), "a store without a save is refused");
}

TEST(netconfAddKeepsNetworksInTheOrderTheyCame) {
  Rig r;
  CHECK(r.ask("0104686f6d6509736563726574313233") == "8001", "home added");
  CHECK(r.ask("01046361666500") == "8001", "an open network: cafe");
  CHECK(r.c.count() == 2 && str(r.c.ssid(0)) == "home" && str(r.c.pass(0)) == "secret123" && str(r.c.ssid(1)) == "cafe" && r.c.pass(1).n == 0,
        "both held, in order");
  CHECK(r.ask("03") == "820204686f6d650463616665" "00", "the list names them");
  CHECK(r.c.generation() == 2 && Mem::saves == 2, "two changes, two writes");
}

TEST(netconfAListNeverCarriesAPassword) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  std::vector<uint8_t> p = unhex(r.ask("03").c_str());
  std::string all((const char*)p.data(), p.size());
  CHECK(all.find("secret") == std::string::npos, "no password in the list");
}

TEST(netconfAnSsidAlreadyHeldTakesTheNewPasswordWithoutAFifthSlot) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  CHECK(r.ask("0104686f6d6509736563726574343536") == "8001", "home again, another password");
  CHECK(r.c.count() == 1 && str(r.c.pass(0)) == "secret456", "replaced, still one");
  int saves = Mem::saves;
  uint32_t gen = r.c.generation();
  CHECK(r.ask("0104686f6d6509736563726574343536") == "8001", "the same again is fine");
  CHECK(Mem::saves == saves && r.c.generation() == gen, "and writes nothing");
  CHECK(r.ask("0104686f6d6500") == "8001" && r.c.pass(0).n == 0, "a password can become none");
}

TEST(netconfAFifthNetworkIsFullButAHeldOneStillTakesAPassword) {
  Rig r;
  CHECK(r.ask("0101" "61" "00") == "8001" && r.ask("0101" "62" "00") == "8001" && r.ask("0101" "63" "00") == "8001" &&
            r.ask("0101" "64" "00") == "8001",
        "four held");
  CHECK(r.ask("0101" "65" "00") == "810102", "a fifth is ERR FULL");
  CHECK(r.c.count() == 4 && str(r.c.ssid(3)) == "d", "unchanged");
  CHECK(r.ask("0101" "62" "08" "3132333435363738") == "8001" && str(r.c.pass(1)) == "12345678", "b takes a password while full");
}

TEST(netconfRemoveShiftsTheOthersUpAndSaysWhenItIsNotHeld) {
  Rig r;
  r.ask("0101" "61" "00");
  r.ask("0101" "62" "00");
  r.ask("0101" "63" "00");
  CHECK(r.ask("0201" "62") == "8002", "b removed");
  CHECK(r.c.count() == 2 && str(r.c.ssid(0)) == "a" && str(r.c.ssid(1)) == "c", "a and c, in order");
  CHECK(r.ask("0201" "62") == "810203", "b again is ERR UNKNOWN");
  CHECK(r.ask("0201" "61") == "8002" && r.ask("0201" "63") == "8002" && r.c.count() == 0, "all gone");
  CHECK(r.ask("0201" "61") == "810203", "nothing to remove");
  CHECK(r.ask("0101" "64" "00") == "8001" && str(r.c.ssid(0)) == "d", "a slot comes free again");
}

TEST(netconfTheRelayHostIsSetClearedAndReported) {
  Rig r;
  CHECK(r.ask("041477616c6b69652d72656c61792e666c792e646576") == "8004", "set");
  CHECK(str(r.c.relay()) == "walkie-relay.fly.dev", "held");
  CHECK(r.ask("03") == "820014" "77616c6b69652d72656c61792e666c792e646576", "LIST names it");
  int saves = Mem::saves;
  CHECK(r.ask("041477616c6b69652d72656c61792e666c792e646576") == "8004" && Mem::saves == saves, "the same host writes nothing");
  CHECK(r.ask("0409782e666c792e646576") == "8004" && str(r.c.relay()) == "x.fly.dev", "another replaces it");
  CHECK(r.ask("05") == "8005" && r.c.relay().n == 0, "cleared");
  saves = Mem::saves;
  CHECK(r.ask("05") == "8005" && Mem::saves == saves, "clearing nothing is fine and writes nothing");
}

TEST(netconfWhatIsHeldSurvivesARestart) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  r.ask("01046361666500");
  r.ask("0409782e666c792e646576");
  NetConf again;
  CHECK(again.begin(Mem::store()), "begin");
  CHECK(again.count() == 2 && str(again.ssid(0)) == "home" && str(again.pass(0)) == "secret123" && str(again.ssid(1)) == "cafe" &&
            again.pass(1).n == 0 && str(again.relay()) == "x.fly.dev",
        "the same");
  CHECK(again.generation() == 0, "a fresh start is generation 0 again");
}

TEST(netconfAChangeThatCannotBeSavedIsNotMade) {
  Rig r;
  r.ask("0104686f6d6509736563726574313233");
  r.ask("0409782e666c792e646576");
  uint32_t gen = r.c.generation();
  Mem::failSave = true;
  CHECK(r.ask("01046361666500") == "810104", "add: ERR STORE");
  CHECK(r.ask("0104686f6d6509736563726574343536") == "810104", "a new password: ERR STORE");
  CHECK(r.ask("0204686f6d65") == "810204", "remove: ERR STORE");
  CHECK(r.ask("0409612e666c792e646576") == "810404", "relay set: ERR STORE");
  CHECK(r.ask("05") == "810504", "relay clear: ERR STORE");
  CHECK(r.c.count() == 1 && str(r.c.ssid(0)) == "home" && str(r.c.pass(0)) == "secret123" && str(r.c.relay()) == "x.fly.dev", "nothing changed");
  CHECK(r.c.generation() == gen, "no generation either");
  Mem::failSave = false;
  CHECK(r.ask("01046361666500") == "8001" && r.c.count() == 2, "and it works again once the store does");
}

TEST(netconfABlobThatIsNotExactlyWhatWasWrittenIsAsGoodAsNone) {
  const char* bad[] = {
      "",
      "01",                               // no count
      "0200" "00",                        // another version
      "0100",                             // no host length
      "0100" "00" "00",                   // trailing byte
      "0105" "00",                        // five networks
      "0101" "00" "00",                   // SSID of 0 bytes
      "0101" "0161" "01" "62" "00",       // a password of 1 byte
      "0101" "0161" "08" "31323334353637",  // a password that runs past the end
      "0101" "0161" "00",                 // the host length is missing
      "0100" "03" "6120" "62",            // a host with a space
      "0100" "40" "",                     // a host of 64 bytes announced, none there
  };
  for (const char* h : bad) {
    Mem::reset();
    Mem::has = true;
    Mem::blob = unhex(h);
    NetConf c;
    CHECK(c.begin(Mem::store()), h);
    CHECK(c.count() == 0 && c.relay().n == 0, h);
  }
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex("0101" "0161" "00" "00");
  NetConf ok;
  CHECK(ok.begin(Mem::store()) && ok.count() == 1 && str(ok.ssid(0)) == "a" && ok.relay().n == 0, "the well-formed one loads");
  Mem::blob.assign(proto::NETCONF_BLOB_MAX + 5, 1);
  NetConf big;
  CHECK(big.begin(Mem::store()) && big.count() == 0, "a blob longer than any that is written");
}

TEST(netconfAFullBlobFitsTheBound) {
  Rig r;
  std::string pass63(126, '7');
  for (char c = 'a'; c < 'e'; c++) {
    std::string ssid32(64, '6');
    ssid32[0] = (char)('0' + (c - 'a'));  // four different 32-byte SSIDs
    std::string hex = "01" "20" + ssid32 + "3f" + pass63;
    CHECK(r.ask(hex.c_str()) == "8001", "a full-size network");
  }
  std::string host = "04" "3f" + std::string(126, '6');
  CHECK(r.ask(host.c_str()) == "8004", "a full-size host");
  CHECK(Mem::blob.size() == proto::NETCONF_BLOB_MAX, "the biggest blob is the bound");
  NetConf again;
  CHECK(again.begin(Mem::store()) && again.count() == 4 && again.relay().n == 63 && again.pass(3).n == 63, "and it loads back");
}

TEST(netconfAReplyThatDoesNotFitIsNotBuilt) {
  Rig r;
  std::vector<uint8_t> p = unhex("03");
  NetMsg m = NetMsg();
  CHECK(proto::parseNet(p.data(), p.size(), m), "parse");
  uint8_t out[1];
  CHECK(r.c.handle(m, out, sizeof out) == 0, "a LIST that does not fit");
  std::vector<uint8_t> q = unhex("05");
  CHECK(proto::parseNet(q.data(), q.size(), m) && r.c.handle(m, out, sizeof out) == 0, "an OK that does not fit");
}


namespace {
std::string rep(const char* hex, int n) {
  std::string s;
  for (int i = 0; i < n; i++) s += hex;
  return s;
}
Text T(const char* s) { return Text{(const uint8_t*)s, strlen(s)}; }
bool loadsEmpty(const std::string& hex) {
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex(hex.c_str());
  NetConf c;
  return c.begin(Mem::store()) && c.count() == 0 && c.relay().n == 0;
}
}  // namespace

TEST(netconfABlobThatBreaksOneLimitLoadsNothingEvenWhenTheRestIsFine) {
  CHECK(loadsEmpty("0201" "016100" "00"), "another version, with a network in it");
  CHECK(loadsEmpty("0105" + rep("016100", 5) + "00"), "five networks");
  CHECK(loadsEmpty("0101" "21" + rep("61", 33) + "00" "00"), "an SSID of 33 bytes");
  CHECK(loadsEmpty("0101" "0161" "40" + rep("37", 64) + "00"), "a password of 64 bytes");
  CHECK(loadsEmpty("0101" "0161" "07" + rep("37", 7) + "00"), "a password of 7 bytes");
  CHECK(loadsEmpty("0100" "01" "61" "00"), "a byte after the host");
  CHECK(loadsEmpty("0100" "40" + rep("61", 64)), "a host of 64 bytes");
  Mem::reset();
  Mem::has = true;
  Mem::blob = unhex(("0104" + rep("016100", 4) + "01" "61").c_str());
  NetConf four;
  CHECK(four.begin(Mem::store()) && four.count() == 4 && str(four.relay()) == "a", "four networks and a host of 1 byte are fine");
}

TEST(netconfRefusesWhatTheFrameParserWouldHaveRefusedEvenWhenAskedDirectly) {
  Rig r;
  uint8_t big[70];
  memset(big, 'a', sizeof big);
  CHECK(r.c.add(Text{big, 0}, Text{nullptr, 0}) == proto::NETERR_BAD, "an empty SSID");
  CHECK(r.c.add(Text{big, 33}, Text{nullptr, 0}) == proto::NETERR_BAD, "an SSID of 33");
  CHECK(r.c.add(Text{big, 32}, Text{nullptr, 0}) == 0, "an SSID of 32");
  CHECK(r.c.add(Text{big, 31}, Text{big, 64}) == proto::NETERR_BAD, "a password of 64");
  CHECK(r.c.add(Text{big, 31}, Text{big, 7}) == proto::NETERR_BAD, "a password of 7");
  CHECK(r.c.add(Text{big, 31}, Text{big, 63}) == 0, "a password of 63");
  CHECK(r.c.add(Text{big, 30}, Text{big, 8}) == 0, "a password of 8");
  CHECK(r.c.count() == 3 && Mem::saves == 3, "only the three that were fine were kept and written");
  CHECK(r.c.setRelay(Text{big, 0}) == proto::NETERR_BAD, "an empty host");
  CHECK(r.c.setRelay(Text{big, 64}) == proto::NETERR_BAD, "a host of 64");
  CHECK(r.c.setRelay(Text{big, 63}) == 0, "a host of 63");
  CHECK(r.c.setRelay(T("a b")) == proto::NETERR_BAD, "a space");
  CHECK(r.c.setRelay(T("a\r\nb")) == proto::NETERR_BAD, "a line break");
  CHECK(r.c.setRelay(T("a/b")) == proto::NETERR_BAD, "a slash");
  CHECK(Mem::saves == 4 && r.c.relay().n == 63, "the host that was fine is the one held");
}

TEST(netconfAnOpItDoesNotKnowIsAnErrorReplyNotSilence) {
  Rig r;
  NetMsg m = NetMsg();
  m.op = proto::NET_OK;  // a reply op where a request belongs
  uint8_t out[16];
  size_t n = r.c.handle(m, out, sizeof out);
  CHECK(hexOf(out, n) == "818001", "ERR BAD, answering the op as given");
}


namespace {
bool zeroFrom(const uint8_t* p, size_t from, size_t to) {
  for (size_t i = from; i < to; i++)
    if (p[i]) return false;
  return true;
}
}  // namespace

TEST(netconfWhatWasReplacedOrRemovedLeavesNothingInMemory) {
  Rig r;
  CHECK(r.ask("0104686f6d6509736563726574313233") == "8001", "home, with a 9-byte password");
  const uint8_t* pass = r.c.pass(0).p;
  CHECK(r.ask("0104686f6d6508" "3132333435363738") == "8001" && r.c.pass(0).n == 8, "a shorter one replaces it");
  CHECK(zeroFrom(pass, 8, 9), "the ninth byte of the old password is gone");
  CHECK(r.ask("0104686f6d6500") == "8001" && r.c.pass(0).n == 0, "and now none");
  CHECK(zeroFrom(pass, 0, 9), "no byte of any password is left");

  CHECK(r.ask("01016208" "3132333435363738") == "8001", "b");
  CHECK(r.ask("010163" "00") == "8001", "c");
  const uint8_t* lastSsid = r.c.ssid(2).p;
  const uint8_t* lastPass = r.c.pass(2).p;
  CHECK(r.ask("0204686f6d65") == "8002" && r.c.count() == 2, "home removed");
  CHECK(zeroFrom(lastSsid, 0, 1) && zeroFrom(lastPass, 0, 8), "the slot that came free holds nothing");

  CHECK(r.ask("0409782e666c792e646576") == "8004", "a host of 9 bytes");
  const uint8_t* host = r.c.relay().p;
  CHECK(r.ask("04" "03" "612e62") == "8004" && r.c.relay().n == 3, "a host of 3 bytes");
  CHECK(zeroFrom(host, 3, 9), "the rest of the old host is gone");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `proto/netconf.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/netconf.cpp`:

```cpp
#include "proto/netconf.h"
#include <string.h>

namespace proto {
namespace {
const uint8_t BLOB_VERSION = 1;

bool sameText(const uint8_t* a, size_t an, Text b) { return an == b.n && (an == 0 || memcmp(a, b.p, an) == 0); }

bool hostChar(uint8_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
}
}  // namespace

NetConf::NetConf() : store_(), s_(), generation_(0) {
  memset(&s_, 0, sizeof s_);
  store_.load = nullptr;
  store_.save = nullptr;
}

bool NetConf::begin(const NetStore& store) {
  if (!store.load || !store.save) return false;
  store_ = store;
  memset(&s_, 0, sizeof s_);
  uint8_t buf[NETCONF_BLOB_MAX + 1];
  size_t n = 0;
  State loaded;
  if (store_.load(buf, sizeof buf, n) && n <= NETCONF_BLOB_MAX && decode(buf, n, loaded)) s_ = loaded;
  return true;
}

size_t NetConf::encode(uint8_t* buf) const {
  uint8_t* p = buf;
  *p++ = BLOB_VERSION;
  *p++ = s_.n;
  for (uint8_t i = 0; i < s_.n; i++) {
    *p++ = s_.nets[i].sl;
    memcpy(p, s_.nets[i].ssid, s_.nets[i].sl);
    p += s_.nets[i].sl;
    *p++ = s_.nets[i].pl;
    memcpy(p, s_.nets[i].pass, s_.nets[i].pl);
    p += s_.nets[i].pl;
  }
  *p++ = s_.hl;
  memcpy(p, s_.host, s_.hl);
  p += s_.hl;
  return (size_t)(p - buf);
}

bool NetConf::decode(const uint8_t* buf, size_t n, State& s) {
  memset(&s, 0, sizeof s);
  if (n < 2 || buf[0] != BLOB_VERSION || buf[1] > NET_NETWORKS_MAX) return false;
  s.n = buf[1];
  size_t at = 2;
  for (uint8_t i = 0; i < s.n; i++) {
    if (at >= n) return false;
    size_t sl = buf[at++];
    if (sl < 1 || sl > NET_SSID_MAX || at + sl + 1 > n) return false;
    memcpy(s.nets[i].ssid, buf + at, sl);
    s.nets[i].sl = (uint8_t)sl;
    at += sl;
    size_t pl = buf[at++];
    if (pl > NET_PASS_MAX || (pl != 0 && pl < 8) || at + pl > n) return false;
    memcpy(s.nets[i].pass, buf + at, pl);
    s.nets[i].pl = (uint8_t)pl;
    at += pl;
  }
  if (at >= n) return false;
  size_t hl = buf[at++];
  if (hl > NET_HOST_MAX || at + hl != n) return false;
  for (size_t i = 0; i < hl; i++)
    if (!hostChar(buf[at + i])) return false;
  memcpy(s.host, buf + at, hl);
  s.hl = (uint8_t)hl;
  return true;
}

uint8_t NetConf::commit(const State& old) {
  uint8_t buf[NETCONF_BLOB_MAX];
  size_t n = encode(buf);
  if (!store_.save || !store_.save(buf, n)) {
    s_ = old;
    return NETERR_STORE;
  }
  generation_++;
  return 0;
}

int NetConf::find(Text ssid) const {
  for (uint8_t i = 0; i < s_.n; i++)
    if (sameText(s_.nets[i].ssid, s_.nets[i].sl, ssid)) return i;
  return -1;
}

uint8_t NetConf::add(Text ssid, Text pass) {
  if (ssid.n < 1 || ssid.n > NET_SSID_MAX || pass.n > NET_PASS_MAX || (pass.n != 0 && pass.n < 8)) return NETERR_BAD;
  State old = s_;
  int at = find(ssid);
  if (at >= 0) {
    if (sameText(s_.nets[at].pass, s_.nets[at].pl, pass)) return 0;  // as it was: nothing to write
  } else {
    if (s_.n >= NET_NETWORKS_MAX) return NETERR_FULL;
    at = s_.n++;
    memcpy(s_.nets[at].ssid, ssid.p, ssid.n);
    s_.nets[at].sl = (uint8_t)ssid.n;
  }
  memset(s_.nets[at].pass, 0, sizeof s_.nets[at].pass);
  if (pass.n) memcpy(s_.nets[at].pass, pass.p, pass.n);
  s_.nets[at].pl = (uint8_t)pass.n;
  return commit(old);
}

uint8_t NetConf::remove(Text ssid) {
  int at = find(ssid);
  if (at < 0) return NETERR_UNKNOWN;
  State old = s_;
  for (uint8_t i = (uint8_t)at; i + 1 < s_.n; i++) s_.nets[i] = s_.nets[i + 1];
  memset(&s_.nets[s_.n - 1], 0, sizeof s_.nets[0]);
  s_.n--;
  return commit(old);
}

uint8_t NetConf::setRelay(Text host) {
  if (host.n < 1 || host.n > NET_HOST_MAX) return NETERR_BAD;
  for (size_t i = 0; i < host.n; i++)
    if (!hostChar(host.p[i])) return NETERR_BAD;
  if (sameText(s_.host, s_.hl, host)) return 0;
  State old = s_;
  memset(s_.host, 0, sizeof s_.host);
  memcpy(s_.host, host.p, host.n);
  s_.hl = (uint8_t)host.n;
  return commit(old);
}

uint8_t NetConf::clearRelay() {
  if (s_.hl == 0) return 0;
  State old = s_;
  memset(s_.host, 0, sizeof s_.host);
  s_.hl = 0;
  return commit(old);
}

Text NetConf::ssid(size_t i) const { return i < s_.n ? Text{s_.nets[i].ssid, s_.nets[i].sl} : Text{nullptr, 0}; }
Text NetConf::pass(size_t i) const { return i < s_.n ? Text{s_.nets[i].pass, s_.nets[i].pl} : Text{nullptr, 0}; }
Text NetConf::relay() const { return s_.hl ? Text{s_.host, s_.hl} : Text{nullptr, 0}; }

size_t NetConf::handle(const NetMsg& m, uint8_t* out, size_t cap) {
  uint8_t err = 0;
  switch (m.op) {
    case NET_WIFI_ADD:
      err = add(m.ssid, m.pass);
      break;
    case NET_WIFI_REMOVE:
      err = remove(m.ssid);
      break;
    case NET_RELAY_SET:
      err = setRelay(m.host);
      break;
    case NET_RELAY_CLEAR:
      err = clearRelay();
      break;
    case NET_WIFI_LIST: {
      Text names[NET_NETWORKS_MAX];
      for (size_t i = 0; i < s_.n; i++) names[i] = ssid(i);
      return buildNetList(names, s_.n, relay(), out, cap);
    }
    default:
      err = NETERR_BAD;
      break;
  }
  return err ? buildNetErr(m.op, err, out, cap) : buildNetOk(m.op, out, cap);
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/netconf.h`:

```cpp
// netconf.h: the Wi-Fi networks and the relay host the S3 holds (protocol/frames.md, "Network settings (plan 6)"), apart from where
// they are kept, so that the host tests can run all of it. The PC sets them with sealed NET frames; handle() does what a request asks
// and builds the reply; the connection code reads them back with count(), ssid(), pass() and relay().
//
// Not thread safe: netconf_nvs.cpp puts one lock around every use on the device.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"

namespace proto {
// Everything is kept as one blob: version, count, (ssid length, ssid, password length, password) x count, host length, host.
const size_t NETCONF_BLOB_MAX = 2 + NET_NETWORKS_MAX * (2 + NET_SSID_MAX + NET_PASS_MAX) + 1 + NET_HOST_MAX;

// Where the blob lives. The device keeps it in NVS; the host tests keep it in a variable.
struct NetStore {
  bool (*load)(uint8_t* buf, size_t cap, size_t& n);  // the blob into buf; false when there is none
  bool (*save)(const uint8_t* buf, size_t n);         // false when it could not be stored
};

class NetConf {
 public:
  NetConf();
  // Loads what the store holds. A blob that is not exactly what save() writes is the same as none: nothing is held.
  // False when the store has no functions.
  bool begin(const NetStore& store);

  // Each returns 0, or the NETERR_* reason. A change that cannot be saved is not made.
  uint8_t add(Text ssid, Text pass);  // a network already held (same SSID) takes the new password; a fifth network is NETERR_FULL
  uint8_t remove(Text ssid);          // NETERR_UNKNOWN when it is not held
  uint8_t setRelay(Text host);
  uint8_t clearRelay();               // nothing set is fine

  size_t count() const { return s_.n; }
  Text ssid(size_t i) const;   // empty past the last
  Text pass(size_t i) const;
  Text relay() const;          // empty when none is set
  // Goes up by one for every change that was made, so a reader can tell that what it holds is old.
  uint32_t generation() const { return generation_; }

  // Does a request and writes the reply payload: OK, ERR, or for LIST the SSIDs and the host (never a password).
  // Returns its length, or 0 when cap is too small.
  size_t handle(const NetMsg& m, uint8_t* out, size_t cap);

 private:
  struct Net {
    uint8_t sl, pl;
    uint8_t ssid[NET_SSID_MAX];
    uint8_t pass[NET_PASS_MAX];
  };
  struct State {
    uint8_t n;
    Net nets[NET_NETWORKS_MAX];
    uint8_t hl;
    uint8_t host[NET_HOST_MAX];
  };
  size_t encode(uint8_t* buf) const;
  static bool decode(const uint8_t* buf, size_t n, State& s);
  uint8_t commit(const State& old);  // saves s_; puts old back and says NETERR_STORE when that fails
  int find(Text ssid) const;

  NetStore store_;
  State s_;
  uint32_t generation_;
};
}  // namespace proto
```

In `firmware/src/main.cpp`, replace:

```cpp
#include "crypto_mbedtls.h"
#include "proto/frame.h"
```

with:

```cpp
#include "crypto_mbedtls.h"
#include "netconf_nvs.h"
#include "proto/frame.h"
```

In `firmware/src/main.cpp`, replace:

```cpp
  h.ringBytes = audioOk ? audio::RING_BYTES : 0;
  usblink::begin(h);
```

with:

```cpp
  h.ringBytes = audioOk ? audio::RING_BYTES : 0;
  netconf::begin();  // before the link: a NET frame may be the first thing it hears
  usblink::begin(h);
```

Create `firmware/src/netconf_nvs.cpp`:

```cpp
// netconf_nvs.cpp: see netconf_nvs.h.
#include "netconf_nvs.h"
#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

namespace netconf {
namespace {
const char* const NS = "walkie";
const char* const KEY = "netconf";

proto::NetConf conf;
SemaphoreHandle_t lock = nullptr;

bool load(uint8_t* buf, size_t cap, size_t& n) {
  Preferences p;
  if (!p.begin(NS, true)) return false;
  size_t len = p.getBytesLength(KEY);
  bool ok = len > 0 && len <= cap && p.getBytes(KEY, buf, len) == len;
  p.end();
  if (ok) n = len;
  return ok;
}

bool save(const uint8_t* buf, size_t n) {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = p.putBytes(KEY, buf, n) == n;
  p.end();
  return ok;
}

void copy(char* to, size_t cap, proto::Text t) {
  size_t n = t.n < cap - 1 ? t.n : cap - 1;
  if (n) memcpy(to, t.p, n);
  to[n] = 0;
}
}  // namespace

void begin() {
  lock = xSemaphoreCreateMutex();
  proto::NetStore s;
  s.load = load;
  s.save = save;
  conf.begin(s);
}

size_t handle(const proto::NetMsg& m, uint8_t* out, size_t cap) {
  xSemaphoreTake(lock, portMAX_DELAY);
  size_t n = conf.handle(m, out, cap);
  xSemaphoreGive(lock);
  return n;
}

void snapshot(Snapshot& s) {
  memset(&s, 0, sizeof s);
  xSemaphoreTake(lock, portMAX_DELAY);
  s.count = (uint8_t)conf.count();
  for (size_t i = 0; i < conf.count(); i++) {
    copy(s.nets[i].ssid, sizeof s.nets[i].ssid, conf.ssid(i));
    copy(s.nets[i].pass, sizeof s.nets[i].pass, conf.pass(i));
  }
  copy(s.host, sizeof s.host, conf.relay());
  s.generation = conf.generation();
  xSemaphoreGive(lock);
}

uint32_t generation() {
  xSemaphoreTake(lock, portMAX_DELAY);
  uint32_t g = conf.generation();
  xSemaphoreGive(lock);
  return g;
}
}  // namespace netconf
```

Create `firmware/src/netconf_nvs.h`:

```cpp
// netconf_nvs.h: the S3's one NetConf (proto/netconf.h), kept in NVS. The link task writes it when a sealed NET frame asks; the
// connection code reads it. One lock covers both, and the readers get a copy, never a pointer into what the link task may change.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/messages.h"
#include "proto/netconf.h"

namespace netconf {
// SSIDs and passwords are C strings, because that is what the Wi-Fi library takes (a NET request cannot hold a NUL).
struct Net {
  char ssid[proto::NET_SSID_MAX + 1];
  char pass[proto::NET_PASS_MAX + 1];
};
struct Snapshot {
  uint8_t count;
  Net nets[proto::NET_NETWORKS_MAX];
  char host[proto::NET_HOST_MAX + 1];  // empty when no relay is set
  uint32_t generation;                 // NetConf::generation() at the time of the copy
};

// Loads what NVS holds. Call once at boot, before usblink::begin().
void begin();
// A NET request that came sealed: does it and writes the reply payload. Returns its length, or 0.
size_t handle(const proto::NetMsg& m, uint8_t* out, size_t cap);
void snapshot(Snapshot& s);
uint32_t generation();
}  // namespace netconf
```

In `firmware/src/usblink.cpp`, replace:

```cpp
#include "keystore_nvs.h"
#include "proto/frame.h"
```

with:

```cpp
#include "keystore_nvs.h"
#include "netconf_nvs.h"
#include "proto/frame.h"
```

In `firmware/src/usblink.cpp`, replace:

```cpp

void onFrame(const proto::Frame& raw) {
```

with:

```cpp

// NET (protocol/frames.md, "Network settings (plan 6)") counts only over a sealed link: a Wi-Fi password never travels in the
// clear, and nobody without the pairing key can set the networks or the relay. A request that is not sealed, or is not one, is refused.
void onNet(const proto::Frame& f, bool sealed) {
  proto::NetMsg m;
  if (!sealed || !proto::parseNet(f.payload, f.len, m)) {
    g_status.rxRefused++;
    return;
  }
  uint8_t p[200];  // the longest reply is a LIST: 2 + 4 x 33 + 1 + 63 = 198
  size_t n = netconf::handle(m, p, sizeof p);
  if (n) send(proto::T_NET, 0, p, (uint16_t)n);
}

void onFrame(const proto::Frame& raw) {
```

In `firmware/src/usblink.cpp`, replace:

```cpp
  uint32_t nonce = gate.helloNonce();
  xSemaphoreGive(txLock);
```

with:

```cpp
  uint32_t nonce = gate.helloNonce();
  bool sealed = gate.lastSealed();
  xSemaphoreGive(txLock);
```

In `firmware/src/usblink.cpp`, replace:

```cpp
    }
    case proto::T_AUDIO_DOWN:
```

with:

```cpp
    }
    case proto::T_NET:
      onNet(f, sealed);
      return;
    case proto::T_AUDIO_DOWN:
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `230 cases, 1335 checks passed, 0 failed`.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.1%, Flash 27.5%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 889 tests, the tools' 17, the relay's 13, and `230 cases, 1335 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add firmware/host/test_netconf.cpp firmware/lib/proto/src/proto/netconf.cpp firmware/lib/proto/src/proto/netconf.h firmware/src/main.cpp firmware/src/netconf_nvs.cpp firmware/src/netconf_nvs.h firmware/src/usblink.cpp
git commit -m "Task 10: netconf: the S3 holds up to four Wi-Fi networks and a relay host, set only by sealed NET frames (host tests, NVS store, usblink handler)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: walkie wifi, and walkie relay on the S3

`runNet` sends one sealed NET request over a `Link` that holds the key and waits for its answer (`askOnce`, which ignores replies to other ops and frames that are not replies). `walkie wifi add <ssid>` asks for the password twice with no echo (`readSecret`, raw mode, with backspace that removes a whole character, astral ones included) and sends it; `list` and `remove <ssid>` need no password. `walkie relay <host>` and `--forget` now also set the S3, unless `--pc-only`. All of them need a `pair.key` and the S3 on the cable, say what to do when either is missing, and print no password.

**Files:**
- Create: `bridge/src/link/exchange.js`, `bridge/src/net-cli.js`, `bridge/src/net.js`, `bridge/src/prompt.js`
- Modify: `bridge/bin/walkie.js`, `bridge/src/cli.js`, `bridge/src/dev/args.js`, `bridge/src/pair.js`
- Test (new): `bridge/test/helpers/fake-net.js`, `bridge/test/link/exchange.test.js`, `bridge/test/net-cli.test.js`, `bridge/test/net.test.js`, `bridge/test/prompt.test.js`
- Test (changed): `bridge/test/cli.test.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/walkie-bin.test.js`

**Interfaces:**
- Consumes: The NET payloads and `parseNetReply` (Task 9), the `Link` with a key (plan 5), `relayCommand` and the relay file (Task 8), `connect`'s `portOpener` (plan 1).
- Produces: `bridge/src/link/exchange.js`: `arrivesWithin(emitter, event, ms)`, `askOnce(link, type, payload, pick, answerMs)`.
- Produces: `bridge/src/net.js`: `runNet({ openPort, master, request, helloMs = 10_000, answerMs = 10_000, makeNonce, retryMs, retryMaxMs }): Promise<{ reply }>` (`reply` as `parseNetReply` gives it, or null when the S3 said nothing within `answerMs`; rejects with no key or no HELLO).
- Produces: `bridge/src/net-cli.js`: `wifiCommand({ action, ssid, master, openPort, readSecret, run = runNet, say, err })` and `relayPushCommand({ host, forget, master, openPort, run = runNet, say, err })`, each resolving with an exit code.
- Produces: `bridge/src/prompt.js`: `readSecret(question, { input, output }): Promise<string>`.
- Produces: `parseWalkieCommand`: `{ command: 'wifi', action, ssid, opts }` and `relay`'s `pcOnly`.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `bridge/test/cli.test.js` with:

```js
// The command line of `walkie`: what it takes and what it makes of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../src/dev/args.js';
import { parseWalkieCommand } from '../src/cli.js';

test('no words runs the bridge; --clean-env, --port, --command, --inject and --codec are its options', () => {
  assert.deepEqual(parseWalkieCommand([]), { command: 'run', cleanEnv: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['--clean-env', '--port', 'COM8', '--codec', 'adpcm']), {
    command: 'run', cleanEnv: true, opts: { port: 'COM8', codec: 'adpcm' },
  });
});

test('pair, and pair --forget, are the pairing commands, and take --port', () => {
  assert.deepEqual(parseWalkieCommand(['pair']), { command: 'pair', forget: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['pair', '--forget', '--port', 'COM8']), { command: 'pair', forget: true, opts: { port: 'COM8' } });
  assert.deepEqual(parseWalkieCommand(['--port', 'COM8', 'pair']), { command: 'pair', forget: false, opts: { port: 'COM8' } });
});

test('anything else is a usage error: a word, --forget without pair, --codec or --clean-env with pair', () => {
  for (const argv of [['listen'], ['--forget'], ['pair', 'now'], ['pair', '--bogus'], ['pair', '--clean-env'], ['pair', '--codec', 'pcm'], ['pair', '--inject', 'a.wav'], ['pair', '--command', '[]'], ['--codec', 'opus']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});

test('relay shows the relay set on this PC, relay <host> sets it, relay --forget clears it', () => {
  assert.deepEqual(parseWalkieCommand(['relay']), { command: 'relay', host: null, forget: false, pcOnly: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', 'walkie-relay.fly.dev']), { command: 'relay', host: 'walkie-relay.fly.dev', forget: false, pcOnly: false, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', '--forget']), { command: 'relay', host: null, forget: true, pcOnly: false, opts: {} });
});

test('relay --pc-only keeps the host on this PC, and --port names the cable that the S3 is told over', () => {
  assert.deepEqual(parseWalkieCommand(['relay', 'a.fly.dev', '--pc-only']), { command: 'relay', host: 'a.fly.dev', forget: false, pcOnly: true, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', '--pc-only', '--forget']), { command: 'relay', host: null, forget: true, pcOnly: true, opts: {} });
  assert.deepEqual(parseWalkieCommand(['relay', 'a.fly.dev', '--port', 'COM8']).opts, { port: 'COM8' });
  assert.throws(() => parseWalkieCommand(['relay', '--pc-only']), /goes with a host or --forget/);
  assert.throws(() => parseWalkieCommand(['--pc-only']), UsageError);
  assert.throws(() => parseWalkieCommand(['pair', '--pc-only']), UsageError);
});

test('relay takes one host or --forget, and --pc-only and --port, and no other option', () => {
  for (const argv of [['relay', 'a.fly.dev', 'b.fly.dev'], ['relay', 'a.fly.dev', '--forget'], ['relay', '--codec', 'adpcm'], ['relay', '--clean-env'], ['relay', '--inject', 'a.wav']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});

test('wifi is add <ssid>, list or remove <ssid>, and takes --port', () => {
  assert.deepEqual(parseWalkieCommand(['wifi', 'add', 'home']), { command: 'wifi', action: 'add', ssid: 'home', opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'remove', 'home']), { command: 'wifi', action: 'remove', ssid: 'home', opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'list']), { command: 'wifi', action: 'list', ssid: null, opts: {} });
  assert.deepEqual(parseWalkieCommand(['wifi', 'list', '--port', 'COM8']).opts, { port: 'COM8' });
  assert.deepEqual(parseWalkieCommand(['wifi', 'add', 'my network']).ssid, 'my network');
});

test('wifi without an action, with another, with a name missing or too many, or with an option it does not take, is a usage error', () => {
  const bad = [
    ['wifi'],
    ['wifi', 'join', 'home'],
    ['wifi', 'add'],
    ['wifi', 'remove'],
    ['wifi', 'list', 'home'],
    ['wifi', 'add', 'home', 'cafe'],
    ['wifi', 'add', 'home', '--forget'],
    ['wifi', 'add', 'home', '--codec', 'pcm'],
    ['wifi', 'list', '--clean-env'],
  ];
  for (const argv of bad) assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
});

test('a password is not something wifi takes on the command line: it is typed at the prompt, so it never reaches a history file', () => {
  for (const argv of [['wifi', 'add', 'home', '--pass', 'secret123'], ['wifi', 'add', 'home', '--password=secret123'], ['wifi', 'add', 'home', 'secret123']]) {
    assert.throws(() => parseWalkieCommand(argv), UsageError, argv.join(' '));
  }
});
```

Create `bridge/test/helpers/fake-net.js`:

```js
// What the S3 does with a NET request (firmware/lib/proto/src/proto/netconf.cpp and messages.cpp), in JS, for the stand-in S3: the same
// limits and the same answers, so that the commands that set the networks can be tried against it. Whether the real S3 agrees is
// what gate M is for.
import { NET_ERR, NET_LIMITS, NET_OP } from '../../src/link/messages.js';

const HOST_RE = /^[A-Za-z0-9.-]+$/;

// The text that starts at `at`, led by its length: [bytes, index after it], or null when it runs past the end.
function text(p, at) {
  if (at >= p.length || at + 1 + p[at] > p.length) return null;
  return [p.subarray(at + 1, at + 1 + p[at]), at + 1 + p[at]];
}

const reply = (...bytes) => Buffer.from(bytes);

export class FakeNetConf {
  nets = []; // { ssid, pass } in the order they were added
  relay = null;
  failSave = false; // true: nothing can be stored, so every change answers ERR STORE
  generation = 0;

  // A request as the S3 parses it: { op, ssid, pass, host } with strings, or null when it breaks the frame's rules.
  static parse(p) {
    if (p.length < 1) return null;
    const op = p[0];
    if (op === NET_OP.WIFI_LIST || op === NET_OP.RELAY_CLEAR) return p.length === 1 ? { op } : null;
    if (op === NET_OP.RELAY_SET) {
      const h = text(p, 1);
      if (!h || h[1] !== p.length || h[0].length < 1 || h[0].length > NET_LIMITS.host) return null;
      const host = h[0].toString('latin1');
      return HOST_RE.test(host) ? { op, host } : null;
    }
    if (op !== NET_OP.WIFI_ADD && op !== NET_OP.WIFI_REMOVE) return null;
    const s = text(p, 1);
    if (!s || s[0].length < 1 || s[0].length > NET_LIMITS.ssid || s[0].includes(0)) return null;
    if (op === NET_OP.WIFI_REMOVE) return s[1] === p.length ? { op, ssid: s[0].toString('utf8') } : null;
    const w = text(p, s[1]);
    if (!w || w[1] !== p.length || w[0].length > NET_LIMITS.pass || (w[0].length > 0 && w[0].length < 8) || w[0].includes(0)) return null;
    return { op, ssid: s[0].toString('utf8'), pass: w[0].toString('utf8') };
  }

  // The reply payload to a request, or null when it is not a valid one (the S3 drops it).
  handle(p) {
    const m = FakeNetConf.parse(p);
    if (!m) return null;
    const bad = (why) => reply(NET_OP.ERR, m.op, why);
    const save = (change) => {
      if (this.failSave) return bad(NET_ERR.STORE);
      change();
      this.generation++;
      return reply(NET_OP.OK, m.op);
    };
    const at = this.nets.findIndex((n) => n.ssid === m.ssid);
    switch (m.op) {
      case NET_OP.WIFI_ADD:
        if (at >= 0) return this.nets[at].pass === m.pass ? reply(NET_OP.OK, m.op) : save(() => (this.nets[at].pass = m.pass));
        if (this.nets.length >= NET_LIMITS.networks) return bad(NET_ERR.FULL);
        return save(() => this.nets.push({ ssid: m.ssid, pass: m.pass }));
      case NET_OP.WIFI_REMOVE:
        return at < 0 ? bad(NET_ERR.UNKNOWN) : save(() => this.nets.splice(at, 1));
      case NET_OP.RELAY_SET:
        return this.relay === m.host ? reply(NET_OP.OK, m.op) : save(() => (this.relay = m.host));
      case NET_OP.RELAY_CLEAR:
        return this.relay === null ? reply(NET_OP.OK, m.op) : save(() => (this.relay = null));
      default: {
        const parts = [reply(NET_OP.LIST, this.nets.length)];
        for (const n of this.nets) parts.push(reply(Buffer.byteLength(n.ssid)), Buffer.from(n.ssid));
        const host = Buffer.from(this.relay ?? '', 'latin1');
        parts.push(reply(host.length), host);
        return Buffer.concat(parts); // never a password
      }
    }
  }
}
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
import { Session } from '../../src/link/session.js';

```

with:

```js
import { Session } from '../../src/link/session.js';
import { FakeNetConf } from './fake-net.js';

```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  pairRequests = []; // every PAIR request that came: { op, key }
  #ringBytes;
```

with:

```js
  pairRequests = []; // every PAIR request that came: { op, key }
  net = new FakeNetConf(); // the Wi-Fi networks and relay host a NET request sets
  netRequests = []; // every NET request that was taken (it came sealed on a paired S3): its plain payload
  netRefused = 0; // NET frames that were not taken: plain, or on an S3 with no key
  #ringBytes;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      this.sent.push(frame);
      setImmediate(() => this.#answer(frame));
    }
```

with:

```js
      this.sent.push(frame);
      const sealed = Boolean(this.session) && f.type !== TYPE.HELLO && f.type !== TYPE.PAIR;
      setImmediate(() => this.#answer(frame, sealed));
    }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js

  #answer(f) {
    switch (f.type) {
```

with:

```js

  #answer(f, sealed) {
    switch (f.type) {
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
        break;
      default:
```

with:

```js
        break;
      case TYPE.NET: {
        // Only ever over a sealed link, as the firmware has it: a plain NET frame, or any on an S3 without a key, is dropped.
        const answer = sealed ? this.net.handle(f.payload) : null;
        if (!sealed || answer === null) {
          this.netRefused++;
          break;
        }
        this.netRequests.push(f.payload);
        this.feed(TYPE.NET, answer);
        break;
      }
      default:
```

Create `bridge/test/link/exchange.test.js`:

```js
// arrivesWithin and askOnce: waiting for an event, and sending one frame and waiting for its answer, without leaving a timer or a
// listener behind (the commands that use them are short-lived processes, but a test process and a long-lived caller are not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { arrivesWithin, askOnce } from '../../src/link/exchange.js';

const PICK = (p) => (p[0] === 1 ? { got: p[0] } : null);

function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.send = (type, payload) => link.sent.push({ type, payload });
  return link;
}

test('arrivesWithin is true when the event comes, and leaves no timer and no listener', async (t) => {
  const e = new EventEmitter();
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const result = arrivesWithin(e, 'hello', 5000);
  assert.equal(e.listenerCount('hello'), 1);
  e.emit('hello');
  assert.equal(await result, true);
  assert.equal(e.listenerCount('hello'), 0);
  assert.equal(cleared.mock.callCount(), 1, 'the timer was cleared');
});

test('arrivesWithin is false when the time runs out, and leaves no listener', async () => {
  const e = new EventEmitter();
  assert.equal(await arrivesWithin(e, 'hello', 20), false);
  assert.equal(e.listenerCount('hello'), 0);
});

test('askOnce sends the frame once, and resolves with what pick makes of the first answer it accepts', async () => {
  const link = fakeLink();
  const answer = askOnce(link, 0x33, Buffer.from([9]), PICK, 5000);
  assert.deepEqual(link.sent, [{ type: 0x33, payload: Buffer.from([9]) }]);
  link.emit('frame', { type: 0x33, payload: Buffer.from([2]) }); // not an answer
  link.emit('frame', { type: 0x33, payload: Buffer.from([1]) });
  link.emit('frame', { type: 0x33, payload: Buffer.from([1, 5]) }); // a second one changes nothing
  assert.deepEqual(await answer, { got: 1 });
  assert.equal(link.sent.length, 1, 'never sent again');
});

test('a frame of another type is not an answer, whatever pick would make of it', async () => {
  const link = fakeLink();
  const answer = askOnce(link, 0x33, Buffer.from([9]), PICK, 60);
  link.emit('frame', { type: 0x32, payload: Buffer.from([1]) });
  assert.equal(await answer, null);
});

test('askOnce is null after answerMs, and either way leaves no listener and no timer', async (t) => {
  const link = fakeLink();
  assert.equal(await askOnce(link, 0x33, Buffer.alloc(1), PICK, 20), null);
  assert.equal(link.listenerCount('frame'), 0);
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const answer = askOnce(link, 0x33, Buffer.alloc(1), PICK, 5000);
  link.emit('frame', { type: 0x33, payload: Buffer.from([1]) });
  await answer;
  assert.equal(link.listenerCount('frame'), 0);
  assert.equal(cleared.mock.callCount(), 1);
});
```

Create `bridge/test/net-cli.test.js`:

```js
// walkie wifi add|list|remove and the relay host sent on to the S3: the console around runNet, and an exit code. `run` stands in for
// runNet, so what is checked here is what is asked, what is said and what is never said (a password).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayPushCommand, wifiCommand } from '../src/net-cli.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from '../src/link/messages.js';

const KEY = Buffer.alloc(32, 7);

function fixture({ replies = [], typed = [], master = KEY } = {}) {
  const said = [];
  const errs = [];
  const asked = [];
  const calls = [];
  const queue = [...replies];
  const keys = [...typed];
  const f = {
    said,
    errs,
    asked,
    calls,
    all: () => [...said, ...errs, ...asked].join('\n'),
    base: {
      master,
      openPort: async () => null,
      say: (s) => said.push(s),
      err: (s) => errs.push(s),
      readSecret: async (q) => {
        asked.push(q);
        const next = keys.shift();
        if (next instanceof Error) throw next;
        return next ?? '';
      },
      run: async (options) => {
        calls.push(options);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { reply: next ?? null };
      },
    },
  };
  return f;
}
const ok = (op) => ({ kind: 'ok', answered: op });
const refused = (op, reason) => ({ kind: 'err', answered: op, reason });

test('wifi add asks for the password twice, with typing hidden, and sends the request sealed through runNet', async () => {
  const f = fixture({ typed: ['secret123', 'secret123'], replies: [ok(NET_OP.WIFI_ADD)] });
  const code = await wifiCommand({ ...f.base, action: 'add', ssid: 'home' });
  assert.equal(code, 0);
  assert.equal(f.asked.length, 2);
  assert.match(f.asked[0], /Wi-Fi password for "home"/);
  assert.match(f.asked[0], /hidden/);
  assert.deepEqual(f.calls[0].request, netWifiAddPayload('home', 'secret123'));
  assert.equal(f.calls[0].master, KEY);
  assert.deepEqual(f.said, ['walkie now holds "home"']);
});

test('an empty password is an open network, and is asked for once', async () => {
  const f = fixture({ typed: [''], replies: [ok(NET_OP.WIFI_ADD)] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'cafe' }), 0);
  assert.equal(f.asked.length, 1);
  assert.deepEqual(f.calls[0].request, netWifiAddPayload('cafe', ''));
  assert.deepEqual(f.said, ['walkie now holds "cafe" (an open network)']);
});

test('two passwords that differ send nothing, and say so without saying either', async () => {
  const f = fixture({ typed: ['secret123', 'secret124'] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.equal(f.calls.length, 0);
  assert.match(f.errs[0], /differ.*nothing was sent/);
  assert.ok(!f.all().includes('secret12'));
});

test('an SSID that cannot be is exit 2 before a password is asked for', async () => {
  const f = fixture();
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'x'.repeat(33) }), 2);
  assert.match(f.errs[0], /^walkie: the ssid must be 1 to 32 bytes/);
  assert.equal(f.asked.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a password that cannot be is exit 2, nothing is sent, and the password is not repeated', async () => {
  const f = fixture({ typed: ['short', 'short'] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 2);
  assert.match(f.errs[0], /^walkie: the password must be 8 to 63 bytes/);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.errs.join('\n').includes('short'));
});

test('without a pairing key nothing is asked and nothing is sent: NET goes sealed only', async () => {
  for (const action of ['add', 'list', 'remove']) {
    const f = fixture({ master: null });
    assert.equal(await wifiCommand({ ...f.base, action, ssid: 'home' }), 1);
    assert.match(f.errs[0], /pairing key comes first/);
    assert.equal(f.asked.length, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('a password prompt that is cancelled, or is not at a terminal, is exit 1 with its message and nothing sent', async () => {
  const f = fixture({ typed: [new Error('cancelled')] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.deepEqual(f.errs, ['cancelled']);
  assert.equal(f.calls.length, 0);
  const g = fixture({ typed: [new Error('a password is typed at a terminal, and this is not one: run this command in your own terminal')] });
  assert.equal(await wifiCommand({ ...g.base, action: 'add', ssid: 'home' }), 1);
  assert.match(g.errs[0], /not one/);
});

test('the reasons the S3 gives are said in words, and the exit code is 1', async () => {
  const cases = [
    [NET_ERR.FULL, /already holds 4 Wi-Fi networks.*wifi remove/],
    [NET_ERR.STORE, /could not save it, so nothing changed/],
    [NET_ERR.BAD, /malformed/],
    [99, /reason 99/],
  ];
  for (const [reason, pattern] of cases) {
    const f = fixture({ typed: ['secret123', 'secret123'], replies: [refused(NET_OP.WIFI_ADD, reason)] });
    assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
    assert.match(f.errs[0], pattern);
    assert.ok(!f.all().includes('secret123'), 'the password is not echoed in any message');
  }
});

test('remove sends the SSID, and says when walkie did not hold it', async () => {
  const f = fixture({ replies: [ok(NET_OP.WIFI_REMOVE), refused(NET_OP.WIFI_REMOVE, NET_ERR.UNKNOWN)] });
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'home' }), 0);
  assert.deepEqual(f.calls[0].request, netWifiRemovePayload('home'));
  assert.deepEqual(f.said, ['walkie forgot "home"']);
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'home' }), 1);
  assert.match(f.errs[0], /holds no such network.*wifi list/);
});

test('list prints the networks in order and the relay, or says there are none', async () => {
  const f = fixture({
    replies: [
      { kind: 'list', ssids: ['home', 'cafe'], host: 'walkie-relay.fly.dev' },
      { kind: 'list', ssids: [], host: null },
    ],
  });
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 0);
  assert.deepEqual(f.calls[0].request, netWifiListPayload());
  assert.deepEqual(f.said, ['Wi-Fi networks on walkie, tried in this order:', '  1. home', '  2. cafe', 'relay on walkie: walkie-relay.fly.dev']);
  f.said.length = 0;
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 0);
  assert.deepEqual(f.said, ['walkie holds no Wi-Fi network (node bridge/bin/walkie.js wifi add <ssid>)', 'relay on walkie: none']);
});

test('no answer is exit 1 with how to find out what happened, and an error from runNet is its own message', async () => {
  const f = fixture({ typed: ['secret123', 'secret123'], replies: [null, new Error('no walkie answered within 10 s: is it plugged in')] });
  assert.equal(await wifiCommand({ ...f.base, action: 'add', ssid: 'home' }), 1);
  assert.match(f.errs[0], /did not answer.*wifi list/);
  assert.equal(await wifiCommand({ ...f.base, action: 'list' }), 1);
  assert.equal(f.errs[1], 'no walkie answered within 10 s: is it plugged in');
});

test('the options for the link are passed on to runNet', async () => {
  const f = fixture({ replies: [{ kind: 'list', ssids: [], host: null }] });
  await wifiCommand({ ...f.base, action: 'list', helloMs: 123, answerMs: 456 });
  assert.equal(f.calls[0].helloMs, 123);
  assert.equal(f.calls[0].answerMs, 456);
  assert.equal(typeof f.calls[0].openPort, 'function');
});

test('the relay host goes on to the S3, or off it', async () => {
  const f = fixture({ replies: [ok(NET_OP.RELAY_SET), ok(NET_OP.RELAY_CLEAR)] });
  assert.equal(await relayPushCommand({ ...f.base, host: 'walkie-relay.fly.dev', forget: false }), 0);
  assert.deepEqual(f.calls[0].request, netRelaySetPayload('walkie-relay.fly.dev'));
  assert.deepEqual(f.said, ['walkie now uses the relay walkie-relay.fly.dev']);
  assert.equal(await relayPushCommand({ ...f.base, host: null, forget: true }), 0);
  assert.deepEqual(f.calls[1].request, netRelayClearPayload());
  assert.equal(f.said[1], 'walkie no longer has a relay');
});

test('a relay that did not go on is exit 1 and says why', async () => {
  const f = fixture({ replies: [refused(NET_OP.RELAY_SET, NET_ERR.STORE), null] });
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[0], /could not save it/);
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[1], /did not answer.*wifi list/);
});

test('a relay host that is not one is exit 2 and sends nothing', async () => {
  const f = fixture();
  assert.equal(await relayPushCommand({ ...f.base, host: 'a b', forget: false }), 2);
  assert.equal(f.calls.length, 0);
});

test('a relay push without a pairing key says so and sends nothing', async () => {
  const f = fixture({ master: null });
  assert.equal(await relayPushCommand({ ...f.base, host: 'a.fly.dev', forget: false }), 1);
  assert.match(f.errs[0], /pairing key comes first/);
  assert.equal(f.calls.length, 0);
});


test('remove with an SSID that cannot be is exit 2 and sends nothing', async () => {
  const f = fixture();
  assert.equal(await wifiCommand({ ...f.base, action: 'remove', ssid: 'x'.repeat(33) }), 2);
  assert.match(f.errs[0], /^walkie: the ssid must be 1 to 32 bytes/);
  assert.equal(f.calls.length, 0);
});
```

Create `bridge/test/net.test.js`:

```js
// runNet: one sealed NET request to the S3 and its answer (protocol/frames.md, "Network settings (plan 6)"). The stand-in S3 keeps the
// networks the way the firmware does (test/helpers/fake-net.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNet } from '../src/net.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from '../src/link/messages.js';
import { SEALED } from '../src/link/session.js';
import { FakeNetConf } from './helpers/fake-net.js';
import { FakeS3 } from './helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 0x42);
const FAST = { helloMs: 3000, answerMs: 3000, retryMs: 20, makeNonce: () => 0x1234abcd };

function setup(deviceOptions = {}) {
  const device = new FakeS3({ proto: 2, master: KEY, ...deviceOptions });
  const run = (request, options = {}) => runNet({ openPort: async () => device, master: KEY, request, ...FAST, ...options });
  return { device, run };
}

test('WIFI_ADD is taken by a paired S3 over the sealed link, and answered OK', async () => {
  const { device, run } = setup();
  const { reply } = await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual(reply, { kind: 'ok', answered: NET_OP.WIFI_ADD });
  assert.deepEqual(device.net.nets, [{ ssid: 'home', pass: 'secret123' }]);
  assert.equal(device.netRequests.length, 1);
  assert.equal(device.netRefused, 0);
});

test('the request travelled sealed: on the wire it is not the plain bytes, and no password is in it', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  const net = device.raw.find((f) => f.type === 0x33);
  assert.ok(net.flags & SEALED, 'the seal bit is set');
  assert.ok(!net.payload.includes(Buffer.from('secret123')), 'the password is not in the clear');
  assert.ok(!net.payload.includes(Buffer.from('home')), 'nor is the SSID');
});

test('LIST names the networks in the order they were added and the relay host, and never a password', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  await run(netWifiAddPayload('cafe', ''));
  await run(netRelaySetPayload('walkie-relay.fly.dev'));
  const { reply } = await run(netWifiListPayload());
  assert.deepEqual(reply, { kind: 'list', ssids: ['home', 'cafe'], host: 'walkie-relay.fly.dev' });
  assert.deepEqual(device.net.nets.map((n) => n.ssid), ['home', 'cafe']);
});

test('REMOVE, and an SSID that is not held is ERR UNKNOWN', async () => {
  const { device, run } = setup();
  await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual((await run(netWifiRemovePayload('home'))).reply, { kind: 'ok', answered: NET_OP.WIFI_REMOVE });
  assert.deepEqual(device.net.nets, []);
  assert.deepEqual((await run(netWifiRemovePayload('home'))).reply, { kind: 'err', answered: NET_OP.WIFI_REMOVE, reason: NET_ERR.UNKNOWN });
});

test('a fifth network is ERR FULL', async () => {
  const { run } = setup();
  for (const ssid of ['a', 'b', 'c', 'd']) assert.equal((await run(netWifiAddPayload(ssid, ''))).reply.kind, 'ok');
  assert.deepEqual((await run(netWifiAddPayload('e', ''))).reply, { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.FULL });
});

test('a change the S3 cannot save is ERR STORE and changes nothing', async () => {
  const { device, run } = setup();
  device.net.failSave = true;
  assert.deepEqual((await run(netWifiAddPayload('home', 'secret123'))).reply, { kind: 'err', answered: NET_OP.WIFI_ADD, reason: NET_ERR.STORE });
  assert.deepEqual(device.net.nets, []);
});

test('the relay host is set and cleared', async () => {
  const { device, run } = setup();
  assert.equal((await run(netRelaySetPayload('walkie-relay.fly.dev'))).reply.kind, 'ok');
  assert.equal(device.net.relay, 'walkie-relay.fly.dev');
  assert.equal((await run(netRelayClearPayload())).reply.kind, 'ok');
  assert.equal(device.net.relay, null);
});

test('only the answer to the request that was asked counts', async () => {
  const { device, run } = setup();
  // Another op's answer comes first (sealed, as the S3 would send it), then the one asked for.
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([NET_OP.OK, NET_OP.RELAY_SET]));
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiListPayload());
  assert.equal(reply.kind, 'list');
});

test('an S3 with no key never takes NET: a sealed request cannot even be made, and the S3 says nothing', async () => {
  const device = new FakeS3({ proto: 2 }); // no key
  await assert.rejects(runNet({ openPort: async () => device, master: null, request: netWifiListPayload(), ...FAST }), /pairing key/);
  assert.equal(device.sent.filter((f) => f.type === 0x33).length, 0);
});

test('with the wrong key there is no sealed link, so no answer and no request taken', async () => {
  const device = new FakeS3({ proto: 2, master: Buffer.alloc(32, 0x5a) });
  await assert.rejects(
    runNet({ openPort: async () => device, master: KEY, request: netWifiListPayload(), ...FAST, helloMs: 300 }),
    /no walkie answered within 0.3 s/,
  );
  assert.equal(device.netRequests.length, 0);
});

test('no walkie at all is an error that says what to check', async () => {
  const device = new FakeS3({ proto: 2, master: KEY });
  device.write = () => true; // a port nobody answers on
  await assert.rejects(
    runNet({ openPort: async () => device, master: KEY, request: netWifiListPayload(), ...FAST, helloMs: 200 }),
    /no walkie answered within 0.2 s: is it plugged in/,
  );
});

test('an S3 that takes the request and says nothing is null after answerMs, and the link is closed', async () => {
  const { device, run } = setup();
  device.net.handle = () => null; // taken as far as the frame goes, never answered
  const { reply } = await run(netWifiListPayload(), { answerMs: 200 });
  assert.equal(reply, null);
  assert.equal(device.listenerCount('data'), 0, 'the link let go of the port');
});

test('the link is closed after an answer too', async () => {
  const { device, run } = setup();
  await run(netWifiListPayload());
  assert.equal(device.listenerCount('data'), 0);
});


test('a LIST reply is not the answer to a request that was not LIST', async () => {
  const { device, run } = setup();
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([0x82, 0, 0])); // an empty list, as if for another request
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiAddPayload('home', 'secret123'));
  assert.deepEqual(reply, { kind: 'ok', answered: NET_OP.WIFI_ADD });
});

test('a NET frame that is not a reply at all is passed over, and the real answer still counts', async () => {
  const { device, run } = setup();
  device.net.handle = function handle(p) {
    device.feed(0x33, Buffer.from([0x7f, 1, 2]));
    device.feed(0x33, Buffer.alloc(0));
    return FakeNetConf.prototype.handle.call(this, p);
  };
  const { reply } = await run(netWifiListPayload());
  assert.equal(reply.kind, 'list');
});

test('the wait for the answer is answerMs, not the wait for HELLO', async () => {
  const { device, run } = setup();
  device.net.handle = () => null;
  const started = Date.now();
  const { reply } = await run(netWifiListPayload(), { helloMs: 5000, answerMs: 150 });
  assert.equal(reply, null);
  assert.ok(Date.now() - started < 2500, `gave up after ${Date.now() - started} ms`);
});
```

Create `bridge/test/prompt.test.js`:

```js
// readSecret: a password typed at the person's own terminal, with nothing echoed, never put on a command line or in a file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readSecret } from '../src/prompt.js';

function terminal({ tty = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = tty;
  input.isRaw = false;
  input.raw = [];
  input.setRawMode = (on) => {
    input.raw.push(on);
    input.isRaw = on;
  };
  input.setEncoding = () => {};
  input.paused = true;
  input.resume = () => {
    input.paused = false;
  };
  input.pause = () => {
    input.paused = true;
  };
  const written = [];
  const output = { write: (s) => written.push(s) };
  return { input, output, written, type: (s) => input.emit('data', s) };
}

test('what is typed up to Enter is the secret, and it is never written back', async () => {
  const t = terminal();
  const result = readSecret('password: ', { input: t.input, output: t.output });
  t.type('hun');
  t.type('ter2\r');
  assert.equal(await result, 'hunter2');
  assert.equal(t.written.join(''), 'password: \n');
});

test('raw mode is on while typing and back as it was after, and the input is let go', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  assert.deepEqual(t.input.raw, [true]);
  assert.equal(t.input.paused, false);
  t.type('x\n');
  await result;
  assert.deepEqual(t.input.raw, [true, false]);
  assert.equal(t.input.paused, true);
  assert.equal(t.input.listenerCount('data'), 0);
});

test('a terminal that was already raw is left raw', async () => {
  const t = terminal();
  t.input.isRaw = true;
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('x\r');
  await result;
  assert.deepEqual(t.input.raw, [true, true]);
});

test('Backspace takes off a whole character, even one that is more than a byte', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('ab咖啡\u007f\u007f');
  t.type('c\b');
  t.type('d\r');
  assert.equal(await result, 'abd');
});

test('Backspace on nothing does nothing', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('\u007f\u007fa\r');
  assert.equal(await result, 'a');
});

test('Ctrl+C cancels: it rejects, and the terminal is put back', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('abc\u0003');
  await assert.rejects(result, /cancelled/);
  assert.deepEqual(t.input.raw, [true, false]);
  assert.equal(t.written.join(''), 'p: \n');
});

test('an arrow key or another escape sequence adds nothing', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\u001b[Ab\u001b[1;5Cc\u001b[3~d\r');
  assert.equal(await result, 'abcd');
});

test('other control characters add nothing, and a pasted line is taken to its end', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\tb\u0001c\r');
  assert.equal(await result, 'abc');
});

test('what comes after Enter in the same chunk is not part of it', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('abc\rdef');
  assert.equal(await result, 'abc');
});

test('Enter with nothing typed is an empty secret: an open network', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('\r');
  assert.equal(await result, '');
});

test('input that is not a terminal is refused before anything is written: a password is typed, not piped', async () => {
  const t = terminal({ tty: false });
  await assert.rejects(readSecret('p: ', { input: t.input, output: t.output }), /this is not one/);
  assert.deepEqual(t.written, []);
  assert.deepEqual(t.input.raw, []);
});

test('an input that cannot go raw is refused too', async () => {
  const t = terminal();
  t.input.setRawMode = undefined;
  await assert.rejects(readSecret('p: ', { input: t.input, output: t.output }), /this is not one/);
});


test('a character outside the BMP is one character: one Backspace takes all of it', async () => {
  const t = terminal();
  const result = readSecret('p: ', { input: t.input, output: t.output });
  t.type('a\u{1F600}\u007f\r');
  assert.equal(await result, 'a');
});
```

In `bridge/test/walkie-bin.test.js`, replace:

```js
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

with:

```js
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('wifi without an action is exit 2 and the usage; with no pairing key it stops before asking for a password or opening a port', () => {
  const bare = run('wifi');
  assert.equal(bare.status, 2);
  assert.match(bare.out, /usage: node bridge\/bin\/walkie\.js/);
  assert.match(bare.out, /wifi add <ssid>/);
  for (const args of [['wifi', 'add', 'home'], ['wifi', 'list'], ['wifi', 'remove', 'home']]) {
    const r = run(...args);
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.err, /pairing key comes first/, args.join(' '));
    assert.doesNotMatch(r.err + r.out, /password/i, 'nothing was asked');
  }
  assert.equal(run('wifi', 'add').status, 2);
});

test('relay <host> without a pairing key sets the PC and says that the S3 was not told; --pc-only says nothing of it', () => {
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  const go = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 20_000, env: env(appdata) });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    const set = go('relay', 'a.fly.dev');
    assert.equal(set.status, 0);
    assert.match(set.out, /relay set on this PC: a.fly.dev/);
    assert.match(set.out, /not paired, so the S3 was not told/);
    const only = go('relay', 'b.fly.dev', '--pc-only');
    assert.equal(only.status, 0);
    assert.doesNotMatch(only.out, /not told/);
    assert.match(go('relay').out, /relay: b.fly.dev/);
    assert.match(go('relay', '--forget').out, /not paired, so the S3 was not told/);
    assert.equal(go('relay', '--pc-only').status, 2);
  } finally {
    rmSync(appdata, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/cli.test.js bridge/test/link/exchange.test.js bridge/test/net-cli.test.js bridge/test/net.test.js bridge/test/prompt.test.js bridge/test/walkie-bin.test.js`
Expected: FAIL, 5 tests fail: `relay shows the relay set on this PC, relay <host> sets it, relay --forget clears it`, `relay --pc-only keeps the host on this PC, and --port names the cable that the S3 is told over`, `wifi is add <ssid>, list or remove <ssid>, and takes --port`, `wifi without an action is exit 2 and the usage; with no pairing key it stops before asking for a password or opening a port`, `relay <host> without a pairing key sets the PC and says that the S3 was not told; --pc-only says nothing of it`; the files `bridge/test/link/exchange.test.js`, `bridge/test/net-cli.test.js`, `bridge/test/net.test.js`, `bridge/test/prompt.test.js` cannot load, because they import `bridge/src/link/exchange.js`, `bridge/src/net-cli.js`, `bridge/src/net.js`, `bridge/src/prompt.js`, which do not exist yet.

- [ ] **Step 3: Write the implementation**

In `bridge/bin/walkie.js`, replace:

```js
import { relayCommand } from '../src/relay-cli.js';
import { createAdapters } from '../src/speech/speech.js';
```

with:

```js
import { relayCommand } from '../src/relay-cli.js';
import { relayPushCommand, wifiCommand } from '../src/net-cli.js';
import { readSecret } from '../src/prompt.js';
import { createAdapters } from '../src/speech/speech.js';
```

In `bridge/bin/walkie.js`, replace:

```js
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
       node bridge/bin/walkie.js relay [<host> | --forget]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
```

with:

```js
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
       node bridge/bin/walkie.js relay [<host> | --forget] [--pc-only] [--port COMx]
       node bridge/bin/walkie.js wifi add <ssid> | list | remove <ssid> [--port COMx]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
```

In `bridge/bin/walkie.js`, replace:

```js
  relay             show the relay host of this PC; relay <host> sets it (a name such as walkie-relay.fly.dev); relay --forget clears it.
                    The relay is used only with a pairing key, which names the room, and never with --port.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

with:

```js
  relay             show the relay host of this PC; relay <host> sets it (a name such as walkie-relay.fly.dev); relay --forget clears it.
                    With a pairing key it also tells the S3 (over the cable, or over the relay when the S3 is on Wi-Fi), unless --pc-only.
                    The relay is used only with a pairing key, which names the room, and never with --port.
  wifi              the S3's Wi-Fi networks, kept on the S3 (at most 4, tried in the order they were added). add asks for the password
                    at the prompt, typing hidden, never on the command line; list shows the names and the relay, never a password.
                    Needs a pairing key, and the S3 on the cable or on the relay. Stop walkie first: it holds the cable and the relay.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

In `bridge/bin/walkie.js`, replace:

```js

if (parsed.command === 'relay') {
  const code = relayCommand({ host: parsed.host, forget: parsed.forget });
  await new Promise((resolve) => setTimeout(resolve, 100)); // lets the output flush
  process.exit(code);
```

with:

```js

// The way to the S3 for the commands that talk to it once: the cable, else the relay, as `walkie` itself goes.
function s3Port(master) {
  return bridgeOpenPort({ port: opts.port ?? null, master, relayHost: () => loadRelayHost(), log: (line) => console.log(`[transport] ${line}`) });
}

if (parsed.command === 'relay') {
  let code = relayCommand({ host: parsed.host, forget: parsed.forget });
  if (code === 0 && !parsed.pcOnly && (parsed.host !== null || parsed.forget)) {
    try {
      const master = loadPairKey();
      if (master) code = await relayPushCommand({ host: parsed.forget ? null : loadRelayHost(), forget: parsed.forget, master, openPort: s3Port(master) });
      else console.log('not paired, so the S3 was not told (node bridge/bin/walkie.js pair, then this again)');
    } catch (err) {
      console.error(err.message);
      code = 1;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300)); // lets the output flush, and the port finish closing
  process.exit(code);
}

if (parsed.command === 'wifi') {
  let code;
  try {
    const master = loadPairKey();
    code = await wifiCommand({ action: parsed.action, ssid: parsed.ssid, master, openPort: master ? s3Port(master) : null, readSecret });
  } catch (err) {
    console.error(err.message);
    code = 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(code);
```

Replace the whole of `bridge/src/cli.js` with:

```js
// The command line of bin/walkie.js, apart from the process: `walkie [options]` runs the bridge, `walkie pair [--forget] [--port COMx]`
// pairs (or unpairs) the S3 over the cable, `walkie relay [<host>|--forget] [--pc-only]` sets, shows or forgets the relay host (on this PC,
// and on the S3 unless --pc-only), and `walkie wifi add <ssid> | list | remove <ssid>` sets the S3's Wi-Fi networks.
import { UsageError, parseArgs } from './dev/args.js';

export function parseWalkieCommand(argv) {
  const { name, args, opts } = parseArgs(argv);
  if (name === 'pair') {
    const extra = args.find((word) => word !== '--forget');
    if (extra !== undefined) throw new UsageError(`${extra} is not something walkie pair takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie pair takes`);
    return { command: 'pair', forget: args.includes('--forget'), opts };
  }
  if (name === 'relay') {
    const stray = args.find((word) => word.startsWith('--') && word !== '--forget' && word !== '--pc-only');
    if (stray !== undefined) throw new UsageError(`${stray} is not something walkie relay takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie relay takes`);
    const forget = args.includes('--forget');
    const pcOnly = args.includes('--pc-only');
    const hosts = args.filter((word) => word !== '--forget' && word !== '--pc-only');
    if (hosts.length > 1) throw new UsageError(`${hosts[1]} is not something walkie relay takes`);
    if (forget && hosts.length > 0) throw new UsageError('walkie relay --forget takes no host');
    if (pcOnly && !forget && hosts.length === 0) throw new UsageError('walkie relay --pc-only goes with a host or --forget');
    return { command: 'relay', host: hosts[0] ?? null, forget, pcOnly, opts };
  }
  if (name === 'wifi') {
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie wifi takes`);
    const [action, ...rest] = args;
    if (action !== 'add' && action !== 'list' && action !== 'remove') throw new UsageError('walkie wifi is add <ssid>, list or remove <ssid>');
    const wants = action === 'list' ? 0 : 1;
    if (rest.length < wants) throw new UsageError(`walkie wifi ${action} needs the network's name`);
    if (rest.length > wants) throw new UsageError(`${rest[wants]} is not something walkie wifi ${action} takes`);
    return { command: 'wifi', action, ssid: rest[0] ?? null, opts };
  }
  const words = [name, ...args].filter((word) => word !== undefined);
  const stray = words.find((word) => word !== '--clean-env');
  if (stray !== undefined) throw new UsageError(`${stray} is not something walkie takes`);
  return { command: 'run', cleanEnv: words.includes('--clean-env'), opts };
}
```

Replace the whole of `bridge/src/dev/args.js` with:

```js
// The command line of walkie-dev.js: <command> [arguments] [--flag value]... A flag that is misspelled, has no value or is
// given twice is an error, never a silent default: a `--provider=openai` that quietly meant "auto" could send a
// recording to a provider nobody agreed to.
export class UsageError extends Error {}

const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider', '--cwd', '--project', '--command', '--elapsed', '--snap', '--inject', '--codec'];
const SWITCHES = ['--all', '--clean-env', '--forget', '--pc-only']; // stay among the arguments, for the command that reads them
const FLAG_LIKE = /^--[A-Za-z][\w-]*(=|$)/; // anything else that starts with -- is text

export function parseArgs(argv) {
  const rest = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAG_LIKE.test(arg) || SWITCHES.includes(arg)) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq); // what follows an equals sign is never repeated: it may be a key
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const name = flag.slice(2);
    if (name in opts) throw new UsageError(`${flag} was given twice`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || FLAG_LIKE.test(value)) throw new UsageError(`${flag} needs a value`);
    if (name === 'codec' && value !== 'pcm' && value !== 'adpcm') throw new UsageError('--codec is pcm or adpcm');
    opts[name] = value;
  }
  const [name, ...args] = rest;
  return { name, args, opts };
}
```

Create `bridge/src/link/exchange.js`:

```js
// What the commands that talk to the S3 once (pair, wifi, relay) share: waiting for an event for a while, and sending one frame and
// waiting for its answer.

// True when `event` came before `ms` ran out.
export function arrivesWithin(emitter, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      resolve(false);
    }, ms);
    const onEvent = () => {
      clearTimeout(timer);
      resolve(true);
    };
    emitter.once(event, onEvent);
  });
}

// Sends one frame and resolves with what `pick` makes of the first frame of that type that it accepts (a falsy result means "not the
// answer"), or null after `answerMs`. The frame is sent once: a request that changes what walkie holds is not safe to repeat.
export function askOnce(link, type, payload, pick, answerMs) {
  return new Promise((resolve) => {
    let giveUp;
    const finish = (answer) => {
      clearTimeout(giveUp);
      link.off('frame', onFrame);
      resolve(answer);
    };
    const onFrame = (f) => {
      if (f.type !== type) return;
      const answer = pick(f.payload);
      if (answer) finish(answer);
    };
    link.on('frame', onFrame);
    giveUp = setTimeout(() => finish(null), answerMs);
    link.send(type, payload);
  });
}
```

Create `bridge/src/net-cli.js`:

```js
// `walkie wifi add|list|remove` and the relay host sent on to the S3: runNet with the console around it, and an exit code (0 done, 1
// it did not happen, 2 what was typed is wrong). A password is read at the terminal, asked twice, and never printed or kept.
import { runNet } from './net.js';
import {
  NET_ERR,
  NET_OP,
  netRelayClearPayload,
  netRelaySetPayload,
  netWifiAddPayload,
  netWifiListPayload,
  netWifiRemovePayload,
} from './link/messages.js';

const NEED_KEY = 'Wi-Fi and relay settings go to walkie sealed, so a pairing key comes first (node bridge/bin/walkie.js pair)';
const WHY = {
  [NET_ERR.BAD]: 'walkie refused the request as malformed',
  [NET_ERR.FULL]: 'walkie already holds 4 Wi-Fi networks: remove one first (node bridge/bin/walkie.js wifi remove <ssid>)',
  [NET_ERR.UNKNOWN]: 'walkie holds no such network (node bridge/bin/walkie.js wifi list)',
  [NET_ERR.STORE]: 'walkie could not save it, so nothing changed',
};
const NO_ANSWER = 'walkie did not answer. See what it holds with: node bridge/bin/walkie.js wifi list';

// Sends `request` and tells what came of it: { reply } to go on with, or { code } when it is over.
async function send({ request, master, openPort, run, err, ...options }) {
  let result;
  try {
    result = await run({ openPort, master, request, ...options });
  } catch (e) {
    err(e.message);
    return { code: 1 };
  }
  if (result.reply === null) {
    err(NO_ANSWER);
    return { code: 1 };
  }
  if (result.reply.kind === 'err') {
    err(WHY[result.reply.reason] ?? `walkie refused (reason ${result.reply.reason})`);
    return { code: 1 };
  }
  return { reply: result.reply };
}

export async function wifiCommand({
  action,
  ssid = null,
  master,
  openPort,
  readSecret,
  run = runNet,
  say = console.log,
  err = console.error,
  ...options
}) {
  if (!master) {
    err(NEED_KEY);
    return 1;
  }
  let request;
  let open = false;
  if (action === 'add') {
    try {
      netWifiAddPayload(ssid, ''); // the SSID alone is checked first, so that nobody types a password for one that cannot be
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
    let pass;
    try {
      pass = await readSecret(`Wi-Fi password for "${ssid}" (typing is hidden; Enter with nothing for an open network): `);
      if (pass !== '' && pass !== (await readSecret('Again: '))) {
        err('walkie: the two passwords differ: nothing was sent');
        return 1;
      }
    } catch (e) {
      err(e.message);
      return 1;
    }
    try {
      request = netWifiAddPayload(ssid, pass);
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
    open = pass === '';
  } else if (action === 'remove') {
    try {
      request = netWifiRemovePayload(ssid);
    } catch (e) {
      err(`walkie: ${e.message}`);
      return 2;
    }
  } else {
    request = netWifiListPayload();
  }
  const { reply, code } = await send({ request, master, openPort, run, err, ...options });
  if (reply === undefined) return code;
  if (action === 'add') say(`walkie now holds "${ssid}"${open ? ' (an open network)' : ''}`);
  else if (action === 'remove') say(`walkie forgot "${ssid}"`);
  else {
    if (reply.ssids.length === 0) say('walkie holds no Wi-Fi network (node bridge/bin/walkie.js wifi add <ssid>)');
    else {
      say('Wi-Fi networks on walkie, tried in this order:');
      reply.ssids.forEach((name, i) => say(`  ${i + 1}. ${name}`));
    }
    say(`relay on walkie: ${reply.host ?? 'none'}`);
  }
  return 0;
}

// After `walkie relay <host>` or `--forget` has done its part on this PC: the same on the S3.
export async function relayPushCommand({ host, forget, master, openPort, run = runNet, say = console.log, err = console.error, ...options }) {
  if (!master) {
    err(NEED_KEY);
    return 1;
  }
  let request;
  try {
    request = forget ? netRelayClearPayload() : netRelaySetPayload(host);
  } catch (e) {
    err(`walkie: ${e.message}`);
    return 2;
  }
  const { code } = await send({ request, master, openPort, run, err, ...options });
  if (code !== undefined) return code;
  say(forget ? 'walkie no longer has a relay' : `walkie now uses the relay ${host}`);
  return 0;
}
```

Create `bridge/src/net.js`:

```js
// One NET request to the S3 (protocol/frames.md, "Network settings (plan 6)"): bring up a sealed link, send it, wait for the answer.
// The S3 takes NET only over a sealed link, so a pairing key is a must; the way to the S3 is whatever `openPort` gives (the cable, or
// the relay when the S3 is away from it).
import { TYPE } from './link/frame.js';
import { arrivesWithin, askOnce } from './link/exchange.js';
import { Link } from './link/link.js';
import { NET_OP, parseNetReply } from './link/messages.js';

// Resolves with { reply }: the S3's answer as parseNetReply() has it, or null when it said nothing within answerMs (the request may
// or may not have been taken). Rejects when there is no pairing key, or no walkie answers HELLO.
export async function runNet({
  openPort,
  master,
  request,
  helloMs = 10_000,
  answerMs = 10_000,
  makeNonce,
  retryMs = 1000,
  retryMaxMs = 30_000,
}) {
  if (!master) throw new Error('Wi-Fi and relay settings go to walkie sealed, so a pairing key comes first (node bridge/bin/walkie.js pair)');
  const op = request[0];
  const link = new Link({ openPort, master, retryMs, retryMaxMs, ...(makeNonce ? { makeNonce } : {}) });
  try {
    const up = arrivesWithin(link, 'hello', helloMs);
    await link.start();
    if (!(await up)) throw new Error(`no walkie answered within ${helloMs / 1000} s: is it plugged in and running walkie, or on Wi-Fi with a relay set?`);
    const pick = (payload) => {
      const reply = parseNetReply(payload);
      if (!reply) return null;
      return (reply.kind === 'list' ? op === NET_OP.WIFI_LIST : reply.answered === op) ? reply : null;
    };
    return { reply: await askOnce(link, TYPE.NET, request, pick, answerMs) };
  } finally {
    link.close();
  }
}
```

In `bridge/src/pair.js`, replace:

```js
} from './config/pairkey.js';
import { TYPE } from './link/frame.js';
```

with:

```js
} from './config/pairkey.js';
import { arrivesWithin } from './link/exchange.js';
import { TYPE } from './link/frame.js';
```

In `bridge/src/pair.js`, replace:

```js

// True when `event` came before `ms` ran out.
function arrivesWithin(emitter, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      resolve(false);
    }, ms);
    const onEvent = () => {
      clearTimeout(timer);
      resolve(true);
    };
    emitter.once(event, onEvent);
  });
}

// The walkie gives up on its confirm screen 30 s after it opened it, a few ms after the first SET, so no repeat may fall within a second
```

with:

```js

// The walkie gives up on its confirm screen 30 s after it opened it, a few ms after the first SET, so no repeat may fall within a second
```

Create `bridge/src/prompt.js`:

```js
// A secret typed at the person's own terminal: no echo, never an argument, never a file. Only a real terminal will do, because piped
// input would put the password in somebody's shell history or script.
export function readSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('a password is typed at a terminal, and this is not one: run this command in your own terminal'));
      return;
    }
    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let secret = [];
    let escape = false; // inside an escape sequence (an arrow key sends ESC [ A): its letters are not typing
    const finish = (settle) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      settle();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape) {
          if (/[A-Za-z~]/.test(ch)) escape = false;
          continue;
        }
        if (ch === '\u001b') escape = true;
        else if (ch === '\r' || ch === '\n') return finish(() => resolve(secret.join('')));
        else if (ch === '\u0003') return finish(() => reject(new Error('cancelled')));
        else if (ch === '\u007f' || ch === '\b') secret.pop();
        else if (ch >= ' ') secret.push(ch);
      }
    };
    input.on('data', onData);
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/cli.test.js bridge/test/link/exchange.test.js bridge/test/net-cli.test.js bridge/test/net.test.js bridge/test/prompt.test.js bridge/test/walkie-bin.test.js`
Expected: PASS, 68 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 17, the relay's 13, and `230 cases, 1335 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie.js bridge/src/cli.js bridge/src/dev/args.js bridge/src/link/exchange.js bridge/src/net-cli.js bridge/src/net.js bridge/src/pair.js bridge/src/prompt.js bridge/test/cli.test.js bridge/test/helpers/fake-net.js bridge/test/helpers/fake-s3.js bridge/test/link/exchange.test.js bridge/test/net-cli.test.js bridge/test/net.test.js bridge/test/prompt.test.js bridge/test/walkie-bin.test.js
git commit -m "Task 11: walkie wifi add|list|remove and walkie relay pushing the host to the S3: one sealed NET request (runNet), the password typed twice at a terminal with no echo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Backoff, the transport in use, and why OFFLINE

Three small pieces of plain logic the device code will lean on, in `proto/netstate`. `Backoff` gives 1000, 2000, 4000 ms and so on up to 30000 and starts again on `reset()`. `TransportSelector` is the spec's rule (§5.3): it answers which transport the S3 sends on (the one where it last took a HELLO), takes other frames only from that one, marks a transport down, and says whether the S3 is online (a PING on the transport in use within 3 s on USB, 10 s on the relay). `offlineReason` turns what netlink knows into the reason OFFLINE shows.

**Files:**
- Create: `firmware/lib/proto/src/proto/netstate.cpp`, `firmware/lib/proto/src/proto/netstate.h`
- Test (new): `firmware/host/test_netstate.cpp`

**Interfaces:**
- Consumes: Nothing from earlier tasks.
- Produces: `firmware/lib/proto/src/proto/netstate.h`: `class Backoff(firstMs = 1000, maxMs = 30000)` with `next()` and `reset()`; `TR_NONE`, `TR_USB`, `TR_WSS`; `onlineWindowMs(transport)`; `class TransportSelector` with `onFrame(transport, hello, ping, now): bool`, `onDown(transport)`, `active()`, `online(now)`, `switches()`; `LINK_ONLINE`, `LINK_NO_WIFI`, `LINK_RELAY_DOWN`, `LINK_PC_OFFLINE`; `struct LinkView { online, netWanted, wifiUp, relayUp }`; `offlineReason(const LinkView&)`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_netstate.cpp`:

```cpp
// test_netstate.cpp: how the S3 waits between reconnects, which transport it sends on when the cable and the relay are both up, and
// which link OFFLINE names (spec 5.2 to 5.4), without a device: time is a number the test moves.
#include "check.h"
#include "proto/netstate.h"

using proto::Backoff;
using proto::LinkView;
using proto::TransportSelector;

TEST(backoffDoublesFromOneSecondAndStopsAtThirty) {
  Backoff b;
  const uint32_t want[] = {1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000};
  for (uint32_t w : want) CHECK(b.next() == w, "1, 2, 4, 8, 16, then 30 s and no more");
  b.reset();
  CHECK(b.next() == 1000 && b.next() == 2000, "a success starts it again from 1 s");
}

TEST(backoffTakesOtherBoundsButNeverZeroOrAMaxBelowTheFirst) {
  Backoff b(500, 1500);
  CHECK(b.next() == 500 && b.next() == 1000 && b.next() == 1500 && b.next() == 1500, "500, 1000, then the cap");
  Backoff zero(0, 4);
  CHECK(zero.next() == 1 && zero.next() == 2 && zero.next() == 4 && zero.next() == 4, "a first delay of 0 is 1 ms: never a busy loop");
  Backoff odd(1000, 2001);
  CHECK(odd.next() == 1000 && odd.next() == 2000 && odd.next() == 2001, "it doubles while that stays under the cap, then takes the cap");
  Backoff upside(3000, 1000);
  CHECK(upside.next() == 3000 && upside.next() == 3000, "a max below the first is the first");
  Backoff big(0x80000000u, 0xffffffffu);
  CHECK(big.next() == 0x80000000u && big.next() == 0xffffffffu && big.next() == 0xffffffffu, "doubling past 32 bits stops at the max");
}

TEST(onlineWindowsAreThreeSecondsOnUsbAndTenOnTheRelay) {
  CHECK(proto::onlineWindowMs(proto::TR_USB) == 3000, "USB, as before");
  CHECK(proto::onlineWindowMs(proto::TR_WSS) == 10000, "the relay: a hotspot's jitter is not a disconnect");
  CHECK(proto::onlineWindowMs(proto::TR_NONE) == 0, "nothing");
}

TEST(selectorSendsNowhereAndIsOfflineUntilAHello) {
  TransportSelector s;
  CHECK(s.active() == proto::TR_NONE && !s.online(5), "nothing yet");
  CHECK(!s.onFrame(proto::TR_USB, false, true, 10), "a PING before any HELLO is not taken");
  CHECK(!s.online(20), "and does not make it online");
  CHECK(!s.onFrame(proto::TR_NONE, true, false, 30) && s.active() == proto::TR_NONE, "a HELLO from no transport is not taken");
  CHECK(!s.onFrame(7, true, false, 30) && s.active() == proto::TR_NONE, "nor from one that is not USB or the relay");
  s.onFrame(proto::TR_USB, true, false, 40);
  CHECK(!s.onFrame(proto::TR_NONE, false, true, 50) && !s.onFrame(7, true, false, 50) && s.active() == proto::TR_USB, "and they change nothing later");
}

TEST(selectorOnlineMeansAPingOnTheActiveTransportWithinItsWindow) {
  TransportSelector s;
  CHECK(s.onFrame(proto::TR_USB, true, false, 1000), "HELLO on USB");
  CHECK(s.active() == proto::TR_USB && !s.online(1000), "sending on USB; a HELLO alone is not online");
  CHECK(s.onFrame(proto::TR_USB, false, true, 2000), "a PING");
  CHECK(s.online(2000) && s.online(4999) && !s.online(5000), "online for 3 s after it");
  CHECK(s.onFrame(proto::TR_USB, false, false, 4000), "another frame on USB is taken");
  CHECK(!s.online(5000), "but only a PING keeps it online");

  TransportSelector w;
  w.onFrame(proto::TR_WSS, true, false, 0);
  w.onFrame(proto::TR_WSS, false, true, 100);
  CHECK(w.online(10099) && !w.online(10100), "10 s on the relay");
}

TEST(selectorAHelloOnTheOtherTransportSwitchesAndTheOldOneIsDown) {
  TransportSelector s;
  s.onFrame(proto::TR_WSS, true, false, 0);
  s.onFrame(proto::TR_WSS, false, true, 500);
  CHECK(s.online(600), "online on the relay");
  CHECK(s.onFrame(proto::TR_USB, true, false, 700), "the cable goes in: HELLO on USB");
  CHECK(s.active() == proto::TR_USB && s.switches() == 1, "sending on USB now");
  CHECK(!s.online(700), "the relay's PING does not count for USB");
  CHECK(!s.onFrame(proto::TR_WSS, false, true, 800), "a PING still coming on the relay is dropped");
  CHECK(!s.onFrame(proto::TR_WSS, false, false, 800), "and so is anything else on it");
  CHECK(!s.online(800), "and it did not make it online");
  CHECK(s.onFrame(proto::TR_USB, false, true, 900) && s.online(900), "a PING on USB does");
  CHECK(s.onFrame(proto::TR_WSS, true, false, 1000) && s.active() == proto::TR_WSS && s.switches() == 2, "and back, by a HELLO on the relay");
  CHECK(!s.online(1000), "the USB PING does not carry over");
}

TEST(selectorAHelloOnTheSameTransportKeepsItAndItsPing) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0);
  s.onFrame(proto::TR_USB, false, true, 100);
  CHECK(s.onFrame(proto::TR_USB, true, false, 200), "a new HELLO on USB");
  CHECK(s.active() == proto::TR_USB && s.switches() == 0 && s.online(200), "nothing moved");
}

TEST(selectorATransportThatGoesAwayStopsBeingSentOn) {
  TransportSelector s;
  s.onFrame(proto::TR_WSS, true, false, 0);
  s.onFrame(proto::TR_WSS, false, true, 10);
  s.onDown(proto::TR_USB);
  CHECK(s.active() == proto::TR_WSS && s.online(20), "the other one going away changes nothing");
  s.onDown(proto::TR_WSS);
  CHECK(s.active() == proto::TR_NONE && !s.online(20), "the relay connection closed: nowhere to send, offline at once");
  CHECK(!s.onFrame(proto::TR_WSS, false, true, 30), "a PING after it, without a HELLO, is not taken");
  CHECK(s.onFrame(proto::TR_WSS, true, false, 40) && s.active() == proto::TR_WSS, "a HELLO brings it back");
}

TEST(selectorSurvivesTheMillisecondCounterWrapping) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0xfffffc00u);
  s.onFrame(proto::TR_USB, false, true, 0xfffffc00u);
  CHECK(s.online(0xfffffc00u + 2999u) && !s.online(0xfffffc00u + 3000u), "3 s, across the wrap");
}

TEST(selectorAPingAtTimeZeroStillCounts) {
  TransportSelector s;
  s.onFrame(proto::TR_USB, true, false, 0);
  s.onFrame(proto::TR_USB, false, true, 0);
  CHECK(s.online(0) && s.online(2999), "a PING at 0 ms is a PING");
}

TEST(offlineSaysWhichLinkIsDown) {
  LinkView v = {};
  v.online = true;
  CHECK(proto::offlineReason(v) == proto::LINK_ONLINE, "online, whatever else");
  v.online = false;
  CHECK(proto::offlineReason(v) == proto::LINK_PC_OFFLINE, "no network set up: the cable's PC is the only way, and it is not there");
  v.netWanted = true;
  CHECK(proto::offlineReason(v) == proto::LINK_NO_WIFI, "networks set, none joined");
  v.relayUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_NO_WIFI, "a relay link without Wi-Fi under it is still no Wi-Fi");
  v.relayUp = false;
  v.wifiUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_RELAY_DOWN, "Wi-Fi joined, relay not reached");
  v.relayUp = true;
  CHECK(proto::offlineReason(v) == proto::LINK_PC_OFFLINE, "relay reached, no PC pinging");
  v.online = true;
  CHECK(proto::offlineReason(v) == proto::LINK_ONLINE, "and then it is");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `proto/netstate.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/netstate.cpp`:

```cpp
#include "proto/netstate.h"

namespace proto {
Backoff::Backoff(uint32_t firstMs, uint32_t maxMs) : first_(firstMs ? firstMs : 1), max_(maxMs < first_ ? first_ : maxMs), next_(first_) {}

uint32_t Backoff::next() {
  uint32_t now = next_;
  next_ = now > max_ / 2 ? max_ : now * 2;
  return now;
}

void Backoff::reset() { next_ = first_; }

uint32_t onlineWindowMs(uint8_t transport) {
  switch (transport) {
    case TR_USB:
      return 3000;
    case TR_WSS:
      return 10000;
    default:
      return 0;
  }
}

TransportSelector::TransportSelector() : active_(TR_NONE), pinged_(false), lastPing_(0), switches_(0) {}

bool TransportSelector::onFrame(uint8_t transport, bool hello, bool ping, uint32_t now) {
  if (transport != TR_USB && transport != TR_WSS) return false;
  if (hello) {
    if (transport != active_) {
      if (active_ != TR_NONE) switches_++;
      active_ = transport;
      pinged_ = false;
    }
    return true;
  }
  if (transport != active_) return false;
  if (ping) {
    pinged_ = true;
    lastPing_ = now;
  }
  return true;
}

void TransportSelector::onDown(uint8_t transport) {
  if (transport == active_) active_ = TR_NONE;  // online() is then false: TR_NONE has no window
}

bool TransportSelector::online(uint32_t now) const {
  return pinged_ && now - lastPing_ < onlineWindowMs(active_);
}

uint8_t offlineReason(const LinkView& v) {
  if (v.online) return LINK_ONLINE;
  if (!v.netWanted) return LINK_PC_OFFLINE;
  if (!v.wifiUp) return LINK_NO_WIFI;
  if (!v.relayUp) return LINK_RELAY_DOWN;
  return LINK_PC_OFFLINE;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/netstate.h`:

```cpp
// netstate.h: what the S3 decides about its links, apart from the radio and the sockets, so that the host tests can run all of it
// (spec 5.2 to 5.4). Backoff spaces the Wi-Fi and relay reconnects; TransportSelector says which of USB and the relay the S3 sends on
// and whether it is online; offlineReason() says which link OFFLINE names.
//
// Not thread safe: the device puts one lock around a TransportSelector, as it does around the Gate.
#pragma once
#include <stdint.h>

namespace proto {
// Reconnect delays: firstMs, then double each time, never past maxMs. 1, 2, 4 ... 30 s by default.
class Backoff {
 public:
  explicit Backoff(uint32_t firstMs = 1000, uint32_t maxMs = 30000);
  uint32_t next();  // the delay before the next attempt
  void reset();     // after a success: the next delay is firstMs again

 private:
  uint32_t first_, max_, next_;
};

enum : uint8_t { TR_NONE = 0, TR_USB = 1, TR_WSS = 2 };
// How long after a PING the S3 is still online: 3 s on USB, 10 s on the relay; 0 for TR_NONE.
uint32_t onlineWindowMs(uint8_t transport);

// The S3 sends on the transport where it last saw a HELLO. A HELLO on the other one switches it over, and from then on frames that
// still come on the first are dropped (the PC that sent them has moved, or is another one). Online means a PING came on the active
// transport within its window. Times are millis(), and may wrap.
class TransportSelector {
 public:
  TransportSelector();
  // A frame arrived on `transport`. True when it is to be taken; false when it is to be dropped. A HELLO is always taken.
  bool onFrame(uint8_t transport, bool hello, bool ping, uint32_t now);
  // `transport` is gone (the relay connection closed). When it was the active one, nothing is sent until the next HELLO.
  void onDown(uint8_t transport);

  uint8_t active() const { return active_; }
  bool online(uint32_t now) const;
  uint32_t switches() const { return switches_; }  // how many HELLOs moved it to the other transport

 private:
  uint8_t active_;
  bool pinged_;
  uint32_t lastPing_;
  uint32_t switches_;
};

enum : uint8_t { LINK_ONLINE = 0, LINK_NO_WIFI = 1, LINK_RELAY_DOWN = 2, LINK_PC_OFFLINE = 3 };
struct LinkView {
  bool online;     // TransportSelector::online()
  bool netWanted;  // paired, with a network and a relay host set: the S3 is trying the relay
  bool wifiUp;     // joined a network
  bool relayUp;    // the relay connection is open
};
// Which link is down, for OFFLINE: LINK_ONLINE when none is.
uint8_t offlineReason(const LinkView& v);
}  // namespace proto
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `241 cases, 1390 checks passed, 0 failed`.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.1%, Flash 27.5%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 17, the relay's 13, and `241 cases, 1390 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add firmware/host/test_netstate.cpp firmware/lib/proto/src/proto/netstate.cpp firmware/lib/proto/src/proto/netstate.h
git commit -m "Task 12: netstate: reconnect backoff (1, 2, 4 ... 30 s), the transport the S3 sends on (where it last saw a HELLO; online windows 3 s USB, 10 s relay), and which link OFFLINE names" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The S3's WebSocket client codec

The S3 speaks WebSocket through its own small codec in `proto/ws`, pure and host-tested: the upgrade request (with a 16-byte key from the caller), the 101 answer read up to its blank line, client frames masked with a caller's 4-byte mask, server frames unmasked, control frames limited to 125 bytes, a close frame's code. `relay/test/device-bytes.test.js` sends the relay the bytes this codec makes and checks the relay takes them: the upgrade request, a masked binary frame that reaches the PC unchanged, and the empty masked PONG to the relay's ping, without which the relay drops the S3. That relay test passes as soon as it is written, since it pins Task 2's relay to these bytes; the host test is the one that fails first.

**Files:**
- Create: `firmware/lib/proto/src/proto/ws.cpp`, `firmware/lib/proto/src/proto/ws.h`
- Test (new): `firmware/host/test_ws.cpp`, `relay/test/device-bytes.test.js`

**Interfaces:**
- Consumes: `startRelay` (Task 2), in the relay test.
- Produces: `firmware/lib/proto/src/proto/ws.h`: `WS_CONT`, `WS_TEXT`, `WS_BINARY`, `WS_CLOSE`, `WS_PING`, `WS_PONG`; `WS_MAX_PAYLOAD` (1100), `WS_CONTROL_MAX` (125), `WS_KEY_BYTES` (16), `WS_HTTP_MAX` (1024); `wsRequest(host, path, key, out, cap): size_t`; `wsResponse(buf, n, headerLen&, status&)` returning `WS_HTTP_BAD`, `WS_HTTP_MORE` or `WS_HTTP_OK`; `wsEncode(opcode, payload, n, mask, out, cap): size_t`; `struct WsFrame { opcode, fin, payload, n }`; `wsDecode(buf, n, WsFrame&): int` (bytes used, 0 for more, -1 for refused); `wsCloseCode(const WsFrame&)`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_ws.cpp`:

```cpp
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
```

Create `relay/test/device-bytes.test.js`:

```js
// The S3 talks to the relay through its own WebSocket client (firmware/lib/proto/src/proto/ws.cpp), which only the device runs. These
// are the bytes that code is tested to produce and take in firmware/host/test_ws.cpp, sent over a plain socket, so a change on
// either side that the other would not survive fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startRelay } from '../src/server.js';

const ROOM = '00112233445566778899aabbccddeeff';
// wsRequest("walkie-relay.fly.dev", "/r/<ROOM>?role=device", "the sample nonce"), as test_ws.cpp has it.
const REQUEST =
  `GET /r/${ROOM}?role=device HTTP/1.1\r\n` +
  'Host: walkie-relay.fly.dev\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  '\r\n';
// The answer test_ws.cpp's wsResponse() takes.
const RESPONSE =
  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n';
const MASKED_HELLO = Buffer.from('828537fa213d7f9f4d5158', 'hex'); // wsEncode(WS_BINARY, "Hello", 37fa213d)
const EMPTY_PONG = Buffer.from('8a8037fa213d', 'hex'); // wsEncode(WS_PONG, nothing, 37fa213d): what the S3 answers the relay's ping with

async function device(t, port) {
  const sock = net.connect(port, '127.0.0.1');
  t.after(() => sock.destroy());
  const s = { sock, got: Buffer.alloc(0), closed: false };
  sock.on('data', (d) => {
    s.got = Buffer.concat([s.got, d]);
  });
  sock.on('close', () => {
    s.closed = true;
  });
  await new Promise((resolve) => sock.once('connect', resolve));
  return s;
}

async function pcPeer(t, port) {
  const pc = new WebSocket(`ws://127.0.0.1:${port}/r/${ROOM}?role=pc`);
  pc.binaryType = 'arraybuffer';
  t.after(() => pc.close());
  const messages = [];
  pc.addEventListener('message', (e) => messages.push(Buffer.from(e.data).toString('hex')));
  await new Promise((resolve) => pc.addEventListener('open', resolve));
  return { pc, messages };
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the S3's upgrade request is taken, and the answer is the one its parser is tested on", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  assert.equal(s.got.toString('latin1'), RESPONSE);
});

test("the S3's masked binary frame reaches the PC as the bytes it carried", async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const { messages } = await pcPeer(t, relay.port);
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  s.sock.write(MASKED_HELLO);
  await until(() => messages.length === 1);
  assert.deepEqual(messages, ['48656c6c6f']);
});

test("the relay's ping is an empty one the S3 decodes, and an S3 that answers it stays", async (t) => {
  const relay = await startRelay({ pingEveryMs: 100 });
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  s.got = Buffer.alloc(0);
  for (let i = 0; i < 4; i++) {
    await until(() => s.got.length >= 2);
    assert.equal(s.got.subarray(0, 2).toString('hex'), '8900', 'an empty ping, FIN, unmasked');
    s.got = s.got.subarray(2);
    s.sock.write(EMPTY_PONG);
  }
  assert.equal(s.closed, false, 'still connected after four pings');
});

test('an S3 that does not answer the ping is dropped', async (t) => {
  const relay = await startRelay({ pingEveryMs: 100 });
  t.after(() => relay.close());
  const s = await device(t, relay.port);
  s.sock.write(REQUEST);
  await until(() => s.got.includes('\r\n\r\n'));
  await until(() => s.closed, 2000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `proto/ws.h: No such file or directory`.

Run: `node --test relay/test/device-bytes.test.js`
Expected: PASS, 4 tests, 0 fail: this test pins code that already exists (see above), so the failing test of this task is the host one.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/ws.cpp`:

```cpp
#include "proto/ws.h"
#include <string.h>

namespace proto {
namespace {
const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 16 bytes as 24 base64 characters (the last two are padding).
void base64Key(const uint8_t* in, char* out) {
  size_t o = 0;
  for (size_t i = 0; i < WS_KEY_BYTES; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < WS_KEY_BYTES) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < WS_KEY_BYTES) v |= in[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = i + 1 < WS_KEY_BYTES ? B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < WS_KEY_BYTES ? B64[v & 63] : '=';
  }
}

bool printable(const char* s) {
  if (!s || !*s) return false;
  for (; *s; s++)
    if ((uint8_t)*s < 0x21 || (uint8_t)*s > 0x7e) return false;
  return true;
}

char lower(char c) { return c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c; }

// a[0..an) equals the NUL-terminated word, ignoring case.
bool same(const char* a, size_t an, const char* word) {
  size_t wn = strlen(word);
  if (an != wn) return false;
  for (size_t i = 0; i < an; i++)
    if (lower(a[i]) != word[i]) return false;
  return true;
}

void trim(const char*& p, size_t& n) {
  while (n && (*p == ' ' || *p == '\t')) p++, n--;
  while (n && (p[n - 1] == ' ' || p[n - 1] == '\t')) n--;
}

// A comma-separated header value has `word` as one of its tokens.
bool hasToken(const char* v, size_t n, const char* word) {
  size_t start = 0;
  for (size_t i = 0; i <= n; i++) {
    if (i == n || v[i] == ',') {
      const char* t = v + start;
      size_t tn = i - start;
      trim(t, tn);
      if (same(t, tn, word)) return true;
      start = i + 1;
    }
  }
  return false;
}
}  // namespace

size_t wsRequest(const char* host, const char* path, const uint8_t key[WS_KEY_BYTES], char* out, size_t cap) {
  if (!printable(host) || !printable(path) || path[0] != '/') return 0;
  char k[25];
  base64Key(key, k);
  k[24] = 0;
  const char* parts[] = {"GET ", path, " HTTP/1.1\r\nHost: ", host,
                         "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ", k,
                         "\r\nSec-WebSocket-Version: 13\r\n\r\n"};
  size_t n = 0;
  for (const char* p : parts) {
    size_t pn = strlen(p);
    if (n + pn + 1 > cap) return 0;
    memcpy(out + n, p, pn);
    n += pn;
  }
  out[n] = 0;
  return n;
}

int wsResponse(const uint8_t* buf, size_t n, size_t& headerLen, int& status) {
  status = 0;
  const char* s = (const char*)buf;
  size_t limit = n < WS_HTTP_MAX ? n : WS_HTTP_MAX;
  size_t end = 0;
  for (size_t i = 0; i + 4 <= limit; i++) {
    if (memcmp(s + i, "\r\n\r\n", 4) == 0) {
      end = i + 4;
      break;
    }
  }
  if (!end) return n >= WS_HTTP_MAX ? WS_HTTP_BAD : WS_HTTP_MORE;
  // The status line: HTTP/1.1, a space, three digits, then a space or the end of the line.
  if (end < 14 || memcmp(s, "HTTP/1.1 ", 9) != 0) return WS_HTTP_BAD;
  for (size_t i = 9; i < 12; i++)
    if (s[i] < '0' || s[i] > '9') return WS_HTTP_BAD;
  if (s[12] != ' ' && s[12] != '\r') return WS_HTTP_BAD;
  status = (s[9] - '0') * 100 + (s[10] - '0') * 10 + (s[11] - '0');
  bool upgrade = false, connection = false;
  size_t at = 0;
  while (memcmp(s + at, "\r\n", 2) != 0) at++;
  at += 2;
  while (at + 2 <= end - 2) {  // each header line, up to the blank line
    size_t eol = at;
    while (memcmp(s + eol, "\r\n", 2) != 0) eol++;
    const char* colon = (const char*)memchr(s + at, ':', eol - at);
    if (colon) {
      const char* name = s + at;
      size_t nn = (size_t)(colon - name);
      const char* v = colon + 1;
      size_t vn = (size_t)(s + eol - v);
      trim(v, vn);
      if (same(name, nn, "upgrade")) upgrade = same(v, vn, "websocket");
      if (same(name, nn, "connection")) connection = hasToken(v, vn, "upgrade");
    }
    at = eol + 2;
  }
  if (status != 101 || !upgrade || !connection) return WS_HTTP_BAD;
  headerLen = end;
  return WS_HTTP_OK;
}

size_t wsEncode(uint8_t opcode, const uint8_t* payload, size_t n, const uint8_t mask[4], uint8_t* out, size_t cap) {
  if (n > WS_MAX_PAYLOAD) return 0;
  size_t head = n < 126 ? 2 : 4;
  if (head + 4 + n > cap) return 0;
  out[0] = (uint8_t)(0x80 | (opcode & 0x0f));
  if (n < 126) {
    out[1] = (uint8_t)(0x80 | n);
  } else {
    out[1] = 0x80 | 126;
    out[2] = (uint8_t)(n >> 8);
    out[3] = (uint8_t)n;
  }
  memcpy(out + head, mask, 4);
  for (size_t i = 0; i < n; i++) out[head + 4 + i] = (uint8_t)(payload[i] ^ mask[i % 4]);
  return head + 4 + n;
}

int wsDecode(const uint8_t* buf, size_t n, WsFrame& f) {
  if (n < 2) return 0;
  uint8_t op = buf[0] & 0x0f;
  if (!(buf[0] & 0x80) || (buf[0] & 0x70) || (buf[1] & 0x80)) return -1;
  if (op != WS_BINARY && op != WS_CLOSE && op != WS_PING && op != WS_PONG) return -1;
  size_t len = buf[1] & 0x7f, head = 2;
  if (len == 127) return -1;
  if (len == 126) {
    if (n < 4) return 0;
    len = ((size_t)buf[2] << 8) | buf[3];
    head = 4;
  }
  if (len > WS_MAX_PAYLOAD || (op != WS_BINARY && len > WS_CONTROL_MAX)) return -1;
  if (n < head + len) return 0;
  f.opcode = op;
  f.payload = buf + head;
  f.n = len;
  return (int)(head + len);
}

uint16_t wsCloseCode(const WsFrame& f) { return f.n >= 2 ? (uint16_t)((f.payload[0] << 8) | f.payload[1]) : 1005; }
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/ws.h`:

```cpp
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
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `257 cases, 1475 checks passed, 0 failed`.

Run: `node --test relay/test/device-bytes.test.js`
Expected: PASS, 4 tests, 0 fail.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.1%, Flash 27.5%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 17, the relay's 17, and `257 cases, 1475 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add firmware/host/test_ws.cpp firmware/lib/proto/src/proto/ws.cpp firmware/lib/proto/src/proto/ws.h relay/test/device-bytes.test.js
git commit -m "Task 13: the S3's WebSocket client codec (upgrade request, 101 check, masked frames, ping/pong/close) and the relay taking its bytes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The S3 on the relay

This puts the pieces together on the device. `encodeEnvelope` writes the bare envelope a relay message carries, and `encodeFrame` is now COBS around it. The `Router` sits in front of the `Gate`: a frame from a transport that is neither, a PAIR that did not come on USB, and any frame but HELLO from the transport not in use are dropped before the gate sees them; a HELLO moves the `TransportSelector`; a delivered PING marks the S3 online. `usblink.cpp` receives from USB and from a ring that netlink fills, tags each frame it queues with its transport, and its TX task hands relay frames to netlink. `netlink.cpp` is a task of its own: while the S3 holds a key, a network and a host it joins Wi-Fi (10 s per network), opens TLS to the host on port 443 verified against `relay_roots.h`, upgrades to `/r/<room>?role=device`, answers pings, hands binary frames to usblink, backs off between attempts, hangs up a relay silent for 70 s, and chooses again when the settings change. `tools/gen-relay-roots.mjs` writes `relay_roots.h` from the local certifi bundle, `tools/check-relay-roots.mjs <host>` checks a host against it, and a tools test pins its two fingerprints. The device side is checked by compiling it; the host tests cover the `Router` and the envelope.

**Files:**
- Create: `firmware/lib/proto/src/proto/router.cpp`, `firmware/lib/proto/src/proto/router.h`, `firmware/src/netlink.cpp`, `firmware/src/netlink.h`, `firmware/src/relay_roots.h`, `tools/check-relay-roots.mjs`, `tools/gen-relay-roots.mjs`, `tools/lib/roots.mjs`
- Modify: `firmware/lib/proto/src/proto/frame.cpp`, `firmware/lib/proto/src/proto/frame.h`, `firmware/src/main.cpp`, `firmware/src/status.h`, `firmware/src/usblink.cpp`, `firmware/src/usblink.h`
- Test (new): `tools/test/roots.test.mjs`
- Test (changed): `firmware/host/test_codec.cpp`, `firmware/host/test_gate.cpp`

**Interfaces:**
- Consumes: `TransportSelector`, `Backoff` (Task 12), the `ws` codec (Task 13), `roomId` (Task 3), `netconf::snapshot` and `generation` (Task 10), the `Gate` (plan 5).
- Produces: `firmware/lib/proto/src/proto/frame.h`: `encodeEnvelope(type, flags, seq, payload, len, out, cap): size_t`.
- Produces: `firmware/lib/proto/src/proto/router.h`: `class Router(Gate&)` with `Gate::Rx receive(uint8_t transport, const Frame& in, Frame& out, uint32_t now)`, `selector()` (the `TransportSelector`) and `otherTransport()` (how many frames were dropped for coming on the transport not in use).
- Produces: `firmware/src/netlink.h`: `netlink::begin()`, `sendEnvelope(env, n)`, `wanted()`, `wifiUp()`, `relayUp()`.
- Produces: `firmware/src/usblink.h`: `online()`, `transport()`, `fromRelay(env, n)`, `relayConnected()`, `relayDown()`; `msSincePing()` is gone. `status.h`: `rxOther`, `relayLost`.
- Produces: `tools/lib/roots.mjs`: `RELAY_ROOT_LABELS`, `RELAY_ROOT_FINGERPRINTS`, `pickRoots(bundle)`, `rootsHeader(roots)`, `parseRootsHeader(text)`, `checkRelayRoots(host, ca, { port, timeoutMs }): Promise<{ ok, chain } | { ok: false, error }>`.

- [ ] **Step 1: Write the failing tests**

In `firmware/host/test_codec.cpp`, replace:

```cpp
  CHECK(proto::MAX_CHUNK == 1100, "MAX_CHUNK");
}
```

with:

```cpp
  CHECK(proto::MAX_CHUNK == 1100, "MAX_CHUNK");
}


// The relay carries the envelope alone (protocol/frames.md, "Relay"): the same bytes COBS carries on USB.
TEST(envelopesAreTheBytesCobsCarries) {
  static uint8_t env[proto::ENVELOPE_MAX];
  static uint8_t dec[proto::ENVELOPE_MAX + 8];
  for (const FrameVec& v : kFrames) {
    std::vector<uint8_t> p = unhex(v.payload);
    size_t n = proto::encodeEnvelope(v.type, v.flags, v.seq, p.data(), (uint16_t)p.size(), env, sizeof env);
    std::vector<uint8_t> w = unhex(v.wire);
    size_t m = proto::cobsDecode(w.data() + 1, w.size() - 2, dec, sizeof dec);
    CHECK(n == p.size() + 8 && n == m && memcmp(env, dec, n) == 0, v.name);
    proto::Frame f = proto::Frame();
    CHECK(proto::parseEnvelope(env, n, f) && f.type == v.type && f.flags == v.flags && f.seq == v.seq && tohex(f.payload, f.len) == v.payload,
          v.name);
  }
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, env, sizeof env) == 0, "payload over 1024");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD, env, sizeof env) == proto::ENVELOPE_MAX, "1024 is the largest");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, 16, env, 23) == 0, "a buffer one short");
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, 16, env, 24) == 24, "exactly enough");
  proto::Frame empty = proto::Frame();
  CHECK(proto::encodeEnvelope(0x11, 0, 0, nullptr, 0, env, 8) == 8 && proto::parseEnvelope(env, 8, empty) && empty.len == 0, "an empty payload");
}


TEST(envelopeOverTheLimitIsRefusedEvenWithRoomForIt) {
  static uint8_t big[proto::MAX_PAYLOAD + 1];
  static uint8_t roomy[proto::ENVELOPE_MAX + 64];
  CHECK(proto::encodeEnvelope(0x11, 0, 0, big, proto::MAX_PAYLOAD + 1, roomy, sizeof roomy) == 0,
        "1025 bytes is no frame (the S3 would refuse it), whatever the buffer");
}
```

In `firmware/host/test_gate.cpp`, replace:

```cpp
#include "proto/messages.h"
#include "ref_crypto.h"
```

with:

```cpp
#include "proto/messages.h"
#include "proto/router.h"
#include "ref_crypto.h"
```

In `firmware/host/test_gate.cpp`, replace:

```cpp
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == 2 && out[0] == 0x80 && out[1] == 1, "the PC opens it");
}
```

with:

```cpp
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == 2 && out[0] == 0x80 && out[1] == 1, "the PC opens it");
}


// The Router (proto/router.h): frames from the cable and from the relay into this one Gate (spec 5.3). The Rig above is the gate.
namespace {
std::vector<uint8_t> helloPayload(uint32_t nonceP) {
  return {1, (uint8_t)nonceP, (uint8_t)(nonceP >> 8), (uint8_t)(nonceP >> 16), (uint8_t)(nonceP >> 24)};
}
}  // namespace

TEST(routerAtBootTheCableIsHeardAsItAlwaysWas) {
  Rig r(false);
  proto::Router router(r.gate);
  CHECK(router.selector().active() == proto::TR_USB, "USB until a HELLO says otherwise");
  std::vector<uint8_t> p = {1, 0, 0, 0};
  proto::Frame out;
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 100) == Gate::Deliver, "a plain PING on USB, before any HELLO");
  CHECK(router.selector().online(100), "and it counts");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, 0, 2, p), out, 100) == Gate::Drop && router.otherTransport() == 1,
        "the same on the relay is dropped, and counted");
}

TEST(routerAHelloOnTheRelaySwitchesAndTheCableIsThenDropped) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 10) == Gate::Hello, "HELLO on the relay");
  CHECK(router.selector().active() == proto::TR_WSS && r.gate.helloNonce() == kP, "the relay is in use, with the session of that HELLO");
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  uint8_t flags = 0;
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 1, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 1, s), out, 20) == Gate::Drop, "the same sealed PING on USB is dropped");
  CHECK(router.otherTransport() == 1, "as from the transport not in use");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, flags, 1, s), out, 30) == Gate::Deliver && out.type == proto::T_PING,
        "and on the relay it opens: the drop on USB did not spend its counter");
  CHECK(router.selector().online(30) && router.selector().online(10029) && !router.selector().online(10030), "online, 10 s on the relay");
}

TEST(routerOnlyADeliveredPingMakesItOnline) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 5) == Gate::Drop, "a plain PING to a paired S3");
  CHECK(!router.selector().online(5), "is not online");
  uint8_t flags = 0;
  std::vector<uint8_t> cmd = r.sealed(proto::T_CMD, 2, std::vector<uint8_t>{1, 0}, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_CMD, flags, 2, cmd), out, 6) == Gate::Deliver && !router.selector().online(6),
        "nor is a sealed frame that is not a PING");
  std::vector<uint8_t> ping = r.sealed(proto::T_PING, 3, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 3, ping), out, 7) == Gate::Deliver && router.selector().online(7),
        "a sealed PING is");
}

TEST(routerPairingIsOnlyEverOverTheCable) {
  Rig r(false);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  std::vector<uint8_t> set = unhex(msgHexOf("pair_set"));
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PAIR, 0, 1, set), out, 1) == Gate::Drop, "a PAIR on the relay, the transport in use");
  CHECK(router.selector().active() == proto::TR_WSS, "changes nothing");
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 2);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PAIR, 0, 1, set), out, 3) == Gate::Pair, "over the cable it is a PAIR");
}

TEST(routerAHelloTheGateRefusesSwitchesNothing) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> shortHello = {1, 2};
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, shortHello), out, 0) == Gate::Drop, "too short to carry a nonce");
  CHECK(router.selector().active() == proto::TR_USB && router.selector().switches() == 0, "still the cable");
}

TEST(routerAFrameFromNoTransportNeverReachesTheGate) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  uint32_t nonceS = r.gate.nonceS();
  std::vector<uint8_t> other = helloPayload(kP + 1);
  CHECK(router.receive(proto::TR_NONE, r.frame(proto::T_HELLO, 0, 0, other), out, 1) == Gate::Drop, "TR_NONE");
  CHECK(router.receive(9, r.frame(proto::T_HELLO, 0, 0, other), out, 1) == Gate::Drop, "a transport that does not exist");
  CHECK(r.gate.helloNonce() == kP && r.gate.nonceS() == nonceS, "the session is the one the cable's HELLO began");
}

TEST(routerWhenTheRelayGoesAwayNothingIsTakenUntilTheNextHello) {
  Rig r(false);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  std::vector<uint8_t> p = {1, 0, 0, 0};
  router.receive(proto::TR_WSS, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  router.selector().onDown(proto::TR_WSS);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 1, p), out, 1) == Gate::Drop, "not the cable");
  CHECK(router.receive(proto::TR_WSS, r.frame(proto::T_PING, 0, 2, p), out, 1) == Gate::Drop, "not the relay");
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 2) == Gate::Hello &&
            router.receive(proto::TR_USB, r.frame(proto::T_PING, 0, 3, p), out, 3) == Gate::Deliver,
        "a HELLO on the cable brings it back");
}


TEST(routerOrdinaryFramesOnTheTransportInUseChangeNothingAboutIt) {
  Rig r(true);
  proto::Router router(r.gate);
  proto::Frame out;
  std::vector<uint8_t> h = helloPayload(kP);
  router.receive(proto::TR_USB, r.frame(proto::T_HELLO, 0, 0, h), out, 0);
  r.pcBegin();
  uint8_t flags = 0;
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> ping = r.sealed(proto::T_PING, 1, p, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_PING, flags, 1, ping), out, 5) == Gate::Deliver && router.selector().online(5),
        "online after a sealed PING");
  uint32_t switches = router.selector().switches();
  std::vector<uint8_t> cmd = r.sealed(proto::T_CMD, 2, std::vector<uint8_t>{1, 0}, &flags);
  CHECK(router.receive(proto::TR_USB, r.frame(proto::T_CMD, flags, 2, cmd), out, 6) == Gate::Deliver, "a sealed CMD on USB");
  CHECK(router.selector().online(6), "leaves it online: only a HELLO starts the transport over");
  CHECK(router.selector().switches() == switches && router.selector().active() == proto::TR_USB, "and is no switch");
}
```

Create `tools/test/roots.test.mjs`:

```js
// The roots the S3 trusts for the relay: the committed header holds exactly the two pinned ones, and the picker refuses a bundle that
// does not give them as they should be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_ROOT_FINGERPRINTS, RELAY_ROOT_LABELS, parseRootsHeader, pickRoots, rootsHeader } from '../lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const header = readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8');
const pems = parseRootsHeader(header);
const bundleOf = (entries) => entries.map(([label, pem]) => `\n# Issuer: x\n# Label: "${label}"\n# Serial: 1\n${pem}`).join('');

test('relay_roots.h holds ISRG Root X1 and X2, and nothing else', () => {
  assert.equal(pems.length, 2);
  const certs = pems.map((p) => new X509Certificate(p));
  assert.deepEqual(
    certs.map((c) => c.fingerprint256),
    RELAY_ROOT_LABELS.map((l) => RELAY_ROOT_FINGERPRINTS[l]),
  );
  for (const c of certs) assert.ok(c.ca && c.subject === c.issuer, 'self-signed CAs');
  assert.match(header, /static const char RELAY_ROOTS_PEM\[\] =/);
  assert.match(header, /\\n";\r?\n$/, 'one C string, ended'); // a checkout with core.autocrlf has CRLF
});

test('the header is what the generator writes from those two', () => {
  const roots = pickRoots(bundleOf(RELAY_ROOT_LABELS.map((l, i) => [l, pems[i]])));
  assert.equal(rootsHeader(roots), header.replace(/\r\n/g, '\n'));
});

test('the picker takes them in the order asked, from a bundle with CRLF line ends', () => {
  const bundle = bundleOf([['Other', pems[0]], ['ISRG Root X2', pems[1]], ['ISRG Root X1', pems[0]]]).replace(/\n/g, '\r\n');
  assert.deepEqual(
    pickRoots(bundle).map((r) => r.label),
    ['ISRG Root X1', 'ISRG Root X2'],
  );
});

test('a missing root, or one whose fingerprint is not the pinned one, is refused', () => {
  assert.throws(() => pickRoots(bundleOf([['ISRG Root X1', pems[0]]])), /no "ISRG Root X2"/);
  assert.throws(() => pickRoots(bundleOf([['ISRG Root X1', pems[1]], ['ISRG Root X2', pems[1]]])), /ISRG Root X1" has fingerprint/);
  assert.throws(() => pickRoots('# Label: "ISRG Root X1"\nno pem here\n'), /no certificate after/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `'encodeEnvelope' is not a member of 'proto'`, `proto/router.h: No such file or directory`.

Run: `node --test tools/test/roots.test.mjs`
Expected: FAIL, the file `tools/test/roots.test.mjs` cannot load, because it imports `tools/lib/roots.mjs`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

In `firmware/lib/proto/src/proto/frame.cpp`, replace:

```cpp

size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
```

with:

```cpp

size_t encodeEnvelope(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out, size_t cap) {
  if (len > MAX_PAYLOAD || cap < (size_t)len + 8) return 0;
  out[0] = type;
  out[1] = flags;
  put16(out + 2, seq);
  put16(out + 4, len);
  if (len) memcpy(out + 6, payload, len);
  put16(out + 6 + len, crc16(out, 6 + (size_t)len));
  return (size_t)len + 8;
}

size_t encodeFrame(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out,
```

In `firmware/lib/proto/src/proto/frame.cpp`, replace:

```cpp
  uint8_t env[ENVELOPE_MAX];
  env[0] = type;
  env[1] = flags;
  put16(env + 2, seq);
  put16(env + 4, len);
  if (len) memcpy(env + 6, payload, len);
  put16(env + 6 + len, crc16(env, 6 + (size_t)len));
  out[0] = 0;
```

with:

```cpp
  uint8_t env[ENVELOPE_MAX];
  encodeEnvelope(type, flags, seq, payload, len, env, sizeof env);
  out[0] = 0;
```

In `firmware/lib/proto/src/proto/frame.h`, replace:

```cpp
                   size_t cap);
// Checks a decoded envelope; on success fills f, whose payload points into env.
```

with:

```cpp
                   size_t cap);
// Writes the envelope alone (what COBS carries on USB, and one relay message carries): type, flags, seq, len, payload, CRC-16.
// Returns its length, len + 8, or 0 if len > MAX_PAYLOAD or cap is too small.
size_t encodeEnvelope(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, uint16_t len, uint8_t* out, size_t cap);
// Checks a decoded envelope; on success fills f, whose payload points into env.
```

Create `firmware/lib/proto/src/proto/router.cpp`:

```cpp
#include "proto/router.h"

namespace proto {
Router::Router(Gate& gate) : gate_(gate), sel_(), other_(0) { sel_.onFrame(TR_USB, true, false, 0); }

Gate::Rx Router::receive(uint8_t transport, const Frame& in, Frame& out, uint32_t now) {
  if (transport != TR_USB && transport != TR_WSS) return Gate::Drop;
  if (in.type == T_PAIR && transport != TR_USB) return Gate::Drop;
  bool hello = in.type == T_HELLO;
  if (!hello && !sel_.onFrame(transport, false, false, now)) {
    other_++;
    return Gate::Drop;
  }
  Gate::Rx rx = gate_.receive(in, out);
  if (rx == Gate::Hello) sel_.onFrame(transport, true, false, now);
  if (rx == Gate::Deliver && out.type == T_PING) sel_.onFrame(transport, false, true, now);
  return rx;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/router.h`:

```cpp
// router.h: frames from the cable and from the relay into one Gate (spec 5.3). The S3 takes frames from the transport where it last
// saw a HELLO and drops what still comes on the other; it takes PAIR only from the cable, so a pairing key is never set or replaced
// from the network; and a PING the gate delivers is what makes it online. At boot the cable is the one in use, as it always was.
//
// Not thread safe: usblink.cpp calls it under the same lock as the Gate.
#pragma once
#include <stdint.h>
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/netstate.h"

namespace proto {
class Router {
 public:
  explicit Router(Gate& gate);
  // Gate::receive() for a frame that came on `transport`, or Drop without asking the gate: a frame other than HELLO from the
  // transport not in use, a PAIR that did not come on USB, anything from a transport that is neither.
  Gate::Rx receive(uint8_t transport, const Frame& in, Frame& out, uint32_t now);

  TransportSelector& selector() { return sel_; }
  const TransportSelector& selector() const { return sel_; }
  uint32_t otherTransport() const { return other_; }  // frames dropped because they came on the transport not in use

 private:
  Gate& gate_;
  TransportSelector sel_;
  uint32_t other_;
};
}  // namespace proto
```

In `firmware/src/main.cpp`, replace:

```cpp
#include "netconf_nvs.h"
#include "proto/frame.h"
```

with:

```cpp
#include "netconf_nvs.h"
#include "netlink.h"
#include "proto/frame.h"
```

In `firmware/src/main.cpp`, replace:

```cpp
  usblink::begin(h);
  if (!audioOk) usblink::logf("no PSRAM for the playback ring: replies cannot play");
```

with:

```cpp
  usblink::begin(h);
  netlink::begin();  // after the link: it reports through it, and hands it what the relay sends
  if (!audioOk) usblink::logf("no PSRAM for the playback ring: replies cannot play");
```

In `firmware/src/main.cpp`, replace:

```cpp
  bool side = M5.BtnB.isPressed() || (scripted & proto::KEY_SIDE);
  machine.tick(now, usblink::msSincePing() < 3000, audio::replyBusy());
  ui::Events ev = gesture.update(now, front, side);
```

with:

```cpp
  bool side = M5.BtnB.isPressed() || (scripted & proto::KEY_SIDE);
  machine.tick(now, usblink::online(), audio::replyBusy());
  ui::Events ev = gesture.update(now, front, side);
```

Create `firmware/src/netlink.cpp`:

```cpp
// netlink.cpp: see netlink.h. Only the device runs this file; what it decides is in proto/netstate.h and proto/ws.h, which the host
// tests run.
#include "netlink.h"
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <atomic>
#include <esp_random.h>
#include <string.h>
#include "crypto_mbedtls.h"
#include "keystore_nvs.h"
#include "netconf_nvs.h"
#include "proto/netstate.h"
#include "proto/room.h"
#include "proto/ws.h"
#include "relay_roots.h"
#include "usblink.h"

namespace netlink {
namespace {
const uint32_t JOIN_MS = 10000;     // per network
const uint32_t ANSWER_MS = 10000;   // for the relay's 101
const int32_t CONNECT_MS = 10000;   // TCP and TLS
const uint32_t SILENT_MS = 70000;   // the relay pings every 30 s; nothing at all for this long means the path is gone
const uint32_t STACK = 12288;       // the TLS handshake runs on this task
std::atomic<bool> g_wanted{false}, g_wifi{false}, g_relay{false};
SemaphoreHandle_t sockLock = nullptr;  // the read side (this task) and the write side (usblink's TX task) take turns
WiFiClientSecure client;
proto::Backoff backoff;
uint8_t rx[2 * (4 + proto::WS_MAX_PAYLOAD)];  // this task only
size_t rxLen = 0;

void wifiOff() {
  if (WiFi.getMode() != WIFI_OFF) {
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
  }
  g_wifi = false;
}

void hangUp() {
  xSemaphoreTake(sockLock, portMAX_DELAY);
  bool was = g_relay.exchange(false);
  client.stop();
  xSemaphoreGive(sockLock);
  rxLen = 0;
  if (was) usblink::relayDown();
}

bool joinAny(const netconf::Snapshot& s) {
  WiFi.mode(WIFI_STA);
  for (uint8_t i = 0; i < s.count; i++) {
    WiFi.begin(s.nets[i].ssid, s.nets[i].pass[0] ? s.nets[i].pass : nullptr);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < JOIN_MS) vTaskDelay(pdMS_TO_TICKS(100));
    if (WiFi.status() == WL_CONNECTED) {
      usblink::logf("wifi: joined %s", s.nets[i].ssid);  // never the password
      return true;
    }
    WiFi.disconnect();
  }
  return false;
}

// Writes one client frame; the caller holds sockLock.
bool writeFrame(uint8_t opcode, const uint8_t* payload, size_t n) {
  static uint8_t out[8 + proto::WS_MAX_PAYLOAD];  // under sockLock
  uint8_t mask[4];
  esp_fill_random(mask, sizeof mask);
  size_t m = proto::wsEncode(opcode, payload, n, mask, out, sizeof out);
  return m && client.write(out, m) == m;
}

// TLS to the relay, verified against the pinned roots, then the upgrade to /r/<room>?role=device.
bool dial(const char* host) {
  uint8_t master[proto::KEY_BYTES], id[proto::ROOM_BYTES];
  char roomHex[proto::ROOM_HEX_BYTES];
  bool haveKey = nvsKeyStore().load(master) && proto::roomId(mbedtlsCrypto(), master, id);
  memset(master, 0, sizeof master);
  if (!haveKey) return false;
  proto::roomIdHex(id, roomHex);
  char path[64];
  snprintf(path, sizeof path, "/r/%s?role=device", roomHex);
  uint8_t key[proto::WS_KEY_BYTES];
  esp_fill_random(key, sizeof key);
  char request[256];
  size_t n = proto::wsRequest(host, path, key, request, sizeof request);
  if (!n) return false;

  xSemaphoreTake(sockLock, portMAX_DELAY);
  client.setCACert(RELAY_ROOTS_PEM);
  bool ok = client.connect(host, 443, CONNECT_MS) && client.write((const uint8_t*)request, n) == n;
  xSemaphoreGive(sockLock);
  if (!ok) {
    usblink::logf("relay: no TLS connection to %s", host);
    hangUp();
    return false;
  }
  rxLen = 0;
  uint32_t start = millis();
  for (;;) {
    xSemaphoreTake(sockLock, portMAX_DELAY);
    int got = client.available() > 0 ? client.read(rx + rxLen, sizeof rx - rxLen) : 0;
    bool open = client.connected();
    xSemaphoreGive(sockLock);
    if (got > 0) rxLen += (size_t)got;
    size_t headerLen = 0;
    int status = 0;
    int r = proto::wsResponse(rx, rxLen, headerLen, status);
    if (r == proto::WS_HTTP_OK) {
      memmove(rx, rx + headerLen, rxLen - headerLen);  // frames that came in the same read
      rxLen -= headerLen;
      return true;
    }
    if (r == proto::WS_HTTP_BAD || !open || millis() - start > ANSWER_MS || rxLen == sizeof rx) {
      usblink::logf("relay: refused the upgrade (HTTP %d)", status);
      hangUp();
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// Takes frames until the connection ends, Wi-Fi goes, or the settings change.
void pump(uint32_t generation) {
  uint32_t heard = millis();
  for (;;) {
    xSemaphoreTake(sockLock, portMAX_DELAY);
    int got = client.available() > 0 ? client.read(rx + rxLen, sizeof rx - rxLen) : 0;
    bool open = client.connected();
    xSemaphoreGive(sockLock);
    if (got > 0) {
      rxLen += (size_t)got;
      heard = millis();
    }
    for (;;) {
      proto::WsFrame f;
      int k = proto::wsDecode(rx, rxLen, f);
      if (k == 0) break;
      if (k < 0) {
        usblink::logf("relay: a frame walkie does not take; closing");
        return;
      }
      if (f.opcode == proto::WS_BINARY) {
        usblink::fromRelay(f.payload, f.n);
      } else if (f.opcode == proto::WS_PING) {
        xSemaphoreTake(sockLock, portMAX_DELAY);
        writeFrame(proto::WS_PONG, f.payload, f.n);
        xSemaphoreGive(sockLock);
      } else if (f.opcode == proto::WS_CLOSE) {
        usblink::logf("relay: closed (%u)", (unsigned)proto::wsCloseCode(f));  // 4000: another walkie with this key took the room
        return;
      }
      memmove(rx, rx + k, rxLen - (size_t)k);
      rxLen -= (size_t)k;
    }
    if (millis() - heard > SILENT_MS) {
      usblink::logf("relay: nothing for %u s; closing", (unsigned)(SILENT_MS / 1000));
      return;
    }
    if (!open || WiFi.status() != WL_CONNECTED || netconf::generation() != generation) return;
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void task(void*) {
  static netconf::Snapshot s;
  uint32_t joinedFor = 0;  // the settings generation the current Wi-Fi was joined under
  for (;;) {
    netconf::snapshot(s);
    if (WiFi.status() == WL_CONNECTED && s.generation != joinedFor) wifiOff();  // a network removed or added: choose again
    uint8_t key[proto::KEY_BYTES];
    bool paired = nvsKeyStore().load(key);
    memset(key, 0, sizeof key);
    bool want = paired && s.count > 0 && s.host[0];
    g_wanted = want;
    if (!want) {
      wifiOff();
      backoff.reset();
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }
    if (WiFi.status() != WL_CONNECTED) {
      g_wifi = false;
      if (!joinAny(s)) {
        vTaskDelay(pdMS_TO_TICKS(backoff.next()));
        continue;
      }
      joinedFor = s.generation;
    }
    g_wifi = true;
    if (!dial(s.host)) {
      vTaskDelay(pdMS_TO_TICKS(backoff.next()));
      continue;
    }
    backoff.reset();
    g_relay = true;
    usblink::logf("relay: connected to %s", s.host);
    usblink::relayConnected();  // HELLO on the relay, so that a PC already waiting there starts a session
    pump(s.generation);
    hangUp();
  }
}
}  // namespace

void begin() {
  sockLock = xSemaphoreCreateMutex();
  WiFi.persistent(false);  // the networks are netconf's, never the Wi-Fi library's own flash
  WiFi.mode(WIFI_OFF);
  xTaskCreatePinnedToCore(task, "netlink", STACK, nullptr, 2, nullptr, 0);
}

bool sendEnvelope(const uint8_t* env, size_t n) {
  if (!sockLock || !g_relay) return false;
  xSemaphoreTake(sockLock, portMAX_DELAY);
  bool ok = g_relay && writeFrame(proto::WS_BINARY, env, n);
  xSemaphoreGive(sockLock);
  return ok;
}

bool wanted() { return g_wanted; }
bool wifiUp() { return g_wifi; }
bool relayUp() { return g_relay; }
}  // namespace netlink
```

Create `firmware/src/netlink.h`:

```cpp
// netlink.h: the S3's way to the PC away from the cable (spec 5.2): Wi-Fi, then a WebSocket over TLS to the relay, in its own task.
// It runs only while the S3 holds a pairing key, a network and a relay host (netconf); otherwise Wi-Fi is off. Frames from the relay go
// to usblink, which takes them as it takes the cable's; usblink's TX task hands it the frames to send while the relay is in use.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace netlink {
void begin();
// One link frame's envelope (protocol/frames.md, "Relay") as one binary message. False when the relay is not connected or the
// write failed; the frame is then lost, as on a cable nobody reads.
bool sendEnvelope(const uint8_t* env, size_t n);

bool wanted();   // paired, with a network and a relay host set
bool wifiUp();   // joined one of the networks
bool relayUp();  // the WebSocket to the relay is open
}  // namespace netlink
```

Create `firmware/src/relay_roots.h`:

```cpp
// relay_roots.h: the roots the S3 trusts for the relay (spec 5.2: verified against a root bundle, no insecure mode).
// Generated by tools/gen-relay-roots.mjs from a local CA bundle; tools/check-relay-roots.mjs <host> tries them against a relay.
// *.fly.dev chains to ISRG Root X1 through X2 today (checked 2026-10-03). Let's Encrypt's newer roots are not here: if it
// stops sending the cross-signed chain, the S3 says RELAY_DOWN until this file has the root it ends in.
#pragma once

static const char RELAY_ROOTS_PEM[] =
    // ISRG Root X1, SHA-256 96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6, until 2035-06-04
    "-----BEGIN CERTIFICATE-----\n"
    "MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n"
    "TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n"
    "cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n"
    "WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n"
    "ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n"
    "MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n"
    "h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n"
    "0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n"
    "A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n"
    "T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n"
    "B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n"
    "B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n"
    "KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n"
    "OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n"
    "jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n"
    "qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\n"
    "rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n"
    "HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n"
    "hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n"
    "ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n"
    "3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n"
    "NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n"
    "ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n"
    "TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n"
    "jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n"
    "oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n"
    "4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n"
    "mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n"
    "emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n"
    "-----END CERTIFICATE-----\n"
    // ISRG Root X2, SHA-256 69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70, until 2040-09-17
    "-----BEGIN CERTIFICATE-----\n"
    "MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw\n"
    "CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg\n"
    "R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00\n"
    "MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT\n"
    "ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw\n"
    "EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW\n"
    "+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9\n"
    "ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T\n"
    "AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI\n"
    "zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW\n"
    "tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1\n"
    "/q4AaOeMSQ+2b1tbFfLn\n"
    "-----END CERTIFICATE-----\n";
```

Replace the whole of `firmware/src/status.h` with:

```cpp
// status.h: counters and settings shared between tasks; the screen shows them.
#pragma once
#include <atomic>
#include <stdint.h>

struct Status {
  std::atomic<uint32_t> rxBad{0};      // bad chunks from the PC
  std::atomic<uint32_t> rxGaps{0};     // gaps in the PC's seq since its last HELLO
  std::atomic<uint32_t> txDropped{0};  // frames the TX queue had no room for, or that a paired S3 had no session to seal with
  std::atomic<uint32_t> rxRefused{0};  // frames refused for being plain when sealed was required, or for failing their tag or counter
  std::atomic<uint32_t> rxOther{0};    // frames from the transport not in use (spec 5.3)
  std::atomic<uint32_t> relayLost{0};  // frames from the relay there was no room for
  std::atomic<uint8_t> volume{255};    // speaker volume (spec D9)
  std::atomic<uint8_t> micGain{2};     // mic magnification (spec §6.2)
  std::atomic<uint32_t> takes{0};
  std::atomic<uint32_t> lastTakeMs{0};
  std::atomic<bool> playing{false};
  std::atomic<uint32_t> ringFill{0};
  std::atomic<uint32_t> underruns{0};
  std::atomic<uint8_t> micLevel{0};    // peak of the last 20 ms of a take, 0 to 255 of full scale
};

extern Status g_status;
```

Replace the whole of `firmware/src/usblink.cpp` with:

```cpp
// usblink.cpp: see usblink.h.
#include "usblink.h"
#include <Arduino.h>
#include <atomic>
#include <freertos/ringbuf.h>
#include <stdarg.h>
#include <stdio.h>
#include <esp_system.h>
#include "crypto_mbedtls.h"
#include "keystore_nvs.h"
#include "netconf_nvs.h"
#include "netlink.h"
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/messages.h"
#include "proto/router.h"
#include "status.h"
#include "version.h"

namespace usblink {
namespace {
const size_t RX_QUEUE = 16384;  // the USB driver drops bytes beyond this; credit keeps audio below it
const size_t TX_RING = 32768;   // frames waiting to go: each item is a TX_* byte, then the COBS wire (USB) or the envelope (relay)
const size_t RELAY_RX = 8192;   // envelopes from the relay waiting for the RX task
const size_t RX_READ = 1024;
const uint32_t RX_STACK = 8192;  // 6144 before the gate: it opens frames and derives keys on this task
const uint32_t TX_STACK = 8192;  // 4096 before the relay: a TLS write runs on this task
enum : uint8_t { TX_USB = 1, TX_RELAY = 2 };
Handlers handlers;
RingbufHandle_t txRing = nullptr;
RingbufHandle_t relayRx = nullptr;
SemaphoreHandle_t txLock = nullptr;
uint16_t txSeq = 0;               // under txLock
proto::FrameDecoder decoder;      // RX task only
bool haveRxSeq = false;           // RX task only
uint16_t rxSeq = 0;               // RX task only
proto::Gate gate;                 // sealing and pairing; the RX task and txLock take turns (see gate.h)
proto::Router router(gate);       // which of USB and the relay is in use (spec 5.3); under txLock, as the gate is
std::atomic<int> pairAnswerPending{0};  // 0 nothing, 1 yes, 2 no: from the key press to the RX task

uint32_t randomNonce() { return esp_random(); }

// Queues one frame for `transport` (proto::TR_*, or ACTIVE: the one in use, read under the same lock): the relay gets the bare
// envelope, anything else the COBS wire on USB.
const uint8_t ACTIVE = 0xff;
bool sendVia(uint8_t transport, uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  static uint8_t item[1 + proto::MAX_WIRE];  // under txLock
  if (!txRing) return false;
  xSemaphoreTake(txLock, portMAX_DELAY);
  proto::Gate::Wire w;
  uint16_t seq = txSeq;
  bool ok = false;
  if (transport == ACTIVE) transport = router.selector().active();
  if (gate.wrap(type, flags, seq, payload, len, w) != proto::Gate::Blocked) {
    txSeq++;
    bool relay = transport == proto::TR_WSS;
    item[0] = relay ? TX_RELAY : TX_USB;
    size_t n = relay ? proto::encodeEnvelope(type, w.flags, seq, w.payload, w.len, item + 1, sizeof item - 1)
                     : proto::encodeFrame(type, w.flags, seq, w.payload, w.len, item + 1, sizeof item - 1);
    ok = n > 0 && xRingbufferSend(txRing, item, n + 1, 0) == pdTRUE;
  }
  xSemaphoreGive(txLock);
  if (!ok) g_status.txDropped++;
  return ok;
}

uint8_t activeTransport() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  uint8_t t = router.selector().active();
  xSemaphoreGive(txLock);
  return t;
}

// nonce: the one from the bridge's HELLO being answered, or 0 at boot. The S3's half of the session numbers and the flags come
// from the gate; read under the lock, since the RX task changes them at a HELLO. It goes on `transport`: an answer goes where the
// HELLO came from, which the router has just made the one in use.
void sayHello(uint32_t nonce, uint8_t transport) {
  uint8_t p[56];
  xSemaphoreTake(txLock, portMAX_DELAY);
  uint32_t nonceS = nonce ? gate.nonceS() : 0;
  uint8_t flags = gate.helloFlags();
  xSemaphoreGive(txLock);
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, nonceS, flags, WALKIE_VERSION, p, sizeof p);
  sendVia(transport, proto::T_HELLO, 0, p, (uint16_t)n);
}

void sendPairReply(const proto::Gate::PairReply& r) {
  uint8_t p[2];
  size_t n = proto::buildPairReply(r.op, r.answered, p, sizeof p);
  if (n) send(proto::T_PAIR, 0, p, (uint16_t)n);
}

void onPair(const proto::Frame& f) {
  uint8_t op = 0;
  xSemaphoreTake(txLock, portMAX_DELAY);
  proto::Gate::PairAction a = gate.onPair(f.payload, f.len, op);
  proto::Gate::PairReply denied = a == proto::Gate::PairAsk && !handlers.onPairRequest ? gate.answer(false) : proto::Gate::PairReply();
  xSemaphoreGive(txLock);
  if (a == proto::Gate::PairReplyOk) {
    proto::Gate::PairReply ok = {true, proto::PAIR_OK, op};
    sendPairReply(ok);
  } else if (denied.send) {
    sendPairReply(denied);
  } else if (a == proto::Gate::PairAsk) {
    handlers.onPairRequest(op);
  }
}

// NET (protocol/frames.md, "Network settings (plan 6)") counts only over a sealed link: a Wi-Fi password never travels in the
// clear, and nobody without the pairing key can set the networks or the relay. A request that is not sealed, or is not one, is refused.
void onNet(const proto::Frame& f, bool sealed) {
  proto::NetMsg m;
  if (!sealed || !proto::parseNet(f.payload, f.len, m)) {
    g_status.rxRefused++;
    return;
  }
  uint8_t p[200];  // the longest reply is a LIST: 2 + 4 x 33 + 1 + 63 = 198
  size_t n = netconf::handle(m, p, sizeof p);
  if (n) send(proto::T_NET, 0, p, (uint16_t)n);
}

void onFrame(const proto::Frame& raw, uint8_t transport) {
  proto::Frame f;
  xSemaphoreTake(txLock, portMAX_DELAY);  // a HELLO, or the eighth refusal, changes the session that send() seals with
  uint32_t other = router.otherTransport();
  proto::Gate::Rx rx = router.receive(transport, raw, f, millis());
  bool fromOther = router.otherTransport() != other;
  uint32_t nonce = gate.helloNonce();
  bool sealed = gate.lastSealed();
  xSemaphoreGive(txLock);
  if (rx == proto::Gate::Drop) {
    if (fromOther) g_status.rxOther++;
    else g_status.rxRefused++;
    return;
  }
  if (rx == proto::Gate::Pair) {
    onPair(f);
    return;
  }
  if (rx == proto::Gate::Hello) {
    haveRxSeq = true;
    rxSeq = f.seq;
    g_status.rxGaps = 0;
    if (handlers.onHello) handlers.onHello();
    sayHello(nonce, transport);
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
      uint8_t p[16];
      size_t n = proto::buildPong(token, now, decoder.bad(), g_status.rxGaps, p, sizeof p);
      send(proto::T_PONG, 0, p, (uint16_t)n);
      return;
    }
    case proto::T_NET:
      onNet(f, sealed);
      return;
    case proto::T_AUDIO_DOWN:
      if (handlers.onAudioDown) handlers.onAudioDown(f.payload, f.len, f.flags);
      return;
    case proto::T_CMD: {
      proto::Command c;
      if (proto::parseCmd(f.payload, f.len, c) && handlers.onCommand) handlers.onCommand(c.op, c.arg);
      return;
    }
    case proto::T_UI:
      if (handlers.onUi) handlers.onUi(f.payload, f.len);
      return;
    case proto::T_APPROVAL_REQ:
      if (handlers.onApprovalReq) handlers.onApprovalReq(f.payload, f.len);
      return;
    case proto::T_TEST: {
      proto::TestOp t;
      if (proto::parseTest(f.payload, f.len, t) && handlers.onTest) handlers.onTest(t.op, t.args, t.len);
      return;
    }
    default:
      return;
  }
}

void onUsbFrame(const proto::Frame& f) { onFrame(f, proto::TR_USB); }

void rxTask(void*) {
  static uint8_t buf[RX_READ];
  for (;;) {
    int avail = Serial.available();
    if (avail > 0) {
      size_t n = Serial.read(buf, (size_t)avail < RX_READ ? (size_t)avail : RX_READ);
      if (n <= RX_READ) decoder.push(buf, n, onUsbFrame);
      g_status.rxBad = decoder.bad();
    }
    size_t en = 0;
    uint8_t* env;
    while ((env = (uint8_t*)xRingbufferReceive(relayRx, &en, 0)) != nullptr) {
      proto::Frame f = proto::Frame();
      if (proto::parseEnvelope(env, en, f)) onFrame(f, proto::TR_WSS);
      else g_status.rxBad++;
      vRingbufferReturnItem(relayRx, env);
    }
    int answer = pairAnswerPending.exchange(0);
    if (answer != 0) {
      xSemaphoreTake(txLock, portMAX_DELAY);
      proto::Gate::PairReply r = gate.answer(answer == 1);
      xSemaphoreGive(txLock);
      if (r.send) sendPairReply(r);
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
    if (n > 1 && item[0] == TX_RELAY) {
      if (!netlink::sendEnvelope(item + 1, n - 1)) g_status.txDropped++;  // the relay went away under it
    } else {
      for (size_t off = 1; off < n;) {
        size_t w = Serial.write(item + off, n - off);
        if (w == 0) break;  // nobody is reading the port: the rest of this frame is lost
        off += w;
      }
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
  relayRx = xRingbufferCreate(RELAY_RX, RINGBUF_TYPE_NOSPLIT);
  txLock = xSemaphoreCreateMutex();
  gate.begin(mbedtlsCrypto(), nvsKeyStore(), randomNonce);
  gate.setAdpcm(true);  // HELLO says this S3 takes ADPCM
  xTaskCreatePinnedToCore(txTask, "linkTx", TX_STACK, nullptr, 4, nullptr, 0);
  // Tells a bridge that is already connected that walkie has (re)started. It is queued before the RX task exists, so no
  // answer to a HELLO that is already waiting in the USB FIFO, and no CREDIT, can go out ahead of it.
  sayHello(0, proto::TR_USB);
  xTaskCreatePinnedToCore(rxTask, "linkRx", RX_STACK, nullptr, 5, nullptr, 0);
}

bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  return sendVia(ACTIVE, type, flags, payload, len);
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

void pairAnswer(bool yes) { pairAnswerPending = yes ? 1 : 2; }

bool online() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  bool on = router.selector().online(millis());
  xSemaphoreGive(txLock);
  return on;
}

uint8_t transport() { return activeTransport(); }

void fromRelay(const uint8_t* env, size_t n) {
  if (!relayRx || xRingbufferSend(relayRx, env, n, 0) != pdTRUE) g_status.relayLost++;
}

void relayConnected() { sayHello(0, proto::TR_WSS); }

void relayDown() {
  xSemaphoreTake(txLock, portMAX_DELAY);
  router.selector().onDown(proto::TR_WSS);
  xSemaphoreGive(txLock);
}
}  // namespace usblink
```

Replace the whole of `firmware/src/usblink.h` with:

```cpp
// usblink.h: the S3's end of the link (protocol/frames.md), on USB and, through netlink, on the relay (spec 5.3). The RX task decodes
// frames from both and dispatches them; the TX task is the only writer to USB, and hands frames for the relay to netlink. Frames go
// on the transport where the last HELLO came from (proto/router.h).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace usblink {
// Called from the RX task. Any of them may be null.
struct Handlers {
  void (*onHello)();                                        // the bridge (re)connected
  void (*onAudioDown)(const uint8_t* payload, size_t len, uint8_t flags);
  void (*onCommand)(uint8_t op, uint8_t arg);
  void (*onTest)(uint8_t op, const uint8_t* args, size_t len);
  void (*onUi)(const uint8_t* payload, size_t len);           // UI: valid only during the call
  void (*onApprovalReq)(const uint8_t* payload, size_t len);  // APPROVAL_REQ: likewise
  void (*onPairRequest)(uint8_t op);                          // PAIR SET or FORGET (proto::PAIR_*): show it; answer with pairAnswer()
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for the transport in use and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// The key press on a pairing request: true is yes. Any task may call it; the answer is acted on by the RX task. With no request
// waiting it does nothing.
void pairAnswer(bool yes);
// A PING came on the transport in use within its window: 3 s on USB, 10 s on the relay (spec 5.4).
bool online();
// The transport in use: proto::TR_USB, proto::TR_WSS, or proto::TR_NONE after the relay went away until the next HELLO.
uint8_t transport();
// From netlink: one envelope from the relay (copied; any task), the relay connection opened (a HELLO goes out on it), or closed.
void fromRelay(const uint8_t* env, size_t n);
void relayConnected();
void relayDown();
}  // namespace usblink
```

Create `tools/check-relay-roots.mjs`:

```js
// node tools/check-relay-roots.mjs <host>: connects to <host>:443 trusting only the roots in firmware/src/relay_roots.h, as the S3
// does, and says whether the relay's certificate checks out against them. Exit 0 when it does, 1 when it does not.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelayRoots, parseRootsHeader } from './lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.argv[2];
if (!host) {
  console.error('usage: node tools/check-relay-roots.mjs <relay host>');
  process.exit(2);
}
const ca = parseRootsHeader(readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8'));
const r = await checkRelayRoots(host, ca);
if (r.ok) console.log(`${host}: trusted by the pinned roots (${r.chain.join(' <- ')})`);
else console.error(`${host}: NOT trusted by the pinned roots, or not reached: ${r.error}`);
process.exitCode = r.ok ? 0 : 1;
```

Create `tools/gen-relay-roots.mjs`:

```js
// node tools/gen-relay-roots.mjs [<ca bundle>]: writes firmware/src/relay_roots.h from a CA bundle on this machine. The default is the
// certifi bundle in PlatformIO's own Python, which every machine that builds the firmware has; nothing is downloaded.
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickRoots, rootsHeader } from './lib/roots.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = process.argv[2] ?? path.join(os.homedir(), '.platformio', 'penv', 'Lib', 'site-packages', 'certifi', 'cacert.pem');
const out = path.join(root, 'firmware', 'src', 'relay_roots.h');
try {
  const roots = pickRoots(readFileSync(bundle, 'utf8'));
  writeFileSync(out, rootsHeader(roots));
  for (const r of roots) console.log(`${r.label}  ${r.cert.fingerprint256}`);
  console.log(`wrote ${path.relative(root, out)}`);
} catch (e) {
  console.error(`gen-relay-roots: ${e.message}`);
  process.exit(1);
}
```

Create `tools/lib/roots.mjs`:

```js
// The root certificates the S3 trusts for the relay (firmware/src/relay_roots.h): picked by label out of a CA bundle in the format
// certifi ships (a "# Label:" comment before each PEM), checked, and written as a C string the TLS client takes as is.
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';

export const RELAY_ROOT_LABELS = ['ISRG Root X1', 'ISRG Root X2'];
// SHA-256 of each, as Let's Encrypt publishes them (letsencrypt.org/certificates).
export const RELAY_ROOT_FINGERPRINTS = {
  'ISRG Root X1': '96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6',
  'ISRG Root X2': '69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70',
};

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

// [{ label, pem, cert }] for each label, in the order asked. Throws when one is missing, is not a self-signed CA, or its
// fingerprint is not the one above.
export function pickRoots(bundle, labels = RELAY_ROOT_LABELS) {
  const text = bundle.replace(/\r\n/g, '\n');
  return labels.map((label) => {
    const at = text.indexOf(`# Label: "${label}"\n`);
    if (at < 0) throw new Error(`no "${label}" in the bundle`);
    const m = PEM.exec(text.slice(at));
    if (!m) throw new Error(`no certificate after "${label}"`);
    return { label, pem: `${m[0]}\n`, cert: checkRoot(label, m[0]) };
  });
}

function checkRoot(label, pem) {
  const cert = new X509Certificate(pem);
  if (!cert.ca || cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) throw new Error(`"${label}" is not a self-signed CA`);
  const want = RELAY_ROOT_FINGERPRINTS[label];
  if (want && cert.fingerprint256 !== want) throw new Error(`"${label}" has fingerprint ${cert.fingerprint256}, not ${want}`);
  return cert;
}

// The header: every PEM in one C string, each line ending in \n, as mbedTLS parses a chain of them.
export function rootsHeader(roots) {
  const lines = [
    '// relay_roots.h: the roots the S3 trusts for the relay (spec 5.2: verified against a root bundle, no insecure mode).',
    '// Generated by tools/gen-relay-roots.mjs from a local CA bundle; tools/check-relay-roots.mjs <host> tries them against a relay.',
    '// *.fly.dev chains to ISRG Root X1 through X2 today (checked 2026-10-03). Let\'s Encrypt\'s newer roots are not here: if it',
    '// stops sending the cross-signed chain, the S3 says RELAY_DOWN until this file has the root it ends in.',
    '#pragma once',
    '',
    'static const char RELAY_ROOTS_PEM[] =',
  ];
  for (const r of roots) {
    lines.push(`    // ${r.label}, SHA-256 ${r.cert.fingerprint256}, until ${new Date(r.cert.validTo).toISOString().slice(0, 10)}`);
    for (const l of r.pem.trimEnd().split('\n')) lines.push(`    "${l}\\n"`);
  }
  lines[lines.length - 1] += ';';
  return `${lines.join('\n')}\n`;
}

// The PEMs back out of a header rootsHeader() wrote.
export function parseRootsHeader(text) {
  const body = [...text.matchAll(/^\s*"([^"]*)\\n"/gm)].map((m) => m[1]).join('\n');
  return [...body.matchAll(new RegExp(PEM.source, 'g'))].map((m) => `${m[0]}\n`);
}

// Connects to host:port trusting only `ca` (the PEMs the S3 holds), as the S3 does. Resolves with { ok: true, chain } (subject CNs, leaf
// first) when the relay's certificate checks out against them, or { ok: false, error } when it does not or no answer came in time.
export function checkRelayRoots(host, ca, { port = 443, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, ca, timeout: timeoutMs }, () => {
      const chain = [];
      for (let c = socket.getPeerCertificate(true), seen = new Set(); c && !seen.has(c.fingerprint256); c = c.issuerCertificate) {
        seen.add(c.fingerprint256);
        chain.push(c.subject?.CN ?? '?');
      }
      socket.end();
      resolve({ ok: true, chain });
    });
    socket.on('timeout', () => socket.destroy(new Error(`no answer in ${timeoutMs / 1000} s`)));
    socket.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `267 cases, 1535 checks passed, 0 failed`.

Run: `node --test tools/test/roots.test.mjs`
Expected: PASS, 4 tests, 0 fail.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 32.4%, Flash 43.8%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 21, the relay's 17, and `267 cases, 1535 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add firmware/host/test_codec.cpp firmware/host/test_gate.cpp firmware/lib/proto/src/proto/frame.cpp firmware/lib/proto/src/proto/frame.h firmware/lib/proto/src/proto/router.cpp firmware/lib/proto/src/proto/router.h firmware/src/main.cpp firmware/src/netlink.cpp firmware/src/netlink.h firmware/src/relay_roots.h firmware/src/status.h firmware/src/usblink.cpp firmware/src/usblink.h tools/check-relay-roots.mjs tools/gen-relay-roots.mjs tools/lib/roots.mjs tools/test/roots.test.mjs
git commit -m "Task 14: the S3 on the relay: Wi-Fi and a TLS WebSocket in netlink (pinned roots, backoff, a silent relay hung up), frames routed by the transport of the last HELLO, PAIR over USB only, and the roots tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: OFFLINE says which link is down

`ui::offlineHint` gives the line under 未连接 for the reason `offlineReason` names, and `ui::offlineName` the word the log uses; an S3 with no network set up still says to plug in USB, as before. The screen draws the hint and redraws when it changes. The main loop logs `link <state>` when the reason changes, `transport usb|relay|none` when the transport in use changes, and every 5 minutes a health line with the battery, the free heap, the Wi-Fi signal (`netlink::rssi()`) and the link state, which gates M and N read.

**Files:**
- Create: `firmware/lib/ui/src/ui/offline.cpp`, `firmware/lib/ui/src/ui/offline.h`
- Modify: `firmware/src/main.cpp`, `firmware/src/netlink.cpp`, `firmware/src/netlink.h`, `firmware/src/screen.cpp`, `firmware/src/screen.h`
- Test (new): `firmware/host/test_offline.cpp`

**Interfaces:**
- Consumes: `offlineReason`, `LinkView` (Task 12); `netlink::wanted`, `wifiUp`, `relayUp` and `usblink::online`, `transport` (Task 14).
- Produces: `firmware/lib/ui/src/ui/offline.h`: `offlineHint(const proto::LinkView&)`, `offlineName(uint8_t reason)`.
- Produces: `firmware/src/screen.h`: `Extras::offline`. `firmware/src/netlink.h`: `rssi()`.

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_offline.cpp`:

```cpp
// test_offline.cpp: the OFFLINE screen's line for each link that can be down (spec 5.4), and the names the log gives them.
#include <string.h>
#include "check.h"
#include "ui/offline.h"

namespace {
proto::LinkView view(bool online, bool wanted, bool wifi, bool relay) {
  proto::LinkView v;
  v.online = online;
  v.netWanted = wanted;
  v.wifiUp = wifi;
  v.relayUp = relay;
  return v;
}
bool is(const char* got, const char* want) { return strcmp(got, want) == 0; }
}  // namespace

TEST(offlineHintNamesTheLinkThatIsDown) {
  CHECK(is(ui::offlineHint(view(false, false, false, false)), "插好 USB，运行 walkie"), "no network set up: the cable, as before");
  CHECK(is(ui::offlineHint(view(false, true, false, false)), "连不上 Wi-Fi"), "networks set, none joined");
  CHECK(is(ui::offlineHint(view(false, true, true, false)), "连不上中继"), "Wi-Fi, but no relay");
  CHECK(is(ui::offlineHint(view(false, true, true, true)), "电脑没在线：运行 walkie"), "the relay, but no PC on it");
  CHECK(is(ui::offlineHint(view(true, true, true, true)), ""), "online: nothing to say");
}

TEST(offlineNamesAreTheLogsWords) {
  CHECK(is(ui::offlineName(proto::LINK_ONLINE), "online"), "online");
  CHECK(is(ui::offlineName(proto::LINK_NO_WIFI), "no-wifi"), "no-wifi");
  CHECK(is(ui::offlineName(proto::LINK_RELAY_DOWN), "relay-down"), "relay-down");
  CHECK(is(ui::offlineName(proto::LINK_PC_OFFLINE), "pc-offline"), "pc-offline");
  CHECK(is(ui::offlineName(9), "?"), "anything else");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, the host tests do not compile: `ui/offline.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/ui/src/ui/offline.cpp`:

```cpp
#include "ui/offline.h"

namespace ui {
const char* offlineHint(const proto::LinkView& v) {
  switch (proto::offlineReason(v)) {
    case proto::LINK_ONLINE:
      return "";
    case proto::LINK_NO_WIFI:
      return "连不上 Wi-Fi";
    case proto::LINK_RELAY_DOWN:
      return "连不上中继";
    default:
      return v.netWanted ? "电脑没在线：运行 walkie" : "插好 USB，运行 walkie";
  }
}

const char* offlineName(uint8_t reason) {
  switch (reason) {
    case proto::LINK_ONLINE:
      return "online";
    case proto::LINK_NO_WIFI:
      return "no-wifi";
    case proto::LINK_RELAY_DOWN:
      return "relay-down";
    case proto::LINK_PC_OFFLINE:
      return "pc-offline";
    default:
      return "?";
  }
}
}  // namespace ui
```

Create `firmware/lib/ui/src/ui/offline.h`:

```cpp
// offline.h: what the OFFLINE screen says about which link is down (spec 5.4), and the word the log uses for it.
#pragma once
#include <stdint.h>
#include "proto/netstate.h"

namespace ui {
// The line under 未连接: what to check, for the link offlineReason() names. An S3 with no network set up still says to plug in USB.
const char* offlineHint(const proto::LinkView& v);
// "online", "no-wifi", "relay-down" or "pc-offline": for the LOG line when it changes.
const char* offlineName(uint8_t reason);
}  // namespace ui
```

In `firmware/src/main.cpp`, replace:

```cpp
#include "netlink.h"
#include "proto/frame.h"
```

with:

```cpp
#include "netlink.h"
#include "proto/netstate.h"
#include "ui/offline.h"
#include "proto/frame.h"
```

In `firmware/src/main.cpp`, replace:

```cpp
  }
  screen::Extras x = {battery, g_status.micLevel.load(), g_status.playing.load()};
  screen::draw(machine.view(now), x);
```

with:

```cpp
  }
  static uint8_t reason = 0xff;
  proto::LinkView link = {usblink::online(), netlink::wanted(), netlink::wifiUp(), netlink::relayUp()};
  if (proto::offlineReason(link) != reason) {
    reason = proto::offlineReason(link);
    usblink::logf("link %s", ui::offlineName(reason));
  }
  static uint8_t carrier = proto::TR_USB;
  if (usblink::transport() != carrier) {  // a HELLO on the other transport, or the relay gone: gate M watches for these
    carrier = usblink::transport();
    usblink::logf("transport %s", carrier == proto::TR_USB ? "usb" : carrier == proto::TR_WSS ? "relay" : "none");
  }
  static uint32_t lastHealth = 0;
  if (now - lastHealth >= 300000) {  // every 5 min: what gate N reads an hour of standby from
    lastHealth = now;
    usblink::logf("health battery %u%% heap %u rssi %d link %s", (unsigned)battery, (unsigned)ESP.getFreeHeap(), netlink::rssi(),
                  ui::offlineName(reason));
  }
  screen::Extras x = {battery, g_status.micLevel.load(), g_status.playing.load(), ui::offlineHint(link)};
  screen::draw(machine.view(now), x);
```

In `firmware/src/netlink.cpp`, replace:

```cpp
bool relayUp() { return g_relay; }
}  // namespace netlink
```

with:

```cpp
bool relayUp() { return g_relay; }
int rssi() { return g_wifi ? WiFi.RSSI() : 0; }
}  // namespace netlink
```

Replace the whole of `firmware/src/netlink.h` with:

```cpp
// netlink.h: the S3's way to the PC away from the cable (spec 5.2): Wi-Fi, then a WebSocket over TLS to the relay, in its own task.
// It runs only while the S3 holds a pairing key, a network and a relay host (netconf); otherwise Wi-Fi is off. Frames from the relay go
// to usblink, which takes them as it takes the cable's; usblink's TX task hands it the frames to send while the relay is in use.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace netlink {
void begin();
// One link frame's envelope (protocol/frames.md, "Relay") as one binary message. False when the relay is not connected or the
// write failed; the frame is then lost, as on a cable nobody reads.
bool sendEnvelope(const uint8_t* env, size_t n);

bool wanted();   // paired, with a network and a relay host set
bool wifiUp();   // joined one of the networks
bool relayUp();  // the WebSocket to the relay is open
int rssi();      // the joined network's signal in dBm, 0 when none
}  // namespace netlink
```

In `firmware/src/screen.cpp`, replace:

```cpp
  h = mix(h, (uint32_t)x.battery);
  h = mix(h, v.screen == ui::Screen::Listening ? (uint32_t)(x.micLevel / 6) : 0);
```

with:

```cpp
  h = mix(h, (uint32_t)x.battery);
  if (v.screen == ui::Screen::Offline) h = mix(h, x.offline, strlen(x.offline));
  h = mix(h, v.screen == ui::Screen::Listening ? (uint32_t)(x.micLevel / 6) : 0);
```

In `firmware/src/screen.cpp`, replace:

```cpp
      centered(34, "未连接", WHITE, 2);
      centered(82, "插好 USB，运行 walkie", GREY, 1);
      footer("两键同按 3 秒：切换固件");
```

with:

```cpp
      centered(34, "未连接", WHITE, 2);
      centered(82, x.offline, GREY, 1);
      footer("两键同按 3 秒：切换固件");
```

Replace the whole of `firmware/src/screen.h` with:

```cpp
// screen.h: draws a ui::View on the 240x135 display through an off-screen canvas, and can send that canvas to the PC (TEST
// SNAP). The layout is a 16-pixel header, six 16-pixel lines of body and a 16-pixel hint line; efontCN_16 draws 8 pixels
// to an ASCII character and 16 to a Chinese one, so a line is 30 cells (ui/text.h).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "ui/machine.h"

namespace screen {

struct Extras {
  uint8_t battery;   // percent
  uint8_t micLevel;  // g_status.micLevel
  bool playing;      // a reply is playing: the hint on REPLY changes
  const char* offline;  // the line under 未连接 on OFFLINE: ui::offlineHint()
};

bool begin();  // false when the canvas could not be allocated: nothing is drawn then
// Redraws only when something it shows has changed since the last call.
void draw(const ui::View& v, const Extras& x);

// TEST SNAP: freezes the picture, then hands the canvas out as RGB565 chunks, two rows to a chunk, for the main loop to send
// at its own pace. snapNext() writes a TEST payload (proto::buildSnapChunk) and returns true until the last chunk has gone;
// after that, drawing goes on.
bool snapStart();
bool snapNext(uint8_t* out, size_t cap, size_t& len);

}  // namespace screen
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `269 cases, 1545 checks passed, 0 failed`.

- [ ] **Step 5: Build the firmware**

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 32.4%, Flash 43.8%.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 21, the relay's 17, and `269 cases, 1545 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 7: Commit**

```powershell
git add firmware/host/test_offline.cpp firmware/lib/ui/src/ui/offline.cpp firmware/lib/ui/src/ui/offline.h firmware/src/main.cpp firmware/src/netlink.cpp firmware/src/netlink.h firmware/src/screen.cpp firmware/src/screen.h
git commit -m "Task 15: OFFLINE says which link is down (no Wi-Fi, no relay, PC offline, or plug in USB), and the S3 logs its link, its transport and a 5-minute health line" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Gate L, the README, and the spec's amendments

Gate L checks a deployed relay before any S3 goes near it: `tools/gate-l.mjs` first checks that the relay's certificate chains to the S3's pinned roots, then `runGateL` runs a stand-in S3 and a PC through the relay with a throwaway key, scene by scene, and stops at the first that fails: the S3 joins its room, the PC reaches it sealed, the link stays up for 75 s with nobody talking (past two of the relay's pings), the PC notices the S3 leaving, the link is sealed again when it returns, and a second PC replaces the first. The tests run it against a local relay and make each scene fail in turn. The README gains "Away from the cable (plan 6)" (deploying the relay, the settings, how the bridge chooses, gates L, M and N and the S3's log lines), `protocol/frames.md` gains "The S3 on two transports", and the spec gets the amendments and answers listed under "Spec" above.

**Files:**
- Create: `tools/gate-l.mjs`, `tools/lib/gate-l.mjs`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, `protocol/frames.md`
- Test (new): `tools/test/gate-l.test.mjs`

**Interfaces:**
- Consumes: `openRelayPort` (Task 4), `roomId` (Task 3), the `Link` (Task 5), `FakeS3` (Task 5), `loadRelayHost` (Task 8), `checkRelayRoots` and `parseRootsHeader` (Task 14), `startRelay` (Task 2) in the tests.
- Produces: `tools/lib/gate-l.mjs`: `runGateL({ host, holdMs = 75_000, waitMs = 20_000, clock = null, say = console.log, standIn }): Promise<boolean>`.
- Produces: `tools/gate-l.mjs [--host <relay host>] [--hold <seconds>]`: exit 0, 1, or 2 for a usage error.

- [ ] **Step 1: Write the failing tests**

Create `tools/test/gate-l.test.mjs`:

```js
// Gate L against a relay on this machine: every scene holds through the relay's keep-alive pings, and each scene fails, and stops the
// gate, when what it checks is not so: no relay, the wrong key, a silent S3, a link that drops, a loss noticed too late, an S3 that does
// not come back, a relay that goes away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../relay/src/server.js';
import { FakeS3 } from '../../bridge/test/helpers/fake-s3.js';
import { runGateL } from '../lib/gate-l.mjs';

const FAST = { pingEveryMs: 100, pongTimeoutMs: 400 };
const SLOW_LOSS = { pingEveryMs: 100, pongTimeoutMs: 10_000 };

// Runs the gate against a fresh local relay; `onLine(line, ctx)` sees each line as it is said, with the relay and the stand-in S3.
async function gate(t, { holdMs = 1000, waitMs = 3000, clock = FAST, s3Options = {}, onLine = () => {} } = {}) {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  t.after(() => relay.close());
  const lines = [];
  const ctx = { relay, s3: null };
  const ok = await runGateL({
    host: `ws://127.0.0.1:${relay.port}`,
    holdMs,
    waitMs,
    clock,
    say: (l) => {
      lines.push(l);
      onLine(l, ctx);
    },
    standIn: (master) => (ctx.s3 = new FakeS3({ proto: 2, master, ...s3Options })),
  });
  return { ok, lines, last: lines.at(-1) };
}

test('gate L passes every scene against a working relay, through its keep-alive pings', async (t) => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  t.after(() => relay.close());
  const lines = [];
  const ok = await runGateL({ host: `ws://127.0.0.1:${relay.port}`, holdMs: 1000, waitMs: 5000, clock: FAST, say: (l) => lines.push(l) });
  assert.equal(ok, true, lines.join('\n'));
  assert.deepEqual(
    lines.map((l) => l.split(' (')[0]),
    [
      'PASS the S3 joins its room on the relay',
      'PASS the PC reaches it and the link is sealed',
      'PASS it stays up for 1 s with nobody talking',
      'PASS the PC notices when the S3 leaves',
      'PASS and is sealed again when it comes back',
      'PASS a second PC in the room replaces the first',
    ],
  );
  assert.match(lines[2], /\(\d+ PONGs, 0 drops\)/);
  assert.match(lines[5], /\(close code 4000\)$/);
});

test('gate L fails at the first scene, quickly, when no relay answers', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1' });
  const host = `ws://127.0.0.1:${relay.port}`;
  await relay.close();
  const lines = [];
  const started = Date.now();
  const ok = await runGateL({ host, holdMs: 1000, waitMs: 2000, clock: FAST, say: (l) => lines.push(l) });
  assert.equal(ok, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^FAIL the S3 joins its room on the relay \(/);
  assert.ok(Date.now() - started < 5000, 'no hang');
});

test('gate L fails the hold when the relay goes away while the link is up', async () => {
  const relay = await startRelay({ port: 0, host: '127.0.0.1', pingEveryMs: 200 });
  const lines = [];
  const say = (l) => {
    lines.push(l);
    if (l.startsWith('PASS the PC reaches it')) relay.close(); // a relay restarted, or a network gone, in the middle of the hold
  };
  const ok = await runGateL({ host: `ws://127.0.0.1:${relay.port}`, holdMs: 1500, waitMs: 5000, clock: FAST, say });
  assert.equal(ok, false);
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[2], /^FAIL it stays up for 1\.5 s with nobody talking \(\d+ PONGs, [1-9]\d* drops\)$/);
});

test('gate L stops at the sealed link when the S3 holds another key', async (t) => {
  const { ok, lines, last } = await gate(t, { waitMs: 1500, s3Options: { master: Buffer.alloc(32, 7) } });
  assert.equal(ok, false);
  assert.equal(lines.length, 2);
  assert.equal(last, 'FAIL the PC reaches it and the link is sealed');
});

test('gate L fails the hold when the S3 answers no PING, even before the PC gives up on it', async (t) => {
  const { ok, lines, last } = await gate(t, { clock: SLOW_LOSS, onLine: (l, c) => l.startsWith('PASS the PC reaches') && (c.s3.answerPings = false) });
  assert.equal(ok, false);
  assert.equal(lines.length, 3);
  assert.equal(last, 'FAIL it stays up for 1 s with nobody talking (0 PONGs, 0 drops)');
});

test('gate L fails the hold when the link dropped in it, even though it came back', async (t) => {
  const onLine = (l, c) => {
    if (!l.startsWith('PASS the PC reaches')) return;
    c.s3.answerPings = false;
    setTimeout(() => (c.s3.answerPings = true), 700);
  };
  const { ok, lines, last } = await gate(t, { holdMs: 4000, onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 3);
  assert.match(last, /^FAIL it stays up for 4 s with nobody talking \([1-9]\d* PONGs, [1-9]\d* drops\)$/);
});

test('gate L fails when the PC is slower to notice the S3 leaving than the gate waits', async (t) => {
  const { ok, lines, last } = await gate(t, { holdMs: 300, waitMs: 1500, clock: SLOW_LOSS });
  assert.equal(ok, false);
  assert.equal(lines.length, 4);
  assert.equal(last, 'FAIL the PC notices when the S3 leaves (still ready)');
});

test('gate L fails when the S3 that comes back does not answer', async (t) => {
  const onLine = (l, c) => l.startsWith('PASS the PC notices') && (c.s3.write = () => {});
  const { ok, lines, last } = await gate(t, { waitMs: 1500, onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 5);
  assert.equal(last, 'FAIL and is sealed again when it comes back');
});

test('gate L says FAIL, and does not throw, when the relay goes away before the S3 comes back', async (t) => {
  const onLine = (l, c) => l.startsWith('PASS the PC notices') && c.relay.close();
  const { ok, lines, last } = await gate(t, { onLine });
  assert.equal(ok, false);
  assert.equal(lines.length, 5);
  assert.match(last, /^FAIL and is sealed again when it comes back \(.+\)$/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tools/test/gate-l.test.mjs`
Expected: FAIL, the file `tools/test/gate-l.test.mjs` cannot load, because it imports `tools/lib/gate-l.mjs`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Replace the whole of `README.md` with:

````markdown
# walkie

Talk to Claude Code on the PC through the M5StickS3 on the wrist. The design is in
`docs/superpowers/specs/2026-09-29-walkie-design.md`; the plans are in `docs/superpowers/plans/`.

The S3 also runs on-the-beat. on-the-beat keeps app0 and walkie lives in app1, so never run
`pio test` for this firmware against the S3. `pio run -t upload` is routed to `tools/flash.mjs`, and `-t erase` /
`-t uploadfs` are refused by `firmware/guard.py`; use `tools/flash.mjs` and `tools/boot.mjs` for everything that
touches the S3.

## Layout

| Folder | What it holds |
|---|---|
| `protocol/` | the USB wire format (`frames.md`), its Python reference and the shared test vectors |
| `firmware/` | the S3 firmware (PlatformIO). `lib/proto` (frames and payloads) and `lib/ui` (key gestures, key scripts, text paging, the state machine) are portable C++ that `host/run.mjs` also builds and tests on the PC; `src/` holds what needs the hardware: the USB link, audio, the screen |
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `src/speech` talks to OpenAI and Gemini; `src/intent` and `src/config` decide what was said and read the settings; `src/claude` runs Claude Code, one process per project, resumed, stopped and switched, and `src/perm` is the permission endpoint it asks and the queue of approvals waiting for the wrist; `src/turn` takes a recording through speech and Claude and back (approvals, replies, the take that is a reason for a deny), `src/ui` decides what the S3 shows, `src/console.js` is the log and `src/main.js` wires it all together; `bin/walkie.js` is the bridge itself, `bin/walkie-dev.js` and `src/dev` are developer commands |
| `tools/` | writing walkie into app1, choosing which app the S3 boots, and `gate-h.mjs`, the check of the screens and keys on the S3, and `gate-p5.mjs`, the check of pairing, the sealed link and ADPCM on it |

## Prerequisites

- Node 24. Run `npm --prefix bridge install` once, or the dev CLI cannot load serialport.
- g++ (WinLibs) on PATH, for the firmware host tests that `npm test` runs.
- PlatformIO, for building the firmware: the tools use the `pio` in `%USERPROFILE%\.platformio\penv\Scripts` (under `PLATFORMIO_CORE_DIR` instead, when that is set).
- ffmpeg on PATH, for `walkie-dev play <file>`.
- Claude Code (`claude` on PATH, logged in), for `walkie-dev claude` against the real thing and for the bridge itself. The tests never start it: they run a stand-in, `bridge/test/claude/fake-claude.js`.
- API keys for the speech commands: `OPENAI_API_KEY` and `GEMINI_API_KEY`, one `NAME=value` per line in `%APPDATA%\walkie\keys.env` (outside the repo), or environment variables of the same names, which win. The bridge never prints a key. When a speech command finds one missing, its `[keys]` line says where it looked and whether the file names the key with no value, which is what an edit that was never saved looks like.

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
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify, claude, press, ui, snap, inject, selftest. `hear`, `say` and `classify` send text or recordings to OpenAI (and to Gemini when OpenAI fails), so they need the keys above and cost a little each time. `--provider openai` or `--provider gemini` (or `--provider=openai`) uses that provider alone. An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.

`claude` runs the session manager from a terminal, with no S3. It reads one command per line on stdin (`say <text>`, `yes`, `no [reason]`, `stop`, `continue`, `compact`, `new`, `status`, `switch <project>`, `wait idle`, `wait approval`, `sleep <s>`, `quit`; the header of `bridge/src/dev/claude.js` lists them all) and prints what the device would show. It starts the real `claude`, with his login and his quota, in the folder of `--cwd <dir>` (default: the current one) or in a project of `projects.json` with `--project <name>`; the permission server and the approvals are the real ones. Inside the Claude desktop app's own shell it needs `--clean-env`, because the variables of that shell point a nested `claude` at the app. `--command '<json array>'` replaces the program, for the stand-in of the tests. It keeps its state in memory and never touches `%APPDATA%\walkie\state.json`.

`press`, `ui`, `snap` and `inject` use the S3's TEST hooks, so nobody has to touch it: `press` presses its keys, `ui` shows a screen or an approval as the bridge would, `snap` saves what the screen shows as a PNG, and `inject <wav>` feeds a 16 kHz recording to it as its microphone and prints the take that comes back (no API, no Claude).

`node bridge/bin/walkie.js` is the bridge itself. It runs until Ctrl+C, starts Claude Code in the active project of `bridge/projects.json` ahead of the first message (`claude.prewarm`) and waits for the S3 on USB. Hold the front key to talk and release it to send; both keys together for 3 s open the switch to on-the-beat. It runs the real `claude` (his login and quota) and calls the speech APIs, so there is no dry run except with `--command '<json array>'`, a stand-in for `claude` such as `'["node","C:/path/to/bridge/test/claude/fake-claude.js"]'` (a Windows path: the `/c/...` form of Git Bash is one node cannot open, and the stand-in then exits at once). `--port COMx` names the port and `--clean-env` is needed inside the Claude desktop app's own shell, as for `claude` above. `--inject <wav>` feeds a recording to the S3 as its microphone, as if the front key were held while it was said, waits for the whole turn (speech, Claude, the reply spoken) and stops: exit code 0 when Claude replied or the words were a command for walkie, 1 for unclear, a failure, a timeout or no S3. It calls the APIs and runs the real `claude`, so the first turn of a process costs about $0.4 and the session stays in the project's history. The bridge keeps the active project and the last session of each project in `%APPDATA%\walkie\state.json`; a stand-in cannot resume a real session, so set that file aside for a run with `--command`.

`node tools/gate-h.mjs [--port COMx] [--only "scene;scene"]` checks the screens and keys on the S3 with no hands and no API: 11 scenes that show a screen as the bridge would, press keys by TEST frames and check the buttons, verdicts, takes and header colours that come back. walkie must be running on the S3. Its last scene opens the switch to on-the-beat and closes it again; if it is interrupted with that screen open, a tap on the front key reboots the S3 into on-the-beat, and `node tools/boot.mjs app1` brings walkie back.

`flash.mjs` and `boot.mjs` take `--port COMx` (or `--port=COMx`); without it they use the `WALKIE_PORT` environment variable, else
COM8. `flash.mjs --skip-build` writes the last build without running PlatformIO first.

Only one program can hold the S3's port (COM8) at a time: stop the dev CLI before flashing or switching.
Takes recorded by `listen` are voice recordings; they go to `bridge/takes/`, which git ignores.

## The sealed link and pairing (plan 5)

Over the cable the link can be sealed: every frame but HELLO and PAIR is AES-256-GCM under a session key derived from a pairing key that only walkie and this PC hold (`protocol/frames.md`, "Sealed frames" and "Pairing"). It is the groundwork for using walkie away from the cable; the transport is still USB.

```bash
node bridge/bin/walkie.js pair
```

`pair` makes a new key and offers it to the S3 over the cable. The S3 shows a confirmation: the front key accepts, the side key (or 30 s) refuses. Only after the S3 says OK does the key become `%APPDATA%\walkie\pair.key` (64 hex characters; the file is never printed or logged), and the bridge then talks to the S3 in sealed frames only and verifies that a sealed link comes up. A key that was offered and never answered stays as `pair.key.new` and is offered again next time, so a key the S3 did take is not lost. `pair --forget` makes the S3 forget its key (front key again) and this PC delete its own. With no `pair.key` the link is plain, as before, and refuses an S3 that is paired. Anyone with the cable can ask, so the key press on the S3 is the whole authority.

`walkie.js --codec adpcm` sends replies as ADPCM (4 bits a sample, a quarter of the bytes) and asks the S3 for ADPCM takes; the default stays PCM because the cable has bandwidth to spare. `walkie-dev selftest` has the S3 check its own HKDF, AES-GCM and sealed-session code against published test vectors (it needs no key and prints `selftest ok`).

`node tools/gate-p5.mjs [--port COMx] [--only "scene;scene"]` checks all of this on the S3 with no API: the self-test on the chip, pairing with a throwaway key by a TEST key press, a sealed link, a refused plain link and wrong key, a refused re-pair, and an ADPCM take. A paired S3 drops TEST frames, so two presses are yours: the side key in the "pair again" scene and the front key at the end, when the S3 forgets the gate's key (each is asked for on the screen and waits 35 s). It writes the S3's NVS (the key, then its removal) and refuses an S3 that already holds a key, so it never touches `pair.key`. The S3 must run the plan 5 firmware and nothing else may hold COM8.


## Away from the cable (plan 6)

Once paired (above), walkie can reach this PC through a relay on the internet when it is not on the cable: the S3 joins one of its saved Wi-Fi networks and dials the relay, the bridge (`node bridge/bin/walkie.js`) dials the same relay, and the relay passes the sealed frames between them without being able to read them (`protocol/frames.md`, "Relay" and "The S3 on two transports"). The cable still wins: while the S3 is on USB, both ends use it.

**The relay** is `relay/`, a small Node server meant for one always-on Fly.io machine (`relay/fly.toml`, `relay/Dockerfile`). Setting it up is yours to do, because it needs your Fly account and publishes a service:

```bash
cd relay
```

```bash
fly launch --no-deploy --copy-config --name <app name> --region <region>
```

```bash
fly deploy
```

It then answers at `wss://<app name>.fly.dev`. `node relay/bin/relay.js` runs it on this machine instead (port 8080, plain `ws://`; only a loopback address may be used without TLS). It keeps nothing: a room exists while its two ends are connected, and a frame for an absent peer is dropped.

**Settings**, all over the cable to a paired S3:

```bash
node bridge/bin/walkie.js relay <app name>.fly.dev
```

```bash
node bridge/bin/walkie.js wifi add <network name>
```

`relay <host>` saves the host on this PC (`%APPDATA%\walkie\relay.txt`) and on the S3; `relay` alone shows it, `relay --forget` removes it from both, and `--pc-only` leaves the S3 alone. `wifi add` asks for the password twice in this terminal without echoing it (an empty one is an open network) and sends it sealed; the S3 keeps at most four networks and tries them in the order they were added. `wifi list` shows the names (never the passwords) and the relay host the S3 holds; `wifi remove <name>` forgets one. The S3 uses Wi-Fi only while it holds a key, a network and a relay host; with none of them it behaves as before.

**The bridge** looks for the S3 on USB first and uses the relay only when there is no cable and both a `pair.key` and a relay host are set; while on the relay it looks for the cable every 3 s and moves to it when it appears. A move is not seamless: a turn in progress is abandoned, as on any lost link. If a second bridge with the same key takes the relay room, the first stays off the relay for 5 minutes instead of taking it back. Away from the cable the S3's OFFLINE screen says what it lacks: 连不上 Wi-Fi, 连不上中继 (no relay), or 电脑没在线 (the relay is there, the PC is not: start the bridge). With no network set up it still says to plug in USB.

**Checks** before an S3 is involved:

```bash
node tools/check-relay-roots.mjs <app name>.fly.dev
```

```bash
node tools/gate-l.mjs --host <app name>.fly.dev
```

The S3 trusts two roots only, ISRG Root X1 and X2 (`firmware/src/relay_roots.h`, made by `node tools/gen-relay-roots.mjs` from the certifi bundle PlatformIO installs); `check-relay-roots` connects as the S3 would and says whether the relay's certificate chains to them. `gate-l` does the same check and then runs a stand-in S3 and a PC through the relay with a throwaway key: a sealed link, 75 s with nobody talking (past two of the relay's keep-alive pings), the S3 leaving and returning, and a second PC replacing the first. It needs no COM port, no API and no `pair.key`; `--hold <s>` changes the 75 s, and without `--host` it uses the host `walkie relay` saved.

**On the S3**, two more checks need you and the device. Gate M: with walkie paired, a network and the relay set, unplug the cable and start the bridge; a whole turn with an approval must work over Wi-Fi, and plugging the cable back in and out again mid-session must move the link to USB and back. Gate N: take the S3 to another network (a phone hotspot is enough), add it with `wifi add` beforehand, use it there, then leave it on standby with the bridge running for an hour. The bridge prints what the S3 says about its link: `[S3] transport usb|relay|none` when it moves, `[S3] link online|no-wifi|relay-down|pc-offline` when that changes, `[S3] wifi: joined <name>` and `[S3] relay: ...` from the connection, and every 5 minutes `[S3] health battery <n>% heap <bytes> rssi <dBm> link <state>`, from which an hour's standby drain is read.
````

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown
- Paired and with at least one saved network, the S3 joins Wi-Fi and the relay in the background and stays connected. Reconnect backoff is 1, 2, 4 seconds and so on up to 30.
- The relay's certificate is verified against a root bundle. There is no insecure mode.
- TLS memory on top of the audio tasks is the main risk. Heap is measured on the device; if it does not fit, the ring size changes, not the verification.
```

with:

```markdown
- Paired and with at least one saved network, the S3 joins Wi-Fi and the relay in the background and stays connected. Reconnect backoff is 1, 2, 4 seconds and so on up to 30.
- The relay's certificate is verified against a root bundle. There is no insecure mode. *Amended in Plan 6:* the bundle is two pinned roots, ISRG Root X1 and ISRG Root X2 (`firmware/src/relay_roots.h`), so the relay must present a Let's Encrypt chain to one of them, as `*.fly.dev` does. If Let's Encrypt stops cross-signing its newer roots to these, the S3 needs the new root and a flash; `tools/check-relay-roots.mjs` shows it first. The S3 does not check `Sec-WebSocket-Accept`: TLS names the relay, and the relay can neither read nor forge a sealed frame.
- TLS memory on top of the audio tasks is the main risk. Heap is measured on the device; if it does not fit, the ring size changes, not the verification.
```

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown
- A switch is not seamless. A turn in progress is abandoned, as on any link loss.

```

with:

```markdown
- A switch is not seamless. A turn in progress is abandoned, as on any link loss.
- *Amended in Plan 6:* the S3 starts on USB. A frame other than HELLO that arrives on the transport not in use is dropped before it is opened, so it spends no replay counter. PAIR is taken over USB only.

```

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown
- OFFLINE says which link is down: no Wi-Fi, relay unreachable, PC offline.
- Online still means a sealed PONG arrived. The PING timeout is 3 s on USB (as today) and 10 s on WSS, so a phone hotspot's jitter does not read as a disconnect. The PING interval on WSS is chosen against battery in Plan 6.
- When the PC sleeps the bridge stops and the S3 shows PC offline. Windows power settings and starting the bridge at login are not changed by this work; both are the user's to ask for.
```

with:

```markdown
- OFFLINE says which link is down: no Wi-Fi, relay unreachable, PC offline.
- Online still means a sealed PONG arrived. The PING timeout is 3 s on USB (as today) and 10 s on WSS, so a phone hotspot's jitter does not read as a disconnect. The PING interval on WSS is chosen against battery in Plan 6. *Plan 6:* the bridge pings every 5 s on the relay, with the 10 s timeout; the S3 hangs up a relay that has sent nothing for 70 s (the relay pings every 30 s) and dials again.
- When the PC sleeps the bridge stops and the S3 shows PC offline. Windows power settings and starting the bridge at login are not changed by this work; both are the user's to ask for.
```

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown

1. **Where it will be used.** If any of those networks blocks `fly.dev` (for example inside mainland China), the relay cannot be reached there and the hosting choice or domain must change. This was asked and not yet answered. It does not affect Plan 5; it must be settled before Plan 6's relay design is fixed.
2. `esp_websocket_client` or another WebSocket library, and whether the host build can use mbedtls: both are verified in the plans, not decided here.
3. Standby battery cost of staying connected is unknown until measured (gate N).
```

with:

```markdown

1. **Where it will be used.** If any of those networks blocks `fly.dev` (for example inside mainland China), the relay cannot be reached there and the hosting choice or domain must change. *Answered 3 Oct 2026:* only networks that can reach `fly.dev` are in scope. The relay host is a setting (`walkie relay <host>`, on the PC and the S3), so moving the relay needs no new firmware.
2. `esp_websocket_client` or another WebSocket library, and whether the host build can use mbedtls: both are verified in the plans, not decided here. *Answered in Plan 6:* the S3 uses its own WebSocket codec (`proto/ws`, host-tested and checked against the relay byte for byte) over the Arduino core's `WiFiClientSecure`, which is mbedtls; the host build keeps the reference crypto of Plan 5.
3. Standby battery cost of staying connected is unknown until measured (gate N).
```

In `protocol/frames.md`, replace:

```markdown

## Network settings (plan 6)
```

with:

```markdown

### The S3 on two transports

- The S3 joins Wi-Fi and the relay only while it holds a pairing key, at least one network and a relay host (NET, below); otherwise its Wi-Fi is off. It tries the networks in the order they were added, 10 s each, and between failed attempts waits 1, 2, 4 s and so on up to 30 s.
- TLS to the relay is verified against two roots only, ISRG Root X1 and ISRG Root X2 (`firmware/src/relay_roots.h`, made by `tools/gen-relay-roots.mjs`). A relay must present a chain to one of them, as `*.fly.dev` does; `tools/check-relay-roots.mjs <host>` checks a host. There is no way to turn the check off. The S3 does not check `Sec-WebSocket-Accept`: the TLS check names the relay, and the relay can neither read nor forge a sealed frame.
- The S3 is a WebSocket client: every frame it sends is masked, every frame it takes is unmasked. The relay sends an empty ping every 30 s and drops a client that does not answer; the S3 answers with an empty pong. The S3 hangs up when nothing at all has come from the relay for 70 s, and dials again.
- The S3 starts on USB. It sends on the transport where it last took a HELLO, and a HELLO on the other transport moves it there. Any other frame that arrives on the transport not in use is dropped before it is opened, so it spends no replay counter. Online means a PING came within 3 s on USB and 10 s on the relay.
- PAIR is taken over USB only; one that arrives from the relay is dropped. Pairing stays a matter of the cable and the key press.
- On OFFLINE the S3 says which link it lacks: no network set up (plug in USB and run walkie, as before), no Wi-Fi joined, no relay reached, or a relay with no PC on it.

## Network settings (plan 6)
```

Create `tools/gate-l.mjs`:

```js
// Gate L: walkie through the deployed relay, before any S3 goes near it (tools/lib/gate-l.mjs says what each scene checks). First it
// checks that the relay's certificate is one the S3 will trust (the pinned roots in firmware/src/relay_roots.h), then it runs a stand-in
// S3 and a PC through the relay with a throwaway key. No COM port, no API, no pair.key; deploying the relay is not part of it.
// Usage: node tools/gate-l.mjs [--host <relay host>] [--hold <seconds>]   (the host defaults to the one `walkie relay` saved)
// Exit code 0 when every scene held, 1 when one did not, 2 for a usage error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelayHost } from '../bridge/src/config/relay.js';
import { runGateL } from './lib/gate-l.mjs';
import { checkRelayRoots, parseRootsHeader } from './lib/roots.mjs';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const host = flag('--host') ?? loadRelayHost();
const hold = Number(flag('--hold') ?? 75);
if (!host || !Number.isFinite(hold) || hold <= 0) {
  console.error('usage: node tools/gate-l.mjs [--host <relay host>] [--hold <seconds>]  (no --host: run `walkie relay <host>` first)');
  process.exit(2);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)) {
  const ca = parseRootsHeader(readFileSync(path.join(root, 'firmware', 'src', 'relay_roots.h'), 'utf8'));
  const r = await checkRelayRoots(host, ca);
  console.log(r.ok ? `PASS the S3 will trust ${host} (${r.chain.join(' <- ')})` : `FAIL the S3 will trust ${host} (${r.error})`);
  if (!r.ok) process.exitCode = 1;
}
// process.exitCode, never process.exit(): exiting with WebSocket handles still closing aborts Node on Windows (libuv async.c).
if (process.exitCode !== 1) {
  const ok = await runGateL({ host, holdMs: hold * 1000 });
  console.log(ok ? 'gate L: every scene held' : 'gate L: a scene did not hold');
  process.exitCode = ok ? 0 : 1;
}
```

Create `tools/lib/gate-l.mjs`:

```js
// Gate L: walkie away from the cable, through a real relay (normally the deployed one), with no S3, no COM port and no API. A stand-in
// S3 (the tests' FakeS3) holding a throwaway pairing key joins the relay as the device, as the S3's netlink does, and a Link with the same
// key joins as the PC, as the bridge does. Neither touches %APPDATA%\walkie\pair.key; the room is one nobody else will ever use.
import { randomBytes } from 'node:crypto';
import { Link } from '../../bridge/src/link/link.js';
import { openRelayPort } from '../../bridge/src/link/relay-port.js';
import { roomId } from '../../bridge/src/link/room.js';
import { FakeS3 } from '../../bridge/test/helpers/fake-s3.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, ms) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await sleep(50);
  return check();
};

// Runs the scenes in order and stops at the first that fails, since the ones after it build on it. `holdMs`: how long the link must stay
// up untouched (past two of the relay's 30 s keep-alive pings by default). `clock`: the PC end's ping clock, for a test that cannot wait
// out the relay port's 5 s / 10 s. `standIn(master)`: the S3 to use. Resolves with true when every scene held; a relay that goes away
// in the middle is a failed scene, never a throw.
export async function runGateL({
  host,
  holdMs = 75_000,
  waitMs = 20_000,
  clock = null,
  say = console.log,
  standIn = (master) => new FakeS3({ proto: 2, master }),
}) {
  const master = randomBytes(32);
  const room = roomId(master);
  const s3 = standIn(master);
  let device = null;
  let link = null;
  const pass = (name, ok, detail = '') => {
    say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    return ok;
  };

  s3.on('data', (wire) => device?.write(wire));
  const join = async () => {
    const port = await openRelayPort({ host, room, role: 'device' });
    port.on('data', (wire) => s3.write(wire));
    port.on('close', () => {
      if (device === port) device = null;
    });
    device = port;
  };

  try {
    try {
      await join();
    } catch (err) {
      return pass('the S3 joins its room on the relay', false, err.message);
    }
    pass('the S3 joins its room on the relay', true, `room ${room.slice(0, 6)}…`);

    const down = [];
    let pongs = 0;
    const openPort = async () => {
      const port = await openRelayPort({ host, room });
      return clock ? Object.assign(port, clock) : port;
    };
    link = new Link({ openPort, master, retryMs: 1000, retryMaxMs: 4000 });
    link.on('down', (reason) => down.push(reason));
    link.on('pong', () => pongs++);
    link.on('status', () => {});
    await link.start();
    if (!pass('the PC reaches it and the link is sealed', await waitFor(() => link.ready, waitMs))) return false;

    const before = pongs;
    await sleep(holdMs);
    const held = down.length === 0 && device !== null && pongs > before; // a ready link only stops being ready by dropping
    if (!pass(`it stays up for ${holdMs / 1000} s with nobody talking`, held, `${pongs - before} PONGs, ${down.length} drops`)) return false;

    device.close();
    if (!pass('the PC notices when the S3 leaves', await waitFor(() => !link.ready, waitMs), down[0] ?? 'still ready')) return false;
    try {
      await join();
    } catch (err) {
      return pass('and is sealed again when it comes back', false, err.message);
    }
    if (!pass('and is sealed again when it comes back', await waitFor(() => link.ready, waitMs))) return false;

    link.close();
    link = null;
    try {
      const first = await openRelayPort({ host, room });
      const second = await openRelayPort({ host, room });
      const replaced = await waitFor(() => first.replaced, waitMs);
      second.close();
      return pass('a second PC in the room replaces the first', replaced, `close code ${first.closeCode}`);
    } catch (err) {
      return pass('a second PC in the room replaces the first', false, err.message);
    }
  } finally {
    link?.close();
    device?.close();
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test tools/test/gate-l.test.mjs`
Expected: PASS, 9 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all four parts pass: the bridge's 946 tests, the tools' 30, the relay's 17, and `269 cases, 1545 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add README.md docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md protocol/frames.md tools/gate-l.mjs tools/lib/gate-l.mjs tools/test/gate-l.test.mjs
git commit -m "Task 16: gate L (a stand-in S3 and the PC through a real relay, after checking the S3 will trust its certificate), the README for using walkie away from the cable and gates M and N, frames.md on the S3's two transports, and the spec's amendments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
