// A provider call that did not work, described so the console can say which one and why, and so that nothing in the
// description can leak an API key.

// kind: timeout | http | network | bad-response | empty | unavailable
export class SpeechError extends Error {
  constructor(message, { provider = null, step = null, kind, status = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SpeechError';
    this.provider = provider;
    this.step = step;
    this.kind = kind;
    this.status = status;
  }
}

// The caller (not a provider) gave up: the front key stopped a reply, for example. Never a reason to skip a provider.
export function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
export const isAbort = (err) => err?.name === 'AbortError';

// Text that may come back from a server or an error, with anything key-shaped, and the keys themselves, removed.
export function redact(text, keys = []) {
  let out = String(text ?? '');
  for (const key of keys) if (key) out = out.split(key).join('[key]');
  return out.replace(/sk-[A-Za-z0-9_*.-]{6,}/g, '[key]').replace(/AIza[A-Za-z0-9_*.-]{10,}/g, '[key]');
}
