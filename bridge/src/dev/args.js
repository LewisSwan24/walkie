// The command line of walkie-dev.js: <command> [arguments] [--flag value]... A flag that is misspelled, has no value or is
// given twice is an error, never a silent default: a `--provider=openai` that quietly meant "auto" could send a
// recording to a provider nobody agreed to.
export class UsageError extends Error {}

const VALUE_FLAGS = ['--port', '--secs', '--out', '--provider', '--cwd', '--project', '--command', '--elapsed', '--snap', '--inject', '--codec'];
const SWITCHES = ['--all', '--clean-env', '--forget', '--pc-only']; // stay among the arguments, for the command that reads them
const FLAG_LIKE = /^--[A-Za-z][\w-]*(=|$)/; // anything else that starts with -- is text

export function parseArgs(argv) {
  const rest = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!FLAG_LIKE.test(arg) || SWITCHES.includes(arg)) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq < 0 ? arg : arg.slice(0, eq); // what follows an equals sign is never repeated: it may be a key
    if (!VALUE_FLAGS.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    const name = flag.slice(2);
    if (name in opts) throw new UsageError(`${flag} was given twice`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (!value || FLAG_LIKE.test(value)) throw new UsageError(`${flag} needs a value`);
    if (name === 'codec' && value !== 'pcm' && value !== 'adpcm') throw new UsageError('--codec is pcm or adpcm');
    opts[name] = value;
  }
  const [name, ...args] = rest;
  return { name, args, opts };
}
