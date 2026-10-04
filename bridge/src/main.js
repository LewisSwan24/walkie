// The bridge, wired (spec 4 and 6): the S3 over USB serial on one side, Claude Code on the other, and the speech providers
// between them. This file only joins the parts; what each does is in its own module.
//
//   Link ── ui ──┐
//    │           ├── turn ── speech (OpenAI, Gemini)
//    │           ├── manager ── claude -p ──(MCP)── permission server ── approvals
//    └ console   └──────────────────────────────────────────────────────────┘
import { createManager } from './claude/manager.js';
import { createStateStore } from './config/state.js';
import { createConsole } from './console.js';
import { Link } from './link/link.js';
import { createApprovals } from './perm/approvals.js';
import { createPermServer } from './perm/server.js';
import { createSpeech } from './speech/speech.js';
import { createTurn } from './turn/turn.js';
import { createUi } from './ui/ui.js';

// config: the settings (loadConfig). projects: bridge/projects.json, validated. adapters: the speech providers that have a key
// (createAdapters). openPort: opens the S3's serial port, or throws while there is none; the link tries again every second.
// The rest are for tests and the dev commands: `start` is the program that stands in for claude, `turn` overrides the turn's
// timings, `makeNonce` the link's HELLO nonce. `master` is the pairing key, `adpcm` asks for ADPCM audio (see Link).
export async function startBridge({ config, projects, adapters, openPort, store, console: con = createConsole(), start, env, makeNonce, master, adpcm, retry = {}, turn: turnOptions = {} }) {
  const link = new Link({ openPort, makeNonce, master, adpcm, ...retry });
  const approvals = createApprovals({ timeoutMs: config.claude.approvalTimeoutSec * 1000 });
  const server = createPermServer({ decide: (request) => approvals.request(request), log: con.log });
  let manager = null;
  let speech = null;
  let ui = null;
  let turn = null;
  let closing = null;

  // Deny what waits first, so that Claude is not left holding a request while it is ended; the link goes last, so that the
  // last frames still reach the device.
  async function close() {
    closing ??= (async () => {
      await turn?.close();
      approvals.denyAll();
      await manager?.close();
      await server.close();
      link.close();
    })();
    return closing;
  }

  try {
    const mcp = await server.start();
    const state = store ?? createStateStore({ report: con.log });
    manager = createManager({ config: config.claude, projects, store: state, mcp, start, env, log: con.log });
    speech = createSpeech({ adapters, config, projects, log: con.log });
    ui = createUi({ link, log: con.log });
    turn = createTurn({ link, speech, manager, approvals, ui, log: con.log, ...turnOptions });
    con.attach({ manager, approvals, link });
    turn.on('heard', con.heard);
    await link.start();
    manager.start();
  } catch (err) {
    await close();
    throw err;
  }
  return { link, manager, approvals, speech, ui, turn, console: con, close };
}
