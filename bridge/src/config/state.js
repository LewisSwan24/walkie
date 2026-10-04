// What the bridge remembers between runs (spec 6.3): %APPDATA%\walkie\state.json holds the active project and the last
// session id of each project, so a restart carries on where it stopped. A file that is missing, damaged or edited into
// nonsense gives an empty state and a report, never an error: what it costs is a fresh session, not a bridge that will not
// start. A failed save is reported the same way and the bridge goes on with what it has in memory.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function defaultStateFile(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'walkie', 'state.json') : null;
}

// What `claude --resume` is given. Claude's ids are UUIDs; anything shaped otherwise, or able to read as an option, is not one.
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{6,99}$/;

// `file` null keeps the state in memory only (no APPDATA). `report(text)` is told about a file it could not use or save.
export function createStateStore({ file = defaultStateFile(), report = () => {}, read = readFileSync, write = writeFileSync, rename = renameSync, mkdir = mkdirSync } = {}) {
  let project = null;
  const sessions = new Map();

  if (file) {
    let text = null;
    try {
      text = read(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') report(`cannot read the state file ${file} (${err.code ?? 'error'}); starting without it`);
    }
    if (text !== null) {
      try {
        const data = JSON.parse(text);
        if (typeof data?.project === 'string' && data.project) project = data.project;
        if (data?.sessions !== null && typeof data?.sessions === 'object' && !Array.isArray(data.sessions)) {
          for (const [name, id] of Object.entries(data.sessions)) if (typeof id === 'string' && SESSION_ID.test(id)) sessions.set(name, id);
        }
      } catch {
        report(`the state file ${file} is not valid JSON; starting without it`);
      }
    }
  }

  function save() {
    if (!file) return;
    const temp = `${file}.tmp`;
    try {
      mkdir(path.dirname(file), { recursive: true });
      write(temp, `${JSON.stringify({ project, sessions: Object.fromEntries(sessions) }, null, 2)}\n`);
      rename(temp, file);
    } catch (err) {
      report(`cannot save the state file ${file} (${err.code ?? 'error'}); a restart will not remember this`);
    }
  }

  return {
    project: () => project,
    setProject(name) {
      if (name === project) return;
      project = name;
      save();
    },
    sessionId: (name) => sessions.get(name) ?? null,
    setSession(name, id) {
      if (!SESSION_ID.test(id) || sessions.get(name) === id) return;
      sessions.set(name, id);
      save();
    },
    forgetSession(name) {
      if (sessions.delete(name)) save();
    },
  };
}
