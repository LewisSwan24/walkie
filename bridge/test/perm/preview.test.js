import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PREVIEW, previewOf } from '../../src/perm/preview.js';

test('a Bash call shows its command', () => {
  assert.equal(previewOf('Bash', { command: 'npm test', description: 'x' }), 'npm test');
  assert.equal(previewOf('PowerShell', { command: 'Get-Date' }), 'Get-Date');
  assert.equal(previewOf('Bash', { command: 'a\nb' }), 'a\nb');
});

test('a long command shows its head and its tail, so that the end cannot hide', () => {
  const command = `${'echo harmless; '.repeat(40)}rm -rf ~/important`;
  const shown = previewOf('Bash', { command });
  assert.equal(Array.from(shown).length, MAX_PREVIEW);
  assert.ok(shown.startsWith('echo harmless; echo'));
  assert.ok(shown.endsWith('rm -rf ~/important'));
  assert.ok(shown.includes(' … '));
  assert.equal(MAX_PREVIEW, 300);
});

test('a command of exactly the limit is shown whole, and one character more is cut', () => {
  assert.equal(previewOf('Bash', { command: 'x'.repeat(300) }), 'x'.repeat(300));
  const cutOne = previewOf('Bash', { command: 'x'.repeat(301) });
  assert.equal(Array.from(cutOne).length, 300);
  assert.match(cutOne, /^x+ … x+$/);
});

test('a cut command is two thirds head and one third tail', () => {
  const shown = previewOf('Bash', { command: 'H'.repeat(300) + 'T'.repeat(300) });
  assert.equal(shown, `${'H'.repeat(197)} … ${'T'.repeat(100)}`);
});

test('the limit can be changed, and a silly one is raised to something that can be read', () => {
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(100) }, 50)).length, 50);
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(100) }, 2)).length, 10);
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(400) }, NaN)).length, 300);
});

test('it is cut by characters, not by UTF-16 units', () => {
  const shown = previewOf('Bash', { command: '😀'.repeat(400) });
  assert.equal(Array.from(shown).length, 300);
  assert.ok(Array.from(shown).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no half of an emoji');
});

// Built from their code points, not written as \u escapes: the tools that write this plan scrub those escapes out of a file.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

test('control, zero-width and direction characters show as a dot, and the break between lines stays', () => {
  const shown = previewOf('Bash', { command: `ec${ZERO_WIDTH_SPACE}ho${RIGHT_TO_LEFT_OVERRIDE} hi\x07\r\nnext\tline\x1b[31m` });
  assert.equal(shown, 'ec·ho· hi·\nnext line·[31m');
  for (const hidden of [ZERO_WIDTH_SPACE, RIGHT_TO_LEFT_OVERRIDE, '\x07', '\x1b', '\r', '\t']) assert.ok(!shown.includes(hidden), JSON.stringify(hidden));
});

test('a Write shows the path, how long the content is, and its beginning', () => {
  const shown = previewOf('Write', { file_path: 'C:\\proj\\note.txt', content: 'hello walkie' });
  assert.equal(shown, 'C:\\proj\\note.txt\n12 字\nhello walkie');
  const long = previewOf('Write', { file_path: 'a.txt', content: 'z'.repeat(1000) });
  assert.match(long, /^a\.txt\n1000 字\nz+ … z+$/);
  assert.equal(Array.from(long.split('\n')[2]).length, 140);
  assert.equal(previewOf('Write', { file_path: 'a.txt', content: '一二三' }).split('\n')[1], '3 字');
  assert.equal(previewOf('Write', { file_path: 'a.txt', content: '😀😀' }).split('\n')[1], '2 字', 'an emoji is one character');
  assert.equal(previewOf('Write', { file_path: 'a.txt' }).split('\n')[1], '0 字');
});

test('an Edit shows the path and what is taken out and put in', () => {
  assert.equal(previewOf('Edit', { file_path: 'src/a.js', old_string: 'foo()', new_string: 'bar()' }), 'src/a.js\n- foo()\n+ bar()');
  const long = previewOf('Edit', { file_path: 'a.js', old_string: 'o'.repeat(500), new_string: 'n'.repeat(500) });
  const [, minus, plus] = long.split('\n');
  assert.ok(minus.startsWith('- o') && minus.includes(' … ') && plus.startsWith('+ n') && plus.includes(' … '));
  assert.equal(Array.from(minus).length, 102);
  assert.equal(Array.from(plus).length, 102);
});

test('a long path shows its beginning and its end, which has the file name', () => {
  const file_path = `C:\\${'folder\\'.repeat(30)}the-file.txt`;
  const shown = previewOf('Write', { file_path, content: 'x' }).split('\n')[0];
  assert.ok(shown.startsWith('C:\\folder') && shown.endsWith('the-file.txt') && shown.includes(' … '));
  assert.equal(Array.from(shown).length, 120);
});

test('the other tools show the one thing that matters about them', () => {
  assert.equal(previewOf('MultiEdit', { file_path: 'a.js', edits: [{}, {}, {}] }), 'a.js\n3 处修改');
  assert.equal(previewOf('MultiEdit', { file_path: 'a.js' }), 'a.js\n0 处修改');
  assert.equal(previewOf('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(previewOf('WebFetch', { url: 'https://example.com/x', prompt: 'p' }), 'https://example.com/x');
  assert.equal(previewOf('WebSearch', { query: 'node test runner' }), 'node test runner');
  assert.equal(previewOf('Task', { description: 'Find the callers', prompt: 'p' }), 'Find the callers');
  assert.equal(previewOf('Agent', { description: 'Look around' }), 'Look around');
});

test('a tool it does not know, or a call with nothing in it that can be shown, shows the input itself', () => {
  assert.equal(previewOf('mcp__codegraph__codegraph_search', { query: 'foo', limit: 5 }), '{"query":"foo","limit":5}');
  assert.equal(previewOf('Bash', { command: 7 }), '{"command":7}');
  assert.equal(previewOf('Bash', { command: '  \n ' }), '{"command":"  \\n "}');
  assert.equal(previewOf('Bash', { command: ZERO_WIDTH_SPACE + ZERO_WIDTH_SPACE }), '{"command":"··"}');
  assert.equal(previewOf('Write', { content: 'x' }), '{"content":"x"}', 'a Write with no path is shown as it came');
  assert.equal(previewOf('Edit', { old_string: 'a', new_string: 'b' }), '{"old_string":"a","new_string":"b"}');
  for (const input of [undefined, null, 5, 'str']) {
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'Agent', 'Other']) assert.equal(previewOf(tool, input), '{}', `${tool} ${input}`);
  }
  assert.equal(previewOf('Bash', []), '[]');
});
