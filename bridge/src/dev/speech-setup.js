// Shared by the speech dev commands: the keys, the settings and the provider chain, with the console as its log.
import { loadConfig } from '../config/config.js';
import { describeKeys, loadKeys, whyKeysMissing } from '../config/keys.js';
import { loadProjects } from '../config/projects.js';
import { createAdapters, createSpeech } from '../speech/speech.js';

export const PROVIDERS = ['auto', 'openai', 'gemini'];

// `--provider openai|gemini` tests one provider on purpose: it is used alone, whatever was skipped before.
export function speechFromFiles(opts) {
  const provider = opts.provider ?? 'auto';
  if (!PROVIDERS.includes(provider)) throw new Error(`--provider is one of ${PROVIDERS.join(', ')}`);
  const keys = loadKeys();
  console.log(`[keys] ${describeKeys(keys)}`);
  const why = whyKeysMissing(keys);
  if (why) console.log(`[keys] ${why}`);
  const config = loadConfig();
  const adapters = createAdapters({ keys, config });
  if (provider !== 'auto' && !adapters.some((a) => a.name === provider)) throw new Error(`--provider ${provider}: its API key is not set`);
  const speech = createSpeech({ adapters, config, projects: loadProjects(), log: (line) => console.log(line) });
  return { speech, only: provider === 'auto' ? null : provider, config };
}

export const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// Ctrl+C aborts what is running, the way the bridge will stop a reply.
export function abortOnSigint() {
  const ac = new AbortController();
  process.once('SIGINT', () => ac.abort());
  return ac.signal;
}
