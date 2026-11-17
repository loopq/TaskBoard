import { authenticate, login, logout, syncFileCookie } from './auth.ts';
import { createColumn, deleteColumn, patchColumn } from './columns.ts';
import { getFile, upload } from './files.ts';
import { type Ctx, type Env, HttpError, body, json } from './http.ts';
import { type PushSub, dailyDigest, dayInShanghai, isPushEndpoint, parseSubscription, send, vapidKeys } from './push.ts';
import * as t from './tasks.ts';

type Handler = (c: Ctx, params: string[]) => Promise<Response>;

/** 所有接口都在 /api 下（页面与 API 同域名）；':x' 匹配一段路径，'*' 匹配剩余全部 */
const route = (method: string, path: string, handler: Handler, isPublic = false) => ({
  method,
  re: new RegExp(`^/api${path.replace(/:\w+/g, '([^/]+)').replace('*', '(.+)')}$`),
  handler,
  isPublic,
});

const health: Handler = async ({ env }) => {
  await env.DB.prepare('SELECT 1').first();
  return json({ ok: true });
};

const pushKey: Handler = async ({ env }) => json({ publicKey: (await vapidKeys(env.DB)).publicKey });

const pushSubscribe: Handler = async ({ req, env, uid }) => {
  const sub = await parseSubscription(await body(req));
  // endpoint 是设备唯一键：同一设备换账号时 owner / keys 一起覆盖
  await env.DB
    .prepare(
      `INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET
         owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
    )
    .bind(sub.endpoint, uid, sub.p256dh, sub.auth, Date.now())
    .run();
  return json({ ok: true });
};

const pushUnsubscribe: Handler = async ({ req, env }) => {
  // endpoint 等同于退订凭据：推送服务下发、不可猜测；公开路由让退出登录后也能补做清理
  const { endpoint } = await body(req);
  if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) throw new HttpError(400, '推送订阅不合法：endpoint');
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(endpoint).run();
  return json({ ok: true });
};

const pushTest: Handler = async ({ env, uid }) => {
  const subs = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE owner = ?').bind(uid).all<PushSub>();
  const msg = (await dailyDigest(env.DB, uid, dayInShanghai(Date.now()))) ?? {
    title: '今天没有到期任务',
    body: '安心开始新的一天',
    url: '/',
    tag: 'daily',
  };
  let sent = 0;
  for (const sub of subs.results) if ((await send(env.DB, sub, msg)) === 'ok') sent++;
  return json({ sent });
};

const routes = [
  route('GET', '/health', health, true),
  route('POST', '/login', login, true),
  route('POST', '/logout', logout, true),
  route('GET', '/push/key', pushKey),
  route('POST', '/push/subscribe', pushSubscribe),
  route('POST', '/push/unsubscribe', pushUnsubscribe, true),
  route('POST', '/push/test', pushTest),
  route('GET', '/files/*', getFile, true), // 不走 Bearer 必选：getFile 自己认 Bearer 或图片 Cookie
  route('GET', '/board', t.board),
  route('POST', '/columns', createColumn),
  route('PATCH', '/columns/:id', patchColumn),
  route('DELETE', '/columns/:id', deleteColumn),
  route('POST', '/tasks', t.createTask),
  route('GET', '/tasks/:id', t.getTask),
  route('PATCH', '/tasks/:id', t.patchTask),
  route('DELETE', '/tasks/:id', t.deleteTask),
  route('POST', '/tasks/:id/move', t.moveTask),
  route('POST', '/tasks/:id/complete', t.complete),
  route('POST', '/tasks/:id/uncomplete', t.uncomplete),
  route('POST', '/tasks/:id/subtasks', t.createSubtask),
  route('PATCH', '/tasks/:id/subtasks/:sid', t.patchSubtask),
  route('DELETE', '/tasks/:id/subtasks/:sid', t.deleteSubtask),
  route('POST', '/tasks/:id/comments', t.createComment),
  route('DELETE', '/tasks/:id/comments/:cid', t.deleteComment),
  route('POST', '/upload', upload),
];

async function dispatch(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(pathname);
    if (!m) continue;
    const uid = r.isPublic ? '' : await authenticate(req, env);
    const res = await r.handler({ req, env, uid }, m.slice(1));
    return r.isPublic ? res : syncFileCookie(req, res);
  }
  throw new HttpError(404, '接口不存在');
}

function toResponse(e: unknown) {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  console.error('request_failed', e);
  return json({ error: '服务器内部错误' }, 500);
}

export const handle = (req: Request, env: Env) => dispatch(req, env).catch(toResponse);
