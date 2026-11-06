import hashlib
import hmac
import sys
import types
from urllib.parse import parse_qs, urlparse

from app.config import Settings
from app.media_urls import create_object_url_resolver, resolve_object_url


def test_local_storage_url_matches_node_hmac_contract_and_encodes_path_segments():
    settings = Settings(
        _env_file=None,
        OBJECT_STORAGE_PROVIDER="local",
        OBJECT_STORAGE_PUBLIC_BASE_URL="https://media.example/storage",
        OBJECT_STORAGE_SIGNING_SECRET="test-secret",
        OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS=900,
    )

    url = resolve_object_url("projects/8/audio track.wav", settings, now=1_800_000_000)

    parsed = urlparse(url)
    expires = str(1_800_000_900)
    expected = hmac.new(
        b"test-secret",
        f"projects/8/audio track.wav\n{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert parsed.path == "/storage/projects/8/audio%20track.wav"
    assert parse_qs(parsed.query) == {"expires": [expires], "signature": [expected]}


def test_cos_storage_url_uses_official_sdk_with_configured_bucket_region_domain_and_ttl(monkeypatch):
    calls = {}

    class FakeCosConfig:
        def __init__(self, **kwargs):
            calls["config"] = kwargs

    class FakeCosS3Client:
        def __init__(self, config):
            calls["client_creations"] = calls.get("client_creations", 0) + 1
            calls["client_config"] = config

        def get_presigned_url(self, **kwargs):
            calls.setdefault("signs", []).append(kwargs)
            return "https://cdn.example/audio.wav?q-signature=test"

    monkeypatch.setitem(sys.modules, "qcloud_cos", types.SimpleNamespace(CosConfig=FakeCosConfig, CosS3Client=FakeCosS3Client))
    settings = Settings(
        _env_file=None,
        OBJECT_STORAGE_PROVIDER="cos",
        OBJECT_STORAGE_PUBLIC_BASE_URL="https://cdn.example",
        COS_SECRET_ID="secret-id",
        COS_SECRET_KEY="secret-key",
        COS_BUCKET="projectdream-123456",
        COS_REGION="ap-guangzhou",
        COS_DOMAIN="cdn.example",
        COS_PROTOCOL="https:",
        OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS=600,
    )

    resolver = create_object_url_resolver(settings)
    url = resolver("projects/8/audio.wav")
    second_url = resolver("projects/8/second.wav")

    assert url == "https://cdn.example/audio.wav?q-signature=test"
    assert second_url == "https://cdn.example/audio.wav?q-signature=test"
    assert calls["config"] == {
        "Region": "ap-guangzhou",
        "SecretId": "secret-id",
        "SecretKey": "secret-key",
        "Scheme": "https",
        "Domain": "cdn.example",
    }
    assert calls["signs"] == [
        {"Bucket": "projectdream-123456", "Key": "projects/8/audio.wav", "Method": "GET", "Expired": 600},
        {"Bucket": "projectdream-123456", "Key": "projects/8/second.wav", "Method": "GET", "Expired": 600},
    ]
    assert calls["config"] == {
        "Region": "ap-guangzhou", "SecretId": "secret-id", "SecretKey": "secret-key",
        "Scheme": "https", "Domain": "cdn.example",
    }
    assert calls["client_creations"] == 1


def test_invalid_object_keys_are_not_signed():
    settings = Settings(_env_file=None)

    assert resolve_object_url("../private.wav", settings) is None
    assert resolve_object_url("", settings) is None
