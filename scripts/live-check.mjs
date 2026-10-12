/**
 * 真实联调：对正在运行的服务（默认 127.0.0.1:8796）用真的 Claude / Codex 跑一遍。
 *   npm run test:live
 * 第 1 轮「两个都问」→ 等对比报告；第 2 轮只问 Claude、第 3 轮只问 Codex，检查多轮记忆。
 * 会花订阅额度（约 5 次调用），跑完会把测试对话删掉。
 */
const BASE = `http://127.0.0.1:${process.env.DUAL_CHAT_PORT ?? 8796}`;
const HEADERS = { 'Content-Type': 'application/json', 'X-Dual-Chat': '1' };

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!json.success) throw new Error(`${method} ${path} → ${json.error}`);
  return json.data;
}

async function follow(turnId) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/jobs/${turnId}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const seen = new Set();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const ev = JSON.parse(part.slice(6));
      const t = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      if (ev.type === 'delta' && !seen.has(ev.model)) {
        seen.add(ev.model);
        console.log(`  ${t} ${ev.model} 开始输出`);
      } else if (ev.type === 'status') console.log(`  ${t} ${ev.model} ${ev.text}`);
      else if (ev.type === 'answer') console.log(`  ${t} ${ev.model} ${ev.answer.status}${ev.answer.error ? `：${ev.answer.error}` : ''}`);
      else if (ev.type === 'compare-start') console.log(`  ${t} 开始对比（裁判 ${ev.judge}）`);
      else if (ev.type === 'compare') console.log(`  ${t} 对比 ${ev.comparison.status}${ev.comparison.error ? `：${ev.comparison.error}` : ''}`);
      else if (ev.type === 'meta') console.log(`  ${t} 自动标题「${ev.title}」话题「${ev.topic}」`);
      else if (ev.type === 'end') {
        console.log(`  ${t} 结束：${ev.status}`);
        return ev.status;
      }
    }
  }
  return 'closed';
}

async function main() {
  const conv = await api('POST', '/api/conversations', {});
  console.log(`对话 ${conv.id}`);
  let failures = 0;

  console.log('第 1 轮（两个都问，不联网）');
  const t1 = await api('POST', `/api/conversations/${conv.id}/ask`, {
    question: '我的幸运数字是 37。请用三条要点说明：小团队做内部工具，选 SQLite 还是 PostgreSQL？',
    mode: 'both',
    web: false
  });
  if ((await follow(t1.turnId)) !== 'done') failures += 1;

  let saved = await api('GET', `/api/conversations/${conv.id}`);
  const cmp = saved.turns[0].comparison;
  if (cmp?.status === 'done') {
    console.log(`  报告：${BASE}/reports/${cmp.report}`);
    console.log(`  结论：${cmp.data.verdict}（Claude ${cmp.data.totals.claude} : Codex ${cmp.data.totals.codex}）`);
  } else failures += 1;

  console.log('第 2 轮（只问 Claude，检查记忆）');
  const t2 = await api('POST', `/api/conversations/${conv.id}/ask`, { question: '我的幸运数字是多少？只回答数字。', mode: 'claude', web: false });
  await follow(t2.turnId);
  console.log('第 3 轮（只问 Codex，它要从补给它的前文里知道第 2 轮发生了什么）');
  const t3 = await api('POST', `/api/conversations/${conv.id}/ask`, { question: '刚才另一个助手回答我的幸运数字是多少？只回答数字。', mode: 'codex', web: false });
  await follow(t3.turnId);

  saved = await api('GET', `/api/conversations/${conv.id}`);
  const a2 = saved.turns[1].answers.claude.text;
  const a3 = saved.turns[2].answers.codex.text;
  console.log(`  Claude 第 2 轮：${a2.trim()}  | Codex 第 3 轮：${a3.trim()}`);
  if (!a2.includes('37')) failures += 1;
  if (!a3.includes('37')) failures += 1;
  console.log(`  会话：${JSON.stringify(saved.sessions)}`);

  if (!process.argv.includes('--keep')) await api('DELETE', `/api/conversations/${conv.id}`);
  console.log(failures ? `✗ ${failures} 项未通过` : '✓ 全部通过');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
