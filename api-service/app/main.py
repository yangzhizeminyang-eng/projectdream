from __future__ import annotations

import hashlib
import asyncio
import base64
import hmac
import inspect
import json
import math
import os
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
import logging
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .agent.errors import AgentError
from .agent.schemas import AgentRequest
from .agent.pipeline.stages import PIPELINE_STAGES
from .domain.production_run import (
    build_episode_blueprint,
    build_production_checkpoint_transition,
    build_production_run_seed,
    build_production_stage_completion_transition,
    evaluate_episode_blueprint,
    normalize_production_run_input,
)
from .ai_provider import AiProviderError, generate_structured_json, get_ai_config
from .ai_generators import (
    generate_character_profile as ai_generate_character_profile,
    generate_characters as ai_generate_characters,
    generate_outline as ai_generate_outline,
    generate_scene_script as ai_generate_scene_script,
    generate_scene_space_anchors as ai_generate_scene_space_anchors,
    generate_season_structure as ai_generate_season_structure,
    generate_story_bible as ai_generate_story_bible,
    generate_storyboards as ai_generate_storyboards,
    rewrite_frame_visual_prompt as ai_rewrite_frame_visual_prompt,
)
from .auth_captcha import AuthCaptchaService
from .config import Settings
from .database import MySQLDatabase
from .direction_contract import validate_direction
from .domain.frame_character import (
    build_frame_consistency_prompt,
    create_frame_character_snapshot,
    resolve_frame_character_context,
)
from .domain.story_quality import (
    evaluate_season_structure,
    evaluate_story_bible,
    normalize_season_structure_input,
    normalize_story_bible_input,
)
from .domain.workflow_gates import evaluate_creative_workflow_gates
from .domain.storyboard_ai import (
    StoryboardContractError,
    StoryboardDurationError,
    build_storyboard_asset_catalog,
    build_storyboard_mentioned_prompt,
    build_sub_shot_direction_reference,
    fallback_dialogue_sub_shots,
    frame_role_prompt_fallback,
    inspect_storyboard_asset_reference_gate,
    normalize_dialogue_sub_shots,
    normalize_frame_role,
    normalize_storyboard_duration_seconds,
    normalize_storyboard_performance,
    normalize_sub_shots,
    sanitize_storyboard_prompt,
    simple_keyframe_prompt_fallback,
    validate_storyboard_duration_contracts,
)
from .envelope import failure, success
from .domain.asset_canvas import (
    asset_node_image_row,
    build_asset_canvas_view,
    build_active_asset_node_dedup_plan,
    build_scene_nine_grid_angle_prompt,
    choose_scene_for_relink,
    find_scene_node_match,
    get_scene_nine_grid_angles,
    is_character_asset_pack_row,
    normalize_asset_node_layout,
    normalize_asset_node_type,
    scene_nine_grid_quality_attempts,
    validate_asset_image_confirmation,
    validate_character_asset_pack_confirmation,
    validate_character_face_closeup_confirmation,
    validate_character_turnaround_confirmation,
    validate_character_view_generation,
    validate_prop_turnaround_confirmation,
    validate_scene_nine_grid_view_confirmation,
)
from .domain.asset_prompts import (
    build_asset_node_generation_prompt,
    build_asset_node_prompt_snapshot,
    build_asset_node_view_prompt,
    build_character_asset_pack_prompt,
    build_character_identity_lock_prompt,
    build_character_identity_lock_snapshot,
    build_character_view_negative_prompt,
    build_scene_display_label,
    build_scene_environment_prompt,
    build_scene_environment_prompt,
    build_script_character_prompt,
    build_script_scene_prompt,
    is_legacy_character_prompt,
    normalize_asset_group_key,
    normalize_scene_space_manifest,
    parse_character_identity_lock,
    resolve_asset_node_generation_prompt,
    resolve_character_reference_set,
)
from .domain.character_voice import (
    CHARACTER_AGE_GROUPS,
    CHARACTER_GENDERS,
    character_image_row,
    character_row,
    character_voice_cast_row,
    infer_character_voice_traits,
    is_character_voice_ready,
    normalize_character_age_group,
    normalize_character_gender,
    resolve_character_voice_profile,
    recommend_voice_profiles,
)
from .domain.character_rename import build_character_rename_plan
from .audio_generation import AudioProviderError, build_rule_based_voice_design, create_qwen_designed_voice, synthesize_audio
from .mappers import (
    asset_item,
    audio_asset_row,
    generation_job_row,
    image_asset_row,
    normalize_generated_media_url,
    outline_row,
    project_row,
    scene_row,
    season_structure_row,
    storyboard_row,
    story_bible_row,
    video_asset_row,
    voice_profile_row,
)
from .media_service import register_media_routes
from .media_urls import create_object_url_resolver
from .domain.video_generation import (
    assert_video_model_provider,
    build_color_continuity_constraints,
    build_lip_sync_prompt,
    build_mention_context_prompt,
    build_reference_audio_prompt_context,
    build_referenced_asset_prompt_context,
    build_storyboard_continuity_prompt,
    build_storyboard_direction_prompt,
    build_storyboard_frame_reference,
    build_storyboard_performance_prompt,
    build_storyboard_reference_snapshot,
    build_storyboard_video_prompt_parts,
    build_two_keyframe_video_prompt,
    build_video_continuity_constraints,
    build_video_reference_image_guide,
    get_lip_sync_provider,
    get_video_provider_config,
    infer_video_candidate_expectations,
    inspect_storyboard_generation_context,
    is_official_agnes_model,
    is_wan_video_model,
    normalize_storyboard_mention_context,
    resolve_dash_scope_lip_sync_duration,
    resolve_continuity_source_shot_no,
    resolve_lip_sync_duration,
    resolve_reference_audio_url,
    should_use_storyboard_continuity,
    validate_storyboard_reference_snapshot,
)
from .sms import SmsSendError, create_sms_provider
from .task_center import build_project_tasks
from .domain.model_settings import (
    build_model_settings_payload,
    get_model_setting_fallback_values,
    save_model_settings,
)
from .domain.script_agent import build_script_agent_activity_payload

logger = logging.getLogger("projectdream-api")

PROJECT_ASSET_TYPES = {"character", "image", "video", "audio"}
PROTECTED_ASSET_STATUSES = {"confirmed", "finalized", "done"}
# PATCH /api/projects/{id} 可更新字段：顺序即 Node normalizeProjectUpdateInput 的校验顺序，
# 多字段同时非法时按此顺序返回第一个错误（不可改为 set，否则错误优先级随哈希序漂移）。
PROJECT_UPDATE_FIELDS = ("name", "category", "narrativeVision", "visualStyle", "aspectRatio")
# aspectRatio 校验：与 Node canvasFromRatioLabel 对齐——任意「W:H / W：H / W/H」形态
# （两侧均为正数，支持小数）即可解析为画布，外加业务特殊标签；re.ASCII 对齐 JS \d 的
# ASCII 语义（全角数字不接受）。
ASPECT_RATIO_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$", re.ASCII)
ASPECT_RATIO_SPECIAL_LABELS = {"自适应", "auto"}
# 鉴权组（阶段 8.1）：手机号与短信验证码格式，对齐 Node /^1\d{10}$/ 与 /^\d{4,8}$/
# （JS \d 仅 ASCII，re.ASCII 等价；全角数字不接受）。
AUTH_PHONE_PATTERN = re.compile(r"^1\d{10}$", re.ASCII)
AUTH_SMS_CODE_PATTERN = re.compile(r"^\d{4,8}$", re.ASCII)
# 短信验证码兜底有效期（秒）：供应商未返回 expiresIn 时使用，对齐 Node CODE_TTL_SECONDS。
SMS_CODE_TTL_SECONDS = 5 * 60

# ---------------------------------------------------------------------------
# 运维端点豁免清单（阶段 3.2.5「运维端点与其他剩余路由处置」）。
#
# 兜底收口语义：下列路由在 FastAPI 显式注册为 501（code 5010），不再落入
# /api/{path:path} 兜底代理透传 Node。每条附判定理由与缺口记录，缺口消除前
# 不得改为透传（决策 9：显式 501/4040 envelope 优于静默代理）。
#
# 处置四分法（与 api-service/docs/ops-endpoints-spec.md 处置总表一致）：
#   迁移（原生实现）    —— 本清单之外，见 create_app 内各原生路由；
#   显式 501            —— 本清单（Agent 执行体与真实 TTS 供应商边界尚未承接）；
#   Worker 内部无需 HTTP —— 恢复队列/对象存储验证/媒体回填（Node 无路由，无处置项）；
#   悬空（决策 9）      —— market 审计等 Node 无路由的前端调用，收口后由兜底 4040 覆盖。
# ---------------------------------------------------------------------------
OPS_FALLBACK_501_ROUTES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    # ---- Agent Pipeline start/decision 已接入持久化运行队列及 Worker。----
    # ---- 导出创建（Node L15068-L15138）：依赖 final-edit 校验 + queueExportJob
    # （FFmpeg 执行体归 Worker，决策 6）；列表/详情两条只读已原生迁移。----
)

# 501 envelope 的失败码与文案（决策 9：显式 envelope 优于静默代理）。
OPS_NOT_IMPLEMENTED_CODE = 5010
OPS_NOT_IMPLEMENTED_MESSAGE = "该接口尚未在 FastAPI 网关实现"


def _token(request: Request) -> str:
    value = str(request.headers.get("authorization") or "").strip()
    return value[7:].strip() if value.lower().startswith("bearer ") else value


def _normalize_phone(value: Any) -> str:
    r"""手机号标准化，逐字符对齐 Node normalizePhone（index.mjs L6293）。

    JS 实现：``String(input || '').replace(/\D/g, '').slice(0, 11)``——仅保留 ASCII
    数字（全角数字、空格、+、- 等一律剔除），截取前 11 位。不可用 ``str.isdigit()``
    （会保留全角数字），也不能用 ``re.sub(r"\D", ...)``（Python \D 匹配全角数字）。

    :param value: 任意输入（None 视为空串）。
    :returns: 标准化后的手机号（0-11 位 ASCII 数字）。
    """
    return "".join(char for char in str(value or "") if "0" <= char <= "9")[:11]


def _client_ip(request: Request) -> str:
    """读取客户端来源 IP，对齐 Node 路由的取值顺序与分段逻辑。

    Node：``String(xff || x-real-ip || socket.remoteAddress || '').split(',')[0].trim()``——
    x-forwarded-for 存在即优先（哪怕首段为空），再取 x-real-ip，最后 socket 地址；
    统一按逗号取首段并 trim。

    :param request: 当前请求。
    :returns: 来源 IP（可能为空串）。
    """
    raw_ip = (
        request.headers.get("x-forwarded-for")
        or request.headers.get("x-real-ip")
        or (request.client.host if request.client else "")
        or ""
    )
    return str(raw_ip).split(",")[0].strip()


def _safe_user(user: dict[str, Any]) -> dict[str, Any]:
    return {"id": user["id"], "phone": user["phone"], "nickname": user["nickname"], "createdAt": user.get("createdAt")}


def _is_valid_aspect_ratio(value: str) -> bool:
    """判断画面比例标签能否解析为画布（对齐 Node canvasFromRatioLabel + 特殊标签）。

    :param value: 已 strip 的比例标签。
    :returns: 可解析（或属业务特殊标签）时 True；否则 False。
    """
    if value in ASPECT_RATIO_SPECIAL_LABELS:
        return True
    match = ASPECT_RATIO_PATTERN.fullmatch(value)
    if match is None:
        return False
    return float(match.group(1)) > 0 and float(match.group(2)) > 0


def _parse_id_value(value: Any) -> int:
    """Node parseId 的等价实现：正数取整，否则 0（body 字段解析用）。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return int(parsed) if parsed > 0 else 0


def _default_export_resolution(aspect_ratio: Any) -> str:
    """按项目画幅选择不裁切的成片分辨率。

    :param aspect_ratio: 项目画幅（如 9:16）。
    :returns: 导出分辨率文案。
    """
    normalized = str(aspect_ratio or "").strip().replace(" ", "")
    return {
        "9:16": "720 x 1280 (HD)",
        "16:9": "1920 x 1080 (FHD)",
        "1:1": "1080 x 1080",
        "4:3": "1440 x 1080",
        "3:4": "1080 x 1440",
        "21:9": "2560 x 1080",
        "2.39:1": "2560 x 1080",
    }.get(normalized, "1920 x 1080 (FHD)")


def _asset_node_row_id(row: dict[str, Any]) -> int:
    """Node assetNodeRowId：资产节点行 id（asset_node_id 或 id）。"""
    return int(row.get("asset_node_id") or row.get("id") or 0)


def _storyboard_asset_gate_blocker(counts: dict[str, int], *, allow_continuity_start_image: bool) -> str | None:
    """Node assertStoryboardHasNoGeneratedAssets 的 blocker 文案（L3997）。

    :param counts: count_storyboard_generated_assets 的统计结果。
    :param allow_continuity_start_image: 是否允许「仅承接起始帧」豁免（拆分类端点为 True）。
    :returns: blocker 文案；无素材或命中豁免时返回 None。
    """
    image_count = int(counts.get("imageCount") or 0)
    continuity_start_count = int(counts.get("continuityStartImageCount") or 0)
    video_count = int(counts.get("videoCount") or 0)
    audio_count = int(counts.get("audioCount") or 0)
    only_continuity_start_image = (
        allow_continuity_start_image
        and image_count > 0
        and image_count == continuity_start_count
        and video_count == 0
        and audio_count == 0
    )
    if (image_count or video_count or audio_count) and not only_continuity_start_image:
        return (
            "当前分镜已经有视频或音频素材，不能再拆分。正确流程是先拆分多人对白/子分镜，再生成静帧、动作视频、对白音频和口型视频。"
            if (video_count or audio_count)
            else "当前分镜已经有生成图片素材，不能再拆分。只有“承接上一镜头”的起始帧允许在拆分时保留到第一条子分镜。请先确认流程：拆分 -> 承接/生成静帧 -> 生成视频/音频 -> 口型。"
        )
    return None


class StoryboardGateError(Exception):
    """分镜资产引用门禁失败（Node statusCode=409 的业务抛错形态）。

    :ivar message: 与 Node 逐字一致的 blocker 汇总文案。
    """

    def __init__(self, message: str) -> None:
        """保存错误文案。

        :param message: 门禁汇总文案。
        """
        super().__init__(message)
        self.message = message


def _resolve_scene_storyboard_asset_rows(
    ai_shots: list[dict[str, Any]],
    asset_rows: list[dict[str, Any]],
    project_characters: list[dict[str, Any]],
    scene_id: int,
    scene_content: Any,
) -> list[dict[str, Any]]:
    """把 AI 镜头解析为 storyboards 插入行（对齐 Node L15859-L16028 事务内逻辑）。

    资产门禁逐镜头检查（角色资产/三视图资产板/场景全景/道具引用/视线声音契约），
    首个含 blocker 的镜头抛 :class:`StoryboardGateError`（HTTP 500/5001，Node 全局
    catch 形态——Node 该路由无 try/catch，409 statusCode 被全局兜底覆盖）。

    :param ai_shots: normalize_storyboard_payload 产出的镜头列表。
    :param asset_rows: 事务期资产行（vision 允许 NULL，对齐 Node 第二段查询）。
    :param project_characters: 项目角色行（含资产版本）。
    :param scene_id: 当前场景 id。
    :param scene_content: 场景正文（脸部特写需求判定输入）。
    :returns: storyboards 插入行列表（snake_case 列名）。
    :raises StoryboardGateError: 任一镜头未通过资产/执行计划门禁。
    """
    from app.domain.storyboard_ai import requires_character_face_reference

    character_asset_rows = [row for row in asset_rows if str(row.get("node_type") or "") == "character"]
    scene_asset_rows = [row for row in asset_rows if str(row.get("node_type") or "") == "scene"]

    def find_character_asset(names: list[str]) -> dict[str, Any] | None:
        """Node findCharacterAsset：label 精确匹配或 ref_id 关联角色名匹配。"""
        for row in character_asset_rows:
            if any(str(name or "").strip() == str(row.get("label") or "").strip() for name in names):
                return row
            if any(
                int(row.get("ref_id") or 0) > 0
                and any(
                    int(c.get("id") or 0) == int(row.get("ref_id") or 0)
                    and str(c.get("name") or "").strip() == str(name or "").strip()
                    for c in project_characters
                )
                for name in names
            ):
                return row
        return None

    def find_row(predicate: Any, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
        """行列表谓词查找（保持 Node find 语义：返回首个命中）。"""
        return next((row for row in rows if predicate(row)), None)

    scene_asset = find_row(
        lambda row: int(row.get("ref_id") or 0) == int(scene_id or 0), scene_asset_rows
    )

    def vision_ok(row: dict[str, Any], extra: tuple[str, ...] = ()) -> bool:
        """Node (!row.vision_status || row.vision_status === 'passed' [|| extra]) 判定。"""
        vision = str(row.get("vision_status") or "")
        return not vision or vision == "passed" or vision in extra

    rows: list[dict[str, Any]] = []
    for index, shot in enumerate(ai_shots):
        character_name = str(shot.get("character_name") or "").strip()
        scene_asset_names = [str(n or "") for n in shot.get("scene_assets") or []]
        prop_asset_names = [str(n or "") for n in shot.get("prop_assets") or []]
        raw_character_assets = shot.get("character_assets") or []
        character_asset_names = (
            [str(n or "") for n in raw_character_assets]
            if raw_character_assets
            else ([character_name] if character_name else [])
        )
        character = next(
            (
                c
                for c in project_characters
                if any(str(name).strip() == str(c.get("name") or "").strip() for name in character_asset_names)
            ),
            None,
        )
        character_asset = find_character_asset(character_asset_names) if character_asset_names else None
        node_rows = (
            [row for row in asset_rows if _asset_node_row_id(row) == _asset_node_row_id(character_asset)]
            if character_asset
            else []
        )
        character_asset_pack_row = find_row(
            lambda row: str(row.get("view_set_type") or "") == "character-asset-pack"
            and str(row.get("status") or "") == "confirmed"
            and vision_ok(row),
            node_rows,
        )
        character_turnaround_rows = (
            [
                row
                for row in node_rows
                if str(row.get("view_set_type") or "") == "character-turnaround"
                and str(row.get("view_key") or "") in {"front", "side", "back"}
            ]
            if character_asset
            else []
        )
        character_base_row = find_row(
            lambda row: str(row.get("view_set_type") or "") in {"single", "character-asset-pack"}
            and not str(row.get("view_key") or "").strip()
            and str(row.get("status") or "") == "confirmed"
            and vision_ok(row),
            node_rows,
        )
        character_face_row = find_row(
            lambda row: (
                (str(row.get("view_set_type") or "") == "character-face-closeup" and str(row.get("view_key") or "") == "face")
                or str(row.get("view_set_type") or "") == "character-asset-pack"
            )
            and str(row.get("status") or "") == "confirmed"
            and vision_ok(row),
            node_rows,
        )
        character_face_required = bool(not character_asset_pack_row and character_asset) and (
            requires_character_face_reference(
                character or {}, scene_content, shot.get("visual_prompt"), shot.get("action_text")
            )
        )
        scene_node_rows = (
            [row for row in asset_rows if _asset_node_row_id(row) == _asset_node_row_id(scene_asset)]
            if scene_asset
            else []
        )
        scene_view_key = str(shot.get("scene_view_key") or "").strip()
        scene_panorama = find_row(
            lambda row: str(row.get("view_set_type") or "") == "single"
            and not str(row.get("view_key") or "").strip()
            and str(row.get("status") or "") == "confirmed"
            and vision_ok(row, ("skipped",)),
            scene_node_rows,
        )
        scene_view = find_row(
            lambda row: str(row.get("view_set_type") or "") == "scene-nine-grid"
            and str(row.get("view_key") or "") == scene_view_key,
            scene_node_rows,
        )
        prop_rows = []
        for name in prop_asset_names:
            matched = find_row(
                lambda row, name=name: str(row.get("node_type") or "") in {"prop", "tool", "material"}
                and str(row.get("label") or "").strip() == str(name or "").strip()
                and str(row.get("status") or "") == "confirmed"
                and vision_ok(row),
                asset_rows,
            )
            if matched:
                prop_rows.append(matched)
        missing_props = [
            name
            for name in prop_asset_names
            if not any(str(row.get("label") or "").strip() == str(name or "").strip() for row in prop_rows)
        ]
        tools = [str(item or "").strip() for item in (shot.get("tools") or []) if str(item or "").strip()]
        performance = normalize_storyboard_performance(shot)
        direction = validate_direction({**shot, **{"durationSeconds": shot.get("duration_seconds")}})
        shot_no = shot.get("shot_no")
        blockers: list[str] = [
            f"镜头 {shot_no}：{message}" for message in direction["blockers"]
        ]
        if character_name and not character:
            blockers.append(f"镜头 {shot_no} 引用了不存在的角色「{character_name}」")
        if character_name and not character_asset:
            blockers.append(f"镜头 {shot_no} 的角色「{character_name}」没有绑定角色资产")
        if character_name and not character_asset_pack_row:
            blockers.append(f"镜头 {shot_no} 的角色「{character_name}」没有已采用的完整角色资产板，请在资产页等待五区视觉检查通过")
        if not scene_asset or not scene_panorama:
            blockers.append(f"镜头 {shot_no} 没有绑定当前场景全景资产")
        for name in missing_props:
            blockers.append(f"镜头 {shot_no} 引用的道具「{name}」没有已确认道具资产")
        if blockers:
            raise StoryboardGateError(f"分镜资产引用门禁未通过：{'；'.join(blockers)}")

        pack_version = character_asset_pack_row.get("version_no") if character_asset_pack_row else None
        asset_reference = {
            "schemaVersion": 1,
            "source": "storyboard-agent",
            "characterId": _asset_node_row_id(character_asset) if character_asset else 0,
            "characterVersionNo": pack_version or (character_asset.get("version_no") if character_asset else None) or None,
            "characterViewSetVersion": (
                character_asset_pack_row.get("view_set_version") if character_asset_pack_row else None
            )
            or pack_version
            or None,
            "characterViewKeys": ["front", "side", "back"],
            "characterBaseImageId": (
                character_asset_pack_row.get("image_id") if character_asset_pack_row else None
            )
            or (character_asset_pack_row.get("asset_node_id") if character_asset_pack_row else None)
            or None,
            "characterBaseVersionNo": pack_version or None,
            "characterFaceImageId": (
                character_asset_pack_row.get("image_id") if character_asset_pack_row else None
            )
            or (character_asset_pack_row.get("asset_node_id") if character_asset_pack_row else None)
            or None,
            "characterFaceVersionNo": pack_version or None,
            "characterAssetPackImageId": character_asset_pack_row.get("image_id") if character_asset_pack_row else None,
            "characterAssetPackVersionNo": pack_version or None,
            "characterFaceRequired": character_face_required,
            "characterName": (character or {}).get("name") or character_name or None,
            "sceneAssetId": _asset_node_row_id(scene_asset) if scene_asset else 0,
            "scenePanoramaVersion": (scene_panorama or {}).get("version_no") or (scene_asset or {}).get("version_no") or None,
            "scenePanoramaImageId": (scene_panorama or {}).get("image_id") or (scene_asset or {}).get("asset_node_id") or None,
            "sceneViewSetVersion": (scene_asset or {}).get("view_set_version") or None,
            "sceneAssetNames": list(dict.fromkeys(
                [*scene_asset_names, str((scene_asset or {}).get("label") or "").strip()]
            )),
            "sceneViewKey": scene_view_key or None,
            "sceneViewIndex": (scene_view or {}).get("view_index") or None,
            "propAssetNames": prop_asset_names,
            "propAssetIds": [_asset_node_row_id(row) for row in prop_rows if _asset_node_row_id(row)],
            "propImageIds": [int(row.get("image_id") or 0) for row in prop_rows],
            "propAssetRefs": [
                {
                    "assetNodeId": _asset_node_row_id(row),
                    "imageId": int(row.get("image_id") or 0) or None,
                    "name": str(row.get("label") or "").strip(),
                    "versionNo": int(row.get("version_no") or 0) or None,
                }
                for row in prop_rows
            ],
            "tools": tools,
            "emotionalChange": performance["emotionChange"],
            "gazePlan": direction["gaze"],
            "soundPlan": direction["sound"],
            "performance": performance,
            "startState": shot.get("start_state") or "",
            "endState": shot.get("end_state") or "",
            "startVisualPrompt": shot.get("start_visual_prompt") or "",
            "endVisualPrompt": shot.get("end_visual_prompt") or "",
        }
        rows.append(
            {
                "shot_no": shot.get("shot_no"),
                "shot_type": shot.get("shot_type"),
                "camera_angle": shot.get("camera_angle"),
                "composition": shot.get("composition"),
                "duration_seconds": normalize_storyboard_duration_seconds(shot.get("duration_seconds")),
                "character_id": _match_character_id_fallback(shot.get("character_name"), project_characters),
                "character_name": shot.get("character_name"),
                "action_text": shot.get("action_text"),
                "dialogue_text": shot.get("dialogue_text"),
                "visual_prompt": build_storyboard_mentioned_prompt(shot.get("visual_prompt"), asset_reference),
                "start_visual_prompt": shot.get("start_visual_prompt") or None,
                "end_visual_prompt": shot.get("end_visual_prompt") or None,
                "asset_reference_json": json.dumps(asset_reference, ensure_ascii=False),
                "sort_order": index,
            }
        )
    return rows


def _match_character_id_fallback(character_name: Any, characters: list[dict[str, Any]]) -> int | None:
    """Node matchCharacterId 的薄包装（精确 → 部分匹配）。"""
    from app.domain.storyboard_ai import match_character_id

    return match_character_id(character_name, characters)


def story_bible_db_values(bible: dict[str, Any], report: dict[str, Any], *, locked: bool) -> dict[str, Any]:
    """Node storyBibleDbValues 等价实现：设定 DTO → story_bibles 列值。

    :param bible: normalize_story_bible_input 后的设定。
    :param report: evaluate_story_bible 的质量报告。
    :param locked: 是否锁定版。
    :returns: 持久化列值字典（列表字段序列化为 JSON 字符串）。
    """
    return {
        "status": "locked" if locked else "draft",
        "title": bible.get("title"),
        "logline": bible.get("logline"),
        "audience": bible.get("audience"),
        "emotionalPromise": bible.get("emotionalPromise"),
        "worldRules": json.dumps(bible.get("worldRules") or [], ensure_ascii=False),
        "timeline": json.dumps(bible.get("timeline") or [], ensure_ascii=False),
        "locations": json.dumps(bible.get("locations") or [], ensure_ascii=False),
        "characters": json.dumps(bible.get("characters") or [], ensure_ascii=False),
        "relationships": json.dumps(bible.get("relationships") or [], ensure_ascii=False),
        "props": json.dumps(bible.get("props") or [], ensure_ascii=False),
        "mainPlot": bible.get("mainPlot"),
        "subplots": json.dumps(bible.get("subplots") or [], ensure_ascii=False),
        "foreshadowing": json.dumps(bible.get("foreshadowing") or [], ensure_ascii=False),
        "lockedFacts": json.dumps(bible.get("lockedFacts") or [], ensure_ascii=False),
        "flexibleFacts": json.dumps(bible.get("flexibleFacts") or [], ensure_ascii=False),
        "visualSymbols": json.dumps(bible.get("visualSymbols") or [], ensure_ascii=False),
        "qualityReport": json.dumps(report, ensure_ascii=False),
        "lockedAt": None,
    }


def season_structure_db_values(season: dict[str, Any], report: dict[str, Any], *, locked: bool) -> dict[str, Any]:
    """Node seasonStructureDbValues 等价实现：分集大纲 DTO → season_structures 列值。"""
    return {
        "status": "locked" if locked else "draft",
        "seasonTheme": season.get("seasonTheme"),
        "coreConflict": season.get("coreConflict"),
        "structureType": season.get("structureType"),
        "episodeCount": season.get("episodeCount"),
        "episodes": json.dumps(season.get("episodes") or [], ensure_ascii=False),
        "foreshadowingPlan": json.dumps(season.get("foreshadowingPlan") or [], ensure_ascii=False),
        "characterArcs": json.dumps(season.get("characterArcs") or [], ensure_ascii=False),
        "qualityReport": json.dumps(report, ensure_ascii=False),
        "lockedAt": None,
    }


_FRAME_REFERENCE_CAPABILITIES: dict[str, dict[str, Any]] = {
    "agnes": {"supports": True, "max": 8},
    "toapi": {"supports": True, "max": 8},
    "volcengine": {"supports": True, "max": 8},
    "bigmodel": {"supports": False, "max": 0},
    "zhipu": {"supports": False, "max": 0},
    "trae-url": {"supports": False, "max": 0},
    "mock": {"supports": False, "max": 0},
}


def assert_frame_reference_image_support(
    *, provider: str, model_name: str, reference_image_urls: list[str], reference_image_storage_keys: list[str] | None = None
) -> None:
    """Node assertFrameReferenceImageSupport：通道不支持定妆参考图时 409 抛错。

    :param provider: 图片供应商标识。
    :param model_name: 模型名。
    :param reference_image_urls: 参考图 URL 列表。
    :raises StoryboardGateError: 有参考图但通道不支持（Node statusCode=409）。
    """
    import os
    import re as _re

    references = [
        url
        for url in (str(item or "").strip() for item in reference_image_urls or [])
        if _re.match(r"^https?://", url, _re.I) or _re.match(r"^data:image/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$", url, _re.I)
    ]
    storage_keys = [str(item or "").strip() for item in reference_image_storage_keys or [] if str(item or "").strip()]
    if not references and not storage_keys:
        return
    capabilities = _FRAME_REFERENCE_CAPABILITIES.get(
        str(provider or os.environ.get("FRAME_PROVIDER", "trae-url")).strip().lower(),
        {"supports": False, "max": 0},
    )
    if not capabilities["supports"]:
        raise StoryboardGateError(
            f"当前图片生成通道 {provider}{f' / {model_name}' if model_name else ''} "
            "不支持定妆参考图输入，不能保证角色同脸和穿搭一致。请切换到支持 reference_images 的图片模型。"
        )


def _frame_reference_default_model(provider: str) -> str:
    """Node getFrameConfig 的 defaultModel 分支（frame.mjs L267 的模型表）。"""
    return {
        "agnes": "agnes-image-2.1-flash",
        "toapi": "gpt-image-2",
        "volcengine": "doubao-seedream-5-0-flash-260915",
        "bigmodel": "cogview-3-flash",
        "zhipu": "cogview-3-flash",
    }.get(provider, "trae-text2image-v1")


async def _build_frame_image_job(db: Any, shot: dict[str, Any], shot_id: int, body: dict[str, Any]) -> dict[str, Any]:
    """静帧任务入队的编排细节（enqueue_frame_image_route 的受控异常边界内执行）。

    对齐 Node enqueueFrameImageJob（index.mjs L2862）：资产引用门禁 →
    frameCharacterContext 就绪门禁 → 一致性提示词 → 参考图通道断言 →
    generation_jobs 入队（active 任务幂等复用）。

    :param db: 数据库适配器。
    :param shot: 分镜行（含 project_visual_style/project_id）。
    :param shot_id: 分镜 id。
    :param body: 请求体（frameRole/prompt/negativePrompt/candidateCount/modelName）。
    :returns: generation_jobs 行。
    :raises StoryboardGateError: 资产门禁/角色上下文未就绪/参考图通道不支持。
    :raises Exception: DB 故障原样抛出（网关兜底 500/5001）。
    """
    import os as _os

    # 资产引用门禁（Node 第一道闸，L2876）。
    asset_gate = await asyncio.to_thread(
        inspect_storyboard_asset_reference_gate,
        storyboard=shot,
        require_character=bool(shot.get("character_id") or shot.get("character_name")),
        require_scene=True,
    )
    if not asset_gate["passed"]:
        raise StoryboardGateError(asset_gate["summary"])
    characters = await asyncio.to_thread(db.list_frame_characters, int(shot["project_id"]))
    context = await asyncio.to_thread(resolve_frame_character_context, shot, characters)
    if not context["ready"]:
        raise StoryboardGateError(context["blockers"][0] or "分镜角色信息不完整，无法保证画面一致性")
    frame_role = normalize_frame_role(body.get("frameRole"))
    prompt_override = str(body.get("prompt")).strip() if body.get("prompt") else ""
    negative_prompt = str(body.get("negativePrompt")).strip() if body.get("negativePrompt") else ""
    consistency_prompt = build_frame_consistency_prompt(
        prompt=prompt_override or frame_role_prompt_fallback(shot, frame_role),
        negative_prompt=negative_prompt,
        storyboard=shot,
        context=context,
        project_visual_style=shot.get("project_visual_style"),
    )
    frame_provider = str(_os.environ.get("FRAME_PROVIDER") or "trae-url").strip().lower()
    model_name = str(body.get("modelName") or _frame_reference_default_model(frame_provider)).strip()
    assert_frame_reference_image_support(
        provider=frame_provider,
        model_name=model_name,
        reference_image_urls=consistency_prompt["referenceImageUrls"],
        reference_image_storage_keys=consistency_prompt["referenceImageStorageKeys"],
    )
    version_no = await asyncio.to_thread(db.next_image_version, shot_id)
    return await asyncio.to_thread(
        db.create_generation_job,
        int(shot["project_id"]),
        "frame_image",
        shot_id,
        {
            "shotId": shot_id,
            "versionNo": version_no,
            "frameRole": frame_role,
            "candidateCount": max(1, min(3, _parse_id_value(body.get("candidateCount")) or 1)),
            "modelName": model_name,
            "promptSnapshot": consistency_prompt["prompt"],
            "negativePrompt": consistency_prompt["negativePrompt"],
            "characterSnapshot": create_frame_character_snapshot(context),
            "referenceImageUrls": consistency_prompt["referenceImageUrls"],
            "referenceImageStorageKeys": consistency_prompt["referenceImageStorageKeys"],
        },
    )


class VideoEnqueueError(Exception):
    """付费生成任务入队的受控业务抛错（对齐 Node error.statusCode + qualityReport 传递）。

    Node enqueueStoryboardVideoJob / enqueueLipSyncJob 的业务抛错由路由统一包成
    ``fail(res, 4011, message, error?.statusCode || 400, qualityReport?)``；
    Python 侧由本异常携带等价三元组，路由捕获后转同形 envelope。

    :ivar message: 受控业务文案（原样透传给前端）。
    :ivar status_code: HTTP 状态码（Node error.statusCode，缺省 400）。
    :ivar quality_report: 可选质检报告（视频入队 409 附带 data.qualityReport）。
    """

    def __init__(self, message: str, status_code: int = 400, quality_report: dict[str, Any] | None = None):
        """初始化受控异常。

        :param message: 受控业务文案。
        :param status_code: HTTP 状态码。
        :param quality_report: 可选质检报告 dict。
        """
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.quality_report = quality_report


def _parse_json_object_value(value: Any) -> dict[str, Any]:
    """Node parseJsonObject（index.mjs L8325）：对象原样返回，字符串尝试解析，失败返回 {}。

    :param value: 任意输入。
    :returns: dict（解析失败为空 dict）。
    """
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _number_or_zero(value: Any) -> float:
    """Node Number(value) 的入队真值判定语义（NaN/Infinity/非法 → 0，等价 falsy）。

    :param value: 任意输入。
    :returns: 有限数值；非法输入返回 0.0。
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0.0
    return parsed if math.isfinite(parsed) else 0.0


FINAL_EDIT_AUDIO_TRACKS = ("dialogue", "narration", "music", "sfx")


def _normalize_final_edit_draft(raw_draft: Any, video_items: list[dict[str, Any]], audio_tracks: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Normalize editable clip order/enabled state and audio mix like Node normalizeFinalEditDraft."""
    draft = _safe_json_object(raw_draft)
    context_ids = {int(item["storyboardId"]) for item in video_items if _parse_id_value(item.get("storyboardId"))}
    seen: set[int] = set()
    video_clips: list[dict[str, Any]] = []
    raw_clips = draft.get("videoClips") if isinstance(draft.get("videoClips"), list) else []
    for index, item in enumerate(raw_clips):
        if not isinstance(item, dict):
            continue
        storyboard_id = _parse_id_value(item.get("storyboardId"))
        if not storyboard_id or (context_ids and storyboard_id not in context_ids) or storyboard_id in seen:
            continue
        seen.add(storyboard_id)
        video_clips.append({
            "storyboardId": storyboard_id,
            "enabled": item.get("enabled") is not False,
            "order": _parse_id_value(item.get("order")) or index + 1,
        })

    raw_mix = _safe_json_object(draft.get("audioMix"))
    audio_mix: dict[str, dict[str, Any]] = {}
    for track_key in FINAL_EDIT_AUDIO_TRACKS:
        raw_track = _safe_json_object(raw_mix.get(track_key))
        fallback_enabled = bool(audio_tracks.get(track_key))
        try:
            volume_number = float(raw_track.get("volume", 100))
            volume = int(round(volume_number)) if math.isfinite(volume_number) else 100
        except (TypeError, ValueError):
            volume = 100
        audio_mix[track_key] = {
            "enabled": raw_track.get("enabled") is not False if "enabled" in raw_track else fallback_enabled,
            "volume": max(0, min(100, volume)),
        }
    return {"videoClips": video_clips, "audioMix": audio_mix}


def _build_final_edit_validation(
    video_items: list[dict[str, Any]],
    audio_tracks: dict[str, list[dict[str, Any]]],
    audio_mix: dict[str, dict[str, Any]],
    completeness: dict[str, Any],
) -> dict[str, Any]:
    """Build final-edit export blockers/warnings without starting an export job."""
    enabled_items = [item for item in video_items if item.get("enabled") is not False]
    available_audio_count = sum(bool(audio_tracks.get(key)) for key in FINAL_EDIT_AUDIO_TRACKS)
    enabled_audio_count = sum(
        bool(audio_tracks.get(key)) and audio_mix.get(key, {}).get("enabled") is not False
        for key in FINAL_EDIT_AUDIO_TRACKS
    )
    total_storyboards = int(completeness.get("totalStoryboardCount") or 0)
    missing_scenes = int(completeness.get("missingStoryboardSceneCount") or 0)
    missing_videos = max(total_storyboards - len(video_items), 0)
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if missing_scenes:
        blockers.append({"code": "missing-storyboards", "message": f"还有 {missing_scenes} 个场景尚未生成分镜，请先完成场景拆镜。"})
    elif total_storyboards == 0:
        blockers.append({"code": "missing-storyboards", "message": "当前项目还没有分镜，请先完成场景拆镜。"})
    if missing_videos and video_items:
        warnings.append({"code": "mixed-media", "message": f"还有 {missing_videos} 个分镜没有确认媒体，本次导出将使用已确认视频和静帧完成混合成片。"})
    if video_items and not enabled_items:
        blockers.append({"code": "all-video-disabled", "message": "当前所有视频片段都被禁用了，导出前至少保留一个启用片段。"})
    if not available_audio_count:
        warnings.append({"code": "missing-audio", "message": "当前还没有已确认音频，成片可先预览视频，但导出前建议先补齐音频主版本。"})
    elif not enabled_audio_count:
        warnings.append({"code": "all-audio-disabled", "message": "当前所有音频轨都被关闭了，如需带音频导出，请至少开启一个轨道。"})
    duration = sum(_number_or_zero(item.get("durationSeconds")) for item in enabled_items)
    return {
        "canExport": not blockers,
        "enabledVideoCount": len(enabled_items),
        "enabledVideoDurationSeconds": duration,
        "availableAudioTrackCount": available_audio_count,
        "enabledAudioTrackCount": enabled_audio_count,
        "totalStoryboardCount": total_storyboards,
        "confirmedVideoCount": len(video_items),
        "missingVideoCount": missing_videos,
        "missingStoryboardSceneCount": missing_scenes,
        "blockingIssues": blockers,
        "warningIssues": warnings,
    }


def _build_project_final_edit(context: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """Assemble the Node-compatible final-edit payload from owner-scoped database rows."""
    project = context["project"]
    project_id = int(project["id"])
    video_items: list[dict[str, Any]] = []
    source_duration = 0.0
    for row in context.get("videoRows") or []:
        duration = _number_or_zero(row.get("video_duration_seconds"))
        if duration <= 0:
            duration = _number_or_zero(row.get("storyboard_duration_seconds")) or 4
        source_duration += duration
        image_url = _resolve_object_storage_url(
            row.get("image_storage_key"), row.get("confirmed_image_url"), settings
        )
        has_video = bool(row.get("video_asset_id") and row.get("video_url"))
        video_url = None
        if has_video:
            video_url = _resolve_object_storage_url(row.get("video_storage_key"), row.get("video_url"), settings)
            if not row.get("video_storage_key"):
                video_url = _normalize_generated_media_url(video_url, settings.public_base_url)
        video_items.append({
            "storyboardId": int(row["storyboard_id"]),
            "episodeNo": row.get("episode_no"),
            "sceneId": int(row["scene_id"]),
            "sceneNo": row.get("scene_no"),
            "sceneTitle": row.get("scene_title"),
            "shotNo": row.get("shot_no"),
            "shotType": row.get("shot_type"),
            "dialogueText": row.get("dialogue_text") or None,
            "durationSeconds": duration,
            "sourceType": "video" if has_video else "static",
            "videoUrl": video_url,
            "imageUrl": image_url,
            "thumbnailUrl": (
                _resolve_object_storage_url(row.get("video_storage_key"), row.get("thumbnail_url") or row.get("video_url"), settings)
                if row.get("video_storage_key")
                else row.get("thumbnail_url") or row.get("confirmed_image_thumbnail_url") or image_url
            ),
            "versionNo": row.get("video_version_no") or 1,
            "confirmedAt": row.get("video_confirmed_at"),
            "sortOrder": row.get("sort_order") or 0,
            "enabled": True,
            "order": len(video_items) + 1,
        })

    audio_tracks: dict[str, list[dict[str, Any]]] = {key: [] for key in FINAL_EDIT_AUDIO_TRACKS}
    for row in context.get("audioRows") or []:
        track_type = str(row.get("track_type") or "")
        if track_type not in audio_tracks:
            continue
        title = row.get("title")
        if not title:
            scene_label = f"Scene {int(row['scene_no']):02d}" if row.get("scene_no") else ""
            scene_title = row.get("scene_title") or scene_label or "项目"
            if track_type == "dialogue":
                title = f"对白轨{f' · {row.get('storyboard_shot_no')}' if row.get('storyboard_shot_no') else ''} - {row.get('character_name') or row.get('scene_title') or scene_label or '未命名来源'}"
            elif track_type == "narration":
                title = f"旁白轨 - {scene_title}"
            elif track_type == "music":
                title = f"音乐轨 - {scene_title}"
            else:
                title = f"音效轨 - {scene_title}"
        audio_url = _resolve_object_storage_url(row.get("storage_key"), row.get("audio_url"), settings)
        audio_tracks[track_type].append({
            "id": int(row["id"]), "projectId": project_id, "trackType": track_type,
            "sceneId": row.get("scene_id"), "storyboardId": row.get("storyboard_id"),
            "shotNo": row.get("storyboard_shot_no"), "characterId": row.get("character_id"),
            "versionNo": row.get("version_no") or 1, "title": title, "audioUrl": audio_url,
            "durationSeconds": _number_or_zero(row.get("duration_seconds")) or None,
            "startOffsetSeconds": _number_or_zero(row.get("start_offset_seconds")),
            "voiceName": str(row.get("voice_name") or "").strip() or None,
            "modelName": row.get("model_name"), "confirmedAt": row.get("confirmed_at"),
            "createdAt": row.get("created_at"),
        })

    draft_row = context.get("draft") or {}
    draft_raw = draft_row.get("draft_json")
    normalized = _normalize_final_edit_draft(draft_raw, video_items, audio_tracks)
    draft_map = {item["storyboardId"]: item for item in normalized["videoClips"]}
    has_draft_clips = bool(draft_map)
    fallback_order = len(draft_map) + 1
    for index, item in enumerate(video_items):
        draft_item = draft_map.get(item["storyboardId"])
        item["enabled"] = draft_item["enabled"] if draft_item else not has_draft_clips
        item["order"] = draft_item["order"] if draft_item else fallback_order + index
    video_items.sort(key=lambda item: (
        _number_or_zero(item.get("order")), _number_or_zero(item.get("sceneNo")),
        _number_or_zero(item.get("sortOrder")), _number_or_zero(item.get("storyboardId")),
    ))
    for index, item in enumerate(video_items, start=1):
        item["order"] = index
    completeness_row = context.get("completeness") or {}
    completeness = {
        "totalStoryboardCount": int(completeness_row.get("total_storyboard_count") or 0),
        "missingStoryboardSceneCount": int(completeness_row.get("missing_storyboard_scene_count") or 0),
    }
    validation = _build_final_edit_validation(video_items, audio_tracks, normalized["audioMix"], completeness)
    confirmed_audio_count = sum(len(items) for items in audio_tracks.values())
    return {
        "projectId": project_id,
        "projectName": project.get("name"),
        "videoTrack": {
            "items": video_items, "totalCount": len(video_items), "totalDurationSeconds": source_duration,
            "enabledCount": validation["enabledVideoCount"],
            "enabledDurationSeconds": validation["enabledVideoDurationSeconds"],
        },
        "audioTracks": audio_tracks,
        "audioMix": normalized["audioMix"],
        "draft": {
            "videoClips": [{"storyboardId": item["storyboardId"], "enabled": item["enabled"], "order": item["order"]} for item in video_items],
            "audioMix": normalized["audioMix"], "updatedAt": draft_row.get("updated_at"),
        },
        "validation": validation,
        "summary": {
            "confirmedVideoCount": len(video_items), "confirmedAudioCount": confirmed_audio_count,
            "hasVideo": bool(video_items), "hasAudio": bool(confirmed_audio_count),
            "totalDurationSeconds": validation["enabledVideoDurationSeconds"],
            "sourceDurationSeconds": source_duration,
            "enabledAudioTrackCount": validation["enabledAudioTrackCount"],
            "availableAudioTrackCount": validation["availableAudioTrackCount"],
            "totalStoryboardCount": completeness["totalStoryboardCount"],
            "missingVideoCount": validation["missingVideoCount"],
            "missingStoryboardSceneCount": completeness["missingStoryboardSceneCount"],
        },
    }


def _normalize_generated_media_url(value: Any, public_base_url: Any) -> str | None:
    """Node normalizeGeneratedMediaUrl（media-public-url.mjs）薄包装（视频确认路径用）。"""
    return normalize_generated_media_url(value, public_base_url)


def _local_generated_path_from_url(value: Any, settings: Settings) -> str | None:
    """Node localGeneratedPathFromUrl（index.mjs L468）：本机生成媒体 URL → 本地文件路径。

    仅接受 127.0.0.1 / localhost / ::1 / 配置公网 host；``/storage/`` 需本地对象存储
    且键可解析进存储根；``/generated/{video,audio,frame,export}/`` 映射到对应生成目录。

    :param value: 媒体 URL。
    :param settings: 服务配置（公网基址、存储根、生成目录）。
    :returns: 本地文件绝对路径；非本机资源返回 None。
    """
    raw = str(value or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if not (parts.scheme in {"http", "https"} and parts.netloc):
        return None
    hostname = (parts.hostname or "").lower()
    configured_host = ""
    base = str(settings.public_base_url or "").strip()
    if base:
        base_parts = urlsplit(base)
        configured_host = (base_parts.hostname or "").lower()
    if hostname not in {"127.0.0.1", "localhost", "::1"} and hostname != configured_host:
        return None
    try:
        pathname = unquote(parts.path or "")
    except Exception:
        return None
    if pathname.startswith("/storage/") and str(settings.object_storage_provider or "").strip().lower() == "local":
        # Node objectStorage.resolveLocalPath 的键清洗等价：剥离引导斜杠并限制在存储根内。
        key = pathname[len("/storage/"):].lstrip("/\\")
        if not key or ".." in key.split("/"):
            return None
        storage_root = Path(str(settings.object_storage_root)).resolve()
        try:
            resolved = (storage_root / key).resolve()
            resolved.relative_to(storage_root)
        except Exception:
            return None
        return str(resolved)
    generated_dirs = {
        "/generated/video/": settings.generated_video_dir,
        "/generated/audio/": settings.generated_audio_dir,
        "/generated/frame/": settings.generated_frame_dir,
        "/generated/export/": settings.generated_export_dir,
    }
    for prefix, directory in generated_dirs.items():
        if pathname.startswith(prefix):
            return str(Path(str(directory)) / Path(pathname).name)
    return None


def _resolve_video_confirmation_source(
    *, storage_key: Any, video_url: Any, local_path: str | None, create_signed_url: Any
) -> dict[str, Any]:
    """Node resolveVideoConfirmationSource（media-url.mjs L26）：确认后的播放地址来源。

    :param storage_key: 对象存储键（命中 → 签名 URL，不落盘）。
    :param video_url: 当前视频地址。
    :param local_path: 本地生成文件路径（命中 → shouldPersist=False）。
    :param create_signed_url: 签名回调；storage_key 存在但不可签名时抛错（Node 同形）。
    :returns: ``{"videoUrl": ..., "shouldPersist": bool}``。
    :raises RuntimeError: 有 storage_key 但签名器不可用/签名失败。
    """
    key = str(storage_key or "").strip()
    if key:
        if not callable(create_signed_url):
            raise RuntimeError("object storage URL signer is unavailable")
        signed = create_signed_url(key)
        if not signed:
            raise RuntimeError("object storage URL signer is unavailable")
        return {"videoUrl": signed, "shouldPersist": False}
    source_url = str(video_url or "").strip()
    return {"videoUrl": source_url or None, "shouldPersist": not local_path and not key}


def _ensure_audio_asset_storage(audio: dict[str, Any] | None, *, create_signed_url: Any) -> dict[str, Any] | None:
    """口型入队的音频存储确保（Node ensureAudioAssetStorage 的入队可见子集）。

    storage_key 命中 → 换签名 URL 返回；未命中 → 原样透传（audio_url 由生成链路保证
    可访问）。有意差异：Node 缺 key 时会在请求线程内下载并转存对象存储（依赖本地盘
    与 COS 凭据）；FastAPI 网关不复制该行为，缺 key 记录按原 audio_url 入队。

    :param audio: audio_assets 行。
    :param create_signed_url: storage_key → 签名 URL 回调。
    :returns: 处理后的音频行（可能换 audio_url）；入参为 None 时返回 None。
    """
    if not isinstance(audio, dict) or not audio.get("id") or not audio.get("project_id"):
        return audio
    key = str(audio.get("storage_key") or "").strip()
    if key:
        try:
            signed = create_signed_url(key) if callable(create_signed_url) else None
        except Exception:
            signed = None
        if signed:
            return {**audio, "audio_url": signed}
    return audio


def _direction_contract_or_raise(reference: dict[str, Any], shot: dict[str, Any]) -> dict[str, Any]:
    """视线/声音执行合同校验（对齐 Node L2962）：未通过 → 409 + qualityReport。

    :param reference: 分镜资产引用 JSON。
    :param shot: 分镜行。
    :returns: ``{passed, blockers, gaze, sound}``。
    :raises VideoEnqueueError: blockers 非空（Node statusCode=409）。
    """
    performance = reference.get("performance")
    performance_ref = performance if isinstance(performance, dict) else {}
    direction_input = {
        **shot,
        **performance_ref,
        "gazePlan": reference.get("gazePlan") or performance_ref.get("gazePlan") or shot.get("gaze_plan"),
        "soundPlan": reference.get("soundPlan") or performance_ref.get("soundPlan") or shot.get("sound_plan"),
    }
    contract = validate_direction(direction_input)
    if not contract["passed"]:
        message = f"本镜头视线/声音执行计划未通过校验：{'；'.join(contract['blockers'])}"
        raise VideoEnqueueError(
            message,
            status_code=409,
            quality_report={
                "passed": False,
                "blockers": [
                    {"code": "storyboard-direction-contract-incomplete", "message": blocker}
                    for blocker in contract["blockers"]
                ],
                "summary": "本镜头视线/声音执行计划未就绪",
            },
        )
    return contract


def _latest_usable_image(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Node latestUsableImage（L3310）：有图行按 version_no/id 降序取首行。

    :param rows: 候选资产行。
    :returns: 最新可用行；无有图行 None。
    """
    usable = [row for row in rows if row.get("image_url") or row.get("thumbnail_url")]
    usable.sort(
        key=lambda row: (-_number_or_zero(row.get("version_no")), -_number_or_zero(row.get("id")))
    )
    return usable[0] if usable else None


async def _build_storyboard_video_job(
    db: Any,
    shot: dict[str, Any],
    storyboard_id: int,
    user_id: int,
    body: dict[str, Any],
    *,
    resolve_object_url: Any,
    public_base_url: str,
) -> dict[str, Any]:
    """视频生成任务入队编排（Node enqueueStoryboardVideoJob L2941-3489 的 Python 复刻）。

    门禁链与 Node 逐条同序：方向合同 → 片段衔接帧引用 → 资产引用门禁 → 场景资产绑定
    → 锁定参考图完备性 → 质检门禁 → 模型/服务商断言 → 时长边界 → 场景/角色选中图 →
    参考图上限 → 引用快照校验；全部通过后写 video_image 任务（快照逐字段对照
    tests/fixtures/generate_video_fixtures.mjs 锁定的构建器输出）。

    :param db: 数据库适配器。
    :param shot: 分镜行（含 project_id / aspect_ratio / asset_reference_json）。
    :param storyboard_id: 分镜 id。
    :param user_id: 当前用户 id（资产归属查询用）。
    :param body: 请求体（prompt/mentionTools/voiceBindings/referencedAssets/motionMode/
        durationSeconds/candidateCount/modelName/imageRatio/aspectRatio/allowCandidateAssets）。
    :param resolve_object_url: storage_key → 签名 URL 回调。
    :param public_base_url: 当前公网基址（本实现未消费；保留与 Node PUBLIC_BASE_URL 对位）。
    :returns: generation_jobs 行。
    :raises VideoEnqueueError: 任一门禁未通过（Node statusCode 400/409）。
    :raises Exception: DB 故障原样抛出（网关兜底 500/5001）。
    """
    project_id = int(shot["project_id"])
    prompt_override = sanitize_storyboard_prompt(
        body.get("prompt") or shot.get("visual_prompt"),
        character_names=[shot.get("character_name")],
    )
    reference = _parse_json_object_value(
        shot.get("asset_reference_json") or shot.get("assetReference") or shot.get("asset_reference")
    )
    direction_contract = _direction_contract_or_raise(reference, shot)

    continuity_prompt = "\n".join(
        [value for value in (prompt_override, shot.get("visual_prompt"), shot.get("start_visual_prompt")) if value]
    )
    continuity_enabled = should_use_storyboard_continuity(
        tools=body.get("mentionTools") or reference.get("tools"),
        prompt=continuity_prompt,
        asset_reference=reference,
    )
    requested_continuity_source = (
        resolve_continuity_source_shot_no(prompt=continuity_prompt, asset_reference=reference)
        if continuity_enabled
        else None
    )
    previous_shot = await asyncio.to_thread(
        db.get_continuity_previous_shot,
        int(shot["scene_id"]),
        requested_continuity_source or "",
        int(shot.get("sort_order") or 0),
    )
    if previous_shot and previous_shot.get("end_frame_storage_key"):
        signed = None
        try:
            signed = resolve_object_url(previous_shot["end_frame_storage_key"])
        except Exception:
            signed = None
        previous_shot["end_frame_url"] = signed or previous_shot.get("end_frame_url")
    current_end_frame = await asyncio.to_thread(db.get_confirmed_end_frame_image, storyboard_id)
    frame_reference = build_storyboard_frame_reference(
        continuity_enabled=continuity_enabled,
        previous_shot=previous_shot,
        previous_video=previous_shot,
        current_shot=shot,
        current_end_frame=current_end_frame,
    )
    if continuity_enabled and (not previous_shot or frame_reference["missingStartFrame"]):
        message = "当前镜头已选择片段衔接，但上一镜没有可读取的确认尾帧，请先确认上一镜视频或结束帧"
        raise VideoEnqueueError(
            message,
            status_code=409,
            quality_report={
                "passed": False,
                "blockers": [{"code": "missing-previous-end-frame", "message": message}],
                "summary": message,
            },
        )

    has_character_binding = bool(
        reference.get("characterId") or shot.get("character_id") or shot.get("character_name")
    )
    asset_reference_gate = inspect_storyboard_asset_reference_gate(
        storyboard=shot,
        require_character=has_character_binding,
    )
    if not asset_reference_gate["passed"]:
        raise VideoEnqueueError(asset_reference_gate["summary"], status_code=409, quality_report=asset_reference_gate)

    referenced_assets = body.get("referencedAssets") if isinstance(body.get("referencedAssets"), list) else []
    if not _number_or_zero(reference.get("sceneAssetId")):
        raise VideoEnqueueError(
            "当前分镜没有绑定完整的场景资产版本，请先重新生成分镜并完成资产确认",
            status_code=409,
        )
    mention_context = normalize_storyboard_mention_context(
        referenced_assets=referenced_assets,
        tools=body.get("mentionTools"),
        voice_bindings=body.get("voiceBindings"),
        prompt=shot.get("visual_prompt"),
    )
    referenced_asset_ids = [
        parsed for parsed in (
            _parse_id_value((asset or {}).get("id") or (asset or {}).get("assetId"))
            for asset in referenced_assets
        ) if parsed
    ]
    asset_rows: list[dict[str, Any]] = []
    if referenced_asset_ids:
        asset_rows = list(await asyncio.to_thread(
            db.list_referenced_asset_node_images, referenced_asset_ids, project_id, user_id
        ))

    reference_node_ids = [
        _parse_id_value(reference.get("characterId")),
        _parse_id_value(reference.get("sceneAssetId")),
        *(
            [
                _parse_id_value((item or {}).get("assetNodeId"))
                for item in reference.get("propAssetRefs", [])
            ]
            if isinstance(reference.get("propAssetRefs"), list)
            else [
                _parse_id_value(item) for item in (reference.get("propAssetIds") or [])
            ]
            if isinstance(reference.get("propAssetIds"), list)
            else []
        ),
    ]
    reference_node_ids = [node_id for node_id in reference_node_ids if node_id]
    locked_reference_rows: list[dict[str, Any]] = []
    if reference_node_ids:
        locked_reference_rows = list(await asyncio.to_thread(
            db.list_locked_reference_rows, reference_node_ids, project_id, user_id
        ))

    required_angle_rows = [
        row
        for row in locked_reference_rows
        if (row.get("node_type") == "character" and str(row.get("view_key") or "") in {"front", "side", "back"})
        or (
            row.get("node_type") == "scene"
            and reference.get("sceneViewKey")
            and str(row.get("view_key") or "") == str(reference.get("sceneViewKey") or "")
        )
    ]
    _type_order = {"character": 0, "scene": 1}
    _view_order = {"front": 0, "side": 1, "back": 2}
    required_angle_rows.sort(
        key=lambda row: (
            _type_order.get(row.get("node_type"), 9),
            _view_order.get(str(row.get("view_key") or ""), 3),
            _number_or_zero(row.get("id")),
        )
    )
    character_base_rows = [
        row
        for row in locked_reference_rows
        if row.get("node_type") == "character"
        and str(row.get("view_set_type") or "") in {"single", "character-asset-pack"}
        and not str(row.get("view_key") or "").strip()
    ]
    character_face_rows = [
        row
        for row in locked_reference_rows
        if row.get("node_type") == "character"
        and (
            (row.get("view_set_type") == "character-face-closeup" and str(row.get("view_key") or "") == "face")
            or row.get("view_set_type") == "character-asset-pack"
        )
    ]
    character_asset_pack_rows = [
        row
        for row in locked_reference_rows
        if row.get("node_type") == "character" and row.get("view_set_type") == "character-asset-pack"
    ]
    scene_panorama_rows = [
        row
        for row in locked_reference_rows
        if row.get("node_type") == "scene"
        and not str(row.get("view_key") or "").strip()
        and row.get("view_set_type") == "single"
    ]
    prop_reference_rows = [
        row for row in locked_reference_rows if str(row.get("node_type") or "") in {"prop", "tool", "material"}
    ]
    locked_image_rows: list[dict[str, Any]] = []
    for row in [
        *character_base_rows,
        *character_face_rows,
        *character_asset_pack_rows,
        *scene_panorama_rows,
        *required_angle_rows,
        *prop_reference_rows,
    ]:
        if all(_number_or_zero(existing.get("id")) != _number_or_zero(row.get("id")) for existing in locked_image_rows):
            locked_image_rows.append(row)

    prompt_override = sanitize_storyboard_prompt(
        prompt_override,
        character_names=[
            shot.get("character_name"),
            *[row.get("label") for row in locked_reference_rows if row.get("node_type") == "character"],
        ],
    )
    if prompt_override and prompt_override != str(shot.get("visual_prompt") or "").strip():
        await asyncio.to_thread(db.update_storyboard_visual_prompt, storyboard_id, prompt_override)
        shot["visual_prompt"] = prompt_override

    locked_images = [
        url for url in (row.get("image_url") or row.get("thumbnail_url") for row in locked_image_rows) if url
    ]
    has_character_asset_pack = len(character_asset_pack_rows) > 0
    minimum_locked_image_count = 6 if has_character_binding and not has_character_asset_pack else 1
    if len(locked_images) < minimum_locked_image_count:
        message = "当前分镜绑定的角色参考图或场景全景基准缺失"
        raise VideoEnqueueError(
            message,
            status_code=409,
            quality_report={
                "passed": False,
                "blockers": [{"code": "locked-asset-images-incomplete", "message": message}],
                "summary": message,
            },
        )
    asset_rows = [*asset_rows, *locked_reference_rows]
    auto_referenced_assets = [
        {
            "id": int(row["id"]) if _number_or_zero(row.get("id")) else None,
            "refId": int(row["ref_id"]) if _number_or_zero(row.get("ref_id")) else None,
            "characterId": (
                int(row["ref_id"]) if row.get("node_type") == "character" and _number_or_zero(row.get("ref_id")) else None
            ),
            "kind": (
                "character" if row.get("node_type") == "character"
                else "scene" if row.get("node_type") == "scene"
                else "prop"
            ),
            "name": str(row.get("label") or "").strip(),
            "imageUrl": row.get("image_url") or row.get("thumbnail_url") or None,
            "promptText": (
                ""
                if row.get("node_type") == "character"
                else "；".join([value for value in (row.get("asset_prompt"), row.get("environment_prompt")) if value])
            ),
            "sceneViewKey": row.get("view_key") or None,
            "viewKeys": ["front", "side", "back"] if row.get("node_type") == "character" else [],
            "viewSetVersion": int(row["view_set_version"]) if _number_or_zero(row.get("view_set_version")) else None,
            "versionNo": int(row["version_no"]) if _number_or_zero(row.get("version_no")) else None,
        }
        for row in locked_reference_rows
    ]
    effective_referenced_assets: list[dict[str, Any]] = []
    for asset in [*referenced_assets, *auto_referenced_assets]:
        asset = asset if isinstance(asset, dict) else {}
        key = f"{asset.get('kind')}:{asset.get('name')}:{asset.get('sceneViewKey') or ''}"
        if all(
            f"{existing.get('kind')}:{existing.get('name')}:{existing.get('sceneViewKey') or ''}" != key
            for existing in effective_referenced_assets
        ):
            effective_referenced_assets.append(asset)
    effective_mention_context = normalize_storyboard_mention_context(
        referenced_assets=effective_referenced_assets,
        tools=body.get("mentionTools") or reference.get("tools"),
        voice_bindings=body.get("voiceBindings"),
        prompt=prompt_override or shot.get("visual_prompt"),
    )

    locked_character_row = next((row for row in locked_reference_rows if row.get("node_type") == "character"), None)
    locked_scene_row = next((row for row in locked_reference_rows if row.get("node_type") == "scene"), None)
    character_constraint: dict[str, Any] | None = None
    if locked_character_row and _number_or_zero(locked_character_row.get("ref_id")):
        character_constraint = await asyncio.to_thread(
            db.get_character_constraint_name, int(locked_character_row["ref_id"]), project_id
        )
    scene_asset_prompt = "；".join(
        [
            value
            for value in (
                (locked_scene_row or {}).get("asset_prompt"),
                (locked_scene_row or {}).get("environment_prompt"),
                (locked_scene_row or {}).get("image_prompt"),
            )
            if value
        ]
    )
    continuity_constraints = build_video_continuity_constraints(
        character_name=(
            (character_constraint or {}).get("name") or reference.get("characterName") or shot.get("character_name")
        ),
        scene_asset_prompt=scene_asset_prompt,
    )
    color_continuity_constraints = build_color_continuity_constraints(
        visual_style=shot.get("project_visual_style"),
        scene_prompt=scene_asset_prompt,
        shot_prompt="；".join(
            [
                value
                for value in (shot.get("visual_prompt"), shot.get("composition"), shot.get("camera_angle"))
                if value
            ]
        ),
    )

    referenced_character_ids = [
        _parse_id_value(asset.get("refId") or asset.get("characterId"))
        for asset in mention_context["assets"]
        if str(asset.get("kind") or asset.get("type") or asset.get("nodeType") or "").strip() == "character"
    ]
    referenced_character_ids = [value for value in referenced_character_ids if value]
    voice_rows: list[dict[str, Any]] = []
    if shot.get("character_id"):
        referenced_character_ids.insert(0, _parse_id_value(shot.get("character_id")))
    referenced_character_ids = list(dict.fromkeys(value for value in referenced_character_ids if value))
    if referenced_character_ids:
        voice_rows = list(await asyncio.to_thread(db.list_character_voice_rows, referenced_character_ids, project_id))
    reference_audio_urls: list[str] = []
    seen_audio_urls: set[str] = set()
    for row in voice_rows:
        if not row.get("voice_locked") or not str(row.get("reference_audio_url") or "").strip():
            continue
        url = resolve_reference_audio_url(row, create_signed_url=resolve_object_url)
        if re.match(r"^https?://", url or "", re.I) and url not in seen_audio_urls:
            seen_audio_urls.add(url)
            reference_audio_urls.append(url)
    reference_audio_urls = reference_audio_urls[:3]
    reference_audio_prompt = build_reference_audio_prompt_context(voice_rows, reference_audio_urls)
    effective_mention_context["voices"] = [
        voice
        for voice in [
            *effective_mention_context["voices"],
            *[
                {
                    "characterId": int(row["character_id"]) if _number_or_zero(row.get("character_id")) else None,
                    "characterName": str(row.get("character_name") or "").strip(),
                    "voiceProfileKey": str(row.get("voice_profile_key") or "").strip() or None,
                    "voiceLocked": row.get("voice_locked") in (1, True),
                    "referenceAudioUrl": resolve_reference_audio_url(row, create_signed_url=resolve_object_url),
                }
                for row in voice_rows
            ],
        ]
    ]
    deduped_voices: list[dict[str, Any]] = []
    for voice in effective_mention_context["voices"]:
        if all(existing.get("characterName") != voice.get("characterName") for existing in deduped_voices):
            deduped_voices.append(voice)
    effective_mention_context["voices"] = deduped_voices

    video_config = get_video_provider_config()
    quality_report = inspect_storyboard_generation_context(
        storyboard=shot,
        assets=asset_rows,
        character_voices=voice_rows,
        require_confirmed_assets=body.get("allowCandidateAssets") is not True,
        # Wan consumes Base64 media, so a localhost/signed storage URL is a valid
        # worker-side input even though an external provider could not fetch it.
        require_public_assets=video_config["provider"] != "wan",
    )
    if not quality_report["passed"]:
        raise VideoEnqueueError(quality_report["summary"], status_code=409, quality_report=quality_report)

    transition_images = [url for url in (frame_reference["startFrameUrl"], frame_reference["endFrameUrl"]) if url]
    video_model_name = str(body.get("modelName") or video_config["defaultModel"]).strip()
    try:
        assert_video_model_provider(video_model_name, video_config["provider"])
    except ValueError as exc:
        # Node 断言抛错无 statusCode → 路由兜底 HTTP 400（4011 envelope）。
        raise VideoEnqueueError(str(exc), status_code=400) from exc
    if (
        not re.match(r"^minimax(?:-|$)", video_model_name, re.I)
        and video_config["provider"] not in {"agnes", "wan"}
    ):
        raise VideoEnqueueError(
            "当前视频服务商不支持分镜多资产参考生成，请切换到已支持多参考图的视频模型。",
            status_code=409,
        )
    if re.match(r"^minimax(?:-|$)", video_model_name, re.I):
        image_limit = 9
    elif is_official_agnes_model(video_model_name):
        image_limit = 5
    elif video_config["provider"] == "agnes":
        image_limit = 6
    elif video_config["provider"] == "wan":
        image_limit = 9
    else:
        image_limit = 1
    requested_duration_source = (
        body["durationSeconds"] if "durationSeconds" in body else shot.get("duration_seconds")
    )
    try:
        requested_duration = normalize_storyboard_duration_seconds(requested_duration_source)
    except StoryboardDurationError as exc:
        raise VideoEnqueueError(str(exc), status_code=400) from exc
    if video_config["provider"] == "wan":
        duration_min, duration_limit = 2, 30
    elif re.match(r"^minimax(?:-|$)", video_model_name, re.I):
        duration_min, duration_limit = 4, 15
    else:
        duration_min, duration_limit = 4, 12
    if requested_duration < duration_min or requested_duration > duration_limit:
        raise VideoEnqueueError(
            f"{video_model_name} 单镜只支持 {duration_min}-{duration_limit} 秒，本镜当前为 {requested_duration} 秒；请先调整分镜时长再生成。",
            status_code=400,
        )

    selected_character_rows: list[dict[str, Any]] = []
    if has_character_binding:
        if character_asset_pack_rows:
            selected_character_rows = [
                row for row in [_latest_usable_image(character_asset_pack_rows)] if row
            ]
        else:
            selected_character_rows = [
                row
                for row in [
                    _latest_usable_image(character_base_rows),
                    _latest_usable_image(character_face_rows),
                    *required_angle_rows,
                ]
                if row
            ]
    scene_angle_rows = [
        row
        for row in locked_reference_rows
        if row.get("node_type") == "scene"
        and row.get("view_set_type") == "scene-nine-grid"
        and str(row.get("view_key") or "") == str(reference.get("sceneViewKey") or "")
    ]
    selected_scene_row = _latest_usable_image(scene_angle_rows) or _latest_usable_image(scene_panorama_rows)
    requested_prop_names = {
        str(name or "").strip()
        for name in [
            *(
                reference.get("propAssetNames")
                if isinstance(reference.get("propAssetNames"), list)
                else []
            ),
            *[
                (item or {}).get("name")
                for item in (
                    reference.get("propAssetRefs") if isinstance(reference.get("propAssetRefs"), list) else []
                )
            ],
        ]
        if str(name or "").strip()
    }
    filtered_prop_rows = [
        row
        for row in prop_reference_rows
        if not requested_prop_names or str(row.get("label") or "").strip() in requested_prop_names
    ]
    selected_prop_node_ids: list[float] = []
    for row in filtered_prop_rows:
        node_id = _number_or_zero(row.get("asset_node_id") or row.get("ref_id") or row.get("id"))
        if node_id and all(node_id != existing for existing in selected_prop_node_ids):
            selected_prop_node_ids.append(node_id)
    selected_prop_rows = [
        row
        for row in (
            _latest_usable_image(
                [
                    candidate
                    for candidate in filtered_prop_rows
                    if _number_or_zero(candidate.get("asset_node_id") or candidate.get("ref_id") or candidate.get("id")) == node_id
                ]
            )
            for node_id in selected_prop_node_ids
        )
        if row
    ]
    selected_asset_rows: list[dict[str, Any]] = []
    for row in [*selected_character_rows, selected_scene_row, *selected_prop_rows]:
        if row and all(_number_or_zero(existing.get("id")) != _number_or_zero(row.get("id")) for existing in selected_asset_rows):
            selected_asset_rows.append(row)
    if not selected_scene_row or (has_character_binding and not selected_character_rows):
        raise VideoEnqueueError("本镜缺少已确认的场景视角图或角色资产图，不能提交视频生成。", status_code=409)
    if len(selected_asset_rows) > image_limit:
        raise VideoEnqueueError(
            f"本镜已确认角色、场景和道具资产共需 {len(selected_asset_rows)} 张参考图，"
            f"{video_model_name} 最多接收 {image_limit} 张；请拆分镜头或减少本镜资产引用。",
            status_code=409,
        )
    available_slots = max(0, image_limit - len(selected_asset_rows))
    selected_transition_images = transition_images[:available_slots]
    reference_images = [
        url
        for url in [
            *(row.get("image_url") or row.get("thumbnail_url") for row in selected_asset_rows),
            *selected_transition_images,
        ]
        if url
    ]
    selected_transition_storage_keys = [
        frame_reference["startFrameStorageKey"] if url == frame_reference["startFrameUrl"] else frame_reference["endFrameStorageKey"]
        for url in selected_transition_images
    ]
    every_reference_has_storage_key = all(
        str(row.get("storage_key") or "").strip() for row in selected_asset_rows
    ) and all(str(key or "").strip() for key in selected_transition_storage_keys)
    reference_image_storage_keys = (
        [
            str(key or "").strip()
            for key in [*(row.get("storage_key") for row in selected_asset_rows), *selected_transition_storage_keys]
        ]
        if every_reference_has_storage_key
        else []
    )
    reference_snapshot = build_storyboard_reference_snapshot(
        storyboard=shot,
        reference_images=reference_images,
        referenced_assets=effective_referenced_assets,
    )
    reference_validation = validate_storyboard_reference_snapshot(reference_snapshot)
    if not reference_validation["passed"]:
        raise VideoEnqueueError(
            f"视频资产引用未就绪：{'；'.join(reference_validation['blockers'])}",
            status_code=409,
            quality_report={
                "passed": False,
                "blockers": [
                    {"code": "storyboard-reference-incomplete", "message": blocker}
                    for blocker in reference_validation["blockers"]
                ],
                "summary": "视频资产引用未就绪",
            },
        )

    version_no = await asyncio.to_thread(db.next_video_version, storyboard_id)
    motion_mode = str(body.get("motionMode") or "PAN").strip() or "PAN"
    requested_start_image_url = str(
        body.get("startImageUrl") or body.get("startFrameUrl") or ""
    ).strip()
    first_frame_url = frame_reference["startFrameUrl"] or requested_start_image_url or None
    last_frame_url = frame_reference["endFrameUrl"] if first_frame_url else None
    is_wan_provider = video_config["provider"] == "wan"
    if is_wan_provider and first_frame_url:
        video_reference_image_guide = (
            "首帧锁定：以本次提交的首帧作为唯一画面起点，严格延续首帧中的角色身份、服装、场景结构、光线方向和构图关系；"
            "动作从首帧状态自然开始，不得重新设计角色或跳变空间。"
        )
    elif is_wan_provider:
        video_reference_image_guide = (
            "本镜未提交首帧：严格按文字中的角色身份、固定服装、场景结构和光线方向生成，"
            "不得新增未声明人物或道具；下一镜会以本镜尾帧作为严格首帧。"
        )
    else:
        video_reference_image_guide = build_video_reference_image_guide(
            selected_asset_rows, len(selected_transition_images)
        )
    request_snapshot = {
        "storyboardId": storyboard_id,
        "imageAssetId": None,
        "imageUrl": None,
        "firstFrameUrl": first_frame_url,
        "lastFrameUrl": last_frame_url,
        "versionNo": version_no,
        "motionMode": motion_mode,
        "durationSeconds": requested_duration,
        # Generate one result and let the worker replace the current version after media QC.
        "candidateCount": 1,
        "videoInspectionExpected": infer_video_candidate_expectations(
            duration_seconds=requested_duration_source,
            action_text="\n".join(
                [value for value in (prompt_override, shot.get("action_text"), shot.get("acting_beat")) if value]
            ),
            acting_beat=shot.get("acting_beat"),
            dialogue_text=shot.get("dialogue_text"),
            audio_direction="\n".join(
                [value for value in (prompt_override, shot.get("audio_direction")) if value]
            ),
            gaze_plan=direction_contract["gaze"],
            sound_plan=direction_contract["sound"],
        ),
        "modelName": video_model_name,
        "videoProvider": video_config["provider"],
        "generationMode": "multi_reference",
        "referencedAssets": [
            {
                "key": asset.get("key") or None,
                "kind": asset.get("kind") or None,
                "name": asset.get("name") or None,
                "imageUrl": asset.get("imageUrl") or None,
                "promptText": asset.get("promptText") or None,
                "appearance": asset.get("appearance") or None,
                "costume": asset.get("costume") or None,
                "sceneViewKey": asset.get("sceneViewKey") or None,
                "viewKeys": asset.get("viewKeys") or [],
                "versionNo": asset.get("versionNo") or None,
                "viewSetVersion": asset.get("viewSetVersion") or None,
                "voiceProfileKey": asset.get("voiceProfileKey") or None,
                "voiceLocked": asset.get("voiceLocked") is True,
                "referenceAudioUrl": asset.get("referenceAudioUrl") or None,
            }
            for asset in effective_mention_context["assets"]
        ],
        "referenceImages": reference_images,
        "referenceImageStorageKeys": reference_image_storage_keys,
        "referenceAudioUrls": reference_audio_urls,
        "frameReferences": {
            "continuityEnabled": continuity_enabled,
            "sourceStoryboardId": frame_reference["sourceStoryboardId"],
            "sourceShotNo": frame_reference["sourceShotNo"],
            "startFrameUrl": frame_reference["startFrameUrl"],
            "startFrameStorageKey": frame_reference["startFrameStorageKey"],
            "endFrameUrl": frame_reference["endFrameUrl"],
            "endFrameStorageKey": frame_reference["endFrameStorageKey"],
        },
        "imageRatio": str(
            body.get("imageRatio") or body.get("aspectRatio") or shot.get("aspect_ratio") or "9:16"
        ).strip(),
        "storyboardAssetReference": reference_snapshot,
        "promptSnapshot": build_two_keyframe_video_prompt(
            prompt="\n".join(
                build_storyboard_video_prompt_parts(
                    prompt=prompt_override,
                    context_parts=[
                        video_reference_image_guide,
                        build_storyboard_direction_prompt(
                            gaze_plan=direction_contract["gaze"], sound_plan=direction_contract["sound"]
                        ),
                        build_storyboard_continuity_prompt(frame_reference),
                        continuity_constraints,
                        color_continuity_constraints,
                        build_referenced_asset_prompt_context(effective_mention_context["assets"]),
                        reference_audio_prompt,
                        build_mention_context_prompt(effective_mention_context),
                    ],
                    legacy_field_parts=[
                        f"景别：{shot.get('shot_type') or '由视频模型根据镜头脚本判断'}",
                        f"机位：{shot.get('camera_angle') or '由视频模型根据镜头脚本判断'}",
                        f"构图：{shot.get('composition') or '由视频模型根据镜头脚本判断'}",
                        f"角色情绪与变化：{shot.get('emotional_change') or ''}",
                        f"表演节拍：{shot.get('acting_beat') or ''}",
                        "结构化表演与音画同步：\n"
                        + build_storyboard_performance_prompt(
                            reference.get("performance") if isinstance(reference.get("performance"), dict) else shot
                        ),
                        (
                            f"声音与口型同步：{shot.get('audio_direction') or ''}；"
                            "对白必须逐字对应口型，按自然语速完成，不得提前、延后或用无声口型替代。"
                        ),
                        f"镜头动作：{shot.get('action_text') or ''}",
                        f"对白与声音：{shot.get('dialogue_text') or ''}",
                    ],
                )
            ),
            shot=shot,
            start_image={"image_url": first_frame_url} if first_frame_url else None,
            end_image={"image_url": last_frame_url} if last_frame_url else None,
        ),
        "providerTasks": [],
        # The user must adopt a generated video explicitly; a rerun only replaces the pending result.
        "autoConfirm": False,
    }
    return await asyncio.to_thread(db.create_generation_job, project_id, "video_image", storyboard_id, request_snapshot)


async def _build_lip_sync_job(
    db: Any,
    shot: dict[str, Any],
    storyboard_id: int,
    body: dict[str, Any],
    *,
    resolve_object_url: Any,
) -> dict[str, Any]:
    """口型同步任务入队编排（Node enqueueLipSyncJob L4381-4502 的 Python 复刻）。

    门禁链与 Node 同序：说话角色绑定 → 已确认对白音频 → 说话人归属一致 → 静帧/源视频
    就绪（按 LIP_SYNC_PROVIDER 分支）→ 版本号；通过后写 lip_sync 任务。

    :param db: 数据库适配器。
    :param shot: 分镜行（含 project_id / character_id / resolved_character_name）。
    :param storyboard_id: 分镜 id。
    :param body: 请求体（prompt/cropFilter/autoConfirm/providerTaskId）。
    :param resolve_object_url: storage_key → 签名 URL 回调。
    :returns: generation_jobs 行。
    :raises VideoEnqueueError: 任一门禁未通过（Node statusCode=409）。
    :raises Exception: DB 故障原样抛出（网关兜底 500/5001）。
    """
    if not shot.get("character_id"):
        raise VideoEnqueueError("当前分镜没有绑定说话角色，无法生成口型视频", status_code=409)
    provider = get_lip_sync_provider()
    image = await asyncio.to_thread(db.get_confirmed_storyboard_image, storyboard_id)
    audio = await asyncio.to_thread(db.get_confirmed_dialogue_audio, storyboard_id, int(shot["character_id"]))
    audio = await asyncio.to_thread(_ensure_audio_asset_storage, audio, create_signed_url=resolve_object_url)
    if audio is None:
        raise VideoEnqueueError("请先为当前分镜确认中文对白音频，再生成口型视频", status_code=409)
    if audio.get("character_id") and int(audio["character_id"]) != int(shot["character_id"]):
        shot_character = (
            shot.get("resolved_character_name") or shot.get("character_name") or f"角色 {shot['character_id']}"
        )
        audio_character = audio.get("character_name") or f"角色 {audio['character_id']}"
        raise VideoEnqueueError(
            (
                f"当前分镜绑定的说话人是“{shot_character}”，但已确认对白音频属于“{audio_character}”。"
                "请先在分镜编辑页把当前分镜绑定到真正说话的人，"
                f"或在音频页为“{shot_character}”重新生成并确认对白音频。"
                "多人对白请先使用“AI 拆分多人对白”，按对白从上到下拆成单人说话分镜。"
            ),
            status_code=409,
        )
    source_video = await asyncio.to_thread(db.get_lip_sync_source_video, storyboard_id)
    can_use_source_video = provider in {"dashscope", "latentsync"}
    if image is None and not (can_use_source_video and source_video and source_video.get("video_url")):
        raise VideoEnqueueError("请先确认当前分镜静帧，再生成口型视频", status_code=409)
    if provider == "latentsync" and not (source_video and source_video.get("video_url")):
        raise VideoEnqueueError("LatentSync 是视频后处理服务，请先生成并确认当前分镜视频", status_code=409)
    version_no = await asyncio.to_thread(db.next_video_version, storyboard_id)
    character_name = shot.get("resolved_character_name") or shot.get("character_name") or "人物"
    audio_duration = audio.get("duration_seconds")
    generation_duration_seconds = (
        resolve_dash_scope_lip_sync_duration(audio_duration, shot.get("duration_seconds"))
        if provider == "dashscope"
        else resolve_lip_sync_duration(audio_duration, shot.get("duration_seconds"))
    )
    prompt = str(body.get("prompt") or "").strip() or build_lip_sync_prompt(
        character_name=character_name,
        dialogue_text=shot.get("dialogue_text"),
        action_text=shot.get("action_text"),
    )
    request_snapshot: dict[str, Any] = {
        "projectId": int(shot["project_id"]),
        "storyboardId": storyboard_id,
        "characterId": int(shot["character_id"]),
        "characterName": character_name,
        "imageAssetId": int(image["id"]) if image else None,
        "imageUrl": (
            (image or {}).get("image_url")
            or (source_video or {}).get("thumbnail_url")
            or (source_video or {}).get("video_url")
            or None
        ),
    }
    if source_video:
        request_snapshot["sourceVideoAssetId"] = int(source_video["id"])
        if source_video.get("video_url"):
            request_snapshot["sourceVideoUrl"] = source_video["video_url"]
        if source_video.get("thumbnail_url"):
            request_snapshot["sourceVideoThumbnailUrl"] = source_video["thumbnail_url"]
    request_snapshot.update(
        {
            "audioAssetId": int(audio["id"]),
            "audioUrl": audio.get("audio_url"),
            "audioDurationSeconds": _number_or_zero(audio_duration) or 0,
            "generationDurationSeconds": generation_duration_seconds,
            "versionNo": version_no,
            "prompt": prompt,
        }
    )
    crop_filter = str(body.get("cropFilter") or "").strip()
    if re.fullmatch(r"(\d{3,4}):(\d{3,4}):(\d{1,4}):(\d{1,4})", crop_filter, re.ASCII):
        request_snapshot["cropFilter"] = crop_filter
    request_snapshot["autoConfirm"] = body.get("autoConfirm") is not False
    provider_task_id = str(body.get("providerTaskId") or "").strip()
    if provider_task_id:
        request_snapshot["providerTaskId"] = provider_task_id
    return await asyncio.to_thread(
        db.create_generation_job, int(shot["project_id"]), "lip_sync", storyboard_id, request_snapshot
    )


# ---------------------------------------------------------------------------
# 项目/资产组剩余（阶段 3.5）：资产画布 / 角色库 / 项目删除 / 导出包 的路由级 helper。
# 逐条对照 Node index.mjs（行号基准 2026-10-17，见 api-service/docs/project-asset-group-spec.md）。
# ---------------------------------------------------------------------------


def _object_storage_url(storage_key: Any, settings: Settings) -> str | None:
    """storage_key → 签名 URL（失败返回 None，调用方回退历史地址）。"""
    try:
        return create_object_url_resolver(settings)(storage_key)
    except Exception:
        return None


def _read_object_bytes(settings: Settings, storage_key: str) -> bytes:
    """读取本地对象存储字节（vision-check 用；COS 模式不支持在网关内读）。

    :param settings: 服务配置。
    :param storage_key: 对象键。
    :returns: 对象字节。
    :raises FileNotFoundError: 键非法或文件缺失。
    """
    provider = str(settings.object_storage_provider or "").strip().lower()
    if provider != "local":
        raise FileNotFoundError(f"object storage provider {provider} is not readable in gateway")
    root = Path(str(settings.object_storage_root)).resolve()
    resolved = (root / str(storage_key).lstrip("/\\")).resolve()
    if not str(resolved).startswith(str(root)) or not resolved.is_file():
        raise FileNotFoundError(f"object not found: {storage_key}")
    return resolved.read_bytes()


def _write_object_bytes(settings: Settings, storage_key: str, data: bytes, content_type: str) -> dict[str, Any]:
    """写入本地对象存储并返回 ``{"key", "url"}``（参考音频上传用）。

    :param settings: 服务配置。
    :param storage_key: 对象键。
    :param data: 字节内容。
    :param content_type: MIME 类型（落 meta 便于媒体服务回放）。
    :returns: ``{"key": 键, "url": 签名 URL}``。
    :raises RuntimeError: 非 local 供应商（COS 写入由 Worker 承担，网关不支持）。
    """
    provider = str(settings.object_storage_provider or "").strip().lower()
    key = str(storage_key or "").strip().lstrip("/\\")
    if not key or any(part in {"", ".", ".."} for part in key.replace("\\", "/").split("/")):
        raise RuntimeError("invalid object storage key")
    if provider == "local":
        root = Path(str(settings.object_storage_root)).resolve()
        resolved = (root / key).resolve()
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise RuntimeError("invalid object storage key") from exc
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_bytes(data)
        meta_path = resolved.with_name(resolved.name + ".meta.json")
        meta_path.write_text(json.dumps({"contentType": content_type}, ensure_ascii=False), encoding="utf-8")
    elif provider == "cos":
        if not all((settings.cos_secret_id, settings.cos_secret_key, settings.cos_bucket, settings.cos_region)):
            raise RuntimeError("COS credentials and bucket configuration are required")
        from .media_service import cos_client_factory

        client = cos_client_factory(settings)
        client.put_object(Bucket=settings.cos_bucket, Key=key, Body=data, ContentType=content_type)
    else:
        raise RuntimeError(f"unsupported object storage provider: {provider}")
    signed = _object_storage_url(key, settings)
    base = str(settings.object_storage_public_base_url or "").strip().rstrip("/")
    return {"key": key, "url": signed or (f"{base}/{key}" if base else key)}


def _resolve_object_storage_url(storage_key: Any, fallback: Any, settings: Settings) -> Any:
    """Node resolveObjectStorageUrl（index.mjs L9688）：有键签名，失败回退。"""
    if not storage_key:
        return fallback
    signed = _object_storage_url(storage_key, settings)
    return signed if signed else fallback


def _script_agent_activity_row(row: dict[str, Any]) -> dict[str, Any]:
    """Script Agent 活动行映射（对齐 Node scriptAgentActivityRow，index.mjs L6948）。

    :param row: script_agent_activities 原始行。
    :returns: 前端 DTO（camelCase；context/result/reaction 为解析后对象）。
    """
    return {
        "id": int(row.get("id") or 0),
        "projectId": int(row.get("project_id") or 0),
        "userId": int(row.get("user_id") or 0),
        "stageKey": row.get("stage_key") or "script",
        "actionKey": row.get("action_key") or "",
        "agentKey": row.get("agent_key") or "script-agent",
        "source": row.get("source") or "button",
        "status": row.get("status") or "running",
        "title": row.get("title") or "",
        "summary": row.get("summary") or "",
        "context": _safe_json_object(row.get("context_json")),
        "result": _safe_json_object(row.get("result_json")),
        "reaction": _safe_json_object(row.get("reaction_json")),
        "errorText": row.get("error_text") or "",
        "idempotencyKey": row.get("idempotency_key") or None,
        "startedAt": row.get("started_at") or None,
        "finishedAt": row.get("finished_at") or None,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _safe_json_object(value: Any) -> dict[str, Any]:
    """JSON 列安全解析（对齐 Node parseJsonObject：非对象一律回退空对象）。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, (bytes, bytearray, str)):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _safe_json_array(value: Any) -> list[Any]:
    """JSON 数组列安全解析（对齐 Node jsonArray：非数组回退空数组）。"""
    if isinstance(value, list):
        return value
    if isinstance(value, (bytes, bytearray, str)):
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _agent_pipeline_run_row(row: dict[str, Any]) -> dict[str, Any]:
    """Agent Pipeline run DTO（对齐 Node agentPipelineRunRow）。"""
    return {
        "id": int(row.get("id") or 0),
        "projectId": int(row.get("project_id") or 0),
        "userId": int(row.get("user_id") or 0),
        "episodeNo": int(row.get("episode_no") or 1),
        "status": row.get("status") or "queued",
        "currentStage": row.get("current_stage") or "asset-parse",
        "inputSnapshot": _safe_json_object(row.get("input_snapshot_json")),
        "outputSnapshot": (
            _safe_json_object(row.get("output_snapshot_json"))
            if row.get("output_snapshot_json")
            else None
        ),
        "errorText": row.get("error_text") or "",
        "idempotencyKey": row.get("idempotency_key"),
        "createdAt": row.get("created_at") or None,
        "updatedAt": row.get("updated_at") or None,
    }


def _agent_pipeline_execution_row(row: dict[str, Any]) -> dict[str, Any]:
    """Agent Pipeline execution DTO（对齐 Node agentPipelineExecutionRow）。"""
    return {
        "id": int(row.get("id") or 0),
        "pipelineRunId": int(row.get("pipeline_run_id") or 0),
        "stageKey": row.get("stage_key"),
        "agentKey": row.get("agent_key"),
        "status": row.get("status"),
        "attempt": int(row.get("attempt") or 1),
        "idempotencyKey": row.get("idempotency_key"),
        "inputSnapshot": _safe_json_object(row.get("input_snapshot_json")),
        "outputSnapshot": _safe_json_object(row.get("output_snapshot_json")),
        "blockers": _safe_json_array(row.get("blockers_json")),
        "errorText": row.get("error_text") or "",
        "startedAt": row.get("started_at") or None,
        "finishedAt": row.get("finished_at") or None,
        "createdAt": row.get("created_at") or None,
        "updatedAt": row.get("updated_at") or None,
    }


def _agent_pipeline_event_row(row: dict[str, Any]) -> dict[str, Any]:
    """Agent Pipeline event DTO（对齐 Node agentPipelineEventRow）。"""
    return {
        "id": int(row.get("id") or 0),
        "pipelineRunId": int(row.get("pipeline_run_id") or 0),
        "executionId": int(row["execution_id"]) if row.get("execution_id") is not None else None,
        "stageKey": row.get("stage_key"),
        "agentKey": row.get("agent_key"),
        "attempt": int(row.get("attempt") or 1),
        "status": row.get("status"),
        "payload": _safe_json_object(row.get("payload_json")),
        "createdAt": row.get("created_at") or None,
    }


def _agent_pipeline_view(view: dict[str, Any]) -> dict[str, Any]:
    """把数据库分组结果转换为 Node loadAgentPipelineView 响应形状。"""
    return {
        "run": _agent_pipeline_run_row(view["run"]),
        "executions": [_agent_pipeline_execution_row(row) for row in view["executions"]],
        "events": [_agent_pipeline_event_row(row) for row in view["events"]],
    }


def _production_run_row(row: dict[str, Any]) -> dict[str, Any]:
    """ProductionRun 列表 DTO（对齐 Node productionRunRow）。"""
    episode_no = int(row.get("episode_no") or 1)
    budget_value = row.get("budget")
    try:
        budget = float(budget_value) if budget_value is not None else None
    except (TypeError, ValueError):
        budget = None
    return {
        "id": int(row.get("id") or 0),
        "projectId": int(row.get("project_id") or 0),
        "projectName": row.get("project_name") or None,
        "episodeNo": episode_no,
        "platform": row.get("platform") or "抖音",
        "name": row.get("name") or f"第 {episode_no} 集黄金样片",
        "status": row.get("status") or "created",
        "currentStage": row.get("current_stage") or "planning",
        "currentCheckpoint": row.get("current_checkpoint") or None,
        "pilotMode": row.get("pilot_mode") or "two-scenes-golden-sample",
        "pilotSceneCount": int(row.get("pilot_scene_count") or 2),
        "budget": budget,
        "candidatePolicy": _safe_json_object(row.get("candidate_policy_json")),
        "successMetrics": _safe_json_array(row.get("success_metrics_json")),
        "inputSnapshot": _safe_json_object(row.get("input_snapshot_json")),
        "outputSnapshot": (
            _safe_json_object(row.get("output_snapshot_json"))
            if row.get("output_snapshot_json")
            else None
        ),
        "failureCode": row.get("failure_code") or None,
        "failureText": row.get("failure_text") or None,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def _production_run_view(view: dict[str, Any]) -> dict[str, Any]:
    """ProductionRun 详情 DTO（对齐 Node loadProductionRunView）。"""
    run = _production_run_row(view["run"])
    stages = [
        {
            "id": int(row.get("id") or 0),
            "stageKey": row.get("stage_key"),
            "sequenceNo": int(row.get("sequence_no") or 0),
            "agentKey": row.get("agent_key"),
            "status": row.get("status"),
            "inputSnapshot": _safe_json_object(row.get("input_snapshot_json")) if row.get("input_snapshot_json") else None,
            "outputSnapshot": _safe_json_object(row.get("output_snapshot_json")) if row.get("output_snapshot_json") else None,
            "errorText": row.get("error_text") or None,
            "startedAt": row.get("started_at") or None,
            "finishedAt": row.get("finished_at") or None,
        }
        for row in view["stages"]
    ]
    checkpoints = [
        {
            "id": int(row.get("id") or 0),
            "checkpointKey": row.get("checkpoint_key"),
            "stageKey": row.get("stage_key"),
            "status": row.get("status"),
            "decisionNote": row.get("decision_note") or None,
            "reviewedAt": row.get("reviewed_at") or None,
        }
        for row in view["checkpoints"]
    ]
    executions = [
        {
            "id": int(row.get("id") or 0),
            "agentKey": row.get("agent_key"),
            "status": row.get("status"),
            "modelName": row.get("model_name") or None,
            "output": _safe_json_object(row.get("output_json")) if row.get("output_json") else None,
        }
        for row in view["agentExecutions"]
    ]
    blueprint_view = view.get("blueprint")
    blueprint = None
    if blueprint_view:
        row = blueprint_view["row"]
        emotion_beats = [
            {
                "id": beat.get("beat_key"),
                "beatKey": beat.get("beat_key"),
                "phase": beat.get("phase"),
                "label": beat.get("label"),
                "sequenceNo": int(beat.get("sequence_no") or 0),
                "durationSeconds": float(beat.get("duration_seconds") or 0),
                "emotionStart": beat.get("emotion_start") or "",
                "emotionProcess": beat.get("emotion_process") or "",
                "emotionEnd": beat.get("emotion_end") or "",
                "actionStart": beat.get("action_start") or "",
                "actionProcess": beat.get("action_process") or "",
                "actionEnd": beat.get("action_end") or "",
                "dialoguePlan": beat.get("dialogue_plan") or "",
                "soundPlan": beat.get("sound_plan") or "",
                "continuity": beat.get("continuity") or "",
                "sceneNo": int(beat["scene_no"]) if beat.get("scene_no") is not None else None,
                "shotCount": int(beat.get("shot_count") or 0),
                "status": beat.get("status") or "draft",
            }
            for beat in blueprint_view["emotionBeats"]
        ]
        blueprint = {
            "id": int(row.get("id") or 0),
            "productionRunId": int(row.get("production_run_id") or 0),
            "projectId": int(row.get("project_id") or 0),
            "episodeNo": int(row.get("episode_no") or 1),
            "versionNo": int(row.get("version_no") or 1),
            "status": row.get("status") or "draft",
            "blueprint": _safe_json_object(row.get("blueprint_json")),
            "qualityReport": _safe_json_object(row.get("quality_report_json")) if row.get("quality_report_json") else None,
            "emotionBeats": emotion_beats,
            "approvedAt": row.get("approved_at") or None,
        }
    return {"run": run, "stages": stages, "checkpoints": checkpoints,
            "agentExecutions": executions, "blueprint": blueprint}


def _export_record_row(row: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """导出记录行映射（对齐 Node exportRecordRow，index.mjs L8865）。

    :param row: export_records 原始行（详情联查可含 ownerId，仅列表/详情映射用不到）。
    :param settings: 应用配置（存储签名 URL 解析用）。
    :returns: 前端 DTO（config_json 解析；storage_key 命中时 video/subtitle 走签名 URL）。
    """
    raw_config = row.get("config_json")
    if isinstance(raw_config, (bytes, bytearray, str)) and raw_config:
        try:
            config = json.loads(raw_config)
        except (ValueError, TypeError):
            config = None
    elif isinstance(raw_config, dict):
        config = raw_config
    else:
        config = None

    storage_key = row.get("storage_key") or row.get("storageKey") or None
    subtitle_storage_key = row.get("subtitle_storage_key") or row.get("subtitleStorageKey") or None
    if isinstance(config, dict) and subtitle_storage_key:
        config["subtitleFile"] = _resolve_object_storage_url(
            subtitle_storage_key, config.get("subtitleFile") or None, settings
        )

    return {
        "id": row.get("id"),
        "projectId": row.get("project_id") or row.get("projectId"),
        "status": row.get("status"),
        "videoUrl": _resolve_object_storage_url(storage_key, row.get("video_url") or row.get("videoUrl"), settings)
        if storage_key
        else (row.get("video_url") or row.get("videoUrl")),
        "storageKey": storage_key,
        "subtitleStorageKey": subtitle_storage_key,
        "coverUrl": row.get("cover_url") or row.get("coverUrl"),
        "durationSeconds": row.get("duration_seconds") or row.get("durationSeconds"),
        "config": config,
        "sourceCount": row.get("source_count") or row.get("sourceCount") or 0,
        "readyCount": row.get("ready_count") or row.get("readyCount") or 0,
        "missingCount": row.get("missing_count") or row.get("missingCount") or 0,
        "createdAt": row.get("created_at") or row.get("createdAt"),
        "updatedAt": row.get("updated_at") or row.get("updatedAt"),
    }


def _has_durable_asset_node_image(row: dict[str, Any], settings: Settings) -> bool:
    """Node hasDurableAssetNodeImage（L9787）：本地存储键需对象真实存在。"""
    storage_key = str(row.get("storage_key") or "").strip()
    if not storage_key:
        return bool(row.get("image_url") or row.get("thumbnail_url"))
    if str(settings.object_storage_provider or "").strip().lower() != "local":
        return True
    try:
        root = Path(str(settings.object_storage_root)).resolve()
        resolved = (root / storage_key).resolve()
        return resolved.is_file() and str(resolved).startswith(str(root))
    except Exception:
        return False


def _asset_node_image_dto(row: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """Node assetNodeImageDto（L9797）：URL 解析 + 持久性过滤 + 形象行 DTO。"""
    resolved = dict(row)
    resolved["image_url"] = _resolve_object_storage_url(row.get("storage_key"), row.get("image_url"), settings)
    resolved["thumbnail_url"] = _resolve_object_storage_url(
        row.get("storage_key"),
        row.get("thumbnail_url") or row.get("image_url"),
        settings,
    )
    resolved.setdefault("vision_status", "pending")
    resolved.setdefault("vision_reason", None)
    resolved.setdefault("vision_checked_at", None)
    durable = _has_durable_asset_node_image(row, settings)
    # 不把已知不存在的本地对象继续暴露给前端，前端会显示「待重新生成」。
    resolved["image_url"] = resolved["image_url"] if durable else None
    resolved["thumbnail_url"] = resolved["thumbnail_url"] if durable else None
    return asset_node_image_row(resolved)


def _project_deletion_confirmation_name(project: dict[str, Any]) -> str:
    """Node projectDeletionConfirmationName（L6871）：空名兜底「未命名项目 PF-{id}」。"""
    name = str(project.get("name") or "").strip()
    return name or f"未命名项目 PF-{int(project.get('id') or 0):03d}"


def _fetch_asset_node_for_user(
    db: Any, node_id: int, user_id: int, settings: Settings
) -> dict[str, Any] | None:
    """Node fetchAssetNodeForUser（L9810）：归属校验 + 场景节点两段读时自愈。

    自愈一：scene 无 ref_id → findSceneNodeMatch 绑定并回写提示词；
    自愈二：scene 有 ref_id 但提示词为空/旧占位 → 按场景重建提示词。

    :param db: 数据库适配器。
    :param node_id: 节点 id。
    :param user_id: 当前用户 id。
    :param settings: 服务配置。
    :returns: ``{"node", "character"}``；不存在或越权 None。
    """
    node = db.get_asset_node_full(node_id)
    if node is None or int(node.get("ownerId") or 0) != int(user_id):
        return None

    character = None
    if str(node.get("node_type") or "") == "scene" and not node.get("ref_id"):
        scene_rows = db.list_project_scene_rows(int(node["project_id"]))
        matched_scene = find_scene_node_match(node, scene_rows)
        if matched_scene:
            prompt_text = build_script_scene_prompt(
                matched_scene,
                node.get("project_visual_style") or "",
                node.get("project_category") or "",
            )
            appearance_label = " · ".join(
                [value for value in (matched_scene.get("location"), matched_scene.get("time_of_day")) if value]
            ) or None
            node = db.update_asset_node_fields(
                node_id,
                {
                    "ref_id": int(matched_scene["id"]),
                    "prompt_text": prompt_text,
                    "appearance_label": node.get("appearance_label") or appearance_label,
                },
            ) or node
            node["ref_id"] = int(matched_scene["id"])
            node["prompt_text"] = prompt_text

    if (
        str(node.get("node_type") or "") == "scene"
        and node.get("ref_id")
        and (
            not str(node.get("prompt_text") or "").strip()
            or str(node.get("prompt_text") or "").strip()
            == "场景空间结构待补充：请描述地点、时代、建筑结构、主要物件位置、门窗方向、光线方向和剧情功能。"
        )
    ):
        scene_rows = db.list_project_scene_rows(int(node["project_id"]))
        matched_scene = next((row for row in scene_rows if int(row["id"]) == int(node["ref_id"])), None)
        if matched_scene:
            project = db.fetch_project_by_id(int(node["project_id"])) or {}
            prompt_text = build_script_scene_prompt(
                matched_scene,
                project.get("visual_style") or "",
                project.get("category") or "",
            )
            node = db.update_asset_node_fields(node_id, {"prompt_text": prompt_text}) or node
            node["prompt_text"] = prompt_text

    if str(node.get("node_type") or "") == "character" and node.get("ref_id"):
        character = next(
            (
                row
                for row in db.list_project_character_rows(int(node["project_id"]))
                if int(row["id"]) == int(node["ref_id"])
            ),
            None,
        )
    return {"node": node, "character": character}


def _node_canvas_node_response(db: Any, node: dict[str, Any], settings: Settings) -> dict[str, Any]:
    """节点单数响应（Node 路由回读 nodes+images 后取 buildAssetCanvasView().nodes[0]）。"""
    node_id = int(node["id"])
    rows = db.get_asset_node_raw(node_id) or node
    images = [_asset_node_image_dto(row, settings) for row in db.list_asset_node_images(node_id)]
    view = build_asset_canvas_view(int(node.get("project_id")), nodes=[rows], images=images)
    return view["nodes"][0]


def _build_export_package(
    db: Any, project_id: int, settings: Settings, episode_no: int | None = None
) -> dict[str, Any]:
    """Node buildExportPackage（L10690）：导出就绪度聚合。

    :param db: 数据库适配器。
    :param project_id: 项目 id。
    :param settings: 服务配置（媒体 URL 规范化基址）。
    :returns: 导出包 DTO（items 已按草稿 order 排序）。
    """
    rows = db.export_package_rows(project_id, episode_no=episode_no)

    def normalize_media_url(value: Any) -> Any:
        """媒体地址规范化（/generated/* 换当前公网基址）。"""
        return normalize_generated_media_url(value, settings.public_base_url)

    draft_row = None if episode_no else db.fetch_final_edit_draft(project_id)
    draft_video_map: dict[int, dict[str, Any]] = {}
    if draft_row and draft_row.get("draft_json"):
        try:
            draft_json = json.loads(draft_row["draft_json"]) if isinstance(draft_row["draft_json"], str) else draft_row["draft_json"]
        except (TypeError, ValueError):
            draft_json = {}
        for index, item in enumerate(draft_json.get("videoClips") or []):
            if not isinstance(item, dict) or not item.get("storyboardId"):
                continue
            draft_video_map[int(item["storyboardId"])] = {
                "enabled": item.get("enabled") is not False,
                "order": _parse_id_value(item.get("order")) or index + 1,
            }

    incomplete_scenes = [
        {
            "sceneId": row["scene_id"],
            "sceneNo": row["scene_no"],
            "sceneTitle": row["scene_title"],
        }
        for row in rows
        if not row.get("storyboard_id")
    ]
    total_shots = sum(1 for row in rows if row.get("storyboard_id"))
    confirmed_shots = sum(
        1 for row in rows
        if row.get("storyboard_id") and row.get("confirmed_video_asset_id")
        and row.get("confirmed_video_url")
    )
    items: list[dict[str, Any]] = []
    ready_shots = 0
    total_duration_seconds = 0
    cover_url: str | None = None

    for row in rows:
        if not row.get("storyboard_id"):
            continue
        storyboard_id = int(row["storyboard_id"])
        draft_item = draft_video_map.get(storyboard_id)
        if draft_item and draft_item.get("enabled") is False:
            continue
        confirmed_duration = _number_or_zero(row.get("confirmed_video_duration_seconds"))
        storyboard_duration = _number_or_zero(row.get("storyboard_duration_seconds"))
        duration_seconds = (
            confirmed_duration
            if confirmed_duration > 0
            else (storyboard_duration if storyboard_duration > 0 else 4)
        )
        export_status = (
            "ready"
            if row.get("confirmed_video_asset_id") and row.get("confirmed_video_url")
            else ("static-ready" if row.get("image_url") else "missing-video")
        )
        if export_status in ("ready", "static-ready"):
            ready_shots += 1
            total_duration_seconds += duration_seconds
            if not cover_url and row.get("image_url"):
                cover_url = row["image_url"]
        items.append(
            {
                "sceneId": row["scene_id"],
                "episodeNo": row.get("episode_no"),
                "sceneNo": row["scene_no"],
                "sceneTitle": row["scene_title"],
                "storyboardId": storyboard_id,
                "shotNo": row["shot_no"],
                "shotType": row["shot_type"],
                "dialogueText": row.get("dialogue_text") or None,
                "durationSeconds": duration_seconds,
                "imageUrl": normalize_media_url(row.get("image_url")) if row.get("image_url") else None,
                "videoUrl": normalize_media_url(row.get("confirmed_video_url") or row.get("video_url"))
                if (row.get("confirmed_video_url") or row.get("video_url"))
                else None,
                "exportStatus": export_status,
                "order": draft_item["order"] if draft_item else total_shots,
            }
        )

    items.sort(
        key=lambda item: (
            _number_or_zero(item.get("order")),
            _number_or_zero(item.get("sceneNo")),
            _number_or_zero(item.get("storyboardId")),
        )
    )
    if not cover_url:
        cover_url = next((item["imageUrl"] for item in items if item.get("imageUrl")), None)

    missing_storyboard_scene_count = len(incomplete_scenes)
    missing_video_count = max(total_shots - confirmed_shots, 0)
    blocking_issues = []
    if missing_storyboard_scene_count > 0:
        blocking_issues.append(
            {
                "code": "missing-storyboards",
                "message": f"还有 {missing_storyboard_scene_count} 个场景尚未生成分镜，请先完成场景拆镜。",
            }
        )
    if ready_shots == 0:
        blocking_issues.append(
            {
                "code": "all-video-disabled",
                "message": "当前所有视频片段都被禁用了，导出前至少保留一个启用片段。",
            }
        )
    return {
        "projectId": project_id,
        "coverUrl": cover_url,
        "totalShots": total_shots,
        "readyShots": ready_shots,
        "confirmedShots": confirmed_shots,
        "missingShots": missing_video_count,
        "missingStoryboardScenes": missing_storyboard_scene_count,
        "incompleteScenes": incomplete_scenes,
        "canExport": not blocking_issues,
        "blockingIssues": blocking_issues,
        "totalDurationSeconds": total_duration_seconds,
        "items": items,
    }


async def _ensure_scene_spatial_anchors_for_node(
    db: Any,
    user_id: int,
    node_id: int,
    client: Any,
    settings: Settings,
) -> None:
    """场景节点入队前补齐空间锚点（Node ensureSceneSpatialAnchors 的 FastAPI 路径）。"""
    resolved = await asyncio.to_thread(_fetch_asset_node_for_user, db, node_id, user_id, settings)
    if resolved is None:
        return
    node = resolved["node"]
    if str(node.get("node_type") or "") != "scene" or not node.get("ref_id"):
        return
    project_id = int(node["project_id"])
    scene_rows = await asyncio.to_thread(db.list_project_scene_rows, project_id, with_anchors=True)
    scene = next((row for row in scene_rows if int(row["id"]) == int(node["ref_id"])), None)
    if scene is None:
        return
    repair_reason = ""
    existing = scene.get("spatial_anchors_json")
    if existing:
        try:
            normalize_scene_space_manifest(existing)
            return
        except ValueError as exc:
            repair_reason = str(exc)
    manifest = await ai_generate_scene_space_anchors(
        scene, client=client, repair_reason=repair_reason
    )
    persisted = await asyncio.to_thread(
        db.update_scene_spatial_anchors,
        int(scene["id"]),
        project_id,
        int(user_id),
        json.dumps(manifest, ensure_ascii=False),
    )
    if not persisted:
        raise ValueError("场景空间锚点写入失败：场景不存在或无权访问")


def _enqueue_asset_node_image_job(
    db: Any, user_id: int, node_id: int, body: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    """Node enqueueAssetNodeImageJob（L9914）：画布形象任务入队编排。

    场景节点刷新环境提示词（空间锚点缺失时受控报错）；角色资产板/九宫格/
    道具多视角走各自的门禁与提示词构建器；最终 createGenerationJob
    （同 project+type+source 活动任务幂等复用）。

    :param db: 数据库适配器。
    :param user_id: 当前用户 id。
    :param node_id: 画布节点 id。
    :param body: 请求体（viewType/viewKey/prompt/candidateCount/modelName/referenceImageId 等）。
    :param settings: 服务配置。
    :returns: generation_jobs 行。
    :raises NodeEnqueueError: 门禁未通过（message/statusCode 对齐 Node 抛错）。
    :raises LookupError: 节点不存在或越权（路由转 404/4004）。
    """
    resolved = _fetch_asset_node_for_user(db, node_id, user_id, settings)
    if resolved is None:
        raise LookupError("画布节点不存在或无权访问")
    node = resolved["node"]
    character = resolved["character"]
    effective_prompt_text = str(node.get("prompt_text") or "").strip()
    scene_spatial_anchors: Any = None
    project_character_names: list[str] = []
    requested_view_type = str(body.get("viewType") or "").strip()

    if str(node.get("node_type") or "") == "scene" and node.get("ref_id") and not effective_prompt_text:
        project = db.fetch_project_by_id(int(node["project_id"])) or {}
        project_character_names = db.list_project_character_names(int(node["project_id"]))
        scene_rows = db.list_project_scene_rows(int(node["project_id"]), with_anchors=True)
        scene = next((row for row in scene_rows if int(row["id"]) == int(node["ref_id"])), None)
        if scene is not None:
            effective_prompt_text = build_script_scene_prompt(
                scene,
                project.get("visual_style") or "",
                project.get("category") or "",
                project_character_names,
            )
            node = db.update_asset_node_fields(node_id, {"prompt_text": effective_prompt_text}) or node

    if str(node.get("node_type") or "") == "scene" and node.get("ref_id"):
        project = db.fetch_project_by_id(int(node["project_id"])) or {}
        scene_rows = db.list_project_scene_rows(int(node["project_id"]), with_anchors=True)
        scene = next((row for row in scene_rows if int(row["id"]) == int(node["ref_id"])), None)
        if not project_character_names:
            project_character_names = db.list_project_character_names(int(node["project_id"]))
        if scene is not None:
            if scene.get("spatial_anchors_json"):
                try:
                    scene_spatial_anchors = json.loads(scene["spatial_anchors_json"])
                except (TypeError, ValueError):
                    scene_spatial_anchors = None
            if scene_spatial_anchors is None:
                # Node 会在请求线程内调空间锚点 Agent（ensureSceneSpatialAnchors）；
                # FastAPI 网关不承担 Agent 执行，缺失时按 Node 无提取器的同款文案受控报错。
                raise NodeEnqueueError("缺少场景空间锚点时，必须先完成 Agent 提取并持久化", status_code=500)
            scene["spatial_anchors"] = scene_spatial_anchors
            environment_prompt_text = build_scene_environment_prompt(
                scene,
                project.get("visual_style") or "",
                project.get("category") or "",
                project_character_names,
            )
            # 每次全景生成都从当前绑定场景刷新环境层，避免沿用旧版混入人物动作的提示词。
            node = db.update_asset_node_fields(node_id, {"environment_prompt_text": environment_prompt_text}) or node

    if str(node.get("node_type") or "") == "character" and requested_view_type not in ("", "single", "character-asset-pack"):
        raise NodeEnqueueError("角色资产统一生成完整资产板；独立脸部特写和三视图链路已停用", status_code=409)
    if str(node.get("node_type") or "") in ("prop", "material") and requested_view_type == "prop-turnaround":
        raise NodeEnqueueError("道具资产统一使用完整单图；独立多视角链路已停用", status_code=409)

    asset_pack_enabled = str(node.get("node_type") or "") == "character" and requested_view_type in (
        "character-asset-pack", "single", ""
    )
    frame_provider = str(os.environ.get("FRAME_PROVIDER") or "trae-url").strip().lower()
    default_model = _frame_reference_default_model(frame_provider)
    requested_pack_model = (
        str(body.get("modelName") or os.environ.get("FRAME_ASSET_PACK_MODEL") or default_model).strip()
        if asset_pack_enabled
        else ""
    )

    version_no = db.next_asset_node_image_version(node_id)
    prompt_node = {
        **node,
        "promptText": resolve_asset_node_generation_prompt(
            {**node, "promptText": effective_prompt_text},
            requested_view_type or "single",
            body.get("prompt"),
        ),
    }
    requested_view_key = str(body.get("viewKey") or "").strip()
    scene_angle = next((angle for angle in get_scene_nine_grid_angles() if angle["key"] == requested_view_key), None)
    if requested_view_type == "scene-nine-grid" and requested_view_key and not scene_angle:
        raise NodeEnqueueError(f"无效的场景九宫格视角：{requested_view_key}", status_code=400)

    reference_image_url = str(body.get("referenceImageUrl") or "").strip()
    base_reference_image_url = ""
    base_reference_storage_key = ""
    base_reference_image_id: int | None = None
    panorama_image_id: int | None = None
    panorama_image_url = ""
    panorama_storage_key = ""
    identity_lock_snapshot = parse_character_identity_lock(node.get("character_identity_lock_json"))
    identity_reference_image_ids: list[int] = []
    identity_reference_image_urls: list[str] = []
    identity_reference_storage_keys: list[str] = []

    existing_image_dtos: list[dict[str, Any]] = []
    if requested_view_type in ("character-turnaround", "character-face-closeup", "prop-turnaround", "scene-nine-grid"):
        existing_image_dtos = [
            _asset_node_image_dto(row, settings) for row in db.list_asset_node_images(node_id)
        ]

    if requested_view_type in ("character-turnaround", "character-face-closeup") and str(node.get("node_type") or "") == "character":
        gate = validate_character_view_generation(node.get("node_type"), requested_view_type, existing_image_dtos)
        if not gate["ready"]:
            raise NodeEnqueueError(gate["message"], status_code=409)
        base_image = gate["baseImage"] or {}
        base_reference_image_id = int(base_image.get("id") or 0) or None
        base_reference_image_url = str(base_image.get("imageUrl") or base_image.get("thumbnailUrl") or "").strip()
        base_reference_storage_key = str(base_image.get("storageKey") or "").strip()
        reference_set = resolve_character_reference_set(existing_image_dtos)
        identity_reference_image_ids = reference_set["imageIds"]
        identity_reference_image_urls = reference_set["imageUrls"]
        identity_reference_storage_keys = reference_set["storageKeys"]
        if identity_lock_snapshot is None:
            identity_lock_snapshot = build_character_identity_lock_snapshot(
                character or {"id": node.get("ref_id"), "name": node.get("label")},
                base_image,
                reference_set,
            )

    scene_reference_storage_key = ""
    if requested_view_type == "scene-nine-grid" and str(node.get("node_type") or "") == "scene":
        explicit_panorama_id = _parse_id_value(body.get("referenceImageId"))
        panorama_rows = db.list_asset_node_images(node_id)
        if explicit_panorama_id:
            panorama = next(
                (
                    row
                    for row in panorama_rows
                    if int(row["id"]) == explicit_panorama_id
                    and str(row.get("view_set_type") or "") == "single"
                    and str(row.get("status") or "") in ("candidate", "confirmed")
                    and (str(row.get("vision_status") or "") in ("passed", "skipped") or not row.get("vision_status"))
                ),
                None,
            )
            if panorama is None:
                raise NodeEnqueueError(
                    "指定的场景全景母图不存在、未通过视觉检查或不属于当前节点", status_code=409
                )
            panorama_rows = [panorama]
        else:
            panorama_rows = [
                row
                for row in panorama_rows
                if str(row.get("view_set_type") or "") == "single"
                and str(row.get("status") or "") == "confirmed"
                and (str(row.get("vision_status") or "") in ("passed", "skipped") or not row.get("vision_status"))
            ]
            panorama_rows = sorted(panorama_rows, key=lambda row: int(row["id"]), reverse=True)[:1]
        if explicit_panorama_id and not panorama_rows:
            raise NodeEnqueueError(
                "指定的场景全景母图不存在、未通过视觉检查或不属于当前节点", status_code=409
            )
        if panorama_rows:
            panorama_image_id = int(panorama_rows[0]["id"])
            scene_reference_storage_key = str(panorama_rows[0].get("storage_key") or "").strip()
            panorama_storage_key = scene_reference_storage_key
            panorama_image_url = str(panorama_rows[0].get("image_url") or "").strip()
            reference_image_url = reference_image_url or panorama_image_url
        if not panorama_image_id:
            raise NodeEnqueueError("请先确认场景全景基准图，再生成九个独立场景视角", status_code=409)
        if not requested_view_key:
            complete_batches = db.count_scene_nine_grid_complete_batches(node_id, panorama_image_id)
            if int(complete_batches or 0) >= 9:
                raise NodeEnqueueError(
                    "九宫格九个独立视角已生成；请在对应视角卡片中单独重试，不要重复生成整组",
                    status_code=409,
                )

    requested_character_view_keys = []
    is_character_turnaround_batch = False
    if requested_view_type == "character-turnaround":
        raw_keys = body.get("viewKeys") if isinstance(body.get("viewKeys"), list) and body.get("viewKeys") else ["front", "side", "back"]
        keys = [str(key or "").strip() for key in raw_keys]
        is_character_turnaround_batch = not requested_view_key
        requested_character_view_keys = [
            key for index, key in enumerate(keys) if key in ("front", "side", "back") and keys.index(key) == index
        ]

    view_prompt: dict[str, Any] | None = None
    if (
        requested_view_type
        and requested_view_type not in ("single", "character-asset-pack")
        and not is_character_turnaround_batch
    ):
        view_prompt = build_asset_node_view_prompt(
            prompt_node,
            character,
            node.get("project_visual_style"),
            bool((character or {}).get("appearance_locked")),
            requested_view_type,
            requested_view_key,
            reference_image_url,
            base_reference_image_url,
        )
    scene_angle_prompt = (
        build_scene_nine_grid_angle_prompt(requested_view_key, panorama_image_url or panorama_storage_key, scene_spatial_anchors)
        if requested_view_type == "scene-nine-grid" and requested_view_key and scene_angle
        else None
    )
    if asset_pack_enabled:
        pack_base = build_character_asset_pack_prompt(
            character or {"name": node.get("label")},
            node.get("project_visual_style"),
        )
        generation_prompt = (
            f"{pack_base}\n角色节点原始约束（只补充外貌事实，不改变资产板布局）：\n{effective_prompt_text.strip()}"
        )
    else:
        generation_prompt = (
            scene_angle_prompt
            or (view_prompt or {}).get("prompt")
            or build_asset_node_generation_prompt(
                prompt_node,
                character,
                node.get("project_visual_style"),
                bool((character or {}).get("appearance_locked")),
            )
        )
    identity_prompt = (
        build_character_identity_lock_prompt(
            identity_lock_snapshot or {},
            (view_prompt or {}).get("viewLabel") or requested_view_key,
        )
        if requested_view_type in ("character-turnaround", "character-face-closeup")
        and str(node.get("node_type") or "") == "character"
        else ""
    )
    effective_generation_prompt = "\n".join([value for value in (generation_prompt, identity_prompt) if value])
    if not effective_generation_prompt:
        raise NodeEnqueueError(
            "请先填写提示词：角色节点可以只靠身份约束生成，场景和道具节点必须写提示词", status_code=400
        )
    prompt_snapshot = build_asset_node_prompt_snapshot(
        prompt_node,
        character,
        node.get("project_visual_style"),
        bool((character or {}).get("appearance_locked")),
    )
    no_face_character = bool(
        re.search(
            r"正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见",
            "\n".join(
                value
                for value in (
                    (character or {}).get("appearance"),
                    (character or {}).get("costume"),
                    node.get("prompt_text"),
                )
                if value
            ),
        )
    )
    if view_prompt or is_character_turnaround_batch:
        if requested_view_type in ("character-turnaround", "character-face-closeup"):
            negative_prompt_value: Any = build_character_view_negative_prompt(
                requested_view_key,
                {
                    "noFace": str(node.get("node_type") or "") == "character" and no_face_character,
                },
            )
        else:
            negative_prompt_value = "场景背景以外的人物主体，多人，拼贴，文字，水印"
    else:
        negative_prompt_value = str(node.get("negative_prompt") or "").strip()

    view_batch = None
    if is_character_turnaround_batch:
        view_batch = [
            build_asset_node_view_prompt(
                prompt_node,
                character,
                node.get("project_visual_style"),
                bool((character or {}).get("appearance_locked")),
                "character-turnaround",
                view_key,
                reference_image_url,
                base_reference_image_url,
            )
            for view_key in requested_character_view_keys
        ]
    reference_image_urls_value: Any = (
        identity_reference_image_urls
        if identity_reference_image_urls
        else (view_prompt or {}).get("referenceImageUrls")
        if view_prompt
        else None
    ) or ([base_reference_image_url] if base_reference_image_url else None)
    reference_image_storage_keys = [
        key
        for key in [
            *identity_reference_storage_keys,
            *([base_reference_storage_key] if base_reference_storage_key else []),
            *([scene_reference_storage_key] if scene_reference_storage_key else []),
        ]
        if key
    ]
    reference_image_storage_keys = list(dict.fromkeys(reference_image_storage_keys))
    request_snapshot = {
        "assetNodeId": node_id,
        "nodeType": node.get("node_type"),
        "label": node.get("label"),
        "versionNo": version_no,
        "candidateCount": (view_prompt or {}).get("candidateCount")
        if view_prompt
        else max(1, min(3, _parse_id_value(body.get("candidateCount")) or 1)),
        "imageRatio": "16:9"
        if asset_pack_enabled
        else ("1:1" if requested_view_type == "character-face-closeup" else ("9:16" if str(node.get("node_type") or "") == "character" else None)),
        "viewType": requested_view_type or "single",
        "viewIndex": (scene_angle or {}).get("index") if scene_angle else (view_prompt or {}).get("viewIndex"),
        "viewKey": (scene_angle or {}).get("key") if scene_angle else (view_prompt or {}).get("viewKey"),
        "viewLabel": (scene_angle or {}).get("label") if scene_angle else (view_prompt or {}).get("viewLabel"),
        "modelName": requested_pack_model or str(body.get("modelName") or default_model).strip(),
        "qualityAttempts": (
            _parse_id_value(body.get("qualityAttempts")) or 3
        ) if requested_view_type in ("character-turnaround", "character-face-closeup") else (
            scene_nine_grid_quality_attempts(body.get("qualityAttempts"), 5)
            if requested_view_type == "scene-nine-grid"
            else 1
        ),
        "prompt": effective_generation_prompt,
        "sceneSpatialAnchors": scene_spatial_anchors,
        "panoramaImageId": panorama_image_id,
        "panoramaImageUrl": panorama_image_url,
        "panoramaStorageKey": panorama_storage_key,
        # 三视图是纯白背景的角色资产单图，禁止继承节点上的剧情负面词。
        "negativePrompt": negative_prompt_value,
        "promptSnapshot": effective_generation_prompt,
        "baseReferenceImageUrl": base_reference_image_url,
        "baseReferenceStorageKey": base_reference_storage_key,
        "deterministicFaceCrop": requested_view_type == "character-face-closeup",
        "assetPackEnabled": asset_pack_enabled,
        "sourceImageId": base_reference_image_id if requested_view_type in ("character-turnaround", "character-face-closeup") else None,
        "viewBatch": view_batch,
        "identityLockSnapshot": identity_lock_snapshot,
        "identityReferenceImageIds": identity_reference_image_ids,
        "identityReferenceImageStorageKeys": identity_reference_storage_keys,
        "referenceImageUrls": reference_image_urls_value,
        "referenceImageStorageKeys": reference_image_storage_keys,
    }
    return db.create_generation_job(int(node["project_id"]), "asset_node_image", node_id, request_snapshot)


def _enqueue_character_image_job(
    db: Any, user_id: int, character_id: int, body: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    """Node enqueueCharacterImageJob（L4326）：角色定妆图任务入队。

    :param db: 数据库适配器。
    :param user_id: 当前用户 id。
    :param character_id: 角色 id。
    :param body: 请求体（prompt/candidateCount/modelName）。
    :param settings: 服务配置。
    :returns: generation_jobs 行。
    :raises NodeEnqueueError: 角色缺少外观设定（HTTP 400）。
    :raises LookupError: 角色不存在或越权（路由转 404/4004）。
    """
    character = db.get_character_for_user(character_id)
    if character is None or int(character.get("ownerId") or 0) != int(user_id):
        raise LookupError("角色不存在或无权访问")
    if not str(character.get("appearance") or "").strip():
        raise NodeEnqueueError("角色缺少外观设定，请先填写或使用 AI 补全角色档案", status_code=400)
    frame_provider = str(os.environ.get("FRAME_PROVIDER") or "trae-url").strip().lower()
    default_model = _frame_reference_default_model(frame_provider)
    prompt_snapshot = "，".join(
        value
        for value in [
            str(body.get("prompt") or "").strip(),
            character.get("name"),
            character.get("role_tag"),
            character.get("personality"),
            character.get("appearance"),
            character.get("project_visual_style"),
        ]
        if value
    )
    request_snapshot = {
        "characterId": character_id,
        "versionNo": db.next_character_image_version(character_id),
        "candidateCount": max(1, min(3, _parse_id_value(body.get("candidateCount")) or 1)),
        "modelName": str(body.get("modelName") or default_model).strip(),
        "prompt": str(body.get("prompt") or "").strip() if body.get("prompt") else "",
        "promptSnapshot": prompt_snapshot,
        "character": {
            "name": character.get("name"),
            "roleTag": character.get("role_tag"),
            "personality": character.get("personality"),
            "appearance": character.get("appearance"),
        },
        "projectVisualStyle": character.get("project_visual_style"),
        "referenceImageUrls": (
            [character["reference_image_url"]]
            if re.match(r"^https?://", str(character.get("reference_image_url") or ""), re.I)
            and "/mock-assets/" not in str(character.get("reference_image_url") or "")
            else []
        ),
    }
    return db.create_generation_job(int(character["project_id"]), "character_image", character_id, request_snapshot)


class NodeEnqueueError(Exception):
    """画布/角色入队受控业务抛错（对齐 Node error.statusCode 形态）。

    :ivar message: 受控业务文案（原样透传前端）。
    :ivar status_code: HTTP 状态码（Node error.statusCode，缺省 400）。
    """

    def __init__(self, message: str, status_code: int = 400):
        """初始化受控异常。

        :param message: 受控业务文案。
        :param status_code: HTTP 状态码。
        """
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def create_app(settings: Settings | None = None, database: Any = None, agent_runtime: Any = None, captcha_service: Any = None, sms_provider: Any = None, ai_client: Any = None) -> FastAPI:
    """构建 FastAPI 应用实例。

    :param settings: 服务配置；缺省时从环境变量读取。
    :param database: 数据库适配器；缺省时使用 MySQLDatabase。
    :param agent_runtime: 可选注入的 Agent 运行时（需提供 invoke/get_status）；
        未注入且 ``agent_runtime_enabled=True`` 时尝试延迟构建，失败不影响启动。
    :param captcha_service: 可选注入的滑块验证码服务（AuthCaptchaService）；
        缺省时按配置密钥构建（鉴权组扩展路由使用）。
    :param sms_provider: 可选注入的短信供应商；缺省时按 SMS_PROVIDER 配置构建，
        tencent 凭据缺失/SDK 不可用会在启动期警告并降级 mock。
    :param ai_client: 文本模型调用的 httpx.AsyncClient（第三阶段第三组 generate
        端点使用）；缺省时在 lifespan 内创建，测试可注入 MockTransport 客户端。
    :return: 配置完成的 FastAPI 应用。
    :raises Exception: 数据库/配置初始化错误原样抛出；Agent 依赖缺失会被吞掉并降级为 503。
    """
    service_settings = settings or Settings()
    db = database or MySQLDatabase(service_settings)
    ai_http_client = ai_client
    resolve_object_url = create_object_url_resolver(service_settings)
    # 鉴权组扩展（阶段 8.1）：滑块验证码服务与短信供应商（均可注入替换，便于测试）。
    captcha_service = captcha_service or AuthCaptchaService(db, service_settings.captcha_signing_secret)
    sms_provider = sms_provider or create_sms_provider(service_settings)

    # Agent 运行时试点：优先使用注入的 runtime；否则在开关开启时延迟构建。
    # 构建失败（依赖未就绪 / 未配置模型）只记录原因，端点返回 503 envelope，不阻断服务启动。
    agent_runtime_service: Any = agent_runtime
    agent_runtime_error: str | None = None
    if service_settings.agent_runtime_enabled and agent_runtime_service is None:
        try:
            from .agent.model_provider import LangChainModelProvider
            from .agent.quality.graph import build_storyboard_quality_graph

            provider = LangChainModelProvider.from_settings(service_settings)
            storyboard_graph = build_storyboard_quality_graph(provider, enable_model_review=False)
            try:
                from .agent.runtime import AgentRuntime

                agent_runtime_service = AgentRuntime(graph=storyboard_graph, settings=service_settings)
            except Exception:
                agent_runtime_error = "Agent 运行时初始化失败"
        except AgentError as exc:
            agent_runtime_error = exc.message
        except Exception:
            agent_runtime_error = "Agent 运行时依赖未就绪"

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal ai_http_client
        if ai_http_client is None:
            # 文本模型调用客户端：300s 超时延续原 AI 客户端预算（generate 长任务）。
            ai_http_client = httpx.AsyncClient(timeout=300.0)
        yield
        if isinstance(ai_http_client, httpx.AsyncClient):
            await ai_http_client.aclose()

    app = FastAPI(title="ProjectDream API", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request.state.request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-API-Gateway"] = "fastapi"
        return response

    @app.get("/health")
    async def health():
        return {"status": "ok", "service": service_settings.app_name, "config": service_settings.public_summary()}

    @app.get("/ready")
    async def ready():
        """就绪探针：仅检查自身依赖（MySQL）。

        第四阶段已删除 Node upstream 探活（compose 中 api depends_on backend
        healthy 的启动顺序依赖解除属第五阶段编排变更，与本代码无关）。

        :return: 就绪 200 ``{status, checks}``；MySQL 不可用 503 ``not_ready``。
        """
        try:
            database_ready = await asyncio.to_thread(db.health)
        except Exception:
            database_ready = False
        checks = {"mysql": database_ready}
        if not all(checks.values()):
            return JSONResponse(status_code=503, content={"status": "not_ready", "checks": checks})
        return {"status": "ready", "checks": checks}

    def internal_agent_gate(request: Request) -> JSONResponse | None:
        """内部 Agent 端点的开关与令牌校验闸门。

        校验顺序：试点开关关闭 → 503；缺 ``X-Internal-Token`` 头 → 401；
        服务未配置令牌 → 503；令牌不匹配（常数时间比较）→ 403。

        :param request: 当前请求。
        :return: None 表示校验通过；否则返回对应状态码的 failure envelope 响应。
        :raises: 本函数不抛出异常。
        """
        if not service_settings.agent_runtime_enabled:
            return JSONResponse(status_code=503, content=failure(503, "Agent 运行时试点未启用"))
        header_token = request.headers.get("x-internal-token")
        if not header_token:
            return JSONResponse(status_code=401, content=failure(401, "缺少内部调用令牌"))
        if not service_settings.internal_token:
            return JSONResponse(status_code=503, content=failure(503, "内部调用令牌未配置"))
        if not hmac.compare_digest(header_token, service_settings.internal_token):
            return JSONResponse(status_code=403, content=failure(403, "内部调用令牌不正确"))
        return None

    def require_agent_runtime() -> Any:
        """获取可用的 Agent 运行时；不可用时抛出带 envelope 的 503。

        :return: 注入或延迟构建的 runtime 对象。
        :raises HTTPException: 503，detail 为 failure envelope（由全局处理器转为 JSON）。
        """
        if agent_runtime_service is None:
            raise HTTPException(
                status_code=503,
                detail=failure(503, agent_runtime_error or "Agent 运行时试点未启用"),
            )
        return agent_runtime_service

    @app.post("/internal/agent/runs")
    async def create_agent_run(request: AgentRequest, raw_request: Request):
        """提交一次 Agent 运行（内部端点）。

        :param request: 经 Pydantic 校验的请求体（复用 agent.schemas.AgentRequest）。
        :param raw_request: 原始请求，用于内部令牌校验。
        :return: 成功时 ``success(result.model_dump())``；闸门或运行时不可用时返回 401/403/503 envelope。
        :raises HTTPException: 运行时未就绪时 503。
        """
        gate = internal_agent_gate(raw_request)
        if gate is not None:
            return gate
        runtime = require_agent_runtime()
        result = runtime.invoke(request)
        if inspect.isawaitable(result):
            result = await result
        return success(result.model_dump())

    @app.get("/internal/agent/runs/{run_id}")
    async def get_agent_run(run_id: str, raw_request: Request):
        """查询 Agent 运行状态（内部端点）。

        :param run_id: 路径中的运行 ID。
        :param raw_request: 原始请求，用于内部令牌校验。
        :return: 命中时 ``success(data)``；未命中 404 envelope；闸门未通过时 401/403/503。
        :raises HTTPException: 运行时未就绪时 503。
        """
        gate = internal_agent_gate(raw_request)
        if gate is not None:
            return gate
        runtime = require_agent_runtime()
        data = runtime.get_status(run_id)
        if inspect.isawaitable(data):
            data = await data
        if data is None:
            return JSONResponse(status_code=404, content=failure(404, "Agent run 不存在"))
        return success(data)

    async def require_user(request: Request) -> dict[str, Any]:
        user = await asyncio.to_thread(db.find_user_by_token, _token(request))
        if not user:
            raise HTTPException(status_code=401, detail=failure(4010, "未登录或登录已过期"))
        return user

    @app.get("/api/voice-profiles")
    async def list_voice_profiles(request: Request):
        await require_user(request)
        rows = await asyncio.to_thread(db.list_active_voice_profiles)
        return success({
            "items": [voice_profile_row(row) for row in rows],
            "ageGroups": [
                {"value": "child", "label": "儿童（12 岁及以下）"},
                {"value": "teen", "label": "少年（13-18 岁）"},
                {"value": "young_adult", "label": "青年（19-35 岁）"},
                {"value": "middle_aged", "label": "中年（36-55 岁）"},
                {"value": "senior", "label": "老年（56 岁以上）"},
            ],
            "genders": [
                {"value": "male", "label": "男性声线"},
                {"value": "female", "label": "女性声线"},
                {"value": "neutral", "label": "中性 / 系统声线"},
            ],
        })

    @app.post("/api/auth/login-password")
    async def login_password(request: Request):
        body = await request.json()
        # 手机号标准化与 Node normalizePhone 对齐：仅保留 ASCII 数字（全角数字视作非法字符剔除），截取前 11 位。
        phone = "".join(char for char in str(body.get("phone") or "") if "0" <= char <= "9")[:11]
        password = str(body.get("password") or "")
        if len(phone) != 11 or not phone.startswith("1"):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        if len(password) < 6:
            return JSONResponse(status_code=400, content=failure(4007, "密码至少需要 6 位"))
        user = await asyncio.to_thread(db.fetch_user_by_phone, phone)
        if not user or user.get("password_hash") != hashlib.sha256(password.encode()).hexdigest():
            return JSONResponse(status_code=400, content=failure(4008, "账号或密码不正确"))
        token = await asyncio.to_thread(db.create_session, user)
        return success({"token": token, "user": _safe_user(user)}, "登录成功")

    @app.get("/api/auth/check-phone")
    async def check_phone(request: Request):
        phone = "".join(char for char in str(request.query_params.get("phone") or "") if "0" <= char <= "9")[:11]
        if len(phone) != 11 or not phone.startswith("1"):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        user = await asyncio.to_thread(db.fetch_user_by_phone, phone)
        return success({"exists": bool(user)})

    # ------------------------------------------------------------------
    # 鉴权组扩展（阶段 8.1，FastAPI-Only 迁移第三阶段第一组）
    # GET /api/auth/captcha、POST /api/auth/captcha/verify、POST /api/auth/send-code、
    # POST /api/auth/reset-password、POST /api/auth/login、POST /api/auth/register。
    # 行为规格按兼容契约实现；会话状态走 MySQL（迁移 0004），
    # 短信发送走 app/sms 适配层。Node 无 /api/auth/logout 与 /api/auth/refresh 路由，
    # 故本组不含对应实现。
    # ------------------------------------------------------------------

    @app.get("/api/auth/captcha")
    async def auth_captcha_issue(request: Request):
        """签发滑块验证码挑战（对齐 Node GET /api/auth/captcha，index.mjs L12268）。

        ``phone`` query 参数按 Node 语义 normalizePhone 后绑定到挑战；来源 IP 取
        ``x-forwarded-for`` / ``x-real-ip`` / socket 首段。挑战答案（target_x）只落 DB。

        :param request: 当前请求。
        :returns: 200 + ``{"code":0, "message":"success", "data":{challengeId, challenge,
            backgroundImage, pieceImage, trackWidth, imageHeight, pieceSize, pieceTop, expiresAt}}``。
        :raises Exception: DB 写入失败时由网关兜底 500/5001。
        """
        phone = _normalize_phone(request.query_params.get("phone"))
        data = captcha_service.create_challenge(ip=_client_ip(request), phone=phone)
        return success(data)

    @app.post("/api/auth/captcha/verify")
    async def auth_captcha_verify(request: Request):
        """校验滑块挑战并签发一次性 captchaToken（对齐 Node L12276）。

        校验失败一律 409/4010（消息透传服务层，与 Node 逐字对齐）；成功 message
        为「滑块验证通过」，data 仅含 captchaToken。

        :param request: 当前请求，body 为 ``{"challenge", "position", "phone"?}``。
        :returns: 200 成功或 409/4010 失败 envelope。
        :raises Exception: DB 故障时由网关兜底 500/5001。
        """
        body = await request.json()
        result = captcha_service.verify(
            challenge=body.get("challenge"),
            position=body.get("position"),
            phone=_normalize_phone(body.get("phone")),
            ip=_client_ip(request),
        )
        if not result["ok"]:
            return JSONResponse(status_code=409, content=failure(4010, result["message"]))
        return success({"captchaToken": result["verificationToken"]}, "滑块验证通过")

    @app.post("/api/auth/send-code")
    async def auth_send_code(request: Request):
        """发送短信验证码（对齐 Node L12294：先消费 captchaToken，再按用途校验注册态）。

        校验顺序：4001 手机号 → 4009 captchaToken 消费失败（409）→ 4002 已注册 /
        4004 未注册 → 供应商发码（失败 500/5001 + 受控文案）→ sms_codes 落库。
        ``type`` 非法或缺省一律落 ``login``（对齐 Node）。Node 无发码限频逻辑，
        频控由短信供应商自身承担，本路由不复刻额外限频。

        :param request: 当前请求，body 为 ``{"phone", "captchaToken", "type"?}``。
        :returns: 成功 200 ``{"countdown", "expiresIn", "provider", "devCode"?}``
            （devCode 仅 mock 供应商返回，与 Node JSON 省略 undefined 的行为一致）。
        :raises Exception: DB 故障由网关兜底 500/5001；SMS 失败已捕获为 500/5001 受控文案。
        """
        body = await request.json()
        phone = _normalize_phone(body.get("phone"))
        code_type = str(body.get("type") or "login")
        if code_type not in ("register", "reset"):
            code_type = "login"
        if not AUTH_PHONE_PATTERN.fullmatch(phone):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        if not captcha_service.consume_verification_token(body.get("captchaToken")):
            return JSONResponse(
                status_code=409,
                content=failure(4009, "请先完成滑块验证，验证结果已失效或已使用"),
            )
        existing_user = await asyncio.to_thread(db.fetch_user_by_phone, phone)
        if code_type == "register" and existing_user:
            return JSONResponse(status_code=400, content=failure(4002, "该手机号已注册"))
        if code_type in ("login", "reset") and not existing_user:
            return JSONResponse(status_code=400, content=failure(4004, "该手机号尚未注册"))
        # 6 位验证码：对齐 Node randomInt(100000, 1000000) 的取值域。
        code = str(secrets.randbelow(900000) + 100000)
        try:
            send_result = sms_provider.send_code(phone, code_type, code)
        except SmsSendError as exc:
            # Node：发送异常走全局兜底 500/5001 + error.message（适配器文案已受控脱敏）。
            return JSONResponse(status_code=500, content=failure(5001, str(exc)))
        expires_in = int(send_result.get("expiresIn") or SMS_CODE_TTL_SECONDS)
        await asyncio.to_thread(
            db.save_sms_code_record,
            phone,
            code_type,
            code,
            send_result.get("provider"),
            expires_in,
        )
        data: dict[str, Any] = {
            "countdown": send_result.get("countdown"),
            "expiresIn": send_result.get("expiresIn"),
            "provider": send_result.get("provider"),
        }
        # 对齐 Node：tencent 分支 devCode 为 undefined，JSON 序列化时省略该键。
        if send_result.get("devCode") is not None:
            data["devCode"] = send_result["devCode"]
        return success(data, "验证码已发送")

    @app.post("/api/auth/reset-password")
    async def auth_reset_password(request: Request):
        """重置密码（对齐 Node L12370：4001 → 4003 → 4007 → 4004 → 4005 → 更新）。

        :param request: 当前请求，body 为 ``{"phone", "code", "newPassword"}``。
        :returns: 成功 200 ``{"success": true}``，message「密码重置成功」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        body = await request.json()
        phone = _normalize_phone(body.get("phone"))
        code = str(body.get("code") or "")
        new_password = str(body.get("newPassword") or "")
        if not AUTH_PHONE_PATTERN.fullmatch(phone):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        if not AUTH_SMS_CODE_PATTERN.fullmatch(code):
            return JSONResponse(status_code=400, content=failure(4003, "验证码格式不正确"))
        if len(new_password) < 6:
            return JSONResponse(status_code=400, content=failure(4007, "新密码至少需要 6 位"))
        user = await asyncio.to_thread(db.fetch_user_by_phone, phone)
        if not user:
            return JSONResponse(status_code=400, content=failure(4004, "该手机号尚未注册"))
        code_check = await asyncio.to_thread(db.verify_sms_code, phone, "reset", code)
        if not code_check["ok"]:
            return JSONResponse(status_code=400, content=failure(4005, code_check["message"]))
        await asyncio.to_thread(db.update_user_password, int(user["id"]), new_password)
        return success({"success": True}, "密码重置成功")

    @app.post("/api/auth/login")
    async def auth_login_by_sms(request: Request):
        """手机号 + 短信验证码登录（对齐 Node L12408：4001 → 4003 → 4004 → 4005 → 签会话）。

        会话签发复用 login-password 的 ``create_session``（每次登录产生新 token，
        旧会话不吊销）。与 Node 的已知差异同 login-password：响应 user 的 createdAt
        为 null（fetch_user_by_phone 未取该列，7.1 既有行为）。

        :param request: 当前请求，body 为 ``{"phone", "code"}``。
        :returns: 成功 200 ``{"token", "user"}``，message「登录成功」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        body = await request.json()
        phone = _normalize_phone(body.get("phone"))
        code = str(body.get("code") or "")
        if not AUTH_PHONE_PATTERN.fullmatch(phone):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        if not AUTH_SMS_CODE_PATTERN.fullmatch(code):
            return JSONResponse(status_code=400, content=failure(4003, "验证码格式不正确"))
        user = await asyncio.to_thread(db.fetch_user_by_phone, phone)
        if not user:
            return JSONResponse(status_code=400, content=failure(4004, "该手机号尚未注册"))
        code_check = await asyncio.to_thread(db.verify_sms_code, phone, "login", code)
        if not code_check["ok"]:
            return JSONResponse(status_code=400, content=failure(4005, code_check["message"]))
        token = await asyncio.to_thread(db.create_session, user)
        return success({"token": token, "user": _safe_user(user)}, "登录成功")

    @app.post("/api/auth/register")
    async def auth_register(request: Request):
        """注册新用户（对齐 Node L12440：4001 → 4002 → 4003 → 4006 → 4007 → 4005 → 建号签会话）。

        校验顺序与 Node 一致：已注册检查（4002）先于验证码/昵称/密码格式校验。
        成功后创建用户并签发会话，message「注册成功」。

        :param request: 当前请求，body 为 ``{"phone", "code", "nickname", "password"}``。
        :returns: 成功 200 ``{"token", "user"}``（user 含 createdAt ISO 字符串，对齐 Node createUser）。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        body = await request.json()
        phone = _normalize_phone(body.get("phone"))
        code = str(body.get("code") or "")
        nickname = str(body.get("nickname") or "").strip()
        password = str(body.get("password") or "")
        if not AUTH_PHONE_PATTERN.fullmatch(phone):
            return JSONResponse(status_code=400, content=failure(4001, "手机号格式不正确"))
        if await asyncio.to_thread(db.fetch_user_by_phone, phone):
            return JSONResponse(status_code=400, content=failure(4002, "该手机号已注册"))
        if not AUTH_SMS_CODE_PATTERN.fullmatch(code):
            return JSONResponse(status_code=400, content=failure(4003, "验证码格式不正确"))
        if len(nickname) < 2:
            return JSONResponse(status_code=400, content=failure(4006, "昵称至少需要 2 个字符"))
        if len(password) < 6:
            return JSONResponse(status_code=400, content=failure(4007, "密码至少需要 6 位"))
        code_check = await asyncio.to_thread(db.verify_sms_code, phone, "register", code)
        if not code_check["ok"]:
            return JSONResponse(status_code=400, content=failure(4005, code_check["message"]))
        user = await asyncio.to_thread(db.create_user, phone, nickname, password)
        token = await asyncio.to_thread(db.create_session, user)
        return success({"token": token, "user": _safe_user(user)}, "注册成功")


    @app.get("/api/projects")
    async def list_projects(request: Request):
        user = await require_user(request)
        rows = await asyncio.to_thread(db.list_projects, int(user["id"]))
        return success({"items": [project_row(row) for row in rows]})

    @app.post("/api/projects")
    async def create_project(request: Request):
        user = await require_user(request)
        body = await request.json()
        name = str(body.get("name") or "").strip()
        if not name:
            return JSONResponse(status_code=400, content=failure(4001, "项目名不能为空"))
        row = await asyncio.to_thread(db.create_project, int(user["id"]), {**body, "name": name})
        return success(project_row(row), "项目创建成功")

    @app.api_route("/api/projects/{project_id}", methods=["GET", "PATCH"])
    async def project_detail(project_id: int, request: Request):
        user = await require_user(request)
        row = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        if request.method == "PATCH":
            body = await request.json()
            if not isinstance(body, dict):
                return JSONResponse(status_code=400, content=failure(4001, "请求内容无效"))
            unknown = [key for key in body if key not in PROJECT_UPDATE_FIELDS]
            if unknown:
                return JSONResponse(status_code=400, content=failure(4001, f"不支持的字段：{'、'.join(unknown)}；可更新字段为 name、category、narrativeVision、visualStyle、aspectRatio"))
            updates: dict[str, Any] = {}
            for key in PROJECT_UPDATE_FIELDS:
                if key not in body:
                    continue
                value = str(body[key] or "").strip()
                if key == "name":
                    if not value:
                        return JSONResponse(status_code=400, content=failure(4001, "项目名不能为空"))
                    if len(value) > 200:
                        return JSONResponse(status_code=400, content=failure(4001, "项目名不能超过 200 个字"))
                elif key == "category" and len(value) > 80:
                    return JSONResponse(status_code=400, content=failure(4001, "作品类型不能超过 80 个字"))
                elif key == "aspectRatio" and value and not _is_valid_aspect_ratio(value):
                    return JSONResponse(status_code=400, content=failure(4001, f"画面比例「{value}」无法解析，请使用 16:9、9:16、2.39:1 这类格式"))
                updates[key] = value or None
            if not updates:
                return JSONResponse(status_code=400, content=failure(4001, "没有可更新的字段"))
            updated = await asyncio.to_thread(db.update_project, project_id, int(user["id"]), updates)
            if updated is not None:
                # Re-read the aggregate counters so progress data remains compatible with GET/list.
                updated = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
            return success(project_row(updated), "项目设置已保存")
        return success(project_row(row))

    @app.get("/api/projects/{project_id}/assets")
    async def project_assets(project_id: int, request: Request):
        user = await require_user(request)
        if project_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 projectId"))
        rows = await asyncio.to_thread(db.project_assets, project_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        items = [asset_item(row, "character", project_id) for row in rows["characters"]]
        items += [asset_item(row, "image", project_id) for row in rows["images"]]
        items += [asset_item(row, "video", project_id) for row in rows["videos"]]
        items += [asset_item(row, "audio", project_id) for row in rows["audios"]]
        summary = {
            "totalCount": len(items),
            "characterCount": sum(item["assetType"] == "character" for item in items),
            "imageCount": sum(item["assetType"] == "image" for item in items),
            "videoCount": sum(item["assetType"] == "video" for item in items),
            "audioCount": sum(item["assetType"] == "audio" for item in items),
            "confirmedImageCount": sum(item["assetType"] == "image" and item["status"] == "confirmed" for item in items),
            "confirmedVideoCount": sum(item["assetType"] == "video" and item["status"] == "confirmed" for item in items),
            "confirmedAudioCount": sum(item["assetType"] == "audio" and item["status"] == "confirmed" for item in items),
        }
        return success({"projectId": project_id, "summary": summary, "items": items})

    @app.get("/api/projects/{project_id:int}/workflow-readiness")
    async def project_workflow_readiness(project_id: int, request: Request):
        user = await require_user(request)
        context = await asyncio.to_thread(db.get_project_workflow_readiness_context, project_id, int(user["id"]))
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success(evaluate_creative_workflow_gates(
            scenes=context["scenes"], parsed_fingerprint=context["parsed_fingerprint"],
            characters=context["characters"], asset_nodes=context["asset_nodes"],
        ), "项目流程门禁已读取")

    @app.post("/api/projects/{project_id:int}/workflow-readiness/parse-complete")
    async def confirm_project_script_parsed(project_id: int, request: Request):
        user = await require_user(request)
        user_id = int(user["id"])
        context = await asyncio.to_thread(db.get_project_workflow_readiness_context, project_id, user_id)
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        scenes = context["scenes"]
        if not scenes or any(not str(scene.get("content") or "").strip() for scene in scenes):
            return JSONResponse(status_code=409, content=failure(4004, "所有场景正文必须先生成并保存，才能完成剧本解析。"))
        outcome = await asyncio.to_thread(db.persist_parsed_script_fingerprint, project_id, user_id)
        if outcome == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        if outcome == "script_incomplete":
            return JSONResponse(status_code=409, content=failure(4004, "所有场景正文必须先生成并保存，才能完成剧本解析。"))
        if outcome == "assets_incomplete":
            return JSONResponse(status_code=409, content=failure(4004, "剧本解析结果不完整，请重新执行角色与场景解析。"))
        context = await asyncio.to_thread(db.get_project_workflow_readiness_context, project_id, user_id)
        return success(evaluate_creative_workflow_gates(
            scenes=context["scenes"], parsed_fingerprint=context["parsed_fingerprint"],
            characters=context["characters"], asset_nodes=context["asset_nodes"],
        ), "当前剧本解析状态已确认")

    @app.get("/api/projects/{project_id}/audio")
    async def list_project_audio(project_id: int, request: Request):
        user = await require_user(request)
        rows = await asyncio.to_thread(db.list_project_audio, project_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        items = []
        for row in rows:
            item = audio_asset_row(row)
            signed_url = resolve_object_url(row.get("storage_key") or row.get("storageKey"))
            if signed_url:
                item["audioUrl"] = signed_url
            items.append(item)
        return success({"items": items})

    def _audio_mock_url(project_id: int, scene_id: int, character_id: int, version_no: int, track_type: str, candidate_no: int) -> str:
        base = str(service_settings.public_base_url or "").strip().rstrip("/")
        return f"{base}/mock/audio/{project_id}/{scene_id}/{character_id}/{version_no}/{track_type}/{candidate_no}.wav"

    def _audio_source_text(value: Any, character_name: str = "") -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        selected: list[str] = []
        for line in text.splitlines():
            normalized = line.strip()
            if not normalized:
                continue
            if "：" in normalized or ":" in normalized:
                speaker, spoken = re.split(r"[：:]", normalized, maxsplit=1)
                if character_name and speaker.strip().startswith(character_name):
                    normalized = spoken.strip().strip("“”\"'「」")
                elif not character_name:
                    normalized = spoken.strip().strip("“”\"'「」")
                elif speaker.strip() != character_name:
                    continue
            if normalized:
                selected.append(normalized)
        return "\n".join(selected) or text

    async def _effective_audio_config() -> dict[str, Any]:
        defaults = get_model_setting_fallback_values()
        persisted = await asyncio.to_thread(db.get_model_settings_map)
        merged = {**defaults, **persisted}
        return {
            "provider": str(merged.get("AUDIO_PROVIDER") or "mock").strip().lower(),
            "api_key": str(merged.get("DASHSCOPE_API_KEY") or "").strip(),
            "base_url": str(merged.get("AUDIO_BASE_URL") or "").strip(),
            "model": str(merged.get("AUDIO_MODEL") or "qwen3-tts-flash").strip(),
            "voice": str(merged.get("AUDIO_VOICE") or "Cherry").strip(),
            "language_type": str(merged.get("AUDIO_LANGUAGE_TYPE") or "Chinese").strip(),
            "max_text_length": int(merged.get("AUDIO_MAX_TEXT_LENGTH") or 600),
            "timeout_seconds": int(merged.get("AUDIO_TIMEOUT_MS") or 120000) / 1000,
            "fallback_to_mock": str(merged.get("AUDIO_FALLBACK_TO_MOCK") or "false").lower() in {"1", "true", "yes", "on"},
        }

    async def _generate_tts_candidate(config: dict[str, Any], text: str, voice_name: str, model_name: str, instructions: str | None) -> dict[str, Any]:
        async with httpx.AsyncClient(follow_redirects=False) as client:
            return await synthesize_audio(
                config=config, text=text, voice_name=voice_name, model_name=model_name,
                instructions=instructions, client=client,
            )

    @app.post("/api/projects/{project_id:int}/audio/generate")
    async def generate_project_audio_route(project_id: int, request: Request):
        """同步生成音频候选并落入既有对象存储和 audio_assets。"""
        user = await require_user(request)
        user_id = int(user["id"])
        project = await asyncio.to_thread(db.get_project, project_id, user_id)
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            body = await request.json()
        except Exception:
            body = {}
        body = body if isinstance(body, dict) else {}
        track_type = str(body.get("trackType") or "").strip().lower()
        if track_type not in {"dialogue", "narration", "music", "sfx"}:
            return JSONResponse(status_code=400, content=failure(4001, "trackType 只允许 dialogue / narration / music / sfx"))
        config = await _effective_audio_config()
        if config["provider"] != "mock" and track_type not in {"dialogue", "narration"}:
            return JSONResponse(status_code=400, content=failure(4001, "qwen3-tts-flash only supports dialogue and narration tracks"))
        candidate_count = min(3, max(1, _parse_id_value(body.get("candidateCount")) or 1))
        scene_id = _parse_id_value(body.get("sceneId"))
        storyboard_id = _parse_id_value(body.get("storyboardId"))
        character_id = _parse_id_value(body.get("characterId"))
        scene = None
        storyboard = None
        if storyboard_id:
            storyboard = await asyncio.to_thread(db.get_storyboard, storyboard_id, user_id)
            if storyboard is None or int(storyboard.get("project_id") or 0) != project_id:
                return JSONResponse(status_code=404, content=failure(4004, "storyboardId 不属于当前项目"))
            if scene_id and int(storyboard.get("scene_id") or 0) != scene_id:
                return JSONResponse(status_code=400, content=failure(4001, "storyboardId 与 sceneId 不匹配"))
            scene_id = int(storyboard.get("scene_id") or 0)
        if scene_id:
            scene = await asyncio.to_thread(db.get_scene, scene_id, user_id)
            if scene is None or int(scene.get("project_id") or 0) != project_id:
                return JSONResponse(status_code=404, content=failure(4004, "sceneId 不属于当前项目"))
        character = None
        if character_id:
            character = await asyncio.to_thread(db.get_character_for_user, character_id)
            if character is None or int(character.get("ownerId") or 0) != user_id or int(character.get("project_id") or 0) != project_id:
                return JSONResponse(status_code=404, content=failure(4004, "characterId 不属于当前项目"))
        if track_type == "dialogue" and character is None:
            return JSONResponse(status_code=400, content=failure(4001, "对白轨必须选择角色"))

        voice_profile = None
        if track_type == "dialogue" and config["provider"] != "mock":
            profiles = [voice_profile_row(row) for row in await asyncio.to_thread(db.list_active_voice_profiles)]
            resolution = resolve_character_voice_profile(character, profiles, body.get("voiceProfileKey") or character.get("voice_profile_key") or "")
            if resolution.get("error"):
                return JSONResponse(status_code=400, content=failure(4001, resolution["error"]))
            voice_profile = resolution["profile"]
            custom_design = _safe_json_object(character.get("voice_design_json"))
            locked_custom = bool(character.get("voice_locked") and custom_design.get("provider") == "qwen" and custom_design.get("voiceId") == character.get("voice_setting") and custom_design.get("targetModel"))
            if not character.get("voice_locked") or (not voice_profile and not locked_custom):
                return JSONResponse(status_code=409, content=failure(4010, f"角色“{character.get('name')}”还没有确认并锁定音色，请先完成角色音色管理"))
            if locked_custom:
                voice_profile = {"profileKey": character.get("voice_profile_key"), "voiceId": custom_design["voiceId"], "modelName": custom_design["targetModel"], "instructions": ""}

        raw_text = str(body.get("text") or ((storyboard or {}).get("dialogue_text") if track_type == "dialogue" else "") or (scene or {}).get("summary") or (scene or {}).get("content") or "").strip()
        text = _audio_source_text(raw_text, str((character or {}).get("name") or "")) if track_type == "dialogue" else raw_text
        if config["provider"] != "mock" and not text:
            return JSONResponse(status_code=400, content=failure(4001, "Speech synthesis text is required"))
        if len(text) > int(config["max_text_length"]):
            return JSONResponse(status_code=400, content=failure(4001, f"Speech synthesis text exceeds {config['max_text_length']} characters"))

        voice_name = str((voice_profile or {}).get("voiceId") or (character or {}).get("voice_setting") or body.get("voiceName") or config["voice"]).strip()
        model_name = str((voice_profile or {}).get("modelName") or body.get("modelName") or config["model"]).strip()
        instructions = "；".join(value for value in [str((voice_profile or {}).get("instructions") or "").strip(), str((character or {}).get("voice_style") or "").strip(), str(body.get("voiceStyle") or "").strip()] if value) or None
        duration = _parse_id_value(body.get("durationSeconds")) or _parse_id_value((storyboard or {}).get("duration_seconds")) or (18 if track_type == "music" else 8 if track_type == "sfx" else 12)
        scene_no = (scene or {}).get("scene_no")
        scene_title = str((scene or {}).get("title") or "").strip()
        shot_no = (storyboard or {}).get("shot_no")
        character_name = str((character or {}).get("name") or "").strip()
        if str(body.get("title") or "").strip():
            title = str(body["title"]).strip()[:255]
        elif track_type == "dialogue":
            title = f"对白轨{f' · {shot_no}' if shot_no else ''} - {character_name or scene_title or (f'Scene {int(scene_no):02d}' if scene_no else '未命名来源')}"
        elif track_type == "narration":
            title = f"旁白轨{f' · {shot_no}' if shot_no else ''} - {scene_title or (f'Scene {int(scene_no):02d}' if scene_no else project.get('name') or '项目')}"
        else:
            title = f"{'音乐轨' if track_type == 'music' else '音效轨'} - {scene_title or project.get('name') or '项目'}"

        values = []
        for candidate_no in range(1, candidate_count + 1):
            candidate = {
                "track_type": track_type, "scene_id": scene_id or None,
                "storyboard_id": storyboard_id or None, "character_id": character_id or None,
                "start_offset_seconds": max(0.0, _number_or_zero(body.get("startOffsetSeconds"))),
                "title": title, "audio_url": None, "storage_key": None,
                "duration_seconds": float(duration), "voice_name": voice_name or None,
                "model_name": model_name, "voice_profile_key": (voice_profile or {}).get("profileKey"),
                "voice_instructions": instructions,
            }
            if config["provider"] == "mock":
                candidate["audio_url"] = _audio_mock_url(project_id, scene_id, character_id, "{version}", track_type, candidate_no)
                candidate["model_name"] = "mock-audio-v2"
            else:
                try:
                    generated = await _generate_tts_candidate(config, text, voice_name, model_name, instructions)
                except AudioProviderError as exc:
                    if not config["fallback_to_mock"]:
                        status = 503 if exc.status_code == 503 else 502
                        return JSONResponse(status_code=status, content=failure(5020, f"真实音频生成服务暂时不可用：{str(exc)}"))
                    candidate["audio_url"] = _audio_mock_url(project_id, scene_id, character_id, "{version}", track_type, candidate_no)
                    candidate["model_name"] = "mock-audio-v2"
                else:
                    extension = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/webm": ".webm"}.get(generated["content_type"].lower(), ".wav")
                    storage_key = f"projects/{project_id}/generated-audio/{track_type}/{secrets.token_hex(16)}{extension}"
                    try:
                        stored = await asyncio.to_thread(_write_object_bytes, service_settings, storage_key, generated["audio_bytes"], generated["content_type"])
                    except Exception as exc:
                        logger.warning("tts storage write failed request_id=%s error=%s", request.state.request_id, type(exc).__name__)
                        return JSONResponse(status_code=500, content=failure(5001, "生成音频保存失败，请检查对象存储配置"))
                    candidate.update({"audio_url": stored["url"], "storage_key": stored["key"], "duration_seconds": generated["duration_seconds"] or duration, "voice_name": generated["voice_name"], "model_name": generated["model_name"]})
            values.append(candidate)

        created = await asyncio.to_thread(db.create_audio_assets, project_id, user_id, values)
        if created is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        items = []
        for row in created:
            item = audio_asset_row(row)
            if row.get("storage_key"):
                item["audioUrl"] = resolve_object_url(row.get("storage_key")) or item["audioUrl"]
            items.append(item)
        return success({"items": items}, "音频候选轨道已生成")

    @app.post("/api/characters/{character_id:int}/voice-preview")
    async def character_voice_preview_route(character_id: int, request: Request):
        """按角色已选音色合成试听，真实音频保存到对象存储。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        try:
            body = await request.json()
        except Exception:
            body = {}
        body = body if isinstance(body, dict) else {}
        config = await _effective_audio_config()
        if body.get("voiceAgent") is True:
            if config["provider"] == "mock":
                return JSONResponse(status_code=503, content=failure(5030, "当前音频服务处于模拟模式，无法创建真实角色音色；请切换到 DashScope 音频服务"))
            sample_text = str(body.get("text") or "").strip()
            design = build_rule_based_voice_design(character, sample_text)
            gender_label = {"male": "男性", "female": "女性"}.get(str(character.get("gender") or "").lower(), "中性")
            design["ageAndGender"] = f"{gender_label}声线；设计必须符合角色已确定的性别与年龄感"
            voice_prompt = "；".join(value for value in [design["ageAndGender"], design["timbre"], design["summary"], design["performanceInstructions"], design["rhythm"]] if value)[:500]
            preview_text = sample_text or design["sampleText"] or "我给过你机会，现在把你知道的都说出来。"
            if len(preview_text) < 15:
                preview_text = f"{preview_text}{'。' if preview_text else ''}我给过你机会，现在把你知道的都说出来。"
            preview_text = preview_text[:200]
            target_model = str(os.environ.get("AUDIO_VOICE_DESIGN_MODEL") or "cosyvoice-v3.5-flash").strip()
            try:
                async with httpx.AsyncClient(follow_redirects=False) as audio_client:
                    enrollment = await create_qwen_designed_voice(
                        client=audio_client,
                        api_key=config["api_key"],
                        target_model=target_model,
                        voice_prompt=voice_prompt,
                        preview_text=preview_text,
                        prefix=f"char{character_id}",
                    )
            except AudioProviderError as exc:
                status = 503 if exc.status_code == 503 else 502
                return JSONResponse(status_code=status, content=failure(5020, f"自定义音色创建失败：{str(exc)}"))
            design.update({
                "provider": "qwen", "model": "voice-enrollment", "voiceId": enrollment["voice_id"],
                "targetModel": enrollment["target_model"], "status": "ready",
                "requestId": enrollment["request_id"], "voicePrompt": voice_prompt,
                "sampleText": preview_text,
            })
            storage_key = f"projects/{character['project_id']}/characters/{character_id}/voice-preview/{secrets.token_hex(16)}.wav"
            try:
                stored = await asyncio.to_thread(_write_object_bytes, service_settings, storage_key, enrollment["preview_audio_bytes"], "audio/wav")
            except Exception as exc:
                logger.warning("voice enrollment preview storage failed request_id=%s error=%s", request.state.request_id, type(exc).__name__)
                return JSONResponse(status_code=500, content=failure(5001, "自定义音色试听保存失败，请检查对象存储配置"))
            preview_name = f"audio-{character['project_id']}-voice-preview-{character_id}-{secrets.token_hex(12)}.wav"
            preview_dir = Path(service_settings.generated_audio_dir).resolve()
            await asyncio.to_thread(preview_dir.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread((preview_dir / preview_name).write_bytes, enrollment["preview_audio_bytes"])
            updated_character = await asyncio.to_thread(
                db.update_character_voice_binding,
                character_id,
                {"voice_design_json": json.dumps(design, ensure_ascii=False), "voice_setting": enrollment["voice_id"], "voice_profile_key": None, "voice_locked": 0},
            )
            return success({
                "audioUrl": f"{str(service_settings.public_base_url or '').rstrip('/')}/generated/audio/{preview_name}", "durationSeconds": 4, "voiceName": enrollment["voice_id"],
                "modelName": enrollment["target_model"], "voiceProfileKey": None,
                "voiceProfileName": None, "voiceProfileGender": None, "voiceDesign": design,
                "voiceId": enrollment["voice_id"], "referenceAudioUrl": None,
                "referenceAudioBound": False, "character": character_row(updated_character) if updated_character else None,
            }, "声音 Agent 试听已生成")
        if body.get("bindReferenceAudio") is True:
            parsed_url = urlsplit(str(body.get("previewAudioUrl") or ""))
            file_name = Path(parsed_url.path).name
            expected_prefix = f"audio-{int(character['project_id'])}-voice-preview-{character_id}-"
            if (
                not parsed_url.path.startswith("/generated/audio/")
                or file_name != parsed_url.path.rsplit("/", 1)[-1]
                or not re.fullmatch(r"[A-Za-z0-9._-]+", file_name)
                or not file_name.startswith(expected_prefix)
            ):
                return JSONResponse(status_code=400, content=failure(4001, "自定义音色候选试听地址无效，请重新生成试听"))
            persisted_design = _safe_json_object(character.get("voice_design_json"))
            requested_voice_id = str(body.get("voiceId") or "").strip()
            if (
                persisted_design.get("provider") != "qwen"
                or not requested_voice_id
                or requested_voice_id != str(character.get("voice_setting") or "")
                or requested_voice_id != str(persisted_design.get("voiceId") or "")
                or str(body.get("voiceDesign", {}).get("voiceId") or "") != requested_voice_id
            ):
                return JSONResponse(status_code=409, content=failure(4001, "声音 Agent 设计已失效，请重新生成试听后再确认绑定"))
            preview_path = (Path(service_settings.generated_audio_dir).resolve() / file_name).resolve()
            try:
                preview_path.relative_to(Path(service_settings.generated_audio_dir).resolve())
                preview_bytes = await asyncio.to_thread(preview_path.read_bytes)
            except (ValueError, OSError):
                return JSONResponse(status_code=400, content=failure(4001, "试听音频已失效，请重新生成声音 Agent 试听"))
            storage_key = f"projects/{character['project_id']}/characters/{character_id}/voice-agent-reference/{secrets.token_hex(16)}.wav"
            try:
                stored = await asyncio.to_thread(_write_object_bytes, service_settings, storage_key, preview_bytes, "audio/wav")
            except Exception as exc:
                logger.warning("voice reference binding failed request_id=%s error=%s", request.state.request_id, type(exc).__name__)
                return JSONResponse(status_code=500, content=failure(5001, "参考音频保存失败，请检查对象存储配置"))
            voice_style = str(body.get("voiceStyle") or character.get("voice_style") or "").strip()[:160] or None
            updated_character = await asyncio.to_thread(
                db.update_character_voice_binding,
                character_id,
                {"reference_audio_url": stored["url"], "reference_audio_storage_key": stored["key"],
                 "voice_design_json": json.dumps(persisted_design, ensure_ascii=False), "voice_profile_key": None,
                 "voice_setting": requested_voice_id, "voice_style": voice_style, "voice_locked": 1},
            )
            return success({
                "audioUrl": str(body.get("previewAudioUrl") or ""), "voiceName": requested_voice_id,
                "modelName": persisted_design.get("targetModel"), "voiceProfileKey": None,
                "voiceDesign": persisted_design, "voiceId": requested_voice_id,
                "referenceAudioUrl": stored["url"], "referenceAudioBound": True,
                "character": character_row(updated_character) if updated_character else None,
            }, "音色试听已确认")
        profiles = [voice_profile_row(row) for row in await asyncio.to_thread(db.list_active_voice_profiles)]
        custom_design = _safe_json_object(character.get("voice_design_json"))
        locked_custom = bool(character.get("voice_locked") and custom_design.get("provider") == "qwen" and custom_design.get("voiceId") == character.get("voice_setting") and custom_design.get("targetModel"))
        resolution = resolve_character_voice_profile(character, profiles, body.get("voiceProfileKey") or character.get("voice_profile_key") or "")
        if resolution.get("error") and not locked_custom:
            return JSONResponse(status_code=400, content=failure(4001, resolution["error"]))
        voice_profile = resolution.get("profile")
        voice_name = str((voice_profile or {}).get("voiceId") or custom_design.get("voiceId") or character.get("voice_setting") or config["voice"]).strip()
        model_name = str(custom_design.get("targetModel") if locked_custom else ((voice_profile or {}).get("modelName") or body.get("modelName") or config["model"])).strip()
        text = str(body.get("text") or "").strip() or f"我是{character.get('name') or '角色'}。故事已经开始，我会做出自己的选择。"
        if len(text) > int(config["max_text_length"]):
            return JSONResponse(status_code=400, content=failure(4001, f"Speech synthesis text exceeds {config['max_text_length']} characters"))
        instructions = "；".join(value for value in [str((voice_profile or {}).get("instructions") or "").strip(), str(character.get("voice_style") or "").strip(), str(body.get("voiceStyle") or "").strip()] if value) or None
        if config["provider"] == "mock":
            return success({"audioUrl": _audio_mock_url(int(character["project_id"]), 0, character_id, 1, "voice-preview", 1), "durationSeconds": 4,
                            "voiceName": voice_name, "modelName": "mock-audio-v2", "voiceProfileKey": (voice_profile or {}).get("profileKey"),
                            "voiceProfileName": (voice_profile or {}).get("displayName"), "voiceProfileGender": (voice_profile or {}).get("gender"),
                            "voiceDesign": custom_design or None, "referenceAudioBound": False}, "音色试听已生成")
        try:
            generated = await _generate_tts_candidate(config, text, voice_name, model_name, instructions)
        except AudioProviderError as exc:
            status = 503 if exc.status_code == 503 else 502
            return JSONResponse(status_code=status, content=failure(5020, f"音色试听生成失败：{str(exc)}"))
        extension = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/webm": ".webm"}.get(generated["content_type"].lower(), ".wav")
        storage_key = f"projects/{character['project_id']}/characters/{character_id}/voice-preview/{secrets.token_hex(16)}{extension}"
        try:
            stored = await asyncio.to_thread(_write_object_bytes, service_settings, storage_key, generated["audio_bytes"], generated["content_type"])
        except Exception as exc:
            logger.warning("voice preview storage write failed request_id=%s error=%s", request.state.request_id, type(exc).__name__)
            return JSONResponse(status_code=500, content=failure(5001, "试听音频保存失败，请检查对象存储配置"))
        return success({"audioUrl": stored["url"], "durationSeconds": generated["duration_seconds"] or 4,
                        "voiceName": generated["voice_name"], "modelName": generated["model_name"],
                        "voiceProfileKey": (voice_profile or {}).get("profileKey"), "voiceProfileName": (voice_profile or {}).get("displayName"),
                        "voiceProfileGender": (voice_profile or {}).get("gender"), "voiceDesign": custom_design or None,
                        "voiceId": voice_name, "referenceAudioUrl": None, "referenceAudioBound": False}, "音色试听已生成")

    @app.get("/api/projects/{project_id}/outline")
    async def get_latest_outline(project_id: int, request: Request):
        user = await require_user(request)
        if project_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 projectId"))
        result = await asyncio.to_thread(db.latest_outline, project_id, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        row = result["outline"]
        # 无数据时 message 用 Node success() 默认值 "success"（7.2 对齐，此前误写 "ok"）。
        return success(outline_row(row)) if row else success(None)

    @app.post("/api/projects/{project_id:int}/outline/generate")
    async def generate_project_outline_route(project_id: int, request: Request):
        """生成旧版三幕总纲；新式分集剧本存在时拒绝删除或覆盖。"""
        user = await require_user(request)
        user_id = int(user["id"])
        project = await asyncio.to_thread(db.get_project, project_id, user_id)
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        has_modern_script = await asyncio.to_thread(db.has_modern_outline_script, project_id, user_id)
        if has_modern_script:
            return JSONResponse(
                status_code=409,
                content=failure(4090, "此项目已有分集剧本，旧版总纲重生成已拦截，避免删除剧本与分镜"),
            )
        ai_project = {
            "id": project_id,
            "name": project.get("name"),
            "category": project.get("category"),
            "narrativeVision": project.get("narrative_vision"),
            "visualStyle": project.get("visual_style"),
            "targetDuration": project.get("target_duration"),
        }
        try:
            generated = await ai_generate_outline(ai_project, client=ai_http_client)
        except AiProviderError as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        row = await asyncio.to_thread(db.save_generated_outline, project_id, user_id, generated)
        if row is None:
            return JSONResponse(
                status_code=409,
                content=failure(4090, "此项目已有分集剧本，旧版总纲重生成已拦截，避免删除剧本与分镜"),
            )
        return success(outline_row(row), "总纲已生成")

    @app.get("/api/projects/{project_id}/story-bible")
    async def get_latest_story_bible(project_id: int, request: Request):
        user = await require_user(request)
        if project_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 projectId"))
        result = await asyncio.to_thread(db.latest_story_bible, project_id, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        row = result["item"]
        return success(story_bible_row(row)) if row else success(None)

    @app.get("/api/projects/{project_id}/season-structure")
    async def get_latest_season_structure(project_id: int, request: Request):
        user = await require_user(request)
        if project_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 projectId"))
        result = await asyncio.to_thread(db.latest_season_structure, project_id, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        row = result["item"]
        return success(season_structure_row(row)) if row else success(None)

    @app.get("/api/projects/{project_id}/tasks")
    async def project_tasks(project_id: int, request: Request):
        user = await require_user(request)
        rows = await asyncio.to_thread(db.list_project_task_rows, project_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success(build_project_tasks(project_id, rows, service_settings.public_base_url))

    @app.get("/api/projects/{project_id}/scenes")
    async def list_project_scenes(project_id: int, request: Request):
        user = await require_user(request)
        rows = await asyncio.to_thread(db.list_scenes, project_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success({"items": [scene_row(row) for row in rows]})

    @app.api_route("/api/scenes/{scene_id}", methods=["GET", "PUT"])
    async def get_scene(scene_id: int, request: Request):
        user = await require_user(request)
        row = await asyncio.to_thread(db.get_scene, scene_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        if request.method == "PUT":
            body = await request.json()
            updates: dict[str, Any] = {}
            field_map = {
                "title": "title",
                "summary": "summary",
                "location": "location",
                "timeOfDay": "time_of_day",
            }
            for api_key, column in field_map.items():
                if api_key not in body:
                    continue
                value = body[api_key]
                updates[column] = None if value in (None, "") else str(value)
            if "estimatedDuration" in body:
                try:
                    duration = int(body["estimatedDuration"])
                except (TypeError, ValueError):
                    duration = 0
                if duration > 0:
                    updates["estimated_duration"] = duration
            if not updates:
                # 对齐 Node：body 未携带任何可识别字段时直接返回当前行（message「场景无变更」），
                # 不发空 UPDATE（7.3 前误报「场景已保存」）。
                return success(scene_row(row), "场景无变更")
            updated = await asyncio.to_thread(db.update_scene, scene_id, int(user["id"]), updates)
            if updated is None:
                return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
            return success(scene_row(updated), "场景已保存")
        return success(scene_row(row))

    @app.put("/api/scenes/{scene_id}/script")
    async def save_scene_script(scene_id: int, request: Request):
        user = await require_user(request)
        row = await asyncio.to_thread(db.get_scene, scene_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        body = await request.json()
        content = str(body["content"]) if body.get("content") is not None else row.get("content")
        mood = str(body["mood"]) if body.get("mood") is not None else row.get("mood")
        title = str(body["title"]) if body.get("title") is not None else row.get("title")
        updated = await asyncio.to_thread(
            db.save_scene_script,
            scene_id,
            int(user["id"]),
            content,
            mood,
            title,
        )
        if updated is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        return success(scene_row(updated), "剧本已保存")

    @app.get("/api/scenes/{scene_id}/storyboards")
    async def list_scene_storyboards(scene_id: int, request: Request):
        user = await require_user(request)
        rows = await asyncio.to_thread(db.list_storyboards, scene_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        return success({"items": [storyboard_row(row) for row in rows]})

    @app.api_route("/api/storyboards/{storyboard_id}", methods=["GET", "PUT"])
    async def get_storyboard(storyboard_id: int, request: Request):
        # 第三阶段第三组：GET 单条已原生化（废除 7.3 的固定代理）。frameCharacterContext
        # 由 app/domain/frame_character.py 逐行复刻 Node resolveFrameCharacterContext，
        # 并以 Node 真实实现产出的 fixture（tests/fixtures/frame_character_fixtures.json）
        # 做逐字段对照验收，双实现漂移风险由该测试闭环。
        user = await require_user(request)
        row = await asyncio.to_thread(db.get_storyboard_detail, storyboard_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        if request.method == "GET":
            characters = await asyncio.to_thread(
                db.list_frame_characters, int(row.get("project_id") or 0)
            )
            context = await asyncio.to_thread(resolve_frame_character_context, row, characters)
            return success({**storyboard_row(row), "frameCharacterContext": context})
        # ---- PUT：字段白名单更新 ----
        body = await request.json()
        updates: dict[str, Any] = {}
        field_map = {
            "shotType": "shotType",
            "cameraAngle": "cameraAngle",
            "composition": "composition",
            "characterName": "characterName",
            "actionText": "actionText",
            "dialogueText": "dialogueText",
            "startVisualPrompt": "startVisualPrompt",
            "endVisualPrompt": "endVisualPrompt",
            "imageUrl": "imageUrl",
            "endImageUrl": "endImageUrl",
            "status": "status",
        }
        for api_key, update_key in field_map.items():
            if api_key in body:
                updates[update_key] = body[api_key]
        # 对齐 Node：videoPrompt 与 visualPrompt 写同一列，且 videoPrompt 优先
        # （同时传时 Node 忽略 visualPrompt，7.3 前此处反向优先）。
        if "videoPrompt" in body:
            updates["visualPrompt"] = body["videoPrompt"]
        elif "visualPrompt" in body:
            updates["visualPrompt"] = body["visualPrompt"]
        if "durationSeconds" in body:
            try:
                duration = int(body["durationSeconds"])
            except (TypeError, ValueError):
                duration = 0
            if duration < 1 or duration > 30:
                # 与 Node 的差异：Node 因 normalizeStoryboardDurationSeconds 抛异常被
                # 兜底为 500/5001（校验错误按服务端错误返回），FastAPI 保持正确的 400/4001。
                return JSONResponse(status_code=400, content=failure(4001, "分镜时长必须是有效整数（1-30 秒）"))
            updates["durationSeconds"] = duration
        project_id = int(row.get("project_id") or row.get("projectId") or 0)
        if "characterId" in body:
            character_id = body["characterId"]
            if character_id is not None:
                try:
                    character_id = int(character_id)
                except (TypeError, ValueError):
                    character_id = 0
                if character_id <= 0:
                    return JSONResponse(status_code=400, content=failure(4001, "无效的 characterId"))
                character = await asyncio.to_thread(db.character_in_project, character_id, project_id)
                if character is None:
                    return JSONResponse(status_code=404, content=failure(4004, "角色不存在或不属于当前项目"))
                if "characterName" not in body:
                    updates["characterName"] = character["name"]
            updates["characterId"] = character_id
        elif "characterName" in body:
            # 对齐 Node：仅传 characterName（未传 characterId）时按名称解析同项目角色，
            # characterId 更新为解析结果（未命中置 NULL）；characterName 保持传入值。
            name = str(body["characterName"] or "").strip()
            character = await asyncio.to_thread(db.find_character_by_name, project_id, name) if name else None
            updates["characterId"] = character["id"] if character else None
        direction_edited = any(key in body for key in ("gazePlan", "gaze_plan", "soundPlan", "sound_plan"))
        if direction_edited:
            current_reference = row.get("asset_reference_json") or row.get("assetReference") or {}
            if isinstance(current_reference, str):
                try:
                    current_reference = json.loads(current_reference)
                except (TypeError, ValueError):
                    current_reference = {}
            if not isinstance(current_reference, dict):
                current_reference = {}
            direction = validate_direction({
                **row,
                **body,
                "gazePlan": body.get("gazePlan", body.get("gaze_plan", current_reference.get("gazePlan", current_reference.get("performance", {}).get("gazePlan")))),
                "soundPlan": body.get("soundPlan", body.get("sound_plan", current_reference.get("soundPlan", current_reference.get("performance", {}).get("soundPlan")))),
            })
            if not direction["passed"]:
                return JSONResponse(status_code=422, content=failure(4001, f"视线/声音执行计划未通过校验：{'；'.join(direction['blockers'])}"))
            updates["assetReference"] = json.dumps({
                **current_reference,
                "gazePlan": direction["gaze"],
                "soundPlan": direction["sound"],
                "performance": {
                    **(current_reference.get("performance") or {}),
                    "gazePlan": direction["gaze"],
                    "soundPlan": direction["sound"],
                },
            }, ensure_ascii=False)
        updated = await asyncio.to_thread(db.update_storyboard, storyboard_id, int(user["id"]), updates)
        if updated is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        return success(storyboard_row(updated), "分镜已保存")

    # ------------------------------------------------------------------
    # 剧本/分镜组 generate 端点（第三阶段第三组 · 任务 C）。
    # 形态判定（与 Node 逐条对照）：全部为「同步 AI 调用」（HTTP 请求-响应内完成，
    # 不写 generation_jobs、不走 agent-pipeline），除静帧入队为「任务入队」形态。
    # 文本模型调用经 ai_http_client（async）发起，不阻塞事件循环、不落线程池；
    # mock 模式（AI_PROVIDER=mock 默认）与 Node 一致地走本地兜底或抛错。
    # ------------------------------------------------------------------

    @app.post("/api/scenes/{scene_id}/script/generate")
    async def generate_scene_script_route(scene_id: int, request: Request):
        """单场景剧本生成（对齐 Node L15548）。

        形态 (b) 同步 AI：mock 模式走确定性 mock 生成器（Node 同）；真实模式失败且
        fallbackToMock=true 回退 mock。错误形态：场景缺失 404/4004；AI 链路未捕获
        异常 → 500/5001（Node 全局 catch 形态）。

        :param scene_id: 场景 id。
        :param request: 当前请求。
        :returns: 成功 200 + sceneRow，message「剧本已生成」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        scene = await asyncio.to_thread(db.get_scene_with_project, scene_id, int(user["id"]))
        if scene is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        project_id = int(scene.get("project_id") or 0)
        bible_row = await asyncio.to_thread(db.latest_story_bible_row, project_id)
        season_row = await asyncio.to_thread(db.latest_season_structure_row, project_id)
        outline_row = await asyncio.to_thread(db.latest_outline_row, project_id)
        context = {
            "scene": scene,
            "outline": {**outline_row, "title": outline_row.get("title")} if outline_row else None,
            "storyBible": story_bible_row(bible_row) if bible_row else None,
            "seasonStructure": season_structure_row(season_row) if season_row else None,
            "project": {
                "name": scene.get("projectName"),
                "category": scene.get("category"),
                "visualStyle": scene.get("visual_style"),
                "narrativeVision": scene.get("narrative_vision"),
            },
        }
        ai_script = await ai_generate_scene_script(context, client=ai_http_client)
        fields = {
            "title": ai_script.get("title"),
            "summary": ai_script.get("summary"),
            "content": ai_script.get("content"),
            "mood": ai_script.get("mood"),
            "location": ai_script.get("location"),
            "time_of_day": ai_script.get("time_of_day"),
            "estimated_duration": ai_script.get("estimated_duration"),
        }
        row = await asyncio.to_thread(db.save_generated_scene_script, scene_id, fields)
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        return success(scene_row(row), "剧本已生成")

    @app.post("/api/scenes/{scene_id}/storyboards/generate")
    async def generate_scene_storyboards_route(scene_id: int, request: Request):
        """单场分镜生成（对齐 Node L15713）。

        形态 (b) 同步 AI：RAG 检索（不可达时降级，Node 同款 degraded 分支）→
        mock/真实模型 → 时长契约校验 → 资产门禁 → 事务替换整场分镜。错误形态：
        场景缺失 404/4004；空剧本 400/4004（Node 复用 4004 + HTTP 400）；时长规划
        无效 / 资产门禁失败 → 500/5001（Node 无路由 try/catch，全局 catch 形态）。

        :param scene_id: 场景 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{items: storyboardRow[]}``，message「分镜已生成」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        scene = await asyncio.to_thread(db.get_scene_with_project, scene_id, int(user["id"]))
        if scene is None:
            return JSONResponse(status_code=404, content=failure(4004, "场景不存在或无权访问"))
        if not scene.get("content") or not str(scene.get("content") or "").strip():
            return JSONResponse(
                status_code=400,
                content=failure(4004, "场景没有剧本内容，请先在单场剧本模块生成或编辑剧本"),
            )
        project_id = int(scene.get("project_id") or 0)
        outline_row = await asyncio.to_thread(db.latest_outline_row, project_id)
        project_characters = await asyncio.to_thread(db.list_project_characters_with_assets, project_id)
        scene_text = "\n".join(
            str(part) for part in (scene.get("title"), scene.get("summary"), scene.get("content")) if part
        )
        # 分镜 Agent 只能看到本场正文明确出现的角色（Node 同款过滤，L15743）。
        scene_characters = [
            character for character in project_characters if str(character.get("name") or "").strip() in scene_text
        ]
        strict_asset_rows = await asyncio.to_thread(db.list_storyboard_asset_rows, project_id)
        asset_catalog = build_storyboard_asset_catalog(strict_asset_rows, scene_id)
        # RAG：Node 走 rag-service，不可达时 degraded 降级（空上下文继续生成）。
        rag_context: list[dict[str, Any]] = []
        ai_result = await ai_generate_storyboards(
            {
                "sceneId": scene_id,
                "scene": scene,
                "scriptContent": scene.get("content"),
                "outline": (
                    {
                        **outline_row,
                        "title": outline_row.get("title"),
                        "premise": outline_row.get("premise"),
                    }
                    if outline_row
                    else None
                ),
                "project": {
                    "name": scene.get("projectName"),
                    "visualStyle": scene.get("visual_style"),
                    "category": scene.get("category"),
                    "narrativeVision": scene.get("narrative_vision"),
                },
                "characters": scene_characters,
                "assetCatalog": asset_catalog,
                "ragContext": rag_context,
            },
            client=ai_http_client,
        )
        duration_contract = validate_storyboard_duration_contracts(
            ai_result["shots"], {"requireVisibleTimeline": True}
        )
        if not duration_contract["passed"]:
            raise StoryboardContractError(
                f"分镜时长规划校验未通过：{'；'.join(duration_contract['blockers'])}"
            )
        transaction_asset_rows = await asyncio.to_thread(
            db.list_storyboard_asset_rows, project_id, include_missing_vision=True
        )
        insert_rows = await asyncio.to_thread(
            _resolve_scene_storyboard_asset_rows,
            ai_result["shots"],
            transaction_asset_rows,
            project_characters,
            scene_id,
            scene.get("content"),
        )
        rows = await asyncio.to_thread(db.replace_scene_storyboards, scene_id, project_id, insert_rows)
        return success({"items": [storyboard_row(row) for row in rows]}, "分镜已生成")

    @app.post("/api/projects/{project_id}/story-bible/generate")
    async def generate_story_bible_route(project_id: int, request: Request):
        """故事设定生成（对齐 Node L13127）。

        形态 (b) 同步 AI（两段式调用，刻意不回退 mock——Node 同）：mock 模式直接
        502/5020（不编造设定）。错误：项目缺失 404/4004；空创意 400/4001；
        生成失败 502/5020（error.message 透传）。

        :param project_id: 项目 id。
        :param request: 当前请求（body 含 idea / episodeCount）。
        :returns: 成功 200 + ``{item: storyBibleRow, report}``，message「故事设定已生成」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        idea = str(body.get("idea") or "").strip()
        if not idea:
            return JSONResponse(status_code=400, content=failure(4001, "请先写下你的创意，再生成故事设定"))
        episode_count = max(1, min(50, _parse_id_value(body.get("episodeCount")) or 1))
        try:
            generated = await ai_generate_story_bible(
                project, {"idea": idea, "episodeCount": episode_count}, client=ai_http_client
            )
        except (AiProviderError, ValueError) as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        bible = normalize_story_bible_input(generated)
        report = evaluate_story_bible(bible)
        row = await asyncio.to_thread(
            db.persist_story_bible, project_id, story_bible_db_values(bible, report, locked=False)
        )
        return success({"item": story_bible_row(row), "report": report}, "故事设定已生成")

    @app.post("/api/projects/{project_id}/season-structure/generate")
    async def generate_season_structure_route(project_id: int, request: Request):
        """分集大纲生成（对齐 Node L13148）。

        形态 (b) 同步 AI：mock 直接 502/5020。错误：项目缺失 404/4004；无故事设定
        400/4001「请先生成并保存故事设定」；生成失败 502/5020。

        :param project_id: 项目 id。
        :param request: 当前请求（body 含 episodeCount）。
        :returns: 成功 200 + ``{item: seasonStructureRow, report}``，message「分集大纲已生成」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        bible_row = await asyncio.to_thread(db.latest_story_bible_row, project_id)
        if bible_row is None:
            return JSONResponse(status_code=400, content=failure(4001, "请先生成并保存故事设定"))
        episode_count = max(1, min(50, _parse_id_value(body.get("episodeCount")) or 1))
        try:
            generated = await ai_generate_season_structure(
                project,
                story_bible_row(bible_row),
                {"episodeCount": episode_count},
                client=ai_http_client,
            )
        except (AiProviderError, ValueError) as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        season = normalize_season_structure_input(generated)
        report = evaluate_season_structure(season)
        row = await asyncio.to_thread(
            db.persist_season_structure,
            project_id,
            int(bible_row["id"]),
            season_structure_db_values(season, report, locked=False),
        )
        return success({"item": season_structure_row(row), "report": report}, "分集大纲已生成")

    @app.post("/api/storyboards/{storyboard_id}/keyframes/optimize")
    async def optimize_storyboard_keyframes_route(storyboard_id: int, request: Request):
        """两帧提示词优化（对齐 Node L16265）。

        形态 (b) 同步 AI：AI 失败/mock 时走本地兜底规则（Node 内部 fallback 同款），
        不抛给调用方。错误：storyboardId 无效 400/4001；分镜缺失 404/4004；
        兜底外异常 4011（statusCode 400，Node 路由 catch 形态）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{storyboard, startVisualPrompt, endVisualPrompt, notes}``。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        context = await asyncio.to_thread(db.load_storyboard_director_context, storyboard_id, int(user["id"]))
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        payload: dict[str, Any] | None = None
        try:
            result = await generate_structured_json(
                task="storyboard-keyframe-prompts",
                system_prompt="\n".join(
                    [
                        "你是 AI 漫剧导演和分镜提示词设计师。",
                        "你的任务是把用户写的动作，改写成起始帧和结束帧两条中文视觉提示词。",
                        "必须保持同一角色外貌、服装、年龄感、发型、道具、场景、光线、镜头语言连续。",
                        "不要输出英文，不要输出 Markdown，只返回 JSON。",
                    ]
                ),
                user_prompt=json.dumps(
                    {
                        "输出格式": {
                            "startVisualPrompt": "中文起始帧提示词",
                            "endVisualPrompt": "中文结束帧提示词",
                            "notes": "给用户看的简短中文说明",
                        },
                        "项目": context["project"],
                        "场景": context["scene"],
                        "分镜": {
                            "shotNo": context["storyboard"].get("shot_no"),
                            "shotType": context["storyboard"].get("shot_type"),
                            "cameraAngle": context["storyboard"].get("camera_angle"),
                            "composition": context["storyboard"].get("composition"),
                            "durationSeconds": context["storyboard"].get("duration_seconds"),
                            "actionText": context["storyboard"].get("action_text"),
                            "dialogueText": context["storyboard"].get("dialogue_text"),
                            "visualPrompt": context["storyboard"].get("visual_prompt"),
                        },
                        "角色": context["characters"],
                        "要求": [
                            "起始帧描述动作开始前一瞬间，写清人物姿态、站位、表情、视线、道具和构图。",
                            "结束帧描述动作完成后一瞬间，写清动作结果、重心变化、情绪变化和空间关系。",
                            "两帧必须像同一段视频的首尾帧，不能换人、不能换服装、不能换场景。",
                            "如果动作过长，不要在这里拆镜头，只把首尾状态写清。",
                        ],
                    },
                    ensure_ascii=False,
                ),
                client=ai_http_client,
            )
            payload = result["json"] if isinstance(result["json"], dict) else {}
        except AiProviderError:
            payload = simple_keyframe_prompt_fallback(context)
        fallback = simple_keyframe_prompt_fallback(context)
        start_prompt = str((payload or {}).get("startVisualPrompt") or fallback["startVisualPrompt"]).strip()
        end_prompt = str((payload or {}).get("endVisualPrompt") or fallback["endVisualPrompt"]).strip()
        notes = str((payload or {}).get("notes") or fallback["notes"] or "").strip()
        row = await asyncio.to_thread(db.update_storyboard_keyframes, storyboard_id, start_prompt, end_prompt)
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        return success(
            {
                "storyboard": storyboard_row(row),
                "startVisualPrompt": start_prompt,
                "endVisualPrompt": end_prompt,
                "notes": notes,
            },
            "两帧提示词已优化",
        )

    @app.post("/api/storyboards/{storyboard_id}/continuity/start-frame")
    async def copy_previous_frame_route(storyboard_id: int, request: Request):
        """承接上一镜头（对齐 Node L16287 / copyPreviousFrameToStoryboard）。

        形态：纯 DB 事务（无 AI 调用）。错误：id 无效 400/4001；分镜缺失 404/4004；
        上一镜无确认画面 409/4011；其余异常 4011（Node 路由 catch 形态）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{storyboard, image, sourceStoryboardId, sourceShotNo}``，
            message「已承接上一镜头」。
        :raises Exception: DB 故障 rollback 后由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        result = await asyncio.to_thread(db.copy_previous_frame, storyboard_id, int(user["id"]))
        if result["outcome"] == "no_shot":
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        if result["outcome"] == "no_source":
            return JSONResponse(status_code=409, content=failure(4011, "上一镜头还没有已确认画面，无法承接"))
        return success(
            {
                "storyboard": storyboard_row(result["storyboard"]),
                "image": image_asset_row(result["image"]),
                "sourceStoryboardId": result["sourceStoryboardId"],
                "sourceShotNo": result["sourceShotNo"],
            },
            "已承接上一镜头",
        )

    @app.post("/api/storyboards/{storyboard_id}/split")
    async def split_storyboard_route(storyboard_id: int, request: Request):
        """拆分子分镜（对齐 Node L16309 / splitStoryboardIntoSubShots）。

        形态 (b) 同步 AI（AI 失败/mock 走两段子分镜兜底）：素材门禁 409/4011、
        不适合拆分 409/4011、其余异常 4011（Node 路由 catch 形态）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{items, current, createdCount}``，message「子分镜已拆分」。
        :raises Exception: DB 故障 rollback 后由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        context = await asyncio.to_thread(db.load_storyboard_director_context, storyboard_id, int(user["id"]))
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        counts = await asyncio.to_thread(db.count_storyboard_generated_assets, storyboard_id)
        gate_error = _storyboard_asset_gate_blocker(counts, allow_continuity_start_image=True)
        if gate_error:
            return JSONResponse(status_code=409, content=failure(4011, gate_error))
        raw_sub_shots = None
        try:
            result = await generate_structured_json(
                task="storyboard-split-subshots",
                system_prompt="\n".join(
                    [
                        "你是 AI 漫剧分镜导演。",
                        "请把一个长动作拆成 2 到 4 个更短、更稳定、更省钱的子分镜。",
                        "输出必须是中文 JSON，不要 Markdown，不要英文。",
                    ]
                ),
                user_prompt=json.dumps(
                    {
                        "输出格式": {
                            "subShots": [
                                {
                                    "shotType": "景别", "cameraAngle": "机位", "composition": "构图",
                                    "durationSeconds": 4, "actionText": "动作描述",
                                    "dialogueText": "对白，可为空", "visualPrompt": "视觉提示词",
                                    "startVisualPrompt": "起始帧提示词", "endVisualPrompt": "结束帧提示词",
                                }
                            ]
                        },
                        "项目": context["project"],
                        "场景": context["scene"],
                        "分镜": context["storyboard"],
                        "角色": context["characters"],
                        "要求": [
                            "每个子分镜只保留一个清晰动作，不要把走路、转身、拿东西、表情变化全塞到同一镜头。",
                            "对白优先放在最适合说话的子分镜，不需要每个子分镜都有对白。",
                            "子分镜之间必须能顺滑承接，角色外貌、服装、场景和光线连续。",
                            "每条 visualPrompt、startVisualPrompt、endVisualPrompt 都要用中文写完整。",
                        ],
                    },
                    ensure_ascii=False,
                ),
                client=ai_http_client,
            )
            raw_sub_shots = (result["json"] or {}).get("subShots")
        except AiProviderError:
            raw_sub_shots = None
        sub_shots = normalize_sub_shots(raw_sub_shots, context)
        if len(sub_shots) < 2:
            return JSONResponse(status_code=409, content=failure(4011, "当前动作不适合继续拆分，建议直接使用两帧模式生成。"))
        shot = context["storyboard"]
        original_reference = shot.get("asset_reference_json") or shot.get("assetReference") or None
        first_reference = build_sub_shot_direction_reference(original_reference, shot, sub_shots[0])
        first_update = {
            "shot_type": sub_shots[0]["shotType"],
            "camera_angle": sub_shots[0]["cameraAngle"],
            "composition": sub_shots[0]["composition"],
            "duration_seconds": sub_shots[0]["durationSeconds"],
            "action_text": sub_shots[0]["actionText"],
            "dialogue_text": sub_shots[0]["dialogueText"],
            "visual_prompt": sub_shots[0]["visualPrompt"],
            "start_visual_prompt": sub_shots[0]["startVisualPrompt"],
            "end_visual_prompt": sub_shots[0]["endVisualPrompt"],
            "asset_reference_json": json.dumps(first_reference, ensure_ascii=False),
            "image_url": shot.get("image_url") or None,
        }
        base_shot_no = str(shot.get("shot_no") or "S")[:5]
        extra_rows = []
        for index in range(1, len(sub_shots)):
            item = sub_shots[index]
            item_reference = build_sub_shot_direction_reference(original_reference, shot, item)
            extra_rows.append(
                {
                    "shot_no": f"{base_shot_no}-{index + 1}"[:8],
                    "shot_type": item["shotType"],
                    "camera_angle": item["cameraAngle"],
                    "composition": item["composition"],
                    "duration_seconds": item["durationSeconds"],
                    "character_id": shot.get("character_id") or None,
                    "character_name": shot.get("character_name") or None,
                    "action_text": item["actionText"],
                    "dialogue_text": item["dialogueText"],
                    "visual_prompt": item["visualPrompt"],
                    "start_visual_prompt": item["startVisualPrompt"],
                    "end_visual_prompt": item["endVisualPrompt"],
                    "asset_reference_json": json.dumps(item_reference, ensure_ascii=False),
                    "sort_order": int(shot.get("sort_order") or 0) + index,
                }
            )
        await asyncio.to_thread(
            db.split_storyboard_in_place,
            storyboard_id=storyboard_id,
            scene_id=int(shot["scene_id"]),
            sort_order=int(shot.get("sort_order") or 0),
            first_update=first_update,
            extra_rows=extra_rows,
            override_first_character=False,
        )
        rows = await asyncio.to_thread(db.list_scene_storyboard_rows, int(shot["scene_id"]))
        current_row = next((row for row in rows if int(row["id"]) == int(storyboard_id)), None)
        return success(
            {
                "items": [storyboard_row(row) for row in rows],
                "current": storyboard_row(current_row) if current_row else None,
                "createdCount": len(sub_shots),
            },
            "子分镜已拆分",
        )

    @app.post("/api/storyboards/{storyboard_id}/dialogue/split")
    async def split_dialogue_route(storyboard_id: int, request: Request):
        """多人对白拆分（对齐 Node L16331 / splitStoryboardDialogueTurns）。

        形态 (b) 同步 AI（AI 失败/mock 走本地轮次兜底）：素材门禁 409/4011、说话行
        不足/单说话人/拆分失败 409/4011（Node 路由 catch 形态）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{items, current, createdCount, speakers}``，
            message「多人对白已拆分为可做口型的短分镜」。
        :raises Exception: DB 故障 rollback 后由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        context = await asyncio.to_thread(db.load_storyboard_director_context, storyboard_id, int(user["id"]))
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        counts = await asyncio.to_thread(db.count_storyboard_generated_assets, storyboard_id)
        gate_error = _storyboard_asset_gate_blocker(counts, allow_continuity_start_image=True)
        if gate_error:
            return JSONResponse(status_code=409, content=failure(4011, gate_error))
        fallback_turns = fallback_dialogue_sub_shots(context)
        if len(fallback_turns) < 2:
            return JSONResponse(
                status_code=409,
                content=failure(
                    4011,
                    "当前对白没有识别到两个以上已存在角色的说话行。请用“角色名：对白”格式填写，例如“温叙：我听见了”。",
                ),
            )
        if len({item["characterId"] for item in fallback_turns}) < 2:
            return JSONResponse(status_code=409, content=failure(4011, "当前对白只识别到一个说话角色，不需要按多人对白拆镜。"))
        raw_sub_shots = None
        try:
            result = await generate_structured_json(
                task="storyboard-dialogue-turn-split",
                system_prompt="\n".join(
                    [
                        "你是 AI 漫剧对话分镜导演。",
                        "请把多人对白拆成短分镜，每个分镜只能有一个当前说话角色。",
                        "输出必须是中文 JSON，不要 Markdown，不要英文。",
                    ]
                ),
                user_prompt=json.dumps(
                    {
                        "输出格式": {
                            "subShots": [
                                {
                                    "speakerName": "必须匹配角色列表里的中文角色名",
                                    "shotType": "景别", "cameraAngle": "机位", "composition": "构图",
                                    "durationSeconds": 4,
                                    "actionText": "当前说话人的动作和其他人的反应",
                                    "dialogueText": "角色名：这一句对白",
                                    "visualPrompt": "画面提示词",
                                    "startVisualPrompt": "起始帧提示词", "endVisualPrompt": "结束帧提示词",
                                }
                            ]
                        },
                        "项目": context["project"],
                        "场景": context["scene"],
                        "原分镜": {
                            "shotNo": context["storyboard"].get("shot_no"),
                            "shotType": context["storyboard"].get("shot_type"),
                            "cameraAngle": context["storyboard"].get("camera_angle"),
                            "composition": context["storyboard"].get("composition"),
                            "durationSeconds": context["storyboard"].get("duration_seconds"),
                            "actionText": context["storyboard"].get("action_text"),
                            "dialogueText": context["storyboard"].get("dialogue_text"),
                            "visualPrompt": context["storyboard"].get("visual_prompt"),
                        },
                        "角色": [
                            {
                                "id": item.get("id"),
                                "name": item.get("name"),
                                "roleTag": item.get("role_tag"),
                                "appearance": item.get("appearance"),
                            }
                            for item in context["characters"]
                        ],
                        "要求": [
                            "每个子分镜只能保留一个当前说话角色，dialogueText 必须只包含这个角色的一句或连续短句。",
                            "speakerName 必须严格使用角色列表里的 name，不能自造角色名。",
                            "多人同框可以保留，但不说话的人只能作为倾听或反应人物，不能张嘴。",
                            "每个子分镜都要绑定适合做口型的景别，优先中近景、近景或过肩镜头。",
                            "保留原场景、角色外貌、服装、光线和空间连续性。",
                        ],
                    },
                    ensure_ascii=False,
                ),
                client=ai_http_client,
            )
            raw_sub_shots = (result["json"] or {}).get("subShots")
        except AiProviderError:
            raw_sub_shots = None
        sub_shots = normalize_dialogue_sub_shots(raw_sub_shots, context)
        if len(sub_shots) < 2:
            return JSONResponse(
                status_code=409,
                content=failure(4011, "多人对白拆镜失败：没有得到可绑定角色的有效子分镜。请检查对白是否使用“角色名：对白”格式。"),
            )
        shot = context["storyboard"]
        original_reference = shot.get("asset_reference_json") or shot.get("assetReference") or None
        first_reference = build_sub_shot_direction_reference(original_reference, shot, sub_shots[0])
        first_update = {
            "shot_type": sub_shots[0]["shotType"],
            "camera_angle": sub_shots[0]["cameraAngle"],
            "composition": sub_shots[0]["composition"],
            "duration_seconds": sub_shots[0]["durationSeconds"],
            "character_id": sub_shots[0]["characterId"],
            "character_name": sub_shots[0]["characterName"],
            "action_text": sub_shots[0]["actionText"],
            "dialogue_text": sub_shots[0]["dialogueText"],
            "visual_prompt": sub_shots[0]["visualPrompt"],
            "start_visual_prompt": sub_shots[0]["startVisualPrompt"],
            "end_visual_prompt": sub_shots[0]["endVisualPrompt"],
            "asset_reference_json": json.dumps(first_reference, ensure_ascii=False),
            "image_url": shot.get("image_url") or None,
        }
        base_shot_no = str(shot.get("shot_no") or "S")[:5]
        extra_rows = []
        for index in range(1, len(sub_shots)):
            item = sub_shots[index]
            item_reference = build_sub_shot_direction_reference(original_reference, shot, item)
            extra_rows.append(
                {
                    "shot_no": f"{base_shot_no}-{index + 1}"[:8],
                    "shot_type": item["shotType"],
                    "camera_angle": item["cameraAngle"],
                    "composition": item["composition"],
                    "duration_seconds": item["durationSeconds"],
                    "character_id": item["characterId"],
                    "character_name": item["characterName"],
                    "action_text": item["actionText"],
                    "dialogue_text": item["dialogueText"],
                    "visual_prompt": item["visualPrompt"],
                    "start_visual_prompt": item["startVisualPrompt"],
                    "end_visual_prompt": item["endVisualPrompt"],
                    "asset_reference_json": json.dumps(item_reference, ensure_ascii=False),
                    "sort_order": int(shot.get("sort_order") or 0) + index,
                }
            )
        await asyncio.to_thread(
            db.split_storyboard_in_place,
            storyboard_id=storyboard_id,
            scene_id=int(shot["scene_id"]),
            sort_order=int(shot.get("sort_order") or 0),
            first_update=first_update,
            extra_rows=extra_rows,
            override_first_character=True,
        )
        rows = await asyncio.to_thread(db.list_scene_storyboard_rows, int(shot["scene_id"]))
        current_row = next((row for row in rows if int(row["id"]) == int(storyboard_id)), None)
        speakers = list(dict.fromkeys(item["characterName"] for item in sub_shots if item["characterName"]))
        return success(
            {
                "items": [storyboard_row(row) for row in rows],
                "current": storyboard_row(current_row) if current_row else None,
                "createdCount": len(sub_shots),
                "speakers": speakers,
            },
            "多人对白已拆分为可做口型的短分镜",
        )

    @app.post("/api/storyboards/{storyboard_id}/frame-prompt/rewrite")
    async def rewrite_frame_prompt_route(storyboard_id: int, request: Request):
        """静帧视觉提示词重写（对齐 Node L16070）。

        形态 (b) 同步 AI：mock/真实失败走本地兜底（Node 内部 fallback 同款）。
        只读编排：不落库，响应附带最新 frameCharacterContext。错误：id 无效
        400/4001；分镜缺失 404/4004。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + ``{visualPrompt, notes, frameCharacterContext}``，
            message「视觉提示词已重写」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        context = await asyncio.to_thread(db.load_frame_rewrite_context, storyboard_id, int(user["id"]))
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        context["frameCharacterContext"] = await asyncio.to_thread(
            resolve_frame_character_context, context["storyboard"], context["characters"]
        )
        result = await ai_rewrite_frame_visual_prompt(context, client=ai_http_client)
        return success(
            {
                "visualPrompt": result["visualPrompt"],
                "notes": result.get("notes") or "",
                "frameCharacterContext": context["frameCharacterContext"],
            },
            "视觉提示词已重写",
        )

    @app.post("/api/shots/{shot_id}/images/generate")
    async def enqueue_frame_image_route(shot_id: int, request: Request):
        """静帧生成任务入队（对齐 Node L16410，形态 (a) 任务入队）。

        权限与角色一致性校验通过后把完整请求快照写进 generation_jobs
        （frame_image，Worker 消费），不在请求线程内做付费调用。幂等：同
        project+job_type+source_id 的 queued/running 活动任务直接复用（Node
        createGenerationJob 同款）。错误：shotId 无效 400/4001；分镜缺失 404/4004；
        资产门禁/frameCharacterContext 未就绪/参考图通道不支持 → 409/4011。

        :param shot_id: 分镜 id。
        :param request: 当前请求（body 含 frameRole/prompt/negativePrompt/
            candidateCount/modelName，全部可缺省）。
        :returns: 成功 200 + generationJobRow，message「静帧生成任务已提交」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if shot_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 shotId"))
        try:
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}
        shot = await asyncio.to_thread(db.get_shot_for_frame_job, shot_id, int(user["id"]))
        if shot is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        # Node 把 enqueueFrameImageJob 的全部业务抛错包成 4011 + error.statusCode（默认 400）；
        # Python 侧等价捕获受控异常转 409/4011，DB 故障继续走全局 500/5001 脱敏。
        try:
            job = await _build_frame_image_job(db, shot, shot_id, body)
        except StoryboardGateError as exc:
            return JSONResponse(status_code=409, content=failure(4011, exc.message))
        return success(generation_job_row(job), "静帧生成任务已提交")

    @app.post("/api/project-assets/{asset_type}/{asset_id}/archive")
    async def archive_project_asset(asset_type: str, asset_id: int, request: Request):
        user = await require_user(request)
        # 对齐 Node URL 正则的大小写敏感语义：类型须精确为小写四类之一，
        # 其余（含大写/未知类型）视作未匹配路由 → 404/4040（7.2 前误返回 400/4001）。
        if asset_type not in PROJECT_ASSET_TYPES:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        if asset_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的项目资产参数"))

        # The database adapter performs ownership, status protection and the update atomically.
        asset = await asyncio.to_thread(db.archive_project_asset, asset_type, asset_id, int(user["id"]))
        if asset is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目资产不存在或无权访问"))
        status = str(asset.get("previous_status") or "").strip().lower()
        if status == "archived":
            return JSONResponse(status_code=400, content=failure(4001, "项目资产已经归档"))
        if status in PROTECTED_ASSET_STATUSES:
            message = {
                "confirmed": "已确认或定稿资产不能直接归档",
                "finalized": "已确认或定稿资产不能直接归档",
                "done": "已完成资产不允许直接归档",
            }[status]
            return JSONResponse(status_code=400, content=failure(4001, message))
        return success({"id": asset_id, "assetType": asset_type, "status": "archived"}, "项目资产已归档")

    @app.get("/api/generation-jobs/{job_id}")
    async def get_generation_job(job_id: int, request: Request):
        user = await require_user(request)
        row = await asyncio.to_thread(db.get_generation_job, job_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "生成任务不存在或无权访问"))
        return success(generation_job_row(row))

    @app.post("/api/videos/{video_id}/subtitles/remove")
    async def enqueue_subtitle_cleanup(video_id: int, request: Request):
        user = await require_user(request)
        if video_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 videoId"))
        row = await asyncio.to_thread(db.enqueue_subtitle_cleanup, video_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "视频不存在或无权访问"))
        return success(generation_job_row(row), "字幕清理任务已加入后台队列")

    def _enqueue_error_response(exc: VideoEnqueueError, *, with_quality_report: bool) -> JSONResponse:
        """把入队受控异常转成 Node 同形 4011 envelope。

        Node：``fail(res, 4011, message, error?.statusCode || 400, qualityReport ? {qualityReport} : undefined)``；
        仅视频入队在 data 里附带 qualityReport，口型入队不带 data。

        :param exc: 入队受控异常。
        :param with_quality_report: 是否在 data 附带 qualityReport（视频入队 True）。
        :returns: JSONResponse（4011 envelope）。
        """
        payload = failure(4011, exc.message)
        if with_quality_report and exc.quality_report is not None:
            payload["data"] = {"qualityReport": exc.quality_report}
        return JSONResponse(status_code=exc.status_code, content=payload)

    @app.post("/api/storyboards/{storyboard_id}/videos/generate")
    async def enqueue_storyboard_video_route(storyboard_id: int, request: Request):
        """分镜视频生成任务入队（对齐 Node L16629 / L16667，形态 (a) 任务入队）。

        权限与十道门禁通过后把完整请求快照写进 generation_jobs（video_image，
        Node Worker 消费），不在请求线程内做付费调用。幂等：同 project+job_type+
        source_id 的 queued/running 活动任务直接复用（Node createGenerationJob 同款，
        video_image 无 viewType/viewKey 维度）。错误：storyboardId 非法 400/4001；
        分镜缺失 404/4004；门禁失败 4011 + statusCode（400/409，409 附 qualityReport）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求。
        :returns: 成功 200 + generationJobRow，message「视频生成任务已加入后台队列」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        try:
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}
        shot = await asyncio.to_thread(db.get_shot_for_video_job, storyboard_id, int(user["id"]))
        if shot is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        try:
            job = await _build_storyboard_video_job(
                db,
                shot,
                storyboard_id,
                int(user["id"]),
                body,
                resolve_object_url=resolve_object_url,
                public_base_url=service_settings.public_base_url,
            )
        except VideoEnqueueError as exc:
            return _enqueue_error_response(exc, with_quality_report=True)
        await asyncio.to_thread(db.supersede_storyboard_video_candidates, storyboard_id)
        return success(generation_job_row(job), "视频生成任务已加入后台队列")

    @app.post("/api/storyboards/{storyboard_id}/lip-sync/generate")
    async def enqueue_storyboard_lip_sync_route(storyboard_id: int, request: Request):
        """口型同步任务入队（对齐 Node L16631 / L16634，形态 (a) 任务入队）。

        权限与门禁（说话角色 / 已确认对白音频 / 说话人归属 / 静帧或源视频）通过后把
        请求快照写进 generation_jobs（lip_sync，Node Worker 消费）。幂等语义同
        createGenerationJob（同 project+type+source 活动任务复用）。错误：storyboardId
        非法 400/4001；分镜缺失 404/4004；门禁失败 4011 + 409（无 qualityReport data）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求（prompt/cropFilter/autoConfirm/providerTaskId 均可缺省）。
        :returns: 成功 200 + generationJobRow，message「口型同步任务已加入后台队列」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        try:
            body = await request.json()
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}
        shot = await asyncio.to_thread(db.get_shot_for_lip_sync_job, storyboard_id, int(user["id"]))
        if shot is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        try:
            job = await _build_lip_sync_job(
                db,
                shot,
                storyboard_id,
                body,
                resolve_object_url=resolve_object_url,
            )
        except VideoEnqueueError as exc:
            return _enqueue_error_response(exc, with_quality_report=False)
        return success(generation_job_row(job), "口型同步任务已加入后台队列")

    @app.post("/api/videos/{video_id}/confirm")
    async def confirm_video_asset_route(video_id: int, request: Request):
        """最终视频确认（对齐 Node L16880，状态写路由）。

        归属校验 → 地址规范化回写 → 确认来源解析（storage_key 签名 URL / 本地文件 /
        远端临时链接）→ 事务：归档同镜旧确认、置 confirmed、回写分镜 video_url、
        质量报告标注 accepted_by_user。错误：videoId 非法 400/4001；视频缺失 404/4004；
        签名失败 409/4093；本地文件丢失 409/4091；远端旧链接 409/4092（有意收紧：
        FastAPI 网关不复制 persistGeneratedVideo 的下载/转存/抽帧链路）。

        :param video_id: 视频 id。
        :param request: 当前请求。
        :returns: 成功 200 + videoAsset DTO，message「最终视频已确认」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if video_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 videoId"))
        video = await asyncio.to_thread(db.get_video_for_confirm, video_id, int(user["id"]))
        if video is None:
            return JSONResponse(status_code=404, content=failure(4004, "视频不存在或无权访问"))
        confirmed_url = _normalize_generated_media_url(video.get("video_url"), service_settings.public_base_url)
        if confirmed_url != video.get("video_url"):
            await asyncio.to_thread(db.touch_video_url, video_id, confirmed_url)
        existing_local_path = _local_generated_path_from_url(confirmed_url, service_settings)
        try:
            confirmation = _resolve_video_confirmation_source(
                storage_key=video.get("storage_key"),
                video_url=confirmed_url,
                local_path=existing_local_path,
                create_signed_url=resolve_object_url,
            )
        except Exception:
            return JSONResponse(
                status_code=409,
                content=failure(4093, "视频已存入对象存储，但播放链接刷新失败；请稍后重试确认"),
            )
        confirmed_url = confirmation["videoUrl"]
        if existing_local_path:
            if not await asyncio.to_thread(os.path.exists, existing_local_path):
                return JSONResponse(status_code=409, content=failure(4091, "该本地视频文件已丢失，请重新生成后再确认"))
        elif confirmation["shouldPersist"]:
            # 有意收紧差异：Node 会下载远端临时链接并转存对象存储 + ffmpeg 抽尾帧
            # （persistGeneratedVideo，Worker 语义）。FastAPI 网关不复制该链路，
            # 与 Node 持久化失败同文案（409/4092）引导用户改用本地版本或重新生成。
            return JSONResponse(
                status_code=409,
                content=failure(4092, "该旧视频临时链接已过期，无法设为最终版本；请选择本地版本或重新生成"),
            )
        # Node safeJsonParse(quality_report_json, null)：仅合法 JSON 对象参与标注。
        raw_report = video.get("quality_report_json")
        reviewed_report: dict[str, Any] | None = None
        if isinstance(raw_report, str):
            try:
                parsed_report = json.loads(raw_report)
            except (TypeError, ValueError):
                parsed_report = None
            if isinstance(parsed_report, dict):
                reviewed_report = parsed_report
        elif isinstance(raw_report, dict):
            reviewed_report = raw_report
        if reviewed_report is not None:
            reviewed_report["semanticStatus"] = "accepted_by_user"
            reviewed_report["reviewedAt"] = (
                datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            )
        row = await asyncio.to_thread(
            db.confirm_video_asset_txn,
            video_id,
            int(video["storyboard_id"]),
            video.get("video_url"),
            confirmed_url,
            json.dumps(reviewed_report, ensure_ascii=False) if reviewed_report is not None else None,
        )
        return success(
            video_asset_row(row, resolve_storage_url=resolve_object_url, public_base_url=service_settings.public_base_url),
            "最终视频已确认",
        )

    @app.post("/api/audio-assets/{audio_id}/confirm")
    async def confirm_audio_asset(audio_id: int, request: Request):
        user = await require_user(request)
        if audio_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 audioId"))
        row = await asyncio.to_thread(db.confirm_audio_asset, audio_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "音频资产不存在或无权访问"))
        return success(audio_asset_row(row), "音频轨道已确认")

    @app.post("/api/audio-assets/{audio_id}/archive")
    async def archive_audio_asset(audio_id: int, request: Request):
        user = await require_user(request)
        if audio_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 audioId"))
        result = await asyncio.to_thread(db.archive_audio_asset, audio_id, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "音频资产不存在或无权访问"))
        if result["outcome"] == "protected":
            return JSONResponse(status_code=400, content=failure(4001, "已确认主版本不允许直接归档"))
        return success(audio_asset_row(result["audio"]), "音频候选已归档")

    @app.put("/api/audio-assets/{audio_id}")
    async def update_audio_placement(audio_id: int, request: Request):
        user = await require_user(request)
        if audio_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 audioId"))
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        result = await asyncio.to_thread(db.update_audio_placement, audio_id, int(user["id"]), payload)
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "音频资产不存在或无权访问"))
        if result["outcome"] == "storyboard_not_found":
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或不属于当前项目"))
        return success(audio_asset_row(result["audio"]), "音频时间线定位已保存")

    @app.post("/api/images/{image_id}/confirm")
    async def confirm_image_asset(image_id: int, request: Request):
        user = await require_user(request)
        if image_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 imageId"))
        row = await asyncio.to_thread(db.confirm_image_asset, image_id, int(user["id"]))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "静帧不存在或无权访问"))
        return success(image_asset_row(row), "静帧已确认")

    @app.get("/api/shots/{shot_id}/images")
    async def list_shot_images(shot_id: int, request: Request):
        user = await require_user(request)
        if shot_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 shotId"))
        rows = await asyncio.to_thread(db.list_storyboard_images, shot_id, int(user["id"]))
        if rows is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        return success({"items": [image_asset_row(row) for row in rows]})

    @app.post("/api/storyboards/reorder")
    async def reorder_storyboards(request: Request):
        user = await require_user(request)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        orders = payload.get("orders") if isinstance(payload, dict) else None
        if not isinstance(orders, list) or not orders:
            return JSONResponse(status_code=400, content=failure(4001, "缺少排序数据"))
        normalized: list[dict[str, int]] = []
        seen_ids: set[int] = set()
        for item in orders:
            if not isinstance(item, dict):
                return JSONResponse(status_code=400, content=failure(4001, "排序数据无效"))
            try:
                storyboard_id = int(item.get("id"))
                sort_order = int(item.get("sortOrder"))
            except (TypeError, ValueError):
                return JSONResponse(status_code=400, content=failure(4001, "排序数据无效"))
            if (
                isinstance(item.get("id"), bool)
                or isinstance(item.get("sortOrder"), bool)
                or storyboard_id <= 0
                or sort_order < 0
                or sort_order > 4294967295
                or str(item.get("id")).strip() != str(storyboard_id)
                or str(item.get("sortOrder")).strip() != str(sort_order)
                or storyboard_id in seen_ids
            ):
                return JSONResponse(status_code=400, content=failure(4001, "排序数据无效"))
            seen_ids.add(storyboard_id)
            normalized.append({"id": storyboard_id, "sortOrder": sort_order})
        result = await asyncio.to_thread(db.reorder_storyboards, normalized, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        if result["outcome"] == "cross_scene":
            return JSONResponse(status_code=400, content=failure(4001, "排序数据必须属于同一场景"))
        return success({"success": True}, "排序已更新")

    @app.post("/api/project-tasks/{task_key}/{action}")
    async def project_task_action(task_key: str, action: str, request: Request):
        """Apply provider-backed generation actions or persisted mock asset actions.

        :param task_key: Task key with a generation/image/video/audio/export prefix.
        :param action: 动作名（retry/cancel）。
        :param request: 当前请求。
        :return: Updated task center DTO or a compatible error envelope.
        """
        match = re.fullmatch(r"generation-(\d+)", task_key)
        if action not in {"retry", "cancel"}:
            return JSONResponse(
                status_code=404,
                content=failure(4040, "接口不存在"),
            )
        user = await require_user(request)
        if not match:
            mock_match = re.fullmatch(r"(image|video|audio|export)-(\d+)", task_key)
            if not mock_match:
                return JSONResponse(status_code=400, content=failure(4001, "无效的 taskKey"))
            task_type, raw_source_id = mock_match.groups()
            source_id = int(raw_source_id)
            if source_id <= 0:
                return JSONResponse(status_code=400, content=failure(4001, "无效的 taskKey"))
            result = await asyncio.to_thread(db.apply_mock_task_action, task_type, source_id, int(user["id"]), action)
            if result["outcome"] == "not_found":
                return JSONResponse(status_code=404, content=failure(4004, "任务不存在或无权访问"))
            if result["outcome"] == "not_cancelable":
                return JSONResponse(status_code=400, content=failure(4001, "当前任务不处于可取消状态"))
            rows = await asyncio.to_thread(db.list_project_task_rows, int(result["project_id"]), int(user["id"]))
            payload = build_project_tasks(int(result["project_id"]), rows or {}, service_settings.public_base_url)
            task = next((item for item in payload["items"] if item["taskKey"] == task_key), None)
            if task is None:
                return JSONResponse(status_code=404, content=failure(4004, "任务不存在"))
            message = "任务已重新加入队列（Mock）" if action == "retry" else "任务已取消（Mock）"
            return success(task, message)
        job_id = int(match.group(1))
        if action == "cancel":
            job = await asyncio.to_thread(db.get_generation_job, job_id, int(user["id"]))
            if job is None:
                return JSONResponse(status_code=404, content=failure(4004, "任务不存在或无权访问"))
            return JSONResponse(status_code=409, content=failure(4001, "当前供应商请求不支持安全取消，请等待本轮完成"))
        result = await asyncio.to_thread(db.retry_generation_job, job_id, int(user["id"]))
        if result["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "任务不存在或无权访问"))
        if result["outcome"] == "conflict":
            return JSONResponse(status_code=409, content=failure(4001, "只有失败或已取消的生成任务可以重试"))
        job = result["job"]
        job_type = job.get("job_type")
        title = "对白口型同步任务" if job_type == "lip_sync" else "动作视频生成任务" if job_type == "video_image" else "图片生成任务"
        item = {
            "taskKey": f"generation-{job_id}",
            "taskType": "video" if job_type in {"video_image", "lip_sync"} else "image",
            "sourceId": job_id,
            "projectId": int(job["project_id"]),
            "title": title,
            "status": "queued",
            "runtimeStatus": "queued",
            "progressPercent": 0,
            "runtimeMessage": "生成任务已重新加入队列",
            "canRetry": False,
            "canCancel": False,
            "createdAt": job.get("created_at"),
            "updatedAt": job.get("updated_at"),
        }
        return success(item, "生成任务已重新加入队列")

    # ------------------------------------------------------------------
    # 项目/资产组剩余（阶段 3.5）：资产画布 / 角色库 / 项目删除 / 导出包。
    # 第四阶段已删除回退开关，整组恒为原生实现。
    # ------------------------------------------------------------------

    def _asset_node_canvas_payload(project_id: int, settings: Settings) -> dict[str, Any]:
        """画布视图组装（读时自愈链：旧壳归档 → 去重 → 角色/场景提示词刷新 → prop 自动采用）。"""
        nodes = db.list_asset_canvas_nodes(project_id)
        # 兼容旧版解析留下的重复场景节点：无环境提示词且 label 含旧版标记 → 归档旧壳。
        legacy_scene_ids = [
            int(node["id"])
            for node in nodes
            if str(node.get("node_type") or "") == "scene"
            and node.get("ref_id")
            and not str(node.get("environment_prompt_text") or "").strip()
            and re.search(r"场景：|时间未明确", str(node.get("label") or node.get("appearance_label") or ""))
        ]
        if legacy_scene_ids:
            db.archive_asset_nodes(project_id, legacy_scene_ids)
            nodes = [node for node in nodes if int(node["id"]) not in legacy_scene_ids]
        duplicate_plan = build_active_asset_node_dedup_plan(nodes)
        if duplicate_plan["archiveIds"]:
            db.archive_asset_nodes(project_id, duplicate_plan["archiveIds"])
            nodes = [node for node in nodes if int(node["id"]) not in duplicate_plan["archiveIds"]]
        project = db.fetch_project_by_id(project_id) or {}
        scene_rows = db.list_project_scene_rows(project_id, with_anchors=True)
        character_rows = db.list_project_character_rows(project_id)
        # 道具/素材单视角视觉检查通过 → 自动采用（读时自愈）。
        prop_like_node_ids = [
            int(node["id"])
            for node in nodes
            if str(node.get("node_type") or "") in ("prop", "material")
        ]
        for image_id in db.list_passed_single_prop_images(prop_like_node_ids):
            db.commit_asset_adoption_txn([image_id], str(
                next(
                    (
                        node.get("node_type")
                        for node in nodes
                        if any(
                            row.get("asset_node_id") == image_id
                            for row in db.list_asset_node_images(int(node["id"]))
                        )
                    ),
                    "prop",
                )
            ), _asset_node_row_id_of_image(db, image_id), "single")
        # 角色节点提示词过期检测与刷新（Node L13557-L13602 的 stalePrompt/staleTurnaround 规则）。
        for node in [item for item in nodes if str(item.get("node_type") or "") == "character" and item.get("ref_id")]:
            character = next((row for row in character_rows if int(row["id"]) == int(node["ref_id"])), None)
            if character is None:
                continue
            character_scenes = [
                scene
                for scene in scene_rows
                if any(
                    str(character.get("name") or "") in str(scene.get(column) or "")
                    for column in ("title", "summary", "content", "location")
                )
            ]
            from .domain.storyboard_ai import requires_character_face_reference

            generated = build_script_character_prompt(
                character,
                character_scenes,
                project.get("visual_style") or "",
                project.get("category") or "",
            )
            no_face_constraint_required = not requires_character_face_reference(
                character, *[scene.get("content") for scene in character_scenes]
            )
            prompt_text = str(node.get("prompt_text") or "")
            stale_prompt = (
                not prompt_text.strip()
                or "固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理" in prompt_text
                or (no_face_constraint_required and "本角色在剧情中明确不直接露脸" not in prompt_text)
                or is_legacy_character_prompt(prompt_text)
            )
            turnaround_text = str(node.get("turnaround_prompt_text") or "")
            stale_turnaround = not turnaround_text.strip() or (
                no_face_constraint_required and "该角色剧情约束为不直接露脸" not in turnaround_text
            )
            if not stale_prompt and not stale_turnaround:
                continue
            assignments: dict[str, Any] = {}
            if stale_prompt:
                assignments["prompt_text"] = generated["prompt"]
            if stale_turnaround:
                assignments["turnaround_prompt_text"] = generated["turnaroundPrompt"]
            if not str(node.get("negative_prompt") or "").strip():
                assignments["negative_prompt"] = generated["negativePrompt"]
            node = db.update_asset_node_fields(int(node["id"]), assignments) or node
        # 场景节点每次读取都重新绑定并刷新提示词（Agent 提示词升级不滞留旧快照）。
        for node in [item for item in nodes if str(item.get("node_type") or "") == "scene"]:
            matched_scene = find_scene_node_match(node, scene_rows)
            if matched_scene is None:
                continue
            prompt_text = build_script_scene_prompt(
                matched_scene,
                project.get("visual_style") or "",
                project.get("category") or "",
                [row.get("name") for row in character_rows if row.get("name")],
            )
            environment_prompt_text = build_scene_environment_prompt(
                matched_scene,
                project.get("visual_style") or "",
                project.get("category") or "",
                [row.get("name") for row in character_rows if row.get("name")],
            )
            expected_group_key = f"scene:{matched_scene['id']}:default"
            stale_scene_link = int(node.get("ref_id") or 0) != int(matched_scene["id"]) or str(node.get("group_key") or "") != expected_group_key
            refreshed_label = build_scene_display_label(matched_scene)
            refreshed_appearance_label = (
                " · ".join(
                    [value for value in (infer_location_for_label(matched_scene), infer_time_for_label(matched_scene)) if value]
                )
                or None
            )
            label = str(node.get("label") or "")
            assignments = {
                "ref_id": int(matched_scene["id"]),
                "prompt_text": prompt_text,
                "environment_prompt_text": environment_prompt_text,
            }
            if (
                stale_scene_link
                or not label.strip()
                or label == str(matched_scene.get("title") or "")
                or re.search(r"死后三天|场景：", label)
            ):
                assignments["label"] = refreshed_label
            if stale_scene_link:
                assignments["group_key"] = expected_group_key
            appearance_label = str(node.get("appearance_label") or "")
            if not appearance_label.strip() or re.search(r"未明确", appearance_label):
                assignments["appearance_label"] = refreshed_appearance_label
            node = db.update_asset_node_fields(int(node["id"]), assignments) or node
        node_ids = [int(node["id"]) for node in nodes]
        images = [
            _asset_node_image_dto(row, settings) for row in db.list_asset_node_images_by_nodes(node_ids)
        ]
        return build_asset_canvas_view(project_id, nodes=nodes, images=images)

    def infer_location_for_label(scene: dict[str, Any]) -> str:
        """画布场景外观标签的地点段（Node inferSceneLabelLocation 薄包装）。"""
        from .domain.asset_prompts import build_scene_display_label as _label  # noqa: F401

        from .domain.asset_prompts import _infer_scene_label_location

        return _infer_scene_label_location(scene)

    def infer_time_for_label(scene: dict[str, Any]) -> str:
        """画布场景外观标签的时间段（Node inferSceneLabelTime 薄包装）。"""
        from .domain.asset_prompts import _infer_scene_label_time

        return _infer_scene_label_time(scene)

    def _asset_node_row_id_of_image(db: Any, image_id: int) -> int:
        """图片行所属节点 id（读时自愈自动采用用）。"""
        row = db.get_asset_node_image(image_id)
        return int(row.get("asset_node_id") or 0) if row else 0

    @app.get("/api/projects/{project_id}/asset-canvas")
    async def project_asset_canvas(project_id: int, request: Request):
        """资产画布视图（对齐 Node GET /api/projects/{id}/asset-canvas，L13483）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        payload = await asyncio.to_thread(_asset_node_canvas_payload, project_id, service_settings)
        return success(payload)

    @app.post("/api/projects/{project_id}/asset-nodes")
    async def create_asset_node(project_id: int, request: Request):
        """创建画布节点（对齐 Node POST，L13681；character/scene 自动生成提示词）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        node_type = normalize_asset_node_type(body.get("nodeType"))
        if not node_type:
            return JSONResponse(status_code=400, content=failure(4001, "无效的节点类型，只支持 character / scene / prop / material"))
        ref_id: int | None = None
        label = str(body.get("label") or "").strip()
        character: dict[str, Any] | None = None
        scene: dict[str, Any] | None = None
        if node_type == "character" and body.get("refId") is not None:
            character = next(
                (
                    row
                    for row in await asyncio.to_thread(db.list_project_character_rows, project_id)
                    if int(row["id"]) == _parse_id_value(body.get("refId"))
                ),
                None,
            )
            if character is None:
                return JSONResponse(status_code=404, content=failure(4004, "角色不存在或不属于该项目"))
            ref_id = int(character["id"])
            if not label:
                label = str(character.get("name") or "").strip()
        if node_type == "scene" and body.get("refId") is not None:
            scene_rows = await asyncio.to_thread(db.list_project_scene_rows, project_id)
            scene = next((row for row in scene_rows if int(row["id"]) == _parse_id_value(body.get("refId"))), None)
            if scene is None:
                return JSONResponse(status_code=404, content=failure(4004, "关联场景不存在或不属于该项目"))
            ref_id = int(scene["id"])
            if not label:
                label = build_scene_display_label(scene)
        if not label:
            return JSONResponse(status_code=400, content=failure(4001, "请填写节点名称"))
        prompt_text = str(body["promptText"]) if body.get("promptText") is not None else None
        turnaround_prompt_text = str(body["turnaroundPromptText"]) if body.get("turnaroundPromptText") is not None else None
        environment_prompt_text = str(body["environmentPromptText"]) if body.get("environmentPromptText") is not None else None
        negative_prompt = str(body["negativePrompt"]) if body.get("negativePrompt") is not None else None
        if (node_type in ("character", "scene")) and prompt_text is None:
            project_full = await asyncio.to_thread(db.fetch_project_by_id, project_id) or {}
            scene_rows = await asyncio.to_thread(db.list_project_scene_rows, project_id)
            if node_type == "character" and character is not None:
                generated = build_script_character_prompt(
                    character,
                    scene_rows,
                    project_full.get("visual_style") or "",
                    project_full.get("category") or "",
                )
                prompt_text = generated["prompt"]
                if turnaround_prompt_text is None:
                    turnaround_prompt_text = generated["turnaroundPrompt"]
                if negative_prompt is None:
                    negative_prompt = generated["negativePrompt"]
            elif node_type == "scene" and scene is not None:
                prompt_text = build_script_scene_prompt(
                    scene,
                    project_full.get("visual_style") or "",
                    project_full.get("category") or "",
                )
                environment_prompt_text = build_scene_environment_prompt(
                    scene,
                    project_full.get("visual_style") or "",
                    project_full.get("category") or "",
                )
        layout = normalize_asset_node_layout(body)
        group_key = None
        if body.get("groupKey") is not None:
            group_key = normalize_asset_group_key(str(body.get("groupKey")).strip()) or None
        row = await asyncio.to_thread(
            db.create_asset_node,
            project_id,
            {
                "nodeType": node_type,
                "refId": ref_id,
                "label": label,
                "appearanceLabel": (str(body.get("appearanceLabel")).strip() or None)
                if body.get("appearanceLabel") is not None
                else None,
                "promptText": prompt_text,
                "turnaroundPromptText": turnaround_prompt_text,
                "environmentPromptText": environment_prompt_text,
                "negativePrompt": negative_prompt,
                "x": layout["x"],
                "y": layout["y"],
                "width": layout["width"],
                "height": layout["height"],
                "groupKey": group_key,
            },
        )
        node_view = await asyncio.to_thread(_node_canvas_node_response, db, row, service_settings)
        return success(node_view, "画布节点已创建")

    @app.api_route("/api/asset-nodes/{node_id}", methods=["PATCH", "DELETE"])
    async def asset_node_detail(node_id: int, request: Request):
        """画布节点更新/软删（对齐 Node PATCH L13968 / DELETE L14030）。"""
        user = await require_user(request)
        resolved = await asyncio.to_thread(_fetch_asset_node_for_user, db, node_id, int(user["id"]), service_settings)
        if resolved is None:
            return JSONResponse(status_code=404, content=failure(4004, "画布节点不存在或无权访问"))
        node = resolved["node"]
        if request.method == "DELETE":
            await asyncio.to_thread(db.archive_asset_node, node_id)
            return success({"success": True}, "画布节点已移除")
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content=failure(4001, "请求内容无效"))
        assignments: dict[str, Any] = {}
        for key, column in [
            ("label", "label"),
            ("appearanceLabel", "appearance_label"),
            ("promptText", "prompt_text"),
            ("turnaroundPromptText", "turnaround_prompt_text"),
            ("environmentPromptText", "environment_prompt_text"),
            ("negativePrompt", "negative_prompt"),
            ("groupKey", "group_key"),
        ]:
            if key not in body:
                continue
            value = "" if body[key] is None else str(body[key]).strip()
            if key == "label" and not value:
                return JSONResponse(status_code=400, content=failure(4001, "节点名称不能为空"))
            assignments[column] = value if key not in ("appearanceLabel", "groupKey") else (value or None)
        if any(body.get(key) is not None for key in ("x", "y", "width", "height")):
            layout = normalize_asset_node_layout(
                {
                    "x": body.get("x") if body.get("x") is not None else node.get("x"),
                    "y": body.get("y") if body.get("y") is not None else node.get("y"),
                    "width": body.get("width") if body.get("width") is not None else node.get("width"),
                    "height": body.get("height") if body.get("height") is not None else node.get("height"),
                }
            )
            assignments.update(
                {"x": layout["x"], "y": layout["y"], "width": layout["width"], "height": layout["height"]}
            )
        if not assignments:
            return JSONResponse(status_code=400, content=failure(4001, "没有可更新的字段"))
        row = await asyncio.to_thread(db.update_asset_node_fields, node_id, assignments)
        node_view = await asyncio.to_thread(_node_canvas_node_response, db, row or node, service_settings)
        return success(node_view, "画布节点已更新")

    @app.post("/api/asset-nodes/{node_id}/relink-scene")
    async def asset_node_relink_scene(node_id: int, request: Request):
        """场景节点重新关联剧本场景并刷新提示词（对齐 Node L13806）。"""
        user = await require_user(request)
        resolved = await asyncio.to_thread(_fetch_asset_node_for_user, db, node_id, int(user["id"]), service_settings)
        if resolved is None:
            return JSONResponse(status_code=404, content=failure(4004, "画布节点不存在或无权访问"))
        node = resolved["node"]
        if str(node.get("node_type") or "") != "scene":
            return JSONResponse(status_code=400, content=failure(4001, "只有场景节点可以重新关联剧本场景"))
        body = await request.json()
        scene_rows = await asyncio.to_thread(db.list_project_scene_rows, int(node["project_id"]))
        scene = choose_scene_for_relink(
            body.get("sceneId"),
            body.get("label") or body.get("location"),
            scene_rows,
        )
        if scene is None:
            return JSONResponse(
                status_code=404,
                content=failure(4004, "没有找到可关联的剧本场景，请提供有效 sceneId 或场景名称"),
            )
        project = await asyncio.to_thread(db.fetch_project_by_id, int(node["project_id"])) or {}
        prompt_text = build_script_scene_prompt(
            scene,
            project.get("visual_style") or "",
            project.get("category") or "",
        )
        environment_prompt_text = build_scene_environment_prompt(
            scene,
            project.get("visual_style") or "",
            project.get("category") or "",
        )
        row = await asyncio.to_thread(
            db.update_asset_node_fields,
            node_id,
            {
                "ref_id": int(scene["id"]),
                "label": build_scene_display_label(scene),
                "group_key": f"scene:{scene['id']}:default",
                "prompt_text": prompt_text,
                "environment_prompt_text": environment_prompt_text,
                "appearance_label": " · ".join(
                    [value for value in (scene.get("location"), scene.get("time_of_day")) if value]
                ) or None,
            },
        )
        node_view = await asyncio.to_thread(_node_canvas_node_response, db, row or node, service_settings)
        return success(node_view, "场景节点已重新关联并刷新提示词")

    @app.post("/api/asset-nodes/{node_id}/hydrate-prompt")
    async def asset_node_hydrate_prompt(node_id: int, request: Request):
        """场景/角色节点自动补齐提示词（对齐 Node L13879）。"""
        user = await require_user(request)
        resolved = await asyncio.to_thread(_fetch_asset_node_for_user, db, node_id, int(user["id"]), service_settings)
        if resolved is None:
            return JSONResponse(status_code=404, content=failure(4004, "画布节点不存在或无权访问"))
        node = resolved["node"]
        if str(node.get("node_type") or "") not in ("scene", "character") or not node.get("ref_id"):
            return JSONResponse(status_code=400, content=failure(4001, "只有关联剧本场景或角色的节点可以自动补齐提示词"))
        project = await asyncio.to_thread(db.fetch_project_by_id, int(node["project_id"])) or {}
        prompt_text = ""
        environment_prompt_text: str | None = None
        turnaround_prompt_text: str | None = None
        negative_prompt: str | None = None
        if str(node.get("node_type") or "") == "scene":
            scene_rows = await asyncio.to_thread(db.list_project_scene_rows, int(node["project_id"]), with_anchors=True)
            scene = next((row for row in scene_rows if int(row["id"]) == int(node["ref_id"])), None)
            if scene is None:
                return JSONResponse(status_code=404, content=failure(4004, "关联剧本场景不存在"))
            prompt_text = build_script_scene_prompt(
                scene,
                project.get("visual_style") or "",
                project.get("category") or "",
            )
            environment_prompt_text = build_scene_environment_prompt(
                scene,
                project.get("visual_style") or "",
                project.get("category") or "",
            )
        else:
            character_rows = await asyncio.to_thread(db.list_project_character_rows, int(node["project_id"]))
            character = next((row for row in character_rows if int(row["id"]) == int(node["ref_id"])), None)
            if character is None:
                return JSONResponse(status_code=404, content=failure(4004, "关联剧本角色不存在"))
            scene_rows = await asyncio.to_thread(db.list_project_scene_rows, int(node["project_id"]))
            generated = build_script_character_prompt(
                character,
                scene_rows,
                project.get("visual_style") or "",
                project.get("category") or "",
            )
            prompt_text = generated["prompt"]
            turnaround_prompt_text = generated["turnaroundPrompt"]
            negative_prompt = generated["negativePrompt"]
        row = await asyncio.to_thread(
            db.update_asset_node_fields,
            node_id,
            {
                "prompt_text": prompt_text,
                "turnaround_prompt_text": turnaround_prompt_text,
                "environment_prompt_text": environment_prompt_text,
                "negative_prompt": negative_prompt,
            },
        )
        node_view = await asyncio.to_thread(_node_canvas_node_response, db, row or node, service_settings)
        return success(
            node_view,
            f"{'场景' if str(node.get('node_type') or '') == 'scene' else '角色'}详细提示词已补齐并保存",
        )

    @app.get("/api/asset-nodes/{node_id}/images")
    async def asset_node_images(node_id: int, request: Request):
        """画布节点形象列表（对齐 Node GET，L14047）。"""
        user = await require_user(request)
        resolved = await asyncio.to_thread(_fetch_asset_node_for_user, db, node_id, int(user["id"]), service_settings)
        if resolved is None:
            return JSONResponse(status_code=404, content=failure(4004, "画布节点不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_asset_node_images, node_id)
        return success({"items": [_asset_node_image_dto(row, service_settings) for row in rows]})

    @app.post("/api/asset-nodes/{node_id}/images/generate")
    async def asset_node_images_generate(node_id: int, request: Request):
        """画布形象生成入队（对齐 Node POST，L14063：4011 受控错误形态）。"""
        user = await require_user(request)
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        try:
            await _ensure_scene_spatial_anchors_for_node(
                db, int(user["id"]), node_id, ai_http_client, service_settings
            )
            job = await asyncio.to_thread(
                _enqueue_asset_node_image_job, db, int(user["id"]), node_id, body, service_settings
            )
        except LookupError as exc:
            return JSONResponse(status_code=404, content=failure(4004, str(exc)))
        except (AiProviderError, ValueError) as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        except NodeEnqueueError as exc:
            return JSONResponse(status_code=exc.status_code, content=failure(4011, exc.message))
        return success(generation_job_row(job), "画布节点形象生成任务已提交")

    @app.post("/api/asset-node-images/{image_id}/confirm")
    async def asset_node_image_confirm(image_id: int, request: Request):
        """画布形象确认（对齐 Node L14080：多重门禁 + 身份锁 + 同视角 superseded）。"""
        user = await require_user(request)
        image = await asyncio.to_thread(db.get_asset_node_image_full, image_id)
        if (
            image is None
            or int(image.get("ownerId") or 0) != int(user["id"])
            or str(image.get("node_status") or "") == "archived"
        ):
            return JSONResponse(status_code=404, content=failure(4004, "画布节点形象不存在或无权访问"))
        node_type = str(image.get("node_type") or "")
        legacy_character_board = node_type == "character" and is_character_asset_pack_row(image)
        if node_type == "character" and str(image.get("view_set_type") or "") != "character-asset-pack" and not legacy_character_board:
            return JSONResponse(
                status_code=409,
                content=failure(4004, "角色资产板通过整体视觉检查后会自动采用，无需单独确认旧版拆分图片"),
            )
        if str(image.get("status") or "") == "superseded":
            return JSONResponse(status_code=409, content=failure(4004, "该图片已被新资产替代，不能重新检查"))
        if legacy_character_board:
            await asyncio.to_thread(
                db.update_asset_node_image_fields,
                image_id,
                {
                    "view_set_type": "character-asset-pack",
                    "view_key": None,
                    "view_index": None,
                    "view_label": "角色资产板",
                },
            )
            image["view_set_type"] = "character-asset-pack"
            image["view_key"] = None
            image["view_index"] = None
            image["view_label"] = "角色资产板"
        gate_kwargs = {
            "view_type": image.get("view_set_type"),
            "image_status": image.get("status"),
            "vision_status": image.get("vision_status"),
            "image_url": image.get("image_url"),
            "model_name": image.get("model_name"),
        }
        asset_pack_gate = validate_character_asset_pack_confirmation(**gate_kwargs)
        confirmation_gate = validate_character_turnaround_confirmation(
            **{**gate_kwargs, "view_key": image.get("view_key"), "identity_status": image.get("identity_status"), "identity_reason": image.get("identity_reason")}
        )
        face_closeup_gate = validate_character_face_closeup_confirmation(
            **{**gate_kwargs, "view_key": image.get("view_key"), "identity_status": image.get("identity_status"), "identity_reason": image.get("identity_reason")}
        )
        prop_gate = validate_prop_turnaround_confirmation(**{"node_type": node_type, **gate_kwargs, "view_key": image.get("view_key")})
        selected_gate = (
            asset_pack_gate if not asset_pack_gate["ready"]
            else confirmation_gate if not confirmation_gate["ready"]
            else face_closeup_gate if not face_closeup_gate["ready"]
            else prop_gate
        )
        if not selected_gate["ready"]:
            return JSONResponse(status_code=409, content=failure(4004, selected_gate["message"]))
        base_asset_gate = validate_asset_image_confirmation(**{"node_type": node_type, **gate_kwargs})
        if not base_asset_gate["ready"]:
            return JSONResponse(status_code=409, content=failure(4004, base_asset_gate["message"]))
        view_set_type = str(image.get("view_set_type") or "")
        if view_set_type == "scene-nine-grid":
            try:
                crop = json.loads(image["crop_json"]) if isinstance(image.get("crop_json"), str) else image.get("crop_json")
            except (TypeError, ValueError):
                crop = None
            scene_gate = validate_scene_nine_grid_view_confirmation(
                view_key=image.get("view_key")
                or ("front" if node_type == "character" and view_set_type == "single" else None),
                crop=crop if isinstance(crop, dict) else None,
                source_image_id=image.get("source_image_id"),
                image_status=image.get("status"),
                vision_status=image.get("vision_status"),
                image_url=image.get("image_url"),
                model_name=image.get("model_name"),
            )
            if not scene_gate["ready"]:
                return JSONResponse(status_code=409, content=failure(4004, scene_gate["message"]))
        if node_type == "character":
            character_rows = await asyncio.to_thread(
                db.list_project_character_rows, int(image["project_id"])
            )
            character = next(
                (row for row in character_rows if int(row["id"]) == int(image.get("ref_id") or 0)), None
            )
            reference_rows = [
                row for row in await asyncio.to_thread(db.list_asset_node_images, int(image["asset_node_id"]))
                if int(row["id"]) != int(image_id)
            ]
            reference_rows.sort(key=lambda row: int(row["id"]), reverse=True)
            confirmed_image = dict(image)
            confirmed_image["status"] = "confirmed"
            reference_set = resolve_character_reference_set([confirmed_image, *reference_rows])
            identity_snapshot = build_character_identity_lock_snapshot(
                character or {"id": image.get("ref_id"), "name": image.get("label")},
                confirmed_image,
                reference_set,
            )
            await asyncio.to_thread(
                db.save_character_identity_lock,
                int(image["asset_node_id"]),
                image_id,
                json.dumps(identity_snapshot, ensure_ascii=False),
            )
        if view_set_type == "single" and node_type in ("character", "scene"):
            await asyncio.to_thread(db.supersede_confirmed_single_images, int(image["asset_node_id"]), image_id)
            if node_type == "scene":
                await asyncio.to_thread(
                    db.supersede_asset_node_images,
                    node_id=int(image["asset_node_id"]),
                    keep_image_id=image_id,
                    view_set_types=["scene-nine-grid"],
                    source_image_id=int(image_id),
                    exclude_matching_source=True,
                )
        if node_type == "character" and view_set_type == "character-asset-pack":
            await asyncio.to_thread(
                db.supersede_asset_node_images,
                node_id=int(image["asset_node_id"]),
                keep_image_id=image_id,
                view_set_types=["single", "character-asset-pack", "character-face-closeup", "character-turnaround"],
            )
        if view_set_type == "scene-nine-grid":
            await asyncio.to_thread(
                db.supersede_asset_node_images,
                node_id=int(image["asset_node_id"]),
                keep_image_id=image_id,
                view_set_types=["scene-nine-grid"],
                view_key=str(image.get("view_key") or ""),
            )
        if view_set_type in ("character-turnaround", "character-face-closeup", "prop-turnaround"):
            await asyncio.to_thread(
                db.supersede_asset_node_images,
                node_id=int(image["asset_node_id"]),
                keep_image_id=image_id,
                view_set_types=[view_set_type],
                view_key=str(image.get("view_key") or ""),
            )
        updated = await asyncio.to_thread(
            db.update_asset_node_image_fields, image_id, {"status": "confirmed", "confirmed_at": datetime.now(timezone.utc)}
        )
        updated = await asyncio.to_thread(db.get_asset_node_image, image_id)
        return success(_asset_node_image_dto(updated, service_settings), "形象已采用")

    @app.post("/api/asset-node-images/{image_id}/vision-check")
    async def asset_node_image_vision_check(image_id: int, request: Request):
        """视角视觉检查（对齐 Node L14303；场景恒走 skipped 分支）。"""
        user = await require_user(request)
        image = await asyncio.to_thread(db.get_asset_node_image_full, image_id)
        if (
            image is None
            or int(image.get("ownerId") or 0) != int(user["id"])
            or str(image.get("node_status") or "") == "archived"
        ):
            return JSONResponse(status_code=404, content=failure(4004, "画布节点形象不存在或无权访问"))
        if str(image.get("status") or "") == "superseded":
            return JSONResponse(status_code=409, content=failure(4004, "该图片已被新资产替代，不能重新检查"))
        node_type = str(image.get("node_type") or "")
        from .domain.asset_vision import is_scene_vision_check_enabled, inspect_asset_image

        if node_type == "scene" and not is_scene_vision_check_enabled():
            await asyncio.to_thread(
                db.update_asset_node_image_fields,
                image_id,
                {
                    "vision_status": "skipped",
                    "vision_reason": "未运行视觉检查；结果需由用户按全景基准人工确认",
                    "vision_checked_at": None,
                    "identity_status": "not_checked",
                },
            )
            updated = await asyncio.to_thread(db.get_asset_node_image, image_id)
            return success(_asset_node_image_dto(updated, service_settings), "场景视觉检查未运行，请按全景基准人工确认")

        async def run_vision() -> dict[str, Any]:
            """视觉检查执行体（对象存储读图 + inspect_asset_image 门禁链）。"""
            current_stored = None
            if image.get("storage_key"):
                try:
                    current_stored = await asyncio.to_thread(
                        _read_object_bytes, service_settings, str(image["storage_key"])
                    )
                except Exception:
                    current_stored = None
            source_stored = None
            source_image_url = None
            if str(image.get("view_set_type") or "") == "scene-nine-grid" and image.get("source_image_id"):
                source_row = await asyncio.to_thread(db.get_asset_node_image, int(image["source_image_id"]))
                source_image_url = (source_row or {}).get("image_url") or None
                if (source_row or {}).get("storage_key"):
                    try:
                        source_stored = await asyncio.to_thread(
                            _read_object_bytes, service_settings, str(source_row["storage_key"])
                        )
                    except Exception:
                        source_stored = None
            identity_reference_urls: list[str] = []
            identity_reference_bytes: list[bytes] = []
            identity_checked = False
            if node_type == "character" and str(image.get("view_set_type") or "") in (
                "character-turnaround", "character-face-closeup"
            ):
                identity_checked = True
                reference_rows = [
                    row for row in await asyncio.to_thread(db.list_asset_node_images, int(image["asset_node_id"]))
                    if int(row["id"]) != int(image_id)
                ]
                reference_rows.sort(key=lambda row: int(row["id"]), reverse=True)
                reference_set = resolve_character_reference_set(
                    [_asset_node_image_dto(row, service_settings) for row in reference_rows]
                )
                identity_reference_urls = reference_set["imageUrls"]
                for storage_key in reference_set["storageKeys"]:
                    try:
                        stored = await asyncio.to_thread(_read_object_bytes, service_settings, storage_key)
                        if stored:
                            identity_reference_bytes.append(stored)
                    except Exception:
                        continue
            try:
                return inspect_asset_image(
                    image_url=None if current_stored else image.get("image_url"),
                    image_bytes=current_stored,
                    reference_image_url=None if source_stored else source_image_url,
                    reference_image_bytes=source_stored,
                    reference_image_urls=[] if identity_reference_bytes else identity_reference_urls,
                    reference_image_bytes_list=identity_reference_bytes,
                    view_key=image.get("view_key")
                    or ("front" if node_type == "character" and str(image.get("view_set_type") or "") == "single" else None),
                    scene=node_type == "scene",
                    asset_pack=str(image.get("view_set_type") or "") == "character-asset-pack"
                    or is_character_asset_pack_row(image),
                    node_type=node_type,
                    identity_lock=identity_checked,
                    no_face=node_type == "character"
                    and bool(
                        re.search(r"不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见", str(image.get("prompt_snapshot") or ""))
                    ),
                )
            except Exception as error:
                return {
                    "passed": False,
                    "reason": f"视觉检查无法读取已生成图片：{error}",
                }

        vision = await run_vision()
        assignments = {
            "vision_status": "pending" if vision.get("pending") else ("passed" if vision.get("passed") else "failed"),
            "vision_reason": vision.get("reason") or None,
            "vision_checked_at": datetime.now(timezone.utc),
            "identity_status": (
                ("pending" if vision.get("pending") else ("passed" if vision.get("passed") else "failed"))
                if identity_checked_flag(vision)
                else "not_checked"
            ),
            "identity_reason": (vision.get("reason") or None) if identity_checked_flag(vision) else None,
            "identity_similarity_score": vision.get("identitySimilarityScore") if identity_checked_flag(vision) else None,
            "wardrobe_consistency_score": vision.get("wardrobeConsistencyScore") if identity_checked_flag(vision) else None,
        }
        if str(image.get("status") or "") == "failed" and assignments["vision_status"] != "failed":
            assignments["status"] = "candidate"
        await asyncio.to_thread(db.update_asset_node_image_fields, image_id, assignments)
        if vision.get("passed"):
            if node_type == "character" and (
                str(image.get("view_set_type") or "") == "character-asset-pack" or is_character_asset_pack_row(image)
            ):
                await asyncio.to_thread(
                    db.commit_asset_adoption_txn, [image_id], "character", int(image["asset_node_id"]), None
                )
            elif node_type in ("prop", "material") and str(image.get("view_set_type") or "") == "single":
                await asyncio.to_thread(
                    db.commit_asset_adoption_txn, [image_id], node_type, int(image["asset_node_id"]), "single"
                )
        updated = await asyncio.to_thread(db.get_asset_node_image, image_id)
        return success(_asset_node_image_dto(updated, service_settings), "视角视觉检查已更新")

    def identity_checked_flag(vision: dict[str, Any]) -> bool:
        """vision-check 是否执行了身份一致性检查（pending/skipped 之外的视觉调用均执行）。"""
        return not vision.get("skipped") and not vision.get("pending")

    # -- 项目删除 / 导出包 -------------------------------------------------

    @app.delete("/api/projects/{project_id}")
    async def delete_project(project_id: int, request: Request):
        """项目永久删除（对齐 Node DELETE，L15141：confirmName 校验 + 4090）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            body = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content=failure(4001, "删除确认信息格式无效"))
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content=failure(4001, "删除确认信息格式无效"))
        confirm_name = str(body.get("confirmName") or "").strip()
        expected_name = _project_deletion_confirmation_name(project)
        if not confirm_name:
            return JSONResponse(status_code=400, content=failure(4001, f"请输入项目名称“{expected_name}”以确认删除"))
        if confirm_name != expected_name:
            return JSONResponse(status_code=409, content=failure(4090, "项目名称不匹配，请输入页面显示的完整项目名称"))
        deleted = await asyncio.to_thread(db.delete_project_txn, project_id, int(user["id"]))
        if not deleted:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success({"id": project_id}, "项目已永久删除")

    @app.get("/api/projects/{project_id}/export-package")
    async def project_export_package(project_id: int, request: Request):
        """导出就绪度包（对齐 Node GET，L12592：buildExportPackage 复刻）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        episode_no = _parse_id_value(request.query_params.get("episodeNo"))
        payload = await asyncio.to_thread(
            _build_export_package, db, project_id, service_settings, episode_no or None
        )
        return success(payload)

    # -- 角色库 -----------------------------------------------------------

    @app.get("/api/projects/{project_id}/characters")
    async def list_project_characters(project_id: int, request: Request):
        """项目角色列表（对齐 Node GET，L17546）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_project_characters, project_id)
        return success({"items": [character_row(row) for row in rows]})

    @app.post("/api/projects/{project_id}/characters/generate")
    async def generate_project_characters(project_id: int, request: Request):
        """从已保存总纲/剧本抽取角色，并以事务方式同步角色库。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        outline = await asyncio.to_thread(db.latest_outline_row, project_id)
        scenes = await asyncio.to_thread(db.list_scenes, project_id, int(user["id"]))
        if scenes is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        if not outline and not any(str(scene.get("content") or scene.get("summary") or "").strip() for scene in scenes):
            return JSONResponse(status_code=400, content=failure(4004, "项目还没有总纲或剧本内容，请先生成故事总纲或单场剧本"))
        story_bible_row = await asyncio.to_thread(db.latest_story_bible_row, project_id)
        story_bible = story_bible_row
        if story_bible and isinstance(story_bible.get("characters"), str):
            try:
                story_bible = {**story_bible, "characters": json.loads(story_bible["characters"])}
            except (TypeError, ValueError):
                story_bible = {**story_bible, "characters": []}
        ai_project = {
            "name": project.get("name"), "category": project.get("category"),
            "visual_style": project.get("visual_style"), "narrative_vision": project.get("narrative_vision"),
        }
        try:
            generated = await ai_generate_characters(
                project=ai_project, outline=outline, scenes=scenes,
                story_bible=story_bible, client=ai_http_client,
            )
        except AiProviderError as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        raw_characters = generated.get("characters") if isinstance(generated, dict) else None
        if not isinstance(raw_characters, list) or not raw_characters:
            return JSONResponse(status_code=502, content=failure(5001, "AI 没有识别出有效角色，请检查总纲和剧本内容"))
        normalized = []
        for index, item in enumerate(raw_characters[:20]):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or f"角色 {index + 1}").strip()
            if not name:
                continue
            normalized.append({
                "name": name[:200],
                "role_tag": str(item.get("role_tag", item.get("roleTag")) or ("主角" if index == 0 else "配角")).strip() or None,
                "personality": str(item.get("personality") or "性格鲜明，行为动机与剧情目标一致。").strip() or None,
                "appearance": str(item.get("appearance") or "具有清晰可辨的脸部、发型、体态与服装特征。").strip() or None,
                "costume": str(item.get("costume") or item.get("costume_description") or "").strip() or None,
                "voice_setting": str(item.get("voice_setting", item.get("voiceSetting")) or "").strip() or None,
                "age_group": normalize_character_age_group(item.get("age_group", item.get("ageGroup"))),
                "gender": normalize_character_gender(item.get("gender")),
                "voice_style": str(item.get("voice_style", item.get("voiceStyle")) or "").strip()[:160] or None,
            })
        if not normalized:
            return JSONResponse(status_code=502, content=failure(5001, "AI 没有识别出有效角色，请检查总纲和剧本内容"))
        rows = await asyncio.to_thread(db.upsert_generated_characters, project_id, normalized)
        existing_nodes = await asyncio.to_thread(db.list_asset_canvas_nodes, project_id)
        existing_keys = {
            (
                str(node.get("node_type", node.get("nodeType")) or ""),
                int(node.get("ref_id", node.get("refId")) or 0),
                str(node.get("group_key", node.get("groupKey")) or ""),
            )
            for node in existing_nodes if node.get("status") != "archived"
        }
        scene_names = [row.get("name") for row in rows if row.get("name")]
        for index, row in enumerate(rows):
            group_key = normalize_asset_group_key(f"character:{row['id']}:default")
            if ("character", int(row["id"]), group_key) in existing_keys:
                continue
            character_scenes = [
                scene for scene in scenes
                if any(str(row.get("name") or "") in str(scene.get(field) or "") for field in ("title", "summary", "content", "location"))
            ]
            prompt = build_script_character_prompt(row, character_scenes, project.get("visual_style") or "", project.get("category") or "")
            await asyncio.to_thread(db.create_asset_node, project_id, {
                "nodeType": "character", "refId": int(row["id"]), "label": row.get("name"),
                "appearanceLabel": row.get("role_tag"), "promptText": prompt["prompt"],
                "turnaroundPromptText": prompt["turnaroundPrompt"], "negativePrompt": prompt["negativePrompt"],
                "x": 80 + (index % 4) * 260, "y": 80 + (index // 4) * 320,
                "width": 220, "height": 260, "groupKey": group_key,
            })
            existing_keys.add(("character", int(row["id"]), group_key))
        for index, scene in enumerate(scenes):
            scene_id = int(scene["id"])
            group_key = f"scene:{scene_id}:default"
            if ("scene", scene_id, group_key) in existing_keys or not str(scene.get("title") or "").strip():
                continue
            await asyncio.to_thread(db.create_asset_node, project_id, {
                "nodeType": "scene", "refId": scene_id, "label": build_scene_display_label(scene),
                "promptText": build_script_scene_prompt(scene, project.get("visual_style") or "", project.get("category") or "", scene_names),
                "environmentPromptText": build_scene_environment_prompt(scene, project.get("visual_style") or "", project.get("category") or "", scene_names),
                "x": 80 + (index % 4) * 300, "y": 420 + (index // 4) * 260,
                "width": 260, "height": 220, "groupKey": group_key,
            })
        return success({"items": [character_row(row) for row in rows]}, "角色档案已生成")

    @app.post("/api/characters/{character_id}/generate-profile")
    async def generate_character_profile_route(character_id: int, request: Request):
        """补全角色档案；生成完成后原子更新字段并重置锁定的音色。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        project = await asyncio.to_thread(
            db.get_project, int(character["project_id"]), int(user["id"])
        )
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        scenes = await asyncio.to_thread(db.list_scenes, int(character["project_id"]), int(user["id"]))
        if scenes is None:
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        try:
            profile = await ai_generate_character_profile(
                character=character,
                project={
                    "name": project.get("name"), "category": project.get("category"),
                    "visual_style": project.get("visual_style"),
                    "narrative_vision": project.get("narrative_vision"),
                },
                scenes=scenes, client=ai_http_client,
            )
        except AiProviderError as exc:
            return JSONResponse(status_code=502, content=failure(5020, str(exc)))
        assignments = {
            "role_tag": profile.get("role_tag"),
            "personality": profile.get("personality"),
            "appearance": profile.get("appearance"),
            "age_group": normalize_character_age_group(profile.get("age_group")),
            "gender": normalize_character_gender(profile.get("gender")),
            "voice_style": str(profile.get("voice_style") or "").strip()[:160] or None,
            "voice_locked": 0,
        }
        try:
            row = await asyncio.to_thread(
                db.update_character_txn, character_id, assignments,
                require_same_owner=int(user["id"]),
            )
        except RuntimeError as exc:
            return JSONResponse(status_code=404, content=failure(4004, str(exc)))
        if row is None:
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        return success(character_row(row), "角色档案已补全")

    @app.post("/api/projects/{project_id}/characters")
    async def create_project_character(project_id: int, request: Request):
        """手工新建角色（对齐 Node POST，L17555：4001 → 4009 → 归一化插入）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        name = str(body.get("name") or "").strip()
        if not name:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能为空"))
        if len(name) > 200:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能超过 200 个字符"))
        if await asyncio.to_thread(db.character_name_exists, project_id, name):
            return JSONResponse(status_code=409, content=failure(4009, "当前项目已经存在同名角色"))
        age_group = None if body.get("ageGroup") is None else normalize_character_age_group(body.get("ageGroup"))
        gender = None if body.get("gender") is None else normalize_character_gender(body.get("gender"))
        if body.get("ageGroup") is not None and not age_group:
            return JSONResponse(status_code=400, content=failure(4001, "角色年龄段无效"))
        if body.get("gender") is not None and not gender:
            return JSONResponse(status_code=400, content=failure(4001, "角色声线性别无效"))
        row = await asyncio.to_thread(
            db.insert_character,
            project_id,
            {
                "name": name,
                "roleTag": str(body.get("roleTag")).strip() if body.get("roleTag") else None,
                "personality": str(body.get("personality")) if body.get("personality") is not None else None,
                "appearance": str(body.get("appearance")) if body.get("appearance") is not None else None,
                "voiceSetting": str(body.get("voiceSetting")) if body.get("voiceSetting") is not None else None,
                "ageGroup": age_group,
                "gender": gender,
                "voiceStyle": str(body.get("voiceStyle") or "").strip()[:160] or None,
                "referenceImageUrl": str(body.get("referenceImageUrl")) if body.get("referenceImageUrl") is not None else None,
            },
        )
        return success(character_row(row), "角色已创建")

    @app.api_route("/api/characters/{character_id}", methods=["GET", "PUT", "DELETE"])
    async def character_detail(character_id: int, request: Request):
        """角色详情/更新/软删（对齐 Node GET L18192 / DELETE L18197 / PUT L18208）。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        if request.method == "GET":
            return success(character_row(character))
        if request.method == "DELETE":
            await asyncio.to_thread(db.archive_character, character_id)
            return success({"success": True}, "角色已删除")
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse(status_code=400, content=failure(4001, "请求内容无效"))
        requested_name = (
            str(character.get("name") or "").strip()
            if "name" not in body
            else str(body.get("name") or "").strip()
        )
        if not requested_name:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能为空"))
        if len(requested_name) > 200:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能超过 200 个字符"))
        is_rename = requested_name != str(character.get("name") or "").strip()
        if is_rename and not isinstance(body.get("syncNameReferences"), bool):
            return JSONResponse(status_code=400, content=failure(4001, "修改角色名时必须明确是否同步项目文本"))

        age_group: Any = "undefined"
        if "ageGroup" in body:
            if body.get("ageGroup") in (None, ""):
                age_group = None
            else:
                age_group = normalize_character_age_group(body.get("ageGroup"))
                if not age_group:
                    return JSONResponse(status_code=400, content=failure(4001, "角色年龄段无效"))
        gender: Any = "undefined"
        if "gender" in body:
            if body.get("gender") in (None, ""):
                gender = None
            else:
                gender = normalize_character_gender(body.get("gender"))
                if not gender:
                    return JSONResponse(status_code=400, content=failure(4001, "角色声线性别无效"))
        voice_style: Any = "undefined"
        if "voiceStyle" in body:
            voice_style = str(body.get("voiceStyle") or "").strip()[:160] or None
        voice_traits_changed = (
            (age_group != "undefined" and age_group != (character.get("age_group") or None))
            or (gender != "undefined" and gender != (character.get("gender") or None))
            or (voice_style != "undefined" and voice_style != (character.get("voice_style") or None))
        )

        allowed: dict[str, Any] = {}
        if "name" in body:
            allowed["name"] = requested_name
        for key, column in (
            ("roleTag", "role_tag"),
            ("personality", "personality"),
            ("appearance", "appearance"),
            ("voiceSetting", "voice_setting"),
            ("referenceImageUrl", "reference_image_url"),
            ("status", "status"),
        ):
            if key in body:
                allowed[column] = body.get(key)
        if age_group != "undefined":
            allowed["age_group"] = age_group
        if gender != "undefined":
            allowed["gender"] = gender
        if voice_style != "undefined":
            allowed["voice_style"] = voice_style
        if voice_traits_changed:
            allowed["voice_locked"] = 0

        rename_plan = None
        if is_rename and body.get("syncNameReferences"):
            context = await asyncio.to_thread(db.list_rename_context_rows, int(character["project_id"]), character_id)
            rename_plan = build_character_rename_plan(
                character,
                requested_name,
                project_rows=context["project"],
                outline_rows=context["outline"],
                scene_rows=context["scenes"],
                storyboard_rows=context["storyboards"],
                project_character_rows=context["characters"],
                media_counts=context["media_counts"],
            )
        try:
            row = await asyncio.to_thread(
                db.update_character_txn,
                character_id,
                allowed,
                rename_plan=rename_plan if (is_rename and body.get("syncNameReferences")) else None,
                require_same_owner=int(user["id"]),
            )
        except RuntimeError as exc:
            if str(exc) == "当前项目已经存在同名角色，请使用其他名字":
                return JSONResponse(status_code=409, content=failure(4009, str(exc)))
            return JSONResponse(status_code=404, content=failure(4004, str(exc)))
        return success(
            character_row(row),
            "角色名及项目文本已同步更新" if (is_rename and body.get("syncNameReferences")) else "角色已保存",
        )

    @app.post("/api/character-images/{image_id}/confirm")
    async def character_image_confirm(image_id: int, request: Request):
        """定妆图确认（对齐 Node L17613：同角色旧确认降级 + 角色 finalized）。"""
        user = await require_user(request)
        image = await asyncio.to_thread(db.get_character_image_full, image_id)
        if image is None or int(image.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色定妆图不存在或无权访问"))
        row = await asyncio.to_thread(
            db.confirm_character_image_txn,
            image_id,
            int(image["character_id"]),
            image.get("image_url"),
            image.get("storage_key"),
        )
        return success(character_image_row(row, resolve_storage_url=None), "角色定妆图已确认")

    @app.post("/api/characters/{character_id}/rename-preview")
    async def character_rename_preview(character_id: int, request: Request):
        """改名影响预览（对齐 Node L17664：4001 → 4009 → impact）。"""
        user = await require_user(request)
        body = await request.json()
        new_name = str(body.get("name") or "").strip()
        if not new_name:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能为空"))
        if len(new_name) > 200:
            return JSONResponse(status_code=400, content=failure(4001, "角色名不能超过 200 个字符"))
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        if await asyncio.to_thread(db.character_name_exists, int(character["project_id"]), new_name, character_id):
            return JSONResponse(status_code=409, content=failure(4009, "当前项目已经存在同名角色，请使用其他名字"))
        context = await asyncio.to_thread(db.list_rename_context_rows, int(character["project_id"]), character_id)
        plan = build_character_rename_plan(
            character,
            new_name,
            project_rows=context["project"],
            outline_rows=context["outline"],
            scene_rows=context["scenes"],
            storyboard_rows=context["storyboards"],
            project_character_rows=context["characters"],
            media_counts=context["media_counts"],
        )
        return success(plan["impact"])

    @app.get("/api/characters/{character_id}/images")
    async def character_images(character_id: int, request: Request):
        """角色定妆图列表（对齐 Node feature images GET，L17768）。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_character_images, character_id)
        return success(
            {"items": [character_image_row(row, resolve_storage_url=_resolve_character_storage_url) for row in rows]}
        )

    def _resolve_character_storage_url(storage_key: Any) -> str | None:
        """定妆图 storage_key → 签名 URL（失败 None 回退历史地址）。"""
        return _object_storage_url(storage_key, service_settings)

    @app.post("/api/characters/{character_id}/images/generate")
    async def character_images_generate(character_id: int, request: Request):
        """定妆图生成入队（对齐 Node POST，L17777：4011 受控错误形态）。"""
        user = await require_user(request)
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
        try:
            job = await asyncio.to_thread(
                _enqueue_character_image_job, db, int(user["id"]), character_id, body, service_settings
            )
        except LookupError as exc:
            return JSONResponse(status_code=404, content=failure(4004, str(exc)))
        except NodeEnqueueError as exc:
            return JSONResponse(status_code=exc.status_code, content=failure(4011, exc.message))
        return success(generation_job_row(job), "角色定妆图生成任务已提交")

    @app.get("/api/projects/{project_id}/voice-cast")
    async def project_voice_cast(project_id: int, request: Request):
        """角色×音色阵容（对齐 Node GET，L17237）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_project_characters, project_id)
        profile_rows = await asyncio.to_thread(db.list_active_voice_profiles)
        profiles = [voice_profile_row(row) for row in profile_rows]
        return success({"items": [character_voice_cast_row(row, profiles) for row in rows]})

    @app.get("/api/characters/{character_id}/voice-recommendations")
    async def character_voice_recommendations(character_id: int, request: Request):
        """音色推荐 Top3（对齐 Node GET，L17279）。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        profile_rows = await asyncio.to_thread(db.list_active_voice_profiles)
        profiles = [voice_profile_row(row) for row in profile_rows]
        recommendation = recommend_voice_profiles(character, profiles, 3)
        return success(
            {
                "character": character_row(character),
                "traits": recommendation["traits"],
                "selectedProfile": next(
                    (profile for profile in profiles if profile.get("profileKey") == character.get("voice_profile_key")),
                    None,
                ),
                "items": recommendation["items"],
            }
        )

    @app.put("/api/characters/{character_id}/voice-binding")
    async def character_voice_binding(character_id: int, request: Request):
        """音色绑定+锁定（对齐 Node PUT，L17292：4001 校验链 + traits 推断）。"""
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        body = await request.json()
        profile_rows = await asyncio.to_thread(db.list_active_voice_profiles)
        profiles = [voice_profile_row(row) for row in profile_rows]
        profile = next(
            (profile for profile in profiles if profile.get("profileKey") == str(body.get("voiceProfileKey") or "").strip()),
            None,
        )
        if profile is None:
            return JSONResponse(status_code=400, content=failure(4001, "请选择有效且可用的音色方案"))
        requested_age_group = None
        if body.get("ageGroup") is not None:
            requested_age_group = normalize_character_age_group(body.get("ageGroup"))
            if not requested_age_group:
                return JSONResponse(status_code=400, content=failure(4001, "角色年龄段无效"))
        requested_gender = None
        if body.get("gender") is not None:
            requested_gender = normalize_character_gender(body.get("gender"))
            if not requested_gender:
                return JSONResponse(status_code=400, content=failure(4001, "角色声线性别无效"))
        inferred = infer_character_voice_traits(character)
        age_group = (
            requested_age_group
            or normalize_character_age_group(character.get("age_group"))
            or inferred["ageGroup"]
        )
        gender = (
            requested_gender
            or normalize_character_gender(character.get("gender"))
            or inferred["gender"]
        )
        voice_resolution = resolve_character_voice_profile(
            {**character, "gender": gender, "age_group": age_group},
            [profile],
            profile["profileKey"],
        )
        if voice_resolution.get("error"):
            return JSONResponse(status_code=400, content=failure(4001, voice_resolution["error"]))
        voice_style = str(body.get("voiceStyle") if body.get("voiceStyle") is not None else character.get("voice_style") or "").strip()[:160] or None
        voice_locked = body.get("locked") is not False
        row = await asyncio.to_thread(
            db.update_character_voice_binding,
            character_id,
            {
                "age_group": age_group,
                "gender": gender,
                "voice_style": voice_style,
                "voice_profile_key": profile["profileKey"],
                "voice_setting": profile["voiceId"],
                "voice_design_json": None,
                "voice_locked": 1 if voice_locked else 0,
            },
        )
        return success(
            {
                "character": character_row(row),
                "selectedProfile": profile,
                "traits": infer_character_voice_traits(row or {}),
            },
            "角色音色已确认并锁定" if voice_locked else "角色音色方案已保存",
        )

    @app.put("/api/characters/{character_id}/reference-audio")
    async def character_reference_audio(character_id: int, request: Request):
        """参考音频上传（对齐 Node PUT，L17351：dataURL ≤15MB → 对象存储 + 锁定）。

        有意差异：Node decodeAudioDataUrl 上限 15MB（L6881），入队注释里的 22MB 是
        parseBody 的请求体上限；Python 按 Node 校验语义执行 15MB 上限。
        """
        user = await require_user(request)
        character = await asyncio.to_thread(db.get_character_for_user, character_id)
        if character is None or int(character.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "角色不存在或无权访问"))
        body = await request.json()
        data_url = str(body.get("dataBase64") or "")
        match = re.fullmatch(r"^data:(audio/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$", data_url, re.I)
        if not match:
            return JSONResponse(status_code=400, content=failure(4011, "参考音频格式无效"))
        mime_type = match.group(1).lower()
        try:
            audio_bytes = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
        except Exception:
            return JSONResponse(status_code=400, content=failure(4011, "参考音频格式无效"))
        if not audio_bytes or len(audio_bytes) > 15 * 1024 * 1024:
            return JSONResponse(status_code=400, content=failure(4011, "参考音频不能为空且不能超过 15MB"))
        extension = mime_type.split("/")[1].replace("mpeg", "mp3").replace("x-wav", "wav")
        storage_key = f"projects/{character['project_id']}/characters/{character_id}/voice-reference.{extension}"
        try:
            stored = await asyncio.to_thread(
                _write_object_bytes, service_settings, storage_key, audio_bytes, mime_type
            )
        except Exception as exc:
            logger.warning("reference audio upload failed request_id=%s error=%s", request.state.request_id, type(exc).__name__)
            return JSONResponse(status_code=500, content=failure(5001, "参考音频保存失败，请稍后重试"))
        row = await asyncio.to_thread(
            db.update_character_voice_binding,
            character_id,
            {
                "reference_audio_url": stored["url"],
                "reference_audio_storage_key": stored["key"],
                "voice_locked": 1,
            },
        )
        return success({"character": character_row(row)}, "参考音频已保存")

    # ------------------------------------------------------------------
    # 运维端点组（阶段 3.2.5）原生路由。豁免（501）清单见常量区
    # OPS_FALLBACK_501_ROUTES；兜底代理收口为本块尾部的 4040 处理器。
    # ------------------------------------------------------------------

    @app.get("/api/health")
    async def api_health():
        """业务健康摘要（对齐 Node GET /api/health，index.mjs L12218）。

        与 :func:`health`（/health，网关自身）不同，本路由对齐 Node 的业务摘要
        形状供运维探活与 FastAPI /ready 探测使用。有意差异（记录不修）：FastAPI
        的 SMS 供应商在构建期完成降级（sms/__init__），故 ``smsReady`` 恒 true、
        ``smsReason`` 恒空串；Node 的 ready/reason 为运行期判定。

        :returns: success envelope，data 含 status/serverStartedAt/port/
                  publicBaseUrl/objectStorage*/sms*/dbName/userCount。
        :raises Exception: DB 故障由网关兜底 500/5001（对齐 Node 全局 catch）。
        """
        user_count = await asyncio.to_thread(db.get_user_count)
        sms_provider_name = "tencent" if type(sms_provider).__name__ == "TencentSmsProvider" else "mock"
        return success(
            {
                "status": "ok",
                "serverStartedAt": os.environ.get("PROJECTDREAM_SERVER_STARTED_AT") or None,
                "port": service_settings.port,
                "publicBaseUrl": service_settings.public_base_url,
                "objectStorageProvider": service_settings.object_storage_provider,
                "objectStoragePublicBaseUrl": service_settings.object_storage_public_base_url,
                "smsProvider": sms_provider_name,
                "smsReady": True,
                "smsReason": "",
                "dbName": service_settings.mysql_database,
                "userCount": user_count,
            }
        )

    @app.get("/api/model-settings")
    async def get_model_settings(request: Request):
        """模型设置读取（对齐 Node GET /api/model-settings，index.mjs L12235）。

        :param request: 当前请求（鉴权用）。
        :returns: success envelope（groups/fields/effective；secret 不回显明文）。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        await require_user(request)
        persisted = await asyncio.to_thread(db.get_model_settings_map)
        return success(build_model_settings_payload(persisted))

    @app.put("/api/model-settings")
    async def put_model_settings(request: Request):
        """模型设置保存（对齐 Node PUT /api/model-settings，index.mjs L12244）。

        逐条 upsert；secret 空值跳过、未注册 key 忽略、数值非法 400/4001。

        :param request: 当前请求（body.settings 为 ``[{key, value}]``）。
        :returns: 成功 200 + 保存后的完整 payload，message「模型设置已保存」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        body = await request.json()
        try:
            await asyncio.to_thread(
                save_model_settings,
                body.get("settings"),
                int(user["id"]),
                db.upsert_model_setting,
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content=failure(4001, str(exc) if str(exc) else "模型设置保存失败"))
        persisted = await asyncio.to_thread(db.get_model_settings_map)
        return success(build_model_settings_payload(persisted), "模型设置已保存")

    @app.post("/api/projects/{project_id}/agent-pipeline/start")
    async def start_agent_pipeline_route(project_id: int, request: Request):
        """Create or reuse an owner-scoped Pipeline run for the Node Worker queue."""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            body = await request.json()
        except Exception:
            body = {}
        try:
            episode_no = max(1, min(50, int(body.get("episodeNo") or 1)))
        except (TypeError, ValueError):
            episode_no = 1
        idempotency_key = str(body.get("idempotencyKey") or "").strip()
        if not idempotency_key:
            return JSONResponse(status_code=400, content=failure(4001, "请提供 Agent Pipeline 幂等键"))
        result = await asyncio.to_thread(
            db.enqueue_agent_pipeline_run,
            project_id=project_id,
            user_id=int(user["id"]),
            episode_no=episode_no,
            idempotency_key=idempotency_key,
            regenerate=body.get("regenerate") is True,
        )
        if result.get("outcome") == "script_missing":
            return JSONResponse(
                status_code=400,
                content=failure(4001, f"第 {episode_no} 集还没有剧本正文，请先完成剧本生成"),
            )
        if result.get("outcome") not in {"queued", "existing"}:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        view = await asyncio.to_thread(
            db.get_agent_pipeline_view, int(result["run_id"]), int(user["id"])
        )
        if view is None:
            return JSONResponse(status_code=500, content=failure(5001, "Agent Pipeline 入队后无法读取运行记录"))
        return success(_agent_pipeline_view(view), "Agent Pipeline 已入队")

    @app.get("/api/projects/{project_id}/agent-pipeline")
    async def list_agent_pipeline_route(project_id: int, request: Request):
        """读取项目下的 Agent Pipeline 运行及其阶段执行、事件历史。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        views = await asyncio.to_thread(db.list_agent_pipeline_views, project_id, int(user["id"]))
        if views is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success({"items": [_agent_pipeline_view(view) for view in views]})

    @app.get("/api/agent-pipelines/{run_id}")
    async def get_agent_pipeline_route(run_id: int, request: Request):
        """读取 owner 可见的单次 Agent Pipeline 运行详情及历史。"""
        user = await require_user(request)
        if run_id <= 0:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        view = await asyncio.to_thread(db.get_agent_pipeline_view, run_id, int(user["id"]))
        if view is None:
            return JSONResponse(status_code=404, content=failure(4004, "运行记录不存在或无权访问"))
        return success(_agent_pipeline_view(view))

    @app.post("/api/agent-pipelines/{run_id:int}/stages/{stage_key}/decision")
    async def decide_agent_pipeline_stage_route(run_id: int, stage_key: str, request: Request):
        """以 owner-scoped 事务确认或拒绝等待审批的阶段，并恢复持久队列。"""
        user = await require_user(request)
        if run_id <= 0:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        stage = next((item for item in PIPELINE_STAGES if item.key == stage_key), None)
        if stage is None:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        try:
            body = await request.json()
        except Exception:
            body = {}
        decision = str(body.get("decision") or "").strip()
        if decision not in {"approve", "reject"}:
            return JSONResponse(status_code=400, content=failure(4001, "Agent 检查点决定无效"))
        outcome = await asyncio.to_thread(
            db.apply_agent_pipeline_decision,
            run_id,
            int(user["id"]),
            stage_key,
            decision,
            str(body.get("note") or "").strip(),
        )
        if outcome.get("outcome") == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "Agent Pipeline 不存在或无权访问"))
        if outcome.get("outcome") == "not_waiting":
            return JSONResponse(status_code=409, content=failure(4090, "当前 Agent 阶段还没有可审批的结果"))
        view = await asyncio.to_thread(db.get_agent_pipeline_view, run_id, int(user["id"]))
        if view is None:
            return JSONResponse(status_code=404, content=failure(4004, "Agent Pipeline 不存在或无权访问"))
        message = "Agent Pipeline 已暂停" if outcome.get("outcome") == "paused" else (
            "剧本链已完成，请进入分镜创作页" if outcome.get("outcome") == "completed" else "Agent 阶段已确认并重新入队"
        )
        return success(_agent_pipeline_view(view), message)

    @app.post("/api/agent-pipelines/{run_id:int}/stage-actions")
    async def register_agent_pipeline_stage_action_route(run_id: int, request: Request):
        """登记调用方提交的阶段结果与事件，不启动 Agent 或外部执行体。"""
        user = await require_user(request)
        if run_id <= 0:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        user_id = int(user["id"])
        view = await asyncio.to_thread(db.get_agent_pipeline_view, run_id, user_id)
        if view is None:
            return JSONResponse(status_code=404, content=failure(4004, "Agent Pipeline 不存在或无权访问"))
        body = await request.json()
        stage_key = str(body.get("stageKey") or "").strip()
        stage = next((item for item in PIPELINE_STAGES if item.key == stage_key), None)
        if stage is None or stage_key in {"asset-parse", "storyboard"}:
            return JSONResponse(status_code=400, content=failure(4001, "该阶段不能通过业务动作登记"))
        idempotency_key = str(body.get("idempotencyKey") or "").strip()
        if not idempotency_key:
            return JSONResponse(status_code=400, content=failure(4001, "请提供 Agent 阶段动作幂等键"))
        run_status = view["run"].get("status")
        if run_status not in {"completed", "waiting_approval", "running", "paused"}:
            return JSONResponse(status_code=409, content=failure(4090, "当前 Pipeline 不允许登记业务动作"))
        status = str(body.get("status") or "waiting_approval").strip()
        action = {
            "stageKey": stage_key,
            "agentKey": stage.agent_key,
            "idempotencyKey": idempotency_key,
            "status": status,
            "inputSnapshot": body.get("inputSnapshot") if isinstance(body.get("inputSnapshot"), (dict, list)) else {},
            "outputSnapshot": body.get("outputSnapshot") if isinstance(body.get("outputSnapshot"), (dict, list)) else {},
            "blockers": body.get("blockers") if isinstance(body.get("blockers"), list) else [],
            "errorText": str(body.get("errorText") or "").strip(),
        }
        outcome = await asyncio.to_thread(db.register_agent_pipeline_stage_action, run_id, user_id, action)
        if outcome["outcome"] == "not_found":
            return JSONResponse(status_code=404, content=failure(4004, "Agent Pipeline 不存在或无权访问"))
        if outcome["outcome"] == "not_allowed":
            return JSONResponse(status_code=409, content=failure(4090, "当前 Pipeline 不允许登记业务动作"))
        updated = await asyncio.to_thread(db.get_agent_pipeline_view, run_id, user_id)
        if updated is None:
            return JSONResponse(status_code=404, content=failure(4004, "Agent Pipeline 不存在或无权访问"))
        return success(_agent_pipeline_view(updated), f"{stage.label_cn} 已登记")

    @app.get("/api/projects/{project_id}/production-runs")
    async def list_production_runs_route(project_id: int, request: Request):
        """读取项目的 ProductionRun 摘要列表（不触发蓝图生成或阶段执行）。"""
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_production_run_rows, project_id, int(user["id"]))
        return success({"items": [_production_run_row(row) for row in rows]})

    @app.get("/api/production-runs/{run_id:int}")
    async def get_production_run_route(run_id: int, request: Request):
        """读取 owner 可见的 ProductionRun 只读详情，不触发生成或状态推进。"""
        user = await require_user(request)
        view = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        if view is None:
            return JSONResponse(status_code=404, content=failure(4004, "运行记录不存在或无权访问"))
        return success(_production_run_view(view))

    @app.post("/api/projects/{project_id}/production-runs")
    async def create_production_run_route(project_id: int, request: Request):
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if not project:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        try:
            normalized = normalize_production_run_input({**body, "projectId": project_id})
        except ValueError as exc:
            return JSONResponse(status_code=400, content=failure(4001, str(exc)))
        idempotency_key = str(body.get("idempotencyKey") or "").strip() or None
        sources = await asyncio.to_thread(db.get_production_story_sources, project_id, normalized["episodeNo"])
        blueprint = build_episode_blueprint(
            project_id=project_id, episode_no=normalized["episodeNo"], episode=sources["episode"],
            bible=sources["bible"], platform=normalized["platform"],
            candidate_policy=normalized["candidatePolicy"], source_script=sources["sourceScript"],
        )
        quality_report = evaluate_episode_blueprint(blueprint)
        seed = build_production_run_seed(normalized, blueprint)
        try:
            run_id = await asyncio.to_thread(
                db.create_production_run, project_id=project_id, user_id=int(user["id"]),
                project_name=project.get("name") or "项目", seed=seed, blueprint=blueprint,
                quality_report=quality_report, idempotency_key=idempotency_key,
            )
        except Exception as exc:
            if idempotency_key and getattr(exc, "args", [None])[0] == 1062:
                existing = await asyncio.to_thread(db.find_production_run_by_idempotency, project_id, int(user["id"]), idempotency_key)
                if existing:
                    view = await asyncio.to_thread(db.get_production_run_view, int(existing["id"]), int(user["id"]))
                    return success(_production_run_view(view), "ProductionRun 已存在")
            raise
        view = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        return success(_production_run_view(view), "ProductionRun 已创建")

    @app.put("/api/production-runs/{run_id:int}/blueprint")
    async def save_production_blueprint_route(run_id: int, request: Request):
        user = await require_user(request)
        view = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        if not view:
            return JSONResponse(status_code=404, content=failure(4004, "生产运行不存在或无权访问"))
        body = await request.json()
        blueprint = body.get("blueprint") if isinstance(body.get("blueprint"), dict) else {}
        report = evaluate_episode_blueprint(blueprint)
        blueprint_id = await asyncio.to_thread(db.save_production_blueprint, run_id, int(user["id"]), blueprint, report)
        if not blueprint_id:
            return JSONResponse(status_code=404, content=failure(4004, "生产运行不存在或无权访问"))
        updated = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        return success({"blueprint": _production_run_view(updated)["blueprint"], "report": report}, "单集蓝图已保存")

    @app.post("/api/production-runs/{run_id:int}/checkpoints/{checkpoint_key}/decision")
    async def decide_production_checkpoint_route(run_id: int, checkpoint_key: str, request: Request):
        user = await require_user(request)
        view = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        if not view:
            return JSONResponse(status_code=404, content=failure(4004, "生产运行不存在或无权访问"))
        body = await request.json()
        decision = str(body.get("decision") or "").strip()
        try:
            quality_report = (view.get("blueprint") or {}).get("qualityReport") or {}
            if checkpoint_key == "blueprint" and decision == "approve" and not quality_report.get("canApprove"):
                raise ValueError("单集蓝图尚未通过质量门禁，不能审批进入生成")
            transition = build_production_checkpoint_transition(
                run=_production_run_row(view["run"]),
                stages=_production_run_view(view)["stages"], checkpoints=_production_run_view(view)["checkpoints"],
                checkpoint_key=checkpoint_key, decision=decision, note=body.get("note") or "",
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content=failure(4001, str(exc)))
        applied = await asyncio.to_thread(db.apply_production_transition, run_id, int(user["id"]), transition, checkpoint=True)
        if not applied:
            return JSONResponse(status_code=409, content=failure(4090, "检查点状态已变化，请刷新后重试"))
        updated = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        return success(_production_run_view(updated), "检查点已批准" if decision == "approve" else "检查点已拒绝")

    @app.post("/api/production-runs/{run_id:int}/stages/{stage_key}/complete")
    async def complete_production_stage_route(run_id: int, stage_key: str, request: Request):
        user = await require_user(request)
        view = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        if not view:
            return JSONResponse(status_code=404, content=failure(4004, "生产运行不存在或无权访问"))
        body = await request.json()
        try:
            transition = build_production_stage_completion_transition(
                run=_production_run_row(view["run"]), stages=_production_run_view(view)["stages"],
                checkpoints=_production_run_view(view)["checkpoints"], completed_stage_key=stage_key,
                output_snapshot=body.get("outputSnapshot") if isinstance(body.get("outputSnapshot"), dict) else {},
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content=failure(4001, str(exc)))
        applied = await asyncio.to_thread(db.apply_production_transition, run_id, int(user["id"]), transition)
        if not applied:
            return JSONResponse(status_code=409, content=failure(4090, "生产运行状态已变化，请刷新后重试"))
        updated = await asyncio.to_thread(db.get_production_run_view, run_id, int(user["id"]))
        return success(_production_run_view(updated), "当前生产阶段已完成")

    @app.post("/api/projects/{project_id:int}/scenes/generate")
    async def generate_project_scenes_route(project_id: int, request: Request):
        """从最新分集结构或旧版总纲创建场景草稿，不覆盖已有剧本。"""
        user = await require_user(request)
        user_id = int(user["id"])
        project = await asyncio.to_thread(db.get_project, project_id, user_id)
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))

        season = await asyncio.to_thread(db.latest_season_structure_row, project_id)
        outline = None
        episodes = _safe_json_array(season.get("episodes_json")) if season else []
        specs: list[dict[str, Any]] = []
        for index, episode in enumerate(episodes):
            if not isinstance(episode, dict):
                episode = {}
            summary = "\n".join(
                text for text in (
                    str(episode.get("logline") or "").strip(),
                    f"开场钩子：{episode.get('openingHook') or episode.get('opening_hook')}"
                    if str(episode.get("openingHook") or episode.get("opening_hook") or "").strip() else "",
                    f"本集目标：{episode.get('goal')}" if str(episode.get("goal") or "").strip() else "",
                    f"核心冲突：{episode.get('coreConflict') or episode.get('core_conflict')}"
                    if str(episode.get("coreConflict") or episode.get("core_conflict") or "").strip() else "",
                    f"主角选择：{episode.get('protagonistChoice') or episode.get('protagonist_choice')}"
                    if str(episode.get("protagonistChoice") or episode.get("protagonist_choice") or "").strip() else "",
                    f"不可逆变化：{episode.get('irreversibleChange') or episode.get('irreversible_change')}"
                    if str(episode.get("irreversibleChange") or episode.get("irreversible_change") or "").strip() else "",
                    f"结尾钩子：{episode.get('endingHook') or episode.get('ending_hook')}"
                    if str(episode.get("endingHook") or episode.get("ending_hook") or "").strip() else "",
                ) if text
            )
            specs.append({
                "episode_no": index + 1,
                "scene_no": index + 1,
                "title": str(episode.get("title") or f"第 {index + 1} 集").strip(),
                "summary": summary,
                "location": None,
                "time_of_day": None,
                "estimated_duration": 120,
            })

        if not specs:
            outline = await asyncio.to_thread(db.latest_outline_row, project_id)
            raw_outline = _safe_json_object(outline.get("raw_json")) if outline else {}
            raw_scenes = raw_outline.get("scenes")
            for index, item in enumerate(raw_scenes if isinstance(raw_scenes, list) else []):
                if not isinstance(item, dict):
                    continue
                specs.append({
                    "episode_no": _parse_id_value(item.get("episode_no") or item.get("episodeNo")) or 1,
                    "scene_no": _parse_id_value(item.get("scene_no") or item.get("sceneNo")) or index + 1,
                    "title": str(item.get("title") or f"场景 {index + 1}"),
                    "summary": str(item.get("summary") or ""),
                    "location": item.get("location"),
                    "time_of_day": item.get("time_of_day") or item.get("timeOfDay"),
                    "estimated_duration": _parse_id_value(
                        item.get("estimated_duration") or item.get("estimatedDuration")
                    ) or 120,
                })
        if not specs:
            return JSONResponse(status_code=400, content=failure(4001, "请先生成并保存分集大纲"))

        existing = await asyncio.to_thread(db.list_scenes, project_id, user_id)
        if existing is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        if existing:
            if request.headers.get("x-confirm-regenerate") != "true":
                message = "项目已有场景，重新生成会覆盖剧本与分镜，请确认后再试"
            else:
                message = "项目已有场景，旧版总纲不能覆盖现有剧本与分镜"
            return JSONResponse(status_code=409, content=failure(4090, message))

        rows = await asyncio.to_thread(
            db.generate_project_scenes, project_id, user_id, int(outline["id"]) if outline else None, specs
        )
        if rows is None:
            return JSONResponse(status_code=409, content=failure(4090, "项目场景已发生变化，请刷新后重试"))
        return success({"items": [scene_row(row) for row in rows]}, "场景列表已生成")

    @app.get("/api/projects/{project_id:int}/final-edit")
    async def get_project_final_edit_route(project_id: int, request: Request):
        """读取成片编辑聚合视图，不生成媒体或创建导出任务。"""
        user = await require_user(request)
        episode_no = _parse_id_value(request.query_params.get("episodeNo")) or None
        context = await asyncio.to_thread(db.get_final_edit_context, project_id, int(user["id"]), episode_no)
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success(_build_project_final_edit(context, service_settings))

    @app.put("/api/projects/{project_id:int}/final-edit-draft")
    async def save_project_final_edit_draft_route(project_id: int, request: Request):
        """校验并持久化 owner 项目的成片剪辑草稿，保存后返回完整视图。"""
        user = await require_user(request)
        user_id = int(user["id"])
        episode_no = _parse_id_value(request.query_params.get("episodeNo")) or None
        context = await asyncio.to_thread(db.get_final_edit_context, project_id, user_id, episode_no)
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            raw_body = await request.json()
        except (ValueError, json.JSONDecodeError):
            raw_body = {}
        body = raw_body if isinstance(raw_body, dict) else {}
        current = _build_project_final_edit(context, service_settings)
        normalized = _normalize_final_edit_draft(
            body,
            current["videoTrack"]["items"],
            current["audioTracks"],
        )
        if episode_no:
            full_context = await asyncio.to_thread(db.get_final_edit_context, project_id, user_id)
            if full_context is None:
                return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
            full_current = _build_project_final_edit(full_context, service_settings)
            existing_draft = full_current["draft"]
            episode_ids = {int(item["storyboardId"]) for item in current["videoTrack"]["items"]}
            merged_clips = [
                item for item in existing_draft.get("videoClips", [])
                if int(item.get("storyboardId") or 0) not in episode_ids
            ] + normalized["videoClips"]
            normalized["videoClips"] = merged_clips
            normalized["audioMix"] = existing_draft.get("audioMix") or normalized["audioMix"]
        saved = await asyncio.to_thread(
            db.save_final_edit_draft,
            project_id,
            user_id,
            json.dumps(normalized, ensure_ascii=False, separators=(",", ":")),
        )
        if not saved:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        updated_context = await asyncio.to_thread(db.get_final_edit_context, project_id, user_id, episode_no)
        if updated_context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        return success(_build_project_final_edit(updated_context, service_settings), "成片编辑草稿已保存")

    @app.post("/api/projects/{project_id:int}/exports")
    async def create_project_export_route(project_id: int, request: Request):
        """校验导出资料并写入共享队列；媒体执行由 Node Worker 负责。"""
        user = await require_user(request)
        user_id = int(user["id"])
        project = await asyncio.to_thread(db.get_project, project_id, user_id)
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            raw_body = await request.json()
        except (ValueError, json.JSONDecodeError):
            raw_body = {}
        body = raw_body if isinstance(raw_body, dict) else {}

        episode_no = _parse_id_value(body.get("episodeNo")) or None
        export_package = await asyncio.to_thread(
            _build_export_package, db, project_id, service_settings, episode_no or None
        )
        if episode_no:
            if export_package["totalShots"] == 0:
                export_package["blockingIssues"].append(
                    {"code": "empty-episode", "message": f"第 {episode_no} 集还没有可导出的分镜视频。"}
                )
            elif export_package["missingShots"] > 0:
                export_package["blockingIssues"] = [
                    {"code": "missing-episode-video", "message": f"第 {episode_no} 集仍有 {export_package['missingShots']} 个分镜没有已确认视频，不能导出整集。"},
                    *export_package["blockingIssues"],
                ]
            export_package["canExport"] = not export_package["blockingIssues"]
        if episode_no and not export_package["canExport"]:
            issues = export_package["blockingIssues"]
            message = issues[0].get("message") if issues else "本集尚不满足整集导出条件"
            return JSONResponse(status_code=400, content=failure(4001, message))
        if not export_package["canExport"] and int(export_package.get("readyShots") or 0) <= 0:
            blocking_issues = export_package.get("blockingIssues") or []
            message = (
                blocking_issues[0].get("message")
                if blocking_issues and isinstance(blocking_issues[0], dict)
                else "当前项目还没有已确认视频，无法导出"
            )
            return JSONResponse(status_code=400, content=failure(4001, message))

        context = await asyncio.to_thread(db.get_final_edit_context, project_id, user_id, episode_no)
        if context is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        final_edit = _build_project_final_edit(context, service_settings)
        if episode_no:
            items_by_storyboard = {
                int(item["storyboardId"]): item for item in export_package["items"]
                if item.get("storyboardId")
            }
            final_edit["videoTrack"]["items"] = [
                item for item in final_edit["videoTrack"]["items"]
                if int(item.get("storyboardId") or 0) in items_by_storyboard
            ]
            ordered_ids = [
                int(item["storyboardId"])
                for item in export_package["items"]
                if item.get("storyboardId")
            ]
            final_edit["draft"] = {
                "videoClips": [
                    {"storyboardId": storyboard_id, "enabled": True, "order": index}
                    for index, storyboard_id in enumerate(ordered_ids, start=1)
                ],
                "audioMix": final_edit["audioMix"],
            }
            scene_ids = {int(item["sceneId"]) for item in export_package["items"] if item.get("sceneId")}
            for track in final_edit["audioTracks"].values():
                track[:] = [
                    audio for audio in track
                    if (not audio.get("storyboardId") or int(audio.get("storyboardId") or 0) in items_by_storyboard)
                    and (not audio.get("sceneId") or int(audio.get("sceneId") or 0) in scene_ids)
                ]
            final_edit["validation"]["canExport"] = True
            final_edit["validation"]["enabledVideoCount"] = len(ordered_ids)
            final_edit["validation"]["blockingIssues"] = []
        validation = final_edit["validation"]
        if not validation["canExport"]:
            blocking_issues = validation.get("blockingIssues") or []
            message = (
                blocking_issues[0].get("message")
                if blocking_issues and isinstance(blocking_issues[0], dict)
                else "当前成片编辑草稿不可用，无法导出"
            )
            return JSONResponse(status_code=400, content=failure(4001, message))

        default_resolution = _default_export_resolution(
            project.get("aspect_ratio") or project.get("aspectRatio")
        )
        config = {
            "episodeNo": episode_no,
            "format": str(body.get("format") or "H.264 / MP4").strip() or "H.264 / MP4",
            "resolution": str(body.get("resolution") or default_resolution).strip() or default_resolution,
            "frameRate": _parse_id_value(body.get("frameRate")) or (30 if episode_no else 24),
            "burnSubtitle": bool(body.get("burnSubtitle")),
            # Episode films keep the video model's generated ambience instead of
            # falling back to a silent AAC bed when no speech track is bound.
            "preserveSourceAudio": (
                body.get("preserveSourceAudio") is not False
                if episode_no
                else body.get("preserveSourceAudio") is True
            ),
            "hybridVideoPerScene": max(
                1,
                min(
                    6,
                    _parse_id_value(body.get("hybridVideoPerScene"))
                    or (6 if episode_no else 4),
                ),
            ),
            "strictStoryboardAudio": body.get("strictStoryboardAudio") is not False,
            "finalEditDraft": final_edit["draft"],
            "finalEditSummary": {
                "enabledVideoCount": validation["enabledVideoCount"],
                "enabledVideoDurationSeconds": validation["enabledVideoDurationSeconds"],
                "enabledAudioTrackCount": validation["enabledAudioTrackCount"],
            },
        }
        row = await asyncio.to_thread(
            db.create_export_record,
            project_id,
            {
                "video_url": "pending://hybrid-export",
                "cover_url": export_package.get("coverUrl"),
                "config_json": json.dumps(config, ensure_ascii=False, separators=(",", ":")),
                "source_count": int(export_package.get("totalShots") or 0),
                "ready_count": int(export_package.get("readyShots") or 0),
                "missing_count": int(export_package.get("missingShots") or 0),
            },
        )
        return success(_export_record_row(row, service_settings), "导出任务已生成")

    @app.get("/api/projects/{project_id}/script-agent/activities")
    async def list_script_agent_activities_route(project_id: int, request: Request):
        """Script Agent 活动列表（对齐 Node GET 分支，index.mjs L12960）。

        :param project_id: 项目 id。
        :param request: 当前请求（query.limit，钳位 1-100，缺省 40）。
        :returns: 成功 200 + ``{items}``；项目缺失 404/4004。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        try:
            raw_limit = int(str(request.query_params.get("limit") or "").strip() or 40)
        except ValueError:
            raw_limit = 40
        safe_limit = max(1, min(100, raw_limit))
        rows = await asyncio.to_thread(db.list_script_agent_activities, project_id, int(user["id"]), safe_limit)
        return success({"items": [_script_agent_activity_row(row) for row in rows]})

    @app.post("/api/projects/{project_id}/script-agent/activities")
    async def create_script_agent_activity_route(project_id: int, request: Request):
        """Script Agent 活动写入（对齐 Node POST 分支，index.mjs L12970-L13098）。

        phase ∈ start/complete/fail/blocked：start 走幂等键去重 + INSERT；
        其余 phase 需 activityId 命中已有活动后 UPDATE 终态。非法 phase 400/4001、
        参数非法 400/4001、活动不存在 404/4004。

        :param project_id: 项目 id。
        :param request: 当前请求（body.phase/activityId/...）。
        :returns: 成功 200 + ``{item, reaction}``，message 按 phase 取 Node 同款文案。
        :raises Exception: DB 故障由网关兜底 500/5001（幂等唯一冲突按 Node 同款
                           ER_DUP_ENTRY 兜底查重）。
        """
        import pymysql

        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        phase = str(body.get("phase") or "start").strip()
        if phase not in {"start", "complete", "fail", "blocked"}:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 Script Agent 活动阶段"))

        if phase == "start":
            try:
                input_payload = build_script_agent_activity_payload({**body, "status": "running"})
            except ValueError as exc:
                return JSONResponse(status_code=400, content=failure(4001, str(exc) if str(exc) else "Script Agent 活动参数无效"))
            idempotency_key = input_payload.get("idempotencyKey") or ""
            if idempotency_key:
                existing = await asyncio.to_thread(
                    db.list_script_agent_activities, project_id, int(user["id"]), 100
                )
                for row in existing:
                    if (row.get("idempotency_key") or "") == idempotency_key:
                        item = _script_agent_activity_row(row)
                        return success({"item": item, "reaction": item["reaction"]}, "Script Agent 活动已存在")
            try:
                row = await asyncio.to_thread(db.insert_script_agent_activity, project_id, int(user["id"]), input_payload)
            except pymysql.MySQLError as exc:
                # 对齐 Node L13030：并发下唯一键冲突（ER_DUP_ENTRY 1062）时按幂等键回查。
                if exc.args and exc.args[0] == 1062 and idempotency_key:
                    existing = await asyncio.to_thread(
                        db.list_script_agent_activities, project_id, int(user["id"]), 100
                    )
                    for row in existing:
                        if (row.get("idempotency_key") or "") == idempotency_key:
                            item = _script_agent_activity_row(row)
                            return success({"item": item, "reaction": item["reaction"]}, "Script Agent 活动已存在")
                raise
            item = _script_agent_activity_row(row)
            return success({"item": item, "reaction": item["reaction"]}, "Script Agent 已开始执行")

        activity_id = _parse_id_value(body.get("activityId"))
        existing_row = await asyncio.to_thread(
            db.load_script_agent_activity, int(activity_id), project_id, int(user["id"])
        )
        if existing_row is None:
            return JSONResponse(status_code=404, content=failure(4004, "Script Agent 活动不存在或无权访问"))
        status = "completed" if phase == "complete" else "blocked" if phase == "blocked" else "failed"
        try:
            input_payload = build_script_agent_activity_payload(
                {
                    "actionKey": existing_row.get("action_key"),
                    "agentKey": existing_row.get("agent_key"),
                    "stageKey": existing_row.get("stage_key"),
                    "source": existing_row.get("source"),
                    "status": status,
                    "title": body.get("title") or existing_row.get("title"),
                    "summary": body.get("summary") or "",
                    "context": body.get("context") or _safe_json_object(existing_row.get("context_json")),
                    "result": body.get("result") or {},
                    "errorText": body.get("errorText") or "",
                }
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content=failure(4001, str(exc) if str(exc) else "Script Agent 活动参数无效"))
        row = await asyncio.to_thread(
            db.update_script_agent_activity,
            int(activity_id),
            project_id,
            int(user["id"]),
            input_payload,
        )
        item = _script_agent_activity_row(row) if row else _script_agent_activity_row(existing_row)
        return success({"item": item, "reaction": item["reaction"]}, "Script Agent 活动已更新")

    @app.get("/api/storyboards/{storyboard_id}/videos")
    async def list_storyboard_videos_route(storyboard_id: int, request: Request):
        """分镜视频候选列表（对齐 Node GET 分支，index.mjs L16830）。

        :param storyboard_id: 分镜 id。
        :param request: 当前请求（鉴权用）。
        :returns: 成功 200 + ``{items}``（videoAssetRow）；分镜缺失 404/4004。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if storyboard_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 storyboardId"))
        shot = await asyncio.to_thread(db.get_shot_for_video_job, storyboard_id, int(user["id"]))
        if shot is None:
            return JSONResponse(status_code=404, content=failure(4004, "分镜不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_storyboard_video_assets, storyboard_id)
        return success({"items": [
            video_asset_row(
                row,
                resolve_storage_url=resolve_object_url,
                public_base_url=service_settings.public_base_url,
            )
            for row in rows
        ]})

    @app.put("/api/projects/{project_id}/story-bible")
    async def save_story_bible_route(project_id: int, request: Request):
        """故事设定保存（对齐 Node PUT storyQualityMatch 分支，index.mjs L13177）。

        归一化 → 质量评估 → 新版本持久化（status=draft）。参数异常 4011
        （statusCode 400，Node 路由 catch 形态）。

        :param project_id: 项目 id。
        :param request: 当前请求（body 为设定输入）。
        :returns: 成功 200 + ``{item, report}``，message「故事设定已保存」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        return await _save_story_quality_resource(project_id, request, resource="story-bible", action="")

    @app.post("/api/projects/{project_id}/story-bible/{action}")
    async def story_bible_action_route(project_id: int, action: str, request: Request):
        """故事设定评估/锁定（对齐 Node POST evaluate/lock 分支，index.mjs L13177）。

        :param project_id: 项目 id。
        :param action: 子动作（仅 evaluate/lock；其余对齐 Node 落兜底 4040）。
        :param request: 当前请求。
        :returns: 成功 200 + ``{item, report}``；message 按 action 区分。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        if action not in {"evaluate", "lock"}:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        return await _save_story_quality_resource(project_id, request, resource="story-bible", action=action)

    @app.put("/api/projects/{project_id}/season-structure")
    async def save_season_structure_route(project_id: int, request: Request):
        """分集大纲保存（对齐 Node PUT storyQualityMatch 分支，index.mjs L13177）。

        :param project_id: 项目 id。
        :param request: 当前请求（body 为大纲输入）。
        :returns: 成功 200 + ``{item, report}``，message「分集大纲已保存」。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        return await _save_story_quality_resource(project_id, request, resource="season-structure", action="")

    @app.post("/api/projects/{project_id}/season-structure/{action}")
    async def season_structure_action_route(project_id: int, action: str, request: Request):
        """分集大纲评估/锁定（对齐 Node POST evaluate/lock 分支，index.mjs L13177）。

        :param project_id: 项目 id。
        :param action: 子动作（仅 evaluate/lock；其余对齐 Node 落兜底 4040）。
        :param request: 当前请求。
        :returns: 成功 200 + ``{item, report}``；message 按 action 区分。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        if action not in {"evaluate", "lock"}:
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        return await _save_story_quality_resource(project_id, request, resource="season-structure", action=action)

    async def _save_story_quality_resource(project_id: int, request: Request, *, resource: str, action: str) -> JSONResponse:
        """story-bible / season-structure 写侧共享实现（对齐 Node L13177-L13194）。

        Node 中 PUT 与 POST evaluate/lock 是**同一分支**：归一化（normalize_*_input）
        → 质量评估（evaluate_*）→ persistStoryBible/persistSeasonStructure 新版本
        落库（evaluate/PUT 的 locked=false → status='draft'；lock → 'locked'）；
        message 仅 lock 时为「已确认」，evaluate 与 PUT 同为「已保存」。

        :param project_id: 项目 id。
        :param request: 当前请求。
        :param resource: ``story-bible`` 或 ``season-structure``。
        :param action: ``""``（PUT 保存）/ ``evaluate`` / ``lock``。
        :returns: 成功 200 + ``{item, report}``；项目缺失 404/4004。
        :raises Exception: 归一化/持久化异常对齐 Node 全局 catch 形态（网关兜底 500/5001）。
        """
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        body = await request.json()
        locked = action == "lock"
        if resource == "story-bible":
            bible = normalize_story_bible_input(body)
            report = evaluate_story_bible(bible)
            row = await asyncio.to_thread(
                db.persist_story_bible,
                project_id,
                story_bible_db_values(bible, report, locked=locked),
            )
            item = story_bible_row(row)
            message = "故事设定已确认" if locked else "故事设定已保存"
        else:
            season = normalize_season_structure_input(body)
            report = evaluate_season_structure(season)
            bible_row = await asyncio.to_thread(db.latest_story_bible_row, project_id)
            row = await asyncio.to_thread(
                db.persist_season_structure,
                project_id,
                int(bible_row["id"]) if bible_row else None,
                season_structure_db_values(season, report, locked=locked),
            )
            item = season_structure_row(row)
            message = "分集大纲已确认" if locked else "分集大纲已保存"
        return success({"item": item, "report": report}, message)

    @app.get("/api/projects/{project_id}/exports")
    async def list_project_exports_route(project_id: int, request: Request):
        """项目导出记录列表（对齐 Node GET 分支，index.mjs L15057）。

        :param project_id: 项目 id。
        :param request: 当前请求（鉴权用）。
        :returns: 成功 200 + ``{items}``（exportRecordRow）；项目缺失 404/4004。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        project = await asyncio.to_thread(db.get_project, project_id, int(user["id"]))
        if project is None:
            return JSONResponse(status_code=404, content=failure(4004, "项目不存在或无权访问"))
        rows = await asyncio.to_thread(db.list_export_records, project_id)
        return success({"items": [_export_record_row(row, service_settings) for row in rows]})

    @app.get("/api/exports/{export_id}")
    async def get_export_record_route(export_id: int, request: Request):
        """导出记录详情（对齐 Node GET /api/exports/{id}，index.mjs L17198）。

        :param export_id: 导出记录 id。
        :param request: 当前请求（鉴权用）。
        :returns: 成功 200 + exportRecordRow；id 非法 400/4001；记录缺失或越权
                  404/4004（Node 同款统一文案）。
        :raises Exception: DB 故障由网关兜底 500/5001。
        """
        user = await require_user(request)
        if export_id <= 0:
            return JSONResponse(status_code=400, content=failure(4001, "无效的 exportId"))
        record = await asyncio.to_thread(db.get_export_record_with_owner, export_id)
        if record is None or int(record.get("ownerId") or 0) != int(user["id"]):
            return JSONResponse(status_code=404, content=failure(4004, "导出记录不存在或无权访问"))
        return success(_export_record_row(record, service_settings))

    # 显式 501 组：豁免清单 OPS_FALLBACK_501_ROUTES 逐条注册（决策 9），
    # 注册顺序位于兜底 4040 之前、原生路由之后；路径参数用 int 标注以对齐
    # Node「非整数 id → 兜底 4040」的行为（校验失败由全局 422 处理器转 4040）。
    def _ops_not_implemented_handler(reason: str):
        """构造 501 处理器（闭包携带豁免理由）。

        :param reason: 豁免清单中的判定理由（缺口记录）。
        :returns: 异步请求处理器，恒返回 501/5010 envelope。
        """

        async def _handler(request: Request) -> JSONResponse:
            return JSONResponse(
                status_code=501,
                content=failure(
                    OPS_NOT_IMPLEMENTED_CODE,
                    f"{OPS_NOT_IMPLEMENTED_MESSAGE}：{reason}",
                ),
            )

        return _handler

    for _route_path, _route_methods, _route_reason in OPS_FALLBACK_501_ROUTES:
        app.add_api_route(
            _route_path,
            _ops_not_implemented_handler(_route_reason),
            methods=list(_route_methods),
            name=f"ops-not-implemented-{len(app.routes)}",
            include_in_schema=False,
        )

    # 兜底收口（阶段 3.2.5 决策 9 引入，第四阶段删除 flag 回退后为终态）：/api/{path:path}
    # 显式 4040 envelope——与 Node 未匹配路径的兜底（index.mjs L18352
    # fail(res, 4040, '接口不存在', 404)）逐字对齐。所有 Node HTTP 路由均已在
    # FastAPI 显式注册（原生 / 501 豁免），任何到达本处理器的请求都是悬空调用
    # （A-16：market 审计等，约 49 个前端函数）或未知路径。
    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def api_fallback_not_found(path: str, request: Request):
        """兜底 4040 处理器（终态行为，非代理）。

        :param path: 未被任何显式路由命中的剩余路径。
        :param request: 当前请求。
        :returns: 404/4040 envelope「接口不存在」，与 Node 未匹配路径行为一致。
        """
        return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))

    # 媒体组（阶段 3.2）：/generated、/storage、/mock、/mock-assets 四路媒体原生接管。
    # 这些路由不带 /api 前缀，与上方 /api 兜底互不冲突（兜底仅匹配 /api/*）。
    register_media_routes(app, service_settings)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_: Request, exc: HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else failure(5001, str(exc.detail))
        return JSONResponse(status_code=exc.status_code, content=detail)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error_handler(request: Request, exc: RequestValidationError):
        """输入校验失败（路径参数类型不符等）的对齐处理。

        Node 侧 URL 用 ``\\d+`` 正则匹配路径参数，非整数 ID 落到兜底 404/4040；
        FastAPI 路径参数默认 str 转换器 + 注解校验会返回 422 裸形状。为保持
        与 Node 行为一致，/api/* 下的校验失败统一对齐 Node 兜底 envelope；
        非 /api 路径（内部端点）保留 FastAPI 默认 422 形状。

        :param request: 当前请求。
        :param exc: 请求校验异常。
        :returns: /api/* → 404/4040 envelope；其他 → FastAPI 默认 422 形状。
        """
        if request.url.path.startswith("/api/"):
            return JSONResponse(status_code=404, content=failure(4040, "接口不存在"))
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(exc.errors())})

    @app.exception_handler(StoryboardContractError)
    @app.exception_handler(StoryboardGateError)
    async def storyboard_business_error_handler(_: Request, exc: Exception):
        """分镜生成受控业务抛错的对齐处理。

        Node 场景分镜 generate 路由无 try/catch，时长契约失败 / 资产门禁失败 /
        mock 时长规划无效统一落入全局 catch → ``fail(res, 5001, error.message, 500)``
        （HTTP 500 + code 5001 + 透传受控 message）。此处对这两个受控异常保留同形；
        非受控异常（DB 故障等）仍走脱敏兜底。

        :param _: 当前请求（未使用）。
        :param exc: StoryboardContractError / StoryboardGateError 实例。
        :returns: 500/5001 envelope（message 为受控业务文案）。
        """
        return JSONResponse(status_code=500, content=failure(5001, str(exc)))

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("api request failed: %s", exc)
        response = JSONResponse(status_code=500, content=failure(5001, "服务暂时不可用，请稍后重试"))
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-API-Gateway"] = "fastapi"
        return response

    return app


app = create_app()
