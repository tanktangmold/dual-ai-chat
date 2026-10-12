/** 把 CLI 的原始报错翻译成用户能照着做的提示（中文 / 日本語）。 */
import { t } from '../i18n.mjs';

export const LABELS = Object.freeze({ claude: 'Claude', codex: 'Codex' });

export function humanizeError(provider, raw, { model, lang = 'zh' } = {}) {
  const label = LABELS[provider] ?? provider;
  const msg = String(raw ?? '').trim();
  const shownModel = model || t(lang, 'hum.default');

  if (/not supported when using Codex with a ChatGPT account/i.test(msg)) return t(lang, 'hum.badModel', { model: shownModel });
  if (/model.*(not found|does not exist|invalid)|unknown model|invalid model/i.test(msg)) return t(lang, 'hum.unknownModel', { label, model: shownModel });
  if (/not logged in|please log ?in|login required|unauthori[sz]ed|\b401\b|invalid api key|authentication/i.test(msg)) {
    return t(lang, 'hum.login', { label, hint: t(lang, `hum.login.${provider}`) });
  }
  if (/usage limit|rate.?limit|\b429\b|quota|limit reached|too many requests/i.test(msg)) return t(lang, 'hum.limit', { label });
  if (/overloaded|\b529\b|\b503\b|temporarily unavailable/i.test(msg)) return t(lang, 'hum.busy', { label });
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|network|fetch failed/i.test(msg)) return t(lang, 'hum.network', { label });
  return msg ? t(lang, 'hum.other', { label, msg: msg.slice(0, 600) }) : t(lang, 'hum.empty', { label });
}

/** 续接旧会话失败（会话被清理了）时，改用新会话 + 带上历史重试。 */
export const isStaleSessionError = (raw) =>
  /no conversation found|session.*not found|thread.*not found|could not find.*(session|thread|conversation)|no rollout found|unknown (session|thread)/i.test(String(raw ?? ''));
