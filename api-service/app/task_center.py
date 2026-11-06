from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit, urlunsplit


def _value(row: dict[str, Any], key: str, fallback: Any = None) -> Any:
    return row.get(key, fallback)


def _time_key(item: dict[str, Any]) -> tuple[float, int]:
    value = item.get("updatedAt") or item.get("createdAt")
    if isinstance(value, datetime):
        stamp = value.timestamp()
    elif value:
        try:
            stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OSError):
            stamp = 0
    else:
        stamp = 0
    return stamp, int(item.get("sourceId") or 0)


def _duration(value: Any) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0
    return f"{number:g}s" if number > 0 else "时长未设置"


def _media_url(value: Any, public_base_url: str) -> Any:
    raw = str(value or "").strip()
    base = str(public_base_url or "").strip().rstrip("/")
    if not raw or not base:
        return raw or None
    try:
        parsed = urlsplit(raw)
        configured = urlsplit(base)
    except ValueError:
        return raw
    if not re.match(r"^/generated/(video|audio|frame|export)/", parsed.path, re.IGNORECASE):
        return raw
    if not configured.scheme or not configured.netloc:
        return raw
    return urlunsplit((configured.scheme, configured.netloc, parsed.path, parsed.query, parsed.fragment))


def _audio_title(row: dict[str, Any]) -> str:
    title = str(row.get("title") or "").strip()
    if title and "???" not in title:
        return title
    track = row.get("track_type") or "audio"
    scene_no = row.get("scene_no")
    scene = f"Scene {int(scene_no):02d}" if scene_no else ""
    shot = str(row.get("shot_no") or "").strip()
    character = str(row.get("character_name") or "").strip()
    scene_title = str(row.get("scene_title") or "").strip()
    if track == "dialogue":
        return f"对白轨{' · ' + shot if shot else ''} - {character or scene_title or scene or '未命名来源'}"
    if track == "narration":
        return f"旁白轨{' · ' + shot if shot else ''} - {scene_title or scene or '项目'}"
    if track == "music":
        return f"音乐轨 - {scene_title or scene or '项目'}"
    return f"音效轨 - {scene_title or scene or '项目'}"


def _generation_item(row: dict[str, Any], project_id: int, public_base_url: str) -> dict[str, Any]:
    job_type = str(row.get("job_type") or "")
    status = str(row.get("status") or "queued")
    is_character = job_type == "character_image"
    is_node_asset = job_type == "asset_node_image"
    is_lip_sync = job_type == "lip_sync"
    is_video = job_type in {"lip_sync", "video_image"}
    result = row.get("result_json")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            result = None
    first = (result or {}).get("item") if is_lip_sync else next(iter((result or {}).get("items") or []), None)
    scene_no = row.get("scene_no") or 0
    shot_no = row.get("shot_no") or "SHOT"
    if is_character:
        title = f"{row.get('character_name') or '角色'} 定妆图生成"
        detail = "角色定妆图生成任务"
    elif is_node_asset:
        title = f"{row.get('asset_node_label') or '资产节点'} 形象生成"
        detail = f"资产画布{'角色形象' if row.get('asset_node_type') == 'character' else '节点图片'}生成任务"
    elif is_lip_sync:
        title, detail = f"Scene {int(scene_no):02d} / {shot_no} 对白口型同步", "中文对白驱动口型视频"
    elif job_type == "video_image":
        title, detail = f"Scene {int(scene_no):02d} / {shot_no} 视频生成", "分镜动作视频生成并持久化任务"
    else:
        title, detail = f"Scene {int(scene_no):02d} / {shot_no} 静帧生成", "分镜静帧生成任务"
    if status == "queued":
        message = "生成任务正在排队"
    elif status == "running":
        message = "正在同步中文对白与人物口型" if is_lip_sync else "正在生成并下载动作视频" if job_type == "video_image" else "正在调用图片生成模型"
    elif status == "success":
        message = "口型视频已生成并保存到本地" if is_lip_sync else "动作视频已生成并保存到本地" if job_type == "video_image" else "图片候选已生成"
    else:
        message = "口型同步失败" if is_lip_sync else "动作视频生成失败" if job_type == "video_image" else "图片生成失败"
    media = (first or {}).get("videoUrl") or (first or {}).get("imageUrl")
    return {
        "taskKey": f"generation-{row['id']}", "taskType": "video" if is_video else "image",
        "sourceId": int(row["id"]), "projectId": project_id,
        "sceneId": row.get("scene_id"), "sceneNo": row.get("scene_no"), "sceneTitle": row.get("scene_title"),
        "storyboardId": None if is_character or is_node_asset else int(row["source_id"]),
        "characterId": int(row["source_id"]) if is_character else None,
        "shotNo": row.get("shot_no"), "versionNo": None, "title": title,
        "subtitle": "生成完成" if status == "success" else "生成失败" if status == "failed" else "后台处理中",
        "status": "completed" if status == "success" else status,
        "previewUrl": _media_url((first or {}).get("thumbnailUrl") or (first or {}).get("imageUrl"), public_base_url),
        "fileUrl": _media_url(media, public_base_url),
        "detailText": detail, "runtimeStatus": status,
        "progressPercent": int(row.get("progress_percent") or 0), "runtimeMessage": message,
        "errorText": row.get("error_text"), "canRetry": status in {"failed", "canceled"},
        "canCancel": False, "confirmedAt": None, "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at") or row.get("created_at"),
    }


def _asset_item(row: dict[str, Any], project_id: int, task_type: str) -> dict[str, Any]:
    source_id = int(row["id"])
    scene_no = row.get("scene_no") or 0
    shot = row.get("shot_no") or "SHOT"
    status = row.get("status") or "candidate"
    version = row.get("version_no") or 1
    if task_type == "image":
        title = f"Scene {int(scene_no):02d} / {shot} 静帧 V{version}"
        subtitle = "已确认静帧" if status == "confirmed" else "候选静帧"
        preview = row.get("thumbnail_url") or row.get("image_url")
        file_url = row.get("image_url")
        detail = f"模型：{row['model_name']}{' / 已保存提示词快照' if row.get('prompt_snapshot') else ''}" if row.get("model_name") else "已保存提示词快照" if row.get("prompt_snapshot") else "静帧生成记录"
        confirmed = row.get("confirmed_at")
    elif task_type == "video":
        title = f"Scene {int(scene_no):02d} / {shot} 视频 V{version}"
        subtitle = "已确认视频" if status == "confirmed" else "候选视频"
        preview, file_url = row.get("thumbnail_url"), row.get("video_url")
        detail = f"{row.get('motion_mode') or '未指定运动模式'} / {_duration(row.get('duration_seconds'))}"
        if row.get("model_name"):
            detail += f" / 模型：{row['model_name']}"
        confirmed = row.get("confirmed_at")
    elif task_type == "audio":
        scene = f"Scene {int(scene_no):02d}" if scene_no else "项目级"
        title = f"{_audio_title(row)} V{version}"
        subtitle = "已确认音轨" if status == "confirmed" else "已归档音轨" if status == "archived" else "候选音轨"
        preview, file_url = None, row.get("audio_url")
        detail = f"{scene} / {row.get('track_type') or 'audio'}"
        if str(row.get("voice_name") or "").strip():
            detail += f" / {str(row['voice_name']).strip()}"
        if str(row.get("character_name") or "").strip():
            detail += f" / 角色：{str(row['character_name']).strip()}"
        detail += f" / {_duration(row.get('duration_seconds'))}"
        if row.get("model_name"):
            detail += f" / 模型：{row['model_name']}"
        confirmed = row.get("confirmed_at")
    else:
        title = f"导出任务 #{source_id}"
        subtitle = "导出完成" if status == "completed" else status or "导出记录"
        preview, file_url = row.get("cover_url"), row.get("video_url")
        detail = f"就绪分镜 {row.get('ready_count') or 0}/{row.get('source_count') or 0} / 缺失 {row.get('missing_count') or 0}"
        if row.get("duration_seconds"):
            detail += f" / 成片 {row['duration_seconds']}s"
        confirmed = None
    item = {
        "taskKey": f"{task_type}-{source_id}", "taskType": task_type, "sourceId": source_id,
        "projectId": project_id, "sceneId": row.get("scene_id"), "sceneNo": row.get("scene_no"),
        "sceneTitle": row.get("scene_title"), "storyboardId": row.get("storyboard_id"),
        "shotNo": row.get("shot_no"), "versionNo": row.get("version_no"), "title": title,
        "subtitle": subtitle, "status": status, "previewUrl": preview, "fileUrl": file_url,
        "detailText": detail, "confirmedAt": confirmed, "createdAt": row.get("created_at"),
        "updatedAt": confirmed or row.get("created_at"),
    }
    runtime = row.get("runtime") or {}
    runtime_status = runtime.get("runtime_status")
    if status == "archived":
        runtime_status, progress, message, error = "canceled", 100, "该任务候选已归档，可在需要时重新发起。", None
    elif runtime_status in {"queued", "running", "failed", "canceled", "success"}:
        progress = max(0, min(100, round(float(runtime.get("progress_percent") or 0))))
        message = runtime.get("runtime_message") or {"queued": "任务已进入队列，等待开始执行。", "running": "任务执行中。", "failed": "任务执行失败，可以查看原因后重试。", "canceled": "任务已取消，当前保留原有结果记录。", "success": "任务已完成。"}[runtime_status]
        error = runtime.get("error_text")
    elif not file_url:
        runtime_status, progress, message, error = "failed", 100, "任务结果不可用，请检查来源模块后重试。", "当前记录缺少可用输出文件。"
    else:
        runtime_status, progress, message, error = "success", 100, "任务已完成，当前结果已被确认为主版本。" if status == "confirmed" else "任务已完成，当前保留的是候选结果。", None
    item.update({
        "runtimeStatus": runtime_status, "progressPercent": progress, "runtimeMessage": message,
        "errorText": error, "canRetry": runtime_status not in {"queued", "running"},
        "canCancel": runtime_status in {"queued", "running"},
        "updatedAt": runtime.get("updated_at") or item["updatedAt"],
    })
    return item


def build_project_tasks(project_id: int, rows: dict[str, Any], public_base_url: str = "") -> dict[str, Any]:
    items = [_generation_item(row, project_id, public_base_url) for row in rows.get("generation_jobs", [])]
    for task_type, key in (("image", "images"), ("video", "videos"), ("audio", "audios"), ("export", "exports")):
        for row in rows.get(key, []):
            items.append(_asset_item(row, project_id, task_type))
    items.sort(key=_time_key, reverse=True)
    summary = {key: 0 for key in (
        "totalCount", "imageCount", "videoCount", "audioCount", "exportCount", "confirmedCount",
        "candidateCount", "completedCount", "queuedCount", "runningCount", "successCount", "failedCount", "canceledCount",
    )}
    summary["totalCount"] = len(items)
    for item in items:
        summary[f"{item['taskType']}Count"] += 1
        if item["status"] in {"confirmed", "candidate", "completed"}:
            summary[f"{item['status']}Count"] += 1
        if item.get("runtimeStatus") in {"queued", "running", "success", "failed", "canceled"}:
            summary[f"{item['runtimeStatus']}Count"] += 1
    return {"projectId": project_id, "summary": summary, "items": items}
