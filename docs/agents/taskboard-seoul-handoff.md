# taskboard 首尔自托管：交接给下一位执行者

> 2026-11-09 · 已批准的方案：[taskboard-seoul-self-host.md](taskboard-seoul-self-host.md)（先完整读一遍）
> 业务设计：[private-task-board-design.md](private-task-board-design.md)（§2/§8 已被上面的方案取代）
> 参照实现：AccountRelation 已上线的自托管版本，`git -C /Users/loopq/dev/git/loopq/AccountRelation show origin/feat/self-hosted-web:<path>`，重点看 `scripts/deploy.sh`、`scripts/package-release.py`、`scripts/server-backup.sh`、`deploy/compose.yaml`、`Dockerfile`

> **续接更新（2026-11-09，部署完成）**：下方原交接 §2 的技术实施和验收均已完成，详细结果见已批准方案 §7–11。当前生产 release 为 `83ed8b56bad1917f4f6b`，health healthy；密码最短 6 位已更新到服务器并验证，用户已确认自行完成密码设置。设置后公网 health、容器状态与备份 timer 复核通过。备份、恢复、重启持久性、密码工具已验证，agent 未写入生产测试数据。共享 Caddy 已按追加方式备份、validate、reload，https://task.loopq.cn 首页/health 均 200、证书有效、account/agy 正常、原有容器均未重启。**剩余仅用户真实登录/iPhone 验收**；不要读取生产 secrets.env。无需重跑已通过的流程。所有 agent SSH 使用 `deploy/ssh.sh` 的重试封装；用户已授权本次 stage/commit，并将部署清单归档到 tencent-ubuntu 仓库，仍不 push。

## 1. 已完成（本机验证通过，未 commit）

- **api/ 已从 Cloudflare Worker 迁到 Node 24**，运行时依赖为 0：
  - `src/sqlite.ts`：基于 `node:sqlite` 实现 D1 同形适配（prepare/bind/first/all/run/batch=事务）。业务 handler（`columns.ts`、`tasks.ts`）没改。
  - `src/files.ts`：R2 换成文件系统（`$DATA_DIR/files/<uid>/<uuid>.<ext>`）。
  - `src/server.ts`：负责 node:http 与 fetch handler 的适配；请求体上限 6MB；按白名单托管 `WEB_DIST`；统一加安全头，CSP 为 `style-src 'self'` 严格模式；优雅退出。
  - `src/backup.ts`：在线一致性备份，备份后做 integrity_check。
  - `src/index.ts`：所有路由挂在 `/api/*` 下，新增 `/api/health`，删除 CORS。
  - `auth.ts`：改用 `node:crypto.timingSafeEqual`；密码或 TOKEN_SECRET 未配置时返回 503。
  - 直接用原生类型擦除运行 `.ts`（import 带 `.ts` 后缀）；tsconfig 开了 `erasableSyntaxOnly` 和 `verbatimModuleSyntax`；wrangler 已删除。
- **web/**：`API_BASE` 固定为 `'/api'`；Vite 代理 `/api` → `127.0.0.1:8787`；已删除 `VITE_API_BASE`、`.env.development`、`public/CNAME`、`.github/workflows/pages.yml`。
- **验证结果**：
  - `cd api && npx tsc --noEmit` 通过。
  - `bash api/test/rules.sh` 132/132 通过：在 Node 25 下跑过一次，用 `/tmp/node24/node_modules/node/bin`（v24.22.2，与服务器镜像同版本）又跑过一次。
  - `cd web && npm run build` 通过。
- `api/test/rules.sh` 有两种模式。本地模式下自己起服务，存在 `web/dist` 时会顺带验静态托管。外部模式：`BASE=http://127.0.0.1:18080 ENV_FILE=<测试密钥文件> SQL_CONTAINER=<容器名> bash api/test/rules.sh`，供服务器上验证刚构建的镜像。

## 2. 剩余工作（按顺序）

1. **本机浏览器端到端测试（建议做）**：之前 `/tmp/tb-e2e/` 下的脚本已被系统清掉，只剩 `node_modules/playwright-core`。Chromium 在 `~/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`。
   - 起服务：在 `api/` 下执行 `DATA_DIR=$(mktemp -d) WEB_DIST=../web/dist PORT=8790 node --env-file=.dev.vars --disable-warning=ExperimentalWarning src/server.ts`。
   - 要验的流程：登录、新建列和任务、拖拽（拖不进/拖不出「已完成」）、完成与取消完成、粘贴图片上传并预览、`<script>` 被过滤、子任务、评论、退出、两个账号互相隔离、Service Worker 注册成功。
   - **控制台必须零错误**。严格 CSP 如果拦了 inline style，需要定位修复，不要直接放宽 CSP。
2. 清理遗留：删掉 `.gitignore` 里的 `.wrangler/` 行，以及 `api/.wrangler/`（只是旧的本地测试状态）。
3. **新增部署文件**（照搬 AccountRelation 的结构，命名换成 taskboard）：
   - **根目录 `Dockerfile`**：`FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`（服务器已缓存这个镜像）。
     - 环境变量：`ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data WEB_DIST=/app/web/dist NODE_OPTIONS=--disable-warning=ExperimentalWarning`。
     - 只 COPY `api/package.json`（需要其中的 `"type": "module"`）、`api/schema.sql`、`api/src`、`web/dist`；镜像里**不跑 npm**。
     - `USER 1000:1000`；HEALTHCHECK 用 `fetch('http://127.0.0.1:3000/api/health')`；`CMD ["node","api/src/server.ts"]`。
   - **`.dockerignore`**：白名单方式。
   - **`deploy/compose.yaml`**：参照 AccountRelation 的写法。
     - 安全与资源：`read_only`、`cap_drop: [ALL]`、`no-new-privileges`、`mem_limit: 256m`、`pids_limit: 100`、`tmpfs /tmp`、日志 10m×3、`init`、`restart: unless-stopped`。
     - 挂载与环境：`env_file: [/etc/taskboard/secrets.env]`；`volumes: /var/lib/taskboard:/data`。
     - 网络：external `taskboard-private`，别名 `taskboard-app`；**不映射宿主机端口**。
   - **`deploy/package-release.py`**：白名单包括 Dockerfile、.dockerignore、`api/package.json`、`api/schema.sql`、`api/src/**`、`api/test/rules.sh`、`deploy/**`、`web/dist/**`。生成 manifest 的 sha256，用它算出 release id。
   - **`deploy/deploy.sh`**：
     1. 本地门禁：tsc → rules.sh → web build。
     2. 打包 → 经 `ssh tencent-seoul-admin` 上传 → 校验 sha 和 manifest → `docker build -t taskboard:<rel>`。
     3. **隔离测试**：建临时数据目录（属主 1000）和测试密钥文件（随机值），用 `docker run -d --read-only --tmpfs /tmp -p 127.0.0.1:18080:3000` 起镜像，在宿主机上以外部模式跑 rules.sh。通过才继续，测完删掉容器和临时目录。
     4. 发布前备份（生产库存在时）。
     5. 写入 `/etc/taskboard/compose.yaml` 和 `release.env`（root 0600）。
     6. `secrets.env` 不存在时才创建：在服务器上生成 `TOKEN_SECRET='$(openssl rand -base64 48)'`，`PW_ZHUHU=''`、`PW_LVCUI=''` 留空；**任何时候都不能回显其内容**。
     7. `docker network create --internal taskboard-private`（不存在时）；`install -d -m 0700 -o 1000 -g 1000 /var/lib/taskboard`。
     8. `compose up -d --wait --wait-timeout 90`，失败就回切 previous；最后写 current-release。
   - **`deploy/server/taskboard-backup`**：安装到 `/usr/local/libexec/`，root 0700。
     - 用 flock 防重入；执行 `docker compose … exec -T app node api/src/backup.ts /data/taskboard.db /data/.backup-<ts>.db </dev/null`；结果移到 `/opt/backups/taskboard/<daily|predeploy>-<ts>.db`，权限 0600。
     - 保留策略：daily 14 份、predeploy 10 份。
   - **`deploy/server/taskboard-set-password`**：用法 `sudo taskboard-set-password zhuhu|lvcui`。
     - 必须在 tty 下运行；`read -rs` 输入两次；至少 6 位；拒绝包含 `'` 或换行的密码。
     - 原子重写 secrets.env，格式 `KEY='value'`；写完执行 compose `up -d --wait` 重建容器。
     - 密码只能经 shell 内建命令处理，不能出现在任何进程的 argv 里。
   - **systemd**：`taskboard-backup.service`/`.timer`，每天 03:30，`Persistent=true`。
   - **`deploy/setup.sh`**：一次性、幂等。
     1. 安装上面的 libexec 脚本和 systemd unit，enable timer。
     2. 共享 Caddy 改动只能追加：带时间戳备份 `/opt/apps/reverse-proxy/{Caddyfile,compose.yaml}`。
     3. Caddyfile 里还没有 `task.loopq.cn` 时，追加 plan §3 的站点块。
     4. 在 proxy compose 的 networks 里加 external `taskboard-private`，持久化。
     5. `docker network connect taskboard-private shared-proxy-caddy-1`：在线接入，不重启 Caddy。
     6. `docker exec shared-proxy-caddy-1 caddy validate --config /etc/caddy/Caddyfile`，通过后再 `caddy reload --config /etc/caddy/Caddyfile`。
     7. 复核 `account.loopq.cn` 和 `agy.loopq.cn` 仍然正常。
4. **上线顺序**：
   1. 先让用户在阿里云加 A 记录 `task`，值与 `account` 记录相同；若有旧的 `task` CNAME 要先删。确认 DNS 已生效后再 reload Caddy，Caddy 要靠它走 ACME HTTP-01 签证书。
   2. 执行 `deploy.sh`，再执行 `setup.sh`。
   3. 用户在**自己的终端**执行两次 `ssh -t tencent-seoul-admin sudo /usr/local/libexec/taskboard-set-password zhuhu`（第二次把 zhuhu 换成 lvcui）。
5. **线上验收**：
   - `https://task.loopq.cn/api/health` 正常；证书有效。
   - 未知 Host 返回 404；account 和 agy 不受影响；容器以非 root、只读运行；没有宿主机端口映射。
   - `docker restart` 之后数据还在。
   - 手动跑一次备份，恢复到临时库后 integrity_check 为 ok。
   - **生产库不写任何测试数据**。真实登录和 iPhone 测试（添加到主屏、长按拖拽、从相册上传）由用户自己验。
6. 收尾：把执行和验收结果追加到 plan 文档。

## 3. 服务器事实（2026-11-09 实测）

- 系统与基础设施：Ubuntu 24.04.5，2C/3.6G（空闲约 2.9G），磁盘剩 39G；Docker 29 / Compose 5.7。UFW 和云防火墙都已开放 22/80/443，**不用改**。
- 容器：`shared-proxy-caddy-1`（`caddy:2`，共享反代，compose 在 `/opt/apps/reverse-proxy/compose.yaml`，当前网络为 edge 和 account-relation-private）、`account-relation-app-1`、`ag-seoul-manager-1`。
- 已有站点：`account.loopq.cn`、`agy.loopq.cn`。
- 账号与目录：uid 1000 是管理员账号 ubuntu（容器也用 1000）。AccountRelation 的约定是 `/etc/<app>/`（root 配置）、`/opt/<app>/releases/`、`/var/lib/<app>/`、`/opt/backups/<app>/`。
- **SSH**：`tencent-seoul-admin` 可以 sudo；`tencent-seoul` 是 deploy 账号，无权限，不要给它加权限。
  - 必须带参数 `-T -o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o ConnectTimeout=12`。
  - 本机流量走 Clash TUN，会间歇性出现 `Connection closed by … port 22`，脚本里**要加重试**。
- **Mac 没有 Docker CLI**，镜像只能在服务器上构建。

## 4. 硬约束

- 实施阶段不 commit，不 push；用户已追加授权本次收尾 stage/commit，仍不 push。
- 密码不经过 agent：不索要、不生成、不回显 secrets.env。
- 除了对共享 Caddy 的追加改动，不碰 account-relation、agy 的容器、数据和配置；不重启整机。
- 不做异地备份（用户已确认）。
- 用中文汇报；每个阶段说清楚验证结果；用户需要手动操作时停下来，给出逐步清单。
