# ProjectDream 项目组 / 资产组（/api/projects*、/api/project-assets* 等）迁移规格


> **第四阶段状态（2026-10-19）**：本文所述 `API_NATIVE_*` 回退开关、`proxy_api` 代理与
> `node_upstream_url`/`node_readiness_timeout_seconds`/`proxy_timeout_seconds` 配置
> **已移除（第四阶段）**——对应组恒为原生实现，回退代理专项测试随实现一并删除；
> 静态扫描守卫 `api-service/tests/test_no_node_dependencies.py` 防止回归。
> 下文对 flag/代理的描述仅作迁移过程历史记录，不再反映当前实现。

> 阶段 7.2 · 项目与资产组 API 迁移加固 · 2026-10-17
>
> 本文档从 Node HTTP API（`server/index.mjs`，行号以 2026-10-17 工作区版本为准）只读提取行为规格，作为 FastAPI 网关（`api-service/`）已接管路由的对照基准与回退依据。Node 侧源码为用户修改中文件，本文档不伴随其改动自动更新，后续以 diff 复核。

## 1. 范围与接管状态总览

| # | 方法 | 路径 | 接管状态 | 分组 flag（回退开关） |
|---|------|------|----------|----------------------|
| 1 | GET | `/api/projects` | ✅ 原生 | `API_NATIVE_PROJECTS`（默认 true） |
| 2 | POST | `/api/projects` | ✅ 原生 | 同上 |
| 3 | GET/PATCH | `/api/projects/{id}` | ✅ 原生 | 同上 |
| 4 | GET | `/api/projects/{id}/outline` | ✅ 原生 | 同上 |
| 5 | GET | `/api/projects/{id}/story-bible` | ✅ 原生 | 同上 |
| 6 | GET | `/api/projects/{id}/season-structure` | ✅ 原生 | 同上 |
| 7 | GET | `/api/projects/{id}/audio` | ✅ 原生 | 同上 |
| 8 | GET | `/api/projects/{id}/tasks` | ✅ 原生 | 同上 |
| 9 | GET | `/api/projects/{id}/assets` | ✅ 原生 | `API_NATIVE_ASSETS`（默认 true） |
| 10 | POST | `/api/project-assets/{type}/{id}/archive` | ✅ 原生 | 同上 |
| 11 | POST | `/api/audio-assets/{id}/confirm` | ✅ 原生 | 同上 |
| 12 | POST | `/api/audio-assets/{id}/archive` | ✅ 原生 | 同上 |
| 13 | PUT | `/api/audio-assets/{id}` | ✅ 原生 | 同上 |
| 14 | POST | `/api/images/{id}/confirm` | ✅ 原生 | 同上 |
| 15 | GET | `/api/shots/{id}/images` | ✅ 原生 | 同上 |

flag 粒度决策：鉴权组（7.1）按单路由开 flag（2 条各一个）；本组共 15 条，逐条开 flag 维护成本高且无独立灰度诉求，故**按组粒度**各开一个 flag。flag 为 `false` 时对应组整条代理给 Node（`proxy_api`，`app/main.py`），透传语义与 7.1 完全一致（剔除 host/content-length、追加 `x-forwarded-by`、Node 网络失败 → 502/5020）。

flag 值解析：布尔字符串等价类（`"0"/"no"/"off"` → False；`"1"/"yes"/"on"` → True）；非布尔字符串在 Settings 构造期抛 ValidationError（快速失败，不静默回退）。

## 2. 通用约定（Node 侧语义提取）

- **envelope**：`success(res, data, message='success')` → 200 + `{"code":0,"message","data"}`（index.mjs L6258）；`fail(res, code, message, statusCode=400)` → `{"code","message","data":extra||null}`（L6262）。**注意成功 message 缺省是 "success"**——7.2 前空数据路由误写 "ok"，已修复（§5）。
- **鉴权**：所有路由 `authenticate(req, res)` 先行；失败 401/4010「未登录或登录已过期」。FastAPI `require_user` 同语义。
- **路径参数形态**：Node 全部用 `(\d+)` 正则匹配——非整数 ID 不构成路由 → 兜底 404/4040「接口不存在」（L18352）；ID 为 `0` 时匹配成功但 `parseId("0")=0` falsy → 400/4001。
- **排序与分页**：本组路由**全部无分页**（一次性全量返回）。排序语义逐条见 §4；FastAPI `database.py` 已逐条对齐同一 ORDER BY。
- **事务语义**：Node 对「音频确认（降级同轨旧主版本）」「静帧确认（降级同位候选 + 回写分镜图 URL）」用显式事务包裹；FastAPI `database.py` 对应方法在单连接事务内执行同等多语句。
- **媒体 URL/COS 签名**：仅 `GET /api/projects/{id}/audio` 需要（storage_key → 签名 URL，HMAC-SHA256/COS 契约，`media_urls.py` 复刻）；资产聚合列表的 previewUrl/videoUrl/audioUrl 均为**直通原值不做签名**，与 Node 一致。

## 3. 错误码矩阵（项目组/资产组）

| code | HTTP | message（Node 原文） | 触发路由 |
|------|------|---------------------|----------|
| 4001 | 400 | 项目名不能为空 | POST /api/projects、PATCH name 空白 |
| 4001 | 400 | 项目名不能超过 200 个字 | PATCH name > 200 |
| 4001 | 400 | 作品类型不能超过 80 个字 | PATCH category > 80 |
| 4001 | 400 | 画面比例「{v}」无法解析，请使用 16:9、9:16、2.39:1 这类格式 | PATCH aspectRatio 不可解析 |
| 4001 | 400 | 请求内容无效 | PATCH body 非对象 |
| 4001 | 400 | 不支持的字段：{fields}；可更新字段为 name、category、narrativeVision、visualStyle、aspectRatio | PATCH 未知字段 |
| 4001 | 400 | 没有可更新的字段 | PATCH 无有效字段 |
| 4001 | 400 | 无效的项目资产参数 | archive 的 assetId=0 |
| 4001 | 400 | 项目资产已经归档 | archive 时状态已是 archived |
| 4001 | 400 | 已确认或定稿资产不能直接归档 | archive 时状态 confirmed/finalized |
| 4001 | 400 | 已完成资产不允许直接归档 | archive 时状态 done |
| 4001 | 400 | 无效的 audioId / imageId / shotId / projectId | 对应 id=0 |
| 4001 | 400 | 已确认主版本不允许直接归档 | audio archive 时 status=confirmed |
| 4004 | 404 | 项目不存在或无权访问 | 项目不存在/非本人（含各子资源挂靠项目） |
| 4004 | 404 | 项目资产不存在或无权访问 | archive 资产不存在/非本人 |
| 4004 | 404 | 音频资产不存在或无权访问 | audio confirm/archive/placement |
| 4004 | 404 | 分镜不存在或不属于当前项目 | audio placement 的 storyboardId 跨项目 |
| 4004 | 404 | 静帧不存在或无权访问 | image confirm |
| 4004 | 404 | 分镜不存在或无权访问 | shots images |
| 4010 | 401 | 未登录或登录已过期 | 全部 |
| 4040 | 404 | 接口不存在 | 非整数 ID / 未知资产类型（URL 正则不匹配兜底） |
| 5001 | 500 | （Node 泄漏 error.message；FastAPI 脱敏为「服务暂时不可用，请稍后重试」） | 数据库故障 |

> 有意保留的脱敏差异：Node 500 会把底层 error.message 原样返回（L18355），FastAPI 自阶段 0 起统一脱敏为 5001 固定文案。此项是网关侧安全加固，不回退对齐。

## 4. 逐条路由规格（要点）

### 4.1 GET /api/projects —— Node L12489

`SELECT p.* + 七个聚合子查询 + 最新 completed 导出`，`ORDER BY p.created_at DESC, p.id DESC`；返回 `{items: rows.map(projectRow)}`。`projectRow`（L6838）基础 DTO + 有聚合列时追加 progressPercent/progressStage/progressDetails/progressComplete。

### 4.2 POST /api/projects —— Node L12563

`name=String(body.name||'').trim()`；空 → 400/4001「项目名不能为空」；INSERT（status='draft'）后回读返回 `projectRow` + message「项目创建成功」。**同名不拦截**，重复创建各自成行。可写入字段：name/category/targetDuration/narrativeVision/visualStyle/aspectRatio（其余字段静默丢弃）。

### 4.3 GET/PATCH /api/projects/{id} —— Node L15196（projectMatch）

- GET：归属校验后返回 `projectRow(raw)`——**原始行无聚合列，响应不含 progress 字段**（FastAPI `test_project_detail_keeps_node_raw_project_dto_shape` 锁定）。
- PATCH：`normalizeProjectUpdateInput`（`server/services/project-settings.mjs`）——非对象 → 「请求内容无效」；未知字段全量列出报错；字段校验按**固定顺序 name→category→narrativeVision→visualStyle→aspectRatio**，返回第一个错误；name 空 → 4001、>200 → 超长；category 空 → 置 NULL、>80 → 超长；aspectRatio 空 → 置 NULL，非空须可解析（`canvasFromRatioLabel`：任意 `W:H`/`W：H`/`W/H`、两侧正数、支持小数 + 特殊标签「自适应」/「auto」）；全部空 → 「没有可更新的字段」。UPDATE 后回读返回 + 「项目设置已保存」。

### 4.4 GET /api/projects/{id}/outline | story-bible | season-structure —— Node L15233 / L13101

归属校验 → 最新一条（`ORDER BY version_no DESC, id DESC LIMIT 1`）→ `success(row)`；**无数据时 `success(res, null)`，message 为默认 "success"**（7.2 对齐修复点，§5-3）。

### 4.5 GET /api/projects/{id}/audio —— Node L14690

多轨排序：`CASE track_type（dialogue<narration<music<sfx<其他）→ scene_id ASC → character_id ASC → version_no DESC → id DESC`；LEFT JOIN 场景/分镜/角色补名称；`audio_asset_row` 映射；FastAPI 侧追加 COS 签名 audioUrl（仅当 storage_key 可解析）。

### 4.6 GET /api/projects/{id}/tasks —— Node L14430

任务中心聚合（images/videos/audios/exports/generation_jobs + task_runtime_states 运行态），`build_project_tasks` 组装。生成任务 retry/cancel 动作属阶段 7.4 范围。

### 4.7 GET /api/projects/{id}/assets —— Node L12609

`buildProjectAssets`（L11017）：characters（status<>'archived'，`updated_at DESC, id DESC`）+ images/videos/audio（status<>'archived'，`created_at DESC, id DESC`）→ `assetItemRow` 扁平 items + summary 计数（totalCount/characterCount/imageCount/videoCount/audioCount/confirmedImageCount/confirmedVideoCount/confirmedAudioCount）。

### 4.8 POST /api/project-assets/{type}/{id}/archive —— Node L12626

URL 正则 `(character|image|video|audio)` **大小写敏感**；归属联查（image/video 经 storyboard→scene→project）；`canArchiveProjectAsset` 保护策略（archived→「项目资产已经归档」；confirmed/finalized→「已确认或定稿资产不能直接归档」；done→「已完成资产不允许直接归档」）；UPDATE status='archived'；成功 data `{id, assetType, status:"archived"}` + 「项目资产已归档」。

### 4.9 POST /api/audio-assets/{id}/confirm —— Node L16994

归属校验 → **事务内**：同 project+track_type+scene_id+storyboard_id+character_id（`<=>` NULL 安全等价）且 status='confirmed' 的其他行降级 candidate → 本行置 confirmed+confirmed_at。成功 message「音频轨道已确认」。

### 4.10 POST /api/audio-assets/{id}/archive —— Node L17073

status=confirmed → 400/4001「已确认主版本不允许直接归档」；否则归档后回读（含 join 名称）返回「音频候选已归档」。

### 4.11 PUT /api/audio-assets/{id} —— Node L17126

`body.storyboardId !== undefined` 时校验分镜属于本项目（否则 404/4004「分镜不存在或不属于当前项目」），且 scene_id 跟随分镜的 scene_id（解绑分镜时保留原 scene 归属）；`startOffsetSeconds` 缺省不动、提供时钳位 [0,60]；定位保存 message「音频时间线定位已保存」。

### 4.12 POST /api/images/{id}/confirm —— Node L16565

**事务内**：同 storyboard 同 frame_role（normalize 后 start/end/primary）其他行降级 candidate → 本行 confirmed → 回写 storyboards.image_url / end_image_url（按 role）。message「静帧已确认」。

### 4.13 GET /api/shots/{id}/images —— Node L16383

归属校验 → 该分镜全部静帧（`version_no DESC, id DESC`，FastAPI stub 与 MySQL 实现均同序）→ `{items: imageAssetRow(...)}`。

## 5. 7.2 变更清单（兼容修复 + 加固）

| # | 修复 | Node 行为 | 修复前 FastAPI 行为 | 位置 |
|---|------|----------|--------------------|------|
| 1 | aspectRatio 校验放宽 | 任意 `W:H/W：H/W/H`（正数、支持小数）+ 自适应/auto | 固定白名单，误拒 16:10、1.85:1、3/2 等 | `app/main.py` `_is_valid_aspect_ratio`（re.ASCII 对齐 JS \d） |
| 2 | PATCH 错误优先级 | 固定顺序 name→category→…→aspectRatio | `PROJECT_UPDATE_FIELDS` 为 set，遍历序随哈希漂移 | 改为 tuple 固定顺序 |
| 3 | 空数据 message | `success(res, null)` → "success" | 误写 "ok"（outline/story-bible/season-structure） | 3 处改 `success(None)`；test_contracts 3 处断言同步更新 |
| 4 | 资产类型校验 | URL 正则精确小写匹配，未知/大写类型 → 兜底 404/4040 | `.strip().lower()` 放行大写；未知类型误 400/4001 | archive 路由拆分：类型不在集合 → 404/4040；id<=0 → 400/4001 |
| 5 | 非整数路径参数 | Node URL 正则不匹配 → 404/4040「接口不存在」 | FastAPI 路径参数注解校验失败 → 422 裸 pydantic 形状 | 新增 `RequestValidationError` handler：/api/* → 404/4040；非 /api（内部端点）保留 422 |
| 6 | flag 回退 | —（本组此前无回退路径） | — | `config.py` 新增 `API_NATIVE_PROJECTS`/`API_NATIVE_ASSETS`；15 条路由头部加组级守卫 |

已知保留差异（记录不修）：
- **负数 ID**：Node `\d+` 不匹配 → 404/4040；FastAPI int 注解接受负数 → 走业务查询 → 404/4004（项目）或 400/4001（id<=0 分支）。前端从不产生负数 ID，无真实调用方。
- **500 文案**：Node 泄漏 error.message，FastAPI 脱敏固定文案（安全加固，见 §3）。

## 6. flag 回退核对矩阵

| 用例 | 断言 | 来源 |
|------|------|------|
| `API_NATIVE_PROJECTS=false` | GET/POST /api/projects、PATCH detail 整条转发（未登录也代理，body 原样透传），Node envelope 原样返回 | [N] test_project_asset_group_compat |
| `API_NATIVE_ASSETS=false` | assets 列表代理透传 | [N] |
| flag=true（默认） | 原生直连 DB，不触 upstream（upstream 不可达仍 200） | [N] |
| 非整数 ID（flag=true） | 落代理 → Node 兜底 404/4040 原样透传（原生与代理模式下行为一致） | [N] |
| flag 值非法 | Settings 构造期 ValidationError | [N] |
| flag 布尔等价类 | "0"/"no"/"off" → False；"1"/"yes"/"on" → True | [N] |

## 7. 未接管的项目/资产写路由与前置条件

> 阶段 3.5（FastAPI-Only 迁移第三阶段第五组，2026-10-18）已接管 §7 前表中的大部分路由，见 §9；
> 下表为**当前仍未接管**的剩余项。

| 路由/能力 | Node 位置 | 未接管原因与前置条件 |
|-----------|----------|---------------------|
| POST /api/projects/{id}/outline/generate（旧版总纲重生成，4090 拦截已有分集剧本） | L15248 | 触发 AI 生成 + 事务内清空场景/分镜，付费副作用（属其他迁移组） |
| PUT/POST story-bible\|season-structure 的 evaluate/lock/generate | L13101 | AI 生成 + 质量评估 + 锁定状态机（属其他迁移组） |
| POST /api/projects/{id}/audio/generate | L14719 | 付费 TTS 入队（属其他迁移组） |
| POST /api/projects/{id}/scenes/generate | L15333 | 场景解析 Agent（属其他迁移组） |
| POST /api/projects/{id}/characters/generate（AI 抽取角色，upsert by name） | L17393-L17559 | `aiGenerateCharacters` 依赖文本模型多轮生成 + `persistParsedCharacters`/`archiveStaleCharacterRecords`/`repairNarrativeRoleCharacterRecords` 三段修复事务；需 Eval 样本后入队化 |
| POST /api/characters/{id}/generate-profile（AI 补全档案） | L17733 | `aiGenerateCharacterProfile` 文本模型同步调用 |
| POST /api/characters/{id}/voice-preview（同步 TTS 试听） | L17783+ | 真实 TTS 供应商（DashScope voiceDesign/qwen 试听）；mock 分支语义保留在 Node，建议随音频生成入队化一并迁移 |
| GET /api/shots/{id}/images/generate | L16410 | 已由阶段 3.4 迁移（frame_image 入队），此处勘误 |

前置条件共性：① 付费/队列语义归 Worker（保持 Node/Worker 承接）；② AI 生成与状态机需先有 Eval 样本与契约测试。

## 8. 测试覆盖索引

- [N] = `tests/test_project_asset_group_compat.py`（7.2 新增 52 项：修复点回归 + 七类场景 + 同 fixture 双侧对照 + flag 专项）
- [E] = `tests/test_contracts.py` 既有覆盖（成功形状/越权/归档保护/音频确认降级/定位钳位/任务中心等），其中 3 处空数据断言随 §5-3 同步更新为 "success"

## 9. 阶段 3.5：项目/资产组剩余（资产画布 + 角色库 + 项目删除/导出包）

> 2026-10-18 · FastAPI-Only 迁移第三阶段第五组。本节记录本组接管状态、提示词 fixture 命令与差异记录。
> 测试：`tests/test_asset_canvas_native_compat.py`（134 项）+ `tests/test_characters_native_compat.py`（36 项），
> 全量套件 995 passed（含既有 825 项，零断言更新）。

### 9.1 接管路由清单

| 组 | 路由 | Node 行号 | 回退 flag |
|----|------|----------|----------|
| A 资产画布 | GET /api/projects/{id}/asset-canvas（读时自愈链） | L13483-13679 | `API_NATIVE_ASSETS` |
| A | POST /api/projects/{id}/asset-nodes | L13681-13801 | 同上 |
| A | PATCH/DELETE /api/asset-nodes/{id} | L13968-14045 | 同上 |
| A | POST /api/asset-nodes/{id}/relink-scene | L13806-13878 | 同上 |
| A | POST /api/asset-nodes/{id}/hydrate-prompt | L13879-13967 | 同上 |
| A | GET /api/asset-nodes/{id}/images | L14047-14062 | 同上 |
| A | POST /api/asset-nodes/{id}/images/generate（入队，幂等复用同 3.4 模式） | L14063-14079 + L9914 | 同上 |
| A | POST /api/asset-node-images/{id}/confirm（多重门禁 + identity lock + superseded） | L14080-14302 | 同上 |
| A | POST /api/asset-node-images/{id}/vision-check（场景恒 skipped；mock 直接 passed；未配置 VISION_API_KEY → pending） | L14303-14428 | 同上 |
| B 角色库 | GET/POST /api/projects/{id}/characters | L17371/L17546/L17555 | 同上 |
| B | GET/PUT/DELETE /api/characters/{id}（改名 syncNameReferences 契约 + rename plan 事务应用） | L18167-18350 | 同上 |
| B | POST /api/character-images/{id}/confirm（定妆图确认 → 角色 finalized） | L17613-17662 | 同上 |
| B | POST /api/characters/{id}/rename-preview（重名 409/4009） | L17664-17708 | 同上 |
| B | GET /api/characters/{id}/images | L17768-17775 | 同上 |
| B | POST /api/characters/{id}/images/generate（入队） | L17777-17789 + L4326 | 同上 |
| B | GET /api/projects/{id}/voice-cast | L17237-17256 | 同上 |
| B | GET /api/characters/{id}/voice-recommendations（Top3 打分） | L17279-17290 | 同上 |
| B | PUT /api/characters/{id}/voice-binding（性别一致性校验 + 锁定） | L17292-17349 | 同上 |
| B | PUT /api/characters/{id}/reference-audio（dataURL ≤15MB → 本地对象存储 + 锁定） | L17351-17368 | 同上 |
| C 项目 | DELETE /api/projects/{id}（confirmName 校验 + 4090；级联靠 FK CASCADE） | L15141-15194 | `API_NATIVE_PROJECTS` |
| C | GET /api/projects/{id}/export-package（buildExportPackage 复刻） | L12592-12607 + L10690 | 同上 |

一致性锁定 / 版本升级 409 家族已全部复刻（Node error.code → 4011 envelope，HTTP 取 error.statusCode）：
`CHARACTER_ASSET_PACK_REQUIRED`（409）、`PROP_SINGLE_IMAGE_REQUIRED`（409）、`SCENE_PANORAMA_REQUIRED`（409）、
`SCENE_PANORAMA_REFERENCE_INVALID`（409）、`SCENE_NINE_GRID_ALREADY_GENERATED`（409）、
`character-base-image-required` / `character-face-closeup-required`（409）、确认门禁矩阵
（pack/turnaround/face-closeup/asset/prop/nine-grid，409/4004）。

### 9.2 提示词 fixture（Node 直调锁定）

- 生成脚本：`api-service/tests/fixtures/generate_asset_node_fixtures.mjs`
- 重新生成命令（仓库根目录执行）：`node api-service/tests/fixtures/generate_asset_node_fixtures.mjs`
- 产物：`api-service/tests/fixtures/asset_node_fixtures.json`（**85 个 case**），覆盖
  asset-character-prompt（buildScriptCharacterPrompt/turnaround/资产板/场景/环境/服饰证据/时空）、
  asset-node-prompt（生成提示词/快照/视图/负面词/身份锁/解析器）、scene-nine-grid（机位提示词/门禁）、
  asset-props（多视角）、scene-space-manifest（明确设施）、asset-canvas（DTO/布局钳制/场景匹配/画布视图/分组/视图契约）、
  asset-pack-lifecycle（采纳计划）、asset-parser-sync（去重）、asset-node-relink、scene-label、
  asset-temporal-groups（分组键/时空状态）、character-identity-lock（参考集/快照/提示词）、
  asset-character-workflow（六类确认门禁）、character-rename（文本/JSON 替换/说话人别名）、
  voice-profiles（特质推断/推荐/解析/就绪）。
- 不可直调项（Node 实现在 index.mjs 内部，import 会启动服务器）：`enqueueAssetNodeImageJob` /
  `enqueueCharacterImageJob` / `buildExportPackage` / `commitAssetAdoption` —— 由端点测试
  （FakeDB + 快照逐字段断言）覆盖其编排语义；纯函数依赖已全部 fixture 锁定。

### 9.3 有意差异（记录不修）

| # | 差异 | Node 行为 | FastAPI 行为 | 理由 |
|---|------|----------|-------------|------|
| 1 | 场景空间锚点缺失 | 请求线程内调空间锚点 Agent（`ensureSceneSpatialAnchors`，最多 2 次）并持久化 | 受控报错「缺少场景空间锚点时，必须先完成 Agent 提取并持久化」（HTTP 500 + 4011） | 网关不承担 Agent 执行；锚点由 Worker/Agent 链路先行产出 |
| 2 | vision-check 读图 | objectStorage 读字节（local/cos） | 仅 local 供应商在网关内读；COS 模式回退 URL 传入视觉模型 | COS SDK 读放 Worker 侧；URL 通道 Node 视觉模型本就支持 |
| 3 | 参考音频写桶 | objectStorage.putObject（local/cos） | 仅 local；COS 模式 500/5001「参考音频保存失败」 | COS 写入由 Worker 承担；生产 env 走 COS 前需补 COS put 适配 |
| 4 | 500 脱敏 | Node 泄漏 error.message | 固定文案（全局既有策略） | 安全加固（§3 同款） |
| 5 | 参考音频大小上限 | parseBody 上限 22MB，校验 15MB（L6881） | 15MB 校验逐字对齐；无 22MB 请求体硬限（Starlette 默认） | 校验语义与 Node 一致；请求体上限由反向代理承担 |
| 6 | 角色节点提示词刷新的自愈输入 | 画布 GET 用 `SELECT * FROM characters` 全列 | `list_project_character_rows` 同为 `SELECT *` | 等价 |
| 7 | asset-nodes generate 的 `qualityAttempts`（角色派生视图） | `characterDerivedQualityAttempts(body.qualityAttempts, 3)`（1-3 钳制） | `_parse_id_value(body.qualityAttempts) or 3`（未钳制上限） | 派生视图链路 Node 已停用（CHARACTER_ASSET_PACK_REQUIRED 409 拦截在前），不可达分支 |

### 9.4 本组改动文件

- 新增：`app/domain/asset_prompts.py`（提示词构建器 + 空间锚点归一化）、`app/domain/asset_canvas.py`（画布视图/分组/门禁/九宫格）、
  `app/domain/character_voice.py`（角色 DTO/音色推荐）、`app/domain/character_rename.py`（改名计划）、
  `app/domain/asset_vision.py`（视觉检查）、`tests/fixtures/generate_asset_node_fixtures.mjs`、
  `tests/fixtures/asset_node_fixtures.json`、`tests/test_asset_canvas_native_compat.py`、`tests/test_characters_native_compat.py`
- 修改：`app/main.py`（22 条路由 + 入队/导出包/画布自愈编排 + 对象存储读写 helper）、
  `app/database.py`（30 个方法：画布/形象/角色/定妆图/导出包/删除/改名上下文/版本号）、
  `app/domain/storyboard_ai.py`（`build_genre_prompt_context` 文案修正「禁区：」→「禁止事项：」，对齐 Node genre-skill-profile.mjs L116；既有测试无该文案断言）
