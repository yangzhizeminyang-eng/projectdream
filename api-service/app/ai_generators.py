"""剧本/分镜/故事设定 AI 生成编排（任务 C）。

组合 :mod:`app.ai_provider` 与 :mod:`app.domain.storyboard_ai` /
``app.domain.story_quality``，复刻 Node 各 generate 服务的形态：
- 场景剧本（``ai/script.mjs``）：mock 生成器 / 真实调用失败回退 mock；
- 分镜（``ai/storyboard.mjs``）：mock 校验抛错 / 真实调用两次尝试带纠错提示、
  契约失败 422、供应商失败按配置回退 mock；
- 故事设定（``ai/story-bible.mjs``）：mock 直接抛错（不造假设定）、真实两段调用
  且刻意不走 fallbackToMock；
- 分集大纲（``ai/season-structure.mjs``）：mock 直接抛错；
- 静帧提示词重写（``ai/frame-prompt.mjs``）：mock 兜底 / 真实失败回退兜底。

全部为 async：模型调用走注入的 httpx.AsyncClient（不阻塞事件循环、不落线程池）。
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

import httpx

from app.ai_provider import AiConfig, AiProviderError, generate_structured_json, get_ai_config, is_mock_provider
from app.domain.asset_prompts import normalize_scene_space_manifest
from app.domain.story_quality import _text as quality_text
from app.domain.storyboard_ai import (
    generate_mock_scene_script,
    generate_mock_storyboards,
    normalize_scene_script_payload,
    normalize_storyboard_payload,
    validate_storyboard_duration_contracts,
    _validate_configured_video_durations,
    build_genre_prompt_context,
    build_mock_visual_prompt,
    StoryboardContractError,
)


def _text(value: Any, fallback: str = "") -> str:
    """局部 text 助手（与 Node text(value, fallback) 一致：空则回退）。"""
    normalized = str(value if value is not None else "").strip()
    return normalized or fallback


def normalize_outline_payload(payload: Any, project: dict[str, Any]) -> dict[str, Any]:
    """Node normalizeOutlinePayload：把模型结果归一成可持久化总纲 DTO。"""
    def positive_int(value: Any, fallback: int) -> int:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return fallback
        return max(1, math.floor(number + 0.5)) if math.isfinite(number) and number > 0 else fallback

    def non_empty(value: Any, fallback: str = "") -> str:
        if value is None:
            return fallback
        result = str(value).strip()
        return result or fallback

    source = payload if isinstance(payload, dict) else {}
    project_name = non_empty(project.get("name"), "未命名项目")
    target_minutes = positive_int(project.get("targetDuration", project.get("target_duration")), 90)
    fallback_count = max(4, min(12, math.floor(target_minutes / 10 + 0.5)))
    fallback_duration = max(120, math.floor(target_minutes * 60 / fallback_count + 0.5))
    acts_source = source.get("acts") if isinstance(source.get("acts"), list) else []
    acts_source = acts_source[:3]
    acts = [
        {
            "act": positive_int(item.get("act"), index + 1) if isinstance(item, dict) else index + 1,
            "title": non_empty(item.get("title"), f"第{index + 1}幕") if isinstance(item, dict) else f"第{index + 1}幕",
            "summary": non_empty(item.get("summary"), "本幕摘要待补充。") if isinstance(item, dict) else "本幕摘要待补充。",
        }
        for index, item in enumerate(acts_source)
    ]
    if not acts:
        acts = [
            {"act": 1, "title": "建置与钩子", "summary": "建立世界观与主角初始处境。"},
            {"act": 2, "title": "冲突与升级", "summary": "冲突逐步升级，代价不断抬高。"},
            {"act": 3, "title": "高潮与抉择", "summary": "主角做出最终抉择并收束故事。"},
        ]
    scenes_source = source.get("scenes") if isinstance(source.get("scenes"), list) else []
    scenes_source = scenes_source[:20] if scenes_source else [{} for _ in range(fallback_count)]
    scenes = []
    for index, item in enumerate(scenes_source):
        item = item if isinstance(item, dict) else {}
        scenes.append({
            "scene_no": positive_int(item.get("scene_no"), index + 1),
            "title": non_empty(item.get("title"), f"场景 {index + 1:02d}"),
            "summary": non_empty(item.get("summary"), "本场景摘要待补充。"),
            "location": non_empty(item.get("location"), "未知地点"),
            "time_of_day": non_empty(item.get("time_of_day"), "夜"),
            "estimated_duration": positive_int(item.get("estimated_duration"), fallback_duration),
        })
    title = non_empty(source.get("title"), project_name)
    if title.lower() in {"未命名项目", "未命名场景", "untitled project", "untitled scene", "n/a"}:
        title = project_name
    return {
        "title": title,
        "logline": non_empty(source.get("logline"), f"{non_empty(project.get('name'), '这个故事')}围绕一位主角在压力中被迫做出改变的过程展开。"),
        "premise": non_empty(source.get("premise"), non_empty(project.get("narrativeVision", project.get("narrative_vision")), "故事设定待模型进一步补足。")),
        "visual_style": non_empty(source.get("visual_style"), non_empty(project.get("visualStyle", project.get("visual_style")), "电影感写实风格")),
        "acts": acts,
        "scenes": scenes,
    }


def _mock_outline(project: dict[str, Any]) -> dict[str, Any]:
    """Node generateMockOutline：按项目名/id 生成稳定的离线总纲。"""
    seed = f"{project.get('name') or 'undefined'}-{project.get('id') or 'new'}"
    code_units = seed.encode("utf-16-le", errors="surrogatepass")
    value = 2166136261
    for index in range(0, len(code_units), 2):
        unit = code_units[index] | (code_units[index + 1] << 8)
        value = ((value ^ unit) * 16777619) & 0xFFFFFFFF

    def rand() -> float:
        nonlocal value
        value ^= (value << 13) & 0xFFFFFFFF
        value ^= value >> 17
        value ^= (value << 5) & 0xFFFFFFFF
        value &= 0xFFFFFFFF
        return (value % 10000) / 10000

    def pick(items: list[str]) -> str:
        return items[min(len(items) - 1, int(rand() * len(items)))]

    category = project.get("category") or "科幻剧情片"
    try:
        duration = float(project.get("targetDuration", project.get("target_duration")) or 90)
    except (TypeError, ValueError):
        duration = 90
    if not math.isfinite(duration) or not duration:
        duration = 90
    scene_count = max(4, min(12, math.floor(duration / 10 + 0.5)))
    project_name = project.get("name") or "这个故事"
    locations = ["废弃实验室", "雨夜街头", "霓虹走廊", "地下档案室", "悬浮列车", "旧城天台", "寂静海滩"]
    times = ["夜", "晨", "黄昏", "深夜", "午后", "拂晓"]
    templates = [
        ("建置与钩子", "建立世界观与主角的初始状态，用一个强事件把观众拽进故事。"),
        ("冲突与升级", "主角被迫偏离计划，目标代价不断升高，对手的能力被反复确认。"),
        ("高潮与抉择", "所有伏笔兑现，主角在极端压力下做出选择，留下开放或闭合的结局。"),
    ]
    acts = []
    for index, (title, summary) in enumerate(templates):
        location = pick(locations)
        detail = (f" 场景切入：{location}。" if index == 0 else
                  f" 关键抉择发生在 {location}。" if index == 1 else f" 终局落点：{location}。")
        acts.append({"act": index + 1, "title": title, "summary": summary + detail})
    titles = ["钩子开场", "平静被打破", "关键情报", "第一次对峙", "代价浮出水面", "盟友出现", "真相一角", "中点反转", "被迫上路", "最终决战", "余波", "尾声"]
    scenes = []
    for index in range(scene_count):
        scene_no = index + 1
        location = pick(locations)
        time = pick(times)
        minutes = max(2, math.floor(duration / scene_count + 0.5))
        if 1 < scene_no < scene_count:
            summary = f"主角在 {location}（{time}）收到关于核心秘密的线索，{pick(['信任', '怀疑', '拒绝', '接受'])}。"
        elif scene_no == 1:
            summary = "用极短时间建立主角身份和世界规则，第一场戏就抛出不寻常的信号。"
        else:
            summary = f"收束所有线索，{pick(['角色', '城市', '情感'])}的命运在此定型。"
        scenes.append({"scene_no": scene_no, "title": titles[(scene_no - 1) % len(titles)], "summary": summary,
                       "location": location, "time_of_day": time, "estimated_duration": minutes * 60})
    return {
        "title": project.get("name") or "未命名项目",
        "logline": f"{project_name} 讲述了一个在{category}背景下，被迫打破自身规则的主角，意外触发连锁反应的故事。",
        "premise": project.get("narrativeVision", project.get("narrative_vision")) or "一座被霓虹吞没的城市，记忆成了可被买卖的违禁品。主角作为清道夫，第一次发现自己的记忆也成了某场交易的目标。",
        "visual_style": project.get("visualStyle", project.get("visual_style")) or "黑色电影 / 高反差夜景",
        "acts": acts, "scenes": scenes,
    }


async def generate_outline(
    project: dict[str, Any], *, client: httpx.AsyncClient, config: AiConfig | None = None
) -> dict[str, Any]:
    """Node generateOutline：mock 确定性输出，真实模式按配置生成并安全回退。"""
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        return _mock_outline(project)
    genre_context = build_genre_prompt_context(project.get("category"))
    prompts = {
        "system": " ".join([
            "你是专业影视策划与编剧顾问。", "你的任务是根据项目信息输出一个适合影视开发的故事总纲。",
            "你必须只返回 JSON，不要输出解释、标题、Markdown、代码块。",
            "字段必须严格使用这些 key：title, logline, premise, visual_style, acts, scenes。",
            "acts 必须是 3 项数组，每项包含：act, title, summary。",
            "scenes 必须是数组，每项包含：scene_no, title, summary, location, time_of_day, estimated_duration。",
            "estimated_duration 必须是正整数，单位是秒。", "内容要尽量具体，可拍摄，可继续流转到场景拆解和单场景剧本阶段。",
            genre_context,
        ]),
        "user": "\n".join([
            f"项目名：{_text(project.get('name'), '未命名项目')}",
            f"题材：{_text(project.get('category'), '剧情 / 科幻')}",
            f"目标时长（分钟）：{project.get('targetDuration', project.get('target_duration')) or 90}",
            f"世界观 / 叙事愿景：{_text(project.get('narrativeVision', project.get('narrative_vision')), '请自行补足完整世界观和故事矛盾')}",
            f"视觉风格：{_text(project.get('visualStyle', project.get('visual_style')), '电影感、写实、可视化明确')}",
            genre_context, "", "请生成：", "1. 一句话 logline", "2. premise（完整故事前提）", "3. 三幕结构", "4. 4 到 12 个场景预览", "",
            "输出要求：", "- scene_no 从 1 递增", "- 场景摘要要体现冲突推进", "- location 和 time_of_day 不能空",
            "- estimated_duration 用秒表示", "- 整体风格要贴合该项目题材与视觉风格",
        ]),
    }
    try:
        result = await generate_structured_json(
            task="outline", system_prompt=prompts["system"], user_prompt=prompts["user"],
            client=client, config=active_config, model=active_config.outline_model, temperature=0.8,
        )
        return normalize_outline_payload(result["json"], project)
    except AiProviderError:
        if active_config.fallback_to_mock:
            return _mock_outline(project)
        raise


def _normalize_characters(payload: Any, scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    source = payload.get("characters") if isinstance(payload, dict) else payload
    if not isinstance(source, list):
        return []
    script_text = "\n".join(
        str(scene.get(key) or "")
        for scene in scenes
        for key in ("title", "summary", "content", "location")
    )
    characters: list[dict[str, Any]] = []
    seen: set[str] = set()
    excluded_name = re.compile(r"^(?:路人|群众|群演|旁白|观众|员工|同事|保安|司机|警察)[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十\d]*$")
    costume_evidence = re.compile(r"固定|默认|穿着|穿戴|服装|衣着|西装|衬衫|外套|夹克|裙|裤|鞋|靴|皮带|领带|眼镜|腕表|手表|项链|吊坠|耳环|戒指|随身|携带|U盘")
    for index, item in enumerate(source[:20]):
        if not isinstance(item, dict):
            continue
        name = re.sub(r"[（(](?:成年|青年|少年|童年|小时候|当前|现在|过去|五年前|十八年前)[）)]", "", _text(item.get("name")))
        name = re.sub(r"\s+", "", name).strip()
        role = _text(item.get("role_tag", item.get("roleTag")), "主角" if index == 0 else "配角")
        if name in {"主角", "主人公", "男主角", "女主角", "男主", "女主", "第一主角", "核心人物"}:
            candidate = re.search(r"(?:主角|主人公|男主角|女主角)\s*(?:是|叫|为|：|:|，|、)?\s*([\u4e00-\u9fa5]{2,4})(?=[^\u4e00-\u9fa5]|$)", script_text)
            name = candidate.group(1) if candidate else ""
        if not name or name in seen or excluded_name.fullmatch(name) or re.search(r"群演|无名|路人|背景人物|群众", role):
            continue
        if script_text and name not in script_text:
            continue
        costume = _text(item.get("costume", item.get("costume_description", item.get("fixed_costume", item.get("fixedCostume")))))
        voice_setting = _text(item.get("voice_setting", item.get("voiceSetting")))
        if not costume and costume_evidence.search(voice_setting):
            costume = voice_setting
        age_group = _text(item.get("age_group", item.get("ageGroup"))).lower()
        gender = _text(item.get("gender")).lower()
        gender = gender if gender in {"male", "female", "neutral"} else None
        identity = "\n".join((name, _text(item.get("appearance")), role))
        if name == "林默" or re.search(r"男主角|男主|男配角|男配|男性|男人|男士|男孩|父亲|爸爸|他穿着|他的", identity):
            gender = "male"
        elif re.search(r"女主角|女主|女配角|女配|女性|女人|女士|女孩|母亲|妈妈|她穿着|她的", identity):
            gender = "female"
        seen.add(name)
        characters.append({
            "name": name,
            "role_tag": role,
            "personality": _text(item.get("personality"), "性格鲜明，行为动机与剧情目标一致。"),
            "appearance": _text(item.get("appearance"), "具有清晰可辨的脸部、发型、体态与服装特征。"),
            "costume": costume or None,
            "voice_setting": voice_setting or None,
            "age_group": age_group if age_group in {"child", "teen", "young_adult", "middle_aged", "senior"} else None,
            "gender": gender,
            "voice_style": _text(item.get("voice_style", item.get("voiceStyle")))[:160] or None,
        })
    return characters


def _mock_characters(scenes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    text = "\n".join(str(scene.get("content") or "") for scene in scenes)
    names = list(dict.fromkeys(
        re.findall(r"(?:角色|人物|姓名)[：:]\s*([\u4e00-\u9fa5A-Za-z0-9·]{2,16})(?=\s|[，。；;：:]|$)", text)
    ))[:12]
    if not names:
        names = ["主角"]
    return [{
        "name": name,
        "role_tag": "主角" if index == 0 else "配角",
        "personality": "目标明确，在压力下展现出稳定而有辨识度的行动方式。",
        "appearance": "具有清晰可辨的面部轮廓、发型、体态、服装层次与标志性细节。",
        "costume": "深色长外套与简洁内搭，佩戴一件固定的金属身份吊坠。",
        "age_group": "young_adult",
        "gender": ("male", "female")[index % 2] if name != "主角" else "neutral",
        "voice_style": "自然、克制，语速稳定。",
    } for index, name in enumerate(names)]


async def generate_characters(
    *, project: dict[str, Any], outline: dict[str, Any] | None,
    scenes: list[dict[str, Any]], story_bible: dict[str, Any] | None,
    client: httpx.AsyncClient,
) -> dict[str, Any]:
    """从当前项目剧本提取角色；mock 模式与 Node 一样走确定性规则。"""
    config = get_ai_config()
    if is_mock_provider(config):
        return {"characters": _mock_characters(scenes)}
    system_prompt = (
        "你是影视角色设定总监。仅从当前剧本提取有明确姓名或行动的叙事角色，排除路人、群演、地点和物件。"
        "将同一人的年龄/时间状态合并。只返回 JSON：{\"characters\":[{\"name\",\"role_tag\",\"personality\",\"appearance\",\"costume\",\"voice_setting\",\"age_group\",\"gender\",\"voice_style\"}]}。"
        "appearance 描述稳定外貌，costume 描述固定服装与随身物件，voice_setting 只描述音色。"
    )
    compact_scenes = "\n\n".join(
        f"场景 {scene.get('scene_no') or '?'}｜{scene.get('title') or '未命名'}\n{str(scene.get('content') or scene.get('summary') or '')[:2400]}"
        for scene in scenes[:20]
    )[:24000]
    user_prompt = "\n".join((
        f"项目名：{project.get('name') or '未命名项目'}",
        f"题材：{project.get('category') or '剧情'}",
        f"视觉风格：{project.get('visual_style') or ''}",
        f"叙事愿景：{project.get('narrative_vision') or ''}",
        "当前剧本正文（唯一角色来源）：", compact_scenes,
        f"总纲：{outline.get('premise') or outline.get('logline') or ''}" if outline else "",
        f"既有角色视觉基线：{json.dumps((story_bible or {}).get('characters') or [], ensure_ascii=False)}",
        "不得仅凭主角/女主等标签推断性别；不新增剧本正文没有的姓名。",
    ))
    try:
        result = await generate_structured_json(
            task="characters", system_prompt=system_prompt, user_prompt=user_prompt,
            client=client, config=config, model=config.character_model,
            temperature=0.6, response_format={"type": "json_object"},
        )
        characters = _normalize_characters(result["json"], scenes)
    except AiProviderError:
        if not config.fallback_to_mock:
            raise
        characters = _normalize_characters({"characters": _mock_characters(scenes)}, scenes)
    return {"characters": characters}


def _normalize_character_profile(payload: Any, current: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("character", payload) if isinstance(payload, dict) else {}
    if not isinstance(source, dict):
        source = {}

    def value(key: str, fallback_key: str | None = None, default: str = "") -> str:
        raw = source.get(key, source.get(fallback_key) if fallback_key else None)
        if raw is None or not str(raw).strip():
            raw = current.get(key, current.get(fallback_key) if fallback_key else None)
        return _text(raw, default)

    age_group = value("age_group", "ageGroup").lower()
    gender = value("gender").lower()
    return {
        "role_tag": value("role_tag", "roleTag", "配角"),
        "personality": value("personality", default="性格鲜明，行为动机与剧情目标一致。"),
        "appearance": value("appearance", default="具有清晰可辨的脸部、发型、体态与服装特征。"),
        "costume": value("costume", "costume_description") or None,
        "voice_setting": value("voice_setting", "voiceSetting") or None,
        "age_group": age_group if age_group in {"child", "teen", "young_adult", "middle_aged", "senior"} else None,
        "gender": gender if gender in {"male", "female", "neutral"} else None,
        "voice_style": value("voice_style", "voiceStyle")[:160] or None,
    }


async def generate_character_profile(
    *, character: dict[str, Any], project: dict[str, Any],
    scenes: list[dict[str, Any]], client: httpx.AsyncClient,
) -> dict[str, Any]:
    """补全角色档案，已有字段作为模型输出缺失时的安全回退。"""
    config = get_ai_config()
    if is_mock_provider(config):
        return _normalize_character_profile({}, character)
    system_prompt = (
        "你是影视项目的角色设定总监，为指定角色补全可用于表演、定妆、生图和配音的结构化档案。"
        "保持角色姓名与身份不变。只返回 JSON 对象，字段为 role_tag、personality、appearance、costume、"
        "voice_setting、age_group、gender、voice_style。costume 只描述服装与随身物件，voice_setting 只描述音色。"
    )
    scene_context = "\n\n".join(
        f"场景 {scene.get('scene_no') or '?'}｜{scene.get('title') or '未命名'}\n{str(scene.get('content') or scene.get('summary') or '')[:2400]}"
        for scene in scenes[:20]
    )[:24000]
    user_prompt = "\n".join((
        f"项目名：{project.get('name') or '未命名项目'}",
        f"题材：{project.get('category') or '剧情'}",
        f"视觉风格：{project.get('visual_style') or ''}",
        f"叙事愿景：{project.get('narrative_vision') or ''}",
        f"角色名：{character.get('name') or ''}",
        f"当前身份：{character.get('role_tag') or ''}",
        f"当前性格：{character.get('personality') or ''}",
        f"当前外观：{character.get('appearance') or ''}",
        f"当前服装：{character.get('costume') or character.get('costume_description') or ''}",
        "相关场景与剧本：", scene_context,
    ))
    try:
        result = await generate_structured_json(
            task="character-profile", system_prompt=system_prompt, user_prompt=user_prompt,
            client=client, config=config, model=config.character_model,
            temperature=0.65, response_format={"type": "json_object"},
        )
        profile = _normalize_character_profile(result["json"], character)
    except AiProviderError:
        if not config.fallback_to_mock:
            raise
        profile = _normalize_character_profile({}, character)
    return profile


# ---------------------------------------------------------------------------
# ai/story-bible.mjs：normalizeGeneratedStoryBible + prompts
# ---------------------------------------------------------------------------

_CHARACTER_FIELDS = ("name", "role", "goal", "fear", "secret", "growthArc", "visualDescription")
_LIST_FIELDS = ("worldRules", "timeline", "locations", "relationships", "props", "foreshadowing", "visualSymbols")


def _bible_list(value: Any) -> list[Any]:
    """ai/story-bible.mjs list()：数组保留对象，字符串按分隔符拆分。"""
    if isinstance(value, list):
        return [item if isinstance(item, dict) else _text(item) for item in value if item if True]
    if isinstance(value, str):
        return [item.strip() for item in value.replace("，", ",").replace("；", ";").replace("\n", ",").split(",") if item.strip()] if False else [
            item.strip() for item in [segment for chunk in value.split("\n") for segment in chunk.replace("，", ",").replace("；", ";").split(",")] if item.strip()
        ]
    return []


def normalize_generated_story_bible(payload: Any, project: dict[str, Any] | None = None) -> dict[str, Any]:
    """Node normalizeGeneratedStoryBible：模型设定归一（噪音剔除 + 主角补齐）。

    :param payload: 模型 JSON。
    :param project: 项目行（title 回退用）。
    :returns: 归一后的设定 dict。
    :raises ValueError: 三个核心字段全空（无可用水产出）。
    """
    project = project or {}
    source = payload if isinstance(payload, dict) else {}
    characters = []
    for item in source.get("characters", []) if isinstance(source.get("characters"), list) else []:
        character = {field: _text((item or {}).get(field)) for field in _CHARACTER_FIELDS}
        if character["name"] or character["role"]:
            characters.append(character)
    logline = _text(source.get("logline"))
    main_plot = _text(source.get("mainPlot"))
    if not logline and not main_plot and not characters:
        raise ValueError("模型没有返回可用的故事设定，请重试或补充更多创意细节")
    if characters and not any("主角" in character["role"] for character in characters):
        characters[0]["role"] = f"{characters[0]['role']} / 主角" if characters[0]["role"] else "主角"
    normalized: dict[str, Any] = {
        "title": _text(source.get("title")) or _text(project.get("name")) or "未命名项目",
        "logline": logline,
        "audience": _text(source.get("audience")),
        "emotionalPromise": _text(source.get("emotionalPromise")),
        "characters": characters,
        "mainPlot": main_plot,
        "subplots": _bible_list(source.get("subplots")),
    }
    for field in _LIST_FIELDS:
        normalized[field] = _bible_list(source.get(field))
    return normalized


def _build_core_story_bible_prompts(project: dict[str, Any], options: dict[str, Any]) -> dict[str, str]:
    """Node buildCoreStoryBiblePrompts：核心设定（人物小传）提示词。"""
    genre_context = build_genre_prompt_context(project.get("category"))
    episodes = max(1, min(50, int(options.get("episodeCount") or 1)))
    return {
        "systemPrompt": "\n".join(
            [
                "你是影视项目的故事总监，只返回 JSON，不要解释、Markdown 或代码块。",
                "只能使用这些字段：title, logline, audience, emotionalPromise, characters, mainPlot, subplots。",
                "characters 必须是 3 到 5 个对象，每个对象必须包含 name, role, goal, fear, secret, growthArc, visualDescription。",
                "至少一名角色的 role 必须包含“主角”。所有内容具体、可视化、可拍摄。",
                genre_context,
            ]
        ),
        "userPrompt": "\n".join(
            [
                f"项目名：{_text(project.get('name')) or '未命名项目'}",
                f"类型：{_text(project.get('category')) or '剧情'}",
                f"视觉方向：{_text(project.get('visualStyle')) or '电影感、写实、可视化明确'}",
                f"画面比例：{_text(project.get('aspectRatio')) or '9:16'}",
                f"计划集数：{episodes} 集",
                f"创作者创意：{_text(options.get('idea'))}",
                genre_context,
                "请生成核心故事设定，subplots 控制在 2 条以内。",
            ]
        ),
    }


def _build_world_story_bible_prompts(project: dict[str, Any], options: dict[str, Any], core: dict[str, Any]) -> dict[str, str]:
    """Node buildWorldStoryBiblePrompts：世界观补齐提示词。"""
    genre_context = build_genre_prompt_context(project.get("category"))
    return {
        "systemPrompt": "\n".join(
            [
                "你是影视项目的世界观与视觉设定总监，只返回 JSON，不要解释、Markdown 或代码块。",
                "只能使用这些字段：worldRules, timeline, locations, relationships, props, foreshadowing, visualSymbols。",
                "所有字段都必须是数组，每个数组给 2 到 4 条，内容具体、可拍摄，避免空泛形容词。",
                genre_context,
            ]
        ),
        "userPrompt": "\n".join(
            [
                f"项目名：{_text(project.get('name')) or '未命名项目'}",
                f"视觉方向：{_text(project.get('visualStyle')) or '电影感、写实、可视化明确'}",
                f"创作者创意：{_text(options.get('idea'))}",
                genre_context,
                f"已确定的核心故事：{json.dumps(core, ensure_ascii=False)}",
                "请补齐世界观、时间线、场景、人物关系、关键道具、伏笔和视觉符号，不要重复完整人物小传。"
                "props 仍须按核心故事提示中的结构输出道具对象，并为每项补齐剧情功能、实体识别设计、可固化状态和事实/推断依据。",
            ]
        ),
    }


async def generate_story_bible(
    project: dict[str, Any],
    options: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    config: AiConfig | None = None,
) -> dict[str, Any]:
    """Node generateStoryBible：两段式故事设定生成（mock 直接抛错）。

    :param project: 项目行。
    :param options: ``{"idea", "episodeCount"}``。
    :param client: 注入的 httpx.AsyncClient。
    :param config: AI 配置；缺省读环境。
    :returns: 归一后的故事设定。
    :raises AiProviderError: 模型调用失败（刻意不回退 mock，Node 同）。
    :raises ValueError: 模型输出无可用水产出。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        raise AiProviderError("当前为 mock 模式，不会真实调用模型生成故事设定")
    core_prompts = _build_core_story_bible_prompts(project, options)
    core_result = await generate_structured_json(
        task="story-bible",
        system_prompt=core_prompts["systemPrompt"],
        user_prompt=core_prompts["userPrompt"],
        client=client,
        config=active_config,
        model=active_config.outline_model or active_config.default_model,
        temperature=0.6,
        max_tokens=5200,
        thinking={"type": "disabled"},
    )
    core = normalize_generated_story_bible(core_result["json"], project)
    world_prompts = _build_world_story_bible_prompts(project, options, core)
    world_result = await generate_structured_json(
        task="story-bible",
        system_prompt=world_prompts["systemPrompt"],
        user_prompt=world_prompts["userPrompt"],
        client=client,
        config=active_config,
        model=active_config.outline_model or active_config.default_model,
        temperature=0.5,
        max_tokens=3200,
        thinking={"type": "disabled"},
    )
    return normalize_generated_story_bible({**core, **(world_result["json"] if isinstance(world_result["json"], dict) else {})}, project)


# ---------------------------------------------------------------------------
# ai/season-structure.mjs
# ---------------------------------------------------------------------------


def _build_season_structure_prompts(project: dict[str, Any], bible: dict[str, Any], episode_count: Any) -> dict[str, str]:
    """Node buildSeasonStructurePrompts：分集大纲提示词。"""
    count = max(1, min(50, int(episode_count or 1)))
    genre_context = build_genre_prompt_context(project.get("category"))
    system_prompt = "\n".join(
        [
            "你是影视项目的季播结构编剧。",
            "请把故事圣经拆成可以直接进入剧本阶段的分集结构。",
            "只返回 JSON，不要 Markdown、解释或额外字段。",
            "JSON 必须包含 seasonTheme、coreConflict、structureType、episodeCount、episodes、foreshadowingPlan、characterArcs。",
            "episodes 必须正好有计划集数，每集必须包含 episodeNo、title、logline、openingHook、goal、coreConflict、irreversibleChange、endingHook、protagonistChoice、reversal、visualSetPieces。",
            "每集要有主动选择、明确冲突和不可逆变化，结尾留下推动下一集的钩子。",
            f"计划集数：{count}",
            genre_context,
        ]
    )
    user_prompt = "\n".join(
        [
            f"项目：{_text(project.get('name'))}",
            f"类型：{_text(project.get('category'))}",
            f"视觉方向：{_text(project.get('visual_style') or project.get('visualStyle'))}",
            f"一句话故事：{_text(bible.get('logline'))}",
            f"故事主线：{_text(bible.get('mainPlot'))}",
            f"人物：{json.dumps(bible.get('characters') or [], ensure_ascii=False)}",
            f"世界规则：{json.dumps(bible.get('worldRules') or [], ensure_ascii=False)}",
            f"伏笔：{json.dumps(bible.get('foreshadowing') or [], ensure_ascii=False)}",
            genre_context,
            "",
            f"请生成 {count} 集完整分集结构。",
        ]
    )
    return {"systemPrompt": system_prompt, "userPrompt": user_prompt}


def _season_normalize_episode(item: dict[str, Any], index: int) -> dict[str, Any]:
    """ai/season-structure.mjs normalizeEpisode。"""
    try:
        episode_no = float(item.get("episodeNo"))
    except (TypeError, ValueError, AttributeError):
        episode_no = 0
    return {
        "episodeNo": int(episode_no) if episode_no > 0 else index + 1,
        "title": _text(item.get("title")),
        "logline": _text(item.get("logline")),
        "openingHook": _text(item.get("openingHook")),
        "goal": _text(item.get("goal")),
        "coreConflict": _text(item.get("coreConflict")),
        "irreversibleChange": _text(item.get("irreversibleChange")),
        "endingHook": _text(item.get("endingHook")),
        "protagonistChoice": _text(item.get("protagonistChoice")),
        "reversal": _text(item.get("reversal")),
        "visualSetPieces": _bible_list(item.get("visualSetPieces")),
    }


async def generate_season_structure(
    project: dict[str, Any],
    bible: dict[str, Any],
    options: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    config: AiConfig | None = None,
) -> dict[str, Any]:
    """Node generateSeasonStructure：分集大纲生成（mock 直接抛错）。

    :param project: 项目行。
    :param bible: 最新故事设定（storyBibleRow 形态）。
    :param options: ``{"episodeCount"}``。
    :param client: 注入的 httpx.AsyncClient。
    :param config: AI 配置；缺省读环境。
    :returns: 分集大纲 DTO。
    :raises AiProviderError: 模型调用失败。
    :raises ValueError: 模型返回的分集大纲不完整。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        raise AiProviderError("当前为 mock 模式，不会真实调用模型生成分集大纲")
    episode_count = options.get("episodeCount", 1)
    prompts = _build_season_structure_prompts(project, bible, episode_count)
    result = await generate_structured_json(
        task="season-structure",
        system_prompt=prompts["systemPrompt"],
        user_prompt=prompts["userPrompt"],
        client=client,
        config=active_config,
        model=active_config.outline_model or active_config.default_model,
        temperature=0.75,
    )
    payload = result["json"] if isinstance(result["json"], dict) else {}
    count = max(1, min(50, int(episode_count or 1)))
    payload_episodes = payload.get("episodes") if isinstance(payload.get("episodes"), list) else []
    episodes = [_season_normalize_episode(payload_episodes[index] if index < len(payload_episodes) else {}, index) for index in range(count)]
    if any(not episode["title"] or not episode["logline"] for episode in episodes):
        raise ValueError("模型返回的分集大纲不完整，请重试或补充故事设定")
    return {
        "seasonTheme": _text(payload.get("seasonTheme")) or _text(bible.get("logline")),
        "coreConflict": _text(payload.get("coreConflict")) or _text(bible.get("mainPlot")),
        "structureType": _text(payload.get("structureType")) or "linear",
        "episodeCount": count,
        "episodes": episodes,
        "foreshadowingPlan": _bible_list(payload.get("foreshadowingPlan")),
        "characterArcs": _bible_list(payload.get("characterArcs")),
    }


# ---------------------------------------------------------------------------
# ai/script.mjs：单场景剧本
# ---------------------------------------------------------------------------


def build_scene_script_prompts(ctx: dict[str, Any]) -> dict[str, str]:
    """Node buildSceneScriptPrompts（ai/prompts/script.mjs）：单场剧本提示词。"""
    scene = ctx.get("scene") or {}
    outline = ctx.get("outline") or {}
    story_bible = ctx.get("storyBible") or {}
    season_structure = ctx.get("seasonStructure") or {}
    project = ctx.get("project") or {}
    episode = None
    if isinstance(season_structure.get("episodes"), list):
        episode = next(
            (
                item
                for item in season_structure["episodes"]
                if float(item.get("episodeNo") or 0) == float(scene.get("episode_no", scene.get("episodeNo", 1)))
            ),
            None,
        )
    genre_context = build_genre_prompt_context(project.get("category"))
    system_prompt = " ".join(
        [
            "你是专业影视编剧，擅长把项目总纲和场景摘要扩展为单场景剧本。",
            "你必须只返回 JSON，不要输出解释、Markdown、代码块。",
            "字段必须严格使用这些 key：scene_no, title, summary, content, mood, location, time_of_day, estimated_duration。",
            "content 必须是完整的单场戏正文，允许包含动作描写、氛围描写、对白和转场感。",
            "estimated_duration 必须是正整数，单位是秒。",
            "文本要可继续流转到分镜生成阶段，避免空泛概述。",
            genre_context,
        ]
    )
    user_prompt = "\n".join(
        [
            f"项目名：{project.get('name') or '未命名项目'}",
            f"题材：{project.get('category') or '剧情'}",
            f"视觉风格：{project.get('visualStyle') or '电影感写实'}",
            f"项目叙事愿景：{project.get('narrativeVision') or ''}",
            f"总纲标题：{outline.get('title') or project.get('name') or '本片'}",
            f"总纲 premise：{outline.get('premise') or ''}",
            f"故事一句话：{story_bible.get('logline') or ''}",
            f"故事主线：{story_bible.get('mainPlot') or ''}",
            f"角色设定：{json.dumps(story_bible.get('characters') or [], ensure_ascii=False)}",
            f"世界规则：{json.dumps(story_bible.get('worldRules') or [], ensure_ascii=False)}",
            f"本集结构：{json.dumps(episode or {}, ensure_ascii=False)}",
            f"当前集数：{scene.get('episode_no', scene.get('episodeNo', 1))}",
            f"当前场景编号：{scene.get('scene_no') or 1}",
            f"当前场景标题：{scene.get('title') or '未命名场景'}",
            f"当前场景摘要：{scene.get('summary') or ''}",
            f"场景地点：{scene.get('location') or '未知地点'}",
            f"时间：{scene.get('time_of_day') or '夜'}",
            genre_context,
            f"预估时长（秒）：{scene.get('estimated_duration') or 120}",
            "",
            "请输出一个适合影视开发的一场戏：",
            "- content 要是完整正文，不是提纲",
            "- 要有明确情绪和推进",
            "- 可以写对白，但不要过度舞台说明化",
            "- mood 需要概括本场戏情绪",
            "- summary 需要保留为本场戏摘要",
        ]
    )
    return {"systemPrompt": system_prompt, "userPrompt": user_prompt}


async def generate_scene_script(
    ctx: dict[str, Any], *, client: httpx.AsyncClient, config: AiConfig | None = None
) -> dict[str, Any]:
    """Node generateSceneScript：mock 生成器 / 真实调用失败回退 mock。

    :param ctx: ``{"scene", "outline", "storyBible", "seasonStructure", "project"}``。
    :param client: 注入的 httpx.AsyncClient。
    :param config: AI 配置；缺省读环境。
    :returns: normalizeSceneScriptPayload 后的剧本 DTO。
    :raises AiProviderError: 真实模式失败且 fallbackToMock=false。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        return generate_mock_scene_script(ctx)
    prompts = build_scene_script_prompts(ctx)
    try:
        result = await generate_structured_json(
            task="scene-script",
            system_prompt=prompts["systemPrompt"],
            user_prompt=prompts["userPrompt"],
            client=client,
            config=active_config,
            model=active_config.script_model,
            temperature=0.85,
        )
        return normalize_scene_script_payload(result["json"], ctx)
    except AiProviderError:
        if active_config.fallback_to_mock:
            return generate_mock_scene_script(ctx)
        raise


# ---------------------------------------------------------------------------
# ai/storyboard.mjs：分镜生成
# ---------------------------------------------------------------------------

_STORYBOARD_SYSTEM_PROMPT = (
    "你是 AI 漫剧分镜导演。请把单场剧本拆成可拍摄的连续镜头列表，只返回 JSON："
    '{"shots":[{"shot_no","shot_type","camera_angle","composition","duration_seconds",'
    '"duration_breakdown":[{"phase","seconds","observable"}],"duration_basis",'
    '"character_name","action_text","dialogue_text","visual_prompt","acting_beat",'
    '"audio_direction","shot_purpose","reaction_shot","start_state","end_state",'
    '"start_visual_prompt","end_visual_prompt","character_assets","scene_assets","prop_assets","tools"}]}。'
    "visual_prompt 必须以「时间轴：0-N秒，…；镜头：…；位置：…；动作：…；要求：…」格式写清"
    "单一可见动作及其结果；duration_breakdown 各段 seconds 之和必须等于 duration_seconds。"
    "不要输出英文、Markdown 或解释。"
)


def _build_storyboard_user_prompt(ctx: dict[str, Any], video_duration_range: dict[str, int]) -> str:
    """Node buildStoryboardPrompts（ai/prompts/storyboard.mjs）的等价上下文构造。"""
    scene = ctx.get("scene") or {}
    project = ctx.get("project") or {}
    characters = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "roleTag": item.get("role_tag", item.get("roleTag")),
            "appearance": item.get("appearance"),
            "ageGroup": item.get("age_group", item.get("ageGroup")),
            "gender": item.get("gender"),
        }
        for item in (ctx.get("characters") or [])
    ]
    return json.dumps(
        {
            "输出格式": {
                "shots": [
                    {
                        "shot_no": 1,
                        "shot_type": "中景",
                        "duration_seconds": video_duration_range["min"],
                        "duration_breakdown": [{"phase": "主要动作与结果", "seconds": video_duration_range["min"], "observable": "可观察动作"}],
                        "duration_basis": "按单一可见动作及其结果停留时长规划。",
                        "visual_prompt": "时间轴：0-4秒，…；镜头：…；位置：…；动作：…；要求：…",
                    }
                ]
            },
            "项目": {
                "name": project.get("name"),
                "visualStyle": project.get("visualStyle"),
                "category": project.get("category"),
                "narrativeVision": project.get("narrativeVision"),
            },
            "场景": {"sceneNo": scene.get("scene_no"), "title": scene.get("title"), "summary": scene.get("summary")},
            "剧本正文": ctx.get("scriptContent"),
            "总纲": ctx.get("outline"),
            "可用角色": characters,
            "资产目录": ctx.get("assetCatalog"),
            "RAG 上下文": ctx.get("ragContext"),
            "要求": [
                f"每个镜头 duration_seconds 必须在 {video_duration_range['min']}-{video_duration_range['max']} 秒之间。",
                "duration_breakdown 各段 seconds 之和必须等于 duration_seconds。",
                "visual_prompt 必须以「时间轴：0-N秒，…」开头并连续覆盖整镜。",
                "character_name 必须严格使用可用角色列表里的姓名，或留空。",
                "对白请写进 dialogue_text，时长必须容纳自然语速。",
            ],
        },
        ensure_ascii=False,
    )


async def generate_storyboards(
    ctx: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    config: AiConfig | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Node generateStoryboards：mock 规则化 / 真实两次尝试 + 契约校验 + 回退。

    :param ctx: ``{"sceneId", "scene", "scriptContent", "outline", "project",
        "characters", "assetCatalog", "ragContext"}``。
    :param client: 注入的 httpx.AsyncClient。
    :param config: AI 配置；缺省读环境。
    :param env: 视频模型时长区间判定的环境快照。
    :returns: ``{"scene_id", "shots"}``。
    :raises ValueError: mock 时长规划无效；真实模式契约两次失败（Node 422 形态）。
    :raises AiProviderError: 真实模式失败且 fallbackToMock=false。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        return generate_mock_storyboards(ctx, env)
    from app.ai_provider import resolve_ai_request_timeout_ms  # 局部引用避免环

    video_duration_range = {"min": 1, "max": 30} if env is None else _range_from_env(env)
    user_prompt = _build_storyboard_user_prompt(ctx, video_duration_range)
    blockers: list[str] = []
    try:
        for attempt in range(2):
            correction = "" if attempt == 0 else (
                f"\n上一次输出未通过时长或镜头内时间轴契约，请只修正这些问题后重新输出完整 JSON：{'；'.join(blockers)}"
            )
            result = await generate_structured_json(
                task="storyboard",
                system_prompt=_STORYBOARD_SYSTEM_PROMPT,
                user_prompt=f"{user_prompt}{correction}",
                client=client,
                config=active_config,
                model=active_config.storyboard_model,
                temperature=0.2,
                response_format={"type": "json_object"},
            )
            normalized = normalize_storyboard_payload(result["json"], ctx)
            contract = validate_storyboard_duration_contracts(normalized["shots"], {"requireVisibleTimeline": True})
            model_blockers = _validate_configured_video_durations(normalized["shots"], env)
            if contract["passed"] and not model_blockers:
                return normalized
            blockers = [*contract["blockers"], *model_blockers]
        raise StoryboardContractError(
            f"分镜 Agent 两次输出均未通过时长规划校验：{'；'.join(blockers)}"
        )
    except StoryboardContractError:
        raise
    except AiProviderError:
        if not active_config.fallback_to_mock:
            raise
        return generate_mock_storyboards(ctx, env)


def _range_from_env(env: dict[str, str]) -> dict[str, int]:
    """从环境快照计算视频时长区间（委托 storyboard_ai 的实现）。"""
    from app.domain.storyboard_ai import get_configured_video_duration_range

    return get_configured_video_duration_range(env)


# ---------------------------------------------------------------------------
# ai/frame-prompt.mjs：静帧视觉提示词重写
# ---------------------------------------------------------------------------


def _normalize_frame_rewrite_payload(payload: Any, ctx: dict[str, Any]) -> dict[str, str]:
    """ai/frame-prompt.mjs normalizePayload：visualPrompt 空则回退 mock。"""
    payload = payload if isinstance(payload, dict) else {}
    visual_prompt = _text(payload.get("visual_prompt") or payload.get("visualPrompt"))
    return {
        "visualPrompt": visual_prompt or build_mock_visual_prompt(ctx),
        "notes": _text(payload.get("notes")),
    }


async def rewrite_frame_visual_prompt(
    ctx: dict[str, Any], *, client: httpx.AsyncClient, config: AiConfig | None = None
) -> dict[str, str]:
    """Node rewriteFrameVisualPrompt：AI 重写提示词（mock/真实失败走兜底）。

    :param ctx: buildFramePromptRewriteContext 的上下文（project/outline/scene/
        storyboard/characters/frameCharacterContext）。
    :param client: 注入的 httpx.AsyncClient。
    :param config: AI 配置；缺省读环境。
    :returns: ``{"visualPrompt", "notes"}``。
    :raises AiProviderError: 真实模式失败且 fallbackToMock=false。
    """
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        return {
            "visualPrompt": build_mock_visual_prompt(ctx),
            "notes": "当前为 mock 模式，已按上下文生成兜底视觉提示词。",
        }
    project = ctx.get("project") or {}
    outline = ctx.get("outline") or {}
    scene = ctx.get("scene") or {}
    storyboard = ctx.get("storyboard") or {}
    characters = ctx.get("characters") or []

    def clip(value: Any, max_length: int) -> str:
        return _text(value)[:max_length]

    def shot_brief(shot: dict[str, Any]) -> str:
        return "\n".join(
            part
            for part in (
                f"分镜号：{shot.get('shot_no', shot.get('shotNo'))}" if shot.get("shot_no", shot.get("shotNo")) else "",
                f"景别：{shot.get('shot_type', shot.get('shotType'))}" if shot.get("shot_type", shot.get("shotType")) else "",
                f"机位：{shot.get('camera_angle', shot.get('cameraAngle'))}" if shot.get("camera_angle", shot.get("cameraAngle")) else "",
                f"构图：{shot.get('composition')}" if shot.get("composition") else "",
                f"出镜角色：{shot.get('character_name', shot.get('characterName'))}" if shot.get("character_name", shot.get("characterName")) else "",
                f"原动作：{shot.get('action_text', shot.get('actionText'))}" if shot.get("action_text", shot.get("actionText")) else "",
                f"对白：{shot.get('dialogue_text', shot.get('dialogueText'))}" if shot.get("dialogue_text", shot.get("dialogueText")) else "",
                f"原视觉提示词：{clip(shot.get('visual_prompt', shot.get('visualPrompt')), 800)}" if shot.get("visual_prompt", shot.get("visualPrompt")) else "",
            )
            if part
        )

    def character_line(character: dict[str, Any]) -> str:
        return "；".join(
            part
            for part in (
                f"姓名={character.get('name') or ''}",
                f"身份={character.get('role_tag', character.get('roleTag')) or ''}",
                f"性别={character.get('gender') or '未明确'}",
                f"年龄段={character.get('age_group', character.get('ageGroup')) or '未明确'}",
                ("已确认定妆图=是" if character.get("reference_image_url", character.get("referenceImageUrl")) else "已确认定妆图=否"),
                (f"固定外貌已存在，禁止在视觉提示词中重新描述脸、发型、服装" if character.get("appearance") else ""),
            )
            if part
        )

    system_prompt = " ".join(
        [
            "你是电影分镜导演和静帧提示词设计师，擅长根据剧情上下文生成可执行的图像生成提示词。",
            "你必须只返回 JSON，不要输出解释、Markdown、代码块或额外说明。",
            "返回顶层 key 只能包含 visual_prompt 和 notes。",
            "visual_prompt 必须是中文为主，可直接用于静帧生成。",
            "visual_prompt 只负责场景、动作、情绪、机位、构图、光线、道具、空间层次和画面重点。",
            "严禁在 visual_prompt 中重新发明或改写角色脸型、五官、发型、服装、年龄、体态、随身物件。",
            "角色外貌由系统后续的定妆图和角色一致性硬约束接管。你只可以使用准确角色姓名来指代人物。",
            "如果原视觉提示词里包含角色外貌，必须剥离这些外貌细节，只保留剧情动作和场景调度。",
            "不要输出“保持同一张脸”等一致性硬约束，这部分由系统自动追加。",
        ]
    )
    user_prompt = "\n".join(
        [
            f"项目名：{_text(project.get('name'), '未命名项目')}",
            f"项目题材：{_text(project.get('category'), '剧情')}",
            f"项目固定视觉风格：{_text(project.get('visual_style') or project.get('visualStyle'), '电影感写实风格')}",
            f"叙事愿景：{clip(project.get('narrative_vision') or project.get('narrativeVision'), 500)}",
            f"总纲标题：{_text(outline.get('title'), project.get('name') or '本片')}",
            f"总纲概要：{clip(outline.get('summary') or outline.get('premise') or outline.get('content'), 800)}",
            "",
            f"场景编号：{scene.get('scene_no', scene.get('sceneNo', 1))}",
            f"场景标题：{_text(scene.get('title'), '未命名场景')}",
            f"场景地点：{_text(scene.get('location'), '未知地点')}",
            f"时间：{_text(scene.get('time_of_day') or scene.get('timeOfDay'), '夜')}",
            f"场景摘要：{clip(scene.get('summary'), 800)}",
            f"场景剧本正文：{clip(scene.get('content'), 1400)}",
            "",
            "当前分镜：",
            shot_brief(storyboard),
            "",
            ("项目角色清单（仅用于姓名和身份理解，不要改写外貌）：" if characters else ""),
            "\n".join(character_line(character) for character in characters),
            "",
            "输出要求：",
            "1. 生成 1 段完整 visual_prompt，长度建议 120 到 260 个中文字符。",
            "2. 必须体现这一镜真正发生的动作或信息变化，不要只写氛围。",
            "3. 必须包含景别、机位、构图、环境、光线和情绪。",
            "4. 人物出镜时只写准确角色姓名和动作，不写新的脸、发型、服装等外貌描述。",
            "5. 画面应适合直接生成静帧，不要写抽象导演说明。",
        ]
    )
    try:
        result = await generate_structured_json(
            task="frame-prompt-rewrite",
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            client=client,
            config=active_config,
            model=active_config.storyboard_model or active_config.default_model,
            temperature=0.62,
        )
        return _normalize_frame_rewrite_payload(result["json"], ctx)
    except AiProviderError as exc:
        if active_config.fallback_to_mock:
            return {
                "visualPrompt": build_mock_visual_prompt(ctx),
                "notes": f"真实模型重写失败，已使用兜底提示词：{exc}",
            }
        raise


def build_scene_space_anchor_prompt(scene: dict[str, Any], repair_reason: str = "") -> dict[str, str]:
    """Node buildSceneSpaceAnchorPrompt：场景空间锚点提取提示词。"""
    title = _text(scene.get("title"), "未命名场景")
    location = _text(scene.get("location"), "剧本未明确地点，请依据动作路径推断")
    time_of_day = _text(scene.get("time_of_day") or scene.get("timeOfDay"), "依据剧情推断")
    evidence = "\n".join(
        value for value in (_text(scene.get("summary")), _text(scene.get("content"))) if value
    )
    system_prompt = "\n".join(
        value for value in [
            "你是影视场景空间资产规划 Agent。只把剧本证据转换成可复用的空间锚点与拍摄光材质方案，不生成图片提示词，不补写剧情。",
            '严格返回 JSON 对象：{"spatial_anchors":{"version":1,"anchors":[{"id":"A1","category":"architecture|opening|fixed_furniture|material|light","label":"","description":"","relative_position":"","evidence":"","origin":"script|inference","narrative_reason":""}],"view_bindings":{"front-left":["A1","A2"],"front":["A1","A2"],"front-right":["A1","A2"],"left":["A1","A2"],"center":["A1","A2"],"right":["A1","A2"],"back-left":["A1","A2"],"back":["A1","A2"],"back-right":["A1","A2"]}}}。',
            "anchors 至少包含两个稳定的建筑、门窗或固定家具锚点，并包含至少一个 material 和一个 light 锚点。每个锚点写清相对位置、可见特征和剧情证据；origin=script 表示剧本明确，origin=inference 表示合理推断。不得伪称推断内容来自剧本。",
            "必须完整锚定本场剧本明确出现的固定设施、家具与实体灯具。设施即使出现在动作句中也不能漏掉：只提取静态设施本身作为空场锚点，不把人物、动作或可移动剧情道具写进空间资产。修复时必须补齐校验列出的设施。",
            "材质必须依据地点用途、角色长期使用痕迹、剧情道具接触方式和情绪质感设计；光源必须依据时间、天气、剧情氛围和可见灯具设计，写清实体光源、方向、色温/色彩、照射范围与衰减。material 与 light 都要用 narrative_reason 说明剧情设计依据。",
            "材质与光线不是全项目固定色板。不得机械套用审讯室、冷蓝环境光、暖黄台灯、红色警示灯等固定示例；没有剧情依据时选择克制、现实、符合地点功能的方案。禁止无来源全局色彩滤镜。",
            "view_bindings 的值只能是 anchors 中真实存在的 id，不能写名称或类别；九个固定机位都至少绑定两个 architecture/opening/fixed_furniture ID，按相对位置和墙体遮挡判断可见性，material/light ID 不可绑定为画面参照。",
            f"上次输出未通过程序校验：{repair_reason}。请先修正该错误，再返回完整 JSON。"
            if repair_reason else "",
            "空间无法从剧本确定时，给出最小合理推断并标记 origin=inference；不要为凑锚点虚构复杂建筑或剧情道具。",
        ] if value
    )
    user_prompt = "\n".join([
        f"场景：{title}",
        f"地点：{location}",
        f"时间：{time_of_day}",
        f"上次校验缺失的固定设施：{repair_reason or '无'}",
        "场景剧情证据：",
        evidence or "剧本未提供具体空间细节，请只推断容纳该场戏所需的最小空间。",
        "",
        "请输出可持久化、供全景和九视角共同引用的 spatial_anchors。材质和光线要服务本场剧情，不沿用其它场景模板。",
    ])
    return {"systemPrompt": system_prompt, "userPrompt": user_prompt}


async def generate_scene_space_anchors(
    scene: dict[str, Any],
    *,
    client: httpx.AsyncClient,
    config: AiConfig | None = None,
    repair_reason: str = "",
) -> dict[str, Any]:
    """用剧本 Agent 提取并归一化场景空间锚点；失败时抛错，不做本地伪造。"""
    active_config = config or get_ai_config()
    if is_mock_provider(active_config):
        raise AiProviderError("当前为 mock 模式，不会真实提取场景空间锚点")
    prompts = build_scene_space_anchor_prompt(scene, repair_reason)
    result = await generate_structured_json(
        task="scene-space-anchors",
        system_prompt=prompts["systemPrompt"],
        user_prompt=prompts["userPrompt"],
        client=client,
        config=active_config,
        model=active_config.script_model or active_config.default_model,
        temperature=0.1,
    )
    payload = result["json"]
    if isinstance(payload, dict) and "spatial_anchors" in payload:
        payload = payload["spatial_anchors"]
    return normalize_scene_space_manifest(payload)
