# taskboard

两人私人看板 https://task.loopq.cn。`api/` 用 Node 24 + `node:sqlite`，运行时零依赖；`web/` 用 Vue 3 + Vite；`skills/taskboard/` 是 CLI skill（已软链到 `~/.agents/skills/taskboard`）。

## 命令

- 本地开发：`cd api && npm run dev`（:8787，先 `cp .dev.vars.example .dev.vars`），然后 `cd web && npm run dev`（`/api` 代理到 :8787）
- 类型检查：`cd api && npm run check`；`cd web && npm run build`（vue-tsc + vite）
- 测试：`cd api && npm run test:push`；`bash api/test/rules.sh`（curl 端到端，自起临时库）
- 发布：`bash deploy/deploy.sh`，必须用 Node 24。上面这些检查都是发布前的门禁，任何一项不过就不能发布

## 代码约定

- api 用 Node 原生类型擦除直接跑 `.ts`：import 要带 `.ts` 后缀，不能用 enum、namespace、构造参数属性（`erasableSyntaxOnly`）
- api 不加运行时依赖，镜像里不跑 npm
- 数据访问统一走 `api/src/sqlite.ts` 的 D1 同形适配（`prepare/bind/first/all/run/batch`，其中 `batch` 是事务）
- CSP 严格（`style-src 'self'`）：遇到拦截就改代码，不要放宽 CSP
- Markdown 渲染必须经过 DOMPurify

## 边界

- 密码和 `secrets.env` 不经过 agent：不索要、不生成、不读取、不回显
- 不往生产库写测试数据；iPhone、主屏 web app 相关的验收交给用户
- 服务器运维以 `~/dev/tools/tencent-ubuntu/CLAUDE.md` 为准；SSH 统一走 `deploy/ssh.sh`，它封装了重试

## 文档

- plan 放 `docs/plans/<事务名>.md`，review 放 `docs/reviews/<plan 名>-review.md`
- 新功能先读 `docs/plans/private-task-board-design.md`（业务规则）
