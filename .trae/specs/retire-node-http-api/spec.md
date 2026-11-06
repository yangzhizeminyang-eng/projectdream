# FastAPI-Only：彻底移除 Node HTTP API Spec

> change-id: `retire-node-http-api` · 2026-10-17
>
> 前置：`.trae/specs/upgrade-agent-backend/`（阶段 0-7.5 已完成：四组兼容加固、546 项 pytest、四份组规格文档、5 个 flag、下线门禁底稿）。本 spec 是其终局阶段——从「渐进迁移 + flag 回退」收敛到「FastAPI 为唯一 HTTP API」。

## Why

当前 FastAPI 已接管约 28 条核心路由并经四组兼容加固（546 项测试零回归），但 Node HTTP API 仍是生产链路的一部分：FastAPI 兜底代理 + 5 个 `API_NATIVE_*` 开关 + Nginx 四个媒体路（/generated、/storage、/mock、/mock-assets）直指 `backend:3001` + AI 生成链路未入队迁移 + captcha/SMS 在 Node。本 spec 定义彻底退役 Node HTTP API 的可验证、可回滚路径——最终 Node 仅作为异步 Worker 保留（不监听业务 HTTP、不被 Nginx 代理、不作为 fallback）。

## 核心架构决策（定调，避免伪迁移）

1. **共享任务表即队列**：AI/付费生成的执行体**留在 Node Worker**（不迁移供应商调用逻辑）。迁移对象是 API 面：FastAPI 复刻各 generate 端点的「校验 + request_json 快照构造 + INSERT generation_jobs」，Node Worker 按现有轮询直接消费任务表——**Worker 全程不经 HTTP 调用 Node API**。
2. **captcha 全链路 Python 化（不等 Node 改造）**：挑战/验证/token 会话落 MySQL `auth_captcha_sessions` 表（多实例可用，满足"不能只放 Node 内存"）；拼图 SVG 生成与 HMAC 签名在 FastAPI 复刻；切换后前端全走 FastAPI captcha 链路。
3. **SMS provider adapter**：`tencentcloud-sdk-python-sms` 优先，无 SDK 供应商走官方 HTTP API；统一 provider adapter（腾讯/阿里/mock 三实现，保留 devCode 语义）。
4. **frameCharacterContext Python 复刻**：`resolveFrameCharacterContext` 及依赖（数百行文本启发式）迁入 `api-service/app/domain/`，以「同批分镜 fixture 两侧输出一致」的对照测试锁定——单条 GET storyboard 不再保留任何回退。
5. **不引入 Redis**：captcha 会话用 MySQL、队列用 generation_jobs 表、锁用已有租约实现（阶段 2 已论证）。除非压测证明 MySQL 方案不足，否则不新增基础设施。
6. **诚实红线**：任何端点未完成 FastAPI 实现前，允许显式 501/503 + 缺口记录，**不允许保留 Node fallback 冒充完成**；最终报告按任务书九条硬条件 YES/NO 判定，任一不满足即报「Node API 尚未下线」。

## What Changes

- 第一阶段：全仓扫描产出 `docs/node-retirement-inventory.md`（Node 全部路由 × 调用方、FastAPI 路由 native/proxy/fallback 分类、Node 运行时依赖清单、迁移矩阵）。
- 第二阶段：目标架构决策记录（含不引入 Redis 论证、Node Worker 保留边界）。
- 第三阶段按组迁移（每组：实现 → 测试 → 切流 → 观察）：
  - 鉴权组剩余：captcha 生成/校验/会话（MySQL 化）、send-code、register、login（短信码）、reset-password、logout/会话刷新、SMS adapter。
  - 项目/资产组剩余：资产画布（asset_nodes）、角色一致性锁定、版本升级 409、项目删除/封面/生命周期；媒体 URL 全部由 FastAPI media service 产出。
  - 剧本/分镜组剩余：**frameCharacterContext Python 复刻** + 单条 GET 原生化（废除固定代理）、各 generate 端点入队化、删除/拆分/承接/两帧优化。
  - 生成任务组剩余：全部 generate 入队端点（视频/音频/口型/资产节点图/静帧）、视频/图片确认、成本台账读接口。
  - 媒体/存储组：/generated、/storage、/mock、/mock-assets 四个 Nginx 路改指 FastAPI；FastAPI 媒体服务（本地文件流 + COS 代理/预签名 + 权限校验）；导出与成片链路确认 Worker 承接边界。
  - 运维端点处置：逐条迁移或显式 501/503 + 缺口记录。
- 第四阶段：删除 `proxy_api`/Node upstream client/Node readiness 检查/全部 `API_NATIVE_*` flag/`NODE_UPSTREAM_URL` 相关配置与代理测试。
- 第五阶段：Compose 删除 backend 服务（Node Worker 拆为独立服务定义）、Nginx 四个媒体路改指 FastAPI、镜像不含 `server/index.mjs`（Worker 镜像除外）。
- 第六阶段：前端/脚本/文档清理（禁止 3001 引用、Node API 配置删除、部署文档更新）。
- 第七阶段：静态依赖扫描测试（红灯先行）、FastAPI 路由覆盖测试、黑盒契约测试、Worker 独立性测试。
- 第八阶段：`scripts/assert-fastapi-only.mjs`（CI/部署前硬门禁，失败非 0 退出并打印文件行号）+ `scripts/fastapi-only-smoke.mjs`。
- 第九/十阶段：生产切换顺序执行 + `docs/node-retirement-final-report.md`（按九条硬条件 YES/NO 判定）。**需云端操作，本机产出切换手册与脚本。**

**BREAKING**：最终态删除 `NODE_UPSTREAM_URL`、`API_NATIVE_*`、Node readiness 依赖——部署配置需同步更新，未更新即启动失败（快速失败优于静默回退）。

## Impact

- Affected specs: `.trae/specs/upgrade-agent-backend/`（其产物——四份组规格、兼容测试、flag——是本 spec 第三阶段的输入；flag 在第四阶段删除）。
- Affected code: `api-service/app/**`（新增 auth/captcha、sms、domain/frame_character、media、tasks_enqueue 模块；删除 proxy/flag）、`nginx.conf`、`docker-compose.yml`、`Dockerfile.backend`（拆分为 Worker 镜像）、`src/**`（无 3001 引用清理）、`scripts/**`（新增两个门禁脚本）、`.env*`、README。
- 不可触碰：用户未提交改动优先；生产数据/媒体/volume 零删除。
- 诚实边界：本机可完成第三至八阶段的实现与测试；第九阶段生产切换的每一步需用户在云端执行部署脚本（spec 产出逐步操作手册）；frameCharacterContext 复刻与 captcha SVG 复刻是最大单体工程，按 fixture 对照验收。

## ADDED Requirements

### Requirement: 依赖清单先行（第一阶段）

在任何删除动作前，系统 SHALL 产出 `docs/node-retirement-inventory.md`：Node 全部路由（方法/参数/请求体/响应/状态码/鉴权/调用方）、FastAPI 路由分类（native/proxy/fallback/未实现/仅测试）、Node 运行时依赖全量清单、迁移矩阵（含验收测试列）。

#### Scenario: 矩阵覆盖全部路由
- **WHEN** 枚举 `server/index.mjs` 全部路由与 FastAPI 全部路由并交叉比对
- **THEN** 每条 Node 路由在矩阵中有唯一行，标注「已原生 / 待迁移 / 显式 501 / Node Worker 保留」之一

### Requirement: 鉴权组全量 Python 化（第三阶段-1）

系统 SHALL 在 FastAPI 实现 captcha 生成/校验（MySQL 会话）、send-code（SMS provider adapter）、register、login（短信码）、reset-password、logout/会话刷新，保持既有错误码（4001-4010）与 envelope。验证码会话 MUST NOT 依赖 Node 进程内存。

#### Scenario: 验证码全链路走 FastAPI
- **WHEN** 前端依次调用 captcha → captcha/verify → send-code → register
- **THEN** 全部请求由 FastAPI 原生处理，会话状态持久化于 MySQL，无任何 Node 参与

### Requirement: frameCharacterContext 复刻与 GET 原生化（第三阶段-3）

系统 SHALL 将 `resolveFrameCharacterContext` 及依赖复刻为 Python 领域模块，单条 GET storyboard 由 FastAPI 原生返回该字段，并以「同批分镜 fixture 两侧输出一致」对照测试验收；废除固定代理。

#### Scenario: 两侧输出一致
- **WHEN** 同一批分镜 fixture（含无角色/提及单角色/声音角色/画外音/缺定妆图等形态）分别输入 Node 与 Python 实现
- **THEN** ready/characterFree/primaryCharacterId/characters/blockers 逐字段一致

### Requirement: 生成端点入队化（第三阶段-4）

全部 generate/付费入队端点 SHALL 由 FastAPI 原生实现「鉴权 + 校验 + request_json 快照构造 + INSERT generation_jobs」，Node Worker 直接消费任务表执行；禁止 FastAPI 请求线程内同步执行生成；入队幂等键沿用稳定业务范围。

#### Scenario: FastAPI 入队后 Worker 消费
- **WHEN** FastAPI 接收视频生成请求并入库
- **THEN** Node Worker 无需任何 HTTP 调用即可认领执行，任务状态经数据库回写

### Requirement: 媒体服务 FastAPI 化（第三阶段-5）

Nginx 的 /generated、/storage、/mock、/mock-assets SHALL 改指 FastAPI；FastAPI 媒体服务提供本地文件流（带权限校验）与 COS 代理/预签名；媒体 URL 统一由 FastAPI media service 产出。

#### Scenario: 媒体访问不依赖 Node
- **WHEN** 停止 Node 全部服务后请求图片/音频/视频/导出文件
- **THEN** 媒体正常返回（本地/COS 均可），越权访问被拒绝

### Requirement: 消除代理与回退（第四阶段）

业务组全部迁移后，系统 SHALL 删除 proxy_api、Node upstream client、Node readiness 检查、全部 `API_NATIVE_*`、`NODE_UPSTREAM_URL` 及其测试；延期接口显式 501/503 并记录缺口。

#### Scenario: 配置残留即失败
- **WHEN** 仓库中搜索 `NODE_UPSTREAM_URL`、`API_NATIVE_*`、`proxy_pass http://backend:3001`
- **THEN** 生产链路（api-service、nginx.conf、compose、前端、脚本、.env 模板）零命中

### Requirement: 硬门禁脚本（第八阶段）

`scripts/assert-fastapi-only.mjs` SHALL 在 CI 与部署前执行，检查 Compose/Nginx/环境变量/FastAPI/前端/Worker/镜像入口七类禁用项，失败打印文件与行号并以非 0 退出；`scripts/fastapi-only-smoke.mjs` SHALL 验证健康检查、关键 API、停 Node 后主流程与最小生成链路。

#### Scenario: 门禁拦截残留
- **WHEN** Compose 中重新出现 backend Node 服务
- **THEN** assert-fastapi-only 以非 0 退出并指出 compose 文件行号

### Requirement: 最终报告诚实判定（第十阶段）

`docs/node-retirement-final-report.md` SHALL 按九条硬条件逐项 YES/NO；任一不满足 MUST 报告「Node API 尚未下线」并列出阻塞项，不得以「准备完成」「开关已打开」「代理暂时保留」代替。

#### Scenario: 阻塞项如实报告
- **WHEN** 停止 Node 后黑盒测试任一主流程失败
- **THEN** 最终报告判定 NO 并列出该流程与阻塞原因

## 现实约束与依赖（如实声明）

1. **工程量大头**：frameCharacterContext 复刻、captcha SVG/会话、约 15-20 个 generate 入队端点的快照构造复刻、媒体服务。每块都有明确的对照验收方式，不接受「写完即完成」。
2. **云端依赖**：每组切流观察、生产切换顺序（第九阶段）、容器验收需用户执行；本机产出脚本与逐步手册。
3. **顺序纪律**：inventory 未完成不删任何东西；每组未过测试不切流；第九阶段 14 步顺序不可跳。
4. **回滚**：每组迁移保持独立提交；flag 在迁移完成前是回滚工具（第四阶段才删除）；生产切换前必须有 DB 备份。
