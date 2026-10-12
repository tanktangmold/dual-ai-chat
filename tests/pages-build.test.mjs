import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { build, transform, OUT } from '../scripts/build-pages.mjs';
import { cleanConversation } from '../scripts/export-demo.mjs';

test('在线体验版构建：路径全部改成相对，演示脚本插在 app.js 之前', () => {
  const out = build();
  assert.equal(out, OUT);
  const html = readFileSync(join(OUT, 'index.html'), 'utf8');
  assert.ok(html.indexOf('./demo-shim.js') > 0 && html.indexOf('./demo-shim.js') < html.indexOf('./app.js'));
  assert.ok(!/(src|href)="\//.test(html), 'index.html 里不能再有以 / 开头的资源路径');
  for (const f of ['app.js', 'ui.js', 'attachments.js', 'settings.js']) {
    const js = readFileSync(join(OUT, f), 'utf8');
    assert.ok(!js.includes("from '/"), `${f} 还有绝对路径 import`);
  }
  const ui = readFileSync(join(OUT, 'ui.js'), 'utf8');
  assert.ok(!ui.includes('`/reports/') && !ui.includes('`/uploads/'));
  for (const f of ['.nojekyll', 'demo-data.json', 'demo-backend.mjs', 'i18n/en.mjs', 'i18n/ja.mjs', 'i18n/zh.mjs', 'markdown.mjs', 'preview.png', 'app.ico']) {
    assert.ok(existsSync(join(OUT, f)), `缺少 ${f}`);
  }
});

test('演示数据引用的报告和附件文件都在网站里', () => {
  build();
  const data = JSON.parse(readFileSync(join(OUT, 'demo-data.json'), 'utf8'));
  for (const conv of data.conversations) {
    for (const turn of conv.turns) {
      if (turn.comparison?.report) assert.ok(existsSync(join(OUT, 'reports', turn.comparison.report)), `缺报告 ${turn.comparison.report}`);
      for (const a of turn.attachments ?? []) assert.ok(existsSync(join(OUT, 'uploads', a.id, a.file)), `缺附件 ${a.id}/${a.file}`);
    }
  }
});

test('界面代码改了而构建脚本没同步时，构建直接报错而不是悄悄出错', () => {
  assert.throws(() => transform('index.html', '<html></html>'), /找不到/);
  assert.throws(() => transform('app.js', 'console.log(1)'), /绝对路径/);
});

test('导出演示数据：去掉会话 ID，附件改成 ASCII 文件名', () => {
  const conv = { id: 'c_x', sessions: { claude: { id: 'secret' } }, turns: [{ attachments: [{ id: 'u_1', name: '見積書.pdf', file: '見積書.pdf' }] }] };
  const clean = cleanConversation(conv, () => 'file.pdf');
  assert.equal(clean.sessions, undefined);
  assert.equal(clean.turns[0].attachments[0].file, 'file.pdf');
  assert.equal(clean.turns[0].attachments[0].name, '見積書.pdf', '显示名保留原名');
});
