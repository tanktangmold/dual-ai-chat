/**
 * 任务编排：一次提问 = 一个 job（按 turnId 索引）。
 *
 * - 两个模型并行跑，增量文字实时推给订阅者（SSE），答完一个就落盘一个。
 * - 「两个都问」时两边都答完 → 匿名裁判 → 生成 HTML 对比报告。
 * - 第一问时顺带让 AI 起标题、归话题。
 * - 附件：文字直接进 prompt；图片 Claude 用 Read（只限 ./uploads/**），Codex 用 --image。
 * - 语言：turn.lang（zh / ja）决定回答语言、报告语言和错误提示语言。
 * - 浏览器断开不影响任务；重新订阅会先收到一份当前快照。
 *
 * job 本身是进程内的运行时登记表（监听者集合、取消器），对话数据仍按不可变方式更新。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId, LIMITS } from './store.mjs';
import { buildPrompt, sessionAfter, systemPrompt, attachmentSection } from './context.mjs';
import { assignSides, buildJudgePrompt, normalizeComparison, COMPARE_SCHEMA } from './compare.mjs';
import { buildTopicPrompt, fallbackTitle, normalizeTopic, TOPIC_SCHEMA } from './topic.mjs';
import { renderReport } from './report.mjs';
import { localDate } from './dates.mjs';
import { t, normalizeLang, i18nError } from './i18n.mjs';
import { UPLOAD_LIMITS } from './uploads.mjs';

export const MODE_MODELS = Object.freeze({ claude: ['claude'], codex: ['codex'], both: ['claude', 'codex'] });
const MAX_RUNNING = 4;
const KEEP_FINISHED_MS = 60_000;
const TITLE_TIMEOUT_MS = 60_000;
const TITLE_GRACE_MS = 15_000;
const VISION = Object.freeze({ claude: 'read', codex: 'inline' });

const replaceTurn = (turns, turnId, fn) => turns.map((x) => (x.id === turnId ? fn(x) : x));
const isCancelled = (err, job) => Boolean(err.cancelled) || job.controller.signal.aborted;

/** 附件元数据里存进对话的那部分（不含服务器路径）。 */
const turnAttachment = (m) => ({ id: m.id, name: m.name, file: m.file, kind: m.kind, mime: m.mime, size: m.size, textChars: m.textChars, pages: m.pages });

export function createJobs({ store, providers, uploads = null, getSettings, reportsDir, log = console, random = Math.random }) {
  const jobs = new Map();

  const runningCount = () => [...jobs.values()].filter((j) => !j.done).length;

  function emit(job, event) {
    job.snapshot = applyToSnapshot(job.snapshot, event);
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn?.(`[jobs] 推送事件失败：${err.message}`);
      }
    }
  }

  const updateTurn = (job, fn, opts) =>
    store.update(job.convId, (c) => ({ ...c, turns: replaceTurn(c.turns, job.turnId, fn) }), opts);

  function finishJob(job, status) {
    job.done = true;
    emit(job, { type: 'end', status });
    // 同一轮可能已经被「重新对比」换成了新 job，只删自己
    setTimeout(() => jobs.get(job.turnId) === job && jobs.delete(job.turnId), KEEP_FINISHED_MS).unref?.();
  }

  // ---------- 附件 ----------
  /** 把这一轮的附件解析成 prompt 需要的样子：{ meta, text, rel, scanCount, images(绝对路径) } */
  async function resolveAttachments(turn) {
    if (!uploads || !turn.attachments?.length) return [];
    const resolved = [];
    for (const a of turn.attachments) {
      const meta = await uploads.get(a.id);
      if (!meta) continue;
      const scans = meta.kind === 'pdf' && !meta.textChars ? meta.scanPages ?? [] : [];
      resolved.push({
        meta,
        text: await uploads.textOf(meta),
        rel: uploads.relPath(meta),
        scanCount: scans.length,
        images: meta.kind === 'image' ? [uploads.absPath(meta)] : scans.map((f) => uploads.absPath(meta, f))
      });
    }
    return resolved;
  }

  const hasAttachments = (conv, turn) => Boolean(turn.attachments?.length) || (conv.turns ?? []).some((x) => x.attachments?.length);

  // ---------- 单个模型回答 ----------
  async function answerWith(job, model, convBefore, turn, turnIndex, settings, files) {
    const provider = providers[model];
    const cfg = settings[model] ?? {};
    const session = convBefore.sessions?.[model];
    const lang = normalizeLang(turn.lang);
    const started = Date.now();

    const attempt = (fresh) =>
      provider.run({
        prompt: buildPrompt({
          conv: convBefore,
          model,
          question: turn.question,
          fresh,
          includeSystem: !provider.supportsSystemPrompt && (fresh || !session?.id),
          attachments: files,
          vision: VISION[model],
          lang
        }),
        sessionId: fresh ? undefined : session?.id,
        web: turn.web,
        model: cfg.model,
        effort: cfg.effort,
        systemPrompt: provider.supportsSystemPrompt ? systemPrompt(lang) : undefined,
        readFiles: hasAttachments(convBefore, turn),
        images: files.flatMap((f) => f.images),
        lang,
        signal: job.controller.signal,
        timeoutMs: settings.timeoutMin * 60_000,
        onEvent: (e) => {
          if (e.type === 'delta') emit(job, { type: 'delta', model, text: e.text });
          if (e.type === 'status') emit(job, { type: 'status', model, text: e.text });
        }
      });

    let answer;
    let sessionId = '';
    try {
      let out;
      try {
        out = await attempt(false);
      } catch (err) {
        if (!err.stale || job.controller.signal.aborted) throw err;
        emit(job, { type: 'reset', model, text: t(lang, 'stale.retry') });
        out = await attempt(true);
      }
      sessionId = out.sessionId;
      answer = { status: 'done', text: out.text, durationMs: Date.now() - started, finishedAt: new Date().toISOString() };
    } catch (err) {
      const cancelled = isCancelled(err, job);
      answer = {
        status: cancelled ? 'cancelled' : 'error',
        text: job.snapshot.answers[model]?.text ?? '',
        error: cancelled ? t(lang, 'stopped') : err.message,
        durationMs: Date.now() - started,
        finishedAt: new Date().toISOString()
      };
      if (!cancelled) log.warn?.(`[jobs] ${model} 回答失败：${err.raw ?? err.message}`);
    }

    await store.update(job.convId, (c) => ({
      ...c,
      sessions: answer.status === 'done' && sessionId ? { ...c.sessions, [model]: sessionAfter(sessionId, turnIndex, session?.id === sessionId ? session.lang ?? 'zh' : lang) } : c.sessions,
      turns: replaceTurn(c.turns, job.turnId, (x) => ({ ...x, answers: { ...x.answers, [model]: answer } }))
    }));
    emit(job, { type: 'answer', model, answer });
    return answer;
  }

  // ---------- 对比裁判 ----------
  async function compareTurn(job, judge) {
    const settings = getSettings();
    const started = Date.now();
    const conv = store.get(job.convId);
    const index = conv.turns.findIndex((x) => x.id === job.turnId);
    const turn = conv.turns[index];
    const lang = normalizeLang(turn.lang);
    emit(job, { type: 'compare-start', judge, startedAt: new Date(started).toISOString() });

    let comparison;
    try {
      const files = await resolveAttachments(turn);
      const sides = assignSides(random);
      const prompt = buildJudgePrompt({
        question: turn.question,
        answers: { claude: turn.answers.claude.text, codex: turn.answers.codex.text },
        sides,
        previousQuestion: index > 0 ? conv.turns[index - 1].question : '',
        files: attachmentSection(files, { vision: VISION[judge], lang }),
        lang
      });
      const out = await providers[judge].run({
        prompt,
        schema: COMPARE_SCHEMA,
        ephemeral: true,
        web: false,
        model: settings[judge].model,
        effort: settings.judgeEffort || settings[judge].effort,
        systemPrompt: providers[judge].supportsSystemPrompt ? t(lang, 'sys.judge') : undefined,
        readFiles: files.length > 0,
        images: files.flatMap((f) => f.images),
        lang,
        signal: job.controller.signal,
        timeoutMs: settings.timeoutMin * 60_000,
        onEvent: (e) => e.type === 'status' && emit(job, { type: 'compare-status', text: e.text })
      });
      const data = normalizeComparison(out.structured ?? out.text, sides);
      if (!data) throw new Error(t(lang, 'cmp.badJson'));

      const day = localDate(turn.createdAt);
      const report = `${day}/${job.convId}__${job.turnId}.html`;
      const latest = store.get(job.convId);
      const html = renderReport({ conv: latest, turn: latest.turns[index], comparison: data, judge });
      await mkdir(join(reportsDir, day), { recursive: true });
      await writeFile(join(reportsDir, report), html, 'utf8');
      comparison = { status: 'done', judge, data, report, durationMs: Date.now() - started };
    } catch (err) {
      const cancelled = isCancelled(err, job);
      comparison = { status: cancelled ? 'cancelled' : 'error', judge, error: cancelled ? t(lang, 'stopped') : err.message, durationMs: Date.now() - started };
      if (!cancelled) log.warn?.(`[jobs] 对比失败：${err.raw ?? err.message}`);
    }

    await updateTurn(job, (x) => ({ ...x, comparison }));
    emit(job, { type: 'compare', comparison });
    return comparison;
  }

  // ---------- 自动标题/话题 ----------
  async function autoTitle(job, turn, model) {
    const settings = getSettings();
    const lang = normalizeLang(turn.lang);
    try {
      const out = await providers[model].run({
        prompt: buildTopicPrompt(turn.question, store.topics().map((x) => x.name), { lang, attachmentNames: (turn.attachments ?? []).map((a) => a.name) }),
        schema: TOPIC_SCHEMA,
        ephemeral: true,
        web: false,
        model: settings[model].model,
        effort: 'low',
        lang,
        signal: job.controller.signal,
        timeoutMs: TITLE_TIMEOUT_MS
      });
      const meta = normalizeTopic(out.structured ?? out.text, turn.question, lang);
      const conv = await store.update(
        job.convId,
        (c) => (c.titleAuto ? { ...c, title: meta.title, topic: meta.topic ?? c.topic } : null),
        { touch: false }
      );
      emit(job, { type: 'meta', title: conv.title, topic: conv.topic });
    } catch (err) {
      if (!err.cancelled) log.warn?.(`[jobs] 自动起标题失败：${err.message}`);
    }
  }

  async function execute(job, convBefore, turn) {
    const settings = getSettings();
    const models = MODE_MODELS[turn.mode];
    const lang = normalizeLang(turn.lang);
    const titleTask = convBefore.titleAuto && convBefore.turns.length === 0 ? autoTitle(job, turn, models[0]) : null;
    const files = await resolveAttachments(turn);

    const answers = await Promise.all(models.map((m) => answerWith(job, m, convBefore, turn, convBefore.turns.length, settings, files)));
    const aborted = job.controller.signal.aborted;

    if (turn.mode === 'both') {
      if (!aborted && answers.every((a) => a.status === 'done')) {
        await compareTurn(job, settings.judge);
      } else {
        const comparison = { status: 'skipped', judge: settings.judge, error: aborted ? t(lang, 'stopped') : t(lang, 'cmp.skipped') };
        await updateTurn(job, (x) => ({ ...x, comparison }));
        emit(job, { type: 'compare', comparison });
      }
    }
    // 起标题偶尔会卡住：回答和对比都完成后最多再等一会儿，不让整轮一直显示「回答中」；标题在后台继续生成，下次刷新列表就能看到
    if (titleTask) await Promise.race([titleTask, new Promise((r) => setTimeout(r, TITLE_GRACE_MS).unref?.())]);

    const okCount = answers.filter((a) => a.status === 'done').length;
    const status = aborted ? 'cancelled' : okCount === answers.length ? 'done' : okCount ? 'partial' : 'error';
    await updateTurn(job, (x) => ({ ...x, status }));
    finishJob(job, status);
  }

  function register(convId, turnId, snapshot) {
    const job = { convId, turnId, controller: new AbortController(), listeners: new Set(), snapshot, done: false };
    jobs.set(turnId, job);
    return job;
  }

  function guard(conv) {
    if (!conv) throw i18nError(404, 'err.noConv');
    // 只认真正在跑的任务：存储里残留的 running（比如写盘失败后）不能把对话永久锁死
    if ([...jobs.values()].some((j) => j.convId === conv.id && !j.done)) {
      throw i18nError(409, 'err.busy');
    }
    if (runningCount() >= MAX_RUNNING) throw i18nError(429, 'err.tooMany', { n: MAX_RUNNING });
  }

  async function loadAttachments(ids) {
    const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
    if (list.length > UPLOAD_LIMITS.perTurn) throw i18nError(400, 'err.maxAttachments', { n: UPLOAD_LIMITS.perTurn });
    const metas = [];
    for (const id of list) {
      const meta = uploads ? await uploads.get(id) : null;
      if (!meta) throw i18nError(400, 'err.noAttachment');
      metas.push(turnAttachment(meta));
    }
    return metas;
  }

  return {
    async ask({ convId, question, mode, web, lang: rawLang, attachments: attachmentIds }) {
      const lang = normalizeLang(rawLang);
      const attachments = await loadAttachments(attachmentIds);
      const typed = typeof question === 'string' ? question.trim() : '';
      const text = typed || (attachments.length ? t(lang, 'attach.defaultQuestion') : '');
      if (!text) throw i18nError(400, 'err.emptyQuestion');
      if (text.length > LIMITS.question) throw i18nError(400, 'err.longQuestion', { n: LIMITS.question });
      if (!MODE_MODELS[mode]) throw i18nError(400, 'err.mode');

      const convBefore = store.get(convId);
      guard(convBefore);

      const models = MODE_MODELS[mode];
      const turn = {
        id: newId('t'),
        createdAt: new Date().toISOString(),
        mode,
        lang,
        question: text,
        attachments,
        web: web === undefined ? getSettings().web : Boolean(web),
        status: 'running',
        answers: Object.fromEntries(models.map((m) => [m, { status: 'running', text: '' }])),
        comparison: mode === 'both' ? { status: 'pending' } : null
      };
      const firstTurn = convBefore.turns.length === 0 && convBefore.titleAuto;
      await store.update(convId, (c) => ({
        ...c,
        title: firstTurn ? fallbackTitle(typed || attachments[0]?.name || text, lang) : c.title,
        turns: [...c.turns, turn]
      }));

      const job = register(convId, turn.id, initialSnapshot(turn));
      execute(job, convBefore, turn).catch((err) => {
        log.error?.(`[jobs] 任务异常：${err.stack ?? err.message}`);
        updateTurn(job, (x) => ({ ...x, status: 'error' })).catch(() => {});
        finishJob(job, 'error');
      });
      return { turnId: turn.id, turn };
    },

    /** 对已有的一轮重新对比（失败重试或换裁判）。 */
    async recompare({ convId, turnId, judge }) {
      const conv = store.get(convId);
      guard(conv);
      const turn = conv.turns.find((x) => x.id === turnId);
      if (!turn) throw i18nError(404, 'err.noTurn');
      if (turn.answers?.claude?.status !== 'done' || turn.answers?.codex?.status !== 'done') throw i18nError(400, 'err.needBoth');
      const who = judge ?? getSettings().judge;
      if (!['claude', 'codex'].includes(who)) throw i18nError(400, 'err.judge');

      await updateTurn({ convId, turnId }, (x) => ({ ...x, status: 'running', comparison: { status: 'pending', judge: who } }));
      const job = register(convId, turnId, { ...initialSnapshot(turn), answers: turn.answers });
      (async () => {
        const comparison = await compareTurn(job, who);
        const status = comparison.status === 'cancelled' ? 'cancelled' : 'done';
        await updateTurn(job, (x) => ({ ...x, status }));
        finishJob(job, status);
      })().catch((err) => {
        log.error?.(`[jobs] 重新对比异常：${err.stack ?? err.message}`);
        updateTurn(job, (x) => ({ ...x, status: 'done' })).catch(() => {});
        finishJob(job, 'error');
      });
      return { turnId };
    },

    cancel(turnId) {
      const job = jobs.get(turnId);
      if (!job || job.done) return false;
      job.controller.abort();
      return true;
    },

    /** 订阅一轮的事件。先推一份快照；任务不存在返回 null。 */
    subscribe(turnId, listener) {
      const job = jobs.get(turnId);
      if (!job) return null;
      listener({ type: 'snapshot', ...job.snapshot });
      if (job.done) {
        listener({ type: 'end', status: job.snapshot.status });
        return () => {};
      }
      job.listeners.add(listener);
      return () => job.listeners.delete(listener);
    },

    /** 把进行中任务的实时快照（流式文字、裁判状态）叠加进对话，刷新页面时不会丢掉已输出的部分。 */
    withLive(conv) {
      const live = (turn) => {
        const job = jobs.get(turn.id);
        if (!job || job.done) return turn;
        const snap = job.snapshot;
        const answers = Object.fromEntries(Object.entries(turn.answers ?? {}).map(([m, a]) =>
          [m, a?.status === 'running' && snap.answers[m] ? { ...a, ...snap.answers[m] } : a]));
        const comparison = snap.comparison && ['pending', 'running'].includes(snap.comparison.status) ? snap.comparison : turn.comparison;
        return { ...turn, status: 'running', answers, comparison };
      };
      return { ...conv, turns: conv.turns.map(live) };
    },

    activeTurns(convId) {
      return [...jobs.values()].filter((j) => j.convId === convId && !j.done).map((j) => j.turnId);
    },

    /** 服务重启后，把上次没跑完的轮次标成中断。 */
    async recoverInterrupted() {
      let fixed = 0;
      for (const summary of store.list().filter((s) => s.running)) {
        await store.update(summary.id, (c) => ({
          ...c,
          turns: c.turns.map((x) => (x.status !== 'running' ? x : interrupted(x)))
        }), { touch: false });
        fixed += 1;
      }
      return fixed;
    }
  };
}

function interrupted(turn) {
  const lang = normalizeLang(turn.lang);
  const mark = (a) => (a?.status === 'running' ? { ...a, status: 'error', error: t(lang, 'restart.answer') } : a);
  const answers = Object.fromEntries(Object.entries(turn.answers ?? {}).map(([m, a]) => [m, mark(a)]));
  const comparison = turn.comparison && ['pending', 'running'].includes(turn.comparison.status)
    ? { ...turn.comparison, status: 'error', error: t(lang, 'restart.compare') }
    : turn.comparison;
  return { ...turn, status: 'error', answers, comparison };
}

function initialSnapshot(turn) {
  return {
    status: 'running',
    answers: Object.fromEntries(Object.keys(turn.answers).map((m) => [m, { status: 'running', text: '', statusText: '' }])),
    comparison: turn.comparison,
    meta: null
  };
}

/** 把事件折叠进快照，供中途加入的订阅者使用。 */
export function applyToSnapshot(snap, event) {
  const patchAnswer = (model, fn) => ({ ...snap, answers: { ...snap.answers, [model]: fn(snap.answers[model] ?? { text: '' }) } });
  switch (event.type) {
    case 'delta':
      return patchAnswer(event.model, (a) => ({ ...a, text: (a.text ?? '') + event.text }));
    case 'status':
      return patchAnswer(event.model, (a) => ({ ...a, statusText: event.text }));
    case 'reset':
      return patchAnswer(event.model, (a) => ({ ...a, text: '', statusText: event.text }));
    case 'answer':
      return patchAnswer(event.model, () => ({ ...event.answer, statusText: '' }));
    case 'compare-start':
      return { ...snap, comparison: { status: 'running', judge: event.judge, startedAt: event.startedAt } };
    case 'compare-status':
      return { ...snap, comparison: { ...snap.comparison, statusText: event.text } };
    case 'compare':
      return { ...snap, comparison: event.comparison };
    case 'meta':
      return { ...snap, meta: { title: event.title, topic: event.topic } };
    case 'end':
      return { ...snap, status: event.status };
    default:
      return snap;
  }
}
