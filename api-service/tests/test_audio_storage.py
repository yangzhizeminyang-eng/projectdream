from __future__ import annotations

from app.config import Settings
from app.main import _write_object_bytes
import app.main as main_module
import app.media_service as media_service


def test_generated_audio_bytes_are_uploaded_to_cos(monkeypatch):
    calls = []

    class FakeCos:
        def put_object(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(media_service, "cos_client_factory", lambda _settings: FakeCos())
    monkeypatch.setattr(main_module, "_object_storage_url", lambda _key, _settings: None)
    settings = Settings(
        _env_file=None,
        object_storage_provider="cos",
        object_storage_public_base_url="https://cdn.example/storage",
        cos_secret_id="id",
        cos_secret_key="secret",
        cos_bucket="bucket",
        cos_region="ap-shanghai",
    )

    result = _write_object_bytes(settings, "projects/1/generated-audio/dialogue/a.wav", b"wav", "audio/wav")

    assert calls == [{"Bucket": "bucket", "Key": "projects/1/generated-audio/dialogue/a.wav", "Body": b"wav", "ContentType": "audio/wav"}]
    assert result["key"] == "projects/1/generated-audio/dialogue/a.wav"
    assert "projects/1/generated-audio/dialogue/a.wav" in result["url"]
