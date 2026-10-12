/**
 * iPhone 照片（HEIC/HEIF）→ JPEG。浏览器（Windows 上的 Chrome）和两个模型都不认 HEIC，上传时就在服务端转好。
 *
 * 用 ffmpeg（7.1+ 支持 HEIF 的 tile grid）。2026-10 用 ffmpeg 9.0 实测：
 * - iPhone 的网格图（多个 hvc1 小块 + grid 主图）默认映射就会拼成完整图；
 * - irot 旋转标记会自动转正（竖拍不会躺着）；
 * - 但网格内部用的是复杂滤镜，不能再叠 -vf，所以「先完整转出，再单独缩小」分两步。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { APP_ROOT } from './cli/locate.mjs';
import { rename, rm, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export const HEIC_EXT = Object.freeze(['.heic', '.heif']);
export const isHeic = (name) => HEIC_EXT.some((ext) => String(name ?? '').toLowerCase().endsWith(ext));

const IS_WIN = process.platform === 'win32';
const scaleFilter = (maxSide) => `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`;

const safeList = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** 可能的 ffmpeg 位置：环境变量 → 一键安装放的 runtime\ffmpeg → PATH → 常见安装位置。装在别处的在「设置 → 高级」里填。 */
export function ffmpegCandidates(env = process.env) {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [];
  if (env.DUAL_CHAT_FFMPEG) list.push(env.DUAL_CHAT_FFMPEG);
  list.push(join(APP_ROOT, 'runtime', 'ffmpeg', exe));
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) list.push(join(dir, exe));
  if (IS_WIN) {
    if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    if (env.USERPROFILE) list.push(join(env.USERPROFILE, 'scoop', 'shims', exe));
    if (env.ProgramFiles) list.push(join(env.ProgramFiles, 'ffmpeg', 'bin', exe));
    list.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  }
  return [...new Set(list)];
}

export function locateFfmpeg({ override, env = process.env, exists = existsSync } = {}) {
  const manual = String(override ?? '').trim();
  if (manual) return exists(manual) ? manual : null;
  return ffmpegCandidates(env).find((file) => exists(file)) ?? null;
}

/**
 * 可能的 Python 位置：环境变量 → 一键安装的便携版 runtime\python → PATH（跳过 WindowsApps 里那个只会打开应用商店的假 python）
 * → 官方安装器的默认位置。
 */
export function pythonCandidates(env = process.env) {
  const exe = IS_WIN ? 'python.exe' : 'python3';
  const list = [];
  if (env.DUAL_CHAT_PYTHON) list.push(env.DUAL_CHAT_PYTHON);
  list.push(join(APP_ROOT, 'runtime', 'python', exe));
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    if (!/WindowsApps/i.test(dir)) list.push(join(dir, exe));
  }
  if (IS_WIN && env.LOCALAPPDATA) {
    list.push(join(env.LOCALAPPDATA, 'Python', 'bin', exe));
    const programs = join(env.LOCALAPPDATA, 'Programs', 'Python');
    const versions = safeList(programs).filter((d) => /^Python3\d+$/i.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    list.push(...versions.map((d) => join(programs, d, exe)));
  }
  return [...new Set(list)];
}

export function locatePython({ env = process.env, exists = existsSync } = {}) {
  return pythonCandidates(env).find((file) => exists(file)) ?? null;
}

const LIB_PROBE = 'import importlib.util as u;print(",".join(m for m in ["fitz","pypdf","docx","openpyxl"] if u.find_spec(m)))';

/** Python 版本 + 已装的文档库（fitz=PyMuPDF / pypdf / docx=python-docx / openpyxl）。找不到返回 null。 */
export function pythonInfo(python) {
  if (!python) return null;
  const ver = spawnSync(python, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const version = `${ver.stdout ?? ''}${ver.stderr ?? ''}`.trim();
  if (ver.status !== 0 || !/python/i.test(version)) return null;
  const libs = spawnSync(python, ['-c', LIB_PROBE], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return { file: python, version, libs: String(libs.stdout ?? '').trim().split(',').filter(Boolean) };
}

/** 设置页显示用：「Python 3.14.3」之类。 */
export const pythonVersion = (python) => pythonInfo(python)?.version ?? '';

function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stderr: err.message });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const sizeOf = async (file) => (await stat(file).catch(() => null))?.size ?? 0;
const lastLines = (text) => String(text ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 300);

/**
 * HEIC → JPEG（最长边不超过 maxSide）。返回 { ok, error }。
 * run 可注入，方便测试。
 */
export async function heicToJpeg({ ffmpeg, input, output, maxSide = 2400, timeoutMs = 90_000, run = runFfmpeg }) {
  const full = `${output}.full.jpg`;
  const base = ['-hide_banner', '-loglevel', 'error', '-y'];
  const first = await run(ffmpeg, [...base, '-i', input, '-frames:v', '1', '-update', '1', '-q:v', '2', full], timeoutMs);
  if (first.code !== 0 || !(await sizeOf(full))) {
    await rm(full, { force: true });
    return { ok: false, error: lastLines(first.stderr) || `ffmpeg exit ${first.code}` };
  }
  const second = await run(ffmpeg, [...base, '-i', full, '-vf', scaleFilter(maxSide), '-frames:v', '1', '-update', '1', '-q:v', '3', output], timeoutMs);
  if (second.code === 0 && (await sizeOf(output))) {
    await rm(full, { force: true });
  } else {
    // 缩小失败就用完整尺寸的那张，至少能用
    await rename(full, output);
  }
  return { ok: true };
}
