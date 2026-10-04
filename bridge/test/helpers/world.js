// The whole bridge, with only the two ends stood in for: the S3 (FakeS3, on the real Link) and the speech providers. Claude is
// the fake-claude process, which speaks the real stream-json and calls the real permission server over HTTP.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../../src/main.js';
import { createConsole } from '../../src/console.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { createStateStore } from '../../src/config/state.js';
import { tone } from '../../src/audio/tone.js';
import { FakeS3, until } from './fake-s3.js';
import { relayedS3 } from './relay-s3.js';

export const FAKE_CLAUDE = join(import.meta.dirname, '..', 'claude', 'fake-claude.js');
export const speechPcm = Buffer.alloc(16000 * 2 * 1.2, 1); // 1.2 s of 16 kHz PCM16: more than the 250 ms that are trimmed and the 300 ms that are needed

// The providers: the transcripts come from `said` one call at a time, every utterance is a request for Claude (or the `intent`
// given), and every reply is a short tone, with the text it was asked to say written down in `spoken`.
export function providers(said, spoken, { intent = 'to_claude' } = {}) {
  return [
    {
      name: 'openai',
      limits: { transcribeBaseMs: 3000, classifyMs: 3500, speakFirstByteMs: 3000, speakIdleMs: 3000, hearMs: 8000 },
      transcribe: async () => said.shift() ?? '',
      classify: async (text) => JSON.stringify({ intent, project: null, text }),
      speak: async function* (text) {
        spoken.push(text);
        yield tone(330, 0.3, 4000);
      },
    },
  ];
}

// `command` stands in for claude (default: the fake). `turn` overrides the turn's timings.
// `s3` is the stand-in S3's options, `link` those of startBridge that belong to the link (master, adpcm). `relay`: the S3 is behind a real
// relay instead of on a cable (true, or the options of relayedS3); the bridge then opens the relay port, and `relayed` is its handle.
export async function world(t, { said = [], adapters = null, openPort = null, turn = {}, approvalTimeoutSec = 10, command = [process.execPath, FAKE_CLAUDE], intent, s3: s3Options = {}, link: linkOptions = {}, relay = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'walkie-main-'));
  const project = join(dir, 'proj');
  mkdirSync(project);
  const s3 = new FakeS3(s3Options);
  const relayed = relay ? await relayedS3(t, s3, { master: linkOptions.master ?? null, ...(relay === true ? {} : relay) }) : null;
  const lines = [];
  const spoken = [];
  const store = createStateStore({ file: null });
  const bridge = await startBridge({
    config: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, command, prewarm: false, approvalTimeoutSec } },
    projects: [{ name: 'proj', aliases: [], path: project }],
    adapters: adapters ?? providers(said, spoken, { intent }),
    openPort: openPort ?? relayed?.openPort ?? (async () => s3),
    store,
    env: { ...process.env, FAKE_CLAUDE: JSON.stringify({ stateDir: join(dir, 'sessions') }) },
    console: createConsole({ out: (line) => lines.push(line) }),
    turn: { confirmMs: 30, unclearMs: 5000, ...turn },
    ...linkOptions,
  });
  t.after(async () => {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await until(() => bridge.link.ready, 'the S3 to answer HELLO');
  const shown = (state) => s3.screens().find((s) => s.state === state);
  const order = () => s3.screens().flatMap((s) => (s.state === undefined ? [] : [s.state])).filter((s, i, all) => s !== all[i - 1]);
  return { bridge, s3, store, lines, spoken, shown, order, relayed };
}
