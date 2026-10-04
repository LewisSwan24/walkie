import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeard } from '../../src/dev/hear.js';

const ok = { status: 'ok', transcribedBy: 'openai', classifiedBy: 'openai', project: null, text: '', ms: { transcribe: 1234, classify: 567 } };

test('a command shows the words, who heard them, the intent and who decided it', () => {
  const heard = { ...ok, transcript: '换到 on the beat 那个项目。', intent: 'switch_project', project: 'on-the-beat' };
  assert.deepEqual(formatHeard(heard), ['transcript: 「换到 on the beat 那个项目。」 (openai, 1.2 s)', 'intent: switch_project -> on-the-beat (openai, 0.6 s)']);
});

test('work for Claude also shows what would be sent', () => {
  const heard = { ...ok, transcript: '嗯 帮我跑一下 npm test', intent: 'to_claude', text: '帮我跑一下 npm test', transcribedBy: 'gemini', classifiedBy: 'default' };
  assert.deepEqual(formatHeard(heard), ['transcript: 「嗯 帮我跑一下 npm test」 (gemini, 1.2 s)', 'intent: to_claude (default, 0.6 s)', 'to Claude: 「帮我跑一下 npm test」']);
});

test('an approval reason is transcribed and never classified', () => {
  const heard = { ...ok, transcript: '因为接口要向后兼容', intent: null, classifiedBy: null, ms: { transcribe: 900, classify: null } };
  assert.deepEqual(formatHeard(heard), ['transcript: 「因为接口要向后兼容」 (openai, 0.9 s)', 'not classified']);
});

test('a clip that goes nowhere says why, and what the device would do', () => {
  for (const [reason, why] of [['too-short', 'the clip is too short'], ['empty', 'nothing was transcribed'], ['unavailable', 'no provider could transcribe it']]) {
    assert.deepEqual(formatHeard({ status: 'unclear', reason, transcript: '' }), [`unclear: ${why}. The device would say 「没听清，再说一次」 and send nothing.`]);
  }
});
