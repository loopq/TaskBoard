#!/usr/bin/env node
// taskboard CLI：给 AI 用的私人看板增删改查。零依赖，Node 18+。
// 业务规则（不能拖进「已完成」、锁定列等）全部由服务端判定，这里只把错误原样报出来。
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const CRED_FILE = join(homedir(), '.config', 'taskboard', 'credentials.json');
const DEFAULT_BASE = 'https://task.loopq.cn';
const PRIORITIES = ['无', '较低', '普通', '紧急', '非常紧急'];
const BOOL_FLAGS = new Set(['all', 'json', 'yes']);

const die = (msg) => {
  process.stderr.write(`错误：${msg}\n`);
  process.exit(1);
};

// ---- 参数：位置参数 + --key value；all / json / yes 是开关 ----
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (BOOL_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
    else if (i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
    else die(`${a} 缺少取值`);
  }
  return { pos, flags };
}

// ---- 登录态：环境变量优先（本机测试用），否则读 login 写下的凭据文件 ----
function readCred() {
  try {
    return JSON.parse(readFileSync(CRED_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const cred = readCred();
const BASE = (process.env.TASKBOARD_BASE || cred.base || DEFAULT_BASE).replace(/\/+$/, '');
const TOKEN = process.env.TASKBOARD_TOKEN || cred.token;
const loginHint = `请用户在自己的终端运行：node ${SELF} login <zhuhu|lvcui>（密码只在用户终端输入，不经过 AI）`;

/** 给了 type 就原样发 body（上传图片），否则按 JSON 发；raw = true 时成功返回原始字节（下载图片） */
async function api(method, path, body, type, raw = false) {
  if (!TOKEN && path !== '/login') die(`还没登录。${loginHint}`);
  const headers = { 'content-type': type ?? 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: type || body === undefined ? body : JSON.stringify(body) });
  } catch (e) {
    die(`连不上 ${BASE}：${e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message}`);
  }
  if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') die(`登录已失效。${loginHint}`);
  if (!res.ok) die(data.error ?? `请求失败（${res.status}）`);
  return data;
}

// ---- 格式化 ----
const pad = (n) => String(n).padStart(2, '0');
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (ms) => {
  const d = new Date(ms);
  return `${ymd(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function dayStart(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}
function dueLabel(t) {
  if (t.due_at === null) return '';
  const diff = Math.round((new Date(t.due_at).setHours(0, 0, 0, 0) - dayStart()) / 86400_000);
  const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff < 0 && t.done_at === null ? '已过期' : '';
  return `截止 ${ymd(t.due_at)}${rel ? `（${rel}）` : ''}`;
}
const url = (no) => `${BASE}/?t=${no}`;
function cardLine(t) {
  const meta = [
    t.priority ? `[${PRIORITIES[t.priority]}]` : '',
    dueLabel(t),
    t.sub_total ? `子任务 ${t.sub_done}/${t.sub_total}` : '',
    t.comment_count ? `评论 ${t.comment_count}` : '',
  ].filter(Boolean);
  return `  #${t.no} ${t.title}${meta.length ? `  ${meta.join(' · ')}` : ''}`;
}

// ---- 解析输入：任务、列、日期、优先级 ----
const board = () => api('GET', '/board');
const sortedCols = (b) => [...b.columns].sort((x, y) => x.sort - y.sort);

/** 12 / #12 / t12 / https://task.loopq.cn/?t=12 → 看板里的任务卡片 */
function findTask(b, ref) {
  if (!ref) die('缺少任务编号（例如 12、#12 或详情链接）');
  const m = /(?:[?&]t=|^#?t?)(\d+)$/i.exec(String(ref).trim());
  const t = m ? b.tasks.find((x) => x.no === Number(m[1])) : b.tasks.find((x) => x.id === ref);
  return t ?? die(`找不到任务 ${ref}`);
}
function findCol(b, ref) {
  if (!ref) die('缺少列名');
  const hits = b.columns.filter((c) => c.name === ref || c.id === ref);
  if (hits.length === 1) return hits[0];
  const names = sortedCols(b).map((c) => `「${c.name}」`).join(' ');
  return die(hits.length ? `有多个列叫「${ref}」，请用列 id` : `没有叫「${ref}」的列。现有：${names}`);
}
function parseDue(v) {
  const s = String(v).trim().toLowerCase();
  const rel = { today: 0, 今天: 0, tomorrow: 1, 明天: 1, 后天: 2 }[s];
  if (rel !== undefined) return dayStart(rel);
  if (['none', 'null', '无', '清除'].includes(s)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = new Date(`${s}T00:00:00`).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return die(`看不懂日期「${v}」：用 YYYY-MM-DD、today/今天、tomorrow/明天、后天 或 none`);
}
function parsePriority(v) {
  const s = String(v).trim();
  const i = /^[0-4]$/.test(s) ? Number(s) : PRIORITIES.indexOf(s);
  return i >= 0 ? i : die(`优先级只能是 0-4 或 ${PRIORITIES.join('/')}`);
}
/** add / edit 共用的字段：只带用户显式给出的 */
function taskFields(flags) {
  const f = {};
  if (flags.title !== undefined) f.title = flags.title;
  if (flags.desc !== undefined) f.desc_md = flags.desc;
  if (flags.due !== undefined) f.due_at = parseDue(flags.due);
  if (flags.priority !== undefined) f.priority = parsePriority(flags.priority);
  return f;
}
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/** 本地图片 → /files/... 地址。原样上传不压缩（零依赖做不了缩放，网页端会压到长边 1920），超过 5MB 由服务端拒绝 */
async function uploadImage(path) {
  const type = IMAGE_TYPES[extname(path).toLowerCase()] ?? die(`只支持 png / jpg / webp / gif 图片：${path}`);
  const buf = await readFile(path).catch((e) => die(`读不了图片 ${path}：${e.code ?? e.message}`));
  return (await api('POST', '/upload', buf, type)).url;
}
/** 子任务序号（show 里列出的 1、2、3） */
async function findSub(taskId, n) {
  const d = await api('GET', `/tasks/${taskId}`);
  const s = d.subtasks[Number(n) - 1];
  return s ?? die(`没有第 ${n} 个子任务（共 ${d.subtasks.length} 个）`);
}

// ---- 命令 ----
const out = (flags, data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

const commands = {
  async login({ pos }) {
    const user = pos[0];
    if (!['zhuhu', 'lvcui'].includes(user)) die('用法：login <zhuhu|lvcui>');
    // 只接受交互式终端：密码绝不从管道 / 参数 / 环境变量读，AI 也就没有机会经手
    if (!process.stdin.isTTY) die('login 只能在交互式终端里运行（请用户自己在终端执行）');
    const password = await askHidden(`${user} 的密码（${BASE}）：`);
    const r = await api('POST', '/login', { user, password });
    mkdirSync(dirname(CRED_FILE), { recursive: true, mode: 0o700 });
    writeFileSync(CRED_FILE, `${JSON.stringify({ base: BASE, user: r.user, token: r.token }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(CRED_FILE, 0o600);
    console.log(`已登录 ${r.user}，凭据写入 ${CRED_FILE}（有效期 1 年）`);
  },

  async whoami({ flags }) {
    const b = await board();
    out(flags, { user: b.user, base: BASE }, `${b.user} @ ${BASE}`);
  },

  async board({ flags }) {
    const b = await board();
    const lines = [`${b.user} 的看板 ${BASE}`];
    for (const c of sortedCols(b)) {
      const list = b.tasks.filter((t) => t.column_id === c.id).sort((x, y) => x.sort - y.sort);
      const lock = c.kind === 'normal' ? '' : '，锁定列';
      lines.push(`\n## ${c.name}（${list.length}${lock}）`);
      if (c.kind === 'done' && !flags.all) {
        if (list.length) lines.push('  （已完成的任务默认不列出，加 --all 查看）');
        continue;
      }
      lines.push(...list.map(cardLine));
    }
    out(flags, b, lines.join('\n'));
  },

  async show({ pos, flags }) {
    const b = await board();
    const card = findTask(b, pos[0]);
    const d = await api('GET', `/tasks/${card.id}`);
    const col = b.columns.find((c) => c.id === card.column_id);
    const lines = [
      `#${card.no} ${card.title}`,
      `链接：${url(card.no)}`,
      `所在列：${col?.name}${card.done_at === null ? '' : `（${hm(card.done_at)} 完成）`}`,
      `优先级：${PRIORITIES[card.priority]}`,
      `截止：${dueLabel(card).replace(/^截止 /, '') || '无'}`,
      `\n描述：${d.task.desc_md.trim() ? `\n${d.task.desc_md}` : '（空）'}`,
      `\n子任务（${card.sub_done}/${card.sub_total}）：`,
      ...d.subtasks.map((s, i) => `  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.title}`),
      '\n动态：',
      ...d.timeline.map((c) => `  ${hm(c.created_at)} ${c.kind === 'system' ? '·' : '评论：'} ${c.body_md}`),
    ];
    out(flags, { ...d, no: card.no, url: url(card.no) }, lines.join('\n'));
  },

  async add({ pos, flags }) {
    if (!pos[0]) die('用法：add "<标题>" [--col 列名] [--desc md] [--due 日期] [--priority 级别]');
    const b = await board();
    const col = flags.col ? findCol(b, flags.col) : b.columns.find((c) => c.kind === 'todo');
    const t = await api('POST', '/tasks', { ...taskFields(flags), title: pos[0], column_id: col.id });
    out(flags, t, `已创建 #${t.no} ${t.title}（${col.name}）${url(t.no)}`);
  },

  async edit({ pos, flags }) {
    const f = taskFields(flags);
    if (!Object.keys(f).length) die('用法：edit <任务> [--title] [--desc] [--due 日期|none] [--priority 级别]');
    const card = findTask(await board(), pos[0]);
    const t = await api('PATCH', `/tasks/${card.id}`, f);
    out(flags, t, `已更新 ${cardLine(t).trim()}`);
  },

  async move({ pos, flags }) {
    const b = await board();
    const card = findTask(b, pos[0]);
    const col = findCol(b, pos[1]);
    // 排到目标列末尾
    const last = Math.max(0, ...b.tasks.filter((t) => t.column_id === col.id && t.id !== card.id).map((t) => t.sort));
    const r = await api('POST', `/tasks/${card.id}/move`, { column_id: col.id, sort: last + 1 });
    out(flags, r, `#${card.no} 已移到「${col.name}」`);
  },

  async done({ pos, flags }) {
    const card = findTask(await board(), pos[0]);
    out(flags, await api('POST', `/tasks/${card.id}/complete`), `#${card.no} 已完成`);
  },

  async undo({ pos, flags }) {
    const b = await board();
    const card = findTask(b, pos[0]);
    const t = await api('POST', `/tasks/${card.id}/uncomplete`);
    out(flags, t, `#${card.no} 已取消完成，回到「${b.columns.find((c) => c.id === t.column_id)?.name}」`);
  },

  async rm({ pos, flags }) {
    const card = findTask(await board(), pos[0]);
    if (!flags.yes) die(`删除 #${card.no}「${card.title}」会连同子任务和评论一起删掉。确认后加 --yes 重跑`);
    out(flags, await api('DELETE', `/tasks/${card.id}`), `已删除 #${card.no} ${card.title}`);
  },

  async comment({ pos, flags }) {
    if (!pos[1] && !flags.image) die('用法：comment <任务> ["<Markdown>"] [--image 图片路径]');
    // 先找任务再上传：任务不存在时不留孤儿图片
    const card = findTask(await board(), pos[0]);
    const img = flags.image && `![](${await uploadImage(flags.image)})`;
    const body_md = [pos[1], img].filter(Boolean).join('\n\n');
    out(flags, await api('POST', `/tasks/${card.id}/comments`, { body_md }), `已评论 #${card.no}`);
  },

  /** 图片只有本人能看（浏览器靠 Cookie），AI 要看就带 token 下载到本地，再用 Read 打开 */
  async image({ pos, flags }) {
    const key = /\/files\/([a-z]+\/[0-9a-f-]{36}\.(?:webp|jpg|png|gif))/.exec(pos[0] ?? '')?.[1];
    if (!key) die('用法：image <图片地址，例如 show 里的 /files/zhuhu/xxx.webp> [--out 路径]');
    const buf = await api('GET', `/files/${key}`, undefined, undefined, true);
    const file = flags.out ?? join(tmpdir(), 'taskboard-images', key.replace('/', '-'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    out(flags, { file, bytes: buf.length }, file);
  },

  async sub({ pos, flags }) {
    const [ref, action, arg] = pos;
    const card = findTask(await board(), ref);
    const base = `/tasks/${card.id}/subtasks`;
    if (action === 'add') {
      if (!arg) die('用法：sub <任务> add "<标题>"');
      return out(flags, await api('POST', base, { title: arg }), `#${card.no} 已添加子任务「${arg}」`);
    }
    if (!['done', 'undo', 'rm'].includes(action)) die('用法：sub <任务> add "<标题>" | done <序号> | undo <序号> | rm <序号>');
    const s = await findSub(card.id, arg);
    if (action === 'rm') return out(flags, await api('DELETE', `${base}/${s.id}`), `#${card.no} 已删除子任务「${s.title}」`);
    const r = await api('PATCH', `${base}/${s.id}`, { done: action === 'done' });
    out(flags, r, `#${card.no} 子任务「${s.title}」${action === 'done' ? '已完成' : '已取消完成'}`);
  },

  async col({ pos, flags }) {
    const [action, ref, arg] = pos;
    if (action === 'add') {
      if (!ref) die('用法：col add "<列名>"');
      return out(flags, await api('POST', '/columns', { name: ref }), `已新建列「${ref}」`);
    }
    const b = await board();
    const col = findCol(b, ref);
    if (action === 'rename') {
      if (!arg) die('用法：col rename <列> "<新名>"');
      return out(flags, await api('PATCH', `/columns/${col.id}`, { name: arg }), `「${col.name}」已改名为「${arg}」`);
    }
    if (action === 'rm') {
      if (!flags.yes) die(`删除列「${col.name}」？确认后加 --yes 重跑（列里有任务时服务端会拒绝）`);
      return out(flags, await api('DELETE', `/columns/${col.id}`), `已删除列「${col.name}」`);
    }
    if (action === 'move') {
      // 位置 = 普通列之间的第几个（1 起）；「待处理」「已完成」固定在两端
      const cols = sortedCols(b);
      const normals = cols.filter((c) => c.kind === 'normal' && c.id !== col.id);
      const i = Number(arg) - 1;
      if (!Number.isInteger(i) || i < 0 || i > normals.length) die(`位置只能是 1-${normals.length + 1}`);
      const prev = normals[i - 1]?.sort ?? cols.find((c) => c.kind === 'todo').sort;
      const next = normals[i]?.sort ?? cols.find((c) => c.kind === 'done').sort;
      return out(flags, await api('PATCH', `/columns/${col.id}`, { sort: (prev + next) / 2 }), `「${col.name}」已移到普通列第 ${i + 1} 位`);
    }
    die('用法：col add "<列名>" | rename <列> "<新名>" | rm <列> --yes | move <列> <位置>');
  },
};

/** 隐藏输入（不回显），支持退格和粘贴；Ctrl+C 退出 */
function askHidden(question) {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  let s = '';
  return new Promise((resolve) => {
    stdin.on('data', function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(s);
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        s = ch === '\u007f' || ch === '\b' ? s.slice(0, -1) : s + ch;
      }
    });
  });
}

const USAGE = `用法：node ${SELF} <命令> [参数]
  login <zhuhu|lvcui>                   用户在自己的终端登录（AI 不要代跑）
  whoami
  board [--all]                         列 + 任务（默认不列已完成）
  show <任务>                           详情：描述、子任务、动态
  add "<标题>" [--col 列] [--desc md] [--due 日期] [--priority 级别]
  edit <任务> [--title] [--desc] [--due 日期|none] [--priority 级别]
  move <任务> <列>                       改分组，排到目标列末尾
  done <任务> | undo <任务>             完成 / 取消完成
  rm <任务> --yes
  comment <任务> ["<Markdown>"] [--image 图片路径]   图片接在文字后面
  image <图片地址> [--out 路径]           下载任务里的图片（/files/...）到本地，打印保存路径
  sub <任务> add "<标题>" | done <序号> | undo <序号> | rm <序号>
  col add "<名>" | rename <列> "<新名>" | rm <列> --yes | move <列> <位置>
<任务> = 12 / #12 / 详情链接；<列> = 列名；日期 = YYYY-MM-DD / today / tomorrow / 今天 / 明天 / 后天 / none
优先级 = 0-4 或 ${PRIORITIES.join('/')}；任何命令加 --json 输出原始数据`;

const [name, ...rest] = process.argv.slice(2);
const cmd = commands[name];
if (!cmd) {
  console.log(USAGE);
  process.exit(name && !['help', '-h', '--help'].includes(name) ? 1 : 0);
}
await cmd(parseArgs(rest));
