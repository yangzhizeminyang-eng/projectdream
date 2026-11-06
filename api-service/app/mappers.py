import json
import re
from typing import Any
from urllib.parse import urlsplit


def normalize_generated_media_url(value: Any, public_base_url: Any = "") -> Any:
    """Node normalizeGeneratedMediaUrl（media-public-url.mjs）：/generated/* 旧域名地址按当前基址重建。

    :param value: 历史媒体地址。
    :param public_base_url: 当前公网基址（PUBLIC_BASE_URL）。
    :returns: 规范化地址；无基址或不可解析时原样返回（空值返回 None）。
    """
    raw = str(value or "").strip()
    base = str(public_base_url or "").strip().rstrip("/")
    if not raw or not base:
        return raw or None
    parts = urlsplit(raw)
    base_parts = urlsplit(base)
    # Node `new URL(...)` 对相对/非法地址抛错并原样返回；等价要求 scheme+host 齐全。
    if not (parts.scheme in {"http", "https"} and parts.netloc):
        return raw
    if not (base_parts.scheme in {"http", "https"} and base_parts.netloc):
        return raw
    path = parts.path or "/"
    if not re.match(r"^/generated/(?:video|audio|frame|export)/", path, re.I):
        return raw
    return f"{base_parts.scheme}://{base_parts.netloc}{path}{('?' + parts.query) if parts.query else ''}{('#' + parts.fragment) if parts.fragment else ''}"


def video_asset_row(
    row: dict[str, Any],
    *,
    resolve_storage_url: Any = None,
    public_base_url: Any = "",
) -> dict[str, Any]:
    """Node videoAssetRow（index.mjs L8805）：video_assets 行 → 前端 DTO。

    :param row: video_assets 行（snake_case 列）。
    :param resolve_storage_url: storage_key → 签名 URL 回调（失败/缺失回退历史地址）。
    :param public_base_url: 当前公网基址（无 storage_key 时规范化 /generated/* 地址）。
    :returns: videoAsset DTO（qualityReport 已 JSON 解析，解析失败为 None）。
    """
    storage_key = _value(row, "storage_key", "storageKey")
    end_frame_storage_key = _value(row, "end_frame_storage_key", "endFrameStorageKey")

    def _resolve(key: Any, fallback: Any) -> Any:
        if key and callable(resolve_storage_url):
            try:
                signed = resolve_storage_url(key)
                if signed:
                    return signed
            except Exception:
                pass
        return fallback

    quality_report = _value(row, "quality_report_json", "qualityReportJson")
    if isinstance(quality_report, str):
        try:
            quality_report = json.loads(quality_report)
        except (TypeError, ValueError):
            quality_report = None
    return {
        "id": row["id"],
        "storyboardId": _value(row, "storyboard_id", "storyboardId"),
        "imageAssetId": _value(row, "image_asset_id", "imageAssetId"),
        "versionNo": _value(row, "version_no", "versionNo"),
        "videoUrl": (
            _resolve(storage_key, _value(row, "video_url", "videoUrl"))
            if storage_key
            else normalize_generated_media_url(_value(row, "video_url", "videoUrl"), public_base_url)
        ),
        "storageKey": storage_key,
        "endFrameUrl": (
            _resolve(end_frame_storage_key, row.get("end_frame_url"))
            if end_frame_storage_key
            else normalize_generated_media_url(_value(row, "end_frame_url", "endFrameUrl"), public_base_url)
        ),
        "endFrameStorageKey": end_frame_storage_key,
        "thumbnailUrl": normalize_generated_media_url(_value(row, "thumbnail_url", "thumbnailUrl"), public_base_url),
        "motionMode": _value(row, "motion_mode", "motionMode"),
        "durationSeconds": _value(row, "duration_seconds", "durationSeconds"),
        "modelName": _value(row, "model_name", "modelName"),
        "audioAssetId": _value(row, "audio_asset_id", "audioAssetId"),
        "generationJobId": _value(row, "generation_job_id", "generationJobId"),
        "qualityReport": quality_report,
        "sourceType": _value(row, "source_type", "sourceType", default="generated_video"),
        "status": row.get("status"),
        "confirmedAt": _value(row, "confirmed_at", "confirmedAt"),
        "createdAt": _value(row, "created_at", "createdAt"),
    }


def _value(row: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if row.get(key) is not None:
            return row[key]
    return default


def _string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if item]
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def voice_profile_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "profileKey": _value(row, "profile_key", "profileKey"),
        "displayName": _value(row, "display_name", "displayName"),
        "provider": row.get("provider"),
        "modelName": _value(row, "model_name", "modelName"),
        "voiceId": _value(row, "voice_id", "voiceId"),
        "gender": row.get("gender"),
        "ageGroups": _string_list(_value(row, "age_groups", "ageGroups")),
        "styleTags": _string_list(_value(row, "style_tags", "styleTags")),
        "description": row.get("description") or "",
        "instructions": row.get("instructions") or "",
        "languageType": _value(row, "language_type", "languageType", default="Chinese"),
        "status": row.get("status") or "active",
        "sortOrder": int(_value(row, "sort_order", "sortOrder", default=0) or 0),
    }


def project_row(row: dict[str, Any]) -> dict[str, Any]:
    outline_count = int(row.get("outline_count") or 0)
    scene_count = int(row.get("scene_count") or 0)
    storyboard_count = int(row.get("storyboard_count") or 0)
    image_count = int(row.get("confirmed_image_count") or 0)
    video_count = int(row.get("confirmed_video_count") or 0)
    audio_count = int(row.get("confirmed_audio_count") or 0)
    completed_export_count = 1 if row.get("latest_export_id") else 0
    progress = min(100, round((15 if outline_count else 0) + (15 if scene_count else 0)
        + (20 * min(1, storyboard_count / scene_count) if scene_count else 0)
        + (15 * min(1, image_count / storyboard_count) if storyboard_count else 0)
        + (20 * min(1, video_count / storyboard_count) if storyboard_count else 0)
        + (10 if audio_count else 0)
        + (5 if completed_export_count else 0)))
    if completed_export_count:
        stage = "已导出成片"
    elif video_count > 0:
        stage = "视频素材已就绪 · 待导出"
    elif image_count > 0:
        stage = "静帧素材制作中"
    elif storyboard_count > 0:
        stage = "分镜制作中"
    elif scene_count > 0:
        stage = "剧本已就绪 · 待拆分镜"
    elif outline_count > 0:
        stage = "总纲已就绪 · 待拆场景"
    else:
        stage = "待创建总纲"
    result = {
        "id": row["id"],
        "userId": _value(row, "user_id", "userId"),
        "name": row.get("name"),
        "category": row.get("category"),
        "targetDuration": _value(row, "target_duration", "targetDuration"),
        "narrativeVision": _value(row, "narrative_vision", "narrativeVision"),
        "visualStyle": _value(row, "visual_style", "visualStyle"),
        "aspectRatio": _value(row, "aspect_ratio", "aspectRatio"),
        "status": row.get("status"),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
        "latestVideo": ({
            "exportId": int(row["latest_export_id"]),
            "videoUrl": _value(row, "latest_export_video_url"),
            "durationSeconds": int(row["latest_export_duration_seconds"])
                if row.get("latest_export_duration_seconds") is not None else None,
            "createdAt": _value(row, "latest_export_created_at"),
        } if row.get("latest_export_id") else None),
    }
    if "outline_count" in row:
        result.update({
            "progressPercent": progress,
            "progressStage": stage,
            "progressComplete": progress >= 100,
            "progressDetails": {
                "outlineCount": outline_count,
                "sceneCount": scene_count,
                "storyboardCount": storyboard_count,
                "confirmedImageCount": image_count,
                "confirmedVideoCount": video_count,
                "confirmedAudioCount": audio_count,
                "completedExportCount": completed_export_count,
            },
        })
    return result


def asset_item(row: dict[str, Any], asset_type: str, project_id: int) -> dict[str, Any]:
    item = {
        "id": row["id"],
        "assetType": asset_type,
        "projectId": project_id,
        "sceneId": row.get("scene_id"),
        "sceneNo": row.get("scene_no"),
        "sceneTitle": row.get("scene_title"),
        "storyboardId": row.get("storyboard_id"),
        "shotNo": row.get("shot_no"),
        "characterId": row.get("character_id"),
        "characterName": row.get("character_name"),
        "status": row.get("status"),
        "name": None,
        "subtitle": None,
        "previewUrl": None,
        "videoUrl": None,
        "audioUrl": None,
        "trackType": None,
        "durationSeconds": None,
        "voiceName": None,
        "confirmedAt": None,
        "versionNo": None,
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }
    if asset_type == "character":
        item.update({
            "characterId": row["id"], "name": row.get("name"),
            "subtitle": row.get("role_tag") or "角色资产",
            "previewUrl": row.get("reference_image_url"),
        })
    elif asset_type in {"image", "video"}:
        shot_label = row.get("shot_no") or f"Shot {row.get('storyboard_id')}"
        item.update({
            "sceneId": row.get("scene_id"), "sceneNo": row.get("scene_no"),
            "sceneTitle": row.get("scene_title"), "storyboardId": row.get("storyboard_id"),
            "shotNo": row.get("shot_no"),
            "name": f"Scene {row.get('scene_no')} / {shot_label}",
            "subtitle": ("已确认" if row.get("status") == "confirmed" else "候选") + ("视频" if asset_type == "video" else "静帧"),
            "previewUrl": row.get("thumbnail_url") or row.get("image_url"),
            "versionNo": row.get("version_no"),
        })
        if asset_type == "video": item["videoUrl"] = row.get("video_url")
    else:
        scene_label = f"Scene {int(row.get('scene_no') or 0):02d}" if row.get("scene_no") else "Project"
        title = str(row.get("title") or "").strip()
        if not title:
            track_type = row.get("track_type") or ""
            source = row.get("character_name") or row.get("scene_title") or scene_label
            shot = row.get("shot_no")
            if track_type == "dialogue":
                title = f"对白轨{' · ' + str(shot) if shot else ''} - {source}"
            elif track_type == "narration":
                title = f"旁白轨{' · ' + str(shot) if shot else ''} - {source}"
            elif track_type == "music":
                title = f"音乐轨 - {source}"
            else:
                title = f"音效轨 - {source}"
        item.update({
            "name": title,
            "subtitle": ("已确认音频 / " if row.get("status") == "confirmed" else "候选音频 / ") + (row.get("character_name") or scene_label),
            "audioUrl": row.get("audio_url"), "trackType": row.get("track_type"),
            "durationSeconds": row.get("duration_seconds"), "voiceName": row.get("voice_name"),
            "versionNo": row.get("version_no"),
            "confirmedAt": _value(row, "confirmed_at", "confirmedAt"),
        })
    return item


def _json_object(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def scene_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "projectId": _value(row, "project_id", "projectId"),
        "episodeNo": _value(row, "episode_no", "episodeNo"),
        "outlineId": _value(row, "outline_id", "outlineId"),
        "sceneNo": _value(row, "scene_no", "sceneNo"),
        "title": row.get("title"),
        "summary": row.get("summary"),
        "content": row.get("content"),
        "spatialAnchors": _json_object(_value(row, "spatial_anchors_json", "spatialAnchors")),
        "mood": row.get("mood"),
        "location": row.get("location"),
        "timeOfDay": _value(row, "time_of_day", "timeOfDay"),
        "estimatedDuration": _value(row, "estimated_duration", "estimatedDuration"),
        "sortOrder": _value(row, "sort_order", "sortOrder", default=0),
        "status": row.get("status"),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }


def storyboard_row(row: dict[str, Any]) -> dict[str, Any]:
    performance = _json_object(_value(row, "performance_json", "performance"))
    return {
        "id": row["id"],
        "sceneId": _value(row, "scene_id", "sceneId"),
        "shotNo": _value(row, "shot_no", "shotNo"),
        "shotType": _value(row, "shot_type", "shotType"),
        "cameraAngle": _value(row, "camera_angle", "cameraAngle"),
        "composition": row.get("composition"),
        "durationSeconds": _value(row, "duration_seconds", "durationSeconds"),
        "characterId": _value(row, "character_id", "characterId"),
        "characterName": _value(row, "character_name", "characterName"),
        "actionText": _value(row, "action_text", "actionText"),
        "dialogueText": _value(row, "dialogue_text", "dialogueText"),
        "visualPrompt": _value(row, "visual_prompt", "visualPrompt"),
        "performance": performance,
        "startVisualPrompt": _value(row, "start_visual_prompt", "startVisualPrompt"),
        "endVisualPrompt": _value(row, "end_visual_prompt", "endVisualPrompt"),
        "imageUrl": _value(row, "image_url", "imageUrl"),
        "endImageUrl": _value(row, "end_image_url", "endImageUrl"),
        "videoUrl": _value(row, "video_url", "videoUrl"),
        "sortOrder": _value(row, "sort_order", "sortOrder", default=0),
        "status": row.get("status"),
        "assetReference": _json_object(_value(row, "asset_reference_json", "assetReference")),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }


def generation_job_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "jobKey": row.get("job_key"),
        "projectId": int(_value(row, "project_id", "projectId", default=0) or 0),
        "jobType": row.get("job_type"),
        "sourceId": int(_value(row, "source_id", "sourceId", default=0) or 0),
        "status": row.get("status"),
        "progressPercent": int(_value(row, "progress_percent", "progressPercent", default=0) or 0),
        "result": _json_object(_value(row, "result_json", "result")),
        "errorText": _value(row, "error_text", "errorText"),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }


def audio_asset_row(row: dict[str, Any]) -> dict[str, Any]:
    track_type = _value(row, "track_type", "trackType")
    character_name = _value(row, "character_name", "characterName")
    scene_no = _value(row, "scene_no", "sceneNo")
    scene_label = f"Scene {int(scene_no):02d}" if scene_no else ""
    scene_title = _value(row, "scene_title", "sceneTitle")
    shot_no = _value(row, "shot_no", "storyboard_shot_no", "shotNo")
    title = row.get("title")
    if not title:
        if track_type == "dialogue":
            title = f"对白轨{f' · {shot_no}' if shot_no else ''} - {character_name or scene_title or scene_label or '未命名来源'}"
        elif track_type == "narration":
            title = f"旁白轨 - {scene_title or scene_label or '项目'}"
        elif track_type == "music":
            title = f"音乐轨 - {scene_title or scene_label or '项目'}"
        else:
            title = f"音效轨 - {scene_title or scene_label or '项目'}"
    return {
        "id": int(row["id"]),
        "projectId": _value(row, "project_id", "projectId"),
        "trackType": track_type,
        "sceneId": _value(row, "scene_id", "sceneId"),
        "storyboardId": _value(row, "storyboard_id", "storyboardId"),
        "shotNo": shot_no,
        "sceneNo": scene_no,
        "sceneTitle": _value(row, "scene_title", "sceneTitle"),
        "characterId": _value(row, "character_id", "characterId"),
        "characterName": character_name,
        "versionNo": _value(row, "version_no", "versionNo"),
        "startOffsetSeconds": float(_value(row, "start_offset_seconds", "startOffsetSeconds", default=0) or 0),
        "title": title,
        "audioUrl": _value(row, "audio_url", "audioUrl"),
        "storageKey": _value(row, "storage_key", "storageKey"),
        "durationSeconds": _value(row, "duration_seconds", "durationSeconds"),
        "voiceName": _value(row, "voice_name", "voiceName"),
        "modelName": _value(row, "model_name", "modelName"),
        "voiceProfileKey": _value(row, "voice_profile_key", "voiceProfileKey"),
        "voiceInstructions": _value(row, "voice_instructions", "voiceInstructions"),
        "status": row.get("status"),
        "confirmedAt": _value(row, "confirmed_at", "confirmedAt"),
        "createdAt": _value(row, "created_at", "createdAt"),
    }


def image_asset_row(row: dict[str, Any]) -> dict[str, Any]:
    role = str(_value(row, "frame_role", "frameRole") or "").strip().lower()
    return {
        "id": row["id"],
        "storyboardId": _value(row, "storyboard_id", "storyboardId"),
        "versionNo": _value(row, "version_no", "versionNo"),
        "frameRole": role if role in {"start", "end"} else "primary",
        "imageUrl": _value(row, "image_url", "imageUrl"),
        "thumbnailUrl": _value(row, "thumbnail_url", "thumbnailUrl"),
        "promptSnapshot": _value(row, "prompt_snapshot", "promptSnapshot"),
        "negativePrompt": _value(row, "negative_prompt", "negativePrompt"),
        "characterSnapshot": _json_object(_value(row, "character_snapshot", "characterSnapshot")),
        "modelName": _value(row, "model_name", "modelName"),
        "status": row.get("status"),
        "confirmedAt": _value(row, "confirmed_at", "confirmedAt"),
        "createdAt": _value(row, "created_at", "createdAt"),
    }


def outline_row(row: dict[str, Any]) -> dict[str, Any]:
    raw = _json_object(_value(row, "raw_json", "rawJson")) or {}
    acts = raw.get("acts") if isinstance(raw.get("acts"), list) else []
    scenes = raw.get("scenes") if isinstance(raw.get("scenes"), list) else []
    return {
        "id": row["id"],
        "projectId": _value(row, "project_id", "projectId"),
        "versionNo": _value(row, "version_no", "versionNo"),
        "title": row.get("title"),
        "logline": row.get("logline"),
        "premise": row.get("premise"),
        "act1Text": _value(row, "act1_text", "act1Text"),
        "act2Text": _value(row, "act2_text", "act2Text"),
        "act3Text": _value(row, "act3_text", "act3Text"),
        "visualStyle": _value(row, "visual_style", "visualStyle"),
        "acts": acts,
        "scenes": scenes,
        "createdAt": _value(row, "created_at", "createdAt"),
    }


def story_bible_row(row: dict[str, Any]) -> dict[str, Any]:
    def array_value(key: str) -> list[Any]:
        value = _json_object(_value(row, f"{key}_json", key))
        return value if isinstance(value, list) else []

    return {
        "id": int(row["id"]),
        "projectId": int(_value(row, "project_id", "projectId")),
        "versionNo": int(_value(row, "version_no", "versionNo", default=1) or 1),
        "status": row.get("status") or "draft",
        "title": row.get("title") or "",
        "logline": row.get("logline") or "",
        "audience": row.get("audience") or "",
        "emotionalPromise": _value(row, "emotional_promise", "emotionalPromise") or "",
        "worldRules": array_value("world_rules"),
        "timeline": array_value("timeline"),
        "locations": array_value("locations"),
        "characters": array_value("characters"),
        "relationships": array_value("relationships"),
        "props": array_value("props"),
        "mainPlot": _value(row, "main_plot", "mainPlot") or "",
        "subplots": array_value("subplots"),
        "foreshadowing": array_value("foreshadowing"),
        "lockedFacts": array_value("locked_facts"),
        "flexibleFacts": array_value("flexible_facts"),
        "visualSymbols": array_value("visual_symbols"),
        "qualityReport": _json_object(_value(row, "quality_report_json", "qualityReport")),
        "lockedAt": _value(row, "locked_at", "lockedAt"),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }


def season_structure_row(row: dict[str, Any]) -> dict[str, Any]:
    def array_value(key: str) -> list[Any]:
        value = _json_object(_value(row, f"{key}_json", key))
        return value if isinstance(value, list) else []

    story_bible_id = _value(row, "story_bible_id", "storyBibleId")
    return {
        "id": int(row["id"]),
        "projectId": int(_value(row, "project_id", "projectId")),
        "storyBibleId": int(story_bible_id) if story_bible_id else None,
        "versionNo": int(_value(row, "version_no", "versionNo", default=1) or 1),
        "status": row.get("status") or "draft",
        "seasonTheme": _value(row, "season_theme", "seasonTheme") or "",
        "coreConflict": _value(row, "core_conflict", "coreConflict") or "",
        "structureType": _value(row, "structure_type", "structureType") or "",
        "episodeCount": int(_value(row, "episode_count", "episodeCount", default=1) or 1),
        "episodes": array_value("episodes"),
        "foreshadowingPlan": array_value("foreshadowing_plan"),
        "characterArcs": array_value("character_arcs"),
        "qualityReport": _json_object(_value(row, "quality_report_json", "qualityReport")),
        "lockedAt": _value(row, "locked_at", "lockedAt"),
        "createdAt": _value(row, "created_at", "createdAt"),
        "updatedAt": _value(row, "updated_at", "updatedAt"),
    }
