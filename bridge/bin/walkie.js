#!/usr/bin/env node
// walkie: the bridge between the S3 and Claude Code. It runs until Ctrl+C.
import { parseWalkieCommand } from '../src/cli.js';
import { loadConfig } from '../src/config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../src/config/keys.js';
import { loadPairKey } from '../src/config/pairkey.js';
import { loadRelayHost } from '../src/config/relay.js';
import { loadProjects } from '../src/config/projects.js';
import { createConsole } from '../src/console.js';
import { UsageError } from '../src/dev/args.js';
import { cleanEnv, commandFrom } from '../src/dev/claude.js';
import { portOpener } from '../src/dev/connect.js';
import { readRecording, runInjected } from '../src/dev/inject.js';
import { bridgeOpenPort, describeTransport } from '../src/link/open-port.js';
import { startBridge } from '../src/main.js';
import { pairCommand } from '../src/pair-cli.js';
import { relayChange } from '../src/relay-cli.js';
import { relayPushCommand, wifiCommand } from '../src/net-cli.js';
import { readSecret } from '../src/prompt.js';
import { createAdapters } from '../src/speech/speech.js';

const USAGE = `usage: node bridge/bin/walkie.js [--port COMx] [--command json] [--clean-env] [--inject file.wav] [--codec pcm|adpcm]
       node bridge/bin/walkie.js pair [--forget] [--port COMx]
       node bridge/bin/walkie.js relay [<host> | --forget] [--pc-only] [--port COMx]
       node bridge/bin/walkie.js wifi add <ssid> | list | remove <ssid> [--port COMx]
  Runs the bridge until Ctrl+C: the S3 on USB, Claude Code in the projects of bridge/projects.json, and the speech providers
  whose keys are in %APPDATA%\\walkie\\keys.env. With no S3 plugged in it waits and connects when one appears; with a pairing key and a
  relay set (walkie relay), it goes by the relay while there is no cable.
  --port COMx       the S3's serial port (default: the one with USB id 303A:1001)
  --command json    the program and its leading arguments as a JSON array, for a stand-in for claude: '["node","fake-claude.js"]'
  --clean-env       claude is given the environment without CLAUDE* and ANTHROPIC* variables; needed inside the Claude app's
                    own shell, whose variables point a nested claude at the app instead of at the login
  --codec adpcm     send replies as ADPCM and ask the S3 for ADPCM takes (default pcm: over the cable there is bandwidth to spare)
  pair              put a new pairing key on the S3 over the cable. Press the front key on the S3 to accept (the side key refuses).
                    The key is kept in %APPDATA%\\walkie\\pair.key and the bridge then talks to the S3 only in sealed frames.
                    pair --forget makes the S3 forget its key and this PC delete its own.
  relay             show the relay host of this PC; relay <host> sets it (a name such as walkie-relay.fly.dev); relay --forget clears it.
                    With a pairing key it tells the S3 first (over the cable, or over the relay it is on now) and changes this PC only once the
                    S3 has it; --pc-only changes this PC alone.
                    The relay is used only with a pairing key, which names the room, and never with --port.
  wifi              the S3's Wi-Fi networks, kept on the S3 (at most 4, tried in the order they were added). add asks for the password
                    at the prompt, typing hidden, never on the command line; list shows the names and the relay, never a password.
                    Needs a pairing key, and the S3 on the cable or on the relay. Stop walkie first: it holds the cable and the relay.
  --inject wav      once the S3 is up, feed this 16 kHz recording to it as its microphone, as if the front key were held while
                    it was said, wait for the whole turn (speech, Claude, the reply spoken) and stop. Calls the speech APIs
                    and runs the real claude. Exit code 0 when Claude replied or the words were a command for walkie.`;

let parsed;
try {
  parsed = parseWalkieCommand(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`walkie: ${err.message}`);
  console.log(USAGE);
  process.exit(2); // before any key is loaded or any port opened
}
const { opts } = parsed;

if (parsed.command === 'pair') {
  const code = await pairCommand({ forget: parsed.forget, openPort: portOpener(opts.port) });
  await new Promise((resolve) => setTimeout(resolve, 300)); // lets the port finish closing
  process.exit(code);
}

// The way to the S3 for the commands that talk to it once: the cable, else the relay, as `walkie` itself goes.
function s3Port(master, relayHost = () => loadRelayHost()) {
  return bridgeOpenPort({ port: opts.port ?? null, master, relayHost, log: (line) => console.log(`[transport] ${line}`) });
}

if (parsed.command === 'relay') {
  const code = await relayChange({
    host: parsed.host,
    forget: parsed.forget,
    pcOnly: parsed.pcOnly,
    loadKey: loadPairKey,
    push: ({ host, forget, master, via }) => relayPushCommand({ host, forget, master, openPort: s3Port(master, () => via) }),
  });
  await new Promise((resolve) => setTimeout(resolve, 300)); // lets the output flush, and the port finish closing
  process.exit(code);
}

if (parsed.command === 'wifi') {
  let code;
  try {
    const master = loadPairKey();
    code = await wifiCommand({ action: parsed.action, ssid: parsed.ssid, master, openPort: master ? s3Port(master) : null, readSecret });
  } catch (err) {
    console.error(err.message);
    code = 1;
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(code);
}

let injected = null;
if (opts.inject) {
  try {
    injected = readRecording(opts.inject);
  } catch (err) {
    console.error(err.message);
    process.exit(1); // before anything is started
  }
}

let bridge;
try {
  const con = createConsole();
  const config = loadConfig();
  const keys = loadKeys();
  const master = loadPairKey();
  con.log(master ? '[pair] a pairing key is present: the link to the S3 is sealed' : '[pair] no pairing key: the link to the S3 is plain (node bridge/bin/walkie.js pair)');
  con.log(`[keys] ${describeKeys(keys)}`);
  const why = whyKeysMissing(keys);
  if (why) con.log(`[keys] ${why}`);
  const relayHost = () => loadRelayHost();
  con.log(`[transport] ${describeTransport({ master, host: relayHost(), port: opts.port ?? null })}`);
  const projects = loadProjects();
  const settings = { ...config, claude: { ...config.claude, ...(opts.command ? { command: commandFrom(opts.command) } : {}) } };
  bridge = await startBridge({
    config: settings,
    projects,
    adapters: createAdapters({ keys, config }),
    openPort: bridgeOpenPort({ port: opts.port ?? null, master, relayHost, log: (line) => con.log(`[transport] ${line}`) }),
    retry: { retryMs: 1000, retryMaxMs: 30_000 },
    master,
    adpcm: opts.codec === 'adpcm',
    console: con,
    env: parsed.cleanEnv ? cleanEnv(process.env) : process.env,
  });
  con.log(`[walkie] ${projects.length} project${projects.length === 1 ? '' : 's'}, active ${bridge.manager.project()}; waiting for the S3. Ctrl+C to stop.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (injected) {
  bridge.console.log(`[inject] feeding ${opts.inject} to the S3 as its microphone`);
  runInjected(bridge, injected).then(
    (run) => {
      bridge.console.log(`[inject] ${run.outcome}`);
      process.exitCode = run.outcome === 'reply' || run.outcome === 'handled' ? 0 : 1;
      stop('inject finished');
    },
    (err) => {
      console.error(err.message);
      process.exitCode = 1;
      stop('inject failed');
    },
  );
}

let stopping = false;
function stop(signal) {
  if (stopping) process.exit(130); // a second Ctrl+C does not wait
  stopping = true;
  bridge.console.log(`[walkie] ${signal}: closing`);
  bridge
    .close()
    .catch((err) => console.error(err.message))
    .finally(() => setTimeout(() => process.exit(), 1000).unref()); // process.exit() right after a fetch can trip a libuv assertion on Node 24 for Windows; this ends when the loop empties
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
