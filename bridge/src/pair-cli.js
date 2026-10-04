// `walkie pair`: runPair with the console around it, and an exit code. 0 when the walkie was paired (and proved it) or forgotten.
import { runPair } from './pair.js';

export async function pairCommand({ forget, openPort, run = runPair, say = console.log, err = console.error }) {
  try {
    const { outcome } = await run({ openPort, forget, say });
    return outcome === 'paired' || outcome === 'forgotten' ? 0 : 1;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
