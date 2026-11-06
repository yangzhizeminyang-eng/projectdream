import json
import asyncio
import threading

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.database import _retry_request_snapshot
from app.main import create_app


class FakeDatabase:
    def __init__(self):
        self.users = {
            "13912345678": {
                "id": 7,
                "phone": "13912345678",
                "nickname": "测试用户",
                "password_hash": "ef7797e13d3a0c1b7b2f7c4d5d9c0f1c7c1a2d0a8b6e9b1d4e4b3c9a4d6e8f1",
            }
        }
        self.sessions = {}
        self.projects = []
        self.outlines = {}
        self.story_bibles = {}
        self.season_structures = {}
        self.assets = {}
        self.scenes = {}
        self.storyboards = {}
        self.generation_jobs = {}
        self.subtitle_videos = {}
        self.audio_assets = {}
        self.image_assets = {}
        self.project_task_rows = {}
        self.project_asset_rows = {}
        self.voice_profiles = []
        self.project_audio_rows = {}

    def list_project_audio(self, project_id, user_id):
        if self.get_project(project_id, user_id) is None:
            return None
        track_order = {"dialogue": 1, "narration": 2, "music": 3, "sfx": 4}
        return sorted(
            self.project_audio_rows.get(project_id, []),
            key=lambda row: (
                track_order.get(row.get("track_type"), 99),
                row.get("scene_id") or 0,
                row.get("character_id") or 0,
                -(row.get("version_no") or 0),
                -(row.get("id") or 0),
            ),
        )

    def fetch_user_by_phone(self, phone):
        return self.users.get(phone)

    def create_session(self, user):
        token = "session-token"
        self.sessions[token] = user["id"]
        return token

    def list_projects(self, user_id):
        return [project for project in self.projects if project["user_id"] == user_id]

    def project_assets(self, project_id, user_id):
        if self.get_project(project_id, user_id) is None:
            return None
        return self.project_asset_rows.get(project_id, {
            "characters": [], "images": [], "videos": [], "audios": [],
        })

    def list_active_voice_profiles(self):
        return [profile for profile in self.voice_profiles if profile.get("status") == "active"]


    def create_project(self, user_id, payload):
        project = {
            "id": len(self.projects) + 1,
            "user_id": user_id,
            "name": payload["name"],
            "category": payload.get("category"),
            "target_duration": payload.get("targetDuration"),
            "narrative_vision": payload.get("narrativeVision"),
            "visual_style": payload.get("visualStyle"),
            "aspect_ratio": payload.get("aspectRatio"),
            "status": "draft",
        }
        self.projects.append(project)
        return project

    def get_project(self, project_id, user_id):
        return next((project for project in self.projects if project["id"] == project_id and project["user_id"] == user_id), None)

    def latest_outline(self, project_id, user_id):
        if not self.get_project(project_id, user_id):
            return {"outcome": "not_found", "outline": None}
        rows = self.outlines.get(project_id, [])
        rows = sorted(rows, key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "outline": rows[0] if rows else None}

    def latest_story_bible(self, project_id, user_id):
        if not self.get_project(project_id, user_id):
            return {"outcome": "not_found", "item": None}
        rows = self.story_bibles.get(project_id, [])
        rows = sorted(rows, key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "item": rows[0] if rows else None}

    def latest_season_structure(self, project_id, user_id):
        if not self.get_project(project_id, user_id):
            return {"outcome": "not_found", "item": None}
        rows = self.season_structures.get(project_id, [])
        rows = sorted(rows, key=lambda row: (row.get("version_no") or 0, row["id"]), reverse=True)
        return {"outcome": "found", "item": rows[0] if rows else None}

    def update_project(self, project_id, user_id, updates):
        project = self.get_project(project_id, user_id)
        if project is None:
            return None
        project.update(updates)
        return project

    def find_user_by_token(self, token):
        user_id = self.sessions.get(token)
        return next((user for user in self.users.values() if user["id"] == user_id), None)

    def archive_project_asset(self, asset_type, asset_id, user_id):
        asset = self.assets.get((asset_type, asset_id))
        if not asset or asset["user_id"] != user_id:
            return None
        previous_status = asset["status"]
        if previous_status not in {"archived", "confirmed", "finalized", "done"}:
            asset["status"] = "archived"
        return {"id": asset_id, "status": asset["status"], "previous_status": previous_status}

    def list_scenes(self, project_id, user_id):
        if project_id not in {project["id"] for project in self.projects if project["user_id"] == user_id}:
            return None
        return [scene for scene in self.scenes.values() if scene["project_id"] == project_id]

    def get_scene(self, scene_id, user_id):
        scene = self.scenes.get(scene_id)
        return scene if scene and scene.get("user_id") == user_id else None

    def update_scene(self, scene_id, user_id, updates):
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        scene.update(updates)
        return scene

    def save_scene_script(self, scene_id, user_id, content, mood, title):
        scene = self.get_scene(scene_id, user_id)
        if scene is None:
            return None
        scene.update({"content": content, "mood": mood, "title": title, "status": "revised"})
        return scene

    def list_storyboards(self, scene_id, user_id):
        scene = self.scenes.get(scene_id)
        if not scene or scene.get("user_id") != user_id:
            return None
        return [shot for shot in self.storyboards.values() if shot["scene_id"] == scene_id]

    def get_storyboard(self, storyboard_id, user_id):
        shot = self.storyboards.get(storyboard_id)
        return shot if shot and self.scenes.get(shot["scene_id"], {}).get("user_id") == user_id else None

    def get_storyboard_detail(self, storyboard_id, user_id):
        """单分镜详情联查桩（第三阶段第三组：GET 单条原生化后 PUT 也走此入口）。"""
        shot = self.get_storyboard(storyboard_id, user_id)
        if shot is None:
            return None
        row = dict(shot)
        scene = self.scenes.get(shot.get("scene_id"), {})
        row.setdefault("project_id", scene.get("project_id") or 8)
        return row

    def list_frame_characters(self, project_id):
        """项目角色库桩（frameCharacterContext 输入，默认空库）。"""
        return []

    def character_in_project(self, character_id, project_id):
        return None

    def update_storyboard(self, storyboard_id, user_id, updates):
        shot = self.get_storyboard(storyboard_id, user_id)
        if shot is None:
            return None
        field_map = {
            "durationSeconds": "duration_seconds",
            "actionText": "action_text",
            "visualPrompt": "visual_prompt",
            "assetReference": "asset_reference_json",
        }
        shot.update({field_map.get(key, key): value for key, value in updates.items()})
        return shot

    def get_generation_job(self, job_id, user_id):
        job = self.generation_jobs.get(job_id)
        return job if job and job.get("user_id") == user_id else None

    def list_project_task_rows(self, project_id, user_id):
        project = self.get_project(project_id, user_id)
        if project is None:
            return None
        rows = self.project_task_rows.get(project_id, {
            "images": [], "videos": [], "audios": [], "exports": [],
            "generation_jobs": [], "runtime_states": [],
        })
        runtime = {row["task_key"]: row for row in rows.get("runtime_states", [])}
        for kind in ("images", "videos", "audios", "exports"):
            task_type = {"images": "image", "videos": "video", "audios": "audio", "exports": "export"}[kind]
            for row in rows.get(kind, []):
                row["runtime"] = runtime.get(f"{task_type}-{row['id']}")
        return rows

    def apply_mock_task_action(self, task_type, source_id, user_id, action):
        source_key = {"image": "images", "video": "videos", "audio": "audios", "export": "exports"}[task_type]
        source = next((row for row in self.project_task_rows.get(1, {}).get(source_key, []) if row["id"] == source_id), None)
        project = next((project for project in self.projects if project["user_id"] == user_id and any(
            row["id"] == source_id for row in self.project_task_rows.get(project["id"], {}).get(source_key, [])
        )), None)
        if source is None or project is None:
            return {"outcome": "not_found"}
        rows = self.project_task_rows[project["id"]]
        runtime = next((row for row in rows.setdefault("runtime_states", []) if row["task_key"] == f"{task_type}-{source_id}"), None)
        if action == "cancel":
            status = runtime.get("runtime_status") if runtime else ("success" if source.get("image_url") else "failed")
            if status not in {"queued", "running"}:
                return {"outcome": "not_cancelable"}
            target, progress = "canceled", int((runtime or {}).get("progress_percent") or 0)
        else:
            target, progress = "queued", 0
        state = {"task_key": f"{task_type}-{source_id}", "runtime_status": target, "progress_percent": progress}
        if runtime:
            runtime.update(state)
        else:
            rows["runtime_states"].append(state)
        return {"outcome": "updated", "project_id": project["id"], "runtime_status": target}

    def retry_generation_job(self, job_id, user_id):
        job = self.get_generation_job(job_id, user_id)
        if job is None:
            return {"outcome": "not_found"}
        if job.get("status") not in {"failed", "canceled"}:
            return {"outcome": "conflict", "status": job.get("status")}
        job.update({"status": "queued", "progress_percent": 0, "result_json": None, "error_text": None})
        return {"outcome": "queued", "job": job}

    def enqueue_subtitle_cleanup(self, video_id, user_id):
        video = self.subtitle_videos.get(video_id)
        if not video or video.get("user_id") != user_id:
            return None
        existing = next((job for job in self.generation_jobs.values() if job.get("job_type") == "subtitle_cleanup" and job.get("source_id") == video_id and job.get("status") in {"queued", "running"}), None)
        if existing:
            return existing
        job_id = max(self.generation_jobs.keys(), default=0) + 1
        job = {
            "id": job_id, "job_key": f"subtitle_cleanup-{video_id}-test", "project_id": video["project_id"],
            "job_type": "subtitle_cleanup", "source_id": video_id, "status": "queued", "progress_percent": 0,
            "request_json": json.dumps({
                "projectId": video["project_id"], "storyboardId": video["storyboard_id"], "sourceVideoId": video_id,
                "sourceStorageKey": video.get("storage_key"), "sourceVideoUrl": video["video_url"],
                "thumbnailUrl": video.get("thumbnail_url"), "durationSeconds": video.get("duration_seconds"),
                "modelName": video.get("model_name"),
            }), "user_id": user_id,
        }
        self.generation_jobs[job_id] = job
        return job

    def confirm_audio_asset(self, audio_id, user_id):
        audio = self.audio_assets.get(audio_id)
        if not audio or audio.get("user_id") != user_id:
            return None
        key = (audio.get("project_id"), audio.get("track_type"), audio.get("scene_id"), audio.get("storyboard_id"), audio.get("character_id"))
        for item in self.audio_assets.values():
            item_key = (item.get("project_id"), item.get("track_type"), item.get("scene_id"), item.get("storyboard_id"), item.get("character_id"))
            if item_key == key and item["id"] != audio_id and item.get("status") == "confirmed":
                item.update({"status": "candidate", "confirmed_at": None})
        audio.update({"status": "confirmed", "confirmed_at": "2026-10-15T10:00:00"})
        return audio

    def archive_audio_asset(self, audio_id, user_id):
        audio = self.audio_assets.get(audio_id)
        if not audio or audio.get("user_id") != user_id:
            return {"outcome": "not_found"}
        if audio.get("status") == "confirmed":
            return {"outcome": "protected"}
        audio["status"] = "archived"
        return {"outcome": "archived", "audio": audio}

    def update_audio_placement(self, audio_id, user_id, payload):
        audio = self.audio_assets.get(audio_id)
        if not audio or audio.get("user_id") != user_id:
            return {"outcome": "not_found"}
        storyboard_id = audio.get("storyboard_id")
        scene_id = audio.get("scene_id")
        if "storyboardId" in payload:
            storyboard_id = payload["storyboardId"] or None
            if storyboard_id:
                shot = self.storyboards.get(storyboard_id)
                if not shot or shot.get("project_id") != audio.get("project_id"):
                    return {"outcome": "storyboard_not_found"}
                scene_id = shot["scene_id"]
        audio["storyboard_id"] = storyboard_id
        audio["scene_id"] = scene_id
        if payload.get("startOffsetSeconds") is not None:
            audio["start_offset_seconds"] = max(0, min(60, float(payload["startOffsetSeconds"] or 0)))
        return {"outcome": "updated", "audio": audio}

    def confirm_image_asset(self, image_id, user_id):
        image = self.image_assets.get(image_id)
        if not image or image.get("user_id") != user_id:
            return None
        role = image.get("frame_role") if image.get("frame_role") in {"start", "end"} else "primary"
        for item in self.image_assets.values():
            item_role = item.get("frame_role") if item.get("frame_role") in {"start", "end"} else "primary"
            if item.get("storyboard_id") == image.get("storyboard_id") and item_role == role and item["id"] != image_id:
                item.update({"status": "candidate", "confirmed_at": None})
        image.update({"status": "confirmed", "confirmed_at": "2026-10-15T10:00:00"})
        shot = self.storyboards.get(image["storyboard_id"])
        if shot:
            shot["end_image_url" if role == "end" else "image_url"] = image.get("image_url")
        return image

    def list_storyboard_images(self, storyboard_id, user_id):
        shot = self.storyboards.get(storyboard_id)
        if not shot or shot.get("user_id") != user_id:
            return None
        rows = [image for image in self.image_assets.values() if image.get("storyboard_id") == storyboard_id]
        return sorted(rows, key=lambda image: (image.get("version_no") or 0, image["id"]), reverse=True)

    def reorder_storyboards(self, orders, user_id):
        shots = [self.storyboards.get(item["id"]) for item in orders]
        if any(not shot or shot.get("user_id") != user_id for shot in shots):
            return {"outcome": "not_found"}
        if len({shot.get("scene_id") for shot in shots}) != 1:
            return {"outcome": "cross_scene"}
        for item in orders:
            self.storyboards[item["id"]]["sort_order"] = item["sortOrder"]
        return {"outcome": "updated"}


def make_client(database=None):
    settings = Settings(_env_file=None)
    return TestClient(create_app(settings, database=database or FakeDatabase()))


def test_ready_reports_mysql_availability():
    """就绪探针：第四阶段已删除 Node upstream 探活，仅检查自身依赖（MySQL）。"""

    class ReadyDatabase:
        def health(self):
            return True

    client = TestClient(create_app(Settings(_env_file=None), database=ReadyDatabase()))

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "checks": {"mysql": True},
    }


def test_ready_returns_service_unavailable_when_mysql_is_down():
    class UnavailableDatabase:
        def health(self):
            raise TimeoutError("database connection timed out")

    client = TestClient(create_app(Settings(_env_file=None), database=UnavailableDatabase()))

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "checks": {"mysql": False},
    }


def test_compose_api_healthcheck_uses_readiness_endpoint():
    from pathlib import Path

    compose = Path(__file__).resolve().parents[2].joinpath("docker-compose.yml").read_text(encoding="utf-8")

    assert "http://127.0.0.1:8000/ready" in compose


def test_project_assets_match_node_summary_and_confirmation_fields():
    database = FakeDatabase()
    database.sessions["token"] = 7
    database.projects.append({"id": 5, "user_id": 7, "name": "测试项目"})
    database.project_asset_rows[5] = {
        "characters": [{"id": 31, "name": "林知夏", "role_tag": "主角", "status": "confirmed", "reference_image_url": "cos://character.png"}],
        "images": [{"id": 41, "storyboard_id": 51, "shot_no": 1, "scene_id": 61, "scene_no": 1, "scene_title": "夜班", "status": "confirmed", "image_url": "cos://frame.png", "version_no": 2}],
        "videos": [{"id": 42, "storyboard_id": 51, "shot_no": 1, "scene_id": 61, "scene_no": 1, "scene_title": "夜班", "status": "candidate", "video_url": "cos://video.mp4", "thumbnail_url": "cos://thumb.png", "version_no": 1}],
        "audios": [{"id": 43, "scene_id": 61, "scene_no": 1, "scene_title": "夜班", "character_id": 31, "character_name": "林知夏", "title": "夜班对白", "status": "confirmed", "audio_url": "cos://audio.mp3", "track_type": "dialogue", "duration_seconds": 4, "voice_name": "知夏音色", "confirmed_at": "2026-10-15T10:00:00", "version_no": 3}],
    }
    client = make_client(database=database)

    response = client.get("/api/projects/5/assets", headers={"Authorization": "Bearer token"})

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["summary"] == {
        "totalCount": 4, "characterCount": 1, "imageCount": 1,
        "videoCount": 1, "audioCount": 1,
        "confirmedImageCount": 1, "confirmedVideoCount": 0,
        "confirmedAudioCount": 1,
    }
    audio = next(item for item in payload["items"] if item["assetType"] == "audio")
    assert audio["confirmedAt"] == "2026-10-15T10:00:00"
    assert audio["name"] == "夜班对白"
    assert audio["audioUrl"] == "cos://audio.mp3"


def test_project_assets_does_not_read_assets_for_foreign_project():
    database = FakeDatabase()
    database.sessions["token"] = 7
    database.projects.append({"id": 5, "user_id": 8, "name": "他人项目"})
    client = make_client(database=database)

    response = client.get("/api/projects/5/assets", headers={"Authorization": "Bearer token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_keeps_node_compatible_success_envelope_for_password_login():
    database = FakeDatabase()
    # SHA-256("123456") is the same password format used by the current Node API.
    database.users["13912345678"]["password_hash"] = (
        "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
    )
    client = make_client(database=database)

    response = client.post(
        "/api/auth/login-password",
        json={"phone": "13912345678", "password": "123456"},
    )

    assert response.status_code == 200
    assert response.json()["code"] == 0
    assert response.json()["data"]["token"] == "session-token"


def test_fastapi_returns_existing_auth_error_contract():
    client = make_client()

    response = client.post(
        "/api/auth/login-password",
        json={"phone": "13912345678", "password": "wrong-password"},
    )

    assert response.status_code == 400
    assert response.json() == {"code": 4008, "message": "账号或密码不正确", "data": None}


def test_fastapi_owns_project_list_and_creation_routes():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    created = client.post(
        "/api/projects",
        headers=headers,
        json={"name": "第一集", "category": "悬疑", "targetDuration": 60},
    )
    listed = client.get("/api/projects", headers=headers)

    assert created.status_code == 200
    assert created.json()["data"]["name"] == "第一集"
    assert listed.status_code == 200
    assert listed.json()["data"]["items"][0]["name"] == "第一集"


def test_project_list_preserves_latest_completed_export_and_export_progress():
    database = FakeDatabase()
    database.sessions["token"] = 7
    database.projects.append({
        "id": 8, "user_id": 7, "name": "已导出项目", "status": "storyboarding",
        "outline_count": 1, "scene_count": 1, "storyboard_count": 1,
        "confirmed_image_count": 1, "confirmed_video_count": 1,
        "confirmed_audio_count": 1, "latest_export_id": 91,
        "latest_export_video_url": "/generated/export-91.mp4",
        "latest_export_duration_seconds": 32,
        "latest_export_created_at": "2026-10-15T08:00:00",
    })

    response = make_client(database=database).get(
        "/api/projects", headers={"Authorization": "Bearer token"},
    )

    item = response.json()["data"]["items"][0]
    assert item["latestVideo"] == {
        "exportId": 91,
        "videoUrl": "/generated/export-91.mp4",
        "durationSeconds": 32,
        "createdAt": "2026-10-15T08:00:00",
    }
    assert item["progressPercent"] == 100
    assert item["progressStage"] == "已导出成片"
    assert item["progressDetails"]["completedExportCount"] == 1


def test_project_detail_keeps_node_raw_project_dto_shape():
    database = FakeDatabase()
    database.sessions["token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "原始项目", "status": "draft"})

    response = make_client(database=database).get(
        "/api/projects/8", headers={"Authorization": "Bearer token"},
    )

    item = response.json()["data"]
    assert item["latestVideo"] is None
    assert "progressPercent" not in item
    assert "progressDetails" not in item


def test_fastapi_owns_phone_existence_check_without_exposing_user_record():
    database = FakeDatabase()
    client = make_client(database=database)

    response = client.get("/api/auth/check-phone?phone=13912345678")

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "success", "data": {"exists": True}}


def test_fastapi_lists_owned_project_audio_with_signed_media_url_and_node_order():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "音频项目", "status": "draft"})
    database.project_audio_rows[8] = [
        {"id": 2, "project_id": 8, "track_type": "sfx", "storage_key": "projects/8/sfx.wav", "audio_url": "legacy"},
        {"id": 1, "project_id": 8, "track_type": "dialogue", "storage_key": None, "audio_url": "https://cdn.invalid/voice.mp3"},
    ]
    settings = Settings(
        _env_file=None,
        OBJECT_STORAGE_PROVIDER="local",
        OBJECT_STORAGE_PUBLIC_BASE_URL="http://media.example/storage",
    )
    client = TestClient(create_app(settings, database=database))

    response = client.get("/api/projects/8/audio", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["data"]["items"][0]["audioUrl"] == "https://cdn.invalid/voice.mp3"
    assert response.json()["data"]["items"][1]["audioUrl"].startswith("http://media.example/storage/projects/8/sfx.wav?")
    assert [item["id"] for item in response.json()["data"]["items"]] == [1, 2]


def test_fastapi_project_audio_list_requires_auth_and_hides_unowned_project():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 42, "name": "他人项目", "status": "draft"})
    client = make_client(database=database)

    unauthorized = client.get("/api/projects/8/audio")
    foreign = client.get("/api/projects/8/audio", headers={"Authorization": "Bearer session-token"})

    assert unauthorized.status_code == 401
    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_phone_existence_check_preserves_invalid_phone_error_contract():
    response = make_client().get("/api/auth/check-phone?phone=not-a-phone")

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}


def test_phone_existence_check_uses_node_compatible_ascii_digit_normalization():
    response = make_client().get("/api/auth/check-phone?phone=1１２３４５６７８９０")

    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "手机号格式不正确", "data": None}


def test_fastapi_reads_and_updates_owned_project_settings_only():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "旧项目", "status": "draft"})
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    detail = client.get("/api/projects/8", headers=headers)
    updated = client.patch("/api/projects/8", headers=headers, json={"name": "新项目", "visualStyle": "写实悬疑", "status": "confirmed"})

    assert detail.status_code == 200
    assert updated.status_code == 400
    assert updated.json()["code"] == 4001
    assert database.projects[0]["name"] == "旧项目"

    updated = client.patch("/api/projects/8", headers=headers, json={"name": "新项目", "aspectRatio": "9:16"})
    assert updated.status_code == 200
    assert updated.json()["data"]["name"] == "新项目"


def test_unhandled_error_response_keeps_request_correlation_headers():
    class FailingDatabase(FakeDatabase):
        def list_projects(self, user_id):
            raise RuntimeError("database failure")

    database = FailingDatabase()
    database.sessions["token"] = 7
    client = TestClient(
        create_app(Settings(_env_file=None), database=database),
        raise_server_exceptions=False,
    )

    response = client.get(
        "/api/projects",
        headers={"Authorization": "Bearer token", "X-Request-ID": "request-error-42"},
    )

    assert response.status_code == 500
    assert response.headers["X-Request-Id"] == "request-error-42"
    assert response.headers["X-API-Gateway"] == "fastapi"
    assert response.json() == {"code": 5001, "message": "服务暂时不可用，请稍后重试", "data": None}


def test_fastapi_archives_owned_project_asset_with_node_error_contract():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.assets[("image", 3)] = {"user_id": 7, "status": "candidate"}
    client = make_client(database=database)

    response = client.post(
        "/api/project-assets/image/3/archive",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "code": 0,
        "message": "项目资产已归档",
        "data": {"id": 3, "assetType": "image", "status": "archived"},
    }


def test_fastapi_does_not_archive_confirmed_project_asset():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.assets[("video", 4)] = {"user_id": 7, "status": "confirmed"}
    client = make_client(database=database)

    response = client.post(
        "/api/project-assets/video/4/archive",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 400
    assert response.json() == {
        "code": 4001,
        "message": "已确认或定稿资产不能直接归档",
        "data": None,
    }


def test_fastapi_reads_owned_scene_and_storyboard_contracts():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "剧本项目"})
    database.scenes[11] = {
        "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1,
        "scene_no": 1, "title": "夜班值班台", "summary": "异常物品出现",
        "content": "窗口滑出发卡", "sort_order": 0, "status": "draft",
    }
    database.storyboards[21] = {
        "id": 21, "scene_id": 11, "shot_no": "01", "duration_seconds": 5,
        "action_text": "发卡滑出窗口", "visual_prompt": "固定中景",
        "sort_order": 0, "status": "pending",
    }
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    scenes = client.get("/api/projects/8/scenes", headers=headers)
    scene = client.get("/api/scenes/11", headers=headers)
    storyboards = client.get("/api/scenes/11/storyboards", headers=headers)

    assert scenes.status_code == 200
    assert scenes.json()["data"]["items"][0]["sceneNo"] == 1
    assert scene.json()["data"]["title"] == "夜班值班台"
    assert storyboards.json()["data"]["items"][0]["shotNo"] == "01"
    # 单条 GET /api/storyboards/{id} 自第三阶段第三组起原生化（frameCharacterContext
    # 由 domain/frame_character.py 提供，Node fixture 对照见 test_frame_character_fixtures）。


def test_fastapi_hides_scene_from_another_user():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.scenes[99] = {"id": 99, "user_id": 42, "project_id": 8}
    client = make_client(database=database)

    response = client.get("/api/scenes/99", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "场景不存在或无权访问", "data": None}


def test_fastapi_reads_owned_generation_job_and_hides_other_users_jobs():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.generation_jobs[31] = {
        "id": 31, "user_id": 7, "job_key": "video_image-21-test", "project_id": 8,
        "job_type": "video_image", "source_id": 21, "status": "queued",
        "progress_percent": 0, "result_json": '{"items": []}', "error_text": None,
    }
    database.generation_jobs[32] = {
        "id": 32, "user_id": 42, "job_key": "video_image-22-other", "project_id": 9,
        "job_type": "video_image", "source_id": 22, "status": "failed",
        "progress_percent": 30, "result_json": None, "error_text": "provider timeout",
    }
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    owned = client.get("/api/generation-jobs/31", headers=headers)
    hidden = client.get("/api/generation-jobs/32", headers=headers)

    assert owned.status_code == 200
    assert owned.json()["data"] == {
        "id": 31,
        "jobKey": "video_image-21-test",
        "projectId": 8,
        "jobType": "video_image",
        "sourceId": 21,
        "status": "queued",
        "progressPercent": 0,
        "result": {"items": []},
        "errorText": None,
        "createdAt": None,
        "updatedAt": None,
    }
    assert hidden.status_code == 404
    assert hidden.json()["code"] == 4004


def test_fastapi_updates_scene_metadata_with_node_compatible_whitelist():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "剧本项目"})
    database.scenes[11] = {
        "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1,
        "scene_no": 1, "title": "旧标题", "summary": "旧摘要", "status": "draft",
        "estimated_duration": 10,
    }
    client = make_client(database=database)

    response = client.put(
        "/api/scenes/11",
        headers={"Authorization": "Bearer session-token"},
        json={"title": "新标题", "estimatedDuration": 18, "status": "confirmed"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "场景已保存"
    assert response.json()["data"]["title"] == "新标题"
    assert response.json()["data"]["estimatedDuration"] == 18
    assert response.json()["data"]["status"] == "draft"


def test_fastapi_saves_scene_script_and_marks_it_revised():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.scenes[11] = {
        "id": 11, "user_id": 7, "project_id": 8, "episode_no": 1,
        "scene_no": 1, "title": "旧标题", "content": "旧正文", "mood": "旧氛围",
        "status": "generated",
    }
    client = make_client(database=database)

    response = client.put(
        "/api/scenes/11/script",
        headers={"Authorization": "Bearer session-token"},
        json={"title": "新标题", "content": "新正文", "mood": "压迫"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "剧本已保存"
    assert response.json()["data"]["content"] == "新正文"
    assert response.json()["data"]["status"] == "revised"


def test_fastapi_updates_storyboard_and_preserves_storyboard_contract():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.scenes[11] = {"id": 11, "user_id": 7, "project_id": 8}
    database.storyboards[21] = {
        "id": 21, "scene_id": 11, "shot_no": "01", "duration_seconds": 5,
        "action_text": "发卡滑出窗口", "visual_prompt": "固定中景", "status": "pending",
    }
    client = make_client(database=database)

    response = client.put(
        "/api/storyboards/21",
        headers={"Authorization": "Bearer session-token"},
        json={"durationSeconds": 8, "actionText": "发卡沿托盘滑出窗口", "status": "confirmed"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "分镜已保存"
    assert response.json()["data"]["durationSeconds"] == 8
    assert response.json()["data"]["actionText"] == "发卡沿托盘滑出窗口"


def test_fastapi_returns_empty_project_task_center_with_complete_summary():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "空任务项目"})
    client = make_client(database=database)

    response = client.get("/api/projects/8/tasks", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["data"] == {
        "projectId": 8,
        "summary": {
            "totalCount": 0, "imageCount": 0, "videoCount": 0, "audioCount": 0,
            "exportCount": 0, "confirmedCount": 0, "candidateCount": 0,
            "completedCount": 0, "queuedCount": 0, "runningCount": 0,
            "successCount": 0, "failedCount": 0, "canceledCount": 0,
        },
        "items": [],
    }


def test_fastapi_project_task_center_merges_jobs_and_assets_with_runtime_summary():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "任务项目"})
    database.project_task_rows[8] = {
        "images": [{"id": 4, "scene_id": 11, "scene_no": 1, "scene_title": "值班台", "storyboard_id": 21, "shot_no": "02", "version_no": 1, "status": "candidate", "image_url": "/media/frame.png", "created_at": "2026-10-15T10:00:00"}],
        "videos": [], "audios": [], "exports": [],
        "generation_jobs": [{"id": 31, "job_type": "video_image", "source_id": 21, "status": "queued", "progress_percent": 12, "result_json": '{"items":[{"videoUrl":"/generated/video/task-31.mp4"}]}', "error_text": None, "scene_id": 11, "scene_no": 1, "scene_title": "值班台", "shot_no": "02", "created_at": "2026-10-15T10:01:00", "updated_at": "2026-10-15T10:01:00"}],
        "runtime_states": [{"task_key": "image-4", "runtime_status": "running", "progress_percent": 55, "updated_at": "2026-10-15T10:02:00"}],
    }
    client = TestClient(create_app(
        Settings(_env_file=None, public_base_url="http://media.example:8002"),
        database=database,
    ))

    response = client.get("/api/projects/8/tasks", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    payload = response.json()["data"]
    assert [item["taskKey"] for item in payload["items"]] == ["image-4", "generation-31"]
    assert payload["items"][1]["runtimeStatus"] == "queued"
    assert payload["items"][0]["runtimeStatus"] == "running"
    assert payload["items"][0]["canCancel"] is True
    assert payload["items"][1]["fileUrl"] == "http://media.example:8002/generated/video/task-31.mp4"
    assert payload["summary"]["totalCount"] == 2
    assert payload["summary"]["queuedCount"] == 1
    assert payload["summary"]["runningCount"] == 1
    assert payload["summary"]["imageCount"] == 1
    assert payload["summary"]["videoCount"] == 1


def test_fastapi_project_task_center_hides_other_users_project():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 9, "user_id": 42, "name": "他人项目"})
    client = make_client(database=database)

    response = client.get("/api/projects/9/tasks", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_retries_only_owned_terminal_generation_jobs():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.generation_jobs[31] = {
        "id": 31, "user_id": 7, "project_id": 8, "job_type": "frame_image", "source_id": 21,
        "status": "failed", "progress_percent": 100, "error_text": "provider timeout",
        "created_at": "2026-10-15T10:00:00", "updated_at": "2026-10-15T10:01:00",
    }
    database.generation_jobs[32] = {
        "id": 32, "user_id": 42, "project_id": 9, "job_type": "frame_image", "source_id": 22,
        "status": "failed", "progress_percent": 100,
    }
    client = make_client(database=database)

    retried = client.post("/api/project-tasks/generation-31/retry", headers={"Authorization": "Bearer session-token"})
    foreign = client.post("/api/project-tasks/generation-32/retry", headers={"Authorization": "Bearer session-token"})

    assert retried.status_code == 200
    assert retried.json()["message"] == "生成任务已重新加入队列"
    assert retried.json()["data"]["runtimeStatus"] == "queued"
    assert database.generation_jobs[31]["progress_percent"] == 0
    assert database.generation_jobs[31]["error_text"] is None
    assert foreign.status_code == 404
    assert foreign.json()["code"] == 4004


def test_fastapi_rejects_retrying_active_generation_job_and_keeps_cancel_contract():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.generation_jobs[31] = {
        "id": 31, "user_id": 7, "project_id": 8, "job_type": "video_image", "source_id": 21,
        "status": "running", "progress_percent": 44,
    }
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    retry = client.post("/api/project-tasks/generation-31/retry", headers=headers)
    cancel = client.post("/api/project-tasks/generation-31/cancel", headers=headers)

    assert retry.status_code == 409
    assert retry.json() == {"code": 4001, "message": "只有失败或已取消的生成任务可以重试", "data": None}
    assert cancel.status_code == 409
    assert cancel.json() == {"code": 4001, "message": "当前供应商请求不支持安全取消，请等待本轮完成", "data": None}


def test_generation_retry_snapshot_reuses_live_provider_tasks_and_drops_failed_or_unusable_tasks():
    snapshot = _retry_request_snapshot({
        "request_json": {
            "providerTaskId": "legacy-task",
            "providerReferenceImages": ["https://provider.invalid/ref.png"],
            "providerTasks": [
                {"videoId": "pending-1", "status": "processing"},
                {"videoId": "done-1", "status": "succeeded", "videoUrl": "https://cdn.invalid/done.mp4"},
                {"videoId": "done-2", "status": "succeeded"},
                {"videoId": "failed-1", "status": "failed"},
            ],
        }
    })
    request = json.loads(snapshot)

    assert "providerTaskId" not in request
    assert [task["videoId"] for task in request["providerTasks"]] == ["pending-1", "done-1"]


def test_mock_asset_task_actions_reject_unknown_asset_id():
    """未知任务前缀对应的资源应由 FastAPI 统一返回未找到，而非 501。"""
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    client = TestClient(create_app(Settings(_env_file=None), database=database))

    response = client.post(
        "/api/project-tasks/image-404/retry",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 404
    assert response.json()["code"] == 4004


def test_mock_asset_task_retry_resets_an_owned_asset_to_queued():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 1, "user_id": 7, "name": "测试项目"})
    database.project_task_rows[1] = {
        "images": [{"id": 4, "status": "candidate", "image_url": None, "created_at": "2026-01-01T00:00:00"}],
        "videos": [], "audios": [], "exports": [], "generation_jobs": [], "runtime_states": [],
    }
    client = TestClient(create_app(Settings(_env_file=None), database=database))

    response = client.post(
        "/api/project-tasks/image-4/retry",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "任务已重新加入队列（Mock）"
    assert response.json()["data"]["taskKey"] == "image-4"
    assert response.json()["data"]["runtimeStatus"] == "queued"
    assert response.json()["data"]["canCancel"] is True


def test_mock_asset_task_cancel_only_cancels_an_owned_active_task():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 1, "user_id": 7, "name": "测试项目"})
    database.project_task_rows[1] = {
        "images": [{"id": 4, "status": "candidate", "image_url": None, "created_at": "2026-01-01T00:00:00"}],
        "videos": [], "audios": [], "exports": [], "generation_jobs": [],
        "runtime_states": [{"task_key": "image-4", "runtime_status": "running", "progress_percent": 35}],
    }
    client = TestClient(create_app(Settings(_env_file=None), database=database))
    headers = {"Authorization": "Bearer session-token"}

    response = client.post("/api/project-tasks/image-4/cancel", headers=headers)

    assert response.status_code == 200
    assert response.json()["message"] == "任务已取消（Mock）"
    assert response.json()["data"]["runtimeStatus"] == "canceled"
    assert response.json()["data"]["progressPercent"] == 35


def test_mock_asset_task_actions_keep_owner_and_cancel_state_guards():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.extend([
        {"id": 1, "user_id": 7, "name": "我的项目"},
        {"id": 2, "user_id": 42, "name": "他人项目"},
    ])
    database.project_task_rows[1] = {
        "images": [{"id": 4, "status": "candidate", "image_url": "https://media.invalid/image.png"}],
        "videos": [], "audios": [], "exports": [], "generation_jobs": [], "runtime_states": [],
    }
    database.project_task_rows[2] = {
        "images": [{"id": 5, "status": "candidate", "image_url": None}],
        "videos": [], "audios": [], "exports": [], "generation_jobs": [], "runtime_states": [],
    }
    client = TestClient(create_app(Settings(_env_file=None), database=database))
    headers = {"Authorization": "Bearer session-token"}

    completed = client.post("/api/project-tasks/image-4/cancel", headers=headers)
    foreign = client.post("/api/project-tasks/image-5/retry", headers=headers)

    assert completed.status_code == 400
    assert completed.json()["code"] == 4001
    assert foreign.status_code == 404
    assert foreign.json()["code"] == 4004


def test_unknown_project_task_action_matches_the_unmatched_node_route_contract():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    client = TestClient(create_app(Settings(_env_file=None), database=database))

    response = client.post(
        "/api/project-tasks/image-4/archive",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 404
    assert response.json() == {"code": 4040, "message": "接口不存在", "data": None}


def test_fastapi_enqueues_owned_subtitle_cleanup_and_reuses_active_job():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.subtitle_videos[54] = {
        "user_id": 7, "project_id": 8, "storyboard_id": 21, "video_url": "https://media.invalid/source.mp4",
        "storage_key": "projects/8/video/54.mp4", "thumbnail_url": "https://media.invalid/thumb.jpg",
        "duration_seconds": 8, "model_name": "minimax-video",
    }
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    first = client.post("/api/videos/54/subtitles/remove", headers=headers)
    duplicate = client.post("/api/videos/54/subtitles/remove", headers=headers)

    assert first.status_code == duplicate.status_code == 200
    assert first.json()["message"] == "字幕清理任务已加入后台队列"
    assert first.json()["data"]["id"] == duplicate.json()["data"]["id"]
    assert first.json()["data"]["jobType"] == "subtitle_cleanup"
    assert json.loads(database.generation_jobs[1]["request_json"]) == {
        "projectId": 8, "storyboardId": 21, "sourceVideoId": 54,
        "sourceStorageKey": "projects/8/video/54.mp4", "sourceVideoUrl": "https://media.invalid/source.mp4",
        "thumbnailUrl": "https://media.invalid/thumb.jpg", "durationSeconds": 8, "modelName": "minimax-video",
    }


def test_fastapi_does_not_enqueue_subtitle_cleanup_for_another_users_video():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.subtitle_videos[54] = {"user_id": 42, "project_id": 9, "storyboard_id": 33, "video_url": "https://media.invalid/private.mp4"}
    client = make_client(database=database)

    response = client.post("/api/videos/54/subtitles/remove", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "视频不存在或无权访问", "data": None}
    assert database.generation_jobs == {}


def test_fastapi_confirms_owned_audio_and_demotes_previous_version_in_same_track():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {
        "id": 71, "user_id": 7, "project_id": 8, "track_type": "dialogue",
        "scene_id": 11, "storyboard_id": 21, "character_id": 4,
        "status": "candidate", "audio_url": "https://media.invalid/new.wav",
        "version_no": 2, "duration_seconds": 3, "shot_no": "02",
    }
    database.audio_assets[70] = {
        "id": 70, "user_id": 7, "project_id": 8, "track_type": "dialogue",
        "scene_id": 11, "storyboard_id": 21, "character_id": 4,
        "status": "confirmed", "audio_url": "https://media.invalid/old.wav", "version_no": 1,
    }
    client = make_client(database=database)

    response = client.post("/api/audio-assets/71/confirm", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["message"] == "音频轨道已确认"
    assert response.json()["data"]["status"] == "confirmed"
    assert response.json()["data"]["audioUrl"] == "https://media.invalid/new.wav"
    assert response.json()["data"]["title"] == "对白轨 · 02 - 未命名来源"
    assert database.audio_assets[70]["status"] == "candidate"
    assert database.audio_assets[70]["confirmed_at"] is None


def test_fastapi_does_not_confirm_another_users_audio():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {"id": 71, "user_id": 42, "project_id": 9, "status": "candidate"}
    client = make_client(database=database)

    response = client.post("/api/audio-assets/71/confirm", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "音频资产不存在或无权访问", "data": None}
    assert database.audio_assets[71]["status"] == "candidate"


def test_fastapi_archives_owned_audio_candidate_and_returns_compatible_asset():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {
        "id": 71, "user_id": 7, "project_id": 8, "track_type": "ambience",
        "scene_id": 11, "status": "candidate", "audio_url": "https://media.invalid/ambience.wav",
        "duration_seconds": 12, "version_no": 3,
    }
    client = make_client(database=database)

    response = client.post("/api/audio-assets/71/archive", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["message"] == "音频候选已归档"
    assert response.json()["data"]["id"] == 71
    assert response.json()["data"]["status"] == "archived"
    assert response.json()["data"]["trackType"] == "ambience"
    assert database.audio_assets[71]["status"] == "archived"


def test_fastapi_rejects_archiving_confirmed_audio_and_hides_foreign_audio():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {"id": 71, "user_id": 7, "project_id": 8, "status": "confirmed"}
    database.audio_assets[72] = {"id": 72, "user_id": 42, "project_id": 9, "status": "candidate"}
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    protected = client.post("/api/audio-assets/71/archive", headers=headers)
    foreign = client.post("/api/audio-assets/72/archive", headers=headers)

    assert protected.status_code == 400
    assert protected.json() == {"code": 4001, "message": "已确认主版本不允许直接归档", "data": None}
    assert database.audio_assets[71]["status"] == "confirmed"
    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "音频资产不存在或无权访问", "data": None}
    assert database.audio_assets[72]["status"] == "candidate"


def test_fastapi_confirms_owned_image_within_frame_role_and_updates_storyboard():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.storyboards[21] = {"id": 21, "scene_id": 11, "image_url": "old-primary", "end_image_url": "old-end"}
    database.image_assets[81] = {
        "id": 81, "user_id": 7, "storyboard_id": 21, "frame_role": "start",
        "image_url": "new-start", "status": "candidate", "version_no": 2,
    }
    database.image_assets[80] = {
        "id": 80, "user_id": 7, "storyboard_id": 21, "frame_role": "start",
        "image_url": "old-start", "status": "confirmed",
    }
    database.image_assets[79] = {
        "id": 79, "user_id": 7, "storyboard_id": 21, "frame_role": "end",
        "image_url": "old-end", "status": "confirmed",
    }
    database.image_assets[82] = {
        "id": 82, "user_id": 7, "storyboard_id": 21, "frame_role": "end",
        "image_url": "new-end", "status": "candidate",
    }
    client = make_client(database=database)

    response = client.post("/api/images/81/confirm", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["message"] == "静帧已确认"
    assert response.json()["data"]["frameRole"] == "start"
    assert response.json()["data"]["status"] == "confirmed"
    assert database.image_assets[80]["status"] == "candidate"
    assert database.image_assets[79]["status"] == "confirmed"
    assert database.storyboards[21]["image_url"] == "new-start"
    assert database.storyboards[21]["end_image_url"] == "old-end"

    end_response = client.post("/api/images/82/confirm", headers={"Authorization": "Bearer session-token"})

    assert end_response.status_code == 200
    assert end_response.json()["data"]["frameRole"] == "end"
    assert database.image_assets[81]["status"] == "confirmed"
    assert database.image_assets[79]["status"] == "candidate"
    assert database.storyboards[21]["image_url"] == "new-start"
    assert database.storyboards[21]["end_image_url"] == "new-end"


def test_fastapi_does_not_confirm_another_users_image():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.image_assets[81] = {
        "id": 81, "user_id": 42, "storyboard_id": 21, "frame_role": "primary",
        "image_url": "private-image", "status": "candidate",
    }
    client = make_client(database=database)

    response = client.post("/api/images/81/confirm", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 404
    assert response.json() == {"code": 4004, "message": "静帧不存在或无权访问", "data": None}
    assert database.image_assets[81]["status"] == "candidate"


def test_fastapi_lists_owned_shot_images_in_node_order_and_compatible_shape():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.storyboards[21] = {"id": 21, "user_id": 7}
    database.image_assets[81] = {
        "id": 81, "user_id": 7, "storyboard_id": 21, "version_no": 4,
        "frame_role": "start", "image_url": "image-v4", "status": "candidate",
    }
    database.image_assets[82] = {
        "id": 82, "user_id": 7, "storyboard_id": 21, "version_no": 4,
        "frame_role": "end", "image_url": "image-v4-later-id", "status": "confirmed",
    }
    database.image_assets[80] = {
        "id": 80, "user_id": 7, "storyboard_id": 21, "version_no": 3,
        "frame_role": "invalid", "image_url": "image-v3", "status": "archived",
    }
    client = make_client(database=database)

    response = client.get("/api/shots/21/images", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["code"] == 0
    assert [item["id"] for item in response.json()["data"]["items"]] == [82, 81, 80]
    assert response.json()["data"]["items"][0]["frameRole"] == "end"
    assert response.json()["data"]["items"][2]["frameRole"] == "primary"
    assert response.json()["data"]["items"][0]["imageUrl"] == "image-v4-later-id"


def test_fastapi_hides_foreign_shot_image_list_and_requires_authentication():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.storyboards[22] = {"id": 22, "user_id": 42}
    client = make_client(database=database)

    foreign = client.get("/api/shots/22/images", headers={"Authorization": "Bearer session-token"})
    anonymous = client.get("/api/shots/22/images")

    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "分镜不存在或无权访问", "data": None}
    assert anonymous.status_code == 401
    assert anonymous.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


def test_fastapi_reorders_owned_storyboards_atomically_and_allows_zero_order():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.storyboards[21] = {"id": 21, "user_id": 7, "scene_id": 11, "sort_order": 8}
    database.storyboards[22] = {"id": 22, "user_id": 7, "scene_id": 11, "sort_order": 9}
    database.storyboards[23] = {"id": 23, "user_id": 7, "scene_id": 12, "sort_order": 4}
    client = make_client(database=database)

    response = client.post(
        "/api/storyboards/reorder",
        headers={"Authorization": "Bearer session-token"},
        json={"orders": [{"id": 21, "sortOrder": 0}, {"id": 22, "sortOrder": 1}]},
    )

    assert response.status_code == 200
    assert response.json() == {"code": 0, "message": "排序已更新", "data": {"success": True}}
    assert database.storyboards[21]["sort_order"] == 0
    assert database.storyboards[22]["sort_order"] == 1
    assert database.storyboards[23]["sort_order"] == 4


def test_fastapi_rejects_foreign_or_cross_scene_reorder_without_partial_changes():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.storyboards[21] = {"id": 21, "user_id": 7, "scene_id": 11, "sort_order": 8}
    database.storyboards[22] = {"id": 22, "user_id": 42, "scene_id": 11, "sort_order": 9}
    database.storyboards[23] = {"id": 23, "user_id": 7, "scene_id": 12, "sort_order": 4}
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    foreign = client.post("/api/storyboards/reorder", headers=headers, json={"orders": [{"id": 21, "sortOrder": 0}, {"id": 22, "sortOrder": 1}]})
    cross_scene = client.post("/api/storyboards/reorder", headers=headers, json={"orders": [{"id": 21, "sortOrder": 0}, {"id": 23, "sortOrder": 1}]})

    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "分镜不存在或无权访问", "data": None}
    assert cross_scene.status_code == 400
    assert cross_scene.json() == {"code": 4001, "message": "排序数据必须属于同一场景", "data": None}
    assert database.storyboards[21]["sort_order"] == 8
    assert database.storyboards[22]["sort_order"] == 9
    assert database.storyboards[23]["sort_order"] == 4


def test_fastapi_rejects_empty_or_invalid_storyboard_order_payload():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    empty = client.post("/api/storyboards/reorder", headers=headers, json={"orders": []})
    invalid = client.post("/api/storyboards/reorder", headers=headers, json={"orders": [{"id": 21, "sortOrder": -1}]})

    assert empty.status_code == 400
    assert empty.json() == {"code": 4001, "message": "缺少排序数据", "data": None}
    assert invalid.status_code == 400
    assert invalid.json() == {"code": 4001, "message": "排序数据无效", "data": None}


def test_fastapi_returns_latest_owned_outline_with_compatible_shape():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.outlines[8] = [
        {"id": 31, "project_id": 8, "version_no": 1, "title": "旧版", "raw_json": '{"acts":["旧"]}'},
        {
            "id": 32, "project_id": 8, "version_no": 2, "title": "新版", "logline": "一行故事",
            "premise": "核心设定", "act1_text": "起", "act2_text": "承", "act3_text": "转合",
            "visual_style": "半写实 CG", "raw_json": '{"acts":["第一幕"],"scenes":[{"title":"夜班"}]}',
            "created_at": "2026-10-15T08:00:00",
        },
    ]
    client = make_client(database=database)

    response = client.get("/api/projects/8/outline", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["code"] == 0
    assert response.json()["data"] == {
        "id": 32, "projectId": 8, "versionNo": 2, "title": "新版", "logline": "一行故事",
        "premise": "核心设定", "act1Text": "起", "act2Text": "承", "act3Text": "转合",
        "visualStyle": "半写实 CG", "acts": ["第一幕"], "scenes": [{"title": "夜班"}],
        "createdAt": "2026-10-15T08:00:00",
    }


def test_fastapi_returns_null_for_missing_outline_and_hides_foreign_project():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.extend([
        {"id": 8, "user_id": 7, "name": "项目"},
        {"id": 9, "user_id": 42, "name": "他人项目"},
    ])
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    missing_outline = client.get("/api/projects/8/outline", headers=headers)
    foreign_project = client.get("/api/projects/9/outline", headers=headers)

    assert missing_outline.status_code == 200
    # 7.2 对齐：空数据 message 用 Node success() 默认值 "success"（Node success(res, null)）。
    assert missing_outline.json() == {"code": 0, "message": "success", "data": None}
    assert foreign_project.status_code == 404
    assert foreign_project.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_outline_mapper_tolerates_invalid_structured_json():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.outlines[8] = [{"id": 31, "project_id": 8, "version_no": 1, "raw_json": "not-json"}]
    client = make_client(database=database)

    response = client.get("/api/projects/8/outline", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    assert response.json()["data"]["acts"] == []
    assert response.json()["data"]["scenes"] == []


def test_fastapi_returns_latest_story_bible_and_maps_json_fields():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.story_bibles[8] = [
        {"id": 40, "project_id": 8, "version_no": 1, "title": "旧故事"},
        {
            "id": 41, "project_id": 8, "version_no": 2, "status": "locked", "title": "新故事",
            "logline": "一行梗概", "audience": "成年观众", "emotional_promise": "悬疑与释然",
            "world_rules_json": '["规则一"]', "timeline_json": '[{"year":2026}]',
            "locations_json": '[{"name":"值班台"}]', "characters_json": '[{"name":"林知夏"}]',
            "relationships_json": '[{"from":"甲","to":"乙"}]', "props_json": '[{"name":"发卡"}]',
            "main_plot": "找回失物", "subplots_json": '["副线"]',
            "foreshadowing_json": '["伏笔"]', "locked_facts_json": '["不可更改事实"]',
            "flexible_facts_json": '["可调整事实"]', "visual_symbols_json": '["绿色出口灯"]',
            "quality_report_json": '{"score":95}', "locked_at": "2026-10-15T08:00:00",
            "created_at": "2026-10-14T08:00:00", "updated_at": "2026-10-15T08:00:00",
        },
    ]
    client = make_client(database=database)

    response = client.get("/api/projects/8/story-bible", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["id"] == 41
    assert data["versionNo"] == 2
    assert data["worldRules"] == ["规则一"]
    assert data["timeline"] == [{"year": 2026}]
    assert data["characters"] == [{"name": "林知夏"}]
    assert data["mainPlot"] == "找回失物"
    assert data["visualSymbols"] == ["绿色出口灯"]
    assert data["qualityReport"] == {"score": 95}


def test_fastapi_story_bible_null_and_foreign_project_contract():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.extend([
        {"id": 8, "user_id": 7, "name": "项目"},
        {"id": 9, "user_id": 42, "name": "他人项目"},
    ])
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    missing = client.get("/api/projects/8/story-bible", headers=headers)
    foreign = client.get("/api/projects/9/story-bible", headers=headers)

    assert missing.status_code == 200
    # 7.2 对齐：空数据 message 用 Node success() 默认值 "success"。
    assert missing.json() == {"code": 0, "message": "success", "data": None}
    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_story_bible_recovers_from_individually_malformed_json_fields():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.story_bibles[8] = [{
        "id": 41, "project_id": 8, "version_no": 1,
        "world_rules_json": "broken", "timeline_json": "{}", "characters_json": '["有效角色"]',
        "quality_report_json": "broken",
    }]
    client = make_client(database=database)

    response = client.get("/api/projects/8/story-bible", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["worldRules"] == []
    assert data["timeline"] == []
    assert data["characters"] == ["有效角色"]
    assert data["qualityReport"] is None


def test_fastapi_returns_latest_season_structure_and_maps_nested_fields():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.season_structures[8] = [
        {"id": 50, "project_id": 8, "version_no": 1, "season_theme": "旧主题"},
        {
            "id": 51, "project_id": 8, "story_bible_id": 41, "version_no": 2,
            "status": "locked", "season_theme": "归还之夜", "core_conflict": "遗失还是归还",
            "structure_type": "mystery", "episode_count": 8,
            "episodes_json": '[{"episodeNo":1,"title":"发卡"}]',
            "foreshadowing_plan_json": '[{"clue":"慢三秒"}]',
            "character_arcs_json": '[{"name":"林知夏","arc":"释怀"}]',
            "quality_report_json": '{"score":92}', "locked_at": "2026-10-15T09:00:00",
            "created_at": "2026-10-14T09:00:00", "updated_at": "2026-10-15T09:00:00",
        },
    ]
    client = make_client(database=database)

    response = client.get("/api/projects/8/season-structure", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["id"] == 51
    assert data["storyBibleId"] == 41
    assert data["episodeCount"] == 8
    assert data["episodes"] == [{"episodeNo": 1, "title": "发卡"}]
    assert data["foreshadowingPlan"] == [{"clue": "慢三秒"}]
    assert data["characterArcs"] == [{"name": "林知夏", "arc": "释怀"}]
    assert data["qualityReport"] == {"score": 92}


def test_fastapi_season_structure_preserves_null_and_hides_foreign_project():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.extend([
        {"id": 8, "user_id": 7, "name": "项目"},
        {"id": 9, "user_id": 42, "name": "他人项目"},
    ])
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    missing = client.get("/api/projects/8/season-structure", headers=headers)
    foreign = client.get("/api/projects/9/season-structure", headers=headers)

    assert missing.status_code == 200
    # 7.2 对齐：空数据 message 用 Node success() 默认值 "success"。
    assert missing.json() == {"code": 0, "message": "success", "data": None}
    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "项目不存在或无权访问", "data": None}


def test_fastapi_season_structure_malformed_json_uses_compatible_defaults():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.projects.append({"id": 8, "user_id": 7, "name": "项目"})
    database.season_structures[8] = [{
        "id": 51, "project_id": 8, "version_no": 1, "episodes_json": "broken",
        "foreshadowing_plan_json": "{}", "character_arcs_json": "broken", "quality_report_json": "broken",
    }]
    client = make_client(database=database)

    response = client.get("/api/projects/8/season-structure", headers={"Authorization": "Bearer session-token"})

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["status"] == "draft"
    assert data["episodeCount"] == 1
    assert data["episodes"] == []
    assert data["foreshadowingPlan"] == []
    assert data["characterArcs"] == []
    assert data["qualityReport"] is None


def test_fastapi_updates_audio_timeline_placement_and_clamps_offset():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {
        "id": 71, "user_id": 7, "project_id": 8, "track_type": "dialogue",
        "scene_id": 11, "status": "candidate", "audio_url": "https://media.invalid/dialogue.wav",
    }
    database.storyboards[21] = {"id": 21, "scene_id": 12, "project_id": 8, "shot_no": "03"}
    database.scenes[12] = {"id": 12, "project_id": 8, "scene_no": 2, "title": "档案柜前"}
    client = make_client(database=database)

    response = client.put(
        "/api/audio-assets/71",
        headers={"Authorization": "Bearer session-token"},
        json={"storyboardId": 21, "startOffsetSeconds": 75},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "音频时间线定位已保存"
    assert response.json()["data"]["storyboardId"] == 21
    assert response.json()["data"]["sceneId"] == 12
    assert response.json()["data"]["startOffsetSeconds"] == 60


def test_fastapi_detaching_audio_from_storyboard_preserves_scene_assignment():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {
        "id": 71, "user_id": 7, "project_id": 8, "track_type": "ambience",
        "scene_id": 12, "storyboard_id": 21, "status": "candidate",
    }
    client = make_client(database=database)

    response = client.put(
        "/api/audio-assets/71",
        headers={"Authorization": "Bearer session-token"},
        json={"storyboardId": None},
    )

    assert response.status_code == 200
    assert response.json()["data"]["storyboardId"] is None
    assert response.json()["data"]["sceneId"] == 12


def test_fastapi_rejects_audio_placement_in_another_project_and_foreign_audio():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.audio_assets[71] = {"id": 71, "user_id": 7, "project_id": 8, "status": "candidate"}
    database.audio_assets[72] = {"id": 72, "user_id": 42, "project_id": 9, "status": "candidate"}
    database.storyboards[91] = {"id": 91, "scene_id": 92, "project_id": 9}
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    wrong_project = client.put("/api/audio-assets/71", headers=headers, json={"storyboardId": 91})
    foreign = client.put("/api/audio-assets/72", headers=headers, json={"startOffsetSeconds": 5})

    assert wrong_project.status_code == 404
    assert wrong_project.json() == {"code": 4004, "message": "分镜不存在或不属于当前项目", "data": None}
    assert database.audio_assets[71].get("storyboard_id") is None
    assert foreign.status_code == 404
    assert foreign.json() == {"code": 4004, "message": "音频资产不存在或无权访问", "data": None}


def test_fastapi_rejects_invalid_storyboard_duration_and_direction_timeline():
    database = FakeDatabase()
    database.sessions["session-token"] = 7
    database.scenes[11] = {"id": 11, "user_id": 7, "project_id": 8}
    database.storyboards[21] = {
        "id": 21, "scene_id": 11, "shot_no": "01", "duration_seconds": 5,
        "action_text": "发卡滑出窗口", "visual_prompt": "固定中景", "status": "pending",
    }
    client = make_client(database=database)
    headers = {"Authorization": "Bearer session-token"}

    duration = client.put("/api/storyboards/21", headers=headers, json={"durationSeconds": 31})
    direction = client.put(
        "/api/storyboards/21",
        headers=headers,
        json={"durationSeconds": 5, "soundPlan": {"cues": [{"atSecond": 6, "sound": "滑动声"}]}},
    )

    assert duration.status_code == 400
    assert duration.json()["code"] == 4001
    assert direction.status_code == 422
    assert "声音 cue 时间点超出镜头时长" in direction.json()["message"]


def test_voice_profile_catalog_returns_node_compatible_options_and_profile_fields():
    database = FakeDatabase()
    database.sessions["token"] = 7
    database.voice_profiles = [{
        "profile_key": "female-young-gentle", "display_name": "清透青年女声",
        "provider": "dashscope", "model_name": "qwen3-tts-flash", "voice_id": "Cherry",
        "gender": "female", "age_groups": "young_adult,middle_aged",
        "style_tags": "清透,克制", "description": "自然清晰",
        "instructions": "语气克制", "language_type": "Chinese", "status": "active",
        "sort_order": 20,
    }]
    client = make_client(database=database)

    response = client.get("/api/voice-profiles", headers={"Authorization": "Bearer token"})

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["ageGroups"] == [
        {"value": "child", "label": "儿童（12 岁及以下）"},
        {"value": "teen", "label": "少年（13-18 岁）"},
        {"value": "young_adult", "label": "青年（19-35 岁）"},
        {"value": "middle_aged", "label": "中年（36-55 岁）"},
        {"value": "senior", "label": "老年（56 岁以上）"},
    ]
    assert payload["genders"] == [
        {"value": "male", "label": "男性声线"},
        {"value": "female", "label": "女性声线"},
        {"value": "neutral", "label": "中性 / 系统声线"},
    ]
    assert payload["items"] == [{
        "profileKey": "female-young-gentle", "displayName": "清透青年女声",
        "provider": "dashscope", "modelName": "qwen3-tts-flash", "voiceId": "Cherry",
        "gender": "female", "ageGroups": ["young_adult", "middle_aged"],
        "styleTags": ["清透", "克制"], "description": "自然清晰",
        "instructions": "语气克制", "languageType": "Chinese", "status": "active",
        "sortOrder": 20,
    }]


def test_voice_profile_catalog_requires_authentication():
    response = make_client().get("/api/voice-profiles")

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


def test_token_database_lookup_does_not_block_asgi_event_loop():
    database = FakeDatabase()
    database.sessions["token"] = 7
    lookup_threads = []
    original_lookup = database.find_user_by_token

    def capture_lookup_thread(token):
        lookup_threads.append(threading.get_ident())
        return original_lookup(token)

    database.find_user_by_token = capture_lookup_thread
    app = create_app(Settings(_env_file=None), database=database)

    async def make_request():
        event_loop_thread = threading.get_ident()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/voice-profiles", headers={"Authorization": "Bearer token"})
        assert response.status_code == 200
        assert lookup_threads
        assert lookup_threads[0] != event_loop_thread

    asyncio.run(make_request())
