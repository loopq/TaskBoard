import type { webcrypto } from 'node:crypto';
import { HttpError } from './http.ts';
import type { Db } from './sqlite.ts';

/**
 * Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID）的最小实现。
 * 不引依赖：协议就是 ECDH + HKDF + AES-GCM + ES256，node:crypto 的 WebCrypto 够用。
 *
 * 已知天花板：失败不重试（每天只有一条，漏了第二天还会推）；要重试就给 push_sent 加状态列。
 */
export interface Msg {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface Vapid {
  publicKey: string; // base64url，65 字节未压缩点
  privateKey: webcrypto.CryptoKey;
  publicRaw: Uint8Array;
}

const TZ = 'Asia/Shanghai';
const DAY = 86400_000;
const enc = new TextEncoder();
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 只认推送服务主机：URL 解析按 hostname 判断，不对原始字符串 endsWith */
export function isPushEndpoint(s: string): boolean {
  if (typeof s !== 'string' || !s || s.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.replace(/\.$/, '');
  return host === 'fcm.googleapis.com' || host.endsWith('.push.apple.com') || host.endsWith('.push.services.mozilla.com');
}

const bad = (field: string): never => {
  throw new HttpError(400, `推送订阅不合法：${field}`);
};

export async function parseSubscription(body: unknown): Promise<PushSub> {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = b?.endpoint;
  if (typeof endpoint !== 'string' || !isPushEndpoint(endpoint)) return bad('endpoint');
  const p256dh = b?.keys?.p256dh;
  const auth = b?.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return bad('keys');
  const ua = unb64u(p256dh);
  const secret = unb64u(auth);
  if (secret.length !== 16) return bad('auth');
  if (ua.length !== 65 || ua[0] !== 0x04) return bad('p256dh');
  try {
    await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    return bad('p256dh');
  }
  return { endpoint, p256dh, auth };
}

const vapidCache = new WeakMap<Db, Promise<Vapid>>();

/** VAPID 密钥对存 kv 表，跟 sqlite 备份一起走；进程内缓存避免并发首次启动生成两对 */
export function vapidKeys(db: Db): Promise<Vapid> {
  let p = vapidCache.get(db);
  if (!p) {
    p = loadVapid(db);
    vapidCache.set(db, p);
  }
  return p;
}

async function loadVapid(db: Db): Promise<Vapid> {
  const saved = await db.prepare('SELECT v FROM kv WHERE k = ?').bind('vapid').first<string>('v');
  let jwk: webcrypto.JsonWebKey;
  if (saved) {
    jwk = JSON.parse(saved) as webcrypto.JsonWebKey;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').bind('vapid', JSON.stringify(jwk)).run();
  }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicRaw = concat(new Uint8Array([0x04]), unb64u(jwk.x!), unb64u(jwk.y!));
  return { publicKey: b64u(publicRaw), privateKey, publicRaw };
}

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
};

/** 纯函数：注入临时密钥、salt，RFC 8291 附录 A 的向量可以直接逐字节对比 */
export async function encryptWith(o: {
  payload: Uint8Array;
  uaPublic: Uint8Array;
  authSecret: Uint8Array;
  salt: Uint8Array;
  asKeyPair: webcrypto.CryptoKeyPair;
}): Promise<Uint8Array> {
  const uaKey = await crypto.subtle.importKey('raw', o.uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, o.asKeyPair.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', o.asKeyPair.publicKey));
  const ikm = await hkdf(o.authSecret, ecdh, concat(enc.encode('WebPush: info\0'), o.uaPublic, asPublic), 32);
  const cek = await hkdf(o.salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(o.salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(o.payload, new Uint8Array([0x02]))));
  // aes128gcm 单条记录头：salt(16) | rs=4096(4) | idlen=65(1) | as_public(65)
  return concat(o.salt, new Uint8Array([0, 0, 0x10, 0, asPublic.length]), asPublic, cipher);
}

export async function encrypt(sub: Pick<PushSub, 'p256dh' | 'auth'>, payload: Uint8Array): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const asKeyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  return encryptWith({ payload, uaPublic: unb64u(sub.p256dh), authSecret: unb64u(sub.auth), salt, asKeyPair });
}

/** RFC 8292：ES256 JWT，WebCrypto 的 ECDSA 签名本身就是 r‖s */
export async function vapidAuth(endpoint: string, keys: Vapid, nowSec: number): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 43200, sub: 'https://task.loopq.cn' })));
  const data = enc.encode(`${header}.${claims}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
};

/** 单设备发送：自己吞掉所有异常，一个设备出错不影响同一 owner 的其他设备 */
export async function send(db: Db, sub: PushSub, msg: Msg): Promise<'ok' | 'gone' | 'error'> {
  const host = hostOf(sub.endpoint);
  try {
    if (!isPushEndpoint(sub.endpoint)) return 'error';
    const body = await encrypt(sub, enc.encode(JSON.stringify(msg)));
    const keys = await vapidKeys(db);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        TTL: '43200',
        Urgency: 'normal',
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        Authorization: await vapidAuth(sub.endpoint, keys, Math.floor(Date.now() / 1000)),
      },
      body,
    });
    if (res.status === 200 || res.status === 201) return 'ok';
    if (res.status === 404 || res.status === 410) {
      await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
      return 'gone';
    }
    console.error('push_send_failed', res.status, host);
    return 'error';
  } catch (e) {
    console.error('push_send_failed', (e as Error).message, host);
    return 'error';
  }
}

export const dayInShanghai = (ms: number) => dayFmt.format(new Date(ms));

/** 今天到期且未完成；due_at 是浏览器本地零点，所以先用 ±36h SQL 粗筛，再按上海日期精确判断 */
export async function dailyDigest(db: Db, owner: string, day: string): Promise<Msg | null> {
  const base = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(base)) return null;
  const rows = await db
    .prepare(
      `SELECT title, no, due_at FROM tasks
       WHERE owner = ? AND done_at IS NULL AND due_at IS NOT NULL AND due_at > ? AND due_at < ?
       ORDER BY priority DESC, sort ASC`,
    )
    .bind(owner, base - 36 * 3600_000, base + 36 * 3600_000)
    .all<{ title: string; no: number | null; due_at: number }>();
  const due = rows.results.filter((r) => dayInShanghai(r.due_at) === day);
  if (!due.length) return null;
  const lines = due.slice(0, 4).map((r) => r.title);
  if (due.length > 4) lines.push(`…等 ${due.length} 项`);
  return {
    title: `今天到期 · ${due.length} 项`,
    body: lines.join('\n'),
    url: due.length === 1 && due[0].no !== null ? `/?t=${due[0].no}` : '/',
    tag: 'daily',
  };
}

/** 每个 owner 每天最多发一次；push_sent 主键兜底重复 tick 和多实例 */
export async function tick(db: Db, nowMs: number): Promise<void> {
  if (hmFmt.format(new Date(nowMs)) < '10:30') return;
  const day = dayInShanghai(nowMs);
  const owners = await db.prepare('SELECT DISTINCT owner FROM push_subs').all<{ owner: string }>();
  for (const { owner } of owners.results) {
    const key = `daily:${owner}:${day}`;
    const inserted = await db.prepare('INSERT OR IGNORE INTO push_sent (key, at) VALUES (?, ?)').bind(key, nowMs).run();
    if (!inserted.meta.changes) continue;
    const msg = await dailyDigest(db, owner, day);
    if (!msg) continue;
    const subs = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE owner = ?').bind(owner).all<PushSub>();
    for (const sub of subs.results) await send(db, sub, msg);
  }
  await db.prepare('DELETE FROM push_sent WHERE at < ?').bind(nowMs - 7 * DAY).run();
}

export function startScheduler(db: Db): void {
  if (process.env.PUSH_SCHEDULER === '0') return;
  const run = () => tick(db, Date.now()).catch((e) => console.error('push_tick_failed', e));
  void run();
  setInterval(run, 60_000).unref();
}
