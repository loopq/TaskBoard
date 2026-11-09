import { createReadStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Env } from './http.ts';
import { handle } from './index.ts';
import { openDb } from './sqlite.ts';

process.umask(0o077);
const DATA = resolve(process.env.DATA_DIR ?? 'data');
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const db = openDb(join(DATA, 'taskboard.db'));
const env: Env = {
  DB: db,
  FILES_DIR: join(DATA, 'files'),
  PW_ZHUHU: process.env.PW_ZHUHU,
  PW_LVCUI: process.env.PW_LVCUI,
  TOKEN_SECRET: process.env.TOKEN_SECRET,
};
const missing = (['PW_ZHUHU', 'PW_LVCUI', 'TOKEN_SECRET'] as const).filter((k) => !env[k]);
if (missing.length) console.warn(`未配置：${missing.join(', ')}（对应账号登录会返回 503）`);

/** 上传上限 5MB + 余量。Caddy 同样限制 6MB；这里是兜底，防止直连时被灌大包 */
const MAX_BODY = 6 * 1024 * 1024;

/** 所有响应统一带的安全头。CSP：脚本、样式只许同源；图片额外放行 https（Markdown 外链图片）和 data/blob */
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// ---- 静态文件：启动时把 dist 扫成白名单，请求只能命中这里的文件，不存在路径穿越 ----
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const statics = new Map<string, string>();
if (process.env.WEB_DIST) {
  const dist = resolve(process.env.WEB_DIST);
  for (const rel of readdirSync(dist, { recursive: true }) as string[]) {
    const abs = join(dist, rel);
    if (TYPES[extname(rel)] && statSync(abs).isFile()) statics.set(`/${rel.split(sep).join('/')}`, abs);
  }
}

function send(res: ServerResponse, status: number, body = '') {
  res.writeHead(status, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const file = statics.get(path === '/' ? '/index.html' : path);
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, 'Not found');
  res.writeHead(200, {
    ...SECURITY,
    'content-type': TYPES[extname(file)],
    // Vite 产物文件名带 hash，可以永久缓存；index.html / sw.js / manifest 每次校验
    'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/** 读完整个请求体（上限 MAX_BODY）；超限返回 null */
async function readBody(req: IncomingMessage) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (Number(req.headers['content-length']) > MAX_BODY) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'expect']);

/** node:http ↔ fetch 风格 handler（业务代码沿用 Request/Response，与运行时无关） */
async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const body = await readBody(req);
  if (body === null) {
    res.setHeader('connection', 'close');
    return send(res, 413, '{"error":"请求体过大"}');
  }
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (!HOP_BY_HOP.has(req.rawHeaders[i].toLowerCase())) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const response = await handle(new Request(url, { method: req.method, headers, body }), env);
  res.writeHead(response.status, { ...SECURITY, ...Object.fromEntries(response.headers) });
  if (!response.body) return res.end();
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://taskboard.local');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('server_error', e);
    if (!res.headersSent) send(res, 500);
    else res.destroy();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => console.log(`taskboard listening on ${host}:${port}（静态文件 ${statics.size} 个）`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => {
      db.raw.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
