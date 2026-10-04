// The words the models are given. The classification prompt is the one tested in Stage 0 (10 of 10, spec section 3),
// with the project table, the current project and Claude's state filled in.
import { projectTable, projectWords } from '../config/projects.js';

const TERMS = ['Claude', 'npm', 'git', 'commit', 'PlatformIO', 'on-the-beat'];

const state = ({ currentProject, busy }) => `Current project: ${currentProject ?? 'none'}. Claude is ${busy ? 'working' : 'idle'}.`;

// A hint for the transcription model: project names and the technical words he mixes into Mandarin.
export function transcriptionPrompt(projects) {
  const words = [...new Set([...projectWords(projects), ...TERMS])];
  return `程序员对着 Claude Code 说的普通话，夹杂英文技术词。常见词：${words.join('、')}。`;
}

export function classifyPrompt({ projects, currentProject = null, busy = false }) {
  return `You classify one utterance spoken to a wrist voice remote for Claude Code.
intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.
Use a command intent only when the WHOLE utterance is that command; any request for work on code, files or services is to_claude,
even if it contains words like 停止, 切换, 继续 or 压缩.
Projects (name: aliases): ${projectTable(projects)}.
${state({ currentProject, busy })}
project: the canonical project name for switch_project, otherwise null. text: for to_claude the utterance without filler words, otherwise "".`;
}

// What Gemini is told when it hears the audio itself: the transcription, and with `classify` the classification too.
export function hearPrompt({ projects, currentProject = null, busy = false, classify = true }) {
  const transcribe = `You are the ear of a wrist voice remote for Claude Code.
1. Transcribe the audio verbatim in Simplified Chinese; keep English words (${TERMS.join(', ')}) in English. Common project names: ${projectWords(projects).join(', ')}.`;
  if (!classify) return `${transcribe}\nAnswer with the transcript only.`;
  return `${transcribe}
2. Classify the WHOLE utterance. intent is one of: to_claude, stop, continue, compact, new_session, switch_project, status.
   Only use a command intent when the whole utterance is that command. Anything that asks for work on code is to_claude.
   Projects (name: aliases): ${projectTable(projects)}.
   ${state({ currentProject, busy })}
   Examples: 停一下 -> stop; 先别弄了 -> stop; 把停止按钮改成红色 -> to_claude; 切到手环那个项目 -> switch_project, project on-the-beat;
   现在在干嘛 -> status; 压缩一下上下文 -> compact; 开个新对话 -> new_session; 继续 -> continue.
3. project: the canonical project name for switch_project, otherwise null. text: for to_claude, the transcript cleaned of filler words, otherwise empty.`;
}
