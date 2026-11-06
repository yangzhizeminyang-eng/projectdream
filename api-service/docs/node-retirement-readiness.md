# Node HTTP API 下线门禁核对底稿（阶段 7.5）


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 2026-10-17 · 基于阶段 7.1-7.4 四组迁移证据汇总 · **本底稿不含也不授权任何下线动作**
>
> 结论先行：**当前不具备 Node HTTP API 下线条件**——AI 生成链路、付费生成入队、captcha/SMS、`GET /api/storyboards/{id}`（frameCharacterContext 派生）、mock 资产动作、运维端点仍在 Node 承接。Node 的定位应从「生产 API」收敛为「内部生成/会话服务」，下线是这些能力迁完之后的长期目标。

## 1. 九项门禁逐项核对

| # | 门禁 | 状态 | 已有证据 | 缺口（云端待办） |
|---|------|------|----------|-----------------|
| 1 | 外部/内部调用方依赖扫描 | 🟡 部分 | 前端唯一入口 `src/api/*` 全部走 `/api` 前缀 → Nginx → FastAPI 网关（native/代理对前端透明）；Worker 直连 MySQL 不走 HTTP；RAG 经 `X-RAG-Internal-Token` 受控调用 | 云端核实：cron/运维脚本、Gitee CI、任何直连 3001 端口的外部调用（netstat/访问日志扫描） |
| 2 | 路由清单 100% 对照 | 🟡 部分 | Node 约 113 个 method 分支已全量枚举（阶段 0 §3.3 + 7.2/7.3/7.4 规格文档的 route map，70 条路径模式）；四组已接管路由逐条规格化 | 未接管路由的处置决策：AI 生成/付费入队/captcha/SMS/运维端点 → 保留 Node 或迁移（每条需规格化） |
| 3 | 每组契约/权限回归通过 | ✅ 本机 | 546 项 pytest（四组兼容测试 152 项 + 既有契约）；959 项 npm test 零回归 | 云端运行同版本镜像复跑 |
| 4 | 前端/Worker/脚本/RAG/运维入口真实运行验证 | 🔴 待办 | — | 云端隔离环境跑「前端全页面 → 网关 → DB」真实流量，覆盖每个 flag 组 |
| 5 | 生产灰度观察无回归 | 🔴 待办 | 5 个 flag（AUTH×2/PROJECTS/ASSETS/SCRIPT/GENERATION）全部默认 true，具备逐组灰度开关 | 灰度方案：先关 flag 走代理观察 → 逐组开 flag 观察；每窗口 ≥48h 对照错误率/延迟 |
| 6 | 回滚到 Node 代理已演练 | 🟡 本机已验 | 每个 flag 的回退透传行为均有 MockTransport 断言（body/URL/头逐项） | 云端演练：生产配置翻转 flag → 验证流量回到 Node → 翻回，全程无重启 |
| 7 | Node Worker 独立保留且健康 | 🟡 架构不变 | Worker 与 API 共镜像、`APP_RUNTIME_ROLE=worker` 区分；`worker-healthcheck.mjs` 已有 | 云端 verify：Worker healthy + 队列认领正常；**下线的是 Node 的 HTTP 角色而非 Worker** |
| 8 | Compose 健康验收 | 🟡 本机配置核对 | compose 六服务 healthcheck 齐全；`deploy-production.sh` check/verify 门禁已有 | 云端执行 verify 全绿 |
| 9 | 已验证的备份与回滚步骤 | 🟡 部分 | DB 迁移 0001-0003 均有回滚脚本；部署脚本有构建前检查与整批回滚（P66-P68） | 云端备份演练：MySQL 快照恢复 + 镜像版本回退各一次 |

## 2. Node 仍被依赖的能力清单（下线前置）

| 能力 | 依赖原因 | 迁移前置 |
|------|----------|----------|
| 滑块验证码（captcha/verify） | 会话在 Node 进程内存 Map；Python 无法消费 | `auth_captcha_sessions` 表设计已备（auth-group-spec §5.1）；**Node 侧改造需协调** |
| SMS 发码 | 腾讯/阿里 SDK 在 Node | Python SDK 引入或 Node 内部转发端点（auth-group-spec §5.2） |
| 单条 GET /api/storyboards/{id} | `frameCharacterContext` 数百行文本启发式派生（前端静帧生成页依赖） | 复刻会造成双实现漂移；候选方案：抽成独立服务或 Node 内部端点固化 |
| AI 生成链路（总纲/剧本/分镜/两帧优化/拆分/承接） | 付费模型 + 重试修复循环 + 事务重排 | Eval 样本与契约测试就绪后逐条迁移 |
| 付费生成入队（视频/音频/口型/资产节点图） | Worker/队列/供应商轮询语义 | 任务书明确 Worker 保持 Node；入队 API 可随 7.4 模式迁移 |
| mock 资产动作（task_runtime_states） | Node 原生实现，代理透传零成本 | 可长期保留代理或随任务中心重构 |
| 运维端点（/api/health、对象存储验证、媒体回填、恢复队列） | 依赖 Node 运行时角色 | 随部署架构收敛决策 |

## 3. 建议路径（不构成下线承诺）

1. **短期**：云端补齐门禁 1/4/6/8/9 的真实环境证据；5 个 flag 按组灰度，观察期数据回填本底稿。
2. **中期**：Node 改造 captcha 会话 DB 化（前置协调）→ 鉴权组剩余 6 条迁移；AI 生成链路逐条按 7.4 模式规格化 + 契约测试后迁移。
3. **长期**：Node 收敛为纯 Worker + 内部生成服务（无公网 HTTP），Nginx `/api` 全量指向 FastAPI；此时才满足「下线 Node HTTP API」的字面条件，仍需全量灰度 + 回滚演练。

## 4. 证据索引

- 四组规格：`api-service/docs/{auth,project-asset,script,generation}-group-spec.md`
- 兼容测试：`tests/test_{auth,project_asset_group,script_group,generation_group}_compat.py`（152 项）
- 全量回归：pytest 546 passed / npm test 959 passed（2026-10-17）
- flag 清单：`API_NATIVE_AUTH_CHECK_PHONE`、`API_NATIVE_AUTH_LOGIN_PASSWORD`、`API_NATIVE_PROJECTS`、`API_NATIVE_ASSETS`、`API_NATIVE_SCRIPT`、`API_NATIVE_GENERATION`
- 迁移前基线：`.trae/specs/upgrade-agent-backend/phase0-baseline-report.md`
