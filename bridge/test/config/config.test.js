import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, defaultConfigFile, loadConfig } from '../../src/config/config.js';

const fileWith = (object) => ({ read: () => JSON.stringify(object) });
const missing = () => {
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
const shape = (o) => Object.entries(o).map(([k, v]) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? [k, shape(v)] : k));

test('without a config file every setting has its default', () => {
  assert.deepEqual(loadConfig({ read: missing }), DEFAULT_CONFIG);
});

test('the spec numbers are the defaults', () => {
  assert.equal(DEFAULT_CONFIG.models.transcribe, 'gpt-transcribe');
  assert.equal(DEFAULT_CONFIG.models.classify, 'gpt-6-luna');
  assert.equal(DEFAULT_CONFIG.models.classifyEffort, 'none');
  assert.equal(DEFAULT_CONFIG.models.tts, 'gpt-4o-mini-tts');
  assert.deepEqual(DEFAULT_CONFIG.models.geminiHear, ['gemini-3.8-flash', 'gemini-3.1-flash-lite']);
  assert.equal(DEFAULT_CONFIG.models.geminiTts, 'gemini-3.8-flash-tts');
  assert.equal(DEFAULT_CONFIG.voice, 'marin');
  assert.deepEqual(DEFAULT_CONFIG.timeoutsMs, { transcribeBase: 3000, classify: 3500, speakFirstByte: 3000, speakIdle: 3000, geminiHear: 8000, geminiSpeak: 10000 });
  assert.equal(DEFAULT_CONFIG.transcribeClipFraction, 0.1);
  assert.equal(DEFAULT_CONFIG.trimStartMs, 250);
  assert.equal(DEFAULT_CONFIG.minSpeechMs, 300);
  assert.equal(DEFAULT_CONFIG.cooldownMs, 5 * 60 * 1000);
  assert.deepEqual(
    { ...DEFAULT_CONFIG.loudness, makeupDb: 0 },
    { highpassHz: 300, thresholdDb: -34, ratio: 12, attackMs: 1, releaseMs: 40, makeupDb: 0, ceiling: 0.98, lookaheadMs: 5 },
  );
});

test('the claude defaults are the ones measured with the real claude on 1 Oct 2026', () => {
  assert.deepEqual(DEFAULT_CONFIG.claude, { command: ['claude'], model: 'claude-opus-5-5', idleMinutes: 60, approvalTimeoutSec: 55, prewarm: true });
  assert.ok(DEFAULT_CONFIG.claude.approvalTimeoutSec < 60, "claude's MCP client drops a pending request at about 60 s");
});

test('the committed bridge/config.json is valid and lists every setting', () => {
  const text = readFileSync(defaultConfigFile(), 'utf8');
  assert.deepEqual(shape(JSON.parse(text)), shape(DEFAULT_CONFIG));
  assert.doesNotThrow(() => loadConfig());
});

test('a file overrides single settings and leaves the rest alone', () => {
  const c = loadConfig(fileWith({ voice: 'cedar', timeoutsMs: { classify: 5000 }, loudness: { makeupDb: 24 } }));
  assert.equal(c.voice, 'cedar');
  assert.equal(c.timeoutsMs.classify, 5000);
  assert.equal(c.timeoutsMs.transcribeBase, 3000);
  assert.equal(c.loudness.makeupDb, 24);
  assert.equal(c.loudness.ratio, 12);
});

test('the claude settings can be overridden, the command as a list', () => {
  const c = loadConfig(fileWith({ claude: { command: ['node', 'fake-claude.js'], model: 'claude-sonnet-5-5', prewarm: false, idleMinutes: 5 } }));
  assert.deepEqual(c.claude, { command: ['node', 'fake-claude.js'], model: 'claude-sonnet-5-5', idleMinutes: 5, approvalTimeoutSec: 55, prewarm: false });
});

test('a setting the code does not know is an error that names it', () => {
  assert.throws(() => loadConfig(fileWith({ voce: 'cedar' })), /unknown setting voce/);
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { clasify: 1 } })), /unknown setting timeoutsMs\.clasify/);
});

test('a setting of the wrong type is an error', () => {
  assert.throws(() => loadConfig(fileWith({ voice: 7 })), /voice must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ voice: '' })), /voice must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { classify: '3500' } })), /timeoutsMs\.classify must be a number/);
  assert.throws(() => loadConfig(fileWith({ models: { geminiHear: 'gemini-3.8-flash' } })), /models\.geminiHear must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ models: { geminiHear: [] } })), /models\.geminiHear must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ loudness: 5 })), /loudness must be an object/);
  assert.throws(() => loadConfig(fileWith({ claude: { prewarm: 'yes' } })), /claude\.prewarm must be true or false/);
  assert.throws(() => loadConfig(fileWith({ claude: { prewarm: 1 } })), /claude\.prewarm must be true or false/);
  assert.throws(() => loadConfig(fileWith({ claude: { command: 'claude' } })), /claude\.command must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ claude: { command: [] } })), /claude\.command must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ claude: { model: '' } })), /claude\.model must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ claude: { idleMinutes: '60' } })), /claude\.idleMinutes must be a number/);
});

test('numbers outside their range are errors that show the value', () => {
  assert.throws(() => loadConfig(fileWith({ timeoutsMs: { classify: 0 } })), /timeoutsMs\.classify must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ loudness: { ratio: 0.5 } })), /loudness\.ratio must be 1 or more/);
  assert.throws(() => loadConfig(fileWith({ loudness: { ceiling: 1.5 } })), /loudness\.ceiling/);
  assert.throws(() => loadConfig(fileWith({ transcribeClipFraction: 2 })), /transcribeClipFraction/);
  assert.throws(() => loadConfig(fileWith({ cooldownMs: -1 })), /cooldownMs/);
  assert.throws(() => loadConfig(fileWith({ claude: { idleMinutes: 0 } })), /claude\.idleMinutes must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ claude: { approvalTimeoutSec: 0 } })), /claude\.approvalTimeoutSec must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ claude: { approvalTimeoutSec: -5 } })), /claude\.approvalTimeoutSec must be more than 0/);
});

test('a file that is not JSON is an error that names the file but not its content', () => {
  assert.throws(
    () => loadConfig({ file: 'C:/x/config.json', read: () => '{ "voice": "secret-ish", ' }),
    (err) => err.message.includes('C:/x/config.json') && err.message.includes('not valid JSON') && !err.message.includes('secret-ish'),
  );
});

test('an unreadable config file is an error', () => {
  const read = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => loadConfig({ file: 'C:/x/config.json', read }), /cannot read the config file C:\/x\/config\.json \(EACCES\)/);
});
