export const PRIORITIES = ['无', '较低', '普通', '紧急', '非常紧急'];

const DAY = 86400_000;
const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const pad = (n: number) => String(n).padStart(2, '0');

export function dateLabel(ms: number) {
  const diff = Math.round((dayStart(ms) - dayStart(Date.now())) / DAY);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const d = new Date(ms);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日`;
}

export const timeLabel = (ms: number) => {
  const d = new Date(ms);
  return `${dateLabel(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 截止日当天不算过期，过了那一天才标红 */
export const isOverdue = (due: number | null, done: number | null) => due !== null && done === null && dayStart(due) < dayStart(Date.now());
/** 今天截止且未完成：卡片标琥珀色，顶栏统计 */
export const isDueToday = (due: number | null, done: number | null) => due !== null && done === null && dayStart(due) === dayStart(Date.now());

/** <input type="date"> 的值和本地零点毫秒互转 */
export function toDateInput(ms: number | null) {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const fromDateInput = (s: string) => (s ? new Date(`${s}T00:00:00`).getTime() : null);

/** 今天 + n 天的本地零点（截止日期快捷：今天 / 明天） */
export function dayFromToday(n: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()} · ${pad(d.getMonth() + 1)} · ${pad(d.getDate())}`;
};
