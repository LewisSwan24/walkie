// The session manager (spec 6.4): one claude process at a time, for the active project, kept alive between messages and
// started again with --resume when it has to be. It turns what the process prints into what the rest of walkie says or
// shows, and does nothing else: the approvals sit between the permission server and the device, not here.
//
// Events (`on(name, fn)`; every payload names its project, or is about the active one):
//   working {project, tool, summary, startedAt}      a turn began (tool null) or Claude began using a tool
//   reply   {project, kind, voice, screen, text, tagged, turns, ms, costUsd}   what Claude answered; kind 'reply' or 'compact'; costUsd is what that turn cost
//   idle    {project}                                the turn is over however it ended: every run of `working` ends in one
//   notice  {kind, text}                             news that is not a failure
//   failure {kind, message}                          something he has to do at the PC, or try again later
//   project {name}                                   the active project changed
// The failure event is not called "error": an EventEmitter throws when it emits 'error' and nobody listens.
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { findProject } from '../config/projects.js';
import { classifyFailure, MESSAGES } from './errors.js';
import { claudeArgs, spawnClaude } from './process.js';
import { statusText, toolSummary } from './status.js';
import { interpret } from './stream.js';
import { extractVoice } from './voice.js';

export const SAY = {
  stopped: '已停止。',
  nothingToStop: '现在没有在做事。',
  newSession: '好的，开了新的对话。',
  noProject: '没有这个项目。',
  sameProject: (name) => `已经在${name}了。`,
  switched: (name) => `切到${name}了。`,
};

export const NOTICE = {
  exitedBusy: 'Claude 意外退出了，刚才的事没做完，再说一句就会接着做。',
  exitedIdle: 'Claude 退出了，再说话会自动接上。',
  mcp: '审批通道没连上，Claude 要做的事都会被拒绝。',
  notReceived: 'Claude 没有收到这句话，再说一遍。',
};

export const CONTINUE_TEXT = '继续';
export const COMPACT_TEXT = '/compact';
const MISSING_SESSION = /no conversation found/i;
const MAX_JUNK_LOG = 200;

function folderExists(folder) {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

// config: the `claude` section of config.json. projects: bridge/projects.json, validated. store: the state store.
// mcp: {url, token} of the permission server. `start` is spawnClaude, or a stand-in for tests.
export function createManager({ config, projects, store, mcp, start = spawnClaude, env = process.env, log = () => {}, now = () => Date.now(), isDir = folderExists }) {
  const events = new EventEmitter();
  const live = new Set(); // every process started and not yet seen to exit, so that close() can end them all
  const turns = new Map(); // project -> turns answered since this bridge started
  const lastMs = new Map(); // project -> how long its last turn took
  let active = projects.find((p) => p.name === store.project())?.name ?? projects[0].name;
  let current = null; // the session whose events count; null when no process is running for the active project
  let closed = false;

  const emit = (name, payload) => {
    if (closed) return;
    try {
      events.emit(name, payload);
    } catch (err) {
      log(`claude: a listener of ${name} threw: ${err.message}`); // a broken screen must not break the session
    }
  };

  // ---- one process

  // Starts a process for `project`, resuming the session the store knows. Null when that cannot be done.
  function spawn(project, { resume = store.sessionId(project) } = {}) {
    const folder = projects.find((p) => p.name === project)?.path;
    if (!folder || !isDir(folder)) {
      emit('failure', { kind: 'cwd', message: `找不到项目的文件夹：${project}` });
      return null;
    }
    const session = { project, proc: null, resumed: Boolean(resume), gone: false, busy: false, tool: null, startedAt: 0, sent: [], idle: null, apiError: null, compacted: null, warnedMcp: false, totalUsd: 0 };
    log(`claude: starting ${project}${resume ? ` and resuming ${resume.slice(0, 8)}` : ''}`);
    try {
      session.proc = start(
        { command: config.command, args: claudeArgs({ model: config.model, mcpUrl: mcp.url, mcpToken: mcp.token, resume }), cwd: folder, env },
        { onEvent: (raw) => onEvent(session, raw), onJunk: (line) => log(`claude: ${line.slice(0, MAX_JUNK_LOG)}`), onExit: (info) => onExit(session, info) },
      );
    } catch (err) {
      emit('failure', classifyFailure({ code: err.code, text: String(err.message) }));
      return null;
    }
    live.add(session);
    current = session;
    armIdle(session);
    return session;
  }

  // The session no longer counts: nothing it prints is acted on, and it is not the current one.
  function release(session) {
    session.gone = true;
    clearTimeout(session.idle);
    if (current === session) current = null;
  }

  // Ends a process for good (its session id stays in the store, so that the next message resumes it).
  function end(session) {
    release(session);
    if (session.busy) emit('idle', { project: session.project });
    return session.proc.kill();
  }

  function armIdle(session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      log(`claude: ${session.project} idle for ${config.idleMinutes} minutes, closing its input`);
      release(session);
      session.proc.closeInput(); // it finishes and exits with 0; the next message starts it again
    }, config.idleMinutes * 60_000);
    session.idle.unref?.(); // an idle timer is no reason for the bridge to stay alive
  }

  function beginTurn(session) {
    if (session.busy) return;
    session.busy = true;
    session.startedAt = now();
    clearTimeout(session.idle);
    emit('working', { project: session.project, tool: null, summary: '', startedAt: session.startedAt });
  }

  function endTurn(session) {
    session.busy = false;
    session.tool = null;
    session.sent = [];
    session.compacted = null;
    session.apiError = null;
    armIdle(session);
  }

  function sendTo(session, text) {
    if (!session.proc.send(text)) return false;
    session.sent.push(text);
    return true;
  }

  // ---- what the process says

  function onEvent(session, raw) {
    if (session.gone) return;
    for (const ev of interpret(raw)) {
      if (ev.kind === 'init') onInit(session, ev);
      else if (ev.kind === 'tool') onTool(session, ev);
      else if (ev.kind === 'api-error') session.apiError = { code: ev.code, text: ev.text };
      else if (ev.kind === 'compacted') session.compacted = ev;
      else if (ev.kind === 'result') onResult(session, ev);
    }
  }

  // claude prints `init` at the start of every turn, so it is also how a turn nobody asked for in this process is noticed.
  function onInit(session, ev) {
    store.setSession(session.project, ev.sessionId); // the store keeps only what looks like a session id
    if (ev.walkie !== 'connected' && !session.warnedMcp) {
      session.warnedMcp = true;
      emit('notice', { kind: 'mcp', text: NOTICE.mcp });
    }
    beginTurn(session);
  }

  function onTool(session, ev) {
    beginTurn(session);
    session.tool = { name: ev.name, summary: toolSummary(ev.name, ev.input) };
    emit('working', { project: session.project, tool: session.tool.name, summary: session.tool.summary, startedAt: session.startedAt });
  }

  function compactSpeech(c) {
    if (!(c.preTokens > 0) || c.postTokens > c.preTokens) return '压缩完了。';
    return `压缩完了，上下文少了${Math.round((1 - c.postTokens / c.preTokens) * 100)}%。`;
  }

  function onResult(session, ev) {
    const { project } = session;
    if (!ev.ok && session.resumed && MISSING_SESSION.test([ev.text, ...ev.errors].join('\n'))) return replay(session);
    const { apiError, compacted } = session;
    const costUsd = Math.max(0, ev.costUsd - session.totalUsd); // claude's total_cost_usd is the process's running total, not the turn's
    session.totalUsd = Math.max(session.totalUsd, ev.costUsd);
    endTurn(session);
    if (!ev.ok) {
      emit('failure', classifyFailure({ code: apiError?.code, status: ev.apiStatus, text: ev.text || apiError?.text, errors: ev.errors, stderr: session.proc.stderrTail() }));
    } else if (compacted?.trigger === 'manual') {
      const spoken = compactSpeech(compacted);
      emit('reply', { project, kind: 'compact', voice: spoken, screen: spoken, text: '', tagged: false, turns: turns.get(project) ?? 0, ms: ev.durationMs, costUsd });
    } else {
      const done = (turns.get(project) ?? 0) + 1;
      turns.set(project, done);
      lastMs.set(project, ev.durationMs);
      log(`claude: ${project} turn ${done} took ${ev.durationMs} ms, ${costUsd.toFixed(3)} USD`);
      emit('reply', { project, kind: 'reply', ...extractVoice(ev.text), text: ev.text, turns: done, ms: ev.durationMs, costUsd });
    }
    emit('idle', { project });
  }

  // The session claude was asked to resume is gone: forget it, say so, and go on in a new one with what was said and not answered.
  function replay(session) {
    const { project } = session;
    const unanswered = session.sent;
    store.forgetSession(project);
    release(session);
    void session.proc.kill(); // it is ending by itself
    emit('notice', { kind: 'no-session', text: MESSAGES['no-session'] });
    const fresh = spawn(project); // the store has forgotten the session, so this one starts from nothing
    if (!fresh) {
      if (session.busy) emit('idle', { project });
      return;
    }
    if (session.busy) {
      fresh.busy = true; // the run of `working` goes on
      fresh.startedAt = session.startedAt;
      clearTimeout(fresh.idle);
    }
    for (const text of unanswered) sendTo(fresh, text);
  }

  function onExit(session, info) {
    live.delete(session);
    if (session.gone) return; // ended by us: a stop, a switch, the idle close
    release(session);
    const wasBusy = session.busy;
    log(`claude: ${session.project} exited (code ${info.code}, signal ${info.signal})`);
    const failure = classifyFailure({ code: info.error?.code, text: info.error ? String(info.error.message) : '', stderr: info.stderr });
    if (info.error || failure.kind !== 'other') emit('failure', failure);
    else emit('notice', { kind: 'exited', text: wasBusy ? NOTICE.exitedBusy : NOTICE.exitedIdle });
    if (wasBusy) emit('idle', { project: session.project });
  }

  // ---- what he says

  function say(text) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = current ?? spawn(active);
      if (!session) return false;
      if (sendTo(session, text)) {
        beginTurn(session);
        return true;
      }
      release(session); // gone without a word yet: start a new one for the second attempt
      void session.proc.kill();
    }
    emit('failure', { kind: 'other', message: NOTICE.notReceived });
    return false;
  }

  async function stop() {
    const session = current;
    if (!session?.busy) return { speak: SAY.nothingToStop };
    await end(session);
    return { speak: SAY.stopped };
  }

  async function newSession() {
    const ended = current ? end(current) : null;
    store.forgetSession(active);
    turns.delete(active);
    if (config.prewarm) spawn(active);
    await ended;
    return { speak: SAY.newSession };
  }

  async function switchProject(name) {
    const target = findProject(projects, name);
    if (!target) return { speak: SAY.noProject };
    if (target.name === active) return { speak: SAY.sameProject(target.name) };
    const ended = current ? end(current) : null;
    active = target.name;
    store.setProject(active);
    emit('project', { name: active });
    if (config.prewarm) spawn(active);
    await ended;
    return { speak: SAY.switched(active) };
  }

  function statusLine() {
    const session = current;
    const done = turns.get(active) ?? 0;
    return statusText({
      project: active,
      running: Boolean(session),
      busy: Boolean(session?.busy),
      tool: session?.tool?.name ?? null,
      summary: session?.tool?.summary ?? '',
      elapsedMs: session?.busy ? now() - session.startedAt : (lastMs.get(active) ?? null),
      turns: session?.busy ? done + 1 : done,
      resumable: Boolean(store.sessionId(active)),
    });
  }

  return {
    project: () => active,
    on(name, fn) {
      events.on(name, fn);
      return () => events.off(name, fn);
    },
    // Remembers the active project and, if configured, starts its process now so that the first message does not wait for it.
    start() {
      store.setProject(active);
      if (config.prewarm && !current) spawn(active);
    },
    // What to do about one thing he said: {intent, project, text}, as validateAnswer gives it. Resolves {speak?}.
    async handle({ intent, project, text }) {
      if (closed) return {};
      switch (intent) {
        case 'to_claude':
          if (typeof text === 'string' && text.trim()) say(text);
          return {};
        case 'continue':
          say(CONTINUE_TEXT);
          return {};
        case 'compact':
          say(COMPACT_TEXT);
          return {};
        case 'stop':
          return stop();
        case 'new_session':
          return newSession();
        case 'switch_project':
          return switchProject(project);
        case 'status':
          return { speak: statusLine() };
        default:
          return {};
      }
    },
    // Ends every process this manager started, and stops telling anyone anything.
    async close() {
      closed = true;
      const all = [...live];
      for (const session of all) release(session);
      await Promise.all(all.map((session) => session.proc.kill()));
    },
  };
}
