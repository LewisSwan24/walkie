import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_RULES, extractVoice, stripMarkdown } from '../../src/claude/voice.js';

test('a reply that ends with a voice line speaks that line and keeps the rest for the screen', () => {
  // the first reply of the live run of 1 Oct 2026, word for word
  const reply = '你好，很高兴见到你，今天有什么可以帮你的吗？\n\n<voice>你好，很高兴见到你，今天有什么可以帮你的吗？</voice>';
  assert.deepEqual(extractVoice(reply), {
    voice: '你好，很高兴见到你，今天有什么可以帮你的吗？',
    screen: '你好，很高兴见到你，今天有什么可以帮你的吗？',
    tagged: true,
  });
});

test('the screen text keeps its markdown and loses only the voice block', () => {
  const out = extractVoice('It printed `walkie`.\n\n<voice>It printed the word walkie.</voice>');
  assert.equal(out.voice, 'It printed the word walkie.');
  assert.equal(out.screen, 'It printed `walkie`.');
});

test('the last of several voice blocks is the one spoken', () => {
  const out = extractVoice('<voice>first</voice> some text <voice>second</voice>');
  assert.equal(out.voice, 'second');
  assert.equal(out.screen, '<voice>first</voice> some text');
});

test('a voice block cut off before its closing tag is still spoken', () => {
  const out = extractVoice('Done with the edit.\n<voice>改好了，测试也通过了');
  assert.equal(out.voice, '改好了，测试也通过了');
  assert.equal(out.screen, 'Done with the edit.');
  assert.equal(out.tagged, true);
});

test('the tag is found in any case and with line breaks inside it', () => {
  assert.equal(extractVoice('x <VOICE>\n  hello\n  there\n</Voice>').voice, 'hello there');
});

test('markdown inside the voice block is removed', () => {
  assert.equal(extractVoice('<voice>I ran **npm test** and `all` of it [passed](https://example.com/x).</voice>').voice, 'I ran npm test and all of it passed.');
});

test('a voice line longer than 160 characters is cut at a sentence end in its back half', () => {
  const sentence = '这是一句比较长的话，用来把声音那一行撑过上限。';
  const text = sentence.repeat(10);
  const out = extractVoice(`<voice>${text}</voice>`).voice;
  assert.ok(out.length <= 160, `got ${out.length} characters`);
  assert.ok(out.endsWith('。'), 'it ends where a sentence ends');
});

test('a voice line with no sentence end is cut on the spot at 160 characters', () => {
  const out = extractVoice(`<voice>${'啊'.repeat(400)}</voice>`).voice;
  assert.equal(out.length, 160);
});

test('an empty voice block falls back to the first sentence of the reply', () => {
  const out = extractVoice('The build is green. Nothing else to do.\n<voice>  </voice>');
  assert.equal(out.voice, 'The build is green.');
  assert.equal(out.tagged, false);
});

test('with no tag, the first sentence is spoken with its markdown stripped', () => {
  const out = extractVoice('I **fixed** the bug in `parse.js`. Then I ran the tests.');
  assert.deepEqual(out, { voice: 'I fixed the bug in parse.js.', screen: 'I **fixed** the bug in `parse.js`. Then I ran the tests.', tagged: false });
});

test('with no tag, the first sentence is cut to 60 characters when it runs on', () => {
  const out = extractVoice(`${'word '.repeat(40)}end.`).voice;
  assert.equal(out.length <= 60, true);
  assert.ok(out.length > 40, 'it keeps most of the 60');
  const zh = extractVoice('我'.repeat(100)).voice;
  assert.equal(zh.length, 60);
});

test('with no tag, a Chinese reply is spoken up to its first full stop', () => {
  assert.equal(extractVoice('测试全部通过了。我还顺手改了注释。').voice, '测试全部通过了。');
});

test('with no tag, a reply that starts with a code block is spoken from the first line outside it', () => {
  const reply = '```js\nconst x = 1;\n```\nThat is the whole change. It is small.';
  assert.equal(extractVoice(reply).voice, 'That is the whole change.');
});

test('a dotted file name does not end the first sentence', () => {
  assert.equal(extractVoice('Edited voice.js and added a test. Done.').voice, 'Edited voice.js and added a test.');
});

test('a code block inside the voice block is not read out', () => {
  assert.equal(extractVoice('<voice>Run it:\n```\nls -la\n```\nthen look.</voice>').voice, 'Run it: then look.');
});

test('headings, bullets and quotes lose their markers when read out', () => {
  assert.equal(extractVoice('## Result\n- all green').voice, 'Result');
  assert.equal(stripMarkdown('> quoted\n1. first\n* second'), 'quoted first second');
});

test('URLs are not read out and snake_case words keep their underscores', () => {
  assert.equal(stripMarkdown('see https://example.com/a?b=1 for my_var_name'), 'see for my_var_name');
});

test('an empty reply, or no reply, gives an empty voice', () => {
  assert.deepEqual(extractVoice(''), { voice: '', screen: '', tagged: false });
  assert.deepEqual(extractVoice(undefined), { voice: '', screen: '', tagged: false });
});

test('a reply that is only a code block has nothing to say', () => {
  assert.equal(extractVoice('```\nls -la\n```').voice, '');
});

test('the rules Claude is given name the tag the code looks for', () => {
  assert.match(VOICE_RULES, /<voice>.*<\/voice>/);
  assert.ok(!VOICE_RULES.includes('\n'), 'one paragraph: it is a command line argument');
});
