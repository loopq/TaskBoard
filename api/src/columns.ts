import { type Ctx, HttpError, SORT_EPS, body, json, num, str, update } from './http.ts';
import type { Db } from './sqlite.ts';

/** todo / done 的 sort 固定不动，normal 列只能落在两者之间 */
const TODO_SORT = 0;
const DONE_SORT = 1e9;

export interface Column {
  id: string;
  name: string;
  kind: 'todo' | 'normal' | 'done';
  sort: number;
}

/**
 * 首次访问时建默认三列。只在「一列都没有」时触发，所以删掉的「进行中」不会被重建；
 * id 是确定性的 + INSERT OR IGNORE，两个请求同时首访也不会建出重复列。
 */
export async function ensureColumns(db: Db, uid: string) {
  if (await db.prepare('SELECT 1 FROM columns WHERE owner = ? LIMIT 1').bind(uid).first()) return;
  const ins = db.prepare('INSERT OR IGNORE INTO columns (id, owner, name, kind, sort) VALUES (?, ?, ?, ?, ?)');
  await db.batch([
    ins.bind(`${uid}-todo`, uid, '待处理', 'todo', TODO_SORT),
    ins.bind(`${uid}-doing`, uid, '进行中', 'normal', 1),
    ins.bind(`${uid}-done`, uid, '已完成', 'done', DONE_SORT),
  ]);
}

export async function ownColumn(db: Db, uid: string, id: string) {
  const col = await db.prepare('SELECT id, name, kind, sort FROM columns WHERE id = ? AND owner = ?').bind(id, uid).first<Column>();
  if (!col) throw new HttpError(404, '列不存在');
  return col;
}

async function ownNormalColumn(db: Db, uid: string, id: string) {
  const col = await ownColumn(db, uid, id);
  if (col.kind !== 'normal') throw new HttpError(409, '「待处理」「已完成」是锁定列，不能改名、排序或删除');
  return col;
}

/** 间隙小于 SORT_EPS（含与 todo/done 的间隙）时，把 normal 列重排为 1..n */
async function settleColumns(db: Db, uid: string, id: string, sort: number) {
  const gap = await db
    .prepare('SELECT MIN(ABS(sort - ?1)) AS g FROM columns WHERE owner = ?2 AND id != ?3')
    .bind(sort, uid, id)
    .first<number | null>('g');
  if (gap === null || gap >= SORT_EPS) return false;
  await db
    .prepare(
      `UPDATE columns SET sort = r.n FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY sort, id) AS n FROM columns WHERE owner = ?1 AND kind = 'normal'
       ) AS r WHERE columns.id = r.id`,
    )
    .bind(uid)
    .run();
  return true;
}

export async function createColumn({ req, env, uid }: Ctx) {
  const name = str((await body(req)).name, 'name', 50);
  const db = env.DB;
  await ensureColumns(db, uid);
  const id = crypto.randomUUID();
  // 新列追加在「已完成」前：非 done 列最大 sort + 1。done 固定 1e9，列数到不了这个量级
  await db
    .prepare(
      `INSERT INTO columns (id, owner, name, kind, sort)
       SELECT ?1, ?2, ?3, 'normal', MAX(sort) + 1 FROM columns WHERE owner = ?2 AND kind != 'done'`,
    )
    .bind(id, uid, name)
    .run();
  return json(await ownColumn(db, uid, id), 201);
}

export async function patchColumn({ req, env, uid }: Ctx, [id]: string[]) {
  const b = await body(req);
  const db = env.DB;
  await ownNormalColumn(db, uid, id);
  const set: Record<string, unknown> = {};
  if ('name' in b) set.name = str(b.name, 'name', 50);
  if ('sort' in b) {
    const sort = num(b.sort, 'sort');
    if (!(sort > TODO_SORT && sort < DONE_SORT)) throw new HttpError(400, '列只能排在「待处理」和「已完成」之间');
    set.sort = sort;
  }
  await update(db, 'columns', set, 'id = ? AND owner = ?', id, uid).run();
  const renumbered = typeof set.sort === 'number' && (await settleColumns(db, uid, id, set.sort));
  return json({ column: await ownColumn(db, uid, id), renumbered });
}

export async function deleteColumn({ env, uid }: Ctx, [id]: string[]) {
  const db = env.DB;
  await ownNormalColumn(db, uid, id);
  // 条件删除：「检查为空」和「删除」在同一条语句里，没有竞态
  const r = await db
    .prepare('DELETE FROM columns WHERE id = ?1 AND owner = ?2 AND NOT EXISTS (SELECT 1 FROM tasks WHERE owner = ?2 AND column_id = ?1)')
    .bind(id, uid)
    .run();
  if (!r.meta.changes) throw new HttpError(409, '列里还有任务，不能删除');
  return json({ ok: true });
}
