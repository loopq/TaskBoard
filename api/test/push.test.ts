import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { webcrypto } from 'node:crypto';
import { HttpError } from '../src/http.ts';
import { dailyDigest, encrypt, encryptWith, isPushEndpoint, parseSubscription, send, tick, vapidAuth, vapidKeys } from '../src/push.ts';
import { openDb } from '../src/sqlite.ts';

const enc = new TextEncoder();
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

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** 用 ua_public 的 x/y + 原始私钥拼出 WebCrypto 可导入的 ECDH 密钥对 */
async function ecPair(privateRaw: string, publicRaw: string): Promise<webcrypto.CryptoKeyPair> {
  const pub = unb64u(publicRaw);
  const x = b64u(pub.slice(1, 33));
  const y = b64u(pub.slice(33));
  const base = { kty: 'EC', crv: 'P-256', ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', { ...base, x, y, d: privateRaw }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('jwk', { ...base, x, y }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { privateKey, publicKey };
}

const RFC = {
  payload: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
} as const;

test('encryptWith：RFC 8291 附录 A 测试向量逐字节一致', async () => {
  const out = await encryptWith({
    payload: enc.encode(RFC.payload),
    uaPublic: unb64u(RFC.uaPublic),
    authSecret: unb64u(RFC.authSecret),
    salt: unb64u(RFC.salt),
    asKeyPair: await ecPair(RFC.asPrivate, RFC.asPublic),
  });
  assert.equal(b64u(out), RFC.body);
});

test('encrypt：用 UA 私钥能解回原文（随机 salt + 临时 ECDH 密钥）', async () => {
  const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const payload = enc.encode('今天要交报告\n还有两件小事');
  const record = await encrypt({ p256dh: b64u(uaPublic), auth: b64u(authSecret) }, payload);

  const salt = record.slice(0, 16);
  const idlen = record[20];
  const asPublic = record.slice(21, 21 + idlen);
  const cipher = record.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, cipher));
  assert.equal(plain.at(-1), 0x02);
  assert.deepEqual(new TextDecoder().decode(plain.slice(0, -1)), new TextDecoder().decode(payload));
});

test('vapidAuth：公钥可验签，aud 是 endpoint origin，exp=now+12h', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const nowSec = 1_700_000_000;
  const endpoint = 'https://web.push.apple.com/send/abc';
  const auth = await vapidAuth(endpoint, { publicKey: b64u(publicRaw), privateKey: pair.privateKey, publicRaw }, nowSec);

  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m);
  const [header, claims, sig] = m[1].split('.');
  assert.equal(m[2], b64u(publicRaw));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64u(header))), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(new TextDecoder().decode(unb64u(claims)));
  assert.equal(payload.aud, 'https://web.push.apple.com');
  assert.equal(payload.exp - nowSec, 12 * 3600);
  assert.equal(payload.sub, 'https://task.loopq.cn');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, unb64u(sig), enc.encode(`${header}.${claims}`)));
});

test('vapidKeys：首次生成写 kv，重启后从 JWK 载入同一对密钥', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskboard-push-'));
  const path = join(dir, 'test.db');
  try {
    const first = openDb(path);
    const a = await vapidKeys(first);
    first.raw.close();
    const second = openDb(path);
    try {
      const b = await vapidKeys(second);
      assert.equal(a.publicKey, b.publicKey);
      assert.equal(a.publicRaw.length, 65);
      assert.equal(await second.prepare("SELECT COUNT(*) AS n FROM kv WHERE k = 'vapid'").first<number>('n'), 1);
    } finally {
      second.raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isPushEndpoint：白名单主机 + 规范化', () => {
  const yes = [
    'https://web.push.apple.com/send/abc',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com./send/abc',
    'https://WEB.PUSH.APPLE.COM/send/abc',
    'https://web.push.apple.com:443/send/abc',
  ];
  const no = [
    'https://fcm.googleapis.com.evil.com/x',
    'https://evilfcm.googleapis.com/x',
    'https://fcm.googleapis.com@evil.com/',
    'http://web.push.apple.com/x',
    'https://web.push.apple.com:8443/x',
    'https://1.2.3.4/x',
    'https://[::1]/x',
    'file:///etc/passwd',
    'not a url',
    `https://web.push.apple.com/${'x'.repeat(1024)}`,
  ];
  for (const s of yes) assert.equal(isPushEndpoint(s), true, s);
  for (const s of no) assert.equal(isPushEndpoint(s), false, s);
});

test('parseSubscription：合法订阅通过，长度 / 前缀 / 曲线点错误都 400', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = 'https://web.push.apple.com/send/abc';
  assert.deepEqual(await parseSubscription({ endpoint, keys: { p256dh, auth } }), { endpoint, p256dh, auth });

  const reject = (body: unknown) => assert.rejects(() => parseSubscription(body), (e) => e instanceof HttpError && e.status === 400);
  await reject({ endpoint: 'https://evil.com/x', keys: { p256dh, auth } });
  await reject({ endpoint, keys: { p256dh, auth: b64u(new Uint8Array(15)) } });
  const badPrefix = unb64u(p256dh);
  badPrefix[0] = 0x05;
  await reject({ endpoint, keys: { p256dh: b64u(badPrefix), auth } });
  const offCurve = new Uint8Array(65);
  offCurve[0] = 0x04;
  await reject({ endpoint, keys: { p256dh: b64u(offCurve), auth } });
});

async function makeDb() {
  const db = openDb(':memory:');
  await db.prepare("INSERT INTO columns (id, owner, name, kind, sort) VALUES ('c', 'zhuhu', '待处理', 'todo', 0)").run();
  return db;
}

async function addTask(
  db: ReturnType<typeof openDb>,
  o: { id: string; title: string; due: number; owner?: string; done?: number | null; priority?: number; sort?: number; no?: number },
) {
  await db
    .prepare(
      `INSERT INTO tasks (id, owner, column_id, title, sort, priority, due_at, done_at, created_at, updated_at, no)
       VALUES (?, ?, 'c', ?, ?, ?, ?, ?, 0, 0, ?)`,
    )
    .bind(o.id, o.owner ?? 'zhuhu', o.title, o.sort ?? 1, o.priority ?? 0, o.due, o.done ?? null, o.no ?? null)
    .run();
}

test('dailyDigest：上海 00:00 / 23:59 边界、已完成、他人任务、无任务', async () => {
  const db = await makeDb();
  try {
    const day = '2026-11-17';
    const start = Date.parse('2026-11-17T00:00:00+08:00');
    const end = Date.parse('2026-11-17T23:59:59+08:00');
    await addTask(db, { id: 'a', title: '边界 00:00', due: start, priority: 1, sort: 2 });
    await addTask(db, { id: 'b', title: '边界 23:59', due: end, priority: 1, sort: 1 });
    await addTask(db, { id: 'c', title: '前一天', due: Date.parse('2026-11-16T23:59:59+08:00') });
    await addTask(db, { id: 'd', title: '后一天', due: Date.parse('2026-11-18T00:00:00+08:00') });
    await addTask(db, { id: 'e', title: '已完成', due: start, done: 1 });
    await addTask(db, { id: 'f', title: '别人的', due: start, owner: 'lvcui' });

    assert.deepEqual(await dailyDigest(db, 'zhuhu', day), {
      title: '今天到期 · 2 项',
      body: '边界 23:59\n边界 00:00',
      url: '/',
      tag: 'daily',
    });
    assert.equal(await dailyDigest(db, 'zhuhu', '2026-11-19'), null);
    assert.equal(await dailyDigest(db, 'nobody', day), null);
  } finally {
    db.raw.close();
  }
});

test('dailyDigest：单条带 ?t、超过 4 条折叠并保持优先级 + sort 顺序', async () => {
  const db = await makeDb();
  try {
    const day = '2026-11-17';
    const due = Date.parse('2026-11-17T00:00:00+08:00');
    await addTask(db, { id: 'one', title: '只有这条', due, no: 7 });
    assert.equal((await dailyDigest(db, 'zhuhu', day))?.url, '/?t=7');
    await db.prepare("DELETE FROM tasks WHERE id = 'one'").run();

    const rows = [
      ['a', 'P0 后', 0, 2],
      ['b', 'P4', 4, 9],
      ['c', 'P3', 3, 9],
      ['d', 'P2', 2, 9],
      ['e', 'P1', 1, 9],
      ['f', 'P0 前', 0, 1],
    ] as const;
    for (const [id, title, priority, sort] of rows) await addTask(db, { id, title, due, priority, sort });
    const msg = await dailyDigest(db, 'zhuhu', day);
    assert.equal(msg?.title, '今天到期 · 6 项');
    assert.equal(msg?.url, '/');
    assert.deepEqual(msg?.body.split('\n'), ['P4', 'P3', 'P2', 'P1', '…等 6 项']);
  } finally {
    db.raw.close();
  }
});

async function subscription(endpoint = 'https://web.push.apple.com/send/abc') {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  return {
    endpoint,
    p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
  };
}

async function withFetch(fn: (init: RequestInit[]) => Promise<void>, response: () => Response = () => new Response(null, { status: 201 })) {
  const orig = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return response();
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const msg = { title: '今天到期 · 1 项', body: 'x', url: '/', tag: 'daily' };

test('send：200/201 ok，404/410 删订阅，其他状态 / 异常 error 且保留', async () => {
  for (const status of [200, 201]) {
    const db = await makeDb();
    try {
      const sub = await subscription();
      await db.prepare('INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)').bind(sub.endpoint, 'zhuhu', sub.p256dh, sub.auth).run();
      await withFetch(async (calls) => {
        assert.equal(await send(db, sub, msg), 'ok');
        assert.equal(calls.length, 1);
        const h = new Headers(calls[0].headers);
        assert.equal(h.get('TTL'), '43200');
        assert.equal(h.get('Urgency'), 'normal');
        assert.equal(h.get('Content-Type'), 'application/octet-stream');
        assert.equal(h.get('Content-Encoding'), 'aes128gcm');
        assert.match(h.get('Authorization') ?? '', /^vapid t=.+, k=.+$/);
      }, () => new Response(null, { status }));
      assert.ok(await db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).first());
    } finally {
      db.raw.close();
    }
  }

  for (const status of [404, 410]) {
    const db = await makeDb();
    try {
      const sub = await subscription();
      await db.prepare('INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)').bind(sub.endpoint, 'zhuhu', sub.p256dh, sub.auth).run();
      await withFetch(async () => assert.equal(await send(db, sub, msg), 'gone'), () => new Response(null, { status }));
      assert.equal(await db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).first(), null);
    } finally {
      db.raw.close();
    }
  }

  for (const status of [401, 403, 500]) {
    const db = await makeDb();
    try {
      const sub = await subscription();
      await db.prepare('INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)').bind(sub.endpoint, 'zhuhu', sub.p256dh, sub.auth).run();
      await withFetch(async () => assert.equal(await send(db, sub, msg), 'error'), () => new Response(null, { status }));
      assert.ok(await db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).first());
    } finally {
      db.raw.close();
    }
  }

  const db = await makeDb();
  try {
    const sub = await subscription();
    await db.prepare('INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)').bind(sub.endpoint, 'zhuhu', sub.p256dh, sub.auth).run();
    await withFetch(async () => assert.equal(await send(db, sub, msg), 'error'), () => {
      throw new Error('network down');
    });
    assert.ok(await db.prepare('SELECT 1 FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).first());
  } finally {
    db.raw.close();
  }
});

test('tick：10:29 不发、10:30 发、当天只发一次、次日再发、清理 7 天前记录', async () => {
  const db = await makeDb();
  try {
    const sub = await subscription();
    await db.prepare('INSERT INTO push_subs (endpoint, owner, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)').bind(sub.endpoint, 'zhuhu', sub.p256dh, sub.auth).run();
    await addTask(db, { id: 'd1', title: '17 号', due: Date.parse('2026-11-17T00:00:00+08:00') });
    await addTask(db, { id: 'd2', title: '18 号', due: Date.parse('2026-11-18T00:00:00+08:00') });

    await withFetch(async (calls) => {
      await tick(db, Date.parse('2026-11-17T10:29:00+08:00'));
      assert.equal(calls.length, 0);
      assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM push_sent').first<number>('n'), 0);

      await tick(db, Date.parse('2026-11-17T10:30:00+08:00'));
      assert.equal(calls.length, 1);
      assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM push_sent').first<number>('n'), 1);

      await tick(db, Date.parse('2026-11-17T10:31:00+08:00'));
      assert.equal(calls.length, 1);

      const old = Date.parse('2026-11-18T10:30:00+08:00') - 8 * 86400_000;
      await db.prepare("INSERT INTO push_sent (key, at) VALUES ('old', ?)").bind(old).run();
      await tick(db, Date.parse('2026-11-18T10:30:00+08:00'));
      assert.equal(calls.length, 2);
      assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM push_sent WHERE key = 'old'").first<number>('n'), 0);
    });
  } finally {
    db.raw.close();
  }
});
