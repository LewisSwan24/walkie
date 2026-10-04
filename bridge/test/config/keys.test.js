import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultKeysFile, describeKeys, loadKeys, parseKeysEnv, whyKeysMissing } from '../../src/config/keys.js';

const OPENAI = 'sk-test-openai-0123456789';
const GEMINI = 'AIza-test-gemini-0123456789';

test('parses KEY=value lines, skipping comments, blanks, CRLF and a BOM', () => {
  const BOM = String.fromCharCode(0xfeff);
  // the BOM sits in front of the first assignment, where a parser that does not strip it would lose the key
  const text = `${BOM}OPENAI_API_KEY=${OPENAI}\r\n# keys for walkie\r\n\r\n  GEMINI_API_KEY = ${GEMINI}  \r\n`;
  assert.deepEqual(parseKeysEnv(text), { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI });
});

test('quotes and an export prefix are accepted, and an unquoted trailing comment is cut', () => {
  const text = `export OPENAI_API_KEY="${OPENAI}"\nGEMINI_API_KEY='${GEMINI}'\nOTHER=abc # note\nQUOTED="a # b"\n`;
  assert.deepEqual(parseKeysEnv(text), { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI, OTHER: 'abc', QUOTED: 'a # b' });
});

test('lines that are not assignments are ignored', () => {
  assert.deepEqual(parseKeysEnv('just some words\n=novalue\nA=1\n'), { A: '1' });
});

test('an environment variable overrides the file, and only the two keys are returned', () => {
  const file = `OPENAI_API_KEY=from-file\nGEMINI_API_KEY=${GEMINI}\nUNRELATED=x\n`;
  const keys = loadKeys({ env: { OPENAI_API_KEY: OPENAI }, file: 'keys.env', read: () => file });
  assert.deepEqual(keys, { OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI });
});

test('an empty environment variable does not hide the file', () => {
  const keys = loadKeys({ env: { OPENAI_API_KEY: '  ' }, file: 'keys.env', read: () => `OPENAI_API_KEY=${OPENAI}\n` });
  assert.deepEqual(keys, { OPENAI_API_KEY: OPENAI });
});

test('a missing keys file is not an error: no keys', () => {
  const read = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };
  assert.deepEqual(loadKeys({ env: {}, file: 'nope.env', read }), {});
});

test('an unreadable keys file is an error that names the file and never shows content', () => {
  const read = () => {
    throw Object.assign(new Error(`EACCES while reading ${OPENAI}`), { code: 'EACCES' });
  };
  assert.throws(
    () => loadKeys({ env: {}, file: 'C:/x/keys.env', read }),
    (err) => err.message.includes('C:/x/keys.env') && err.message.includes('EACCES') && !err.message.includes(OPENAI),
  );
});

test('no APPDATA means no default keys file', () => {
  assert.equal(defaultKeysFile({}), null);
  assert.match(defaultKeysFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), /walkie[\\/]keys\.env$/);
  assert.deepEqual(loadKeys({ env: {} }), {});
});

test('describeKeys says which keys are present and never what they are', () => {
  const said = describeKeys({ OPENAI_API_KEY: OPENAI });
  assert.equal(said, 'OPENAI_API_KEY set, GEMINI_API_KEY missing');
  assert.ok(!said.includes(OPENAI));
});

test('whyKeysMissing says nothing when both keys are there', () => {
  assert.equal(whyKeysMissing({ OPENAI_API_KEY: OPENAI, GEMINI_API_KEY: GEMINI }, { env: {}, file: 'keys.env', read: () => '' }), '');
});

test('whyKeysMissing says where it looked and what the file holds for each missing key, and never a value', () => {
  const PASTED = 'sk-proj-pasted-without-its-name-0123456789';
  const file = `# keys\nOPENAI_API_KEY=\nGEMINI_API_KEY_OLD=${GEMINI}\n${PASTED}\n`;
  const why = whyKeysMissing({}, { env: {}, file: 'C:/x/keys.env', read: () => file });
  assert.equal(why, 'C:/x/keys.env (assignments: 2, other lines: 1): OPENAI_API_KEY is in the file with no value; GEMINI_API_KEY is not in the file');
  assert.ok(!why.includes(PASTED) && !why.includes(GEMINI));
  assert.equal(
    whyKeysMissing({ GEMINI_API_KEY: GEMINI }, { env: {}, file: 'C:/x/keys.env', read: () => file }),
    'C:/x/keys.env (assignments: 2, other lines: 1): OPENAI_API_KEY is in the file with no value',
  );
});

test('whyKeysMissing says so when the keys file is not there, and when there is no place to look', () => {
  const read = () => {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  };
  assert.equal(whyKeysMissing({}, { env: {}, file: 'C:/x/keys.env', read }), 'C:/x/keys.env does not exist');
  assert.equal(whyKeysMissing({}, { env: {} }), 'APPDATA is not set, so there is no keys file');
});

test('whyKeysMissing on a file it cannot read gives the reason code and never the content', () => {
  const read = () => {
    throw Object.assign(new Error(`EACCES while reading ${OPENAI}`), { code: 'EACCES' });
  };
  const why = whyKeysMissing({}, { env: {}, file: 'C:/x/keys.env', read });
  assert.equal(why, 'C:/x/keys.env cannot be read (EACCES)');
  assert.ok(!why.includes(OPENAI));
});
