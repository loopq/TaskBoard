# 两人看板：改名、新图标、日夜模式与账号图谱式版式

> 2026-11-13 · 状态：已批准并实施，本机验证通过，见 §6
> 任务：[#14 名字重新取](https://task.loopq.cn/?t=14) · [#15 手机桌面图标改动](https://task.loopq.cn/?t=15) · [#17 没有日夜模式，UI 不如 Account 好看](https://task.loopq.cn/?t=17)（评论附账号图谱 iPhone 亮色截图）
> 参照：AccountRelation `web/index.html`（token / 组件）、`web/theme.js`（防闪烁）
> 前作：[taskboard-ui-redesign.md](taskboard-ui-redesign.md)（纸、墨、印；当时明确把暗色模式留作「后续一个文件的事」）

## 0. 用户已定

| 问题 | 决定 |
|---|---|
| 新名字 | **两人看板** |
| 图标方向 | 「来点有创意的，你自行设计」 |
| 日夜模式 | **跟随系统 + 手动三档**（跟随系统 / 亮色 / 暗色），选择记在本机 |
| 风格程度 | **布局向账号图谱靠，保留朱砂**：底色、卡片、边框、字号、控件全面对齐账号图谱；完成印章、过期、非常紧急、危险操作仍是朱砂 |

三个任务其实是一件事：让 taskboard 和账号图谱成为同一家族的产品。

## 1. 数据流（唯一的新状态）

```
localStorage['taskboard.theme'] = 'system' | 'light' | 'dark'   （缺省 system）
        │  解析：system → matchMedia('(prefers-color-scheme: dark)')
        ▼
<html data-theme="light|dark">  +  <meta name="theme-color" content=当前画布色>
        ▼
style.css：:root = 亮色 token，[data-theme='dark'] = 暗色 token；组件只读 token
```

- 写入方只有一个：顶栏的主题按钮（`theme.ts`）。
- `public/theme.js` 只负责**首帧前**套上主题（CSP 是 `script-src 'self'`，不能内联；它是同源静态文件，`server.ts` 从 `web/dist` 自动扫描，不用改服务端）。`theme.ts` 和它共享 3 行解析逻辑，注释标明两处要同步。
- 选「跟随系统」时监听 `matchMedia` 的 change，系统切夜间看板跟着变；固定亮/暗时不监听。

## 2. 改动清单

### 2.1 改名（#14）

| 位置 | 改成 |
|---|---|
| `index.html` `<title>`、`apple-mobile-web-app-title` | 两人看板 |
| `manifest.webmanifest` `name` / `short_name` | 两人看板 |
| `Board.vue` 顶栏、`Home.vue` 首页 | 图标 mark + 「两人看板」 |

**不改**：域名、`taskboard.token` / `taskboard.user` 存储键（改了会把两个人都登出）、`sw.js` 缓存名、CLI / skill 的 `taskboard`、仓库名、API。

### 2.2 图标（#15）：「两」字就是一块看板

把「两」拆开画：顶上一横 = 看板标题栏，「冂」= 看板外框，框里两个「人」= 两个人。一个金色（账号图谱的强调色），一个朱砂（taskboard 原来的印章色）。深色方底和账号图谱图标同族，两个图标并排放在主屏上看得出是一家。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#0e0f13"/>
  <rect x="116" y="110" width="280" height="32" rx="16" fill="#ece9e2"/>
  <path d="M140 398V190a18 18 0 0 1 18-18h196a18 18 0 0 1 18 18v208" fill="none" stroke="#ece9e2" stroke-width="32" stroke-linecap="round"/>
  <circle cx="212" cy="234" r="27" fill="#d4a857"/>
  <path d="M178 360l34-66 34 66" fill="none" stroke="#d4a857" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="300" cy="234" r="27" fill="#d2402a"/>
  <path d="M266 360l34-66 34 66" fill="none" stroke="#d2402a" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

- 草稿已在 180 / 120 / 60 / 32px 渲染核对，32px 仍可辨认。
- 方底铺满，规避 iOS 透明角填黑；最远的点（标题栏左上角）离中心 203px，落在 Android maskable 安全圆（半径 205）内，所以 `icon-512.png` 继续兼作 maskable，manifest 的图标条目不用改。
- `favicon.svg` 是唯一源文件，PNG 都由它生成：`rsvg-convert -w N` 出 180（`apple-touch-icon.png`）/ 192 / 512，再用 `pngquant` 压缩。文件名不变。
- 页内的品牌 mark 直接用 `<img src="/favicon.svg">`（24px，圆角 6px），不新增组件，也不另存一份 SVG。

### 2.3 日夜模式（#17 上半）

- **`web/public/theme.js`**（新增，约 6 行）：读偏好 → 设 `data-theme` 和 `theme-color`。在 `index.html` 的 `<head>` 里用普通 `<script src>` 同步加载，抢在首帧之前。
- **`web/src/theme.ts`**（新增，约 25 行）：`pref` ref、`cycleTheme()`（跟随系统 → 亮色 → 暗色 → 跟随系统）、`matchMedia` 监听。
- **`Board.vue` 顶栏**：在头像左边加一个图标按钮，图标随档位换（显示器 / 太阳 / 月亮），`title` 和 `aria-label` 写当前档位，例如「主题：跟随系统」。`Icon.vue` 补 `monitor` / `sun` / `moon` 三条 path。首页不放按钮，按本机偏好或系统显示即可。
- **`index.html`**：`apple-mobile-web-app-status-bar-style` 由 `default` 改成 `black-translucent`（和账号图谱一致，你的 iPhone 上已经验证过亮色下状态栏文字正常）。`default` 在暗色模式下会在顶上留一条白边。顶栏、抽屉、首页本来就留了 `env(safe-area-inset-top)`，不用另外处理。
- **`style.css`**：每组 token 都声明 `color-scheme`，让原生日期选择器、下拉框、滚动条跟着变色。约 20 处写死的颜色（`#fff`、`rgba(27,27,26,…)`、`#343432`、`#b9361f`）全部收进 token。图片预览本来就是黑底，保持不变。

### 2.4 版式向账号图谱靠，保留朱砂（#17 下半）

**token（亮 / 暗）**：取账号图谱的色值，朱砂、琥珀、链接色单独调。

| token | 亮 | 暗 | 用途 |
|---|---|---|---|
| `--canvas` | `#f4f4f0` | `#0e0f13` | 画布 |
| `--panel` | `#eeeee8` | `#1f232c` | 次级填充：按钮、数量药丸、代码底 |
| `--surface` | `#ffffff` | `#171a21` | 卡片、抽屉、菜单、首页卡 |
| `--field` | `#fcfcfa` | `#0f1116` | 输入框 |
| `--line` / `--line-strong` / `--line-soft` | `#e1e1d9` / `#c9c9bf` / `#ebebe4` | `#272b36` / `#3a3f4d` / `#1f232c` | 边框 |
| `--ink` … `--ink-4` | `#1b1d22` `#4a4f5b` `#7a7f8c` `#b4b7bf` | `#e9e7e1` `#b6b9c3` `#7f8493` `#4b505d` | 文字四级 |
| `--accent` / `--accent-ink` / `--accent-soft` | `#b07d2e` / `#1a1507` / 13% | `#d4a857` / `#1a1507` / 14% | **金**：主按钮、焦点、选中 |
| `--red` / `--red-soft` | `#d2402a` / `#fbe9e5` | `#e2604a` / 14% | **朱砂**：完成、过期、非常紧急、危险、错误 |
| `--amber` | `#c2620a` | `#e0913a` | 「紧急」：比原来更偏橙，和金色拉开距离 |
| `--link` | `#3d7196` | `#6a9cbd` | Markdown 链接 |
| 阴影 / 遮罩 / hover 填充 | 账号图谱亮色值 | 账号图谱暗色值 | |

**组件**：

- **全局**：字体统一走无衬线，去掉 serif wordmark 和红色句点。按钮改成账号图谱的样式：`--panel` 底加细边框；主按钮是金底深字。输入框是 `--field` 底，聚焦时金边加 `--accent-soft` 光环。`:focus-visible` 改成金色描边。
- **顶栏**：mark +「两人看板」（15px / 650）+ 日期 + 过期 / 今天统计；右侧依次是主题按钮、头像、退出。底部加 1px 分隔线，同账号图谱的 `header.top`。
- **桌面列**：「画布上的圆角面板」改成账号图谱的「通高列 + 1px 发丝线分隔」。列宽仍是 288px、可横滚，列头加底线（13px / 600 + mono 数量药丸）。拖拽、锁定列、空列虚线占位、幽灵「新建列」的行为都不变。
- **卡片**：圆角 11px，内边距 12 / 14 / 12 / 17，`shadow-1`，hover 时抬起并换 `shadow-2`。**左侧 3px 色条 = 优先级色**（「无」优先级不画色条），对应账号图谱的分类色条。截止和优先级改成账号图谱的染色 chip：过期用朱砂、今天用琥珀、优先级用各自的颜色。子任务数、评论数仍是纯文字，编号 mono 靠右。
- **手机分组条**：参照账号图谱的 tabbar。当前项是 `--surface` 凸起加细边和 `shadow-1`，其余透明，底部加分隔线。仍然横滑，因为列数是动态的，不能平分宽度。
- **详情抽屉**：`--surface` 底加左边框；遮罩 `rgba(0,0,0,.45)` + `blur(3px)`。分节小标题和属性表标签改成账号图谱的 `group-title`（11px / 650 / 字距 .08em / `--ink-3`）。宽度保持 600px，内容比账号图谱多。
- **首页**：参照账号图谱的登录门。居中一张卡（`--surface` 底、细边、`shadow-2`、圆角 16），背景两团径向光晕，左上金、右下朱砂，和图标里的两个人对应。卡内：mark +「两人看板」、副标题「两个人，各一本。」、两个用户行（未选中是 `--field` 底；选中后金边加 `--accent-soft`，原地展开密码框）。`Home.vue` 的逻辑不动，只改 class 和样式。
- **Toast**：胶囊形，`--ink` 底、`--canvas` 字，两种主题都成立。
- **保留朱砂的地方**：✓ 完成按钮的填充和盖章动画、抽屉里的「已完成」印章、过期、「非常紧急」、删除等危险操作、错误提示、子任务进度条满格。

## 3. 破坏性分析

- API、数据库、`store.ts` 写路径、`sortable.ts`、`AddInput` 的提交约定：**零改动**。
- 改的文件：`style.css`（主要）、`Board.vue` / `Home.vue` / `TaskCard.vue` / `BoardColumn.vue` / `TaskDrawer.vue` 的少量 class、`Icon.vue`（+3 path）、`index.html`、`manifest.webmanifest`、`favicon.svg` 和三张 PNG；新增 `public/theme.js`、`src/theme.ts`。
- CSP 不放宽：`theme.js` 同源；动态样式继续走 Vue `:style`；`<img src="/favicon.svg">` 在 `img-src 'self'` 之内。
- `sw.js` 对图标和 manifest 用的是 stale-while-revalidate：发版后第一次打开可能还是旧图标，第二次打开就是新的。
- **iOS 主屏图标和名字是在「添加到主屏幕」那一刻存下的**：发布后要删掉旧图标、重新添加，才能看到「两人看板」和新图标。两部手机都要做一次。
- 手机断点仍是 640px；单列加保留组件实例（切组不丢草稿）的机制不动。

## 4. 验证

1. `cd web && npm run build`（vue-tsc + vite）。
2. 本机起 API + 生产构建（CSP 生效），按 `taskboard-playwright-verification` 记忆里的做法，Chromium + WebKit 各跑一遍：
   - 截图：桌面 1440×900 和手机 390×844 × 亮 / 暗，每种截首页、看板、详情抽屉、已完成列、空列。
   - 主题：点按钮三档循环，刷新后保持；`emulateMedia({ colorScheme })` 切系统深浅色时，「跟随系统」档跟着变、固定档不变；DOMContentLoaded 时 `data-theme` 已经有值（不闪）。
   - 回归：新建 → 完成（盖章）→ 取消完成 → 跨列拖拽 → 手机切组 → 抽屉改截止 / 优先级，Esc 关闭。
   - 控制台零 CSP 违规（WebKit 截图注入样式的报错是已知假阳性）。
3. 暗色对比度抽查：`--ink-3` 在 `--canvas` / `--surface` 上 ≥ 4.5:1。
4. 对照 §0 的四条决定和 #17 的截图逐条复核。

## 5. 发布

验证通过、你确认后执行 `bash deploy/deploy.sh`（脚本要求 Node 24，用 `/tmp/node24`）。不 commit、不 push。发布后在 #14 / #15 / #17 各留一条评论，说明改了什么，并提醒重新添加主屏图标。

## 6. 执行记录（2026-11-13）

改动只在 `web/`：`style.css`、`index.html`、`manifest.webmanifest`、`favicon.svg` 和三张 PNG、`Board.vue`、`Home.vue`、`Icon.vue`；新增 `public/theme.js`、`src/theme.ts`。API、数据库、`store.ts`、`sortable.ts`、`AddInput` 零改动。

与 §2 的偏差：

- **优先级色阶**：照搬 token 后，「较低」= `--ink-4` 的 chip 文字在白卡上几乎看不见。改成较低 `--ink-3` 灰 → 普通 `--link` 蓝 → 紧急琥珀 → 非常紧急朱砂，四档一眼可分；蓝色和账号图谱的 Email 蓝同色。
- **亮色对比度**：账号图谱原值 `--ink-3 #7a7f8c` 在画布上只有 3.63:1，压到 `#696e7a`（4.63:1）；琥珀 `#c2620a` 在白底上 4.16:1，压到 `#b05506`（5.06:1）。暗色各项本来就 ≥ 4.66:1。
- **图标名**：`Icon.vue` 新增的三条 path 直接叫 `system / light / dark`，按钮写 `:name="themePref"`，省掉一张映射表。
- **首页首字母方块**：第一个人金、第二个人朱砂，和图标里的两个人对上（纯 CSS：`.user-row + .user-row`）。
- **顺手修的旧问题**：手机详情里「添加子任务」输入框比内容区宽 10px（桌面那套负边距在手机有边框时露馅），手机下归零。

验证（生产构建 + API 自托管，CSP 生效；样例数据：3 列 8 任务，含过期 / 今天 / 各级优先级 / 子任务 / 评论 / 已完成）：

- `npm run build`（vue-tsc + vite）通过；`dist/` 含 `theme.js`。
- 截图：桌面 1440 / 手机 390 × 亮 / 暗 × 首页、看板、分组、详情，逐张核对。
- e2e：**Chromium 23/23、WebKit 22/22**（WebKit 不模拟原生拖拽，少一项）。覆盖：DOMContentLoaded 时 `data-theme` 已就位（不闪）；跟随系统随 `emulateMedia` 切换；固定亮 / 暗不受系统影响；刷新保持；`theme-color` 跟随；标题和顶栏是「两人看板」；回车新建 → 完成 → 取消完成；抽屉改截止 / 优先级同步到卡片 chip 和左侧色条；Esc 关闭；拖拽跨列（空列、非空列）；手机切组、「新建任务」与 `···` 同行、「添加子任务」不越界、分组条分隔线。两个引擎控制台**零错误、零 CSP 违规**（WebKit 跑的时候没截图）。
- 排查记录：拖拽用例一度失败，原因是按下点在卡片左 40px，落在 ✓ 按钮扩大后的触控热区（15 + 18 + 10 = 43px）里，被 Sortable 的 `filter: '.tick'` 正确拦下。不是回归，改为从标题处按下即可。
- 未覆盖：iPhone 真机上 `black-translucent` 状态栏在「手动暗色 + 系统亮色」组合下的文字颜色，以及重新添加主屏后的图标实际效果，需要用户实测。

发布（2026-11-13，用户授权「直接部署到线上」）：`deploy/deploy.sh`（PATH 前置 `/tmp/node24`，即从 nodejs.org 下载并核对 SHA256 的 v24.22.2）—— 本机 rules **150/150**，服务器隔离镜像 **149/149**，发布前备份 `predeploy-20261113T064704Z-3407045.db` 校验通过（线上 4 列 15 任务），`taskboard-app-1` healthy，release **`2ee4c16bee86cba85e15`**。线上核对：`index.html` 标题 / `apple-mobile-web-app-title` 为「两人看板」、`theme.js` 在主脚本前加载、`apple-touch-icon.png` 与本地逐字节一致、CSP 未变；Chromium 打开线上首页亮 / 暗两种配色，`data-theme` 正确、控制台零错误。未 commit、未 push。

发布后只改了 `public/theme.js` 一行注释（把 `resolve()` 改正为 `apply()`），下次发布时一并带上。
