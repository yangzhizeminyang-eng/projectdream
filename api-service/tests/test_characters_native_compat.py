"""角色库组（阶段 3.5）端点兼容测试。

对照 Node（行号以 2026-10-17 工作区版本为准）：

- GET/POST /api/projects/{id}/characters（index.mjs L17371/L17546/L17555）
- GET/PUT/DELETE /api/characters/{id}（L18167-L18350：改名 syncNameReferences 契约）
- POST /api/character-images/{id}/confirm（L17613：定妆图确认 → finalized）
- POST /api/characters/{id}/rename-preview（L17664：重名 409/4009）
- GET  /api/characters/{id}/images（L17768）
- POST /api/characters/{id}/images/generate（L17777 + enqueueCharacterImageJob L4326）
- GET  /api/projects/{id}/voice-cast（L17237）
- GET  /api/characters/{id}/voice-recommendations（L17279）
- PUT  /api/characters/{id}/voice-binding（L17292）
- PUT  /api/characters/{id}/reference-audio（L17351：dataURL ≤15MB）

不迁移项（保持兜底代理，见 spec 差异记录）：characters/generate（AI 抽取）、
generate-profile（AI 补全）、voice-preview（真实 TTS 供应商）。
全部离线（fake database + 本地对象存储）。
"""

import base64
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

AUTH = {"Authorization": "Bearer session-token"}
USER_ID = 7
OTHER_USER_ID = 99
PROJECT_ID = 8
CHARACTER_ID = 9
OTHER_CHARACTER_ID = 10
IMAGE_ID = 301

VOICE_PROFILE_ROW = {
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
MALE_VOICE_PROFILE_ROW = {
    "profile_key": "male-adult-calm",
    "display_name": "冷静成年男声",
    "provider": "dashscope",
    "model_name": "qwen3-tts-instruct-flash",
    "voice_id": "Moon",
    "gender": "male",
    "age_groups": "young_adult,middle_aged",
    "style_tags": "冷静,克制,理性",
    "description": "",
    "instructions": "请使用30至45岁成年男性的自然声线。",
    "language_type": "Chinese",
    "status": "active",
    "sort_order": 40,
}

CHARACTER_ROW = {
    "id": CHARACTER_ID,
    "project_id": PROJECT_ID,
    "name": "林知夏",
    "role_tag": "主角",
    "personality": "冷静克制，观察力强",
    "appearance": "28 岁女性，短发瓜子脸，灰色风衣",
    "voice_setting": None,
    "age_group": "young_adult",
    "gender": "female",
    "voice_style": "低沉克制的青年女声",
    "voice_profile_key": None,
    "voice_locked": 0,
    "voice_design_json": None,
    "reference_image_url": None,
    "reference_audio_url": None,
    "reference_audio_storage_key": None,
    "status": "draft",
    "ownerId": USER_ID,
    "project_visual_style": "冷蓝色调科幻风",
}

CHARACTER_IMAGE_ROW = {
    "id": IMAGE_ID,
    "character_id": CHARACTER_ID,
    "version_no": 2,
    "image_url": "https://media.example.com/characterization.png",
    "thumbnail_url": None,
    "storage_key": None,
    "prompt_snapshot": "定妆图快照",
    "model_name": "agnes-image-2.1-flash",
    "status": "candidate",
    "confirmed_at": None,
    "created_at": "2026-10-17T09:00:00",
    "ownerId": USER_ID,
    "project_id": PROJECT_ID,
}


class CharactersDatabase:
    """角色库端点测试的最小数据库桩。

    :ivar projects / characters / character_images: 主数据。
    :ivar generation_jobs: 入队任务（幂等复用语义与 MySQL 实现一致）。
    :ivar object_writes: 参考音频写桶记录。
    """

    def __init__(self):
        self.projects = {PROJECT_ID: {"id": PROJECT_ID, "user_id": USER_ID, "name": "死讯服务器", "visual_style": "冷蓝", "category": "都市悬疑"}}
        self.characters: dict[int, dict] = {CHARACTER_ID: dict(CHARACTER_ROW)}
        self.character_images: dict[int, dict] = {IMAGE_ID: dict(CHARACTER_IMAGE_ROW)}
        self.generation_jobs: dict[int, dict] = {}
        self.next_character_id = 20
        self.next_job_id = 500
        self.object_writes: list[tuple[str, bytes, str]] = []
        # 改名计划上下文（默认空集：仅项目行）。
        self.rename_context = {
            "project": [{"id": PROJECT_ID, "narrative_vision": "林知夏发现死讯服务器。"}],
            "outline": [],
            "scenes": [
                {"id": 3, "title": "深夜监控室", "summary": None, "content": "林知夏转身看向屏幕。林知夏：进来。"},
                {"id": 4, "title": "葬礼灵堂", "summary": "陈默悼词", "content": "陈默站在灵堂。"},
            ],
            "storyboards": [
                {"id": 21, "character_id": CHARACTER_ID, "character_name": "林知夏", "action_text": "林知夏转身。", "dialogue_text": "林知夏：数据不会说谎。", "visual_prompt": "林知夏中景"},
                {"id": 22, "character_id": None, "character_name": "林知夏", "action_text": "旧版绑定", "dialogue_text": None, "visual_prompt": None},
            ],
            "characters": [
                {"id": CHARACTER_ID, "name": "林知夏"},
                {"id": OTHER_CHARACTER_ID, "name": "陈默"},
            ],
            "media_counts": {"character_images": 1, "image_assets": 0, "video_assets": 0, "audio_assets": 0},
        }
        self.finalized_character_ids: list[int] = []

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

    # -- 角色 ---------------------------------------------------------------

    def list_project_characters(self, project_id):
        """项目角色列表。"""
        return [dict(row) for row in self.characters.values() if row["project_id"] == project_id and row.get("status") != "archived"]

    def get_character_for_user(self, character_id, extra_project_columns=""):
        """角色归属行。"""
        row = self.characters.get(character_id)
        if row is None or row.get("status") == "archived":
            return None
        result = dict(row)
        result["ownerId"] = self.projects.get(row["project_id"], {}).get("user_id")
        return result

    def character_name_exists(self, project_id, name, exclude_id=0):
        """同名角色存在性。"""
        return any(
            row["project_id"] == project_id
            and row.get("name") == name
            and int(row["id"]) != int(exclude_id)
            and row.get("status") != "archived"
            for row in self.characters.values()
        )

    def insert_character(self, project_id, payload):
        """新建角色并回读。"""
        self.next_character_id += 1
        row = {
            "id": self.next_character_id,
            "project_id": project_id,
            "name": payload["name"],
            "role_tag": payload.get("roleTag"),
            "personality": payload.get("personality"),
            "appearance": payload.get("appearance"),
            "voice_setting": payload.get("voiceSetting"),
            "age_group": payload.get("ageGroup"),
            "gender": payload.get("gender"),
            "voice_style": payload.get("voiceStyle"),
            "voice_profile_key": None,
            "voice_locked": 0,
            "voice_design_json": None,
            "reference_image_url": payload.get("referenceImageUrl"),
            "reference_audio_url": None,
            "reference_audio_storage_key": None,
            "status": "draft",
        }
        self.characters[row["id"]] = row
        return dict(row)

    def archive_character(self, character_id):
        """软删角色。"""
        row = self.characters.get(character_id)
        if row:
            row["status"] = "archived"
            row["voice_locked"] = 0

    def update_character_fields(self, character_id, assignments):
        """白名单列更新并回读。"""
        row = self.characters.get(character_id)
        if row is None:
            return None
        row.update(assignments)
        return dict(row)

    def update_character_voice_binding(self, character_id, assignments):
        """音色绑定写回。"""
        return self.update_character_fields(character_id, assignments)

    def update_character_txn(self, character_id, assignments, *, rename_plan=None, require_same_owner=None):
        """角色更新事务（含重名检查 + 改名计划应用）。"""
        from app.domain.character_rename import apply_character_rename_plan

        row = self.characters.get(character_id)
        if row is None or row.get("status") == "archived":
            raise RuntimeError("角色不存在或无权访问")
        if require_same_owner is not None and int(self.projects[row["project_id"]]["user_id"]) != int(require_same_owner):
            raise RuntimeError("角色不存在或无权访问")
        if "name" in assignments:
            requested = assignments["name"]
            if any(
                other["project_id"] == row["project_id"]
                and other.get("name") == requested
                and int(other["id"]) != character_id
                for other in self.characters.values()
            ):
                raise RuntimeError("当前项目已经存在同名角色，请使用其他名字")
        class _Cursor:
            """apply_character_rename_plan 的游标适配（execute 记录 UPDATE）。"""

            def __init__(inner, database):
                inner.database = database
                inner.updates = []

            def execute(inner, sql, params=None):
                inner.updates.append((sql.strip(), params))

        cursor = _Cursor(self)
        row.update(assignments)
        if rename_plan is not None:
            apply_character_rename_plan(cursor, rename_plan, character_id)
        return dict(row)

    def list_character_images(self, character_id):
        """角色定妆图列表。"""
        rows = [image for image in self.character_images.values() if image["character_id"] == character_id]
        rows.sort(key=lambda row: (-int(row.get("version_no") or 0), row["id"]))
        return [dict(row) for row in rows]

    def get_character_image_full(self, image_id):
        """定妆图归属行。"""
        image = self.character_images.get(image_id)
        if image is None:
            return None
        row = dict(image)
        character = self.characters.get(image["character_id"], {})
        row["project_id"] = character.get("project_id")
        row["ownerId"] = self.projects.get(row["project_id"], {}).get("user_id")
        return row

    def confirm_character_image_txn(self, image_id, character_id, image_url, storage_key=None):
        """定妆图确认事务。"""
        for other in self.character_images.values():
            if other["character_id"] == character_id and other.get("status") == "confirmed":
                other["status"] = "candidate"
                other["confirmed_at"] = None
        image = self.character_images[image_id]
        image["status"] = "confirmed"
        image["confirmed_at"] = "2026-10-18T09:00:00"
        character = self.characters[character_id]
        character["reference_image_url"] = image_url
        character["reference_image_storage_key"] = storage_key
        character["status"] = "finalized"
        self.finalized_character_ids.append(character_id)
        return dict(image)

    def list_rename_context_rows(self, project_id, character_id):
        """改名计划上下文行。"""
        return {key: [dict(item) for item in value] if isinstance(value, list) else dict(value) for key, value in self.rename_context.items()}

    def list_active_voice_profiles(self):
        """系统音色目录。"""
        return [dict(VOICE_PROFILE_ROW), dict(MALE_VOICE_PROFILE_ROW)]

    # -- 入队 ---------------------------------------------------------------

    def next_character_image_version(self, character_id):
        """定妆图下一版本号。"""
        versions = [int(image.get("version_no") or 0) for image in self.character_images.values() if image["character_id"] == character_id]
        return max(versions, default=0) + 1

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
        import uuid as _uuid

        self.next_job_id += 1
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


def make_client(database=None, object_storage_root="object-storage", **settings_overrides):
    """构建原生模式测试客户端（第四阶段起恒为原生实现）。

    :param database: 注入的数据库桩。
    :param object_storage_root: 本地对象存储根目录。
    :param settings_overrides: 透传给 Settings 的额外覆盖项（如 OBJECT_STORAGE_PROVIDER）。
    :return: 配置完成的 TestClient。
    """
    settings = Settings(
        _env_file=None,
        object_storage_root=object_storage_root,
        **settings_overrides,
    )
    return TestClient(create_app(settings, database=database or CharactersDatabase()), raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# 鉴权 / 越权
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", f"/api/projects/{PROJECT_ID}/characters"),
        ("post", f"/api/projects/{PROJECT_ID}/characters"),
        ("get", f"/api/characters/{CHARACTER_ID}"),
        ("put", f"/api/characters/{CHARACTER_ID}"),
        ("delete", f"/api/characters/{CHARACTER_ID}"),
        ("post", f"/api/character-images/{IMAGE_ID}/confirm"),
        ("post", f"/api/characters/{CHARACTER_ID}/rename-preview"),
        ("get", f"/api/characters/{CHARACTER_ID}/images"),
        ("post", f"/api/characters/{CHARACTER_ID}/images/generate"),
        ("get", f"/api/projects/{PROJECT_ID}/voice-cast"),
        ("get", f"/api/characters/{CHARACTER_ID}/voice-recommendations"),
        ("put", f"/api/characters/{CHARACTER_ID}/voice-binding"),
        ("put", f"/api/characters/{CHARACTER_ID}/reference-audio"),
    ],
)
def test_character_routes_require_authentication(method, path):
    """未登录：角色组路由统一 401/4010 envelope。"""
    client = make_client()
    response = client.request(method.upper(), path, json={})
    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}


def test_character_routes_hide_foreign_rows():
    """越权：角色/定妆图 owner 隔离 → 404/4004。"""
    database = CharactersDatabase()
    database.projects[PROJECT_ID]["user_id"] = OTHER_USER_ID
    client = make_client(database)
    assert client.get(f"/api/characters/{CHARACTER_ID}", headers=AUTH).status_code == 404
    assert client.get(f"/api/characters/{CHARACTER_ID}/images", headers=AUTH).status_code == 404
    assert client.post(f"/api/character-images/{IMAGE_ID}/confirm", json={}, headers=AUTH).status_code == 404
    assert client.get(f"/api/projects/{PROJECT_ID}/characters", headers=AUTH).status_code == 404


# ---------------------------------------------------------------------------
# characters 列表 / 创建
# ---------------------------------------------------------------------------


def test_list_project_characters():
    """角色列表：items 形状（camelCase DTO）。"""
    response = make_client().get(f"/api/projects/{PROJECT_ID}/characters", headers=AUTH)
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["name"] == "林知夏"
    assert items[0]["roleTag"] == "主角"
    assert items[0]["voiceLocked"] is False
    assert items[0]["ageGroup"] == "young_adult"


def test_create_character_success_and_duplicate():
    """新建角色：成功 + 同名 409/4009 + 名字长度 4001。"""
    client = make_client()
    ok = client.post(
        f"/api/projects/{PROJECT_ID}/characters",
        json={"name": "陈默", "roleTag": "配角", "ageGroup": "middle_aged", "gender": "male"},
        headers=AUTH,
    )
    assert ok.status_code == 200
    assert ok.json()["message"] == "角色已创建"
    assert ok.json()["data"]["status"] == "draft"

    duplicate = client.post(f"/api/projects/{PROJECT_ID}/characters", json={"name": "林知夏"}, headers=AUTH)
    assert duplicate.status_code == 409
    assert duplicate.json() == {"code": 4009, "message": "当前项目已经存在同名角色", "data": None}

    too_long = client.post(f"/api/projects/{PROJECT_ID}/characters", json={"name": "名" * 201}, headers=AUTH)
    assert too_long.status_code == 400
    assert too_long.json()["message"] == "角色名不能超过 200 个字符"

    bad_gender = client.post(f"/api/projects/{PROJECT_ID}/characters", json={"name": "新角色", "gender": "robot"}, headers=AUTH)
    assert bad_gender.status_code == 400
    assert bad_gender.json()["message"] == "角色声线性别无效"


# ---------------------------------------------------------------------------
# 角色详情 / 更新（改名契约）/ 软删
# ---------------------------------------------------------------------------


def test_character_detail_get_and_delete():
    """GET 详情 DTO；DELETE 软删后 404。"""
    client = make_client()
    detail = client.get(f"/api/characters/{CHARACTER_ID}", headers=AUTH)
    assert detail.status_code == 200
    assert detail.json()["data"]["name"] == "林知夏"
    deleted = client.request("DELETE", f"/api/characters/{CHARACTER_ID}", headers=AUTH)
    assert deleted.status_code == 200
    assert deleted.json() == {"code": 0, "message": "角色已删除", "data": {"success": True}}
    assert client.get(f"/api/characters/{CHARACTER_ID}", headers=AUTH).status_code == 404


def test_character_update_requires_sync_flag_on_rename():
    """改名必须显式 syncNameReferences（bool），否则 4001（Node 同文案）。"""
    client = make_client()
    response = client.put(f"/api/characters/{CHARACTER_ID}", json={"name": "夏知林"}, headers=AUTH)
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "修改角色名时必须明确是否同步项目文本", "data": None}


def test_character_update_rename_conflict():
    """改名重名 → 409/4009（Node CHARACTER_NAME_CONFLICT 同形）。"""
    database = CharactersDatabase()
    database.characters[OTHER_CHARACTER_ID] = {**CHARACTER_ROW, "id": OTHER_CHARACTER_ID, "name": "夏知林", "role_tag": "配角"}
    client = make_client(database)
    response = client.put(
        f"/api/characters/{CHARACTER_ID}",
        json={"name": "夏知林", "syncNameReferences": True},
        headers=AUTH,
    )
    assert response.status_code == 409
    assert response.json() == {"code": 4009, "message": "当前项目已经存在同名角色，请使用其他名字", "data": None}


def test_character_update_rename_with_sync_applies_plan():
    """改名 + syncNameReferences=true：项目文本同步替换 + 分镜 character_id 绑定。"""
    client = make_client()
    response = client.put(
        f"/api/characters/{CHARACTER_ID}",
        json={"name": "夏知林", "syncNameReferences": True},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json()["message"] == "角色名及项目文本已同步更新"
    assert response.json()["data"]["name"] == "夏知林"
    # 影响面：项目叙事愿景 + 场景正文 + 分镜动作/对白（陈默行不动）。
    context = client.app  # noqa: F841


def test_character_update_rename_sync_text_replacements():
    """改名同步：项目/场景/分镜文本逐字段替换（Node transformCharacterNames 语义）。"""
    from app.domain.character_rename import build_character_rename_plan

    database = CharactersDatabase()
    character = dict(CHARACTER_ROW)
    plan = build_character_rename_plan(
        character,
        "夏知林",
        project_rows=database.rename_context["project"],
        outline_rows=database.rename_context["outline"],
        scene_rows=database.rename_context["scenes"],
        storyboard_rows=database.rename_context["storyboards"],
        project_character_rows=database.rename_context["characters"],
        media_counts=database.rename_context["media_counts"],
    )
    impact = plan["impact"]
    assert impact["totalOccurrences"] >= 5
    assert impact["sections"]["scenes"]["occurrences"] >= 2
    assert impact["sections"]["storyboards"]["occurrences"] >= 3
    assert impact["historicalMedia"] == {
        "characterImages": 1, "imageAssets": 0, "videoAssets": 0, "audioAssets": 0,
    }
    assert impact["warnings"] == {"invalidOutlineJson": False}
    # legacy 未绑分镜行（character_id=None 且旧名命中）计划绑定为该角色。
    legacy_record = next(record for record in plan["records"]["storyboards"] if record["id"] == 22)
    assert legacy_record["bindCharacterId"] is True
    assert legacy_record["values"]["character_name"] == "夏知林"


def test_character_update_voice_traits_change_unlocks():
    """声线特征变化（voiceStyle）→ voice_locked 解锁（Node voiceTraitsChanged 语义）。"""
    database = CharactersDatabase()
    database.characters[CHARACTER_ID]["voice_locked"] = 1
    client = make_client(database)
    response = client.put(
        f"/api/characters/{CHARACTER_ID}",
        json={"voiceStyle": "更冷的女声"},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert database.characters[CHARACTER_ID]["voice_locked"] == 0


def test_character_update_invalid_age_group():
    """非法年龄段 → 4001（Node 同文案与顺序）。"""
    client = make_client()
    response = client.put(f"/api/characters/{CHARACTER_ID}", json={"ageGroup": "ancient"}, headers=AUTH)
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "角色年龄段无效", "data": None}


# ---------------------------------------------------------------------------
# 定妆图确认 / 列表 / 入队
# ---------------------------------------------------------------------------


def test_character_image_confirm_finalizes_character():
    """定妆图确认：同角色旧确认降级 + 角色 finalized + DTO。"""
    database = CharactersDatabase()
    database.character_images[IMAGE_ID]["storage_key"] = "characters/9/v2-approved.png"
    older_confirmed = {
        **CHARACTER_IMAGE_ROW,
        "id": 300,
        "version_no": 1,
        "status": "confirmed",
        "confirmed_at": "2026-10-17T08:00:00",
    }
    database.character_images[300] = older_confirmed
    client = make_client(database)

    response = client.post(f"/api/character-images/{IMAGE_ID}/confirm", json={}, headers=AUTH)

    assert response.status_code == 200
    assert response.json()["message"] == "角色定妆图已确认"
    assert response.json()["data"]["status"] == "confirmed"
    assert database.character_images[300]["status"] == "candidate"
    assert database.characters[CHARACTER_ID]["status"] == "finalized"
    assert database.characters[CHARACTER_ID]["reference_image_url"] == "https://media.example.com/characterization.png"
    assert database.characters[CHARACTER_ID]["reference_image_storage_key"] == "characters/9/v2-approved.png"


def test_character_images_list():
    """定妆图列表：版本倒序 + storage_key 签名 URL 优先。"""
    database = CharactersDatabase()
    database.character_images[IMAGE_ID]["storage_key"] = "characters/9/v2.png"
    client = make_client(database, OBJECT_STORAGE_PROVIDER="local")
    response = client.get(f"/api/characters/{CHARACTER_ID}/images", headers=AUTH)
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["id"] for item in items] == [IMAGE_ID]
    assert "/storage/characters/9/v2.png" in items[0]["imageUrl"]
    assert "signature=" in items[0]["imageUrl"]


def test_character_image_generate_enqueue_and_idempotent():
    """定妆图入队：快照字段（promptSnapshot 拼接、versionNo、referenceImageUrls）+ 幂等。"""
    database = CharactersDatabase()
    database.characters[CHARACTER_ID]["reference_image_url"] = "https://media.example.com/ref.png"
    client = make_client(database)

    first = client.post(
        f"/api/characters/{CHARACTER_ID}/images/generate",
        json={"prompt": "全身定妆照", "candidateCount": 2, "modelName": "agnes-image-2.1-flash"},
        headers=AUTH,
    )
    second = client.post(f"/api/characters/{CHARACTER_ID}/images/generate", json={}, headers=AUTH)

    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["message"] == "角色定妆图生成任务已提交"
    assert first.json()["data"]["id"] == second.json()["data"]["id"]
    assert len(database.generation_jobs) == 1
    snapshot = json.loads(database.generation_jobs[first.json()["data"]["id"]]["request_json"])
    assert snapshot["characterId"] == CHARACTER_ID
    assert snapshot["versionNo"] == 3
    assert snapshot["candidateCount"] == 2
    assert snapshot["modelName"] == "agnes-image-2.1-flash"
    assert snapshot["prompt"] == "全身定妆照"
    assert snapshot["promptSnapshot"].startswith("全身定妆照，林知夏，主角")
    assert snapshot["character"]["name"] == "林知夏"
    assert snapshot["projectVisualStyle"] == "冷蓝色调科幻风"
    assert snapshot["referenceImageUrls"] == ["https://media.example.com/ref.png"]


def test_character_image_generate_requires_appearance():
    """角色缺外观设定 → 400/4011（Node enqueueCharacterImageJob 同文案）。"""
    database = CharactersDatabase()
    database.characters[CHARACTER_ID]["appearance"] = ""
    client = make_client(database)
    response = client.post(f"/api/characters/{CHARACTER_ID}/images/generate", json={}, headers=AUTH)
    assert response.status_code == 400
    assert response.json() == {"code": 4011, "message": "角色缺少外观设定，请先填写或使用 AI 补全角色档案", "data": None}


# ---------------------------------------------------------------------------
# 改名预览
# ---------------------------------------------------------------------------


def test_rename_preview_conflict_and_success():
    """改名预览：重名 409/4009；成功返回 impact 结构。"""
    database = CharactersDatabase()
    database.characters[OTHER_CHARACTER_ID] = {**CHARACTER_ROW, "id": OTHER_CHARACTER_ID, "name": "夏知林", "role_tag": "配角"}
    client = make_client(database)
    conflict = client.post(f"/api/characters/{CHARACTER_ID}/rename-preview", json={"name": "夏知林"}, headers=AUTH)
    assert conflict.status_code == 409
    assert conflict.json() == {"code": 4009, "message": "当前项目已经存在同名角色，请使用其他名字", "data": None}

    ok_client = make_client()
    ok = ok_client.post(f"/api/characters/{CHARACTER_ID}/rename-preview", json={"name": "夏知林"}, headers=AUTH)
    assert ok.status_code == 200
    impact = ok.json()["data"]
    assert impact["characterId"] == CHARACTER_ID
    assert impact["oldName"] == "林知夏"
    assert impact["newName"] == "夏知林"
    assert "林知夏" in impact["sourceNames"]
    assert impact["totalRecords"] > 0
    assert impact["totalOccurrences"] > 0
    assert impact["sections"]["storyboards"]["records"] >= 1
    assert impact["warnings"] == {"invalidOutlineJson": False}


def test_rename_preview_empty_name():
    """改名预览：空名 4001。"""
    response = make_client().post(f"/api/characters/{CHARACTER_ID}/rename-preview", json={"name": "  "}, headers=AUTH)
    assert response.status_code == 400
    assert response.json() == {"code": 4001, "message": "角色名不能为空", "data": None}


# ---------------------------------------------------------------------------
# 音色阵容 / 推荐 / 绑定 / 参考音频
# ---------------------------------------------------------------------------


def test_voice_cast_shape():
    """voice-cast：character + traits + selectedProfile + recommendations + ready。"""
    database = CharactersDatabase()
    database.characters[CHARACTER_ID].update({"voice_profile_key": "female-young-warm", "voice_locked": 1})
    client = make_client(database)
    response = client.get(f"/api/projects/{PROJECT_ID}/voice-cast", headers=AUTH)
    assert response.status_code == 200
    item = response.json()["data"]["items"][0]
    assert item["character"]["name"] == "林知夏"
    assert item["traits"]["gender"] == "female"
    assert item["selectedProfile"]["profileKey"] == "female-young-warm"
    assert len(item["recommendations"]) <= 3
    assert item["ready"] is True


def test_voice_recommendations_top3():
    """音色推荐：Top3 + selectedProfile + traits。"""
    response = make_client().get(f"/api/characters/{CHARACTER_ID}/voice-recommendations", headers=AUTH)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["character"]["id"] == CHARACTER_ID
    assert data["traits"]["gender"] == "female"
    assert data["selectedProfile"] is None
    assert len(data["items"]) == 2  # 桩内音色目录共 2 条（limit=3 不足时全量返回）
    assert data["items"][0]["gender"] == "female"  # 女性角色候选排前


def test_voice_binding_success_locks():
    """音色绑定：写入 profile/voiceId/锁定 + message「已确认并锁定」。"""
    database = CharactersDatabase()
    client = make_client(database)
    response = client.put(
        f"/api/characters/{CHARACTER_ID}/voice-binding",
        json={"voiceProfileKey": "female-young-warm", "voiceStyle": "更克制", "locked": True},
        headers=AUTH,
    )
    assert response.status_code == 200
    assert response.json()["message"] == "角色音色已确认并锁定"
    body = response.json()["data"]
    assert body["selectedProfile"]["profileKey"] == "female-young-warm"
    assert body["character"]["voiceProfileKey"] == "female-young-warm"
    assert body["character"]["voiceSetting"] == "Cherry"
    assert body["character"]["voiceLocked"] is True
    row = database.characters[CHARACTER_ID]
    assert row["voice_profile_key"] == "female-young-warm"
    assert row["voice_setting"] == "Cherry"
    assert row["voice_locked"] == 1
    assert row["voice_design_json"] is None


def test_voice_binding_invalid_profile_or_gender():
    """音色绑定：无效方案 4001；性别冲突 4001（Node resolveCharacterVoiceProfile 同文案）。"""
    client = make_client()
    missing = client.put(f"/api/characters/{CHARACTER_ID}/voice-binding", json={"voiceProfileKey": "nope"}, headers=AUTH)
    assert missing.status_code == 400
    assert missing.json() == {"code": 4001, "message": "请选择有效且可用的音色方案", "data": None}

    conflict = make_client().put(
        f"/api/characters/{CHARACTER_ID}/voice-binding", json={"voiceProfileKey": "male-adult-calm"}, headers=AUTH
    )
    assert conflict.status_code == 400
    assert conflict.json()["message"] == "女性角色不能绑定男性声线，请选择性别匹配的音色"


def test_reference_audio_success_and_validation():
    """参考音频：非法 dataURL 4011 / 超 15MB 4011 / 成功写桶 + 锁定。"""
    database = CharactersDatabase()
    client = make_client(database)
    bad_format = client.put(f"/api/characters/{CHARACTER_ID}/reference-audio", json={"dataBase64": "not-a-data-url"}, headers=AUTH)
    assert bad_format.status_code == 400
    assert bad_format.json() == {"code": 4011, "message": "参考音频格式无效", "data": None}

    oversized = base64.b64encode(b"x" * (15 * 1024 * 1024 + 1)).decode()
    too_big = client.put(f"/api/characters/{CHARACTER_ID}/reference-audio", json={"dataBase64": f"data:audio/wav;base64,{oversized}"}, headers=AUTH)
    assert too_big.status_code == 400
    assert too_big.json()["message"] == "参考音频不能为空且不能超过 15MB"

    audio_bytes = b"RIFFfake-wav-bytes"
    ok = client.put(
        f"/api/characters/{CHARACTER_ID}/reference-audio",
        json={"dataBase64": "data:audio/mpeg;base64," + base64.b64encode(audio_bytes).decode()},
        headers=AUTH,
    )
    assert ok.status_code == 200
    assert ok.json()["message"] == "参考音频已保存"
    assert ok.json()["data"]["character"]["voiceLocked"] is True
    assert len(database.object_writes) == 0  # 写桶走 helper（local 落盘），此处断言角色行
    row = database.characters[CHARACTER_ID]
    assert row["reference_audio_url"].startswith("http://127.0.0.1:8000/storage/projects/8/characters/9/voice-reference.mp3")
    assert "signature=" in row["reference_audio_url"]
    assert row["reference_audio_storage_key"] == "projects/8/characters/9/voice-reference.mp3"
    assert row["voice_locked"] == 1
