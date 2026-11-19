# taskboard-web-push 执行评审记录

- Plan：[taskboard-web-push.md](../taskboard-web-push.md)（三轮 Codex plan review，Round 3 8/10 无 blocker）
- 实施：Codex profile `cxd-ds2`，session `01a1e7c2-49e7-7cd3-bfe4-fb7d8dd67b96`；Claude 审查与验收
- 起点：`752d32d`，未 commit

## Round 1 审查发现

| 严重度 | 位置 | 问题 | 处置 |
|---|---|---|---|
| Medium | `api/test/rules.sh:101` | 「同一 endpoint 换账号」用例第二次订阅仍用 zhuhu 的 token（`TOK=$A`），断言 owner=lvcui 必然失败；Codex 沙箱不能 listen，没跑到 | Claude 修：传 `"$BT"` |

其余按 plan 逐项核对：schema 三表、`push.ts` 签名与校验（白名单按 hostname、redirect:error、p256dh importKey、401/403 不删行、日志只打 host）、路由鉴权（unsubscribe 公开）、调度器 `PUSH_SCHEDULER=0`、sw.js push 兜底 + notificationclick、前端 syncPush/pending/logout 清理、铃铛面板、compose egress、门禁接入，均符合。未发回 Codex。

## 验证（Claude 亲自跑）

- `api npm run check` 通过；`npm run test:push` 10/10（含 RFC 8291 附录 A 逐字节）；`npm run test:rules` 166/166；`web npm run build` 通过
- Chromium 375px：顶栏不溢出，铃铛面板正常，控制台 0 错误
- 发布：`deploy/deploy.sh`（PATH 前置 `/tmp/node24`，v24.22.2）→ 服务器隔离镜像 165/165，备份 `predeploy-20261117T045431Z-2002269.db`（4 列 19 任务），release **`c2215f3b0531f1b69663`**，`taskboard-app-1` healthy
- 线上：容器连 `taskboard-egress` + `taskboard-private`（仍 internal）；容器内 fetch `web.push.apple.com` → 405、`fcm.googleapis.com` → 404（出网通）；`/api/push/key` 未登录 401；线上 sw.js 含 notificationclick

## 遗留

- iPhone 真机：添加主屏幕 → 开启 → 测试推送 → 锁屏 / 点击跳转 → 次日 10:30，只能用户验
- 面板点外部不自动关闭（再点铃铛关闭），可后续优化

## 追加（2026-11-17）：铃铛面板

- 用户 iPhone 真机验收通过（通知 + 测试推送）
- 改动（Claude 直接实施，plan 见「追加」一节）：on 状态 3 秒自动关闭、点外部关闭；去掉测试按钮，开启成功后自动 `/push/test` + toast；关闭 toast
- 顺带修复：启动同步遇到「已授权但无订阅」会强制重新订阅，导致「关闭」重启后失效 → 非 force 同步只在本机已有订阅时进行，订阅即「已开启」的记忆
- 验证：web build；Chromium 375px 打桩 e2e 7 项全过、控制台 0 错误；发布 release **`3bac346a966ee0107078`**，隔离镜像 165/165，备份 `predeploy-20261117T083320Z-2112208.db`，线上 asset hash 与本地构建一致
