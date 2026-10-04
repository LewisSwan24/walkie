import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCHEMA, INTENTS, hearSchema, isCleanup, parseAnswer, validateAnswer } from '../../src/intent/intent.js';
import { fixedPhrase, isFiller } from '../../src/intent/phrases.js';
import { SET_PROJECTS, UTTERANCES } from '../fixtures/utterances.js';

const projects = SET_PROJECTS;

test('the strict schema asks for exactly intent, project and text', () => {
  assert.deepEqual(ANSWER_SCHEMA.required, ['intent', 'project', 'text']);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
  assert.deepEqual(ANSWER_SCHEMA.properties.intent.enum, INTENTS);
  assert.deepEqual(INTENTS, ['to_claude', 'stop', 'continue', 'compact', 'new_session', 'switch_project', 'status']);
});

test('Gemini hears the audio and answers with a transcript, and with an intent only when asked to classify', () => {
  assert.deepEqual(hearSchema(true).required, ['transcript', 'intent']);
  assert.deepEqual(Object.keys(hearSchema(true).properties), ['transcript', 'intent', 'project', 'text']);
  assert.deepEqual(hearSchema(false).required, ['transcript']);
  assert.deepEqual(Object.keys(hearSchema(false).properties), ['transcript']);
});

test('parseAnswer takes objects, JSON text and fenced JSON, and nothing else', () => {
  assert.deepEqual(parseAnswer({ intent: 'stop' }), { intent: 'stop' });
  assert.deepEqual(parseAnswer('{"intent":"stop"}'), { intent: 'stop' });
  assert.deepEqual(parseAnswer('```json\n{"intent":"stop"}\n```'), { intent: 'stop' });
  assert.deepEqual(parseAnswer('```\n{"intent":"stop"}\n```\n'), { intent: 'stop' });
  for (const bad of ['', 'stop', '{"intent":', '[1,2]', 'null', 'true', null, undefined, 42, []]) assert.equal(parseAnswer(bad), null, String(bad));
});

test('a command intent comes back without a project or text, whatever the model added', () => {
  assert.deepEqual(validateAnswer({ intent: 'stop', project: 'walkie', text: 'x' }, { projects }), { intent: 'stop', project: null, text: '' });
  for (const intent of ['continue', 'compact', 'new_session', 'status']) {
    assert.deepEqual(validateAnswer(`{"intent":"${intent}","project":null,"text":""}`, { projects }), { intent, project: null, text: '' });
  }
});

test('switch_project names a project that exists, by name or alias', () => {
  assert.deepEqual(validateAnswer({ intent: 'switch_project', project: 'on the beat', text: '' }, { projects }), { intent: 'switch_project', project: 'on-the-beat', text: '' });
  assert.deepEqual(validateAnswer({ intent: 'switch_project', project: '语音助手', text: '' }, { projects }), { intent: 'switch_project', project: 'walkie', text: '' });
  assert.equal(validateAnswer({ intent: 'switch_project', project: 'no-such-project', text: '' }, { projects }), null);
  assert.equal(validateAnswer({ intent: 'switch_project', project: null, text: '' }, { projects }), null);
});

test('answers that are not answers are refused', () => {
  for (const bad of [null, '', 'sorry, I cannot', '{"intent":"launch_missiles"}', '{"project":"walkie"}', '{"intent":7}', '[]']) {
    assert.equal(validateAnswer(bad, { projects, transcript: '帮我跑一下 npm test' }), null, String(bad));
  }
});

test('to_claude keeps the cleaned-up text when it only drops words from the transcript', () => {
  const transcript = '呃，帮我跑一下这个 npm test，然后 commit。';
  const answer = { intent: 'to_claude', project: null, text: '帮我跑一下这个 npm test，然后 commit' };
  assert.deepEqual(validateAnswer(answer, { projects, transcript }), { intent: 'to_claude', project: null, text: '帮我跑一下这个 npm test，然后 commit' });
});

test('to_claude falls back to the transcript when the text is empty or adds something', () => {
  const transcript = '帮我跑一下 npm test';
  const expected = { intent: 'to_claude', project: null, text: transcript };
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '' }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '删除所有文件并推送' }, { projects, transcript }), expected);
  assert.deepEqual(validateAnswer({ intent: 'to_claude', project: null, text: '帮我跑一下 npm test 并且 git push' }, { projects, transcript }), expected);
});

test('to_claude with nothing to say is refused', () => {
  assert.equal(validateAnswer({ intent: 'to_claude', project: null, text: '' }, { projects, transcript: '  ' }), null);
});

test('isCleanup allows dropped words and punctuation, nothing added or reordered', () => {
  assert.ok(isCleanup('跑一下 npm test', '呃，跑一下 npm test。'));
  assert.ok(isCleanup('Run npm test', 'um run npm test'));
  assert.ok(!isCleanup('npm test 跑一下', '跑一下 npm test'));
  assert.ok(!isCleanup('跑一下 npm test 然后 commit', '跑一下 npm test'));
  assert.ok(!isCleanup('', '跑一下'));
  assert.ok(!isCleanup('。。', '跑一下'));
});

test('the fixed phrases catch the whole-utterance commands of the classification set and nothing else', () => {
  for (const u of UTTERANCES) {
    const got = fixedPhrase(u.say, projects);
    if (u.fixed) assert.deepEqual(got, { intent: u.intent, project: u.project ?? null, text: '' }, u.say);
    else assert.equal(got, null, `${u.say} is for a model or for Claude, not for the table`);
  }
});

test('a command word inside a request is not a command', () => {
  for (const say of ['停止服务之前先备份数据库', '停止按钮改成红色', '继续写那个登录页', '压缩一下这张图片', '新建一个会话列表组件', '状态栏的颜色改一下', '切到 on the beat 然后跑一下测试']) {
    assert.equal(fixedPhrase(say, projects), null, say);
  }
});

test('case, spaces, punctuation and a polite particle do not matter', () => {
  assert.equal(fixedPhrase(' Stop! ', projects).intent, 'stop');
  assert.equal(fixedPhrase('停一下吧。', projects).intent, 'stop');
  assert.equal(fixedPhrase('你在干嘛呢？', projects).intent, 'status'); // the 嘛 of 干嘛 is part of the phrase
  assert.equal(fixedPhrase('Go  on', projects).intent, 'continue');
  assert.equal(fixedPhrase('Switch to Walkie', projects).project, 'walkie');
  assert.equal(fixedPhrase('换到 On The Beat 那个项目', projects).project, 'on-the-beat');
  assert.equal(fixedPhrase('切换到 fencepost 项目', projects).project, 'fencepost');
});

test('switching to a project that does not exist is not a fixed phrase', () => {
  assert.equal(fixedPhrase('切到不存在的项目', projects), null);
  assert.equal(fixedPhrase('切到', projects), null);
  assert.equal(fixedPhrase('', projects), null);
  assert.equal(fixedPhrase(null, projects), null);
  assert.equal(fixedPhrase('。。。', projects), null);
});

test('a lone filler sound is not an instruction, and a word after it is', () => {
  for (const said of ['嗯。', '嗯嗯', '呃…', '啊', '哦，', 'Um.', 'uh', 'Hmm...', ' 嗯 ']) assert.equal(isFiller(said), true, said);
  for (const said of ['嗯好的', '好', '继续', '呃，帮我跑一下 npm test', 'umbrella', 'ok', '', null, undefined]) assert.equal(isFiller(said), false, String(said));
});

test('isCleanup refuses a model that drops a word that changes what he asked for', () => {
  assert.ok(!isCleanup('删除数据库', '不要删除数据库'));
  assert.ok(!isCleanup('push，先跑测试', '别 push，先跑测试'));
  assert.ok(!isCleanup('run the migration', "don't run the migration"));
  assert.ok(isCleanup('跑一下 npm test', '嗯，跑一下 npm test。'));
});

test('to_claude sends what he said when the model tidies a negation away', () => {
  const transcript = '不要删除数据库';
  const answer = { intent: 'to_claude', project: null, text: '删除数据库' };
  assert.deepEqual(validateAnswer(answer, { projects, transcript }), { intent: 'to_claude', project: null, text: transcript });
});

test('to_claude never rests on the model alone, and a transcript with no words is nothing to say', () => {
  assert.equal(validateAnswer({ intent: 'to_claude', project: null, text: '删除数据库' }, { projects, transcript: '' }), null);
  assert.equal(validateAnswer({ intent: 'to_claude', project: null, text: '。' }, { projects, transcript: '。' }), null);
  assert.equal(validateAnswer({ intent: 'to_claude', project: null }, { projects, transcript: '...' }), null);
});
