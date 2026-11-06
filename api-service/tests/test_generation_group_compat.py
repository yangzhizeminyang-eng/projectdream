"""生成任务与任务中心组已接管路由的兼容测试（阶段 7.4）。

对照规格：``api-service/docs/generation-group-spec.md``。聚焦 test_contracts.py
未覆盖的缺口：未登录/数据不存在/异常依赖/重复 retry 语义、generation-jobs id=0
的 Node 对齐（parseId("0") → SQL 无行 → 404/4004）。
第四阶段已删除过渡开关：整组恒为原生实现，回退代理专项测试随实现一并移除。
"""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}


class GenerationDatabase:
    """生成任务组兼容测试的最小数据库桩。

    :ivar generation_jobs: job_id -> 任务行（user_id 归属判定）。
    :ivar subtitle_videos: video_id -> 视频行（字幕清理入队）。
    :ivar voice_profiles: 声线目录行列表。
    :ivar fail_on_read: 置 True 时读取类方法抛异常，模拟数据库故障。
    """

    def __init__(self):
        self.generation_jobs = {
            31: {
                "id": 31, "job_key": "video_image-31-test", "project_id": 8,
                "job_type": "video_image", "source_id": 21, "user_id": 7,
                "status": "failed", "progress_percent": 0,
                "request_json": '{"projectId": 8, "storyboardId": 21}',
                "result_json": None, "error_text": "provider timeout",
                "created_at": "2026-10-17T08:00:00", "updated_at": "2026-10-17T08:00:00",
            },
            32: {
                "id": 32, "job_key": "frame_image-32-test", "project_id": 8,
                "job_type": "frame_image", "source_id": 21, "user_id": 7,
                "status": "queued", "progress_percent": 0,
                "request_json": None, "result_json": None, "error_text": None,
                "created_at": "2026-10-17T08:00:00", "updated_at": "2026-10-17T08:00:00",
            },
        }
        self.subtitle_videos = {
            55: {
                "id": 55, "user_id": 7, "project_id": 8, "storyboard_id": 21,
                "video_url": "https://cdn.test/clip.mp4", "storage_key": "frames/clip.mp4",
                "thumbnail_url": None, "duration_seconds": 5, "model_name": "wanx",
            }
        }
        self.voice_profiles = [
            {
                "profile_key": "male-child-clear", "display_name": "清澈男童声",
                "provider": "dashscope", "model_name": "qwen3-tts-flash",
                "voice_id": "qwen3-tts-male-child", "gender": "male",
                "age_groups": "child", "style_tags": "清澈,童声",
                "description": "清澈的男童声", "instructions": "",
                "language_type": "Chinese", "status": "active", "sort_order": 1,
            }
        ]
        self.fail_on_read = False

    # -- 通用鉴权 ----------------------------------------------------------

    def find_user_by_token(self, token):
        """按 token 反查用户（require_user 鉴权入口）。

        :param token: 访问令牌。
        :return: 命中时返回用户 dict，否则 None。
        """
        if token == "session-token":
            return {"id": 7, "phone": "13912345678", "nickname": "测试用户"}
        return None

    # -- 生成任务 ----------------------------------------------------------

    def get_generation_job(self, job_id, user_id):
        """按 id+归属读取生成任务。

        :param job_id: 任务 id。
        :param user_id: 用户 id。
        :return: 命中的任务行；不存在或非本人返回 None。
        :raises RuntimeError: fail_on_read 为 True 时模拟数据库离线。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        job = self.generation_jobs.get(job_id)
        return job if job and job["user_id"] == user_id else None

    def retry_generation_job(self, job_id, user_id):
        """原子重试：仅 failed/canceled 可回到 queued。

        :param job_id: 任务 id。
        :param user_id: 用户 id。
        :return: {"outcome": ..., "job": ...}。
        """
        job = self.get_generation_job(job_id, user_id)
        if job is None:
            return {"outcome": "not_found"}
        if job["status"] not in {"failed", "canceled"}:
            return {"outcome": "conflict", "status": job["status"]}
        job.update({"status": "queued", "progress_percent": 0, "result_json": None, "error_text": None})
        return {"outcome": "queued", "job": job}

    def list_active_voice_profiles(self):
        """列出启用中的声线目录。

        :return: 声线行列表。
        :raises RuntimeError: 故障注入时抛出。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        return [profile for profile in self.voice_profiles if profile.get("status") == "active"]

    def enqueue_subtitle_cleanup(self, video_id, user_id):
        """字幕清理入队（幂等：已有 active 同源任务则复用）。

        :param video_id: 视频 id。
        :param user_id: 用户 id。
        :return: 任务行；视频不存在或非本人返回 None。
        """
        if self.fail_on_read:
            raise RuntimeError("database offline")
        video = self.subtitle_videos.get(video_id)
        if not video or video["user_id"] != user_id:
            return None
        existing = next(
            (job for job in self.generation_jobs.values()
             if job["job_type"] == "subtitle_cleanup" and job["source_id"] == video_id
             and job["status"] in {"queued", "running"}),
            None,
        )
        if existing:
            return existing
        job_id = max(self.generation_jobs.keys(), default=0) + 1
        job = {
            "id": job_id, "job_key": f"subtitle_cleanup-{video_id}", "project_id": video["project_id"],
            "job_type": "subtitle_cleanup", "source_id": video_id, "user_id": user_id,
            "status": "queued", "progress_percent": 0, "request_json": None,
            "result_json": None, "error_text": None,
            "created_at": "2026-10-17T08:00:00", "updated_at": "2026-10-17T08:00:00",
        }
        self.generation_jobs[job_id] = job
        return job


def make_client(database=None):
    """构建原生模式测试客户端（第四阶段起恒为原生实现，直连数据库桩）。

    :param database: 注入的数据库桩；缺省使用 GenerationDatabase()。
    :return: 配置完成的 TestClient。
    """
    return TestClient(create_app(Settings(_env_file=None), database=database or GenerationDatabase()), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# 场景一：未登录
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/generation-jobs/31"),
        ("post", "/api/project-tasks/generation-31/retry"),
        ("post", "/api/videos/55/subtitles/remove"),
        ("get", "/api/voice-profiles"),
    ],
)
def test_generation_group_routes_require_authentication(method, path):
    """未登录：生成任务组路由统一 401/4010 envelope。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    kwargs = {"json": {}} if method == "post" else {}
    response = getattr(make_client(), method)(path, **kwargs)

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


# ---------------------------------------------------------------------------
# 场景二/三：数据不存在与非法 id
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("job_id", ["999", "0"])
def test_get_generation_job_treats_zero_and_missing_as_not_found(job_id):
    """generation-jobs 读取：id=0（Node parseId("0") → SQL 无行）与不存在 id 均为 404/4004。

    :param job_id: 路径中的任务 id（参数化：0 / 不存在）。
    :return: None。
    """
    response = make_client().get(f"/api/generation-jobs/{job_id}", headers=AUTH)

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "生成任务不存在或无权访问", "data": None}


def test_retry_hides_foreign_generation_job():
    """retry：他人任务 → 404/4004（owner 隔离）。

    :return: None。
    """
    response = make_client().post("/api/project-tasks/generation-33/retry", headers=AUTH)

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "任务不存在或无权访问", "data": None}


# ---------------------------------------------------------------------------
# 场景四：重复写入语义
# ---------------------------------------------------------------------------


def test_repeated_retry_turns_into_conflict_once_queued():
    """重复 retry：首次成功回队后，再次点击命中「只有失败或已取消的生成任务可以重试」409。

    :return: None。
    """
    client = make_client()

    first = client.post("/api/project-tasks/generation-31/retry", headers=AUTH)
    second = client.post("/api/project-tasks/generation-31/retry", headers=AUTH)

    assert first.status_code == 200
    assert first.json()["message"] == "生成任务已重新加入队列"
    assert first.json()["data"]["taskKey"] == "generation-31"
    assert first.json()["data"]["status"] == "queued"
    assert second.status_code == 409
    assert second.json() == {
        "code": 4001,
        "message": "只有失败或已取消的生成任务可以重试",
        "data": None,
    }


def test_cancel_always_returns_conflict_contract():
    """cancel：供应商请求不可安全中断 → 恒 409/4001（不产生状态变更）。

    :return: None。
    """
    response = make_client().post("/api/project-tasks/generation-31/cancel", headers=AUTH)

    assert response.status_code == 409
    assert response.json() == {
        "code": 4001,
        "message": "当前供应商请求不支持安全取消，请等待本轮完成",
        "data": None,
    }


def test_subtitle_cleanup_is_idempotent_for_active_job():
    """字幕清理入队幂等：已有 queued 同源任务时复用，不新增任务行。

    :return: None。
    """
    database = GenerationDatabase()
    client = make_client(database)

    first = client.post("/api/videos/55/subtitles/remove", headers=AUTH)
    second = client.post("/api/videos/55/subtitles/remove", headers=AUTH)

    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    # 幂等：只有一条 subtitle_cleanup 任务（有意收紧语义，README 已声明）。
    cleanup_jobs = [
        job for job in database.generation_jobs.values()
        if job["job_type"] == "subtitle_cleanup"
    ]
    assert len(cleanup_jobs) == 1


# ---------------------------------------------------------------------------
# 场景五：异常依赖
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/generation-jobs/31"),
        ("get", "/api/voice-profiles"),
        ("post", "/api/videos/55/subtitles/remove"),
    ],
)
def test_generation_group_routes_return_sanitized_500_when_database_fails(method, path):
    """异常依赖：数据库故障 → 500/5001，不泄漏内部异常文本。

    :param method: HTTP 方法。
    :param path: 被测路由。
    :return: None。
    """
    database = GenerationDatabase()
    database.fail_on_read = True
    kwargs = {"json": {}} if method == "post" else {}
    response = getattr(make_client(database), method)(path, headers=AUTH, **kwargs)

    assert response.status_code == 500
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}
    assert "database offline" not in response.text
