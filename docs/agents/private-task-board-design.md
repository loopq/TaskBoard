# 私人 Task 看板（taskboard）设计方案

> 来源：飞书 task t142857「自己的 todo 平台，公私分开，iOS 和网页端」
> 状态：待审核 · 2026-11-02

## 1. 目标与边界

两个用户（zhuhu / lvcui）各自独立的看板式 task 工具，网页 + iPhone（PWA）可用。

**做**：自定义列看板、拖拽、完成按钮、Markdown 描述 + 图片、优先级、截止日期、子任务、评论 + 动态记录、PWA 安装。

**不做（本期）**：提醒推送、列表视图、仪表盘、搜索/筛选、多人协作、改密码、注册。

## 2. 架构

```
task.loopq.cn  ── GitHub Pages（Vite 构建的静态 PWA，public 仓库）
       │  fetch + Bearer token（CORS）
taskboard-api.<account>.workers.dev ── Cloudflare Worker
       ├─ D1（SQLite）：columns / tasks / subtasks / comments / login_fail
       └─ R2：图片
```

- **DNS 不迁移**：`task.loopq.cn` 在阿里云 DNS 加 CNAME → `loopq.github.io`。
- **API 用 workers.dev**。已知天花板：`*.workers.dev` 在国内直连经常 DNS 污染，需要代理（iPhone 也要开代理）。
  升级路径：以后把 loopq.cn 的 NS 迁到 Cloudflare，给 Worker 绑 `task-api.loopq.cn`，前端只改 `VITE_API_BASE` 一个常量，零代码改动。
- 仓库公开：代码里不含任何密钥。密码、token 签名密钥全部用 `wrangler secret`。`wrangler.toml` 里的 D1 database_id 不算机密。

### 仓库结构

```
taskboard/
  api/                 Worker（无框架，手写约 20 行路由）
    src/index.ts
    schema.sql
    wrangler.toml
  web/                 Vite + Vue 3
    src/
    public/manifest.webmanifest, icons, CNAME
  .github/workflows/pages.yml
  docs/agents/
```

### 依赖（尽量少）

| 用途 | 选择 | 理由 |
|---|---|---|
| 前端框架 | Vue 3 + Vite | 轻量，SFC 写看板/抽屉足够 |
| 拖拽 | SortableJS | 支持触屏，用 `group.put` 原生禁止拖入「已完成」 |
| Markdown | marked + DOMPurify | 渲染 + XSS 过滤（安全措施，不可省） |
| 编辑器 | 原生 `<textarea>` + 「编辑/预览」切换 | 粘贴/选择图片 → 上传 → 插入 `![](url)`，不引入富文本编辑器 |
| Worker | 无依赖 | Web Crypto 做 HMAC，路由手写 |

## 3. 认证

- Worker secrets：`PW_ZHUHU`、`PW_LVCUI`、`TOKEN_SECRET`。
- `POST /login {user, password}`：用户名只接受白名单 `zhuhu | lvcui`；密码做常量时间比较；通过后签发 token = `base64(user.exp).HMAC-SHA256(TOKEN_SECRET)`，有效期 1 年。
- **防爆破**：D1 表 `login_fail(user, count, locked_until)`，连续失败 5 次锁 10 分钟。
- 前端：token 存在 localStorage，有 token 就直接进看板（「保存登录」）；退出 = 清 token 回首页。
- 吊销：轮换 `TOKEN_SECRET` 会让所有登录失效（密码不改，这是唯一的吊销手段，够用）。
- **隔离**：每个请求解析 token → `uid`，所有 SQL 带 `owner = uid`；子表（subtasks/comments）通过 task 的 owner 校验。越权一律返回 404。

## 4. 数据结构（D1）

```sql
CREATE TABLE columns (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('todo','normal','done')),
  sort REAL NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL,
  column_id TEXT NOT NULL REFERENCES columns(id),
  title TEXT NOT NULL, desc_md TEXT NOT NULL DEFAULT '',
  sort REAL NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,      -- 0 无 / 1 较低 / 2 普通 / 3 紧急 / 4 非常紧急
  due_at INTEGER,                           -- unix ms
  done_at INTEGER, prev_column_id TEXT,     -- 完成时记录来源列
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE subtasks (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user','system')),
  body_md TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE login_fail (user TEXT PRIMARY KEY, count INTEGER, locked_until INTEGER);
CREATE INDEX idx_tasks_owner_col ON tasks(owner, column_id, sort);
CREATE INDEX idx_comments_task ON comments(task_id, created_at);
```

- **排序**：`sort` 用浮点数，插入到两项之间时取两者的中点，只更新被拖的那一行。浮点精度耗尽（约 50 次同位置插入）时整列重新编号（1, 2, 3…），由服务端检测后处理。
- **列初始化**：用户首次 `GET /board` 时如果没有列，创建 `待处理(todo,0)`、`进行中(normal,1)`、`已完成(done,1e9)`。
- **评论与动态共用一张表**：`kind='system'` 由服务端自动写，记录创建任务、移动到某列、完成、取消完成。

## 5. 列与任务规则（服务端强制，前端只做体验）

| 操作 | 规则 |
|---|---|
| 新建列 | 只能是 `normal`，排在 todo 和 done 之间 |
| 改名 | `todo` / `done` 不可改；`normal`（包括默认的「进行中」）可改 |
| 列排序 | 只有 `normal` 列可以排，位置限制在 todo 和 done 之间 |
| 删除列 | 只能删 `normal`，并且列里没有任务，否则返回 409 |
| 拖拽移动 | 目标列不能是 `done`（400）；`todo` 和 `normal` 之间可以任意互相移动 |
| 完成 | `prev_column_id = 当前列`，`column_id = done`，`done_at = now` |
| 取消完成 | 回到 `prev_column_id`；该列已被删除则回 `todo`；清空 `done_at` |
| 在「已完成」列内 | 允许组内排序，不允许拖出（拖出只能通过取消完成） |

## 6. API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /login | 登录，返回 token |
| GET | /board | 列 + 任务卡片（带子任务进度、评论数） |
| POST / PATCH / DELETE | /columns[/:id] | 列的增、改名排序、删 |
| POST | /tasks | 新建（指定列，不能是 done） |
| GET | /tasks/:id | 详情 + 子任务 + 时间线 |
| PATCH | /tasks/:id | title / desc_md / priority / due_at |
| POST | /tasks/:id/move | `{column_id, sort}` |
| POST | /tasks/:id/complete · /uncomplete | 完成 / 取消完成 |
| DELETE | /tasks/:id | 删除（级联删子任务、评论） |
| POST / PATCH / DELETE | /tasks/:id/subtasks[/:sid] | 子任务 |
| POST / DELETE | /tasks/:id/comments[/:cid] | 评论（system 类型不可删） |
| POST | /upload | 上传图片，返回 `{url}` |
| GET | /files/:key | 从 R2 读图（公开） |

- **图片**：前端先用 canvas 压缩成 webp（长边不超过 1920px），key = `uid/uuidv4.webp`，大小限制 5MB。
- **已知天花板**：`<img>` 标签带不了 Authorization 头，所以 `/files` 不鉴权，靠 128 位随机 key 不可猜来保护。删除任务时不清理 R2 里的图片（成本可以忽略）。如果以后需要严格保护，升级路径是改成短期签名 URL。
- CORS 只放行 `https://task.loopq.cn` 和 `http://localhost:5173`。

## 7. 前端

- `/`：两张用户卡片「zhuhu 🔐 / lvcui 🔐」；如果已登录，直接跳转看板。
- 点卡片 → 输入密码 → 进入看板。看板右上角显示当前用户名和退出按钮。
- **看板（桌面）**：各列横向排列，列头显示名称、数量和 `···` 菜单（改名 / 删除，锁定列没有菜单），最右边是「+ 新建列」。卡片样式参考 Teambition：○ 完成圆圈、标题、优先级旗标、截止日期（过期标红）、子任务进度 `0/3`、评论数。
- **详情抽屉**（桌面在右侧，移动端全屏）：参考飞书。顶部「✓ 完成任务 / 取消完成」，然后是标题、列选择器（下拉里不含「已完成」）、优先级、截止日期（原生 `<input type="date">`）、描述（Markdown 编辑/预览）、子任务、时间线（评论 + 动态），底部是评论输入框（支持 Markdown 和贴图）。
- **移动端**：列用 `scroll-snap` 横向滑动，每列宽 88vw；SortableJS 设置 `delay: 200, delayOnTouchOnly`，长按后才开始拖动，避免和滚动冲突；详情里的列选择器作为备用的移动方式。
- **PWA**：`manifest.webmanifest`（`display: standalone`）、`apple-touch-icon`、`apple-mobile-web-app-capable`，加上一个只缓存静态资源的 service worker（数据不做离线）。
- 刷新策略：页面重新可见（`visibilitychange`）时重新拉 `/board`。只有自己一个人在操作，不需要实时推送。

## 8. 部署

### 一次性（需要你操作）

1. 注册 Cloudflare，在 Dashboard 开通 R2（需要绑卡，额度内免费）。
2. 本地执行 `npx wrangler login`。
3. 我来执行：`wrangler d1 create taskboard`、`wrangler r2 bucket create taskboard-files`、`wrangler d1 execute --remote --file schema.sql`。
4. 你来执行：`wrangler secret put PW_ZHUHU` / `PW_LVCUI` / `TOKEN_SECRET`（密码不经过我）。
5. 在 GitHub 建 public 仓库 `taskboard`，Pages 的 Source 选 GitHub Actions，自定义域名填 `task.loopq.cn`。
6. 阿里云 DNS 添加 CNAME `task` → `loopq.github.io`，再到 GitHub 勾选 Enforce HTTPS。

### 日常

- 前端：push 到 main 后由 Actions 自动构建发布；`VITE_API_BASE` 写在 workflow 的 env 里。
- API：本地执行 `npm run deploy`（`wrangler deploy`）。

## 9. 实施步骤

1. `api/`：schema、认证、路由、列和任务规则、上传；用 `wrangler dev` 加 curl 脚本验证所有规则和越权场景。
2. `web/`：首页和登录、看板加拖拽、详情抽屉、Markdown 和图片、子任务、时间线。
3. PWA 和移动端适配；在 iPhone Safari 上「添加到主屏幕」实测。
4. 编写 Actions workflow，部署后做线上验收。

## 10. 验收清单

- [ ] 两个账号互相看不到对方的列和任务；用 A 的 token 请求 B 的 task id 返回 404
- [ ] 连续输错 5 次密码后锁定
- [ ] 关闭浏览器后重新打开仍保持登录；退出后需要重新输入密码
- [ ] 拖不进「已完成」；点「完成」后进入已完成；取消完成后回到原列（原列已删则回到待处理）
- [ ] 待处理 / 已完成不能改名、不能删除；有任务的列不能删除
- [ ] 粘贴截图能上传并在预览中显示；Markdown 中的 `<script>` 被过滤
- [ ] 评论能发送；时间线能看到创建、移动、完成的系统记录
- [ ] iPhone 添加到主屏后全屏打开、能长按拖拽、能从相册上传图片
