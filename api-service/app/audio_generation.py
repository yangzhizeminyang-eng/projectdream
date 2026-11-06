"""DashScope speech synthesis adapter used by native audio routes."""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

MAX_AUDIO_BYTES = 20 * 1024 * 1024


class AudioProviderError(RuntimeError):
    """A sanitized and classifiable TTS provider failure."""

    def __init__(self, message: str, status_code: int = 0) -> None:
        super().__init__(message[:300])
        self.status_code = int(status_code or 0)


def build_rule_based_voice_design(character: dict[str, Any], sample_text: str = "") -> dict[str, Any]:
    """Create the deterministic design fallback used when text-model credits are unavailable."""
    gender = str(character.get("gender") or "").strip().lower()
    gender_label = {"male": "男性", "female": "女性"}.get(gender, "中性")
    age_group = str(character.get("age_group") or character.get("ageGroup") or "").strip()
    age_label = {
        "child": "儿童", "teen": "青少年", "young_adult": "青年",
        "middle_aged": "中年", "senior": "老年",
    }.get(age_group, "成年")
    style = str(character.get("voice_style") or character.get("voiceStyle") or "").strip() or "语速适中，吐字清晰，情绪克制"
    personality = str(character.get("personality") or "").strip()
    role = str(character.get("role_tag") or character.get("roleTag") or "").strip()
    name = str(character.get("name") or "角色").strip()
    return {
        "name": f"{name}·规则声线设计",
        "summary": f"依据角色的{age_label}{gender_label}设定{f'与{role}身份' if role else ''}生成基础声线，并保留剧情要求的表演气质。",
        "timbre": f"{age_label}{gender_label}，普通话自然清晰；音色和发声方式遵循角色设定：{style}。",
        "ageAndGender": f"{age_label}{gender_label}声线，必须与角色结构化性别和年龄设定一致。",
        "emotionArc": f"表演情绪服从角色性格：{personality[:180]}" if personality else "情绪随台词语义变化，保持角色身份稳定。",
        "rhythm": style,
        "breathingAndPauses": "在施压或犹豫处使用短停顿和克制换气，不吞字，不用夸张喘息。",
        "performanceInstructions": f"使用{age_label}{gender_label}声线；{style}；根据当前台词语义控制重音和句尾，不模仿真实人物。",
        "avoid": (["女性、少女或甜美客服声线"] if gender == "male" else ["男性、少年或粗哑男低音"] if gender == "female" else [])
        + ["与年龄不符的声线、夸张播音腔、无依据的方言、失控咆哮、机械念稿"],
        "sampleText": " ".join(str(sample_text or "").split()),
        "generationSource": "rules_fallback",
    }


async def create_qwen_designed_voice(
    *, client: httpx.AsyncClient, api_key: str, target_model: str,
    voice_prompt: str, preview_text: str, prefix: str,
) -> dict[str, Any]:
    """Enroll a designed CosyVoice and decode the provider's preview sample."""
    key = api_key.strip()
    model = target_model.strip()
    prompt = voice_prompt.strip()
    sample = preview_text.strip()
    normalized_prefix = "".join(char for char in prefix if char.isascii() and char.isalnum())[:10]
    if not key:
        raise AudioProviderError("Missing DASHSCOPE_API_KEY or AUDIO_API_KEY configuration", 503)
    if not prompt or len(prompt) > 500 or not 15 <= len(sample) <= 200 or not normalized_prefix:
        raise AudioProviderError("Qwen voice design input is invalid", 400)
    if model.lower() not in {"cosyvoice-v3.5-flash", "cosyvoice-v3.5-plus"}:
        raise AudioProviderError("Qwen text voice design requires a supported CosyVoice v3.5 target model", 400)
    try:
        response = await client.post(
            "https://maas.qianwenaiapi.com/api/v1/services/audio/tts/customization",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "model": "voice-enrollment",
                "input": {
                    "action": "create_voice", "target_model": model, "voice_prompt": prompt,
                    "preview_text": sample, "prefix": normalized_prefix, "language_hints": ["zh"],
                },
                "parameters": {"sample_rate": 24000, "response_format": "wav"},
            },
            timeout=120,
        )
    except httpx.HTTPError as exc:
        raise AudioProviderError("Qwen voice design request failed") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    if response.is_error:
        detail = str(payload.get("message") or payload.get("code") or f"HTTP {response.status_code}")
        if key in detail:
            detail = detail.replace(key, "[redacted]")
        raise AudioProviderError(f"Qwen voice design failed: {detail}", response.status_code)
    output = payload.get("output", {}) if isinstance(payload, dict) else {}
    preview = output.get("preview_audio", {}) if isinstance(output, dict) else {}
    voice_id = str(output.get("voice_id") or "").strip() if isinstance(output, dict) else ""
    audio_data = str(preview.get("data") or "").strip() if isinstance(preview, dict) else ""
    if not voice_id or not audio_data:
        raise AudioProviderError("Qwen voice design returned no custom voice id or preview audio")
    return {
        "voice_id": voice_id,
        "target_model": str(output.get("target_model") or model),
        "preview_audio_bytes": _decode_audio_data(audio_data),
        "request_id": str(payload.get("request_id") or "").strip() or None,
    }


def _speech_endpoint(config: dict[str, Any], model_name: str) -> str:
    model = model_name.strip().lower()
    if model.startswith(("cosyvoice-", "qwen-audio-")):
        return "https://maas.qianwenaiapi.com/api/v1/services/audio/tts/SpeechSynthesizer"
    return str(config.get("base_url") or "").strip().rstrip("/")


def _decode_audio_data(value: str) -> bytes:
    normalized = value.strip()
    if normalized.startswith("data:"):
        header, separator, normalized = normalized.partition(",")
        if not separator or ";base64" not in header.lower():
            raise AudioProviderError("DashScope returned invalid audio data")
    try:
        audio = base64.b64decode(normalized, validate=True)
    except (ValueError, TypeError) as exc:
        raise AudioProviderError("DashScope returned invalid audio data") from exc
    if not audio:
        raise AudioProviderError("DashScope returned empty audio data")
    if len(audio) > MAX_AUDIO_BYTES:
        raise AudioProviderError("DashScope audio exceeds the 20MB limit")
    return audio


def _wav_duration(audio: bytes) -> float | None:
    if len(audio) < 44 or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return None
    offset = 12
    byte_rate = data_size = 0
    while offset + 8 <= len(audio):
        chunk = audio[offset : offset + 4]
        size = int.from_bytes(audio[offset + 4 : offset + 8], "little")
        start = offset + 8
        if chunk == b"fmt " and size >= 12 and start + 12 <= len(audio):
            byte_rate = int.from_bytes(audio[start + 8 : start + 12], "little")
        if chunk == b"data":
            data_size = min(size, max(0, len(audio) - start))
            break
        offset = start + size + (size % 2)
    if not byte_rate or not data_size:
        return None
    return max(0.1, round(data_size / byte_rate, 3))


def _valid_provider_audio_url(value: str) -> bool:
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").lower()
    return (
        parsed.scheme == "https"
        and not parsed.username
        and not parsed.password
        and any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in ("aliyuncs.com", "qianwenaiapi.com"))
    )


def _upgrade_provider_audio_url(value: str) -> str:
    """DashScope 结果 OSS 域名当前返回 http；仅对受信域名升级为 https。"""
    parsed = urlsplit(value)
    hostname = (parsed.hostname or "").lower()
    if parsed.scheme == "http" and any(
        hostname == suffix or hostname.endswith(f".{suffix}")
        for suffix in ("aliyuncs.com", "qianwenaiapi.com")
    ):
        return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    return value


async def synthesize_audio(
    *,
    config: dict[str, Any],
    text: str,
    voice_name: str,
    model_name: str,
    instructions: str | None,
    client: httpx.AsyncClient,
) -> dict[str, Any]:
    """Call DashScope, fetch its temporary audio URL when necessary, and return bytes."""
    if str(config.get("provider") or "").lower() != "dashscope":
        raise AudioProviderError("真实音频生成服务未配置", 503)
    api_key = str(config.get("api_key") or "").strip()
    endpoint = _speech_endpoint(config, model_name)
    if not api_key or not endpoint:
        raise AudioProviderError("DashScope 音频服务缺少密钥或接口地址", 503)
    normalized_text = text.strip()
    if not normalized_text:
        raise AudioProviderError("Speech synthesis text is required", 400)
    max_text_length = int(config.get("max_text_length") or 600)
    if len(normalized_text) > max_text_length:
        raise AudioProviderError(f"Speech synthesis text exceeds {max_text_length} characters", 400)

    is_cosy_voice = model_name.lower().startswith("cosyvoice-")
    input_payload: dict[str, Any] = {
        "text": normalized_text,
        "voice": voice_name,
        **({"format": "wav", "sample_rate": 24000} if is_cosy_voice else {
            "language_type": str(config.get("language_type") or "Chinese")
        }),
    }
    if instructions:
        if is_cosy_voice:
            bounded = ""
            units = 0
            for character in instructions.strip():
                next_units = 2 if "\u4e00" <= character <= "\u9fff" else 1
                if units + next_units > 100:
                    break
                bounded += character
                units += next_units
            input_payload["instruction"] = bounded.strip()
        else:
            input_payload["instructions"] = instructions
            input_payload["optimize_instructions"] = True

    try:
        response = await client.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"model": model_name, "input": input_payload},
            timeout=float(config.get("timeout_seconds") or 120),
        )
    except httpx.HTTPError as exc:
        raise AudioProviderError("DashScope speech synthesis request failed") from exc

    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        payload = {}
    if response.is_error:
        detail = str(payload.get("message") or payload.get("code") or f"HTTP {response.status_code}")
        raise AudioProviderError(f"DashScope speech synthesis failed: {detail}", response.status_code)

    audio = payload.get("output", {}).get("audio", {}) if isinstance(payload, dict) else {}
    audio_url = _upgrade_provider_audio_url(str(audio.get("url") or "").strip())
    audio_data = audio.get("data")
    content_type = "audio/wav"
    if isinstance(audio_data, str) and audio_data.strip():
        audio_bytes = _decode_audio_data(audio_data)
    elif audio_url:
        if not _valid_provider_audio_url(audio_url):
            raise AudioProviderError("DashScope returned an unsafe audio URL")
        try:
            download = await client.get(audio_url, timeout=float(config.get("timeout_seconds") or 120), follow_redirects=False)
        except httpx.HTTPError as exc:
            raise AudioProviderError("DashScope audio download failed") from exc
        if download.is_error:
            raise AudioProviderError(f"DashScope audio download failed with HTTP {download.status_code}", download.status_code)
        if len(download.content) > MAX_AUDIO_BYTES:
            raise AudioProviderError("DashScope audio exceeds the 20MB limit")
        audio_bytes = download.content
        content_type = download.headers.get("content-type", "audio/wav").split(";", 1)[0].strip() or "audio/wav"
        if not audio_bytes:
            raise AudioProviderError("DashScope audio download returned an empty file")
    else:
        raise AudioProviderError("DashScope speech synthesis returned no audio URL or audio data")

    return {
        "audio_bytes": audio_bytes,
        "content_type": content_type,
        "duration_seconds": _wav_duration(audio_bytes),
        "request_id": str(payload.get("request_id") or audio.get("id") or "").strip() or None,
        "model_name": model_name,
        "voice_name": voice_name,
    }
