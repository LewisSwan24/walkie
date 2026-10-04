// The fixed-phrase table: the last resort when no model gave a valid intent (spec 6.5). A phrase counts only when it
// is the WHOLE utterance, so 「停止服务之前先备份数据库」 is work for Claude and never a stop. A miss is cheap: the
// utterance goes to Claude as text.
import { findProject, normalizeName } from '../config/projects.js';

const PHRASES = {
  stop: ['停', '停止', '停下', '停下来', '停一下', '停住', '先停', '先停一下', '先停住', '等一下', '等一下先停住', '别弄了', '先别弄了', '别做了', '先别做了', '别说了', '暂停', 'stop'],
  continue: ['继续', '继续做', '继续干', '继续执行', '接着来', '接着做', '接着干', '往下', 'continue', 'goon'],
  compact: ['压缩', '压缩一下', '压缩上下文', '压缩一下上下文', '压一压上下文', '把上下文压一压', '压缩会话', 'compact'],
  new_session: ['新会话', '新对话', '开个新会话', '开个新对话', '开新会话', '新开一个会话', '重新开个会话', '重新开一个会话', '换个新会话', '重新开始', 'newsession'],
  status: ['状态', '进度', '进展如何', '怎么样了', '现在什么情况', '你在干嘛', '现在在干嘛', '你在做什么', '你现在在做什么', '做到哪了', '做到哪里了', '做到哪一步了', '你现在做到哪一步了', 'status'],
};

const TABLE = new Map();
for (const [intent, list] of Object.entries(PHRASES)) for (const phrase of list) TABLE.set(normalizeName(phrase), intent);

const SWITCH = /^(?:切换到|切换成|切到|切成|切回|换到|换成|换回|回到|switchto)(.+)$/;

// Case, spaces and punctuation do not count, and a polite particle at the end does not either.
function canonical(transcript) {
  return String(transcript ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(?:吧|啊|呀|哦|啦|呢)+$/u, '');
}

export function fixedPhrase(transcript, projects) {
  const said = canonical(transcript);
  if (!said) return null;
  const intent = TABLE.get(said);
  if (intent) return { intent, project: null, text: '' };
  const m = SWITCH.exec(said);
  if (!m) return null;
  const target = m[1];
  const project = findProject(projects, target) ?? findProject(projects, target.replace(/(?:那个|这个)?(?:项目|工程)?$/u, ''));
  return project ? { intent: 'switch_project', project: project.name, text: '' } : null;
}

// A sound that is not a request: 「嗯。」, 「呃…」, "um". Breathing and a cough come back from the transcriber like this,
// and sending one to Claude would start a turn about nothing.
const FILLER = /^(?:[嗯呃额啊哦噢唔哼哈呀欸诶]+|u+m+|u+h+|h+m+|e+r+m*|a+h+|o+h+)$/u;

export function isFiller(transcript) {
  return FILLER.test(String(transcript ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
}

// True when there is anything to say: at least one letter or digit. 「。」 or "..." is a breath the transcriber wrote
// down as punctuation, and it is no more a request than 「嗯」 is.
export function hasWords(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''));
}

// The text with its filler sounds taken out, which is all a cleaned-up request may differ from the transcript by.
const SOUND = /[嗯呃额啊哦噢唔哼哈呀欸诶]|\b(?:u+m+|u+h+|h+m+|e+r+m*|a+h+|o+h+)\b/giu;

export function withoutSounds(text) {
  return String(text ?? '').replace(SOUND, ' ');
}
