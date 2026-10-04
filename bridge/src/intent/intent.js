// What a spoken utterance asks for, and how far a model's answer about it is trusted (spec 6.5).
import { findProject } from '../config/projects.js';
import { hasWords, withoutSounds } from './phrases.js';

export const INTENTS = ['to_claude', 'stop', 'continue', 'compact', 'new_session', 'switch_project', 'status'];

// The strict JSON schema OpenAI is asked to answer with.
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'project', 'text'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    project: { type: ['string', 'null'] },
    text: { type: 'string' },
  },
};

// The schema Gemini answers with when it hears the audio itself: the transcript comes with the intent.
export function hearSchema(classify) {
  const properties = { transcript: { type: 'STRING' } };
  if (classify) {
    properties.intent = { type: 'STRING', enum: INTENTS };
    properties.project = { type: 'STRING', nullable: true };
    properties.text = { type: 'STRING' };
  }
  return { type: 'OBJECT', properties, required: classify ? ['transcript', 'intent'] : ['transcript'] };
}

// A model's answer as an object: already an object, JSON text, or JSON text in a markdown fence. Anything else is null.
export function parseAnswer(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
    try {
      value = JSON.parse(fenced ? fenced[1] : raw);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

const bare = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

// True when `text` is `transcript` with at most its filler sounds taken out: a cleaned-up request may drop 嗯 and "um",
// never a word. A model that tidies 不要删除数据库 into 删除数据库 has inverted what he asked for.
export function isCleanup(text, transcript) {
  const a = bare(withoutSounds(text));
  return a !== '' && a === bare(withoutSounds(transcript));
}

// {intent, project, text} that can be acted on, or null when the answer is not one. For to_claude, `text` is the model's
// cleaned-up request when that only removes words from the transcript, and the transcript itself otherwise. A
// switch_project must name a project that exists.
export function validateAnswer(raw, { projects, transcript = '' }) {
  const answer = parseAnswer(raw);
  if (!answer || !INTENTS.includes(answer.intent)) return null;
  if (answer.intent === 'switch_project') {
    const project = findProject(projects, answer.project);
    return project ? { intent: 'switch_project', project: project.name, text: '' } : null;
  }
  if (answer.intent === 'to_claude') {
    const said = transcript.trim();
    const cleaned = typeof answer.text === 'string' ? answer.text.trim() : '';
    const text = cleaned && isCleanup(cleaned, said) ? cleaned : said; // the model's words are only ever his own, minus the sounds
    return hasWords(text) ? { intent: 'to_claude', project: null, text } : null;
  }
  return { intent: answer.intent, project: null, text: '' };
}
