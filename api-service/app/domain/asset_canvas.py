"""资产画布视图与门禁纯函数（Node services/asset-canvas.mjs、asset-view-contract.mjs、
asset-grouping.mjs、asset-pack-lifecycle.mjs、asset-parser-sync.mjs、asset-node-relink.mjs、
scene-nine-grid.mjs、asset-character-workflow.mjs 的 Python 复刻）。

画布节点是「形象变体」层，与角色身份层（characters / character_images）严格分开；
本模块只做纯计算，不碰数据库。
"""

from __future__ import annotations

import json
import re
from typing import Any

from .asset_prompts import normalize_scene_space_manifest

ASSET_NODE_TYPES = ["character", "scene", "prop", "material"]
ASSET_NODE_DEFAULT_WIDTH = 220
ASSET_NODE_DEFAULT_HEIGHT = 260
ASSET_NODE_MIN_SIDE = 160
ASSET_NODE_MAX_SIDE = 640
ASSET_NODE_COORDINATE_LIMIT = 100000
ASSET_CANVAS_LAYOUT_GAP_X = 72
ASSET_CANVAS_LAYOUT_GAP_Y = 56
ASSET_CANVAS_LAYOUT_MARGIN = 48
ASSET_CANVAS_GROUP_PADDING = 26
ASSET_CANVAS_GROUP_HEADER_HEIGHT = 88

_TYPE_LABELS = {"character": "角色", "scene": "场景", "prop": "道具", "material": "素材"}

# asset-view-contract.mjs 视角表
CHARACTER_VIEW_ANGLES = [
    {"key": "front", "label": "正面", "index": 1, "prompt": "正面全身"},
    {"key": "side", "label": "严格侧面", "index": 2, "prompt": "严格左侧面全身"},
    {"key": "back", "label": "背面", "index": 3, "prompt": "背面全身"},
]
CHARACTER_FACE_CLOSEUP_ANGLES = [
    {"key": "face", "label": "脸部特写", "index": 1, "prompt": "正面脸部特写"},
]
SCENE_VIEW_ANGLES = [
    {"key": "front-left", "label": "左前", "index": 1},
    {"key": "front", "label": "正前", "index": 2},
    {"key": "front-right", "label": "右前", "index": 3},
    {"key": "left", "label": "左侧", "index": 4},
    {"key": "center", "label": "正中", "index": 5},
    {"key": "right", "label": "右侧", "index": 6},
    {"key": "back-left", "label": "左后", "index": 7},
    {"key": "back", "label": "正后", "index": 8},
    {"key": "back-right", "label": "右后", "index": 9},
]
PROP_VIEW_ANGLES = [
    {"key": "front", "label": "正面", "index": 1},
    {"key": "side", "label": "侧面", "index": 2},
    {"key": "back", "label": "背面", "index": 3},
    {"key": "top", "label": "俯视", "index": 4},
]

# scene-nine-grid.mjs 九机位（含相机参数）
SCENE_GRID_ANGLES = [
    {"key": "front-left", "label": "左前", "yaw": -45, "pitch": -4, "fov": 76, "index": 1},
    {"key": "front", "label": "正前", "yaw": 0, "pitch": 0, "fov": 70, "index": 2},
    {"key": "front-right", "label": "右前", "yaw": 45, "pitch": -4, "fov": 76, "index": 3},
    {"key": "left", "label": "左侧", "yaw": -90, "pitch": 0, "fov": 66, "index": 4},
    {"key": "center", "label": "正中", "yaw": 90, "pitch": 0, "fov": 62, "index": 5},
    {"key": "right", "label": "右侧", "yaw": 110, "pitch": 0, "fov": 66, "index": 6},
    {"key": "back-left", "label": "左后", "yaw": 145, "pitch": 4, "fov": 76, "index": 7},
    {"key": "back", "label": "正后", "yaw": 180, "pitch": 0, "fov": 70, "index": 8},
    {"key": "back-right", "label": "右后", "yaw": 215, "pitch": 4, "fov": 76, "index": 9},
]

# asset-character-workflow.mjs：确认门禁共用判定
_PACK_LEGACY_LABEL_RE = re.compile(r"完整角色资产板|角色资产板|character\s+asset\s+board", re.I)


def _text(value: Any) -> str:
    """Node text() 等价：``String(value ?? '').trim()``。"""
    if value is None:
        return ""
    return str(value).strip()


def _safe_int(value: Any) -> int:
    """Node Number(value) 取整：非法/NaN/Infinity → 0。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return 0
    return int(parsed)


def _positive_int(value: Any) -> int | None:
    """Node positiveInt：正整数返回值，否则 None。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return int(parsed) if float(parsed).is_integer() and parsed > 0 else None


def parse_crop(value: Any) -> dict[str, Any] | None:
    """Node parseCrop：crop/identity JSON → dict（失败 None）。"""
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return None
    return dict(parsed) if isinstance(parsed, dict) else None


def normalize_asset_node_type(value: Any) -> str | None:
    """Node normalizeAssetNodeType：未知类型一律 None（由路由报 400，不静默归类）。"""
    normalized = _text(value).lower()
    return normalized if normalized in ASSET_NODE_TYPES else None


def _normalize_side(value: Any, fallback: int) -> int:
    """Node normalizeSide：非数字/非正数回落默认，正数越界钳制。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = None
    if parsed is None or parsed != parsed or parsed in (float("inf"), float("-inf")) or parsed <= 0:
        return fallback
    return min(ASSET_NODE_MAX_SIDE, max(ASSET_NODE_MIN_SIDE, round(parsed)))


def _normalize_coordinate(value: Any) -> float:
    """Node normalizeCoordinate：非法归 0，合法钳制到 ±100000 并保留两位小数。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return 0
    clamped = min(ASSET_NODE_COORDINATE_LIMIT, max(-ASSET_NODE_COORDINATE_LIMIT, parsed))
    return round(clamped, 2)


def normalize_asset_node_layout(node: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node normalizeAssetNodeLayout：画布坐标与尺寸归一化。"""
    node = node or {}
    return {
        "x": _normalize_coordinate(node.get("x")),
        "y": _normalize_coordinate(node.get("y")),
        "width": _normalize_side(node.get("width"), ASSET_NODE_DEFAULT_WIDTH),
        "height": _normalize_side(node.get("height"), ASSET_NODE_DEFAULT_HEIGHT),
    }


def asset_node_image_row(row: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node assetNodeImageRow：asset_node_images 行 → 前端形象 DTO。

    :param row: 数据库行（snake_case 优先，兼容 camelCase）。
    :returns: 形象 DTO（view/crop/identity/vision 全字段）。
    """
    row = row or {}
    image_url = _text(row.get("image_url", row.get("imageUrl")))
    thumbnail_url = _text(row.get("thumbnail_url", row.get("thumbnailUrl"))) or image_url
    view_index = row.get("view_index", row.get("viewIndex"))
    source_image_id = row.get("source_image_id", row.get("sourceImageId"))
    try:
        view_index_value = int(float(view_index)) if view_index is not None and str(view_index).strip() else 0
    except (TypeError, ValueError):
        view_index_value = 0
    return {
        "id": _safe_int(row.get("id")),
        "assetNodeId": _safe_int(row.get("asset_node_id", row.get("assetNodeId"))),
        "versionNo": _safe_int(row.get("version_no", row.get("versionNo")) or 1) or 1,
        "imageUrl": image_url,
        "storageKey": _text(row.get("storage_key", row.get("storageKey"))) or None,
        "thumbnailUrl": thumbnail_url,
        "promptSnapshot": _text(row.get("prompt_snapshot", row.get("promptSnapshot"))),
        "modelName": _text(row.get("model_name", row.get("modelName"))) or None,
        "viewSetType": _text(row.get("view_set_type", row.get("viewSetType"))) or "single",
        "viewSetVersion": _safe_int(row.get("view_set_version", row.get("viewSetVersion")) or 1) or 1,
        "viewIndex": view_index_value or None,
        "viewKey": _text(row.get("view_key", row.get("viewKey"))) or None,
        "viewLabel": _text(row.get("view_label", row.get("viewLabel"))) or None,
        "sourceImageId": (_safe_int(source_image_id) or None) if source_image_id is not None else None,
        "sourceImageUrl": _text(row.get("source_image_url", row.get("sourceImageUrl"))) or None,
        "crop": parse_crop(row.get("crop_json", row.get("crop"))),
        "characterIdentityLock": parse_crop(row.get("character_identity_lock_json", row.get("characterIdentityLock"))),
        "identityStatus": _text(row.get("identity_status", row.get("identityStatus"))) or "not_checked",
        "identityReason": _text(row.get("identity_reason", row.get("identityReason"))) or None,
        "identitySimilarityScore": _finite_number_or_none(row.get("identity_similarity_score", row.get("identitySimilarityScore"))),
        "wardrobeConsistencyScore": _finite_number_or_none(row.get("wardrobe_consistency_score", row.get("wardrobeConsistencyScore"))),
        "visionStatus": _text(row.get("vision_status", row.get("visionStatus"))) or "pending",
        "visionReason": _text(row.get("vision_reason", row.get("visionReason"))) or None,
        "visionCheckedAt": row.get("vision_checked_at", row.get("visionCheckedAt")),
        "status": _text(row.get("status")) or "candidate",
        "confirmedAt": row.get("confirmed_at", row.get("confirmedAt")),
        "createdAt": row.get("created_at", row.get("createdAt")),
    }


def _finite_number_or_none(value: Any) -> float | None:
    """Node finiteNumberOrNull：有限数值返回原值，否则 None。"""
    if isinstance(value, (int, float)):
        parsed = float(value)
        return value if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None
    raw = _text(value)
    if not raw:
        return None
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    # Node Number('3.0') → 3；保持数值类型原样返回
    if isinstance(value, str) and raw.strip() == raw:
        parsed_value = float(raw)
        if parsed_value.is_integer() and "." not in raw and "e" not in raw.lower():
            return int(parsed_value)
        return parsed_value
    return parsed


def _is_usable_asset_image(image: dict[str, Any], node_type: Any = "") -> bool:
    """Node isUsableAssetImage：派生节点状态时的可用图判定。"""
    image_url = _text(image.get("imageUrl", image.get("image_url")))
    model_name = _text(image.get("modelName", image.get("model_name"))).lower()
    status = _text(image.get("status")).lower()
    vision_status = _text(image.get("visionStatus", image.get("vision_status"))).lower()
    if not image_url or "/mock-assets/" in image_url or model_name.startswith("mock-"):
        return False
    if status in ("superseded", "failed"):
        return False
    if vision_status and vision_status != "passed" and not (node_type == "scene" and vision_status == "skipped"):
        return False
    return True


def derive_asset_node_state(images: list[dict[str, Any]] | None, node_type: Any = "") -> str:
    """Node deriveAssetNodeState：从真实图片派生节点状态（不读 DB status 列）。"""
    node_type = _text(node_type)
    image_list = images or []
    if any(_text(image.get("status")) == "confirmed" and _is_usable_asset_image(image, node_type) for image in image_list):
        return "confirmed"
    if any(
        _text(image.get("status")).lower() not in ("superseded", "failed")
        and _text(image.get("visionStatus", image.get("vision_status"))).lower() != "failed"
        for image in image_list
    ):
        return "ready"
    return "draft"


def _normalize_node(row: dict[str, Any]) -> dict[str, Any]:
    """Node normalizeNode：asset_nodes 行 → 视图节点基座。"""
    row = row or {}
    ref_id = row.get("ref_id")
    if ref_id is None:
        ref_id = row.get("refId")
    return {
        "id": _safe_int(row.get("id")),
        "projectId": _safe_int(row.get("project_id", row.get("projectId"))),
        "nodeType": normalize_asset_node_type(row.get("node_type", row.get("nodeType"))),
        "refId": None if ref_id is None else _safe_int(ref_id),
        "label": _text(row.get("label")),
        "appearanceLabel": _text(row.get("appearance_label", row.get("appearanceLabel"))) or None,
        "promptText": _text(row.get("prompt_text", row.get("promptText"))),
        "turnaroundPromptText": _text(row.get("turnaround_prompt_text", row.get("turnaroundPromptText"))),
        "environmentPromptText": _text(row.get("environment_prompt_text", row.get("environmentPromptText"))),
        "negativePrompt": _text(row.get("negative_prompt", row.get("negativePrompt"))),
        "x": float(row.get("x") or 0),
        "y": float(row.get("y") or 0),
        "width": float(row.get("width") or ASSET_NODE_DEFAULT_WIDTH),
        "height": float(row.get("height") or ASSET_NODE_DEFAULT_HEIGHT),
        "groupKey": _text(row.get("group_key", row.get("groupKey"))) or None,
        "characterIdentityLock": parse_crop(row.get("character_identity_lock_json", row.get("characterIdentityLock"))),
        "lifecycleStatus": _text(row.get("status")) or "active",
    }


def summarize_asset_canvas(nodes: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Node summarizeAssetCanvas：按类型计数 + pending/ready/confirmed 汇总。"""
    by_type = {"character": 0, "scene": 0, "prop": 0, "material": 0}
    pending_count = 0
    ready_count = 0
    confirmed_count = 0
    for node in nodes or []:
        node_type = normalize_asset_node_type(node.get("nodeType", node.get("node_type")))
        if node_type:
            by_type[node_type] += 1
        state = _text(node.get("state")) or "draft"
        if state == "confirmed":
            confirmed_count += 1
        elif state == "ready":
            ready_count += 1
        else:
            pending_count += 1
    return {
        "total": by_type["character"] + by_type["scene"] + by_type["prop"] + by_type["material"],
        "byType": by_type,
        "pendingCount": pending_count,
        "readyCount": ready_count,
        "confirmedCount": confirmed_count,
    }


def find_scene_node_match(node: dict[str, Any] | None, scenes: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Node findSceneNodeMatch：历史场景节点的确定性关联候选。

    ref_id 命中优先；否则按「标题 / 标题 · 时间」精确匹配（唯一才回退），
    再按「场景/scene + 编号」回退（项目内 scene_no 唯一才接受）。

    :param node: 画布节点行。
    :param scenes: 项目场景行列表。
    :returns: 命中的场景行；无唯一匹配 None。
    """
    node = node or {}
    if normalize_asset_node_type(node.get("nodeType", node.get("node_type"))) != "scene":
        return None
    available_scenes = scenes or []
    linked_id = _safe_int(node.get("refId", node.get("ref_id")))
    if linked_id > 0:
        linked_scene = next((scene for scene in available_scenes if _safe_int(scene.get("id")) == linked_id), None)
        if linked_scene:
            return linked_scene
    label = _text(node.get("label"))
    if not label:
        return None
    candidates = [
        scene
        for scene in available_scenes
        if _text(scene.get("title"))
        and (_text(scene.get("title")) == label or f"{_text(scene.get('title'))} · {_text(scene.get('time_of_day'))}" == label)
    ]
    if len(candidates) == 1:
        return candidates[0]

    scene_no_match = re.search(r"(?:场景|scene)\s*0*(\d+)", label, re.I)
    if not scene_no_match:
        return None
    scene_no = int(scene_no_match.group(1))
    numbered = [scene for scene in available_scenes if _safe_int(scene.get("scene_no", scene.get("sceneNo"))) == scene_no]
    return numbered[0] if len(numbered) == 1 else None


# ---------------------------------------------------------------------------
# asset-grouping.mjs
# ---------------------------------------------------------------------------


def _safe_id(value: Any) -> int | None:
    """Node safeId：正安全整数。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed.is_integer() and parsed > 0 and abs(parsed) <= 2**53 - 1:
        return int(parsed)
    return None


def resolve_asset_group_key(node: dict[str, Any]) -> str:
    """Node resolveAssetGroupKey：画布分组键（历史通用键按 refId 修复）。"""
    node_type = _text(node.get("nodeType", node.get("node_type"))).lower()
    node_type = node_type if node_type in _TYPE_LABELS else "material"
    ref_id = _safe_id(node.get("refId", node.get("ref_id")))
    explicit = _text(node.get("groupKey", node.get("group_key")))
    if explicit in ("角色", "场景"):
        return f"{node_type}:{ref_id}" if ref_id else f"{node_type}:{_safe_id(node.get('id')) or _text(node.get('label')) or 'unassigned'}"
    if explicit:
        return explicit
    if ref_id and node_type in ("character", "scene"):
        return f"{node_type}:{ref_id}"
    return f"{node_type}:{_safe_id(node.get('id')) or _text(node.get('label')) or 'unassigned'}"


def _group_bounds(nodes: list[dict[str, Any]]) -> dict[str, float]:
    """Node groupBounds：分组外接框（含头部留白）。"""
    xs = [float(node.get("x") or 0) for node in nodes] or [0]
    ys = [float(node.get("y") or 0) for node in nodes] or [0]

    def side_of(node: dict[str, Any], key: str, fallback: int) -> float:
        """边长读取（非法回落）。"""
        try:
            parsed = float(node.get(key))
        except (TypeError, ValueError):
            return float(fallback)
        return parsed if parsed > 0 else float(fallback)

    max_right = max(
        (float(node.get("x") or 0) + side_of(node, "width", 220) for node in nodes),
        default=0,
    )
    max_bottom = max(
        (float(node.get("y") or 0) + side_of(node, "height", 260) for node in nodes),
        default=0,
    )
    min_x = min(xs) - ASSET_CANVAS_GROUP_PADDING
    min_y = min(ys) - ASSET_CANVAS_GROUP_PADDING - ASSET_CANVAS_GROUP_HEADER_HEIGHT
    return {
        "x": min_x,
        "y": min_y,
        "width": max_right + ASSET_CANVAS_GROUP_PADDING - min_x,
        "height": max_bottom + ASSET_CANVAS_GROUP_PADDING - min_y,
    }


def _state_counts(nodes: list[dict[str, Any]]) -> dict[str, int]:
    """Node stateCounts：分组内状态计数。"""
    counts = {"draft": 0, "ready": 0, "confirmed": 0}
    for node in nodes:
        state = _text(node.get("state")) or "draft"
        counts[state] = counts.get(state, 0) + 1
    return counts


def build_asset_groups(nodes: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Node buildAssetGroups：节点按实体组聚合（画布与资产库共用视图）。"""
    buckets: dict[str, list[dict[str, Any]]] = {}
    for node in nodes or []:
        key = resolve_asset_group_key(node)
        buckets.setdefault(key, []).append(node)
    groups = []
    for key, items in buckets.items():
        first = items[0] if items else {}
        node_type = _text(first.get("nodeType", first.get("node_type"))).lower()
        node_type = node_type if node_type in _TYPE_LABELS else "material"
        label = _text(first.get("label")) or f"未命名{_TYPE_LABELS[node_type]}"
        sorted_items = sorted(items, key=lambda node: _safe_id(node.get("id")) or 0)
        groups.append(
            {
                "key": key,
                "nodeType": node_type,
                "typeLabel": _TYPE_LABELS[node_type],
                "label": label,
                "nodeIds": [node_id for node_id in (_safe_id(node.get("id")) for node in sorted_items) if node_id],
                "nodeCount": len(sorted_items),
                "stateCounts": _state_counts(sorted_items),
                "bounds": _group_bounds(sorted_items),
            }
        )
    return groups


def build_asset_canvas_group_bounds(nodes: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Node buildAssetCanvasGroupBounds：按实际渲染坐标重算分组外接框。"""
    normalized_nodes = [
        {**node, **normalize_asset_node_layout(node)}
        for node in (nodes or [])
    ]
    by_id = {_safe_int(node.get("id")): node for node in normalized_nodes}

    def layout_sort(left: dict[str, Any] | None, right: dict[str, Any] | None) -> tuple:
        """Node layoutSort：类型序 → 标签 zh 比较 → id。"""
        type_order = {"character": 0, "scene": 1, "prop": 2, "material": 3}
        left_type = type_order.get(normalize_asset_node_type((left or {}).get("nodeType", (left or {}).get("node_type"))) or "", 9)
        right_type = type_order.get(normalize_asset_node_type((right or {}).get("nodeType", (right or {}).get("node_type"))) or "", 9)
        if left_type != right_type:
            return left_type - right_type
        left_label = _text((left or {}).get("label"))
        right_label = _text((right or {}).get("label"))
        if left_label != right_label:
            return -1 if left_label < right_label else 1
        return _safe_int((left or {}).get("id")) - _safe_int((right or {}).get("id"))

    groups = []
    for group in sorted(build_asset_groups(normalized_nodes), key=lambda g: _layout_sort_key(by_id, g)):
        group_nodes = [by_id.get(node_id) for node_id in group["nodeIds"]]
        group_nodes = [node for node in group_nodes if node]
        if not group_nodes:
            continue
        sorted_group_nodes = sorted(
            group_nodes,
            key=lambda node: (_text(node.get("appearanceLabel")), _safe_int(node.get("id"))),
        )
        min_x = min(float(node.get("x") or 0) for node in sorted_group_nodes) - ASSET_CANVAS_GROUP_PADDING
        min_y = min(float(node.get("y") or 0) for node in sorted_group_nodes) - ASSET_CANVAS_GROUP_PADDING - ASSET_CANVAS_GROUP_HEADER_HEIGHT
        max_x = max(
            float(node.get("x") or 0) + _normalize_side(node.get("width"), ASSET_NODE_DEFAULT_WIDTH)
            for node in sorted_group_nodes
        ) + ASSET_CANVAS_GROUP_PADDING
        max_y = max(
            float(node.get("y") or 0) + _normalize_side(node.get("height"), ASSET_NODE_DEFAULT_HEIGHT)
            for node in sorted_group_nodes
        ) + ASSET_CANVAS_GROUP_PADDING
        groups.append(
            {
                **group,
                "bounds": {"x": min_x, "y": min_y, "width": max_x - min_x, "height": max_y - min_y},
            }
        )
    return groups


def _layout_sort_key(by_id: dict[int, dict[str, Any]], group: dict[str, Any]) -> tuple:
    """分组排序键（Node groups.sort(layoutSort(firstNode)) 的键化等价）。"""
    first_node = by_id.get(group["nodeIds"][0]) if group["nodeIds"] else None
    type_order = {"character": 0, "scene": 1, "prop": 2, "material": 3}
    node_type = normalize_asset_node_type((first_node or {}).get("nodeType", (first_node or {}).get("node_type"))) or ""
    label = _text((first_node or {}).get("label"))
    node_id = _safe_int((first_node or {}).get("id")) or 0
    return (type_order.get(node_type, 9), label, node_id)


# ---------------------------------------------------------------------------
# asset-view-contract.mjs
# ---------------------------------------------------------------------------


def get_asset_view_angles(view_set_type: Any) -> list[dict[str, Any]]:
    """Node getAssetViewAngles：视图类型 → 视角表。"""
    view_set_type = _text(view_set_type)
    if view_set_type == "character-turnaround":
        return CHARACTER_VIEW_ANGLES
    if view_set_type == "character-face-closeup":
        return CHARACTER_FACE_CLOSEUP_ANGLES
    if view_set_type == "scene-nine-grid":
        return SCENE_VIEW_ANGLES
    if view_set_type == "prop-turnaround":
        return PROP_VIEW_ANGLES
    return []


def normalize_asset_view_type(value: Any) -> str:
    """Node normalizeAssetViewType：非法视图类型回落 single。"""
    view_type = _text(value)
    return view_type if view_type in ("character-turnaround", "character-face-closeup", "scene-nine-grid", "prop-turnaround") else "single"


def normalize_asset_view_items(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Node normalizeAssetViewItems：视图项归一化（保留有 index+key 的项）。"""
    normalized = []
    for item in items or []:
        item = item if isinstance(item, dict) else {}
        view_index = _positive_int(item.get("viewIndex", item.get("view_index")))
        view_key = _text(item.get("viewKey", item.get("view_key")))
        if not view_index or not view_key:
            continue
        referenced = item.get("referencedStoryboardIds")
        normalized.append(
            {
                "imageId": _positive_int(item.get("imageId", item.get("image_id"))),
                "assetNodeId": _positive_int(item.get("assetNodeId", item.get("asset_node_id"))),
                "viewSetType": normalize_asset_view_type(item.get("viewSetType", item.get("view_set_type"))),
                "viewSetVersion": _positive_int(item.get("viewSetVersion", item.get("view_set_version"))) or 1,
                "viewIndex": view_index,
                "viewKey": view_key,
                "viewLabel": _text(item.get("viewLabel", item.get("view_label"))),
                "sourceImageId": _positive_int(item.get("sourceImageId", item.get("source_image_id"))),
                "sourceImageUrl": _text(item.get("sourceImageUrl", item.get("source_image_url"))) or None,
                "status": _text(item.get("status")).lower() or "candidate",
                "crop": parse_crop(item.get("crop", item.get("crop_json"))),
                "referencedStoryboardIds": (
                    [value for value in (_positive_int(entry) for entry in referenced) if value]
                    if isinstance(referenced, list)
                    else []
                ),
            }
        )
    return normalized


def select_latest_asset_view_items(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Node selectLatestAssetViewItems：同视角取最新版本（重试行优先）。"""
    latest: dict[str, dict[str, Any]] = {}
    for item in normalize_asset_view_items(items):
        key = f"{item['viewSetType']}:{item['viewKey']}"
        current = latest.get(key)
        current_version = _positive_int((current or {}).get("viewSetVersion")) or 0
        next_version = _positive_int(item.get("viewSetVersion")) or 0
        if (
            not current
            or next_version > current_version
            or (next_version == current_version and (_safe_int(item.get("imageId")) or 0) > (_safe_int(current.get("imageId")) or 0))
        ):
            latest[key] = item
    return sorted(latest.values(), key=lambda item: item["viewIndex"])


def validate_asset_view_set(view_set_type: Any, items: list[dict[str, Any]] | None = None, require_confirmed: bool = False) -> dict[str, Any]:
    """Node validateAssetViewSet：视图组完备性校验。"""
    expected = get_asset_view_angles(normalize_asset_view_type(view_set_type))
    if not expected:
        return {"ready": True, "blockers": [], "missing": [], "invalid": [], "items": []}
    normalized = select_latest_asset_view_items(items)
    by_index = {item["viewIndex"]: item for item in normalized}
    missing = [angle for angle in expected if angle["index"] not in by_index]
    invalid = [
        item
        for item in normalized
        if not any(angle["index"] == item["viewIndex"] and item["viewKey"] == angle["key"] for angle in expected)
    ]
    unconfirmed = [item for item in normalized if item["status"] != "confirmed"] if require_confirmed else []
    blockers = [
        *(f"缺少{angle['label']}视角" for angle in missing),
        *(f"视角编号 {item['viewIndex']} 与视角标识不匹配" for item in invalid),
        *(f"{item['viewLabel'] or item['viewKey']}视角尚未确认" for item in unconfirmed),
    ]
    return {
        "ready": not blockers,
        "blockers": blockers,
        "missing": [angle["key"] for angle in missing],
        "invalid": invalid,
        "unconfirmed": unconfirmed,
        "items": normalized,
    }


# ---------------------------------------------------------------------------
# asset-pack-lifecycle.mjs / asset-parser-sync.mjs / asset-node-relink.mjs
# ---------------------------------------------------------------------------


def is_character_asset_pack_row(row: dict[str, Any] | None) -> bool:
    """Node isCharacterAssetPackRow：完整角色资产板行判定（含旧 single 板升级）。"""
    row = row or {}
    view_set_type = _text(row.get("view_set_type", row.get("viewSetType")))
    if view_set_type == "character-asset-pack":
        return True
    if view_set_type != "single":
        return False
    label = _text(row.get("view_label", row.get("viewLabel")))
    prompt = _text(row.get("prompt_snapshot", row.get("promptSnapshot")))
    return label == "角色资产板" or bool(_PACK_LEGACY_LABEL_RE.search(f"{label}\n{prompt}"))


def _is_active_row(row: dict[str, Any]) -> bool:
    """Node isActive：failed/superseded 之外视为活动。"""
    return _text(row.get("status")).lower() not in ("failed", "superseded")


def plan_asset_pack_adoption(candidate_rows: list[dict[str, Any]], existing_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Node planAssetPackAdoption：角色资产板整体采纳计划。"""
    candidates = sorted(
        (
            row
            for row in (candidate_rows or [])
            if _is_active_row(row) and _text(row.get("view_set_type", row.get("viewSetType"))) == "character-asset-pack"
        ),
        key=lambda row: _safe_int(row.get("id")) or 0,
        reverse=True,
    )
    candidate = candidates[0] if candidates else None
    passed = _text((candidate or {}).get("vision_status", (candidate or {}).get("visionStatus"))).lower() == "passed"
    if not candidate or not passed:
        return {
            "ready": False,
            "blockers": ["角色资产板整体视觉检查未通过" if candidate else "角色资产板缺失"],
            "adoptIds": [],
            "replaceIds": [],
        }
    adopt_id = _safe_int(candidate.get("id"))
    if not adopt_id:
        return {"ready": False, "blockers": ["角色资产板记录无效"], "adoptIds": [], "replaceIds": []}
    replace_ids = [
        _safe_int(row.get("id"))
        for row in (existing_rows or [])
        if _is_active_row(row)
        and _text(row.get("status")).lower() in ("confirmed", "candidate")
        and (_safe_int(row.get("id")) or 0) != adopt_id
    ]
    return {"ready": True, "blockers": [], "adoptIds": [adopt_id], "replaceIds": [value for value in replace_ids if value]}


def plan_single_asset_adoption(candidate: dict[str, Any] | None, existing_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Node planSingleAssetAdoption：单图（道具/素材）采纳计划。"""
    if (
        not candidate
        or not _is_active_row(candidate)
        or _text(candidate.get("vision_status", candidate.get("visionStatus"))).lower() != "passed"
    ):
        return {"ready": False, "adoptId": None, "replaceIds": []}
    adopt_id = _safe_int(candidate.get("id"))
    if not adopt_id:
        return {"ready": False, "adoptId": None, "replaceIds": []}
    replace_ids = [
        _safe_int(row.get("id"))
        for row in (existing_rows or [])
        if _is_active_row(row)
        and (_safe_int(row.get("id")) or 0) != adopt_id
        and _text(row.get("status")).lower() in ("confirmed", "candidate")
    ]
    return {"ready": True, "adoptId": adopt_id, "replaceIds": [value for value in replace_ids if value]}


def build_active_asset_node_dedup_plan(existing_nodes: list[dict[str, Any]] | None) -> dict[str, Any]:
    """Node buildActiveAssetNodeDedupPlan：同逻辑资产保一活动节点（保留图片工作）。"""
    groups: dict[str, list[dict[str, Any]]] = {}
    for node in existing_nodes or []:
        if _text(node.get("status") or "active") == "archived":
            continue
        node_type = _text(node.get("nodeType", node.get("node_type")))
        ref_id = node.get("refId", node.get("ref_id"))
        group_key = node.get("groupKey", node.get("group_key"))
        if not node_type or (ref_id is None and not _text(group_key)):
            continue
        logical_key = f"{node_type}:{_safe_int(ref_id)}:{_text(group_key)}"
        groups.setdefault(logical_key, []).append(node)
    archive_ids: list[int] = []
    for group_nodes in groups.values():
        if len(group_nodes) < 2:
            continue

        def image_count(node: dict[str, Any]) -> int:
            """Node imageCount：节点图片计数。"""
            value = _safe_int(node.get("imageCount", node.get("image_count")))
            return value if value > 0 else 0

        ordered = sorted(group_nodes, key=lambda node: (-image_count(node), _safe_int(node.get("id")) or 0))
        archive_ids.extend(_safe_int(node.get("id")) for node in ordered[1:])
    return {"archiveIds": sorted({value for value in archive_ids if value})}


def choose_scene_for_relink(
    requested_scene_id: Any = None,
    requested_label: Any = None,
    scenes: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Node chooseSceneForRelink：场景重关联候选（id 优先，名称次之）。

    :param requested_scene_id: 请求场景 id。
    :param requested_label: 请求场景名称。
    :param scenes: 项目场景行列表。
    :returns: 命中场景行；否则 None。
    """
    scene_id = _safe_int(requested_scene_id)
    if scene_id > 0:
        return next((scene for scene in (scenes or []) if _safe_int(scene.get("id")) == scene_id), None)
    label = _text(requested_label).lower()
    if not label:
        return None
    for scene in scenes or []:
        for value in (_text(scene.get("title")), _text(scene.get("location")), _text(scene.get("summary"))):
            if value and value.lower() == label:
                return scene
    return None


# ---------------------------------------------------------------------------
# asset-character-workflow.mjs：确认门禁系列
# ---------------------------------------------------------------------------


def _is_real_asset_image(image_url: Any, model_name: Any) -> bool:
    """Node isRealAssetImage：真实生图服务产物（排除 mock 与占位）。"""
    url = _text(image_url)
    model = _text(model_name).lower()
    return bool(url) and "/mock-assets/" not in url and not model.startswith("mock-")


def validate_character_asset_pack_confirmation(
    *, view_type: Any, image_status: Any, vision_status: Any, image_url: Any, model_name: Any
) -> dict[str, Any]:
    """Node validateCharacterAssetPackConfirmation：角色资产板确认门禁。

    :returns: ``{"ready", "code", "message"}``。
    """
    if _text(view_type) != "character-asset-pack":
        return {"ready": True, "code": None, "message": ""}
    if _text(image_status) in ("failed", "superseded"):
        return {"ready": False, "code": "character-asset-pack-not-active", "message": "失效或已替代的角色资产板不能确认"}
    if _text(vision_status) != "passed":
        return {
            "ready": False,
            "code": "character-asset-pack-vision-pending",
            "message": "角色资产板未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "角色资产板尚未完成视觉检查，请稍后重试",
        }
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "character-asset-pack-not-real", "message": "角色资产板不是来自真实图片生成服务，不能确认"}
    return {"ready": True, "code": None, "message": ""}


def _image_id_of(image: dict[str, Any] | None) -> int:
    """Node imageId：图片 id（缺省 0）。"""
    if not image:
        return 0
    try:
        return int(float(image.get("id", image.get("image_id"))))
    except (TypeError, ValueError):
        return 0


def get_confirmed_character_base_image(images: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Node getConfirmedCharacterBaseImage：角色三视图唯一基础来源（已确认 single/板）。"""
    candidates = [
        image
        for image in (images or [])
        if _text(image.get("viewSetType", image.get("view_set_type"))) in ("single", "character-asset-pack")
        and _text(image.get("status")) == "confirmed"
    ]
    candidates.sort(key=_image_id_of, reverse=True)
    return candidates[0] if candidates else None


def get_character_base_reference_image(images: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Node getCharacterBaseReferenceImage：派生图可用的基础参考（passed 重试可当参考）。"""
    candidates = []
    for image in images or []:
        view_type = _text(image.get("viewSetType", image.get("view_set_type")))
        status = _text(image.get("status"))
        vision_status = _text(image.get("visionStatus", image.get("vision_status")))
        if view_type not in ("single", "character-asset-pack") or status in ("failed", "superseded"):
            continue
        if vision_status == "passed" or (status == "confirmed" and not vision_status):
            candidates.append(image)
    candidates.sort(key=_image_id_of, reverse=True)
    return candidates[0] if candidates else None


def get_confirmed_character_face_closeup_image(images: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Node getConfirmedCharacterFaceCloseupImage：已确认且通过视觉的脸部特写。"""
    candidates = [
        image
        for image in (images or [])
        if _text(image.get("viewSetType", image.get("view_set_type"))) == "character-face-closeup"
        and _text(image.get("viewKey", image.get("view_key"))) == "face"
        and _text(image.get("status")) == "confirmed"
        and _text(image.get("visionStatus", image.get("vision_status"))) == "passed"
    ]
    candidates.sort(key=_image_id_of, reverse=True)
    return candidates[0] if candidates else None


def validate_character_view_generation(node_type: Any, view_type: Any, images: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Node validateCharacterViewGeneration：派生图生成前置门禁（基础图/脸部特写）。"""
    if node_type != "character" or view_type not in ("character-turnaround", "character-face-closeup"):
        return {"ready": True, "code": None, "message": "", "baseImage": None}
    base_image = get_character_base_reference_image(images)
    if not base_image:
        return {"ready": False, "code": "character-base-image-required", "message": "请先生成并确认角色基础正面全身图", "baseImage": None}
    if view_type == "character-turnaround" and not get_confirmed_character_face_closeup_image(images):
        return {
            "ready": False,
            "code": "character-face-closeup-required",
            "message": "请先生成、通过视觉检查并确认角色脸部特写，再生成三视图",
            "baseImage": base_image,
        }
    return {"ready": True, "code": None, "message": "", "baseImage": base_image}


def validate_character_face_closeup_confirmation(
    *,
    view_type: Any,
    view_key: Any,
    image_status: Any,
    vision_status: Any,
    image_url: Any,
    model_name: Any,
    identity_status: Any,
    identity_reason: Any,
) -> dict[str, Any]:
    """Node validateCharacterFaceCloseupConfirmation：脸部特写确认门禁。"""
    if _text(view_type) != "character-face-closeup":
        return {"ready": True, "code": None, "message": ""}
    if _text(view_key) != "face":
        return {"ready": False, "code": "character-face-closeup-required", "message": "脸部特写必须是独立的 face 视图"}
    if _text(image_status) == "failed":
        return {"ready": False, "code": "character-face-closeup-generation-failed", "message": "生成失败的脸部特写不能确认"}
    if _text(image_status) == "superseded":
        return {"ready": False, "code": "character-face-closeup-superseded", "message": "该脸部特写已被新候选替代，不能确认"}
    if _text(vision_status) != "passed":
        return {
            "ready": False,
            "code": "character-face-closeup-vision-pending",
            "message": "脸部特写未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "脸部特写尚未完成视觉检查，请稍后重试",
        }
    if _text(identity_status) == "failed":
        return {
            "ready": False,
            "code": "character-identity-inconsistent",
            "message": _text(identity_reason) or "脸部特写与基础角色身份或穿搭不一致，请重新生成",
        }
    if _text(identity_status) == "pending":
        return {"ready": False, "code": "character-identity-pending", "message": "脸部特写尚未完成身份与穿搭一致性检查，请稍后重试"}
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "character-face-closeup-not-real", "message": "脸部特写不是来自真实图片生成服务，不能确认"}
    return {"ready": True, "code": None, "message": ""}


def validate_character_turnaround_confirmation(
    *,
    view_type: Any,
    view_key: Any,
    image_status: Any,
    vision_status: Any,
    image_url: Any,
    model_name: Any,
    identity_status: Any,
    identity_reason: Any,
) -> dict[str, Any]:
    """Node validateCharacterTurnaroundConfirmation：三视图确认门禁。"""
    if _text(view_type) != "character-turnaround":
        return {"ready": True, "code": None, "message": ""}
    if _text(view_key) not in ("front", "side", "back"):
        return {
            "ready": False,
            "code": "character-view-angle-required",
            "message": "该旧三视图是单张拼贴结果，不能作为独立视角确认；请重新分别生成正面、侧面和背面",
        }
    if _text(image_status) == "failed":
        return {"ready": False, "code": "character-view-generation-failed", "message": "生成失败的角色视角不能确认"}
    if _text(image_status) == "superseded":
        return {"ready": False, "code": "character-view-superseded", "message": "该角色视角已被新候选替代，不能确认"}
    if _text(vision_status) != "passed":
        return {
            "ready": False,
            "code": "character-view-vision-pending",
            "message": "该视角未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "该视角尚未完成视觉检查，请稍后重试",
        }
    if _text(identity_status) == "failed":
        return {
            "ready": False,
            "code": "character-identity-inconsistent",
            "message": _text(identity_reason) or "三视图与基础角色身份或穿搭不一致，请重新生成",
        }
    if _text(identity_status) == "pending":
        return {"ready": False, "code": "character-identity-pending", "message": "三视图尚未完成身份与穿搭一致性检查，请稍后重试"}
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "character-view-not-real", "message": "该视角不是来自真实图片生成服务，不能确认；请重新生成"}
    return {"ready": True, "code": None, "message": ""}


def validate_asset_image_confirmation(
    *, node_type: Any, view_type: Any, image_status: Any, vision_status: Any, image_url: Any, model_name: Any
) -> dict[str, Any]:
    """Node validateAssetImageConfirmation：基础资产（single/板）确认门禁。

    场景 skipped 视为人工确认通道（仍要求真实图片）。
    """
    asset_type = _text(node_type)
    is_base_asset = _text(view_type) in ("single", "character-asset-pack") and asset_type in (
        "character", "scene", "prop", "material"
    )
    if not is_base_asset:
        return {"ready": True, "code": None, "message": ""}
    if _text(image_status) == "failed":
        return {"ready": False, "code": "asset-image-generation-failed", "message": "生成失败的资产不能确认"}
    if _text(image_status) == "superseded":
        return {"ready": False, "code": "asset-image-superseded", "message": "该资产已被新候选替代，不能确认"}
    if asset_type == "scene" and _text(vision_status) == "skipped":
        if not _is_real_asset_image(image_url, model_name):
            return {"ready": False, "code": "asset-image-not-real", "message": "该资产不是来自真实图片生成服务，不能确认"}
        return {"ready": True, "code": None, "message": "视觉检查未运行；请人工确认场景全景基准"}
    if _text(vision_status) != "passed":
        return {
            "ready": False,
            "code": "asset-image-vision-pending",
            "message": "该资产未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "该资产尚未完成视觉检查，请稍后重试",
        }
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "asset-image-not-real", "message": "该资产不是来自真实图片生成服务，不能确认"}
    return {"ready": True, "code": None, "message": ""}


def validate_prop_turnaround_confirmation(
    *,
    node_type: Any,
    view_type: Any,
    view_key: Any,
    image_status: Any,
    vision_status: Any,
    image_url: Any,
    model_name: Any,
) -> dict[str, Any]:
    """Node validatePropTurnaroundConfirmation：道具多视角确认门禁。"""
    if _text(node_type) not in ("prop", "material") or _text(view_type) != "prop-turnaround":
        return {"ready": True, "code": None, "message": ""}
    if _text(view_key) not in ("front", "side", "back", "top"):
        return {"ready": False, "code": "prop-view-angle-required", "message": "道具多视角必须是正面、侧面、背面或俯视独立视角"}
    if _text(image_status) in ("failed", "superseded"):
        return {"ready": False, "code": "prop-view-not-active", "message": "失效或已替代的道具视角不能确认"}
    if _text(vision_status) != "passed":
        return {
            "ready": False,
            "code": "prop-view-vision-pending",
            "message": "道具视角未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "道具视角尚未完成视觉检查，请稍后重试",
        }
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "prop-view-not-real", "message": "道具视角不是来自真实图片生成服务，不能确认"}
    return {"ready": True, "code": None, "message": ""}


# ---------------------------------------------------------------------------
# scene-nine-grid.mjs
# ---------------------------------------------------------------------------


def get_scene_nine_grid_angles() -> list[dict[str, Any]]:
    """Node getSceneNineGridAngles：九机位描述符。"""
    return SCENE_GRID_ANGLES


def scene_nine_grid_quality_attempts(value: Any, fallback: int = 5) -> int:
    """Node sceneNineGridQualityAttempts：1-5 之外的次数回落默认。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return int(parsed) if parsed.is_integer() and 1 <= parsed <= 5 else fallback


def validate_scene_nine_grid_view_confirmation(
    *,
    view_key: Any,
    crop: Any,
    source_image_id: Any,
    image_status: Any,
    vision_status: Any,
    image_url: Any,
    model_name: Any,
) -> dict[str, Any]:
    """Node validateSceneNineGridViewConfirmation：场景视角确认门禁。"""
    angle = next((item for item in SCENE_GRID_ANGLES if item["key"] == _text(view_key)), None)
    if not angle or not _positive_int(source_image_id):
        return {
            "ready": False,
            "code": "scene-view-angle-required",
            "message": "九宫格母图不能直接确认，请先生成并检查具体场景视角",
        }
    if _text(image_status) == "failed":
        return {"ready": False, "code": "scene-view-generation-failed", "message": "生成失败的场景视角不能确认"}
    if _text(image_status) == "superseded":
        return {"ready": False, "code": "scene-view-superseded", "message": "该场景视角已被新候选替代，不能确认"}
    if _text(vision_status) not in ("passed", "skipped"):
        return {
            "ready": False,
            "code": "scene-view-vision-pending",
            "message": "该场景视角未通过视觉检查，请重新生成" if _text(vision_status) == "failed" else "该场景视角尚未完成视觉检查，请稍后重试",
        }
    if not _is_real_asset_image(image_url, model_name):
        return {"ready": False, "code": "scene-view-not-real", "message": "该场景视角不是来自真实图片生成服务，不能确认；请重新生成"}
    if _text(vision_status) == "skipped":
        return {
            "ready": True,
            "code": None,
            "message": "视觉检查未运行；请按全景基准人工确认此角度",
            "visionSkipped": True,
        }
    return {"ready": True, "code": None, "message": ""}


def build_scene_nine_grid_angle_prompt(angle: Any, panorama: Any, spatial_anchors: Any = None) -> str:
    """Node buildSceneNineGridAnglePrompt：九宫格单机位参考图引导提示词。

    :param angle: 机位键。
    :param panorama: 全景基准（URL 或 storage_key）。
    :param spatial_anchors: 场景空间锚点清单。
    :returns: 提示词文本。
    :raises ValueError: 未知机位或缺全景参考。
    """
    descriptor = next((item for item in SCENE_GRID_ANGLES if item["key"] == _text(angle)), None)
    if not descriptor:
        raise ValueError(f"unknown scene nine-grid view: {_text(angle)}")
    reference = _text(panorama)
    if not reference:
        raise ValueError("confirmed panorama reference is required")
    manifest = normalize_scene_space_manifest(spatial_anchors) if spatial_anchors else {"anchors": [], "view_bindings": {}}
    anchor_ids = manifest.get("view_bindings", {}).get(descriptor["key"], [])
    anchor_labels = []
    for anchor_id in anchor_ids:
        anchor = next((item for item in manifest.get("anchors", []) if item["id"] == anchor_id), None)
        if anchor:
            anchor_labels.append(f"{anchor['id']}「{anchor['label']}」")
    return "\n".join(
        [
            "任务类型：使用已确认全景母版生成一个参考图引导的空场视角候选。",
            f"同一张已确认的场景全景基准图 / 全景母版参考：{reference}",
            "母版是唯一空间来源。继承其中已确认的建筑、开口、固定家具、材质、光线和相对位置；禁止重构、增删、移动、镜像或改变这些内容。",
            f"相机参数（唯一变化）：固定全景原点 origin=(0,1.55,0)；yaw={descriptor['yaw']}°；pitch={descriptor['pitch']}°；FOV={descriptor['fov']}°。坐标系固定，不进行平移。",
            f"目标机位：{descriptor['label']}（view_key={descriptor['key']}）。本视角必须保留并可辨认的空间锚点：{'、'.join(anchor_labels)}。",
            "只根据相机参数改变投影视角，不补写房间、家具、材质、灯光或剧情描述；按母版原有遮挡关系表现，锚点不合理可见时应阻断该机位计划，不得临时虚构。",
            "只输出单张空场环境视角，不生成角色、人物剪影、人物照片、遗像、人体倒影、文字、字幕、水印、九宫格或拼贴。",
            "能力标记：这是参考图引导生成，不是确定性三维采样。只有有效360°等距柱状母版走确定性投影时，才可称为几何锁定视角。",
        ]
    )


# ---------------------------------------------------------------------------
# asset-canvas.mjs：buildAssetCanvasView
# ---------------------------------------------------------------------------


def build_asset_canvas_view(
    project_id: Any,
    nodes: list[dict[str, Any]] | None = None,
    images: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Node buildAssetCanvasView：画布视图组装（节点 + 形象 + 分组 + 汇总）。

    :param project_id: 项目 id。
    :param nodes: asset_nodes 行（非归档）。
    :param images: asset_node_images DTO（已过 assetNodeImageDto 处理）。
    :returns: ``{"projectId", "nodes", "groups", "summary"}``。
    """
    images_by_node: dict[int, list[dict[str, Any]]] = {}
    node_type_by_id = {
        _safe_int(node.get("id")): normalize_asset_node_type(node.get("node_type", node.get("nodeType")))
        for node in (nodes or [])
    }
    for image in images or []:
        node_id = _safe_int(image.get("asset_node_id", image.get("assetNodeId")))
        normalized_image: dict[str, Any] = dict(image)
        if node_type_by_id.get(node_id) == "character" and is_character_asset_pack_row(image):
            # 旧 single 角色资产板在视图层升级为板形态（不改库）。
            normalized_image.update(
                {
                    "view_set_type": "character-asset-pack",
                    "viewSetType": "character-asset-pack",
                    "view_key": None,
                    "viewKey": None,
                    "view_index": None,
                    "viewIndex": None,
                    "view_label": "角色资产板",
                    "viewLabel": "角色资产板",
                }
            )
        images_by_node.setdefault(node_id, []).append(asset_node_image_row(normalized_image))

    view_nodes = []
    for row in nodes or []:
        node_images = sorted(images_by_node.get(_safe_int(row.get("id")) or 0, []), key=lambda image: image["id"])
        latest_view_images: dict[str, dict[str, Any]] = {}
        for image in node_images:
            if image["viewSetType"] == "character-turnaround" and image["viewKey"]:
                current = latest_view_images.get(image["viewKey"])
                if not current or image["id"] > current["id"]:
                    latest_view_images[image["viewKey"]] = image
        display_images = [
            image
            for image in node_images
            if image["status"] not in ("superseded", "failed")
            and image["visionStatus"] != "failed"
            and (
                image["viewSetType"] != "character-turnaround"
                or not image["viewKey"]
                or latest_view_images.get(image["viewKey"], {}).get("id") == image["id"]
            )
        ]
        view_items = select_latest_asset_view_items(
            [
                {**item, "imageId": image["id"]}
                for image in display_images
                for item in normalize_asset_view_items([image])
            ]
        )
        view_set_validation = []
        for view_set_type in dict.fromkeys(image["viewSetType"] for image in node_images):
            if view_set_type == "single":
                continue
            validation = validate_asset_view_set(
                view_set_type,
                [item for item in view_items if item["viewSetType"] == view_set_type],
                require_confirmed=True,
            )
            view_set_validation.append({"viewSetType": view_set_type, **validation})
        confirmed_image = next(
            (
                image
                for image in display_images
                if image["status"] == "confirmed"
                and (image["viewSetType"] != "character-turnaround" or image["visionStatus"] == "passed")
            ),
            None,
        )
        view_nodes.append(
            {
                **_normalize_node(row),
                "state": derive_asset_node_state(node_images, row.get("node_type", row.get("nodeType"))),
                "images": node_images,
                "confirmedImage": confirmed_image,
                "viewItems": view_items,
                "viewSetValidation": view_set_validation,
            }
        )

    laid_out_nodes = [{**node, **normalize_asset_node_layout(node)} for node in view_nodes]
    return {
        "projectId": _safe_int(project_id),
        "nodes": laid_out_nodes,
        "groups": build_asset_canvas_group_bounds(laid_out_nodes),
        "summary": summarize_asset_canvas(laid_out_nodes),
    }
