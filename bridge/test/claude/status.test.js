import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUMMARY, spokenElapsed, statusText, toolSummary } from '../../src/claude/status.js';

test('a file tool shows the name of the file, whichever way the path is written', () => {
  assert.equal(toolSummary('Write', { file_path: 'C:\\proj\\src\\note.txt', content: 'x' }), 'note.txt');
  assert.equal(toolSummary('Read', { file_path: '/home/me/proj/a.js' }), 'a.js');
  assert.equal(toolSummary('Edit', { file_path: 'C:\\proj\\' }), 'proj');
  assert.equal(toolSummary('NotebookEdit', { notebook_path: 'D:\\n\\x.ipynb' }), 'x.ipynb');
});

test('Bash shows its description when it has one, otherwise the first line of the command', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run the tests' }), 'Run the tests');
  assert.equal(toolSummary('Bash', { command: '\n  \ngit status\ngit diff' }), 'git status');
  assert.equal(toolSummary('Bash', { command: 'a\tb   c' }), 'a b c');
  assert.equal(toolSummary('PowerShell', { command: 'Get-Date' }), 'Get-Date');
  assert.equal(toolSummary('Bash', { command: '' }), '');
});

test('search tools show what they search for, the web tools the host or the query', () => {
  assert.equal(toolSummary('Grep', { pattern: 'TODO|FIXME', path: 'src' }), 'TODO|FIXME');
  assert.equal(toolSummary('Glob', { pattern: '**/*.test.js' }), '**/*.test.js');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a/b?c=d', prompt: 'x' }), 'example.com');
  assert.equal(toolSummary('WebFetch', { url: 'not a url' }), 'not a url');
  assert.equal(toolSummary('WebSearch', { query: 'node test runner' }), 'node test runner');
});

test('a tool it does not know shows the first thing in its input that says something', () => {
  assert.equal(toolSummary('Agent', { description: 'Find the callers', prompt: 'long' }), 'Find the callers');
  assert.equal(toolSummary('mcp__x__y', { prompt: 'just this' }), 'just this');
  assert.equal(toolSummary('mcp__x__y', { n: 3 }), '');
});

test('input of any shape gives a string, and no more than the limit, cut by characters and marked', () => {
  for (const input of [undefined, null, 5, 'str', [], {}, { file_path: 7 }, { command: ['a'] }]) {
    assert.equal(toolSummary('Bash', input), '', JSON.stringify(input));
    assert.equal(toolSummary('Write', input), '', JSON.stringify(input));
  }
  assert.equal(MAX_SUMMARY, 40);
  const long = toolSummary('Bash', { description: 'x'.repeat(100) });
  assert.equal(long, `${'x'.repeat(39)}…`);
  assert.equal(toolSummary('Bash', { description: 'y'.repeat(40) }), 'y'.repeat(40));
  assert.equal(toolSummary('Bash', { description: 'z'.repeat(41) }), `${'z'.repeat(39)}…`);
  assert.equal(toolSummary('Bash', { description: '运行所有的测试并把结果告诉我' }, 6), '运行所有的…');
  assert.equal(toolSummary('Bash', { description: '😀'.repeat(10) }, 4), '😀😀😀…', 'an emoji is one character, not half of one');
});

test('a time is read aloud in seconds, minutes and hours, and nothing else gives zero', () => {
  const t = (...a) => spokenElapsed(a.reduce((sum, v, i) => sum + v * [3600000, 60000, 1000][i], 0));
  assert.equal(spokenElapsed(0), '0秒');
  assert.equal(spokenElapsed(999), '0秒');
  assert.equal(spokenElapsed(45_000), '45秒');
  assert.equal(spokenElapsed(59_999), '59秒');
  assert.equal(spokenElapsed(60_000), '1分钟');
  assert.equal(t(0, 2, 15), '2分15秒');
  assert.equal(t(0, 59, 59), '59分59秒');
  assert.equal(t(1, 0, 0), '1小时');
  assert.equal(t(1, 5, 30), '1小时5分钟');
  assert.equal(t(25, 0, 0), '25小时');
  for (const bad of [-5, NaN, Infinity, undefined, null, '12']) assert.equal(spokenElapsed(bad), '0秒', String(bad));
});

const base = { project: 'walkie', running: true, busy: false, tool: '', summary: '', elapsedMs: null, turns: 0, resumable: false };

test('no process: it says so, and whether the last conversation will be picked up again', () => {
  assert.equal(statusText({ ...base, running: false, resumable: true }), 'walkie没在运行，上次的对话还在，说话就接着做。');
  assert.equal(statusText({ ...base, running: false }), 'walkie没在运行，说话就开始新对话。');
});

test('a process with nothing to do says it waits, and after work says how much it did and how long the last turn took', () => {
  assert.equal(statusText(base), 'walkie已经待命，等你说话。');
  assert.equal(statusText({ ...base, turns: 3, elapsedMs: 135_000 }), 'walkie空闲，这个对话做了3轮，上一轮用了2分15秒。');
  assert.equal(statusText({ ...base, turns: 3, elapsedMs: null }), 'walkie空闲，这个对话做了3轮。');
});

test('a turn under way says what the last tool is doing, how long it has gone on and which turn it is', () => {
  assert.equal(statusText({ ...base, busy: true, tool: 'Bash', summary: 'Run the tests', elapsedMs: 135_000, turns: 3 }), 'walkie在忙，在用Bash：Run the tests，已经2分15秒，这是第3轮。');
  assert.equal(statusText({ ...base, busy: true, tool: 'Read', elapsedMs: 4000, turns: 1 }), 'walkie在忙，在用Read，已经4秒，这是第1轮。');
  assert.equal(statusText({ ...base, busy: true, elapsedMs: 800, turns: 1 }), 'walkie在忙，还在想，已经0秒，这是第1轮。');
});
