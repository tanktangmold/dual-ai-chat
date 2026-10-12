import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoBackend, shiftDates, chunkText, buildSamples } from '../demo/backend.mjs';
import { t } from '../src/i18n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = JSON.parse(readFileSync(join(ROOT, 'demo', 'data.json'), 'utf8'));
const NOW = Date.parse('2027-03-15T10:00:00Z');

/** 假定时器：run() 按时间顺序执行全部排队的回调。 */
function fakeClock() {
  let queue = [];
  let id = 0;
  return {
    schedule: (fn, ms) => { queue.push({ id: (id += 1), fn, ms }); return id; },
    cancelTimer: (tid) => { queue = queue.filter((q) => q.id !== tid); },
    run() {
      while (queue.length) {
        queue.sort((a, b) => a.ms - b.ms || a.id - b.id);
        const next = queue.shift();
        next.fn();
      }
    },
    pending: () => queue.length
  };
}

const backend = (clock = fakeClock()) => ({ clock, api: createDemoBackend({ data: DATA, t, now: () => NOW, schedule: clock.schedule, cancelTimer: clock.cancelTimer }) });

test('演示数据：每段对话都有报告和语言，至少覆盖中日英', () => {
  const langs = new Set(DATA.conversations.map((c) => c.turns[0].lang));
  for (const l of ['zh', 'ja', 'en']) assert.ok(langs.has(l), `缺少 ${l} 演示`);
  for (const c of DATA.conversations) assert.equal(c.sessions, undefined, '不能带 CLI 会话 ID');
  assert.ok(DATA.conversations.some((c) => c.turns.some((x) => x.attachments?.length)), '要有带附件的演示');
  assert.ok(DATA.conversations.some((c) => c.turns.length > 1), '要有多轮（展示记忆）的演示');
});

test('日期平移到最近几天：最新一段是今天，日历当月有点', () => {
  const shifted = shiftDates(DATA.conversations, NOW);
  assert.ok(NOW - Date.parse(shifted[0].updatedAt) < 3600_000);
  assert.ok(shifted.every((c) => Date.parse(c.updatedAt) <= NOW));
  assert.ok(shifted.every((c) => c.turns.every((x) => Date.parse(x.createdAt) <= Date.parse(c.updatedAt) + 1000)));
});

test('列表、详情、搜索、话题', () => {
  const { api } = backend();
  const list = api.handle('GET', '/dual-ai-chat/api/conversations').data;
  assert.equal(list.items.length, DATA.conversations.length);
  assert.ok(list.topics.length >= 3);
  const id = list.items[0].id;
  assert.equal(api.handle('GET', `/api/conversations/${id}`).data.id, id);
  assert.ok(api.handle('GET', `/api/search?q=${encodeURIComponent('Python')}`).data.items.length >= 1);
  assert.equal(api.handle('GET', '/api/conversations/nope').status, 404);
});

test('问示例问题：完整回放事件，结束后对话里有答案、对比和自动标题', () => {
  const { api, clock } = backend();
  const sample = api.samples.find((s) => s.mode === 'both' && s.lang === 'en');
  const conv = api.handle('POST', '/api/conversations', {}, { lang: 'en' }).data;
  const res = api.handle('POST', `/api/conversations/${conv.id}/ask`, { question: `  ${sample.question} `, mode: 'both', lang: 'en' });
  assert.ok(res.ok);
  const events = [];
  api.subscribe(res.data.turnId, (e) => events.push(e));
  assert.equal(api.handle('GET', `/api/conversations/${conv.id}`).data.activeTurns.length, 1);
  clock.run();

  const types = events.map((e) => e.type);
  assert.equal(types[0], 'snapshot');
  assert.equal(types.at(-1), 'end');
  for (const ty of ['status', 'delta', 'answer', 'meta', 'compare-start', 'compare']) assert.ok(types.includes(ty), `缺少 ${ty}`);
  const claudeText = events.filter((e) => e.type === 'delta' && e.model === 'claude').map((e) => e.text).join('');
  assert.equal(claudeText, sample.turn.answers.claude.text, 'Claude 逐字回放拼起来和录制一致');
  assert.equal(events.filter((e) => e.type === 'delta' && e.model === 'codex').length, 1, 'Codex 整段到达');
  assert.ok(types.indexOf('compare') > types.lastIndexOf('answer'));

  const after = api.handle('GET', `/api/conversations/${conv.id}`).data;
  assert.equal(after.title, sample.title);
  assert.equal(after.turns[0].status, 'done');
  assert.equal(after.turns[0].comparison.status, 'done');
  assert.equal(after.turns[0].comparison.report, sample.turn.comparison.report);
  assert.deepEqual(after.activeTurns, []);
});

test('只问 Claude：不回放 Codex，也没有对比', () => {
  const { api, clock } = backend();
  const sample = api.samples.find((s) => s.mode === 'both');
  const conv = api.handle('POST', '/api/conversations', {}).data;
  const res = api.handle('POST', `/api/conversations/${conv.id}/ask`, { question: sample.question, mode: 'claude' });
  const events = [];
  api.subscribe(res.data.turnId, (e) => events.push(e));
  clock.run();
  assert.ok(!events.some((e) => e.model === 'codex'));
  assert.ok(!events.some((e) => e.type === 'compare'));
  assert.equal(res.data.turn.mode, 'claude');
});

test('停止：剩下的定时器取消，状态为 cancelled', () => {
  const { api, clock } = backend();
  const sample = api.samples.find((s) => s.mode === 'both');
  const conv = api.handle('POST', '/api/conversations', {}).data;
  const { turnId } = api.handle('POST', `/api/conversations/${conv.id}/ask`, { question: sample.question, mode: 'both' }).data;
  const events = [];
  api.subscribe(turnId, (e) => events.push(e));
  assert.ok(clock.pending() > 0);
  assert.equal(api.handle('POST', `/api/jobs/${turnId}/cancel`).data.cancelled, true);
  clock.run();
  assert.equal(events.at(-1).status, 'cancelled');
  assert.equal(api.handle('GET', `/api/conversations/${conv.id}`).data.turns[0].status, 'cancelled');
});

test('自由提问、上传、换裁判：给出「请下载安装」的提示（按语言）', () => {
  const { api } = backend();
  const conv = api.handle('POST', '/api/conversations', {}).data;
  const free = api.handle('POST', `/api/conversations/${conv.id}/ask`, { question: '随便问一个', mode: 'both', lang: 'zh' });
  assert.equal(free.status, 400);
  assert.match(free.error, /示例问题/);
  assert.match(api.handle('POST', '/api/uploads', {}, { lang: 'ja' }).error, /インストール/);
  assert.match(api.handle('POST', `/api/conversations/${conv.id}/turns/x/compare`, {}, { lang: 'en' }).error, /installed app/);
});

test('首次打开按语言挑一段对话；示例问题来自每段对话的第一问', () => {
  const { api } = backend();
  const zh = api.landingConversation('zh');
  assert.equal(api.handle('GET', `/api/conversations/${zh}`).data.turns[0].lang, 'zh');
  assert.equal(buildSamples(DATA.conversations).length, DATA.conversations.length);
});

test('chunkText 按字符切，中文也均匀、拼回原文', () => {
  const s = '通货膨胀就是东西慢慢变贵了'.repeat(5);
  const parts = chunkText(s, 7);
  assert.equal(parts.join(''), s);
  assert.ok(parts.length <= 7);
});
