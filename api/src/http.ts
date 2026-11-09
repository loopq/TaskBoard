import type { Db } from './sqlite.ts';

/** 运行时环境：数据库、图片目录，以及来自 /etc/taskboard/secrets.env 的三个密钥 */
export interface Env {
  DB: Db;
  FILES_DIR: string;
  PW_ZHUHU?: string;
  PW_LVCUI?: string;
  TOKEN_SECRET?: string;
}

// 不用 TS 参数属性：Node 原生类型擦除只支持可擦除语法
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Ctx {
  req: Request;
  env: Env;
  uid: string; // 公开路由为 ''
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const bad = (field: string): never => {
  throw new HttpError(400, `参数不合法：${field}`);
};

export async function body(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>;
  throw new HttpError(400, '请求体必须是 JSON 对象');
}

/** trim 后非空；raw = true 时原样保留且允许为空（Markdown 正文） */
export function str(v: unknown, field: string, max: number, raw = false): string {
  if (typeof v !== 'string') return bad(field);
  const s = raw ? v : v.trim();
  return (raw || s) && s.length <= max ? s : bad(field);
}

export function int(v: unknown, field: string, min: number, max: number): number {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : bad(field);
}

export function num(v: unknown, field: string): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : bad(field);
}

export function bool(v: unknown, field: string): number {
  return typeof v === 'boolean' ? Number(v) : bad(field);
}

/** 动态 UPDATE：set 的 key 只来自代码里的白名单字段，不来自用户输入 */
export function update(db: Db, table: string, set: Record<string, unknown>, where: string, ...args: unknown[]) {
  const keys = Object.keys(set);
  if (!keys.length) throw new HttpError(400, '没有可更新的字段');
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${where}`;
  return db.prepare(sql).bind(...Object.values(set), ...args);
}

/**
 * 浮点排序的间隙阈值。客户端按中点插入，间隙每次减半；
 * 小于 EPS（约同位置连续插入 20 次）就整列重新编号，远早于 double 精度耗尽（约 50 次），
 * 所以顺序永远是确定的，不会出现两项 sort 相等的歧义。
 */
export const SORT_EPS = 1e-6;

export const now = () => Date.now();
