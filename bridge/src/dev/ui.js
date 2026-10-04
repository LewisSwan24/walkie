// ui <screen> [text...] [--project name] [--elapsed secs]     put a screen on the S3 as the bridge would
// ui approval <tool> <preview...>                              ask for a yes or no, as the permission server would
//   screens: idle, transcribing, confirm, working, reply, error
// The S3 shows it for as long as this stays connected (a screen is only kept up by a bridge that is pinging): until Ctrl+C,
// or --secs n, or --snap file.png, which waits for the screen to be drawn, saves a picture of it and ends. Meanwhile the
// keys' answers are printed: BUTTON events and the verdict of the approval.
import { TYPE } from '../link/frame.js';
import { BUTTON, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, uiPayload } from '../link/messages.js';
import { connect } from './connect.js';
import { snapTo } from './snap.js';

export class UiArgsError extends Error {}

const SCREENS = Object.keys(UI_STATE).map((name) => name.toLowerCase());
const BUTTON_NAMES = Object.fromEntries(Object.entries(BUTTON).map(([name, code]) => [code, name]));
const DRAW_MS = 700; // for the S3 to draw what it was sent before its display is read back
const MAX_ELAPSED_MS = 0xffffffff;
const SECONDS = /^\d+(\.\d+)?$/;

function seconds(text, flag, what) {
  if (!SECONDS.test(text ?? '')) throw new UiArgsError(`${flag} needs a number of seconds${what}`);
  return Number(text);
}

// -> {kind: 'ui', view: {state, project?, text?, elapsedMs?}, waitMs?} or {kind: 'approval', approval: {id, tool, preview}, waitMs?}
export function parseUiArgs(args, opts) {
  if (args.length === 0) throw new UiArgsError(`ui needs a screen: ${SCREENS.join(', ')} or approval`);
  const [first, ...rest] = args;
  const name = first.toLowerCase();
  let result;
  if (name === 'approval') {
    if (rest.length < 2) throw new UiArgsError('ui approval <tool> <preview...>: a tool name, then what it would do');
    result = { kind: 'approval', approval: { id: 1, tool: rest[0], preview: rest.slice(1).join(' ') } };
  } else {
    if (!SCREENS.includes(name)) throw new UiArgsError(`unknown screen "${first}": ${SCREENS.join(', ')} or approval`);
    const view = { state: UI_STATE[name.toUpperCase()] };
    if (opts.project) view.project = opts.project;
    if (rest.length > 0) view.text = rest.join(' ');
    if (opts.elapsed !== undefined) {
      const ms = Math.round(seconds(opts.elapsed, '--elapsed', ', like 12.5') * 1000);
      if (ms > MAX_ELAPSED_MS) throw new UiArgsError(`--elapsed is too long: at most ${Math.floor(MAX_ELAPSED_MS / 1000)} seconds`);
      view.elapsedMs = ms;
    }
    result = { kind: 'ui', view };
  }
  if (opts.secs !== undefined) {
    const secs = seconds(opts.secs, '--secs', ', more than 0');
    if (secs <= 0) throw new UiArgsError('--secs needs a number of seconds, more than 0');
    result.waitMs = Math.round(secs * 1000);
  }
  return result;
}

// connectFn and sleep are for tests.
export default async function ui(args, opts, connectFn = connect, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const what = parseUiArgs(args, opts);
  const link = await connectFn(opts);
  try {
    link.on('frame', (f) => {
      if (f.type === TYPE.BUTTON) {
        const b = parseButton(f.payload);
        if (b) console.log(`button: ${BUTTON_NAMES[b.event] ?? b.event}`);
      } else if (f.type === TYPE.APPROVAL_RES) {
        const r = parseApprovalRes(f.payload);
        if (r) console.log(`approval #${r.id}: ${r.allow ? 'allowed' : 'denied'}${r.reasonFollows ? ', a reason follows' : ''}`);
      }
    });
    if (what.kind === 'approval') {
      link.send(TYPE.APPROVAL_REQ, approvalReqPayload(what.approval));
      console.log(`sent: approval #${what.approval.id} ${what.approval.tool}`);
    } else {
      link.send(TYPE.UI, uiPayload(what.view));
      console.log(`sent: ${SCREENS[what.view.state]}${what.view.text ? ` "${what.view.text}"` : ''}`);
    }
    if (opts.snap) {
      await sleep(DRAW_MS);
      await snapTo(link, opts.snap);
    } else if (what.waitMs !== undefined) {
      await sleep(what.waitMs);
    } else {
      console.log('Keys are printed as they are pressed. Ctrl+C to stop.');
      await new Promise(() => {});
    }
  } finally {
    link.close();
  }
}
