# Walkie Stage 1, plan 3 of 4: Claude. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge runs Claude Code for him. One `claude` process per project, kept alive between messages and started again with `--resume` when it has to be; what he says goes in as a message and what comes back is a spoken line (`<voice>`) and a screen text; a tool call that needs approval reaches a local permission endpoint and waits for his yes or no; stop, continue, compact, new session, switch project and status work. It runs against a stand-in `claude` and, in the one live task, the real one, through a developer command (`walkie-dev claude`); the firmware does not change and no S3 is needed.

**Architecture:** `bridge/src/claude` holds one process (`process.js`: its arguments, its events, `send`, `kill`) and the session manager built on it (`manager.js`), with the small pieces they share: `stream.js` splits what `claude` prints into lines and turns the events into the few kinds the manager acts on, `voice.js` finds the spoken line of a reply, `status.js` and `errors.js` write the sentences for `status` and for a failed run. `bridge/src/perm` holds the permission side: `server.js` is a hand-written MCP endpoint over HTTP on 127.0.0.1 with a token made for each run, `approvals.js` is the queue of calls waiting for the wrist (one on the screen at a time, each denied on its own clock), `preview.js` is what the screen shows of a call. `bridge/src/config/state.js` keeps the active project and a session id per project. The manager tells the rest of walkie what happened through events (`working`, `reply`, `idle`, `notice`, `failure`, `project`) and knows nothing about the device; plan 4 wires them to the screen.

**Tech Stack:** Node 24 (ESM, `node:test`, `node:http`, `node:child_process`); Claude Code 2.1.285 in print mode (`-p --input-format stream-json --output-format stream-json --verbose`); MCP over Streamable HTTP with plain JSON answers. No new dependency.

**Spec:** `docs/superpowers/specs/2026-09-29-walkie-design.md`. This plan implements §6.4 and the `claude` and `perm` parts of §6.3 and §8, and settles the two Claude items of §10 (the permission MCP over HTTP, the cache re-writes). It needs plan 2's `config.js` and `projects.js` (`findProject`, `loadProjects`) and its developer CLI (`args.js`, `walkie-dev.js`); it changes those only by addition. Three decisions here depart from the spec's text, each on a measurement made with the real `claude` on 1 Oct 2026, and Task 11 writes them into the spec:

1. An approval nobody answers is denied after **55 s**, not 120 s (§6.4, §8). `claude`'s own MCP client drops a pending call at about 60 s (59,999 and 59,996 ms observed) and the model then asks once more, so waiting 120 s would run every unanswered approval twice and let a late yes allow a call that `claude` had already given up on. The setting is `claude.approvalTimeoutSec`.
2. The permission endpoint is written by hand on `node:http`, not with `@modelcontextprotocol/sdk` (§6.3). The real client's whole conversation is `server/discover` (answered with -32601), `initialize`, `notifications/initialized` (202), a GET (405), `tools/list` and `tools/call`; about 190 lines answer it, and the bridge's only dependency stays `serialport`.
3. A process for the active project starts when the bridge starts and after a switch (`claude.prewarm`, on by default), not on the first `to_claude` message (§6.4), because a cold start takes 14 to 23 s (the SessionStart hooks).

**Stage 1 is four plans.** Each one leaves working, tested software:

1. **The link** (landed 2026-09-30): the protocol, the firmware's link and audio transport, the bridge's `link`, the flash and boot tools, a developer CLI, and mic gain calibration.
2. **Speech** (landed 2026-10-01): the OpenAI and Gemini adapters, the provider chain, the loudness chain, intent, configuration and the keys.
3. **Claude** (this plan): the session manager, the permission MCP over HTTP, `<voice>` extraction. Bridge only; it runs against a stand-in `claude` and then the real one.
4. **The device experience**: the firmware's state machine, screens, key gestures, approvals and SWITCH_CONFIRM, the remaining TEST hooks, and the bridge's `ui`, `console` and `main`, which join everything into one voice turn.

Plan 4 is written once this plan has landed, so that it can use what this one measured.

Task 10 is live: it runs the real `claude`, and it needs him. Run it on the main thread. Tasks 1 to 9 are pure code and tests, and each can go to a worker. Task 11 edits the spec and the README.

## Global Constraints

- **The real `claude` runs only in Task 10, and only with his fresh yes.** It uses his Claude login and his quota, loads his own settings and hooks, and can write files in the folder it is started in. Before each such step ask him with the AskUserQuestion tool and say exactly what will run, in which folder, what it may do there and what it costs. Only a clear yes in that answer counts: not 「继续」 in chat, and not a yes given for a different step. Tasks 1 to 9 never start the real `claude`: they run `bridge/test/claude/fake-claude.js`, a stand-in that takes the same arguments and prints the recorded events, and every test of the developer command passes it with `--command`. Nothing in Tasks 1 to 9 uses a key, the network or a serial port; the only socket is the permission server's, on 127.0.0.1 with a port the system picks.
- **Inside the Claude desktop app's own shell, a nested `claude` inherits variables that point it at the app instead of at the login** (`CLAUDE*` and `ANTHROPIC*`), and fails with a 401. `walkie-dev claude --clean-env` starts it without them. The bridge itself will run from a normal terminal and does not need this.
- **Nothing he says and nothing Claude answers reaches a log or the console's log lines.** Logs carry tool names, outcomes, ids, sizes and times, never texts or tool input (pinned in Tasks 6 and 8). The token of the permission server is made for each run, is never logged or printed, and the server listens on 127.0.0.1 only.
- The command line of each session is the one in spec 6.4: `claude -p --input-format stream-json --output-format stream-json --verbose --model <model> --strict-mcp-config --mcp-config '{"mcpServers":{"walkie":{"type":"http","url":"http://127.0.0.1:<port>/mcp","headers":{"Authorization":"Bearer <token>"}}}}' --permission-prompt-tool mcp__walkie__approve --append-system-prompt "<voice rules>" [--resume <session id>]`. The program and any arguments before these come from `claude.command` in `bridge/config.json` (default `["claude"]`). Arguments are passed as an array: nothing goes through a shell and nothing is quoted for one.
- Measured with the real `claude` 2.1.285 on 1 Oct 2026. They are why the code has its shape; a newer `claude` that changes one shows up as a failing fixture or in Task 10:
  - The client drops a pending permission call at about 60 s and the model retries it once: `claude.approvalTimeoutSec` is 55.
  - `system/init` is printed at the start of **every** turn, not once per process.
  - A message sent while a turn is running is merged into that turn: one `result` answers both.
  - A cold start takes 14 to 23 s before the first turn can begin (the SessionStart hooks): `claude.prewarm`.
  - `/compact` takes about 18 s: a `status` event of `compacting`, a `compact_boundary` with `pre_tokens` and `post_tokens`, then a `result` with no text.
  - Ending the process tree in the middle of a turn exits with code 1, and `--resume <id>` carries on in the same session; closing stdin exits with code 0.
  - Resuming a session that does not exist is a `result` of subtype `error_during_execution` with errors `["No conversation found with session ID: …"]`, the same words on stderr, and exit code 1.
  - Failures recorded: a login that has run out (`authentication_failed`, 401) and a model it does not know (`model_not_found`, 404). A rate limit, an overload and a missing program were not recorded; they are matched by the same fields and by the words `claude` uses.
- Node 24, ESM, `node:test`. The bridge's dependencies stay `serialport` alone.
- Session ids live in `%APPDATA%\walkie\state.json`. Tests and the developer command never touch the real file: they keep the state in memory or point `APPDATA` at a temporary folder and check that nothing was written there.
- Windows: the process tree is ended with `taskkill /PID <pid> /T /F` (a Bash tool that is running is a grandchild); elsewhere the one process is killed with SIGKILL.
- A test that depends on a time limit mocks the clock with `t.mock.timers`; no unit test waits in real time. The tests that start a real process (`process-real`, `manager-real`, the developer command's end-to-end tests) are bounded by that process's own timeouts and by a guard in the test.
- The repo is `C:\Users\you\Documents\walkie`. Commands are PowerShell, run from the repo root unless a step says otherwise. Commit by explicit path (`git add <files>`), never `git add -A` or `git commit -a`. No push and no amend.
- The `Co-Authored-By:` line of a commit names the model that actually wrote it. The commands below say Claude Sonnet 5.5; change the name if another model writes the commit, and a session on a model that is not Claude leaves the line out.

## Review Focus

What a person using this is most likely to meet, that the spec does not spell out. Each line names the tests that pin it (a test titled in a task below), and Task 10 checks the first two against the real `claude`.

1. **An approval nobody answers** (he took the S3 off, or a call came in). The queue denies at 55 s, below the 60 s at which `claude` gives up on its own, with 「手腕上没人回应，先别做。」; a late, unknown or repeated answer changes nothing; a client that hangs up takes its request off the screen and the next one comes up. Pinned in Task 1 by `the claude defaults are the ones measured with the real claude on 1 Oct 2026`, in Task 5 by `with no answer it is denied after the timeout with the words of the spec, and the screen is told`, `the wait is 55 s unless told otherwise, and an answer stops the clock` and `an answer that is late, unknown or for a request that is not on the screen changes nothing`, and in Task 6 by `when the client hangs up before an answer, the signal given to decide aborts and nothing is answered or logged`.
2. **He speaks again while Claude is still working.** `claude` merges the message into the running turn and answers once. A manager that expects one reply per message would announce `working` twice, wait for a reply that never comes, or speak two answers. Pinned in Task 3 by `a denied tool shows in the result, and the one reply answers both messages sent during the turn` and in Task 8 by `however many messages are sent during a turn, working is announced once and the one result is one reply` and `a message sent while a turn is running is part of that turn: one reply for both`.
3. **Claude fails or goes away in the middle of a turn** (the login ran out, the model is unknown, the session is gone, the process was killed, the program or the folder is missing). He is told what to do at the PC, every run of `working` ends in an `idle`, nothing throws when nobody is listening, and the next message works. Pinned in Task 4 by `the three failures recorded from the real claude are told apart`, and in Task 8 by `a failed turn is a failure of the kind it was, with the sentence for the screen, then idle`, `an unexpected exit in the middle of a turn: he is told, the run of working ends, and the next message starts a process that resumes; the lost message is not sent again`, `a session that cannot be resumed at start: the id is forgotten, he is told, and a fresh process takes over`, `a program that cannot be started is a failure of kind missing, and a message after it tries again` and `with nobody listening, a failed turn, an unexpected exit and a program that is missing throw nothing`.
4. **Anything else on this PC that can reach the permission port** (another program, a web page that makes the browser call 127.0.0.1). It needs the token, a Host that names this server and no Origin header, and it may only POST JSON to `/mcp`; a refusal never reaches the device, and a verdict that cannot be made is a deny. Pinned in Task 6 by `a request without the token, or with the wrong one, is refused before anything is read`, `a request that names another host is refused even with the right token, and localhost is a name for this one`, `a request with an Origin header, which only a browser sends, is refused`, `a body over the limit is refused with 413 and the next request still works` and `when decide throws, the answer is a denial that says so, and it is logged`.
5. **Noise on `claude`'s output and a damaged state file.** A hook that prints text, a line cut in the middle, a character split between two chunks, a line of 3 MB from a big Write, a `state.json` edited into nonsense. Nothing throws; a stray line goes to the log cut to 200 characters, and a bad state file means a fresh start, not a bridge that will not start. Pinned in Task 3 by `the splitter gives whole lines whatever the chunks, and takes CRLF as a newline` and `a line longer than the limit is dropped and the lines after it still arrive`, in Task 7 by `a line that is not a JSON object is junk and never an event` and `a real process: a line of 3 MB arrives whole, and a line that is no event is told apart`, in Task 8 by `lines that are not events go to the log, cut to 200 characters, and nothing else` and `what he said and what Claude answered never reach the log`, and in Task 1 by `a damaged file is an empty state and a report that does not quote the file, and the next save repairs it`.

## Files

```
README.md                                   Layout row, Prerequisites (claude), the developer command list
bridge/config.json                          + the claude section
bridge/src/config/config.js                 + the claude defaults, their range checks, true/false settings
bridge/src/config/state.js                  state.json: the active project and a session id per project
bridge/src/claude/voice.js                  the rules Claude is given about speaking; the spoken line of a reply
bridge/src/claude/stream.js                 claude's stdout: lines, events, the line sent in
bridge/src/claude/status.js                 what `status` says; the summary of a tool call
bridge/src/claude/errors.js                 a failed run as a kind and a sentence for the screen
bridge/src/claude/process.js                one claude process: arguments, events, send, end
bridge/src/claude/manager.js                the session manager
bridge/src/perm/preview.js                  what the APPROVAL screen shows of a tool call
bridge/src/perm/approvals.js                the queue of calls waiting for his yes or no
bridge/src/perm/server.js                   the permission endpoint: MCP over HTTP on 127.0.0.1
bridge/src/dev/claude.js                    walkie-dev claude: the manager from a terminal
bridge/src/dev/args.js, bin/walkie-dev.js   + claude, --cwd, --project, --command and --clean-env
bridge/test/**                              new suites; test/claude/fake-claude.js is the stand-in claude, test/claude/fixtures/ the events recorded from the real one
docs/superpowers/specs/2026-09-29-walkie-design.md   §6.3, §6.4, §8 and §10 record what this plan measured
```

---

### Task 1: The `claude` settings and the state file

Two small things the rest of the plan stands on. `bridge/config.json` gets a `claude` section, whose numbers are the ones measured with the real `claude` on 1 Oct 2026. And `state.json` remembers the active project and the last session id of each project, so that a restart carries on where it stopped.

**Files:**
- Modify: `bridge/config.json`, `bridge/src/config/config.js`
- Modify: `bridge/test/config/config.test.js` (four edits)
- Create: `bridge/src/config/state.js`
- Test: `bridge/test/config/state.test.js`

**Interfaces:**
- Consumes (plan 2): `loadConfig` and `DEFAULT_CONFIG` in `config.js`; in `config.test.js`, the helpers `fileWith` and `shape`. `shape` compares the keys of `config.json` with those of `DEFAULT_CONFIG`, which is why the file and the defaults change together.
- Produces:
  - `DEFAULT_CONFIG.claude` and the same section in `bridge/config.json`: `{command: ['claude'], model: 'claude-opus-5-5', idleMinutes: 60, approvalTimeoutSec: 55, prewarm: true}`. `command` is the program and any arguments that go before the ones walkie adds (a stand-in `claude` is `["node", "fake-claude.js"]`); `idleMinutes` is how long a process with nothing to do keeps its input open; `approvalTimeoutSec` is how long a tool call waits for the wrist (55, below the 60 s at which `claude` gives up, see Global Constraints); `prewarm` starts a process before the first message. `loadConfig()` checks them: `idleMinutes` and `approvalTimeoutSec` must be more than 0, `prewarm` must be `true` or `false` (a wrong type is named in the error), `command` a non-empty list of non-empty strings.
  - `defaultStateFile(env = process.env): string | null`: `%APPDATA%\walkie\state.json`, or `null` without `APPDATA`.
  - `SESSION_ID`: the pattern of an id `claude --resume` is given (`/^[A-Za-z0-9][A-Za-z0-9_-]{6,99}$/`). `claude`'s ids are UUIDs; anything else, and anything that could read as an option, is not kept.
  - `createStateStore({file = defaultStateFile(), report = () => {}, read, write, rename, mkdir}): {project(): string | null, setProject(name), sessionId(name): string | null, setSession(name, id), forgetSession(name)}`. `file: null` keeps the state in memory. A file that is missing, damaged, edited into nonsense or unreadable gives an empty state (or what is sound in it) and one `report(text)`, never an error and never a quotation of the file; a save writes a temporary file and renames it over the real one, so a save that dies halfway leaves the old file; a save that fails is reported and the state in memory stays right. Saying again what the store already knows writes nothing.

- [ ] **Step 1: Write the failing tests**

Four edits to `bridge/test/config/config.test.js`: the defaults, an override of the `claude` section, the wrong types and the ranges.

In `bridge/test/config/config.test.js`, replace

```js
test('the committed bridge/config.json is valid and lists every setting', () => {
```

with

```js
test('the claude defaults are the ones measured with the real claude on 1 Oct 2026', () => {
  assert.deepEqual(DEFAULT_CONFIG.claude, { command: ['claude'], model: 'claude-opus-5-5', idleMinutes: 60, approvalTimeoutSec: 55, prewarm: true });
  assert.ok(DEFAULT_CONFIG.claude.approvalTimeoutSec < 60, "claude's MCP client drops a pending request at about 60 s");
});

test('the committed bridge/config.json is valid and lists every setting', () => {
```

In `bridge/test/config/config.test.js`, replace

```js
test('a setting the code does not know is an error that names it', () => {
```

with

```js
test('the claude settings can be overridden, the command as a list', () => {
  const c = loadConfig(fileWith({ claude: { command: ['node', 'fake-claude.js'], model: 'claude-sonnet-5-5', prewarm: false, idleMinutes: 5 } }));
  assert.deepEqual(c.claude, { command: ['node', 'fake-claude.js'], model: 'claude-sonnet-5-5', idleMinutes: 5, approvalTimeoutSec: 55, prewarm: false });
});

test('a setting the code does not know is an error that names it', () => {
```

In `bridge/test/config/config.test.js`, replace

```js
  assert.throws(() => loadConfig(fileWith({ loudness: 5 })), /loudness must be an object/);
```

with

```js
  assert.throws(() => loadConfig(fileWith({ loudness: 5 })), /loudness must be an object/);
  assert.throws(() => loadConfig(fileWith({ claude: { prewarm: 'yes' } })), /claude\.prewarm must be true or false/);
  assert.throws(() => loadConfig(fileWith({ claude: { prewarm: 1 } })), /claude\.prewarm must be true or false/);
  assert.throws(() => loadConfig(fileWith({ claude: { command: 'claude' } })), /claude\.command must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ claude: { command: [] } })), /claude\.command must be a list of names/);
  assert.throws(() => loadConfig(fileWith({ claude: { model: '' } })), /claude\.model must be a non-empty string/);
  assert.throws(() => loadConfig(fileWith({ claude: { idleMinutes: '60' } })), /claude\.idleMinutes must be a number/);
```

In `bridge/test/config/config.test.js`, replace

```js
  assert.throws(() => loadConfig(fileWith({ cooldownMs: -1 })), /cooldownMs/);
```

with

```js
  assert.throws(() => loadConfig(fileWith({ cooldownMs: -1 })), /cooldownMs/);
  assert.throws(() => loadConfig(fileWith({ claude: { idleMinutes: 0 } })), /claude\.idleMinutes must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ claude: { approvalTimeoutSec: 0 } })), /claude\.approvalTimeoutSec must be more than 0 \(got 0\)/);
  assert.throws(() => loadConfig(fileWith({ claude: { approvalTimeoutSec: -5 } })), /claude\.approvalTimeoutSec must be more than 0/);
```

And the state store's tests:

Create `bridge/test/config/state.test.js`:

```js
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/config/config.test.js bridge/test/config/state.test.js`
Expected: FAIL. `state.test.js` fails with `ERR_MODULE_NOT_FOUND` for `src/config/state.js`; in `config.test.js` the four tests that mention `claude` fail (`DEFAULT_CONFIG.claude` is not there, and `unknown setting claude` is thrown for the override, the wrong type and the value out of range), and the other seven tests of that file keep passing.

- [ ] **Step 3: Add the `claude` section to the config**

Three edits to `bridge/src/config/config.js`: the defaults, the two range checks, and the error for a wrong type, which until now could only be a number or a string and now names `true or false` for a boolean.

In `bridge/src/config/config.js`, replace

```js
  loudness: { ...DEFAULT_LOUDNESS },
};
```

with

```js
  loudness: { ...DEFAULT_LOUDNESS },
  claude: {
    command: ['claude'], // the program, then any arguments that go before the ones walkie adds
    model: 'claude-opus-5-5',
    idleMinutes: 60, // a process with nothing to do this long has its stdin closed; the next message resumes the session
    approvalTimeoutSec: 55, // claude's MCP client drops a pending request after about 60 s (measured 1 Oct 2026): answer first
    prewarm: true, // start claude with the bridge and after a switch, so the first message does not wait for it to boot (about 20 s)
  },
};
```

In `bridge/src/config/config.js`, replace

```js
  ['loudness.lookaheadMs', (v) => v >= 0, 'must be 0 or more'],
];
```

with

```js
  ['loudness.lookaheadMs', (v) => v >= 0, 'must be 0 or more'],
  ['claude.idleMinutes', (v) => v > 0, 'must be more than 0'],
  ['claude.approvalTimeoutSec', (v) => v > 0, 'must be more than 0'],
];
```

In `bridge/src/config/config.js`, replace

```js
        throw new Error(`config: ${path} must be ${typeof base === 'number' ? 'a number' : 'a non-empty string'}`);
```

with

```js
        throw new Error(`config: ${path} must be ${{ number: 'a number', boolean: 'true or false' }[typeof base] ?? 'a non-empty string'}`);
```

And the same section in the file he edits. `config.test.js` compares the shape of the two:

In `bridge/config.json`, replace

```json
    "lookaheadMs": 5
  }
}
```

with

```json
    "lookaheadMs": 5
  },
  "claude": {
    "command": ["claude"],
    "model": "claude-opus-5-5",
    "idleMinutes": 60,
    "approvalTimeoutSec": 55,
    "prewarm": true
  }
}
```

- [ ] **Step 4: Write the state store**

Create `bridge/src/config/state.js`:

```js
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
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `node --test bridge/test/config/config.test.js bridge/test/config/state.test.js`
Expected: PASS, 11 tests in `config.test.js` and 14 in `state.test.js`.

Run: `npm --prefix bridge test`
Expected: PASS, 265 tests.

- [ ] **Step 6: Commit**

```bash
git add bridge/config.json bridge/src/config/config.js bridge/src/config/state.js bridge/test/config/config.test.js bridge/test/config/state.test.js
git commit -m "Bridge: claude settings in config.json and a state file for the project and its sessions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The voice line

What Claude is told about speaking, and how its reply becomes the one or two sentences the S3 says. Pure functions of a string, so this is the cheapest task to get exactly right, and everything the user hears from Claude passes through it.

**Files:**
- Create: `bridge/src/claude/voice.js`
- Test: `bridge/test/claude/voice.test.js`

**Interfaces:**
- Consumes: nothing. Plain JS with no imports.
- Produces:
  - `VOICE_RULES`: the text appended to Claude's system prompt (`--append-system-prompt`, Task 7). It asks for one `<voice>…</voice>` line of one or two short spoken sentences at the end of every final reply, in the language he speaks, with no code, markdown, paths, URLs or tool names. Tried live on 1 Oct 2026 (claude 2.1.285, Opus 5.5): a Chinese question got a Chinese line, an English one an English line, and the line closed every final reply.
  - `MAX_VOICE_CHARS` (160) and `FALLBACK_CHARS` (60).
  - `stripMarkdown(text): string`: markdown as plain text for the ear: fenced code dropped whole, links and images reduced to their text, URLs dropped, markers of headings, bullets, quotes, bold, italic and strike-through removed, `snake_case` words left alone.
  - `extractVoice(reply): {voice, screen, tagged}`. `voice` is what to say aloud and `screen` is the reply without the voice block. The last `<voice>` block of the reply is the one spoken, found in any case and across line breaks, and a block cut off before its closing tag still counts. Markdown inside it is removed, and a line longer than 160 characters is cut at a sentence end in its back half, or on the spot at 160. With no usable block (none, or an empty one), the first sentence of the screen text is spoken, markdown stripped and at most 60 characters (spec §6.4), and `tagged` is `false`; a reply that is only a code block has nothing to say. The input is whatever `claude` sent: a non-string gives an empty voice.

- [ ] **Step 1: Write the failing test**

Create `bridge/test/claude/voice.test.js`:

````js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_RULES, extractVoice, stripMarkdown } from '../../src/claude/voice.js';

test('a reply that ends with a voice line speaks that line and keeps the rest for the screen', () => {
  // the first reply of the live run of 1 Oct 2026, word for word
  const reply = '你好，很高兴见到你，今天有什么可以帮你的吗？\n\n<voice>你好，很高兴见到你，今天有什么可以帮你的吗？</voice>';
  assert.deepEqual(extractVoice(reply), {
    voice: '你好，很高兴见到你，今天有什么可以帮你的吗？',
    screen: '你好，很高兴见到你，今天有什么可以帮你的吗？',
    tagged: true,
  });
});

test('the screen text keeps its markdown and loses only the voice block', () => {
  const out = extractVoice('It printed `walkie`.\n\n<voice>It printed the word walkie.</voice>');
  assert.equal(out.voice, 'It printed the word walkie.');
  assert.equal(out.screen, 'It printed `walkie`.');
});

test('the last of several voice blocks is the one spoken', () => {
  const out = extractVoice('<voice>first</voice> some text <voice>second</voice>');
  assert.equal(out.voice, 'second');
  assert.equal(out.screen, '<voice>first</voice> some text');
});

test('a voice block cut off before its closing tag is still spoken', () => {
  const out = extractVoice('Done with the edit.\n<voice>改好了，测试也通过了');
  assert.equal(out.voice, '改好了，测试也通过了');
  assert.equal(out.screen, 'Done with the edit.');
  assert.equal(out.tagged, true);
});

test('the tag is found in any case and with line breaks inside it', () => {
  assert.equal(extractVoice('x <VOICE>\n  hello\n  there\n</Voice>').voice, 'hello there');
});

test('markdown inside the voice block is removed', () => {
  assert.equal(extractVoice('<voice>I ran **npm test** and `all` of it [passed](https://example.com/x).</voice>').voice, 'I ran npm test and all of it passed.');
});

test('a voice line longer than 160 characters is cut at a sentence end in its back half', () => {
  const sentence = '这是一句比较长的话，用来把声音那一行撑过上限。';
  const text = sentence.repeat(10);
  const out = extractVoice(`<voice>${text}</voice>`).voice;
  assert.ok(out.length <= 160, `got ${out.length} characters`);
  assert.ok(out.endsWith('。'), 'it ends where a sentence ends');
});

test('a voice line with no sentence end is cut on the spot at 160 characters', () => {
  const out = extractVoice(`<voice>${'啊'.repeat(400)}</voice>`).voice;
  assert.equal(out.length, 160);
});

test('an empty voice block falls back to the first sentence of the reply', () => {
  const out = extractVoice('The build is green. Nothing else to do.\n<voice>  </voice>');
  assert.equal(out.voice, 'The build is green.');
  assert.equal(out.tagged, false);
});

test('with no tag, the first sentence is spoken with its markdown stripped', () => {
  const out = extractVoice('I **fixed** the bug in `parse.js`. Then I ran the tests.');
  assert.deepEqual(out, { voice: 'I fixed the bug in parse.js.', screen: 'I **fixed** the bug in `parse.js`. Then I ran the tests.', tagged: false });
});

test('with no tag, the first sentence is cut to 60 characters when it runs on', () => {
  const out = extractVoice(`${'word '.repeat(40)}end.`).voice;
  assert.equal(out.length <= 60, true);
  assert.ok(out.length > 40, 'it keeps most of the 60');
  const zh = extractVoice('我'.repeat(100)).voice;
  assert.equal(zh.length, 60);
});

test('with no tag, a Chinese reply is spoken up to its first full stop', () => {
  assert.equal(extractVoice('测试全部通过了。我还顺手改了注释。').voice, '测试全部通过了。');
});

test('with no tag, a reply that starts with a code block is spoken from the first line outside it', () => {
  const reply = '```js\nconst x = 1;\n```\nThat is the whole change. It is small.';
  assert.equal(extractVoice(reply).voice, 'That is the whole change.');
});

test('a dotted file name does not end the first sentence', () => {
  assert.equal(extractVoice('Edited voice.js and added a test. Done.').voice, 'Edited voice.js and added a test.');
});

test('a code block inside the voice block is not read out', () => {
  assert.equal(extractVoice('<voice>Run it:\n```\nls -la\n```\nthen look.</voice>').voice, 'Run it: then look.');
});

test('headings, bullets and quotes lose their markers when read out', () => {
  assert.equal(extractVoice('## Result\n- all green').voice, 'Result');
  assert.equal(stripMarkdown('> quoted\n1. first\n* second'), 'quoted first second');
});

test('URLs are not read out and snake_case words keep their underscores', () => {
  assert.equal(stripMarkdown('see https://example.com/a?b=1 for my_var_name'), 'see for my_var_name');
});

test('an empty reply, or no reply, gives an empty voice', () => {
  assert.deepEqual(extractVoice(''), { voice: '', screen: '', tagged: false });
  assert.deepEqual(extractVoice(undefined), { voice: '', screen: '', tagged: false });
});

test('a reply that is only a code block has nothing to say', () => {
  assert.equal(extractVoice('```\nls -la\n```').voice, '');
});

test('the rules Claude is given name the tag the code looks for', () => {
  assert.match(VOICE_RULES, /<voice>.*<\/voice>/);
  assert.ok(!VOICE_RULES.includes('\n'), 'one paragraph: it is a command line argument');
});
````

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test bridge/test/claude/voice.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude/voice.js`.

- [ ] **Step 3: Write the module**

Create `bridge/src/claude/voice.js`:

````js
// What Claude is told about speaking, and how its reply becomes the one or two sentences the S3 says (spec 6.4).

// Appended to Claude's system prompt. Tried live on 1 Oct 2026 (claude 2.1.285, Opus 5.5): a Chinese question got a Chinese
// <voice> line, an English one an English line, and the line closed every final reply.
export const VOICE_RULES =
  'Your replies reach the user through a small voice remote on their wrist: a tiny screen and a speaker. ' +
  'End every final reply with one line of the form <voice>one or two short sentences</voice>. ' +
  'Say in plain spoken words what you did or what you need from them, in the language the user is speaking. ' +
  'Inside the tag use no code, no markdown, no file paths, no URLs and no tool names. ' +
  'Everything before the tag is shown on the computer and may be as long as it needs to be.';

export const MAX_VOICE_CHARS = 160; // a tagged line longer than this is cut at a sentence end: it is one or two short sentences
export const FALLBACK_CHARS = 60; // spec 6.4: with no tag, the reply's first sentence, at most this many characters

const SENTENCE_END = /[。！？!?；;]|\.(?=\s|$)/;

// One line of markdown as text a person would say: no markers, no links, no URLs.
function plainLine(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*([-*_]\s*){3,}$/, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Markdown to plain text, a line at a time. Fenced code is dropped whole: nobody wants it read out.
export function stripMarkdown(text) {
  const lines = [];
  let fenced = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(plainLine(line));
  }
  return lines.filter(Boolean).join(' ');
}

// `text` cut to at most `max` characters, at a sentence end when there is one in the back half, and on the spot otherwise.
function limit(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  for (let i = head.length - 1; i >= max / 2; i--) {
    if (SENTENCE_END.test(head[i]) && (head[i] !== '.' || i + 1 >= head.length || /\s/.test(head[i + 1]))) {
      end = i;
      break;
    }
  }
  return (end >= 0 ? head.slice(0, end + 1) : head).trim();
}

// The first sentence of a reply that has no tag: the first line with words in it, up to its first sentence end.
function firstSentence(reply) {
  let fenced = false;
  for (const line of reply.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const plain = fenced ? '' : plainLine(line);
    if (!/[\p{L}\p{N}]/u.test(plain)) continue;
    const m = SENTENCE_END.exec(plain);
    return m ? plain.slice(0, m.index + 1).trim() : plain;
  }
  return '';
}

// {voice, screen, tagged}. `voice` is what to say aloud: the last <voice> block of the reply, with any markdown inside it
// removed, or, with no usable block, the first sentence of the reply. `screen` is the reply without the block.
export function extractVoice(reply) {
  const text = typeof reply === 'string' ? reply : '';
  let voice = '';
  let screen = text.trim();
  let last = null;
  for (const m of text.matchAll(/<voice>([\s\S]*?)<\/voice>/gi)) last = m;
  if (last) {
    voice = stripMarkdown(last[1]);
    screen = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  } else {
    const open = text.search(/<voice>(?![\s\S]*<\/voice>)/i); // a reply cut off inside the tag
    if (open >= 0) {
      voice = stripMarkdown(text.slice(open + '<voice>'.length));
      screen = text.slice(0, open).trim();
    }
  }
  if (voice) return { voice: limit(voice, MAX_VOICE_CHARS), screen, tagged: true };
  return { voice: limit(firstSentence(screen), FALLBACK_CHARS), screen, tagged: false };
}
````

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/claude/voice.test.js`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/claude/voice.js bridge/test/claude/voice.test.js
git commit -m "Bridge: the voice rules for Claude and the spoken line of a reply" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: What `claude` prints

`claude -p --output-format stream-json --verbose` prints one JSON object per line: hook progress, thinking, rate-limit news, every assistant message, every tool result, and at the end a `result`. The manager needs a handful of facts from all that. This task cuts the stream into lines and boils the events down to those facts, written against recordings of the real thing, so that a newer `claude` that adds a kind of event never reaches the manager, and one that changes the shape of an event it needs shows up as a failing fixture.

**Files:**
- Create: `bridge/src/claude/stream.js`
- Test: `bridge/test/claude/stream.test.js`
- Create (test data): `bridge/test/claude/fixtures/hello.jsonl`, `write-allowed.jsonl`, `write-denied.jsonl`, `write-timed-out.jsonl`, `compact.jsonl`, `error-login.jsonl`, `error-model.jsonl` and `error-resume.jsonl`

**Interfaces:**
- Consumes: nothing. Plain JS with no imports.
- Produces:
  - `MAX_LINE` (32 MB): one event is one line, and a Write of a big file makes a big line.
  - `createLineSplitter(onLine, {maxLine = MAX_LINE}): {push(text), end()}`: `push` takes strings (the caller decodes the bytes with a decoder that keeps a character split between two chunks), and `onLine` gets each whole line, whatever the chunks and with CRLF taken as a newline; `end()` hands over a last line that had no newline and leaves the splitter ready to start again. A line longer than `maxLine` is dropped for that one event, and the lines after it still arrive; a line of exactly the limit is kept.
  - `parseEvent(line): object | null`: the line as an object, or `null` when it is not a JSON object (a warning, a number, an array).
  - `interpret(event): object[]`: the events one raw event stands for, in order; most raw events stand for none.
    - `{kind: 'init', sessionId, model, walkie}`: a turn begins. `claude` prints `system/init` at the start of every turn, not once per process; `walkie` is the permission server's connection status in `mcp_servers` (`'connected'`, `'pending'`, `'failed'`), or `null` when it is not listed.
    - `{kind: 'tool', id, name, input}` for a `tool_use` block, in the order it came; `input` is `{}` when it is missing or not an object.
    - `{kind: 'text', text}` for a text block (a blank one gives nothing).
    - `{kind: 'api-error', code, text}`: `claude`'s own message for an API failure, which is an `assistant` message with an `error` field (`authentication_failed`, `model_not_found`, …) and the explanation as its text.
    - `{kind: 'compacting'}` and `{kind: 'compacted', trigger, preTokens, postTokens, durationMs}`: `/compact` started, and `compact_boundary`.
    - `{kind: 'result', ok, subtype, text, errors, apiStatus, terminal, sessionId, turns, durationMs, costUsd, usage, denials}`: the turn is over. `ok` is `false` for every kind of error. A `/compact` ends with a result whose text is empty. `usage` is `{input, cacheWrite, cacheRead, output}` and `denials` lists `{tool, id}` of the calls that were denied. A field that is missing comes out as zero, empty or `false`, never `undefined`.
  - `userLine(text): string`: the line to write to `claude`'s stdin for a user message, one JSON line however many lines the text has.

The eight fixtures are the events of the live runs of 1 Oct 2026 (claude 2.1.285), cut down by hand: the folder is `C:\proj`, the tool list has five tools, hook output is empty and the thinking blocks are emptied; everything else is as `claude` printed it. They are what the later tasks' stand-in `claude` copies:

- `hello`: one plain reply, the first one `claude` gave, with a `<voice>` line.
- `write-allowed` and `write-denied`: a Write that went through the permission tool and was allowed, and one that was refused.
- `write-timed-out`: a permission call that the client dropped at about 60 s and the model tried again: two tool events, one result.
- `compact`: `/compact`, with a result that has no text.
- `error-login`, `error-model` and `error-resume`: the three failures recorded.

- [ ] **Step 1: Write the fixtures and the failing test**

The recordings first, one file each:

Create `bridge/test/claude/fixtures/hello.jsonl`:

```
{"type":"system","subtype":"hook_started","hook_id":"4f14987f-4ded-40b0-8e52-10bab14c42c0","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"system","subtype":"hook_response","hook_id":"4f14987f-4ded-40b0-8e52-10bab14c42c0","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"system","subtype":"hook_progress","hook_id":"3f9dc854-2f63-413a-a8e4-04960b93e061","hook_name":"SessionStart:startup","hook_event":"SessionStart","stdout":"","stderr":"","output":"","session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[{"name":"walkie","status":"connected","source":"dynamic"}],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":189,"estimated_tokens_delta":139,"session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb8bfKNT7B2bs9d97REf","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":36118,"cache_read_input_tokens":16994,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":36118},"output_tokens":9,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb8bfKNT7B2bs9d97REf","type":"message","role":"assistant","content":[{"type":"text","text":"你好，很高兴见到你，今天有什么可以帮你的吗？\n\n<voice>你好，很高兴见到你，今天有什么可以帮你的吗？</voice>"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":36118,"cache_read_input_tokens":16994,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":36118},"output_tokens":9,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790841600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.21,"resetsAt":1790841600},"seven_day":{"utilization":0.05,"resetsAt":1791428400}}},"session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23"}
{"duration_api_ms":2761,"stop_reason":"end_turn","session_id":"66cdb925-7b82-47cf-b3f6-03178fa21d23","total_cost_usd":0.29457079999999997,"usage":{"input_tokens":2,"cache_creation_input_tokens":36118,"cache_read_input_tokens":16994,"output_tokens":111,"output_tokens_details":{"thinking_tokens":50},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":36118,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"completed","is_error":false,"num_turns":1,"subtype":"success","api_error_status":null,"result":"你好，很高兴见到你，今天有什么可以帮你的吗？\n\n<voice>你好，很高兴见到你，今天有什么可以帮你的吗？</voice>","ttft_ms":8544,"type":"result","duration_ms":10249,"ttft_stream_ms":7388,"time_to_request_ms":5830,"first_content_frame_ms":7388,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/write-allowed.jsonl`:

```
{"type":"system","subtype":"hook_started","hook_id":"75d8d50d-ece6-4b2c-8a8f-70579df83e39","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"hook_response","hook_id":"75d8d50d-ece6-4b2c-8a8f-70579df83e39","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"hook_progress","hook_id":"866642fc-12e3-4155-b342-be2bd6b1d7ae","hook_name":"SessionStart:startup","hook_event":"SessionStart","stdout":"","stderr":"","output":"","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[{"name":"walkie","status":"connected","source":"dynamic"}],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9j7tqFjPP2EwhLEUge","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_016BhzRgf1f39R5v77ger4ot","name":"Write","input":{"file_path":"C:\\proj\\note.txt","content":"walkie"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":35963,"cache_read_input_tokens":16994,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":35963},"output_tokens":16,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790841600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.22,"resetsAt":1790841600},"seven_day":{"utilization":0.05,"resetsAt":1791428400}}},"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_016BhzRgf1f39R5v77ger4ot","type":"tool_result","content":"File created successfully at: C:\\proj\\note.txt (file state is current in your context — no need to Read it back)"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":{"type":"create","filePath":"C:\\proj\\note.txt","content":"walkie","structuredPatch":[],"originalFile":null,"userModified":false}}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9jqAYYCzFUKZkhwWMi","type":"message","role":"assistant","content":[{"type":"text","text":"I created `note.txt` in the current folder (`rec-project2`). It contains the single word `walkie`.\n\n<voice>I made the note file with the word walkie in it.</voice>"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":299,"cache_read_input_tokens":52957,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":299},"output_tokens":59,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"duration_api_ms":4760,"stop_reason":"end_turn","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","total_cost_usd":0.3084422,"usage":{"input_tokens":4,"cache_creation_input_tokens":36262,"cache_read_input_tokens":69951,"output_tokens":217,"output_tokens_details":{"thinking_tokens":0},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":36262,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"completed","is_error":false,"num_turns":2,"subtype":"success","api_error_status":null,"result":"I created `note.txt` in the current folder (`rec-project2`). It contains the single word `walkie`.\n\n<voice>I made the note file with the word walkie in it.</voice>","ttft_ms":7368,"type":"result","duration_ms":19137,"ttft_stream_ms":6110,"time_to_request_ms":4499,"first_content_frame_ms":6111,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/write-denied.jsonl`:

```
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[{"name":"walkie","status":"connected","source":"dynamic"}],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9kj7STaGyrCejtsugJ","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01E3HRh6WZAkdu8AhFBd8zp6","name":"Write","input":{"file_path":"C:\\proj\\second.txt","content":"second"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":115,"cache_read_input_tokens":53256,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":115},"output_tokens":16,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"用户拒绝了这个操作。","is_error":true,"tool_use_id":"toolu_01E3HRh6WZAkdu8AhFBd8zp6"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":"Error: 用户拒绝了这个操作。","tool_result_meta":[{"id":"toolu_01E3HRh6WZAkdu8AhFBd8zp6","non_execution_kind":"permission-rule"}]}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9mZUXyHdwTZfVoWuPH","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":311,"cache_read_input_tokens":53371,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":311},"output_tokens":8,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9mZUXyHdwTZfVoWuPH","type":"message","role":"assistant","content":[{"type":"text","text":"你拒绝了这次写入，所以没有创建 `second.txt`，我也没有重试。\n\n当前所在的文件夹叫 `rec-project2`。\n\n<voice>你拒绝了写入，所以第二个文件没有创建。现在所在的文件夹叫 rec-project2。</voice>"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":311,"cache_read_input_tokens":53371,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":311},"output_tokens":8,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1790841600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.23,"resetsAt":1790841600},"seven_day":{"utilization":0.05,"resetsAt":1791428400}}},"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"duration_api_ms":10363,"stop_reason":"end_turn","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","total_cost_usd":0.33931160000000005,"usage":{"input_tokens":4,"cache_creation_input_tokens":426,"cache_read_input_tokens":106627,"output_tokens":306,"output_tokens_details":{"thinking_tokens":47},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":426,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_01E3HRh6WZAkdu8AhFBd8zp6","tool_input":{"file_path":"C:\\proj\\second.txt","content":"second"}}],"terminal_reason":"completed","is_error":false,"num_turns":2,"subtype":"success","api_error_status":null,"result":"你拒绝了这次写入，所以没有创建 `second.txt`，我也没有重试。\n\n当前所在的文件夹叫 `rec-project2`。\n\n<voice>你拒绝了写入，所以第二个文件没有创建。现在所在的文件夹叫 rec-project2。</voice>","ttft_ms":9856,"type":"result","duration_ms":22640,"ttft_stream_ms":8501,"time_to_request_ms":7029,"first_content_frame_ms":8501,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/write-timed-out.jsonl`:

```
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[{"name":"walkie","status":"connected","source":"dynamic"}],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9rZ3sSagbuRcQ51cT4","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01EJosZB5Vu2nVxNEHrmez1u","name":"Write","input":{"file_path":"C:\\proj\\third.txt","content":"third"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":206,"cache_read_input_tokens":53682,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":206},"output_tokens":16,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"<tool_use_error>Error calling tool (Write): The operation timed out.</tool_use_error>","is_error":true,"tool_use_id":"toolu_01EJosZB5Vu2nVxNEHrmez1u"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":"Error calling tool (Write): The operation timed out."}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9wFa3KkM6URjvAxHTH","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":222,"cache_read_input_tokens":53888,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":222},"output_tokens":6,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9wFa3KkM6URjvAxHTH","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01L6Qar5uju1YY7hWnGw6cVz","name":"Glob","input":{"pattern":"third.txt","path":"C:\\proj"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":222,"cache_read_input_tokens":53888,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":222},"output_tokens":6,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01L6Qar5uju1YY7hWnGw6cVz","type":"tool_result","content":"No files found"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":{"filenames":[],"durationMs":172,"numFiles":0,"truncated":false,"totalMatches":0,"countIsComplete":true}}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9wZzZK7wo9u1Cr6fWw","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":214,"cache_read_input_tokens":54110,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":214},"output_tokens":3,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011Cfb9wZzZK7wo9u1Cr6fWw","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01FPxGmT7CcMndK3YjVoVoB4","name":"Write","input":{"file_path":"C:\\proj\\third.txt","content":"third"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":214,"cache_read_input_tokens":54110,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":214},"output_tokens":3,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"<tool_use_error>Error calling tool (Write): The operation timed out.</tool_use_error>","is_error":true,"tool_use_id":"toolu_01FPxGmT7CcMndK3YjVoVoB4"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":"Error calling tool (Write): The operation timed out."}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011CfbA2KquWZ8qndGbB3up3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01RJPfv1MNcEovfE7PbFXwKg","name":"Glob","input":{"pattern":"*.txt","path":"C:\\proj"},"caller":{"type":"direct"}}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":251,"cache_read_input_tokens":54324,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":251},"output_tokens":16,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01RJPfv1MNcEovfE7PbFXwKg","type":"tool_result","content":"hello.txt\nnote.txt"}]},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tool_use_result":{"filenames":["hello.txt","note.txt"],"durationMs":175,"numFiles":2,"truncated":false,"totalMatches":2,"countIsComplete":true}}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":237,"estimated_tokens_delta":187,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011CfbA2eEhQbfarf92k458P","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":194,"cache_read_input_tokens":54575,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":194},"output_tokens":5,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"assistant","message":{"model":"claude-opus-5-5","id":"msg_011CfbA2eEhQbfarf92k458P","type":"message","role":"assistant","content":[{"type":"text","text":"I couldn't create `third.txt`. The Write tool timed out on two attempts, and the folder still has no `third.txt`. The only text files in `rec-project2` are `hello.txt` and `note.txt`.\n\nA write timing "}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":194,"cache_read_input_tokens":54575,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":194},"output_tokens":5,"service_tier":"standard"}},"parent_tool_use_id":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"duration_api_ms":25313,"stop_reason":"end_turn","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","total_cost_usd":0.4199834,"usage":{"input_tokens":10,"cache_creation_input_tokens":1087,"cache_read_input_tokens":270579,"output_tokens":891,"output_tokens_details":{"thinking_tokens":98},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":1087,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"completed","is_error":false,"num_turns":5,"subtype":"success","api_error_status":null,"result":"I couldn't create `third.txt`. The Write tool timed out on two attempts, and the folder still has no `third.txt`. The only text files in `rec-project2` are `hello.txt` and `note.txt`.\n\nA write timing ","ttft_ms":5985,"type":"result","duration_ms":146962,"ttft_stream_ms":4859,"time_to_request_ms":3376,"first_content_frame_ms":4859,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/compact.jsonl`:

```
{"type":"system","subtype":"status","status":"compacting","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"hook_started","hook_id":"19d32abd-bfdd-4673-86d7-d9a1bf395e72","hook_name":"SessionStart:compact","hook_event":"SessionStart","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"hook_response","hook_id":"19d32abd-bfdd-4673-86d7-d9a1bf395e72","hook_name":"SessionStart:compact","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158"}
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[{"name":"walkie","status":"connected","source":"dynamic"}],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"system","subtype":"compact_boundary","session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","compact_metadata":{"trigger":"manual","pre_tokens":55111,"post_tokens":6566,"cumulative_dropped_tokens":48545,"duration_ms":16036,"preserved_segment":{"head_uuid":"c0e3470a-275d-450a-9c31-e3a94ffac759","anchor_uuid":"3b70e8a6-d4b0-43cc-9efb-5699d8afef78","tail_uuid":"b8b20d6d-ae03-49b7-b46a-5e0c1e3336c8"},"preserved_messages":{"anchor_uuid":"3b70e8a6-d4b0-43cc-9efb-5699d8afef78","uuids":["c0e3470a-275d-450a-9c31-e3a94ffac759","041de850-ec82-4ad2-acab-e3919b6e3741","7a27fa71-de7c-419a-a675-f2bb0ed96c8b","61176da5-0f30-40fa-bb67-97d0be773f9f","b8b20d6d-ae03-49b7-b46a-5e0c1e3336c8"],"all_uuids":["c0e3470a-275d-450a-9c31-e3a94ffac759","041de850-ec82-4ad2-acab-e3919b6e3741","3f9af3ec-6041-40a0-8d9f-9dcaa2fd2e4a","7a27fa71-de7c-419a-a675-f2bb0ed96c8b","61176da5-0f30-40fa-bb67-97d0be773f9f","b8b20d6d-ae03-49b7-b46a-5e0c1e3336c8"]}},"logical_parent_uuid":"b8b20d6d-ae03-49b7-b46a-5e0c1e3336c8"}
{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   - Cr"},"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","parent_tool_use_id":null,"isReplay":false,"isSynthetic":true}
{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted PreCompact [node -e \"const p=require('path');const r=(()=>{var e=process.env.CLAUDE_PLUGIN_ROOT;if(e&&e.trim())return e.trim();var p=require('path'),f=require('fs'),h=r"},"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","parent_tool_use_id":null,"isReplay":true}
{"is_error":false,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"session_id":"eb5a82a3-77c3-44e9-a88e-94359ba3f158","total_cost_usd":0.4684058,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"subtype":"success","result":"","local_command":"compact","type":"result","duration_ms":18315,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/error-login.jsonl`:

```
{"type":"system","subtype":"hook_started","hook_id":"9c62361d-28bb-40e9-83f8-32e161d211ed","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac"}
{"type":"system","subtype":"hook_response","hook_id":"9c62361d-28bb-40e9-83f8-32e161d211ed","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac"}
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[],"model":"claude-opus-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":621,"error_status":401,"error":"authentication_failed","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac"}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1011,"error_status":401,"error":"authentication_failed","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac"}
{"type":"assistant","message":{"id":"8907b61c-7fb5-438d-8a4f-987193aca05b","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"output_tokens_details":null,"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"iterations":null,"speed":null,"fallback_credit":null},"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}]},"parent_tool_use_id":null,"session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac","error":"authentication_failed","is_api_error_message":true}
{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"4a3edabd-f7b7-48a0-b303-251ae96d2cac","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"api_error","is_error":true,"num_turns":1,"subtype":"success","api_error_status":401,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid.","type":"result","duration_ms":9214,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/error-model.jsonl`:

```
{"type":"system","subtype":"hook_started","hook_id":"02ea8150-cd43-42d1-90c8-c5d11ba34d54","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa"}
{"type":"system","subtype":"hook_response","hook_id":"02ea8150-cd43-42d1-90c8-c5d11ba34d54","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa"}
{"type":"system","subtype":"commands_changed","commands":[],"session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa"}
{"type":"system","subtype":"hook_progress","hook_id":"905310de-3145-4bf8-8859-998bba1b0ea1","hook_name":"SessionStart:startup","hook_event":"SessionStart","stdout":"","stderr":"","output":"","session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa"}
{"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa","tools":["Bash","Edit","Glob","Read","Write"],"mcp_servers":[],"model":"claude-nonexistent-9","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.285","output_style":"default"}
{"type":"assistant","message":{"id":"ba10a73e-b207-411f-8d78-35d69acfacc2","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"output_tokens_details":null,"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"iterations":null,"speed":null,"fallback_credit":null},"content":[{"type":"text","text":"There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model."}]},"parent_tool_use_id":null,"session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa","error":"model_not_found","is_api_error_message":true}
{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"bf32cc71-7676-4c9e-94b0-f7395e852aaa","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"terminal_reason":"api_error","is_error":true,"num_turns":1,"subtype":"success","api_error_status":404,"result":"There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.","type":"result","duration_ms":12335,"queued_turn_count":0}
```

Create `bridge/test/claude/fixtures/error-resume.jsonl`:

```
{"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"00000000-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"speed":"standard","fallback_credit":null},"permission_denials":[],"errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"]}
```

Then the test:

Create `bridge/test/claude/stream.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLineSplitter, interpret, parseEvent, userLine } from '../../src/claude/stream.js';

// The events of the live runs of 1 Oct 2026 (claude 2.1.285), cut down by hand: test/claude/fixtures.
function events(name) {
  const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
  return text.split('\n').filter(Boolean).flatMap((line) => interpret(parseEvent(line)));
}
const kinds = (list) => list.map((e) => e.kind);

test('a plain reply is an init, its text and a result; hooks, thinking and rate-limit news are dropped', () => {
  const list = events('hello');
  assert.deepEqual(kinds(list), ['init', 'text', 'result']);
  const [init, text, result] = list;
  assert.equal(init.model, 'claude-opus-5-5');
  assert.equal(init.walkie, 'connected');
  assert.match(init.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(text.text, /<voice>.*<\/voice>/);
  assert.equal(result.ok, true);
  assert.equal(result.subtype, 'success');
  assert.equal(result.text, text.text);
  assert.equal(result.turns, 1);
  assert.equal(result.sessionId, init.sessionId);
  assert.deepEqual(result.usage, { input: 2, cacheWrite: 36118, cacheRead: 16994, output: 111 });
  assert.ok(result.costUsd > 0.29 && result.costUsd < 0.3);
  assert.deepEqual(result.denials, []);
});

test('a tool call is its name and input, in the order it came', () => {
  const list = events('write-allowed');
  assert.deepEqual(kinds(list), ['init', 'tool', 'text', 'result']);
  const tool = list[1];
  assert.equal(tool.name, 'Write');
  assert.deepEqual(tool.input, { file_path: 'C:\\proj\\note.txt', content: 'walkie' });
  assert.match(tool.id, /^toolu_/);
  assert.equal(list[3].turns, 2);
});

test('a denied tool shows in the result, and the one reply answers both messages sent during the turn', () => {
  const list = events('write-denied');
  const result = list.at(-1);
  assert.equal(result.kind, 'result');
  assert.deepEqual(result.denials, [{ tool: 'Write', id: list.find((e) => e.kind === 'tool').id }]);
  assert.match(result.text, /rec-project2/);
});

test('a tool call that timed out and was tried again is two tool events and still one result', () => {
  const list = events('write-timed-out');
  assert.deepEqual(list.filter((e) => e.kind === 'tool').map((e) => e.name), ['Write', 'Glob', 'Write', 'Glob']);
  assert.equal(list.filter((e) => e.kind === 'result').length, 1);
  assert.equal(list.at(-1).turns, 5);
});

test('/compact is a compacting event, a compacted event with the token counts, and a result with no text', () => {
  const list = events('compact');
  assert.deepEqual(kinds(list), ['compacting', 'init', 'compacted', 'result']);
  assert.deepEqual(list[2], { kind: 'compacted', trigger: 'manual', preTokens: 55111, postTokens: 6566, durationMs: 16036 });
  assert.equal(list[3].ok, true);
  assert.equal(list[3].text, '');
  assert.equal(list[3].turns, 0);
});

test('a model claude does not know is an api-error and a failed result with status 404', () => {
  const list = events('error-model');
  const err = list.find((e) => e.kind === 'api-error');
  assert.equal(err.code, 'model_not_found');
  assert.match(err.text, /issue with the selected model/);
  const result = list.at(-1);
  assert.equal(result.ok, false);
  assert.equal(result.apiStatus, 404);
  assert.equal(result.terminal, 'api_error');
  assert.ok(!list.some((e) => e.kind === 'text'), 'the error text is not a reply');
});

test('a login that is no longer valid is an api-error and a failed result with status 401', () => {
  const list = events('error-login');
  assert.equal(list.find((e) => e.kind === 'api-error').code, 'authentication_failed');
  assert.deepEqual([list.at(-1).ok, list.at(-1).apiStatus], [false, 401]);
  assert.match(list.at(-1).text, /Failed to authenticate/);
});

test('resuming a session that does not exist is a failed result with the reason in errors and no text', () => {
  const [result] = events('error-resume');
  assert.equal(result.kind, 'result');
  assert.equal(result.ok, false);
  assert.equal(result.subtype, 'error_during_execution');
  assert.equal(result.text, '');
  assert.deepEqual(result.errors, ['No conversation found with session ID: 00000000-0000-4000-8000-000000000000']);
  assert.equal(result.turns, 0);
});

test('events of a kind the manager does not use, and things that are not events, give nothing', () => {
  for (const e of [null, undefined, 5, 'x', [], {}, { type: 'weird' }, { type: 'rate_limit_event' }, { type: 'user', message: { content: [] } }, { type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'status', status: null }, { type: 'assistant' }, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }]) {
    assert.deepEqual(interpret(e), [], JSON.stringify(e));
  }
});

test('an assistant message with text and a tool call gives both, text first, and blank text gives nothing', () => {
  const list = interpret({ type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'text', text: '   ' }, { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }] } });
  assert.deepEqual(list, [{ kind: 'text', text: 'Looking.' }, { kind: 'tool', id: 't1', name: 'Grep', input: { pattern: 'x' } }]);
});

test('a tool call with no input, or an input that is not an object, has an empty input', () => {
  const list = interpret({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'A' }, { type: 'tool_use', id: 't2', name: 'B', input: 'oops' }, { type: 'tool_use', id: 't3', name: 'C', input: null }, { type: 'tool_use', id: 't4' }] } });
  assert.deepEqual(list.map((e) => [e.name, e.input]), [['A', {}], ['B', {}], ['C', {}]]);
});

test('an api error carries its code and the text of the message, without the blank blocks, and none at all is fine', () => {
  const error = (error, content) => interpret({ type: 'assistant', error, message: { content } });
  assert.deepEqual(error('rate_limit', [{ type: 'text', text: '  ' }, { type: 'text', text: 'Limit reached' }, { type: 'thinking', thinking: 'x' }]), [{ kind: 'api-error', code: 'rate_limit', text: 'Limit reached' }]);
  assert.deepEqual(interpret({ type: 'assistant', error: 'overloaded' }), [{ kind: 'api-error', code: 'overloaded', text: '' }]);
  assert.deepEqual(interpret({ type: 'assistant', error: '', message: { content: [{ type: 'text', text: 'fine' }] } }), [{ kind: 'text', text: 'fine' }]);
});

test('an init says whether the permission server is connected', () => {
  const init = (mcp_servers) => interpret({ type: 'system', subtype: 'init', session_id: 's', model: 'm', mcp_servers })[0];
  assert.equal(init([{ name: 'walkie', status: 'failed' }]).walkie, 'failed');
  assert.equal(init([{ name: 'other', status: 'connected' }]).walkie, null);
  assert.equal(init(undefined).walkie, null);
});

test('a result with fields missing still has every field, as zero, empty or false', () => {
  assert.deepEqual(interpret({ type: 'result', is_error: true })[0], {
    kind: 'result', ok: false, subtype: '', text: '', errors: [], apiStatus: null, terminal: '', sessionId: '', turns: 0, durationMs: 0, costUsd: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, denials: [],
  });
});

test('parseEvent takes a JSON object and nothing else', () => {
  assert.deepEqual(parseEvent('{"a":1}'), { a: 1 });
  for (const bad of ['[1]', '5', 'null', '"x"', '{nope', '', 'claude: warning']) assert.equal(parseEvent(bad), null, bad);
});

test('the splitter gives whole lines whatever the chunks, and takes CRLF as a newline', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l));
  s.push('{"a":');
  s.push('1}\r\n{"b"');
  s.push(':2}\n\n\n{"c":3}\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('the splitter hands over a last line that has no newline when it ends', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l));
  s.push('one\ntwo');
  assert.deepEqual(got, ['one']);
  s.end();
  assert.deepEqual(got, ['one', 'two']);
  s.end();
  assert.deepEqual(got, ['one', 'two']);
});

test('a line longer than the limit is dropped and the lines after it still arrive', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 10 });
  s.push('x'.repeat(30) + '\nok\n'); // whole in one chunk
  s.push('y'.repeat(25)); // begins in one chunk,
  s.push('y'.repeat(25)); // goes on in another
  s.push('yy\nfine\n'); // and ends in a third
  s.push('z'.repeat(40)); // a last one that never ends,
  s.push('zz'); // with a short chunk of its own at the end
  s.end();
  assert.deepEqual(got, ['ok', 'fine']);
});

test('a line of exactly the limit is kept, whether its newline comes with it or in the next chunk', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 10 });
  s.push('0123456789\n');
  s.push('abcdefghij');
  s.push('\n');
  s.push('0123456789A\n'); // one over
  assert.deepEqual(got, ['0123456789', 'abcdefghij']);
});

test('the splitter starts again after end', () => {
  const got = [];
  const s = createLineSplitter((l) => got.push(l), { maxLine: 5 });
  s.push('toolongline'); // skipping, no newline yet
  s.end();
  s.push('ok\n');
  assert.deepEqual(got, ['ok']);
});

test('a user message is one line of stream-json, however many lines the message has', () => {
  const line = userLine('帮我看看\n第二行 "引号"');
  assert.ok(line.endsWith('\n') && line.indexOf('\n') === line.length - 1, 'one line');
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我看看\n第二行 "引号"' }] } });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test bridge/test/claude/stream.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude/stream.js`.

- [ ] **Step 3: Write the module**

Create `bridge/src/claude/stream.js`:

```js
// What `claude -p --output-format stream-json --verbose` prints, as the events the session manager acts on (spec 6.4).
// Written against the events recorded on 1 Oct 2026 (claude 2.1.285); test/claude/fixtures holds them. Everything the
// manager does not need (hook progress, thinking, rate limit news, tool output) is dropped here, so a new kind of event
// from a newer claude never reaches it, and an event it does need that changes shape shows up as a failing fixture.

export const MAX_LINE = 32 * 1024 * 1024; // one event is one line; a Write of a big file makes a big line

// Splits a stream of text into lines. `push` takes strings (decode the bytes first, with a decoder that keeps a character
// split between two chunks), `end` hands over a last line that had no newline. A line longer than `maxLine` is dropped,
// and `onLine` is told nothing about it: the stream is ruined for that one event only.
export function createLineSplitter(onLine, { maxLine = MAX_LINE } = {}) {
  let buffer = '';
  let skipping = false;
  return {
    push(chunk) {
      let text = buffer + chunk;
      buffer = '';
      for (;;) {
        const at = text.indexOf('\n');
        if (at < 0) break;
        const line = text.slice(0, at).replace(/\r$/, '');
        text = text.slice(at + 1);
        if (skipping) skipping = false;
        else if (line.length <= maxLine && line.trim()) onLine(line);
      }
      if (skipping) return;
      if (text.length > maxLine) skipping = true;
      else buffer = text;
    },
    end() {
      const rest = buffer.replace(/\r$/, ''); // nothing is buffered while a long line is being skipped
      buffer = '';
      skipping = false;
      if (rest.trim()) onLine(rest);
    },
  };
}

// One line as an event object, or null when it is not a JSON object.
export function parseEvent(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function usageOf(u) {
  return { input: num(u?.input_tokens), cacheWrite: num(u?.cache_creation_input_tokens), cacheRead: num(u?.cache_read_input_tokens), output: num(u?.output_tokens) };
}

// The events one raw event stands for, in order. Most raw events stand for none.
//   {kind: 'init', sessionId, model, walkie}   a turn begins (claude prints it at the start of EVERY turn, not once per
//                                              process); `walkie` is the permission server's connection status, or null
//   {kind: 'tool', id, name, input}            a tool_use block
//   {kind: 'text', text}                       a text block
//   {kind: 'api-error', code, text}            claude's own message for an API failure: `code` is its `error` field
//   {kind: 'compacting'}                       /compact started
//   {kind: 'compacted', trigger, preTokens, postTokens, durationMs}
//   {kind: 'result', ok, subtype, text, errors, apiStatus, terminal, sessionId, turns, durationMs, costUsd, usage, denials}
//                                              the turn is over. `ok` is false for every kind of error. A /compact ends
//                                              with a result whose text is empty.
export function interpret(event) {
  if (event === null || typeof event !== 'object') return [];
  if (event.type === 'system') {
    if (event.subtype === 'init') {
      const walkie = Array.isArray(event.mcp_servers) ? event.mcp_servers.find((s) => s?.name === 'walkie') : null;
      return [{ kind: 'init', sessionId: String(event.session_id ?? ''), model: String(event.model ?? ''), walkie: walkie?.status ?? null }];
    }
    if (event.subtype === 'status' && event.status === 'compacting') return [{ kind: 'compacting' }];
    if (event.subtype === 'compact_boundary') {
      const m = event.compact_metadata ?? {};
      return [{ kind: 'compacted', trigger: String(m.trigger ?? ''), preTokens: num(m.pre_tokens), postTokens: num(m.post_tokens), durationMs: num(m.duration_ms) }];
    }
    return [];
  }
  if (event.type === 'assistant') {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const texts = blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text);
    if (typeof event.error === 'string' && event.error) return [{ kind: 'api-error', code: event.error, text: texts.join('\n') }];
    const out = [];
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ kind: 'text', text: b.text });
      else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push({ kind: 'tool', id: String(b.id ?? ''), name: b.name, input: b.input !== null && typeof b.input === 'object' ? b.input : {} });
    }
    return out;
  }
  if (event.type === 'result') {
    return [
      {
        kind: 'result',
        ok: event.is_error !== true,
        subtype: String(event.subtype ?? ''),
        text: typeof event.result === 'string' ? event.result : '',
        errors: Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === 'string') : [],
        apiStatus: typeof event.api_error_status === 'number' ? event.api_error_status : null,
        terminal: typeof event.terminal_reason === 'string' ? event.terminal_reason : '',
        sessionId: String(event.session_id ?? ''),
        turns: num(event.num_turns),
        durationMs: num(event.duration_ms),
        costUsd: num(event.total_cost_usd),
        usage: usageOf(event.usage),
        denials: Array.isArray(event.permission_denials) ? event.permission_denials.map((d) => ({ tool: String(d?.tool_name ?? ''), id: String(d?.tool_use_id ?? '') })) : [],
      },
    ];
  }
  return [];
}

// The line `claude` is sent for a user message: an input event of stream-json.
export function userLine(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/claude/stream.test.js`
Expected: PASS, 21 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/claude/stream.js bridge/test/claude/stream.test.js bridge/test/claude/fixtures
git commit -m "Bridge: claude's stream-json output as lines and as the events the manager needs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: What the bridge says about a session, and about a failed run

Two sets of sentences the manager needs and that have nothing to do with processes. `status` is answered by the bridge from what it has seen, not by asking Claude (spec §6.4), and a failed run has to become a kind the manager acts on and one plain sentence for the ERROR screen that says what to do at the PC (spec §8).

**Files:**
- Create: `bridge/src/claude/status.js`, `bridge/src/claude/errors.js`
- Test: `bridge/test/claude/status.test.js`, `bridge/test/claude/errors.test.js`

**Interfaces:**
- Consumes: nothing. Plain JS with no imports.
- Produces:
  - `MAX_SUMMARY` (40) and `toolSummary(name, input, max = MAX_SUMMARY): string`: what a tool call is working on, in at most `max` characters, cut by characters and marked with `…`. A file tool shows the file's name, however the path is written; Bash shows the description it came with (that says more than the command does), else the first line of the command; the search tools show what they search for, the web tools the host of a URL or the query; a tool it does not know shows the first thing in its input that says something; `''` when nothing does. `input` comes from a model, so any shape at all is possible and none throws.
  - `spokenElapsed(ms): string`: a length of time as it is read aloud: `45秒`, `3分钟`, `2分15秒`, `1小时`, `1小时5分钟`; anything that is not a positive number gives `0秒`.
  - `statusText({project, running, busy, tool, summary, elapsedMs, turns, resumable}): string`: the sentence for the `status` intent, in the language he speaks to the device. No process: it says so and whether the last conversation will be picked up again. A process with nothing to do says it waits, and after work says how many turns and how long the last one took. A turn under way says what the last tool is doing, how long it has gone on and which turn it is.
  - `MESSAGES`: the screen sentence of each kind of failure, `login`, `model`, `no-session`, `rate`, `overloaded` and `missing`.
  - `classifyFailure({code, status, text, errors, stderr, exitCode}): {kind, message}`. `kind` is one of `login`, `model`, `no-session`, `rate`, `overloaded`, `missing` and `other`, found from whichever of the fields says what happened: `code` is the `error` field of the assistant message `claude` printed for the failure (or the code of a spawn error such as `ENOENT`), `status` the result's `api_error_status`, `text` the result's text, `errors` its errors list, `stderr` the tail of what the process wrote to it, `exitCode` how it ended. Three were recorded from the real `claude` on 1 Oct 2026 (a login that ran out, a model it does not know, a session that is not there); the others are matched by the same fields and by the words `claude` uses, and anything else shows the first line of what `claude` said, cut to fit the screen, or the exit code. A login problem wins over a rate limit when both are mentioned. Every field comes from a process or the network, so a field of the wrong type is ignored, never a throw.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/claude/status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUMMARY, spokenElapsed, statusText, toolSummary } from '../../src/claude/status.js';

test('a file tool shows the name of the file, whichever way the path is written', () => {
  assert.equal(toolSummary('Write', { file_path: 'C:\\proj\\src\\note.txt', content: 'x' }), 'note.txt');
  assert.equal(toolSummary('Read', { file_path: '/home/me/proj/a.js' }), 'a.js');
  assert.equal(toolSummary('Edit', { file_path: 'C:\\proj\\' }), 'proj');
  assert.equal(toolSummary('NotebookEdit', { notebook_path: 'D:\\n\\x.ipynb' }), 'x.ipynb');
});

test('Bash shows its description when it has one, otherwise the first line of the command', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run the tests' }), 'Run the tests');
  assert.equal(toolSummary('Bash', { command: '\n  \ngit status\ngit diff' }), 'git status');
  assert.equal(toolSummary('Bash', { command: 'a\tb   c' }), 'a b c');
  assert.equal(toolSummary('PowerShell', { command: 'Get-Date' }), 'Get-Date');
  assert.equal(toolSummary('Bash', { command: '' }), '');
});

test('search tools show what they search for, the web tools the host or the query', () => {
  assert.equal(toolSummary('Grep', { pattern: 'TODO|FIXME', path: 'src' }), 'TODO|FIXME');
  assert.equal(toolSummary('Glob', { pattern: '**/*.test.js' }), '**/*.test.js');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a/b?c=d', prompt: 'x' }), 'example.com');
  assert.equal(toolSummary('WebFetch', { url: 'not a url' }), 'not a url');
  assert.equal(toolSummary('WebSearch', { query: 'node test runner' }), 'node test runner');
});

test('a tool it does not know shows the first thing in its input that says something', () => {
  assert.equal(toolSummary('Agent', { description: 'Find the callers', prompt: 'long' }), 'Find the callers');
  assert.equal(toolSummary('mcp__x__y', { prompt: 'just this' }), 'just this');
  assert.equal(toolSummary('mcp__x__y', { n: 3 }), '');
});

test('input of any shape gives a string, and no more than the limit, cut by characters and marked', () => {
  for (const input of [undefined, null, 5, 'str', [], {}, { file_path: 7 }, { command: ['a'] }]) {
    assert.equal(toolSummary('Bash', input), '', JSON.stringify(input));
    assert.equal(toolSummary('Write', input), '', JSON.stringify(input));
  }
  assert.equal(MAX_SUMMARY, 40);
  const long = toolSummary('Bash', { description: 'x'.repeat(100) });
  assert.equal(long, `${'x'.repeat(39)}…`);
  assert.equal(toolSummary('Bash', { description: 'y'.repeat(40) }), 'y'.repeat(40));
  assert.equal(toolSummary('Bash', { description: 'z'.repeat(41) }), `${'z'.repeat(39)}…`);
  assert.equal(toolSummary('Bash', { description: '运行所有的测试并把结果告诉我' }, 6), '运行所有的…');
  assert.equal(toolSummary('Bash', { description: '😀'.repeat(10) }, 4), '😀😀😀…', 'an emoji is one character, not half of one');
});

test('a time is read aloud in seconds, minutes and hours, and nothing else gives zero', () => {
  const t = (...a) => spokenElapsed(a.reduce((sum, v, i) => sum + v * [3600000, 60000, 1000][i], 0));
  assert.equal(spokenElapsed(0), '0秒');
  assert.equal(spokenElapsed(999), '0秒');
  assert.equal(spokenElapsed(45_000), '45秒');
  assert.equal(spokenElapsed(59_999), '59秒');
  assert.equal(spokenElapsed(60_000), '1分钟');
  assert.equal(t(0, 2, 15), '2分15秒');
  assert.equal(t(0, 59, 59), '59分59秒');
  assert.equal(t(1, 0, 0), '1小时');
  assert.equal(t(1, 5, 30), '1小时5分钟');
  assert.equal(t(25, 0, 0), '25小时');
  for (const bad of [-5, NaN, Infinity, undefined, null, '12']) assert.equal(spokenElapsed(bad), '0秒', String(bad));
});

const base = { project: 'walkie', running: true, busy: false, tool: '', summary: '', elapsedMs: null, turns: 0, resumable: false };

test('no process: it says so, and whether the last conversation will be picked up again', () => {
  assert.equal(statusText({ ...base, running: false, resumable: true }), 'walkie没在运行，上次的对话还在，说话就接着做。');
  assert.equal(statusText({ ...base, running: false }), 'walkie没在运行，说话就开始新对话。');
});

test('a process with nothing to do says it waits, and after work says how much it did and how long the last turn took', () => {
  assert.equal(statusText(base), 'walkie已经待命，等你说话。');
  assert.equal(statusText({ ...base, turns: 3, elapsedMs: 135_000 }), 'walkie空闲，这个对话做了3轮，上一轮用了2分15秒。');
  assert.equal(statusText({ ...base, turns: 3, elapsedMs: null }), 'walkie空闲，这个对话做了3轮。');
});

test('a turn under way says what the last tool is doing, how long it has gone on and which turn it is', () => {
  assert.equal(statusText({ ...base, busy: true, tool: 'Bash', summary: 'Run the tests', elapsedMs: 135_000, turns: 3 }), 'walkie在忙，在用Bash：Run the tests，已经2分15秒，这是第3轮。');
  assert.equal(statusText({ ...base, busy: true, tool: 'Read', elapsedMs: 4000, turns: 1 }), 'walkie在忙，在用Read，已经4秒，这是第1轮。');
  assert.equal(statusText({ ...base, busy: true, elapsedMs: 800, turns: 1 }), 'walkie在忙，还在想，已经0秒，这是第1轮。');
});
```

Create `bridge/test/claude/errors.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFailure, MESSAGES } from '../../src/claude/errors.js';
import { interpret, parseEvent } from '../../src/claude/stream.js';

// What the manager would hand over for a recorded failure: the code of the api-error event and the fields of the result.
function failureOf(name) {
  const text = readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), 'utf8');
  const list = text.split('\n').filter(Boolean).flatMap((line) => interpret(parseEvent(line)));
  const apiError = list.find((e) => e.kind === 'api-error');
  const result = list.find((e) => e.kind === 'result');
  return { code: apiError?.code ?? '', status: result.apiStatus, text: result.text, errors: result.errors };
}

test('the three failures recorded from the real claude are told apart', () => {
  assert.deepEqual(classifyFailure(failureOf('error-login')), { kind: 'login', message: 'Claude 登录过期，回电脑上登录' });
  assert.deepEqual(classifyFailure(failureOf('error-model')), { kind: 'model', message: 'Claude 不认这个模型，回电脑运行 claude update' });
  assert.deepEqual(classifyFailure(failureOf('error-resume')), { kind: 'no-session', message: '找不到上次的对话，已经开了新的' });
});

test('the model failure names the command that fixes it', () => {
  assert.match(MESSAGES.model, /claude update/);
});

test('each kind is also recognised from its status or its words alone', () => {
  const kind = (f) => classifyFailure(f).kind;
  assert.equal(kind({ status: 401 }), 'login');
  assert.equal(kind({ stderr: 'Invalid API key · Please run /login' }), 'login');
  assert.equal(kind({ text: 'OAuth token has expired' }), 'login');
  assert.equal(kind({ text: 'The model does not support this model setting' }), 'model');
  assert.equal(kind({ stderr: '[claude-code:unrecognized_model] {"model":"x"}' }), 'model');
  assert.equal(kind({ errors: ['No conversation found with session ID: abc'] }), 'no-session');
  assert.equal(kind({ code: 'rate_limit' }), 'rate');
  assert.equal(kind({ status: 429 }), 'rate');
  assert.equal(kind({ text: "You've hit your limit · resets 3pm" }), 'rate');
  assert.equal(kind({ text: 'Rate limit reached' }), 'rate');
  assert.equal(kind({ code: 'overloaded' }), 'overloaded');
  assert.equal(kind({ status: 529 }), 'overloaded');
  assert.equal(kind({ status: 503 }), 'overloaded');
  assert.equal(kind({ text: 'Overloaded' }), 'overloaded');
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) assert.equal(kind({ code }), 'missing', code);
  assert.equal(classifyFailure({ code: 'ENOENT' }).message, '找不到 claude 程序，回电脑检查安装');
});

test('each of the words claude uses is enough on its own', () => {
  const kind = (text) => classifyFailure({ text }).kind;
  assert.equal(kind('Failed to authenticate'), 'login');
  assert.equal(kind('You are not logged in'), 'login');
  assert.equal(kind("There's an issue with the selected model (x)"), 'model');
  assert.equal(kind('error: model_not_found'), 'model');
  assert.equal(kind('ratelimit exceeded'), 'rate');
  assert.equal(kind('Claude usage limit exceeded'), 'rate');
  assert.equal(kind('Limit reached'), 'rate');
  assert.equal(kind('Too many requests'), 'rate');
  assert.equal(kind('Server is overloaded'), 'overloaded');
});

test('a login problem wins over a rate limit when both are mentioned, and a model over a missing session', () => {
  assert.equal(classifyFailure({ code: 'authentication_failed', text: 'rate limit' }).kind, 'login');
  assert.equal(classifyFailure({ code: 'model_not_found', errors: ['No conversation found'] }).kind, 'model');
});

test('anything else shows the first line of what claude said, cut to fit the screen', () => {
  assert.deepEqual(classifyFailure({ text: '\n  Something odd happened\nsecond line' }), { kind: 'other', message: 'Claude 出错了：Something odd happened' });
  const long = classifyFailure({ text: 'x'.repeat(80) }).message;
  assert.equal(long, `Claude 出错了：${'x'.repeat(49)}…`);
  assert.equal(classifyFailure({ text: 'y'.repeat(50) }).message, `Claude 出错了：${'y'.repeat(50)}`);
  assert.equal(classifyFailure({ text: '遇到了一个意外'.repeat(10) }).message, `Claude 出错了：${Array.from('遇到了一个意外'.repeat(10)).slice(0, 49).join('')}…`);
});

test('with no text it falls back on the errors list, then the last line of stderr, then the exit code', () => {
  assert.equal(classifyFailure({ text: 'from the text', errors: ['from the errors'], stderr: 'from stderr' }).message, 'Claude 出错了：from the text');
  assert.equal(classifyFailure({ errors: ['', 'Disk full'], stderr: 'noise' }).message, 'Claude 出错了：Disk full');
  assert.equal(classifyFailure({ stderr: 'first\nlast words\n' }).message, 'Claude 出错了：last words');
  assert.equal(classifyFailure({ exitCode: 3 }).message, 'Claude 出错了（退出码 3）');
  assert.equal(classifyFailure({ exitCode: 0 }).message, 'Claude 出错了');
  assert.equal(classifyFailure({}).message, 'Claude 出错了');
  assert.equal(classifyFailure().message, 'Claude 出错了');
  assert.equal(classifyFailure(null).message, 'Claude 出错了');
  assert.equal(classifyFailure('boom').message, 'Claude 出错了');
});

test('fields of the wrong type do not throw', () => {
  const r = classifyFailure({ code: 5, status: 'x', text: 7, errors: [3, null, 'ok'], stderr: null, exitCode: 'n' });
  assert.equal(r.kind, 'other');
  assert.equal(r.message, 'Claude 出错了：ok');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/claude/status.test.js bridge/test/claude/errors.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude/status.js` and for `src/claude/errors.js`.

- [ ] **Step 3: Write the modules**

Create `bridge/src/claude/status.js`:

```js
// What the bridge says about the session without asking Claude (spec 6.4, the `status` intent), and the short summary of
// a tool call that the WORKING screen shows beside the tool's name.

export const MAX_SUMMARY = 40;

function clip(text, max) {
  const chars = Array.from(String(text).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const str = (v) => (typeof v === 'string' && v.trim() ? v : '');
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// What a tool is working on, in at most `max` characters: a file's name, a search pattern, the description a Bash command
// came with (it says more than the command does) or else the command's first line, the host of a URL. '' when nothing in
// the input is worth showing. `input` comes from a model: any shape at all is possible.
export function toolSummary(name, input, max = MAX_SUMMARY) {
  const i = input !== null && typeof input === 'object' ? input : {};
  let s;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      s = str(i.description) || str(i.command).split('\n').find((l) => l.trim()) || '';
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      s = baseName(str(i.file_path));
      break;
    case 'NotebookEdit':
      s = baseName(str(i.notebook_path));
      break;
    case 'Grep':
    case 'Glob':
      s = str(i.pattern);
      break;
    case 'WebFetch':
      s = hostOf(str(i.url));
      break;
    case 'WebSearch':
      s = str(i.query);
      break;
    default:
      s = str(i.description) || str(i.command) || baseName(str(i.file_path)) || str(i.pattern) || str(i.query) || str(i.prompt);
  }
  return clip(s, max);
}

// A length of time as it is read aloud: 45秒, 3分钟, 2分15秒, 1小时, 1小时5分钟.
export function spokenElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  if (m > 0) return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
  return `${s}秒`;
}

// The sentence for the `status` intent, in the language he speaks to the device (like the other fixed phrases).
//   project    the active project's name
//   running    a claude process is alive
//   busy       a turn is under way
//   tool, summary   the last tool call of that turn, when busy
//   elapsedMs  busy: since the turn began; idle: how long the last turn took (null when there has not been one)
//   turns      busy: the number of this turn; idle: how many turns the project has had
//   resumable  there is a session id to resume
export function statusText({ project, running, busy, tool, summary, elapsedMs, turns, resumable }) {
  if (!running) return resumable ? `${project}没在运行，上次的对话还在，说话就接着做。` : `${project}没在运行，说话就开始新对话。`;
  if (busy) {
    const doing = tool ? `在用${tool}${summary ? `：${summary}` : ''}` : '还在想';
    return `${project}在忙，${doing}，已经${spokenElapsed(elapsedMs)}，这是第${turns}轮。`;
  }
  if (!turns) return `${project}已经待命，等你说话。`;
  return `${project}空闲，这个对话做了${turns}轮${elapsedMs == null ? '' : `，上一轮用了${spokenElapsed(elapsedMs)}`}。`;
}
```

Create `bridge/src/claude/errors.js`:

```js
// What went wrong with a claude run, as a kind the manager acts on and a plain sentence for the ERROR screen (spec 8:
// the screen says what to do on the PC). Written from the failures recorded on 1 Oct 2026 (claude 2.1.285):
//   login   assistant.error 'authentication_failed', result.api_error_status 401
//   model   assistant.error 'model_not_found', status 404, text "There's an issue with the selected model (X)..."
//   resume  result.subtype 'error_during_execution', errors ['No conversation found with session ID: ...']
// Rate limit, overload and a missing program were not recorded: they are matched by the same fields (`error` code, status)
// and by the words claude uses for them, and anything else shows claude's own words.

const MAX_TEXT = 50;

export const MESSAGES = {
  login: 'Claude 登录过期，回电脑上登录',
  model: 'Claude 不认这个模型，回电脑运行 claude update',
  'no-session': '找不到上次的对话，已经开了新的',
  rate: 'Claude 额度用完了，等一会儿再试',
  overloaded: 'Claude 现在太忙，等一会儿再试',
  missing: '找不到 claude 程序，回电脑检查安装',
};

const SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM']);

const lines = (words) => words.split('\n').map((l) => l.trim()).filter(Boolean);

// The first line of what claude said, short enough for the screen.
function gist(words) {
  const chars = Array.from(lines(words)[0] ?? '');
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
}

// `code`: the `error` field of the assistant message claude printed for the failure, or the code of a spawn error;
// `status`: the result's api_error_status; `text`: the result's text (or the assistant message's); `errors`: the result's
// errors list; `stderr`: the tail of what the process wrote to stderr; `exitCode`: how it ended. Whatever their types:
// they come from a process and from the network.
// Returns {kind, message}; kind is one of login, model, no-session, rate, overloaded, missing, other.
export function classifyFailure(failure) {
  const f = failure !== null && typeof failure === 'object' ? failure : {};
  const { code, status, exitCode } = f;
  const text = typeof f.text === 'string' ? f.text : '';
  const stderr = typeof f.stderr === 'string' ? f.stderr : '';
  const errors = Array.isArray(f.errors) ? f.errors.filter((e) => typeof e === 'string') : [];
  const said = [text, ...errors, stderr].join('\n');
  let kind = 'other';
  if (code === 'authentication_failed' || status === 401 || /authenticat|\/login|not logged in|oauth/i.test(said)) kind = 'login';
  else if (code === 'model_not_found' || /does not support this model|issue with the selected model|unrecognized_model|model_not_found/i.test(said)) kind = 'model';
  else if (/no conversation found/i.test(said)) kind = 'no-session';
  else if (code === 'rate_limit' || status === 429 || /rate.?limit|usage limit|limit reached|hit your limit|too many requests/i.test(said)) kind = 'rate';
  else if (code === 'overloaded' || status === 503 || status === 529 || /overloaded/i.test(said)) kind = 'overloaded';
  else if (SPAWN_ERRORS.has(code)) kind = 'missing';
  if (kind !== 'other') return { kind, message: MESSAGES[kind] };
  const words = [text, ...errors, lines(stderr).pop() ?? ''].map(gist).find(Boolean);
  if (words) return { kind, message: `Claude 出错了：${words}` };
  return { kind, message: exitCode == null || exitCode === 0 ? 'Claude 出错了' : `Claude 出错了（退出码 ${exitCode}）` };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/claude/status.test.js bridge/test/claude/errors.test.js`
Expected: PASS, 9 tests in `status.test.js` and 8 in `errors.test.js`.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/claude/status.js bridge/src/claude/errors.js bridge/test/claude/status.test.js bridge/test/claude/errors.test.js
git commit -m "Bridge: the status sentence, tool summaries and the kinds of failed run" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The approvals queue

What stands between a tool call that needs his say-so and the wrist. `preview.js` turns a call into a few lines of plain text the screen can show, `approvals.js` is the queue: one request on the screen at a time, in the order they came, each with its own clock, answered by the device's keys or denied when nobody answers. Neither knows about HTTP or about `claude`: Task 6 puts the permission server in front of the queue, plan 4 puts the screen and the keys behind it.

**Files:**
- Create: `bridge/src/perm/preview.js`, `bridge/src/perm/approvals.js`
- Test: `bridge/test/perm/preview.test.js`, `bridge/test/perm/approvals.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (`approvals.js` imports `preview.js`, made here).
- Produces:
  - `MAX_PREVIEW` (300) and `previewOf(tool, input, max = MAX_PREVIEW): string`: a few lines of plain text for the APPROVAL screen, from the input of a tool the model chose, so any shape is possible and none throws. A Bash or PowerShell call shows its command; Write shows the path, `N 字` for how long the content is, and the beginning of it; Edit shows the path and what is taken out and put in; MultiEdit the path and how many edits; NotebookEdit the path; WebFetch the URL; WebSearch the query; Task and Agent the description; a tool it does not know, or a call with nothing in it that can be shown, shows the input itself as JSON. Nothing it prints may make the call look like something it is not: control characters and the invisible format characters (zero-width ones, direction overrides, with which a command can be made to read backwards or to hide a word) show as `·`, and line breaks stay. A text over the limit shows its head and its tail with ` … ` between (two thirds head, one third tail), never the head alone, because what makes a long command dangerous is often at its end; it is cut by characters, not UTF-16 units, and a limit below 10 is raised to 10.
  - `DENY_TIMEOUT` (`手腕上没人回应，先别做。`, the words of spec §6.4), `DENY_DEFAULT` (`用户在手腕上拒绝了这个操作，不要重试。`), `DENY_ABORTED`, `DENY_SHUTDOWN` and `denyWithReason(reason)`: the messages of a denial. What Claude reads, so each says who said no and that the call should not be tried again.
  - `createApprovals({timeoutMs = 55_000}): {request, answer, denyAll, current, pending, on}`:
    - `request({tool, input, toolUseId, signal}): Promise<{behavior: 'allow'} | {behavior: 'deny', message}>`; it never rejects. It joins the queue; the first one is shown at once, the others when the ones before them are over. `signal` aborts when the client that asked has gone away: the request leaves the queue with a `clear` of outcome `aborted` (when it was only waiting the screen is not touched, when it was the one on the screen the next one comes up), and one whose client is already gone is denied without ever being shown. Each request has its own clock from the moment it arrived: after `timeoutMs` it is denied with `DENY_TIMEOUT`. That is 55 s in the bridge and must stay below the 60 s at which `claude` drops a pending call (Global Constraints).
    - `answer(id, {allow = false, reason = ''}): boolean`: the device's answer. Only the request on the screen can be answered; `false` means the answer is for one that is already over (late, unknown or repeated) and nothing changes. A denial with a reason he spoke carries it, otherwise `DENY_DEFAULT`.
    - `denyAll(message = DENY_SHUTDOWN)`: everything that is waiting is denied, the one on the screen last, so that no request shows in between.
    - `current(): {id, tool, preview, toolUseId} | null` and `pending(): number`.
    - `on('show', ({id, tool, preview, toolUseId}))`: this request is now the one on the screen. `on('clear', ({id, outcome}))`: it is finished, with `outcome` `allowed`, `denied`, `timeout` or `aborted`. The ids count up from 1, wrap round at 65535 (they travel to the device in 16 bits) and skip one that is still waiting. A tool name or an id that is not text is shown as text or as no id.

- [ ] **Step 1: Write the failing tests**

Create `bridge/test/perm/preview.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PREVIEW, previewOf } from '../../src/perm/preview.js';

test('a Bash call shows its command', () => {
  assert.equal(previewOf('Bash', { command: 'npm test', description: 'x' }), 'npm test');
  assert.equal(previewOf('PowerShell', { command: 'Get-Date' }), 'Get-Date');
  assert.equal(previewOf('Bash', { command: 'a\nb' }), 'a\nb');
});

test('a long command shows its head and its tail, so that the end cannot hide', () => {
  const command = `${'echo harmless; '.repeat(40)}rm -rf ~/important`;
  const shown = previewOf('Bash', { command });
  assert.equal(Array.from(shown).length, MAX_PREVIEW);
  assert.ok(shown.startsWith('echo harmless; echo'));
  assert.ok(shown.endsWith('rm -rf ~/important'));
  assert.ok(shown.includes(' … '));
  assert.equal(MAX_PREVIEW, 300);
});

test('a command of exactly the limit is shown whole, and one character more is cut', () => {
  assert.equal(previewOf('Bash', { command: 'x'.repeat(300) }), 'x'.repeat(300));
  const cutOne = previewOf('Bash', { command: 'x'.repeat(301) });
  assert.equal(Array.from(cutOne).length, 300);
  assert.match(cutOne, /^x+ … x+$/);
});

test('a cut command is two thirds head and one third tail', () => {
  const shown = previewOf('Bash', { command: 'H'.repeat(300) + 'T'.repeat(300) });
  assert.equal(shown, `${'H'.repeat(197)} … ${'T'.repeat(100)}`);
});

test('the limit can be changed, and a silly one is raised to something that can be read', () => {
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(100) }, 50)).length, 50);
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(100) }, 2)).length, 10);
  assert.equal(Array.from(previewOf('Bash', { command: 'y'.repeat(400) }, NaN)).length, 300);
});

test('it is cut by characters, not by UTF-16 units', () => {
  const shown = previewOf('Bash', { command: '😀'.repeat(400) });
  assert.equal(Array.from(shown).length, 300);
  assert.ok(Array.from(shown).every((ch) => ch.codePointAt(0) < 0xd800 || ch.codePointAt(0) > 0xdfff), 'no half of an emoji');
});

// Built from their code points, not written as \u escapes: the tools that write this plan scrub those escapes out of a file.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

test('control, zero-width and direction characters show as a dot, and the break between lines stays', () => {
  const shown = previewOf('Bash', { command: `ec${ZERO_WIDTH_SPACE}ho${RIGHT_TO_LEFT_OVERRIDE} hi\x07\r\nnext\tline\x1b[31m` });
  assert.equal(shown, 'ec·ho· hi·\nnext line·[31m');
  for (const hidden of [ZERO_WIDTH_SPACE, RIGHT_TO_LEFT_OVERRIDE, '\x07', '\x1b', '\r', '\t']) assert.ok(!shown.includes(hidden), JSON.stringify(hidden));
});

test('a Write shows the path, how long the content is, and its beginning', () => {
  const shown = previewOf('Write', { file_path: 'C:\\proj\\note.txt', content: 'hello walkie' });
  assert.equal(shown, 'C:\\proj\\note.txt\n12 字\nhello walkie');
  const long = previewOf('Write', { file_path: 'a.txt', content: 'z'.repeat(1000) });
  assert.match(long, /^a\.txt\n1000 字\nz+ … z+$/);
  assert.equal(Array.from(long.split('\n')[2]).length, 140);
  assert.equal(previewOf('Write', { file_path: 'a.txt', content: '一二三' }).split('\n')[1], '3 字');
  assert.equal(previewOf('Write', { file_path: 'a.txt', content: '😀😀' }).split('\n')[1], '2 字', 'an emoji is one character');
  assert.equal(previewOf('Write', { file_path: 'a.txt' }).split('\n')[1], '0 字');
});

test('an Edit shows the path and what is taken out and put in', () => {
  assert.equal(previewOf('Edit', { file_path: 'src/a.js', old_string: 'foo()', new_string: 'bar()' }), 'src/a.js\n- foo()\n+ bar()');
  const long = previewOf('Edit', { file_path: 'a.js', old_string: 'o'.repeat(500), new_string: 'n'.repeat(500) });
  const [, minus, plus] = long.split('\n');
  assert.ok(minus.startsWith('- o') && minus.includes(' … ') && plus.startsWith('+ n') && plus.includes(' … '));
  assert.equal(Array.from(minus).length, 102);
  assert.equal(Array.from(plus).length, 102);
});

test('a long path shows its beginning and its end, which has the file name', () => {
  const file_path = `C:\\${'folder\\'.repeat(30)}the-file.txt`;
  const shown = previewOf('Write', { file_path, content: 'x' }).split('\n')[0];
  assert.ok(shown.startsWith('C:\\folder') && shown.endsWith('the-file.txt') && shown.includes(' … '));
  assert.equal(Array.from(shown).length, 120);
});

test('the other tools show the one thing that matters about them', () => {
  assert.equal(previewOf('MultiEdit', { file_path: 'a.js', edits: [{}, {}, {}] }), 'a.js\n3 处修改');
  assert.equal(previewOf('MultiEdit', { file_path: 'a.js' }), 'a.js\n0 处修改');
  assert.equal(previewOf('NotebookEdit', { notebook_path: 'n.ipynb' }), 'n.ipynb');
  assert.equal(previewOf('WebFetch', { url: 'https://example.com/x', prompt: 'p' }), 'https://example.com/x');
  assert.equal(previewOf('WebSearch', { query: 'node test runner' }), 'node test runner');
  assert.equal(previewOf('Task', { description: 'Find the callers', prompt: 'p' }), 'Find the callers');
  assert.equal(previewOf('Agent', { description: 'Look around' }), 'Look around');
});

test('a tool it does not know, or a call with nothing in it that can be shown, shows the input itself', () => {
  assert.equal(previewOf('mcp__codegraph__codegraph_search', { query: 'foo', limit: 5 }), '{"query":"foo","limit":5}');
  assert.equal(previewOf('Bash', { command: 7 }), '{"command":7}');
  assert.equal(previewOf('Bash', { command: '  \n ' }), '{"command":"  \\n "}');
  assert.equal(previewOf('Bash', { command: ZERO_WIDTH_SPACE + ZERO_WIDTH_SPACE }), '{"command":"··"}');
  assert.equal(previewOf('Write', { content: 'x' }), '{"content":"x"}', 'a Write with no path is shown as it came');
  assert.equal(previewOf('Edit', { old_string: 'a', new_string: 'b' }), '{"old_string":"a","new_string":"b"}');
  for (const input of [undefined, null, 5, 'str']) {
    for (const tool of ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'Agent', 'Other']) assert.equal(previewOf(tool, input), '{}', `${tool} ${input}`);
  }
  assert.equal(previewOf('Bash', []), '[]');
});
```

Create `bridge/test/perm/approvals.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovals, DENY_ABORTED, DENY_DEFAULT, DENY_SHUTDOWN, DENY_TIMEOUT, denyWithReason } from '../../src/perm/approvals.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// An approvals queue with its events written down, on mock timers.
function setup(t, options) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const approvals = createApprovals(options);
  const log = [];
  approvals.on('show', (v) => log.push(['show', v.id]));
  approvals.on('clear', (v) => log.push(['clear', v.id, v.outcome]));
  const shown = [];
  approvals.on('show', (v) => shown.push(v));
  return { approvals, log, shown };
}
const ask = (approvals, tool = 'Write', input = { file_path: 'a.txt', content: 'x' }, extra = {}) => {
  let verdict = null;
  const done = approvals.request({ tool, input, toolUseId: 'toolu_1', ...extra }).then((v) => (verdict = v));
  return { done, get verdict() { return verdict; } };
};

test('the first request is shown at once, with its tool, preview and tool use id, and allowing it resolves the call', async (t) => {
  const { approvals, log, shown } = setup(t);
  const a = ask(approvals, 'Bash', { command: 'npm test' });
  assert.deepEqual(shown, [{ id: 1, tool: 'Bash', preview: 'npm test', toolUseId: 'toolu_1' }]);
  assert.deepEqual(approvals.current(), shown[0]);
  assert.equal(approvals.pending(), 1);
  assert.equal(approvals.answer(1, { allow: true }), true);
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'allow' });
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']]);
  assert.equal(approvals.current(), null);
  assert.equal(approvals.pending(), 0);
});

test('a denial says who refused and not to try again, and carries the reason he spoke, if he did', async (t) => {
  const { approvals } = setup(t);
  const plain = ask(approvals);
  approvals.answer(1, { allow: false });
  await plain.done;
  assert.deepEqual(plain.verdict, { behavior: 'deny', message: DENY_DEFAULT });
  assert.match(DENY_DEFAULT, /不要重试/);
  const spoken = ask(approvals);
  approvals.answer(2, { reason: '  先别动 package.json  ' });
  await spoken.done;
  assert.deepEqual(spoken.verdict, { behavior: 'deny', message: '用户在手腕上拒绝了这个操作，理由：先别动 package.json' });
  assert.equal(denyWithReason('x'), '用户在手腕上拒绝了这个操作，理由：x');
  const blank = ask(approvals);
  approvals.answer(3, { allow: false, reason: '   ' });
  await blank.done;
  assert.equal(blank.verdict.message, DENY_DEFAULT);
  const odd = ask(approvals);
  approvals.answer(4, { reason: 7 });
  await odd.done;
  assert.equal(odd.verdict.message, DENY_DEFAULT);
  const bare = ask(approvals);
  approvals.answer(5);
  await bare.done;
  assert.equal(bare.verdict.message, DENY_DEFAULT);
});

test('with no answer it is denied after the timeout with the words of the spec, and the screen is told', async (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 55_000 });
  const a = ask(approvals);
  t.mock.timers.tick(54_999);
  await settle();
  assert.equal(a.verdict, null);
  t.mock.timers.tick(1);
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: '手腕上没人回应，先别做。' });
  assert.equal(DENY_TIMEOUT, '手腕上没人回应，先别做。');
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'timeout']]);
});

test('the wait is 55 s unless told otherwise, and an answer stops the clock', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals);
  t.mock.timers.tick(54_000);
  approvals.answer(1, { allow: true });
  await a.done;
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']], 'nothing happens after the answer');
  const b = ask(approvals);
  t.mock.timers.tick(55_000);
  await b.done;
  assert.equal(b.verdict.message, DENY_TIMEOUT);
});

test('every way a request ends stops its clock', async (t) => {
  const { approvals } = setup(t);
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const gone = new AbortController();
  const list = [ask(approvals), ask(approvals, 'Write', {}, { signal: gone.signal }), ask(approvals), ask(approvals)];
  approvals.answer(1, { allow: true });
  gone.abort();
  approvals.denyAll();
  await Promise.all(list.map((x) => x.done));
  assert.equal(cleared.mock.callCount(), 4);
});

test('requests wait their turn: one on the screen, the next shown when it is answered, in the order they came', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals, 'Write', { file_path: 'one' });
  const b = ask(approvals, 'Write', { file_path: 'two' });
  const c = ask(approvals, 'Write', { file_path: 'three' });
  assert.deepEqual(log, [['show', 1]], 'only the first is shown');
  assert.equal(approvals.pending(), 3);
  assert.equal(approvals.answer(2, { allow: true }), false, 'the one that is not on the screen cannot be answered');
  assert.equal(approvals.answer(1, { allow: true }), true);
  await a.done;
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed'], ['show', 2]]);
  assert.match(approvals.current().preview, /^two/);
  approvals.answer(2, { allow: false });
  approvals.answer(3, { allow: true });
  await Promise.all([b.done, c.done]);
  assert.deepEqual(log.slice(3), [['clear', 2, 'denied'], ['show', 3], ['clear', 3, 'allowed']]);
  assert.deepEqual([a.verdict.behavior, b.verdict.behavior, c.verdict.behavior], ['allow', 'deny', 'allow']);
});

test('each request has its own clock, from the moment it arrived', async (t) => {
  const { approvals, log } = setup(t);
  const a = ask(approvals);
  t.mock.timers.tick(30_000);
  const b = ask(approvals);
  t.mock.timers.tick(25_000); // 55 s since a, 25 since b
  await a.done;
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'timeout'], ['show', 2]]);
  assert.equal(b.verdict, null);
  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(b.verdict, null);
  t.mock.timers.tick(1);
  await b.done;
  assert.equal(b.verdict.message, DENY_TIMEOUT);
});

test('an answer that is late, unknown or for a request that is not on the screen changes nothing', async (t) => {
  const { approvals, log } = setup(t);
  assert.equal(approvals.answer(1, { allow: true }), false);
  const a = ask(approvals);
  assert.equal(approvals.answer(99, { allow: true }), false);
  assert.equal(approvals.answer('1', { allow: true }), false);
  approvals.answer(1, { allow: true });
  await a.done;
  assert.equal(approvals.answer(1, { allow: false }), false, 'the same request answered twice');
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'allowed']]);
});

test('a client that goes away takes its request off the screen, and the next one comes up', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  const a = ask(approvals, 'Write', { file_path: 'one' }, { signal: gone.signal });
  const b = ask(approvals, 'Write', { file_path: 'two' });
  gone.abort();
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: DENY_ABORTED });
  assert.deepEqual(log, [['show', 1], ['clear', 1, 'aborted'], ['show', 2]]);
  assert.equal(b.verdict, null);
  assert.equal(approvals.pending(), 1);
});

test('a request that is waiting behind another and is abandoned leaves quietly', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  ask(approvals, 'Write', { file_path: 'one' });
  const b = ask(approvals, 'Write', { file_path: 'two' }, { signal: gone.signal });
  gone.abort();
  await b.done;
  assert.deepEqual(log, [['show', 1], ['clear', 2, 'aborted']], 'the screen is not touched');
  assert.equal(approvals.current().id, 1);
  assert.equal(approvals.pending(), 1);
});

test('a request whose client is already gone is denied without ever being shown', async (t) => {
  const { approvals, log } = setup(t);
  const gone = new AbortController();
  gone.abort();
  const a = ask(approvals, 'Write', {}, { signal: gone.signal });
  await a.done;
  assert.deepEqual(a.verdict, { behavior: 'deny', message: DENY_ABORTED });
  assert.deepEqual(log, []);
  assert.equal(approvals.pending(), 0);
});

test('an answer takes the abort listener off the signal, so a client that lives long does not collect them', async (t) => {
  const { approvals } = setup(t);
  const controller = new AbortController();
  let removed = 0;
  const original = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => (removed++, original(...args));
  const a = ask(approvals, 'Write', {}, { signal: controller.signal });
  approvals.answer(1, { allow: true });
  await a.done;
  assert.equal(removed, 1);
  controller.abort();
  await settle();
  assert.equal(a.verdict.behavior, 'allow', 'an abort after the answer does nothing');
});

test('denyAll refuses everything that is waiting, the one on the screen last, with the message given', async (t) => {
  const { approvals, log } = setup(t);
  const list = [ask(approvals), ask(approvals), ask(approvals)];
  approvals.denyAll('关机了');
  await Promise.all(list.map((x) => x.done));
  assert.deepEqual(list.map((x) => x.verdict), Array(3).fill({ behavior: 'deny', message: '关机了' }));
  assert.deepEqual(log, [['show', 1], ['clear', 3, 'denied'], ['clear', 2, 'denied'], ['clear', 1, 'denied']], 'no request is shown on the way');
  assert.equal(approvals.pending(), 0);
  const later = ask(approvals);
  approvals.denyAll();
  await later.done;
  assert.equal(later.verdict.message, DENY_SHUTDOWN);
  approvals.denyAll();
});

test('the ids count up from 1, wrap round at 65535 and skip one that is still waiting', (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 10 ** 9 });
  ask(approvals); // id 1 stays waiting at the head
  const passThrough = () => {
    const gone = new AbortController();
    ask(approvals, 'Write', {}, { signal: gone.signal });
    gone.abort(); // a request that waits behind the head can leave on its own
    return log.at(-1)[1];
  };
  let expected = 2;
  for (; expected <= 65534; expected++) {
    const id = passThrough();
    if (id !== expected) assert.fail(`the id after ${expected - 1} was ${id}, not ${expected}`);
  }
  assert.equal(passThrough(), 65535);
  assert.equal(passThrough(), 2, 'it went round, and passed the 1 that is still waiting');
  assert.equal(passThrough(), 3);
  assert.equal(approvals.current().id, 1);
});

test('when the one that waited is gone its id comes round again', async (t) => {
  const { approvals, log } = setup(t, { timeoutMs: 10 ** 9 });
  const first = ask(approvals);
  approvals.answer(1, { allow: true });
  await first.done;
  const second = ask(approvals);
  assert.equal(approvals.current().id, 2);
  approvals.answer(2, { allow: true });
  await second.done;
  assert.deepEqual(log.filter((e) => e[0] === 'show').map((e) => e[1]), [1, 2]);
});

test('a request with no tool or input is shown as it came, and its fields are text', (t) => {
  const { approvals, shown } = setup(t);
  approvals.request({});
  assert.deepEqual(shown[0], { id: 1, tool: '', preview: '{}', toolUseId: '' });
  approvals.denyAll();
});

test('a tool use id that is missing, null or not text is shown as no id, and a tool name that is not text as text', (t) => {
  const { approvals, shown } = setup(t);
  for (const toolUseId of [undefined, null, 5, {}]) {
    approvals.request({ tool: 'Write', input: {}, toolUseId });
    approvals.denyAll();
  }
  approvals.request({ tool: 'Write', input: {}, toolUseId: 'toolu_7' });
  approvals.denyAll();
  assert.deepEqual(shown.map((v) => v.toolUseId), ['', '', '', '', 'toolu_7']);
  approvals.request({ tool: 5, input: {} });
  assert.equal(shown.at(-1).tool, '5');
  approvals.denyAll();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/perm/preview.test.js bridge/test/perm/approvals.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/perm/preview.js` and for `src/perm/approvals.js`.

- [ ] **Step 3: Write the modules**

Create `bridge/src/perm/preview.js`:

```js
// What the APPROVAL screen shows of a tool call (spec 6.2, 6.4): a few lines of plain text the wrist can read, from the
// input of a tool the model chose. Nothing it prints may make the call look like something it is not.

export const MAX_PREVIEW = 300;

const MIN_MAX = 10;
const PATH_MAX = 120;
const BODY_MAX = 140;
const SIDE_MAX = 100;

// Control characters and the invisible format characters (zero-width, direction overrides: a command can be made to read
// backwards or to hide a word with them) become a visible dot; tabs become a space; line breaks stay.
function plain(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? c : '·'));
}

// Too long: the head and the tail with a gap between, never the head alone, because what makes a long command dangerous is
// often at its end. The result is `max` characters, counted as characters rather than UTF-16 units.
function cut(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${chars.slice(0, max - tail - 3).join('')} … ${chars.slice(chars.length - tail).join('')}`;
}

const str = (v) => (typeof v === 'string' ? plain(v) : '');
const count = (v) => (typeof v === 'string' ? Array.from(v).length : 0);

// The preview of `input` for `tool`, at most `max` characters. `input` is whatever the model sent.
export function previewOf(tool, input, max = MAX_PREVIEW) {
  const limit = Math.max(MIN_MAX, Number.isFinite(max) ? Math.floor(max) : MAX_PREVIEW);
  const i = input !== null && typeof input === 'object' ? input : {};
  let main = ''; // what the call is about: without it the input itself is shown
  let text = '';
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      main = text = str(i.command);
      break;
    case 'Write':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `${count(i.content)} 字`, cut(str(i.content), BODY_MAX)].join('\n');
      break;
    case 'Edit':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `- ${cut(str(i.old_string), SIDE_MAX)}`, `+ ${cut(str(i.new_string), SIDE_MAX)}`].join('\n');
      break;
    case 'MultiEdit':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `${Array.isArray(i.edits) ? i.edits.length : 0} 处修改`].join('\n');
      break;
    case 'NotebookEdit':
      main = text = cut(str(i.notebook_path), PATH_MAX);
      break;
    case 'WebFetch':
      main = text = str(i.url);
      break;
    case 'WebSearch':
      main = text = str(i.query);
      break;
    case 'Task':
    case 'Agent':
      main = text = str(i.description);
      break;
    default:
  }
  if (!main.replace(/[\s·]/g, '')) text = plain(JSON.stringify(i));
  return cut(text, limit);
}
```

Create `bridge/src/perm/approvals.js`:

```js
// The queue of tool calls waiting for his yes or no (spec 6.4). One is shown on the device at a time, in the order they came;
// each is denied on its own if nobody answers in time. The permission server asks, the device's keys answer, and the
// device layer listens to 'show' and 'clear' to know what to put on the APPROVAL screen.
//
//   'show'  {id, tool, preview, toolUseId}   this request is now the one on the screen
//   'clear' {id, outcome}                    it is finished: 'allowed', 'denied', 'timeout' or 'aborted'
//
// The verdicts are the permission tool's: {behavior: 'allow'} or {behavior: 'deny', message}. The message of a denial is
// what Claude reads, so it says who said no and that the call should not be tried again.
import { EventEmitter } from 'node:events';
import { previewOf } from './preview.js';

export const DENY_TIMEOUT = '手腕上没人回应，先别做。';
export const DENY_DEFAULT = '用户在手腕上拒绝了这个操作，不要重试。';
export const DENY_ABORTED = '这个请求已经取消了。';
export const DENY_SHUTDOWN = 'walkie 关闭了，先别做。';
export const denyWithReason = (reason) => `用户在手腕上拒绝了这个操作，理由：${reason}`;

const MAX_ID = 65535; // the id travels to the device in 16 bits

const deny = (message) => ({ behavior: 'deny', message });

// `timeoutMs`: how long a request waits for an answer, counted from its arrival. Claude's own client gives up on a pending
// tool call at about 60 s and then tries the call again, so this must stay below that (config claude.approvalTimeoutSec).
export function createApprovals({ timeoutMs = 55_000 } = {}) {
  const events = new EventEmitter();
  const queue = []; // the head is the one on the screen
  let nextId = 1;

  const view = (req) => ({ id: req.id, tool: req.tool, preview: req.preview, toolUseId: req.toolUseId });

  function newId() {
    for (let tries = 0; tries < MAX_ID; tries++) {
      const id = nextId;
      nextId = nextId === MAX_ID ? 1 : nextId + 1;
      if (!queue.some((r) => r.id === id)) return id;
    }
    throw new Error('too many approvals are waiting');
  }

  function finish(req, verdict, outcome) {
    const at = queue.indexOf(req);
    if (at < 0) return;
    queue.splice(at, 1);
    clearTimeout(req.timer);
    req.signal?.removeEventListener('abort', req.onAbort);
    req.resolve(verdict);
    events.emit('clear', { id: req.id, outcome });
    if (at === 0 && queue.length > 0) events.emit('show', view(queue[0]));
  }

  // A promise of the verdict; it never rejects. `signal` aborts when the client that asked has gone away.
  function request({ tool, input, toolUseId, signal } = {}) {
    if (signal?.aborted) return Promise.resolve(deny(DENY_ABORTED));
    return new Promise((resolve) => {
      const req = { id: newId(), tool: String(tool ?? ''), preview: previewOf(tool, input), toolUseId: typeof toolUseId === 'string' ? toolUseId : '', resolve, signal };
      req.timer = setTimeout(() => finish(req, deny(DENY_TIMEOUT), 'timeout'), timeoutMs);
      req.onAbort = () => finish(req, deny(DENY_ABORTED), 'aborted');
      signal?.addEventListener('abort', req.onAbort, { once: true });
      queue.push(req);
      if (queue.length === 1) events.emit('show', view(req));
    });
  }

  // The answer from the device: `allow`, or a denial with the reason he spoke, if he did. Only the request on the screen can
  // be answered; false means this answer is for one that is already over.
  function answer(id, { allow = false, reason = '' } = {}) {
    const req = queue[0];
    if (!req || req.id !== id) return false;
    const verdict = allow ? { behavior: 'allow' } : deny(typeof reason === 'string' && reason.trim() ? denyWithReason(reason.trim()) : DENY_DEFAULT);
    finish(req, verdict, allow ? 'allowed' : 'denied');
    return true;
  }

  // Everything that is waiting is denied with `message`, the one on the screen last, so that no request ever shows in between.
  function denyAll(message = DENY_SHUTDOWN) {
    for (const req of [...queue].reverse()) finish(req, deny(message), 'denied');
  }

  return {
    request,
    answer,
    denyAll,
    current: () => (queue.length > 0 ? view(queue[0]) : null),
    pending: () => queue.length,
    on: (name, listener) => events.on(name, listener),
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/perm/preview.test.js bridge/test/perm/approvals.test.js`
Expected: PASS, 12 tests in `preview.test.js` and 17 in `approvals.test.js`.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/perm/preview.js bridge/src/perm/approvals.js bridge/test/perm/preview.test.js bridge/test/perm/approvals.test.js
git commit -m "Bridge: the queue of tool calls waiting for his yes or no, and what the screen shows of one" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The permission server

`claude` is started with `--permission-prompt-tool mcp__walkie__approve`. Whenever one of his permission rules does not settle a tool call, it calls that MCP tool and does what the answer says. This task is the other end of that call: a small MCP server over HTTP on 127.0.0.1 that offers the one tool, hands every request to a `decide` function (Task 5's queue, in the bridge) and answers with its verdict.

It is written by hand rather than with the MCP SDK (departure 2 in the header). The recording of 1 Oct 2026 shows what the real client sends, in this order: `server/discover` (it takes the -32601 and goes on), `initialize`, `notifications/initialized` (answered 202), a GET (405 is fine), `tools/list`, and then `tools/call`. Plain JSON answers are enough, no event stream.

Anyone on this PC can reach a port on 127.0.0.1, and what answers here decides whether a tool runs, so the server refuses everything that is not Claude Code: it needs the bearer token made for this run, a `Host` that names this server (a web page can be made to reach 127.0.0.1 under another name), no `Origin` header (a web page always sends one; an MCP client never does), and only `POST /mcp` with a JSON body is served.

**Files:**
- Create: `bridge/src/perm/server.js`
- Create (test helper): `bridge/test/helpers/mcp-client.js`
- Test: `bridge/test/perm/server.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks. `decide` is passed in; the helper below is for tests.
- Produces:
  - `SERVER_NAME` (`'walkie'`), `TOOL_NAME` (`'approve'`), `DENIED` (the message of a denial that carries none), `MAX_BODY` (32 MB: a Write of a big file arrives whole), `PROTOCOLS` (the protocol versions it speaks, newest first; the client's own pick is echoed when it is listed) and `APPROVE_TOOL` (the tool's definition: arguments `tool_name`, `input` and `tool_use_id`).
  - `createPermServer({decide, token = <32 random bytes, hex>, host = '127.0.0.1', port = 0, maxBody = MAX_BODY, log = () => {}}): {token, waiting(), start(): Promise<{url, token}>, close(): Promise<void>}`. `start()` listens and resolves with the URL for `--mcp-config` (`http://127.0.0.1:<port>/mcp`). `close()` aborts the signal of every request still waiting, before it resolves, drops every connection, and is fine on a server that was never started; a port that is taken is an error from `start()`. `waiting()` counts the requests read and not yet answered.
  - `decide({tool, input, toolUseId, signal}): Promise<{behavior: 'allow'} | {behavior: 'deny', message}>`. `signal` aborts when Claude Code hangs up before an answer, or when the server closes; nothing is answered or logged for a request that was abandoned. An allow is answered as `{behavior: 'allow', updatedInput: <the input as it was asked>}`, a deny as `{behavior: 'deny', message}`, and anything that is not a clear allow, including a `decide` that throws, is a denial: the server fails closed, and says in the message why it could not ask. Two calls asked at once wait for their answers independently.
  - Refusals: a wrong or missing token is 401, a `Host` that does not name this server or any `Origin` is 403, another path 404, another method 405, another content type 415, a body over `maxBody` 413 (the rest of it is thrown away as it arrives, so that the refusal can still be sent), a body that is not JSON is a JSON-RPC parse error (400) and a JSON value that is not a message an invalid request. Each refusal closes the connection, so one that leaves a body unread cannot break a connection the client means to reuse. A request that is not well formed is an error of the protocol, never a question for the device. A batch is answered with an array, in order, without an answer for a notification.
  - The log line has the tool's name and the outcome (`perm: Write allowed`), never what the tool was given.
  - Test helper `bridge/test/helpers/mcp-client.js`: `rawRequest({port, method, path, headers, body, agent, signal})`, a plain `http` request (`fetch` will not let a test set `Host` or hang up half way), and `mcpClient({url, token, agent})`, the small part of an MCP client that walkie answers: `{port, post, rpc, notify, initialize, approve}`.

- [ ] **Step 1: Write the helper and the failing test**

Create `bridge/test/helpers/mcp-client.js`:

```js
// Test helper: talking to the permission server the way Claude Code does, over HTTP on 127.0.0.1.
// `rawRequest` is a plain http request, because fetch will not let a test set Host or hang up half way.
// `mcpClient` is the small part of an MCP client that walkie answers.
import http from 'node:http';

export function rawRequest({ port, method = 'POST', path = '/mcp', headers = {}, body, agent, signal }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const lengthHeader = data === null ? {} : { 'content-length': Buffer.byteLength(data) };
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, signal, headers: { ...lengthHeader, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

export function mcpClient({ url, token, agent }) {
  const { port } = new URL(url);
  let id = 0;
  const headersFor = (extra) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...extra });
  const post = (body, extra = {}, signal) => rawRequest({ port, headers: headersFor(extra), body, agent, signal });
  const rpc = async (method, params, signal) => (await post({ jsonrpc: '2.0', id: ++id, method, params }, {}, signal)).json();
  return {
    port,
    post,
    rpc,
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }),
    initialize: () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
    // Asks the permission tool and returns the verdict it answered, as an object.
    async approve(args, signal) {
      const reply = await rpc('tools/call', { name: 'approve', arguments: args }, signal);
      return JSON.parse(reply.result.content[0].text);
    },
  };
}
```

Create `bridge/test/perm/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { APPROVE_TOOL, createPermServer, DENIED, PROTOCOLS, SERVER_NAME } from '../../src/perm/server.js';
import { mcpClient, rawRequest } from '../helpers/mcp-client.js';

const ALLOW = async () => ({ behavior: 'allow' });

// A server on a free port whose answers come from `decide`, with what it logged and a client that knows its token.
async function serve(t, decide = ALLOW, options = {}) {
  const logs = [];
  const server = createPermServer({ decide, log: (line) => logs.push(line), ...options });
  const { url, token } = await server.start();
  t.after(() => server.close());
  return { server, url, token, logs, port: new URL(url).port, client: mcpClient({ url, token }) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const until = async (ok, what) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), what);
};

test('start gives the URL for --mcp-config, on 127.0.0.1, and a token no other server shares', async (t) => {
  const a = await serve(t);
  const b = await serve(t);
  assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.port, b.port);
  assert.equal(a.server.token, a.token);
});

test('the handshake of the real client: initialize, the initialized notification, tools/list', async (t) => {
  const { client } = await serve(t);
  const init = await client.initialize();
  assert.deepEqual(init, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'walkie', version: '0.1.0' } } });
  const note = await client.notify('notifications/initialized');
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  const list = await client.rpc('tools/list');
  assert.deepEqual(list.result, { tools: [APPROVE_TOOL] });
  assert.deepEqual(APPROVE_TOOL.inputSchema.required, ['tool_name', 'input']);
  assert.equal(SERVER_NAME, 'walkie');
  assert.deepEqual((await client.rpc('ping')).result, {});
});

test('it answers with the protocol version the client asks for if it knows it, and its newest if not', async (t) => {
  const { client } = await serve(t);
  for (const version of PROTOCOLS) assert.equal((await client.rpc('initialize', { protocolVersion: version })).result.protocolVersion, version);
  for (const odd of ['2099-01-01', '', 7, null, undefined]) assert.equal((await client.rpc('initialize', { protocolVersion: odd })).result.protocolVersion, PROTOCOLS[0], String(odd));
  assert.equal((await client.rpc('initialize')).result.protocolVersion, PROTOCOLS[0]);
});

test('the discovery call the real client makes first gets the plain answer for a method that does not exist', async (t) => {
  const { client } = await serve(t);
  const res = await client.post({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not found: server/discover' } });
});

test('an allowed call is answered with the input it was given, and decide is told what was asked', async (t) => {
  const asked = [];
  const { client } = await serve(t, async (request) => (asked.push(request), { behavior: 'allow' }));
  const input = { file_path: 'C:\\proj\\note.txt', content: '你好 walkie' };
  assert.deepEqual(await client.approve({ tool_name: 'Write', input, tool_use_id: 'toolu_01' }), { behavior: 'allow', updatedInput: input });
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], signal: undefined }, { tool: 'Write', input, toolUseId: 'toolu_01', signal: undefined });
  assert.ok(asked[0].signal instanceof AbortSignal);
  assert.equal(asked[0].signal.aborted, false);
});

test('a denied call carries the message, and any answer that is not a clear allow is a denial', async (t) => {
  let verdict;
  const { client } = await serve(t, async () => verdict);
  const ask = () => client.approve({ tool_name: 'Bash', input: { command: 'rm -rf /' } });
  verdict = { behavior: 'deny', message: '手腕上没人回应，先别做。' };
  assert.deepEqual(await ask(), { behavior: 'deny', message: '手腕上没人回应，先别做。' });
  for (const odd of [{ behavior: 'deny' }, { behavior: 'deny', message: '' }, { behavior: 'maybe' }, { behavior: 'ALLOW' }, {}, undefined, null, 'allow', true]) {
    verdict = odd;
    assert.deepEqual(await ask(), { behavior: 'deny', message: DENIED }, JSON.stringify(odd));
  }
  assert.equal(DENIED, '用户没有允许这个操作。');
});

test('when decide throws, the answer is a denial that says so, and it is logged', async (t) => {
  const { client, logs } = await serve(t, async () => {
    throw new Error('the device is gone');
  });
  assert.deepEqual(await client.approve({ tool_name: 'Write', input: {} }), { behavior: 'deny', message: 'walkie 没能问你：the device is gone' });
  assert.deepEqual(logs, ['perm: could not ask about Write: the device is gone', 'perm: Write denied']);
});

test('the log has the tool and the outcome and never what the tool was given', async (t) => {
  const { client, logs } = await serve(t, async ({ tool }) => (tool === 'Write' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' }));
  await client.approve({ tool_name: 'Write', input: { content: 'SECRET-CONTENT' } });
  await client.approve({ tool_name: 'Bash', input: { command: 'echo SECRET-COMMAND' } });
  assert.deepEqual(logs, ['perm: Write allowed', 'perm: Bash denied']);
});

test('a call that is not well formed is an error of the protocol, not a question for the device', async (t) => {
  let asked = 0;
  const { client } = await serve(t, async () => (asked++, { behavior: 'allow' }));
  const call = (args, name = 'approve') => client.rpc('tools/call', { name, arguments: args });
  for (const args of [undefined, null, {}, { tool_name: '' }, { tool_name: 5 }, { tool_name: 'Write', input: [] }, { tool_name: 'Write', input: null }, { tool_name: 'Write', input: 'x' }]) {
    const reply = await call(args);
    assert.equal(reply.error?.code, -32602, JSON.stringify(args));
  }
  assert.match((await call({ tool_name: 'Write', input: {} }, 'other')).error.message, /unknown tool other/);
  assert.equal((await client.rpc('tools/call')).error.code, -32602);
  assert.equal((await client.rpc('resources/list')).error.code, -32601);
  assert.equal(asked, 0);
});

test('an input that is left out is an empty one, and a tool use id that is not text is none', async (t) => {
  const asked = [];
  const { client } = await serve(t, async (request) => (asked.push(request), { behavior: 'allow' }));
  assert.deepEqual(await client.approve({ tool_name: 'Glob' }), { behavior: 'allow', updatedInput: {} });
  await client.approve({ tool_name: 'Glob', input: {}, tool_use_id: 7 });
  await client.approve({ tool_name: 'Glob', input: {}, tool_use_id: 'toolu_9' });
  assert.deepEqual(asked.map((a) => a.toolUseId), [null, null, 'toolu_9']);
});

test('a request without the token, or with the wrong one, is refused before anything is read', async (t) => {
  const { token, port } = await serve(t);
  const send = (authorization) => rawRequest({ port, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  for (const authorization of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Bearer ${'0'.repeat(64)}`, `Basic ${token}`, `Basic  ${token}`, token]) {
    const res = await send(authorization);
    assert.equal(res.status, 401, String(authorization));
    assert.equal(res.headers['www-authenticate'], 'Bearer');
    assert.equal(res.headers.connection, 'close');
  }
  assert.equal((await send(`Bearer ${token}`)).status, 200);
});

test('a request that names another host is refused even with the right token, and localhost is a name for this one', async (t) => {
  const { token, port } = await serve(t);
  const send = (host) => rawRequest({ port, headers: { host, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, '127.0.0.1', 'localhost', `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`]) {
    assert.equal((await send(host)).status, 403, host);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) assert.equal((await send(host)).status, 200, host);
});

test('a request with an Origin header, which only a browser sends, is refused', async (t) => {
  const { client } = await serve(t);
  const res = await client.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.connection, 'close');
});

test('only POST to /mcp with a JSON body is served, and the refusals close the connection', async (t) => {
  const { token, port } = await serve(t);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const check = async (options, status) => {
    const res = await rawRequest({ port, headers, body, ...options });
    assert.equal(res.status, status, JSON.stringify(options));
    if (status >= 400) assert.equal(res.headers.connection, 'close');
    return res;
  };
  for (const path of ['/', '/other', '/mcp/', '/mcpx', '/%6dcp']) await check({ path }, 404);
  await check({ path: '/mcp?session=1' }, 200);
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await check({ method }, 405)).headers.allow, 'POST');
  await check({ headers: { authorization: headers.authorization, 'content-type': 'text/plain' } }, 415);
  await check({ headers: { authorization: headers.authorization } }, 415);
  await check({ headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } }, 200);
  await check({ headers: { ...headers, 'content-type': 'APPLICATION/JSON' } }, 200);
  await check({ headers: { ...headers, 'content-type': 'application/jsonx' } }, 415);
  await check({ headers: { ...headers, 'content-type': 'text/application/json' } }, 415);
});

test('a body that is not JSON is a parse error, and a JSON value that is not a message is an invalid request', async (t) => {
  const { client } = await serve(t);
  const bad = await client.post('{"jsonrpc": "2.0", "id": 1, "method": ');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  for (const text of ['5', 'null', '"x"', 'true', '{}', '{"jsonrpc":"1.0","id":1,"method":"ping"}']) {
    const res = await client.post(text);
    assert.equal(res.status, 200, text);
    assert.equal(res.json().error.code, -32600, text);
  }
});

test('a batch is answered with an array, in order, without an answer for a notification', async (t) => {
  const { client } = await serve(t);
  const res = await client.post([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().map((r) => r.id), [1, 'b']);
  const notes = await client.post([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }]);
  assert.equal(notes.status, 202);
  assert.equal((await client.post({ jsonrpc: '2.0', id: 3, result: {} })).status, 202, 'a reply to a request we never made is ignored');
});

test('a body over the limit is refused with 413 and the next request still works', async (t) => {
  const { client, token, port } = await serve(t, ALLOW, { maxBody: 1000 });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2000) } });
  const res = await rawRequest({ port, agent, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: big });
  assert.equal(res.status, 413);
  assert.equal(res.json().error.code, -32600);
  assert.equal((await client.rpc('ping')).result !== undefined, true);
  const small = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'y'.repeat(300) } });
  assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: small })).status, 200);
});

test('a body of exactly the limit is served and one byte more is not', async (t) => {
  const { token, port } = await serve(t, ALLOW, { maxBody: 1000 });
  const bodyOf = (bytes) => {
    const empty = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: '' } });
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(bytes - Buffer.byteLength(empty)) } });
  };
  const send = (body) => rawRequest({ port, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
  assert.equal(Buffer.byteLength(bodyOf(1000)), 1000);
  assert.equal((await send(bodyOf(1000))).status, 200);
  assert.equal((await send(bodyOf(1001))).status, 413);
});

test('a big Write gets through whole', async (t) => {
  const seen = [];
  const { client } = await serve(t, async ({ input }) => (seen.push(input.content.length), { behavior: 'allow' }));
  const content = 'a'.repeat(3 * 1024 * 1024);
  const verdict = await client.approve({ tool_name: 'Write', input: { file_path: 'big.txt', content } });
  assert.equal(seen[0], content.length);
  assert.equal(verdict.updatedInput.content.length, content.length);
});

test('requests wait for their answers independently, so two tools asked at once are answered each in its own time', async (t) => {
  const waiting = new Map();
  const { client } = await serve(t, ({ tool }) => new Promise((resolve) => waiting.set(tool, resolve)));
  const first = client.approve({ tool_name: 'Write', input: {} });
  const second = client.approve({ tool_name: 'Bash', input: {} });
  await until(() => waiting.size === 2, 'both requests reached decide');
  waiting.get('Bash')({ behavior: 'deny', message: 'second first' });
  assert.deepEqual(await second, { behavior: 'deny', message: 'second first' });
  waiting.get('Write')({ behavior: 'allow' });
  assert.equal((await first).behavior, 'allow');
});

test('the server knows how many requests wait for an answer: while they wait, and no more once they are answered, refused or abandoned', async (t) => {
  const waiting = new Map();
  const { server, client } = await serve(t, ({ tool }) => new Promise((resolve) => waiting.set(tool, resolve)));
  assert.equal(server.waiting(), 0);
  const first = client.approve({ tool_name: 'Write', input: {} });
  const hangUp = new AbortController();
  const second = client.approve({ tool_name: 'Bash', input: {} }, hangUp.signal);
  second.catch(() => {});
  await until(() => waiting.size === 2, 'both requests reached decide');
  assert.equal(server.waiting(), 2);
  waiting.get('Write')({ behavior: 'allow' });
  await first;
  assert.equal(server.waiting(), 1);
  hangUp.abort();
  await until(() => server.waiting() === 0, 'the abandoned request is no longer counted');
  assert.equal((await client.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'x' })).status, 403);
  assert.equal(server.waiting(), 0);
  await client.rpc('ping');
  assert.equal(server.waiting(), 0);
});

test('when the client hangs up before an answer, the signal given to decide aborts and nothing is answered or logged', async (t) => {
  let signal = null;
  const { client, logs } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise(() => {});
  });
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await until(() => signal !== null, 'decide was asked');
  assert.equal(signal.aborted, false);
  hangUp.abort();
  await assert.rejects(pending);
  await until(() => signal.aborted, 'the signal aborted');
  await settle();
  assert.deepEqual(logs, []);
});

test('a decide that throws because the client left is not logged as a failure', async (t) => {
  const { client, logs } = await serve(t, ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  hangUp.abort();
  await assert.rejects(pending);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(logs, []);
});

test('a decide that answers when the client has left, as the approvals queue does, is not logged as an answer', async (t) => {
  let signal = null;
  const { client, logs } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise((resolve) => s.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'gone' })));
  });
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await until(() => signal !== null, 'decide was asked');
  hangUp.abort();
  await assert.rejects(pending);
  await until(() => signal.aborted, 'the signal aborted');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(logs, []);
});

test('a refusal that leaves a body unread does not break the connection the client keeps open', async (t) => {
  const { token, port, client } = await serve(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const refused = await rawRequest({ port, agent, method: 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(refused.status, 405);
  const next = await rawRequest({ port, agent, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 2, method: 'ping' } });
  assert.equal(next.status, 200);
  assert.equal((await client.rpc('ping')).result !== undefined, true);
});

test('closing the server aborts the requests still waiting and ends the listening', async (t) => {
  let signal = null;
  const { server, client, port } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise(() => {});
  });
  const pending = client.approve({ tool_name: 'Write', input: {} });
  pending.catch(() => {});
  await until(() => signal !== null, 'decide was asked');
  await server.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(pending);
  await assert.rejects(rawRequest({ port, body: {} }), /ECONNREFUSED/);
  await server.close();
});

test('closing a server that was never started is fine, and a port that is taken is an error from start', async (t) => {
  await createPermServer({ decide: ALLOW }).close();
  const { port } = await serve(t);
  const second = createPermServer({ decide: ALLOW, port: Number(port) });
  await assert.rejects(second.start(), (err) => err.code === 'EADDRINUSE');
});

test('a fixed token can be given, and a request is only as good as that token', async (t) => {
  const { client, token } = await serve(t, ALLOW, { token: 'fixed-token-for-this-test' });
  assert.equal(token, 'fixed-token-for-this-test');
  assert.equal((await client.initialize()).result.serverInfo.name, 'walkie');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test bridge/test/perm/server.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/perm/server.js`.

- [ ] **Step 3: Write the server**

Create `bridge/src/perm/server.js`:

```js
// The permission endpoint Claude Code calls through `--permission-prompt-tool mcp__walkie__approve`: a small MCP server over
// Streamable HTTP on 127.0.0.1 (spec 6.3, 6.4). It answers with plain JSON, offers one tool, and knows nothing about the
// device: `decide` is handed every request and says what to answer. Anything Claude Code sends that is not on the short
// list below is refused. Written to what the real client does (claude 2.1.285, recorded 1 Oct 2026): it asks `server/discover`
// first and takes the -32601, then `initialize`, `notifications/initialized` (answered 202), a GET (405 is fine), `tools/list`.
//
// Anyone on this PC can reach a port on 127.0.0.1, and what answers here decides whether a tool runs. So a request needs the
// bearer token made for this run, a Host that names this server (a web page can be made to reach 127.0.0.1 under another
// name), and no Origin header (a web page always sends one; an MCP client never does).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const SERVER_NAME = 'walkie';
export const TOOL_NAME = 'approve';
export const DENIED = '用户没有允许这个操作。';
export const MAX_BODY = 32 * 1024 * 1024; // a Write of a big file arrives whole

export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first; the client's own pick is echoed when listed

export const APPROVE_TOOL = {
  name: TOOL_NAME,
  description: 'Asks the person wearing the walkie device whether Claude may run a tool.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function sameToken(given, token) {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Past the limit the rest of the body is thrown away as it arrives rather than the socket being cut, so that the refusal can
// still be sent; it closes the connection (see `send`).
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBody) {
        refused = true;
        chunks.length = 0;
        reject(new RpcError(-32600, 'request too large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// decide({tool, input, toolUseId, signal}) resolves {behavior: 'allow'} or {behavior: 'deny', message}. `signal` aborts when
// Claude Code drops the connection before an answer. An answer that cannot be given is a deny: this fails closed.
// `log(text)` hears what was asked about (the tool's name, never its input) and what was answered.
export function createPermServer({ decide, token = randomBytes(32).toString('hex'), host = '127.0.0.1', port = 0, maxBody = MAX_BODY, log = () => {} }) {
  let server = null;
  let hostPort = '';
  const waiting = new Set(); // the abort controllers of the requests that have been read and not yet answered

  async function approve(args, signal) {
    const { tool_name: tool, input = {}, tool_use_id: toolUseId = null } = args ?? {};
    if (typeof tool !== 'string' || !tool) throw new RpcError(-32602, 'tool_name must be a non-empty string');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RpcError(-32602, 'input must be an object');
    let verdict;
    try {
      verdict = await decide({ tool, input, toolUseId: typeof toolUseId === 'string' ? toolUseId : null, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      log(`perm: could not ask about ${tool}: ${err.message}`);
      verdict = { behavior: 'deny', message: `walkie 没能问你：${err.message}` };
    }
    const allowed = verdict?.behavior === 'allow';
    if (!signal.aborted) log(`perm: ${tool} ${allowed ? 'allowed' : 'denied'}`);
    const body = allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict?.message || DENIED };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async function answer(message, signal) {
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return rpcError(message?.id, -32600, 'not a JSON-RPC 2.0 message');
    const { id, method, params } = message;
    if (typeof method !== 'string') return null; // a response to us, which we never ask for
    if (id === undefined) return null; // a notification: nothing to say
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          return rpcResult(id, {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: '0.1.0' },
          });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: [APPROVE_TOOL] });
        case 'tools/call':
          if (params?.name !== TOOL_NAME) throw new RpcError(-32602, `unknown tool ${params?.name}`);
          return rpcResult(id, await approve(params.arguments, signal));
        default:
          throw new RpcError(-32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (signal.aborted) return null;
      return rpcError(id, err instanceof RpcError ? err.code : -32603, err.message);
    }
  }

  // A refusal may leave the request body unread on a socket the client means to reuse; closing the connection is the safe end.
  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'object' ? 'application/json' : 'text/plain; charset=utf-8',
      ...(status >= 400 ? { connection: 'close' } : {}),
      ...headers,
    });
    res.end(text);
  }

  async function onRequest(req, res) {
    try {
      const asked = req.headers.host ?? '';
      if (![`127.0.0.1:${hostPort}`, `localhost:${hostPort}`, `[::1]:${hostPort}`].includes(asked)) return send(res, 403, 'wrong host');
      if (req.headers.origin) return send(res, 403, 'no browsers'); // an MCP client sends no Origin; a web page would
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return send(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      if (new URL(req.url, 'http://walkie').pathname !== '/mcp') return send(res, 404, 'not found');
      if (req.method !== 'POST') return send(res, 405, 'POST only', { allow: 'POST' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, 'send application/json');
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req, maxBody));
      } catch (err) {
        return send(res, err instanceof RpcError ? 413 : 400, rpcError(null, err instanceof RpcError ? err.code : -32700, err instanceof RpcError ? err.message : 'parse error'));
      }
      const gone = new AbortController();
      waiting.add(gone);
      res.on('close', () => {
        waiting.delete(gone);
        if (!res.writableFinished) gone.abort();
      });
      const batch = Array.isArray(parsed);
      const replies = (await Promise.all((batch ? parsed : [parsed]).map((m) => answer(m, gone.signal)))).filter(Boolean);
      if (gone.signal.aborted) return;
      if (!replies.length) return send(res, 202);
      send(res, 200, batch ? replies : replies[0]);
    } catch (err) {
      log(`perm: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
    }
  }

  return {
    token,
    // How many requests have been read and not yet answered.
    waiting: () => waiting.size,
    // Starts listening; resolves with the URL to put in --mcp-config.
    start() {
      return new Promise((resolve, reject) => {
        server = createServer(onRequest);
        server.once('error', reject);
        server.listen(port, host, () => {
          hostPort = String(server.address().port);
          resolve({ url: `http://127.0.0.1:${hostPort}/mcp`, token });
        });
      });
    },
    // Stops listening, aborts the signal of each request still waiting for an answer (before this resolves) and drops every connection.
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        for (const gone of [...waiting]) gone.abort();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
```

- [ ] **Step 4: Run the test and see it pass**

Run: `node --test bridge/test/perm/server.test.js`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/perm/server.js bridge/test/helpers/mcp-client.js bridge/test/perm/server.test.js
git commit -m "Bridge: the permission endpoint Claude Code asks, MCP over HTTP on 127.0.0.1" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One `claude` process, and a stand-in for it

The layer between the operating system and the session manager: the command line of a session, a child process whose stdout becomes events, a way to write a user message to it, and a way to end it that also ends what it started. It decides nothing about sessions; the manager does that (Task 8). It also needs something to run against that is not the real `claude`, so this task adds the stand-in that the rest of the plan's real-process tests use.

**Files:**
- Create: `bridge/src/claude/process.js`
- Create (test helper): `bridge/test/claude/fake-claude.js`
- Test: `bridge/test/claude/process.test.js`, `bridge/test/claude/process-real.test.js`

**Interfaces:**
- Consumes: `createLineSplitter`, `parseEvent` and `userLine` (Task 3); `VOICE_RULES` (Task 2); in the stand-in, `mcpClient` (Task 6).
- Produces:
  - `PERMISSION_TOOL` (`'mcp__walkie__approve'`), `STDERR_TAIL` (4000: the characters of stderr kept for the error message when a process dies) and `DRAIN_MS` (200).
  - `claudeArgs({model, mcpUrl, mcpToken, resume = null}): string[]`: the arguments after the command, as spec §6.4 has them: `-p --input-format stream-json --output-format stream-json --verbose --model <model> --strict-mcp-config --mcp-config <one JSON argument> --permission-prompt-tool mcp__walkie__approve --append-system-prompt <VOICE_RULES>`, then `--resume <id>` when there is a session to resume (none, `null` or an empty id adds nothing and changes nothing else). Nothing is quoted for a shell: a value with spaces and quotes stays one argument.
  - `killTree(pid, {spawn, platform}): Promise<void>`: ends the process and everything it started. On Windows that is `taskkill /PID <pid> /T /F`, the only thing that reaches grandchildren (a Bash tool that is running, say), and the promise waits for `taskkill` to finish; elsewhere the one process gets SIGKILL, which it cannot ignore. A pid that is already gone is no error, a pid that is not a positive whole number starts nothing, and a `taskkill` that cannot be started still ends the call.
  - `spawnClaude({command, args, cwd, env}, {onEvent, onJunk, onExit}, {spawn, kill}): {pid, send(text): boolean, closeInput(), kill(): Promise<void>, stderrTail(): string}`. `command` is the program and the arguments that go before `args` (`claude.command` in the config), started with the folder, the environment and three pipes. Each line of stdout is one event whatever the chunks, a character cut in two between chunks arrives whole, and `onEvent` gets the object; a line that is not a JSON object goes to `onJunk(line)` and is never an event. Stderr is kept, its last 4000 characters. `onExit({code, signal, error, stderr})` is called once, after the last event (even a last line with no newline), when the process has ended or could not be started (`error`, for instance `ENOENT`); when the process has exited but its pipes stay open because a grandchild holds them, it is reported after `DRAIN_MS` with whatever still came out. `send(text)` writes the user message as one stream-json line and says whether it could be written: after the process has ended, or when the pipe is broken, it writes nothing and says no, and throws nothing. `closeInput()` ends stdin once, which makes `claude` finish what it is doing and exit with code 0.
  - `bridge/test/claude/fake-claude.js`: the stand-in. It takes the real argument list, reads user messages from stdin, prints events as the recordings of 1 Oct 2026 show them (hook and thinking noise, `system/init` at the start of every turn, a message that arrives while a turn runs merged into that turn, the `/compact` sequence, the errors), and calls the permission tool as an MCP client over HTTP, as `claude` does. It keeps a session between processes in a state directory so that `--resume <id>` finds it, and exits with the codes the recordings show. It is configured with JSON in the environment variable `FAKE_CLAUDE` (`bootMs`, `turnMs`, `stateDir`, `argsFile`, `mcpTimeoutMs`), and what a message says decides what happens: `/compact`, `!write <file>` (the model asks to Write that file, which needs approval), `!sleep <ms>` (a Bash command that takes that long), `!big <n>`, `!junk`, `!login`, `!model`, `!crash`; anything else is answered with `I heard: <text>`. Its header lists them all.

- [ ] **Step 1: Write the stand-in and the failing tests**

The stand-in, which the real-process tests start:

Create `bridge/test/claude/fake-claude.js`:

```js
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`, so that the process wrapper and
// the session manager can be tested against a real process without Claude, a login or the network. It takes the real argument
// list, reads user messages from stdin one JSON line at a time, prints events one JSON line at a time, and talks to the
// permission server as an MCP client over HTTP, as Claude Code does. What it prints is copied from the recordings of 1 Oct
// 2026 (claude 2.1.285, test/claude/fixtures): hook and thinking noise, `system/init` at the start of EVERY turn, a message
// that arrives while a turn runs merged into that turn (one result for both), the /compact sequence, the errors.
//
// Settings (JSON in the environment variable FAKE_CLAUDE):
//   bootMs        how long the SessionStart hooks take before the first message can be answered (default 0)
//   turnMs        how long the model takes over each turn (default 0)
//   stateDir      where a session is kept between processes, so that `--resume <id>` finds it (without it nothing is found)
//   argsFile      every start appends {argv, cwd, pid, claudeVars} to this file, one JSON line; claudeVars are the names of the
//                 environment variables it was given that start with CLAUDE or ANTHROPIC (what `--clean-env` takes out)
//   mcpTimeoutMs  how long a call to the permission tool may wait; the real client gives up at about 60 s (default 60000)
//
// What a message says decides what happens (the first message of a turn; the others are merged):
//   /compact          compacts the conversation
//   !write <file>     the model asks to Write <file> (default note.txt) in its folder: that needs the walkie approval
//   !sleep <ms>       the model runs a Bash command that takes that long
//   !big <n>          the reply text is n characters long
//   !junk             a line that is not JSON is printed first
//   !login | !model   the API refuses: login expired, model not found
//   !crash            the process dies with exit code 1 in the middle of the turn
//   anything else     "I heard: <text>"
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mcpClient } from '../helpers/mcp-client.js';

const cfg = { bootMs: 0, turnMs: 0, stateDir: null, argsFile: null, mcpTimeoutMs: 60_000, ...JSON.parse(process.env.FAKE_CLAUDE || '{}') };
const argv = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

let leaving = false;
function leave(code) {
  if (leaving) return;
  leaving = true;
  process.exitCode = code;
  process.stdout.write('', () => process.exit()); // everything written so far goes out first
}

// ---- the command line

const VALUE_FLAGS = ['--input-format', '--output-format', '--model', '--mcp-config', '--permission-prompt-tool', '--append-system-prompt', '--resume'];
const flags = new Set();
const values = {};
for (let i = 0; i < argv.length; i++) {
  if (VALUE_FLAGS.includes(argv[i])) values[argv[i]] = argv[++i];
  else flags.add(argv[i]);
}

function mcpServer() {
  try {
    const server = JSON.parse(values['--mcp-config']).mcpServers.walkie;
    return { url: server.url, token: server.headers.Authorization.replace(/^Bearer /, '') };
  } catch {
    return null;
  }
}

function usageError() {
  if (!flags.has('-p')) return 'fake-claude: only print mode (-p) is supported';
  if (values['--input-format'] !== 'stream-json' || values['--output-format'] !== 'stream-json') return 'fake-claude: both formats must be stream-json';
  if (!flags.has('--verbose')) return 'Error: When using --print, --output-format=stream-json requires --verbose';
  if (!values['--model']) return 'fake-claude: --model is missing';
  if (!flags.has('--strict-mcp-config') || !mcpServer()) return 'fake-claude: --strict-mcp-config and an --mcp-config with a walkie server are expected';
  if (values['--permission-prompt-tool'] !== 'mcp__walkie__approve') return 'fake-claude: the permission tool must be mcp__walkie__approve';
  return null;
}

// ---- the session

const resume = values['--resume'] ?? null;
const model = values['--model'];
const sessionId = resume ?? randomUUID();
const sessionFile = cfg.stateDir ? path.join(cfg.stateDir, `${sessionId}.json`) : null;
let turns = 0;
let mcp = null; // {client} once connected
let mcpStatus = 'failed';
let lastWasError = false;

function saveSession() {
  if (!sessionFile) return;
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ turns }));
}

async function connectMcp() {
  try {
    const { url, token } = mcpServer();
    const client = mcpClient({ url, token, agent: new http.Agent({ keepAlive: false }) });
    if (!(await client.initialize()).result) return;
    await client.notify('notifications/initialized');
    const listed = await client.rpc('tools/list');
    if (!listed.result.tools.some((t) => t.name === 'approve')) return;
    mcp = { client };
    mcpStatus = 'connected';
  } catch {
    // stays 'failed'
  }
}

// ---- events, as recorded

const hook = (subtype, id, name) => ({ type: 'system', subtype, hook_id: id, hook_name: name, hook_event: 'SessionStart', ...(subtype === 'hook_response' ? { output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success' } : {}), session_id: sessionId });
const init = () => ({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, tools: ['Bash', 'Edit', 'Glob', 'Read', 'Write'], mcp_servers: [{ name: 'walkie', status: mcpStatus, source: 'dynamic' }], model, permissionMode: 'default', apiKeySource: 'none', claude_code_version: '2.1.285', output_style: 'default' });
const thinkingTokens = () => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50, session_id: sessionId });
const rateLimit = () => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false }, session_id: sessionId });
const assistant = (content) => ({ type: 'assistant', message: { model, id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, stop_reason: null, stop_sequence: null }, parent_tool_use_id: null, session_id: sessionId });
const thinking = () => assistant([{ type: 'thinking', thinking: '', signature: 'sig' }]);
const textOf = (text) => ({ type: 'text', text });
const toolUse = (name, input) => {
  const id = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  return { id, event: assistant([{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }]) };
};
const toolResult = (id, content, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: sessionId });
const resultEvent = ({ started, text = '', turnCount = 1, denials = [], error = null }) => ({
  type: 'result',
  subtype: 'success',
  is_error: error !== null,
  duration_ms: Date.now() - started,
  duration_api_ms: Date.now() - started,
  num_turns: turnCount,
  result: text,
  stop_reason: 'end_turn',
  session_id: sessionId,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 20 },
  permission_denials: denials,
  terminal_reason: error ? 'api_error' : 'completed',
  api_error_status: error?.status ?? null,
});

// ---- one turn

let turn = null; // the running turn: {texts}; a message that arrives meanwhile is added to it
const queue = [];
let ready = false;
let stdinEnded = false;

// The model's last words: `screen` is what it writes, `voice` is the line inside <voice>. Messages merged into the turn are named.
function finish(started, screen, voice, denials = []) {
  const merged = turn.texts.slice(1);
  const also = merged.length ? ` Also heard: ${merged.join(' / ')}.` : '';
  const text = `${screen}${also}\n\n<voice>${voice}${also}</voice>`;
  out(assistant([textOf(text)]));
  out(rateLimit());
  out(resultEvent({ started, text, turnCount: denials.length ? 2 : 1, denials }));
  lastWasError = false;
}

function apiError(started, code, status, text) {
  out({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, error: code, is_api_error_message: true, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', stop_sequence: '', type: 'message', content: [textOf(text)] } });
  out(resultEvent({ started, text, error: { status } }));
  lastWasError = true;
}

// Asks the walkie permission tool, as the real client does, and gives up after mcpTimeoutMs.
async function askPermission(args) {
  if (!mcp) return { behavior: 'deny', message: 'mcp__walkie__approve is not connected' };
  try {
    return await mcp.client.approve(args, AbortSignal.timeout(cfg.mcpTimeoutMs));
  } catch {
    return { behavior: 'timeout' };
  }
}

async function write(started, file) {
  const input = { file_path: path.resolve(process.cwd(), file), content: 'walkie' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const asked = toolUse('Write', input);
    out(asked.event);
    out(rateLimit());
    const verdict = await askPermission({ tool_name: 'Write', input, tool_use_id: asked.id });
    if (verdict.behavior === 'allow') {
      const final = verdict.updatedInput ?? input;
      fs.writeFileSync(final.file_path, final.content);
      out(toolResult(asked.id, `File created successfully at: ${final.file_path}`));
      return finish(started, `Created ${file}.`, `I made ${file}.`);
    }
    if (verdict.behavior === 'deny') {
      out(toolResult(asked.id, verdict.message, true));
      return finish(started, `You refused the write, so ${file} was not created.`, `You refused it, so ${file} was not made.`, [{ tool_name: 'Write', tool_use_id: asked.id, tool_input: input }]);
    }
    out(toolResult(asked.id, '<tool_use_error>Error calling tool (Write): The operation timed out.</tool_use_error>', true));
  }
  return finish(started, `I could not create ${file}: the Write tool timed out twice.`, `I could not make ${file}, it timed out.`);
}

async function compact(started) {
  const id = randomUUID();
  out({ type: 'system', subtype: 'status', status: 'compacting', session_id: sessionId });
  out(hook('hook_started', id, 'SessionStart:compact'));
  await wait(cfg.turnMs);
  out(hook('hook_response', id, 'SessionStart:compact'));
  out({ type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: sessionId });
  out(init());
  out({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'manual', pre_tokens: 55111, post_tokens: 6566, cumulative_dropped_tokens: 48545, duration_ms: 16036 } });
  out({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation.' }, session_id: sessionId, parent_tool_use_id: null, isReplay: false, isSynthetic: true });
  out(resultEvent({ started, turnCount: 0 }));
  lastWasError = false;
}

async function runTurn() {
  const started = Date.now();
  const first = turn.texts[0].trim();
  if (first === '/compact') return compact(started);
  turns += 1;
  saveSession();
  out(init());
  out(thinkingTokens());
  out(thinking());
  await wait(cfg.turnMs);
  const [, command, rest = ''] = /^!(\w+)\s*(.*)$/s.exec(first) ?? [];
  switch (command) {
    case 'write':
      return write(started, rest.trim() || 'note.txt');
    case 'sleep': {
      const ms = Number(rest) || 0;
      const running = toolUse('Bash', { command: `sleep ${Math.ceil(ms / 1000)}`, description: `Wait ${ms} ms` });
      out(running.event);
      await wait(ms);
      out(toolResult(running.id, ''));
      return finish(started, `Waited ${ms} ms (turn ${turns}).`, `I waited ${ms} milliseconds.`);
    }
    case 'big':
      return finish(started, 'x'.repeat(Number(rest) || 1000), 'That was a long one.');
    case 'junk':
      process.stdout.write('warning: this line is not an event\n');
      return finish(started, `Junk first (turn ${turns}).`, 'Junk first.');
    case 'login':
      out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 10, error_status: 401, error: 'authentication_failed', session_id: sessionId });
      return apiError(started, 'authentication_failed', 401, 'Failed to authenticate. API Error: 401 OAuth access token is invalid.');
    case 'model':
      return apiError(started, 'model_not_found', 404, `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`);
    case 'crash':
      out(assistant([textOf('about to fall over')]));
      err('fake-claude: simulated crash');
      leave(1);
      return new Promise(() => {}); // the process ends before this settles
    default: {
      const heard = first;
      return finish(started, `I heard: ${heard} (turn ${turns})`, `I heard: ${heard}`);
    }
  }
}

async function pump() {
  if (!ready || turn || !queue.length) return;
  turn = { texts: [queue.shift()] };
  try {
    await runTurn();
  } finally {
    turn = null;
  }
  pump();
  maybeLeave();
}

// Closing stdin ends the process once the running turn is over; the code says whether the last turn failed.
function maybeLeave() {
  if (stdinEnded && ready && !turn && !queue.length) leave(lastWasError ? 1 : 0);
}

// ---- input

function accept(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return err(`fake-claude: input is not JSON: ${line.slice(0, 80)}`);
  }
  const blocks = message?.type === 'user' && message.message?.role === 'user' ? message.message.content : null;
  const text = Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
  if (!text) return err('fake-claude: input is not a user message with text');
  if (turn) turn.texts.push(text);
  else {
    queue.push(text);
    pump();
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) accept(line);
  }
});
process.stdin.on('end', () => {
  if (buffer.trim()) accept(buffer.trim());
  buffer = '';
  stdinEnded = true;
  maybeLeave();
});

// ---- start

async function main() {
  const wrong = usageError();
  if (wrong) {
    err(wrong);
    return leave(1);
  }
  if (cfg.argsFile) {
    const claudeVars = Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC)/i.test(name)).sort();
    fs.appendFileSync(cfg.argsFile, `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, claudeVars })}\n`);
  }
  const hookId = randomUUID();
  out(hook('hook_started', hookId, 'SessionStart:startup'));
  await wait(cfg.bootMs);
  out(hook('hook_response', hookId, 'SessionStart:startup'));
  if (resume) {
    if (!sessionFile || !fs.existsSync(sessionFile)) {
      const message = `No conversation found with session ID: ${resume}`;
      err(message);
      out({ ...resultEvent({ started: Date.now(), turnCount: 0, error: {} }), subtype: 'error_during_execution', session_id: randomUUID(), total_cost_usd: 0, errors: [message], terminal_reason: undefined, api_error_status: undefined });
      return leave(1);
    }
    turns = JSON.parse(fs.readFileSync(sessionFile, 'utf8')).turns;
  }
  await connectMcp();
  ready = true;
  pump();
  maybeLeave();
}

main();
```

The tests of the process wrapper, with the operating system replaced by stand-ins:

Create `bridge/test/claude/process.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { claudeArgs, DRAIN_MS, killTree, PERMISSION_TOOL, spawnClaude, STDERR_TAIL } from '../../src/claude/process.js';
import { userLine } from '../../src/claude/stream.js';
import { VOICE_RULES } from '../../src/claude/voice.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const until = async (ok, what, ms = 8000) => {
  for (let waited = 0; !ok() && waited < ms; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ok(), what);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- the command line

const ARGS = { model: 'claude-opus-5-5', mcpUrl: 'http://127.0.0.1:5123/mcp', mcpToken: 'abc123' };

test('the arguments are the ones in spec 6.4, and the MCP config is one JSON argument', () => {
  assert.deepEqual(claudeArgs(ARGS), [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-opus-5-5',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{"walkie":{"type":"http","url":"http://127.0.0.1:5123/mcp","headers":{"Authorization":"Bearer abc123"}}}}',
    '--permission-prompt-tool', 'mcp__walkie__approve',
    '--append-system-prompt', VOICE_RULES,
  ]);
  assert.equal(PERMISSION_TOOL, 'mcp__walkie__approve');
});

test('a session to resume is added at the end and changes nothing else; none, null or an empty id adds nothing', () => {
  const plain = claudeArgs(ARGS);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: 'abc-123' }), [...plain, '--resume', 'abc-123']);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: null }), plain);
  assert.deepEqual(claudeArgs({ ...ARGS, resume: '' }), plain);
});

test('nothing is quoted for a shell: a value with spaces and quotes stays one argument, and JSON escapes it', () => {
  const args = claudeArgs({ model: 'a b "c"', mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 'to"ken with space' });
  assert.equal(args[args.indexOf('--model') + 1], 'a b "c"');
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(config.mcpServers.walkie.headers.Authorization, 'Bearer to"ken with space');
});

// ---- ending a process and what it started

test('on Windows the whole tree is ended with taskkill, and the call waits for taskkill to finish', { timeout: 3000 }, async () => {
  const calls = [];
  const killer = new EventEmitter();
  let finished = false;
  const done = killTree(4242, { platform: 'win32', spawn: (...call) => (calls.push(call), killer) }).then(() => (finished = true));
  await settle();
  assert.deepEqual(calls, [['taskkill', ['/PID', '4242', '/T', '/F'], { stdio: 'ignore', windowsHide: true }]]);
  assert.equal(finished, false);
  killer.emit('exit', 0, null);
  await done;
  assert.equal(finished, true);
});

test('if taskkill cannot be started the call still ends', { timeout: 3000 }, async () => {
  const killer = new EventEmitter();
  const done = killTree(4242, { platform: 'win32', spawn: () => killer });
  killer.emit('error', new Error('spawn taskkill ENOENT'));
  await done;
});

test('a pid that is not a positive whole number starts nothing and ends at once', async () => {
  const never = () => assert.fail('taskkill must not be started');
  for (const pid of [undefined, null, 0, -5, 1.5, '12', Number.NaN]) await killTree(pid, { platform: 'win32', spawn: never });
});

test('elsewhere the one process is killed for good (SIGKILL: it cannot ignore that), and a pid that is already gone is no error', { timeout: 8000 }, async () => {
  const child = realSpawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try {
    await killTree(child.pid, { platform: 'linux' });
    await gone;
    assert.equal(alive(child.pid), false);
  } finally {
    child.kill();
  }
  await killTree(2147483646, { platform: 'linux' });
});

test('on Windows a grandchild dies with the process that started it', { skip: process.platform !== 'win32' }, async (t) => {
  const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
  const parent = realSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let grandchild = 0;
  t.after(() => {
    parent.kill();
    if (grandchild) {
      try {
        process.kill(grandchild);
      } catch {
        // already gone
      }
    }
  });
  let printed = '';
  parent.stdout.on('data', (chunk) => (printed += chunk));
  await until(() => printed.includes('\n'), 'the child printed its own child');
  grandchild = Number(printed);
  assert.equal(alive(grandchild), true);
  await killTree(parent.pid);
  await until(() => !alive(grandchild), 'the grandchild is gone');
  await until(() => !alive(parent.pid), 'the parent is gone');
});

// ---- one process, with a stand-in for what child_process gives back

function start(overrides = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.endCalls = 0;
  child.stdin = new Writable({ write(chunk, _encoding, done) { child.written.push(chunk.toString('utf8')); done(); } });
  const end = child.stdin.end.bind(child.stdin);
  child.stdin.end = (...rest) => (child.endCalls++, end(...rest));
  const spawned = [];
  const seen = { events: [], junk: [], exits: [], order: [] };
  const killed = [];
  const proc = spawnClaude(
    { command: ['claude'], args: ['-p'], cwd: 'C:\\proj', env: { A: '1' }, ...overrides },
    {
      onEvent: (event) => (seen.events.push(event), seen.order.push(['event', event])),
      onJunk: (line) => (seen.junk.push(line), seen.order.push(['junk', line])),
      onExit: (info) => (seen.exits.push(info), seen.order.push(['exit'])),
    },
    { spawn: (program, args, options) => (spawned.push({ program, args, options }), child), kill: (pid) => (killed.push(pid), Promise.resolve()) },
  );
  return { child, proc, spawned, killed, ...seen };
}

test('the program and its leading arguments come from `command`, then the arguments, with the folder, the environment and three pipes', () => {
  const { spawned } = start({ command: ['node', 'C:\\x\\fake.js'], args: ['-p', '--verbose'] });
  assert.deepEqual(spawned, [{ program: 'node', args: ['C:\\x\\fake.js', '-p', '--verbose'], options: { cwd: 'C:\\proj', env: { A: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true } }]);
});

test('each line of stdout is one event, however the bytes are cut', async () => {
  const { child, events } = start();
  child.stdout.write('{"type":"sys');
  child.stdout.write('tem","n":1}\n{"type":"result","n":2}\n{"type":');
  child.stdout.write('"x"}\n\n');
  await settle();
  assert.deepEqual(events, [{ type: 'system', n: 1 }, { type: 'result', n: 2 }, { type: 'x' }]);
});

test('a character cut in two between chunks arrives whole', async () => {
  const { child, events } = start();
  const bytes = Buffer.from('{"t":"你好"}\n', 'utf8');
  child.stdout.write(bytes.subarray(0, 8)); // inside the first character
  child.stdout.write(bytes.subarray(8));
  await settle();
  assert.deepEqual(events, [{ t: '你好' }]);
});

test('a line that is not a JSON object is junk and never an event', async () => {
  const { child, events, junk } = start();
  child.stdout.write('warning: something\n[1,2]\nnull\n42\n"text"\n{"type":"ok"}\n');
  await settle();
  assert.deepEqual(events, [{ type: 'ok' }]);
  assert.deepEqual(junk, ['warning: something', '[1,2]', 'null', '42', '"text"']);
});

test('stderr is kept, its last 4000 characters, and handed over at the exit', async () => {
  const { child, proc, exits } = start();
  child.stderr.write('a'.repeat(3000));
  child.stderr.write('b'.repeat(3000));
  await settle();
  assert.equal(STDERR_TAIL, 4000);
  assert.equal(proc.stderrTail(), 'a'.repeat(1000) + 'b'.repeat(3000));
  child.emit('close', 1, null);
  assert.equal(exits[0].stderr, 'a'.repeat(1000) + 'b'.repeat(3000));
});

test('the exit is reported once, with its code and stderr, after the last event, even a last line with no newline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, order, exits } = start();
  child.stdout.write('{"n":1}\n{"n":2}');
  child.stderr.write('boom\n');
  await settle();
  child.emit('exit', 3, null);
  child.emit('close', 3, null);
  t.mock.timers.tick(DRAIN_MS * 5);
  assert.deepEqual(order, [['event', { n: 1 }], ['event', { n: 2 }], ['exit']]);
  assert.deepEqual(exits, [{ code: 3, signal: null, stderr: 'boom\n' }]);
});

test('a process that has exited but whose pipes stay open is reported after a short wait, with what still came out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, order, exits } = start();
  child.emit('exit', 1, null);
  await settle();
  child.stdout.write('{"late":true}\n');
  await settle();
  t.mock.timers.tick(DRAIN_MS - 1);
  assert.equal(exits.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(order, [['event', { late: true }], ['exit']]);
  assert.deepEqual(exits, [{ code: 1, signal: null, stderr: '' }]);
  child.emit('close', 1, null);
  assert.equal(exits.length, 1);
});

test('a close that follows the exit does not wait for the pause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, exits } = start();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(exits.length, 1);
});

test('a signal that ended the process is reported', () => {
  const { child, exits } = start();
  child.emit('close', null, 'SIGKILL');
  assert.deepEqual(exits, [{ code: null, signal: 'SIGKILL', stderr: '' }]);
});

test('a program that cannot start is reported as an error, once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, exits, proc } = start();
  const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  child.emit('error', error);
  child.emit('close', -4058, null);
  t.mock.timers.tick(DRAIN_MS * 5);
  assert.deepEqual(exits, [{ code: null, signal: null, error, stderr: '' }]);
  assert.equal(proc.send('hello'), false);
});

test('send writes the user message as one stream-json line; closeInput ends stdin once, and after it nothing is written', async () => {
  const { child, proc } = start();
  assert.equal(proc.send('你好'), true);
  assert.equal(proc.send('second'), true);
  await settle();
  assert.deepEqual(child.written, [userLine('你好'), userLine('second')]);
  proc.closeInput();
  proc.closeInput();
  assert.equal(child.endCalls, 1);
  assert.equal(proc.send('too late'), false);
  await settle();
  assert.equal(child.written.length, 2);
});

test('nothing is written to a process that has ended, and its stdin is not closed again', () => {
  const { child, proc } = start();
  child.emit('close', 0, null);
  assert.equal(proc.send('hello'), false);
  proc.closeInput();
  assert.deepEqual(child.written, []);
  assert.equal(child.endCalls, 0);
});

test('a character cut in two between chunks of stderr is kept whole', async () => {
  const { child, proc } = start();
  const bytes = Buffer.from('错误：坏了', 'utf8');
  child.stderr.write(bytes.subarray(0, 4)); // inside the second character
  child.stderr.write(bytes.subarray(4));
  await settle();
  assert.equal(proc.stderrTail(), '错误：坏了');
});

test('a broken pipe on stdin throws nothing, and sends after it say no', async () => {
  const { child, proc } = start();
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(proc.send('hello'), false);
  proc.closeInput();
  assert.equal(child.endCalls, 0);
});

test('kill ends the tree of this pid, and the pid is the child\'s', async () => {
  const { proc, killed } = start();
  assert.equal(proc.pid, 4242);
  await proc.kill();
  assert.deepEqual(killed, [4242]);
});
```

And the same wrapper on a real process, the stand-in:

Create `bridge/test/claude/process-real.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeArgs, spawnClaude } from '../../src/claude/process.js';
import { createPermServer } from '../../src/perm/server.js';

const FAKE = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const until = async (ok, what, ms = 8000) => {
  for (let waited = 0; !ok() && waited < ms; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ok(), what);
};

// spawnClaude on a real process (the fake claude) with real pipes; the stand-in child of process.test.js cannot show these.
async function realStart(t, { fakeConfig = {}, resume = null, command = [process.execPath, FAKE] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-proc-'));
  const server = createPermServer({ decide: async () => ({ behavior: 'allow' }) });
  const { url, token } = await server.start();
  const seen = { events: [], junk: [], exits: [] };
  const proc = spawnClaude(
    { command, args: claudeArgs({ model: 'claude-opus-5-5', mcpUrl: url, mcpToken: token, resume }), cwd: dir, env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: path.join(dir, 'state'), ...fakeConfig }) } },
    { onEvent: (e) => seen.events.push(e), onJunk: (l) => seen.junk.push(l), onExit: (i) => seen.exits.push(i) },
  );
  t.after(async () => {
    await proc.kill();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const results = () => seen.events.filter((e) => e.type === 'result');
  return { proc, server, dir, results, ...seen };
}

test('a real process: a message in, events out, and closing stdin ends it with code 0', async (t) => {
  const { proc, events, exits, results } = await realStart(t);
  assert.equal(proc.send('hello'), true);
  await until(() => results().length === 1, 'a result');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.mcp_servers[0].status, 'connected');
  assert.match(results()[0].result, /I heard: hello \(turn 1\)/);
  assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'hook_started'), 'noise arrives too; deciding what matters is not this layer\'s job');
  proc.closeInput();
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].code, 0);
  assert.equal(exits[0].signal, null);
});

test('a real process: a line of 3 MB arrives whole, and a line that is no event is told apart', async (t) => {
  const { proc, junk, results } = await realStart(t);
  proc.send('!junk');
  await until(() => results().length === 1, 'the first result');
  proc.send('!big 3000000');
  await until(() => results().length === 2, 'the second result');
  assert.deepEqual(junk, ['warning: this line is not an event']);
  assert.ok(results()[1].result.length > 3_000_000);
});

test('a real process: kill ends it in the middle of a turn, and nothing is reported after the exit', async (t) => {
  const { proc, events, exits } = await realStart(t);
  proc.send('!sleep 60000');
  await until(() => events.some((e) => e.type === 'assistant' && JSON.stringify(e).includes('"Bash"')), 'the long tool started');
  await proc.kill();
  await until(() => exits.length === 1, 'the exit');
  assert.ok(exits[0].code !== 0 || exits[0].signal !== null, 'it did not leave cleanly');
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(events.length, count);
  assert.equal(exits.length, 1);
  assert.equal(proc.send('anyone there?'), false);
});

test('a real process: asked to resume a session that is not there, it says so on both outputs and ends with code 1', async (t) => {
  const { exits, events } = await realStart(t, { resume: '11111111-2222-4333-8444-555555555555' });
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].code, 1);
  assert.match(exits[0].stderr, /No conversation found with session ID: 11111111-2222-4333-8444-555555555555/);
  const result = events.find((e) => e.type === 'result');
  assert.equal(result.subtype, 'error_during_execution');
  assert.deepEqual(result.errors, ['No conversation found with session ID: 11111111-2222-4333-8444-555555555555']);
});

test('a program that does not exist is an exit with an error, not a crash', async (t) => {
  const { proc, exits } = await realStart(t, { command: ['walkie-no-such-program-xyz'] });
  await until(() => exits.length === 1, 'the exit');
  assert.equal(exits[0].error.code, 'ENOENT');
  assert.equal(proc.send('hello'), false);
});

test('a real process that is stopped and started again with --resume carries on in the same session', async (t) => {
  const first = await realStart(t);
  first.proc.send('one');
  await until(() => first.results().length === 1, 'the first result');
  const sessionId = first.results()[0].session_id;
  first.proc.closeInput();
  await until(() => first.exits.length === 1, 'the first exit');
  const second = await realStart(t, { resume: sessionId, fakeConfig: { stateDir: path.join(first.dir, 'state') } });
  second.proc.send('two');
  await until(() => second.results().length === 1, 'the second result');
  assert.equal(second.results()[0].session_id, sessionId);
  assert.match(second.results()[0].result, /\(turn 2\)/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/claude/process.test.js bridge/test/claude/process-real.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude/process.js`.

- [ ] **Step 3: Write the module**

Create `bridge/src/claude/process.js`:

```js
// One claude process (spec 6.4): its command line, what comes out of it as events, a way to write to it and a way to end it.
// It decides nothing about a session; the manager does that. Everything that touches the operating system is injectable.
import { spawn as nodeSpawn } from 'node:child_process';
import { createLineSplitter, parseEvent, userLine } from './stream.js';
import { VOICE_RULES } from './voice.js';

export const STDERR_TAIL = 4000; // characters of stderr kept, for the error message when the process dies
export const DRAIN_MS = 200; // how long output may still arrive after the process has exited (a grandchild can hold the pipe open)
export const PERMISSION_TOOL = 'mcp__walkie__approve';

// The arguments after the command, as in spec 6.4. The MCP config is one JSON argument: nothing here passes through a shell.
export function claudeArgs({ model, mcpUrl, mcpToken, resume = null }) {
  const mcpConfig = { mcpServers: { walkie: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } };
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--permission-prompt-tool', PERMISSION_TOOL,
    '--append-system-prompt', VOICE_RULES,
    ...(resume ? ['--resume', resume] : []),
  ];
}

// Ends a process and everything it started. On Windows `taskkill /T` is the only thing that reaches the grandchildren (a
// Bash tool that is running, say); elsewhere the process alone is killed. Resolves when the attempt is over, whatever came of it.
export function killTree(pid, { spawn = nodeSpawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    if (platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      return resolve();
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

// Starts `command` (a program and the arguments that go before `args`) in `cwd`.
//   onEvent(object)     one parsed line of stdout
//   onJunk(line)        a line of stdout that is not a JSON object
//   onExit({code, signal, error, stderr})   once, when the process has ended or could not start; `stderr` is its tail
// Returns {pid, send(text), closeInput(), kill(), stderrTail()}. send says whether the text could be written.
export function spawnClaude({ command, args, cwd, env }, { onEvent = () => {}, onJunk = () => {}, onExit = () => {} } = {}, { spawn = nodeSpawn, kill = killTree } = {}) {
  const [program, ...leading] = command;
  const child = spawn(program, [...leading, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  let finished = false;
  let drain = null;
  let stdinOpen = true;

  const splitter = createLineSplitter((line) => {
    const event = parseEvent(line);
    if (event) onEvent(event);
    else onJunk(line);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => splitter.push(chunk));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  child.stdin.on('error', () => {
    stdinOpen = false; // the process went away between two writes; its exit says why
  });

  function finish(info) {
    if (finished) return;
    finished = true;
    stdinOpen = false;
    clearTimeout(drain);
    splitter.end();
    onExit({ code: null, signal: null, ...info, stderr });
  }
  child.once('error', (error) => finish({ error }));
  child.once('exit', (code, signal) => {
    drain = setTimeout(() => finish({ code, signal }), DRAIN_MS);
  });
  child.once('close', (code, signal) => finish({ code, signal }));

  return {
    pid: child.pid,
    send(text) {
      if (!stdinOpen) return false;
      child.stdin.write(userLine(text));
      return true;
    },
    // Closes stdin, which makes claude finish what it is doing and exit with code 0.
    closeInput() {
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin.end();
    },
    kill: () => kill(child.pid),
    stderrTail: () => stderr,
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/claude/process.test.js bridge/test/claude/process-real.test.js`
Expected: PASS, 23 tests in `process.test.js` and 6 in `process-real.test.js`. The real-process tests take a few seconds: one of them starts a process, ends it in the middle of a turn, and starts it again with `--resume`. On a system other than Windows one test of `process.test.js` is skipped (a grandchild dying with its parent is Windows' `taskkill /T`).

- [ ] **Step 5: Commit**

```bash
git add bridge/src/claude/process.js bridge/test/claude/fake-claude.js bridge/test/claude/process.test.js bridge/test/claude/process-real.test.js
git commit -m "Bridge: one claude process as events in and a message out, and a stand-in claude to test it" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The session manager

The heart of the plan, spec §6.4. One `claude` process at a time, for the active project; kept alive between messages, closed after an hour with nothing to do, started again with `--resume` when a message comes. It turns what the process prints into what the rest of walkie says or shows (`working`, `reply`, `idle`, `notice`, `failure`, `project`), carries out the spoken commands (stop, continue, compact, new session, switch project, status), and does nothing else: the approvals sit between the permission server and the device, not here.

**Files:**
- Create: `bridge/src/claude/manager.js`
- Create (test helper): `bridge/test/claude/fake-proc.js`
- Test: `bridge/test/claude/manager.test.js`, `bridge/test/claude/manager-real.test.js`

**Interfaces:**
- Consumes: `findProject(projects, name)` from plan 2's `src/config/projects.js`; `claudeArgs` and `spawnClaude` (Task 7); `interpret` (Task 3); `extractVoice` (Task 2); `statusText` and `toolSummary`, `classifyFailure` and `MESSAGES` (Task 4); the state store of Task 1 (`project()`, `setProject(name)`, `sessionId(name)`, `setSession(name, id)`, `forgetSession(name)`). In `manager-real.test.js`: the stand-in `claude` (Task 7), the permission server (Task 6) and the approvals queue (Task 5).
- Produces:
  - `createManager({config, projects, store, mcp, start = spawnClaude, env = process.env, log = () => {}, now = () => Date.now(), isDir}): {project(), on(name, fn): off, start(), handle(message): Promise<{speak?}>, close(): Promise<void>}`. `config` is the `claude` section of `config.json` (Task 1), `projects` the validated list of plan 2's `projects.json` loader, `mcp` the `{url, token}` of the permission server; `start` is `spawnClaude` or a stand-in for tests, and `isDir` checks that a project's folder exists.
  - `SAY`, `NOTICE`, `CONTINUE_TEXT` (`继续`) and `COMPACT_TEXT` (`/compact`): the fixed sentences of the spoken commands and of the notices.
  - Events (`on(name, fn)` returns a function that takes the listener off; every payload names its project or is about the active one):
    - `working {project, tool, summary, startedAt}`: a turn began (`tool` is `null`) or `claude` began using a tool. However many messages are sent during a turn, it is announced once.
    - `reply {project, kind, voice, screen, text, tagged, turns, ms, costUsd}`: what `claude` answered; `kind` is `'reply'` or `'compact'` (a manual `/compact` is answered with how much shorter the context got, not with an empty reply); `voice` and `screen` come from Task 2's `extractVoice`, and `turns` counts per project since the bridge started.
    - `idle {project}`: the turn is over, however it ended. Every run of `working` ends in exactly one `idle`: after a reply, a failure, a stop, a switch away, or an unexpected exit.
    - `notice {kind, text}`: news that is not a failure (`claude` exited unexpectedly, the permission server did not connect, the session it was asked to resume is gone and a new one was started).
    - `failure {kind, message}`: something he has to do at the PC or try again later: the kinds of Task 4's `classifyFailure`, plus `cwd` (the project's folder is missing). The event is called `failure` and not `error`, because an `EventEmitter` throws when it emits `error` and nobody listens.
    - `project {name}`: the active project changed.
  - `handle({intent, project, text})`, with the answer shape of plan 2's intent validator: `to_claude` sends `text` (nothing for an empty one), `continue` sends 「继续」, `compact` sends `/compact`, `stop` ends the process tree in the middle of a turn and keeps the session id (nothing to stop says so and leaves the process alone), `new_session` ends the process, forgets the session id and counts turns from zero, `switch_project` ends the process, makes the project active and, with `prewarm`, starts its process (an unknown project and the active one change nothing), `status` answers from what the manager has seen (Task 4's `statusText`). It resolves `{speak}` with the sentence to say, or `{}`; `stop`, `new_session` and `switch_project` answer only when the old process is gone.
  - Sessions: the session id is stored when `claude` says it (`system/init`, at the start of every turn); a process started later resumes it. A session that cannot be resumed (the answer is believed only for a process that was asked to resume something) is forgotten, he is told, and a fresh process takes over with only the messages that were not answered yet. A process that dies in the middle of a turn: he is told, the run of `working` ends, the next message starts a process that resumes, and the lost message is not sent again. After `idleMinutes` with nothing to do the input is closed, not the process killed (it exits with 0, and that exit is no news); a busy process is never closed for being idle, and the timer does not keep the bridge alive. A process that has silently gone is replaced once; if that one is gone too, it is a failure.
  - Logging: lines that are not events go to the log cut to 200 characters. Nothing he said and nothing `claude` answered reaches the log. A listener that throws does not break the session. After `close()` nothing is said and no timer is left behind.
  - Test helper `bridge/test/claude/fake-proc.js`: `createProcs()`, a stand-in for `spawnClaude` that lets a test feed events and exits by hand, and `ev` and `SESSION`, builders of the events of the recordings.

- [ ] **Step 1: Write the helper and the failing tests**

The stand-in for `spawnClaude` that the unit tests use:

Create `bridge/test/claude/fake-proc.js`:

```js
// Stand-ins for what spawnClaude returns, so that the manager can be tested without a process: nothing runs, the test says what
// the process printed (`print`) and when it exited (`exit`), and reads what the manager sent to it and did to it.
// `ev` builds the events claude prints, in the shapes recorded on 1 Oct 2026 (test/claude/fixtures).

export const SESSION = '11111111-2222-4333-8444-555555555555';

export function createProcs() {
  const procs = [];
  function start(spec, handlers) {
    const proc = {
      spec,
      pid: 1000 + procs.length,
      sent: [],
      inputClosed: false,
      killed: false,
      ended: false,
      stderr: '',
      send(text) {
        if (proc.inputClosed || proc.ended) return false;
        proc.sent.push(text);
        return true;
      },
      closeInput() {
        proc.inputClosed = true;
      },
      kill() {
        proc.killed = true;
        queueMicrotask(() => proc.exit({ code: 1 })); // a killed process does report its exit, a moment later
        return Promise.resolve();
      },
      stderrTail: () => proc.stderr,
      // the test's side
      print: (event) => handlers.onEvent(event),
      junk: (line) => handlers.onJunk(line),
      exit(info = {}) {
        if (proc.ended) return;
        proc.ended = true;
        handlers.onExit({ code: 0, signal: null, stderr: proc.stderr, ...info });
      },
    };
    procs.push(proc);
    return proc;
  }
  return { start, procs, last: () => procs.at(-1) };
}

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content }, parent_tool_use_id: null, session_id: SESSION, ...extra });

export const ev = {
  init: ({ sessionId = SESSION, walkie = 'connected' } = {}) => ({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-opus-5-5',
    cwd: 'C:\\proj',
    mcp_servers: walkie === null ? [] : [{ name: 'walkie', status: walkie, source: 'dynamic' }],
  }),
  tool: (name, input = {}) => assistant([{ type: 'tool_use', id: 'toolu_1', name, input }]),
  text: (text) => assistant([{ type: 'text', text }]),
  apiError: (code, text) => assistant([{ type: 'text', text }], { error: code, is_api_error_message: true }),
  compacting: () => ({ type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION }),
  compacted: ({ trigger = 'manual', pre = 55111, post = 6566 } = {}) => ({ type: 'system', subtype: 'compact_boundary', session_id: SESSION, compact_metadata: { trigger, pre_tokens: pre, post_tokens: post, duration_ms: 16036 } }),
  result: ({ text = '', ok = true, sessionId = SESSION, ms = 1500, cost = 0.05, status = null, errors = [], subtype = 'success', turns = 1 } = {}) => ({
    type: 'result',
    subtype,
    is_error: !ok,
    result: text,
    errors,
    api_error_status: status,
    session_id: sessionId,
    num_turns: turns,
    duration_ms: ms,
    total_cost_usd: cost,
    permission_denials: [],
  }),
};
```

The manager against it, with the clock mocked:

Create `bridge/test/claude/manager.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStateStore } from '../../src/config/state.js';
import { MESSAGES } from '../../src/claude/errors.js';
import { COMPACT_TEXT, CONTINUE_TEXT, createManager, NOTICE, SAY } from '../../src/claude/manager.js';
import { claudeArgs } from '../../src/claude/process.js';
import { statusText } from '../../src/claude/status.js';
import { createProcs, ev, SESSION } from './fake-proc.js';

const PROJECTS = [
  { name: 'alpha', aliases: ['阿尔法'], path: 'C:\\work\\alpha' },
  { name: 'beta', aliases: [], path: 'C:\\work\\beta' },
];
const CONFIG = { command: ['claude-test', '--flag'], model: 'claude-test-model', idleMinutes: 60, approvalTimeoutSec: 55, prewarm: true };
const MCP = { url: 'http://127.0.0.1:5123/mcp', token: 'tok' };
const ARGS = { model: CONFIG.model, mcpUrl: MCP.url, mcpToken: MCP.token };
const MINUTE = 60_000;
const OTHER = '22222222-3333-4444-8555-666666666666';
const settle = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate is not one of the mocked timers

// A manager on a double of the process, mock timers and an in-memory state store; `seen` is every event it emitted.
function setup(t, { config = {}, store = createStateStore({ file: null }), isDir = () => true, start } = {}) {
  t.mock.timers.reset(); // a test may set up more than one manager
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const procs = createProcs();
  const logs = [];
  const manager = createManager({ config: { ...CONFIG, ...config }, projects: PROJECTS, store, mcp: MCP, start: start ? (spec, handlers) => start(procs, spec, handlers) : procs.start, env: { E: '1' }, log: (line) => logs.push(line), isDir });
  const seen = [];
  for (const name of ['working', 'reply', 'idle', 'notice', 'failure', 'project']) manager.on(name, (payload) => seen.push([name, payload]));
  const names = () => seen.map(([name]) => name);
  const say = (text) => manager.handle({ intent: 'to_claude', text });
  const speak = async (intent, extra = {}) => (await manager.handle({ intent, ...extra })).speak;
  return { manager, procs, store, logs, seen, names, say, speak };
}

// A whole turn as the process prints it.
function answer(proc, { text = '好了\n\n<voice>好了。</voice>', ms = 1500, sessionId = SESSION } = {}) {
  proc.print(ev.init({ sessionId }));
  proc.print(ev.text(text));
  proc.print(ev.result({ text, ms, sessionId }));
}

test('start() with prewarm starts the active project\'s process: the configured command, the spec\'s arguments, its folder, the given environment', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  assert.equal(procs.procs.length, 1);
  const { spec } = procs.last();
  assert.deepEqual(spec.command, ['claude-test', '--flag']);
  assert.deepEqual(spec.args, claudeArgs(ARGS));
  assert.equal(spec.cwd, 'C:\\work\\alpha');
  assert.deepEqual(spec.env, { E: '1' });
});

test('without prewarm start() starts nothing, and the first message starts the process and goes to it', async (t) => {
  const { manager, procs, names, say } = setup(t, { config: { prewarm: false } });
  manager.start();
  assert.equal(procs.procs.length, 0);
  await say('你好');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['你好']);
  assert.deepEqual(names(), ['working']);
});

test('a message goes to the process that was started ahead, not to a second one, and is sent as it was said', async (t) => {
  const { manager, procs, say } = setup(t);
  manager.start();
  await say('  把 README 改一下  ');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['  把 README 改一下  ']);
});

test('the active project is the stored one when it exists, else the first, and start() stores it', (t) => {
  const known = createStateStore({ file: null });
  known.setProject('beta');
  const a = setup(t, { store: known });
  assert.equal(a.manager.project(), 'beta');
  a.manager.start();
  assert.equal(a.procs.last().spec.cwd, 'C:\\work\\beta');

  const unknown = createStateStore({ file: null });
  unknown.setProject('renamed-away');
  const b = setup(t, { store: unknown });
  assert.equal(b.manager.project(), 'alpha');
  b.manager.start();
  assert.equal(unknown.project(), 'alpha');
});

test('a turn: working, working with the tool in use, the reply with its voice, then idle', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  const proc = procs.last();
  await say('看一下测试');
  proc.print(ev.init());
  proc.print(ev.tool('Bash', { command: 'npm test' }));
  const text = '干完了\n\n<voice>测试都通过了。</voice>';
  proc.print(ev.text(text));
  proc.print(ev.result({ text, ms: 45_000, cost: 0.1234 }));
  assert.deepEqual(seen, [
    ['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }],
    ['working', { project: 'alpha', tool: 'Bash', summary: 'npm test', startedAt: 0 }],
    ['reply', { project: 'alpha', kind: 'reply', voice: '测试都通过了。', screen: '干完了', text, tagged: true, turns: 1, ms: 45_000, costUsd: 0.1234 }],
    ['idle', { project: 'alpha' }],
  ]);
});

test('the session id is stored when claude says it, and a process started later resumes that session', async (t) => {
  const { manager, procs, store, say } = setup(t, { config: { prewarm: false } });
  await say('一');
  procs.last().print(ev.init());
  assert.equal(store.sessionId('alpha'), SESSION);
  procs.last().exit({ code: 1 });
  await say('二');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.equal(manager.project(), 'alpha');
});

test('a reply without the voice tag is untagged and speaks its first sentence', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('嗯');
  answer(procs.last(), { text: '已经改好了。另外还有一个小问题。' });
  const reply = seen.find(([name]) => name === 'reply')[1];
  assert.equal(reply.tagged, false);
  assert.equal(reply.voice, '已经改好了。');
  assert.equal(reply.screen, '已经改好了。另外还有一个小问题。');
});

test('however many messages are sent during a turn, working is announced once and the one result is one reply', async (t) => {
  const { manager, procs, names, say } = setup(t);
  manager.start();
  await say('第一句');
  await say('第二句');
  assert.deepEqual(procs.last().sent, ['第一句', '第二句']);
  procs.last().print(ev.init());
  answer(procs.last());
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
});

test('a turn that begins without a message from here is a working turn too', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().print(ev.init());
  assert.deepEqual(seen, [['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }]]);
});

test('status says what the process is doing: nothing running, ready, thinking, using a tool and for how long, idle, stopped', async (t) => {
  const { manager, procs, store, speak, say } = setup(t, { config: { prewarm: false } });
  const base = { project: 'alpha', running: false, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false };
  assert.equal(await speak('status'), statusText(base));
  await say('做点事');
  const proc = procs.last();
  proc.print(ev.init());
  t.mock.timers.tick(10_000);
  assert.equal(await speak('status'), statusText({ ...base, running: true, busy: true, elapsedMs: 10_000, turns: 1, resumable: true }));
  proc.print(ev.tool('Bash', { command: 'npm test' }));
  t.mock.timers.tick(35_000);
  assert.equal(await speak('status'), statusText({ ...base, running: true, busy: true, tool: 'Bash', summary: 'npm test', elapsedMs: 45_000, turns: 1, resumable: true }));
  answer(proc, { ms: 45_000 });
  assert.equal(await speak('status'), statusText({ ...base, running: true, elapsedMs: 45_000, turns: 1, resumable: true }));
  proc.exit({ code: 1 });
  assert.equal(await speak('status'), statusText({ ...base, elapsedMs: 45_000, turns: 1, resumable: true }));
  assert.equal(store.sessionId('alpha'), SESSION);
});

test('a process that is ready and has done nothing is "standing by"', async (t) => {
  const { manager, speak } = setup(t);
  manager.start();
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
});

test('stop ends a busy process, says so, keeps the session, and the exit that follows is no news', async (t) => {
  const { manager, procs, store, seen, say, speak } = setup(t);
  manager.start();
  await say('做个很长的事');
  procs.last().print(ev.init());
  seen.length = 0;
  assert.equal(await speak('stop'), SAY.stopped);
  assert.equal(procs.last().killed, true);
  assert.deepEqual(seen, [['idle', { project: 'alpha' }]]);
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: false, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: true }));
});

test('stop with nothing to stop leaves the process alone', async (t) => {
  const { manager, procs, say, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('stop'), SAY.nothingToStop);
  manager.start();
  await say('一');
  answer(procs.last());
  assert.equal(await speak('stop'), SAY.nothingToStop);
  assert.equal(procs.last().killed, false);
});

test('after a stop the next message starts a new process that resumes the same session', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('慢活');
  procs.last().print(ev.init());
  await speak('stop');
  await say('继续吧');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.deepEqual(procs.last().sent, ['继续吧']);
});

test('continue sends the word for it and compact sends the command', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  assert.deepEqual(await manager.handle({ intent: 'continue' }), {});
  assert.deepEqual(await manager.handle({ intent: 'compact' }), {});
  assert.deepEqual(procs.last().sent, [CONTINUE_TEXT, COMPACT_TEXT]);
  assert.equal(CONTINUE_TEXT, '继续');
  assert.equal(COMPACT_TEXT, '/compact');
});

test('a /compact is answered with how much shorter the context got, not with an empty reply', async (t) => {
  const { manager, procs, seen, names } = setup(t);
  manager.start();
  await manager.handle({ intent: 'compact' });
  const proc = procs.last();
  proc.print(ev.compacting());
  proc.print(ev.init());
  proc.print(ev.compacted({ pre: 55111, post: 6566 }));
  proc.print(ev.result({ text: '', ms: 18_000, turns: 0 }));
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
  assert.deepEqual(seen[1][1], { project: 'alpha', kind: 'compact', voice: '压缩完了，上下文少了88%。', screen: '压缩完了，上下文少了88%。', text: '', tagged: false, turns: 0, ms: 18_000, costUsd: 0.05 });
});

test('a compaction that claude does by itself in the middle of a turn does not change that turn\'s reply', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('长任务');
  procs.last().print(ev.init());
  procs.last().print(ev.compacted({ trigger: 'auto' }));
  const text = '做完了\n\n<voice>做完了。</voice>';
  procs.last().print(ev.result({ text }));
  const reply = seen.find(([name]) => name === 'reply')[1];
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.voice, '做完了。');
  assert.equal(reply.turns, 1);
});

test('the compaction speech copes with numbers that make no sense', async (t) => {
  for (const [pre, post, spoken] of [[0, 0, '压缩完了。'], [1000, 2000, '压缩完了。'], [1000, 1000, '压缩完了，上下文少了0%。'], [1000, 0, '压缩完了，上下文少了100%。']]) {
    const { manager, procs, seen } = setup(t);
    manager.start();
    await manager.handle({ intent: 'compact' });
    procs.last().print(ev.compacted({ pre, post }));
    procs.last().print(ev.result({ text: '', turns: 0 }));
    assert.equal(seen.find(([name]) => name === 'reply')[1].voice, spoken, `${pre} -> ${post}`);
  }
});

test('new_session ends the process, forgets the session, counts turns from zero again and starts a fresh process', async (t) => {
  const { manager, procs, store, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.equal(await speak('new_session'), SAY.newSession);
  assert.equal(procs.procs[0].killed, true);
  assert.equal(store.sessionId('alpha'), null);
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
});

test('new_session without prewarm starts nothing until he speaks', async (t) => {
  const { procs, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('new_session'), SAY.newSession);
  assert.equal(procs.procs.length, 0);
});

test('switch_project: an unknown project and the active one change nothing; another ends the process, starts that project\'s, resumes its session, and keeps the other\'s', async (t) => {
  const { manager, procs, store, seen, speak } = setup(t);
  store.setSession('alpha', SESSION);
  store.setSession('beta', OTHER);
  manager.start();
  assert.equal(await speak('switch_project', { project: 'nope' }), SAY.noProject);
  assert.equal(await speak('switch_project', { project: 'alpha' }), SAY.sameProject('alpha'));
  assert.equal(procs.procs.length, 1);
  assert.equal(procs.procs[0].killed, false);

  assert.equal(await speak('switch_project', { project: 'beta' }), SAY.switched('beta'));
  assert.equal(procs.procs[0].killed, true);
  assert.equal(procs.procs.length, 2);
  assert.equal(procs.last().spec.cwd, 'C:\\work\\beta');
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: OTHER }));
  assert.equal(manager.project(), 'beta');
  assert.equal(store.project(), 'beta');
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.deepEqual(seen, [['project', { name: 'beta' }]]);

  await speak('switch_project', { project: 'alpha' });
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
});

test('switching away from a busy project ends its run of working', async (t) => {
  const { manager, names, say, speak } = setup(t);
  manager.start();
  await say('一');
  await speak('switch_project', { project: 'beta' });
  assert.deepEqual(names(), ['working', 'idle', 'project']);
});

test('a failed turn is a failure of the kind it was, with the sentence for the screen, then idle', async (t) => {
  const login = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
  const model = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
  const cases = [
    [[ev.apiError('authentication_failed', login)], ev.result({ ok: false, text: login, status: 401 }), { kind: 'login', message: MESSAGES.login }],
    [[ev.apiError('model_not_found', model)], ev.result({ ok: false, text: model, status: 404 }), { kind: 'model', message: MESSAGES.model }],
    [[], ev.result({ ok: false, text: 'Something odd went wrong\nsecond line' }), { kind: 'other', message: 'Claude 出错了：Something odd went wrong' }],
  ];
  for (const [before, result, failure] of cases) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('hi');
    procs.last().print(ev.init());
    for (const e of before) procs.last().print(e);
    procs.last().print(result);
    assert.deepEqual(seen.slice(1), [['failure', failure], ['idle', { project: 'alpha' }]], failure.kind);
  }
});

test('the process stays usable after a failed turn, and the turn count does not include it', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('hi');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, text: 'boom' }));
  await say('again');
  assert.equal(procs.procs.length, 1);
  assert.deepEqual(procs.last().sent, ['hi', 'again']);
  answer(procs.last());
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: 1500, turns: 1, resumable: true }));
});

test('a session that cannot be resumed at start: the id is forgotten, he is told, and a fresh process takes over', (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, seen } = setup(t, { store });
  manager.start();
  const first = procs.last();
  assert.deepEqual(first.spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  first.print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0, ms: 0 }));
  first.exit({ code: 1 });
  assert.equal(store.sessionId('alpha'), null);
  assert.equal(first.killed, true);
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.deepEqual(seen, [['notice', { kind: 'no-session', text: MESSAGES['no-session'] }]]);
});

test('a session that cannot be resumed when a message was already sent: the message goes to the fresh process, and the run of working goes on', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, names, say } = setup(t, { store, config: { prewarm: false } });
  await say('帮我看看');
  const first = procs.last();
  assert.deepEqual(first.sent, ['帮我看看']);
  first.print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0, ms: 0 }));
  first.exit({ code: 1 });
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().sent, ['帮我看看']);
  assert.deepEqual(procs.last().spec.args, claudeArgs(ARGS));
  assert.deepEqual(names(), ['working', 'notice']);
  answer(procs.last(), { sessionId: OTHER });
  assert.deepEqual(names(), ['working', 'notice', 'reply', 'idle']);
  assert.equal(store.sessionId('alpha'), OTHER);
});

test('the missing-session answer is only believed for a process that was asked to resume something', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('hi');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: ['No conversation found with session ID: x'], turns: 0 }));
  assert.equal(procs.procs.length, 1);
  assert.equal(seen.at(-2)[0], 'failure');
});

// An EventEmitter throws when it emits 'error' and nobody listens: the failure event has another name, so that a manager that
// nothing listens to yet (the bridge before the device layer is up) cannot be brought down by what Claude says or does.
test('with nobody listening, a failed turn, an unexpected exit and a program that is missing throw nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const procs = createProcs();
  const missing = () => {
    throw Object.assign(new Error('spawn claude-test ENOENT'), { code: 'ENOENT' });
  };
  const manager = createManager({ config: { ...CONFIG, prewarm: false }, projects: PROJECTS, store: createStateStore({ file: null }), mcp: MCP, start: procs.start, env: {}, isDir: () => true });
  await manager.handle({ intent: 'to_claude', text: 'hi' });
  procs.last().print(ev.init());
  assert.doesNotThrow(() => procs.last().print(ev.result({ ok: false, text: 'Something odd went wrong' })), 'a failed turn');
  await manager.handle({ intent: 'to_claude', text: 'again' });
  assert.doesNotThrow(() => procs.last().exit({ code: 1 }), 'an unexpected exit');
  const lost = createManager({ config: { ...CONFIG, prewarm: false }, projects: PROJECTS, store: createStateStore({ file: null }), mcp: MCP, start: missing, env: {}, isDir: () => true });
  await assert.doesNotReject(lost.handle({ intent: 'to_claude', text: 'hi' }), 'a program that is missing');
});

test('an unexpected exit in the middle of a turn: he is told, the run of working ends, and the next message starts a process that resumes; the lost message is not sent again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('做一件事');
  procs.last().print(ev.init());
  procs.last().stderr = 'TypeError: something broke\n    at foo (bar.js:1:1)';
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen.slice(1), [['notice', { kind: 'exited', text: NOTICE.exitedBusy }], ['idle', { project: 'alpha' }]]);
  await say('再来');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
  assert.deepEqual(procs.last().sent, ['再来']);
});

test('an unexpected exit of a process that was only waiting says so in other words', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen, [['notice', { kind: 'exited', text: NOTICE.exitedIdle }]]);
});

test('an exit whose stderr names a login problem is that failure, not a vague notice', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().stderr = 'Invalid API key · Please run /login';
  procs.last().exit({ code: 1 });
  assert.deepEqual(seen, [['failure', { kind: 'login', message: MESSAGES.login }]]);
});

test('a program that cannot be started is a failure of kind missing, and a message after it tries again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  procs.last().exit({ code: null, error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) });
  assert.deepEqual(seen, [['failure', { kind: 'missing', message: MESSAGES.missing }]]);
  await say('hi');
  assert.equal(procs.procs.length, 2);
});

test('after an hour of nothing the input is closed, not the process killed; the exit is no news and the next message starts again', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  seen.length = 0;
  t.mock.timers.tick(59 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(MINUTE);
  assert.equal(procs.last().inputClosed, true);
  assert.equal(procs.last().killed, false);
  procs.last().exit({ code: 0 });
  assert.deepEqual(seen, []);
  await say('二');
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().spec.args, claudeArgs({ ...ARGS, resume: SESSION }));
});

test('the hour starts again after each turn, and a process that is busy is never closed for being idle', async (t) => {
  const { manager, procs, say } = setup(t);
  manager.start();
  await say('一');
  t.mock.timers.tick(5 * 60 * MINUTE); // a very long turn
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(59 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  await say('二');
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('the idle limit is the configured one', (t) => {
  const { manager, procs } = setup(t, { config: { idleMinutes: 5 } });
  manager.start();
  t.mock.timers.tick(4 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a permission server that did not connect is a notice, once per process', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init({ walkie: 'failed' }));
  answer(procs.last());
  assert.deepEqual(seen.filter(([name]) => name === 'notice'), [['notice', { kind: 'mcp', text: NOTICE.mcp }]]);
  procs.last().print(ev.init({ walkie: null }));
  assert.equal(seen.filter(([name]) => name === 'notice').length, 1);
});

test('a project whose folder is missing is a failure of kind cwd, and nothing is started', async (t) => {
  const { manager, procs, seen, say } = setup(t, { isDir: () => false });
  manager.start();
  await say('hi');
  assert.equal(procs.procs.length, 0);
  assert.deepEqual(seen.map(([name, payload]) => [name, payload.kind]), [['failure', 'cwd'], ['failure', 'cwd']]);
  assert.match(seen[0][1].message, /alpha/);
});

test('a start that throws is a failure, not a crash', async (t) => {
  const { manager, seen, say } = setup(t, { start: () => { throw Object.assign(new Error('bad arguments'), { code: 'EINVAL' }); } });
  manager.start();
  await say('hi');
  assert.deepEqual(seen.map(([name, payload]) => [name, payload.kind, payload.message]), [
    ['failure', 'other', 'Claude 出错了：bad arguments'],
    ['failure', 'other', 'Claude 出错了：bad arguments'],
  ]);
});

test('a screen that throws while being told does not break the session', async (t) => {
  const { manager, procs, logs, names, say } = setup(t);
  manager.on('reply', () => {
    throw new Error('screen broke');
  });
  manager.start();
  await say('hi');
  answer(procs.last());
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
  assert.ok(logs.some((line) => line.includes('a listener of reply threw: screen broke')));
  await say('again');
  assert.deepEqual(procs.last().sent, ['hi', 'again']);
});

test('what a process that was ended says afterwards is ignored', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  const old = procs.last();
  old.print(ev.init());
  await speak('stop');
  seen.length = 0;
  old.print(ev.tool('Bash', { command: 'x' }));
  answer(old);
  old.exit({ code: 1 });
  assert.deepEqual(seen, []);
});

test('close() ends every process, and nothing is said or timed after it', async (t) => {
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  const proc = procs.last();
  await manager.close();
  assert.equal(proc.killed, true);
  seen.length = 0;
  proc.print(ev.init());
  answer(proc);
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.deepEqual(seen, []);
  assert.equal(proc.inputClosed, false);
  assert.deepEqual(await manager.handle({ intent: 'to_claude', text: 'hello?' }), {});
  assert.equal(procs.procs.length, 1);
});

test('close() also ends a process that was let go but has not exited yet', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().kill = () => {
    procs.last().killed = true; // does not exit by itself this time
    return Promise.resolve();
  };
  const old = procs.last();
  await speak('stop');
  old.killed = false;
  await manager.close();
  assert.equal(old.killed, true);
});

test('a process that has silently gone is replaced once; if that one is gone too, it is a failure and nothing is announced as working', async (t) => {
  const first = setup(t);
  first.manager.start();
  first.procs.last().ended = true;
  await first.say('hi');
  assert.equal(first.procs.procs.length, 2);
  assert.equal(first.procs.procs[0].killed, true);
  assert.deepEqual(first.procs.last().sent, ['hi']);

  const second = setup(t, { start: (procs, spec, handlers) => Object.assign(procs.start(spec, handlers), { ended: true }) });
  second.manager.start();
  await second.say('hi');
  assert.equal(second.procs.procs.length, 2); // the one started ahead and its one replacement
  assert.deepEqual(second.seen, [['failure', { kind: 'other', message: NOTICE.notReceived }]]);
});

test('lines that are not events go to the log, cut to 200 characters, and nothing else', (t) => {
  const { manager, procs, logs, seen } = setup(t);
  manager.start();
  const line = `warning: ${'x'.repeat(500)}`;
  procs.last().junk(line);
  assert.ok(logs.includes(`claude: ${line.slice(0, 200)}`), logs.join(' | '));
  assert.deepEqual(seen, []);
});

test('what he said and what Claude answered never reach the log', async (t) => {
  const { manager, procs, logs, say } = setup(t);
  manager.start();
  await say('密码是 hunter2');
  answer(procs.last(), { text: '好的，不会记住 hunter2\n\n<voice>好的，不记。</voice>' });
  procs.last().exit({ code: 1 });
  assert.ok(logs.length > 0);
  assert.ok(logs.every((line) => !/hunter2|密码|不记/.test(line)), logs.join(' | '));
});

test('intents with nothing to do: an empty message, an unknown intent, a missing text', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  for (const intent of [{ intent: 'to_claude', text: '   ' }, { intent: 'to_claude' }, { intent: 'dance' }, {}]) assert.deepEqual(await manager.handle(intent), {});
  assert.deepEqual(procs.last().sent, []);
});

// ---- the cases the first version of these tests did not pin, found by changing the code and watching what still passed

test('the words he hears and reads', () => {
  assert.deepEqual(
    [SAY.stopped, SAY.nothingToStop, SAY.newSession, SAY.noProject, SAY.sameProject('alpha'), SAY.switched('beta')],
    ['已停止。', '现在没有在做事。', '好的，开了新的对话。', '没有这个项目。', '已经在alpha了。', '切到beta了。'],
  );
  assert.deepEqual(NOTICE, {
    exitedBusy: 'Claude 意外退出了，刚才的事没做完，再说一句就会接着做。',
    exitedIdle: 'Claude 退出了，再说话会自动接上。',
    mcp: '审批通道没连上，Claude 要做的事都会被拒绝。',
    notReceived: 'Claude 没有收到这句话，再说一遍。',
  });
});

test('a result that arrives when no turn was begun here still starts the hour again', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  t.mock.timers.tick(30 * MINUTE);
  procs.last().print(ev.result({ text: '好了' }));
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  t.mock.timers.tick(30 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a process that was ended is not touched by its idle timer afterwards', async (t) => {
  const { manager, procs, speak } = setup(t);
  manager.start();
  await speak('switch_project', { project: 'beta' });
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.procs[0].inputClosed, false);
  assert.equal(procs.procs[1].inputClosed, true); // the new one runs out its own hour
});

test('a second turn is its own: thinking until a tool is used, timed from when it began, counted as the second', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.tool('Bash', { command: 'npm test' }));
  procs.last().print(ev.result({ text: '好了', ms: 2000 }));
  t.mock.timers.tick(7_000);
  seen.length = 0;
  await say('二');
  procs.last().print(ev.init());
  t.mock.timers.tick(3_000);
  assert.deepEqual(seen, [['working', { project: 'alpha', tool: null, summary: '', startedAt: 7_000 }]]);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: true, tool: null, summary: '', elapsedMs: 3_000, turns: 2, resumable: true }));
});

test('turns are counted for each project, and the count of one is there when he comes back to it', async (t) => {
  const { manager, procs, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  await speak('switch_project', { project: 'beta' });
  assert.equal(await speak('status'), statusText({ project: 'beta', running: true, busy: false, tool: null, summary: '', elapsedMs: null, turns: 0, resumable: false }));
  await speak('switch_project', { project: 'alpha' });
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: false, tool: null, summary: '', elapsedMs: 1500, turns: 1, resumable: true }));
});

test('a tool in use with no turn announced before it begins the turn', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().print(ev.tool('Bash', { command: 'ls' }));
  assert.deepEqual(seen, [
    ['working', { project: 'alpha', tool: null, summary: '', startedAt: 0 }],
    ['working', { project: 'alpha', tool: 'Bash', summary: 'ls', startedAt: 0 }],
  ]);
});

test('a turn after a compaction is a reply again; the compaction itself was not a turn, and the percentage is rounded', async (t) => {
  const { manager, procs, seen, say, speak } = setup(t);
  manager.start();
  await say('一');
  answer(procs.last());
  await speak('compact');
  procs.last().print(ev.compacted({ pre: 1000, post: 204 }));
  procs.last().print(ev.result({ text: '', turns: 0 }));
  await say('二');
  answer(procs.last());
  const replies = seen.filter(([name]) => name === 'reply').map(([, reply]) => [reply.kind, reply.turns, reply.voice]);
  assert.deepEqual(replies, [['reply', 1, '好了。'], ['compact', 1, '压缩完了，上下文少了80%。'], ['reply', 2, '好了。']]);
});

test('what claude said about one failed turn does not colour the next failed turn', async (t) => {
  const login = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init());
  procs.last().print(ev.apiError('authentication_failed', login));
  procs.last().print(ev.result({ ok: false, text: login, status: 401 }));
  await say('二');
  procs.last().print(ev.init());
  procs.last().print(ev.result({ ok: false, text: 'Something odd went wrong' }));
  assert.deepEqual(seen.filter(([name]) => name === 'failure').map(([, failure]) => failure.kind), ['login', 'other']);
});

test('a failed turn is read from whichever of the error code, the status, the errors list, stderr or the api message says what happened', async (t) => {
  const cases = [
    ['the code', [ev.apiError('rate_limit', 'x')], ev.result({ ok: false, text: 'x' }), '', 'rate'],
    ['the status', [], ev.result({ ok: false, text: 'x', status: 429 }), '', 'rate'],
    ['the errors list', [], ev.result({ ok: false, text: '', subtype: 'error_during_execution', errors: ['Not logged in · Please run /login'] }), '', 'login'],
    ['stderr', [], ev.result({ ok: false, text: '' }), 'Invalid API key · Please run /login', 'login'],
    ['the api message, when the result has no text', [ev.apiError('x', 'Claude usage limit reached')], ev.result({ ok: false, text: '' }), '', 'rate'],
  ];
  for (const [what, before, result, stderr, kind] of cases) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('hi');
    procs.last().stderr = stderr;
    procs.last().print(ev.init());
    for (const e of before) procs.last().print(e);
    procs.last().print(result);
    assert.equal(seen.find(([name]) => name === 'failure')[1].kind, kind, what);
  }
});

test('the permission server counts as connected only when claude says so: left out of the list, pending and failed are each a notice, and a new process is told about again', async (t) => {
  for (const [walkie, notices] of [['connected', 0], [null, 1], ['pending', 1], ['failed', 1]]) {
    const { manager, procs, seen, say } = setup(t);
    manager.start();
    await say('一');
    procs.last().print(ev.init({ walkie }));
    assert.equal(seen.filter(([name]) => name === 'notice').length, notices, String(walkie));
  }
  const { manager, procs, seen, say } = setup(t);
  manager.start();
  await say('一');
  procs.last().print(ev.init({ walkie: 'failed' }));
  procs.last().exit({ code: 1 });
  await say('二');
  procs.last().print(ev.init({ walkie: 'failed' }));
  assert.equal(seen.filter(([name, payload]) => name === 'notice' && payload.kind === 'mcp').length, 2);
});

test('the missing-session answer is recognised in the errors list and in the result text', (t) => {
  for (const result of [
    ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }),
    ev.result({ ok: false, text: `No conversation found with session ID: ${SESSION}`, turns: 0 }),
  ]) {
    const store = createStateStore({ file: null });
    store.setSession('alpha', SESSION);
    const { manager, procs } = setup(t, { store });
    manager.start();
    procs.last().print(result);
    assert.equal(procs.procs.length, 2);
    assert.equal(store.sessionId('alpha'), null);
  }
});

test('a successful answer that happens to quote the missing-session sentence is just an answer', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, names, say } = setup(t, { store, config: { prewarm: false } });
  await say('这句话是什么意思：No conversation found');
  answer(procs.last(), { text: '意思是 No conversation found with session ID，找不到会话。\n\n<voice>找不到会话。</voice>' });
  assert.equal(procs.procs.length, 1);
  assert.equal(store.sessionId('alpha'), SESSION);
  assert.deepEqual(names(), ['working', 'reply', 'idle']);
});

test('when a resumed process turns out to have no session, only what was not answered yet is sent again', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, say } = setup(t, { store, config: { prewarm: false } });
  await say('一');
  answer(procs.last());
  await say('二');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  assert.equal(procs.procs.length, 2);
  assert.deepEqual(procs.last().sent, ['二']);
});

test('the process that takes over for a session that could not be resumed is timed from the first message, and is not closed for idleness while it works', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  const { manager, procs, say, speak } = setup(t, { store, config: { prewarm: false } });
  t.mock.timers.tick(5_000);
  await say('帮我看看');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  t.mock.timers.tick(2_000);
  assert.equal(await speak('status'), statusText({ project: 'alpha', running: true, busy: true, tool: null, summary: '', elapsedMs: 2_000, turns: 1, resumable: false }));
  t.mock.timers.tick(2 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  answer(procs.last());
  t.mock.timers.tick(60 * MINUTE);
  assert.equal(procs.last().inputClosed, true);
});

test('a session that cannot be resumed, when the process for a new one cannot be started either: he is told, and the run of working ends', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('alpha', SESSION);
  let starts = 0;
  const start = (procs, spec, handlers) => {
    if (++starts > 1) throw Object.assign(new Error('no more'), { code: 'EINVAL' });
    return procs.start(spec, handlers);
  };
  const { manager, procs, names, say } = setup(t, { store, start, config: { prewarm: false } });
  await say('帮我看看');
  procs.last().print(ev.result({ ok: false, subtype: 'error_during_execution', errors: [`No conversation found with session ID: ${SESSION}`], turns: 0 }));
  assert.deepEqual(names(), ['working', 'notice', 'failure', 'idle']);
});

test('close() does not kill a process that has already exited', async (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  procs.last().exit({ code: 1 });
  await manager.close();
  assert.equal(procs.last().killed, false);
});

test('stop, new_session, switch_project and close answer only when the old process is gone', async (t) => {
  for (const [intent, extra] of [['stop', {}], ['new_session', {}], ['switch_project', { project: 'beta' }], ['close', {}]]) {
    const { manager, procs, say, speak } = setup(t);
    manager.start();
    await say('一');
    procs.last().print(ev.init());
    const proc = procs.procs[0];
    let gone = null;
    proc.kill = () => {
      proc.killed = true;
      return new Promise((resolve) => {
        gone = resolve;
      });
    };
    let answered = false;
    const pending = (intent === 'close' ? manager.close() : speak(intent, extra)).then(() => {
      answered = true;
    });
    await settle();
    assert.equal(answered, false, `${intent} answered while the process was still there`);
    gone();
    await pending;
    assert.equal(answered, true, intent);
  }
});

test('a process that could not be started for some other reason is a failure that says why', (t) => {
  const { manager, procs, seen } = setup(t);
  manager.start();
  procs.last().exit({ code: null, error: Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }) });
  assert.deepEqual(seen, [['failure', { kind: 'other', message: 'Claude 出错了：spawn E2BIG' }]]);
});

test('close() leaves no timer and no exit behind that could say anything later', async (t) => {
  const { manager, procs, logs } = setup(t);
  manager.start();
  await manager.close();
  const before = logs.length;
  t.mock.timers.tick(5 * 60 * MINUTE);
  assert.equal(procs.last().inputClosed, false);
  assert.equal(logs.length, before);
  assert.ok(!logs.some((line) => line.includes('exited')), logs.join(' | '));
});

test('the idle timer does not keep the bridge alive', (t) => {
  const { manager } = setup(t);
  const mocked = globalThis.setTimeout;
  const unrefs = [];
  globalThis.setTimeout = (...args) => {
    const handle = mocked(...args);
    const unref = handle.unref.bind(handle);
    handle.unref = () => {
      unrefs.push(handle);
      return unref();
    };
    return handle;
  };
  t.after(() => {
    globalThis.setTimeout = mocked;
  });
  manager.start();
  assert.equal(unrefs.length, 1);
});

test('a start that throws because the program is not there is a failure of kind missing', (t) => {
  const { manager, seen } = setup(t, { start: () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); } });
  manager.start();
  assert.deepEqual(seen, [['failure', { kind: 'missing', message: MESSAGES.missing }]]);
});

test('switch_project without prewarm starts nothing until he speaks, and then starts that project\'s process', async (t) => {
  const { manager, procs, say, speak } = setup(t, { config: { prewarm: false } });
  assert.equal(await speak('switch_project', { project: 'beta' }), SAY.switched('beta'));
  assert.equal(procs.procs.length, 0);
  await say('hi');
  assert.equal(procs.last().spec.cwd, 'C:\\work\\beta');
});

test('start() twice starts one process, and a listener that has been taken off hears nothing more', (t) => {
  const { manager, procs } = setup(t);
  manager.start();
  manager.start();
  assert.equal(procs.procs.length, 1);
  const heard = [];
  const off = manager.on('working', (payload) => heard.push(payload.tool));
  procs.last().print(ev.init());
  off();
  procs.last().print(ev.tool('Bash', { command: 'x' }));
  assert.deepEqual(heard, [null]);
});

test('without a folder check or an environment of its own the manager asks the file system and passes on its own environment: a folder is a place to start in; a file and a missing path are not', async () => {
  const procs = createProcs();
  const failures = [];
  const projects = [
    { name: 'here', aliases: [], path: import.meta.dirname },
    { name: 'file', aliases: [], path: import.meta.filename },
    { name: 'gone', aliases: [], path: join(import.meta.dirname, 'no-such-folder') },
  ];
  const manager = createManager({ config: CONFIG, projects, store: createStateStore({ file: null }), mcp: MCP, start: procs.start });
  manager.on('failure', (failure) => failures.push(failure.kind));
  manager.start();
  assert.equal(procs.procs.length, 1);
  assert.equal(procs.last().spec.env, process.env); // the bridge's own environment unless it is told another
  await manager.handle({ intent: 'switch_project', project: 'file' });
  await manager.handle({ intent: 'switch_project', project: 'gone' });
  assert.deepEqual(failures, ['cwd', 'cwd']);
  assert.equal(procs.procs.length, 1);
  await manager.close();
});
```

And the manager against real processes, the stand-in `claude` of Task 7, with the real permission server and the real approvals queue:

Create `bridge/test/claude/manager-real.test.js`:

```js
// The manager against a real process (fake-claude.js, which speaks claude's stream-json and uses the permission server over
// HTTP the way the real client does) and the real permission server and approvals queue. Everything here takes real time,
// so every wait names what it waits for and gives up after 20 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../src/config/state.js';
import { MESSAGES } from '../../src/claude/errors.js';
import { createManager, NOTICE } from '../../src/claude/manager.js';
import { createApprovals } from '../../src/perm/approvals.js';
import { createPermServer } from '../../src/perm/server.js';
import { SESSION } from './fake-proc.js';

const FAKE = join(import.meta.dirname, 'fake-claude.js');

async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A project folder, the permission server and the approvals queue behind it, and a manager that starts the fake claude.
async function world(t, { fake = {}, config = {}, token = null, store = createStateStore({ file: null }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-real-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const argsFile = join(dir, 'starts.jsonl');
  const approvals = createApprovals({ timeoutMs: 10_000 });
  const shown = [];
  approvals.on('show', (request) => shown.push(request));
  const server = createPermServer({ decide: (request) => approvals.request(request) });
  const mcp = await server.start();
  const manager = createManager({
    config: { command: [process.execPath, FAKE], model: 'fake-model', idleMinutes: 60, approvalTimeoutSec: 10, prewarm: false, ...config },
    projects: [{ name: 'proj', aliases: [], path: project }],
    store,
    mcp: token ? { url: mcp.url, token } : mcp,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ bootMs: 0, turnMs: 0, stateDir: join(dir, 'sessions'), argsFile, ...fake }) },
  });
  const seen = [];
  for (const name of ['working', 'reply', 'idle', 'notice', 'failure', 'project']) manager.on(name, (payload) => seen.push([name, payload]));
  t.after(async () => {
    await manager.close();
    approvals.denyAll();
    await server.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // a process that was just killed may still hold its folder
    }
  });
  const of = (name) => seen.filter(([n]) => n === name).map(([, payload]) => payload);
  return {
    manager,
    approvals,
    shown,
    store,
    project,
    seen,
    of,
    names: () => seen.map(([name]) => name),
    starts: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
    say: (text) => manager.handle({ intent: 'to_claude', text }),
    speak: async (intent, extra = {}) => (await manager.handle({ intent, ...extra })).speak,
    idles: (n) => () => of('idle').length >= n,
  };
}

test('a message is answered by a real process: working, the reply with its voice, idle; the session is kept', async (t) => {
  const { manager, seen, of, store, say, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  assert.deepEqual(seen.map(([name]) => name), ['working', 'reply', 'idle']);
  const [reply] = of('reply');
  assert.equal(reply.voice, 'I heard: 你好');
  assert.equal(reply.screen, 'I heard: 你好 (turn 1)');
  assert.equal(reply.turns, 1);
  assert.match(store.sessionId('proj'), /^[0-9a-f-]{36}$/);
  assert.equal(manager.project(), 'proj');
});

test('with prewarm the process is started before the first message, and the message does not start a second', async (t) => {
  const { manager, starts, say, idles } = await world(t, { config: { prewarm: true } });
  manager.start();
  await until(() => starts().length === 1, 'the process that is started ahead');
  await say('你好');
  await until(idles(1), 'the answer');
  assert.equal(starts().length, 1);
});

test('a Write is asked about on the wrist, and happens only if he allows it', async (t) => {
  const { approvals, shown, of, project, say, idles } = await world(t);
  await say('!write out.txt');
  await until(() => shown.length === 1, 'the approval request');
  assert.equal(shown[0].tool, 'Write');
  assert.match(shown[0].preview, /out\.txt/);
  assert.equal(existsSync(join(project, 'out.txt')), false);
  assert.equal(approvals.answer(shown[0].id, { allow: true }), true);
  await until(idles(1), 'the answer');
  assert.equal(existsSync(join(project, 'out.txt')), true);
  assert.ok(of('working').some((w) => w.tool === 'Write'));
});

test('a Write he refuses does not happen, and Claude is told', async (t) => {
  const { approvals, shown, of, project, say, idles } = await world(t);
  await say('!write out.txt');
  await until(() => shown.length === 1, 'the approval request');
  approvals.answer(shown[0].id, { allow: false, reason: '不要写' });
  await until(idles(1), 'the answer');
  assert.equal(existsSync(join(project, 'out.txt')), false);
  assert.match(of('reply')[0].screen, /refused/);
});

test('stop kills the process in the middle of a long tool, and the next message resumes the same session', async (t) => {
  const { of, starts, store, say, speak, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  const session = store.sessionId('proj');
  await say('!sleep 30000');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the long tool');
  const [{ pid }] = starts();
  assert.equal(alive(pid), true);
  assert.equal(await speak('stop'), '已停止。');
  await until(() => !alive(pid), 'the process to be gone', 5_000);
  assert.equal(of('idle').length, 2);
  await say('再来一次');
  await until(idles(3), 'the answer after the stop');
  assert.equal(starts().length, 2);
  assert.equal(store.sessionId('proj'), session);
  assert.equal(of('reply').at(-1).screen, 'I heard: 再来一次 (turn 3)');
});

test('a message sent while a turn is running is part of that turn: one reply for both', async (t) => {
  const { of, names, say, idles } = await world(t);
  await say('!sleep 1500');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the tool');
  await say('第二句');
  await until(idles(1), 'the answer');
  assert.deepEqual(names(), ['working', 'working', 'reply', 'idle']);
  assert.match(of('reply')[0].screen, /第二句/);
});

test('/compact is answered with how much shorter the context got', async (t) => {
  const { of, speak, idles } = await world(t);
  await speak('compact');
  await until(idles(1), 'the compaction');
  assert.deepEqual(of('reply').map((r) => [r.kind, r.voice, r.turns]), [['compact', '压缩完了，上下文少了88%。', 0]]);
});

test('a login that has run out is a failure with the sentence for the screen, and the process goes on', async (t) => {
  const { of, say, idles } = await world(t);
  await say('!login');
  await until(idles(1), 'the failure');
  assert.deepEqual(of('failure'), [{ kind: 'login', message: MESSAGES.login }]);
  await say('在吗');
  await until(idles(2), 'the next answer');
  assert.equal(of('reply').length, 1);
});

test('a model claude does not know is a failure of kind model', async (t) => {
  const { of, say, idles } = await world(t);
  await say('!model');
  await until(idles(1), 'the failure');
  assert.deepEqual(of('failure'), [{ kind: 'model', message: MESSAGES.model }]);
});

test('a process that dies in the middle of a turn: he is told once, and the next message resumes', async (t) => {
  const { of, names, starts, store, say, idles } = await world(t);
  await say('你好');
  await until(idles(1), 'the first answer');
  const session = store.sessionId('proj');
  await say('!crash');
  await until(idles(2), 'the end of the crashed turn');
  assert.deepEqual(of('notice'), [{ kind: 'exited', text: NOTICE.exitedBusy }]);
  assert.deepEqual(names().slice(-2), ['notice', 'idle']);
  await say('还在吗');
  await until(idles(3), 'the answer after the crash');
  assert.equal(starts().length, 2);
  assert.equal(store.sessionId('proj'), session);
  assert.equal(of('reply').at(-1).screen, 'I heard: 还在吗 (turn 3)');
});

test('a permission server that refuses the token is a notice, once, and the work goes on', async (t) => {
  const { of, say, idles } = await world(t, { token: 'not-the-token' });
  await say('你好');
  await until(idles(1), 'the answer');
  await say('再说一句');
  await until(idles(2), 'the second answer');
  assert.deepEqual(of('notice'), [{ kind: 'mcp', text: NOTICE.mcp }]);
  assert.equal(of('reply').length, 2);
});

test('after the idle time the input is closed, the exit is no news, and the next message resumes', async (t) => {
  const { of, starts, store, say, idles } = await world(t, { config: { idleMinutes: 0.02 } });
  await say('你好');
  await until(idles(1), 'the first answer');
  const [{ pid }] = starts();
  await until(() => !alive(pid), 'the idle process to leave by itself', 10_000);
  assert.deepEqual(of('notice'), []);
  assert.deepEqual(of('failure'), []);
  await say('我回来了');
  await until(idles(2), 'the answer after the idle close');
  assert.equal(starts().length, 2);
  assert.equal(of('reply').at(-1).screen, 'I heard: 我回来了 (turn 2)');
  assert.ok(store.sessionId('proj'));
});

test('a session that is no longer there: he is told, and the message is answered in a new one', async (t) => {
  const store = createStateStore({ file: null });
  store.setSession('proj', SESSION);
  const { of, say, idles } = await world(t, { store });
  await say('你好');
  await until(idles(1), 'the answer in the new session');
  assert.deepEqual(of('notice'), [{ kind: 'no-session', text: MESSAGES['no-session'] }]);
  assert.equal(of('reply')[0].screen, 'I heard: 你好 (turn 1)');
  assert.notEqual(store.sessionId('proj'), SESSION);
});

test('close() ends the process that is running', async (t) => {
  const { manager, of, starts, say } = await world(t);
  await say('!sleep 30000');
  await until(() => of('working').some((w) => w.tool === 'Bash'), 'the long tool');
  const [{ pid }] = starts();
  assert.equal(alive(pid), true);
  await manager.close();
  await until(() => !alive(pid), 'the process to be gone', 5_000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/claude/manager.test.js bridge/test/claude/manager-real.test.js`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/claude/manager.js`.

- [ ] **Step 3: Write the manager**

Create `bridge/src/claude/manager.js`:

```js
// The session manager (spec 6.4): one claude process at a time, for the active project, kept alive between messages and
// started again with --resume when it has to be. It turns what the process prints into what the rest of walkie says or
// shows, and does nothing else: the approvals sit between the permission server and the device, not here.
//
// Events (`on(name, fn)`; every payload names its project, or is about the active one):
//   working {project, tool, summary, startedAt}      a turn began (tool null) or Claude began using a tool
//   reply   {project, kind, voice, screen, text, tagged, turns, ms, costUsd}   what Claude answered; kind 'reply' or 'compact'
//   idle    {project}                                the turn is over however it ended: every run of `working` ends in one
//   notice  {kind, text}                             news that is not a failure
//   failure {kind, message}                          something he has to do at the PC, or try again later
//   project {name}                                   the active project changed
// The failure event is not called "error": an EventEmitter throws when it emits 'error' and nobody listens.
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { findProject } from '../config/projects.js';
import { classifyFailure, MESSAGES } from './errors.js';
import { claudeArgs, spawnClaude } from './process.js';
import { statusText, toolSummary } from './status.js';
import { interpret } from './stream.js';
import { extractVoice } from './voice.js';

export const SAY = {
  stopped: '已停止。',
  nothingToStop: '现在没有在做事。',
  newSession: '好的，开了新的对话。',
  noProject: '没有这个项目。',
  sameProject: (name) => `已经在${name}了。`,
  switched: (name) => `切到${name}了。`,
};

export const NOTICE = {
  exitedBusy: 'Claude 意外退出了，刚才的事没做完，再说一句就会接着做。',
  exitedIdle: 'Claude 退出了，再说话会自动接上。',
  mcp: '审批通道没连上，Claude 要做的事都会被拒绝。',
  notReceived: 'Claude 没有收到这句话，再说一遍。',
};

export const CONTINUE_TEXT = '继续';
export const COMPACT_TEXT = '/compact';
const MISSING_SESSION = /no conversation found/i;
const MAX_JUNK_LOG = 200;

function folderExists(folder) {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

// config: the `claude` section of config.json. projects: bridge/projects.json, validated. store: the state store.
// mcp: {url, token} of the permission server. `start` is spawnClaude, or a stand-in for tests.
export function createManager({ config, projects, store, mcp, start = spawnClaude, env = process.env, log = () => {}, now = () => Date.now(), isDir = folderExists }) {
  const events = new EventEmitter();
  const live = new Set(); // every process started and not yet seen to exit, so that close() can end them all
  const turns = new Map(); // project -> turns answered since this bridge started
  const lastMs = new Map(); // project -> how long its last turn took
  let active = projects.find((p) => p.name === store.project())?.name ?? projects[0].name;
  let current = null; // the session whose events count; null when no process is running for the active project
  let closed = false;

  const emit = (name, payload) => {
    if (closed) return;
    try {
      events.emit(name, payload);
    } catch (err) {
      log(`claude: a listener of ${name} threw: ${err.message}`); // a broken screen must not break the session
    }
  };

  // ---- one process

  // Starts a process for `project`, resuming the session the store knows. Null when that cannot be done.
  function spawn(project, { resume = store.sessionId(project) } = {}) {
    const folder = projects.find((p) => p.name === project)?.path;
    if (!folder || !isDir(folder)) {
      emit('failure', { kind: 'cwd', message: `找不到项目的文件夹：${project}` });
      return null;
    }
    const session = { project, proc: null, resumed: Boolean(resume), gone: false, busy: false, tool: null, startedAt: 0, sent: [], idle: null, apiError: null, compacted: null, warnedMcp: false };
    log(`claude: starting ${project}${resume ? ` and resuming ${resume.slice(0, 8)}` : ''}`);
    try {
      session.proc = start(
        { command: config.command, args: claudeArgs({ model: config.model, mcpUrl: mcp.url, mcpToken: mcp.token, resume }), cwd: folder, env },
        { onEvent: (raw) => onEvent(session, raw), onJunk: (line) => log(`claude: ${line.slice(0, MAX_JUNK_LOG)}`), onExit: (info) => onExit(session, info) },
      );
    } catch (err) {
      emit('failure', classifyFailure({ code: err.code, text: String(err.message) }));
      return null;
    }
    live.add(session);
    current = session;
    armIdle(session);
    return session;
  }

  // The session no longer counts: nothing it prints is acted on, and it is not the current one.
  function release(session) {
    session.gone = true;
    clearTimeout(session.idle);
    if (current === session) current = null;
  }

  // Ends a process for good (its session id stays in the store, so that the next message resumes it).
  function end(session) {
    release(session);
    if (session.busy) emit('idle', { project: session.project });
    return session.proc.kill();
  }

  function armIdle(session) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      log(`claude: ${session.project} idle for ${config.idleMinutes} minutes, closing its input`);
      release(session);
      session.proc.closeInput(); // it finishes and exits with 0; the next message starts it again
    }, config.idleMinutes * 60_000);
    session.idle.unref?.(); // an idle timer is no reason for the bridge to stay alive
  }

  function beginTurn(session) {
    if (session.busy) return;
    session.busy = true;
    session.startedAt = now();
    clearTimeout(session.idle);
    emit('working', { project: session.project, tool: null, summary: '', startedAt: session.startedAt });
  }

  function endTurn(session) {
    session.busy = false;
    session.tool = null;
    session.sent = [];
    session.compacted = null;
    session.apiError = null;
    armIdle(session);
  }

  function sendTo(session, text) {
    if (!session.proc.send(text)) return false;
    session.sent.push(text);
    return true;
  }

  // ---- what the process says

  function onEvent(session, raw) {
    if (session.gone) return;
    for (const ev of interpret(raw)) {
      if (ev.kind === 'init') onInit(session, ev);
      else if (ev.kind === 'tool') onTool(session, ev);
      else if (ev.kind === 'api-error') session.apiError = { code: ev.code, text: ev.text };
      else if (ev.kind === 'compacted') session.compacted = ev;
      else if (ev.kind === 'result') onResult(session, ev);
    }
  }

  // claude prints `init` at the start of every turn, so it is also how a turn nobody asked for in this process is noticed.
  function onInit(session, ev) {
    store.setSession(session.project, ev.sessionId); // the store keeps only what looks like a session id
    if (ev.walkie !== 'connected' && !session.warnedMcp) {
      session.warnedMcp = true;
      emit('notice', { kind: 'mcp', text: NOTICE.mcp });
    }
    beginTurn(session);
  }

  function onTool(session, ev) {
    beginTurn(session);
    session.tool = { name: ev.name, summary: toolSummary(ev.name, ev.input) };
    emit('working', { project: session.project, tool: session.tool.name, summary: session.tool.summary, startedAt: session.startedAt });
  }

  function compactSpeech(c) {
    if (!(c.preTokens > 0) || c.postTokens > c.preTokens) return '压缩完了。';
    return `压缩完了，上下文少了${Math.round((1 - c.postTokens / c.preTokens) * 100)}%。`;
  }

  function onResult(session, ev) {
    const { project } = session;
    if (!ev.ok && session.resumed && MISSING_SESSION.test([ev.text, ...ev.errors].join('\n'))) return replay(session);
    const { apiError, compacted } = session;
    endTurn(session);
    if (!ev.ok) {
      emit('failure', classifyFailure({ code: apiError?.code, status: ev.apiStatus, text: ev.text || apiError?.text, errors: ev.errors, stderr: session.proc.stderrTail() }));
    } else if (compacted?.trigger === 'manual') {
      const spoken = compactSpeech(compacted);
      emit('reply', { project, kind: 'compact', voice: spoken, screen: spoken, text: '', tagged: false, turns: turns.get(project) ?? 0, ms: ev.durationMs, costUsd: ev.costUsd });
    } else {
      const done = (turns.get(project) ?? 0) + 1;
      turns.set(project, done);
      lastMs.set(project, ev.durationMs);
      log(`claude: ${project} turn ${done} took ${ev.durationMs} ms, ${ev.costUsd.toFixed(3)} USD`);
      emit('reply', { project, kind: 'reply', ...extractVoice(ev.text), text: ev.text, turns: done, ms: ev.durationMs, costUsd: ev.costUsd });
    }
    emit('idle', { project });
  }

  // The session claude was asked to resume is gone: forget it, say so, and go on in a new one with what was said and not answered.
  function replay(session) {
    const { project } = session;
    const unanswered = session.sent;
    store.forgetSession(project);
    release(session);
    void session.proc.kill(); // it is ending by itself
    emit('notice', { kind: 'no-session', text: MESSAGES['no-session'] });
    const fresh = spawn(project); // the store has forgotten the session, so this one starts from nothing
    if (!fresh) {
      if (session.busy) emit('idle', { project });
      return;
    }
    if (session.busy) {
      fresh.busy = true; // the run of `working` goes on
      fresh.startedAt = session.startedAt;
      clearTimeout(fresh.idle);
    }
    for (const text of unanswered) sendTo(fresh, text);
  }

  function onExit(session, info) {
    live.delete(session);
    if (session.gone) return; // ended by us: a stop, a switch, the idle close
    release(session);
    const wasBusy = session.busy;
    log(`claude: ${session.project} exited (code ${info.code}, signal ${info.signal})`);
    const failure = classifyFailure({ code: info.error?.code, text: info.error ? String(info.error.message) : '', stderr: info.stderr });
    if (info.error || failure.kind !== 'other') emit('failure', failure);
    else emit('notice', { kind: 'exited', text: wasBusy ? NOTICE.exitedBusy : NOTICE.exitedIdle });
    if (wasBusy) emit('idle', { project: session.project });
  }

  // ---- what he says

  function say(text) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = current ?? spawn(active);
      if (!session) return false;
      if (sendTo(session, text)) {
        beginTurn(session);
        return true;
      }
      release(session); // gone without a word yet: start a new one for the second attempt
      void session.proc.kill();
    }
    emit('failure', { kind: 'other', message: NOTICE.notReceived });
    return false;
  }

  async function stop() {
    const session = current;
    if (!session?.busy) return { speak: SAY.nothingToStop };
    await end(session);
    return { speak: SAY.stopped };
  }

  async function newSession() {
    const ended = current ? end(current) : null;
    store.forgetSession(active);
    turns.delete(active);
    if (config.prewarm) spawn(active);
    await ended;
    return { speak: SAY.newSession };
  }

  async function switchProject(name) {
    const target = findProject(projects, name);
    if (!target) return { speak: SAY.noProject };
    if (target.name === active) return { speak: SAY.sameProject(target.name) };
    const ended = current ? end(current) : null;
    active = target.name;
    store.setProject(active);
    emit('project', { name: active });
    if (config.prewarm) spawn(active);
    await ended;
    return { speak: SAY.switched(active) };
  }

  function statusLine() {
    const session = current;
    const done = turns.get(active) ?? 0;
    return statusText({
      project: active,
      running: Boolean(session),
      busy: Boolean(session?.busy),
      tool: session?.tool?.name ?? null,
      summary: session?.tool?.summary ?? '',
      elapsedMs: session?.busy ? now() - session.startedAt : (lastMs.get(active) ?? null),
      turns: session?.busy ? done + 1 : done,
      resumable: Boolean(store.sessionId(active)),
    });
  }

  return {
    project: () => active,
    on(name, fn) {
      events.on(name, fn);
      return () => events.off(name, fn);
    },
    // Remembers the active project and, if configured, starts its process now so that the first message does not wait for it.
    start() {
      store.setProject(active);
      if (config.prewarm && !current) spawn(active);
    },
    // What to do about one thing he said: {intent, project, text}, as validateAnswer gives it. Resolves {speak?}.
    async handle({ intent, project, text }) {
      if (closed) return {};
      switch (intent) {
        case 'to_claude':
          if (typeof text === 'string' && text.trim()) say(text);
          return {};
        case 'continue':
          say(CONTINUE_TEXT);
          return {};
        case 'compact':
          say(COMPACT_TEXT);
          return {};
        case 'stop':
          return stop();
        case 'new_session':
          return newSession();
        case 'switch_project':
          return switchProject(project);
        case 'status':
          return { speak: statusLine() };
        default:
          return {};
      }
    },
    // Ends every process this manager started, and stops telling anyone anything.
    async close() {
      closed = true;
      const all = [...live];
      for (const session of all) release(session);
      await Promise.all(all.map((session) => session.proc.kill()));
    },
  };
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/claude/manager.test.js bridge/test/claude/manager-real.test.js`
Expected: PASS, 70 tests in `manager.test.js` and 14 in `manager-real.test.js`. The real ones take 10 to 20 s in all, because several processes are started and ended.

Run: `npm --prefix bridge test`
Expected: PASS, 493 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/claude/manager.js bridge/test/claude/fake-proc.js bridge/test/claude/manager.test.js bridge/test/claude/manager-real.test.js
git commit -m "Bridge: the Claude session manager: one process per project, resumed, stopped, switched" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The developer command `walkie-dev claude`

The session manager with nothing else around it: no S3, no speech, no intent classifier. `walkie-dev claude` starts the manager with the real permission server and the real approvals queue, reads what he would have said or pressed from stdin, one command per line, and prints what the wrist would show. It is how Task 10 puts the real `claude` through the manager, and how anyone can see a session from a terminal before plan 4 joins the pieces. With `--command` it runs the stand-in of Task 7 instead, which is how its own tests run.

**Files:**
- Create: `bridge/src/dev/claude.js`
- Modify: `bridge/src/dev/args.js`, `bridge/bin/walkie-dev.js`
- Test: `bridge/test/dev/claude.test.js` (new), `bridge/test/dev/args.test.js`, `bridge/test/dev/walkie-dev.test.js`

**Interfaces:**
- Consumes: `createManager` (Task 8: `on`, `start`, `handle`, `close`); `createApprovals` (Task 5: `request`, `current`, `answer(id, {allow, reason})`, `denyAll`, and the events `show {id, tool, preview}` and `clear {id, outcome}`); `createPermServer` (Task 6: `start() → {url, token}`, `close()`); `createStateStore({file: null})` (Task 1); `loadConfig` and `loadProjects` of plan 2; `parseArgs` of plan 2's `args.js`, which gives a command its `args` and `opts`. The stand-in `fake-claude.js` (Task 7), which only the tests start.
- Produces: the command `walkie-dev claude [--cwd dir | --project name] [--command json] [--clean-env]`, and in `src/dev/claude.js`:
  - `parseLine(line)`: one line of the script as `{do: 'handle', message}`, `{do: 'answer', allow, reason}`, `{do: 'wait', what, seconds}`, `{do: 'sleep', seconds}` or `{do: 'quit'}`; `null` for a blank line or a `#` comment; a `CommandError` for anything else, so that a typo does not run the rest of a script written for something else. `wait` takes `idle`, `working` or `approval` and a number of seconds above 0 and at most 3600 (`WAIT_SECONDS`, 120, when there is none).
  - `runSession({manager, approvals, lines, print, sleep, signal}): Promise<boolean>`: runs the lines against the manager and the queue and prints everything that happens. True when the script ran to its end (at `quit`, or when the input ended and the turn that was running had finished); false when a wait ran out or `signal` aborted.
  - `cleanEnv(env)`, `commandFrom(text)`, `projectsFor(opts, {cwd, load})`, `settingsFor(config, opts)`, `queueFor(settings)`, `stateFor(active)` and `ctrlC(emitter, lines)`: the pieces of the command's set-up, each of them testable alone.
  - `CommandError`.

What it prints, one line each unless said: `[claude] <folder>, starting in <project>; permission server on <url>` (with `--project` it says `<n> projects` where the folder is), `[working] thinking` or `[working] <tool>: <summary>`, `[reply] <kind>, turn <n>, <s> s, $<cost>` followed by `  voice:` and the screen text indented, `[idle]`, `[says] <sentence>` for what the device would say, `[notice]`, `[failure]`, `[project]`, and `[approval] #<id> <tool>`, the preview, and `  answer: yes | no [reason]`, then `[approval] #<id> <outcome>` when it is settled. The manager's and the server's own log lines come as `[log] …`. The permission server's token is never printed.

- [ ] **Step 1: Write the failing tests**

The unit tests of the command: the script language, the waits against a manager that is fed by hand, and every piece of the set-up:

Create `bridge/test/dev/claude.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanEnv, CommandError, commandFrom, ctrlC, parseLine, projectsFor, queueFor, runSession, settingsFor, stateFor, WAIT_SECONDS } from '../../src/dev/claude.js';
import { createApprovals } from '../../src/perm/approvals.js';

// ---- parseLine

test('every command word becomes what the manager or the queue is told', () => {
  assert.deepEqual(parseLine('say 帮我跑一下测试'), { do: 'handle', message: { intent: 'to_claude', text: '帮我跑一下测试' } });
  assert.deepEqual(parseLine('  say   two   spaces inside  '), { do: 'handle', message: { intent: 'to_claude', text: 'two   spaces inside' } });
  assert.deepEqual(parseLine('say\t你好'), { do: 'handle', message: { intent: 'to_claude', text: '你好' } }, 'a tab separates like a space');
  for (const [word, intent] of [['continue', 'continue'], ['compact', 'compact'], ['new', 'new_session'], ['stop', 'stop'], ['status', 'status']]) {
    assert.deepEqual(parseLine(word), { do: 'handle', message: { intent } }, word);
  }
  assert.deepEqual(parseLine('switch walkie'), { do: 'handle', message: { intent: 'switch_project', project: 'walkie' } });
  assert.deepEqual(parseLine('yes'), { do: 'answer', allow: true, reason: '' });
  assert.deepEqual(parseLine('no'), { do: 'answer', allow: false, reason: '' });
  assert.deepEqual(parseLine('no not in that folder'), { do: 'answer', allow: false, reason: 'not in that folder' });
  assert.deepEqual(parseLine('quit'), { do: 'quit' });
});

test('wait and sleep take seconds; a wait with none gets the default', () => {
  assert.deepEqual(parseLine('wait idle'), { do: 'wait', what: 'idle', seconds: WAIT_SECONDS });
  assert.equal(WAIT_SECONDS, 120);
  assert.deepEqual(parseLine('wait approval 30'), { do: 'wait', what: 'approval', seconds: 30 });
  assert.deepEqual(parseLine('wait working 0.5'), { do: 'wait', what: 'working', seconds: 0.5 });
  assert.deepEqual(parseLine('sleep 2'), { do: 'sleep', seconds: 2 });
  assert.deepEqual(parseLine('sleep 3600'), { do: 'sleep', seconds: 3600 });
});

test('a blank line and a comment are nothing', () => {
  for (const line of ['', '   ', '\t', '# say hello', '   # wait idle']) assert.equal(parseLine(line), null, JSON.stringify(line));
});

test('a line that is not a command is an error naming it, never a guess', () => {
  const bad = (line, pattern) => assert.throws(() => parseLine(line), (err) => err instanceof CommandError && pattern.test(err.message), line);
  bad('say', /say needs the words to say/);
  bad('say   ', /say needs the words to say/);
  bad('switch', /switch needs a project name/);
  bad('wait', /wait is followed by idle, working, approval/);
  bad('wait soon', /wait is followed by idle, working, approval/);
  bad('wait idle 5 6', /wait is followed by idle, working, approval/);
  bad('wait idle 0', /wait needs a number of seconds/);
  bad('wait idle -3', /wait needs a number of seconds/);
  bad('wait idle soon', /wait needs a number of seconds/);
  bad('wait idle 3601', /at most 3600/);
  bad('sleep', /sleep needs a number of seconds/);
  bad('sleep 0', /sleep needs a number of seconds/);
  bad('sleep Infinity', /sleep needs a number of seconds/);
  bad('sleep 3601', /sleep needs a number of seconds/);
  bad('sy hello', /unknown command "sy" \(continue, compact, new, stop, status, say, switch, yes, no, wait, sleep, quit\)/);
  bad('Say hello', /unknown command "Say"/);
});

test('a word that Object.prototype also has is unknown, not a command', () => {
  for (const word of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => parseLine(word), (err) => err instanceof CommandError && err.message.startsWith(`unknown command "${word}"`), word);
  }
});

// ---- runSession, with a manager that is only an emitter and the real approvals queue

function stage({ timeoutMs = 10_000 } = {}) {
  const manager = new EventEmitter();
  manager.started = 0;
  manager.handled = [];
  manager.start = () => {
    manager.started += 1;
  };
  manager.handle = async (message) => {
    manager.handled.push(message);
    return manager.answer(message);
  };
  manager.answer = () => ({});
  const approvals = createApprovals({ timeoutMs });
  const printed = [];
  const print = (text) => printed.push(text);
  return { manager, approvals, printed, print };
}

async function* script(...lines) {
  yield* lines;
}

test('a script is run line by line against the manager, which is started first', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = (message) => (message.intent === 'status' ? { speak: '空闲。' } : {});
  const done = await runSession({ manager, approvals, print, lines: script('# a comment', '', 'say 你好', 'continue', 'status', 'quit', 'say never') });
  assert.equal(done, true);
  assert.equal(manager.started, 1);
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: '你好' }, { intent: 'continue' }, { intent: 'status' }]);
  assert.deepEqual(printed, ['[says] 空闲。']);
});

test('the manager is started before the first line is read', async () => {
  const { manager, approvals, print } = stage();
  let startedWhenRead = null;
  async function* lines() {
    startedWhenRead = manager.started;
    yield 'quit';
  }
  await runSession({ manager, approvals, print, lines: lines() });
  assert.equal(startedWhenRead, 1);
});

test('what the manager reports is printed the way a person reads it', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    manager.emit('working', { tool: 'Bash', summary: 'npm test' });
    manager.emit('working', { tool: 'Read' });
    manager.emit('reply', { kind: 'reply', voice: '好了。', screen: 'line one\nline two', tagged: true, turns: 3, ms: 12_345, costUsd: 0.0264 });
    manager.emit('reply', { kind: 'compact', voice: '压缩完了。', screen: '压缩完了。', tagged: false, turns: 0, ms: 16_000, costUsd: 0 });
    manager.emit('reply', { kind: 'reply', voice: '随便。', screen: '随便。', tagged: false, turns: 1, ms: 900, costUsd: 0.5 });
    manager.emit('notice', { kind: 'new_session', text: '新会话' });
    manager.emit('failure', { kind: 'login', message: '登录过期了' });
    manager.emit('project', { name: 'walkie' });
    manager.emit('idle', { project: 'walkie' });
    return {};
  };
  await runSession({ manager, approvals, print, lines: script('say hi') });
  assert.deepEqual(printed, [
    '[working] thinking',
    '[working] Bash: npm test',
    '[working] Read',
    '[reply] reply, turn 3, 12.3 s, $0.026\n  voice: 好了。\n  screen:\n    line one\n    line two',
    '[reply] compact, 16.0 s, $0.000, no <voice> tag\n  voice: 压缩完了。\n  screen:\n    压缩完了。',
    '[reply] reply, turn 1, 0.9 s, $0.500, no <voice> tag\n  voice: 随便。\n  screen:\n    随便。',
    '[notice] new_session: 新会话',
    '[failure] login: 登录过期了',
    '[project] walkie',
    '[idle]',
  ]);
});

test('an approval is shown with its preview, answered with yes or no, and its outcome printed', async () => {
  const { manager, approvals, print, printed } = stage();
  let first;
  let second;
  setTimeout(() => {
    first = approvals.request({ tool: 'Write', input: { file_path: 'C:\\w\\note.txt', content: 'walkie' }, toolUseId: 'toolu_1' });
    second = approvals.request({ tool: 'Bash', input: { command: 'npm test' }, toolUseId: 'toolu_2' });
  }, 20);
  const done = await runSession({ manager, approvals, print, lines: script('wait approval 5', 'yes', 'no too risky', 'quit') });
  assert.equal(done, true);
  const verdicts = await Promise.all([first, second]);
  assert.deepEqual(verdicts.map((v) => v.behavior), ['allow', 'deny']);
  assert.match(verdicts[1].message, /too risky/);
  assert.equal(printed.length, 4, printed.join('\n'));
  const [shown1, cleared1, shown2, cleared2] = printed;
  const id1 = /^\[approval\] #(\d+) Write\n {4}\S/.exec(shown1)?.[1];
  const id2 = /^\[approval\] #(\d+) Bash\n {4}\S/.exec(shown2)?.[1];
  assert.ok(id1 && id2 && id1 !== id2, `${shown1}\n${shown2}`);
  assert.ok(shown1.endsWith('\n  answer: yes | no [reason]'), shown1);
  assert.ok(shown2.endsWith('\n  answer: yes | no [reason]'), shown2);
  assert.equal(cleared1, `[approval] #${id1} allowed`);
  assert.equal(cleared2, `[approval] #${id2} denied`);
});

test('yes or no with nothing on the screen says so and goes on', async () => {
  const { manager, approvals, print, printed } = stage();
  const done = await runSession({ manager, approvals, print, lines: script('yes', 'no', 'say after') });
  assert.equal(done, true);
  assert.deepEqual(printed, ['[approval] nothing is waiting', '[approval] nothing is waiting']);
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: 'after' }]);
});

test('wait idle goes on at once when nothing is running, and waits for the idle event while a turn is', async () => {
  const { manager, approvals, print } = stage();
  const order = [];
  manager.answer = (message) => {
    if (message.text === 'slow') {
      manager.emit('working', {});
      setTimeout(() => {
        order.push('idle');
        manager.emit('idle', {});
      }, 40);
    }
    return {};
  };
  async function* lines() {
    yield 'wait idle 5'; // nothing is running yet
    yield 'say slow';
    yield 'wait idle 5';
    order.push('after the wait');
  }
  const done = await runSession({ manager, approvals, print, lines: lines() });
  assert.equal(done, true);
  assert.deepEqual(order, ['idle', 'after the wait']);
});

test('wait working goes on when the next turn starts, wait approval when one is on the screen', async () => {
  const { manager, approvals, print, printed } = stage();
  setTimeout(() => manager.emit('working', {}), 30);
  setTimeout(() => approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'x' }, toolUseId: 'toolu_9' }), 60);
  const done = await runSession({ manager, approvals, print, lines: script('wait working 5', 'wait approval 5', 'no', 'quit') });
  assert.equal(done, true);
  assert.equal(printed[0], '[working] thinking');
  assert.match(printed[1], /^\[approval\] #\d+ Write/);
  assert.match(printed[2], /^\[approval\] #\d+ denied$/);
});

test('wait working and wait approval go on at once when it is already so', async () => {
  const { manager, approvals, print } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'x' }, toolUseId: 'toolu_9' });
  // the 0.05 s is the whole wait: a script that had to wait for something new would run out
  const done = await runSession({ manager, approvals, print, lines: script('wait approval 0.05', 'say go', 'wait working 0.05', 'no', 'quit') });
  assert.equal(done, true);
});

test('wait idle does not go on while a turn is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say go', 'wait idle 0.05', 'quit') }), false);
  assert.deepEqual(printed, ['[working] thinking', '[wait] idle did not happen in 0.05 s']);
});

test('a wait that runs out says what did not happen and ends the run without reading on', async () => {
  const { manager, approvals, print, printed } = stage();
  const done = await runSession({ manager, approvals, print, lines: script('wait working 0.05', 'say never') });
  assert.equal(done, false);
  assert.deepEqual(printed, ['[wait] working did not happen in 0.05 s']);
  assert.deepEqual(manager.handled, []);
});

test('the end of the input waits for the turn that is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    setTimeout(() => manager.emit('idle', {}), 40);
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say slow') }), true);
  assert.deepEqual(printed, ['[working] thinking', '[idle]']);
});

test('a turn that never ends fails the run, after the 120 s the end of the input waits', async (t) => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  const waits = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    waits.push(ms);
    return real(fn, ms >= WAIT_SECONDS * 1000 ? 30 : ms, ...rest); // the 120 s, shortened to get on with it
  });
  assert.equal(await runSession({ manager, approvals, print, lines: script('say stuck') }), false);
  assert.ok(waits.includes(WAIT_SECONDS * 1000), `a wait of ${WAIT_SECONDS} s was set: ${waits}`);
  assert.deepEqual(printed, ['[working] thinking', `[wait] idle did not happen in ${WAIT_SECONDS} s`]);
});

test('a wait runs out when its seconds are over, not before and not after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  let result;
  const run = runSession({ manager, approvals, print, lines: script('say go', 'wait idle 5') }).then((done) => (result = done));
  const settle = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate is not mocked: what is waiting on promises has run
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(result, undefined, 'it is still waiting after 4.999 s');
  t.mock.timers.tick(1);
  await run;
  assert.equal(result, false);
  assert.deepEqual(printed, ['[working] thinking', '[wait] idle did not happen in 5 s']);
});

test('quit ends the run at once, without waiting for the turn that is running', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, lines: script('say go', 'quit') }), true);
  assert.deepEqual(printed, ['[working] thinking']);
});

test('sleep waits through the injected clock for as long as it was told', async () => {
  const { manager, approvals, print } = stage();
  const slept = [];
  const done = await runSession({ manager, approvals, print, sleep: async (ms) => slept.push(ms), lines: script('sleep 2', 'sleep 0.25') });
  assert.equal(done, true);
  assert.deepEqual(slept, [2000, 250]);
});

test('a line that is not a command stops the script after the lines before it have run', async () => {
  const { manager, approvals, print } = stage();
  await assert.rejects(runSession({ manager, approvals, print, lines: script('say one', 'sya two', 'say three') }), (err) => err instanceof CommandError && /unknown command "sya"/.test(err.message));
  assert.deepEqual(manager.handled, [{ intent: 'to_claude', text: 'one' }]);
});

test('Ctrl+C ends a wait and the run, and prints no complaint about it', async () => {
  const { manager, approvals, print, printed } = stage();
  const ctrlC = new AbortController();
  setTimeout(() => ctrlC.abort(), 30);
  const done = await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('wait working 60', 'say never') });
  assert.equal(done, false);
  assert.deepEqual(printed, []);
  assert.deepEqual(manager.handled, []);
});

test('a signal that is aborted before the first line is read ends the run at once', async () => {
  const { manager, approvals, print } = stage();
  const ctrlC = new AbortController();
  ctrlC.abort();
  assert.equal(await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('say never') }), false);
  assert.deepEqual(manager.handled, []);
});

test('a signal aborted at the end of the input ends the wait for idle without a complaint', async () => {
  const { manager, approvals, print, printed } = stage();
  manager.answer = () => {
    manager.emit('working', {});
    return {};
  };
  const ctrlC = new AbortController();
  setTimeout(() => ctrlC.abort(), 30);
  assert.equal(await runSession({ manager, approvals, print, signal: ctrlC.signal, lines: script('say stuck') }), false);
  assert.deepEqual(printed, ['[working] thinking']);
});

test('Ctrl+C while the last command runs ends the run at once, not after the 120 s the end of the input waits', async () => {
  const { manager, approvals, print, printed } = stage();
  const abort = new AbortController();
  manager.answer = () => {
    manager.emit('working', {});
    abort.abort();
    return {};
  };
  assert.equal(await runSession({ manager, approvals, print, signal: abort.signal, lines: script('say last') }), false);
  assert.deepEqual(printed, ['[working] thinking']);
});

// ---- the pieces around it

test('ctrlC turns the first SIGINT into an aborted signal and closes the input; a second one is left alone', () => {
  const emitter = new EventEmitter();
  let closed = 0;
  const signal = ctrlC(emitter, { close: () => (closed += 1) });
  assert.equal(signal.aborted, false);
  assert.equal(closed, 0);
  emitter.emit('SIGINT');
  assert.equal(signal.aborted, true);
  assert.equal(closed, 1);
  assert.equal(emitter.listenerCount('SIGINT'), 0, 'with no listener left a second Ctrl+C ends the process, if shutting down hangs');
});

test('stateFor: a developer run starts in the project it was given, and its state is its own, in memory', () => {
  const store = stateFor('ontheBeat');
  assert.equal(store.project(), 'ontheBeat');
  store.setSession('ontheBeat', '6a1f4c2e-0d3b-4c5a-8f7e-123456789abc');
  assert.equal(store.sessionId('ontheBeat'), '6a1f4c2e-0d3b-4c5a-8f7e-123456789abc');
  assert.equal(stateFor('walkie').project(), 'walkie');
  assert.equal(stateFor('walkie').sessionId('ontheBeat'), null, 'nothing of it reaches another run');
});

test('settingsFor: the claude section of the config, with the program replaced by --command', () => {
  const config = { claude: { command: ['claude'], model: 'm', approvalTimeoutSec: 55 }, voice: 'marin' };
  assert.deepEqual(settingsFor(config, {}), { command: ['claude'], model: 'm', approvalTimeoutSec: 55 });
  assert.deepEqual(settingsFor(config, { command: '["node","fake.js"]' }), { command: ['node', 'fake.js'], model: 'm', approvalTimeoutSec: 55 });
  assert.throws(() => settingsFor(config, { command: 'node fake.js' }), /--command is the program/);
  assert.deepEqual(config.claude.command, ['claude'], 'the config itself is not changed');
});

test('queueFor: a request nobody answers is denied after approvalTimeoutSec, counted in seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const approvals = queueFor({ approvalTimeoutSec: 2 });
  const outcomes = [];
  approvals.on('clear', (c) => outcomes.push(c.outcome));
  const verdict = approvals.request({ tool: 'Write', input: { file_path: 'a.txt', content: 'b' }, toolUseId: 'toolu_1' });
  t.mock.timers.tick(1999);
  assert.deepEqual(outcomes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(outcomes, ['timeout']);
  assert.equal((await verdict).behavior, 'deny');
});

test('cleanEnv takes out what points a nested claude at the Claude app, and nothing else', () => {
  const env = { PATH: 'p', HOME: 'h', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', claude_lower: 'y', ANTHROPIC_API_KEY: 'k', Anthropic_Base: 'b', MY_CLAUDE: 'keep', NOT_ANTHROPIC: 'keep' };
  assert.deepEqual(cleanEnv(env), { PATH: 'p', HOME: 'h', MY_CLAUDE: 'keep', NOT_ANTHROPIC: 'keep' });
  assert.equal(env.CLAUDECODE, '1', 'the original is not changed');
});

test('--command is a JSON array of non-empty strings, otherwise an error that shows the form', () => {
  assert.deepEqual(commandFrom('["node","fake-claude.js"]'), ['node', 'fake-claude.js']);
  assert.deepEqual(commandFrom('["claude"]'), ['claude']);
  for (const text of ['node fake.js', '[]', '{"a":1}', '["node",3]', '["node",""]', '"node"', 'null', '[', '']) {
    assert.throws(() => commandFrom(text), /--command is the program and its leading arguments as a JSON array of strings/, JSON.stringify(text));
  }
});

test('projectsFor: one folder, called dev, is the default; --cwd names another', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-pf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(projectsFor({}, { cwd: dir }), { projects: [{ name: 'dev', aliases: [], path: dir }], active: 'dev' });
  assert.deepEqual(projectsFor({ cwd: dir }, { cwd: 'C:\\somewhere\\else' }), { projects: [{ name: 'dev', aliases: [], path: dir }], active: 'dev' });
  assert.equal(projectsFor({ cwd: '.' }).projects[0].path, process.cwd(), 'a relative folder is made absolute: claude is started in it from another folder');
  assert.throws(() => projectsFor({ cwd: path.join(dir, 'nope') }, { cwd: dir }), /--cwd .*nope: not a folder/);
  const file = path.join(dir, 'a-file.txt');
  writeFileSync(file, 'x');
  assert.throws(() => projectsFor({ cwd: file }, { cwd: dir }), /a-file\.txt: not a folder/);
});

test('projectsFor: --project uses projects.json and must name one of its projects; it cannot be mixed with --cwd', () => {
  const projects = [{ name: 'walkie', aliases: ['沃奇'], path: 'C:\\w' }, { name: 'ontheBeat', aliases: [], path: 'C:\\b' }];
  assert.deepEqual(projectsFor({ project: 'ontheBeat' }, { load: () => projects }), { projects, active: 'ontheBeat' });
  assert.throws(() => projectsFor({ project: 'nope' }, { load: () => projects }), /--project nope: not in projects\.json \(walkie, ontheBeat\)/);
  assert.throws(() => projectsFor({ project: 'walkie', cwd: 'C:\\w' }, { load: () => projects }), /--cwd and --project cannot be used together/);
});
```

The new options of the argument parser:

In `bridge/test/dev/args.test.js`, replace

```js
test('text that only looks like a flag is text', () => {
```

with

```js
test('--cwd, --project and --command take a value, and --clean-env stays with the arguments', () => {
  assert.deepEqual(parseArgs(['claude', '--cwd', 'C:\\w', '--command', '["node","fake.js"]', '--clean-env']), { name: 'claude', args: ['--clean-env'], opts: { cwd: 'C:\\w', command: '["node","fake.js"]' } });
  assert.deepEqual(parseArgs(['claude', '--project=walkie']), { name: 'claude', args: [], opts: { project: 'walkie' } });
  for (const argv of [['claude', '--cwd'], ['claude', '--cwd', '--clean-env'], ['claude', '--project='], ['claude', '--command']]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && /needs a value/.test(err.message), argv.join(' '));
  }
  assert.throws(() => parseArgs(['claude', '--cwd', 'a', '--cwd=b']), (err) => err instanceof UsageError && err.message === '--cwd was given twice');
});

test('text that only looks like a flag is text', () => {
```

And the real `walkie-dev` binary, run against the stand-in. Its test helper learns to feed stdin and to report what the run left in its `%APPDATA%`:

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
```

with

```js
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
```

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
const BIN = fileURLToPath(new URL('../../bin/walkie-dev.js', import.meta.url));
```

with

```js
const BIN = fileURLToPath(new URL('../../bin/walkie-dev.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../claude/fake-claude.js', import.meta.url));
```

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
// `nodeArgs` go to node in front of the bin, `env` over the environment it is given.
function walkieDevWith({ nodeArgs = [], env = {} }, ...args) {
```

with

```js
// `nodeArgs` go to node in front of the bin, `env` over the environment it is given, `input` to its stdin. `files` is what the
// run left in its %APPDATA% (an empty folder that is thrown away afterwards).
function walkieDevWith({ nodeArgs = [], env = {}, input }, ...args) {
```

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
      timeout: 20_000,
```

with

```js
      timeout: 20_000,
      input,
```

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
    return { status: run.status, out: run.stdout, err: run.stderr };
```

with

```js
    return { status: run.status, out: run.stdout, err: run.stderr, files: readdirSync(appdata, { recursive: true }) };
```

In `bridge/test/dev/walkie-dev.test.js`, replace

```js
test('a flag with no value stops the command with exit 2 before any key is loaded', () => {
```

with

```js
test('with no command it lists every command it has, and exits 0', () => {
  const run = walkieDev();
  assert.equal(run.status, 0);
  for (const name of ['ping', 'cmd', 'term', 'listen', 'loopback', 'play', 'hear', 'say', 'classify', 'claude']) {
    assert.match(run.out, new RegExp(`^  ${name} `, 'm'), name);
  }
});

test('a flag with no value stops the command with exit 2 before any key is loaded', () => {
```

and, at the end of that file, the tests of the command itself:

Append to the end of `bridge/test/dev/walkie-dev.test.js`:

```js

// ---- claude: the session manager from a terminal, run against the stand-in for claude (test/claude/fake-claude.js)

// A project folder and the stand-in's settings; the stand-in writes a line to `starts` for every process it is.
function claudeWorld(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'walkie-devclaude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const project = path.join(dir, 'proj');
  mkdirSync(project);
  const argsFile = path.join(dir, 'starts.jsonl');
  const fake = JSON.stringify({ bootMs: 0, turnMs: 0, stateDir: path.join(dir, 'sessions'), argsFile });
  const argv = (extra = []) => ['claude', '--cwd', project, '--command', JSON.stringify([process.execPath, FAKE_CLAUDE]), ...extra];
  return {
    project,
    argv,
    env: { FAKE_CLAUDE: fake },
    run: (script, { extra = [], env = {}, nodeArgs = [] } = {}) => walkieDevWith({ input: script, nodeArgs, env: { FAKE_CLAUDE: fake, ...env } }, ...argv(extra)),
    starts: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

// The permission server's token, as the stand-in was given it on its command line.
function tokenOf(start) {
  const config = JSON.parse(start.argv[start.argv.indexOf('--mcp-config') + 1]);
  return config.mcpServers.walkie.headers.Authorization.replace(/^Bearer /, '');
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('claude: a script on stdin is run against the stand-in, and what happens is printed', (t) => {
  const { run, project, starts } = claudeWorld(t);
  const result = run('# the first words\nsay 你好\nwait idle 20\nquit\n');
  assert.equal(result.status, 0, result.err);
  const [first] = result.out.split('\n');
  assert.ok(first.startsWith(`[claude] ${project}, starting in dev; permission server on http://127.0.0.1:`), first);
  assert.match(first, /:\d+\/mcp$/);
  assert.match(result.out, /\[working\] thinking\n/);
  assert.match(result.out, /\[reply\] reply, turn 1, [\d.]+ s, \$0\.012\n {2}voice: I heard: 你好\n {2}screen:\n {4}I heard: 你好 \(turn 1\)\n/);
  assert.match(result.out, /\[idle\]\n$/);
  const token = tokenOf(starts()[0]);
  assert.ok(token.length >= 16, 'the stand-in was given a token');
  assert.ok(!(result.out + result.err).includes(token), "the permission server's token is never printed");
  assert.deepEqual(result.files, [], "a developer run keeps no session ids: nothing of it is written to the bridge's own folder");
});

test('claude: the end of the input waits for the turn that is running, then ends', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say 你好\n');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /voice: I heard: 你好/);
  assert.match(result.out, /\[idle\]\n$/);
});

test('claude: a Write is asked for on the screen, and yes lets it through, no keeps it out', (t) => {
  const { run, project } = claudeWorld(t);
  const yes = run('say !write note.txt\nwait approval 20\nyes\nwait idle 20\nquit\n');
  assert.equal(yes.status, 0, yes.err);
  assert.match(yes.out, /\[approval\] #(\d+) Write\n[\s\S]*?\n {2}answer: yes \| no \[reason\]\n[\s\S]*?\[approval\] #\1 allowed\n/);
  assert.match(yes.out, /voice: I made note\.txt\./);
  assert.equal(readFileSync(path.join(project, 'note.txt'), 'utf8'), 'walkie');

  rmSync(path.join(project, 'note.txt'));
  const no = run('say !write note.txt\nwait approval 20\nno 先别写\nwait idle 20\nquit\n');
  assert.equal(no.status, 0, no.err);
  assert.match(no.out, /\[approval\] #(\d+) denied\n/);
  assert.match(no.out, /voice: You refused it, so note\.txt was not made\./);
  assert.ok(!existsSync(path.join(project, 'note.txt')), 'a refused Write wrote nothing');
});

test('claude: --clean-env takes the CLAUDE* and ANTHROPIC* variables out of what claude is given', (t) => {
  const { run, starts } = claudeWorld(t);
  const env = { CLAUDE_WALKIE_MARK: '1', ANTHROPIC_WALKIE_MARK: '1' };
  const marks = (record) => record.claudeVars.filter((name) => name.endsWith('_WALKIE_MARK'));
  assert.equal(run('say hi\nwait idle 20\nquit\n', { env }).status, 0);
  assert.deepEqual(marks(starts()[0]), ['ANTHROPIC_WALKIE_MARK', 'CLAUDE_WALKIE_MARK'], 'without the switch claude is given them');
  // FAKE_CLAUDE, which the stand-in cannot start without, is neither CLAUDE* nor ANTHROPIC*: it gets through
  assert.equal(run('say hi\nwait idle 20\nquit\n', { env, extra: ['--clean-env'] }).status, 0);
  assert.equal(starts().length, 2);
  assert.deepEqual(marks(starts()[1]), [], 'with it, it is not');
});

test('claude: a wait that runs out ends the run with exit 1 and leaves no claude behind', (t) => {
  const { run, starts } = claudeWorld(t);
  const result = run('say !sleep 8000\nwait idle 0.5\nsay never\n');
  assert.equal(result.status, 1, result.err);
  assert.match(result.out, /\[wait\] idle did not happen in 0\.5 s\n/);
  assert.ok(!result.out.includes('never'), 'the script was not read on');
  const [{ pid }] = starts();
  assert.ok(!alive(pid), 'the process of the turn that was still running was killed');
});

test('claude: a line that is not a command ends the run with exit 2, after the lines before it have run', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say first\nwait idle 20\nsya second\nsay third\n');
  assert.equal(result.status, 2, result.err);
  assert.match(result.err, /walkie-dev claude: unknown command "sya"/);
  assert.match(result.out, /voice: I heard: first/);
  assert.ok(!result.out.includes('third'));
});

test('claude: what cannot be used is refused before anything is started', (t) => {
  const { project, starts, env } = claudeWorld(t);
  const standIn = ['--command', JSON.stringify([process.execPath, FAKE_CLAUDE])]; // whatever goes wrong, it is never the real claude
  const refused = (args, pattern) => {
    const result = walkieDevWith({ input: 'say never\n', env }, 'claude', ...args);
    assert.equal(result.status, 1, result.err);
    assert.match(result.err, pattern);
    assert.ok(!result.out.includes('[claude]'), result.out);
  };
  refused(['--cwd', project, '--project', 'walkie', ...standIn], /--cwd and --project cannot be used together/);
  refused(['--cwd', path.join(project, 'nope'), ...standIn], /nope: not a folder/);
  refused(['--cwd', project, ...standIn, 'extra'], /the commands are read from stdin/);
  refused(['--project', 'no-such-project', ...standIn], /--project no-such-project: not in projects\.json/);
  refused(['--cwd', project, '--command', 'node fake.js'], /--command is the program and its leading arguments as a JSON array of strings/);
  assert.deepEqual(starts(), []);
});

test('claude: quit with an approval still on the screen denies it, and nothing is written', (t) => {
  const { run, project } = claudeWorld(t);
  const result = run('say !write note.txt\nwait approval 20\nquit\n');
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /\[approval\] #(\d+) Write[\s\S]*\[approval\] #\1 denied\n/);
  assert.ok(!existsSync(path.join(project, 'note.txt')), 'the Write that was waiting for his answer did not happen');
});

test('claude ends by itself: it does not call process.exit() after closing its server and killing claude', (t) => {
  const { run } = claudeWorld(t);
  const result = run('say hi\nwait idle 20\nquit\n', { nodeArgs: ['--import', EXIT_PRELOAD] });
  assert.equal(result.status, 0, result.err);
  assert.ok(!result.err.includes('process.exit() was called'), 'claude called process.exit()');
});

// In a terminal the input does not end after `quit`: the process has to let go of it itself.
test('claude: quit ends the run although its input stays open', async (t) => {
  const { argv, env } = claudeWorld(t);
  const appdata = mkdtempSync(path.join(tmpdir(), 'walkie-bin-'));
  t.after(() => rmSync(appdata, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--import', EXIT_PRELOAD, BIN, ...argv()], { env: { ...process.env, APPDATA: appdata, OPENAI_API_KEY: '', GEMINI_API_KEY: '', ...env } });
  let err = '';
  child.stderr.on('data', (chunk) => (err += chunk));
  child.stdout.resume();
  child.stdin.write('say hi\nwait idle 20\nquit\n'); // and no end(): the terminal is still there
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('it did not end by itself'));
    }, 15_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(code, 0, err);
  assert.ok(!err.includes('process.exit() was called'), 'the loop was not empty: the cut-off had to end it');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test bridge/test/dev/claude.test.js bridge/test/dev/args.test.js bridge/test/dev/walkie-dev.test.js`
Expected: FAIL. `claude.test.js` fails with `ERR_MODULE_NOT_FOUND` for `src/dev/claude.js`; in `args.test.js` the new test fails because `--cwd` is not an option yet; in `walkie-dev.test.js` the listing test fails (there is no `claude` line) and so do the ten tests whose names start with `claude`, because the command is unknown. The older tests of both files keep passing: 14 pass and 13 fail in all.

- [ ] **Step 3: Write the command, and teach the parser and the bin about it**

Create `bridge/src/dev/claude.js`:

```js
// The session manager from a terminal, with no S3: claude runs the way the bridge will run it, the permission server and the
// approvals queue are the real ones, and what the wrist would do is typed instead. One command per line on stdin:
//   say <text>                         what he would say to Claude
//   continue | compact | new | stop | status      the spoken commands of the same names
//   switch <project>                   switch_project (needs --project: the default is one project, the current folder)
//   yes | no [reason]                  answer the approval that is on the screen
//   wait idle|working|approval [secs]  go on when that is so (120 s at most unless told); a wait that runs out ends the run
//   sleep <secs>                       do nothing for a while (to see the idle close, or a prewarmed process, work)
//   quit                               end it now; the end of the input waits for the turn that is running, then ends
// Options:
//   --cwd <dir>        the one project is that folder (default: the current folder, called "dev")
//   --project <name>   use bridge/projects.json and start in that project
//   --command <json>   the program and its leading arguments as a JSON array, for a stand-in: '["node","fake-claude.js"]'
//   --clean-env        claude is given the environment without CLAUDE* and ANTHROPIC* variables; needed inside the Claude app's
//                      own shell, whose variables point a nested claude at the app instead of at the login
import { statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createManager } from '../claude/manager.js';
import { loadConfig } from '../config/config.js';
import { loadProjects } from '../config/projects.js';
import { createStateStore } from '../config/state.js';
import { createApprovals } from '../perm/approvals.js';
import { createPermServer } from '../perm/server.js';

export const WAIT_SECONDS = 120;
const MAX_SECONDS = 3600;
const SPOKEN = { continue: 'continue', compact: 'compact', new: 'new_session', stop: 'stop', status: 'status' };
const WORDS = [...Object.keys(SPOKEN), 'say', 'switch', 'yes', 'no', 'wait', 'sleep', 'quit'];
const WAITS = ['idle', 'working', 'approval'];

export class CommandError extends Error {}

function seconds(text, what) {
  const n = Number(text); // no text at all is NaN or 0: both are refused below
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SECONDS) throw new CommandError(`${what} needs a number of seconds, more than 0 and at most ${MAX_SECONDS}`);
  return n;
}

// One line of the script. Null for a blank line or a comment; a CommandError for a line that is not a command: a typo must
// not run the rest of a script that was written for something else.
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const word = trimmed.split(/\s+/, 1)[0];
  const rest = trimmed.slice(word.length).trim();
  if (word === 'say') {
    if (!rest) throw new CommandError('say needs the words to say');
    return { do: 'handle', message: { intent: 'to_claude', text: rest } };
  }
  if (Object.hasOwn(SPOKEN, word)) return { do: 'handle', message: { intent: SPOKEN[word] } };
  if (word === 'switch') {
    if (!rest) throw new CommandError('switch needs a project name');
    return { do: 'handle', message: { intent: 'switch_project', project: rest } };
  }
  if (word === 'yes') return { do: 'answer', allow: true, reason: '' };
  if (word === 'no') return { do: 'answer', allow: false, reason: rest };
  if (word === 'wait') {
    const [what, secs, extra] = rest.split(/\s+/);
    if (!WAITS.includes(what) || extra !== undefined) throw new CommandError(`wait is followed by ${WAITS.join(', ')} and, if you like, a number of seconds`);
    return { do: 'wait', what, seconds: secs === undefined ? WAIT_SECONDS : seconds(secs, 'wait') };
  }
  if (word === 'sleep') return { do: 'sleep', seconds: seconds(rest, 'sleep') };
  if (word === 'quit') return { do: 'quit' };
  throw new CommandError(`unknown command "${word}" (${WORDS.join(', ')})`);
}

const clock = (ms) => `${(ms / 1000).toFixed(1)} s`;
const indent = (text, by = '    ') => text.split('\n').map((l) => `${by}${l}`).join('\n');

// Runs `lines` (an async iterable of strings) against the manager and the approvals queue. Everything that happens is
// `print`ed. Resolves true when the script ran to its end, false when a wait ran out or `signal` aborted (Ctrl+C). Throws a
// CommandError for a line that is not a command; the manager and the approvals are left to the caller to close.
export async function runSession({ manager, approvals, lines, print = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal }) {
  let busy = false;
  const waiters = new Set();
  const ring = (what) => {
    for (const w of [...waiters]) if (w.what === what) w.done(true);
  };
  const waitFor = (what, secs) => {
    if ((what === 'idle' && !busy) || (what === 'working' && busy) || (what === 'approval' && approvals.current())) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => w.done(false), secs * 1000);
      const w = {
        what,
        done(value) {
          clearTimeout(timer);
          waiters.delete(w);
          resolve(value);
        },
      };
      waiters.add(w);
    });
  };
  signal?.addEventListener('abort', () => {
    for (const w of [...waiters]) w.done(false);
  }, { once: true });

  manager.on('working', ({ tool, summary }) => {
    busy = true;
    print(tool ? `[working] ${tool}${summary ? `: ${summary}` : ''}` : '[working] thinking');
    ring('working');
  });
  manager.on('idle', () => {
    busy = false;
    print('[idle]');
    ring('idle');
  });
  manager.on('reply', (r) => print(`[reply] ${r.kind}, ${r.kind === 'reply' ? `turn ${r.turns}, ` : ''}${clock(r.ms)}, $${r.costUsd.toFixed(3)}${r.tagged ? '' : ', no <voice> tag'}\n  voice: ${r.voice}\n  screen:\n${indent(r.screen)}`));
  manager.on('notice', (n) => print(`[notice] ${n.kind}: ${n.text}`));
  manager.on('failure', (f) => print(`[failure] ${f.kind}: ${f.message}`));
  manager.on('project', (p) => print(`[project] ${p.name}`));
  approvals.on('show', (r) => {
    print(`[approval] #${r.id} ${r.tool}\n${indent(r.preview)}\n  answer: yes | no [reason]`);
    ring('approval');
  });
  approvals.on('clear', (c) => print(`[approval] #${c.id} ${c.outcome}`));

  manager.start();
  for await (const line of lines) {
    if (signal?.aborted) return false;
    const command = parseLine(line);
    if (!command) continue;
    if (command.do === 'quit') return true;
    if (command.do === 'handle') {
      const { speak } = await manager.handle(command.message);
      if (speak) print(`[says] ${speak}`);
    } else if (command.do === 'answer') {
      const shown = approvals.current();
      if (!shown) print('[approval] nothing is waiting');
      else approvals.answer(shown.id, { allow: command.allow, reason: command.reason });
    } else if (command.do === 'sleep') {
      await sleep(command.seconds * 1000);
    } else if (!(await waitFor(command.what, command.seconds))) {
      if (!signal?.aborted) print(`[wait] ${command.what} did not happen in ${command.seconds} s`);
      return false;
    }
  }
  if (signal?.aborted) return false;
  if (await waitFor('idle', WAIT_SECONDS)) return true; // the end of the input: let the turn that is running finish
  if (!signal?.aborted) print(`[wait] idle did not happen in ${WAIT_SECONDS} s`);
  return false;
}

export function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(CLAUDE|ANTHROPIC)/i.test(name)));
}

export function commandFrom(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((s) => typeof s === 'string' && s)) {
    throw new Error('--command is the program and its leading arguments as a JSON array of strings, like \'["node","fake-claude.js"]\'');
  }
  return parsed;
}

// The projects the run may use: the one folder, or bridge/projects.json with `--project`.
export function projectsFor(opts, { cwd = process.cwd(), load = loadProjects } = {}) {
  if (opts.cwd !== undefined && opts.project !== undefined) throw new Error('--cwd and --project cannot be used together: one folder, or a project from projects.json');
  if (opts.project !== undefined) {
    const projects = load();
    if (!projects.some((p) => p.name === opts.project)) throw new Error(`--project ${opts.project}: not in projects.json (${projects.map((p) => p.name).join(', ')})`);
    return { projects, active: opts.project };
  }
  const folder = path.resolve(opts.cwd ?? cwd);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--cwd ${folder}: not a folder`);
  return { projects: [{ name: 'dev', aliases: [], path: folder }], active: 'dev' };
}

// A developer run keeps its state in memory, so that it cannot touch the session ids of the real bridge, and starts in `active`.
export function stateFor(active) {
  const store = createStateStore({ file: null });
  store.setProject(active);
  return store;
}

// The claude section of the config, with the program replaced when `--command` names a stand-in.
export function settingsFor(config, opts) {
  return { ...config.claude, ...(opts.command ? { command: commandFrom(opts.command) } : {}) };
}

// The queue of approvals: a request that nobody answers is denied after claude.approvalTimeoutSec, below the 60 s at which
// claude's own client gives up on a pending call.
export const queueFor = (settings) => createApprovals({ timeoutMs: settings.approvalTimeoutSec * 1000 });

// Ctrl+C: the waits end, no more lines are read, and the run closes what it started. Returns the signal that says so.
export function ctrlC(emitter, lines) {
  const controller = new AbortController();
  emitter.once('SIGINT', () => {
    controller.abort();
    lines.close();
  });
  return controller.signal;
}

export default async function claude(args, opts) {
  if (args.length > 0 && !(args.length === 1 && args[0] === '--clean-env')) throw new Error('claude [--cwd dir | --project name] [--command json] [--clean-env]  (the commands are read from stdin)');
  const config = loadConfig();
  const { projects, active } = projectsFor(opts);
  const store = stateFor(active);
  const settings = settingsFor(config, opts);
  const approvals = queueFor(settings);
  const server = createPermServer({ decide: (request) => approvals.request(request), log: (line) => console.log(`[log] ${line}`) });
  const mcp = await server.start();
  const manager = createManager({
    config: settings,
    projects,
    store,
    mcp,
    env: args.includes('--clean-env') ? cleanEnv(process.env) : process.env,
    log: (line) => console.log(`[log] ${line}`),
  });
  const lines = createInterface({ input: process.stdin });
  const signal = ctrlC(process, lines);
  try {
    console.log(`[claude] ${projects.length === 1 ? projects[0].path : `${projects.length} projects`}, starting in ${active}; permission server on ${mcp.url}`);
    if (!(await runSession({ manager, approvals, lines, signal }))) process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    console.error(`walkie-dev claude: ${err.message}`);
    process.exitCode = 2;
  } finally {
    lines.close();
    approvals.denyAll();
    await manager.close();
    await server.close();
  }
}
```

The parser takes the three options that carry a value and the switch that does not:

In `bridge/src/dev/args.js`, replace

```js
const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider'];
const SWITCHES = ['--all']; // stays among the arguments, for the command that reads it
```

with

```js
const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider', '--cwd', '--project', '--command'];
const SWITCHES = ['--all', '--clean-env']; // stay among the arguments, for the command that reads them
```

The bin lists the command, knows its module, and ends it the way it ends `hear`, `say` and `classify`: by letting the loop empty. `claude` has just closed a server and killed a process, which is the situation that tripped the libuv assertion in plan 2.

In `bridge/bin/walkie-dev.js`, replace

```js
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)`;
```

with

```js
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)
  claude [--cwd dir | --project name] [--command json] [--clean-env]   the session manager from a terminal: it reads
                           commands on stdin (say, continue, compact, new, stop, status, switch, yes, no, wait, sleep, quit)
                           and runs the real claude (Claude's quota) unless --command names a stand-in`;
```

In `bridge/bin/walkie-dev.js`, replace

```js
  classify: () => import('../src/dev/classify.js'),
```

with

```js
  classify: () => import('../src/dev/classify.js'),
  claude: () => import('../src/dev/claude.js'),
```

In `bridge/bin/walkie-dev.js`, replace

```js
// hear, say and classify call the providers. On Node 24 for Windows, process.exit() just after a fetch can trip a libuv
// assertion (exit code 127, after the right output), so they end when the loop empties; the timer only cuts off one that
// left something open. The serial commands close their port themselves and exit at once, as before.
const TALKS_TO_PROVIDERS = new Set(['hear', 'say', 'classify']);
if (TALKS_TO_PROVIDERS.has(name)) setTimeout(() => process.exit(), 1000).unref();
```

with

```js
// hear, say and classify call the providers, and claude has just closed a server and killed a process. On Node 24 for
// Windows, process.exit() right after a fetch can trip a libuv assertion (exit code 127, after the right output), so these
// end when the loop empties; the timer only cuts off one that left something open. The serial commands close their port
// themselves and exit at once, as before.
const ENDS_WHEN_THE_LOOP_EMPTIES = new Set(['hear', 'say', 'classify', 'claude']);
if (ENDS_WHEN_THE_LOOP_EMPTIES.has(name)) setTimeout(() => process.exit(), 1000).unref();
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `node --test bridge/test/dev/claude.test.js bridge/test/dev/args.test.js bridge/test/dev/walkie-dev.test.js`
Expected: PASS, 33 tests in `claude.test.js`, 8 in `args.test.js` and 18 in `walkie-dev.test.js`. The binary's tests start real processes and take 10 to 20 s in all.

Run: `npm --prefix bridge test`
Expected: PASS, 538 tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/src/dev/claude.js bridge/src/dev/args.js bridge/bin/walkie-dev.js bridge/test/dev/claude.test.js bridge/test/dev/args.test.js bridge/test/dev/walkie-dev.test.js
git commit -m "Bridge: walkie-dev claude runs the session manager from a terminal, against the real claude or a stand-in" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live: the real `claude` through the manager (gated)

The first time the session manager, the permission server and the approvals queue meet the real `claude`. The recordings of 1 Oct 2026 were made with raw `claude` and a bare MCP server; this runs the code of Tasks 1 to 9 against the real thing, through `walkie-dev claude`. It checks Review Focus 1 and 2 (an approval that nobody answers; a message sent in the middle of a turn), the stop and resume that the stand-in can only imitate, `/compact`, what `claude.prewarm` saves, and whether the 40K cache re-writes of Stage 0 come back.

**Files:**
- Create: a scratch folder outside the repo, `$env:TEMP\walkie-live`, which `claude` is started in. It is empty, it holds only the small text files that Run B asks `claude` to write, and nothing in it is ever committed.
- Nothing else changes. The results are written into the spec in Task 11.

**Interfaces:**
- Consumes: `walkie-dev claude` (Task 9) and the real `claude` 2.1.285 or newer, logged in.
- Produces: numbers and observations for Task 11: the cost and time of the turns, whether a message sent in the middle of a turn was merged, what each of three approvals did, whether `--resume` kept the session, what `/compact` said, and the two total times of the prewarm comparison.

Each of the two gates below is asked separately, with the AskUserQuestion tool, and only a clear yes for that gate counts (Global Constraints). If he says no to one, skip its steps, say so in Task 11's spec text, and go on.

How the runs work: the commands go to `walkie-dev claude` on stdin, one per line (`say`, `wait idle`, `yes`, `quit`, …; the header of `bridge/src/dev/claude.js` lists them), and it prints what the device would show: `[working]`, `[reply]` with the voice line and the screen text, `[idle]`, `[approval]`, `[says]`, and `[log]` lines with times. The permission server and the queue are the real ones. `--clean-env` is needed inside the Claude desktop app's shell, so it is always given. Each run starts a `claude` that loads his own settings and hooks. The manager starts it (`prewarm`) before the first line of the script is read, so the first message waits for what is left of the boot, the SessionStart hooks: 14 to 23 s on 1 Oct. The blocks of expected output below leave out the `[log]` lines about turns, permissions and starting a process unless they matter, and the words and times in them are examples.

- [ ] **Step 1: Make the scratch folder and ask gate F: talking, with no tools**

Run: `New-Item -ItemType Directory -Force "$env:TEMP\walkie-live" | Out-Null; Get-ChildItem "$env:TEMP\walkie-live" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: `0`. If the folder already holds something, use another name in every step below and say so.

What runs: `claude` (Opus 5.5, from `bridge/config.json`) under his Claude login, in `$env:TEMP\walkie-live`, started from `node bridge/bin/walkie-dev.js claude --cwd … --clean-env`. What leaves the PC: a few short sentences of Chinese about counting and about itself (no file, no project, nothing of his), plus what Claude Code always sends at the start of a session: his global context and hook output. It uses no tool, so nothing is written. Cost: about 0.3 US dollars for the first turn, when the prompt cache is cold, and a few cents for each later one; Runs A, C and D together are about six turns, under 1 dollar of plan quota. Suggested question: 「在一个空的临时文件夹里启动真的 Claude（Opus 5.5，用你的登录），让它回答几句简单的话、数数、压缩一次对话；不会用任何工具，不会写文件。大约花 1 美元的额度，可以吗？」

- [ ] **Step 2: Run A: hello, the status sentence, and a message sent in the middle of a turn**

Run:

```powershell
@'
say 用一句话告诉我你收到了。
wait idle 120
status
say 慢慢地从 1 数到 20，每个数字单独占一行。
wait working 120
say 数完以后再说一声“好了”。
wait idle 120
status
quit
'@ | node bridge/bin/walkie-dev.js claude --cwd "$env:TEMP\walkie-live" --clean-env
```

Expected, in this order:

```
[claude] C:\Users\…\walkie-live, starting in dev; permission server on http://127.0.0.1:<port>/mcp
[log] claude: starting dev
[working] thinking
[reply] reply, turn 1, 3.1 s, $0.295
  voice: 收到了。
  screen:
    …
[idle]
[says] dev空闲，这个对话做了1轮，上一轮用了3秒。
[working] thinking
[reply] reply, turn 2, 6.4 s, $0.027
  voice: …
[idle]
[says] dev空闲，这个对话做了2轮，上一轮用了6秒。
```

What to read in it:
- The first `[working]` comes 15 to 30 s after the start: the first message waited for the boot of the prewarmed process. The token of the permission server is never printed.
- A message sent while a turn is running is merged into that turn by `claude`: expect **one** `[reply]` (turn 2) whose screen text counts to 20 and says 「好了」, one `[working] thinking` and one `[idle]` for the pair. If `claude` instead answered twice (`turn 2` and `turn 3`), `[working]` and `[idle]` must still come in pairs; record what happened, as it is how `claude` behaved today.
- Keep the cost of every turn. The second and later turns of a process should cost a few cents. A turn that costs 0.2 dollars or more is the 40K cache re-write of Stage 0 coming back: record which turn.
- A `[failure]` line, or a `[notice] mcp:` line (the permission server did not connect), is the finding. Show it to him, with its kind (`login`, `model`, `other`…), and stop this task.

- [ ] **Step 3: Run C: stop in the middle of a turn, carry on in the same session, and compact**

Run:

```powershell
@'
say 从 1 数到 300，每个数字单独占一行，一次全部写出来。
wait working 120
sleep 5
stop
continue
wait idle 180
compact
wait idle 120
quit
'@ | node bridge/bin/walkie-dev.js claude --cwd "$env:TEMP\walkie-live" --clean-env
```

Expected:

```
[working] thinking
[idle]
[says] 已停止。
[log] claude: starting dev and resuming 6a1f4c2e
[working] thinking
[reply] reply, turn 1, … s, $…
…
[idle]
[working] thinking
[reply] compact, 17.9 s, $0.0…
  voice: 压缩完了，上下文少了86%。
[idle]
```

What to read in it:
- `[idle]` and `[says] 已停止。` come within a moment of `stop`: the run of `working` ends, and the `claude` process tree is gone. A `claude` of this run that is still alive after `stop` would show in `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*stream-json*' }`, which must list nothing once the run has ended. `continue` starts a second process with `--resume` and sends 「继续」: the `[log]` line shows the first 8 characters of the session id it resumed. If `stop` printed `[says] 现在没有在做事。` instead, the count had already finished before the five seconds were over; say so and run it again with 1000 in place of 300.
- Check that `--resume` kept the session rather than starting another: `Get-ChildItem -Recurse -Filter "<those 8 characters>*.jsonl" "$HOME\.claude\projects" | Select-Object FullName` lists one transcript, and no other transcript was made for the folder in this run.
- `/compact` is answered with how much shorter the context got, and the reply's kind is `compact`: its voice line reads 「压缩完了，上下文少了N%。」 with the real number. The compaction itself takes about 18 s.

- [ ] **Step 4: Run D: what `claude.prewarm` saves**

The same one-word question twice. In the first run the message goes in at once, so it waits for the prewarmed process to finish booting; in the second the run sleeps 30 s first, so the boot has finished before the message is sent.

Run:

```powershell
$a = Measure-Command { 'say 只回答一个字：好。', 'wait idle 120', 'quit' | node bridge/bin/walkie-dev.js claude --cwd "$env:TEMP\walkie-live" --clean-env | Out-Null }
$b = Measure-Command { 'sleep 30', 'say 只回答一个字：好。', 'wait idle 120', 'quit' | node bridge/bin/walkie-dev.js claude --cwd "$env:TEMP\walkie-live" --clean-env | Out-Null }
"at once: {0:N1} s, after 30 s: {1:N1} s, the boot that waiting hid: about {2:N1} s" -f $a.TotalSeconds, $b.TotalSeconds, ($a.TotalSeconds - ($b.TotalSeconds - 30))
```

Expected: a line such as `at once: 32.4 s, after 30 s: 38.1 s, the boot that waiting hid: about 24.3 s`. The last number is how long a message sent at once, with no head start, waits for the boot, and so what `prewarm` saves when he lifts the S3 after the bridge has been up for half a minute. If the second run is faster than 30 s plus a turn of a few seconds, the boot is shorter than 30 s and the figure is only a lower bound: say so.

- [ ] **Step 5: Ask gate G: three files, three answers**

What runs: the real `claude` again, in the same scratch folder, asked to create three small text files one after another. Each Write goes through the permission endpoint and the approvals queue, and the script answers the first with yes, the second with no and a reason, and leaves the third unanswered for 55 s. What may change on the PC: `allowed.txt` should appear in `$env:TEMP\walkie-live`, the other two should not. His own permission rules still apply, so a Bash call that they allow could create a file by another route; the step checks for that. What leaves the PC: three short Chinese sentences, and the answers' words. Cost: about 0.1 to 0.2 dollars and four minutes. Suggested question: 「再启动一次真的 Claude，让它在那个临时文件夹里依次创建三个小文本文件。脚本替你答：第一个允许，第二个拒绝并说理由，第三个不回答，让 55 秒的超时去拒绝。只会在那个临时文件夹里创建文件，可以吗？」

- [ ] **Step 6: Run B: allowed, refused with a reason, and unanswered**

Run:

```powershell
@'
say 在当前文件夹里创建文件 allowed.txt，内容是 ok。
wait approval 120
yes
wait idle 120
say 在当前文件夹里创建文件 refused.txt，内容是 no。
wait approval 120
no 这个文件不需要
wait idle 120
say 在当前文件夹里创建文件 silent.txt，内容是 later。
wait approval 120
wait idle 120
quit
'@ | node bridge/bin/walkie-dev.js claude --cwd "$env:TEMP\walkie-live" --clean-env
```

Expected (paths shortened):

```
[approval] #1 Write
    C:\Users\…\walkie-live\allowed.txt
    2 字
    ok
  answer: yes | no [reason]
[approval] #1 allowed
[reply] reply, turn 1, … s, $…
…
[approval] #2 Write
    …\refused.txt
…
[approval] #2 denied
[reply] reply, turn 2, …
  voice: 好的，我没有创建这个文件。
[approval] #3 Write
    …\silent.txt
…
[approval] #3 timeout
[reply] reply, turn 3, …
```

What to read in it, and what each means for the plan:
- `#3 timeout` comes about 55 s after `#3 Write` was shown, and **no `#4`** follows for the same file. That is the 55 s limit working: the verdict reaches `claude` before its client gives up at 60 s, so the model is not asked to retry. If a `#4` for `silent.txt` appears, `claude` asked again, and the limit must come down: record the times between the lines and stop here; do not change the number in this task.
- The reply to `no 这个文件不需要` shows that `claude` was told the reason (it should mention that the user declined, and may repeat the reason); the reply to the timeout shows that it was told nobody answered.
- `Get-ChildItem "$env:TEMP\walkie-live"` lists `allowed.txt` with the content `ok`, and no `refused.txt` or `silent.txt`. If one of those two exists, `claude` found another way (a Bash call that his rules allow): that is not a bridge failure, but record it.

- [ ] **Step 7: Clean up and keep the results**

Run: `Remove-Item -Recurse -Force "$env:TEMP\walkie-live"`; then `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*walkie-dev*' -or $_.CommandLine -like '*stream-json*' }` should list nothing: no `walkie-dev` and no `claude` that this task started is left running.

Keep these for Task 11: the cost and time of each turn (the first of a cold run, the later ones, whether any looked like a 40K re-write); whether the message sent in the middle of a turn was merged; the session id check of Run C and what `/compact` said; the two totals of Run D and the figure that comes out of them; and the three approvals with the time of `#3 timeout`. There is no commit in this task.

---

### Task 11: The README, and the spec records what this plan measured

The last task: the README says what is new, and the spec's text is brought in line with what was measured with the real `claude`: three decisions that depart from it (55 s, no SDK, prewarm) and two of the open items of §10.

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-09-29-walkie-design.md` (§6.3, §6.4, §8 and §10)

**Interfaces:**
- Consumes: the numbers kept from Task 10.
- Produces: a README that lists `claude` among the developer commands and says what it needs, and a spec that says what is now known.

- [ ] **Step 1: Update the README**

Three edits: the layout row of `bridge/`, the prerequisite of the real `claude`, and the developer command list.

In `README.md`, replace

```markdown
`src/intent` and `src/config` decide what was said and read the settings; `bin/walkie-dev.js` and `src/dev` are developer commands |
```

with

```markdown
`src/intent` and `src/config` decide what was said and read the settings; `src/claude` runs Claude Code, one process per project, resumed, stopped and switched, and `src/perm` is the permission endpoint it asks and the queue of approvals waiting for the wrist; `bin/walkie-dev.js` and `src/dev` are developer commands |
```

In `README.md`, replace

```markdown
- ffmpeg on PATH, for `walkie-dev play <file>`.
```

with

```markdown
- ffmpeg on PATH, for `walkie-dev play <file>`.
- Claude Code (`claude` on PATH, logged in), for `walkie-dev claude` against the real thing and for the bridge itself. The tests never start it: they run a stand-in, `bridge/test/claude/fake-claude.js`.
```

In `README.md`, replace

```markdown
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify.
```

with

```markdown
developer commands: ping, cmd, term, listen, loopback, play, hear, say, classify, claude.
```

In `README.md`, replace

```markdown
An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.
```

with

```markdown
An option the dev CLI does not know, a flag without a value and a flag given twice all stop it with exit 2 before any key is loaded.

`claude` runs the session manager from a terminal, with no S3. It reads one command per line on stdin (`say <text>`, `yes`, `no [reason]`, `stop`, `continue`, `compact`, `new`, `status`, `switch <project>`, `wait idle`, `wait approval`, `sleep <s>`, `quit`; the header of `bridge/src/dev/claude.js` lists them all) and prints what the device would show. It starts the real `claude`, with his login and his quota, in the folder of `--cwd <dir>` (default: the current one) or in a project of `projects.json` with `--project <name>`; the permission server and the approvals are the real ones. Inside the Claude desktop app's own shell it needs `--clean-env`, because the variables of that shell point a nested `claude` at the app. `--command '<json array>'` replaces the program, for the stand-in of the tests. It keeps its state in memory and never touches `%APPDATA%\walkie\state.json`.
```

- [ ] **Step 2: Record what was measured in the spec**

Seven edits to §6.3, §6.4, §8 and §10; the last of them also adds two new items to §10. In the §10 texts, each `<…>` is a value kept from Task 10: replace it with that value and leave nothing in angle brackets. A check he declined, or one that could not run, is written as `Not checked: <why>.` in place of its numbers, and the item then says what is still untested.

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
Dependencies: `serialport` and `@modelcontextprotocol/sdk`; OpenAI and Gemini are called with `fetch`.
```

with

```markdown
One dependency, `serialport`. OpenAI and Gemini are called with `fetch`, and the permission endpoint (§6.4) is a small hand-written MCP server on `node:http`: the real client's whole conversation with it is six JSON-RPC calls (measured 1 Oct 2026, plan 3), so the MCP SDK would only add a dependency.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
It starts on the first `to_claude` message. After 60 min idle the bridge closes its stdin so it exits cleanly, and the next message resumes the session.
```

with

```markdown
With `claude.prewarm` (on by default) it starts with the bridge and after a switch, so that the first message does not wait for the boot (14 to 23 s on 1 Oct 2026: the SessionStart hooks); with it off it starts on the first `to_claude` message. After 60 min idle (`claude.idleMinutes`) the bridge closes its stdin so it exits cleanly, and the next message resumes the session. A message sent while a turn is running is merged into that turn by `claude`: one `result` answers both.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
With no answer in 120 s the verdict is deny, with the message 「手腕上没人回应，先别做。」
```

with

```markdown
With no answer in 55 s (`claude.approvalTimeoutSec`) the verdict is deny, with the message 「手腕上没人回应，先别做。」 It cannot be longer: `claude`'s own MCP client drops a pending call at about 60 s (59,999 and 59,996 ms measured on 1 Oct 2026) and the model then asks once more, so a longer wait would run every unanswered approval twice, and a late yes would allow a call that `claude` had already given up on.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
`system/init` gives the session id and model;
```

with

```markdown
`system/init`, printed at the start of every turn and not once per process, gives the session id and model;
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
| Approval unanswered for 120 s |
```

with

```markdown
| Approval unanswered for 55 s |
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- The permission MCP over HTTP (Stage 0 used stdio).
```

with

```markdown
- The permission MCP over HTTP (Stage 0 used stdio). Done (plan 3, 1 Oct 2026): a hand-written `node:http` server, no SDK. `claude` 2.1.285 asks `server/discover` first (answered -32601), then `initialize`, `notifications/initialized` (202), a GET (405) and `tools/list`, and calls the tool with `tool_name`, `input` and `tool_use_id`; the answer is one text block holding `{behavior: "allow", updatedInput}` or `{behavior: "deny", message}`. Its client drops a pending call at about 60 s and the model retries once, so an unanswered approval is denied at 55 s. Checked on <date> through `walkie-dev claude` against the real `claude`: a Write allowed <what happened>; a Write refused with a reason <what Claude said back>; a Write left unanswered <denied N s after it was shown, and Claude did / did not ask again>.
```

In `docs/superpowers/specs/2026-09-29-walkie-design.md`, replace

```markdown
- The ~40K cache re-writes in the first process's turns 2 and 3.
```

with

```markdown
- The ~40K cache re-writes in the first process's turns 2 and 3. Not reproduced (plan 3). On 1 Oct 2026 the first turn of a process wrote 36,118 tokens ($0.2946, 10.2 s; 27.6 s with the boot) and the next three wrote 280, 189 and 426 and read about 106K ($0.026 each); a resumed process wrote 35.5K on its first turn ($0.29), once more. Through the manager on <date>: the turns cost <the cost of each turn, in order>, so <no turn re-wrote anything of that size / the turn that cost $x did>. The first turn of every process costs about $0.3: one more reason to keep a process alive between messages and to start it ahead.
- What `claude.prewarm` saves (plan 3). A message sent at once to a prewarmed process waited for the rest of the boot: the run took <a> s in all; with a 30 s head start it took <b> s, so the boot that waiting hides is about <c> s (<"a lower bound: the boot is shorter than 30 s" or "the boot itself">).
- Stopping, resuming, `/compact` and a message in the middle of a turn, against the real `claude` (plan 3, <date>). `stop` in the middle of a long answer ended the process tree at once; `continue` resumed session <the first 8 characters> and no second transcript was made. A message sent in the middle of a turn was <merged: one reply for both / answered as a turn of its own>. `/compact` took <N> s and made the context <N>% shorter.
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: exit code 0. The bridge part reports `tests 538`, `pass 538` and `fail 0` (Tasks 10 and 11 add no tests), and the tools and firmware host parts pass as they did at the end of plan 2.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-09-29-walkie-design.md
git commit -m "Docs: spec and README record what plan 3 measured with the real claude" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Report to him**

Report in Chinese, as in every reply to him, and say plainly which checks ran and which did not. Give: the cost and time of the turns and whether any looked like the 40K re-write; whether the message sent in the middle of a turn was merged; the three approvals, with the time of the timeout and whether Claude asked again; whether `stop` and `--resume` kept the session; what `/compact` said; what `prewarm` saves; and the three departures from the spec (55 s, no SDK, prewarm) that are now written into it. Say what is still open in §10: the question of an empty answer from `gpt-transcribe` (a call of his, left by plan 2). Then stop: plan 4 (the firmware's state machine, screens and keys, and the bridge's `ui`, `console` and `main`, which join everything into one voice turn) starts with its own plan.
