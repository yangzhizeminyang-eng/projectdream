"""剧本/分镜组 generate 端点原生兼容测试（第三阶段第三组 · 任务 D）。

覆盖：单条 GET storyboard 原生形状（含 frameCharacterContext，见
test_script_group_compat.py）、10 条 generate 端点的成功 / 字段非法 /
数据不存在 / 越权 / 异常依赖（AI 超时 → 可诊断失败、DB 异常 → 500 脱敏）/
重复提交幂等 / envelope 形状，以及既有 eval 校验器
（app.agent.eval.validators）对 mock 生成分镜的时长与提示词回归。
全部离线执行（fake database + httpx.MockTransport，CI 零 Node 依赖）。
"""

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.agent.eval.dataset import EvalCase
from app.agent.eval.validators import verify_storyboard_duration
from app.config import Settings
from app.domain.storyboard_ai import normalize_storyboard_shot
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}


class GenerateDatabase:
    """generate 端点测试的最小数据库桩。

    :ivar fail_on_read: 置 True 时读取类方法抛异常，模拟数据库故障。
    """

    def __init__(self):
        self.fail_on_read = False
        self.projects = [{"id": 8, "user_id": 7, "name": "夜班项目", "category": "悬疑", "visual_style": "电影感写实风格"}]
        self.scenes = {
            11: {
                "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1, "scene_no": 1,
                "title": "夜班值班台", "summary": "异常物品出现", "content": "林知夏站在值班台前，发现异常信号。",
                "mood": None, "location": "值班室", "time_of_day": "深夜",
                "estimated_duration": 90, "sort_order": 0, "status": "draft",
            }
        }
        self.storyboards = {
            21: {
                "id": 21, "scene_id": 11, "project_id": 8, "shot_no": "01", "shot_type": "中景",
                "camera_angle": "平视", "composition": "三分构图", "duration_seconds": 5,
                "character_id": 9, "character_name": "林知夏", "action_text": "林知夏站在值班台前",
                "dialogue_text": "（无对白）", "visual_prompt": "固定中景",
                "start_visual_prompt": None, "end_visual_prompt": None,
                "image_url": None, "end_image_url": None, "video_url": None,
                "asset_reference_json": None, "sort_order": 0, "status": "pending",
            },
            22: {
                "id": 22, "scene_id": 11, "project_id": 8, "shot_no": "02", "shot_type": "近景",
                "camera_angle": "平视", "composition": "对称构图", "duration_seconds": 4,
                "character_id": 9, "character_name": "林知夏", "action_text": "林知夏盯住屏幕",
                "dialogue_text": "温叙：我听见了。", "visual_prompt": "近景特写",
                "start_visual_prompt": None, "end_visual_prompt": None,
                "image_url": None, "end_image_url": None, "video_url": None,
                "asset_reference_json": None, "sort_order": 1, "status": "pending",
            },
        }
        self.characters = {
            8: [
                {
                    "id": 9, "name": "林知夏", "project_id": 8, "role_tag": "主角",
                    "personality": "克制冷静", "appearance": "黑色短发，灰色风衣",
                    "age_group": "young_adult", "gender": "female",
                    "reference_image_url": "https://media.example.com/9.png", "status": "confirmed",
                }
            ]
        }
        self.story_bibles = {8: [{"id": 5, "project_id": 8, "version_no": 1, "title": "夜班", "logline": "一晚改变一切"}]}
        self.season_structures = {8: []}
        self.story_outlines = {8: []}
        self.persisted_bibles = []
        self.persisted_seasons = []
        self.generation_jobs = {}
        self.image_assets = {}
        self.asset_rows = [
            {
                "asset_node_id": 71, "node_type": "character", "ref_id": 9, "label": "林知夏",
                "asset_prompt": None, "image_id": 81, "version_no": 3, "view_set_version": 2,
                "view_index": 1, "view_key": None, "view_set_type": "character-asset-pack",
                "status": "confirmed", "vision_status": "passed",
            },
            {
                "asset_node_id": 72, "node_type": "scene", "ref_id": 11, "label": "值班室",
                "asset_prompt": None, "image_id": 82, "version_no": 2, "view_set_version": 1,
                "view_index": 1, "view_key": None, "view_set_type": "single",
                "status": "confirmed", "vision_status": "passed",
            },
        ]

    # -- 鉴权 ---------------------------------------------------------------

    def find_user_by_token(self, token):
        """按 token 反查用户。

        :param token: 访问令牌。
        :return: 命中用户 dict，否则 None。
        """
        if token == "session-token":
            return {"id": 7, "phone": "13912345678", "nickname": "测试用户"}
        return None

    def get_project(self, project_id, user_id):
        """按 id+用户取项目。

        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 项目行或 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        return next((p for p in self.projects if p["id"] == project_id and p["user_id"] == user_id), None)

    # -- 场景 ----------------------------------------------------------------

    def get_scene_with_project(self, scene_id, user_id):
        """场景 + 项目字段联查桩。

        :param scene_id: 场景 id。
        :param user_id: 用户 id。
        :return: 场景行或 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        scene = self.scenes.get(scene_id)
        if scene is None or scene["user_id"] != user_id:
            return None
        row = dict(scene)
        row.update({"ownerId": user_id, "projectName": "夜班项目", "category": "悬疑",
                    "narrative_vision": None, "visual_style": "电影感写实风格"})
        return row

    def latest_story_bible_row(self, project_id):
        """最新故事设定行桩。"""
        rows = self.story_bibles.get(project_id, [])
        return rows[0] if rows else None

    def latest_season_structure_row(self, project_id):
        """最新分集大纲行桩。"""
        rows = self.season_structures.get(project_id, [])
        return rows[0] if rows else None

    def latest_outline_row(self, project_id):
        """最新总纲行桩。"""
        rows = self.story_outlines.get(project_id, [])
        return rows[0] if rows else None

    def save_generated_scene_script(self, scene_id, fields):
        """AI 剧本回写桩（status='generated'）。

        :param scene_id: 场景 id。
        :param fields: 剧本字段。
        :return: 更新后的场景行。
        """
        scene = self.scenes.get(scene_id)
        if scene is None:
            return None
        scene.update(fields)
        scene["status"] = "generated"
        return dict(scene)

    # -- 故事设定 / 分集大纲 ---------------------------------------------------

    def persist_story_bible(self, project_id, values):
        """故事设定持久化桩。

        :param project_id: 项目 id。
        :param values: 列值 dict。
        :return: 插入后的行。
        """
        row = {
            "id": 100 + len(self.persisted_bibles), "project_id": project_id, "version_no": 2,
            **values,
        }
        self.persisted_bibles.append(row)
        return row

    def persist_season_structure(self, project_id, story_bible_id, values):
        """分集大纲持久化桩。

        :param project_id: 项目 id。
        :param story_bible_id: 故事设定 id。
        :param values: 列值 dict。
        :return: 插入后的行。
        """
        row = {
            "id": 200 + len(self.persisted_seasons), "project_id": project_id,
            "story_bible_id": story_bible_id, "version_no": 1, **values,
        }
        self.persisted_seasons.append(row)
        return row

    # -- 分镜导演上下文 --------------------------------------------------------

    def load_storyboard_director_context(self, storyboard_id, user_id):
        """分镜导演上下文桩（含 project/scene/characters）。"""
        if self.fail_on_read:
            raise RuntimeError("database offline")
        shot = self.storyboards.get(storyboard_id)
        scene = self.scenes.get(shot["scene_id"]) if shot else None
        if shot is None or scene is None or scene["user_id"] != user_id:
            return None
        project = self.get_project(scene["project_id"], user_id)
        return {
            "storyboard": dict(shot),
            "project": {
                "id": project["id"], "name": project["name"], "category": project.get("category"),
                "visualStyle": project.get("visual_style"), "narrativeVision": None,
            },
            "scene": {
                "id": scene["id"], "sceneNo": scene["scene_no"], "title": scene["title"],
                "summary": scene["summary"], "content": scene["content"], "mood": scene.get("mood"),
                "location": scene.get("location"), "timeOfDay": scene.get("time_of_day"),
                "estimatedDuration": scene.get("estimated_duration"),
            },
            "characters": self.list_frame_characters(scene["project_id"]),
            "project_id": scene["project_id"],
        }

    def load_frame_rewrite_context(self, storyboard_id, user_id):
        """静帧重写上下文桩（额外带 outline）。"""
        context = self.load_storyboard_director_context(storyboard_id, user_id)
        if context is None:
            return None
        context["outline"] = {"title": None, "summary": None, "premise": None, "content": None}
        return context

    def update_storyboard_keyframes(self, storyboard_id, start_prompt, end_prompt):
        """两帧提示词回写桩。"""
        shot = self.storyboards.get(storyboard_id)
        if shot is None:
            return None
        shot.update({"start_visual_prompt": start_prompt, "end_visual_prompt": end_prompt})
        return dict(shot)

    def copy_previous_frame(self, storyboard_id, user_id):
        """承接上一镜头桩（返回 outcome 形态）。"""
        shot = self.storyboards.get(storyboard_id)
        scene = self.scenes.get(shot["scene_id"]) if shot else None
        if shot is None or scene is None or scene["user_id"] != user_id:
            return {"outcome": "no_shot"}
        source = next(
            (
                {"id": row_id, "shot_no": row["shot_no"], "image_url": "https://media.example.com/prev.png",
                 "thumbnail_url": None, "prompt_snapshot": "上一镜提示", "negative_prompt": None,
                 "character_snapshot": None, "model_name": "mock-frame-v1", "frame_role": "end"}
                for row_id, row in self.storyboards.items()
                if row["scene_id"] == shot["scene_id"]
                and int(row.get("sort_order") or 0) < int(shot.get("sort_order") or 0)
                and any(asset["storyboard_id"] == row_id and asset["status"] == "confirmed" for asset in self.image_assets.values())
            ),
            None,
        )
        if source is None:
            return {"outcome": "no_source"}
        image_id = max(self.image_assets.keys(), default=80) + 1
        image = {
            "id": image_id, "storyboard_id": storyboard_id, "version_no": 1,
            "image_url": source["image_url"], "thumbnail_url": None, "frame_role": "start",
            "prompt_snapshot": f"承接上一镜头 {source['shot_no']} 的结束帧作为本镜头起始帧。",
            "status": "confirmed",
        }
        self.image_assets[image_id] = image
        shot.update({"image_url": source["image_url"], "start_visual_prompt": image["prompt_snapshot"]})
        return {
            "outcome": "copied", "storyboard": dict(shot), "image": dict(image),
            "sourceStoryboardId": source["id"], "sourceShotNo": source["shot_no"],
        }

    def count_storyboard_generated_assets(self, storyboard_id):
        """素材计数桩（image_assets + continuity 起始帧豁免）。"""
        images = [a for a in self.image_assets.values() if a["storyboard_id"] == storyboard_id]
        continuity = [a for a in images if str(a.get("prompt_snapshot") or "").startswith("承接上一镜头")]
        return {
            "imageCount": len(images),
            "continuityStartImageCount": len(continuity),
            "videoCount": 0,
            "audioCount": 0,
        }

    def split_storyboard_in_place(self, *, storyboard_id, scene_id, sort_order, first_update, extra_rows, override_first_character):
        """拆分子分镜桩（首条 UPDATE 原行 + 其余 INSERT，sort_order 后移）。"""
        shot = self.storyboards[storyboard_id]
        for row_id, row in self.storyboards.items():
            if row["scene_id"] == scene_id and int(row.get("sort_order") or 0) > int(sort_order or 0):
                row["sort_order"] = int(row.get("sort_order") or 0) + len(extra_rows)
        column_map = {
            "shot_type": "shot_type", "camera_angle": "camera_angle", "composition": "composition",
            "duration_seconds": "duration_seconds", "character_id": "character_id",
            "character_name": "character_name", "action_text": "action_text",
            "dialogue_text": "dialogue_text", "visual_prompt": "visual_prompt",
            "start_visual_prompt": "start_visual_prompt", "end_visual_prompt": "end_visual_prompt",
            "asset_reference_json": "asset_reference_json", "image_url": "image_url",
        }
        shot.update({column_map[k]: v for k, v in first_update.items() if k in column_map})
        shot["status"] = "pending"
        for offset, row in enumerate(extra_rows, start=1):
            new_id = max(self.storyboards.keys()) + 1
            self.storyboards[new_id] = {
                "id": new_id, "scene_id": scene_id, "project_id": shot.get("project_id", 8),
                "status": "pending", "image_url": None, "end_image_url": None, "video_url": None,
                **{column_map.get(k, k): v for k, v in row.items()},
            }

    def list_scene_storyboard_rows(self, scene_id):
        """场景全部分镜行桩。"""
        return [dict(row) for row in sorted(
            (row for row in self.storyboards.values() if row["scene_id"] == scene_id),
            key=lambda row: (row.get("sort_order") or 0, row["id"]),
        )]

    def list_project_characters_with_assets(self, project_id):
        """项目角色（含资产版本）桩。"""
        return [dict(c) for c in self.characters.get(project_id, [])]

    def list_storyboard_asset_rows(self, project_id, *, include_missing_vision=False):
        """资产节点行桩（全量返回，不含 project 过滤语义差异）。"""
        return [dict(row) for row in self.asset_rows]

    def replace_scene_storyboards(self, scene_id, project_id, rows):
        """整场替换桩（DELETE+INSERT 语义由列表重建模拟）。"""
        self.storyboards = {
            row_id: row for row_id, row in self.storyboards.items() if row["scene_id"] != scene_id
        }
        for index, row in enumerate(rows):
            new_id = 300 + index
            self.storyboards[new_id] = {"id": new_id, "scene_id": scene_id, "project_id": project_id,
                                        "status": "pending", "image_url": None, "end_image_url": None,
                                        "video_url": None, **row}
        self.scenes[scene_id]["status"] = "storyboard_ready"
        return self.list_scene_storyboard_rows(scene_id)

    # -- 静帧入队 --------------------------------------------------------------

    def get_shot_for_frame_job(self, shot_id, user_id):
        """静帧入队前置查询桩。"""
        if self.fail_on_read:
            raise RuntimeError("database offline")
        shot = self.storyboards.get(shot_id)
        scene = self.scenes.get(shot["scene_id"]) if shot else None
        if shot is None or scene is None or scene["user_id"] != user_id:
            return None
        row = dict(shot)
        row.update({"project_id": scene["project_id"], "project_visual_style": "电影感写实风格"})
        return row

    def list_frame_characters(self, project_id):
        """项目角色库桩（frameCharacterContext 输入）。"""
        return [dict(c) for c in self.characters.get(project_id, []) if c.get("status") != "archived"]

    def next_image_version(self, storyboard_id):
        """下一静帧版本号桩。"""
        existing = [a["version_no"] for a in self.image_assets.values() if a["storyboard_id"] == storyboard_id]
        return (max(existing) if existing else 0) + 1

    def create_generation_job(self, project_id, job_type, source_id, request):
        """创建/复用生成任务桩（active 幂等复用，与 Node 一致）。"""
        for job in self.generation_jobs.values():
            if (job["project_id"] == project_id and job["job_type"] == job_type
                    and job["source_id"] == source_id and job["status"] in {"queued", "running"}):
                return job
        job_id = max(self.generation_jobs.keys(), default=30) + 1
        job = {
            "id": job_id, "job_key": f"{job_type}-{source_id}-test", "project_id": project_id,
            "job_type": job_type, "source_id": source_id, "status": "queued",
            "progress_percent": 0,
            "request_json": json.dumps({**(request or {}), "projectId": int(project_id)}, ensure_ascii=False),
            "result_json": None, "error_text": None,
        }
        self.generation_jobs[job_id] = job
        return job


def make_client(database=None, ai_handler=None):
    """构建原生模式测试客户端（第四阶段起恒为原生实现，AI 客户端可注入 MockTransport）。

    :param database: 注入数据库桩。
    :param ai_handler: 可选的 AI MockTransport 处理函数（注入 ai_client）。
    :return: 配置完成的 TestClient。
    """
    settings = Settings(_env_file=None)
    ai_client = (
        httpx.AsyncClient(transport=httpx.MockTransport(ai_handler)) if ai_handler else httpx.AsyncClient()
    )
    return TestClient(
        create_app(settings, database=database or GenerateDatabase(), ai_client=ai_client),
        raise_server_exceptions=False,
    )


# ---------------------------------------------------------------------------
# POST /api/scenes/{id}/script/generate —— mock 模式确定性生成
# ---------------------------------------------------------------------------


def test_generate_scene_script_writes_generated_scene():
    """剧本生成（mock）：mock 剧本回写多字段 + status='generated'，message「剧本已生成」。

    :return: None。
    """
    database = GenerateDatabase()
    response = make_client(database).post("/api/scenes/11/script/generate", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "剧本已生成"
    data = response.json()["data"]
    assert data["status"] == "generated"
    assert "【场景 01】" in data["content"]
    assert database.scenes[11]["status"] == "generated"


def test_generate_scene_script_requires_authentication():
    """剧本生成未登录：401/4010 envelope。

    :return: None。
    """
    response = make_client().post("/api/scenes/11/script/generate", json={})
    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


def test_generate_scene_script_hides_missing_scene():
    """剧本生成：场景不存在 → 404/4004。

    :return: None。
    """
    response = make_client().post("/api/scenes/999/script/generate", headers=AUTH, json={})
    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_generate_scene_script_returns_sanitized_500_when_database_fails():
    """剧本生成：DB 故障 → 500/5001 脱敏，不泄漏内部异常文本。

    :return: None。
    """
    database = GenerateDatabase()
    database.fail_on_read = True
    response = make_client(database).post("/api/scenes/11/script/generate", headers=AUTH, json={})
    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}


# ---------------------------------------------------------------------------
# POST /api/scenes/{id}/storyboards/generate —— mock 生成 + 资产门禁
# ---------------------------------------------------------------------------


def test_generate_scene_storyboards_replaces_scene_with_mock_shots():
    """分镜生成（mock）：mock 镜头过时长契约与资产门禁，整场替换 + 状态推进。

    :return: None。
    """
    database = GenerateDatabase()
    response = make_client(database).post("/api/scenes/11/storyboards/generate", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "分镜已生成"
    items = response.json()["data"]["items"]
    assert len(items) >= 4
    assert database.scenes[11]["status"] == "storyboard_ready"
    first = items[0]
    assert first["sortOrder"] == 0
    reference = first["assetReference"]
    assert reference["schemaVersion"] == 1
    assert reference["characterName"] == "林知夏"
    assert reference["sceneAssetId"] == 72
    # @引用补齐：visual_prompt 需含 @林知夏 与 @值班室。
    assert "@林知夏" in first["visualPrompt"]
    assert "@值班室" in first["visualPrompt"]


def test_generate_scene_storyboards_rejects_empty_script():
    """分镜生成：空剧本 → 400/4004（Node 复用 4004 + HTTP 400）。

    :return: None。
    """
    database = GenerateDatabase()
    database.scenes[11]["content"] = "   "
    response = make_client(database).post("/api/scenes/11/storyboards/generate", headers=AUTH, json={})

    assert response.status_code == 400
    assert response.json() == {
        "code": 4004,
        "message": "场景没有剧本内容，请先在单场剧本模块生成或编辑剧本",
        "data": None,
    }


def test_generate_scene_storyboards_gate_failure_returns_node_global_shape():
    """分镜生成：角色无资产 → 门禁 blocker → 500/5001 + 受控 message（Node 全局 catch 形态）。

    :return: None。
    """
    database = GenerateDatabase()
    database.asset_rows = []
    response = make_client(database).post("/api/scenes/11/storyboards/generate", headers=AUTH, json={})

    assert response.status_code == 500
    body = response.json()
    assert body["code"] == 5001
    assert body["message"].startswith("分镜资产引用门禁未通过：")
    assert "没有已采用的完整角色资产板" in body["message"]


def test_generate_scene_storyboards_eval_validators_pass_on_mock_output():
    """既有 eval 校验器回归：mock 分镜无 0 秒镜头、无时长断裂、提示词非空。

    :return: None。
    """
    database = GenerateDatabase()
    response = make_client(database).post("/api/scenes/11/storyboards/generate", headers=AUTH, json={})
    items = response.json()["data"]["items"]

    cursor = 0
    shots = []
    for item in items:
        duration = item["durationSeconds"]
        shots.append({"index": item["shotNo"], "start_seconds": cursor, "end_seconds": cursor + duration})
        cursor += duration
    result = verify_storyboard_duration(
        EvalCase(
            case_id="native-mock-storyboard-duration",
            eval_type="storyboard_duration",
            name="mock 生成分镜时长契约回归",
            input={"shots": shots, "target_total_seconds": cursor, "tolerance_seconds": 0.0},
            context={},
            expectations={"expected_verdict": "pass"},
            verifier="verify_storyboard_duration",
            source="rule_check",
        )
    )
    assert result["passed"], result["failures"]
    assert all(item["visualPrompt"].strip() for item in items)
    # mock 提示词经 @引用补齐后以提及开头，时间轴段保留（Node buildUnifiedStoryboardPrompt 同款）。
    assert all("时间轴：" in item["visualPrompt"] for item in items)


# ---------------------------------------------------------------------------
# story-bible / season-structure generate —— mock 502 与真实模式
# ---------------------------------------------------------------------------


def _ai_chat_response(payload):
    """构造 OpenAI-compatible chat completion 响应体。

    :param payload: 模型应返回的 JSON 对象。
    :return: httpx.Response。
    """
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]},
    )


def test_generate_story_bible_mock_mode_returns_5020():
    """故事设定生成（mock）：Node 同款直接 502/5020（不编造设定）。

    :return: None。
    """
    response = make_client().post(
        "/api/projects/8/story-bible/generate", headers=AUTH, json={"idea": "一个夜班值班员的悬疑故事"}
    )

    assert response.status_code == 502
    assert response.json() == {
        "code": 5020,
        "message": "当前为 mock 模式，不会真实调用模型生成故事设定",
        "data": None,
    }


def test_generate_story_bible_requires_idea():
    """故事设定生成：空创意 → 400/4001。

    :return: None。
    """
    response = make_client().post("/api/projects/8/story-bible/generate", headers=AUTH, json={"idea": "  "})
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "请先写下你的创意，再生成故事设定", "data": None}


def test_generate_story_bible_hides_missing_project():
    """故事设定生成：项目不存在/越权 → 404/4004。

    :return: None。
    """
    response = make_client().post("/api/projects/999/story-bible/generate", headers=AUTH, json={"idea": "x"})
    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_generate_story_bible_real_mode_two_call_chain_persists(monkeypatch):
    """故事设定生成（真实模式）：两段调用 → 归一化 → 评估 → 持久化 → {item, report}。

    :return: None。
    """
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_BASE_URL", "http://ai.test/v1")
    monkeypatch.setenv("AI_API_KEY", "sk-test")
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        """模拟两段模型调用：第一段核心设定，第二段世界观补齐。

        :param request: fake AI 收到的 httpx.Request。
        :return: chat completion 响应。
        """
        calls["count"] += 1
        if calls["count"] == 1:
            return _ai_chat_response({
                "title": "夜班", "logline": "一晚改变一切", "audience": "悬疑爱好者",
                "emotionalPromise": "紧张与释然", "mainPlot": "值班员发现异常",
                "subplots": ["搭档的秘密"],
                "characters": [
                    {"name": "林知夏", "role": "主角", "goal": "查明异常", "fear": "失去控制",
                     "secret": "她早知道信号", "growthArc": "从回避到直面", "visualDescription": "黑色短发"},
                    {"name": "陈默", "role": "配角", "goal": "保护她", "fear": "暴露", "secret": "卧底身份",
                     "growthArc": "从隐瞒到坦白", "visualDescription": "寸头"},
                ],
            })
        return _ai_chat_response({
            "worldRules": ["信号只在午夜出现"], "timeline": ["第一夜", "第二夜"],
            "locations": ["值班室"], "relationships": ["林知夏与陈默是搭档"],
            "props": [{"name": "发卡"}], "foreshadowing": ["发卡来历"], "visualSymbols": ["冷光"],
        })

    database = GenerateDatabase()
    response = make_client(database, ai_handler=handler).post(
        "/api/projects/8/story-bible/generate", headers=AUTH, json={"idea": "夜班悬疑", "episodeCount": 3}
    )

    assert response.status_code == 200
    assert response.json()["message"] == "故事设定已生成"
    data = response.json()["data"]
    assert data["item"]["title"] == "夜班"
    assert data["item"]["versionNo"] == 2
    assert data["item"]["status"] == "draft"
    assert data["report"]["type"] == "story_bible"
    assert data["report"]["threshold"] == 90
    assert calls["count"] == 2
    assert len(database.persisted_bibles) == 1


def test_generate_story_bible_timeout_returns_diagnosable_5020(monkeypatch):
    """故事设定生成：AI 超时 → 502/5020 可诊断文案（不泄漏密钥）。

    :return: None。
    """
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_BASE_URL", "http://ai.test/v1")
    monkeypatch.setenv("AI_API_KEY", "sk-secret-key")

    def handler(request: httpx.Request) -> httpx.Response:
        """模拟上游超时。

        :param request: fake AI 收到的 httpx.Request。
        :raises httpx.ReadTimeout: 恒抛出。
        """
        raise httpx.ReadTimeout("timed out", request=request)

    response = make_client(ai_handler=handler).post(
        "/api/projects/8/story-bible/generate", headers=AUTH, json={"idea": "夜班悬疑"}
    )

    assert response.status_code == 502
    body = response.json()
    assert body["code"] == 5020
    assert "生成超时" in body["message"]
    assert "sk-secret-key" not in response.text


def test_generate_season_structure_requires_bible():
    """分集大纲生成：无故事设定 → 400/4001「请先生成并保存故事设定」。

    :return: None。
    """
    database = GenerateDatabase()
    database.story_bibles = {8: []}
    response = make_client(database).post(
        "/api/projects/8/season-structure/generate", headers=AUTH, json={"episodeCount": 2}
    )

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "请先生成并保存故事设定", "data": None}


def test_generate_season_structure_mock_mode_returns_5020():
    """分集大纲生成（mock）：502/5020（Node 同款）。

    :return: None。
    """
    response = make_client().post(
        "/api/projects/8/season-structure/generate", headers=AUTH, json={"episodeCount": 2}
    )

    assert response.status_code == 502
    assert response.json() == {
        "code": 5020,
        "message": "当前为 mock 模式，不会真实调用模型生成分集大纲",
        "data": None,
    }


def test_generate_season_structure_real_mode_persists_with_report(monkeypatch):
    """分集大纲生成（真实模式）：完整分集 → 评估 → 持久化。

    :return: None。
    """

    def episode(no):
        """构造一集完整分集 payload。

        :param no: 集数。
        :return: 分集 dict。
        """
        return {
            "episodeNo": no, "title": f"第{no}夜", "logline": f"第{no}夜的异常升级",
            "openingHook": "深夜值班台突然自动弹出一张失踪者的照片，照片上的日期是明天。",
            "goal": "查明照片来历", "coreConflict": "主任威胁她立刻封锁档案，否则她会被调离。",
            "irreversibleChange": "她公开了照片，身份暴露再也无法回头。",
            "endingHook": "电话里传来她自己的声音，约她明晚在机房见面。",
            "protagonistChoice": "她选择拒绝上交照片并偷偷扫描备份。",
            "reversal": "原来照片背面印着她自己的名字。",
            "visualSetPieces": ["警报灯下的档案室", "雨夜天台对峙"],
        }

    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_BASE_URL", "http://ai.test/v1")
    monkeypatch.setenv("AI_API_KEY", "sk-test")
    response = make_client(ai_handler=lambda request: _ai_chat_response({
        "seasonTheme": "异常夜班", "coreConflict": "值班员与体制的对抗",
        "structureType": "linear", "episodes": [episode(1), episode(2)],
    })).post("/api/projects/8/season-structure/generate", headers=AUTH, json={"episodeCount": 2})

    assert response.status_code == 200
    assert response.json()["message"] == "分集大纲已生成"
    data = response.json()["data"]
    assert data["item"]["episodeCount"] == 2
    assert data["report"]["type"] == "season_structure"
    assert "marketQuality" in data["report"]


# ---------------------------------------------------------------------------
# storyboard keyframes / continuity / split / dialogue split / frame-prompt
# ---------------------------------------------------------------------------


def test_optimize_keyframes_falls_back_to_local_rules_in_mock_mode():
    """两帧优化（mock）：AI 抛错走本地兜底规则，notes 为兜底说明（Node 同款）。

    :return: None。
    """
    database = GenerateDatabase()
    response = make_client(database).post("/api/storyboards/21/keyframes/optimize", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "两帧提示词已优化"
    data = response.json()["data"]
    assert data["notes"] == "已使用本地兜底规则生成，建议确认后再生成起始帧和结束帧。"
    assert "动作开始前" in data["startVisualPrompt"]
    assert "动作完成后" in data["endVisualPrompt"]
    assert database.storyboards[21]["start_visual_prompt"] == data["startVisualPrompt"]


def test_optimize_keyframes_hides_missing_storyboard():
    """两帧优化：分镜不存在 → 404/4004。

    :return: None。
    """
    response = make_client().post("/api/storyboards/999/keyframes/optimize", headers=AUTH, json={})
    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_copy_previous_frame_without_source_returns_409_4011():
    """承接上一镜头：上一镜无确认画面 → 409/4011（Node 形态）。

    :return: None。
    """
    response = make_client().post("/api/storyboards/21/continuity/start-frame", headers=AUTH, json={})

    assert response.status_code == 409
    assert response.json() == {"code": 4011, "message": "上一镜头还没有已确认画面，无法承接", "data": None}


def test_copy_previous_frame_copies_confirmed_end_frame():
    """承接上一镜头：上一镜有确认帧 → 插入 confirmed 起始帧 + 回写 image_url。

    :return: None。
    """
    database = GenerateDatabase()
    # 镜头 21 sort_order=0，给同场景前一镜 20 放一个确认结束帧。
    database.storyboards[20] = {**database.storyboards[21], "id": 20, "shot_no": "00", "sort_order": -1}
    database.image_assets[90] = {
        "id": 90, "storyboard_id": 20, "version_no": 1, "status": "confirmed",
        "frame_role": "end", "image_url": "https://media.example.com/prev.png",
        "prompt_snapshot": "上一镜提示", "negative_prompt": None, "character_snapshot": None,
        "model_name": "mock-frame-v1",
    }
    response = make_client(database).post("/api/storyboards/21/continuity/start-frame", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "已承接上一镜头"
    data = response.json()["data"]
    assert data["sourceStoryboardId"] == 20
    assert data["image"]["status"] == "confirmed"
    assert data["image"]["frameRole"] == "start"
    assert data["storyboard"]["imageUrl"] == "https://media.example.com/prev.png"
    assert data["storyboard"]["startVisualPrompt"].startswith("承接上一镜头")


def test_split_storyboard_creates_two_sub_shots_with_fallback():
    """拆分子分镜（mock）：AI 抛错走两段子分镜兜底 → createdCount=2 + 排序后移。

    :return: None。
    """
    database = GenerateDatabase()
    database.storyboards[22]["sort_order"] = 1
    response = make_client(database).post("/api/storyboards/21/split", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "子分镜已拆分"
    data = response.json()["data"]
    assert data["createdCount"] == 2
    assert data["current"]["id"] == 21
    assert data["items"][0]["id"] == 21
    # 后续镜头 sort_order 被推移（Node 事务语义）。
    assert database.storyboards[22]["sort_order"] == 2


def test_split_storyboard_blocks_when_assets_exist():
    """拆分子分镜：已有图片素材 → 409/4011（Node 门禁文案逐字）。

    :return: None。
    """
    database = GenerateDatabase()
    database.image_assets[91] = {
        "id": 91, "storyboard_id": 21, "version_no": 1, "status": "candidate",
        "frame_role": "primary", "prompt_snapshot": "普通提示", "image_url": "https://media.example.com/a.png",
    }
    response = make_client(database).post("/api/storyboards/21/split", headers=AUTH, json={})

    assert response.status_code == 409
    assert response.json()["code"] == 4011
    assert "当前分镜已经有生成图片素材，不能再拆分" in response.json()["message"]


def test_split_dialogue_requires_two_speakers():
    """对白拆分：只识别到一个说话角色 → 409/4011。

    :return: None。
    """
    database = GenerateDatabase()
    database.storyboards[21]["dialogue_text"] = "林知夏：我听见了。林知夏：你听错了吗？"
    response = make_client(database).post("/api/storyboards/21/dialogue/split", headers=AUTH, json={})

    assert response.status_code == 409
    assert response.json() == {
        "code": 4011,
        "message": "当前对白只识别到一个说话角色，不需要按多人对白拆镜。",
        "data": None,
    }


def test_split_dialogue_creates_speaker_bound_sub_shots():
    """对白拆分：两个说话角色 → 轮次兜底子分镜 + speakers 列表。

    :return: None。
    """
    database = GenerateDatabase()
    database.storyboards[21]["dialogue_text"] = "林知夏：我听见了。\n温叙：我也听见了。"
    database.characters[8].append({
        "id": 10, "name": "温叙", "project_id": 8, "role_tag": "配角", "personality": "低沉",
        "appearance": "不出现正脸", "age_group": "young_adult", "gender": "male",
        "reference_image_url": "https://media.example.com/10.png", "status": "confirmed",
    })
    response = make_client(database).post("/api/storyboards/21/dialogue/split", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "多人对白已拆分为可做口型的短分镜"
    data = response.json()["data"]
    assert data["createdCount"] == 2
    assert set(data["speakers"]) == {"林知夏", "温叙"}
    assert data["items"][0]["characterName"] == "林知夏"
    assert data["items"][1]["characterName"] == "温叙"


def test_rewrite_frame_prompt_returns_mock_prompt_with_context():
    """提示词重写（mock）：返回兜底 visualPrompt + 最新 frameCharacterContext，不落库。

    :return: None。
    """
    database = GenerateDatabase()
    before = dict(database.storyboards[21])
    response = make_client(database).post("/api/storyboards/21/frame-prompt/rewrite", headers=AUTH, json={})

    assert response.status_code == 200
    assert response.json()["message"] == "视觉提示词已重写"
    data = response.json()["data"]
    assert data["visualPrompt"].strip()
    assert data["frameCharacterContext"]["ready"] is True
    assert data["frameCharacterContext"]["primaryCharacterId"] == 9
    # Node 同款：该端点不写库。
    assert database.storyboards[21] == before


def test_rewrite_frame_prompt_rejects_invalid_storyboard_id():
    """提示词重写：storyboardId 无效（0）→ 400/4001。

    :return: None。
    """
    response = make_client().post("/api/storyboards/0/frame-prompt/rewrite", headers=AUTH, json={})
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "无效的 storyboardId", "data": None}


# ---------------------------------------------------------------------------
# POST /api/shots/{id}/images/generate —— 形态 (a) 任务入队
# ---------------------------------------------------------------------------


def test_enqueue_frame_image_creates_job_with_snapshot(monkeypatch):
    """静帧入队：资产门禁 + frameCharacterContext 就绪 → generation_jobs 快照。

    FRAME_PROVIDER 需支持定妆参考图（默认 trae-url 通道与 Node 同款 409）。

    :param monkeypatch: pytest 环境变量注入。
    :return: None。
    """
    monkeypatch.setenv("FRAME_PROVIDER", "volcengine")
    database = GenerateDatabase()
    database.storyboards[21]["asset_reference_json"] = json.dumps({
        "characterId": 71, "characterVersionNo": 3, "characterViewSetVersion": 2,
        "characterViewKeys": ["front", "side", "back"], "characterAssetPackImageId": 81,
        "characterAssetPackVersionNo": 3, "sceneAssetId": 72, "scenePanoramaVersion": 2,
    })
    database.characters[8][0]["reference_image_storage_key"] = "characters/9/v2-approved.png"
    response = make_client(database).post(
        "/api/shots/21/images/generate", headers=AUTH, json={"frameRole": "start", "candidateCount": 2}
    )

    assert response.status_code == 200
    assert response.json()["message"] == "静帧生成任务已提交"
    job = response.json()["data"]
    assert job["jobType"] == "frame_image"
    assert job["sourceId"] == 21
    assert job["status"] == "queued"
    request_snapshot = json.loads(database.generation_jobs[job["id"]]["request_json"])
    assert request_snapshot["projectId"] == 8
    assert request_snapshot["versionNo"] == 1
    assert request_snapshot["frameRole"] == "start"
    assert request_snapshot["candidateCount"] == 2
    assert request_snapshot["promptSnapshot"].strip()
    assert request_snapshot["characterSnapshot"]["primaryCharacterId"] == 9
    assert request_snapshot["referenceImageStorageKeys"] == ["characters/9/v2-approved.png"]
    assert request_snapshot["referenceImageUrls"] == []


def test_enqueue_frame_image_blocks_provider_without_reference_support_when_only_storage_key_exists(monkeypatch):
    """稳定对象键也是强制人物参考，不能因无 URL 被能力门禁漏掉。"""
    monkeypatch.setenv("FRAME_PROVIDER", "bigmodel")
    database = GenerateDatabase()
    database.characters[8][0]["reference_image_url"] = None
    database.characters[8][0]["reference_image_storage_key"] = "characters/9/v2-approved.png"
    database.storyboards[21]["asset_reference_json"] = json.dumps({
        "characterId": 71, "characterVersionNo": 3, "characterViewSetVersion": 2,
        "characterViewKeys": ["front", "side", "back"], "characterAssetPackImageId": 81,
        "characterAssetPackVersionNo": 3, "sceneAssetId": 72, "scenePanoramaVersion": 2,
    })

    response = make_client(database).post("/api/shots/21/images/generate", headers=AUTH, json={})

    assert response.status_code == 409
    assert "不支持定妆参考图输入" in response.json()["message"]


def test_enqueue_frame_image_is_idempotent_for_active_job(monkeypatch):
    """静帧入队幂等：queued 活动任务重复提交复用同一 job（Node createGenerationJob 同款）。

    :param monkeypatch: pytest 环境变量注入。
    :return: None。
    """
    monkeypatch.setenv("FRAME_PROVIDER", "volcengine")
    database = GenerateDatabase()
    database.storyboards[21]["asset_reference_json"] = json.dumps({
        "characterId": 71, "characterVersionNo": 3, "characterViewSetVersion": 2,
        "characterViewKeys": ["front", "side", "back"], "characterAssetPackImageId": 81,
        "characterAssetPackVersionNo": 3, "sceneAssetId": 72, "scenePanoramaVersion": 2,
    })
    client = make_client(database)
    first = client.post("/api/shots/21/images/generate", headers=AUTH, json={})
    second = client.post("/api/shots/21/images/generate", headers=AUTH, json={})

    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    assert len(database.generation_jobs) == 1


def test_enqueue_frame_image_blocks_when_character_context_not_ready():
    """静帧入队：角色缺定妆图 → 409/4011（blockers[0] 文案与 Node 逐字一致）。

    :return: None。
    """
    database = GenerateDatabase()
    database.characters[8][0]["reference_image_url"] = None
    database.storyboards[21]["asset_reference_json"] = json.dumps({
        "characterId": 71, "characterVersionNo": 3, "characterViewSetVersion": 2,
        "characterViewKeys": ["front", "side", "back"], "characterAssetPackImageId": 81,
        "characterAssetPackVersionNo": 3, "sceneAssetId": 72, "scenePanoramaVersion": 2,
    })
    response = make_client(database).post("/api/shots/21/images/generate", headers=AUTH, json={})

    assert response.status_code == 409
    assert response.json() == {
        "code": 4011,
        "message": "角色“林知夏”尚未确认定妆图，请先生成并确认角色定妆图",
        "data": None,
    }


def test_enqueue_frame_image_blocks_on_asset_reference_gate():
    """静帧入队：资产引用门禁未通过 → 409/4011「资产引用门禁未通过：N 个问题需要处理」。

    :return: None。
    """
    database = GenerateDatabase()
    response = make_client(database).post("/api/shots/21/images/generate", headers=AUTH, json={})

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 4011
    assert body["message"].startswith("资产引用门禁未通过：")
    assert body["message"].endswith("个问题需要处理")


def test_enqueue_frame_image_hides_missing_shot_and_requires_auth():
    """静帧入队：未登录 401/4010；分镜不存在/越权 404/4004。

    :return: None。
    """
    assert make_client().post("/api/shots/21/images/generate", json={}).status_code == 401
    assert make_client().post("/api/shots/999/images/generate", headers=AUTH, json={}).status_code == 404


def test_normalize_storyboard_shot_accepts_object_shaped_asset_references():
    """分镜 Agent 返回 {name,id} 对象引用时，归一为可匹配的名称而不是 dict 字符串。"""
    shot = normalize_storyboard_shot(
        {
            "shot_no": 1,
            "shot_type": "全景",
            "camera_angle": "平视",
            "composition": "三分构图",
            "duration_seconds": 5,
            "duration_breakdown": [
                {"phase": "入画", "seconds": 2, "observable": "林默走入灯室"},
                {"phase": "停步", "seconds": 3, "observable": "林默停在控制台前"},
            ],
            "character_name": {"name": "林默", "id": 40},
            "character_assets": [{"name": "林默", "id": 40}],
            "scene_assets": [{"name": "灯塔灯室", "id": 361}],
            "prop_assets": [{"name": "手提工具", "id": 363}, {"name": "老式无线电收发机", "id": 362}],
            "tools": [{"name": "片段衔接"}],
            "action_text": "林默提着手提工具走入灯室。",
            "visual_prompt": "全景，林默走入灯室。",
        },
        index=0,
        project_visual_style="电影感写实",
        characters=[{"id": 40, "name": "林默", "role_tag": "主角"}],
    )

    assert shot["character_name"] == "林默"
    assert shot["character_assets"] == ["林默"]
    assert shot["scene_assets"] == ["灯塔灯室"]
    assert shot["prop_assets"] == ["手提工具", "老式无线电收发机"]
    assert shot["tools"] == ["片段衔接"]
