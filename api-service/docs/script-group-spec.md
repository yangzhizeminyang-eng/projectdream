# ProjectDream 剧本/分镜组（/api/scenes*、/api/storyboards*）迁移规格


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 阶段 7.3 · 剧本与分镜组 API 迁移加固 · 2026-10-17
> 阶段三-3 · 剧本/分镜组剩余（frameCharacterContext 复刻 + GET 原生化 + generate 端点）· 2026-10-17
>
> 本文档从 Node HTTP API（`server/index.mjs`，行号以 2026-10-17 工作区版本为准）只读提取行为规格，作为 FastAPI 网关已接管路由的对照基准。Node 侧源码为用户修改中文件，后续以 diff 复核。

## 1. 范围与接管状态总览

| # | 方法 | 路径 | 接管状态 | 说明 |
|---|------|------|----------|------|
| 1 | GET | `/api/projects/{id}/scenes` | ✅ 原生 | flag `API_NATIVE_SCRIPT` |
| 2 | GET/PUT | `/api/scenes/{id}` | ✅ 原生 | 同上 |
| 3 | PUT | `/api/scenes/{id}/script` | ✅ 原生 | 同上 |
| 4 | GET | `/api/scenes/{id}/storyboards` | ✅ 原生 | 同上 |
| 5 | GET | `/api/storyboards/{id}` | ✅ **原生（废除固定代理）** | frameCharacterContext 由 Python 复刻 + Node fixture 对照验收，见 §4.5 |
| 6 | PUT | `/api/storyboards/{id}` | ✅ 原生 | flag 同上 |
| 7 | POST | `/api/storyboards/reorder` | ✅ 原生 | 同上（语义有意收紧，见 §5） |
| 8 | POST | `/api/scenes/{id}/script/generate` | ✅ 原生 | 形态 (b) 同步 AI，见 §6.1 |
| 9 | POST | `/api/scenes/{id}/storyboards/generate` | ✅ 原生 | 形态 (b) 同步 AI + 资产门禁 + 事务替换，见 §6.2 |
| 10 | POST | `/api/projects/{id}/story-bible/generate` | ✅ 原生 | 形态 (b) 同步 AI（两段式），见 §6.3 |
| 11 | POST | `/api/projects/{id}/season-structure/generate` | ✅ 原生 | 形态 (b) 同步 AI，见 §6.3 |
| 12 | POST | `/api/storyboards/{id}/keyframes/optimize` | ✅ 原生 | 形态 (b) 同步 AI（本地兜底），见 §6.4 |
| 13 | POST | `/api/storyboards/{id}/continuity/start-frame` | ✅ 原生 | 纯 DB 事务（无 AI），见 §6.4 |
| 14 | POST | `/api/storyboards/{id}/split` | ✅ 原生 | 形态 (b) 同步 AI（兜底），见 §6.4 |
| 15 | POST | `/api/storyboards/{id}/dialogue/split` | ✅ 原生 | 形态 (b) 同步 AI（兜底），见 §6.4 |
| 16 | POST | `/api/storyboards/{id}/frame-prompt/rewrite` | ✅ 原生 | 形态 (b) 同步 AI（只读），见 §6.4 |
| 17 | POST | `/api/shots/{id}/images/generate` | ✅ 原生 | **形态 (a) 任务入队**，见 §6.5 |

flag 粒度：组级一个 flag（与 7.2 一致）。`API_NATIVE_SCRIPT=false` 时 #1-#4、#6-#9、#12-#16 整组代理；#10/#11 受 `API_NATIVE_PROJECTS`；#17 受 `API_NATIVE_ASSETS`（与其余静帧路由同组）。

## 2. 通用约定

- envelope/鉴权/4040 兜底与项目组规格一致（见 `project-asset-group-spec.md` §2/§3）；非整数路径参数由 7.2 新增的 RequestValidationError handler 统一 404/4040。
- 场景列表排序：Node `ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`（L15326），FastAPI `db.list_scenes` 同序。
- 分镜列表排序：Node 按 storyboard 主键序输出（DELETE+INSERT 重排后 id 序即排序序），FastAPI `db.list_storyboards` 按 `sort_order` 序返回，两者均「列表顺序 = 镜头顺序」，前端按序渲染。
- **AI 调用纪律**：generate 端点的文本模型调用全部经 `ai_provider.generate_structured_json`（async httpx），不落线程池、不阻塞事件循环；`AI_PROVIDER=mock`（默认）不发起真实请求——mock 语义与 Node 逐条一致（剧本/分镜走 mock 生成器，故事设定/分集大纲直接抛错不造假）。

## 3. 错误码矩阵（本组）

| code | HTTP | message | 触发 |
|------|------|---------|------|
| 4001 | 400 | 无效的 storyboardId / 无效的 shotId / 无效的 characterId | generate/PUT 的 id 校验 |
| 4001 | 400 | 分镜时长必须是有效整数（1-30 秒） | storyboard PUT durationSeconds 越界 |
| 4001 | 400 | 缺少排序数据 / 排序数据无效 / 排序数据必须属于同一场景 | reorder 校验 |
| 4001 | 400 | 视线/声音执行计划未通过校验：{blockers} | storyboard PUT direction 校验失败（**HTTP 422**） |
| 4001 | 400 | 请先写下你的创意，再生成故事设定 | story-bible generate 空 idea |
| 4001 | 400 | 请先生成并保存故事设定 | season-structure generate 无 bible |
| 4004 | 404 | 场景/分镜/项目/角色不存在或无权访问 | 归属校验 |
| 4004 | 400 | 场景没有剧本内容，请先在单场剧本模块生成或编辑剧本 | storyboards/generate 前置（Node 复用 4004 + HTTP 400） |
| 4010 | 401 | 未登录或登录已过期 | 全部 |
| 4011 | 409 | 上一镜头还没有已确认画面，无法承接 | continuity/start-frame 无源帧 |
| 4011 | 409 | 资产引用门禁未通过：N 个问题需要处理 | 静帧入队资产门禁 |
| 4011 | 409 | 角色「X」尚未确认定妆图，请先生成并确认角色定妆图（等 blockers[0]） | 静帧入队 frameCharacterContext 未就绪 |
| 4011 | 409 | 当前动作不适合继续拆分… / 当前对白只识别到一个说话角色… / 多人对白拆镜失败… / 当前分镜已经有{图片|视频或音频}素材… | split / dialogue/split 门禁 |
| 4011 | 409 | 当前图片生成通道 X 不支持定妆参考图输入… | 静帧入队 + FRAME_PROVIDER 能力断言 |
| 5020 | 502 | 当前为 mock 模式，不会真实调用模型生成{故事设定|分集大纲} | story-bible / season-structure（mock 语义） |
| 5020 | 502 | AI 生成超时… / 密钥无效… / 额度不足… / AI 请求失败：… | story-bible / season-structure 模型失败（error.message 透传，超时/密钥等走受控文案） |
| 5001 | 500 | 分镜时长规划校验未通过：… / 分镜资产引用门禁未通过：… / 模拟分镜时长规划无效：… | storyboards/generate 受控抛错（Node 该路由无 try/catch，全局 catch 500/5001 透传 message——怪癖保留） |
| 5001 | 500 | 服务暂时不可用，请稍后重试 | 非受控异常（DB 故障等，脱敏） |
| 4040 | 404 | 接口不存在 | 非整数路径参数（7.2 兜底） |

## 4. 逐条路由规格（要点）

### 4.1 GET /api/projects/{id}/scenes —— Node L15324

`ORDER BY episode_no ASC, sort_order ASC, scene_no ASC, id ASC`，`{items: sceneRow(...)}`。

### 4.2 GET/PUT /api/scenes/{id} —— Node L15620

- GET：`sceneRow(scene)`。
- PUT 白名单：title/summary/location/timeOfDay（null 或空串 → SET NULL，否则 String）+ estimatedDuration（`parseId` ≤0 忽略更新）；**无可识别字段 → 200 + 当前行 + message「场景无变更」，不发 UPDATE**（L15676-15680）。status 不在白名单（防误改）。
- 7.3 修复点：FastAPI 此前无可识别字段时误报「场景已保存」。

### 4.3 PUT /api/scenes/{id}/script —— Node L15604

content/mood/title 缺省回退当前行值（`!= null` 判定）；UPDATE + status='revised'；message「剧本已保存」。

### 4.4 GET /api/scenes/{id}/storyboards —— Node sceneStoryboardMatch

归属校验 → 全部分镜列表（Node 列表响应**不带** frameCharacterContext）。

### 4.5 GET /api/storyboards/{id} —— Node L16124 ✅ 原生（第三阶段第三组废除固定代理）

- 归属联查询与 Node 逐字一致（`COALESCE(c.name, s.character_name)` 覆盖 character_name、带出 project_id）→ `db.get_storyboard_detail`；角色库 `db.list_frame_characters`（九列、排除 archived、ORDER BY id ASC）。
- 响应 `{...storyboardRow, frameCharacterContext}`——`frameCharacterContext` 由 `app/domain/frame_character.py` 逐行为复刻 Node `resolveFrameCharacterContext`（含 voice-profiles 依赖子集）产出。
- **对照验收（硬要求）**：`tests/fixtures/frame_character_fixtures.json` 由一次性 Node 脚本调用真实实现生成（10 种形态：无角色/空值、单角色已确认、声音角色绑定、画外音显式离屏、缺定妆图、多角色同框、绑定 id 直连、角色名无法匹配、角色标签多义、声音角色可见人物未点名），pytest 断言 Python 输出与 fixture 逐字段一致。fixture 再生成命令（仓库根目录）：

  ```bash
  node api-service/tests/fixtures/generate_frame_fixtures.mjs
  ```

  pytest 运行期不调用 Node（CI 零 Node 依赖）。
- 前端消费面（FrameGenerate.vue / production-studio.ts）：ready / blockers[0] / characterFree / characters[].name 与生成约束面板，全部在复刻字段内。

### 4.6 PUT /api/storyboards/{id} —— Node L16140

- 字段映射：shotType/cameraAngle/composition/durationSeconds/characterId/characterName/actionText/dialogueText/visualPrompt|videoPrompt/startVisualPrompt/endVisualPrompt/imageUrl/endImageUrl/status。
- **videoPrompt 优先**：videoPrompt 与 visualPrompt 同写 `visual_prompt` 列；同时传时 Node 忽略 visualPrompt（7.3 前 FastAPI 反向优先，已修复）。
- characterId：null → 置 NULL；非数字/0/负数 → 400/4001；跨项目 → 404/4004「角色不存在或不属于当前项目」；命中且未传 characterName → 自动补 `character["name"]`。**Node 查询不过滤 archived**（FastAPI 7.3 前误过滤，已修复）。
- **仅传 characterName**：按名称查同项目角色（`ORDER BY id ASC LIMIT 1`）→ characterId 更新为解析结果（未命中置 NULL），characterName 保持传入值（7.3 新增该分支）。
- durationSeconds：Node `normalizeStoryboardDurationSeconds` 抛异常被兜底成 **500/5001**（校验错误按服务端错误返回的缺陷）；FastAPI 保持 **400/4001**——有意保留差异。
- gazePlan/soundPlan（含 snake_case 变体）编辑 → `validateStoryboardDirectionContract` → 失败 **HTTP 422** + 4001（FastAPI 同形）；通过后合并进 assetReference（performance.gazePlan/soundPlan 同步）。
- 空更新（无任何字段）→ 不发 UPDATE，回读返回「分镜已保存」。

### 4.7 POST /api/storyboards/reorder —— Node L16354

Node：逐条 `parseId`，**id 无效静默 continue**，逐条 UPDATE（JOIN 限定归属），无同场景校验、无事务，恒成功。
**FastAPI 有意收紧（保留不回退）**：全量校验（int/bool 拒绝/id>0/sortOrder 0-4294967295/去重）→ 失败 400/4001；事务批量更新 + 同场景校验（cross_scene → 400/4001）。README L92-94 已声明，test_contracts 已锁定。

## 5. 7.3 变更清单（历史）

| # | 修复 | Node 行为 | 修复前 FastAPI 行为 | 位置 |
|---|------|----------|--------------------|------|
| 1 | 场景 PUT 空变更 | 200 + 「场景无变更」，不发 UPDATE | 误「场景已保存」 | `app/main.py` get_scene |
| 2 | videoPrompt 优先 | videoPrompt 覆盖 visual_prompt | 同时传时反向用 visualPrompt | storyboard PUT |
| 3 | characterName 名称解析 | 按名称解析角色回填 characterId（未命中置 NULL） | 只透传字符串，不动 characterId | storyboard PUT + `db.find_character_by_name`（新增） |
| 4 | 角色查询不过滤 archived | `WHERE id AND project_id` | 误加 `status <> 'archived'`，已归档角色被 404 | `db.character_in_project` |
| 5 | ~~单条 GET 固定代理~~ → **第三阶段第三组已废除**，见 §4.5 | — | — | — |
| 6 | flag 回退 | — | 本组无回退路径 | `config.py` 新增 `API_NATIVE_SCRIPT`，6 条路由加守卫 |

有意保留差异（记录不修）：
- durationSeconds 非法：Node 500/5001（泄漏 message），FastAPI 400/4001。
- reorder 收紧语义（§4.7）。
- estimatedDuration 小数（如 2.7）：Node 写 2.7 由 MySQL round，FastAPI 忽略更新（int 解析失败）。

## 6. generate 端点规格（第三阶段第三组新增）

形态判定结论：**组内全部 generate/写路由在 Node 中均为「同步 AI 调用」形态（HTTP 请求-响应内 await AI），不写 generation_jobs、不走 agent-pipeline**；唯一例外是静帧 `shots/{id}/images/generate`（enqueueFrameImageJob → generation_jobs 任务入队，Worker 消费）。agent-pipeline（agent_runs）与剧本组 generate 无交集（资产解析 pipeline 独立路由族）。

### 6.1 POST /api/scenes/{id}/script/generate —— Node L15548 · 形态 (b)

scene+project 联查（404/4004）→ bible/season/outline 最新行 → `generateSceneScript`（mock 生成器 / 真实调用失败 fallbackToMock 回退 mock）→ UPDATE title/summary/content/mood/location/time_of_day/estimated_duration + status='generated' → sceneRow，message「剧本已生成」。AI 链路未捕获异常 → 500/5001（Node 全局 catch；FastAPI 走脱敏兜底——差异见 §7）。

### 6.2 POST /api/scenes/{id}/storyboards/generate —— Node L15713 · 形态 (b)

- 前置：scene.content 空 → **400/4004**（Node 复用 4004 + HTTP 400）。
- 角色：项目角色过滤「正文出现姓名」（Node L15743 同款）。
- 资产目录：`buildStoryboardAssetCatalog`（确认图 + vision passed/skipped 分组）。
- RAG：Node 走 rag-service（indexRagDocuments/queryRagDocuments，degraded 降级继续）；FastAPI 等价降级为空上下文（degraded 语义一致，rag-service 对接为既有 adapter 职责）。
- `generateStoryboards`：mock 走确定性规则生成器（时长契约 + 视频模型区间校验，失败抛错）；真实模式两次尝试带纠错提示，契约失败 → `分镜 Agent 两次输出均未通过时长规划校验`；供应商失败 fallbackToMock 回退 mock。
- 路由侧：`validateStoryboardDurationContracts(requireVisibleTimeline)` 失败 → `分镜时长规划校验未通过：…`；资产行（事务期查询允许 vision NULL）逐镜头解析 characterAsset/三视图资产板/场景全景/道具 → blocker 汇总 → `分镜资产引用门禁未通过：…`。两者均为受控抛错 → **500/5001 + message 透传**（Node 全局 catch 形态，FastAPI 以专用 exception handler 保留）。
- 事务：DELETE 整场分镜 + INSERT + scene status='storyboard_ready' + project status='storyboarding'（`db.replace_scene_storyboards`）。
- 响应 `{items: storyboardRow[]}`，message「分镜已生成」；visual_prompt 经 `buildStoryboardMentionedPrompt` 补齐 @角色/@场景/@道具/@工具 引用。

### 6.3 story-bible / season-structure generate —— Node L13127/L13148 · 形态 (b)

- story-bible：idea 必填（400/4001）→ `generateStoryBible` **两段式真实调用**（core + world，maxTokens 5200/3200、thinking disabled），mock 模式直接 502/5020（不造假设定，Node 刻意不走 fallbackToMock）→ `normalizeStoryBibleInput` → `evaluateStoryBible` → `persistStoryBible`（version_no 递增，draft）→ `{item: storyBibleRow, report}`，message「故事设定已生成」。失败 502/5020（error.message 透传；超时/密钥/额度走受控文案，不泄漏 sk-）。
- season-structure：无 bible → 400/4001「请先生成并保存故事设定」→ `generateSeasonStructure`（episodes 逐集归一，缺 title/logline 抛「模型返回的分集大纲不完整」）→ `evaluateSeasonStructure`（含 marketQuality）→ persist → `{item, report}`，message「分集大纲已生成」。

### 6.4 storyboard 四条 AI 端点 —— Node L16265-L16350 · 形态 (b)

- **keyframes/optimize**：director context → `generateStructuredJson('storyboard-keyframe-prompts')`，**AI 失败/mock 一律走 `simpleKeyframePromptFallback` 本地规则**（不报错）→ UPDATE 两帧 → `{storyboard, startVisualPrompt, endVisualPrompt, notes}`，message「两帧提示词已优化」。
- **continuity/start-frame**：**纯 DB 事务**（无 AI）：上一镜确认帧（end 优先）→ 插入 confirmed 起始帧 + promptSnapshot「承接上一镜头 X 的Y作为本镜头起始帧。」→ 回写 image_url/start_visual_prompt。无源帧 409/4011；响应 `{storyboard, image, sourceStoryboardId, sourceShotNo}`，message「已承接上一镜头」。
- **split**：素材门禁（已有图片素材 → 409/4011 Node 文案逐字；仅承接起始帧豁免）→ AI（mock 失败走 `fallbackSubShots` 两段兜底）→ normalizeSubShots（<2 → 409/4011「当前动作不适合继续拆分…」）→ 事务（后续 sort_order 后移 + 首条 UPDATE 原行 + 其余 INSERT，asset_reference 继承视线/声音计划）→ `{items, current, createdCount}`，message「子分镜已拆分」。
- **dialogue/split**：素材门禁同上 → 本地轮次解析（<2 行 → 409/4011；单说话人 → 409/4011）→ AI（mock 失败走轮次兜底）→ normalizeDialogueSubShots（<2 → 409/4011）→ 事务（首条同步覆盖 character_id/character_name）→ `{items, current, createdCount, speakers}`，message「多人对白已拆分为可做口型的短分镜」。
- **frame-prompt/rewrite**：rewrite context（额外 LEFT JOIN 总纲）+ 最新 frameCharacterContext → `rewriteFrameVisualPrompt`（mock/真实失败走 `buildMockVisualPrompt` 兜底）→ **只读不落库**（Node 同），响应 `{visualPrompt, notes, frameCharacterContext}`，message「视觉提示词已重写」。
- 以上四条：路由层 catch 受控异常 → **4011 + error.statusCode（默认 400）**（Node 形态）；分镜缺失 404/4004；id 无效 400/4001。

### 6.5 POST /api/shots/{id}/images/generate —— Node L16410 + enqueueFrameImageJob(L2862) · **形态 (a) 任务入队**

- 门禁链：shot 归属（404/4004）→ `inspectStoryboardAssetReferenceGate`（requireCharacter=bool(character_id||character_name)）→ `resolveFrameCharacterContext.ready`（blockers[0]）→ `buildFrameConsistencyPrompt`（frameRole 兜底提示词 + projectVisualStyle）→ `assertFrameReferenceImageSupport`（FRAME_PROVIDER 能力表；trae-url/bigmodel/zhipu/mock 不支持参考图 → 409/4011）。
- 入队：`createGenerationJob`——request 快照 `{shotId, versionNo(MAX+1), frameRole, candidateCount(1-3), modelName, promptSnapshot, negativePrompt, characterSnapshot(createFrameCharacterSnapshot), referenceImageUrls}` + projectId；**幂等：同 project+job_type+source_id 的 queued/running 活动任务直接复用**（Node 同款，业务幂等键等价 `{task_type}:p{project}:{business_ref}`）。付费图片供应商调用发生在 Worker（`processFrameGenerationJob`），FastAPI 请求线程内零付费调用。
- 响应 generationJobRow，message「静帧生成任务已提交」。错误形态：id 无效 400/4001；缺失 404/4004；门禁 409/4011（Node 路由 catch `error.statusCode || 400` 形态）。

## 7. 第三阶段第三组差异记录

有意保留 / 记录的差异（不修）：
1. **500 文案脱敏**：Node 全局 catch 透传 `error.message`；FastAPI 非受控异常固定「服务暂时不可用」。受控业务抛错（时长契约/资产门禁/mock 时长规划无效）以专用 exception handler 保留 Node 同形（500/5001 + 受控 message）。
2. **RAG**：Node 走 rag-service HTTP（degraded 降级）；FastAPI 当前等价降级为空上下文（degraded 分支语义一致；rag-service 接入走既有 `rag_adapter`，不阻塞本组）。
3. **scene script generate 未捕获 AI 异常**：Node 500/5001 透传 message；FastAPI 500/5001 脱敏（fallbackToMock 默认 true 时该路径实际不可达）。
4. 视频模型时长区间（`getConfiguredVideoDurationRange`）按 env（VIDEO_MODEL/VIDEO_PROVIDER）判定，默认 1-30——与 Node 默认分支一致。

## 8. 测试覆盖索引

- [N] = `tests/test_script_native_compat.py`（第三阶段第三组新增 32 项：GET 原生形状在 test_script_group_compat；generate 端点成功/字段非法/数据不存在/越权/异常依赖/幂等/envelope/flag 回退/eval 校验器回归）
- [F] = `tests/test_frame_character_fixtures.py`（14 项：10 形态 Node fixture 逐字段对照 + 覆盖面 + snapshot/prompt 形状）
- [E] = `tests/test_contracts.py` 既有覆盖（场景/分镜读取、白名单更新、剧本 revised、reorder 三态、时长与 direction 校验），单条 GET storyboard 断言随本次原生化移交 [N]/[F] 覆盖
- fixture 再生成：`node api-service/tests/fixtures/generate_frame_fixtures.mjs`（一次性 Node 脚本，不进 pytest 运行路径）
