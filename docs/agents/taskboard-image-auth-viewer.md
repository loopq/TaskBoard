# taskboard：图片访问鉴权 + 居中图片预览

> 来源：task.loopq.cn 任务 [#5](https://task.loopq.cn/?t=5)「task 图片地址控权限，不让外部用户访问」、[#6](https://task.loopq.cn/?t=6)「图片预览有问题，直接跳转新页面全屏打开了，用居中弹窗承载，仿照 bilibili 的照片预览形式」，以及 #6 的评论「评论中的图片无法点击查看放大」
> 状态：已批准（2026-11-09：验证通过后直接发布）

## 1. 现状与根因

- **#5**：`GET /api/files/<用户>/<uuid>.<ext>` 是公开路由，只靠 122 位随机 uuid 不可猜来保护（设计文档 §6 记下的已知天花板）。链接一旦外泄，比如截图里地址栏上那条，任何人都能打开。之所以这么做，是因为 `<img>` 带不了 `Authorization` 头。
- **#6**：描述预览里点图片会执行 `window.open(src)`，直接开新标签页；评论气泡里的图片根本没有绑定点击处理。

## 2. #5 方案：文件专用 Cookie

浏览器加载 `<img>` 时唯一能自动带上的凭据就是 Cookie，所以：

- **Cookie 内容**：`tb_files=<现有 token>; Path=/api/files; HttpOnly; SameSite=Strict; Max-Age=1 年; Secure`（本机 `127.0.0.1` / `localhost` 调试时不加 Secure）。值就是现有的 Bearer token，不另造凭据。HttpOnly 让 JS 读不到它；token 本来就存在 localStorage 里，所以不会多暴露什么。
- **只给文件用**：Path 限定在 `/api/files`，服务端也只有读图片这一个接口认 Cookie，其他接口照旧只认 Bearer，所以不会引入 CSRF 面。
- **下发时机**：放在 `dispatch` 里统一处理。任何一次 Bearer 鉴权成功的请求，如果 Cookie 缺失或和 token 不一致，就在响应上补一个 `Set-Cookie`。前端每次启动都会先拉 `/board`，而图片只可能在看板加载之后才渲染，所以没有竞态，也不需要新增 session 接口。**已经登录的设备和缓存里的旧版前端都不受影响**：下一次拉 `/board` 时就会自动拿到 Cookie。
- **读图规则**（`getFile`）：鉴权顺序是先 Bearer、后 Cookie。没有凭据或凭据无效返回 401；路径里的 `<用户>` 和当前登录用户不一致返回 404（沿用「越权一律 404」）。缓存头从 `public` 改成 `private, max-age=31536000, immutable`。
- **退出**：新增公开路由 `POST /api/logout`，返回清 Cookie 的 `Set-Cookie`（Max-Age=0）。前端 `logout()` 时调用它，token 失效被动登出时也一样。
- **已知天花板**：退出后，本机浏览器缓存里已经看过的图片还在（`private` 缓存，只在这台设备上）。要彻底清掉，得改成 `no-store`，代价是每次都重新下载，不值得。
- **skill 跟着补**：外部访问关掉之后，AI 也没法再用 curl 看图了（比如这次我就是靠 curl 下载 #6 的截图）。新增 `tb image <地址> [--out 路径]`：带 Bearer 下载到临时目录，打印本地路径，AI 再用 Read 打开。SKILL.md 同步说明。
- **副作用（预期内）**：以前贴到外面（比如飞书）的图片链接全部失效。这正是 #5 要的效果。

## 3. #6 方案：居中图片预览（参照 B 站）

- **用原生 `<dialog>`** 加 `showModal()`：系统自带遮罩层（`::backdrop`）、焦点限制在弹窗内、Esc 关闭，不引入任何依赖。新组件 `ImageViewer.vue`，放在详情抽屉里。
- **布局**（参照 B 站的图片查看器）：深色半透明遮罩；图片居中，等比缩放到不超过约 92vw × 80vh；右上角是计数 `2 / 5`、向左旋转、向右旋转、查看原图（新标签打开，同站请求会带上 Cookie）、关闭；有多张图时，左右两侧显示圆形翻页箭头，底部是缩略图条，当前那张高亮。
- **交互**：点遮罩空白处、× 或按 Esc 关闭；←/→ 翻页；手机上照常可以双指缩放（页面没有禁止缩放）。
- **图片范围**：一个任务相当于一条「动态」，所以弹窗里能翻**这个任务详情里的所有图片**（描述加评论，按页面顺序），而不是只翻当前这一段。
- **接线**：在抽屉正文上做一个点击事件委托：点到 `.md img` 就收集抽屉里所有的 `.md img`，然后从被点的那张打开预览。描述里点图片不再进入编辑模式（`onPreviewClick` 对图片直接 return），评论里的图片也就能点了。抽屉自己的 Esc 处理在预览弹窗打开时跳过，避免按一次 Esc 把抽屉也一起关掉。

## 4. 改动清单

- `api/src/auth.ts`：核心校验抽成 `verify(token)`，`authenticate` 继续只认 Bearer；新增 `fileUser`（先 Bearer 后 Cookie）、Cookie 的生成和清除。
- `api/src/index.ts`：鉴权成功后同步 Cookie；新增 `POST /logout`。
- `api/src/files.ts`：`getFile` 加鉴权和本人校验，缓存头改为 private。
- `api/test/rules.sh`：「/files 不鉴权可读」改成一组新断言：未登录 401、本人 Bearer/Cookie 200、他人 404、篡改 Cookie 401、只带 Cookie 访问其他接口 401、Cookie 一致时不重复下发、logout 清 Cookie。
- `web/src/store.ts`（logout 调用 `/logout`）、`web/src/components/ImageViewer.vue`（新增）、`TaskDrawer.vue`（事件委托、Esc）、`Icon.vue`（旋转、箭头、原图图标）、`style.css`。
- `skills/taskboard/scripts/tb.mjs`、`SKILL.md`：新增 `image` 命令。
- `docs/agents/private-task-board-design.md` §6：删掉「`/files` 公开」这条天花板，改写成新的鉴权说明。

## 5. 验证与发布

1. 本机：API 类型检查；`rules.sh` 全部通过；web 构建；e2e 在 WebKit / Chromium、手机 / 桌面视口下跑：登录后描述和评论里的图片能正常显示（证明 Cookie 生效）；不带凭据直接请求图片地址返回 401；点图打开居中预览，可以翻页、旋转、Esc 关闭且抽屉不跟着关、点遮罩关闭；退出后图片地址返回 401。用 skill 的 `image` 命令下载一张图验证。
2. 发布：`deploy/deploy.sh`（发布前备份、隔离测试、失败回滚）。
3. 发布后：线上验证未登录访问图片返回 401；你的 Chrome 里图片照常显示、预览弹窗正常；用 skill 给 #5、#6 写说明并标记完成。

## 6. 执行记录（2026-11-09）

- **本机**（Node 24.22.2）：API 和 web 类型检查、构建通过；`rules.sh` **150/150**。原来的「/files 不鉴权可读」改为新增的图片上传 / Cookie 断言：未登录 401、他人 404、篡改 401、Cookie 不能调其他接口、正式域名带 Secure、重复不下发、换号重发、logout 清除。
- **实施中顺带修掉的问题**：`server.ts` 会把 `host` 当成逐跳头剥掉，业务代码拿不到 Host，导致本机也被加上了 Secure。改为构造请求 URL 时带上真实 Host，Host 非法时退回占位域名（已验证不会 500）。
- **e2e**：图片专项在 WebKit / Chromium、手机 / 桌面四种环境下都是 22/22（Cookie 生效、401、预览开关、翻页、缩略图、旋转后仍在屏幕内、Esc 不关抽屉、点空白关闭、单图隐藏导航、退出后 401）；主流程回归 22/22、22/22、23/23、23/23。测试要点：验证服务端行为时必须带 `cache: 'no-store'`，否则 Chromium 会直接从 `private` 缓存返回 200，这正是 §2 写的那条已知天花板。
- **观感调整**：遮罩不透明度 0.86 → 0.92；打开时把焦点交给弹窗本身，消掉第一个按钮上的焦点环。
- **生产**：release **`ccb39b7b0352f681d19e`**，发布前备份通过，服务器隔离测试 149/149。线上：未登录访问图片 401；skill `image` 下载的内容和发布前一致；用户 Chrome 里没有重新登录，3 张图正常显示，不带 Cookie 请求 401、带 Cookie 200；点图打开居中预览「2 / 3」，没有新开标签页，Esc 只关预览。#5、#6 已用 skill 写说明并标记完成。
