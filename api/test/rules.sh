#!/usr/bin/env bash
# 用 curl 验证设计文档 §3 认证、§5 列与任务规则、§6 上传与越权场景，以及同域托管与安全头。
# 本地（在 api/ 下）：npm run test:rules —— 用临时数据目录起 node src/server.ts，跑完自动关闭；
#   已构建 web/dist 时一并验证静态托管。
# 外部：BASE=http://127.0.0.1:18080 ENV_FILE=<测试密钥文件> SQL_CONTAINER=<容器名> bash test/rules.sh
#   发布脚本在服务器上用它测试刚构建的镜像（隔离容器 + 临时库），通过后才切换生产。
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${ENV_FILE:-.dev.vars}
[[ -f $ENV_FILE ]] || { echo "缺少 $ENV_FILE（参考 .dev.vars.example）"; exit 1; }
set -a; source "$ENV_FILE"; set +a
TMP=$(mktemp -d)

# 直接查库（模拟锁定过期、核对级联删除）：本地读临时库文件，服务器上进隔离容器查
SQL_JS='const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.TB_DB);console.log(JSON.stringify(d.prepare(process.argv.at(-1)).all()))'
SERVER=
if [[ -z ${BASE:-} ]]; then
  PORT=8799
  BASE="http://127.0.0.1:$PORT"
  DATA="$TMP/data"
  [[ -d ../web/dist ]] && export WEB_DIST=../web/dist
  DATA_DIR=$DATA PORT=$PORT HOST=127.0.0.1 node --disable-warning=ExperimentalWarning src/server.ts >"$TMP/server.log" 2>&1 &
  SERVER=$!
  sql() { TB_DB="$DATA/taskboard.db" node --disable-warning=ExperimentalWarning -e "$SQL_JS" "$1"; }
else
  sql() { docker exec -e TB_DB=/data/taskboard.db "$SQL_CONTAINER" node --disable-warning=ExperimentalWarning -e "$SQL_JS" "$1"; }
fi
trap '[[ -n $SERVER ]] && kill $SERVER 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"' EXIT
curl -s -o /dev/null --retry 60 --retry-connrefused --retry-delay 1 "$BASE/api/health" || { cat "$TMP/server.log" 2>/dev/null; exit 1; }
API="$BASE/api"

PASS=0 FAIL=0 TOK='' S='' B=''

# req 方法 路径 [JSON] [token，缺省用 ${TOK}，传 '' 表示不带] → $S 状态码 / $B 响应体
req() {
  local tok=${4-$TOK} args=(-s -o "$TMP/body" -w '%{http_code}' -X "$1" "$API$2")
  [[ -n $tok ]] && args+=(-H "authorization: Bearer $tok")
  [[ -n ${3-} ]] && args+=(-H 'content-type: application/json' --data "$3")
  S=$(curl "${args[@]}")
  B=$(cat "$TMP/body")
}
# up 内容类型 文件 [token] → 上传图片
up() {
  local tok=${3-$TOK} args=(-s -o "$TMP/body" -w '%{http_code}' -X POST "$API/upload" -H "content-type: $1" --data-binary "@$2")
  [[ -n $tok ]] && args+=(-H "authorization: Bearer $tok")
  S=$(curl "${args[@]}")
  B=$(cat "$TMP/body")
}
ok() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
ng() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n      %s\n' "$1" "$2"; }
# check 描述 期望状态码 [jq 断言]
check() {
  if [[ $S == "$2" ]] && { [[ -z ${3-} ]] || jq -e "$3" <<<"$B" >/dev/null 2>&1; }; then ok "$1"
  else ng "$1" "期望 $2 ${3-}；实际 $S $B"; fi
}
j() { jq -r "$1" <<<"$B"; }
cred() { jq -nc --arg u "$1" --arg p "$2" '{user: $u, password: $p}'; }
b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
# forge 用户 过期时间 → 用 .dev.vars 里的 TOKEN_SECRET 自签 token
forge() {
  local p="$1.$2"
  printf '%s.%s' "$(printf %s "$p" | b64u)" "$(printf %s "$p" | openssl dgst -sha256 -hmac "$TOKEN_SECRET" -binary | b64u)"
}
FAR=9999999999999

echo '== 认证 §3'
req POST /login "$(cred root x)" ''; check '白名单外用户名 → 401' 401
req POST /login "$(cred zhuhu wrong)" ''; check '密码错误 → 401' 401
req POST /login '{bad json' ''; check '非法 JSON → 400' 400
req POST /login "$(cred zhuhu "$PW_ZHUHU")" ''; check 'zhuhu 登录成功' 200 '.user == "zhuhu" and (.token | length > 40)'
A=$(j .token)
req POST /login "$(cred lvcui "$PW_LVCUI")" ''; check 'lvcui 登录成功' 200 '.user == "lvcui"'
BT=$(j .token)
req GET /board '' ''; check '不带 token → 401' 401
req GET /board '' 'garbage'; check '乱写 token → 401' 401
req GET /board '' "$(printf 'lvcui.%s' $FAR | b64u).${A#*.}"; check '篡改 payload（换用户名）→ 401' 401
req GET /board '' "${A%.*}.$(printf x | b64u)"; check '篡改签名 → 401' 401
req GET /board '' "$(forge zhuhu 1000)"; check '过期 token → 401' 401
req GET /board '' "$(forge root $FAR)"; check '白名单外用户即使签名正确 → 401' 401
req GET /board '' "$(forge zhuhu $FAR)"; check '自签合法 token → 200（签名格式与文档一致）' 200
req GET /nope; check '未知接口 → 404' 404

echo '== 列 §5'
TOK=$A
req GET /board; check '首次 /board 建默认三列' 200 \
  '[.columns[].kind] == ["todo","normal","done"] and [.columns[].name] == ["待处理","进行中","已完成"]'
TODO=$(j '.columns[0].id') DOING=$(j '.columns[1].id') DONE=$(j '.columns[2].id')
req GET /board; check '重复访问不重复建列' 200 '.columns | length == 3'
req POST /columns '{"name":"测试列","kind":"done"}'; check '新建列只能是 normal（kind 参数被忽略）' 201 '.kind == "normal"'
COL=$(j .id)
req GET /board; check '新列排在待处理和已完成之间' 200 '[.columns[].name] == ["待处理","进行中","测试列","已完成"]'
req POST /columns '{"name":"   "}'; check '空列名 → 400' 400
req PATCH "/columns/$TODO" '{"name":"x"}'; check '待处理不能改名 → 409' 409
req PATCH "/columns/$DONE" '{"name":"x"}'; check '已完成不能改名 → 409' 409
req PATCH "/columns/$DOING" '{"name":"开发中"}'; check '「进行中」是普通列，可改名' 200 '.column.name == "开发中"'
req PATCH "/columns/$TODO" '{"sort":0.5}'; check '待处理不能排序 → 409' 409
req PATCH "/columns/$DONE" '{"sort":0.5}'; check '已完成不能排序 → 409' 409
req PATCH "/columns/$COL" '{"sort":0}'; check '排到待处理的位置 → 400' 400
req PATCH "/columns/$COL" '{"sort":-5}'; check '排到待处理前面 → 400' 400
req PATCH "/columns/$COL" '{"sort":1e9}'; check '排到已完成的位置 → 400' 400
req PATCH "/columns/$COL" '{"sort":"1"}'; check 'sort 不是数字 → 400' 400
req PATCH "/columns/$COL" '{}'; check '空 PATCH → 400' 400
req PATCH "/columns/$COL" '{"sort":0.5}'; check '普通列可在中间排序' 200 '.renumbered == false'
req GET /board; check '列顺序生效' 200 '[.columns[].name] == ["待处理","测试列","开发中","已完成"]'
req DELETE "/columns/$TODO"; check '待处理不能删 → 409' 409
req DELETE "/columns/$DONE"; check '已完成不能删 → 409' 409

echo '== 任务与拖拽 §5'
req POST /tasks "{\"column_id\":\"$DONE\",\"title\":\"x\"}"; check '不能在已完成里新建 → 400' 400
req POST /tasks "{\"column_id\":\"$TODO\",\"title\":\"  \"}"; check '空标题 → 400' 400
req POST /tasks "{\"column_id\":\"$TODO\"}"; check '缺标题 → 400' 400
req POST /tasks "{\"column_id\":\"$TODO\",\"title\":\"任务1\",\"priority\":3}"; check '新建任务' 201 \
  ".column_id == \"$TODO\" and .priority == 3 and .done_at == null and .sub_total == 0"
T1=$(j .id)
req POST "/tasks/$T1/move" "{\"column_id\":\"$DONE\",\"sort\":1}"; check '拖入已完成 → 400' 400
req POST "/tasks/$T1/move" "{\"column_id\":\"$COL\",\"sort\":1}"; check '待处理 → 普通列' 200 ".task.column_id == \"$COL\""
req POST "/tasks/$T1/move" "{\"column_id\":\"$DOING\",\"sort\":1}"; check '普通列 → 普通列' 200 ".task.column_id == \"$DOING\""
req POST "/tasks/$T1/move" "{\"column_id\":\"$TODO\",\"sort\":1}"; check '普通列 → 待处理' 200 ".task.column_id == \"$TODO\""
req POST "/tasks/$T1/move" "{\"column_id\":\"$COL\",\"sort\":1}"; check '再移回测试列' 200
req POST "/tasks/$T1/move" "{\"column_id\":\"$COL\",\"sort\":2}"; check '同列内排序' 200 '.task.sort == 2'
req POST "/tasks/$T1/move" "{\"column_id\":\"$COL\"}"; check '缺 sort → 400' 400
req GET "/tasks/$T1"; check '时间线：创建 + 每次跨列移动（同列排序不记）' 200 \
  '[.timeline[] | select(.kind == "system") | .body_md] == ["创建了任务","移动到「测试列」","移动到「开发中」","移动到「待处理」","移动到「测试列」"]'
req DELETE "/columns/$COL"; check '列里有任务不能删 → 409' 409

echo '== 完成 / 取消完成 §5'
req POST "/tasks/$T1/complete"; check '完成 → 进入已完成，记录完成时间' 200 ".column_id == \"$DONE\" and .done_at != null"
req POST "/tasks/$T1/complete"; check '重复完成 → 409' 409
req POST "/tasks/$T1/move" "{\"column_id\":\"$TODO\",\"sort\":1}"; check '从已完成拖出 → 400' 400
req POST "/tasks/$T1/move" "{\"column_id\":\"$DONE\",\"sort\":-10}"; check '已完成组内可排序' 200 ".task.column_id == \"$DONE\" and .task.sort == -10"
req POST "/tasks/$T1/uncomplete"; check '取消完成 → 回到原列（测试列）' 200 ".column_id == \"$COL\" and .done_at == null"
req POST "/tasks/$T1/uncomplete"; check '未完成的任务取消完成 → 409' 409
req POST "/tasks/$T1/complete"; check '再次完成' 200
req DELETE "/columns/$COL"; check '任务完成后原列已空，可以删除' 200
req POST "/tasks/$T1/uncomplete"; check '原列已删 → 回到待处理' 200 ".column_id == \"$TODO\""
req GET "/tasks/$T1"; check '时间线有完成 / 取消完成记录' 200 \
  '[.timeline[] | select(.kind == "system") | .body_md] | any(. == "完成了任务") and .[-1] == "取消完成，回到「待处理」"'

echo '== 编辑字段'
req PATCH "/tasks/$T1" '{"title":"任务1改","desc_md":"# hi\n<script>alert(1)</script>","priority":4,"due_at":1767225600000}'
check 'PATCH 标题/描述/优先级/截止日期' 200 '.title == "任务1改" and .priority == 4 and .due_at == 1767225600000'
req PATCH "/tasks/$T1" '{"priority":5}'; check '优先级越界 → 400' 400
req PATCH "/tasks/$T1" '{"priority":1.5}'; check '优先级非整数 → 400' 400
req PATCH "/tasks/$T1" '{"title":""}'; check '标题改空 → 400' 400
req PATCH "/tasks/$T1" '{"column_id":"x"}'; check 'PATCH 不能改列（无可更新字段）→ 400' 400
req PATCH "/tasks/$T1" '{"due_at":null}'; check '清空截止日期' 200 '.due_at == null'
req GET "/tasks/$T1"; check 'Markdown 原样存储（过滤在前端渲染时做）' 200 '.task.desc_md == "# hi\n<script>alert(1)</script>"'

echo '== 子任务'
req POST "/tasks/$T1/subtasks" '{"title":"子1"}'; check '新建子任务' 201 '.done == 0'
S1=$(j .id)
req POST "/tasks/$T1/subtasks" '{"title":"子2"}'; check '新建子任务 2' 201
S2=$(j .id)
req PATCH "/tasks/$T1/subtasks/$S1" '{"done":true}'; check '勾选子任务' 200 '.done == 1'
req PATCH "/tasks/$T1/subtasks/$S1" '{"done":"yes"}'; check 'done 不是布尔 → 400' 400
req GET /board; check '卡片子任务进度 1/2' 200 ".tasks[] | select(.id == \"$T1\") | .sub_done == 1 and .sub_total == 2"
req DELETE "/tasks/$T1/subtasks/$S2"; check '删除子任务' 200
req DELETE "/tasks/$T1/subtasks/$S2"; check '重复删除 → 404' 404
req GET "/tasks/$T1"; check '详情子任务列表' 200 '[.subtasks[].title] == ["子1"]'

echo '== 评论与动态'
req POST "/tasks/$T1/comments" '{"body_md":"看图 ![](/files/zhuhu/x.webp)"}'; check '发评论' 201 '.kind == "user"'
C1=$(j .id)
req POST "/tasks/$T1/comments" '{"body_md":"  "}'; check '空评论 → 400' 400
req GET /board; check '卡片评论数只数用户评论' 200 ".tasks[] | select(.id == \"$T1\") | .comment_count == 1"
req GET "/tasks/$T1"; check '时间线混排评论与动态，按时间排序' 200 ".timeline[-1].id == \"$C1\" and .timeline[0].body_md == \"创建了任务\""
SYS=$(j '.timeline[0].id')
req DELETE "/tasks/$T1/comments/$SYS"; check '系统动态不能删 → 409' 409
req POST "/tasks/$T1/comments" '{"body_md":"待删"}'
C2=$(j .id)
req DELETE "/tasks/$T1/comments/$C2"; check '删除自己的评论' 200

echo '== 越权：lvcui 访问 zhuhu 的资源，一律 404'
TOK=$BT
req GET /board; check 'lvcui 只看到自己的默认列，看不到任何 zhuhu 任务' 200 \
  '.user == "lvcui" and (.tasks | length == 0) and ([.columns[].id] | all(startswith("lvcui-")))'
BTODO=$(j '.columns[0].id')
req GET "/tasks/$T1"; check 'GET 他人任务' 404
req PATCH "/tasks/$T1" '{"title":"hack"}'; check 'PATCH 他人任务' 404
req POST "/tasks/$T1/move" "{\"column_id\":\"$BTODO\",\"sort\":1}"; check '把他人任务移进自己的列' 404
req POST "/tasks/$T1/complete"; check '完成他人任务' 404
req POST "/tasks/$T1/uncomplete"; check '取消完成他人任务' 404
req POST "/tasks/$T1/subtasks" '{"title":"x"}'; check '给他人任务加子任务' 404
req PATCH "/tasks/$T1/subtasks/$S1" '{"done":false}'; check '改他人子任务' 404
req DELETE "/tasks/$T1/subtasks/$S1"; check '删他人子任务' 404
req POST "/tasks/$T1/comments" '{"body_md":"x"}'; check '评论他人任务' 404
req DELETE "/tasks/$T1/comments/$C1"; check '删他人评论' 404
req POST /tasks "{\"column_id\":\"$TODO\",\"title\":\"x\"}"; check '在他人列里建任务' 404
req PATCH "/columns/$DOING" '{"name":"hack"}'; check '改他人列名' 404
req PATCH "/columns/$DOING" '{"sort":0.5}'; check '排他人列' 404
req DELETE "/columns/$DOING"; check '删他人列' 404
req DELETE "/tasks/$T1"; check '删他人任务' 404
req POST /tasks "{\"column_id\":\"$BTODO\",\"title\":\"lvcui 的任务\"}"; check 'lvcui 在自己列里建任务' 201
BT1=$(j .id)
req PATCH "/tasks/$BT1/subtasks/$S1" '{"done":false}'; check '借自己的任务路径改他人子任务' 404
req DELETE "/tasks/$BT1/subtasks/$S1"; check '借自己的任务路径删他人子任务' 404
req DELETE "/tasks/$BT1/comments/$C1"; check '借自己的任务路径删他人评论' 404
TOK=$A
req POST "/tasks/$T1/move" "{\"column_id\":\"$BTODO\",\"sort\":1}"; check 'zhuhu 把自己任务移进 lvcui 的列' 404
req GET "/tasks/$BT1"; check 'zhuhu 读 lvcui 的任务' 404
req GET "/tasks/$T1"; check 'zhuhu 的数据没被改动' 200 \
  '.task.title == "任务1改" and .task.column_id == "zhuhu-todo" and .subtasks[0].done == 1 and (.timeline | map(select(.kind == "user")) | length == 1)'
req GET /board; check 'zhuhu 看板里没有 lvcui 的任务' 200 "[.tasks[].id] | index(\"$BT1\") == null"

echo '== 浮点排序与重编号 §4'
req POST /tasks "{\"column_id\":\"$DOING\",\"title\":\"P\"}"; P_SORT=$(j .sort)
req POST /tasks "{\"column_id\":\"$DOING\",\"title\":\"Q\"}"; HI=$(j .sort)
req POST /tasks "{\"column_id\":\"$DOING\",\"title\":\"R\"}"; R=$(j .id)
N=0
for i in $(seq 1 40); do # 反复把 R 插到 P 和它上一次位置的中点，间隙每次减半
  HI=$(jq -n "($P_SORT + $HI) / 2")
  req POST "/tasks/$R/move" "{\"column_id\":\"$DOING\",\"sort\":$HI}"
  [[ $(j .renumbered) == true ]] && { N=$i; break; }
done
if ((N > 0 && N < 50)); then ok "同位置连续插入第 $N 次时服务端检测到间隙过小，整列重编号"; else ng '任务重编号' "40 次内未触发 renumbered（最后响应 $S ${B}）"; fi
req GET /board; check '重编号后顺序保持 P R Q，sort 为 1 2 3' 200 \
  "[.tasks[] | select(.column_id == \"$DOING\") | [.title, .sort]] == [[\"P\",1],[\"R\",2],[\"Q\",3]]"

req POST /columns '{"name":"X"}'; X=$(j .id)
HI=1 # 「开发中」的 sort
N=0
for i in $(seq 1 40); do # 反复把 X 插到待处理（0）和它上一次位置的中点，向待处理逼近
  HI=$(jq -n "$HI / 2")
  req PATCH "/columns/$X" "{\"sort\":$HI}"
  [[ $(j .renumbered) == true ]] && { N=$i; break; }
done
if ((N > 0 && N < 50)); then ok "列连续插入第 $N 次时整列重编号"; else ng '列重编号' "40 次内未触发 renumbered（最后响应 $S ${B}）"; fi
req GET /board; check '列重编号后：待处理 0、普通列 1..n、已完成 1e9' 200 \
  '[.columns[] | [.name, .sort]] == [["待处理",0],["X",1],["开发中",2],["已完成",1000000000]]'

echo '== 删除任务级联'
req DELETE "/tasks/$T1"; check '删除任务' 200
req GET "/tasks/$T1"; check '删除后 404' 404
LEFT=$(sql "SELECT (SELECT COUNT(*) FROM subtasks WHERE task_id = '$T1') + (SELECT COUNT(*) FROM comments WHERE task_id = '$T1') AS n" | jq '.[0].n')
if [[ $LEFT == 0 ]]; then ok '子任务和评论被外键级联删除'; else ng '级联删除' "残留 $LEFT 行"; fi

echo '== 图片上传 §6'
echo 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d >"$TMP/a.png"
up image/png "$TMP/a.png"; check '上传 png，返回相对路径 /files/<uid>/<uuid>.png' 201 '.url | test("^/files/zhuhu/[0-9a-f-]{36}\\.png$")'
URL=$(j .url)
H=$(curl -s -D - -o "$TMP/got.png" "$API$URL")
if grep -qi '^content-type: image/png' <<<"$H" && grep -qi '^x-content-type-options: nosniff' <<<"$H" && cmp -s "$TMP/a.png" "$TMP/got.png"; then
  ok '/files 不鉴权可读，内容一致，带 nosniff'
else ng '/files 读取' "$H"; fi
up image/webp "$TMP/a.png" ''; check '未登录上传 → 401' 401
printf '<script>alert(1)</script>' >"$TMP/x.html"
up text/html "$TMP/x.html"; check '非图片类型 → 415' 415
up constructor "$TMP/x.html"; check '原型链上的 key 不会被当成合法类型 → 415' 415
head -c $((5 * 1024 * 1024 + 1)) /dev/zero >"$TMP/big.bin"
up image/jpeg "$TMP/big.bin"; check '超过 5MB → 413' 413
: >"$TMP/empty.bin"
up image/jpeg "$TMP/empty.bin"; check '空文件 → 400' 400
S=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$API/files/zhuhu/../../etc/passwd"); check '非法 key → 404' 404
S=$(curl -s -o /dev/null -w '%{http_code}' "$API/files/zhuhu/00000000-0000-0000-0000-000000000000.png"); check '不存在的图片 → 404' 404

echo '== 防爆破 §3'
for _ in 1 2 3 4 5; do req POST /login "$(cred lvcui wrong)" ''; done
check '连续第 5 次错误仍是 401' 401
req POST /login "$(cred lvcui "$PW_LVCUI")" ''; check '锁定期间正确密码也被拒 → 429' 429 '.error | test("分钟")'
req POST /login "$(cred zhuhu "$PW_ZHUHU")" ''; check '锁定按用户隔离：zhuhu 不受影响' 200
req GET /board '' "$BT"; check '锁定不影响已签发的 token' 200
sql 'UPDATE login_fail SET locked_until = 0' >/dev/null # 模拟 10 分钟已过
req POST /login "$(cred lvcui "$PW_LVCUI")" ''; check '锁定过期后可以登录' 200
for _ in 1 2 3 4; do req POST /login "$(cred zhuhu wrong)" ''; done
req POST /login "$(cred zhuhu "$PW_ZHUHU")" ''; check '错 4 次后正确密码仍可登录' 200
for _ in 1 2 3 4; do req POST /login "$(cred zhuhu wrong)" ''; done
req POST /login "$(cred zhuhu "$PW_ZHUHU")" ''; check '登录成功会清零计数（只算连续失败）' 200

echo '== 同域托管与安全头'
H=$(curl -s -D - -o /dev/null "$API/board" -H "authorization: Bearer $A" | tr -d '\r')
if grep -qi "^content-security-policy:.*script-src 'self'" <<<"$H" && grep -qi '^x-content-type-options: nosniff' <<<"$H" && grep -qi '^cache-control: no-store' <<<"$H"; then
  ok 'API 响应带 CSP / nosniff / no-store'
else ng 'API 安全头' "$H"; fi
grep -qi '^access-control-allow-origin' <<<"$H" && ng 'CORS' '同域名部署不应再返回 CORS 头' || ok '同域名部署，不返回任何 CORS 头'
req GET /health '' ''; check '/api/health 免登录' 200 '.ok == true'
head -c $((7 * 1024 * 1024)) /dev/zero >"$TMP/huge.bin"
up image/png "$TMP/huge.bin" "$A"; check '请求体超过 6MB 在入口直接拒绝 → 413' 413
if [[ $(curl -s -o /dev/null -w '%{http_code}' "$BASE/") == 200 ]]; then
  H=$(curl -s -D - -o "$TMP/index.html" "$BASE/" | tr -d '\r')
  grep -qi '^content-type: text/html' <<<"$H" && grep -qi '^cache-control: no-cache' <<<"$H" && grep -qi '^content-security-policy' <<<"$H" \
    && ok '首页 index.html：no-cache + CSP' || ng '首页' "$H"
  ASSET=$(grep -o '/assets/[^"]*\.js' "$TMP/index.html" | head -1)
  curl -s -D - -o /dev/null "$BASE$ASSET" | grep -qi '^cache-control:.*immutable' && ok '带 hash 的 assets 永久缓存' || ng 'assets 缓存' "$ASSET"
  S=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sw.js"); check 'Service Worker 脚本可访问' 200
  S=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/../api/src/server.ts"); check '静态目录之外的路径 → 404' 404
  S=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/index.html"); check '静态文件只接受 GET → 404' 404
else
  echo '  - 未构建 web/dist，跳过静态托管检查'
fi

echo
echo "通过 ${PASS}，失败 $FAIL"
((FAIL == 0))
