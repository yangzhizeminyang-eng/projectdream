"""角色库 DTO 与音色推荐（Node services/voice-profiles.mjs、index.mjs characterRow /
characterVoiceCastRow / characterImageRow 的 Python 复刻）。

年龄段/性别归一、音色特质推断、推荐打分与绑定校验逐字段对齐 Node。
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..mappers import voice_profile_row

AGE_GROUP_ORDER = ["child", "teen", "young_adult", "middle_aged", "senior"]

CHARACTER_AGE_GROUPS = [
    {"value": "child", "label": "儿童（12 岁及以下）"},
    {"value": "teen", "label": "少年（13-18 岁）"},
    {"value": "young_adult", "label": "青年（19-35 岁）"},
    {"value": "middle_aged", "label": "中年（36-55 岁）"},
    {"value": "senior", "label": "老年（56 岁以上）"},
]

CHARACTER_GENDERS = [
    {"value": "male", "label": "男性声线"},
    {"value": "female", "label": "女性声线"},
    {"value": "neutral", "label": "中性 / 系统声线"},
]


def normalize_character_age_group(value: Any) -> str | None:
    """Node normalizeCharacterAgeGroup：年龄段白名单归一化。"""
    normalized = str(value or "").strip().lower()
    return normalized if normalized in AGE_GROUP_ORDER else None


def normalize_character_gender(value: Any) -> str | None:
    """Node normalizeCharacterGender：性别白名单归一化。"""
    normalized = str(value or "").strip().lower()
    return normalized if normalized in ("male", "female", "neutral") else None


def _text(value: Any) -> str:
    """Node text() 等价。"""
    if value is None:
        return ""
    return str(value).strip()


def _chinese_number_to_int(value: str) -> int:
    """Node chineseNumberToInt：中文数字（零一...十）→ 整数。"""
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    text_value = str(value or "")
    if not text_value:
        return 0
    if text_value == "十":
        return 10
    ten_index = text_value.find("十")
    if ten_index >= 0:
        tens = 1 if ten_index == 0 else digits.get(text_value[ten_index - 1], 0)
        ones = 0 if ten_index == len(text_value) - 1 else digits.get(text_value[ten_index + 1], 0)
        return tens * 10 + ones
    total = 0
    for char in text_value:
        total = total * 10 + digits.get(char, 0)
    return total


def _age_group_from_age(age: float) -> str | None:
    """Node ageGroupFromAge：数值年龄 → 段位。"""
    if not (age > 0):
        return None
    if age <= 12:
        return "child"
    if age <= 18:
        return "teen"
    if age <= 35:
        return "young_adult"
    if age <= 55:
        return "middle_aged"
    return "senior"


def _infer_age_group(source: Any) -> str | None:
    """Node inferAgeGroup：文本年龄证据推断。"""
    text_value = str(source or "")
    range_match = re.search(r"(\d{1,2})\s*(?:至|到|[-~—])\s*(\d{1,2})\s*岁", text_value)
    if range_match:
        return _age_group_from_age((int(range_match.group(1)) + int(range_match.group(2))) / 2)
    age_match = re.search(r"(\d{1,2})\s*岁", text_value)
    if age_match:
        return _age_group_from_age(int(age_match.group(1)))
    chinese_age_match = re.search(r"(?<![轻差小前后到至])([零一二两三四五六七八九十]{1,3})\s*岁", text_value)
    if chinese_age_match:
        return _age_group_from_age(_chinese_number_to_int(chinese_age_match.group(1)))
    if re.search(r"女童|男童|小女孩|小男孩|儿童|孩童|幼年", text_value):
        return "child"
    if re.search(r"十几岁|少年|少女|中学生", text_value):
        return "teen"
    if re.search(r"老年|老人|老者|长者|爷爷|奶奶|六十|七十|八十", text_value):
        return "senior"
    if re.search(r"中年|四十|五十|成熟管理者|父亲|母亲", text_value):
        return "middle_aged"
    if re.search(r"青年|年轻|二十|三十", text_value):
        return "young_adult"
    return None


def _infer_gender(source: Any) -> str | None:
    """Node inferGender：文本性别证据推断。"""
    text_value = str(source or "")
    if re.search(r"女性|女人|女声|女孩|女童|少女|姐姐|妹妹|母亲|妻子|奶奶|御姐", text_value):
        return "female"
    if re.search(r"男性|男人|男声|男孩|男童|少年|哥哥|弟弟|父亲|丈夫|爷爷|老者", text_value):
        return "male"
    if re.search(r"系统|终端|机械|无实体|中性", text_value):
        return "neutral"
    return None


_STYLE_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("沉稳", re.compile(r"沉稳|稳重|厚重")),
    ("低沉", re.compile(r"低沉|压低|深沉")),
    ("权威", re.compile(r"权威|管理|主管|监管|官署|领导")),
    ("压迫", re.compile(r"压迫|审讯|冷酷|反派")),
    ("克制", re.compile(r"克制|收束|节制")),
    ("冷静", re.compile(r"冷静|冷淡|理性|稳定")),
    ("温柔", re.compile(r"温柔|舒缓|柔和")),
    ("亲切", re.compile(r"亲切|友善|温暖")),
    ("活力", re.compile(r"活力|活泼|阳光|朝气")),
    ("沧桑", re.compile(r"沧桑|疲惫|阅历|风霜")),
    ("沙哑", re.compile(r"沙哑|烟嗓|粗粝")),
    ("慈和", re.compile(r"慈和|慈祥|和蔼|长辈")),
    ("长者", re.compile(r"长者|老人|老年|老者|大爷|奶奶|婆婆")),
    ("从容", re.compile(r"从容|不疾不徐|沉静")),
    ("童真", re.compile(r"童真|童年|小女孩|小男孩|儿童")),
    ("系统", re.compile(r"系统|终端|机械|播报|无实体")),
]


def infer_character_voice_traits(character: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node inferCharacterVoiceTraits：从角色档案推断音色需求（只用于推荐）。

    :param character: 角色行。
    :returns: ``{"ageGroup", "gender", "styleTags", "inferredAge", "inferredGender"}``。
    """
    character = character or {}
    identity_source = "\n".join(
        value for value in (_text(character.get("name")), _first(character.get("role_tag"), character.get("roleTag"))) if value
    )
    source = "\n".join(
        value
        for value in (
            _text(character.get("name")),
            _first(character.get("role_tag"), character.get("roleTag")),
            _text(character.get("appearance")),
            _text(character.get("personality")),
            _first(character.get("voice_style"), character.get("voiceStyle")),
        )
        if value
    )
    explicit_age = normalize_character_age_group(_first(character.get("age_group"), character.get("ageGroup")))
    explicit_gender = normalize_character_gender(character.get("gender"))
    style_tags = [tag for tag, pattern in _STYLE_RULES if pattern.search(source)]
    return {
        "ageGroup": explicit_age or _infer_age_group(source),
        "gender": explicit_gender or _infer_gender(identity_source) or _infer_gender(source),
        "styleTags": style_tags,
        "inferredAge": not explicit_age,
        "inferredGender": not explicit_gender,
    }


def _first(*values: Any) -> Any:
    """首个非 None 值（不 trim，供 camel/snake 双键读取）。"""
    for value in values:
        if value is not None:
            return value
    return None


def _age_distance(age_group: str, profile_age_groups: list[str]) -> int | None:
    """Node ageDistance：年龄段距离（无交集 None）。"""
    try:
        target_index = AGE_GROUP_ORDER.index(age_group)
    except ValueError:
        return None
    if not profile_age_groups:
        return None
    indexes = []
    for item in profile_age_groups:
        try:
            indexes.append(AGE_GROUP_ORDER.index(item))
        except ValueError:
            continue
    return min((abs(target_index - index) for index in indexes), default=None)


def recommend_voice_profiles(
    character: dict[str, Any],
    profiles: list[Any],
    limit: int = 3,
) -> dict[str, Any]:
    """Node recommendVoiceProfiles：候选音色打分排序（性别/年龄段/风格标签）。

    :param character: 角色行。
    :param profiles: voice_profiles 行（或 DTO）。
    :param limit: 返回数量上限（1-6）。
    :returns: ``{"traits", "items"}``。
    """
    traits = infer_character_voice_traits(character)
    scored = []
    for raw in profiles:
        profile = raw if isinstance(raw, dict) and "profileKey" in raw else voice_profile_row(raw)
        if profile.get("status") != "active":
            continue
        score = 0
        reasons: list[str] = []
        if traits["gender"]:
            if profile.get("gender") == traits["gender"]:
                score += 55
                reasons.append("声线性别匹配")
            elif profile.get("gender") == "neutral":
                score += 5
            else:
                score -= 80
        if traits["ageGroup"]:
            distance = _age_distance(traits["ageGroup"], profile.get("ageGroups") or [])
            if distance == 0:
                score += 45
                reasons.append("年龄段匹配")
            elif distance == 1:
                score += 10
            elif distance is not None:
                score -= distance * 20
        matching_tags = [tag for tag in (profile.get("styleTags") or []) if tag in traits["styleTags"]]
        score += len(matching_tags) * 12
        if matching_tags:
            reasons.append(f"气质匹配：{'、'.join(matching_tags[:3])}")
        if profile.get("instructions"):
            score += 2
        scored.append({**profile, "score": score, "matchReasons": reasons or ["通用声线候选"]})
    scored.sort(key=lambda item: (-item["score"], item.get("sortOrder") or 0))
    try:
        bounded = int(limit)
    except (TypeError, ValueError):
        bounded = 3
    bounded = max(1, min(6, bounded or 3))
    return {"traits": traits, "items": scored[:bounded]}


def resolve_character_voice_profile(
    character: dict[str, Any],
    profiles: list[Any],
    requested_profile_key: Any = "",
) -> dict[str, Any]:
    """Node resolveCharacterVoiceProfile：绑定/试听音色解析（含性别一致性校验）。

    :returns: ``{"profile", "traits", "error"}``。
    """
    active_profiles = []
    for raw in profiles:
        profile = raw if isinstance(raw, dict) and "profileKey" in raw else voice_profile_row(raw)
        if profile.get("status") == "active":
            active_profiles.append(profile)
    traits = infer_character_voice_traits(character)
    requested_key = str(requested_profile_key or "").strip()
    if requested_key:
        selected = next((profile for profile in active_profiles if profile["profileKey"] == requested_key), None)
    else:
        selected = (recommend_voice_profiles(character, active_profiles, 1).get("items") or [None])[0]
    if not selected:
        return {
            "profile": None,
            "traits": traits,
            "error": "试听音色方案不存在或已停用" if requested_key else "当前没有可用的角色音色方案",
        }
    if traits["gender"] and selected.get("gender") != traits["gender"] and selected.get("gender") != "neutral":
        gender_label = {"male": "男性", "female": "女性", "neutral": "中性"}
        return {
            "profile": None,
            "traits": traits,
            "error": f"{gender_label[traits['gender']]}角色不能绑定{gender_label[selected['gender']]}声线，请选择性别匹配的音色",
        }
    return {"profile": selected, "traits": traits, "error": None}


def _has_designed_voice(character: dict[str, Any], custom_voice_design: Any) -> bool:
    """Node hasDesignedVoice：自定义设计音色完整性判定。"""
    voice_setting = _first(character.get("voice_setting"), character.get("voiceSetting"))
    voice_id = _text((custom_voice_design or {}).get("voiceId"))
    target_model = _text(
        (custom_voice_design or {}).get("targetModel", (custom_voice_design or {}).get("target_model"))
    )
    return bool(
        _text(voice_setting)
        and _text((custom_voice_design or {}).get("provider"))
        and voice_id
        and voice_id == _text(voice_setting)
        and target_model
    )


def is_character_voice_ready(character: dict[str, Any], selected_profile: dict[str, Any] | None) -> bool:
    """Node isCharacterVoiceReady：音色是否可用（锁定 + 有音源）。"""
    locked = _first(character.get("voice_locked"), character.get("voiceLocked"))
    locked = locked in (True, 1, "1")
    voice_design = _first(character.get("voice_design_json"), character.get("voiceDesign"))
    custom_voice_design = voice_design
    if isinstance(voice_design, str):
        try:
            custom_voice_design = json.loads(voice_design)
        except (TypeError, ValueError):
            custom_voice_design = None
    has_voice_source = bool(
        selected_profile
        or _text(_first(character.get("voice_profile_key"), character.get("voiceProfileKey")))
        or _text(_first(character.get("reference_audio_url"), character.get("referenceAudioUrl")))
        or _has_designed_voice(character, custom_voice_design)
    )
    return locked and has_voice_source


def resolve_reference_audio_url_value(row: dict[str, Any], fallback: Any = None) -> str | None:
    """Node resolveReferenceAudioUrl（index.mjs L8786 入队可见子集）：参考音频地址。"""
    value = _text(_first(row.get("reference_audio_url"), row.get("referenceAudioUrl")))
    return value or (str(fallback) if fallback else None)


def character_row(row: dict[str, Any]) -> dict[str, Any]:
    """Node characterRow：characters 行 → 前端 DTO（音色设计 JSON 已解析）。"""
    voice_design = _first(row.get("voice_design_json"), row.get("voiceDesignJson"))
    if isinstance(voice_design, str):
        try:
            voice_design = json.loads(voice_design)
        except (TypeError, ValueError):
            voice_design = None
    return {
        "id": row.get("id"),
        "projectId": _first(row.get("project_id"), row.get("projectId")),
        "name": row.get("name"),
        "roleTag": _first(row.get("role_tag"), row.get("roleTag")),
        "personality": row.get("personality"),
        "appearance": row.get("appearance"),
        "costume": _first(row.get("costume"), row.get("costume_description")),
        "voiceSetting": _first(row.get("voice_setting"), row.get("voiceSetting")),
        "ageGroup": _first(row.get("age_group"), row.get("ageGroup")),
        "gender": row.get("gender"),
        "voiceStyle": _first(row.get("voice_style"), row.get("voiceStyle")),
        "voiceProfileKey": _first(row.get("voice_profile_key"), row.get("voiceProfileKey")),
        "voiceLocked": bool(_first(row.get("voice_locked"), row.get("voiceLocked"))),
        "voiceDesign": voice_design,
        "referenceImageUrl": _first(row.get("reference_image_url"), row.get("referenceImageUrl")),
        "referenceAudioUrl": _text(_first(row.get("reference_audio_url"), row.get("referenceAudioUrl"))) or None,
        "status": row.get("status"),
        "createdAt": _first(row.get("created_at"), row.get("createdAt")),
        "updatedAt": _first(row.get("updated_at"), row.get("updatedAt")),
    }


def character_voice_cast_row(row: dict[str, Any], profiles: list[dict[str, Any]]) -> dict[str, Any]:
    """Node characterVoiceCastRow：角色×音色阵容行（含推荐与就绪态）。"""
    character = character_row(row)
    recommendation = recommend_voice_profiles(row, profiles, 3)
    selected_profile = next(
        (profile for profile in profiles if profile.get("profileKey") == character.get("voiceProfileKey")),
        None,
    )
    return {
        "character": character,
        "traits": recommendation["traits"],
        "selectedProfile": selected_profile,
        "recommendations": recommendation["items"],
        "ready": is_character_voice_ready(
            {**character, "voiceProfileKey": (selected_profile or {}).get("profileKey") or ""},
            selected_profile,
        ),
    }


def character_image_row(row: dict[str, Any], resolve_storage_url: Any = None) -> dict[str, Any]:
    """Node characterImageRow：character_images 行 → DTO（storage_key 优先签名 URL）。

    :param row: character_images 行。
    :param resolve_storage_url: storage_key → 签名 URL 回调（失败回退历史地址）。
    :returns: 定妆图 DTO。
    """
    storage_key = _first(row.get("storage_key"), row.get("storageKey"))
    image_url = _first(row.get("image_url"), row.get("imageUrl"))
    thumbnail_url = _first(row.get("thumbnail_url"), row.get("thumbnailUrl"))

    def resolve(key: Any, fallback: Any) -> Any:
        """签名失败/缺失回退历史地址（Node resolveObjectStorageUrl 同语义）。"""
        if key and callable(resolve_storage_url):
            try:
                signed = resolve_storage_url(key)
                if signed:
                    return signed
            except Exception:
                pass
        return fallback

    if storage_key:
        image_url = resolve(storage_key, image_url)
        thumbnail_url = resolve(storage_key, thumbnail_url or image_url)
    return {
        "id": row.get("id"),
        "characterId": _first(row.get("character_id"), row.get("characterId")),
        "versionNo": _first(row.get("version_no"), row.get("versionNo")),
        "imageUrl": image_url,
        "thumbnailUrl": thumbnail_url,
        "storageKey": storage_key,
        "promptSnapshot": _first(row.get("prompt_snapshot"), row.get("promptSnapshot")),
        "modelName": _first(row.get("model_name"), row.get("modelName")),
        "status": row.get("status"),
        "confirmedAt": _first(row.get("confirmed_at"), row.get("confirmedAt")),
        "createdAt": _first(row.get("created_at"), row.get("createdAt")),
    }
