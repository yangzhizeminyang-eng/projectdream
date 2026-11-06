import asyncio
import json

import httpx

from app.ai_generators import generate_outline
from app.ai_provider import AiConfig


def _config(*, provider="mock", fallback_to_mock=False):
    return AiConfig(
        provider=provider, base_url="https://ai.example.test/v1", api_key="test-only",
        default_model="model-default", outline_model="model-outline", script_model="model-script",
        storyboard_model="model-storyboard", character_model="model-character",
        timeout_ms=1000, long_task_timeout_ms=1000, fallback_to_mock=fallback_to_mock,
    )


def test_mock_outline_is_deterministic_and_contains_complete_scene_preview():
    project = {"id": 7, "name": "雨夜档案", "category": "悬疑", "targetDuration": 40}

    first = asyncio.run(generate_outline(project, client=httpx.AsyncClient(), config=_config()))
    second = asyncio.run(generate_outline(project, client=httpx.AsyncClient(), config=_config()))

    assert first == second
    assert first["title"] == "雨夜档案"
    assert len(first["acts"]) == 3
    assert len(first["scenes"]) == 4
    assert [scene["scene_no"] for scene in first["scenes"]] == [1, 2, 3, 4]
    assert all(scene["location"] and scene["time_of_day"] and scene["estimated_duration"] > 0 for scene in first["scenes"])


def test_real_outline_uses_normalized_structured_provider_output():
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        content = json.dumps({
            "title": "未命名项目", "logline": "一名编辑发现被删除的档案。", "premise": "完整前提",
            "visual_style": "冷色纪实", "acts": [{"title": "开端"}],
            "scenes": [{"title": "未命名场景", "summary": "线索出现", "location": "档案室"}],
        }, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_outline(
                {"id": 4, "name": "档案夜班", "category": "悬疑", "targetDuration": 30},
                client=client, config=_config(provider="openai"),
            )

    result = asyncio.run(run())

    assert result["title"] == "档案夜班"
    assert result["acts"][0] == {"act": 1, "title": "开端", "summary": "本幕摘要待补充。"}
    assert result["scenes"][0] == {
        "scene_no": 1, "title": "未命名场景", "summary": "线索出现", "location": "档案室",
        "time_of_day": "夜", "estimated_duration": 450,
    }
    assert len(requests) == 1
    assert requests[0]["model"] == "model-outline"


def test_real_outline_falls_back_only_when_explicitly_configured():
    def handler(_request):
        return httpx.Response(503, json={"error": {"message": "offline"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_outline(
                {"id": 4, "name": "档案夜班", "category": "悬疑"},
                client=client, config=_config(provider="openai", fallback_to_mock=True),
            )

    result = asyncio.run(run())

    assert result["title"] == "档案夜班"
    assert result["scenes"]


def test_real_outline_provider_failure_propagates_when_fallback_is_disabled():
    def handler(_request):
        return httpx.Response(503, json={"error": {"message": "offline"}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await generate_outline(
                {"id": 4, "name": "档案夜班"}, client=client,
                config=_config(provider="openai", fallback_to_mock=False),
            )

    try:
        asyncio.run(run())
    except Exception as exc:
        assert "outline" in str(exc).lower() or "AI" in str(exc)
    else:
        raise AssertionError("provider failure must not be converted to fake outline success")
