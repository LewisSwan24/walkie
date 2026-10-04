// Time limits for provider calls. They use setTimeout, so tests can drive them with mock timers.
import { abortError } from './errors.js';

export class DeadlineError extends Error {
  constructor(ms) {
    super(`no answer within ${ms} ms`);
    this.name = 'DeadlineError';
    this.ms = ms;
  }
}

// Runs fn(signal) and gives up after `ms`. `signal` is aborted on the deadline and when `parent` aborts, so a fetch
// that was given it stops too; fn is not trusted to honour it, so the result is a race. Rejects with a DeadlineError
// on the deadline and with an AbortError when the parent aborted.
export async function withDeadline(ms, parent, fn) {
  // A missing or misspelt limit must not turn into an instant or an endless wait.
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError(`a deadline needs a positive number of milliseconds, got ${ms}`);
  const ac = new AbortController();
  let timer;
  let onParent;
  const cut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new DeadlineError(ms));
    }, ms);
    onParent = () => {
      ac.abort();
      reject(abortError());
    };
    if (parent?.aborted) onParent();
    else parent?.addEventListener('abort', onParent, { once: true });
  });
  cut.catch(() => {}); // when fn wins, a later cut is not an unhandled rejection
  const work = Promise.resolve().then(() => fn(ac.signal));
  work.catch(() => {}); // the same, the other way round
  try {
    return await Promise.race([work, cut]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
  }
}
