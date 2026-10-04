import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createConsole } from '../src/console.js';

const at = (h, m, s) => () => new Date(2026, 9, 1, h, m, s);

function make() {
  const lines = [];
  const con = createConsole({ out: (line) => lines.push(line), now: at(9, 5, 7) });
  return { con, lines };
}

test('every line starts with the time of day, to the second', () => {
  const { con, lines } = make();
  con.log('claude: starting walkie');
  assert.deepEqual(lines, ['09:05:07 claude: starting walkie']);
});

test('a reply is printed in full: its numbers, the voice text and everything Claude wrote', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'reply', voice: '测试都过了。', screen: '570 个测试通过。', text: '一共 570 个测试，\n全部通过。', tagged: true, turns: 3, ms: 12_340, costUsd: 0.0421 });
  assert.equal(lines[0], '09:05:07 [reply] walkie turn 3, 12.3 s, $0.042');
  assert.equal(lines[1], '  voice: 测试都过了。');
  assert.equal(lines.slice(2).join('\n'), '  一共 570 个测试，\n  全部通过。');
});

test('a reply that has no <voice> tag says so', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'reply', voice: '好了', screen: '好了', text: '好了', tagged: false, turns: 1, ms: 900, costUsd: 0 });
  assert.match(lines[0], /\[reply\] walkie turn 1, 0\.9 s, \$0\.000, no <voice> tag$/);
});

test('a compaction is printed as one, with what was said of it', () => {
  const { con, lines } = make();
  con.reply({ project: 'walkie', kind: 'compact', voice: '压缩完了。', screen: '压缩完了，上下文少了60%。', text: '', tagged: false, turns: 3, ms: 30_000, costUsd: 0.5 });
  assert.match(lines[0], /\[compact\] walkie, 30\.0 s, \$0\.500$/);
  assert.equal(lines[1], '  压缩完了，上下文少了60%。');
});

test('attach prints what the manager, the approvals and the link say', () => {
  const { con, lines } = make();
  const manager = new EventEmitter();
  const approvals = new EventEmitter();
  const link = new EventEmitter();
  con.attach({ manager: { on: (n, f) => manager.on(n, f) }, approvals: { on: (n, f) => approvals.on(n, f) }, link });
  manager.emit('working', { project: 'walkie', tool: null, summary: '', startedAt: 0 });
  manager.emit('working', { project: 'walkie', tool: 'Bash', summary: 'npm test', startedAt: 0 });
  manager.emit('notice', { kind: 'exited', text: 'Claude 退出了' });
  manager.emit('failure', { kind: 'login', message: '登录过期' });
  manager.emit('project', { name: 'on-the-beat' });
  approvals.emit('show', { id: 4, tool: 'Bash', preview: 'rm -rf build\nand more', toolUseId: 't' });
  approvals.emit('clear', { id: 4, outcome: 'denied' });
  link.emit('status', 'cannot open the S3 (no S3 on USB); retrying');
  link.emit('hello', { version: '0.4.0', ringBytes: 262144, upRate: 16000, downRate: 24000 });
  link.emit('log', 'screen idle');
  link.emit('down', 'no PONG for 3 s');
  assert.deepEqual(lines.map((l) => l.replace(/^\d\d:\d\d:\d\d /, '')), [
    '[working] thinking',
    '[working] Bash: npm test',
    '[notice] exited: Claude 退出了',
    '[failure] login: 登录过期',
    '[project] on-the-beat',
    '[approval] #4 Bash',
    '    rm -rf build',
    '    and more',
    '[approval] #4 denied',
    '[link] cannot open the S3 (no S3 on USB); retrying',
    '[link] walkie 0.4.0 is connected (ring 262144 bytes)',
    '[S3] screen idle',
    '[link] down: no PONG for 3 s',
  ]);
});

test('what was heard is printed with its words and where they go, and a take nobody could hear says why', () => {
  const { con, lines } = make();
  con.heard({ status: 'ok', transcript: '看一下测试', transcribedBy: 'openai', intent: 'to_claude', project: null, text: '看一下测试' });
  con.heard({ status: 'ok', transcript: '切到 walkie', transcribedBy: 'gemini', intent: 'switch_project', project: 'walkie', text: '' });
  con.heard({ status: 'ok', transcript: '你好', transcribedBy: 'openai', intent: null });
  con.heard({ status: 'ok', transcript: '继续', intent: 'continue' }); // no provider named
  con.heard({ status: 'unclear', reason: 'too-short', transcript: '' });
  assert.deepEqual(lines, [
    '09:05:07 [heard] 「看一下测试」 → to_claude (openai)',
    '09:05:07 [heard] 「切到 walkie」 → switch_project walkie (gemini)',
    '09:05:07 [heard] 「你好」 (openai)',
    '09:05:07 [heard] 「继续」 → continue',
    '09:05:07 [heard] nothing clear (too-short)',
  ]);
});
