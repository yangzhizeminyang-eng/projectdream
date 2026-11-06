# ProjectDream 生成任务与任务中心组（/api/generation-jobs*、/api/project-tasks*）迁移规格


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 阶段 7.4 · 生成任务与任务中心组 API 迁移加固 · 2026-10-18（后续批次：视频/口型入队 + 视频确认）
>
> 本文档从 Node HTTP API（`server/index.mjs`，行号以 2026-10-17 工作区版本为准）只读提取行为规格。Node 侧源码为用户修改中文件，后续以 diff 复核。

## 1. 范围与接管状态总览

| # | 方法 | 路径 | 接管状态 | flag |
|---|------|------|----------|------|
| 1 | GET | `/api/generation-jobs/{id}` | ✅ 原生 | `API_NATIVE_GENERATION`（默认 true） |
| 2 | POST | `/api/project-tasks/generation-{id}/retry` | ✅ 原生 | 同上 |
| 3 | POST | `/api/project-tasks/generation-{id}/cancel` | ✅ 原生（恒 409） | 同上 |
| 4 | POST | `/api/project-tasks/{image\|video\|audio\|export}-{id}/(retry\|cancel)` | 🔁 固定代理 | Mock 语义（task_runtime_states UPSERT），Node 原生实现，无迁移收益 |
| 5 | POST | `/api/videos/{id}/subtitles/remove` | ✅ 原生 | 同上 |
| 6 | GET | `/api/voice-profiles` | ✅ 原生 | 同上 |
| 7 | GET | `/api/projects/{id}/tasks` | ✅ 原生 | 归 7.2 项目组 flag（`API_NATIVE_PROJECTS`） |
| 8 | POST | `/api/storyboards/{id}/videos/generate` | ✅ 原生（入队） | `API_NATIVE_GENERATION` |
| 9 | POST | `/api/storyboards/{id}/lip-sync/generate` | ✅ 原生（入队） | 同上 |
| 10 | POST | `/api/videos/{id}/confirm` | ✅ 原生（状态写） | 同上 |

flag 粒度：组级一个 flag。`API_NATIVE_GENERATION=false` 时 #1-#6、#8-#10 整条代理（含 mock 动作——原本即代理，行为不变）。

入队核心模式：FastAPI 只做「鉴权 + 校验 + request_json 快照构造 + INSERT generation_jobs」，Node Worker 直接消费任务表；快照构建器逐字段语义由 `tests/fixtures/generate_video_fixtures.mjs`（Node 直调 services 纯函数，51 case）+ `tests/test_generation_native_compat.py` 对照锁定。

## 2. 逐条路由规格（要点）

### 2.1 GET /api/generation-jobs/{id} —— Node L14447

归属联查（generation_jobs → projects）→ `generationJobRow`；id=0 与不存在统一 404/4004「生成任务不存在或无权访问」（Node `parseId("0")=0` → SQL 无行；FastAPI `db.get_generation_job(0)` 同结果）。

### 2.2 POST /api/project-tasks/generation-{id}/retry —— Node L14476

归属校验 → 非 failed/canceled → **409/4001**「只有失败或已取消的生成任务可以重试」→ 重试快照清洗（`repairVideoRetryReferences` + `providerTasks` 过滤：**复用 pending 任务与已完成 URL，只替换终态失败任务**——防重复付费的关键，FastAPI `database.py` retry 快照语义已对齐并有测试锁定）→ 置 queued → 重新入队 → 返回 `projectTaskItemRow`（taskKey=generation-{id}、status=queued、runtimeMessage「生成任务已重新加入队列」、canRetry/canCancel=false；job_type 映射：lip_sync→对白口型同步任务、video_image→动作视频生成任务、其余→图片生成任务）。

### 2.3 POST /api/project-tasks/generation-{id}/cancel —— Node L14494

**恒 409/4001**「当前供应商请求不支持安全取消，请等待本轮完成」——不产生状态变更。FastAPI 同形。

### 2.4 POST /api/project-tasks/{mock}-* —— Node L14549

Mock 语义：`parseTaskKey` 失败 → 400/4001「无效的 taskKey」；owner 校验 → `buildProjectTasksV2` 重查任务 → retry 为 task_runtime_states UPSERT（queued）→ 返回重查后的任务项「任务已重新加入队列（Mock）」；cancel 校验 canCancel → UPSERT canceled。**FastAPI 固定代理不迁移**（Node 原生实现，无迁移收益，代理透传测试已锁定）。

### 2.5 POST /api/videos/{id}/subtitles/remove —— Node L16843

归属联查 → `createGenerationJob`（subtitle_cleanup，request 快照含 storage_key/video_url/thumbnail/duration/model_name）→「字幕清理任务已加入后台队列」。
**有意收紧差异**：Node 每次调用 INSERT 新 job（无幂等）；FastAPI `db.enqueue_subtitle_cleanup` **对已有 queued/running 同源任务幂等复用**（README 已声明 + 测试锁定）——防重复入队积压，不回退。

### 2.6 GET /api/voice-profiles —— Node L17225

`{items: profiles, ageGroups, genders}`；`CHARACTER_AGE_GROUPS`/`CHARACTER_GENDERS` 目录（voice-profiles.mjs L27-39）与 FastAPI 硬编码逐字一致（五档年龄段 + 三档性别 + 中文 label）。

### 2.7 GET /api/projects/{id}/tasks —— Node L14431

`buildProjectTasksV2` 聚合（images/videos/audios/exports/generation_jobs + task_runtime_states）。FastAPI `task_center.py` 已对齐（7.2 归项目组 flag）。

### 2.8 POST /api/storyboards/{id}/videos/generate —— Node L16629 + L2941

鉴权 → storyboardId 非法 400/4001 → 分镜归属（storyboards↔script_scenes↔projects）→ `enqueueStoryboardVideoJob` 十道门禁（Python `_build_storyboard_video_job` 同序复刻）：视线/声音执行合同（409+qualityReport）→ 片段衔接帧引用（409+qualityReport）→ 资产引用门禁（409+qualityReport）→ 场景资产绑定（409）→ 锁定参考图完备性（409+qualityReport）→ 质检门禁（409+qualityReport，含未确认资产/私网图/音色缺失 blocker）→ 模型/服务商断言（400）→ 时长边界（400，normalizeStoryboardDurationSeconds 非法同 400）→ 场景/角色选中图缺失（409）→ 参考图上限（409）→ 引用快照校验（409+qualityReport）→ `createGenerationJob`（video_image，快照含 versionNo/motionMode/durationSeconds/candidateCount/videoInspectionExpected/modelName/videoProvider/generationMode/referencedAssets/referenceImages/referenceImageStorageKeys/referenceAudioUrls/frameReferences/imageRatio/storyboardAssetReference/promptSnapshot/providerTasks/autoConfirm）。清洗后提示词变化时回写 storyboards.visual_prompt（Node L3157 同款副作用）。幂等：同 project+job_type+source_id 的 queued/running 活动任务复用（video_image 无 viewType/viewKey 维度）。

此分镜工作流固定 `candidateCount=1`，并强制 `autoConfirm=false`；新一轮任务成功入队后，旧的 `candidate` 视频改为 `superseded` 保留历史，不删除媒体。启用跨镜头衔接时，Worker 以确认尾帧替换生成 MP4 的首帧，并在统一为 yuv420p 后比对首帧 `framemd5`；参考帧不可读、尺寸不匹配或哈希不一致时任务失败，不保存为可采用结果。用户确认仍只由 `/api/videos/{id}/confirm` 明确触发。

### 2.9 POST /api/storyboards/{id}/lip-sync/generate —— Node L16631 + L4381

鉴权 → storyboardId 非法 400/4001 → 分镜归属（含 LEFT JOIN characters 解析说话人名）→ `enqueueLipSyncJob` 门禁：说话角色绑定（409）→ 已确认对白音频（409，本镜角色优先排序）→ 音频存储确保（见 §3）→ 说话人归属一致（409 长文案）→ 静帧/源视频就绪（LIP_SYNC_PROVIDER 分支：toapi 需确认静帧；latentsync 需确认源视频；dashscope 可用源视频兜底）→ `createGenerationJob`（lip_sync，快照条件键与 Node undefined 语义一致：sourceVideo*/cropFilter/providerTaskId 仅命中时落快照；autoConfirm 默认 true；generationDurationSeconds 按 provider 取 4-15 / 3-119 取整）。错误统一 4011 + statusCode（无 qualityReport data）。

### 2.10 POST /api/videos/{id}/confirm —— Node L16880

鉴权 → videoId 非法 400/4001 → 归属联查（video_assets↔storyboards↔script_scenes↔projects）404/4004 → `normalizeGeneratedMediaUrl` 变化时事务外回写（Node 怪癖按原样保留：此后事务内条件更新必然 0 行 → 500）→ `resolveVideoConfirmationSource`：storage_key 命中 → 签名 URL（签名器不可用 → 409/4093）；本地 /generated/video 文件在位 → 原地址；缺失 → 409/4091；远端临时链接 → Node 走 persistGeneratedVideo 下载转存，FastAPI 有意收紧为 409/4092（见 §3）→ 事务：同镜旧 confirmed 归档、本行置 confirmed + quality_report_json 标注 `semanticStatus=accepted_by_user`/`reviewedAt`（COALESCE 保留原值）、回写 storyboards.video_url → 返回 `videoAssetRow`（签名 URL + 质量报告 JSON 解析）。

## 3. 已知保留差异（记录不修）

| 项 | Node | FastAPI | 理由 |
|----|------|---------|------|
| 字幕清理幂等 | 每次新建 job | active 同源任务复用 | 防重复入队；README 已声明 |
| 500 文案 | 泄漏 error.message | 脱敏固定文案 | 网关安全加固（阶段 0 起） |
| 非整数 ID | 404/4040 | 404/4040（7.2 兜底 handler，一致） | — |
| 视频确认远端临时链接 | persistGeneratedVideo：请求线程内下载 + COS 转存 + ffmpeg 抽尾帧 + 质检 | 恒 409/4092（同 Node 持久化失败文案） | FastAPI 网关不复制 Worker 语义（大文件下载/ffmpeg 依赖），引导用户改用本地版本或重新生成 |
| 口型入队音频存储确保 | ensureAudioAssetStorage：缺 storage_key 时请求线程内下载并转存 COS；命中时校验对象存在再签名 | storage_key 命中 → 签名 URL；缺 key → 原 audio_url 透传 | 网关无下载/转存能力；快照 audioUrl 语义不变（Worker 消费时可达） |
| 视频确认地址规范化怪癖 | 规范化回写（事务外）后事务内条件更新必然 0 行 → 500 | 同样保留（`touch_video_url` + 条件更新） | 忠实复刻存量行为，仅脏数据场景触发 |
| 参考音频签名 TTL | max(900, VIDEO_REFERENCE_AUDIO_SIGNED_URL_TTL_SECONDS \|\| 3600) | `OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS`（默认 3600，无 900s 下限） | 键级配置统一走 Settings；签名可达性一致 |

## 4. flag 回退核对矩阵

| 用例 | 断言 | 来源 |
|------|------|------|
| `API_NATIVE_GENERATION=false` | generation-jobs 读取 / retry / mock 动作 / voice-profiles / 字幕清理整条转发，Node envelope 原样透传 | [N] test_generation_group_compat |
| flag=true（默认） | 原生直连 DB，不触 upstream | [N] |
| flag 值非法 | Settings 构造期 ValidationError | [N] |
| flag 布尔等价类 | "1"/"yes" → True；"0"/"off" → False | [N] |

## 5. 未接管路由与前置条件

| 路由 | Node 位置 | 原因 |
|------|----------|------|
| POST `/api/asset-nodes/{id}/images/generate`（资产画布入队） | L14063 + L9914 | 形态确为入队（asset_node_image job），但其快照构建依赖 asset-canvas 提示词族（buildAssetNodeViewPrompt / buildCharacterAssetPackPrompt / buildSceneNineGridAnglePrompt / resolveAssetNodeGenerationPrompt / 身份锁与质量重试等约 15 个函数），Python 域层尚未复刻；按「不虚构实现」纪律留待资产画布组整体迁移 |
| `/api/projects/{id}/asset-canvas`（GET） | L13483 | 只读画布视图，非入队形态（核实结论：无 asset-canvas generate 路由） |
| POST `/api/characters/{id}/images` 等角色生成链路 | L17371+ | 归角色组（inventory 分组处置），非本组范围 |
| 成本台账 / 市场审计 / 对象存储验证 / 恢复队列等运维端点 | — | **核实结论：Node 无成本台账路由**（`/api/costs`、usage-records 等均不存在）→ 不迁移，标记悬空留第四阶段，不虚构实现 |
| POST `/api/projects/{id}/audio/generate`（L14677 音频段） | L14677 + L14719 | **核实结论：非入队形态**——同步生成音频候选并直接 INSERT audio_assets（不写 generation_jobs），归音频/资产组；本组仅核实归属，不迁移 |

## 6. 测试覆盖索引

- [N] = `tests/test_generation_group_compat.py`（7.4 新增 19 项：未登录/数据不存在/重复 retry 冲突/cancel 恒 409/字幕清理幂等/异常依赖/flag 专项）
- [F] = `tests/test_generation_native_compat.py`（快照构建器 fixture 对照：51 case 直调 Node services 产期望 + index.mjs 内部函数 buildTwoKeyframeVideoPrompt / buildReferenceAudioPromptContext / resolveReferenceAudioUrl 手工对照 + group 映射完备性与入队核心 group 覆盖断言）
- [E2] = `tests/test_generation_video_enqueue_compat.py`（视频/口型入队 + 视频确认端点：未登录/非法 id/越权/成功/幂等复用/未确认资产/方向合同失败/资产门禁/字段非法 4011/确认 4091-4093/本地文件在位/flag 回退/入队行字段完整性）
- [E] = `tests/test_contracts.py` 既有覆盖（job 形状与越权、retry 快照重用、mock 代理、字幕清理复用与跨用户、任务中心形状、voice-profiles 目录与鉴权）
