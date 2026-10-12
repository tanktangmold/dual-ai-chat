import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, missedTurns, sessionAfter } from '../src/context.mjs';
import { assignSides, buildJudgePrompt, normalizeComparison, extractJson, COMPARE_SCHEMA, DIMENSIONS } from '../src/compare.mjs';

const done = (text) => ({ status: 'done', text });
const conv = {
  sessions: { claude: { id: 'cs', seenTurns: 1 } },
  turns: [
    { mode: 'claude', question: '问题一', status: 'done', answers: { claude: done('C1') } },
    { mode: 'codex', question: '问题二', status: 'done', answers: { codex: done('X2') } },
    { mode: 'codex', question: '问题三', status: 'done', answers: { codex: done('X3') } }
  ]
};

test('Claude 续接会话时只补它没看到的第 2、3 轮', () => {
  const missed = missedTurns(conv, 'claude');
  assert.deepEqual(missed.map((m) => m.index), [1, 2]);
  const prompt = buildPrompt({ conv, model: 'claude', question: '问题四' });
  assert.ok(prompt.includes('【第 2 轮 · 用户】\n问题二'));
  assert.ok(prompt.includes('【第 3 轮 · Codex 的回答】\nX3'));
  assert.ok(!prompt.includes('问题一'), '自己会话里已有的轮次不重复发');
  assert.ok(prompt.endsWith('问题四'));
});

test('没有会话的模型拿到全部历史；旧会话失效时 fresh 也补全部', () => {
  assert.equal(missedTurns(conv, 'codex').length, 3);
  assert.equal(missedTurns(conv, 'claude', { fresh: true }).length, 3);
});

test('第一问不带历史，codex 需要把说明写进 prompt', () => {
  const prompt = buildPrompt({ conv: { turns: [] }, model: 'codex', question: '你好', includeSystem: true });
  assert.ok(prompt.startsWith('【说明】'));
  assert.ok(prompt.endsWith('你好'));
  assert.ok(!prompt.includes('<history>'));
});

test('进行中的轮次不进历史', () => {
  const c = { turns: [{ question: 'q', status: 'running', answers: {} }] };
  assert.equal(missedTurns(c, 'claude').length, 0);
});

test('sessionAfter 记录看过的轮数', () => {
  assert.deepEqual(sessionAfter('s', 2), { id: 's', seenTurns: 3 });
});

test('匿名分配 A/B', () => {
  assert.deepEqual(assignSides(() => 0.1), { A: 'claude', B: 'codex' });
  assert.deepEqual(assignSides(() => 0.9), { A: 'codex', B: 'claude' });
});

test('裁判 prompt 按分配顺序放答案', () => {
  const p = buildJudgePrompt({ question: 'Q', answers: { claude: 'CL', codex: 'CX' }, sides: { A: 'codex', B: 'claude' } });
  assert.ok(p.indexOf('【回答A】\nCX') < p.indexOf('【回答B】\nCL'));
});

const judgeOutput = {
  verdict: '回答A 更全面',
  winner: 'A',
  winnerReason: '回答A 给了步骤',
  scores: { A: { accuracy: 9, completeness: 9, clarity: 8, practicality: 9, depth: 7 }, B: { accuracy: 8, completeness: 6, clarity: 12, practicality: 'x', depth: 6 } },
  consensus: ['都推荐 LTS'],
  differences: [{ aspect: '版本', A: '说 v24', B: '说 v22', better: 'A', note: '回答B 过时' }],
  strengths: { A: ['步骤清楚'], B: ['简短'] },
  weaknesses: { A: ['略长'], B: ['信息过时'] },
  issues: [{ answer: 'B', problem: 'v22 已不是最新', severity: '中' }, { answer: 'C', problem: '无效', severity: '高' }],
  bestAnswer: '用 v24',
  recommendation: '采纳回答A'
};

test('归一化：A/B 映射回模型名，分数夹到 1-10，文字里的「回答A」换成模型名', () => {
  const sides = { A: 'codex', B: 'claude' };
  const r = normalizeComparison(judgeOutput, sides);
  assert.equal(r.winner, 'codex');
  assert.equal(r.verdict, 'Codex 更全面');
  assert.equal(r.scores.claude.clarity, 10);
  assert.equal(r.scores.claude.practicality, 5, '非数字给中间分');
  assert.equal(r.totals.codex, 42);
  assert.equal(r.differences[0].codex, '说 v24');
  assert.equal(r.differences[0].claude, '说 v22');
  assert.equal(r.differences[0].better, 'codex');
  assert.equal(r.differences[0].note, 'Claude 过时');
  assert.deepEqual(r.weaknesses.claude, ['信息过时']);
  assert.equal(r.issues.length, 1, '无效的 answer 被丢弃');
  assert.equal(r.issues[0].model, 'claude');
  assert.equal(r.recommendation, '采纳Codex');
});

test('归一化：结构不对返回 null', () => {
  assert.equal(normalizeComparison('不是 JSON', { A: 'claude', B: 'codex' }), null);
  assert.equal(normalizeComparison({ verdict: 'x' }, { A: 'claude', B: 'codex' }), null);
});

test('extractJson 兜底：代码块和前后废话', () => {
  assert.deepEqual(extractJson('结果如下：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的 {"a":2} 完毕'), { a: 2 });
  assert.equal(extractJson('完全没有'), null);
});

test('schema 满足严格模式：每层 required 覆盖全部字段', () => {
  const walk = (node) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      Object.values(node.properties).forEach(walk);
    }
    if (node.type === 'array') walk(node.items);
  };
  walk(COMPARE_SCHEMA);
  assert.equal(DIMENSIONS.length, 5);
});

test('裁判提示词要求胜者和总分一致（避免「Codex 胜」却分数更低）', () => {
  for (const lang of ['zh', 'ja', 'en']) {
    const p = buildJudgePrompt({ question: 'Q', answers: { claude: 'C', codex: 'X' }, sides: { A: 'claude', B: 'codex' }, lang });
    assert.match(p, /tie/);
    assert.match(p, lang === 'en' ? /higher total score/ : lang === 'ja' ? /合計点が高い方/ : /总分更高的一方/);
  }
});
