// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`, so that the process wrapper and
// the session manager can be tested against a real process without Claude, a login or the network. It takes the real argument
// list, reads user messages from stdin one JSON line at a time, prints events one JSON line at a time, and talks to the
// permission server as an MCP client over HTTP, as Claude Code does. What it prints is copied from the recordings of 1 Oct
// 2026 (claude 2.1.285, test/claude/fixtures): hook and thinking noise, `system/init` at the start of EVERY turn, the /compact
// sequence, the errors. Messages that are in before the first turn has begun are answered as turns of their own (measured); one
// that arrives while a turn runs is merged into that turn, one result for both (NOT measured with the real claude).
//
// Settings (JSON in the environment variable FAKE_CLAUDE):
//   bootMs        how long the SessionStart hooks take before the first message can be answered (default 0)
//   turnMs        how long the model takes over each turn (default 0)
//   stateDir      where a session is kept between processes, so that `--resume <id>` finds it (without it nothing is found)
//   argsFile      every start appends {argv, cwd, pid, claudeVars} to this file, one JSON line; claudeVars are the names of the
//                 environment variables it was given that start with CLAUDE or ANTHROPIC (what `--clean-env` takes out)
//   mcpTimeoutMs  how long a call to the permission tool may wait; the real client gives up at about 60 s (default 60000)
//
// What a message says decides what happens (the first message of a turn; the others are merged):
//   /compact          compacts the conversation
//   !write <file>     the model asks to Write <file> (default note.txt) in its folder: that needs the walkie approval
//   !sleep <ms>       the model runs a Bash command that takes that long
//   !big <n>          the reply text is n characters long
//   !junk             a line that is not JSON is printed first
//   !login | !model   the API refuses: login expired, model not found
//   !crash            the process dies with exit code 1 in the middle of the turn
//   anything else     "I heard: <text>"
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mcpClient } from '../helpers/mcp-client.js';

const cfg = { bootMs: 0, turnMs: 0, stateDir: null, argsFile: null, mcpTimeoutMs: 60_000, ...JSON.parse(process.env.FAKE_CLAUDE || '{}') };
const argv = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

let leaving = false;
function leave(code) {
  if (leaving) return;
  leaving = true;
  process.exitCode = code;
  process.stdout.write('', () => process.exit()); // everything written so far goes out first
}

// ---- the command line

const VALUE_FLAGS = ['--input-format', '--output-format', '--model', '--mcp-config', '--permission-prompt-tool', '--append-system-prompt', '--resume'];
const flags = new Set();
const values = {};
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.includes(argv[i])) values[argv[i]] = argv[++i];
  else flags.add(argv[i]);
}

function mcpServer() {
  try {
    const server = JSON.parse(values['--mcp-config']).mcpServers.walkie;
    return { url: server.url, token: server.headers.Authorization.replace(/^Bearer /, '') };
  } catch {
    return null;
  }
}

function usageError() {
  if (!flags.has('-p')) return 'fake-claude: only print mode (-p) is supported';
  if (values['--input-format'] !== 'stream-json' || values['--output-format'] !== 'stream-json') return 'fake-claude: both formats must be stream-json';
  if (!flags.has('--verbose')) return 'Error: When using --print, --output-format=stream-json requires --verbose';
  if (!values['--model']) return 'fake-claude: --model is missing';
  if (!flags.has('--strict-mcp-config') || !mcpServer()) return 'fake-claude: --strict-mcp-config and an --mcp-config with a walkie server are expected';
  if (values['--permission-prompt-tool'] !== 'mcp__walkie__approve') return 'fake-claude: the permission tool must be mcp__walkie__approve';
  return null;
}

// ---- the session

const resume = values['--resume'] ?? null;
const model = values['--model'];
const sessionId = resume ?? randomUUID();
const sessionFile = cfg.stateDir ? path.join(cfg.stateDir, `${sessionId}.json`) : null;
let turns = 0;
let mcp = null; // {client} once connected
let mcpStatus = 'failed';
let lastWasError = false;
let totalUsd = 0; // like the real claude's total_cost_usd: what the whole process has cost so far, not one turn

function saveSession() {
  if (!sessionFile) return;
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ turns }));
}

async function connectMcp() {
  try {
    const { url, token } = mcpServer();
    const client = mcpClient({ url, token, agent: new http.Agent({ keepAlive: false }) });
    if (!(await client.initialize()).result) return;
    await client.notify('notifications/initialized');
    const listed = await client.rpc('tools/list');
    if (!listed.result.tools.some((t) => t.name === 'approve')) return;
    mcp = { client };
    mcpStatus = 'connected';
  } catch {
    // stays 'failed'
  }
}

// ---- events, as recorded

const hook = (subtype, id, name) => ({ type: 'system', subtype, hook_id: id, hook_name: name, hook_event: 'SessionStart', ...(subtype === 'hook_response' ? { output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' } : {}), session_id: sessionId });
const init = () => ({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: ['Bash', 'Edit', 'Glob', 'Read', 'Write'], mcp_servers: [{ name: 'walkie', status: mcpStatus, source: 'dynamic' }], model, permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.285', output_style: 'default' });
const thinkingTokens = () => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50, session_id: sessionId });
const rateLimit = () => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false }, session_id: sessionId });
const assistant = (content) => ({ type: 'assistant', message: { model, id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, stop_reason: null, stop_sequence: null }, parent_tool_use_id: null, session_id: sessionId });
const thinking = () => assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]);
const textOf = (text) => ({ type: 'text', text });
const toolUse = (name, input) => {
  const id = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  return { id, event: assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }]) };
};
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: sessionId });
const resultEvent = ({ started, text = '', turnCount = 1, denials = [], error = null }) => ({
  type: 'result',
  subtype: 'success',
  is_error: error !== null,
  duration_ms: Date.now() - started,
  duration_api_ms: Date.now() - started,
  num_turns: turnCount,
  result: text,
  stop_reason: 'end_turn',
  session_id: sessionId,
  total_cost_usd: (totalUsd += 0.0123),
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 20 },
  permission_denials: denials,
  terminal_reason: error ? 'api_error' : 'completed',
  api_error_status: error?.status ?? null,
});

// ---- one turn

let turn = null; // the running turn: {texts}; a message that arrives meanwhile is added to it
const queue = [];
let ready = false;
let stdinEnded = false;

// The model's last words: `screen` is what it writes, `voice` is the line inside <voice>. Messages merged into the turn are named.
function finish(started, screen, voice, denials = []) {
  const merged = turn.texts.slice(1);
  const also = merged.length ? ` Also heard: ${merged.join(' / ')}.` : '';
  const text = `${screen}${also}\n\n<voice>${voice}${also}</voice>`;
  out(assistant([textOf(text)]));
  out(rateLimit());
  out(resultEvent({ started, text, turnCount: denials.length ? 2 : 1, denials }));
  lastWasError = false;
}

function apiError(started, code, status, text) {
  out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, error: code, is_api_error_message: true, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', content: [textOf(text)] } });
  out(resultEvent({ started, text, error: { status } }));
  lastWasError = true;
}

// Asks the walkie permission tool, as the real client does, and gives up after mcpTimeoutMs.
async function askPermission(args) {
  if (!mcp) return { behavior: 'deny', message: 'mcp__walkie__approve is not connected' };
  try {
    return await mcp.client.approve(args, AbortSignal.timeout(cfg.mcpTimeoutMs));
  } catch {
    return { behavior: 'timeout' };
  }
}

async function write(started, file) {
  const input = { file_path: path.resolve(process.cwd(), file), content: 'walkie' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const asked = toolUse('Write', input);
    out(asked.event);
    out(rateLimit());
    const verdict = await askPermission({ tool_name: 'Write', input, tool_use_id: asked.id });
    if (verdict.behavior === 'allow') {
      const final = verdict.updatedInput ?? input;
      fs.writeFileSync(final.file_path, final.content);
      out(toolResult(asked.id, `File created successfully at: ${final.file_path}`));
      return finish(started, `Created ${file}.`, `I made ${file}.`);
    }
    if (verdict.behavior === 'deny') {
      out(toolResult(asked.id, verdict.message, true));
      return finish(started, `You refused the write, so ${file} was not created.`, `You refused it, so ${file} was not made.`, [{ tool_name: 'Write', tool_use_id: asked.id, tool_input: input }]);
    }
    out(toolResult(asked.id, '<tool_use_error>Error calling tool (Write): The operation timed out.</tool_use_error>', true));
  }
  return finish(started, `I could not create ${file}: the Write tool timed out twice.`, `I could not make ${file}, it timed out.`);
}

async function compact(started) {
  const id = randomUUID();
  out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
  out(hook('hook_started', id, 'SessionStart:compact'));
  await wait(cfg.turnMs);
  out(hook('hook_response', id, 'SessionStart:compact'));
  out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId });
  out(init());
  out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: 55111, post_tokens: 6566, cumulative_dropped_tokens: 48545, duration_ms: 16036 } });
  out({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation.' }, session_id: sessionId, parent_tool_use_id: null, isReplay: false, isSynthetic: true });
  out(resultEvent({ started, turnCount: 0 }));
  lastWasError = false;
}

async function runTurn() {
  const started = Date.now();
  const first = turn.texts[0].trim();
  if (first === '/compact') return compact(started);
  turns += 1;
  saveSession();
  out(init());
  out(thinkingTokens());
  out(thinking());
  await wait(cfg.turnMs);
  const [, command, rest = ''] = /^!(\w+)\s*(.*)$/s.exec(first) ?? [];
  switch (command) {
    case 'write':
      return write(started, rest.trim() || 'note.txt');
    case 'sleep': {
      const ms = Number(rest) || 0;
      const running = toolUse('Bash', { command: `sleep ${Math.ceil(ms / 1000)}`, description: `Wait ${ms} ms` });
      out(running.event);
      await wait(ms);
      out(toolResult(running.id, ''));
      return finish(started, `Waited ${ms} ms (turn ${turns}).`, `I waited ${ms} milliseconds.`);
    }
    case 'big':
      return finish(started, 'x'.repeat(Number(rest) || 1000), 'That was a long one.');
    case 'junk':
      process.stdout.write('warning: this line is not an event\n');
      return finish(started, `Junk first (turn ${turns}).`, 'Junk first.');
    case 'login':
      out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 10, error_status: 401, error: 'authentication_failed', session_id: sessionId });
      return apiError(started, 'authentication_failed', 401, 'Failed to authenticate. API Error: 401 OAuth access token is invalid.');
    case 'model':
      return apiError(started, 'model_not_found', 404, `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`);
    case 'crash':
      out(assistant([textOf('about to fall over')]));
      err('fake-claude: simulated crash');
      leave(1);
      return new Promise(() => {}); // the process ends before this settles
    default: {
      const heard = first;
      return finish(started, `I heard: ${heard} (turn ${turns})`, `I heard: ${heard}`);
    }
  }
}

async function pump() {
  if (!ready || turn || !queue.length) return;
  turn = { texts: [queue.shift()] };
  try {
    await runTurn();
  } finally {
    turn = null;
  }
  pump();
  maybeLeave();
}

// Closing stdin ends the process once the running turn is over; the code says whether the last turn failed.
function maybeLeave() {
  if (stdinEnded && ready && !turn && !queue.length) leave(lastWasError ? 1 : 0);
}

// ---- input

function accept(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return err(`fake-claude: input is not JSON: ${line.slice(0, 80)}`);
  }
  const blocks = message?.type === 'user' && message.message?.role === 'user' ? message.message.content : null;
  const text = Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  if (!text) return err('fake-claude: input is not a user message with text');
  if (turn) turn.texts.push(text);
  else {
    queue.push(text);
    pump();
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) accept(line);
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) accept(buffer.trim());
  buffer = '';
  stdinEnded = true;
  maybeLeave();
});

// ---- start

async function main() {
  const wrong = usageError();
  if (wrong) {
    err(wrong);
    return leave(1);
  }
  if (cfg.argsFile) {
    const claudeVars = Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC)/i.test(name)).sort();
    fs.appendFileSync(cfg.argsFile, `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, claudeVars })}\n`);
  }
  const hookId = randomUUID();
  out(hook('hook_started', hookId, 'SessionStart:startup'));
  await wait(cfg.bootMs);
  out(hook('hook_response', hookId, 'SessionStart:startup'));
  if (resume) {
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      const message = `No conversation found with session ID: ${resume}`;
      err(message);
      out({ ...resultEvent({ started: Date.now(), turnCount: 0, error: {} }), subtype: 'error_during_execution', session_id: randomUUID(), total_cost_usd: 0, errors: [message], terminal_reason: undefined, api_error_status: undefined });
      return leave(1);
    }
    turns = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).turns;
  }
  await connectMcp();
  ready = true;
  pump();
  maybeLeave();
}

main();
