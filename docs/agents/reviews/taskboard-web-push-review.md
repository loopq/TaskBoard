# Plan Review: taskboard-web-push

**Plan File**: /Users/loopq/dev/git/loopq/taskboard/docs/agents/taskboard-web-push.md
**Reviewer**: Codex

---

## Round 1 — 2026-11-17

### Overall Assessment
方案方向正确，关键代码事实（`taskboard-private` 为 internal、`node:sqlite` 单进程、`due_at` 是浏览器本地零点、SW 已注册、compose 结构）核对基本准确；VAPID 自实现、白名单出网、`push_sent` 去重的取舍也说得通。但它把「推送是否真的可用」完全交给前端 `getSubscription()` 判断，服务端订阅表与 UI 状态没有对账；叠加退出登录/换账号清理不可靠、`due_at` 时区口径不一致、RFC 8291 测试向量按现有函数签名写不出来，按当前 plan 直接实施会出现「UI 显示已开启、实际收不到推送」的静默失败。PRD validation skipped — plan 没有 `**PRD**` 行，也没有飞书原文/本地副本，只有 taskboard #21 的链接，需求原文无法独立核对。

# Plan Review Result

## Decision
REQUEST_CHANGES

## Score
7 / 10

## Blockers
- [High] **服务端订阅状态没有对账，UI 会假显示「已开启」**（`### 前端` 的 `pushState()`/`syncPush()`、`### 路由`、`### 数据结构`）：`pushState()` 只看浏览器侧 `Notification.permission` + `getSubscription()`，没有任何服务端回读。可达路径有三条：① `enablePush()` 的 `POST /push/subscribe` 失败（网络 / 500 / 401）后，浏览器 subscription 仍存在，UI 继续显示「on」；② plan 自己在 `### 风险` 承认「数据库从更早的备份恢复」会导致密钥/订阅丢失，此时 `push_subs` 为空但所有设备 UI 仍显示「on」；③ 推送返回 410 后服务端删行，若浏览器 `getSubscription()` 仍返回旧 subscription，`syncPush()` 不会重新订阅（它只在「拿不到」时才订阅），只会把同一个失效 endpoint 再上报一次，形成 410 → 删行 → 再上报的循环。并且 `syncPush()` 只写在「App 启动时」，而 `web/src/store.ts:113-118` 的 `login()` 是 SPA 内状态切换、不重载页面，`web/src/App.vue:11-14` 的 `onMounted` 只跑一次，登录后不会触发同步。**建议**：加 `GET /push/status`（按当前 endpoint 返回服务端是否已登记 + 登记时的 VAPID 公钥指纹），`pushState()` 把「on」定义为「浏览器有 subscription 且服务端有该 endpoint 记录」；`syncPush()` 在 App 启动和 `store.login()` 成功后都执行；服务端说没有记录或 key 指纹变了时，先 `pushManager.unsubscribe()` 再 `subscribe()`，而不是复用旧 subscription；`Notification.requestPermission()` / `pushManager.subscribe()` 抛错也要有明确错误态（未安装到主屏幕、权限被拒、网络失败）；`enablePush()` 的 POST 失败必须显示可重试错误，不能静默保留「on」。

## Required Changes
- [High] **RFC 8291 测试向量与 `encrypt(sub, payload)` 签名冲突**（`### 服务端` 第 2 条、`### 验证` 第 2 条）：plan 要求 `encrypt(sub, payload)` 内部生成随机 salt / 临时 ECDH 密钥，却又要求用 RFC 8291 附录 A 的固定测试向量做「逐字节一致」校验；随机输入下不可能复现固定密文。**建议**：拆出可注入参数的纯函数（如 `encryptWith({ salt, ephKey, uaPublic, authSecret, payload })`），`encrypt(sub, payload)` 只负责生成随机值并调用它；测试直接调纯函数对 RFC 向量逐字节比对，另加一条「随机加密 → 用订阅私钥解密还原」的 round-trip 测试。
- [High] **退出登录/换账号的订阅清理不可靠，存在隐私泄漏**（`### 前端` 的「退出登录前先 unsubscribe」、`web/src/store.ts:120-125` 的 `logout()`、`### 路由` 的 `/push/unsubscribe`）：当前 `logout()` 是同步清 session、`POST /logout` fire-and-forget；plan 只说「退出登录前先 unsubscribe」，没有要求 await、也没有服务端侧按 token 清理。离线或请求失败时，`push_subs` 行和 Apple 侧订阅都还在，设备重新联网后仍会在 10:30 收到原账号的任务标题，而看板本身是按 `owner` 隔离的，这属于两人之间的隐私边界泄漏。**建议**：`logout()` 改为 async，先 `await POST /push/unsubscribe`（带 Bearer，删自己名下 endpoint）再清 session；失败时仍执行本地 `pushManager.unsubscribe()` 并记录；同时在 `store.login()` 成功后调用 `syncPush()`，覆盖「同一设备换账号但没重载页面」的路径。补一条规则测试：A 订阅 → logout（模拟 unsubscribe 失败）→ 登录 B → B 的 `push_subs` 不得再出现 A 的 owner。
- [Medium] **`due_at` 的浏览器本地零点与上海时区 digest 口径不一致**（`### 现状与约束`、`### 服务端` 第 5 条、`web/src/format.ts:33`）：`fromDateInput` 用 `new Date(s + 'T00:00:00')` 存浏览器本地零点，服务端按 `Asia/Shanghai` 取 `[dayStart, dayStart+86400)`。北京用户无感；但用户在东京（UTC+9）设「今天到期」时，存的是北京时间前一天 23:00，服务端的「今天」窗口会漏掉它；反之在 UTC+9 设「明天」会落进北京「今天」窗口而被提前推送。**建议**：明确「截止日期是北京时间日历日」，把 `fromDateInput`/`toDateInput`/`dayStart` 统一到 `Asia/Shanghai`，或把 `due_at` 改成日期字符串/epoch-day 存储；至少在 `dailyDigest` 测试里加一条「旅行时区创建的 due_at」用例，避免只测上海 00:00/23:59 造成假安全感。
- [Medium] **加密测试没有进部署门禁，scheduler 也没有测试开关**（`### 验证` 第 2 条、`deploy/deploy.sh:5-9`、`api/test/rules.sh:23`、`api/tsconfig.json`）：`deploy.sh` 只跑 `api npm run check`、`rules.sh`、`web build`，新增的 `push.test.ts` 只是手工步骤；`api/tsconfig.json` 的 `include` 只有 `src`，`npm run check` 也不会检查测试文件。更麻烦的是 `server.ts` 一旦启动 scheduler，`rules.sh` 和 release 的隔离测试容器都会跑真实定时器；测试里创建订阅后若跨过 60s tick 且当前已过 10:30，会对假 endpoint 发真实请求，404/410 又会删掉测试订阅，导致后续断言依赖执行顺序。**建议**：`api/package.json` 加 `test:push`，`deploy.sh` 在 `npm run check` 后执行；`package-release.py` 若要镜像内跑测试则把 `api/test/push.test.ts` 加进白名单；scheduler 用 `PUSH_SCHEDULER=0`（或 `NODE_ENV=test`）在 `rules.sh` / 测试容器里关闭，并补一条「同一天两次 tick 只发一次」的测试。
- [Medium] **`p256dh` 只校验长度，非法曲线点会在发送时抛异常，且 send 循环没有按订阅隔离**（`### 路由` 的 subscribe 校验、`### 服务端` 第 4 条）：65 字节只保证长度，不保证是合法的 P-256 未压缩点；`crypto.subtle.importKey`/`deriveBits` 在发送时才抛错。若 `dailyDigest` 后按订阅循环发送时没有逐条 catch，一条坏订阅会中断同 owner 其他设备的发送；而 `push_sent` 已经插入，当天不会重试。**建议**：订阅时用 `crypto.subtle.importKey('raw', ..., { name: 'ECDH', namedCurve: 'P-256' }, false, [])` 真正校验公钥（首字节 0x04 + import 成功），失败返回 400；`send` 对每个订阅 catch，坏订阅删行，不影响同 owner 其他设备。
- [Low] **SSRF 白名单建议补两处硬约束**（`### 决策点` 的「校验 endpoint 白名单」）：plan 的协议 + hostname 后缀方向是对的，但实施时要 `new URL(endpoint)` 后只信 `url.hostname`（不要对原始字符串 `endsWith`），并给 `fetch` 设 `redirect: 'error'`，避免未来某个白名单主机的 30x 把请求带到任意地址；同时拒绝用户名/密码和非 443 端口。这些不是当前 blocker，但既然 plan 自己写了「review 时要重点看 SSRF」，应把规则钉死。
- [Low] **API 形状/签名需要写死，避免实现时对不上**（`### 路由` 的 subscribe body、`### 前端` 的 `sw.js` push、`### 服务端` 第 3 条）：`PushSubscription.toJSON()` 的字段是 `{ endpoint, expirationTime, keys: { p256dh, auth } }`，plan 的校验文字把它写成平铺的 `p256dh`/`auth`，容易实现成永远 400；SW 里必须调用 `self.registration.showNotification(...)`，不是全局 `showNotification`；`vapidHeader(endpoint)` 目前没有私钥参数，测试也需要能注入固定 key/time。建议在 plan 里直接写出请求/响应 JSON 形状和函数签名。

## Missing Context
- PRD validation skipped — plan 没有 `**PRD**` 行，也没有飞书原文/本地副本；taskboard #21 的原文没有嵌入，无法独立核对「10:30」「只推今天到期」「不做定期任务」是否与原需求完全一致。
- iPhone 真机验证只能由用户完成（plan 已声明），当前环境没有 iOS 模拟器；桌面 Chromium 走 FCM 只能证明加密/VAPID 基本正确，不能证明 iOS 主屏幕 PWA 的权限、锁屏展示和点击跳转。
- 目标服务器实际的出网策略（NAT / 防火墙 / IPv6 优先）与 `node:24-bookworm-slim` 的 CA 信任需要在目标机验证；plan 的 `docker exec … fetch` 检查方向正确，但要在真实 `taskboard-egress` 网络上跑，而不是只在默认 bridge 的 release 测试容器里跑。
- `api/tsconfig.json` 的 `include: ["src"]` 不覆盖新增 `api/test/push.test.ts`；若希望 `npm run check` 覆盖测试文件，需要同步改 tsconfig。

## Risk Assessment
- logic: 时区口径（浏览器本地零点 vs Asia/Shanghai）、10:30 后任意时刻重启的补发窗口（23:59 重启会发一条「今天到期」）、`push_sent` 先插后发导致当天失败不重试。
- state: 客户端 subscription 与服务端 `push_subs` 无对账；410 后可能反复上报同一失效 endpoint；`syncPush` 只在挂载时跑，登录/换账号不触发。
- data: VAPID 私钥在 sqlite `kv` 中，随备份走；从 push 功能之前的备份恢复会生成新密钥并清空订阅，UI 无法感知；`push_sent` 7 天清理和 `push_subs` 的 410 清理需要测试。
- UI: 「已开启」可能假阳性；`POST /push/subscribe` 失败没有错误态；`denied`/`unsupported` 文案依赖 iOS 版本；顶栏在 375px 宽度下新增铃铛后需要实际检查是否溢出。
- regression: compose 新增 `taskboard-egress` 会改变 app 的出网面（白名单只在应用层）；`logout()` 变 async 会影响现有退出交互；SW 新 push 处理器需要发版后用户至少打开一次 App 才会生效；CSP 不变是正确判断。

## Test Requirements
- unit: RFC 8291 附录 A 固定向量逐字节一致（可注入 salt/ephKey）；随机加密后解密 round-trip；VAPID JWT 用固定 key/time verify 通过、`aud` 为 endpoint origin、`exp` ≤ 24h；`dailyDigest` 覆盖上海 00:00/23:59、done 任务、他人任务、无任务、单条 `/?t=<no>` 与多条 `/`；`push_sent` 同日两次 tick 只发一次、重启后不重发、7 天清理；白名单反例（`fcm.googleapis.com.evil.com`、`evilfcm.googleapis.com`、`https://fcm.googleapis.com@evil.com`、大写/尾点/`http:`/`file:`/IP/非 443）；`p256dh` 非法曲线点返回 400。
- integration: `rules.sh` 补 401/400 鉴权与校验、跨 owner unsubscribe、同一 endpoint 换 owner（A→B）只留 B、`/push/status` 与服务端表一致、`POST /push/subscribe` 失败时 UI 不显示「on」；scheduler 在测试环境关闭，避免真实外网请求和 410 删行导致顺序依赖。
- manual: iPhone 主屏幕 PWA 开启提醒 → `/push/test` → 锁屏通知 → 点击冷启动/热启动都能到任务；拒绝权限；今天无任务；2 条以上任务；10:30 真实推送；10:30 后重启服务；从旧备份恢复（key/订阅丢失）后 UI 能提示重新开启；离线退出登录后重新联网不再收到原账号通知；多设备同 owner 其中一台 410 不影响另一台。
- deployment: 在真实 `taskboard-egress` 网络上验证 Apple/FCM 出网；`docker compose config` 校验双网络；回滚上一版 compose/image 后 app 仍只连 `taskboard-private`；release 隔离测试容器与生产网络差异有说明。

## Final Verdict
方案值得做、代码事实基本可信，但现在还不能照抄执行：先补服务端订阅状态对账、退出登录/换账号的订阅清理、可复现的 RFC 8291 测试与部署门禁，再开工。

---

## Round 2 — 2026-11-17

### Overall Assessment
Round 2 明显收敛：Round 1 的 #1（服务端订阅状态对账）已用「每次启动/登录 upsert + VAPID 公钥比对 + `on` 必须本次 sync 成功」解决；#2 拆出可注入的 `encryptWith` 以复现 RFC 向量；#5 测试门禁与 `PUSH_SCHEDULER=0`、#6 `p256dh` 曲线点校验与逐设备 catch、#7 双重 `isPushEndpoint` 校验、#8 API 形状都已落地；#4 时区按 trade-off 接受；#3 只解决了在线路径，离线退出仍会泄漏。但 `## 部署` 把实际的 `~/dev/tools/tencent-ubuntu` 写成 `~/tencent-ubuntu`，还说本仓库 `deploy.sh` 只是参考，和 tencent-ubuntu 的部署表及 `taskboard-seoul-deployment.md` §3 直接冲突；`push_subs` upsert 也只写了改 owner、没写更新 keys。PRD validation skipped — plan 明确没有 PRD，只有 2026-11-17 对话引文，需求原文无法独立核对。

# Plan Review Result

## Decision
REQUEST_CHANGES

## Score
7 / 10

## Blockers
- [High] **部署路径和发布入口与现有运维仓库冲突**（`## 部署` 最后一条）：plan 说「实施前先读 `~/tencent-ubuntu/CLAUDE.md`」，但该路径不存在，实际是 `~/dev/tools/tencent-ubuntu/CLAUDE.md`；并且该文件的部署表明确写 Taskboard「用 `bash deploy/deploy.sh` 发布」，`~/dev/tools/tencent-ubuntu/docs/agents/taskboard-seoul-deployment.md` §3 也写「日常发布在 taskboard 仓库使用 Node 24 执行 `bash deploy/deploy.sh`」。plan 却写「仓库内的 `deploy/deploy.sh` 只作为参考」，这与事实相反：`deploy.sh` 就是实际发布门禁，`test:push` 和 `PUSH_SCHEDULER=0` 必须接进它。**建议**：把路径改成 `~/dev/tools/tencent-ubuntu/CLAUDE.md`（同时读 `docs/agents/taskboard-seoul-deployment.md`），删除「只作为参考」，明确 `deploy.sh` 是实际发布入口；部署验收按 `taskboard-seoul-deployment.md` 的备份/回滚流程执行，尤其确认新增 `egress` 网络后回滚到旧 compose 仍只连 `taskboard-private`。

## Required Changes
- [High] **离线退出登录仍可能收到原账号推送，plan 的 410 说法不成立**（`## 前端` 的 `store.logout()` / `disablePush()`）：plan 说「离线退出导致服务端那条记录残留时：本地订阅已经注销，Apple 会对它返回 410」。但 `sub.unsubscribe()` 本身要访问 push service，离线时也会失败；本地订阅并未注销，服务端 `push_subs` 行还在，设备重新联网后仍会收到原 owner 的 `daily` 通知（看板按 owner 隔离，这是隐私边界）。**建议**：二选一——要么在 `logout()` 失败时把 endpoint 记到一个持久化的 pending-unsubscribe 队列，下次 App 打开（即使未登录）先重试 `/push/unsubscribe` 并本地 `unsubscribe()`；要么在 plan 的「风险」和「验证」里明确这是已知残留窗口，删除「Apple 返回 410」的错误论证，并把手动验收改成「在线退出」+「离线退出后重连仍可能收到，下次打开 App 后消失」。不要用不成立的 410 论证把安全边界说成已解决。
- [Medium] **`push_subs` upsert 需要明确更新 `p256dh`/`auth`，不能只改 owner**（`## 路由` 的 `POST /push/subscribe`、`## 数据结构` 的注释）：plan 只写「按 endpoint upsert 并把 owner 设为当前用户」「upsert 改 owner」，没有写更新 keys。VAPID 公钥变化后 `syncPush` 会 `unsubscribe()` + `subscribe()`；如果 push service 复用同一个 endpoint 但下发新 keys，只更新 owner 会留下旧 `p256dh`/`auth`，后续发送失败且 UI 仍显示 on。**建议**：upsert 明确 `SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`；`rules.sh` 的 A→B 同 endpoint 用例同时断言 keys 也变成 B 的。
- [Low] **风险描述与 `send` 的 401/403 行为不一致**（`## 风险` 的「密钥变了（恢复旧备份）→ 旧订阅全部 410 后被清理」）：VAPID 公钥不匹配时 push service 更可能返回 401/403，而 `send` 只对 404/410 删行，其他状态打日志；旧行会保留并每天重试，和「全部 410 后被清理」不符。**建议**：要么在 `send` 对 401/403 也删行（并补测试），要么把风险文案改成「旧行保留，等客户端重新订阅后自然失效」，不要让运维按错误的 410 预期排查。

## Missing Context
- PRD validation skipped — plan 明确「没有 PRD」，只有 2026-11-17 对话引文；需求原文无法独立核对，但引文的三点（10:30、今天到期、以后具体时间主动 push、不依赖快捷指令）在 plan 里都有对应，未发现 scope creep。
- `~/tencent-ubuntu` 不存在；实际运维仓库是 `~/dev/tools/tencent-ubuntu`，Taskboard 的实际发布入口是该仓库部署表和 `docs/agents/taskboard-seoul-deployment.md` 指向的本仓库 `bash deploy/deploy.sh`。这是本轮 blocker 的上下文。
- iOS `getSubscription()` 在「系统设置关通知 / 删除主屏幕图标 / 410 失效」后的返回值没有真机证据；plan 的离线 410 和「App 内显示 denied 或 off」依赖这一行为，需要在 iPhone 上补一次实测。
- 目标服务器真实 `taskboard-egress` 的出网、CA 信任和回滚后的 compose 行为需要在首尔机器上验证；plan 的 `docker exec` 检查方向正确，但 release 隔离容器走默认 bridge，不能替代生产网络验证。

## Risk Assessment
- logic: 时区按 trade-off 接受；10:30 后补发（23:00 恢复也会发）是已知取舍；`send` 401/403 与风险文案不一致。
- state: 客户端/服务端状态对账已解决；离线 logout 残留；stale 410 在公钥未变时仍可能循环；upsert 只改 owner 会留下旧 keys。
- data: VAPID 私钥随 sqlite 备份；恢复旧备份后旧订阅 401/403 而非 410；`push_sent` 先插后发当天失败不重试；`push_subs` 旧行可能累积。
- UI: 「on」要求本次 sync 成功，网络抖动时可能短暂显示 off + error；`denied` 文案是 iPhone 专用，桌面会看到错误指引；375px 顶栏需要真机/浏览器检查。
- regression: 部署路径写错可能导致实际发布不走新门禁；`store.logout()` 变 async 影响现有退出交互；`egress` 网络改变出网面；SW 新 push 处理器需要用户发版后至少打开一次 App；CSP 不变是正确判断。

## Test Requirements
- unit: RFC 8291 附录 A 逐字节一致；`encrypt` 随机加密→UA 私钥解密 round-trip；`vapidAuth` 固定 key/time verify、`aud` origin、`exp` 12h；`isPushEndpoint` 补尾点（`web.push.apple.com.`）、大写主机、`:443` 接受、`:8443` 拒绝、userinfo 拒绝；`parseSubscription` 长度/首字节/非曲线点 400；`dailyDigest` 上海边界、done、他人、无任务、1 条 `?t=`、多条、>4 条；`tick` 10:29 不发/10:30 发/同日两次一次/次日再发/7 天清理；`send` 201/200→ok、404/410→删行、401/403/500→error 且不删；upsert A→B 同 endpoint 的 keys 也变 B。
- integration: `rules.sh` 补 401、400、跨 owner unsubscribe、A→B 同 endpoint 只留 B 且 keys 正确、`/push/test` 返回 `sent`；本地和 release 容器都设 `PUSH_SCHEDULER=0`；在真实 `bash deploy/deploy.sh` 门禁里确认 `test:push` 被执行。
- manual: iPhone 主屏幕开启→测试→锁屏；冷/热启动点击跳转；拒绝权限后再放开；今天无任务；2 条以上；10:30 真实推送；10:30 后重启；恢复旧备份/密钥变化后打开 App 自动重新订阅；在线退出不再收到；离线退出后重连的残留行为按 plan 的最终表述验收；375px 顶栏；桌面 Chromium 走 FCM 全流程。
- deployment: 按 `~/dev/tools/tencent-ubuntu/CLAUDE.md` 与 `docs/agents/taskboard-seoul-deployment.md` 执行；`bash deploy/deploy.sh` 的实际门禁包含 `test:push`；真实 `taskboard-egress` 验证 Apple/FCM 出网；`docker compose config` 双网络；回滚旧 compose/image 后 app 仍只连 `taskboard-private`。

## Final Verdict
方案已接近可执行，但部署路径/发布入口和离线退出的 410 论证必须改；`push_subs` 更新 keys 也要补上，改完可以进入实施。

---

## Round 3 — 2026-11-17

### Overall Assessment
Round 3 把 Round 2 的 blocker 和 High 都收掉了：部署路径改成 `~/dev/tools/tencent-ubuntu` 并明确 `bash deploy/deploy.sh` 是实际发布入口；离线退出改成 `tb_push_pending` 队列 + 公开 unsubscribe 补做 + 明确残留窗口；`push_subs` upsert 更新 owner/p256dh/auth；401/403 的风险文案也改对了。剩下的是三处一致性/边界问题：路由标题和 `rules.sh` 的「全部 Bearer/未登录 401」与 `/push/unsubscribe` 公开矛盾，pending 补做可能 unsubscribe 掉新账号的订阅，以及公开 unsubscribe 这个 capability URL 的测试/日志边界。PRD validation skipped — plan 明确没有 PRD，只有 2026-11-17 对话引文。

# Plan Review Result

## Decision
REQUEST_CHANGES

## Score
8 / 10

## Blockers
- None — Round 2 的 blocker 和 High 已解决。

## Required Changes
- [Medium] **路由鉴权模型自相矛盾**（`### 路由（api/src/index.ts，全部需要 Bearer）`、同节 `/push/unsubscribe` 行、`### 验证` 3 的第一条/第四条）：标题说所有 `/push/*` 需要 Bearer，表格说 `/push/unsubscribe` 公开，`rules.sh` 又要求「未登录访问 `/push/*` 返回 401」，同时要求「不带 Bearer 也能 `/push/unsubscribe`」。这是 Round 2 离线清理修复的关键：如果实现按标题给 unsubscribe 加 Bearer，离线 pending 补做会 401，旧账号推送会继续。**建议**：标题改成「除 `/push/unsubscribe` 外需要 Bearer」；`rules.sh` 的 401 用例只覆盖 `/push/key`、`/push/subscribe`、`/push/test`，unsubscribe 单独测「无 Bearer 有效 endpoint 删除成功 + 非白名单 400」。
- [Medium] **pending 补做可能 unsubscribe 掉新账号的订阅**（`### 前端` 的 `store.logout()` / 「补做」）：pending 里存的是 endpoint，补做时「重跑第 3 步」是 `POST /push/unsubscribe` + `sub.unsubscribe()`；`PushSubscription.unsubscribe()` 只能作用于当前 `getSubscription()`。如果 A 离线退出留下 pending，B 在同一设备登录并订阅后 pending 仍存在，下一次 App 启动会把这个调用作用在 B 的当前订阅上，B 的本地订阅被注销；`syncPush` 随后通常会重新订阅，但 sync 失败时 B 会显示 off/error。**建议**：补做时先取当前 `sub`，只有 `sub?.endpoint === pending.endpoint` 才 `sub.unsubscribe()`；否则只 `POST /push/unsubscribe` 删服务端 pending endpoint，绝不动当前订阅。补一条手动/纯函数用例：A 离线退出 → B 登录并开启 → 再启动，B 仍能收到。
- [Low] **公开 unsubscribe 是 capability URL，需要钉死测试和日志边界**（`### 路由` 的 `/push/unsubscribe`）：endpoint 本身可作为 capability 删订阅，最坏是 DoS（让某台设备收不到推送），plan 已明确接受这个 trade-off；但 `rules.sh` 没有「随机合法但不存在 endpoint → ok 且不误删别人行」的用例，`send` 的日志若把 endpoint 全量打出来也会扩大泄漏面。**建议**：补随机 endpoint no-op 测试；日志只打状态/主机名，不打完整 endpoint；代码注释里写明「endpoint 等同 unsubscribe 凭据」。

## Missing Context
- PRD validation skipped — plan 明确「没有 PRD」，只有 2026-11-17 对话引文；引文的三点（10:30、今天到期、以后具体时间主动 push、不依赖快捷指令）都有对应，未发现 scope creep。
- `tb_push_pending` 的补做逻辑没有进入 `api/test/push.test.ts` 或 `rules.sh`（前端也没有测试框架）；目前只有一条手动验收。若担心回归，至少把「是否该 unsubscribe 当前订阅」抽成纯函数并加 `node:test` 用例。
- 公开 `/push/unsubscribe` 后，endpoint 的泄漏面（浏览器 DevTools、服务端日志、`localStorage` pending）需要确认；plan 只论证了「不可猜测」，没说明日志脱敏。
- iPhone `getSubscription()` 在系统设置关通知/删除主屏幕图标后的返回值仍需真机确认；plan 的 denied/off 和 pending 残留窗口依赖它。
- 真实 `taskboard-egress` 出网和回滚已在 plan 里，但需要在首尔机器上实测；release 隔离容器走默认 bridge，不能替代生产网络。

## Risk Assessment
- logic: 时区按 trade-off 接受；10:30 后补发是已知取舍；公开 unsubscribe 的 capability 语义。
- state: pending 队列解决了离线退出，但补做可能作用于新订阅；pending 若 localStorage 被清则丢失；`disablePush()` 离线失败没有 pending/失败态（UI 可能保持 on，用户可重试）。
- data: VAPID 私钥随 sqlite 备份；401/403 不删行是合理取舍；`push_sent` 先插后发当天失败不重试；`push_subs` 旧行可能累积。
- UI: 「on」要求本次 sync 成功，网络抖动时短暂 off + error；denied 文案是 iPhone 专用，桌面会看到错误指引；375px 顶栏需要检查。
- regression: 路由鉴权标题若被照做会让离线清理失效；公开 unsubscribe 放宽了删除权限；`store.logout()` 变 async 影响退出交互；`egress` 网络改变出网面；SW 新 push 处理器需要发版后至少打开一次 App。

## Test Requirements
- unit: RFC 8291 附录 A 逐字节一致；`encrypt` round-trip；`vapidAuth` 固定 key/time；`isPushEndpoint` 尾点/大写/`:443`/`:8443`/userinfo；`parseSubscription` 长度/首字节/非曲线点；`dailyDigest` 上海边界/已完成/他人/无任务/1 条/多条/>4 条；`send` 201/200/404/410/401/403/500；`tick` 10:29/10:30/同日两次/次日/7 天清理；`push_subs` upsert A→B keys 也变 B；pending 判断纯函数（当前 endpoint ≠ pending 时不 unsubscribe）。
- integration: `rules.sh` 401 只覆盖 `/push/key`、`/push/subscribe`、`/push/test`；`/push/unsubscribe` 无 Bearer 删除有效 endpoint、非白名单 400、随机 endpoint no-op；A→B 同 endpoint keys；`PUSH_SCHEDULER=0`；真实 `bash deploy/deploy.sh` 门禁包含 `test:push`。
- manual: iPhone 主屏幕开启→测试→锁屏；冷/热启动点击；拒绝/放开权限；10:30 真实推送；10:30 后重启；恢复旧备份/密钥变化；在线退出不再收到；离线退出→重连打开 App 后清理；A 离线退出→B 登录开启→再启动，B 不被误注销；375px；桌面 Chromium FCM。
- deployment: 按 `~/dev/tools/tencent-ubuntu/CLAUDE.md` 与 `docs/agents/taskboard-seoul-deployment.md`；`bash deploy/deploy.sh` 实际门禁；真实 egress；双网络；回滚旧 compose/image。

## Final Verdict
方向和主体已经站住，改掉路由鉴权表述与 pending endpoint 校验即可实施；公开 unsubscribe 的 capability 边界补测试和日志脱敏。
