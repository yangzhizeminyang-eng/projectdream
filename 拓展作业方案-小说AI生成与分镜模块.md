# 拓展作业方案：小说 AI 生成与分镜模块

## 1. 作业定位

本次拓展作业的目标，不是单独实现一个页面，而是补齐一条从故事创意到分镜输出的完整业务链路。

结合当前项目 `projectdream` 的已有基础，建议将拓展作业定义为：

`项目设定 -> AI 生成故事总纲 -> AI 生成场景剧本 -> 自动拆分分镜 -> 人工微调分镜`

这样做的好处有三点：

- 能和当前项目现有的 AI 漫剧 / 分镜 / 视频制作平台定位保持一致
- 能体现“AI 辅助创作流程”而不是静态页面展示
- 后续可以自然衔接画面生成、视频生成、任务中心等模块

---

## 2. 当前项目基础分析

当前项目已经具备以下基础：

- 前端技术栈：`Vue 3 + Vite + Vue Router + Tailwind`
- 后端技术栈：`Node.js + mysql2`
- 已完成登录注册、短信验证码、路由守卫等基础认证能力
- 已有一套高保真工作台页面，覆盖剧本、分镜、画面、视频、音频、导出等流程

当前与本次拓展作业最相关的页面包括：

- `src/views/NewProject.vue`
- `src/views/AIScript.vue`
- `src/views/ScriptEditor.vue`
- `src/views/StoryboardList.vue`
- `src/views/StoryboardEditor.vue`

现状判断：

- 登录注册模块已经接了真实后端
- 工作台大多数业务页目前仍偏“高保真原型”
- 因此这次拓展作业最适合做成“前端真实接业务数据、后端提供真实表结构和真实接口、AI 先用 mock 服务”

---

## 3. 总体目标

本次一期 MVP 的目标是把以下业务链完整打通：

1. 用户创建项目
2. 用户输入题材、时长、故事愿景、风格等信息
3. 系统基于这些信息生成故事总纲
4. 系统基于总纲生成场景列表
5. 用户选择一个场景生成剧本正文
6. 用户编辑场景剧本
7. 用户点击生成分镜
8. 系统输出结构化镜头列表
9. 用户继续编辑单个镜头

一期先不做：

- 真实大模型接入
- 批量出图引擎
- 视频生成引擎
- 多人协同
- 复杂版本管理

---

## 4. 核心业务流程

### 4.1 项目创建流程

入口页面：`NewProject.vue`

流程如下：

1. 用户输入项目名称
2. 用户选择作品类型
3. 用户填写目标时长
4. 用户填写故事愿景
5. 用户确认画幅比例、视觉风格
6. 点击“开始创建项目”
7. 后端保存项目记录
8. 页面跳转到 AI 故事生成页

这一阶段的作用是为后续 AI 提供创作上下文。

---

### 4.2 AI 总纲生成流程

入口页面：`AIScript.vue`

流程如下：

1. 前端读取当前项目配置
2. 用户点击“生成故事总纲”
3. 后端调用 AI 服务
4. AI 返回结构化总纲结果
5. 后端保存总纲版本
6. 前端展示：
   - 标题
   - 一句话故事
   - 核心设定
   - 三幕结构
   - 场景摘要列表

这一阶段的目标是把“故事想法”转成“可执行的故事结构”。

---

### 4.3 场景生成流程

仍然在 `AIScript.vue` 中完成。

流程如下：

1. 用户确认总纲方向
2. 点击“生成场景”
3. 后端基于总纲生成场景列表
4. 每个场景包含：
   - 场景编号
   - 场景标题
   - 场景摘要
   - 地点
   - 时间
   - 预估时长
5. 场景列表保存到数据库
6. 左侧结构树展示真实场景数据

这一阶段是从宏观故事结构进入可写剧本的场景层级。

---

### 4.4 场景剧本生成与编辑流程

入口页面：`ScriptEditor.vue`

流程如下：

1. 用户在场景列表中选择一个场景
2. 点击“生成剧本”
3. 后端调用 AI 生成该场景的剧本正文
4. 前端进入剧本编辑页
5. 用户在编辑器中查看并修改：
   - 场景描述
   - 动作描写
   - 人物对白
   - 情绪表达
6. 用户点击保存
7. 后端保存剧本内容

这一阶段强调“AI 先出稿，用户再精修”，而不是完全自动化。

---

### 4.5 分镜生成流程

入口页面：`StoryboardList.vue`

流程如下：

1. 用户在场景剧本页点击“生成分镜”
2. 后端读取当前场景剧本
3. AI 按镜头语言自动拆解出多个镜头
4. 每个镜头返回结构化字段：
   - 镜头编号
   - 景别
   - 机位
   - 构图
   - 时长
   - 角色
   - 动作
   - 台词
   - 视觉提示词
5. 后端保存镜头列表
6. 前端分镜卡片页显示镜头列表
7. 显示镜头状态：
   - `pending`
   - `generating`
   - `done`
   - `failed`

这一阶段是整套作业最重要的核心亮点之一，因为它真正体现了“从文本到分镜”的 AI 生产链。

---

### 4.6 单镜头编辑流程

入口页面：`StoryboardEditor.vue`

流程如下：

1. 用户点击某个镜头卡片
2. 进入单镜头编辑页
3. 用户可以修改：
   - 景别
   - 机位
   - 构图
   - 时长
   - 角色
   - 动作描述
   - 台词
   - 视觉提示词
4. 用户保存镜头
5. 后端更新镜头数据

这一阶段体现“AI 负责生成初稿，人负责创作把关”。

---

## 5. 功能模块拆分

为了便于实现和汇报，可以把系统拆成两个大模块。

### 5.1 AI 小说 / 剧本生成模块

主要职责：

- 接收项目创作设定
- 生成故事总纲
- 生成三幕式结构
- 生成场景列表
- 生成单场景剧本
- 支持 AI 重写和人工修改

建议功能点：

- 项目设定输入
- 一键生成总纲
- 一键生成场景
- 一键生成剧本
- 保存剧本
- AI 辅助重写
- 冲突增强
- 对白精简
- 风格统一

---

### 5.2 分镜模块

主要职责：

- 将场景剧本自动拆解为镜头
- 以卡片/时间轴方式展示镜头
- 支持镜头编辑与排序
- 为后续画面生成提供结构化提示词

建议功能点：

- 自动拆镜
- 分镜卡片展示
- 分镜状态显示
- 单镜头编辑
- 镜头排序
- 镜头新增
- 镜头删除
- 镜头提示词编辑

---

## 6. 页面职责设计

### 6.1 `NewProject.vue`

职责：

- 创建项目
- 保存基础设定
- 跳转到 AI 故事页

页面应接真实接口，而不是只保留演示输入框。

---

### 6.2 `AIScript.vue`

职责：

- 展示故事总纲
- 展示三幕结构
- 展示场景树
- 承载“生成总纲 / 生成场景 / 生成剧本”入口

建议它成为“故事结构控制台”。

---

### 6.3 `ScriptEditor.vue`

职责：

- 编辑单个场景剧本
- 保存剧本
- 跳转生成分镜

建议它成为“场景级文字创作页”。

---

### 6.4 `StoryboardList.vue`

职责：

- 展示某个场景的全部镜头
- 显示镜头状态
- 提供批量入口
- 提供进入单镜头编辑的入口

建议它成为“镜头级结构总览页”。

---

### 6.5 `StoryboardEditor.vue`

职责：

- 编辑单个镜头详细参数
- 保存镜头信息

建议它成为“镜头微调工作台”。

---

## 7. 数据模型设计

为了让前后端都能稳定扩展，一期建议增加 4 张核心表。

### 7.1 `projects`

用途：保存项目基础设定

建议字段：

- `id`
- `user_id`
- `name`
- `category`
- `target_duration`
- `narrative_vision`
- `visual_style`
- `aspect_ratio`
- `status`
- `created_at`
- `updated_at`

---

### 7.2 `story_outlines`

用途：保存 AI 生成的故事总纲版本

建议字段：

- `id`
- `project_id`
- `version_no`
- `title`
- `logline`
- `premise`
- `act1_text`
- `act2_text`
- `act3_text`
- `raw_json`
- `created_at`

---

### 7.3 `script_scenes`

用途：保存场景信息和剧本内容

建议字段：

- `id`
- `project_id`
- `outline_id`
- `scene_no`
- `title`
- `summary`
- `content`
- `mood`
- `location`
- `time_of_day`
- `estimated_duration`
- `sort_order`
- `status`
- `created_at`
- `updated_at`

---

### 7.4 `storyboards`

用途：保存镜头级结构化数据

建议字段：

- `id`
- `scene_id`
- `shot_no`
- `shot_type`
- `camera_angle`
- `composition`
- `duration_seconds`
- `character_name`
- `action_text`
- `dialogue_text`
- `visual_prompt`
- `image_url`
- `sort_order`
- `status`
- `created_at`
- `updated_at`

---

## 8. 状态设计

建议统一状态，避免页面、接口、数据库各写一套。

### 8.1 项目状态

- `draft`
- `outlined`
- `scripting`
- `storyboarding`
- `done`

### 8.2 场景状态

- `draft`
- `generated`
- `revised`
- `storyboard_ready`

### 8.3 分镜状态

- `pending`
- `generating`
- `done`
- `failed`

---

## 9. 接口设计

为了把流程完整打通，建议增加以下接口。

### 9.1 项目接口

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`

---

### 9.2 总纲接口

- `POST /api/projects/:id/outline/generate`
- `GET /api/projects/:id/outline`

---

### 9.3 场景接口

- `POST /api/projects/:id/scenes/generate`
- `GET /api/projects/:id/scenes`

---

### 9.4 剧本接口

- `POST /api/scenes/:id/script/generate`
- `PUT /api/scenes/:id/script`

---

### 9.5 分镜接口

- `POST /api/scenes/:id/storyboards/generate`
- `GET /api/scenes/:id/storyboards`
- `GET /api/storyboards/:id`
- `PUT /api/storyboards/:id`
- `POST /api/storyboards/reorder`

---

## 10. AI 输出格式设计

这部分是本次作业很关键的架构点。

建议 AI 统一返回结构化 JSON，而不是只返回一大段自然语言文本。这样做的好处是：

- 前端容易渲染
- 后端容易存库
- 后续容易接画面生成、视频生成
- 业务数据更稳定

### 10.1 总纲输出格式

```json
{
  "title": "项目标题",
  "logline": "一句话故事",
  "premise": "核心设定",
  "acts": [
    { "act": 1, "summary": "第一幕摘要" },
    { "act": 2, "summary": "第二幕摘要" },
    { "act": 3, "summary": "第三幕摘要" }
  ],
  "scenes": [
    {
      "scene_no": 1,
      "title": "场景标题",
      "summary": "场景摘要",
      "location": "地点",
      "time_of_day": "夜",
      "estimated_duration": 90
    }
  ]
}
```

### 10.2 场景剧本输出格式

```json
{
  "scene_no": 1,
  "title": "废弃实验室",
  "summary": "K 首次接收到异常信号",
  "content": "完整剧本文本",
  "mood": "压迫、悬疑",
  "estimated_duration": 120
}
```

### 10.3 分镜输出格式

```json
{
  "scene_id": 12,
  "shots": [
    {
      "shot_no": "01",
      "shot_type": "全景",
      "camera_angle": "低机位",
      "composition": "居中构图",
      "duration_seconds": 4,
      "character_name": "K",
      "action_text": "K 走入雨夜实验室",
      "dialogue_text": "没人该在这里活过今晚。",
      "visual_prompt": "赛博朋克雨夜实验室，全景，低机位，高反差电影光影"
    }
  ]
}
```

---

## 11. 技术实现建议

### 11.1 一期建议使用 mock AI service

因为当前作业重点是“业务流程和功能实现”，不是大模型接入本身，所以建议：

- 后端先做 `mock AI`
- 但保留清晰的 AI service 结构
- 后续可无缝替换成真实模型

建议目录：

- `server/services/ai/outline.mjs`
- `server/services/ai/script.mjs`
- `server/services/ai/storyboard.mjs`

这样做的优点：

- 前端开发不会被真实模型阻塞
- 后端接口能提前稳定
- 后续替换真实模型时改动最小

---

### 11.2 路由参数建议

建议通过 query 参数传递当前上下文：

- `/new`
- `/workspace/script/ai?projectId=1`
- `/workspace/script?projectId=1&sceneId=12`
- `/workspace/storyboard?projectId=1&sceneId=12`
- `/workspace/storyboard/editor?storyboardId=88`

这样有利于：

- 页面刷新后恢复上下文
- 页面之间跳转清晰
- 后续做深链接和分享更方便

---

## 12. 开发优先级

为了让实现更稳，建议按以下顺序开发：

1. 新增数据库表
2. 新增后端接口
3. 新增 mock AI service
4. 改造 `NewProject.vue`
5. 改造 `AIScript.vue`
6. 改造 `ScriptEditor.vue`
7. 改造 `StoryboardList.vue`
8. 改造 `StoryboardEditor.vue`
9. 自测完整流程

这样做可以避免“前端先写死、后端再推翻”的返工。

---

## 13. 一期 MVP 验收标准

如果以下内容都能跑通，就说明一期已经完成：

1. 能创建项目
2. 能保存项目基础设定
3. 能生成总纲并保存
4. 能生成场景列表并保存
5. 能生成单场景剧本并保存
6. 能编辑并保存剧本
7. 能从剧本生成分镜
8. 能查看分镜列表
9. 能编辑单个镜头

---

## 14. 作业汇报时可强调的亮点

本次方案的亮点不在于单独做了某个页面，而在于完成了“从文本创意到镜头结构”的业务链设计。

可以总结为三点：

1. 系统不是只做静态展示，而是具备完整创作流程
2. AI 不直接替代创作者，而是提供结构化草稿，用户负责精修
3. 分镜模块天然可以继续接画面生成、视频生成与任务中心

这会比单纯讲“我做了一个剧本页和一个分镜页”更有整体性和项目感。

---

## 15. 结论

综合当前项目现状，本次拓展作业最合理的实现路径是：

- 保留现有认证系统
- 将高保真原型页改造成真实业务页
- 先用 mock AI 跑通链路
- 用结构化数据把项目、总纲、场景、分镜串起来

最终形成一条可演示、可扩展、可继续接真实模型和生成引擎的业务主线：

`项目设定 -> AI 总纲 -> 场景剧本 -> 分镜生成 -> 分镜编辑`

这套方案既适合课堂展示，也适合作为后续继续开发的架构基础。
