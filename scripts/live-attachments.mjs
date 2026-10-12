/**
 * 真实联调（附件 + 日语）：对正在运行的服务上传 截图 / PDF / Excel，用日语「两个都问」，
 * 检查两边都读懂了图片和文件内容、报告是日语。会花订阅额度（约 4 次调用），跑完删掉测试对话。
 *   node scripts/live-attachments.mjs <截图.png> <見積書.pdf> <売上.xlsx> [--keep]
 * 期望：截图里的应用名「双AI对话台」、PDF 合计 331,200 円、Excel 9 月売上 1,234,567。
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE = `http://127.0.0.1:${process.env.DUAL_CHAT_PORT ?? 8796}`;
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

async function call(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-Dual-Chat': '1', 'X-Lang': 'ja', ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path} → ${json.error}`);
  return json.data;
}

async function main() {
  const started = Date.now();
  const ids = [];
  for (const file of files) {
    const meta = await call('POST', '/api/uploads', await readFile(file), { 'X-File-Name': encodeURIComponent(basename(file)) });
    console.log(`上传 ${meta.name}：${meta.kind}，提取 ${meta.textChars} 字`);
    ids.push(meta.id);
  }
  const conv = await call('POST', '/api/conversations', {});
  const { turnId } = await call('POST', `/api/conversations/${conv.id}/ask`, {
    question: '添付を見て答えてください：1) スクリーンショット左上のアプリ名は？ 2) 見積書の合計金額は？ 3) 売上表の9月の売上は？ 3行で。',
    mode: 'both', web: false, lang: 'ja', attachments: ids
  });

  for (;;) {
    const c = await call('GET', `/api/conversations/${conv.id}`);
    if (!c.activeTurns.includes(turnId)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const saved = await call('GET', `/api/conversations/${conv.id}`);
  const turn = saved.turns[0];
  let failures = 0;
  for (const m of ['claude', 'codex']) {
    const a = turn.answers[m];
    const text = (a.text ?? '').replace(/\s+/g, ' ');
    const ok = a.status === 'done' && /双AI对话台/.test(text) && /331,?200/.test(text) && /1,?234,?567/.test(text);
    if (!ok) failures += 1;
    console.log(`${ok ? '✓' : '✗'} ${m}（${(a.durationMs / 1000).toFixed(1)}s）：${text.slice(0, 220)}${a.error ? ` 错误：${a.error}` : ''}`);
  }
  const cmp = turn.comparison;
  console.log(`对比：${cmp.status}${cmp.data ? ` ${cmp.data.totals.claude}:${cmp.data.totals.codex} ${cmp.data.verdict}` : ` ${cmp.error ?? ''}`}`);
  if (cmp.status === 'done') {
    const html = await (await fetch(`${BASE}/reports/${cmp.report}`)).text();
    const ja = html.includes('<html lang="ja">') && html.includes('5項目の評価');
    if (!ja) failures += 1;
    console.log(`${ja ? '✓' : '✗'} 报告是日语：${BASE}/reports/${cmp.report}`);
  } else failures += 1;
  console.log(`标题「${saved.title}」话题「${saved.topic}」，总用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
  if (!process.argv.includes('--keep')) await call('DELETE', `/api/conversations/${conv.id}`);
  console.log(failures ? `✗ ${failures} 项未通过` : '✓ 全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
