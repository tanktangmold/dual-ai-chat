import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, summarize } from '../src/store.mjs';

const quiet = { warn() {}, error() {} };
let dir;
let store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dual-chat-store-'));
  store = createStore({ dir, log: quiet });
  await store.load();
});

const turn = (question, createdAt, extra = {}) => ({
  id: `t_${Math.random().toString(16).slice(2, 8)}`,
  createdAt,
  mode: 'both',
  question,
  status: 'done',
  answers: { claude: { text: `Claude 答：${question}` }, codex: { text: `Codex 答：${question}` } },
  ...extra
});

test('新建对话会落盘，重新加载后还在', async () => {
  const conv = await store.create({ title: '第一段', topic: '编程' });
  await store.flush();
  const again = createStore({ dir, log: quiet });
  assert.equal(await again.load(), 1);
  assert.equal(again.get(conv.id).title, '第一段');
  assert.equal(again.get(conv.id).topic, '编程');
});

test('update 不改动旧对象（不可变）', async () => {
  const conv = await store.create({ title: '原标题' });
  const before = store.get(conv.id);
  const after = await store.update(conv.id, (c) => ({ ...c, title: '新标题' }));
  assert.equal(before.title, '原标题');
  assert.equal(after.title, '新标题');
  assert.equal(store.get(conv.id).title, '新标题');
});

test('并发更新按顺序落盘，文件里是最后的状态', async () => {
  const conv = await store.create();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.update(conv.id, (c) => ({ ...c, turns: [...c.turns, turn(`问${i}`, new Date().toISOString())] })))
  );
  await store.flush();
  const onDisk = JSON.parse(await readFile(join(dir, 'conversations', `${conv.id}.json`), 'utf8'));
  assert.equal(onDisk.turns.length, 8);
});

test('列表按最近活动排序，摘要里带日期和模式', async () => {
  const a = await store.create({ title: 'A', now: new Date('2026-10-01T09:00:00') });
  const b = await store.create({ title: 'B', now: new Date('2026-10-02T09:00:00') });
  await store.update(a.id, (c) => ({ ...c, turns: [turn('老问题', '2026-10-01T09:00:00'), turn('新问题', '2026-10-03T10:00:00', { mode: 'claude' })] }));
  const list = store.list();
  assert.deepEqual(list.map((x) => x.title), ['A', 'B']);
  assert.deepEqual(list[0].days, ['2026-10-01', '2026-10-03']);
  assert.deepEqual(list[0].modes.sort(), ['both', 'claude']);
  assert.equal(list[0].lastQuestion, '新问题');
  assert.equal(b.turns.length, 0);
});

test('按关键词搜索问题和回答，返回片段', async () => {
  const conv = await store.create({ title: '杂谈' });
  await store.update(conv.id, (c) => ({ ...c, turns: [turn('楽天商品的 SEO 标题怎么写', new Date().toISOString())] }));
  const hits = store.search('seo');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /SEO/);
  assert.deepEqual(store.search('完全不存在的词'), []);
});

test('话题统计', async () => {
  await store.create({ topic: '编程' });
  await store.create({ topic: '编程' });
  await store.create({ topic: '电商' });
  assert.deepEqual(store.topics(), [{ name: '编程', count: 2 }, { name: '电商', count: 1 }]);
});

test('删除 = 挪到回收站', async () => {
  const conv = await store.create();
  await store.flush();
  await store.remove(conv.id);
  assert.equal(store.get(conv.id), null);
  assert.deepEqual(await readdir(join(dir, 'trash')), [`${conv.id}.json`]);
});

test('非法 ID 被拒绝（防路径穿越）', () => {
  assert.throws(() => store.get('../../etc/passwd'), /不合法/);
});

test('标题和话题会被截断，空值有默认', async () => {
  const conv = await store.create({ title: '   ', topic: 'x'.repeat(50) });
  assert.equal(conv.title, '新对话');
  assert.equal(conv.topic.length, 20);
});

test('summarize 标记进行中的对话', () => {
  const s = summarize({ id: 'c_x', title: 't', topic: 'p', createdAt: '', updatedAt: '', turns: [{ createdAt: '2026-10-11T00:00:00Z', mode: 'both', question: 'q', status: 'running' }] });
  assert.equal(s.running, true);
});

test('损坏的文件被跳过', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'conversations', 'c_broken.json'), '{坏掉的');
  const again = createStore({ dir, log: quiet });
  assert.equal(await again.load(), 0);
});
