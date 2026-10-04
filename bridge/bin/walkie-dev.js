#!/usr/bin/env node
// Developer commands for the S3 link.
import { loadPairKey } from '../src/config/pairkey.js';
import { parseArgs, UsageError } from '../src/dev/args.js';

const USAGE = `usage: node bridge/bin/walkie-dev.js <command> [args] [--port COMx]
  ping [n]                 say HELLO, then show n PONGs (default 5)
  cmd vol <0-255> | gain <1-64> | stop | boot-app0 | reboot
  term [text] [--secs n]   plain-text console without resetting the S3 (for on-the-beat)
  listen [--out dir]       save each talk-key take as a WAV and print its levels
  loopback [up|down|stop|all] [secs]   check that the link loses nothing (down plays secs of tone, default 10)
  play <file> | play tone <hz> <secs>  play audio on the S3; Ctrl+C stops it
  hear <wav> [--provider auto|openai|gemini]        run a recorded take through the speech chain (calls the APIs)
  say <text...> [--out file.wav] [--provider ...]    speak through the chain: play on the S3, or save a WAV (calls the APIs)
  classify <text...> | classify --all [--provider ...]  the intent of a transcript; --all scores the 20 samples (calls the APIs)
  claude [--cwd dir | --project name] [--command json] [--clean-env]   the session manager from a terminal: it reads
                           commands on stdin (say, continue, compact, new, stop, status, switch, yes, no, wait, sleep, quit)
                           and runs the real claude (Claude's quota) unless --command names a stand-in
  press <script> [--snap file.png]   press the S3's keys from the firmware: front:600 side:1100 both:3200 wait:300 down:front up:front
  ui <idle|transcribing|confirm|working|reply|error> [text...] [--project name] [--elapsed secs] [--secs n | --snap file.png]
  ui approval <tool> <preview...> [--secs n | --snap file.png]   show a screen, or a request for a yes or no, as the bridge would
  snap [--out file.png]    save what the S3's screen shows as a PNG (default: bridge/snaps/)
  inject <wav> [--out dir]   feed a 16 kHz recording to the S3 as its microphone and print the take that comes back
  selftest                 the S3 checks its own HKDF, AES-GCM and sealed-session code against published vectors (exit 1 if not)`;

const commands = {
  ping: () => import('../src/dev/ping.js'),
  cmd: () => import('../src/dev/cmd.js'),
  term: () => import('../src/dev/term.js'),
  listen: () => import('../src/dev/listen.js'),
  loopback: () => import('../src/dev/loopback.js'),
  play: () => import('../src/dev/play.js'),
  hear: () => import('../src/dev/hear.js'),
  say: () => import('../src/dev/say.js'),
  classify: () => import('../src/dev/classify.js'),
  claude: () => import('../src/dev/claude.js'),
  press: () => import('../src/dev/press.js'),
  ui: () => import('../src/dev/ui.js'),
  snap: () => import('../src/dev/snap.js'),
  inject: () => import('../src/dev/inject.js'),
  selftest: () => import('../src/dev/selftest.js'),
};

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof UsageError)) throw err;
  console.error(`walkie-dev: ${err.message}`);
  console.log(USAGE);
  process.exit(2); // before any key is loaded or any port opened
}
const { name, args, opts } = parsed;
if (!commands[name]) {
  console.log(USAGE);
  process.exit(name ? 2 : 0);
}
const { default: run } = await commands[name]();
try {
  opts.master = loadPairKey(); // a paired S3 is talked to in sealed frames only
  await run(args, opts);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
// hear, say and classify call the providers, and claude has just closed a server and killed a process. On Node 24 for
// Windows, process.exit() right after a fetch can trip a libuv assertion (exit code 127, after the right output), so these
// end when the loop empties; the timer only cuts off one that left something open. The serial commands close their port
// themselves and exit at once, as before.
const ENDS_WHEN_THE_LOOP_EMPTIES = new Set(['hear', 'say', 'classify', 'claude']);
if (ENDS_WHEN_THE_LOOP_EMPTIES.has(name)) setTimeout(() => process.exit(), 1000).unref();
else process.exit();
