// 在线体验版：在 app.js 之前加载，把界面的 /api 请求和实时事件（EventSource）接到浏览器里的假后台。
// 另外加顶部的「录制回放」提示条和示例问题按钮。界面本身（app.js / ui.js …）和正式版是同一份代码。
import { createDemoBackend, DEMO_TEXT } from './demo-backend.mjs';
import { t, detectLang } from './i18n.mjs';

const REPO = 'https://github.com/tanktangmold/dual-ai-chat';
const RELEASES = `${REPO}/releases/latest`;

function currentLang() {
  try {
    const saved = JSON.parse(localStorage.getItem('dual-chat:lang') ?? 'null');
    if (['zh', 'ja', 'en'].includes(saved)) return saved;
  } catch {
    // 读不到偏好就按浏览器语言
  }
  return detectLang(navigator.language);
}

const ready = fetch('./demo-data.json')
  .then((r) => r.json())
  .then((data) => {
    const backend = createDemoBackend({ data, t });
    // 第一次打开直接展示一段带对比的对话，访客马上能看到效果
    if (!location.hash) {
      const id = backend.landingConversation(currentLang());
      if (id) history.replaceState(null, '', `#/c/${id}`);
    }
    return backend;
  });

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.includes('/api/')) return realFetch(input, init);
  const backend = await ready;
  let body = {};
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = {};
    }
  }
  const headers = new Headers(init.headers ?? {});
  const res = backend.handle(init.method ?? 'GET', url.pathname + url.search, body, { lang: headers.get('X-Lang') ?? currentLang() });
  const payload = res.ok ? { success: true, data: res.data, error: null } : { success: false, data: null, error: res.error };
  return new Response(JSON.stringify(payload), { status: res.status, headers: { 'Content-Type': 'application/json' } });
};

class DemoEventSource {
  constructor(url) {
    this.url = String(url);
    this.readyState = DemoEventSource.CONNECTING;
    this.onmessage = null;
    this.onerror = null;
    const match = this.url.match(/\/api\/jobs\/([^/?]+)\/events/);
    ready.then((backend) => {
      if (this.readyState === DemoEventSource.CLOSED) return;
      this.readyState = DemoEventSource.OPEN;
      const send = (event) => this.onmessage?.({ data: JSON.stringify(event) });
      this.unsubscribe = match ? backend.subscribe(decodeURIComponent(match[1]), send) : null;
      if (!this.unsubscribe) send({ type: 'gone' });
    });
  }

  close() {
    this.readyState = DemoEventSource.CLOSED;
    this.unsubscribe?.();
  }
}
DemoEventSource.CONNECTING = 0;
DemoEventSource.OPEN = 1;
DemoEventSource.CLOSED = 2;
window.EventSource = DemoEventSource;

// ---------- 提示条 + 示例问题 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uiLang = () => ({ ja: 'ja', en: 'en' })[document.documentElement.lang] ?? 'zh';

function renderBanner(banner) {
  const text = DEMO_TEXT[uiLang()];
  banner.innerHTML = `<span class="demo-tag">DEMO</span><span class="demo-text">${esc(text.banner)}</span>
    <a class="demo-btn" href="${RELEASES}" target="_blank" rel="noopener">${esc(text.download)}</a>
    <a class="demo-link" href="${REPO}" target="_blank" rel="noopener">GitHub</a>`;
}

function renderSamples(bar, samples) {
  const lang = uiLang();
  const ordered = [...samples.filter((s) => s.lang === lang), ...samples.filter((s) => s.lang !== lang)];
  bar.innerHTML = `<span class="demo-label">${esc(DEMO_TEXT[lang].samples)}</span>${ordered
    .map((s) => `<button type="button" class="demo-chip" data-q="${esc(s.question)}" data-mode="${esc(s.mode)}" title="${esc(s.question)}">${s.turn.attachments?.length ? '📎 ' : ''}${esc(s.question)}</button>`)
    .join('')}`;
}

function askSample(button) {
  const send = document.querySelector('#sendBtn');
  if (!send || send.classList.contains('stop')) return; // 还在回放，别触发「停止」
  document.querySelector(`#modeGroup [data-mode="${button.dataset.mode}"]`)?.click();
  const box = document.querySelector('#question');
  box.value = button.dataset.q;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#composer').requestSubmit();
}

async function decorate() {
  const backend = await ready;
  document.body.classList.add('demo');
  const banner = document.createElement('div');
  banner.className = 'demo-banner';
  document.body.prepend(banner);
  const bar = document.createElement('div');
  bar.className = 'demo-samples';
  document.querySelector('#composer .input-row')?.before(bar);
  bar.addEventListener('click', (e) => {
    const chip = e.target.closest('.demo-chip');
    if (chip) askSample(chip);
  });
  const refresh = () => {
    renderBanner(banner);
    renderSamples(bar, backend.samples);
  };
  refresh();
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorate);
else decorate();
