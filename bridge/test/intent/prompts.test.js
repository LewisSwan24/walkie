import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPrompt, hearPrompt, transcriptionPrompt } from '../../src/intent/prompts.js';
import { SET_PROJECTS } from '../fixtures/utterances.js';

const projects = SET_PROJECTS;

test('the transcription prompt lists every project name and alias and the technical words', () => {
  const p = transcriptionPrompt(projects);
  for (const word of ['on-the-beat', '手环项目', 'on the beat', 'verbatim', 'fencepost', 'walkie', '语音助手', 'Claude', 'npm', 'git', 'commit', 'PlatformIO']) {
    assert.ok(p.includes(word), word);
  }
  assert.equal(p.split('on-the-beat').length, 2, 'a word that is both a project and a term is listed once');
});

test('the classification prompt carries the rule, the project table and the state', () => {
  const p = classifyPrompt({ projects, currentProject: 'walkie', busy: true });
  assert.ok(p.includes('only when the WHOLE utterance is that command'));
  assert.ok(p.includes('intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.'));
  assert.ok(p.includes('Projects (name: aliases): on-the-beat: 手环项目, on the beat; verbatim; fencepost; walkie: 语音助手.'));
  assert.ok(p.includes('Current project: walkie. Claude is working.'));
  assert.ok(classifyPrompt({ projects }).includes('Current project: none. Claude is idle.'));
});

test('the prompt Gemini hears with classifies only when asked to', () => {
  const both = hearPrompt({ projects, currentProject: 'walkie' });
  assert.ok(both.includes('Transcribe the audio verbatim'));
  assert.ok(both.includes('Classify the WHOLE utterance'));
  assert.ok(both.includes('Current project: walkie. Claude is idle.'));
  const only = hearPrompt({ projects, classify: false });
  assert.ok(only.includes('Transcribe the audio verbatim'));
  assert.ok(!only.includes('intent'));
  assert.ok(only.includes('transcript only'));
});
