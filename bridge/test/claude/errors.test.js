import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFailure, MESSAGES } from '../../src/claude/errors.js';
import { interpret, parseEvent } from '../../src/claude/stream.js';

// What the manager would hand over for a recorded failure: the code of the api-error event and the fields of the result.
function failureOf(name) {
  const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
  const list = text.split('\n').filter(Boolean).flatMap((line) => interpret(parseEvent(line)));
  const apiError = list.find((e) => e.kind === 'api-error');
  const result = list.find((e) => e.kind === 'result');
  return { code: apiError?.code ?? '', status: result.apiStatus, text: result.text, errors: result.errors };
}

test('the three failures recorded from the real claude are told apart', () => {
  assert.deepEqual(classifyFailure(failureOf('error-login')), { kind: 'login', message: 'Claude 登录过期，回电脑上登录' });
  assert.deepEqual(classifyFailure(failureOf('error-model')), { kind: 'model', message: 'Claude 不认这个模型，回电脑运行 claude update' });
  assert.deepEqual(classifyFailure(failureOf('error-resume')), { kind: 'no-session', message: '找不到上次的对话，已经开了新的' });
});

test('the model failure names the command that fixes it', () => {
  assert.match(MESSAGES.model, /claude update/);
});

test('each kind is also recognised from its status or its words alone', () => {
  const kind = (f) => classifyFailure(f).kind;
  assert.equal(kind({ status: 401 }), 'login');
  assert.equal(kind({ stderr: 'Invalid API key · Please run /login' }), 'login');
  assert.equal(kind({ text: 'OAuth token has expired' }), 'login');
  assert.equal(kind({ text: 'The model does not support this model setting' }), 'model');
  assert.equal(kind({ stderr: '[claude-code:unrecognized_model] {"model":"x"}' }), 'model');
  assert.equal(kind({ errors: ['No conversation found with session ID: abc'] }), 'no-session');
  assert.equal(kind({ code: 'rate_limit' }), 'rate');
  assert.equal(kind({ status: 429 }), 'rate');
  assert.equal(kind({ text: "You've hit your limit · resets 3pm" }), 'rate');
  assert.equal(kind({ text: 'Rate limit reached' }), 'rate');
  assert.equal(kind({ code: 'overloaded' }), 'overloaded');
  assert.equal(kind({ status: 529 }), 'overloaded');
  assert.equal(kind({ status: 503 }), 'overloaded');
  assert.equal(kind({ text: 'Overloaded' }), 'overloaded');
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) assert.equal(kind({ code }), 'missing', code);
  assert.equal(classifyFailure({ code: 'ENOENT' }).message, '找不到 claude 程序，回电脑检查安装');
});

test('each of the words claude uses is enough on its own', () => {
  const kind = (text) => classifyFailure({ text }).kind;
  assert.equal(kind('Failed to authenticate'), 'login');
  assert.equal(kind('You are not logged in'), 'login');
  assert.equal(kind("There's an issue with the selected model (x)"), 'model');
  assert.equal(kind('error: model_not_found'), 'model');
  assert.equal(kind('ratelimit exceeded'), 'rate');
  assert.equal(kind('Claude usage limit exceeded'), 'rate');
  assert.equal(kind('Limit reached'), 'rate');
  assert.equal(kind('Too many requests'), 'rate');
  assert.equal(kind('Server is overloaded'), 'overloaded');
});

test('a login problem wins over a rate limit when both are mentioned, and a model over a missing session', () => {
  assert.equal(classifyFailure({ code: 'authentication_failed', text: 'rate limit' }).kind, 'login');
  assert.equal(classifyFailure({ code: 'model_not_found', errors: ['No conversation found'] }).kind, 'model');
});

test('anything else shows the first line of what claude said, cut to fit the screen', () => {
  assert.deepEqual(classifyFailure({ text: '\n  Something odd happened\nsecond line' }), { kind: 'other', message: 'Claude 出错了：Something odd happened' });
  const long = classifyFailure({ text: 'x'.repeat(80) }).message;
  assert.equal(long, `Claude 出错了：${'x'.repeat(49)}…`);
  assert.equal(classifyFailure({ text: 'y'.repeat(50) }).message, `Claude 出错了：${'y'.repeat(50)}`);
  assert.equal(classifyFailure({ text: '遇到了一个意外'.repeat(10) }).message, `Claude 出错了：${Array.from('遇到了一个意外'.repeat(10)).slice(0, 49).join('')}…`);
});

test('with no text it falls back on the errors list, then the last line of stderr, then the exit code', () => {
  assert.equal(classifyFailure({ text: 'from the text', errors: ['from the errors'], stderr: 'from stderr' }).message, 'Claude 出错了：from the text');
  assert.equal(classifyFailure({ errors: ['', 'Disk full'], stderr: 'noise' }).message, 'Claude 出错了：Disk full');
  assert.equal(classifyFailure({ stderr: 'first\nlast words\n' }).message, 'Claude 出错了：last words');
  assert.equal(classifyFailure({ exitCode: 3 }).message, 'Claude 出错了（退出码 3）');
  assert.equal(classifyFailure({ exitCode: 0 }).message, 'Claude 出错了');
  assert.equal(classifyFailure({}).message, 'Claude 出错了');
  assert.equal(classifyFailure().message, 'Claude 出错了');
  assert.equal(classifyFailure(null).message, 'Claude 出错了');
  assert.equal(classifyFailure('boom').message, 'Claude 出错了');
});

test('fields of the wrong type do not throw', () => {
  const r = classifyFailure({ code: 5, status: 'x', text: 7, errors: [3, null, 'ok'], stderr: null, exitCode: 'n' });
  assert.equal(r.kind, 'other');
  assert.equal(r.message, 'Claude 出错了：ok');
});
