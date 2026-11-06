# FastAPI-Only 目标架构决策记录（ADR）

> 依据：`.trae/specs/retire-node-http-api/spec.md` · 清单：`docs/node-retirement-inventory.md` · 2026-10-17
>
> 切流顺序已经用户确认：鉴权 → 媒体/存储 → 剧本/分镜 → 项目/资产 → 生成任务 → 运维端点 → 消除代理。

## 目标架构

```
浏览器 → Nginx → FastAPI :8000 → MySQL / Milvus / COS / 外部 AI
后台：Node Worker（独立容器，无端口暴露）→ 直接读写 MySQL 任务表与媒体存储
      （可选）Python Worker → 共享领域服务（同一任务表）
禁止链路：FastAPI→Node 代理、Nginx→backend:3001、前端→:3001、Worker→Node HTTP
```

## 决策 1：共享任务表即队列（生成链路迁移策略）

**决策**：AI/付费生成的执行体留在 Node Worker，只迁移 API 面。FastAPI 复刻各 generate 端点的「鉴权 + 校验 + request_json 快照构造 + INSERT generation_jobs」，Node Worker 按现有轮询（BACKGROUND_QUEUE_POLL_INTERVAL_MS）直接消费任务表执行，状态经数据库回写。

**理由**：供应商调用/重试/媒体落盘逻辑在 Worker 内已稳定运行且不在迁移目标内（任务书允许 Node Worker 保留）；复刻执行体是无收益风险。**边界**：禁止 FastAPI 请求线程内同步执行生成；禁止 Worker 发起任何 Node HTTP 调用。

## 决策 2：captcha 全链路 Python 化

**决策**：挑战/验证/token 会话落 MySQL `auth_captcha_sessions` 表（迁移 0004，多实例可用）；拼图 SVG 生成与 HMAC 签名在 FastAPI 复刻（对照 `server/services/auth-captcha.mjs` 逐行为）；一次性消费与过期语义与 Node 一致。

**理由**：任务书要求「验证码状态不能只放 Node 进程内存」；等 Node 侧改造会拉长依赖链。**切换风险（已知）**：切流窗口内进行中的 Node 内存会话作废，用户需刷新一次——灰度窗口期记录为已知影响。

## 决策 3：SMS provider adapter

**决策**：`api-service/app/sms/` 三 provider（tencent 官方 SDK `tencentcloud-sdk-python-sms` / aliyun HTTP API / mock+devCode）。凭据仅从环境变量（SMS_*），无凭据或显式 mock 时回退 devCode（保持现状行为）。Node 侧发码逻辑不调用。

## 决策 4：frameCharacterContext Python 复刻

**决策**：`resolveFrameCharacterContext` 及依赖迁入 `api-service/app/domain/`，验收 = 同批分镜 fixture（无角色/单角色/声音角色/画外音/缺定妆图等形态）Node 与 Python 输出逐字段一致；随后单条 GET storyboard 原生化，废除固定代理。

## 决策 5：不引入 Redis

**决策**：captcha 会话用 MySQL（决策 2）、队列用 generation_jobs 表、锁用已有租约实现（migrations/0003）。

**理由**：每 run 写入频次低，MySQL 承载力足够（阶段 2 已论证）；新增 Redis 引入部署/备份/故障面成本，除非压测证明不足否则不加。

## 决策 6：Node Worker 保留边界与镜像拆分

**决策**：Node Worker 保留（`APP_RUNTIME_ROLE=worker`），compose 服务改名 `worker-node`：无 ports 暴露、无 Nginx 代理、无 healthcheck 依赖 API。镜像拆分：API 镜像纯 Python（不含 `server/index.mjs` 与 Node 运行时）；Worker 镜像保留 Node。删除 `Dockerfile.backend` 的 API 角色。

**状态（第五阶段已落地）**：compose 删除 `backend` 服务；`worker` 改名 `worker-node`（build 改用 `Dockerfile.worker`，由 `Dockerfile.backend` git mv 而来并删除 `EXPOSE 3001`）；`api` 服务解除 depends_on backend 并挂共享 `runtime_data` 卷，mock-assets 占位图经只读 bind mount + `MOCK_ASSET_IMAGE_PATH` 提供；`frontend` 改 depends_on api。Nginx 四路媒体切 `api:8000`。`scripts/deploy-production.sh` 仍按旧服务名 `backend`/`worker` 操作，服务名清单待第六阶段同步。健康探针契约（补充说明）：FastAPI 注册 `GET /health`（存活）与 `GET /ready`（就绪，仅探 MySQL），compose `api` healthcheck 探 `/ready`；探针不经 Nginx 暴露公网，且不新增就绪探针别名（所有消费者统一使用 `/ready`）。

## 决策 7：媒体服务归属

**决策**：`/generated`、`/storage`、`/mock`、`/mock-assets` 四个 Nginx 路改指 FastAPI；FastAPI `media service` 提供本地文件流（带 owner 权限校验——Node 现状 /storage 无签名校验，迁移时补齐为行为增强并记录）与 COS 代理/预签名；`OBJECT_STORAGE_*` 指向 FastAPI。所有媒体 URL 由 FastAPI 产出。

**状态（第五阶段已落地）**：`nginx.conf` 四路媒体 `proxy_pass` 已从 `backend:3001` 切到 `http://api:8000`；api 服务与 worker-node 共享 `runtime_data:/app/.codex-runtime` 卷，媒体目录环境变量沿用 api-service/app/config.py 默认值（相对 cwd=/app 解析到卷内）。

## 决策 8：flag 生命周期（已于第四阶段删除）

**决策**：迁移期保留 `API_NATIVE_*` 作为切流/回滚工具（新增 `API_NATIVE_AUTH_EXTENDED` 等）；第四阶段（消除代理）全部删除——**已删除（第四阶段，2026-10-19）**：8 个 `API_NATIVE_*` flag、`node_upstream_url`、`node_readiness_timeout_seconds`、`proxy_timeout_seconds` 配置与 `proxy_api` 函数均已移除，各组路由恒为原生实现；静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归（最终态配置残留即启动失败（快速失败优于静默回退）。

## 决策 9：悬空调用处置

49 个前端调用函数（market/jianying/recovery 等）经兜底代理得 404，属历史残留：不在第三阶段迁移范围；第四阶段消除代理时统一改为显式 501/4040 envelope（比 Node 404 更明确），第六阶段从前端清理。
