import { computed, reactive, watch } from 'vue';
import { api, session, setUnauthorizedHandler } from './api';

export type Kind = 'todo' | 'normal' | 'done';
export interface Column {
  id: string;
  name: string;
  kind: Kind;
  sort: number;
}
export interface Card {
  id: string;
  /** 任务编号 #12：全局递增，用于详情链接 /?t=12 */
  no: number;
  column_id: string;
  title: string;
  sort: number;
  priority: number;
  due_at: number | null;
  done_at: number | null;
  sub_total: number;
  sub_done: number;
  comment_count: number;
}

export const state = reactive({
  user: session.token ? session.user : null,
  columns: [] as Column[],
  tasks: [] as Card[],
  loaded: false,
  openId: null as string | null,
  toast: '',
});

export const columns = computed(() => [...state.columns].sort((a, b) => a.sort - b.sort));

export const byColumn = computed(() => {
  const m: Record<string, Card[]> = {};
  for (const c of state.columns) m[c.id] = [];
  for (const t of state.tasks) (m[t.column_id] ??= []).push(t);
  for (const list of Object.values(m)) list.sort((a, b) => a.sort - b.sort);
  return m;
});

const columnOf = (kind: Kind) => state.columns.find((c) => c.kind === kind)!;
export const findTask = (id: string) => state.tasks.find((t) => t.id === id);

/** 插到两个 sort 之间；服务端发现间隙过小时会整列重编号并返回 renumbered */
export function between(prev?: number, next?: number) {
  if (prev === undefined) return next === undefined ? 1 : next - 1;
  return next === undefined ? prev + 1 : (prev + next) / 2;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string) {
  state.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (state.toast = ''), 3200);
}

/** 统一错误处理：提示服务端给的原因，再拉一次看板把乐观更新对齐回服务端状态 */
export async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast((e as Error).message);
    await load().catch(() => {});
  }
}

/** 移动 / 完成 / 取消完成会产生系统动态：通知打开着的详情抽屉重拉时间线 */
export const lastChange = reactive({ id: '', n: 0 });
const changed = (id: string) => Object.assign(lastChange, { id, n: lastChange.n + 1 });

function upsert(card: Card) {
  const t = findTask(card.id);
  if (t) Object.assign(t, card);
  else state.tasks.push(card);
}

// ---- 详情链接 /?t=12 ----
// 打开详情时写进地址栏、关闭时清掉；用 replaceState 不产生历史记录，不用处理返回键。
// 查询参数而不是 /t/12 路径：服务端静态白名单和 Service Worker 的导航缓存都不用改
export const taskUrl = (no: number) => `${location.origin}/?t=${no}`;
const urlNo = () => Number(new URLSearchParams(location.search).get('t')) || 0;
watch(
  () => state.openId,
  (id) => {
    const no = id ? findTask(id)?.no : undefined;
    history.replaceState(history.state, '', no ? `/?t=${no}` : '/');
  },
);

/** 每次拉完看板：地址栏带 ?t= 就打开那条（首次打开链接、登录后都走这里；已打开时是 no-op） */
function openFromUrl() {
  const no = urlNo();
  if (!no) return;
  const t = state.tasks.find((t) => t.no === no);
  if (t) return void (state.openId = t.id);
  toast(`任务 #${no} 不存在`);
  history.replaceState(history.state, '', '/');
}

export async function load() {
  if (!state.user) return;
  const b = await api<{ columns: Column[]; tasks: Card[] }>('GET', '/board');
  state.columns = b.columns;
  state.tasks = b.tasks;
  state.loaded = true;
  openFromUrl();
}

export async function login(user: string, password: string) {
  const r = await api<{ user: string; token: string }>('POST', '/login', { user, password });
  session.save(r.user, r.token);
  state.user = r.user;
  await load();
}

export function logout() {
  session.clear();
  // 图片 Cookie 是 HttpOnly，前端删不掉，让服务端下发过期；失败也无妨，Cookie 里的 token 到期自然失效
  api('POST', '/logout').catch(() => {});
  Object.assign(state, { user: null, columns: [], tasks: [], loaded: false, openId: null });
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  logout();
  toast('登录已失效，请重新输入密码');
});

// ---- 列 ----

export const addColumn = (name: string) =>
  run(async () => state.columns.push(await api<Column>('POST', '/columns', { name })));

export const renameColumn = (id: string, name: string) =>
  run(async () => {
    const r = await api<{ column: Column }>('PATCH', `/columns/${id}`, { name });
    Object.assign(state.columns.find((c) => c.id === id)!, r.column);
  });

export const deleteColumn = (id: string) =>
  run(async () => {
    await api('DELETE', `/columns/${id}`);
    state.columns = state.columns.filter((c) => c.id !== id);
  });

/** index：在普通列之间的目标位置；前邻缺省是「待处理」，后邻缺省表示排到最后（「已完成」之前） */
export function moveColumn(id: string, index: number) {
  const normals = columns.value.filter((c) => c.kind === 'normal' && c.id !== id);
  const sort = between(normals[index - 1]?.sort ?? columnOf('todo').sort, normals[index]?.sort);
  const col = state.columns.find((c) => c.id === id)!;
  col.sort = sort;
  return run(async () => {
    const r = await api<{ column: Column; renumbered: boolean }>('PATCH', `/columns/${id}`, { sort });
    Object.assign(col, r.column);
    if (r.renumbered) await load();
  });
}

// ---- 任务 ----

export const addTask = (column_id: string, title: string) =>
  run(async () => upsert(await api<Card>('POST', '/tasks', { column_id, title })));

/** index：目标列里（不含自己）的目标位置，超出长度即排到最后 */
export function moveTask(id: string, columnId: string, index: number) {
  const list = (byColumn.value[columnId] ?? []).filter((t) => t.id !== id);
  const sort = between(list[index - 1]?.sort, list[index]?.sort);
  const t = findTask(id)!;
  Object.assign(t, { column_id: columnId, sort });
  return run(async () => {
    const r = await api<{ task: Card; renumbered: boolean }>('POST', `/tasks/${id}/move`, { column_id: columnId, sort });
    upsert(r.task);
    changed(id);
    if (r.renumbered) await load();
  });
}

export function complete(id: string) {
  // 乐观：和服务端同规则，排到「已完成」最上面
  const done = columnOf('done');
  const top = byColumn.value[done.id]?.[0]?.sort ?? 1;
  Object.assign(findTask(id)!, { column_id: done.id, sort: top - 1, done_at: Date.now() });
  return run(async () => {
    upsert(await api<Card>('POST', `/tasks/${id}/complete`));
    changed(id);
  });
}

/** 回到哪一列由服务端决定（原列已删则回「待处理」） */
export const uncomplete = (id: string) =>
  run(async () => {
    upsert(await api<Card>('POST', `/tasks/${id}/uncomplete`));
    changed(id);
  });

export const patchTask = (id: string, fields: Partial<Pick<Card, 'title' | 'priority' | 'due_at'>> & { desc_md?: string }) =>
  run(async () => upsert(await api<Card>('PATCH', `/tasks/${id}`, fields)));

export const deleteTask = (id: string) =>
  run(async () => {
    await api('DELETE', `/tasks/${id}`);
    state.tasks = state.tasks.filter((t) => t.id !== id);
    if (state.openId === id) state.openId = null;
  });
