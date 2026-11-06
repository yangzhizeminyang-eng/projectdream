"""FastAPI 原生媒体服务（FastAPI-Only 迁移第三阶段第二组：媒体/存储组）。

承接 Nginx 四路媒体 location（``/generated/``、``/storage/``、``/mock/``、
``/mock-assets/``），逐条对照 Node 实现（``server/index.mjs`` L11979-L12216 与
L12926-L12946）：

- ``/generated/{frame|audio|video|export}``：读本地 ``.codex-runtime`` 生成目录；
  frame 不支持 Range（Node 一致），audio/video/export（非 srt）支持单区间 Range；
- ``/storage/{key}``：本地对象存储（``OBJECT_STORAGE_ROOT``）或 COS 流式代理；
  **与 Node 的差异（有意收紧）**：Node 裸读任意 key（``server/index.mjs`` L12926
  未调用 ``verifySignedUrl``），本服务强制校验 ``?expires=&signature=`` 签名
  （HMAC-SHA256 ``f"{key}\\n{expires}"``，与 ``media_urls._local_signed_url`` 及
  Node ``services/object-storage.mjs signatureFor`` 完全同构），缺失/伪造/过期
  一律 401/4010 envelope；
- ``/mock/{image|audio}``：代码内生成的占位 SVG 与 WAV（复刻 ``buildMockImageSvg``
  与 ``buildMockAudioBuffer``）；
- ``/mock-assets/project-{p}/node-{n}/v{x}-{y}.png``：读取仓库静态占位图
  （Node ``PUBLIC_MOCK_ASSET_IMAGE_PATH`` = ``public/images/login-hero-clean.png``）。

路径安全：所有本地读取统一「decode（至多 3 轮）→ 键校验（复刻 Node
``normalizeObjectKey``）→ resolve 后前缀校验」，拒绝 ``..``、绝对路径、Windows
盘符、反斜杠与 URL 编码变体；点段（``.``/``..``）在分发前即按 Node WHATWG URL
归一化的结果落到兜底 4040『接口不存在』。

第四阶段已删除媒体组过渡开关：四路媒体恒为原生实现。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import struct
import time
from pathlib import Path
from typing import Any, Callable, Iterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .config import Settings
from .envelope import failure
from .media_urls import _normalize_key

# Range 单区间解析：与 Node ``/^bytes=(\d*)-(\d*)$/`` 逐字对齐（多区间/非数字 → 不支持 → 200 全量）。
# re.ASCII：JS \d 仅匹配 ASCII 数字，Python \d 会吞全角数字，必须显式收窄。
_RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$", re.ASCII)
# 签名形状：64 位十六进制（Node verifySignedUrl 的 ``/^[a-f0-9]{64}$/``，比较前统一小写）。
_SIGNATURE_PATTERN = re.compile(r"^[a-f0-9]{64}$")
# mock 路由结构（对照 Node L11979 / L12145-L12148；V2 优先于 V1；re.ASCII 对齐 JS \d）。
_MOCK_IMAGE_PATTERN = re.compile(r"^image/(\d+)/(\d+)/(\d+)\.svg$", re.ASCII)
_MOCK_AUDIO_V2_PATTERN = re.compile(r"^audio/(\d+)/(\d+)/(\d+)/(\d+)/([a-z-]+)/(\d+)\.wav$", re.ASCII)
_MOCK_AUDIO_V1_PATTERN = re.compile(r"^audio/(\d+)/(\d+)/([a-z-]+)/(\d+)\.wav$", re.ASCII)
# mock-assets 结构（对照 Node L11993-L11994）。
_MOCK_ASSET_PATTERN = re.compile(r"^project-(\d+)/node-(\d+)/v(\d+)-(\d+)\.png$", re.ASCII)
# /generated 子路由结构（对照 Node L12013 / L12039 / L12098 / L12149）。
_GENERATED_FRAME_PATTERN = re.compile(r"^frame/([A-Za-z0-9._-]+)$")
_GENERATED_AUDIO_PATTERN = re.compile(r"^audio/([A-Za-z0-9._-]+)$")
_GENERATED_VIDEO_PATTERN = re.compile(r"^video/([A-Za-z0-9._-]+)$")
_GENERATED_EXPORT_PATTERN = re.compile(r"^export/(\d+)(?:/([A-Za-z0-9._-]+))?$", re.ASCII)
# /storage 本地对象的扩展名 → Content-Type 映射（逐项对齐 Node object-storage.mjs inferContentType）。
_OBJECT_CONTENT_TYPES: dict[str, str] = {
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".srt": "application/x-subrip",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
}
# 本地文件流式读取分片大小（64 KiB：大视频不进内存）。
_FILE_CHUNK_SIZE = 64 * 1024
# mock 音频的音色基频（对照 Node buildMockAudioBuffer trackBase，未知名回落 260）。
_MOCK_AUDIO_TRACK_BASE = {"dialogue": 220, "narration": 180, "music": 330, "sfx": 440}
# COS 客户端工厂类型：返回实现 get_object(Bucket=, Key=) 的客户端（测试可替换）。
CosClientFactory = Callable[[Settings], Any]

# 模块级 COS 客户端工厂（默认走 qcloud_cos 官方 SDK；测试通过 monkeypatch 替换）。
cos_client_factory: CosClientFactory


def _default_cos_client_factory(settings: Settings) -> Any:
    """构建腾讯云 COS 官方 SDK 客户端（延迟导入，与 media_urls.resolve 的构建参数一致）。

    :param settings: 服务配置（COS 凭据、桶、地域、域名与协议）。
    :return: 实现 ``get_object(Bucket=, Key=)`` 的 COS 客户端。
    :raises Exception: SDK 缺失或凭据缺失时原样抛出（由调用方按 Node catch-all 转 4040）。
    """
    from qcloud_cos import CosConfig, CosS3Client

    options: dict[str, Any] = {
        "Region": settings.cos_region,
        "SecretId": settings.cos_secret_id,
        "SecretKey": settings.cos_secret_key,
        "Scheme": str(settings.cos_protocol or "https:").rstrip(":") or "https",
    }
    if settings.cos_domain:
        options["Domain"] = settings.cos_domain
    return CosS3Client(CosConfig(**options))


cos_client_factory = _default_cos_client_factory


def _media_json(status_code: int, code: int, message: str) -> JSONResponse:
    """构造媒体路由的 Node 风格错误 envelope（json 助手带 CORS 头，index.mjs L6248）。

    :param status_code: HTTP 状态码。
    :param code: 业务错误码（4040/4010/5001 等）。
    :param message: 错误文案（与 Node 逐字对齐）。
    :return: 带 ``Access-Control-Allow-Origin`` 的 JSON envelope 响应。
    """
    return JSONResponse(
        status_code=status_code,
        content=failure(code, message),
        headers={"Access-Control-Allow-Origin": "*"},
    )


def _media_not_found() -> JSONResponse:
    """构造未匹配媒体路径/方法的兜底响应（对齐 Node L18352 ``4040『接口不存在』``）。

    :return: 404 + ``{code:4040, message:'接口不存在', data:null}`` envelope。
    """
    return _media_json(404, 4040, "接口不存在")


def _has_dot_segment(path_value: str) -> bool:
    """判断相对路径中存在空段或点段（``.``/``..``）。

    Node 侧 WHATWG URL 会在解析期归一化点段（含 %2e 变体），归一化结果要么改变路径
    要么落空；本函数将其统一拦截为『接口不存在』，与 Node 兜底形状对齐。

    :param path_value: 已解码的相对路径（如 ``frame/../x.png``）。
    :returns: 存在空段/点段时 True。
    """
    return any(segment in {"", ".", ".."} for segment in path_value.split("/"))


def _resolve_within(root: Path, relative_parts: list[str]) -> Path | None:
    """在根目录内解析相对路径并做前缀校验（统一 resolve 后比对，防符号链接与穿越）。

    :param root: 媒体根目录（配置注入，绝对或相对 cwd）。
    :param relative_parts: 相对根目录的路径分段（均已通过白名单校验）。
    :returns: 解析出的常规文件路径；越界、不存在或非文件时 None。
    """
    try:
        root_resolved = root.resolve()
        target = root_resolved.joinpath(*relative_parts).resolve()
        target.relative_to(root_resolved)
    except (OSError, ValueError):
        return None
    if not target.is_file():
        return None
    return target


def _parse_range(range_header: str, size: int) -> tuple[int, int] | None | str:
    """解析 Range 头，复刻 Node ``/^bytes=(\\d*)-(\\d*)$/`` 的单区间语义。

    :param range_header: 请求的 ``Range`` 头原值（可能为空串）。
    :param size: 资源总字节数。
    :returns: 命中区间返回 ``(start, end)``（end 已含）；头缺失/非单区间格式返回
        None（→ 200 全量）；区间非法返回字符串 ``"invalid"``（→ 416）。
    """
    match = _RANGE_PATTERN.fullmatch(range_header or "")
    if match is None:
        return None
    start_text, end_text = match.group(1), match.group(2)
    # Node：``!g1 && g2`` 视为后缀区间（bytes=-N）；注意 ``bytes=-0`` 的 g2 为 '0'
    # 但 suffixLength=0，会落入普通分支（Node 原样怪癖，逐字复刻）。
    suffix_length = int(end_text) if (not start_text and end_text) else 0
    if suffix_length > 0:
        start = max(0, size - suffix_length)
        end = size - 1
    else:
        start = int(start_text) if start_text else 0
        end = int(end_text) if end_text else size - 1
    if start < 0 or end < start or start >= size:
        return "invalid"
    return start, min(end, size - 1)


def _iter_file(file_path: Path, start: int, length: int) -> Iterator[bytes]:
    """以只读流的方式迭代文件字节切片（不整读进内存）。

    :param file_path: 已通过前缀校验的本地文件路径。
    :param start: 起始字节偏移。
    :param length: 需要读取的字节数（0 表示空）。
    :returns: 字节分片生成器（Starlette 以线程池迭代）。
    :raises OSError: 文件在流式读取过程中被删除/不可读时抛出（响应中断，与 Node 一致）。
    """
    remaining = length
    with open(file_path, "rb") as handle:
        if start:
            handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(_FILE_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def _file_media_response(
    file_path: Path,
    content_type: str,
    cache_control: str,
    range_header: str,
    range_enabled: bool,
    accept_ranges: str | None = "bytes",
    extra_headers: dict[str, str] | None = None,
) -> Response:
    """为本地文件构造 200/206/416 媒体响应（流式，不进内存）。

    :param file_path: 本地文件路径。
    :param content_type: Content-Type（已按路由规则推断）。
    :param cache_control: Cache-Control 头值（immutable/no-store 等）。
    :param range_header: 请求的 Range 头原值。
    :param range_enabled: 该路由是否支持 Range（frame/storage 与 Node 一致为 False）。
    :param accept_ranges: 200 响应的 Accept-Ranges 头（None 表示不发送，如 frame）。
    :param extra_headers: 附加头（如 mock-assets 的 X-ProjectDream-Mock-Asset）。
    :returns: 200（全量）/206（单区间）/416（区间非法）响应。
    :raises OSError: stat 失败时抛出（调用方统一转 4040 envelope）。
    """
    size = file_path.stat().st_size
    headers: dict[str, str] = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": cache_control,
    }
    if accept_ranges is not None:
        headers["Accept-Ranges"] = accept_ranges
    if extra_headers:
        headers.update(extra_headers)

    if range_enabled:
        parsed = _parse_range(range_header, size)
        if parsed == "invalid":
            return Response(
                status_code=416,
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Content-Range": f"bytes */{size}",
                },
                content=b"",
            )
        if parsed is not None:
            start, end = parsed
            headers.update(
                {
                    "Content-Length": str(end - start + 1),
                    "Content-Range": f"bytes {start}-{end}/{size}",
                }
            )
            return StreamingResponse(
                _iter_file(file_path, start, end - start + 1),
                status_code=206,
                media_type=content_type,
                headers=headers,
            )

    headers["Content-Length"] = str(size)
    return StreamingResponse(
        _iter_file(file_path, 0, size),
        status_code=200,
        media_type=content_type,
        headers=headers,
    )


def _infer_object_content_type(key: str) -> str:
    """按对象键扩展名推断 Content-Type（对齐 Node inferContentType，未知名回落 octet-stream）。

    :param key: 归一化后的对象键。
    :returns: MIME 字符串。
    """
    extension = Path(key).suffix.lower()
    return _OBJECT_CONTENT_TYPES.get(extension, "application/octet-stream")


def _read_meta_content_type(file_path: Path) -> str | None:
    """读取本地对象的 ``.meta.json`` sidecar 的 contentType（对齐 Node readMetadata）。

    :param file_path: 对象文件路径（sidecar 为 ``<path>.meta.json``）。
    :returns: 元数据中的 contentType；sidecar 缺失/损坏/字段为空时 None。
    """
    try:
        metadata = json.loads((file_path.with_name(file_path.name + ".meta.json")).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(metadata, dict):
        value = str(metadata.get("contentType") or "").strip()
        return value or None
    return None


def _build_mock_image_svg(storyboard_id: int, version_no: int, candidate_no: int) -> str:
    """生成 mock 分镜占位 SVG（逐字复刻 Node buildMockImageSvg，index.mjs L10543）。

    :param storyboard_id: 分镜 ID（标题中的 SHOT 编号）。
    :param version_no: 版本号。
    :param candidate_no: 候选编号。
    :returns: 完整 SVG 文本。
    """
    title = f"SHOT {storyboard_id}"
    subtitle = f"Version {version_no} / Candidate {candidate_no}"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#191813" />
      <stop offset="55%" stop-color="#2b241d" />
      <stop offset="100%" stop-color="#0f0f0d" />
    </linearGradient>
    <linearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#f59e0b" stop-opacity="0" />
    </linearGradient>
  </defs>
  <rect width="1024" height="576" fill="url(#bg)" />
  <rect x="28" y="28" width="968" height="520" rx="18" fill="none" stroke="#8d6f4a" stroke-width="2" />
  <rect x="28" y="28" width="968" height="140" fill="url(#shine)" />
  <circle cx="862" cy="146" r="120" fill="#f59e0b" fill-opacity="0.07" />
  <circle cx="194" cy="416" r="164" fill="#f59e0b" fill-opacity="0.05" />
  <text x="72" y="122" fill="#f7efe5" font-size="54" font-family="Georgia, serif" font-weight="700">{title}</text>
  <text x="74" y="176" fill="#f0b56f" font-size="24" font-family="Arial, sans-serif" letter-spacing="3">{subtitle}</text>
  <text x="74" y="458" fill="#cbb59b" font-size="18" font-family="Arial, sans-serif">Mock frame asset generated by local ProjectDream server</text>
  <text x="74" y="492" fill="#9a8876" font-size="16" font-family="Arial, sans-serif">This placeholder keeps the image module testable without any external image service.</text>
  <rect x="74" y="232" width="292" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.55" />
  <rect x="74" y="256" width="404" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.38" />
  <rect x="74" y="280" width="356" height="10" rx="5" fill="#8d6f4a" fill-opacity="0.3" />
</svg>"""


def _build_mock_audio_buffer(track_type: str, candidate_no: int, version_no: int, source_seed: int = 0) -> bytes:
    """生成 mock 音频 WAV 字节（逐字复刻 Node buildMockAudioBuffer，index.mjs L10601）。

    :param track_type: 音轨类型（dialogue/narration/music/sfx 之外的键回落基频 260）。
    :param candidate_no: 候选编号（参与频率偏移）。
    :param version_no: 版本号（参与频率偏移）。
    :param source_seed: 场景/角色派生种子（V2: sceneId*17+characterId*29；V1 恒 0）。
    :returns: 22050Hz/单声道/16bit/3 秒的完整 WAV 字节。
    """
    sample_rate = 22050
    duration_seconds = 3
    total_samples = sample_rate * duration_seconds
    bits_per_sample = 16
    num_channels = 1
    block_align = (num_channels * bits_per_sample) // 8
    byte_rate = sample_rate * block_align
    data_size = total_samples * block_align
    track_base = _MOCK_AUDIO_TRACK_BASE.get(track_type, 260)
    # Node：frequency = trackBase + candidateNo*28 + versionNo*6 + (sourceSeed % 41)。
    frequency = track_base + candidate_no * 28 + version_no * 6 + (source_seed % 41)
    pulse = {"music": 0.65, "sfx": 0.85}.get(track_type, 0.45)

    buffer = bytearray(44 + data_size)
    struct.pack_into("<4sI4s", buffer, 0, b"RIFF", 36 + data_size, b"WAVE")
    struct.pack_into("<4sI", buffer, 12, b"fmt ", 16)
    struct.pack_into("<HHIIHH", buffer, 20, 1, num_channels, sample_rate, byte_rate, block_align, bits_per_sample)
    struct.pack_into("<4sI", buffer, 36, b"data", data_size)
    two_pi = 2.0 * math.pi
    for index in range(total_samples):
        t = index / sample_rate
        # Node：envelope = Math.min(1, t*4, (duration - t)*4)。
        envelope = min(1.0, t * 4.0, (duration_seconds - t) * 4.0)
        value = math.sin(two_pi * frequency * t) * envelope * pulse
        # JS Math.round 语义 = floor(x + 0.5)（Python round 为银行家舍入，不可用）。
        sample = math.floor(value * 32767 + 0.5)
        struct.pack_into("<h", buffer, 44 + index * 2, sample)
    return bytes(buffer)


def register_media_routes(app: FastAPI, settings: Settings) -> None:
    """向应用注册四路媒体路由（GET 语义 + 其他方法的 4040 兜底，均与 Node 对齐）。

    Node 仅在 ``req.method === 'GET'`` 时处理媒体，其余方法（含 HEAD）落到最终兜底
    4040『接口不存在』；Starlette 会为 GET 路由自动附加 HEAD 匹配，因此「其他方法」
    的兜底路由必须先注册以抢占 HEAD。

    :param app: FastAPI 应用实例。
    :param settings: 服务配置（媒体目录、对象存储根、COS 凭据与迁移开关）。
    :return: 无返回值。
    :raises Exception: 目录配置无法解析时在启动期暴露（Path 构造为惰性，不主动抛出）。
    """
    frame_dir = Path(settings.generated_frame_dir)
    audio_dir = Path(settings.generated_audio_dir)
    video_dir = Path(settings.generated_video_dir)
    export_dir = Path(settings.generated_export_dir)
    storage_root = Path(settings.object_storage_root)
    # mock-assets 占位图：未配置时回落仓库根 public/images/login-hero-clean.png
    # （Node PUBLIC_MOCK_ASSET_IMAGE_PATH；api 容器内若未挂载则按 Node 同款 4040 处理）。
    default_mock_asset = Path(__file__).resolve().parents[2] / "public" / "images" / "login-hero-clean.png"
    mock_asset_path = Path(settings.mock_asset_image_path) if settings.mock_asset_image_path else default_mock_asset
    # COS 模式客户端缓存（与 media_urls.resolve 的惰性构建一致；测试经 monkeypatch 工厂替换）。
    cos_client_cell: list[Any] = []

    def _get_cos_client() -> Any:
        """惰性获取 COS 客户端（进程内缓存一份，对齐 Node 启动期构建）。

        :return: COS 客户端实例。
        :raises Exception: 工厂构建失败时原样抛出（调用方 catch-all 转 4040）。
        """
        if not cos_client_cell:
            cos_client_cell.append(cos_client_factory(settings))
        return cos_client_cell[0]

    def _storage_auth_failure() -> JSONResponse:
        """/storage 签名校验失败响应（有意收紧：Node 裸读 → 本服务强制验签）。

        :return: 401 + ``{code:4010}`` envelope，文案统一不区分缺失/伪造/过期。
        """
        return _media_json(401, 4010, "媒体访问签名缺失、无效或已过期")

    def _verify_storage_signature(key: str, request: Request) -> bool:
        """校验 /storage 请求的 ``expires``/``signature`` 签名（对齐 Node verifySignedUrl）。

        签名算法：HMAC-SHA256(secret, ``f"{key}\\n{expires}"``) 十六进制小写；过期
        （``expires <= now``）或形状非法一律拒绝；比较使用常数时间 ``hmac.compare_digest``。

        :param key: 已归一化的对象键。
        :param request: 当前请求（读取 query 参数）。
        :returns: 签名合法且未过期时 True。
        """
        expires_raw = request.query_params.get("expires")
        signature_raw = str(request.query_params.get("signature") or "").strip().lower()
        if not expires_raw or not _SIGNATURE_PATTERN.fullmatch(signature_raw):
            return False
        try:
            expires = int(expires_raw)
        except ValueError:
            return False
        now = int(time.time())
        if expires <= now:
            return False
        expected = hmac.new(
            settings.object_storage_signing_secret.encode(),
            f"{key}\n{expires}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, signature_raw)

    # ---------------- /generated/{p:path} ----------------

    def _serve_generated(p: str, range_header: str) -> Response:
        """分发 /generated 子路由（frame/audio/video/export，对照 Node L12013-L12194）。

        :param p: 通配路径参数（已解码相对路径）。
        :param range_header: 请求 Range 头原值。
        :returns: 200/206/416 媒体响应或 4040 envelope。
        """
        if _has_dot_segment(p):
            return _media_not_found()
        frame_match = _GENERATED_FRAME_PATTERN.fullmatch(p)
        if frame_match is not None:
            target = _resolve_within(frame_dir, [frame_match.group(1)])
            if target is None:
                return _media_json(404, 4040, "generated frame not found")
            extension = target.suffix.lower()
            content_type = {".png": "image/png", ".webp": "image/webp"}.get(extension, "image/jpeg")
            # Node frame 路由不支持 Range，也不发送 Accept-Ranges。
            return _file_media_response(
                target, content_type, "public, max-age=31536000, immutable", range_header, False, None
            )
        audio_match = _GENERATED_AUDIO_PATTERN.fullmatch(p)
        if audio_match is not None:
            target = _resolve_within(audio_dir, [audio_match.group(1)])
            if target is None:
                return _media_json(404, 4040, "generated audio not found")
            extension = target.suffix.lower()
            content_type = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4"}.get(extension, "audio/wav")
            return _file_media_response(target, content_type, "public, max-age=31536000, immutable", range_header, True)
        video_match = _GENERATED_VIDEO_PATTERN.fullmatch(p)
        if video_match is not None:
            target = _resolve_within(video_dir, [video_match.group(1)])
            if target is None:
                return _media_json(404, 4040, "generated video not found")
            return _file_media_response(
                target, "video/mp4", "public, max-age=31536000, immutable", range_header, True
            )
        export_match = _GENERATED_EXPORT_PATTERN.fullmatch(p)
        if export_match is not None:
            export_id, file_name = export_match.group(1), export_match.group(2)
            name = file_name if file_name else f"export-{export_id}.mp4"
            relative_parts = [export_id, name] if file_name else [name]
            target = _resolve_within(export_dir, relative_parts)
            if target is None:
                return _media_json(404, 4040, "generated export not found")
            if target.suffix.lower() == ".srt":
                # Node：srt 忽略 Range，Accept-Ranges: none。
                return _file_media_response(
                    target,
                    "application/x-subrip; charset=utf-8",
                    "public, max-age=31536000, immutable",
                    range_header,
                    False,
                    "none",
                )
            return _file_media_response(
                target, "video/mp4", "public, max-age=31536000, immutable", range_header, True
            )
        return _media_not_found()

    # ---------------- /storage/{p:path} ----------------

    def _serve_storage(p: str, request: Request) -> Response:
        """分发 /storage（本地流式读或 COS 流式代理，对照 Node L12926-L12946）。

        与 Node 的差异（有意收紧）：强制校验签名（Node 裸读）；本地模式支持
        ``.meta.json`` sidecar 的 contentType（Node readMetadata 同款）。

        :param p: 通配路径参数（服务端已解码一次；键内编码由 _normalize_key 再解码）。
        :param request: 当前请求（签名 query 参数）。
        :returns: 200 媒体流、4010 签名失败或 4040 envelope。
        """
        # Node 侧 WHATWG URL 会把点段（含 %2e 变体）归一化掉 → 落到『接口不存在』兜底；
        # 空段（如 //）WHATWG 会保留，交由 normalizeObjectKey 判非法 →『stored object not found』。
        if not p or any(segment in {".", ".."} for segment in p.split("/")):
            return _media_not_found()
        key = _normalize_key(p)
        if key is None:
            return _media_json(404, 4040, "stored object not found")
        if not _verify_storage_signature(key, request):
            return _storage_auth_failure()
        provider = settings.object_storage_provider.strip().lower()
        if provider == "cos":
            return _serve_storage_from_cos(key)
        target = _resolve_within(storage_root, key.split("/"))
        if target is None:
            return _media_json(404, 4040, "stored object not found")
        content_type = _read_meta_content_type(target) or _infer_object_content_type(key)
        # Node /storage 不支持 Range（getObject 全量返回），此处保持一致。
        return _file_media_response(
            target, content_type, "public, max-age=31536000, immutable", "", False
        )

    def _serve_storage_from_cos(key: str) -> Response:
        """COS 模式下的流式代理实现（对照 Node getObject 全量返回；本服务流式转发不落盘）。

        :param key: 已归一化的对象键。
        :returns: 200 流式响应（Content-Type 取 COS 响应头，缺省按扩展名推断）；
            任何 COS 异常按 Node catch-all 转 4040『stored object not found』。
        """
        try:
            client = _get_cos_client()
            response = client.get_object(Bucket=settings.cos_bucket, Key=key)
            body = response.get("Body") if isinstance(response, dict) else None
            if body is None:
                raise OSError("cos object body missing")
            content_type = ""
            if isinstance(response, dict):
                content_type = str(response.get("Content-Type") or "").strip()
            content_type = content_type or _infer_object_content_type(key)
            # qcloud SDK StreamBody 提供 get_raw_stream()；简单可读对象直接当文件流。
            raw_stream = body.get_raw_stream() if hasattr(body, "get_raw_stream") else body
            headers = {
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=31536000, immutable",
            }
            length_raw = response.get("Content-Length") if isinstance(response, dict) else None
            if length_raw not in (None, ""):
                headers["Content-Length"] = str(length_raw)

            def _iter_cos() -> Iterator[bytes]:
                """迭代 COS 对象体分片。

                :returns: 字节分片生成器。
                :raises OSError: 上游流读取失败时抛出（响应中断）。
                """
                while True:
                    chunk = raw_stream.read(_FILE_CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

            return StreamingResponse(_iter_cos(), status_code=200, media_type=content_type, headers=headers)
        except Exception:
            # Node：getObject 任何异常（含对象不存在）→ 4040 stored object not found。
            return _media_json(404, 4040, "stored object not found")

    # ---------------- /mock/{p:path} 与 /mock-assets/{p:path} ----------------

    def _serve_mock(p: str, _range_header: str) -> Response:
        """分发 /mock 子路由（image SVG 与 audio WAV，均代码生成，对照 Node L11979-L12216）。

        mock 内容由代码生成且 Node 不支持 Range，``_range_header`` 仅用于与
        generated 分发器保持同签名，处理时忽略。

        :param p: 通配路径参数。
        :param _range_header: 请求 Range 头原值（忽略）。
        :returns: 200 生成内容或 4040 envelope（未匹配走『接口不存在』）。
        """
        if _has_dot_segment(p):
            return _media_not_found()
        image_match = _MOCK_IMAGE_PATTERN.fullmatch(p)
        if image_match is not None:
            storyboard_id = int(image_match.group(1)) or 0
            version_no = int(image_match.group(2)) or 0
            candidate_no = int(image_match.group(3)) or 0
            return Response(
                content=_build_mock_image_svg(storyboard_id, version_no, candidate_no),
                status_code=200,
                media_type="image/svg+xml; charset=utf-8",
                headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
            )
        # Node：V2 结构优先于 V1。
        audio_v2 = _MOCK_AUDIO_V2_PATTERN.fullmatch(p)
        audio_v1 = _MOCK_AUDIO_V1_PATTERN.fullmatch(p)
        if audio_v2 is not None or audio_v1 is not None:
            if audio_v2 is not None:
                scene_id = int(audio_v2.group(2)) or 0
                character_id = int(audio_v2.group(3)) or 0
                version_no = int(audio_v2.group(4)) or 1
                track_type = audio_v2.group(5) or "dialogue"
                candidate_no = int(audio_v2.group(6)) or 1
            else:
                scene_id = 0
                character_id = 0
                version_no = int(audio_v1.group(2)) or 1  # type: ignore[union-attr]
                track_type = audio_v1.group(3) or "dialogue"  # type: ignore[union-attr]
                candidate_no = int(audio_v1.group(4)) or 1  # type: ignore[union-attr]
            source_seed = scene_id * 17 + character_id * 29
            return Response(
                content=_build_mock_audio_buffer(track_type, candidate_no, version_no, source_seed),
                status_code=200,
                media_type="audio/wav",
                headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
            )
        return _media_not_found()

    def _serve_mock_asset(p: str, _range_header: str) -> Response:
        """分发 /mock-assets（仓库静态占位图，对照 Node L11993-L12011）。

        Node 不支持 Range，``_range_header`` 仅用于保持同签名，处理时忽略。

        :param p: 通配路径参数（仅 ``project-{d}/node-{d}/v{d}-{d}.png`` 命中）。
        :param _range_header: 请求 Range 头原值（忽略）。
        :returns: 200 PNG（带 X-ProjectDream-Mock-Asset 头）或 4040 envelope。
        """
        if _has_dot_segment(p):
            return _media_not_found()
        if _MOCK_ASSET_PATTERN.fullmatch(p) is None:
            return _media_not_found()
        try:
            size = mock_asset_path.stat().st_size
            if size <= 0:
                raise OSError("empty mock asset")
        except OSError:
            # Node：占位图缺失 → 4040 mock asset image not found。
            return _media_json(404, 4040, "mock asset image not found")

        def _iter_mock_asset() -> Iterator[bytes]:
            """迭代占位图文件分片。

            :returns: 字节分片生成器。
            :raises OSError: 文件读取失败时抛出。
            """
            with open(mock_asset_path, "rb") as handle:
                while True:
                    chunk = handle.read(_FILE_CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

        return StreamingResponse(
            _iter_mock_asset(),
            status_code=200,
            media_type="image/png",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "public, max-age=3600",
                "Content-Length": str(size),
                "X-ProjectDream-Mock-Asset": "true",
            },
        )

    # ---------------- 注册（第四阶段起恒为原生实现，无过渡分支） ----------------

    prefix_handlers = {
        "generated": _serve_generated,
        "storage": _serve_storage,
        "mock": _serve_mock,
        "mock-assets": _serve_mock_asset,
    }

    for prefix, handler in prefix_handlers.items():
        # 1) 先注册「非 GET 方法」兜底（抢占 Starlette 为 GET 自动附加的 HEAD 匹配，
        #    与 Node 的最终 4040 兜底一致）。
        app.add_api_route(
            f"/{prefix}/{{p:path}}",
            lambda p: _media_not_found(),
            methods=["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            include_in_schema=False,
        )
        app.add_api_route(
            f"/{prefix}",
            lambda: _media_not_found(),
            methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            include_in_schema=False,
        )
        # 2) 再注册 GET 主路由；storage 的通配处理器需要 Request 以读取签名参数。
        if prefix == "storage":

            async def storage_route(p: str, request: Request) -> Response:
                """/storage GET 入口。

                :param p: 通配路径参数。
                :param request: 当前请求（签名 query 参数）。
                :return: 媒体响应或 envelope。
                """
                return _serve_storage(p, request)

            app.add_api_route(f"/{prefix}/{{p:path}}", storage_route, methods=["GET"], include_in_schema=False)
        else:

            async def generic_route(p: str, request: Request, _handler=handler) -> Response:
                """非 /storage 的 GET 媒体入口（generated/mock/mock-assets 共用分发器）。

                ``_handler`` 以默认参数绑定当前迭代的分发器，规避循环闭包晚绑定。

                :param p: 通配路径参数。
                :param request: 当前请求（读取 Range 头）。
                :return: 媒体响应或 envelope。
                """
                return _handler(p, request.headers.get("range", ""))

            app.add_api_route(f"/{prefix}/{{p:path}}", generic_route, methods=["GET"], include_in_schema=False)
