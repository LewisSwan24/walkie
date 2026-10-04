// What Claude is told about speaking, and how its reply becomes the one or two sentences the S3 says (spec 6.4).

// Appended to Claude's system prompt. Tried live on 1 Oct 2026 (claude 2.1.285, Opus 5.5): a Chinese question got a Chinese
// <voice> line, an English one an English line, and the line closed every final reply.
export const VOICE_RULES =
  'Your replies reach the user through a small voice remote on their wrist: a tiny screen and a speaker. ' +
  'End every final reply with one line of the form <voice>one or two short sentences</voice>. ' +
  'Say in plain spoken words what you did or what you need from them, in the language the user is speaking. ' +
  'Inside the tag use no code, no markdown, no file paths, no URLs and no tool names. ' +
  'Everything before the tag is shown on the computer and may be as long as it needs to be.';

export const MAX_VOICE_CHARS = 160; // a tagged line longer than this is cut at a sentence end: it is one or two short sentences
export const FALLBACK_CHARS = 60; // spec 6.4: with no tag, the reply's first sentence, at most this many characters

const SENTENCE_END = /[。！？!?；;]|\.(?=\s|$)/;

// One line of markdown as text a person would say: no markers, no links, no URLs.
function plainLine(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*([-*_]\s*){3,}$/, '')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?![*\w])/g, '$1$2')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Markdown to plain text, a line at a time. Fenced code is dropped whole: nobody wants it read out.
export function stripMarkdown(text) {
  const lines = [];
  let fenced = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(plainLine(line));
  }
  return lines.filter(Boolean).join(' ');
}

// `text` cut to at most `max` characters, at a sentence end when there is one in the back half, and on the spot otherwise.
function limit(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  for (let i = head.length - 1; i >= max / 2; i--) {
    if (SENTENCE_END.test(head[i]) && (head[i] !== '.' || i + 1 >= head.length || /\s/.test(head[i + 1]))) {
      end = i;
      break;
    }
  }
  return (end >= 0 ? head.slice(0, end + 1) : head).trim();
}

// The first sentence of a reply that has no tag: the first line with words in it, up to its first sentence end.
function firstSentence(reply) {
  let fenced = false;
  for (const line of reply.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const plain = fenced ? '' : plainLine(line);
    if (!/[\p{L}\p{N}]/u.test(plain)) continue;
    const m = SENTENCE_END.exec(plain);
    return m ? plain.slice(0, m.index + 1).trim() : plain;
  }
  return '';
}

// {voice, screen, tagged}. `voice` is what to say aloud: the last <voice> block of the reply, with any markdown inside it
// removed, or, with no usable block, the first sentence of the reply. `screen` is the reply without the block.
export function extractVoice(reply) {
  const text = typeof reply === 'string' ? reply : '';
  let voice = '';
  let screen = text.trim();
  let last = null;
  for (const m of text.matchAll(/<voice>([\s\S]*?)<\/voice>/gi)) last = m;
  if (last) {
    voice = stripMarkdown(last[1]);
    screen = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim();
  } else {
    const open = text.search(/<voice>(?![\s\S]*<\/voice>)/i); // a reply cut off inside the tag
    if (open >= 0) {
      voice = stripMarkdown(text.slice(open + '<voice>'.length));
      screen = text.slice(0, open).trim();
    }
  }
  if (voice) return { voice: limit(voice, MAX_VOICE_CHARS), screen, tagged: true };
  return { voice: limit(firstSentence(screen), FALLBACK_CHARS), screen, tagged: false };
}
