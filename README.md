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
- `bridge/projects.json`: copy `bridge/projects.example.json` and list your own projects (name, aliases you say, folder). It is yours and is not committed.
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

`relay <host>` saves the host on this PC (`%APPDATA%\walkie\relay.txt`) and on the S3; `relay` alone shows it, `relay --forget` removes it from both, and `--pc-only` leaves the S3 alone. The S3 is told first, over the cable or over the relay it is on now, and this PC changes only once the S3 has it, so a change made over the relay never leaves the two on different relays. `wifi add` asks for the password twice in this terminal without echoing it (an empty one is an open network) and sends it sealed; the S3 keeps at most four networks and tries them in the order they were added. `wifi list` shows the names (never the passwords) and the relay host the S3 holds; `wifi remove <name>` forgets one. The S3 uses Wi-Fi only while it holds a key, a network and a relay host; with none of them it behaves as before.

**The bridge** looks for the S3 on USB first and uses the relay only when there is no cable and both a `pair.key` and a relay host are set; while on the relay it looks for the cable every 3 s and moves to it when it appears. A move is not seamless: a turn in progress is abandoned, as on any lost link. If a second bridge with the same key takes the relay room, the first stays off the relay for 5 minutes instead of taking it back. Away from the cable the S3's OFFLINE screen says what it lacks: 连不上 Wi-Fi, 连不上中继 (no relay), or 电脑没在线 (the relay is there, the PC is not: start the bridge). With no network set up it still says to plug in USB.

**Checks** before an S3 is involved:

```bash
node tools/check-relay-roots.mjs <app name>.fly.dev
```

```bash
node tools/gate-l.mjs --host <app name>.fly.dev
```

The S3 trusts two roots only, ISRG Root X1 and X2 (`firmware/src/relay_roots.h`, made by `node tools/gen-relay-roots.mjs` from the certifi bundle PlatformIO installs); `check-relay-roots` connects as the S3 would and says whether the relay's certificate chains to them. `gate-l` does the same check and then runs a stand-in S3 and a PC through the relay with a throwaway key: a sealed link, 75 s with nobody talking (past two of the relay's keep-alive pings), the S3 leaving and returning, and a second PC replacing the first. It needs no COM port, no API and no `pair.key`; `--hold <s>` changes the 75 s, and without `--host` it uses the host `walkie relay` saved.

**On the S3**, two more checks need you and the device. Gate M: with walkie paired, a network and the relay set, unplug the cable and start the bridge; a whole turn with an approval must work over Wi-Fi, and plugging the cable back in and out again mid-session must move the link to USB and back. Gate N: take the S3 to another network (a phone hotspot is enough), add it with `wifi add` beforehand, use it there, then leave it on standby with the bridge running for an hour. The bridge prints what the S3 says about its link: `[S3] transport usb|relay|none` when it moves, `[S3] link online|no-wifi|relay-down|pc-offline` when that changes, `[S3] wifi: joined <name>` and `[S3] relay: ...` from the connection, and every 5 minutes `[S3] health battery <n>% heap <bytes> min <bytes> block <bytes> rssi <dBm> link <state>`, from which an hour's standby drain is read. `min` is the lowest the heap has been since boot and `block` the largest free piece of internal memory, so the TLS handshake's peak shows even though it falls between two samples; a failed TLS connection says mbedtls's own error code and reason.
