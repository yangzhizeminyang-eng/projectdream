"""分镜质检规则的 Python 精确复刻（语义基准：``server/services/agent/quality-gate.mjs``）。

本模块是纯函数规则层：零框架依赖、不访问数据库、不调用模型，
供 LangGraph 编排图（:mod:`app.agent.quality.graph`）与兼容性测试直接复用。

对齐纪律：
- blocker/warning 结构统一为 ``{"code", "message", "severity"}``；
- 中文文案与 Node 实现逐字一致，便于跨语言 diff；
- camelCase / snake_case 字段双支持，取值顺序与 Node 的 ``??`` 链一致；
- 数值真值判断遵循 JS ``Number()`` 语义（NaN/0 为假）。

异常说明：本模块所有函数均不抛出异常——输入非法时一律降级为
空 dict / 空字符串 / NaN，并按 Node 语义落入对应的 blocker 分支。
"""

from __future__ import annotations

import json
import re
import urllib.parse
from datetime import datetime, timezone
from typing import Any

# 动作事件词表：与 Node 端 quality-gate.mjs 的正则逐词一致（顺序敏感，
# Python re 与 JS 的交替分支同为“最先出现者优先”，行为等价）。
_ACTION_EVENT_PATTERN = re.compile(
    r"(?:然后|随后|接着|同时|并且|再|之后|继而|滑出|滑入|打印|抬头|低头|转身|望向|看向|"
    r"打开|关闭|伸手|拿起|放下|递出|接过|走向|推开|拉开|按下|点击)"
)

# 无对白占位符判定：等价 JS /.../i 正则（$ 允许结尾换行，与 Python 行为一致）。
_NO_DIALOGUE_PATTERN = re.compile(
    r"^(?:[（(]\s*)?(?:无对白|无台词|no\s+dialogue)(?:\s*[）)])?$",
    re.IGNORECASE,
)

# 172.16.0.0 - 172.31.255.255 私网段（Node 端以 /^172\.(1[6-9]|2\d|3[01])\./ 判定）。
_PRIVATE_172_PATTERN = re.compile(r"^172\.(1[6-9]|2\d|3[01])\.")


def _issue(code: str, message: str, severity: str = "blocker") -> dict[str, str]:
    """构造与 Node ``issue()`` 同构的问题条目。

    :param code: 机器可读的问题码。
    :param message: 面向用户的中文说明，文案与 Node 一致。
    :param severity: 问题级别，``blocker`` 或 ``warning``。
    :return: ``{"code","message","severity"}`` 结构的 dict。
    """
    return {"code": code, "message": message, "severity": severity}


def _text(value: Any) -> str:
    """按 JS ``String(value ?? '').trim()`` 语义把任意值转成字符串。

    :param value: 任意 JSON 类型值（None 视为 undefined/null）。
    :return: 去除首尾空白后的字符串；常见类型的转换结果与 JS 一致。
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return ("true" if value else "false").strip()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # JS String(3.0) === '3'；超大数/小数保持字面表示。
        if value.is_integer() and abs(value) < 1e21:
            return str(int(value))
        return repr(value).strip()
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        return ",".join(_text(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value).strip()


def _js_number(value: Any) -> float:
    """按 JS ``Number()`` 语义把值转换为数字。

    :param value: 任意 JSON 类型值。
    :return: 转换结果；无法转换时返回 NaN（与 JS 一致，NaN 参与比较恒为假）。
    """
    if value is None:
        return float("nan")
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return 0.0
        try:
            return float(stripped)
        except ValueError:
            return float("nan")
    return float("nan")


def _number_truthy(value: Any) -> bool:
    """等价 JS ``!Number(x)`` 的取反判定：NaN 与 0 视为假。

    :param value: 待转换的原始值。
    :return: 转换后的数字是否为真值（非 NaN 且非 0）。
    """
    num = _js_number(value)
    return num == num and num != 0.0


def _parse_reference_json(value: Any) -> dict[str, Any]:
    """按 Node ``parseJson`` 语义解析资产引用 JSON。

    :param value: dict 原样返回；字符串尝试 JSON 解析。
    :return: 解析成功的 dict；其余情况（含解析失败、非对象结果）返回空 dict。
    :raises: 本函数不抛出异常，所有失败路径均降级为空 dict。
    """
    if isinstance(value, dict):
        return value
    if value is None:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _includes(container: Any, key: str) -> bool:
    """等价 JS ``Array.prototype.includes``（字符串时按子串语义，覆盖 JS 行为）。

    :param container: 数组或字符串；其他类型一律视为不包含。
    :param key: 待查找的元素。
    :return: 是否包含。
    """
    if isinstance(container, list):
        return key in container
    if isinstance(container, str):
        return key in container
    return False


def _pick(storyboard: dict, *keys: str) -> Any:
    """按 ``??`` 链顺序取第一个非 None 的字段值。

    :param storyboard: 源 dict（分镜记录）。
    :param keys: 依序尝试的字段名（camelCase 在前）。
    :return: 第一个非 None 的值；全部缺失时返回 None。
    """
    for key in keys:
        value = storyboard.get(key)
        if value is not None:
            return value
    return None


def _is_public_http_image_url(value: Any) -> bool:
    """判断图片地址是否为生成服务可访问的公网 http(s) 地址。

    语义对齐 Node ``isPublicHttpImageUrl``：解析失败或非 http/https 返回 False；
    拒绝 localhost、::1、0.0.0.0、127.*、10.*、192.168.*、172.16-31.*、169.254.*。
    与 Node 的差异：Python 解析器会把 ``[::1]`` 的方括号剥掉，本实现对
    ``::1`` 与 ``[::1]`` 两种形态都拒绝（比 Node 更严格，见交付说明）。

    :param value: URL 字符串（先经 ``_text`` 归一化）。
    :return: 是否为可访问的公网地址。
    """
    raw = _text(value)
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        return False
    if parsed.scheme.lower() not in ("http", "https"):
        return False
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return False
    if hostname in {"localhost", "::1", "[::1]", "0.0.0.0"}:
        return False
    if hostname.startswith(("127.", "10.", "192.168.", "169.254.")):
        return False
    if _PRIVATE_172_PATTERN.match(hostname):
        return False
    return True


def _asset_image_url(asset: dict) -> Any:
    """按 Node ``hasImage`` 的 ``??`` 键序取出资产图片地址。

    :param asset: 资产 dict。
    :return: 第一个非 None 的图片地址字段值；均缺失时为 None。
    """
    return _pick(asset, "imageUrl", "image_url", "thumbnailUrl", "thumbnail_url")


def _utc_now_iso() -> str:
    """生成与 JS ``new Date().toISOString()`` 同构的 UTC ISO 字符串。

    :return: 形如 ``2026-10-16T08:00:00.123Z``（毫秒精度 + Z 后缀）的字符串。
    """
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def inspect_storyboard_asset_reference_gate(
    storyboard: dict,
    *,
    require_character: bool = True,
    require_scene: bool = True,
) -> dict[str, Any]:
    """分镜资产引用门禁（语义复刻 Node ``inspectStoryboardAssetReferenceGate``）。

    检查分镜是否锁定了角色 / 场景资产引用：角色需要版本号、三视图版本与
    正/侧/背视图键；未携带资产包整图时还需要基础全身图与脸部特写引用
    （``characterFaceRequired === False`` 时显式豁免脸部检查）；
    场景需要场景资产 ID 与全景版本号。

    :param storyboard: 分镜记录；支持 ``asset_reference_json`` / ``assetReference`` /
        ``asset_reference`` 三键（按序取第一个非空值做 JSON 解析，失败得空 dict）。
    :param require_character: 是否执行角色引用检查。
    :param require_scene: 是否执行场景引用检查。
    :return: ``{"passed","blockers","reference","summary"}``；
        passed 表示无 blocker，summary 为与 Node 一致的中文文案。
    :raises: 本函数不抛出异常；引用 JSON 非法时按空引用走 blocker 分支。
    """
    blockers: list[dict[str, str]] = []
    reference = _parse_reference_json(
        _pick(storyboard, "asset_reference_json", "assetReference", "asset_reference")
    )

    if require_character:
        has_character_asset_pack = _js_number(
            reference.get("characterAssetPackImageId")
        ) > 0 and _js_number(reference.get("characterAssetPackVersionNo")) > 0
        if not _number_truthy(
            reference.get("characterId") or storyboard.get("character_id")
        ):
            blockers.append(_issue("character-asset-reference-missing", "分镜缺少角色资产引用"))
        if not _number_truthy(reference.get("characterVersionNo")):
            blockers.append(_issue("character-version-reference-missing", "分镜缺少角色版本引用"))
        view_keys = reference.get("characterViewKeys")
        if (
            not _number_truthy(reference.get("characterViewSetVersion"))
            or not isinstance(view_keys, list)
            or len(view_keys) < 3
        ):
            blockers.append(_issue("character-view-set-reference-missing", "分镜缺少角色三视图版本引用"))
        if not all(
            _includes(view_keys, key) for key in ("front", "side", "back")
        ):
            blockers.append(
                _issue("character-view-angle-reference-incomplete", "分镜角色三视图缺少正面、侧面或背面引用")
            )
        if not has_character_asset_pack and (
            not _number_truthy(reference.get("characterBaseImageId"))
            or not _number_truthy(reference.get("characterBaseVersionNo"))
        ):
            blockers.append(_issue("character-base-image-reference-missing", "分镜缺少角色基础正面全身图引用"))
        # 旧快照未携带 characterFaceRequired 标记时保持严格门禁（!== false 才要求）。
        if (
            not has_character_asset_pack
            and reference.get("characterFaceRequired") is not False
            and (
                not _number_truthy(reference.get("characterFaceImageId"))
                or not _number_truthy(reference.get("characterFaceVersionNo"))
            )
        ):
            blockers.append(_issue("character-face-closeup-reference-missing", "分镜缺少角色脸部特写引用"))

    if require_scene:
        if not _number_truthy(reference.get("sceneAssetId")):
            blockers.append(_issue("scene-asset-reference-missing", "分镜缺少场景资产引用"))
        if not _number_truthy(reference.get("scenePanoramaVersion")):
            blockers.append(_issue("scene-panorama-reference-missing", "分镜缺少场景全景版本引用"))

    return {
        "passed": len(blockers) == 0,
        "blockers": blockers,
        "reference": reference,
        "summary": (
            f"资产引用门禁未通过：{len(blockers)} 个问题需要处理"
            if blockers
            else "资产引用门禁通过"
        ),
    }


def inspect_storyboard_generation_context(
    storyboard: dict,
    assets: list | None = None,
    character_voices: list | None = None,
    *,
    require_confirmed_assets: bool = True,
) -> dict[str, Any]:
    """分镜生成上下文质检（语义复刻 Node ``inspectStoryboardGenerationContext``）。

    检查项：分镜记录与镜头提示词存在性（blocker）、景别/机位缺失（warning）、
    单镜动作事件过载（warning）、资产图片存在性与公网可达性、资产确认状态
    （strict 模式为 blocker，draft 模式降级为 warning）、对白与角色音色绑定。

    :param storyboard: 分镜记录，camelCase / snake_case 双支持。
    :param assets: 资产列表；非列表输入按空列表处理。
    :param character_voices: 角色音色绑定列表；非列表输入按空列表处理。
    :param require_confirmed_assets: True 为 strict 模式（资产问题阻塞），
        False 为 draft 模式（资产问题仅提示）。
    :return: ``{"passed","blockers","warnings","checkedAt","summary"}``；
        checkedAt 为与 JS ``toISOString()`` 同构的 UTC 时间戳。
    :raises: 本函数不抛出异常；非法输入一律按空值降级处理。
    """
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    prompt = _text(_pick(storyboard, "visualPrompt", "visual_prompt"))
    action_text = _text(_pick(storyboard, "actionText", "action_text"))
    dialogue = _text(_pick(storyboard, "dialogueText", "dialogue_text"))
    asset_list = assets if isinstance(assets, list) else []
    voice_list = character_voices if isinstance(character_voices, list) else []

    if not _text(storyboard.get("id")):
        blockers.append(_issue("storyboard-missing", "缺少分镜记录，无法建立视频生成任务"))
    if not prompt:
        blockers.append(_issue("visual-prompt-missing", "当前分镜还没有镜头提示词"))
    if not _text(_pick(storyboard, "shotType", "shot_type")):
        warnings.append(_issue("shot-type-missing", "未填写景别，视频模型将自行推断", "warning"))
    if not _text(_pick(storyboard, "cameraAngle", "camera_angle")):
        warnings.append(_issue("camera-angle-missing", "未填写机位，视频模型将自行推断", "warning"))
    action_events = _ACTION_EVENT_PATTERN.findall(action_text)
    if len(action_events) >= 4:
        warnings.append(_issue(
            "shot-action-overloaded",
            "本镜动作事件较多，建议拆成“线索出现”和“角色反应”等连续镜头，避免短时长内事件被模型省略。",
            "warning",
        ))

    for asset in asset_list:
        if not isinstance(asset, dict):
            continue
        label = _text(asset.get("label")) or f"资产 {asset.get('id') or ''}".strip()
        image_url = _asset_image_url(asset)
        if not _text(image_url):
            missing = _issue("asset-image-missing", f"资产「{label}」还没有可用图片")
            if require_confirmed_assets:
                blockers.append(missing)
            else:
                warnings.append({**missing, "severity": "warning"})
        if (
            require_confirmed_assets
            and _text(image_url)
            and not _is_public_http_image_url(image_url)
        ):
            blockers.append(_issue("asset-image-not-public", f"资产「{label}」图片地址不是 Agnes 可访问的公网地址"))
        status = _text(asset.get("status"))
        if require_confirmed_assets and status and status != "confirmed":
            blockers.append(_issue("asset-not-confirmed", f"资产「{label}」还没有确认，不能用于生成视频"))
        elif not require_confirmed_assets and status and status != "confirmed":
            warnings.append(_issue("asset-not-confirmed", f"资产「{label}」尚未确认，将按候选资产尝试生成", "warning"))

    # 对白判定：无对白占位符（含中英文变体）之外的文本都视为有对白，需要音色绑定。
    requires_voice = bool(dialogue) and _NO_DIALOGUE_PATTERN.match(dialogue) is None
    if requires_voice and not voice_list:
        blockers.append(_issue("voice-binding-missing", "当前分镜包含对白，但没有绑定角色音色"))
    if requires_voice:
        for voice in voice_list:
            if not isinstance(voice, dict):
                continue
            voice_key = _pick(voice, "voiceProfileKey", "voice_profile_key")
            reference_audio = _pick(voice, "referenceAudioUrl", "reference_audio_url")
            if not _text(voice_key) and not _text(reference_audio):
                label = _text(_pick(voice, "characterName", "character_name")) or (
                    f"角色 {voice.get('characterId') if voice.get('characterId') is not None else ''}".strip()
                )
                blockers.append(_issue("voice-binding-missing", f"角色「{label}」没有绑定系统音色或参考音频"))

    if blockers:
        summary = f"质检未通过：{len(blockers)} 个问题需要处理"
    elif warnings:
        summary = f"质检通过，但有 {len(warnings)} 个提示"
    else:
        summary = "质检通过，可以提交视频生成"

    return {
        "passed": len(blockers) == 0,
        "blockers": blockers,
        "warnings": warnings,
        "checkedAt": _utc_now_iso(),
        "summary": summary,
    }


def inspect_generated_video_result(
    items: list | None = None,
    *,
    expected_candidate_count: int = 1,
) -> dict[str, Any]:
    """视频生成结果质检（语义复刻 Node ``inspectGeneratedVideoResult``）。

    :param items: 候选视频结果列表；非列表输入按空列表处理。
    :param expected_candidate_count: 期望的候选数量；与 Node 一致，经
        ``max(1, Number(x) || 1)`` 归一化（0/负数/非法值都会回落到 1）。
    :return: ``{"passed","blockers","warnings","checkedAt","summary"}``。
    :raises: 本函数不抛出异常。
    """
    candidates = items if isinstance(items, list) else []
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    usable = [
        item
        for item in candidates
        if isinstance(item, dict)
        and _text(_pick(item, "videoUrl", "video_url"))
        and _text(item.get("status")) != "failed"
    ]

    if not usable:
        blockers.append(_issue("video-result-missing", "视频任务完成，但没有可供预览的视频地址"))
    expected_number = _js_number(expected_candidate_count)
    expected = max(1, expected_number) if _number_truthy(expected_number) else 1
    if len(usable) < expected:
        warnings.append(_issue(
            "video-candidate-count-short",
            f"请求 {expected} 个候选，实际得到 {len(usable)} 个",
            "warning",
        ))

    if blockers:
        summary = "视频结果质检未通过，请检查生成任务和媒体存储"
    elif warnings:
        summary = "视频结果可用，但候选数量少于请求数量"
    else:
        summary = "视频结果已通过基础完整性检查"

    return {
        "passed": len(blockers) == 0,
        "blockers": blockers,
        "warnings": warnings,
        "checkedAt": _utc_now_iso(),
        "summary": summary,
    }
