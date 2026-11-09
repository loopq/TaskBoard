/** 页面与 API 同域名部署：API 固定在 /api（开发时由 Vite 代理到本地 Node 服务） */
export const API_BASE = '/api';

const TOKEN_KEY = 'taskboard.token';
const USER_KEY = 'taskboard.user';

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  get user() {
    return localStorage.getItem(USER_KEY);
  },
  save(user: string, token: string) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, user);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

/** token 失效（过期 / TOKEN_SECRET 轮换）时由 store 注册回调，回到首页 */
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** body 为 Blob 时原样上传（图片），否则按 JSON 发送 */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  let payload: BodyInit | undefined;
  if (body instanceof Blob) {
    headers['content-type'] = body.type;
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, '网络不通，请检查网络后重试');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

/** 上传返回的是相对 API 根的 /files/...，渲染时才拼上 API_BASE，与部署域名无关 */
export const fileUrl = (src: string) => (src.startsWith('/files/') ? API_BASE + src : src);
