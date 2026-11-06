# Node HTTP API 退役依赖清单（第一阶段盘点）

> 生成日期：2026-10-17 · 基线 commit：`cbf34c1`（2026-10-16）
>
> **免责与边界**：`server/index.mjs`、`src/**`、`scripts/**` 为用户修改中文件，本清单为只读盘点快照。行号引用以当前工作区为准，删除/迁移前须用 Grep `pathname.match|pathname ===` 对 `server/index.mjs` 重新复核 diff。生成/付费端点的供应商细节以「入队语义」一句话概括（详见 spec 第三阶段-4），不影响路由完整性。
>
> 统计口径：`server/index.mjs` 共 **83 个 pathname 匹配模式**，展开为 **约 118 条 HTTP method 分支**；FastAPI `app/main.py` 共 **32 个路由装饰器 / 35 条 method 路由**（含兜底代理）。

## A. Node HTTP 路由全量清单（按前缀分节）

调用方标注：**前端**=`src/api/*.ts`；**脚本**=`scripts/*.mjs`（HTTP 调用）；**Worker-内部**=同进程函数调用（非 HTTP）；**Nginx**=nginx.conf 直代；**运维**=compose healthcheck / 部署脚本。响应 envelope 统一为 `success(data, message)` / `fail(code, message, httpStatus)`。

### A-1 媒体与静态文件服务（无 /api 前缀，Nginx 四路直代 `backend:3001`）

| # | 方法 | 路径模式 | Node 行号 | 鉴权 | 请求/响应要点 | 调用方 |
|---|------|----------|-----------|------|---------------|--------|
| 1 | GET | `/mock/image/{sb}/{ver}/{cand}.svg` | L11979-11991 | 公开 | 内存生成 SVG；`image/svg+xml`，`no-store` | 前端（mock 模式图片 URL） |
| 2 | GET | `/mock-assets/project-{p}/node-{n}/v{v}-{c}.png` | L11993-12011 | 公开 | 读 mock 资产图；404/4040；`X-ProjectDream-Mock-Asset` 头 | 前端（mock 资产画布） |
| 3 | GET | `/generated/frame/{file}` | L12013-12037 | 公开 | 读 `.codex-runtime/generated-frames`；png/webp/jpeg；404/4040 | 前端（Nginx /generated/） |
| 4 | GET | `/generated/audio/{file}` | L12039-12096 | 公开 | 读音频；支持 Range（206/416）；mp3/ogg/m4a/wav | 前端 |
| 5 | GET | `/generated/video/{file}` | L12098-12143 | 公开 | 读视频 mp4；支持 Range | 前端 |
| 6 | GET | `/generated/export/{id}[/{file}]` | L12149-12194 | 公开 | 导出 mp4/srt；Range（srt 除外）；404/4040 | 前端 |
| 7 | GET | `/mock/audio/...`（v1/v2 两种 URL 形态，同一分支） | L12145-12216 | 公开 | 内存生成 wav（trackType/candidateNo/版本种子） | 前端 |
| 8 | GET | `/storage/{key...}` | L12926-12946 | 公开（无签名校验） | `objectStorage.getObject`（local/cos）；immutable 缓存；404/4040 | 前端、脚本 |

### A-2 健康与模型设置

| # | 方法 | 路径 | Node 行号 | 鉴权 | 要点 | 调用方 |
|---|------|------|-----------|------|------|--------|
| 9 | GET | `/api/health` | L12218-12233 | 公开 | 返回 smsReady/objectStorage/dbName/userCount 等；**compose backend healthcheck 依赖** | 运维（compose L80）、FastAPI /ready 探测 |
| 10 | GET | `/api/model-settings` | L12235-12242 | authenticate | `buildModelSettingsPayload()` | 前端（project.ts L3843） |
| 11 | PUT | `/api/model-settings` | L12244-12254 | authenticate | body.settings；失败 4001 | 前端（project.ts L3854） |

### A-3 鉴权组（已规格化：`api-service/docs/auth-group-spec.md`；captcha 会话在 Node 进程内存，见 index.mjs L348 `captchaStore`）

| # | 方法 | 路径 | Node 行号 | 鉴权 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|------|--------------|--------|
| 12 | GET | `/api/auth/check-phone` | L12257-12266 | 公开 | query.phone 校验 `^1\d{10}$`；4001 | ✅ native（`API_NATIVE_AUTH_CHECK_PHONE`） | 前端 |
| 13 | GET | `/api/auth/captcha` | L12268+ | 公开 | 滑块挑战生成（内存会话） | ❌ 待迁移 | 前端 |
| 14 | POST | `/api/auth/captcha/verify` | L12276+ | 公开 | 校验滑块→captchaToken | ❌ 待迁移 | 前端 |
| 15 | POST | `/api/auth/send-code` | L12294+ | 公开 | SMS provider（tencent/aliyun/mock） | ❌ 待迁移（需 SMS adapter） | 前端 |
| 16 | POST | `/api/auth/login-password` | L12339+ | 公开 | 密码登录 | ✅ native（`API_NATIVE_AUTH_LOGIN_PASSWORD`） | 前端 |
| 17 | POST | `/api/auth/reset-password` | L12370+ | 公开 | 短信码重置 | ❌ 待迁移 | 前端 |
| 18 | POST | `/api/auth/login` | L12408+ | 公开 | 短信码登录 | ❌ 待迁移 | 前端 |
| 19 | POST | `/api/auth/register` | L12440+ | 公开 | 注册（含验证码链路） | ❌ 待迁移 | 前端 |

### A-4 项目组（部分已规格化：`project-asset-group-spec.md`）

| # | 方法 | 路径 | Node 行号 | 鉴权 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|------|--------------|--------|
| 20 | GET | `/api/projects` | L12486+ | authenticate | 列表+聚合统计 | ✅ native（`API_NATIVE_PROJECTS`） | 前端 |
| 21 | POST | `/api/projects` | L12486-12589 | authenticate | 创建（name/category/targetDuration/narrativeVision/visualStyle/aspectRatio） | ✅ native | 前端 |
| 22 | GET | `/api/projects/{id}` | L15196-15215（projectMatch，无 sub） | authenticate | 详情 | ✅ native | 前端 |
| 23 | PATCH | `/api/projects/{id}` | L15216-15230 | authenticate | 白名单字段更新 | ✅ native | 前端 |
| 24 | DELETE | `/api/projects/{id}` | L15141-15194 | authenticate | body.confirmName 必须等于完整项目名，否则 409/4090；级联靠 FK | ❌ 待迁移 | 前端（project.ts L2423） |
| 25 | GET | `/api/projects/{id}/outline` | L15196/L15233-15246 | authenticate | 最新总纲（无则 data=null） | ✅ native | 前端 |
| 26 | POST | `/api/projects/{id}/outline/generate` | L15248-15322 | authenticate | AI 同步生成；已有分集剧本时 409/4090；事务内清空旧场景 | ❌ 待迁移 | 前端 |
| 27 | GET | `/api/projects/{id}/scenes` | L15324-15331 | authenticate | 场景列表 | ✅ native（`API_NATIVE_SCRIPT`） | 前端 |
| 28 | POST | `/api/projects/{id}/scenes/generate` | L15333-15523 | authenticate | 场景解析 Agent（同步）；已有场景需头 `x-confirm-regenerate: true` 否则 409 | ❌ 待迁移 | 前端 |
| 29 | GET | `/api/projects/{id}/export-package` | L12592-12607 | authenticate | `buildExportPackage`（导出就绪度） | ❌ 待迁移 | 前端 |
| 30 | GET | `/api/projects/{id}/assets` | L12609-12624 | authenticate | 资产聚合 | ✅ native（`API_NATIVE_ASSETS`） | 前端 |
| 31 | POST | `/api/project-assets/{character\|image\|video\|audio}/{id}/archive` | L12626-12695 | authenticate | 归档策略 `canArchiveProjectAsset`；违规 4001 | ✅ native | 前端 |
| 32 | GET | `/api/projects/{id}/tasks` | L14430-14445 | authenticate | `buildProjectTasksV2` 任务中心 | ✅ native（归 PROJECTS flag） | 前端 |

### A-5 故事圣经 / 分集大纲（storyQualityMatch L13100-13195，一个 match 多分支）

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 33 | GET | `/api/projects/{id}/story-bible` | L13116-13124 | 最新版本或 null | ✅ native（只读） | 前端 |
| 34 | POST | `/api/projects/{id}/story-bible/generate` | L13127-13146 | AI 同步；idea 必填；5020 生成失败 | ❌ 待迁移 | 前端 |
| 35 | PUT | `/api/projects/{id}/story-bible` | L13177-13194 | 保存+质量评估 | ❌ 待迁移（写侧） | 前端 |
| 36 | POST | `/api/projects/{id}/story-bible/evaluate` | L13177-13194 | 评估不入库锁定 | ❌ 待迁移 | 前端 |
| 37 | POST | `/api/projects/{id}/story-bible/lock` | L13177-13194 | 确认锁定 | ❌ 待迁移 | 前端 |
| 38 | GET | `/api/projects/{id}/season-structure` | L13116-13124 | 最新版本或 null | ✅ native（只读） | 前端 |
| 39 | POST | `/api/projects/{id}/season-structure/generate` | L13148-13175 | 依赖已有 bible；AI 同步；5020 | ❌ 待迁移 | 前端 |
| 40 | PUT | `/api/projects/{id}/season-structure` | L13177-13194 | 保存+评估 | ❌ 待迁移（写侧） | 前端 |
| 41 | POST | `/api/projects/{id}/season-structure/evaluate` | L13177-13194 | 评估 | ❌ 待迁移 | 前端 |
| 42 | POST | `/api/projects/{id}/season-structure/lock` | L13177-13194 | 确认锁定 | ❌ 待迁移 | 前端 |

### A-6 项目音频与音频资产

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 43 | GET | `/api/projects/{id}/audio` | L14677-14717 | 按轨道类型排序的音频列表 | ✅ native | 前端 |
| 44 | POST | `/api/projects/{id}/audio/generate` | L14677/L14719+ | TTS 同步生成并写 `audio_assets`（DashScope + 对象存储；mock 离线响应） | ✅ FastAPI 原生 | 前端 |
| 45 | POST | `/api/audio-assets/{id}/confirm` | L16994-17071 | 同轨道组互斥确认（事务） | ✅ native（`API_NATIVE_ASSETS`） | 前端 |
| 46 | POST | `/api/audio-assets/{id}/archive` | L17073-17124 | confirmed 不可归档（4001） | ✅ native | 前端 |
| 47 | PUT | `/api/audio-assets/{id}` | L17126-17195 | 时间线定位（storyboardId/startOffsetSeconds≤60） | ✅ native | 前端 |

### A-7 Agent Pipeline（项目级剧本链 Agent）

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 48 | GET | `/api/projects/{id}/agent-pipeline` | L12698/L12709-12723 | run 列表（逐个 loadAgentPipelineView） | ❌ 待迁移 | 前端 |
| 49 | POST | `/api/projects/{id}/agent-pipeline/start` | L12697/L12725-12801 | 幂等键去重；校验该集剧本正文；INSERT agent_pipeline_runs（queued/asset-parse）后由 Node Worker 持久队列执行阶段 | ✅ FastAPI 入队 + Node Worker（2026-10-20；本地未发布） | 前端 |
| 50 | GET | `/api/agent-pipelines/{id}` | L12804/L12820-12823 | run 视图 | ❌ 待迁移 | 前端 |
| 51 | POST | `/api/agent-pipelines/{id}/stage-actions` | L12805/L12824-12844 | owner/status/幂等键校验；原子登记 execution 与 queued/running/终态事件，不调用 Agent | ✅ FastAPI 原生（2026-10-19） | 前端 |
| 52 | POST | `/api/agent-pipelines/{id}/stages/{key}/decision` | L12806/L12845-12923 | owner-scoped 锁定等待审批 execution；approve 原子入队下一阶段，reject→paused 并记录事件 | ✅ FastAPI 原生（2026-10-20；本地未发布） | 前端 |

### A-8 Script Agent 活动

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 53 | GET | `/api/projects/{id}/script-agent/activities` | L12948-12963 | query.limit；活动列表 | ❌ 待迁移 | 前端 |
| 54 | POST | `/api/projects/{id}/script-agent/activities` | L12965-13098 | phase ∈ start/complete/fail/blocked（含 reaction 更新）；非法 4001 | ❌ 待迁移 | 前端 |

### A-9 Production Runs（黄金样片流水线）

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 55 | GET | `/api/projects/{id}/production-runs` | L13197-13216 | owner-scoped run 摘要列表 | ✅ FastAPI 原生（2026-10-19） | 前端 |
| 56 | POST | `/api/projects/{id}/production-runs` | L13217-13317 | 幂等键（含 ER_DUP_ENTRY 兜底）；blueprint 构建+质量评估；单事务插 runs/stages/checkpoints/agent_executions/episode_blueprints | ✅ FastAPI 原生（2026-10-20；本地未发布） | 前端 |
| 57 | GET | `/api/production-runs/{id}` | L13319/L13335-13338 | owner-scoped run/stage/checkpoint/execution/latest blueprint 只读视图 | ✅ FastAPI 原生（2026-10-19） | 前端 |
| 58 | PUT | `/api/production-runs/{id}/blueprint` | L13320/L13339-13361 | 新版本 blueprint+质量报告 | ✅ FastAPI 原生（2026-10-20；本地未发布） | 前端 |
| 59 | POST | `/api/production-runs/{id}/checkpoints/{key}/decision` | L13321/L13362-13434 | approve 推进阶段（事务）；blueprint 检查点需 qualityReport.canApprove | ✅ FastAPI 原生（2026-10-20；本地未发布） | 前端 |
| 60 | POST | `/api/production-runs/{id}/stages/{key}/complete` | L13322/L13435-13480 | 阶段完成事务（stage/checkpoint 联动） | ✅ FastAPI 原生（2026-10-20；本地未发布） | 前端 |

### A-10 资产画布 / 资产节点（asset-canvas / asset-nodes）

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 61 | GET | `/api/projects/{id}/asset-canvas` | L13483-13679 | **读时自愈**：归档旧场景壳、去重、刷新角色/场景提示词、prop 单视角自动采用；返回画布视图 | ❌ 待迁移（复刻成本高） | 前端 |
| 62 | POST | `/api/projects/{id}/asset-nodes` | L13681-13801 | nodeType ∈ character/scene/prop/material；character/scene 可自动生成提示词 | ❌ 待迁移 | 前端 |
| 63 | PATCH | `/api/asset-nodes/{id}` | L13803/L13968-14029 | label/appearance/prompt/turnaround/environment/negative/groupKey/x/y/w/h 白名单 | ❌ 待迁移 | 前端 |
| 64 | DELETE | `/api/asset-nodes/{id}` | L14030-14045 | 软删（status=archived） | ❌ 待迁移 | 前端 |
| 65 | POST | `/api/asset-nodes/{id}/relink-scene` | L13804/L13806-13878 | 仅场景节点；重新匹配剧本场景并刷新提示词 | ❌ 待迁移 | 前端 |
| 66 | POST | `/api/asset-nodes/{id}/hydrate-prompt` | L13805/L13879-13967 | 仅 scene/character 且有 ref_id；自动补齐提示词 | ❌ 待迁移 | 前端 |
| 67 | GET | `/api/asset-nodes/{id}/images` | L14047-14062 | 图片列表 | ❌ 待迁移 | 前端 |
| 68 | POST | `/api/asset-nodes/{id}/images/generate` | L14063-14079 | **入队** `enqueueAssetNodeImageJob`（付费图片） | ❌ 待迁移（入队语义） | 前端 |
| 69 | POST | `/api/asset-node-images/{id}/confirm` | L14080-14302 | 多重确认门禁（资产板/三视图/脸特写/九宫格）；角色节点写 identity lock；同视角 superseded | ❌ 待迁移 | 前端 |
| 70 | POST | `/api/asset-node-images/{id}/vision-check` | L14303-14428 | 视角视觉检查状态更新 | ❌ 待迁移 | 前端 |

### A-11 生成任务与任务中心动作

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 71 | GET | `/api/generation-jobs/{id}` | L14447-14467 | job 详情（owner 校验） | ✅ native（`API_NATIVE_GENERATION`） | 前端 |
| 72 | POST | `/api/project-tasks/generation-{id}/retry` | L14473-14547 | 仅 failed/canceled 可重试（409）；`repairVideoRetryReferences` 修复引用、复用未失败 providerTasks 后 `queueGenerationJob` | ✅ native（GENERATION flag） | 前端 |
| 73 | POST | `/api/project-tasks/generation-{id}/cancel` | L14494-14497 | 固定 409（供应商请求不支持取消） | ✅ native | 前端 |
| 74 | POST | `/api/project-tasks/{image\|video\|audio\|export}-{id}/retry` | L14469/L14549-14596 | Mock 语义：task_runtime_states upsert 'queued' | 🔒 fixed-proxy（任何情况代理 Node） | 前端 |
| 75 | POST | `/api/project-tasks/{image\|video\|audio\|export}-{id}/cancel` | L14598-14625 | Mock 语义：canCancel 校验后置 canceled | 🔒 fixed-proxy | 前端 |

### A-12 场景与分镜（已规格化：`script-group-spec.md`）

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 76 | GET | `/api/scenes/{id}` | L15620-15642 | 场景详情 | ✅ native | 前端 |
| 77 | PUT | `/api/scenes/{id}` | L15644-15688 | 白名单（title/summary/location/timeOfDay/estimatedDuration） | ✅ native | 前端 |
| 78 | POST | `/api/scenes/{id}/script/generate` | L15527-15602 | AI 同步生成剧本（依赖 bible/season/outline） | ❌ 待迁移 | 前端 |
| 79 | PUT | `/api/scenes/{id}/script` | L15604-15617 | 保存剧本（content/mood/title；status=revised） | ✅ native | 前端 |
| 80 | GET | `/api/scenes/{id}/storyboards` | L15692-16068 | 分镜列表 | ✅ native | 前端 |
| 81 | POST | `/api/scenes/{id}/storyboards/generate` | L15713-16065 | AI 同步生成分镜 + RAG 索引/查询（RAG_SERVICE_URL） | ❌ 待迁移 | 前端 |
| 82 | GET | `/api/storyboards/{id}` | L16098-16138 | 详情 + **`resolveFrameCharacterContext` 数百行启发式派生字段**（前端静帧页依赖 ready/blockers/characters） | 🔒 **fixed-proxy**（不受 flag 控制，main.py L516-523） | 前端 |
| 83 | PUT | `/api/storyboards/{id}` | L16140-16262 | 大字段白名单 + gaze/sound 计划契约校验（422） | ✅ native（SCRIPT flag） | 前端 |
| 84 | POST | `/api/storyboards/{id}/frame-prompt/rewrite` | L16070-16095 | 视觉提示词重写（依赖 frameCharacterContext） | ❌ 待迁移 | 前端 |
| 85 | POST | `/api/storyboards/{id}/keyframes/optimize` | L16265-16285 | 两帧提示词优化 | ❌ 待迁移 | 前端 |
| 86 | POST | `/api/storyboards/{id}/continuity/start-frame` | L16287-16307 | 承接上一镜头 | ❌ 待迁移 | 前端 |
| 87 | POST | `/api/storyboards/{id}/split` | L16309-16329 | AI 拆分子分镜（事务重排） | ❌ 待迁移 | 前端 |
| 88 | POST | `/api/storyboards/{id}/dialogue/split` | L16331-16351 | AI 拆分多人对白 | ❌ 待迁移 | 前端 |
| 89 | POST | `/api/storyboards/reorder` | L16354-16379 | 批量 sort_order | ✅ native | 前端 |

### A-13 静帧 / 视频 / 口型 / 字幕

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 90 | GET | `/api/shots/{id}/images` | L16383/L16553-16562 | 候选图列表 | ✅ native（ASSETS flag） | 前端 |
| 91 | POST | `/api/shots/{id}/images/generate` | L16410-16428 | **入队** `enqueueFrameImageJob`（legacy 同步路径以注释保留） | ❌ 待迁移（入队语义） | 前端 |
| 92 | POST | `/api/images/{id}/confirm` | L16565-16627 | 同 frame_role 互斥确认并回写 storyboard.image_url/end_image_url（事务） | ✅ native | 前端 |
| 93 | GET | `/api/storyboards/{id}/videos` | L16667/L16830-16839 | 视频候选列表 | ❌ 待迁移 | 前端 |
| 94 | POST | `/api/storyboards/{id}/videos/generate` | L16693-16717 | **入队** `enqueueStoryboardVideoJob`（付费视频；qualityReport 错误附带）；legacy 注释保留 | ❌ 待迁移（入队语义） | 前端 |
| 95 | POST | `/api/storyboards/{id}/lip-sync/generate` | L16631-16665 | **入队** `enqueueLipSyncJob`（口型同步） | ❌ 待迁移（入队语义） | 前端 |
| 96 | POST | `/api/videos/{id}/subtitles/remove` | L16842-16878 | **入队** `createGenerationJob(subtitle_cleanup)` | ✅ native（入队实现已迁移，GENERATION flag） | 前端 |
| 97 | POST | `/api/videos/{id}/confirm` | L16880-16992 | 最终视频确认（事务回写 storyboard） | ❌ 待迁移 | 前端 |

### A-14 成片编辑与导出

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 98 | GET | `/api/projects/{id}/final-edit` | L14627-14642 | 成片编辑聚合+校验 | ✅ FastAPI 原生（2026-10-20，本地未发布） | 前端 |
| 99 | PUT | `/api/projects/{id}/final-edit-draft` | L14644-14675 | 草稿 upsert（final_edit_drafts） | ✅ FastAPI 原生（2026-10-20，本地未发布） | 前端 |
| 100 | GET | `/api/projects/{id}/exports` | L15045-15066 | 导出记录列表 | ❌ 待迁移 | 前端 |
| 101 | POST | `/api/projects/{id}/exports` | L15068-15138 | 校验（exportPackage+finalEdit）；INSERT export_records(queued) + Worker 消费 FFmpeg | ✅ FastAPI 入队 + Node Worker 执行（2026-10-20，本地未发布） | 前端 |
| 102 | GET | `/api/exports/{id}` | L17197-17223 | 导出详情 | ❌ 待迁移 | 前端 |

### A-15 角色库与配音

| # | 方法 | 路径 | Node 行号 | 要点 | FastAPI 现状 | 调用方 |
|---|------|------|-----------|------|--------------|--------|
| 103 | GET | `/api/voice-profiles` | L17225-17235 | 系统音色目录+年龄段/性别枚举 | ✅ native（GENERATION flag） | 前端 |
| 104 | GET | `/api/projects/{id}/voice-cast` | L17237-17256 | 角色×音色阵容 | ❌ 待迁移 | 前端 |
| 105 | GET | `/api/projects/{id}/characters` | L16382/L17371-17390 | 角色列表 | ❌ 待迁移 | 前端 |
| 106 | POST | `/api/projects/{id}/characters` | L17371/L17560-17609 | 手工新建角色（draft） | ❌ 待迁移 | 前端 |
| 107 | POST | `/api/projects/{id}/characters/generate` | L17393-17559 | AI 同步抽取角色（upsert by name；502/5001） | ✅ FastAPI 原生（P74；未同步生产） | 前端 |
| 108 | GET | `/api/characters/{id}` | L18167-18195 | 角色详情 | ❌ 待迁移 | 前端 |
| 109 | PUT | `/api/characters/{id}` | L18208+ | 更新；改名必须显式 `syncNameReferences` | ❌ 待迁移 | 前端 |
| 110 | DELETE | `/api/characters/{id}` | L18197-18206 | 软删（archived） | ❌ 待迁移 | 前端 |
| 111 | POST | `/api/character-images/{id}/confirm` | L17613-17662 | 定妆图确认→角色 finalized | ❌ 待迁移 | 前端 |
| 112 | POST | `/api/characters/{id}/rename-preview` | L17664-17708 | 改名影响预览（重名 409/4009） | ❌ 待迁移 | 前端 |
| 113 | POST | `/api/characters/{id}/generate-profile` | L17710/L17733-17760 | AI 补全角色档案 | ❌ 待迁移 | 前端 |
| 114 | POST | `/api/characters/{id}/images/generate` | L17710/L17776-17788 | **入队** `enqueueCharacterImageJob`（定妆图） | ❌ 待迁移（入队语义） | 前端 |
| 115 | POST | `/api/characters/{id}/voice-preview` | L17710/L18090-18163 | 同步 TTS 试听、Qwen voice-enrollment 与确认绑定 | ✅ FastAPI 原生（真实凭据/供应商验收待生产执行） | 前端 |
| 116 | GET | `/api/characters/{id}/voice-recommendations` | L17258/L17279-17290 | 音色推荐 Top3 | ❌ 待迁移 | 前端 |
| 117 | PUT | `/api/characters/{id}/voice-binding` | L17292-17349 | 音色绑定+锁定（ageGroup/gender/voiceStyle） | ❌ 待迁移 | 前端 |
| 118 | PUT | `/api/characters/{id}/reference-audio` | L17351-17368 | base64≤22MB→objectStorage 存储 | ❌ 待迁移 | 前端 |

### A-16 Node 侧「存在服务模块但无 HTTP 路由」的域

`server/services/` 下存在 `market-*`、`jianying-*`、`delivery-package.mjs`、`cost-ledger.mjs`、`release-compliance.mjs`、`final-quality-*.mjs`、`recovery-*`、`single-video-final-edit.mjs`、`character-rename.mjs` 等完整服务实现与测试，但当前 `server/index.mjs` **没有对应路由注册**（Grep `pathname` 零命中），FastAPI 亦无。`src/api/project.ts`/`market.ts` 中约 **49 个前端调用函数**指向这些不存在的路径（如 `/market/*`、`/projects/{id}/jianying-draft`、`/audio-library`、`/cost-ledger`、`/recovery-*`、`/single-video-final-edit/*`、`/characters/{id}/versions` 等）——运行时经 FastAPI 兜底代理到 Node 得到 404/5000。这些是**历史功能残留/重构中**的悬空调用，不阻塞 Node 下线（删除兜底后行为不变仍是 404），但需在第六阶段前端清理时一并确认去留。

## B. FastAPI 路由清单与分类（`api-service/app/main.py`）

分类：**native**=默认原生实现（受对应 `API_NATIVE_*` flag 控制，false 时回退代理）；**fixed-proxy**=任何情况固定代理 Node；**internal**=内部端点（`X-Internal-Token` 保护，`INTERNAL_TOKEN` 未配置返回 503）；**fallback**=兜底代理 `/api/{path:path}`（methods GET/POST/PUT/PATCH/DELETE）。

| 装饰器行号 | 方法 | 路径 | 分类 | 控制开关 |
|-----------|------|------|------|----------|
| L124 | GET | `/health` | native | — |
| L128 | GET | `/ready` | native | 探 MySQL **+ Node upstream**（`NODE_READINESS_TIMEOUT_SECONDS`） |
| L183 | POST | `/internal/agent/runs` | internal | INTERNAL_TOKEN + AGENT_RUNTIME_ENABLED |
| L201 | GET | `/internal/agent/runs/{run_id}` | internal | 同上 |
| L227 | GET | `/api/voice-profiles` | native | `API_NATIVE_GENERATION` |
| L250 | POST | `/api/auth/login-password` | native | `API_NATIVE_AUTH_LOGIN_PASSWORD` |
| L269 | GET | `/api/auth/check-phone` | native | `API_NATIVE_AUTH_CHECK_PHONE` |
| L279/L288 | GET/POST | `/api/projects` | native | `API_NATIVE_PROJECTS` |
| L300 | GET/PATCH | `/api/projects/{id}` | native | `API_NATIVE_PROJECTS` |
| L339 | GET | `/api/projects/{id}/assets` | native | `API_NATIVE_ASSETS` |
| L366 | GET | `/api/projects/{id}/audio` | native | `API_NATIVE_PROJECTS` |
| L383/L397/L410 | GET | `/api/projects/{id}/outline`、`/story-bible`、`/season-structure` | native | `API_NATIVE_PROJECTS` |
| L423 | GET | `/api/projects/{id}/tasks` | native | `API_NATIVE_PROJECTS` |
| L433 | GET | `/api/projects/{id}/scenes` | native | `API_NATIVE_SCRIPT` |
| L444 | GET/PUT | `/api/scenes/{id}` | native | `API_NATIVE_SCRIPT` |
| L483 | PUT | `/api/scenes/{id}/script` | native | `API_NATIVE_SCRIPT` |
| L507 | GET | `/api/scenes/{id}/storyboards` | native | `API_NATIVE_SCRIPT` |
| L517 | GET/PUT | `/api/storyboards/{id}` | **GET=fixed-proxy**（frameCharacterContext）；PUT=native | SCRIPT（仅 PUT） |
| L620 | POST | `/api/project-assets/{type}/{id}/archive` | native | `API_NATIVE_ASSETS` |
| L648 | GET | `/api/generation-jobs/{id}` | native | `API_NATIVE_GENERATION` |
| L658 | POST | `/api/videos/{id}/subtitles/remove` | native | `API_NATIVE_GENERATION` |
| L670 | POST | `/api/audio-assets/{id}/confirm` | native | `API_NATIVE_ASSETS` |
| L682 | POST | `/api/audio-assets/{id}/archive` | native | `API_NATIVE_ASSETS` |
| L696 | PUT | `/api/audio-assets/{id}` | native | `API_NATIVE_ASSETS` |
| L716 | POST | `/api/images/{id}/confirm` | native | `API_NATIVE_ASSETS` |
| L728 | GET | `/api/shots/{id}/images` | native | `API_NATIVE_ASSETS` |
| L740 | POST | `/api/storyboards/reorder` | native | `API_NATIVE_SCRIPT` |
| L782 | POST | `/api/project-tasks/{task_key}/{action}` | `generation-*`=native；`image/video/audio/export-*` 动作=**fixed-proxy** | `API_NATIVE_GENERATION`（仅 generation-*） |
| L822 | ANY | `/api/{path:path}` | **fallback** 兜底代理 | `node_upstream_url` 非空即启用 |

其余运行时依赖见 C 部分：`proxy_api()`（main.py L825 组装上游 URL、L109 httpx 客户端 `proxy_timeout_seconds`）、`/ready` 的 Node 探活（L135-139）。

## C. Node 运行时依赖清单（逐文件:行号）

### C-1 FastAPI 侧（`api-service/`）

| 文件:行号 | 依赖项 | 说明 |
|-----------|--------|------|
| app/config.py:10 | `node_upstream_url`（`NODE_UPSTREAM_URL`，默认 `http://backend:3001`） | 兜底代理/探活上游 |
| app/config.py:13 | `OBJECT_STORAGE_PUBLIC_BASE_URL` 默认 `http://127.0.0.1:3001/storage` | **默认值含 3001**，生产由 env 覆盖为 COS 域名 |
| app/config.py:30 | `node_readiness_timeout_seconds`（`NODE_READINESS_TIMEOUT_SECONDS`，默认 2.0） | /ready 探 Node |
| app/config.py:31 | `proxy_timeout_seconds`（默认 300） | 代理超时 |
| app/config.py:32-46 | 6 个 flag：`API_NATIVE_AUTH_CHECK_PHONE`、`API_NATIVE_AUTH_LOGIN_PASSWORD`、`API_NATIVE_PROJECTS`、`API_NATIVE_ASSETS`、`API_NATIVE_SCRIPT`、`API_NATIVE_GENERATION`（全默认 true） | 第四阶段删除 |
| app/config.py:63 | `public_summary().node_upstream_configured` | 健康摘要暴露 Node 依赖 |
| app/main.py:109 | httpx 客户端使用 `proxy_timeout_seconds` | 代理实现 |
| app/main.py:135-139 | `/ready` 探 `{node_upstream_url}/api/health` | **停 Node 即 /ready 失败 → compose api 服务不健康** |
| app/main.py:825 | `proxy_api` 组装 `{node_upstream_url}/api/{path}` | 兜底代理 |
| README.md:61/104/109 | flag 回退说明、NODE_UPSTREAM_URL、NODE_READINESS_TIMEOUT_SECONDS 文档 | 第六阶段更新 |
| tests/（test_config.py:33-41、test_contracts.py:310/326/348/369/542/600/646/663/691/924/1037、test_auth_group_compat.py:89/100/105、test_project_asset_group_compat.py:199/210/215、test_script_group_compat.py:236/246/251、test_generation_group_compat.py:159/169/174、test_agent_internal_endpoints.py:87） | `node_upstream_url`/flag 回退测试夹具 | 第四阶段随实现一并删除/改写 |

### C-2 编排与网关

| 文件:行号 | 依赖项 |
|-----------|--------|
| docker-compose.yml:40-89 | `backend` 服务（Node API，PORT=3001，APP_RUNTIME_ROLE=api，healthcheck 打 127.0.0.1:3001/api/health L80） |
| docker-compose.yml:106 | `api` 服务注入 `NODE_UPSTREAM_URL: http://backend:3001` |
| docker-compose.yml:118-122 | `api` depends_on `backend` healthy（**启动顺序依赖**） |
| docker-compose.yml:136-183 | `worker` 服务：`command: node server/index.mjs`（L145）、APP_RUNTIME_ROLE=worker（L157）、RAG_* 注入（L158-163）——**保留**（仅 HTTP 角色退役） |
| docker-compose.yml:241-243 | `frontend` depends_on `backend` healthy（**启动顺序依赖**） |
| nginx.conf:16-26 | `/api/` → `api:8000`（保留） |
| nginx.conf:29-39/44-54/57-67/69-79 | `/generated/`、`/storage/`、`/mock/`、`/mock-assets/` → `proxy_pass http://backend:3001`（**四条媒体路**） |
| Dockerfile.backend:45 | `CMD ["node", "server/index.mjs"]`（backend 与 worker 共镜像；第五阶段拆分） |
| .env.production.example:40-42 | `NODE_UPSTREAM_URL=http://backend:3001` + 注释 |
| .env.example:14 | `OBJECT_STORAGE_PUBLIC_BASE_URL=http://127.0.0.1:3001/storage`（本地开发默认） |
| .codex-deploy.patch:28/36/44/52/60 | 历史 patch 中 5 处 `proxy_pass http://backend:3001`（非活跃文件，清理时确认） |

### C-3 前端与开发工具

| 文件:行号 | 依赖项 |
|-----------|--------|
| vite.config.ts:20-27 | dev 代理 `/storage` → `http://127.0.0.1:3001`、`/api` → `VITE_DEV_API_TARGET || http://127.0.0.1:3001`（**开发模式直连 Node**） |
| package.json:30 | `npm run server` → `node --watch server/index.mjs` |
| src/api/*.ts | 全部走 `VITE_API_BASE_URL=/api`（相对路径，生产经 Nginx→FastAPI；无 3001 直连）✅ |

### C-4 脚本（scripts/，HTTP 调 Node API）

| 文件:行号 | 默认上游 |
|-----------|----------|
| scripts/create-dead-boss-server-story.mjs:1、run-dead-boss-server-video-loop.mjs:4 | `API_ORIGIN || http://backend:3001`（容器内直连 Node） |
| scripts/character-consistency-smoke.mjs:4、export-episode-one-validation-scenes.mjs:10、run-dead-boss-episode-one-pilot.mjs:19、run-episode-one-core-production.mjs:12、run-episode-one-pilot-candidates.mjs:21、run-episode-one-reference-remake.mjs:15、setup-dead-boss-episode-one.mjs:19 | `PROJECTDREAM_API_ORIGIN || http://127.0.0.1:3001` |
| .tmp-fullchain-text-acceptance.mjs:1、.tmp-refresh-dead-boss-scenes.mjs:3、.tmp-run-dead-boss-acceptance.mjs:1、.tmp-run-dead-boss-assets.mjs:1、.tmp-seed-dead-boss-assets.mjs:26 | `API_ORIGIN || http://127.0.0.1:3001`（临时脚本） |
| scripts/migrate-legacy-media-to-storage.mjs:405、repair-missing-speech-audio.mjs:21、replicate-local-media-to-cos.mjs:104 | `PUBLIC_BASE_URL` 默认 `http://127.0.0.1:3001`（拼媒体 URL） |
| scripts/worker-healthcheck.mjs | Worker 健康检查（**保留**，非 HTTP API 依赖） |
| scripts/run-worker.mjs | Worker 入口（**保留**） |

### C-5 文档与其他

| 文件 | 内容 |
|------|------|
| README.md:55-56/226/274 | 3001 健康检查、`node --check server/index.mjs`、index.mjs 职责说明 |
| 项目开发文档/*.md（约 15 处） | 3001 示例 URL（AI漫剧指南 L117/L128、功能拆解 L1041、答辩稿、混合MVP导出记录等） |
| 项目开发文档/腾讯云DockerCompose部署指南.md:19-23 | 四媒体路+代理架构说明 |
| 登录注册与过程遇到的问题以及怎么解决.md:326 | `VITE_API_BASE_URL=http://localhost:3001/api`（历史排障记录） |
| server/services/object-storage.mjs:14 | Node 侧 `DEFAULT_PUBLIC_BASE_URL = http://127.0.0.1:3001/storage`（Node 内部，随 Worker 保留；媒体 URL 产出迁 FastAPI 后不再被外部依赖） |

## D. 迁移矩阵（七组）

> 「FastAPI 现状」：✅ 已原生（默认 flag 生效）/ 🔒 固定代理 / ❌ 仅兜底代理（待迁移）/ ➖ 不适用。
> 「当前真实流量来源」以调用方标注为准。

### D-1 鉴权组

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| GET /api/auth/check-phone | ✅ native | 前端 | 是 | — | 既有契约测试 |
| POST /api/auth/login-password | ✅ native | 前端 | 是 | — | 既有契约测试 |
| GET /api/auth/captcha | ❌ | 前端 | 否 | 滑块 SVG+HMAC 复刻；会话 MySQL 化（现为 Node 内存 L348） | captcha→verify→send-code→register 全链路黑盒 |
| POST /api/auth/captcha/verify | ❌ | 前端 | 否 | 同上 | 同上 |
| POST /api/auth/send-code | ❌ | 前端 | 否 | SMS provider adapter（tencent/aliyun/mock，devCode 语义） | mock 供应商发码 + 真实供应商云端验收 |
| POST /api/auth/register | ❌ | 前端 | 否 | 错误码 4001-4010 envelope 对齐 | 错误码等价类 |
| POST /api/auth/login | ❌ | 前端 | 否 | 短信码登录 | 短信登录契约 |
| POST /api/auth/reset-password | ❌ | 前端 | 否 | 短信码重置 | 重置后旧会话失效断言 |

### D-2 项目组

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| GET/POST /api/projects、GET/PATCH /api/projects/{id} | ✅ | 前端 | 是 | — | 既有 |
| DELETE /api/projects/{id} | ❌ | 前端 | 否 | confirmName 409 语义 | 删除确认等价类 |
| GET /api/projects/{id}/outline | ✅ | 前端 | 是 | — | 既有 |
| POST /api/projects/{id}/outline/generate | ❌ | 前端 | 否 | AI 同步→入队化决策；409 拦截语义 | 已有剧本时 409 断言 |
| GET /api/projects/{id}/scenes | ✅ | 前端 | 是 | — | 既有 |
| POST /api/projects/{id}/scenes/generate | ❌ | 前端 | 否 | 场景解析 Agent；x-confirm-regenerate 头 | 确认头缺失 409 |
| GET outline/story-bible/season-structure 只读 | ✅ | 前端 | 是 | — | 既有 |
| story-bible/season-structure 写+generate+evaluate+lock（6 条） | ❌ | 前端 | 否 | 保存/评估/锁定 + AI 生成入队化 | 版本号推进 + lock 语义 |
| GET /api/projects/{id}/audio | ✅ | 前端 | 是 | — | 既有 |
| POST /api/projects/{id}/audio/generate | ❌ | 前端 | 否 | 付费 TTS 入队快照构造 | 入队→Worker 消费闭环 |
| GET /api/projects/{id}/tasks | ✅ | 前端 | 是 | — | 既有 |
| GET /api/projects/{id}/export-package | ❌ | 前端 | 否 | buildExportPackage 复刻 | readyShots 计数对照 |

### D-3 资产组（含资产画布）

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| GET /api/projects/{id}/assets、POST project-assets archive | ✅ | 前端 | 是 | — | 既有 |
| GET /api/projects/{id}/asset-canvas | ❌ | 前端 | 否 | **读时自愈逻辑**（归档旧壳/去重/提示词刷新/prop 自动采用）Python 复刻 | 同 fixture 两侧画布一致 |
| POST /api/projects/{id}/asset-nodes | ❌ | 前端 | 否 | 节点创建+提示词自动生成 | 四种 nodeType 等价类 |
| PATCH/DELETE /api/asset-nodes/{id} | ❌ | 前端 | 否 | 白名单更新/软删 | 字段白名单 |
| POST relink-scene / hydrate-prompt | ❌ | 前端 | 否 | 场景重匹配+提示词构建器复刻 | relink 后 prompt 断言 |
| GET /api/asset-nodes/{id}/images | ❌ | 前端 | 否 | 简单读取 | 契约 |
| POST asset-nodes/{id}/images/generate | ❌ | 前端 | 否 | 付费图片入队 | 入队闭环 |
| POST asset-node-images/{id}/confirm | ❌ | 前端 | 否 | 多重确认门禁+identity lock+superseded 规则 | 门禁拒绝矩阵 |
| POST asset-node-images/{id}/vision-check | ❌ | 前端 | 否 | 视觉检查状态机 | 状态迁移 |
| audio-assets confirm/archive/PUT、images/{id}/confirm、shots/{id}/images | ✅ | 前端 | 是 | — | 既有 |

### D-4 剧本 / 分镜组

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| GET/PUT /api/scenes/{id}、PUT script、GET storyboards、PUT storyboard、POST reorder | ✅ | 前端 | 是 | — | 既有 |
| GET /api/storyboards/{id} | 🔒 fixed-proxy | 前端 | 否 | **frameCharacterContext Python 复刻**（spec 最大单体工程之一）；复刻后废除固定代理 | 同批分镜 fixture 两侧逐字段一致 |
| POST scenes/{id}/script/generate | ❌ | 前端 | 否 | AI 同步→入队化 | 入队闭环 |
| POST scenes/{id}/storyboards/generate | ❌ | 前端 | 否 | AI 同步+RAG 索引/查询；入队化时 RAG 调用归 Worker | 空剧本 4004、生成数量断言 |
| POST frame-prompt/rewrite | ❌ | 前端 | 否 | 依赖 frameCharacterContext | 与复刻联动验收 |
| POST keyframes/optimize、continuity/start-frame、split、dialogue/split（4 条） | ❌ | 前端 | 否 | AI 文本能力+事务重排 | 拆分后 sort_order 连续性 |

### D-5 生成任务组

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| GET /api/generation-jobs/{id} | ✅ | 前端 | 是 | — | 既有 |
| POST project-tasks/generation-{id}/retry、/cancel | ✅ | 前端 | 是 | — | 既有 |
| POST project-tasks/{img\|video\|audio\|export}-{id}/retry、/cancel | 🔒 fixed-proxy | 前端 | 否（决策项：随任务中心重构迁移或保留语义在 FastAPI 复刻 task_runtime_states upsert） | mock 语义复刻 | retry 后状态 queued、cancel 后 canceled |
| POST shots/{id}/images/generate | ❌ | 前端 | 否 | 静帧入队快照（frameRole/prompt/candidateCount/modelName） | 入队→Worker 认领 |
| POST storyboards/{id}/videos/generate | ❌ | 前端 | 否 | 视频入队+qualityReport 错误通道 | 非法参数 4011 |
| POST storyboards/{id}/lip-sync/generate | ❌ | 前端 | 否 | 口型入队 | 入队闭环 |
| POST videos/{id}/subtitles/remove | ✅ | 前端 | 是 | — | 既有 |
| POST videos/{id}/confirm | ❌ | 前端 | 否 | 最终视频确认事务 | 确认后 storyboard 回写 |
| GET /api/storyboards/{id}/videos | ❌ | 前端 | 否 | 列表读取 | 契约 |

### D-6 媒体与存储组

| Node 路由/设施 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|----------------|--------------|----------|----------|------|--------------|
| GET /generated/{frame\|audio\|video\|export}/...（4 条媒体路） | ➖（Nginx 直代 Node） | 前端（Nginx） | 否 | FastAPI 媒体服务：本地文件流+Range+权限校验 | 停 Node 后图片/音频/视频/导出可访问；Range 206/416 |
| GET /storage/{key} | ➖ | 前端、脚本 | 否 | COS 代理/预签名+权限校验；**注意现 Node 实现无签名校验**（L12926） | 越权访问被拒 |
| GET /mock/image、/mock/audio、/mock-assets/...png（3 条） | ➖ | 前端（mock 模式） | 否 | mock 媒体生成复刻（或 mock 模式由前端内联） | mock 模式回归 |
| /api/health | ➖ | compose healthcheck、FastAPI /ready | 否 | FastAPI /ready 去除 Node 探活 | 停 Node 后 /ready 200 |
| 导出 POST /api/projects/{id}/exports + queueExportJob | ❌ | 前端 | 否 | 导出任务入队 + **Worker 承接边界决策**（FFmpeg 在 Worker） | 导出全链路（入队→mp4 落盘→可播放） |

### D-7 Agent 内部端点与运维

| Node 路由 | FastAPI 现状 | 流量来源 | 已原生？ | 缺口 | 建议验收测试 |
|-----------|--------------|----------|----------|------|--------------|
| agent-pipeline 5 条（A-7） | ❌ | 前端 | 否 | run 表读写+阶段执行语义（执行体可留 Worker/进程内） | 幂等键去重、decision 后状态迁移 |
| script-agent activities 2 条（A-8） | ❌ | 前端 | 否 | 简单 CRUD+phase 枚举 | phase 等价类 |
| production-runs 写侧 4 条（A-9） | ❌ | 前端 | 否 | 创建、蓝图/检查点/阶段事务复刻 | 检查点门禁（blueprint canApprove）；列表与详情只读已迁移 |
| GET/PUT /api/model-settings | ❌ | 前端 | 否 | 模型设置读写（buildModelSettingsPayload/saveModelSettings） | 保存后 GET 一致 |
| GET /api/voice-profiles | ✅ | 前端 | 是 | — | 既有 |
| voice-cast/characters/character-images/voice 12 条（A-15 除 103） | ❌ | 前端 | 否 | 角色库 CRUD+AI 抽取（入队化）+音色绑定/参考音频存储 | 角色 upsert 幂等、改名 syncNameReferences |
| exports 列表/详情（100/102） | ❌ | 前端 | 否 | 简单读取 | 契约 |
| final-edit/final-edit-draft（98/99） | ❌ | 前端 | 否 | 成片编辑聚合+草稿校验 | 草稿归一化对照 |
| A-16 悬空调用域（market/jianying/delivery-package/cost-ledger/recovery/final-quality 等，Node 无路由） | ➖ | 前端（将 404） | ➖ | **无迁移需求**；第六阶段确认前端去留 | — |

## E. 汇总统计与风险

### E-1 统计

| 指标 | 数值 |
|------|------|
| Node pathname 匹配模式 / HTTP method 分支 | 83 / **约 118** |
| 其中：已由 FastAPI 原生覆盖（默认 flag 生效） | **31 条**（check-phone、login-password、projects 读写 5、assets/archive、audio 读、outline/story-bible/season-structure/tasks/scenes 只读 4、scene detail/script/storyboards 读写、storyboard PUT、reorder、voice-profiles、generation-jobs、generation retry/cancel、subtitles/remove、images confirm、shots images、audio-assets confirm/archive/PUT、project-assets archive） |
| 其中：固定代理（不受 flag 控制） | **2 处**（GET /api/storyboards/{id}；project-tasks mock 动作） |
| 其中：待迁移（Node 有、FastAPI 无原生） | **约 85 条**（含媒体服务 8 条、鉴权 6 条、generate 入队约 15 条、资产画布 10 条、agent/production 13 条、角色/配音 12 条、成片/导出 6 条、运维/杂项 15 条） |
| FastAPI 路由装饰器 / method 路由 | 32 / 35（native 30、fixed-proxy 2 处分支、fallback 1） |
| Node 侧死路由（无任何调用方） | **0**（全部路由均有前端/脚本/运维调用方） |
| 前端悬空调用函数（Node/FastAPI 均无路由，运行时 404） | **约 49 个**（A-16：market/*、jianying-draft、audio-library、delivery-package、cost-ledger、release-compliance、production-readiness、recovery-*、single-video-final-edit、final-quality-*、characters versions/locks/regression-samples、character-consistency、performance-plan、projects archive/restore） |

### E-2 风险 Top 5

1. **frameCharacterContext 固定代理（D-4 / L16098→main.py L516-523）**：单条 GET 分镜的派生字段无法原生，任何删除 Node HTTP 的动作都被它阻塞；Python 复刻必须先过 fixture 对照。
2. **captcha 进程内存会话 + SMS（D-1 / L348）**：Node 重启即丢失挑战会话；Python 化必须 MySQL 会话表 + provider adapter，切换期间两端会话不互通。
3. **FastAPI `/ready` 探活 Node + compose 双 depends_on（C-1/C-2）**：停止 backend 会让 api/frontend 服务判为不健康（快速失败有利但切换顺序必须先改 /ready 与 compose）。
4. **Nginx 四媒体路 + FastAPI OBJECT_STORAGE_PUBLIC_BASE_URL 默认 3001（C-1/C-2）**：媒体 URL 由 Node 产出并写库（storage_key/历史 URL），FastAPI 媒体服务需同时兼容本地流与 COS，历史 `/generated/...` URL 要重写或代理。
5. **前端约 49 个悬空调用 + vite dev 代理与 15+ 脚本默认打 3001（A-16/C-3/C-4）**：删除兜底代理后这些调用从「404」变为「连接失败」，页面表现可能恶化；脚本需统一 `API_ORIGIN` 指向 FastAPI。
