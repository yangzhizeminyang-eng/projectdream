"""Native audio route contract tests using only mock audio and an in-memory database."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


USER = {"id": 7, "phone": "13912345678", "nickname": "音频测试", "createdAt": "2026-10-20T00:00:00.000Z"}


class AudioDatabase:
    def __init__(self):
        self.settings = {"AUDIO_PROVIDER": "mock"}
        self.audio_assets = []
        self.characters = {
            9: {"id": 9, "project_id": 1, "ownerId": 7, "name": "林夏", "voice_setting": "Cherry",
                "voice_profile_key": "female-young", "voice_style": "清晰温柔", "voice_locked": 1,
                "gender": "female", "age_group": "青年"},
        }

    def find_user_by_token(self, token):
        return USER if token == "audio-test-token" else None

    def get_project(self, project_id, user_id):
        return {"id": 1, "user_id": 7, "name": "测试项目"} if project_id == 1 and user_id == 7 else None

    def get_character_for_user(self, character_id, extra_project_columns=""):
        return self.characters.get(character_id)

    def list_active_voice_profiles(self):
        return [{"profile_key": "female-young", "display_name": "清晰女声", "gender": "female",
                 "voice_id": "Cherry", "model_name": "qwen3-tts-flash", "instructions": "自然表达", "status": "active"}]

    def get_model_settings_map(self):
        return dict(self.settings)

    def update_character_voice_binding(self, character_id, assignments):
        self.characters[character_id].update(assignments)
        return self.characters[character_id]

    def create_audio_assets(self, project_id, user_id, values):
        if self.get_project(project_id, user_id) is None:
            return None
        version = max((row["version_no"] for row in self.audio_assets), default=0) + 1
        rows = []
        for value in values:
            row = {"id": len(self.audio_assets) + 1, "project_id": project_id, "version_no": version,
                   "status": "candidate", "created_at": "2026-10-20 10:00:00", **value}
            row["audio_url"] = str(row.get("audio_url") or "").replace("{version}", str(version))
            self.audio_assets.append(row)
            rows.append(row)
        return rows

    def get_scene(self, scene_id, user_id):
        return {"id": 4, "project_id": 1, "scene_no": 2, "title": "雨夜", "summary": "林夏逃离追兵", "content": ""} if scene_id == 4 and user_id == 7 else None

    def get_storyboard(self, storyboard_id, user_id):
        return {"id": 21, "project_id": 1, "scene_id": 4, "shot_no": 3, "duration_seconds": 5,
                "dialogue_text": "林夏：快走。"} if storyboard_id == 21 and user_id == 7 else None

    def create_audio_assets(self, project_id, user_id, values):
        if self.get_project(project_id, user_id) is None:
            return None
        version = max((row["version_no"] for row in self.audio_assets), default=0) + 1
        created = []
        for value in values:
            row = {"id": len(self.audio_assets) + 1, "project_id": project_id, "version_no": version,
                   "status": "candidate", "created_at": "2026-10-20 10:00:00", **value}
            row["audio_url"] = str(row.get("audio_url") or "").replace("{version}", str(version))
            self.audio_assets.append(row)
            created.append(row)
        return created


def _client(database=None, **settings_kwargs):
    return TestClient(create_app(Settings(_env_file=None, **settings_kwargs), database=database or AudioDatabase()))


def test_project_audio_generate_is_native_and_persists_mock_candidate():
    database = AudioDatabase()
    response = _client(database).post(
        "/api/projects/1/audio/generate",
        headers={"Authorization": "Bearer audio-test-token"},
        json={"trackType": "narration", "sceneId": 4, "text": "雨夜里，林夏终于甩开了追兵。", "candidateCount": 1},
    )

    assert response.status_code == 200, response.text
    item = response.json()["data"]["items"][0]
    assert item["trackType"] == "narration"
    assert item["sceneId"] == 4
    assert item["versionNo"] == 1
    assert item["status"] == "candidate"
    assert item["audioUrl"].endswith("/mock/audio/1/4/0/1/narration/1.wav")
    assert database.audio_assets[0]["title"].startswith("旁白轨")


def test_voice_preview_is_native_for_locked_character_in_mock_mode():
    response = _client().post(
        "/api/characters/9/voice-preview",
        headers={"Authorization": "Bearer audio-test-token"},
        json={"text": "我不会让你一个人留在这里。"},
    )

    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["audioUrl"].endswith("/mock/audio/1/0/9/1/voice-preview/1.wav")
    assert result["voiceName"] == "Cherry"
    assert result["voiceProfileKey"] == "female-young"


def test_tts_routes_require_authentication_and_do_not_disclose_route_as_unimplemented():
    client = _client()

    audio = client.post("/api/projects/1/audio/generate", json={})
    preview = client.post("/api/characters/9/voice-preview", json={})

    assert audio.status_code == 401
    assert preview.status_code == 401
    assert audio.json()["code"] != 5010
    assert preview.json()["code"] != 5010


def test_dashscope_audio_generation_persists_bytes_and_signed_object_key(monkeypatch, tmp_path):
    import app.main as main_module

    database = AudioDatabase()
    database.settings.update({"AUDIO_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "configured-test-key"})

    async def fake_synthesize(**_kwargs):
        return {"audio_bytes": b"sample-wav", "content_type": "audio/wav", "duration_seconds": 2.5,
                "request_id": "tts-1", "model_name": "qwen3-tts-flash", "voice_name": "Cherry"}

    monkeypatch.setattr(main_module, "synthesize_audio", fake_synthesize)
    response = _client(database, object_storage_root=str(tmp_path / "objects"), generated_audio_dir=str(tmp_path / "generated")).post(
        "/api/projects/1/audio/generate",
        headers={"Authorization": "Bearer audio-test-token"},
        json={"trackType": "narration", "sceneId": 4, "text": "雨夜里，林夏终于甩开了追兵。"},
    )

    assert response.status_code == 200, response.text
    item = response.json()["data"]["items"][0]
    assert item["storageKey"].startswith("projects/1/generated-audio/narration/")
    assert item["durationSeconds"] == 2.5
    assert item["audioUrl"].startswith("http://127.0.0.1:8000/storage/")
    key = item["storageKey"]
    assert (tmp_path / "objects" / key).read_bytes() == b"sample-wav"


def test_voice_agent_enrollment_persists_custom_voice_and_preview(monkeypatch, tmp_path):
    import app.main as main_module

    database = AudioDatabase()
    database.settings.update({"AUDIO_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "configured-test-key"})

    async def fake_enrollment(**_kwargs):
        return {"voice_id": "char9-designed", "target_model": "cosyvoice-v3.5-flash",
                "preview_audio_bytes": b"preview-wav", "request_id": "enroll-9"}

    monkeypatch.setattr(main_module, "create_qwen_designed_voice", fake_enrollment)
    response = _client(database, object_storage_root=str(tmp_path / "objects"), generated_audio_dir=str(tmp_path / "generated")).post(
        "/api/characters/9/voice-preview",
        headers={"Authorization": "Bearer audio-test-token"},
        json={"voiceAgent": True, "text": "我给过你机会，现在把你知道的都说出来。"},
    )

    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["voiceId"] == "char9-designed"
    assert result["voiceDesign"]["provider"] == "qwen"
    assert result["voiceDesign"]["generationSource"] == "rules_fallback"
    assert database.characters[9]["voice_setting"] == "char9-designed"
    assert database.characters[9]["voice_locked"] == 0
    preview_name = result["audioUrl"].rsplit("/", 1)[-1]
    assert (tmp_path / "generated" / preview_name).read_bytes() == b"preview-wav"


def test_voice_agent_preview_can_be_confirmed_and_bound_as_reference_audio(monkeypatch, tmp_path):
    import app.main as main_module

    database = AudioDatabase()
    database.settings.update({"AUDIO_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "configured-test-key"})

    async def fake_enrollment(**_kwargs):
        return {"voice_id": "char9-designed", "target_model": "cosyvoice-v3.5-flash",
                "preview_audio_bytes": b"preview-wav", "request_id": "enroll-9"}

    monkeypatch.setattr(main_module, "create_qwen_designed_voice", fake_enrollment)
    client = _client(database, object_storage_root=str(tmp_path / "objects"), generated_audio_dir=str(tmp_path / "generated"))
    headers = {"Authorization": "Bearer audio-test-token"}
    preview = client.post("/api/characters/9/voice-preview", headers=headers, json={"voiceAgent": True})
    preview_url = preview.json()["data"]["audioUrl"]

    bound = client.post("/api/characters/9/voice-preview", headers=headers, json={
        "bindReferenceAudio": True, "previewAudioUrl": preview_url,
        "voiceId": "char9-designed", "voiceDesign": preview.json()["data"]["voiceDesign"],
    })

    assert bound.status_code == 200, bound.text
    assert bound.json()["data"]["referenceAudioBound"] is True
    assert database.characters[9]["voice_locked"] == 1
    assert database.characters[9]["reference_audio_storage_key"].startswith("projects/1/characters/9/")


def test_voice_agent_binding_rejects_another_characters_preview_without_locking():
    database = AudioDatabase()
    database.characters[9].update({
        "voice_setting": "char9-designed", "voice_locked": 0,
        "voice_design_json": '{"provider":"qwen","voiceId":"char9-designed","targetModel":"cosyvoice-v3.5-flash"}',
    })

    response = _client(database).post("/api/characters/9/voice-preview", headers={
        "Authorization": "Bearer audio-test-token",
    }, json={
        "bindReferenceAudio": True,
        "previewAudioUrl": "/generated/audio/audio-1-voice-preview-10-foreign.wav",
        "voiceId": "char9-designed",
        "voiceDesign": {"voiceId": "char9-designed"},
    })

    assert response.status_code == 400
    assert database.characters[9]["voice_locked"] == 0


def test_dashscope_provider_error_is_not_reported_as_success(monkeypatch):
    from app.audio_generation import AudioProviderError
    import app.main as main_module

    database = AudioDatabase()
    database.settings.update({"AUDIO_PROVIDER": "dashscope", "DASHSCOPE_API_KEY": "configured-test-key"})

    async def fail(**_kwargs):
        raise AudioProviderError("provider rate limit", 429)

    monkeypatch.setattr(main_module, "synthesize_audio", fail)
    response = _client(database).post("/api/projects/1/audio/generate", headers={
        "Authorization": "Bearer audio-test-token",
    }, json={"trackType": "narration", "text": "这是一段足够长的旁白文本。"})

    assert response.status_code == 502
    assert response.json()["code"] == 5020
    assert database.audio_assets == []
