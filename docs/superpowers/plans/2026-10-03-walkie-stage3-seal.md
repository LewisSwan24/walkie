# Walkie Stage 3, plan 5 of 6: The sealed link. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the link between the S3 and the PC something that can be trusted away from the cable, while it still runs on the cable. Every frame except HELLO and PAIR is sealed with AES-256-GCM under a session key made from a pairing key that only the S3 and the PC hold. The key is put on the S3 over USB by `walkie pair`, and only after a key press on the S3 says yes. Audio can be carried as IMA-ADPCM, a quarter of the bytes, which is what a network link will need. And the S3's own crypto can be checked on the chip. The link stays USB, so every existing vector and gate still applies; plan 6 puts Wi-Fi, the Fly relay and reconnect on top of what this plan builds.

**Architecture:** On the wire, `protocol/frames.md` gains three things: sealed frames (flags bit 7: the payload becomes `counter | ciphertext | tag`, keyed per link from HELLO's two nonces), the audio codec flag (flags bits 1 to 2) with IMA-ADPCM, and the PAIR frame with HELLO v2 (the S3's answer carries its own nonce and says whether it is paired). Every number is generated once, by a script that shares no code with either implementation (`protocol/gen_seal_vectors.mjs` through `node:crypto`, `protocol/gen_vectors.py` for ADPCM and the new payloads), and both sides pass the same JSON. On the firmware the logic is pure C++ in `firmware/lib/proto`, compiled and tested on the PC: `Session` (keys, counters, seal and open) behind a three-function `Crypto` seam, `Gate` (the S3's whole policy: what is sealed, what is refused, how a pairing request is handled), the ADPCM codec and `selfTest`. The seam has two implementations: a test-only reference AES-GCM and HKDF in `firmware/host/ref_crypto.cpp`, and the device's mbedtls adapter in `firmware/src`. `usblink.cpp` sends and receives through the `Gate`; the confirmation screen is a new state of the existing machine. On the bridge, `Link` gets a key and a pairing mode, `pair.js` runs the pairing, and `walkie pair` and `--codec adpcm` are the commands.

**Tech Stack:** C++11 on PlatformIO (`espressif32@6.13.0`, Arduino, mbedtls from the framework, Preferences for NVS), the pure logic compiled by `g++ -std=gnu++11 -Wall -Wextra -Werror` through `firmware/host/run.mjs`; Node 24 (ESM, `node:test`, `node:crypto` for AES-GCM and HKDF); `serialport` stays the bridge's only dependency; Python 3 standard library for the ADPCM reference in `protocol/gen_vectors.py`. No new dependency anywhere.

**Spec:** `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`. This plan implements §4 in full (§4.1 to §4.9). Plan 6 (§5: Wi-Fi, the WSS client, the relay, the network transport and reconnect) is not in it. Two things the spec says are changed on purpose, and Task 16 writes both into the spec: §4.3 said the 1024-byte limit would apply to the plaintext and a sealed payload could be 1044; it stays 1024 for the whole payload, so a sealed frame holds 1004 bytes of plaintext (the largest frame either side sends is 974). §4.5 said every frame except HELLO is sealed once paired; PAIR is the second exception on USB, because a PC that lost its key file could not otherwise ask a paired S3 to take a new one, and the key press on the S3 is the authority, not the secrecy of the frame. Two things §4 lists are deferred on purpose. §4.1's split of `usblink.cpp` into a frame layer and a transport is left to plan 6: the bridge's `openPort` already is the seam on the PC side, and on the firmware the split is better made when there is a second transport to design it against. §4.9's whole voice turn run sealed over USB, once with PCM16 and once with ADPCM, is not in gate P5, which checks pairing, the sealed link and an ADPCM take without OpenAI or the real `claude`; the whole turn is a separate run through the speech APIs and `claude`, and needs its own yes from him. It needs the four plans of stage 1 and changes them only by addition, with the exceptions listed under "Where this plan decides what the spec leaves open".

**Stage 3 is two plans.** Each one leaves working, tested software:

5. **The sealed link** (this plan): sealing, pairing over USB, ADPCM, the self-test, on the cable.
6. **Outside** (later): Wi-Fi credentials over USB into the S3's NVS, the WSS client, `relay/` on Fly.io that forwards sealed frames it cannot read, the network transport behind the same seam, reconnect and standby. It is written after this plan has run on the S3.

Tasks 1 to 15 are code, host tests and a firmware build: they need no S3, no network and no `claude`, and each can go to a worker. Task 16 writes the gate that runs pairing, the sealed link and ADPCM on the real S3, plus the README and the spec amendments; the gate itself is main-thread work and needs his fresh yes, because it opens COM8 and writes the S3's NVS. The S3 currently runs the plan 4 firmware, so running it also means flashing this plan's firmware first, which is a second yes.

**How this plan was checked.** Plan 5 was built once, task by task, before it was written down. The code blocks below are those commits' files, and each task's *Expected* lines are what the commands printed when its tests were put on the commit before it (red) and the rest of its files after them (green) in a clean worktree, with the whole suite and the firmware build run on every commit. Replaying the whole plan onto the commit that holds the spec (`fc8ed8f`) gives, task by task, the tree of the original commits; that was done with the plan's own blocks, by a script that applies each *In, replace*, *Replace the whole of*, *Create* and *Append to the end of* block exactly as written. The sealed link, pairing and ADPCM have run only against the stand-in S3 and the firmware's host tests: **nothing in this plan has run on the real S3** (the device code, `usblink.cpp`, `crypto_mbedtls.cpp` and `keystore_nvs.cpp`, was only compiled; `selfTest` and gate P5 are what will run it, in Task 16 and after).

The new code was also attacked by hand: a condition inverted, a boundary moved by one, a step left out, one mutant at a time, and the tests run against each. Every mutant that survived got a test, in the task that owns the code, before this plan was written, except these, which change nothing a test can see: dropping `!session_.active()` in `Gate::wrap` (`Session::seal` refuses the same frame), an empty HKDF salt against 32 zero bytes (HMAC pads the key, so the two are the same key), `reply.op === DENIED` against `reply.op !== OK` in `runPair` (the S3 sends only those two answers), the file mode `0o600` of the key file (Windows ignores it), and the replay check of `selfTest` (a replay cannot be made through the `Crypto` seam). Review Focus lists what the tests do not reach.

## Global Constraints

- **The S3, the serial port and the network are touched only in Task 16, and each action only with his fresh yes.** Opening COM8 or writing to it, flashing, and anything that pairs the S3 use his hardware and change what is stored on it (pairing writes a key into the S3's NVS). Before each such step ask him with the AskUserQuestion tool and say exactly what will be done, whether the S3 ends up paired and how it is put back. Only a clear yes in that answer counts: not 「继续」, not an earlier yes, not a yes for another run. A re-run after a fix is a new question. Tasks 1 to 15 contain no step that does any of this, and no test in this plan opens a serial port: the tests use the stand-in S3 (`bridge/test/helpers/fake-s3.js`). A test that imports a command's default export instead of its injectable function can open the real port by accident; that happened once while this plan was built, which is why `bridge/src/dev/selftest.js` exports `selftest` for tests and `run` for the bin.
- **The pairing key is never read, listed, logged or printed, and a test never finds the real one.** It lives in `%APPDATA%\walkie\pair.key` (64 hex characters). Library code takes the key, or a file path, as an argument; only `bridge/bin/walkie.js` and `bridge/bin/walkie-dev.js` call `loadPairKey()` with its default path. No log line, error message, `say` line or LOG frame carries a key byte; the key leaves `pairkey.js` only as a `Buffer` handed to the code that seals with it. `%APPDATA%\walkie\keys.env` stays as untouchable as in earlier plans.
- **The S3 is flashed only by `node tools/flash.mjs`** (spec 6.7 of the first spec), which reads the partition table first and writes app1 and otadata only. `pio run -t upload` is routed to it, `-t erase` and `uploadfs` are refused, and `pio test` is never run against the S3. NVS is written by the firmware itself (the pairing key, namespace `walkie`, key `pairkey`), never by a tool. A step that leaves the S3 in app0 ends with `node tools/boot.mjs app1`.
- **The wire, from `protocol/frames.md` ("Sealed frames", "Audio codec", "Pairing").** A sealed frame has flags bit 7 set and the payload `counter:u32 LE | ciphertext | tag:16`; the plain payload is at most 1004 bytes. AES-256-GCM, nonce = direction u32 (1 PC to S3, 2 S3 to PC) then the counter as u64 LE, AAD = type, flags, seq, len (as on the wire, len being the sealed length) and the counter, 10 bytes. Session keys: `HKDF-SHA256(K, empty salt, "walkie-session-v1" || nonceP u32 || nonceS u32 || direction u8, 32)`. A receiver accepts a frame only when the tag is right and the counter is above every counter it has accepted since the HELLO; eight refusals in a row mean a broken link. The CRC-16 stays outside the seal. HELLO and PAIR are never sealed. The codec is flags bits 1 to 2 (0 PCM16, 1 IMA-ADPCM) and a receiver decodes by it; credit, the ring and PLAYED count decoded PCM bytes.
- **No downgrade.** A PC that holds a key sends only sealed frames (HELLO excepted) and drops plain ones; a paired S3 drops every plain frame except HELLO and PAIR; an unpaired S3 drops sealed ones. Nothing in the code may fall back to plain because the sealed path failed.
- **The firmware's pure code (`firmware/lib/proto`, `firmware/lib/ui`) includes no Arduino, M5 or mbedtls header, allocates nothing, writes only into buffers it is given and never writes past them.** It compiles under `-Wall -Wextra -Werror` as C++11. Time is `uint32_t` milliseconds and may wrap: every comparison is `(int32_t)(a - b)`. Crypto is reached only through `proto::Crypto`. The reference crypto in `firmware/host/ref_crypto.cpp` is test code and is never linked into the firmware.
- **What he says does not reach a log line**, as before, and neither does anything of the key. Log lines carry what happened, with sizes and counts.
- **`walkie` is never run without `--command` in a test or a smoke run**, as before (`claude.prewarm` starts the real `claude`). Nothing in this plan runs the real `claude` or a speech API.
- Node 24, ESM, `node:test`. The bridge's dependencies stay `serialport` alone. A test that depends on a time limit uses an injected clock or `sleep`, or `t.mock.timers`; the pairing tests use windows of a few seconds that nothing in them waits out except where a test says so.
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise. Commit by explicit path (`git add <files>`), never `git add -A` or `git commit -a`. No push and no amend. The commands below name the commit's model as Claude Sonnet 5.5 in the `Co-Authored-By:` line; change the name if another model writes the commit, and a session on a model that is not Claude leaves the line out.

### Where this plan decides what the spec leaves open

The spec leaves these open; this plan decides them, and the tests pin each one.

- **PAIR frame.** Type `0x32`, never sealed, payload `u8 op` then: `1` SET (`key:32`), `2` FORGET, `3` OK (`u8` the op it answers), `4` DENIED (`u8` the op it answers). A reply names the op it answers, so a late OK to an old FORGET cannot be taken for the answer to a new SET.
- **HELLO v2.** The PC's HELLO is unchanged (proto 1, a nonce). The S3's answer says proto 2 and carries `nonceS:u32` and `flags:u8` (bit 0 paired, bit 1 takes ADPCM) before the version string. The S3 starts a new session at every PC HELLO, paired or not, so a repeated HELLO gives a second answer with a new `nonceS`.
- **Ready means proven.** A `Link` with a key is ready only when the first frame from the S3 opens under the derived session. HELLO repeats every second until then; after 3 s without a frame that opens it says once that the key is probably wrong. A proto 1 answer, or one that says unpaired, gets a message to run `walkie pair` and only HELLO is sent.
- **A candidate file.** `walkie pair` writes the new key to `pair.key.new`, offers it, and renames it over `pair.key` only when the S3 answers OK; on DENIED it deletes the candidate; on no answer it keeps it, and the next run offers the same key, which the S3 takes without asking if it already holds it. So a lost OK, a crash between the OK and the rename, and a power cut on the S3 cannot leave the two sides with different keys and no way back. The request is repeated every 3 s until it is answered.
- **Pairing mode of the Link.** `new Link({ pairing: true })` holds no key, does not ping and hands up only PAIR frames, so `walkie pair` works against a paired S3 that would refuse a plain PING.
- **The confirmation on the S3.** `PairConfirm` is the highest screen, offline included. The front key short press is yes, the side key short press is no, 30 s without an answer is no, a lost link does not close it. A press that began before the request is not an answer (the front key must be seen up after the screen opened), a chord is ignored while it is open, and a repeated request for the same op does not restart the timer.
- **ADPCM.** The step index is carried from one frame to the next of a stream and starts at 0 for each reply (down) and each take (up); an EOS frame, even an empty one, ends the stream. `CMD SET_CODEC` (op 6, arg 0 or 1) controls only the S3's uplink and a HELLO resets it to PCM16, so the `Link` sends it again after every HELLO answer. A downlink frame needs no command: its flags say what it is. The `Link` computes the PLAYED CRC it expects from its own decode and puts it in the result of a reply as `expected`.
- **Self-test.** `TEST` op 6 makes the S3 run `proto::selfTest` against the mbedtls adapter (RFC 5869 test case 1 for HKDF, NIST GCM test case 16 for seal, open and tamper, and a sealed round trip through a PC to S3 `Session`) and answer with one LOG line, `selftest ok …` or `selftest FAILED, mask 0x..`. It reads and writes no key.
- **What changes in earlier plans:** `TEST_OP`, `CMD` and `TYPE` gain members; HELLO parses two more fields; `Link`'s `played` result gains `expected`; `usblink.cpp` sends and receives through the `Gate`; `fake-s3.js` learns proto 2, sealing, pairing and ADPCM; `startBridge` takes `master` and `adpcm`; `connect()` takes `opts.master`. Nothing is removed, and every plan 1 to 4 test passes unchanged except the ones that assert HELLO's exact bytes or `played`'s exact fields, which are updated in the tasks that change them.

## Review Focus

These are the input classes and failure modes the plan's tests do not exercise. The final reviewer checks each deliberately.

1. **The device paths have only been compiled.** `usblink.cpp`'s use of the `Gate`, `crypto_mbedtls.cpp`, `keystore_nvs.cpp` and the RX task's 8192-byte stack have never run on the S3. Look for: a lock taken twice or not at all around `gate.receive()` and `gate.wrap()`; the static mbedtls GCM context shared between the RX task (open) and the TX path (seal); NVS reads and writes from the wrong task; the stack depth of a receive that derives keys. `selfTest` (Task 15) covers the mbedtls adapter's arithmetic on the chip, nothing else.
2. **A reboot in the middle of a session.** The S3 resets, the PC's old counters are above the new session's: the PC must start a new session at the next HELLO answer (new `nonceS`, counters at 0) and not keep sealing under the old one. In the other direction, frames the S3 sealed before the reset and the PC receives after a new HELLO are refused and counted, never delivered. Check the `Link` for a window in which it still holds the old session after the S3 has started a new one.
3. **Counter rollover.** `Session` refuses to seal after 2^32 - 1 and the tests start a session near it; nothing tests that the `Link` and `usblink` then start the link over rather than going quiet or sending plain.
4. **A wrong key against a real S3.** The S3 counts the PC's frames as refused and, after eight in a row, drops the session until the next HELLO. The PC says the key is probably wrong after 3 s. The tests use the stand-in; check that the S3's side really goes quiet and does not answer a sealed PING with a plain PONG.
5. **Plaintext after pairing.** Every plain frame but HELLO and PAIR must be dropped by a paired S3, including CMD (`boot-app0`), TEST (including `SELFTEST`, `KEYS`, `MIC_PCM`) and UI. `Gate::receive` is tested in isolation; check that nothing in `usblink.cpp` handles a frame type before it has gone through the gate.
6. **PAIR is plain and accepted from anyone on the cable.** The key press is the whole authority. Check that nothing answers a SET without the screen having been shown (the held-key guard), that a SET for the key already held is answered OK at once and only for that exact key, and that FORGET cannot be requested with any argument that changes what it does.
7. **A lost OK, an S3 reset in the middle of pairing, an interrupted NVS write.** The candidate-file protocol and the repeated SET cover the first; the second and third rest on `Preferences::putBytes` being atomic enough, which is not verified. A key half written would show as a paired S3 that opens nothing: `walkie pair` over it is the only recovery, and it works because PAIR is plain.
8. **Odd and oversize audio.** `DownDecoder` refuses a reserved codec, a bad ADPCM frame and anything over 960 decoded bytes, and a PCM frame of odd length loses its last byte; check the credit accounting when a frame is refused (it counts 0, and an EOS on the same frame is still honoured). `UpEncoder` keeps its index across frames and resets it on EOS and on `setCodec`: check a take that is cut by a HELLO.
9. **The key in a log.** Search every path that formats an error or a status near a key (`pair.js`, `pairkey.js`, `link.js`'s `#warn`, `usblink.cpp`'s `logf`, `keystore_nvs.cpp`) for a byte of it, a hex string of it or a length-dependent message that leaks its form. `load()` reports "not a key (64 hex characters expected)" without the text.
10. **What the tests cannot reach on the bridge.** `connect.js`'s `opts.master`, `bin/walkie.js`'s `pair` branch and the `loadPairKey()` calls in both bins need a real serial port or a real `%APPDATA%`. `bridge/test/walkie-bin.test.js` runs the bin in a private `%APPDATA%` and checks usage and start-up only.
11. **The equivalent mutants listed in "How this plan was checked."** Check that none of them is in fact observable.
12. **Not done, on purpose.** `tools/gate-h.mjs` and the other tools that open the link do not take a key, so they work against an unpaired S3 only; run `walkie pair --forget` before them, or give them a key in plan 6. ADPCM is off by default (`--codec adpcm` turns it on): over the cable there is bandwidth to spare, and the network transport of plan 6 is what needs it. Wi-Fi, WSS and the relay are plan 6.

## Files

Every file this plan touches, by what it does to it (the tasks list them again, each with its tests).

- Create (44): `bridge/src/link/session.js`, `bridge/test/link/session.test.js`, `protocol/gen_seal_vectors.mjs`, `protocol/seal-vectors.json`, `bridge/src/link/adpcm.js`, `bridge/test/link/adpcm.test.js`, `firmware/host/ref_crypto.cpp`, `firmware/host/ref_crypto.h`, `firmware/host/test_session.cpp`, `firmware/lib/proto/src/proto/crypto.h`, `firmware/lib/proto/src/proto/session.cpp`, `firmware/lib/proto/src/proto/session.h`, `firmware/host/test_adpcm.cpp`, `firmware/lib/proto/src/proto/adpcm.cpp`, `firmware/lib/proto/src/proto/adpcm.h`, `bridge/test/link/sealed-link.test.js`, `firmware/host/test_gate.cpp`, `firmware/lib/proto/src/proto/gate.cpp`, `firmware/lib/proto/src/proto/gate.h`, `firmware/host/test_hkdf.cpp`, `firmware/lib/proto/src/proto/hkdf.cpp`, `firmware/lib/proto/src/proto/hkdf.h`, `firmware/src/crypto_mbedtls.cpp`, `firmware/src/crypto_mbedtls.h`, `firmware/src/keystore_nvs.cpp`, `firmware/src/keystore_nvs.h`, `firmware/host/test_audiocodec.cpp`, `firmware/lib/proto/src/proto/audiocodec.cpp`, `firmware/lib/proto/src/proto/audiocodec.h`, `bridge/test/link/audio-codec.test.js`, `bridge/src/config/pairkey.js`, `bridge/test/config/pairkey.test.js`, `bridge/src/pair.js`, `bridge/test/pair.test.js`, `bridge/src/cli.js`, `bridge/src/pair-cli.js`, `bridge/test/cli.test.js`, `bridge/test/pair-cli.test.js`, `bridge/src/dev/selftest.js`, `bridge/test/dev/selftest.test.js`, `firmware/host/test_selftest.cpp`, `firmware/lib/proto/src/proto/selftest.cpp`, `firmware/lib/proto/src/proto/selftest.h`, `tools/gate-p5.mjs`
- Modify (36): `protocol/frames.md`, `protocol/gen_vectors.py`, `protocol/vectors.json`, `firmware/host/run.mjs`, `bridge/src/link/frame.js`, `bridge/src/link/link.js`, `bridge/src/link/messages.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/link/codec.test.js`, `bridge/test/link/messages.test.js`, `firmware/host/test_state.cpp`, `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/usblink.cpp`, `firmware/src/status.h`, `firmware/src/usblink.h`, `firmware/host/test_machine.cpp`, `firmware/lib/ui/src/ui/machine.cpp`, `firmware/lib/ui/src/ui/machine.h`, `firmware/src/main.cpp`, `firmware/src/screen.cpp`, `firmware/src/audio.cpp`, `firmware/src/audio.h`, `bridge/bin/walkie-dev.js`, `bridge/bin/walkie.js`, `bridge/src/dev/args.js`, `bridge/src/dev/connect.js`, `bridge/src/main.js`, `bridge/test/dev/args.test.js`, `bridge/test/helpers/world.js`, `bridge/test/main.test.js`, `bridge/test/walkie-bin.test.js`, `bridge/test/dev/walkie-dev.test.js`, `README.md`, `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`

---

### Task 1: Session keys and sealed frames on the bridge

Everything that follows rests on one set of bytes: how a payload is sealed. They are written down once, in `protocol/frames.md` ("Sealed frames"), and generated once, by `protocol/gen_seal_vectors.mjs` into `protocol/seal-vectors.json`. The generator calls `node:crypto` directly and shares no code with `bridge/src/link/session.js`, so a mistake in one cannot be repeated in the other; the firmware's host tests (Task 3) pass the same file. `Session` derives the two directional keys with HKDF-SHA256, seals a payload as `counter | ciphertext | tag`, and opens one only when the tag is right and the counter is above every counter it accepted before. It is pure: no I/O, no clock, no frame encoding.

**Files:**
- Create: `bridge/src/link/session.js`
- Modify: `protocol/frames.md`
- Test (new): `bridge/test/link/session.test.js`, `protocol/gen_seal_vectors.mjs`, `protocol/seal-vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/link/session.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cobsDecode, cobsEncode } from '../../src/link/cobs.js';
import { decodeChunk, encodeFrame } from '../../src/link/frame.js';
import { DIR, MAX_PLAIN, OVERHEAD, SEALED, Session, deriveKeys, hkdf } from '../../src/link/session.js';

const sealVectors = JSON.parse(readFileSync(new URL('../../../protocol/seal-vectors.json', import.meta.url), 'utf8'));
const hex = (s) => Buffer.from(s, 'hex');
const { master, nonceP, nonceS } = sealVectors.session;

const pair = (opts = {}) => ({
  pc: new Session({ master: hex(master), nonceP, nonceS, role: 'pc', ...opts }),
  s3: new Session({ master: hex(master), nonceP, nonceS, role: 's3', ...opts }),
});
// What the wire carries for a sealed frame, back as a decoded frame (COBS and the CRC included).
const overWire = (frame) => decodeChunk(encodeFrame(frame).subarray(1, -1));
const envelopeOf = (frame) => Buffer.from(cobsDecode(encodeFrame(frame).subarray(1, -1))).toString('hex');
const asFrame = (envelopeHex) => decodeChunk(cobsEncode(hex(envelopeHex)));

test('hkdf gives the two RFC 5869 outputs that were written down by hand', () => {
  const [a, b] = sealVectors.hkdf;
  assert.equal(hkdf(hex(a.ikm), hex(a.salt), hex(a.info), a.length).toString('hex'), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
  assert.equal(hkdf(hex(b.ikm), hex(b.salt), hex(b.info), b.length).toString('hex'), '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8');
  for (const v of sealVectors.hkdf) assert.equal(hkdf(hex(v.ikm), hex(v.salt), hex(v.info), v.length).toString('hex'), v.okm, v.name);
});

test('the session keys are the vector keys, one for each direction', () => {
  const k = deriveKeys(hex(master), nonceP, nonceS);
  assert.equal(k.pcToS3.toString('hex'), sealVectors.session.pcToS3);
  assert.equal(k.s3ToPc.toString('hex'), sealVectors.session.s3ToPc);
  assert.notEqual(k.pcToS3.toString('hex'), k.s3ToPc.toString('hex'));
});

test('another nonce on either side gives other keys', () => {
  const a = deriveKeys(hex(master), nonceP, nonceS).pcToS3.toString('hex');
  assert.notEqual(deriveKeys(hex(master), nonceP + 1, nonceS).pcToS3.toString('hex'), a);
  assert.notEqual(deriveKeys(hex(master), nonceP, nonceS + 1).pcToS3.toString('hex'), a);
});

test('sealing builds the vector envelope byte for byte', () => {
  for (const v of sealVectors.frames) {
    const s = new Session({ master: hex(master), nonceP, nonceS, role: v.dir === DIR.PC_TO_S3 ? 'pc' : 's3', counter: v.counter });
    const frame = s.seal({ type: v.type, flags: v.flags, seq: v.seq, payload: hex(v.plain) });
    assert.equal(frame.flags & SEALED, SEALED);
    assert.equal(envelopeOf(frame), v.envelope, `type ${v.type} counter ${v.counter}`);
  }
});

test('the other end opens every vector envelope, and the frame comes out as it went in', () => {
  for (const v of sealVectors.frames) {
    const s = new Session({ master: hex(master), nonceP, nonceS, role: v.dir === DIR.PC_TO_S3 ? 's3' : 'pc' });
    const r = s.open(asFrame(v.envelope));
    assert.equal(r.ok, true, `type ${v.type}`);
    assert.equal(r.frame.type, v.type);
    assert.equal(r.frame.flags, v.flags);
    assert.equal(r.frame.seq, v.seq);
    assert.equal(r.frame.payload.toString('hex'), v.plain);
  }
});

test('a frame sealed here crosses the wire and opens at the other end', () => {
  const { pc, s3 } = pair();
  const r = s3.open(overWire(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 2, 3, 4]) })));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.frame.payload], [1, 2, 3, 4]);
  const back = pc.open(overWire(s3.seal({ type: 0x03, seq: 1, payload: Buffer.from('pong') })));
  assert.equal(back.ok, true);
  assert.equal(back.frame.payload.toString(), 'pong');
});

test('a changed byte anywhere in a sealed frame is refused', () => {
  const v = sealVectors.frames[2];
  const env = hex(v.envelope);
  // type, flags, seq, counter, a ciphertext byte, and the last byte of the tag. (len and the CRC are the wire layer's.)
  for (const at of [0, 1, 2, 6, 10, env.length - 3]) {
    const bad = Buffer.from(env);
    bad[at] ^= 0x01;
    const s = new Session({ master: hex(master), nonceP, nonceS, role: 'pc' });
    const frame = { type: bad[0], flags: bad[1], seq: bad.readUInt16LE(2), payload: bad.subarray(6, bad.length - 2) };
    const r = s.open(frame);
    assert.equal(r.ok, false, `byte ${at}`);
  }
});

test('the receive rule accepts a counter only when it is above every one accepted before', () => {
  const s = new Session({ master: hex(master), nonceP, nonceS, role: 's3' });
  const got = sealVectors.replay.counters.map((counter) => {
    const f = new Session({ master: hex(master), nonceP, nonceS, role: 'pc', counter }).seal({ type: 0x02, seq: 0, payload: Buffer.from([0, 0, 0, 0]) });
    return s.open(f).ok ? 1 : 0;
  });
  assert.deepEqual(got, sealVectors.replay.accepted);
});

test('a replayed frame is refused with the reason replay, and does not move the counter', () => {
  const { pc, s3 } = pair();
  const f1 = pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) });
  const f2 = pc.seal({ type: 0x02, seq: 2, payload: Buffer.from([2, 0, 0, 0]) });
  assert.equal(s3.open(f2).ok, true);
  const again = s3.open(f2);
  assert.deepEqual([again.ok, again.reason], [false, 'replay']);
  const late = s3.open(f1);
  assert.deepEqual([late.ok, late.reason], [false, 'replay']);
});

test('a frame that fails the tag does not move the counter, so the real one still opens', () => {
  const { pc, s3 } = pair();
  const f = pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) });
  const forged = { ...f, payload: Buffer.from(f.payload) };
  forged.payload[forged.payload.length - 1] ^= 0xff;
  const bad = s3.open(forged);
  assert.deepEqual([bad.ok, bad.reason], [false, 'tag']);
  assert.equal(s3.open(f).ok, true);
});

test('a frame without the seal bit, or too short to hold a counter and a tag, is refused', () => {
  const { s3 } = pair();
  const plain = s3.open({ type: 0x02, flags: 0, seq: 0, payload: Buffer.from([1, 0, 0, 0]) });
  assert.deepEqual([plain.ok, plain.reason], [false, 'plain']);
  const short = s3.open({ type: 0x02, flags: SEALED, seq: 0, payload: Buffer.alloc(OVERHEAD - 1) });
  assert.deepEqual([short.ok, short.reason], [false, 'short']);
});

test('a session cannot open what it sealed itself: the two directions have two keys', () => {
  const { pc } = pair();
  const r = pc.open(pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) }));
  assert.deepEqual([r.ok, r.reason], [false, 'tag']);
});

test('failures counts the refusals in a row and goes back to zero at the first frame that opens', () => {
  const { pc, s3 } = pair();
  const bad = { type: 0x02, flags: 0, seq: 0, payload: Buffer.from([1, 0, 0, 0]) };
  s3.open(bad);
  s3.open(bad);
  assert.equal(s3.failures, 2);
  assert.equal(s3.open(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) })).ok, true);
  assert.equal(s3.failures, 0);
});

test('a session of other nonces cannot open the frames of this one', () => {
  const { pc } = pair();
  const other = new Session({ master: hex(master), nonceP, nonceS: nonceS + 1, role: 's3' });
  assert.equal(other.open(pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) })).ok, false);
  const wrongKey = new Session({ master: Buffer.alloc(32, 9), nonceP, nonceS, role: 's3' });
  assert.equal(wrongKey.open(pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) })).ok, false);
});

test('the largest payload that seals is 1004 bytes, and one more is refused', () => {
  const { pc, s3 } = pair();
  assert.equal(MAX_PLAIN, 1004);
  assert.equal(s3.open(overWire(pc.seal({ type: 0x11, seq: 0, payload: Buffer.alloc(1004, 7) }))).ok, true);
  assert.throws(() => pc.seal({ type: 0x11, seq: 1, payload: Buffer.alloc(1005) }), RangeError);
});

test('the send counter ends at 2^32 - 1: that one frame goes, and the next is refused', () => {
  const { pc } = pair({ counter: 0xffffffff });
  assert.doesNotThrow(() => pc.seal({ type: 0x02, seq: 0, payload: Buffer.from([1, 0, 0, 0]) }));
  assert.throws(() => pc.seal({ type: 0x02, seq: 1, payload: Buffer.from([1, 0, 0, 0]) }), /counter/);
});

test('an empty payload seals and opens', () => {
  const { pc, s3 } = pair();
  const r = s3.open(overWire(pc.seal({ type: 0x3f, seq: 3 })));
  assert.equal(r.ok, true);
  assert.equal(r.frame.payload.length, 0);
});
```

Create `protocol/gen_seal_vectors.mjs`:

```js
// Writes protocol/seal-vectors.json: the sealed-frame cases that the bridge's tests and the firmware's host tests both pass.
// It uses node:crypto directly and shares no code with bridge/src/link/session.js, so a mistake in either shows as a mismatch.
// Usage, from the repo root: node protocol/gen_seal_vectors.mjs
import { createCipheriv, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (s) => Buffer.from(s, 'hex');

function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const nonceP = 0x11223344;
const nonceS = 0x55667788;
const info = (dir) => Buffer.concat([Buffer.from('walkie-session-v1'), u32(nonceP), u32(nonceS), Buffer.from([dir])]);
const keys = { 1: hkdf(master, Buffer.alloc(0), info(1), 32), 2: hkdf(master, Buffer.alloc(0), info(2), 32) };

// One sealed envelope, before COBS: type, flags with bit 7, seq, len, counter, ciphertext, tag, CRC-16.
function sealed({ dir, type, flags, seq, counter, plain }) {
  const len = 4 + plain.length + 16;
  const head = Buffer.alloc(6);
  head[0] = type;
  head[1] = flags | 0x80;
  head.writeUInt16LE(seq, 2);
  head.writeUInt16LE(len, 4);
  const aad = Buffer.concat([head, u32(counter)]);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(dir, 0);
  nonce.writeBigUInt64LE(BigInt(counter), 4);
  const c = createCipheriv('aes-256-gcm', keys[dir], nonce, { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const tag = c.getAuthTag();
  const body = Buffer.concat([head, u32(counter), ct, tag]);
  const envelope = Buffer.concat([body, Buffer.from([crc16(body) & 0xff, crc16(body) >> 8])]);
  return { dir, type, flags, seq, counter, plain: hex(plain), envelope: hex(envelope) };
}

const ramp = (n, from = 0) => Buffer.from(Array.from({ length: n }, (_, i) => (from + i * 7) & 0xff));
const frames = [
  sealed({ dir: 1, type: 0x02, flags: 0, seq: 7, counter: 0, plain: u32(0x12345678) }),
  sealed({ dir: 2, type: 0x03, flags: 0, seq: 8, counter: 0, plain: Buffer.concat([u32(0x12345678), u32(5000), u32(1), u32(2)]) }),
  sealed({ dir: 2, type: 0x10, flags: 0x01, seq: 10, counter: 41, plain: ramp(164) }),
  sealed({ dir: 1, type: 0x11, flags: 0x00, seq: 65535, counter: 0xfffffffe, plain: ramp(1004) }),
  sealed({ dir: 2, type: 0x3f, flags: 0, seq: 0, counter: 1, plain: Buffer.alloc(0) }),
];

// The receive rule: a counter is accepted only when it is above every one accepted before it.
const replay = { counters: [0, 1, 2, 2, 1, 5, 4, 6, 0xffffffff, 0xffffffff], accepted: [1, 1, 1, 0, 0, 1, 0, 1, 1, 0] };

const out = {
  hkdf: [
    {
      name: 'RFC 5869 test case 1',
      ikm: '0b'.repeat(22),
      salt: '000102030405060708090a0b0c',
      info: 'f0f1f2f3f4f5f6f7f8f9',
      length: 42,
      okm: hex(hkdf(unhex('0b'.repeat(22)), unhex('000102030405060708090a0b0c'), unhex('f0f1f2f3f4f5f6f7f8f9'), 42)),
    },
    {
      name: 'RFC 5869 test case 3, empty salt and info',
      ikm: '0b'.repeat(22),
      salt: '',
      info: '',
      length: 42,
      okm: hex(hkdf(unhex('0b'.repeat(22)), Buffer.alloc(0), Buffer.alloc(0), 42)),
    },
  ],
  session: { master: hex(master), nonceP, nonceS, pcToS3: hex(keys[1]), s3ToPc: hex(keys[2]) },
  frames,
  replay,
};
writeFileSync(new URL('./seal-vectors.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
```

Create `protocol/seal-vectors.json`:

```json
{
 "hkdf": [
  {
   "name": "RFC 5869 test case 1",
   "ikm": "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
   "salt": "000102030405060708090a0b0c",
   "info": "f0f1f2f3f4f5f6f7f8f9",
   "length": 42,
   "okm": "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
  },
  {
   "name": "RFC 5869 test case 3, empty salt and info",
   "ikm": "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b",
   "salt": "",
   "info": "",
   "length": 42,
   "okm": "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8"
  }
 ],
 "session": {
  "master": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "nonceP": 287454020,
  "nonceS": 1432778632,
  "pcToS3": "21195dac33d846a4a4fbd3777016612e924753d1e8a35e98f5ea770765dfc880",
  "s3ToPc": "f9d144e8397815eebaf92bee71e7bed03fee3997d0830dbbceb98792f31413a4"
 },
 "frames": [
  {
   "dir": 1,
   "type": 2,
   "flags": 0,
   "seq": 7,
   "counter": 0,
   "plain": "78563412",
   "envelope": "0280070018000000000053879a5e2e13942c31f3d1a6e49265915f06e84b2b82"
  },
  {
   "dir": 2,
   "type": 3,
   "flags": 0,
   "seq": 8,
   "counter": 0,
   "plain": "78563412881300000100000002000000",
   "envelope": "03800800240000000000d88c11547b2d5875d6c45f6912228978447718b7b3dde857cb0163ba5ef60f38d79a"
  },
  {
   "dir": 2,
   "type": 16,
   "flags": 1,
   "seq": 10,
   "counter": 41,
   "plain": "00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e75",
   "envelope": "10810a00b8002900000094d5837a949d8d570d354155b0e16d2beb96b8433351665dd511181e073f1878c419d55ca5e48c651c348e19a43cf20fb8b7851305cd1dbdcd8a8f65baa6b585f7617994fb2423f1a964da1d483c0551b9ec163a24636b019b18e700a02284693155cdab6d5c4f10cd2f4e9af0608b1e55e6084b49ad41a408a8aa239a317b7a1076f69e728a1780ed66f6227bbd090f4e4a3c80eb55c9629bcda2eba2e10c183dbb2d377225fb1f7ec137e3491c7ad8034b3ab42b9f"
  },
  {
   "dir": 1,
   "type": 17,
   "flags": 0,
   "seq": 65535,
   "counter": 4294967294,
   "plain": "00070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d9e0e7eef5fc030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6edf4fb020910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2e9f0f7fe050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7dee5ecf3fa01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3dae1e8eff6fd040b121920272e353c434a51585f666d",
   "envelope": "1180ffff0004feffffffd3e16b968e34deb7f04fd57cb92932093eeafd19c17fd382b5e26ba312448820f26d0251495c7a04f041f57c35bfabb11d79c9f827fb1b73acda344f30618af6f30040f7b1548efc31fc6538e39bff38467c9bbd38fadc0cac45bb51f07df4e32002974db75324e5764d22778c5a04e93cbd17c6e6c72b1260b8489f1842ef4866b311815faa5d27911acc72a6612695db5649455370ce918d45b39ae6895f6cab4bbbed992c751c9c233a1dea24490f41fbfad559effbd581c5400ca48f1ea2a2403bf5aa771d3b624700815cfe63d011fc351804a540ad6b4550965b5355c2da59b17f54e961427043394abcf76e0ca31846bc56a102f0f5544af58be53591bff534e3c99860c889e0d4783152b706ca378199b54758719ec94381a22230a06e00a33e62d6d5584cce39a73d57060c1d3abc5e03229c1910e289622e6fc50c34939305da394f71c1dd95a7b9d17dbd19e251fcd055e8286decfca3a25398fe05ddcc9f5a15bc1fc46532aa1e993b07cddd0b06a1fb231a85278363e851cc6253f8e68aae6567bea0eb4d2b230d2b043987573b32ae4ebc50071db64ed2498daa935019be00200eb32e9793f470271c0d2f95e9cef62a26c70cb66c16cac609e289e49513fca100f7a0aaff6b73577a245bfffe7db2a3790d68a6e313b9ac6de06b93dabb4bf045821498d549abd416f851d3c50d991d094480cd9381028c22b1982ecf968a9c0b4800bc0f876dac725d3d869cef3f24c1df515367bdefca3e74a090e545385894bf1fb340d90a81cac196c1be73d1ad064535a93f965c73f314f5a9d77ec020ea83ea2ef4509392c7ad24d4bc7e39a2f30bcc2b5de8e5d9537e5503eac93af559e38265a6f10753c2e5520034804a7fff2764fbe979b01fef5d2fe868f9e13607845fb07acaad2ebd6b6b98988010e26ebdb3137ccab88762a0189e15348b01fab03a4685d3454269cab02dca2a8886c98984e508f687e4477ed0c0ebc9ce0f220b5dbb424883718abbe38a24e56a359805d2416cd2f6f2dfc67af3430b45cb478bbb08b2b16ebd2c406829f043145a5117678f4e11ee8dfff020a28f673b11c67016633e08a835c692bf8f8bb769a0a108a4e2836e7108aff85c8c97dff4d715486b1ddf60ab01a923f9d4d53c3156d7683caf39102e6baef5ab557e7d09f0541e297b620b252db7f4af0b274c11b25e8f46b31e3943cf1fc78bae1a3548ebd34fe387484a21ba68fd05e95556efd02ea2761eff0a2e56ea090836756606f98f7f823db11940808d18b8667ea3065fa302cb01ed45816246a3b401e8f5483a76e1dc1b97ac068eff6018292776453223c9b52f70bafa1d76d2a996b57fa80e94028bf4e269a413fe49269dce03d42676229f884b9d1c4336a707934ad9d6e1db9f9ee707b5b843992dfc33d6df93b8d52e4cc610d046"
  },
  {
   "dir": 2,
   "type": 63,
   "flags": 0,
   "seq": 0,
   "counter": 1,
   "plain": "",
   "envelope": "3f800000140001000000bba7975481ffab19ba46f4726949b582b6e5"
  }
 ],
 "replay": {
  "counters": [
   0,
   1,
   2,
   2,
   1,
   5,
   4,
   6,
   4294967295,
   4294967295
  ],
  "accepted": [
   1,
   1,
   1,
   0,
   0,
   1,
   0,
   1,
   1,
   0
  ]
 }
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/session.test.js`
Expected: FAIL, the file `bridge/test/link/session.test.js` cannot load, because it imports `bridge/src/link/session.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/link/session.js`:

```js
// Sealed frames (protocol/frames.md, "Sealed frames"): the session keys and the AES-256-GCM seal around a frame's payload.
// Pure: no I/O and no clock. A Session belongs to one handshake; a new HELLO makes a new Session.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

export const DIR = Object.freeze({ PC_TO_S3: 1, S3_TO_PC: 2 });
export const SEALED = 0x80; // flags bit 7
export const COUNTER_BYTES = 4;
export const TAG_BYTES = 16;
export const OVERHEAD = COUNTER_BYTES + TAG_BYTES;
export const MAX_PLAIN = 1024 - OVERHEAD; // what a sealed payload may hold: 1004 bytes
const LAST_COUNTER = 0xffffffff;

const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

export const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

// One key for each direction, from the master key and the two nonces of the handshake.
export function deriveKeys(master, nonceP, nonceS) {
  const info = (dir) => Buffer.concat([Buffer.from('walkie-session-v1'), u32(nonceP), u32(nonceS), Buffer.from([dir])]);
  const empty = Buffer.alloc(0);
  return {
    pcToS3: hkdf(master, empty, info(DIR.PC_TO_S3), 32),
    s3ToPc: hkdf(master, empty, info(DIR.S3_TO_PC), 32),
  };
}

function nonceFor(dir, counter) {
  const n = Buffer.alloc(12);
  n.writeUInt32LE(dir, 0);
  n.writeBigUInt64LE(BigInt(counter), 4);
  return n;
}

// The bytes the tag covers besides the payload: the frame's type, flags, seq and sealed length, then the counter.
function aadFor(type, flags, seq, sealedLen, counter) {
  const head = Buffer.alloc(6);
  head[0] = type;
  head[1] = flags;
  head.writeUInt16LE(seq, 2);
  head.writeUInt16LE(sealedLen, 4);
  return Buffer.concat([head, u32(counter)]);
}

export class Session {
  #sendKey;
  #recvKey;
  #sendDir;
  #recvDir;
  #next;
  #last = -1;
  #failures = 0;

  // role: 'pc' seals toward the S3 and opens what the S3 sealed; 's3' is the reverse. `counter` is where sending starts.
  constructor({ master, nonceP, nonceS, role, counter = 0 }) {
    if (role !== 'pc' && role !== 's3') throw new RangeError(`role must be 'pc' or 's3', not ${role}`);
    const keys = deriveKeys(master, nonceP, nonceS);
    const pc = role === 'pc';
    this.#sendKey = pc ? keys.pcToS3 : keys.s3ToPc;
    this.#recvKey = pc ? keys.s3ToPc : keys.pcToS3;
    this.#sendDir = pc ? DIR.PC_TO_S3 : DIR.S3_TO_PC;
    this.#recvDir = pc ? DIR.S3_TO_PC : DIR.PC_TO_S3;
    this.#next = counter;
  }

  // Refusals in a row since the last frame that opened.
  get failures() {
    return this.#failures;
  }

  // Returns the frame to hand to encodeFrame: the seal bit set, and counter, ciphertext and tag as the payload.
  seal({ type, flags = 0, seq, payload = Buffer.alloc(0) }) {
    if (payload.length > MAX_PLAIN) throw new RangeError(`a sealed payload holds at most ${MAX_PLAIN} bytes, not ${payload.length}`);
    if (this.#next > LAST_COUNTER) throw new RangeError('the send counter is used up: start the link over');
    const counter = this.#next++;
    const sealedFlags = flags | SEALED;
    const c = createCipheriv('aes-256-gcm', this.#sendKey, nonceFor(this.#sendDir, counter), { authTagLength: TAG_BYTES });
    c.setAAD(aadFor(type, sealedFlags, seq, OVERHEAD + payload.length, counter));
    const ct = Buffer.concat([c.update(payload), c.final()]);
    return { type, flags: sealedFlags, seq, payload: Buffer.concat([u32(counter), ct, c.getAuthTag()]) };
  }

  // { ok: true, frame } with the seal bit cleared and the plain payload, or { ok: false, reason } with reason one of
  // 'plain', 'short', 'replay' and 'tag'. A refused frame changes nothing but the failure count.
  open(frame) {
    const refuse = (reason) => {
      this.#failures++;
      return { ok: false, reason };
    };
    if (!(frame.flags & SEALED)) return refuse('plain');
    const p = frame.payload;
    if (p.length < OVERHEAD) return refuse('short');
    const counter = p.readUInt32LE(0);
    if (counter <= this.#last) return refuse('replay');
    const d = createDecipheriv('aes-256-gcm', this.#recvKey, nonceFor(this.#recvDir, counter), { authTagLength: TAG_BYTES });
    d.setAAD(aadFor(frame.type, frame.flags, frame.seq, p.length, counter));
    d.setAuthTag(p.subarray(p.length - TAG_BYTES));
    let plain;
    try {
      plain = Buffer.concat([d.update(p.subarray(COUNTER_BYTES, p.length - TAG_BYTES)), d.final()]);
    } catch {
      return refuse('tag');
    }
    this.#last = counter;
    this.#failures = 0;
    return { ok: true, frame: { type: frame.type, flags: frame.flags & ~SEALED, seq: frame.seq, payload: plain } };
  }
}
```

In `protocol/frames.md`, replace:

```markdown
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
| 7 | Reserved for encryption (Stage 3). |

```

with:

```markdown
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
| 7 | Sealed: the payload is `counter, ciphertext, tag` (see Sealed frames). |

```

In `protocol/frames.md`, replace:

```markdown

## Types
```

with:

```markdown

## Sealed frames

A device that has been paired (see Pairing, below) and the bridge that holds its key seal every frame except HELLO. `protocol/gen_seal_vectors.mjs` writes `seal-vectors.json`, which the bridge's tests and the firmware's host tests both pass.

- A sealed frame has flags bit 7 set, and its payload is `counter:u32, ciphertext, tag:16`. The ciphertext is as long as the plain payload, so a sealed payload is 20 bytes longer than the plain one, and the plain payload is at most 1004 bytes (the 1024-byte limit of a frame is unchanged).
- Cipher: AES-256-GCM. The nonce is 12 bytes: the direction as u32 (1 for PC to S3, 2 for S3 to PC), then the counter as u64, little endian. The additional authenticated data is the frame's type, flags (bit 7 set), seq and len as they are on the wire (len is the sealed length), then the counter, 10 bytes in all. The tag is 16 bytes.
- Session keys: one for each direction, `HKDF-SHA256(ikm = K, salt = empty, info = "walkie-session-v1" || nonceP:u32 || nonceS:u32 || direction:u8, 32 bytes)`. `K` is the 32-byte key made at pairing; nonceP and nonceS are the two nonces of the HELLO that began the link, so every link has new keys and a counter that starts at 0 never repeats a nonce under a key.
- Counters start at 0 at each HELLO and go up by 1 for every sealed frame a side sends. A receiver accepts a frame only when its counter is above that of every frame it has accepted since the HELLO and the tag is right; a frame that fails either is dropped and counted, and moves nothing. Gaps are normal (frames are lost); going back is not. The counter after 2^32 - 1 does not exist: the sender starts the link over.
- Eight refused frames in a row mean the link is broken: the bridge says HELLO again, and the S3 treats the session as lost until the next HELLO.
- The CRC-16 stays outside the seal, so a frame damaged on the wire is dropped before any decryption and is not counted as an attack.

## Types
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/session.test.js`
Expected: PASS, 17 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 736 tests, the tools' 17, and `125 cases, 598 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/session.js bridge/test/link/session.test.js protocol/frames.md protocol/gen_seal_vectors.mjs protocol/seal-vectors.json
git commit -m "Task 1: seal: session keys and sealed frames, with the vectors both ends pass" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: IMA-ADPCM on the bridge, with a Python reference

The second codec is specified the same way: a Python reference in `protocol/gen_vectors.py` (standard library only, integer arithmetic, written separately from the JavaScript) writes the step tables and a set of encoded and decoded frames into `protocol/vectors.json`, and `bridge/src/link/adpcm.js` passes them. A frame is self-contained: a 4-byte header (sample 0 as s16, the step index in effect for sample 1, a pad flag) then the nibbles, the first in the low half of a byte; 320 samples become 164 bytes and 480 become 244. The firmware's version is Task 4.

**Files:**
- Create: `bridge/src/link/adpcm.js`
- Modify: `protocol/frames.md`
- Test (new): `bridge/test/link/adpcm.test.js`
- Test (changed): `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/link/adpcm.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectors, hex } from '../vectors.js';
import { INDEX_TABLE, STEP_TABLE, decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';

const toHex = (b) => Buffer.from(b).toString('hex');
const pcmOf = (samples) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const tone = (n, hz, rate, amp) => pcmOf(Array.from({ length: n }, (_, k) => Math.round(amp * Math.sin((2 * Math.PI * hz * k) / rate))));

test('the step and index tables are the reference tables', () => {
  assert.deepEqual([...STEP_TABLE], vectors.adpcm.steps);
  assert.deepEqual([...INDEX_TABLE], vectors.adpcm.indexTable);
});

test('encoding gives the vector frame and the vector step index, for every case', () => {
  for (const c of vectors.adpcm.cases) {
    const r = encodeAdpcm(hex(c.pcm), c.indexIn);
    assert.equal(toHex(r.frame), c.frame, c.name);
    assert.equal(r.index, c.indexOut, c.name);
  }
});

test('decoding gives the vector samples, bit for bit, for every case', () => {
  for (const c of vectors.adpcm.cases) assert.equal(toHex(decodeAdpcm(hex(c.frame))), c.decoded, c.name);
});

test('20 ms of speech is 164 bytes at 16 kHz and 244 at 24 kHz, and decodes to as many samples as went in', () => {
  const up = encodeAdpcm(tone(320, 440, 16000, 8000), 0);
  assert.equal(up.frame.length, 164);
  assert.equal(decodeAdpcm(up.frame).length, 640);
  const down = encodeAdpcm(tone(480, 300, 24000, 8000), 0);
  assert.equal(down.frame.length, 244);
  assert.equal(decodeAdpcm(down.frame).length, 960);
});

test('a decoded tone stays close to the original once the step index has settled: the error is well under the signal', () => {
  const both = tone(640, 440, 16000, 12000);
  const settled = encodeAdpcm(both.subarray(0, 640), 0).index; // the index the encoder carries from the frame before
  const pcm = both.subarray(640);
  const back = decodeAdpcm(encodeAdpcm(pcm, settled).frame);
  let sig = 0;
  let err = 0;
  for (let i = 0; i < 320; i++) {
    const a = pcm.readInt16LE(i * 2);
    const d = a - back.readInt16LE(i * 2);
    sig += a * a;
    err += d * d;
  }
  assert.ok(10 * Math.log10(sig / err) > 20, `${(10 * Math.log10(sig / err)).toFixed(1)} dB`);
});

test('a frame decodes without the one before it: the header carries the sample and the index', () => {
  const pcm = tone(640, 300, 16000, 10000);
  const a = encodeAdpcm(pcm.subarray(0, 640), 0);
  const b = encodeAdpcm(pcm.subarray(640), a.index);
  assert.equal(decodeAdpcm(b.frame).length, 640);
  assert.equal(toHex(decodeAdpcm(b.frame)), toHex(decodeAdpcm(Buffer.from(b.frame))));
  assert.equal(b.frame[2], a.index);
});

test('the first sample goes through unchanged, whatever the index', () => {
  for (const index of [0, 44, 88]) {
    const back = decodeAdpcm(encodeAdpcm(pcmOf([-32768, 5, 7]), index).frame);
    assert.equal(back.readInt16LE(0), -32768);
  }
});

test('encoding refuses what is not whole PCM16 samples, or a step index outside 0 to 88', () => {
  assert.throws(() => encodeAdpcm(Buffer.alloc(3), 0), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(0), 0), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(4), 89), RangeError);
  assert.throws(() => encodeAdpcm(Buffer.alloc(4), -1), RangeError);
});

test('decoding refuses a frame that is shorter than its header, has an index above 88 or a bad pad flag', () => {
  assert.equal(decodeAdpcm(Buffer.alloc(3)), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 89, 0])), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 0, 2])), null);
  assert.equal(decodeAdpcm(Buffer.from([0, 0, 0, 1])), null); // padding with no nibble to pad
  assert.equal(decodeAdpcm(Buffer.from([1, 0, 0, 0])).length, 2); // one sample, no nibbles
});
```

In `protocol/gen_vectors.py`, replace:

```python
import json
import pathlib
```

with:

```python
import json
import math
import pathlib
```

In `protocol/gen_vectors.py`, replace:

```python

digits = b'123456789'
```

with:

```python

# IMA-ADPCM, 4 bits a sample (frames.md, "Audio codec"). A frame is a 4-byte header, then the nibbles of samples 1 to n-1,
# the first sample's nibble in the low half of a byte. The header holds sample 0 as s16, the step index in effect for
# sample 1, and 1 when the last nibble is padding (n - 1 is odd), so a frame never depends on the one before it.
ADPCM_STEPS = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
    1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
    7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]
ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8]
assert len(ADPCM_STEPS) == 89


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def adpcm_encode(samples, index):
    pred, nibbles, index_in = samples[0], [], index
    for s in samples[1:]:
        step = ADPCM_STEPS[index]
        diff, nib = s - pred, 0
        if diff < 0:
            nib, diff = 8, -diff
        if diff >= step:
            nib |= 4
            diff -= step
        if diff >= step >> 1:
            nib |= 2
            diff -= step >> 1
        if diff >= step >> 2:
            nib |= 1
        diffq = step >> 3
        if nib & 4:
            diffq += step
        if nib & 2:
            diffq += step >> 1
        if nib & 1:
            diffq += step >> 2
        pred = clamp(pred - diffq if nib & 8 else pred + diffq, -32768, 32767)
        index = clamp(index + ADPCM_INDEX[nib & 7], 0, 88)
        nibbles.append(nib)
    pad = len(nibbles) % 2
    if pad:
        nibbles.append(0)
    body = bytes(nibbles[i] | (nibbles[i + 1] << 4) for i in range(0, len(nibbles), 2))
    return struct.pack('<hBB', samples[0], index_in, pad) + body, index


def adpcm_decode(frame):
    pred, index, pad = struct.unpack('<hBB', frame[:4])
    out = [pred]
    nibbles = []
    for b in frame[4:]:
        nibbles += [b & 15, b >> 4]
    if pad:
        nibbles.pop()
    for nib in nibbles:
        step = ADPCM_STEPS[index]
        diffq = step >> 3
        if nib & 4:
            diffq += step
        if nib & 2:
            diffq += step >> 1
        if nib & 1:
            diffq += step >> 2
        pred = clamp(pred - diffq if nib & 8 else pred + diffq, -32768, 32767)
        index = clamp(index + ADPCM_INDEX[nib & 7], 0, 88)
        out.append(pred)
    return out


def adpcm_case(name, samples, index_in):
    frame, index_out = adpcm_encode(samples, index_in)
    return {'name': name, 'pcm': h(struct.pack('<%dh' % len(samples), *samples)), 'indexIn': index_in, 'frame': h(frame),
            'indexOut': index_out, 'decoded': h(struct.pack('<%dh' % len(samples), *adpcm_decode(frame)))}


lcg, noise = 12345, []
for _ in range(100):
    lcg = (lcg * 1103515245 + 12345) & 0x7FFFFFFF
    noise.append((lcg >> 8) % 65536 - 32768)
adpcm = {
    'steps': ADPCM_STEPS,
    'indexTable': ADPCM_INDEX,
    'cases': [
        adpcm_case('silence, 20 ms at 16 kHz', [0] * 320, 0),
        adpcm_case('a 440 Hz tone, 20 ms at 16 kHz', [int(12000 * math.sin(2 * math.pi * 440 * k / 16000)) for k in range(320)], 0),
        adpcm_case('a 300 Hz tone, 20 ms at 24 kHz, a step index of 20', [int(9000 * math.sin(2 * math.pi * 300 * k / 24000)) for k in range(480)], 20),
        adpcm_case('full-scale square wave, the steps at their largest', [32767 if (k // 8) % 2 == 0 else -32768 for k in range(320)], 88),
        adpcm_case('full-scale square wave from the smallest step', [32767 if (k // 8) % 2 == 0 else -32768 for k in range(320)], 0),
        adpcm_case('one sample', [1234], 10),
        adpcm_case('two samples, the last nibble is padding', [100, -100], 5),
        adpcm_case('three samples', [-5, 300, 20000], 40),
        adpcm_case('noise over the whole range', noise, 30),
    ],
}
assert all(len(c['frame']) // 2 == 4 + (len(c['pcm']) // 4) // 2 for c in adpcm['cases'])

digits = b'123456789'
```

In `protocol/gen_vectors.py`, replace:

```python
    'messages': messages,
    'pattern': {'first8': h(b''.join(struct.pack('<H', (k * 1103 + 12345) & 0xFFFF) for k in range(8))),
```

with:

```python
    'messages': messages,
    'adpcm': adpcm,
    'pattern': {'first8': h(b''.join(struct.pack('<H', (k * 1103 + 12345) & 0xFFFF) for k in range(8))),
```

In `protocol/vectors.json`, replace:

```json
 ],
 "pattern": {
```

with:

```json
 ],
 "adpcm": {
  "steps": [
   7,
   8,
   9,
   10,
   11,
   12,
   13,
   14,
   16,
   17,
   19,
   21,
   23,
   25,
   28,
   31,
   34,
   37,
   41,
   45,
   50,
   55,
   60,
   66,
   73,
   80,
   88,
   97,
   107,
   118,
   130,
   143,
   157,
   173,
   190,
   209,
   230,
   253,
   279,
   307,
   337,
   371,
   408,
   449,
   494,
   544,
   598,
   658,
   724,
   796,
   876,
   963,
   1060,
   1166,
   1282,
   1411,
   1552,
   1707,
   1878,
   2066,
   2272,
   2499,
   2749,
   3024,
   3327,
   3660,
   4026,
   4428,
   4871,
   5358,
   5894,
   6484,
   7132,
   7845,
   8630,
   9493,
   10442,
   11487,
   12635,
   13899,
   15289,
   16818,
   18500,
   20350,
   22385,
   24623,
   27086,
   29794,
   32767
  ],
  "indexTable": [
   -1,
   -1,
   -1,
   -1,
   2,
   4,
   6,
   8
  ],
  "cases": [
   {
    "name": "silence, 20 ms at 16 kHz",
    "pcm": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "indexIn": 0,
    "frame": "0000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    "indexOut": 0,
    "decoded": "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
   },
   {
    "name": "a 440 Hz tone, 20 ms at 16 kHz",
    "pcm": "00000f08e00f3917e11da4235828d92b0b2ede2e4c2e592c13299524ff1e7d1841118109780166f984f111ea46e355dd6dd8b2d441d22ed17fd133d33cd684daeadf44e663ed0ff50ffd2405130d9f148d1ba921c426b82a662dbb2eaa2e362d692a59262521f41af5135e0c690453fc58f4b6eca7e562df14dae8d5fdd269d138d16cd2fbd4d3d8d5dddbe3b9ea38f221fa3502390af0111d198c1f09256d29942c682eda2ee62d952bf72729234e1d95162f0f550744ff38f76fef24e88fe1e2db49d7e6d3d3d120d1d3d1e6d349d7e2db8fe124e86fef38f744ff55072f0f95164e1d2923f727952be62dda2e682e942c6d2909258c1f1d19f011390a350221fa38f2b9eadbe3d5ddd3d8fbd46cd238d169d1fdd2e8d514da62dfa7e5b6ec58f453fc69045e0cf513f41a25215926692a362daa2ebb2e662db82ac426a9218d1b9f14130d24050ffd0ff563ed44e6eadf84da3cd633d37fd12ed141d2b2d46dd855dd46e311ea84f166f97801810941117d18ff1e95241329592c4c2ede2e0b2ed92b5828a423e11d3917e00f0f080000f1f720f0c7e81fe25cdca8d727d4f5d122d1b4d1a7d3edd66bdb01e183e7bfee7ff688fe9a067c0eef15ba1cab2293274e2bbf2dd22e812ecd2cc4297c251620bc199d12f10af102dcfaedf261eb73e457de3cd948d59ad245d156d1cad297d5a7d9dbde0ce50beca2f397fbad03a80b4a13591a9e20ec25182a032d972ec82e942d052b2d272b22251c4715c80ddf05cbfdc7f510eee3e674e0f7da93d66cd398d126d11ad26bd409d8d7dcb2e26be9d1f0abf8bc00c8089110dc17711e1e24b7281a2c2d2ee02e2d2e1a2cb7281e24711edc179110c808bc00abf8d1f06be9b2e2d7dc09d86bd41ad226d198d1",
    "indexIn": 0,
    "frame": "0000000177777777078889a9a9ababab9a08214444434323231200a9cccccbbbbcba9a89214434354333331301a8ccccbccbbbbbab8920635334433324120198cabcbdbcbcbaaa8910424434342423231188bbbebdbcacbbaa9a00323635344333221280bacdccbbbcbbbb9a08313645333433241100b9dbcccbcbbaab9a09214444433334321201a9ccbcbdcbbbbb9b89204444344333332301a8ebdbbccbbbac9a8900",
    "indexOut": 54,
    "decoded": "00000b0029006800f00015028c04d9093715932d0e31e42d042b2c23cc20501a7c10200b0203acf8f7f16ee9e2e3d3dc3ed814d4ced11ed1bed172d308d643da62df95e515ed24f464fc28043c0dc515511b6022f5261f2b652d152eb52e012d6b2a30261121de1a5e134f0c0f044bfc3cf5fcec38e52de0c3d999d553d343d1a3d057d2edd428d947de7ae44eeaa4f268fa7701b7097b118a18f41ec824162a262c062e972e132eba2be1273923971dc516850ec106b2ff72f7aeef9fe835e261dc13d7a2d3c2d131d1b5d10ed40cd719dceae0cce70cf0d0f7dffe1f07e30ef215321ebe23c928882b072ec92e192e392c6129b924171fc9193612270be70223fb0ff286e9fae3ebdc56d82cd4e6d136d1d6d18ad320d65bda7adfade52ded3cf47cfc4004540d6d13311b3c20a626d02a162d262f862ef52d562a0d277e21301c9d148e0d4e058afd76f45dee99e68adff5dacbd601d3f1d091d122d2b8d401d890dddee271ea80f1c0f984019308d3109718a61f3b2465282f2c3f2edf2e4e2eb82b6f28bb23191e4717070f43073400f4f730f021e9b7e2e3dc95d724d444d2b3d137d29fd39dd6aadb7be05de79def61f770feb006740e8315ed1b6d237828372bb62d782e282f482d4d29ae258320501ad012c10b8103bdfba9f290eccce4bddd28d9fed4b8d2a8d048d1fcd292d5cdd9ecde1fe59fecaef3eefbb203c10a0113c51ad01f3a26642aaa2cba2e5a2fa62d102bd526b621831baf15590d950586fe46f682ee73e709e135dbe7d5d7d3f7d166d1ead143d41cd8c4dc66e238e978f13cf94b008b084f105e17c81d9c23ea285b2c3b2ecc2e482eef2bf128e423131f3118f10f2d081e01def81af10beacbe13fdc34d775d4f6d134d1e4d1"
   },
   {
    "name": "a 300 Hz tone, 20 ms at 24 kHz, a step index of 20",
    "pcm": "0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd0000c2027f053508dd0a740df50f5e12aa14d516db18bb1a711cf91d531f7a206f212f22b9220c2328230c23b9222f226f217a20531ff91d711cbb1adb18d516aa145e12f50f740ddd0a35087f05c20200003efd81facbf723f58cf20bf0a2ed56eb2be925e745e58fe307e2ade086df91ded1dd47ddf4dcd8dcf4dc47ddd1dd91de86dfade007e28fe345e525e72be956eba2ed0bf08cf223f5cbf781fa3efd",
    "indexIn": 20,
    "frame": "00001401777716111121110111809099cbbccccbbccbcbbbbcacbbcbbabbbaaaaa88104244445333354343333424334323333222120198caccccdbbbbdcbcbbbbcacbbcbabbbbaaaaa88104254433444433344323433433343322222120198caccdbdbbbbdcbcbbbbcacbbcbbabbbaaaaa88104244445333354343333424334323333222220098cadccbbccccbbbccbabcbbcbbbcbbaaaaa9a89104244535333354343333424334332333222220098caccccdbbbbdcbcbbbbcacbbcbabbbbaaaaa88104254433444433344323433433343322222120198caccdbdbbbbdcbcbbbbcacbbcbbabbbaaaaa8810424444533335434303",
    "indexOut": 48,
    "decoded": "00005d002401d2026f06290de80f6712ad14bd169d18511ae71c4f1e971fc1201b211122f0223423f7222f2396220c228e2183204a1fcf1d6a1cc91ad018f416c9142912b00f710dd10a58087405bc0243005ffda7fa79f756f59ef225f0e6ed46eb82e943e739e55de329e2a1e0a2dfbbdee9dd2add08dde9dc05dd53ddc9dd8bde76df92e0ebe18ce314e545e74fe92bebd1ed4af089f229f5a2f786fa3efdb7ff9b0253058108a40a5c0dd50f1412b4142d17c818d21aae1ce21d6a1f6920502122229422fb221a23fe22b0223a2278218d20711f181e771cef1abe18b416d8143212b90f7a0dda0a61087d05c5024c0068fdb0fa82f75ff5a7f22ef0efed4febd6e83be731e555e321e299e09adfb3dee1dd22dd00dde1dcfddc4bddc1dd83de6edfc9e00ce287e352e501e7fae85eeb9ded3df0b6f2f5f495f7c3fae6fc9effcc02ca058208fb0a3a0dda0f531292149c1600199b1aa51cf91d2d1f452044212b22a9221b233d231e23c922472272217020371f111e6c1ce41ab318a916cd142712ae0f6f0dcf0a56087205ba0241005dfda5fa77f754f59cf223f0e4ed44eb80e941e737e55be327e29fe0a0dfb9dee7dd28dd06dde7dc03dd51ddc7dd89de74df90e0e9e18ae312e543e74de929ebcfed48f087f227f5a0f784fa3cfdb5ff990251057f08a20a5a0dd30f1212b2142b17c618d01aac1ce01d681f67204e212022df22012320230423b62240227e219320381ff51d7a1caf1a00190717a3146412c40f4b0d0c0b6c083e051b03630035fd37fa7ff706f5c7f227f0aeed6feb65e901e766e55ce308e2d4e0bcdfbdded6dd58dde6dcc4dce3dc38ddbadd8fde91dfcae0f0e195e31de54ee758e934ebdaed53f092f232f5abf78ffa47fdc0ffa4025c058a08ad0a650dde0f1d12bd148116c018ca1aa61cda1d621f612048211a22d922fb221a23fe22b0223a2278218d20711f181e771cef1abe18b416d8143212b90f7a0dda0a61087d05c5024c0068fdb0fa82f75ff5a7f22ef0efed4febd6e83be731e555e321e299e09adfb3dee1dd22dd00dde1dcfddc4bddc1dd83de6edfc9e00ce287e352e501e7fae85eeb9ded3df0b6f2f5f495f7c3fae6fc9effcc02ca058208fb0a3a0dda0f531292149c1600199b1aa51cf91d2d1f452044212b22a9221b233d231e23c922472272217020371f111e6c1ce41ab318a916cd142712ae0f6f0dcf0a56087205ba0241005dfda5fa77f754f59cf223f0e4ed44eb80e941e737e55be327e29fe0a0dfb9dee7dd28dd06dde7dc03dd51ddc7dd89de74df90e0e9e18ae312e543e74de929ebcfed48f087f227f5a0f784fa3cfd"
   },
   {
    "name": "full-scale square wave, the steps at their largest",
    "pcm": "ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080",
    "indexIn": 88,
    "frame": "ff7f5801000000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888008",
    "indexOut": 82,
    "decoded": "ff7fff7fff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c17810080"
   },
   {
    "name": "full-scale square wave from the smallest step",
    "pcm": "ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080ff7fff7fff7fff7fff7fff7fff7fff7f00800080008000800080008000800080",
    "indexIn": 0,
    "frame": "ff7f0001000000f0ffffff6f000000f0ff8a8078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888078030000f00c888008",
    "indexOut": 82,
    "decoded": "ff7fff7fff7fff7fff7fff7fff7fff7ff47fd67f977f0f7fea7d737b2676c86ae57fff7fff7fff7fff7fff7fff7fff7fd9695c3a91d4d48b0080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c178100807f077c77ff7fff7fff7fff7fff7fff7fd2040080ff8f73810080058c17810080"
   },
   {
    "name": "one sample",
    "pcm": "d204",
    "indexIn": 10,
    "frame": "d2040a00",
    "indexOut": 10,
    "decoded": "d204"
   },
   {
    "name": "two samples, the last nibble is padding",
    "pcm": "64009cff",
    "indexIn": 5,
    "frame": "640005010f",
    "indexOut": 13,
    "decoded": "64004e00"
   },
   {
    "name": "three samples",
    "pcm": "fbff2c01204e",
    "indexIn": 40,
    "frame": "fbff280073",
    "indexOut": 47,
    "decoded": "fbff21015f03"
   },
   {
    "name": "noise over the whole range",
    "pcm": "165c27841ce5962a1c9f622dcf9dadda775a3365c42caf9bb29e36df699399f01bf9c6ece87d2790bc7f00992e2fd4e0629dc084e62cde34989da2827eab3fc6abf801f320bab372a75ffadfb92eb837588869d9f551886e4ab9ea903f4b20c8c815d835c44c3c09dfa95091707f57865b362ee2efaeae5fc7bc0e79acb53d7d71cb4b14d4a8c04a638902fc53c4b3336a820fded51651df11330e6ac5ed972ca5545aad510141ee32e9102f6360ca6684070ccca71c6f842767ea528bb62cdd66ac05e03949bd6a",
    "indexIn": 30,
    "frame": "165c1e01ffffff7ca10da103787f4eaa68d01820a8072ce042e0682c10ca795daad7d5d6c2e593d4223ae2022d8822d03a6ed8914101",
    "indexOut": 86,
    "decoded": "165c235b1a59ba54574b36370c0c86d480447e74c12b479a46aaead5ca93f1e7dff2f0e86f7073806f7072a0703072e0b5977c8ac726c636c096c18665b29ebfbafbccf01ebf9d469c56aed3ac2338324a8648d63659356916ac179c365938c93619c2276e4f5213f3b047899d3da08d9d3d9fede2a4436b46bb436b46bbff7f02d00020129d0f4d0080fdef59c4603b638b61db1e24fee12536cb6c9feb9d3b294aafb8ad0821fae8ec0429aa5f99693c061cc443182c8a295a2a4a24aa22da7eae2ad65e42026e"
   }
  ]
 },
 "pattern": {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/adpcm.test.js`
Expected: FAIL, the file `bridge/test/link/adpcm.test.js` cannot load, because it imports `bridge/src/link/adpcm.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/link/adpcm.js`:

```js
// IMA-ADPCM, 4 bits a sample (protocol/frames.md, "Audio codec"). A frame is self-contained: a 4-byte header (sample 0 as s16,
// the step index in effect for sample 1, a pad flag), then the nibbles of samples 1 to n-1, the first one in the low half
// of a byte. Integer arithmetic only, so every implementation decodes to the same bits.
export const STEP_TABLE = Object.freeze([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
  143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
  9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);
export const INDEX_TABLE = Object.freeze([-1, -1, -1, -1, 2, 4, 6, 8]);
export const HEADER_BYTES = 4;
const MAX_INDEX = 88;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// The change in the predictor that a nibble stands for, with the step it was coded at.
function delta(nibble, step) {
  let d = step >> 3;
  if (nibble & 4) d += step;
  if (nibble & 2) d += step >> 1;
  if (nibble & 1) d += step >> 2;
  return nibble & 8 ? -d : d;
}

// `pcm`: PCM16 little endian, at least one sample. `index`: the step index to start from. Returns { frame, index }, where
// index is the one to start the next frame from.
export function encodeAdpcm(pcm, index) {
  if (pcm.length < 2 || pcm.length % 2) throw new RangeError('ADPCM needs whole PCM16 samples, at least one');
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) throw new RangeError(`step index must be 0..${MAX_INDEX}, not ${index}`);
  const n = pcm.length / 2;
  const nibbles = [];
  let pred = pcm.readInt16LE(0);
  let idx = index;
  for (let i = 1; i < n; i++) {
    const step = STEP_TABLE[idx];
    let diff = pcm.readInt16LE(i * 2) - pred;
    let nib = 0;
    if (diff < 0) {
      nib = 8;
      diff = -diff;
    }
    if (diff >= step) {
      nib |= 4;
      diff -= step;
    }
    if (diff >= step >> 1) {
      nib |= 2;
      diff -= step >> 1;
    }
    if (diff >= step >> 2) nib |= 1;
    pred = clamp(pred + delta(nib, step), -32768, 32767);
    idx = clamp(idx + INDEX_TABLE[nib & 7], 0, MAX_INDEX);
    nibbles.push(nib);
  }
  const pad = nibbles.length % 2;
  if (pad) nibbles.push(0);
  const frame = Buffer.alloc(HEADER_BYTES + nibbles.length / 2);
  frame.writeInt16LE(pcm.readInt16LE(0), 0);
  frame[2] = index;
  frame[3] = pad;
  for (let i = 0; i < nibbles.length; i += 2) frame[HEADER_BYTES + i / 2] = nibbles[i] | (nibbles[i + 1] << 4);
  return { frame, index: idx };
}

// PCM16 little endian, or null when the frame cannot be one: shorter than its header, an index above 88, a pad flag that is
// not 0 or 1, or padding with no nibble to pad.
export function decodeAdpcm(frame) {
  if (frame.length < HEADER_BYTES) return null;
  const index = frame[2];
  const pad = frame[3];
  if (index > MAX_INDEX || pad > 1 || (pad === 1 && frame.length === HEADER_BYTES)) return null;
  const count = 1 + (frame.length - HEADER_BYTES) * 2 - pad;
  const out = Buffer.alloc(count * 2);
  let pred = frame.readInt16LE(0);
  let idx = index;
  out.writeInt16LE(pred, 0);
  for (let i = 1; i < count; i++) {
    const byte = frame[HEADER_BYTES + ((i - 1) >> 1)];
    const nib = (i - 1) & 1 ? byte >> 4 : byte & 15;
    pred = clamp(pred + delta(nib, STEP_TABLE[idx]), -32768, 32767);
    idx = clamp(idx + INDEX_TABLE[nib & 7], 0, MAX_INDEX);
    out.writeInt16LE(pred, i * 2);
  }
  return out;
}
```

In `protocol/frames.md`, replace:

```markdown
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec. 0 is PCM16, little endian, mono; the other values are reserved (ADPCM, Stage 3). |
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
```

with:

```markdown
| 0 | EOS, end of stream: the last frame of an AUDIO_UP take or an AUDIO_DOWN reply. Its payload may be empty. |
| 1-2 | Audio codec of an AUDIO_UP or AUDIO_DOWN frame. 0 is PCM16, little endian, mono; 1 is IMA-ADPCM (see Audio codec); 2 and 3 are reserved. |
| 3 | REASON, on the EOS frame of an AUDIO_UP take only: the take was recorded while an APPROVAL was on screen, to give the reason for denying it (see APPROVAL). |
```

In `protocol/frames.md`, replace:

```markdown

## Types
```

with:

```markdown

## Audio codec

A receiver decodes an audio frame by its codec flag, so nothing is negotiated. `vectors.json` holds the step tables and encoded and decoded cases that the bridge's tests and the firmware's host tests both pass; the reference is `protocol/gen_vectors.py`.

- IMA-ADPCM, 4 bits a sample, integer arithmetic only, so every decoder gives the same bits. Both tables (89 steps, and the index adjustments -1, -1, -1, -1, 2, 4, 6, 8) are in the vectors.
- A frame is self-contained: `pred:s16, index:u8, pad:u8`, then the nibbles of samples 1 to n-1, two to a byte, the first in the low half. `pred` is sample 0 and is not coded. `index` is the step index in effect for sample 1 (0 to 88). `pad` is 1 when n - 1 is odd and the last nibble is padding. The sample count is `1 + 2 * (len - 4) - pad`. A lost frame costs only that frame.
- An encoder carries the step index from one frame to the next of a stream (the next frame's header says it), so a frame is not coded from the smallest step. The first frame of a stream starts at index 0.
- 20 ms is 320 samples up (640 bytes become 164) and 480 samples down (960 bytes become 244). An empty AUDIO frame (the EOS) stays empty.
- Credit, the S3's ring and PLAYED all count decoded PCM bytes, so they mean what they meant before. PLAYED's crc32 is over the PCM the S3 decoded; the bridge decodes its own frames to know what to expect.

## Types
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/adpcm.test.js`
Expected: PASS, 9 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 745 tests, the tools' 17, and `125 cases, 598 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/adpcm.js bridge/test/link/adpcm.test.js protocol/frames.md protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 2: adpcm: IMA-ADPCM frames, with a Python reference and its vectors" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sealed frames on the firmware: the Crypto seam, Session, and a test-only reference crypto

The same `Session` in C++11, behind `proto::Crypto`, three function pointers (HKDF-SHA256, AES-256-GCM seal, AES-256-GCM open) so that the logic can be compiled and tested on the PC with no mbedtls. The host needs a real primitive to run the vectors Node made, so `firmware/host/ref_crypto.cpp` is a portable reference AES-256, GHASH, SHA-256, HMAC and HKDF written for tests only; its first job is to match `seal-vectors.json`, which is what proves both it and `Session`. Task 8 adds the device's adapter over mbedtls behind the same seam.

**Files:**
- Create: `firmware/lib/proto/src/proto/crypto.h`, `firmware/lib/proto/src/proto/session.cpp`, `firmware/lib/proto/src/proto/session.h`
- Test (new): `firmware/host/ref_crypto.cpp`, `firmware/host/ref_crypto.h`, `firmware/host/test_session.cpp`
- Test (changed): `firmware/host/run.mjs`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/ref_crypto.cpp`:

```cpp
// ref_crypto.cpp: see ref_crypto.h. Short and slow on purpose: nothing here is constant time, and it never ships.
#include "ref_crypto.h"
#include <string.h>

namespace {
// ---- AES-256 ----
uint8_t sbox[256];
bool sboxReady = false;

uint8_t rotl8(uint8_t x, int n) { return (uint8_t)((x << n) | (x >> (8 - n))); }

void initSbox() {
  if (sboxReady) return;
  uint8_t p = 1, q = 1;
  do {
    p = (uint8_t)(p ^ (uint8_t)(p << 1) ^ ((p & 0x80) ? 0x1B : 0));  // p times 3
    q = (uint8_t)(q ^ (uint8_t)(q << 1));                            // q divided by 3
    q = (uint8_t)(q ^ (uint8_t)(q << 2));
    q = (uint8_t)(q ^ (uint8_t)(q << 4));
    if (q & 0x80) q = (uint8_t)(q ^ 0x09);
    sbox[p] = (uint8_t)(q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63);
  } while (p != 1);
  sbox[0] = 0x63;
  sboxReady = true;
}

uint8_t xtime(uint8_t x) { return (uint8_t)((x << 1) ^ ((x & 0x80) ? 0x1B : 0)); }

struct Aes {
  uint8_t rk[15 * 16];
  explicit Aes(const uint8_t* key) {
    initSbox();
    memcpy(rk, key, 32);
    uint8_t rcon = 1;
    for (int i = 8; i < 60; i++) {
      uint8_t t[4];
      memcpy(t, rk + 4 * (i - 1), 4);
      if (i % 8 == 0) {
        uint8_t u = t[0];
        t[0] = (uint8_t)(sbox[t[1]] ^ rcon);
        t[1] = sbox[t[2]];
        t[2] = sbox[t[3]];
        t[3] = sbox[u];
        rcon = xtime(rcon);
      } else if (i % 8 == 4) {
        for (int k = 0; k < 4; k++) t[k] = sbox[t[k]];
      }
      for (int k = 0; k < 4; k++) rk[4 * i + k] = (uint8_t)(rk[4 * (i - 8) + k] ^ t[k]);
    }
  }
  void encrypt(const uint8_t* in, uint8_t* out) const {
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = (uint8_t)(in[i] ^ rk[i]);
    for (int round = 1; round <= 14; round++) {
      uint8_t t[16];
      for (int c = 0; c < 4; c++)  // SubBytes and ShiftRows
        for (int r = 0; r < 4; r++) t[4 * c + r] = sbox[s[4 * ((c + r) % 4) + r]];
      if (round < 14) {
        for (int c = 0; c < 4; c++) {  // MixColumns
          uint8_t* a = t + 4 * c;
          uint8_t a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
          a[0] = (uint8_t)(xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3);
          a[1] = (uint8_t)(a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3);
          a[2] = (uint8_t)(a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3));
          a[3] = (uint8_t)((xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3));
        }
      }
      for (int i = 0; i < 16; i++) s[i] = (uint8_t)(t[i] ^ rk[16 * round + i]);
    }
    memcpy(out, s, 16);
  }
};

// ---- GCM ----
void gmul(uint8_t* x, const uint8_t* h) {  // x = x * h in GF(2^128), the bit order of the GCM specification
  uint8_t z[16] = {0}, v[16];
  memcpy(v, h, 16);
  for (int i = 0; i < 128; i++) {
    if ((x[i / 8] >> (7 - i % 8)) & 1)
      for (int k = 0; k < 16; k++) z[k] ^= v[k];
    uint8_t lsb = v[15] & 1;
    for (int k = 15; k > 0; k--) v[k] = (uint8_t)((v[k] >> 1) | (v[k - 1] << 7));
    v[0] = (uint8_t)(v[0] >> 1);
    if (lsb) v[0] ^= 0xE1;
  }
  memcpy(x, z, 16);
}

void ghashUpdate(uint8_t* y, const uint8_t* h, const uint8_t* data, size_t len) {
  for (size_t off = 0; off < len; off += 16) {
    size_t n = len - off < 16 ? len - off : 16;
    for (size_t k = 0; k < n; k++) y[k] ^= data[off + k];
    gmul(y, h);
  }
}

void putBe64(uint8_t* p, uint64_t v) {
  for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (56 - 8 * i));
}

// The tag for (aad, ciphertext) under key and a 96-bit nonce.
void gcmTag(const Aes& aes, const uint8_t* h, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* ct,
            size_t len, uint8_t* tag) {
  uint8_t y[16] = {0}, lens[16], j0[16], e[16];
  ghashUpdate(y, h, aad, aadLen);
  ghashUpdate(y, h, ct, len);
  putBe64(lens, (uint64_t)aadLen * 8);
  putBe64(lens + 8, (uint64_t)len * 8);
  ghashUpdate(y, h, lens, 16);
  memcpy(j0, nonce, 12);
  j0[12] = j0[13] = j0[14] = 0;
  j0[15] = 1;
  aes.encrypt(j0, e);
  for (int k = 0; k < 16; k++) tag[k] = (uint8_t)(y[k] ^ e[k]);
}

void gcmCtr(const Aes& aes, const uint8_t* nonce, const uint8_t* in, size_t len, uint8_t* out) {
  uint8_t cb[16], ks[16];
  memcpy(cb, nonce, 12);
  uint32_t ctr = 2;  // 1 is for the tag
  for (size_t off = 0; off < len; off += 16) {
    cb[12] = (uint8_t)(ctr >> 24);
    cb[13] = (uint8_t)(ctr >> 16);
    cb[14] = (uint8_t)(ctr >> 8);
    cb[15] = (uint8_t)ctr;
    aes.encrypt(cb, ks);
    size_t n = len - off < 16 ? len - off : 16;
    for (size_t k = 0; k < n; k++) out[off + k] = (uint8_t)(in[off + k] ^ ks[k]);
    ctr++;
  }
}

bool refGcmSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                uint8_t* out, uint8_t* tag) {
  Aes aes(key);
  uint8_t zero[16] = {0}, h[16];
  aes.encrypt(zero, h);
  gcmCtr(aes, nonce, in, len, out);
  gcmTag(aes, h, nonce, aad, aadLen, out, len, tag);
  return true;
}

bool refGcmOpen(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                const uint8_t* tag, uint8_t* out) {
  Aes aes(key);
  uint8_t zero[16] = {0}, h[16], want[16];
  aes.encrypt(zero, h);
  gcmTag(aes, h, nonce, aad, aadLen, in, len, want);
  uint8_t diff = 0;
  for (int k = 0; k < 16; k++) diff |= (uint8_t)(want[k] ^ tag[k]);
  if (diff) return false;
  gcmCtr(aes, nonce, in, len, out);
  return true;
}

// ---- SHA-256, HMAC, HKDF ----
const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

struct Sha256 {
  uint32_t h[8];
  uint8_t buf[64];
  size_t used;
  uint64_t total;
  Sha256() : used(0), total(0) {
    static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(h, init, sizeof h);
  }
  void block(const uint8_t* p) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
      w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) | ((uint32_t)p[4 * i + 2] << 8) | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      uint32_t t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i];
      uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  void update(const uint8_t* p, size_t n) {
    total += n;
    while (n) {
      size_t take = 64 - used < n ? 64 - used : n;
      memcpy(buf + used, p, take);
      used += take;
      p += take;
      n -= take;
      if (used == 64) {
        block(buf);
        used = 0;
      }
    }
  }
  void finish(uint8_t* out) {
    uint64_t bits = total * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (used != 56) update(&zero, 1);
    uint8_t len[8];
    putBe64(len, bits);
    update(len, 8);
    for (int i = 0; i < 8; i++) {
      out[4 * i] = (uint8_t)(h[i] >> 24);
      out[4 * i + 1] = (uint8_t)(h[i] >> 16);
      out[4 * i + 2] = (uint8_t)(h[i] >> 8);
      out[4 * i + 3] = (uint8_t)h[i];
    }
  }
};

void hmac(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  uint8_t k[64] = {0}, ipad[64], opad[64], inner[32];
  if (keyLen > 64) {
    Sha256 s;
    s.update(key, keyLen);
    s.finish(k);
  } else {
    memcpy(k, key, keyLen);
  }
  for (int i = 0; i < 64; i++) {
    ipad[i] = (uint8_t)(k[i] ^ 0x36);
    opad[i] = (uint8_t)(k[i] ^ 0x5c);
  }
  Sha256 a;
  a.update(ipad, 64);
  for (int i = 0; i < n; i++) a.update(parts[i], lens[i]);
  a.finish(inner);
  Sha256 b;
  b.update(opad, 64);
  b.update(inner, 32);
  b.finish(out);
}

bool refHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
             uint8_t* okm, size_t okmLen) {
  if (okmLen > 255 * 32) return false;
  uint8_t zeros[32] = {0}, prk[32];
  const uint8_t* ikmParts[1] = {ikm};
  size_t ikmLens[1] = {ikmLen};
  if (saltLen == 0) hmac(zeros, 32, ikmParts, ikmLens, 1, prk);
  else hmac(salt, saltLen, ikmParts, ikmLens, 1, prk);
  uint8_t t[32];
  size_t tLen = 0;
  for (size_t done = 0, i = 1; done < okmLen; i++) {
    uint8_t counter = (uint8_t)i;
    const uint8_t* parts[3] = {t, info, &counter};
    size_t lens[3] = {tLen, infoLen, 1};
    hmac(prk, 32, parts, lens, 3, t);
    tLen = 32;
    size_t take = okmLen - done < 32 ? okmLen - done : 32;
    memcpy(okm + done, t, take);
    done += take;
  }
  return true;
}
}  // namespace

const proto::Crypto& refCrypto() {
  static const proto::Crypto c = {refHkdf, refGcmSeal, refGcmOpen};
  return c;
}
```

Create `firmware/host/ref_crypto.h`:

```cpp
// ref_crypto.h: AES-256-GCM and HKDF-SHA256 in plain C++, for the host tests only. The device uses mbedtls (src/crypto_mbedtls.cpp);
// this exists so that the session logic, which is the same code on both, can run on the PC against vectors made by Node's OpenSSL.
#pragma once
#include "proto/crypto.h"

const proto::Crypto& refCrypto();
```

In `firmware/host/run.mjs`, replace:

```js
const v = JSON.parse(readFileSync(path.join(root, 'protocol', 'vectors.json'), 'utf8'));
const str = (s) => JSON.stringify(s); // the vectors' strings are ASCII, so a JSON string is a valid C literal
```

with:

```js
const v = JSON.parse(readFileSync(path.join(root, 'protocol', 'vectors.json'), 'utf8'));
const sv = JSON.parse(readFileSync(path.join(root, 'protocol', 'seal-vectors.json'), 'utf8'));
const str = (s) => JSON.stringify(s); // the vectors' strings are ASCII, so a JSON string is a valid C literal
```

In `firmware/host/run.mjs`, replace:

```js
struct MsgVec { const char* name; const char* hex; };
static const HexU32 kCrc16[] = {
```

with:

```js
struct MsgVec { const char* name; const char* hex; };
struct HkdfVec { const char* name; const char* ikm; const char* salt; const char* info; int length; const char* okm; };
struct SealVec { uint8_t dir; uint8_t type; uint8_t flags; uint16_t seq; uint32_t counter; const char* plain; const char* envelope; };
static const HexU32 kCrc16[] = {
```

In `firmware/host/run.mjs`, replace:

```js
  ${list(v.messages.map((m) => `{${str(m.name)}, ${str(m.hex)}}`))}};
static const char* const kPatternFirst8 = ${str(v.pattern.first8)};
```

with:

```js
  ${list(v.messages.map((m) => `{${str(m.name)}, ${str(m.hex)}}`))}};
static const HkdfVec kHkdf[] = {
  ${list(sv.hkdf.map((k) => `{${str(k.name)}, ${str(k.ikm)}, ${str(k.salt)}, ${str(k.info)}, ${k.length}, ${str(k.okm)}}`))}};
static const char* const kSealMaster = ${str(sv.session.master)};
static const uint32_t kSealNonceP = ${sv.session.nonceP}u;
static const uint32_t kSealNonceS = ${sv.session.nonceS}u;
static const SealVec kSealFrames[] = {
  ${list(sv.frames.map((f) => `{${f.dir}, ${f.type}, ${f.flags}, ${f.seq}, ${f.counter}u, ${str(f.plain)}, ${str(f.envelope)}}`))}};
static const uint32_t kReplayCounters[] = {${sv.replay.counters.map((c) => `${c}u`).join(', ')}};
static const uint8_t kReplayAccepted[] = {${sv.replay.accepted.join(', ')}};
static const char* const kPatternFirst8 = ${str(v.pattern.first8)};
```

Create `firmware/host/test_session.cpp`:

```cpp
// test_session.cpp: sealed frames (protocol/frames.md, "Sealed frames") against protocol/seal-vectors.json, which the bridge's
// tests pass as well. The primitives are host/ref_crypto.cpp's; the device's mbedtls ones are checked on the device itself.
#include <string.h>
#include "check.h"
#include "proto/crc.h"
#include "proto/frame.h"
#include "proto/session.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
using proto::Session;

std::vector<uint8_t> master() { return unhex(kSealMaster); }

bool begin(Session& s, proto::Role role, uint32_t counter = 0, uint32_t nonceS = kSealNonceS) {
  std::vector<uint8_t> m = master();
  return s.begin(refCrypto(), m.data(), kSealNonceP, nonceS, role, counter);
}

// A frame as the wire layer would hand it over: header fields and the sealed payload.
struct Wire {
  uint8_t type, flags;
  uint16_t seq;
  std::vector<uint8_t> payload;
};

proto::Frame asFrame(const Wire& w) {
  proto::Frame f = proto::Frame();
  f.type = w.type;
  f.flags = w.flags;
  f.seq = w.seq;
  f.len = (uint16_t)w.payload.size();
  f.payload = w.payload.data();
  return f;
}

// The envelope bytes of a sealed frame: type, flags, seq, len, payload, CRC-16.
std::string envelopeHex(const Wire& w) {
  std::vector<uint8_t> e;
  e.push_back(w.type);
  e.push_back(w.flags);
  e.push_back((uint8_t)w.seq);
  e.push_back((uint8_t)(w.seq >> 8));
  e.push_back((uint8_t)w.payload.size());
  e.push_back((uint8_t)(w.payload.size() >> 8));
  e.insert(e.end(), w.payload.begin(), w.payload.end());
  uint16_t crc = proto::crc16(e.data(), e.size());
  e.push_back((uint8_t)crc);
  e.push_back((uint8_t)(crc >> 8));
  return tohex(e.data(), e.size());
}

Wire sealOne(Session& s, uint8_t type, uint8_t flags, uint16_t seq, const std::vector<uint8_t>& plain) {
  Wire w;
  w.type = type;
  w.flags = (uint8_t)(flags | proto::F_SEALED);
  w.seq = seq;
  w.payload.resize(plain.size() + proto::SEAL_OVERHEAD);
  size_t n = s.seal(type, flags, seq, plain.data(), plain.size(), w.payload.data(), w.payload.size());
  w.payload.resize(n);
  return w;
}

Session::Open openOne(Session& s, const Wire& w, std::vector<uint8_t>* plain = nullptr) {
  std::vector<uint8_t> out(w.payload.size() + 1);
  size_t n = 0;
  proto::Frame f = asFrame(w);
  Session::Open r = s.open(f, out.data(), out.size(), n);
  if (plain) plain->assign(out.begin(), out.begin() + (long)n);
  return r;
}

Wire fromEnvelope(const std::string& hex) {
  std::vector<uint8_t> e = unhex(hex.c_str());
  Wire w;
  w.type = e[0];
  w.flags = e[1];
  w.seq = (uint16_t)(e[2] | (e[3] << 8));
  w.payload.assign(e.begin() + 6, e.end() - 2);
  return w;
}
}  // namespace

TEST(sessionHkdfMatchesTheRfcAndTheVectors) {
  CHECK(tohex(unhex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865").data(), 42) ==
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
        "the helper itself");
  for (const HkdfVec& v : kHkdf) {
    std::vector<uint8_t> ikm = unhex(v.ikm), salt = unhex(v.salt), info = unhex(v.info), okm((size_t)v.length);
    CHECK(refCrypto().hkdf(ikm.data(), ikm.size(), salt.data(), salt.size(), info.data(), info.size(), okm.data(), okm.size()),
          v.name);
    CHECK(tohex(okm.data(), okm.size()) == v.okm, v.name);
  }
  CHECK(strcmp(kHkdf[0].okm, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865") == 0,
        "RFC 5869 test case 1");
}

TEST(sessionSealsTheVectorEnvelopesByteForByte) {
  for (const SealVec& v : kSealFrames) {
    Session s;
    CHECK(begin(s, v.dir == 1 ? proto::ROLE_PC : proto::ROLE_S3, v.counter), "begin");
    Wire w = sealOne(s, v.type, v.flags, v.seq, unhex(v.plain));
    CHECK(envelopeHex(w) == v.envelope, "sealed envelope");
  }
}

TEST(sessionOpensTheVectorEnvelopesAtTheOtherEnd) {
  for (const SealVec& v : kSealFrames) {
    Session s;
    CHECK(begin(s, v.dir == 1 ? proto::ROLE_S3 : proto::ROLE_PC), "begin");
    std::vector<uint8_t> plain;
    CHECK(openOne(s, fromEnvelope(v.envelope), &plain) == Session::Ok, "opens");
    CHECK(tohex(plain.data(), plain.size()) == v.plain, "the plain payload comes out as it went in");
  }
}

TEST(sessionACrossingRoundTripInBothDirections) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  std::vector<uint8_t> got;
  CHECK(openOne(s3, sealOne(pc, 0x02, 0, 1, unhex("01020304")), &got) == Session::Ok && tohex(got.data(), got.size()) == "01020304",
        "PC to S3");
  CHECK(openOne(pc, sealOne(s3, 0x03, 0, 1, unhex("70"))) == Session::Ok, "S3 to PC");
}

TEST(sessionAChangedByteAnywhereIsRefused) {
  const SealVec& v = kSealFrames[2];
  std::vector<uint8_t> env = unhex(v.envelope);
  size_t spots[] = {0, 1, 2, 6, 10, env.size() - 3};  // type, flags, seq, counter, a ciphertext byte, the tag's last byte
  for (size_t at : spots) {
    Session s;
    CHECK(begin(s, proto::ROLE_PC), "begin");
    std::vector<uint8_t> bad = env;
    bad[at] ^= 1;
    Wire w;
    w.type = bad[0];
    w.flags = bad[1];
    w.seq = (uint16_t)(bad[2] | (bad[3] << 8));
    w.payload.assign(bad.begin() + 6, bad.end() - 2);
    CHECK(openOne(s, w) != Session::Ok, "refused");
  }
}

TEST(sessionTheReceiveRuleAcceptsOnlyACounterAboveEveryAcceptedOne) {
  Session s3;
  CHECK(begin(s3, proto::ROLE_S3), "begin");
  for (size_t i = 0; i < sizeof kReplayCounters / sizeof kReplayCounters[0]; i++) {
    Session pc;
    CHECK(begin(pc, proto::ROLE_PC, kReplayCounters[i]), "begin");
    bool ok = openOne(s3, sealOne(pc, 0x02, 0, 0, unhex("00000000"))) == Session::Ok;
    CHECK(ok == (kReplayAccepted[i] != 0), "accepted or not, as the vector says");
  }
}

TEST(sessionAReplayIsRefusedAsReplayAndDoesNotMoveTheCounter) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire f1 = sealOne(pc, 0x02, 0, 1, unhex("01000000"));
  Wire f2 = sealOne(pc, 0x02, 0, 2, unhex("02000000"));
  CHECK(openOne(s3, f2) == Session::Ok, "the later one opens");
  CHECK(openOne(s3, f2) == Session::Replay, "again: replay");
  CHECK(openOne(s3, f1) == Session::Replay, "the earlier one: replay");
}

TEST(sessionAFrameThatFailsTheTagDoesNotMoveTheCounter) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire f = sealOne(pc, 0x02, 0, 1, unhex("01000000"));
  Wire forged = f;
  forged.payload.back() ^= 0xFF;
  CHECK(openOne(s3, forged) == Session::Tag, "the forgery fails the tag");
  CHECK(openOne(s3, f) == Session::Ok, "the real frame still opens");
}

TEST(sessionAFrameWithoutTheSealBitOrTooShortIsRefused) {
  Session s3;
  CHECK(begin(s3, proto::ROLE_S3), "begin");
  Wire plain;
  plain.type = 0x02;
  plain.flags = 0;
  plain.seq = 0;
  plain.payload = unhex("01000000");
  CHECK(openOne(s3, plain) == Session::Plain, "no seal bit");
  Wire shortFrame = plain;
  shortFrame.flags = proto::F_SEALED;
  shortFrame.payload.assign(proto::SEAL_OVERHEAD - 1, 0);
  CHECK(openOne(s3, shortFrame) == Session::Short, "too short for a counter and a tag");
}

TEST(sessionCannotOpenWhatItSealedItself) {
  Session pc;
  CHECK(begin(pc, proto::ROLE_PC), "begin");
  CHECK(openOne(pc, sealOne(pc, 0x02, 0, 0, unhex("01000000"))) == Session::Tag, "the two directions have two keys");
}

TEST(sessionFailuresCountsRefusalsInARowAndRestartsAtTheFirstFrameThatOpens) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire plain;
  plain.type = 0x02;
  plain.flags = 0;
  plain.seq = 0;
  plain.payload = unhex("01000000");
  openOne(s3, plain);
  openOne(s3, plain);
  CHECK(s3.failures() == 2, "two refusals");
  CHECK(openOne(s3, sealOne(pc, 0x02, 0, 1, unhex("01000000"))) == Session::Ok, "a good frame");
  CHECK(s3.failures() == 0, "back to zero");
}

TEST(sessionOtherNoncesOrAnotherKeyCannotOpenTheFrame) {
  Session pc, other, wrong;
  CHECK(begin(pc, proto::ROLE_PC) && begin(other, proto::ROLE_S3, 0, kSealNonceS + 1), "begin");
  uint8_t zeros[32];
  memset(zeros, 9, sizeof zeros);
  CHECK(wrong.begin(refCrypto(), zeros, kSealNonceP, kSealNonceS, proto::ROLE_S3), "begin with another key");
  CHECK(openOne(other, sealOne(pc, 0x02, 0, 0, unhex("01000000"))) != Session::Ok, "another S3 nonce");
  CHECK(openOne(wrong, sealOne(pc, 0x02, 0, 1, unhex("01000000"))) != Session::Ok, "another master key");
}

TEST(sessionTheLargestPayloadThatSealsIs1004BytesAndOneMoreIsRefused) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  CHECK(proto::MAX_PLAIN == 1004, "the constant");
  std::vector<uint8_t> big(1004, 7);
  Wire w = sealOne(pc, 0x11, 0, 0, big);
  CHECK(w.payload.size() == 1024, "1004 plain bytes seal to the 1024 a frame may hold");
  CHECK(openOne(s3, w) == Session::Ok, "and open");
  std::vector<uint8_t> tooBig(1005, 7), out(1100);
  CHECK(pc.seal(0x11, 0, 1, tooBig.data(), tooBig.size(), out.data(), out.size()) == 0, "one more is refused");
}

TEST(sessionTheSendCounterEndsAt2To32Minus1) {
  Session pc;
  CHECK(begin(pc, proto::ROLE_PC, 0xFFFFFFFFu), "begin");
  uint8_t plain[4] = {1, 0, 0, 0}, out[64];
  CHECK(pc.seal(0x02, 0, 0, plain, 4, out, sizeof out) == 24, "the last counter still seals");
  CHECK(pc.seal(0x02, 0, 1, plain, 4, out, sizeof out) == 0, "the next is refused");
}

TEST(sessionAnEmptyPayloadSealsAndOpens) {
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  std::vector<uint8_t> got(1, 1);
  CHECK(openOne(s3, sealOne(pc, 0x3F, 0, 3, std::vector<uint8_t>()), &got) == Session::Ok && got.empty(), "empty in, empty out");
}

TEST(sessionAnInactiveOrEndedSessionSealsNothingAndOpensNothing) {
  Session s;
  uint8_t plain[4] = {1, 0, 0, 0}, out[64];
  CHECK(!s.active() && s.seal(0x02, 0, 0, plain, 4, out, sizeof out) == 0, "never begun");
  Session pc, s3;
  CHECK(begin(pc, proto::ROLE_PC) && begin(s3, proto::ROLE_S3), "begin");
  Wire w = sealOne(pc, 0x02, 0, 0, unhex("01000000"));
  s3.end();
  CHECK(!s3.active() && openOne(s3, w) == Session::Inactive, "ended: nothing opens");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/crypto.h: No such file or directory`, `proto/session.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/crypto.h`:

```cpp
// crypto.h: the primitives a link session needs (protocol/frames.md, "Sealed frames"). The device binds them to mbedtls
// (src/crypto_mbedtls.cpp, with the S3's AES hardware); the host tests bind them to a plain C++ version
// (host/ref_crypto.cpp), so the session logic runs on the PC against the same vectors as the bridge.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t KEY_BYTES = 32;
const size_t GCM_NONCE_BYTES = 12;
const size_t GCM_TAG_BYTES = 16;

struct Crypto {
  // HKDF-SHA256 (RFC 5869): okmLen bytes into okm, at most 255 * 32. An empty salt means 32 zero bytes. False on failure.
  bool (*hkdf)(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
               uint8_t* okm, size_t okmLen);
  // AES-256-GCM. gcmSeal writes len bytes of ciphertext to out (which may be the input) and the 16-byte tag; gcmOpen checks the
  // tag first and returns false, writing nothing, when it is wrong.
  bool (*gcmSeal)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  uint8_t* out, uint8_t* tag);
  bool (*gcmOpen)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out);
};
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/session.cpp`:

```cpp
#include "proto/session.h"
#include <string.h>

namespace proto {
namespace {
const char kInfo[] = "walkie-session-v1";
const size_t kInfoLen = sizeof kInfo - 1;

void put32(uint8_t* p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

// HKDF info: "walkie-session-v1" | nonceP u32 LE | nonceS u32 LE | dir u8. Empty salt.
bool deriveKey(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, uint8_t dir, uint8_t* key) {
  uint8_t info[kInfoLen + 9];
  memcpy(info, kInfo, kInfoLen);
  put32(info + kInfoLen, nonceP);
  put32(info + kInfoLen + 4, nonceS);
  info[kInfoLen + 8] = dir;
  return c.hkdf(master, KEY_BYTES, nullptr, 0, info, sizeof info, key, KEY_BYTES);
}

// Nonce: dir u32 LE | counter u64 LE. AAD: type | flags (bit 7 set) | seq u16 LE | sealed length u16 LE | counter u32 LE.
void gcmNonce(uint8_t* n, uint32_t dir, uint32_t counter) {
  put32(n, dir);
  put32(n + 4, counter);
  put32(n + 8, 0);
}

void gcmAad(uint8_t* a, uint8_t type, uint8_t flags, uint16_t seq, uint16_t sealedLen, uint32_t counter) {
  a[0] = type;
  a[1] = (uint8_t)(flags | F_SEALED);
  a[2] = (uint8_t)seq;
  a[3] = (uint8_t)(seq >> 8);
  a[4] = (uint8_t)sealedLen;
  a[5] = (uint8_t)(sealedLen >> 8);
  put32(a + 6, counter);
}
}  // namespace

Session::Session()
    : c_(nullptr), sendDir_(0), recvDir_(0), next_(0), haveRecv_(false), lastRecv_(0), failures_(0), active_(false) {
  memset(sendKey_, 0, sizeof sendKey_);
  memset(recvKey_, 0, sizeof recvKey_);
}

bool Session::begin(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, Role role, uint32_t counter) {
  end();
  if (!c.hkdf || !c.gcmSeal || !c.gcmOpen || !master) return false;
  sendDir_ = role == ROLE_PC ? 1 : 2;
  recvDir_ = role == ROLE_PC ? 2 : 1;
  if (!deriveKey(c, master, nonceP, nonceS, (uint8_t)sendDir_, sendKey_) ||
      !deriveKey(c, master, nonceP, nonceS, (uint8_t)recvDir_, recvKey_)) {
    end();
    return false;
  }
  c_ = &c;
  next_ = counter;
  active_ = true;
  return true;
}

void Session::end() {
  memset(sendKey_, 0, sizeof sendKey_);
  memset(recvKey_, 0, sizeof recvKey_);
  c_ = nullptr;
  next_ = 0;
  haveRecv_ = false;
  lastRecv_ = 0;
  failures_ = 0;
  active_ = false;
}

size_t Session::seal(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* plain, size_t len, uint8_t* out, size_t cap) {
  if (!active_ || len > MAX_PLAIN || cap < len + SEAL_OVERHEAD || next_ > 0xFFFFFFFFull) return 0;
  uint32_t counter = (uint32_t)next_;
  uint8_t nonce[GCM_NONCE_BYTES], aad[10];
  gcmNonce(nonce, sendDir_, counter);
  gcmAad(aad, type, flags, seq, (uint16_t)(len + SEAL_OVERHEAD), counter);
  put32(out, counter);
  if (!c_->gcmSeal(sendKey_, nonce, aad, sizeof aad, plain, len, out + 4, out + 4 + len)) return 0;
  next_++;
  return len + SEAL_OVERHEAD;
}

Session::Open Session::open(const Frame& f, uint8_t* out, size_t cap, size_t& outLen) {
  outLen = 0;
  if (!active_) return Inactive;
  Open r = Ok;
  if (!(f.flags & F_SEALED)) {
    r = Plain;
  } else if (f.len < SEAL_OVERHEAD) {
    r = Short;
  } else {
    const uint8_t* p = f.payload;
    uint32_t counter = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    size_t plainLen = f.len - SEAL_OVERHEAD;
    if (haveRecv_ && counter <= lastRecv_) {
      r = Replay;
    } else if (cap < plainLen) {
      r = Short;
    } else {
      uint8_t nonce[GCM_NONCE_BYTES], aad[10];
      gcmNonce(nonce, recvDir_, counter);
      gcmAad(aad, f.type, f.flags, f.seq, f.len, counter);
      if (!c_->gcmOpen(recvKey_, nonce, aad, sizeof aad, p + 4, plainLen, p + 4 + plainLen, out)) {
        r = Tag;
      } else {
        haveRecv_ = true;
        lastRecv_ = counter;
        outLen = plainLen;
      }
    }
  }
  if (r == Ok) failures_ = 0;
  else failures_++;
  return r;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/session.h`:

```cpp
// session.h: sealed frames (protocol/frames.md, "Sealed frames"). One Session holds the two direction keys derived from the paired
// master key and both nonces of a HELLO, the send counter and the highest counter accepted so far. It is the same logic as
// bridge/src/link/session.js, and both are checked against protocol/seal-vectors.json.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"
#include "proto/frame.h"

namespace proto {
const uint8_t F_SEALED = 0x80;              // flags bit 7: the payload is counter | ciphertext | tag
const size_t SEAL_OVERHEAD = 4 + GCM_TAG_BYTES;  // counter u32 LE plus the tag
const size_t MAX_PLAIN = MAX_PAYLOAD - SEAL_OVERHEAD;

enum Role : uint8_t { ROLE_PC = 1, ROLE_S3 = 2 };

class Session {
 public:
  enum Open { Ok, Plain, Short, Replay, Tag, Inactive };

  Session();
  // Derives both keys. False when the primitives fail or c is null. counter is the first send counter (0 except in tests).
  bool begin(const Crypto& c, const uint8_t* master, uint32_t nonceP, uint32_t nonceS, Role role, uint32_t counter = 0);
  // Forgets the keys and every counter.
  void end();
  bool active() const { return active_; }

  // Seals len bytes into out as counter | ciphertext | tag and returns len + SEAL_OVERHEAD. 0 when inactive, len > MAX_PLAIN, cap
  // is too small or the counter is used up (2^32 - 1 was the last). The caller sets F_SEALED on the frame it sends.
  size_t seal(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* plain, size_t len, uint8_t* out, size_t cap);

  // Opens a received frame into out (cap bytes) and sets outLen. A refused frame changes nothing but failures().
  Open open(const Frame& f, uint8_t* out, size_t cap, size_t& outLen);

  // Refusals in a row; any frame that opens sets it back to 0.
  uint32_t failures() const { return failures_; }

 private:
  const Crypto* c_;
  uint8_t sendKey_[KEY_BYTES];
  uint8_t recvKey_[KEY_BYTES];
  uint32_t sendDir_, recvDir_;
  uint64_t next_;  // the next send counter; above 0xFFFFFFFF means used up
  bool haveRecv_;
  uint32_t lastRecv_;
  uint32_t failures_;
  bool active_;
};
}  // namespace proto
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `141 cases, 698 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 745 tests, the tools' 17, and `141 cases, 698 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/ref_crypto.cpp firmware/host/ref_crypto.h firmware/host/run.mjs firmware/host/test_session.cpp firmware/lib/proto/src/proto/crypto.h firmware/lib/proto/src/proto/session.cpp firmware/lib/proto/src/proto/session.h
git commit -m "Task 3: firmware sealed frames: a Crypto seam, Session, and a test-only reference AES-GCM/HKDF run against the Node vectors" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ADPCM on the firmware

IMA-ADPCM in C++11, checked against the same Python vectors as the bridge's: `adpcmEncode` and `adpcmDecode` with the index in and out, and `adpcmSampleCount` which refuses what cannot be a frame (shorter than its header, an index above 88, a pad flag other than 0 or 1, padding with no nibble to pad). The audio path uses it in Task 10.

**Files:**
- Create: `firmware/lib/proto/src/proto/adpcm.cpp`, `firmware/lib/proto/src/proto/adpcm.h`
- Test (new): `firmware/host/test_adpcm.cpp`
- Test (changed): `firmware/host/run.mjs`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `firmware/host/run.mjs`, replace:

```js
struct HkdfVec { const char* name; const char* ikm; const char* salt; const char* info; int length; const char* okm; };
struct SealVec { uint8_t dir; uint8_t type; uint8_t flags; uint16_t seq; uint32_t counter; const char* plain; const char* envelope; };
```

with:

```js
struct HkdfVec { const char* name; const char* ikm; const char* salt; const char* info; int length; const char* okm; };
struct AdpcmVec { const char* name; const char* pcm; uint8_t indexIn; const char* frame; uint8_t indexOut; const char* decoded; };
struct SealVec { uint8_t dir; uint8_t type; uint8_t flags; uint16_t seq; uint32_t counter; const char* plain; const char* envelope; };
```

In `firmware/host/run.mjs`, replace:

```js
static const uint8_t kReplayAccepted[] = {${sv.replay.accepted.join(', ')}};
static const char* const kPatternFirst8 = ${str(v.pattern.first8)};
```

with:

```js
static const uint8_t kReplayAccepted[] = {${sv.replay.accepted.join(', ')}};
static const int16_t kAdpcmSteps[] = {${v.adpcm.steps.join(', ')}};
static const int8_t kAdpcmIndex[] = {${v.adpcm.indexTable.join(', ')}};
static const AdpcmVec kAdpcm[] = {
  ${list(v.adpcm.cases.map((c) => `{${str(c.name)}, ${str(c.pcm)}, ${c.indexIn}, ${str(c.frame)}, ${c.indexOut}, ${str(c.decoded)}}`))}};
static const char* const kPatternFirst8 = ${str(v.pattern.first8)};
```

Create `firmware/host/test_adpcm.cpp`:

```cpp
// test_adpcm.cpp: IMA-ADPCM frames (protocol/frames.md, "Audio codec") against the "adpcm" vectors of protocol/vectors.json, which
// the bridge's tests pass as well and a Python reference made.
#include <string.h>
#include "check.h"
#include "proto/adpcm.h"
#include "vectors.h"

namespace {
std::vector<int16_t> samplesOf(const std::vector<uint8_t>& b) {
  std::vector<int16_t> s(b.size() / 2);
  for (size_t i = 0; i < s.size(); i++) s[i] = (int16_t)(b[i * 2] | (b[i * 2 + 1] << 8));
  return s;
}
}  // namespace

TEST(adpcmTablesAreTheReferenceTables) {
  CHECK(sizeof kAdpcmSteps / sizeof kAdpcmSteps[0] == 89, "89 steps");
  for (size_t i = 0; i < 89; i++) CHECK(proto::ADPCM_STEPS[i] == kAdpcmSteps[i], "step");
  for (size_t i = 0; i < 8; i++) CHECK(proto::ADPCM_INDEX[i] == kAdpcmIndex[i], "index adjustment");
}

TEST(adpcmEncodesEveryVectorCaseToItsFrameAndStepIndex) {
  for (const AdpcmVec& v : kAdpcm) {
    std::vector<int16_t> pcm = samplesOf(unhex(v.pcm));
    uint8_t out[400];
    uint8_t index = v.indexIn;
    size_t n = proto::adpcmEncode(pcm.data(), pcm.size(), index, out, sizeof out);
    CHECK(tohex(out, n) == v.frame, v.name);
    CHECK(index == v.indexOut, v.name);
  }
}

TEST(adpcmDecodesEveryVectorCaseBitForBit) {
  for (const AdpcmVec& v : kAdpcm) {
    std::vector<uint8_t> frame = unhex(v.frame);
    int16_t out[500];
    size_t n = proto::adpcmDecode(frame.data(), frame.size(), out, 500);
    std::vector<uint8_t> got;
    for (size_t i = 0; i < n; i++) {
      got.push_back((uint8_t)out[i]);
      got.push_back((uint8_t)((uint16_t)out[i] >> 8));
    }
    CHECK(tohex(got.data(), got.size()) == v.decoded, v.name);
  }
}

TEST(adpcmCountsTheSamplesAFrameHoldsAndRejectsWhatCannotBeAFrame) {
  CHECK(proto::adpcmSampleCount(unhex("00000000").data(), 4) == 1, "a bare header holds the one sample it carries");
  CHECK(proto::adpcmSampleCount(unhex("0000000011").data(), 5) == 3, "one byte, two nibbles");
  CHECK(proto::adpcmSampleCount(unhex("0000000111").data(), 5) == 2, "padded: the last nibble is not a sample");
  CHECK(proto::adpcmSampleCount(unhex("000000").data(), 3) == 0, "shorter than its header");
  CHECK(proto::adpcmSampleCount(unhex("00005800").data(), 4) == 1, "index 88 is the largest");
  CHECK(proto::adpcmSampleCount(unhex("00005900").data(), 4) == 0, "index 89 is out of range");
  CHECK(proto::adpcmSampleCount(unhex("00000002").data(), 4) == 0, "a pad flag is 0 or 1");
  CHECK(proto::adpcmSampleCount(unhex("00000001").data(), 4) == 0, "padding with no nibble to pad");
  int16_t out[8];
  CHECK(proto::adpcmDecode(unhex("00005900").data(), 4, out, 8) == 0, "a decode of a bad frame gives nothing");
  std::vector<uint8_t> big = unhex("00000000112233");
  CHECK(proto::adpcmDecode(big.data(), big.size(), out, 4) == 0, "and so does one that does not fit the buffer");
}

TEST(adpcmEncodeRefusesWhatItCannotHold) {
  int16_t pcm[4] = {1, 2, 3, 4};
  uint8_t out[16], index = 0;
  CHECK(proto::adpcmEncode(pcm, 0, index, out, sizeof out) == 0, "no samples");
  CHECK(proto::adpcmEncode(pcm, 4, index, out, 5) == 0, "a buffer too small for the frame");
  CHECK(proto::adpcmEncode(pcm, 4, index, out, 6) == 6, "and one that just fits");
  uint8_t bad = 89;
  CHECK(proto::adpcmEncode(pcm, 4, bad, out, sizeof out) == 0, "a step index out of range");
}

TEST(adpcmTheStepIndexCarriesFromOneFrameToTheNext) {
  std::vector<int16_t> loud(320);
  for (size_t i = 0; i < loud.size(); i++) loud[i] = (i / 8) % 2 ? 12000 : -12000;
  uint8_t a[200], b[200], index = 0;
  size_t na = proto::adpcmEncode(loud.data(), loud.size(), index, a, sizeof a);
  CHECK(na == 164 && index > 0, "a loud frame leaves the index raised");
  uint8_t carried = index;
  size_t nb = proto::adpcmEncode(loud.data(), loud.size(), carried, b, sizeof b);
  CHECK(nb == 164 && b[2] == index, "the next frame states the index it started from");
}

TEST(adpcmFrameSizes) {
  CHECK(proto::adpcmFrameBytes(320) == 164, "20 ms at 16 kHz");
  CHECK(proto::adpcmFrameBytes(480) == 244, "20 ms at 24 kHz");
  CHECK(proto::adpcmFrameBytes(1) == 4, "one sample");
  CHECK(proto::adpcmFrameBytes(2) == 5, "two");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/adpcm.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/adpcm.cpp`:

```cpp
#include "proto/adpcm.h"

namespace proto {
const int16_t ADPCM_STEPS[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,    19,    21,    23,    25,    28,    31,    34,
    37,    41,    45,    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,   130,   143,   157,   173,
    190,   209,   230,   253,   279,   307,   337,   371,   408,   449,   494,   544,   598,   658,   724,   796,   876,
    963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,  2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,
    4871,  5358,  5894,  6484,  7132,  7845,  8630,  9493,  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385,
    24623, 27086, 29794, 32767};
const int8_t ADPCM_INDEX[8] = {-1, -1, -1, -1, 2, 4, 6, 8};

namespace {
int clampInt(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

// The change in the predictor that a nibble stands for, with the step it was coded at.
int delta(uint8_t nibble, int step) {
  int d = step >> 3;
  if (nibble & 4) d += step;
  if (nibble & 2) d += step >> 1;
  if (nibble & 1) d += step >> 2;
  return nibble & 8 ? -d : d;
}
}  // namespace

size_t adpcmFrameBytes(size_t n) { return ADPCM_HEADER + n / 2; }

size_t adpcmSampleCount(const uint8_t* frame, size_t len) {
  if (len < ADPCM_HEADER) return 0;
  uint8_t index = frame[2], pad = frame[3];
  if (index > ADPCM_MAX_INDEX || pad > 1 || (pad == 1 && len == ADPCM_HEADER)) return 0;
  return 1 + (len - ADPCM_HEADER) * 2 - pad;
}

size_t adpcmEncode(const int16_t* pcm, size_t n, uint8_t& index, uint8_t* out, size_t cap) {
  if (n == 0 || index > ADPCM_MAX_INDEX) return 0;
  size_t bytes = adpcmFrameBytes(n);
  if (cap < bytes) return 0;
  int pred = pcm[0];
  int idx = index;
  out[0] = (uint8_t)pred;
  out[1] = (uint8_t)((uint16_t)pcm[0] >> 8);
  out[2] = index;
  out[3] = (uint8_t)((n - 1) % 2);
  for (size_t i = 0; i + ADPCM_HEADER < bytes; i++) out[ADPCM_HEADER + i] = 0;
  for (size_t i = 1; i < n; i++) {
    int step = ADPCM_STEPS[idx];
    int diff = pcm[i] - pred;
    uint8_t nib = 0;
    if (diff < 0) {
      nib = 8;
      diff = -diff;
    }
    if (diff >= step) {
      nib |= 4;
      diff -= step;
    }
    if (diff >= (step >> 1)) {
      nib |= 2;
      diff -= step >> 1;
    }
    if (diff >= (step >> 2)) nib |= 1;
    pred = clampInt(pred + delta(nib, step), -32768, 32767);
    idx = clampInt(idx + ADPCM_INDEX[nib & 7], 0, ADPCM_MAX_INDEX);
    out[ADPCM_HEADER + ((i - 1) >> 1)] |= (uint8_t)(((i - 1) & 1) ? nib << 4 : nib);
  }
  index = (uint8_t)idx;
  return bytes;
}

size_t adpcmDecode(const uint8_t* frame, size_t len, int16_t* pcm, size_t cap) {
  size_t n = adpcmSampleCount(frame, len);
  if (n == 0 || n > cap) return 0;
  int pred = (int16_t)(frame[0] | (frame[1] << 8));
  int idx = frame[2];
  pcm[0] = (int16_t)pred;
  for (size_t i = 1; i < n; i++) {
    uint8_t byte = frame[ADPCM_HEADER + ((i - 1) >> 1)];
    uint8_t nib = ((i - 1) & 1) ? (uint8_t)(byte >> 4) : (uint8_t)(byte & 15);
    pred = clampInt(pred + delta(nib, ADPCM_STEPS[idx]), -32768, 32767);
    idx = clampInt(idx + ADPCM_INDEX[nib & 7], 0, ADPCM_MAX_INDEX);
    pcm[i] = (int16_t)pred;
  }
  return n;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/adpcm.h`:

```cpp
// adpcm.h: IMA-ADPCM, 4 bits a sample (protocol/frames.md, "Audio codec"). A frame is self-contained: a 4-byte header (sample 0
// as s16 LE, the step index in effect for sample 1, a pad flag), then the nibbles of samples 1 to n-1, the first one in the low
// half of a byte. Integer arithmetic only, so every implementation decodes to the same bits as bridge/src/link/adpcm.js.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t ADPCM_HEADER = 4;
const uint8_t ADPCM_MAX_INDEX = 88;
extern const int16_t ADPCM_STEPS[89];
extern const int8_t ADPCM_INDEX[8];

// Bytes a frame of n samples (n >= 1) takes.
size_t adpcmFrameBytes(size_t n);

// Samples a frame holds, or 0 when it cannot be a frame: shorter than its header, an index above 88, a pad flag that is not 0 or
// 1, or padding with no nibble to pad.
size_t adpcmSampleCount(const uint8_t* frame, size_t len);

// Encodes n >= 1 samples into out and returns the frame's length; 0 when n is 0, cap is too small or index is above 88. index
// goes in as the step index to start from and comes out as the one to start the next frame from.
size_t adpcmEncode(const int16_t* pcm, size_t n, uint8_t& index, uint8_t* out, size_t cap);

// Decodes a frame into pcm and returns the sample count; 0 when the frame is invalid or more than cap samples.
size_t adpcmDecode(const uint8_t* frame, size_t len, int16_t* pcm, size_t cap);
}  // namespace proto
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `148 cases, 843 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 745 tests, the tools' 17, and `148 cases, 843 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/run.mjs firmware/host/test_adpcm.cpp firmware/lib/proto/src/proto/adpcm.cpp firmware/lib/proto/src/proto/adpcm.h
git commit -m "Task 4: firmware ADPCM: the same IMA frames as the bridge, against the Python vectors" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The bridge's Link: the sealed handshake, no plain frames once a key is held, a pairing mode, and HELLO v2

`Link` learns to seal. `new Link({ openPort, master })` with a 32-byte key accepts only a HELLO answer that says proto 2 and paired, derives a `Session` from its own nonce and the S3's `nonceS`, seals everything it sends except HELLO, drops every plain frame it receives, and becomes ready only when the first frame from the S3 opens under that session; HELLO repeats every second until then, and after 3 s with nothing that opens it says once that the key is probably wrong. A further answer with the same nonce starts a new session on the new `nonceS`. With no key the link is as before but refuses a paired S3 and says to run `walkie pair`. `pairing: true` is the third mode, for Task 13: plain, no pings, only PAIR frames handed up. The stand-in S3 in `bridge/test/helpers/fake-s3.js` learns proto 2, sealing and the paired and unpaired states, which every later bridge task uses. The HELLO v2 fields and the `HELLO_FLAG` bits are parsed here; the firmware builds them in Task 6.

**Files:**
- Modify: `bridge/src/link/frame.js`, `bridge/src/link/link.js`, `bridge/src/link/messages.js`, `protocol/frames.md`
- Test (new): `bridge/test/link/sealed-link.test.js`
- Test (changed): `bridge/test/helpers/fake-s3.js`, `bridge/test/link/codec.test.js`, `bridge/test/link/messages.test.js`, `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `bridge/test/helpers/fake-s3.js`, replace:

```js
import { CMD, KEY, TEST_OP, parseApprovalReq, parseTestKeys, parseUi } from '../../src/link/messages.js';

```

with:

```js
import { CMD, KEY, TEST_OP, parseApprovalReq, parseTestKeys, parseUi } from '../../src/link/messages.js';
import { Session } from '../../src/link/session.js';

```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
export class FakeS3 extends EventEmitter {
  sent = []; // every frame the bridge wrote, decoded, in order
  #decoder = new FrameDecoder();
```

with:

```js
export class FakeS3 extends EventEmitter {
  sent = []; // every frame the bridge wrote, decoded, in order (a sealed one opened: the plain frame)
  raw = []; // the same frames as they arrived, a sealed one still sealed
  refused = []; // what a session would not open: { reason, frame }
  out = []; // every buffer written to the bridge, to replay
  session = null;
  #decoder = new FrameDecoder();
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  #version;
  #fifo = Buffer.alloc(0);
```

with:

```js
  #version;
  #proto;
  #master;
  #paired;
  #nonceS;
  #hellos = 0;
  #lastNonceP = 0;
  #fifo = Buffer.alloc(0);
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js

  constructor({ ringBytes = 262144, version = '0.0.0-fake' } = {}) {
    super();
```

with:

```js

  // proto 2 answers HELLO the way a walkie that can seal frames does: with nonceS and a flags byte, paired when `master` (the
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d } = {}) {
    super();
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    this.#version = version;
  }
```

with:

```js
    this.#version = version;
    this.#proto = proto;
    this.#master = master;
    this.#paired = master !== null;
    this.#nonceS = nonceS;
  }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    for (const f of this.#decoder.push(buf)) {
      this.sent.push(f);
      setImmediate(() => this.#answer(f));
    }
```

with:

```js
    for (const f of this.#decoder.push(buf)) {
      this.raw.push(f);
      let frame = f;
      if (this.session && f.type !== TYPE.HELLO && f.type !== TYPE.PAIR) {
        const r = this.session.open(f);
        if (!r.ok) {
          this.refused.push({ reason: r.reason, frame: f });
          continue;
        }
        frame = r.frame;
      }
      this.sent.push(frame);
      setImmediate(() => this.#answer(frame));
    }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    switch (f.type) {
      case TYPE.HELLO: {
        const hello = Buffer.alloc(18 + this.#version.length);
        hello[0] = 1;
        hello.writeUInt16LE(16000, 2);
        hello.writeUInt16LE(24000, 4);
        hello.writeUInt32LE(this.#ringBytes, 6);
        hello.writeUInt32LE(1234, 10);
        hello.writeUInt32LE(f.payload.readUInt32LE(1), 14);
        hello.write(this.#version, 18);
        this.feed(TYPE.HELLO, hello);
        this.feed(TYPE.CREDIT, u32(12288));
        break;
      }
      case TYPE.PING:
```

with:

```js
    switch (f.type) {
      case TYPE.HELLO:
        this.#answerHello(f.payload.readUInt32LE(1));
        break;
      case TYPE.PING:
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js

  #test(p) {
```

with:

```js

  #answerHello(nonceP) {
    this.#lastNonceP = nonceP;
    const v2 = this.#proto >= 2;
    const head = v2 ? 23 : 18;
    const hello = Buffer.alloc(head + this.#version.length);
    hello[0] = v2 ? 2 : 1;
    hello.writeUInt16LE(16000, 2);
    hello.writeUInt16LE(24000, 4);
    hello.writeUInt32LE(this.#ringBytes, 6);
    hello.writeUInt32LE(1234, 10);
    hello.writeUInt32LE(nonceP, 14);
    if (v2) {
      const nonceS = (this.#nonceS + this.#hellos++) >>> 0;
      hello.writeUInt32LE(nonceS, 18);
      hello[22] = this.#paired ? 1 : 0;
      this.session = this.#master ? new Session({ master: this.#master, nonceP, nonceS, role: 's3' }) : null;
    }
    hello.write(this.#version, head);
    this.feed(TYPE.HELLO, hello);
    this.feed(TYPE.CREDIT, u32(12288));
  }

  // The S3 starts the link over again, as it does for a repeated HELLO: new session numbers, and credit from 0.
  rehello() {
    this.#answerHello(this.#lastNonceP);
  }

  #test(p) {
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js

  feed(type, payload = Buffer.alloc(0), flags = 0) {
    this.emit('data', Buffer.from(encodeFrame({ type, flags, seq: this.#seq++, payload })));
  }
```

with:

```js

  // `plain` sends a frame unsealed even on a sealed link, as an attacker or a downgrade would.
  feed(type, payload = Buffer.alloc(0), flags = 0, { plain = false } = {}) {
    let frame = { type, flags, seq: this.#seq++, payload };
    if (this.session && !plain && type !== TYPE.HELLO && type !== TYPE.PAIR) frame = this.session.seal(frame);
    const wire = Buffer.from(encodeFrame(frame));
    this.out.push(wire);
    this.emit('data', wire);
  }
```

In `bridge/test/link/codec.test.js`, replace:

```js
    UI: 0x20, BUTTON: 0x21, APPROVAL_REQ: 0x22, APPROVAL_RES: 0x23,
    CMD: 0x30, TEST: 0x31, LOG: 0x3f,
  });
```

with:

```js
    UI: 0x20, BUTTON: 0x21, APPROVAL_REQ: 0x22, APPROVAL_RES: 0x23,
    CMD: 0x30, TEST: 0x31, PAIR: 0x32, LOG: 0x3f,
  });
```

In `bridge/test/link/messages.test.js`, replace:

```js
  hello_device: parseHello,
  pong: parsePong,
```

with:

```js
  hello_device: parseHello,
  hello_device_v2: parseHello,
  pong: parsePong,
```

In `bridge/test/link/messages.test.js`, replace:

```js
  assert.equal(parseHello(Buffer.alloc(17)), null);
  assert.equal(parsePong(Buffer.alloc(15)), null);
```

with:

```js
  assert.equal(parseHello(Buffer.alloc(17)), null);
  const v2 = Buffer.alloc(22);
  v2[0] = 2;
  assert.equal(parseHello(v2), null, 'a proto 2 HELLO carries nonceS and flags, 23 bytes before the version');
  v2[0] = 1;
  assert.notEqual(parseHello(v2), null, 'the same bytes are a fine proto 1 HELLO');
  assert.equal(parsePong(Buffer.alloc(15)), null);
```

Create `bridge/test/link/sealed-link.test.js`:

```js
// The Link with a pairing key: the handshake that proves both ends hold it, sealed frames both ways, and no way back to plaintext.
// The stand-in S3 (test/helpers/fake-s3.js) keeps the other end of the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { pingPayload } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 9);
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const pong = (token) => Buffer.concat([u32(token), u32(1), u32(0), u32(0)]);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const settleFor = async (n = 5) => {
  for (let i = 0; i < n; i++) await settle();
};

async function connect(t, { s3 = {}, link: linkOptions = {}, nonces = [0x5eed1234] } = {}) {
  const device = new FakeS3({ proto: 2, ...s3 });
  let next = 0;
  const link = new Link({ openPort: async () => device, makeNonce: () => nonces[Math.min(next++, nonces.length - 1)], ...linkOptions });
  const seen = { status: [], down: [], hello: [], pong: [], frame: [] };
  for (const name of Object.keys(seen)) link.on(name, (x) => seen[name].push(x));
  t.after(() => link.close());
  await link.start();
  return { device, link, seen };
}

test('a paired walkie and a bridge with its key: ready once the first sealed frame opens, and every frame after HELLO is sealed', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'the link to be ready');
  assert.equal(seen.hello.length, 1);
  assert.equal(seen.hello[0].paired, true);
  assert.equal(link.credit, 12288, 'the sealed CREDIT that proved the key was still counted');
  await until(() => seen.pong.length > 0, 'a PONG to the sealed PING');
  const raw = device.raw.filter((f) => f.type !== TYPE.HELLO);
  assert.ok(raw.length > 0);
  assert.ok(raw.every((f) => f.flags & 0x80), 'every frame after HELLO carries the seal bit');
  assert.equal(device.refused.length, 0, 'and the S3 opened all of them');
  assert.ok(device.raw.filter((f) => f.type === TYPE.HELLO).every((f) => !(f.flags & 0x80)), 'HELLO stays plain');
});

test('the link is not ready until a sealed frame opens: with another key it never is, and after 3 s it says to pair again, once', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { device, link, seen } = await connect(t, { s3: { master: OTHER }, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(device.refused.length > 0, 'the S3 refused the PING sealed under the wrong key');
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await settleFor();
  }
  assert.equal(link.ready, false);
  const said = seen.status.filter((s) => /walkie pair/.test(s));
  assert.equal(said.length, 1, `one message about the key: ${JSON.stringify(seen.status)}`);
  assert.ok(device.frames(TYPE.HELLO).length >= 4, 'and HELLO carries on');
});

test('a plain frame on a sealed link is refused, and 8 refusals in a row start the handshake over with a new nonce', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY }, nonces: [0x11, 0x22, 0x33] });
  await until(() => link.ready, 'ready');
  const before = seen.pong.length;
  device.feed(TYPE.PONG, pong(5), 0, { plain: true });
  await settleFor();
  assert.equal(seen.pong.length, before, 'the plain PONG was not taken');
  assert.equal(link.ready, true, 'one refusal is not the end of the link');
  for (let i = 0; i < 7; i++) device.feed(TYPE.PONG, pong(5), 0, { plain: true });
  await until(() => seen.down.length > 0, 'the link to be called down');
  assert.match(seen.down[0], /refused/);
  await until(() => device.frames(TYPE.HELLO).some((f) => f.payload.readUInt32LE(1) === 0x22), 'a HELLO with the next nonce');
  await until(() => link.ready, 'ready again under a new session');
});

test('a sealed frame replayed is refused', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  link.send(TYPE.PING, pingPayload(5));
  await until(() => seen.pong.some((p) => p.token === 5), 'PONG for token 5');
  const wire = device.out.at(-1);
  const n = seen.pong.length;
  device.emit('data', wire);
  await settleFor();
  assert.equal(seen.pong.length, n, 'the replayed PONG was not taken');
});

test('a walkie that is not paired is not talked to by a bridge that has a key, and nothing but HELLO is sent', async (t) => {
  const { device, link, seen } = await connect(t, { s3: {}, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /not paired/.test(s) && /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO], 'no PING, no plain frame of any kind');
});

test('an older walkie (proto 1) is treated the same way when the bridge has a key', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { proto: 1 }, link: { master: KEY } });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO]);
});

test('a walkie that is paired is not talked to by a bridge with no key, and it says why', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: {} });
  await settleFor();
  assert.equal(link.ready, false);
  assert.ok(seen.status.some((s) => /paired/.test(s) && /walkie pair/.test(s)), JSON.stringify(seen.status));
  assert.deepEqual([...new Set(device.raw.map((f) => f.type))], [TYPE.HELLO]);
});

test('with no key on either side the link is plain, proto 2 or not', async (t) => {
  const { device, link, seen } = await connect(t, { s3: {}, link: {} });
  await until(() => link.ready, 'ready');
  assert.equal(seen.hello[0].proto, 2);
  assert.equal(seen.hello[0].paired, false);
  await until(() => seen.pong.length > 0, 'PONG');
  assert.ok(device.raw.every((f) => !(f.flags & 0x80)), 'nothing is sealed');
});

test('a second HELLO answer with new session numbers while ready: the link keeps going on the new keys', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  device.rehello();
  await settleFor();
  assert.equal(link.ready, true);
  assert.equal(link.credit, 12288, 'credit started over and the new CREDIT was counted');
  link.send(TYPE.PING, pingPayload(9));
  await until(() => seen.pong.some((p) => p.token === 9), 'a PONG on the new session');
  assert.equal(seen.hello.length, 1, 'one hello event for the link');
});

test('pairing mode: plain HELLO, no PING, frames of type PAIR only', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { pairing: true } });
  await until(() => link.ready, 'ready, though the walkie is paired and there is no key');
  device.feed(TYPE.PAIR, Buffer.from([3, 1]), 0, { plain: true });
  await until(() => seen.frame.some((f) => f.type === TYPE.PAIR), 'the PAIR frame');
  assert.deepEqual([...seen.frame.find((f) => f.type === TYPE.PAIR).payload], [3, 1]);
  assert.equal(link.credit, 0, 'a sealed CREDIT it cannot open grants nothing');
  assert.equal(device.raw.filter((f) => f.type === TYPE.PING).length, 0, 'a paired walkie would not answer a plain PING, so none is sent');
  link.send(TYPE.PAIR, Buffer.from([2]));
  await until(() => device.frames(TYPE.PAIR).length === 1, 'the PAIR frame reaching the S3');
  assert.ok(!(device.raw.find((f) => f.type === TYPE.PAIR).flags & 0x80), 'PAIR goes out plain');
});

test('PAIR goes out plain even on a sealed link: the type is never sealed', async (t) => {
  const { device, link } = await connect(t, { s3: { master: KEY }, link: { master: KEY } });
  await until(() => link.ready, 'ready');
  link.send(TYPE.PAIR, Buffer.from([2]));
  await until(() => device.raw.some((f) => f.type === TYPE.PAIR), 'the PAIR frame');
  assert.ok(!(device.raw.find((f) => f.type === TYPE.PAIR).flags & 0x80));
});

test('a key that is not 32 bytes, or a key together with pairing mode, is refused', () => {
  const openPort = async () => new FakeS3();
  assert.throws(() => new Link({ openPort, master: Buffer.alloc(5) }), TypeError);
  assert.throws(() => new Link({ openPort, master: KEY, pairing: true }), TypeError);
  assert.doesNotThrow(() => new Link({ openPort, master: KEY }));
});

test('a frame that cannot be sealed any more takes the link down instead of going out plain', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { master: KEY }, link: { master: KEY, firstCounter: 0xfffffffe } });
  await until(() => link.ready, 'ready');
  await settleFor();
  let sent = 0;
  for (let i = 0; i < 5; i++) if (link.send(TYPE.PING, pingPayload(100 + i))) sent++;
  assert.ok(sent < 5, 'the counter ran out');
  assert.ok(seen.down.some((d) => /counter/.test(d)), JSON.stringify(seen.down));
  assert.ok(device.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'and nothing went out plain');
});
```

In `protocol/gen_vectors.py`, replace:

```python
      'version': '0.1.0'}),
    ('ping', 0x02, 'down', struct.pack('<I', 0x12345678), {'token': 0x12345678}),
```

with:

```python
      'version': '0.1.0'}),
    ('hello_device_v2', 0x01, 'up',
     struct.pack('<BBHHIIIIB', 2, 0, 16000, 24000, 2097152, 123456, NONCE, 0x0A0B0C0D, 3) + b'0.2.0',
     {'proto': 2, 'upRate': 16000, 'downRate': 24000, 'ringBytes': 2097152, 'uptimeMs': 123456, 'nonce': NONCE,
      'nonceS': 0x0A0B0C0D, 'paired': True, 'adpcm': True, 'version': '0.2.0'}),
    ('ping', 0x02, 'down', struct.pack('<I', 0x12345678), {'token': 0x12345678}),
```

In `protocol/vectors.json`, replace:

```json
   }
  },
  {
   "name": "ping",
```

with:

```json
   }
  },
  {
   "name": "hello_device_v2",
   "type": 1,
   "dir": "up",
   "hex": "0200803ec05d0000200040e201003412ed5e0d0c0b0a03302e322e30",
   "fields": {
    "proto": 2,
    "upRate": 16000,
    "downRate": 24000,
    "ringBytes": 2097152,
    "uptimeMs": 123456,
    "nonce": 1592594996,
    "nonceS": 168496141,
    "paired": true,
    "adpcm": true,
    "version": "0.2.0"
   }
  },
  {
   "name": "ping",
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/codec.test.js bridge/test/link/messages.test.js bridge/test/link/sealed-link.test.js`
Expected: FAIL, 16 tests fail: `frame constants match protocol/frames.md`, `payloads from the S3 parse to the vector fields`, `payloads that are too short parse to null`, `a paired walkie and a bridge with its key: ready once the first sealed frame opens, and every frame after HELLO is sealed`, `the link is not ready until a sealed frame opens: with another key it never is, and after 3 s it says to pair again, once`, `a plain frame on a sealed link is refused, and 8 refusals in a row start the handshake over with a new nonce`, and 10 more.

- [ ] **Step 3: Write the implementation**

In `bridge/src/link/frame.js`, replace:

```js
  TEST: 0x31,
  LOG: 0x3f,
```

with:

```js
  TEST: 0x31,
  PAIR: 0x32,
  LOG: 0x3f,
```

In `bridge/src/link/link.js`, replace:

```js
import { FLAG, TYPE, encodeFrame } from './frame.js';
import {
```

with:

```js
import { FLAG, TYPE, encodeFrame } from './frame.js';
import { MAX_PLAIN, Session } from './session.js';
import {
```

In `bridge/src/link/link.js`, replace:

```js
const CREDIT_STALL_MS = 5000;

```

with:

```js
const CREDIT_STALL_MS = 5000;
const PROOF_WAIT_MS = 3000; // a sealed HELLO answer that has not been proved by a frame that opens by now means the keys differ
const REFUSALS_IN_A_ROW = 8;
const NOT_PAIRED = 'walkie is not paired with this PC (or was reset): connect it with the USB cable and run `walkie pair`';
const TOO_OLD =
  'walkie runs firmware that cannot seal frames, and this PC holds a pairing key: flash the new firmware, then run `walkie pair`';
const PAIRED_ELSEWHERE = 'walkie is paired, but this PC has no key for it: connect it with the USB cable and run `walkie pair`';
const WRONG_KEY =
  "walkie did not answer under this PC's pairing key (is it paired with another PC?): connect it with the USB cable and run `walkie pair`";

```

In `bridge/src/link/link.js`, replace:

```js
  #ringBytes = 0;

  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000) }) {
    super();
    this.#openPort = openPort;
```

with:

```js
  #ringBytes = 0;
  #master;
  #pairing;
  #firstCounter;
  #session = null; // set once the S3 answers HELLO with proto 2 and paired
  #pending = false; // the session exists but no frame has opened under it yet
  #pendingSince = 0;
  #warned = false;
  #announced = false;
  #helloInfo = null;

  // `master`: the 32-byte pairing key. With one, the link talks only sealed (protocol/frames.md, "Sealed frames"); without one it
  // is plain, and refuses a walkie that is paired. `pairing` is for `walkie pair`: a plain link that holds no key and does not
  // ping, and hands up only PAIR frames. `firstCounter` is the first send counter of a session, for tests.
  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0 }) {
    super();
    if (master !== null && !(master instanceof Uint8Array && master.length === 32)) throw new TypeError('master must be 32 bytes');
    if (master !== null && pairing) throw new TypeError('a link that is pairing holds no key');
    this.#openPort = openPort;
```

In `bridge/src/link/link.js`, replace:

```js
    this.#makeNonce = makeNonce;
  }
```

with:

```js
    this.#makeNonce = makeNonce;
    this.#master = master;
    this.#pairing = pairing;
    this.#firstCounter = firstCounter;
  }
```

In `bridge/src/link/link.js`, replace:

```js
    if (!this.#port) return false;
    this.#port.write(encodeFrame({ type, flags, seq: this.#seq, payload }));
    this.#seq = (this.#seq + 1) & 0xffff;
```

with:

```js
    if (!this.#port) return false;
    let frame = { type, flags, seq: this.#seq, payload };
    const open = type === TYPE.HELLO || type === TYPE.PAIR; // the two that are always plain
    if (this.#master && !this.#session && !open) return false; // a link with a key has no plain frames, session or not
    if (this.#session && !open) {
      if (payload.length > MAX_PLAIN) throw new RangeError(`a sealed payload holds at most ${MAX_PLAIN} bytes, not ${payload.length}`);
      try {
        frame = this.#session.seal(frame);
      } catch (err) {
        this.#lost(`the send counter is used up (${err.message})`); // never send it plain instead
        return false;
      }
    }
    this.#port.write(encodeFrame(frame));
    this.#seq = (this.#seq + 1) & 0xffff;
```

In `bridge/src/link/link.js`, replace:

```js
    const wasReady = this.#ready;
    this.#ready = false;
    this.#stopTimers();
    this.#credits.reset();
```

with:

```js
    const wasReady = this.#ready;
    this.#ready = false;
    this.#dropSession();
    this.#stopTimers();
    this.#credits.reset();
```

In `bridge/src/link/link.js`, replace:

```js
    this.#nonce = this.#makeNonce();
    clearInterval(this.#helloTimer);
    this.#sayHello();
    this.#helloTimer = setInterval(() => this.#sayHello(), HELLO_EVERY_MS);
  }
```

with:

```js
    this.#nonce = this.#makeNonce();
    this.#dropSession();
    clearInterval(this.#helloTimer);
    this.#sayHello();
    this.#helloTimer = setInterval(() => {
      this.#sayHello();
      if (this.#pending && !this.#warned && Date.now() - this.#pendingSince >= PROOF_WAIT_MS) this.#warn(WRONG_KEY);
    }, HELLO_EVERY_MS);
  }

  #dropSession() {
    this.#session = null;
    this.#pending = false;
    this.#warned = false;
    this.#announced = false;
  }

  // Said once for a handshake, however many HELLOs it takes.
  #warn(message) {
    if (this.#warned) return;
    this.#warned = true;
    this.emit('status', message);
  }
```

In `bridge/src/link/link.js`, replace:

```js
    }
    if (!this.#ready) return; // left over from before walkie answered
```

with:

```js
    }
    if (this.#pairing) {
      if (this.#ready && f.type === TYPE.PAIR) this.emit('frame', f);
      return;
    }
    if (this.#session) {
      const opened = this.#session.open(f);
      if (!opened.ok) {
        if (this.#ready && this.#session.failures >= REFUSALS_IN_A_ROW) this.#lost(`${REFUSALS_IN_A_ROW} frames refused in a row`);
        return;
      }
      f = opened.frame;
      if (this.#pending) this.#becomeReady(f.seq);
    }
    if (!this.#ready) return; // left over from before walkie answered
```

In `bridge/src/link/link.js`, replace:

```js
    if (hello.nonce === this.#nonce) {
      // An answer to this handshake: the S3 has just started the link over.
      const already = this.#ready;
      this.#ready = true;
      this.#ringBytes = hello.ringBytes;
      this.#rxSeq = seq;
      this.#gaps = 0;
      this.#credits.reset();
      this.#failStream(new Error('the S3 started the link over'));
      clearInterval(this.#helloTimer);
      this.#helloTimer = null;
      clearInterval(this.#pingTimer);
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
      if (!already) this.emit('hello', hello);
      return;
```

with:

```js
    if (hello.nonce === this.#nonce) {
      this.#onAnswer(hello, seq);
      return;
```

In `bridge/src/link/link.js`, replace:

```js

  #ping() {
```

with:

```js

  // An answer to this handshake: the S3 has just started the link over.
  #onAnswer(hello, seq) {
    if (!this.#pairing) {
      const sealed = this.#master !== null;
      let problem = null;
      if (sealed) problem = hello.proto < 2 ? TOO_OLD : hello.paired ? null : NOT_PAIRED;
      else if (hello.paired) problem = PAIRED_ELSEWHERE;
      if (problem) {
        if (this.#ready) this.#lost(problem);
        else this.#warn(problem);
        return;
      }
    }
    this.#rxSeq = seq;
    this.#gaps = 0;
    this.#credits.reset();
    this.#failStream(new Error('the S3 started the link over'));
    this.#helloInfo = hello;
    if (!this.#master) {
      this.#becomeReady();
      return;
    }
    // Sealed: the keys come from both nonces, so every answer is a new session. The link is ready once a frame opens under it,
    // which only a walkie that holds the same key can make; until then HELLO goes on.
    this.#session = new Session({ master: this.#master, nonceP: this.#nonce, nonceS: hello.nonceS, role: 'pc', counter: this.#firstCounter });
    if (this.#ready) return;
    if (!this.#pending) {
      this.#pending = true;
      this.#pendingSince = Date.now();
    }
    this.#sendPing();
  }

  #becomeReady() {
    const hello = this.#helloInfo;
    this.#pending = false;
    this.#ready = true;
    this.#ringBytes = hello.ringBytes;
    clearInterval(this.#helloTimer);
    this.#helloTimer = null;
    clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    if (!this.#pairing) {
      this.#lastPong = Date.now();
      this.#pingTimer = setInterval(() => this.#ping(), PING_EVERY_MS);
      this.#ping(); // at once: the S3 shows its offline screen until it has had one
    }
    if (!this.#announced) {
      this.#announced = true;
      this.emit('hello', hello);
    }
  }

  #ping() {
```

In `bridge/src/link/link.js`, replace:

```js
    }
    this.#token = (this.#token + 1) >>> 0;
```

with:

```js
    }
    this.#sendPing();
  }

  #sendPing() {
    this.#token = (this.#token + 1) >>> 0;
```

In `bridge/src/link/link.js`, replace:

```js
  #lost(reason) {
    this.#ready = false;
    this.#stopTimers();
    this.#credits.reset();
```

with:

```js
  #lost(reason) {
    this.#ready = false;
    this.#dropSession();
    this.#stopTimers();
    this.#credits.reset();
```

In `bridge/src/link/messages.js`, replace:

```js

export function parseHello(p) {
  if (p.length < 18) return null;
  return {
    proto: p[0],
```

with:

```js

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
// keys, and a flags byte: bit 0 is set when it is paired, bit 1 when it takes ADPCM.
export const HELLO_FLAG = Object.freeze({ PAIRED: 1, ADPCM: 2 });
export function parseHello(p) {
  if (p.length < 18) return null;
  const hello = {
    proto: p[0],
```

In `bridge/src/link/messages.js`, replace:

```js
    nonce: p.readUInt32LE(14),
    version: p.subarray(18).toString('utf8'),
  };
```

with:

```js
    nonce: p.readUInt32LE(14),
  };
  if (p[0] < 2) return { ...hello, version: p.subarray(18).toString('utf8') };
  if (p.length < 23) return null;
  return {
    ...hello,
    nonceS: p.readUInt32LE(18),
    paired: (p[22] & HELLO_FLAG.PAIRED) !== 0,
    adpcm: (p[22] & HELLO_FLAG.ADPCM) !== 0,
    version: p.subarray(23).toString('utf8'),
  };
```

In `protocol/frames.md`, replace:

```markdown
| 0x31 | TEST | PC to S3, and SNAP chunks S3 to PC | u8 op, then its arguments |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |
```

with:

```markdown
| 0x31 | TEST | PC to S3, and SNAP chunks S3 to PC | u8 op, then its arguments |
| 0x32 | PAIR | both | u8 op, then its argument: see Pairing |
| 0x3F | LOG | S3 to PC | one line of UTF-8 text, no newline |
```

In `protocol/frames.md`, replace:

```markdown
- S3 to PC: `u8 proto (1), u8 reserved (0), u16 up_rate (16000), u16 down_rate (24000), u32 ring_bytes, u32 uptime_ms, u32 nonce`, then the firmware version as UTF-8 to the end of the payload. In an answer, the nonce is the one from the PC's HELLO; in the HELLO the S3 sends at boot, it is 0.
- The PC ignores every frame until an S3 HELLO that carries its current nonce. That HELLO makes the link ready and sets the PC's credit to 0. A second answer with the same nonce (to a repeated HELLO) sets the credit to 0 again, because the S3 started over again. Once the link is ready, a HELLO with nonce 0 means the S3 restarted: the reply being sent fails, and the PC shakes hands again with a new nonce. Any other HELLO was queued before the PC opened the port, and is ignored. The S3's USB port holds output until someone reads it, so a stale HELLO from boot is normal.
```

with:

```markdown
- S3 to PC: `u8 proto (1), u8 reserved (0), u16 up_rate (16000), u16 down_rate (24000), u32 ring_bytes, u32 uptime_ms, u32 nonce`, then the firmware version as UTF-8 to the end of the payload. In an answer, the nonce is the one from the PC's HELLO; in the HELLO the S3 sends at boot, it is 0.
- S3 to PC, proto 2 (a walkie that can seal frames): the same fields, then `u32 nonceS` and `u8 flags` before the version string. `nonceS` is the S3's fresh random half of the session keys. Flags: bit 0 set when the S3 is paired, bit 1 set when it takes ADPCM (see Audio codec). The S3 answers a PC HELLO with proto 2 and starts a new session (keys from the PC's nonce and its `nonceS`, counters at 0) at every HELLO it gets, so a repeated HELLO gives a second answer with another `nonceS`.
- A PC with no key takes a proto 2 answer that says unpaired exactly like a proto 1 answer: plain frames. It refuses a paired S3 and says to run `walkie pair`.
- A PC with a key accepts only an answer that says paired, and then derives the session keys from its nonce and `nonceS`. The link is not ready yet: it becomes ready when the first frame from the S3 opens under those keys (any frame; the PC also sends a sealed PING at once), because only an S3 that holds the same key can make one. HELLO goes on every second until then; if nothing has opened after 3 s the PC says the key is probably wrong. An answer that says unpaired, or proto 1, is refused with a message to run `walkie pair`. Once the link is ready, a further answer with the same nonce starts a new session on the new `nonceS` and sets the credit to 0 again.
- The PC ignores every frame until an S3 HELLO that carries its current nonce. That HELLO makes the link ready and sets the PC's credit to 0. A second answer with the same nonce (to a repeated HELLO) sets the credit to 0 again, because the S3 started over again. Once the link is ready, a HELLO with nonce 0 means the S3 restarted: the reply being sent fails, and the PC shakes hands again with a new nonce. Any other HELLO was queued before the PC opened the port, and is ignored. The S3's USB port holds output until someone reads it, so a stale HELLO from boot is normal.
```

In `protocol/frames.md`, replace:

```markdown

### Credit: flow control for AUDIO_DOWN
```

with:

```markdown

### Pairing (PAIR)

PAIR, type 0x32, is never sealed, in either direction. Its payload is `u8 op`, then: 1 SET (`key:32`), 2 FORGET, 3 OK (`op`: the op it answers), 4 DENIED (`op`).

- `walkie pair` makes a random 32-byte `K`, writes it to `pair.key.new`, and sends SET. The S3 shows a confirmation on its own screen (front key yes, side key no, no answer in 30 s is no). On yes it stores `K` and answers OK, and the PC then renames `pair.key.new` to `pair.key`. On no or a timeout the S3 answers DENIED and the PC deletes `pair.key.new`.
- SET with the key the S3 already holds is answered OK at once, without asking, so that a PC that lost the OK can try again.
- FORGET, after the same confirmation, makes the S3 erase its key and answer OK. The PC then deletes `pair.key`.
- A paired S3 takes SET and FORGET in plain frames, though it refuses every other plain frame: the key press on the device is the authority, and without this a lost key file would lock walkie out of pairing for good. They are accepted on the USB link only.
- The bridge's `Link` has a pairing mode for this: it holds no key, does not ping (a paired S3 would not answer a plain PING) and hands up only PAIR frames.

### Credit: flow control for AUDIO_DOWN
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/codec.test.js bridge/test/link/messages.test.js bridge/test/link/sealed-link.test.js`
Expected: PASS, 29 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 758 tests, the tools' 17, and `148 cases, 843 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/frame.js bridge/src/link/link.js bridge/src/link/messages.js bridge/test/helpers/fake-s3.js bridge/test/link/codec.test.js bridge/test/link/messages.test.js bridge/test/link/sealed-link.test.js protocol/frames.md protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 5: bridge Link: the sealed handshake, no plain frames once a key is held, a pairing mode, and HELLO v2" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: HELLO v2 and PAIR on both ends: builders, parsers and shared vectors

The PAIR frame and HELLO v2 are written down in `protocol/gen_vectors.py` once and pass on both sides: the bridge's builders (`pairSetPayload`, `pairForgetPayload`) and reply parser, and the firmware's `buildHello` with a nonce and flags, `parsePair` and the new constants. Only the S3's HELLO answer changes (`PROTO_VERSION` 2); the PC's HELLO stays proto 1.

**Files:**
- Modify: `bridge/src/link/messages.js`, `firmware/lib/proto/src/proto/frame.h`, `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/usblink.cpp`
- Test (changed): `bridge/test/link/messages.test.js`, `firmware/host/test_state.cpp`, `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `bridge/test/link/messages.test.js`, replace:

```js
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
  parseUi, parseApprovalReq, parseTestKeys,
} from '../../src/link/messages.js';
```

with:

```js
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
  parseUi, parseApprovalReq, parseTestKeys, pairSetPayload, pairForgetPayload, parsePairReply, PAIR_OP,
} from '../../src/link/messages.js';
```

In `bridge/test/link/messages.test.js`, replace:

```js
  test_snap: () => testSnapPayload(),
};
```

with:

```js
  test_snap: () => testSnapPayload(),
  pair_set: (f) => pairSetPayload(hex(f.key)),
  pair_forget: () => pairForgetPayload(),
};
```

In `bridge/test/link/messages.test.js`, replace:

```js
  hello_device_v2: parseHello,
  pong: parsePong,
```

with:

```js
  hello_device_v2: parseHello,
  pair_ok_set: parsePairReply,
  pair_denied_forget: parsePairReply,
  pong: parsePong,
```

In `bridge/test/link/messages.test.js`, replace:

```js

test('payloads that are too short parse to null', () => {
```

with:

```js

test('a pairing key is exactly 32 bytes, and a PAIR reply needs its op and the op it answers', () => {
  assert.throws(() => pairSetPayload(Buffer.alloc(31)), RangeError);
  assert.throws(() => pairSetPayload(Buffer.alloc(33)), RangeError);
  assert.equal(pairSetPayload(Buffer.alloc(32, 1)).length, 33);
  assert.equal(parsePairReply(Buffer.from([3])), null);
  assert.equal(parsePairReply(Buffer.from([1, 1])), null, 'a SET is not a reply');
});

test('payloads that are too short parse to null', () => {
```

In `bridge/test/link/messages.test.js`, replace:

```js
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
});
```

with:

```js
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
});
```

In `firmware/host/test_state.cpp`, replace:

```cpp
#include "proto/credit.h"
#include "proto/messages.h"
```

with:

```cpp
#include "proto/credit.h"
#include "proto/frame.h"
#include "proto/messages.h"
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  uint8_t out[64];
  size_t n = proto::buildHello(16000, 24000, 2097152, 123456, 0x5EED1234u, "0.1.0", out, sizeof out);
  CHECK(tohex(out, n) == msgHex("hello_device"), "hello_device");
  n = proto::buildPong(0x12345678u, 5000, 1, 2, out, sizeof out);
```

with:

```cpp
  uint8_t out[64];
  size_t n = proto::buildHello(16000, 24000, 2097152, 123456, 0x5EED1234u, 0x0A0B0C0Du, proto::HELLO_PAIRED | proto::HELLO_ADPCM, "0.2.0",
                               out, sizeof out);
  CHECK(tohex(out, n) == msgHex("hello_device_v2"), "hello_device_v2");
  n = proto::buildPairReply(proto::PAIR_OK, proto::PAIR_SET, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pair_ok_set"), "pair_ok_set");
  n = proto::buildPairReply(proto::PAIR_DENIED, proto::PAIR_FORGET, out, sizeof out);
  CHECK(tohex(out, n) == msgHex("pair_denied_forget"), "pair_denied_forget");
  CHECK(proto::buildPairReply(proto::PAIR_OK, proto::PAIR_SET, out, 1) == 0, "a pair reply into a short buffer");
  n = proto::buildPong(0x12345678u, 5000, 1, 2, out, sizeof out);
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK(proto::buildPong(1, 2, 3, 4, out, 15) == 0, "pong into a short buffer");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, "0.1.0", out, 22) == 0, "hello into a short buffer");
}
```

with:

```cpp
  CHECK(proto::buildPong(1, 2, 3, 4, out, 15) == 0, "pong into a short buffer");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, 6, 0, "0.1.0", out, 27) == 0, "hello into a short buffer: 23 bytes and the version");
  CHECK(proto::buildHello(1, 2, 3, 4, 5, 6, 0, "0.1.0", out, 28) == 28, "and just enough");
}
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK(!proto::parseHello(b.data(), 4, nonce), "short hello");
  b = unhex(msgHex("ping").c_str());
```

with:

```cpp
  CHECK(!proto::parseHello(b.data(), 4, nonce), "short hello");
  proto::PairMsg pm = proto::PairMsg();
  b = unhex(msgHex("pair_set").c_str());
  CHECK(proto::parsePair(b.data(), b.size(), pm) && pm.op == proto::PAIR_SET && pm.key && tohex(pm.key, 32) == tohex(b.data() + 1, 32),
        "pair_set");
  CHECK(!proto::parsePair(b.data(), 32, pm), "a SET one byte short");
  b.push_back(0);
  CHECK(!proto::parsePair(b.data(), b.size(), pm), "a SET one byte long");
  b = unhex(msgHex("pair_forget").c_str());
  CHECK(proto::parsePair(b.data(), b.size(), pm) && pm.op == proto::PAIR_FORGET && pm.key == nullptr, "pair_forget");
  b = unhex(msgHex("pair_ok_set").c_str());
  CHECK(!proto::parsePair(b.data(), b.size(), pm), "a reply is not a request");
  CHECK(!proto::parsePair(b.data(), 0, pm), "empty");
  b = unhex(msgHex("ping").c_str());
```

In `firmware/host/test_state.cpp`, replace:

```cpp
TEST(messageConstantsMatchSpec) {
  CHECK((unsigned)proto::PROTO_VERSION == 1u, "PROTO_VERSION");
  CHECK((unsigned)proto::CMD_SET_VOLUME == 1u, "CMD_SET_VOLUME");
```

with:

```cpp
TEST(messageConstantsMatchSpec) {
  CHECK((unsigned)proto::PROTO_VERSION == 2u, "PROTO_VERSION: what the S3 says in HELLO");
  CHECK((unsigned)proto::HELLO_PAIRED == 1u && (unsigned)proto::HELLO_ADPCM == 2u, "HELLO flags");
  CHECK((unsigned)proto::PAIR_SET == 1u && (unsigned)proto::PAIR_FORGET == 2u && (unsigned)proto::PAIR_OK == 3u &&
            (unsigned)proto::PAIR_DENIED == 4u,
        "PAIR ops");
  CHECK((unsigned)proto::T_PAIR == 0x32u, "T_PAIR");
  CHECK((unsigned)proto::CMD_SET_VOLUME == 1u, "CMD_SET_VOLUME");
```

In `protocol/gen_vectors.py`, replace:

```python
PCM8 = bytes([0x01, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x34, 0x12])
PIX4 = bytes([0x1F, 0x00, 0xE0, 0x07])
```

with:

```python
PCM8 = bytes([0x01, 0x00, 0xFF, 0x7F, 0x00, 0x80, 0x34, 0x12])
PAIR_KEY = bytes(range(0x40, 0x60))
PIX4 = bytes([0x1F, 0x00, 0xE0, 0x07])
```

In `protocol/gen_vectors.py`, replace:

```python
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('button_cancel', 0x21, 'up', bytes([1]), {'event': 1}),
```

with:

```python
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('pair_set', 0x32, 'down', bytes([1]) + PAIR_KEY, {'op': 1, 'key': h(PAIR_KEY)}),
    ('pair_forget', 0x32, 'down', bytes([2]), {'op': 2}),
    ('pair_ok_set', 0x32, 'up', bytes([3, 1]), {'op': 3, 'answered': 1}),
    ('pair_denied_forget', 0x32, 'up', bytes([4, 2]), {'op': 4, 'answered': 2}),
    ('button_cancel', 0x21, 'up', bytes([1]), {'event': 1}),
```

In `protocol/vectors.json`, replace:

```json
   }
  },
  {
   "name": "button_cancel",
```

with:

```json
   }
  },
  {
   "name": "pair_set",
   "type": 50,
   "dir": "down",
   "hex": "01404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
   "fields": {
    "op": 1,
    "key": "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f"
   }
  },
  {
   "name": "pair_forget",
   "type": 50,
   "dir": "down",
   "hex": "02",
   "fields": {
    "op": 2
   }
  },
  {
   "name": "pair_ok_set",
   "type": 50,
   "dir": "up",
   "hex": "0301",
   "fields": {
    "op": 3,
    "answered": 1
   }
  },
  {
   "name": "pair_denied_forget",
   "type": 50,
   "dir": "up",
   "hex": "0402",
   "fields": {
    "op": 4,
    "answered": 2
   }
  },
  {
   "name": "button_cancel",
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/messages.test.js`
Expected: FAIL, the file `bridge/test/link/messages.test.js` cannot load, because it imports what the source does not have yet.

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `'HELLO_PAIRED' is not a member of 'proto'`, `'HELLO_ADPCM' is not a member of 'proto'`, `'buildPairReply' is not a member of 'proto'`, and 11 more.

- [ ] **Step 3: Write the implementation**

In `bridge/src/link/messages.js`, replace:

```js
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
export const UI_STATE = Object.freeze({ IDLE: 0, TRANSCRIBING: 1, CONFIRM: 2, WORKING: 3, REPLY: 4, ERROR: 5 });
```

with:

```js
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
export const PAIR_OP = Object.freeze({ SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
export const UI_STATE = Object.freeze({ IDLE: 0, TRANSCRIBING: 1, CONFIRM: 2, WORKING: 3, REPLY: 4, ERROR: 5 });
```

In `bridge/src/link/messages.js`, replace:

```js

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
```

with:

```js

// PAIR (protocol/frames.md, "Pairing"): SET carries the 32-byte key, FORGET nothing; the S3 answers OK or DENIED with the op it answers.
export function pairSetPayload(key) {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new RangeError('a pairing key is 32 bytes');
  return Buffer.concat([Buffer.from([PAIR_OP.SET]), key]);
}

export function pairForgetPayload() {
  return Buffer.from([PAIR_OP.FORGET]);
}

export function parsePairReply(p) {
  if (p.length < 2 || (p[0] !== PAIR_OP.OK && p[0] !== PAIR_OP.DENIED)) return null;
  return { op: p[0], answered: p[1] };
}

// Proto 1 ends its fixed part at the nonce. Proto 2 (a walkie that can seal frames) adds nonceS, the S3's half of the session
```

In `firmware/lib/proto/src/proto/frame.h`, replace:

```cpp
  T_TEST = 0x31,
  T_LOG = 0x3F,
```

with:

```cpp
  T_TEST = 0x31,
  T_PAIR = 0x32,
  T_LOG = 0x3F,
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp

size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce,
                  const char* version, uint8_t* out, size_t cap) {
  size_t vlen = strlen(version);
  if (cap < 18 + vlen) return 0;
  uint8_t* p = out;
```

with:

```cpp

size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce, uint32_t nonceS,
                  uint8_t flags, const char* version, uint8_t* out, size_t cap) {
  size_t vlen = strlen(version);
  if (cap < 23 + vlen) return 0;
  uint8_t* p = out;
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp
  p = put32(p, nonce);
  memcpy(p, version, vlen);
  return 18 + vlen;
}
```

with:

```cpp
  p = put32(p, nonce);
  p = put32(p, nonceS);
  *p++ = flags;
  memcpy(p, version, vlen);
  return 23 + vlen;
}

size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap) {
  if (cap < 2) return 0;
  out[0] = op;
  out[1] = answered;
  return 2;
}
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp

bool parsePing(const uint8_t* p, size_t n, uint32_t& token) {
```

with:

```cpp

bool parsePair(const uint8_t* p, size_t n, PairMsg& m) {
  if (n == 33 && p[0] == PAIR_SET) {
    m.op = PAIR_SET;
    m.key = p + 1;
    return true;
  }
  if (n == 1 && p[0] == PAIR_FORGET) {
    m.op = PAIR_FORGET;
    m.key = nullptr;
    return true;
  }
  return false;
}

bool parsePing(const uint8_t* p, size_t n, uint32_t& token) {
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
namespace proto {
const uint8_t PROTO_VERSION = 1;
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5 };
```

with:

```cpp
namespace proto {
const uint8_t PROTO_VERSION = 2;  // what the S3 says in HELLO; the PC's HELLO is still proto 1
enum : uint8_t { HELLO_PAIRED = 1, HELLO_ADPCM = 2 };  // the flags byte of a proto 2 HELLO
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5 };
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
};
struct ApprovalReq {
```

with:

```cpp
};
struct PairMsg {
  uint8_t op;           // PAIR_SET or PAIR_FORGET
  const uint8_t* key;   // SET: the 32 key bytes, inside the payload; FORGET: null
};
struct ApprovalReq {
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
// Builders write the payload to out and return its length, or 0 when cap is too small.
// nonce: the one from the PC's HELLO being answered, or 0 for the HELLO sent at boot.
size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce,
                  const char* version, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
```

with:

```cpp
// Builders write the payload to out and return its length, or 0 when cap is too small.
// nonce: the one from the PC's HELLO being answered, or 0 for the HELLO sent at boot. nonceS: this S3's half of the session keys
// (0 at boot, when there is no session). flags: HELLO_PAIRED, HELLO_ADPCM.
size_t buildHello(uint16_t upRate, uint16_t downRate, uint32_t ringBytes, uint32_t uptimeMs, uint32_t nonce, uint32_t nonceS,
                  uint8_t flags, const char* version, uint8_t* out, size_t cap);
// op: PAIR_OK or PAIR_DENIED; answered: the PC's op it answers.
size_t buildPairReply(uint8_t op, uint8_t answered, uint8_t* out, size_t cap);
size_t buildPong(uint32_t token, uint32_t uptimeMs, uint32_t badChunks, uint32_t seqGaps, uint8_t* out, size_t cap);
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
bool parsePing(const uint8_t* p, size_t n, uint32_t& token);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
```

with:

```cpp
bool parsePing(const uint8_t* p, size_t n, uint32_t& token);
// A PAIR request from the PC: SET with exactly 32 key bytes, or FORGET with nothing after the op. False for anything else.
bool parsePair(const uint8_t* p, size_t n, PairMsg& m);
bool parseCmd(const uint8_t* p, size_t n, Command& c);
```

In `firmware/src/usblink.cpp`, replace:

```cpp
void sayHello(uint32_t nonce) {
  uint8_t p[48];
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, WALKIE_VERSION, p, sizeof p);
  send(proto::T_HELLO, 0, p, (uint16_t)n);
```

with:

```cpp
void sayHello(uint32_t nonce) {
  uint8_t p[56];
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, 0, 0, WALKIE_VERSION, p, sizeof p);
  send(proto::T_HELLO, 0, p, (uint16_t)n);
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/messages.test.js`
Expected: PASS, 10 tests, 0 fail.

Run: `node firmware/host/run.mjs`
Expected: `148 cases, 856 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 759 tests, the tools' 17, and `148 cases, 856 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/messages.js bridge/test/link/messages.test.js firmware/host/test_state.cpp firmware/lib/proto/src/proto/frame.h firmware/lib/proto/src/proto/messages.cpp firmware/lib/proto/src/proto/messages.h firmware/src/usblink.cpp protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 6: HELLO v2 and PAIR on both ends: builders, parsers and shared vectors" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The firmware Gate: the S3's policy for sealed frames and pairing, run on the host

All of what the S3 decides about security, apart from the serial port and the screen, is one pure class, so the host tests can run it. `Gate` owns the `Session`: it starts one at every PC HELLO when paired (with a fresh `nonceS` from an injected `random32`), classifies every received frame (`Drop`, `Hello`, `Pair`, `Deliver`), opens sealed frames and refuses plain ones when paired and sealed ones when not, ends the session after eight refusals in a row, seals what is sent (`wrap`: HELLO and PAIR plain, everything else sealed, and blocked when paired with no session), and handles pairing (`onPair` says whether to ask the person, answer OK at once for the key already held, or ignore; `answer(yes)` stores or erases the key through a `KeyStore` and returns the reply to send). The key never leaves the class. The threading rules are in the header: the caller holds the TX lock around `receive()` and `wrap()`.

**Files:**
- Create: `firmware/lib/proto/src/proto/gate.cpp`, `firmware/lib/proto/src/proto/gate.h`
- Test (new): `firmware/host/test_gate.cpp`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_gate.cpp`:

```cpp
// test_gate.cpp: the S3's policy for sealed frames and pairing (protocol/frames.md, "Sealed frames" and "Pairing"), without a
// device: the primitives are host/ref_crypto.cpp's, the key store is a variable, the "PC" is a second Session.
#include <string.h>
#include "check.h"
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/messages.h"
#include "ref_crypto.h"
#include "vectors.h"

namespace {
using proto::Gate;
using proto::Session;

struct Store {
  static bool has;
  static uint8_t key[32];
  static int saves, erases;
  static bool failSave;
  static bool load(uint8_t* k) {
    if (!has) return false;
    memcpy(k, key, 32);
    return true;
  }
  static bool save(const uint8_t* k) {
    if (failSave) return false;
    memcpy(key, k, 32);
    has = true;
    saves++;
    return true;
  }
  static bool erase() {
    has = false;
    memset(key, 0, 32);
    erases++;
    return true;
  }
  static void reset(bool withKey) {
    has = withKey;
    failSave = false;
    saves = erases = 0;
    std::vector<uint8_t> m = unhex(kSealMaster);
    memset(key, 0, 32);
    if (withKey) memcpy(key, m.data(), 32);
  }
};
bool Store::has = false;
uint8_t Store::key[32];
int Store::saves = 0;
int Store::erases = 0;
bool Store::failSave = false;

const char* msgHexOf(const char* name) {
  for (const MsgVec& m : kMsgs)
    if (strcmp(m.name, name) == 0) return m.hex;
  CHECK(false, name);
  return "";
}

uint32_t g_nonceS = 0;
uint32_t rnd() { return g_nonceS++; }
const uint32_t kP = 0x11223344u;

proto::KeyStore store() {
  proto::KeyStore s;
  s.load = Store::load;
  s.save = Store::save;
  s.erase = Store::erase;
  return s;
}

// A gate that starts paired (with the vector's master key) or not, and the PC's session for the link its HELLO begins.
struct Rig {
  Gate gate;
  Session pc;
  uint8_t plain[1100];
  explicit Rig(bool paired) {
    Store::reset(paired);
    g_nonceS = kSealNonceS;
    CHECK(gate.begin(refCrypto(), store(), rnd), "begin");
  }
  proto::Frame frame(uint8_t type, uint8_t flags, uint16_t seq, const std::vector<uint8_t>& payload) {
    proto::Frame f = proto::Frame();
    f.type = type;
    f.flags = flags;
    f.seq = seq;
    f.len = (uint16_t)payload.size();
    f.payload = payload.data();
    return f;
  }
  // The PC says HELLO with nonce kP; returns what the gate made of it.
  Gate::Rx hello(uint32_t nonceP = kP) {
    std::vector<uint8_t> p = {1, (uint8_t)nonceP, (uint8_t)(nonceP >> 8), (uint8_t)(nonceP >> 16), (uint8_t)(nonceP >> 24)};
    proto::Frame out;
    return gate.receive(frame(proto::T_HELLO, 0, 0, p), out);
  }
  // The PC's session for the HELLO just made (the gate drew `nonceS`).
  void pcBegin(uint32_t nonceP = kP) {
    std::vector<uint8_t> m = unhex(kSealMaster);
    CHECK(pc.begin(refCrypto(), m.data(), nonceP, gate.nonceS(), proto::ROLE_PC), "pc session");
  }
  // A frame as the PC sends it sealed.
  std::vector<uint8_t> sealed(uint8_t type, uint16_t seq, const std::vector<uint8_t>& payload, uint8_t* flagsOut = nullptr) {
    std::vector<uint8_t> out(payload.size() + proto::SEAL_OVERHEAD);
    size_t n = pc.seal(type, 0, seq, payload.data(), payload.size(), out.data(), out.size());
    out.resize(n);
    if (flagsOut) *flagsOut = proto::F_SEALED;
    return out;
  }
};
}  // namespace

TEST(gateAnUnpairedGateDeliversPlainFramesAndDropsSealedOnes) {
  Rig r(false);
  CHECK(!r.gate.paired() && r.gate.helloFlags() == 0, "unpaired");
  std::vector<uint8_t> p = {1, 0, 0, 0};
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_PING, 0, 5, p), out) == Gate::Deliver && out.type == proto::T_PING && out.seq == 5 &&
            out.len == 4 && memcmp(out.payload, p.data(), 4) == 0,
        "a plain PING goes through untouched");
  std::vector<uint8_t> junk(24, 1);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 6, junk), out) == Gate::Drop, "a sealed frame means nothing to an unpaired S3");
}

TEST(gateAHelloAnswersWithTheNoncesAndStartsASessionOnlyWhenPaired) {
  Rig un(false);
  CHECK(un.hello() == Gate::Hello && un.gate.helloNonce() == kP, "the nonce to echo");
  Rig r(true);
  CHECK(r.gate.paired() && (r.gate.helloFlags() & proto::HELLO_PAIRED), "paired flag");
  CHECK(r.hello() == Gate::Hello && r.gate.helloNonce() == kP, "the nonce to echo");
  CHECK(r.gate.nonceS() == kSealNonceS, "nonceS comes from the generator");
  proto::Frame out;
  std::vector<uint8_t> bad = {1, 2};
  CHECK(r.gate.receive(r.frame(proto::T_HELLO, 0, 0, bad), out) == Gate::Drop, "a HELLO too short to carry a nonce");
}

TEST(gateAPairedGateOpensSealedFramesAndRefusesPlainOnes) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 9, p);
  proto::Frame in = r.frame(proto::T_PING, proto::F_SEALED, 9, s), out;
  CHECK(r.gate.receive(in, out) == Gate::Deliver, "the sealed PING opens");
  CHECK(out.type == proto::T_PING && out.seq == 9 && !(out.flags & proto::F_SEALED) && out.len == 4 && memcmp(out.payload, p.data(), 4) == 0,
        "type and seq as sent, the seal bit gone, the plain payload");
  CHECK(r.gate.receive(r.frame(proto::T_PING, 0, 10, p), out) == Gate::Drop, "a plain frame is refused once paired");
  CHECK(r.gate.receive(in, out) == Gate::Drop, "a replay is refused");
}

TEST(gateEightRefusalsInARowEndTheSessionUntilTheNextHello) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  proto::Frame out;
  for (int i = 0; i < 8; i++) CHECK(r.gate.receive(r.frame(proto::T_PING, 0, (uint16_t)i, p), out) == Gate::Drop, "refused");
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 20, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 20, s), out) == Gate::Drop, "even a good frame is dropped now");
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Blocked, "and nothing goes out");
  r.hello(0x55);
  r.pcBegin(0x55);
  s = r.sealed(proto::T_PING, 21, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 21, s), out) == Gate::Deliver, "a new HELLO starts a new session");
}

TEST(gateSevenRefusalsAreNotTheEnd) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  proto::Frame out;
  for (int i = 0; i < 7; i++) r.gate.receive(r.frame(proto::T_PING, 0, (uint16_t)i, p), out);
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 20, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 20, s), out) == Gate::Deliver, "the session is still there");
}

TEST(gateAPairedGateSendsNothingPlainExceptHelloAndPair) {
  Rig r(true);
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Blocked, "no session yet: blocked, never plain");
  CHECK(r.gate.wrap(proto::T_LOG, 0, 1, p.data(), 4, w) == Gate::Blocked, "a LOG too");
  CHECK(r.gate.wrap(proto::T_HELLO, 0, 1, p.data(), 4, w) == Gate::Plain && w.len == 4 && w.payload == p.data() && w.flags == 0, "HELLO stays plain");
  CHECK(r.gate.wrap(proto::T_PAIR, 0, 1, p.data(), 4, w) == Gate::Plain && !(w.flags & proto::F_SEALED), "PAIR stays plain");
}

TEST(gateSealsWhatItSendsAndThePcOpensIt) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {9, 8, 7, 6, 5};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, proto::F_EOS, 3, p.data(), p.size(), w) == Gate::Sealed, "sealed");
  CHECK((w.flags & proto::F_SEALED) && (w.flags & proto::F_EOS) && w.len == p.size() + proto::SEAL_OVERHEAD, "the seal bit is set, the other flags stay");
  proto::Frame f = proto::Frame();
  f.type = proto::T_PONG;
  f.flags = w.flags;
  f.seq = 3;
  f.len = w.len;
  f.payload = w.payload;
  uint8_t out[64];
  size_t n = 0;
  CHECK(r.pc.open(f, out, sizeof out, n) == Session::Ok && n == p.size() && memcmp(out, p.data(), n) == 0, "the PC opens it");
  std::vector<uint8_t> big(proto::MAX_PLAIN + 1, 1);
  CHECK(r.gate.wrap(proto::T_PONG, 0, 4, big.data(), big.size(), w) == Gate::Blocked, "too big to seal: blocked");
}

TEST(gateAnUnpairedGateSendsPlain) {
  Rig r(false);
  r.hello();
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Plain && w.payload == p.data() && w.len == 4 && w.flags == 0, "plain");
}

TEST(gateEveryHelloIsANewSession) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  uint32_t first = r.gate.nonceS();
  std::vector<uint8_t> p = {7, 0, 0, 0};
  std::vector<uint8_t> old = r.sealed(proto::T_PING, 1, p);
  r.hello();
  CHECK(r.gate.nonceS() != first, "another nonceS");
  proto::Frame out;
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 1, old), out) == Gate::Drop, "a frame of the old session does not open");
  r.pcBegin();
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 2, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 2, s), out) == Gate::Deliver, "the new one does");
}

TEST(gatePairSetAsksAndYesStoresTheKeyAndEndsTheSession) {
  Rig r(false);
  r.hello();
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk && op == proto::PAIR_SET, "asks");
  CHECK(Store::saves == 0 && !r.gate.paired(), "nothing stored before the answer");
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_OK && rep.answered == proto::PAIR_SET, "OK for the SET");
  CHECK(Store::saves == 1 && Store::has && memcmp(Store::key, k.data() + 1, 32) == 0, "the key is in the store");
  CHECK(r.gate.paired() && (r.gate.helloFlags() & proto::HELLO_PAIRED), "paired now");
  CHECK(!r.gate.answer(true).send, "the same answer twice does nothing");
  // The next HELLO starts a session under the key that was just paired.
  r.hello();
  Session pc;
  CHECK(pc.begin(refCrypto(), k.data() + 1, kP, r.gate.nonceS(), proto::ROLE_PC), "pc session under the new key");
  uint8_t sealedFrame[32];
  uint8_t body[4] = {7, 0, 0, 0};
  size_t n = pc.seal(proto::T_PING, 0, 1, body, 4, sealedFrame, sizeof sealedFrame);
  proto::Frame in = proto::Frame(), out;
  in.type = proto::T_PING;
  in.flags = proto::F_SEALED;
  in.seq = 1;
  in.len = (uint16_t)n;
  in.payload = sealedFrame;
  CHECK(r.gate.receive(in, out) == Gate::Deliver, "a frame sealed under the new key opens");
}

TEST(gateAPairedGateTakesAReplacementKeyOnlyAfterTheKeyPress) {
  Rig r(true);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  proto::Frame out;
  std::vector<uint8_t> pairFrame = k;
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, 0, 1, pairFrame), out) == Gate::Pair, "PAIR is taken plain, though the gate is paired and in a session");
  CHECK(r.gate.onPair(out.payload, out.len, op) == Gate::PairAsk, "asks");
  CHECK(memcmp(Store::key, unhex(kSealMaster).data(), 32) == 0, "the old key stays until yes");
  CHECK(r.gate.answer(true).op == proto::PAIR_OK, "yes");
  CHECK(memcmp(Store::key, k.data() + 1, 32) == 0, "replaced");
  std::vector<uint8_t> p = {7, 0, 0, 0}, s = r.sealed(proto::T_PING, 5, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 5, s), out) == Gate::Drop, "the old session ended with the old key");
}

TEST(gateNoAnswerDeniesAndChangesNothing) {
  Rig r(false);
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "asks");
  Gate::PairReply rep = r.gate.answer(false);
  CHECK(rep.send && rep.op == proto::PAIR_DENIED && rep.answered == proto::PAIR_SET, "DENIED for the SET");
  CHECK(Store::saves == 0 && !Store::has && !r.gate.paired(), "nothing stored");
}

TEST(gateASaveThatFailsDenies) {
  Rig r(false);
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  uint8_t op = 0;
  r.gate.onPair(k.data(), k.size(), op);
  Store::failSave = true;
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_DENIED && !r.gate.paired(), "denied, still unpaired");
}

TEST(gateSetWithTheKeyItAlreadyHoldsIsAnsweredWithoutAsking) {
  Rig r(true);
  std::vector<uint8_t> k(33);
  k[0] = proto::PAIR_SET;
  memcpy(k.data() + 1, Store::key, 32);
  uint8_t op = 0;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairReplyOk && op == proto::PAIR_SET, "answered at once");
  CHECK(!r.gate.answer(true).send && Store::saves == 0, "and there is nothing to answer");
  k[5] ^= 1;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "one different byte asks");
  k[5] ^= 1;
  k[32] ^= 1;
  CHECK(r.gate.onPair(k.data(), k.size(), op) == Gate::PairAsk, "and so does a different last byte");
}

TEST(gateForgetAsksWhenPairedAndErasesOnYes) {
  Rig r(true);
  r.hello();
  uint8_t forget[1] = {proto::PAIR_FORGET}, op = 0;
  CHECK(r.gate.onPair(forget, 1, op) == Gate::PairAsk && op == proto::PAIR_FORGET, "asks");
  CHECK(Store::erases == 0 && r.gate.paired(), "not before yes");
  Gate::PairReply rep = r.gate.answer(true);
  CHECK(rep.send && rep.op == proto::PAIR_OK && rep.answered == proto::PAIR_FORGET, "OK for the FORGET");
  CHECK(Store::erases == 1 && !Store::has && !r.gate.paired() && r.gate.helloFlags() == 0, "forgotten");
  CHECK(r.gate.onPair(forget, 1, op) == Gate::PairReplyOk, "forgetting nothing is answered OK at once");
}

TEST(gatePairIgnoresWhatItDoesNotUnderstandAndSealedPairFrames) {
  Rig r(false);
  uint8_t op = 0;
  uint8_t bad[2] = {proto::PAIR_FORGET, 0};
  CHECK(r.gate.onPair(bad, 2, op) == Gate::PairIgnore, "FORGET with a tail");
  uint8_t ok[2] = {proto::PAIR_OK, 1};
  CHECK(r.gate.onPair(ok, 2, op) == Gate::PairIgnore, "a reply is not a request");
  CHECK(r.gate.onPair(bad, 0, op) == Gate::PairIgnore, "empty");
  CHECK(!r.gate.answer(true).send, "and none of it left anything pending");
  proto::Frame out;
  std::vector<uint8_t> k = unhex(msgHexOf("pair_set"));
  CHECK(r.gate.receive(r.frame(proto::T_PAIR, proto::F_SEALED, 1, k), out) == Gate::Drop, "PAIR is never sealed");
}

TEST(gateTheKeyInTheStoreIsTheOneItStartsWith) {
  Rig r(true);
  CHECK(r.gate.paired(), "paired at begin");
  Store::reset(false);
  Gate g2;
  g_nonceS = kSealNonceS;
  CHECK(g2.begin(refCrypto(), store(), rnd) && !g2.paired(), "unpaired when the store is empty");
}

TEST(gateTheSendCounterEndingEndsTheSession) {
  Rig r(true);
  r.gate.setFirstCounter(0xFFFFFFFFu);
  r.hello();
  r.pcBegin();
  std::vector<uint8_t> p = {1, 2, 3, 4};
  Gate::Wire w;
  CHECK(r.gate.wrap(proto::T_PONG, 0, 1, p.data(), 4, w) == Gate::Sealed, "the last counter seals");
  CHECK(r.gate.wrap(proto::T_PONG, 0, 2, p.data(), 4, w) == Gate::Blocked, "the next does not, and nothing goes out plain");
  proto::Frame out;
  std::vector<uint8_t> s = r.sealed(proto::T_PING, 3, p);
  CHECK(r.gate.receive(r.frame(proto::T_PING, proto::F_SEALED, 3, s), out) == Gate::Drop, "the session is over until the next HELLO");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/gate.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/gate.cpp`:

```cpp
#include "proto/gate.h"
#include <string.h>
#include "proto/messages.h"

namespace proto {
namespace {
const uint32_t REFUSALS_IN_A_ROW = 8;

// The two types that are never sealed.
bool neverSealed(uint8_t type) { return type == T_HELLO || type == T_PAIR; }

// Does not stop at the first difference.
bool sameKey(const uint8_t* a, const uint8_t* b) {
  uint8_t diff = 0;
  for (size_t i = 0; i < KEY_BYTES; i++) diff |= (uint8_t)(a[i] ^ b[i]);
  return diff == 0;
}
}  // namespace

Gate::Gate()
    : c_(nullptr), store_(), random32_(nullptr), pending_(0), paired_(false), adpcm_(false), nonceP_(0), nonceS_(0), firstCounter_(0) {
  memset(key_, 0, sizeof key_);
  memset(candidate_, 0, sizeof candidate_);
}

bool Gate::begin(const Crypto& c, const KeyStore& store, uint32_t (*random32)()) {
  if (!store.load || !store.save || !store.erase || !random32) return false;
  c_ = &c;
  store_ = store;
  random32_ = random32;
  session_.end();
  pending_ = 0;
  paired_ = store_.load(key_);
  if (!paired_) memset(key_, 0, sizeof key_);
  return true;
}

uint8_t Gate::helloFlags() const { return (uint8_t)((paired_ ? HELLO_PAIRED : 0) | (adpcm_ ? HELLO_ADPCM : 0)); }

Gate::Rx Gate::receive(const Frame& in, Frame& out) {
  if (in.type == T_HELLO) {
    uint32_t nonce = 0;
    if (!parseHello(in.payload, in.len, nonce)) return Drop;
    nonceP_ = nonce;
    nonceS_ = random32_();
    session_.end();
    if (paired_ && !session_.begin(*c_, key_, nonceP_, nonceS_, ROLE_S3, firstCounter_)) return Drop;
    out = in;
    return Hello;
  }
  if (in.type == T_PAIR) {
    if (in.flags & F_SEALED) return Drop;
    out = in;
    return Pair;
  }
  if (!paired_) {
    if (in.flags & F_SEALED) return Drop;
    out = in;
    return Deliver;
  }
  size_t n = 0;
  if (session_.open(in, rx_, sizeof rx_, n) != Session::Ok) {
    if (session_.failures() >= REFUSALS_IN_A_ROW) session_.end();
    return Drop;
  }
  out = in;
  out.flags = (uint8_t)(in.flags & ~F_SEALED);
  out.len = (uint16_t)n;
  out.payload = rx_;
  return Deliver;
}

Gate::Tx Gate::wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out) {
  if (neverSealed(type) || !paired_) {
    out.flags = flags;
    out.payload = payload;
    out.len = (uint16_t)len;
    return Plain;
  }
  if (!session_.active() || len > MAX_PLAIN) return Blocked;
  size_t n = session_.seal(type, flags, seq, payload, len, tx_, sizeof tx_);
  if (n == 0) {
    session_.end();  // the counter is used up: the PC's refusals will make it say HELLO again
    return Blocked;
  }
  out.flags = (uint8_t)(flags | F_SEALED);
  out.payload = tx_;
  out.len = (uint16_t)n;
  return Sealed;
}

Gate::PairAction Gate::onPair(const uint8_t* payload, size_t len, uint8_t& op) {
  PairMsg m = PairMsg();
  if (!parsePair(payload, len, m)) return PairIgnore;
  op = m.op;
  if (m.op == PAIR_SET) {
    if (paired_ && sameKey(key_, m.key)) {
      pending_ = 0;
      return PairReplyOk;
    }
    memcpy(candidate_, m.key, KEY_BYTES);
    pending_ = PAIR_SET;
    return PairAsk;
  }
  if (!paired_) {
    pending_ = 0;
    return PairReplyOk;
  }
  pending_ = PAIR_FORGET;
  return PairAsk;
}

Gate::PairReply Gate::answer(bool yes) {
  PairReply r = PairReply();
  if (pending_ == 0) return r;
  uint8_t op = pending_;
  pending_ = 0;
  r.send = true;
  r.answered = op;
  r.op = PAIR_DENIED;
  if (yes) {
    if (op == PAIR_SET) {
      if (store_.save(candidate_)) {
        memcpy(key_, candidate_, KEY_BYTES);
        paired_ = true;
        r.op = PAIR_OK;
      }
    } else if (store_.erase()) {
      memset(key_, 0, sizeof key_);
      paired_ = false;
      r.op = PAIR_OK;
    }
  }
  memset(candidate_, 0, sizeof candidate_);
  if (r.op == PAIR_OK) session_.end();  // the old keys came from the old key
  return r;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/gate.h`:

```cpp
// gate.h: what the S3 does with sealed frames and with pairing (protocol/frames.md, "Sealed frames" and "Pairing"), apart from the
// serial port and the screen, so that the host tests can run all of it. usblink.cpp owns one Gate: every received frame goes
// through receive(), every frame to send through wrap(), and PAIR frames and the key press through onPair() and answer().
//
// Threads: begin(), receive(), onPair() and answer() belong to the RX task. wrap() is called under the TX lock, and so must
// anything that changes the session, which receive() does when it sees a HELLO or the eighth refusal in a row: the caller
// holds the TX lock around receive() for those two cases (usblink.cpp takes it for every receive() call; it is cheap).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "proto/crypto.h"
#include "proto/frame.h"
#include "proto/session.h"

namespace proto {
// Where the pairing key lives. The device keeps it in NVS; the host tests keep it in a variable.
struct KeyStore {
  bool (*load)(uint8_t* key);        // KEY_BYTES into key; false when there is none
  bool (*save)(const uint8_t* key);  // false when it could not be stored
  bool (*erase)();
};

class Gate {
 public:
  enum Rx {
    Drop,     // not for anyone: refused, or no good
    Hello,    // a PC HELLO: a session has been started if paired; answer with helloNonce(), nonceS() and helloFlags()
    Pair,     // a PAIR frame, plain as it must be: hand its payload to onPair()
    Deliver,  // an ordinary frame, opened if it was sealed: `out` holds it
  };
  enum Tx {
    Plain,    // send the frame as it is (an unpaired S3, or HELLO and PAIR)
    Sealed,   // send Wire: sealed
    Blocked,  // send nothing: a paired S3 never sends a plain frame, and there is no session to seal with
  };
  struct Wire {
    uint8_t flags;
    const uint8_t* payload;  // valid until the next wrap()
    uint16_t len;
  };
  enum PairAction {
    PairIgnore,   // not a request this S3 understands
    PairAsk,      // show the confirmation, then call answer()
    PairReplyOk,  // nothing to ask: answer OK now (the key is already the one held, or there is nothing to forget)
  };
  struct PairReply {
    bool send;         // false when no request was waiting
    uint8_t op;        // PAIR_OK or PAIR_DENIED
    uint8_t answered;  // the PC's op
  };

  Gate();
  // Loads the key, if the store has one. `random32` makes the S3's half of every session's keys.
  bool begin(const Crypto& c, const KeyStore& store, uint32_t (*random32)());

  bool paired() const { return paired_; }
  uint8_t helloFlags() const;  // HELLO_PAIRED when paired, HELLO_ADPCM when setAdpcm(true)
  void setAdpcm(bool on) { adpcm_ = on; }
  uint32_t helloNonce() const { return nonceP_; }  // the PC's nonce from the last HELLO
  uint32_t nonceS() const { return nonceS_; }      // this S3's half for the same session

  Rx receive(const Frame& in, Frame& out);
  Tx wrap(uint8_t type, uint8_t flags, uint16_t seq, const uint8_t* payload, size_t len, Wire& out);

  PairAction onPair(const uint8_t* payload, size_t len, uint8_t& op);
  PairReply answer(bool yes);

  // For tests: the first send counter of the next session.
  void setFirstCounter(uint32_t c) { firstCounter_ = c; }

 private:
  const Crypto* c_;
  KeyStore store_;
  uint32_t (*random32_)();
  Session session_;
  uint8_t key_[KEY_BYTES];
  uint8_t candidate_[KEY_BYTES];
  uint8_t rx_[MAX_PAYLOAD];
  uint8_t tx_[MAX_PAYLOAD];
  uint8_t pending_;  // PAIR_SET or PAIR_FORGET while a request waits for the key press, else 0
  bool paired_;
  bool adpcm_;
  uint32_t nonceP_, nonceS_, firstCounter_;
};
}  // namespace proto
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `166 cases, 957 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 21.8%, Flash 26.6%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 759 tests, the tools' 17, and `166 cases, 957 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_gate.cpp firmware/lib/proto/src/proto/gate.cpp firmware/lib/proto/src/proto/gate.h
git commit -m "Task 7: firmware Gate: the S3's policy for sealed frames and pairing, run on the host" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: usblink runs through the Gate: sealed frames, pairing over USB, mbedtls and NVS adapters

The device side is wired up and compiled; it does not run until Task 16. `usblink.cpp` owns one static `Gate`, takes the TX lock around `gate.receive()` and `gate.wrap()`, answers HELLO with the gate's nonce, `nonceS` and flags, hands PAIR frames to `onPair` (calling `handlers.onPairRequest(op)` when it must ask, or denying at once when there is no handler), posts the person's answer from the UI task to the RX task through an atomic, and sends reply PAIR frames plain. A frame the gate refuses is counted in the status (`rxRefused`) instead of being handled. `crypto_mbedtls.cpp` is the `Crypto` over mbedtls (AES-GCM; HKDF is built in `proto/hkdf` over mbedtls HMAC, because the framework's mbedtls has no `mbedtls_hkdf`: the linker said so), `keystore_nvs.cpp` keeps the key in NVS (`Preferences`, namespace `walkie`, key `pairkey`), and the RX task's stack goes from 6144 to 8192 because it now opens frames and derives keys. `proto/hkdf` is shared with the host reference, so it is tested on the host.

**Files:**
- Create: `firmware/lib/proto/src/proto/hkdf.cpp`, `firmware/lib/proto/src/proto/hkdf.h`, `firmware/src/crypto_mbedtls.cpp`, `firmware/src/crypto_mbedtls.h`, `firmware/src/keystore_nvs.cpp`, `firmware/src/keystore_nvs.h`
- Modify: `firmware/lib/proto/src/proto/crypto.h`, `firmware/src/status.h`, `firmware/src/usblink.cpp`, `firmware/src/usblink.h`
- Test (new): `firmware/host/test_hkdf.cpp`
- Test (changed): `firmware/host/ref_crypto.cpp`, `firmware/host/ref_crypto.h`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `firmware/host/ref_crypto.cpp`, replace:

```cpp
#include <string.h>

```

with:

```cpp
#include <string.h>
#include "proto/hkdf.h"

```

In `firmware/host/ref_crypto.cpp`, replace:

```cpp

bool refHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
             uint8_t* okm, size_t okmLen) {
  if (okmLen > 255 * 32) return false;
  uint8_t zeros[32] = {0}, prk[32];
  const uint8_t* ikmParts[1] = {ikm};
  size_t ikmLens[1] = {ikmLen};
  if (saltLen == 0) hmac(zeros, 32, ikmParts, ikmLens, 1, prk);
  else hmac(salt, saltLen, ikmParts, ikmLens, 1, prk);
  uint8_t t[32];
  size_t tLen = 0;
  for (size_t done = 0, i = 1; done < okmLen; i++) {
    uint8_t counter = (uint8_t)i;
    const uint8_t* parts[3] = {t, info, &counter};
    size_t lens[3] = {tLen, infoLen, 1};
    hmac(prk, 32, parts, lens, 3, t);
    tLen = 32;
    size_t take = okmLen - done < 32 ? okmLen - done : 32;
    memcpy(okm + done, t, take);
    done += take;
  }
  return true;
}
```

with:

```cpp

}  // namespace

bool refHmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  hmac(key, keyLen, parts, lens, n, out);
  return true;
}

namespace {
// The same HKDF code as the device's, over the reference HMAC.
bool refHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
             uint8_t* okm, size_t okmLen) {
  return proto::hkdfSha256(refHmacSha256, ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
}
```

Replace the whole of `firmware/host/ref_crypto.h` with:

```cpp
// ref_crypto.h: AES-256-GCM and HKDF-SHA256 in plain C++, for the host tests only. The device uses mbedtls (src/crypto_mbedtls.cpp);
// this exists so that the session logic, which is the same code on both, can run on the PC against vectors made by Node's OpenSSL.
#pragma once
#include "proto/crypto.h"

const proto::Crypto& refCrypto();
// The reference HMAC-SHA256 under proto::HmacSha256's signature, for testing proto::hkdfSha256 by itself.
bool refHmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out);
```

Create `firmware/host/test_hkdf.cpp`:

```cpp
// test_hkdf.cpp: the HKDF that runs on the device (proto/hkdf.cpp), over the host's reference HMAC, against RFC 5869 and the vectors.
#include <string.h>
#include "check.h"
#include "proto/hkdf.h"
#include "ref_crypto.h"
#include "vectors.h"

TEST(hkdfMatchesTheRfcAndTheVectorsOverTheReferenceHmac) {
  for (const HkdfVec& v : kHkdf) {
    std::vector<uint8_t> ikm = unhex(v.ikm), salt = unhex(v.salt), info = unhex(v.info), okm((size_t)v.length);
    CHECK(proto::hkdfSha256(refHmacSha256, ikm.data(), ikm.size(), salt.data(), salt.size(), info.data(), info.size(), okm.data(),
                            okm.size()),
          v.name);
    CHECK(tohex(okm.data(), okm.size()) == v.okm, v.name);
  }
}

TEST(hkdfAnEmptySaltIsThirtyTwoZeroBytes) {
  uint8_t ikm[22], zeros[32] = {0}, a[42], b[42];
  memset(ikm, 0x0b, sizeof ikm);
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, sizeof ikm, nullptr, 0, nullptr, 0, a, sizeof a), "empty");
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, sizeof ikm, zeros, sizeof zeros, nullptr, 0, b, sizeof b), "zeros");
  CHECK(memcmp(a, b, sizeof a) == 0, "the same output");
}

TEST(hkdfRefusesWhatItCannotMakeAndWhatTheHmacRefuses) {
  uint8_t ikm[4] = {1, 2, 3, 4}, out[32];
  CHECK(!proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, nullptr, 0, out, 255 * 32 + 1), "more than 255 blocks");
  CHECK(proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, nullptr, 0, out, 0), "nothing to make is fine");
  uint8_t info[65] = {0};
  CHECK(!proto::hkdfSha256(refHmacSha256, ikm, 4, nullptr, 0, info, sizeof info, out, 32), "an info longer than 64 bytes is out of range");
  CHECK(!proto::hkdfSha256(nullptr, ikm, 4, nullptr, 0, nullptr, 0, out, 32), "no HMAC");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/hkdf.h: No such file or directory`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `firmware/lib/proto/src/proto/crypto.h` with:

```cpp
// crypto.h: the primitives a link session needs (protocol/frames.md, "Sealed frames"). The device binds them to mbedtls
// (src/crypto_mbedtls.cpp, with the S3's AES hardware); the host tests bind them to a plain C++ version
// (host/ref_crypto.cpp), so the session logic runs on the PC against the same vectors as the bridge.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t KEY_BYTES = 32;
const size_t GCM_NONCE_BYTES = 12;
const size_t GCM_TAG_BYTES = 16;

struct Crypto {
  // HKDF-SHA256 (RFC 5869): okmLen bytes into okm, at most 255 * 32. An empty salt means 32 zero bytes. False on failure.
  bool (*hkdf)(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen,
               uint8_t* okm, size_t okmLen);
  // AES-256-GCM. gcmSeal writes len bytes of ciphertext to out (which may be the input) and the 16-byte tag; gcmOpen returns false
  // when the tag is wrong, and then out holds nothing worth reading.
  bool (*gcmSeal)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  uint8_t* out, uint8_t* tag);
  bool (*gcmOpen)(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out);
};
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/hkdf.cpp`:

```cpp
#include "proto/hkdf.h"
#include <string.h>

namespace proto {
bool hkdfSha256(HmacSha256 hmac, const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info,
                size_t infoLen, uint8_t* okm, size_t okmLen) {
  if (!hmac || okmLen > 255 * 32 || infoLen > HKDF_MAX_INFO) return false;
  uint8_t zeros[32] = {0}, prk[32];
  const uint8_t* ikmParts[1] = {ikm};
  size_t ikmLens[1] = {ikmLen};
  if (saltLen == 0) {
    if (!hmac(zeros, sizeof zeros, ikmParts, ikmLens, 1, prk)) return false;
  } else if (!hmac(salt, saltLen, ikmParts, ikmLens, 1, prk)) {
    return false;
  }
  uint8_t t[32];
  size_t tLen = 0;
  for (size_t done = 0, i = 1; done < okmLen; i++) {
    uint8_t counter = (uint8_t)i;
    const uint8_t* parts[3] = {t, info, &counter};
    size_t lens[3] = {tLen, infoLen, 1};
    if (!hmac(prk, sizeof prk, parts, lens, 3, t)) return false;
    tLen = sizeof t;
    size_t take = okmLen - done < sizeof t ? okmLen - done : sizeof t;
    memcpy(okm + done, t, take);
    done += take;
  }
  return true;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/hkdf.h`:

```cpp
// hkdf.h: HKDF-SHA256 (RFC 5869) over any HMAC-SHA256, so that the same code runs on the device (mbedtls's HMAC, since the
// framework's build leaves out its HKDF) and in the host tests (a plain C++ HMAC) against the same vectors.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
const size_t HKDF_MAX_INFO = 64;

// HMAC-SHA256 of the concatenation of n parts (n <= 3) under key; writes 32 bytes to out. False on failure.
typedef bool (*HmacSha256)(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out);

// okmLen bytes (at most 255 * 32) into okm. An empty salt means 32 zero bytes. False when a length is out of range
// (info over HKDF_MAX_INFO included) or the HMAC fails.
bool hkdfSha256(HmacSha256 hmac, const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info,
                size_t infoLen, uint8_t* okm, size_t okmLen);
}  // namespace proto
```

Create `firmware/src/crypto_mbedtls.cpp`:

```cpp
// crypto_mbedtls.cpp: see crypto_mbedtls.h.
#include "crypto_mbedtls.h"
#include <mbedtls/gcm.h>
#include <mbedtls/md.h>
#include "proto/hkdf.h"

namespace {
mbedtls_gcm_context g_gcm;  // one context for every call: a stack one would cost the callers' tasks about 500 bytes each

// The framework's mbedtls is built without HKDF, so proto/hkdf.cpp does it over mbedtls's HMAC.
bool hmacSha256(const uint8_t* key, size_t keyLen, const uint8_t* const* parts, const size_t* lens, int n, uint8_t* out) {
  const mbedtls_md_info_t* md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!md) return false;
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  bool ok = mbedtls_md_setup(&ctx, md, 1) == 0 && mbedtls_md_hmac_starts(&ctx, key, keyLen) == 0;
  for (int i = 0; ok && i < n; i++) ok = lens[i] == 0 || mbedtls_md_hmac_update(&ctx, parts[i], lens[i]) == 0;
  ok = ok && mbedtls_md_hmac_finish(&ctx, out) == 0;
  mbedtls_md_free(&ctx);
  return ok;
}

bool hkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen, uint8_t* okm,
          size_t okmLen) {
  return proto::hkdfSha256(hmacSha256, ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
}

bool gcmSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
             uint8_t* tag) {
  mbedtls_gcm_init(&g_gcm);
  bool ok = mbedtls_gcm_setkey(&g_gcm, MBEDTLS_CIPHER_ID_AES, key, 256) == 0 &&
            mbedtls_gcm_crypt_and_tag(&g_gcm, MBEDTLS_GCM_ENCRYPT, len, nonce, proto::GCM_NONCE_BYTES, aad, aadLen, in, out,
                                      proto::GCM_TAG_BYTES, tag) == 0;
  mbedtls_gcm_free(&g_gcm);
  return ok;
}

bool gcmOpen(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
             const uint8_t* tag, uint8_t* out) {
  mbedtls_gcm_init(&g_gcm);
  bool ok = mbedtls_gcm_setkey(&g_gcm, MBEDTLS_CIPHER_ID_AES, key, 256) == 0 &&
            mbedtls_gcm_auth_decrypt(&g_gcm, len, nonce, proto::GCM_NONCE_BYTES, aad, aadLen, tag, proto::GCM_TAG_BYTES, in, out) == 0;
  mbedtls_gcm_free(&g_gcm);
  return ok;
}
}  // namespace

const proto::Crypto& mbedtlsCrypto() {
  static const proto::Crypto c = {hkdf, gcmSeal, gcmOpen};
  return c;
}
```

Create `firmware/src/crypto_mbedtls.h`:

```cpp
// crypto_mbedtls.h: the primitives of proto/crypto.h on the S3's mbedtls (and its AES hardware).
#pragma once
#include "proto/crypto.h"

// The functions share one GCM context, so they must not run at the same time: usblink.cpp calls them all under its TX lock.
const proto::Crypto& mbedtlsCrypto();
```

Create `firmware/src/keystore_nvs.cpp`:

```cpp
// keystore_nvs.cpp: see keystore_nvs.h.
#include "keystore_nvs.h"
#include <Preferences.h>

namespace {
const char* const NS = "walkie";
const char* const KEY = "pairkey";

bool load(uint8_t* key) {
  Preferences p;
  if (!p.begin(NS, true)) return false;
  bool ok = p.getBytesLength(KEY) == proto::KEY_BYTES && p.getBytes(KEY, key, proto::KEY_BYTES) == proto::KEY_BYTES;
  p.end();
  return ok;
}

bool save(const uint8_t* key) {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = p.putBytes(KEY, key, proto::KEY_BYTES) == proto::KEY_BYTES;
  p.end();
  return ok;
}

bool erase() {
  Preferences p;
  if (!p.begin(NS, false)) return false;
  bool ok = !p.isKey(KEY) || p.remove(KEY);
  p.end();
  return ok;
}
}  // namespace

const proto::KeyStore& nvsKeyStore() {
  static const proto::KeyStore s = {load, save, erase};
  return s;
}
```

Create `firmware/src/keystore_nvs.h`:

```cpp
// keystore_nvs.h: where the S3 keeps the pairing key (protocol/frames.md, "Pairing"): its own NVS namespace, nothing else reads it.
// The key is never logged, shown or sent; erasing it is `walkie pair --forget` with the key press on the device.
#pragma once
#include "proto/gate.h"

const proto::KeyStore& nvsKeyStore();
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
#include "proto/frame.h"
#include "proto/gate.h"
#include "proto/messages.h"
#include "status.h"
#include "version.h"

namespace usblink {
namespace {
const size_t RX_QUEUE = 16384;  // the USB driver drops bytes beyond this; credit keeps audio below it
const size_t TX_RING = 32768;   // encoded frames waiting for USB
const size_t RX_READ = 1024;
const uint32_t RX_STACK = 8192;  // 6144 before the gate: it opens frames and derives keys on this task
Handlers handlers;
RingbufHandle_t txRing = nullptr;
SemaphoreHandle_t txLock = nullptr;
uint16_t txSeq = 0;               // under txLock
proto::FrameDecoder decoder;      // RX task only
bool haveRxSeq = false;           // RX task only
uint16_t rxSeq = 0;               // RX task only
std::atomic<uint32_t> lastPing{0};
proto::Gate gate;                 // sealing and pairing; the RX task and txLock take turns (see gate.h)
std::atomic<int> pairAnswerPending{0};  // 0 nothing, 1 yes, 2 no: from the key press to the RX task

uint32_t randomNonce() { return esp_random(); }

// nonce: the one from the bridge's HELLO being answered, or 0 at boot. The S3's half of the session numbers and the flags come
// from the gate; read under the lock, since the RX task changes them at a HELLO.
void sayHello(uint32_t nonce) {
  uint8_t p[56];
  xSemaphoreTake(txLock, portMAX_DELAY);
  uint32_t nonceS = nonce ? gate.nonceS() : 0;
  uint8_t flags = gate.helloFlags();
  xSemaphoreGive(txLock);
  size_t n = proto::buildHello(16000, 24000, handlers.ringBytes, millis(), nonce, nonceS, flags, WALKIE_VERSION, p, sizeof p);
  send(proto::T_HELLO, 0, p, (uint16_t)n);
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

void onFrame(const proto::Frame& raw) {
  proto::Frame f;
  xSemaphoreTake(txLock, portMAX_DELAY);  // a HELLO, or the eighth refusal, changes the session that send() seals with
  proto::Gate::Rx rx = gate.receive(raw, f);
  uint32_t nonce = gate.helloNonce();
  xSemaphoreGive(txLock);
  if (rx == proto::Gate::Drop) {
    g_status.rxRefused++;
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

void rxTask(void*) {
  static uint8_t buf[RX_READ];
  for (;;) {
    int avail = Serial.available();
    if (avail > 0) {
      size_t n = Serial.read(buf, (size_t)avail < RX_READ ? (size_t)avail : RX_READ);
      if (n <= RX_READ) decoder.push(buf, n, onFrame);
      g_status.rxBad = decoder.bad();
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
  gate.begin(mbedtlsCrypto(), nvsKeyStore(), randomNonce);
  xTaskCreatePinnedToCore(txTask, "linkTx", 4096, nullptr, 4, nullptr, 0);
  // Tells a bridge that is already connected that walkie has (re)started. It is queued before the RX task exists, so no
  // answer to a HELLO that is already waiting in the USB FIFO, and no CREDIT, can go out ahead of it.
  sayHello(0);
  xTaskCreatePinnedToCore(rxTask, "linkRx", RX_STACK, nullptr, 5, nullptr, 0);
}

bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len) {
  static uint8_t wire[proto::MAX_WIRE];  // under txLock
  if (!txRing) return false;
  xSemaphoreTake(txLock, portMAX_DELAY);
  proto::Gate::Wire w;
  uint16_t seq = txSeq;
  bool ok = false;
  if (gate.wrap(type, flags, seq, payload, len, w) != proto::Gate::Blocked) {
    txSeq++;
    size_t n = proto::encodeFrame(type, w.flags, seq, w.payload, w.len, wire, sizeof wire);
    ok = n > 0 && xRingbufferSend(txRing, wire, n, 0) == pdTRUE;
  }
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

void pairAnswer(bool yes) { pairAnswerPending = yes ? 1 : 2; }

uint32_t msSincePing() {
  uint32_t t = lastPing.load();
  return t ? millis() - t : UINT32_MAX;
}
}  // namespace usblink
```

Replace the whole of `firmware/src/usblink.h` with:

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
  void (*onTest)(uint8_t op, const uint8_t* args, size_t len);
  void (*onUi)(const uint8_t* payload, size_t len);           // UI: valid only during the call
  void (*onApprovalReq)(const uint8_t* payload, size_t len);  // APPROVAL_REQ: likewise
  void (*onPairRequest)(uint8_t op);                          // PAIR SET or FORGET (proto::PAIR_*): show it; answer with pairAnswer()
  void (*idle)();                                           // at least once a millisecond
  uint32_t ringBytes;                                       // reported in HELLO
};

void begin(const Handlers& h);
// Queues one frame for USB and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// The key press on a pairing request: true is yes. Any task may call it; the answer is acted on by the RX task. With no request
// waiting it does nothing.
void pairAnswer(bool yes);
// Milliseconds since the bridge's last PING, or UINT32_MAX before the first.
uint32_t msSincePing();
}  // namespace usblink
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `169 cases, 968 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 22.7%, Flash 27.1%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 759 tests, the tools' 17, and `169 cases, 968 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/ref_crypto.cpp firmware/host/ref_crypto.h firmware/host/test_hkdf.cpp firmware/lib/proto/src/proto/crypto.h firmware/lib/proto/src/proto/hkdf.cpp firmware/lib/proto/src/proto/hkdf.h firmware/src/crypto_mbedtls.cpp firmware/src/crypto_mbedtls.h firmware/src/keystore_nvs.cpp firmware/src/keystore_nvs.h firmware/src/status.h firmware/src/usblink.cpp firmware/src/usblink.h
git commit -m "Task 8: usblink runs through the Gate: sealed frames, pairing over USB, mbedtls and NVS adapters, HKDF shared with the host tests" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The device asks before it takes or forgets a pairing key

A PAIR request opens a `PairConfirm` screen above everything, the offline screen included: a front short press is yes, a side short press is no, 30 s is no. A press that began before the request is not an answer (the front key must be seen up after the screen opened), a chord or a talk cannot slip past it, a repeated request for the same op does not restart the timer and a different op restarts it, and a lost link does not close it. The machine tells the UI task what to answer through `Act::PairAnswer`, and `main.cpp` passes the answer to `usblink::pairAnswer`. The screen says, in Chinese like the rest of the device, whether a PC is to be accepted or forgotten, which key answers what, and how many seconds are left.

**Files:**
- Modify: `firmware/lib/ui/src/ui/machine.cpp`, `firmware/lib/ui/src/ui/machine.h`, `firmware/src/main.cpp`, `firmware/src/screen.cpp`
- Test (changed): `firmware/host/test_machine.cpp`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `firmware/host/test_machine.cpp`, replace:

```cpp
      case ui::Act::BootApp0: out += "Boot"; break;
    }
```

with:

```cpp
      case ui::Act::BootApp0: out += "Boot"; break;
      case ui::Act::PairAnswer: out += a.arg ? "PairYes" : "PairNo"; break;
    }
```

In `firmware/host/test_machine.cpp`, replace:

```cpp
  CHECK(s.screen() == Screen::Approval, "which waits for him");
}
```

with:

```cpp
  CHECK(s.screen() == Screen::Approval, "which waits for him");
}

// ---- pairing confirmation (protocol/frames.md, "Pairing"): the key press on the device is the authority for a key.

TEST(aPairRequestOpensPairConfirmAboveEverythingEvenWhileOffline) {
  Sim s;
  s.link = false;
  s.step(false, false);
  CHECK(s.screen() == Screen::Offline, "no bridge: pairing runs over a link that does not ping");
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.screen() == Screen::PairConfirm, "above OFFLINE");
  CHECK(s.m.view(s.now).pairOp == proto::PAIR_SET, "the view says which request it is");
  CHECK(std::string(ui::screenName(Screen::PairConfirm)) == "pair-confirm", "its name");
  s.m.onPairRequest(proto::PAIR_FORGET, s.now);
  CHECK(s.m.view(s.now).pairOp == proto::PAIR_FORGET, "and shows the latest one");
}

TEST(aShortFrontPressAnswersYesAndAShortSidePressAnswersNo) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.step(false, false);
  s.front(100);
  CHECK(s.acts() == "PairYes" && s.screen() == Screen::Idle, "yes closes it");
  s.front(100);
  CHECK(s.acts() == "Prepare End", "and nothing answers twice");
  Sim t;
  t.m.onPairRequest(proto::PAIR_SET, t.now);
  t.step(false, false);
  t.side(100);
  CHECK(t.acts() == "PairNo" && t.screen() == Screen::Idle, "a short side press is no");
}

TEST(aFrontPressThatBeganBeforeTheRequestIsNotAnAnswer) {
  Sim s;
  s.hold(100, true, false);
  s.acts();
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.acts() == "End", "the talk the press had begun is dropped");
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "released: not a yes");
  s.front(100);
  CHECK(s.acts() == "PairYes", "a press that began on the screen is");
}

TEST(aLongFrontHoldNeitherAnswersNorTalksWhilePairConfirmIsOpen) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.step(false, false);
  s.hold(500, true, false);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "nothing: neither a yes nor a spoken reason");
  s.hold(1200, false, true);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "a long side press is not a no either");
}

TEST(noAnswerIn30SecondsIsNoAtExactlyThirtySeconds) {
  ui::Machine m;
  m.tick(0, true, false);
  m.onPairRequest(proto::PAIR_SET, 1000);
  m.tick(30999, true, false);
  CHECK(m.screen() == Screen::PairConfirm && actions(m) == "", "a millisecond short");
  CHECK(m.view(30999).pairLeftMs == 1, "and the view counts down");
  m.tick(31000, true, false);
  CHECK(m.screen() == Screen::Idle && actions(m) == "PairNo", "thirty seconds");
  ui::Machine w;
  w.tick(0xFFFFFF00u, true, false);
  w.onPairRequest(proto::PAIR_SET, 0xFFFFFF00u);
  w.tick(0xFFFFFF00u + 29999u, true, false);
  CHECK(w.screen() == Screen::PairConfirm, "across the wrap: still open");
  w.tick(0xFFFFFF00u + 30000u, true, false);
  CHECK(w.screen() == Screen::Idle, "across the wrap: closed");
}

TEST(aRepeatedRequestKeepsTheTimeButAChangedOneRestartsItAndNeedsANewPress) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  uint32_t first = s.now;
  s.hold(10000, false, false);
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.m.view(s.now).pairLeftMs <= 20100, "the same request again does not buy more time");
  s.hold(100, true, false);
  s.m.onPairRequest(proto::PAIR_FORGET, s.now);
  s.hold(20, false, false);
  CHECK(s.acts().find("PairYes") == std::string::npos && s.screen() == Screen::PairConfirm, "a press made for the old request does not answer the new one");
  CHECK(s.m.view(s.now).pairLeftMs > 29000 && s.now - first > 10000, "the new one has its own 30 seconds");
}

TEST(pairConfirmSitsAboveSwitchConfirmAndLeavesItWhereItWas) {
  Sim s;
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.screen() == Screen::SwitchConfirm, "open");
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  CHECK(s.screen() == Screen::PairConfirm, "pairing is above it");
  s.hold(3100, true, true);
  s.hold(20, false, false);
  CHECK(s.acts() == "" && s.screen() == Screen::PairConfirm, "a chord does not open or confirm anything meanwhile");
  s.m.tick(s.now + 40000, true, false);
  CHECK(actions(s.m) == "PairNo" && s.screen() != Screen::PairConfirm, "closed by the timeout");
}

TEST(aLostLinkDoesNotCloseAPairRequest) {
  Sim s;
  s.link = false;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.hold(5000, false, false);
  CHECK(s.screen() == Screen::PairConfirm, "pairing runs with the bridge not pinging");
}

TEST(aChordHeldDuringAPairRequestOpensNoSwitchConfirmBehindIt) {
  Sim s;
  s.m.onPairRequest(proto::PAIR_SET, s.now);
  s.hold(3100, true, true);
  s.hold(20, false, false);
  s.m.onGesture(ui::Ev::SideShort, s.now);
  CHECK(actions(s.m) == "PairNo", "the side key said no");
  CHECK(s.screen() != Screen::SwitchConfirm && s.screen() != Screen::PairConfirm, "and no switch confirmation waits behind it");
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `'PairAnswer' is not a member of 'ui::Act'`, `'class ui::Machine' has no member named 'onPairRequest'`, `'PairConfirm' is not a member of 'ui::Screen'; did you mean 'Confirm'?`, and 2 more.

- [ ] **Step 3: Write the implementation**

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
    case Screen::Offline: return "offline";
  }
```

with:

```cpp
    case Screen::Offline: return "offline";
    case Screen::PairConfirm: return "pair-confirm";
  }
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
      switchDeadline_(0),
      head_(0),
```

with:

```cpp
      switchDeadline_(0),
      pairOpen_(false),
      pairOp_(0),
      pairDeadline_(0),
      frontSawPair_(false),
      head_(0),
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
Screen Machine::screen() const {
  if (switchOpen_) return Screen::SwitchConfirm;
```

with:

```cpp
Screen Machine::screen() const {
  if (pairOpen_) return Screen::PairConfirm;
  if (switchOpen_) return Screen::SwitchConfirm;
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
bool Machine::canTalk() const {
  if (offline_ || switchOpen_) return false;
  if (approval_) return true;  // a front hold is the spoken reason
```

with:

```cpp
bool Machine::canTalk() const {
  if (offline_ || switchOpen_ || pairOpen_) return false;
  if (approval_) return true;  // a front hold is the spoken reason
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp

void Machine::dropTalk() {
```

with:

```cpp

void Machine::answerPair(bool yes) {
  push(Act::PairAnswer, yes ? 1 : 0);
  pairOpen_ = false;
}

void Machine::dropTalk() {
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
      frontApprovalId_ = approvalId_;
      if (talk_ == Talk::Off && canTalk()) {
```

with:

```cpp
      frontApprovalId_ = approvalId_;
      frontSawPair_ = pairOpen_;
      if (talk_ == Talk::Off && canTalk()) {
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
      if (talk_ == Talk::Prepared) dropTalk();
      if (switchOpen_) {
        if (!switching_) {
```

with:

```cpp
      if (talk_ == Talk::Prepared) dropTalk();
      if (pairOpen_) {
        if (frontSawPair_) answerPair(true);  // a press that began before the request was not meant for it
      } else if (switchOpen_) {
        if (!switching_) {
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
    case Ev::SideShort:
      if (switchOpen_) {
        if (!switching_) switchOpen_ = false;
```

with:

```cpp
    case Ev::SideShort:
      if (pairOpen_) {
        answerPair(false);
      } else if (switchOpen_) {
        if (!switching_) switchOpen_ = false;
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
    case Ev::ChordHold:
      if (!switchOpen_) {
        switchOpen_ = true;
```

with:

```cpp
    case Ev::ChordHold:
      if (!switchOpen_ && !pairOpen_) {
        switchOpen_ = true;
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp

void Machine::tick(uint32_t now, bool linkUp, bool speakerBusy) {
```

with:

```cpp

void Machine::onPairRequest(uint8_t op, uint32_t now) {
  if (pairOpen_ && pairOp_ == op) return;
  dropTalk();
  pairOpen_ = true;
  pairOp_ = op;
  pairDeadline_ = now + PAIR_TIMEOUT_MS;
  frontSawPair_ = false;
}

void Machine::tick(uint32_t now, bool linkUp, bool speakerBusy) {
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
  if (switchOpen_ && !switching_ && (int32_t)(now - switchDeadline_) >= 0) switchOpen_ = false;
}
```

with:

```cpp
  if (switchOpen_ && !switching_ && (int32_t)(now - switchDeadline_) >= 0) switchOpen_ = false;
  if (pairOpen_ && (int32_t)(now - pairDeadline_) >= 0) answerPair(false);
}
```

In `firmware/lib/ui/src/ui/machine.cpp`, replace:

```cpp
  v.switching = switching_;
  const Line* from = lines_;
```

with:

```cpp
  v.switching = switching_;
  v.pairOp = pairOp_;
  v.pairLeftMs = pairOpen_ && (int32_t)(pairDeadline_ - now) > 0 ? pairDeadline_ - now : 0;
  const Line* from = lines_;
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
// Six screens come from the PC as UI frames (Idle to Error). The rest are the device's own and sit above them:
//   SwitchConfirm > Offline > Listening > Approval > the PC's screen.
// SwitchConfirm is above Offline so that the device can be switched back to app0 when the bridge is not running.
#pragma once
```

with:

```cpp
// Six screens come from the PC as UI frames (Idle to Error). The rest are the device's own and sit above them:
//   PairConfirm > SwitchConfirm > Offline > Listening > Approval > the PC's screen.
// SwitchConfirm is above Offline so that the device can be switched back to app0 when the bridge is not running. PairConfirm is
// above both: `walkie pair` runs with the bridge not pinging, and a request for a key must be answered on the device.
#pragma once
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
const uint32_t SWITCH_TIMEOUT_MS = 10000;

```

with:

```cpp
const uint32_t SWITCH_TIMEOUT_MS = 10000;
const uint32_t PAIR_TIMEOUT_MS = 30000;  // no answer is no

```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  Offline = 9,
};
```

with:

```cpp
  Offline = 9,
  PairConfirm = 10,
};
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  BootApp0,      // restart into app0
};
```

with:

```cpp
  BootApp0,      // restart into app0
  PairAnswer,    // arg 1 yes, 0 no (also when the time ran out): tell the link
};
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  bool switching;       // SwitchConfirm after the front key: the device is about to restart
};
```

with:

```cpp
  bool switching;       // SwitchConfirm after the front key: the device is about to restart
  uint8_t pairOp;       // PairConfirm: proto::PAIR_SET or PAIR_FORGET
  uint32_t pairLeftMs;  // PairConfirm: until it counts as no
};
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  void onApprovalReq(const proto::ApprovalReq& r, uint32_t now);
  // Every loop: whether pings still arrive, and whether a reply is playing.
```

with:

```cpp
  void onApprovalReq(const proto::ApprovalReq& r, uint32_t now);
  // A PAIR request (proto::PAIR_SET or PAIR_FORGET) from the link: front key yes, side key no, 30 s is no. The same request again
  // changes nothing; another op replaces it and starts the 30 s over.
  void onPairRequest(uint8_t op, uint32_t now);
  // Every loop: whether pings still arrive, and whether a reply is playing.
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp
  void answer(bool allow, bool reasonFollows);
  void dropTalk();
```

with:

```cpp
  void answer(bool allow, bool reasonFollows);
  void answerPair(bool yes);
  void dropTalk();
```

In `firmware/lib/ui/src/ui/machine.h`, replace:

```cpp

  Action queue_[16];
```

with:

```cpp

  bool pairOpen_;
  uint8_t pairOp_;
  uint32_t pairDeadline_;
  bool frontSawPair_;  // the request was on the screen when the front key went down

  Action queue_[16];
```

In `firmware/src/main.cpp`, replace:

```cpp

enum Kind : uint8_t { K_UI, K_APPROVAL, K_KEYS, K_SNAP };
struct Msg {
```

with:

```cpp

enum Kind : uint8_t { K_UI, K_APPROVAL, K_KEYS, K_SNAP, K_PAIR };
struct Msg {
```

In `firmware/src/main.cpp`, replace:

```cpp
void onApprovalFrame(const uint8_t* p, size_t n) { post(K_APPROVAL, p, n); }

// Runs on the link RX task.
void command(uint8_t op, uint8_t arg) {
```

with:

```cpp
void onApprovalFrame(const uint8_t* p, size_t n) { post(K_APPROVAL, p, n); }

// Link RX task: the PC asks to set or forget the pairing key. The answer comes from a key press on the UI loop.
void onPairRequest(uint8_t op) { post(K_PAIR, &op, 1); }

// Runs on the link RX task.
void command(uint8_t op, uint8_t arg) {
```

In `firmware/src/main.cpp`, replace:

```cpp
    }
    case K_SNAP:
```

with:

```cpp
    }
    case K_PAIR:
      if (m.len == 1) machine.onPairRequest(m.data[0], now);
      break;
    case K_SNAP:
```

In `firmware/src/main.cpp`, replace:

```cpp
      break;
    case ui::Act::BootApp0:
```

with:

```cpp
      break;
    case ui::Act::PairAnswer:
      usblink::logf("act pair answer %u", a.arg);
      usblink::pairAnswer(a.arg != 0);
      break;
    case ui::Act::BootApp0:
```

In `firmware/src/main.cpp`, replace:

```cpp
  h.onApprovalReq = onApprovalFrame;
  h.idle = audio::rxIdle;
```

with:

```cpp
  h.onApprovalReq = onApprovalFrame;
  h.onPairRequest = onPairRequest;
  h.idle = audio::rxIdle;
```

In `firmware/src/screen.cpp`, replace:

```cpp
  h = mix(h, v.hasElapsed ? v.elapsedMs / 1000 : 0);
  h = mix(h, (uint32_t)x.battery);
```

with:

```cpp
  h = mix(h, v.hasElapsed ? v.elapsedMs / 1000 : 0);
  h = mix(h, v.screen == ui::Screen::PairConfirm ? (uint32_t)v.pairOp << 16 | (v.pairLeftMs + 999) / 1000 : 0);
  h = mix(h, (uint32_t)x.battery);
```

In `firmware/src/screen.cpp`, replace:

```cpp
    }
    case ui::Screen::SwitchConfirm:
```

with:

```cpp
    }
    case ui::Screen::PairConfirm: {
      char line[48];
      header(MAGENTA, v.pairOp == proto::PAIR_FORGET ? "解除配对" : "配对", right);
      put(0, BODY_Y, v.pairOp == proto::PAIR_FORGET ? "电脑要忘记这个密钥" : "电脑要设置一个新密钥", WHITE);
      snprintf(line, sizeof line, "%u 秒后算拒绝", (unsigned)((v.pairLeftMs + 999) / 1000));
      put(0, BODY_Y + ROW, line, GREY);
      footer("前键同意 侧键拒绝");
      break;
    }
    case ui::Screen::SwitchConfirm:
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `178 cases, 996 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 22.7%, Flash 27.1%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 759 tests, the tools' 17, and `178 cases, 996 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_machine.cpp firmware/lib/ui/src/ui/machine.cpp firmware/lib/ui/src/ui/machine.h firmware/src/main.cpp firmware/src/screen.cpp
git commit -m "Task 9: the device asks before it takes or forgets a pairing key" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The S3 decodes ADPCM from the PC and encodes it for the PC on request

`AUDIO_DOWN` is decoded by its codec flag (PCM16 passes through with an odd byte dropped; ADPCM is decoded; anything else, or a frame that does not decode, is refused), and credit counts the decoded PCM bytes, so the ring and PLAYED mean what they meant. `AUDIO_UP` is PCM16 until `CMD SET_CODEC` (op 6) asks for ADPCM, carries the step index through a take, resets it on EOS and on every `setCodec`, and goes back to PCM16 at HELLO. The S3's HELLO says it takes ADPCM. A bad downlink frame is logged and counts as 0 bytes, and its EOS is still honoured. `CMD_SET_CODEC` needs its argument; the shared vector `cmd_set_codec` pins the payload.

**Files:**
- Create: `firmware/lib/proto/src/proto/audiocodec.cpp`, `firmware/lib/proto/src/proto/audiocodec.h`
- Modify: `firmware/lib/proto/src/proto/messages.cpp`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/audio.cpp`, `firmware/src/audio.h`, `firmware/src/main.cpp`, `firmware/src/usblink.cpp`, `firmware/src/usblink.h`
- Test (new): `firmware/host/test_audiocodec.cpp`
- Test (changed): `firmware/host/test_state.cpp`, `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `firmware/host/test_audiocodec.cpp`:

```cpp
// test_audiocodec.cpp: what the S3 does with the codec flag of an AUDIO frame (protocol/frames.md, "Audio codec"): decode what comes
// down, and choose and carry the encoder for what goes up.
#include <string.h>
#include <vector>
#include "check.h"
#include "proto/adpcm.h"
#include "proto/audiocodec.h"

namespace {
std::vector<int16_t> ramp(size_t n, int step) {
  std::vector<int16_t> v(n);
  for (size_t i = 0; i < n; i++) v[i] = (int16_t)(((int)i * step) % 20000 - 10000);
  return v;
}
}  // namespace

TEST(codecFlagIsBitsOneAndTwoOfTheFrameFlags) {
  CHECK(proto::codecOf(0x00) == proto::CODEC_PCM16, "no bits: PCM16");
  CHECK(proto::codecOf(0x02) == proto::CODEC_ADPCM, "bit 1: ADPCM");
  CHECK(proto::codecOf(0x01 | 0x08 | 0x80) == proto::CODEC_PCM16, "EOS, REASON and SEALED are not codec bits");
  CHECK(proto::codecOf(0x04) == 2 && proto::codecOf(0x06) == 3, "2 and 3 are read as they are, so they can be refused");
  CHECK(proto::codecFlags(proto::CODEC_ADPCM) == 0x02 && proto::codecFlags(proto::CODEC_PCM16) == 0, "and the other way");
}

TEST(aPcmFrameGoesDownUntouchedWithAnOddByteDropped) {
  proto::DownDecoder d;
  uint8_t in[7] = {1, 2, 3, 4, 5, 6, 7};
  const uint8_t* pcm = nullptr;
  size_t n = 99;
  CHECK(d.decode(0, in, 7, pcm, n) && pcm == in && n == 6, "the same bytes, whole samples only");
}

TEST(anAdpcmFrameGoesDownAsItsPcm) {
  std::vector<int16_t> src = ramp(480, 37);
  uint8_t frame[300];
  uint8_t index = 0;
  size_t flen = proto::adpcmEncode(src.data(), src.size(), index, frame, sizeof frame);
  CHECK(flen == 244, "480 samples are 244 bytes");
  int16_t want[480];
  CHECK(proto::adpcmDecode(frame, flen, want, 480) == 480, "the reference decode");
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 0;
  CHECK(d.decode(proto::codecFlags(proto::CODEC_ADPCM), frame, flen, pcm, n), "decoded");
  CHECK(n == 960 && memcmp(pcm, want, 960) == 0, "960 bytes of the reference PCM, so credit counts what it always counted");
}

TEST(aFrameThatIsNotGoodDecodesToNothingAndSaysSo) {
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 5;
  uint8_t shortFrame[3] = {0, 0, 0};
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), shortFrame, 3, pcm, n) && n == 0, "shorter than its header");
  uint8_t badIndex[8] = {0, 0, 89, 0, 0, 0, 0, 0};
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), badIndex, 8, pcm, n) && n == 0, "a step index above 88");
  uint8_t big[1000];
  memset(big, 0, sizeof big);
  CHECK(!d.decode(proto::codecFlags(proto::CODEC_ADPCM), big, 500, pcm, n) && n == 0, "more than 20 ms (480 samples) of audio");
  uint8_t some[8] = {0, 0, 0, 0, 1, 2, 3, 4};
  CHECK(!d.decode(2 << 1, some, 8, pcm, n) && n == 0, "codec 2 is reserved");
  CHECK(!d.decode(3 << 1, some, 8, pcm, n) && n == 0, "codec 3 is reserved");
}

TEST(anEmptyFrameIsGoodWhateverItsCodecFlag) {
  proto::DownDecoder d;
  const uint8_t* pcm = nullptr;
  size_t n = 7;
  CHECK(d.decode(proto::codecFlags(proto::CODEC_ADPCM), nullptr, 0, pcm, n) && n == 0, "the EOS frame stays empty");
  CHECK(d.decode(0, nullptr, 0, pcm, n) && n == 0, "in PCM16 too");
}

TEST(theUpEncoderIsPcmUntilToldAndGoesBackAtHello) {
  proto::UpEncoder e;
  std::vector<int16_t> src = ramp(320, 11);
  uint8_t out[200];
  const uint8_t* payload = nullptr;
  size_t n = 0;
  uint8_t flags = 0;
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(payload == (const uint8_t*)src.data() && n == 640 && flags == 0, "PCM16 goes out as it is");
  CHECK(e.setCodec(proto::CODEC_ADPCM), "ADPCM accepted");
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(payload == out && n == 164 && flags == proto::codecFlags(proto::CODEC_ADPCM), "now 164 bytes with the codec flag");
  e.reset();
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(n == 640 && flags == 0, "a HELLO puts it back to PCM16");
  CHECK(!e.setCodec(2) && !e.setCodec(255), "codecs 2 and up are refused");
  e.encode(src.data(), 320, false, out, sizeof out, payload, n, flags);
  CHECK(n == 640, "and a refusal changes nothing");
}

TEST(theUpEncoderCarriesTheStepIndexThroughATakeAndStartsTheNextAtZero) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200], b[200], c[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "the first frame of a take starts at index 0");
  uint8_t idx = 0;
  uint8_t ref[200];
  proto::adpcmEncode(loud.data(), 320, idx, ref, sizeof ref);
  CHECK(idx > 0, "(the loud ramp does move the index)");
  e.encode(loud.data(), 320, false, b, sizeof b, p, n, flags);
  CHECK(b[2] == idx, "the second frame starts where the first ended");
  e.encode(loud.data(), 320, true, c, sizeof c, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "after the EOS frame the next take starts at 0 again");
}

TEST(theEmptyEosFrameStaysEmptyAndCarriesNoCodecFlag) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  uint8_t out[200];
  const uint8_t* p = nullptr;
  size_t n = 9;
  uint8_t flags = 0xff;
  e.encode(nullptr, 0, true, out, sizeof out, p, n, flags);
  CHECK(n == 0 && flags == 0, "no payload, no codec flag");
}

TEST(theUpEncoderRefusesABufferThatIsTooSmallInsteadOfSendingHalfAFrame) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> src = ramp(320, 11);
  uint8_t small[100];
  const uint8_t* p = nullptr;
  size_t n = 5;
  uint8_t flags = 0;
  CHECK(!e.encode(src.data(), 320, false, small, sizeof small, p, n, flags) && n == 0, "false and nothing to send");
}

TEST(aTakeThatEndsWithAnEmptyEosFrameStartsTheNextOneAtZero) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200], b[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] > 0, "(the index has moved)");
  e.encode(nullptr, 0, true, b, sizeof b, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "a talk key released gives an empty EOS frame, and the next take starts at 0");
}

TEST(askingForTheCodecAgainStartsANewStream) {
  proto::UpEncoder e;
  e.setCodec(proto::CODEC_ADPCM);
  std::vector<int16_t> loud = ramp(320, 600);
  uint8_t a[200];
  const uint8_t* p;
  size_t n;
  uint8_t flags;
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] > 0, "(the index has moved)");
  e.setCodec(proto::CODEC_ADPCM);
  e.encode(loud.data(), 320, false, a, sizeof a, p, n, flags);
  CHECK(a[2] == 0, "SET_CODEC begins at index 0");
}
```

In `firmware/host/test_state.cpp`, replace:

```cpp
              {"cmd_boot_app0", 4, 0},
              {"cmd_reboot", 5, 0}};
  for (auto& c : cmds) {
```

with:

```cpp
              {"cmd_boot_app0", 4, 0},
              {"cmd_reboot", 5, 0},
              {"cmd_set_codec", 6, 1}};
  for (auto& c : cmds) {
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK((unsigned)proto::CMD_REBOOT == 5u, "CMD_REBOOT");
  CHECK((unsigned)proto::TEST_UP_PATTERN == 1u, "TEST_UP_PATTERN");
```

with:

```cpp
  CHECK((unsigned)proto::CMD_REBOOT == 5u, "CMD_REBOOT");
  CHECK((unsigned)proto::CMD_SET_CODEC == 6u, "CMD_SET_CODEC");
  CHECK((unsigned)proto::TEST_UP_PATTERN == 1u, "TEST_UP_PATTERN");
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK(!proto::parseCmd(gain, 1, cmd), "SET_MIC_GAIN without its argument");
  const uint8_t stop[] = {proto::CMD_STOP_AUDIO};
```

with:

```cpp
  CHECK(!proto::parseCmd(gain, 1, cmd), "SET_MIC_GAIN without its argument");
  const uint8_t codec[] = {proto::CMD_SET_CODEC};
  CHECK(!proto::parseCmd(codec, 1, cmd), "SET_CODEC without its argument");
  const uint8_t stop[] = {proto::CMD_STOP_AUDIO};
```

In `protocol/gen_vectors.py`, replace:

```python
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
```

with:

```python
    ('cmd_reboot', 0x30, 'down', bytes([5]), {'op': 5, 'arg': 0}),
    ('cmd_set_codec', 0x30, 'down', bytes([6, 1]), {'op': 6, 'arg': 1}),
    ('test_up_pattern', 0x31, 'down', bytes([1]) + struct.pack('<H', 250), {'op': 1, 'frames': 250}),
```

In `protocol/vectors.json`, replace:

```json
   }
  },
  {
   "name": "test_up_pattern",
```

with:

```json
   }
  },
  {
   "name": "cmd_set_codec",
   "type": 48,
   "dir": "down",
   "hex": "0601",
   "fields": {
    "op": 6,
    "arg": 1
   }
  },
  {
   "name": "test_up_pattern",
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/audiocodec.h: No such file or directory`, `'CMD_SET_CODEC' is not a member of 'proto'`.

- [ ] **Step 3: Write the implementation**

Create `firmware/lib/proto/src/proto/audiocodec.cpp`:

```cpp
#include "proto/audiocodec.h"
#include "proto/adpcm.h"

namespace proto {
bool DownDecoder::decode(uint8_t flags, const uint8_t* in, size_t len, const uint8_t*& pcm, size_t& pcmLen) {
  pcm = nullptr;
  pcmLen = 0;
  if (len == 0) return true;
  switch (codecOf(flags)) {
    case CODEC_PCM16:
      pcm = in;
      pcmLen = len & ~(size_t)1;
      return true;
    case CODEC_ADPCM: {
      size_t n = adpcmDecode(in, len, buf_, DOWN_PCM_MAX / 2);
      if (n == 0) return false;
      pcm = (const uint8_t*)buf_;
      pcmLen = n * 2;
      return true;
    }
    default:
      return false;
  }
}

UpEncoder::UpEncoder() : codec_(CODEC_PCM16), index_(0) {}

bool UpEncoder::setCodec(uint8_t codec) {
  if (codec != CODEC_PCM16 && codec != CODEC_ADPCM) return false;
  codec_ = codec;
  index_ = 0;
  return true;
}

void UpEncoder::reset() {
  codec_ = CODEC_PCM16;
  index_ = 0;
}

bool UpEncoder::encode(const int16_t* pcm, size_t samples, bool eos, uint8_t* out, size_t cap, const uint8_t*& payload, size_t& len,
                       uint8_t& codecBits) {
  payload = nullptr;
  len = 0;
  codecBits = 0;
  if (samples == 0) {
    if (eos) index_ = 0;
    return true;
  }
  if (codec_ == CODEC_PCM16) {
    payload = (const uint8_t*)pcm;
    len = samples * 2;
    return true;
  }
  uint8_t idx = index_;
  size_t n = adpcmEncode(pcm, samples, idx, out, cap);
  if (n == 0) return false;
  index_ = eos ? 0 : idx;
  payload = out;
  len = n;
  codecBits = codecFlags(CODEC_ADPCM);
  return true;
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/audiocodec.h`:

```cpp
// audiocodec.h: what the S3 does with the codec flag of an AUDIO frame (protocol/frames.md, "Audio codec"). A receiver decodes by
// the flag, so nothing is negotiated for the downlink; the uplink codec is whatever the PC last asked for with CMD SET_CODEC, and
// goes back to PCM16 at every HELLO. Pure, so the host tests run all of it.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace proto {
enum : uint8_t { CODEC_PCM16 = 0, CODEC_ADPCM = 1 };
const uint8_t F_CODEC_MASK = 0x06;  // frame flags bits 1-2
const size_t DOWN_PCM_MAX = 960;    // 20 ms at 24 kHz: no downlink frame decodes to more

inline uint8_t codecOf(uint8_t flags) { return (uint8_t)((flags & F_CODEC_MASK) >> 1); }
inline uint8_t codecFlags(uint8_t codec) { return (uint8_t)((codec << 1) & F_CODEC_MASK); }

// AUDIO_DOWN payload to the PCM16 bytes to play.
class DownDecoder {
 public:
  // PCM16 frames pass through (a stray odd byte is dropped); ADPCM frames are decoded into an internal buffer, valid until the next
  // call. An empty frame (the EOS) is good whatever its flag says. False, with pcmLen 0, for a frame that is no good: a reserved
  // codec, ADPCM that does not parse, or one that decodes to more than DOWN_PCM_MAX bytes.
  bool decode(uint8_t flags, const uint8_t* in, size_t len, const uint8_t*& pcm, size_t& pcmLen);

 private:
  int16_t buf_[DOWN_PCM_MAX / 2];
};

// AUDIO_UP: PCM16 samples to the payload and codec flag bits to send.
class UpEncoder {
 public:
  UpEncoder();
  // The RX task's: CMD SET_CODEC (false for a codec this does not know, which changes nothing) and HELLO. Both start a new stream.
  bool setCodec(uint8_t codec);
  void reset();
  // The audio task's. `payload` is `pcm` itself for PCM16, else a frame in `out`; `codecBits` are for the frame flags. The step index
  // is carried from frame to frame, and the frame with `eos` ends the stream. False, with len 0, when `out` is too small.
  bool encode(const int16_t* pcm, size_t samples, bool eos, uint8_t* out, size_t cap, const uint8_t*& payload, size_t& len,
              uint8_t& codecBits);

 private:
  volatile uint8_t codec_;
  volatile uint8_t index_;
};
}  // namespace proto
```

In `firmware/lib/proto/src/proto/messages.cpp`, replace:

```cpp
  if (n < 1) return false;
  if ((p[0] == CMD_SET_VOLUME || p[0] == CMD_SET_MIC_GAIN) && n < 2) return false;
  c.op = p[0];
```

with:

```cpp
  if (n < 1) return false;
  if ((p[0] == CMD_SET_VOLUME || p[0] == CMD_SET_MIC_GAIN || p[0] == CMD_SET_CODEC) && n < 2) return false;
  c.op = p[0];
```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5 };
```

with:

```cpp
enum : uint8_t { PAIR_SET = 1, PAIR_FORGET = 2, PAIR_OK = 3, PAIR_DENIED = 4 };
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5 };
```

In `firmware/src/audio.cpp`, replace:

```cpp
#include <atomic>
#include "proto/crc.h"
```

with:

```cpp
#include <atomic>
#include "proto/adpcm.h"
#include "proto/audiocodec.h"
#include "proto/crc.h"
```

In `firmware/src/audio.cpp`, replace:

```cpp
proto::CreditLedger ledger(12288, 1920);  // window below the 16,384-byte USB receive queue

```

with:

```cpp
proto::CreditLedger ledger(12288, 1920);  // window below the 16,384-byte USB receive queue
proto::DownDecoder downDecoder;  // RX task
proto::UpEncoder upEncoder;      // the audio task encodes; the RX task sets the codec at CMD SET_CODEC and HELLO

```

In `firmware/src/audio.cpp`, replace:

```cpp
void sendUp(const int16_t* pcm, size_t samples, bool eos, bool reason = false) {
  uint8_t flags = eos ? (uint8_t)(proto::F_EOS | (reason ? proto::F_REASON : 0)) : 0;
  usblink::send(proto::T_AUDIO_UP, flags, (const uint8_t*)pcm, (uint16_t)(samples * 2));
}
```

with:

```cpp
void sendUp(const int16_t* pcm, size_t samples, bool eos, bool reason = false) {
  uint8_t enc[proto::ADPCM_HEADER + UP_SAMPLES / 2 + 1];
  const uint8_t* payload = nullptr;
  size_t len = 0;
  uint8_t codecBits = 0;
  if (!upEncoder.encode(pcm, samples, eos, enc, sizeof enc, payload, len, codecBits)) {
    usblink::logf("uplink frame did not encode: dropped");
    return;
  }
  uint8_t flags = (uint8_t)(codecBits | (eos ? (proto::F_EOS | (reason ? proto::F_REASON : 0)) : 0));
  usblink::send(proto::T_AUDIO_UP, flags, payload, (uint16_t)len);
}
```

In `firmware/src/audio.cpp`, replace:

```cpp
void onHello() {
  ledger.reset();
```

with:

```cpp
void onHello() {
  upEncoder.reset();  // every link starts in PCM16: the bridge asks again if it wants ADPCM
  ledger.reset();
```

In `firmware/src/audio.cpp`, replace:

```cpp

void onAudioDown(const uint8_t* pcm, size_t len, bool eos) {
  ledger.received(len);
  if (discarding) {
```

with:

```cpp

void setUpCodec(uint8_t codec) {
  if (upEncoder.setCodec(codec)) usblink::logf("uplink codec %u", (unsigned)codec);
  else usblink::logf("bad codec %u", (unsigned)codec);
}

// Credit counts decoded PCM bytes whatever the codec, so a frame that does not decode counts for nothing (and still ends a reply if it
// carries EOS): the bridge's credit for it is only given back at the next HELLO, like that of a frame lost on the wire.
void onAudioDown(const uint8_t* payload, size_t len, uint8_t flags) {
  bool eos = (flags & proto::F_EOS) != 0;
  const uint8_t* pcm = nullptr;
  size_t n = 0;
  if (!downDecoder.decode(flags, payload, len, pcm, n)) {
    usblink::logf("bad AUDIO_DOWN frame (codec %u, %u bytes): dropped", (unsigned)proto::codecOf(flags), (unsigned)len);
  }
  ledger.received(proto::codecOf(flags) == proto::CODEC_PCM16 ? (uint32_t)len : (uint32_t)n);
  if (discarding) {
```

In `firmware/src/audio.cpp`, replace:

```cpp
  streamOpen = !eos;
  size_t even = len & ~(size_t)1;
  if (even) ring.write(pcm, (uint32_t)even);
  if (eos) eosReceived.store(true);
```

with:

```cpp
  streamOpen = !eos;
  if (n) ring.write(pcm, (uint32_t)n);
  if (eos) eosReceived.store(true);
```

Replace the whole of `firmware/src/audio.h` with:

```cpp
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
```

In `firmware/src/main.cpp`, replace:

```cpp
      break;
    case proto::CMD_BOOT_APP0:
```

with:

```cpp
      break;
    case proto::CMD_SET_CODEC:
      audio::setUpCodec(arg);
      break;
    case proto::CMD_BOOT_APP0:
```

In `firmware/src/usblink.cpp`, replace:

```cpp
    case proto::T_AUDIO_DOWN:
      if (handlers.onAudioDown) handlers.onAudioDown(f.payload, f.len, (f.flags & proto::F_EOS) != 0);
      return;
```

with:

```cpp
    case proto::T_AUDIO_DOWN:
      if (handlers.onAudioDown) handlers.onAudioDown(f.payload, f.len, f.flags);
      return;
```

In `firmware/src/usblink.cpp`, replace:

```cpp
  gate.begin(mbedtlsCrypto(), nvsKeyStore(), randomNonce);
  xTaskCreatePinnedToCore(txTask, "linkTx", 4096, nullptr, 4, nullptr, 0);
```

with:

```cpp
  gate.begin(mbedtlsCrypto(), nvsKeyStore(), randomNonce);
  gate.setAdpcm(true);  // HELLO says this S3 takes ADPCM
  xTaskCreatePinnedToCore(txTask, "linkTx", 4096, nullptr, 4, nullptr, 0);
```

Replace the whole of `firmware/src/usblink.h` with:

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
// Queues one frame for USB and never blocks. False when the queue is full: the frame is dropped and counted.
bool send(uint8_t type, uint8_t flags, const uint8_t* payload, uint16_t len);
// Queues a LOG frame of at most 200 characters.
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
// The key press on a pairing request: true is yes. Any task may call it; the answer is acted on by the RX task. With no request
// waiting it does nothing.
void pairAnswer(bool yes);
// Milliseconds since the bridge's last PING, or UINT32_MAX before the first.
uint32_t msSincePing();
}  // namespace usblink
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node firmware/host/run.mjs`
Expected: `189 cases, 1032 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.0%, Flash 27.2%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 759 tests, the tools' 17, and `189 cases, 1032 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add firmware/host/test_audiocodec.cpp firmware/host/test_state.cpp firmware/lib/proto/src/proto/audiocodec.cpp firmware/lib/proto/src/proto/audiocodec.h firmware/lib/proto/src/proto/messages.cpp firmware/lib/proto/src/proto/messages.h firmware/src/audio.cpp firmware/src/audio.h firmware/src/main.cpp firmware/src/usblink.cpp firmware/src/usblink.h protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 10: the S3 decodes ADPCM from the PC and encodes it for the PC on request" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The Link sends replies as ADPCM and asks the S3 for ADPCM takes when asked to

`new Link({ adpcm: true })`: when the S3's HELLO says it takes ADPCM, `AUDIO_DOWN` frames are encoded (the step index is carried through a reply and starts at 0 for each), and `CMD SET_CODEC 1` is sent after every HELLO answer, because a HELLO resets the S3's uplink to PCM16. `AUDIO_UP` is decoded by its codec flag, so listeners always get PCM16 and a frame that does not decode is counted in `badAudioFrames` (and warned about once). A reply's result now says what PLAYED should read: `expected {bytes, crc32}`, computed from the Link's own decode of what it sent, because the S3's CRC is over the decoded PCM. Nothing sent means no `expected`, as before. The stand-in S3 decodes by the flag as the firmware does.

**Files:**
- Modify: `bridge/src/link/frame.js`, `bridge/src/link/link.js`, `bridge/src/link/messages.js`, `protocol/frames.md`
- Test (new): `bridge/test/link/audio-codec.test.js`
- Test (changed): `bridge/test/helpers/fake-s3.js`, `bridge/test/link/messages.test.js`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `bridge/test/helpers/fake-s3.js`, replace:

```js
import { EventEmitter } from 'node:events';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { FrameDecoder } from '../../src/link/decoder.js';
```

with:

```js
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';
import { FLAG, TYPE, encodeFrame } from '../../src/link/frame.js';
import { decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';
import { FrameDecoder } from '../../src/link/decoder.js';
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  #downBytes = 0;
  #ringBytes;
```

with:

```js
  #downBytes = 0;
  #downCrc = 0;
  #adpcm;
  #upCodec = 0; // what CMD SET_CODEC last asked for; a HELLO puts it back to 0
  #upIndex = 0;
  badDown = 0; // AUDIO_DOWN frames that did not decode
  #ringBytes;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d } = {}) {
    super();
```

with:

```js
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  // `adpcm`: the HELLO flags say it takes ADPCM. It decodes AUDIO_DOWN by the codec flag whatever the flags say, and sends AUDIO_UP as
  // ADPCM once CMD SET_CODEC 1 has come.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d, adpcm = false } = {}) {
    super();
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    this.#nonceS = nonceS;
  }
```

with:

```js
    this.#nonceS = nonceS;
    this.#adpcm = adpcm;
  }

  get upCodec() {
    return this.#upCodec;
  }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
        break;
      case TYPE.AUDIO_DOWN:
        this.#downBytes += f.payload.length;
        if (f.payload.length > 0) this.feed(TYPE.CREDIT, u32(f.payload.length));
        if (f.flags & FLAG.EOS) this.#played(0);
        break;
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        break;
```

with:

```js
        break;
      case TYPE.AUDIO_DOWN: {
        const codec = (f.flags >> 1) & 3;
        const pcm = f.payload.length === 0 || codec === 0 ? f.payload : codec === 1 ? decodeAdpcm(f.payload) : null;
        if (pcm === null) {
          this.badDown++;
        } else {
          this.#downBytes += pcm.length;
          this.#downCrc = crc32(pcm, this.#downCrc);
          if (pcm.length > 0) this.feed(TYPE.CREDIT, u32(pcm.length));
        }
        if (f.flags & FLAG.EOS) this.#played(0);
        break;
      }
      case TYPE.CMD:
        if (f.payload[0] === CMD.STOP_AUDIO) this.#played(1);
        if (f.payload[0] === CMD.SET_CODEC) {
          this.#upCodec = f.payload[1];
          this.#upIndex = 0;
        }
        break;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    this.#lastNonceP = nonceP;
    const v2 = this.#proto >= 2;
```

with:

```js
    this.#lastNonceP = nonceP;
    this.#upCodec = 0;
    this.#upIndex = 0;
    const v2 = this.#proto >= 2;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      hello.writeUInt32LE(nonceS, 18);
      hello[22] = this.#paired ? 1 : 0;
      this.session = this.#master ? new Session({ master: this.#master, nonceP, nonceS, role: 's3' }) : null;
```

with:

```js
      hello.writeUInt32LE(nonceS, 18);
      hello[22] = (this.#paired ? 1 : 0) | (this.#adpcm ? 2 : 0);
      this.session = this.#master ? new Session({ master: this.#master, nonceP, nonceS, role: 's3' }) : null;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(0), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
  }
```

with:

```js
  #played(reason) {
    this.feed(TYPE.PLAYED, Buffer.concat([u32(this.#downBytes), u32(this.#downCrc), u32(0), u32(0), Buffer.from([reason])]));
    this.#downBytes = 0;
    this.#downCrc = 0;
  }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      const last = at + FRAME >= pcm.length;
      this.feed(TYPE.AUDIO_UP, pcm.subarray(at, at + FRAME), last ? FLAG.EOS | (reason ? FLAG.REASON : 0) : 0);
    }
```

with:

```js
      const last = at + FRAME >= pcm.length;
      const flags = last ? FLAG.EOS | (reason ? FLAG.REASON : 0) : 0;
      if (this.#upCodec === 1) {
        const r = encodeAdpcm(pcm.subarray(at, at + FRAME), this.#upIndex);
        this.#upIndex = last ? 0 : r.index;
        this.feed(TYPE.AUDIO_UP, r.frame, flags | 0x02);
      } else {
        this.feed(TYPE.AUDIO_UP, pcm.subarray(at, at + FRAME), flags);
      }
    }
```

Create `bridge/test/link/audio-codec.test.js`:

```js
// ADPCM on the link (protocol/frames.md, "Audio codec"): the Link encodes replies when it is asked to and the walkie takes it, asks for
// ADPCM from the walkie, and hands listeners PCM16 whatever the walkie sent. The stand-in S3 (test/helpers/fake-s3.js) decodes by the
// codec flag as the firmware does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { decodeAdpcm, encodeAdpcm } from '../../src/link/adpcm.js';
import { Link } from '../../src/link/link.js';
import { TYPE } from '../../src/link/frame.js';
import { CMD } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

const KEY = Buffer.alloc(32, 7);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const tone = (samples, hz, rate) => {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
};

async function connect(t, { s3 = {}, link: linkOptions = {} } = {}) {
  const device = new FakeS3({ proto: 2, ...s3 });
  const link = new Link({ openPort: async () => device, makeNonce: () => 0x5eed1234, ...linkOptions });
  const seen = { status: [], 'audio-up': [], played: [] };
  for (const name of Object.keys(seen)) link.on(name, (x) => seen[name].push(x));
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return { device, link, seen };
}

// What the walkie plays for `pcm` sent as ADPCM in frames of `size` bytes: the reference encoder, the index carried, then decoded.
function playedFor(pcm, size = 960) {
  let index = 0;
  const parts = [];
  for (let at = 0; at < pcm.length; at += size) {
    const r = encodeAdpcm(pcm.subarray(at, at + size), index);
    index = r.index;
    parts.push(decodeAdpcm(r.frame));
  }
  return Buffer.concat(parts);
}

const setCodecFrames = (device) => device.frames(TYPE.CMD).filter((f) => f.payload[0] === CMD.SET_CODEC);

test('with ADPCM on and a walkie that takes it, a reply goes down as 244-byte frames and credit counts the 960 decoded bytes', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const pcm = tone(4800, 440, 24000); // 200 ms
  const played = await link.playAudio(pcm);
  const frames = device.frames(TYPE.AUDIO_DOWN);
  assert.equal(frames.length, 10);
  assert.ok(frames.every((f) => (f.flags & 0x06) === 0x02), 'every frame carries the ADPCM codec flag');
  assert.ok(frames.every((f) => f.payload.length === 244));
  const heard = playedFor(pcm);
  assert.equal(played.bytes, 9600, 'PLAYED counts decoded bytes');
  assert.equal(played.crc32, crc32(heard), 'the walkie decoded what the reference decoder gives');
  assert.notEqual(played.crc32, crc32(pcm), 'which is not the PCM that went in: the codec is lossy');
  assert.deepEqual(played.expected, { bytes: 9600, crc32: crc32(heard) }, 'and the Link knew what to expect');
  assert.equal(device.badDown, 0);
  assert.equal(link.credit, 12288, 'credit given back for decoded bytes ends where it began');
});

test('a reply that ends on a single sample is a 4-byte frame, and the stream still ends with EOS', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const pcm = tone(961, 300, 24000);
  const played = await link.playAudio(pcm);
  const frames = device.frames(TYPE.AUDIO_DOWN);
  assert.deepEqual(frames.map((f) => f.payload.length), [244, 244, 4]);
  assert.ok(frames.at(-1).flags & 0x01, 'EOS on the last');
  assert.equal(played.bytes, 1922);
  assert.equal(played.expected.crc32, played.crc32);
});

test('the step index starts at 0 for each reply', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  const loud = tone(960, 700, 24000);
  await link.playAudio(loud);
  await link.playAudio(loud);
  const firsts = device.frames(TYPE.AUDIO_DOWN).filter((f, i, all) => i === 0 || all[i - 1].flags & 0x01);
  assert.equal(firsts.length, 2);
  assert.ok(firsts.every((f) => f.payload[2] === 0), 'both replies begin at index 0');
});

test('without the option the link is PCM16 as before, and what to expect is the CRC of the PCM', async (t) => {
  const { device, link } = await connect(t, { s3: { adpcm: true } });
  const pcm = tone(2400, 440, 24000);
  const played = await link.playAudio(pcm);
  assert.ok(device.frames(TYPE.AUDIO_DOWN).every((f) => (f.flags & 0x06) === 0 && f.payload.length <= 960));
  assert.equal(played.crc32, crc32(pcm));
  assert.deepEqual(played.expected, { bytes: 4800, crc32: crc32(pcm) });
  assert.equal(setCodecFrames(device).length, 0, 'and the walkie is not asked for ADPCM');
});

test('ADPCM asked for from a walkie that does not say it takes it: PCM16, and one status says why', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { adpcm: false }, link: { adpcm: true } });
  await link.playAudio(tone(1200, 440, 24000));
  assert.ok(device.frames(TYPE.AUDIO_DOWN).every((f) => (f.flags & 0x06) === 0));
  assert.equal(seen.status.filter((s) => /ADPCM/.test(s)).length, 1, JSON.stringify(seen.status));
  device.rehello();
  await settle();
  await settle();
  assert.equal(seen.status.filter((s) => /ADPCM/.test(s)).length, 1, 'said once for the link, not for every handshake');
  assert.equal(setCodecFrames(device).length, 0);
});

test('the walkie is asked for ADPCM once the link is ready, and again after every HELLO answer, since a HELLO puts it back to PCM16', async (t) => {
  const { device } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  assert.equal(setCodecFrames(device).length, 1);
  device.rehello();
  await until(() => setCodecFrames(device).length === 2, 'SET_CODEC again');
  await until(() => device.upCodec === 1, 'the walkie on ADPCM again');
});

test('on a sealed link the same: SET_CODEC goes out sealed, after the link is ready, and again after a re-key', async (t) => {
  const { device } = await connect(t, { s3: { adpcm: true, master: KEY }, link: { adpcm: true, master: KEY } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  assert.equal(setCodecFrames(device).length, 1);
  assert.ok(device.raw.filter((f) => f.type === TYPE.CMD).every((f) => f.flags & 0x80), 'sealed');
  device.rehello();
  await until(() => setCodecFrames(device).length === 2, 'SET_CODEC after the re-key');
  await until(() => device.upCodec === 1, 'the walkie on ADPCM again');
});

test('AUDIO_UP that arrives as ADPCM reaches listeners as PCM16 of 640 bytes a frame, with EOS and the codec bits gone', async (t) => {
  const { device, seen } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  await until(() => device.upCodec === 1, 'SET_CODEC 1');
  const pcm = tone(1600, 500, 16000); // 100 ms: five frames
  device.take(pcm);
  await until(() => seen['audio-up'].length === 5, 'five AUDIO_UP frames');
  const got = seen['audio-up'];
  assert.ok(got.every((f) => f.payload.length === 640 && (f.flags & 0x06) === 0));
  assert.deepEqual(got.map((f) => f.flags & 1), [0, 0, 0, 0, 1]);
  assert.equal(Buffer.concat(got.map((f) => f.payload)).compare(playedFor(pcm, 640)), 0, 'the PCM the reference decoder gives');
  device.feed(TYPE.AUDIO_UP, Buffer.alloc(0), 0x01 | 0x02); // a take ended by an empty EOS frame, whatever codec it says
  await until(() => seen['audio-up'].length === 6, 'the empty EOS frame');
  assert.equal(seen['audio-up'][5].payload.length, 0);
  assert.equal(seen['audio-up'][5].flags & 0x06, 0);
});

test('AUDIO_UP is untouched while the walkie is still on PCM16', async (t) => {
  const { device, seen } = await connect(t, { s3: { adpcm: true } });
  const pcm = tone(640, 500, 16000);
  device.take(pcm);
  await until(() => seen['audio-up'].length === 2, 'two frames');
  assert.equal(Buffer.concat(seen['audio-up'].map((f) => f.payload)).compare(pcm), 0);
});

test('an AUDIO_UP frame that is no good is dropped and counted, and the link says so once', async (t) => {
  const { device, link, seen } = await connect(t, { s3: { adpcm: true }, link: { adpcm: true } });
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 99, 0, 1, 2]), 0x02); // step index 99
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 0]), 0x02); // shorter than its header
  device.feed(TYPE.AUDIO_UP, Buffer.from([0, 0, 0, 0, 1, 2]), 0x04); // codec 2 is reserved
  await settle();
  await settle();
  assert.equal(seen['audio-up'].length, 0);
  assert.equal(link.badAudioFrames, 3);
  assert.equal(seen.status.filter((s) => /AUDIO_UP/.test(s)).length, 1, JSON.stringify(seen.status));
});
```

In `bridge/test/link/messages.test.js`, replace:

```js
import {
  helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload,
```

with:

```js
import {
  CMD, helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload,
```

In `bridge/test/link/messages.test.js`, replace:

```js
  cmd_reboot: (f) => cmdPayload(f.op),
  test_up_pattern: (f) => testPayload(f.op, f.frames),
```

with:

```js
  cmd_reboot: (f) => cmdPayload(f.op),
  cmd_set_codec: (f) => cmdPayload(f.op, f.arg),
  test_up_pattern: (f) => testPayload(f.op, f.frames),
```

In `bridge/test/link/messages.test.js`, replace:

```js
  assert.equal(PROTO, 1);
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
```

with:

```js
  assert.equal(PROTO, 1);
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
```

In `bridge/test/link/messages.test.js`, replace:

```js
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
});
```

with:

```js
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
});

test('SET_CODEC takes 0 (PCM16) or 1 (ADPCM) and nothing else', () => {
  assert.equal(cmdPayload(CMD.SET_CODEC, 1).toString('hex'), '0601');
  assert.equal(cmdPayload(CMD.SET_CODEC, 0).toString('hex'), '0600');
  for (const arg of [2, 255, -1, 0.5, undefined]) assert.throws(() => cmdPayload(CMD.SET_CODEC, arg), RangeError, `codec ${arg}`);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/link/audio-codec.test.js bridge/test/link/messages.test.js`
Expected: FAIL, 11 tests fail: `with ADPCM on and a walkie that takes it, a reply goes down as 244-byte frames and credit counts the 960 decoded bytes`, `a reply that ends on a single sample is a 4-byte frame, and the stream still ends with EOS`, `the step index starts at 0 for each reply`, `without the option the link is PCM16 as before, and what to expect is the CRC of the PCM`, `ADPCM asked for from a walkie that does not say it takes it: PCM16, and one status says why`, `the walkie is asked for ADPCM once the link is ready, and again after every HELLO answer, since a HELLO puts it back to PCM16`, and 5 more.

- [ ] **Step 3: Write the implementation**

In `bridge/src/link/frame.js`, replace:

```js
export const FLAG = Object.freeze({ EOS: 0x01, REASON: 0x08 });
export const MAX_PAYLOAD = 1024;
```

with:

```js
export const FLAG = Object.freeze({ EOS: 0x01, REASON: 0x08 });
// The codec of an AUDIO frame is bits 1-2 of its flags (protocol/frames.md, "Audio codec").
export const CODEC = Object.freeze({ PCM16: 0, ADPCM: 1 });
export const CODEC_MASK = 0x06;
export const codecOf = (flags) => (flags & CODEC_MASK) >> 1;
export const codecFlags = (codec) => (codec << 1) & CODEC_MASK;
export const MAX_PAYLOAD = 1024;
```

In `bridge/src/link/link.js`, replace:

```js
import { EventEmitter } from 'node:events';
import { CreditGate } from './credits.js';
import { FrameDecoder } from './decoder.js';
import { FLAG, TYPE, encodeFrame } from './frame.js';
import { MAX_PLAIN, Session } from './session.js';
```

with:

```js
import { EventEmitter } from 'node:events';
import { crc32 } from 'node:zlib';
import { decodeAdpcm, encodeAdpcm } from './adpcm.js';
import { CreditGate } from './credits.js';
import { FrameDecoder } from './decoder.js';
import { CODEC, CODEC_MASK, FLAG, TYPE, codecFlags, codecOf, encodeFrame } from './frame.js';
import { MAX_PLAIN, Session } from './session.js';
```

In `bridge/src/link/link.js`, replace:

```js
  #helloInfo = null;

```

with:

```js
  #helloInfo = null;
  #adpcmWanted;
  #adpcm = false; // wanted, and the walkie said it takes it
  #warnedAdpcm = false;
  #warnedAudio = false;
  badAudioFrames = 0; // AUDIO_UP frames dropped for not decoding

```

In `bridge/src/link/link.js`, replace:

```js
  // is plain, and refuses a walkie that is paired. `pairing` is for `walkie pair`: a plain link that holds no key and does not
  // ping, and hands up only PAIR frames. `firstCounter` is the first send counter of a session, for tests.
  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0 }) {
    super();
```

with:

```js
  // is plain, and refuses a walkie that is paired. `pairing` is for `walkie pair`: a plain link that holds no key and does not
  // ping, and hands up only PAIR frames. `firstCounter` is the first send counter of a session, for tests. `adpcm`: send replies as ADPCM and
  // ask the walkie for ADPCM takes, when the walkie says it takes it (protocol/frames.md, "Audio codec"); listeners get PCM16 either way.
  constructor({ openPort, retryMs = 1000, makeNonce = () => randomInt(1, 0x100000000), master = null, pairing = false, firstCounter = 0, adpcm = false }) {
    super();
```

In `bridge/src/link/link.js`, replace:

```js
    this.#firstCounter = firstCounter;
  }
```

with:

```js
    this.#firstCounter = firstCounter;
    this.#adpcmWanted = adpcm;
  }
```

In `bridge/src/link/link.js`, replace:

```js
    const stop = new AbortController();
    const stream = { stop, sent: 0, error: null };
    stream.played = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
```

with:

```js
    const stop = new AbortController();
    const stream = { stop, sent: 0, error: null, index: 0, crc: 0 }; // sent and crc are of the PCM the walkie will have, decoded
    stream.played = new Promise((resolve, reject) => Object.assign(stream, { resolve, reject }));
```

In `bridge/src/link/link.js`, replace:

```js
        }
        this.send(TYPE.AUDIO_DOWN, carry.subarray(0, n), last ? FLAG.EOS : 0);
        stream.sent += n;
        carry = carry.subarray(last ? carry.length : n);
```

with:

```js
        }
        const chunk = carry.subarray(0, n);
        let payload = chunk;
        let flags = last ? FLAG.EOS : 0;
        let heard = chunk;
        if (this.#adpcm && n > 0) {
          const r = encodeAdpcm(chunk, stream.index);
          stream.index = r.index;
          payload = r.frame;
          flags |= codecFlags(CODEC.ADPCM);
          heard = decodeAdpcm(r.frame); // what the walkie will decode, so that PLAYED can be checked
        }
        this.send(TYPE.AUDIO_DOWN, payload, flags);
        stream.sent += n;
        stream.crc = crc32(heard, stream.crc);
        carry = carry.subarray(last ? carry.length : n);
```

In `bridge/src/link/link.js`, replace:

```js
      if (!eos) {
        if (stream.sent === 0) return { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 };
        this.send(TYPE.AUDIO_DOWN, Buffer.alloc(0), FLAG.EOS); // ends the S3's discarding
```

with:

```js
      if (!eos) {
        if (stream.sent === 0) return { bytes: 0, crc32: 0, underruns: 0, maxFill: 0, reason: 1 }; // nothing was sent: there is nothing to expect
        this.send(TYPE.AUDIO_DOWN, Buffer.alloc(0), FLAG.EOS); // ends the S3's discarding
```

In `bridge/src/link/link.js`, replace:

```js
      if (sourceError && !stop.signal.aborted) throw sourceError;
      return played;
    } finally {
```

with:

```js
      if (sourceError && !stop.signal.aborted) throw sourceError;
      return { ...played, expected: { bytes: stream.sent, crc32: stream.crc } }; // of what was sent: a reply that was stopped played less
    } finally {
```

In `bridge/src/link/link.js`, replace:

```js
      case TYPE.AUDIO_UP:
        this.emit('audio-up', f);
        break;
```

with:

```js
      case TYPE.AUDIO_UP:
        this.#onAudioUp(f);
        break;
```

In `bridge/src/link/link.js`, replace:

```js

  #onDeviceHello(hello, seq) {
```

with:

```js

  // Listeners get PCM16 whatever the walkie sent. A frame that does not decode is dropped and counted, and said once.
  #onAudioUp(f) {
    const codec = codecOf(f.flags);
    if (f.payload.length === 0 || codec === CODEC.PCM16) {
      this.emit('audio-up', codec === CODEC.PCM16 ? f : { ...f, flags: f.flags & ~CODEC_MASK }); // an empty EOS frame stays empty
      return;
    }
    const pcm = codec === CODEC.ADPCM ? decodeAdpcm(f.payload) : null;
    if (pcm === null) {
      this.badAudioFrames++;
      if (!this.#warnedAudio) {
        this.#warnedAudio = true;
        this.emit('status', `an AUDIO_UP frame with codec ${codec} did not decode and was dropped`);
      }
      return;
    }
    this.emit('audio-up', { ...f, flags: f.flags & ~CODEC_MASK, payload: pcm });
  }

  #onDeviceHello(hello, seq) {
```

In `bridge/src/link/link.js`, replace:

```js
    this.#helloInfo = hello;
    if (!this.#master) {
```

with:

```js
    this.#helloInfo = hello;
    this.#adpcm = this.#adpcmWanted && hello.adpcm === true;
    if (this.#adpcmWanted && !this.#adpcm && !this.#warnedAdpcm) {
      this.#warnedAdpcm = true;
      this.emit('status', 'walkie does not take ADPCM (older firmware): replies and takes stay PCM16');
    }
    if (!this.#master) {
```

In `bridge/src/link/link.js`, replace:

```js
    this.#session = new Session({ master: this.#master, nonceP: this.#nonce, nonceS: hello.nonceS, role: 'pc', counter: this.#firstCounter });
    if (this.#ready) return;
    if (!this.#pending) {
```

with:

```js
    this.#session = new Session({ master: this.#master, nonceP: this.#nonce, nonceS: hello.nonceS, role: 'pc', counter: this.#firstCounter });
    if (this.#ready) {
      this.#askForAdpcm();
      return;
    }
    if (!this.#pending) {
```

In `bridge/src/link/link.js`, replace:

```js
    }
    if (!this.#announced) {
```

with:

```js
    }
    this.#askForAdpcm();
    if (!this.#announced) {
```

In `bridge/src/link/link.js`, replace:

```js

  #ping() {
```

with:

```js

  // A HELLO puts the walkie's uplink back to PCM16, so this follows every answer that starts a session.
  #askForAdpcm() {
    if (this.#adpcm) this.cmd(CMD.SET_CODEC, 1);
  }

  #ping() {
```

In `bridge/src/link/messages.js`, replace:

```js
export const PROTO = 1;
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
```

with:

```js
export const PROTO = 1;
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
```

In `bridge/src/link/messages.js`, replace:

```js
      break;
    case CMD.STOP_AUDIO:
```

with:

```js
      break;
    case CMD.SET_CODEC:
      if (!isInt(arg, 0, 1)) throw new RangeError(`codec must be 0 (PCM16) or 1 (ADPCM), not ${arg}`);
      break;
    case CMD.STOP_AUDIO:
```

In `protocol/frames.md`, replace:

```markdown
| 5 | REBOOT | none | restarts walkie |

```

with:

```markdown
| 5 | REBOOT | none | restarts walkie |
| 6 | SET_CODEC | u8: 0 PCM16, 1 ADPCM | the codec of AUDIO_UP from now on (see Audio codec); a HELLO puts it back to PCM16, so the PC sends it again after every HELLO answer. Anything else than 0 or 1 is refused with a LOG line. AUDIO_DOWN needs no such command: its frames carry their codec |

```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/link/audio-codec.test.js bridge/test/link/messages.test.js`
Expected: PASS, 21 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 770 tests, the tools' 17, and `189 cases, 1032 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/link/frame.js bridge/src/link/link.js bridge/src/link/messages.js bridge/test/helpers/fake-s3.js bridge/test/link/audio-codec.test.js bridge/test/link/messages.test.js protocol/frames.md
git commit -m "Task 11: the Link sends replies as ADPCM and asks the S3 for ADPCM takes when asked to" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The pairing key file

Where the key lives and how it changes: `%APPDATA%\walkie\pair.key`, 64 hex characters and a newline, never printed. A new key is written first as the candidate `pair.key.new` and renamed over `pair.key` in one step when the S3 has said OK, so there is never a moment with no key or half of one, and a crash between the OK and the rename leaves the candidate for the next run to offer again. A file that is not a key is reported as "not a key (64 hex characters expected)" without the text it held, and a read error as the file and the error code only. Every function takes the file as an argument (default: under `%APPDATA%`), so a test uses a temporary folder and never finds the real key.

**Files:**
- Create: `bridge/src/config/pairkey.js`
- Test (new): `bridge/test/config/pairkey.test.js`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/config/pairkey.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  commitPairKey, defaultPairKeyFile, discardPairCandidate, forgetPairKey, loadPairCandidate, loadPairKey, writePairCandidate,
} from '../../src/config/pairkey.js';

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pairkey-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'pair.key'); // the folder does not exist yet
}
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i));
const OTHER = Buffer.alloc(32, 0x11);

test('the key lives beside keys.env in %APPDATA%\\walkie, and there is no default without APPDATA', () => {
  assert.equal(defaultPairKeyFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'walkie', 'pair.key'));
  assert.equal(defaultPairKeyFile({}), null);
});

test('with no file there is no key, and that is not an error', (t) => {
  const file = tempFile(t);
  assert.equal(loadPairKey({ file }), null);
  assert.equal(loadPairCandidate({ file }), null);
});

test('a key is written as a candidate first and becomes the key only when it is committed', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  assert.equal(loadPairKey({ file }), null, 'a candidate is not the key');
  assert.equal(loadPairCandidate({ file }).compare(KEY), 0);
  assert.equal(readFileSync(`${file}.new`, 'utf8'), `${KEY.toString('hex')}\n`, '64 hex characters and a newline');
  commitPairKey({ file });
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
  assert.equal(loadPairCandidate({ file }), null, 'and the candidate is gone');
  assert.deepEqual(readdirSync(path.dirname(file)), ['pair.key'], 'nothing else is left beside it');
});

test('committing replaces the key that was there, and a stale candidate is replaced by a new one', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  writePairCandidate(KEY, { file });
  writePairCandidate(OTHER, { file });
  assert.equal(loadPairKey({ file }).compare(KEY), 0, 'the old key stands until the new one is committed');
  commitPairKey({ file });
  assert.equal(loadPairKey({ file }).compare(OTHER), 0);
});

test('discarding a candidate leaves the key, and discarding when there is none is quiet', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  discardPairCandidate({ file });
  assert.equal(loadPairCandidate({ file }), null);
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
  assert.doesNotThrow(() => discardPairCandidate({ file }));
});

test('forgetting removes the key and any candidate, and is quiet when there is nothing', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writePairCandidate(OTHER, { file });
  forgetPairKey({ file });
  assert.equal(loadPairKey({ file }), null);
  assert.equal(loadPairCandidate({ file }), null);
  assert.doesNotThrow(() => forgetPairKey({ file }));
});

test('a file that is not 64 hex characters is refused, and the error never holds what the file said', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  for (const bad of ['', '#!#', 'zz'.repeat(32), `${KEY.toString('hex')}00`, 'my secret passphrase', `${KEY.toString('hex').slice(0, 62)}`]) {
    writeFileSync(file, bad);
    assert.throws(
      () => loadPairKey({ file }),
      (err) => err instanceof Error && err.message.includes(file) && !err.message.includes(bad.slice(0, 8) || '\0'),
      JSON.stringify(bad.length),
    );
  }
});

test('an editor that added a BOM, CRLF or capitals is forgiven', (t) => {
  const file = tempFile(t);
  writePairCandidate(KEY, { file });
  commitPairKey({ file });
  writeFileSync(file, `\uFEFF${KEY.toString('hex').toUpperCase()}\r\n`);
  assert.equal(loadPairKey({ file }).compare(KEY), 0);
});

test('only a 32-byte key can be written, and committing with no candidate says so', (t) => {
  const file = tempFile(t);
  assert.throws(() => writePairCandidate(Buffer.alloc(31), { file }), RangeError);
  assert.throws(() => writePairCandidate(Buffer.alloc(33), { file }), RangeError);
  assert.throws(() => writePairCandidate('a'.repeat(64), { file }), RangeError);
  assert.equal(existsSync(path.dirname(file)), false, 'a refused key leaves nothing behind');
  assert.throws(() => commitPairKey({ file }), /no pairing key to commit/);
});

test('a file that cannot be read for another reason than being absent is an error', (t) => {
  const file = tempFile(t);
  assert.throws(
    () =>
      loadPairKey({
        file,
        read: () => {
          throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
        },
      }),
    (err) => /cannot read/.test(err.message) && err.message.includes(file) && !err.message.includes('denied'),
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/config/pairkey.test.js`
Expected: FAIL, the file `bridge/test/config/pairkey.test.js` cannot load, because it imports `bridge/src/config/pairkey.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/config/pairkey.js`:

```js
// The pairing key (protocol/frames.md, "Pairing"): 32 bytes in %APPDATA%\walkie\pair.key, written as 64 hex characters and a newline. It
// goes nowhere else: not into errors, not into logs, and nothing here says what it is, only where it lives and whether it is usable.
//
// A new key is written first as a candidate, pair.key.new, and renamed over pair.key only once the walkie has said OK. A key that was
// never accepted does not replace one that works, and a crash between the walkie's OK and the rename leaves the candidate behind, so
// the next `walkie pair` can offer the very same key again and the walkie accepts it without asking.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const KEY_BYTES = 32;

export function defaultPairKeyFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'pair.key') : null;
}

const candidateOf = (file) => `${file}.new`;

function parse(text, file) {
  const hex = text.trim(); // trim() drops a BOM and CRLF too
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`the pairing key file ${file} is not a key (64 hex characters expected)`);
  return Buffer.from(hex, 'hex');
}

function load(file, read) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`cannot read the pairing key file ${file} (${err.code ?? 'error'})`);
  }
  return parse(text, file);
}

// The key as 32 bytes, or null when this PC has none.
export function loadPairKey({ file = defaultPairKeyFile(), read = readFileSync } = {}) {
  return file ? load(file, read) : null;
}

// The candidate an earlier `walkie pair` left, or null.
export function loadPairCandidate({ file = defaultPairKeyFile(), read = readFileSync } = {}) {
  return file ? load(candidateOf(file), read) : null;
}

export function writePairCandidate(key, { file = defaultPairKeyFile() } = {}) {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new RangeError(`a pairing key is ${KEY_BYTES} bytes`);
  if (!file) throw new Error('there is nowhere to keep a pairing key: %APPDATA% is not set');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(candidateOf(file), `${Buffer.from(key).toString('hex')}\n`, { mode: 0o600 });
}

// The rename replaces pair.key in one step: there is never a moment with no key, or with half of one.
export function commitPairKey({ file = defaultPairKeyFile() } = {}) {
  try {
    renameSync(candidateOf(file), file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no pairing key to commit: ${candidateOf(file)} is not there`);
    throw err;
  }
}

function remove(file) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function discardPairCandidate({ file = defaultPairKeyFile() } = {}) {
  remove(candidateOf(file));
}

export function forgetPairKey({ file = defaultPairKeyFile() } = {}) {
  remove(candidateOf(file));
  remove(file);
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/config/pairkey.test.js`
Expected: PASS, 10 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 780 tests, the tools' 17, and `189 cases, 1032 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/config/pairkey.js bridge/test/config/pairkey.test.js
git commit -m "Task 12: the pairing key file: pair.key as 64 hex characters, written as a candidate and committed by one rename" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: runPair: offer a key, wait for the key press on the walkie, keep the key only when it says OK, then prove it over a sealed link

`walkie pair` as a function. It opens a `Link` in pairing mode, waits for a HELLO answer, offers the stored candidate or a new random key, repeating the SET every 3 s until the S3 answers that very op, and acts on the answer: OK commits the key and then opens a sealed `Link` with it to prove that it works (`paired`, or `unverified` when the S3 took the key and no sealed link came up); DENIED deletes the candidate; no answer keeps it. FORGET asks the same way and, on OK, deletes this PC's key. Everything the person should read goes through `say`, and the key is never in it. The stand-in S3 learns the person: it can press yes, press no, ask first and be answered later, lose its OK, or take the key and then not answer to it. A repeated SET rescues a lost OK, because an S3 that already holds the key answers OK at once.

**Files:**
- Create: `bridge/src/pair.js`
- Test (new): `bridge/test/pair.test.js`
- Test (changed): `bridge/test/helpers/fake-s3.js`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  badDown = 0; // AUDIO_DOWN frames that did not decode
  #ringBytes;
```

with:

```js
  badDown = 0; // AUDIO_DOWN frames that did not decode
  #pairMode;
  #pendingPair = null;
  pairRequests = []; // every PAIR request that came: { op, key }
  #ringBytes;
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  // `adpcm`: the HELLO flags say it takes ADPCM. It decodes AUDIO_DOWN by the codec flag whatever the flags say, and sends AUDIO_UP as
  // ADPCM once CMD SET_CODEC 1 has come.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d, adpcm = false } = {}) {
    super();
```

with:

```js
  // pairing key, 32 bytes) is given. With a key it keeps the session and seals what it sends, except HELLO and PAIR.
  // `pairing` is what the person at the walkie does with a PAIR request: null (nothing is ever answered), 'yes' or 'no' (answered at once, as
  // if the front or the side key had been pressed), 'ask' (held until confirmPair()), 'lose-reply' (the key is taken but the OK never
  // arrives) or 'wrong-key' (it says OK but keeps another key). A request for the key it already holds is answered OK at once, as the
  // firmware does. `adpcm`: the HELLO flags say it takes ADPCM. It decodes AUDIO_DOWN by the codec flag whatever the flags say, and sends AUDIO_UP as
  // ADPCM once CMD SET_CODEC 1 has come.
  constructor({ ringBytes = 262144, version = '0.0.0-fake', proto = 1, master = null, nonceS = 0x0a0b0c0d, adpcm = false, pairing = null } = {}) {
    super();
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    this.#adpcm = adpcm;
  }
```

with:

```js
    this.#adpcm = adpcm;
    this.#pairMode = pairing;
  }

  // The key the walkie holds, or null when it is not paired.
  get heldKey() {
    return this.#paired ? Buffer.from(this.#master) : null;
  }

  // The front key (yes) or the side key (no), pressed on the pairing screen.
  confirmPair(yes) {
    const p = this.#pendingPair;
    this.#pendingPair = null;
    if (p) this.#decidePair(p, yes ? 'yes' : 'no');
  }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
    this.emit('close');
  }
```

with:

```js
    this.emit('close');
    this.removeAllListeners('data'); // a closed port says nothing more, even to a Link that is still listening
  }
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
        break;
      default:
```

with:

```js
        break;
      case TYPE.PAIR:
        this.#onPair(f.payload);
        break;
      default:
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js

  #answerHello(nonceP) {
```

with:

```js

  #onPair(p) {
    const op = p[0];
    const key = op === 1 ? Buffer.from(p.subarray(1, 33)) : null;
    this.pairRequests.push({ op, key });
    if (op === 1 && this.#paired && this.#master.equals(key)) this.#pairReply(3, op);
    else if (op === 2 && !this.#paired) this.#pairReply(3, op);
    else if (this.#pairMode === 'ask') this.#pendingPair = { op, key };
    else if (this.#pairMode) this.#decidePair({ op, key }, this.#pairMode);
  }

  #decidePair({ op, key }, mode) {
    if (mode === 'no') {
      this.#pairReply(4, op);
      return;
    }
    if (op === 1) {
      this.#master = mode === 'wrong-key' ? Buffer.alloc(32, 0x5a) : key;
      this.#paired = true;
    } else {
      this.#master = null;
      this.#paired = false;
    }
    this.session = null; // the keys that were in use came from the old key
    if (mode !== 'lose-reply') this.#pairReply(3, op);
  }

  #pairReply(reply, answered) {
    this.feed(TYPE.PAIR, Buffer.from([reply, answered]), 0, { plain: true });
  }

  #answerHello(nonceP) {
```

Create `bridge/test/pair.test.js`:

```js
// `walkie pair` (protocol/frames.md, "Pairing"): put a new key on the walkie over the cable, with a key press on the walkie as the
// yes, and keep it on this PC only once the walkie has said so. The stand-in S3 plays the person at the walkie (test/helpers/fake-s3.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPairCandidate, loadPairKey, writePairCandidate, commitPairKey } from '../src/config/pairkey.js';
import { runPair } from '../src/pair.js';
import { TYPE } from '../src/link/frame.js';
import { FakeS3, until } from './helpers/fake-s3.js';

const OLD = Buffer.alloc(32, 0x33);
// Generous where something is expected to happen, because a busy machine runs these beside the rest of the suite; a test that expects a
// time to run out says so in its own options.
const FAST = { helloMs: 3000, answerMs: 3000, resendMs: 40, verifyMs: 3000, retryMs: 20 };

function setup(t, deviceOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pair.key');
  const device = new FakeS3({ proto: 2, adpcm: true, ...deviceOptions });
  const said = [];
  const run = (options = {}) =>
    runPair({ openPort: async () => device, file, say: (line) => said.push(line), makeNonce: () => 0x1234abcd, ...FAST, ...options });
  return { dir, file, device, said, run };
}
const files = (dir) => readdirSync(dir).sort();

test('the person presses yes: the walkie holds the key, this PC keeps it, and a sealed link proves it', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'yes' });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  const kept = loadPairKey({ file });
  assert.equal(kept.compare(device.heldKey), 0, 'the same key on both sides');
  assert.deepEqual(files(dir), ['pair.key'], 'no candidate left behind');
  assert.ok(device.raw.some((f) => f.type !== TYPE.HELLO && f.type !== TYPE.PAIR && f.flags & 0x80), 'the check ran over a sealed link');
  assert.ok(said.some((l) => /front key/.test(l)), 'it tells the person what to press');
  assert.ok(said.some((l) => /verified|sealed/.test(l)), JSON.stringify(said));
  assert.ok(!said.join('\n').includes(kept.toString('hex')), 'and never says the key');
});

test('the person presses no: nothing is kept and a key that worked is not touched', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'no' });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run();
  assert.equal(result.outcome, 'denied');
  assert.equal(loadPairKey({ file }).compare(OLD), 0);
  assert.deepEqual(files(dir), ['pair.key'], 'the candidate was thrown away');
  assert.equal(device.heldKey, null);
  assert.ok(said.some((l) => /refused|side key|30 s/.test(l)), JSON.stringify(said));
});

test('a walkie that is paired already can be paired again: the key press is what counts', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'yes', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  const kept = loadPairKey({ file });
  assert.notEqual(kept.compare(OLD), 0, 'a new key');
  assert.equal(kept.compare(device.heldKey), 0);
});

test('the request is repeated until it is answered, and the answer can come late', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'ask' });
  const done = run();
  await until(() => device.pairRequests.length >= 3, 'the request three times');
  assert.ok(device.pairRequests.every((r) => r.key.compare(device.pairRequests[0].key) === 0), 'always the same key');
  device.confirmPair(true);
  assert.equal((await done).outcome, 'paired');
  assert.equal(loadPairKey({ file }).compare(device.heldKey), 0);
});

test('an answer to another request is not an answer', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'ask' });
  const done = run();
  await until(() => device.pairRequests.length >= 1, 'the request');
  device.feed(TYPE.PAIR, Buffer.from([3, 2]), 0, { plain: true }); // OK to a FORGET
  device.feed(TYPE.PAIR, Buffer.from([4, 2]), 0, { plain: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(loadPairKey({ file }), null, 'nothing was kept for an answer that was not to this');
  device.confirmPair(false);
  assert.equal((await done).outcome, 'denied');
});

test('no answer: the candidate stays, and the next run offers the same key, which the walkie takes without asking', async (t) => {
  const { dir, file, device, said, run } = setup(t, { pairing: 'lose-reply' });
  const first = await run({ resendMs: 10_000, answerMs: 300 }); // no repeat inside the time allowed: the one answer was lost
  assert.equal(first.outcome, 'no-answer');
  assert.deepEqual(files(dir), ['pair.key.new'], 'the key the walkie may hold is still on this PC');
  assert.ok(device.heldKey, 'the walkie did take it: only the answer was lost');
  assert.ok(said.some((l) => /run .*pair.* again|no answer/i.test(l)), JSON.stringify(said));
  const offered = loadPairCandidate({ file });
  const second = await run();
  assert.equal(second.outcome, 'paired');
  assert.equal(device.pairRequests.at(-1).key.compare(offered), 0, 'the same key again');
  assert.equal(loadPairKey({ file }).compare(offered), 0);
});

test('a walkie that took the key but cannot be reached with it is reported, not called paired', async (t) => {
  const { file, run } = setup(t, { pairing: 'wrong-key' });
  const result = await run({ verifyMs: 400 });
  assert.equal(result.outcome, 'unverified');
  assert.ok(loadPairKey({ file }), 'the key was accepted, so it is kept: the next `walkie pair` can put it right');
});

test('forgetting: the walkie says OK, and then this PC lets go of the key', async (t) => {
  const { dir, file, device, run } = setup(t, { pairing: 'yes', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'forgotten');
  assert.equal(device.heldKey, null);
  assert.deepEqual(files(dir), []);
  assert.equal(device.pairRequests.at(-1).op, 2);
});

test('forgetting is refused at the walkie: the key stays on both sides', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'no', master: OLD });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'denied');
  assert.equal(device.heldKey.compare(OLD), 0);
  assert.equal(loadPairKey({ file }).compare(OLD), 0);
});

test('forgetting at a walkie that holds no key: it says OK at once, and this PC still lets go of its key', async (t) => {
  const { dir, file, run } = setup(t, { pairing: null });
  writePairCandidate(OLD, { file });
  commitPairKey({ file });
  const result = await run({ forget: true });
  assert.equal(result.outcome, 'forgotten');
  assert.deepEqual(files(dir), []);
});

test('no walkie on the cable: it says so and leaves nothing on disk', async (t) => {
  const { dir, file, said } = setup(t);
  await assert.rejects(
    runPair({ openPort: async () => { throw new Error('no S3 on USB (303A:1001)'); }, file, say: (l) => said.push(l), ...FAST, helloMs: 300 }),
    /no walkie answered/,
  );
  assert.equal(existsSync(file), false);
  assert.deepEqual(existsSync(dir) ? files(dir) : [], []);
});

test('a repeated request rescues a lost OK: the walkie holds the key already and says OK at once', async (t) => {
  const { file, device, run } = setup(t, { pairing: 'lose-reply' });
  const result = await run();
  assert.equal(result.outcome, 'paired');
  assert.ok(device.pairRequests.length >= 2);
  assert.equal(loadPairKey({ file }).compare(device.heldKey), 0);
});

test('a walkie that never answers: no-answer, nothing is held, and the candidate waits for the next run', async (t) => {
  const { dir, device, run } = setup(t, { pairing: null });
  const result = await run({ answerMs: 300 });
  assert.equal(result.outcome, 'no-answer');
  assert.equal(device.heldKey, null);
  assert.deepEqual(files(dir), ['pair.key.new']);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/pair.test.js`
Expected: FAIL, the file `bridge/test/pair.test.js` cannot load, because it imports `bridge/src/pair.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `bridge/src/pair.js`:

```js
// `walkie pair` and `walkie pair --forget` (protocol/frames.md, "Pairing"). Pairing happens over the cable: this PC offers a key, the
// person presses the front key on walkie to accept (the side key, or 30 s of nothing, refuses), and only when walkie has said OK does
// the key become this PC's. The key is never printed.
import { randomBytes } from 'node:crypto';
import {
  commitPairKey, defaultPairKeyFile, discardPairCandidate, forgetPairKey, loadPairCandidate, writePairCandidate,
} from './config/pairkey.js';
import { TYPE } from './link/frame.js';
import { Link } from './link/link.js';
import { PAIR_OP, pairForgetPayload, pairSetPayload, parsePairReply } from './link/messages.js';

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

// Sends `payload` every `resendMs` until walkie answers that very op (a repeated request changes nothing on walkie), or null after `answerMs`.
function ask(link, op, payload, { resendMs, answerMs }) {
  return new Promise((resolve) => {
    let resend;
    let giveUp;
    const finish = (reply) => {
      clearInterval(resend);
      clearTimeout(giveUp);
      link.off('frame', onFrame);
      resolve(reply);
    };
    const onFrame = (f) => {
      if (f.type !== TYPE.PAIR) return;
      const reply = parsePairReply(f.payload);
      if (reply && reply.answered === op) finish(reply);
    };
    link.on('frame', onFrame);
    resend = setInterval(() => link.send(TYPE.PAIR, payload), resendMs);
    giveUp = setTimeout(() => finish(null), answerMs);
    link.send(TYPE.PAIR, payload);
  });
}

// Resolves with { outcome }: 'paired', 'forgotten', 'denied', 'no-answer' or 'unverified' (walkie took the key but a sealed link with it
// did not come up). Rejects when no walkie answers HELLO at all. Everything the person should read goes through `say`.
export async function runPair({
  openPort,
  forget = false,
  file = defaultPairKeyFile(),
  say = console.log,
  makeKey = () => randomBytes(32),
  makeNonce,
  helloMs = 10_000,
  answerMs = 40_000,
  resendMs = 3000,
  verifyMs = 5000,
  retryMs = 1000,
}) {
  if (!file) throw new Error('there is nowhere to keep a pairing key: %APPDATA% is not set');
  const linkOptions = { openPort, retryMs, ...(makeNonce ? { makeNonce } : {}) };
  const link = new Link({ ...linkOptions, pairing: true });
  link.on('status', (s) => say(`[link] ${s}`));
  let reply;
  let key = null;
  try {
    const up = arrivesWithin(link, 'hello', helloMs);
    await link.start();
    if (!(await up)) throw new Error(`no walkie answered within ${helloMs / 1000} s: is it plugged in and running walkie?`);
    if (forget) {
      say('Press the front key on walkie to let it forget this PC (the side key refuses).');
    } else {
      try {
        key = loadPairCandidate({ file }); // an earlier attempt that never heard back: the same key again
      } catch {
        discardPairCandidate({ file });
      }
      key ??= makeKey();
      writePairCandidate(key, { file });
      say('Press the front key on walkie to accept this PC (the side key refuses). walkie waits 30 s.');
    }
    const op = forget ? PAIR_OP.FORGET : PAIR_OP.SET;
    reply = await ask(link, op, forget ? pairForgetPayload() : pairSetPayload(key), { resendMs, answerMs });
  } finally {
    link.close();
  }
  if (reply === null) {
    say(`No answer from walkie. Run \`walkie pair${forget ? ' --forget' : ''}\` again${forget ? '' : ': the same key is offered again, so a key walkie did take is not lost'}.`);
    return { outcome: 'no-answer' };
  }
  if (reply.op === PAIR_OP.DENIED) {
    if (!forget) discardPairCandidate({ file });
    say('walkie refused: the side key was pressed, or 30 s went by. Nothing changed.');
    return { outcome: 'denied' };
  }
  if (forget) {
    forgetPairKey({ file });
    say('walkie no longer holds a pairing key, and this PC has let go of its key.');
    return { outcome: 'forgotten' };
  }
  commitPairKey({ file });
  const sealed = new Link({ ...linkOptions, master: key });
  try {
    const up = arrivesWithin(sealed, 'hello', verifyMs);
    await sealed.start();
    if (await up) {
      say('Paired. A sealed link to walkie came up with the new key: verified.');
      return { outcome: 'paired' };
    }
  } finally {
    sealed.close();
  }
  say('walkie accepted the key, but a sealed link with it did not come up. Run `walkie pair` again.');
  return { outcome: 'unverified' };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/pair.test.js`
Expected: PASS, 13 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 793 tests, the tools' 17, and `189 cases, 1032 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/src/pair.js bridge/test/helpers/fake-s3.js bridge/test/pair.test.js
git commit -m "Task 13: runPair: offer a key, wait for the key press on the walkie, keep the key only when it says OK, then prove it over a sealed link" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: walkie pair and walkie pair --forget, the pairing key into the bridge and the dev commands, and --codec

The commands. `parseWalkieCommand` knows `pair` (with `--forget` and `--port`) and the bridge's own options plus `--codec pcm|adpcm`; anything else, or `--forget` or `--codec` or `--clean-env` in the wrong place, is a usage error before any key is loaded or port opened. `bin/walkie.js` loads the key and passes it as `master` to `startBridge`, which hands it to the `Link`, with `adpcm` for the codec; the dev commands get `opts.master` the same way through `connect()`, so every `walkie-dev` command works against a paired S3 in sealed frames. `pairCommand` runs `runPair` and turns its outcome into an exit code and the lines the person reads. Only the two bins call `loadPairKey()` with its default path; `bridge/test/walkie-bin.test.js` runs the bin in a private `%APPDATA%`.

**Files:**
- Create: `bridge/src/cli.js`, `bridge/src/pair-cli.js`
- Modify: `bridge/bin/walkie-dev.js`, `bridge/bin/walkie.js`, `bridge/src/dev/args.js`, `bridge/src/dev/connect.js`, `bridge/src/main.js`
- Test (new): `bridge/test/cli.test.js`, `bridge/test/pair-cli.test.js`
- Test (changed): `bridge/test/dev/args.test.js`, `bridge/test/helpers/world.js`, `bridge/test/main.test.js`, `bridge/test/walkie-bin.test.js`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/cli.test.js`:

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
```

In `bridge/test/dev/args.test.js`, replace:

```js
  assert.deepEqual(parseArgs(['say', '--help me', '--', '---', '--5']).args, ['--help me', '--', '---', '--5']);
});
```

with:

```js
  assert.deepEqual(parseArgs(['say', '--help me', '--', '---', '--5']).args, ['--help me', '--', '---', '--5']);
});

test('--codec takes pcm or adpcm and nothing else, and --forget stays among the arguments', () => {
  assert.deepEqual(parseArgs(['--codec', 'adpcm', 'play', 'x.wav']), { name: 'play', args: ['x.wav'], opts: { codec: 'adpcm' } });
  assert.deepEqual(parseArgs(['play', '--codec=pcm']).opts, { codec: 'pcm' });
  for (const argv of [['--codec', 'opus'], ['--codec=ADPCM'], ['--codec', '']]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && /--codec/.test(err.message), argv.join(' '));
  }
  assert.deepEqual(parseArgs(['pair', '--forget']), { name: 'pair', args: ['--forget'], opts: {} });
});
```

In `bridge/test/helpers/world.js`, replace:

```js
// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
```

with:

```js
// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
// `s3` is the stand-in S3's options, `link` those of startBridge that belong to the link (master, adpcm).
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent, s3: s3Options = {}, link: linkOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
```

In `bridge/test/helpers/world.js`, replace:

```js
  mkdirSync(project);
  const s3 = new FakeS3();
  const lines = [];
```

with:

```js
  mkdirSync(project);
  const s3 = new FakeS3(s3Options);
  const lines = [];
```

In `bridge/test/helpers/world.js`, replace:

```js
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
  });
```

with:

```js
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
    ...linkOptions,
  });
```

In `bridge/test/main.test.js`, replace:

```js
  assert.equal(denies, 1);
});
```

with:

```js
  assert.equal(denies, 1);
});

const KEY = Buffer.alloc(32, 0x42);

test('with the pairing key and ADPCM, a whole turn runs sealed: the take comes up as ADPCM and the reply goes down as ADPCM', async (t) => {
  const w = await world(t, { said: ['你好'], s3: { proto: 2, master: KEY, adpcm: true }, link: { master: KEY, adpcm: true } });
  await until(() => w.s3.upCodec === 1, 'the S3 asked for ADPCM takes');
  w.s3.take(speechPcm);
  await until(() => w.s3.screens().some((s) => s.state === UI_STATE.REPLY), 'the REPLY screen');
  await until(() => w.s3.audioDown().ended, 'the spoken reply to reach the S3');
  assert.match(w.shown(UI_STATE.REPLY).text, /I heard: 你好/);
  assert.ok(w.s3.raw.filter((f) => f.type !== TYPE.HELLO).every((f) => f.flags & 0x80), 'every frame after HELLO was sealed');
  assert.equal(w.s3.refused.length, 0);
  assert.ok(w.s3.frames(TYPE.AUDIO_DOWN).every((f) => !f.payload.length || (f.flags & 0x06) === 0x02), 'the reply went down as ADPCM');
  assert.equal(w.s3.badDown, 0);
});
```

Create `bridge/test/pair-cli.test.js`:

```js
// The part of `walkie pair` between the command line and runPair: what it is given, what it says, and the exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairCommand } from '../src/pair-cli.js';

const run = async (outcome, { forget = false } = {}) => {
  const calls = [];
  const lines = [];
  const code = await pairCommand({
    forget,
    openPort: 'the opener',
    say: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    run: async (options) => {
      calls.push(options);
      if (outcome instanceof Error) throw outcome;
      return { outcome };
    },
  });
  return { code, calls, lines };
};

test('it hands runPair the port opener and whether to forget, and says what runPair says', async () => {
  const a = await run('paired');
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].openPort, 'the opener');
  assert.equal(a.calls[0].forget, false);
  assert.equal(typeof a.calls[0].say, 'function');
  const b = await run('forgotten', { forget: true });
  assert.equal(b.calls[0].forget, true);
});

test('paired and forgotten are exit 0, and anything else is exit 1', async () => {
  assert.equal((await run('paired')).code, 0);
  assert.equal((await run('forgotten', { forget: true })).code, 0);
  for (const outcome of ['denied', 'no-answer', 'unverified']) assert.equal((await run(outcome)).code, 1, outcome);
});

test('a walkie that is not there is exit 1 with the reason, not a stack trace', async () => {
  const r = await run(new Error('no walkie answered within 10 s'));
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, ['ERR no walkie answered within 10 s']);
});
```

In `bridge/test/walkie-bin.test.js`, replace:

```js

test('a --command that is not a JSON array stops it before anything is started', () => {
```

with:

```js

test('pair takes only --forget and --port, --forget is only for pair, and --codec is pcm or adpcm', () => {
  for (const args of [['pair', '--bogus'], ['pair', 'now'], ['pair', '--clean-env'], ['pair', '--codec', 'adpcm'], ['--forget'], ['--codec', 'opus'], ['--codec']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out, /usage: node bridge\/bin\/walkie\.js/, args.join(' '));
  }
});

test('a --command that is not a JSON array stops it before anything is started', () => {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/cli.test.js bridge/test/dev/args.test.js bridge/test/main.test.js bridge/test/pair-cli.test.js bridge/test/walkie-bin.test.js`
Expected: FAIL, 2 tests fail: `--codec takes pcm or adpcm and nothing else, and --forget stays among the arguments`, `with the pairing key and ADPCM, a whole turn runs sealed: the take comes up as ADPCM and the reply goes down as ADPCM`; the files `bridge/test/cli.test.js`, `bridge/test/pair-cli.test.js` cannot load, because they import `bridge/src/cli.js`, `bridge/src/pair-cli.js`, which does not exist yet.

- [ ] **Step 3: Write the implementation**

In `bridge/bin/walkie-dev.js`, replace:

```js
// Developer commands for the S3 link.
import { parseArgs, UsageError } from '../src/dev/args.js';
```

with:

```js
// Developer commands for the S3 link.
import { loadPairKey } from '../src/config/pairkey.js';
import { parseArgs, UsageError } from '../src/dev/args.js';
```

In `bridge/bin/walkie-dev.js`, replace:

```js
try {
  await run(args, opts);
```

with:

```js
try {
  opts.master = loadPairKey(); // a paired S3 is talked to in sealed frames only
  await run(args, opts);
```

In `bridge/bin/walkie.js`, replace:

```js
// walkie: the bridge between the S3 and Claude Code. It runs until Ctrl+C.
import { loadConfig } from '../src/config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../src/config/keys.js';
import { loadProjects } from '../src/config/projects.js';
import { createConsole } from '../src/console.js';
import { parseArgs, UsageError } from '../src/dev/args.js';
import { cleanEnv, commandFrom } from '../src/dev/claude.js';
```

with:

```js
// walkie: the bridge between the S3 and Claude Code. It runs until Ctrl+C.
import { parseWalkieCommand } from '../src/cli.js';
import { loadConfig } from '../src/config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../src/config/keys.js';
import { loadPairKey } from '../src/config/pairkey.js';
import { loadProjects } from '../src/config/projects.js';
import { createConsole } from '../src/console.js';
import { UsageError } from '../src/dev/args.js';
import { cleanEnv, commandFrom } from '../src/dev/claude.js';
```

In `bridge/bin/walkie.js`, replace:

```js
import { startBridge } from '../src/main.js';
import { createAdapters } from '../src/speech/speech.js';

const USAGE = `usage: node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env] [--inject file.wav]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
```

with:

```js
import { startBridge } from '../src/main.js';
import { pairCommand } from '../src/pair-cli.js';
import { createAdapters } from '../src/speech/speech.js';

const USAGE = `usage: node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env] [--inject file.wav] [--codec pcm|adpcm]
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
```

In `bridge/bin/walkie.js`, replace:

```js
                    own shell, whose variables point a nested claude at the app instead of at the login
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

with:

```js
                    own shell, whose variables point a nested claude at the app instead of at the login
  --codec adpcm     send replies as ADPCM and ask the S3 for ADPCM takes (default pcm: over the cable there is bandwidth to spare)
  pair              put a new pairing key on the S3 over the cable. Press the front key on the S3 to accept (the side key refuses).
                    The key is kept in %APPDATA%\\walkie\\pair.key and the bridge then talks to the S3 only in sealed frames.
                    pair --forget makes the S3 forget its key and this PC delete its own.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
```

In `bridge/bin/walkie.js`, replace:

```js
try {
  parsed = parseArgs(process.argv.slice(2));
  const words = [parsed.name, ...parsed.args].filter((w) => w !== undefined);
  if (words.some((w) => w !== '--clean-env')) throw new UsageError(`${words.find((w) => w !== '--clean-env')} is not something walkie takes`);
  parsed.cleanEnv = words.includes('--clean-env');
} catch (err) {
```

with:

```js
try {
  parsed = parseWalkieCommand(process.argv.slice(2));
} catch (err) {
```

In `bridge/bin/walkie.js`, replace:

```js

let injected = null;
```

with:

```js

if (parsed.command === 'pair') {
  const code = await pairCommand({ forget: parsed.forget, openPort: portOpener(opts.port) });
  await new Promise((resolve) => setTimeout(resolve, 300)); // lets the port finish closing
  process.exit(code);
}

let injected = null;
```

In `bridge/bin/walkie.js`, replace:

```js
  const keys = loadKeys();
  con.log(`[keys] ${describeKeys(keys)}`);
```

with:

```js
  const keys = loadKeys();
  const master = loadPairKey();
  con.log(master ? '[pair] a pairing key is present: the link to the S3 is sealed' : '[pair] no pairing key: the link to the S3 is plain (node bridge/bin/walkie.js pair)');
  con.log(`[keys] ${describeKeys(keys)}`);
```

In `bridge/bin/walkie.js`, replace:

```js
    openPort: portOpener(opts.port),
    console: con,
```

with:

```js
    openPort: portOpener(opts.port),
    master,
    adpcm: opts.codec === 'adpcm',
    console: con,
```

Create `bridge/src/cli.js`:

```js
// The command line of bin/walkie.js, apart from the process: `walkie [options]` runs the bridge, `walkie pair [--forget] [--port COMx]`
// pairs (or unpairs) the S3 over the cable.
import { UsageError, parseArgs } from './dev/args.js';

export function parseWalkieCommand(argv) {
  const { name, args, opts } = parseArgs(argv);
  if (name === 'pair') {
    const extra = args.find((word) => word !== '--forget');
    if (extra !== undefined) throw new UsageError(`${extra} is not something walkie pair takes`);
    for (const option of Object.keys(opts)) if (option !== 'port') throw new UsageError(`--${option} is not something walkie pair takes`);
    return { command: 'pair', forget: args.includes('--forget'), opts };
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
const SWITCHES = ['--all', '--clean-env', '--forget']; // stay among the arguments, for the command that reads them
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

Replace the whole of `bridge/src/dev/connect.js` with:

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
  // `opts.master` is the pairing key, which bin/walkie-dev.js loads: this file reads no key of its own, so that a test never finds the
  // real one.
  const link = new Link({ openPort: portOpener(opts.port), master: opts.master ?? null, adpcm: opts.codec === 'adpcm' });
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

In `bridge/src/main.js`, replace:

```js
// The rest are for tests and the dev commands: `start` is the program that stands in for claude, `turn` overrides the turn's
// timings, `makeNonce` the link's HELLO nonce.
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
```

with:

```js
// The rest are for tests and the dev commands: `start` is the program that stands in for claude, `turn` overrides the turn's
// timings, `makeNonce` the link's HELLO nonce. `master` is the pairing key, `adpcm` asks for ADPCM audio (see Link).
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, master, adpcm, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce, master, adpcm });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
```

Create `bridge/src/pair-cli.js`:

```js
// `walkie pair`: runPair with the console around it, and an exit code. 0 when the walkie was paired (and proved it) or forgotten.
import { runPair } from './pair.js';

export async function pairCommand({ forget, openPort, run = runPair, say = console.log, err = console.error }) {
  try {
    const { outcome } = await run({ openPort, forget, say });
    return outcome === 'paired' || outcome === 'forgotten' ? 0 : 1;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/cli.test.js bridge/test/dev/args.test.js bridge/test/main.test.js bridge/test/pair-cli.test.js bridge/test/walkie-bin.test.js`
Expected: PASS, 34 tests, 0 fail.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 802 tests, the tools' 17, and `189 cases, 1032 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie-dev.js bridge/bin/walkie.js bridge/src/cli.js bridge/src/dev/args.js bridge/src/dev/connect.js bridge/src/main.js bridge/src/pair-cli.js bridge/test/cli.test.js bridge/test/dev/args.test.js bridge/test/helpers/world.js bridge/test/main.test.js bridge/test/pair-cli.test.js bridge/test/walkie-bin.test.js
git commit -m "Task 14: walkie pair and walkie pair --forget, the pairing key into the bridge and the dev commands, and --codec" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The S3's self-test

The mbedtls adapter is the one part of the sealed link the host tests cannot reach, so the S3 can check itself: `TEST` op 6 runs `proto::selfTest(mbedtlsCrypto())` and answers with one LOG line, `selftest ok: hkdf gcm-seal gcm-open gcm-tamper session` or `selftest FAILED, mask 0x..` with the bits that failed. It checks RFC 5869 test case 1 (HKDF), NIST GCM test case 16 (seal, open, and a tampered tag, ciphertext, AAD and nonce refused) and a sealed round trip through a PC to S3 `Session`, with buffers of 64 bytes because it runs on the RX task. It reads and writes no key. On the host the same function runs against the reference crypto, with wrappers that break one primitive at a time to prove each check can fail. `walkie-dev selftest` sends it and exits 0 for `ok` and 1 for a failure or no answer within 5 s; the stand-in S3 answers it.

**Files:**
- Create: `bridge/src/dev/selftest.js`, `firmware/lib/proto/src/proto/selftest.cpp`, `firmware/lib/proto/src/proto/selftest.h`
- Modify: `bridge/bin/walkie-dev.js`, `bridge/src/link/messages.js`, `firmware/lib/proto/src/proto/messages.h`, `firmware/src/main.cpp`, `protocol/frames.md`
- Test (new): `bridge/test/dev/selftest.test.js`, `firmware/host/test_selftest.cpp`
- Test (changed): `bridge/test/dev/walkie-dev.test.js`, `bridge/test/helpers/fake-s3.js`, `bridge/test/link/messages.test.js`, `firmware/host/test_state.cpp`, `protocol/gen_vectors.py`, `protocol/vectors.json`

**Interfaces:**

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/dev/selftest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selftest } from '../../src/dev/selftest.js';
import { TYPE } from '../../src/link/frame.js';
import { Link } from '../../src/link/link.js';
import { TEST_OP } from '../../src/link/messages.js';
import { FakeS3, until } from '../helpers/fake-s3.js';

// selftest() reaches the S3 through connect(); the fake link records what is sent and lets the test choose the answer.
function fakeLink() {
  const link = new EventEmitter();
  link.sent = [];
  link.closed = false;
  link.send = (type, payload) => link.sent.push({ type, payload });
  link.close = () => { link.closed = true; };
  return link;
}
const settle = () => new Promise((r) => setImmediate(r));

test('it asks the S3 to check its own crypto and prints the answer', async () => {
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].type, TYPE.TEST);
  assert.deepEqual([...link.sent[0].payload], [TEST_OP.SELFTEST]);
  link.emit('log', 'unrelated line');
  link.emit('log', 'selftest ok: hkdf gcm-seal gcm-open gcm-tamper session');
  assert.equal(await done, 0);
  assert.deepEqual(lines, ['selftest ok: hkdf gcm-seal gcm-open gcm-tamper session']);
  assert.equal(link.closed, true);
});

test('a failed check is exit code 1 and says which', async () => {
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  link.emit('log', 'selftest FAILED, mask 0x02 (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)');
  assert.equal(await done, 1);
  assert.match(lines[0], /FAILED, mask 0x02/);
});

test('no answer within the time allowed is exit code 1 and the link is closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const link = fakeLink();
  const lines = [];
  const done = selftest([], {}, async () => link, (l) => lines.push(l));
  await settle();
  t.mock.timers.tick(5000);
  assert.equal(await done, 1);
  assert.match(lines.join('\n'), /no answer/);
  assert.equal(link.closed, true);
});

// Through a real Link and the stand-in S3, so the TEST frame and the LOG answer are the real ones.
async function realLink(t, device) {
  const link = new Link({ openPort: async () => device, makeNonce: () => 0x5eed1234 });
  t.after(() => link.close());
  await link.start();
  await until(() => link.ready, 'the link to be ready');
  return link;
}

test('over a real link: the stand-in S3 gets TEST SELFTEST once and its answer is what is printed', async (t) => {
  const device = new FakeS3({ proto: 2 });
  const lines = [];
  assert.equal(await selftest([], {}, async () => realLink(t, device), (l) => lines.push(l)), 0);
  assert.equal(device.selftests, 1);
  assert.match(lines[0], /^selftest ok/);
});

test('over a real link: a FAILED answer from the S3 is exit code 1', async (t) => {
  const device = new FakeS3({ proto: 2 });
  device.selftestAnswer = 'selftest FAILED, mask 0x10 (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)';
  const lines = [];
  assert.equal(await selftest([], {}, async () => realLink(t, device), (l) => lines.push(l)), 1);
  assert.match(lines[0], /mask 0x10/);
});
```

In `bridge/test/dev/walkie-dev.test.js`, replace:

```js
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap', 'inject']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
```

with:

```js
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude', 'press', 'ui', 'snap', 'inject', 'selftest']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
```

In `bridge/test/helpers/fake-s3.js`, replace:

```js
      if (this.micSource) this.#fifo = Buffer.concat([this.#fifo, p.subarray(1)]);
    } else if (p[0] === TEST_OP.KEYS) {
```

with:

```js
      if (this.micSource) this.#fifo = Buffer.concat([this.#fifo, p.subarray(1)]);
    } else if (p[0] === TEST_OP.SELFTEST) {
      this.selftests = (this.selftests ?? 0) + 1;
      this.feed(TYPE.LOG, Buffer.from(this.selftestAnswer ?? 'selftest ok: hkdf gcm-seal gcm-open gcm-tamper session'));
    } else if (p[0] === TEST_OP.KEYS) {
```

In `bridge/test/link/messages.test.js`, replace:

```js
  CMD, helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload,
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
```

with:

```js
  CMD, helloPayload, pingPayload, cmdPayload, testPayload,
  uiPayload, approvalReqPayload, testKeysPayload, testMicSourcePayload, testMicPcmPayload, testSnapPayload, testSelftestPayload,
  parseHello, parsePong, parseCredit, parsePlayed, parseButton, parseApprovalRes, parseSnapChunk,
```

In `bridge/test/link/messages.test.js`, replace:

```js
  test_snap: () => testSnapPayload(),
  pair_set: (f) => pairSetPayload(hex(f.key)),
```

with:

```js
  test_snap: () => testSnapPayload(),
  test_selftest: () => testSelftestPayload(),
  pair_set: (f) => pairSetPayload(hex(f.key)),
```

In `bridge/test/link/messages.test.js`, replace:

```js
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
```

with:

```js
  assert.deepEqual({ ...CMD }, { SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
  assert.deepEqual({ ...TEST_OP }, { UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5, SELFTEST: 6 });
  assert.deepEqual({ ...PAIR_OP }, { SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
```

Create `firmware/host/test_selftest.cpp`:

```cpp
// test_selftest.cpp: the known-answer test the S3 runs on itself (TEST SELFTEST), here against the host's reference primitives, which must
// pass it, and against primitives with one fault each, which must not. The vectors are the RFC 5869 and NIST ones, so a pass here means
// the expected values are right, and a pass on the device means mbedtls agrees with them.
#include <string.h>
#include "check.h"
#include "proto/crypto.h"
#include "proto/selftest.h"
#include "ref_crypto.h"

namespace {
proto::Crypto base() { return refCrypto(); }

bool brokenHkdf(const uint8_t* ikm, size_t ikmLen, const uint8_t* salt, size_t saltLen, const uint8_t* info, size_t infoLen, uint8_t* okm,
                size_t okmLen) {
  bool ok = refCrypto().hkdf(ikm, ikmLen, salt, saltLen, info, infoLen, okm, okmLen);
  okm[okmLen - 1] ^= 1;
  return ok;
}
bool brokenSeal(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len, uint8_t* out,
                uint8_t* tag) {
  bool ok = refCrypto().gcmSeal(key, nonce, aad, aadLen, in, len, out, tag);
  out[0] ^= 1;
  return ok;
}
bool openNothing(const uint8_t*, const uint8_t*, const uint8_t*, size_t, const uint8_t*, size_t, const uint8_t*, uint8_t*) { return false; }
bool openAnything(const uint8_t* key, const uint8_t* nonce, const uint8_t* aad, size_t aadLen, const uint8_t* in, size_t len,
                  const uint8_t* tag, uint8_t* out) {
  refCrypto().gcmOpen(key, nonce, aad, aadLen, in, len, tag, out);
  return true;
}
}  // namespace

TEST(theReferencePrimitivesPassTheSelfTest) { CHECK(proto::selfTest(base()) == 0, "every known answer matches"); }

TEST(aWrongHkdfFailsTheHkdfCheck) {
  proto::Crypto c = base();
  c.hkdf = brokenHkdf;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_HKDF, "the RFC 5869 answer differs");
}

TEST(aWrongGcmSealFailsTheSealCheck) {
  proto::Crypto c = base();
  c.gcmSeal = brokenSeal;
  CHECK(proto::selfTest(c) & proto::ST_GCM_SEAL, "the NIST ciphertext differs");
}

TEST(aGcmOpenThatRefusesEverythingFailsTheOpenCheck) {
  proto::Crypto c = base();
  c.gcmOpen = openNothing;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_GCM_OPEN, "a good frame was refused");
  CHECK(!(failed & proto::ST_GCM_TAMPER), "refusing a bad one is not what failed");
}

TEST(aGcmOpenThatAcceptsEverythingFailsTheTamperCheck) {
  proto::Crypto c = base();
  c.gcmOpen = openAnything;
  uint8_t failed = proto::selfTest(c);
  CHECK(failed & proto::ST_GCM_TAMPER, "a damaged tag or ciphertext was accepted");
  CHECK(!(failed & proto::ST_GCM_OPEN), "accepting a good one is not what failed");
}

TEST(aSessionBetweenTwoRolesSealsOpensAndRefusesAReplay) {
  proto::Crypto c = base();
  c.gcmOpen = openAnything;  // a session that accepts forgeries must show in the session check as well
  CHECK(proto::selfTest(c) & proto::ST_SESSION, "a tampered frame opened");
}

TEST(primitivesThatAreMissingFailEverything) {
  proto::Crypto c = base();
  c.hkdf = nullptr;
  CHECK(proto::selfTest(c) == proto::ST_ALL, "nothing can be checked");
  c = base();
  c.gcmOpen = nullptr;
  CHECK(proto::selfTest(c) == proto::ST_ALL, "nothing can be checked");
}
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK(!proto::parseUpPattern(t.args, 1, frames), "a pattern length cut short");
  CHECK(!proto::parseTest(b.data(), 0, t), "an empty TEST payload");
```

with:

```cpp
  CHECK(!proto::parseUpPattern(t.args, 1, frames), "a pattern length cut short");
  b = unhex(msgHex("test_selftest").c_str());
  CHECK(proto::parseTest(b.data(), b.size(), t) && t.op == proto::TEST_SELFTEST && t.len == 0, "test_selftest");
  CHECK(!proto::parseTest(b.data(), 0, t), "an empty TEST payload");
```

In `firmware/host/test_state.cpp`, replace:

```cpp
  CHECK((unsigned)proto::TEST_UP_PATTERN == 1u, "TEST_UP_PATTERN");
  CHECK((unsigned)proto::PLAYED_FINISHED == 0u, "PLAYED_FINISHED");
```

with:

```cpp
  CHECK((unsigned)proto::TEST_UP_PATTERN == 1u, "TEST_UP_PATTERN");
  CHECK((unsigned)proto::TEST_SELFTEST == 6u, "TEST_SELFTEST");
  CHECK((unsigned)proto::PLAYED_FINISHED == 0u, "PLAYED_FINISHED");
```

In `protocol/gen_vectors.py`, replace:

```python
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('pair_set', 0x32, 'down', bytes([1]) + PAIR_KEY, {'op': 1, 'key': h(PAIR_KEY)}),
```

with:

```python
    ('test_snap', 0x31, 'down', bytes([5]), {'op': 5}),
    ('test_selftest', 0x31, 'down', bytes([6]), {'op': 6}),
    ('pair_set', 0x32, 'down', bytes([1]) + PAIR_KEY, {'op': 1, 'key': h(PAIR_KEY)}),
```

In `protocol/vectors.json`, replace:

```json
   }
  },
  {
   "name": "pair_set",
```

with:

```json
   }
  },
  {
   "name": "test_selftest",
   "type": 49,
   "dir": "down",
   "hex": "06",
   "fields": {
    "op": 6
   }
  },
  {
   "name": "pair_set",
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/dev/selftest.test.js bridge/test/dev/walkie-dev.test.js bridge/test/link/messages.test.js`
Expected: FAIL, 1 test fails: `with no command it lists every command it has, and exits 0`; the files `bridge/test/dev/selftest.test.js`, `bridge/test/link/messages.test.js` cannot load, because they import what the source does not have yet.

Run: `node firmware/host/run.mjs`
Expected: FAIL, `compile failed`: `proto/selftest.h: No such file or directory`, `'TEST_SELFTEST' is not a member of 'proto'`.

- [ ] **Step 3: Write the implementation**

In `bridge/bin/walkie-dev.js`, replace:

```js
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)
  inject <wav> [--out dir]   feed a 16 kHz recording to the S3 as its microphone and print the take that comes back`;

```

with:

```js
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)
  inject <wav> [--out dir]   feed a 16 kHz recording to the S3 as its microphone and print the take that comes back
  selftest                 the S3 checks its own HKDF, AES-GCM and sealed-session code against published vectors (exit 1 if not)`;

```

In `bridge/bin/walkie-dev.js`, replace:

```js
  inject: () => import('../src/dev/inject.js'),
};
```

with:

```js
  inject: () => import('../src/dev/inject.js'),
  selftest: () => import('../src/dev/selftest.js'),
};
```

Create `bridge/src/dev/selftest.js`:

```js
// selftest: the S3 checks its own crypto against published vectors (RFC 5869 HKDF, NIST AES-GCM) and a sealed session, and says so in one
// LOG line. The firmware's adapter over mbedtls is the one part of the sealed link the host tests cannot reach; this is how it is checked
// on the chip. It reads and writes no pairing key.
import { TYPE } from '../link/frame.js';
import { testSelftestPayload } from '../link/messages.js';
import { connect } from './connect.js';

const ANSWER_TIMEOUT_MS = 5000;

// 0 when the S3 says `selftest ok`, 1 for a failed check or no answer. connectFn and say are injectable so tests never touch a port.
export async function selftest(args, opts, connectFn = connect, say = console.log) {
  const link = await connectFn(opts);
  let timer;
  try {
    const answer = new Promise((resolve) => {
      link.on('log', (line) => {
        if (String(line).startsWith('selftest')) resolve(String(line));
      });
    });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ANSWER_TIMEOUT_MS);
    });
    link.send(TYPE.TEST, testSelftestPayload());
    const line = await Promise.race([answer, timeout]);
    if (line === null) {
      say('selftest: no answer from the S3 within 5 s (is it running firmware with the self-test?)');
      return 1;
    }
    say(line);
    return line.startsWith('selftest ok') ? 0 : 1;
  } finally {
    clearTimeout(timer);
    link.close();
  }
}

export default async function run(args, opts) {
  process.exitCode = await selftest(args, opts);
}
```

In `bridge/src/link/messages.js`, replace:

```js
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5 });
export const PAIR_OP = Object.freeze({ SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
```

with:

```js
export const CMD = Object.freeze({ SET_VOLUME: 1, SET_MIC_GAIN: 2, STOP_AUDIO: 3, BOOT_APP0: 4, REBOOT: 5, SET_CODEC: 6 });
export const TEST_OP = Object.freeze({ UP_PATTERN: 1, KEYS: 2, MIC_SOURCE: 3, MIC_PCM: 4, SNAP: 5, SELFTEST: 6 });
export const PAIR_OP = Object.freeze({ SET: 1, FORGET: 2, OK: 3, DENIED: 4 });
```

In `bridge/src/link/messages.js`, replace:

```js
export const testSnapPayload = () => Buffer.from([TEST_OP.SNAP]);

```

with:

```js
export const testSnapPayload = () => Buffer.from([TEST_OP.SNAP]);
export const testSelftestPayload = () => Buffer.from([TEST_OP.SELFTEST]);

```

In `firmware/lib/proto/src/proto/messages.h`, replace:

```cpp
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5 };
enum : uint8_t { UI_IDLE = 0, UI_TRANSCRIBING = 1, UI_CONFIRM = 2, UI_WORKING = 3, UI_REPLY = 4, UI_ERROR = 5 };
```

with:

```cpp
enum : uint8_t { CMD_SET_VOLUME = 1, CMD_SET_MIC_GAIN = 2, CMD_STOP_AUDIO = 3, CMD_BOOT_APP0 = 4, CMD_REBOOT = 5, CMD_SET_CODEC = 6 };
enum : uint8_t { TEST_UP_PATTERN = 1, TEST_KEYS = 2, TEST_MIC_SOURCE = 3, TEST_MIC_PCM = 4, TEST_SNAP = 5, TEST_SELFTEST = 6 };
enum : uint8_t { UI_IDLE = 0, UI_TRANSCRIBING = 1, UI_CONFIRM = 2, UI_WORKING = 3, UI_REPLY = 4, UI_ERROR = 5 };
```

Create `firmware/lib/proto/src/proto/selftest.cpp`:

```cpp
#include "proto/selftest.h"
#include <string.h>
#include "proto/frame.h"
#include "proto/session.h"

namespace proto {
namespace {
size_t unhex(const char* s, uint8_t* out) {
  size_t n = 0;
  for (; s[0] && s[1]; s += 2) {
    int v = 0;
    for (int i = 0; i < 2; i++) {
      char c = s[i];
      v = v * 16 + (c >= 'a' ? c - 'a' + 10 : c >= 'A' ? c - 'A' + 10 : c - '0');
    }
    out[n++] = (uint8_t)v;
  }
  return n;
}

// RFC 5869, appendix A.1.
const char* HKDF_IKM = "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b";
const char* HKDF_SALT = "000102030405060708090a0b0c";
const char* HKDF_INFO = "f0f1f2f3f4f5f6f7f8f9";
const char* HKDF_OKM = "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865";

// The GCM specification's test case 16 (AES-256, 96-bit nonce, 60 bytes of plaintext and 20 of additional data).
const char* GCM_KEY = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const char* GCM_NONCE = "cafebabefacedbaddecaf888";
const char* GCM_AAD = "feedfacedeadbeeffeedfacedeadbeefabaddad2";
const char* GCM_PLAIN =
    "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39";
const char* GCM_CIPHER =
    "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662";
const char* GCM_TAG = "76fc6ece0f4e1768cddf8853bb2d551b";

uint8_t checkHkdf(const Crypto& c) {
  uint8_t ikm[22], salt[13], info[10], want[42], got[42];
  unhex(HKDF_IKM, ikm);
  unhex(HKDF_SALT, salt);
  unhex(HKDF_INFO, info);
  unhex(HKDF_OKM, want);
  bool ok = c.hkdf(ikm, sizeof ikm, salt, sizeof salt, info, sizeof info, got, sizeof got);
  return ok && memcmp(got, want, sizeof want) == 0 ? 0 : ST_HKDF;
}

struct Gcm {
  uint8_t key[32], nonce[12], aad[20], plain[60], cipher[60], tag[16];
  Gcm() {
    unhex(GCM_KEY, key);
    unhex(GCM_NONCE, nonce);
    unhex(GCM_AAD, aad);
    unhex(GCM_PLAIN, plain);
    unhex(GCM_CIPHER, cipher);
    unhex(GCM_TAG, tag);
  }
};

uint8_t checkSeal(const Crypto& c, const Gcm& g) {
  uint8_t ct[60], tag[16];
  bool ok = c.gcmSeal(g.key, g.nonce, g.aad, sizeof g.aad, g.plain, sizeof g.plain, ct, tag);
  return ok && memcmp(ct, g.cipher, sizeof ct) == 0 && memcmp(tag, g.tag, sizeof tag) == 0 ? 0 : ST_GCM_SEAL;
}

uint8_t checkOpen(const Crypto& c, const Gcm& g) {
  uint8_t pt[60];
  bool ok = c.gcmOpen(g.key, g.nonce, g.aad, sizeof g.aad, g.cipher, sizeof g.cipher, g.tag, pt);
  return ok && memcmp(pt, g.plain, sizeof pt) == 0 ? 0 : ST_GCM_OPEN;
}

uint8_t checkTamper(const Crypto& c, const Gcm& g) {
  uint8_t pt[60];
  uint8_t tag[16], ct[60], aad[20];
  memcpy(tag, g.tag, sizeof tag);
  memcpy(ct, g.cipher, sizeof ct);
  memcpy(aad, g.aad, sizeof aad);
  tag[15] ^= 0x80;
  if (c.gcmOpen(g.key, g.nonce, g.aad, sizeof aad, g.cipher, sizeof ct, tag, pt)) return ST_GCM_TAMPER;
  ct[30] ^= 1;
  if (c.gcmOpen(g.key, g.nonce, g.aad, sizeof aad, ct, sizeof ct, g.tag, pt)) return ST_GCM_TAMPER;
  aad[0] ^= 1;
  if (c.gcmOpen(g.key, g.nonce, aad, sizeof aad, g.cipher, sizeof ct, g.tag, pt)) return ST_GCM_TAMPER;
  return 0;
}

uint8_t checkSession(const Crypto& c) {
  uint8_t master[KEY_BYTES];
  for (size_t i = 0; i < sizeof master; i++) master[i] = (uint8_t)(0x40 + i);
  Session pc, s3;
  if (!pc.begin(c, master, 0x11111111u, 0x22222222u, ROLE_PC) || !s3.begin(c, master, 0x11111111u, 0x22222222u, ROLE_S3)) return ST_SESSION;
  const uint8_t plain[6] = {'w', 'a', 'l', 'k', 'i', 'e'};
  uint8_t wire[64], out[64];  // small: this runs on the link's RX task
  size_t n = pc.seal(T_PING, 0, 5, plain, sizeof plain, wire, sizeof wire);
  if (n != sizeof plain + SEAL_OVERHEAD) return ST_SESSION;
  Frame f = {T_PING, (uint8_t)F_SEALED, 5, (uint16_t)n, wire};
  size_t got = 0;
  if (s3.open(f, out, sizeof out, got) != Session::Ok || got != sizeof plain || memcmp(out, plain, got) != 0) return ST_SESSION;
  if (s3.open(f, out, sizeof out, got) == Session::Ok) return ST_SESSION;  // the same frame again
  n = pc.seal(T_PING, 0, 6, plain, sizeof plain, wire, sizeof wire);
  wire[5] ^= 1;  // a bit of the ciphertext
  Frame forged = {T_PING, (uint8_t)F_SEALED, 6, (uint16_t)n, wire};
  if (s3.open(forged, out, sizeof out, got) == Session::Ok) return ST_SESSION;
  return 0;
}
}  // namespace

uint8_t selfTest(const Crypto& c) {
  if (!c.hkdf || !c.gcmSeal || !c.gcmOpen) return ST_ALL;
  Gcm g;
  return (uint8_t)(checkHkdf(c) | checkSeal(c, g) | checkOpen(c, g) | checkTamper(c, g) | checkSession(c));
}
}  // namespace proto
```

Create `firmware/lib/proto/src/proto/selftest.h`:

```cpp
// selftest.h: known-answer tests of a Crypto (proto/crypto.h), for the S3 to run on itself (TEST SELFTEST) so that the mbedtls adapter,
// which no host test reaches, is checked against published vectors on the real chip. The host tests run the same code against the
// reference primitives, which is what proves the expected values themselves.
#pragma once
#include <stdint.h>
#include "proto/crypto.h"

namespace proto {
enum : uint8_t {
  ST_HKDF = 1,         // RFC 5869 test case 1
  ST_GCM_SEAL = 2,     // NIST AES-256-GCM test case 16: ciphertext and tag
  ST_GCM_OPEN = 4,     // the same frame opens, to the plaintext
  ST_GCM_TAMPER = 8,   // a flipped bit in the tag, the ciphertext or the additional data is refused
  ST_SESSION = 16,     // a Session from the PC's role to the S3's: opens, a replay and a forgery are refused
  ST_ALL = 31,
};

// The bits of the checks that failed, 0 when all passed. A Crypto with a missing primitive fails them all.
uint8_t selfTest(const Crypto& c);
}  // namespace proto
```

In `firmware/src/main.cpp`, replace:

```cpp
#include "audio.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "screen.h"
```

with:

```cpp
#include "audio.h"
#include "crypto_mbedtls.h"
#include "proto/frame.h"
#include "proto/messages.h"
#include "proto/selftest.h"
#include "screen.h"
```

In `firmware/src/main.cpp`, replace:

```cpp
      post(K_SNAP, args, len);
      break;
    default:
      usblink::logf("test %u is not handled", op);
```

with:

```cpp
      post(K_SNAP, args, len);
      break;
    case proto::TEST_SELFTEST: {
      // The mbedtls adapter against the RFC 5869 and NIST vectors, on this chip. It reads and writes no pairing key.
      uint8_t failed = proto::selfTest(mbedtlsCrypto());
      if (failed == 0) usblink::logf("selftest ok: hkdf gcm-seal gcm-open gcm-tamper session");
      else usblink::logf("selftest FAILED, mask 0x%02x (1 hkdf, 2 gcm-seal, 4 gcm-open, 8 gcm-tamper, 16 session)", (unsigned)failed);
      break;
    }
    default:
      usblink::logf("test %u is not handled", op);
```

In `protocol/frames.md`, replace:

```markdown
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |

```

with:

```markdown
| 5 | SNAP | none | the S3 sends the screen as SNAP chunks |
| 6 | SELFTEST | none | the S3 checks its own HKDF, AES-GCM and sealed-session code against published vectors (RFC 5869, NIST) and answers with one LOG line that starts with `selftest ok` or `selftest FAILED`. It reads and writes no pairing key |

```

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test bridge/test/dev/selftest.test.js bridge/test/dev/walkie-dev.test.js bridge/test/link/messages.test.js`
Expected: PASS, 36 tests, 0 fail.

Run: `node firmware/host/run.mjs`
Expected: `196 cases, 1044 checks passed, 0 failed`.

Run: `& "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" run -d firmware -e sticks3`
Expected: `[SUCCESS]`, RAM 23.0%, Flash 27.2%.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 807 tests, the tools' 17, and `196 cases, 1044 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 6: Commit**

```powershell
git add bridge/bin/walkie-dev.js bridge/src/dev/selftest.js bridge/src/link/messages.js bridge/test/dev/selftest.test.js bridge/test/dev/walkie-dev.test.js bridge/test/helpers/fake-s3.js bridge/test/link/messages.test.js firmware/host/test_selftest.cpp firmware/host/test_state.cpp firmware/lib/proto/src/proto/messages.h firmware/lib/proto/src/proto/selftest.cpp firmware/lib/proto/src/proto/selftest.h firmware/src/main.cpp protocol/frames.md protocol/gen_vectors.py protocol/vectors.json
git commit -m "Task 15: selftest: the S3 checks its HKDF, AES-GCM and sealed session against RFC 5869 and NIST vectors (TEST op 6), walkie-dev selftest" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Gate P5 on the real S3, the README and the two spec amendments

The check that runs all of it on the real S3, written here and run by hand after the firmware is flashed, with his yes: `tools/gate-p5.mjs` runs the self-test on the chip, pairs the S3 with a throwaway key by a TEST key press (nobody needs to touch it), checks that a sealed link comes up with pings answered and the self-test run sealed, that a plain link and a link with another key get nothing, that a re-pair refused with the side key leaves the first key working, and that a 1.2 s take comes back as ADPCM decoded to PCM; then it makes the S3 forget the key, so it is left as it was found. It refuses an S3 that already holds a key, never touches `%APPDATA%\walkie\pair.key`, and writes the S3's NVS twice. The README gets a section on the sealed link and pairing, and the spec gets the two amendments (§4.3 and §4.5) its Summary names. This task writes the gate and does not run it.

**Files:**
- Create: `tools/gate-p5.mjs`
- Modify: `README.md`, `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`

**Interfaces:**

- [ ] **Step 1: Write the files**

In `README.md`, replace:

```markdown
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `src/speech` talks to OpenAI and Gemini; `src/intent` and `src/config` decide what was said and read the settings; `src/claude` runs Claude Code, one process per project, resumed, stopped and switched, and `src/perm` is the permission endpoint it asks and the queue of approvals waiting for the wrist; `src/turn` takes a recording through speech and Claude and back (approvals, replies, the take that is a reason for a deny), `src/ui` decides what the S3 shows, `src/console.js` is the log and `src/main.js` wires it all together; `bin/walkie.js` is the bridge itself, `bin/walkie-dev.js` and `src/dev` are developer commands |
| `tools/` | writing walkie into app1, choosing which app the S3 boots, and `gate-h.mjs`, the check of the screens and keys on the S3 |

```

with:

```markdown
| `bridge/` | the PC side (Node 24): `src/link` is the USB link; `src/speech` talks to OpenAI and Gemini; `src/intent` and `src/config` decide what was said and read the settings; `src/claude` runs Claude Code, one process per project, resumed, stopped and switched, and `src/perm` is the permission endpoint it asks and the queue of approvals waiting for the wrist; `src/turn` takes a recording through speech and Claude and back (approvals, replies, the take that is a reason for a deny), `src/ui` decides what the S3 shows, `src/console.js` is the log and `src/main.js` wires it all together; `bin/walkie.js` is the bridge itself, `bin/walkie-dev.js` and `src/dev` are developer commands |
| `tools/` | writing walkie into app1, choosing which app the S3 boots, and `gate-h.mjs`, the check of the screens and keys on the S3, and `gate-p5.mjs`, the check of pairing, the sealed link and ADPCM on it |

```

In `README.md`, replace:

```markdown
`boot.mjs app0` boots on-the-beat and `boot.mjs app1` boots walkie. `walkie-dev.js` with no arguments lists the
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify, claude, press, ui, snap, inject. `hear`, `say` and `classify` send text or recordings to OpenAI (and to Gemini when OpenAI fails), so they need the keys above and cost a little each time. `--provider openai` or `--provider gemini` (or `--provider=openai`) uses that provider alone. An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.

```

with:

```markdown
`boot.mjs app0` boots on-the-beat and `boot.mjs app1` boots walkie. `walkie-dev.js` with no arguments lists the
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify, claude, press, ui, snap, inject, selftest. `hear`, `say` and `classify` send text or recordings to OpenAI (and to Gemini when OpenAI fails), so they need the keys above and cost a little each time. `--provider openai` or `--provider gemini` (or `--provider=openai`) uses that provider alone. An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.

```

In `README.md`, replace:

```markdown
Takes recorded by `listen` are voice recordings; they go to `bridge/takes/`, which git ignores.
```

with:

````markdown
Takes recorded by `listen` are voice recordings; they go to `bridge/takes/`, which git ignores.

## The sealed link and pairing (plan 5)

Over the cable the link can be sealed: every frame but HELLO and PAIR is AES-256-GCM under a session key derived from a pairing key that only walkie and this PC hold (`protocol/frames.md`, "Sealed frames" and "Pairing"). It is the groundwork for using walkie away from the cable; the transport is still USB.

```bash
node bridge/bin/walkie.js pair
```

`pair` makes a new key and offers it to the S3 over the cable. The S3 shows a confirmation: the front key accepts, the side key (or 30 s) refuses. Only after the S3 says OK does the key become `%APPDATA%\walkie\pair.key` (64 hex characters; the file is never printed or logged), and the bridge then talks to the S3 in sealed frames only and verifies that a sealed link comes up. A key that was offered and never answered stays as `pair.key.new` and is offered again next time, so a key the S3 did take is not lost. `pair --forget` makes the S3 forget its key (front key again) and this PC delete its own. With no `pair.key` the link is plain, as before, and refuses an S3 that is paired. Anyone with the cable can ask, so the key press on the S3 is the whole authority.

`walkie.js --codec adpcm` sends replies as ADPCM (4 bits a sample, a quarter of the bytes) and asks the S3 for ADPCM takes; the default stays PCM because the cable has bandwidth to spare. `walkie-dev selftest` has the S3 check its own HKDF, AES-GCM and sealed-session code against published test vectors (it needs no key and prints `selftest ok`).

`node tools/gate-p5.mjs [--port COMx] [--only "scene;scene"]` checks all of this on the S3 with no hands and no API: the self-test on the chip, pairing with a throwaway key by a TEST key press, a sealed link, a refused plain link and wrong key, a refused re-pair, and an ADPCM take. It writes the S3's NVS (the key, then its removal) and refuses an S3 that already holds a key, so it never touches `pair.key`. The S3 must run the plan 5 firmware and nothing else may hold COM8.
````

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown
- Overhead is 20 bytes a frame. The 1024-byte limit applies to the plaintext; a sealed payload is at most 1044. The decoder limit and `protocol/frames.md` change with it.
- The CRC stays so that the damaged USB frames (about 1 in 1000) are dropped before decryption and are not mistaken for an attack.
```

with:

```markdown
- Overhead is 20 bytes a frame. The 1024-byte limit applies to the plaintext; a sealed payload is at most 1044. The decoder limit and `protocol/frames.md` change with it.
- **Amended in plan 5:** the frame limit stays 1024 for the whole payload, sealed or not, so a sealed frame carries at most 1004 bytes of plaintext. Every frame the firmware and the bridge send is far below that (the largest, audio, is 964 bytes plain), and a limit that does not move leaves the existing decoders, vectors and gates untouched.
- The CRC stays so that the damaged USB frames (about 1 in 1000) are dropped before decryption and are not mistaken for an attack.
```

In `docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md`, replace:

```markdown
- No downgrade: once paired, every frame except HELLO must be sealed, on every transport. That includes CMD (boot app0) and TEST.
- At counter 2^32 - 1 the link reconnects. This is a backstop; at 50 frames a second it is more than two years away.
```

with:

```markdown
- No downgrade: once paired, every frame except HELLO must be sealed, on every transport. That includes CMD (boot app0) and TEST.
- **Amended in plan 5:** PAIR frames are the second exception, on USB. A PC that has lost its key (a reinstall, a wiped `%APPDATA%`) could not otherwise ask the S3 to take a new one, and the person's key press on the S3 is what authorises SET and FORGET, not secrecy of the frame. PAIR is never accepted over any other transport.
- At counter 2^32 - 1 the link reconnects. This is a backstop; at 50 frames a second it is more than two years away.
```

Create `tools/gate-p5.mjs`:

```js
// Gate P5, on the real S3: the sealed link, pairing and ADPCM of plan 5, without anyone touching the device and without any API.
// The keys are pressed with TEST KEYS, so nobody needs to be at the S3. It pairs with a throwaway key made for this run, never with
// %APPDATA%\walkie\pair.key, and makes the S3 forget it again at the end; an S3 that already holds a key is refused at the start,
// because pairing here would replace the one that is in use.
// Usage: node tools/gate-p5.mjs [--port COMx] [--only "scene name;scene name"]
// Exit code 0 when every scene held, 1 when one did not. The S3 must run the plan 5 firmware (node tools/flash.mjs) and nothing else
// may hold its port (not walkie, not walkie-dev). It opens COM8 and writes the S3's NVS (the key, then its removal): run it only
// when the person at the machine has said so.
import { randomBytes } from 'node:crypto';
import { FLAG, TYPE } from '../bridge/src/link/frame.js';
import { Link } from '../bridge/src/link/link.js';
import { KEY, PAIR_OP, pairForgetPayload, pairSetPayload, parsePairReply, testKeysPayload, testSelftestPayload } from '../bridge/src/link/messages.js';
import { portOpener } from '../bridge/src/dev/connect.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = flag('--only')?.split(';');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const openPort = portOpener(flag('--port'));
const { FRONT, SIDE } = KEY;

const waitFor = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 50) await sleep(50);
  return check();
};

// A link with what it saw. `master` null is a plain link; `pairing` is the plain link that holds no key and does not refuse a paired S3.
async function open({ master = null, pairing = false, adpcm = false, helloMs = 6000 } = {}) {
  const link = new Link({ openPort, master, pairing, adpcm });
  const seen = { logs: [], statuses: [], pongs: 0, takeFrames: 0, takeEnds: 0, hello: null };
  link.on('log', (l) => seen.logs.push(l));
  link.on('status', (s) => seen.statuses.push(s));
  link.on('pong', () => seen.pongs++);
  link.on('audio-up', (f) => {
    seen.takeFrames++;
    if (f.flags & FLAG.EOS) seen.takeEnds++;
  });
  const hello = new Promise((resolve) => link.once('hello', resolve));
  await link.start();
  seen.hello = await Promise.race([hello, sleep(helloMs).then(() => null)]);
  return { link, seen, close: async () => { link.close(); await sleep(900); } }; // the port needs a moment before the next open
}

const tap = (link, mask, holdMs) => link.send(TYPE.TEST, testKeysPayload([{ delayMs: 0, mask }, { delayMs: holdMs, mask: 0 }]));

// Offers `key` (or asks to forget, with key null) and presses `button` at the S3 once its confirm screen is up.
// Resolves with the S3's answer: 'ok', 'denied' or 'none'.
async function pairWith(link, seen, key, button) {
  const answers = [];
  link.on('frame', (f) => {
    if (f.type !== TYPE.PAIR) return;
    const reply = parsePairReply(f.payload);
    if (reply) answers.push(reply);
  });
  const op = key ? PAIR_OP.SET : PAIR_OP.FORGET;
  const payload = key ? pairSetPayload(key) : pairForgetPayload();
  link.send(TYPE.PAIR, payload);
  const asked = await waitFor(() => seen.logs.some((l) => /^screen pair/.test(l)), 3000);
  if (asked && button) {
    await sleep(700); // the front key counts only after it has been seen up on the confirm screen
    tap(link, button, 150);
  }
  const resend = setInterval(() => link.send(TYPE.PAIR, payload), 2500);
  try {
    await waitFor(() => answers.some((a) => a.answered === op), 8000);
  } finally {
    clearInterval(resend);
  }
  const answer = answers.find((a) => a.answered === op);
  return !answer ? 'none' : answer.op === PAIR_OP.OK ? 'ok' : 'denied';
}

const selftestIn = async (link, seen) => {
  const before = seen.logs.length;
  link.send(TYPE.TEST, testSelftestPayload());
  await waitFor(() => seen.logs.slice(before).some((l) => l.startsWith('selftest')), 5000);
  return seen.logs.slice(before).find((l) => l.startsWith('selftest')) ?? 'no answer';
};

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
let paired = false;

// Each scene returns what it found wanting, as a list of sentences; an empty list is a pass.
const scenes = {
  'selftest: the mbedtls adapter agrees with the RFC 5869 and NIST vectors on the chip': async () => {
    const { link, seen, close } = await open();
    try {
      if (!seen.hello) return [`no HELLO: ${seen.statuses.join(' | ')}`];
      const answer = await selftestIn(link, seen);
      return answer.startsWith('selftest ok') ? [] : [answer];
    } finally {
      await close();
    }
  },
  'pair: the front key accepts, and the S3 answers OK': async () => {
    const { link, seen, close } = await open({ pairing: true });
    try {
      if (!seen.hello) return [`no HELLO: ${seen.statuses.join(' | ')}`];
      if (seen.hello.paired) return ['the S3 already holds a pairing key: this gate would replace it, so it stops (walkie pair --forget first)'];
      const answer = await pairWith(link, seen, KEY_A, FRONT);
      paired = answer === 'ok';
      return answer === 'ok' ? [] : [`the answer was ${answer}, wanted ok`];
    } finally {
      await close();
    }
  },
  'sealed: with the key the link comes up, pings are answered and the self-test runs sealed': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { link, seen, close } = await open({ master: KEY_A });
    try {
      if (!seen.hello) return [`no sealed HELLO: ${seen.statuses.join(' | ')}`];
      const bad = [];
      if (!(await waitFor(() => seen.pongs >= 3, 5000))) bad.push(`${seen.pongs} PONGs in 5 s`);
      const answer = await selftestIn(link, seen);
      if (!answer.startsWith('selftest ok')) bad.push(answer);
      if (link.badChunks || link.seqGaps) bad.push(`${link.badChunks} bad chunks, ${link.seqGaps} gaps`);
      return bad;
    } finally {
      await close();
    }
  },
  'plain refused: a bridge with no key gets no link from a paired S3': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { seen, close } = await open({ helloMs: 4000 });
    try {
      return seen.hello ? ['a plain link came up on a paired S3'] : [];
    } finally {
      await close();
    }
  },
  'wrong key: another key gets no link, and says so': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { seen, close } = await open({ master: KEY_B, helloMs: 5000 });
    try {
      if (seen.hello) return ['a link came up under a key the S3 does not hold'];
      return seen.statuses.some((s) => /pair/.test(s)) ? [] : [`no word about pairing in: ${seen.statuses.join(' | ')}`];
    } finally {
      await close();
    }
  },
  'pair again: the side key refuses, and the first key still works': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const bad = [];
    const offer = await open({ pairing: true });
    try {
      if (!offer.seen.hello) return [`no HELLO: ${offer.seen.statuses.join(' | ')}`];
      const answer = await pairWith(offer.link, offer.seen, KEY_B, SIDE);
      if (answer !== 'denied') bad.push(`the answer was ${answer}, wanted denied`);
    } finally {
      await offer.close();
    }
    const again = await open({ master: KEY_A });
    try {
      if (!again.seen.hello) bad.push('the first key no longer opens a link after a refused re-pair');
    } finally {
      await again.close();
    }
    return bad;
  },
  'adpcm: a 1.2 s take comes back as PCM, whole, with an EOS': async () => {
    if (!paired) return ['skipped: the S3 did not take the key'];
    const { link, seen, close } = await open({ master: KEY_A, adpcm: true });
    try {
      if (!seen.hello) return [`no sealed HELLO: ${seen.statuses.join(' | ')}`];
      await sleep(600); // the S3 is told to send ADPCM once the link is ready
      tap(link, FRONT, 1200);
      await waitFor(() => seen.takeEnds > 0, 4000);
      const bad = [];
      if (seen.takeEnds !== 1) bad.push(`${seen.takeEnds} EOS`);
      if (seen.takeFrames < 30) bad.push(`only ${seen.takeFrames} take frames for 1.2 s`);
      if (link.badAudioFrames) bad.push(`${link.badAudioFrames} audio frames the link could not decode`);
      return bad;
    } finally {
      await close();
    }
  },
};

let failed = 0;
try {
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    let bad;
    try {
      bad = await run();
    } catch (err) {
      bad = [`threw: ${err.message}`];
    }
    if (bad.length === 0) console.log(`PASS ${name}`);
    else {
      failed++;
      console.log(`FAIL ${name}: ${bad.join('; ')}`);
    }
  }
} finally {
  if (paired) {
    // Leave the S3 as it was found: unpaired. The front key is pressed for it, as it was to pair.
    const { link, seen, close } = await open({ pairing: true });
    try {
      const answer = seen.hello ? await pairWith(link, seen, null, FRONT) : 'none';
      if (answer !== 'ok') {
        failed++;
        console.log(`FAIL cleanup: the S3 did not forget the gate's key (${answer}). Run: node bridge/bin/walkie.js pair --forget`);
      }
    } finally {
      await close();
    }
  }
}
console.log(failed === 0 ? 'gate P5: every scene held' : `gate P5: ${failed} scene(s) did not hold`);
process.exitCode = failed === 0 ? 0 : 1;
```

- [ ] **Step 2: Check that the gate loads, and do not run it**

Run: `node --check tools/gate-p5.mjs`
Expected: no output, exit code 0. The gate is not run here: it opens COM8 and writes the S3's NVS (Global Constraints). It is run by hand, with his yes, after `node tools/flash.mjs` has put this plan's firmware on the S3.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: all three parts pass: the bridge's 807 tests, the tools' 17, and `196 cases, 1044 checks passed, 0 failed` from the firmware's host tests.

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/superpowers/specs/2026-10-03-walkie-stage3-outside-design.md tools/gate-p5.mjs
git commit -m "Task 16: gate P5 on the real S3 (written, not run), the README, and the two spec amendments (payload limit stays 1024, PAIR is exempt from sealing on USB)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---
