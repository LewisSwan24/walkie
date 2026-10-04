# Walkie: a StickS3 voice remote for Claude Code (design)

- Date: 2026-09-29
- Status: approved on 29 Sep 2026 (「可以」). Stage 1 is carried out by four plans in `docs/superpowers/plans/`, starting with `2026-09-29-walkie-stage1-link.md`.
- Scope: the whole system's architecture and interfaces, plus Stage 1 (USB end to end) in implementable detail. Stages 2 and 3 get their own specs.
- Working name: `walkie` (a walkie-talkie to Claude Code). Rename freely.

## 1. Goal

Talk to Claude Code on the PC through the M5StickS3 on the wrist. Hold a button and speak (Mandarin with English technical terms); the request runs in a real Claude Code session; a one- or two-sentence spoken answer comes back while the full answer is readable on the PC; Claude's tool use is approved or denied with the device's buttons. The session itself is controlled by voice: stop, continue, compact, new session, switch project, "what are you doing". Eventually it works away from home.

Hard constraint: the S3 also runs on-the-beat's band firmware, and both apps must stay on the device (「不能覆盖现有ONTHEBEAT，这俩应用需要共存」). Apart from sharing the hardware, walkie has nothing to do with on-the-beat (「这个和ONTHEBEAT一点关系没有」).

## 2. Decisions

| # | Question | His pick | Consequence |
|---|---|---|---|
| D1 | How far from the PC | Outside too (「出门也要能用」) | Public relay + end-to-end crypto in Stage 3; Stage 1 runs over USB. |
| D2 | Coexistence with on-the-beat | Both apps on the S3 | on-the-beat keeps app0, walkie lives in app1 (§3). |
| D3 | What "simple commands" means | Claude Code session control only | stop / continue / compact / new session / switch project / status, handled by the bridge, never by Claude. |
| D4 | How the bridge drives Claude Code | A: one long-lived `claude -p --input-format stream-json` per session | Channels cannot interrupt, compact or change cwd; a process per request re-runs the ~10 s startup and likely misses the prompt cache; the Agent SDK is documented for API-key billing. A was verified in Stage 0. |
| D5 | Switching on-the-beat to walkie on the device | Add a small entry to on-the-beat (「给 on-the-beat 加个小入口」) | Stage 2, inside the on-the-beat repo. |
| D6 | Speech engine | OpenAI first, Gemini as fallback (「反正这俩的API KEY我都有」, then 「OpenAI 为主，Gemini 备用」) | Bailian had no speech on his plan (§3). Gemini paid tier was picked next, but on 29 Sep every Gemini flash model except 3.1 flash-lite returned 503 and flash-lite took 7 s, while OpenAI transcribed in 1-2 s. Each step falls back to the other provider on timeout or error. |
| D7 | Recognising session commands | Every utterance is classified by a model (「每句都问 Luna」) | `gpt-6-luna` with `reasoning_effort: "none"`: 10 of 10 test utterances right in about 1 s. When transcription fell back to Gemini, Gemini's own answer carries the intent. Fixed phrases apply only when a transcript exists and no model gave a valid intent (§6.5). |
| D10 | Voice | OpenAI `marin` (「第 2 个，OpenAI marin」) | Streams, with first audio after 0.9 s; Gemini's Kore needed about 5 s before any audio. |
| D8 | Claude model | Opus 5.5, `claude-opus-5-5` (「用更好的模型」) | Needs Claude Code 2.1.280 or later; the CLI is now 2.1.283. |
| D9 | Speaker loudness | The loudest of five variants (「声音太小了实在」, then 「要第 5 种（最响）」) | Heavy compression on the PC plus volume 255 and magnification 2 on the device (§3). |

## 3. Verified facts (Stage 0, 29 Sep 2026)

### Device

- StickS3 on COM8, USB `303A:1001` (USB-Serial-JTAG), MAC 14:C1:9F:D5:36:0C. ESP32-S3-PICO-1 rev v0.2, 8 MB flash (GD), 8 MB PSRAM (AP 3v3).
- Partition table read from the device is `default_8MB.csv`: nvs 0x9000 20K, otadata 0xE000 8K, app0 (ota_0) 0x10000 3264K, app1 (ota_1) 0x340000 3264K, spiffs 0x670000 1536K, coredump 0x7F0000 64K.
- Original otadata: sector 0 holds `ota_seq=1`, sector 1 holds `ota_seq=0`, both with valid CRCs, so app0 boots. CRC = `crc32(le32(ota_seq))` with initial value 0xFFFFFFFF (Python: `binascii.crc32(struct.pack('<I', seq), 0xFFFFFFFF)`). Writing sector 1 with `ota_seq=2` boots app1; writing the original 8 KB image back boots app0.
- A test image written to 0x340000 plus that otadata booted from app1, with app0 and NVS untouched. on-the-beat's normal `pio run -t upload` writes the bootloader, partition table, `boot_app0.bin` and app0 (standard PlatformIO behaviour, not re-run in Stage 0), so it leaves app1 in place and boots app0.
- A toolchain that builds for it: PlatformIO `espressif32@6.13.0` (Arduino-ESP32 2.0.17), board `esp32-s3-devkitc-1`, `board_build.arduino.memory_type = qio_opi`, `board_upload.flash_size = 8MB`, `board_build.partitions = default_8MB.csv`, `-DBOARD_HAS_PSRAM -DARDUINO_USB_CDC_ON_BOOT=1`, M5Unified 0.2.23 with M5GFX 0.2.30. `M5.getBoard()` returns 26 and PSRAM reports about 8,386,000 bytes. The test image with `efontCN_16` was 862 KB, 25.8% of the slot.
- `cfg.output_power = false` before `M5.begin()` is required for charging (on-the-beat finding); the speaker still works.
- Mic (ES8311 through `M5.Mic`, 16 kHz) works, but the default `magnification=16` clips: peak 32752, 0.7% of samples at full scale. Speaker (`M5.Speaker.playRaw` at 16 and 24 kHz) works; he heard the playback and found it far too quiet.
- Loudness: M5Unified 0.2.23 configures the StickS3 speaker with `magnification = 1` (CoreS3 uses 4), an output rate of 22050 Hz and the ES8311 DAC volume at 0 dB (register 0x32 = 0xBF; 0xEF = +24 dB is the ChainCaptain's value, and the StickS3's unused +24 dB of DAC-register headroom is digital too). The AW8737A amplifier is enabled with a single rising edge, which is mode 1, already its highest level (1.2 W with anti-clipping AGC), so the headroom left is digital. A/B on the device with the same 6.9 s Mandarin clip (peak 95% FS, RMS 2368): he picked variant 5 of 5, which was the clip high-passed at 300 Hz, compressed (ffmpeg `acompressor` threshold 0.02, ratio 12, attack 1 ms, release 40 ms, makeup 10, then `alimiter` 0.98) and normalised to a 32000 peak (RMS 5802, about +7.8 dB), played at volume 255 with magnification 2.
- Serial output can stay held until the port is reopened, so the bridge keeps the port open for its whole lifetime, opened with DTR and RTS low so the board does not reset.
- PC-to-device bulk data without flow control lost 76% of the bytes (4 KB RX queue, a `delay(5)` in the loop), and the lost end marker wedged the line parser. Paced at about 2 KB per 20 ms, 331,416 bytes arrived intact in 5.4 s (about 61 KB/s of decoded audio). 24 kHz PCM16 needs 48 KB/s.

### Claude Code (CLI 2.1.283, `--model claude-opus-5-5`, `--strict-mcp-config`)

- One `claude -p --input-format stream-json --output-format stream-json --verbose` process carried several turns; a recall question answered from the previous turn.
- With `--permission-prompt-tool mcp__<server>__<tool>`, the tool receives `{tool_name, input, tool_use_id}`. Returning `{"behavior":"allow","updatedInput":<input>}` let a Write through; returning `{"behavior":"deny","message":"..."}` blocked it, and Claude quoted the message back.
- `/compact` sent as an ordinary user message compacts the session (a `system/compact_boundary` event appears) and the context survives.
- Killing the process and starting another with `--resume <session_id>` continues the same session.
- `system/init` arrives about 10.5 s after spawn. The first turn wrote 68,239 tokens to the prompt cache (his global context). In steady state after a resume, a short turn read 66,031 cached tokens and wrote 141. A trivial turn takes 6-8 s. Unexplained: in the first process, turns 2 and 3 each re-wrote about 40K cache tokens.
- The standalone CLI had been logged out (`claude auth status` showed `loggedIn:false`) and 2.1.277 rejected Opus 5.5. He logged in and `claude update` brought 2.1.283. The bridge must report both kinds of failure plainly.

### Speech

- Bailian: his only key is a Coding Plan key (`sk-sp-`), valid on `coding[-intl].dashscope.aliyuncs.com/v1` with 10 text models and no speech models. `bl` treats every `sk-sp-` key as Token Plan, so its profile points at the wrong endpoint and even `bl text chat` returns 401.
- Keys for both providers live in `%APPDATA%\walkie\keys.env`, which he filled in himself. `~/.gemini` holds the Gemini CLI's own login and `~/.codex/auth.json` the Codex login; walkie touches neither.
- OpenAI, measured: `gpt-transcribe` ($0.0045/min) transcribed five clean Mandarin clips with English terms exactly (「换到 on the beat 那个项目。」, 「帮我跑一下 npm test，然后 commit。」) in 0.8-2.4 s. `gpt-6-luna` (text in, text out; $0.10/$0.50 per million tokens) with a strict JSON schema classified 10 of 10 test utterances correctly, including 「把登录页的停止按钮改成红色」 and 「停止服务之前先备份数据库」 as `to_claude`: 1.2-2.6 s at default effort, 0.8-1.5 s with `reasoning_effort: "none"` (one 3.7 s outlier); `minimal` is rejected (accepted values: none, low, medium, high, xhigh). `gpt-4o-mini-tts` with voice `marin` and `pcm` output: first byte after 0.9 s, 6.55 s of speech complete in 1.9 s.
- Gemini, measured about 04:30 on 29 Sep (`serviceTier: standard`): `gemini-3.8-flash`, `3.7-flash`, `3.5-flash` and `flash-latest` all returned 503 "high demand", some only after 17-31 s; `gemini-2.5-flash` returned 404 (no longer offered to new users; the message recommends 3.8 and the Interactions API); `gemini-3.1-flash-lite` answered one clip correctly (transcript, `switch_project`, `on-the-beat`) in 7.0 s; `gemini-3.8-flash-tts` returned 8 s of 24 kHz WAV in 5.1 s as a single response. From the docs: WAV or raw PCM input inline up to 20 MB, 32 tokens per audio second, JSON-schema answers alongside audio, paid-tier content not used for Google's product training.
- The far-field test was invalid: S3 recordings of the laptop speaker across the desk were dominated by his livestream, and `gpt-transcribe` returned empty text for them.
- His own voice, measured on 29 Sep: he held the front key and said 「帮我跑一下 npm test，然后 commit」 into the S3, holding it as he naturally would (distance not measured). The 5.26 s clip at 16 kHz and the default mic magnification of 16 peaked at full scale with 2.66% of samples clipped (speech RMS per 100 ms up to about 21,000). Even so, `gpt-transcribe` returned 「呃，帮我跑一下这个 npm test，然后 commit。」 in 1.6 s with the term prompt, and the same sentence minus the 「呃」 in 2.1 s without the prompt. `gpt-6-luna` at `none` gave `to_claude` with the filler removed. A cold single Luna call (new process, new connection) took 1.1-2.5 s over five runs; the 0.8-1.5 s above came from ten calls in one process.
- The start-up transient varies: about 0.25 s at RMS near 11,000 (against about 1,500 of background) on serial-triggered recordings, RMS 1,817 on the push-to-talk one. His speech began about 0.85 s after key-down, so the 250 ms trim cut nothing.

## 4. Architecture

```
StickS3, app1 (walkie firmware)              PC, Windows (walkie-bridge, Node 24)
+-----------------------------+   USB     +---------------------------------------------+
| UI loop: buttons, screen    |  serial   | link: frames, credits                       |
| audio task: mic, speaker    |<--------->| hear: gpt-transcribe, intent: gpt-6-luna   |
| link task: frames, credits  |  (Stage 3:| speak: gpt-4o-mini-tts; Gemini as fallback  |
+-----------------------------+  WSS relay| session manager --> claude -p (stream-json) |
                                          | permission MCP (HTTP, 127.0.0.1) <-- claude |
                                          +---------------------------------------------+
```

One voice turn:

1. Front key held: the device streams 16 kHz PCM16 in 20 ms frames to the bridge.
2. Release: the device shows TRANSCRIBING; the bridge wraps the audio as WAV and sends it to `gpt-transcribe` (Gemini if that fails, §6.5).
3. The transcript shows on the device for 1 s (CONFIRM; the side key cancels) while `gpt-6-luna` classifies it.
4. `to_claude`: the text becomes a user message on the project's `claude -p` stdin. Any other intent is handled by the session manager (§6.4).
5. Stream events keep the device's WORKING line current (last tool and elapsed time); permission requests open the APPROVAL screen.
6. On `result`, the bridge extracts the `<voice>` text, streams it through `gpt-4o-mini-tts` (voice `marin`) and the loudness chain (§6.5) to the device under flow control, and shows the text on the device in pages. The full reply is printed in the bridge console.

Principle: the bridge owns the session state and decides what the device shows; the device owns input capture, timing-critical audio and rendering, and reports button events.

## 5. Stages

- **Stage 0, spikes**: done (§3). The throwaway code stays out of the repo.
- **Stage 1, USB end to end** (this spec): firmware in app1, the bridge, flash and boot-slot tools, and the in-app switch back to on-the-beat.
- **Stage 2, on-the-beat entry**: in the on-the-beat repo, a boot-time key hold and a console command that select app1 and restart. It gets its own short spec there and follows that repo's tests.
- **Stage 3, outside**: pairing over USB, per-frame encryption, a relay on Fly, Wi-Fi through his phone hotspot, compressed audio. It gets its own spec; §7 fixes its boundary.

## 6. Stage 1 design

### 6.1 Repository

```
walkie/
  firmware/      PlatformIO project: src/, host/ (logic compiled and tested on the PC)
  bridge/        Node 24 ESM, no build step: src/, test/
  protocol/      frames.md and vectors.json, shared by the firmware host tests and the bridge tests
  tools/         flash and boot-slot scripts
  docs/superpowers/specs/, docs/superpowers/plans/
```

### 6.2 Firmware

- Build exactly as in §3, pinning `m5stack/M5Unified@0.2.23`.
- Boot: `output_power = false`; `esp_ota_mark_app_valid_cancel_rollback()`; rotation 3 (USB on the left, as on-the-beat defaults); font `efontCN_16`; NVS namespace `walkie` only.
- Link task: `Serial.setRxBufferSize(16384)` before `Serial.begin()`, drains RX continuously, decodes COBS frames and resynchronises on every 0x00, checks the CRC, routes frames to queues, and owns the single TX queue. Nothing in the RX path waits.
- Audio task: records 16 kHz mono PCM16 in 20 ms chunks while the talk key is held and sends each chunk at once; plays replies from a PSRAM ring of at least 30 s at 24 kHz (about 1.4 MB), starting once 300 ms is buffered or the stream has ended, and grants CREDIT frames as the ring drains. Mic and speaker are half-duplex: end one before beginning the other. Speaker volume 255 and `magnification` 2 (D9).
- Mic gain: `magnification` 2, calibrated on 2026-09-30 in Stage 1 plan 1. At wrist distance his normal speech peaked at 30-39% of full scale over three takes, with nothing clipped.
- UI loop: `M5.update()`, button gestures, the state machine, rendering.
- States: OFFLINE; IDLE (project, link, battery); LISTENING (level bar); TRANSCRIBING; CONFIRM (the transcript for 1 s); WORKING (one status line and elapsed time); REPLY (text in pages, playing); APPROVAL (tool and preview); ERROR (a plain message); SWITCH_CONFIRM.
- Buttons. KEY1 is the front key (G11) and KEY2 the side key (G12); the power key belongs to the M5PM1 and the firmware never sees it.
  - A short press is released within 300 ms; a hold lasts 300 ms or longer.
  - Front held: talk; release sends. A short front press outside APPROVAL is ignored.
  - A chord (both keys down within 150 ms of each other) never starts talking; it can only lead to SWITCH_CONFIRM.
  - Side short: cancel in CONFIRM, stop the audio in REPLY, deny in APPROVAL, next page in REPLY once the audio has finished.
  - Side held 1 s in WORKING: stop.
  - In APPROVAL: front short allows; side short denies; front held denies and records a reason, whose transcript becomes the deny message.
  - Both keys held 3 s: SWITCH_CONFIRM; the front key confirms, then `esp_ota_set_boot_partition(app0)` and restart.
- Test hooks arrive as TEST frames (press, hold, inject audio as if from the mic, snap the screen), sent by the bridge's developer commands. The device never parses free text on the port; its own logs leave as LOG frames.

### 6.3 Bridge

- Node 24 ESM. One dependency, `serialport`. OpenAI and Gemini are called with `fetch`, and the permission endpoint (§6.4) is a small hand-written MCP server on `node:http`: the real client's whole conversation with it is six JSON-RPC calls (measured 1 Oct 2026, plan 3), so the MCP SDK would only add a dependency.
- Configuration: `bridge/config.json` (voice, models, timeouts, loudness settings) and `projects.json` (`[{name, aliases, path}]`, pre-filled with his project folders). State: `%APPDATA%\walkie\state.json` (active project, last session id per project).
- Keys: `%APPDATA%\walkie\keys.env` holds `OPENAI_API_KEY` and `GEMINI_API_KEY`; an environment variable of the same name overrides the file. The file sits outside every repo and its values are never logged. Anything that creates files there from inside the Claude desktop app must use PowerShell, because the app's own writes to a new AppData folder are redirected into its package storage where other programs cannot see them.
- Modules: `link` (serial, frames, credits), `speech` (OpenAI and Gemini adapters behind one interface for transcribe, classify and speak; the provider chain; the loudness chain), `intent` (validating answers, fixed-phrase fallback), `claude` (process manager, stream parser, status), `perm` (the MCP endpoint), `voice` (reply extraction), `ui` (what the device shows), `console` (live log and developer commands), `main` (wiring).

### 6.4 Claude session manager

Each session is one process, started in the project folder:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --model claude-opus-5-5 --strict-mcp-config
  --mcp-config '{"mcpServers":{"walkie":{"type":"http","url":"http://127.0.0.1:<port>/mcp",
                 "headers":{"Authorization":"Bearer <token made for this run>"}}}}'
  --permission-prompt-tool mcp__walkie__approve
  --append-system-prompt "<voice rules>"
  [--resume <session_id>]
```

- One active process at a time. With `claude.prewarm` (on by default) it starts with the bridge and after a switch, so that the first message does not wait for the boot (14 to 23 s when first measured on 1 Oct 2026, the SessionStart hooks; about 4 s when measured again that evening, see §10); with it off it starts on the first `to_claude` message. After 60 min idle (`claude.idleMinutes`) the bridge closes its stdin so it exits cleanly, and the next message resumes the session. Two messages sent before the first turn has begun are answered as two turns, each with its own `init`, `result` and reply, not merged (measured 1 Oct 2026); what `claude` does with a message that arrives while an answer is being written was not measured. The manager copes with either: a turn nobody asked for is announced with a new `working`.
- His usual permission rules apply. Anything still needing approval reaches `mcp__walkie__approve`, which opens APPROVAL on the device and waits. With no answer in 55 s (`claude.approvalTimeoutSec`) the verdict is deny, with the message 「手腕上没人回应，先别做。」 It cannot be longer: `claude`'s own MCP client drops a pending call at about 60 s (59,999 and 59,996 ms measured on 1 Oct 2026) and the model then asks once more, so a longer wait would run every unanswered approval twice, and a late yes would allow a call that `claude` had already given up on.
- Intents:
  - `stop`: kill the process tree (`taskkill /PID <pid> /T /F`), keep the session id; the next message resumes.
  - `continue`: send 「继续」, resuming first if needed.
  - `compact`: send `/compact`.
  - `new_session`: end the process and forget the project's session id.
  - `switch_project(name)`: end the process, make the project active; the next message resumes its last session or starts a new one.
  - `status`: answered by the bridge from the stream (idle or working, last tool with a short summary of its input, elapsed time, turns), spoken through TTS.
  - `to_claude(text)`: a user message.
- Stream handling: `system/init`, printed at the start of every turn and not once per process, gives the session id and model; `assistant` tool_use blocks update the status line and text blocks are collected; `result` ends the turn with the text, usage (including cache read and write) and error flags. Errors mentioning authentication, or "does not support this model", become ERROR screens that say what to do on the PC.
- Voice rules in the appended system prompt: end every final reply with `<voice>` holding one or two short spoken sentences in the user's language, with no code, markdown or paths. If the tag is missing, speak the reply's first sentence with markdown stripped, at most 60 characters.
- At the desk, the console shows everything. After the bridge ends its process, `claude --resume <id>` in the project folder continues the same session; `claude --continue` skips `-p` sessions.

### 6.5 Speech and intent

- Provider chain. Each step has a primary and a fallback; a candidate that fails (one model at one step, so a voice that fails does not silence the transcriber) is skipped for 5 minutes, so a bad spell costs one timeout rather than one per utterance. When every candidate of hearing, or of speaking, is in its window, the one whose window ends first is asked anyway and the console says so; an answer ends its window. Otherwise one hiccup would leave the device deaf, or mute, for the whole 5 minutes. Classifying keeps its windows, because it has the fixed phrases and Claude to fall back on.

  | Step | Primary | Fallback | Last resort |
  |---|---|---|---|
  | Transcribe | `gpt-transcribe`, timeout 3 s plus 10% of the clip's length | `gemini-3.8-flash`, then `gemini-3.1-flash-lite`, hearing and classifying in one call, 8 s | 「没听清，再说一次」, nothing sent |
  | Classify | `gpt-6-luna`, `reasoning_effort: "none"`, 3.5 s (it follows the transcription on the same host, so it normally reuses that connection; one cold call in five took 2.5 s) | (skipped when the transcript came from Gemini, which already classified it) | fixed phrases, then `to_claude` |
  | Speak | `gpt-4o-mini-tts`, voice `marin`, streamed; 3 s to first byte | `gemini-3.8-flash-tts`, 10 s | text only, with a short tone |

- Transcribe: the WAV (16 kHz mono PCM16) built from the uplink frames, minus the first 250 ms (the mic's start-up transient), with a `prompt` listing project names and common terms (Claude, npm, git, commit, PlatformIO, on-the-beat). Clips under 300 ms of speech, an empty transcript, one with no letter or digit in it (「。」), or a lone filler (「嗯」, "um"), become 「没听清」 and go nowhere. While an approval is pending, a spoken reason is transcribed and never classified.
- Classify: a strict JSON schema `{intent, project, text}`, with the prompt tested in Stage 0: the command list, the rule that only a whole-utterance command is a command, the project table with aliases, the current project and whether Claude is working. It runs during the 1 s CONFIRM window. The Gemini fallback uses the same prompt with the audio attached and a `transcript` field added. For `to_claude`, `text` is the model's cleaned-up request only when it differs from the transcript by filler sounds alone (「嗯」, "um"); in every other case the transcript itself goes to Claude, so a model that tidies 「不要删除数据库」 into 「删除数据库」 cannot turn a request around.
- Speak: `response_format=pcm` (24 kHz) with `instructions` asking for natural, concise Mandarin at a slightly quick pace. Every chunk passes the loudness chain and then becomes AUDIO_DOWN frames under credit flow control. The Gemini fallback returns one WAV, which goes through the same chain. A voice that falls silent for 3 s in the middle of a reply counts as failed; the reply ends there and is not repeated in the other voice.
- Loudness chain (in the bridge, streaming, plain JS): high-pass at 300 Hz; feed-forward compressor at about -34 dBFS, ratio 12, attack 1 ms, release 40 ms; fixed makeup gain; limiter at 0.98 of full scale with a few milliseconds of lookahead. A stream cannot be normalised to its own peak, so the makeup gain is a constant calibrated in Stage 1 to bring `marin` to the level of variant 5 (RMS about 5800 with peaks near full scale; the offline chain gave `marin` RMS 7561).

### 6.6 Link protocol

- Frame: `type:u8 | flags:u8 | seq:u16 | len:u16 | payload | crc16:u16` (CRC-16/CCITT-FALSE, little endian), COBS-encoded, delimited by 0x00. `flags` bit 0 marks end of stream; bits 1-2 hold the audio codec (0 = PCM16; ADPCM is reserved for Stage 3); bit 7 is reserved for encryption. Payloads are at most 1024 bytes.
- Types: HELLO (the PC's carries a random nonce and the S3's answer echoes it, so a HELLO the S3 sent at boot is never taken for the answer), PING, PONG, AUDIO_UP (640 B = 20 ms at 16 kHz), AUDIO_DOWN (up to 960 B = 20 ms at 24 kHz), CREDIT (u32 bytes), PLAYED (how a reply ended: bytes played, their CRC-32, underruns, peak ring fill, finished or stopped), UI (a state byte plus tagged fields: project, text, elapsed time; the first draft said JSON, and the tagged form needs no parser on the S3), BUTTON (event), APPROVAL_REQ (id, tool, preview up to 300 characters), APPROVAL_RES (id, verdict, whether a voice reason follows), CMD (volume, mic gain, stop audio, boot app0, reboot), TEST, LOG.
- `protocol/frames.md` is the detailed contract: payload layouts, credit flow control, how a reply is stopped, and sequence numbers.
- Bytes outside frames (ROM and boot text) are skipped until the next delimiter.
- `protocol/vectors.json` holds encoded and decoded pairs that both implementations must pass.

### 6.7 Coexistence tooling

- `tools/flash`: builds, reads the partition table from the device and refuses unless it matches §3, then writes the image to 0x340000 and an otadata image selecting ota_1. It never writes 0x0, 0x8000, app0 or NVS.
- `tools/boot app0|app1`: writes only an otadata image; for app0 it is the original two-sector image.
- On the device: SWITCH_CONFIRM (§6.2).
- Stage 2 boundary: on-the-beat gains a boot-time hold (front key held at power-on for 2 s or more) and a console command, both of which select app1 and restart. Each app keeps to its own NVS namespace.

## 7. Stage 3 boundary (outside)

- Relay: a separate small Fly app, not on-the-beat's. The device and the bridge both connect out over WSS and are paired into one room; the relay forwards frames and learns nothing else.
- Pairing: over USB, the bridge generates a 32-byte key, keeps it on the PC and writes it into the device's NVS. The key never crosses the network.
- Crypto: AES-256-GCM on every frame (the S3 has hardware AES); nonce = direction and a 64-bit counter; replays are rejected; the room id is derived from the key.
- Transport: Wi-Fi through his phone hotspot or saved networks; the device checks the relay's certificate as on-the-beat does; audio travels as ADPCM (4:1).
- The PC has to stay on and awake with the bridge running.

## 8. Error handling

| Situation | What happens |
|---|---|
| Nothing heard, or both transcription providers fail | 「没听清，再说一次」 on the device; nothing is sent to Claude. |
| No model gives a valid intent | Fixed phrases on the transcript, then `to_claude`. |
| Claude process exits unexpectedly | A notice on the device; the next message resumes the session. |
| Claude login expired | ERROR: 「Claude 登录过期，回电脑上登录」. |
| CLI too old for the model | ERROR naming `claude update`. |
| Both TTS providers fail (error, quota, billing) | The reply shows as text only, with a short tone. |
| A provider fails repeatedly | It is skipped for 5 minutes; the console says which one and why. |
| Serial link lost | Device shows OFFLINE; the bridge reopens the port when it reappears. |
| Approval unanswered for 55 s | Deny, with the message in §6.4. |

## 9. Testing

- Bridge, with Node's built-in test runner: frames and COBS against `vectors.json`, credit accounting, the loudness chain on a fixed input, the fixed-phrase table, both providers' adapters and the fallback chain with recorded responses and injected failures (503, timeouts, bad JSON) standing in for the APIs, the Stage 0 classification set, stream parsing with the real events recorded in Stage 0, and the session manager against a fake `claude` script that replays those events.
- Firmware: frame codec and state machine compiled on the PC under `firmware/host/` and run against the same `vectors.json`.
- On the real S3 without his hands: TEST frames press keys and inject a WAV as mic input; `snap` captures the screen.
- End to end: a recorded utterance, then `gpt-transcribe`, `gpt-6-luna`, Claude (Opus 5.5), `gpt-4o-mini-tts` through the loudness chain, and playback on the S3; the same run with OpenAI blocked exercises the Gemini path. Last, he does the whole thing by hand once.

## 10. To verify during Stage 1

- Recognition of his own voice through the S3 mic at wrist distance (measured 1 Oct 2026, plan 2). Twelve takes, 74.8 s in all and at wrist distance by his account, went through the real chain (first 250 ms trimmed, term prompt) to `gpt-transcribe` alone. Eleven came back as what he said, and `gpt-6-luna` made each of them `to_claude`; it also scored 20 of 20 on the Stage 0 set through the chat completions endpoint. The miss is the first take of 29 Sep (2.8 s): `gpt-transcribe` returned nothing, so the device would say 「没听清」, while `gemini-3.1-flash-lite` heard 「把这个手环项目的代码优化一下」, which he confirms is what he said. A synthetic 3 s clip of faint noise (RMS about 87) came back empty too, as it should. Not checked: the mic gain of each take (the local `listen` logs do not record it); the first three takes predate the 30 Sep calibration.
- The Gemini fallback (probe of 1 Oct 2026, three calls per model, `generateContent`). `gemini-3.8-flash` answered two of three, in 5.9 and 6.5 s, close to its 8 s limit, and the third was a 503 (high demand). `gemini-3.1-flash-lite` answered three of three, median 2.4 s (1.8 to 7.4 s). `gemini-3.8-flash-tts` answered three of three, median 3.3 s. Through the chain on the 2.8 s take with OpenAI left out, `gemini-3.8-flash` gave a 503 and `gemini-3.1-flash-lite` then answered correctly, 10.6 s from the end of the take to the transcript. `generateContent` worked on every call, so the Interactions API was not tried. Not checked: how long a spell of 503s lasts; three calls per model is a sample, not a rate.
- Loudness chain calibration (1 Oct 2026). The constant makeup gain of 27.5 dB, set offline, was checked on `marin` through the live chain: first audio 0.7 s, RMS 7959, peak 32113, inside the 5800 to 8500 acceptance band, so it stands. That is louder than variant 5 (RMS about 5800), and he found it fine. On the S3 at the firmware's speaker setting (`magnification` 2) the `marin` reply (RMS 7863, first audio 1.2 s) was 「响度和音质都可以」 to him, and the Gemini voice (RMS 8335, first audio 5.0 s, no style prefix read aloud) 「正常，可以用」; neither played with an underrun. So magnification 2 does not distort at these levels, by ear. Not checked: any measurement of the speaker's output; it was judged by listening.
- Whether an empty answer from `gpt-transcribe` should be tried on Gemini before giving up. Today it ends the chain (6.5), which cost the first take above: empty from OpenAI, right from Gemini. Trying Gemini would also send every noise clip there, one more call each and a chance of invented words.
- The permission MCP over HTTP (Stage 0 used stdio). Done (plan 3, 1 Oct 2026): a hand-written `node:http` server, no SDK. `claude` 2.1.285 asks `server/discover` first (answered -32601), then `initialize`, `notifications/initialized` (202), a GET (405) and `tools/list`, and calls the tool with `tool_name`, `input` and `tool_use_id`; the answer is one text block holding `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. Its client drops a pending call at about 60 s and the model retries once, so an unanswered approval is denied at 55 s. Checked on 1 Oct 2026 through `walkie-dev claude` against the real `claude`: a Write allowed created the file with the content `ok`, and Claude said so; a Write refused with the reason 「这个文件不需要」 was not made, and Claude told him that he had declined it on the watch and repeated the reason; a Write left unanswered was denied 55 s after it was shown (21:35:29 to 21:36:24) and Claude did not ask again (no second approval for that file), but said that nobody had answered on the watch and offered to do it later.
- The ~40K cache re-writes in the first process's turns 2 and 3. Not reproduced (plan 3). On 1 Oct 2026 the first turn of a process wrote 36,118 tokens ($0.2946, 10.2 s; 27.6 s with the boot) and the next three wrote 280, 189 and 426 and read about 106K ($0.026 each); a resumed process wrote 35.5K on its first turn ($0.29), once more. Through the manager that evening: the turns of one process cost $0.429 and $0.017, those of another $0.432, $0.035 and $0.035, so no turn after the first re-wrote anything of that size; the first turns of seven processes (six new, one resumed) cost $0.352, $0.429, $0.415, $0.414, $0.413, $0.432 and, resumed, $0.459 (two more processes were killed by a `stop` before they answered and have no figure). The first turn of every process costs about $0.4 (his own CLAUDE.md and skills are in it): one more reason to keep a process alive between messages and to start it ahead. `claude` reports its total cost as the running total of the process, not of the turn; the manager shows the difference.
- What `claude.prewarm` saves (plan 3). A message sent at once to a prewarmed process waited for the rest of the boot: the run took 11.1 s in all (the turn itself 5.1 s); with a 30 s head start it took 37.1 s, that is 7.1 s after the head start (the turn 5.7 s), so the boot that waiting hides is about 4 s (the boot itself, measured that evening; it was 14 to 23 s when first measured).
- Stopping, resuming, `/compact` and a message in the middle of a turn, against the real `claude` (plan 3, 1 Oct 2026). `stop` 20 s into a long answer (counting to 1500) ended the process at once and no `claude` was left running; `continue` resumed session 3977649d, no second transcript was made, the transcript held the interrupted request, a stub "No response requested." and then the `continue`, and `claude` wrote the whole answer again (36.2 s, $0.459): what was already written when it was stopped is lost. A `stop` sent before the process had printed `init` (5 s after the message) left no session to resume, and the `continue` started a new one. Two messages sent one right after the other, before the first turn began, were answered as two turns of their own (6.9 s and 6.3 s, $0.429 and $0.017). Not checked: a message sent while an answer is being written; what is still untested is whether `claude` merges that one into the running turn. `/compact` took 10.7 s and made the context 88% shorter (70,055 tokens to 8,077) and cost $0.039.

- The whole turn on the real S3 (plan 4, 2 Oct 2026). A recorded utterance (Windows speech synthesis, 16 kHz, 「一加一等于几？请只回答一个数字。」) was fed to the S3 as its mic by `walkie.js --inject`, which holds the front key by TEST frames. With OpenAI and the real `claude` (Opus 5.5, project on-the-beat): the take ended at 02:14:03 and the screen showed CONFIRM at 02:14:05; the console printed the transcript and `to_claude (openai)` at 02:14:08; Claude answered in 5.5 s ($0.359, the first turn of a process); the reply, with `<voice>二</voice>`, was spoken to the end and the run finished at 02:14:16, 13 s after the key came up. With OpenAI refused (an invalid key: HTTP 401, skipped for 5 minutes) and a stand-in for `claude`: `gemini-3.8-flash` did not answer within 8 s, `gemini-3.1-flash-lite` gave the transcript 12 s after the take ended, and the reply was spoken in the Gemini voice, 32 s in all. A run of the same with `gemini-3.8-flash` and `gemini-3.1-flash-lite` both answering 503 sent nothing to Claude: the console said `nothing clear (unavailable)` and the run ended as unclear. Not checked: how either reply sounded (the run reads PLAYED and does not hear), and the whole thing by hand at wrist distance with his own voice, which is still his to do.
- The screens and the keys on the real S3 without anyone touching it (plan 4, `tools/gate-h.mjs`, 11 scenes, all held): the side key cancels in CONFIRM, a hold of a second stops in WORKING and a tap does not, a reply of 16 lines turns four pages and the fifth side tap dismisses it, the side key dismisses an error, an approval is allowed by a front tap and denied by a side tap, a front hold records a reason (the take ends with EOS and REASON), talking while WORKING ends with EOS and the working screen is back, a front tap is not a take, the header colours (checked from `TEST SNAP` pixels) are the ones asked for, and both keys held 3 s open SWITCH_CONFIRM, which the side key closes. It found two faults, both fixed: `TEST SNAP` showed red and blue swapped (M5GFX's `readRectRGB` fills r, g, b although its type is called bgr888_t), and the S3 stayed on its OFFLINE screen until its first PING (the bridge now pings at once on HELLO). The switch to app0 was also done by hand with the real keys (both held 3 s, then a front tap): `boot app0: ESP_OK`, and `tools/boot.mjs app1` brought walkie back.
- Frames lost on the link (plan 4, 2 Oct 2026). PC to S3: 283 MIC_PCM frames handed to the port at once lost 50 (the S3's PONG counted 83 more bad chunks and 50 sequence gaps; its receive queue is 16 KB), and the first end-to-end run lost its key script that way and made no take; four frames and a 5 ms pause lost none in 283, so `walkie-dev inject` and `--inject` pace the recording. S3 to PC: about one frame in a thousand of about 1 KB arrives damaged (about one snapshot in twenty loses a chunk of 68; the same at half the rate, with the TX ring not full; the audio at 33 KB/s was clean in plans 1 and 2), so `takeSnap` asks again. Open: a BUTTON or an APPROVAL_RES lost that way (rare) leaves the bridge waiting, and an approval then falls back on its 55 s deny; a lost LOG line is why a run's log can lack a line such as `screen listening`. The cause of the S3-to-PC damage was not found. It showed again when plan 4 was executed afresh the same day: in one run of gate H the reason scene lost its APPROVAL_RES and the S3's log line for it (two frames in a row); the scene passed 3 of 3 alone, and the whole gate then held, 11 of 11.

## 11. Out of scope

Wake words; local speech engines; attaching to desktop-app sessions; channels; more than one device; typing into the session from the bridge console; everything in Stage 3 beyond its boundary.
