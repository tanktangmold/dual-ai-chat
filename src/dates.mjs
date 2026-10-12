/** 本机时区的日期工具。服务端和浏览器在同一台电脑上，时区一致。 */

const pad = (n) => String(n).padStart(2, '0');

/** ISO 时间 → 本地日期 YYYY-MM-DD。 */
export function localDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时间戳 YYYYMMDD-HHmmss，用于生成可读的 ID。 */
export function localStamp(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
