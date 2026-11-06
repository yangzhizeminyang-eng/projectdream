"""故事设定 / 分集大纲归一化与质量门禁（任务 C）。

逐行为复刻 Node ``server/services/story-quality.mjs`` 与
``server/services/story-market-quality.mjs``：normalizeStoryBibleInput、
evaluateStoryBible、normalizeSeasonStructureInput、evaluateSeasonStructure、
evaluateMarketEpisodeQuality、evaluateMarketSeasonQuality。
报告结构（blockers/warnings/dimensions/score/canLock）供 API 响应 `report` 字段
与持久化 quality_report_json 使用，字段文案与 Node 逐字一致。
"""

from __future__ import annotations

import re
from typing import Any

_BIBLE_REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("title", "故事标题"),
    ("logline", "一句话卖点"),
    ("audience", "目标受众"),
    ("emotionalPromise", "情绪承诺"),
    ("worldRules", "世界观规则"),
    ("timeline", "时间线"),
    ("locations", "地点与空间"),
    ("characters", "人物档案"),
    ("relationships", "人物关系"),
    ("mainPlot", "主线"),
    ("foreshadowing", "伏笔计划"),
    ("lockedFacts", "禁止改变的事实"),
)

_CHARACTER_REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("name", "姓名"),
    ("role", "角色定位"),
    ("goal", "目标"),
    ("fear", "恐惧"),
    ("secret", "秘密"),
    ("growthArc", "成长弧"),
    ("visualDescription", "视觉描述"),
)

_EPISODE_REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("title", "集标题"),
    ("logline", "一句话卖点"),
    ("openingHook", "开场钩子"),
    ("goal", "本集目标"),
    ("coreConflict", "核心冲突"),
    ("irreversibleChange", "不可逆变化"),
    ("endingHook", "结尾钩子"),
    ("protagonistChoice", "主角主动选择"),
)

_BIBLE_SCORE_RULES: tuple[tuple[str, str, int], ...] = (
    ("logline", "核心卖点", 15),
    ("characters", "人物动机与成长", 20),
    ("mainPlot", "主线冲突", 15),
    ("worldRules", "世界观约束", 10),
    ("timeline", "时间线连续性基础", 10),
    ("relationships", "人物关系", 10),
    ("foreshadowing", "伏笔可回收性基础", 10),
    ("visualSymbols", "视觉可视化基础", 10),
)

_GENERIC_TEXT = re.compile(r"^(故事开始了|这一集结束了|主角继续调查|事情发生了|等待事情发生)[。.!！?？\s]*$", re.I)
_OPENING_EVENT_SIGNAL = re.compile(r"突然|发现|失踪|死亡|尸体|求救|被抓|曝光|倒计时|婚礼|直播|闯入|砸门|断电|改口|开口")
_CONFLICT_SIGNAL = re.compile(r"阻止|封锁|逼|威胁|追杀|对抗|争夺|反派|否则|代价|选择|陷阱|质问|指认|起诉|封锁")
_ACTIVE_CHOICE_SIGNAL = re.compile(r"选择|拒绝|决定|公开|闯入|追查|交换|揭开|救下|反击|逃离|承认|销毁|上传|报警|签下")
_IRREVERSIBLE_CHANGE_SIGNAL = re.compile(r"失去|暴露|公开|被捕|被起诉|决裂|死亡|受伤|身份|全网|彻底|再也|无法|代价")
_REVERSAL_SIGNAL = re.compile(r"反转|原来|其实|却|竟然|不是|真相|身份|转向|幕后|照片|录音")
_ENDING_HOOK_SIGNAL = re.compile(r"秘密|电话|照片|录音|来电|出现|活着|死亡|身份|真相|幕后|倒计时|敲门|威胁|发来|留下")


def _text(value: Any) -> str:
    """JS toText：String(value ?? '').trim()。"""
    return str(value if value is not None else "").strip()


def _has_text(value: Any) -> bool:
    """JS hasText：非空字符串或真值。"""
    return len(value.strip()) > 0 if isinstance(value, str) else bool(value)


def _has_items(value: Any) -> bool:
    """JS hasItems：非空数组或 hasText。"""
    return len(value) > 0 if isinstance(value, list) else _has_text(value)


def _to_list(value: Any) -> list[Any]:
    """JS toList：数组原样（对象保留），字符串按分隔符拆分。"""
    if isinstance(value, list):
        return [item if isinstance(item, dict) else _text(item) for item in value if item if True]
    if isinstance(value, str):
        return [item.strip() for item in re.split(r"[\n,，；;]", value) if item.strip()]
    return []


def _blocker(field: str, message: str) -> dict[str, str]:
    """JS blocker：阻塞问题项。"""
    return {"field": field, "message": message, "severity": "blocker"}


def _warning(field: str, message: str) -> dict[str, str]:
    """JS warning：提醒项。"""
    return {"field": field, "message": message, "severity": "warning"}


def _dimension(key: str, label: str, weight: int, score: int, passed: bool) -> dict[str, Any]:
    """JS dimension：评分维度项。"""
    return {"key": key, "label": label, "weight": weight, "score": score, "passed": passed}


def _normalize_character(input_data: dict[str, Any]) -> dict[str, str]:
    """JS normalizeCharacter：角色七字段全量归一。"""
    return {field: _text(input_data.get(field)) for field, _ in _CHARACTER_REQUIRED_FIELDS}


def _normalize_episode(input_data: dict[str, Any], index: int = 0) -> dict[str, Any]:
    """JS normalizeEpisode：分集字段全量归一。"""
    try:
        episode_no = float(input_data.get("episodeNo"))
    except (TypeError, ValueError):
        episode_no = 0
    return {
        "episodeNo": int(episode_no) if episode_no > 0 else index + 1,
        "title": _text(input_data.get("title")),
        "logline": _text(input_data.get("logline")),
        "openingHook": _text(input_data.get("openingHook")),
        "goal": _text(input_data.get("goal")),
        "coreConflict": _text(input_data.get("coreConflict")),
        "irreversibleChange": _text(input_data.get("irreversibleChange")),
        "endingHook": _text(input_data.get("endingHook")),
        "protagonistChoice": _text(input_data.get("protagonistChoice")),
        "reversal": _text(input_data.get("reversal")),
        "visualSetPieces": _to_list(input_data.get("visualSetPieces")),
    }


def normalize_story_bible_input(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node normalizeStoryBibleInput：故事设定字段全量归一。

    :param input_data: 任意 dict（模型输出或前端表单）。
    :returns: 归一后的设定 DTO（列表字段缺省为空数组）。
    """
    input_data = input_data or {}
    return {
        "title": _text(input_data.get("title")),
        "logline": _text(input_data.get("logline")),
        "audience": _text(input_data.get("audience")),
        "emotionalPromise": _text(input_data.get("emotionalPromise")),
        "worldRules": _to_list(input_data.get("worldRules")),
        "timeline": _to_list(input_data.get("timeline")),
        "locations": _to_list(input_data.get("locations")),
        "characters": [_normalize_character(item) for item in input_data.get("characters", [])] if isinstance(input_data.get("characters"), list) else [],
        "relationships": _to_list(input_data.get("relationships")),
        "props": _to_list(input_data.get("props")),
        "mainPlot": _text(input_data.get("mainPlot")),
        "subplots": _to_list(input_data.get("subplots")),
        "foreshadowing": _to_list(input_data.get("foreshadowing")),
        "lockedFacts": _to_list(input_data.get("lockedFacts")),
        "flexibleFacts": _to_list(input_data.get("flexibleFacts")),
        "visualSymbols": _to_list(input_data.get("visualSymbols")),
    }


def normalize_season_structure_input(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node normalizeSeasonStructureInput：分集大纲字段全量归一。"""
    input_data = input_data or {}
    episodes = (
        [_normalize_episode(item, index) for index, item in enumerate(input_data.get("episodes", []))]
        if isinstance(input_data.get("episodes"), list)
        else []
    )
    try:
        episode_count = float(input_data.get("episodeCount"))
    except (TypeError, ValueError):
        episode_count = 0
    return {
        "seasonTheme": _text(input_data.get("seasonTheme")),
        "coreConflict": _text(input_data.get("coreConflict")),
        "structureType": _text(input_data.get("structureType")),
        "episodeCount": int(episode_count) if episode_count > 0 else len(episodes),
        "episodes": episodes,
        "foreshadowingPlan": _to_list(input_data.get("foreshadowingPlan")),
        "characterArcs": _to_list(input_data.get("characterArcs")),
    }


def _check_required_fields(value: dict[str, Any], fields: tuple[tuple[str, str], ...], prefix: str = "") -> list[dict[str, str]]:
    """JS checkRequiredFields：必填字段缺失 → blocker 列表。"""
    return [
        _blocker(f"{prefix}.{field}" if prefix else field, f"{label}不能为空")
        for field, label in fields
        if not _has_text(value.get(field)) and not _has_items(value.get(field))
    ]


def _evaluate_characters(characters: list[dict[str, Any]]) -> list[dict[str, str]]:
    """JS evaluateCharacters：角色字段/重名/主角与反派检查。"""
    blockers: list[dict[str, str]] = []
    names: set[str] = set()
    for index, character in enumerate(characters):
        prefix = f"characters[{index}]"
        blockers.extend(_check_required_fields(character, _CHARACTER_REQUIRED_FIELDS, prefix))
        if character.get("name"):
            if character["name"] in names:
                blockers.append(_blocker(f"{prefix}.name", f"人物姓名“{character['name']}”重复"))
            names.add(character["name"])
    if not any("主角" in character.get("role", "") for character in characters):
        blockers.append(_blocker("characters", "至少需要一名角色定位为“主角”的人物"))
    if not any("反派" in character.get("role", "") for character in characters):
        blockers.append(_warning("characters", "尚未明确反派角色，后续冲突强度可能不足"))
    return blockers


def _score_from_rules(value: dict[str, Any]) -> int:
    """JS scoreFromRules：按 BIBLE_SCORE_RULES 累加得分。"""
    return sum(
        weight
        for key, _label, weight in _BIBLE_SCORE_RULES
        if (_has_items(value.get(key)) if key != "logline" and key != "mainPlot" else _has_text(value.get(key)))
        if key != "characters"
    ) + (
        20
        if isinstance(value.get("characters"), list)
        and len(value["characters"]) >= 2
        and all(all(_has_text(character.get(field)) for field, _ in _CHARACTER_REQUIRED_FIELDS) for character in value["characters"])
        else 0
    )


def evaluate_story_bible(input_data: dict[str, Any]) -> dict[str, Any]:
    """Node evaluateStoryBible：故事设定质量报告（threshold 90）。

    :param input_data: 设定 dict。
    :returns: ``{"type","score","threshold","canLock","blockers","warnings",
        "dimensions","normalized"}``。
    """
    bible = normalize_story_bible_input(input_data)
    blockers = [*_check_required_fields(bible, _BIBLE_REQUIRED_FIELDS), *_evaluate_characters(bible["characters"])]
    warnings: list[dict[str, str]] = []
    if not _has_items(bible["props"]):
        warnings.append(_warning("props", "尚未配置关键道具，画面记忆点可能不足"))
    if not _has_items(bible["subplots"]):
        warnings.append(_warning("subplots", "尚未配置支线，整季中段可能缺少层次"))
    if not _has_items(bible["flexibleFacts"]):
        warnings.append(_warning("flexibleFacts", "尚未标记可调整设定，后续改稿空间较小"))

    score = 0
    dimensions = []
    for key, label, weight in _BIBLE_SCORE_RULES:
        if key == "characters":
            passed = (
                isinstance(bible["characters"], list)
                and len(bible["characters"]) >= 2
                and all(
                    all(_has_text(character.get(field)) for field, _ in _CHARACTER_REQUIRED_FIELDS)
                    for character in bible["characters"]
                )
            )
        elif key in {"logline", "mainPlot"}:
            passed = _has_text(bible[key])
        else:
            passed = _has_items(bible[key])
        dimensions.append(_dimension(key, label, weight, weight if passed else 0, passed))
        score += weight if passed else 0
    return {
        "type": "story_bible",
        "score": score,
        "threshold": 90,
        "canLock": not blockers and score >= 90,
        "blockers": blockers,
        "warnings": warnings,
        "dimensions": dimensions,
        "normalized": bible,
    }


def _clamp_score(value: Any) -> int:
    """JS clampScore：0-100 夹取四舍五入。"""
    try:
        parsed = round(float(value))
    except (TypeError, ValueError):
        parsed = 0
    return max(0, min(100, parsed))


def _is_concrete(value: Any, minimum_length: int = 12) -> bool:
    """JS isConcrete：长度达标且非模板句。"""
    normalized = _text(value)
    return len(normalized) >= minimum_length and not _GENERIC_TEXT.fullmatch(normalized)


def evaluate_market_episode_quality(episode: dict[str, Any]) -> dict[str, Any]:
    """Node evaluateMarketEpisodeQuality：单集爆款结构评估（threshold 80）。"""
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    opening_hook = _text(episode.get("openingHook"))
    core_conflict = _text(episode.get("coreConflict"))
    protagonist_choice = _text(episode.get("protagonistChoice"))
    irreversible_change = _text(episode.get("irreversibleChange"))
    reversal = _text(episode.get("reversal"))
    ending_hook = _text(episode.get("endingHook"))
    visual_set_pieces = (
        [item for item in (_text(entry) for entry in episode.get("visualSetPieces", [])) if item]
        if isinstance(episode.get("visualSetPieces"), list)
        else []
    )

    opening_passed = _is_concrete(opening_hook) and _OPENING_EVENT_SIGNAL.search(opening_hook)
    if not opening_passed:
        blockers.append(_blocker("openingHook", "开场钩子必须在第一句交代具体异常事件、人物目标或立即风险，不能只写“故事开始了”。"))
    conflict_passed = _is_concrete(core_conflict) and _CONFLICT_SIGNAL.search(core_conflict)
    if not conflict_passed:
        blockers.append(_blocker("coreConflict", "核心冲突必须明确阻力、对手或代价，观众要知道主角正在和谁争什么。"))
    choice_passed = _is_concrete(protagonist_choice, 10) and _ACTIVE_CHOICE_SIGNAL.search(protagonist_choice)
    if not choice_passed:
        blockers.append(_blocker("protagonistChoice", "主角必须做出可拍摄的主动选择，不能只是等待、被动接受或继续调查。"))
    irreversible_passed = _is_concrete(irreversible_change, 10) and _IRREVERSIBLE_CHANGE_SIGNAL.search(irreversible_change)
    if not irreversible_passed:
        blockers.append(_blocker("irreversibleChange", "每集必须产生不可逆后果，否则剧情会像流水账，无法支撑追更。"))
    reversal_passed = _is_concrete(reversal, 8) and _REVERSAL_SIGNAL.search(reversal)
    if not reversal_passed:
        blockers.append(_blocker("reversal", "每集至少需要一次信息反转、身份变化或线索方向变化。"))
    ending_passed = _is_concrete(ending_hook, 10) and _ENDING_HOOK_SIGNAL.search(ending_hook)
    if not ending_passed:
        blockers.append(_blocker("endingHook", "结尾必须留下新证据、新威胁或未解决问题，形成明确追更理由。"))

    visual_passed = len(visual_set_pieces) > 0
    if not visual_passed:
        blockers.append(_blocker("visualSetPieces", "至少配置一个可直接转成分镜的视觉场面，避免只有抽象对白没有画面记忆点。"))
    elif len(visual_set_pieces) < 2:
        warnings.append(_warning("visualSetPieces", "当前只有一个可视化场面，建议增加第二个空间、道具或动作变化。"))

    dimensions = [
        _dimension("opening-hook", "开场钩子", 25, 25 if opening_passed else 0, bool(opening_passed)),
        _dimension("conflict-and-stakes", "冲突与代价", 20, 20 if conflict_passed else 0, bool(conflict_passed)),
        _dimension("protagonist-agency", "主角主动性", 15, 15 if choice_passed else 0, bool(choice_passed)),
        _dimension("irreversible-change", "不可逆变化", 15, 15 if irreversible_passed else 0, bool(irreversible_passed)),
        _dimension("reversal", "信息反转", 15, 15 if reversal_passed else 0, bool(reversal_passed)),
        _dimension("ending-hook", "结尾追更钩子", 10, 10 if ending_passed else 0, bool(ending_passed)),
    ]
    score = _clamp_score(sum(item["score"] for item in dimensions))
    return {
        "type": "market_episode",
        "score": score,
        "threshold": 80,
        "canPass": not blockers and score >= 80,
        "blockers": blockers,
        "warnings": warnings,
        "dimensions": dimensions,
        "visualSetPieces": visual_set_pieces,
    }


def evaluate_market_season_quality(season: dict[str, Any]) -> dict[str, Any]:
    """Node evaluateMarketSeasonQuality：整季爆款结构聚合评估。"""
    episodes = season.get("episodes") if isinstance(season.get("episodes"), list) else []
    episode_reports = [evaluate_market_episode_quality(episode) for episode in episodes]
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not episodes:
        blockers.append(_blocker("episodes", "至少需要一集内容才能进行爆款结构代理评估。"))
    for index, report in enumerate(episode_reports):
        for item in report["blockers"]:
            blockers.append({**item, "field": f"episodes[{index}].{item['field']}"})
        for item in report["warnings"]:
            warnings.append({**item, "field": f"episodes[{index}].{item['field']}"})

    average_score = (
        sum(report["score"] for report in episode_reports) / len(episode_reports) if episode_reports else 0
    )
    reversal_count = sum(
        1 for report in episode_reports if any(item["key"] == "reversal" and item["passed"] for item in report["dimensions"])
    )
    ending_hook_count = sum(
        1 for report in episode_reports if any(item["key"] == "ending-hook" and item["passed"] for item in report["dimensions"])
    )
    dimensions = [
        _dimension(
            "episode-average", "单集爆款结构平均分", 70, round(average_score * 0.7),
            bool(episode_reports) and average_score >= 80,
        ),
        _dimension(
            "reversal-coverage", "反转覆盖率", 15,
            round((reversal_count / len(episode_reports)) * 15) if episode_reports else 0,
            bool(episode_reports) and reversal_count == len(episode_reports),
        ),
        _dimension(
            "ending-hook-coverage", "结尾钩子覆盖率", 15,
            round((ending_hook_count / len(episode_reports)) * 15) if episode_reports else 0,
            bool(episode_reports) and ending_hook_count == len(episode_reports),
        ),
    ]
    score = _clamp_score(sum(item["score"] for item in dimensions))
    return {
        "type": "market_season",
        "score": score,
        "threshold": 80,
        "canPass": not blockers and score >= 80,
        "blockers": blockers,
        "warnings": warnings,
        "dimensions": dimensions,
        "episodeReports": episode_reports,
        "coverage": {"episodeCount": len(episodes), "reversalCount": reversal_count, "endingHookCount": ending_hook_count},
    }


def evaluate_season_structure(input_data: dict[str, Any]) -> dict[str, Any]:
    """Node evaluateSeasonStructure：分集大纲质量报告（threshold 90）。

    :param input_data: 分集大纲 dict。
    :returns: ``{"type","score","threshold","canLock","blockers","warnings",
        "dimensions","marketQuality","normalized"}``。
    """
    season = normalize_season_structure_input(input_data)
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    market_quality = evaluate_market_season_quality(season)

    if not _has_text(season["seasonTheme"]):
        blockers.append(_blocker("seasonTheme", "季主题不能为空"))
    if not _has_text(season["coreConflict"]):
        blockers.append(_blocker("coreConflict", "整季主线冲突不能为空"))
    if not season["episodes"]:
        blockers.append(_blocker("episodes", "至少需要一集分集结构"))
    if season["episodeCount"] != len(season["episodes"]):
        blockers.append(_blocker("episodes", f"计划集数为 {season['episodeCount']}，但实际只有 {len(season['episodes'])} 集"))

    seen_episode_nos: set[int] = set()
    for index, episode in enumerate(season["episodes"]):
        if episode["episodeNo"] in seen_episode_nos:
            blockers.append(_blocker("episodes", f"第 {episode['episodeNo']} 集编号重复"))
        seen_episode_nos.add(episode["episodeNo"])
        episode_blockers = _check_required_fields(episode, _EPISODE_REQUIRED_FIELDS, f"episodes[{index}]")
        blockers.extend(episode_blockers)
        if not _has_text(episode.get("reversal")):
            warnings.append(_warning(f"episodes[{index}].reversal", "尚未填写反转或信息揭示"))
        if not _has_items(episode.get("visualSetPieces")):
            warnings.append(_warning(f"episodes[{index}].visualSetPieces", "尚未填写可视化场面"))

    blockers.extend(market_quality["blockers"])
    warnings.extend(market_quality["warnings"])

    if season["episodes"] and not _has_items(season["foreshadowingPlan"]):
        warnings.append(_warning("foreshadowingPlan", "尚未配置整季伏笔回收计划"))
    if season["episodes"] and not _has_items(season["characterArcs"]):
        warnings.append(_warning("characterArcs", "尚未配置人物阶段性变化"))

    episode_pass_count = sum(
        1
        for episode in season["episodes"]
        if not _check_required_fields(episode, _EPISODE_REQUIRED_FIELDS, f"episodes[0]")
    )
    base_score = round((episode_pass_count / len(season["episodes"])) * 80) if season["episodes"] else 0
    structure_score = 10 if _has_text(season["seasonTheme"]) and _has_text(season["coreConflict"]) else 0
    foreshadowing_score = 5 if _has_items(season["foreshadowingPlan"]) else 0
    arc_score = 5 if _has_items(season["characterArcs"]) else 0
    score = min(100, base_score + structure_score + foreshadowing_score + arc_score)

    return {
        "type": "season_structure",
        "score": score,
        "threshold": 90,
        "canLock": not blockers and score >= 90 and market_quality["canPass"],
        "blockers": blockers,
        "warnings": warnings,
        # Node 此处分组的 dimensions 项不含 passed 字段（与 bible 评分维度不同形）。
        "dimensions": [
            {"key": "episodeCompleteness", "label": "分集必备字段", "weight": 80, "score": base_score},
            {"key": "seasonConflict", "label": "整季主题与冲突", "weight": 10, "score": structure_score},
            {"key": "foreshadowingPlan", "label": "伏笔回收计划", "weight": 5, "score": foreshadowing_score},
            {"key": "characterArcs", "label": "人物阶段性变化", "weight": 5, "score": arc_score},
        ],
        "marketQuality": market_quality,
        "normalized": season,
    }
