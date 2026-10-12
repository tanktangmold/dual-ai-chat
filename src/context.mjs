/**
 * 多轮上下文：每个模型在 CLI 里有自己的会话（claude --resume / codex exec resume），
 * 已经记得自己参与过的轮次。只有「它没参与的轮次」（比如这轮只问了另一个模型）需要补给它。
 *
 * conv.sessions[model] = { id, seenTurns } —— seenTurns 是它会话里已经包含的轮次数。
 *
 * 附件：文字类（文本 / PDF / Office 提取出的文字）直接放进 prompt；图片 Claude 用 Read 工具看（vision='read'），
 * Codex 随消息附上（vision='inline'）。
 */
import { LABELS } from './providers/errors.mjs';
import { t } from './i18n.mjs';

export const systemPrompt = (lang) => t(lang, 'sys.prompt');
/** 兼容旧调用：中文系统提示。 */
export const SYSTEM_PROMPT = systemPrompt('zh');

const HISTORY_LIMITS = Object.freeze({ turns: 12, answerChars: 4000, totalChars: 24000 });
export const ATTACH_LIMITS = Object.freeze({ perFile: 30_000, total: 60_000 });

const clip = (text, max, lang) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}${t(lang, 'ctx.cut')}` : s;
};

function renderTurn(turn, index, lang) {
  const lines = [t(lang, 'ctx.user', { n: index + 1 }), turn.question];
  if (turn.attachments?.length) lines.push(t(lang, 'ctx.attachedNames', { names: turn.attachments.map((a) => a.name).join(lang === 'en' ? ', ' : '、') }));
  for (const [model, answer] of Object.entries(turn.answers ?? {})) {
    if (answer?.status === 'done' && answer.text) {
      lines.push(t(lang, 'ctx.answer', { n: index + 1, model: LABELS[model] ?? model }), clip(answer.text, HISTORY_LIMITS.answerChars, lang));
    }
  }
  return lines.join('\n');
}

/** 取出要补给某模型的历史轮次（只算已完成的）。 */
export function missedTurns(conv, model, { fresh = false } = {}) {
  const session = conv.sessions?.[model];
  const from = !fresh && session?.id ? session.seenTurns ?? 0 : 0;
  return (conv.turns ?? [])
    .map((turn, index) => ({ turn, index }))
    .slice(from)
    .filter(({ turn }) => turn.status !== 'running')
    .slice(-HISTORY_LIMITS.turns);
}

function historyBlock(entries, lang) {
  const parts = [];
  let total = 0;
  for (const { turn, index } of [...entries].reverse()) {
    const block = renderTurn(turn, index, lang);
    if (total + block.length > HISTORY_LIMITS.totalChars && parts.length) break;
    parts.unshift(block);
    total += block.length;
  }
  return parts.join('\n\n');
}

const fileBlock = (name, text) => `<file name="${String(name).replace(/"/g, "'")}">\n${text}\n</file>`;

/**
 * 附件说明段。
 * @param attachments [{ meta, text, rel, scanCount }]  由 jobs 解析好
 * @param vision 'read'（Claude：用 Read 工具读路径）| 'inline'（Codex：图片已随消息附上）
 */
export function attachmentSection(attachments, { vision, lang }) {
  if (!attachments?.length) return '';
  let budget = ATTACH_LIMITS.total;
  const lines = [t(lang, 'att.header')];
  attachments.forEach(({ meta, text, rel, scanCount }, i) => {
    const n = `${i + 1}. `;
    const name = meta.name;
    if (meta.kind === 'image') {
      lines.push(n + t(lang, vision === 'read' ? 'att.imageRead' : 'att.imageInline', { name, path: rel }));
      return;
    }
    const content = String(text ?? '');
    if (meta.kind === 'pdf' && vision === 'read') lines.push(n + t(lang, 'att.pdfRead', { name, path: rel }));
    if (content.trim()) {
      const room = Math.max(0, Math.min(ATTACH_LIMITS.perFile, budget));
      const shown = content.slice(0, room);
      budget -= shown.length;
      const head = meta.kind === 'pdf' && vision === 'read' ? '' : n;
      lines.push(head + t(lang, 'att.text', { name }), fileBlock(name, shown));
      if (shown.length < content.length) lines.push(t(lang, 'att.textCut', { n: shown.length }));
    } else if (meta.kind === 'pdf' && scanCount && vision !== 'read') {
      lines.push(n + t(lang, 'att.pdfPages', { name, n: scanCount }));
    } else if (!(meta.kind === 'pdf' && vision === 'read')) {
      lines.push(n + t(lang, 'att.noText', { name }));
    }
  });
  return lines.join('\n');
}

/**
 * 组装发给某模型的 prompt。
 * @param conv 不含本轮的对话快照
 * @param fresh true = 强制开新会话（旧会话失效时），把历史全补上
 */
export function buildPrompt({ conv, model, question, fresh = false, includeSystem = false, attachments = [], vision = 'read', lang = 'zh' }) {
  const session = conv.sessions?.[model];
  // 续接的会话沿用最初的系统提示；中途换了界面语言就在提问里明确说一声
  const switched = Boolean(!fresh && session?.id && (session.lang ?? 'zh') !== lang);
  const entries = missedTurns(conv, model, { fresh });
  const sections = [];
  if (includeSystem) sections.push(`${t(lang, 'ctx.note')}${systemPrompt(lang)}`);
  if (entries.length) {
    sections.push(t(lang, 'ctx.missed'), `<history>\n${historyBlock(entries, lang)}\n</history>`, t(lang, 'ctx.now'));
  }
  if (switched) sections.push(t(lang, 'ctx.langSwitch'));
  sections.push(question);
  const files = attachmentSection(attachments, { vision, lang });
  if (files) sections.push(files);
  return sections.join('\n\n');
}

/** 模型答完后，它的会话就包含了到本轮为止的所有轮次。 */
export const sessionAfter = (sessionId, turnIndex, lang) => ({ id: sessionId, seenTurns: turnIndex + 1, ...(lang ? { lang } : {}) });
