/**
 * 统一的 provider 接口：run({ prompt, sessionId, ... }) → { text, sessionId, structured }。
 * 失败抛出带提示的 Error（按 lang 翻译），err.stale 表示「续接的旧会话已失效，可以开新会话重试」。
 *
 * 附件：readFiles=true 时 Claude 拿到只限 ./uploads/** 的 Read 工具；images 是给 Codex 的图片绝对路径（--image）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runJsonl } from '../cli/run.mjs';
import { claudeAdapter } from './claude.mjs';
import { codexAdapter } from './codex.mjs';
import { humanizeError, isStaleSessionError, LABELS } from './errors.mjs';
import { t } from '../i18n.mjs';

const ADAPTERS = Object.freeze({ claude: claudeAdapter, codex: codexAdapter });
/** Claude Code settings.json 的 language 取值 */
const CLAUDE_LANGUAGE = Object.freeze({ zh: 'chinese', ja: 'japanese', en: 'english' });

async function jsonFileFor(dir, prefix, value) {
  const body = JSON.stringify(value);
  const file = join(dir, `${prefix}-${createHash('sha1').update(body).digest('hex').slice(0, 12)}.json`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, body, 'utf8');
  return file;
}

/**
 * @param kind 'claude' | 'codex'
 * @param getCli () => { file, isCmd } | null —— 每次调用时取，设置里改了路径立即生效
 */
export function createProvider(kind, { getCli, cwd, tmpDir, run = runJsonl }) {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new Error(`unknown provider: ${kind}`);

  return {
    kind,
    supportsSystemPrompt: adapter.supportsSystemPrompt,
    async run({ prompt, sessionId, web, model, effort, systemPrompt, schema, ephemeral, readFiles, images, signal, onEvent, timeoutMs, lang = 'zh' }) {
      const cli = getCli();
      if (!cli) throw new Error(t(lang, 'err.cliMissing', { kind, label: LABELS[kind] }));

      // claude 的 schema 直接走参数（含引号，cmd.exe 兜底模式下传不了就退回提示词约束）
      const claudeSchema = kind === 'claude' && schema && !cli.isCmd ? schema : undefined;
      const schemaFile = kind === 'codex' && schema ? await jsonFileFor(tmpDir, 'schema', schema) : undefined;
      const settingsFile = kind === 'claude' ? await jsonFileFor(tmpDir, 'claude-settings', { language: CLAUDE_LANGUAGE[lang] ?? 'chinese' }) : undefined;
      const args = adapter.buildArgs({
        sessionId, web, model, effort, systemPrompt, schema: claudeSchema, schemaFile, settingsFile, ephemeral, cwd,
        readFiles: kind === 'claude' && Boolean(readFiles),
        images: kind === 'codex' ? images ?? [] : []
      });

      let state = adapter.initial();
      let code;
      let stderr;
      try {
        ({ code, stderr } = await run({
          cli,
          args,
          stdin: prompt,
          cwd,
          signal,
          timeoutMs,
          onLine(obj) {
            const reduced = adapter.reduce(state, obj);
            state = reduced.state;
            for (const event of reduced.events) onEvent?.(event);
          }
        }));
      } catch (err) {
        if (err.timeout) err.message = t(lang, 'cli.timeout', { n: Math.round(timeoutMs / 60000) });
        throw err;
      }

      const out = adapter.finish(state, { code, stderr });
      if (out.error) {
        throw Object.assign(new Error(humanizeError(kind, out.error, { model, lang })), {
          raw: out.error,
          stale: Boolean(sessionId) && (isStaleSessionError(out.error) || isStaleSessionError(stderr)),
          partial: state.text
        });
      }
      return out;
    }
  };
}
