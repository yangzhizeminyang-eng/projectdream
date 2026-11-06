import asyncio
import json
import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class CharacterGenerationDatabase:
    def __init__(self):
        self.project = {
            "id": 8,
            "user_id": 7,
            "name": "夜班档案室",
            "category": "悬疑",
            "visual_style": "冷色写实",
            "narrative_vision": "一名档案员发现自己的死亡记录。",
        }
        self.outline = None
        self.scenes = [
            {"id": 31, "project_id": 8, "scene_no": 1, "title": "档案室", "summary": "林知夏发现记录", "content": "林知夏翻开档案。"}
        ]
        self.story_bible = None
        self.saved_characters = []
        self.existing_characters = {}
        self.asset_nodes = []
        self.character = {
            "id": 11, "project_id": 8, "ownerId": 7, "name": "林知夏",
            "role_tag": "主角", "personality": "克制", "appearance": "黑色短发",
            "costume": "灰色风衣", "age_group": "young_adult", "gender": "female",
            "voice_style": "低沉克制", "voice_locked": 1,
        }
        self.updated_character = None

    def find_user_by_token(self, token):
        return {"id": 7, "phone": "13912345678"} if token == "session-token" else None

    def get_project(self, project_id, user_id):
        return dict(self.project) if project_id == 8 and user_id == 7 else None

    def latest_outline_row(self, project_id):
        return self.outline

    def list_scenes(self, project_id, user_id):
        return list(self.scenes) if project_id == 8 and user_id == 7 else None

    def latest_story_bible_row(self, project_id):
        return self.story_bible

    def upsert_generated_characters(self, project_id, characters):
        self.saved_characters = [dict(character) for character in characters]
        rows = []
        for index, character in enumerate(characters):
            existing = self.existing_characters.get(character["name"], {})
            row = {**existing, **character, "id": existing.get("id", index + 1), "project_id": project_id, "status": "draft"}
            self.existing_characters[character["name"]] = row
            rows.append(dict(row))
        return rows

    def list_asset_canvas_nodes(self, project_id):
        return list(self.asset_nodes)

    def create_asset_node(self, project_id, payload):
        row = {**payload, "id": len(self.asset_nodes) + 1, "project_id": project_id, "status": "active"}
        self.asset_nodes.append(row)
        return row

    def get_character_for_user(self, character_id, extra_project_columns=""):
        return dict(self.character) if character_id == 11 else None

    def update_character_txn(self, character_id, assignments, **_kwargs):
        self.updated_character = dict(assignments)
        self.character.update(assignments)
        return dict(self.character)


def test_character_generation_persists_normalized_ai_results_and_returns_character_dtos(monkeypatch):
    database = CharacterGenerationDatabase()
    async def generated(*_args, **_kwargs):
        return {"characters": [{
            "name": " 林知夏 ", "role_tag": "主角", "personality": "克制",
            "appearance": "黑色短发", "costume": "灰色风衣", "age_group": "young_adult",
            "gender": "female", "voice_style": "清晰克制",
        }]}
    monkeypatch.setattr("app.main.ai_generate_characters", generated, raising=False)
    app = create_app(Settings(_env_file=None), database=database)

    response = TestClient(app).post(
        "/api/projects/8/characters/generate",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 0
    assert body["data"]["items"][0]["name"] == "林知夏"
    assert database.saved_characters[0]["gender"] == "female"
    assert database.saved_characters[0]["age_group"] == "young_adult"
    assert body["data"]["items"][0]["projectId"] == 8
    assert [(node["nodeType"], node["refId"]) for node in database.asset_nodes] == [
        ("character", 1), ("scene", 31),
    ]


def test_character_generation_rejects_projects_without_outline_or_script():
    database = CharacterGenerationDatabase()
    database.scenes = [{"id": 31, "project_id": 8, "scene_no": 1, "title": "空场", "content": " "}]
    app = create_app(Settings(_env_file=None), database=database)

    response = TestClient(app).post(
        "/api/projects/8/characters/generate",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 400
    assert response.json()["code"] == 4004
    assert database.saved_characters == []


def test_character_generation_rejects_empty_model_result_without_mutating_database(monkeypatch):
    database = CharacterGenerationDatabase()
    async def generated(*_args, **_kwargs):
        return {"characters": []}
    monkeypatch.setattr("app.main.ai_generate_characters", generated, raising=False)
    app = create_app(Settings(_env_file=None), database=database)

    response = TestClient(app).post(
        "/api/projects/8/characters/generate",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 502
    assert response.json()["code"] == 5001
    assert database.saved_characters == []


def test_character_generation_requires_authentication():
    database = CharacterGenerationDatabase()
    app = create_app(Settings(_env_file=None), database=database)

    response = TestClient(app).post("/api/projects/8/characters/generate")

    assert response.status_code == 401
    assert response.json()["code"] == 4010
    assert database.saved_characters == []


def test_character_generator_uses_configured_model_and_filters_names_not_in_script(monkeypatch):
    from app.ai_generators import generate_characters

    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_BASE_URL", "https://model.example/v1")
    monkeypatch.setenv("AI_API_KEY", "test-only")
    monkeypatch.setenv("AI_MODEL", "test-model")
    monkeypatch.setenv("AI_MODEL_CHARACTER", "character-model")
    monkeypatch.setenv("AI_FALLBACK_TO_MOCK", "false")
    requests = []

    def model(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"characters": ['
            '{"name":"林知夏","role_tag":"主角","gender":"female"},'
            '{"name":"旧总纲角色","role_tag":"配角"},'
            '{"name":"林知夏","role_tag":"重复"}]}'}}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(model)) as client:
            return await generate_characters(
                project={"name": "夜班档案室"}, outline=None,
                scenes=[{"scene_no": 1, "content": "林知夏翻开档案。"}],
                story_bible=None, client=client,
            )
    result = asyncio.run(run())

    assert len(requests) == 1
    assert requests[0].url.path == "/v1/chat/completions"
    assert json.loads(requests[0].read())["model"] == "character-model"
    assert result["characters"] == [{
        "name": "林知夏", "role_tag": "主角",
        "personality": "性格鲜明，行为动机与剧情目标一致。",
        "appearance": "具有清晰可辨的脸部、发型、体态与服装特征。",
        "costume": None, "voice_setting": None, "age_group": None,
        "gender": "female", "voice_style": None,
    }]


def test_character_generator_uses_node_compatible_mock_without_calling_provider(monkeypatch):
    from app.ai_generators import generate_characters

    monkeypatch.setenv("AI_PROVIDER", "mock")
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _request: pytest.fail("mock provider must not make a network request")
        )) as client:
            return await generate_characters(
                project={"name": "夜班档案室"}, outline=None,
            scenes=[{"content": "角色：林知夏，正在档案室查找记录。"}],
                story_bible=None, client=client,
            )
    result = asyncio.run(run())

    assert result["characters"][0]["name"] == "林知夏"
    assert result["characters"][0]["role_tag"] == "主角"


def test_character_generation_returns_safe_upstream_error_without_persisting(monkeypatch):
    from app.ai_provider import AiProviderError

    database = CharacterGenerationDatabase()

    async def generated(*_args, **_kwargs):
        raise AiProviderError("模型暂不可用", detail="secret must not leak")

    monkeypatch.setattr("app.main.ai_generate_characters", generated, raising=False)
    response = TestClient(create_app(Settings(_env_file=None), database=database)).post(
        "/api/projects/8/characters/generate",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 502
    assert response.json() == {"code": 5020, "message": "模型暂不可用", "data": None}
    assert database.saved_characters == []
    assert database.asset_nodes == []


def test_generate_profile_completes_existing_fields_and_resets_voice_lock(monkeypatch):
    from app.ai_provider import AiProviderError

    async def generate_profile(*_args, **_kwargs):
        return {
            "role_tag": "女主角", "personality": "理性但有同理心",
            "appearance": "黑发，左眉有浅疤", "costume": "不应覆盖已有服装",
            "age_group": "young_adult", "gender": "female", "voice_style": "清晰偏低",
        }

    monkeypatch.setattr("app.main.ai_generate_character_profile", generate_profile, raising=False)
    database = CharacterGenerationDatabase()
    response = TestClient(create_app(Settings(_env_file=None), database=database)).post(
        "/api/characters/11/generate-profile",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 200
    assert response.json()["message"] == "角色档案已补全"
    assert database.updated_character == {
        "role_tag": "女主角", "personality": "理性但有同理心",
        "appearance": "黑发，左眉有浅疤", "age_group": "young_adult",
        "gender": "female", "voice_style": "清晰偏低", "voice_locked": 0,
    }
    assert response.json()["data"]["costume"] == "灰色风衣"


def test_generate_profile_rejects_foreign_character_and_preserves_voice_lock():
    database = CharacterGenerationDatabase()
    database.character["ownerId"] = 99
    response = TestClient(create_app(Settings(_env_file=None), database=database)).post(
        "/api/characters/11/generate-profile",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 404
    assert response.json()["code"] == 4004
    assert database.updated_character is None


def test_generate_profile_maps_provider_failure_without_partial_update(monkeypatch):
    from app.ai_provider import AiProviderError

    async def fail(*_args, **_kwargs):
        raise AiProviderError("文本模型暂不可用", detail="private provider detail")

    monkeypatch.setattr("app.main.ai_generate_character_profile", fail, raising=False)
    database = CharacterGenerationDatabase()
    response = TestClient(create_app(Settings(_env_file=None), database=database)).post(
        "/api/characters/11/generate-profile",
        headers={"Authorization": "Bearer session-token"},
    )

    assert response.status_code == 502
    assert response.json() == {"code": 5020, "message": "文本模型暂不可用", "data": None}
    assert database.updated_character is None


def test_character_profile_generator_uses_character_model_and_preserves_costume(monkeypatch):
    from app.ai_generators import generate_character_profile

    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_BASE_URL", "https://model.example/v1")
    monkeypatch.setenv("AI_API_KEY", "test-only")
    monkeypatch.setenv("AI_MODEL", "generic-model")
    monkeypatch.setenv("AI_MODEL_CHARACTER", "character-model")
    monkeypatch.setenv("AI_FALLBACK_TO_MOCK", "false")
    requests = []

    def model(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content":
            '{"personality":"理性、克制","appearance":"黑发浅疤","age_group":"young_adult","gender":"female","voice_style":"清晰偏低"}'
        }}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(model)) as client:
            return await generate_character_profile(
                character={"name": "林知夏", "costume": "灰色风衣", "voice_locked": 1},
                project={"name": "夜班档案室"}, scenes=[{"content": "林知夏翻开档案。"}], client=client,
            )

    result = asyncio.run(run())
    assert json.loads(requests[0].read())["model"] == "character-model"
    assert result["personality"] == "理性、克制"
    assert result["appearance"] == "黑发浅疤"
    assert result["costume"] == "灰色风衣"


def test_character_profile_mock_mode_keeps_current_profile_without_network(monkeypatch):
    from app.ai_generators import generate_character_profile

    monkeypatch.setenv("AI_PROVIDER", "mock")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda _request: pytest.fail("mock profile must not make a network request")
        )) as client:
            return await generate_character_profile(
                character={"name": "林知夏", "personality": "克制", "costume": "灰色风衣"},
                project={}, scenes=[], client=client,
            )

    result = asyncio.run(run())
    assert result["personality"] == "克制"
    assert result["costume"] == "灰色风衣"
