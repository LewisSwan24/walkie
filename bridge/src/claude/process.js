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
