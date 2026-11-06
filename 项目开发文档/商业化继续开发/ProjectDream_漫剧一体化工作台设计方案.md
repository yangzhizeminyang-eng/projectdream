# ProjectDream 漫剧一体化工作台设计方案

> 阶段 0：审计与架构方案（已获小泽确认，进入阶段 1 实现）
> 日期：2026-09-24

## 目标

把 ProjectDream 从“多个互相独立的制作后台页面”重构为**从单集蓝图到成片导出的连续漫剧生产台**。用户进入一个项目后，在同一个工作区内看到当前项目 / 集 / 场景 / 镜头、单集生产进度、情绪段落、分镜与镜头卡、资产、候选、连续性、质量门禁、时间线，以及“下一步最重要动作”。

本设计只做**只读聚合 + 前端适配**，不替换旧页面，不伪造任何生产结果。

## 架构决策（已确认）

1. **阶段 1 不新增后端聚合接口**。在 `src/api/production-studio.ts` 建立**只读适配层**，组合现有真实 GET 接口返回 `ProductionStudioViewModel`。两级加载：跨时段只拉轻量快照，选中镜头才拉详情。若后续发现请求过多 / 数据一致性无法保证 / 性能不足，再新增只读聚合接口 `GET /api/projects/:id/production-studio`（该接口只聚合已有真实数据，不能伪造生产结果）。
2. **不使用任何 mock 数据**，接口暂缺的能力显示“待接入” + 真实阻塞原因 + 禁用操作，绝不显示虚假的 100% 完成。
3. **当前 ProductionRun 选择优先级**（不是简单取最高 ID）：
   1. URL/query 明确指定的 `runId`；
   2. 进行中的 run（running / candidate-generation 等，`created < running < completed` 优先级高于 waiting）→ 其中优先级：`running` > `candidate-generation` 进行中等 > `waiting_approval` > `planning` > 最近完成 > 最近创建；
   3. 同一状态取 ID 最大者。
   项目 12 默认使用正在运行的 ProductionRun #2。
4. **不复制小云雀品牌 / 文案 / 素材 / 视觉细节**，只借鉴其“产品节奏、连续工作流、媒体优先”思路。

## 现有代码审计结论

- 六大支柱（角色版本、声音锁定、连续性契约、候选制、质量门禁、ProductionRun）**服务端均已有真实数据与 GET 接口**。
- 验证对象真实存在：项目 12、第 1 集、Scene 02、storyboard `284=02/14`（预告广播器）、`285=02/15`（揭示广播器）；24 镜头蓝图、情绪段落、24 个视频候选、音频 `219/220="六"`、`221/222="四"`，均带 `continuity-contract` 与 `voice-lock` 快照。
- `getProjectProductionReadiness(projectId)` 已聚合 5 大阶段 + blockers + actionQueue，可直接复用为“下一步 / 阻塞”。
- **全局 `Inspector.vue` 是 100% 硬编码 mock** → 工作台不复用，`WorkspaceLayout showInspector=false`，右侧 Inspector 为页面内真实组件。
- 无单场景聚合接口；`FinalEdit` 时间线非组件、无总播放头；上下文模型缺 episodeNo / runId。

## 数据 / API 使用清单（全部复用现有真实 GET）

| 工作台区域 | 复用接口 | 说明 |
|---|---|---|
| 项目上下文 | `getProject`, `getSeasonStructure` | 项目名、目标时长、第 1 集标题 |
| 场景条 | `listScenes(projectId)` | sceneNo / sortOrder / status |
| 故事板 + 镜头卡 | `listStoryboards(sceneId)` | 内联确认静帧/视频/镜号/主动作/对白/情绪/起止帧 |
| 候选 + 历史 | `listShotImages`, `listStoryboardVideos` | status pending / confirmed / versionNo 区分当前/历史 |
| 声音 | `listProjectAudio`（按 storyboardId 过滤）、`listProjectVoiceCast` | 对白/声线快照/锁定 |
| 情绪段落 | `getProductionRun(runId).blueprint.emotionBeats` | 真实段落 |
| ProductionRun | `listProductionRuns`, `getProductionRun` | 上述选择优先级 |
| 质量门禁 / 阻塞 / 下一步 | `getProjectProductionReadiness` | blockers + actionQueue |
| 资产画布 | `listCharacters`, `getProjectAssets` | 角色版本 / 锁定 |
| 轻量时间线 | `getProjectFinalEdit` | videoTrack / audioTracks / subtitleCues |

## 组件树

```
src/components/production/
├─ ProductionStudioShell.vue        # 5 区网格布局
├─ ProductionContextBar.vue         # 顶栏上下文
├─ ProductionStageRail.vue          # 左：10 阶段
├─ ProductionCanvas.vue             # 中：单集生产视图
│  ├─ EpisodeHeader.vue             # 集信息 + 下一步按钮
│  ├─ SceneStrip.vue                # 场景条
│  ├─ StoryboardGrid.vue            # 分镜故事板
│  └─ ShotProductionCard.vue        # 单镜头生产卡
├─ ProductionInspector.vue          # 右：连续性 / 声线 / 门禁 / Agent
└─ ProductionLightTimeline.vue      # 底：真实 FinalEditDTO 轻量时间线
```

`src/views/ProductionStudio.vue` 组装 → 路由 `/workspace/studio`，标题“漫剧一体化工作台”。

## 文件变更清单

**新增：**
- `src/views/ProductionStudio.vue`
- `src/api/production-studio.ts`（+ 类型与 view-model）
- `src/components/production/*`（上述 11 个组件）
- 相关测试 `.test.mjs`（结构 / 上下文 / 聚合契约）
- 本设计文档及 `PROJECT_PROGRESS.*` 更新

**修改（最小）：**
- `src/router/index.ts`：加 `/workspace/studio`
- `src/components/SideNav.vue`：加“漫剧工作台”入口并高亮 `/workspace/studio`
- `src/views/Dashboard.vue`：加“进入一体化工作台”
- `src/lib/context.ts`：扩展 episodeNo / productionRunId（向后兼容）

**不改动：** 旧页面、旧路由、认证、生成 / 一致性 / 声音锁定 / 质量门禁服务端、FinalEdit 页本身、所有已生成媒体。

## 视觉规范（沿用前端已确认的 Dark 主题，收敛为本工作台专用尾部规范）

- 生产型工作台，不做营销首页 / 统计卡片墙 / 三列 KPI。
- 深石墨底、暖白文字、单一琥珀强调、纸张白素材做内容层；专业、密集但不拥挤、可扫描。
- 内圆形 ≤ 6px，时间码等宽数字，按钮图标 + 短文本，重要动作有阻塞提示。
- 禁：紫色渐变、蓝紫霓虹、发光球、HUD、科技网格、大面积玻璃拟态、AI 生成装饰、卡片套卡片、无意义背景动画。
- 响应式：1440 / 1280 / 1024 / 390；左右栏可折叠、1024 阶段栏转抽屉、390 阶段条转横滚、Inspector 下沉、关键按钮不被挤出屏幕。

## 阶段 1 最小垂直切片

> Dashboard → `/workspace/studio?projectId=12&episodeNo=1&runId=2` → 顶部上下文（死去的老板给我发邮件 / 别签字 / Scene 02 / 15 / 候选筛选中）→ 场景条 Scene 02 → 选中 14/15 → Inspector 显示连续性契约（284 预告广播器 → 285 揭示广播器）、声线锁定、候选 vs 历史、阻塞、下一步。

验收自检 3 点：镜头连续（首尾帧 + 契约显式展示）；声音与角色锁定（voice-lock 快照 + 角色版本显式展示）；候选真筛选（candidate ≠ confirmed，未确认不进终剪，如实显示）。

## 风险 / 阻塞项

- “当前 batch vs 历史”：`VideoAssetDTO` 无显式 batch 字段，`legacy-history` 判定需核对后端标记字段；阶段 1 用 status + versionNo 兜底。
- “当前 ProductionRun”无字段，靠上述优先级启发式，需后续认可。
- 剧集标题依赖 `getSeasonStructure`，结构未生成则降级文案。
- 环境声 / BGM / 混音、高级裁切尚未具备 → 显示“待接入”+ 真实阻塞，不伪造。

## 验收命令

- 工程：`npm test`、`npm run type-check`、`npm run build-only`、`git diff --check`
- 真实接口：项目 12 只读冒烟（场景条 / 故事板 / 单镜头详情 / readiness 200，owner-scope）
- 浏览器（frontend-design + browser）：1440 / 1280 / 1024 / 390 四档截图 + 场景 / 镜头切换 + Inspector 收放 + 时间线横滚 + 旧页跳转 + a11y + Impeccable
- 视觉：不出现紫色 AI 风格、卡片套卡片、无意义横向溢出；当前镜头与下一步动作突出