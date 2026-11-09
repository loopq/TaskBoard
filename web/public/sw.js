// 只缓存静态资源，数据（API，跨域）一律不碰、不做离线。
// - /assets/*：Vite 产物带 hash、内容不变 → 缓存优先
// - 页面导航：网络优先，断网时退回缓存的壳；拿到新 index.html 后顺手清掉它不再引用的旧 assets
// - 其他同源静态文件（图标、manifest）：先用缓存，后台更新
const CACHE = 'taskboard-static-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') return e.respondWith(navigate(req));
  if (url.pathname.startsWith('/assets/')) return e.respondWith(cacheFirst(req));
  e.respondWith(staleWhileRevalidate(req, e));
});

async function navigate(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put('/', res.clone());
      prune(cache, await res.clone().text());
    }
    return res;
  } catch {
    return (await cache.match('/')) ?? Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, e) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => (res.ok && cache.put(req, res.clone()), res));
  if (hit) {
    e.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

/** 每次发版 assets 文件名都变：只保留当前 index.html 引用的，避免手机上越攒越多 */
async function prune(cache, html) {
  const keep = new Set([...html.matchAll(/\/assets\/[^"'\s)]+/g)].map((m) => m[0]));
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith('/assets/') && !keep.has(p)) cache.delete(req);
  }
}
