// API keys: %APPDATA%\walkie\keys.env, where an environment variable of the same name wins (spec 6.3).
// The values are returned to the code that calls the providers and go nowhere else: not into errors, not into logs.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const KEY_NAMES = ['OPENAI_API_KEY', 'GEMINI_API_KEY'];

export function defaultKeysFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'keys.env') : null;
}

// The assignments in `text`, and how many lines were neither an assignment, blank nor a comment (a key pasted without
// its name, say). trim() also drops a BOM in front of the first line; a value may be quoted, and an unquoted one may end in a # comment.
function scan(text) {
  const values = {};
  let others = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      others++;
      continue;
    }
    let value = m[2].trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    value = quoted ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
    values[m[1]] = value;
  }
  return { values, others };
}

// KEY=value lines; blank lines and # comments are skipped.
export function parseKeysEnv(text) {
  return scan(text).values;
}

export function loadKeys({ env = process.env, file = defaultKeysFile(env), read = readFileSync } = {}) {
  let fromFile = {};
  if (file) {
    try {
      fromFile = parseKeysEnv(read(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read the keys file ${file} (${err.code ?? 'error'})`);
    }
  }
  const keys = {};
  for (const name of KEY_NAMES) {
    const value = (env[name] ?? '').trim() || (fromFile[name] ?? '').trim();
    if (value) keys[name] = value;
  }
  return keys;
}

// What the console may say about the keys: which are present, never what they are.
export function describeKeys(keys) {
  return KEY_NAMES.map((name) => `${name} ${keys[name] ? 'set' : 'missing'}`).join(', ');
}

// Why a key is missing, as facts that cannot give one away: where the file is, whether it is there, how many lines it has
// of each kind, and whether it names each missing key at all. '' when no key is missing.
export function whyKeysMissing(keys, { env = process.env, file = defaultKeysFile(env), read = readFileSync } = {}) {
  const missing = KEY_NAMES.filter((name) => !keys[name]);
  if (!missing.length) return '';
  if (!file) return 'APPDATA is not set, so there is no keys file';
  let found;
  try {
    found = scan(read(file, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? `${file} does not exist` : `${file} cannot be read (${err.code ?? 'error'})`;
  }
  const { values, others } = found;
  const each = missing.map((name) => `${name} is ${Object.hasOwn(values, name) ? 'in the file with no value' : 'not in the file'}`);
  return `${file} (assignments: ${Object.keys(values).length}, other lines: ${others}): ${each.join('; ')}`;
}
