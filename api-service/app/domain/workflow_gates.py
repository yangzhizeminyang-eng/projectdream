"""Creative workflow readiness rules shared by the native API routes."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


def create_script_fingerprint(scenes: list[dict[str, Any]]) -> str:
    snapshot = [
        {
            "id": _number(scene.get("id")),
            "episodeNo": _number(scene.get("episode_no", scene.get("episodeNo"))) or 1,
            "sceneNo": _number(scene.get("scene_no", scene.get("sceneNo"))),
            "title": _text(scene.get("title")),
            "summary": _text(scene.get("summary")),
            "content": _text(scene.get("content")),
        }
        for scene in scenes
    ]
    snapshot.sort(key=lambda scene: (scene["episodeNo"], scene["sceneNo"], scene["id"]))
    serialized = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def find_scene_node_match(node: dict[str, Any], scenes: list[dict[str, Any]]) -> dict[str, Any] | None:
    if str(node.get("node_type", node.get("nodeType")) or "") != "scene":
        return None
    group_key = _text(node.get("group_key", node.get("groupKey")))
    match = re.match(r"^scene:(\d+)(?::|$)", group_key)
    candidates = scenes
    if match:
        scene = next((item for item in scenes if _number(item.get("id")) == int(match.group(1))), None)
        if scene:
            return scene
    linked_id = _number(node.get("ref_id", node.get("refId")))
    if linked_id > 0:
        scene = next((item for item in scenes if _number(item.get("id")) == linked_id), None)
        if scene:
            return scene
    label = _text(node.get("label"))
    if not label:
        return None
    candidates = [
        scene for scene in scenes
        if _text(scene.get("title"))
        and (_text(scene.get("title")) == label
             or f"{_text(scene.get('title'))} · {_text(scene.get('time_of_day', scene.get('timeOfDay')))}" == label)
    ]
    if len(candidates) == 1:
        return candidates[0]
    number_match = re.search(r"(?:场景|scene)\s*0*(\d+)", label, re.I)
    if not number_match:
        return None
    numbered = [scene for scene in scenes if _number(scene.get("scene_no", scene.get("sceneNo"))) == int(number_match.group(1))]
    return numbered[0] if len(numbered) == 1 else None


def evaluate_creative_workflow_gates(
    *, scenes: list[dict[str, Any]], parsed_fingerprint: str, characters: list[dict[str, Any]],
    asset_nodes: list[dict[str, Any]],
) -> dict[str, Any]:
    active_nodes = [node for node in asset_nodes if node.get("status") != "archived"]
    characters_required = []
    for character in characters:
        matches = [node for node in active_nodes if node.get("node_type") == "character" and _number(node.get("ref_id")) == _number(character.get("id"))]
        if matches:
            characters_required.extend(_asset_state(node) for node in matches)
        else:
            characters_required.append({"exists": False, "state": "missing"})
    scenes_required = []
    for scene in scenes:
        node = next((item for item in active_nodes if find_scene_node_match(item, scenes) and _number(find_scene_node_match(item, scenes).get("id")) == _number(scene.get("id"))), None)
        scenes_required.append(_asset_state(node) if node else {"exists": False, "state": "missing"})
    other_assets = [_asset_state(node) for node in active_nodes if node.get("node_type") in {"prop", "tool", "material"}]
    required = [*characters_required, *scenes_required, *other_assets]
    incomplete = [scene for scene in scenes if not _text(scene.get("content"))]
    script_complete = bool(scenes) and not incomplete
    parse_current = script_complete and bool(parsed_fingerprint) and create_script_fingerprint(scenes) == parsed_fingerprint
    assets_code = "script_incomplete" if not script_complete else "script_parse_required"
    assets_reason = "请先生成并保存全部场景的剧本正文。" if not script_complete else "请先完成当前版本剧本的角色与场景解析。"
    if script_complete and parsed_fingerprint and not parse_current:
        assets_code, assets_reason = "script_parse_stale", "剧本已发生变化，请重新解析后再进入资产管理。"
    missing = sum(asset.get("exists") is False for asset in required)
    pending = sum(asset.get("exists") is not False and asset.get("state") != "confirmed" for asset in required)
    assets_allowed = parse_current
    storyboard_allowed = assets_allowed and bool(required) and not missing and not pending
    storyboard_code = "storyboard_ready" if storyboard_allowed else (
        assets_code if not assets_allowed else "assets_missing" if not required else "assets_unconfirmed"
    )
    storyboard_reason = "" if storyboard_allowed else (
        assets_reason if not assets_allowed else "尚未解析出必需资产，请返回剧本重新解析。" if not required
        else f"还有 {missing + pending} 项必需资产未完成确认。"
    )
    return {
        "script": {"complete": script_complete, "sceneCount": len(scenes), "incompleteCount": len(incomplete)},
        "assets": {"allowed": assets_allowed, "code": "assets_ready" if assets_allowed else assets_code,
                   "reason": "" if assets_allowed else assets_reason, "requiredCount": len(required),
                   "missingCount": missing, "pendingCount": pending},
        "storyboard": {"allowed": storyboard_allowed, "code": storyboard_code, "reason": storyboard_reason,
                       "requiredCount": len(required), "missingCount": missing, "pendingCount": pending},
    }


def _asset_state(node: dict[str, Any]) -> dict[str, Any]:
    return {"exists": True, "state": "confirmed" if _number(node.get("has_confirmed_image")) == 1 else "pending"}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any) -> int:
    try:
        number = float(value)
        return int(number) if number == number and abs(number) != float("inf") else 0
    except (TypeError, ValueError):
        return 0
