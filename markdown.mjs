/**
 * 极简、先转义后排版的 Markdown 渲染器。
 *
 * 模型输出是不可信内容：所有文本先 HTML 转义，再套标签；链接只放行 http/https/mailto。
 * 浏览器端和服务端（生成对比报告）共用这一个文件。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 引用/列表最多嵌套这么多层，再深按普通文字处理（防栈溢出）。 */
const MAX_DEPTH = 12;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;

/** 行内格式：代码、链接、自动链接、粗体、斜体、删除线。 */
export function renderInline(text) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  const restore = (str) => str.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? '');

  // 占位符用 NUL 包裹，先把原文里的 NUL 去掉，避免伪造占位符
  let s = String(text ?? '').replace(/\u0000/g, '').replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);

  // 链接文字里可能已经有行内代码的占位符（[`fetch`](url)），放进链接前先还原
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) =>
    SAFE_URL.test(url) ? keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${restore(label)}</a>`) : match
  );
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<\u0000]+[^\s<.,;:!?)\]'"\u0000。，；：！？）])/g, (_, lead, url) =>
    `${lead}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`
  );

  s = s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');

  return restore(s);
}

const isTableStart = (lines, i) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_SEP_RE.test(lines[i + 1]) &&
  (lines[i + 1].includes('|') || lines[i].trim().startsWith('|'));

function isBlockStart(lines, i) {
  const line = lines[i];
  return (
    FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || /^\s*>/.test(line) ||
    LIST_RE.test(line) || isTableStart(lines, i)
  );
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : '';
  });
  const style = (col) => (aligns[col] ? ` style="text-align:${aligns[col]}"` : '');

  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }

  const head = header.map((cell, col) => `<th${style(col)}>${renderInline(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${header.map((_, col) => `<td${style(col)}>${renderInline(row[col] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return { html: `<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
}

function readFence(lines, start) {
  const [, marker, lang] = lines[start].match(FENCE_RE);
  const indent = indentOf(lines[start]);
  const body = [];
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith(marker[0].repeat(3))) {
    body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
    i += 1;
  }
  const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
  return { html: `<pre class="md-code"${langAttr}><code>${escapeHtml(body.join('\n'))}</code></pre>`, next: i + 1 };
}

function renderItem(item) {
  const text = item.lines.map(renderInline).join('<br>');
  return `<li>${text}${item.children.join('')}</li>`;
}

function parseList(lines, start, depth = 0) {
  const base = indentOf(lines[start]);
  const first = lines[start].match(LIST_RE);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const continues = j < lines.length && indentOf(lines[j]) >= base &&
        (LIST_RE.test(lines[j]) ? indentOf(lines[j]) >= base : indentOf(lines[j]) > base);
      if (!continues) break;
      i = j;
      continue;
    }

    const indent = indentOf(line);
    const match = line.match(LIST_RE);
    const last = items.at(-1);

    if (match && indent === base) {
      if (/\d/.test(match[2]) !== ordered) break;
      items.push({ lines: [match[3]], children: [] });
      i += 1;
    } else if (indent < base || !last) {
      break;
    } else if (FENCE_RE.test(line)) {
      const fence = readFence(lines, i);
      last.children.push(fence.html);
      i = fence.next;
    } else if (match && depth < MAX_DEPTH) {
      const sub = parseList(lines, i, depth + 1);
      last.children.push(sub.html);
      i = sub.next;
    } else if (indent > base || !isBlockStart(lines, i)) {
      last.lines.push(line.trim());
      i += 1;
    } else {
      break;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : '';
  return { html: `<${tag}${startAttr}>${items.map(renderItem).join('')}</${tag}>`, next: i };
}

function renderBlocks(source, depth) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
    } else if (FENCE_RE.test(line)) {
      const fence = readFence(lines, i);
      out.push(fence.html);
      i = fence.next;
    } else if (HEADING_RE.test(line)) {
      const [, hashes, text] = line.match(HEADING_RE);
      out.push(`<h${hashes.length}>${renderInline(text)}</h${hashes.length}>`);
      i += 1;
    } else if (HR_RE.test(line)) {
      out.push('<hr>');
      i += 1;
    } else if (isTableStart(lines, i)) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
    } else if (/^\s*>/.test(line) && depth < MAX_DEPTH) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted.join('\n'), depth + 1)}</blockquote>`);
    } else if (LIST_RE.test(line)) {
      const list = parseList(lines, i, depth);
      out.push(list.html);
      i = list.next;
    } else {
      const para = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${para.map((l) => renderInline(l.trim())).join('<br>')}</p>`);
    }
  }

  return out.join('\n');
}

/** 把 Markdown 文本渲染成安全的 HTML 片段。任何意外都退回成转义后的纯文本，不让一份回答拖垮整页。 */
export function renderMarkdown(source) {
  try {
    return renderBlocks(source, 0);
  } catch {
    return `<pre class="md-code"><code>${escapeHtml(source)}</code></pre>`;
  }
}
