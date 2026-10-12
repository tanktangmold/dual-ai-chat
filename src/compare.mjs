/**
 * 对比裁判：把两份回答匿名成「回答A / 回答B」（顺序随机，减少裁判偏心自家模型），
 * 让裁判模型按固定 JSON 结构打分、找共识与分歧、写一份综合最佳回答，再映射回 claude / codex。
 * 思路参考 karpathy/llm-council 的「匿名互评 + 主席汇总」。
 */
import { LABELS } from './providers/errors.mjs';

/** 维度 key 固定；显示名在 i18n 的 dim.<key>。 */
export const DIMENSIONS = Object.freeze([
  { key: 'accuracy' }, { key: 'completeness' }, { key: 'clarity' }, { key: 'practicality' }, { key: 'depth' }
]);

const str = { type: 'string' };
const strList = { type: 'array', items: str };
const side = { type: 'string', enum: ['A', 'B', 'tie'] };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const scoreSet = obj(Object.fromEntries(DIMENSIONS.map((d) => [d.key, { type: 'integer' }])));

/** 严格模式 schema：每层都 required 全字段 + additionalProperties:false（OpenAI 结构化输出的要求）。 */
export const COMPARE_SCHEMA = obj({
  verdict: str,
  winner: side,
  winnerReason: str,
  scores: obj({ A: scoreSet, B: scoreSet }),
  consensus: strList,
  differences: { type: 'array', items: obj({ aspect: str, A: str, B: str, better: side, note: str }) },
  strengths: obj({ A: strList, B: strList }),
  weaknesses: obj({ A: strList, B: strList }),
  issues: { type: 'array', items: obj({ answer: { type: 'string', enum: ['A', 'B'] }, problem: str, severity: { type: 'string', enum: ['高', '中', '低'] } }) },
  bestAnswer: str,
  recommendation: str
});

/** 随机决定谁是 A。random 可注入，方便测试。 */
export function assignSides(random = Math.random) {
  return random() < 0.5 ? { A: 'claude', B: 'codex' } : { A: 'codex', B: 'claude' };
}

const JUDGE_TEXT = Object.freeze({
  zh: {
    background: (q) => `【对话背景】用户上一轮问的是：${q}`,
    lines: [
      '你是一位严格、公正的评审。下面是同一个问题的两份回答（回答A、回答B），作者匿名、顺序随机。',
      '请完成：',
      '1. 从准确性、完整性、清晰度、实用性、深度 5 个维度各打 1-10 的整数分（accuracy/completeness/clarity/practicality/depth）。',
      '2. consensus：两份回答都同意的要点（3-6 条，短句）。',
      '3. differences：两者说法不同或侧重点不同的地方（2-6 条）；A、B 字段各用一两句话概括各自的说法，better 写哪个更好（A/B/tie），note 说明理由。',
      '4. strengths / weaknesses：各自的优点和不足（每边 2-4 条）。',
      '5. issues：事实错误、过时信息、可疑或危险的建议（没有就给空数组），severity 用 高/中/低。',
      '6. winner / winnerReason / verdict：谁更好、为什么、一句话总结结论。winner 必须是五项总分更高的一方，总分相同才写 tie；如果你更看重某一项，就把它体现在分数里。',
      '7. bestAnswer：综合两者的优点、修正错误，写一份可以直接交给用户的最佳回答（Markdown）。',
      '8. recommendation：给用户的一两句使用建议（比如先采纳谁的哪部分、还要注意什么）。',
      '要求：全部用简体中文；不要因为篇幅长就给高分，看对用户的实际帮助；在文字里用「回答A」「回答B」指代两份回答。只输出符合 schema 的 JSON。'
    ],
    question: '【用户问题】',
    files: '用户提问时附带了文件，评审时请对照文件内容判断准确性：'
  },
  ja: {
    background: (q) => `【会話の背景】ユーザーの直前の質問：${q}`,
    lines: [
      'あなたは厳格で公正な審査役です。以下は同じ質問への2つの回答（回答A・回答B）で、作者は匿名、順番はランダムです。',
      '次を行ってください：',
      '1. 正確性・網羅性・分かりやすさ・実用性・深さの5項目を、それぞれ1〜10の整数で採点（accuracy/completeness/clarity/practicality/depth）。',
      '2. consensus：両方の回答が一致している要点（3〜6件、短文）。',
      '3. differences：主張や重点が異なる点（2〜6件）。A・B にはそれぞれの主張を1〜2文で要約し、better には優れている方（A/B/tie）、note には理由。',
      '4. strengths / weaknesses：それぞれの良い点と足りない点（各2〜4件）。',
      '5. issues：事実誤り・古い情報・疑わしい／危険な助言（なければ空配列）。severity は 高/中/低。',
      '6. winner / winnerReason / verdict：どちらが優れているか、その理由、結論を1文で。winner は5項目の合計点が高い方にし、同点のときだけ tie にする。重視する観点があれば点数に反映させる。',
      '7. bestAnswer：両者の良い点を合わせ、誤りを直した、そのままユーザーに渡せる最良の回答（Markdown）。',
      '8. recommendation：ユーザーへの1〜2文の使い方アドバイス（どちらのどの部分を採用するか、注意点など）。',
      '条件：すべて日本語で書く。長いだけで高得点にせず、ユーザーへの実際の有用性で判断する。本文では「回答A」「回答B」と呼ぶ。schema に合う JSON だけを出力する。'
    ],
    question: '【ユーザーの質問】',
    files: 'ユーザーは質問にファイルを添付しています。正確性はファイルの内容と照らし合わせて判断してください：'
  },
  en: {
    background: (q) => `[Context] The user's previous question was: ${q}`,
    lines: [
      'You are a strict, fair judge. Below are two answers (Answer A and Answer B) to the same question. The authors are anonymous and the order is random.',
      'Please do the following:',
      '1. Score each answer from 1 to 10 (integers) on accuracy, completeness, clarity, practicality and depth (accuracy/completeness/clarity/practicality/depth).',
      '2. consensus: points both answers agree on (3–6 short items).',
      '3. differences: places where they disagree or emphasize different things (2–6 items). In A and B, summarize each answer\'s position in one or two sentences; in better, say which is better (A/B/tie); in note, explain why.',
      '4. strengths / weaknesses: 2–4 items for each answer.',
      '5. issues: factual errors, outdated information, questionable or risky advice (empty array if none); severity is 高 (high) / 中 (medium) / 低 (low).',
      '6. winner / winnerReason / verdict: which is better, why, and the conclusion in one sentence. The winner must be the answer with the higher total score; use tie only when totals are equal. If one aspect matters more to you, reflect it in the scores.',
      '7. bestAnswer: combine the strengths of both, fix their mistakes, and write the best answer that can be handed directly to the user (Markdown).',
      '8. recommendation: one or two sentences of advice for the user (e.g. which parts to adopt first and what to watch out for).',
      'Requirements: write everything in English; do not reward length — judge by real usefulness to the user; refer to the answers as "Answer A" and "Answer B" in your text. Output only JSON that matches the schema.'
    ],
    question: '[User question]',
    files: 'The user attached files to the question. Judge accuracy against their contents:'
  }
});

const ANSWER_LABELS = Object.freeze({ zh: ['【回答A】', '【回答B】'], ja: ['【回答A】', '【回答B】'], en: ['[Answer A]', '[Answer B]'] });

export function buildJudgePrompt({ question, answers, sides, previousQuestion, files = '', lang = 'zh' }) {
  const key = JUDGE_TEXT[lang] ? lang : 'zh';
  const text = JUDGE_TEXT[key];
  const [labelA, labelB] = ANSWER_LABELS[key];
  const body = [
    previousQuestion ? text.background(previousQuestion) : '',
    `${text.question}\n${question}`,
    files ? `${text.files}\n${files}` : '',
    `${labelA}\n${answers[sides.A]}`,
    `${labelB}\n${answers[sides.B]}`
  ].filter(Boolean);
  return [...text.lines, '', ...body].join('\n');
}

/** 从模型文本里抠出 JSON（结构化输出失效时的兜底）。 */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').trim();
  const candidates = [s];
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);
const asText = (v) => String(v ?? '').trim();
const clampScore = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
};

/** 把文字里的「回答A/回答B」换成真实模型名。 */
function relabel(text, sides) {
  return asText(text)
    .replace(/(回答|答案|Answer)\s*A(?![A-Za-z])/g, LABELS[sides.A])
    .replace(/(回答|答案|Answer)\s*B(?![A-Za-z])/g, LABELS[sides.B]);
}

const sideToModel = (value, sides) => (value === 'A' || value === 'B' ? sides[value] : 'tie');

/** 校验 + 归一化裁判输出，A/B 映射回 claude/codex。结构不对返回 null。 */
export function normalizeComparison(raw, sides) {
  const data = extractJson(raw);
  if (!data || typeof data !== 'object' || !data.scores) return null;

  const scores = {};
  const totals = {};
  for (const letter of ['A', 'B']) {
    const model = sides[letter];
    const src = data.scores[letter] ?? {};
    scores[model] = Object.fromEntries(DIMENSIONS.map((d) => [d.key, clampScore(src[d.key])]));
    totals[model] = DIMENSIONS.reduce((sum, d) => sum + scores[model][d.key], 0);
  }

  const bySide = (field) => ({
    [sides.A]: asList(data[field]?.A).map((t) => relabel(t, sides)),
    [sides.B]: asList(data[field]?.B).map((t) => relabel(t, sides))
  });

  return {
    verdict: relabel(data.verdict, sides),
    winner: sideToModel(data.winner, sides),
    winnerReason: relabel(data.winnerReason, sides),
    scores,
    totals,
    consensus: asList(data.consensus).map((t) => relabel(t, sides)),
    differences: (Array.isArray(data.differences) ? data.differences : []).map((d) => ({
      aspect: relabel(d?.aspect, sides),
      [sides.A]: relabel(d?.A, sides),
      [sides.B]: relabel(d?.B, sides),
      better: sideToModel(d?.better, sides),
      note: relabel(d?.note, sides)
    })),
    strengths: bySide('strengths'),
    weaknesses: bySide('weaknesses'),
    issues: (Array.isArray(data.issues) ? data.issues : [])
      .filter((i) => i && (i.answer === 'A' || i.answer === 'B'))
      .map((i) => ({ model: sides[i.answer], problem: relabel(i.problem, sides), severity: ['高', '中', '低'].includes(i.severity) ? i.severity : '中' })),
    bestAnswer: relabel(data.bestAnswer, sides),
    recommendation: relabel(data.recommendation, sides),
    sides
  };
}
