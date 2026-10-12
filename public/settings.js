// 设置与连接弹窗：读写 /api/settings，显示 CLI 位置，测试连接，关闭后台服务。
import { esc, t, LABELS, formatDuration } from '/ui.js';

const $ = (sel) => document.querySelector(sel);

function connRow(kind, info) {
  const status = info?.found
    ? `<span class="path" title="${esc(info.file)}">${esc(info.version || '')} · ${esc(info.file)}</span>`
    : `<span class="path bad-text">${esc(t('set.notFound'))}</span>`;
  return `<span class="who ${kind}"><i></i>${LABELS[kind]}</span>${status}<button type="button" class="btn small" data-test="${kind}">${esc(t('set.test'))}</button><span class="result" data-result="${kind}"></span>`;
}

function toolRows(tools) {
  const row = (label, value) => `<span class="tool-label">${esc(label)}</span>${value
    ? `<span class="path" title="${esc(value)}">✓ ${esc(value)}</span>`
    : `<span class="path bad-text">✗ ${esc(t('set.toolMissing'))}</span>`}`;
  return row(t('set.ffmpeg'), tools.ffmpeg) + row(t('set.python'), tools.python);
}

/**
 * @param api (method, path, body) => Promise
 * @param onSaved (settings, health) => void
 * @param toast (msg, isError) => void
 */
export function createSettingsDialog({ api, onSaved, toast }) {
  const dialog = $('#settingsDialog');
  const form = $('#settingsForm');

  async function open() {
    try {
      const [settings, health] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/health')]);
      form.judge.value = settings.judge;
      form.judgeEffort.value = settings.judgeEffort;
      form.claudeModel.value = settings.claude.model;
      form.claudeEffort.value = settings.claude.effort;
      form.codexModel.value = settings.codex.model;
      form.codexEffort.value = settings.codex.effort;
      form.claudePath.value = settings.claude.path;
      form.codexPath.value = settings.codex.path;
      form.ffmpegPath.value = settings.ffmpegPath ?? '';
      form.web.checked = settings.web;
      form.timeoutMin.value = settings.timeoutMin;
      $('#connClaude').innerHTML = connRow('claude', health.claude);
      $('#connCodex').innerHTML = connRow('codex', health.codex);
      $('#toolRows').innerHTML = toolRows(health.tools ?? {});
      $('#dataInfo').textContent = t('set.dataInfo', { dir: health.dataDir, n: health.conversations });
      $('#settingsMsg').textContent = '';
      dialog.showModal();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function save() {
    const body = {
      judge: form.judge.value,
      judgeEffort: form.judgeEffort.value,
      web: form.web.checked,
      timeoutMin: Number(form.timeoutMin.value),
      ffmpegPath: form.ffmpegPath.value.trim(),
      claude: { model: form.claudeModel.value.trim(), effort: form.claudeEffort.value, path: form.claudePath.value.trim() },
      codex: { model: form.codexModel.value.trim(), effort: form.codexEffort.value, path: form.codexPath.value.trim() }
    };
    try {
      const settings = await api('PUT', '/api/settings', body);
      const health = await api('GET', '/api/health');
      dialog.close();
      onSaved(settings, health);
      toast(t('set.saved'));
    } catch (err) {
      $('#settingsMsg').textContent = err.message;
    }
  }

  async function test(kind, button) {
    const out = form.querySelector(`[data-result="${kind}"]`);
    button.disabled = true;
    out.className = 'result';
    out.textContent = t('set.testing');
    try {
      const r = await api('POST', '/api/health/test', { model: kind });
      out.className = `result ${r.ok ? 'ok' : 'bad'}`;
      out.textContent = r.ok ? t('set.testOk', { t: formatDuration(r.ms), text: r.text }) : `✗ ${r.error}`;
    } catch (err) {
      out.className = 'result bad';
      out.textContent = `✗ ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  $('#saveSettings').addEventListener('click', (e) => {
    e.preventDefault();
    save();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-test]');
    if (b) test(b.dataset.test, b);
  });
  $('#shutdownBtn').addEventListener('click', async () => {
    if (!confirm(t('set.confirmShutdown'))) return;
    await api('POST', '/api/shutdown').catch(() => {});
    dialog.close();
    toast(t('set.stopped'));
  });

  return { open };
}
