"""角色改名计划（Node services/character-rename.mjs + index.mjs buildCharacterRenamePlan /
applyCharacterRenamePlan 的 Python 复刻）。

改名影响预览（rename-preview）与 PUT 更新时的项目文本同步共用同一套计划；
文本替换一次性完成（避免新名被连锁替换），结构化 JSON 只改字符串值不改键。
"""

from __future__ import annotations

import json
import re
from typing import Any


def normalize_source_names(source_names: Any, new_name: str) -> list[str]:
    """Node normalizeSourceNames：历史称呼去重过滤并按长度降序（长名优先替换）。"""
    values = source_names if isinstance(source_names, list) else [source_names]
    unique: list[str] = []
    for value in values:
        name = str(value or "").strip()
        if name and name != new_name and name not in unique:
            unique.append(name)
    return sorted(unique, key=len, reverse=True)


def _escape_regexp(value: str) -> str:
    """JS escapeRegExp 等价。"""
    return re.sub(r"[.*+?^${}()|[\]\\]", r"\\\g<0>", value)


def transform_character_names(value: Any, source_names: Any, new_name: str) -> dict[str, Any]:
    """Node transformCharacterNames：可编辑文本中的历史称呼一次性替换。

    :param value: 任意结构（str/list/dict/其他原样返回）。
    :param source_names: 历史称呼列表。
    :param new_name: 新角色名。
    :returns: ``{"value", "occurrences", "changed"}``。
    """
    normalized_names = normalize_source_names(source_names, new_name)
    if not normalized_names:
        return {"value": value, "occurrences": 0, "changed": False}

    if isinstance(value, str):
        pattern = re.compile("|".join(_escape_regexp(name) for name in normalized_names))
        occurrences = len(pattern.findall(value))
        return {
            "value": pattern.sub(new_name, value) if occurrences else value,
            "occurrences": occurrences,
            "changed": occurrences > 0,
        }

    if isinstance(value, list):
        occurrences = 0
        changed = False
        next_value = []
        for item in value:
            transformed = transform_character_names(item, normalized_names, new_name)
            occurrences += transformed["occurrences"]
            changed = changed or transformed["changed"]
            next_value.append(transformed["value"])
        return {"value": next_value if changed else value, "occurrences": occurrences, "changed": changed}

    if isinstance(value, dict):
        occurrences = 0
        changed = False
        next_value: dict[str, Any] = {}
        for key, item in value.items():
            transformed = transform_character_names(item, normalized_names, new_name)
            occurrences += transformed["occurrences"]
            changed = changed or transformed["changed"]
            next_value[key] = transformed["value"]
        return {"value": next_value if changed else value, "occurrences": occurrences, "changed": changed}

    return {"value": value, "occurrences": 0, "changed": False}


def transform_character_names_json(raw_json: Any, source_names: Any, new_name: str) -> dict[str, Any]:
    """Node transformCharacterNamesJson：结构化 JSON 改名（仅字符串值，不改键）。

    :returns: ``{"value", "occurrences", "changed", "valid"}``；非法 JSON 时 valid=False。
    """
    if not str(raw_json or "").strip():
        return {"value": raw_json, "occurrences": 0, "changed": False, "valid": True}
    try:
        parsed = json.loads(str(raw_json))
    except (TypeError, ValueError):
        return {"value": raw_json, "occurrences": 0, "changed": False, "valid": False}
    transformed = transform_character_names(parsed, source_names, new_name)
    return {
        # Node JSON.stringify 为紧凑格式（无空格），保持逐字节一致。
        "value": json.dumps(transformed["value"], ensure_ascii=False, separators=(",", ":"))
        if transformed["changed"]
        else raw_json,
        "occurrences": transformed["occurrences"],
        "changed": transformed["changed"],
        "valid": True,
    }


def extract_related_speaker_names(text_values: Any, current_name: Any, reserved_names: Any = None) -> list[str]:
    """Node extractRelatedSpeakerNames：从文本提取可能的历史称呼/说话人标签。

    :param text_values: 文本值列表。
    :param current_name: 当前角色名（≥2 字符才启用）。
    :param reserved_names: 其他角色名（保留，不作为别名）。
    :returns: 别名列表（保序去重）。
    """
    canonical_name = str(current_name or "").strip()
    if len(canonical_name) < 2:
        return []
    reserved = {str(name or "").strip() for name in (reserved_names or [])}
    aliases: list[str] = []
    speaker_pattern = re.compile(r"^[ \t]*([\w·_-]{2,30})[：:]", re.UNICODE | re.MULTILINE)
    for value in text_values or []:
        text_value = str(value or "")
        for match in speaker_pattern.finditer(text_value):
            candidate = str(match.group(1) or "").strip()
            if candidate != canonical_name and candidate not in reserved and (
                canonical_name in candidate or candidate in canonical_name
            ):
                if candidate not in aliases:
                    aliases.append(candidate)
    return aliases


def _build_rename_record(
    row: dict[str, Any],
    fields: list[str],
    source_names: list[str],
    new_name: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Node buildRenameRecord：单行改名记录（字段变换 + 出现次数统计）。"""
    options = options or {}
    values: dict[str, Any] = {}
    occurrences = 0
    changed = False
    invalid_structured_field = False
    for field in fields:
        if field in (options.get("jsonFields") or set()):
            transformed = transform_character_names_json(row.get(field), source_names, new_name)
        else:
            transformed = transform_character_names(row.get(field), source_names, new_name)
        values[field] = transformed["value"]
        occurrences += transformed["occurrences"]
        changed = changed or transformed["changed"]
        if "valid" in transformed and not transformed["valid"]:
            invalid_structured_field = True

    if options.get("forceValues"):
        for field, value in options["forceValues"].items():
            current_value = values[field] if field in values else row.get(field)
            if current_value != value:
                changed = True
            values[field] = value

    return {
        "id": int(row.get("id") or 0),
        "values": values,
        "occurrences": occurrences,
        "changed": changed,
        "invalidStructuredField": invalid_structured_field,
        "bindCharacterId": bool(options.get("bindCharacterId")),
        "characterId": None if options.get("characterId") is None else int(options.get("characterId") or 0) or None,
    }


def _summarize_rename_records(records: list[dict[str, Any]]) -> dict[str, int]:
    """Node summarizeRenameRecords：变更行数与出现次数汇总。"""
    changed_records = [record for record in records if record["changed"]]
    return {
        "records": len(changed_records),
        "occurrences": sum(record["occurrences"] for record in changed_records),
    }


def build_character_rename_plan(
    character: dict[str, Any],
    new_name: str,
    *,
    project_rows: list[dict[str, Any]],
    outline_rows: list[dict[str, Any]],
    scene_rows: list[dict[str, Any]],
    storyboard_rows: list[dict[str, Any]],
    project_character_rows: list[dict[str, Any]],
    media_counts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Node buildCharacterRenamePlan：改名影响计划（纯函数部分）。

    :param character: 角色行（含 project_id / id / name）。
    :param new_name: 新角色名。
    :param project_rows: 项目行（narrative_vision）。
    :param outline_rows: 最新总纲行。
    :param scene_rows: 场景行。
    :param storyboard_rows: 分镜行（join 场景过滤后）。
    :param project_character_rows: 项目全部角色（id/name）。
    :param media_counts: 历史媒体计数行（character_images/audio_assets/image_assets/video_assets）。
    :returns: ``{"oldName", "newName", "sourceNames", "projectId", "records", "impact"}``。
    """
    old_name = str(character.get("name") or "").strip()
    project_id = int(character.get("project_id") or 0)
    related_speaker_names = extract_related_speaker_names(
        [value for row in scene_rows for value in (row.get("title"), row.get("summary"), row.get("content"))],
        old_name,
        [row.get("name") for row in project_character_rows if int(row.get("id") or 0) != int(character.get("id") or 0)],
    )
    source_names = list(
        dict.fromkeys(
            [
                old_name,
                *[
                    str(row.get("character_name") or "").strip()
                    for row in storyboard_rows
                    if int(row.get("character_id") or 0) == int(character.get("id") or 0)
                ],
                *related_speaker_names,
            ]
        )
    )
    source_names = [name for name in source_names if name and name != new_name]

    media = media_counts or {}

    project_records = [_build_rename_record(row, ["narrative_vision"], source_names, new_name) for row in project_rows]
    outline_records = [
        _build_rename_record(
            row,
            ["title", "logline", "premise", "act1_text", "act2_text", "act3_text", "raw_json"],
            source_names,
            new_name,
            {"jsonFields": {"raw_json"}},
        )
        for row in outline_rows
    ]
    scene_records = [_build_rename_record(row, ["title", "summary", "content"], source_names, new_name) for row in scene_rows]
    storyboard_records = []
    for row in storyboard_rows:
        is_bound_character = int(row.get("character_id") or 0) == int(character.get("id") or 0)
        is_legacy_name_match = not row.get("character_id") and str(row.get("character_name") or "").strip() in source_names
        record = _build_rename_record(
            row,
            ["action_text", "dialogue_text", "visual_prompt"],
            source_names,
            new_name,
            {
                "forceValues": {
                    "character_name": new_name if (is_bound_character or is_legacy_name_match) else row.get("character_name"),
                },
                "bindCharacterId": is_legacy_name_match,
                "characterId": row.get("character_id"),
            },
        )
        if is_bound_character or is_legacy_name_match:
            name_transform = transform_character_names(row.get("character_name"), source_names, new_name)
            if name_transform["occurrences"] > 0:
                record["occurrences"] += 1
        storyboard_records.append(record)

    sections = {
        "project": _summarize_rename_records(project_records),
        "outline": _summarize_rename_records(outline_records),
        "scenes": _summarize_rename_records(scene_records),
        "storyboards": _summarize_rename_records(storyboard_records),
    }
    section_values = list(sections.values())
    return {
        "oldName": old_name,
        "newName": new_name,
        "sourceNames": source_names,
        "projectId": project_id,
        "records": {
            "project": [record for record in project_records if record["changed"]],
            "outline": [record for record in outline_records if record["changed"]],
            "scenes": [record for record in scene_records if record["changed"]],
            "storyboards": [record for record in storyboard_records if record["changed"]],
        },
        "impact": {
            "characterId": int(character.get("id") or 0),
            "oldName": old_name,
            "newName": new_name,
            "sourceNames": source_names,
            "totalRecords": sum(section["records"] for section in section_values),
            "totalOccurrences": sum(section["occurrences"] for section in section_values),
            "sections": sections,
            "historicalMedia": {
                "characterImages": int(media.get("character_images") or 0),
                "imageAssets": int(media.get("image_assets") or 0),
                "videoAssets": int(media.get("video_assets") or 0),
                "audioAssets": int(media.get("audio_assets") or 0),
            },
            "warnings": {
                "invalidOutlineJson": any(record["invalidStructuredField"] for record in outline_records),
            },
        },
    }


def apply_character_rename_plan(connection: Any, plan: dict[str, Any], character_id: int) -> None:
    """Node applyCharacterRenamePlan：事务内回写项目文本（project/outline/scene/storyboard）。

    :param connection: 事务连接（execute(sql, params)）。
    :param plan: build_character_rename_plan 的计划。
    :param character_id: 改名角色 id（legacy 未绑行绑定为该角色）。
    :return: None。
    """
    for record in plan["records"]["project"]:
        connection.execute(
            "UPDATE projects SET narrative_vision = %s, updated_at = NOW() WHERE id = %s",
            (record["values"]["narrative_vision"], record["id"]),
        )
    for record in plan["records"]["outline"]:
        values = record["values"]
        connection.execute(
            """
            UPDATE story_outlines
            SET title = %s, logline = %s, premise = %s, act1_text = %s, act2_text = %s, act3_text = %s, raw_json = %s
            WHERE id = %s
            """,
            (
                values["title"],
                values["logline"],
                values["premise"],
                values["act1_text"],
                values["act2_text"],
                values["act3_text"],
                values["raw_json"],
                record["id"],
            ),
        )
    for record in plan["records"]["scenes"]:
        values = record["values"]
        connection.execute(
            "UPDATE script_scenes SET title = %s, summary = %s, content = %s, updated_at = NOW() WHERE id = %s",
            (values["title"], values["summary"], values["content"], record["id"]),
        )
    for record in plan["records"]["storyboards"]:
        values = record["values"]
        connection.execute(
            """
            UPDATE storyboards
            SET character_id = %s, character_name = %s, action_text = %s, dialogue_text = %s,
                visual_prompt = %s, updated_at = NOW()
            WHERE id = %s
            """,
            (
                character_id if record["bindCharacterId"] else record["characterId"],
                values["character_name"],
                values["action_text"],
                values["dialogue_text"],
                values["visual_prompt"],
                record["id"],
            ),
        )
