// 纯渲染函数：数据 → HTML 字符串。所有动态文本都经过 esc / renderMarkdown，所有界面文字走 i18n。
import { escapeHtml as esc, renderMarkdown } from '/markdown.mjs';
import { t as translate, WEEKDAYS, dateVars } from '/i18n.mjs';

export { esc, renderMarkdown };

let lang = 'zh';
export const setLang = (value) => { lang = ['ja', 'en'].includes(value) ? value : 'zh'; };
export const getLang = () => lang;
export const t = (key, vars) => translate(lang, key, vars);

export const LABELS = { claude: 'Claude', codex: 'Codex' };
export const DIMENSIONS = ['accuracy', 'completeness', 'clarity', 'practicality', 'depth'];

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeOf = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function dayLabel(key, today = dayKey(new Date())) {
  const [y, m, d] = key.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((new Date(ty, tm - 1, td).getTime() - date.getTime()) / 86400000);
  const w = WEEKDAYS[lang][date.getDay()];
  const base = t('day.format', { ...dateVars(y, m, d), w });
  if (diff === 0) return t('day.today', { d: base });
  if (diff === 1) return t('day.yesterday', { d: base });
  return y === new Date().getFullYear() ? base : t('day.formatYear', { ...dateVars(y, m, d), w });
}

export function shortWhen(iso) {
  if (dayKey(iso) === dayKey(new Date())) return timeOf(iso);
  const d = new Date(iso);
  return d.getFullYear() === new Date().getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = ms / 1000;
  return s < 60 ? t('duration.s', { s: s.toFixed(1) }) : t('duration.ms', { m: Math.floor(s / 60), s: pad(Math.round(s % 60)) });
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileIcon(kind, name = '') {
  if (kind === 'image') return '🖼';
  if (kind === 'pdf') return '📕';
  if (/\.xlsx?m?$/i.test(name) || /\.(csv|tsv)$/i.test(name)) return '📊';
  if (/\.pptx$/i.test(name)) return '📽';
  if (/\.docx$/i.test(name)) return '📝';
  return '📄';
}

export const uploadUrl = (a) => `/uploads/${encodeURIComponent(a.id)}/${encodeURIComponent(a.file || a.name)}`;

const who = (model) => `<span class="who ${model}"><i></i>${LABELS[model]}</span>`;

// ---------- 侧边栏 ----------

function modeIcons(modes) {
  return modes.map((m) => (m === 'both' ? `<i class="mi both" title="${esc(t('mode.icon.both'))}">⚖</i>` : `<i class="mi ${m}" title="${LABELS[m]}"></i>`)).join('');
}

export function convItem(item, activeId, { snippet = '' } = {}) {
  const running = item.running ? `<span class="spin small" title="${esc(t('running'))}"></span>` : '';
  return `<a class="conv-item${item.id === activeId ? ' active' : ''}" href="#/c/${esc(item.id)}" data-id="${esc(item.id)}">
    <div class="conv-title">${running}${esc(item.title)}</div>
    ${snippet ? `<div class="conv-snippet">${esc(snippet)}</div>` : ''}
    <div class="conv-meta"><span class="topic-chip">${esc(item.topic)}</span><span class="modes">${modeIcons(item.modes)}</span><time>${esc(shortWhen(item.updatedAt))}</time></div>
  </a>`;
}

export function groupedByDate(items, activeId) {
  const groups = new Map();
  for (const item of items) {
    const key = dayKey(item.updatedAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([key, list]) => `<div class="group"><div class="group-head">${esc(dayLabel(key))}<span class="count">${list.length}</span></div>${list.map((i) => convItem(i, activeId)).join('')}</div>`)
    .join('');
}

export function groupedByTopic(items, activeId, collapsed) {
  const groups = new Map();
  for (const item of items) groups.set(item.topic, [...(groups.get(item.topic) ?? []), item]);
  return [...groups.entries()]
    .sort((a, b) => b[1][0].updatedAt.localeCompare(a[1][0].updatedAt))
    .map(([topic, list]) => {
      const shut = collapsed.has(topic);
      return `<div class="group${shut ? ' shut' : ''}">
        <button class="group-head toggle" data-topic="${esc(topic)}" aria-expanded="${!shut}"><span class="caret">▾</span>${esc(topic)}<span class="count">${list.length}</span></button>
        <div class="group-body">${list.map((i) => convItem(i, activeId)).join('')}</div>
      </div>`;
    })
    .join('');
}

export function calendar(month, counts, selected) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 周一开头
  const today = dayKey(new Date());
  const cells = Array.from({ length: lead }, () => '<span class="cal-cell empty"></span>');
  for (let d = 1; d <= days; d += 1) {
    const key = `${y}-${pad(m)}-${pad(d)}`;
    const n = counts.get(key) ?? 0;
    const cls = ['cal-cell', n ? 'has' : '', key === today ? 'today' : '', key === selected ? 'sel' : ''].filter(Boolean).join(' ');
    const title = n ? t('cal.count', { date: key, n }) : key;
    cells.push(`<button class="${cls}" data-day="${key}" title="${esc(title)}" ${n ? '' : 'disabled'}>${d}${n ? '<i></i>' : ''}</button>`);
  }
  const week = [1, 2, 3, 4, 5, 6, 0].map((i) => `<span class="cal-w">${WEEKDAYS[lang][i]}</span>`).join('');
  return `<div class="cal-head"><button class="icon-btn" data-cal="-1" aria-label="${esc(t('cal.prev'))}">‹</button><span>${esc(t('cal.month', dateVars(y, m, 1)))}</span><button class="icon-btn" data-cal="1" aria-label="${esc(t('cal.next'))}">›</button></div>
    <div class="cal-grid">${week}${cells.join('')}</div>`;
}

// ---------- 对话区 ----------

function attachmentsBlock(list) {
  if (!list?.length) return '';
  const images = list.filter((a) => a.kind === 'image');
  const others = list.filter((a) => a.kind !== 'image');
  const imgs = images.map((a) => `<a class="q-img" href="${esc(uploadUrl(a))}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${esc(uploadUrl(a))}" alt="${esc(a.name)}" loading="lazy"></a>`).join('');
  const docs = others.map((a) => {
    const extra = [formatSize(a.size), a.pages ? t('attach.pages', { n: a.pages }) : ''].filter(Boolean).join(' · ');
    return `<a class="q-file" href="${esc(uploadUrl(a))}" target="_blank" rel="noopener" title="${esc(t('attach.open'))}"><span class="q-file-icon">${fileIcon(a.kind, a.name)}</span><span class="q-file-name">${esc(a.name)}</span><span class="muted">${esc(extra)}</span></a>`;
  }).join('');
  return `<div class="q-files">${imgs}${docs}</div>`;
}

function answerState(answer, turn) {
  if (!answer || answer.status === 'running') {
    const status = answer?.statusText ? esc(answer.statusText) : esc(t('answer.running'));
    return `<span class="state running"><span class="spin"></span><span class="status-text">${status}</span><span class="elapsed" data-since="${esc(turn.createdAt)}"></span></span>`;
  }
  if (answer.status === 'done') return `<span class="state done">${esc(t('answer.took', { t: formatDuration(answer.durationMs) }))}</span>`;
  if (answer.status === 'cancelled') return `<span class="state warn">${esc(t('answer.cancelled'))}</span>`;
  return `<span class="state err">${esc(t('answer.error'))}</span>`;
}

export function answerCard(model, answer, turn) {
  const text = answer?.text ?? '';
  const body = text ? renderMarkdown(text) : answer?.status === 'running' || !answer ? `<p class="placeholder">${esc(t('answer.waiting'))}</p>` : '';
  const error = answer?.error && answer.status !== 'cancelled' ? `<div class="answer-error">${esc(answer.error)}</div>` : '';
  return `<article class="answer ${model}" data-model="${model}">
    <header>${who(model)}${answerState(answer, turn)}<span class="spacer"></span>
      <button class="icon-btn copy" data-copy="${model}" title="${esc(t('copy.title'))}" ${text ? '' : 'hidden'}>${esc(t('copy'))}</button></header>
    <div class="md body">${body}</div>${error}
  </article>`;
}

function miniDims(data) {
  return DIMENSIONS.map((key) => `<div class="dim"><span class="dim-label">${esc(t(`dim.${key}`))}</span>
    <span class="dim-bars"><i class="claude" style="width:${data.scores.claude[key] * 10}%"></i><i class="codex" style="width:${data.scores.codex[key] * 10}%"></i></span>
    <span class="dim-val">${data.scores.claude[key]} : ${data.scores.codex[key]}</span></div>`).join('');
}

export function compareCard(turn, { expanded = false } = {}) {
  const c = turn.comparison;
  if (!c) return '';
  const judge = c.judge ? t('cmp.judge', { judge: LABELS[c.judge] }) : '';
  const head = (actions = '') => `<header><span class="compare-title">${esc(t('cmp.title'))}</span><span class="muted">${esc(judge)}</span><span class="spacer"></span>${actions}</header>`;

  if (c.status === 'pending') return `<section class="compare waiting">${head()}<p class="muted">${esc(t('cmp.pending'))}</p></section>`;
  if (c.status === 'running') {
    const since = c.startedAt ? ` <span class="elapsed" data-since="${esc(c.startedAt)}"></span>` : '';
    return `<section class="compare waiting">${head()}<p class="muted"><span class="spin"></span> ${esc(c.statusText || t('cmp.running'))}${since}</p></section>`;
  }
  if (c.status !== 'done') {
    const retry = turn.answers?.claude?.status === 'done' && turn.answers?.codex?.status === 'done'
      ? ['claude', 'codex'].map((j) => `<button class="btn small" data-recompare="${j}">${esc(t('cmp.retryWith', { judge: LABELS[j] }))}</button>`).join('') : '';
    return `<section class="compare failed">${head(retry)}<p class="muted">${esc(c.error || t('cmp.notDone'))}</p></section>`;
  }

  const d = c.data;
  const total = d.totals.claude + d.totals.codex || 1;
  const winner = d.winner === 'tie' ? `<span class="pill tie">${esc(t('cmp.tie'))}</span>` : `<span class="pill ${d.winner}">${esc(t('cmp.winner', { model: LABELS[d.winner] }))}</span>`;
  const url = `/reports/${c.report}`;
  const other = c.judge === 'claude' ? 'codex' : 'claude';
  const actions = `<button class="btn small" data-toggle-report>${esc(t(expanded ? 'cmp.collapse' : 'cmp.expand'))}</button>
    <a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">${esc(t('cmp.newWindow'))}</a>
    <button class="btn small ghost" data-reveal="${esc(c.report)}" title="${esc(t('cmp.fileTitle'))}">${esc(t('cmp.file'))}</button>
    <button class="btn small ghost" data-recompare="${other}" title="${esc(t('cmp.swapTitle'))}">${esc(t('cmp.swap'))}</button>`;
  return `<section class="compare done">
    ${head(actions)}
    <div class="compare-body">
      <div class="compare-top">${winner}
        <div class="duo"><span class="duo-side claude">${who('claude')}<b>${d.totals.claude}</b></span>
          <span class="duo-bar"><i class="claude" style="width:${(d.totals.claude / total) * 100}%"></i><i class="codex" style="width:${(d.totals.codex / total) * 100}%"></i></span>
          <span class="duo-side codex"><b>${d.totals.codex}</b>${who('codex')}</span></div>
      </div>
      <p class="verdict">${esc(d.verdict)}</p>
      <div class="dims">${miniDims(d)}</div>
      ${d.issues.length ? `<p class="issues-line">${esc(t('cmp.issues', { n: d.issues.length }))}</p>` : ''}
    </div>
    <div class="report-frame"${expanded ? '' : ' hidden'}>${expanded ? `<iframe src="${esc(url)}" title="${esc(t('cmp.frame'))}" data-report="${esc(url)}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe>` : ''}</div>
  </section>`;
}

export function turnBlock(turn, index, opts = {}) {
  const models = turn.mode === 'both' ? ['claude', 'codex'] : [turn.mode];
  return `<section class="turn" data-turn="${esc(turn.id)}">
    <div class="question">
      <div class="q-meta"><span class="q-who">${esc(t('turn.you'))}</span><span class="muted">${esc(t('turn.meta', { n: index + 1, time: timeOf(turn.createdAt) }))}</span>
        <span class="mode-tag ${turn.mode}">${esc(t(`mode.${turn.mode}`))}</span>${turn.web ? `<span class="mode-tag web">${esc(t('turn.web'))}</span>` : ''}
        ${turn.status === 'running' ? `<button class="btn small danger" data-cancel="${esc(turn.id)}">${esc(t('stop'))}</button>` : ''}</div>
      <div class="q-text">${esc(turn.question)}</div>
      ${attachmentsBlock(turn.attachments)}
    </div>
    <div class="answers cols-${models.length}">${models.map((m) => answerCard(m, turn.answers?.[m], turn)).join('')}</div>
    ${compareCard(turn, { expanded: opts.expanded?.has(turn.id) })}
  </section>`;
}

export function welcome(topics) {
  const chips = topics.slice(0, 8).map((x) => `<span class="topic-chip">${esc(x.name)} · ${x.count}</span>`).join('');
  return `<div class="welcome">
    <h1>${esc(t('welcome.title'))}</h1>
    <p class="muted">${esc(t('welcome.desc'))}</p>
    <div class="mode-cards">
      <div class="mode-card"><div>${who('claude')}</div><p>${esc(t('welcome.claude'))}</p></div>
      <div class="mode-card"><div>${who('codex')}</div><p>${esc(t('welcome.codex'))}</p></div>
      <div class="mode-card both"><div>⚖ ${esc(t('mode.both'))}</div><p>${esc(t('welcome.both'))}</p></div>
    </div>
    <p class="welcome-files">${esc(t('welcome.files'))}</p>
    ${chips ? `<div class="welcome-topics"><span class="muted">${esc(t('welcome.topics'))}</span>${chips}</div>` : ''}
  </div>`;
}
