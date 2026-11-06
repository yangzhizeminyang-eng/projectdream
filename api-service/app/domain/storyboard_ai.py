"""剧本/分镜 AI 生成域函数（FastAPI-Only 迁移第三阶段第三组 · 任务 C）。

逐行为复刻 Node 侧纯函数：
- ``server/services/storyboard-duration.mjs`` / ``storyboard-duration-contract.mjs``
  （时长契约与对白最短时长）；
- ``server/services/ai/parsers.mjs``（模型输出归一化）；
- ``server/services/ai/script.mjs`` / ``ai/storyboard.mjs`` 的 mock 生成器；
- ``server/index.mjs`` 内的 frameRole/子分镜/对白拆分/两帧兜底函数；
- ``server/services/storyboard-performance.mjs``（表演归一化，视线/声音计划复用
  ``app.direction_contract``）；
- ``server/services/storyboard-prompt-sanitizer.mjs``；
- ``server/services/agent/quality-gate.mjs`` 的资产引用门禁；
- ``server/services/storyboard-asset-catalog.mjs`` / ``storyboard-asset-binding.mjs``；
- ``server/services/ai/scene-extraction.mjs`` 的地点/时间推断；
- ``server/services/ai/genre-skill-profile.mjs``（题材技能提示词）。

全部为纯函数：输入 dict/行，输出 dict；不触 DB / 网络，便于 fixture 与单测。
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from app.direction_contract import normalize_gaze, normalize_sound

MAX_STORYBOARD_DURATION_SECONDS = 30

# ---------------------------------------------------------------------------
# storyboard-duration.mjs
# ---------------------------------------------------------------------------


class StoryboardDurationError(ValueError):
    """分镜时长非法（对齐 Node normalizeStoryboardDurationSeconds 抛错）。"""


class StoryboardContractError(ValueError):
    """分镜时长契约校验失败（Node statusCode=422 的错误形态）。"""


def normalize_storyboard_duration_seconds(value: Any) -> int:
    """Node normalizeStoryboardDurationSeconds：1-30 正整数才收，否则抛错。

    :param value: 任意输入。
    :returns: 合法秒数。
    :raises StoryboardDurationError: 非整数或越界。
    """
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = float("nan")
    if parsed != parsed or parsed != int(parsed) or parsed < 1 or parsed > MAX_STORYBOARD_DURATION_SECONDS:
        raise StoryboardDurationError(f"分镜时长必须是有效整数（1-{MAX_STORYBOARD_DURATION_SECONDS} 秒）")
    return int(parsed)


def is_valid_storyboard_duration_seconds(value: Any) -> bool:
    """Node isValidStoryboardDurationSeconds：布尔包装。"""
    try:
        normalize_storyboard_duration_seconds(value)
        return True
    except StoryboardDurationError:
        return False


# ---------------------------------------------------------------------------
# storyboard-duration-contract.mjs
# ---------------------------------------------------------------------------

_SILENT_DIALOGUE = re.compile(r"^(?:（无对白）|\(无对白\)|无对白|无台词|none|no dialogue)$", re.I)
_SILENT_DIALOGUE_LOOSE = re.compile(r"^(?:[（(]\s*)?(?:无对白|无台词|no\s+dialogue)(?:\s*[）)])?$", re.I)


def _text(value: Any, fallback: str = "") -> str:
    """JS text(value, fallback)：String(value ?? '').trim()，空则回退默认值。"""
    normalized = str(value if value is not None else "").strip()
    return normalized or fallback


def _read_duration(value: Any) -> int | None:
    """JS readDuration：正整数才收（float 整数亦收）。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return int(parsed) if parsed == int(parsed) and parsed > 0 else None


_TIMELINE_LABEL_PATTERN = re.compile(
    r"时间轴\s*[:：]([\s\S]*?)(?=(?:；|;|\r?\n)\s*(?:镜头|位置|动作|要求|对白|旁白|声音|视线)\s*[:：]|$)"
)
_TIMELINE_RANGE_PATTERN = re.compile(r"(\d+(?:\.\d+)?)\s*[-–至]\s*(\d+(?:\.\d+)?)\s*秒")


def _read_visible_timeline_ranges(prompt: Any) -> list[tuple[str, str]]:
    """JS readVisibleTimelineRanges：从提示词抽取「a-b秒」时间轴片段。"""
    match = _TIMELINE_LABEL_PATTERN.search(str(prompt or ""))
    if not match:
        return []
    return [(m.group(1), m.group(2)) for m in _TIMELINE_RANGE_PATTERN.finditer(match.group(1))]


def _normalize_breakdown(value: Any) -> list[dict[str, Any]]:
    """JS normalizeBreakdown：时长拆解归一（phase/seconds/observable）。"""
    items = value if isinstance(value, list) else []
    return [
        {
            "phase": _text(item.get("phase", item.get("label", item.get("name")))) if isinstance(item, dict) else "",
            "seconds": _read_duration(
                item.get("seconds", item.get("duration_seconds", item.get("durationSeconds")))
            )
            if isinstance(item, dict)
            else None,
            "observable": _text(item.get("observable", item.get("event", item.get("result")))) if isinstance(item, dict) else "",
        }
        for item in items
    ]


def _count_spoken_characters(value: Any) -> int:
    """JS countSpokenCharacters：去空白与「说话人：」前缀后的可发音字符数。"""
    text = re.sub(r"^.{1,30}[:：]\s*", "", re.sub(r"\s+", "", _text(value)))
    return sum(1 for char in text if not re.match(r"[，。！？；、,.!?;:：]", char))


def estimate_minimum_dialogue_seconds(dialogue_text: Any) -> int:
    """Node estimateMinimumDialogueSeconds：对白自然语速下限（仅校验用）。"""
    dialogue = _text(dialogue_text)
    if not dialogue or _SILENT_DIALOGUE.fullmatch(dialogue):
        return 0
    characters = _count_spoken_characters(dialogue)
    punctuation_pauses = len(re.findall(r"[，。！？；、,.!?;:：]", dialogue))
    return max(1, math.ceil(characters / 5 + punctuation_pauses * 0.15))


def _visible_timeline_blockers(prompt: Any, duration_seconds: Any, required: bool) -> list[str]:
    """JS visibleTimelineBlockers：镜头内时间轴必须连续覆盖 0 到镜头时长。"""
    if not re.search(r"时间轴\s*[:：]", str(prompt or "")) and not required:
        return []
    ranges = _read_visible_timeline_ranges(prompt)
    try:
        numeric_duration = float(duration_seconds)
    except (TypeError, ValueError):
        numeric_duration = float("nan")
    if not ranges or numeric_duration != numeric_duration:
        return ["镜头内时间轴必须连续覆盖0到镜头时长"]
    cursor = 0.0
    for start_raw, end_raw in ranges:
        start = float(start_raw)
        end = float(end_raw)
        if abs(start - cursor) > 0.001 or end <= start:
            return ["镜头内时间轴必须连续覆盖0到镜头时长"]
        cursor = end
    return [] if abs(cursor - numeric_duration) <= 0.001 else ["镜头内时间轴必须连续覆盖0到镜头时长"]


def validate_storyboard_duration_contract(
    shot: dict[str, Any], *, require_visible_timeline: bool = False
) -> dict[str, Any]:
    """Node validateStoryboardDurationContract：单镜头时长契约校验。

    :param shot: 镜头 dict（snake_case 或 camelCase）。
    :param require_visible_timeline: 是否强制提示词含时间轴。
    :returns: ``{"passed", "blockers", "durationSeconds", "durationBreakdown",
        "durationBasis", "minimumDialogueSeconds"}``。
    """
    blockers: list[str] = []
    duration_seconds = _read_duration(shot.get("duration_seconds", shot.get("durationSeconds")))
    try:
        normalize_storyboard_duration_seconds(duration_seconds)
    except StoryboardDurationError:
        shot_no = _text(shot.get("shot_no", shot.get("shotNo"))) or "?"
        blockers.append(f"镜头 {shot_no} 的时长必须是 1-{MAX_STORYBOARD_DURATION_SECONDS} 秒的正整数")

    blockers.extend(
        _visible_timeline_blockers(
            shot.get("visual_prompt", shot.get("visualPrompt")),
            duration_seconds,
            require_visible_timeline,
        )
    )

    breakdown = _normalize_breakdown(
        shot.get("duration_breakdown", shot.get("durationBreakdown", shot.get("timing_plan", shot.get("timingPlan"))))
    )
    if not breakdown:
        blockers.append("缺少内部时长拆解 duration_breakdown")
    else:
        if any(not part["phase"] or not part["observable"] or not part["seconds"] for part in breakdown):
            blockers.append("内部时长拆解的每一段都必须包含 phase、seconds 和 observable")
        total = sum(part["seconds"] or 0 for part in breakdown)
        if duration_seconds and total != duration_seconds:
            blockers.append(f"时长拆解总和必须等于镜头时长（当前 {total}s，镜头 {duration_seconds}s）")

    duration_basis = _text(shot.get("duration_basis", shot.get("durationBasis")))
    if not duration_basis:
        blockers.append("缺少内部时长依据 duration_basis")

    minimum_dialogue_seconds = estimate_minimum_dialogue_seconds(
        shot.get("dialogue_text", shot.get("dialogueText"))
    )
    if duration_seconds and minimum_dialogue_seconds > duration_seconds:
        blockers.append(
            f"对白自然语速至少需要 {minimum_dialogue_seconds}s，不能压缩到 {duration_seconds}s"
        )

    return {
        "passed": not blockers,
        "blockers": blockers,
        "durationSeconds": duration_seconds,
        "durationBreakdown": breakdown,
        "durationBasis": duration_basis,
        "minimumDialogueSeconds": minimum_dialogue_seconds,
    }


def validate_storyboard_duration_contracts(
    shots: list[dict[str, Any]] | None, options: dict[str, bool] | None = None
) -> dict[str, Any]:
    """Node validateStoryboardDurationContracts：批量镜头契约校验。

    :param shots: 镜头列表。
    :param options: ``{"requireVisibleTimeline": bool}``。
    :returns: ``{"passed", "results", "blockers"}``。
    """
    options = options or {}
    results = [
        validate_storyboard_duration_contract(
            shot, require_visible_timeline=bool(options.get("requireVisibleTimeline"))
        )
        for shot in (shots or [])
    ]
    return {
        "passed": bool(results) and all(result["passed"] for result in results),
        "results": results,
        "blockers": [blocker for result in results for blocker in result["blockers"]],
    }


# ---------------------------------------------------------------------------
# storyboard-prompt-sanitizer.mjs
# ---------------------------------------------------------------------------

_ASSET_TEMPLATE_MARKERS = (
    re.compile(r"提示词模板技能：prompt-template-skill-", re.U),
    re.compile(r"参考模板来源：角色生成提示词模板", re.U),
    re.compile(r"角色资产板必须一次生成", re.U),
    re.compile(r"资产范围：只输出角色外貌", re.U),
)


def sanitize_storyboard_prompt(value: Any = "", *, character_names: list[Any] | None = None) -> str:
    """Node sanitizeStoryboardPrompt：剥离资产模板尾巴与角色外貌括注。

    :param value: 原始提示词。
    :param character_names: 角色名列表（用于剥离「名字（…外貌…）」括注）。
    :returns: 消毒后的提示词。
    """
    source = str(value or "").strip()
    if not source:
        return ""
    marker_indexes = [match.start() for marker in _ASSET_TEMPLATE_MARKERS if (match := marker.search(source))]
    marker_index = min(marker_indexes) if marker_indexes else len(source)
    sanitized = source[:marker_index]
    for raw_name in character_names or []:
        name = str(raw_name or "").strip()
        if not name:
            continue
        escaped = re.sub(r"[.*+?^${}()|[\]\\]", lambda m: "\\" + m.group(0), name)
        profile = re.compile(
            rf"@?{escaped}（[^）]*(?:\d+岁|男性|女性|青年|中年)[^）]*"
            r"(?:脸|发|眉|眼|鼻|唇|耳|下颌|衬衫|外套|西装|服装|长发|短发)[^）]*）",
            re.U,
        )
        sanitized = profile.sub("", sanitized)
    sanitized = re.sub(r"[ \t]+", " ", sanitized)
    sanitized = re.sub(r"\n{3,}", "\n\n", sanitized)
    sanitized = re.sub(r"\s+([，。；：、])", r"\1", sanitized)
    return sanitized.strip()


# ---------------------------------------------------------------------------
# storyboard-performance.mjs（视线/声音计划复用 app.direction_contract）
# ---------------------------------------------------------------------------


def _clamp_intensity(value: Any, fallback: int = 50) -> int:
    """JS clampIntensity：0-1 视作比例放大到百分制，越界夹取。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    normalized = parsed * 100 if 0 <= parsed <= 1 else parsed
    return max(0, min(100, round(normalized)))


def normalize_storyboard_performance(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node normalizeStoryboardPerformance：表演字段缺省值全量兜底。

    :param input_data: 镜头 dict（snake_case / camelCase）。
    :returns: 表演 DTO（shotPurpose/actingBeat/…/gazePlan/soundPlan）。
    """
    shot = input_data or {}

    def pick(*keys: str) -> str:
        for key in keys:
            if shot.get(key) is not None and str(shot.get(key)).strip():
                return str(shot[key]).strip()
        return ""

    return {
        "shotPurpose": pick("shot_purpose", "shotPurpose") or "story",
        "actingBeat": pick("acting_beat", "actingBeat"),
        "audioDirection": pick("audio_direction", "audioDirection"),
        "speechDurationPolicy": pick("speech_duration_policy", "speechDurationPolicy") or "preserve",
        "reactionShot": bool(shot.get("reaction_shot", shot.get("reactionShot"))),
        "emotion": pick("emotion", "current_emotion", "currentEmotion") or "情绪随剧情自然推进",
        "intensity": _clamp_intensity(
            next((shot.get(key) for key in ("intensity", "emotion_intensity", "emotionIntensity") if shot.get(key) is not None), None)
        ),
        "emotionStart": pick("emotion_start", "emotionStart") or "镜头开始时承接上一镜头的情绪状态",
        "emotionTrigger": pick("emotion_trigger", "emotionTrigger") or "由本镜头的剧情信息或动作触发",
        "emotionChange": pick("emotion_change", "emotional_change", "emotionChange") or "情绪随本镜头动作和信息逐步变化",
        "emotionEnd": pick("emotion_end", "emotionEnd") or "镜头结束时保留可供下一镜头承接的情绪余波",
        "microExpression": pick("micro_expression", "microExpression") or "眼神、眉眼、嘴角和下颌保持可读且克制的变化",
        "breathAction": pick("breath_action", "breathAction") or "按情绪完成吸气、呼气或短暂停顿",
        "bodyAction": pick("body_action", "bodyAction") or "身体重心、肩颈、手指和姿态随情绪发生细微变化",
        "voiceTone": pick("voice_tone", "voiceTone") or "与角色固定声线一致，并匹配当前情绪",
        "voiceVolume": pick("voice_volume", "voiceVolume") or "按情绪自然变化，避免无依据夸张",
        "speechRate": pick("speech_rate", "speechRate") or "自然语速，按对白情绪调整",
        "speechPauses": pick("speech_pauses", "speechPauses") or "在语义和情绪转折处保留可听见的停顿",
        "lipSync": pick("lip_sync", "lipSync") or "对白逐字对应口型，停顿时闭唇并保留呼吸和面部反应",
        "continuityFromPrevious": pick("continuity_from_previous", "continuityFromPrevious") or "承接上一镜头的视线、姿态、空间位置和情绪强度",
        "gazePlan": normalize_gaze(shot),
        "soundPlan": normalize_sound(shot),
    }


# ---------------------------------------------------------------------------
# ai/scene-extraction.mjs（地点/时间推断子集）
# ---------------------------------------------------------------------------

_ABSTRACT_LOCATION_LABELS = {"室内", "室外", "未知地点", "未定", "待定"}


def infer_location_from_scene_text(item: dict[str, Any]) -> str:
    """Node inferLocationFromSceneText：抽象地点时按正文关键词推断具体地点。"""
    current = _text(item.get("location"))
    if current and current not in _ABSTRACT_LOCATION_LABELS:
        return current
    source = "\n".join(part for part in (_text(item.get("content")), _text(item.get("summary"))) if part)
    if not source:
        return ""
    if re.search(r"公寓", source) and re.search(r"沙发|茶几|客厅|冰箱|百叶窗|冷咖啡", source):
        return "深夜公寓客厅"
    if re.search(r"办公室", source) and re.search(r"书架|办公椅|办公桌|摄像头", source):
        return "陈志远办公室（视频画面）"
    if re.search(r"机房|主节点|核心日志", source):
        return "公司核心机房"
    if re.search(r"葬礼|遗照|花圈|灵堂", source):
        return "葬礼现场回忆"
    return ""


def infer_time_of_day_from_scene_text(item: dict[str, Any]) -> str:
    """Node inferTimeOfDayFromSceneText：按正文关键词推断时段。"""
    current = _text(item.get("time_of_day", item.get("timeOfDay")))
    if current:
        return current
    source = "\n".join(part for part in (_text(item.get("content")), _text(item.get("summary"))) if part)
    if re.search(r"深夜|凌晨|00:00|午夜", source):
        return "深夜"
    if re.search(r"清晨|早晨|日出", source):
        return "清晨"
    if re.search(r"夜晚|晚上|夜里", source):
        return "夜晚"
    if re.search(r"白天|下午|午后|上午", source):
        return "白天"
    return ""


# ---------------------------------------------------------------------------
# ai/parsers.mjs（scene script + storyboards）
# ---------------------------------------------------------------------------


def _to_non_empty_string(value: Any, fallback: str = "") -> str:
    """JS toNonEmptyString：strip 后空则回退默认。"""
    return _text(value) or fallback


def _is_placeholder_text(value: Any) -> bool:
    """JS isPlaceholderText：占位标题集合（大小写不敏感）。"""
    return _text(value).lower() in {
        "", "未命名项目", "未命名场景", "untitled project", "untitled scene", "n/a"
    }


def _to_positive_int(value: Any, fallback: Any) -> int:
    """JS toPositiveInt：有限正数四舍五入，否则回退。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return round(parsed) if math.isfinite(parsed) and parsed > 0 else fallback


def normalize_scene_script_payload(payload: Any, ctx: dict[str, Any]) -> dict[str, Any]:
    """Node normalizeSceneScriptPayload：剧本模型输出 → scene 更新 DTO。

    :param payload: 模型 JSON（dict）。
    :param ctx: ``{"scene", "outline", "project"}`` 上下文。
    :returns: scene_no/title/summary/content/mood/location/time_of_day/
        estimated_duration/outline_title。
    """
    payload = payload if isinstance(payload, dict) else {}
    scene = ctx.get("scene") or {}
    outline = ctx.get("outline") or {}
    project = ctx.get("project") or {}
    content = _to_non_empty_string(
        payload.get("content"),
        f"【场景 {str(_to_positive_int(scene.get('scene_no'), 1)).zfill(2)}】\n"
        + _to_non_empty_string(scene.get("summary"), "本场景正文待补充。"),
    )
    scene_source = {**scene, **payload, "content": content}
    inferred_location = infer_location_from_scene_text(scene_source)
    inferred_time_of_day = infer_time_of_day_from_scene_text(scene_source)
    return {
        "scene_no": _to_positive_int(payload.get("scene_no"), _to_positive_int(scene.get("scene_no"), 1)),
        "title": (
            _to_non_empty_string(scene.get("title"), "未命名场景")
            if _is_placeholder_text(payload.get("title"))
            else _to_non_empty_string(payload.get("title"), _to_non_empty_string(scene.get("title"), "未命名场景"))
        ),
        "summary": _to_non_empty_string(payload.get("summary"), _to_non_empty_string(scene.get("summary"), "")),
        "content": content,
        "mood": _to_non_empty_string(payload.get("mood"), "克制、悬疑，情绪逐步升高。"),
        "location": inferred_location or _to_non_empty_string(payload.get("location"), _to_non_empty_string(scene.get("location"), "未知地点")),
        "time_of_day": inferred_time_of_day or _to_non_empty_string(payload.get("time_of_day"), _to_non_empty_string(scene.get("time_of_day"), "夜")),
        "estimated_duration": _to_positive_int(payload.get("estimated_duration"), _to_positive_int(scene.get("estimated_duration"), 120)),
        "outline_title": _to_non_empty_string(outline.get("title"), _to_non_empty_string(project.get("name"), "本片")),
    }


def _resolve_storyboard_character_name(value: Any, characters: list[dict[str, Any]]) -> str:
    """Node resolveStoryboardCharacterName：精确 → 角色标签 → 部分匹配；未命中保留原文。"""
    raw = _to_non_empty_string(value)
    if not characters:
        return raw or "主角"
    normalized = raw.lower()
    for item in characters:
        if _to_non_empty_string(item.get("name")).lower() == normalized:
            return _to_non_empty_string(item.get("name"))
    for item in characters:
        role = _to_non_empty_string(item.get("role_tag", item.get("roleTag"))).lower()
        if normalized and role and (role in normalized or normalized in role):
            return _to_non_empty_string(item.get("name"))
    for item in characters:
        name = _to_non_empty_string(item.get("name")).lower()
        if normalized and name and (normalized in name or name in normalized):
            return _to_non_empty_string(item.get("name"))
    # 未知姓名不能静默替换成当前 cast 的第一个角色（Node 注释同款纪律）。
    return raw or ""


def _remove_private_duration_evidence(value: Any) -> str:
    """Node removePrivateStoryboardDurationEvidence：从提示词剥离时长拆解等私有段。"""
    text = str(value if value is not None else "")
    text = re.sub(r"(?:duration_breakdown|duration_basis|时长拆解|时长依据)\s*[:：=]\s*[^；;\n]*", "", text, flags=re.I)
    text = re.sub(r"[；;]\s*[；;]", "；", text)
    return text.strip()


def _build_storyboard_timeline(duration_seconds: Any, duration_breakdown: Any) -> str:
    """Node buildStoryboardTimeline：拆解合法时生成「0-a秒，…；a-b秒，…」时间轴。"""
    try:
        duration = float(duration_seconds)
    except (TypeError, ValueError):
        return ""
    plan_raw = duration_breakdown if isinstance(duration_breakdown, list) else []
    if not (duration == int(duration) and duration >= 1) or not plan_raw:
        return ""
    plan = [
        {
            "seconds": item.get("seconds", item.get("duration_seconds", item.get("durationSeconds")))
            if isinstance(item, dict)
            else None,
            "observable": _to_non_empty_string(
                item.get("observable", item.get("event", item.get("result")))
            )
            if isinstance(item, dict)
            else "",
        }
        for item in plan_raw
    ]
    if any(
        not isinstance(item["seconds"], (int, float))
        or item["seconds"] != int(item["seconds"])
        or item["seconds"] < 1
        or not item["observable"]
        for item in plan
    ):
        return ""
    total = sum(int(item["seconds"]) for item in plan)
    if total != int(duration):
        return ""
    cursor = 0
    segments = []
    for item in plan:
        start = cursor
        cursor += int(item["seconds"])
        segments.append(f"{start}-{cursor}秒，{item['observable']}")
    return "；".join(segments)


_TIMELINE_REPLACE_PATTERN = re.compile(
    r"时间轴：[\s\S]*?(?=(?:；|;|\r?\n)\s*(?:镜头|位置|动作|要求|对白|旁白|声音|视线)：|$)"
)


def _repair_visible_storyboard_timeline(source: str, duration_seconds: Any, duration_breakdown: Any) -> str:
    """Node repairVisibleStoryboardTimeline：用合法拆解时间轴修复/补写提示词。"""
    if not source:
        return source
    timeline = _build_storyboard_timeline(duration_seconds, duration_breakdown)
    if not timeline:
        return source
    timeline_label = f"时间轴：{timeline}"
    if not re.search(r"时间轴：", source):
        return "；".join(part for part in (timeline_label, source) if part)
    return _TIMELINE_REPLACE_PATTERN.sub(timeline_label, source)


def _build_fallback_storyboard_prompt(*, project_visual_style: str, shot_type: str, camera_angle: str,
                                      composition: str, duration_seconds: Any, duration_breakdown: Any,
                                      action_text: str, dialogue_text: str, audio_direction: str) -> str:
    """Node buildFallbackStoryboardPrompt：无提示词时的规则化兜底。"""
    try:
        duration = float(duration_seconds)
    except (TypeError, ValueError):
        duration = float("nan")
    plan = duration_breakdown if isinstance(duration_breakdown, list) else []
    plan_total = sum(float(item.get("seconds") or 0) for item in plan if isinstance(item, dict))
    cursor = 0
    timeline = ""
    if duration == int(duration) and duration > 0 and plan and int(plan_total) == int(duration):
        segments = []
        for item in plan:
            start = cursor
            cursor += float(item.get("seconds") or 0)
            segments.append(f"{start}-{cursor:g}秒，{_to_non_empty_string(item.get('observable'))}")
        timeline = "；".join(segments)
    elif duration == int(duration) and duration > 0:
        timeline = f"0-{int(duration)}秒，{action_text}"
    parts = [
        f"时间轴：{timeline}" if timeline else "时间轴：",
        f"镜头：{shot_type}，{camera_angle}",
        f"位置：{composition}",
        f"动作：{action_text}",
        f"要求：{project_visual_style}",
        f"对白：{dialogue_text}" if dialogue_text and dialogue_text != "（无对白）" else "",
        f"声音：{audio_direction}" if audio_direction else "",
    ]
    return "；".join(part for part in parts if part)


def _build_unified_storyboard_prompt(*, visual_prompt: str, character_name: str, character_assets: list[str],
                                     scene_assets: list[str], prop_assets: list[str], dialogue_text: str,
                                     gaze_plan: dict[str, Any] | None, sound_plan: dict[str, Any] | None,
                                     expose_direction_plan: bool = False) -> str:
    """Node buildUnifiedStoryboardPrompt：补齐缺失的 @资产/@音色/视线/声音 标记。"""
    source = _remove_private_duration_evidence(_to_non_empty_string(visual_prompt))
    gaze_prompt_text = (gaze_plan or {}).get("promptText")
    sound_prompt_text = (sound_plan or {}).get("promptText")
    if expose_direction_plan and gaze_prompt_text and not re.search(r"视线：", source):
        source = "；".join(part for part in (source, f"视线：{gaze_prompt_text}") if part)
    if expose_direction_plan and sound_prompt_text and not re.search(r"声音：", source):
        source = "；".join(part for part in (source, f"声音：{sound_prompt_text}") if part)
    mentions = [
        _to_non_empty_string(item)
        for item in (character_name, *character_assets, *scene_assets, *prop_assets)
        if _to_non_empty_string(item)
    ]
    mentions = [item if item.startswith("@") else f"@{item}" for item in mentions]
    voice_mention = (
        f"@音色[{character_name}]"
        if character_name and dialogue_text and dialogue_text != "（无对白）"
        else ""
    )
    missing = [
        item
        for item in list(dict.fromkeys([*mentions, voice_mention]))
        if item and item not in source
    ]
    return "；".join(part for part in ["、".join(missing) if missing else "", source] if part)


def _asset_reference_name(entry: Any) -> str:
    """把字符串或 {name/label/id} 资产引用归一为可匹配的名称。"""
    if isinstance(entry, dict):
        return _to_non_empty_string(
            entry.get("name") or entry.get("label") or entry.get("assetName") or entry.get("id")
        )
    return _to_non_empty_string(entry)


def normalize_storyboard_shot(
    shot: dict[str, Any], index: int, project_visual_style: str, characters: list[dict[str, Any]]
) -> dict[str, Any]:
    """Node normalizeStoryboardShot：单镜头字段归一（默认值 + 提示词修复）。"""
    shot = shot if isinstance(shot, dict) else {}
    shot_no = str(_to_positive_int(shot.get("shot_no"), index + 1)).zfill(2)
    shot_type = _to_non_empty_string(shot.get("shot_type"), "中景")
    camera_angle = _to_non_empty_string(shot.get("camera_angle"), "平视")
    composition = _to_non_empty_string(shot.get("composition"), "三分构图")[:255]
    performance = normalize_storyboard_performance(shot)
    raw_character_name = shot.get("character_name", shot.get("characterName"))
    if isinstance(raw_character_name, dict):
        raw_character_name = _asset_reference_name(raw_character_name)
    character_name = _resolve_storyboard_character_name(raw_character_name, characters)
    prompt_character_name = character_name if (characters or _to_non_empty_string(raw_character_name)) else ""
    action_text = _to_non_empty_string(shot.get("action_text"), "镜头捕捉角色动作与当前场景推进。")
    dialogue_text = _to_non_empty_string(shot.get("dialogue_text"), "（无对白）")
    has_explicit_direction_plan = bool(
        shot.get("gaze_plan") or shot.get("gazePlan") or shot.get("sound_plan") or shot.get("soundPlan")
    )

    def asset_list(*keys: str) -> list[str]:
        for key in keys:
            value = shot.get(key)
            if isinstance(value, list):
                return [item for item in (_asset_reference_name(entry) for entry in value) if item]
        return []

    character_assets = asset_list("character_assets", "characterAssets")
    scene_assets = asset_list("scene_assets", "sceneAssets")
    prop_assets = asset_list("prop_assets", "propAssets")
    sanitized_visual_prompt = _to_non_empty_string(
        sanitize_storyboard_prompt(shot.get("visual_prompt"), character_names=[c.get("name") for c in characters])
    )
    duration_seconds = shot.get("duration_seconds", shot.get("durationSeconds"))
    duration_breakdown = shot.get(
        "duration_breakdown", shot.get("durationBreakdown", shot.get("timing_plan", shot.get("timingPlan")))
    )
    repaired = _repair_visible_storyboard_timeline(sanitized_visual_prompt, duration_seconds, duration_breakdown)
    base_visual_prompt = repaired or _build_fallback_storyboard_prompt(
        project_visual_style=project_visual_style,
        shot_type=shot_type,
        camera_angle=camera_angle,
        composition=composition,
        duration_seconds=duration_seconds,
        duration_breakdown=duration_breakdown,
        action_text=action_text,
        dialogue_text=dialogue_text,
        audio_direction=performance["audioDirection"],
    )

    def pick_first(*keys: str, default: str = "") -> str:
        for key in keys:
            if shot.get(key) is not None:
                return _to_non_empty_string(shot.get(key))
        return default

    return {
        "shot_no": shot_no,
        "shot_type": shot_type,
        "camera_angle": camera_angle,
        "composition": composition,
        "duration_seconds": shot.get("duration_seconds", shot.get("durationSeconds")) if shot.get("duration_seconds", shot.get("durationSeconds")) is not None else None,
        "duration_breakdown": duration_breakdown if duration_breakdown is not None else [],
        "duration_basis": _to_non_empty_string(shot.get("duration_basis", shot.get("durationBasis"))),
        "character_name": character_name,
        "action_text": action_text,
        "dialogue_text": dialogue_text,
        "visual_prompt": _build_unified_storyboard_prompt(
            visual_prompt=base_visual_prompt,
            character_name=prompt_character_name,
            character_assets=character_assets,
            scene_assets=scene_assets,
            prop_assets=prop_assets,
            dialogue_text=dialogue_text,
            gaze_plan=performance["gazePlan"],
            sound_plan=performance["soundPlan"],
            expose_direction_plan=has_explicit_direction_plan,
        ),
        "shot_purpose": performance["shotPurpose"],
        "acting_beat": performance["actingBeat"],
        "audio_direction": performance["audioDirection"],
        "speech_duration_policy": performance["speechDurationPolicy"],
        "reaction_shot": performance["reactionShot"],
        "emotional_change": performance["emotionChange"],
        "emotion": performance["emotion"],
        "emotion_intensity": performance["intensity"],
        "emotion_start": performance["emotionStart"],
        "emotion_trigger": performance["emotionTrigger"],
        "emotion_end": performance["emotionEnd"],
        "micro_expression": performance["microExpression"],
        "breath_action": performance["breathAction"],
        "body_action": performance["bodyAction"],
        "voice_tone": performance["voiceTone"],
        "voice_volume": performance["voiceVolume"],
        "speech_rate": performance["speechRate"],
        "speech_pauses": performance["speechPauses"],
        "lip_sync": performance["lipSync"],
        "continuity_from_previous": performance["continuityFromPrevious"],
        "gaze_plan": performance["gazePlan"],
        "sound_plan": performance["soundPlan"],
        "performance": performance,
        "start_state": _to_non_empty_string(shot.get("start_state", shot.get("startState")), "镜头开始时沿用上一状态。"),
        "end_state": _to_non_empty_string(shot.get("end_state", shot.get("endState")), "镜头结束时为下一镜留下可继承状态。"),
        "character_assets": character_assets,
        "scene_assets": scene_assets,
        "prop_assets": prop_assets,
        "tools": asset_list("tools", "mention_tools", "mentionTools"),
        "scene_view_key": _to_non_empty_string(shot.get("scene_view_key", shot.get("sceneViewKey"))),
        "start_visual_prompt": pick_first("start_visual_prompt", "startVisualPrompt"),
        "end_visual_prompt": pick_first("end_visual_prompt", "endVisualPrompt"),
    }


def normalize_storyboard_payload(payload: Any, ctx: dict[str, Any]) -> dict[str, Any]:
    """Node normalizeStoryboardPayload：模型镜头列表 → storyboards 行 DTO。

    :param payload: 模型 JSON（含 shots）。
    :param ctx: ``{"scene", "project", "sceneId", "characters"}``。
    :returns: ``{"scene_id", "shots"}``。
    """
    payload = payload if isinstance(payload, dict) else {}
    scene = ctx.get("scene") or {}
    project = ctx.get("project") or {}
    project_visual_style = _to_non_empty_string(project.get("visualStyle"), "电影感写实风格")
    characters = [c for c in (ctx.get("characters") or []) if c.get("name")]
    shots_source = payload.get("shots") if isinstance(payload.get("shots"), list) else []
    normalized_shots = [
        normalize_storyboard_shot(item, index, project_visual_style, characters)
        for index, item in enumerate((shots_source if shots_source else [{} for _ in range(4)])[:20])
    ]
    scene_id = _to_positive_int(
        payload.get("scene_id"), _to_positive_int(ctx.get("sceneId"), _to_positive_int(scene.get("id"), 0))
    )
    return {"scene_id": scene_id, "shots": normalized_shots}


# ---------------------------------------------------------------------------
# mock 生成器（ai/script.mjs generateMockSceneScript / ai/storyboard.mjs generateMockStoryboards）
# ---------------------------------------------------------------------------

_BEAT_TEMPLATE = {
    "setup": "画面停留，环境细节被强调。",
    "development": "角色做出一个微小但关键的选择。",
    "escalation": "外部信号介入，氛围被打破。",
    "turn": "角色被迫回应，刚刚的选择引发连锁反应。",
    "resolution": "场景在不安的安静中收束，伏笔被压进下一场。",
}

_SHOT_TYPES = ["全景", "中景", "近景", "特写", "大特写"]
_ANGLES = ["平视", "低机位", "高机位", "俯拍", "仰拍"]
_COMPOSITIONS = ["居中构图", "三分构图", "对称构图", "对角线构图", "框架式构图"]
_FALLBACK_CHARACTERS = ["主角", "对手", "旁白"]
_MOCK_ACTIONS = [
    "{character} 从阴影中缓慢走出，背景里的环境噪声压低成一层底音。",
    "镜头切到 {character} 的侧脸，角色开始观察前方不稳定的局面。",
    "{character} 做出一个关键信息动作，推动场景进入下一拍。",
    "镜头短暂停在环境细节上，为后续剧情埋下视觉线索。",
    "{character} 的目光与对手交汇，场面张力明显抬升。",
    "画面逐渐拉远，空间关系和人物位置被重新建立。",
    "一条异常信号进入镜头，提示局势已经开始失控。",
    "镜头定格在角色离开的背影上，留出情绪余波。",
]
_MOCK_DIALOGUES = [
    "没人应该在这里活过今晚。",
    "你以为你在追我，其实你一直在追自己。",
    "把档案留下，你就可以走。",
    "我不需要答案，我只需要再多一个选择。",
    "这座城市的规则，今晚会被重写一次。",
    "你听到的不是噪音，是这座城在记忆。",
    "故事到这里，已经没有回头路。",
    "（无对白）",
]


def _pick(arr: list[str], index: int) -> str:
    """JS pick(arr, index)：按索引取模循环。"""
    return arr[index % len(arr)]


def generate_mock_scene_script(ctx: dict[str, Any]) -> dict[str, Any]:
    """Node generateMockSceneScript：mock 模式的确定性单场剧本。"""
    scene = ctx.get("scene") or {}
    outline = ctx.get("outline") or {}
    story_bible = ctx.get("storyBible") or {}
    season_structure = ctx.get("seasonStructure") or {}
    project = ctx.get("project") or {}
    title = scene.get("title") or "未命名场景"
    location = scene.get("location") or "未知地点"
    time_of_day = scene.get("time_of_day") or "夜"
    summary = scene.get("summary") or ""
    episode = None
    if isinstance(season_structure.get("episodes"), list):
        episode = next(
            (
                item
                for item in season_structure["episodes"]
                if float(item.get("episodeNo") or 0) == float(scene.get("episode_no", scene.get("episodeNo", 1)))
            ),
            None,
        )
    lead = next(
        (c for c in (story_bible.get("characters") or []) if "主角" in str(c.get("role") or "")),
        None,
    )
    content = (
        f"【场景 {str(scene.get('scene_no') or 1).zfill(2)}】{location} - {time_of_day}\n\n"
        f"{_BEAT_TEMPLATE['setup']} {summary or (episode or {}).get('logline') or story_bible.get('logline') or '故事在这里翻开新的一页。'}\n\n"
        f"{_BEAT_TEMPLATE['development']} {lead.get('name') if lead else '主角'}停住呼吸，让远处的噪音自己消解。"
        "世界仍然在转，但主角已经知道——这场戏的真正节奏，由他自己决定。\n\n"
        f"{_BEAT_TEMPLATE['escalation']} 一束非常规的信号穿透了环境，{title} 的真正含义在这一刻被压到桌面。\n\n"
        f"{_BEAT_TEMPLATE['turn']} {lead.get('name') if lead else '主角'}没有立刻回应。"
        "他/她选择先看清来路，再决定是否要承担起回应之后的代价。\n\n"
        f"{_BEAT_TEMPLATE['resolution']} 镜头缓缓拉远。城市的底噪重新涌回。"
        f"{outline.get('title') or project.get('name') or '本片'}的叙事在这里被轻轻推了一格。"
    ).strip()
    mood = (
        f"{'冷峻、悬疑' if '夜' in str(title) or time_of_day == '夜' else '克制、内敛'}，"
        f"{'压迫感高' if '对决' in str(title) or '战' in str(title) else '情绪密度高'}。"
    )
    return {
        "scene_no": scene.get("scene_no") or 1,
        "title": title,
        "summary": summary,
        "content": content,
        "mood": mood,
        "location": location,
        "time_of_day": time_of_day,
        "estimated_duration": scene.get("estimated_duration") or 120,
    }


def get_configured_video_duration_range(env: dict[str, str] | None = None) -> dict[str, int]:
    """Node getConfiguredVideoDurationRange：按视频模型名判定合法时长区间。"""
    import os

    source = os.environ if env is None else env
    model_name = str(source.get("VIDEO_MODEL") or "").strip()
    provider = str(source.get("VIDEO_PROVIDER") or "").strip().lower()
    if re.match(r"^minimax(?:-|$)", model_name, re.I):
        return {"min": 4, "max": 15}
    # isOfficialAgnesModel：agnes 官方模型名前缀判定（与 Node video.mjs 一致的保守近似）。
    if re.match(r"^agnes-", model_name, re.I) or provider == "agnes":
        return {"min": 4, "max": 12}
    return {"min": 1, "max": 30}


def _validate_configured_video_durations(shots: list[dict[str, Any]], env: dict[str, str] | None = None) -> list[str]:
    """Node validateConfiguredVideoDurations：镜头时长须落在视频模型区间。"""
    video_range = get_configured_video_duration_range(env)
    blockers = []
    for shot in shots:
        duration = shot.get("duration_seconds")
        try:
            value = float(duration)
        except (TypeError, ValueError):
            value = float("nan")
        if not (value == int(value) and video_range["min"] <= value <= video_range["max"]):
            blockers.append(
                f"镜头 {shot.get('shot_no')} 时长须符合当前视频模型 {video_range['min']}-{video_range['max']} 秒范围"
            )
    return blockers


def generate_mock_storyboards(ctx: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    """Node generateMockStoryboards：mock 模式的规则化分镜（确定性）。

    :param ctx: ``{"scene", "project", "scriptContent", "characters", "sceneId"}``。
    :param env: 环境快照（视频模型时长区间判定）。
    :returns: normalize_storyboard_payload 后的 ``{"scene_id", "shots"}``。
    :raises ValueError: mock 时长规划未通过契约/视频区间校验（对齐 Node 抛错）。
    """
    scene = ctx.get("scene") or {}
    project = ctx.get("project") or {}
    content = str(ctx.get("scriptContent") or "")
    project_characters = ctx.get("characters") if isinstance(ctx.get("characters"), list) else []
    character_names = (
        [str(item.get("name") or "").strip() for item in project_characters if str(item.get("name") or "").strip()]
        if project_characters
        else list(_FALLBACK_CHARACTERS)
    )
    paragraph_count = max(2, len(re.split(r"\n{2,}", content)))
    shot_count = min(8, max(4, round(paragraph_count / 2)))
    base_prompt = (
        f"{project.get('visualStyle') or '电影感写实风格'}，{scene.get('location') or '城市夜景'}，"
        f"{scene.get('time_of_day') or '夜'}"
    )
    shots = []
    for i in range(shot_count):
        shot_no = str(i + 1).zfill(2)
        character = _pick(character_names, i)
        shot_type = _pick(_SHOT_TYPES, i)
        camera_angle = _pick(_ANGLES, i + 1)
        composition = _pick(_COMPOSITIONS, i + 2)
        base_duration = 4 + (i % 3)
        action = _MOCK_ACTIONS[i].format(character=character)
        dialogue = _MOCK_DIALOGUES[i]
        duration = max(base_duration, estimate_minimum_dialogue_seconds(dialogue))
        voice_line = (
            "保留环境声，人物不说话时保持短暂静默。"
            if i % 3 == 0
            else "语速自然，关键词轻微重读，句中保留短停顿。"
        )
        dialogue_suffix = f"；对白：{dialogue}" if dialogue and dialogue != "（无对白）" else ""
        shots.append(
            {
                "shot_no": shot_no,
                "shot_type": shot_type,
                "camera_angle": camera_angle,
                "composition": composition,
                "duration_seconds": duration,
                "duration_breakdown": [{"phase": "主要动作与结果", "seconds": duration, "observable": action}],
                "duration_basis": "按单一可见动作及其结果停留时长规划。",
                "character_name": character,
                "action_text": action,
                "dialogue_text": dialogue,
                "visual_prompt": (
                    f"时间轴：0-{duration}秒，{action}；镜头：{shot_type}，{camera_angle}；位置：{composition}；"
                    f"动作：{action}；要求：{base_prompt}，电影感构图，cinemascope 2.39:1{dialogue_suffix}；声音：{voice_line}"
                ),
                "shot_purpose": "hook" if i == 0 else ("reaction" if i % 3 == 0 else "dialogue"),
                "acting_beat": (
                    f"{character}先停顿并观察，再用视线或动作回应刚刚发生的信息。"
                    if i % 3 == 0
                    else f"{character}先吸气确认情绪，再在关键词处停顿后完成动作或对白。"
                ),
                "audio_direction": voice_line,
                "speech_duration_policy": "preserve",
                "reaction_shot": i % 3 == 0,
            }
        )
    normalized = normalize_storyboard_payload({"scene_id": int(ctx.get("sceneId") or 0), "shots": shots}, ctx)
    contract = validate_storyboard_duration_contracts(normalized["shots"], {"requireVisibleTimeline": True})
    model_blockers = _validate_configured_video_durations(normalized["shots"], env)
    if not contract["passed"] or model_blockers:
        raise ValueError(
            "模拟分镜时长规划无效：" + "；".join([*contract["blockers"], *model_blockers])
        )
    return normalized


# ---------------------------------------------------------------------------
# index.mjs 内的 frameRole / 子分镜 / 对白拆分 / 两帧兜底
# ---------------------------------------------------------------------------


def normalize_frame_role(value: Any) -> str:
    """Node normalizeFrameRole：start/end 之外一律 primary。"""
    role = str(value or "").strip().lower()
    return role if role in {"start", "end"} else "primary"


def frame_role_label(role: Any) -> str:
    """Node frameRoleLabel：start → 起始帧 / end → 结束帧 / 其余 → 普通静帧。"""
    normalized = normalize_frame_role(role)
    if normalized == "start":
        return "起始帧"
    if normalized == "end":
        return "结束帧"
    return "普通静帧"


def frame_role_prompt_fallback(shot: dict[str, Any], role: Any) -> str:
    """Node frameRolePromptFallback：按帧角色拼兜底提示词。"""
    normalized = normalize_frame_role(role)
    base = str(shot.get("visual_prompt") or shot.get("action_text") or "").strip()
    if normalized == "start":
        return "，".join(
            part
            for part in (
                str(shot.get("start_visual_prompt") or "").strip(),
                base,
                "起始帧：建立动作开始前的人物姿态、空间位置、镜头构图和光影氛围，为后续动作预留运动空间。",
            )
            if part
        )
    if normalized == "end":
        return "，".join(
            part
            for part in (
                str(shot.get("end_visual_prompt") or "").strip(),
                base,
                "结束帧：表现动作完成后的最终姿态、情绪变化和空间位置，保持同一角色外貌、服装、场景和光线连续。",
            )
            if part
        )
    return base


def fallback_sub_shots(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Node fallbackSubShots：AI 拆分失败时的两段子分镜兜底。"""
    shot = context["storyboard"]
    action = str(shot.get("action_text") or shot.get("visual_prompt") or "人物完成当前动作").strip()
    duration = max(2, float(shot.get("duration_seconds") or 6))
    half_duration = max(1, round(duration / 2))
    base_prompt = str(shot.get("visual_prompt") or action).strip()

    def entry(index: int, action_prefix: str, end_prompt: str) -> dict[str, Any]:
        return {
            "shotType": shot.get("shot_type"),
            "cameraAngle": shot.get("camera_angle"),
            "composition": shot.get("composition"),
            "durationSeconds": int(half_duration if index == 0 else max(1, duration - half_duration)),
            "actionText": f"{action_prefix}：{action}",
            "dialogueText": shot.get("dialogue_text") or "" if index == 0 else "",
            "visualPrompt": base_prompt,
            "startVisualPrompt": (
                f"{base_prompt}，动作开始前的稳定姿态，角色外貌服装保持一致。"
                if index == 0
                else f"{base_prompt}，承接上一子分镜中段姿态。"
            ),
            "endVisualPrompt": end_prompt,
        }

    return [
        entry(0, "动作准备", f"{base_prompt}，动作进行到中段，重心和视线发生变化，角色外貌服装保持一致。"),
        entry(1, "动作完成", f"{base_prompt}，动作完成后的收束姿态，角色外貌服装保持一致。"),
    ]


def normalize_sub_shots(raw_sub_shots: Any, context: dict[str, Any]) -> list[dict[str, Any]]:
    """Node normalizeSubShots：AI 子分镜列表归一（≤4 条、字段兜底）。"""
    fallback = fallback_sub_shots(context)
    shot = context["storyboard"]
    items = raw_sub_shots if isinstance(raw_sub_shots, list) else fallback
    normalized = []
    for index, item in enumerate(items[:4]):
        item = item if isinstance(item, dict) else {}
        duration_raw = item.get("durationSeconds")
        duration = _parse_id(duration_raw) or math.ceil(float(shot.get("duration_seconds") or 4) / 2)
        entry = {
            "shotType": str(item.get("shotType") or shot.get("shot_type") or "").strip() or None,
            "cameraAngle": str(item.get("cameraAngle") or shot.get("camera_angle") or "").strip() or None,
            "composition": str(item.get("composition") or shot.get("composition") or "").strip() or None,
            "durationSeconds": max(1, min(12, duration)),
            "actionText": str(item.get("actionText") or fallback[index].get("actionText") if index < len(fallback) else item.get("actionText") or shot.get("action_text") or "").strip(),
            "dialogueText": str(item.get("dialogueText") if item.get("dialogueText") is not None else ((shot.get("dialogue_text") or "") if index == 0 else "")).strip(),
            "visualPrompt": str(item.get("visualPrompt") or (fallback[index].get("visualPrompt") if index < len(fallback) else None) or shot.get("visual_prompt") or "").strip(),
            "startVisualPrompt": str(item.get("startVisualPrompt") or (fallback[index].get("startVisualPrompt") if index < len(fallback) else "") or "").strip(),
            "endVisualPrompt": str(item.get("endVisualPrompt") or (fallback[index].get("endVisualPrompt") if index < len(fallback) else "") or "").strip(),
            "gazePlan": item.get("gazePlan") or item.get("gaze_plan") or shot.get("gaze_plan") or None,
            "soundPlan": item.get("soundPlan") or item.get("sound_plan") or shot.get("sound_plan") or None,
        }
        if entry["actionText"] or entry["visualPrompt"]:
            normalized.append(entry)
    return normalized


def _parse_id(value: Any) -> int:
    """Node parseId：正数取整，否则 0。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return int(parsed) if math.isfinite(parsed) and parsed > 0 else 0


def build_sub_shot_direction_reference(
    source_reference: Any, source_shot: dict[str, Any], sub_shot: dict[str, Any]
) -> dict[str, Any]:
    """Node buildSubShotDirectionReference：子分镜继承视线/声音执行计划。"""
    reference = source_reference if isinstance(source_reference, dict) else _json_object(source_reference) or {}
    performance = normalize_storyboard_performance(
        {
            **source_shot,
            **sub_shot,
            "gazePlan": sub_shot.get("gazePlan") or reference.get("gazePlan") or (reference.get("performance") or {}).get("gazePlan"),
            "soundPlan": sub_shot.get("soundPlan") or reference.get("soundPlan") or (reference.get("performance") or {}).get("soundPlan"),
        }
    )
    direction = {
        **_direction_contract_validate(
            {
                **source_shot,
                **sub_shot,
                "gazePlan": performance["gazePlan"],
                "soundPlan": performance["soundPlan"],
            }
        )
    }
    return {
        **reference,
        "gazePlan": direction["gaze"],
        "soundPlan": direction["sound"],
        "performance": {
            **performance,
            "gazePlan": direction["gaze"],
            "soundPlan": direction["sound"],
        },
    }


def _direction_contract_validate(input_data: dict[str, Any]) -> dict[str, Any]:
    """validateStoryboardDirectionContract 的本地别名（复用 app.direction_contract）。"""
    from app.direction_contract import validate_direction

    return validate_direction(input_data)


def _json_object(value: Any) -> Any:
    """宽松 JSON 对象解析（None/非 dict 返回 None）。"""
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value or ""))
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _resolve_character_for_dialogue(context: dict[str, Any], speaker_name: Any) -> dict[str, Any] | None:
    """Node resolveCharacterForDialogue：说话人名精确匹配角色库。"""
    name = str(speaker_name or "").strip()
    if not name:
        return None
    return next((c for c in context["characters"] if str(c.get("name") or "").strip() == name), None)


def parse_dialogue_turns(dialogue_text: Any, context: dict[str, Any]) -> list[dict[str, Any]]:
    """Node parseDialogueTurns：按「角色名：对白」拆说话轮次。

    :param dialogue_text: 原始对白文本。
    :param context: 含 characters 的上下文。
    :returns: ``[{"speakerName", "characterId", "text"}]``。
    """
    source = str(dialogue_text or "").strip()
    names = sorted(
        {str(item.get("name") or "").strip() for item in context.get("characters", []) if str(item.get("name") or "").strip()},
        key=len,
        reverse=True,
    )
    turns: list[dict[str, Any]] = []
    if not source or not names:
        return turns
    label_regex = re.compile("【?(" + "|".join(re.escape(name) for name in names) + ")】?[：:]\\s*")
    labels = list(label_regex.finditer(source))
    if labels:
        for index, label in enumerate(labels):
            next_label = labels[index + 1] if index + 1 < len(labels) else None
            character = _resolve_character_for_dialogue(context, label.group(1))
            text = re.sub(r"^[\s，,。；;]+", "", source[label.end() : next_label.start() if next_label else len(source)]).strip()
            if not character or not text:
                continue
            turns.append({"speakerName": character["name"], "characterId": int(character["id"]), "text": text})
        return turns
    for line in [line.strip() for line in re.split(r"\r?\n", source) if line.strip()]:
        match = re.match(r"^【?([^：:]{1,30})】?[：:]\s*(.+)$", line)
        if not match:
            continue
        speaker_name = re.sub(r"[（）()【】\s]", "", match.group(1)).strip()
        text = match.group(2).strip()
        character = _resolve_character_for_dialogue(context, speaker_name)
        if not character or not text:
            continue
        turns.append({"speakerName": character["name"], "characterId": int(character["id"]), "text": text})
    return turns


def fallback_dialogue_sub_shots(context: dict[str, Any]) -> list[dict[str, Any]]:
    """Node fallbackDialogueSubShots：按说话轮次生成可做口型的短分镜兜底。"""
    shot = context["storyboard"]
    turns = parse_dialogue_turns(shot.get("dialogue_text"), context)
    base_prompt = str(shot.get("visual_prompt") or shot.get("action_text") or "").strip()
    sub_shots = []
    for index, turn in enumerate(turns):
        text_length = len(turn["text"])
        sub_shots.append(
            {
                "speakerName": turn["speakerName"],
                "characterId": turn["characterId"],
                "shotType": shot.get("shot_type") or "中近景",
                "cameraAngle": shot.get("camera_angle") or "平视机位",
                "composition": shot.get("composition") or "对话构图",
                "durationSeconds": max(2, min(6, math.ceil(text_length / 8))),
                "actionText": (
                    f"{turn['speakerName']}开始说话，其他角色保持反应状态。"
                    if index == 0
                    else f"{turn['speakerName']}承接上一句对白继续回应。"
                ),
                "dialogueText": f"{turn['speakerName']}：{turn['text']}",
                "visualPrompt": "，".join(
                    part
                    for part in (
                        base_prompt,
                        f"{turn['speakerName']}作为当前说话主体，镜头重点捕捉其面部、口型、眼神和身体反应。",
                        "同场其他角色可以入画但不张嘴，作为倾听或反应人物。",
                    )
                    if part
                ),
                "startVisualPrompt": "，".join(
                    part for part in (base_prompt, f"{turn['speakerName']}说话前的准备姿态，视线和情绪承接上一镜。") if part
                ),
                "endVisualPrompt": "，".join(
                    part for part in (base_prompt, f"{turn['speakerName']}说完这句对白后的表情停顿，其他角色保持连续反应。") if part
                ),
            }
        )
    return sub_shots


def normalize_dialogue_sub_shots(raw_sub_shots: Any, context: dict[str, Any]) -> list[dict[str, Any]]:
    """Node normalizeDialogueSubShots：多人对白子分镜归一（≤8 条、必须绑定角色）。"""
    fallback = fallback_dialogue_sub_shots(context)
    shot = context["storyboard"]
    items = raw_sub_shots if isinstance(raw_sub_shots, list) and raw_sub_shots else fallback
    normalized = []
    for index, item in enumerate(items[:8]):
        item = item if isinstance(item, dict) else {}
        character = (
            _resolve_character_for_dialogue(context, item.get("speakerName") or item.get("characterName"))
            or next((c for c in context["characters"] if float(c.get("id") or 0) == float(item.get("characterId") or -1)), None)
            or (
                next(
                    (c for c in context["characters"] if float(c.get("id") or 0) == float(fallback[index]["characterId"])),
                    None,
                )
                if index < len(fallback) and fallback[index].get("characterId")
                else None
            )
        )
        duration_raw = item.get("durationSeconds")
        duration = (
            _parse_id(duration_raw)
            or (fallback[index].get("durationSeconds") if index < len(fallback) else None)
            or 4
        )
        entry = {
            "characterId": int(character["id"]) if character else None,
            "characterName": str(character.get("name") or "").strip() if character else "",
            "shotType": str(item.get("shotType") or shot.get("shot_type") or "中近景").strip() or None,
            "cameraAngle": str(item.get("cameraAngle") or shot.get("camera_angle") or "平视机位").strip() or None,
            "composition": str(item.get("composition") or shot.get("composition") or "对话构图").strip() or None,
            "durationSeconds": max(1, min(12, duration)),
            "actionText": str(item.get("actionText") or (fallback[index].get("actionText") if index < len(fallback) else "") or "").strip(),
            "dialogueText": str(item.get("dialogueText") or (fallback[index].get("dialogueText") if index < len(fallback) else "") or "").strip(),
            "visualPrompt": str(item.get("visualPrompt") or (fallback[index].get("visualPrompt") if index < len(fallback) else None) or shot.get("visual_prompt") or "").strip(),
            "startVisualPrompt": str(item.get("startVisualPrompt") or (fallback[index].get("startVisualPrompt") if index < len(fallback) else "") or "").strip(),
            "endVisualPrompt": str(item.get("endVisualPrompt") or (fallback[index].get("endVisualPrompt") if index < len(fallback) else "") or "").strip(),
            "gazePlan": item.get("gazePlan") or item.get("gaze_plan") or shot.get("gaze_plan") or None,
            "soundPlan": item.get("soundPlan") or item.get("sound_plan") or shot.get("sound_plan") or None,
        }
        if entry["characterId"] and entry["dialogueText"]:
            normalized.append(entry)
    return normalized


def simple_keyframe_prompt_fallback(context: dict[str, Any]) -> dict[str, str]:
    """Node simpleKeyframePromptFallback：两帧提示词的本地兜底规则。"""
    shot = context["storyboard"]
    character_text = "\n".join(
        "，".join(
            part
            for part in (item.get("name"), item.get("role_tag"), item.get("gender"), item.get("age_group"), item.get("appearance"))
            if part
        )
        for item in context.get("characters", [])
        if any((item.get(k) for k in ("name", "role_tag", "gender", "age_group", "appearance")))
    )
    scene = context["scene"]
    base = "，".join(
        part
        for part in (
            context["project"].get("visualStyle"),
            scene.get("location"),
            scene.get("timeOfDay"),
            shot.get("shot_type"),
            shot.get("camera_angle"),
            shot.get("composition"),
            shot.get("visual_prompt"),
        )
        if part
    )
    action = str(shot.get("action_text") or "").strip()
    shared = "，".join(
        part for part in (base, f"角色外貌锁定：{character_text}" if character_text else "", "保持同一角色脸型、发型、服装、体型、年龄感和场景光线连续。") if part
    )
    return {
        "startVisualPrompt": "，".join(
            part
            for part in (
                shared,
                f"动作开始前：{action}" if action else "动作开始前：人物处在准备动作的稳定姿态。",
                "起始帧需要清楚交代人物站位、视线方向、道具位置和运动空间。",
            )
            if part
        ),
        "endVisualPrompt": "，".join(
            part
            for part in (
                shared,
                f"动作完成后：{action}" if action else "动作完成后：人物处在动作结束的稳定姿态。",
                "结束帧需要体现动作结果、表情变化、身体重心变化和场景连续性。",
            )
            if part
        ),
        "notes": "已使用本地兜底规则生成，建议确认后再生成起始帧和结束帧。",
    }


def _clip(value: Any, max_length: int) -> str:
    """frame-prompt.mjs clip：截断到指定长度。"""
    return _text(value)[:max_length]


def build_mock_visual_prompt(ctx: dict[str, Any]) -> str:
    """Node buildMockVisualPrompt（frame-prompt.mjs）：mock 视觉提示词兜底。"""
    project = ctx.get("project") or {}
    scene = ctx.get("scene") or {}
    storyboard = ctx.get("storyboard") or {}
    character_name = _text(storyboard.get("character_name") or storyboard.get("characterName"))
    action = _text(
        storyboard.get("action_text") or storyboard.get("actionText"),
        f"{character_name}根据剧情推进做出克制而明确的动作" if character_name else "镜头捕捉场景中的关键变化",
    )
    shot_type = _text(storyboard.get("shot_type") or storyboard.get("shotType"), "中景")
    camera_angle = _text(storyboard.get("camera_angle") or storyboard.get("cameraAngle"), "平视机位")
    composition = _text(storyboard.get("composition"), "电影感构图")
    return "，".join(
        part
        for part in (
            _text(project.get("visual_style") or project.get("visualStyle"), "电影感写实风格"),
            f"{_text(scene.get('location'), '当前场景')}，{_text(scene.get('time_of_day') or scene.get('timeOfDay'), '夜')}，{shot_type}，{camera_angle}，{composition}",
            _text(scene.get("summary"), ""),
            action,
            (
                f"{character_name}出现在画面中，但人物脸部、发型、体态、服装和随身物件严格交由定妆图与角色一致性约束决定，视觉提示词不重新改写外貌"
                if character_name
                else ""
            ),
            "强调环境信息、叙事动作、光线方向、空间层次、道具关系和情绪氛围，避免写入新的角色长相设定",
        )
        if part
    )


# ---------------------------------------------------------------------------
# agent/quality-gate.mjs（资产引用门禁）+ asset-catalog + mentioned prompt
# ---------------------------------------------------------------------------


def _requires_character_face_reference(reference: dict[str, Any]) -> bool:
    """Node requiresCharacterFaceReference（quality-gate 内）：旧快照保持严格门禁。"""
    return reference.get("characterFaceRequired") is not False


def inspect_storyboard_asset_reference_gate(
    *, storyboard: dict[str, Any], require_character: bool = True, require_scene: bool = True
) -> dict[str, Any]:
    """Node inspectStoryboardAssetReferenceGate：静帧/视频生成前的资产引用门禁。

    :param storyboard: 分镜行（asset_reference_json / assetReference）。
    :param require_character: 是否校验角色资产引用。
    :param require_scene: 是否校验场景资产引用。
    :returns: ``{"passed", "blockers", "reference", "summary"}``（blocker 为
        ``{"code","message","severity"}``，summary 与 Node 逐字一致）。
    """
    blockers: list[dict[str, str]] = []
    reference = _json_object(
        storyboard.get("asset_reference_json", storyboard.get("assetReference", storyboard.get("asset_reference")))
    ) or {}

    def issue(code: str, message: str) -> dict[str, str]:
        return {"code": code, "message": message, "severity": "blocker"}

    def num(value: Any) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return 0
        return parsed if math.isfinite(parsed) else 0

    if require_character:
        has_character_asset_pack = num(reference.get("characterAssetPackImageId")) > 0 and num(
            reference.get("characterAssetPackVersionNo")
        ) > 0
        if not (num(reference.get("characterId")) or num(storyboard.get("character_id"))):
            blockers.append(issue("character-asset-reference-missing", "分镜缺少角色资产引用"))
        if not num(reference.get("characterVersionNo")):
            blockers.append(issue("character-version-reference-missing", "分镜缺少角色版本引用"))
        view_keys = reference.get("characterViewKeys")
        if (
            not num(reference.get("characterViewSetVersion"))
            or not isinstance(view_keys, list)
            or len(view_keys) < 3
        ):
            blockers.append(issue("character-view-set-reference-missing", "分镜缺少角色三视图版本引用"))
        if not all(key in (view_keys or []) for key in ("front", "side", "back")):
            blockers.append(issue("character-view-angle-reference-incomplete", "分镜角色三视图缺少正面、侧面或背面引用"))
        if not has_character_asset_pack and (
            not num(reference.get("characterBaseImageId")) or not num(reference.get("characterBaseVersionNo"))
        ):
            blockers.append(issue("character-base-image-reference-missing", "分镜缺少角色基础正面全身图引用"))
        if (
            not has_character_asset_pack
            and _requires_character_face_reference(reference)
            and (not num(reference.get("characterFaceImageId")) or not num(reference.get("characterFaceVersionNo")))
        ):
            blockers.append(issue("character-face-closeup-reference-missing", "分镜缺少角色脸部特写引用"))

    if require_scene:
        if not num(reference.get("sceneAssetId")):
            blockers.append(issue("scene-asset-reference-missing", "分镜缺少场景资产引用"))
        if not num(reference.get("scenePanoramaVersion")):
            blockers.append(issue("scene-panorama-reference-missing", "分镜缺少场景全景版本引用"))

    return {
        "passed": not blockers,
        "blockers": blockers,
        "reference": reference,
        "summary": f"资产引用门禁未通过：{len(blockers)} 个问题需要处理" if blockers else "资产引用门禁通过",
    }


def _positive_int(value: Any, fallback: int | None = None) -> int | None:
    """asset-catalog positiveInt：parseInt 语义的正整数。"""
    try:
        parsed = int(str(value if value is not None else "").strip(), 10)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def build_storyboard_asset_catalog(asset_rows: list[dict[str, Any]] | None, scene_id: int = 0) -> dict[str, Any]:
    """Node buildStoryboardAssetCatalog：确认图分组（scenes/props/tools）。"""
    scenes: dict[str, dict[str, Any]] = {}
    props: dict[str, dict[str, Any]] = {}

    def is_confirmed(row: dict[str, Any], node_type: str) -> bool:
        if _text(row.get("status")) != "confirmed":
            return False
        vision_status = _text(row.get("vision_status"))
        return vision_status == "passed" or (node_type == "scene" and vision_status == "skipped")

    def merge(entry: dict[str, Any], row: dict[str, Any]) -> None:
        image_id = _positive_int(row.get("image_id"))
        if not image_id:
            return
        image = {
            "imageId": image_id,
            "versionNo": _positive_int(row.get("version_no"), 1),
            "viewSetVersion": _positive_int(row.get("view_set_version"), 1),
            "viewIndex": _positive_int(row.get("view_index")),
            "viewKey": _text(row.get("view_key")) or None,
            "viewSetType": _text(row.get("view_set_type")) or "single",
            "status": "confirmed",
            "visionStatus": _text(row.get("vision_status")),
        }
        if not any(item["imageId"] == image["imageId"] for item in entry["confirmedImages"]):
            entry["confirmedImages"].append(image)
        if image["viewKey"] and image["viewKey"] not in entry["sceneViewKeys"]:
            entry["sceneViewKeys"].append(image["viewKey"])
        entry["versionNo"] = max(entry["versionNo"], image["versionNo"])
        entry["viewSetVersion"] = max(entry["viewSetVersion"], image["viewSetVersion"])

    def new_entry(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": _text(row.get("label")),
            "assetNodeId": _positive_int(row.get("asset_node_id")),
            "nodeType": _text(row.get("node_type")),
            "refId": _positive_int(row.get("ref_id")),
            "assetPrompt": _text(row.get("asset_prompt")) or None,
            "versionNo": 0,
            "viewSetVersion": 0,
            "sceneViewKeys": [],
            "confirmedImages": [],
        }

    for row in asset_rows or []:
        node_type = _text(row.get("node_type"))
        if not is_confirmed(row, node_type):
            continue
        name = _text(row.get("label"))
        asset_node_id = _positive_int(row.get("asset_node_id"))
        if not name or not asset_node_id:
            continue
        if node_type == "scene" and (not _positive_int(scene_id) or _positive_int(row.get("ref_id")) == _positive_int(scene_id)):
            key = str(asset_node_id)
            entry = scenes.get(key) or new_entry(row)
            merge(entry, row)
            scenes[key] = entry
        if node_type in {"prop", "tool", "material"}:
            key = str(asset_node_id)
            entry = props.get(key) or new_entry(row)
            merge(entry, row)
            props[key] = entry
    return {
        "scenes": list(scenes.values()),
        "props": list(props.values()),
        "tools": ["添加时间", "片段衔接", "首尾帧参考", "环境音"],
    }


_MENTION_NAME_BOUNDARY = r"(?=$|[^\w])"


def build_storyboard_mentioned_prompt(prompt: Any, asset_reference: dict[str, Any] | None = None) -> str:
    """Node buildStoryboardMentionedPrompt：把 @角色/@场景/@道具/@工具 引用补进提示词。

    :param prompt: 原始视觉提示词。
    :param asset_reference: 资产引用快照（characterName/sceneAssetNames/...）。
    :returns: 补齐引用后的提示词；缺失引用以「【执行引用】…」前缀提示。
    """
    reference = asset_reference or {}
    source = _text(prompt)
    scene_names = reference.get("sceneAssetNames") if isinstance(reference.get("sceneAssetNames"), list) else []
    prop_names = reference.get("propAssetNames") if isinstance(reference.get("propAssetNames"), list) else []
    asset_names = [
        _text(part)
        for part in (reference.get("characterName"), *scene_names, *prop_names)
        if _text(part)
    ]
    mentions = [f"@{name}" for name in asset_names]
    tool_names = [_text(item) for item in (reference.get("tools") if isinstance(reference.get("tools"), list) else [])]
    tools = [
        (
            f"@片段衔接[镜头{_text(reference.get('continuityFromShot'))}]"
            if name == "片段衔接" and reference.get("continuityFromShot")
            else f"@{name}"
        )
        for name in tool_names
        if _text(name)
    ]
    voice_mention = (
        f"@音色[{_text(reference.get('characterName'))}]"
        if reference.get("characterName") and (reference.get("voiceProfileKey") or reference.get("voiceLocked"))
        else ""
    )
    tokens = [token for token in [*mentions, voice_mention, *tools] if token]
    result = source
    missing: list[str] = []
    for token in tokens:
        if token in result:
            continue
        name = (
            "片段衔接"
            if token.startswith("@片段衔接[")
            else ("" if token.startswith("@音色[") else token[1:])
        )
        if name and re.search(rf"(^|[^@\w]){re.escape(name)}(?=$|[^\w])", result):
            result = re.sub(rf"(^|[^@\w])({re.escape(name)})(?=$|[^\w])", lambda m: f"{m.group(1)}{token}", result, count=1)
        else:
            missing.append(token)
    if missing:
        return f"【执行引用】{' '.join(missing)}\n{result}".strip()
    return result


def match_character_id(character_name: Any, characters: list[dict[str, Any]]) -> int | None:
    """Node matchCharacterId：精确名 → 部分匹配 → None。"""
    normalized = str(character_name or "").strip().lower()
    if not normalized:
        return None
    for item in characters:
        if str(item.get("name") or "").strip().lower() == normalized:
            return int(item.get("id") or 0) or None
    for item in characters:
        name = str(item.get("name") or "").strip().lower()
        if name and (normalized in name or name in normalized):
            return int(item.get("id") or 0) or None
    return None


_NO_FACE_PATTERN = re.compile(r"不露脸|不露面|不出镜|不直接露脸|不直接露面|不出现正脸|正脸不呈现|脸部(?:不可见|不入镜)|只拍到[^。；\n]{0,24}(?:袖口|手部|身体)|仅(?:有)?声音|画外音")


def has_explicit_no_face_constraint(*values: Any) -> bool:
    """Node hasExplicitNoFaceConstraint：任意文本命中不露脸词表。"""
    return any(_NO_FACE_PATTERN.search(str(value)) for value in values if value is not None)


def requires_character_face_reference(character: dict[str, Any], *script_values: Any) -> bool:
    """Node requiresCharacterFaceReference（character-face-policy.mjs）。

    :param character: 角色行（face_visibility 显式声明优先）。
    :param script_values: 剧本/提示词文本（检测不露脸约束）。
    :returns: 是否需要角色脸部特写参考。
    """
    explicit = str(character.get("face_visibility", character.get("faceVisibility")) or "").strip().lower()
    if explicit in {"not_visible", "not-visible", "off_camera", "off-camera"}:
        return False
    if explicit in {"visible", "partial"}:
        return True
    return not has_explicit_no_face_constraint(
        character.get("appearance"),
        character.get("costume"),
        character.get("role_tag"),
        *script_values,
    )


# ---------------------------------------------------------------------------
# ai/genre-skill-profile.mjs（题材技能提示词）
# ---------------------------------------------------------------------------

_GENRE_PROFILES: dict[str, dict[str, str]] = {
    "mystery": {
        "key": "mystery", "label": "悬疑推理",
        "visual": "现实材质、低照度局部光源、冷暖信息差、可追踪的空间锚点",
        "composition": "用遮挡、前后景、留白和视线方向制造信息差；线索必须有可复核的画面位置",
        "performance": "保留停顿、迟疑、压低声音和微表情，反转前不提前解释答案",
        "continuity": "道具、门窗、屏幕、光线方向和人物站位在镜头之间保持可追踪",
        "forbidden": "禁止无因果的炫技运镜、凭空新增线索、把氛围词当成剧情信息",
    },
    "urban": {
        "key": "urban", "label": "都市情感",
        "visual": "生活化真实空间、自然肤色、可见材质磨损和克制的环境光",
        "composition": "用人物距离、视线和空间阻隔表达关系变化，避免摆拍式对称",
        "performance": "重视呼吸、停顿、未说出口的反应和细小动作",
        "continuity": "服装、手机、杯子、文件和人物相对距离必须连续",
        "forbidden": "禁止悬浮道具、塑料皮肤、无生活痕迹的样板间和过度滤镜",
    },
    "fantasy": {
        "key": "fantasy", "label": "古风玄幻",
        "visual": "东方建筑、真实织物纹样、自然烟尘和有来源的法术光效",
        "composition": "用门廊、台阶、屏风和远近层级组织世界规则与人物关系",
        "performance": "动作遵守身份礼法和力量等级，情绪通过姿态与节奏递进",
        "continuity": "服饰纹样、兵器、建筑朝向、光源和法术颜色必须锁定",
        "forbidden": "禁止现代建筑零件、无来源的霓虹光、纹样漂移和时代混杂",
    },
    "sciFi": {
        "key": "sciFi", "label": "科幻剧情",
        "visual": "工业材质、设备尺度、真实反射、冷光与警示色的功能性对比",
        "composition": "用设备、门禁、屏幕和空间尺度表达规则，不用泛化的未来感代替细节",
        "performance": "人物动作要与设备反馈和风险节拍同步，关键操作必须可见",
        "continuity": "设备接口、线缆、门窗、警示灯、屏幕位置和光线方向保持一致",
        "forbidden": "禁止随机科技面板、无功能的发光线条、游戏场景感和镜像布局",
    },
    "adventure": {
        "key": "adventure", "label": "热血冒险",
        "visual": "真实环境阻力、清楚的动作方向、动态但可信的自然光",
        "composition": "先建立目标和路径，再用景别变化强调动作结果与代价",
        "performance": "动作前有准备，动作中有受力，动作后有反应，不跳帧式瞬移",
        "continuity": "伤痕、装备、方向、地形和动作起止姿态连续",
        "forbidden": "禁止没有空间依据的飞跃、装备瞬移、动作方向反转",
    },
    "comedy": {
        "key": "comedy", "label": "轻喜反转",
        "visual": "明确信息层级、自然生活色彩和略快的反应节奏",
        "composition": "让观众先看见误会来源，再看见角色反应，反转信息不能被构图遮住",
        "performance": "重视反应镜头、停顿和节奏错位，台词与口型长度保持真实",
        "continuity": "笑点道具和人物视线在前后镜头中保持位置稳定",
        "forbidden": "禁止用夸张变形代替表演、无铺垫反转和随机表情",
    },
    "growth": {
        "key": "growth", "label": "成长逆袭",
        "visual": "通过服装、环境层级、光线和姿态表现阶段变化",
        "composition": "前期保留压迫空间，后期逐步增加主体空间与视线高度",
        "performance": "每次选择都留下身体和情绪后果，胜利不能跳过代价",
        "continuity": "阶段性服装、道具、伤痕和空间进出轨迹必须有记录",
        "forbidden": "禁止突然变强、服装无因果变化和无来源的情绪切换",
    },
    "dual": {
        "key": "dual", "label": "双强关系",
        "visual": "平衡的空间重量、清楚的视线轴和克制的光影对峙",
        "composition": "用对称或反对称构图表达势均力敌，保持双方都可读",
        "performance": "双方都有主动动作和反应，不把一方写成纯粹背景",
        "continuity": "对峙轴线、人物距离、视线方向和道具归属保持连续",
        "forbidden": "禁止无理由的角色降智、站位跳变和单方面抢镜",
    },
}

_GENRE_CATEGORY_MAP: tuple[tuple[str, str], ...] = (
    ("悬疑", "mystery"), ("推理", "mystery"),
    ("都市情感", "urban"), ("情感", "urban"),
    ("古风", "fantasy"), ("玄幻", "fantasy"),
    ("科幻", "sciFi"),
    ("热血", "adventure"), ("冒险", "adventure"),
    ("轻喜", "comedy"), ("反转", "comedy"),
    ("成长", "growth"), ("逆袭", "growth"),
    ("双强", "dual"),
)


def build_genre_prompt_context(category: Any = "", scope: str = "") -> str:
    """Node buildGenrePromptContext：确定性题材技能提示词段。"""
    source = _text(category)
    key = next((target for needle, target in _GENRE_CATEGORY_MAP if needle in source), "mystery")
    profile = _GENRE_PROFILES[key]
    scope_rule = {
        "character": "资产范围：只输出角色外貌、发型、妆容、身体、服装和配饰的可复现规则；不得把场景、台词或镜头事件写入角色资产。",
        "scene": "资产范围：只输出空场空间、建筑、固定物件、材质、光源、色彩和机位规则；不得把人物外貌、服装、动作或对白写入场景资产。",
        "prop": "资产范围：只输出道具结构、材质、尺寸、使用痕迹和多视角规则；不得把角色或完整场景写入道具资产。",
        "storyboard": "分镜范围：仅在单镜头确有需要时组合角色、场景和道具资产，并保持@引用、情绪表演和时空连续。",
    }.get(str(scope or "").strip(), "")
    lines = [
        f"题材技能配置：{profile['label']}（profile={profile['key']}）",
        f"视觉叙事规则：{profile['visual']}",
        f"构图规则：{profile['composition']}",
        f"表演节奏规则：{profile['performance']}",
        f"连续性规则：{profile['continuity']}",
        # 对齐 Node genre-skill-profile.mjs L116 的逐字文案（「禁止事项」）。
        f"禁止事项：{profile['forbidden']}",
    ]
    if scope_rule:
        lines.append(scope_rule)
    return "\n".join(lines)
