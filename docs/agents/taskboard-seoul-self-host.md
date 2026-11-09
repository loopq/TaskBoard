# taskboard 改为腾讯云首尔自托管

> 状态：部署完成，用户已确认密码设置完成；待用户验收真实登录与 iPhone（2026-11-09）
> 依据：用户 2026-11-09 指示「调整策略，放到腾讯云 KR 服务器」；参照 AccountRelation `origin/feat/self-hosted-web`（9749fc8）已上线的自托管模式；服务器状态为 2026-11-09 SSH 只读实测。
> 取代 [设计方案](private-task-board-design.md) 的 §2 架构、§6 中 R2/CORS 部分、§8 部署；§1 目标、§3 认证语义、§4 数据结构、§5 规则、§7 前端全部不变。

## 1. 变与不变

| 项目 | 原方案 | 新方案 |
|---|---|---|
| 前端 | GitHub Pages（task.loopq.cn → CNAME） | 同一 Node 进程托管 `web/dist` |
| API | `*.workers.dev`，跨域 + CORS | 同域名 `https://task.loopq.cn/api/*`，**删除 CORS 和 `VITE_API_BASE`** |
| 数据库 | D1 | SQLite 文件（Node 24 内置 `node:sqlite`，零依赖） |
| 图片 | R2 | 本地目录 `/var/lib/taskboard/files/` |
| 密钥 | wrangler secret | 服务器 `/etc/taskboard/secrets.env`（root 0600） |
| 发布 | GitHub Actions + `wrangler deploy` | 本机 `deploy/deploy.sh` 经管理员 SSH 发布，与 AccountRelation 同一套路；一次性的服务器准备放在 `deploy/setup.sh` |
| 入口 | 阿里云 CNAME → loopq.github.io | 阿里云 A 记录 → 首尔服务器；共享 Caddy 按域名路由 |

顺带解决原方案的已知天花板：workers.dev 在国内常被 DNS 污染。

**不变**：两个用户、localStorage 保存 token、5 次失败锁 10 分钟、所有 SQL 按 owner 过滤、越权 404、列和任务规则、评论/动态、上传返回 `/files/...` 相对路径、前端全部 UI。

## 2. 代码改动（最小 diff）

**api/**：所有业务 handler（`columns.ts`、`tasks.ts`）不动。

1. 新增 `src/sqlite.ts`：在 `node:sqlite` 上实现与 D1 同形的 `prepare().bind().first/all/run` 和 `batch`（事务）。这是数据层唯一的改动，127 项规则测试的语义保持不变。
2. `files.ts`：R2 换成文件系统。写入先写临时文件再 rename；读取用流；key 校验不变。
3. `auth.ts`：`crypto.subtle.timingSafeEqual` 是 Cloudflare 专有 API，换成 `node:crypto` 的 `timingSafeEqual`。密码未配置时返回 503「未配置」，不返回 500。
4. `index.ts`：删除 CORS；路由统一挂到 `/api` 前缀下；新增 `GET /health`。
5. 新增 `src/server.ts`：负责 `node:http` 与 fetch 风格 handler 之间的适配（约 30 行），请求体硬上限 6MB，按白名单托管 dist 静态文件，设置安全头（CSP/nosniff/HSTS 由 Caddy 加），处理优雅退出。启动时执行幂等的 `schema.sql`，并设置 `foreign_keys/WAL/busy_timeout/synchronous=FULL`。
6. 新增 `src/backup.ts`：用 `node:sqlite` 的在线 `backup()` 生成一致性副本，再做 `integrity_check`。
7. 直接用 Node 24 的原生类型擦除运行 `.ts`，不需要构建步骤，也不引入 tsx。import 补上 `.ts` 后缀；`HttpError` 的参数属性改成普通字段（这种写法无法被擦除）。删除 `wrangler`、`worker-configuration.d.ts`；`tsc --noEmit` 继续保留，开发依赖加 `@types/node`。**运行时依赖为 0。**
8. `test/rules.sh` 改成启动 `node src/server.ts`，使用临时数据目录，路径加 `/api` 前缀，用 `sqlite3` CLI 替代 `wrangler d1 execute`。CORS 段落换成三项检查：静态托管与安全头、超过 6MB 返回 413、`/health`。

**web/**：`API_BASE` 固定为 `'/api'`；删除 `.env.development` 和构建守卫，Vite 代理改指本地 Node 服务；删除 `public/CNAME` 和 `.github/workflows/pages.yml`；网络错误提示里去掉 workers.dev 字样。

## 3. 部署（复用 AccountRelation 的模式和服务器约定）

- **镜像**：`node:24-bookworm-slim@sha256:01d566e8…`。服务器已有这个镜像，不需要再下载。前端在本机构建，dist 随源码包上传，服务器上不跑 npm。运行时只 COPY `api/src`、`api/schema.sql`、`web/dist`。容器以非 root（1000）、只读根文件系统、`cap_drop ALL`、`no-new-privileges` 运行，限制内存 256m，带 healthcheck，日志限制 10m×3。
- **路径**：`/etc/taskboard/`（compose、release.env、secrets.env，均 root 0600）；`/opt/taskboard/releases/<id>/`（经校验的源码包）；`/var/lib/taskboard/`（`taskboard.db` 和 `files/`，uid 1000，0700）；`/opt/backups/taskboard/`。
- **网络**：新建内部网络 `taskboard-private`，容器别名 `taskboard-app`，不映射任何宿主机端口。
- **共享 Caddy**（只做追加）：先备份 Caddyfile 和 compose，再追加下面的站点。proxy compose 里持久化新网络，同时用 `docker network connect` 在线接入（Caddy 不重启），然后 `caddy validate` → `caddy reload` 平滑生效。改完复核 account/agy 两个站点不受影响。

  ```
  task.loopq.cn {
      encode zstd gzip
      header Strict-Transport-Security "max-age=31536000"
      request_body { max_size 6MB }
      reverse_proxy taskboard-app:3000
  }
  ```
- **密钥**：首次部署时在服务器上生成 `TOKEN_SECRET`（`openssl rand`），它不离开服务器。两个登录密码由你在自己的终端执行 `ssh -t tencent-seoul-admin sudo /usr/local/libexec/taskboard-set-password zhuhu`，用 `read -s` 输入两次，写入 secrets.env 并重建容器。密码不经过我。
- **发布脚本**：流程照搬 AccountRelation：白名单打包 → manifest 和 sha256 → 管理员通道上传 → 校验 → `docker build` → 发布前一致性备份 → `compose up --wait` → 失败回切上一版 → 写入版本标记。SSH 加重试（本机走 Clash TUN，实测会间歇性断开）。
- **备份**（用户确认不做异地备份）：`/usr/local/libexec/taskboard-backup` 只备份数据库，用在线 SQLite 一致性副本，存到 `/opt/backups/taskboard/`。每天 03:30 跑一次（和 AccountRelation 的 03:00 错开），保留 14 份；每次发布前再备份一份，保留 10 份。图片不备份：应用从不删除图片，同一块盘上复制一份也防不了丢盘。
- **DNS**：在阿里云新增 A 记录 `task` → 服务器 IP，TTL 600，由你操作。UFW 和云防火墙不用改，80/443 已经开放。

## 4. 验收

- **本机**：`tsc` 类型检查；`rules.sh` 全量规则加越权测试；web 构建；Playwright 端到端测试改为直接访问本地 Node 服务（与生产一样同源托管 dist），覆盖上传、XSS、Service Worker、CSP 下零控制台错误。
- **服务器（切流前）**：用同一个镜像起一个隔离容器（临时数据目录 + 测试密钥），在服务器上跑一遍 `rules.sh`，然后再启动生产容器。
- **服务器（上线后）**：health 检查；检查非 root、只读、无宿主端口；未知 Host 返回 404、account/agy 仍然正常；TLS 证书有效；`docker restart` 后数据还在；备份恢复到临时库后通过 `integrity_check`。生产库不写任何测试数据，真实登录由你验收。
- iPhone 真机：添加到主屏、长按拖拽、从相册上传。

## 5. 回滚与边界

- 对 Caddy 的改动都是追加；出问题时恢复备份的 Caddyfile/compose 再 reload。应用启动失败时 compose 回切上一版镜像。任何情况下都不删 volume。
- 不触碰 account-relation、agy 的容器、数据和配置，唯一的例外是上面对共享代理的追加。不重启整机。
- 实施阶段不 commit、不 push；2026-11-09 收尾时用户另行明确授权 stage/commit，本次仍不 push。
- **已知风险**：从国内直连首尔的 .cn 域名，account.loopq.cn 出现过间歇性 TLS 失败；本机靠给 Clash 加 `DOMAIN,…,TW` 规则解决。task.loopq.cn 大概率也需要同样处理，iPhone 不开代理可能不稳定。

## 6. 决定记录

1. 前端放服务器，和 API 同域名（2026-11-09 用户选定）。
2. 不做异地备份，只保留服务器本地的数据库备份（2026-11-09 用户：「task 只是临时性的」）。
3. 阿里云 DNS 由用户添加 A 记录 `task`，值与 `account` 记录相同；如果之前按旧方案加过 `task` 的 CNAME，要先删掉。

## 7. 执行与验收记录（2026-11-09）

- 已完整核对交接清单、批准方案与 AccountRelation 参照实现；服务器三个既有容器正常，尚无 taskboard 发布。SSH 曾断线一次，重试恢复。
- 本机 Node 24.22.2：API 类型检查通过；rules.sh **132/132**；Vue 类型检查及 Vite 生产构建通过。
- 独立 Chromium 对 Node 同源托管的生产构建完成端到端验证：登录、新建列/任务、跨列拖拽、禁止拖进/拖出已完成、完成/取消完成、原生剪贴板图片上传与预览、script 过滤、子任务、评论、刷新保持登录、退出、双账号隔离；Service Worker activated；严格 CSP 下控制台 **0 错误**。测试只使用临时数据与测试凭据，未读取生产密码。Browser 连接工具内部报错后使用独立测试 Chromium。
- 新增 Dockerfile、白名单 Docker context/发布打包、Compose、带 SSH 重试的发布脚本、隔离镜像规则测试、失败回滚、数据库备份、交互式密码工具、systemd 备份 timer、分阶段代理初始化。镜像不运行 npm；固定 Node 镜像 digest；生产无宿主端口。
- Shell/Python 语法检查通过；打包检查通过（34 个白名单文件，逐项 SHA-256，重复打包字节一致，不含密钥、依赖目录或文档）。仓库尚无首次提交，manifest git_base 记 null，release 仍由内容 hash 唯一确定。旧 Wrangler 本地状态已移至废纸篓，忽略规则已清理。
- 代理初始化使用 `--prepare` 安装工具；只有用户确认阿里云 A 记录生效后才调用 `--activate-dns-confirmed`。激活前服务器再次核对 task/account IPv4；共享文件先备份、只追加站点与网络；原地写入保留 Caddy bind mount inode；validate 后 reload。
- 服务器构建与隔离测试修正两处部署问题：容器启动阶段先等 Docker healthcheck，避免瞬时连接重置；解包目录统一可遍历且 Docker COPY 显式指定 1000:1000，避免 root umask/旧构建缓存留下不可访问的 assets 目录。这些失败均在隔离门禁内拦截。
- **首次生产发布：`7a047e8429b5b313f92f`**；镜像 `sha256:d412c0e484e0a57062a5083934c30fcbbe995af4a628e51da23aa6ca9f9c772f`，linux/amd64、Node 24.22.2。服务器逐项校验 manifest 后构建，隔离容器 rules.sh **132/132** 通过，再启动 `taskboard-app-1`，healthcheck healthy。
- 生产配置验收：uid/gid 1000:1000、read_only=true、cap_drop ALL、no-new-privileges、内存 268435456、pids=100、internal taskboard-private、无宿主端口映射。配置目录 root 0700、三个配置文件 root 0600、数据目录 1000:1000 0700、两个 libexec root 0700。未读取或回显生产 secrets.env 内容。
- 生产 health 返回 200；只重启 taskboard 容器，重启前后库结构与所有表记录数一致。生产库 columns/tasks/subtasks/comments/login_fail 均为 0，未写测试数据。额外用无网络隔离容器验证非空任务、子任务及文件跨重启保留，非空数据库在线备份恢复后内容一致、integrity_check=ok、foreign_key_check 无错误。
- 已安装运维工具和 systemd service/timer，timer active；服务器时区 Asia/Shanghai，每天 03:30（首次计划 2026-11-10 03:30 CST）。手动 daily 备份成功，临时恢复副本完整性与外键检查通过；备份文件 root 0600。daily 保留 14 份、predeploy 保留 10 份的策略已实现。
- 密码工具在独立容器、临时测试凭据与伪 Docker 命令下验证：无 TTY 拒绝、过短/不匹配/单引号拒绝、不回显输入、空格/美元符号/井号/双引号/反斜杠原样保留、仅更新指定账号、0600、临时密钥文件清理、重建失败恢复旧密钥。没有设置生产密码。
- `account.loopq.cn` 与 `agy.loopq.cn` 均经服务器本机 HTTPS 验证 HTTP 200（正常证书校验）；未知 Host HTTP 404。三个原有容器保持原启动时间，未重启或改动其数据。共享 Caddyfile/compose/network 尚未修改或 reload。
- 本阶段曾停在用户确认 DNS 的门禁；用户已添加记录并授权继续，后续结果见 §8。
- 本阶段未 commit、未 push；生产密码未经过 agent，未重启整机；Caddy 在 §8 才执行 reload。

## 8. DNS 激活与最终验收（2026-11-09）

- 用户确认阿里云记录已填入并授权继续。服务器递归解析及公共解析器 1.1.1.1 均返回 `task.loopq.cn A 119.28.157.228`，与 account 相同；未返回 task CNAME/AAAA。
- 执行 `bash deploy/setup.sh --activate-dns-confirmed` 成功：备份共享 Caddyfile/compose（备份后缀 `taskboard-20261109T050615Z-493482.bak`），仅追加 task 站点和 taskboard-private 网络；在线连接共享 Caddy 后先 validate（Valid configuration），再 reload。未运行共享代理 compose up、未重启共享代理。
- 对比备份验证：当前 Caddyfile 完整保留原内容，仅末尾新增一个 task 站点；共享 compose 仅在 caddy networks 增加 taskboard，并追加 external 网络定义。原有 account/agy 站点块未改变。
- **公网 HTTPS 验收通过**：本机实际访问 `https://task.loopq.cn/api/health` 返回 HTTP/2 200 与 `{"ok":true}`；服务器通过公网域名请求也通过。首页 HTTP/2 200；HTTP 308 跳转 HTTPS；HSTS、严格 CSP、nosniff、DENY、no-referrer 等响应头符合方案。
- 证书正常校验，无跳过 TLS 验证：CN/SAN 均为 task.loopq.cn；颁发者 Let's Encrypt YE1；有效期 2026-11-09 04:07:54 UTC 至 2027-02-07 04:07:53 UTC，由 Caddy 自动续期。
- 既有站点 HTTPS 均为 HTTP 200；未知 Host HTTP 404。三个既有容器 StartedAt 与激活前完全一致：共享 Caddy 2026-11-08T07:08:08.413212374Z、account 2026-11-08T07:33:00.266243381Z、agy 2026-11-08T09:29:27.550615931Z。未改其数据、未重启整机。
- 最终状态：生产 release 仍为 `7a047e8429b5b313f92f`，taskboard healthy、uid/gid 1000:1000、只读根文件系统、无宿主端口；taskboard-private 为 internal，成员只有 taskboard 与共享 Caddy。备份 timer active；隔离测试容器均已清理。未 commit/push。
- **用户自行操作（密码不经过 agent）**：在自己的终端依次执行下列命令，每次输入两遍密码（至少 6 位、不含单引号/换行），工具会重建并等待 taskboard 健康。随后访问 https://task.loopq.cn 验证两个账号；iPhone 验收添加主屏、长按拖拽、相册上传。上述真实账号与真机操作未由 agent 代验。

  ```bash
  ssh -t tencent-seoul-admin sudo /usr/local/libexec/taskboard-set-password zhuhu
  ssh -t tencent-seoul-admin sudo /usr/local/libexec/taskboard-set-password lvcui
  ```

## 9. 密码最短长度调整（2026-11-09，用户已批准）

- 目标：用户要求密码至少 6 位。最小长度仅在 `taskboard-set-password` 校验，API 没有最小长度限制。
- 实施：将工具的长度校验、输入提示和错误提示从 8 改为 6，同步交接与使用说明；沿用原有隐藏输入、重复确认、字符限制及失败回滚。
- 验证与发布：检查脚本语法，复用隔离 TTY 验证覆盖 5 位拒绝和 6 位接受；使用现有发布流程更新版本与运维工具，复核健康检查。全程不读取或修改生产密码，不 commit/push。
- 执行结果：已完成。脚本语法检查通过；隔离 TTY 实测 **5 位拒绝、6 位接受**，隐藏输入、二次确认、字符限制、原子写入和失败回滚均通过。
- **当前生产 release：`83ed8b56bad1917f4f6b`**。本机类型检查/构建及本机、服务器两轮 rules.sh 均 **132/132**；发布前备份成功。相对首次发布唯一代码变化为密码工具；通过 `setup.sh --prepare` 安装新版，服务器工具 SHA-256 与本地一致（`ecf4720e85dde5e18c058000cf2116dfcf8194aa0b9e0a7b46490fdfc9c90506`），权限 root 0700。
- 公网 health 仍为 `{"ok":true}`，三个既有容器启动时间不变；本次未 reload Caddy。未读取或修改生产密码、未 commit/push。用户继续使用 §8 的相同命令，现已允许至少 6 位。

## 10. 密码设置后复核（2026-11-09）

- 用户已确认自行完成密码设置，密码未经过 agent。
- 设置后复核通过：公网 `/api/health` 返回 `{"ok":true}`，生产容器 running=true、health=healthy，备份 timer active。
- 部署及技术验收完成；真实账号登录、iPhone 添加主屏/长按拖拽/相册上传仍由用户验收，尚未收到通过反馈。

## 11. 本地提交与服务器记录归档（2026-11-09）

- 用户追加授权 stage/commit，并要求在 `tencent-ubuntu` 仓库留存本次部署事实；此授权取代本次收尾前的“不 commit”限制，不授权 push。
- taskboard 仓库此前没有首次提交；本次归档应用源码、依赖锁文件、部署脚本和方案/交接记录。密钥、本地数据库、依赖目录、前端构建及发布压缩包由忽略规则排除。
- 已在 `tencent-ubuntu/docs/agents/taskboard-seoul-deployment.md` 留存组件、当前 release/镜像、服务器目录与权限、Caddy 追加与备份、备份/密码运维、验证结果和待用户验收项；服务器初始配置总记录已加入索引。该仓库沿用脱敏约定，不记录真实服务器 IP、个人机器绝对路径或凭据。
- 归档前再次只读复核：当前 release `83ed8b56bad1917f4f6b`，公网 health 正常，容器 healthy/非 root/只读/无宿主端口，备份 timer active。此次归档不修改服务器配置或生产数据。
