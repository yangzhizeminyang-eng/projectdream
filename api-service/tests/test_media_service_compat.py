"""媒体/存储组四路路由（/generated、/storage、/mock、/mock-assets）的兼容测试
（FastAPI-Only 迁移第三阶段第二组，阶段 3.2）。

对照规格：``api-service/docs/media-group-spec.md``；Node 权威源：
``server/index.mjs`` L11979-L12216（generated/mock/mock-assets）、L12926-L12946
（storage）、L10543-L10642（mock SVG/WAV 生成器）、L18352（未匹配兜底 4040）；
``server/services/object-storage.mjs``（inferContentType / verifySignedUrl 语义）。

覆盖场景：四路正常访问、路径穿越全套攻击用例（``..``、%2e%2e、双编码、绝对路径、
Windows 盘符、反斜杠、空 path、超长 path）、Range 单区间/开区间/后缀/end 超界/
非法头（206/416 与 Content-Range）、MIME 推断矩阵、/storage 签名越权（缺失/伪造/
过期/签名与键不绑定）、COS 代理（流式转发与对象缺失）、flag=false 过渡态 501。
全部离线（tmp_path 文件 fixture + monkeypatch COS 工厂，无网络、无数据库）。

有意收紧的差异（Node 裸读 → FastAPI 强制验签）在规格文档 §3 声明。
"""

from __future__ import annotations

import hashlib
import hmac
import io
import time
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
from fastapi.testclient import TestClient

import app.media_service as media_service
from app.config import Settings
from app.main import create_app
from app.media_urls import resolve_object_url

# 测试签名密钥（与 Settings 显式注入值一致，验签同源）。
SIGNING_SECRET = "media-test-signing-secret"
# mock WAV 的总字节数（Node buildMockAudioBuffer：44 头 + 22050*3 采样 * 2 字节）。
MOCK_WAV_SIZE = 44 + 22050 * 3 * 2
PNG_BYTES = b"\x89PNG\r\n\x1a\n-fake-png-payload"


class _NullDatabase:
    """媒体路由不触库；create_app 构造期需要的最小数据库占位。

    媒体四路均为无 DB 依赖的路由（签名无状态、文件直读），该桩仅满足
    create_app 的参数约定（AuthCaptchaService 构造只保存引用不做查询）。
    """


def make_settings(tmp_path: Path, **overrides) -> Settings:
    """构建指向 tmp_path 各媒体目录的测试配置。

    :param tmp_path: pytest 临时目录（充当 .codex-runtime 根）。
    :param overrides: 透传给 Settings 的额外/覆盖配置。
    :return: 配置实例（禁用 env 文件，全部显式注入）。
    """
    base = {
        "_env_file": None,
        "object_storage_provider": "local",
        "object_storage_public_base_url": "http://testserver/storage",
        "object_storage_signing_secret": SIGNING_SECRET,
        "object_storage_signed_url_ttl_seconds": 900,
        "object_storage_root": str(tmp_path / "object-storage"),
        "generated_frame_dir": str(tmp_path / "generated-frames"),
        "generated_audio_dir": str(tmp_path / "generated-audio"),
        "generated_video_dir": str(tmp_path / "generated-videos"),
        "generated_export_dir": str(tmp_path / "exports"),
        "mock_asset_image_path": str(tmp_path / "login-hero-clean.png"),
    }
    base.update(overrides)
    return Settings(**base)


def make_client(settings: Settings) -> TestClient:
    """构建媒体组测试客户端（不注入任何外部依赖，全程离线）。

    :param settings: make_settings 产出的配置。
    :return: TestClient（服务器异常不静默，便于暴露缺陷）。
    """
    return TestClient(
        create_app(settings, database=_NullDatabase()),
        raise_server_exceptions=False,
    )


def signed_url(settings: Settings, key: str, now: int | None = None) -> str:
    """生成带签名 /storage URL（验签与产签共用一套配置）。

    仅限 local 模式使用（media_urls 在 cos 模式返回 COS 直连预签名 URL）；
    COS 模式测试请用 :func:`local_signed_path` 手工构造。

    :param settings: 测试配置。
    :param key: 对象键（内部按 Node 语义归一化后签名）。
    :param now: 显式签发时刻（秒）；缺省取当前时间。
    :return: 形如 ``http://testserver/storage/<key>?expires=&signature=`` 的 URL。
    """
    url = resolve_object_url(key, settings, now=now)
    assert url is not None
    return url


def local_signed_path(key: str, expires: int, signature: str) -> str:
    """按本服务验签形状手工拼接 /storage 路径（COS 模式测试使用）。

    :param key: 对象键（测试用简单键，无需编码）。
    :param expires: 过期时刻（秒）。
    :param signature: HMAC 签名（:func:`signature_for` 产出）。
    :return: ``/storage/<key>?expires=&signature=`` 路径。
    """
    return f"/storage/{key}?expires={expires}&signature={signature}"


def signature_for(settings: Settings, key: str, expires: int) -> str:
    """手工计算 HMAC-SHA256 签名（算法与 Node signatureFor / media_urls 一致）。

    :param settings: 测试配置（读取签名密钥）。
    :param key: 对象键。
    :param expires: 过期时刻（秒）。
    :return: 64 位十六进制签名。
    """
    return hmac.new(
        settings.object_storage_signing_secret.encode(),
        f"{key}\n{expires}".encode(),
        hashlib.sha256,
    ).hexdigest()


def assert_envelope(response, status: int, code: int) -> dict:
    """断言响应为 Node 风格 envelope 并返回其 JSON。

    :param response: TestClient 响应。
    :param status: 期望 HTTP 状态码。
    :param code: 期望业务码（4040/4010/5001）。
    :return: 解析后的 envelope dict。
    """
    assert response.status_code == status, response.text
    body = response.json()
    assert body["code"] == code, response.text
    assert set(body) == {"code", "message", "data"}
    return body


# ---------------------------------------------------------------------------
# 一、/generated 四类生成媒体：MIME 推断与缓存头
# ---------------------------------------------------------------------------


def test_generated_frame_serves_png_with_immutable_cache_and_no_accept_ranges(tmp_path):
    """frame：PNG 按 .png 推断 MIME；Node frame 路由不支持 Range → 无 Accept-Ranges 头。"""
    frames = tmp_path / "generated-frames"
    frames.mkdir(parents=True)
    (frames / "frame-1-v1-c1.png").write_bytes(PNG_BYTES)
    client = make_client(make_settings(tmp_path))

    response = client.get("/generated/frame/frame-1-v1-c1.png")

    assert response.status_code == 200
    assert response.content == PNG_BYTES
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["access-control-allow-origin"] == "*"
    assert "accept-ranges" not in response.headers


@pytest.mark.parametrize(
    ("filename", "expected_type"),
    [
        ("a.png", "image/png"),
        ("a.webp", "image/webp"),
        ("a.jpg", "image/jpeg"),
        ("a.gif", "image/jpeg"),  # Node frame MIME 默认回落 image/jpeg
        ("a.unknown", "image/jpeg"),
    ],
)
def test_generated_frame_mime_matrix(tmp_path, filename, expected_type):
    """frame MIME 矩阵：png/webp 显式，其余一律 image/jpeg（Node L12018-L12023）。"""
    frames = tmp_path / "generated-frames"
    frames.mkdir(parents=True)
    (frames / filename).write_bytes(b"payload")
    client = make_client(make_settings(tmp_path))

    response = client.get(f"/generated/frame/{filename}")

    assert response.status_code == 200
    assert response.headers["content-type"] == expected_type


@pytest.mark.parametrize(
    ("filename", "expected_type"),
    [
        ("a.mp3", "audio/mpeg"),
        ("a.ogg", "audio/ogg"),
        ("a.m4a", "audio/mp4"),
        ("a.wav", "audio/wav"),
        ("a.flac", "audio/wav"),  # Node audio MIME 默认回落 audio/wav
    ],
)
def test_generated_audio_mime_matrix_with_accept_ranges(tmp_path, filename, expected_type):
    """audio MIME 矩阵 + 200 响应带 Accept-Ranges: bytes（Node L12044-L12051）。"""
    audio = tmp_path / "generated-audio"
    audio.mkdir(parents=True)
    (audio / filename).write_bytes(b"audio-bytes")
    client = make_client(make_settings(tmp_path))

    response = client.get(f"/generated/audio/{filename}")

    assert response.status_code == 200
    assert response.headers["content-type"] == expected_type
    assert response.headers["accept-ranges"] == "bytes"


def test_generated_video_serves_mp4_with_length(tmp_path):
    """video：恒 video/mp4，200 全量携带 Content-Length（流式读取不进内存）。"""
    videos = tmp_path / "generated-videos"
    videos.mkdir(parents=True)
    payload = bytes(range(256)) * 8
    (videos / "v1.mp4").write_bytes(payload)
    client = make_client(make_settings(tmp_path))

    response = client.get("/generated/video/v1.mp4")

    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == "video/mp4"
    assert response.headers["content-length"] == str(len(payload))
    assert response.headers["accept-ranges"] == "bytes"


def test_generated_export_default_name_srt_and_nested(tmp_path):
    """export：无文件名回落 export-{id}.mp4；.srt 用 x-subrip + Accept-Ranges: none。"""
    exports = tmp_path / "exports"
    (exports / "12").mkdir(parents=True)
    (exports / "export-12.mp4").write_bytes(b"mp4-bytes")
    (exports / "12" / "sub.srt").write_bytes(b"1\n00:00:01,000 --> 00:00:02,000\nhi\n")
    (exports / "12" / "movie.mp4").write_bytes(b"nested-mp4")
    client = make_client(make_settings(tmp_path))

    default_hit = client.get("/generated/export/12")
    srt_hit = client.get("/generated/export/12/sub.srt")
    nested_hit = client.get("/generated/export/12/movie.mp4")

    assert default_hit.status_code == 200
    assert default_hit.headers["content-type"] == "video/mp4"
    assert default_hit.headers["accept-ranges"] == "bytes"
    assert srt_hit.status_code == 200
    assert srt_hit.headers["content-type"] == "application/x-subrip; charset=utf-8"
    assert srt_hit.headers["accept-ranges"] == "none"
    assert nested_hit.status_code == 200
    assert nested_hit.content == b"nested-mp4"


def test_generated_missing_files_return_route_specific_envelopes(tmp_path):
    """未命中文件 → 路由专属 4040 文案（generated frame/audio/video/export not found）。"""
    for directory in ("generated-frames", "generated-audio", "generated-videos", "exports"):
        (tmp_path / directory).mkdir(parents=True)
    client = make_client(make_settings(tmp_path))

    assert assert_envelope(client.get("/generated/frame/gone.png"), 404, 4040)["message"] == "generated frame not found"
    assert assert_envelope(client.get("/generated/audio/gone.mp3"), 404, 4040)["message"] == "generated audio not found"
    assert assert_envelope(client.get("/generated/video/gone.mp4"), 404, 4040)["message"] == "generated video not found"
    assert assert_envelope(client.get("/generated/export/99"), 404, 4040)["message"] == "generated export not found"


def test_generated_unknown_prefix_falls_back_to_generic_4040(tmp_path):
    """未匹配子前缀（other/）与空路径 → Node 最终兜底 4040『接口不存在』。"""
    client = make_client(make_settings(tmp_path))

    body = assert_envelope(client.get("/generated/other/x.png"), 404, 4040)
    assert body["message"] == "接口不存在"
    assert_envelope(client.get("/generated/"), 404, 4040)


# ---------------------------------------------------------------------------
# 二、/mock 与 /mock-assets：代码生成内容
# ---------------------------------------------------------------------------


def test_mock_image_svg_matches_node_template(tmp_path):
    """mock image：SVG 内容、MIME 与 no-store 头（复刻 buildMockImageSvg）。"""
    client = make_client(make_settings(tmp_path))

    response = client.get("/mock/image/7/2/3.svg")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/svg+xml; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    body = response.text
    assert body.startswith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")
    assert "SHOT 7" in body
    assert "Version 2 / Candidate 3" in body
    assert "width=\"1024\" height=\"576\"" in body


def test_mock_audio_v2_wav_is_deterministic(tmp_path):
    """mock audio（V2 六段结构）：audio/wav + no-store，长度与确定性（同 URL 同字节）。"""
    client = make_client(make_settings(tmp_path))

    first = client.get("/mock/audio/5/3/4/2/dialogue/1.wav")
    second = client.get("/mock/audio/5/3/4/2/dialogue/1.wav")

    assert first.status_code == 200
    assert first.headers["content-type"] == "audio/wav"
    assert first.headers["cache-control"] == "no-store"
    assert len(first.content) == MOCK_WAV_SIZE
    assert first.content[:4] == b"RIFF"
    assert first.content == second.content


def test_mock_audio_v1_uses_zero_seed_and_differs_from_v2(tmp_path):
    """mock audio（V1 四段结构）：seed=0；与带场景/角色种子的 V2 结果不同。"""
    client = make_client(make_settings(tmp_path))

    v1 = client.get("/mock/audio/5/1/dialogue/1.wav")
    v2 = client.get("/mock/audio/5/3/4/1/dialogue/1.wav")

    assert v1.status_code == 200
    assert v2.status_code == 200
    assert v1.content != v2.content


def test_mock_audio_unknown_track_type_still_serves_wav(tmp_path):
    """未知音轨类型（如 '-'）→ Node trackBase 回落 260，仍输出 audio/wav。"""
    client = make_client(make_settings(tmp_path))

    response = client.get("/mock/audio/1/0/0/1/-/2.wav")

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert len(response.content) == MOCK_WAV_SIZE


def test_mock_asset_image_served_with_marker_header(tmp_path):
    """mock-assets：命中仓库静态占位图 → image/png + X-ProjectDream-Mock-Asset。"""
    (tmp_path / "login-hero-clean.png").write_bytes(PNG_BYTES)
    client = make_client(make_settings(tmp_path))

    response = client.get("/mock-assets/project-1/node-2/v3-4.png")

    assert response.status_code == 200
    assert response.content == PNG_BYTES
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-projectdream-mock-asset"] == "true"
    assert response.headers["cache-control"] == "public, max-age=3600"


def test_mock_asset_missing_image_returns_4040(tmp_path):
    """占位图缺失（api 容器未挂载场景）→ Node 同款 4040 文案。"""
    settings = make_settings(tmp_path)  # mock_asset_image_path 指向不存在的文件
    client = make_client(settings)

    body = assert_envelope(client.get("/mock-assets/project-1/node-1/v1-1.png"), 404, 4040)
    assert body["message"] == "mock asset image not found"


def test_mock_asset_invalid_shape_falls_back_to_generic_4040(tmp_path):
    """不符合 project/node/version 结构的路径 → 兜底『接口不存在』。"""
    (tmp_path / "login-hero-clean.png").write_bytes(PNG_BYTES)
    client = make_client(make_settings(tmp_path))

    assert_envelope(client.get("/mock-assets/other.png"), 404, 4040)


# ---------------------------------------------------------------------------
# 三、路径穿越防护（generated / storage 全套攻击用例）
# ---------------------------------------------------------------------------

# 攻击用例（generated：任何变体都必须拒绝，且不能读到根外机密文件）。
# 说明：httpx 客户端会按 RFC 3986 归一化字面 ``..`` 点段（真实流量经 Nginx 转发
# 原样到达 uvicorn），故字面点段一律以 %2e%2e 编码形态发送，服务端解码后与
# 字面点段走同一条守卫分支。
GENERATED_TRAVERSAL_CASES = [
    "/generated/frame/%2e%2e/secret.txt",
    "/generated/frame/..%2Fsecret.txt",
    "/generated/frame/sub/%2e%2e/%2e%2e/secret.txt",
    "/generated/frame/....//secret.txt",
    "/generated/frame/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/generated/audio/%2e%2e/%2e%2e/secret.txt",
    "/generated/video/..%2f..%2fsecret.txt",
    "/generated/export/1/%2e%2e/%2e%2e/secret.txt",
    "/generated/export/1/..%2fsecret.txt",
]

# 攻击用例（storage：拒绝后业务码可能为 4040『stored object not found』或
# 4010（形状合法但未签名），两者均为拒绝）。
STORAGE_TRAVERSAL_CASES = [
    "/storage/%2e%2e/secret.txt",
    "/storage/a/%2e%2e/%2e%2e/secret.txt",
    "/storage/..%2f..%2fsecret.txt",
    "/storage/%252e%252e/secret.txt",
    "/storage/%2Fabs%2Fpath",
    "/storage//etc/passwd",
    "/storage/C%3A%5Cwindows%2Csystem32",
    "/storage/C:/windows/system32",
    "/storage/back\\slash.png",
    "/storage/..%5C..%5Cwindows%5Cwin.ini",
    "/storage/dir/",
    "/storage/" + "a" * 5000,
]


@pytest.mark.parametrize("target", GENERATED_TRAVERSAL_CASES)
def test_generated_traversal_attacks_are_rejected(tmp_path, target):
    """generated 穿越全套：统一 404/4040，且根外机密文件永不出现在响应中。"""
    (tmp_path / "generated-frames").mkdir(parents=True)
    (tmp_path / "secret.txt").write_bytes(b"TOP-SECRET")
    client = make_client(make_settings(tmp_path))

    response = client.get(target)

    assert_envelope(response, 404, 4040)
    assert b"TOP-SECRET" not in response.content


@pytest.mark.parametrize("target", STORAGE_TRAVERSAL_CASES)
def test_storage_traversal_attacks_are_rejected(tmp_path, target):
    """storage 穿越全套（``..``、%2e%2e、双编码、绝对路径、盘符、反斜杠、空段、超长）→ 4xx 拒绝。"""
    root = tmp_path / "object-storage"
    (root / "projects").mkdir(parents=True)
    (tmp_path / "secret.txt").write_bytes(b"TOP-SECRET")
    client = make_client(make_settings(tmp_path))

    response = client.get(target)

    assert response.status_code in {400, 401, 404}
    assert response.json()["code"] in {4040, 4010}
    assert b"TOP-SECRET" not in response.content


def test_storage_signed_traversal_key_is_rejected(tmp_path):
    """即使带合法签名，键内含 ``..``/反斜杠的键也会在归一化阶段拒绝（4040）。

    文案按键形状分流（点段 → 『接口不存在』，反斜杠 → 『stored object not found』），
    与 Node URL 归一化/键校验的分流一致；此处只断言拒绝结果。键以 quote 编码发送
    （httpx 客户端会归一化字面点段），服务端解码后与字面键同一条校验路径。
    """
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)
    settings = make_settings(tmp_path)
    client = make_client(settings)
    expires = int(time.time()) + 600

    for bad_key in ("../secret.txt", "a/../b.png", "x\\y.png"):
        url = (
            f"/storage/{quote(bad_key, safe='')}"
            f"?expires={expires}&signature={signature_for(settings, bad_key, expires)}"
        )
        assert_envelope(client.get(url), 404, 4040)


# ---------------------------------------------------------------------------
# 四、Range 语义（复刻 Node 单区间 bytes=start-end / start- / -suffix）
# ---------------------------------------------------------------------------


@pytest.fixture()
def range_video_client(tmp_path):
    """预置 1000 字节视频的客户端（Range 用例共用）。

    :param tmp_path: pytest 临时目录。
    :return: (TestClient, 1000 字节负载)。
    """
    videos = tmp_path / "generated-videos"
    videos.mkdir(parents=True)
    payload = bytes((i % 251 for i in range(1000)))
    (videos / "v1.mp4").write_bytes(payload)
    return make_client(make_settings(tmp_path)), payload


def test_video_range_single_closed_interval(range_video_client):
    """bytes=100-199 → 206 + Content-Range bytes 100-199/1000 + 精确切片。"""
    client, payload = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=100-199"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 100-199/1000"
    assert response.headers["content-length"] == "100"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.content == payload[100:200]


def test_video_range_open_ended_and_suffix(range_video_client):
    """开区间 bytes=900- 与后缀 bytes=-100 均落在最后 100 字节。"""
    client, payload = range_video_client

    open_ended = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=900-"})
    suffix = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=-100"})

    for response in (open_ended, suffix):
        assert response.status_code == 206
        assert response.headers["content-range"] == "bytes 900-999/1000"
        assert response.content == payload[900:1000]


def test_video_range_end_beyond_size_is_clamped(range_video_client):
    """end 超界 → 钳制到 size-1（206 bytes 0-999/1000）。"""
    client, payload = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=0-5000"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-999/1000"
    assert response.content == payload


def test_video_range_start_beyond_size_returns_416(range_video_client):
    """start 超界 → 416 + ``Content-Range: bytes */1000`` + 空体。"""
    client, _ = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=1000-"})

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */1000"
    assert response.content == b""


def test_video_range_end_lt_start_returns_416(range_video_client):
    """bytes=5-2（end < start）→ 416。"""
    client, _ = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=5-2"})

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */1000"


@pytest.mark.parametrize("header", ["bytes=abc", "bytes=0-1,3-4", "items=0-5", "bytes = 0-5"])
def test_video_range_malformed_headers_serve_full_body(range_video_client, header):
    """非单区间格式（Node 正则不命中）→ 忽略 Range，200 全量。"""
    client, payload = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": header})

    assert response.status_code == 200
    assert response.content == payload


def test_video_range_suffix_zero_keeps_node_quirk(range_video_client):
    """Node 怪癖复刻：bytes=-0 → suffix=0 走普通分支 → 206 bytes 0-0/1000。"""
    client, payload = range_video_client

    response = client.get("/generated/video/v1.mp4", headers={"Range": "bytes=-0"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-0/1000"
    assert response.content == payload[0:1]


def test_audio_range_supported(tmp_path):
    """audio 路由同样支持单区间 Range（Node L12055-L12082）。"""
    audio = tmp_path / "generated-audio"
    audio.mkdir(parents=True)
    payload = bytes((i % 251 for i in range(500)))
    (audio / "a.wav").write_bytes(payload)
    client = make_client(make_settings(tmp_path))

    response = client.get("/generated/audio/a.wav", headers={"Range": "bytes=10-19"})

    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 10-19/500"
    assert response.content == payload[10:20]


def test_srt_and_frame_and_storage_ignore_range(tmp_path):
    """.srt（Node 显式跳过）、frame 与 /storage（Node 不支持）→ Range 被忽略返回 200 全量。"""
    (tmp_path / "exports" / "5").mkdir(parents=True)
    (tmp_path / "exports" / "5" / "s.srt").write_bytes(b"srt-body")
    (tmp_path / "generated-frames").mkdir(parents=True)
    (tmp_path / "generated-frames" / "f.png").write_bytes(b"frame-body")
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)
    (root / "obj.bin").write_bytes(b"storage-body")
    settings = make_settings(tmp_path)
    client = make_client(settings)

    srt = client.get("/generated/export/5/s.srt", headers={"Range": "bytes=0-2"})
    frame = client.get("/generated/frame/f.png", headers={"Range": "bytes=0-2"})
    storage = client.get(signed_url(settings, "obj.bin"), headers={"Range": "bytes=0-2"})

    assert srt.status_code == 200 and srt.content == b"srt-body"
    assert frame.status_code == 200 and frame.content == b"frame-body"
    assert storage.status_code == 200 and storage.content == b"storage-body"


def test_empty_file_without_range_returns_200_and_with_range_returns_416(tmp_path):
    """空文件：无 Range → 200 + Content-Length: 0；带 Range → 416 bytes */0（Node 一致）。"""
    videos = tmp_path / "generated-videos"
    videos.mkdir(parents=True)
    (videos / "empty.mp4").write_bytes(b"")
    client = make_client(make_settings(tmp_path))

    full = client.get("/generated/video/empty.mp4")
    ranged = client.get("/generated/video/empty.mp4", headers={"Range": "bytes=0-"})

    assert full.status_code == 200
    assert full.headers["content-length"] == "0"
    assert ranged.status_code == 416
    assert ranged.headers["content-range"] == "bytes */0"


# ---------------------------------------------------------------------------
# 五、/storage 本地模式：签名校验与 Content-Type
# ---------------------------------------------------------------------------


def test_storage_signed_object_served_with_meta_content_type(tmp_path):
    """合法签名 + .meta.json sidecar → 按 sidecar contentType 返回（Node readMetadata 同款）。"""
    root = tmp_path / "object-storage"
    (root / "projects" / "8").mkdir(parents=True)
    (root / "projects" / "8" / "audio.bin").write_bytes(b"storage-payload")
    (root / "projects" / "8" / "audio.bin.meta.json").write_text(
        '{"key":"projects/8/audio.bin","contentType":"audio/mp4"}', encoding="utf-8"
    )
    settings = make_settings(tmp_path)
    client = make_client(settings)

    response = client.get(signed_url(settings, "projects/8/audio.bin"))

    assert response.status_code == 200
    assert response.content == b"storage-payload"
    assert response.headers["content-type"] == "audio/mp4"
    assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert response.headers["access-control-allow-origin"] == "*"


def test_storage_inferred_content_type_matrix(tmp_path):
    """无 sidecar 时按扩展名推断（对齐 Node inferContentType），未知名回落 octet-stream。"""
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)
    for name in ("clip.webm", "shot.png", "blob.unknownbin"):
        (root / name).write_bytes(b"data")
    settings = make_settings(tmp_path)
    client = make_client(settings)

    assert client.get(signed_url(settings, "clip.webm")).headers["content-type"] == "video/webm"
    assert client.get(signed_url(settings, "shot.png")).headers["content-type"] == "image/png"
    assert client.get(signed_url(settings, "blob.unknownbin")).headers["content-type"] == "application/octet-stream"


def test_storage_with_space_in_key_matches_media_urls_contract(tmp_path):
    """media_urls 签出的含空格键（%20 编码）能被原生路由验签命中（产出与消费一致）。"""
    root = tmp_path / "object-storage"
    (root / "projects" / "8").mkdir(parents=True)
    (root / "projects" / "8" / "audio track.wav").write_bytes(b"space-key")
    settings = make_settings(tmp_path)
    client = make_client(settings)
    url = signed_url(settings, "projects/8/audio track.wav")
    assert "/storage/projects/8/audio%20track.wav" in url

    response = client.get(url)

    assert response.status_code == 200
    assert response.content == b"space-key"
    assert response.headers["content-type"] == "audio/wav"


def test_storage_missing_object_returns_4040(tmp_path):
    """签名合法但对象不存在 → 4040『stored object not found』。"""
    (tmp_path / "object-storage").mkdir(parents=True)
    settings = make_settings(tmp_path)
    client = make_client(settings)

    body = assert_envelope(client.get(signed_url(settings, "ghost.bin")), 404, 4040)
    assert body["message"] == "stored object not found"


def test_storage_without_signature_is_rejected(tmp_path):
    """有意收紧：缺失签名（Node 时代裸 URL）→ 401/4010，不泄露对象是否存在。"""
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)
    (root / "ghost.bin").write_bytes(b"payload")
    client = make_client(make_settings(tmp_path))

    body = assert_envelope(client.get("/storage/ghost.bin"), 401, 4010)
    assert "签名" in body["message"]


@pytest.mark.parametrize(
    ("mutate", "desc"),
    [
        ("drop_expires", "只带 signature 缺 expires"),
        ("drop_signature", "只带 expires 缺 signature"),
        ("tamper_signature", "签名被篡改一位"),
        ("wrong_key_signature", "签名与请求键不绑定"),
        ("expired", "签名已过期"),
        ("bad_expires", "expires 非整数"),
        ("bad_signature_shape", "signature 非 64 位十六进制"),
    ],
)
def test_storage_forged_signature_variants_rejected(tmp_path, mutate, desc):
    """伪造签名全家桶：一律 401/4010（无状态验签，不下查 DB、不泄露存在性）。"""
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)
    (root / "real.bin").write_bytes(b"payload")
    settings = make_settings(tmp_path)
    client = make_client(settings)
    expires = int(time.time()) + 600

    if mutate == "drop_expires":
        url = f"/storage/real.bin?signature={signature_for(settings, 'real.bin', expires)}"
    elif mutate == "drop_signature":
        url = f"/storage/real.bin?expires={expires}"
    elif mutate == "tamper_signature":
        good = signature_for(settings, "real.bin", expires)
        bad = ("0" if good[0] != "0" else "1") + good[1:]
        url = f"/storage/real.bin?expires={expires}&signature={bad}"
    elif mutate == "wrong_key_signature":
        url = f"/storage/real.bin?expires={expires}&signature={signature_for(settings, 'other.bin', expires)}"
    elif mutate == "expired":
        url = f"/storage/real.bin?expires={expires - 100000}&signature={signature_for(settings, 'real.bin', expires - 100000)}"
    elif mutate == "bad_expires":
        url = f"/storage/real.bin?expires=abc&signature={signature_for(settings, 'real.bin', expires)}"
    else:
        url = f"/storage/real.bin?expires={expires}&signature={'z' * 64}"

    assert_envelope(client.get(url), 401, 4010)


# ---------------------------------------------------------------------------
# 六、COS 代理模式：流式转发（不落盘）与对象缺失
# ---------------------------------------------------------------------------


class _FakeCosBody:
    """可重复读取的伪 COS 对象体（提供 get_raw_stream，贴近 qcloud StreamBody 接口）。

    :ivar _payload: 完整字节。
    """

    def __init__(self, payload: bytes):
        self._payload = payload

    def get_raw_stream(self):
        """返回以 4 字节分片读取的伪流（验证流式转发路径）。

        :return: 支持 read(n) 的文件型对象。
        """
        return io.BytesIO(self._payload)


def test_cos_proxy_streams_object_without_local_file(tmp_path, monkeypatch):
    """COS 模式：流式代理返回 COS 字节与 COS Content-Type；不读本地根目录。"""
    root = tmp_path / "object-storage"
    root.mkdir(parents=True)  # 本地根为空 → 命中只能来自 COS 代理
    settings = make_settings(
        tmp_path,
        object_storage_provider="cos",
        cos_secret_id="id",
        cos_secret_key="key",
        cos_bucket="bucket-123",
        cos_region="ap-guangzhou",
    )
    calls: list[dict] = []

    def fake_client(settings_inner):
        """记录 Bucket/Key 并返回伪 COS 客户端。

        :param settings_inner: 传入工厂的配置。
        :return: 带 get_object 的伪客户端。
        """

        class _FakeClient:
            def get_object(self, **kwargs):
                calls.append(kwargs)
                return {
                    "Body": _FakeCosBody(b"cos-stream-bytes"),
                    "Content-Type": "video/mp4",
                    "Content-Length": "16",
                }

        return _FakeClient()

    monkeypatch.setattr(media_service, "cos_client_factory", fake_client)
    client = make_client(settings)
    expires = int(time.time()) + 600
    url = local_signed_path("videos/a.mp4", expires, signature_for(settings, "videos/a.mp4", expires))

    response = client.get(url)

    assert response.status_code == 200
    assert response.content == b"cos-stream-bytes"
    assert response.headers["content-type"] == "video/mp4"
    assert calls == [{"Bucket": "bucket-123", "Key": "videos/a.mp4"}]


def test_cos_missing_object_returns_4040(tmp_path, monkeypatch):
    """COS 对象缺失（SDK 抛 NoSuchKey 形异常）→ Node catch-all 同款 4040 文案。"""
    (tmp_path / "object-storage").mkdir(parents=True)
    settings = make_settings(
        tmp_path,
        object_storage_provider="cos",
        cos_secret_id="id",
        cos_secret_key="key",
        cos_bucket="bucket-123",
        cos_region="ap-guangzhou",
    )

    def fake_client(_settings):
        """返回恒抛 404 型异常的伪客户端。

        :param _settings: 未使用。
        :return: 伪客户端。
        """

        class _MissingClient:
            def get_object(self, **_kwargs):
                error = OSError("nosuchkey")
                error.statusCode = 404
                raise error

        return _MissingClient()

    monkeypatch.setattr(media_service, "cos_client_factory", fake_client)
    client = make_client(settings)
    expires = int(time.time()) + 600
    url = local_signed_path("ghost.mp4", expires, signature_for(settings, "ghost.mp4", expires))

    body = assert_envelope(client.get(url), 404, 4040)
    assert body["message"] == "stored object not found"


def test_cos_mode_still_requires_signature(tmp_path):
    """COS 模式同样强制验签（与本地模式一致的收紧策略）。"""
    (tmp_path / "object-storage").mkdir(parents=True)
    settings = make_settings(
        tmp_path,
        object_storage_provider="cos",
        cos_secret_id="id",
        cos_secret_key="key",
        cos_bucket="bucket-123",
        cos_region="ap-guangzhou",
    )
    client = make_client(settings)

    assert_envelope(client.get("/storage/videos/a.mp4"), 401, 4010)


# ---------------------------------------------------------------------------
# 七、方法/兜底语义（第四阶段已删除过渡 flag，媒体四路恒为原生实现）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    ["/storage", "/generated", "/mock", "/mock-assets", "/storage/"],
)
def test_bare_prefixes_fall_back_to_generic_4040(tmp_path, path):
    """裸前缀与空 path → Node 兜底 4040『接口不存在』。"""
    client = make_client(make_settings(tmp_path))

    body = assert_envelope(client.get(path), 404, 4040)
    assert body["message"] == "接口不存在"


def test_head_and_post_on_media_routes_fall_back_to_4040(tmp_path):
    """Node 仅处理 GET：HEAD/POST 命中媒体路径也返回 4040『接口不存在』（而非 405）。

    HEAD 响应体被 HTTP 语义丢弃，仅断言状态码；POST/PUT/DELETE 额外断言 envelope。
    """
    (tmp_path / "generated-frames").mkdir(parents=True)
    (tmp_path / "generated-frames" / "f.png").write_bytes(PNG_BYTES)
    client = make_client(make_settings(tmp_path))

    assert client.head("/generated/frame/f.png").status_code == 404
    for method in ("post", "put", "delete"):
        response = client.request(method, "/generated/frame/f.png")
        assert_envelope(response, 404, 4040)


def test_media_routes_are_outside_api_proxy_scope(tmp_path):
    """/api 兜底不吞媒体路径：/api/xxx 未命中显式路由 → 收口 4040，媒体路径由原生路由处理。

    阶段 3.2.5 兜底收口：/api/{path:path} 兜底代理退役为显式 4040 envelope
    （对齐 Node 未匹配路径 L18352），不再透传 Node（决策 9）。
    """
    settings = make_settings(tmp_path)
    client = TestClient(create_app(settings, database=_NullDatabase()), raise_server_exceptions=False)

    proxy_miss = client.get("/api/definitely-not-a-route")
    assert proxy_miss.status_code == 404  # 兜底收口：404/4040 envelope，不再透传
    assert proxy_miss.json()["code"] == 4040
    assert "x-forwarded-by" not in proxy_miss.headers  # 无代理透传标记
    media_miss = client.get("/generated/other/x.png")
    assert media_miss.status_code == 404  # 媒体兜底 envelope，未进入兜底
    assert media_miss.json()["code"] == 4040
