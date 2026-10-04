// bridge/projects.json: [{name, aliases, path}], the projects he can switch between by voice (spec 6.3).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultProjectsFile() {
  return fileURLToPath(new URL('../../projects.json', import.meta.url));
}

// "on the beat", "On-The-Beat" and "on_the_beat" are the same name: case, spaces, hyphens and underscores do not count.
export function normalizeName(text) {
  return String(text).toLowerCase().replace(/[\s\-_.,，。、]+/g, '');
}

export function validateProjects(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('projects: the file must be a list with at least one project');
  const taken = new Map();
  const claim = (word, owner) => {
    const key = normalizeName(word);
    if (taken.has(key) && taken.get(key) !== owner) throw new Error(`projects: "${word}" names both ${taken.get(key)} and ${owner}`);
    taken.set(key, owner);
  };
  return list.map((p, i) => {
    const at = `projects[${i}]`;
    if (p === null || typeof p !== 'object') throw new Error(`projects: ${at} must be an object`);
    if (typeof p.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.name)) throw new Error(`projects: ${at}.name must be letters, digits, . _ - (got ${JSON.stringify(p.name)})`);
    if (!Array.isArray(p.aliases) || p.aliases.some((a) => typeof a !== 'string' || !normalizeName(a))) throw new Error(`projects: ${p.name}.aliases must be a list of words`);
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw new Error(`projects: ${p.name}.path must be an absolute path`);
    claim(p.name, p.name);
    for (const a of p.aliases) claim(a, p.name);
    return { name: p.name, aliases: [...p.aliases], path: p.path };
  });
}

export function loadProjects({ file = defaultProjectsFile(), read = readFileSync } = {}) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the projects file ${file} (${err.code ?? 'error'})`);
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new Error(`projects: ${file} is not valid JSON`);
  }
  return validateProjects(list);
}

// The project whose name or alias is `text`, or null.
export function findProject(projects, text) {
  const key = normalizeName(text ?? '');
  if (!key) return null;
  return projects.find((p) => normalizeName(p.name) === key || p.aliases.some((a) => normalizeName(a) === key)) ?? null;
}

// "on-the-beat: 手环项目, on the beat; verbatim; walkie: 语音助手": the table the classifier prompt carries.
export function projectTable(projects) {
  return projects.map((p) => (p.aliases.length ? `${p.name}: ${p.aliases.join(', ')}` : p.name)).join('; ');
}

// Every name and alias, for the transcription prompt.
export function projectWords(projects) {
  return projects.flatMap((p) => [p.name, ...p.aliases]);
}
