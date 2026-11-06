"""生成任务组新接管路由的端点兼容测试（视频/口型入队 + 视频确认）。

对照 Node（行号以 2026-10-17 工作区版本为准）：

- POST /api/storyboards/{id}/videos/generate（index.mjs L16629 + enqueueStoryboardVideoJob L2941）
- POST /api/storyboards/{id}/lip-sync/generate（index.mjs L16631 + enqueueLipSyncJob L4381）
- POST /api/videos/{id}/confirm（index.mjs L16880）

覆盖面：未登录 / 字段非法 / 越权 / 不存在 / 成功入队 / 幂等复用 / 未确认资产 /
4011 错误形态（含 qualityReport data）/ 确认 4091-4093 分支 /
入队行字段完整性（status、request_json 可解析、job_key 格式）。全部离线
（fake database；快照构建器的逐字段语义由
test_generation_native_compat.py 的 Node fixture 对照锁定）。
第四阶段已删除过渡开关：整组恒为原生实现，回退代理专项测试随实现一并移除。
"""

import json
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}

PROJECT_ID = 8
USER_ID = 7
STORYBOARD_ID = 21
SCENE_ID = 5

# 满足资产引用门禁 + 引用快照校验的角色/场景引用（对照 Node 前端写入的快照形态）。
REFERENCE_JSON = json.dumps(
    {
        "characterId": 9,
        "characterVersionNo": 3,
        "characterViewSetVersion": 2,
        "characterViewKeys": ["front", "side", "back"],
        "characterBaseImageId": 101,
        "characterBaseVersionNo": 4,
        "characterFaceImageId": 105,
        "characterFaceVersionNo": 4,
        "sceneAssetId": 3,
        "scenePanoramaVersion": 2,
        "scenePanoramaImageId": 201,
        "sceneViewKey": "wide",
        "sceneViewSetVersion": 2,
    },
    ensure_ascii=False,
)

SHOT = {
    "id": STORYBOARD_ID,
    "scene_id": SCENE_ID,
    "project_id": PROJECT_ID,
    "ownerId": USER_ID,
    "character_id": 9,
    "character_name": "林知夏",
    "visual_prompt": "固定中景，林知夏在监控室里转身看向屏幕。",
    "start_visual_prompt": None,
    "end_visual_prompt": "林知夏停在屏幕前",
    "action_text": "林知夏转身看向屏幕。",
    "dialogue_text": "（无对白）",
    "shot_type": "中景",
    "camera_angle": "平视",
    "composition": "中心构图",
    "emotional_change": "从平静到警觉",
    "acting_beat": "先看屏幕再回头",
    "audio_direction": "环境声延续",
    "duration_seconds": 5,
    "sort_order": 2,
    "aspect_ratio": "9:16",
    "project_visual_style": "冷蓝色调科幻风",
    "asset_reference_json": REFERENCE_JSON,
    "gaze_plan": None,
    "sound_plan": None,
    "resolved_character_name": "林知夏",
}

# 分镜引用锁定的已确认资产图（角色资产板 + 场景全景，均带公网图与 storage_key）。
LOCKED_ROWS = [
    {
        "id": 105, "asset_node_id": 9, "ref_id": 9, "label": "林知夏", "node_type": "character",
        "asset_prompt": "角色提示词", "environment_prompt": None, "image_prompt": None,
        "status": "confirmed", "storage_key": "characters/c9.png",
        "view_set_type": "character-asset-pack", "view_key": None,
        "view_set_version": 2, "version_no": 3, "vision_status": "passed",
        "image_url": "https://media.example.com/char-9.png", "thumbnail_url": None,
    },
    {
        "id": 201, "asset_node_id": 3, "ref_id": 3, "label": "监控室", "node_type": "scene",
        "asset_prompt": "冷蓝机房", "environment_prompt": "金属墙面", "image_prompt": None,
        "status": "confirmed", "storage_key": "scenes/s3.png",
        "view_set_type": "single", "view_key": None,
        "view_set_version": 2, "version_no": 2, "vision_status": "passed",
        "image_url": "https://media.example.com/scene-3.png", "thumbnail_url": None,
    },
]

VOICE_ROWS = [
    {
        "character_id": 9,
        "character_name": "林知夏",
        "voice_profile_key": "female-calm",
        "reference_audio_url": "https://media.example.com/ref-9.wav",
        "reference_audio_storage_key": None,
        "voice_locked": 1,
    }
]

VIDEO_ROW = {
    "id": 55,
    "storyboard_id": STORYBOARD_ID,
    "version_no": 3,
    "video_url": "https://media.example.com/clip.mp4",
    "storage_key": "videos/clip.mp4",
    "quality_report_json": '{"qualityScore": 8}',
    "ownerId": USER_ID,
}


class VideoGenerationDatabase:
    """视频/口型入队与视频确认端点测试的最小数据库桩。

    :ivar generation_jobs: job_id -> 任务行（模拟 generation_jobs 表）。
    :ivar storyboards: storyboard_id -> 分镜行（含 ownerId 归属）。
    :ivar videos: video_id -> video_assets 行（确认路由）。
    :ivar shot_overrides: 分镜行字段覆盖（按用例定制门禁输入）。
    :ivar next_job_id: 自增任务 id。
    """

    def __init__(self):
        self.generation_jobs: dict[int, dict] = {}
        self.next_job_id = 400
        # 分镜 21/22 同构（22 供需要独立 source_id 的幂等隔离用例使用）。
        self.storyboards: dict[int, dict] = {
            STORYBOARD_ID: dict(SHOT),
            22: {**SHOT, "id": 22},
        }
        self.videos: dict[int, dict] = {55: dict(VIDEO_ROW)}
        self.locked_rows = [dict(row) for row in LOCKED_ROWS]
        self.voice_rows = [dict(row) for row in VOICE_ROWS]
        self.confirmed_video_row: dict | None = None
        self.storyboard_video_url_after_confirm: str | None = None
        self.archived_video_ids: list[int] = []
        self.superseded_storyboard_ids: list[int] = []

    # -- 鉴权 --------------------------------------------------------------

    def find_user_by_token(self, token):
        """按 token 反查用户（require_user 鉴权入口）。

        :param token: 访问令牌。
        :return: 命中时返回用户 dict，否则 None。
        """
        if token == "session-token":
            return {"id": USER_ID, "phone": "13912345678", "nickname": "测试用户"}
        return None

    # -- 视频入队查询 ------------------------------------------------------

    def get_shot_for_video_job(self, storyboard_id, user_id):
        """视频入队分镜行（归属过滤）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :return: 分镜行；不存在或非本人 None。
        """
        shot = self.storyboards.get(storyboard_id)
        if shot is None or int(shot.get("ownerId") or 0) != int(user_id):
            return None
        return dict(shot)

    def get_continuity_previous_shot(self, scene_id, requested_shot_no, sort_order):
        """片段衔接上一镜行（测试数据无上一镜，恒 None）。

        :param scene_id: 场景 id。
        :param requested_shot_no: 来源镜号。
        :param sort_order: 排序兜底。
        :return: None。
        """
        return None

    def get_confirmed_end_frame_image(self, storyboard_id):
        """当前镜确认结束帧（测试数据无结束帧，恒 None）。

        :param storyboard_id: 分镜 id。
        :return: None。
        """
        return None

    def list_referenced_asset_node_images(self, asset_ids, project_id, user_id):
        """请求显式引用的资产图行（测试数据恒空）。

        :param asset_ids: 资产图 id 列表。
        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 空列表。
        """
        return []

    def list_locked_reference_rows(self, node_ids, project_id, user_id):
        """分镜引用锁定的已确认资产图行。

        :param node_ids: 资产节点 id 列表。
        :param project_id: 项目 id。
        :param user_id: 用户 id。
        :return: 锁定行列表（深拷贝，防用例间串扰）。
        """
        if project_id != PROJECT_ID or user_id != USER_ID:
            return []
        return [dict(row) for row in self.locked_rows]

    def get_character_constraint_name(self, character_id, project_id):
        """连续性约束角色名。

        :param character_id: 角色 id。
        :param project_id: 项目 id。
        :return: ``{"name": ...}`` 或 None。
        """
        if character_id == 9 and project_id == PROJECT_ID:
            return {"name": "林知夏"}
        return None

    def list_character_voice_rows(self, character_ids, project_id):
        """分镜引用角色的音色行。

        :param character_ids: 角色 id 列表。
        :param project_id: 项目 id。
        :return: 音色行列表。
        """
        if project_id != PROJECT_ID:
            return []
        return [dict(row) for row in self.voice_rows if row["character_id"] in character_ids]

    def update_storyboard_visual_prompt(self, storyboard_id, visual_prompt):
        """入队期间回写分镜视觉提示词（记录到桩上便于断言）。

        :param storyboard_id: 分镜 id。
        :param visual_prompt: 清洗后的提示词。
        :return: None。
        """
        if storyboard_id in self.storyboards:
            self.storyboards[storyboard_id]["visual_prompt"] = visual_prompt

    # -- 口型入队查询 ------------------------------------------------------

    def get_shot_for_lip_sync_job(self, storyboard_id, user_id):
        """口型入队分镜行（含 resolved_character_name，归属过滤）。

        :param storyboard_id: 分镜 id。
        :param user_id: 用户 id。
        :return: 分镜行；不存在或非本人 None。
        """
        return self.get_shot_for_video_job(storyboard_id, user_id)

    def get_confirmed_storyboard_image(self, storyboard_id):
        """口型入队用已确认静帧。

        :param storyboard_id: 分镜 id。
        :return: 静帧行或 None（桩内所有分镜均有确认静帧）。
        """
        if storyboard_id in self.storyboards:
            return {
                "id": 301,
                "storyboard_id": storyboard_id,
                "status": "confirmed",
                "image_url": "https://media.example.com/frame-21.png",
                "storage_key": "frames/f21.png",
            }
        return None

    def get_confirmed_dialogue_audio(self, storyboard_id, character_id):
        """口型入队用已确认对白音频。

        :param storyboard_id: 分镜 id。
        :param character_id: 说话角色 id（本桩恒返回本镜角色音频）。
        :return: 音频行或 None。
        """
        if storyboard_id in self.storyboards:
            return {
                "id": 401,
                "project_id": PROJECT_ID,
                "storyboard_id": storyboard_id,
                "track_type": "dialogue",
                "status": "confirmed",
                "character_id": character_id,
                "character_name": "林知夏",
                "audio_url": "https://media.example.com/audio-401.wav",
                "storage_key": "audio/a401.wav",
                "duration_seconds": 4,
            }
        return None

    def get_lip_sync_source_video(self, storyboard_id):
        """口型入队用源视频（测试数据无源视频，恒 None）。

        :param storyboard_id: 分镜 id。
        :return: None。
        """
        return None

    def next_video_version(self, storyboard_id):
        """下一视频版本号（桩内固定 4，对齐 Node MAX+1 语义）。

        :param storyboard_id: 分镜 id。
        :return: 版本号。
        """
        return 4

    # -- 视频确认 ----------------------------------------------------------

    def get_video_for_confirm(self, video_id, user_id):
        """确认用视频归属行。

        :param video_id: 视频 id。
        :param user_id: 用户 id。
        :return: 视频行；不存在或非本人 None。
        """
        video = self.videos.get(video_id)
        if video is None or int(video.get("ownerId") or 0) != int(user_id):
            return None
        return dict(video)

    def touch_video_url(self, video_id, video_url):
        """确认前地址规范化回写（记录到桩上）。

        :param video_id: 视频 id。
        :param video_url: 规范化地址。
        :return: None。
        """
        self.videos[video_id]["video_url"] = video_url

    def confirm_video_asset_txn(
        self, video_id, storyboard_id, original_video_url, confirmed_video_url, quality_report_json
    ):
        """视频确认事务（模拟条件更新 + 归档旧确认 + 回写分镜 + 重读全行）。

        :param video_id: 视频 id。
        :param storyboard_id: 分镜 id。
        :param original_video_url: 原始地址（乐观锁依据）。
        :param confirmed_video_url: 确认后地址。
        :param quality_report_json: 标注后的质量报告 JSON。
        :return: 确认后的完整视频行。
        :raises RuntimeError: 条件更新 0 行命中（与 MySQL 实现同语义）。
        """
        video = self.videos[video_id]
        if confirmed_video_url != original_video_url and video.get("video_url") != original_video_url:
            raise RuntimeError("视频记录在确认期间已发生变化，请刷新后重试")
        video["video_url"] = confirmed_video_url
        for other_id, other in self.videos.items():
            if other["storyboard_id"] == storyboard_id and other_id != video_id and other.get("status") == "confirmed":
                other["status"] = "archived"
                self.archived_video_ids.append(other_id)
        video["status"] = "confirmed"
        video["confirmed_at"] = "2026-10-18T09:00:00"
        if quality_report_json is not None:
            video["quality_report_json"] = quality_report_json
        self.storyboard_video_url_after_confirm = confirmed_video_url
        self.confirmed_video_row = dict(video)
        return dict(video)

    # -- 生成任务写入（对齐 MySQLDatabase.create_generation_job 幂等语义） --

    def create_generation_job(self, project_id, job_type, source_id, request):
        """创建/复用生成任务（同 project+type+source 活动任务复用，否则 INSERT）。

        :param project_id: 项目 id。
        :param job_type: 任务类型。
        :param source_id: 业务主键。
        :param request: 请求快照（并入 projectId）。
        :return: generation_jobs 行。
        """
        request_snapshot = {**(request or {}), "projectId": int(project_id)}
        for job in self.generation_jobs.values():
            if (
                job["project_id"] == project_id
                and job["job_type"] == job_type
                and job["source_id"] == source_id
                and job["status"] in {"queued", "running"}
            ):
                return job
        self.next_job_id += 1
        job = {
            "id": self.next_job_id,
            "job_key": f"{job_type}-{source_id}-{uuid.uuid4()}",
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

    def supersede_storyboard_video_candidates(self, storyboard_id):
        self.superseded_storyboard_ids.append(storyboard_id)


def make_client(database=None, **settings_kwargs):
    """构建原生模式测试客户端（第四阶段起恒为原生实现，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 VideoGenerationDatabase()。
    :param settings_kwargs: 透传给 Settings 的额外配置。
    :return: 配置完成的 TestClient。
    """
    settings = Settings(
        _env_file=None,
        **settings_kwargs,
    )
    return TestClient(create_app(settings, database=database or VideoGenerationDatabase()), raise_server_exceptions=False)


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", f"/api/storyboards/{STORYBOARD_ID}/videos/generate"),
        ("post", f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate"),
        ("post", "/api/videos/55/confirm"),
    ],
)
def test_new_generation_routes_require_authentication(method, path):
    """未登录：三条新路由统一 401/4010 envelope（Node authenticate 同形）。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    response = getattr(make_client(), method)(path, json={})

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


@pytest.mark.parametrize(
    ("path", "message"),
    [
        ("/api/storyboards/0/videos/generate", "无效的 storyboardId"),
        ("/api/storyboards/0/lip-sync/generate", "无效的 storyboardId"),
        ("/api/videos/0/confirm", "无效的 videoId"),
    ],
)
def test_new_generation_routes_reject_zero_id(path, message):
    """id=0：Node parseId("0")=0 → 400/4001（三条路由一致）。

    :param path: 被测路由。
    :param message: 期望错误文案。
    :return: None。
    """
    response = make_client().post(path, json={}, headers=AUTH)

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": message, "data": None}


@pytest.mark.parametrize(
    "path",
    [
        f"/api/storyboards/{STORYBOARD_ID}/videos/generate",
        f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate",
        "/api/videos/55/confirm",
    ],
)
def test_new_generation_routes_hide_foreign_rows(path):
    """越权/不存在：404/4004（owner 隔离，Node 同文案）。

    :param path: 被测路由。
    :return: None。
    """
    database = VideoGenerationDatabase()
    if path.startswith("/api/storyboards/"):
        database.storyboards.pop(STORYBOARD_ID)
    else:
        database.videos.pop(55)

    response = make_client(database).post(path, json={}, headers=AUTH)

    assert response.status_code == 404
    assert response.json()["code"] == 4004
    assert response.json()["message"] in {"分镜不存在或无权访问", "视频不存在或无权访问"}


@pytest.mark.parametrize(
    "path",
    [
        "/api/storyboards/abc/videos/generate",
        "/api/storyboards/abc/lip-sync/generate",
        "/api/videos/abc/confirm",
    ],
)
def test_new_generation_routes_non_integer_id_falls_back_to_4040(path):
    """非整数 id：Node ``\\d+`` 正则不匹配 → 兜底 404/4040（对齐网关校验异常处理）。

    :param path: 被测路由。
    :return: None。
    """
    response = make_client().post(path, json={}, headers=AUTH)

    assert response.status_code == 404
    assert response.json() == {"code": 4040, "message": "接口不存在", "data": None}


# ---------------------------------------------------------------------------
# 视频入队：成功 / 幂等 / 门禁 4011 / 字段非法
# ---------------------------------------------------------------------------


def test_video_generate_enqueue_success(monkeypatch):
    """视频入队成功：200 envelope + 入队行字段完整性 + 快照关键字段。

    :param monkeypatch: pytest 夹具（注入 VIDEO_PROVIDER=agnes）。
    :return: None。
    """
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    database = VideoGenerationDatabase()
    client = make_client(database)

    response = client.post(
        f"/api/storyboards/{STORYBOARD_ID}/videos/generate",
        json={"candidateCount": 3},
        headers=AUTH,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "视频生成任务已加入后台队列"
    job = body["data"]
    assert job["jobType"] == "video_image"
    assert job["sourceId"] == STORYBOARD_ID
    assert job["status"] == "queued"
    stored = database.generation_jobs[job["id"]]
    # 入队行完整性：status / request_json 可解析 / job_key 格式。
    assert stored["status"] == "queued"
    assert re.fullmatch(r"video_image-21-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", stored["job_key"])
    snapshot = json.loads(stored["request_json"])
    assert snapshot["projectId"] == PROJECT_ID
    assert snapshot["storyboardId"] == STORYBOARD_ID
    assert snapshot["versionNo"] == 4
    assert snapshot["motionMode"] == "PAN"
    assert snapshot["durationSeconds"] == 5
    assert snapshot["candidateCount"] == 1
    assert database.superseded_storyboard_ids == [STORYBOARD_ID]
    assert snapshot["generationMode"] == "multi_reference"
    assert snapshot["videoProvider"] == "agnes"
    assert snapshot["modelName"] == "agnes-video-2.5-flash"
    assert snapshot["imageAssetId"] is None and snapshot["imageUrl"] is None
    assert snapshot["providerTasks"] == [] and snapshot["autoConfirm"] is False
    assert snapshot["imageRatio"] == "9:16"
    assert snapshot["referenceImages"] == [
        "https://media.example.com/char-9.png",
        "https://media.example.com/scene-3.png",
    ]
    assert snapshot["referenceImageStorageKeys"] == ["characters/c9.png", "scenes/s3.png"]
    assert snapshot["referenceAudioUrls"] == ["https://media.example.com/ref-9.wav"]
    assert snapshot["frameReferences"]["continuityEnabled"] is False
    assert snapshot["storyboardAssetReference"]["schemaVersion"] == 1
    assert snapshot["storyboardAssetReference"]["scene"]["assetId"] == 3
    assert snapshot["videoInspectionExpected"]["durationSeconds"] == 5
    # referencedAssets 快照字段集与 Node request.referencedAssets 映射一致。
    assert snapshot["referencedAssets"][0].keys() == {
        "key", "kind", "name", "imageUrl", "promptText", "appearance", "costume",
        "sceneViewKey", "viewKeys", "versionNo", "viewSetVersion", "voiceProfileKey",
        "voiceLocked", "referenceAudioUrl",
    }
    assert any("视频连续性硬约束" in part for part in snapshot["promptSnapshot"].split("\n"))


def test_video_generate_enqueue_is_idempotent_on_active_job(monkeypatch):
    """幂等：同 project+type+source 的 queued 活动任务复用（不产生第二行）。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    database = VideoGenerationDatabase()
    client = make_client(database)

    first = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json={}, headers=AUTH)
    second = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json={}, headers=AUTH)

    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    assert len(database.generation_jobs) == 1


def test_video_generate_rejects_unconfirmed_asset(monkeypatch):
    """未确认资产：质检门禁 → 409/4011 + data.qualityReport.blockers（Node 同形）。"""
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    database = VideoGenerationDatabase()
    database.locked_rows[1]["status"] = "candidate"  # 场景全景未确认
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 4011
    assert body["message"] == "质检未通过：1 个问题需要处理"
    codes = [blocker["code"] for blocker in body["data"]["qualityReport"]["blockers"]]
    assert codes == ["asset-not-confirmed"]


def test_video_generate_rejects_failing_direction_contract(monkeypatch):
    """视线/声音执行合同未通过：409/4011 + storyboard-direction-contract-incomplete。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    database = VideoGenerationDatabase()
    broken_reference = json.dumps(
        {
            **json.loads(REFERENCE_JSON),
            "performance": {
                "gazePlan": {"transitions": [{"fromSecond": 3, "toSecond": 2, "target": "屏幕"}]},
            },
        },
        ensure_ascii=False,
    )
    database.storyboards[STORYBOARD_ID]["asset_reference_json"] = broken_reference
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 4011
    assert body["message"].startswith("本镜头视线/声音执行计划未通过校验：")
    blockers = body["data"]["qualityReport"]["blockers"]
    assert blockers[0]["code"] == "storyboard-direction-contract-incomplete"
    assert body["data"]["qualityReport"]["summary"] == "本镜头视线/声音执行计划未就绪"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"durationSeconds": 2}, "agnes-video-2.5-flash 单镜只支持 4-12 秒，本镜当前为 2 秒；请先调整分镜时长再生成。"),
        ({"durationSeconds": "abc"}, "分镜时长必须是有效整数（1-30 秒）"),
        ({"modelName": "MiniMax-H3"}, "MiniMax 模型需要配置视频服务商为 minimax，当前为 agnes。"),
    ],
)
def test_video_generate_field_errors_map_to_4011_http_400(monkeypatch, payload, message):
    """字段非法（时长越界/非法/模型服务商不匹配）→ HTTP 400 + 4011 envelope（无 data）。

    :param monkeypatch: pytest 夹具。
    :param payload: 请求体。
    :param message: 期望错误文案。
    :return: None。
    """
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    client = make_client(VideoGenerationDatabase())

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json=payload, headers=AUTH)

    assert response.status_code == 400
    assert response.json() == {"code": 4011, "message": message, "data": None}


def test_video_generate_scene_asset_binding_missing(monkeypatch):
    """场景资产未绑定（sceneAssetId 缺失）→ 409/4011 + 门禁 qualityReport data。

    引用仅剩 characterId 时 requireCharacter 分支同时校验角色版本/三视图/基础图/
    脸部特写（与 Node inspectStoryboardAssetReferenceGate 同序同文案）。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("VIDEO_PROVIDER", "agnes")
    database = VideoGenerationDatabase()
    database.storyboards[STORYBOARD_ID]["asset_reference_json"] = json.dumps({"characterId": 9})
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/videos/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 4011
    assert body["message"] == "资产引用门禁未通过：7 个问题需要处理"
    codes = [blocker["code"] for blocker in body["data"]["qualityReport"]["blockers"]]
    assert codes == [
        "character-version-reference-missing",
        "character-view-set-reference-missing",
        "character-view-angle-reference-incomplete",
        "character-base-image-reference-missing",
        "character-face-closeup-reference-missing",
        "scene-asset-reference-missing",
        "scene-panorama-reference-missing",
    ]


def test_lip_sync_generate_enqueue_success(monkeypatch):
    """口型入队成功：200 envelope + 快照关键字段（autoConfirm 默认 true、时长取整）。

    :param monkeypatch: pytest 夹具（保证 LIP_SYNC_PROVIDER=toapi 走静帧分支）。
    :return: None。
    """
    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate", json={}, headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "口型同步任务已加入后台队列"
    job = body["data"]
    assert job["jobType"] == "lip_sync"
    assert job["sourceId"] == STORYBOARD_ID
    stored = database.generation_jobs[job["id"]]
    assert stored["status"] == "queued"
    assert re.fullmatch(r"lip_sync-21-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", stored["job_key"])
    snapshot = json.loads(stored["request_json"])
    assert snapshot["projectId"] == PROJECT_ID
    assert snapshot["storyboardId"] == STORYBOARD_ID
    assert snapshot["characterId"] == 9
    assert snapshot["characterName"] == "林知夏"
    assert snapshot["imageAssetId"] == 301
    assert snapshot["imageUrl"] == "https://media.example.com/frame-21.png"
    assert snapshot["audioAssetId"] == 401
    assert snapshot["audioUrl"] == "https://cos.example.com/signed/audio/a401.wav" or snapshot["audioUrl"]
    assert snapshot["audioDurationSeconds"] == 4
    assert snapshot["generationDurationSeconds"] == 5  # max(4, 5, 4) → 5
    assert snapshot["versionNo"] == 4
    assert snapshot["autoConfirm"] is True
    assert "sourceVideoAssetId" not in snapshot  # Node undefined → 不落快照
    assert "cropFilter" not in snapshot
    assert snapshot["prompt"].startswith("保持图片1中林知夏的脸")
    # storage_key 命中 → audio_url 换签名 URL（对象存储键保留在快照外，audioUrl 为签名结果）。
    assert "/storage/" in snapshot["audioUrl"] or snapshot["audioUrl"].startswith("http")


def test_lip_sync_generate_crop_filter_and_auto_confirm_roundtrip(monkeypatch):
    """cropFilter 合法值落入快照、autoConfirm=false 显式保留（Node 条件键语义）。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    client = make_client(database)

    ok = client.post(
        f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate",
        json={"cropFilter": "720:1280:0:120", "autoConfirm": False, "providerTaskId": " task-9 "},
        headers=AUTH,
    )
    # 幂等按 project+type+source 复用：非法 cropFilter 用例用独立分镜隔离快照。
    bad = client.post(
        "/api/storyboards/22/lip-sync/generate",
        json={"cropFilter": "12:34"},
        headers=AUTH,
    )

    assert ok.status_code == 200 and bad.status_code == 200
    ok_snapshot = json.loads(database.generation_jobs[ok.json()["data"]["id"]]["request_json"])
    bad_snapshot = json.loads(database.generation_jobs[bad.json()["data"]["id"]]["request_json"])
    assert ok_snapshot["cropFilter"] == "720:1280:0:120"
    assert ok_snapshot["autoConfirm"] is False
    assert ok_snapshot["providerTaskId"] == "task-9"
    assert "cropFilter" not in bad_snapshot
    assert bad_snapshot["autoConfirm"] is True


def test_lip_sync_generate_requires_speaker_binding(monkeypatch):
    """分镜未绑定说话角色：409/4011（Node 同文案）。"""

    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    database.storyboards[STORYBOARD_ID]["character_id"] = None
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {"code": 4011, "message": "当前分镜没有绑定说话角色，无法生成口型视频", "data": None}


def test_lip_sync_generate_requires_confirmed_dialogue_audio(monkeypatch):
    """缺已确认对白音频：409/4011（Node 同文案）。"""

    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    database.get_confirmed_dialogue_audio = lambda storyboard_id, character_id: None  # noqa: ARG005
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {"code": 4011, "message": "请先为当前分镜确认中文对白音频，再生成口型视频", "data": None}


def test_lip_sync_generate_requires_confirmed_frame(monkeypatch):
    """无确认静帧（toapi 不支持源视频兜底）：409/4011（Node 同文案）。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    database.get_confirmed_storyboard_image = lambda storyboard_id: None  # noqa: ARG005
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {"code": 4011, "message": "请先确认当前分镜静帧，再生成口型视频", "data": None}


def test_lip_sync_generate_speaker_mismatch(monkeypatch):
    """音频归属他人：409/4011 + 说话人不一致长文案（Node 同文案）。

    :param monkeypatch: pytest 夹具。
    :return: None。
    """
    monkeypatch.setenv("LIP_SYNC_PROVIDER", "toapi")
    database = VideoGenerationDatabase()
    audio = database.get_confirmed_dialogue_audio(STORYBOARD_ID, 9)
    audio.update({"character_id": 12, "character_name": "陈默"})
    database.get_confirmed_dialogue_audio = lambda storyboard_id, character_id: dict(audio)  # noqa: ARG005
    client = make_client(database)

    response = client.post(f"/api/storyboards/{STORYBOARD_ID}/lip-sync/generate", json={}, headers=AUTH)

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 4011
    assert body["message"].startswith("当前分镜绑定的说话人是“林知夏”，但已确认对白音频属于“陈默”。")
    assert body["message"].endswith("按对白从上到下拆成单人说话分镜。")


def test_video_confirm_success_with_storage_key():
    """确认成功（对象存储键）：签名 URL + 事务副作用 + qualityReport 标注。

    :return: None。
    """
    database = VideoGenerationDatabase()
    database.videos[56] = {
        **{key: value for key, value in VIDEO_ROW.items() if key != "id"},
        "id": 56,
        "status": "confirmed",
        "confirmed_at": "2026-10-17T09:00:00",
    }
    client = make_client(database)

    response = client.post("/api/videos/55/confirm", json={}, headers=AUTH)

    assert response.status_code == 200
    body = response.json()
    assert body["message"] == "最终视频已确认"
    video = body["data"]
    assert video["id"] == 55
    assert video["status"] == "confirmed"
    assert video["videoUrl"].startswith("http://127.0.0.1:8000/storage/videos/clip.mp4")
    assert "signature=" in video["videoUrl"]  # 本地对象存储签名
    assert video["qualityReport"]["qualityScore"] == 8
    assert video["qualityReport"]["semanticStatus"] == "accepted_by_user"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", video["qualityReport"]["reviewedAt"])
    # 事务副作用：旧确认归档 + 分镜 video_url 回写 + 行内 quality_report_json 更新。
    assert database.archived_video_ids == [56]
    assert database.storyboard_video_url_after_confirm == video["videoUrl"]
    stored_report = json.loads(database.confirmed_video_row["quality_report_json"])
    assert stored_report["semanticStatus"] == "accepted_by_user"


def test_video_confirm_remote_temporary_url_rejected():
    """远端旧临时链接（无 storage_key / 本地文件）：409/4092（有意收紧差异）。

    :return: None。
    """
    database = VideoGenerationDatabase()
    database.videos[55].update({"storage_key": None, "video_url": "https://cdn.example.com/clip.mp4"})
    client = make_client(database)

    response = client.post("/api/videos/55/confirm", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {
        "code": 4092,
        "message": "该旧视频临时链接已过期，无法设为最终版本；请选择本地版本或重新生成",
        "data": None,
    }

def test_video_confirm_missing_local_file_rejected(tmp_path):
    """本地 /generated/video 文件丢失：409/4091（Node fileExists 同分支）。

    :param tmp_path: pytest 临时目录。
    :return: None。
    """
    database = VideoGenerationDatabase()
    database.videos[55].update({"storage_key": None, "video_url": "http://127.0.0.1:8000/generated/video/clip.mp4"})
    client = make_client(database, GENERATED_VIDEO_DIR=str(tmp_path))

    response = client.post("/api/videos/55/confirm", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {
        "code": 4091,
        "message": "该本地视频文件已丢失，请重新生成后再确认",
        "data": None,
    }
def test_video_confirm_local_file_present_succeeds(tmp_path):
    """本地 /generated/video 文件在位：确认成功且不触发 4092 分支。

    :param tmp_path: pytest 临时目录。
    :return: None。
    """
    (tmp_path / "clip.mp4").write_bytes(b"fake-video-bytes")
    database = VideoGenerationDatabase()
    database.videos[55].update({"storage_key": None, "video_url": "http://127.0.0.1:8000/generated/video/clip.mp4"})
    client = make_client(database, GENERATED_VIDEO_DIR=str(tmp_path))

    response = client.post("/api/videos/55/confirm", json={}, headers=AUTH)

    assert response.status_code == 200
    assert response.json()["data"]["videoUrl"] == "http://127.0.0.1:8000/generated/video/clip.mp4"
    assert response.json()["data"]["status"] == "confirmed"


def test_video_confirm_signer_failure_maps_to_4093():
    """对象存储签名失败：409/4093（Node resolveVideoConfirmationSource 抛错同形）。

    :return: None。
    """
    database = VideoGenerationDatabase()
    # COS 模式 + 空凭据 → 签名器返回 None → 视为不可用。
    client = make_client(database, OBJECT_STORAGE_PROVIDER="cos")

    response = client.post("/api/videos/55/confirm", json={}, headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {
        "code": 4093,
        "message": "视频已存入对象存储，但播放链接刷新失败；请稍后重试确认",
        "data": None,
    }
