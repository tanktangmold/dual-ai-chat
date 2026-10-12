import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createStore } from '../src/store.mjs';
import { createJobs } from '../src/jobs.mjs';
import { createApp } from '../src/app.mjs';
import { createUploads } from '../src/uploads.mjs';
import { DEFAULT_SETTINGS } from '../src/settings.mjs';

const quiet = { warn() {}, error() {}, info() {} };
const calls = [];
const score = { accuracy: 8, completeness: 8, clarity: 8, practicality: 8, depth: 8 };
const JUDGE = {
  verdict: '回答A が良い', winner: 'A', winnerReason: 'r', scores: { A: score, B: score }, consensus: ['c'], differences: [],
  strengths: { A: [], B: [] }, weaknesses: { A: [], B: [] }, issues: [], bestAnswer: 'ベスト', recommendation: 'ok'
};
const fake = (kind) => ({
  kind,
  supportsSystemPrompt: kind === 'claude',
  async run(o) {
    calls.push({ kind, ...o });
    await new Promise((r) => setTimeout(r, 10));
    if (o.schema?.required?.includes('verdict')) return { text: '', structured: JUDGE };
    if (o.schema) return { text: '', structured: { title: '見積書の確認', topic: 'EC運営' } };
    return { text: `${kind} OK`, sessionId: `${kind}-s` };
  }
});

let server;
let port;
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dual-chat-upapp-'));
  const store = createStore({ dir: root, log: quiet });
  await store.load();
  const uploads = createUploads({ root: join(root, 'workspace'), log: quiet, extract: async () => ({ text: '合計金額：331,200 円', pages: 1, images: [] }) });
  const jobs = createJobs({ store, uploads, providers: { claude: fake('claude'), codex: fake('codex') }, getSettings: () => DEFAULT_SETTINGS, reportsDir: join(root, 'reports'), log: quiet });
  server = createApp({
    store, jobs, uploads, reportsDir: join(root, 'reports'), log: quiet,
    settings: { get: () => DEFAULT_SETTINGS, update: async () => DEFAULT_SETTINGS },
    health: () => ({}), testModel: async () => ({})
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

function call(method, path, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { Host: `127.0.0.1:${port}`, 'X-Dual-Chat': '1', ...(raw ? {} : { 'Content-Type': 'application/json' }), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* 二进制 */ }
        resolve({ status: res.statusCode, headers: res.headers, json, buf });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const waitIdle = async (id) => {
  for (let i = 0; i < 100; i += 1) {
    const conv = (await call('GET', `/api/conversations/${id}`)).json.data;
    if (!conv.activeTurns.length) return conv;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等不到任务结束');
};

test('上传图片和 PDF → 只发附件不写问题 → 两边都拿到附件、日语回答设置生效', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const img = await call('POST', '/api/uploads', { raw: png, headers: { 'X-File-Name': encodeURIComponent('スクリーンショット.png'), 'Content-Type': 'image/png' } });
  assert.equal(img.status, 200);
  assert.equal(img.json.data.kind, 'image');
  const pdf = await call('POST', '/api/uploads', { raw: Buffer.from('%PDF-1.4'), headers: { 'X-File-Name': encodeURIComponent('見積書.pdf') } });
  assert.equal(pdf.json.data.textChars > 0, true);

  const served = await call('GET', `/uploads/${img.json.data.id}/whatever.png`);
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'image/png');
  assert.match(served.headers['content-security-policy'], /sandbox/);
  assert.deepEqual(served.buf, png);

  const conv = (await call('POST', '/api/conversations', { body: {}, headers: { 'X-Lang': 'ja' } })).json.data;
  assert.equal(conv.title, '新しい会話');
  const asked = await call('POST', `/api/conversations/${conv.id}/ask`, { body: { question: '', mode: 'both', lang: 'ja', attachments: [img.json.data.id, pdf.json.data.id] } });
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.equal(asked.json.data.turn.question, '添付ファイルを確認して、主な内容を教えてください。');
  const done = await waitIdle(conv.id);
  assert.equal(done.turns[0].attachments.length, 2);
  assert.equal(done.turns[0].lang, 'ja');

  const claude = calls.find((c) => c.kind === 'claude' && !c.schema);
  const codex = calls.find((c) => c.kind === 'codex' && !c.schema);
  assert.equal(claude.readFiles, true);
  assert.match(claude.prompt, /Read ツールで確認してください/);
  assert.match(claude.prompt, /合計金額：331,200 円/);
  assert.match(claude.systemPrompt, /日本語で回答/);
  assert.equal(codex.images.length, 1);
  assert.match(codex.prompt, /このメッセージに添付済み/);
  assert.ok(codex.prompt.startsWith('【前提】'));

  const judge = calls.find((c) => c.schema?.required?.includes('verdict'));
  assert.ok(judge, '裁判被调用');
  assert.equal(done.turns[0].comparison.status, 'done');
  assert.equal(judge.readFiles, true, '裁判也能看附件');
  assert.equal(judge.lang, 'ja');
  const report = await readFile(join(root, 'reports', done.turns[0].comparison.report), 'utf8');
  assert.match(report, /<html lang="ja">/);
  assert.match(report, /添付：スクリーンショット.png、見積書.pdf/);
  assert.match(report, /5項目の評価/);
  assert.equal(done.title, '見積書の確認');
});

test('上传校验：不支持的类型 415、错误提示按 X-Lang 翻译、附件 ID 不存在 400', async () => {
  const exe = await call('POST', '/api/uploads', { raw: Buffer.from('MZ'), headers: { 'X-File-Name': 'a.exe', 'X-Lang': 'ja' } });
  assert.equal(exe.status, 415);
  assert.match(exe.json.error, /未対応の形式/);
  const zh = await call('POST', '/api/uploads', { raw: Buffer.from('MZ'), headers: { 'X-File-Name': 'a.exe' } });
  assert.match(zh.json.error, /不支持/);
  const conv = (await call('POST', '/api/conversations', { body: {} })).json.data;
  const bad = await call('POST', `/api/conversations/${conv.id}/ask`, { body: { question: 'q', mode: 'claude', attachments: ['u_20260101-000000_abcdef'] } });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/uploads/u_20260101-000000_abcdef/x.png')).status, 404);
  assert.equal((await call('GET', '/uploads/..%2F..%2Fsecret/x')).status, 404);
});

test('主页面禁止被别的网站嵌入', async () => {
  const res = await call('GET', '/');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal((await call('GET', '/i18n.mjs')).status, 200);
  assert.equal((await call('GET', '/attachments.js')).status, 200);
  assert.equal((await call('GET', '/settings.js')).status, 200);
});
