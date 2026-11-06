"""运维端点与其他剩余路由处置（阶段 3.2.5）的兜底收口兼容测试。

对照规格：``api-service/docs/ops-endpoints-spec.md`` 处置总表。核心断言（任务门禁）：

1. **兜底收口矩阵**：枚举全部处置路径（原生迁移 / 显式 501 豁免 / 兜底悬空），
   断言每条路径的响应必为「原生成功 / 4040 / 501」三者之一，且**绝不出现代理透传
   标记**（``x-forwarded-by: projectdream-fastapi``）；
2. 原生迁移路由的契约场景（未登录 / 数据不存在 / 成功形状 / 错误码），全部离线
   执行（fake database，无真实 MySQL / Node 依赖）。

Node 对齐基线：index.mjs L12218（health）/ L12235（model-settings）/ L12948
（script-agent）/ L13100-L13194（story-bible|season-structure 写侧）/ L15045+
L17197（exports 读）/ L16830（storyboard videos）/ L18352（未匹配路径 4040）。
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import OPS_FALLBACK_501_ROUTES, create_app

AUTH_HEADER = {"Authorization": "Bearer ops-test-token"}
USER = {"id": 7, "phone": "13912345678", "nickname": "运维测试用户", "createdAt": "2026-01-01T00:00:00.000Z"}


class OpsDatabase:
    """运维端点组测试的最小数据库桩（只实现本次处置路由触达的方法）。

    :ivar users: token -> 用户行（鉴权桩）。
    :ivar projects: 项目行（get_project 桩）。
    :ivar model_settings: model_settings 表键值映射。
    :ivar activities: script_agent_activities 行列表。
    :ivar activity_seq: 活动 id 自增。
    :ivar exports: export_records 行列表。
    :ivar video_assets: storyboard_id -> video_assets 行列表。
    :ivar story_bibles: story_bibles 行列表（persist 桩追加）。
    :ivar season_structures: season_structures 行列表。
    :ivar shot_owner: get_shot_for_video_job 命中时返回的行。
    """

    def __init__(self):
        self.users = {"ops-test-token": USER}
        self.projects = {1: {"id": 1, "user_id": 7, "name": "运维测试项目"}}
        self.model_settings: dict[str, str] = {}
        self.activities: list[dict] = []
        self.activity_seq = 0
        self.exports: list[dict] = []
        self.video_assets: dict[int, list[dict]] = {}
        self.story_bibles: list[dict] = []
        self.season_structures: list[dict] = []
        self.outline_row: dict | None = None
        self.scene_rows: list[dict] = []
        self.created_scene_specs: list[dict] = []
        self.modern_outline_script = False
        self.saved_outline: dict | None = None
        self.shot_owner: dict | None = {"id": 5, "project_id": 1}
        self.agent_pipeline_views: list[dict] = []
        self.agent_pipeline_detail: dict | None = None
        self.agent_pipeline_start_request: dict | None = None
        self.agent_pipeline_stage_action_outcome = "saved"
        self.production_runs: list[dict] = []
        self.production_run_detail: dict | None = None
        self.production_created: dict | None = None
        self.production_transitions: list[dict] = []
        self.final_edit_context = {
            "project": {"id": 1, "name": "运维测试项目"},
            "completeness": {"total_storyboard_count": 2, "missing_storyboard_scene_count": 0},
            "videoRows": [
                {
                    "scene_id": 4, "scene_no": 1, "scene_title": "雨夜", "storyboard_id": 21,
            "episode_no": 1,
                    "shot_no": 1, "shot_type": "wide", "dialogue_text": "快走", "sort_order": 1,
                    "storyboard_duration_seconds": 4, "video_asset_id": 31, "video_url": "/generated/video/a.mp4",
                    "video_storage_key": None, "video_duration_seconds": 3, "video_version_no": 2,
                    "video_confirmed_at": "2026-10-20 10:00:00", "image_asset_id": 41,
                    "confirmed_image_url": "/generated/frame/a.png", "image_storage_key": None,
                    "confirmed_image_thumbnail_url": None,
                },
                {
                    "scene_id": 4, "scene_no": 1, "scene_title": "雨夜", "storyboard_id": 22,
            "episode_no": 1,
                    "shot_no": 2, "shot_type": "close", "dialogue_text": None, "sort_order": 2,
                    "storyboard_duration_seconds": 5, "video_asset_id": None, "video_url": None,
                    "video_storage_key": None, "video_duration_seconds": None, "video_version_no": None,
                    "video_confirmed_at": None, "image_asset_id": 42,
                    "confirmed_image_url": "/generated/frame/b.png", "image_storage_key": None,
                    "confirmed_image_thumbnail_url": None,
                },
            ],
            "audioRows": [{
                "id": 51, "project_id": 1, "track_type": "dialogue", "scene_id": 4, "storyboard_id": 21,
                "storyboard_shot_no": 1, "scene_no": 1, "scene_title": "雨夜", "character_id": 9,
                "character_name": "林夏", "version_no": 1, "audio_url": "/generated/audio/a.wav",
                "storage_key": None, "duration_seconds": 2.5, "start_offset_seconds": 0.5,
                "voice_name": "清晰女声", "model_name": "mock", "confirmed_at": "2026-10-20 10:00:00",
                "created_at": "2026-10-20 09:00:00", "status": "confirmed",
            }],
            "draft": {"draft_json": '{"videoClips":[{"storyboardId":22,"order":1},{"storyboardId":21,"order":2}],"audioMix":{}}', "updated_at": None},
        }
        self.saved_final_edit_draft: dict | None = None
        self.export_package = {
            "totalShots": 2, "readyShots": 2, "missingShots": 0,
            "coverUrl": "/generated/frame/a.png", "blockingIssues": [],
        }
        self.export_rows = [
            {"scene_id": 4, "scene_no": 1, "scene_title": "雨夜", "storyboard_id": 21,
             "shot_no": 1, "shot_type": "wide", "storyboard_duration_seconds": 4,
             "confirmed_video_asset_id": 31, "confirmed_video_duration_seconds": 3,
             "confirmed_video_url": "/generated/video/a.mp4", "image_url": "/generated/frame/a.png"},
            {"scene_id": 4, "scene_no": 1, "scene_title": "雨夜", "storyboard_id": 22,
             "shot_no": 2, "shot_type": "close", "storyboard_duration_seconds": 5,
             "confirmed_video_asset_id": None, "confirmed_video_duration_seconds": None,
             "confirmed_video_url": None, "image_url": "/generated/frame/b.png"},
        ]

    # ---- 鉴权 / 项目归属 ----

    def find_user_by_token(self, token):
        """按 token 反查用户（鉴权桩）。"""
        return self.users.get(token)

    def get_project(self, project_id, user_id):
        """项目归属查询（仅命中 owner 相同的项目）。"""
        project = self.projects.get(project_id)
        return project if project and int(project["user_id"]) == int(user_id) else None

    def latest_season_structure_row(self, project_id):
        return self.season_structures[0] if project_id == 1 and self.season_structures else None

    def latest_outline_row(self, project_id):
        return self.outline_row if project_id == 1 else None

    def list_scenes(self, project_id, user_id):
        return list(self.scene_rows) if project_id == 1 and user_id == 7 else None

    def generate_project_scenes(self, project_id, user_id, outline_id, specs):
        if project_id != 1 or user_id != 7 or self.scene_rows:
            return None
        self.created_scene_specs = [dict(item) for item in specs]
        self.scene_rows = [
            {"id": 100 + index, "project_id": project_id, "outline_id": outline_id,
             "episode_no": item["episode_no"], "scene_no": item["scene_no"],
             "title": item["title"], "summary": item["summary"], "content": "",
             "spatial_anchors_json": None,
             "location": item["location"], "time_of_day": item["time_of_day"],
             "estimated_duration": item["estimated_duration"], "sort_order": index,
             "status": "draft"}
            for index, item in enumerate(specs)
        ]
        return list(self.scene_rows)

    def has_modern_outline_script(self, project_id, user_id):
        return self.modern_outline_script if project_id == 1 and user_id == 7 else False

    def save_generated_outline(self, project_id, user_id, outline):
        if project_id != 1 or user_id != 7 or self.modern_outline_script:
            return None
        self.scene_rows = []
        self.saved_outline = {"id": 45, "project_id": 1, "version_no": 2,
                              "title": outline["title"], "logline": outline["logline"],
                              "premise": outline["premise"], "visual_style": outline["visual_style"],
                              "act1_text": outline["acts"][0]["summary"],
                              "act2_text": outline["acts"][1]["summary"],
                              "act3_text": outline["acts"][2]["summary"],
                              "raw_json": json.dumps({"acts": outline["acts"], "scenes": outline["scenes"]}, ensure_ascii=False)}
        return self.saved_outline

    def list_agent_pipeline_views(self, project_id, user_id):
        """返回 owner-scoped Pipeline 运行视图。"""
        return [dict(view) for view in self.agent_pipeline_views] if project_id == 1 and user_id == 7 else None

    def get_agent_pipeline_view(self, run_id, user_id):
        """按运行记录归属返回单个 Pipeline 视图。"""
        view = self.agent_pipeline_detail
        if view and view["run"].get("id") == run_id and view["run"].get("user_id") == user_id:
            return dict(view)
        return None

    def enqueue_agent_pipeline_run(self, **kwargs):
        self.agent_pipeline_start_request = kwargs
        if kwargs["project_id"] != 1 or kwargs["user_id"] != 7:
            return {"outcome": "not_found"}
        run_id = 91
        self.agent_pipeline_detail = {
            "run": {
                "id": run_id, "project_id": 1, "user_id": 7, "episode_no": kwargs["episode_no"],
                "status": "queued", "current_stage": "asset-parse",
                "input_snapshot_json": json.dumps({"episodeNo": kwargs["episode_no"]}),
                "idempotency_key": kwargs["idempotency_key"],
            },
            "executions": [], "events": [],
        }
        return {"outcome": "queued", "run_id": run_id}

    def apply_agent_pipeline_decision(self, run_id, user_id, stage_key, decision, note):
        view = self.agent_pipeline_detail
        if not view or view["run"].get("id") != run_id or view["run"].get("user_id") != user_id:
            return {"outcome": "not_found"}
        if (view["run"].get("status") != "waiting_approval"
                or view["run"].get("current_stage") != stage_key
                or not any(item.get("stage_key") == stage_key and item.get("status") == "waiting_approval"
                           for item in view["executions"])):
            return {"outcome": "not_waiting"}
        if decision == "reject":
            view["run"].update(status="paused", current_stage=stage_key, error_text=note or "人工检查点未通过")
            return {"outcome": "paused"}
        next_stage = {
            "asset-parse": "character-lock",
            "character-lock": "scene-lock",
            "scene-lock": "storyboard",
        }.get(stage_key)
        if next_stage:
            view["run"].update(status="queued", current_stage=next_stage, error_text="")
            return {"outcome": "queued"}
        view["run"].update(status="completed", current_stage="storyboard", error_text="")
        return {"outcome": "completed"}

    def register_agent_pipeline_stage_action(self, run_id, user_id, action):
        return {"outcome": self.agent_pipeline_stage_action_outcome}

    def list_production_run_rows(self, project_id, user_id):
        return [dict(row) for row in self.production_runs] if project_id == 1 and user_id == 7 else None

    def get_production_run_view(self, run_id, user_id):
        view = self.production_run_detail
        if view and view["run"].get("id") == run_id and view["run"].get("user_id") == user_id:
            return dict(view)
        return None

    def get_production_story_sources(self, project_id, episode_no):
        return {"bible": {}, "season": {}, "episode": {}, "sourceScript": {"scenes": [], "shots": []}}

    def create_production_run(self, *, project_id, user_id, project_name, seed, blueprint, quality_report, idempotency_key):
        self.production_created = {"project_id": project_id, "user_id": user_id, "seed": seed,
                                   "blueprint": blueprint, "quality_report": quality_report,
                                   "idempotency_key": idempotency_key}
        run_id = 77
        self.production_run_detail = {
            "run": {"id": run_id, "project_id": project_id, "user_id": user_id, "project_name": project_name,
                    "episode_no": seed["run"]["episodeNo"], "platform": seed["run"]["platform"],
                    "name": f"{project_name} · 第 {seed['run']['episodeNo']} 集黄金样片",
                    "status": seed["run"]["status"], "current_stage": seed["run"]["currentStage"],
                    "current_checkpoint": seed["run"]["currentCheckpoint"],
                    "pilot_mode": seed["run"]["pilotMode"], "pilot_scene_count": seed["run"]["pilotSceneCount"],
                    "budget": seed["run"]["budget"], "candidate_policy_json": json.dumps(seed["run"]["candidatePolicy"]),
                    "success_metrics_json": json.dumps(seed["run"]["successMetrics"]),
                    "input_snapshot_json": json.dumps(seed["run"]["inputSnapshot"]),
                    "output_snapshot_json": json.dumps({"blueprint": blueprint})},
            "stages": [], "checkpoints": [], "agentExecutions": [],
            "blueprint": {"row": {"id": 88, "production_run_id": run_id, "project_id": project_id,
                                    "episode_no": seed["run"]["episodeNo"], "version_no": 1, "status": "draft",
                                    "blueprint_json": json.dumps(blueprint),
                                    "quality_report_json": json.dumps(quality_report)}, "emotionBeats": []},
        }
        return run_id

    def save_production_blueprint(self, run_id, user_id, blueprint, quality_report):
        return 89 if self.production_run_detail else None

    def apply_production_transition(self, run_id, user_id, transition, checkpoint=False):
        self.production_transitions.append({"transition": transition, "checkpoint": checkpoint})
        return True

    def get_final_edit_context(self, project_id, user_id, episode_no=None):
        if project_id != 1 or user_id != 7:
            return None
        if episode_no is None:
            return self.final_edit_context
        scene_ids = {
            int(row["scene_id"]) for row in self.final_edit_context["videoRows"]
            if row.get("episode_no", 1) == episode_no
        }
        return {
            **self.final_edit_context,
            "videoRows": [row for row in self.final_edit_context["videoRows"] if int(row["scene_id"]) in scene_ids],
            "audioRows": [row for row in self.final_edit_context["audioRows"] if int(row.get("scene_id") or 0) in scene_ids],
        }

    def save_final_edit_draft(self, project_id, user_id, draft_json):
        if project_id != 1 or user_id != 7:
            return False
        self.saved_final_edit_draft = json.loads(draft_json)
        self.final_edit_context["draft"] = {"draft_json": draft_json, "updated_at": "2026-10-20 11:00:00"}
        return True

    def get_user_count(self):
        """健康摘要用户数。"""
        return len(self.users)

    # ---- model-settings ----

    def get_model_settings_map(self):
        """持久化设置映射。"""
        return dict(self.model_settings)

    def upsert_model_setting(self, key, value, user_id):
        """设置 upsert（记录 updated_by 便于断言）。"""
        self.model_settings[key] = value
        self.model_settings[f"__updated_by__{key}"] = str(user_id)

    # ---- script-agent activities ----

    def list_script_agent_activities(self, project_id, user_id, limit):
        """活动列表（id 倒序 + LIMIT 钳位）。"""
        rows = [row for row in self.activities if row["project_id"] == project_id and row["user_id"] == user_id]
        return sorted(rows, key=lambda row: row["id"], reverse=True)[:limit]

    def load_script_agent_activity(self, activity_id, project_id, user_id):
        """按 id 加载活动。"""
        return next(
            (
                row
                for row in self.activities
                if row["id"] == activity_id and row["project_id"] == project_id and row["user_id"] == user_id
            ),
            None,
        )

    def insert_script_agent_activity(self, project_id, user_id, values):
        """插入活动（模拟 idempotency_key 唯一约束）。"""
        if values.get("idempotencyKey"):
            for row in self.activities:
                if row.get("idempotency_key") == values["idempotencyKey"]:
                    import pymysql

                    raise pymysql.MySQLError(1062)
        self.activity_seq += 1
        row = {
            "id": self.activity_seq,
            "project_id": project_id,
            "user_id": user_id,
            "stage_key": values.get("stageKey"),
            "action_key": values.get("actionKey"),
            "agent_key": values.get("agentKey"),
            "source": values.get("source"),
            "status": values.get("status"),
            "title": values.get("title"),
            "summary": values.get("summary"),
            "context_json": json.dumps(values.get("context") or {}),
            "result_json": json.dumps(values.get("result") or {}),
            "reaction_json": json.dumps(values.get("reaction") or {}),
            "idempotency_key": values.get("idempotencyKey") or None,
            "error_text": None,
            "started_at": "2026-01-01T00:00:00",
            "finished_at": None,
            "created_at": "2026-01-01T00:00:00",
            "updated_at": "2026-01-01T00:00:00",
        }
        self.activities.append(row)
        return dict(row)

    def update_script_agent_activity(self, activity_id, project_id, user_id, values):
        """更新活动终态。"""
        row = self.load_script_agent_activity(activity_id, project_id, user_id)
        if row is None:
            return None
        row.update(
            {
                "status": values.get("status"),
                "title": values.get("title"),
                "summary": values.get("summary"),
                "context_json": json.dumps(values.get("context") or {}),
                "result_json": json.dumps(values.get("result") or {}),
                "reaction_json": json.dumps(values.get("reaction") or {}),
                "error_text": values.get("errorText"),
                "finished_at": "2026-01-01T00:01:00",
            }
        )
        return dict(row)

    # ---- storyboard videos ----

    def get_shot_for_video_job(self, storyboard_id, user_id):
        """分镜归属查询（桩：仅 project 1 的分镜 5）。"""
        if self.shot_owner and int(storyboard_id) == 5:
            return self.shot_owner
        return None

    def list_storyboard_video_assets(self, storyboard_id):
        """视频候选列表。"""
        return list(self.video_assets.get(storyboard_id, []))

    # ---- story quality 写侧 ----

    def latest_story_bible_row(self, project_id):
        """最新故事设定行。"""
        rows = [row for row in self.story_bibles if row["project_id"] == project_id]
        return max(rows, key=lambda row: row["id"]) if rows else None

    def persist_story_bible(self, project_id, values):
        """故事设定持久化桩（递增 version_no）。"""
        row = {
            "id": len(self.story_bibles) + 1,
            "project_id": project_id,
            "version_no": len(self.story_bibles) + 1,
            **values,
        }
        self.story_bibles.append(row)
        return dict(row)

    def persist_season_structure(self, project_id, story_bible_id, values):
        """分集大纲持久化桩。"""
        row = {
            "id": len(self.season_structures) + 1,
            "project_id": project_id,
            "story_bible_id": story_bible_id,
            "version_no": len(self.season_structures) + 1,
            **values,
        }
        self.season_structures.append(row)
        return dict(row)

    # ---- exports 只读 ----

    def list_export_records(self, project_id):
        """导出记录列表（id 倒序）。"""
        rows = [row for row in self.exports if row["project_id"] == project_id]
        return sorted(rows, key=lambda row: row["id"], reverse=True)

    def get_export_record_with_owner(self, export_id):
        """导出记录 + 归属联查（对齐真实 SQL：ownerId 由 projects 联查得出）。"""
        row = next((dict(item) for item in self.exports if item["id"] == export_id), None)
        if row is not None:
            project = self.projects.get(row["project_id"])
            row["ownerId"] = project["user_id"] if project else None
        return row

    def export_package_rows(self, project_id, episode_no=None):
        if project_id != 1:
            return []
        return [
            dict(row) for row in self.export_rows
            if episode_no is None or row.get("episode_no") == episode_no
        ]

    def fetch_final_edit_draft(self, project_id):
        return self.final_edit_context.get("draft") if project_id == 1 else None

    def create_export_record(self, project_id, values):
        row = {"id": len(self.exports) + 1, "project_id": project_id, "status": "queued", **values}
        self.exports.append(row)
        return dict(row)


def make_client(database=None, **settings_kwargs):
    """构建运维端点测试客户端（第四阶段起恒为原生模式，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 OpsDatabase()。
    :param settings_kwargs: 透传给 Settings 的额外配置。
    :returns: 配置完成的 TestClient（raise_server_exceptions=False 以复用网关 500 envelope）。
    """
    settings = Settings(
        _env_file=None,
        **settings_kwargs,
    )
    return TestClient(create_app(settings, database=database or OpsDatabase()), raise_server_exceptions=False)


def assert_no_proxy_marker(response):
    """断言响应不含代理透传标记（任务门禁：处置路径绝不出现 x-forwarded-by）。

    :param response: TestClient 响应。
    """
    assert "x-forwarded-by" not in response.headers, (
        f"{response.request.method} {response.request.url.path} 出现代理透传标记 x-forwarded-by，"
        "兜底收口被绕过"
    )


# ---------------------------------------------------------------------------
# 一、兜底收口矩阵（核心门禁）
# ---------------------------------------------------------------------------


def test_fallback_proxy_is_retired():
    """未注册路径（含悬空调用域）返回 404/4040，不再透传 Node。

    Node 未匹配路径兜底为 ``fail(res, 4040, '接口不存在', 404)``（index.mjs L18352）；
    收口后 FastAPI 行为逐字对齐，A-16 悬空调用（market 审计等）行为不变（仍 4040）。
    """
    client = make_client()
    for path in (
        "/api/definitely-not-a-route",
        "/api/market/analyze",
        "/api/market/workspace",
        "/api/projects/1/cost-ledger",
        "/api/videos/1/recovery-review",
        "/api/exports/1/final-quality-regression-tags",
    ):
        response = client.get(path, headers=AUTH_HEADER)
        assert response.status_code == 404, path
        body = response.json()
        assert body["code"] == 4040 and body["message"] == "接口不存在", path
        assert_no_proxy_marker(response)


def test_all_501_exemption_routes_respond_5010():
    """豁免清单逐条断言：HTTP 501 + code 5010 + 理由文案 + 无透传标记。

    :raises AssertionError: 任一豁免路由未按显式 501 处置。
    """
    database = OpsDatabase()
    client = make_client(database)
    for path, methods, reason in OPS_FALLBACK_501_ROUTES:
        for method in methods:
            # 路径参数填最小合法值（int 段模板带 :int 转换器，一并替换）。
            concrete = (
                path.replace("{project_id:int}", "1")
                .replace("{project_id}", "1")
                .replace("{run_id:int}", "1")
                .replace("{run_id}", "1")
                .replace("{stage_key}", "asset-parse")
                .replace("{checkpoint_key}", "blueprint")
                .replace("{character_id:int}", "1")
                .replace("{character_id}", "1")
            )
            response = client.request(method, concrete, headers=AUTH_HEADER, json={})
            assert response.status_code == 501, f"{method} {concrete}"
            body = response.json()
            assert body["code"] == 5010, f"{method} {concrete}"
            assert reason in body["message"], f"{method} {concrete} 豁免理由未透出"
            assert_no_proxy_marker(response)


def test_501_route_with_invalid_id_falls_to_4040():
    """501 路由的 int 路径参数非整数时对齐 Node 兜底 4040（校验失败 → 404 envelope）。"""
    client = make_client()
    response = client.get("/api/agent-pipelines/not-an-int", headers=AUTH_HEADER)
    assert response.status_code == 404
    assert response.json()["code"] == 4040
    assert_no_proxy_marker(response)


def test_final_edit_get_builds_video_audio_draft_and_validation_view():
    database = OpsDatabase()

    response = make_client(database).get("/api/projects/1/final-edit", headers=AUTH_HEADER)

    assert response.status_code == 200
    payload = response.json()["data"]
    assert [item["storyboardId"] for item in payload["videoTrack"]["items"]] == [22, 21]
    assert payload["videoTrack"]["items"][0]["sourceType"] == "static"
    assert payload["videoTrack"]["items"][1]["videoUrl"] == "/generated/video/a.mp4"
    assert payload["audioTracks"]["dialogue"][0]["title"] == "对白轨 · 1 - 林夏"
    assert payload["validation"]["canExport"] is True
    assert payload["summary"]["totalStoryboardCount"] == 2
    assert_no_proxy_marker(response)


def test_final_edit_draft_put_normalizes_ids_audio_mix_and_persists():
    database = OpsDatabase()

    response = make_client(database).put(
        "/api/projects/1/final-edit-draft",
        headers=AUTH_HEADER,
        json={
            "videoClips": [
                {"storyboardId": 21, "enabled": False, "order": 8},
                {"storyboardId": 999, "order": 1},
                {"storyboardId": 21, "order": 2},
            ],
            "audioMix": {"dialogue": {"enabled": True, "volume": 150}, "music": {"volume": "bad"}},
        },
    )

    assert response.status_code == 200
    assert response.json()["message"] == "成片编辑草稿已保存"
    assert database.saved_final_edit_draft == {
        "videoClips": [{"storyboardId": 21, "enabled": False, "order": 8}],
        "audioMix": {
            "dialogue": {"enabled": True, "volume": 100},
            "narration": {"enabled": False, "volume": 100},
            "music": {"enabled": False, "volume": 100},
            "sfx": {"enabled": False, "volume": 100},
        },
    }
    assert response.json()["data"]["validation"]["canExport"] is False
    assert_no_proxy_marker(response)


def test_final_edit_routes_hide_and_reject_projects_owned_by_another_user():
    database = OpsDatabase()
    database.users["other-user-token"] = {**USER, "id": 8}
    client = make_client(database)
    other_user_headers = {"Authorization": "Bearer other-user-token"}

    get_response = client.get("/api/projects/1/final-edit", headers=other_user_headers)
    put_response = client.put(
        "/api/projects/1/final-edit-draft",
        headers=other_user_headers,
        json={"videoClips": [{"storyboardId": 21, "enabled": False}]},
    )

    assert get_response.status_code == 404
    assert get_response.json()["code"] == 4004
    assert put_response.status_code == 404
    assert put_response.json()["code"] == 4004
    assert database.saved_final_edit_draft is None
    assert_no_proxy_marker(get_response)
    assert_no_proxy_marker(put_response)


def test_export_create_validates_final_edit_and_persists_worker_queue_record():
    database = OpsDatabase()

    response = make_client(database).post(
        "/api/projects/1/exports",
        headers=AUTH_HEADER,
        json={"format": "MP4", "frameRate": 30, "hybridVideoPerScene": 9},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "导出任务已生成"
    assert response.json()["data"]["status"] == "queued"
    assert response.json()["data"]["videoUrl"] == "pending://hybrid-export"
    saved_config = json.loads(database.exports[0]["config_json"])
    assert saved_config["format"] == "MP4"
    assert saved_config["frameRate"] == 30
    assert saved_config["hybridVideoPerScene"] == 6
    assert saved_config["finalEditSummary"]["enabledVideoCount"] == 2
    assert_no_proxy_marker(response)


def test_episode_export_queues_only_the_episode_confirmed_videos_and_blocks_missing_video():
    database = OpsDatabase()
    database.export_rows = [
        {
            "scene_id": 4, "episode_no": 1, "scene_no": 1, "scene_title": "雨夜",
            "storyboard_id": 21, "shot_no": 1, "shot_type": "wide",
            "storyboard_duration_seconds": 4, "confirmed_video_asset_id": 31,
            "confirmed_video_duration_seconds": 3, "confirmed_video_url": "/generated/video/a.mp4",
            "image_url": "/generated/frame/a.png",
        },
        {
            "scene_id": 5, "episode_no": 2, "scene_no": 1, "scene_title": "清晨",
            "storyboard_id": 22, "shot_no": 1, "shot_type": "close",
            "storyboard_duration_seconds": 5, "confirmed_video_asset_id": None,
            "confirmed_video_duration_seconds": None, "confirmed_video_url": None,
            "image_url": "/generated/frame/b.png",
        },
    ]
    client = make_client(database)

    created = client.post(
        "/api/projects/1/exports", headers=AUTH_HEADER,
        json={"episodeNo": 1},
    )
    assert created.status_code == 200
    config = json.loads(database.exports[0]["config_json"])
    assert config["episodeNo"] == 1
    assert config["finalEditDraft"]["videoClips"] == [
        {"storyboardId": 21, "enabled": True, "order": 1},
    ]
    assert database.exports[0]["source_count"] == 1

    database.export_rows[0]["confirmed_video_asset_id"] = None
    database.export_rows[0]["confirmed_video_url"] = None
    blocked = client.post(
        "/api/projects/1/exports", headers=AUTH_HEADER,
        json={"episodeNo": 1},
    )
    assert blocked.status_code == 400
    assert "没有已确认视频" in blocked.json()["message"]
    assert len(database.exports) == 1


def test_export_create_rejects_projects_owned_by_another_user_without_queueing():
    database = OpsDatabase()
    database.users["other-user-token"] = {**USER, "id": 8}

    response = make_client(database).post(
        "/api/projects/1/exports",
        headers={"Authorization": "Bearer other-user-token"},
        json={},
    )

    assert response.status_code == 404
    assert response.json()["code"] == 4004
    assert database.exports == []
    assert_no_proxy_marker(response)


def test_export_create_blocks_empty_media_project_without_creating_queue_record():
    database = OpsDatabase()
    database.export_rows = []

    response = make_client(database).post("/api/projects/1/exports", headers=AUTH_HEADER, json={})

    assert response.status_code == 400
    assert response.json()["code"] == 4001
    assert response.json()["message"] == "当前所有视频片段都被禁用了，导出前至少保留一个启用片段。"
    assert database.exports == []
    assert_no_proxy_marker(response)


def test_agent_pipeline_list_returns_owner_scoped_run_views():
    database = OpsDatabase()
    database.agent_pipeline_views = [{
        "run": {
            "id": 9, "project_id": 1, "user_id": 7, "episode_no": 2,
            "status": "waiting_approval", "current_stage": "asset-review",
            "input_snapshot_json": '{"episodeNo":2}', "output_snapshot_json": None,
            "error_text": "", "idempotency_key": "pipeline-2",
            "created_at": "2026-10-19 10:00:00", "updated_at": "2026-10-19 10:01:00",
        },
        "executions": [{
            "id": 12, "pipeline_run_id": 9, "stage_key": "asset-parse", "agent_key": "asset-agent",
            "status": "completed", "attempt": 1, "idempotency_key": "pipeline-2:asset-parse",
            "input_snapshot_json": None, "output_snapshot_json": '{"characters":1}', "blockers_json": "[]",
            "error_text": "", "started_at": None, "finished_at": None, "created_at": None, "updated_at": None,
        }],
        "events": [{
            "id": 15, "pipeline_run_id": 9, "execution_id": 12, "stage_key": "asset-parse",
            "agent_key": "asset-agent", "attempt": 1, "status": "completed",
            "payload_json": '{"characters":1}', "created_at": "2026-10-19 10:01:00",
        }],
    }]

    response = make_client(database).get("/api/projects/1/agent-pipeline", headers=AUTH_HEADER)

    assert response.status_code == 200
    item = response.json()["data"]["items"][0]
    assert item["run"]["inputSnapshot"] == {"episodeNo": 2}
    assert item["run"]["outputSnapshot"] is None
    assert item["executions"][0]["outputSnapshot"] == {"characters": 1}
    assert item["executions"][0]["blockers"] == []
    assert item["events"][0]["payload"] == {"characters": 1}
    assert_no_proxy_marker(response)


def test_agent_pipeline_list_rejects_foreign_project():
    database = OpsDatabase()
    database.projects[2] = {"id": 2, "user_id": 99, "name": "foreign"}

    response = make_client(database).get("/api/projects/2/agent-pipeline", headers=AUTH_HEADER)

    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_agent_pipeline_detail_returns_run_with_execution_history():
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 9, "user_id": 7, "project_id": 1, "episode_no": 1, "input_snapshot_json": "{}"},
        "executions": [{"id": 12, "pipeline_run_id": 9, "stage_key": "asset-parse", "blockers_json": "[]"}],
        "events": [{"id": 15, "pipeline_run_id": 9, "stage_key": "asset-parse", "payload_json": "{}"}],
    }

    response = make_client(database).get("/api/agent-pipelines/9", headers=AUTH_HEADER)

    assert response.status_code == 200
    assert response.json()["data"]["run"]["id"] == 9
    assert response.json()["data"]["executions"][0]["stageKey"] == "asset-parse"
    assert response.json()["data"]["events"][0]["payload"] == {}


def test_agent_pipeline_detail_does_not_disclose_foreign_run():
    database = OpsDatabase()
    database.agent_pipeline_detail = {"run": {"id": 9, "user_id": 99}, "executions": [], "events": []}

    response = make_client(database).get("/api/agent-pipelines/9", headers=AUTH_HEADER)

    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_agent_pipeline_stage_action_registers_without_running_agent():
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 9, "user_id": 7, "project_id": 1, "episode_no": 2, "status": "paused"},
        "executions": [], "events": [],
    }

    response = make_client(database).post(
        "/api/agent-pipelines/9/stage-actions",
        headers=AUTH_HEADER,
        json={"stageKey": "character-lock", "idempotencyKey": "character-lock:manual:1",
              "status": "waiting_approval", "inputSnapshot": {"source": "editor"},
              "outputSnapshot": {"characters": [{"name": "林"}]}, "blockers": [], "errorText": ""},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "角色锁定 已登记"
    assert response.json()["data"]["run"]["id"] == 9


@pytest.mark.parametrize("body", [
    {"stageKey": "asset-parse", "idempotencyKey": "key"},
    {"stageKey": "storyboard", "idempotencyKey": "key"},
    {"stageKey": "unknown", "idempotencyKey": "key"},
    {"stageKey": "character-lock"},
])
def test_agent_pipeline_stage_action_rejects_invalid_stage_or_missing_idempotency(body):
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 9, "user_id": 7, "project_id": 1, "status": "completed"},
        "executions": [], "events": [],
    }

    response = make_client(database).post(
        "/api/agent-pipelines/9/stage-actions", headers=AUTH_HEADER, json=body
    )

    assert response.status_code == 400
    assert response.json()["code"] == 4001


def test_agent_pipeline_stage_action_requires_registerable_run_status():
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 9, "user_id": 7, "project_id": 1, "status": "queued"},
        "executions": [], "events": [],
    }

    response = make_client(database).post(
        "/api/agent-pipelines/9/stage-actions", headers=AUTH_HEADER,
        json={"stageKey": "character-lock", "idempotencyKey": "key"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == 4090


def test_project_scene_generation_creates_episode_scene_drafts_from_latest_season():
    database = OpsDatabase()
    database.season_structures = [{
        "id": 44,
        "episodes_json": json.dumps([
            {"title": "暴雨夜", "logline": "林夏发现异常", "opening_hook": "雨声中警报响起",
             "goal": "查清警报", "core_conflict": "门被锁住", "protagonist_choice": "继续调查",
             "irreversible_change": "监控被删除", "ending_hook": "门外有人"},
        ], ensure_ascii=False),
    }]

    response = make_client(database).post("/api/projects/1/scenes/generate", headers=AUTH_HEADER)

    assert response.status_code == 200
    assert response.json()["message"] == "场景列表已生成"
    assert response.json()["data"]["items"] == [{
        "id": 100, "projectId": 1, "episodeNo": 1, "outlineId": None, "sceneNo": 1,
        "title": "暴雨夜", "summary": "林夏发现异常\n开场钩子：雨声中警报响起\n本集目标：查清警报\n"
                  "核心冲突：门被锁住\n主角选择：继续调查\n不可逆变化：监控被删除\n结尾钩子：门外有人",
        "content": "", "spatialAnchors": None, "mood": None, "location": None,
        "timeOfDay": None, "estimatedDuration": 120, "sortOrder": 0, "status": "draft",
        "createdAt": None, "updatedAt": None,
    }]
    assert database.created_scene_specs[0]["episode_no"] == 1
    assert_no_proxy_marker(response)


def test_agent_pipeline_start_persists_a_worker_queued_run():
    """Starting a pipeline persists an idempotent queue entry; HTTP never executes an Agent inline."""
    database = OpsDatabase()
    database.scene_rows = [{"id": 21, "content": "雨夜里，林夏发现门没有锁。"}]

    response = make_client(database).post(
        "/api/projects/1/agent-pipeline/start",
        headers=AUTH_HEADER,
        json={"episodeNo": 1, "idempotencyKey": "pipeline-demo-1"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "Agent Pipeline 已入队"
    assert body["data"]["run"]["status"] == "queued"
    assert body["data"]["run"]["currentStage"] == "asset-parse"
    assert database.agent_pipeline_start_request == {
        "project_id": 1,
        "user_id": 7,
        "episode_no": 1,
        "idempotency_key": "pipeline-demo-1",
        "regenerate": False,
    }
    assert_no_proxy_marker(response)


def test_agent_pipeline_approval_queues_the_next_stage_without_running_it_inline():
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 91, "project_id": 1, "user_id": 7, "episode_no": 1,
                "status": "waiting_approval", "current_stage": "asset-parse",
                "input_snapshot_json": "{}", "output_snapshot_json": "{}", "idempotency_key": "run-91"},
        "executions": [{"id": 3, "pipeline_run_id": 91, "stage_key": "asset-parse",
                        "agent_key": "asset-parser-agent", "status": "waiting_approval"}],
        "events": [],
    }

    response = make_client(database).post(
        "/api/agent-pipelines/91/stages/asset-parse/decision",
        headers=AUTH_HEADER,
        json={"decision": "approve"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["run"]["status"] == "queued"
    assert response.json()["data"]["run"]["currentStage"] == "character-lock"
    assert_no_proxy_marker(response)


def test_agent_pipeline_decision_rejects_a_stage_without_waiting_execution():
    database = OpsDatabase()
    database.agent_pipeline_detail = {
        "run": {"id": 91, "project_id": 1, "user_id": 7, "episode_no": 1,
                "status": "running", "current_stage": "asset-parse",
                "input_snapshot_json": "{}", "output_snapshot_json": "{}", "idempotency_key": "run-91"},
        "executions": [{"id": 3, "pipeline_run_id": 91, "stage_key": "asset-parse",
                        "agent_key": "asset-parser-agent", "status": "running"}],
        "events": [],
    }

    response = make_client(database).post(
        "/api/agent-pipelines/91/stages/asset-parse/decision",
        headers=AUTH_HEADER,
        json={"decision": "approve"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == 4090


def test_project_scene_generation_requires_outline_and_never_overwrites_existing_scenes():
    database = OpsDatabase()
    client = make_client(database)
    missing = client.post("/api/projects/1/scenes/generate", headers=AUTH_HEADER)
    assert missing.status_code == 400
    assert missing.json()["code"] == 4001

    database.season_structures = [{"id": 44, "episodes_json": '[{"title":"新集","logline":"新故事"}]'}]
    database.scene_rows = [{"id": 9, "project_id": 1, "title": "已有剧本场景"}]
    protected = client.post(
        "/api/projects/1/scenes/generate", headers={**AUTH_HEADER, "x-confirm-regenerate": "true"}
    )
    assert protected.status_code == 409
    assert protected.json()["code"] == 4090
    assert database.scene_rows[0]["title"] == "已有剧本场景"


def test_project_scene_generation_falls_back_to_legacy_outline_scenes():
    database = OpsDatabase()
    database.outline_row = {
        "id": 45,
        "raw_json": json.dumps({"scenes": [{
            "episodeNo": "2", "sceneNo": "3", "title": "机房", "summary": "主角找到日志",
            "location": "公司机房", "timeOfDay": "深夜", "estimatedDuration": "45.5",
        }]}, ensure_ascii=False),
    }

    response = make_client(database).post("/api/projects/1/scenes/generate", headers=AUTH_HEADER)

    assert response.status_code == 200
    assert database.created_scene_specs == [{
        "episode_no": 2, "scene_no": 3, "title": "机房", "summary": "主角找到日志",
        "location": "公司机房", "time_of_day": "深夜", "estimated_duration": 45,
    }]


def test_outline_generation_persists_real_output_and_replaces_legacy_scene_rows(monkeypatch):
    database = OpsDatabase()
    database.projects[1].update({
        "category": "悬疑", "narrative_vision": "雨夜档案室", "visual_style": "冷色纪实",
        "target_duration": 40,
    })
    database.scene_rows = [{"id": 8, "project_id": 1, "title": "旧版场景"}]
    generated = {
        "title": "雨夜档案", "logline": "发现线索", "premise": "故事前提", "visual_style": "冷色",
        "acts": [{"act": index, "title": f"第{index}幕", "summary": f"幕{index}"} for index in (1, 2, 3)],
        "scenes": [{"scene_no": 1, "title": "档案室", "summary": "线索出现", "location": "档案室",
                    "time_of_day": "深夜", "estimated_duration": 300}],
    }
    async def generate(*_args, **_kwargs):
        return generated

    monkeypatch.setattr("app.main.ai_generate_outline", generate, raising=False)

    response = make_client(database).post("/api/projects/1/outline/generate", headers=AUTH_HEADER)

    assert response.status_code == 200
    assert response.json()["message"] == "总纲已生成"
    assert response.json()["data"]["acts"] == generated["acts"]
    assert response.json()["data"]["scenes"] == generated["scenes"]
    assert database.saved_outline["version_no"] == 2
    assert database.scene_rows == []
    assert_no_proxy_marker(response)


def test_outline_generation_blocks_modern_script_before_ai_and_preserves_scene_rows(monkeypatch):
    database = OpsDatabase()
    database.modern_outline_script = True
    database.scene_rows = [{"id": 8, "project_id": 1, "title": "新式剧本场景"}]
    monkeypatch.setattr(
        "app.main.ai_generate_outline",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI must not run")),
        raising=False,
    )

    response = make_client(database).post("/api/projects/1/outline/generate", headers=AUTH_HEADER)

    assert response.status_code == 409
    assert response.json()["code"] == 4090
    assert database.scene_rows[0]["title"] == "新式剧本场景"
    assert database.saved_outline is None


def test_outline_generation_provider_failure_does_not_delete_legacy_scenes(monkeypatch):
    from app.ai_provider import AiProviderError

    database = OpsDatabase()
    database.scene_rows = [{"id": 8, "project_id": 1, "title": "旧版场景"}]

    async def fail(*_args, **_kwargs):
        raise AiProviderError("模型暂时不可用")

    monkeypatch.setattr("app.main.ai_generate_outline", fail, raising=False)
    response = make_client(database).post("/api/projects/1/outline/generate", headers=AUTH_HEADER)

    assert response.status_code == 502
    assert response.json()["code"] == 5020
    assert database.scene_rows == [{"id": 8, "project_id": 1, "title": "旧版场景"}]
    assert database.saved_outline is None


def test_production_run_list_returns_node_compatible_rows():
    database = OpsDatabase()
    database.production_runs = [{
        "id": 21, "project_id": 1, "project_name": "运维测试项目", "episode_no": 3,
        "platform": "抖音", "name": "第三集样片", "status": "waiting_approval",
        "current_stage": "candidate-generation", "current_checkpoint": "blueprint",
        "pilot_mode": "two-scenes-golden-sample", "pilot_scene_count": 2, "budget": "12.50",
        "candidate_policy_json": '{"videoCandidates":3}', "success_metrics_json": '["quality"]',
        "input_snapshot_json": '{"episodeNo":3}', "output_snapshot_json": "bad-json",
        "failure_code": None, "failure_text": None, "created_at": "created", "updated_at": "updated",
    }]

    response = make_client(database).get("/api/projects/1/production-runs", headers=AUTH_HEADER)

    assert response.status_code == 200
    item = response.json()["data"]["items"][0]
    assert item == {
        "id": 21, "projectId": 1, "projectName": "运维测试项目", "episodeNo": 3,
        "platform": "抖音", "name": "第三集样片", "status": "waiting_approval",
        "currentStage": "candidate-generation", "currentCheckpoint": "blueprint",
        "pilotMode": "two-scenes-golden-sample", "pilotSceneCount": 2, "budget": 12.5,
        "candidatePolicy": {"videoCandidates": 3}, "successMetrics": ["quality"],
        "inputSnapshot": {"episodeNo": 3}, "outputSnapshot": {}, "failureCode": None,
        "failureText": None, "createdAt": "created", "updatedAt": "updated",
    }


def test_production_run_list_returns_empty_for_owned_project_and_hides_foreign_project():
    client = make_client()
    own_response = client.get("/api/projects/1/production-runs", headers=AUTH_HEADER)
    foreign_response = client.get("/api/projects/404/production-runs", headers=AUTH_HEADER)

    assert own_response.status_code == 200
    assert own_response.json()["data"]["items"] == []
    assert foreign_response.status_code == 404
    assert foreign_response.json()["code"] == 4004


def test_production_run_list_non_integer_project_id_falls_to_node_4040():
    response = make_client().get("/api/projects/not-an-id/production-runs", headers=AUTH_HEADER)

    assert response.status_code == 404
    assert response.json()["code"] == 4040


def test_production_run_detail_returns_node_compatible_read_only_view():
    database = OpsDatabase()
    database.production_run_detail = {
        "run": {"id": 21, "project_id": 1, "user_id": 7, "project_name": "运维测试项目", "episode_no": 3,
                "status": "waiting_approval", "candidate_policy_json": '{"videoCandidates":3}',
                "success_metrics_json": '["quality"]', "input_snapshot_json": '{"episodeNo":3}',
                "output_snapshot_json": None, "created_at": "created", "updated_at": "updated"},
        "stages": [{"id": 31, "stage_key": "candidate-generation", "sequence_no": 2,
                    "agent_key": "story-agent", "status": "completed", "input_snapshot_json": "{}",
                    "output_snapshot_json": "bad-json", "error_text": None, "started_at": "started",
                    "finished_at": "finished"}],
        "checkpoints": [{"id": 41, "checkpoint_key": "blueprint", "stage_key": "candidate-generation",
                         "status": "pending", "decision_note": None, "reviewed_at": None}],
        "agentExecutions": [{"id": 51, "agent_key": "story-agent", "status": "completed",
                             "model_name": "model-a", "output_json": '{"ok":true}'}],
        "blueprint": None,
    }

    response = make_client(database).get("/api/production-runs/21", headers=AUTH_HEADER)

    assert response.status_code == 200
    assert response.json()["data"] == {
        "run": {
            "id": 21, "projectId": 1, "projectName": "运维测试项目", "episodeNo": 3,
            "platform": "抖音", "name": "第 3 集黄金样片", "status": "waiting_approval",
            "currentStage": "planning", "currentCheckpoint": None,
            "pilotMode": "two-scenes-golden-sample", "pilotSceneCount": 2, "budget": None,
            "candidatePolicy": {"videoCandidates": 3}, "successMetrics": ["quality"],
            "inputSnapshot": {"episodeNo": 3}, "outputSnapshot": None, "failureCode": None,
            "failureText": None, "createdAt": "created", "updatedAt": "updated",
        },
        "stages": [{
            "id": 31, "stageKey": "candidate-generation", "sequenceNo": 2,
            "agentKey": "story-agent", "status": "completed", "inputSnapshot": {},
            "outputSnapshot": {}, "errorText": None, "startedAt": "started", "finishedAt": "finished",
        }],
        "checkpoints": [{
            "id": 41, "checkpointKey": "blueprint", "stageKey": "candidate-generation",
            "status": "pending", "decisionNote": None, "reviewedAt": None,
        }],
        "agentExecutions": [{
            "id": 51, "agentKey": "story-agent", "status": "completed",
            "modelName": "model-a", "output": {"ok": True},
        }],
        "blueprint": None,
    }
    assert_no_proxy_marker(response)


def test_production_run_detail_hides_missing_and_foreign_runs():
    database = OpsDatabase()
    database.production_run_detail = {"run": {"id": 21, "user_id": 99}, "stages": [],
                                      "checkpoints": [], "agentExecutions": [], "blueprint": None}
    client = make_client(database)

    for run_id in (21, 404):
        response = client.get(f"/api/production-runs/{run_id}", headers=AUTH_HEADER)
        assert response.status_code == 404
        assert response.json()["code"] == 4004


def test_production_run_detail_non_integer_id_falls_to_node_4040():
    response = make_client().get("/api/production-runs/not-an-id", headers=AUTH_HEADER)

    assert response.status_code == 404
    assert response.json()["code"] == 4040


def test_production_run_detail_maps_latest_blueprint_and_emotion_beats():
    database = OpsDatabase()
    database.production_run_detail = {
        "run": {"id": 21, "user_id": 7, "project_id": 1, "episode_no": 3},
        "stages": [], "checkpoints": [], "agentExecutions": [],
        "blueprint": {
            "row": {"id": 61, "production_run_id": 21, "project_id": 1, "episode_no": 3,
                    "version_no": 4, "status": "approved", "blueprint_json": '{"scenes":[]}',
                    "quality_report_json": "bad-json", "approved_at": "approved"},
            "emotionBeats": [{"beat_key": "opening", "phase": "hook", "label": "开场",
                              "sequence_no": 1, "duration_seconds": "2.5", "scene_no": None,
                              "shot_count": 3, "status": "ready"}],
        },
    }

    response = make_client(database).get("/api/production-runs/21", headers=AUTH_HEADER)

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["blueprint"] == {
        "id": 61, "productionRunId": 21, "projectId": 1, "episodeNo": 3, "versionNo": 4,
        "status": "approved", "blueprint": {"scenes": []}, "qualityReport": {},
        "emotionBeats": [{
            "id": "opening", "beatKey": "opening", "phase": "hook", "label": "开场",
            "sequenceNo": 1, "durationSeconds": 2.5, "emotionStart": "", "emotionProcess": "",
            "emotionEnd": "", "actionStart": "", "actionProcess": "", "actionEnd": "",
            "dialoguePlan": "", "soundPlan": "", "continuity": "", "sceneNo": None,
            "shotCount": 3, "status": "ready",
        }],
        "approvedAt": "approved",
    }


def test_production_run_create_is_native_idempotent_seed_with_quality_report():
    database = OpsDatabase()

    response = make_client(database).post(
        "/api/projects/1/production-runs", headers=AUTH_HEADER,
        json={"episodeNo": 2, "budget": 30, "idempotencyKey": "pilot-project-1-episode-2"},
    )

    assert response.status_code == 200
    assert database.production_created["idempotency_key"] == "pilot-project-1-episode-2"
    assert database.production_created["seed"]["run"]["currentCheckpoint"] == "market-validation"
    assert database.production_created["quality_report"]["canApprove"] is False
    assert response.json()["data"]["run"]["id"] == 77


def test_production_checkpoint_blueprint_gate_blocks_approval_without_quality_pass():
    database = OpsDatabase()
    database.production_run_detail = {
        "run": {"id": 21, "project_id": 1, "user_id": 7, "current_stage": "episode-blueprint",
                "current_checkpoint": "blueprint"},
        "stages": [], "checkpoints": [], "agentExecutions": [],
        "blueprint": {"row": {"id": 61, "production_run_id": 21, "project_id": 1,
                               "episode_no": 1, "version_no": 1, "blueprint_json": "{}",
                               "quality_report_json": '{"canApprove":false}'}, "emotionBeats": []},
    }

    response = make_client(database).post(
        "/api/production-runs/21/checkpoints/blueprint/decision", headers=AUTH_HEADER,
        json={"decision": "approve"},
    )

    assert response.status_code == 400
    assert "质量门禁" in response.json()["message"]
    assert database.production_transitions == []


# ---------------------------------------------------------------------------
# 二、GET /api/health
# ---------------------------------------------------------------------------


def test_api_health_native_payload():
    """健康摘要原生形状（对齐 Node L12218 字段族；FastAPI sms 语义差异见 docstring）。"""
    client = make_client()
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    data = body["data"]
    assert data["status"] == "ok"
    assert data["dbName"] == "projectdream"
    assert data["userCount"] == 1
    assert data["smsProvider"] == "mock" and data["smsReady"] is True
    assert data["objectStorageProvider"] == "local"
    for key in ("serverStartedAt", "port", "publicBaseUrl", "objectStoragePublicBaseUrl", "smsReason"):
        assert key in data
    assert_no_proxy_marker(response)


# ---------------------------------------------------------------------------
# 三、GET/PUT /api/model-settings
# ---------------------------------------------------------------------------


def test_model_settings_requires_auth():
    """未登录 401/4010（Node authenticate 同款）。"""
    client = make_client()
    for method, kwargs in (("get", {}), ("put", {"json": {}})):
        response = getattr(client, method)("/api/model-settings", **kwargs)
        assert response.status_code == 401
        assert response.json()["code"] == 4010


def test_model_settings_get_payload_shape():
    """GET 形状：groups 4 组、fields 47 项（Node L359-L410 基线 11+13+11+4+8）、secret 不回显。"""
    client = make_client()
    response = client.get("/api/model-settings", headers=AUTH_HEADER)
    assert response.status_code == 200
    data = response.json()["data"]
    assert [group["key"] for group in data["groups"]] == ["text", "frame", "video", "audio"]
    assert len(data["fields"]) == 47
    secret_fields = [field for field in data["fields"] if field["type"] == "secret"]
    assert secret_fields and all(field["value"] == "" for field in secret_fields)
    non_secret = next(field for field in data["fields"] if field["key"] == "AI_PROVIDER")
    assert non_secret["persisted"] is False and non_secret["source"] == "environment"
    # effective 分组形状（对齐 Node buildModelSettingsPayload 的 effective 键族）。
    assert set(data["effective"].keys()) == {"text", "frame", "video", "audio"}
    assert data["effective"]["text"]["provider"] in {"mock", "openai-compatible"}


def test_model_settings_put_roundtrip_and_validation():
    """PUT 往返：保存后 GET source=persisted；非法数值 400/4001；secret 空值跳过、未注册 key 忽略。"""
    database = OpsDatabase()
    client = make_client(database)
    # 非法数值（0 / 非整数）→ 400/4001，message 对齐 Node「{label} 必须是正整数」。
    bad = client.put(
        "/api/model-settings",
        headers=AUTH_HEADER,
        json={"settings": [{"key": "AI_TIMEOUT_MS", "value": "0"}]},
    )
    assert bad.status_code == 400 and bad.json()["code"] == 4001
    assert bad.json()["message"] == "AI_TIMEOUT_MS 必须是正整数".replace("AI_TIMEOUT_MS", "文本超时毫秒")

    # 正常保存：合法数值 + 布尔 + 文本 + secret 空值（跳过）+ 未知 key（忽略）。
    ok = client.put(
        "/api/model-settings",
        headers=AUTH_HEADER,
        json={
            "settings": [
                {"key": "AI_TIMEOUT_MS", "value": "90000"},
                {"key": "AI_FALLBACK_TO_MOCK", "value": "false"},
                {"key": "AI_BASE_URL", "value": "https://api.example.com/v1/"},
                {"key": "AI_API_KEY", "value": "   "},
                {"key": "NOT_A_FIELD", "value": "ignored"},
            ]
        },
    )
    assert ok.status_code == 200 and ok.json()["code"] == 0
    assert ok.json()["message"] == "模型设置已保存"
    assert database.model_settings["AI_TIMEOUT_MS"] == "90000"
    assert database.model_settings["AI_FALLBACK_TO_MOCK"] == "false"
    # 文本值仅 strip 首尾空白（对齐 Node normalizeModelSettingValue，不剥尾斜杠）。
    assert database.model_settings["AI_BASE_URL"] == "https://api.example.com/v1/"
    assert "AI_API_KEY" not in database.model_settings  # secret 空值跳过
    assert "NOT_A_FIELD" not in database.model_settings  # 未注册 key 忽略

    # 保存后再 GET：persisted=True / source=database；secret 仅回显 secretConfigured。
    fetched = client.get("/api/model-settings", headers=AUTH_HEADER).json()["data"]
    timeout_field = next(field for field in fetched["fields"] if field["key"] == "AI_TIMEOUT_MS")
    assert timeout_field["persisted"] is True and timeout_field["source"] == "database"
    assert timeout_field["value"] == "90000"
    api_key_field = next(field for field in fetched["fields"] if field["key"] == "AI_API_KEY")
    assert api_key_field["value"] == "" and api_key_field["secretConfigured"] is False


# ---------------------------------------------------------------------------
# 四、script-agent activities
# ---------------------------------------------------------------------------


def test_script_agent_activities_require_project():
    """项目缺失 404/4004（GET 与 POST 同款前置）。"""
    client = make_client()
    for method, kwargs in (("get", {}), ("post", {"json": {"phase": "start"}})):
        response = getattr(client, method)("/api/projects/999/script-agent/activities", headers=AUTH_HEADER, **kwargs)
        assert response.status_code == 404
        assert response.json()["code"] == 4004


def test_script_agent_activities_list_limit_clamp():
    """GET 列表：limit 钳位 1-100、缺省 40；行形状含 reaction/context/result 对象。"""
    database = OpsDatabase()
    for index in range(3):
        database.activities.append(
            {
                "id": index + 1,
                "project_id": 1,
                "user_id": 7,
                "stage_key": "bible",
                "action_key": "generate-bible",
                "agent_key": "script-agent",
                "source": "button",
                "status": "completed",
                "title": "重新生成故事设定",
                "summary": "",
                "context_json": "{}",
                "result_json": '{"characterCount": 3}',
                "reaction_json": '{"tone": "success"}',
                "idempotency_key": None,
                "error_text": None,
                "started_at": None,
                "finished_at": None,
                "created_at": None,
                "updated_at": None,
            }
        )
    client = make_client(database)
    response = client.get("/api/projects/1/script-agent/activities?limit=2", headers=AUTH_HEADER)
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["id"] for item in items] == [3, 2]  # id 倒序 + LIMIT 2
    assert items[0]["context"] == {} and items[0]["result"] == {"characterCount": 3}
    assert items[0]["stageKey"] == "bible" and items[0]["agentKey"] == "script-agent"


def test_script_agent_activity_start_idempotent_and_invalid_phase():
    """POST start：插入成功 → 同幂等键复用（「活动已存在」）；非法 phase 400/4001。"""
    database = OpsDatabase()
    client = make_client(database)
    payload = {
        "phase": "start",
        "actionKey": "generate-bible",
        "idempotencyKey": "ops-idem-1",
        "summary": "开始生成",
        "result": {"characterCount": 4},
    }
    first = client.post("/api/projects/1/script-agent/activities", headers=AUTH_HEADER, json=payload)
    assert first.status_code == 200
    assert first.json()["message"] == "Script Agent 已开始执行"
    assert first.json()["data"]["item"]["status"] == "running"
    # running 的 reaction 形状（对齐 Node buildScriptAgentReaction running 分支）。
    reaction = first.json()["data"]["reaction"]
    assert reaction["tone"] == "working" and reaction["headline"] == "重新生成故事设定已开始"

    second = client.post("/api/projects/1/script-agent/activities", headers=AUTH_HEADER, json=payload)
    assert second.status_code == 200
    assert second.json()["message"] == "Script Agent 活动已存在"
    assert second.json()["data"]["item"]["id"] == first.json()["data"]["item"]["id"]

    invalid = client.post(
        "/api/projects/1/script-agent/activities",
        headers=AUTH_HEADER,
        json={"phase": "paused"},
    )
    assert invalid.status_code == 400 and invalid.json()["code"] == 4001

    unknown_action = client.post(
        "/api/projects/1/script-agent/activities",
        headers=AUTH_HEADER,
        json={"phase": "start", "actionKey": "no-such-action"},
    )
    assert unknown_action.status_code == 400 and unknown_action.json()["code"] == 4001


def test_script_agent_activity_completion_update():
    """POST complete：activityId 命中后 UPDATE 终态；缺失 404/4004。"""
    database = OpsDatabase()
    client = make_client(database)
    started = client.post(
        "/api/projects/1/script-agent/activities",
        headers=AUTH_HEADER,
        json={"phase": "start", "actionKey": "save-bible", "idempotencyKey": "ops-idem-2"},
    ).json()["data"]["item"]

    completed = client.post(
        "/api/projects/1/script-agent/activities",
        headers=AUTH_HEADER,
        json={"phase": "complete", "activityId": started["id"], "result": {"versionNo": 3}},
    )
    assert completed.status_code == 200
    assert completed.json()["message"] == "Script Agent 活动已更新"
    item = completed.json()["data"]
    assert item["item"]["status"] == "completed"
    # 完成 reaction：versionNo 提示插入 facts 首位（对齐 Node facts 组装）。
    assert item["reaction"]["tone"] == "success"
    assert item["reaction"]["facts"][0] == "已写入第 3 版结果"

    missing = client.post(
        "/api/projects/1/script-agent/activities",
        headers=AUTH_HEADER,
        json={"phase": "fail", "activityId": 999},
    )
    assert missing.status_code == 404 and missing.json()["code"] == 4004


# ---------------------------------------------------------------------------
# 五、story-bible / season-structure 写侧（PUT + evaluate + lock）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("resource", ["story-bible", "season-structure"])
def test_story_quality_write_save_and_lock(resource):
    """PUT 保存（draft）→ POST lock（locked + 「已确认」message）→ 版本递增。"""
    database = OpsDatabase()
    client = make_client(database)
    base = f"/api/projects/1/{resource}"
    body = {"title": "测试设定"} if resource == "story-bible" else {"seasonTheme": "成长", "episodeCount": 2}

    saved = client.put(base, headers=AUTH_HEADER, json=body)
    assert saved.status_code == 200
    assert saved.json()["message"] == ("故事设定已保存" if resource == "story-bible" else "分集大纲已保存")
    first_item = saved.json()["data"]["item"]
    assert first_item["status"] == "draft" and first_item["versionNo"] == 1
    assert "report" in saved.json()["data"]

    # evaluate 与 PUT 同分支：同样落库新版本（对齐 Node L13177 分支语义）。
    evaluated = client.post(f"{base}/evaluate", headers=AUTH_HEADER, json=body)
    assert evaluated.status_code == 200
    assert evaluated.json()["data"]["item"]["status"] == "draft"
    assert evaluated.json()["message"].endswith("已保存")

    locked = client.post(f"{base}/lock", headers=AUTH_HEADER, json=body)
    assert locked.status_code == 200
    assert locked.json()["data"]["item"]["status"] == "locked"
    assert locked.json()["message"] == ("故事设定已确认" if resource == "story-bible" else "分集大纲已确认")
    assert locked.json()["data"]["item"]["versionNo"] == 3

    # 非法子动作 → 4040（Node 正则不匹配落全局兜底）。
    invalid = client.post(f"{base}/no-such-action", headers=AUTH_HEADER, json=body)
    assert invalid.status_code == 404 and invalid.json()["code"] == 4040


def test_story_quality_write_requires_auth_and_project():
    """写侧未登录 401 / 项目缺失 404。"""
    client = make_client()
    assert client.put("/api/projects/1/story-bible", json={}).status_code == 401
    assert client.put("/api/projects/999/story-bible", headers=AUTH_HEADER, json={}).status_code == 404


# ---------------------------------------------------------------------------
# 六、GET /api/storyboards/{id}/videos
# ---------------------------------------------------------------------------


def test_storyboard_videos_list():
    """视频候选列表：成功形状 + 分镜缺失 404 + 非法 id 400。"""
    database = OpsDatabase()
    database.video_assets[5] = [
        {
            "id": 11,
            "storyboard_id": 5,
            "version_no": 2,
            "video_url": "http://media.example/v2.mp4",
            "status": "confirmed",
        },
        {"id": 9, "storyboard_id": 5, "version_no": 1, "video_url": "http://media.example/v1.mp4", "status": "archived"},
    ]
    client = make_client(database)
    response = client.get("/api/storyboards/5/videos", headers=AUTH_HEADER)
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["id"] for item in items] == [11, 9]  # version_no DESC

    assert client.get("/api/storyboards/404/videos", headers=AUTH_HEADER).status_code == 404
    assert client.get("/api/storyboards/0/videos", headers=AUTH_HEADER).status_code == 400


# ---------------------------------------------------------------------------
# 七、exports 只读（列表 / 详情）
# ---------------------------------------------------------------------------


def test_project_exports_list_and_detail():
    """列表 + 详情 + 越权/缺失 404（Node 统一文案）+ config_json 解析。"""
    database = OpsDatabase()
    database.exports = [
        {
            "id": 2,
            "project_id": 1,
            "status": "queued",
            "video_url": "pending://hybrid-export",
            "storage_key": "projects/1/exports/e2.mp4",
            "cover_url": "http://media.example/cover.jpg",
            "duration_seconds": None,
            "config_json": json.dumps({"format": "H.264 / MP4", "burnSubtitle": True}),
            "source_count": 12,
            "ready_count": 12,
            "missing_count": 0,
            "created_at": "2026-01-01T00:00:00",
            "updated_at": "2026-01-01T00:00:00",
        },
        {
            "id": 1,
            "project_id": 1,
            "status": "failed",
            "video_url": None,
            "config_json": "{invalid json",
            "source_count": 3,
            "ready_count": 1,
            "missing_count": 2,
        },
    ]
    client = make_client(database)

    listing = client.get("/api/projects/1/exports", headers=AUTH_HEADER)
    assert listing.status_code == 200
    items = listing.json()["data"]["items"]
    assert [item["id"] for item in items] == [2, 1]
    assert items[1]["config"] is None  # 非法 JSON → None（对齐 Node try/catch）

    detail = client.get("/api/exports/2", headers=AUTH_HEADER)
    assert detail.status_code == 200
    record = detail.json()["data"]
    assert record["status"] == "queued" and record["sourceCount"] == 12
    assert record["videoUrl"]  # storage_key 命中 → 签名/回退 URL 非空

    assert client.get("/api/exports/999", headers=AUTH_HEADER).status_code == 404
    assert client.get("/api/exports/0", headers=AUTH_HEADER).status_code == 400
    assert client.get("/api/projects/999/exports", headers=AUTH_HEADER).status_code == 404


# ---------------------------------------------------------------------------
# 八、域函数：script_agent reaction（Node services/script-agent.test.mjs 对照）
# ---------------------------------------------------------------------------


def test_script_agent_reaction_branches():
    """reaction 四分支形状（running/failed/blocked/completed + nextActions 兜底链）。"""
    from app.domain.script_agent import build_script_agent_activity_payload

    working = build_script_agent_activity_payload({"actionKey": "generate-season", "status": "running"})
    assert working["reaction"]["tone"] == "working"
    assert working["reaction"]["message"] == "我正在读取当前分集大纲并执行这项操作。"

    failed = build_script_agent_activity_payload(
        {"actionKey": "generate-script", "status": "failed", "errorText": "模型超时"}
    )
    assert failed["reaction"]["tone"] == "danger"
    assert failed["reaction"]["nextActions"] == [{"key": "retry", "label": "重试当前动作", "actionKey": "generate-script"}]

    blocked = build_script_agent_activity_payload(
        {
            "actionKey": "save-bible",
            "status": "blocked",
            "result": {"blockers": ["缺少总纲"], "nextActions": ["先生成总纲", "再保存"]},
        }
    )
    assert blocked["reaction"]["tone"] == "warning"
    assert blocked["reaction"]["facts"] == ["缺少总纲"]
    assert [action["key"] for action in blocked["reaction"]["nextActions"]] == ["next-0", "next-1"]

    completed = build_script_agent_activity_payload(
        {"actionKey": "parse-assets", "status": "completed", "result": {"characterCount": 5, "sceneCount": 2}}
    )
    assert completed["reaction"]["tone"] == "success"
    assert completed["reaction"]["nextActions"][0]["label"] == "复核 5 个角色 / 2 个场景"

    # 无专项 nextActions 时回退动作注册表的 nextAction（Node ACTIONS 链）。
    plain = build_script_agent_activity_payload({"actionKey": "save-season", "status": "completed"})
    assert plain["reaction"]["nextActions"] == [
        {"key": "generate-script", "label": "生成剧本正文", "actionKey": "generate-script"}
    ]

    # 非法状态/动作 → ValueError（message 对齐 Node）。
    import pytest as _pytest

    with _pytest.raises(ValueError):
        build_script_agent_activity_payload({"actionKey": "no-such", "status": "running"})
    with _pytest.raises(ValueError):
        build_script_agent_activity_payload({"actionKey": "save-bible", "status": "paused"})


# ---------------------------------------------------------------------------
# 九、501 豁免回归（第四阶段 flag 已删除：豁免路由与 flag 无关，恒 501）
# ---------------------------------------------------------------------------


def test_tts_routes_are_removed_from_501_exemption_registry():
    """TTS API paths must be native; no route-level 501 exemption remains."""
    assert OPS_FALLBACK_501_ROUTES == ()
    client = make_client()
    response = client.post("/api/projects/1/audio/generate", headers=AUTH_HEADER, json={})
    assert response.status_code == 400 and response.json()["code"] == 4001
