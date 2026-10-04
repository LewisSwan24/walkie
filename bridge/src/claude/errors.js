// What went wrong with a claude run, as a kind the manager acts on and a plain sentence for the ERROR screen (spec 8:
// the screen says what to do on the PC). Written from the failures recorded on 1 Oct 2026 (claude 2.1.285):
//   login   assistant.error 'authentication_failed', result.api_error_status 401
//   model   assistant.error 'model_not_found', status 404, text "There's an issue with the selected model (X)..."
//   resume  result.subtype 'error_during_execution', errors ['No conversation found with session ID: ...']
// Rate limit, overload and a missing program were not recorded: they are matched by the same fields (`error` code, status)
// and by the words claude uses for them, and anything else shows claude's own words.

const MAX_TEXT = 50;

export const MESSAGES = {
  login: 'Claude 登录过期，回电脑上登录',
  model: 'Claude 不认这个模型，回电脑运行 claude update',
  'no-session': '找不到上次的对话，已经开了新的',
  rate: 'Claude 额度用完了，等一会儿再试',
  overloaded: 'Claude 现在太忙，等一会儿再试',
  missing: '找不到 claude 程序，回电脑检查安装',
};

const SPAWN_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM']);

const lines = (words) => words.split('\n').map((l) => l.trim()).filter(Boolean);

// The first line of what claude said, short enough for the screen.
function gist(words) {
  const chars = Array.from(lines(words)[0] ?? '');
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
}

// `code`: the `error` field of the assistant message claude printed for the failure, or the code of a spawn error;
// `status`: the result's api_error_status; `text`: the result's text (or the assistant message's); `errors`: the result's
// errors list; `stderr`: the tail of what the process wrote to stderr; `exitCode`: how it ended. Whatever their types:
// they come from a process and from the network.
// Returns {kind, message}; kind is one of login, model, no-session, rate, overloaded, missing, other.
export function classifyFailure(failure) {
  const f = failure !== null && typeof failure === 'object' ? failure : {};
  const { code, status, exitCode } = f;
  const text = typeof f.text === 'string' ? f.text : '';
  const stderr = typeof f.stderr === 'string' ? f.stderr : '';
  const errors = Array.isArray(f.errors) ? f.errors.filter((e) => typeof e === 'string') : [];
  const said = [text, ...errors, stderr].join('\n');
  let kind = 'other';
  if (code === 'authentication_failed' || status === 401 || /authenticat|\/login|not logged in|oauth/i.test(said)) kind = 'login';
  else if (code === 'model_not_found' || /does not support this model|issue with the selected model|unrecognized_model|model_not_found/i.test(said)) kind = 'model';
  else if (/no conversation found/i.test(said)) kind = 'no-session';
  else if (code === 'rate_limit' || status === 429 || /rate.?limit|usage limit|limit reached|hit your limit|too many requests/i.test(said)) kind = 'rate';
  else if (code === 'overloaded' || status === 503 || status === 529 || /overloaded/i.test(said)) kind = 'overloaded';
  else if (SPAWN_ERRORS.has(code)) kind = 'missing';
  if (kind !== 'other') return { kind, message: MESSAGES[kind] };
  const words = [text, ...errors, lines(stderr).pop() ?? ''].map(gist).find(Boolean);
  if (words) return { kind, message: `Claude 出错了：${words}` };
  return { kind, message: exitCode == null || exitCode === 0 ? 'Claude 出错了' : `Claude 出错了（退出码 ${exitCode}）` };
}
