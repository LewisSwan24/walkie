// What he might say, and what each thing means. `fixed: true` marks the whole-utterance commands the fixed-phrase
// table must catch on its own; everything else it must leave alone (a model decides, or it goes to Claude as text).
// The first ten are the Stage 0 classification set (spec section 3): gpt-6-luna at reasoning_effort "none" got 10 of 10.
export const UTTERANCES = [
  { say: '等一下，先停住。', intent: 'stop', fixed: true },
  { say: '换到 on the beat 那个项目。', intent: 'switch_project', project: 'on-the-beat', fixed: true },
  { say: '把登录页的停止按钮改成红色。', intent: 'to_claude' },
  { say: '你现在做到哪一步了？', intent: 'status', fixed: true },
  { say: '帮我跑一下 npm test，然后 commit。', intent: 'to_claude' },
  { say: '继续吧', intent: 'continue', fixed: true },
  { say: '把上下文压一压', intent: 'compact', fixed: true },
  { say: '重新开个会话', intent: 'new_session', fixed: true },
  { say: '停止服务之前先备份数据库', intent: 'to_claude' },
  { say: '切到语音助手这个项目', intent: 'switch_project', project: 'walkie', fixed: true },
  // ten more, written for this plan: short commands, a few traps that contain a command word, and plain work
  { say: '停', intent: 'stop', fixed: true },
  { say: '先别弄了', intent: 'stop', fixed: true },
  { say: '继续', intent: 'continue', fixed: true },
  { say: '压缩一下上下文', intent: 'compact', fixed: true },
  { say: '开个新会话', intent: 'new_session', fixed: true },
  { say: '现在在干嘛', intent: 'status', fixed: true },
  { say: '切到手环项目', intent: 'switch_project', project: 'on-the-beat', fixed: true },
  { say: '继续写那个登录页', intent: 'to_claude' },
  { say: '压缩一下这张图片', intent: 'to_claude' },
  { say: '新建一个会话列表组件', intent: 'to_claude' },
];

// The projects the classification set talks about, in the shape projects.json has.
export const SET_PROJECTS = [
  { name: 'on-the-beat', aliases: ['手环项目', 'on the beat'], path: 'C:/p/on-the-beat' },
  { name: 'verbatim', aliases: [], path: 'C:/p/verbatim' },
  { name: 'fencepost', aliases: [], path: 'C:/p/fencepost' },
  { name: 'walkie', aliases: ['语音助手'], path: 'C:/p/walkie' },
];
