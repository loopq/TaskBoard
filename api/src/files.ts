import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { type Ctx, HttpError, json } from './http.ts';

// 前端优先压成 webp；iOS Safari 的 canvas 不支持编码 webp 会退回 jpeg/png，所以都要收
const TYPES = new Map([
  ['image/webp', 'webp'],
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
]);
const EXT_TYPES = new Map([...TYPES].map(([type, ext]) => [`.${ext}`, type]));
const MAX_BYTES = 5 * 1024 * 1024;
// 只认 <用户>/<uuid>.<ext> 这一种形状：同时挡掉 ../ 路径穿越
const KEY_RE = /^[a-z]+\/[0-9a-f-]{36}\.(webp|jpg|png|gif)$/;
const tooLarge = () => new HttpError(413, '图片不能超过 5MB');

export async function upload({ req, env, uid }: Ctx) {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = TYPES.get(type);
  if (!ext) throw new HttpError(415, '只支持 webp / jpeg / png / gif 图片');
  if (Number(req.headers.get('content-length')) > MAX_BYTES) throw tooLarge();
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) throw new HttpError(400, '图片为空');
  if (buf.byteLength > MAX_BYTES) throw tooLarge();

  const name = `${crypto.randomUUID()}.${ext}`;
  const dir = join(env.FILES_DIR, uid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // 先写临时文件再 rename：读的一方永远看不到写了一半的图片
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, new Uint8Array(buf), { flag: 'wx', mode: 0o600 });
  await rename(tmp, join(dir, name));
  // 返回相对 API 根的路径而不是绝对 URL：存进 Markdown 的地址与域名无关，前端渲染时拼 /api
  return json({ url: `/files/${uid}/${name}` }, 201);
}

/**
 * 公开读：<img> 带不了 Authorization 头，靠 122 位随机 uuid 不可猜保护（设计文档 §6 已知天花板）。
 * nosniff + 白名单 content-type，保证返回的永远只会被当成图片。
 */
export async function getFile({ req, env }: Ctx, [key]: string[]) {
  const path = KEY_RE.test(key) ? join(env.FILES_DIR, key) : null;
  const st = path ? await stat(path).catch(() => null) : null;
  if (!path || !st?.isFile()) throw new HttpError(404, '文件不存在');
  const headers = new Headers({
    etag: `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`,
    'cache-control': 'public, max-age=31536000, immutable',
    'content-type': EXT_TYPES.get(extname(path))!,
    'content-length': String(st.size),
  });
  if (req.headers.get('if-none-match') === headers.get('etag')) return new Response(null, { status: 304, headers });
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
}
