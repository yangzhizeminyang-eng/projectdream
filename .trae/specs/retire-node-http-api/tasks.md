# Tasks

## 第一阶段：依赖清单与迁移矩阵

- [x] Task 1.1: 全仓扫描产出 `docs/node-retirement-inventory.md`
  - [x] SubTask 1.1.1: 枚举 server/index.mjs 全部路由（83 个 pathname 模式 / 约 118 条 method 分支，16 前缀分节）
  - [x] SubTask 1.1.2: 枚举 FastAPI 全部路由并标注（32 装饰器/35 条：native 30 + fixed-proxy 2 分支 + 兜底代理 1）
  - [x] SubTask 1.1.3: Node 运行时依赖清单（逐文件:行号：config 6 flag、compose、nginx 四媒体路、Dockerfile.backend、vite.config、.env 模板、15+ 脚本）
  - [x] SubTask 1.1.4: 迁移矩阵（七组全覆盖；已原生 31 / 固定代理 2 / 待迁移约 85）
- [ ] Task 1.2: 风险清单与切流顺序确认（用户确认后进入第三阶段）

## 第二阶段：目标架构决策记录

- [x] Task 2.1: 架构决策记录落盘（docs/fastapi-only-architecture-decision.md：共享任务表即队列、captcha MySQL 化、SMS adapter 选型、frameCharacterContext 复刻、不引入 Redis 论证、Node Worker 保留边界与镜像拆分方案）

## 第三阶段：按业务组迁移（顺序执行，每组独立验收）

- [x] Task 3.1 鉴权组剩余（最大块）
  - [x] 3.1.1 迁移 0004_auth_captcha_sessions（前向/回滚）+ app/auth_captcha.py（SVG 拼图逐字符复刻 + HMAC 签名 + verify）
  - [x] 3.1.2 captcha/verify + captchaToken 一次性消费（MySQL 原子 UPDATE，两级标记 verified+consumed_at）
  - [x] 3.1.3 SMS provider adapter（tencent SDK 3.0.1302 延迟导入 / mock+devCode；凭据缺失启动期警告自动降级 mock）
  - [x] 3.1.4 send-code / register / login（短信码）/ reset-password 原生化（API_NATIVE_AUTH_EXTENDED flag）；logout/refresh Node 无此路由如实跳过
  - [x] 3.1.5 tests/test_auth_extended_compat.py 59 用例；全量 605 passed 零回归；4 项 Node↔Python 差异记录（含 Node NaN 放行安全洞收紧）
- [x] Task 3.2 项目/资产组剩余
  - [x] 3.2.1 资产画布 9 条迁移（asset-canvas 读时自愈链、asset_nodes CRUD/分组/relink-scene/hydrate-prompt、images GET/generate（3.4 悬空项已接手，幂等复用模式）、asset-node-images confirm 六类门禁+identity lock+superseded、vision-check）
  - [x] 3.2.2 角色一致性锁定/版本升级 409 七类家族复刻（CHARACTER_ASSET_PACK_REQUIRED 等）；项目删除（confirmName→4001/4090，级联靠 FK CASCADE = Node 全部删除范围）；rename syncNameReferences 事务 + rename-preview 4009；export-package 复刻（草稿禁用/order/blockingIssues）
  - [x] 3.2.3 角色库 11 条（characters CRUD/detail/rename/feature/images/confirm/voice-cast/voice-recommendations/voice-binding 性别冲突 4001/reference-audio ≤15MB）
  - [x] 3.2.4 媒体 URL 由 media_urls 产出（mappers video_asset_row 模式，用户改动已兼容）
  - [x] 提示词 fixture：generate_asset_node_fixtures.mjs Node 直调 15 服务模块 → 85 case 逐字段全等（提示词/快照/门禁/视图/改名/音色）；tests 170 项新增；995 passed 零回归
  - [ ] 3.2.5（待 Eval 样本）voice-preview / generate-profile / characters-generate 三条 AI 依赖端点保持兜底代理（spec §9.3 记录）
- [x] Task 3.3 剧本/分镜组剩余
  - [x] 3.3.1 frameCharacterContext Python 复刻（domain/frame_character.py）：Node fixture 脚本（tests/fixtures/generate_frame_fixtures.mjs 直连真实实现）10 形态 → frame_character_fixtures.json → 14 项 pytest 逐字段一次全过；再生成命令记录于 script-group-spec.md
  - [x] 3.3.2 单条 GET storyboard 原生化（废除固定代理）：db.get_storyboard_detail + list_frame_characters + domain 组装；PUT 入口同步改走 detail
  - [x] 3.3.3 generate 入队/同步 AI 复刻：9 个同步 AI 端点（scene script/storyboards、story-bible、season-structure、keyframes、split×2、dialogue、frame-prompt、continuity——经 app/ai_provider.py async httpx 复刻 Node provider 错误文案与 JSON 容错）+ 1 个任务入队（shots/{id}/images/generate → enqueueFrameImageJob 复刻：三道门禁→一致性提示词→generation_jobs 快照 + active 幂等复用）
  - [x] 3.3.4 Node 4011/409 错误形态与 5 项怪癖逐条对照（含全局 catch 500 覆盖、mock 生成器边界、FRAME_PROVIDER=trae-url 部署注意项）
  - [x] 3.3.5 tests/test_script_native_compat.py + test_frame_character_fixtures.py 48 项；734 passed 零回归；RAG 对接当前等价降级（与 Node degraded 同语义，rag_adapter 实连列入后续）
  - [ ] 3.3.6（待云端）storyboards/generate 实连 rag-service 验证（本机 mock 口径已锁定）
- [x] Task 3.4 生成任务组剩余
  - [x] 3.4.1 视频生成/口型同步入队端点迁移（API_NATIVE_GENERATION）：快照构建器经 generate_video_fixtures.mjs Node 直调 51 case 期望 JSON 逐字段锁定；幂等 = 同 project+type+source queued/running 复用；条件键 undefined 语义一致
  - [x] 3.4.2 video confirm 写路由迁移（签名 URL→4093/本地缺失→4091/事务归档+确认+回写分镜+质量报告）；images confirm 3.3 已做；L14677 audio/generate 为同步直写形态不迁移（记录）；characters/character-images 归 3.2
  - [x] 3.4.3 成本台账/市场审计：**Node 无路由（悬空 404）→ 不迁移**，悬空处置留第四阶段（ADR 决策 9）；asset-nodes/images/generate 依赖 15 个未复刻提示词族函数 → 悬空留 3.2 资产画布
  - [x] tests/test_generation_native_compat.py + test_generation_video_enqueue_compat.py 共 91 项（57 fixture/内部函数对照 + 34 端点）；825 passed 零回归；4 项 Node 怪癖记录（含 mouth 入队请求线程下载转存的收紧）
  - [ ] 3.4.4（待云端）真实视频/口型入队后 Worker 消费端到端验证
- [x] Task 3.5 媒体/存储组
  - [x] 3.5.1 FastAPI 媒体服务（app/media_service.py）：/generated、/storage、/mock、/mock-assets 四路——本地流式文件（64KiB 分片）、Range 单区间同语义复刻（含 Node bytes=-0 怪癖）、MIME 推断、路径穿越 22 例全拒（点段守卫 + 3 轮 decode + resolve 前缀 + re.ASCII 白名单）
  - [x] 3.5.2 权限：/storage 强制无状态验签（HMAC 与 Node verifySignedUrl 同构；Node 现状裸读为安全洞，有意收紧已声明）；generated/mock/mock-assets 按 Node 现状公开（img/video 标签无法带 Authorization 头）；COS 模式同验签
  - [x] 3.5.3 导出链路边界：export 归 generated 媒体服务（Range 支持），任务状态读接口已有原生路由；真实媒体文件验收待云端/本地 runtime 数据（第五阶段 compose 挂卷后）
  - [x] OBJECT_STORAGE_PUBLIC_BASE_URL 默认 3001→8000；.env.example 同步；compose 仅加注释；API_NATIVE_MEDIA flag（false→501 过渡态）；tests/test_media_service_compat.py 81 例；686 passed 零回归
- [x] Task 3.6 运维端点处置
  - [x] 3.6.1 历史阶段验收基线：当时迁移 14 条、显式 501 为 20 条；当前状态以 `api-service/docs/ops-endpoints-spec.md` 与 `docs/node-retirement-final-report.md` 为准（剩余 13 条显式 501，原生 105 / 501 13 / 4040 0）
  - [x] 3.6.2 **兜底代理收口**：/api/{path:path} 兜底改 4040 处理器（逐字对齐 Node L18352），**仍走兜底代理的默认路径剩余 0 条**；proxy_api 仅存于 flag=false 回退分支内部
  - [x] 3.6.3 tests/test_ops_endpoints_compat.py 19 项（含兜底收口矩阵门禁）；1014 passed 零回归

## 第四阶段：消除代理与回退（Task 3.x 全部完成后）

- [x] Task 4.1: 静态扫描测试先行（红灯）：tests/test_no_node_dependencies.py——禁 NODE_UPSTREAM_URL/API_NATIVE_*/proxy_api/proxy_pass backend:3001/3001 引用/node.invalid/server/index.mjs 生产引用；范围 api-service/src/scripts/.env.example；src/scripts 命中条件 skip（第六阶段清理后启用）；fixture 与文档豁免白名单精确匹配（11 行）
- [x] Task 4.2: 删除完成——8 个 API_NATIVE_* flag + node_upstream_url/node_readiness_timeout_seconds/proxy_timeout_seconds + proxy_api 函数 + 70 处回退分支 + /ready Node 探活 + upstream client；project-tasks mock 语义 fixed-proxy 改显式 501/5010；媒体服务 flag-off 块删除（恒原生）
- [x] Task 4.3: 历史阶段曾有 20 条显式 501/5010 豁免且均带理由；后续迁移见当前运维端点规格（现余 13 条）；无「以后切回 Node」隐藏开关（proxy_api 已不存在）
- [x] Task 4.4: 测试清理 37 项 flag/代理用例删除，原生断言保留；pytest 978 passed + 1 skipped（扫描 src/scripts 条件延迟）零回归；config/main 静态复查 0 漏删（唯一命中为合法历史注释）；test_auth_extended_compat.py 误伤重建（pyc + spec 高保真，47 项全绿，文件头注明）

## 第五阶段：Docker / Nginx / 镜像改造

- [x] Task 5.1: Compose 删除 backend 服务；worker → worker-node（无端口、无代理、worker-healthcheck 保留）；api/frontend 解除 depends_on backend；api 挂 runtime_data 共享卷（媒体目录）+ mock 占位图只读 bind mount（MOCK_ASSET_IMAGE_PATH）；healthcheck：api→mysql(healthy)，frontend→api(healthy)
- [x] Task 5.2: Nginx 四媒体路全部切 http://api:8000；无 upstream/backend:3001 残留；超时/体积参数原值未缩水
- [x] Task 5.3: api 镜像核实纯 Python（python:3.12-slim，无 Node/无 index.mjs/无 FFmpeg 依赖）；Dockerfile.backend git mv → Dockerfile.worker（删 EXPOSE 3001）；引用断链清单已列（deploy-production.sh 等留第六阶段）
- [x] Task 5.4: .env.production.example 删 NODE_UPSTREAM_URL+2 注释；.env.production 仅删 backend:3001 注释行（未读取其余内容）；.env.example 无 Node 键
- [x] Task 5.5: 验证——compose config 通过（五服务 mysql/worker-node/api/frontend/rag，无 3001）；api/worker Dockerfile 静态验证（与云端已验证版本仅注释/EXPOSE 差异、COPY 源存在、.dockerignore 无阻断）；**docker build --check 待办**（本机 Docker Desktop engine 启动后持续 _ping 500，待人工查看 Desktop 状态或云端构建验证）

## 第六阶段：前端与脚本清理

- [x] Task 6.1: 前端/脚本/文档扫描清理（禁止 localhost:3001、127.0.0.1:3001、backend:3001）；README/部署文档更新（FastAPI 唯一 HTTP 后端 + Node Worker 非 API 声明）
  - [x] scripts/*.mjs 17 处：默认上游切 FastAPI 8000 + 文件头中文声明；run-worker/worker-healthcheck 的 server/index.mjs 引用按 Worker 保留边界保留（EXEMPT_LINES 精确豁免 4 行，漂移即重报）
  - [x] deploy-production.sh：backend 段删除、worker→worker-node、health 走 /api/health；bash -n 通过；deploy-production.test.mjs 断言同步 node --test 11/11
  - [x] README / 腾讯云部署指南：架构图重绘、FastAPI-Only 声明、防火墙删 3001、命令全部对齐新服务名
  - [x] **vite.config.ts dev 代理 3001→8000 补漏**（第四阶段扫描范围漏根级配置，属真实前端→3001 链路）；扫描范围 DEFERRED_GLOBS 纳入 vite.config.ts 防回退
  - [x] 扫描测试收口：条件 skip 改强制断言 test_deferred_scope_is_node_free；pytest **979 passed, 0 skipped**

## 第七/八阶段：测试证据与硬门禁

- [x] Task 7.1: 历史阶段覆盖基线 **native=98 / 501=20 / 4040=0**；当前运行测试动态对账 118 条 method 分支，结果 **native=105 / 501=13 / 4040=0 / worker=0 / 死路由=0**；#74/#75 mock 动作已原生迁移，501 集合双向对账
- [x] Task 7.2: 黑盒契约测试（test_e2e_blackbox.py：鉴权链 captcha→verify→send-code→register→建项目；内容链剧本→分镜→frameCharacterContext→静帧入队→任务行；媒体链签名→401→Range 206；全链 envelope 三键一致性）
- [x] Task 7.3: Worker 独立性测试（test_worker_independence.py 13 项：无 API 回环——fetch 白名单=6 供应商适配器+rag-client+downloadMediaToFile、127.0.0.1:3001 仅 object-storage.mjs 媒体 URL 默认值 1 行豁免；停 Node 可用——config/compose//ready/兜底 handler 代码级断言；回写幂等——updateGenerationJob SQL 形态 + 状态机桩二次回调/终态稳定/noop；局限：真停 Node 端到端属云端项）
- [x] Task 8.1: scripts/assert-fastapi-only.mjs（七类禁用项、fail-closed 关键文件缺失、豁免=运行时解析 pytest EXEMPT_LINES 单一事实源 + Worker 入口结构豁免；真实仓库 0 违规；node --test 13 项）
- [x] Task 8.2: scripts/fastapi-only-smoke.mjs（双目标：--exec-compose 容器内 readiness 探 /health /ready + 公网模式 4040/5010/4010 收口形状断言——探针不经公网、SPA fallback 假阳性已防护、--check-compose 静态结构检查标注、登录态临时项目 try/finally 清理；真实环境冒烟待云端；node --test 15 项）
- [x] 验收：pytest **1003 passed**（979+24）；node --test 20/20；assert-fastapi-only.mjs exit 0（0 违规 0 防护错误）——已独立复跑验证

## 第九/十阶段：生产切换与最终报告（需云端操作）

- [x] Task 9.1: 生产切换手册（docs/production-switch-runbook.md：前置检查→备份→迁移 0001-0004→构建→env 核对→Nginx→五服务滚动重启→两轮黑盒→停 Node 进程→Worker 端到端→观察期→清理→验收记录；回滚预案 R1 应用/R2 数据/R3 Nginx 三级）
- [x] Task 10.1: docs/node-retirement-final-report.md（九条硬条件：YES×5 / PENDING×3（生产切换属云端）/ YES+PENDING 混合×1；按任务书格式报告「Node API 尚未下线（生产侧）」+ 阻塞项=切换手册执行；历史显式 501 20 条已迁移 7 条，当前剩余 13 条且均带理由、有意行为差异 5 项、云端待办 6 项、交接物索引）

# Task Dependencies

- Task 1.1/1.2 → 全部后续；Task 2.1 → Task 3.x。
- Task 3.1-3.6 组间无强依赖（3.2.4 依赖 3.5.1 的媒体服务先行）；组内顺序执行。
- Task 4.x 依赖 3.1-3.6 全部完成；Task 5.x 依赖 4.x；Task 6.1 依赖 5.x；Task 7/8 与 4-6 交织（扫描测试在 4.1 红灯先行、5.x 后转绿）。
- Task 9/10 依赖 1-8 全部 + 云端配合。
