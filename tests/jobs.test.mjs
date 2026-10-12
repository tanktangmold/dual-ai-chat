import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createJobs, applyToSnapshot } from '../src/jobs.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

const quiet = { warn() {}, error() {} };

const JUDGE_JSON = {
  verdict: '回答A 更好', winner: 'A', winnerReason: '更具体',
  scores: { A: { accuracy: 9, completeness: 8, clarity: 8, practicality: 9, depth: 7 }, B: { accuracy: 7, completeness: 7, clarity: 8, practicality: 7, depth: 6 } },
  consensus: ['都说要用 LTS'], differences: [], strengths: { A: ['具体'], B: ['简短'] }, weaknesses: { A: [], B: ['笼统'] },
  issues: [], bestAnswer: '**综合答案**', recommendation: '用回答A'
};

/** 假 provider：记录调用参数，按脚本返回。 */
function fakeProvider(kind, script = {}) {
  const calls = [];
  return {
    kind,
    calls,
    supportsSystemPrompt: kind === 'claude',
    async run(opts) {
      calls.push(opts);
      await new Promise((r) => setTimeout(r, 5)); // 真 CLI 总有启动耗时，订阅者先连上
      if (opts.schema?.required?.includes('verdict')) return { text: JSON.stringify(JUDGE_JSON), structured: JUDGE_JSON, sessionId: '' };
      if (opts.schema?.required?.includes('title')) return { text: '', structured: { title: '自动标题', topic: '编程开发' }, sessionId: '' };
      if (opts.signal?.aborted) throw Object.assign(new Error('已取消'), { cancelled: true });
      if (script.delay) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, script.delay);
          opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('已取消'), { cancelled: true })); });
        });
      }
      if (script.failStaleOnce && opts.sessionId) throw Object.assign(new Error('会话失效'), { stale: true });
      if (script.fail) throw new Error(`${kind} 坏了`);
      opts.onEvent?.({ type: 'status', text: '思考中…' });
      opts.onEvent?.({ type: 'delta', text: `${kind} 的回答` });
      return { text: `${kind} 的回答 #${calls.length}`, sessionId: `${kind}-session-${calls.length}` };
    }
  };
}

let dir;
let store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dual-chat-jobs-'));
  store = createStore({ dir, log: quiet });
  await store.load();
});

function setup(providers) {
  const events = [];
  const jobs = createJobs({ store, providers, getSettings: () => DEFAULT_SETTINGS, reportsDir: join(dir, 'reports'), log: quiet, random: () => 0.1 });
  const waitEnd = (turnId) => new Promise((resolve) => {
    const unsub = jobs.subscribe(turnId, (e) => {
      events.push(e);
      if (e.type === 'end') resolve(e);
    });
    if (!unsub) resolve(null);
  });
  return { jobs, events, waitEnd };
}

test('两个都问：并行回答 → 对比 → 生成报告 → 自动标题', async () => {
  const claude = fakeProvider('claude');
  const codex = fakeProvider('codex');
  const { jobs, events, waitEnd } = setup({ claude, codex });
  const conv = await store.create();

  const { turnId } = await jobs.ask({ convId: conv.id, question: '怎么选 Node 版本？', mode: 'both', web: false });
  const end = await waitEnd(turnId);
  assert.equal(end.status, 'done');

  const saved = store.get(conv.id);
  const turn = saved.turns[0];
  assert.equal(turn.status, 'done');
  assert.match(turn.answers.claude.text, /^claude 的回答 #\d/);
  assert.equal(turn.answers.codex.status, 'done');
  assert.equal(turn.comparison.status, 'done');
  assert.equal(turn.comparison.data.winner, 'claude', 'random=0.1 → A=claude，A 赢');
  assert.equal(saved.title, '自动标题');
  assert.equal(saved.topic, '编程开发');
  assert.equal(saved.sessions.claude.seenTurns, 1);
  assert.match(saved.sessions.claude.id, /^claude-session-/);

  const html = await readFile(join(dir, 'reports', turn.comparison.report), 'utf8');
  assert.match(html, /Claude 的回答更好/);
  assert.match(html, /<strong>综合答案<\/strong>/);

  const types = events.map((e) => e.type);
  for (const t of ['snapshot', 'status', 'delta', 'answer', 'compare-start', 'compare', 'meta', 'end']) assert.ok(types.includes(t), `缺少事件 ${t}`);
  assert.ok(codex.calls[0].prompt.startsWith('【说明】'), 'codex 新会话把说明写进 prompt');
  assert.ok(claude.calls.find((c) => !c.schema).systemPrompt, 'claude 走系统提示');
});

test('第二轮：Claude 续接会话，只补它没看到的那一轮', async () => {
  const claude = fakeProvider('claude');
  const codex = fakeProvider('codex');
  const { jobs, waitEnd } = setup({ claude, codex });
  const conv = await store.create();

  await waitEnd((await jobs.ask({ convId: conv.id, question: '第一问', mode: 'claude' })).turnId);
  const firstSession = store.get(conv.id).sessions.claude.id;
  await waitEnd((await jobs.ask({ convId: conv.id, question: '第二问', mode: 'codex' })).turnId);
  await waitEnd((await jobs.ask({ convId: conv.id, question: '第三问', mode: 'claude' })).turnId);

  const third = claude.calls.filter((c) => !c.schema).at(-1);
  assert.equal(third.sessionId, firstSession);
  assert.ok(third.prompt.includes('第二问'));
  assert.ok(third.prompt.includes('codex 的回答'));
  assert.ok(!third.prompt.includes('第一问'));
  assert.equal(store.get(conv.id).sessions.claude.seenTurns, 3);
});

test('一方失败：另一方照常保存，跳过对比，状态 partial', async () => {
  const { jobs, waitEnd } = setup({ claude: fakeProvider('claude'), codex: fakeProvider('codex', { fail: true }) });
  const conv = await store.create();
  const end = await waitEnd((await jobs.ask({ convId: conv.id, question: '问', mode: 'both' })).turnId);
  assert.equal(end.status, 'partial');
  const turn = store.get(conv.id).turns[0];
  assert.equal(turn.answers.codex.status, 'error');
  assert.match(turn.answers.codex.error, /codex 坏了/);
  assert.equal(turn.comparison.status, 'skipped');
  assert.equal(store.get(conv.id).sessions.codex, undefined, '失败不记会话');
});

test('旧会话失效：自动开新会话重试，带上全部历史', async () => {
  const claude = fakeProvider('claude', { failStaleOnce: true });
  const { jobs, waitEnd } = setup({ claude, codex: fakeProvider('codex') });
  const conv = await store.create();
  await store.update(conv.id, (c) => ({
    ...c,
    sessions: { claude: { id: 'old', seenTurns: 1 } },
    turns: [{ id: 't_old1', createdAt: new Date().toISOString(), mode: 'claude', question: '很早的问题', status: 'done', answers: { claude: { status: 'done', text: '早答' } } }]
  }));
  const end = await waitEnd((await jobs.ask({ convId: conv.id, question: '新问题', mode: 'claude' })).turnId);
  assert.equal(end.status, 'done');
  const retry = claude.calls.at(-1);
  assert.equal(retry.sessionId, undefined);
  assert.ok(retry.prompt.includes('很早的问题'), '新会话补上全部历史');
});

test('停止：两个模型都被取消，状态 cancelled', async () => {
  const { jobs, waitEnd } = setup({ claude: fakeProvider('claude', { delay: 5000 }), codex: fakeProvider('codex', { delay: 5000 }) });
  const conv = await store.create();
  const { turnId } = await jobs.ask({ convId: conv.id, question: '慢问题', mode: 'both' });
  const ended = waitEnd(turnId);
  assert.equal(jobs.cancel(turnId), true);
  assert.equal((await ended).status, 'cancelled');
  const turn = store.get(conv.id).turns[0];
  assert.equal(turn.answers.claude.status, 'cancelled');
  assert.equal(turn.comparison.status, 'skipped');
});

test('同一段对话不能同时问两个问题；参数校验', async () => {
  const { jobs, waitEnd } = setup({ claude: fakeProvider('claude', { delay: 200 }), codex: fakeProvider('codex') });
  const conv = await store.create();
  const { turnId } = await jobs.ask({ convId: conv.id, question: '一', mode: 'claude' });
  await assert.rejects(jobs.ask({ convId: conv.id, question: '二', mode: 'claude' }), (e) => e.status === 409);
  await waitEnd(turnId);
  await assert.rejects(jobs.ask({ convId: conv.id, question: '  ', mode: 'claude' }), (e) => e.status === 400);
  await assert.rejects(jobs.ask({ convId: conv.id, question: '问', mode: 'gpt' }), (e) => e.status === 400);
  await assert.rejects(jobs.ask({ convId: 'c_nope_nope', question: '问', mode: 'claude' }), (e) => e.status === 404);
});

test('重新对比：换 Codex 当裁判', async () => {
  const claude = fakeProvider('claude');
  const codex = fakeProvider('codex');
  const { jobs, waitEnd } = setup({ claude, codex });
  const conv = await store.create();
  const { turnId } = await jobs.ask({ convId: conv.id, question: '问', mode: 'both' });
  await waitEnd(turnId);
  await jobs.recompare({ convId: conv.id, turnId, judge: 'codex' });
  const end = await waitEnd(turnId);
  assert.equal(end.status, 'done');
  assert.equal(store.get(conv.id).turns[0].comparison.judge, 'codex');
  assert.ok(codex.calls.some((c) => c.schema?.required?.includes('verdict')));
});

test('重启恢复：残留的 running 轮次标成中断', async () => {
  const { jobs } = setup({ claude: fakeProvider('claude'), codex: fakeProvider('codex') });
  const conv = await store.create();
  await store.update(conv.id, (c) => ({
    ...c,
    turns: [{ id: 't_x1', createdAt: new Date().toISOString(), mode: 'both', question: 'q', status: 'running', answers: { claude: { status: 'running', text: '' }, codex: { status: 'done', text: 'ok' } }, comparison: { status: 'pending' } }]
  }));
  assert.equal(await jobs.recoverInterrupted(), 1);
  const turn = store.get(conv.id).turns[0];
  assert.equal(turn.status, 'error');
  assert.equal(turn.answers.claude.status, 'error');
  assert.equal(turn.answers.codex.status, 'done');
  assert.equal(turn.comparison.status, 'error');
});

test('快照折叠：增量拼接、最终答案覆盖', () => {
  let s = { status: 'running', answers: { claude: { text: '' } }, comparison: null };
  s = applyToSnapshot(s, { type: 'delta', model: 'claude', text: '你' });
  s = applyToSnapshot(s, { type: 'delta', model: 'claude', text: '好' });
  assert.equal(s.answers.claude.text, '你好');
  s = applyToSnapshot(s, { type: 'answer', model: 'claude', answer: { status: 'done', text: '你好！' } });
  assert.equal(s.answers.claude.text, '你好！');
  assert.equal(s.answers.claude.status, 'done');
});
