/**
 * HTTP 层：静态页面 + JSON API + SSE + 报告文件 + 附件上传/查看。只监听 127.0.0.1。
 *
 * 安全：
 * - Host 头必须是 127.0.0.1/localhost:端口（防 DNS 重绑定）。
 * - 写操作必须带 X-Dual-Chat: 1 且 Origin 同源（防别的网页偷偷调用本机 CLI）。
 * - 所有 ID / 文件名走白名单正则，杜绝路径穿越。
 * - 附件按 meta.json 里登记的文件名取，URL 里的文件名只是给人看的。
 *
 * 语言：错误提示按请求头 X-Lang（zh / ja）翻译。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ID_RE, LIMITS } from './store.mjs';
import { t, normalizeLang, i18nError } from './i18n.mjs';
import { UPLOAD_LIMITS, UPLOAD_ID_RE, publicMeta, mimeOf } from './uploads.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BODY_LIMIT = 256 * 1024;
const UPLOAD_BODY_LIMIT = (UPLOAD_LIMITS.fileMB + 1) * 1024 * 1024;

const js = 'text/javascript; charset=utf-8';
const STATIC = Object.freeze({
  '/': { file: join(ROOT, 'public', 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: join(ROOT, 'public', 'app.js'), type: js },
  '/ui.js': { file: join(ROOT, 'public', 'ui.js'), type: js },
  '/attachments.js': { file: join(ROOT, 'public', 'attachments.js'), type: js },
  '/settings.js': { file: join(ROOT, 'public', 'settings.js'), type: js },
  '/styles.css': { file: join(ROOT, 'public', 'styles.css'), type: 'text/css; charset=utf-8' },
  '/favicon.svg': { file: join(ROOT, 'public', 'favicon.svg'), type: 'image/svg+xml' },
  '/markdown.mjs': { file: join(ROOT, 'src', 'markdown.mjs'), type: js },
  '/i18n.mjs': { file: join(ROOT, 'src', 'i18n.mjs'), type: js },
  '/i18n/zh.mjs': { file: join(ROOT, 'src', 'i18n', 'zh.mjs'), type: js },
  '/i18n/ja.mjs': { file: join(ROOT, 'src', 'i18n', 'ja.mjs'), type: js },
  '/i18n/en.mjs': { file: join(ROOT, 'src', 'i18n', 'en.mjs'), type: js }
});

const APP_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'self'";
const UPLOAD_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
const REPORT_RE = /^\/reports\/(\d{4}-\d{2}-\d{2})\/([a-z][a-z0-9_-]{2,63}__[a-z][a-z0-9_-]{2,63}\.html)$/i;
const UPLOAD_RE = /^\/uploads\/(u_[0-9_-]+[0-9a-f]{6})(?:\/[^/]*)?$/;

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const ok = (res, data) => sendJson(res, 200, { success: true, data, error: null });

async function readRaw(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw i18nError(413, 'err.bodyTooBig');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const raw = await readRaw(req, BODY_LIMIT);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw i18nError(400, 'err.badJson');
  }
}

function checkRequest(req, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host)) throw i18nError(403, 'err.local');
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-dual-chat'] !== '1') throw i18nError(403, 'err.marker');
  const origin = req.headers.origin;
  if (origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) throw i18nError(403, 'err.crossSite');
}

const assertId = (id, what) => {
  if (!ID_RE.test(String(id ?? ''))) throw i18nError(400, 'err.badId', { what });
  return id;
};

function decodeName(raw) {
  try {
    return decodeURIComponent(String(raw ?? ''));
  } catch {
    return String(raw ?? '');
  }
}

function openInExplorer(file) {
  if (process.platform !== 'win32') return;
  spawn('explorer.exe', [`/select,${file}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/**
 * @param deps { store, jobs, uploads, settings: { get, update }, health, testModel(kind), reportsDir, log, onShutdown }
 */
export function createApp(deps) {
  const { store, jobs, uploads, settings, health, testModel, reportsDir, log = console, onShutdown } = deps;
  const langOf = (req) => normalizeLang(req.headers['x-lang']);

  const routes = [
    ['GET', /^\/api\/health$/, async () => health()],
    ['POST', /^\/api\/health\/test$/, async (_req, _m, body) => {
      if (!['claude', 'codex'].includes(body.model)) throw i18nError(400, 'err.testModel');
      return testModel(body.model);
    }],
    ['GET', /^\/api\/settings$/, async () => settings.get()],
    ['PUT', /^\/api\/settings$/, async (_req, _m, body) => settings.update(body)],
    ['GET', /^\/api\/conversations$/, async () => ({ items: store.list(), topics: store.topics() })],
    ['GET', /^\/api\/search$/, async (req) => {
      const q = new URL(req.url, 'http://x').searchParams.get('q') ?? '';
      return { items: store.search(q.slice(0, 100)) };
    }],
    ['POST', /^\/api\/conversations$/, async (req, _m, body) =>
      store.create({ topic: typeof body.topic === 'string' ? body.topic : undefined, lang: langOf(req) })],
    ['GET', /^\/api\/conversations\/([^/]+)$/, async (_req, m) => {
      const conv = store.get(assertId(m[1], 'ID'));
      if (!conv) throw i18nError(404, 'err.noConv');
      return { ...(jobs.withLive ? jobs.withLive(conv) : conv), activeTurns: jobs.activeTurns(conv.id) };
    }],
    ['PATCH', /^\/api\/conversations\/([^/]+)$/, async (_req, m, body) => {
      const id = assertId(m[1], 'ID');
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, LIMITS.title) : undefined;
      const topic = typeof body.topic === 'string' ? body.topic.trim().slice(0, LIMITS.topic) : undefined;
      if (title === '' || topic === '') throw i18nError(400, 'err.emptyTitle');
      return store.update(id, (c) => ({ ...c, title: title ?? c.title, topic: topic ?? c.topic, titleAuto: false }), { touch: false });
    }],
    ['DELETE', /^\/api\/conversations\/([^/]+)$/, async (_req, m) => {
      const id = assertId(m[1], 'ID');
      if (jobs.activeTurns(id).length) throw i18nError(409, 'err.deleteBusy');
      await store.remove(id);
      return { removed: id };
    }],
    ['POST', /^\/api\/conversations\/([^/]+)\/ask$/, async (req, m, body) =>
      jobs.ask({
        convId: assertId(m[1], 'ID'),
        question: body.question,
        mode: body.mode,
        web: body.web,
        lang: body.lang ?? langOf(req),
        attachments: body.attachments
      })],
    ['POST', /^\/api\/conversations\/([^/]+)\/turns\/([^/]+)\/compare$/, async (_req, m, body) =>
      jobs.recompare({ convId: assertId(m[1], 'ID'), turnId: assertId(m[2], 'ID'), judge: body.judge })],
    ['POST', /^\/api\/jobs\/([^/]+)\/cancel$/, async (_req, m) => ({ cancelled: jobs.cancel(assertId(m[1], 'ID')) })],
    ['POST', /^\/api\/reports\/reveal$/, async (_req, _m, body) => {
      const match = `/reports/${String(body.report ?? '')}`.match(REPORT_RE);
      if (!match) throw i18nError(400, 'err.badReport');
      openInExplorer(join(reportsDir, match[1], match[2]));
      return { opened: true };
    }],
    ['POST', /^\/api\/shutdown$/, async () => {
      setTimeout(() => onShutdown?.(), 200);
      return { stopping: true };
    }]
  ];

  async function serveStatic(res, entry) {
    const body = await readFile(entry.file);
    const headers = { 'Content-Type': entry.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (entry.type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = APP_CSP;
      headers['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  async function serveReport(res, match) {
    let body;
    try {
      body = await readFile(join(reportsDir, match[1], match[2]));
    } catch {
      throw i18nError(404, 'err.noReport');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': REPORT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    res.end(body);
  }

  async function serveUpload(res, id) {
    const meta = UPLOAD_ID_RE.test(id) && uploads ? await uploads.get(id) : null;
    if (!meta) throw i18nError(404, 'err.noAttachment');
    const body = await readFile(uploads.absPath(meta)).catch(() => null);
    if (!body) throw i18nError(404, 'err.noAttachment');
    const inline = meta.kind === 'image' || meta.kind === 'pdf';
    res.writeHead(200, {
      'Content-Type': inline ? mimeOf(meta.file) : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.file)}`,
      'Content-Security-Policy': UPLOAD_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600'
    });
    res.end(body);
  }

  async function receiveUpload(req) {
    if (!uploads) throw i18nError(404, 'err.notFound');
    const name = decodeName(req.headers['x-file-name']).trim() || 'file';
    const buffer = await readRaw(req, UPLOAD_BODY_LIMIT).catch((err) => {
      throw err.key === 'err.bodyTooBig' ? i18nError(413, 'err.fileSize', { name, mb: UPLOAD_LIMITS.fileMB }) : err;
    });
    return publicMeta(await uploads.save({ name, buffer }));
  }

  function serveEvents(req, res, turnId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    let closed = false;
    let unsubscribe = null;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe?.();
      res.end();
    };
    const send = (event) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'end') setTimeout(close, 50);
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', close);
    unsubscribe = jobs.subscribe(turnId, send);
    if (!unsubscribe) {
      send({ type: 'gone' });
      setTimeout(close, 50);
    }
  }

  async function handle(req, res) {
    const port = req.socket.localPort;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    checkRequest(req, port);

    if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(res, STATIC[url.pathname]);
    const report = req.method === 'GET' && url.pathname.match(REPORT_RE);
    if (report) return serveReport(res, report);
    const upload = req.method === 'GET' && url.pathname.match(UPLOAD_RE);
    if (upload) return serveUpload(res, upload[1]);
    const events = req.method === 'GET' && url.pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (events) return serveEvents(req, res, assertId(events[1], 'ID'));
    if (req.method === 'POST' && url.pathname === '/api/uploads') return ok(res, await receiveUpload(req));

    for (const [method, pattern, fn] of routes) {
      const match = req.method === method && url.pathname.match(pattern);
      if (!match) continue;
      const body = method === 'GET' ? {} : await readBody(req);
      return ok(res, await fn(req, match, body));
    }
    throw i18nError(404, 'err.notFound');
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status >= 500) log.error?.(`[http] ${req.method} ${req.url} 出错：${err.stack ?? err.message}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      const lang = langOf(req);
      const message = err.key ? t(lang, err.key, err.vars) : err.message;
      sendJson(res, status, { success: false, data: null, error: status >= 500 ? t(lang, 'err.internal', { msg: message }) : message });
    });
  });
}
