import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * 与 Cloudflare D1 同形的最小子集（prepare / bind / first / all / run / batch），
 * 业务 handler 从 D1 迁过来一行不用改。node:sqlite 是同步的，这里只是包成 Promise。
 */
export interface Stmt {
  bind(...args: unknown[]): Stmt;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Db {
  prepare(sql: string): Stmt;
  /** 事务：全部成功或全部回滚（与 D1 batch 语义一致） */
  batch(stmts: Stmt[]): Promise<{ results: unknown[] }[]>;
}

const SCHEMA = new URL('../schema.sql', import.meta.url);

/**
 * 旧库补 tasks.no（任务编号），按创建顺序回填 1..n。必须在 schema.sql 之前跑：
 * schema.sql 里的唯一索引引用 no 列。新库没有 tasks 表、或已有 no 列时什么都不做。
 */
function migrate(raw: DatabaseSync) {
  const cols = raw.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === 'no')) return;
  raw.exec('BEGIN IMMEDIATE');
  try {
    raw.exec(`ALTER TABLE tasks ADD COLUMN no INTEGER;
      UPDATE tasks SET no = r.n FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, rowid) AS n FROM tasks) AS r
      WHERE tasks.id = r.id;`);
    raw.exec('COMMIT');
  } catch (e) {
    raw.exec('ROLLBACK');
    throw e;
  }
}

export function openDb(path: string): Db & { raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;`);
  migrate(raw);
  raw.exec(readFileSync(SCHEMA, 'utf8')); // 幂等：CREATE ... IF NOT EXISTS

  // 预编译缓存：SQL 都来自代码（动态 UPDATE 的列名也来自白名单），组合数有限
  const cache = new Map<string, StatementSync>();
  const compiled = (sql: string) => cache.get(sql) ?? cache.set(sql, raw.prepare(sql)).get(sql)!;

  type Bound = Stmt & { sql: string; args: SQLInputValue[] };
  const stmt = (sql: string, args: SQLInputValue[] = []): Bound => ({
    sql,
    args,
    bind: (...a) => stmt(sql, a as SQLInputValue[]),
    first: async <T>(column?: string) => {
      const row = compiled(sql).get(...args) as Record<string, unknown> | undefined;
      return (row === undefined ? null : column ? (row[column] ?? null) : row) as T | null;
    },
    all: async <T>() => ({ results: compiled(sql).all(...args) as T[] }),
    run: async () => ({ meta: { changes: Number(compiled(sql).run(...args).changes) } }),
  });

  return {
    raw,
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      // 同步执行、中间没有 await，单进程内不会和其他请求交错
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = (stmts as Bound[]).map((s) => ({ results: compiled(s.sql).all(...s.args) as unknown[] }));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
