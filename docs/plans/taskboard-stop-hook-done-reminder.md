# 任务完成后自动回填看板（全局 Stop hook）

> 2026-11-19 · 状态：已批准（触发时机选「push / 部署后问一次」）
> 任务：[#27 task 总是忘记更新总结进度，用 hook 的形式？](https://task.loopq.cn/?t=27)

## 问题

用户贴任务链接让 Claude 干活，活干完了（已 push / 部署），看板却没回填。扫描 Claude 本机会话记录（用户消息里带 `task.loopq.cn/?t=N` 的会话）：

| 任务 | 会话里做了什么 | 看板 |
|---|---|---|
| #26 Email Claude 情况 | 部署 + push | 没回填，下一个会话才补 |
| #10 AccountRelation 需求 | 部署 + push | 关了，但没有总结评论 |
| #24 logcat 搜索 | 改本地工具，无 push | 只写了评论，7 小时后才关 |

已回填的那些（#14/15/17/18/25）都靠 Claude 当时碰巧记得，没有任何机制保证。#26 那次 taskboard skill 根本没被加载（用户贴的是链接 + `/grill-me`），skill 里写再多规则也看不到。

## 核心判断：「任务结束」怎么判定

机械规则判断不了「完成」：push 了可能还要第二轮，没 push 也可能已经做完。拆成三件事，各交给最合适的一方：

| 问题 | 谁来判断 | 依据 |
|---|---|---|
| 什么时候该问一下 | hook（确定性） | 会话绑定了任务，且自上次提醒后出现了新的 `git push` 或 `deploy.sh` |
| 任务完成没有 | Claude（判断） | 需求点是否都已落地并上线 / 合入 |
| 已经回填了没有 | 服务端（事实） | `tb show N --json` 的 `task.done_at` |

效果：平时零打扰；每次 push / 部署后的那一轮结束时最多问一次；Claude 判断没完成就什么都不写（满足「只在完成时才更新」）；已经 done 的任务永不再问。

### 为什么这样选

- **Stop 而不是 PostToolUse**：用户的流程是「部署 → 验收 → commit & push」一口气跑完。PostToolUse 在部署那一刻就会提醒，这时 push 还没做；Stop 在整轮结束时才看，一轮里有几次 push 都只问一次。
- **全局 `~/.claude/settings.json` 而不是 skill frontmatter 里的 hook**：skill 级 hook 只在 skill 被加载时生效，#26 的会话恰好没加载 taskboard skill。
- **已回填与否问服务端，不解析命令**：历史会话里回填命令有 `tb.mjs comment`、`$TB comment`、`tb comment` 三种写法，用户也可能在网页上手动关。`done_at` 是唯一可信的事实。
- **不做 Codex 端**：会话扫描里绑定任务链接的都是 Claude 会话，Codex 没有。需要时再加。

## 改动

### 1. 新增 `skills/taskboard/scripts/stop-hook.mjs`（零依赖，约 80 行）

输入：Stop hook 的 stdin JSON（`session_id`、`transcript_path`、`stop_hook_active`）。

1. `stop_hook_active` 为真 → 退出（防循环）。
2. 读 transcript；全文不含 `task.loopq.cn/?t=` → 立即退出（绝大多数会话走这里，只花一次读文件）。
3. 按行解析：
   - **绑定**：用户消息（字符串或 `text` 块，不含 `tool_result`）里出现的 `task.loopq.cn/?t=N`，收集成集合。
   - **信号**：绑定之后，Bash `tool_use` 命令匹配 `git push`（排除 `--dry-run`）或 `deploy.sh`，且对应 `tool_result.is_error !== true`，计数。
4. 读状态文件 `~/.cache/taskboard/stop-hook/<session_id>.json` 的 `{signals}`；当前信号数 ≤ 已记录 → 退出。
5. 对每个绑定任务跑 `node tb.mjs show N --json`（复用现有 CLI，超时 8 秒），过滤掉 `done_at` 非空的、查不到的。
6. 写回状态文件（先写再输出，保证同一批信号只问一次）。
7. 还有未完成的任务 → 输出 `{"decision":"block","reason":…}`，否则静默退出。

reason 文案：

```text
[taskboard] 本会话绑定了 #27（https://task.loopq.cn/?t=27），刚执行过 git push / 部署。判断这个任务是否已经完成：
- 已完成（需求点都已落地并上线 / 合入；只差用户本人才能做的验收也算完成）→ 按 taskboard skill「完成回填」的格式，先 comment 写总结，再 done，回报链接。
- 还没完成 → 不写看板，直接结束，不用提这条提示。
每次新的 push / 部署之后只提醒一次。
```

**失败策略**：任何异常（transcript 读不了、JSON 坏行、网络失败、未登录）一律静默放行，绝不卡住会话。坏行跳过不影响其他行。

### 2. `skills/taskboard/SKILL.md` 新增「完成回填」一节

这条规则和 hook 共用同一个格式：

- 从任务链接开始的工作，做完后由 agent 主动回填，不等用户提醒；hook 只是兜底。
- 什么算完成：需求点都已落地并上线 / 合入；只差用户本人才能做的验收（真机、付款等）也算完成，写进遗留。只做了一部分、或还在等用户拍板，不算完成。
- 只在完成时写一次：先 `comment` 写总结，再 `done`。不主动写进度评论（用户要求时除外）。
- 总结格式（参照 #25 / #26）：首行「已完成并发布上线（适用范围）：」，接 2–4 条用户视角的改动、`Commit` / `Release`、`遗留`（没有就省略）。

### 3. `~/.claude/settings.json` 的 `Stop` 数组追加一项

```json
{ "hooks": [{ "type": "command", "command": "node \"$HOME/.agents/skills/taskboard/scripts/stop-hook.mjs\"", "timeout": 15 }] }
```

现有的 review-loop 和 luan 两个 Stop hook 不动。

## 已知天花板

- 没有 push / 部署的任务（#20 调研、#24 改本地工具）不会触发提醒，只能靠 SKILL.md 的规则。升级路径：把 `git commit` 也算作信号。
- 信号只认 Claude 自己执行的命令。用户用 `! git push` 自己推送不会触发。
- 不校验 push 是否真的成功：`git push … | tail` 的退出码是 `tail` 的。误判的代价只是多一轮判断，Claude 会判定「未完成」后结束。
- 只认用户消息里的链接。只说「#26」不贴链接的会话不绑定。

## 验证

用 `/tmp` 下手写的 transcript 样例直接跑脚本，对服务端只读：

| 用例 | 期望 |
|---|---|
| 没有任务链接 | 静默 |
| 有链接，没有 push / 部署 | 静默 |
| 有链接 + push，任务 #27 未完成 | 输出 block JSON，reason 含 #27 |
| 同一输入再跑一次 | 静默（状态文件已记录） |
| 再加一次 push | 再次 block |
| `stop_hook_active: true` | 静默 |
| 绑定的是已完成的 #26 | 静默 |
| push 的 `tool_result.is_error: true` | 静默 |
| `tb` 不可用（指向不存在的脚本） | 静默，退出码 0 |
| 真实大 transcript（19 MB）不含链接 | 静默，记录耗时 |

再用 `jq` 校验 `settings.json` 合法，并确认三个 Stop hook 都在。不提交、不推送。

## 验证结果（2026-11-19）

- 上表 10 个用例，加上补充的 4 个（`git -C` 计入、`--dry-run` 不计、push 在贴链接之前不计、stdin 坏输入），共 14 个全部通过。`isMeta` 的 skill 正文里的示例链接 `?t=12` 不会绑定。
- 耗时：不需要查服务端时 60–160ms，19 MB 的真实 transcript 用 163ms；需要提醒时多一次 `tb show`，约 1 秒。
- `~/.claude/settings.json` 的 Stop 数组现有 3 项，`jq` 校验通过。用注册的那条命令原样跑（只带 `HOME` / `PATH`），block JSON 输出正确；空输入时退出码为 0。
- 测试用的状态文件已删除。真实触发要在当前会话结束这一轮时才能看到：本会话绑定了 #27，测试命令里的 `git push` 字样会被当成信号，正好验证一次。
