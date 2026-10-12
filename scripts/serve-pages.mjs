/**
 * 本地预览在线体验版：npm run pages:serve → http://127.0.0.1:8798/dual-ai-chat/
 * 和 GitHub Pages 一样挂在 /dual-ai-chat/ 子路径下，能提前发现绝对路径的问题。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { OUT, build } from './build-pages.mjs';

const PORT = Number(process.env.PAGES_PORT ?? 8798);
const BASE = '/dual-ai-chat/';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf'
};

build();
createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!path.startsWith(BASE)) {
    res.writeHead(302, { Location: BASE });
    res.end();
    return;
  }
  const rel = path.slice(BASE.length) || 'index.html';
  const file = normalize(join(OUT, rel.endsWith('/') ? `${rel}index.html` : rel));
  if (!file.startsWith(OUT + sep) && file !== OUT) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`在线体验版预览：http://127.0.0.1:${PORT}${BASE}`));
