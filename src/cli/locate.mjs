/**
 * 找到本机的 claude / codex 可执行文件。
 *
 * - claude：npm 包里自带原生 claude.exe，优先直接用它（不经过 cmd.exe）。
 * - codex：Codex 桌面版会在 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe 放一份更新的 CLI，
 *   比 npm 全局装的旧版新（旧版不认订阅账号的新模型），所以把所有候选的版本号比一比，取最新的。
 * - npm 版 codex 优先用包里的原生 codex.exe；一键安装放在 <工具>/runtime/npm 的也会找。
 * - Windows 上 Node 不能直接 spawn .cmd，只剩 .cmd 时走 cmd.exe（见 run.mjs）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
/** 工具根目录（一键安装会把 Node / CLI 放在 <根目录>/runtime 下）。 */
export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CMD_META = /[&|<>^"%\r\n]/;

export function parseVersion(text) {
  const m = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)(-[\w.]+)?/);
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '', raw: m[0] };
}

export function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  // alpha.10 > alpha.9：按数字比较
  return a.pre.localeCompare(b.pre, undefined, { numeric: true });
}

export function readVersion(file) {
  const isCmd = /\.(cmd|bat)$/i.test(file);
  const res = isCmd
    ? CMD_META.test(file)
      ? { stdout: '', stderr: '' }
      // /s 会剥掉最外层一对引号，所以整条命令再包一层，带空格的路径才不会断
      : spawnSync('cmd.exe', ['/d', '/s', '/c', `""${file}" --version"`], { encoding: 'utf8', windowsHide: true, timeout: 15000, windowsVerbatimArguments: true })
    : spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return parseVersion(`${res.stdout ?? ''} ${res.stderr ?? ''}`);
}

function pathCandidates(name, env) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`] : [name];
  return dirs.flatMap((dir) => names.map((n) => join(dir, n)));
}

function desktopCodexCandidates(env, fsApi) {
  if (!env.LOCALAPPDATA) return [];
  const root = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  try {
    return fsApi.readdirSync(root).map((d) => join(root, d, 'codex.exe'));
  } catch {
    return [];
  }
}

const safeList = (fsApi, dir) => {
  try {
    return fsApi.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * npm 版 codex 的原生 codex.exe（直接启动，不经过 codex.cmd → node 那一层）。
 * 平台包可能嵌套在 @openai/codex/node_modules 下，也可能被提升到顶层；vendor 下的目录结构各版本不同。
 */
function npmCodexExes(npmRoot, fsApi) {
  const scopes = [join(npmRoot, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'), join(npmRoot, 'node_modules', '@openai')];
  const found = [];
  for (const scope of scopes) {
    for (const pkg of safeList(fsApi, scope).filter((d) => /^codex-win32-/.test(d))) {
      const vendor = join(scope, pkg, 'vendor');
      for (const triple of safeList(fsApi, vendor)) {
        found.push(join(vendor, triple, 'bin', 'codex.exe'), join(vendor, triple, 'codex', 'codex.exe'));
      }
    }
  }
  return found;
}

/** npm 全局目录：用户的 %APPDATA%\npm，以及一键安装放在工具自己文件夹里的 runtime\npm。 */
export function npmRoots(env = process.env) {
  return [env.APPDATA ? join(env.APPDATA, 'npm') : '', join(APP_ROOT, 'runtime', 'npm')].filter(Boolean);
}

/** 列出某个 CLI 所有可能的位置（按优先级）。 */
export function candidatesFor(name, { env = process.env, fsApi = { readdirSync } } = {}) {
  const list = [];
  const roots = npmRoots(env);
  if (name === 'claude') {
    list.push(...roots.map((r) => join(r, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')));
    if (env.USERPROFILE) list.push(join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  }
  if (name === 'codex') list.push(...desktopCodexCandidates(env, fsApi), ...roots.flatMap((r) => npmCodexExes(r, fsApi)));
  list.push(...pathCandidates(name, env));
  list.push(...roots.map((r) => join(r, IS_WIN ? `${name}.cmd` : name)));
  return [...new Set(list)];
}

/**
 * 定位 CLI。override 是用户在设置里填的路径，填了就只认它。
 * 返回 { file, version, isCmd, source } 或 null。
 */
export function locateCli(name, { override, env = process.env, exists = existsSync, versionOf = readVersion, fsApi } = {}) {
  const wrap = (file, source) => ({ file, version: versionOf(file)?.raw ?? '', isCmd: /\.(cmd|bat)$/i.test(file), source });

  if (override?.trim()) {
    const file = override.trim();
    return exists(file) ? wrap(file, '设置里指定') : null;
  }

  const found = candidatesFor(name, { env, fsApi }).filter((f) => exists(f));
  if (found.length === 0) return null;

  // .exe 优先于 .cmd；codex 多个候选时取版本最新的
  const exes = found.filter((f) => !/\.(cmd|bat)$/i.test(f));
  const pool = exes.length ? exes : found;
  if (name !== 'codex' || pool.length === 1) return wrap(pool[0], '自动查找');

  const ranked = pool
    .map((file) => ({ file, version: versionOf(file) }))
    .sort((a, b) => compareVersions(b.version, a.version));
  return { file: ranked[0].file, version: ranked[0].version?.raw ?? '', isCmd: /\.(cmd|bat)$/i.test(ranked[0].file), source: '自动查找（取最新版本）' };
}
