// Stand-ins for what spawnClaude returns, so that the manager can be tested without a process: nothing runs, the test says what
// the process printed (`print`) and when it exited (`exit`), and reads what the manager sent to it and did to it.
// `ev` builds the events claude prints, in the shapes recorded on 1 Oct 2026 (test/claude/fixtures).

export const SESSION = '11111111-2222-4333-8444-555555555555';

export function createProcs() {
  const procs = [];
  function start(spec, handlers) {
    const proc = {
      spec,
      pid: 1000 + procs.length,
      sent: [],
      inputClosed: false,
      killed: false,
      ended: false,
      stderr: '',
      send(text) {
        if (proc.inputClosed || proc.ended) return false;
        proc.sent.push(text);
        return true;
      },
      closeInput() {
        proc.inputClosed = true;
      },
      kill() {
        proc.killed = true;
        queueMicrotask(() => proc.exit({ code: 1 })); // a killed process does report its exit, a moment later
        return Promise.resolve();
      },
      stderrTail: () => proc.stderr,
      // the test's side
      print: (event) => handlers.onEvent(event),
      junk: (line) => handlers.onJunk(line),
      exit(info = {}) {
        if (proc.ended) return;
        proc.ended = true;
        handlers.onExit({ code: 0, signal: null, stderr: proc.stderr, ...info });
      },
    };
    procs.push(proc);
    return proc;
  }
  return { start, procs, last: () => procs.at(-1) };
}

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: SESSION, ...extra });

export const ev = {
  init: ({ sessionId = SESSION, walkie = 'connected' } = {}) => ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-opus-5-5',
    cwd: 'C:\\proj',
    mcp_servers: walkie === null ? [] : [{ name: 'walkie', status: walkie, source: 'dynamic' }],
  }),
  tool: (name, input = {}) => assistant([{ type: 'tool_use', id: 'toolu_1', name, input }]),
  text: (text) => assistant([{ type: 'text', text }]),
  apiError: (code, text) => assistant([{ type: 'text', text }], { error: code, is_api_error_message: true }),
  compacting: () => ({ type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION }),
  compacted: ({ trigger = 'manual', pre = 55111, post = 6566 } = {}) => ({ type: 'system', subtype: 'compact_boundary', session_id: SESSION, compact_metadata: { trigger, pre_tokens: pre, post_tokens: post, duration_ms: 16036 } }),
  result: ({ text = '', ok = true, sessionId = SESSION, ms = 1500, cost = 0.05, status = null, errors = [], subtype = 'success', turns = 1 } = {}) => ({
    type: 'result',
    subtype,
    is_error: !ok,
    result: text,
    errors,
    api_error_status: status,
    session_id: sessionId,
    num_turns: turns,
    duration_ms: ms,
    total_cost_usd: cost,
    permission_denials: [],
  }),
};
