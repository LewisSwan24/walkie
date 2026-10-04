// The session manager from a terminal, with no S3: claude runs the way the bridge will run it, the permission server and the
// approvals queue are the real ones, and what the wrist would do is typed instead. One command per line on stdin:
//   say <text>                         what he would say to Claude
//   continue | compact | new | stop | status      the spoken commands of the same names
//   switch <project>                   switch_project (needs --project: the default is one project, the current folder)
//   yes | no [reason]                  answer the approval that is on the screen
//   wait idle|working|approval [secs]  go on when that is so (120 s at most unless told); a wait that runs out ends the run
//   sleep <secs>                       do nothing for a while (to see the idle close, or a prewarmed process, work)
//   quit                               end it now; the end of the input waits for the turn that is running, then ends
// Options:
//   --cwd <dir>        the one project is that folder (default: the current folder, called "dev")
//   --project <name>   use bridge/projects.json and start in that project
//   --command <json>   the program and its leading arguments as a JSON array, for a stand-in: '["node","fake-claude.js"]'
//   --clean-env        claude is given the environment without CLAUDE* and ANTHROPIC* variables; needed inside the Claude app's
//                      own shell, whose variables point a nested claude at the app instead of at the login
import { statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createManager } from '../claude/manager.js';
import { loadConfig } from '../config/config.js';
import { loadProjects } from '../config/projects.js';
import { createStateStore } from '../config/state.js';
import { createApprovals } from '../perm/approvals.js';
import { createPermServer } from '../perm/server.js';

export const WAIT_SECONDS = 120;
const MAX_SECONDS = 3600;
const SPOKEN = { continue: 'continue', compact: 'compact', new: 'new_session', stop: 'stop', status: 'status' };
const WORDS = [...Object.keys(SPOKEN), 'say', 'switch', 'yes', 'no', 'wait', 'sleep', 'quit'];
const WAITS = ['idle', 'working', 'approval'];

export class CommandError extends Error {}

function seconds(text, what) {
  const n = Number(text); // no text at all is NaN or 0: both are refused below
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SECONDS) throw new CommandError(`${what} needs a number of seconds, more than 0 and at most ${MAX_SECONDS}`);
  return n;
}

// One line of the script. Null for a blank line or a comment; a CommandError for a line that is not a command: a typo must
// not run the rest of a script that was written for something else.
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const word = trimmed.split(/\s+/, 1)[0];
  const rest = trimmed.slice(word.length).trim();
  if (word === 'say') {
    if (!rest) throw new CommandError('say needs the words to say');
    return { do: 'handle', message: { intent: 'to_claude', text: rest } };
  }
  if (Object.hasOwn(SPOKEN, word)) return { do: 'handle', message: { intent: SPOKEN[word] } };
  if (word === 'switch') {
    if (!rest) throw new CommandError('switch needs a project name');
    return { do: 'handle', message: { intent: 'switch_project', project: rest } };
  }
  if (word === 'yes') return { do: 'answer', allow: true, reason: '' };
  if (word === 'no') return { do: 'answer', allow: false, reason: rest };
  if (word === 'wait') {
    const [what, secs, extra] = rest.split(/\s+/);
    if (!WAITS.includes(what) || extra !== undefined) throw new CommandError(`wait is followed by ${WAITS.join(', ')} and, if you like, a number of seconds`);
    return { do: 'wait', what, seconds: secs === undefined ? WAIT_SECONDS : seconds(secs, 'wait') };
  }
  if (word === 'sleep') return { do: 'sleep', seconds: seconds(rest, 'sleep') };
  if (word === 'quit') return { do: 'quit' };
  throw new CommandError(`unknown command "${word}" (${WORDS.join(', ')})`);
}

const clock = (ms) => `${(ms / 1000).toFixed(1)} s`;
const indent = (text, by = '    ') => text.split('\n').map((l) => `${by}${l}`).join('\n');

// Runs `lines` (an async iterable of strings) against the manager and the approvals queue. Everything that happens is
// `print`ed. Resolves true when the script ran to its end, false when a wait ran out or `signal` aborted (Ctrl+C). Throws a
// CommandError for a line that is not a command; the manager and the approvals are left to the caller to close.
export async function runSession({ manager, approvals, lines, print = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal }) {
  let busy = false;
  const waiters = new Set();
  const ring = (what) => {
    for (const w of [...waiters]) if (w.what === what) w.done(true);
  };
  const waitFor = (what, secs) => {
    if ((what === 'idle' && !busy) || (what === 'working' && busy) || (what === 'approval' && approvals.current())) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => w.done(false), secs * 1000);
      const w = {
        what,
        done(value) {
          clearTimeout(timer);
          waiters.delete(w);
          resolve(value);
        },
      };
      waiters.add(w);
    });
  };
  signal?.addEventListener('abort', () => {
    for (const w of [...waiters]) w.done(false);
  }, { once: true });

  manager.on('working', ({ tool, summary }) => {
    busy = true;
    print(tool ? `[working] ${tool}${summary ? `: ${summary}` : ''}` : '[working] thinking');
    ring('working');
  });
  manager.on('idle', () => {
    busy = false;
    print('[idle]');
    ring('idle');
  });
  manager.on('reply', (r) => print(`[reply] ${r.kind}, ${r.kind === 'reply' ? `turn ${r.turns}, ` : ''}${clock(r.ms)}, $${r.costUsd.toFixed(3)}${r.tagged ? '' : ', no <voice> tag'}\n  voice: ${r.voice}\n  screen:\n${indent(r.screen)}`));
  manager.on('notice', (n) => print(`[notice] ${n.kind}: ${n.text}`));
  manager.on('failure', (f) => print(`[failure] ${f.kind}: ${f.message}`));
  manager.on('project', (p) => print(`[project] ${p.name}`));
  approvals.on('show', (r) => {
    print(`[approval] #${r.id} ${r.tool}\n${indent(r.preview)}\n  answer: yes | no [reason]`);
    ring('approval');
  });
  approvals.on('clear', (c) => print(`[approval] #${c.id} ${c.outcome}`));

  manager.start();
  for await (const line of lines) {
    if (signal?.aborted) return false;
    const command = parseLine(line);
    if (!command) continue;
    if (command.do === 'quit') return true;
    if (command.do === 'handle') {
      const { speak } = await manager.handle(command.message);
      if (speak) print(`[says] ${speak}`);
    } else if (command.do === 'answer') {
      const shown = approvals.current();
      if (!shown) print('[approval] nothing is waiting');
      else approvals.answer(shown.id, { allow: command.allow, reason: command.reason });
    } else if (command.do === 'sleep') {
      await sleep(command.seconds * 1000);
    } else if (!(await waitFor(command.what, command.seconds))) {
      if (!signal?.aborted) print(`[wait] ${command.what} did not happen in ${command.seconds} s`);
      return false;
    }
  }
  if (signal?.aborted) return false;
  if (await waitFor('idle', WAIT_SECONDS)) return true; // the end of the input: let the turn that is running finish
  if (!signal?.aborted) print(`[wait] idle did not happen in ${WAIT_SECONDS} s`);
  return false;
}

export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(CLAUDE|ANTHROPIC)/i.test(name)));
}

export function commandFrom(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === 'string' && s)) {
    throw new Error('--command is the program and its leading arguments as a JSON array of strings, like \'["node","fake-claude.js"]\'');
  }
  return parsed;
}

// The projects the run may use: the one folder, or bridge/projects.json with `--project`.
export function projectsFor(opts, { cwd = process.cwd(), load = loadProjects } = {}) {
  if (opts.cwd !== undefined && opts.project !== undefined) throw new Error('--cwd and --project cannot be used together: one folder, or a project from projects.json');
  if (opts.project !== undefined) {
    const projects = load();
    if (!projects.some((p) => p.name === opts.project)) throw new Error(`--project ${opts.project}: not in projects.json (${projects.map((p) => p.name).join(', ')})`);
    return { projects, active: opts.project };
  }
  const folder = path.resolve(opts.cwd ?? cwd);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--cwd ${folder}: not a folder`);
  return { projects: [{ name: 'dev', aliases: [], path: folder }], active: 'dev' };
}

// A developer run keeps its state in memory, so that it cannot touch the session ids of the real bridge, and starts in `active`.
export function stateFor(active) {
  const store = createStateStore({ file: null });
  store.setProject(active);
  return store;
}

// The claude section of the config, with the program replaced when `--command` names a stand-in.
export function settingsFor(config, opts) {
  return { ...config.claude, ...(opts.command ? { command: commandFrom(opts.command) } : {}) };
}

// The queue of approvals: a request that nobody answers is denied after claude.approvalTimeoutSec, below the 60 s at which
// claude's own client gives up on a pending call.
export const queueFor = (settings) => createApprovals({ timeoutMs: settings.approvalTimeoutSec * 1000 });

// Ctrl+C: the waits end, no more lines are read, and the run closes what it started. Returns the signal that says so.
export function ctrlC(emitter, lines) {
  const controller = new AbortController();
  emitter.once('SIGINT', () => {
    controller.abort();
    lines.close();
  });
  return controller.signal;
}

export default async function claude(args, opts) {
  if (args.length > 0 && !(args.length === 1 && args[0] === '--clean-env')) throw new Error('claude [--cwd dir | --project name] [--command json] [--clean-env]  (the commands are read from stdin)');
  const config = loadConfig();
  const { projects, active } = projectsFor(opts);
  const store = stateFor(active);
  const settings = settingsFor(config, opts);
  const approvals = queueFor(settings);
  const server = createPermServer({ decide: (request) => approvals.request(request), log: (line) => console.log(`[log] ${line}`) });
  const mcp = await server.start();
  const manager = createManager({
    config: settings,
    projects,
    store,
    mcp,
    env: args.includes('--clean-env') ? cleanEnv(process.env) : process.env,
    log: (line) => console.log(`[log] ${line}`),
  });
  const lines = createInterface({ input: process.stdin });
  const signal = ctrlC(process, lines);
  try {
    console.log(`[claude] ${projects.length === 1 ? projects[0].path : `${projects.length} projects`}, starting in ${active}; permission server on ${mcp.url}`);
    if (!(await runSession({ manager, approvals, lines, signal }))) process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    console.error(`walkie-dev claude: ${err.message}`);
    process.exitCode = 2;
  } finally {
    lines.close();
    approvals.denyAll();
    await manager.close();
    await server.close();
  }
}
