// bridge/config.json: voice, models, timeouts and loudness settings (spec 6.3). Every setting has a default here,
// the file only overrides, and a setting the code does not know is an error, so a typo cannot pass silently.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LOUDNESS } from '../speech/loudness.js';

export const DEFAULT_CONFIG = {
  voice: 'marin',
  geminiVoice: 'Kore',
  ttsInstructions: '用自然、亲切、简洁的普通话说，语速稍快。',
  models: {
    transcribe: 'gpt-transcribe',
    classify: 'gpt-6-luna',
    classifyEffort: 'none',
    tts: 'gpt-4o-mini-tts',
    geminiHear: ['gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    geminiTts: 'gemini-3.8-flash-tts',
  },
  timeoutsMs: {
    transcribeBase: 3000, // plus transcribeClipFraction of the clip's length
    classify: 3500,
    speakFirstByte: 3000,
    speakIdle: 3000, // the longest silence tolerated between two chunks of a streaming reply
    geminiHear: 8000, // per model
    geminiSpeak: 10000,
  },
  transcribeClipFraction: 0.1,
  trimStartMs: 250, // the mic's start-up transient
  minSpeechMs: 300,
  cooldownMs: 300_000, // a provider that fails is skipped this long
  loudness: { ...DEFAULT_LOUDNESS },
  claude: {
    command: ['claude'], // the program, then any arguments that go before the ones walkie adds
    model: 'claude-opus-5-5',
    idleMinutes: 60, // a process with nothing to do this long has its stdin closed; the next message resumes the session
    approvalTimeoutSec: 55, // claude's MCP client drops a pending request after about 60 s (measured 1 Oct 2026): answer first
    prewarm: true, // start claude with the bridge and after a switch, so the first message does not wait for it to boot (about 20 s)
  },
};

// Checks on the merged settings, by dotted path. `*` stands for any key of that group.
const RULES = [
  ['timeoutsMs.*', (v) => v > 0, 'must be more than 0'],
  ['transcribeClipFraction', (v) => v >= 0 && v <= 1, 'must be between 0 and 1'],
  ['trimStartMs', (v) => v >= 0, 'must be 0 or more'],
  ['minSpeechMs', (v) => v >= 0, 'must be 0 or more'],
  ['cooldownMs', (v) => v >= 0, 'must be 0 or more'],
  ['loudness.highpassHz', (v) => v > 0 && v < 12000, 'must be between 0 and 12000'],
  ['loudness.ratio', (v) => v >= 1, 'must be 1 or more'],
  ['loudness.attackMs', (v) => v > 0, 'must be more than 0'],
  ['loudness.releaseMs', (v) => v > 0, 'must be more than 0'],
  ['loudness.ceiling', (v) => v > 0 && v <= 1, 'must be more than 0 and at most 1'],
  ['loudness.lookaheadMs', (v) => v >= 0, 'must be 0 or more'],
  ['claude.idleMinutes', (v) => v > 0, 'must be more than 0'],
  ['claude.approvalTimeoutSec', (v) => v > 0, 'must be more than 0'],
];

export function defaultConfigFile() {
  return fileURLToPath(new URL('../../config.json', import.meta.url));
}

function merge(defaults, override, at) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error(`config: ${at || 'the file'} must be an object`);
  }
  const out = {};
  for (const key of Object.keys(override)) {
    if (!(key in defaults)) throw new Error(`config: unknown setting ${at ? `${at}.` : ''}${key}`);
  }
  for (const [key, base] of Object.entries(defaults)) {
    const path = at ? `${at}.${key}` : key;
    const value = key in override ? override[key] : base;
    if (Array.isArray(base)) {
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || !v)) {
        throw new Error(`config: ${path} must be a list of names`);
      }
      out[key] = [...value];
    } else if (base !== null && typeof base === 'object') {
      out[key] = merge(base, value, path);
    } else {
      if (typeof value !== typeof base || (typeof value === 'number' && !Number.isFinite(value)) || value === '') {
        throw new Error(`config: ${path} must be ${{ number: 'a number', boolean: 'true or false' }[typeof base] ?? 'a non-empty string'}`);
      }
      out[key] = value;
    }
  }
  return out;
}

function leaves(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? leaves(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
  );
}

function check(config) {
  const all = leaves(config);
  for (const [pattern, ok, message] of RULES) {
    const match = new RegExp(`^${pattern.replace('.', '\\.').replace('*', '[^.]+')}$`);
    for (const [path, value] of all) if (match.test(path) && !ok(value)) throw new Error(`config: ${path} ${message} (got ${value})`);
  }
}

export function loadConfig({ file = defaultConfigFile(), read = readFileSync } = {}) {
  let text = null;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read the config file ${file} (${err.code ?? 'error'})`);
  }
  let override = {};
  if (text !== null) {
    try {
      override = JSON.parse(text);
    } catch {
      throw new Error(`config: ${file} is not valid JSON`);
    }
  }
  const config = merge(DEFAULT_CONFIG, override, '');
  check(config);
  return config;
}
