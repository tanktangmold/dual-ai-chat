// 双AI对话台 前端：状态 + 接口 + 事件。渲染模板在 ui.js，附件在 attachments.js，设置弹窗在 settings.js。
import * as ui from './ui.js';
import { createAttachmentTray, bindDropAndPaste, ACCEPT } from './attachments.js';
import { createSettingsDialog } from './settings.js';
import { detectLang, dateVars } from './i18n.mjs';

const { t } = ui;
const $ = (sel) => document.querySelector(sel);
const els = {
  sidebar: $('#sidebar'), list: $('#convList'), calendar: $('#calendar'), filterChip: $('#filterChip'), search: $('#search'),
  topbar: $('#topbarInfo'), thread: $('#thread'), form: $('#composer'), question: $('#question'), send: $('#sendBtn'),
  web: $('#webToggle'), modeGroup: $('#modeGroup'), health: $('#health'), toast: $('#toast'), topicList: $('#topicList'),
  lang: $('#langSelect'), fileInput: $('#fileInput')
};

// ---------- 偏好（只是本机便利，读不到就用默认） ----------
const pref = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`dual-chat:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`dual-chat:${key}`, JSON.stringify(value));
    } catch {
      // 隐私模式等情况下存不了，忽略
    }
  }
};

let state = {
  list: [], topics: [], hits: null, query: '',
  view: pref.get('view', 'date'), month: ui.dayKey(new Date()).slice(0, 7), day: '',
  collapsed: new Set(pref.get('collapsed', [])), expanded: new Set(),
  current: null, mode: pref.get('mode', 'both'), web: pref.get('web', null), settings: null, health: null,
  lang: pref.get('lang', detectLang(navigator.language))
};
const setState = (patch) => { state = { ...state, ...patch }; };
const live = new Map();
let sending = false;

// ---------- 接口 ----------
async function request(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error(t('net.down'));
  }
  const json = await res.json().catch(() => ({ success: false, error: t('net.bad', { status: res.status }) }));
  if (!json.success) throw new Error(json.error || t('net.failed', { status: res.status }));
  return json.data;
}

const api = (method, path, body) => request(path, {
  method,
  headers: { 'Content-Type': 'application/json', 'X-Dual-Chat': '1', 'X-Lang': state.lang },
  body: body === undefined ? undefined : JSON.stringify(body)
});

const uploadFile = (file) => request('/api/uploads', {
  method: 'POST',
  headers: { 'X-Dual-Chat': '1', 'X-Lang': state.lang, 'X-File-Name': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' },
  body: file
});

let toastTimer;
function toast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.className = `toast${isError ? ' error' : ''}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 6000 : 2400);
}

const tray = createAttachmentTray({ listEl: $('#attachList'), upload: uploadFile, onChange: () => updateComposer(), toast });
const settingsDialog = createSettingsDialog({
  api,
  toast,
  onSaved(settings, health) {
    setState({ settings, health, web: null });
    pref.set('web', null);
    renderHealth();
    updateComposer();
  }
});

// ---------- 语言 ----------
function applyStatic() {
  document.documentElement.lang = { ja: 'ja', en: 'en', zh: 'zh-CN' }[state.lang] ?? 'zh-CN';
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  els.lang.value = state.lang;
}

function setLanguage(lang) {
  setState({ lang: ['ja', 'en'].includes(lang) ? lang : 'zh' });
  pref.set('lang', state.lang);
  ui.setLang(state.lang);
  applyStatic();
  renderSidebar();
  els.topbar.dataset.conv = '';
  renderMain({ keepScroll: true });
  renderHealth();
  tray.rerender();
}

// ---------- 侧边栏 ----------
async function loadList() {
  try {
    const data = await api('GET', '/api/conversations');
    setState({ list: data.items, topics: data.topics });
    els.topicList.innerHTML = data.topics.map((x) => `<option value="${ui.esc(x.name)}">`).join('');
    renderSidebar();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSidebar() {
  const activeId = state.current?.id;
  document.querySelectorAll('.views button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));

  if (state.hits) {
    els.calendar.hidden = true;
    els.filterChip.hidden = false;
    els.filterChip.innerHTML = `<span>${ui.esc(t('list.searchResult', { q: state.query, n: state.hits.length }))}</span><button class="icon-btn" data-clear="search">${ui.esc(t('list.clear'))}</button>`;
    els.list.innerHTML = state.hits.length
      ? state.hits.map((h) => ui.convItem(h, activeId, { snippet: h.snippet })).join('')
      : `<div class="empty-list">${ui.esc(t('list.noHits'))}</div>`;
    return;
  }

  const counts = new Map();
  for (const item of state.list) for (const d of item.days) counts.set(d, (counts.get(d) ?? 0) + 1);
  els.calendar.hidden = state.view !== 'date';
  if (state.view === 'date') els.calendar.innerHTML = ui.calendar(state.month, counts, state.day);

  const items = state.day ? state.list.filter((i) => i.days.includes(state.day)) : state.list;
  els.filterChip.hidden = !state.day;
  if (state.day) {
    els.filterChip.innerHTML = `<span>${ui.esc(t('list.onlyDay', { day: ui.dayLabel(state.day) }))}</span><button class="icon-btn" data-clear="day">${ui.esc(t('list.showAll'))}</button>`;
  }
  if (!items.length) {
    els.list.innerHTML = `<div class="empty-list">${t('list.empty')}</div>`;
    return;
  }
  els.list.innerHTML = state.view === 'topic' ? ui.groupedByTopic(items, activeId, state.collapsed) : ui.groupedByDate(items, activeId);
}

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = els.search.value.trim();
    if (!query) {
      setState({ hits: null, query: '' });
      renderSidebar();
      return;
    }
    try {
      const data = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
      setState({ hits: data.items, query });
      renderSidebar();
    } catch (err) {
      toast(err.message, true);
    }
  }, 250);
}

// ---------- 主区 ----------
function topbarMeta(c) {
  const created = new Date(c.createdAt);
  return t('top.meta', { ...dateVars(created.getFullYear(), created.getMonth() + 1, created.getDate()), n: c.turns.length });
}

function renderTopbar() {
  const c = state.current;
  if (!c) {
    els.topbar.dataset.conv = '';
    els.topbar.innerHTML = `<span class="conv-name static">${ui.esc(t('top.new'))}</span><span class="muted small">${ui.esc(t('top.newHint'))}</span>`;
    return;
  }
  // 正在改标题/话题时只更新轮数，别把输入框冲掉
  if (els.topbar.dataset.conv === c.id && els.topbar.contains(document.activeElement)) {
    const meta = els.topbar.querySelector('.top-meta');
    if (meta) meta.textContent = topbarMeta(c);
    return;
  }
  els.topbar.dataset.conv = c.id;
  els.topbar.innerHTML = `
    <input class="conv-name" id="titleInput" value="${ui.esc(c.title)}" maxlength="60" aria-label="${ui.esc(t('top.titleLabel'))}" title="${ui.esc(t('top.titleTip'))}">
    <input class="topic-edit" id="topicInput" value="${ui.esc(c.topic)}" maxlength="20" list="topicList" aria-label="${ui.esc(t('top.topicLabel'))}" title="${ui.esc(t('top.topicTip'))}">
    <span class="muted small top-meta">${ui.esc(topbarMeta(c))}</span>
    <span class="spacer"></span>
    <button class="icon-btn" id="deleteConv" title="${ui.esc(t('top.deleteTip'))}">${ui.esc(t('top.delete'))}</button>`;
}

function safeTurn(turn, index) {
  try {
    return ui.turnBlock(turn, index, { expanded: state.expanded });
  } catch (err) {
    return `<section class="turn" data-turn="${ui.esc(turn.id)}"><pre class="answer-error">${ui.esc(err.message)}</pre></section>`;
  }
}

function renderThread({ keepScroll = false } = {}) {
  const c = state.current;
  const top = els.thread.scrollTop;
  if (!c || !c.turns.length) {
    els.thread.innerHTML = ui.welcome(state.topics);
    return;
  }
  els.thread.innerHTML = c.turns.map(safeTurn).join('');
  if (keepScroll) els.thread.scrollTop = top;
}

function renderMain(opts) {
  renderTopbar();
  renderThread(opts);
  updateComposer();
}

const runningTurn = () => state.current?.turns.find((x) => x.status === 'running' && live.has(x.id));

function updateComposer() {
  const running = runningTurn();
  els.send.textContent = t(running ? 'stop' : 'send');
  els.send.classList.toggle('stop', Boolean(running));
  els.send.disabled = !running && (sending || tray.busy());
  document.querySelectorAll('#modeGroup button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
  els.web.checked = state.web ?? state.settings?.web ?? true;
}

const turnIndex = (turnId) => state.current?.turns.findIndex((x) => x.id === turnId) ?? -1;
const turnEl = (turnId) => els.thread.querySelector(`.turn[data-turn="${CSS.escape(turnId)}"]`);

function patchTurn(turnId, fn) {
  if (!state.current) return;
  setState({ current: { ...state.current, turns: state.current.turns.map((x) => (x.id === turnId ? fn(x) : x)) } });
}
const patchAnswer = (turnId, model, fn) =>
  patchTurn(turnId, (x) => ({ ...x, answers: { ...x.answers, [model]: fn(x.answers?.[model] ?? { status: 'running', text: '' }) } }));

function rerenderTurn(turnId) {
  const el = turnEl(turnId);
  const i = turnIndex(turnId);
  if (el && i >= 0) el.outerHTML = safeTurn(state.current.turns[i], i);
}

function rerenderAnswer(turnId, model) {
  const el = turnEl(turnId)?.querySelector(`.answer[data-model="${model}"]`);
  const turn = state.current?.turns[turnIndex(turnId)];
  if (el && turn) el.outerHTML = ui.answerCard(model, turn.answers?.[model], turn);
}

function rerenderCompare(turnId) {
  const el = turnEl(turnId);
  const turn = state.current?.turns[turnIndex(turnId)];
  if (!el || !turn) return;
  const old = el.querySelector('.compare');
  const html = ui.compareCard(turn, { expanded: state.expanded.has(turnId) });
  if (old) old.outerHTML = html;
  else el.insertAdjacentHTML('beforeend', html);
}

const pendingBodies = new Set();
function scheduleBody(turnId, model) {
  const key = `${turnId}|${model}`;
  if (pendingBodies.has(key)) return;
  pendingBodies.add(key);
  requestAnimationFrame(() => {
    pendingBodies.delete(key);
    const card = turnEl(turnId)?.querySelector(`.answer[data-model="${model}"]`);
    const answer = state.current?.turns[turnIndex(turnId)]?.answers?.[model];
    if (!card || !answer) return;
    const nearBottom = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 160;
    card.querySelector('.body').innerHTML = ui.renderMarkdown(answer.text);
    card.querySelector('.copy')?.removeAttribute('hidden');
    if (nearBottom) els.thread.scrollTop = els.thread.scrollHeight;
  });
}

function scrollToBottom() {
  els.thread.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    els.thread.scrollTop = els.thread.scrollHeight;
    requestAnimationFrame(() => { els.thread.style.scrollBehavior = ''; });
  });
}

/** 存储里还是 running、但服务端已经没有对应任务（比如服务重启过）→ 按中断显示，不去订阅。 */
function markOrphans(conv) {
  const active = new Set(conv.activeTurns ?? []);
  const fix = (x) => {
    if (x.status !== 'running' || active.has(x.id)) return x;
    const answers = Object.fromEntries(Object.entries(x.answers ?? {}).map(([m, a]) => [m, a?.status === 'running' ? { ...a, status: 'error', error: t('restart.answer') } : a]));
    return { ...x, status: 'error', answers };
  };
  return { ...conv, turns: conv.turns.map(fix) };
}

async function openConversation(id, { quiet = false } = {}) {
  try {
    const fetched = markOrphans(await api('GET', `/api/conversations/${encodeURIComponent(id)}`));
    const switched = state.current?.id !== fetched.id;
    // 同一段对话刷新时，正在流式输出的轮次以本地为准（本地文字比服务端快照更新）
    const conv = switched ? fetched : {
      ...fetched,
      turns: fetched.turns.map((x) => (live.has(x.id) ? state.current.turns.find((l) => l.id === x.id) ?? x : x))
    };
    setState({ current: conv, expanded: switched ? new Set() : state.expanded });
    renderMain({ keepScroll: !switched });
    if (switched) scrollToBottom();
    renderSidebar();
    for (const turnId of fetched.activeTurns ?? []) {
      // 切回来时重新订阅，拿一份最新快照，避免离开期间的增量丢失
      if (switched) unsubscribe(turnId);
      subscribe(turnId);
    }
    els.sidebar.classList.remove('open');
  } catch (err) {
    if (!quiet) toast(err.message, true);
    if (/不存在|見つかりません/.test(err.message)) startNew();
  }
}

function startNew() {
  setState({ current: null, expanded: new Set() });
  if (location.hash) history.replaceState(null, '', location.pathname);
  renderMain();
  renderSidebar();
  els.question.focus();
  els.sidebar.classList.remove('open');
}

// ---------- 实时事件 ----------
function subscribe(turnId) {
  if (live.has(turnId)) return;
  const es = new EventSource(`/api/jobs/${encodeURIComponent(turnId)}/events`);
  live.set(turnId, es);
  es.onmessage = (msg) => {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    onJobEvent(turnId, event);
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      unsubscribe(turnId);
      refreshCurrent();
    }
  };
}

function unsubscribe(turnId) {
  live.get(turnId)?.close();
  live.delete(turnId);
}

async function refreshCurrent() {
  if (state.current) await openConversation(state.current.id, { quiet: true });
}

function onJobEvent(turnId, ev) {
  switch (ev.type) {
    case 'snapshot':
      patchTurn(turnId, (x) => ({
        ...x,
        status: 'running',
        answers: Object.fromEntries(Object.entries({ ...x.answers, ...ev.answers }).map(([m, a]) => [m, { ...x.answers?.[m], ...a }])),
        comparison: ev.comparison ?? x.comparison
      }));
      rerenderTurn(turnId);
      updateComposer();
      break;
    case 'delta':
      patchAnswer(turnId, ev.model, (a) => ({ ...a, text: (a.text ?? '') + ev.text }));
      scheduleBody(turnId, ev.model);
      break;
    case 'status':
    case 'reset':
      patchAnswer(turnId, ev.model, (a) => ({ ...a, statusText: ev.text, text: ev.type === 'reset' ? '' : a.text }));
      rerenderAnswer(turnId, ev.model);
      break;
    case 'answer':
      patchAnswer(turnId, ev.model, () => ev.answer);
      rerenderAnswer(turnId, ev.model);
      break;
    case 'compare-start':
      patchTurn(turnId, (x) => ({ ...x, comparison: { status: 'running', judge: ev.judge, startedAt: ev.startedAt ?? new Date().toISOString() } }));
      rerenderCompare(turnId);
      break;
    case 'compare-status':
      patchTurn(turnId, (x) => ({ ...x, comparison: { ...x.comparison, statusText: ev.text } }));
      rerenderCompare(turnId);
      break;
    case 'compare':
      patchTurn(turnId, (x) => ({ ...x, comparison: ev.comparison }));
      if (ev.comparison.status === 'done') setState({ expanded: new Set([...state.expanded, turnId]) });
      rerenderCompare(turnId);
      break;
    case 'meta':
      if (state.current) {
        setState({ current: { ...state.current, title: ev.title, topic: ev.topic } });
        renderTopbar();
        loadList();
      }
      break;
    case 'end':
    case 'gone':
      unsubscribe(turnId);
      refreshCurrent();
      loadList();
      break;
    default:
      break;
  }
}

// ---------- 提问 ----------
async function send() {
  const running = runningTurn();
  if (running) {
    await api('POST', `/api/jobs/${encodeURIComponent(running.id)}/cancel`).catch((err) => toast(err.message, true));
    return;
  }
  if (sending) return;
  if (tray.busy()) {
    toast(t('attach.wait'));
    return;
  }
  const question = els.question.value.trim();
  const attachments = tray.ids();
  if (!question && !attachments.length) {
    els.question.focus();
    return;
  }
  sending = true;
  updateComposer();
  try {
    let convId = state.current?.id;
    if (!convId) {
      const conv = await api('POST', '/api/conversations', {});
      convId = conv.id;
      setState({ current: { ...conv, activeTurns: [] } });
      history.replaceState(null, '', `#/c/${conv.id}`);
    }
    const { turnId, turn } = await api('POST', `/api/conversations/${encodeURIComponent(convId)}/ask`, {
      question, mode: state.mode, web: els.web.checked, lang: state.lang, attachments
    });
    els.question.value = '';
    autosize();
    tray.clear();
    // 等待期间用户可能切走了，或刷新已经带回这一轮：只往同一段对话里加，且按 ID 去重
    if (state.current?.id === convId && !state.current.turns.some((x) => x.id === turnId)) {
      setState({ current: { ...state.current, turns: [...state.current.turns, turn] } });
      renderMain();
      scrollToBottom();
    }
    subscribe(turnId);
    loadList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    sending = false;
    updateComposer();
  }
}

function autosize() {
  els.question.style.height = 'auto';
  els.question.style.height = `${Math.min(els.question.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

function renderHealth() {
  const h = state.health;
  if (!h) return;
  els.health.innerHTML = ['claude', 'codex'].map((k) => `<span class="${h[k].found ? 'ok' : 'bad'}">${ui.LABELS[k]}</span>`).join('');
}

// ---------- 事件处理 ----------
async function onTopbarChange(e) {
  if (!state.current) return;
  const field = e.target.id === 'titleInput' ? 'title' : e.target.id === 'topicInput' ? 'topic' : null;
  if (!field) return;
  const value = e.target.value.trim();
  if (!value) {
    e.target.value = state.current[field];
    return;
  }
  try {
    const conv = await api('PATCH', `/api/conversations/${encodeURIComponent(state.current.id)}`, { [field]: value });
    setState({ current: { ...state.current, title: conv.title, topic: conv.topic } });
    toast(t(field === 'title' ? 'top.titleSaved' : 'top.topicSaved'));
    loadList();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onDelete(e) {
  if (e.target.id !== 'deleteConv' || !state.current) return;
  if (!confirm(t('top.confirmDelete', { title: state.current.title }))) return;
  try {
    await api('DELETE', `/api/conversations/${encodeURIComponent(state.current.id)}`);
    toast(t('top.deleted'));
    startNew();
    loadList();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onRecompare(turnId, judge) {
  try {
    await api('POST', `/api/conversations/${encodeURIComponent(state.current.id)}/turns/${encodeURIComponent(turnId)}/compare`, { judge });
    patchTurn(turnId, (x) => ({ ...x, status: 'running', comparison: { status: 'pending', judge } }));
    setState({ expanded: new Set([...state.expanded].filter((x) => x !== turnId)) });
    rerenderCompare(turnId);
    subscribe(turnId);
    updateComposer();
  } catch (err) {
    toast(err.message, true);
  }
}

function onThreadClick(e) {
  const turnId = e.target.closest('.turn')?.dataset.turn;
  const copy = e.target.closest('[data-copy]');
  if (copy && turnId) {
    const text = state.current.turns[turnIndex(turnId)]?.answers?.[copy.dataset.copy]?.text ?? '';
    navigator.clipboard.writeText(text).then(() => toast(t('copied')), () => toast(t('copy.failed'), true));
    return;
  }
  const cancel = e.target.closest('[data-cancel]');
  if (cancel) {
    api('POST', `/api/jobs/${encodeURIComponent(cancel.dataset.cancel)}/cancel`).catch((err) => toast(err.message, true));
    return;
  }
  if (e.target.closest('[data-toggle-report]') && turnId) {
    const expanded = new Set(state.expanded);
    if (expanded.has(turnId)) expanded.delete(turnId);
    else expanded.add(turnId);
    setState({ expanded });
    rerenderCompare(turnId);
    return;
  }
  const reveal = e.target.closest('[data-reveal]');
  if (reveal) {
    api('POST', '/api/reports/reveal', { report: reveal.dataset.reveal }).catch((err) => toast(err.message, true));
    return;
  }
  const recompare = e.target.closest('[data-recompare]');
  if (recompare && turnId) onRecompare(turnId, recompare.dataset.recompare);
}

function onCalendarClick(e) {
  const nav = e.target.closest('[data-cal]');
  if (nav) {
    const [y, m] = state.month.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(nav.dataset.cal), 1);
    setState({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
    renderSidebar();
    return;
  }
  const day = e.target.closest('[data-day]')?.dataset.day;
  if (day) {
    setState({ day: state.day === day ? '' : day });
    renderSidebar();
  }
}

function onListClick(e) {
  const topicBtn = e.target.closest('[data-topic]');
  if (!topicBtn) return;
  const collapsed = new Set(state.collapsed);
  if (collapsed.has(topicBtn.dataset.topic)) collapsed.delete(topicBtn.dataset.topic);
  else collapsed.add(topicBtn.dataset.topic);
  setState({ collapsed });
  pref.set('collapsed', [...collapsed]);
  renderSidebar();
}

function bindComposer() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  els.question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  els.question.addEventListener('input', autosize);
  els.modeGroup.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    setState({ mode: b.dataset.mode });
    pref.set('mode', state.mode);
    updateComposer();
  });
  els.web.addEventListener('change', () => {
    setState({ web: els.web.checked });
    pref.set('web', state.web);
  });
  els.fileInput.accept = ACCEPT;
  $('#attachBtn').addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    tray.add(els.fileInput.files);
    els.fileInput.value = '';
  });
  bindDropAndPaste({ overlay: $('#dropOverlay'), onFiles: (files) => tray.add(files) });
}

function bindSidebar() {
  els.lang.addEventListener('change', () => setLanguage(els.lang.value));
  $('#newChat').addEventListener('click', startNew);
  els.search.addEventListener('input', onSearch);
  document.querySelector('.views').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    setState({ view: b.dataset.view });
    pref.set('view', state.view);
    renderSidebar();
  });
  els.calendar.addEventListener('click', onCalendarClick);
  els.filterChip.addEventListener('click', (e) => {
    const what = e.target.closest('[data-clear]')?.dataset.clear;
    if (what === 'day') setState({ day: '' });
    if (what === 'search') {
      els.search.value = '';
      setState({ hits: null, query: '' });
    }
    renderSidebar();
  });
  els.list.addEventListener('click', onListClick);
  $('#openSettings').addEventListener('click', () => settingsDialog.open());
  $('#openSidebar').addEventListener('click', () => els.sidebar.classList.add('open'));
  $('#closeSidebar').addEventListener('click', () => els.sidebar.classList.remove('open'));
}

function bind() {
  bindComposer();
  bindSidebar();
  els.topbar.addEventListener('change', onTopbarChange);
  els.topbar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
  });
  els.topbar.addEventListener('click', onDelete);
  els.thread.addEventListener('click', onThreadClick);

  // 报告 iframe 带 sandbox（不同源），按 e.source 认是哪一个
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'dual-report-height') return;
    document.querySelectorAll('iframe[data-report]').forEach((f) => {
      if (f.contentWindow === e.source) f.style.height = `${Math.max(300, Number(e.data.height) || 0) + 4}px`;
    });
  });
  window.addEventListener('hashchange', route);

  setInterval(() => {
    document.querySelectorAll('.elapsed[data-since]').forEach((el) => {
      el.textContent = t('seconds', { n: Math.max(0, Math.round((Date.now() - Date.parse(el.dataset.since)) / 1000)) });
    });
  }, 1000);
}

function route() {
  const id = location.hash.match(/^#\/c\/([\w-]+)$/)?.[1];
  if (id && id !== state.current?.id) openConversation(id);
  if (!id && state.current) startNew();
}

async function init() {
  ui.setLang(state.lang);
  applyStatic();
  bind();
  renderMain();
  await loadList();
  try {
    const [settings, health] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/health')]);
    setState({ settings, health });
    renderHealth();
    updateComposer();
    if (!health.claude.found || !health.codex.found) toast(t('set.cliMissing'), true);
  } catch (err) {
    toast(err.message, true);
  }
  route();
  els.question.focus();
}

init();
