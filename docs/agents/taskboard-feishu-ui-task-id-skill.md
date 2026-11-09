# taskboard：飞书风格改版 + 任务编号/链接 + AI 操作 skill

> 来源：task.loopq.cn 待处理的 2 个任务（2026-11-09 用 playwright-ext 读取）
> - A「taskboard 写的不好，还不能当做成品使用」：① 手机上错位 ② 手机上点击输入 task 没反应，整体做手机适配 ③ UI 照飞书写，白色、简单 ④ 详情对齐飞书（今天 / 明天等）
> - B「skill 类似 wed 增删改查，面向 AI 使用…包括改动状态、改动分组」
> - 补充（对话）：任务要有 task id，像飞书详情右上角能拿到详情页链接
> 状态：已批准（2026-11-09：编号用递增 #12；本机验证通过后直接发布）

## 1. 结论

三件事的主线是同一个数据：**任务编号**。它让详情页有链接，也让 skill 能用 `#12` 定位任务。做法是先补数据，再改 UI，最后写 skill。

| 件 | 做什么 | 不做 |
|---|---|---|
| 编号 + 链接 | `tasks.no`（全局递增整数），卡片 / 详情显示 `#12`；`https://task.loopq.cn/?t=12` 直接打开详情；详情右上角「复制链接」 | 不改主键（UUID 照旧），不新增 API 路由 |
| 飞书风格 UI | 换白底 + 飞书配色；看板、卡片、详情抽屉按飞书截图重排；截止日期改成「今天 / 明天 / 其他时间」 | 不加列表视图、仪表盘、筛选、负责人、任务清单、附件（飞书有，我们本期不做，见设计文档 §1） |
| 手机适配 | 修 iOS 聚焦、键盘、安全区、视口高度问题 | — |
| skill | `skills/taskboard/`：零依赖 Node CLI + SKILL.md，覆盖任务 / 子任务 / 评论 / 列的增删改查和完成状态 | 不做图片上传（YAGNI，需要时再加） |

## 2. 任务编号（数据层）

- **为什么用整数而不是 UUID 前缀**：要能说出口、能手打（「把 #12 挪到进行中」），飞书也是 `t142857` 这种编号。主键仍是 UUID，所有现有接口和数据零改动。
- **schema**：`tasks` 加 `no INTEGER`，唯一索引 `idx_tasks_no`。
- **迁移**（`sqlite.ts` 的 `openDb`，schema.sql 之后执行，幂等）：`PRAGMA table_info(tasks)` 里没有 `no` 时 `ALTER TABLE ADD COLUMN`，按 `created_at, rowid` 回填 1..n，再建唯一索引。线上目前 3 条任务，发布前有自动备份。
- **分配**：`createTask` 的 INSERT 里 `(SELECT COALESCE(MAX(no), 0) + 1 FROM tasks)`。单进程同步执行加事务，没有竞态；唯一索引兜底。
  - 已知天花板：删掉「最大编号」的那条任务，下一条新任务会复用这个号。换成独立计数器表可以避免，但对两个人用的看板来说不值得。
- **全局编号而非每人各自编号**：一条唯一索引搞定，链接不会有歧义；查询仍带 `owner`，拿别人的编号照样 404。
- **接口**：`/board` 和 `/tasks/:id` 的返回里带上 `no`。编号到 id 的解析放在前端和 skill（它们本来就拉了 `/board`），**服务端不加新路由**。

## 3. 详情链接

- URL 用查询参数 `/?t=12`：服务端静态白名单、Service Worker 的导航缓存（按 `/` 缓存）都**不用改**。如果换成 `/t/12` 路径，要动这两处。
- 打开详情时 `history.replaceState` 写成 `?t=12`，关闭时恢复成 `/`。用 replace 不用 push，这样不必处理返回键。
- 启动时（以及登录成功后）读 `?t`，看板加载完就打开对应任务；编号不存在就提示「任务不存在」并清掉参数。
- 详情右上角：`#12` 标签 + 「复制链接」按钮（`navigator.clipboard.writeText`，成功弹 toast）。

## 4. 飞书风格 UI

以 task A 里的两张飞书截图为准，主要改 `style.css`（主题变量整体替换）和几个组件的模板，交互逻辑基本不动。

- **主题**：白底；主色飞书蓝 `#3370FF`；文字 `#1F2329 / #646A73 / #8F959E`；边框 `#DEE0E3`；危险色 `#F54A45`。去掉纸张底纹、朱砂印章、衬线字体，统一用系统无衬线字体，圆角 6/8px。
- **看板**：列不再有底色块，列头是「名称 + 灰色计数」，「···」菜单保留。卡片白底细边框、圆角 8，左边一个 ○；下面一行显示元信息：截止（过期标红「11月6日 截止」）、子任务进度、评论数、优先级。选中态是蓝色描边。列底部的「+ 新建任务」是灰字。
- **详情抽屉**（桌面在右侧约 560px，手机全屏）：
  - 顶栏：「✓ 完成任务」蓝色描边按钮（已完成时显示「已完成」，点了取消完成）；右边依次是 `#12`、复制链接、删除、关闭。
  - 标题加粗放大。下面是带图标的字段行：所在列（下拉）、截止（快捷标签 **今天 / 明天 / 其他时间**，「其他时间」点开原生日期选择器；选了日期后显示「11月9日 截止 ×」）、优先级（下拉）、描述（空的时候灰字「添加描述」，点一下就编辑，保留 Markdown + 贴图）、子任务（灰字「添加子任务」）。
  - 分隔线以下是「评论」：系统动态（灰点 + 文字 + 时间）和用户评论。底部固定评论输入框。
- **首页 / 登录**：同一套白底主题，结构不变。

## 5. 手机适配

本机 Chromium 模拟 iPhone 13 时，看板、添加任务、打开详情都正常，所以问题集中在 iOS Safari / PWA 独有的行为上。下面是按根因修，不是给某条路径单独打补丁：

1. **点「添加任务」没反应**（已确认：手机上没有按回车的习惯，而现在只有回车才会创建；创建流程也不连贯）。根因有两个：现在**只有回车**才创建，失焦时打的字就悬在那里；另外输入框是先 `v-if` 渲染、再在 `nextTick` 之后 `focus()`，iOS 只认用户手势里**同步**发起的聚焦，键盘可能弹不出来。
   修法：「+ 新建任务」本身就是一个常驻的 `<input>`（和「添加子任务」同一种做法），点它就是原生聚焦，`adding` 状态、`nextTick` 聚焦这些特殊分支全部删掉。三种方式都能创建，都走同一个 submit（标题为空就什么都不做）：**回车**；**输入框有字时右侧出现「添加」按钮**（`pointerdown.prevent` 防止失焦，键盘不收）；**失焦时有内容**。创建后清空并保持聚焦，方便连续录入；点空白处结束。`enterkeyhint="done"`。新建列的输入框同样处理。
2. **错位**：`html/body/#app` 用的是 `height: 100%`，iOS 工具栏伸缩、键盘弹出收起之后，布局会偏移。改成 `100dvh`，不支持时退回 100%。顶栏、抽屉顶栏、评论框补全 `safe-area-inset`（目前只处理了 top / bottom 的一部分）。
3. 卡片和按钮的点击热区不小于 44px；手机上列宽保持 88vw 横滑吸附，不变。
4. 验证：本机 Playwright **WebKit**（Safari 同引擎）+ iPhone 视口跑一遍完整流程，再加 Chromium 模拟；最后由你在 iPhone 上实测（我没有真机，本机也没有 iOS 模拟器运行时）。

## 6. skill（task B）

- **位置**：源码放仓库 `skills/taskboard/`（`SKILL.md` + `scripts/tb.mjs`，零依赖，需要 Node 18+）。和 wed 一样软链安装：`~/.agents/skills/taskboard → 仓库目录`，`~/.claude/skills/taskboard → ~/.agents/skills/taskboard`，Claude 和 Codex 共用。
- **登录（密码不经过 AI）**：`tb.mjs login zhuhu` 只能在**你自己的终端**里跑，隐藏输入密码，换到的 1 年期 token 写进 `~/.config/taskboard/credentials.json`（0600）。没有 TTY 时直接拒绝，不从 stdin 读密码。也支持用环境变量 `TASKBOARD_TOKEN` / `TASKBOARD_BASE` 覆盖（本机测试用）。401 时提示重新 login。
- **命令**（`<task>` 可以是 `12` / `#12` / 详情链接；`<列>` 用列名）：

```
board [--all]                         列 + 任务（默认不含已完成）
show <task>                           详情：描述、子任务、动态
add "<标题>" [--col <列>] [--desc md] [--due 日期] [--priority 级别]
edit <task> [--title] [--desc] [--due 日期|none] [--priority]
move <task> <列>                       改分组（排到目标列末尾）
done <task> | undo <task>             完成 / 取消完成
rm <task> --yes                       删除（必须带 --yes）
comment <task> "<md>"
sub <task> add "<标题>" | done <序号> | undo <序号> | rm <序号>
col add "<名>" | rename <列> "<新名>" | rm <列> --yes | move <列> <位置>
whoami
```

  - 日期接受 `YYYY-MM-DD / today / tomorrow / 今天 / 明天`，换算成本地零点（和前端一致）；优先级接受 `0-4` 或 `无/较低/普通/紧急/非常紧急`。
  - 默认输出精简文本，方便 AI 阅读；`--json` 输出原始数据。所有业务规则（不能拖进「已完成」、锁定列等）仍由服务端判定，CLI 只把错误原样报出来。
  - 不照搬 wed 的「写操作默认 dry-run」：这是私人看板，只有删除需要 `--yes`。

## 7. 改动清单

- `api/schema.sql`、`api/src/sqlite.ts`（迁移）、`api/src/tasks.ts`（CARD_SQL 加 `no`、createTask 分配编号）
- `api/test/rules.sh`：新增编号相关断言（新建递增、两账号共用一个序列但越权 404、迁移回填）
- `web/src/store.ts`（`no` 字段、`?t=` 同步）、`TaskDrawer.vue`、`TaskCard.vue`、`BoardColumn.vue`、`Board.vue`、`Home.vue`、`Icon.vue`（新增 link 等图标）、`format.ts`（快捷日期）、`style.css`（主题重写）、`index.html`（theme-color）
- 新增 `skills/taskboard/`
- `deploy/server/taskboard-release`：解包后刷新 mtime（见 §9，发布时发现的流水线 bug）
- `docs/agents/private-task-board-design.md` §4 / §6 / §7 同步更新编号、链接和 UI 描述

## 8. 验证与发布

1. 本机：`api` 类型检查；`rules.sh` 全部通过（原有 132 项 + 新增）；`web` 构建；在 Playwright WebKit 和 Chromium 的 iPhone、桌面视口下跑完整流程截图（看板、新建任务、详情、今天/明天、复制链接、`?t=` 直达、完成/取消完成）；skill 对着本机服务把每条命令跑一遍。另外用线上库的结构做一份副本，演练迁移。
2. 发布：`deploy/deploy.sh`（自带发布前备份、隔离容器跑 rules.sh、失败回滚）。已授权：本机验证全部通过后直接发布。
3. 发布后：你在自己的终端跑 `node ~/.claude/skills/taskboard/scripts/tb.mjs login zhuhu`；然后我用 skill 给 A、B 两个任务写完成说明并标记完成，这一步同时也是 skill 的线上验收。iPhone 实测由你来做，不满意可以直接「取消完成」打回。
4. 不 commit、不 push，除非你另外要求。

## 9. 执行记录（2026-11-09）

- **本机**（Node 24.22.2）：API 类型检查通过；`rules.sh` **135/135**（原 132 项，新增编号 2 项、迁移 1 项）；web 类型检查和构建通过。e2e 在 WebKit iPhone 13 22/22、WebKit 桌面 22/22、Chromium iPhone 13 23/23、Chromium 桌面 23/23 全部通过（Chromium 多一项剪贴板内容校验），覆盖三种新建方式、今天/明天/其他时间、子任务、描述、复制链接、完成/取消完成、`?t=` 直达与不存在编号、控制台 0 错误。另外用旧版代码建的真实库演练了迁移：3 条任务按创建顺序回填 #1–#3，`integrity_check=ok`。
- **skill**：对着本机服务把全部命令和错误路径跑了一遍；`login` 用伪终端加隔离的 HOME 验证：密码不回显，凭据文件 0600、目录 0700，没有 TTY 时拒绝。已软链安装到 `~/.agents/skills/taskboard`、`~/.claude/skills/taskboard`、`~/.codex/skills/taskboard`。
- **发布流水线 bug（顺带修复）**：第一次发布被服务器隔离测试的「assets 缓存」一项拦下，生产未受影响。根因是打包时 mtime 统一为 0，docker build 又按「大小 + mtime + 权限」增量同步构建上下文；新旧 `index.html` 大小相同，于是镜像里混进了旧的 `index.html`，配的却是新的 assets（如果放行上线就是白屏）。修复：`deploy/server/taskboard-release` 解包后把文件 mtime 刷成当前时间。之前没暴露，是因为上一次发布前端没有改动。
- **生产**：release **`f48257ab8dd29c6891f6`**，发布前备份 `predeploy-20261109T065001Z-551665.db` 校验通过；服务器隔离容器 rules **134/134**（迁移项只在本地跑）。上线后：health 200，资源 hash 与本地构建一致，容器 healthy；迁移结果 #1「自己的 todo 平台」、#2 task A、#3 task B，`integrity_check=ok`；用户 Chrome 里 `/?t=2` 直达详情正常。
- **待用户**：在自己的终端运行 `node ~/.agents/skills/taskboard/scripts/tb.mjs login zhuhu`，之后用 skill 给 #2、#3 写说明并标记完成；iPhone 实测。
- **追加：卡片最小高度**（用户截图反馈「自适应高度有点丑」）：`.card` 加 `min-height: 94px`，也就是「两行标题 + 一行元信息」那张卡的自然高度；更长的标题照常撑高。本机 e2e 四种环境全部通过；发布 release **`b54c2a16c48c2e67e397`**（rules 本机 135/135、服务器 134/134，发布前备份通过）。线上实测 #2、#1 都是 94px，#3（4 行标题）是 112px。
