# FastAPI-Only 生产切换手册（Runbook）

> 对应任务：`.trae/specs/retire-node-http-api/tasks.md` Task 9.1 · 目标：生产环境从「Nginx→Node API(:3001)」切换为「Nginx→FastAPI(:8000)」，Node 仅保留 Worker 执行体。
> FastAPI-only 已部署；2026-10-20 `dd76d16` 已把 TTS 原生路由及 118 条 API 分支发布到独立 release，生产烟测 PASS 4 / SKIP 1 / FAIL 0。真实 DashScope/COS 音频生成仍需单独验收；本手册保留首次切换步骤作为复核/回滚清单，实际线上 release 路径见最终报告 §10。本手册每步含验证命令与预期输出。
> 回滚预案见 §15。**执行窗口建议低峰期**；步骤 6-9 之间用户请求由新旧后端分担的时长应压到最短（建议步骤 6-9 连续执行，约 5 分钟）。

## 0. 前置检查（执行前必做）

> 健康契约：探针 `/health` 与 `/ready` 不经 Nginx 暴露公网；公网入口验证一律用 API 收口形状（4040 envelope / 4010），smoke 脚本（§7/§9）负责具体用法。TTS 两条原生路由已不再属于 501 豁免；未登录调用应在鉴权层返回 401，不能触发生成。

```bash
# 0.1 代码版本：服务器仓库处于包含阶段 0-8 的提交（git log 确认含 docs/node-retirement-final-report.md 同 commit）
git -C /path/to/projectdream log --oneline -3
test -f /path/to/projectdream/docs/node-retirement-final-report.md || { echo "最终报告缺失，停止切换"; exit 1; }
# 0.2 门禁复验（服务器本地执行，任一非 0 退出即中止切换）
node scripts/assert-fastapi-only.mjs        # 预期：0 处违规 / 0 项防护错误，exit 0
python -m pytest api-service/tests -q       # 预期：与同一提交最终报告记录的数量一致（不得沿用旧基线数字）
# 0.3 工作树保护：必须干净；有任何修改/未跟踪文件即停止，不 stash/reset/checkout 覆盖
git -C /path/to/projectdream status --short
test -z "$(git -C /path/to/projectdream status --porcelain)" || { echo "生产工作树非干净，停止；先保全并审阅现有改动"; exit 1; }
# 0.4 生产环境现状与真实入口记录（裸 IP:80 可能命中其他站点的默认虚拟主机）
docker compose --env-file .env.production ps
docker compose --env-file .env.production port frontend 8080 # 记录前端容器发布到宿主机的实际地址/端口
ss -tlnp | grep -E ':3001|:8000|:80|:443|:8002' # 记录 API、旧 Node 与公网入口监听者
sudo nginx -T 2>&1 | grep -E '^[[:space:]]*server_name[[:space:]]' # 核对宿主 Nginx 虚拟主机；确认哪个域名实际路由到 ProjectDream
cp .env.production .env.production.bak-$(date +%F)
```

后续公网 smoke 必须使用确认路由到 ProjectDream 的 HTTPS 域名；若未配置该域名，只有在前端发布端口已按预期开放时才使用 `http://<公网IP>:<前端发布端口>`。不得把裸 IP:80 默认当作 ProjectDream 入口。宿主 Nginx 若承载其他站点，且没有 ProjectDream 对应的 `server_name`/`proxy_pass`，不属于本次切换目标，不得为本项目重载共享宿主 Nginx。

## 1. 数据库备份

```bash
mkdir -p backup
DB_DUMP="backup/db-$(date +%F-%H%M%S).sql.gz"   # 文件名精确到秒，避免同分钟重复执行时互相覆盖

# 凭据机制：MYSQL_ROOT_PASSWORD / MYSQL_DATABASE 由 compose 依据 .env.production 展开后注入 mysql 容器 env，
# 经 sh -c 在容器内展开——不依赖宿主 shell（docker compose --env-file 不会把变量导出到宿主环境）。
# 库名取容器内 ${MYSQL_DATABASE:-projectdream}（与 compose 默认一致）；执行前先核对容器 env：
docker compose --env-file .env.production exec mysql printenv MYSQL_DATABASE   # 预期：输出库名（如 projectdream）；为空或不符则先修正 .env.production 再继续

docker compose --env-file .env.production exec mysql sh -c \
  'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines "${MYSQL_DATABASE:-projectdream}"' \
  | gzip > "$DB_DUMP"
gzip -t "$DB_DUMP" && [ -s "$DB_DUMP" ] && echo "备份完整性 OK：$DB_DUMP（$(wc -c < "$DB_DUMP") 字节）"
# 预期输出：备份完整性 OK：backup/db-<日期-时分秒>.sql.gz（非零字节数）
```

> 失败停止条件：mysqldump/gzip 报错、`gzip -t` 校验失败或文件 0 字节——备份未成功不得进入 §2（先备份后迁移），修复后重跑本步。回退指向：§15 数据兜底（R2 依赖本步产物）。

## 2. 数据库迁移 0001-0004（幂等，先于新镜像启动）

```bash
# 前置：§1 备份未成功时本步不得执行（先备份后迁移）。
# 幂等性核对（如实说明）：0001-0004 前向迁移均只含 CREATE TABLE IF NOT EXISTS（无 ALTER/INSERT），
# 重复执行安全；迁移文件本身无「已应用登记表」，已存在的表会被静默跳过——执行前先看现状：
docker compose --env-file .env.production exec mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SHOW TABLES;"' \
  | grep -E 'agent_runs|agent_pipeline_checkpoints|agent_paid_submissions|agent_run_leases|auth_captcha_sessions' || echo "（相关表均不存在：需全量执行 0001→0004）"

# 顺序硬性 0001→0004；显式列出文件，避免通配 000{1,2,3,4}_*.sql 误匹配 0004_*_rollback.sql：
for f in \
  api-service/migrations/0001_agent_runs.sql \
  api-service/migrations/0002_agent_pipeline_checkpoints.sql \
  api-service/migrations/0003_agent_run_leases.sql \
  api-service/migrations/0004_auth_captcha_sessions.sql; do
  echo "== 应用 $f =="
  docker compose --env-file .env.production exec -T mysql sh -c \
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < "$f" \
    && echo "== $f 完成 ==" || { echo "!! $f 失败，停止（勿继续后续迁移）"; break; }
done

# 验证：0004 表存在（凭据机制同 §1）
docker compose --env-file .env.production exec mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SHOW TABLES;"' \
  | grep -c auth_captcha_sessions   # 预期输出：1
```

> 失败停止条件：任一迁移输出 ERROR / 非零退出——立即停止，不得继续后续迁移或进入 §6；已成功的部分因 IF NOT EXISTS 可安全重跑。回退指向：§15 R2（0004 专属回滚）。

## 3. 构建镜像

```bash
docker compose --env-file .env.production build api worker-node   # api=Python 镜像，worker-node=Dockerfile.worker
docker compose --env-file .env.production images | grep -E 'api|worker'   # 记录新镜像 ID
```

> 失败停止条件：build 报错或 `docker images` 未见新构建镜像——停止，不进入 §6。回退指向：§15 R1（沿用当前运行版本）。

## 4. 更新 .env.production

已随仓库提交（第五阶段删除 `NODE_UPSTREAM_URL` 等 Node API 键）。核对：

```bash
grep -nE 'NODE_UPSTREAM|3001' .env.production   # 预期：无输出
grep -n 'OBJECT_STORAGE_PUBLIC_BASE_URL' .env.production   # 预期：指 :8000（api 服务名亦可）
```

> 失败停止条件：`grep -nE 'NODE_UPSTREAM|3001'` 有输出（.env.production 未随仓库更新）——先核对环境文件版本，未更新不得切流。回退指向：§15 R1。

## 5. 部署 Nginx 新配置并验证语法

仓库 `nginx.conf` 已切换：`/api/` 与 `/generated/ /storage/ /mock/ /mock-assets/` 全部 `proxy_pass http://api:8000`。

```bash
docker compose --env-file .env.production exec frontend nginx -t   # 预期：syntax is ok / test is successful（容器内挂载新配置后）
# 仅当 §0 确认宿主 Nginx 的 ProjectDream server_name 实际代理到本栈时，才部署/检查并重载该配置：
# sudo nginx -t && sudo nginx -s reload
# 若宿主 Nginx 是其他站点的共享入口，不得因本次切换而重载；本栈入口由 frontend 容器内 Nginx 提供。
```

> 失败停止条件：`nginx -t` 报 syntax error / test failed——不得 reload 或重启 frontend。回退指向：§15 R3。

## 6. 滚动重启栈（五服务拓扑：mysql / api / worker-node / frontend / rag）

```bash
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps   # 预期：五服务，api/worker-node/mysql healthy；列表中无 backend
```

> 数据卷说明：排障若需 `docker compose down`，named 数据卷（projectdream_mysql_data / runtime_data / rag_runtime_data）不会被删除（down 不带 -v 即不删卷）；严禁 `down -v`。
> 失败停止条件：`ps` 显示 api/worker-node/mysql 非 healthy、容器重启循环或列表出现 backend 服务——保留现场，不继续。回退指向：§15 R1。

## 7. 第一轮黑盒（切流后立即）

```bash
# 容器内 readiness + 静态结构检查：api 仅 expose 8000 未发布宿主端口（宿主 127.0.0.1:8000 不可达），
# 经 docker compose exec api 用镜像内 python urllib 探 /health /ready——探针不经公网（与 §0 健康契约一致）。
# [ ] 内为可选参数（实际执行时去掉方括号）：--compose-file 默认 <仓库根>/docker-compose.yml，--env-file 默认 env SMOKE_ENV_FILE
node scripts/fastapi-only-smoke.mjs --exec-compose [--compose-file docker-compose.yml] [--env-file .env.production] --check-compose
# 预期逐步 PASS：GET /health（容器内 readiness）→ GET /ready（容器内 readiness）→ --check-compose 编排断言（静态结构检查）
# 最小生成链路：未配置 SMOKE_DEMO_PHONE/SMOKE_DEMO_PASSWORD 时 SKIP（不影响退出码；配置演示凭据后应 PASS）
# 人工抽查：登录页注册/登录、项目列表、打开任一项目详情（assets/scenes/storyboards 读链）
```

> 失败停止条件：smoke 任一 FAIL 或人工走查异常——立即触发 §15（R1 切回镜像 / R3 恢复 Nginx），不得进入 §8。

## 8. 停止旧 Node API 进程（3001 释放）

生产若存在 compose 外独立运行的 Node API（systemd/pm2/screen，或旧版本 compose 遗留容器）：

```bash
docker ps | grep -E 'backend|:3001'          # 旧 compose 容器：docker rm -f <name>
pm2 list && pm2 stop <node-api-id>           # 或 systemctl stop <node-api>
ss -tlnp | grep ':3001'                      # 预期：无输出（3001 已无监听）
```

> 失败停止条件：`ss -tlnp | grep ':3001'` 仍有监听且来源不明——保留旧进程不杀，先查明归属再处理。回退指向：§15 R3。

> 若旧 Node API 从未单独部署（此前 3001 即 compose backend 服务），该服务在步骤 6 已随新 compose 消失，本步只需验证端口释放。

## 9. 第二轮黑盒（停 Node 后，模拟"Node 不可用"终态）

公网黑盒复核（与 §7 的容器内 readiness 模式互补，不重复 exec 命令）+ 补充真实用户链路：

```bash
# 公网黑盒（--public 可省略，缺省即公网黑盒）：SMOKE_BASE_URL 必须填写 §0 核实的 ProjectDream 正式入口，不能猜测裸 IP:80。
# 示例：SMOKE_BASE_URL="https://dream.example.com"；无域名且前端端口有意公开时，填 "http://<公网IP>:<前端发布端口>"。
# 探针直连已移除——/health /ready 不经公网（与 §0 健康契约一致），
# SPA fallback 的 200 + text/html 不再构成假阳性，改以 FastAPI 专有收口形状逐字段断言。
node scripts/fastapi-only-smoke.mjs --base-url "$SMOKE_BASE_URL" --public
# 预期逐步 PASS：4040 收口抽查（GET /api/definitely-not-a-route）→ TTS 原生路由鉴权（POST /api/projects/1/audio/generate 未登录返回 401，不触发生成）→ 通用鉴权 401 形状（GET /api/projects 未登录）
# 最小生成链路：未配置 SMOKE_DEMO_PHONE/SMOKE_DEMO_PASSWORD 时 SKIP（不影响退出码；配置演示凭据后应 PASS）
# 前端全功能人工走查：注册→建项目→资产画布→剧本/分镜生成（mock 口径至少跑通）→媒体预览（图片/音频/视频 Range 拖动）→导出下载
```

> 失败停止条件：公网 smoke 或人工走查任一失败——立即触发 §15（R1 换回镜像 + R3 恢复 Nginx 与旧 Node API）。数据兜底：§1 备份。

## 10. Worker 消费端到端验证（付费链路）

```bash
# 触发一次真实静帧/视频生成（供应商凭据齐备时），观察任务闭环：
docker compose --env-file .env.production logs worker-node --tail 100   # 非阻塞快照（logs -f 会无限阻塞；如需持续观察用 timeout 60 docker compose --env-file .env.production logs -f worker-node，超时自动退出）
# 每 30s 轮询一次任务状态（凭据机制同 §1），直至最新任务 status=succeeded：
docker compose --env-file .env.production exec mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SELECT id,status,updated_at FROM generation_jobs ORDER BY id DESC LIMIT 5;"'
# 预期输出：最新任务行 status 由 queued → running → succeeded
# 整体预期：worker-node 轮询 generation_jobs 拾取 FastAPI 入库的任务行 → 执行 → 状态回写 succeeded → 前端媒体可预览

# api 容器内就绪验证（python:3.12-slim 无 curl，统一用镜像内 python）：
docker compose --env-file .env.production exec api python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=5).read().decode())"
# 预期输出：{"status":"ready"}

# 宿主入口验证（frontend 发布 ${HTTP_PORT:-80}→8080，经 Nginx → api:8000 的 /api 路径）：
curl -s http://127.0.0.1/api/health   # 预期：HTTP 200 success envelope，data.status=="ok"（HTTP_PORT 非 80 时改用 http://127.0.0.1:<HTTP_PORT>/api/health）
```

> 失败停止条件：任务长时间停留 queued/running、回写 failed，或 `/ready`、`/api/health` 验证异常——付费链路未闭环，保留现场排查。回退指向：§15 R1。

## 11. 运维脚本与文档收尾

```bash
bash -n scripts/deploy-production.sh   # 语法 OK（已随第六阶段更新为五服务拓扑）
# 确认 cron/监控中不再引用 3001（Grep 服务器上 crontab -l 与监控配置）
```

## 12. 观察期（24-48h）

- 监控项：api 服务 5xx 率、`generation_jobs` 队列积压、captcha 会话表增长、SMS 发送成功率（tencent provider 凭据若未配置，注册走 mock/devCode——**生产必须配置 SMS_* 真实凭据**）
- 已知行为差异（有意收紧，出现相关工单时对照）：/storage 无签名 401（原 Node 裸读）；非数字滑块坐标拒绝（原 NaN 放行）；确认远端临时链接 409/4092

## 13. 旧资源清理（观察期通过后）

```bash
# 13.1 只读列示（不删除任何东西）。悬空（<none>）镜像可能属于其他项目或构建缓存，不作为本项目清理对象：
docker images --format '{{.ID}}  {{.Repository}}:{{.Tag}}  {{.CreatedSince}}' | grep -Ei 'projectdream|backend|node'
# 预期输出：候选列表含旧 backend API 镜像；保留在用镜像（Worker 仍是 Node 执行体，worker-node 镜像勿删）
docker ps -a --format '{{.ID}}  {{.Image}}  {{.Names}}  {{.Status}}'
# 预期输出：核对上一步候选镜像 ID 未被任何容器（含已停止容器）引用；有引用的一律不删

# 13.2 显式删除（非默认步骤）：操作者核对 13.1 两步输出后，逐个显式填入目标 ID 执行，禁止按名称模糊批量删除：
docker rmi <候选镜像ID>   # 预期输出：若干 Untagged / Deleted 行；若报 conflict（仍被引用）立即停止，勿加 -f
```

`.env.production.bak-*`（§0 产生）：确认已归档至备份盘后**手动删除**——该文件含全部生产密钥（数据库/SMS/对象存储凭据），不得留在仓库目录，严禁提交或打进镜像层。

## 14. 最终验收记录

逐条勾选 `docs/node-retirement-final-report.md` §3 九条硬条件，附本手册各步输出截图/日志归档路径；报告状态从 PENDING 翻为 YES。

## 15. 回滚预案（任一黑盒失败即触发）

```bash
# R1 应用回滚（分钟级）：切回上一镜像版本
# 不执行 down、checkout 或 build；用已保留的旧 release Compose 和 2026-10-19 镜像标签逐服务恢复。
OLD_RELEASE=/opt/projects/projectdream/releases/20261019-fastapi-only/projectdream-release-20261019
docker compose --env-file /opt/projects/projectdream/.env.production \
  -f "$OLD_RELEASE/docker-compose.release.yml" up -d --no-build api rag worker-node frontend
# 等待四个容器 healthy 后复跑 §7/§9 smoke；MySQL、external networks 和数据卷不重建。
docker compose --env-file /opt/projects/projectdream/.env.production \
  -f "$OLD_RELEASE/docker-compose.release.yml" ps
# R2 数据回滚（仅当迁移 0004 造成写入异常；captcha 会话数据可丢弃，不影响其他表）
docker compose --env-file .env.production exec -T mysql sh -c \
  'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < api-service/migrations/0004_auth_captcha_sessions_rollback.sql
# R3 Nginx 回滚：恢复备份的 nginx.conf（四媒体路指回 3001）→ nginx -s reload → 启动旧 Node API
# 数据兜底：backup/db-*.sql.gz（步骤 1）
```
