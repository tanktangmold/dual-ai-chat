/**
 * 在线体验版（GitHub Pages）的「假后台」：在浏览器里回应界面的 /api/* 请求。
 *
 * - 对话、报告、附件都来自 demo/data.json（真实提问录下来的，见 scripts/export-demo.mjs）。
 * - 问「示例问题」时按录制结果加速回放：Claude 逐字、Codex 整段、裁判对比、自动标题，事件格式和真服务完全一样。
 * - 不调用任何 AI；自由提问、上传、换裁判等需要真服务的功能给出「请下载安装」提示。
 * - 纯逻辑、不碰 DOM：时间和定时器可注入，方便在 Node 里测试。
 */

export const DEMO_TEXT = Object.freeze({
  zh: {
    banner: '在线体验版：回答是真实录制后加速回放的，不会调用 AI。想问自己的问题，请下载安装。',
    download: '下载安装',
    samples: '试试示例问题：',
    freeform: '在线体验版只能回放下面的示例问题。下载安装后就能问任何问题。',
    installedOnly: '这个功能需要安装到电脑上才能用（在线体验版不支持）。',
    dataDir: '（在线体验版：不保存任何数据，刷新页面就恢复原样）'
  },
  ja: {
    banner: 'オンラインデモ：回答は実際に録画したものを早送りで再生しています（AI は呼び出しません）。自分の質問をするにはダウンロードしてください。',
    download: 'ダウンロード',
    samples: 'サンプルの質問：',
    freeform: 'オンラインデモでは下のサンプルの質問だけ再生できます。自分の質問はアプリをダウンロードしてどうぞ。',
    installedOnly: 'この機能はアプリをインストールすると使えます（オンラインデモでは使えません）。',
    dataDir: '（オンラインデモ：データは保存されず、再読み込みで元に戻ります）'
  },
  en: {
    banner: 'Live demo: answers are real recordings replayed at higher speed — no AI is called. Download the app to ask your own questions.',
    download: 'Download',
    samples: 'Try a sample:',
    freeform: 'This online demo only replays the sample questions below. Download the app to ask anything.',
    installedOnly: 'This works in the installed app (not in the online demo).',
    dataDir: '(online demo — nothing is saved; reload to reset)'
  }
});

const DAY = 86_400_000;
const pickLang = (v) => (['zh', 'ja', 'en'].includes(v) ? v : 'en');
const text = (lang, key) => DEMO_TEXT[pickLang(lang)][key];
const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

function localDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const shiftIso = (iso, delta) => (iso ? new Date(Date.parse(iso) + delta).toISOString() : iso);

/** 把录制时间平移到「最近几天」，日历和按日期分组看起来自然。最新的一段是刚才，其余分布在前几天。 */
export function shiftDates(conversations, nowMs, dayOffsets = [0, 1, 1, 3, 5, 8]) {
  const sorted = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sorted.map((conv, i) => {
    const target = nowMs - (dayOffsets[i] ?? i) * DAY - (i + 1) * 4 * 60_000;
    const delta = target - Date.parse(conv.updatedAt);
    return {
      ...conv,
      createdAt: shiftIso(conv.createdAt, delta),
      updatedAt: shiftIso(conv.updatedAt, delta),
      turns: conv.turns.map((turn) => ({
        ...turn,
        createdAt: shiftIso(turn.createdAt, delta),
        answers: Object.fromEntries(Object.entries(turn.answers ?? {}).map(([m, a]) => [m, { ...a, finishedAt: shiftIso(a.finishedAt, delta) }]))
      }))
    };
  });
}

/** 和真服务的 store.summarize 一样的列表摘要。 */
export function summarize(conv) {
  const turns = conv.turns ?? [];
  const last = turns.at(-1);
  return {
    id: conv.id,
    title: conv.title,
    topic: conv.topic,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnCount: turns.length,
    days: [...new Set(turns.map((t) => localDate(t.createdAt)))],
    modes: [...new Set(turns.map((t) => t.mode))],
    lastQuestion: last ? normalize(last.question).slice(0, 80) : '',
    running: turns.some((t) => t.status === 'running')
  };
}

/** 每段录制对话的第一问就是一个示例问题。 */
export function buildSamples(conversations) {
  return conversations
    .filter((c) => c.turns?.length)
    .map((c) => ({ lang: c.turns[0].lang ?? 'zh', question: c.turns[0].question, mode: c.turns[0].mode, turn: c.turns[0], title: c.title, topic: c.topic, convId: c.id }));
}

function applyToSnapshot(snap, event) {
  const patch = (model, fn) => ({ ...snap, answers: { ...snap.answers, [model]: fn(snap.answers[model] ?? { text: '' }) } });
  switch (event.type) {
    case 'delta': return patch(event.model, (a) => ({ ...a, text: (a.text ?? '') + event.text }));
    case 'status': return patch(event.model, (a) => ({ ...a, statusText: event.text }));
    case 'answer': return patch(event.model, () => ({ ...event.answer, statusText: '' }));
    case 'compare-start': return { ...snap, comparison: { status: 'running', judge: event.judge, startedAt: event.startedAt } };
    case 'compare': return { ...snap, comparison: event.comparison };
    case 'meta': return { ...snap, meta: { title: event.title, topic: event.topic } };
    case 'end': return { ...snap, status: event.status };
    default: return snap;
  }
}

/** Claude 的逐字输出切成若干段（按字符，CJK 也均匀）。 */
export function chunkText(value, pieces = 36) {
  const chars = [...String(value ?? '')];
  if (!chars.length) return [];
  const size = Math.max(1, Math.ceil(chars.length / pieces));
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

/**
 * @param data { conversations }
 * @param t i18n 的 t(lang, key, vars)（新对话默认标题用）
 */
export function createDemoBackend({ data, t, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancelTimer = (id) => clearTimeout(id), speed = 0.5 }) {
  let convs = shiftDates(data.conversations ?? [], now());
  const samples = buildSamples(convs);
  const jobs = new Map();
  let seq = 0;
  let settings = {
    judge: 'claude', judgeEffort: 'low', web: false, timeoutMin: 10, ffmpegPath: '',
    claude: { model: '', effort: '', path: '' }, codex: { model: '', effort: 'medium', path: '' }
  };

  const ok = (payload) => ({ status: 200, ok: true, data: payload });
  const fail = (status, error) => ({ status, ok: false, error });
  const getConv = (id) => convs.find((c) => c.id === id);
  const setConv = (id, fn) => { convs = convs.map((c) => (c.id === id ? fn(c) : c)); };
  const setTurn = (convId, turnId, fn) => setConv(convId, (c) => ({ ...c, turns: c.turns.map((x) => (x.id === turnId ? fn(x) : x)) }));
  const newId = (prefix) => `${prefix}_demo${Date.now().toString(36)}${(seq += 1)}`;
  const findSample = (question) => samples.find((s) => normalize(s.question) === normalize(question));

  function emit(job, event) {
    job.snapshot = applyToSnapshot(job.snapshot, event);
    for (const listener of job.listeners) listener(event);
  }

  function startReplay(convId, turn, sample, models, firstTurn) {
    const rec = sample.turn;
    const job = {
      convId, turnId: turn.id, listeners: new Set(), timers: [], done: false,
      snapshot: { status: 'running', answers: Object.fromEntries(models.map((m) => [m, { status: 'running', text: '', statusText: '' }])), comparison: turn.comparison, meta: null }
    };
    jobs.set(turn.id, job);
    const at = (ms, fn) => job.timers.push(schedule(() => { if (!job.done) fn(); }, ms));
    const scaled = (m) => Math.min(7000, Math.max(1600, Math.round((rec.answers[m]?.durationMs ?? 6000) * speed)));

    for (const m of models) {
      const finish = scaled(m);
      at(300, () => emit(job, { type: 'status', model: m, text: rec.web ? '🔍 …' : '💭 …' }));
      if (m === 'claude') {
        const parts = chunkText(rec.answers[m].text);
        parts.forEach((part, i) => at(700 + Math.round(((finish - 700) * (i + 1)) / parts.length), () => emit(job, { type: 'delta', model: m, text: part })));
      } else {
        at(finish, () => emit(job, { type: 'delta', model: m, text: rec.answers[m].text }));
      }
      at(finish + 60, () => {
        const answer = { ...rec.answers[m], finishedAt: new Date(now()).toISOString() };
        setTurn(convId, turn.id, (x) => ({ ...x, answers: { ...x.answers, [m]: answer } }));
        emit(job, { type: 'answer', model: m, answer });
      });
    }

    if (firstTurn) {
      at(1800, () => {
        setConv(convId, (c) => (c.titleAuto ? { ...c, title: sample.title, topic: sample.topic } : c));
        const c = getConv(convId);
        emit(job, { type: 'meta', title: c.title, topic: c.topic });
      });
    }

    let end = Math.max(...models.map(scaled)) + 160;
    if (models.length === 2 && rec.comparison?.status === 'done') {
      const startedAt = end;
      at(startedAt, () => {
        setTurn(convId, turn.id, (x) => ({ ...x, comparison: { status: 'running', judge: rec.comparison.judge } }));
        emit(job, { type: 'compare-start', judge: rec.comparison.judge, startedAt: new Date(now()).toISOString() });
      });
      end += 3600;
      at(end, () => {
        setTurn(convId, turn.id, (x) => ({ ...x, comparison: rec.comparison }));
        emit(job, { type: 'compare', comparison: rec.comparison });
      });
    }
    at(end + 100, () => {
      setTurn(convId, turn.id, (x) => ({ ...x, status: 'done' }));
      setConv(convId, (c) => ({ ...c, updatedAt: new Date(now()).toISOString() }));
      emit(job, { type: 'end', status: 'done' });
      job.done = true;
    });
  }

  function cancel(turnId) {
    const job = jobs.get(turnId);
    if (!job || job.done) return false;
    job.timers.forEach(cancelTimer);
    job.done = true;
    setTurn(job.convId, turnId, (x) => ({
      ...x,
      status: 'cancelled',
      answers: Object.fromEntries(Object.entries(x.answers).map(([m, a]) => [m, a.status === 'running' ? { ...a, status: 'cancelled', text: job.snapshot.answers[m]?.text ?? '' } : a])),
      comparison: x.comparison && x.comparison.status !== 'done' ? { ...x.comparison, status: 'skipped' } : x.comparison
    }));
    const turn = getConv(job.convId).turns.find((x) => x.id === turnId);
    for (const [m, a] of Object.entries(turn.answers)) job.listeners.forEach((l) => l({ type: 'answer', model: m, answer: a }));
    job.listeners.forEach((l) => l({ type: 'end', status: 'cancelled' }));
    return true;
  }

  function ask(convId, body, lang) {
    const conv = getConv(convId);
    if (!conv) return fail(404, 'not found');
    if ([...jobs.values()].some((j) => j.convId === convId && !j.done)) return fail(409, t(lang, 'err.busy'));
    const sample = findSample(body.question);
    if (!sample) return fail(400, text(lang, 'freeform'));
    const recorded = Object.keys(sample.turn.answers);
    const wanted = body.mode === 'both' ? recorded : [body.mode].filter((m) => recorded.includes(m));
    const models = wanted.length ? wanted : recorded;
    const firstTurn = conv.turns.length === 0;
    const turn = {
      id: newId('t'),
      createdAt: new Date(now()).toISOString(),
      mode: models.length === 2 ? 'both' : models[0],
      lang: sample.lang,
      question: sample.question,
      attachments: sample.turn.attachments ?? [],
      web: Boolean(sample.turn.web),
      status: 'running',
      answers: Object.fromEntries(models.map((m) => [m, { status: 'running', text: '' }])),
      comparison: models.length === 2 ? { status: 'pending' } : null
    };
    setConv(convId, (c) => ({ ...c, title: firstTurn && c.titleAuto ? sample.question.slice(0, 18) : c.title, updatedAt: turn.createdAt, turns: [...c.turns, turn] }));
    startReplay(convId, turn, sample, models, firstTurn);
    return ok({ turnId: turn.id, turn });
  }

  function search(q) {
    const needle = normalize(q).toLowerCase();
    if (!needle) return [];
    return convs
      .filter((c) => [c.title, c.topic, ...c.turns.flatMap((x) => [x.question, ...Object.values(x.answers).map((a) => a.text)])].some((p) => String(p ?? '').toLowerCase().includes(needle)))
      .map((c) => ({ ...summarize(c), snippet: normalize(c.turns[0]?.question).slice(0, 80) }));
  }

  function topics() {
    const counts = new Map();
    for (const c of convs) counts.set(c.topic, (counts.get(c.topic) ?? 0) + 1);
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }

  /** 和真服务同样的路由；返回 { status, ok, data | error }。 */
  function handle(method, rawPath, body = {}, { lang = 'en' } = {}) {
    const url = new URL(rawPath, 'http://demo');
    const p = url.pathname.replace(/^.*?\/api\//, '/api/');
    let m;
    if (method === 'GET' && p === '/api/health') {
      return ok({
        claude: { found: true, file: 'claude (demo)', version: 'demo' },
        codex: { found: true, file: 'codex (demo)', version: 'demo' },
        dataDir: text(lang, 'dataDir'),
        conversations: convs.length,
        tools: { ffmpeg: '(demo)', python: '(demo)' }
      });
    }
    if (method === 'POST' && p === '/api/health/test') return ok({ ok: true, ms: 900, text: 'OK (demo)' });
    if (method === 'GET' && p === '/api/settings') return ok(settings);
    if (method === 'PUT' && p === '/api/settings') {
      settings = { ...settings, ...body, claude: { ...settings.claude, ...body.claude }, codex: { ...settings.codex, ...body.codex } };
      return ok(settings);
    }
    if (method === 'GET' && p === '/api/conversations') {
      return ok({ items: convs.map(summarize).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), topics: topics() });
    }
    if (method === 'GET' && p === '/api/search') return ok({ items: search(url.searchParams.get('q')) });
    if (method === 'POST' && p === '/api/conversations') {
      const iso = new Date(now()).toISOString();
      const conv = { id: newId('c'), title: t(lang, 'new.title'), topic: t(lang, 'new.topic'), titleAuto: true, createdAt: iso, updatedAt: iso, turns: [] };
      convs = [conv, ...convs];
      return ok(conv);
    }
    if ((m = p.match(/^\/api\/conversations\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      const conv = getConv(id);
      if (!conv) return fail(404, t(lang, 'err.noConv'));
      if (method === 'GET') {
        return ok({ ...conv, activeTurns: [...jobs.values()].filter((j) => j.convId === id && !j.done).map((j) => j.turnId) });
      }
      if (method === 'PATCH') {
        setConv(id, (c) => ({ ...c, title: body.title ?? c.title, topic: body.topic ?? c.topic, titleAuto: false }));
        return ok(getConv(id));
      }
      if (method === 'DELETE') {
        convs = convs.filter((c) => c.id !== id);
        return ok({ removed: id });
      }
    }
    if (method === 'POST' && (m = p.match(/^\/api\/conversations\/([^/]+)\/ask$/))) return ask(decodeURIComponent(m[1]), body, body.lang ?? lang);
    if (method === 'POST' && (m = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/))) return ok({ cancelled: cancel(decodeURIComponent(m[1])) });
    if (method !== 'GET') return fail(400, text(lang, 'installedOnly'));
    return fail(404, t(lang, 'err.notFound'));
  }

  /** 订阅一轮的回放事件：先给快照；不存在返回 null（界面会按 gone 处理）。 */
  function subscribe(turnId, listener) {
    const job = jobs.get(turnId);
    if (!job) return null;
    listener({ type: 'snapshot', ...job.snapshot });
    if (job.done) {
      listener({ type: 'end', status: job.snapshot.status });
      return () => {};
    }
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  /** 首次打开时展示哪段对话：优先当前语言的。 */
  function landingConversation(lang) {
    const own = samples.find((s) => s.lang === pickLang(lang));
    return own?.convId ?? convs[0]?.id ?? null;
  }

  return { handle, subscribe, samples, landingConversation };
}
