/**
 * 界面语言：简体中文 / 日本語 / English。浏览器和服务端共用。
 * 词典在 src/i18n/<lang>.mjs；t(lang, key, vars) 找不到时退回中文，再找不到就返回 key 本身。
 */
import zh from './i18n/zh.mjs';
import ja from './i18n/ja.mjs';
import en from './i18n/en.mjs';

export const LANGS = Object.freeze(['zh', 'ja', 'en']);

/** 'ja-JP' → ja，'en-US' → en，其他（含空）→ zh。 */
export function normalizeLang(value) {
  const v = String(value ?? '').toLowerCase();
  if (v.startsWith('ja')) return 'ja';
  if (v.startsWith('en')) return 'en';
  return 'zh';
}

/** 浏览器首次打开时的默认语言：日语系统 → ja，中文系统 → zh，其他 → en。 */
export function detectLang(browserLang) {
  const v = String(browserLang ?? '').toLowerCase();
  if (v.startsWith('ja')) return 'ja';
  if (v.startsWith('zh')) return 'zh';
  return 'en';
}

export const WEEKDAYS = Object.freeze({
  zh: ['日', '一', '二', '三', '四', '五', '六'],
  ja: ['日', '月', '火', '水', '木', '金', '土'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
});

/** 英文日期要月份名（{mon} 短名、{monLong} 全名）；中日文模板用数字 {m}。 */
export const MONTHS = Object.freeze({
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  enLong: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
});

/** 给日期类模板准备的变量：{ y, m, d, mon, monLong }。 */
export const dateVars = (y, m, d) => ({ y, m, d, mon: MONTHS.en[m - 1], monLong: MONTHS.enLong[m - 1] });

const DICT = Object.freeze({ zh, ja, en });

export function t(lang, key, vars) {
  const table = DICT[normalizeLang(lang)];
  const text = table[key] ?? DICT.zh[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name]))) : text;
}

/** 方便测试：几种语言的 key 必须一一对应。 */
export const dictionaryKeys = (lang) => Object.keys(DICT[normalizeLang(lang)]);

/** 带翻译 key 的错误：HTTP 层按请求语言翻译，日志/测试里 message 是中文。 */
export function i18nError(status, key, vars) {
  return Object.assign(new Error(t('zh', key, vars)), { status, key, vars });
}
