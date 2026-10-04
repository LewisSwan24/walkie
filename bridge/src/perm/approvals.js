// The queue of tool calls waiting for his yes or no (spec 6.4). One is shown on the device at a time, in the order they came;
// each is denied on its own if nobody answers in time. The permission server asks, the device's keys answer, and the
// device layer listens to 'show' and 'clear' to know what to put on the APPROVAL screen.
//
//   'show'  {id, tool, preview, toolUseId}   this request is now the one on the screen
//   'clear' {id, outcome}                    it is finished: 'allowed', 'denied', 'timeout' or 'aborted'
//
// The verdicts are the permission tool's: {behavior: 'allow'} or {behavior: 'deny', message}. The message of a denial is
// what Claude reads, so it says who said no and that the call should not be tried again.
import { EventEmitter } from 'node:events';
import { previewOf } from './preview.js';

export const DENY_TIMEOUT = '手腕上没人回应，先别做。';
export const DENY_DEFAULT = '用户在手腕上拒绝了这个操作，不要重试。';
export const DENY_ABORTED = '这个请求已经取消了。';
export const DENY_SHUTDOWN = 'walkie 关闭了，先别做。';
export const denyWithReason = (reason) => `用户在手腕上拒绝了这个操作，理由：${reason}`;

const MAX_ID = 65535; // the id travels to the device in 16 bits

const deny = (message) => ({ behavior: 'deny', message });

// `timeoutMs`: how long a request waits for an answer, counted from its arrival. Claude's own client gives up on a pending
// tool call at about 60 s and then tries the call again, so this must stay below that (config claude.approvalTimeoutSec).
export function createApprovals({ timeoutMs = 55_000 } = {}) {
  const events = new EventEmitter();
  const queue = []; // the head is the one on the screen
  let nextId = 1;

  const view = (req) => ({ id: req.id, tool: req.tool, preview: req.preview, toolUseId: req.toolUseId });

  function newId() {
    for (let tries = 0; tries < MAX_ID; tries++) {
      const id = nextId;
      nextId = nextId === MAX_ID ? 1 : nextId + 1;
      if (!queue.some((r) => r.id === id)) return id;
    }
    throw new Error('too many approvals are waiting');
  }

  function finish(req, verdict, outcome) {
    const at = queue.indexOf(req);
    if (at < 0) return;
    queue.splice(at, 1);
    clearTimeout(req.timer);
    req.signal?.removeEventListener('abort', req.onAbort);
    req.resolve(verdict);
    events.emit('clear', { id: req.id, outcome });
    if (at === 0 && queue.length > 0) events.emit('show', view(queue[0]));
  }

  // A promise of the verdict; it never rejects. `signal` aborts when the client that asked has gone away.
  function request({ tool, input, toolUseId, signal } = {}) {
    if (signal?.aborted) return Promise.resolve(deny(DENY_ABORTED));
    return new Promise((resolve) => {
      const req = { id: newId(), tool: String(tool ?? ''), preview: previewOf(tool, input), toolUseId: typeof toolUseId === 'string' ? toolUseId : '', resolve, signal };
      req.timer = setTimeout(() => finish(req, deny(DENY_TIMEOUT), 'timeout'), timeoutMs);
      req.onAbort = () => finish(req, deny(DENY_ABORTED), 'aborted');
      signal?.addEventListener('abort', req.onAbort, { once: true });
      queue.push(req);
      if (queue.length === 1) events.emit('show', view(req));
    });
  }

  // The answer from the device: `allow`, or a denial with the reason he spoke, if he did. Only the request on the screen can
  // be answered; false means this answer is for one that is already over.
  function answer(id, { allow = false, reason = '' } = {}) {
    const req = queue[0];
    if (!req || req.id !== id) return false;
    const verdict = allow ? { behavior: 'allow' } : deny(typeof reason === 'string' && reason.trim() ? denyWithReason(reason.trim()) : DENY_DEFAULT);
    finish(req, verdict, allow ? 'allowed' : 'denied');
    return true;
  }

  // Everything that is waiting is denied with `message`, the one on the screen last, so that no request ever shows in between.
  function denyAll(message = DENY_SHUTDOWN) {
    for (const req of [...queue].reverse()) finish(req, deny(message), 'denied');
  }

  return {
    request,
    answer,
    denyAll,
    current: () => (queue.length > 0 ? view(queue[0]) : null),
    pending: () => queue.length,
    on: (name, listener) => events.on(name, listener),
  };
}
