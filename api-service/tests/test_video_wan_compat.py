"""Wan 3.0 provider compatibility for the FastAPI video enqueue layer."""

import pytest

from app.domain.video_generation import (
    assert_video_model_provider,
    get_video_provider_config,
    is_wan_video_model,
)


def test_wan_provider_defaults():
    config = get_video_provider_config({
        "VIDEO_PROVIDER": "wan",
        "VIDEO_MODEL": "",
    })
    assert config == {"provider": "wan", "defaultModel": "wan3.0-video"}


def test_wan_model_requires_wan_provider():
    assert is_wan_video_model("wan3.0-video")
    assert is_wan_video_model("wan3.0-video-prime")
    assert not is_wan_video_model("wan2.7-image")
    assert assert_video_model_provider("wan3.0-video", "wan") is True
    with pytest.raises(ValueError, match="Wan 模型需要配置视频服务商为 wan"):
        assert_video_model_provider("wan3.0-video", "agnes")


def test_existing_provider_assertions_still_apply():
    assert assert_video_model_provider("MiniMax-H3", "minimax") is True
    assert assert_video_model_provider("agnes-video-2.5-flash", "agnes") is True
    with pytest.raises(ValueError, match="Agnes 模型需要配置视频服务商为 agnes"):
        assert_video_model_provider("agnes-video-2.5-flash", "wan")
