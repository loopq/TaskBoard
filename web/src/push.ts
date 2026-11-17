import { reactive } from 'vue';
import { api, session } from './api';

export type PushState = 'unsupported' | 'denied' | 'on' | 'off';

const PENDING = 'tb_push_pending';
const err = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function pushState(): PushState {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'off';
}

export const pushStatus = reactive<{ state: PushState; error: string; busy: boolean }>({
  state: pushState(),
  error: '',
  busy: false,
});

async function current() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

const swReady = () =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Service Worker 未就绪')), 10_000)),
  ]);

const keyOf = (sub: PushSubscription) => (sub.options.applicationServerKey ? b64u(sub.options.applicationServerKey) : '');

/** 补做离线退出留下的退订；只有当前订阅还是 pending 那台设备时才动本地订阅 */
export async function flushPending() {
  const endpoint = localStorage.getItem(PENDING);
  if (!endpoint) return;
  try {
    await api('POST', '/push/unsubscribe', { endpoint });
    const sub = await current();
    if (sub?.endpoint === endpoint) await sub.unsubscribe();
    localStorage.removeItem(PENDING);
  } catch {
    // 离线 / 服务端暂时不可达：下次启动再试
  }
}

let queue = Promise.resolve();

/**
 * 启动和登录后调 syncPush()，用户点「开启」调 syncPush(true)；串行执行，避免同时 subscribe 产生两个 endpoint。
 * 本机的推送订阅就是「已开启」的记忆：非 force 时没有订阅就保持关闭，点过「关闭」不会被启动同步偷偷重开。
 */
export function syncPush(force = false): Promise<void> {
  const run = () => runSync(force);
  queue = queue.then(run, run);
  return queue;
}

async function runSync(force: boolean) {
  if (!session.token) return;
  const base = pushState();
  if (base !== 'off') return void (pushStatus.state = base);
  if (Notification.permission !== 'granted') return void (pushStatus.state = 'off');
  try {
    await flushPending();
    let sub = await current();
    if (!sub && !force) return void (pushStatus.state = 'off');
    if (sub) pushStatus.state = 'on'; // 先按本机订阅显示已开启，下面联网确认失败再改回
    const { publicKey } = await api<{ publicKey: string }>('GET', '/push/key');
    if (sub && keyOf(sub) !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      const reg = await swReady();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(publicKey) });
    }
    // 服务端 upsert 幂等：同时处理丢记录、换 owner、订阅过期
    await api('POST', '/push/subscribe', sub.toJSON());
    pushStatus.state = 'on';
    pushStatus.error = '';
  } catch (e) {
    pushStatus.state = 'off';
    pushStatus.error = err(e, '订阅失败，请重试');
  }
}

/** 必须在点击事件里调用：iOS 要求用户手势触发 requestPermission */
export async function enablePush() {
  pushStatus.busy = true;
  pushStatus.error = '';
  try {
    const base = pushState();
    if (base !== 'off') return void (pushStatus.state = base);
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return void (pushStatus.state = permission === 'denied' ? 'denied' : 'off');
    await syncPush(true);
    if (pushStatus.state !== 'on') pushStatus.error ||= '订阅失败，请重试';
  } catch {
    pushStatus.error = '订阅失败，请重试';
  } finally {
    pushStatus.busy = false;
  }
}

export async function disablePush() {
  pushStatus.busy = true;
  pushStatus.error = '';
  try {
    const sub = await current();
    if (!sub) return void (pushStatus.state = 'off');
    await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
    pushStatus.state = 'off';
  } catch (e) {
    pushStatus.error = err(e, '关闭失败，请重试');
  } finally {
    pushStatus.busy = false;
  }
}

/** 退出登录前清订阅；整体 3s 超时，失败也照常退出，pending 留给下次启动补做 */
export async function cleanupPush() {
  try {
    const sub = await current();
    if (!sub) return;
    localStorage.setItem(PENDING, sub.endpoint);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 3000);
    });
    const work = (async () => {
      await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    })();
    try {
      await Promise.race([work, timeout]);
      localStorage.removeItem(PENDING);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // pending 保留
  }
}
