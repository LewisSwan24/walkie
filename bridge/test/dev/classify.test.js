import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVerdict, isCorrect } from '../../src/dev/classify.js';

test('a verdict is right when the intent is, and the project too when one is expected', () => {
  assert.equal(isCorrect({ intent: 'stop' }, { intent: 'stop', project: null }), true);
  assert.equal(isCorrect({ intent: 'stop' }, { intent: 'to_claude', project: null }), false);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: 'walkie' }), true);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: 'on-the-beat' }), false);
  assert.equal(isCorrect({ intent: 'switch_project', project: 'walkie' }, { intent: 'switch_project', project: null }), false);
});

test('a verdict line says how it was decided, and what was expected when it was wrong', () => {
  const right = formatVerdict({ say: '停', intent: 'stop' }, { intent: 'stop', project: null, classifiedBy: 'openai' });
  assert.equal(right, 'ok   停  ->  stop (openai)');
  const wrong = formatVerdict({ say: '切到语音助手这个项目', intent: 'switch_project', project: 'walkie' }, { intent: 'to_claude', project: null, classifiedBy: 'default' });
  assert.equal(wrong, 'BAD  切到语音助手这个项目  ->  to_claude (default), expected switch_project walkie');
});
