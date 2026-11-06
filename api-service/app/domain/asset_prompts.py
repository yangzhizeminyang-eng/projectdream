"""资产画布提示词构建器（Node services/asset-character-prompt.mjs、asset-node-prompt.mjs、
ai/prompt-template-skill.mjs、ai/skills/production-prompt-rules.mjs、asset-props.mjs、
scene-space-manifest.mjs 纯函数子集的 Python 复刻）。

本模块只做纯计算：提示词模板技能上下文、生产提示词规则、角色/场景/道具资产提示词、
节点生成提示词与快照。逐字段语义以
``tests/fixtures/generate_asset_node_fixtures.mjs``（Node 直调产物）锁定。
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .storyboard_ai import build_genre_prompt_context
from .video_generation import build_color_continuity_constraints

# ---------------------------------------------------------------------------
# ai/prompt-template-skill.mjs
# ---------------------------------------------------------------------------

PROMPT_TEMPLATE_SKILL_VERSION = "prompt-template-skill-v1"

PROMPT_TEMPLATE_SOURCES: dict[str, str] = {
    "character": "角色生成提示词模板.txt + 角色三视图.txt",
    "scene": "场景生成提示词模板.txt",
    "prop": "图像提示词构建器.skill + 道具资产约束",
    "storyboard": "分镜脚本提示词模板.txt + 草图故事板提示词.txt",
}

SCOPED_CONTEXT: dict[str, list[str]] = {
    "character": [
        "模板结构：人物基础特征、头部细节、身体与穿搭、技术与环境限制。",
        "头部细节：脸型、眉毛、眼睛、眼睑、瞳孔、鼻子、鼻翼、嘴唇、耳廓、耳垂、下颌线、肤色、毛孔和自然细纹；脸型、眉毛、眼睛、鼻子、嘴唇、耳廓和下颌线都必须可复核。",
        "发型细节：发色、发际线、分缝、刘海、鬓角、发量、长度、发尾和后脑勺结构；妆容和发长必须在所有视角保持一致。",
        "身体与穿搭：身高体态、肩宽、四肢比例、手掌、五根手指、关节、腿部、脚型、鞋子、版型、面料、接缝、纽扣、褶皱和固定配饰。",
        "构图约束：单人正面、标准 A-Pose、正交平视、零广角畸变、从头到脚完整呈现、双脚鞋子完整入镜、四周保留安全边距。",
        "角色资产先锁定单人正面全身基准；基础角色资产使用纯白纯色背景、无纹理、无渐变、无场景、无道具、无文字、无水印和均匀柔和漫射光。",
        "角色资产只描述角色身份与人体/服装可见信息，禁止写场景结构、剧情动作、对白、环境光源或其他角色。",
    ],
    "scene": [
        "场景 Agent 只负责空场空间资产。全景阶段必须输出可持久化的 spatial_anchors JSON：version、anchors、view_bindings；锚点类别只能是 architecture、opening、fixed_furniture、material、light，并带稳定 ID、描述、相对位置、剧情证据、origin（script/inference）和 narrative_reason。",
        "空间锚点根据当前剧情、地点功能、人物行动路径和镜头需要推导；剧本事实标 origin=script，合理补足标 origin=inference 并说明依据，不把推断伪装成剧本事实。",
        "材质与光源必须根据本场剧情设计：材质结合地点用途、使用历史、道具接触和情绪质感；光源结合时间天气、剧情氛围和实体灯具，说明位置、方向、色温/色彩、照射范围与衰减。每项 material/light 都写 narrative_reason。",
        "材质与光线不复用全项目固定色板，不得机械套用审讯室、冷蓝环境光、暖黄台灯、红色警示灯等示例；避免无来源全局滤镜。",
        "场景资产提示词只描述可拍摄的空场：空间类型与功能、建筑结构和尺度、中心轴、入口出口、门窗方向、固定家具/设备、地面墙面天花板、物理材质磨损、实体光源、色彩关系和可见范围。禁止角色、人物照片/遗像/倒影、外貌、服装、动作、对白、声音、剧情事件、屏幕内容、字幕、文字和水印。",
        "先生成并采用唯一空场母版，再生成九个独立视角候选。九个机位名固定为左前、正前、右前、左侧、正中、右侧、左后、正后、右后；每个 view_binding 必须引用真实存在、按遮挡关系可见的 architecture/opening/fixed_furniture 锚点 ID，至少两个。子机位只写母版继承声明、固定原点下的 yaw/pitch/FOV 和锚点 ID，不重写空间布局、材质或光源。",
        "能力边界必须诚实：只有 360°等距柱状母版经过确定性透视投影才称为全景采样；普通宽幅母图传入生图模型是参考图引导候选，会发生重绘，不承诺零漂移或几何锁死。",
        "场景图必须是单张连续、完整、真实可拍摄的空环境，不是白板、占位图、局部物件特写、九宫格拼图或概念设计图。材质、磨损、曝光和光线衰减服从本场地点功能、使用历史、剧情物件接触、时段和情绪；每种光色绑定实体光源与照射范围，不使用无来源全局滤镜。",
    ],
    "prop": [
        "模板结构：道具身份与剧情用途、形状结构、材质与表面、色彩、尺寸比例、可识别细节、多视角和技术限制。",
        "本道具技能只生成资产库白底单体母版/视角参考，但道具外观必须从剧情提取：明确它推动的剧情信息、人物归属、可辨认的实体线索和可固化在本体上的剧情线索，避免生成只有通用外形的商品图。",
        "道具 Agent 输出名称、归属、剧情用途、叙事功能、外观、结构分件、开口、按钮、接口、可动部位、材质、尺寸、颜色、磨损、识别细节、可固化视觉状态和剧本依据；明确区分事实与推断，缺乏依据时不虚构品牌、型号、文字或损坏。",
        "剧情母版只落实道具本体特征与稳定状态，不包含场景、人物、手持、一次性动作或镜头构图；道具被发现、观看、拿取和操作的剧情画面由分镜 Agent 按当前剧本生成。",
        "带屏幕/文档的道具可表现剧情需要的无字界面布局或空白标签位；准确正文、编号、签名和账号交由后期合成，不要求图像模型生成可读文字。",
        "道具基础图默认只生成一件完整道具：正面三分之四视角、居中、四周留白、完整结构入镜；只有用户明确要求多视角时，才分别生成正面、严格侧面、背面和俯视，并只改变摄影机位置，保持比例、颜色、文字形状、部件数量和损伤位置一致。",
        "道具资产禁止角色、手持、人体、场景、漂浮、镜像、拼贴、九宫格、错误文字、水印、重复道具和不可能结构。",
        "纸张、文件、文件夹、标签、屏幕和其他文档类道具默认完全无字；不得出现标题、正文、字母、数字、乱码、签名、Logo 或水印。剧情只需要签名栏、边框或按钮时，只生成不含文字的几何结构；只有用户明确要求可读剧情标签时才允许该标签原样出现。",
    ],
    "storyboard": [
        "用户可见提示词采用紧凑分镜单，固定输出“时间轴、镜头、位置、动作、要求”，对白/旁白、声音按剧情需要输出；每项只写一次。",
        "单镜时间轴从0秒起算，按可见动作节拍连续划分，时间段总长严格等于本镜duration_seconds；剧中时刻单独说明，不输出时长选择依据。",
        "资产库母版与剧情镜头是不同任务：资产参考图只锁定角色/道具身份、外观和可识别细节；分镜只写本镜场景、动作、空间关系、机位和景别，不复制资产生成模板或展示构图。",
        "邮件、协议、档案标签、屏幕中的精确可读文字交由后期合成；提示词写界面区域层级及角色观看/操作，不能承诺生图或视频模型稳定生成准确中文正文。",
        "节奏约束：根据冲突升级、信息揭示、动作完成和反应落点决定镜头拆分与时长，避免平均分配和固定频率套模板；台词、冲突、停顿时长示例仅作参考，不作为硬规则。剧情信息不足时可用反应、道具、环境或动作结果镜头承接，但不得凭空添加剧情事实。",
        "表演约束：Agent内部分析情绪起点、触发、收束、微表情、呼吸、身体动作及连续性；必须另存 gaze_plan，明确视线目标、转移顺序、时间段、停留、眼睛先动/头部后跟和结束锁定。用户可见提示词只保留对模型有用的可拍摄动作，不要重复粘贴整组分析字段。",
        "声音约束：说话角色必须绑定@音色并写逐字对白；必须另存 sound_plan，拆分持续空间底床、动作拟音、声音进入时机和静音策略。声音栏目只写必要的声线、停顿、环境声与口型同步要求，不在对白和声音栏目重复台词。speech_duration_policy=preserve，不强行加速。",
        "资产约束：根据本镜实际出镜和操作内容使用准确的@角色、@场景、@道具和@音色引用，必要时补充@片段；资产详情来自已确认版本，不把普通文本名称当作绑定。",
        "连续性约束：下一镜首帧继承上一镜尾帧的站位、视线、姿态、道具位置、空间布局和情绪余波，必要时显式使用片段衔接与首尾帧参考。",
        "分镜提示词负责当前可执行镜头；精确字幕、邮件、代码和屏幕文字留给后期合成，不要求视频模型稳定生成可读文字。",
    ],
}


def _text(value: Any) -> str:
    """Node text()：``String(value ?? '').trim()`` 等价（None → 空串）。"""
    if value is None:
        return ""
    return str(value).strip()


def _first_value(*values: Any) -> str:
    """Node firstValue(...values)：首个非空 text 值。"""
    for value in values:
        normalized = _text(value)
        if normalized:
            return normalized
    return ""


def build_prompt_template_context(scope: Any = "") -> str:
    """Node buildPromptTemplateContext：作用域提示词模板技能上下文。

    :param scope: 作用域（character/scene/prop/storyboard）。
    :returns: 模板技能上下文文本；未知作用域返回空串。
    """
    normalized = _text(scope).lower()
    rules = SCOPED_CONTEXT.get(normalized)
    if not rules:
        return ""
    return "\n".join(
        [
            f"提示词模板技能：{PROMPT_TEMPLATE_SKILL_VERSION}",
            f"参考模板来源：{PROMPT_TEMPLATE_SOURCES[normalized]}",
            *rules,
        ]
    )


# ---------------------------------------------------------------------------
# ai/skills/production-prompt-rules.mjs
# ---------------------------------------------------------------------------

CHARACTER_ASSET_SKILL_RULES: list[str] = [
    "角色资产提示词只描述角色身份与可见人体信息：年龄感、脸型、眉眼比例、眼睑、瞳孔、鼻梁鼻翼、唇形、耳廓、下颌线、肤色和自然皮肤纹理。禁止描述场景、镜头事件、对白、环境光源或其他角色。",
    "发型必须写清发色、发际线、分缝、刘海、鬓角、发量、长度、后脑勺结构和固定妆容；服装必须写清版型、面料、颜色、接缝、纽扣、褶皱、鞋履与固定配饰。",
    "角色资产板必须一次生成横向16:9的一张完整母板：左侧基础全身，右上独立脸部特写，右下正面/严格90度侧面/背面三张全身；五个区域缺一不可，脸部特写不能被三视图替代或挤掉。",
    "脸部特写是五官、脸型、发际线和发型的身份基准；左侧正面全身图是体态、服装、鞋子和固定配饰基准；三视图必须逐一回看这两个基准，任何换脸、五官变形、脸型或发型漂移、体态比例漂移、服装配饰变化都使整板失效。",
    "视觉验收不等于排版验收：五个区域齐全只是第一关，必须逐区确认脸部特写、正面全身、三视图正面/侧面/背面的一致性；无法清楚比较时保持未通过，不得自动采用不确定结果。",
    "必须写人体真实性约束：自然轻微不对称、五根手指、可辨认关节与指甲、正确肩肘腕膝踝连接、左右成对鞋履。禁止换脸、年龄漂移、发长漂移、服装漂移、畸形肢体、塑料皮肤和裁切。",
]

PROP_ASSET_SKILL_RULES: list[str] = [
    "道具资产提示词只描述单一道具，不描述角色或场景；白底隔离不等于通用商品化设计。实体外观、可识别线索和稳定状态必须由道具的剧情身份与功能驱动，避免只按名称画普通商品。",
    "Agent 必须提取名称、归属、剧情用途、叙事功能、实体外观、材质结构、尺寸、可识别细节、可固化视觉状态和剧本依据；区分剧本事实与有依据的推断，缺少依据时不得虚构品牌、型号、文字、损坏或标记。",
    "道具母版只呈现本体特征与可长期保持的状态；场景、人物、手持关系、一次性动作和镜头景别属于分镜任务，不能混进白底资产提示词。",
    "带屏幕或文档的道具可以保留剧情所需的无字界面布局、空白标签位和抽象状态；未被剧本明确指定的文字留空，精确正文、编号、账号与签名交由后期合成。",
    "默认只生成一件完整道具基础图，不套用角色从头到脚或人体比例规则，也不默认生成多视角；只有用户明确要求道具多视角时，才建立独立的正面、侧面、背面或俯视任务。",
    "基础道具采用正面三分之四视角，居中，完整结构从最高点到底部接触面入镜，四周安全留白，道具约占画布60%至75%；背景为纯白或干净中性摄影棚背景，柔和均匀光线，保留自然接触阴影。道具必须像真实摄影而不是概念图：真实物理比例、材料反射、粗糙度、细小磨损、污渍、接缝、开口和附属部件清晰可见。禁止手持、人物、场景、悬浮、裁切、局部微距、重复道具、镜像、错误文字、无关装饰和不可能结构。",
    "纸张、文件、文件夹、标签、屏幕和其他文档类道具默认使用完全空白表面：不得生成标题、正文、字母、数字、乱码、签名、Logo 或水印；若剧情只需要签名栏、边框或按钮等结构，只保留不含文字的几何线条。只有用户明确提供并要求保留可读文字时，才把该文字列为唯一允许的剧情标签，其余文字一律拒绝。",
]


def join_production_prompt_rules(*groups: Any) -> str:
    """Node joinProductionPromptRules：规则组拍平后按行拼接。

    :param groups: 规则列表（或列表的列表）。
    :returns: 换行拼接文本。
    """
    lines: list[str] = []
    for group in groups:
        if isinstance(group, list):
            lines.extend(group)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# scene-space-manifest.mjs（extractExplicitSceneFixtures / normalizeSceneSpaceManifest）
# ---------------------------------------------------------------------------

SCENE_SPACE_VIEW_KEYS = [
    "front-left", "front", "front-right", "left", "center", "right", "back-left", "back", "back-right",
]

_ANCHOR_CATEGORIES = {"architecture", "opening", "fixed_furniture", "material", "light"}
_STRUCTURAL_CATEGORIES = {"architecture", "opening", "fixed_furniture"}

EXPLICIT_FIXTURE_RULES: list[dict[str, Any]] = [
    {"label": "传送窗口", "category": "fixed_furniture", "pattern": re.compile("传送窗口|传递窗口|传物窗口")},
    {"label": "值班台", "category": "fixed_furniture", "pattern": re.compile("值班台|服务台|接待台")},
    {"label": "监控回放设备", "category": "fixed_furniture", "pattern": re.compile("监控回放区|监控回放设备|监控屏幕|监控终端")},
    {"label": "档案柜", "category": "fixed_furniture", "pattern": re.compile("档案柜|文件柜")},
    {"label": "旧储物柜", "category": "fixed_furniture", "pattern": re.compile("旧储物柜|储物柜")},
    {"label": "绿色安全出口灯", "category": "light", "pattern": re.compile("绿色安全出口灯|安全出口灯|出口指示灯")},
    {"label": "台灯", "category": "light", "pattern": re.compile("台灯")},
]


def _scene_fixture_evidence(scene: dict[str, Any]) -> str:
    """Node sceneFixtureEvidence：取首个【】小节正文为证据。"""
    content = _text(scene.get("content"))
    sections = re.findall(r"【([^】]+)】([\s\S]*?)(?=【[^】]+】|$)", content)
    scoped_content = (sections[0][0] + sections[0][1]) if sections else content
    return "\n".join(
        value for value in (_text(scene.get("title")), _text(scene.get("summary")), scoped_content) if value
    )


def extract_explicit_scene_fixtures(scene: dict[str, Any] | None = None) -> list[dict[str, str]]:
    """Node extractExplicitSceneFixtures：从场景证据提取剧本明确固定设施。

    :param scene: 场景行（title/summary/content）。
    :returns: ``[{"label", "category"}]`` 列表。
    """
    evidence = _scene_fixture_evidence(scene or {})
    return [
        {"label": rule["label"], "category": rule["category"]}
        for rule in EXPLICIT_FIXTURE_RULES
        if rule["pattern"].search(evidence)
    ]


def normalize_scene_space_manifest(value: Any) -> dict[str, Any]:
    """Node normalizeSceneSpaceManifest：spatial_anchors JSON 校验与归一化。

    :param value: dict 或 JSON 字符串。
    :returns: ``{"version", "anchors", "view_bindings"}``。
    :raises ValueError: 结构/锚点/机位绑定不合法（文案与 Node 逐字一致）。
    """
    if isinstance(value, str):
        try:
            source = json.loads(value)
        except (TypeError, ValueError):
            raise ValueError("场景空间锚点必须是有效 JSON") from None
    elif isinstance(value, dict):
        source = value
    else:
        source = None
    if not isinstance(source, dict) or not isinstance(source.get("anchors"), list):
        raise ValueError("场景 Agent 未返回 spatial_anchors JSON")

    ids: set[str] = set()
    anchors: list[dict[str, str]] = []
    for item in source["anchors"]:
        item = item if isinstance(item, dict) else {}
        anchor_id = _text(item.get("id"))
        category = _text(item.get("category"))
        anchor = {
            "id": anchor_id,
            "category": category,
            "label": _text(item.get("label")),
            "description": _text(item.get("description")),
            "relative_position": _text(item.get("relative_position")),
            "evidence": _text(item.get("evidence")),
            "origin": _text(item.get("origin")),
            "narrative_reason": _text(item.get("narrative_reason")),
        }
        if not anchor_id or anchor_id in ids:
            raise ValueError(f"场景空间锚点 ID 缺失或重复：{anchor_id or 'empty'}")
        if category not in _ANCHOR_CATEGORIES:
            raise ValueError(f"场景空间锚点类别无效：{category or 'empty'}")
        if not anchor["label"] or not anchor["description"] or not anchor["relative_position"] or not anchor["evidence"]:
            raise ValueError(f"场景空间锚点 {anchor_id} 缺少名称、描述、相对位置或剧情证据")
        if anchor["origin"] not in ("script", "inference"):
            raise ValueError(f"场景空间锚点 {anchor_id} 必须标记来源为 script 或 inference")
        if category in ("material", "light") and not anchor["narrative_reason"]:
            raise ValueError("材质和光源锚点必须说明剧情设计依据")
        ids.add(anchor_id)
        anchors.append(anchor)

    categories = {anchor["category"] for anchor in anchors}
    if "material" not in categories or "light" not in categories:
        raise ValueError("场景空间锚点必须包含根据剧情设计的 material 与 light")

    view_bindings_raw = source.get("view_bindings")
    view_bindings: dict[str, list[str]] = {}
    for key in SCENE_SPACE_VIEW_KEYS:
        raw_ids = view_bindings_raw.get(key) if isinstance(view_bindings_raw, dict) else None
        bound_ids = list(dict.fromkeys(
            _text(item) for item in raw_ids if _text(item)
        )) if isinstance(raw_ids, list) else []
        structural_ids = [
            anchor_id for anchor_id in bound_ids
            if any(anchor["id"] == anchor_id and anchor["category"] in _STRUCTURAL_CATEGORIES for anchor in anchors)
        ]
        if len(structural_ids) < 2 or len(structural_ids) != len(bound_ids):
            raise ValueError(f"场景机位 {key} 必须绑定至少两个有效空间锚点")
        view_bindings[key] = structural_ids

    return {"version": 1, "anchors": anchors, "view_bindings": view_bindings}


# ---------------------------------------------------------------------------
# asset-props.mjs（buildPropAssetViewPrompt）
# ---------------------------------------------------------------------------

PROP_VIEW_KEYS = ["front", "side", "back", "top"]


def _normalize_prop_asset(item: Any, index: int = 0) -> dict[str, str]:
    """Node normalizePropAsset：道具描述 → 结构化字段 + 白底母版提示词。"""
    source: dict[str, Any] = {}
    if isinstance(item, dict):
        source = item
    elif isinstance(item, str):
        source = {"name": item}
    name = _first_value(source.get("name"), source.get("title"), source.get("label"), f"道具{index + 1}")
    purpose = _first_value(source.get("purpose"), source.get("function"), source.get("narrativeUse"), "服务当前剧情动作并保持外观可识别")
    narrative_role = _first_value(source.get("narrativeRole"), source.get("storyFunction"), purpose)
    owner = _first_value(source.get("owner"), source.get("associatedCharacter"))
    appearance = _first_value(source.get("appearance"), source.get("visualIdentity"))
    material = _first_value(source.get("material"), source.get("texture"), "符合现实物理属性的常见材质")
    shape = _first_value(source.get("shape"), source.get("form"), "结构完整、比例可信、边缘清晰")
    color = _first_value(source.get("color"), source.get("colour"), "自然、稳定、与项目视觉风格协调")
    dimensions = _first_value(source.get("dimensions"), source.get("size"), source.get("scale"), "与人物手部和场景比例真实")
    details = _first_value(source.get("details"), source.get("detail"), "关键接口、缝隙、磨损和连接关系清晰可见")
    visual_state = _first_value(source.get("visualState"), source.get("canonicalState"))
    script_evidence = _first_value(source.get("scriptEvidence"), source.get("evidence"))
    narrative_label = _first_value(
        source.get("narrativeLabel"), source.get("labelText"), source.get("inscription"), source.get("text")
    )
    prompt = "\n".join(
        [
            build_prompt_template_context("prop"),
            f"道具资产：{name}",
            f"剧情用途：{purpose}",
            f"叙事功能：{narrative_role}",
            f"剧情归属：{owner}" if owner else "",
            f"剧情专属外观：{appearance}" if appearance else "",
            f"形状结构：{shape}",
            f"材质与表面：{material}",
            f"色彩：{color}",
            f"尺寸比例：{dimensions}",
            f"可识别细节：{details}",
            f"可固化的剧情视觉状态：{visual_state}" if visual_state else "可固化的剧情视觉状态：无明确要求，不额外添加剧情痕迹或临时状态。",
            f"设计依据：{script_evidence}" if script_evidence else "设计依据：当前资料未提供可核实的细节；不得虚构品牌、型号、文字、损坏或专属标记。",
            f"剧情指定标签（允许原样出现在道具上）：{narrative_label}" if narrative_label else "剧情指定标签：无；标签、屏幕和按钮保持空白或不可读抽象纹理。",
            "生成真实可拍摄的单件剧情专属道具基础资产：白底只负责隔离展示，道具的实体设计、可识别线索和稳定视觉状态必须落实上方剧情用途与设计依据，不能生成无剧情特征的通用商品替代品。采用正面三分之四视角，完整展示从最左边缘到最右边缘、从最高点到底部接触面；道具主体居中，四周保留明确安全边距，道具占画布约60%至75%。",
            "只把可长期保持在道具本体上的设计与状态带入母版，例如固定划痕、缺损、颜色、部件或无字界面布局；一次性动作、手持方式、房间位置和镜头景别留给分镜，不描述剧情场景和操作动作。",
            "这是完整道具展示图，不是角色立绘、场景概念图或局部材质特写；禁止微距摄影、局部特写、细节裁切或只拍一部分，不得让任何边缘贴住画布边界，不得截断底座、把手、线缆、开口或附属结构。背景为纯白或干净中性无缝背景，无人物、无手持、无桌面、无场景、供应商水印、平台Logo或角标，也不生成其它道具。",
            f"只允许出现上面列出的剧情指定标签“{narrative_label}”；不得增加其它文字、乱码、错误数字或平台标记。" if narrative_label else "屏幕、标签、按钮和接口不得出现可读文字、字母、数字、邮件、剧情内容或乱码；带屏幕的设备必须使用空白暗屏或无文字抽象界面。",
            "任何模型水印都视为生成失败；剧情指定标签不等于平台水印，也不得把水印伪装成剧情标签。",
            "保留真实接触阴影、材质粗糙度、金属/玻璃/塑料的物理反射、细小磨损、污渍和接缝，避免塑料感、漂浮、重复结构、概念艺术和游戏渲染感。",
        ]
    )
    return {
        "name": name,
        "purpose": purpose,
        "material": material,
        "shape": shape,
        "color": color,
        "dimensions": dimensions,
        "details": details,
        "narrativeLabel": narrative_label,
        "narrativeRole": narrative_role,
        "owner": owner,
        "appearance": appearance,
        "prompt": prompt,
        "visualState": visual_state,
        "scriptEvidence": script_evidence,
    }


def build_prop_asset_view_prompt(prop: dict[str, Any] | None = None, view_key: Any = "front") -> str:
    """Node buildPropAssetViewPrompt：道具多视角一致性生成提示词。

    :param prop: 道具描述（name/details 等）。
    :param view_key: 视角键（front/side/back/top）。
    :returns: 提示词文本。
    :raises ValueError: 未知视角（文案与 Node 一致）。
    """
    normalized = _normalize_prop_asset(prop or {})
    views = {
        "front": "正面完整视角，结构和正面识别细节清晰",
        "side": "严格90度侧面完整视角，显示厚度、侧边结构和真实透视",
        "back": "背面完整视角，显示背部结构、接口和材质延续",
        "top": "正上方俯视完整视角，显示顶部布局、开口和部件关系",
    }
    view = views.get(_text(view_key))
    if not view:
        raise ValueError(f"未知道具视角：{_text(view_key)}")
    return "\n".join(
        [
            build_prompt_template_context("prop"),
            "任务类型：道具资产多视角一致性生成。",
            normalized["prompt"],
            f"本次只输出{view}。",
            "同一道具的名称、形状、材质、颜色、尺寸比例、磨损、接口和部件数量必须保持一致；只改变摄影机位置，不重设计道具。",
            "屏幕、标签和按钮不得出现可读文字、字母、数字、剧情内容或乱码；带屏幕的设备使用空白暗屏或无文字抽象界面。",
            "单件完整道具，完整边缘可见，四周有安全留白，道具占画布约60%至75%；禁止微距、局部特写、裁切、边缘出框、只显示细节。纯净背景，无人物、手、场景、可读文字、水印、拼贴、九宫格或多件重复道具；屏幕与标签保持空白或不可读抽象纹理。",
        ]
    )


# ---------------------------------------------------------------------------
# asset-character-prompt.mjs
# ---------------------------------------------------------------------------

NEGATIVE_PROMPT = "换脸、改变年龄、改变性别、第二个人、多人、半身裁切、缺失手脚、畸形手指、错误服装、文字、水印、Logo、低清晰度、过度模糊、重复角色"

_NO_FACE_RE = re.compile(r"不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见")
_LEGACY_PROMPT_RE = re.compile(r"固定服装与随身物件：[^\n]*(?:手机的手|翻找|似乎也捏着|捏着一枚同款)")
_TEMPORAL_STATE_RE = re.compile(r"(?:五年前|5年前|十八年前|18年前|童年|小时候|幼年|当前|现在|职场)")
_SCENE_DISPLAY_LABEL_LOCATION_RE = re.compile(r"会议室|离职协议|人事|合规")
_SCENE_DISPLAY_LABEL_APARTMENT_RE = re.compile(r"公寓|沙发|百叶窗|冷咖啡|冰箱")
_SCENE_DISPLAY_LABEL_OFFICE_RE = re.compile(r"办公室|书架|办公椅|摄像头")
_SCENE_DISPLAY_LABEL_SERVER_RE = re.compile(r"机房|服务器|主节点")
_SCENE_DISPLAY_LABEL_FUNERAL_RE = re.compile(r"葬礼|灵堂|花圈|遗照")
_SCENE_DISPLAY_NIGHT_RE = re.compile(r"深夜|凌晨|午夜|00:00|夜晚|夜里")
_SCENE_DISPLAY_DUSK_RE = re.compile(r"傍晚|黄昏")
_SCENE_DISPLAY_DAWN_RE = re.compile(r"清晨|早晨|黎明")
_SCENE_DISPLAY_HOOK_SIGN_RE = re.compile(r"签字|签署|签名栏")
_SCENE_DISPLAY_HOOK_MAIL_RE = re.compile(r"邮件|发件人")
_SCENE_DISPLAY_HOOK_PC_RE = re.compile(r"电脑|屏幕|代码|系统")
_SCENE_DISPLAY_HOOK_VIDEO_RE = re.compile(r"视频|监控|摄像头")
_SCENE_DISPLAY_HOOK_ARCHIVE_RE = re.compile(r"档案|日志|文件")


def _character_must_not_show_face(character: dict[str, Any]) -> bool:
    """Node characterMustNotShowFace：外貌/服装文本是否含不露脸约束。"""
    return bool(_NO_FACE_RE.search(f"{_text(character.get('appearance'))} {_text(character.get('costume'))}"))


def _scene_matches_character(scene: dict[str, Any], character_name: str) -> bool:
    """Node sceneMatchesCharacter：场景标题/摘要/正文/地点是否提及角色名。"""
    haystack = " ".join(
        _text(scene.get(key)) for key in ("title", "summary", "content", "location")
    )
    return bool(character_name) and character_name in haystack


def _infer_scene_label_location(scene: dict[str, Any]) -> str:
    """Node scene-label.mjs inferLocation（buildSceneDisplayLabel 专用）。"""
    explicit = _text(scene.get("location"))
    if explicit:
        return explicit
    source = " ".join(_text(scene.get(key)) for key in ("title", "summary", "content"))
    if _SCENE_DISPLAY_LABEL_LOCATION_RE.search(source):
        return "公司合规会议室"
    if _SCENE_DISPLAY_LABEL_APARTMENT_RE.search(source):
        return "深夜公寓客厅"
    if _SCENE_DISPLAY_LABEL_OFFICE_RE.search(source):
        return "公司办公室视频空间"
    if _SCENE_DISPLAY_LABEL_SERVER_RE.search(source):
        return "公司核心机房"
    if _SCENE_DISPLAY_LABEL_FUNERAL_RE.search(source):
        return "葬礼灵堂"
    return "未命名空间"


def _infer_scene_label_time(scene: dict[str, Any]) -> str:
    """Node scene-label.mjs inferTime（buildSceneDisplayLabel 专用）。"""
    explicit = _first_value(scene.get("timeOfDay"), scene.get("time_of_day"))
    if explicit:
        return explicit
    source = " ".join(_text(scene.get(key)) for key in ("title", "summary", "content"))
    if _SCENE_DISPLAY_NIGHT_RE.search(source):
        return "深夜"
    if _SCENE_DISPLAY_DUSK_RE.search(source):
        return "傍晚"
    if _SCENE_DISPLAY_DAWN_RE.search(source):
        return "清晨"
    return "当前时段"


def _infer_scene_label_hook(scene: dict[str, Any]) -> str:
    """Node scene-label.mjs inferHook（buildSceneDisplayLabel 专用）。"""
    source = f"{_text(scene.get('title'))} {_text(scene.get('summary'))} {_text(scene.get('content'))}"
    if _SCENE_DISPLAY_HOOK_SIGN_RE.search(source):
        return "离职协议签字前"
    if _SCENE_DISPLAY_HOOK_MAIL_RE.search(source):
        return "收到亡者邮件"
    if _SCENE_DISPLAY_HOOK_PC_RE.search(source):
        return "电脑异常启动"
    if _SCENE_DISPLAY_HOOK_VIDEO_RE.search(source):
        return "遗留视频画面"
    if _SCENE_DISPLAY_HOOK_ARCHIVE_RE.search(source):
        return "关键档案线索"
    return _first_value(scene.get("title"), "剧情关键空间")


def build_scene_display_label(scene: dict[str, Any] | None = None) -> str:
    """Node buildSceneDisplayLabel：场景画布显示标签（场景01 · 时间 · 钩子）。

    :param scene: 场景行。
    :returns: 展示标签文本。
    """
    scene = scene or {}
    raw_no = scene.get("sceneNo", scene.get("scene_no"))
    try:
        scene_no = int(raw_no)
    except (TypeError, ValueError):
        scene_no = 0
    prefix = f"场景{scene_no:02d}" if scene_no > 0 else "场景"
    location = _infer_scene_label_location(scene)
    time_label = _infer_scene_label_time(scene)
    hook = _infer_scene_label_hook(scene)
    return f"{prefix} · {time_label}{'' if time_label == '当前时段' else ' · '}{hook}"


def _scene_evidence(scene: dict[str, Any]) -> str:
    """Node sceneEvidence：标题/摘要/正文/地点/时间拼合证据。"""
    return " ".join(
        value
        for value in (
            _text(scene.get("title")),
            _text(scene.get("summary")),
            _text(scene.get("content")),
            _text(scene.get("location")),
            _text(scene.get("timeOfDay")),
            _text(scene.get("time_of_day")),
        )
        if value
    )


def _active_screenplay_location(scene: dict[str, Any]) -> str:
    """Node activeScreenplayLocation：从正文【场标】提取活跃地点。"""
    heading_match = re.search(r"【([^】]+)】", _text(scene.get("content")))
    if not heading_match:
        return ""
    return _text(re.sub(r"[·|｜]\s*\d{1,2}:\d{2}\s*$", "", re.sub(r"^\s*\d{1,2}:\d{2}\s*", "", heading_match.group(1))))


def infer_scene_location(scene: dict[str, Any] | None = None) -> str:
    """Node inferSceneLocation：证据规则推断场景地点（带推断依据说明）。"""
    scene = scene or {}
    explicit = _text(scene.get("location"))
    if explicit:
        return explicit
    source = _scene_evidence(scene)
    rules = [
        (re.compile("会议室|离职协议|人事流程|警示灯"), "公司合规会议室（根据正文中的离职签字、会议桌和警示灯推断）"),
        (re.compile("公寓|沙发|百叶窗|冷咖啡|冰箱嗡鸣"), "深夜公寓客厅与电脑工作区（根据正文中的沙发、百叶窗和电脑互动推断）"),
        (re.compile("办公室|书架顶端|办公椅|摄像头俯拍"), "公司老板办公室（视频画面，根据书架、办公椅和俯拍摄像头推断）"),
        (re.compile("机房|主节点|服务器机柜"), "公司核心机房（根据主节点、日志或服务器机柜推断）"),
        (re.compile("葬礼|灵堂|花圈|遗照"), "葬礼灵堂（根据悼词、花圈或遗照推断）"),
    ]
    for pattern, label in rules:
        if pattern.search(source):
            return label
    return ""


def infer_scene_time_of_day(scene: dict[str, Any] | None = None) -> str:
    """Node inferSceneTimeOfDay：证据规则推断场景时间（带推断依据说明）。"""
    scene = scene or {}
    explicit = _first_value(scene.get("timeOfDay"), scene.get("time_of_day"))
    if explicit:
        return explicit
    source = _scene_evidence(scene)
    if re.search(r"深夜|凌晨|午夜|00:00|夜里|夜晚|夜[。！？，,\s]", source):
        return "深夜（根据正文光线与时间线推断）"
    if re.search(r"傍晚|黄昏", source):
        return "傍晚（根据正文光线推断）"
    if re.search(r"清晨|早晨|黎明", source):
        return "清晨（根据正文光线推断）"
    if re.search(r"白天|上午|下午", source):
        return "白天（根据正文时间线推断）"
    return ""


def _unique_texts(values: list[Any]) -> list[str]:
    """保序去重的 text 列表。"""
    return list(dict.fromkeys(value for value in (_text(item) for item in values) if value))


def infer_character_costume_from_scenes(scenes: list[dict[str, Any]] | None, character_name: Any) -> str:
    """Node inferCharacterCostumeFromScenes：从匹配场景提取服饰/随身物件证据。

    :param scenes: 场景行列表。
    :param character_name: 角色名。
    :returns: 以「；」连接的服饰证据；无证据返回空串。
    """
    name = _text(character_name)
    if not name:
        return ""
    source = "\n".join(
        " ".join(
            value
            for value in (_text(scene.get("title")), _text(scene.get("summary")), _text(scene.get("content")))
            if value
        )
        for scene in (scenes or [])
        if _scene_matches_character(scene, name)
    )
    if not source:
        return ""

    def normalize_fragment(value: str) -> str:
        """Node normalizeFragment：剥离口语引导词与手部动作尾巴。"""
        value = _text(value)
        value = re.sub(r"^(?:但|而且|然而|只是|他|她|林默|唐宁|赵衡|苏晓)\s*", "", value)
        value = re.sub(r"^(?:一枚|一只|一个|一张|那张|这张|有|戴着|戴有)\s*", "", value)
        value = re.sub(r"的手(?:开始|突然|微微).*$", "", value)
        return value.strip()

    clothing: list[str] = []
    for match in re.finditer(r"(?:穿着|身穿|穿了|穿上|穿)\s*([^，。！？\n；;]{1,80})", source):
        fragment = normalize_fragment(match.group(1))
        if fragment and not re.search(r"(?:的手|开始|突然|正在)", fragment):
            clothing.append(fragment)

    # “领带松垮地挂在脖子上”这类句子没有“穿/戴”动词，但仍是稳定服饰证据。
    for match in re.finditer(r"((?:领带|领结|围巾)\s*(?:松垮地|紧紧地|随意地)?(?:挂在|系在)[^，。！？\n；;]*)", source):
        fragment = normalize_fragment(match.group(1))
        if fragment:
            clothing.append(fragment)

    carried: list[str] = []
    for match in re.finditer(r"(?:戴着|戴|佩戴)\s*([^，。！？\n；;]{1,30})", source):
        fragment = normalize_fragment(match.group(1))
        if fragment and not re.search(r"(?:的手|开始|突然|正在)", fragment):
            carried.append(fragment)
    for match in re.finditer(r"无名指上(?:有|戴着|戴有)?\s*(?:一枚|一只|一个)?\s*([^，。！？\n；;]{1,30})", source):
        fragment = normalize_fragment(match.group(1))
        if fragment and not re.search(r"(?:翻找|握着|拿着|寻找|查看|点击)", fragment):
            carried.append(fragment)
    # 只接受带有“留存/携带”语义的物件，避免把“握着手机的手”“翻找杯垫”误判为固定物件。
    for match in re.finditer(
        r"([^\s，。！？；;]{1,20}(?:杯垫|戒指|手表|项链|钥匙|手机|眼镜))(?=[^。！？；;]{0,24}(?:至今|一直|仍然)?(?:留着|保留|保存着|随身携带|带着))",
        source,
    ):
        fragment = normalize_fragment(match.group(1))
        if fragment and not re.search(r"(?:翻找|握着|拿着|寻找|查看|点击)", fragment):
            carried.append(fragment)

    return "；".join(_unique_texts([*clothing, *carried]))


def is_legacy_character_prompt(prompt: Any) -> bool:
    """Node isLegacyCharacterPrompt：识别已知的历史抽取污染提示词。"""
    return bool(_LEGACY_PROMPT_RE.search(_text(prompt)))


def extract_temporal_states(scenes: list[dict[str, Any]] | None, character_name: Any) -> list[str]:
    """Node extractTemporalStates：从场景标题/地点/时间提取时空状态标签。"""
    states: list[str] = []
    for scene in scenes or []:
        if not _scene_matches_character(scene, _text(character_name)):
            continue
        source = " ".join(
            value
            for value in (
                _text(scene.get("title")),
                _text(scene.get("location")),
                _text(scene.get("timeOfDay")),
                _text(scene.get("time_of_day")),
            )
            if value
        )
        match = _TEMPORAL_STATE_RE.search(source)
        if match and match.group(0) not in states:
            states.append(match.group(0))
    return states


def build_character_turnaround_prompt(character: dict[str, Any] | None = None) -> str:
    """Node buildCharacterTurnaroundPrompt：角色三视图专用资产生成提示词。"""
    character = character or {}
    name = _first_value(character.get("name"), character.get("characterName"), "未命名角色")
    appearance = _first_value(character.get("appearance"))
    costume = _first_value(character.get("costume"), character.get("costume_description"), character.get("costumeDescription"))
    age = _first_value(character.get("age_group"), character.get("ageGroup"))
    gender = _first_value(character.get("gender"))
    no_face = _character_must_not_show_face(character)
    lines = [
        "任务类型：角色三视图专用资产生成。",
        f"角色身份：{name}",
        f"性别：{gender}" if gender else "",
        f"年龄呈现：{age}" if age else "",
        f"基础外貌锁定：{appearance}" if appearance else "",
        f"固定服装与随身物件锁定：{costume}" if costume else "",
        "只读取已确认基础正面全身图和本段角色资产约束，不读取剧情场景、分镜动作、对白、环境或项目背景风格。",
        "基于同一张已确认基础正面全身图，生成同一角色的三张独立全身照片：正面、严格90度侧面、背面；保持同一张脸、发型、妆容、发长、发量、体态、服装、鞋子和全部配饰完全一致。",
        "纯白背景（#FFFFFF）、均匀柔光、无地面环境、无道具、无文字、无水印、无其他人物；从头顶到鞋底完整入镜，人物居中并留安全边距。",
        (
            "该角色剧情约束为不直接露脸：所有视角都不得出现可辨识正脸或清晰五官；以肩线、袖口、手部、后脑勺或遮挡构图保持身份连续，不能为了满足正面视角而生成清晰肖像。"
            if no_face
            else "正面必须看清双眼、鼻子、嘴巴和胸前服装；侧面必须严格90度，只显示一个侧脸轮廓，不能出现正面双眼或三分之四侧面；背面必须只看到后脑勺、后颈、背部和鞋后跟，不出现脸部和胸前衣物。"
        ),
        "手指数量正确，手掌、手臂、肩膀、腿部和鞋子结构真实自然；禁止半身、膝上裁切、脚部裁切、拼贴、九宫格、三联画和背景图。",
        "真人细节约束：保留自然轻微面部不对称；眼睛、瞳孔、虹膜高光、鼻梁鼻翼、嘴唇、耳廓耳垂、发际线和鬓角必须符合真实人体结构；皮肤呈现自然肤色变化和适度细微纹理，不要蜡像或塑料皮肤。",
        "四肢约束：每只手五根手指，关节、指甲和掌纹清楚；肩膀、肘部、腕部、锁骨、膝盖和脚踝连接自然；鞋子成对、左右对应、鞋底完整，不出现融合脚、额外肢体或漂浮配饰。",
        "服装连续性约束：领口、接缝、袖口、纽扣、布料褶皱、腰线、鞋面纹理和配饰位置必须以基础图为唯一依据，不能因为换视角改变衣服穿搭或发型长度。",
    ]
    return "\n".join(line for line in lines if line)


def build_character_asset_pack_prompt(
    character: dict[str, Any] | None = None,
    project_visual_style: Any = "",
    project_category: Any = "",
) -> str:
    """Node buildCharacterAssetPackPrompt：16:9 完整角色资产板母图提示词。"""
    character = character or {}
    name = _first_value(character.get("name"), character.get("characterName"), "未命名角色")
    appearance = _first_value(character.get("appearance"))
    costume = _first_value(character.get("costume"), character.get("costume_description"), character.get("costumeDescription"))
    role = _first_value(character.get("role_tag"), character.get("roleTag"))
    style = _text(project_visual_style)
    category = _text(project_category)
    lines = [
        "任务类型：同一角色资产包基准板（完整角色资产板），只生成一张可直接展示、引用和一致性锁定的母板；不要输出拆分后的单张裁片。",
        f"角色名：{name}",
        f"叙事身份：{role}" if role else "",
        f"固定外貌：{appearance}" if appearance else "",
        f"固定服装与配饰：{costume}" if costume else "",
        f"项目视觉风格：{style}" if style else "",
        build_genre_prompt_context(category, "character") if category else "",
        "白色背景，均匀柔光，真实摄影棚资产参考图；同一张脸、发型、发长、发量、妆容、体态、服装、鞋子和配饰贯穿全部区域，禁止任何区域换脸、换衣、改发型或改变年龄。",
        "身份一致性优先级：右上脸部特写是五官、脸型、耳朵、发际线和发型的唯一身份基准；左侧正面全身照是身高比例、肩宽体态、服装版型、鞋子和固定配饰的唯一身体基准；右下三视图必须同时回看这两个基准逐一复现，不得分别凭空设计三个新人物。",
        "三视图一致性硬约束：正面、严格90度侧面、背面必须属于同一张脸和同一套服装。侧面重点保持鼻梁、鼻尖、嘴唇、下颌线、耳廓、发际线和发长与正面/脸部特写连续；背面重点保持后脑勺轮廓、头发长度、肩线、衣服后片、裤型和鞋子与正面全身连续。任何一个视图五官变形、脸型漂移、发型漂移、体态比例改变或服装配饰变化都视为整板失败。",
        "固定排版，不得改变区域位置：画布必须是16:9横向资产板，禁止竖屏、长条竖图和单人海报。按坐标分成左列和右列；左列占画布约48%，从x=0到x=48%、y=0到y=100%，左列只允许一张正面完整全身照，从头顶到鞋底全部入镜。右列占画布约48%，从x=52%到x=100%；右上区域固定占右列上方约42%，只允许一张独立正面脸部特写，脸部必须是该区域主体并占该区域宽度约70%至90%，必须包含头发顶部、双耳、完整下颌和锁骨上缘；右下区域固定从y约47%开始，占右列下方约51%，必须横向三等分为三个独立小格，依次只放正面、严格90度侧面、背面三张完整全身视图。右上脸部特写与右下三视图不得合并、不得被三视图挤占；区域之间留白约4%，五个区域不可合并、不可重复、不可交换位置；缺少脸部特写或任一全身区域都视为失败。",
        "资产板直接作为完整视觉参考，禁止输出海报、标题、标签、文字、数字、水印、边框装饰、九宫格或多余人物；各区域之间只使用清晰白色间隔，不要用文字标注视图名称，不让人物跨越区域。脸部特写必须是右上独立区域内真正可辨认的头肩近景，不得用三视图中缩小的人脸代替。",
        "所有全身视图都必须从头顶到鞋底完整可见，脚、鞋、头发、双耳和下巴不能被裁切；侧面只允许严格90度单侧轮廓，背面不能出现脸部。",
        "真人结构约束：自然轻微面部不对称，真实眼睑、瞳孔、虹膜、鼻梁鼻翼、嘴唇、耳廓、皮肤纹理、手指和关节；禁止塑料皮肤、畸形肢体、额外手指、重复人物、半身裁切和透视变形。三视图中的头部必须足够清晰可比，不能把人物缩到无法确认脸型和发型的尺寸；画布留白不能牺牲身份可读性。",
        "负面约束：换脸、服装漂移、发型漂移、配饰缺失、裁切脚部、裁切下巴、缺失耳朵、三分之四侧脸、多人、场景背景、道具、文字、字幕、Logo、水印。",
    ]
    return "\n".join(line for line in lines if line)


def build_temporal_variant_prompt(base_prompt: Any, state_label: Any) -> str:
    """Node buildTemporalVariantPrompt：时空状态变体附加约束。"""
    state = _text(state_label)
    if not state:
        return _text(base_prompt)
    return "\n".join(
        [
            _text(base_prompt),
            f"本资产时空状态：{state}",
            "本状态的年龄呈现、固定服饰、鞋履、配饰和随身物件必须根据对应时空的剧本场景、人物身份与动作重新整理；不得沿用与该状态冲突的服饰。",
            "保持角色身份、脸部特征和发型可识别；本时空状态单独成组，不与其他年龄或时间状态合并。",
        ]
    )


def build_script_character_prompt(
    character: dict[str, Any] | None = None,
    scenes: list[dict[str, Any]] | None = None,
    project_visual_style: Any = "",
    project_category: Any = "",
) -> dict[str, Any]:
    """Node buildScriptCharacterPrompt：剧本驱动的角色资产提示词三元组。

    :param character: 角色行。
    :param scenes: 项目场景行（服饰/时空证据来源）。
    :param project_visual_style: 项目视觉风格。
    :param project_category: 项目题材。
    :returns: ``{"prompt", "turnaroundPrompt", "negativePrompt", "source", "version"}``。
    """
    character = character or {}
    name = _first_value(character.get("name"), character.get("characterName"), "未命名角色")
    role = _first_value(character.get("role_tag"), character.get("roleTag"))
    age = _first_value(character.get("age_group"), character.get("ageGroup"))
    gender = _first_value(character.get("gender"))
    appearance = _first_value(character.get("appearance"))
    costume = _first_value(character.get("costume"), character.get("costume_description"), character.get("costumeDescription"))
    no_face = _character_must_not_show_face(character)
    resolved_costume = costume or infer_character_costume_from_scenes(scenes, name)
    personality = _first_value(character.get("personality"))
    voice_style = _first_value(character.get("voice_style"), character.get("voiceStyle"))
    temporal_states = extract_temporal_states(scenes, name)
    style = _text(project_visual_style)
    category = _text(project_category)

    lines = [
        build_prompt_template_context("character"),
        join_production_prompt_rules(CHARACTER_ASSET_SKILL_RULES),
        f"角色名：{name}",
        f"叙事身份：{role}" if role else "叙事身份：未提供",
        f"年龄段：{age}" if age else "年龄段：未提供",
        f"性别：{gender}" if gender else "性别：未提供",
        f"固定外貌：{appearance}" if appearance else "固定外貌：未提供，等待人工补充",
        (
            f"固定服装与随身物件：{resolved_costume}"
            if resolved_costume
            else "固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理，生成前必须补齐"
        ),
        f"性格与表演气质：{personality}" if personality else "性格与表演气质：未提供",
        f"声线参考：{voice_style}" if voice_style else "声线参考：未提供，沿用角色音色绑定",
        f"项目视觉风格：{style}" if style else "项目视觉风格：未提供",
        build_genre_prompt_context(category, "character"),
        (
            f"Agent 已识别时空状态：{'、'.join(temporal_states)}；每个状态单独排版为一组资产"
            if temporal_states
            else "Agent 暂未识别多个时空状态；按当前状态生成默认资产组"
        ),
        "",
        "生成要求：",
        "优先一次生成完整角色资产板：左侧基础正面全身、右上完整脸部特写、右下正面/严格侧面/背面三张全身视图；五个区域必须来自同一角色和同一套服装；统一使用纯白背景和均匀柔光。",
        (
            "本角色在剧情中明确不直接露脸：基础正面全身图也必须保持脸部不可辨识，不得生成清晰正脸肖像；优先使用背对镜头、遮挡或肩手构图，同时保持从头到鞋的身体和固定服饰可复核。"
            if no_face
            else ""
        ),
        "如果剧本存在多个时空状态，先按状态拆成独立资产组；每组分别生成对应服饰、随身物件、年龄呈现和场景环境，不把不同状态混在一张图里。",
        "资产板将作为角色身份基准；后续视频、静帧和分镜统一引用这张已确认母板，保持同一张脸、同一体态、同一服装和同一配饰。",
        "整张资产板为横向16:9；每个全身区域内部的人物从头顶到鞋底完整可见，脸部特写独立位于右上区域，不添加其他人物和无关道具。",
        "真人结构细节：面部保留自然轻微不对称，眼睛、鼻翼、嘴唇、耳朵、发际线、皮肤细纹和肤色变化真实；手指五根且关节、指甲、掌纹自然，四肢关节连接正确，鞋子成对完整。禁止蜡像皮肤、塑料皮肤、六指、融合手、额外肢体、发型长度漂移和服装细节漂移。",
        "当图片模型支持资产板时，必须优先使用资产板模式；应用直接保存并展示这张完整同源母板，不按固定坐标裁切，不把局部裁片当作独立角色资产。",
    ]

    return {
        "prompt": "\n".join(lines),
        "turnaroundPrompt": build_character_turnaround_prompt({**character, "costume": resolved_costume}),
        "negativePrompt": NEGATIVE_PROMPT,
        "source": "script-agent",
        "version": "script-character-prompt-v1",
    }


_EXCLUDED_CLAUSE_RE = re.compile(r"(?:^|：)(?:动作|表演|对白|台词|声音|同期声|音效|回忆|人物动作)\s*[:：]?")
_EXCLUDED_EVIDENCE_RE = re.compile(
    r"(?:穿着|身穿|服装|衣服|丧服|领带|西装|衬衫|袖口|腕表|手表|半陷|陷在|盯住|盯着|起身|走向|回头|输入|点击|解压|观看|拿着|握着|咽下|说出|悼词|同期声|对白|声音|语音|电流失真|屏幕|显示器.*(?:亮|显示|停|出现)|邮件|邮箱|发件|主题|账号|登录|字段|文字|字幕|代码|视频|遗言|人影|脸|手|手指|手臂|身体|倒影|标签朝上|登记簿|失主栏|红色发卡|发卡滑出|发卡停在|腰间钥匙|钥匙轻响|无名指|戒指|划痕|刮痕|去湖边|刮的|空白|倒计时)"
)
_ACTION_EVIDENCE_RE = re.compile(
    r"(?:把|将|拿|放|敲|翻|站|走|起身|回头|盯|看|打开|接|问|回答|停住|握|摸|输入|点击|发现|来到|跑|坐|听|呼吸|抬|低|转身|投|开口|微笑|沉默|说)"
)
_NAMED_PERFORMANCE_RE = re.compile(r"(?:[\u4e00-\u9fff]{2,4})(?:把|将|站|跟|没|说|问|答|走|拿|坐|来到|赶到|停在|的手|的眼|的脸|的声音|：)")
_SPATIAL_LEAD_RE = re.compile(
    r"^(?:深夜|凌晨|公寓|客厅|卧室|房间|室内|窗外|墙上|桌面|地面|天花板|门口|走廊|值班室|登记台|归还箱|办公室|会议室|机房|屏幕|电脑|冰箱|茶几|百叶窗)"
)
_SPATIAL_KEEP_RE = re.compile(
    r"(?:位于|靠近|朝向|沿着|固定|安装|悬挂|铺设|排列|延伸|墙面|地面|天花板|门|窗|走廊|房间|值班室|登记台|归还箱)"
)


def _sanitize_scene_environment_evidence(value: Any, character_names: Any = None) -> str:
    """Node sanitizeSceneEnvironmentEvidence：空场生图仅保留空间事实证据。

    :param value: 场景正文/摘要。
    :param character_names: 需要从证据剔除的角色名（≥2 字符生效）。
    :returns: 清洗后的空间证据文本。
    """
    source = _text(value)
    if not source:
        return ""
    names = [_text(name) for name in (character_names if isinstance(character_names, list) else [character_names])]
    names = [name for name in names if len(name) >= 2]
    character_pattern = re.compile("|".join(re.escape(name) for name in names)) if names else None

    fixture_clauses = [f"剧本明确固定设施：{item['label']}" for item in extract_explicit_scene_fixtures({"content": source})]
    clean_evidence = source
    clean_evidence = re.sub(r"[“”][^“”]*[“”]", "。", clean_evidence)
    clauses: list[str] = []
    for sentence in re.split(r"[。！？\n]", clean_evidence):
        for clause in re.split(r"[；;]", sentence):
            for piece in re.split(r"[，,]", clause):
                piece = piece.strip()
                if not piece or _EXCLUDED_CLAUSE_RE.search(piece):
                    continue
                if character_pattern and character_pattern.search(piece):
                    continue
                if _EXCLUDED_EVIDENCE_RE.search(piece):
                    continue
                if not _SPATIAL_LEAD_RE.search(piece) and _NAMED_PERFORMANCE_RE.search(piece):
                    continue
                if _ACTION_EVIDENCE_RE.search(piece) and not _SPATIAL_KEEP_RE.search(piece):
                    continue
                clauses.append(piece)
    return "，".join([*fixture_clauses, "，".join(clauses)] if clauses else fixture_clauses)


def build_script_scene_prompt(
    scene: dict[str, Any] | None = None,
    project_visual_style: Any = "",
    project_category: Any = "",
    character_names: list[Any] | None = None,
) -> str:
    """Node buildScriptScenePrompt：场景节点基础全景提示词。

    :param scene: 场景行。
    :param project_visual_style: 项目视觉风格。
    :param project_category: 项目题材。
    :param character_names: 项目角色名列表（证据清洗用）。
    :returns: 提示词文本。
    """
    scene = scene or {}
    title = _first_value(scene.get("title"), "未命名场景")
    location = (
        _active_screenplay_location(scene)
        or infer_scene_location(scene)
        or "地点未明确，须根据本场动作与剧情功能推断最小必要空间"
    )
    time_of_day = infer_scene_time_of_day(scene) or "时间未明确，须根据剧情事件、光线需求和人物行动推断并标注为推断"
    screenplay = _first_value(scene.get("content"), scene.get("summary"), "")
    environment_evidence = _sanitize_scene_environment_evidence(screenplay, character_names or [])
    explicit_fixtures = [item["label"] for item in extract_explicit_scene_fixtures(scene)]
    fixture_requirement = (
        f"剧本明确固定设施（必须在场景资产中出现）：{'、'.join(explicit_fixtures)}"
        if explicit_fixtures
        else "剧本明确固定设施：当前文本未识别到专用设施；不得凭空增加剧情道具。"
    )
    style = _text(project_visual_style)
    category = _text(project_category)

    lines = [
        build_prompt_template_context("scene"),
        f"场景：{title}",
        f"时空：{time_of_day}",
        f"地点：{location}",
        f"环境空间证据：{environment_evidence[:5000] or '剧本没有明确空间细节；根据场景地点、时间和固定物件建立可复核的最小空间布局。'}",
        f"项目视觉风格：{style}" if style else "",
        build_genre_prompt_context(category, "scene") if category else "",
        "规划输出按空间功能与尺度、建筑/开口方位、固定物件关系、材质磨损、实体光源与衰减、构图可见范围组织；没有剧本依据的补足标记为推断。",
        "本节点提示词用于全景空场母版。先生成并采用唯一母版，再由后续流程基于同一空间锚点生成九个独立视角候选；不在本提示词中重复描述九个镜头或重写房间。",
        "空间缺少剧本事实时，标记推断依据并补足服务于镜头的最小可拍摄布局。",
        "地点或时间不同的场景必须独立归组，不覆盖其他场景资产。",
    ]
    return "\n".join(line for line in lines if line)


def build_scene_environment_prompt(
    scene: dict[str, Any] | None = None,
    project_visual_style: Any = "",
    project_category: Any = "",
    character_names: list[Any] | None = None,
) -> str:
    """Node buildSceneEnvironmentPrompt：空场环境层提示词（发给生图模型的环境事实）。

    :param scene: 场景行（可含 spatial_anchors / spatial_anchors_json）。
    :param project_visual_style: 项目视觉风格。
    :param project_category: 项目题材。
    :param character_names: 项目角色名列表。
    :returns: 环境提示词文本。
    """
    scene = scene or {}
    title = _first_value(scene.get("title"), "未命名场景")
    location = (
        _active_screenplay_location(scene)
        or infer_scene_location(scene)
        or "根据本场动作与关键道具推断的最小可用空间；若剧本未明确，默认建立能容纳全部动作的单一室内空间"
    )
    panorama_location = (
        "对应视频/监控/回忆内容所在的完整室内空间空场全景（忽略原文中的肩手近景、局部特写和镜头景别）"
        if re.search(r"视频|监控|回忆|闪回", f"{title} {location}")
        else location
    )
    time_of_day = infer_scene_time_of_day(scene) or "根据剧本光线、声音和事件节奏推断的时间状态"
    screenplay = _first_value(scene.get("content"), scene.get("summary"), "")
    environment_evidence = _sanitize_scene_environment_evidence(screenplay, character_names or [])
    explicit_fixtures = [item["label"] for item in extract_explicit_scene_fixtures(scene)]
    fixture_requirement = (
        f"剧本明确固定设施（必须在场景资产中出现）：{'、'.join(explicit_fixtures)}"
        if explicit_fixtures
        else "剧本明确固定设施：当前文本未识别到专用设施；不得凭空增加剧情道具。"
    )
    style = _text(project_visual_style)
    category = _text(project_category)
    spatial_anchors_value = (
        scene.get("spatial_anchors") or scene.get("spatialAnchors") or scene.get("spatial_anchors_json") or None
    )
    spatial_anchors: Any = spatial_anchors_value
    if isinstance(spatial_anchors_value, str):
        try:
            spatial_anchors = json.loads(spatial_anchors_value)
        except (TypeError, ValueError):
            spatial_anchors = None
    spatial_anchors_json = (
        json.dumps(spatial_anchors, ensure_ascii=False, separators=(",", ":"))
        if spatial_anchors
        else "尚未生成；场景规划 Agent 必须先依据本场剧情结构化生成后再提交图片任务。"
    )

    lines = [
        build_prompt_template_context("scene"),
        f"环境资产场景：{title}",
        f"空间类型与功能：{panorama_location}",
        f"时间与光线状态：{time_of_day}",
        "只提取并锁定环境信息：建筑结构、空间尺度、前后左右关系、中心轴、入口出口、门窗方向、固定家具、固定设备、主要环境道具、地面、天花板、材质、光线方向、色彩关系和镜头可见范围。",
        f"剧本环境证据（Agent 提取的空间事实）：{environment_evidence[:5000]}",
        fixture_requirement,
        f"空间锚点 JSON（唯一结构来源）：{spatial_anchors_json}",
        "材质与光线必须回扣本场证据：材质写物理表面和磨损依据，光源写实体来源、方向、色温、范围及衰减，并说明 narrative_reason；不套用其他场景的固定色板。",
        "这是空场环境资产，不是剧情镜头。人物姓名、外貌、服装、动作、表演、对白、声音和剧情事件只可作为空间推理证据，不得出现在图像提示词或画面中。",
        "画面禁止人物、剪影、照片/遗像、人体倒影、屏幕内容、邮件、乱码、字幕、文字和水印；纸张与屏幕如属空间物件，只呈现无字状态。",
        "遵守可信建筑比例、家具尺度、接触阴影、材质粗糙度、自然曝光和真实光线衰减；禁止悬浮物、重复家具、无来源泛光、塑料表面和概念图式布景。",
        "九机位由独立流程读取同一全景母图和 spatial_anchors；当前图片模型只会进行参考图引导重绘，不代表确定性三维采样。",
        f"项目视觉风格：{style}" if style else "",
        build_genre_prompt_context(category, "scene") if category else "",
    ]
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------------------
# asset-node-prompt.mjs
# ---------------------------------------------------------------------------


def _read_node(node: dict[str, Any], camel_key: str, snake_key: str) -> str:
    """Node readNode：camelCase/snake_case 双键读取并 trim。"""
    value = node.get(camel_key)
    if value is None:
        value = node.get(snake_key)
    return _text(value)


def _read_node_shape(node: dict[str, Any]) -> dict[str, str]:
    """Node readNodeShape：节点提示词六元组归一化。"""
    node = node or {}
    return {
        "promptText": _read_node(node, "promptText", "prompt_text"),
        "turnaroundPromptText": _read_node(node, "turnaroundPromptText", "turnaround_prompt_text"),
        "environmentPromptText": _read_node(node, "environmentPromptText", "environment_prompt_text"),
        "negativePrompt": _read_node(node, "negativePrompt", "negative_prompt"),
        "label": _read_node(node, "label", "label"),
        "appearanceLabel": _read_node(node, "appearanceLabel", "appearance_label"),
        "nodeType": _read_node(node, "nodeType", "node_type"),
    }


def build_asset_node_identity_lock(
    character: dict[str, Any] | None,
    appearance_label: Any = "",
    appearance_locked: bool = False,
) -> str:
    """Node buildAssetNodeIdentityLock：角色身份锁文本。

    :param character: 角色行；None（场景/道具节点）返回空串。
    :param appearance_label: 形象变体标签。
    :param appearance_locked: 外貌是否已锁定。
    :returns: 身份锁提示词段。
    """
    if not character:
        return ""
    name = _text(character.get("name")) or "未命名角色"
    role_tag = _first_value(character.get("role_tag"), character.get("roleTag"))
    gender = _text(character.get("gender"))
    appearance = _text(character.get("appearance"))
    costume = _text(character.get("costume"))
    reference_image_url = _first_value(character.get("reference_image_url"), character.get("referenceImageUrl"))
    variant_label = _text(appearance_label)

    if appearance_locked:
        baseline_line = f"外貌基准已锁定：{appearance or '见角色档案'}。变体只能在该基准上做年龄、服装与环境演绎，不得重新设计长相。"
    elif appearance:
        baseline_line = f"固定外貌：{appearance}"
    else:
        baseline_line = ""

    variant_clause = (
        f"本次生成该角色的形象变体「{variant_label}」：保持同一张脸、同一发型、同一体态，但按变体声明调整年龄呈现、服装与时代环境，仍不得换脸、改性别或用其他人物替代。"
        if variant_label
        else "生成时必须保持同一张脸、同一发型、同一体态、同一固定服装、同一随身物件，不得换脸、改龄、改性别或用其他人物替代。"
    )

    return "\n".join(
        line
        for line in [
            f"角色身份：{name}",
            f"角色定位：{role_tag}" if role_tag else "",
            f"性别：{gender}" if gender else "",
            baseline_line,
            ("" if variant_label else (f"固定服装与随身物件：{costume}" if costume else "")),
            f"唯一身份参考图：{reference_image_url}" if reference_image_url else "",
            variant_clause,
        ]
        if line
    )


def resolve_asset_node_generation_prompt(
    node: dict[str, Any],
    requested_view_type: Any = "single",
    prompt_override: Any = "",
) -> str:
    """Node resolveAssetNodeGenerationPrompt：入队有效提示词解析。

    场景 single 视图优先 environmentPromptText；其余 override 优先。

    :param node: 节点行（promptNode）。
    :param requested_view_type: 请求视图类型。
    :param prompt_override: 请求覆盖提示词。
    :returns: 有效提示词。
    """
    shape = _read_node_shape(node)
    override = _text(prompt_override)
    if shape["nodeType"] == "scene" and _text(requested_view_type) == "single":
        return shape["environmentPromptText"] or override or shape["promptText"]
    return override or shape["promptText"]


def build_character_view_negative_prompt(view_key: Any = "", options: dict[str, Any] | None = None) -> str:
    """Node buildCharacterViewNegativePrompt：角色视角负面词（三视图纯白背景隔离剧情）。"""
    options = options or {}
    common = ["场景背景", "室内环境", "机房", "剧情画面", "多人", "拼贴", "九宫格", "文字", "水印", "半身", "裁切"]
    angle_specific_map = {
        "side": ["正面脸", "正面视角", "双眼同时可见", "胸口正对镜头", "三分之四侧面"],
        "back": ["可见脸部", "正面脸", "正面视角", "眼睛", "鼻子", "嘴巴", "眼镜镜片", "胸前衣物正面"],
    }
    angle_specific = list(angle_specific_map.get(_text(view_key), []))
    if _text(view_key) == "front" and options.get("noFace"):
        angle_specific.extend(["清晰正脸", "可辨识脸部", "完整五官特写"])
    return "，".join([*common, *angle_specific])


def build_asset_node_view_prompt(
    node: dict[str, Any],
    character: dict[str, Any] | None,
    project_visual_style: Any,
    appearance_locked: bool,
    view_type: Any = "",
    view_key: Any = "",
    reference_image_url: Any = "",
    base_reference_image_url: Any = "",
) -> dict[str, Any]:
    """Node buildAssetNodeViewPrompt：视图任务提示词（turnaround/特写/道具多视角/九宫格）。

    :param node: 节点行（promptNode，含 promptText 键）。
    :param character: 关联角色行（场景/道具为 None）。
    :param project_visual_style: 项目视觉风格。
    :param appearance_locked: 角色外貌是否锁定。
    :param view_type: 视图类型。
    :param view_key: 视角键。
    :param reference_image_url: 参考图地址。
    :param base_reference_image_url: 基础参考图地址。
    :returns: ``{"prompt", "candidateCount", "referenceImageUrls", ...视图元数据}``。
    :raises ValueError: 门禁失败（文案与 Node 逐字一致）。
    """
    shape = _read_node_shape(node)
    view_type = _text(view_type)
    view_key = _text(view_key)

    if view_type == "character-turnaround":
        if shape["nodeType"] != "character":
            raise ValueError("只有角色节点可以生成三视图")
        base_reference = _text(base_reference_image_url)
        if not base_reference:
            raise ValueError("请先确认角色基础正面全身图，再生成三视图")
        angle = {"front": "正面", "side": "严格左侧面", "back": "背面"}.get(view_key)
        if not angle:
            raise ValueError("三视图生成必须指定正面、侧面或背面视角")
        character_identity = build_asset_node_identity_lock(character, shape["appearanceLabel"], appearance_locked)
        turnaround_prompt = shape["turnaroundPromptText"] or (
            "生成角色三视图专用提示词：基于已确认的基础正面全身图，严格保持同一张脸、发型、妆容、体态、服装、鞋子和配饰，分别输出正面、严格90度侧面和背面三个独立全身视角；纯白背景、均匀柔光、从头到鞋完整入镜，不读取剧情场景，不添加道具、文字、水印或其他人物。"
        )
        no_face_character = bool(
            _NO_FACE_RE_FULL.search(
                "\n".join(
                    value
                    for value in (
                        (character or {}).get("appearance"),
                        (character or {}).get("costume"),
                        character_identity,
                        turnaround_prompt,
                    )
                    if value
                )
            )
        )
        if not shape["promptText"] and not character_identity and not turnaround_prompt:
            raise ValueError("请先填写角色外貌或角色资产提示词")
        return {
            "prompt": "\n".join(
                [
                    "任务类型：角色资产转面单视图生成。",
                    "只生成角色本身，不生成剧情画面，不生成场景，不生成故事分镜。",
                    f"角色名：{shape['label'] or _text((character or {}).get('name')) or '未命名角色'}",
                    # 三视图阶段只读取身份锁和已确认基础图，不能把剧情/项目风格提示词带入生图。
                    turnaround_prompt,
                    character_identity,
                    f"以已确认的角色基础正面全身图为唯一形象基准（仅用于保持脸、发型、体态、服装和配饰一致）：{base_reference}",
                    "这是同一角色的设定参考图，不是三联画、九宫格或场景图；严禁把参考图里的场景、机房、灯光、背景或剧情画面复制到输出。",
                    "身份一致性硬约束：正面基础图中的脸型、五官、妆容、眉形、眼妆、发际线、发色、发长、发量、发型轮廓、耳朵、身材比例、固定服装、鞋子和配饰必须在本视角完全一致；严禁长发变短发、短发变长发、换妆、换衣、换鞋或更换人物。",
                    f"本次只输出{angle}一个视角。画面中只能出现一个该角色，必须是从头顶到鞋底的完整全身照，头发、鞋子和脚底轮廓全部在画面内，人物上下左右留出安全边距，绝不裁切。",
                    "背景必须是无纹理纯白色摄影棚背景（#FFFFFF），均匀柔光，无地面场景、无室内环境、无道具。",
                    "人物自然站立，双脚完整可见且落在画面内，双臂完整可见，手掌和五指自然成形，手指数量正确，手臂与肩膀连接自然，关节比例真实，避免融手、断指、额外手指、手臂畸变、腿部粘连和鞋子缺失。",
                    "保持真实人体比例和摄影棚证件式资产参考图构图：全身人物占画面高度约80%至90%，镜头平视，人物居中，视角必须严格符合本次指定视角。",
                    (
                        (
                            "正面身体硬约束：人物身体和固定服装正面对镜头，头部保持不可辨识（头部略低、背光或被阴影遮挡），不得出现清晰正脸、双眼、鼻子、嘴巴或可辨识五官；仍须从头顶到鞋底完整入镜。"
                            if no_face_character
                            else "正面硬约束：人物面向镜头，双眼、鼻子、嘴巴、眼镜和胸前衣物正面清晰可见；不能出现后脑勺、背部或背面构图。"
                        )
                        if view_key == "front"
                        else (
                            "侧面硬约束：人物身体和头部必须严格旋转到镜头左侧90度，肩线、胸口、骨盆和双脚都呈侧向；只能看到一个侧脸轮廓，远侧眼睛不可见，胸口不能正对镜头；如果画面仍能清楚看到双眼、鼻梁正面、胸前衣物正面或两只鞋的正面，视为错误正面图，必须拒绝；不能生成三分之四侧面、正面或背面；发型轮廓和发长必须与基础正面图一致。"
                            if view_key == "side"
                            else "背面硬约束：人物背对镜头，后脑勺和后颈可见，脸部、眼睛、鼻子、嘴巴、眼镜镜片和胸前衣物细节不可见；只能看到背部、后肩、后臂、后腰、臀部、腿部后侧和鞋后跟，绝对不能出现正面脸部；后脑勺发型、发长、发量和发尾必须与基础正面图一致。"
                        )
                    ),
                    "禁止半身照；不得输出膝上构图、腿部裁切、脚部裁切、不得输出拼贴、三联画、九宫格、电影场景、动作分镜、多人合影、第二个人、剧情道具、文字或水印。",
                ]
            ),
            "candidateCount": 1,
            "referenceImageUrls": [base_reference],
            "viewIndex": {"front": 1, "side": 2, "back": 3}[view_key],
            "viewKey": view_key,
            "viewLabel": {"front": "正面", "side": "严格侧面", "back": "背面"}[view_key],
        }

    if view_type == "character-face-closeup":
        if shape["nodeType"] != "character":
            raise ValueError("只有角色节点可以生成脸部特写")
        base_reference = _text(base_reference_image_url)
        if not base_reference:
            raise ValueError("请先确认角色基础正面全身图，再生成脸部特写")
        character_identity = build_asset_node_identity_lock(character, shape["appearanceLabel"], appearance_locked)
        closeup_prompt = "\n".join(
            [
                "任务类型：角色脸部特写专用资产生成。",
                "只读取已确认基础正面全身图和角色身份锁，不读取剧情场景、分镜动作、对白、环境或项目背景风格。",
                "基于同一张已确认基础正面全身图，生成同一角色的正面脸部特写参考图；脸型、五官比例、妆容、肤色、皮肤纹理、发际线、发色、发长、耳朵和下颌线必须与基础图一致。",
                "纯白背景（#FFFFFF）、均匀柔光、无地面环境、无道具、无文字、无水印、无其他人物。",
                "画面从头顶发际线到锁骨上方完整入镜，双耳、下颌线和发型轮廓完整可见，不裁切头发、耳朵或下巴；正面平视，人物居中，保留安全边距。",
                "真实人体细节：眼睑、瞳孔、虹膜高光、眉毛、鼻梁鼻翼、嘴唇、耳廓耳垂和皮肤细纹自然，保留轻微自然不对称；禁止塑料皮肤、蜡像脸、磨皮过度、换脸、年龄漂移和发型漂移。",
                "禁止生成全身、半身动作、三视图、侧面、背面、三分之四侧脸、场景背景、剧情道具、字幕、文字和水印。",
            ]
        )
        return {
            "prompt": "\n".join(
                line
                for line in [
                    closeup_prompt,
                    f"角色名：{shape['label'] or _text((character or {}).get('name')) or '未命名角色'}",
                    character_identity,
                    f"以已确认的角色基础正面全身图为唯一形象基准：{base_reference}",
                    "身份一致性硬约束：基础图中的脸型、眼眉、眼距、鼻型、唇形、耳朵、下颌线、发际线、发长、发量、妆容和肤色必须完全一致。",
                ]
                if line
            ),
            "candidateCount": 1,
            "referenceImageUrls": [base_reference],
            "viewIndex": 1,
            "viewKey": "face",
            "viewLabel": "脸部特写",
        }

    if view_type == "prop-turnaround":
        if shape["nodeType"] not in ("prop", "tool", "material"):
            raise ValueError("只有道具、工具或材料节点可以生成道具多视角")
        reference = _text(reference_image_url)
        if not reference:
            raise ValueError("请先确认道具基础图，再生成道具多视角")
        return {
            "prompt": "\n".join(
                [
                    build_prop_asset_view_prompt({"name": shape["label"], "details": shape["promptText"]}, view_key),
                    f"已确认道具基础图（唯一外观基准）：{reference}",
                ]
            ),
            "candidateCount": 1,
            "referenceImageUrls": [reference],
            "viewIndex": {"front": 1, "side": 2, "back": 3, "top": 4}[_text(view_key)],
            "viewKey": _text(view_key),
            "viewLabel": {"front": "正面", "side": "侧面", "back": "背面", "top": "俯视"}[_text(view_key)],
        }

    if view_type == "scene-nine-grid":
        if shape["nodeType"] != "scene":
            raise ValueError("只有场景节点可以生成九宫格")
        panorama = _text(reference_image_url)
        if not panorama:
            raise ValueError("请先确认场景全景基准图，再生成九宫格")
        scene_prompt = shape["environmentPromptText"] or shape["promptText"]
        if not scene_prompt:
            raise ValueError("请先填写场景提示词")
        environment_only_prompt = "\n".join(
            [
                "任务类型：已确认场景全景的环境资产单视角锁定候选。",
                "只生成同一空间的空场环境，不生成任何人物或人物相关内容。",
                "只读取下面提示词中的空间结构、建筑、固定家具、固定设备、门窗、地面、天花板、材质、光线和色彩信息；忽略人物姓名、人物动作、服装、表情、对话、葬礼回忆、遗照、视频画面、邮件内容、代码内容和剧情事件。",
                "空间锚点提示词：",
                scene_prompt,
                build_color_continuity_constraints(visual_style=project_visual_style, scene_prompt=scene_prompt),
                "环境主体限定：严格依据上方场景锚点和已确认全景，不得补入其它示例场景或未出现的空间；画面中不得出现人物、人物剪影、人物照片、遗像、脸、手、腿、人形、人体倒影或任何角色主体。",
            ]
        )
        return {
            "prompt": "\n".join(
                [
                    environment_only_prompt,
                    f"这是同一空间的单一环境视角候选，必须以全景基准图为唯一空间参考：{panorama}",
                    "先读取节点中保存的完整场景锚点清单；全景图、场景结构提示词和九宫格必须视为同一套空间锁定数据。",
                    "场景一致性硬约束：建筑结构、墙柱、门窗、出入口、楼梯、固定设备、主要道具、材质、空间尺度、光线方向和色彩关系必须保持完全一致；不得因机位变化重构空间。",
                    "只输出一张连续、完整、单一视角的环境图，不能输出九宫格、拼贴、分格、三联画或多幅不同视角。",
                    "这是环境资产锁定图，不要添加角色主体、人物照片、遗像、对白、字幕、文字和水印。",
                ]
            ),
            "candidateCount": 1,
            "referenceImageUrls": [panorama],
        }

    return {"prompt": "", "candidateCount": 1, "referenceImageUrls": []}


_NO_FACE_RE_FULL = re.compile(r"正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见")


def build_asset_node_generation_prompt(
    node: dict[str, Any],
    character: dict[str, Any] | None,
    project_visual_style: Any,
    appearance_locked: bool,
) -> str | None:
    """Node buildAssetNodeGenerationPrompt：single 视图生成提示词（含场景锁/道具规则/色彩锁）。

    :param node: 节点行（promptNode）。
    :param character: 关联角色行。
    :param project_visual_style: 项目视觉风格。
    :param appearance_locked: 角色外貌是否锁定。
    :returns: 提示词；完全无依据时 None（由路由报 400）。
    """
    shape = _read_node_shape(node)
    style = _text(project_visual_style)
    identity_lock = build_asset_node_identity_lock(character, shape["appearanceLabel"], appearance_locked)

    if not shape["promptText"] and not shape["environmentPromptText"] and not identity_lock:
        return None

    generation_prompt = (
        (shape["environmentPromptText"] or shape["promptText"])
        if shape["nodeType"] == "scene"
        else shape["promptText"]
    )

    scene_lock = (
        "\n".join(
            [
                "这是场景资产，不是角色肖像，不要生成人物主体或人物设定。",
                "这是场景全景基准图阶段，先输出一张完整空间全景图，明确固定空间结构，作为后续九宫格唯一空间来源。",
                "场景提示词必须先写空间类型与功能，再写建筑结构、入口出口、门窗和墙柱方位，再写固定家具/设备的数量、位置、朝向、相对距离和遮挡关系，最后写材质、光源、色彩、机位和负面约束；不要用空泛的“电影感”替代空间事实。",
                "先建立一张可作为空间基准的全景环境图：固定建筑结构、空间结构、空间尺度、材质、主要物件位置、门窗方向、光线方向与色彩关系。",
                "后续多角度视图必须来自同一个空间，不得新增、删除或移动关键结构；不同视角只改变摄影机位置与朝向。",
                "输出适合生成九宫格多角度场景锁定组图的环境画面，保持透视、布局和细节连续。",
                "场景全景硬负面约束：不得出现人物、人物剪影、人物照片、遗像、人体倒影、手臂、手指、走廊人影、任何可读或不可读的屏幕界面、邮件、账号、字母、数字、乱码、字幕、Logo 或水印；电脑和显示器只能是无内容的黑屏或纯色屏幕，协议、文件、便签和纸张只能是空白无字版本；忽略剧本中的肩手近景、局部特写和人物动作，只生成完整空场全景。",
                "真实摄影质感：以现实场地勘景照片为目标，采用可信的建筑透视、自然曝光和真实镜头景深；材质具有各自真实的粗糙度、反射与细微使用痕迹，阴影必须落在接触面并服从实际灯具和窗户方向。冷蓝环境光、暖黄灯光和局部红色警示光必须分别对应真实光源并自然衰减，禁止全画面青蓝/红色滤镜。避免塑料表面、无来源泛光、过度锐化、重复摆件、悬浮物、完美对称的CG布景和游戏渲染感；不得牺牲剧本要求的具体空间锚点来套用通用氛围。",
                "现实空间校准：桌椅、门把手、插座、踢脚线、吊顶和门窗必须符合常见真实建筑尺度；门扇开启范围与通行宽度符合现实，家具必须落地并有接触阴影，墙面、地面和天花板的交界线保持建筑逻辑，镜头视点应让空间能被人真实进入和使用。",
                "禁止无来源的装饰性布景：只保留剧本明确要求或空间功能必需的物件；不为填满画面添加盆栽、摆件、霓虹灯、额外屏幕、标牌、海报或多余家具。未被剧本确定的细节采用克制、常见、低视觉权重的现实方案，不编造新的剧情线索。",
                "画面目标是可信的现实地点勘景照片，不是概念设计图、样板间、摄影棚、游戏场景或精修地产宣传图；保留轻微使用痕迹和合理的不完美，但不把磨损夸张成废墟。",
            ]
        )
        if shape["nodeType"] == "scene"
        else ""
    )
    prop_rules = (
        "\n".join(
            [
                "这是单件道具基础资产，不是角色资产，也不是场景概念图。只生成一个完整可识别的道具本体。",
                "道具从最左边缘到最右边缘、从最高点到底部接触面完整入镜；把手、底座、开口、按钮、接口、线缆和附属结构不得被裁切。道具居中，四周有安全留白，背景干净中性。",
                "禁止人物全身构图、人体比例要求、角色肖像、手持、人物、场景、局部微距、只显示细节、拼贴、九宫格、文字、水印和多件重复道具。",
                "\n".join([build_prompt_template_context("prop"), join_production_prompt_rules(PROP_ASSET_SKILL_RULES)]),
            ]
        )
        if shape["nodeType"] in ("prop", "tool", "material")
        else ""
    )
    color_lock = (
        build_color_continuity_constraints(visual_style=project_visual_style, scene_prompt=generation_prompt)
        if shape["nodeType"] == "scene"
        else ""
    )

    return "\n".join(
        line
        for line in [
            generation_prompt,
            (f"形象变体：{shape['appearanceLabel']}" if shape["nodeType"] == "character" and shape["appearanceLabel"] else ""),
            f"主体：{shape['label']}" if shape["label"] else "",
            f"画面风格：{style}" if style else "",
            identity_lock,
            (
                "角色基础形象要求：生成基础正面全身图，正面平视、单人站立、从头顶到鞋底完整全身照，头发、双手、双脚、鞋子和固定服装全部入镜，鞋子全部入镜；人物占画面高度约80%至90%，四周留安全边距，纯白背景（#FFFFFF），这是后续三视图唯一的服装、发型、妆容、鞋子和配饰基准；禁止半身、四分之三身、膝上、腰部以上和脚部裁切。"
                if shape["nodeType"] == "character"
                else ""
            ),
            scene_lock,
            prop_rules,
            color_lock,
            "画面清晰，构图完整，无文字水印",
        ]
        if line
    )


def build_asset_node_prompt_snapshot(
    node: dict[str, Any],
    character: dict[str, Any] | None,
    project_visual_style: Any,
    appearance_locked: bool,
) -> str:
    """Node buildAssetNodePromptSnapshot：落库的提示词快照（可追溯生成依据）。"""
    shape = _read_node_shape(node)
    style = _text(project_visual_style)
    identity_lock = build_asset_node_identity_lock(character, shape["appearanceLabel"], appearance_locked)
    lines = [
        (shape["environmentPromptText"] or shape["promptText"]) if shape["nodeType"] == "scene" else shape["promptText"],
        f"形象变体：{shape['appearanceLabel']}" if shape["nodeType"] == "character" and shape["appearanceLabel"] else "",
        f"节点：{shape['label']}" if shape["label"] else "",
        f"资产类型：{shape['nodeType']}" if shape["nodeType"] else "",
        f"项目视觉风格：{style}" if style else "",
        f"负面提示词：{shape['negativePrompt']}" if shape["negativePrompt"] else "",
        (
            "\n".join([build_prompt_template_context("prop"), join_production_prompt_rules(PROP_ASSET_SKILL_RULES)])
            if shape["nodeType"] in ("prop", "tool", "material")
            else ""
        ),
        identity_lock,
        "场景锁定要求：以全景基准图为源，生成九宫格固定视角组图；保持空间结构、材质、物件位置、光线方向与色彩关系一致，不生成角色肖像。"
        if shape["nodeType"] == "scene"
        else "",
        (
            build_color_continuity_constraints(
                visual_style=project_visual_style,
                scene_prompt=shape["environmentPromptText"] or shape["promptText"],
            )
            if shape["nodeType"] == "scene"
            else ""
        ),
    ]
    return "\n".join(line for line in lines if line)


# ---------------------------------------------------------------------------
# character-identity-lock.mjs
# ---------------------------------------------------------------------------


def _id_of(image: dict[str, Any] | None) -> int | None:
    """Node idOf：图片行正整数 id。"""
    if not image:
        return None
    try:
        value = int(image.get("id", image.get("image_id")))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _image_url_of(image: dict[str, Any]) -> str:
    """Node imageUrlOf：imageUrl/image_url/thumbnailUrl/thumbnail_url 依序读取。"""
    return _first_value(image.get("imageUrl"), image.get("image_url"), image.get("thumbnailUrl"), image.get("thumbnail_url"))


def _storage_key_of(image: dict[str, Any]) -> str:
    """Node storageKeyOf：storageKey/storage_key 依序读取。"""
    return _first_value(image.get("storageKey"), image.get("storage_key"))


def _is_confirmed_passed(image: dict[str, Any]) -> bool:
    """Node isConfirmedPassed：confirmed + passed + 有图/有键。"""
    return (
        _text(image.get("status")) == "confirmed"
        and _first_value(image.get("visionStatus"), image.get("vision_status")) == "passed"
        and bool(_image_url_of(image) or _storage_key_of(image))
    )


def resolve_character_reference_set(images: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Node resolveCharacterReferenceSet：稳定顺序的身份参考图集合。

    顺序固定：single → face closeup → turnaround front/side/back（同型取最大 id）。

    :param images: 资产图 DTO/行列表。
    :returns: ``{"images", "imageIds", "imageUrls", "storageKeys", "baseImage", "faceImage"}``。
    """
    usable = [image for image in (images or []) if _is_confirmed_passed(image)]

    def by_type(view_set_type: str, view_key: Any = None) -> dict[str, Any] | None:
        """按视图类型（可选视角键）取 id 最大的行。"""
        candidates = [
            image
            for image in usable
            if _first_value(image.get("viewSetType"), image.get("view_set_type")) == view_set_type
            and (view_key is None or _first_value(image.get("viewKey"), image.get("view_key")) == view_key)
        ]
        candidates.sort(key=lambda image: _id_of(image) or 0, reverse=True)
        return candidates[0] if candidates else None

    ordered = [
        image
        for image in [
            by_type("single"),
            by_type("character-face-closeup", "face"),
            by_type("character-turnaround", "front"),
            by_type("character-turnaround", "side"),
            by_type("character-turnaround", "back"),
        ]
        if image
    ]
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for image in ordered:
        image_id = _id_of(image)
        key = f"id:{image_id}" if image_id else f"url:{_image_url_of(image)}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(image)
    return {
        "images": unique,
        "imageIds": [image_id for image_id in (_id_of(image) for image in unique) if image_id],
        "imageUrls": [url for url in (_image_url_of(image) for image in unique) if re.match(r"^https?://", url, re.I)],
        "storageKeys": [key for key in (_storage_key_of(image) for image in unique) if key],
        "baseImage": by_type("single"),
        "faceImage": by_type("character-face-closeup", "face"),
    }


def build_character_identity_lock_snapshot(
    character: dict[str, Any] | None = None,
    base_image: dict[str, Any] | None = None,
    reference_set: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Node buildCharacterIdentityLockSnapshot：角色身份锁快照（确认时写入 asset_nodes）。"""
    character = character or {}
    reference_set = reference_set or {}
    name = _first_value(character.get("name"), character.get("characterName")) or "未命名角色"
    appearance = _text(character.get("appearance"))
    wardrobe = _first_value(character.get("costume"), character.get("costume_description"), character.get("costumeDescription"))
    face_image = reference_set.get("faceImage") or None
    prompt = "\n".join(
        line
        for line in [
            f"角色身份锁：{name}",
            f"基础外貌证据：{appearance}" if appearance else "",
            f"基础图服装与配饰证据：{wardrobe}" if wardrobe else "",
            "基础正面全身图是唯一的身体轮廓、发型、服装、鞋子和配饰基准。",
            "已确认脸部特写是五官和脸型基准。" if face_image else "尚未确认脸部特写，不得声称已完成脸部身份锁。",
            "派生图必须同时保持脸型、五官相对位置、肤色、发型轮廓、发长、服装颜色与版型、鞋子和固定配饰；服装、鞋子、发型和配饰不得变化；禁止换脸、换装、发长漂移或新增服装细节。",
        ]
        if line
    )
    return {
        "schemaVersion": 1,
        "identityMode": "multi-reference-visual-lock",
        "faceEmbeddingStatus": "not-configured",
        "characterId": int(character.get("id") or 0) or None,
        "name": name,
        "appearance": appearance or None,
        "wardrobe": wardrobe or None,
        "baseImageId": _id_of(base_image),
        "faceReferenceImageId": _id_of(face_image),
        "referenceImageIds": reference_set.get("imageIds") or [],
        "referenceImageUrls": reference_set.get("imageUrls") or [],
        "referenceStorageKeys": reference_set.get("storageKeys") or [],
        "prompt": prompt,
    }


def build_character_identity_lock_prompt(snapshot: dict[str, Any] | None = None, requested_angle: Any = "") -> str:
    """Node buildCharacterIdentityLockPrompt：派生图生成的身份锁提示词段。"""
    snapshot = snapshot or {}
    return "\n".join(
        line
        for line in [
            "角色身份与穿搭锁定（只用于角色资产，不读取任何场景或表演上下文）：",
            _text(snapshot.get("prompt")),
            f"当前输出视角：{_text(requested_angle)}" if _text(requested_angle) else "",
            "所有参考图属于同一个已确认角色，只改变摄影机视角，不改变人物身份、发型、妆容、衣服、鞋子、配饰、比例或年龄感。",
            "没有真实 FaceID/人脸向量服务时，不得把文本描述当作 FaceID；必须依赖这些已确认多参考图并接受视觉一致性检查。",
        ]
        if line
    )


def parse_character_identity_lock(value: Any) -> dict[str, Any] | None:
    """Node parseCharacterIdentityLock：身份锁 JSON 解析（失败返回 None）。"""
    if not value:
        return None
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


# ---------------------------------------------------------------------------
# asset-temporal-groups.mjs（normalizeAssetGroupKey）
# ---------------------------------------------------------------------------


def normalize_asset_group_key(value: Any, max_length: int = 240) -> str:
    """Node normalizeAssetGroupKey：分组键 trim + 超长哈希截断。

    :param value: 原始分组键。
    :param max_length: 最大长度（默认 240）。
    :returns: 归一化后的分组键。
    """
    key = _text(value)
    if not key or len(key) <= max_length:
        return key
    digest = hashlib.sha256(key.encode()).hexdigest()[:12]
    return f"{key[:max(1, max_length - len(digest) - 1)]}-{digest}"


def resolve_temporal_state(prompt: Any = "") -> dict[str, str]:
    """Node resolveTemporalState（asset-temporal-groups.mjs temporalState）：提示词时空状态识别。

    资产状态优先读取 Agent 明确写出的「本资产时空状态：」行；历史事实
    （如「父亲五年前的事故」）不能当成当前时空分组依据。

    :param prompt: 节点提示词。
    :returns: ``{"key", "label"}``。
    """
    value = _text(prompt)
    explicit_match = re.search(r"本(?:资产)?时空状态\s*：\s*([^\n]+)", value)
    if explicit_match:
        explicit_state = explicit_match.group(1).strip()
        if re.search(r"五年前|五年以前|5年前", explicit_state):
            return {"key": "past-5-years", "label": explicit_state}
        if re.search(r"十八年前|18年前", explicit_state):
            return {"key": "past-18-years", "label": explicit_state}
        if re.search(r"童年|小时候|幼年|儿童时期", explicit_state):
            return {"key": "childhood", "label": explicit_state}
        if re.search(r"现在|当前|当下|成年|职场", explicit_state):
            return {"key": "current", "label": explicit_state}
        return {"key": "default", "label": explicit_state}
    if re.search(r"五年前|五年以前|5年前", value):
        return {"key": "past-5-years", "label": re.split(r"[；，。]", value)[0] or "五年前"}
    if re.search(r"十八年前|18年前", value):
        return {"key": "past-18-years", "label": "十八年前"}
    if re.search(r"童年|小时候|幼年|儿童时期", value):
        return {"key": "childhood", "label": "童年时期"}
    if re.search(r"现在|当前|当下|成年|职场", value):
        label_match = re.search(r"(?:现在|当前|当下|成年|职场)[^；，。]*", value)
        return {"key": "current", "label": label_match.group(0) if label_match else "当前状态"}
    return {"key": "default", "label": "默认状态"}


def build_prop_asset_group_key(project_id: Any, name: Any) -> str:
    """Node buildPropAssetGroupKey：Agent 道具分组键。"""
    return normalize_asset_group_key(f"prop:agent:{int(project_id) or 0}:{_text(name)}")
