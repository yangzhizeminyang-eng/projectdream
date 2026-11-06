"""DashScope TTS adapter contract tests; all requests use an in-memory transport."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest

from app.audio_generation import AudioProviderError, build_rule_based_voice_design, create_qwen_designed_voice, synthesize_audio


def _wav_bytes() -> bytes:
    return b"RIFF" + b"\x00" * 4 + b"WAVE" + b"fmt " + b"\x10\x00\x00\x00" + b"\x01\x00\x01\x00" + b"\x44\xac\x00\x00" + b"\x88\x58\x01\x00" + b"\x02\x00\x10\x00" + b"data" + b"\x04\x00\x00\x00" + b"\x00\x00\x00\x00"


def _run_synthesis(handler, *, model="qwen3-tts-flash"):
    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)
    config = {
        "provider": "dashscope",
        "api_key": "unit-test-key",
        "base_url": "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        "model": model,
        "language_type": "Chinese",
        "timeout_seconds": 5,
    }

    async def run():
        try:
            return await synthesize_audio(
                config=config,
                text="测试对白",
                voice_name="Cherry",
                model_name=model,
                instructions="清晰、克制",
                client=client,
            )
        finally:
            await client.aclose()

    return asyncio.run(run())


def test_synthesize_audio_posts_dashscope_contract_and_decodes_inline_audio():
    wav = _wav_bytes()
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(
            200,
            json={"request_id": "req-1", "output": {"audio": {"data": base64.b64encode(wav).decode()}}},
        )

    result = _run_synthesis(handler)

    request = captured["request"]
    assert request.url.host == "dashscope.aliyuncs.com"
    assert request.headers["authorization"] == "Bearer unit-test-key"
    assert json.loads(request.content) == {
        "model": "qwen3-tts-flash",
        "input": {
            "text": "测试对白",
            "voice": "Cherry",
            "language_type": "Chinese",
            "instructions": "清晰、克制",
            "optimize_instructions": True,
        },
    }
    assert result == {
        "audio_bytes": wav,
        "content_type": "audio/wav",
        "duration_seconds": 0.1,
        "request_id": "req-1",
        "model_name": "qwen3-tts-flash",
        "voice_name": "Cherry",
    }


def test_synthesize_audio_downloads_provider_audio_and_preserves_content_type():
    wav = _wav_bytes()
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.method == "POST":
            return httpx.Response(200, json={"output": {"audio": {"url": "https://audio.dashscope.aliyuncs.com/result.wav"}}})
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    result = _run_synthesis(handler)

    assert calls == ["/api/v1/services/aigc/multimodal-generation/generation", "/result.wav"]
    assert result["audio_bytes"] == wav
    assert result["content_type"] == "audio/wav"


def test_synthesize_audio_upgrades_trusted_http_dashscope_result_url_to_https():
    """DashScope 结果 URL 目前返回 http://*.aliyuncs.com；只对受信域名升级为 https 再下载。"""
    wav = _wav_bytes()
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(200, json={"output": {"audio": {
                "url": "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav",
            }}})
        return httpx.Response(200, content=wav, headers={"content-type": "audio/wav"})

    result = _run_synthesis(handler)

    assert calls[1][0] == "GET"
    assert calls[1][1].startswith("https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.wav")
    assert result["audio_bytes"] == wav


def test_synthesize_audio_rejects_provider_success_without_audio_payload():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"output": {}})

    with pytest.raises(AudioProviderError, match="no audio"):
        _run_synthesis(handler)


def test_synthesize_audio_surfaces_provider_failure_without_leaking_api_key():
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"message": "rate limit"})

    with pytest.raises(AudioProviderError, match="rate limit") as error:
        _run_synthesis(handler)
    assert "unit-test-key" not in str(error.value)
    assert error.value.status_code == 429


def test_rule_voice_design_preserves_structured_character_traits():
    design = build_rule_based_voice_design({
        "name": "林夏", "gender": "female", "age_group": "young_adult",
        "role_tag": "调查记者", "voice_style": "清醒克制", "personality": "坚韧而谨慎",
    }, "别怕，我在这里。")

    assert design["generationSource"] == "rules_fallback"
    assert "女性" in design["ageAndGender"]
    assert "调查记者" in design["summary"]
    assert design["sampleText"] == "别怕，我在这里。"
    assert design["avoid"]


def test_qwen_voice_enrollment_posts_contract_and_decodes_preview_audio():
    wav = _wav_bytes()
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["request"] = request
        return httpx.Response(200, json={"request_id": "enroll-1", "output": {
            "voice_id": "char9-test", "target_model": "cosyvoice-v3.5-flash",
            "preview_audio": {"data": base64.b64encode(wav).decode(), "response_format": "wav", "sample_rate": 24000},
        }})

    transport = httpx.MockTransport(handler)
    client = httpx.AsyncClient(transport=transport)

    async def run():
        try:
            return await create_qwen_designed_voice(
                client=client, api_key="unit-test-key", target_model="cosyvoice-v3.5-flash",
                voice_prompt="青年女性，清醒克制", preview_text="我给过你机会，现在把你知道的都说出来。", prefix="char9",
            )
        finally:
            await client.aclose()

    result = asyncio.run(run())

    request = captured["request"]
    assert request.url.host == "maas.qianwenaiapi.com"
    assert json.loads(request.content)["input"]["action"] == "create_voice"
    assert result["voice_id"] == "char9-test"
    assert result["preview_audio_bytes"] == wav
    assert result["request_id"] == "enroll-1"
