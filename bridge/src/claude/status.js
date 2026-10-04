// What the bridge says about the session without asking Claude (spec 6.4, the `status` intent), and the short summary of
// a tool call that the WORKING screen shows beside the tool's name.

export const MAX_SUMMARY = 40;

function clip(text, max) {
  const chars = Array.from(String(text).replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

const str = (v) => (typeof v === 'string' && v.trim() ? v : '');
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? '';

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// What a tool is working on, in at most `max` characters: a file's name, a search pattern, the description a Bash command
// came with (it says more than the command does) or else the command's first line, the host of a URL. '' when nothing in
// the input is worth showing. `input` comes from a model: any shape at all is possible.
export function toolSummary(name, input, max = MAX_SUMMARY) {
  const i = input !== null && typeof input === 'object' ? input : {};
  let s;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      s = str(i.description) || str(i.command).split('\n').find((l) => l.trim()) || '';
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      s = baseName(str(i.file_path));
      break;
    case 'NotebookEdit':
      s = baseName(str(i.notebook_path));
      break;
    case 'Grep':
    case 'Glob':
      s = str(i.pattern);
      break;
    case 'WebFetch':
      s = hostOf(str(i.url));
      break;
    case 'WebSearch':
      s = str(i.query);
      break;
    default:
      s = str(i.description) || str(i.command) || baseName(str(i.file_path)) || str(i.pattern) || str(i.query) || str(i.prompt);
  }
  return clip(s, max);
}

// A length of time as it is read aloud: 45秒, 3分钟, 2分15秒, 1小时, 1小时5分钟.
export function spokenElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  if (m > 0) return s > 0 ? `${m}分${s}秒` : `${m}分钟`;
  return `${s}秒`;
}

// The sentence for the `status` intent, in the language he speaks to the device (like the other fixed phrases).
//   project    the active project's name
//   running    a claude process is alive
//   busy       a turn is under way
//   tool, summary   the last tool call of that turn, when busy
//   elapsedMs  busy: since the turn began; idle: how long the last turn took (null when there has not been one)
//   turns      busy: the number of this turn; idle: how many turns the project has had
//   resumable  there is a session id to resume
export function statusText({ project, running, busy, tool, summary, elapsedMs, turns, resumable }) {
  if (!running) return resumable ? `${project}没在运行，上次的对话还在，说话就接着做。` : `${project}没在运行，说话就开始新对话。`;
  if (busy) {
    const doing = tool ? `在用${tool}${summary ? `：${summary}` : ''}` : '还在想';
    return `${project}在忙，${doing}，已经${spokenElapsed(elapsedMs)}，这是第${turns}轮。`;
  }
  if (!turns) return `${project}已经待命，等你说话。`;
  return `${project}空闲，这个对话做了${turns}轮${elapsedMs == null ? '' : `，上一轮用了${spokenElapsed(elapsedMs)}`}。`;
}
