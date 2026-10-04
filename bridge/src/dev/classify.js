// The intent of a transcript, from the model:
//   classify <text...> [--provider auto|openai|gemini]
//   classify --all                      the 20 sample utterances, scored (Stage 0 got the first ten 10 of 10)
import { UTTERANCES } from '../../test/fixtures/utterances.js';
import { abortOnSigint, speechFromFiles } from './speech-setup.js';

// Right when the intent is, and the project too when one is expected.
export const isCorrect = (expected, got) => got.intent === expected.intent && (expected.project === undefined || got.project === expected.project);

const named = (x) => `${x.intent}${x.project ? ` ${x.project}` : ''}`;

export function formatVerdict(expected, got) {
  const ok = isCorrect(expected, got);
  return `${ok ? 'ok ' : 'BAD'}  ${expected.say}  ->  ${named(got)} (${got.classifiedBy})${ok ? '' : `, expected ${named(expected)}`}`;
}

export default async function classify(args, opts) {
  const all = args.includes('--all');
  const text = args.filter((a) => a !== '--all').join(' ').trim();
  if (!all && !text) throw new Error('classify <text...> | classify --all  [--provider auto|openai|gemini]');
  const { speech, only } = speechFromFiles(opts);
  const signal = abortOnSigint();
  if (!all) {
    const got = await speech.classify(text, { only, signal });
    console.log(`intent: ${named(got)} (${got.classifiedBy})`);
    if (got.intent === 'to_claude') console.log(`to Claude: 「${got.text}」`);
    return;
  }
  let right = 0;
  for (const u of UTTERANCES) {
    const got = await speech.classify(u.say, { only, signal });
    if (isCorrect(u, got)) right++;
    console.log(formatVerdict(u, got));
  }
  console.log(`correct ${right}/${UTTERANCES.length}`);
  if (right < UTTERANCES.length) process.exitCode = 1;
}
