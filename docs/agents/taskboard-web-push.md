# 两人看板 Web Push：每天 10:30 推送今天到期的任务

关联任务：[#21 通知？定期 Task？](https://task.loopq.cn/?t=21)（本 plan 只做「通知」；「定期任务」另开 plan）。#20 Siri 不在本 plan 范围。没有 PRD，需求来自 2026-11-17 对话：「统一早上 10 点半 push 今天到期的任务，以后有具体时间也能主动 push，不依赖本机快捷指令」。

## 目标

- iPhone 上已添加到主屏幕的看板 PWA，每天 **10:30（北京时间）** 收到一条系统通知，内容是「今天到期、还没完成」的任务。今天没有就不推送。
- 推送由服务器按时间主动发出，不依赖手机上的快捷指令或 App 是否打开。
- 结构上留好扩展口：以后任务加了「具体提醒时间」，同一个调度器、同一张去重表直接复用，不用推倒重来。

不做：定期任务、过期任务汇总、按任务设置提醒时间（只留扩展口）、App 角标、两人之间互相通知。

## 现状与约束（已读代码确认）

| 事实 | 位置 | 影响 |
|---|---|---|
| 单进程 Node 24 + `node:sqlite`，api 没有任何运行时依赖 | `api/package.json`、`api/src/server.ts` | Web Push 协议用 `node:crypto` 自己实现，不引入 `web-push` 包 |
| `due_at` 是**浏览器本地零点**的毫秒值，只到日期 | `web/src/format.ts` `fromDateInput` | 服务端按 `Asia/Shanghai` 计算「今天」（见「时区口径」） |
| 看板按 `owner` 隔离，两个账号各推各的 | `api/src/tasks.ts` | 订阅要记录属于哪个 owner；换账号是隐私边界 |
| `login()` 只切换 SPA 内的状态，不重载页面；`logout()` 同步执行，`POST /logout` 发出后不等结果 | `web/src/store.ts:113-125` | 订阅同步必须挂在 login 成功后，不能只在启动时做；logout 要先清掉推送订阅 |
| SW 已注册，manifest 是 `standalone` | `web/src/main.ts`、`web/public/manifest.webmanifest` | iOS 16.4+ 加到主屏幕后就能用 Push API |
| **app 容器只连了 internal 网络，出不了网** | `deploy/compose.yaml`、`deploy/server/taskboard-release:84-89` | 推送请求到不了 Apple，必须先开出网（见「决策点」） |
| 部署门禁：`deploy.sh` 跑 `npm run check`、`rules.sh`、`web build`；release 用隔离容器再跑一遍 `rules.sh` | `deploy/deploy.sh`、`deploy/server/taskboard-release:52-75` | 新测试要接进门禁；测试环境必须关掉调度器 |
| 运行时的 secret 都来自 `/etc/taskboard/secrets.env`，只有首次部署时生成 | `taskboard-release:90` | VAPID 密钥不放这里，首次启动时自动生成并存进数据库 |

## 决策点：容器出网怎么开（已定：A，2026-11-17）

**采用 A：给 app 再挂一个普通 bridge 网络 `taskboard-egress`。**
- `taskboard-private` 保持 internal，release 脚本的检查不改，共享 Caddy 不动。
- 代价是 app 有了完整的出网能力，所以在应用层钉死发送目标（`isPushEndpoint(s)`，订阅时和发送前**都**校验一遍）：
  - `new URL(s)` 能解析，`protocol === 'https:'`，`username`/`password` 为空，`port` 为空（即 443），总长度 ≤1024
  - 只认解析后的 `url.hostname`（URL 解析已转小写；先去掉一个尾点 `.`；显式 `:443` 解析后 port 为空，自然接受），满足以下任一条件：
    - 主机名以 `.push.apple.com` 结尾
    - 主机名等于 `fcm.googleapis.com`
    - 主机名以 `.push.services.mozilla.com` 结尾
  - 不对原始字符串做 `endsWith`
  - `fetch` 设 `redirect: 'error'`，防止白名单主机的 30x 把请求带走

## 时区口径

「截止日期」定义为**北京时间的日历日**。服务端把 `due_at` 换算成北京时间的日期后，跟北京时间的「今天」比较。在北京设置日期（主要场景）结果完全正确。

已知天花板：在其他时区设置的日期会按设置时的本地零点存储，换算成北京时间后可能偏一天（东京设置「今天」→ 存的是北京时间前一天 23:00）。现在两个人都在北京时间，不改 `format.ts`（改了会影响现有的到期/过期显示）。要升级的话，就把 `due_at` 改成存日期字符串，前后端一起改。

## 数据结构

`api/schema.sql` 追加（幂等，旧库启动时自动建表）：

```sql
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,           -- 设备唯一；upsert 时 owner / p256dh / auth / created_at 一起覆盖
  owner TEXT NOT NULL,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL,   -- base64url
  created_at INTEGER NOT NULL
);
-- 推送去重：key 形如 daily:zhuhu:2026-11-17；以后的按任务提醒用 task:<id>:<remind_at>
CREATE TABLE IF NOT EXISTS push_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
-- 小型键值：目前只存 VAPID 密钥对
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
```

- VAPID 密钥对：首次启动时如果 `kv` 里没有 `vapid`，就生成一对 P-256 密钥，以 JWK 存进去，跟着现有 sqlite 备份走。万一密钥变了（比如从更早的备份恢复），前端 `syncPush` 会发现公钥对不上，自动重新订阅（见前端部分），用户不需要手动操作。
- `push_sent` 每次调度 tick 时顺手删掉 7 天前的记录。

## 服务端

### 新文件 `api/src/push.ts`（目标 ≤180 行）

签名写死，方便测试注入：

```ts
isPushEndpoint(s: string): boolean
parseSubscription(body): Promise<{ endpoint, p256dh, auth }>      // 校验失败抛 HttpError(400)
vapidKeys(db): Promise<{ publicKey: string /* b64u 65B */, privateKey: CryptoKey, publicRaw: Uint8Array }>
// 纯函数，RFC 8291 测试向量直接调它
encryptWith(o: { payload: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array,
                 salt: Uint8Array, asKeyPair: CryptoKeyPair }): Promise<Uint8Array>
encrypt(sub, payload): Promise<Uint8Array>   // 生成随机 salt + 临时 ECDH 密钥后调 encryptWith
vapidAuth(endpoint: string, keys, nowSec: number): Promise<string>  // 'vapid t=<jwt>, k=<pub>'
send(db, sub, msg: { title, body, url, tag }): Promise<'ok' | 'gone' | 'error'>
dailyDigest(db, owner: string, day: string /* YYYY-MM-DD 上海 */): Promise<Msg | null>
tick(db, nowMs: number): Promise<void>
startScheduler(db): void
```

1. `parseSubscription`：body 形状 = `PushSubscription.toJSON()` = `{ endpoint, expirationTime, keys: { p256dh, auth } }`。依次校验：
   - `isPushEndpoint(endpoint)`
   - `auth` 解码后正好 16 字节
   - `p256dh` 解码后 65 字节、首字节 `0x04`，并且 `crypto.subtle.importKey('raw', …, {name:'ECDH', namedCurve:'P-256'})` 能成功（确认它真的是曲线上的点）
   - 任何一项不过返回 400
2. `encryptWith`：RFC 8291 `aes128gcm`，ECDH → HKDF（auth_info、CEK、nonce）→ AES-128-GCM，单条记录，padding 分隔符 `0x02`。
3. `vapidAuth`：RFC 8292 JWT，ES256（WebCrypto `sign` 输出本来就是 r‖s 格式），payload 为 `{ aud: endpoint 的 origin, exp: nowSec + 12h, sub: 'https://task.loopq.cn' }`。
4. `send`：发送前再跑一次 `isPushEndpoint`，然后 `fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000) })`，带 `TTL: 43200`、`Urgency: normal`、`Content-Encoding: aes128gcm`、`Authorization`。
   - 201/200 → `ok`
   - 404/410 → 删除这条订阅，返回 `gone`
   - 其他状态或异常 → 打日志，返回 `error`
   - **整个函数自己 catch，不往外抛**，一个设备出错不影响同一 owner 的其他设备
   - 天花板：失败不重试（每天只有一条，漏了第二天还会推）。要重试的话，再给 `push_sent` 加一个状态列来升级。
5. `dailyDigest`：查出 `owner = ? AND done_at IS NULL AND due_at IS NOT NULL` 的任务，按北京时间日期等于 `day` 过滤（用 SQL 粗筛 `due_at` 落在 `day` 前后 36h 的范围，再用 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` 精确判断）。排序：优先级降序，然后 sort 升序。没有任务返回 null。
   - `title`：`今天到期 · N 项`
   - `body`：前 4 条标题，每行一条，超过 4 条加「…等 N 项」
   - `url`：只有 1 条时是 `/?t=<no>`，否则是 `/`
   - `tag`：`'daily'`

### 调度器

- `startScheduler(db)` 在 `server.ts` 里启动，除非 `process.env.PUSH_SCHEDULER === '0'`。启动时先执行一次 tick，之后每 60s 一次（`setInterval(...).unref()`）。
- `tick(db, nowMs)`：
  1. 取北京时间的 `day` 和时间，早于 10:30 直接返回。
  2. 对 `SELECT DISTINCT owner FROM push_subs` 里的每个 owner，先 `INSERT OR IGNORE INTO push_sent` 写入 key `daily:<owner>:<day>`，**写入成功才继续**。
  3. 生成 `dailyDigest`，不为空就逐个设备 `send`。
  4. 最后清理 7 天前的 `push_sent`。
- 效果：服务在 10:30 前后重启不会重复发；10:30 时宕机、恢复后当天会补发（比如 23:00 恢复，就 23:00 发一条「今天到期」，可以接受）。
- 天花板：单进程定时器，多实例时由 `push_sent` 主键兜底不重复。现在只有一个实例。
- 扩展口（本期不实现）：tasks 加 `remind_at`，tick 里再加一个 `remind_at <= now AND done_at IS NULL` 的查询，去重 key 用 `task:<id>:<remind_at>`。

### 路由（`api/src/index.ts`，除 `/push/unsubscribe` 外都需要 Bearer）

| 方法 | 路径 | 请求 → 响应 |
|---|---|---|
| GET | `/push/key` | → `{ publicKey }` |
| POST | `/push/subscribe` | `PushSubscription.toJSON()` → `{ ok: true }`；先 `parseSubscription`，再 `INSERT … ON CONFLICT(endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`（**同一设备换账号，旧 owner 的订阅连同 keys 都被覆盖**） |
| POST | `/push/unsubscribe` | `{ endpoint }` → `{ ok: true }`；**公开路由，不要求 Bearer**：按 endpoint 删除。endpoint 是推送服务下发的不可猜测 URL，持有它就等于持有这台设备（最坏后果只是让那台设备收不到推送），这样退出登录后也能补做清理。endpoint 先过 `isPushEndpoint` 和长度校验，不存在也返回 ok。代码注释写明「endpoint 等同于退订凭据」；**所有日志只打状态码和主机名，不打完整 endpoint** |
| POST | `/push/test` | → `{ sent: n }`；立刻把当天摘要推给自己的所有设备（没有到期任务就推「今天没有到期任务」），**不写 `push_sent`** |

## 前端

### `web/public/sw.js` 追加

- `push`：`e.waitUntil(self.registration.showNotification(title, { body, tag, data: { url }, icon: '/icon-192.png' }))`。**iOS 要求每条推送都必须弹出通知**，所以 JSON 解析失败时也要弹一条兜底通知「两人看板有新提醒」。
- `notificationclick`：`e.notification.close()`，然后 `clients.matchAll({ type: 'window' })`：
  - 有窗口：`focus()` 后 `navigate(url)`
  - 没有窗口：`clients.openWindow(url)`

### 新增 `web/src/push.ts`（约 70 行）

- `pushState()` 返回：
  - `unsupported`：没有 `PushManager`。iOS 上就是还没添加到主屏幕
  - `denied`：`Notification.permission === 'denied'`
  - `on`：已授权、浏览器有订阅，并且**本次会话里 `syncPush` 成功过**
  - `off`：其余情况
  - 结果存进一个 reactive 的 `pushStatus`，加上 `error?: string`
- `syncPush()`：已授权时执行。在 **App 启动时（已登录）和 `store.login()` 成功后**都调用。
  1. `GET /push/key`
  2. 取 `getSubscription()`。没有订阅，或者 `sub.options.applicationServerKey` 和服务端公钥对不上 → 先 `unsubscribe()` 再用新公钥 `subscribe()`
  3. **每次都 `POST /push/subscribe`**（服务端 upsert 是幂等的）：这一步同时处理服务端丢了这条记录、换了 owner、订阅过期这几种情况
  4. 成功 → `on`；失败 → `off` 加上错误文案
  - 不另外做 `/push/status`：每次启动都无条件 upsert 已经能把服务端状态对齐，少一个接口
- `enablePush()`：**必须在点击事件处理里调用**。先 `Notification.requestPermission()`：结果是 `denied` 就转成 `denied` 状态；结果是 `granted` 就走 `syncPush()`。每一步抛错都变成 `error` 文案（「订阅失败，请重试」），不静默显示成「已开启」。
- `disablePush()`：先 `POST /push/unsubscribe`，再 `sub.unsubscribe()`。
- `store.logout()` 改成 async。清 session 之前先执行 `cleanupPush()`：
  1. 取 `getSubscription()`，没有订阅就直接结束
  2. 把 endpoint 写进 `localStorage['tb_push_pending']`
  3. 依次 `POST /push/unsubscribe` 和 `sub.unsubscribe()`，整体 3s 超时
  4. 两步都成功才删掉 pending
  - 失败（比如离线）也照常退出登录
- **补做**：App 每次启动时（不管有没有登录），以及 `syncPush()` 开始前，只要 pending 存在就补做：先 `POST /push/unsubscribe {pending}`，然后**只有当前 `sub?.endpoint === pending` 时才执行 `sub.unsubscribe()`**，否则不碰当前订阅（避免 A 离线退出、B 登录开启后，B 的订阅被误注销）。成功就清掉 pending，失败就保留，等下次再试。
- 已知残留窗口：离线退出后、下次打开 App 之前，这台设备仍可能收到原账号的 10:30 推送。打开 App 联网后就会清理掉。
### UI

看板顶栏加一个铃铛按钮（复用 `Icon.vue`，没有 bell 图标就补一个），点开一个小面板：

| 状态 | 显示 |
|---|---|
| unsupported | 「在 Safari 里点『分享 → 添加到主屏幕』，再从主屏幕打开才能开启提醒」 |
| off | 按钮「开启每日提醒（10:30）」；有 error 时一并显示 |
| on | 「已开启」+「发一条测试」+「关闭」 |
| denied | 「通知已被关闭，请到 iPhone 设置 → 两人看板 → 通知 里打开」 |

- 在 375px 宽度下检查顶栏不溢出。
- 不改 CSP：推送和通知不受 `connect-src` 影响。

## 部署

`deploy/compose.yaml`（方案 A）：

```yaml
    networks:
      private:
        aliases: [taskboard-app]
      egress: {}
networks:
  private: { name: taskboard-private, external: true }
  egress: { name: taskboard-egress }
```

- `taskboard-release` 隔离测试容器的 `docker run` 加 `-e PUSH_SCHEDULER=0`；`api/test/rules.sh` 启动本地服务时也设 `PUSH_SCHEDULER=0`。
- `api/package.json` 加 `"test:push": "node --test test/push.test.ts"`，`deploy/deploy.sh` 在 `npm run check` 之后执行 `npm run test:push`；`api/tsconfig.json` 的 `include` 加上 `test/**/*.ts`。
- 部署方式：先读 `~/dev/tools/tencent-ubuntu/CLAUDE.md`（部署表）和 `~/dev/tools/tencent-ubuntu/docs/agents/taskboard-seoul-deployment.md`。**实际发布入口就是本仓库的 `bash deploy/deploy.sh`**（Node 24），`test:push` 和 `PUSH_SCHEDULER=0` 必须接进这条门禁，备份和回滚按 seoul-deployment 文档执行。回滚到旧的 compose 后，app 只连 `taskboard-private`（旧 compose 里没有 egress，这是预期行为）。
- 上线后在真实的 `taskboard-egress` 网络上检查：`docker exec <app> node -e "fetch('https://web.push.apple.com',{redirect:'manual'}).then(r=>console.log(r.status))"` 能拿到 HTTP 状态码。`docker inspect` 确认 app 同时连着 `taskboard-private` 和 `taskboard-egress` 两个网络。

## 验证

1. `cd api && npm run check && npm run test:push`；`cd web && npm run build`。
2. `api/test/push.test.ts`（`node:test`）：
   - `encryptWith` 用 **RFC 8291 附录 A** 的固定向量，输出逐字节一致
   - `encrypt` → 用测试 UA 私钥解密，round-trip 能还原
   - `vapidAuth` 用固定 key 和时间：公钥 verify 通过，`aud` 是 endpoint 的 origin，`exp - now` 为 12h
   - `isPushEndpoint` 正例：`web.push.apple.com`、`fcm.googleapis.com`
   - `isPushEndpoint` 反例：`fcm.googleapis.com.evil.com`、`evilfcm.googleapis.com`、`https://fcm.googleapis.com@evil.com/`、`http:`、`:8443`、IP、`file:`
   - `parseSubscription`：长度错、首字节不是 `0x04`、点不在曲线上，都抛 400
   - `dailyDigest`（内存 sqlite）：上海 00:00 / 23:59 边界、已完成任务、别人的任务、没有任务、单条 `/?t=<no>`、多条 `/`、超过 4 条
   - `send`（注入 fetch 打桩）：201/200 → ok；404/410 → 删行；401/403/500/抛异常 → error 且不删行
   - `isPushEndpoint` 补：尾点 `web.push.apple.com.`、大写主机名、显式 `:443` 接受
   - `tick`：10:29 不发；10:30 发；同一天两次 tick 只发一次；第二天再发；7 天前的记录被清理（`send` 通过一个注入的 fetch 打桩）
3. `api/test/rules.sh` 补：
   - 未登录访问 `/push/key`、`/push/subscribe`、`/push/test` 返回 401
   - 非白名单 endpoint、错误的 key 返回 400
   - A 订阅后 B 用同一个 endpoint 换一组 keys 订阅：表里只剩 B，keys 也是 B 的
   - 不带 Bearer 也能 `/push/unsubscribe` 删掉一个合法 endpoint；非白名单 endpoint 返回 400；随机的合法但不存在的 endpoint 返回 ok，不影响其他行
4. 本地桌面 Chromium（Playwright，走 FCM）：开启 → 发测试 → 收到通知；`/push/test` 返回 `sent ≥ 1`。
5. **iPhone 真机只能用户来验**（本机没有 iOS 模拟器）：
   - 主屏幕打开 → 开启提醒 → 发测试 → 锁屏能看到通知
   - 点击通知：冷启动和热启动都能打开 App
   - A 离线退出 → B 登录并开启 → 重启 App，B 仍能收到
   - 在线退出后不再收到；离线退出 → 重连后打开 App，之后不再收到
   - 第二天 10:30 收到真实推送

## 风险

- iOS：在系统设置里关掉通知或删掉主屏幕图标 → 订阅失效，Apple 返回 410，服务端自动清理；App 内显示 denied 或 off。
- 密钥变了（恢复旧备份）→ 推送服务大概率对旧订阅返回 401/403。`send` 只记日志、不删行（防止 VAPID 实现有 bug 时把全部订阅清空），旧行要等设备下次打开 App、`syncPush` 用新 keys upsert 覆盖后才失效。排查时看日志里的 401/403，不要按 410 去找。
- 方案 A 让 app 能出网，靠 `isPushEndpoint` 双重校验约束发送目标。代码 review 时重点看 SSRF 校验。
- 评审意见中未采纳的：
  - 把前端日期逻辑统一到上海时区：见「时区口径」的天花板说明
  - 单独做 `/push/status` 接口：改成每次启动无条件 upsert，效果相同，少一个接口

## 追加（2026-11-17）：铃铛面板定时关闭、去掉测试按钮

用户真机验收：iPhone 能收到通知，「发一条测试」也走通了。反馈的问题：「已开启」浮窗点开后一直不关。

改动只涉及 `web/src/components/Board.vue`，必要时加几行 `web/src/style.css`：
1. **定时关闭**：面板打开、状态是 `on` 时，3 秒后自动关闭；刚开启成功、状态变成 `on` 时也一样。`off`（有「开启」按钮）、`unsupported`、`denied`（要读说明文字）这三种状态不定时关闭，免得用户还没看完或还没点按钮，面板就没了。
2. **点外面关闭**：面板打开时，在面板和铃铛以外的任何地方按下手指或鼠标，面板就关闭，四种状态都一样。这是弹出层的常规行为。
3. **去掉「发一条测试」按钮**：真机已经验证通过，这个按钮不再常驻。改成开启成功后自动调一次 `POST /push/test`，开启的那台设备马上收到一条推送，当作确认。服务端的 `/push/test` 保留，排查问题时可以用 curl 或 skill 调；rules 测试不变。

验证：`web npm run build`；用 Chromium 在 375px 宽度下检查：on 状态 3 秒后关闭、点面板外关闭、off 状态不自动关闭。之后按原流程执行 `deploy/deploy.sh` 部署。
