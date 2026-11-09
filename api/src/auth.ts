import { timingSafeEqual } from 'node:crypto';
import { type Ctx, type Env, HttpError, body, json, now } from './http.ts';

const PASSWORDS = { zhuhu: 'PW_ZHUHU', lvcui: 'PW_LVCUI' } as const;
type User = keyof typeof PASSWORDS;

const TTL = 365 * 86400_000;
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60_000;

const enc = new TextEncoder();
const isUser = (u: unknown): u is User => typeof u === 'string' && Object.hasOwn(PASSWORDS, u);
const unauthorized = () => new HttpError(401, '未登录或登录已失效');

const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function hmacKey(env: Env) {
  // 防止忘记设置 secret 时用空密钥/弱密钥签 token
  if (!env.TOKEN_SECRET || env.TOKEN_SECRET.length < 16) throw new HttpError(503, '服务器未配置 TOKEN_SECRET');
  return crypto.subtle.importKey('raw', enc.encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** 先 SHA-256 再比较，消除长度差异，然后常量时间比较 */
async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return timingSafeEqual(new Uint8Array(x), new Uint8Array(y));
}

/** token = b64u("user.exp") + "." + b64u(HMAC-SHA256(TOKEN_SECRET, "user.exp")) */
async function sign(env: Env, user: User, exp: number) {
  const payload = enc.encode(`${user}.${exp}`);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), payload);
  return `${b64u(payload)}.${b64u(sig)}`;
}

async function verify(env: Env, token: string | undefined): Promise<User> {
  const m = /^([\w-]+)\.([\w-]+)$/.exec(token ?? '');
  if (!m) throw unauthorized();
  const key = await hmacKey(env);
  let payload: Uint8Array, sig: Uint8Array;
  try {
    [payload, sig] = [unb64u(m[1]), unb64u(m[2])];
  } catch {
    throw unauthorized();
  }
  if (!(await crypto.subtle.verify('HMAC', key, sig, payload))) throw unauthorized();
  const [user, exp] = new TextDecoder().decode(payload).split('.');
  if (!isUser(user) || !(Number(exp) > now())) throw unauthorized();
  return user;
}

const bearer = (req: Request) => /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1];

/** 业务接口只认 Bearer：图片 Cookie 不能用来调其他接口，不引入 CSRF 面 */
export const authenticate = (req: Request, env: Env) => verify(env, bearer(req));

// ---- 图片 Cookie：<img> 带不了 Authorization 头，读图只能靠 Cookie ----
// 值就是 Bearer token（不另造凭据）；Path 限定 /api/files，HttpOnly 让 JS 读不到。
const FILE_COOKIE = 'tb_files';
const fileCookieOf = (req: Request) => /(?:^|;\s*)tb_files=([\w.-]+)/.exec(req.headers.get('cookie') ?? '')?.[1];

/** 读图鉴权：先 Bearer（skill / curl），再 Cookie（浏览器） */
export const fileUser = (req: Request, env: Env) => verify(env, bearer(req) ?? fileCookieOf(req));

/** 本机调试（http://127.0.0.1）不加 Secure：http 下 WebKit 会直接丢掉 Secure Cookie */
function fileCookie(req: Request, value: string, maxAge: number) {
  const secure = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname) ? '' : '; Secure';
  return `${FILE_COOKIE}=${value}; Path=/api/files; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

/**
 * Bearer 鉴权成功后调用：Cookie 缺失或与 token 不一致就补发。
 * 前端每次启动都先拉 /board，图片只会在那之后渲染，所以已登录设备、旧版前端都无感拿到 Cookie。
 */
export function syncFileCookie(req: Request, res: Response) {
  const token = bearer(req);
  if (token && fileCookieOf(req) !== token) res.headers.append('set-cookie', fileCookie(req, token, TTL / 1000));
  return res;
}

/** 退出：HttpOnly Cookie 前端删不掉，由服务端下发过期 */
export async function logout({ req }: Ctx) {
  const res = json({ ok: true });
  res.headers.append('set-cookie', fileCookie(req, '', 0));
  return res;
}

export async function login({ req, env }: Ctx) {
  const { user, password } = await body(req);
  // 用户名白名单之外的请求不碰 login_fail，避免被灌任意行
  if (!isUser(user) || typeof password !== 'string' || password.length > 256) {
    throw new HttpError(401, '用户名或密码错误');
  }
  const db = env.DB;
  const t = now();
  const lockedUntil = await db.prepare('SELECT locked_until FROM login_fail WHERE user = ?').bind(user).first<number>('locked_until');
  if (lockedUntil && lockedUntil > t) {
    throw new HttpError(429, `密码错误次数过多，请 ${Math.ceil((lockedUntil - t) / 60_000)} 分钟后再试`);
  }

  const expected = env[PASSWORDS[user]];
  if (!expected) throw new HttpError(503, `服务器还没设置 ${user} 的密码`);
  if (!(await safeEqual(password, expected))) {
    // 第 MAX_FAILS 次失败时加锁并清零计数；DO UPDATE 里的 count 引用的是旧值
    await db
      .prepare(
        `INSERT INTO login_fail (user, count, locked_until) VALUES (?1, 1, 0)
         ON CONFLICT (user) DO UPDATE SET
           locked_until = CASE WHEN count + 1 >= ?2 THEN ?3 ELSE locked_until END,
           count        = CASE WHEN count + 1 >= ?2 THEN 0  ELSE count + 1 END`,
      )
      .bind(user, MAX_FAILS, t + LOCK_MS)
      .run();
    throw new HttpError(401, '用户名或密码错误');
  }

  await db.prepare('DELETE FROM login_fail WHERE user = ?').bind(user).run();
  return json({ user, token: await sign(env, user, t + TTL) });
}
