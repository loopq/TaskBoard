---
name: taskboard
description: |
  私人看板 task.loopq.cn 的增删改查：看板总览、任务详情、新建 / 编辑 / 改分组（移列）/ 完成 / 取消完成 / 删除、子任务、评论、列（分组）管理。
  Use when user mentions taskboard、task.loopq.cn、私人看板、我的看板、看板任务、私人 todo，或给出 #12 这类任务编号、task.loopq.cn/?t= 链接。
  Do NOT use for Wednesday（用 wed）、飞书任务（用 lark-task）。
---

# taskboard

脚本零依赖（Node 18+）。下文 `tb` = `node ~/.agents/skills/taskboard/scripts/tb.mjs`。

## 登录

凭据在 `~/.config/taskboard/credentials.json`，一年有效。没登录或报「登录已失效」时，**让用户自己在终端运行**：

```bash
node ~/.agents/skills/taskboard/scripts/tb.mjs login zhuhu   # 或 lvcui
```

密码只能由用户在自己的终端输入：不要问用户要密码，不要替用户跑 login，也不要从任何地方读密码。脚本没有 TTY 时会直接拒绝。

## 命令

```bash
tb board [--all]                      # 先看这个：列 + 任务（#编号），默认不列已完成
tb show <任务>                        # 描述、子任务（带序号）、动态
tb add "<标题>" [--col 列] [--desc md] [--due 日期] [--priority 级别]   # 不给 --col 就进「待处理」
tb edit <任务> [--title 新标题] [--desc md] [--due 日期|none] [--priority 级别]
tb move <任务> <列>                    # 改分组 / 状态：排到目标列末尾
tb done <任务> | tb undo <任务>       # 完成 / 取消完成（回到原列，原列删了回「待处理」）
tb rm <任务> --yes                    # 删除，连同子任务和评论
tb comment <任务> ["<Markdown>"] [--image 图片路径]   # 图片上传后以 ![](...) 接在文字后面；只发图可省略文字
tb image <图片地址> [--out 路径]     # 下载任务里的图片（show 里的 /files/...）到本地，打印保存路径
tb sub <任务> add "<标题>" | done <序号> | undo <序号> | rm <序号>
tb col add "<名>" | rename <列> "<新名>" | rm <列> --yes | move <列> <位置>
tb whoami
```

- `<任务>`：`12`、`#12` 或详情链接 `https://task.loopq.cn/?t=12`。用户说标题关键词时，先 `board` 找到编号再操作。
- `<列>`：列名，例如 `待处理`、`进行中`。「分组」就是列。
- 日期：`YYYY-MM-DD`、`today/今天`、`tomorrow/明天`、`后天`、`none`（清除）。优先级：`0-4` 或 `无/较低/普通/紧急/非常紧急`。
- 任何命令加 `--json` 输出原始数据。

## 规则

- 「待处理」「已完成」是锁定列：不能改名、排序、删除。任务不能 `move` 进「已完成」，要用 `done`；已完成的任务要先 `undo` 才能移走。这些都由服务端判定，报错时把原因原样告诉用户。
- `rm`、`col rm` 先把要删的对象给用户看，用户确认后再加 `--yes`。其他写操作直接执行。
- 写完回报编号和链接（`https://task.loopq.cn/?t=<编号>`），方便用户点开核对。
- 看任务里的图片：图片只有本人登录后能看，curl 直接访问会 401。用 `tb image /files/...` 下载，再用 Read 打开打印出来的本地路径；描述和评论里的截图往往就是需求本身，务必看过再动手。
- 评论带图：用户贴的截图直接把本地路径传给 `--image`（png / jpg / webp / gif，≤5MB，原样上传不压缩）。一条评论一张图，多张图就分多条评论。
- 描述和评论都是 Markdown。`edit --desc` 会**整段替换**描述；要追加内容时，先 `show` 拿到原文，拼好后再写回。
