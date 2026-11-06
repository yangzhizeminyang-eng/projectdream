"""frameCharacterContext 复刻（FastAPI-Only 迁移第三阶段第三组 · 任务 A）。

逐行为复刻 Node ``server/services/frame-character-consistency.mjs`` 与其依赖
``server/services/voice-profiles.mjs`` 中的角色音色/性别/年龄段推断函数：
把分镜中的 characterName/characterId 解析成角色库里的真实角色，同时收集
性别、年龄、外貌、参考图等约束；``ready=False`` 表示存在阻塞问题。

对照验收：``tests/fixtures/frame_character_fixtures.json`` 由
``tests/fixtures/generate_frame_fixtures.mjs``（调用 Node 真实实现）生成，
``tests/test_frame_character_fixtures.py`` 断言本模块输出与 fixture 逐字段一致。

字段命名约定：入参行是 DB snake_case 行（Node 路由把 DB 行直接传入），
同时兼容 camelCase 别名（与 Node ``??`` 双取值一致）。
"""

from __future__ import annotations

import json
import re
from typing import Any

# ---------------------------------------------------------------------------
# 文案表（与 Node AGE_GROUP_LABELS / GENDER_LABELS 逐字一致；注意与
# voice-profiles.mjs 的目录文案不同——本模块的 label 中无空格）。
# ---------------------------------------------------------------------------

AGE_GROUP_LABELS: dict[str, str] = {
    "child": "儿童（12岁及以下）",
    "teen": "少年（13-18岁）",
    "young_adult": "青年（19-35岁）",
    "middle_aged": "中年（36-55岁）",
    "senior": "老年（56岁以上）",
}

GENDER_LABELS: dict[str, str] = {
    "male": "男性",
    "female": "女性",
    "neutral": "中性 / 无实体",
}

CHARACTER_FREE_PATTERN = re.compile(r"^(?:无角色|无人|空镜|环境|场景|旁白|none)$", re.I)
HUMAN_SUBJECT_PATTERN = re.compile(
    r"人物|角色|主角|配角|女人|男人|女孩|男孩|女童|男童|少女|少年|老人"
    r"|(?:^|[，。；、\s])[她他](?:们)?(?:[，。；、\s]|$)|woman|man|girl|boy|character|protagonist",
    re.I,
)
AUDIO_ONLY_IDENTITY_PATTERN = re.compile(r"旁白|画外音|系统声|终端声|广播声|通讯声|声音|男声|女声", re.I)
VISUAL_PRESENCE_PATTERN = re.compile(
    r"人物|角色|身影|背影|全息|轮廓|脸|面部|身体|目光|眼神|站立|站着|站在|伫立|坐在|坐着|落座"
    r"|行走|走进|走出|跑动|跑向|抬头|转身|出现|现身|入镜|出镜",
    re.I,
)
EXPLICIT_OFFSCREEN_PATTERN = re.compile(
    r"(?:画面|镜头)(?:中|内|里)?(?:明确)?(?:不|没有|无)(?:会)?(?:出现|呈现|展示|包含)?(?:任何)?(?:实体)?"
    r"(?:人物|人像|角色)|(?:仅|只)(?:以|通过)?.{0,12}(?:声音|广播|画外音)(?:存在|出现|呈现)?",
    re.I,
)
AUDIO_ONLY_IDENTITY_HINT_PATTERN = re.compile(
    r"广播(?:中|里的)?(?:的)?(?:声音|回应者)|主要通过广播|仅(?:以|通过).*声音|无实体",
    re.I,
)

# voice-profiles.mjs 的年龄段顺序（推荐打分与 ageGroupFromAge 共用）。
AGE_GROUP_ORDER = ["child", "teen", "young_adult", "middle_aged", "senior"]


def _s(value: Any) -> str:
    """JS ``String(value || '')``：None/0/False/空容器 → 空串。

    :param value: 任意输入。
    :returns: 字符串化结果（真值才转字符串，与 JS 短路一致）。
    """
    if value is None or value is False:
        return ""
    if isinstance(value, (int, float)) and value == 0:
        return ""
    return str(value)


def _normalized_text(value: Any) -> str:
    """JS ``normalizedText``：String(value || '').trim()。"""
    return _s(value).strip()


def _normalized_name(value: Any) -> str:
    """JS ``normalizedName``：normalizedText 后 toLocaleLowerCase('zh-CN')。"""
    return _normalized_text(value).lower()


def _js_number(value: Any) -> float:
    """JS ``Number(value)`` 的宽松语义：空串/空白 → 0，None/undefined → 0。

    :param value: 任意输入。
    :returns: 数值；无法解析时返回 NaN（与 JS Number 一致）。
    """
    if value is None or value is False:
        return 0.0
    if value is True:
        return 1.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return float("nan")


def _normalized_version_no(value: Any) -> int | None:
    """JS ``normalizedVersionNo``：Number 后正整数才收，否则 None。"""
    parsed = _js_number(value)
    if parsed != parsed:  # NaN
        return None
    return int(parsed) if parsed == int(parsed) and parsed > 0 else None


def _parse_id(value: Any) -> int:
    """Node ``parseId``：Number 有限且 > 0 → int，否则 0。"""
    parsed = _js_number(value)
    return int(parsed) if parsed == parsed and parsed > 0 else 0


def _escape_reg_exp(value: Any) -> str:
    """JS ``escapeRegExp``：转义正则元字符（与 Node 字符集一致）。"""
    return re.sub(r"[.*+?^${}()|[\]\\]", lambda m: "\\" + m.group(0), _s(value))


def _pick(row: dict[str, Any], *keys: str) -> Any:
    """JS ``a ?? b`` 双取值：返回第一个非 None 的键值。"""
    for key in keys:
        if row.get(key) is not None:
            return row[key]
    return None


def _json_object(value: Any) -> Any:
    """JS ``parseContinuityContract`` 的对象解析：dict 原样返回，str 尝试 JSON。"""
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(_s(value))
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# voice-profiles.mjs：normalizeCharacterAgeGroup / normalizeCharacterGender /
# inferCharacterVoiceTraits（frame_character 依赖的最小子集）。
# ---------------------------------------------------------------------------


def normalize_character_age_group(value: Any) -> str | None:
    """JS ``normalizeCharacterAgeGroup``：小写后命中五档返回原值，否则 None。"""
    normalized = _s(value).strip().lower()
    return normalized if normalized in AGE_GROUP_ORDER else None


def normalize_character_gender(value: Any) -> str | None:
    """JS ``normalizeCharacterGender``：male/female/neutral 之外返回 None。"""
    normalized = _s(value).strip().lower()
    return normalized if normalized in {"male", "female", "neutral"} else None


def _chinese_number_to_int(value: Any) -> int:
    """JS ``chineseNumberToInt``：中文数字（含「两」「十」组合）转 int。

    :param value: 含中文数字的文本（仅取其中字符逐一映射）。
    :returns: 解析出的整数；未知字符按 0 计（与 Node reduce 语义一致）。
    """
    digits = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    text = _s(value)
    if not text:
        return 0
    if text == "十":
        return 10
    ten_index = text.find("十")
    if ten_index >= 0:
        tens = 1 if ten_index == 0 else digits.get(text[ten_index - 1], 0)
        ones = 0 if ten_index == len(text) - 1 else digits.get(text[ten_index + 1], 0)
        return tens * 10 + ones
    total = 0
    for char in text:
        total = total * 10 + digits.get(char, 0)
    return total


def _age_group_from_age(age: float) -> str | None:
    """JS ``ageGroupFromAge``：数值年龄 → 年龄段档位（≤0 返回 None）。"""
    if age != age or not (age > 0):  # NaN 或 <= 0
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


_INFER_AGE_RANGE_PATTERN = re.compile(r"(\d{1,2})\s*(?:至|到|[-~—])\s*(\d{1,2})\s*岁", re.A)
_INFER_AGE_PATTERN = re.compile(r"(\d{1,2})\s*岁", re.A)
_INFER_CHINESE_AGE_PATTERN = re.compile(r"(?<![轻差小前后到至])([零一二两三四五六七八九十]{1,3})\s*岁")
_INFER_AGE_KEYWORDS: tuple[tuple[str, str], ...] = (
    ("女童|男童|小女孩|小男孩|儿童|孩童|幼年", "child"),
    ("十几岁|少年|少女|中学生", "teen"),
    ("老年|老人|老者|长者|爷爷|奶奶|六十|七十|八十", "senior"),
    ("中年|四十|五十|成熟管理者|父亲|母亲", "middle_aged"),
    ("青年|年轻|二十|三十", "young_adult"),
)


def _infer_age_group(text: Any) -> str | None:
    """JS ``inferAgeGroup``：数字/中文数字年龄 → 档位；关键词兜底。"""
    source = _s(text)
    match = _INFER_AGE_RANGE_PATTERN.search(source)
    if match:
        return _age_group_from_age((float(match.group(1)) + float(match.group(2))) / 2)
    match = _INFER_AGE_PATTERN.search(source)
    if match:
        return _age_group_from_age(float(match.group(1)))
    match = _INFER_CHINESE_AGE_PATTERN.search(source)
    if match:
        return _age_group_from_age(_chinese_number_to_int(match.group(1)))
    for pattern, group in _INFER_AGE_KEYWORDS:
        if re.search(pattern, source):
            return group
    return None


_INFER_GENDER_FEMALE = r"女性|女人|女声|女孩|女童|少女|姐姐|妹妹|母亲|妻子|奶奶|御姐"
_INFER_GENDER_MALE = r"男性|男人|男声|男孩|男童|少年|哥哥|弟弟|父亲|丈夫|爷爷|老者"
_INFER_GENDER_NEUTRAL = r"系统|终端|机械|无实体|中性"


def _infer_gender(text: Any) -> str | None:
    """JS ``inferGender``：文本关键词 → male/female/neutral；无命中 None。"""
    source = _s(text)
    if re.search(_INFER_GENDER_FEMALE, source):
        return "female"
    if re.search(_INFER_GENDER_MALE, source):
        return "male"
    if re.search(_INFER_GENDER_NEUTRAL, source):
        return "neutral"
    return None


_VOICE_STYLE_RULES: tuple[tuple[str, str], ...] = (
    ("沉稳", r"沉稳|稳重|厚重"),
    ("低沉", r"低沉|压低|深沉"),
    ("权威", r"权威|管理|主管|监管|官署|领导"),
    ("压迫", r"压迫|审讯|冷酷|反派"),
    ("克制", r"克制|收束|节制"),
    ("冷静", r"冷静|冷淡|理性|稳定"),
    ("温柔", r"温柔|舒缓|柔和"),
    ("亲切", r"亲切|友善|温暖"),
    ("活力", r"活力|活泼|阳光|朝气"),
    ("沧桑", r"沧桑|疲惫|阅历|风霜"),
    ("沙哑", r"沙哑|烟嗓|粗粝"),
    ("慈和", r"慈和|慈祥|和蔼|长辈"),
    ("长者", r"长者|老人|老年|老者|大爷|奶奶|婆婆"),
    ("从容", r"从容|不疾不徐|沉静"),
    ("童真", r"童真|童年|小女孩|小男孩|儿童"),
    ("系统", r"系统|终端|机械|播报|无实体"),
)


def infer_character_voice_traits(character: dict[str, Any] | None = None) -> dict[str, Any]:
    """JS ``inferCharacterVoiceTraits``：从角色文本推断音色需求（frame 侧只用 gender/ageGroup）。

    :param character: 角色行（DB snake_case 或 camelCase 别名）。
    :returns: ``{"ageGroup", "gender", "styleTags", "inferredAge", "inferredGender"}``。
    """
    character = character or {}
    identity_source = "\n".join(
        str(part) for part in (character.get("name"), _pick(character, "role_tag", "roleTag")) if part
    )
    source = "\n".join(
        str(part)
        for part in (
            character.get("name"),
            _pick(character, "role_tag", "roleTag"),
            character.get("appearance"),
            character.get("personality"),
            _pick(character, "voice_style", "voiceStyle"),
        )
        if part
    )
    explicit_age = normalize_character_age_group(_pick(character, "age_group", "ageGroup"))
    explicit_gender = normalize_character_gender(character.get("gender"))
    style_tags = [tag for tag, pattern in _VOICE_STYLE_RULES if re.search(pattern, source)]
    return {
        "ageGroup": explicit_age or _infer_age_group(source),
        "gender": explicit_gender or _infer_gender(identity_source) or _infer_gender(source),
        "styleTags": style_tags,
        "inferredAge": explicit_age is None,
        "inferredGender": explicit_gender is None,
    }


# ---------------------------------------------------------------------------
# frame-character-consistency.mjs 主体。
# ---------------------------------------------------------------------------


def infer_identity_gender(character: dict[str, Any]) -> str | None:
    """JS ``inferIdentityGender``：姓名/角色标签关键词 → 性别（未命中 None）。"""
    name = _normalized_text(character.get("name"))
    role = _normalized_text(_pick(character, "role_tag", "roleTag"))
    male_pattern = r"男性|男人|男主|男配|男孩|男童|少年|哥哥|弟弟|父亲|丈夫|爷爷|老者|男声|监护男性"
    female_pattern = r"女性|女人|女主|女配|女孩|女童|少女|姐姐|妹妹|母亲|妻子|奶奶|女声|监护女性"
    neutral_pattern = r"系统|终端|机械|无实体|中性"
    if re.search(male_pattern, name):
        return "male"
    if re.search(female_pattern, name):
        return "female"
    if re.search(neutral_pattern, name):
        return "neutral"
    if re.search(r"父亲|丈夫|爷爷|哥哥|弟弟|男主|男配|男声|监护男性", role):
        return "male"
    if re.search(r"母亲|妻子|奶奶|姐姐|妹妹|女主|女配|女声|监护女性", role):
        return "female"
    if re.search(neutral_pattern, role):
        return "neutral"
    return None


def is_audio_only_identity(character: dict[str, Any]) -> bool:
    """JS ``isAudioOnlyIdentity``：姓名/角色标签/外貌命中纯音频身份词表。"""
    identity_text = "\n".join(
        str(part)
        for part in (
            character.get("name"),
            _pick(character, "role_tag", "roleTag"),
            character.get("appearance"),
        )
        if part
    )
    return bool(
        AUDIO_ONLY_IDENTITY_PATTERN.search(identity_text)
        or AUDIO_ONLY_IDENTITY_HINT_PATTERN.search(identity_text)
    )


def visual_source_for(storyboard: dict[str, Any]) -> str:
    """JS ``visualSourceFor``：action_text + visual_prompt 以换行拼接（过滤空值）。"""
    return "\n".join(
        part
        for part in (
            _pick(storyboard, "action_text", "actionText"),
            _pick(storyboard, "visual_prompt", "visualPrompt"),
        )
        if part
    )


def _sanitize_hand_only_text(value: Any) -> str:
    """JS ``sanitizeHandOnlyText``：离职协议文案替换为空白法律文件。"""
    return re.sub(r"《?离职及保密协议》?", "空白法律文件", _s(value))


def _sanitize_hand_only_environment_text(value: Any) -> str:
    """JS ``sanitizeHandOnlyEnvironmentText``：办公环境词替换为光影描述。"""
    text = re.sub(r"办公室(?:夜景|环境|背景)?", "冷色桌面光影", _s(value))
    text = re.sub(r"电脑蓝光", "冷色轮廓光", text)
    return re.sub(r"办公桌背景", "浅景深背景", text)


def is_hand_only_shot(storyboard: dict[str, Any] | None = None) -> bool:
    """JS ``isHandOnlyShot``：视觉源命中「只/仅 … 手/手部」特写模式。"""
    return bool(
        re.search(r"(?:只|仅)[^。\n；;]*(?:拍|保留|呈现|展示)?[^。\n；;]*(?:手|手部)", visual_source_for(storyboard or {}))
    )


def _is_visual_mention(character_name: str, source: str) -> bool:
    """JS ``isVisualMention``：分句包含角色名且未被屏幕/音频上下文排除。"""
    name = _normalized_name(character_name)
    if not name or name not in source:
        return False
    segments = [segment for segment in re.split(r"[。！？；\n]", source) if name in segment]
    return any(
        not re.search(r"(?:屏幕|手机|邮件|短信|通知|发件人|文字|字幕|显示|标注)[^。！？；\n]{0,30}", segment)
        and not re.search(r"(?:语音|声音|画外音|广播|视频内容|录音)[^。！？；\n]{0,30}", segment)
        for segment in segments
    )


def parse_continuity_contract(storyboard: dict[str, Any]) -> dict[str, Any] | None:
    """JS ``parseContinuityContract``：continuity_contract_json 字段 → dict 或 None。"""
    raw = _pick(storyboard, "continuity_contract_json", "continuityContract")
    return _json_object(raw)


def build_shot_entity_boundary_prompt(storyboard: dict[str, Any]) -> dict[str, str]:
    """JS ``buildShotEntityBoundaryPrompt``：从连续性契约构建实体边界提示与负向词。

    :param storyboard: 分镜行（可含 continuity_contract_json）。
    :returns: ``{"prompt", "negativePrompt"}``（无契约时均为空串）。
    """
    contract = parse_continuity_contract(storyboard)
    if not contract:
        return {"prompt": "", "negativePrompt": ""}

    source = visual_source_for(storyboard)
    hand_only = bool(re.search(r"只拍[^。\n；;]*(?:手|手部)|仅[^。\n；;]*(?:手|手部)", source))
    raw_visible = contract.get("visibleEntities")
    visible_entities = (
        [_normalized_text(item) for item in raw_visible]
        if isinstance(raw_visible, list)
        else []
    )
    if hand_only:
        visible_entities = [_sanitize_hand_only_text(item) for item in visible_entities]
    visible_entities = [item for item in visible_entities if item]
    raw_forbidden = contract.get("forbiddenEntities")
    forbidden_entities = (
        [_normalized_text(item) for item in raw_forbidden if _normalized_text(item)]
        if isinstance(raw_forbidden, list)
        else []
    )
    primary_subject = _normalized_text(contract.get("primarySubject"))
    primary_action = _normalized_text(contract.get("primaryAction"))
    parts = [
        "【画面实体边界】",
        f"本镜头只允许出现：{'、'.join(dict.fromkeys(visible_entities))}。" if visible_entities else "",
        f"本镜头禁止出现：{'、'.join(dict.fromkeys(forbidden_entities))}。" if forbidden_entities else "",
        (
            f"本镜头唯一视觉主体：{_sanitize_hand_only_text(primary_subject) if hand_only else primary_subject}。"
            if primary_subject
            else ""
        ),
        (
            f"只完成一个主动作：{_sanitize_hand_only_text(primary_action) if hand_only else primary_action}。"
            if primary_action
            else ""
        ),
        "这是手部与道具特写；角色只允许以明确的手部局部出现，不得出现角色的脸、头部、完整上半身或其他人物的手。"
        if hand_only
        else "",
        "不得因为角色绑定或参考图而自动补出未声明的人物、肢体、道具、屏幕文字或场景元素。",
    ]

    negative = [*forbidden_entities]
    if hand_only:
        negative.append("角色脸部、头部、完整上半身、其他人物的手、人物半身")
    return {
        "prompt": "\n".join(part for part in parts if part),
        "negativePrompt": ", ".join(item for item in negative if item),
    }


def _explicitly_keeps_audio_offscreen(segment: str, name: str) -> bool:
    """JS ``explicitlyKeepsAudioOffscreen``：显式画外音/不出现人物指令判定。"""
    if EXPLICIT_OFFSCREEN_PATTERN.search(segment):
        return True
    if not name:
        return False
    escaped = _escape_reg_exp(name)
    return bool(
        re.search(
            rf"(?:画面|镜头)(?:中|内|里)?(?:明确)?(?:不|没有|无)(?:会)?(?:出现|呈现|展示|包含)?(?:任何)?(?:实体)?{escaped}",
            _normalized_name(segment),
            re.I,
        )
    )


def _has_explicit_offscreen_instruction(character: dict[str, Any], storyboard: dict[str, Any]) -> bool:
    """JS ``hasExplicitOffscreenInstruction``：任一含角色名的分句显式画外音。"""
    name = _normalized_name(character.get("name"))
    return any(
        (not name or name in _normalized_name(segment)) and _explicitly_keeps_audio_offscreen(segment, name)
        for segment in re.split(r"[。！？；\n]", visual_source_for(storyboard))
    )


def is_visually_present(character: dict[str, Any], storyboard: dict[str, Any]) -> bool:
    """JS ``isVisuallyPresent``：非纯音频角色恒 True；音频角色需分句出现可视词。"""
    if not is_audio_only_identity(character):
        return True
    source = visual_source_for(storyboard)
    name = _normalized_name(character.get("name"))
    visible_segments = [
        segment
        for segment in re.split(r"[。！？；\n]", source)
        if name in _normalized_name(segment) and not _explicitly_keeps_audio_offscreen(segment, name)
    ]
    return any(VISUAL_PRESENCE_PATTERN.search(segment) for segment in visible_segments)


def infer_visual_traits(character: dict[str, Any]) -> dict[str, Any]:
    """JS ``inferVisualTraits``：显式字段优先，其次身份推断，最后文本推断。"""
    inferred = infer_character_voice_traits(character)
    explicit_gender = normalize_character_gender(character.get("gender"))
    explicit_age_group = normalize_character_age_group(_pick(character, "age_group", "ageGroup"))
    identity_gender = infer_identity_gender(character)
    return {
        "gender": explicit_gender or identity_gender or inferred["gender"] or None,
        "ageGroup": explicit_age_group or inferred["ageGroup"] or None,
        "inferredGender": explicit_gender is None and bool(identity_gender or inferred["gender"]),
        "inferredAge": explicit_age_group is None and bool(inferred["ageGroup"]),
    }


def _role_candidates(label: Any, characters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """JS ``roleCandidates``：按「主角/配角」标签与性别从角色库筛候选。"""
    normalized_label = _normalized_name(label)
    if not normalized_label:
        return []
    requested_gender = None
    if re.search(r"女主|女配", normalized_label):
        requested_gender = "female"
    elif re.search(r"男主|男配", normalized_label):
        requested_gender = "male"
    if re.search(r"主角|主人公|女主|男主", normalized_label):
        role_keyword = r"主角|主人公|女主|男主"
    elif re.search(r"配角|女配|男配", normalized_label):
        role_keyword = r"配角|女配|男配"
    else:
        return []
    matched: list[dict[str, Any]] = []
    for character in characters:
        role = _normalized_text(_pick(character, "role_tag", "roleTag"))
        if not re.search(role_keyword, role):
            continue
        if requested_gender and infer_visual_traits(character)["gender"] != requested_gender:
            continue
        matched.append(character)
    return matched


def _resolve_primary_character(
    storyboard: dict[str, Any], characters: list[dict[str, Any]]
) -> dict[str, Any]:
    """JS ``resolvePrimaryCharacter``：绑定 id → 精确名 → 角色标签 → 部分匹配。

    :param storyboard: 分镜行（character_id / character_name）。
    :param characters: 可用角色行列表。
    :returns: ``{"character": 行或 None, "blocker": 文案或 None}``。
    """
    # JS: Number(character_id ?? characterId) || 0 —— NaN/0 归零，负数保持真值。
    raw_bound = _js_number(_pick(storyboard, "character_id", "characterId"))
    bound_id = raw_bound if (raw_bound == raw_bound and raw_bound != 0) else 0
    if bound_id:
        bound = next((c for c in characters if _js_number(c.get("id")) == bound_id), None)
        if bound:
            return {"character": bound, "blocker": None}
        return {"character": None, "blocker": "分镜绑定的角色已不存在，请返回分镜编辑器重新选择角色"}

    label = _normalized_text(_pick(storyboard, "character_name", "characterName"))
    if not label or CHARACTER_FREE_PATTERN.match(label):
        return {"character": None, "blocker": None}
    exact = [c for c in characters if _normalized_name(c.get("name")) == _normalized_name(label)]
    if len(exact) == 1:
        return {"character": exact[0], "blocker": None}

    by_role = _role_candidates(label, characters)
    if len(by_role) == 1:
        return {"character": by_role[0], "blocker": None}
    if len(by_role) > 1:
        return {
            "character": None,
            "blocker": f"分镜角色“{label}”对应多个角色，请在分镜编辑器中选择准确姓名",
        }

    partial = [
        c
        for c in characters
        if (name := _normalized_name(c.get("name")))
        and (name in _normalized_name(label) or _normalized_name(label) in name)
    ]
    if len(partial) == 1:
        return {"character": partial[0], "blocker": None}
    return {
        "character": None,
        "blocker": f"分镜角色“{label}”无法匹配角色库，请先在分镜编辑器中绑定真实角色",
    }


def _is_viewpoint_only_mention(character: dict[str, Any], storyboard: dict[str, Any]) -> bool:
    """JS ``isViewpointOnlyMention``：动作文本只以「…视线/视角中」提及该角色。"""
    name = _normalized_name(character.get("name"))
    if not name:
        return False
    action_text = _normalized_name(_pick(storyboard, "action_text", "actionText"))
    visual_prompt = _normalized_name(_pick(storyboard, "visual_prompt", "visualPrompt"))
    if name not in action_text or name in visual_prompt:
        return False
    escaped = _escape_reg_exp(name)
    return bool(
        re.search(rf"{escaped}(?:的)?(?:视线|视角|眼中|所见|主观镜头)(?:中|里|内)?", action_text, re.I)
    )


def _mentioned_characters(
    storyboard: dict[str, Any], characters: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """JS ``mentionedCharacters``：视觉源中被真实提及且在场的角色列表。"""
    visual_source = "\n".join(
        str(part)
        for part in (
            _pick(storyboard, "character_name", "characterName"),
            _pick(storyboard, "action_text", "actionText"),
            _pick(storyboard, "visual_prompt", "visualPrompt"),
        )
        if part
    ).lower()
    matched = []
    for character in characters:
        name = _normalized_name(character.get("name"))
        if (
            name
            and _is_visual_mention(name, visual_source)
            and not _is_viewpoint_only_mention(character, storyboard)
            and is_visually_present(character, storyboard)
        ):
            matched.append(character)
    return matched


def _character_constraint(character: dict[str, Any], primary_character_id: int | None) -> dict[str, Any]:
    """JS ``characterConstraint``：单角色约束 DTO（字段顺序与 Node 一致）。"""
    traits = infer_visual_traits(character)
    reference_image_storage_key = (
        _normalized_text(_pick(character, "reference_image_storage_key", "referenceImageStorageKey")) or None
    )
    reference_image_url = _normalized_text(_pick(character, "reference_image_url", "referenceImageUrl")) or None
    character_id = int(_js_number(character.get("id")))
    # JS: Number(character.id) === Number(primaryCharacterId) —— null 时 Number(null)=0。
    is_primary = character_id == (primary_character_id if primary_character_id is not None else 0)
    return {
        "characterId": character_id,
        "characterVersionNo": _normalized_version_no(
            _pick(character, "character_version_no", "characterVersionNo")
        ),
        "name": _normalized_text(character.get("name")),
        "roleTag": _normalized_text(_pick(character, "role_tag", "roleTag")) or None,
        "gender": traits["gender"],
        "genderLabel": GENDER_LABELS.get(traits["gender"] or "", "未明确"),
        "ageGroup": traits["ageGroup"],
        "ageGroupLabel": AGE_GROUP_LABELS.get(traits["ageGroup"] or "", "未明确"),
        "appearance": _normalized_text(character.get("appearance")) or None,
        "costume": _normalized_text(character.get("costume")) or None,
        "personality": _normalized_text(character.get("personality")) or None,
        "referenceImageStorageKey": reference_image_storage_key,
        "referenceImageUrl": reference_image_url,
        "hasReferenceImage": bool(reference_image_storage_key or reference_image_url),
        "isPrimary": is_primary,
        "inferredGender": traits["inferredGender"],
        "inferredAge": traits["inferredAge"],
    }


def _hand_only_costume(character: dict[str, Any]) -> str:
    """JS ``handOnlyCostume``：手部特写镜头只保留袖口/腕表类服装词。"""
    costume = _normalized_text(character.get("costume") if character else None)
    normalized = re.sub(r"和(?=[^、，；;。]*(?:裤|鞋|靴|袜))", "、", costume)
    allowed = [
        item.strip()
        for item in re.split(r"[、,，；;。]", normalized)
        if re.search(r"衬衫|外套|袖口|腕表|手表|手链|戒指|手套", item.strip())
    ]
    return "、".join(dict.fromkeys(allowed)) or "中性色袖口与腕表"


def _unique_characters(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """JS ``uniqueCharacters``：按数值 id 去重（保持首现顺序；id 无效剔除）。"""
    seen: set[float] = set()
    unique: list[dict[str, Any]] = []
    for item in items:
        raw = _js_number(item.get("id"))
        if raw != raw or raw == 0 or raw in seen:  # NaN 或 0 视为无效
            continue
        seen.add(raw)
        unique.append(item)
    return unique


def resolve_frame_character_context(
    storyboard: dict[str, Any] | None = None, characters: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """JS ``resolveFrameCharacterContext`` 的 Python 复刻（主入口）。

    解析分镜的角色绑定，生成一致性约束上下文；``ready=False`` 时 blockers
    给出需修正的文案（与 Node 逐字一致）。

    :param storyboard: 分镜行（DB 行或 camelCase 别名）。
    :param characters: 项目角色行列表（DB 行）。
    :returns: ``{"ready", "characterFree", "primaryCharacterId", "characters",
        "blockers", "warnings"}``（键顺序与 Node 返回一致）。
    """
    storyboard = storyboard or {}
    characters = characters or []
    available_characters = [c for c in characters if c and c.get("id") and c.get("name")]
    resolved_primary = _resolve_primary_character(storyboard, available_characters)
    primary_character = resolved_primary["character"]
    blocker = resolved_primary["blocker"]
    offscreen_audio_identity = False
    label = _normalized_text(_pick(storyboard, "character_name", "characterName"))
    mentioned = _mentioned_characters(storyboard, available_characters)
    if primary_character and not is_visually_present(primary_character, storyboard):
        audio_only_identity = is_audio_only_identity(primary_character)
        explicitly_offscreen = _has_explicit_offscreen_instruction(primary_character, storyboard)
        offscreen_audio_identity = audio_only_identity
        if (
            audio_only_identity
            and not explicitly_offscreen
            and VISUAL_PRESENCE_PATTERN.search(visual_source_for(storyboard))
        ):
            blocker = (
                f"声音角色“{primary_character.get('name')}”的镜头出现了可见人物，"
                "但画面描述没有明确点名；请确认其是否实体出镜并写入准确姓名"
            )
        else:
            blocker = None
        primary_character = None
    if not primary_character and len(mentioned) == 1:
        primary_character = mentioned[0]
        blocker = None
    resolved_characters = _unique_characters(
        [*([primary_character] if primary_character else []), *mentioned]
    )
    primary_id = int(_js_number(primary_character.get("id"))) if primary_character else None
    constraints = [_character_constraint(character, primary_id) for character in resolved_characters]
    blockers = [blocker] if blocker else []
    warnings: list[str] = []
    visual_source = visual_source_for(storyboard)
    character_free = (
        not blocker
        and not constraints
        and (offscreen_audio_identity or not HUMAN_SUBJECT_PATTERN.search(visual_source))
    )

    if not blocker and not constraints and not character_free:
        blockers.append("当前分镜包含人物，但没有绑定到角色库，请先在分镜编辑器中选择真实角色")

    for character in constraints:
        if not character["gender"]:
            blockers.append(f"角色“{character['name']}”缺少明确性别，请先在角色详情中补全")
        if not character["ageGroup"]:
            blockers.append(f"角色“{character['name']}”缺少年龄段，请先在角色详情中补全")
        if not character["appearance"]:
            blockers.append(f"角色“{character['name']}”缺少固定外貌设定，请先在角色详情中补全")
        if not character["hasReferenceImage"]:
            blockers.append(f"角色“{character['name']}”尚未确认定妆图，请先生成并确认角色定妆图")

    return {
        "ready": not blockers,
        "characterFree": character_free,
        "primaryCharacterId": int(_js_number(primary_character.get("id"))) if primary_character else None,
        "characters": constraints,
        "blockers": blockers,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _character_gender_rule(character: dict[str, Any]) -> str:
    """JS ``characterGenderRule``：一致性提示词里的性别硬约束文案。"""
    if character["gender"] == "female":
        return "必须呈现为女性，禁止替换成男性或男性化主体"
    if character["gender"] == "male":
        return "必须呈现为男性，禁止替换成女性或女性化主体"
    if character["gender"] == "neutral":
        return "保持中性或无实体设定，不得擅自改成人类男性或女性"
    return "不得擅自改变角色身份"


def _gender_negative_terms(characters: list[dict[str, Any]]) -> list[str]:
    """JS ``genderNegativeTerms``：负向提示词中的性别替换禁用词。"""
    terms: list[str] = []
    if any(item["gender"] == "female" for item in characters):
        terms.extend(
            [
                "male protagonist",
                "man replacing female character",
                "gender swap",
                "男性主角替代女主角",
                "把女性画成男性",
            ]
        )
    if any(item["gender"] == "male" for item in characters):
        terms.extend(
            [
                "female protagonist replacing male character",
                "gender swap",
                "女性主角替代男主角",
                "把男性画成女性",
            ]
        )
    return terms


def build_frame_consistency_prompt(
    *,
    prompt: Any = None,
    negative_prompt: Any = None,
    storyboard: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
    project_visual_style: Any = None,
) -> dict[str, Any]:
    """JS ``buildFrameConsistencyPrompt`` 的 Python 复刻。

    组装静帧生成的一致性提示词：基础提示 + 镜头动作 + 镜头要求 + 项目风格 +
    角色一致性硬约束 + 手部特写锁定 + 实体边界；负向词合并性别与一致性禁用词。

    :param prompt: 外部提示词覆盖（优先于 visual_prompt）。
    :param negative_prompt: 外部负向词。
    :param storyboard: 分镜行。
    :param context: 已解析的 frameCharacterContext；缺省时按空角色库解析。
    :param project_visual_style: 项目固定视觉风格。
    :returns: ``{"prompt", "negativePrompt", "referenceImageStorageKeys",
        "referenceImageUrls"}``。
    """
    storyboard = storyboard or {}
    safe_context = context or resolve_frame_character_context(storyboard, [])
    hand_only = is_hand_only_shot(storyboard)
    raw_base_prompt = _normalized_text(prompt or _pick(storyboard, "visual_prompt", "visualPrompt"))
    base_prompt = (
        re.sub(r"屏幕文字必须为简体中文且只出现这一句[。.]?", "", (
            re.sub(r"手机屏幕(?:清楚)?显示[“\"][^”\"]+[”\"][，,]?\s*", "", _sanitize_hand_only_environment_text(
                _sanitize_hand_only_text(raw_base_prompt)
            ))
        )).strip()
        if hand_only
        else raw_base_prompt
    )
    reference_characters = [
        character
        for character in safe_context["characters"]
        if (character.get("referenceImageUrl") or character.get("referenceImageStorageKey"))
        and not is_hand_only_shot(storyboard)
    ][:3]
    reference_order = {character["characterId"]: index + 1 for index, character in enumerate(reference_characters)}
    character_lines = []
    for index, character in enumerate(safe_context["characters"]):
        if hand_only:
            character_lines.append(
                "；".join(
                    part
                    for part in (
                        f"{index + 1}. {character['name']}（仅局部手部身份）",
                        f"只保留袖口与腕表：{_hand_only_costume({'costume': character.get('costume')})}",
                        "不描绘脸、头部、发型、年龄、完整身体或人物半身，不使用人物参考图。",
                    )
                    if part
                )
            )
            continue
        character_lines.append(
            "；".join(
                part
                for part in (
                    f"{index + 1}. {character['name']}{'（主要主体）' if character['isPrimary'] else '（同框角色）'}",
                    f"角色版本=v{character['characterVersionNo']}" if character["characterVersionNo"] else "",
                    f"性别={character['genderLabel']}，{_character_gender_rule(character)}",
                    f"年龄={character['ageGroupLabel']}",
                    f"身份={character['roleTag']}" if character["roleTag"] else "",
                    f"固定外貌={character['appearance']}" if character["appearance"] else "",
                    f"固定服装与随身物件={character['costume']}" if character["costume"] else "",
                    (
                        f"定妆参考图序号={reference_order[character['characterId']]}，"
                        "这是该角色唯一身份参考；脸型、五官比例、发型、体态、服装和随身物件必须严格以参考图为准"
                        if character["characterId"] in reference_order
                        else ""
                    ),
                )
                if part
            )
        )
    shot_type = _normalized_text(_pick(storyboard, "shot_type", "shotType"))
    camera_angle = _normalized_text(_pick(storyboard, "camera_angle", "cameraAngle"))
    composition = _normalized_text(storyboard.get("composition"))
    action_text = _normalized_text(_pick(storyboard, "action_text", "actionText"))
    prompt_parts = [
        base_prompt,
        f"镜头动作：{_sanitize_hand_only_text(action_text) if hand_only else action_text}" if action_text else "",
        (
            f"镜头要求：{'，'.join(part for part in (shot_type, camera_angle, composition) if part)}"
            if any(part for part in (shot_type, camera_angle, composition))
            else ""
        ),
        (
            f"项目固定视觉风格：{_sanitize_hand_only_environment_text(_normalized_text(project_visual_style)) if hand_only else _normalized_text(project_visual_style)}"
            if project_visual_style
            else ""
        ),
        f"【角色一致性硬约束】\n{chr(10).join(character_lines)}" if character_lines else "",
        (
            "必须保持以上角色同一张脸、同一脸型、同一五官比例、同一发型、同一体态、同一固定服装和同一随身物件；"
            "不得改变姓名对应关系、性别、年龄层、脸部、发型、体态或固定服装；不得换脸，不得年轻化或老化，"
            "不得用其他人物替代主要主体；每张定妆参考图只用于对应序号的角色。"
            if character_lines and not hand_only
            else ""
        ),
        (
            "这是局部手部与道具镜头，手机屏幕保持留白，模型不要生成任何屏幕文字；手机和协议上的准确中文由后期叠加。"
            if hand_only
            else ""
        ),
        (
            "【手部静物构图锁定】局部手部静物特写，前臂只能从画面边缘进入并在手腕处裁切；不出现躯干、胸口、肩膀、"
            "头部或人物半身。背景只保留不可辨认的浅景深色块，不出现可识别的办公室、显示器、键盘、台灯、灯具、指示灯"
            "或支架。所有文件和屏幕保持无文字留白，禁止生成任何汉字、英文、数字或乱码。"
            if hand_only
            else ""
        ),
    ]
    negative_terms = [_normalized_text(negative_prompt), *_gender_negative_terms(safe_context["characters"])]
    if character_lines:
        negative_terms.extend(
            [
                "wrong character identity",
                "inconsistent face",
                "inconsistent age",
                "inconsistent costume",
                "duplicate main character",
                "换脸",
                "五官不一致",
                "脸型变化",
                "发型变化",
                "服装变化",
                "年龄变化",
                "体态不一致",
            ]
        )
        if hand_only:
            negative_terms.extend(
                [
                    "躯干", "胸口", "肩膀", "人物半身", "办公室背景", "显示器", "电脑", "键盘", "台灯",
                    "灯具", "指示灯", "支架", "文字", "汉字", "英文", "数字", "乱码",
                ]
            )
    entity_boundary = build_shot_entity_boundary_prompt(storyboard)
    merged_negative = list(dict.fromkeys([item for item in negative_terms if item] + [entity_boundary["negativePrompt"] for item in [entity_boundary["negativePrompt"]] if item]))
    return {
        "prompt": "\n".join(part for part in [*prompt_parts, entity_boundary["prompt"]] if part),
        "negativePrompt": ", ".join(item for item in merged_negative if item),
        "referenceImageStorageKeys": [
            character["referenceImageStorageKey"]
            for character in reference_characters
            if character.get("referenceImageStorageKey")
        ],
        "referenceImageUrls": [
            character["referenceImageUrl"]
            for character in reference_characters
            if not character.get("referenceImageStorageKey") and character.get("referenceImageUrl")
        ],
    }


def create_frame_character_snapshot(context: dict[str, Any] | None) -> dict[str, Any]:
    """JS ``createFrameCharacterSnapshot``：任务快照 DTO（写入 generation_jobs）。"""
    context = context or {}
    characters = []
    for character in context.get("characters") or []:
        entry: dict[str, Any] = {
            "characterId": character.get("characterId"),
            "characterVersionNo": character.get("characterVersionNo"),
            "name": character.get("name"),
            "roleTag": character.get("roleTag"),
            "gender": character.get("gender"),
            "genderLabel": character.get("genderLabel"),
            "ageGroup": character.get("ageGroup"),
            "ageGroupLabel": character.get("ageGroupLabel"),
            "appearance": character.get("appearance"),
            "costume": character.get("costume"),
        }
        if character.get("referenceImageStorageKey"):
            entry["referenceImageStorageKey"] = character["referenceImageStorageKey"]
        else:
            entry["referenceImageUrl"] = character.get("referenceImageUrl")
        entry.update(
            {
                "isPrimary": character.get("isPrimary"),
                "inferredGender": character.get("inferredGender"),
                "inferredAge": character.get("inferredAge"),
            }
        )
        characters.append(entry)
    return {
        "version": 1,
        "primaryCharacterId": context.get("primaryCharacterId") or None,
        "characterFree": bool(context.get("characterFree")),
        "characters": characters,
    }
