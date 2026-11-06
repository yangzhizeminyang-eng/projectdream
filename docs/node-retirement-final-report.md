# Node HTTP API 下线最终报告

> 任务书：`.trae/specs/retire-node-http-api/spec.md` · 清单：[docs/node-retirement-inventory.md](node-retirement-inventory.md) · ADR：[docs/fastapi-only-architecture-decision.md](fastapi-only-architecture-decision.md)
> 基线 commit：`cbf34c1`（2026-10-17 扫描）· 报告日期：2026-10-19；2026-10-20 本地复验已补记于 §2/§8 · 切换手册：[docs/production-switch-runbook.md](production-switch-runbook.md)

## 1. 结论（任务书要求格式）

> **Node HTTP API 已从生产流量下线；P74 的 TTS 原生路由与 118 条 Node API 分支已随 `dd76d16` 同步生产，当前云端 smoke 通过。DashScope/COS 凭据已配置，但真实付费生成、演示账号 CRUD 与观察期仍未闭环。**
>
> 2026-10-19 首次在独立 release 部署 FastAPI-only 栈并完成数据库迁移 0001-0004；2026-10-20 又将 `dd76d16` 部署到独立 release，完成 TTS 原生路由发布和生产 smoke。旧 Node `backend`/`worker` 容器仍保留用于回退，宿主无 3001 监听。当前仍需完成演示账号登录态验收、真实供应商执行和观察期。
>
> 遗留验收：24-48 小时观察期尚未结束；未配置/提供演示账号，已登录创建-详情-删除链路在生产 smoke 中 SKIP；生产 SMS 当前报告为 mock；未触发真实付费 Worker 生成，因此消费队列的供应商端到端尚未验证；RAG 实际检索与媒体 Range 播放/导出人工验收待补。以上不影响 Node API 已停止和本轮已通过的黑盒切流验收。

## 2. 完成工作总览（阶段 0-10）

| 阶段 | 内容 | 关键证据 |
|------|------|----------|
| 0 准备 | 代理边界修复、测试套件建立 | 阶段 0 遗留项全部解决 |
| 1 清单 | Node 118 条路由分支 / FastAPI 35 条 / 运行时依赖逐文件:行号 / 迁移矩阵 | inventory.md（基线 cbf34c1） |
| 2 决策 | ADR 九项决策（任务表即队列 / captcha MySQL 化 / 不引入 Redis / Worker 边界等） | fastapi-only-architecture-decision.md |
| 3 迁移 | 六业务组全部完成：鉴权、媒体/存储、剧本/分镜、生成任务、项目/资产、运维端点 | 各组 spec 文档 + 新增 258 项测试 |
| 4 消除代理 | 8 flag + proxy_api + 70 回退分支 + Node 探活全删；静态扫描测试红灯→转绿 | 978 passed；config/main 零残留 |
| 5 部署层 | compose 删 backend、worker→worker-node、Nginx 四媒体路切 :8000、镜像拆分 | compose config 五服务无 3001 |
| 6 清理 | scripts 17 处 + vite.config.ts dev 代理 + 部署脚本 + 文档 | 扫描仅剩 4 行 Worker 边界豁免 |
| 7 证据 | 路由覆盖矩阵 118 条四分类、3 条端到端黑盒链路、Worker 独立性 13 项 | 1003 passed |
| 8 门禁 | assert-fastapi-only.mjs（七类禁用项）+ fastapi-only-smoke.mjs（双目标模式，公网不暴露探针） | 门禁 exit 0；smoke/deploy/runbook 定向测试 32/32 |
| 9 云端切换 | 独立 release 目录部署，备份后迁移 0001-0004；构建/载入四镜像；重建 API/RAG/frontend，停旧 Node backend/worker，启动 worker-node | 四新服务 + MySQL healthy；3001 无监听；公网 smoke 两轮 PASS 4 / SKIP 1 / FAIL 0 |
| 10 观察与交接 | 生产证据回写，保留旧容器和旧工作树用于回退；开始观察期 | 本报告与进度看板更新；24-48h 观察及业务/供应商端到端待完成 |

本轮仓库验证（2026-10-20）：pytest **1100 passed**（1 条 Starlette/AnyIO 弃用警告）、`npm test` **975/975**、`npm run type-check`、`npm run build-only`、门禁/部署/runbook 测试 **49/49** 均通过。FastAPI-only 静态门禁为 0 违规。本机 Docker Compose 五服务 healthy；本轮 API、Worker、RAG、前端四镜像均成功构建。本机及云端公网 smoke 均为 **PASS 4 / SKIP 1 / FAIL 0**，唯一 SKIP 为未提供演示凭据的登录 CRUD 链路。2026-10-20 已将 `dd76d16` 部署至独立云端 release，四应用服务和 MySQL 均 healthy，API `/ready` 的 MySQL 检查通过，前端 `/`、`/nginx-health`、`/api/health` 均 200；移动视口与首页素材资源检查通过。真实 DashScope/COS 付费生成仍未执行。

## 3. 九条硬条件评估（任务书 §9）

| # | 硬条件 | 状态 | 证据 |
|---|--------|------|------|
| 1 | 生产环境 Node API 已停止（:3001 无监听） | **YES** | 云端 `ss -ltnp` 仅见前端 8002，无 3001；旧 `projectdream-backend-1` 与 `projectdream-worker-1` 状态 exited，容器保留可回退 |
| 2 | 生产 `/ready` 由 FastAPI 提供 | **YES** | `docker exec projectdream-api-1` 探测返回 `{"status":"ready","checks":{"mysql":true}}`；生产黑盒确认入口响应带 `x-api-gateway: fastapi` |
| 3 | 生产 Nginx 配置无 `backend:3001` | **YES** | 2026-10-20 新前端容器 `nginx -t` 成功；公网 4040 收口、TTS 原生路由 401、通用鉴权 401 均逐字段通过；入口为 frontend 容器 8002，未 reload 不相关的共享宿主 Nginx |
| 4 | Compose 无 `backend` 服务 | **YES**（活动 release 拓扑） | [`docker-compose.release.yml`](../docker-compose.release.yml) 包含 api/worker-node/rag/frontend 四个应用服务；MySQL 复用既有容器，运行栈共五服务。旧 backend 是已停止 orphan 容器，未删除 |
| 5 | `.env.production` 无 `NODE_UPSTREAM_URL` | **YES**（代码/仓库已验证） | 第五阶段已删（键名清单在阶段报告）；Grep 复核零命中 |
| 6 | API 镜像不含 Node 运行时与 `server/index.mjs` | **YES** | `projectdream-api:release-20261020` 由纯 Python API Dockerfile 构建并在生产运行；`/ready` healthy |
| 7 | 全部旧 Node 路由有原生实现或显式 501 | **YES**（代码已部署；供应商效果待验收） | 云端部署矩阵对应提交 `dd76d16`，仓库覆盖矩阵 **native=118 / 501=0 / 4040=0 / 死路由=0**；TTS 路由未登录公网请求返回标准 401。真实 DashScope 合成/COS 写入需要有效凭据和可计费授权，尚未验证 |
| 8 | 测试全绿 | **YES**（仓库 + 当前发布快照） | pytest **1100 passed**、Node `pretest` **30/30**、`npm test` **975/975**、门禁/部署/runbook **49/49**、FastAPI-only 门禁 0 违规；四镜像构建成功，本机 Compose 五服务 healthy；云端五服务 healthy，smoke PASS 4 / SKIP 1 / FAIL 0 |
| 9 | 静态扫描零命中（防回退） | **YES**（代码/仓库已验证） | `node scripts/assert-fastapi-only.mjs` = 0 违规 / 0 防护错误；pytest 扫描测试同语义（EXEMPT_LINES 单一事实源，仅 4 行 Worker 边界 + 11 行文档注释豁免） |

**2026-10-20 发布记录：`dd76d16` 已推送 Gitee `main`，并部署至 `/opt/projects/projectdream/releases/20261020-fastapi-501-closure`；2026-10-19 release 与脏主 checkout 未覆盖。数据库备份位于 `/opt/projects/projectdream/backup/projectdream-pre-dd76d16-20261020.sql.gz`（gzip 校验通过、权限 600）；本轮无 schema 变更、无迁移、无数据卷操作。四个新应用容器 healthy 且 restart count=0，MySQL healthy；生产 smoke PASS 4 / SKIP 1 / FAIL 0，3001 无监听。**

## 4. 501 口径拆分（任务书要求"不应存在——存在即回退 Task 3.x 补齐"的豁免全部带理由）

报告口径拆分为两行陈述——**两类 501 来源不同，不可混计**：

1. **路由级显式 501：0 条**：TTS `voice-preview` 与 `audio/generate` 已迁为 FastAPI 原生端点，`OPS_FALLBACK_501_ROUTES` 已清空；mock、DashScope、Qwen voice-enrollment、自定义声线确认绑定、对象存储及 `audio_assets` 写入有本地契约测试。生产 DashScope/COS 凭据存在，但本次未触发真实生成，尚无音频产出和资产回读证据，不能把真实供应商生产链路标成已验收。
2. **mock 任务动作**：矩阵 #74/#75 `POST /api/project-tasks/{task_key}/retry|cancel` 已随 `dd76d16` 部署；实现 owner 校验、可取消状态判断及事务状态写入，只模拟任务中心状态，不启动真实生成。契约/事务测试通过，生产尚无登录态演示调用证据。

> **native 分类口径**：native 指路由存在且主行为已实现，**不等同于该路由所有请求分支均已迁移**（#74/#75 即属此列）。

当前 `OPS_FALLBACK_501_ROUTES` 为空。声音 Agent 的真实自定义声线在 `AUDIO_PROVIDER=mock` 时按设计返回 503；DashScope 未配置/失败也按 503/5020 明确失败，这些是供应商前置条件，不是路由 501。

已迁出豁免：角色生成/档案、总纲/场景生成、Agent Pipeline 列表/详情/stage-actions、ProductionRun 列表/详情及写侧端点已随 `dd76d16` 部署。Agent Pipeline stage-actions 和 ProductionRun 状态接口不会把登记/推进伪装成 Agent 或媒体执行；真实 Agent/付费媒体执行仍需独立业务验收。

另：悬空调用 ~49 个前端函数（market/jianying/recovery 等）由 4040 收口显式覆盖（Node 现状即 404，行为等价且更明确；前端清理属独立前端重构任务，不在本次范围）。

### 4.5 已从显式 501 迁出、仍待生产验收的功能

（本节描述当前工作树已迁出 501、但其真实执行或生产发布尚未验收的功能。）

| 用户可感知功能 | 涉及路由（条数） | 当前工作树现状 | 尚未闭环的影响/验证 |
|---------------|----------------|----------------|---------------------|
| agent-pipeline 编排（剧本→分镜流水线） | 2 | **FastAPI 原生 + Node Worker，已部署** | start/decision 有持久队列与事务测试；真实 Agent 端到端尚未触发 |
| ProductionRun 阶段执行 | 写侧 4 条原生 | FastAPI 原生，已部署 | 阶段状态写入不代表 Agent/候选生成已真实执行 |
| TTS 生成：voice-preview、audio/generate | 2 | FastAPI 原生，已部署；mock、DashScope 适配、存储/绑定有本地契约测试 | 真实执行依赖有效 DashScope 凭据、可用额度和对象存储；mock 下自定义音色明确返回 503；未做付费调用 |
| mock 任务动作：任务重试/取消 | 2（矩阵 #74/#75） | 已原生实现并部署 | 仅更新 Mock runtime state，不触发 Worker/供应商；缺登录态调用证据 |

final-edit 读取和草稿保存已在 FastAPI 原生实现并随 `dd76d16` 部署：GET owner-scoped 聚合确认视频/静帧、音轨、草稿及导出校验；PUT 校验并归一化片段/音轨后持久化。覆盖矩阵 #98/#99 已由 501 转为 native，相关接口与越权测试通过；终剪浏览器真实数据操作仍待演示账号验收。

导出创建也已在 FastAPI 原生接入并随 `dd76d16` 部署：FastAPI 校验导出包/final-edit 后只写 queued 记录，Worker 以配置的轮询间隔消费并调用既有 FFmpeg 执行体；worker healthcheck 检查两张队列表。API 不直接运行 FFmpeg；本地契约测试通过，真实导出任务尚未执行。

## 5. 有意行为差异（安全收紧，均已声明并记录于各组 spec）

1. `/storage` 强制 HMAC 验签（Node L12926 裸读任意 key）
2. 滑块验证码非数字坐标 fail-closed（Node `NaN>8` 恒 False 放行）
3. 口型入队缺 storage_key 时透传错误（Node 在请求线程内下载转存）
4. 确认远端临时链接 409/4092（Node 500）
5. SMS 未配置启动期警告+mock 降级（Node 发送期抛错）

## 6. 尚待完成的生产验收项

1. 24-48 小时观察期：API 5xx、队列积压、验证码表增长；完成后再更新观察结论。
2. 演示账号登录后的项目列表/创建/详情/删除生产链路（本轮缺演示凭据，smoke 为 SKIP）。
3. 生产 SMS 真实供应商凭据与真实发送验证；当前 `/api/health` 报告 `smsProvider=mock`，不可视为生产短信已就绪。
4. Worker 消费真实生成任务并以 `queued → running → succeeded` 闭环；本轮未触发付费任务。
5. RAG 真实检索请求，以及图片/音频/视频/Range/导出媒体人工验收。
6. 未执行 `docker build --check`；四镜像的实际 Docker build 已通过，此项属于额外静态检查，不影响镜像运行证据。

## 7. 交接物索引

- 代码：`api-service/`（FastAPI 唯一 HTTP 后端）、`Dockerfile.worker` + `server/`（Worker 执行体）
- 部署：`docker-compose.yml`（标准五服务）、[`docker-compose.release.yml`](../docker-compose.release.yml)（外部 DB/卷/网络的隔离发布编排）、`nginx.conf`（全指 :8000）、`.env.production.example`
- 门禁：`scripts/assert-fastapi-only.mjs`（七类禁用项）、`scripts/fastapi-only-smoke.mjs`（运行时冒烟）、`api-service/tests/test_no_node_dependencies.py` + `test_route_coverage_matrix.py`（防回退常驻测试）
- 手册：`docs/production-switch-runbook.md`（14 步 + 回滚预案 R1-R3）
- 规格：`api-service/docs/` 七份组规格（全部含 Node 行号对照、fixture 再生成命令、差异声明）

## 8. 本轮云端发布证据

- 远端工作树未覆盖：生产 `main`=`c6111c7`，54 项 dirty 状态与缺失文件均保留。
- Release 目录：`/opt/projects/projectdream/releases/20261019-fastapi-only/projectdream-release-20261019`；镜像包上传前后 SHA-256 一致：`a8dd0c008ae0249b1af11660249a6a3aa28ab98a816430f07167b65415e0152f`。
- 数据库备份：`/opt/projects/projectdream/backup/db-pre-fastapi-switch-20261019-b2097e4d.sql.gz`，2,106,676 bytes，46 tables，`gzip -t` 通过；SHA-256 `1a91cafe047f32342415081650bd0db7b7766c7c5347616e71e38183c755efc4`。
- 迁移：0001-0004 成功依序执行，验证表 `agent_runs`、`agent_pipeline_checkpoints`、`agent_paid_submissions`、`agent_run_leases`、`auth_captcha_sessions` 均存在。
- 当前服务：mysql/api/worker-node/rag/frontend healthy；原 backend/worker exited 且保留；宿主监听仅 frontend `:8002`，无 `:3001`。
- 公网 smoke：`node scripts/fastapi-only-smoke.mjs --base-url http://<YOUR_SERVER_IP>:8002 --public --check-compose`，两轮结果均 PASS 4 / SKIP 1 / FAIL 0；演示账号链路因凭据未提供跳过。
- 本地验证：`npm test` 975/975；`python -m pytest api-service/tests -q` 1003 passed；`node --test scripts/fastapi-only-smoke.test.mjs scripts/deploy-production.test.mjs scripts/runbook-consistency.test.mjs` 32/32；FastAPI-only 门禁 0 违规；四个镜像 build 成功。

## 9. 2026-10-19 本地优化同步

- 同步范围：仅重建并滚动更新 `frontend` 与 `worker-node`。API、RAG、MySQL、数据库 schema 和持久卷均未更改；没有执行迁移、短信发送或付费生成。旧镜像分别保留为 `projectdream-frontend:rollback-sync-20261019` 和 `projectdream-worker-node:rollback-sync-20261019`。
- 独立交付目录：`/opt/projects/projectdream/releases/20261019-frontend-worker-sync/`；镜像包 `images.tar`，传输前后 SHA-256 一致：`5f71ca7018edd25e5c914fd76a20331dea5d36aa19cdfb7e5beda0b6b813fe29`。生产 release Compose 源文件未覆盖。
- 发布命令使用既有 release Compose，限定 `up -d --no-build --force-recreate worker-node frontend`；命令提示旧 backend/worker orphan，但未加 `--remove-orphans`，旧容器/数据未删除。
- 发布后 `api`、`worker-node`、`rag`、`frontend`、`mysql` 均 running/healthy；新 frontend/worker-node restart count=0。公网 `/`、`/nginx-health`、`/api/health` 均 HTTP 200；公网 smoke PASS 4 / SKIP 1 / FAIL 0，SKIP 仍是缺少演示账号凭据。
- 新首页返回的 `index.html` 与本地生产构建逐字一致，静态资源可访问。`generation_jobs` 只读计数为 failed=58、success=403，无 queued/running；未触发 Worker 付费任务。全量本地验证：`npm test` 975/975、`npm run build` 通过、FastAPI pytest 1003/1003、`docker compose --env-file .env.production config --quiet` 通过。
- 未闭环项保持不变：生产 24-48 小时观察、演示账号登录 CRUD、真实 SMS 凭据/发送、真实供应商 Worker 生成及 RAG/媒体人工验收仍需后续完成。

## 10. 2026-10-20 P74 发布闭环

- Git：提交 `dd76d16`（`feat: complete FastAPI 501 route migration`）已推送 `gitee/main`；远端 `ls-remote` 与本机 HEAD 一致。
- 发布隔离：新 release `/opt/projects/projectdream/releases/20261020-fastapi-501-closure`，由已推送提交构造 734 个文件的运行源码白名单；未覆盖 dirty 主 checkout 和 10/19 release。源码包两端 SHA-256 `81c03f471cc73a415bc3fac8c9c6408921acaffa483fc98a3760e955059980b4`。
- 镜像：API、Worker、RAG、Frontend 四镜像在本机逐个构建、标记 `release-20261020` 后导入云端；均为 `linux/amd64`，镜像 config digest 分别为 `42a9782b4ba35bd9e47a21a8b71cc14703329db175f145a779e181c8c5ae74e8`、`2f9b0984af83dc91928610f45a25cadc4e071dc89fcc338b1c68a37d213be5cb`、`21be41de6f7a7fac974916a941eeba516a1655c519c260cfe41d5726b3a16445`、`24716827ab98903bc24fec0f7dfd3d883c4d12f9bb8be4ff41fc37ae5392c5a0`。云主机没有 Gitee SSH key，因此采用镜像包导入；未触发云端构建。
- 数据保护：发布前备份 `/opt/projects/projectdream/backup/projectdream-pre-dd76d16-20261020.sql.gz`，2,110,042 bytes、mode 600、`gzip -t` 通过、SHA-256 `4e6201c9525e132a84915ae35aa995b7331fcb45ad57ca25acaf7226098ed47d`。本轮无 schema 变更、无迁移、无卷操作、无队列任务和真实付费生成。
- 运行时：API、RAG、Worker、Frontend 均 `running/healthy`、restart count 0；MySQL 既有容器 healthy；公网 `:3001` 无监听；Nginx `-t` 成功；`/ready` mysql=true、`/`/`/nginx-health`/`/api/health` 均通过。
- 黑盒与页面：生产 smoke `PASS 4 / SKIP 1 / FAIL 0`，未登录 TTS 原生路由返回 401，未触发生成；SKIP 是演示账号登录 CRUD（没有账号凭据）。首页 JS/CSS 哈希与本地 build 一致、5 张关键首页图片 HTTP 200；390px 浏览器视口无横向溢出。
- 本轮验证：`pytest` 1100 passed；`npm test` 975/975；类型检查及 Vite build 通过；FastAPI-only 门禁 0 违规；部署/smoke/runbook 定向测试 49/49。生产已配置 DashScope 与 COS 凭据，但真实调用可能计费；未获得明确的单次计费测试授权，本轮未发起。真实音频产出/回读、SMS 发送、登录态 CRUD、真实队列执行与 24-48h 观察仍未验收，不计为本轮闭环。
