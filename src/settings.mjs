/** 设置：data/settings.json。校验后整体替换，不原地改。 */
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export const EFFORTS = Object.freeze({
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'minimal', 'low', 'medium', 'high', 'xhigh']
});

/** 裁判推理强度：两家都支持的那几档。实测 Claude 裁判 低≈18s / 中≈28s / 默认≈46s，结论一致。 */
export const JUDGE_EFFORTS = Object.freeze(['', 'low', 'medium', 'high', 'xhigh']);

export const DEFAULT_SETTINGS = Object.freeze({
  judge: 'claude',
  judgeEffort: 'low',
  ffmpegPath: '',
  web: true,
  timeoutMin: 10,
  claude: Object.freeze({ model: '', effort: '', path: '' }),
  codex: Object.freeze({ model: '', effort: 'medium', path: '' })
});

const MODEL_RE = /^[\w.:\-[\]/]{0,64}$/;

class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function cleanModelConfig(kind, input = {}, base) {
  const model = String(input.model ?? base.model ?? '').trim();
  const effort = String(input.effort ?? base.effort ?? '').trim();
  const path = String(input.path ?? base.path ?? '').trim();
  if (!MODEL_RE.test(model)) throw new SettingsError(`${kind} 模型名只能包含字母、数字和 . - _ : /`);
  if (!EFFORTS[kind].includes(effort)) throw new SettingsError(`${kind} 推理强度只能是：${EFFORTS[kind].filter(Boolean).join(' / ')}，或留空`);
  if (path && (!isAbsolute(path) || !/\.(exe|cmd)$/i.test(path) || path.length > 260)) {
    throw new SettingsError(`${kind} 路径必须是 .exe 或 .cmd 的完整路径`);
  }
  return Object.freeze({ model, effort, path });
}

/** 校验并合并：input 只需要带要改的字段。 */
export function mergeSettings(base, input = {}) {
  const judge = input.judge ?? base.judge;
  if (!['claude', 'codex'].includes(judge)) throw new SettingsError('裁判只能是 claude 或 codex');
  const judgeEffort = String(input.judgeEffort ?? base.judgeEffort ?? '');
  if (!JUDGE_EFFORTS.includes(judgeEffort)) throw new SettingsError(`裁判推理强度只能是：${JUDGE_EFFORTS.filter(Boolean).join(' / ')}，或留空`);
  const ffmpegPath = String(input.ffmpegPath ?? base.ffmpegPath ?? '').trim();
  if (ffmpegPath && (!isAbsolute(ffmpegPath) || ffmpegPath.length > 260 || (process.platform === 'win32' && !/\.exe$/i.test(ffmpegPath)))) {
    throw new SettingsError('ffmpeg 路径必须是 ffmpeg.exe 的完整路径');
  }
  const timeoutMin = Number(input.timeoutMin ?? base.timeoutMin);
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > 60) throw new SettingsError('超时时间要在 1~60 分钟之间');
  return Object.freeze({
    judge,
    judgeEffort,
    ffmpegPath,
    web: Boolean(input.web ?? base.web),
    timeoutMin,
    claude: cleanModelConfig('claude', input.claude, base.claude),
    codex: cleanModelConfig('codex', input.codex, base.codex)
  });
}

/** 读你 ~/.codex/config.toml 里的 model 当默认值（我们跳过了用户配置，得自己带上模型）。 */
export async function codexConfigModel(home = homedir()) {
  try {
    const text = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const top = text.split(/^\s*\[/m)[0];
    return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** 逐项合并：某一项不合法只丢那一项（记警告），不把整份设置重置掉。 */
function mergeLeniently(saved, log) {
  let merged = DEFAULT_SETTINGS;
  for (const [key, value] of Object.entries(saved ?? {})) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    try {
      merged = mergeSettings(merged, { [key]: value });
    } catch (err) {
      log.warn?.(`[settings] 设置项 ${key} 不合法，已用默认值：${err.message}`);
    }
  }
  return merged;
}

export async function loadSettings(file, { home, log = console } = {}) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn?.(`[settings] 读取设置失败，使用默认值：${err.message}`);
    saved = {};
  }
  const merged = mergeLeniently(saved, log);
  if (merged.codex.model || saved.codex?.model === '') return merged;
  const model = await codexConfigModel(home);
  return model && MODEL_RE.test(model) ? mergeSettings(merged, { codex: { model } }) : merged;
}

/** 先写临时文件再改名，写到一半崩溃也不会留下半个 JSON。 */
export async function saveSettings(file, settings) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
