import { ensureColumns, ownColumn } from './columns.ts';
import { type Ctx, HttpError, SORT_EPS, body, bool, int, json, now, num, str, update } from './http.ts';
import type { Db } from './sqlite.ts';

/**
 * 看板卡片：带子任务进度和评论数（只数 user 评论）。
 * 已知天花板：/board 一次返回全部任务（含所有已完成）。两个人用，几千条以内无压力；
 * 以后「已完成」太多再给它加分页 / 只返回最近 N 条。
 */
const CARD_SQL = `SELECT t.id, t.column_id, t.title, t.sort, t.priority, t.due_at, t.done_at,
  (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id) AS sub_total,
  (SELECT COUNT(*) FROM subtasks s WHERE s.task_id = t.id AND s.done = 1) AS sub_done,
  (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id AND c.kind = 'user') AS comment_count
  FROM tasks t WHERE t.owner = ?1`;

const card = (db: Db, uid: string, id: string) => db.prepare(`${CARD_SQL} AND t.id = ?2`).bind(uid, id).first();

interface TaskRow {
  id: string;
  column_id: string;
  done_at: number | null;
  prev_column_id: string | null;
}

/** 越权和不存在一律 404：所有子资源操作都先过这一关 */
async function ownTask(db: Db, uid: string, id: string) {
  const t = await db
    .prepare('SELECT id, column_id, done_at, prev_column_id FROM tasks WHERE id = ? AND owner = ?')
    .bind(id, uid)
    .first<TaskRow>();
  if (!t) throw new HttpError(404, '任务不存在');
  return t;
}

const comment = (db: Db, taskId: string, kind: 'user' | 'system', text: string, t: number, id = crypto.randomUUID()) =>
  db.prepare('INSERT INTO comments (id, task_id, kind, body_md, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, taskId, kind, text, t);

function taskFields(b: Record<string, unknown>) {
  const set: Record<string, unknown> = {};
  if ('title' in b) set.title = str(b.title, 'title', 200);
  if ('desc_md' in b) set.desc_md = str(b.desc_md, 'desc_md', 100_000, true);
  if ('priority' in b) set.priority = int(b.priority, 'priority', 0, 4);
  if ('due_at' in b) set.due_at = b.due_at === null ? null : int(b.due_at, 'due_at', 0, 8.64e15);
  return set;
}

/** 间隙小于 SORT_EPS 时把整列重排为 1..n（见 http.ts SORT_EPS 注释） */
async function settleTasks(db: Db, uid: string, colId: string, id: string, sort: number) {
  const gap = await db
    .prepare('SELECT MIN(ABS(sort - ?1)) AS g FROM tasks WHERE owner = ?2 AND column_id = ?3 AND id != ?4')
    .bind(sort, uid, colId, id)
    .first<number | null>('g');
  if (gap === null || gap >= SORT_EPS) return false;
  await db
    .prepare(
      `UPDATE tasks SET sort = r.n FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort, id) AS n FROM tasks WHERE owner = ?1 AND column_id = ?2
       ) AS r WHERE tasks.id = r.id`,
    )
    .bind(uid, colId)
    .run();
  return true;
}

export async function board({ env, uid }: Ctx) {
  const db = env.DB;
  await ensureColumns(db, uid);
  const [columns, tasks] = await db.batch([
    db.prepare('SELECT id, name, kind, sort FROM columns WHERE owner = ? ORDER BY sort').bind(uid),
    db.prepare(`${CARD_SQL} ORDER BY t.sort`).bind(uid),
  ]);
  return json({ user: uid, columns: columns.results, tasks: tasks.results });
}

export async function createTask({ req, env, uid }: Ctx) {
  const b = await body(req);
  const f = { desc_md: '', priority: 0, due_at: null, ...taskFields(b), title: str(b.title, 'title', 200) };
  const db = env.DB;
  const col = await ownColumn(db, uid, str(b.column_id, 'column_id', 64));
  if (col.kind === 'done') throw new HttpError(400, '不能在「已完成」里新建任务');
  const id = crypto.randomUUID();
  const t = now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO tasks (id, owner, column_id, title, desc_md, priority, due_at, sort, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(MAX(sort), 0) + 1, ?8, ?8 FROM tasks WHERE owner = ?2 AND column_id = ?3`,
      )
      .bind(id, uid, col.id, f.title, f.desc_md, f.priority, f.due_at, t),
    comment(db, id, 'system', '创建了任务', t),
  ]);
  return json(await card(db, uid, id), 201);
}

export async function getTask({ env, uid }: Ctx, [id]: string[]) {
  const db = env.DB;
  // 子表都 JOIN tasks 校验 owner，一次往返取齐
  const [task, subtasks, timeline] = await db.batch([
    db.prepare('SELECT * FROM tasks WHERE id = ? AND owner = ?').bind(id, uid),
    db
      .prepare('SELECT s.id, s.title, s.done, s.sort FROM subtasks s JOIN tasks t ON t.id = s.task_id WHERE t.id = ? AND t.owner = ? ORDER BY s.sort')
      .bind(id, uid),
    db
      .prepare(
        'SELECT c.id, c.kind, c.body_md, c.created_at FROM comments c JOIN tasks t ON t.id = c.task_id WHERE t.id = ? AND t.owner = ? ORDER BY c.created_at, c.rowid',
      )
      .bind(id, uid),
  ]);
  if (!task.results.length) throw new HttpError(404, '任务不存在');
  return json({ task: task.results[0], subtasks: subtasks.results, timeline: timeline.results });
}

export async function patchTask({ req, env, uid }: Ctx, [id]: string[]) {
  const set = taskFields(await body(req));
  if (!Object.keys(set).length) throw new HttpError(400, '没有可更新的字段');
  const r = await update(env.DB, 'tasks', { ...set, updated_at: now() }, 'id = ? AND owner = ?', id, uid).run();
  if (!r.meta.changes) throw new HttpError(404, '任务不存在');
  return json(await card(env.DB, uid, id));
}

export async function deleteTask({ env, uid }: Ctx, [id]: string[]) {
  // 子任务、评论由外键 ON DELETE CASCADE 级联删除；图片文件不清理（见设计文档 §6）
  const r = await env.DB.prepare('DELETE FROM tasks WHERE id = ? AND owner = ?').bind(id, uid).run();
  if (!r.meta.changes) throw new HttpError(404, '任务不存在');
  return json({ ok: true });
}

export async function moveTask({ req, env, uid }: Ctx, [id]: string[]) {
  const b = await body(req);
  const sort = num(b.sort, 'sort');
  const db = env.DB;
  const [task, col] = await Promise.all([ownTask(db, uid, id), ownColumn(db, uid, str(b.column_id, 'column_id', 64))]);
  // 「已完成」只能通过 complete / uncomplete 进出：已完成的任务只能组内排序，未完成的不能拖进去
  if ((task.done_at !== null) !== (col.kind === 'done')) {
    throw new HttpError(400, task.done_at !== null ? '已完成的任务请用「取消完成」移出' : '不能拖入「已完成」，请点「完成任务」');
  }
  const t = now();
  const stmts = [db.prepare('UPDATE tasks SET column_id = ?, sort = ?, updated_at = ? WHERE id = ? AND owner = ?').bind(col.id, sort, t, id, uid)];
  if (col.id !== task.column_id) stmts.push(comment(db, id, 'system', `移动到「${col.name}」`, t));
  await db.batch(stmts);
  const renumbered = await settleTasks(db, uid, col.id, id, sort);
  return json({ task: await card(db, uid, id), renumbered });
}

export async function complete({ env, uid }: Ctx, [id]: string[]) {
  const db = env.DB;
  const task = await ownTask(db, uid, id);
  if (task.done_at !== null) throw new HttpError(409, '任务已经完成了');
  const done = (await db.prepare("SELECT id FROM columns WHERE owner = ? AND kind = 'done'").bind(uid).first<string>('id'))!;
  const t = now();
  // 记下来源列；新完成的排在「已完成」最上面
  await db.batch([
    db
      .prepare(
        `UPDATE tasks SET prev_column_id = column_id, column_id = ?3, done_at = ?4, updated_at = ?4,
           sort = (SELECT COALESCE(MIN(sort), 1) - 1 FROM tasks WHERE owner = ?2 AND column_id = ?3)
         WHERE id = ?1 AND owner = ?2`,
      )
      .bind(id, uid, done, t),
    comment(db, id, 'system', '完成了任务', t),
  ]);
  return json(await card(db, uid, id));
}

export async function uncomplete({ env, uid }: Ctx, [id]: string[]) {
  const db = env.DB;
  const task = await ownTask(db, uid, id);
  if (task.done_at === null) throw new HttpError(409, '任务还没有完成');
  // 原列还在就回原列，否则回「待处理」：ORDER BY 让原列排在 todo 前面，一条查询消掉分支
  const col = (await db
    .prepare(
      `SELECT id, name FROM columns WHERE owner = ?1 AND ((id = ?2 AND kind != 'done') OR kind = 'todo')
       ORDER BY kind = 'todo' LIMIT 1`,
    )
    .bind(uid, task.prev_column_id)
    .first<{ id: string; name: string }>())!;
  const t = now();
  await db.batch([
    db
      .prepare(
        `UPDATE tasks SET column_id = ?3, prev_column_id = NULL, done_at = NULL, updated_at = ?4,
           sort = (SELECT COALESCE(MAX(sort), 0) + 1 FROM tasks WHERE owner = ?2 AND column_id = ?3)
         WHERE id = ?1 AND owner = ?2`,
      )
      .bind(id, uid, col.id, t),
    comment(db, id, 'system', `取消完成，回到「${col.name}」`, t),
  ]);
  return json(await card(db, uid, id));
}

const subtask = (db: Db, id: string) => db.prepare('SELECT id, title, done, sort FROM subtasks WHERE id = ?').bind(id).first();

export async function createSubtask({ req, env, uid }: Ctx, [tid]: string[]) {
  const title = str((await body(req)).title, 'title', 200);
  const db = env.DB;
  await ownTask(db, uid, tid);
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO subtasks (id, task_id, title, done, sort) SELECT ?1, ?2, ?3, 0, COALESCE(MAX(sort), 0) + 1 FROM subtasks WHERE task_id = ?2')
    .bind(id, tid, title)
    .run();
  return json(await subtask(db, id), 201);
}

export async function patchSubtask({ req, env, uid }: Ctx, [tid, sid]: string[]) {
  const b = await body(req);
  const set: Record<string, unknown> = {};
  if ('title' in b) set.title = str(b.title, 'title', 200);
  if ('done' in b) set.done = bool(b.done, 'done');
  const db = env.DB;
  await ownTask(db, uid, tid);
  const r = await update(db, 'subtasks', set, 'id = ? AND task_id = ?', sid, tid).run();
  if (!r.meta.changes) throw new HttpError(404, '子任务不存在');
  return json(await subtask(db, sid));
}

export async function deleteSubtask({ env, uid }: Ctx, [tid, sid]: string[]) {
  const db = env.DB;
  await ownTask(db, uid, tid);
  const r = await db.prepare('DELETE FROM subtasks WHERE id = ? AND task_id = ?').bind(sid, tid).run();
  if (!r.meta.changes) throw new HttpError(404, '子任务不存在');
  return json({ ok: true });
}

export async function createComment({ req, env, uid }: Ctx, [tid]: string[]) {
  const text = str((await body(req)).body_md, 'body_md', 20_000);
  const db = env.DB;
  await ownTask(db, uid, tid);
  const c = { id: crypto.randomUUID(), kind: 'user' as const, body_md: text, created_at: now() };
  await comment(db, tid, c.kind, c.body_md, c.created_at, c.id).run();
  return json(c, 201);
}

export async function deleteComment({ env, uid }: Ctx, [tid, cid]: string[]) {
  const db = env.DB;
  await ownTask(db, uid, tid);
  const kind = await db.prepare('SELECT kind FROM comments WHERE id = ? AND task_id = ?').bind(cid, tid).first<string>('kind');
  if (!kind) throw new HttpError(404, '评论不存在');
  if (kind === 'system') throw new HttpError(409, '系统动态不能删除');
  await db.prepare('DELETE FROM comments WHERE id = ?').bind(cid).run();
  return json({ ok: true });
}
