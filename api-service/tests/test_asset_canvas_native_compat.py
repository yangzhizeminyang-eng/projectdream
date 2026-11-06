"""资产画布组（阶段 3.5）端点兼容测试 + Node fixture 对照。

对照 Node（行号以 2026-10-17 工作区版本为准）：

- GET  /api/projects/{id}/asset-canvas（index.mjs L13483：读时自愈链）
- POST /api/projects/{id}/asset-nodes（L13681）
- PATCH/DELETE /api/asset-nodes/{id}（L13968/L14030）
- POST /api/asset-nodes/{id}/relink-scene（L13806）/ hydrate-prompt（L13879）
- GET  /api/asset-nodes/{id}/images（L14047）
- POST /api/asset-nodes/{id}/images/generate（L14063 + enqueueAssetNodeImageJob L9914）
- POST /api/asset-node-images/{id}/confirm（L14080）/ vision-check（L14303）
- GET  /api/projects/{id}/export-package（L12592 + buildExportPackage L10690）
- DELETE /api/projects/{id}（L15141：confirmName + 4090）

提示词/门禁/视图构建器逐字段语义由 tests/fixtures/generate_asset_node_fixtures.mjs
（Node 直调产物）锁定（本文件 fixture 对照段）。全部离线
（fake database + mock AI 配置）。

运行前置：``node api-service/tests/fixtures/generate_asset_node_fixtures.mjs``
"""

import json
import re
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.domain import asset_canvas as ac
from app.domain import asset_prompts as ap
from app.domain.character_rename import (
    extract_related_speaker_names,
    transform_character_names,
    transform_character_names_json,
)
from app.domain.character_voice import (
    infer_character_voice_traits,
    is_character_voice_ready,
    normalize_character_age_group,
    normalize_character_gender,
    recommend_voice_profiles,
    resolve_character_voice_profile,
)
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}
USER_ID = 7
OTHER_USER_ID = 99
PROJECT_ID = 8
NODE_ID = 12
IMAGE_ID = 105
FIXTURES_PATH = Path(__file__).parent / "fixtures" / "asset_node_fixtures.json"


def _load_fixtures() -> list[dict[str, Any]]:
    """读取 Node 直调期望 fixture（缺失时跳过并提示生成命令）。"""
    if not FIXTURES_PATH.exists():
        pytest.skip("asset_node_fixtures.json 缺失：先运行 node api-service/tests/fixtures/generate_asset_node_fixtures.mjs")
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["cases"]


def _attempt(fn: Any) -> Any:
    """Node attempt() 等价：执行 fn 并捕获 ValueError → ``{"raised", "value"}``。"""
    try:
        return {"raised": None, "value": fn()}
    except ValueError as exc:
        return {"raised": str(exc), "value": None}


# ---------------------------------------------------------------------------
# Node fixture 逐字段对照（提示词族 / 门禁 / 视图 / 改名 / 音色）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", _load_fixtures(), ids=lambda case: case["name"])
def test_asset_node_fixture_matches_node(case):
    """Node fixture 逐 case 对照：Python 复刻函数输出与 Node 直调产物全等。

    :param case: fixture case（name/group/input/expected）。
    :return: None。
    """
    group = case["group"]
    payload = case["input"]
    expected = case["expected"]

    if group == "buildScriptCharacterPrompt":
        actual = ap.build_script_character_prompt(
            payload["character"], payload["scenes"], payload.get("projectVisualStyle", ""), payload.get("projectCategory", "")
        )
    elif group == "buildCharacterTurnaroundPrompt":
        actual = ap.build_character_turnaround_prompt(payload["character"])
    elif group == "buildCharacterAssetPackPrompt":
        actual = ap.build_character_asset_pack_prompt(
            payload["character"], payload.get("projectVisualStyle", ""), payload.get("projectCategory", "")
        )
    elif group == "buildScriptScenePrompt":
        actual = ap.build_script_scene_prompt(
            payload["scene"],
            payload.get("projectVisualStyle", ""),
            payload.get("projectCategory", ""),
            payload.get("characterNames") or [],
        )
    elif group == "buildSceneEnvironmentPrompt":
        actual = ap.build_scene_environment_prompt(
            payload["scene"],
            payload.get("projectVisualStyle", ""),
            payload.get("projectCategory", ""),
            payload.get("characterNames") or [],
        )
    elif group == "inferCharacterCostumeFromScenes":
        actual = ap.infer_character_costume_from_scenes(payload["scenes"], payload["characterName"])
    elif group == "inferSceneLocation":
        actual = ap.infer_scene_location(payload["scene"])
    elif group == "inferSceneTimeOfDay":
        actual = ap.infer_scene_time_of_day(payload["scene"])
    elif group == "extractTemporalStates":
        actual = ap.extract_temporal_states(payload["scenes"], payload["characterName"])
    elif group == "buildTemporalVariantPrompt":
        actual = ap.build_temporal_variant_prompt(payload["basePrompt"], payload["stateLabel"])
    elif group == "isLegacyCharacterPrompt":
        actual = ap.is_legacy_character_prompt(payload["prompt"])
    elif group == "buildAssetNodeGenerationPrompt":
        actual = ap.build_asset_node_generation_prompt(
            payload["node"], payload["character"], payload.get("projectVisualStyle", ""), payload.get("appearanceLocked", False)
        )
    elif group == "buildAssetNodePromptSnapshot":
        actual = ap.build_asset_node_prompt_snapshot(
            payload["node"], payload["character"], payload.get("projectVisualStyle", ""), payload.get("appearanceLocked", False)
        )
    elif group == "buildAssetNodeIdentityLock":
        actual = ap.build_asset_node_identity_lock(
            payload["character"], payload.get("appearanceLabel", ""), payload.get("appearanceLocked", False)
        )
    elif group == "resolveAssetNodeGenerationPrompt":
        actual = ap.resolve_asset_node_generation_prompt(
            payload["node"], payload.get("requestedViewType", "single"), payload.get("promptOverride", "")
        )
    elif group == "buildAssetNodeViewPrompt":
        actual = _run_view_prompt(payload)
    elif group == "buildCharacterViewNegativePrompt":
        actual = ap.build_character_view_negative_prompt(payload["viewKey"], {"noFace": payload.get("noFace", False)})
    elif group == "buildSceneNineGridAnglePrompt":
        actual = _attempt(lambda: ac.build_scene_nine_grid_angle_prompt(
            payload["angle"], "https://media.example.com/panorama.png", _FIXTURE_MANIFEST
        ))
    elif group == "getSceneNineGridAngles":
        actual = ac.get_scene_nine_grid_angles()
    elif group == "sceneNineGridQualityAttempts":
        actual = ac.scene_nine_grid_quality_attempts(payload["value"], payload.get("fallback", 5))
    elif group == "buildPropAssetViewPrompt":
        actual = _attempt(lambda: ap.build_prop_asset_view_prompt(payload["prop"], payload["viewKey"]))
    elif group == "extractExplicitSceneFixtures":
        actual = ap.extract_explicit_scene_fixtures(payload["scene"])
    elif group == "assetNodeImageRow":
        actual = ac.asset_node_image_row(payload["row"])
    elif group == "normalizeAssetNodeType":
        actual = ac.normalize_asset_node_type(payload["value"])
    elif group == "normalizeAssetNodeLayout":
        actual = ac.normalize_asset_node_layout(payload)
    elif group == "deriveAssetNodeState":
        actual = ac.derive_asset_node_state(payload["images"], payload.get("nodeType", ""))
    elif group == "findSceneNodeMatch":
        actual = ac.find_scene_node_match(payload["node"], payload["scenes"])
    elif group == "summarizeAssetCanvas":
        actual = ac.summarize_asset_canvas(payload["nodes"])
    elif group == "buildAssetCanvasView":
        actual = ac.build_asset_canvas_view(payload["projectId"], payload["nodes"], payload["images"])
    elif group == "buildAssetGroups":
        actual = ac.build_asset_groups(payload["nodes"])
    elif group == "validateAssetViewSet":
        report = ac.validate_asset_view_set(payload["viewSetType"], payload.get("items") or [], require_confirmed=True)
        actual = {key: report[key] for key in ("ready", "blockers", "missing")}
    elif group == "selectLatestAssetViewItems":
        actual = ac.select_latest_asset_view_items(payload["items"])
    elif group == "normalizeAssetViewItems":
        actual = ac.normalize_asset_view_items(payload["items"])
    elif group == "isCharacterAssetPackRow":
        actual = ac.is_character_asset_pack_row(payload)
    elif group == "planAssetPackAdoption":
        actual = ac.plan_asset_pack_adoption(payload["candidates"], payload.get("existing") or [])
    elif group == "planSingleAssetAdoption":
        actual = ac.plan_single_asset_adoption(payload["candidate"], payload.get("existing") or [])
    elif group == "buildActiveAssetNodeDedupPlan":
        actual = ac.build_active_asset_node_dedup_plan(payload["nodes"])
    elif group == "chooseSceneForRelink":
        actual = ac.choose_scene_for_relink(payload.get("requestedSceneId"), payload.get("requestedLabel", ""), payload["scenes"])
    elif group == "buildSceneDisplayLabel":
        actual = ap.build_scene_display_label(payload["scene"])
    elif group == "normalizeAssetGroupKey":
        actual = ap.normalize_asset_group_key(payload["value"])
    elif group == "resolveTemporalState":
        actual = ap.resolve_temporal_state(payload["prompt"])
    elif group == "buildPropAssetGroupKey":
        actual = ap.build_prop_asset_group_key(payload["projectId"], payload["name"])
    elif group == "resolveCharacterReferenceSet":
        actual = ap.resolve_character_reference_set(payload["images"])
    elif group == "buildCharacterIdentityLockSnapshot":
        actual = ap.build_character_identity_lock_snapshot(payload["character"], payload["baseImage"], payload["referenceSet"])
    elif group == "buildCharacterIdentityLockPrompt":
        actual = ap.build_character_identity_lock_prompt(payload["snapshot"], payload.get("requestedAngle", ""))
    elif group == "parseCharacterIdentityLock":
        actual = ap.parse_character_identity_lock(payload["value"])
    elif group in (
        "validateCharacterAssetPackConfirmation",
        "validateCharacterTurnaroundConfirmation",
        "validateCharacterFaceCloseupConfirmation",
        "validateAssetImageConfirmation",
        "validatePropTurnaroundConfirmation",
        "validateCharacterViewGeneration",
        "validateSceneNineGridViewConfirmation",
    ):
        actual = _run_gate(group, payload)
    elif group == "transformCharacterNames":
        actual = transform_character_names(payload["value"], payload["sourceNames"], payload["newName"])
    elif group == "transformCharacterNamesJson":
        actual = transform_character_names_json(payload["rawJson"], payload["sourceNames"], payload["newName"])
    elif group == "extractRelatedSpeakerNames":
        actual = extract_related_speaker_names(payload["textValues"], payload["currentName"], payload.get("reservedNames") or [])
    elif group == "inferCharacterVoiceTraits":
        actual = infer_character_voice_traits(payload["character"])
    elif group == "recommendVoiceProfiles":
        actual = recommend_voice_profiles(payload["character"], payload["profiles"], payload.get("limit", 3))
    elif group == "resolveCharacterVoiceProfile":
        actual = resolve_character_voice_profile(payload["character"], payload["profiles"], payload.get("requestedProfileKey", ""))
    elif group == "isCharacterVoiceReady":
        actual = is_character_voice_ready(payload["character"], payload.get("selectedProfile"))
    elif group == "normalizeCharacterAgeGroup":
        actual = normalize_character_age_group(payload["value"])
    elif group == "normalizeCharacterGender":
        actual = normalize_character_gender(payload["value"])
    else:
        pytest.fail(f"未知 fixture group：{group}")

    assert actual == expected, f"fixture {case['name']} 不一致"


_FIXTURE_MANIFEST = {
    "version": 1,
    "anchors": [
        {"id": "A1", "category": "architecture", "label": "主墙体", "description": "承重主墙", "relative_position": "北侧", "evidence": "剧本明确", "origin": "script", "narrative_reason": ""},
        {"id": "A2", "category": "fixed_furniture", "label": "监控台", "description": "回放设备桌", "relative_position": "中西部", "evidence": "剧本明确", "origin": "script", "narrative_reason": ""},
        {"id": "M1", "category": "material", "label": "金属墙面", "description": "拉丝金属", "relative_position": "墙面", "evidence": "推断", "origin": "inference", "narrative_reason": "机房质感"},
        {"id": "L1", "category": "light", "label": "冷蓝灯带", "description": "环境光", "relative_position": "顶部", "evidence": "推断", "origin": "inference", "narrative_reason": "夜间氛围"},
    ],
    "view_bindings": {
        "front-left": ["A1", "A2"], "front": ["A1", "A2"], "front-right": ["A1", "A2"],
        "left": ["A1", "A2"], "center": ["A1", "A2"], "right": ["A1", "A2"],
        "back-left": ["A1", "A2"], "back": ["A1", "A2"], "back-right": ["A1", "A2"],
    },
}


_FIXTURE_NODE = {
    "id": 12,
    "nodeType": "character",
    "label": "林知夏",
    "appearanceLabel": "十八年前",
    "promptText": "固定外貌：28 岁女性，短发瓜子脸。",
    "turnaroundPromptText": "",
    "environmentPromptText": "",
    "negativePrompt": "剧情负面词：机房、代码",
}
_FIXTURE_CHARACTER = {
    "id": 9,
    "project_id": 8,
    "name": "林知夏",
    "role_tag": "主角",
    "personality": "冷静克制，观察力强",
    "appearance": "28 岁女性，短发瓜子脸，灰色风衣",
    "costume": "灰色长风衣，深色牛仔裤，白色运动鞋，左手无名指一枚素圈戒指",
    "age_group": "young_adult",
    "gender": "female",
    "voice_style": "低沉克制的青年女声",
    "status": "draft",
}
_FIXTURE_TURNAROUND_NODE = {
    "nodeType": "prop",
    "label": "老式工牌",
    "promptText": "塑料外壳的工牌",
    "turnaroundPromptText": "",
    "environmentPromptText": "",
    "negativePrompt": "",
    "appearanceLabel": "",
}
_FIXTURE_SCENE_NODE = {
    "nodeType": "scene",
    "label": "监控室",
    "promptText": "空间结构",
    "environmentPromptText": "环境锚点",
    "turnaroundPromptText": "",
    "negativePrompt": "",
    "appearanceLabel": "",
}


def _run_view_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    """按 fixture 输入执行 build_asset_node_view_prompt（Node attempt 同形捕获）。"""
    group_view_type = payload["viewType"]
    if group_view_type in ("character-turnaround", "character-face-closeup"):
        node = dict(_FIXTURE_NODE)
        character = dict(_FIXTURE_CHARACTER)
    elif group_view_type == "prop-turnaround":
        node = dict(_FIXTURE_TURNAROUND_NODE)
        character = None
    else:
        node = dict(_FIXTURE_SCENE_NODE)
        character = None
    if payload.get("noBase"):
        base_reference = ""
    else:
        base_reference = "https://media.example.com/base.png" if group_view_type in (
            "character-turnaround", "character-face-closeup"
        ) else ""
    if group_view_type == "prop-turnaround":
        reference = "https://media.example.com/prop.png"
    elif group_view_type == "scene-nine-grid":
        reference = "https://media.example.com/panorama.png"
    else:
        reference = payload.get("referenceImageUrl", "")
    try:
        value = ap.build_asset_node_view_prompt(
            node,
            character,
            payload.get("projectVisualStyle", "冷蓝" if group_view_type in ("character-turnaround", "scene-nine-grid") else ""),
            payload.get("appearanceLocked", False),
            group_view_type,
            payload.get("viewKey", ""),
            reference,
            base_reference,
        )
    except ValueError as exc:
        return {"raised": str(exc), "value": None}
    return {"raised": None, "value": value}


def _run_gate(group: str, payload: dict[str, Any]) -> dict[str, Any]:
    """按 fixture 输入分发到对应门禁函数。"""
    if group == "validateCharacterAssetPackConfirmation":
        return ac.validate_character_asset_pack_confirmation(
            view_type=payload["viewType"],
            image_status=payload["imageStatus"],
            vision_status=payload["visionStatus"],
            image_url=payload["imageUrl"],
            model_name=payload["modelName"],
        )
    if group == "validateCharacterTurnaroundConfirmation":
        return ac.validate_character_turnaround_confirmation(
            view_type=payload["viewType"],
            view_key=payload["viewKey"],
            image_status=payload["imageStatus"],
            vision_status=payload["visionStatus"],
            image_url=payload.get("imageUrl"),
            model_name=payload.get("modelName"),
            identity_status=payload.get("identityStatus"),
            identity_reason=payload.get("identityReason"),
        )
    if group == "validateCharacterFaceCloseupConfirmation":
        return ac.validate_character_face_closeup_confirmation(
            view_type=payload["viewType"],
            view_key=payload["viewKey"],
            image_status=payload["imageStatus"],
            vision_status=payload["visionStatus"],
            image_url=payload.get("imageUrl"),
            model_name=payload.get("modelName"),
            identity_status=payload.get("identityStatus"),
            identity_reason=payload.get("identityReason"),
        )
    if group == "validateAssetImageConfirmation":
        return ac.validate_asset_image_confirmation(
            node_type=payload["nodeType"],
            view_type=payload["viewType"],
            image_status=payload["imageStatus"],
            vision_status=payload["visionStatus"],
            image_url=payload["imageUrl"],
            model_name=payload["modelName"],
        )
    if group == "validatePropTurnaroundConfirmation":
        return ac.validate_prop_turnaround_confirmation(
            node_type=payload["nodeType"],
            view_type=payload["viewType"],
            view_key=payload["viewKey"],
            image_status=payload["imageStatus"],
            vision_status=payload["visionStatus"],
            image_url=payload["imageUrl"],
            model_name=payload["modelName"],
        )
    if group == "validateCharacterViewGeneration":
        return ac.validate_character_view_generation(payload["nodeType"], payload["viewType"], payload.get("images") or [])
    return ac.validate_scene_nine_grid_view_confirmation(
        view_key=payload["viewKey"],
        crop=payload.get("crop"),
        source_image_id=payload.get("sourceImageId"),
        image_status=payload["imageStatus"],
        vision_status=payload["visionStatus"],
        image_url=payload["imageUrl"],
        model_name=payload["modelName"],
    )


_FIXTURE_NODE = {
    "id": 12,
    "nodeType": "character",
    "label": "林知夏",
    "appearanceLabel": "十八年前",
    "promptText": "固定外貌：28 岁女性，短发瓜子脸。",
    "turnaroundPromptText": "",
    "environmentPromptText": "",
    "negativePrompt": "剧情负面词：机房、代码",
}


# ---------------------------------------------------------------------------
# 端点兼容测试（fake database）
# ---------------------------------------------------------------------------

CHARACTER_ROW = {
    "id": 9,
    "project_id": PROJECT_ID,
    "name": "林知夏",
    "role_tag": "主角",
    "personality": "冷静克制",
    "appearance": "28 岁女性，短发瓜子脸",
    "costume": "灰色长风衣",
    "age_group": "young_adult",
    "gender": "female",
    "voice_style": None,
    "voice_profile_key": None,
    "voice_locked": 0,
    "voice_design_json": None,
    "reference_image_url": None,
    "reference_audio_url": None,
    "status": "draft",
}
SCENE_ROW = {
    "id": 3,
    "episode_no": 1,
    "scene_no": 1,
    "title": "深夜监控室",
    "summary": "林知夏核对离职协议。",
    "content": "【深夜 监控室】林知夏转身看向屏幕。",
    "location": None,
    "time_of_day": None,
    "spatial_anchors_json": json.dumps(_FIXTURE_MANIFEST, ensure_ascii=False),
}
NODE_ROW = {
    "id": NODE_ID,
    "project_id": PROJECT_ID,
    "node_type": "character",
    "ref_id": 9,
    "label": "林知夏",
    "appearance_label": None,
    "prompt_text": "固定外貌：28 岁女性，短发瓜子脸。",
    "turnaround_prompt_text": "",
    "environment_prompt_text": "",
    "negative_prompt": "",
    "x": 10,
    "y": 20,
    "width": 220,
    "height": 260,
    "group_key": "character:9",
    "status": "active",
    "character_identity_lock_json": None,
    "ownerId": USER_ID,
    "project_visual_style": "冷蓝色调科幻风",
    "project_category": "都市悬疑",
}
IMAGE_ROW = {
    "id": IMAGE_ID,
    "asset_node_id": NODE_ID,
    "version_no": 3,
    "image_url": "https://media.example.com/char.png",
    "storage_key": None,
    "thumbnail_url": None,
    "prompt_snapshot": "完整角色资产板 快照",
    "model_name": "agnes-image-2.1-flash",
    "view_set_type": "character-asset-pack",
    "view_set_version": 2,
    "view_index": None,
    "view_key": None,
    "view_label": None,
    "source_image_id": None,
    "source_image_url": None,
    "crop_json": None,
    "character_identity_lock_json": None,
    "identity_status": "passed",
    "identity_reason": None,
    "identity_similarity_score": 0.87,
    "wardrobe_consistency_score": 0.91,
    "vision_status": "passed",
    "vision_reason": None,
    "vision_checked_at": None,
    "status": "candidate",
    "confirmed_at": None,
    "created_at": "2026-10-17T09:00:00",
}


class AssetCanvasDatabase:
    """资产画布/项目删除/导出包端点测试的最小数据库桩。

    :ivar projects: project_id -> 行。
    :ivar asset_nodes: node_id -> 行。
    :ivar asset_node_images: image_id -> 行。
    :ivar generation_jobs: job_id -> 任务行（幂等复用语义与 MySQL 实现一致）。
    :ivar scenes / characters: 项目场景与角色行。
    :ivar archived_node_ids / superseded_calls: 副作用记录。
    """

    def __init__(self):
        self.projects = {
            PROJECT_ID: {"id": PROJECT_ID, "user_id": USER_ID, "name": "死讯服务器", "visual_style": "冷蓝色调科幻风", "category": "都市悬疑"}
        }
        self.scenes = {PROJECT_ID: [dict(SCENE_ROW)]}
        self.characters = {PROJECT_ID: [dict(CHARACTER_ROW)]}
        self.asset_nodes: dict[int, dict] = {NODE_ID: dict(NODE_ROW)}
        self.asset_node_images: dict[int, dict] = {IMAGE_ID: dict(IMAGE_ROW)}
        self.generation_jobs: dict[int, dict] = {}
        self.next_node_id = 100
        self.next_image_id = 500
        self.next_job_id = 700
        self.archived_node_ids: list[int] = []
        self.identity_locks: list[tuple[int, str]] = []
        self.deleted_project_ids: list[int] = []
        self.export_rows = []
        self.final_edit_draft = None
        self.scene_nine_grid_batches = 0
        self.scene_anchor_updates: list[tuple[int, int, int, str]] = []

    # -- 鉴权 ---------------------------------------------------------------

    def find_user_by_token(self, token):
        """按 token 反查用户。"""
        if token == "session-token":
            return {"id": USER_ID, "phone": "13912345678", "nickname": "测试用户"}
        return None

    # -- 项目 ---------------------------------------------------------------

    def get_project(self, project_id, user_id):
        """项目归属读取。"""
        project = self.projects.get(project_id)
        if project is None or int(project["user_id"]) != int(user_id):
            return None
        return dict(project)

    def fetch_project_by_id(self, project_id):
        """无归属项目读取。"""
        project = self.projects.get(project_id)
        return dict(project) if project else None

    def delete_project_txn(self, project_id, user_id):
        """项目删除事务（归属条件）。"""
        project = self.projects.get(project_id)
        if project is None or int(project["user_id"]) != int(user_id):
            return False
        del self.projects[project_id]
        self.deleted_project_ids.append(project_id)
        return True

    # -- 画布节点 -----------------------------------------------------------

    def list_asset_canvas_nodes(self, project_id):
        """画布节点（附 image_count）。"""
        rows = []
        for node in self.asset_nodes.values():
            if node["project_id"] != project_id or node.get("status") == "archived":
                continue
            row = dict(node)
            row["image_count"] = sum(
                1 for image in self.asset_node_images.values() if image["asset_node_id"] == node["id"]
            )
            rows.append(row)
        rows.sort(key=lambda row: row["id"])
        return rows

    def archive_asset_nodes(self, project_id, node_ids):
        """批量归档节点。"""
        for node_id in node_ids:
            node = self.asset_nodes.get(node_id)
            if node and node["project_id"] == project_id:
                node["status"] = "archived"
                self.archived_node_ids.append(node_id)

    def archive_asset_node(self, node_id):
        """软删单节点。"""
        self.archive_asset_nodes(self.asset_nodes[node_id]["project_id"], [node_id])

    def get_asset_node_full(self, node_id):
        """节点归属行。"""
        node = self.asset_nodes.get(node_id)
        if node is None or node.get("status") == "archived":
            return None
        row = dict(node)
        project = self.projects.get(node["project_id"], {})
        row["ownerId"] = project.get("user_id")
        row["project_visual_style"] = project.get("visual_style")
        row["project_category"] = project.get("category")
        return row

    def get_asset_node_raw(self, node_id):
        """节点原始行。"""
        node = self.asset_nodes.get(node_id)
        return dict(node) if node else None

    def update_asset_node_fields(self, node_id, assignments):
        """白名单列更新并回读。"""
        node = self.asset_nodes.get(node_id)
        if node is None:
            return None
        node.update(assignments)
        return dict(node)

    def update_scene_spatial_anchors(self, scene_id, project_id, user_id, manifest_json):
        """场景空间锚点写入（归属校验）。"""
        self.scene_anchor_updates.append((scene_id, project_id, user_id, manifest_json))
        for scene in self.scenes.get(project_id, []):
            if int(scene["id"]) == int(scene_id):
                scene["spatial_anchors_json"] = manifest_json
                return True
        return False

    def create_asset_node(self, project_id, payload):
        """创建节点并回读。"""
        self.next_node_id += 1
        node = {
            "id": self.next_node_id,
            "project_id": project_id,
            "node_type": payload["nodeType"],
            "ref_id": payload.get("refId"),
            "label": payload["label"],
            "appearance_label": payload.get("appearanceLabel"),
            "prompt_text": payload.get("promptText"),
            "turnaround_prompt_text": payload.get("turnaroundPromptText"),
            "environment_prompt_text": payload.get("environmentPromptText"),
            "negative_prompt": payload.get("negativePrompt"),
            "x": payload.get("x"),
            "y": payload.get("y"),
            "width": payload.get("width"),
            "height": payload.get("height"),
            "group_key": payload.get("groupKey"),
            "status": "active",
            "character_identity_lock_json": None,
        }
        self.asset_nodes[node["id"]] = node
        return dict(node)

    def list_asset_node_images(self, node_id):
        """单节点形象行。"""
        rows = [image for image in self.asset_node_images.values() if image["asset_node_id"] == node_id]
        rows.sort(key=lambda row: row["id"])
        return [dict(row) for row in rows]

    def list_asset_node_images_by_nodes(self, node_ids):
        """多节点形象行。"""
        rows = [image for image in self.asset_node_images.values() if image["asset_node_id"] in node_ids]
        rows.sort(key=lambda row: row["id"])
        return [dict(row) for row in rows]

    def get_asset_node_image(self, image_id):
        """形象原始行。"""
        image = self.asset_node_images.get(image_id)
        return dict(image) if image else None

    def get_asset_node_image_full(self, image_id):
        """形象归属行（confirm/vision 联查）。"""
        image = self.asset_node_images.get(image_id)
        if image is None:
            return None
        node = self.asset_nodes.get(image["asset_node_id"])
        if node is None:
            return None
        row = dict(image)
        row["project_id"] = node["project_id"]
        row["node_type"] = node["node_type"]
        row["ref_id"] = node.get("ref_id")
        row["label"] = node.get("label")
        row["node_status"] = node.get("status")
        row["character_identity_lock_json"] = node.get("character_identity_lock_json")
        row["ownerId"] = self.projects.get(node["project_id"], {}).get("user_id")
        return row

    def update_asset_node_image_fields(self, image_id, assignments):
        """形象列更新并回读。"""
        image = self.asset_node_images.get(image_id)
        if image is None:
            return None
        image.update(assignments)
        return dict(image)

    def save_character_identity_lock(self, node_id, image_id, snapshot_json):
        """身份锁写入记录。"""
        self.identity_locks.append((node_id, snapshot_json))
        self.asset_nodes[node_id]["character_identity_lock_json"] = snapshot_json
        self.asset_node_images[image_id]["character_identity_lock_json"] = snapshot_json

    def supersede_confirmed_single_images(self, node_id, keep_image_id):
        """single 旧确认降级。"""
        for image in self.asset_node_images.values():
            if (
                image["asset_node_id"] == node_id
                and image.get("view_set_type") == "single"
                and image.get("status") == "confirmed"
                and image["id"] != keep_image_id
            ):
                image["status"] = "superseded"

    def supersede_asset_node_images(self, *, node_id, keep_image_id, view_set_types, view_key=None, source_image_id=None, exclude_matching_source=False):
        """同视角 superseded（参数语义与 MySQL 实现一致）。"""
        for image in self.asset_node_images.values():
            if image["asset_node_id"] != node_id or image["id"] == keep_image_id:
                continue
            if image.get("view_set_type") not in view_set_types:
                continue
            if view_key is not None and image.get("view_key") != view_key:
                continue
            if source_image_id is not None:
                if exclude_matching_source and image.get("source_image_id") == source_image_id:
                    continue
                if not exclude_matching_source and image.get("source_image_id") != source_image_id:
                    continue
            if image.get("status") in ("candidate", "confirmed"):
                image["status"] = "superseded"

    def list_passed_single_prop_images(self, node_ids):
        """道具/素材已通过单视角图。"""
        return [
            image["id"]
            for image in self.asset_node_images.values()
            if image["asset_node_id"] in node_ids
            and image.get("view_set_type") == "single"
            and image.get("status") == "candidate"
            and image.get("vision_status") == "passed"
        ]

    def commit_asset_adoption_txn(self, candidate_ids, node_type, asset_node_id, view_type=None):
        """采纳事务（单图/板计划化语义简化覆盖测试路径）。"""
        adopted = False
        for image_id in candidate_ids:
            image = self.asset_node_images.get(image_id)
            if image is None or image["asset_node_id"] != asset_node_id:
                continue
            if image.get("vision_status") != "passed":
                return False
            for other in self.asset_node_images.values():
                if other["asset_node_id"] == asset_node_id and other["id"] != image_id and other.get("status") in ("candidate", "confirmed"):
                    other["status"] = "superseded"
            image["status"] = "confirmed"
            adopted = True
        return adopted

    def next_asset_node_image_version(self, node_id):
        """下一版本号。"""
        versions = [
            int(image.get("version_no") or 0)
            for image in self.asset_node_images.values()
            if image["asset_node_id"] == node_id
        ]
        return max(versions, default=0) + 1

    def count_scene_nine_grid_complete_batches(self, node_id, panorama_image_id):
        """九宫格完整批次计数。"""
        return self.scene_nine_grid_batches

    # -- 场景 / 角色 ---------------------------------------------------------

    def list_project_scene_rows(self, project_id, with_anchors=False):
        """项目场景行。"""
        return [dict(row) for row in self.scenes.get(project_id, [])]

    def list_project_character_rows(self, project_id):
        """项目角色行。"""
        return [dict(row) for row in self.characters.get(project_id, [])]

    def list_project_character_names(self, project_id):
        """项目角色名列表。"""
        return [row["name"] for row in self.characters.get(project_id, []) if row.get("name")]

    def list_project_characters(self, project_id):
        """项目角色列表（未归档）。"""
        return [dict(row) for row in self.characters.get(project_id, []) if row.get("status") != "archived"]

    def list_active_voice_profiles(self):
        """系统音色目录。"""
        return [
            {
                "profile_key": "female-young-warm",
                "display_name": "亲切青年女声",
                "provider": "dashscope",
                "model_name": "qwen3-tts-flash",
                "voice_id": "Cherry",
                "gender": "female",
                "age_groups": "young_adult",
                "style_tags": "阳光,亲切,自然",
                "description": "适合 19-35 岁青年女性。",
                "instructions": "",
                "language_type": "Chinese",
                "status": "active",
                "sort_order": 90,
            }
        ]

    # -- 导出包 / 草稿 -------------------------------------------------------

    def export_package_rows(self, project_id, episode_no=None):
        """导出包主查询行。"""
        return [
            dict(row) for row in self.export_rows
            if episode_no is None or row.get("episode_no") == episode_no
        ]

    def fetch_final_edit_draft(self, project_id):
        """成片草稿行。"""
        return self.final_edit_draft

    # -- 生成任务 -----------------------------------------------------------

    def create_generation_job(self, project_id, job_type, source_id, request):
        """创建/复用生成任务（同 project+type+source 活动任务幂等复用）。"""
        request_snapshot = {**(request or {}), "projectId": int(project_id)}
        for job in self.generation_jobs.values():
            if (
                job["project_id"] == project_id
                and job["job_type"] == job_type
                and job["source_id"] == source_id
                and job["status"] in ("queued", "running")
            ):
                return job
        self.next_job_id += 1
        import uuid as _uuid

        job = {
            "id": self.next_job_id,
            "job_key": f"{job_type}-{source_id}-{_uuid.uuid4()}",
            "project_id": project_id,
            "job_type": job_type,
            "source_id": source_id,
            "user_id": USER_ID,
            "status": "queued",
            "progress_percent": 0,
            "request_json": json.dumps(request_snapshot, ensure_ascii=False),
            "result_json": None,
            "error_text": None,
            "created_at": "2026-10-18T09:00:00",
            "updated_at": "2026-10-18T09:00:00",
        }
        self.generation_jobs[job["id"]] = job
        return dict(job)


def make_client(database=None, object_storage_root="object-storage", **settings_kwargs):
    """构建原生模式测试客户端（upstream 不可达，触达即失败）。"""
    settings = Settings(
        _env_file=None,
        object_storage_root=object_storage_root,
        **settings_kwargs,
    )
    return TestClient(create_app(settings, database=database or AssetCanvasDatabase()), raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/projects/8/asset-canvas"),
        ("post", "/api/projects/8/asset-nodes"),
        ("get", "/api/projects/8/workflow-readiness"),
        ("post", "/api/projects/8/workflow-readiness/parse-complete"),
        ("patch", "/api/asset-nodes/31"),
        ("delete", "/api/asset-nodes/31"),
        ("post", "/api/asset-nodes/31/relink-scene"),
        ("post", "/api/asset-nodes/31/hydrate-prompt"),
        ("get", "/api/asset-nodes/31/images"),
        ("post", "/api/asset-nodes/31/images/generate"),
        ("post", "/api/asset-node-images/31/confirm"),
        ("post", "/api/asset-node-images/31/vision-check"),
        ("delete", "/api/projects/8"),
        ("get", "/api/projects/8/export-package"),
    ],
)
def test_asset_canvas_routes_require_authentication(method, path):
    """未登录：新路由统一 401/4010 envelope。"""
    response = client_method(make_client(), method)(path, json={})
    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


def client_method(client: TestClient, method: str):
    """按方法名取 TestClient 请求函数（统一走 request，避免 get/delete 不收 json）。"""
    return lambda path, **kwargs: client.request(method.upper(), path, **kwargs)


def test_asset_canvas_routes_hide_foreign_resources():
    """越权：画布/节点/形象/项目删除均 404/4004（owner 隔离）。"""
    database = AssetCanvasDatabase()
    database.projects[PROJECT_ID]["user_id"] = OTHER_USER_ID
    client = make_client(database)
    assert client.get(f"/api/projects/{PROJECT_ID}/asset-canvas", headers=AUTH).status_code == 404
    assert client.patch(f"/api/asset-nodes/{NODE_ID}", json={"label": "x"}, headers=AUTH).status_code == 404
    assert client.get(f"/api/asset-nodes/{NODE_ID}/images", headers=AUTH).status_code == 404
    assert client.request("DELETE", f"/api/projects/{PROJECT_ID}", json={"confirmName": "死讯服务器"}, headers=AUTH).status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/asset-nodes/abc/images"),
        ("post", "/api/asset-node-images/abc/confirm"),
        ("get", "/api/projects/abc/export-package"),
    ],
)
def test_asset_canvas_routes_non_integer_id_falls_back_to_4040(method, path):
    """非整数 id：Node ``\\d+`` 不匹配 → 兜底 404/4040。"""
    response = client_method(make_client(), method)(path, headers=AUTH)
    assert response.status_code == 404
    assert response.json() == {"code": 4040, "message": "接口不存在", "data": None}


# ---------------------------------------------------------------------------
# asset-canvas 画布视图
# ---------------------------------------------------------------------------


def test_asset_canvas_returns_nodes_images_groups_summary():
    """画布 GET：节点 DTO（layout 归一/状态派生）+ 分组 + 汇总。"""
    client = make_client()

    response = client.get(f"/api/projects/{PROJECT_ID}/asset-canvas", headers=AUTH)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["projectId"] == PROJECT_ID
    node = data["nodes"][0]
    assert node["id"] == NODE_ID
    assert node["nodeType"] == "character"
    assert node["state"] == "ready"  # 形象 candidate + passed
    assert node["width"] == 220 and node["height"] == 260  # 999/0 钳制
    assert node["confirmedImage"] is None
    assert node["images"][0]["imageUrl"] == "https://media.example.com/char.png"
    assert data["summary"]["byType"] == {"character": 1, "scene": 0, "prop": 0, "material": 0}
    assert data["groups"][0]["key"] == "character:9"
    assert data["groups"][0]["bounds"]["x"] == 10 - 26


def test_asset_canvas_archives_legacy_scene_shell_and_duplicates():
    """读时自愈：旧场景壳（无环境提示词 + 旧 label）与重复节点归档。"""
    database = AssetCanvasDatabase()
    legacy_shell = {
        **NODE_ROW,
        "id": 30,
        "node_type": "scene",
        "ref_id": 3,
        "label": "场景：时间未明确",
        "environment_prompt_text": "",
        "group_key": None,
        "prompt_text": "旧提示词",
    }
    duplicate = {**NODE_ROW, "id": 31, "node_type": "character", "ref_id": 9, "label": "林知夏", "group_key": "character:9"}
    database.asset_nodes[30] = legacy_shell
    database.asset_nodes[31] = duplicate
    client = make_client(database)

    response = client.get(f"/api/projects/{PROJECT_ID}/asset-canvas", headers=AUTH)

    assert response.status_code == 200
    assert sorted(database.archived_node_ids) == [30, 31]
    node_ids = [node["id"] for node in response.json()["data"]["nodes"]]
    assert NODE_ID in node_ids and 30 not in node_ids and 31 not in node_ids


def test_asset_canvas_refreshes_scene_prompt_and_label():
    """读时自愈：场景节点每次读取重绑 ref/group/提示词并刷新 label。"""
    database = AssetCanvasDatabase()
    scene_node = {
        **NODE_ROW,
        "id": 41,
        "node_type": "scene",
        "ref_id": None,
        "label": "场景01",
        "prompt_text": "",
        "environment_prompt_text": "",
        "group_key": None,
        "appearance_label": "未明确",
    }
    database.asset_nodes[41] = scene_node
    client = make_client(database)

    response = client.get(f"/api/projects/{PROJECT_ID}/asset-canvas", headers=AUTH)

    assert response.status_code == 200
    refreshed = database.asset_nodes[41]
    assert refreshed["ref_id"] == 3
    assert refreshed["group_key"] == "scene:3:default"
    assert refreshed["prompt_text"].startswith("提示词模板技能：")
    assert "场景：深夜监控室" in refreshed["prompt_text"]
    assert refreshed["label"].startswith("场景01 · ")
    assert "未明确" not in (refreshed["appearance_label"] or "")


def test_asset_canvas_prop_passed_single_image_auto_adopts():
    """读时自愈：道具 single 通过视觉检查 → 自动采用。"""
    database = AssetCanvasDatabase()
    prop_node = {**NODE_ROW, "id": 50, "node_type": "prop", "ref_id": None, "label": "工牌", "group_key": "prop:50"}
    prop_image = {
        **IMAGE_ROW,
        "id": 501,
        "asset_node_id": 50,
        "view_set_type": "single",
        "status": "candidate",
        "vision_status": "passed",
        "view_set_version": 1,
        "version_no": 1,
    }
    database.asset_nodes[50] = prop_node
    database.asset_node_images[501] = prop_image
    client = make_client(database)

    client.get(f"/api/projects/{PROJECT_ID}/asset-canvas", headers=AUTH)

    assert database.asset_node_images[501]["status"] == "confirmed"


def test_create_asset_node_character_auto_prompt():
    """创建角色节点：自动生成提示词/三视图提示词/负面词。"""
    client = make_client()

    response = client.post(
        f"/api/projects/{PROJECT_ID}/asset-nodes",
        json={"nodeType": "character", "refId": 9, "x": 5},
        headers=AUTH,
    )

    assert response.status_code == 200
    node = response.json()["data"]
    assert node["label"] == "林知夏"
    assert node["promptText"].startswith("提示词模板技能：")
    assert node["turnaroundPromptText"].startswith("任务类型：角色三视图专用资产生成。")
    assert node["negativePrompt"] == ap.NEGATIVE_PROMPT
    assert node["refId"] == 9


def test_create_asset_node_scene_auto_prompt_and_label():
    """创建场景节点：label 兜底 buildSceneDisplayLabel + 场景/环境双层提示词。"""
    client = make_client()

    response = client.post(
        f"/api/projects/{PROJECT_ID}/asset-nodes",
        json={"nodeType": "scene", "refId": 3},
        headers=AUTH,
    )

    assert response.status_code == 200
    node = response.json()["data"]
    assert node["label"].startswith("场景01 · ")
    assert node["promptText"].startswith("提示词模板技能：")
    assert node["environmentPromptText"].startswith("提示词模板技能：")


def test_create_asset_node_invalid_type_and_missing_label():
    """创建节点：非法类型 4001 / 无名称 4001。"""
    client = make_client()
    invalid = client.post(f"/api/projects/{PROJECT_ID}/asset-nodes", json={"nodeType": "tool"}, headers=AUTH)
    missing = client.post(f"/api/projects/{PROJECT_ID}/asset-nodes", json={"nodeType": "prop"}, headers=AUTH)
    assert invalid.status_code == 400
    assert invalid.json() == {"code": 4001, "message": "无效的节点类型，只支持 character / scene / prop / material", "data": None}
    assert missing.status_code == 400
    assert missing.json()["message"] == "请填写节点名称"


def test_create_asset_node_character_ref_not_found():
    """创建角色节点：refId 不属于项目 → 404/4004。"""
    client = make_client()
    response = client.post(
        f"/api/projects/{PROJECT_ID}/asset-nodes", json={"nodeType": "character", "refId": 12345}, headers=AUTH
    )
    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "角色不存在或不属于该项目", "data": None}


def test_patch_asset_node_whitelist_and_validation():
    """PATCH：白名单更新 + 空 label 4001 + 无字段 4001 + 布局钳制。"""
    client = make_client()
    ok = client.patch(
        f"/api/asset-nodes/{NODE_ID}",
        json={"label": " 林知夏·变体 ", "x": 1.234, "width": 9999, "groupKey": " 场景 "},
        headers=AUTH,
    )
    assert ok.status_code == 200
    node = ok.json()["data"]
    assert node["label"] == "林知夏·变体"
    assert node["groupKey"] == "场景"
    assert node["width"] == 640  # 越界钳制
    empty_label = client.patch(f"/api/asset-nodes/{NODE_ID}", json={"label": "  "}, headers=AUTH)
    assert empty_label.status_code == 400
    assert empty_label.json()["message"] == "节点名称不能为空"
    no_fields = client.patch(f"/api/asset-nodes/{NODE_ID}", json={}, headers=AUTH)
    assert no_fields.status_code == 400
    assert no_fields.json()["message"] == "没有可更新的字段"


def test_delete_asset_node_soft_archive():
    """DELETE：软删（status=archived）+ message 对齐。"""
    client = make_client()
    response = client.delete(f"/api/asset-nodes/{NODE_ID}", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "画布节点已移除", "data": {"success": True}}
    assert client.get(f"/api/asset-nodes/{NODE_ID}/images", headers=AUTH).status_code == 404


def test_relink_scene_requires_scene_node():
    """relink：非场景节点 4001。"""
    client = make_client()
    response = client.post(f"/api/asset-nodes/{NODE_ID}/relink-scene", json={"sceneId": 3}, headers=AUTH)
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "只有场景节点可以重新关联剧本场景", "data": None}


def test_relink_scene_success_and_not_found():
    """relink：按 id 重绑成功（提示词/label/group 全刷新）；无效输入 404。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = None
    client = make_client(database)
    ok = client.post(f"/api/asset-nodes/{NODE_ID}/relink-scene", json={"sceneId": 3}, headers=AUTH)
    assert ok.status_code == 200
    node = ok.json()["data"]
    assert node["refId"] == 3
    assert node["groupKey"] == "scene:3:default"
    assert node["promptText"].startswith("提示词模板技能：")
    missing = client.post(f"/api/asset-nodes/{NODE_ID}/relink-scene", json={"sceneId": 999}, headers=AUTH)
    assert missing.status_code == 404
    assert missing.json()["message"] == "没有找到可关联的剧本场景，请提供有效 sceneId 或场景名称"


def test_hydrate_prompt_character_and_scene():
    """hydrate：场景补环境层；角色补三视图/负面词；非法类型 4001。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = 3
    client = make_client(database)
    scene_ok = client.post(f"/api/asset-nodes/{NODE_ID}/hydrate-prompt", json={}, headers=AUTH)
    assert scene_ok.status_code == 200
    assert scene_ok.json()["message"] == "场景详细提示词已补齐并保存"
    assert scene_ok.json()["data"]["environmentPromptText"].startswith("提示词模板技能：")

    client2 = make_client()
    character_ok = client2.post(f"/api/asset-nodes/{NODE_ID}/hydrate-prompt", json={}, headers=AUTH)
    assert character_ok.status_code == 200
    assert character_ok.json()["message"] == "角色详细提示词已补齐并保存"
    assert character_ok.json()["data"]["turnaroundPromptText"].startswith("任务类型：角色三视图专用资产生成。")

    prop_node = AssetCanvasDatabase()
    prop_node.asset_nodes[NODE_ID]["node_type"] = "prop"
    prop_node.asset_nodes[NODE_ID]["ref_id"] = None
    invalid = make_client(prop_node).post(f"/api/asset-nodes/{NODE_ID}/hydrate-prompt", json={}, headers=AUTH)
    assert invalid.status_code == 400
    assert invalid.json()["message"] == "只有关联剧本场景或角色的节点可以自动补齐提示词"


# ---------------------------------------------------------------------------
# asset-node images generate（入队）
# ---------------------------------------------------------------------------


def test_asset_node_generate_character_pack_enqueue_and_idempotent():
    """角色资产板入队：快照字段 + 4011 无 + 幂等复用。"""
    database = AssetCanvasDatabase()
    client = make_client(database)

    first = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={"viewType": "character-asset-pack"}, headers=AUTH)
    second = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={}, headers=AUTH)

    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["message"] == "画布节点形象生成任务已提交"
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    assert len(database.generation_jobs) == 1
    stored = database.generation_jobs[first.json()["data"]["id"]]
    snapshot = json.loads(stored["request_json"])
    assert snapshot["assetNodeId"] == NODE_ID
    assert snapshot["nodeType"] == "character"
    assert snapshot["viewType"] == "character-asset-pack"
    assert snapshot["assetPackEnabled"] is True
    assert snapshot["imageRatio"] == "16:9"
    assert snapshot["prompt"].startswith("任务类型：同一角色资产包基准板（完整角色资产板）")
    assert "角色节点原始约束（只补充外貌事实，不改变资产板布局）：" in snapshot["prompt"]
    assert snapshot["promptSnapshot"] == snapshot["prompt"]
    assert re.fullmatch(r"asset_node_image-12-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", stored["job_key"])


def test_asset_node_generate_character_rejects_turnaround_view():
    """角色节点请求独立三视图 → 409/4011（CHARACTER_ASSET_PACK_REQUIRED 语义）。"""
    client = make_client()
    response = client.post(
        f"/api/asset-nodes/{NODE_ID}/images/generate", json={"viewType": "character-turnaround", "viewKey": "front"}, headers=AUTH
    )
    assert response.status_code == 409
    assert response.json() == {
        "code": 4011,
        "message": "角色资产统一生成完整资产板；独立脸部特写和三视图链路已停用",
        "data": None,
    }


def test_asset_node_generate_prop_rejects_turnaround_view():
    """道具节点请求多视角 → 409/4011（PROP_SINGLE_IMAGE_REQUIRED 语义）。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "prop"
    client = make_client(database)
    response = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={"viewType": "prop-turnaround"}, headers=AUTH)
    assert response.status_code == 409
    assert response.json() == {
        "code": 4011,
        "message": "道具资产统一使用完整单图；独立多视角链路已停用",
        "data": None,
    }


def test_asset_node_generate_scene_extracts_missing_spatial_anchors(monkeypatch):
    """场景全景入队：锚点缺失时先走剧本 Agent 提取并持久化，再入队（Node 同语义）。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = 3
    database.scenes[PROJECT_ID][0]["spatial_anchors_json"] = None

    async def fake_anchor_agent(scene, *, client, repair_reason="", config=None):
        assert scene["id"] == 3
        return _FIXTURE_MANIFEST

    import app.main as main_module

    monkeypatch.setattr(main_module, "ai_generate_scene_space_anchors", fake_anchor_agent)
    client = make_client(database)
    response = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={}, headers=AUTH)

    assert response.status_code == 200
    assert response.json()["message"] == "画布节点形象生成任务已提交"
    assert len(database.scene_anchor_updates) == 1
    scene_id, project_id, user_id, manifest_json = database.scene_anchor_updates[0]
    assert (scene_id, project_id, user_id) == (3, PROJECT_ID, USER_ID)
    assert json.loads(manifest_json) == _FIXTURE_MANIFEST
    assert len(database.generation_jobs) == 1


def test_asset_node_generate_scene_single_uses_environment_prompt():
    """场景 single 入队：环境层每次刷新（Node 同语义）+ 锚点入快照。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = 3
    database.asset_nodes[NODE_ID]["prompt_text"] = "剧本层提示词"
    database.asset_nodes[NODE_ID]["environment_prompt_text"] = "环境层提示词"
    client = make_client(database)
    response = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={}, headers=AUTH)
    assert response.status_code == 200
    snapshot = json.loads(database.generation_jobs[response.json()["data"]["id"]]["request_json"])
    assert snapshot["viewType"] == "single"
    # Node enqueueAssetNodeImageJob 每次场景生成都从绑定场景重建环境层提示词；
    # 入队 prompt = 环境层 + 场景锁 + 收尾行（build_asset_node_generation_prompt 拼接）。
    assert snapshot["prompt"].startswith("提示词模板技能：")
    assert "环境资产场景：深夜监控室" in snapshot["prompt"]
    assert database.asset_nodes[NODE_ID]["environment_prompt_text"] in snapshot["prompt"]
    assert snapshot["prompt"].endswith("画面清晰，构图完整，无文字水印")
    assert snapshot["imageRatio"] is None
    assert snapshot["sceneSpatialAnchors"]["version"] == 1


def test_asset_node_generate_invalid_nine_grid_view():
    """九宫格非法视角键 → 400/4011。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = 3
    client = make_client(database)
    response = client.post(
        f"/api/asset-nodes/{NODE_ID}/images/generate", json={"viewType": "scene-nine-grid", "viewKey": "diagonal"}, headers=AUTH
    )
    assert response.status_code == 400
    assert response.json() == {"code": 4011, "message": "无效的场景九宫格视角：diagonal", "data": None}


def test_asset_node_generate_nine_grid_requires_panorama():
    """九宫格无已确认全景 → 409/4011（SCENE_PANORAMA_REQUIRED 语义）。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    database.asset_nodes[NODE_ID]["ref_id"] = 3
    client = make_client(database)
    response = client.post(f"/api/asset-nodes/{NODE_ID}/images/generate", json={"viewType": "scene-nine-grid"}, headers=AUTH)
    assert response.status_code == 409
    assert response.json() == {
        "code": 4011,
        "message": "请先确认场景全景基准图，再生成九个独立场景视角",
        "data": None,
    }


# ---------------------------------------------------------------------------
# asset-node-images confirm / vision-check
# ---------------------------------------------------------------------------


def test_confirm_pack_success_supersedes_legacy_and_writes_identity_lock():
    """资产板确认：旧拆分图降级 + 身份锁写入（角色节点）+ DTO 返回。"""
    database = AssetCanvasDatabase()
    legacy_single = {
        **IMAGE_ROW,
        "id": 106,
        "view_set_type": "single",
        "view_set_version": 1,
        "status": "confirmed",
        "vision_status": "passed",
    }
    database.asset_node_images[106] = legacy_single
    client = make_client(database)

    response = client.post(f"/api/asset-node-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)

    assert response.status_code == 200
    assert response.json()["message"] == "形象已采用"
    assert response.json()["data"]["status"] == "confirmed"
    assert database.asset_node_images[IMAGE_ID]["status"] == "confirmed"
    assert database.asset_node_images[106]["status"] == "superseded"
    assert len(database.identity_locks) == 1
    lock = json.loads(database.identity_locks[0][1])
    assert lock["schemaVersion"] == 1
    assert lock["identityMode"] == "multi-reference-visual-lock"
    assert lock["name"] == "林知夏"
    assert lock["baseImageId"] == IMAGE_ID


def test_confirm_rejects_vision_pending_and_superseded():
    """确认门禁：未过视觉检查 409 / superseded 409（Node 同文案）。"""
    database = AssetCanvasDatabase()
    database.asset_node_images[IMAGE_ID]["vision_status"] = "pending"
    client = make_client(database)
    pending = client.post(f"/api/asset-node-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)
    assert pending.status_code == 409
    assert pending.json()["message"] == "角色资产板尚未完成视觉检查，请稍后重试"

    database.asset_node_images[IMAGE_ID]["vision_status"] = "passed"
    database.asset_node_images[IMAGE_ID]["status"] = "superseded"
    superseded = client.post(f"/api/asset-node-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)
    assert superseded.status_code == 409
    assert superseded.json()["message"] == "该图片已被新资产替代，不能重新检查"


def test_confirm_rejects_legacy_character_split_image():
    """角色节点旧拆分图（single 无板标记）→ 409/4004 引导走资产板。"""
    database = AssetCanvasDatabase()
    database.asset_node_images[IMAGE_ID].update(
        {"view_set_type": "single", "view_label": "正面", "prompt_snapshot": "普通正面图", "status": "candidate", "vision_status": "passed"}
    )
    client = make_client(database)
    response = client.post(f"/api/asset-node-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)
    assert response.status_code == 409
    assert response.json()["message"] == "角色资产板通过整体视觉检查后会自动采用，无需单独确认旧版拆分图片"


def test_confirm_legacy_board_label_promotes_view_set():
    """旧 single 板（label=角色资产板）→ 视图层升级后允许确认。"""
    database = AssetCanvasDatabase()
    database.asset_node_images[IMAGE_ID].update({"view_set_type": "single", "view_label": "角色资产板", "status": "candidate", "vision_status": "passed"})
    client = make_client(database)
    response = client.post(f"/api/asset-node-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)
    assert response.status_code == 200
    assert database.asset_node_images[IMAGE_ID]["view_set_type"] == "character-asset-pack"


def test_vision_check_scene_goes_skipped():
    """场景 vision-check：SCENE_VISION_CHECK_ENABLED=false → skipped 人工确认通道。"""
    database = AssetCanvasDatabase()
    database.asset_nodes[NODE_ID]["node_type"] = "scene"
    response = make_client(database).post(f"/api/asset-node-images/{IMAGE_ID}/vision-check", json={}, headers=AUTH)
    assert response.status_code == 200
    assert response.json()["message"] == "场景视觉检查未运行，请按全景基准人工确认"
    assert response.json()["data"]["visionStatus"] == "skipped"


def test_vision_check_mock_provider_skips_real_model(monkeypatch):
    """mock 文本模型：vision-check 直接通过（Node isMockProvider 同分支）。"""
    monkeypatch.setenv("AI_PROVIDER", "mock")
    client = make_client()
    response = client.post(f"/api/asset-node-images/{IMAGE_ID}/vision-check", json={}, headers=AUTH)
    assert response.status_code == 200
    assert response.json()["data"]["visionStatus"] == "passed"
    assert response.json()["data"]["status"] == "confirmed"  # 资产板通过自动采用


def test_vision_check_unconfigured_vision_model_pending(monkeypatch):
    """未配置 VISION_API_KEY：pending 等待视觉检查（资产板不做身份一致性检查）。"""
    monkeypatch.setenv("AI_PROVIDER", "openai-compatible")
    monkeypatch.delenv("VISION_API_KEY", raising=False)
    client = make_client()
    response = client.post(f"/api/asset-node-images/{IMAGE_ID}/vision-check", json={}, headers=AUTH)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["visionStatus"] == "pending"
    # Node L14358：身份一致性检查只针对 character-turnaround / character-face-closeup；
    # 角色资产板的 identity_status 保持 not_checked。
    assert data["identityStatus"] == "not_checked"


def test_vision_check_superseded_rejected():
    """superseded 图不可再检查 → 409/4004。"""
    database = AssetCanvasDatabase()
    database.asset_node_images[IMAGE_ID]["status"] = "superseded"
    response = make_client(database).post(f"/api/asset-node-images/{IMAGE_ID}/vision-check", json={}, headers=AUTH)
    assert response.status_code == 409
    assert response.json()["message"] == "该图片已被新资产替代，不能重新检查"


# ---------------------------------------------------------------------------
# export-package / 项目删除
# ---------------------------------------------------------------------------


def _seed_export_rows(database: AssetCanvasDatabase) -> None:
    """导出包测试行（场景 1 两镜：一镜 ready、一镜 static-ready；场景 2 无分镜）。"""
    database.export_rows = [
        {
            "scene_id": 3, "scene_no": 1, "scene_title": "深夜监控室", "storyboard_id": 21,
            "shot_no": 1, "shot_type": "中景", "dialogue_text": "（无对白）",
            "storyboard_duration_seconds": 5, "image_url": "http://127.0.0.1:8000/generated/frame/a.png",
            "video_url": None, "confirmed_video_asset_id": 55,
            "confirmed_video_url": "http://127.0.0.1:8000/generated/video/a.mp4",
            "confirmed_thumbnail_url": None, "confirmed_video_duration_seconds": 6,
        },
        {
            "scene_id": 3, "scene_no": 1, "scene_title": "深夜监控室", "storyboard_id": 22,
            "shot_no": 2, "shot_type": "近景", "dialogue_text": None,
            "storyboard_duration_seconds": 4, "image_url": "http://127.0.0.1:8000/generated/frame/b.png",
            "video_url": None, "confirmed_video_asset_id": None,
            "confirmed_video_url": None, "confirmed_thumbnail_url": None,
            "confirmed_video_duration_seconds": None,
        },
        {
            "scene_id": 4, "scene_no": 2, "scene_title": "葬礼灵堂", "storyboard_id": None,
            "shot_no": None, "shot_type": None, "dialogue_text": None,
            "storyboard_duration_seconds": None, "image_url": None, "video_url": None,
            "confirmed_video_asset_id": None, "confirmed_video_url": None,
            "confirmed_thumbnail_url": None, "confirmed_video_duration_seconds": None,
        },
    ]


def test_export_package_shape_and_blocking_issues():
    """导出包：readyShots 计数、时长取确认视频、封面取首个有图项、blockingIssues。"""
    database = AssetCanvasDatabase()
    _seed_export_rows(database)
    client = make_client(database)

    response = client.get(f"/api/projects/{PROJECT_ID}/export-package", headers=AUTH)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["projectId"] == PROJECT_ID
    assert data["totalShots"] == 2
    assert data["readyShots"] == 2
    assert data["confirmedShots"] == 1
    assert data["missingShots"] == 1
    assert data["missingStoryboardScenes"] == 1
    assert data["totalDurationSeconds"] == 10  # 6（确认视频）+ 4（分镜时长兜底）
    assert data["canExport"] is False
    assert [issue["code"] for issue in data["blockingIssues"]] == ["missing-storyboards"]
    assert data["coverUrl"] == "http://127.0.0.1:8000/generated/frame/a.png"
    assert [item["storyboardId"] for item in data["items"]] == [21, 22]
    assert data["items"][0]["exportStatus"] == "ready"
    assert data["items"][1]["exportStatus"] == "static-ready"


def test_export_package_ready_blocks_on_all_disabled():
    """草稿禁用全部片段：readyShots=0 → all-video-disabled 阻塞项。"""
    database = AssetCanvasDatabase()
    _seed_export_rows(database)
    database.final_edit_draft = {
        "draft_json": json.dumps(
            {"videoClips": [{"storyboardId": 21, "enabled": False, "order": 1}, {"storyboardId": 22, "enabled": False, "order": 2}]},
            ensure_ascii=False,
        )
    }
    client = make_client(database)
    response = client.get(f"/api/projects/{PROJECT_ID}/export-package", headers=AUTH)
    data = response.json()["data"]
    assert data["readyShots"] == 0
    assert data["canExport"] is False
    # Node blockingIssues 顺序：missing-storyboards 在前（场景 2 无分镜）。
    assert [issue["code"] for issue in data["blockingIssues"]] == ["missing-storyboards", "all-video-disabled"]
    assert data["items"] == []  # 全部禁用后不产出 item


def test_export_package_can_export_when_complete():
    """全 ready 且无缺分镜 → canExport=True。"""
    database = AssetCanvasDatabase()
    _seed_export_rows(database)
    database.export_rows = [database.export_rows[0]]
    client = make_client(database)
    response = client.get(f"/api/projects/{PROJECT_ID}/export-package", headers=AUTH)
    data = response.json()["data"]
    assert data["canExport"] is True
    assert data["blockingIssues"] == []


def test_project_delete_confirmation_flow():
    """删除流：空确认名 4001（带项目名）→ 错误名 409/4090 → 正确名成功。"""
    client = make_client()
    empty = client.request("DELETE", f"/api/projects/{PROJECT_ID}", json={}, headers=AUTH)
    assert empty.status_code == 400
    assert empty.json() == {"code": 4001, "message": "请输入项目名称“死讯服务器”以确认删除", "data": None}
    wrong = client.request("DELETE", f"/api/projects/{PROJECT_ID}", json={"confirmName": "死讯服务"}, headers=AUTH)
    assert wrong.status_code == 409
    assert wrong.json() == {"code": 4090, "message": "项目名称不匹配，请输入页面显示的完整项目名称", "data": None}
    ok = client.request("DELETE", f"/api/projects/{PROJECT_ID}", json={"confirmName": " 死讯服务器 "}, headers=AUTH)
    assert ok.status_code == 200
    assert ok.json() == {"code": 0, "message": "项目已永久删除", "data": {"id": PROJECT_ID}}
