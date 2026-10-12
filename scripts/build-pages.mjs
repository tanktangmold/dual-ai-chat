/**
 * 构建 GitHub Pages 在线体验版：npm run pages:build → dist/pages/
 *
 * 用的就是正式版的界面文件（public/ + src/markdown.mjs + src/i18n*），只做三件事：
 *   1. 绝对路径改成相对路径（网站开在 https://<用户>.github.io/dual-ai-chat/ 子路径下）；
 *   2. 在 app.js 之前插入 demo-shim.js（把 /api 请求接到浏览器里的假后台）；
 *   3. 带上 demo/ 里录制好的对话、报告、附件。
 * 改了界面后重新构建即可，体验版不会和正式版走样。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'dist', 'pages');
const SITE = 'https://tanktangmold.github.io/dual-ai-chat/';

/** 精确替换，找不到就报错（正式版代码改了要同步这里）。 */
function replaceExact(source, from, to, file, { all = false } = {}) {
  if (!source.includes(from)) throw new Error(`build-pages：${file} 里找不到「${from}」，界面代码改过了，请同步构建脚本`);
  return all ? source.split(from).join(to) : source.replace(from, to);
}

/** ES 模块里 from '/x' → from './x' */
function relativeImports(source, file) {
  const count = (source.match(/from '\//g) ?? []).length;
  if (!count) throw new Error(`build-pages：${file} 里没有绝对路径的 import`);
  return source.replace(/from '\//g, "from './");
}

const META = `<meta name="description" content="Live demo of Dual AI Chat: ask Claude and ChatGPT (Codex) the same question, compare the answers side by side with a scored visual report. Recorded answers replayed in your browser.">
<meta property="og:title" content="Dual AI Chat — live demo">
<meta property="og:description" content="Ask Claude and Codex side by side with your own subscriptions. Blind scored comparison, visual report, chats by date and topic.">
<meta property="og:image" content="${SITE}preview.png">
<meta property="og:url" content="${SITE}">
<meta name="twitter:card" content="summary_large_image">`;

export function transform(name, source) {
  switch (name) {
    case 'index.html': {
      let s = source;
      s = replaceExact(s, 'href="/favicon.svg"', 'href="./favicon.svg"', name);
      s = replaceExact(s, '<link rel="stylesheet" href="/styles.css">', `<link rel="stylesheet" href="./styles.css">\n<link rel="stylesheet" href="./demo.css">\n${META}`, name);
      s = replaceExact(s, '<script type="module" src="/app.js"></script>', '<script type="module" src="./demo-shim.js"></script>\n<script type="module" src="./app.js"></script>', name);
      return s;
    }
    case 'ui.js': {
      let s = relativeImports(source, name);
      s = replaceExact(s, '`/uploads/${', '`uploads/${', name);
      s = replaceExact(s, '`/reports/${c.report}`', '`reports/${c.report}`', name);
      return s;
    }
    case 'app.js':
    case 'attachments.js':
    case 'settings.js':
      return relativeImports(source, name);
    default:
      return source;
  }
}

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'i18n'), { recursive: true });

  for (const name of ['index.html', 'app.js', 'ui.js', 'attachments.js', 'settings.js']) {
    writeFileSync(join(OUT, name), transform(name, readFileSync(join(ROOT, 'public', name), 'utf8')));
  }
  for (const name of ['styles.css', 'favicon.svg', 'app.ico']) cpSync(join(ROOT, 'public', name), join(OUT, name));
  cpSync(join(ROOT, 'src', 'markdown.mjs'), join(OUT, 'markdown.mjs'));
  cpSync(join(ROOT, 'src', 'i18n.mjs'), join(OUT, 'i18n.mjs'));
  for (const f of readdirSync(join(ROOT, 'src', 'i18n'))) cpSync(join(ROOT, 'src', 'i18n', f), join(OUT, 'i18n', f));

  cpSync(join(ROOT, 'demo', 'backend.mjs'), join(OUT, 'demo-backend.mjs'));
  cpSync(join(ROOT, 'demo', 'shim.js'), join(OUT, 'demo-shim.js'));
  cpSync(join(ROOT, 'demo', 'demo.css'), join(OUT, 'demo.css'));
  cpSync(join(ROOT, 'demo', 'data.json'), join(OUT, 'demo-data.json'));
  cpSync(join(ROOT, 'demo', 'reports'), join(OUT, 'reports'), { recursive: true });
  cpSync(join(ROOT, 'demo', 'uploads'), join(OUT, 'uploads'), { recursive: true });
  cpSync(join(ROOT, 'docs', 'screenshot-chat.png'), join(OUT, 'preview.png'));
  writeFileSync(join(OUT, '.nojekyll'), '');
  return OUT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`在线体验版已构建 → ${build()}`);
}
