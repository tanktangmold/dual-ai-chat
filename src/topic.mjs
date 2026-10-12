/** 根据第一个问题，让 AI 起标题、归话题（优先复用已有话题，方便按话题回看）。 */
import { LIMITS } from './store.mjs';
import { extractJson } from './compare.mjs';
import { t } from './i18n.mjs';

export const TOPIC_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'topic'],
  properties: { title: { type: 'string' }, topic: { type: 'string' } }
});

const PROMPT = Object.freeze({
  zh: (existing, suggest) => [
    '给下面这段对话起一个标题，并归入一个话题分类，用于以后按话题查找对话。',
    '- title：概括用户想问什么，简体中文，不超过 16 个字，不要标点结尾。',
    `- topic：2~6 个字的分类名。${existing.length ? `已有话题：${existing.join('、')}。如果合适，必须原样复用其中一个；` : ''}都不合适就新建一个简洁的大类（参考：${suggest}）。`,
    '只输出 JSON：{"title": "...", "topic": "..."}'
  ],
  ja: (existing, suggest) => [
    '次の会話にタイトルを付け、トピック分類を1つ決めてください。あとでトピック別に会話を探すのに使います。',
    '- title：ユーザーが聞きたいことの要約。日本語で20文字以内、末尾に句読点を付けない。',
    `- topic：2〜8文字の分類名。${existing.length ? `既存のトピック：${existing.join('、')}。合うものがあれば必ずそのまま再利用し、` : ''}合わなければ簡潔な大分類を新しく作る（例：${suggest}）。`,
    'JSON だけを出力：{"title": "...", "topic": "..."}'
  ],
  en: (existing, suggest) => [
    'Give the following chat a title and put it into one topic category, so it can be found by topic later.',
    '- title: summarize what the user wants to know, in English, at most 8 words, no trailing punctuation.',
    `- topic: a 1–3 word category name. ${existing.length ? `Existing topics: ${existing.join(', ')}. If one fits, you must reuse it exactly; ` : ''}otherwise create a concise broad category (examples: ${suggest}).`,
    'Output only JSON: {"title": "...", "topic": "..."}'
  ]
});

const QUESTION_LABEL = Object.freeze({ zh: '用户的问题：', ja: 'ユーザーの質問：', en: 'User question:' });
const UNCATEGORIZED = Object.freeze(['未分类', '未分類', 'Uncategorized']);

export function buildTopicPrompt(question, existingTopics = [], { lang = 'zh', attachmentNames = [] } = {}) {
  const key = PROMPT[lang] ? lang : 'zh';
  const existing = existingTopics.filter((x) => x && !UNCATEGORIZED.includes(x));
  const sep = key === 'en' ? ', ' : '、';
  const files = attachmentNames.length ? `\n${t(key, 'ctx.attachedNames', { names: attachmentNames.join(sep) })}` : '';
  return [...PROMPT[key](existing, t(key, 'topic.suggest')), '', `${QUESTION_LABEL[key]}\n${String(question).slice(0, 2000)}${files}`].join('\n');
}

export function fallbackTitle(question, lang = 'zh') {
  const line = String(question ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const clean = line.replace(/^[#>*\-\s]+/, '');
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean || t(lang, 'new.title');
}

export function normalizeTopic(raw, question, lang = 'zh') {
  const data = extractJson(raw);
  const title = String(data?.title ?? '').trim().replace(/[。.！!？?]+$/, '').slice(0, LIMITS.title);
  const topic = String(data?.topic ?? '').trim().slice(0, LIMITS.topic);
  return { title: title || fallbackTitle(question, lang), topic: topic || null };
}
