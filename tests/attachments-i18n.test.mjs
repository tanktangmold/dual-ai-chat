import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, dictionaryKeys, normalizeLang, detectLang, dateVars } from '../src/i18n.mjs';
import { classify, safeFileName, decodeText, createUploads, UPLOAD_ID_RE } from '../src/uploads.mjs';
import { attachmentSection, buildPrompt } from '../src/context.mjs';
import { buildClaudeArgs } from '../src/providers/claude.mjs';
import { buildCodexArgs } from '../src/providers/codex.mjs';
import { humanizeError } from '../src/providers/errors.mjs';
import { buildJudgePrompt } from '../src/compare.mjs';
import { buildTopicPrompt } from '../src/topic.mjs';

test('i18n：中日英词条一一对应，变量替换，缺词回退', () => {
  assert.deepEqual(dictionaryKeys('ja').sort(), dictionaryKeys('zh').sort());
  assert.deepEqual(dictionaryKeys('en').sort(), dictionaryKeys('zh').sort());
  assert.equal(t('ja', 'turn.meta', { n: 3, time: '10:00' }), '第3回 · 10:00');
  assert.equal(t('zh', 'turn.meta', { n: 3, time: '10:00' }), '第 3 轮 · 10:00');
  assert.equal(t('en', 'turn.meta', { n: 3, time: '10:00' }), 'Turn 3 · 10:00');
  assert.equal(t('ja', 'no.such.key'), 'no.such.key');
  assert.equal(normalizeLang('ja-JP'), 'ja');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang(''), 'zh', '没带语言的请求按中文（兼容旧行为）');
  assert.equal(detectLang('en-GB'), 'en');
  assert.equal(detectLang('zh-CN'), 'zh');
  assert.equal(detectLang('fr-FR'), 'en', '其他语言的浏览器默认英文');
});

test('i18n：英文日期用月份名', () => {
  assert.equal(t('en', 'day.format', { ...dateVars(2026, 10, 12), w: 'Mon' }), 'Mon, Oct 12');
  assert.equal(t('en', 'cal.month', dateVars(2026, 10, 1)), 'October 2026');
  assert.equal(t('zh', 'cal.month', dateVars(2026, 10, 1)), '2026年10月');
  assert.equal(t('en', 'top.meta', { ...dateVars(2026, 10, 12), n: 2 }), 'Started Oct 12 · turns: 2');
});

test('i18n：各语言的占位符和中文一致（英文日期可以用 {mon}/{monLong} 代替 {m}）', () => {
  const vars = (s) => new Set(s.match(/\{\w+\}/g) ?? []);
  for (const lang of ['ja', 'en']) {
    for (const key of dictionaryKeys('zh')) {
      const ref = vars(t('zh', key));
      const got = vars(t(lang, key));
      const missing = [...ref].filter((v) => !got.has(v) && v !== '{m}');
      const extra = [...got].filter((v) => !ref.has(v) && !['{mon}', '{monLong}'].includes(v));
      assert.deepEqual([missing, extra], [[], []], `${lang} 占位符不一致：${key}`);
    }
  }
});

test('附件类型判断与文件名清洗', () => {
  assert.equal(classify('截图.PNG'), 'image');
  assert.equal(classify('見積書.pdf'), 'pdf');
  assert.equal(classify('売上.xlsx'), 'office');
  assert.equal(classify('orders.csv'), 'text');
  assert.equal(classify('virus.exe'), null);
  assert.equal(safeFileName('..\\..\\evil<>|"%&!.txt'), 'evil_______.txt');
  assert.equal(safeFileName('見積書 2026.pdf'), '見積書 2026.pdf');
  assert.equal(safeFileName(''), 'file');
});

test('文本解码：UTF-8 / Shift_JIS（楽天 CSV）/ 带 BOM', () => {
  assert.equal(decodeText(Buffer.from('商品名,価格', 'utf8')), '商品名,価格');
  const sjis = Buffer.from([0x8f, 0xa4, 0x95, 0x69, 0x96, 0xbc]); // 「商品名」的 Shift_JIS 编码
  assert.equal(decodeText(sjis), '商品名');
  const utf8bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')]);
  assert.equal(decodeText(utf8bom), '你好');
});

test('上传：保存、提取文字、重启后可读回、拒绝不支持的类型和空文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dual-chat-up-'));
  const pdfText = '[p.1]\n合計 331,200 円';
  const fakeExtract = async () => ({ text: pdfText, pages: 1, images: [] });
  const up = createUploads({ root, log: { warn() {} }, extract: fakeExtract });

  const csv = await up.save({ name: 'orders.csv', buffer: Buffer.from('a,b\n1,2') });
  assert.match(csv.id, UPLOAD_ID_RE);
  assert.equal(csv.kind, 'text');
  assert.equal(await up.textOf(csv), 'a,b\n1,2');
  assert.equal(up.relPath(csv), `uploads/${csv.id}/orders.csv`);

  const pdf = await up.save({ name: '見積書.pdf', buffer: Buffer.from('%PDF-1.4') });
  assert.equal(pdf.textChars, pdfText.length);
  assert.equal(pdf.mime, 'application/pdf');
  const again = createUploads({ root, extract: fakeExtract });
  assert.equal((await again.get(pdf.id)).name, '見積書.pdf');
  assert.equal(await again.get('../../etc'), null);

  await assert.rejects(up.save({ name: 'a.exe', buffer: Buffer.from('MZ') }), (e) => e.status === 415);
  await assert.rejects(up.save({ name: 'a.txt', buffer: Buffer.alloc(0) }), (e) => e.status === 400);
  const meta = JSON.parse(await readFile(join(root, 'uploads', csv.id, 'meta.json'), 'utf8'));
  assert.equal(meta.file, 'orders.csv');
});

const files = [
  { meta: { kind: 'image', name: '截图.png' }, text: '', rel: 'uploads/u1/截图.png', scanCount: 0, images: ['D:/x/截图.png'] },
  { meta: { kind: 'pdf', name: '見積書.pdf' }, text: '合計 331,200 円', rel: 'uploads/u2/見積書.pdf', scanCount: 0, images: [] },
  { meta: { kind: 'pdf', name: 'scan.pdf' }, text: '', rel: 'uploads/u3/scan.pdf', scanCount: 2, images: ['p1', 'p2'] },
  { meta: { kind: 'office', name: 'empty.docx' }, text: '', rel: 'uploads/u4/empty.docx', scanCount: 0, images: [] }
];

test('附件段：Claude 用 Read 读路径；Codex 图片已附上；文字内联', () => {
  const forClaude = attachmentSection(files, { vision: 'read', lang: 'zh' });
  assert.match(forClaude, /图片「截图.png」：路径 uploads\/u1\/截图.png（请用 Read 工具查看）/);
  assert.match(forClaude, /<file name="見積書.pdf">\n合計 331,200 円\n<\/file>/);
  assert.match(forClaude, /PDF「scan.pdf」：路径 uploads\/u3\/scan.pdf/);
  assert.match(forClaude, /没能提取出文字内容/);
  const forCodex = attachmentSection(files, { vision: 'inline', lang: 'ja' });
  assert.match(forCodex, /画像「截图.png」：このメッセージに添付済み/);
  assert.match(forCodex, /スキャン画像のため、先頭 2 ページ/);
  assert.ok(!forCodex.includes('uploads/u1'), 'Codex 不需要路径');
});

test('附件段：超长文字按预算截断', () => {
  const long = [{ meta: { kind: 'text', name: 'big.txt' }, text: 'x'.repeat(50_000), rel: 'r', scanCount: 0, images: [] }];
  assert.match(attachmentSection(long, { vision: 'read', lang: 'zh' }), /只放了前 30000 字/);
});

test('prompt：日语系统说明、历史里标出附件名', () => {
  const conv = { turns: [{ question: '前の質問', status: 'done', attachments: [{ name: '売上.xlsx' }], answers: { codex: { status: 'done', text: 'X' } } }] };
  const p = buildPrompt({ conv, model: 'claude', question: '次', includeSystem: true, lang: 'ja' });
  assert.ok(p.startsWith('【前提】あなたは'));
  assert.match(p, /【第1回・ユーザー】\n前の質問\n（添付：売上.xlsx）/);
});

test('CLI 参数：Claude 读文件权限只限 uploads；Codex 图片紧跟 flag', () => {
  const c = buildClaudeArgs({ web: true, readFiles: true });
  assert.equal(c[c.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read');
  assert.equal(c[c.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch,Read(./uploads/**)');
  const x = buildCodexArgs({ sessionId: 'th', images: ['a.png', 'b.png'] });
  assert.deepEqual(x.slice(0, 7), ['exec', 'resume', '--image', 'a.png', '--image', 'b.png', '--json']);
  assert.deepEqual(x.slice(-2), ['th', '-']);
});

test('错误提示、裁判、起标题都跟随语言', () => {
  assert.match(humanizeError('codex', 'usage limit', { lang: 'ja' }), /利用枠/);
  assert.match(humanizeError('claude', 'Not logged in', { lang: 'ja' }), /\/login/);
  const judge = buildJudgePrompt({ question: 'Q', answers: { claude: 'C', codex: 'X' }, sides: { A: 'claude', B: 'codex' }, files: '【添付】', lang: 'ja' });
  assert.match(judge, /すべて日本語で書く/);
  assert.match(judge, /添付しています/);
  assert.match(buildTopicPrompt('質問', ['EC運営'], { lang: 'ja' }), /既存のトピック：EC運営/);
});

test('Claude 带语言设置文件；中途换语言时提问里加说明', () => {
  const args = buildClaudeArgs({ settingsFile: 'D:/tmp/claude-settings-x.json' });
  assert.equal(args[args.indexOf('--settings') + 1], 'D:/tmp/claude-settings-x.json');
  const conv = { sessions: { claude: { id: 's1', seenTurns: 0 } }, turns: [] };
  assert.match(buildPrompt({ conv, model: 'claude', question: '次の質問', lang: 'ja' }), /このターンからは日本語で回答してください。[\s\S]*次の質問/);
  assert.ok(!buildPrompt({ conv, model: 'claude', question: '下一个', lang: 'zh' }).includes('从这一轮开始'));
  const jaSession = { sessions: { claude: { id: 's1', seenTurns: 0, lang: 'ja' } }, turns: [] };
  assert.ok(!buildPrompt({ conv: jaSession, model: 'claude', question: 'x', lang: 'ja' }).includes('このターン'));
});

test('英文：裁判提示词、「Answer A」换成模型名、起标题提示词、报告语言', async () => {
  const { normalizeComparison } = await import('../src/compare.mjs');
  const judge = buildJudgePrompt({ question: 'Q', answers: { claude: 'C', codex: 'X' }, sides: { A: 'codex', B: 'claude' }, lang: 'en' });
  assert.match(judge, /write everything in English/);
  assert.ok(judge.indexOf('[Answer A]\nX') < judge.indexOf('[Answer B]\nC'));
  const score = { accuracy: 8, completeness: 8, clarity: 8, practicality: 8, depth: 8 };
  const r = normalizeComparison({
    verdict: "Answer A is clearer than Answer B's draft", winner: 'A', winnerReason: '', scores: { A: score, B: score },
    consensus: [], differences: [], strengths: { A: [], B: [] }, weaknesses: { A: [], B: [] }, issues: [], bestAnswer: 'An Answering machine', recommendation: ''
  }, { A: 'codex', B: 'claude' });
  assert.equal(r.verdict, "Codex is clearer than Claude's draft");
  assert.equal(r.bestAnswer, 'An Answering machine', '普通单词不能被误换');
  assert.match(buildTopicPrompt('How to?', ['E-commerce', 'Uncategorized'], { lang: 'en' }), /Existing topics: E-commerce\. If one fits/);
  const { renderReport } = await import('../src/report.mjs');
  const html = renderReport({ conv: { topic: 'x' }, turn: { lang: 'en', question: 'q', createdAt: new Date().toISOString(), answers: {} }, comparison: { ...r, totals: { claude: 40, codex: 40 } }, judge: 'claude' });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /Scores on 5 criteria/);
});
