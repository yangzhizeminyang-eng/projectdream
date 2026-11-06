# 运维端点与其他剩余路由处置总表（阶段 3.2.5）


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 2026-10-20 · FastAPI-Only 迁移现状（P74 进行中）。基于 `docs/node-retirement-inventory.md`
> A/D 节 + `api-service/app/main.py` 现状（原生路由已包含角色生成、角色档案生成、总纲生成、项目场景草稿生成、Agent Pipeline 全部四个入口、ProductionRun 列表/详情及 4 条写侧、final-edit 读取/草稿保存、导出任务入队、TTS 试听与生成；当前无路由级显式 501）
> 全量对照 `server/index.mjs` 的 83 个 pathname 模式复核；任务中心 Mock retry/cancel 已复刻到 `task_runtime_states`，当前不再内联返回 501。
> `OPS_FALLBACK_501_ROUTES` 当前为空；TTS 的真实服务商未就绪按受控 503/502 返回，不作为 501 豁免。

## 1. 处置总表（数字）

| 处置方式 | 条数 | 说明 |
|----------|------|------|
| **原生实现** | **36** | 原迁移 14 项 + 角色相关 2 项 + 总纲生成 1 项 + 项目场景草稿生成 1 项 + Agent Pipeline 列表/详情/阶段动作/start/decision 5 项 + ProductionRun 列表/详情与写侧 6 项 + final-edit 读取/草稿保存 2 项 + export 创建 1 项 + task-center Mock retry/cancel 2 项 + TTS 试听/生成 2 项；具体覆盖以 `test_route_coverage_matrix.py` 为准 |
| **显式 501（code 5010）+ 缺口记录** | **0** | `OPS_FALLBACK_501_ROUTES` 为空；功能子分支的前置条件按 400/409/503 返回，不能以伪 501 代替 |
| **Worker 内部无需 HTTP** | **0（HTTP）** | 恢复队列 / 对象存储验证 / 媒体回填：Grep 核实 `server/index.mjs` 无对应路由（恢复队列仅为 Worker 进程内调用 `recoverGenerationJobs`/`resumeExportJobs`，L18363/L18385），无处置项 |
| **悬空（决策 9）** | **≈49 个前端调用函数** | market 审计等 A-16 域：Node 无路由、FastAPI 亦无路由；兜底收口后由显式 4040 envelope 覆盖（行为与 Node 404 等价，第六阶段前端清理时去留） |

**仍走兜底代理（透传 Node）的路径数：0。** `/api/{path:path}` 兜底代理已收口为显式
4040 处理器（对齐 Node 未匹配路径 `fail(res, 4040, '接口不存在', 404)`，index.mjs L18352）。
`proxy_api` 协程保留为普通函数，仅供既有显式路由在 `API_NATIVE_*` flag=false 时的回退
分支内部调用（inventory C-1 计划第四阶段随 flag 一并删除）。

## 2. 迁移（原生实现）明细

| # | 方法 | 路由 | Node 位置 | 回退 flag | 要点 |
|---|------|------|-----------|-----------|------|
| 1 | GET | `/api/health` | L12218 | — | 健康摘要字段族逐项对齐；有意差异：FastAPI SMS 供应商构建期降级，`smsReady` 恒 true、`smsReason` 恒空 |
| 2 | GET | `/api/model-settings` | L12235 | — | 41 字段 + 4 分组 + effective 配置解析（frame/video/lip-sync/audio 按 Node config 解析器转录；AI 组复用 `ai_provider.get_ai_config`）；secret 不回显明文 |
| 3 | PUT | `/api/model-settings` | L12244 | — | 逐条 upsert；secret 空值跳过、未注册 key 忽略、数值非法 400/4001（`{label} 必须是正整数`）；文本值仅 strip（不剥尾斜杠，对齐 Node） |
| 4 | GET | `/api/projects/{id}/script-agent/activities` | L12960 | — | limit 钳位 1-100（缺省 40）；行映射 `scriptAgentActivityRow` 复刻 |
| 5 | POST | `/api/projects/{id}/script-agent/activities` | L12970-L13098 | — | phase ∈ start/complete/fail/blocked；start 幂等键去重（含 ER_DUP_ENTRY 1062 回查）；complete/fail/blocked 走 activityId UPDATE 终态；reaction 由 `app/domain/script_agent.py` 确定性构建 |
| 6 | GET | `/api/storyboards/{id}/videos` | L16830 | `API_NATIVE_GENERATION` | video_assets 版本倒序列表 |
| 7 | PUT | `/api/projects/{id}/story-bible` | L13177 | `API_NATIVE_PROJECTS` | normalize → evaluate → persist 新版本（draft） |
| 8 | POST | `/api/projects/{id}/story-bible/evaluate` | L13177 | 同上 | **与 PUT 同分支**（Node 语义：evaluate 亦落库新版本，message 同为「已保存」） |
| 9 | POST | `/api/projects/{id}/story-bible/lock` | L13177 | 同上 | locked=true → status='locked'，message「故事设定已确认」 |
| 10 | PUT | `/api/projects/{id}/season-structure` | L13177 | 同上 | 关联最新 story_bible_id（可空） |
| 11 | POST | `/api/projects/{id}/season-structure/evaluate` | L13177 | 同上 | 同 #8 |
| 12 | POST | `/api/projects/{id}/season-structure/lock` | L13177 | 同上 | 同 #9（「分集大纲已确认」） |
| 13 | GET | `/api/projects/{id}/exports` | L15057 | — | exportRecordRow 复刻（config_json 安全解析 + storage_key 签名 URL） |
| 14 | GET | `/api/exports/{id}` | L17198 | — | owner 校验（er ⋈ projects）；id 非法 400/4001；缺失/越权统一 404/4004 |
| 15 | GET | `/api/projects/{id}/agent-pipeline` | L12849 | — | owner-scoped run 列表及 executions/events；数据库 3 次批量查询，不逐 run 扇出 |
| 16 | GET | `/api/agent-pipelines/{id}` | L12960 | — | owner-scoped 单次运行详情及 executions/events；run、project owner 同时校验 |
| 17 | GET | `/api/projects/{id}/production-runs` | L13349 | — | owner-scoped ProductionRun 摘要，按 updated_at/id 倒序；不加载或触发阶段执行体 |
| 18 | GET | `/api/production-runs/{id}` | L13459-L13480 | — | owner-scoped run/stages/checkpoints/agentExecutions/最新 blueprint 与 emotionBeats 只读视图；不触发生成或状态推进 |
| 19 | POST | `/api/agent-pipelines/{id}/stage-actions` | L12824-L12844 | — | owner/status/幂等键校验；单事务记录执行与 queued/running/终态事件并更新 run，不启动 Agent |

非法子动作（如 `POST /story-bible/other`）→ 404/4040（Node 正则不匹配落全局兜底）。

## 3. 显式 501 豁免清单（`OPS_FALLBACK_501_ROUTES`，决策 9）

> 每条以「HTTP 501 + code 5010 + 理由文案」响应；id 段用 `{name:int}` 转换器对齐
> Node「非整数 id → 兜底 4040」。缺口消除前不得改回透传。

### 3.1 Agent Pipeline 组（Node L12697-L12923）— 已原生实现

`start` 通过 FastAPI 校验项目 owner、剧本存在性和幂等键后写入 `agent_pipeline_runs`；Node Worker 按持久队列扫描并执行阶段 Agent。`decision` 在单事务内锁定 owner run 与对应 `waiting_approval` execution，拒绝会暂停运行；批准会保存阶段输出、写入审批事件并将下一阶段置为 queued，最终 storyboard 审批后完成。审批不在 HTTP 请求内执行模型调用，Worker 崩溃恢复仍使用既有 retryable 状态策略。

### 3.2 Production Runs 组（Node L13197-L13480）— 4 条

已原生实现创建、蓝图版本保存、检查点决定和阶段完成：领域规则对齐 Node 的抖音 pilot 默认值、候选策略、蓝图质量门禁与 9 阶段状态机；创建跨 runs/stages/checkpoints/executions/blueprint 单事务，幂等冲突回读既有运行；状态推进在锁定 run 行后核对 expected stage/checkpoint，再原子更新阶段、检查点和运行状态。阶段完成只登记调用方给定 outputSnapshot，不会伪称 Agent 已执行；真实候选/媒体仍由对应业务流程产生。定向契约测试已覆盖质量门禁、拒绝暂停、审批推进、并发过期状态拒绝与 owner scope。

### 3.3 成片编辑组（Node L14627-L14675）— 已原生实现

GET 使用 owner-scoped 数据读取聚合确认视频/静帧、音频、草稿与导出校验；PUT 对视频片段 ID 去重/过滤、音轨音量归一化后，在 owner 项目锁内 upsert `final_edit_drafts`。该能力只构建编辑视图与保存草稿，不启动媒体生成或导出任务。实现和行为测试见 `app/main.py`、`app/database.py` 与 `tests/test_ops_endpoints_compat.py`。

### 3.4 导出创建（Node L15068-L15138）— 已原生入队

FastAPI 校验导出包与 final-edit 门禁后，将 `export_records` 写为 queued 并返回任务记录；
Node Worker 仍持有 FFmpeg 执行体，并按 `BACKGROUND_QUEUE_POLL_INTERVAL_MS` 周期扫描
queued/running 记录，启动恢复与运行中扫描共用 `resumeExportJobs`。Worker readiness 同时
探测 `generation_jobs` 与 `export_records`。API 不执行 FFmpeg，也不触发付费供应商。

### 3.5 TTS 供应商端点 — 2 条（原生）

`POST /api/projects/{id}/audio/generate` 保持 Node 同步生成语义：先验证项目 owner、轨道类型、分镜/场景/角色归属、对白音色锁定及文本长度；DashScope 模式同步请求并下载供应商音频，写入本地对象存储或 COS，再原子分配轨道版本并插入 `audio_assets` 候选；mock 模式返回 Node 兼容的 `/mock/audio/...` URL，不触发付费供应商。

`POST /api/characters/{id}/voice-preview` 支持已选音色试听与 TTS 文件保存。`voiceAgent=true` 调用 Qwen voice-enrollment，持久化自定义声线和预览音频；确认绑定时校验试听路径只属于当前角色、voiceId 与服务端保存设计一致，再转存对象存储并锁定角色声线。mock 模式不能创建真实自定义音色，明确返回 503，不伪造成功。供应商错误、无效音频、危险下载 URL、越权与对象存储失败均按受控错误返回，失败不写候选资产。

适配层契约、mock 路由、DashScope 成功/失败、Qwen enrollment、COS 上传、确认绑定和数据库事务均有定向测试；测试使用内存 HTTP transport 与存储替身，不触发云端付费供应商。该同步形态沿用 Node 行为，因此 Worker 不消费这两类 TTS 请求。

角色抽取 `POST /api/projects/{id}/characters/generate` 已由 P74 原生实现：FastAPI 调用配置文本模型或 Node 兼容 mock，owner 校验后事务 upsert/归档角色，按稳定分组键幂等补齐角色/场景资产节点并绑定空缺分镜角色。全量 Node 行为对照、最终资产副作用与容器/生产验收仍在进行，不能据此宣称 P74 完成。

任务中心 Mock retry/cancel 已复刻 Node 的 owner-scoped 资源查询和运行态写入：retry 写 `queued/0%`，cancel 仅允许 queued/running 并保留进度，二者都只更新 `task_runtime_states`，不会调用 Worker、模型或付费供应商；响应重新聚合任务中心 DTO。

## 4. Worker 内部无需 HTTP（核实记录，0 条处置项）

| 能力 | 核实结论 |
|------|----------|
| 恢复队列 | `recoverGenerationJobs` / `resumeExportJobs` 为 Worker 进程内启动调用（index.mjs L18363/L18385），**无 HTTP 路由** |
| 对象存储验证 | Grep `verify-object|objectStorageVerify` 无路由命中；对象存在性校验已内联于媒体组原生实现（`_has_durable_asset_node_image` 等） |
| 媒体回填 | `scripts/migrate-legacy-media-to-storage.mjs` 等为离线脚本直连存储，无 HTTP 路由 |

## 5. 悬空调用域（决策 9，收口后 4040）

market 审计（`/market/*`）、jianying-draft、audio-library、delivery-package、cost-ledger、
release-compliance、production-readiness、recovery-*、single-video-final-edit、
final-quality-*、characters versions/locks/regression-samples 等：Node 无路由、FastAPI
无路由，运行时行为从「兜底代理 → Node 404/4040」变为「显式 4040 envelope」（等价）。
约 49 个前端调用函数，第六阶段前端清理时一并确认去留。

## 6. 测试覆盖索引

`tests/test_ops_endpoints_compat.py`（41 项，全部离线 fake database）：

- **兜底收口矩阵**（核心门禁）：未注册路径 + 悬空域 → 4040；`OPS_FALLBACK_501_ROUTES`
  逐条 → 501/5010 + 理由透出；全部断言无 `x-forwarded-by` 透传标记；
- 原生路由契约：health 形状 / model-settings 读写往返（secret 跳过、非法数值 4001、
  source 标注）/ script-agent 列表钳位 + 幂等 start + 终态更新 / story quality 写侧
  PUT/evaluate/lock 与非法子动作 4040 / storyboard videos / exports 列表与详情；
- 域函数：script_agent reaction 四分支 + nextActions 兜底链（对照
  `server/services/script-agent.test.mjs` 语义）；
- flag 回退回归：写侧 `API_NATIVE_PROJECTS=false` 仍透传（既有语义）；
  501 豁免路由不受任何 flag 影响。

随收口更新的既有用例：`tests/test_media_service_compat.py::test_media_routes_are_outside_api_proxy_scope`
（原断言兜底透传 502 → 现断言收口 4040 + 无透传标记，inventory C-1「随实现一并改写」）。

## 7. 已知有意差异（记录不修）

1. **health 的 smsReady/smsReason**：FastAPI 供应商构建期降级 → 恒 true/空串；Node 为运行期判定。
2. **saveModelSettings 的 process.env 合并**：Node 保存后合并回进程 env；FastAPI 以 DB 持久化为唯一事实源（Node Worker 独立读库），进程内 env 合并不复刻。
3. **写侧归一化异常形态**：Node 落全局 catch → 500/5001 + error.message 透传；FastAPI 走脱敏兜底 500/5001（沿用 script-group-spec §7 既记差异）。
