import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createStore } from '../src/store.mjs';
import { createJobs } from '../src/jobs.mjs';
import { createApp } from '../src/app.mjs';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings.mjs';

const quiet = { warn() {}, error() {}, info() {} };
const JUDGE = {
  verdict: '回答A 好', winner: 'A', winnerReason: 'r',
  scores: { A: { accuracy: 8, completeness: 8, clarity: 8, practicality: 8, depth: 8 }, B: { accuracy: 6, completeness: 6, clarity: 6, practicality: 6, depth: 6 } },
  consensus: ['c'], differences: [{ aspect: 'x', A: 'a', B: 'b', better: 'A', note: 'n' }], strengths: { A: ['s'], B: ['s'] }, weaknesses: { A: [], B: [] },
  issues: [], bestAnswer: '<script>alert(1)</script> 最佳', recommendation: 'ok'
};
const fake = (kind) => ({
  kind,
  supportsSystemPrompt: kind === 'claude',
  async run(o) {
    await new Promise((r) => setTimeout(r, 10));
    if (o.schema?.required?.includes('verdict')) return { text: '', structured: JUDGE };
    if (o.schema) return { text: '', structured: { title: '测试标题', topic: '测试' } };
    o.onEvent?.({ type: 'delta', text: `${kind}:` });
    return { text: `${kind} 答 <b>粗</b>`, sessionId: `${kind}-s` };
  }
});

let server;
let port;
let settings = DEFAULT_SETTINGS;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dual-chat-app-'));
  const store = createStore({ dir, log: quiet });
  await store.load();
  const reportsDir = join(dir, 'reports');
  const jobs = createJobs({ store, providers: { claude: fake('claude'), codex: fake('codex') }, getSettings: () => settings, reportsDir, log: quiet });
  server = createApp({
    store, jobs, reportsDir, log: quiet,
    settings: { get: () => settings, update: async (b) => { settings = mergeSettings(settings, b); return settings; } },
    health: () => ({ claude: { found: true }, codex: { found: true } }),
    testModel: async () => ({ ok: true, ms: 1, text: '正常' })
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

function call(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-Dual-Chat': '1' }), ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function events(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      const list = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) if (p.startsWith('data: ')) list.push(JSON.parse(p.slice(6)));
      });
      res.on('end', () => resolve(list));
    });
    req.on('error', reject);
    req.end();
  });
}

test('首页和静态资源可以访问，带 CSP', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await call('GET', '/markdown.mjs')).status, 200);
  assert.equal((await call('GET', '/../server.mjs')).status, 404);
});

test('安全：外部 Host、缺少标记、跨站 Origin 都被拒绝', async () => {
  assert.equal((await call('GET', '/api/conversations', { headers: { Host: 'evil.com' } })).status, 403);
  assert.equal((await call('POST', '/api/conversations', { body: {}, headers: { 'X-Dual-Chat': '' } })).status, 403);
  assert.equal((await call('POST', '/api/conversations', { body: {}, headers: { Origin: 'https://evil.com' } })).status, 403);
  assert.equal((await call('POST', '/api/conversations', { body: {}, headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
});

test('完整流程：新建 → 两个都问 → SSE 推送 → 报告可打开且已转义 → 改话题 → 搜索 → 删除', async () => {
  const created = await call('POST', '/api/conversations', { body: {} });
  const id = created.json.data.id;
  const asked = await call('POST', `/api/conversations/${id}/ask`, { body: { question: '测试问题', mode: 'both', web: false } });
  assert.equal(asked.status, 200);
  const { turnId } = asked.json.data;

  const list = await events(`/api/jobs/${turnId}/events`);
  const types = list.map((e) => e.type);
  assert.equal(types[0], 'snapshot');
  assert.equal(types.at(-1), 'end');
  assert.ok(types.includes('compare'));

  const conv = (await call('GET', `/api/conversations/${id}`)).json.data;
  assert.equal(conv.title, '测试标题');
  const report = conv.turns[0].comparison.report;
  const page = await call('GET', `/reports/${report}`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.ok(!page.text.includes('<script>alert(1)</script>'), '模型输出里的脚本被转义');
  assert.ok(page.text.includes('&lt;b&gt;粗&lt;/b&gt;'), '原始回答里的 HTML 标签被转义');

  const patched = await call('PATCH', `/api/conversations/${id}`, { body: { topic: '新话题' } });
  assert.equal(patched.json.data.topic, '新话题');
  assert.equal(patched.json.data.titleAuto, false);

  const found = await call('GET', `/api/search?q=${encodeURIComponent('测试问题')}`);
  assert.equal(found.json.data.items.length, 1);

  const listed = await call('GET', '/api/conversations');
  assert.ok(listed.json.data.topics.some((t) => t.name === '新话题' && t.count === 1));

  assert.equal((await call('DELETE', `/api/conversations/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/conversations/${id}`)).status, 404);
});

test('参数校验与错误格式', async () => {
  const bad = await call('GET', '/api/conversations/..%2F..%2Fetc');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.success, false);
  assert.ok(bad.json.error);
  assert.equal((await call('GET', '/reports/2026-10-12/..%2Fsecret.html')).status, 404);
  assert.equal((await call('PUT', '/api/settings', { body: { judge: 'gpt' } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { body: { codex: { model: 'a b; rm' } } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { body: { judge: 'codex' } })).json.data.judge, 'codex');
  assert.equal((await call('GET', '/api/jobs/t_none_x/events')).text.includes('"gone"'), true);
});
