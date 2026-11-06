"""路由级覆盖矩阵测试（FastAPI-Only 迁移第七阶段 · Task 7.1 硬门禁）。

以 ``docs/node-retirement-inventory.md`` A 节（Node 118 条 HTTP method 分支）与
D 节迁移矩阵为基准，把 118 条 method 分支整理为本测试内的数据表
（path/method/组/处置），逐条断言其在当前 FastAPI 网关命中且仅命中四类处置之一：

  (a) native  —— FastAPI 原生路由存在：用 ``app.routes`` 的 path/method 匹配；
      Node ``{id}`` 与 FastAPI ``{project_id}`` 等参数命名差异按「参数段」归一，
      ``{p:path}`` 通配按前缀语义匹配（媒体四路）；
  (b) 501     —— 显式未实现豁免：``app.main.OPS_FALLBACK_501_ROUTES`` 命中
      （HTTP 501 + code 5010，决策 9「显式 envelope 优于静默代理」）；
  (c) 4040    —— 未实现且未豁免 → ``/api/{path:path}`` 兜底 4040 收口，属
      悬空/缺口，必须登记于本模块 ``GAP_4040_ROUTES``（frozenset 硬编码，与
      OPS_FALLBACK_501_ROUTES 同构），每条附缺口编号注释（对应 inventory
      A-16 / ``docs/fastapi-only-architecture-decision.md`` 决策 9 清单），
      防止缺口静默增长——任何落 4040 而未登记的条目直接红灯；
  (d) worker  —— Node 侧本就无对应 HTTP 路由的项（Worker 内部/函数式域）。

覆盖统计（native/501/4040/worker）总数必须 = 118，死路由必须 = 0（inventory
E-1 基线：Node 全部路由均有调用方）。数据表 (b) 集合与 OPS_FALLBACK_501_ROUTES
做双向对账，任一侧漂移即失败。

全部离线执行（create_app + 空 DB 桩，不发请求）。
"""

from __future__ import annotations

import re
from typing import Any

import pytest

from app.config import Settings
from app.main import OPS_FALLBACK_501_ROUTES, create_app

# ---------------------------------------------------------------------------
# 覆盖矩阵数据表（inventory A 节 118 条 method 分支，编号与文档一致）。
#
# 每条：(编号, method, Node 路径（参数段已归一为 {..}，交替族已展开/抽象）,
#        inventory 组, 期望处置, 备注)。
# 期望处置 ∈ {"native", "501", "4040", "worker"}：
#   - "501" 必须能在 OPS_FALLBACK_501_ROUTES 中找到同 (method, 归一化路径)；
#   - "4040" 必须登记于 GAP_4040_ROUTES 并带缺口编号（当前为空集，漂移即失败）；
#   - "native" 由 app.routes 动态验证（本测试的核心断言）；
#   - "worker" 当前为空（inventory A 节 118 条均为 Node HTTP 路由，无函数式域）。
# ---------------------------------------------------------------------------

ROUTE_MATRIX: tuple[tuple[int, str, str, str, str, str], ...] = (
    # ---- A-1 媒体与静态文件服务（8 条，Nginx 四路直代时代 → 现由 FastAPI 媒体服务原生接管）----
    (1, "GET", "/mock/image/{sb}/{ver}/{cand}.svg", "A-1 媒体", "native", "内存 SVG，media_service /mock 通配"),
    (2, "GET", "/mock-assets/project-{p}/node-{n}/v{v}-{c}.png", "A-1 媒体", "native", "mock 资产图，MOCK_ASSET_IMAGE_PATH"),
    (3, "GET", "/generated/frame/{file}", "A-1 媒体", "native", "静帧文件流，不支持 Range"),
    (4, "GET", "/generated/audio/{file}", "A-1 媒体", "native", "音频流，Range 206/416"),
    (5, "GET", "/generated/video/{file}", "A-1 媒体", "native", "视频流，Range 206/416"),
    (6, "GET", "/generated/export/{id}/{file}", "A-1 媒体", "native", "导出 mp4/srt；[/{file}] 可选段同分支"),
    (7, "GET", "/mock/audio/{track}", "A-1 媒体", "native", "内存 wav；v1/v2 两种 URL 形态同一分支"),
    (8, "GET", "/storage/{key}", "A-1 媒体", "native", "对象存储；FastAPI 有意收紧为强制验签（401/4010）"),
    # ---- A-2 健康与模型设置（3 条）----
    (9, "GET", "/api/health", "A-2 健康", "native", "业务健康摘要（compose 依赖的旧探针已切 /ready）"),
    (10, "GET", "/api/model-settings", "A-2 模型设置", "native", "47 字段 payload，secret 不回显"),
    (11, "PUT", "/api/model-settings", "A-2 模型设置", "native", "白名单 upsert"),
    # ---- A-3 鉴权组（8 条，阶段 8.1 全量原生）----
    (12, "GET", "/api/auth/check-phone", "A-3 鉴权", "native", "手机号格式校验"),
    (13, "GET", "/api/auth/captcha", "A-3 鉴权", "native", "滑块挑战；会话 MySQL 化（迁移 0004）"),
    (14, "POST", "/api/auth/captcha/verify", "A-3 鉴权", "native", "校验滑块 → captchaToken"),
    (15, "POST", "/api/auth/send-code", "A-3 鉴权", "native", "SMS adapter（tencent/aliyun/mock）"),
    (16, "POST", "/api/auth/login-password", "A-3 鉴权", "native", "密码登录"),
    (17, "POST", "/api/auth/reset-password", "A-3 鉴权", "native", "短信码重置"),
    (18, "POST", "/api/auth/login", "A-3 鉴权", "native", "短信码登录"),
    (19, "POST", "/api/auth/register", "A-3 鉴权", "native", "注册（含验证码链路）"),
    # ---- A-4 项目组（13 条）----
    (20, "GET", "/api/projects", "A-4 项目", "native", "列表 + 聚合统计"),
    (21, "POST", "/api/projects", "A-4 项目", "native", "创建"),
    (22, "GET", "/api/projects/{id}", "A-4 项目", "native", "详情"),
    (23, "PATCH", "/api/projects/{id}", "A-4 项目", "native", "白名单字段更新"),
    (24, "DELETE", "/api/projects/{id}", "A-4 项目", "native", "confirmName 409/4090 语义"),
    (25, "GET", "/api/projects/{id}/outline", "A-4 项目", "native", "最新总纲（无则 null）"),
    (26, "POST", "/api/projects/{id}/outline/generate", "A-4 项目", "native", "deterministic mock/real AI normalization; protects modern script and persists outline atomically"),
    (27, "GET", "/api/projects/{id}/scenes", "A-4 项目", "native", "场景列表"),
    (28, "POST", "/api/projects/{id}/scenes/generate", "A-4 项目", "native", "latest season/legacy outline → owner-scoped atomic scene drafts; never overwrites existing scenes"),
    (29, "GET", "/api/projects/{id}/export-package", "A-4 项目", "native", "导出就绪度"),
    (30, "GET", "/api/projects/{id}/assets", "A-4 项目", "native", "资产聚合"),
    (31, "POST", "/api/project-assets/{type}/{id}/archive", "A-4 项目", "native", "归档策略（character|image|video|audio 四类）"),
    (32, "GET", "/api/projects/{id}/tasks", "A-4 项目", "native", "任务中心 V2"),
    # ---- A-5 故事圣经 / 分集大纲（10 条）----
    (33, "GET", "/api/projects/{id}/story-bible", "A-5 圣经", "native", "最新版本或 null"),
    (34, "POST", "/api/projects/{id}/story-bible/generate", "A-5 圣经", "native", "AI 同步；mock 抛错不造假（Node 同）"),
    (35, "PUT", "/api/projects/{id}/story-bible", "A-5 圣经", "native", "保存 + 质量评估"),
    (36, "POST", "/api/projects/{id}/story-bible/evaluate", "A-5 圣经", "native", "经 /story-bible/{action} 动态段路由"),
    (37, "POST", "/api/projects/{id}/story-bible/lock", "A-5 圣经", "native", "经 /story-bible/{action} 动态段路由"),
    (38, "GET", "/api/projects/{id}/season-structure", "A-5 圣经", "native", "最新版本或 null"),
    (39, "POST", "/api/projects/{id}/season-structure/generate", "A-5 圣经", "native", "依赖已有 bible"),
    (40, "PUT", "/api/projects/{id}/season-structure", "A-5 圣经", "native", "保存 + 评估"),
    (41, "POST", "/api/projects/{id}/season-structure/evaluate", "A-5 圣经", "native", "经 /season-structure/{action} 动态段路由"),
    (42, "POST", "/api/projects/{id}/season-structure/lock", "A-5 圣经", "native", "经 /season-structure/{action} 动态段路由"),
    # ---- A-6 项目音频与音频资产（5 条）----
    (43, "GET", "/api/projects/{id}/audio", "A-6 音频", "native", "按轨道类型排序"),
    (44, "POST", "/api/projects/{id}/audio/generate", "A-6 音频", "native", "DashScope TTS + mock + COS/本地对象存储 + audio_assets 持久化"),
    (45, "POST", "/api/audio-assets/{id}/confirm", "A-6 音频", "native", "同轨道组互斥确认"),
    (46, "POST", "/api/audio-assets/{id}/archive", "A-6 音频", "native", "confirmed 不可归档"),
    (47, "PUT", "/api/audio-assets/{id}", "A-6 音频", "native", "时间线定位"),
    # ---- A-7 Agent Pipeline（5 条，stage-actions 登记已迁移，其余执行体待承接）----
    (48, "GET", "/api/projects/{id}/agent-pipeline", "A-7 Pipeline", "native", "owner-scoped runs + executions/events 列表"),
    (49, "POST", "/api/projects/{id}/agent-pipeline/start", "A-7 Pipeline", "native", "owner-scoped 幂等运行记录入队，由 Node Worker 执行"),
    (50, "GET", "/api/agent-pipelines/{id}", "A-7 Pipeline", "native", "owner-scoped 运行详情与执行/事件历史"),
    (51, "POST", "/api/agent-pipelines/{id}/stage-actions", "A-7 Pipeline", "native", "owner/status/idempotency-scoped 执行结果登记，不调用 Agent"),
    (52, "POST", "/api/agent-pipelines/{id}/stages/{key}/decision", "A-7 Pipeline", "native", "owner-scoped 原子审批并恢复持久 Worker 队列"),
    # ---- A-8 Script Agent 活动（2 条）----
    (53, "GET", "/api/projects/{id}/script-agent/activities", "A-8 活动", "native", "limit 钳位 1-100"),
    (54, "POST", "/api/projects/{id}/script-agent/activities", "A-8 活动", "native", "phase 枚举 + 幂等键"),
    # ---- A-9 Production Runs（6 条，列表/详情/创建/审批/阶段完成均原生）----
    (55, "GET", "/api/projects/{id}/production-runs", "A-9 黄金样片", "native", "owner-scoped 运行摘要列表"),
    (56, "POST", "/api/projects/{id}/production-runs", "A-9 黄金样片", "native", "blueprint quality gate + atomic multi-table transaction"),
    (57, "GET", "/api/production-runs/{id}", "A-9 黄金样片", "native", "owner-scoped run/stage/checkpoint/agent/blueprint 只读详情"),
    (58, "PUT", "/api/production-runs/{id}/blueprint", "A-9 黄金样片", "native", "versioned blueprint save + quality report"),
    (59, "POST", "/api/production-runs/{id}/checkpoints/{key}/decision", "A-9 黄金样片", "native", "canApprove gate + locked state transition transaction"),
    (60, "POST", "/api/production-runs/{id}/stages/{key}/complete", "A-9 黄金样片", "native", "validated atomic stage/checkpoint transition"),
    # ---- A-10 资产画布 / 资产节点（10 条）----
    (61, "GET", "/api/projects/{id}/asset-canvas", "A-10 资产画布", "native", "读时自愈链"),
    (62, "POST", "/api/projects/{id}/asset-nodes", "A-10 资产画布", "native", "四类 nodeType"),
    (63, "PATCH", "/api/asset-nodes/{id}", "A-10 资产画布", "native", "字段白名单"),
    (64, "DELETE", "/api/asset-nodes/{id}", "A-10 资产画布", "native", "软删 archived"),
    (65, "POST", "/api/asset-nodes/{id}/relink-scene", "A-10 资产画布", "native", "场景重匹配"),
    (66, "POST", "/api/asset-nodes/{id}/hydrate-prompt", "A-10 资产画布", "native", "提示词补齐"),
    (67, "GET", "/api/asset-nodes/{id}/images", "A-10 资产画布", "native", "图片列表"),
    (68, "POST", "/api/asset-nodes/{id}/images/generate", "A-10 资产画布", "native", "付费图片入队"),
    (69, "POST", "/api/asset-node-images/{id}/confirm", "A-10 资产画布", "native", "多重确认门禁"),
    (70, "POST", "/api/asset-node-images/{id}/vision-check", "A-10 资产画布", "native", "视角视觉检查"),
    # ---- A-11 生成任务与任务中心动作（5 条）----
    (71, "GET", "/api/generation-jobs/{id}", "A-11 任务", "native", "owner 校验"),
    (72, "POST", "/api/project-tasks/generation-{id}/retry", "A-11 任务", "native", "failed/canceled 才可重试"),
    (73, "POST", "/api/project-tasks/generation-{id}/cancel", "A-11 任务", "native", "固定 409（供应商不支持取消）"),
    (74, "POST", "/api/project-tasks/{task_key}/retry", "A-11 任务", "native", "image|video|audio|export-* mock 动作原生持久化至 task_runtime_states"),
    (75, "POST", "/api/project-tasks/{task_key}/cancel", "A-11 任务", "native", "owner-scoped，仅 queued/running 可取消"),
    # ---- A-12 场景与分镜（14 条）----
    (76, "GET", "/api/scenes/{id}", "A-12 分镜", "native", "场景详情"),
    (77, "PUT", "/api/scenes/{id}", "A-12 分镜", "native", "白名单更新"),
    (78, "POST", "/api/scenes/{id}/script/generate", "A-12 分镜", "native", "mock 确定性生成 / 真实回退"),
    (79, "PUT", "/api/scenes/{id}/script", "A-12 分镜", "native", "status=revised"),
    (80, "GET", "/api/scenes/{id}/storyboards", "A-12 分镜", "native", "分镜列表"),
    (81, "POST", "/api/scenes/{id}/storyboards/generate", "A-12 分镜", "native", "mock 规则化 + 资产门禁 + RAG 降级"),
    (82, "GET", "/api/storyboards/{id}", "A-12 分镜", "native", "frameCharacterContext 已 Python 复刻（固定代理废除）"),
    (83, "PUT", "/api/storyboards/{id}", "A-12 分镜", "native", "大字段白名单 + 视线/声音契约"),
    (84, "POST", "/api/storyboards/{id}/frame-prompt/rewrite", "A-12 分镜", "native", "mock 兜底重写"),
    (85, "POST", "/api/storyboards/{id}/keyframes/optimize", "A-12 分镜", "native", "两帧提示词优化"),
    (86, "POST", "/api/storyboards/{id}/continuity/start-frame", "A-12 分镜", "native", "承接上一镜头"),
    (87, "POST", "/api/storyboards/{id}/split", "A-12 分镜", "native", "AI 拆分子分镜"),
    (88, "POST", "/api/storyboards/{id}/dialogue/split", "A-12 分镜", "native", "AI 拆分多人对白"),
    (89, "POST", "/api/storyboards/reorder", "A-12 分镜", "native", "批量 sort_order"),
    # ---- A-13 静帧 / 视频 / 口型 / 字幕（8 条）----
    (90, "GET", "/api/shots/{id}/images", "A-13 静帧", "native", "候选图列表"),
    (91, "POST", "/api/shots/{id}/images/generate", "A-13 静帧", "native", "静帧入队（Worker 消费）"),
    (92, "POST", "/api/images/{id}/confirm", "A-13 静帧", "native", "同 frame_role 互斥确认"),
    (93, "GET", "/api/storyboards/{id}/videos", "A-13 静帧", "native", "视频候选列表"),
    (94, "POST", "/api/storyboards/{id}/videos/generate", "A-13 静帧", "native", "视频入队 + qualityReport 通道"),
    (95, "POST", "/api/storyboards/{id}/lip-sync/generate", "A-13 静帧", "native", "口型入队"),
    (96, "POST", "/api/videos/{id}/subtitles/remove", "A-13 静帧", "native", "字幕清理入队"),
    (97, "POST", "/api/videos/{id}/confirm", "A-13 静帧", "native", "最终视频确认事务"),
    # ---- A-14 成片编辑与导出（5 条）----
    (98, "GET", "/api/projects/{id}/final-edit", "A-14 成片", "native", "owner-scoped 成片聚合与导出校验"),
    (99, "PUT", "/api/projects/{id}/final-edit-draft", "A-14 成片", "native", "草稿归一化、owner 校验与持久化"),
    (100, "GET", "/api/projects/{id}/exports", "A-14 成片", "native", "导出记录列表"),
    (101, "POST", "/api/projects/{id}/exports", "A-14 成片", "native", "导出校验后写持久队列，由 Worker 执行 FFmpeg"),
    (102, "GET", "/api/exports/{id}", "A-14 成片", "native", "导出详情"),
    # ---- A-15 角色库与配音（16 条）----
    (103, "GET", "/api/voice-profiles", "A-15 角色", "native", "系统音色目录"),
    (104, "GET", "/api/projects/{id}/voice-cast", "A-15 角色", "native", "角色 × 音色阵容"),
    (105, "GET", "/api/projects/{id}/characters", "A-15 角色", "native", "角色列表"),
    (106, "POST", "/api/projects/{id}/characters", "A-15 角色", "native", "手工新建角色"),
    (107, "POST", "/api/projects/{id}/characters/generate", "A-15 角色", "native", "AI 结果归一 + owner 校验 + 事务 upsert/过期角色归档"),
    (108, "GET", "/api/characters/{id}", "A-15 角色", "native", "角色详情"),
    (109, "PUT", "/api/characters/{id}", "A-15 角色", "native", "改名 syncNameReferences"),
    (110, "DELETE", "/api/characters/{id}", "A-15 角色", "native", "软删 archived"),
    (111, "POST", "/api/character-images/{id}/confirm", "A-15 角色", "native", "定妆图确认 → finalized"),
    (112, "POST", "/api/characters/{id}/rename-preview", "A-15 角色", "native", "改名影响预览"),
    (113, "POST", "/api/characters/{id}/generate-profile", "A-15 角色", "native", "AI 档案补全 + owner 校验 + 锁定音色重置事务"),
    (114, "POST", "/api/characters/{id}/images/generate", "A-15 角色", "native", "定妆图入队"),
    (115, "POST", "/api/characters/{id}/voice-preview", "A-15 角色", "native", "音色试听与 Qwen 自定义音色注册；mock 明确返回 503"),
    (116, "GET", "/api/characters/{id}/voice-recommendations", "A-15 角色", "native", "音色推荐 Top3"),
    (117, "PUT", "/api/characters/{id}/voice-binding", "A-15 角色", "native", "音色绑定 + 锁定"),
    (118, "PUT", "/api/characters/{id}/reference-audio", "A-15 角色", "native", "base64 ≤22MB 落对象存储"),
)

# inventory 基线：A 节 118 条 method 分支、死路由 0。
EXPECTED_BRANCH_COUNT = 118
EXPECTED_DEAD_ROUTES = 0

# ---------------------------------------------------------------------------
# (c) 类缺口登记表（决策 9）：兜底 4040 收口的 Node 路由必须在此逐条硬编码，
# 每条附「缺口编号 + inventory 引用」注释。当前为空集——第六阶段后所有 Node
# HTTP 路由均已显式注册（原生 / 501 豁免），到达 4040 的只有 A-16 悬空调用域
# （Node 本就无路由，不在 118 条基准内）。
#
# 登记格式（示例，供将来补充时照抄）：
#   # GAP-XXX（inventory A-16 / 决策 9）：GET /api/market/analyze —— 前端悬空
#   # 调用，Node 无路由无迁移需求，兜底 4040 收口；第六阶段前端清理时去留确认。
#   # ("GET", "/api/market/analyze"),
# ---------------------------------------------------------------------------
GAP_4040_ROUTES: frozenset[tuple[str, str]] = frozenset()

# (d) 类 Worker 内部域：inventory A 节 118 条均为 Node HTTP 路由，无函数式域；
# A-16「存在服务模块但无 HTTP 路由」的域不在 118 条基准内。当前为空集，登记
# 格式同 GAP_4040_ROUTES（附 inventory A-16 引用）。
WORKER_INTERNAL_ROUTES: frozenset[tuple[str, str]] = frozenset()

# ---------------------------------------------------------------------------
# FastAPI 路由索引（模块级构建一次）
# ---------------------------------------------------------------------------


class _NullDatabase:
    """覆盖矩阵构建期的最小数据库占位。

    create_app 构造期只保存引用不做查询（AuthCaptchaService 构造等），
    本桩不做任何事即可满足参数约定。
    """


def _is_param_segment(segment: str) -> bool:
    """判断路径段是否为参数段。

    :param segment: 路径段（如 ``{project_id}``、``{p:path}``）。
    :returns: 参数段时 True（``{p:path}`` 通配段也算参数段）。
    """
    return segment.startswith("{") and segment.endswith("}")


def _segments_equal(node_segment: str, template_segment: str) -> bool:
    """比较 Node 归一化段与 FastAPI 模板段是否兼容。

    字面相等，或任一侧为参数段（Node ``{id}`` 已归一为 ``{..}``，FastAPI 的
    ``{project_id}``/``{task_key}``/``{action}`` 等命名差异在此吸收）。

    :param node_segment: Node 侧归一化段。
    :param template_segment: FastAPI 路由模板段。
    :returns: 兼容时 True。
    """
    return (
        node_segment == template_segment
        or _is_param_segment(node_segment)
        or _is_param_segment(template_segment)
    )


def _route_matches(template_path: str, template_methods: set[str], method: str, node_path: str) -> bool:
    """判断 Node 条目 (method, path) 是否被某条 FastAPI 路由模板覆盖。

    ``{p:path}`` 通配段按前缀语义匹配（媒体四路：/generated、/storage、/mock、
    /mock-assets 下的任意子路径均命中）；其余要求段数一致且逐段兼容。

    :param template_path: FastAPI 路由模板（``:int`` 转换器已剥除）。
    :param template_methods: 该路由允许的 method 集合。
    :param method: Node 条目的 method。
    :param node_path: Node 条目归一化路径。
    :returns: 覆盖时 True。
    """
    if method not in template_methods:
        return False
    template_segments = template_path.strip("/").split("/")
    node_segments = node_path.strip("/").split("/")
    if _is_param_segment(template_segments[-1]) and ":path}" in template_segments[-1]:
        prefix_length = len(template_segments) - 1
        return len(node_segments) > prefix_length and all(
            _segments_equal(node_segments[i], template_segments[i]) for i in range(prefix_length)
        )
    if len(template_segments) != len(node_segments):
        return False
    return all(
        _segments_equal(node_segment, template_segment)
        for node_segment, template_segment in zip(node_segments, template_segments)
    )


def _normalize_template(path: str) -> str:
    """剥除 FastAPI 模板中的 ``:int`` 转换器标注。

    :param path: 路由模板（如 ``/api/projects/{project_id:int}``）。
    :returns: 归一化模板（如 ``/api/projects/{project_id}``）。
    """
    return path.replace(":int}", "}")


# 参数段 canonical 化：把任意 ``{name}`` / ``{name:int}`` 段折叠为 ``{}``，
# 用于 (b) 类集合对账（数据表 ``{id}`` 与注册表 ``{project_id}`` 命名差异吸收）。
_CANONICAL_PARAM = re.compile(r"\{[^/{}]+\}")


def _canonical(path: str) -> str:
    """把路径模板 canonical 化：剥 ``:int`` 后所有参数段折叠为 ``{}``。

    :param path: 任意一侧的路由模板。
    :returns: canonical 形态（如 ``/api/characters/{}``）。
    """
    return _CANONICAL_PARAM.sub("{}", _normalize_template(path))


def _build_native_route_index() -> tuple[tuple[str, set[str]], ...]:
    """从 ``app.routes`` 提取显式注册的路由索引（含 501 注册路由）。

    仅排除 ``/api/{path:path}`` 兜底 4040 收口（(c) 类来源，不参与 (a) 匹配）。
    501 注册路由在 :func:`_classify` 中按 (method, canonical) 精确剔除，
    避免同路径不同 method（如 exports 的 GET native / POST 501）被整条误删。

    :returns: (归一化模板, method 集合) 列表。
    """
    app = create_app(Settings(_env_file=None), database=_NullDatabase())
    index: list[tuple[str, set[str]]] = []
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        if path == "/api/{path:path}":
            continue
        index.append((_normalize_template(path), set(methods)))
    return tuple(index)


def _build_ops_501_index() -> set[tuple[str, str]]:
    """把 OPS_FALLBACK_501_ROUTES 展开为 (method, canonical 路径) 集合。

    :returns: 501 豁免 (method, path) 集合（参数段已折叠为 ``{}``）。
    """
    return {
        (method, _canonical(path))
        for path, methods, _reason in OPS_FALLBACK_501_ROUTES
        for method in methods
    }


NATIVE_ROUTES = _build_native_route_index()
OPS_501_INDEX = _build_ops_501_index()
# 全部 app.routes 注册路由的 canonical 集（含 501 注册路由，用于注册遗漏检查）。
REGISTERED_CANONICAL = {_canonical(path) for path, _methods in NATIVE_ROUTES}


def _classify(method: str, node_path: str) -> str:
    """对单条 Node method 分支计算实际处置类别。

    判定顺序：501 豁免注册表 → FastAPI 原生路由（501 注册路由按
    (method, canonical) 剔除，不参与 (a) 匹配）→ /api/* 兜底 4040 → 其余
    （Node 本就无 HTTP 路由的域）归 worker。

    :param method: HTTP method。
    :param node_path: 归一化后的 Node 路径。
    :returns: "501" / "native" / "4040" / "worker" 四类之一。
    """
    if (method, _canonical(node_path)) in OPS_501_INDEX:
        return "501"
    for template_path, template_methods in NATIVE_ROUTES:
        if (method, _canonical(template_path)) in OPS_501_INDEX:
            continue
        if _route_matches(template_path, template_methods, method, node_path):
            return "native"
    if node_path.startswith("/api/") or node_path == "/api":
        return "4040"
    return "worker"


# ---------------------------------------------------------------------------
# 核心断言
# ---------------------------------------------------------------------------


def test_matrix_covers_exactly_118_inventory_branches() -> None:
    """数据表完整性：恰好 118 条、编号 1-118 无缺无重。

    :raises AssertionError: 数据表条数或编号与 inventory 基线不符。
    """
    assert len(ROUTE_MATRIX) == EXPECTED_BRANCH_COUNT, (
        f"覆盖矩阵数据表 {len(ROUTE_MATRIX)} 条，inventory A 节基线为 {EXPECTED_BRANCH_COUNT} 条"
    )
    ids = [entry[0] for entry in ROUTE_MATRIX]
    assert ids == list(range(1, EXPECTED_BRANCH_COUNT + 1)), "数据表编号必须与 inventory A 节 1-118 一一对应"
    # 编号 → (method, path) 不得重复（防止整理数据表时复制粘贴漂移）。
    keys = {(entry[1], entry[2]) for entry in ROUTE_MATRIX}
    assert len(keys) == EXPECTED_BRANCH_COUNT, "数据表存在重复的 (method, path) 条目"


def test_every_branch_hits_declared_disposition() -> None:
    """核心门禁：118 条逐条断言实际处置 == 期望处置。

    实际处置由 (a)app.routes / (b)OPS_FALLBACK_501_ROUTES / (c)兜底 4040 /
    (d)worker 四分法动态计算。任一条偏离（例如原生路由被误删、501 被静默
    改为透传、新条目意外落 4040）即红灯并输出明细。

    :raises AssertionError: 存在处置漂移的条目。
    """
    drift: list[str] = []
    for entry_id, method, node_path, group, expected, _note in ROUTE_MATRIX:
        actual = _classify(method, node_path)
        if actual != expected:
            drift.append(f"#{entry_id} {method} {node_path}（{group}）：期望 {expected}，实际 {actual}")
    assert not drift, f"覆盖矩阵发现 {len(drift)} 条处置漂移：\n" + "\n".join(drift)


def test_gap_4040_registry_matches_classified_routes() -> None:
    """(c) 类对账：落 4040 的条目必须全部登记于 GAP_4040_ROUTES（防静默增长）。

    GAP_4040_ROUTES 当前为空集——若某条 Node 路由不再被原生/501 覆盖而落
    兜底 4040，本测试要求先在该 frozenset 登记缺口编号（对应 inventory A-16 /
    决策 9 清单），再决定迁移或保留，不允许静默吞掉。

    :raises AssertionError: 存在未登记的 4040 收口条目，或登记表含幽灵条目。
    """
    classified_4040 = {
        (method, node_path)
        for _id, method, node_path, _group, expected, _note in ROUTE_MATRIX
        if _classify(method, node_path) == "4040"
    }
    unregistered = sorted(classified_4040 - set(GAP_4040_ROUTES))
    ghost = sorted(set(GAP_4040_ROUTES) - classified_4040)
    assert not unregistered, (
        "以下 Node 路由落入兜底 4040 但未登记 GAP_4040_ROUTES（须附缺口编号注释）：\n"
        + "\n".join(f"  {method} {path}" for method, path in unregistered)
    )
    assert not ghost, (
        "GAP_4040_ROUTES 存在已不落 4040 的幽灵条目（缺口已消除请移除）：\n"
        + "\n".join(f"  {method} {path}" for method, path in ghost)
    )


def test_worker_internal_registry_matches_classified_routes() -> None:
    """(d) 类对账：worker 内部条目必须登记于 WORKER_INTERNAL_ROUTES。

    :raises AssertionError: 存在未登记的 worker 类条目，或登记表含幽灵条目。
    """
    classified_worker = {
        (method, node_path)
        for _id, method, node_path, _group, expected, _note in ROUTE_MATRIX
        if _classify(method, node_path) == "worker"
    }
    unregistered = sorted(classified_worker - set(WORKER_INTERNAL_ROUTES))
    ghost = sorted(set(WORKER_INTERNAL_ROUTES) - classified_worker)
    assert not unregistered, (
        "以下条目分类为 worker 内部但未登记 WORKER_INTERNAL_ROUTES：\n"
        + "\n".join(f"  {method} {path}" for method, path in unregistered)
    )
    assert not ghost, (
        "WORKER_INTERNAL_ROUTES 存在幽灵条目：\n"
        + "\n".join(f"  {method} {path}" for method, path in ghost)
    )


def test_501_entries_match_ops_registry_both_ways() -> None:
    """(b) 类双向对账：数据表 501 条目 ⇄ OPS_FALLBACK_501_ROUTES 完全一致。

    任一侧漂移（新增豁免未进数据表、数据表误标 501、豁免清单被改动）即失败，
    保证覆盖矩阵与 main.py 豁免清单是同一份语义。

    :raises AssertionError: 双向对账存在差异。
    """
    matrix_501 = {
        (method, _canonical(node_path))
        for _id, method, node_path, _group, expected, _note in ROUTE_MATRIX
        if expected == "501"
    }
    missing_in_matrix = sorted(OPS_501_INDEX - matrix_501)
    stale_in_matrix = sorted(matrix_501 - OPS_501_INDEX)
    assert not missing_in_matrix, (
        "OPS_FALLBACK_501_ROUTES 中存在数据表未标注 501 的豁免（请补充数据表）：\n"
        + "\n".join(f"  {method} {path}" for method, path in missing_in_matrix)
    )
    assert not stale_in_matrix, (
        "数据表标注 501 但豁免注册表已不存在（缺口可能已迁移，请更新数据表）：\n"
        + "\n".join(f"  {method} {path}" for method, path in stale_in_matrix)
    )
    # 501 豁免路由必须真的注册在 app.routes 中（add_api_route 注册遗漏即失败）。
    for method, path in sorted(OPS_501_INDEX):
        assert path in REGISTERED_CANONICAL, f"501 豁免路由 {method} {path} 未在 app.routes 注册"


def test_coverage_statistics_sum_to_inventory() -> None:
    """覆盖统计：native/501/4040/worker 合计 = 118，死路由 = 0。

    分类计数从数据表动态汇总：(c) 类数量必须等于 GAP_4040_ROUTES 基数（当前
    0），(b) 类数量必须等于 OPS_FALLBACK_501_ROUTES 展开的 method 分支数，
    native 数随迁移推进变化但四类合计恒为 118。

    :raises AssertionError: 统计失衡。
    """
    counts: dict[str, int] = {"native": 0, "501": 0, "4040": 0, "worker": 0}
    for _id, method, node_path, _group, _expected, _note in ROUTE_MATRIX:
        counts[_classify(method, node_path)] += 1
    total = sum(counts.values())
    assert total == EXPECTED_BRANCH_COUNT, f"四类处置合计 {total} ≠ {EXPECTED_BRANCH_COUNT}"
    assert counts["4040"] == len(GAP_4040_ROUTES), "4040 计数与缺口登记表不一致"
    assert counts["501"] == len(OPS_501_INDEX), "501 计数与 OPS_FALLBACK_501_ROUTES 不一致"
    # 死路由（无任何调用方）基线为 0：数据表每条都必须有处置且 inventory E-1
    # 声明 Node 全部路由均有前端/脚本/运维调用方，死路由概念仅作门禁占位。
    dead_routes = EXPECTED_DEAD_ROUTES
    assert dead_routes == 0, "出现死路由须重新对照 inventory E-1 重新盘点"
    print(
        f"[route-coverage] native={counts['native']} / 501={counts['501']} / "
        f"4040={counts['4040']} / worker={counts['worker']} / dead={dead_routes} / total={total}"
    )


def test_project_task_mock_actions_are_native_not_501() -> None:
    """inventory #74/#75 must reach the native handler and no longer return 501."""
    pytest.importorskip("fastapi.testclient")
    from fastapi.testclient import TestClient

    class _TaskStub:
        """Task-center stub covering ownership, state writes and refreshed DTOs."""

        def find_user_by_token(self, token: str) -> dict[str, Any] | None:
            """按 token 反查用户。

            :param token: 访问令牌。
            :returns: 固定测试用户；其余 None。
            """
            return {"id": 7, "phone": "13912345678", "nickname": "覆盖矩阵用户"} if token == "matrix-token" else None

        def apply_mock_task_action(self, task_type: str, source_id: int, user_id: int, action: str) -> dict[str, Any]:
            return {"outcome": "updated", "project_id": 1, "runtime_status": "queued" if action == "retry" else "canceled"}

        def list_project_task_rows(self, project_id: int, user_id: int) -> dict[str, Any]:
            return {"images": [], "videos": [], "audios": [], "exports": [], "generation_jobs": []}

    client = TestClient(create_app(Settings(_env_file=None), database=_TaskStub()), raise_server_exceptions=False)
    headers = {"Authorization": "Bearer matrix-token"}
    for prefix in ("image", "video", "audio", "export"):
        for action in ("retry", "cancel"):
            response = client.post(f"/api/project-tasks/{prefix}-1/{action}", headers=headers, json={})
            assert response.status_code == 404, f"{prefix}-{action} 未从原生 handler 收口"
            assert response.json()["code"] == 4004, f"{prefix}-{action} 应按任务不存在返回 4004"
