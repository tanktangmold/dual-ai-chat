import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderInline, escapeHtml } from '../src/markdown.mjs';

test('转义 HTML，模型输出里的标签不能变成真标签', () => {
  const html = renderMarkdown('<script>alert(1)</script> 和 <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('javascript: 链接不渲染成 a 标签', () => {
  const html = renderInline('[点我](javascript:alert(1))');
  assert.ok(!html.includes('<a '));
});

test('http 链接和裸网址变成新窗口链接', () => {
  const html = renderInline('看 [官网](https://nodejs.org/en) 或 https://example.com/a?b=1&c=2。');
  assert.match(html, /<a href="https:\/\/nodejs.org\/en" target="_blank" rel="noopener noreferrer">官网<\/a>/);
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2"/);
  assert.ok(html.endsWith('。'), '中文句号不能被吞进链接');
});

test('属性值里的引号被转义，无法跳出 href', () => {
  const html = renderInline('[x](https://a.com/"onmouseover="alert(1))');
  assert.ok(!html.includes('"onmouseover'));
});

test('行内代码里的 markdown 符号保持原样', () => {
  assert.equal(renderInline('`**不加粗**`'), '<code>**不加粗**</code>');
});

test('粗体、斜体、删除线', () => {
  assert.equal(renderInline('**粗** *斜* ~~删~~'), '<strong>粗</strong> <em>斜</em> <del>删</del>');
});

test('snake_case 不会被当成斜体', () => {
  assert.equal(renderInline('my_var_name'), 'my_var_name');
});

test('代码块保留内容并转义', () => {
  const html = renderMarkdown('```js\nconst a = "<b>";\n```');
  assert.equal(html, '<pre class="md-code" data-lang="js"><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
});

test('标题、分隔线、引用', () => {
  const html = renderMarkdown('## 小标题\n\n---\n\n> 引用一句');
  assert.ok(html.includes('<h2>小标题</h2>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<blockquote><p>引用一句</p></blockquote>'));
});

test('有序列表带起始序号、嵌套无序列表', () => {
  const html = renderMarkdown('3. 第三\n4. 第四\n   - 子项 A\n   - 子项 B\n5. 第五');
  assert.ok(html.startsWith('<ol start="3">'));
  assert.ok(html.includes('<li>第四<ul><li>子项 A</li><li>子项 B</li></ul></li>'));
  assert.ok(html.includes('<li>第五</li>'));
});

test('列表项里的缩进代码块', () => {
  const html = renderMarkdown('1. 安装：\n   ```bash\n   npm i\n   ```\n2. 运行');
  assert.ok(html.includes('<li>安装：<pre class="md-code" data-lang="bash"><code>npm i</code></pre></li>'));
  assert.ok(html.includes('<li>运行</li>'));
});

test('空行隔开的列表项仍属同一个列表', () => {
  const html = renderMarkdown('- 一\n\n- 二');
  assert.equal(html, '<ul><li>一</li><li>二</li></ul>');
});

test('表格和对齐', () => {
  const html = renderMarkdown('| 名称 | 分数 |\n|:---|---:|\n| Claude | 9 |\n| Codex | 8 |');
  assert.ok(html.includes('<th style="text-align:left">名称</th>'));
  assert.ok(html.includes('<td style="text-align:right">9</td>'));
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});

test('段落内换行用 br', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行<br>第二行</p>');
});

test('空输入', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
  assert.equal(escapeHtml(undefined), '');
});
