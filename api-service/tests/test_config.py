import pytest
from pydantic import ValidationError

from app.config import Settings


def test_phone_check_is_native_by_default_and_reported_as_migrated():
    settings = Settings(_env_file=None)

    assert "auth.check-phone" in settings.public_summary()["migrated_groups"]


def test_project_audio_route_is_native_and_storage_signing_expiry_is_positive():
    settings = Settings(_env_file=None)

    assert "project-audio.read" in settings.public_summary()["migrated_groups"]
    assert settings.object_storage_provider == "local"
    assert settings.object_storage_signed_url_ttl_seconds == 900

    with pytest.raises(ValidationError):
        Settings(_env_file=None, OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS=0)


def test_mysql_timeouts_default_to_finite_limits():
    settings = Settings(_env_file=None)

    assert (
        settings.mysql_connect_timeout,
        settings.mysql_read_timeout,
        settings.mysql_write_timeout,
    ) == (5, 15, 15)


def test_mysql_timeouts_have_bounded_defaults_and_environment_overrides(monkeypatch):
    monkeypatch.setenv("DB_CONNECT_TIMEOUT", "3")
    monkeypatch.setenv("DB_READ_TIMEOUT", "8")
    monkeypatch.setenv("DB_WRITE_TIMEOUT", "10")

    settings = Settings(_env_file=None)

    assert (
        settings.mysql_connect_timeout,
        settings.mysql_read_timeout,
        settings.mysql_write_timeout,
    ) == (3, 8, 10)


@pytest.mark.parametrize(
    "name",
    ["DB_CONNECT_TIMEOUT", "DB_READ_TIMEOUT", "DB_WRITE_TIMEOUT"],
)
def test_mysql_timeouts_reject_zero(name, monkeypatch):
    monkeypatch.setenv(name, "0")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)
