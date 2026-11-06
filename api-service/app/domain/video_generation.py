"""视频 / 口型生成任务入队快照构建器的 Python 复刻（生成任务组 · 阶段 3.4）。

对照 Node 源码（只读复刻，行号以 2026-10-17 工作区版本为准）：

- ``server/services/storyboard-continuity.mjs``：shouldUseStoryboardContinuity /
  resolveContinuitySourceShotNo / buildStoryboardFrameReference /
  buildStoryboardContinuityPrompt
- ``server/services/storyboard-mention-context.mjs``：normalizeStoryboardMentionContext /
  buildMentionContextPrompt
- ``server/services/storyboard-asset-references.mjs``：buildReferencedAssetPromptContext /
  buildStoryboardReferenceSnapshot / validateStoryboardReferenceSnapshot
- ``server/services/video-generation-request.mjs``：hasUnifiedStoryboardPrompt /
  buildStoryboardVideoPromptParts / buildVideoReferenceImageGuide /
  buildStoryboardDirectionPrompt
- ``server/services/storyboard-performance.mjs``：buildStoryboardPerformancePrompt
- ``server/services/video.mjs``：assertVideoModelProvider / isOfficialAgnesModel /
  buildVideoContinuityConstraints（getVideoConfig 的入队可见字段）
- ``server/services/color-continuity.mjs``：buildColorContinuityConstraints
- ``server/services/agent/quality-gate.mjs``：inspectStoryboardGenerationContext
- ``server/services/video-candidate-inspection.mjs``：inferVideoCandidateExpectations
- ``server/services/lip-sync.mjs``：getLipSyncConfig（入队可见字段）/
  resolveLipSyncDuration / resolveDashScopeLipSyncDuration / buildLipSyncPrompt
- ``server/index.mjs``（内部函数，fixture 不可直调）：buildTwoKeyframeVideoPrompt /
  buildReferenceAudioPromptContext / resolveReferenceAudioUrl

逐字段语义锁定手段：``tests/fixtures/generate_video_fixtures.mjs``（Node 直调上述
services 纯函数产期望 JSON）+ ``tests/test_generation_native_compat.py`` 逐 case 对照。
"""

from __future__ import annotations

import math
import os
import re
from typing import Any, Callable
from urllib.parse import urlsplit

from .storyboard_ai import normalize_storyboard_performance


# ---------------------------------------------------------------------------
# 通用工具（对齐 Node services 内的 text/list/positiveInt/parseJson）
# ---------------------------------------------------------------------------


def _text(value: Any) -> str:
    """Node ``text``：``String(value ?? '').trim()``。

    :param value: 任意输入（None 视为空串）。
    :returns: 字符串化并 strip 后的值。
    """
    return str(value if value is not None else "").strip()


def _list_of_text(value: Any) -> list[str]:
    """Node ``list``：数组逐项 text 后过滤空串；非数组返回空列表。

    :param value: 任意输入。
    :returns: 非空字符串列表。
    """
    if not isinstance(value, list):
        return []
    return [item for item in (_text(entry) for entry in value) if item]


def _positive_int(value: Any) -> int | None:
    """Node ``positiveInt``：``Number.isInteger(v) && v > 0`` 时返回整数，否则 None。

    :param value: 任意输入。
    :returns: 正整数或 None。
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed != int(parsed) or int(parsed) <= 0:
        return None
    return int(parsed)


def _optional_number(value: Any) -> float | int | None:
    """Node ``asset?.x ? Number(asset.x) : null``：原值 truthy 才数值化。

    :param value: 任意输入。
    :returns: 有限数值；原值 falsy 或数值化失败（NaN/Infinity）时 None。
    """
    if not value:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return int(parsed) if parsed == int(parsed) else parsed


def _parse_json_object(value: Any) -> dict[str, Any]:
    """Node ``parseJson``：对象原样返回；字符串尝试 JSON.parse；失败返回 ``{}``。

    :param value: 任意输入。
    :returns: dict（解析失败为空 dict）。
    """
    if isinstance(value, dict):
        return value
    try:
        parsed = __import__("json").loads(str(value or ""))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _js_number(value: Any, fallback: float = 0.0) -> float:
    """Node ``Number(value)`` 的有限数语义（NaN/Infinity 视为 fallback）。

    :param value: 任意输入。
    :param fallback: 非有限数时的回退值。
    :returns: 有限浮点数。
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _nullish(*values: Any) -> Any:
    """Node ``a ?? b ?? c``：返回第一个非 None 的值（空串/0 会被保留）。

    :param values: 候选值序列。
    :returns: 首个非 None 值；全为 None 时 None。
    """
    for value in values:
        if value is not None:
            return value
    return None


# ---------------------------------------------------------------------------
# storyboard-continuity.mjs
# ---------------------------------------------------------------------------

_CONTINUITY_FROM_RE = re.compile(r"@片段衔接(?:\[([^\]]+)\]|\(([^)]+)\))?", re.U)


def should_use_storyboard_continuity(
    *, tools: Any = None, prompt: Any = "", asset_reference: dict[str, Any] | None = None
) -> bool:
    """Node shouldUseStoryboardContinuity：是否启用「片段衔接 / 首尾帧参考」。

    :param tools: 请求或资产引用里的工具列表（字符串或 ``{name}``）。
    :param prompt: 提示词文本（命中 @片段衔接 / 上一镜 等关键词也启用）。
    :param asset_reference: 分镜资产引用 JSON（``tools`` 字段参与判定）。
    :returns: 启用时 True。
    """
    reference = asset_reference or {}
    names = _list_of_text(tools) + _list_of_text(reference.get("tools"))
    source = _text(prompt)
    return (
        "片段衔接" in names
        or "首尾帧参考" in names
        or bool(re.search(r"@片段衔接|@首尾帧参考|上一镜|前一镜|承接", source, re.U))
    )


def resolve_continuity_source_shot_no(
    *, prompt: Any = "", asset_reference: dict[str, Any] | None = None
) -> str | None:
    """Node resolveContinuitySourceShotNo：从 @片段衔接[镜头X] 提取来源镜号。

    :param prompt: 提示词文本。
    :param asset_reference: 资产引用（``continuityFromShot`` 兜底来源）。
    :returns: 来源镜号文本（剥离「镜头」前缀）；未命中返回 None。
    """
    reference = asset_reference or {}
    source = f"{_text(prompt)} {_text(reference.get('continuityFromShot'))}"
    match = _CONTINUITY_FROM_RE.search(source)
    raw = _text(match.group(1) if match else "") or _text(match.group(2) if match else "")
    return re.sub(r"^镜头", "", raw, count=1) or None


def build_storyboard_frame_reference(
    *,
    continuity_enabled: bool = False,
    previous_shot: dict[str, Any] | None = None,
    previous_video: dict[str, Any] | None = None,
    current_shot: dict[str, Any] | None = None,
    current_end_frame: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Node buildStoryboardFrameReference：上一镜尾帧 → 本镜起始帧引用。

    :param continuity_enabled: 是否启用片段衔接。
    :param previous_shot: 上一镜行（end_image_url / shot_no / id）。
    :param previous_video: 上一镜确认视频行（end_frame_url / end_frame_storage_key）。
    :param current_shot: 当前镜行（end_image_url 兜底）。
    :param current_end_frame: 当前镜确认的结束帧行。
    :returns: ``{enabled, sourceStoryboardId, sourceShotNo, startFrameUrl,
        startFrameStorageKey, endFrameUrl, endFrameStorageKey, missingStartFrame}``。
    """
    prev_shot = previous_shot or {}
    prev_video = previous_video or {}
    cur_shot = current_shot or {}
    cur_end = current_end_frame or {}

    def pick_text(*values: Any) -> str | None:
        for value in values:
            candidate = _text(value)
            if candidate:
                return candidate
        return None

    previous_end_frame_url = pick_text(
        prev_video.get("endFrameUrl"), prev_video.get("end_frame_url"),
        prev_shot.get("endImageUrl"), prev_shot.get("end_image_url"),
    )
    previous_end_frame_storage_key = pick_text(
        prev_video.get("endFrameStorageKey"), prev_video.get("end_frame_storage_key"),
    )
    current_end_frame_url = pick_text(
        cur_end.get("imageUrl"), cur_end.get("image_url"),
        cur_shot.get("endImageUrl"), cur_shot.get("end_image_url"),
    )
    current_end_frame_storage_key = pick_text(
        cur_end.get("storageKey"), cur_end.get("storage_key"),
    )
    source_storyboard_id = None
    if continuity_enabled:
        raw_id = prev_shot.get("id", prev_shot.get("storyboardId"))
        try:
            source_storyboard_id = int(raw_id)
        except (TypeError, ValueError):
            source_storyboard_id = None
        if source_storyboard_id == 0:
            source_storyboard_id = None
    return {
        "enabled": bool(continuity_enabled and previous_end_frame_url),
        "sourceStoryboardId": source_storyboard_id,
        "sourceShotNo": (
            _text(prev_shot.get("shotNo", prev_shot.get("shot_no"))) or None
            if continuity_enabled
            else None
        ),
        "startFrameUrl": previous_end_frame_url if continuity_enabled and previous_end_frame_url else None,
        "startFrameStorageKey": (
            previous_end_frame_storage_key if continuity_enabled and previous_end_frame_storage_key else None
        ),
        "endFrameUrl": current_end_frame_url,
        "endFrameStorageKey": current_end_frame_storage_key,
        "missingStartFrame": bool(continuity_enabled and not previous_end_frame_url),
    }


def build_storyboard_continuity_prompt(frame_reference: dict[str, Any] | None = None) -> str:
    """Node buildStoryboardContinuityPrompt：衔接提示词段。

    :param frame_reference: build_storyboard_frame_reference 的产物。
    :returns: 衔接提示词；未启用且不缺起始帧时为空串。
    """
    reference = frame_reference or {}
    if not reference.get("enabled"):
        if reference.get("missingStartFrame"):
            return "已选择片段衔接，但上一镜没有可读取的确认尾帧；必须先补齐上一镜尾帧，禁止用随机首帧替代。"
        return ""
    return "\n".join(
        [
            f"@片段衔接[镜头{reference.get('sourceShotNo') or reference.get('sourceStoryboardId') or '上一镜'}]",
            "本镜首帧必须直接使用上一镜确认尾帧，不得重新构图、换装、换脸或重排场景。",
            "首帧到本镜尾帧之间只执行当前镜头动作，保持人物、道具、灯光方向和空间布局连续。",
        ]
    )


# ---------------------------------------------------------------------------
# storyboard-mention-context.mjs
# ---------------------------------------------------------------------------

_MENTION_TOOL_RULES: dict[str, str] = {
    "添加时间": "保留镜头时长标签，视频时长以分镜 duration_seconds 为准，不擅自压缩对白或动作。",
    "片段衔接": "继承上一镜结束时的人物状态、视线方向、道具位置和空间关系，禁止跳变。",
    "首尾帧参考": "读取上一镜确认结束帧作为本镜开始状态，并让动作连续过渡到本镜结束状态。",
    "环境音": "读取当前场景的环境声方向，用于声音生成与混音，不把环境音误当成角色对白。",
}


def _continuity_from_prompt(value: Any) -> str | None:
    """Node continuityFromPrompt：提示词里的 @片段衔接 目标。

    :param value: 提示词文本。
    :returns: 目标镜号或 None。
    """
    match = _CONTINUITY_FROM_RE.search(str(value if value is not None else ""))
    raw = _text(match.group(1) if match else "") or _text(match.group(2) if match else "")
    return raw or None


def normalize_storyboard_mention_context(
    *,
    referenced_assets: Any = None,
    tools: Any = None,
    voice_bindings: Any = None,
    prompt: Any = "",
) -> dict[str, Any]:
    """Node normalizeStoryboardMentionContext：@ 引用上下文标准化。

    :param referenced_assets: 请求或自动推导的被引用资产列表。
    :param tools: 工具列表（字符串或 ``{name, key, rule}``）。
    :param voice_bindings: 音色绑定列表。
    :param prompt: 提示词（片段衔接工具的 from 来源）。
    :returns: ``{assets, tools, voices}``。
    """
    raw_assets = referenced_assets if isinstance(referenced_assets, list) else []
    assets = []
    for asset in raw_assets:
        asset = asset if isinstance(asset, dict) else {}
        view_set_version = asset.get("viewSetVersion")
        version_no = asset.get("versionNo")
        entry = {
            "id": _positive_int(asset.get("id")),
            "refId": _positive_int(asset.get("refId", asset.get("ref_id"))),
            "characterId": _positive_int(asset.get("characterId")),
            "sceneViewKey": _text(asset.get("sceneViewKey", asset.get("scene_view_key"))) or None,
            "key": _text(asset.get("key")),
            "kind": _text(asset.get("kind", asset.get("type", asset.get("nodeType")))),
            "name": _text(asset.get("name", asset.get("label"))),
            "imageUrl": _text(asset.get("imageUrl", asset.get("image_url"))) or None,
            "promptText": _text(asset.get("promptText")) or None,
            "viewKeys": _list_of_text(asset.get("viewKeys")),
            # Node: `asset?.x ? Number(asset.x) : null`——truthy 判定在原值上，
            # 数值化失败（NaN）时为 None 而不是抛错。
            "viewSetVersion": _optional_number(view_set_version),
            "versionNo": _optional_number(version_no),
            "voiceProfileKey": _text(asset.get("voiceProfileKey")) or None,
            "voiceLocked": asset.get("voiceLocked") is True,
            "referenceAudioUrl": _text(asset.get("referenceAudioUrl")) or None,
        }
        if entry["name"]:
            assets.append(entry)

    raw_tools = tools if isinstance(tools, list) else []
    normalized_tools = []
    for tool in raw_tools:
        tool = tool if isinstance(tool, dict) else {"name": tool}
        name = _text(tool.get("name") if isinstance(tool, dict) else tool)
        rule = tool.get("rule") if isinstance(tool, dict) else None
        entry = {
            "key": _text(tool.get("key") if isinstance(tool, dict) else None) or f"tool-{name}",
            "name": name,
            "rule": _MENTION_TOOL_RULES.get(name) or _text(rule),
            "from": _continuity_from_prompt(prompt) if name == "片段衔接" else None,
        }
        if entry["name"] and entry["rule"]:
            normalized_tools.append(entry)

    raw_voices = voice_bindings if isinstance(voice_bindings, list) else []
    voices = []
    for voice in raw_voices:
        voice = voice if isinstance(voice, dict) else {}
        entry = {
            "characterId": _positive_int(voice.get("characterId")),
            "characterName": _text(voice.get("characterName", voice.get("name"))),
            "voiceProfileKey": _text(voice.get("voiceProfileKey")) or None,
            "voiceLocked": voice.get("voiceLocked") is True,
            "referenceAudioUrl": _text(voice.get("referenceAudioUrl")) or None,
        }
        if entry["characterName"]:
            voices.append(entry)

    return {"assets": assets, "tools": normalized_tools, "voices": voices}


def build_mention_context_prompt(context: dict[str, Any] | None = None) -> str:
    """Node buildMentionContextPrompt：@ 引用上下文提示词段。

    :param context: normalize_storyboard_mention_context 的产物（assets/tools/voices）。
    :returns: 提示词段；无内容时为空串。
    """
    ctx = context or {}
    lines: list[str] = []
    for asset in ctx.get("assets") or []:
        kind_label = "角色" if asset.get("kind") == "character" else "场景" if asset.get("kind") == "scene" else "道具"
        detail = [
            "角色身份、外貌、服装和配饰只读取已确认角色参考图与资产版本" if asset.get("kind") == "character" else "",
            (
                "资产外观只读取已确认参考图；不复述资产生成模板或白底展示约束"
                if asset.get("kind") != "character" and asset.get("promptText")
                else ""
            ),
            "已绑定参考图，必须读取并保持一致" if asset.get("imageUrl") else "缺少参考图",
            f"视角组={'/'.join(asset.get('viewKeys') or [])}" if asset.get("viewKeys") else "",
            (
                f"音色={asset.get('voiceProfileKey')}{'（已锁定）' if asset.get('voiceLocked') else ''}"
                if asset.get("voiceProfileKey")
                else ""
            ),
            "已绑定真实参考音频" if asset.get("referenceAudioUrl") else "",
        ]
        lines.append(f"@{asset.get('name')}（{kind_label}）：{'；'.join(part for part in detail if part)}")
    for tool in ctx.get("tools") or []:
        lines.append(f"@{tool.get('name')}（工具）：{tool.get('rule')}")
    for voice in ctx.get("voices") or []:
        voice_label = voice.get("voiceProfileKey") or "参考音频"
        lock_label = "（已锁定）" if voice.get("voiceLocked") else "（未锁定）"
        lines.append(f"@音色[{voice.get('characterName')}]：{voice_label}{lock_label}")
    continuity = next((tool for tool in ctx.get("tools") or [] if tool.get("name") == "片段衔接"), None)
    if continuity and continuity.get("from"):
        lines.append(f"@片段衔接[{continuity['from']}]：读取该镜头确认尾帧作为本镜首帧")
    if not lines:
        return ""
    return "本镜 @ 引用执行上下文：\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# storyboard-asset-references.mjs
# ---------------------------------------------------------------------------


def build_referenced_asset_prompt_context(referenced_assets: Any = None) -> str:
    """Node buildReferencedAssetPromptContext：被引用资产约束提示词段。

    :param referenced_assets: 资产列表（name/kind/imageUrl/appearance/costume）。
    :returns: 提示词段；无资产时为空串。
    """
    if not isinstance(referenced_assets, list) or not referenced_assets:
        return ""
    lines: list[str] = []
    for asset in referenced_assets:
        if not asset or not _text((asset or {}).get("name")):
            continue
        kind = asset.get("kind")
        kind_label = "角色" if kind == "character" else "场景" if kind == "scene" else "道具"
        detail = [
            f"{kind_label}「{_text(asset.get('name'))}」",
            (
                "身份、外貌、服装与配饰只以已确认角色参考图为准，不重新设计角色。"
                if kind == "character"
                else ""
            ),
            f"外观/状态：{_text(asset.get('appearance'))}" if kind != "character" and asset.get("appearance") else "",
            f"服装/固定物件：{_text(asset.get('costume'))}" if kind != "character" and asset.get("costume") else "",
            (
                "已有已确认资产参考图，只锁定主体身份、可识别外观和材质；镜头构图、场景与动作以本镜提示词为准。"
                if asset.get("imageUrl")
                else "当前没有可用参考图，只按本镜提示词表现。"
            ),
        ]
        lines.append("；".join(part for part in detail if part))
    if not lines:
        return ""
    return "本镜引用资产约束（@ 引用已展开）：" + "\n".join(lines)


def build_storyboard_reference_snapshot(
    *,
    storyboard: dict[str, Any] | None = None,
    reference_images: Any = None,
    referenced_assets: Any = None,
) -> dict[str, Any]:
    """Node buildStoryboardReferenceSnapshot：视频资产引用版本快照（schemaVersion 1）。

    :param storyboard: 分镜行（asset_reference_json / assetReference / asset_reference）。
    :param reference_images: 参考图 URL 列表。
    :param referenced_assets: 被引用资产列表。
    :returns: 引用快照 dict（写入 request.storyboardAssetReference）。
    """
    sb = storyboard or {}
    reference = _parse_json_object(
        sb.get("asset_reference_json", sb.get("assetReference", sb.get("asset_reference")))
    )
    images = [item for item in (_text(url) for url in (reference_images if isinstance(reference_images, list) else [])) if item]
    raw_assets = referenced_assets if isinstance(referenced_assets, list) else []
    assets = []
    for asset in raw_assets:
        asset = asset if isinstance(asset, dict) else {}
        assets.append(
            {
                "key": _text(asset.get("key")),
                "kind": _text(asset.get("kind", asset.get("type", asset.get("nodeType")))),
                "name": _text(asset.get("name", asset.get("label"))),
                "imageUrl": _text(asset.get("imageUrl", asset.get("image_url"))),
                "viewKey": _text(asset.get("sceneViewKey", asset.get("viewKey"))),
                "viewSetVersion": _positive_int(asset.get("viewSetVersion")),
                "versionNo": _positive_int(asset.get("versionNo")),
            }
        )
    character_view_keys = reference.get("characterViewKeys")
    props: list[dict[str, Any]] = []
    if isinstance(reference.get("propAssetRefs"), list):
        for item in reference["propAssetRefs"]:
            item = item if isinstance(item, dict) else {}
            name = _text(item.get("name"))
            if not name:
                continue
            props.append(
                {
                    "assetNodeId": _positive_int(item.get("assetNodeId")),
                    "imageId": _positive_int(item.get("imageId")),
                    "name": name,
                    "versionNo": _positive_int(item.get("versionNo")),
                }
            )
    performance = reference.get("performance")
    return {
        "schemaVersion": 1,
        "character": {
            "id": _positive_int(reference.get("characterId")),
            "versionNo": _positive_int(reference.get("characterVersionNo")),
            "viewSetVersion": _positive_int(reference.get("characterViewSetVersion")),
            "viewKeys": _list_of_text(character_view_keys) if isinstance(character_view_keys, list) else [],
            "baseImageId": _positive_int(reference.get("characterBaseImageId")),
            "baseVersionNo": _positive_int(reference.get("characterBaseVersionNo")),
            "faceImageId": _positive_int(reference.get("characterFaceImageId")),
            "faceVersionNo": _positive_int(reference.get("characterFaceVersionNo")),
            "faceRequired": reference.get("characterFaceRequired") is not False,
        },
        "scene": {
            "assetId": _positive_int(reference.get("sceneAssetId")),
            "panoramaVersion": _positive_int(reference.get("scenePanoramaVersion")),
            "panoramaImageId": _positive_int(reference.get("scenePanoramaImageId")),
            "viewSetVersion": _positive_int(reference.get("sceneViewSetVersion")),
            "viewKey": _text(reference.get("sceneViewKey")) or None,
            "viewIndex": _positive_int(reference.get("sceneViewIndex")),
        },
        "props": props,
        "referenceImages": list(dict.fromkeys(images)),
        "referencedAssets": assets,
        "voice": {
            "profileKey": _text(reference.get("voiceProfileKey")),
            "locked": reference.get("voiceLocked") is True,
            "characterName": _text(reference.get("characterName")),
        },
        "performance": dict(performance) if isinstance(performance, dict) else None,
        "continuity": {
            "fromShot": _text(reference.get("continuityFromShot")) or None,
        },
    }


def validate_storyboard_reference_snapshot(snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node validateStoryboardReferenceSnapshot：引用快照完整性校验。

    :param snapshot: build_storyboard_reference_snapshot 的产物。
    :returns: ``{"passed": bool, "blockers": list[str]}``（blocker 文案与 Node 逐字一致）。
    """
    snap = snapshot or {}
    character = snap.get("character") or {}
    scene = snap.get("scene") or {}
    blockers: list[str] = []
    has_character = bool(
        character.get("id")
        or character.get("versionNo")
        or character.get("viewSetVersion")
        or (character.get("viewKeys") or [])
    )
    view_keys = character.get("viewKeys") or []
    if has_character and (not character.get("id") or not character.get("versionNo")):
        blockers.append("视频缺少已确认角色版本引用")
    if has_character and (not character.get("viewSetVersion") or len(view_keys) < 3):
        blockers.append("视频缺少已确认角色三视图引用")
    if has_character and (not character.get("baseImageId") or not character.get("baseVersionNo")):
        blockers.append("视频缺少已确认角色基础正面全身图引用")
    if (
        has_character
        and character.get("faceRequired") is not False
        and (not character.get("faceImageId") or not character.get("faceVersionNo"))
    ):
        blockers.append("视频缺少已确认角色脸部特写引用")
    if has_character and not {"front", "side", "back"} <= set(view_keys):
        blockers.append("视频缺少已确认角色正面、侧面、背面引用")
    if not scene.get("assetId") or not scene.get("panoramaVersion"):
        blockers.append("视频缺少已确认场景全景引用")
    for prop in snap.get("props") or []:
        if not prop.get("assetNodeId") or not prop.get("imageId") or not prop.get("versionNo"):
            blockers.append(f"视频缺少已确认道具「{prop.get('name') or '未命名'}」引用")
    if not (snap.get("referenceImages") or []):
        blockers.append("视频缺少可供模型读取的角色或场景参考图")
    return {"passed": not blockers, "blockers": blockers}


# ---------------------------------------------------------------------------
# video-generation-request.mjs
# ---------------------------------------------------------------------------

_UNIFIED_STORYBOARD_SECTION = re.compile(
    r"(?:^|\n\n)(?:画面与资产|动作与表演|对白与声音|起始帧衔接|结束帧衔接)："
)
_COMPACT_SHOT_SHEET = re.compile(
    r"(?:^|[；;\n])时间轴：[\s\S]*?(?:^|[；;\n])镜头：[\s\S]*?(?:^|[；;\n])位置："
    r"[\s\S]*?(?:^|[；;\n])动作：[\s\S]*?(?:^|[；;\n])要求：",
    re.U,
)


def has_unified_storyboard_prompt(prompt: Any) -> bool:
    """Node hasUnifiedStoryboardPrompt：提示词是否为统一分段结构。

    :param prompt: 提示词文本。
    :returns: 命中统一分段或紧凑镜头单时 True。
    """
    value = _text(prompt)
    return bool(_UNIFIED_STORYBOARD_SECTION.search(value) or _COMPACT_SHOT_SHEET.search(value))


def build_storyboard_video_prompt_parts(
    *, prompt: Any = "", context_parts: Any = None, legacy_field_parts: Any = None
) -> list[str]:
    """Node buildStoryboardVideoPromptParts：视频提示词分段（统一结构不追加 legacy 字段）。

    :param prompt: 主体提示词。
    :param context_parts: 上下文段列表（衔接/约束/引用上下文等）。
    :param legacy_field_parts: 旧字段段列表（景别/机位/构图等）。
    :returns: 过滤空段后的提示词段列表。
    """
    context = context_parts or []
    legacy = legacy_field_parts or []
    parts = [prompt, *context]
    if not has_unified_storyboard_prompt(prompt):
        parts.extend(legacy)
    return [part for part in parts if _text(part)]


def build_video_reference_image_guide(asset_rows: Any = None, transition_image_count: int = 0) -> str:
    """Node buildVideoReferenceImageGuide：参考图阅读指引段。

    :param asset_rows: 已选资产行（node_type/label）。
    :param transition_image_count: 首尾帧参考图数量。
    :returns: 指引文本；无内容时为空串。
    """
    rows = asset_rows if isinstance(asset_rows, list) else []
    lines: list[str] = []
    for index, asset in enumerate(rows):
        kind = _text((asset or {}).get("node_type"))
        name = _text((asset or {}).get("label")) or "未命名资产"
        if kind == "character":
            scope = f"角色「{name}」：只锁定身份、外貌、服装和配饰，不限定本镜动作。"
        elif kind == "scene":
            scope = f"场景「{name}」：只锁定空间结构、固定设施、材质和光线，不把参考图构图当作本镜首帧。"
        else:
            scope = f"道具「{name}」：只锁定道具外观与材质，不代表本镜初始位置；位置和移动以本镜动作与时间轴为准。"
        kind_label = "角色" if kind == "character" else "场景" if kind == "scene" else "道具"
        lines.append(f"参考图{index + 1}（{kind_label}）：{scope}")
    try:
        transition = math.floor(float(transition_image_count))
    except (TypeError, ValueError):
        transition = 0
    if transition > 0:
        lines.append(
            f"其后{transition}张为镜头首尾状态参考，只约束对应时刻的构图与状态；中间动作必须按时间轴连续完成。"
        )
    return "\n".join(lines)


def build_storyboard_direction_prompt(*, gaze_plan: Any = None, sound_plan: Any = None) -> str:
    """Node buildStoryboardDirectionPrompt：视线/声音执行合同提示词段。

    :param gaze_plan: 视线执行计划（normalize_gaze 产物）。
    :param sound_plan: 声音执行计划。
    :returns: 合同提示词段（两行）；均缺失时为空串。
    """
    gaze = gaze_plan if isinstance(gaze_plan, dict) else None
    sound = sound_plan if isinstance(sound_plan, dict) else None
    transitions = [
        item
        for item in (gaze.get("transitions") or [])
        if isinstance(item, dict) and item.get("target")
    ] if gaze else []
    gaze_lines = []
    for item in transitions:
        start = _js_number(item.get("fromSecond"), float("nan"))
        end = _js_number(item.get("toSecond"), float("nan"))
        if not math.isnan(start) and not math.isnan(end) and end > start:
            # 整数秒对齐 JS 模板字面量的数字呈现（1.0 → "1"）。
            start_label = int(start) if start == int(start) else start
            end_label = int(end) if end == int(end) else end
            range_label = f"{start_label}-{end_label}秒"
        else:
            start_value = 0 if math.isnan(start) else start
            start_label = int(start_value) if start_value == int(start_value) else start_value
            range_label = f"约{start_label}秒"
        observable = f"（{item.get('observable')}）" if item.get("observable") else ""
        gaze_lines.append(f"{range_label}视线落到{item.get('target')}{observable}")
    cues = [
        item
        for item in (sound.get("cues") or [])
        if isinstance(item, dict) and item.get("sound")
    ] if sound else []
    cue_lines = []
    for item in cues:
        at = _js_number(item.get("atSecond"), float("nan"))
        timing = (
            f"{int(at) if at == int(at) else at}秒" if not math.isnan(at) else "动作发生时"
        )
        sync = f"，与{item.get('syncAction')}同步" if item.get("syncAction") else ""
        cue_lines.append(f"{timing}{item.get('sound')}{sync}")
    gaze_part = ""
    if gaze:
        fallback_gaze = "；".join(gaze_lines) or gaze.get("promptText") or "保持当前目标稳定"
        eye_lead = gaze.get("eyeLead") or "眼睛先动，头部延迟半拍跟随"
        end_target = gaze.get("endTarget") or "动作结果"
        start_target_part = f"起始注视{gaze.get('startTarget')}；" if gaze.get("startTarget") else ""
        gaze_part = f"【视线执行合同】{start_target_part}{fallback_gaze}；{eye_lead}；结束锁定{end_target}"
    sound_part = ""
    if sound:
        fallback_sound = "；".join(cue_lines) or sound.get("promptText") or "动作拟音与画面同步"
        sound_part = (
            f"【声音执行合同】从0秒到镜头结束保持{sound.get('bed') or '连续空间底噪'}；"
            f"{fallback_sound}；{sound.get('silencePolicy') or '无对白不等于无声'}"
        )
    return "\n".join(part for part in (gaze_part, sound_part) if part)


# ---------------------------------------------------------------------------
# storyboard-performance.mjs
# ---------------------------------------------------------------------------


def build_storyboard_performance_prompt(input_data: dict[str, Any] | None = None) -> str:
    """Node buildStoryboardPerformancePrompt：结构化表演提示词段。

    :param input_data: 镜头 dict（表演字段 snake_case / camelCase 均可）。
    :returns: 逐行表演提示词。
    """
    performance = normalize_storyboard_performance(input_data)
    gaze = performance["gazePlan"]
    sound = performance["soundPlan"]
    return "\n".join(
        [
            f"当前情绪：{performance['emotion']}（强度 {performance['intensity']}/100）",
            f"情绪起点：{performance['emotionStart']}",
            f"情绪触发：{performance['emotionTrigger']}",
            f"情绪变化：{performance['emotionChange']}",
            f"情绪结束：{performance['emotionEnd']}",
            f"微表情：{performance['microExpression']}",
            f"呼吸与停顿：{performance['breathAction']}",
            f"身体与手部动作：{performance['bodyAction']}",
            (
                f"声音：{performance['voiceTone']}；音量：{performance['voiceVolume']}；"
                f"语速：{performance['speechRate']}；停顿：{performance['speechPauses']}"
            ),
            f"口型同步：{performance['lipSync']}",
            f"上一镜衔接：{performance['continuityFromPrevious']}",
            f"视线执行：{gaze['promptText']}；眼睛与头部：{gaze['eyeLead']}；结束锁定：{gaze['endTarget']}",
            f"声音执行：{sound['promptText']}；静音策略：{sound['silencePolicy']}",
        ]
    )


# ---------------------------------------------------------------------------
# video.mjs / color-continuity.mjs
# ---------------------------------------------------------------------------

_AGNES_OFFICIAL_MODEL_RE = re.compile(r"^agnes-video-(?:v?2\.0|2\.5)(?:-flash)?$", re.I)
_WAN_VIDEO_MODEL_RE = re.compile(r"^wan(?:[0-9.]+)-(?:video|t2v|i2v)(?:-|$)", re.I)


def is_official_agnes_model(model_name: Any) -> bool:
    """Node isOfficialAgnesModel：官方 Agnes 视频（v2.0/2.5）协议判定。

    :param model_name: 模型名。
    :returns: 官方 Agnes 模型时 True。
    """
    return bool(_AGNES_OFFICIAL_MODEL_RE.match(_text(model_name)))


def is_wan_video_model(model_name: Any) -> bool:
    """Wan 3.0 / 2.x 原生异步视频模型判定。

    :param model_name: 模型名。
    :returns: Wan 视频模型时 True。
    """
    return bool(_WAN_VIDEO_MODEL_RE.match(_text(model_name)))


def get_video_provider_config(env: dict[str, str] | None = None) -> dict[str, str]:
    """Node getVideoConfig 的入队可见字段（provider / defaultModel）。

    :param env: 环境变量 override（测试注入；缺省读 os.environ）。
    :returns: ``{"provider", "defaultModel"}``。
    """
    source = env if env is not None else os.environ
    provider = str(source.get("VIDEO_PROVIDER") or "mock").strip().lower()
    if provider in {"bigmodel", "zhipu"}:
        default_model = "cogvideox-flash"
    elif provider == "minimax":
        default_model = "MiniMax-H3"
    elif provider == "wan":
        default_model = "wan3.0-video"
    else:
        default_model = "agnes-video-2.5-flash"
    default_model = str(source.get("VIDEO_MODEL") or default_model).strip()
    return {"provider": provider, "defaultModel": default_model}


def assert_video_model_provider(model_name: Any, provider: Any) -> bool:
    """Node assertVideoModelProvider：模型名与视频服务商必须匹配。

    :param model_name: 请求或默认的视频模型名。
    :param provider: 当前 VIDEO_PROVIDER。
    :returns: 恒 True（通过）。
    :raises ValueError: MiniMax/Agnes/Wan 模型与当前服务商不匹配（Node 409 文案）。
    """
    model = _text(model_name)
    current = _text(provider).lower()
    if re.match(r"^minimax(?:-|$)", model, re.I):
        required = "minimax"
        label = "MiniMax"
    elif re.match(r"^agnes-video-", model, re.I):
        required = "agnes"
        label = "Agnes"
    elif is_wan_video_model(model):
        required = "wan"
        label = "Wan"
    else:
        return True
    if current != required:
        raise ValueError(
            f"{label} 模型需要配置视频服务商为 {required}，当前为 {current or '未配置'}。"
        )
    return True


def build_video_continuity_constraints(
    *, character_name: Any = "", scene_asset_prompt: Any = ""
) -> str:
    """Node buildVideoContinuityConstraints：角色/场景连续性硬约束段。

    :param character_name: 锁定的角色名（空则省略身份锁定行）。
    :param scene_asset_prompt: 场景资产提示词（空则省略场景固定设定行）。
    :returns: 约束提示词段。
    """
    parts = [
        "视频连续性硬约束：全程只允许同一个角色、同一套服装和同一组随身配饰，不得换装、脱掉、增加或替换任何服装和配饰。",
        "角色的脸型、发型、发长、眼镜、体型、年龄感、肤色和手部特征从第一帧到最后一帧必须保持一致；禁止把固定服装改成连帽衫、便服或其他替代服装。",
        (
            f"角色身份锁定：{_text(character_name)}，以已确认角色参考图和角色资产版本为唯一外貌、服装与配饰来源；"
            "视频提示词不得重新设计角色。"
            if _text(character_name)
            else ""
        ),
        (
            "场景资产固定设定：以已确认场景参考图为准，保持空间结构、材质、灯光方向和固定物件；不得复述或套用场景生图模板。"
            if _text(scene_asset_prompt)
            else ""
        ),
        "保持角色身份、服装、配饰和场景结构连续；固定设施与背景物件保持稳定。分镜明确要求移动的角色或道具，必须按镜头动作和时间轴完成可见移动，不得锁定在参考图位置，也不得弱化为静止展示。",
    ]
    return "\n".join(part for part in parts if part)


_COLOR_EVIDENCE_RE = re.compile(r"冷蓝|青蓝|蓝色|红色|暖黄|暖色|黄色|灰绿|色温|色彩|灯具|灯光|光源|光线|白平衡|曝光|材质", re.I)


def _compact_color_evidence(value: Any, max_chars: int = 420) -> str:
    """Node compactEvidence：压缩色彩证据文本（超长时只保留色彩相关句）。

    :param value: 原始文本。
    :param max_chars: 截断长度。
    :returns: 压缩后的证据文本。
    """
    source = re.sub(r"\s+", " ", _text(value))
    if len(source) <= max_chars:
        return source
    fragments: list[str] = []
    for part in re.split(r"[。；;\n]+", source):
        part = part.strip()
        if part and _COLOR_EVIDENCE_RE.search(part):
            fragments.append(part)
    compact = "；".join(dict.fromkeys(fragments))
    return (compact or source)[:max_chars]


def build_color_continuity_constraints(
    *, visual_style: Any = "", scene_prompt: Any = "", shot_prompt: Any = ""
) -> str:
    """Node buildColorContinuityConstraints：色彩连续性硬约束段。

    :param visual_style: 项目视觉风格文本。
    :param scene_prompt: 场景资产提示词。
    :param shot_prompt: 本镜提示词。
    :returns: 色彩约束提示词段。
    """
    style = _compact_color_evidence(visual_style, 320)
    scene = _compact_color_evidence(scene_prompt)
    shot = _compact_color_evidence(shot_prompt, 320)
    combined = "\n".join(part for part in (_text(visual_style), _text(scene_prompt), _text(shot_prompt)) if part)
    has_cold_blue = bool(re.search(r"冷蓝|青蓝|蓝色|teal|cyan|cool\s+blue", combined, re.I))
    has_red_accent = bool(re.search(r"红色|警示|red|warning", combined, re.I))
    has_warm_light = bool(re.search(r"暖黄|暖色|黄色|amber|tungsten|warm\s+light", combined, re.I))
    has_explicit_palette = has_cold_blue or has_red_accent or has_warm_light
    parts = [
        "色彩连续性硬约束：项目与场景中的既有色彩设定是唯一调色来源；不得为了“电影感”擅自更换主色、色温或对比关系。",
        f"项目色彩证据：{style}" if style else "",
        f"场景色彩证据：{scene}" if scene else "",
        f"本镜色彩证据：{shot}" if shot else "",
        "主色锚点：冷蓝、青蓝、低饱和金属灰；冷色用于环境和金属材质，不代表给整张画面套蓝色滤镜。" if has_cold_blue else "",
        "光源锚点：暖黄色只保留在提示词明确的灯具或实际暖色光源上，不能把全场景改成暖橙色。" if has_warm_light else "",
        "警示色锚点：红色仅限局部警示灯、状态指示灯或剧情明确的红色光源；不能铺满墙面、人物或全画面。" if has_red_accent else "",
        "没有明确色板时，保持参考资产的真实颜色和中性白平衡，不主动发明新配色。" if not has_explicit_palette else "",
        "人物保护：肤色、黑色服装和眼镜材质不得被强烈染色；白色/金属材质与固定配饰要保留真实局部颜色。",
        "镜头连续性：起始帧到结束帧保持同一白平衡、曝光和饱和度关系；镜头运动不能造成色温跳变、闪烁或曝光呼吸。",
        "禁止全画面单色滤镜；同时禁止全画面蓝染、红染、过曝、死黑、彩色雾化、彩虹渐变和随机霓虹色。",
        "不得擅自加入青橙、紫色或霓虹渐变，也不得把局部警示色扩展为全局调色。",
    ]
    return "\n".join(part for part in parts if part)


# ---------------------------------------------------------------------------
# agent/quality-gate.mjs
# ---------------------------------------------------------------------------

_SILENT_DIALOGUE_RE = re.compile(r"^(?:[（(]\s*)?(?:无对白|无台词|no\s+dialogue)(?:\s*[）)])?$", re.I)


def _has_spoken_dialogue(value: Any) -> bool:
    """Node hasSpokenDialogue：是否包含真实对白（占位词不算）。

    :param value: 对白文本。
    :returns: 有对白时 True。
    """
    dialogue = _text(value)
    if not dialogue:
        return False
    return not bool(_SILENT_DIALOGUE_RE.match(dialogue))


def _has_image(asset: dict[str, Any]) -> bool:
    """Node hasImage：资产是否有可用图片地址。

    :param asset: 资产行（imageUrl/image_url/thumbnailUrl/thumbnail_url）。
    :returns: 有图片时 True。
    """
    return bool(_text(_nullish(asset.get("imageUrl"), asset.get("image_url"), asset.get("thumbnailUrl"), asset.get("thumbnail_url"))))


def _is_public_http_image_url(value: Any) -> bool:
    """Node isPublicHttpImageUrl：图片地址必须是公网 http(s)。

    :param value: 图片地址。
    :returns: 公网地址时 True。
    """
    raw = _text(value)
    try:
        parts = urlsplit(raw)
    except ValueError:
        return False
    if parts.scheme not in {"http", "https"}:
        return False
    hostname = (parts.hostname or "").lower()
    if not hostname:
        return False
    if hostname in {"localhost", "::1", "0.0.0.0"}:
        return False
    if hostname.startswith(("127.", "10.", "192.168.", "169.254.")):
        return False
    return not bool(re.match(r"^172\.(1[6-9]|2\d|3[01])\.", hostname))


def inspect_storyboard_generation_context(
    *,
    storyboard: dict[str, Any] | None = None,
    assets: Any = None,
    character_voices: Any = None,
    require_confirmed_assets: bool = True,
    require_public_assets: bool = True,
) -> dict[str, Any]:
    """Node inspectStoryboardGenerationContext：视频入队前的受控质检门禁。

    :param storyboard: 分镜行（visual_prompt/action_text/dialogue_text 等）。
    :param assets: 资产行列表（label/status/imageUrl 等）。
    :param character_voices: 角色音色行列表。
    :param require_confirmed_assets: 是否要求资产已确认（allowCandidateAssets 的反面）。
    :param require_public_assets: 是否要求资产图片为供应商可访问的公网地址；
        Wan 使用 Base64 媒体输入时可关闭该检查。
    :returns: ``{passed, blockers, warnings, checkedAt, summary}``；checkedAt 为 UTC ISO。
    """
    from datetime import datetime, timezone

    shot = storyboard or {}
    prompt = _text(shot.get("visualPrompt", shot.get("visual_prompt")))
    action_text = _text(shot.get("actionText", shot.get("action_text")))
    dialogue = _text(shot.get("dialogueText", shot.get("dialogue_text")))
    asset_list = [item for item in (assets if isinstance(assets, list) else []) if isinstance(item, dict)]
    voice_list = [item for item in (character_voices if isinstance(character_voices, list) else []) if isinstance(item, dict)]

    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    def issue(code: str, message: str, severity: str = "blocker") -> dict[str, str]:
        return {"code": code, "message": message, "severity": severity}

    if not _text(shot.get("id")):
        blockers.append(issue("storyboard-missing", "缺少分镜记录，无法建立视频生成任务"))
    if not prompt:
        blockers.append(issue("visual-prompt-missing", "当前分镜还没有镜头提示词"))
    if not _text(shot.get("shotType", shot.get("shot_type"))):
        warnings.append(issue("shot-type-missing", "未填写景别，视频模型将自行推断", "warning"))
    if not _text(shot.get("cameraAngle", shot.get("camera_angle"))):
        warnings.append(issue("camera-angle-missing", "未填写机位，视频模型将自行推断", "warning"))
    action_events = re.findall(
        r"(?:然后|随后|接着|同时|并且|再|之后|继而|滑出|滑入|打印|抬头|低头|转身|望向|看向|打开|关闭|伸手|拿起|放下|递出|接过|走向|推开|拉开|按下|点击)",
        action_text,
    )
    if len(action_events) >= 4:
        warnings.append(issue(
            "shot-action-overloaded",
            "本镜动作事件较多，建议拆成“线索出现”和“角色反应”等连续镜头，避免短时长内事件被模型省略。",
            "warning",
        ))

    for asset in asset_list:
        label = _text(asset.get("label")) or f"资产 {asset.get('id') or ''}".strip()
        if not _has_image(asset):
            missing = issue("asset-image-missing", f"资产「{label}」还没有可用图片")
            if require_confirmed_assets:
                blockers.append(missing)
            else:
                warnings.append({**missing, "severity": "warning"})
        image_url = _nullish(asset.get("imageUrl"), asset.get("image_url"), asset.get("thumbnailUrl"), asset.get("thumbnail_url"))
        if (
            require_confirmed_assets
            and require_public_assets
            and _has_image(asset)
            and not _is_public_http_image_url(image_url)
        ):
            blockers.append(issue("asset-image-not-public", f"资产「{label}」图片地址不是供应商可访问的公网地址"))
        status = _text(asset.get("status"))
        if require_confirmed_assets and status and status != "confirmed":
            blockers.append(issue("asset-not-confirmed", f"资产「{label}」还没有确认，不能用于生成视频"))
        elif not require_confirmed_assets and status and status != "confirmed":
            warnings.append(issue("asset-not-confirmed", f"资产「{label}」尚未确认，将按候选资产尝试生成", "warning"))

    requires_voice = _has_spoken_dialogue(dialogue)
    if requires_voice and not voice_list:
        blockers.append(issue("voice-binding-missing", "当前分镜包含对白，但没有绑定角色音色"))
    if requires_voice:
        for voice in voice_list:
            has_profile = _text(_nullish(voice.get("voiceProfileKey"), voice.get("voice_profile_key")))
            has_reference = _text(_nullish(voice.get("referenceAudioUrl"), voice.get("reference_audio_url")))
            if not has_profile and not has_reference:
                label = _text(_nullish(voice.get("characterName"), voice.get("character_name"))) or f"角色 {voice.get('characterId') or ''}".strip()
                blockers.append(issue("voice-binding-missing", f"角色「{label}」没有绑定系统音色或参考音频"))

    if blockers:
        summary = f"质检未通过：{len(blockers)} 个问题需要处理"
    elif warnings:
        summary = f"质检通过，但有 {len(warnings)} 个提示"
    else:
        summary = "质检通过，可以提交视频生成"
    return {
        "passed": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# video-candidate-inspection.mjs
# ---------------------------------------------------------------------------

_MOTION_KEYWORDS_RE = re.compile(
    r"(?:抬头|低头|转身|走(?:向|到|入|出|开)?|跑|滑出|滑入|推开|拉开|打开|关闭|伸手|拿起|放下|递出|接过|起身|坐下|靠近|后退|移动"
    r"|摇镜|推镜|拉镜|跟拍|环绕|摆动|闪烁|升起|落下|点亮|熄灭|点击|打印|敲击|颤抖|回头|眨眼)",
    re.U,
)
_AMBIENCE_KEYWORDS_RE = re.compile(
    r"(?:环境声|音效|拟音|背景声|打印机|电流声|通风|音乐|脚步声|呼吸声)", re.U
)
_EXPLICIT_SILENT_RE = re.compile(r"(?:静默|完全静音|无环境声|无声音)", re.U)


def infer_video_candidate_expectations(
    *,
    duration_seconds: Any,
    action_text: Any = "",
    acting_beat: Any = "",
    dialogue_text: Any = "",
    audio_direction: Any = "",
    gaze_plan: Any = None,
    sound_plan: Any = None,
) -> dict[str, Any]:
    """Node inferVideoCandidateExpectations：候选视频的技术检查期望。

    :param duration_seconds: 请求时长。
    :param action_text: 动作文本。
    :param acting_beat: 表演节拍。
    :param dialogue_text: 对白文本。
    :param audio_direction: 声音指示。
    :param gaze_plan: 视线执行计划。
    :param sound_plan: 声音执行计划。
    :returns: ``{durationSeconds, requiresMotion, requiresAudio, requiresGazeReview,
        gazeTargetCount, requiresContinuousAmbience, soundCueCount}``。
    """
    action = f"{_text(action_text)} {_text(acting_beat)}"
    dialogue = _text(dialogue_text)
    direction = _text(audio_direction)
    has_dialogue = bool(dialogue) and not bool(_SILENT_DIALOGUE_RE.match(dialogue))
    explicitly_silent = bool(_EXPLICIT_SILENT_RE.search(direction))
    requires_audio = has_dialogue or (
        not explicitly_silent and bool(_AMBIENCE_KEYWORDS_RE.search(direction))
    )
    requires_motion = bool(_MOTION_KEYWORDS_RE.search(action))
    gaze_plan_dict = gaze_plan if isinstance(gaze_plan, dict) else None
    gaze_targets: list[str] = []
    if gaze_plan_dict and isinstance(gaze_plan_dict.get("transitions"), list):
        for item in gaze_plan_dict["transitions"]:
            target = _text((item or {}).get("target") if isinstance(item, dict) else "")
            if target and target not in gaze_targets:
                gaze_targets.append(target)
    sound_plan_dict = sound_plan if isinstance(sound_plan, dict) else None
    sound_cues = []
    if sound_plan_dict and isinstance(sound_plan_dict.get("cues"), list):
        sound_cues = [
            item for item in sound_plan_dict["cues"] if _text((item or {}).get("sound") if isinstance(item, dict) else "")
        ]
    requires_continuous_ambience = (
        not explicitly_silent and bool(_text((sound_plan_dict or {}).get("bed")))
    )
    try:
        rounded_duration = round(float(duration_seconds))
    except (TypeError, ValueError):
        rounded_duration = 4
    return {
        "durationSeconds": max(1, rounded_duration),
        "requiresMotion": requires_motion,
        "requiresAudio": requires_audio or requires_continuous_ambience,
        "requiresGazeReview": len(gaze_targets) > 0,
        "gazeTargetCount": len(gaze_targets),
        "requiresContinuousAmbience": requires_continuous_ambience,
        "soundCueCount": len(sound_cues),
    }


# ---------------------------------------------------------------------------
# index.mjs 内部函数（fixture 不可直调，手工复刻 + 测试对照）
# ---------------------------------------------------------------------------


def build_two_keyframe_video_prompt(
    *, prompt: Any = "", shot: dict[str, Any] | None = None, start_image: dict[str, Any] | None = None,
    end_image: dict[str, Any] | None = None,
) -> str:
    """Node buildTwoKeyframeVideoPrompt（index.mjs L8747）：两关键帧视频提示词。

    :param prompt: 主体提示词（buildStoryboardVideoPromptParts join 后的文本）。
    :param shot: 分镜行（visual_prompt / end_visual_prompt）。
    :param start_image: 起始帧 ``{prompt_snapshot, image_url}``。
    :param end_image: 结束帧 ``{prompt_snapshot, image_url}``。
    :returns: 拼装后的视频提示词。
    """
    shot = shot or {}
    start = start_image or {}
    end = end_image or {}
    parts = [
        _text(prompt or start.get("prompt_snapshot") or shot.get("visual_prompt")),
        "视频需从起始帧的构图和人物状态自然发展，不切镜头，不新增人物，角色外貌和服装保持一致。",
    ]
    end_prompt = _text(end.get("prompt_snapshot") or shot.get("end_visual_prompt"))
    if end_prompt:
        parts.append(f"动作终点参考：{end_prompt}")
    if end.get("image_url"):
        parts.append("结束帧已确认，请让人物动作、表情和镜头运动朝结束帧描述靠近。")
    return " ".join(part for part in parts if part)


def _infer_storage_key_from_url(value: Any) -> str:
    """Node inferStorageKeyFromUrl：COS 域名 URL → 对象键。

    :param value: 参考 URL。
    :returns: 对象键（非 COS 域名返回空串）。
    """
    raw = _text(value)
    try:
        parts = urlsplit(raw)
    except ValueError:
        return ""
    pathname = parts.path.lstrip("/")
    return pathname if ".cos." in (parts.hostname or "") and pathname else ""


def resolve_reference_audio_url(
    row: dict[str, Any] | None = None,
    create_signed_url: Callable[[str], str | None] | None = None,
) -> str:
    """Node resolveReferenceAudioUrl（index.mjs L8786）：参考音频可访问地址。

    优先用 storage_key 换签名 URL（TTL 下限 900 秒）；换不到时回退历史 URL。
    Python 侧签名 URL 由 main.py 注入的 ``create_object_url_resolver`` 提供；
    TTL 语义对齐 Node（``VIDEO_REFERENCE_AUDIO_SIGNED_URL_TTL_SECONDS``，默认 3600）。

    :param row: 角色音色行（reference_audio_storage_key / reference_audio_url）。
    :param create_signed_url: storage_key → 签名 URL 的回调（缺失或失败时回退）。
    :returns: 可访问的音频 URL（可能为空串）。
    """
    record = row or {}
    key = _text(_nullish(record.get("reference_audio_storage_key"), record.get("referenceAudioStorageKey"))) or _infer_storage_key_from_url(
        _nullish(record.get("reference_audio_url"), record.get("referenceAudioUrl"))
    )
    if key and create_signed_url is not None:
        try:
            signed = create_signed_url(key)
            if signed:
                return signed
        except Exception:
            # 与 Node 一致：签名失败保留历史 URL（旧数据 / 非 COS 记录）。
            pass
    return _text(_nullish(record.get("reference_audio_url"), record.get("referenceAudioUrl")))


def build_reference_audio_prompt_context(
    voice_rows: Any = None, reference_audio_urls: Any = None
) -> str:
    """Node buildReferenceAudioPromptContext（index.mjs L8762）：官方 Agnes 参考音频绑定段。

    :param voice_rows: 角色音色行列表（voice_locked / character_name）。
    :param reference_audio_urls: 已选参考音频 URL 列表（决定 ``<Audio N>`` 序号）。
    :returns: 绑定提示词段；无命中时为空串。
    """
    rows = [row for row in (voice_rows if isinstance(voice_rows, list) else []) if isinstance(row, dict)]
    urls = reference_audio_urls if isinstance(reference_audio_urls, list) else []
    lines: list[str] = []
    for row in rows:
        if not row.get("voice_locked"):
            continue
        url = resolve_reference_audio_url(row)
        if url not in urls:
            continue
        index = urls.index(url)
        speaker = _text(row.get("character_name") or "当前角色")
        lines.append(
            f"音色@{speaker} 使用 <Audio {index + 1}>；对白文本必须逐字使用本镜已写入的台词；"
            "人物发声、停顿、重音、情绪和嘴型动作必须与对白时序严格同步，禁止无声说话、错配台词或口型滞后；"
            "官方 Agnes 将参考音频用于声音特征、节奏和情绪参考。"
        )
    if not lines:
        return ""
    return "官方 Agnes 参考音频绑定：\n" + "\n".join(lines)


# ---------------------------------------------------------------------------
# lip-sync.mjs（入队可见子集）
# ---------------------------------------------------------------------------


def get_lip_sync_provider(env: dict[str, str] | None = None) -> str:
    """Node getLipSyncConfig 的 provider 字段（入队分支判定用）。

    :param env: 环境变量 override（测试注入；缺省读 os.environ）。
    :returns: 供应商标识（toapi / dashscope / latentsync，默认 toapi）。
    """
    source = env if env is not None else os.environ
    return str(source.get("LIP_SYNC_PROVIDER") or "toapi").strip().lower()


def resolve_lip_sync_duration(audio_duration_seconds: Any, storyboard_duration_seconds: Any) -> int:
    """Node resolveLipSyncDuration：普通口型服务目标时长（4-15 秒取整）。

    :param audio_duration_seconds: 音频时长。
    :param storyboard_duration_seconds: 分镜时长。
    :returns: 目标时长（整数秒）。
    """
    requested = max(
        _js_number(audio_duration_seconds), _js_number(storyboard_duration_seconds), 4.0
    )
    return min(15, max(4, math.ceil(requested)))


def resolve_dash_scope_lip_sync_duration(audio_duration_seconds: Any, storyboard_duration_seconds: Any) -> int:
    """Node resolveDashScopeLipSyncDuration：DashScope 口型时长（3-119 秒取整）。

    :param audio_duration_seconds: 音频时长。
    :param storyboard_duration_seconds: 分镜时长。
    :returns: 目标时长（整数秒）。
    """
    requested = max(
        _js_number(audio_duration_seconds), _js_number(storyboard_duration_seconds), 3.0
    )
    return min(119, max(3, math.ceil(requested)))


def build_lip_sync_prompt(
    *, character_name: Any = "", dialogue_text: Any = "", action_text: Any = ""
) -> str:
    """Node buildLipSyncPrompt：口型同步提示词（1000 字截断）。

    :param character_name: 说话角色名。
    :param dialogue_text: 对白文本。
    :param action_text: 动作文本。
    :returns: 口型提示词。
    """
    speaker = _text(character_name) or "人物"
    dialogue = _text(dialogue_text)
    action = _text(action_text)
    parts = [
        f"保持图片1中{speaker}的脸、发型、年龄、服装、构图和光线稳定。",
        "让图片1中的人物面对当前方向自然说中文，嘴唇开合严格跟随音频1，停顿时闭嘴。",
        "只允许当前说话人物做轻微表情、眨眼和呼吸动作，不改变身份，不新增人物，不切镜头。",
        f"对白语义：{dialogue}" if dialogue else "",
        f"表演要求：{action}" if action else "",
    ]
    return " ".join(part for part in parts if part)[:1000]
