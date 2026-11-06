from __future__ import annotations

import hashlib
import hmac
import time
from urllib.parse import quote, unquote, urlsplit, urlunsplit

from .config import Settings


def _normalize_key(value: str) -> str | None:
    key = str(value or "").strip()
    for _ in range(3):
        try:
            decoded = unquote(key, errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        if decoded == key:
            break
        key = decoded
    if (
        not key
        or key.startswith(("/", "\\"))
        or (len(key) >= 3 and key[1] == ":" and key[2] in "/\\")
        or "\\" in key
        or any(ord(char) < 32 or ord(char) == 127 for char in key)
        or any(segment in {"", ".", ".."} for segment in key.split("/"))
    ):
        return None
    return key


def _local_signed_url(key: str, settings: Settings, now: int | None = None) -> str | None:
    base = str(settings.object_storage_public_base_url or "").strip().rstrip("/")
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        return None
    expires = (int(now) if now is not None else time.time_ns() // 1_000_000_000) + settings.object_storage_signed_url_ttl_seconds
    signature = hmac.new(
        settings.object_storage_signing_secret.encode(),
        f"{key}\n{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()
    encoded_key = "/".join(quote(segment, safe="~!*'()-._") for segment in key.split("/"))
    path = f"{parts.path.rstrip('/')}/{encoded_key}"
    return urlunsplit((parts.scheme, parts.netloc, path, f"expires={expires}&signature={signature}", ""))


def create_object_url_resolver(settings: Settings):
    cos_client = None

    def resolve(storage_key: str | None, now: int | None = None) -> str | None:
        nonlocal cos_client
        key = _normalize_key(str(storage_key or ""))
        if key is None:
            return None
        provider = settings.object_storage_provider.strip().lower()
        if provider == "local":
            return _local_signed_url(key, settings, now)
        if provider != "cos" or not all((settings.cos_secret_id, settings.cos_secret_key, settings.cos_bucket, settings.cos_region)):
            return None
        try:
            if cos_client is None:
                from qcloud_cos import CosConfig, CosS3Client

                options = {
                    "Region": settings.cos_region,
                    "SecretId": settings.cos_secret_id,
                    "SecretKey": settings.cos_secret_key,
                    "Scheme": str(settings.cos_protocol or "https:").rstrip(":") or "https",
                }
                if settings.cos_domain:
                    options["Domain"] = settings.cos_domain
                cos_client = CosS3Client(CosConfig(**options))
            url = cos_client.get_presigned_url(
                Bucket=settings.cos_bucket,
                Key=key,
                Method="GET",
                Expired=settings.object_storage_signed_url_ttl_seconds,
            )
            return url if isinstance(url, str) and url.strip() else None
        except Exception:
            cos_client = None
            return None

    return resolve


def resolve_object_url(storage_key: str | None, settings: Settings, now: int | None = None) -> str | None:
    return create_object_url_resolver(settings)(storage_key, now)
