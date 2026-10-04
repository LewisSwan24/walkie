import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { findProject, loadProjects, normalizeName, projectTable, projectWords, validateProjects } from '../../src/config/projects.js';

const LIST = [
  { name: 'on-the-beat', aliases: ['手环项目', 'on the beat'], path: 'C:/p/on-the-beat' },
  { name: 'verbatim', aliases: [], path: 'C:/p/verbatim' },
  { name: 'walkie', aliases: ['语音助手'], path: 'C:/p/walkie' },
];

// bridge/projects.json is his own and not committed; the example that is committed must load as it stands.
test('the committed bridge/projects.example.json is valid', () => {
  const projects = loadProjects({ file: fileURLToPath(new URL('../../projects.example.json', import.meta.url)) });
  assert.ok(projects.length >= 1);
  assert.ok(projects.some((p) => p.name === 'walkie'));
});

test('names are compared without case, spaces, hyphens or underscores', () => {
  assert.equal(normalizeName('On The Beat'), 'onthebeat');
  assert.equal(normalizeName('on-the-beat'), 'onthebeat');
  assert.equal(normalizeName('on_the_beat.'), 'onthebeat');
});

test('findProject answers to the name and to every alias, and to nothing else', () => {
  const projects = validateProjects(LIST);
  assert.equal(findProject(projects, 'on the beat').name, 'on-the-beat');
  assert.equal(findProject(projects, 'On-The-Beat').name, 'on-the-beat');
  assert.equal(findProject(projects, '手环项目').name, 'on-the-beat');
  assert.equal(findProject(projects, '语音助手').name, 'walkie');
  assert.equal(findProject(projects, 'verbatim').name, 'verbatim');
  assert.equal(findProject(projects, 'beat'), null);
  assert.equal(findProject(projects, ''), null);
  assert.equal(findProject(projects, null), null);
});

test('projectTable and projectWords feed the prompts', () => {
  const projects = validateProjects(LIST);
  assert.equal(projectTable(projects), 'on-the-beat: 手环项目, on the beat; verbatim; walkie: 语音助手');
  assert.deepEqual(projectWords(projects), ['on-the-beat', '手环项目', 'on the beat', 'verbatim', 'walkie', '语音助手']);
});

test('bad project lists are refused with the project named', () => {
  assert.throws(() => validateProjects([]), /at least one project/);
  assert.throws(() => validateProjects({}), /at least one project/);
  assert.throws(() => validateProjects([{ name: 'a b', aliases: [], path: 'C:/x' }]), /projects\[0\]\.name/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: 'x', path: 'C:/x' }]), /a\.aliases/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: [''], path: 'C:/x' }]), /a\.aliases/);
  assert.throws(() => validateProjects([{ name: 'a', aliases: [], path: 'relative/dir' }]), /a\.path must be an absolute path/);
});

test('one word may not name two projects', () => {
  const clash = [
    { name: 'alpha', aliases: ['the tool'], path: 'C:/a' },
    { name: 'beta', aliases: ['The-Tool'], path: 'C:/b' },
  ];
  assert.throws(() => validateProjects(clash), /"The-Tool" names both alpha and beta/);
  assert.throws(() => validateProjects([{ name: 'alpha', aliases: [], path: 'C:/a' }, { name: 'Alpha', aliases: [], path: 'C:/b' }]), /names both/);
});

test('loadProjects reports unreadable and malformed files without echoing content', () => {
  const eacces = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => loadProjects({ file: 'C:/x/projects.json', read: eacces }), /cannot read the projects file C:\/x\/projects\.json \(EACCES\)/);
  assert.throws(() => loadProjects({ file: 'C:/x/projects.json', read: () => '[ {' }), /C:\/x\/projects\.json is not valid JSON/);
});
