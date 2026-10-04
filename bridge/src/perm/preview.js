// What the APPROVAL screen shows of a tool call (spec 6.2, 6.4): a few lines of plain text the wrist can read, from the
// input of a tool the model chose. Nothing it prints may make the call look like something it is not.

export const MAX_PREVIEW = 300;

const MIN_MAX = 10;
const PATH_MAX = 120;
const BODY_MAX = 140;
const SIDE_MAX = 100;

// Control characters and the invisible format characters (zero-width, direction overrides: a command can be made to read
// backwards or to hide a word with them) become a visible dot; tabs become a space; line breaks stay.
function plain(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' ? c : '·'));
}

// Too long: the head and the tail with a gap between, never the head alone, because what makes a long command dangerous is
// often at its end. The result is `max` characters, counted as characters rather than UTF-16 units.
function cut(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const tail = Math.floor(max / 3);
  return `${chars.slice(0, max - tail - 3).join('')} … ${chars.slice(chars.length - tail).join('')}`;
}

const str = (v) => (typeof v === 'string' ? plain(v) : '');
const count = (v) => (typeof v === 'string' ? Array.from(v).length : 0);

// The preview of `input` for `tool`, at most `max` characters. `input` is whatever the model sent.
export function previewOf(tool, input, max = MAX_PREVIEW) {
  const limit = Math.max(MIN_MAX, Number.isFinite(max) ? Math.floor(max) : MAX_PREVIEW);
  const i = input !== null && typeof input === 'object' ? input : {};
  let main = ''; // what the call is about: without it the input itself is shown
  let text = '';
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      main = text = str(i.command);
      break;
    case 'Write':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `${count(i.content)} 字`, cut(str(i.content), BODY_MAX)].join('\n');
      break;
    case 'Edit':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `- ${cut(str(i.old_string), SIDE_MAX)}`, `+ ${cut(str(i.new_string), SIDE_MAX)}`].join('\n');
      break;
    case 'MultiEdit':
      main = cut(str(i.file_path), PATH_MAX);
      text = [main, `${Array.isArray(i.edits) ? i.edits.length : 0} 处修改`].join('\n');
      break;
    case 'NotebookEdit':
      main = text = cut(str(i.notebook_path), PATH_MAX);
      break;
    case 'WebFetch':
      main = text = str(i.url);
      break;
    case 'WebSearch':
      main = text = str(i.query);
      break;
    case 'Task':
    case 'Agent':
      main = text = str(i.description);
      break;
    default:
  }
  if (!main.replace(/[\s·]/g, '')) text = plain(JSON.stringify(i));
  return cut(text, limit);
}
