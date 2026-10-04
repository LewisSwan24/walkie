// What `claude -p --output-format stream-json --verbose` prints, as the events the session manager acts on (spec 6.4).
// Written against the events recorded on 1 Oct 2026 (claude 2.1.285); test/claude/fixtures holds them. Everything the
// manager does not need (hook progress, thinking, rate limit news, tool output) is dropped here, so a new kind of event
// from a newer claude never reaches it, and an event it does need that changes shape shows up as a failing fixture.

export const MAX_LINE = 32 * 1024 * 1024; // one event is one line; a Write of a big file makes a big line

// Splits a stream of text into lines. `push` takes strings (decode the bytes first, with a decoder that keeps a character
// split between two chunks), `end` hands over a last line that had no newline. A line longer than `maxLine` is dropped,
// and `onLine` is told nothing about it: the stream is ruined for that one event only.
export function createLineSplitter(onLine, { maxLine = MAX_LINE } = {}) {
  let buffer = '';
  let skipping = false;
  return {
    push(chunk) {
      let text = buffer + chunk;
      buffer = '';
      for (;;) {
        const at = text.indexOf('\n');
        if (at < 0) break;
        const line = text.slice(0, at).replace(/\r$/, '');
        text = text.slice(at + 1);
        if (skipping) skipping = false;
        else if (line.length <= maxLine && line.trim()) onLine(line);
      }
      if (skipping) return;
      if (text.length > maxLine) skipping = true;
      else buffer = text;
    },
    end() {
      const rest = buffer.replace(/\r$/, ''); // nothing is buffered while a long line is being skipped
      buffer = '';
      skipping = false;
      if (rest.trim()) onLine(rest);
    },
  };
}

// One line as an event object, or null when it is not a JSON object.
export function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function usageOf(u) {
  return { input: num(u?.input_tokens), cacheWrite: num(u?.cache_creation_input_tokens), cacheRead: num(u?.cache_read_input_tokens), output: num(u?.output_tokens) };
}

// The events one raw event stands for, in order. Most raw events stand for none.
//   {kind: 'init', sessionId, model, walkie}   a turn begins (claude prints it at the start of EVERY turn, not once per
//                                              process); `walkie` is the permission server's connection status, or null
//   {kind: 'tool', id, name, input}            a tool_use block
//   {kind: 'text', text}                       a text block
//   {kind: 'api-error', code, text}            claude's own message for an API failure: `code` is its `error` field
//   {kind: 'compacting'}                       /compact started
//   {kind: 'compacted', trigger, preTokens, postTokens, durationMs}
//   {kind: 'result', ok, subtype, text, errors, apiStatus, terminal, sessionId, turns, durationMs, costUsd, usage, denials}
//                                              the turn is over. `ok` is false for every kind of error. A /compact ends
//                                              with a result whose text is empty.
export function interpret(event) {
  if (event === null || typeof event !== 'object') return [];
  if (event.type === 'system') {
    if (event.subtype === 'init') {
      const walkie = Array.isArray(event.mcp_servers) ? event.mcp_servers.find((s) => s?.name === 'walkie') : null;
      return [{ kind: 'init', sessionId: String(event.session_id ?? ''), model: String(event.model ?? ''), walkie: walkie?.status ?? null }];
    }
    if (event.subtype === 'status' && event.status === 'compacting') return [{ kind: 'compacting' }];
    if (event.subtype === 'compact_boundary') {
      const m = event.compact_metadata ?? {};
      return [{ kind: 'compacted', trigger: String(m.trigger ?? ''), preTokens: num(m.pre_tokens), postTokens: num(m.post_tokens), durationMs: num(m.duration_ms) }];
    }
    return [];
  }
  if (event.type === 'assistant') {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text);
    if (typeof event.error === 'string' && event.error) return [{ kind: 'api-error', code: event.error, text: texts.join('\n') }];
    const out = [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'text', text: b.text });
      else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push({ kind: 'tool', id: String(b.id ?? ''), name: b.name, input: b.input !== null && typeof b.input === 'object' ? b.input : {} });
    }
    return out;
  }
  if (event.type === 'result') {
    return [
      {
        kind: 'result',
        ok: event.is_error !== true,
        subtype: String(event.subtype ?? ''),
        text: typeof event.result === 'string' ? event.result : '',
        errors: Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === 'string') : [],
        apiStatus: typeof event.api_error_status === 'number' ? event.api_error_status : null,
        terminal: typeof event.terminal_reason === 'string' ? event.terminal_reason : '',
        sessionId: String(event.session_id ?? ''),
        turns: num(event.num_turns),
        durationMs: num(event.duration_ms),
        costUsd: num(event.total_cost_usd),
        usage: usageOf(event.usage),
        denials: Array.isArray(event.permission_denials) ? event.permission_denials.map((d) => ({ tool: String(d?.tool_name ?? ''), id: String(d?.tool_use_id ?? '') })) : [],
      },
    ];
  }
  return [];
}

// The line `claude` is sent for a user message: an input event of stream-json.
export function userLine(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}
