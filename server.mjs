/**
 * 双AI对话台 —— 启动入口。
 *   node server.mjs          启动服务（http://127.0.0.1:8796）
 *   node server.mjs --open   启动并用 Chrome/Edge 应用窗口打开；已在运行就只打开窗口
 *   node server.mjs --check  自检：输出找到的 claude / codex / ffmpeg / Python（JSON），一键安装用它判断还缺什么
 * 环境变量：DUAL_CHAT_PORT 改端口，DUAL_CHAT_DATA 改数据目录。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.mjs';
import { createUploads } from './src/uploads.mjs';
import { createJobs } from './src/jobs.mjs';
import { createApp } from './src/app.mjs';
import { createProvider } from './src/providers/index.mjs';
import { locateCli } from './src/cli/locate.mjs';
import { locateFfmpeg, locatePython, pythonInfo } from './src/media.mjs';
import { loadSettings, mergeSettings, saveSettings } from './src/settings.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DUAL_CHAT_PORT ?? 8796);
const DATA = process.env.DUAL_CHAT_DATA ?? join(ROOT, 'data');
const PATHS = Object.freeze({
  settings: join(DATA, 'settings.json'),
  reports: join(DATA, 'reports'),
  workspace: join(DATA, 'workspace'),
  tmp: join(DATA, 'tmp'),
  log: join(DATA, 'server.log')
});
const URL_BASE = `http://127.0.0.1:${PORT}`;

function makeLogger() {
  const write = (level, msg) => {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    (level === 'ERROR' ? console.error : console.log)(line);
    appendFile(PATHS.log, `${line}\n`).catch(() => {});
  };
  return { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m) };
}

function findBrowser() {
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [join('Google', 'Chrome', 'Application', 'chrome.exe'), join('Microsoft', 'Edge', 'Application', 'msedge.exe')];
  for (const r of rel) for (const b of bases) if (existsSync(join(b, r))) return join(b, r);
  return null;
}

function openWindow() {
  const browser = process.platform === 'win32' ? findBrowser() : null;
  const url = `${URL_BASE}/`;
  const opener = { win32: ['cmd.exe', ['/c', 'start', '', url]], darwin: ['open', [url]] }[process.platform] ?? ['xdg-open', [url]];
  const child = browser
    ? spawn(browser, [`--app=${url}`, '--window-size=1360,900'], { detached: true, stdio: 'ignore' })
    : spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  child.unref();
}

/** 自检（不启动服务）：给一键安装脚本用。 */
async function check() {
  const settings = await loadSettings(PATHS.settings, { log: { warn() {} } });
  const cli = (name) => {
    const found = locateCli(name, { override: settings[name].path });
    return found ? { file: found.file, version: found.version, isCmd: found.isCmd } : null;
  };
  const report = {
    node: process.version,
    nodeFile: process.execPath,
    claude: cli('claude'),
    codex: cli('codex'),
    ffmpeg: locateFfmpeg({ override: settings.ffmpegPath }),
    python: pythonInfo(locatePython())
  };
  process.stdout.write(`${JSON.stringify(report)}
`);
}

async function main() {
  await Promise.all(Object.values(PATHS).filter((p) => !p.endsWith('.json') && !p.endsWith('.log')).map((p) => mkdir(p, { recursive: true })));
  const log = makeLogger();

  let settings = await loadSettings(PATHS.settings, { log });
  const locateAll = () => ({
    claude: locateCli('claude', { override: settings.claude.path }),
    codex: locateCli('codex', { override: settings.codex.path })
  });
  let clis = locateAll();
  let ffmpeg = locateFfmpeg({ override: settings.ffmpegPath });
  const pythonFile = locatePython();
  const python = pythonInfo(pythonFile)?.version ?? '';

  const providers = {
    claude: createProvider('claude', { getCli: () => clis.claude, cwd: PATHS.workspace, tmpDir: PATHS.tmp }),
    codex: createProvider('codex', { getCli: () => clis.codex, cwd: PATHS.workspace, tmpDir: PATHS.tmp })
  };

  const store = createStore({ dir: DATA, log });
  const count = await store.load();
  const uploads = createUploads({ root: PATHS.workspace, log, getFfmpeg: () => ffmpeg, ...(pythonFile ? { python: pythonFile } : {}) });
  const jobs = createJobs({ store, providers, uploads, getSettings: () => settings, reportsDir: PATHS.reports, log });
  const recovered = await jobs.recoverInterrupted();

  const health = () => ({
    claude: clis.claude ? { found: true, ...clis.claude } : { found: false },
    codex: clis.codex ? { found: true, ...clis.codex } : { found: false },
    dataDir: DATA,
    reportsDir: PATHS.reports,
    conversations: store.list().length,
    tools: { ffmpeg: ffmpeg ?? '', python }
  });

  async function testModel(kind) {
    const started = Date.now();
    try {
      const out = await providers[kind].run({
        prompt: '这是连接测试，请只回复两个字：正常',
        ephemeral: true,
        web: false,
        model: settings[kind].model,
        effort: 'low',
        signal: AbortSignal.timeout(120_000),
        timeoutMs: 120_000
      });
      return { ok: true, ms: Date.now() - started, text: out.text.slice(0, 200) };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: err.message };
    }
  }

  // 设置更新排队执行，两个并发保存不会交错覆盖
  let settingsChain = Promise.resolve();
  const settingsApi = {
    get: () => settings,
    update(input) {
      const run = settingsChain.then(async () => {
        const next = mergeSettings(settings, input);
        await saveSettings(PATHS.settings, next);
        settings = next;
        clis = locateAll();
        ffmpeg = locateFfmpeg({ override: settings.ffmpegPath });
        return settings;
      });
      settingsChain = run.catch(() => {});
      return run;
    }
  };

  const server = createApp({
    store,
    jobs,
    uploads,
    settings: settingsApi,
    health,
    testModel,
    reportsDir: PATHS.reports,
    log,
    onShutdown: () => {
      log.info('收到关闭请求，服务退出');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.info(`端口 ${PORT} 已有服务在运行，直接打开窗口`);
      if (process.argv.includes('--open')) openWindow();
      process.exit(0);
    }
    log.error(`服务启动失败：${err.message}`);
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    log.info(`双AI对话台已启动：${URL_BASE}/  （${count} 段对话${recovered ? `，修复 ${recovered} 段中断的对话` : ''}）`);
    log.info(`claude：${clis.claude ? `${clis.claude.file} ${clis.claude.version}` : '未找到'}`);
    log.info(`codex：${clis.codex ? `${clis.codex.file} ${clis.codex.version}` : '未找到'}`);
    log.info(`ffmpeg（HEIC 转换）：${ffmpeg ?? '未找到'}；Python（文档提取）：${python || '未找到'}`);
    if (process.argv.includes('--open')) openWindow();
  });
}

(process.argv.includes('--check') ? check() : main()).catch((err) => {
  console.error(err);
  process.exit(1);
});
