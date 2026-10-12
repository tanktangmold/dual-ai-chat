/**
 * 生成独立的「Claude × Codex 对比报告」HTML 文件（内联样式和脚本，双击就能打开、能转发）。
 * 所有模型文本先转义再排版（markdown.mjs），不可信内容不会变成可执行 HTML。
 * 报告语言跟随提问时的界面语言（turn.lang：zh / ja）。
 *
 * 配色按 dataviz 规范校验过：Claude=橙 #eb6834/#d95926，Codex=蓝 #2a78d6/#3987e5，
 * 浅色/深色模式下色盲区分度 ΔE≥24，均通过。
 */
import { escapeHtml as esc, renderMarkdown } from './markdown.mjs';
import { DIMENSIONS } from './compare.mjs';
import { LABELS } from './providers/errors.mjs';
import { t, normalizeLang } from './i18n.mjs';

const MODELS = Object.freeze(['claude', 'codex']);
const SEVERITY = Object.freeze({
  高: { cls: 'sev-high', icon: '⛔', key: 'rep.sevHigh' },
  中: { cls: 'sev-mid', icon: '⚠️', key: 'rep.sevMid' },
  低: { cls: 'sev-low', icon: 'ℹ️', key: 'rep.sevLow' }
});

export function formatDuration(ms, lang = 'zh') {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = ms / 1000;
  if (s < 60) return t(lang, 'duration.s', { s: s.toFixed(1) });
  return t(lang, 'duration.ms', { m: Math.floor(s / 60), s: String(Math.round(s % 60)).padStart(2, '0') });
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const tag = (model) => `<span class="who ${model}"><i></i>${LABELS[model]}</span>`;

function winnerBadge(winner, lang) {
  if (winner === 'tie') return `<div class="badge tie">${t(lang, 'rep.tie')}</div>`;
  return `<div class="badge ${winner}">${esc(t(lang, 'rep.winner', { model: LABELS[winner] }))}</div>`;
}

function tiles(cmp) {
  const max = DIMENSIONS.length * 10;
  return MODELS.map((m) => `
    <div class="tile ${m}${cmp.winner === m ? ' lead' : ''}">
      <div class="tile-name">${tag(m)}</div>
      <div class="tile-num">${cmp.totals[m]}<small>/${max}</small></div>
    </div>`).join('');
}

function scoreChart(cmp, lang) {
  const dim = (d) => t(lang, `dim.${d.key}`);
  const ticks = [0, 2, 4, 6, 8, 10].map((v) => `<span style="left:${v * 10}%">${v}</span>`).join('');
  const rows = DIMENSIONS.map((d) => {
    const bars = MODELS.map((m) => {
      const v = cmp.scores[m][d.key];
      return `<div class="bar-line"><div class="bar ${m}" style="width:${v * 10}%" data-tip="${esc(`${LABELS[m]} · ${dim(d)}: ${v} / 10`)}"></div><span class="bar-val">${v}</span></div>`;
    }).join('');
    return `<div class="row"><div class="row-label">${esc(dim(d))}</div><div class="row-bars">${bars}</div></div>`;
  }).join('');
  const tableRows = DIMENSIONS.map((d) => `<tr><th>${esc(dim(d))}</th>${MODELS.map((m) => `<td>${cmp.scores[m][d.key]}</td>`).join('')}</tr>`).join('');
  return `
    <div class="legend">${MODELS.map((m) => `<span class="legend-item"><i class="sw ${m}"></i>${LABELS[m]}</span>`).join('')}<span class="legend-note">${t(lang, 'rep.fullMark')}</span></div>
    <div class="chart" role="img" aria-label="${esc(t(lang, 'rep.chartAria'))}">
      <div class="grid">${[0, 2, 4, 6, 8, 10].map((v) => `<i style="left:${v * 10}%"></i>`).join('')}</div>
      ${rows}
      <div class="row axis"><div class="row-label"></div><div class="row-bars ticks">${ticks}</div></div>
    </div>
    <details class="table-view"><summary>${t(lang, 'rep.table')}</summary>
      <table><thead><tr><th>${t(lang, 'rep.dimension')}</th>${MODELS.map((m) => `<th>${LABELS[m]}</th>`).join('')}</tr></thead>
      <tbody>${tableRows}<tr class="sum"><th>${t(lang, 'rep.total')}</th>${MODELS.map((m) => `<td>${cmp.totals[m]}</td>`).join('')}</tr></tbody></table>
    </details>`;
}

const listOrEmpty = (items, empty, cls = '') =>
  items.length ? `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`;

function issuesBlock(issues, lang) {
  if (!issues.length) return `<p class="empty ok">${t(lang, 'rep.noIssues')}</p>`;
  return `<ul class="issues">${issues.map((i) => {
    const sev = SEVERITY[i.severity] ?? SEVERITY.中;
    return `<li><span class="sev ${sev.cls}">${sev.icon} ${esc(t(lang, sev.key))}</span>${tag(i.model)}<span class="issue-text">${esc(i.problem)}</span></li>`;
  }).join('')}</ul>`;
}

function betterCell(better, lang) {
  if (better === 'tie') return `<span class="better tie">${t(lang, 'rep.even')}</span>`;
  return `<span class="better ${better}">${esc(t(lang, 'rep.betterIs', { model: LABELS[better] }))}</span>`;
}

function differencesBlock(diffs, lang) {
  if (!diffs.length) return `<p class="empty">${t(lang, 'rep.noDiffs')}</p>`;
  const rows = diffs.map((d) => `
    <tr>
      <th scope="row">${esc(d.aspect)}</th>
      <td data-label="Claude">${esc(d.claude)}</td>
      <td data-label="Codex">${esc(d.codex)}</td>
      <td data-label="${esc(t(lang, 'rep.judgeCol'))}">${betterCell(d.better, lang)}${d.note ? `<div class="note">${esc(d.note)}</div>` : ''}</td>
    </tr>`).join('');
  return `<div class="table-wrap"><table class="diff"><thead><tr><th>${t(lang, 'rep.aspect')}</th><th>${tag('claude')}</th><th>${tag('codex')}</th><th>${t(lang, 'rep.better')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function prosCons(cmp, lang) {
  const none = t(lang, 'rep.none');
  return MODELS.map((m) => `
    <div class="card side ${m}">
      <h3>${tag(m)}</h3>
      <div class="pc-title plus">${t(lang, 'rep.pros')}</div>${listOrEmpty(cmp.strengths[m], none, 'plus')}
      <div class="pc-title minus">${t(lang, 'rep.cons')}</div>${listOrEmpty(cmp.weaknesses[m], none, 'minus')}
    </div>`).join('');
}

function rawAnswers(answers, lang) {
  return MODELS.map((m) => {
    const a = answers[m] ?? {};
    const meta = formatDuration(a.durationMs, lang);
    return `<article class="raw ${m}"><header>${tag(m)}${meta ? `<span class="muted">${esc(t(lang, 'answer.took', { t: meta }))}</span>` : ''}</header><div class="md">${renderMarkdown(a.text)}</div></article>`;
  }).join('');
}

/**
 * @param {{conv, turn, comparison, judge}} input comparison 为 normalizeComparison 的结果
 */
export function renderReport({ conv, turn, comparison: cmp, judge, generatedAt = new Date().toISOString() }) {
  const lang = normalizeLang(turn.lang);
  const answers = turn.answers ?? {};
  const durations = MODELS.map((m) => (answers[m]?.durationMs ? t(lang, 'rep.took', { model: LABELS[m], t: formatDuration(answers[m].durationMs, lang) }) : '')).filter(Boolean);
  const files = turn.attachments?.length ? t(lang, 'rep.attachments', { names: turn.attachments.map((a) => a.name).join(lang === 'en' ? ', ' : '、') }) : '';
  const meta = [formatTime(turn.createdAt), conv.topic ? t(lang, 'rep.topic', { topic: conv.topic }) : '', t(lang, 'rep.judge', { judge: LABELS[judge] ?? judge }), ...durations, files]
    .filter(Boolean).map(esc).join(' · ');
  const shortQ = String(turn.question ?? '').replace(/\s+/g, ' ').slice(0, 40);

  return `<!doctype html>
<html lang="${{ ja: 'ja', en: 'en', zh: 'zh-CN' }[lang]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t(lang, 'rep.titlePrefix'))} · ${esc(shortQ)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main class="report">
  <header class="hero">
    <div class="eyebrow">${t(lang, 'rep.eyebrow')}</div>
    <h1>${esc(turn.question)}</h1>
    <div class="meta">${meta}</div>
  </header>

  <section class="card verdict">
    <div class="verdict-main">
      ${winnerBadge(cmp.winner, lang)}
      <p class="verdict-text">${esc(cmp.verdict)}</p>
      ${cmp.winnerReason ? `<p class="reason">${esc(cmp.winnerReason)}</p>` : ''}
    </div>
    <div class="tiles">${tiles(cmp)}</div>
  </section>

  <section class="card">
    <h2>${t(lang, 'rep.scores')}</h2>
    ${scoreChart(cmp, lang)}
  </section>

  <div class="grid2">
    <section class="card"><h2>${t(lang, 'rep.consensus')}</h2>${listOrEmpty(cmp.consensus, t(lang, 'rep.noConsensus'), 'checks')}</section>
    <section class="card"><h2>${t(lang, 'rep.issues')}</h2>${issuesBlock(cmp.issues, lang)}</section>
  </div>

  <section class="card">
    <h2>${t(lang, 'rep.diffs')}</h2>
    ${differencesBlock(cmp.differences, lang)}
  </section>

  <div class="grid2">${prosCons(cmp, lang)}</div>

  <section class="card best">
    <h2>${t(lang, 'rep.best')} <span class="muted">${t(lang, 'rep.bestNote')}</span></h2>
    <div class="md">${renderMarkdown(cmp.bestAnswer)}</div>
  </section>

  ${cmp.recommendation ? `<section class="card tip-card"><h2>${t(lang, 'rep.advice')}</h2><p>${esc(cmp.recommendation)}</p></section>` : ''}

  <section class="card">
    <details class="raw-wrap"><summary><h2 data-open="${esc(t(lang, 'rep.collapse'))}" data-closed="${esc(t(lang, 'rep.expand'))}">${t(lang, 'rep.raw')}</h2></summary>
      <div class="grid2 raw-grid">${rawAnswers(answers, lang)}</div>
    </details>
  </section>

  <footer>${esc(t(lang, 'rep.footer', { time: formatTime(generatedAt) }))}</footer>
</main>
<div id="tip" role="tooltip" hidden></div>
<script>${REPORT_JS}</script>
</body>
</html>`;
}

const REPORT_JS = `
(function () {
  var q = new URLSearchParams(location.search).get('theme');
  if (q === 'dark' || q === 'light') document.documentElement.setAttribute('data-theme', q);
  var tip = document.getElementById('tip');
  document.querySelectorAll('[data-tip]').forEach(function (el) {
    el.addEventListener('mouseenter', function () { tip.textContent = el.getAttribute('data-tip'); tip.hidden = false; });
    el.addEventListener('mousemove', function (e) { tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; });
    el.addEventListener('mouseleave', function () { tip.hidden = true; });
  });
  function post() {
    if (window.parent === window) return;
    window.parent.postMessage({ type: 'dual-report-height', path: location.pathname, height: document.documentElement.scrollHeight }, '*');
  }
  if ('ResizeObserver' in window) new ResizeObserver(post).observe(document.body);
  document.querySelectorAll('details').forEach(function (d) { d.addEventListener('toggle', post); });
  window.addEventListener('load', post);
  post();
})();`;

const REPORT_CSS = `
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --surface-2: #f3f2ee;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
  --claude: #eb6834; --codex: #2a78d6;
  --claude-wash: rgba(235,104,52,0.10); --codex-wash: rgba(42,120,214,0.10);
  --good: #006300; --sev-high: #d03b3b; --sev-mid: #fab219; --sev-low: #898781;
  --best-wash: rgba(12,163,12,0.07);
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --claude: #d95926; --codex: #3987e5;
    --claude-wash: rgba(217,89,38,0.16); --codex-wash: rgba(57,135,229,0.16);
    --good: #0ca30c; --best-wash: rgba(12,163,12,0.10);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --surface-2: #232321;
  --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
  --claude: #d95926; --codex: #3987e5;
  --claude-wash: rgba(217,89,38,0.16); --codex-wash: rgba(57,135,229,0.16);
  --good: #0ca30c; --best-wash: rgba(12,163,12,0.10);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--page); color: var(--ink); }
body { font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; }
:lang(ja) body { font-family: system-ui, -apple-system, "Segoe UI", "Yu Gothic UI", "Meiryo", "Hiragino Sans", sans-serif; }
.report { max-width: 1080px; margin: 0 auto; padding: 28px 16px 40px; display: flex; flex-direction: column; gap: 16px; }
.hero { padding: 4px 4px 8px; }
.eyebrow { font-size: 12px; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
.hero h1 { font-size: 22px; line-height: 1.45; margin: 6px 0 8px; font-weight: 650; white-space: pre-wrap; overflow-wrap: anywhere; }
.meta, .muted { color: var(--muted); font-size: 13px; font-weight: 400; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; min-width: 0; }
.card h2 { font-size: 16px; margin: 0 0 12px; font-weight: 650; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.card h3 { margin: 0 0 10px; font-size: 15px; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
@media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
.who { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--ink); white-space: nowrap; }
.who i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.who.claude i, .sw.claude { background: var(--claude); }
.who.codex i, .sw.codex { background: var(--codex); }
.verdict { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center; }
@media (max-width: 760px) { .verdict { grid-template-columns: 1fr; } }
.badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 650; font-size: 14px; border: 1px solid var(--border); background: var(--surface-2); }
.badge.claude { background: var(--claude-wash); }
.badge.codex { background: var(--codex-wash); }
.verdict-text { font-size: 18px; font-weight: 600; margin: 12px 0 4px; line-height: 1.55; }
.reason { margin: 0; color: var(--ink-2); }
.tiles { display: flex; gap: 12px; }
.tile { border: 1px solid var(--border); border-radius: 12px; padding: 12px 18px; min-width: 128px; background: var(--surface-2); }
.tile.lead.claude { box-shadow: inset 0 -3px 0 var(--claude); }
.tile.lead.codex { box-shadow: inset 0 -3px 0 var(--codex); }
.tile-num { font-size: 34px; font-weight: 700; line-height: 1.1; margin-top: 4px; }
.tile-num small { font-size: 14px; color: var(--muted); font-weight: 500; margin-left: 2px; }
.legend { display: flex; gap: 18px; align-items: center; font-size: 13px; color: var(--ink-2); margin-bottom: 10px; flex-wrap: wrap; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.legend-note { color: var(--muted); margin-left: auto; }
.chart { position: relative; --label: 72px; }
:lang(en) .chart { --label: 110px; }
.chart .grid { position: absolute; left: calc(var(--label) + 12px); right: 34px; top: 0; bottom: 22px; pointer-events: none; }
.chart .grid i { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--grid); }
.chart .grid i:first-child { border-left-color: var(--axis); }
.row { display: grid; grid-template-columns: var(--label) minmax(0, 1fr); gap: 12px; align-items: center; padding: 7px 0; position: relative; }
.row-label { font-size: 14px; color: var(--ink-2); text-align: right; }
.row-bars { padding-right: 34px; display: flex; flex-direction: column; gap: 2px; }
.bar-line { position: relative; height: 12px; display: flex; align-items: center; }
.bar { height: 10px; border-radius: 0 4px 4px 0; position: relative; cursor: default; }
.bar::after { content: ""; position: absolute; inset: -4px 0; }
.bar.claude { background: var(--claude); }
.bar.codex { background: var(--codex); }
.bar-val { font-size: 12px; color: var(--ink-2); margin-left: 6px; font-variant-numeric: tabular-nums; }
.row.axis { padding: 0; }
.ticks { position: relative; height: 18px; display: block; margin-right: 34px; padding: 0; }
.ticks span { position: absolute; transform: translateX(-50%); font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.table-view { margin-top: 10px; font-size: 13px; color: var(--ink-2); }
.table-view summary { cursor: pointer; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
.table-view table { margin-top: 8px; max-width: 360px; }
.table-view th, .table-view td { border-bottom: 1px solid var(--grid); padding: 4px 8px; text-align: left; font-variant-numeric: tabular-nums; }
.table-view tr.sum th, .table-view tr.sum td { font-weight: 700; }
ul { margin: 0; padding-left: 0; list-style: none; }
ul li { position: relative; padding-left: 22px; margin: 6px 0; }
ul.checks li::before { content: "✓"; position: absolute; left: 2px; color: var(--good); font-weight: 700; }
ul.plus li::before { content: "+"; position: absolute; left: 4px; color: var(--good); font-weight: 700; }
ul.minus li::before { content: "−"; position: absolute; left: 4px; color: var(--sev-high); font-weight: 700; }
.pc-title { font-size: 12px; font-weight: 650; color: var(--muted); margin: 10px 0 2px; letter-spacing: .04em; }
.side.claude { border-top: 3px solid var(--claude); }
.side.codex { border-top: 3px solid var(--codex); }
.empty { color: var(--muted); margin: 0; }
.empty.ok { color: var(--good); }
ul.issues li { padding-left: 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.sev { font-size: 12px; font-weight: 650; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); white-space: nowrap; color: var(--ink); }
.sev-high { background: color-mix(in srgb, var(--sev-high) 18%, transparent); }
.sev-mid { background: color-mix(in srgb, var(--sev-mid) 26%, transparent); }
.sev-low { background: color-mix(in srgb, var(--sev-low) 18%, transparent); }
.issue-text { flex: 1 1 240px; }
.table-wrap { overflow-x: auto; }
table.diff th, table.diff td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--grid); font-size: 14px; }
table.diff thead th { font-size: 13px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--axis); }
table.diff tbody th { width: 16%; font-weight: 650; }
table.diff td:nth-child(2) { background: var(--claude-wash); }
table.diff td:nth-child(3) { background: var(--codex-wash); }
.better { display: inline-block; font-size: 12px; font-weight: 650; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); white-space: nowrap; }
.better.claude { background: var(--claude-wash); }
.better.codex { background: var(--codex-wash); }
.note { color: var(--ink-2); font-size: 13px; margin-top: 4px; }
@media (max-width: 760px) {
  table.diff thead { display: none; }
  table.diff, table.diff tbody, table.diff tr, table.diff th, table.diff td { display: block; width: 100%; }
  table.diff tr { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
  table.diff td::before { content: attr(data-label); display: block; font-size: 12px; color: var(--muted); font-weight: 600; }
}
.best { border: 1px solid color-mix(in srgb, var(--good) 35%, var(--border)); background: linear-gradient(var(--best-wash), var(--best-wash)), var(--surface); }
.tip-card p { margin: 0; }
.raw-wrap summary { cursor: pointer; list-style: none; }
.raw-wrap summary::-webkit-details-marker { display: none; }
.raw-wrap summary h2 { margin: 0; }
.raw-wrap summary h2::after { content: attr(data-closed); font-size: 13px; color: var(--muted); font-weight: 400; }
.raw-wrap[open] summary h2::after { content: attr(data-open); }
.raw-grid { margin-top: 14px; }
.raw { border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; min-width: 0; }
.raw.claude { border-top: 3px solid var(--claude); }
.raw.codex { border-top: 3px solid var(--codex); }
.raw header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md h1, .md h2, .md h3, .md h4 { font-size: 15px; margin: 14px 0 6px; display: block; }
.md p { margin: 8px 0; }
.md ul, .md ol { margin: 6px 0; padding-left: 22px; }
.md ul { list-style: disc; }
.md ul li, .md ol li { padding-left: 0; margin: 3px 0; }
.md ul li::before { content: none; }
.md code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; padding: 0 5px; font: 13px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace; }
.md pre { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; overflow-x: auto; }
.md pre code { background: none; border: 0; padding: 0; }
.md blockquote { margin: 8px 0; padding: 2px 12px; border-left: 3px solid var(--axis); color: var(--ink-2); }
.md .md-table { overflow-x: auto; margin: 8px 0; }
.md table th, .md table td { border: 1px solid var(--grid); padding: 5px 10px; font-size: 14px; }
.md table th { background: var(--surface-2); }
.md a { color: var(--codex); }
.md hr { border: 0; border-top: 1px solid var(--grid); margin: 12px 0; }
footer { text-align: center; color: var(--muted); font-size: 12px; padding-top: 8px; }
#tip { position: fixed; z-index: 10; pointer-events: none; background: var(--ink); color: var(--surface); font-size: 12px; padding: 4px 8px; border-radius: 6px; white-space: nowrap; }
@media (forced-colors: active) { .bar { border: 1px solid CanvasText; } }
@media print { body { background: #fff; } .card { break-inside: avoid; } #tip { display: none; } }
`;
