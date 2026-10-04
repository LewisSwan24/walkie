import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStateStore, defaultStateFile, SESSION_ID } from '../../src/config/state.js';

const ID_A = '11111111-2222-4333-8444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'walkie', 'state.json') };
}
const reports = () => {
  const list = [];
  return Object.assign((text) => list.push(text), { list });
};

test('the file is under APPDATA, and without APPDATA there is none', () => {
  assert.equal(defaultStateFile({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), path.join('C:\\Users\\x\\AppData\\Roaming', 'walkie', 'state.json'));
  assert.equal(defaultStateFile({}), null);
});

test('with no file there is no project and no session', (t) => {
  const { file } = sandbox(t);
  const report = reports();
  const store = createStateStore({ file, report });
  assert.equal(store.project(), null);
  assert.equal(store.sessionId('walkie'), null);
  assert.deepEqual(report.list, [], 'a file that is not there yet is not a problem');
});

test('the project and the session ids survive a restart, and the folder is made when it is needed', (t) => {
  const { dir, file } = sandbox(t);
  const first = createStateStore({ file });
  first.setProject('walkie');
  first.setSession('walkie', ID_A);
  first.setSession('on-the-beat', ID_B);
  const again = createStateStore({ file });
  assert.equal(again.project(), 'walkie');
  assert.equal(again.sessionId('walkie'), ID_A);
  assert.equal(again.sessionId('on-the-beat'), ID_B);
  assert.equal(again.sessionId('other'), null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { project: 'walkie', sessions: { walkie: ID_A, 'on-the-beat': ID_B } });
  assert.deepEqual(readdirSync(path.join(dir, 'walkie')), ['state.json'], 'no temporary file is left');
});

test('forgetting a session is saved, forgetting one that is not there writes nothing', (t) => {
  const { file } = sandbox(t);
  const writes = [];
  const store = createStateStore({ file, write: (f, text) => (writes.push(f), writeFileSync(f, text)) });
  store.setSession('walkie', ID_A);
  assert.equal(writes.length, 1);
  store.forgetSession('other');
  assert.equal(writes.length, 1);
  store.forgetSession('walkie');
  assert.equal(writes.length, 2);
  assert.equal(createStateStore({ file }).sessionId('walkie'), null);
});

test('saying again what it already knows writes nothing', (t) => {
  const { file } = sandbox(t);
  let writes = 0;
  const store = createStateStore({ file, write: (f, text) => (writes++, writeFileSync(f, text)) });
  store.setProject('walkie');
  store.setProject('walkie');
  store.setSession('walkie', ID_A);
  store.setSession('walkie', ID_A);
  assert.equal(writes, 2);
  store.setSession('walkie', ID_B);
  assert.equal(writes, 3);
  assert.equal(store.sessionId('walkie'), ID_B);
});

test('an id that is not shaped like claude ids is not kept, and cannot read as an option', (t) => {
  const { file } = sandbox(t);
  const store = createStateStore({ file });
  for (const bad of ['', 'short', '--dangerously-skip-permissions', '-abcdefgh', ' abcdefgh', 'has space in it', 'a'.repeat(101), 5, null, undefined]) {
    store.setSession('walkie', bad);
    assert.equal(store.sessionId('walkie'), null, String(bad));
  }
  assert.ok(SESSION_ID.test(ID_A));
  store.setSession('walkie', ID_A);
  assert.equal(store.sessionId('walkie'), ID_A);
});

test('a damaged file is an empty state and a report that does not quote the file, and the next save repairs it', (t) => {
  const { file } = sandbox(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"project": "walkie", "sessions": {"walkie": "11111111-SECRET-fragment');
  const report = reports();
  const store = createStateStore({ file, report });
  assert.equal(store.project(), null);
  assert.equal(report.list.length, 1);
  assert.match(report.list[0], /not valid JSON/);
  assert.ok(!report.list[0].includes('SECRET'));
  store.setProject('walkie');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { project: 'walkie', sessions: {} });
});

test('a file with the wrong shapes keeps what is sound and drops the rest', (t) => {
  const { file } = sandbox(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ project: 5, sessions: { good: ID_A, bad: '--resume', worse: 7, nul: null } }));
  const store = createStateStore({ file });
  assert.equal(store.project(), null);
  assert.equal(store.sessionId('good'), ID_A);
  for (const name of ['bad', 'worse', 'nul']) assert.equal(store.sessionId(name), null, name);
  for (const json of ['[]', 'null', '5', '"x"', '{"sessions": []}', '{"project": "", "sessions": "x"}', JSON.stringify({ sessions: [ID_A] })]) {
    writeFileSync(file, json);
    const s = createStateStore({ file });
    assert.equal(s.project(), null, json);
    assert.equal(s.sessionId('x'), null, json);
    assert.equal(s.sessionId('0'), null, json);
  }
});

test('a file whose sessions are null is not damaged, only without sessions', (t) => {
  const { file } = sandbox(t);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"project": "walkie", "sessions": null}');
  const report = reports();
  const store = createStateStore({ file, report });
  assert.equal(store.project(), 'walkie');
  assert.deepEqual(report.list, []);
});

test('a save that dies halfway leaves the old file as it was', (t) => {
  const { file } = sandbox(t);
  createStateStore({ file }).setProject('walkie');
  const before = readFileSync(file, 'utf8');
  const report = reports();
  const dying = createStateStore({
    file,
    report,
    write: (f) => {
      writeFileSync(f, '{"project": "half');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
  });
  dying.setProject('other');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.match(report.list[0], /\(ENOSPC\)/);
  assert.equal(createStateStore({ file }).project(), 'walkie');
});

test('a project named like an object property is just a name', (t) => {
  const { file } = sandbox(t);
  const store = createStateStore({ file });
  store.setSession('__proto__', ID_A);
  store.setSession('constructor', ID_B);
  const again = createStateStore({ file });
  assert.equal(again.sessionId('__proto__'), ID_A);
  assert.equal(again.sessionId('constructor'), ID_B);
  assert.equal(again.sessionId('toString'), null);
});

test('a file that cannot be read is reported with its error code and the bridge goes on', (t) => {
  const { dir } = sandbox(t);
  const report = reports();
  const store = createStateStore({ file: dir, report }); // a folder where a file should be
  assert.equal(store.project(), null);
  assert.match(report.list[0], /cannot read the state file .* \(EISDIR\)/);
});

test('a save that fails is reported and the state in memory is still right', (t) => {
  const { dir } = sandbox(t);
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'a file where a folder should be');
  const report = reports();
  const store = createStateStore({ file: path.join(blocker, 'state.json'), report });
  store.setProject('walkie');
  store.setSession('walkie', ID_A);
  assert.equal(store.project(), 'walkie');
  assert.equal(store.sessionId('walkie'), ID_A);
  assert.equal(report.list.length, 2);
  assert.match(report.list[0], /cannot save the state file .* \(\w+\); a restart will not remember this/);
});

test('without a file the state is kept in memory and nothing is written or reported', () => {
  const report = reports();
  const store = createStateStore({ file: null, report, write: () => assert.fail('wrote'), mkdir: () => assert.fail('made a folder') });
  store.setProject('walkie');
  store.setSession('walkie', ID_A);
  store.forgetSession('walkie');
  assert.equal(store.project(), 'walkie');
  assert.equal(store.sessionId('walkie'), null);
  assert.deepEqual(report.list, []);
});
