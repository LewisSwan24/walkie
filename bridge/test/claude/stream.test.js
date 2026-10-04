import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLineSplitter, interpret, parseEvent, userLine } from '../../src/claude/stream.js';

// The events of the live runs of 1 Oct 2026 (claude 2.1.285), cut down by hand: test/claude/fixtures.
function events(name) {
  const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
  return text.split('\n').filter(Boolean).flatMap((line) => interpret(parseEvent(line)));
}
const kinds = (list) => list.map((e) => e.kind);

test('a plain reply is an init, its text and a result; hooks, thinking and rate-limit news are dropped', () => {
  const list = events('hello');
  assert.deepEqual(kinds(list), ['init', 'text', 'result']);
  const [init, text, result] = list;
  assert.equal(init.model, 'claude-opus-5-5');
  assert.equal(init.walkie, 'connected');
  assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(text.text, /<voice>.*<\/voice>/);
  assert.equal(result.ok, true);
  assert.equal(result.subtype, 'success');
  assert.equal(result.text, text.text);
  assert.equal(result.turns, 1);
  assert.equal(result.sessionId, init.sessionId);
  assert.deepEqual(result.usage, { input: 2, cacheWrite: 36118, cacheRead: 16994, output: 111 });
  assert.ok(result.costUsd > 0.29 && result.costUsd < 0.3);
  assert.deepEqual(result.denials, []);
});

test('a tool call is its name and input, in the order it came', () => {
  const list = events('write-allowed');
  assert.deepEqual(kinds(list), ['init', 'tool', 'text', 'result']);
  const tool = list[1];
  assert.equal(tool.name, 'Write');
  assert.deepEqual(tool.input, { file_path: 'C:\\proj\\note.txt', content: 'walkie' });
  assert.match(tool.id, /^toolu_/);
  assert.equal(list[3].turns, 2);
});

test('a denied tool shows in the result, and the one reply answers both messages sent during the turn', () => {
  const list = events('write-denied');
  const result = list.at(-1);
  assert.equal(result.kind, 'result');
  assert.deepEqual(result.denials, [{ tool: 'Write', id: list.find((e) => e.kind === 'tool').id }]);
  assert.match(result.text, /rec-project2/);
});

test('a tool call that timed out and was tried again is two tool events and still one result', () => {
  const list = events('write-timed-out');
  assert.deepEqual(list.filter((e) => e.kind === 'tool').map((e) => e.name), ['Write', 'Glob', 'Write', 'Glob']);
  assert.equal(list.filter((e) => e.kind === 'result').length, 1);
  assert.equal(list.at(-1).turns, 5);
});

test('/compact is a compacting event, a compacted event with the token counts, and a result with no text', () => {
  const list = events('compact');
  assert.deepEqual(kinds(list), ['compacting', 'init', 'compacted', 'result']);
  assert.deepEqual(list[2], { kind: 'compacted', trigger: 'manual', preTokens: 55111, postTokens: 6566, durationMs: 16036 });
  assert.equal(list[3].ok, true);
  assert.equal(list[3].text, '');
  assert.equal(list[3].turns, 0);
});

test('a model claude does not know is an api-error and a failed result with status 404', () => {
  const list = events('error-model');
  const err = list.find((e) => e.kind === 'api-error');
  assert.equal(err.code, 'model_not_found');
  assert.match(err.text, /issue with the selected model/);
  const result = list.at(-1);
  assert.equal(result.ok, false);
  assert.equal(result.apiStatus, 404);
  assert.equal(result.terminal, 'api_error');
  assert.ok(!list.some((e) => e.kind === 'text'), 'the error text is not a reply');
});

test('a login that is no longer valid is an api-error and a failed result with status 401', () => {
  const list = events('error-login');
  assert.equal(list.find((e) => e.kind === 'api-error').code, 'authentication_failed');
  assert.deepEqual([list.at(-1).ok, list.at(-1).apiStatus], [false, 401]);
  assert.match(list.at(-1).text, /Failed to authenticate/);
});

test('resuming a session that does not exist is a failed result with the reason in errors and no text', () => {
  const [result] = events('error-resume');
  assert.equal(result.kind, 'result');
  assert.equal(result.ok, false);
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.text, '');
  assert.deepEqual(result.errors, ['No conversation found with session ID: 00000000-0000-4000-8000-000000000000']);
  assert.equal(result.turns, 0);
});

test('events of a kind the manager does not use, and things that are not events, give nothing', () => {
  for (const e of [null, undefined, 5, 'x', [], {}, { type: 'weird' }, { type: 'rate_limit_event' }, { type: 'user', message: { content: [] } }, { type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'status', status: null }, { type: 'assistant' }, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }]) {
    assert.deepEqual(interpret(e), [], JSON.stringify(e));
  }
});

test('an assistant message with text and a tool call gives both, text first, and blank text gives nothing', () => {
  const list = interpret({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'text', text: '   ' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } });
  assert.deepEqual(list, [{ kind: 'text', text: 'Looking.' }, { kind: 'tool', id: 't1', name: 'Grep', input: { pattern: 'x' } }]);
});

test('a tool call with no input, or an input that is not an object, has an empty input', () => {
  const list = interpret({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'A' }, { type: 'tool_use', id: 't2', name: 'B', input: 'oops' }, { type: 'tool_use', id: 't3', name: 'C', input: null }, { type: 'tool_use', id: 't4' }] } });
  assert.deepEqual(list.map((e) => [e.name, e.input]), [['A', {}], ['B', {}], ['C', {}]]);
});

test('an api error carries its code and the text of the message, without the blank blocks, and none at all is fine', () => {
  const error = (error, content) => interpret({ type: 'assistant', error, message: { content } });
  assert.deepEqual(error('rate_limit', [{ type: 'text', text: '  ' }, { type: 'text', text: 'Limit reached' }, { type: 'thinking', thinking: 'x' }]), [{ kind: 'api-error', code: 'rate_limit', text: 'Limit reached' }]);
  assert.deepEqual(interpret({ type: 'assistant', error: 'overloaded' }), [{ kind: 'api-error', code: 'overloaded', text: '' }]);
  assert.deepEqual(interpret({ type: 'assistant', error: '', message: { content: [{ type: 'text', text: 'fine' }] } }), [{ kind: 'text', text: 'fine' }]);
});

test('an init says whether the permission server is connected', () => {
  const init = (mcp_servers) => interpret({ type: 'system', subtype: 'init', session_id: 's', model: 'm', mcp_servers })[0];
  assert.equal(init([{ name: 'walkie', status: 'failed' }]).walkie, 'failed');
  assert.equal(init([{ name: 'other', status: 'connected' }]).walkie, null);
  assert.equal(init(undefined).walkie, null);
});

test('a result with fields missing still has every field, as zero, empty or false', () => {
  assert.deepEqual(interpret({ type: 'result', is_error: true })[0], {
    kind: 'result', ok: false, subtype: '', text: '', errors: [], apiStatus: null, terminal: '', sessionId: '', turns: 0, durationMs: 0, costUsd: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, denials: [],
  });
});

test('parseEvent takes a JSON object and nothing else', () => {
  assert.deepEqual(parseEvent('{"a":1}'), { a: 1 });
  for (const bad of ['[1]', '5', 'null', '"x"', '{nope', '', 'claude: warning']) assert.equal(parseEvent(bad), null, bad);
});

test('the splitter gives whole lines whatever the chunks, and takes CRLF as a newline', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l));
  s.push('{"a":');
  s.push('1}\r\n{"b"');
  s.push(':2}\n\n\n{"c":3}\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('the splitter hands over a last line that has no newline when it ends', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l));
  s.push('one\ntwo');
  assert.deepEqual(got, ['one']);
  s.end();
  assert.deepEqual(got, ['one', 'two']);
  s.end();
  assert.deepEqual(got, ['one', 'two']);
});

test('a line longer than the limit is dropped and the lines after it still arrive', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 10 });
  s.push('x'.repeat(30) + '\nok\n'); // whole in one chunk
  s.push('y'.repeat(25)); // begins in one chunk,
  s.push('y'.repeat(25)); // goes on in another
  s.push('yy\nfine\n'); // and ends in a third
  s.push('z'.repeat(40)); // a last one that never ends,
  s.push('zz'); // with a short chunk of its own at the end
  s.end();
  assert.deepEqual(got, ['ok', 'fine']);
});

test('a line of exactly the limit is kept, whether its newline comes with it or in the next chunk', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 10 });
  s.push('0123456789\n');
  s.push('abcdefghij');
  s.push('\n');
  s.push('0123456789A\n'); // one over
  assert.deepEqual(got, ['0123456789', 'abcdefghij']);
});

test('the splitter starts again after end', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 5 });
  s.push('toolongline'); // skipping, no newline yet
  s.end();
  s.push('ok\n');
  assert.deepEqual(got, ['ok']);
});

test('a user message is one line of stream-json, however many lines the message has', () => {
  const line = userLine('帮我看看\n第二行 "引号"');
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line');
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我看看\n第二行 "引号"' }] } });
});
