"""Agent Eval 确定性校验器：verifier 名 → 纯函数注册表（零框架依赖、零网络）。

纪律：
- 所有校验器都是**纯函数**：输入完全来自 :class:`app.agent.eval.dataset.EvalCase`，
  不访问数据库/文件系统（``verify_rag_cases`` 读取报告文件除外，且只读、路径受控）、
  不调用模型、不发起网络请求；同名输入必得同名判定；
- 统一返回结构 ``{"passed": bool, "failures": [str], "details": {...}}``：
  ``passed`` 为 True 当且仅当 ``failures`` 为空；``details`` 全部为 JSON 可序列化值；
- 本模块**不得 import** httpx/requests/langchain 等网络与模型客户端
  （由 ``tests/test_eval_runner.py`` 的 AST 静态自检强制保证）；
- 文本规则只能证明**结构**：涉及"动作真实发生/音轨真实可听"等语义判定一律
  归入 ``pending_review=True`` 的人工复核样本，校验器对它们只做结构检查并在
  details 标注 ``semantic_check="pending_human_review"``。

与阶段 1-4 契约的关系：
- 六态恢复结果词表与 :data:`app.agent.schemas.AgentRunStatus` 一致（人工同步）；
- 故障恢复场景名与阶段 2 ``app.agent.pipeline.recovery`` 的语义对齐；
- RAG 指标键与 ``rag-service/app/retrieval_eval.py`` 的 summary 输出一致。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from .dataset import EvalCase

# 仓库根目录（validators.py 位于 {repo}/api-service/app/agent/eval/ 下，
# parents[4] 即仓库根，用于解析相对路径的 artifacts 报告）。
_REPO_ROOT = Path(__file__).resolve().parents[4]
# api-service 根目录（相对路径的第二候选基准）。
_API_SERVICE_ROOT = Path(__file__).resolve().parents[3]

# 分镜连续性容忍：相邻镜头 start 与上一镜头 end 的最大允许偏差（秒）。
_SHOT_SEAM_TOLERANCE_SECONDS = 0.01

# 故障恢复六类已知场景（语义对齐阶段 2 app.agent.pipeline.recovery 与
# app.agent.pipeline.paid_submission 的故障恢复口径；在认证测试中作常量比对）。
KNOWN_RECOVERY_SCENARIOS: frozenset[str] = frozenset({
    "node_pre_failure",
    "execution_interrupted",
    "provider_created_not_saved",
    "duplicate_callback",
    "worker_restart",
    "checkpoint_mismatch",
})

# 合法的恢复期望结果：Agent 六态（与 app.agent.schemas.AgentRunStatus 一致）
# 加上付费提交幂等语义的 no_duplicate_submission。
_VALID_RECOVERY_OUTCOMES: frozenset[str] = frozenset({
    "completed",
    "failed",
    "retryable_failed",
    "blocked",
    "waiting_approval",
    "canceled",
    "no_duplicate_submission",
})

# 资产可用的确认状态（draft/candidate/archived 等一律视为未确认）。
_USABLE_ASSET_STATUSES: frozenset[str] = frozenset({"confirmed", "ready"})

# 用途 → 所需资产能力的最小要求（purpose=video 表示用于视频生成，底片须为图片）。
_PURPOSE_REQUIRED_CAPABILITY: dict[str, str] = {
    "video": "image",
    "voice": "voice",
    "audio": "voice",
}

# @引用名提取：@ 后的连续非空白、非分隔标点片段。
_AT_MENTION_PATTERN = re.compile(r"@([^\s@，。,;；!！?？:：]+)")

# 人物表演动词词表（scene_asset 不得混入；与 quality/rules.py 的动作事件词表同源扩充）。
_PERFORMANCE_VERB_WORDS: tuple[str, ...] = (
    "表演", "说话", "台词", "奔跑", "抬头", "低头", "转身", "望向", "看向",
    "挥手", "递出", "接过", "跳跃", "打斗", "拥抱", "跪下",
)

# prop_asset 静态描述模式词表（video_action 不得混入）。
_STATIC_PROP_PATTERN_WORDS: tuple[str, ...] = (
    "静止", "静态", "静置", "道具特写", "保持不动", "保持静止",
)

# Prompt 四类合法 kind。
_PROMPT_KINDS: frozenset[str] = frozenset({"prop_asset", "scene_asset", "storyboard_shot", "video_action"})

# 声音 cue 三类合法 kind。
_SOUND_CUE_KINDS: frozenset[str] = frozenset({"environment", "dialogue", "music"})

# 性别矛盾词表（小型中文词表：他/她、男/女；样本文本受控，不追求通用 NLP）。
_GENDER_MALE_WORDS: tuple[str, ...] = ("男", "他")
_GENDER_FEMALE_WORDS: tuple[str, ...] = ("女", "她")

# 年龄段词组：组键 → 词表（appearance/动作约束中的年龄段词）。
_AGE_GROUP_WORDS: dict[str, tuple[str, ...]] = {
    "child": ("儿童", "小孩", "孩童"),
    "youth": ("少年", "少女", "青年", "学生"),
    "middle": ("中年",),
    "elder": ("老年", "老者", "老人"),
}

# 身份-服饰矛盾词表：身份词 → 与之冲突的服饰词。
_IDENTITY_CLOTHING_CONFLICTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("学生", ("警服", "警徽", "军装", "白大褂")),
    ("警察", ("校服", "水手服", "学生装")),
    ("医生", ("警服", "校服", "军装")),
    ("教师", ("警服", "军装")),
    ("护士", ("警服", "军装")),
)

# RAG summary 必须齐全的六个指标键（与 rag-service 检索评测 summary 输出一致）。
_RAG_REQUIRED_METRIC_KEYS: frozenset[str] = frozenset({
    "recall_at_k", "mrr", "leak_count", "empty_rate", "latency_p50_ms", "latency_p95_ms",
})

# leak_count 的设计内暴露上限默认值（= 数据集中 amb 类样本数）。
_RAG_DEFAULT_LEAK_LIMIT = 1

# API 错误码约定表：expected_status → 允许的 envelope code 集合
# （401↔4010 特例：HTTP 未登录允许返回 token 失效码）。
_STATUS_ALLOWED_CODES: dict[int, frozenset[int]] = {
    200: frozenset({0}),
    201: frozenset({0}),
    204: frozenset({0}),
    400: frozenset({400}),
    401: frozenset({401, 4010}),
    403: frozenset({403}),
    404: frozenset({404}),
    409: frozenset({409}),
}


def _verifier_result(passed: bool, failures: list[str], details: dict[str, Any]) -> dict[str, Any]:
    """构造统一的校验器返回结构。

    :param passed: 是否通过（应等于 ``not failures``）。
    :param failures: 失败说明列表。
    :param details: 结构化明细（JSON 可序列化）。
    :return: ``{"passed","failures","details"}`` dict。
    """
    return {"passed": bool(passed and not failures), "failures": failures, "details": details}


def _payload_dict(case: EvalCase, failures: list[str]) -> dict[str, Any]:
    """取出样本 input 并校验为 dict。

    :param case: 当前样本。
    :param failures: 失败收集列表（input 非 dict 时追加一条失败说明）。
    :return: input 为 dict 时返回原 dict，否则返回空 dict。
    """
    if isinstance(case.input, dict):
        return case.input
    failures.append("input 必须是 dict 结构（schema 由校验器约定）")
    return {}


def _num(value: Any) -> float | None:
    """把任意值宽松转为 float。

    :param value: 任意 JSON 值。
    :return: 转换结果；bool/非数值/None 返回 None（bool 视为非法，防止 True 当 1）。
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def verify_storyboard_duration(case: EvalCase) -> dict[str, Any]:
    """校验分镜时长：单镜合法性、时间轴连续性与总时长容差。

    规则（对 input.shots = [{index,start_seconds,end_seconds}, ...]）：
    - 每镜头 ``end > start`` 且 ``start >= 0``（覆盖负时长与 0 秒时长镜头，
      含"首镜头不得意外为 0 秒"）；
    - 相邻镜头 ``start[i+1]`` 与 ``end[i]`` 偏差 ≤ 0.01s（无意外重叠或缺口）；
    - 全片总时长（末镜头 end - 首镜头 start）与 ``target_total_seconds`` 的差
      ≤ ``tolerance_seconds``。

    :param case: 样本（input 需含 shots/target_total_seconds/tolerance_seconds）。
    :returns: ``{"passed","failures","details"}``；details 含镜头数与总时长。
    :raises: 本函数不抛出异常；字段缺失/非数值按失败说明降级处理。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    shots = payload.get("shots")
    target = _num(payload.get("target_total_seconds"))
    tolerance = _num(payload.get("tolerance_seconds"))

    if not isinstance(shots, list) or not shots:
        failures.append("shots 必须是非空镜头列表")
        shots = []
    if target is None:
        failures.append("target_total_seconds 必须为数值")
    if tolerance is None:
        failures.append("tolerance_seconds 必须为数值")
        tolerance = 0.0

    parsed: list[tuple[int, float, float]] = []
    for position, shot in enumerate(shots):
        if not isinstance(shot, dict):
            failures.append(f"镜头 #{position + 1} 必须是 dict（含 index/start_seconds/end_seconds）")
            continue
        index = shot.get("index", position + 1)
        start = _num(shot.get("start_seconds"))
        end = _num(shot.get("end_seconds"))
        if start is None or end is None:
            failures.append(f"镜头 {index} 的 start_seconds/end_seconds 缺失或非数值")
            continue
        if start < 0:
            failures.append(f"镜头 {index} 的 start_seconds({start}) 不得为负值")
        if end <= start:
            failures.append(
                f"镜头 {index} 时长非法：end_seconds({end}) 必须大于 start_seconds({start})"
                f"（0 秒时长镜头视为占位错误，首镜头不得意外为 0 秒）"
            )
        parsed.append((position, start, end))

    # 相邻镜头连续性：按列表顺序两两检查（start[i+1] == end[i]，误差 ≤ 0.01s）。
    for (prev_pos, _prev_start, prev_end), (cur_pos, cur_start, _cur_end) in zip(parsed, parsed[1:]):
        drift = abs(cur_start - prev_end)
        if drift > _SHOT_SEAM_TOLERANCE_SECONDS:
            failures.append(
                f"镜头 {cur_pos + 1} 与上一镜头不连续：start({cur_start}) 与上一镜头 end({prev_end})"
                f" 偏差 {round(drift, 6)}s 超过 {_SHOT_SEAM_TOLERANCE_SECONDS}s（存在缺口或意外重叠）"
            )

    if parsed and target is not None:
        first_start = parsed[0][1]
        last_end = max(item[2] for item in parsed)
        total = last_end - first_start
        drift = abs(total - target)
        if drift > tolerance + 1e-9:
            failures.append(
                f"总时长 {round(total, 6)}s 与目标 {target}s 偏差 {round(drift, 6)}s 超过容差 {tolerance}s"
            )
        details_total: Any = round(total, 6)
    else:
        details_total = None

    details = {
        "shot_count": len(parsed),
        "total_seconds": details_total,
        "target_total_seconds": target,
        "tolerance_seconds": tolerance,
        "seam_tolerance_seconds": _SHOT_SEAM_TOLERANCE_SECONDS,
    }
    return _verifier_result(not failures, failures, details)


def verify_asset_mentions(case: EvalCase) -> dict[str, Any]:
    """校验 @资产引用：存在性、项目归属、确认状态、能力匹配与 @名称一致性。

    规则（对 input.mentions/asset_catalog/current_project_id）：
    - 引用资产必须存在于 catalog；
    - 资产 ``project_id`` 必须等于 ``current_project_id``（禁止跨项目引用）；
    - 资产 ``status`` 必须在 {confirmed, ready}（draft/candidate/archived 不可
      当作已确认资产）；
    - mention 声明的 ``purpose`` 有能力要求时（如 video → image），资产
      ``capabilities`` 必须包含对应能力（资产类型与声明能力匹配）；
    - mention 文本中的 ``@名称`` 引用必须与 catalog 内资产名一致（@ 了不存在的
      名字、或本资产名未被正确 @ 均判失败；文本无任何 @ 引用则跳过本条）。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常；非法输入按失败说明降级处理。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    mentions = payload.get("mentions")
    catalog_rows = payload.get("asset_catalog")
    current_project_id = payload.get("current_project_id")

    if not isinstance(mentions, list) or not mentions:
        failures.append("mentions 必须是非空引用列表")
        mentions = []
    catalog: dict[str, dict[str, Any]] = {}
    if isinstance(catalog_rows, list):
        for row in catalog_rows:
            if isinstance(row, dict) and row.get("asset_id") is not None:
                catalog[str(row["asset_id"])] = row
    else:
        failures.append("asset_catalog 必须是资产列表")
    if current_project_id is None:
        failures.append("current_project_id 缺失，无法校验项目归属")

    catalog_names = {str(row.get("name")) for row in catalog.values() if row.get("name") is not None}
    for position, mention in enumerate(mentions):
        if not isinstance(mention, dict):
            failures.append(f"mention #{position + 1} 必须是 dict（含 asset_id/text）")
            continue
        asset_id = str(mention.get("asset_id"))
        text = mention.get("text")
        asset = catalog.get(asset_id)
        if asset is None:
            failures.append(f"引用资产 {asset_id} 不存在于资产目录")
            continue
        if current_project_id is not None and asset.get("project_id") != current_project_id:
            failures.append(
                f"引用资产 {asset_id} 属于项目 {asset.get('project_id')}，"
                f"与当前项目 {current_project_id} 不一致（跨项目引用）"
            )
        status = asset.get("status")
        if status not in _USABLE_ASSET_STATUSES:
            failures.append(
                f"引用资产 {asset_id} 状态为 {status}，不可作为已确认资产"
                f"（仅 confirmed/ready 可用）"
            )
        purpose = mention.get("purpose")
        required = _PURPOSE_REQUIRED_CAPABILITY.get(str(purpose)) if purpose is not None else None
        if required is not None:
            capabilities = asset.get("capabilities")
            capability_set = set(capabilities) if isinstance(capabilities, list) else set()
            if required not in capability_set:
                failures.append(
                    f"引用资产 {asset_id} 用途 {purpose} 要求能力 {required}，"
                    f"但资产能力为 {sorted(capability_set)}（类型与声明能力不匹配）"
                )
        if isinstance(text, str) and text.strip():
            referenced_names = _AT_MENTION_PATTERN.findall(text)
            if referenced_names:
                unknown = [name for name in referenced_names if name not in catalog_names]
                if unknown:
                    failures.append(
                        f"引用资产 {asset_id} 的文本 @引用 {unknown} 与资产目录名称不一致"
                    )
                asset_name = asset.get("name")
                if asset_name is not None and str(asset_name) not in referenced_names:
                    failures.append(
                        f"引用资产 {asset_id} 未被正确 @引用：文本引用 {referenced_names}，"
                        f"资产目录名称为 {asset_name}"
                    )

    details = {
        "checked_mentions": len(mentions),
        "catalog_size": len(catalog),
        "current_project_id": current_project_id,
    }
    return _verifier_result(not failures, failures, details)


def _gender_polarity(value: Any) -> str | None:
    """把 gender 字段归一为 male/female。

    :param value: gender 原始值（如 "male"/"female"/"男"/"女"）。
    :return: "male"/"female"；无法识别返回 None。
    """
    text = str(value).strip().lower()
    if not text:
        return None
    if "女" in text or text.startswith("f"):
        return "female"
    if "男" in text or text.startswith("m"):
        return "male"
    return None


def _age_group(value: Any) -> str | None:
    """把 age_range 字段归一为年龄组键。

    :param value: age_range 原始值（组键如 "youth"，或组内词如 "少年"）。
    :return: 组键（child/youth/middle/elder）；无法识别返回 None。
    """
    text = str(value).strip().lower()
    if not text:
        return None
    if text in _AGE_GROUP_WORDS:
        return text
    for group, words in _AGE_GROUP_WORDS.items():
        if any(word in text for word in words):
            return group
    return None


def verify_character_consistency(case: EvalCase) -> dict[str, Any]:
    """校验角色设定与约束文本的矛盾（小型中文矛盾词表，样本文本受控）。

    规则（对 input.character 与 input.constraints）：
    - 性别矛盾：gender 与 appearance/非 asset_reference 约束文本中的对立性别词
      （男/女、他/她）冲突；
    - 年龄矛盾：age_range 组与文本中其他年龄段词（少年 vs 中年等）冲突；
    - 身份矛盾：identity 与 clothing 命中身份-服饰冲突词表（如 学生 vs 警服）；
    - 音色绑定：存在 ``category=dialogue`` 的对白约束而 ``voice_binding`` 缺失 → fail；
    - **约束类别区分**：``constraints[].category == "asset_reference"`` 的条目是
      资产参考约束，不参与性别/年龄等动作矛盾检查（防止背景参考文本误伤主角设定）。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常；非法输入按失败说明降级处理。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    character = payload.get("character")
    constraints = payload.get("constraints")

    if not isinstance(character, dict):
        failures.append("character 必须是 dict（含 gender/age_range/appearance/clothing/identity/voice_binding）")
        character = {}
    if not isinstance(constraints, list):
        failures.append("constraints 必须是约束列表")
        constraints = []

    action_texts: list[str] = []
    dialogue_required = False
    skipped_asset_reference = 0
    for constraint in constraints:
        if not isinstance(constraint, dict):
            failures.append("constraints 元素必须是 dict（含 category/text）")
            continue
        category = str(constraint.get("category", ""))
        text = constraint.get("text")
        text_value = text if isinstance(text, str) else ""
        if category == "asset_reference":
            # 资产参考约束描述的是参考素材，不代表主角本身，不参与动作矛盾检查。
            skipped_asset_reference += 1
            continue
        if text_value.strip():
            action_texts.append(text_value)
        if category == "dialogue":
            dialogue_required = True

    appearance = character.get("appearance")
    appearance_text = appearance if isinstance(appearance, str) else ""
    checked_texts = [appearance_text] + action_texts

    # 1) 性别矛盾。
    polarity = _gender_polarity(character.get("gender"))
    if polarity is not None:
        opposite_words = _GENDER_MALE_WORDS if polarity == "female" else _GENDER_FEMALE_WORDS
        for text in checked_texts:
            for word in opposite_words:
                if word in text:
                    failures.append(
                        f"性别矛盾：gender={character.get('gender')}，但文本「{text}」含对立性别词「{word}」"
                    )

    # 2) 年龄矛盾。
    age_group = _age_group(character.get("age_range"))
    if age_group is not None:
        for text in checked_texts:
            for group, words in _AGE_GROUP_WORDS.items():
                if group == age_group:
                    continue
                for word in words:
                    if word in text:
                        failures.append(
                            f"年龄矛盾：age_range={character.get('age_range')}({age_group})，"
                            f"但文本「{text}」含其他年龄段词「{word}」({group})"
                        )

    # 3) 身份-服饰矛盾。
    identity = character.get("identity")
    identity_text = identity if isinstance(identity, str) else ""
    clothing = character.get("clothing")
    clothing_text = clothing if isinstance(clothing, str) else ""
    if identity_text and clothing_text:
        for identity_word, conflict_words in _IDENTITY_CLOTHING_CONFLICTS:
            if identity_word not in identity_text:
                continue
            for cloth_word in conflict_words:
                if cloth_word in clothing_text:
                    failures.append(
                        f"身份矛盾：identity 含「{identity_word}」与 clothing「{clothing_text}」"
                        f"中「{cloth_word}」冲突"
                    )

    # 4) 对白需求与音色绑定。
    voice_binding = character.get("voice_binding")
    voice_missing = voice_binding is None or (isinstance(voice_binding, str) and not voice_binding.strip())
    if dialogue_required and voice_missing:
        failures.append("存在对白约束（category=dialogue）但角色未绑定音色（voice_binding 缺失）")

    details = {
        "gender_polarity": polarity,
        "age_group": age_group,
        "checked_texts": len(checked_texts),
        "asset_reference_skipped": skipped_asset_reference,
        "dialogue_required": dialogue_required,
    }
    return _verifier_result(not failures, failures, details)


def verify_prompt_classification(case: EvalCase) -> dict[str, Any]:
    """校验四类 Prompt 的职责边界与排版。

    规则（对 input.prompts = [{kind,text,mentions}, ...]）：
    - kind 必须是 {prop_asset, scene_asset, storyboard_shot, video_action} 之一；
    - text 非空且排版干净：不含 ``\\r``、不含连续换行、换行后不得紧跟标点
      （换行乱序标记）；
    - scene_asset 文本不得含人物表演动词词表（表演/说话/奔跑/抬头等）；
    - video_action 文本不得混入 prop_asset 的静态描述模式（"道具特写，静止"等）；
    - storyboard_shot 必须保留非空 mentions（执行所需 @引用）。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    prompts = payload.get("prompts")
    if not isinstance(prompts, list) or not prompts:
        failures.append("prompts 必须是非空列表")
        prompts = []

    kinds_seen: list[str] = []
    for position, prompt in enumerate(prompts):
        label = f"prompt[{position}]"
        if not isinstance(prompt, dict):
            failures.append(f"{label} 必须是 dict（含 kind/text/mentions）")
            continue
        kind = prompt.get("kind")
        text = prompt.get("text")
        mentions = prompt.get("mentions")
        text_value = text if isinstance(text, str) else ""
        kind_value = str(kind) if kind is not None else ""

        if kind_value not in _PROMPT_KINDS:
            failures.append(f"{label} kind 非法：{kind_value}（合法值：{sorted(_PROMPT_KINDS)}）")
        else:
            kinds_seen.append(kind_value)
        if not text_value.strip():
            failures.append(f"{label} text 为空（输出排版检查）")
            continue
        # 输出排版检查：拒绝 \r、连续换行与换行后紧跟标点的乱序标记。
        if "\r" in text_value:
            failures.append(f"{label} 排版乱序：文本含 \\r 回车符")
        if "\n\n" in text_value:
            failures.append(f"{label} 排版乱序：文本含连续空行")
        if re.search(r"\n\s*[，。！？；、,.!?]", text_value):
            failures.append(f"{label} 排版乱序：换行后紧跟标点")

        if kind_value == "scene_asset":
            for word in _PERFORMANCE_VERB_WORDS:
                if word in text_value:
                    failures.append(f"scene_asset 文本混入人物表演动词「{word}」：{label}")
        if kind_value == "video_action":
            for word in _STATIC_PROP_PATTERN_WORDS:
                if word in text_value:
                    failures.append(f"video_action 文本混入静态道具描述模式「{word}」：{label}")
        if kind_value == "storyboard_shot":
            if not isinstance(mentions, list) or not mentions:
                failures.append(
                    f"storyboard_shot 必须保留 mentions（执行所需 @引用），当前为空：{label}"
                )

    details = {
        "prompt_count": len(prompts),
        "kinds_seen": kinds_seen,
    }
    return _verifier_result(not failures, failures, details)


def verify_action_sound_cues(case: EvalCase) -> dict[str, Any]:
    """校验可观察动作五要素与声音 cue 的结构（文本规则只能证明结构）。

    规则（对 input.cues/shot_start_seconds/shot_end_seconds）：
    - 每条 cue 的 kind 必须是 {environment, dialogue, music} 之一；
    - 可观察动作五要素齐全：subject/goal/start_state/end_state 非空 + 时间区间
      （start_seconds/end_seconds 为数值）；
    - cue 时间区间满足 ``end > start`` 且完全落在镜头区间
      ``[shot_start_seconds, shot_end_seconds]`` 内；
    - **语义边界**：pending_review 样本（source=human_review）同样只做结构检查，
      details 额外标注 ``semantic_check="pending_human_review"``——"动作真的发生/
      音轨真的可听"不可机器判定，须人工抽检。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    cues = payload.get("cues")
    shot_start = _num(payload.get("shot_start_seconds"))
    shot_end = _num(payload.get("shot_end_seconds"))

    if not isinstance(cues, list) or not cues:
        failures.append("cues 必须是非空列表")
        cues = []
    if shot_start is None or shot_end is None:
        failures.append("shot_start_seconds/shot_end_seconds 必须为数值")
    elif shot_end <= shot_start:
        failures.append(f"镜头区间非法：[{shot_start}, {shot_end}]（要求 end > start）")

    required_fields = ("subject", "goal", "start_state", "end_state")
    for position, cue in enumerate(cues):
        label = f"cue[{position}]"
        if not isinstance(cue, dict):
            failures.append(f"{label} 必须是 dict（含 kind/时间区间/五要素）")
            continue
        kind = str(cue.get("kind")) if cue.get("kind") is not None else ""
        if kind not in _SOUND_CUE_KINDS:
            failures.append(f"{label} kind 非法：{kind}（合法值：{sorted(_SOUND_CUE_KINDS)}）")
        start = _num(cue.get("start_seconds"))
        end = _num(cue.get("end_seconds"))
        if start is None or end is None:
            failures.append(f"{label} 时间区间缺失或非数值（start_seconds/end_seconds）")
        elif end <= start:
            failures.append(f"{label} 时间区间非法：start={start}, end={end}（要求 end > start）")
        elif shot_start is not None and shot_end is not None:
            if start < shot_start or end > shot_end:
                failures.append(
                    f"{label} 时间区间 [{start}, {end}] 超出镜头区间 [{shot_start}, {shot_end}]"
                )
        missing = [
            field
            for field in required_fields
            if not str(cue.get(field) or "").strip()
        ]
        if missing:
            failures.append(f"{label} 缺少可观察动作要素：{missing}")

    details: dict[str, Any] = {
        "cue_count": len(cues),
        "shot_interval": [shot_start, shot_end],
        "pending_review": bool(case.pending_review),
    }
    if case.pending_review:
        # 语义判定（动作真实发生/音轨真实可听）不可机器判定，交人工抽检。
        details["semantic_check"] = "pending_human_review"
    return _verifier_result(not failures, failures, details)


def verify_failure_recovery(case: EvalCase) -> dict[str, Any]:
    """校验故障恢复场景名与期望结果的合法性（不执行真实恢复流程）。

    规则（对 input.scenarios = [{scenario, expected_outcome}, ...]）：
    - ``scenario`` 必须属于 :data:`KNOWN_RECOVERY_SCENARIOS`（阶段 2 六类场景
      常量：node_pre_failure / execution_interrupted / provider_created_not_saved /
      duplicate_callback / worker_restart / checkpoint_mismatch），未知场景名 fail；
    - ``expected_outcome`` 必须是 Agent 六态（与 app.agent.schemas.AgentRunStatus
      一致）或 "no_duplicate_submission"，其余（如自由文本 success）fail；
    - scenario / expected_outcome 必须为非空字符串。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    scenarios = payload.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        failures.append("scenarios 必须是非空列表")
        scenarios = []

    for position, scenario in enumerate(scenarios):
        label = f"scenario[{position}]"
        if not isinstance(scenario, dict):
            failures.append(f"{label} 必须是 dict（含 scenario/expected_outcome）")
            continue
        name = scenario.get("scenario")
        outcome = scenario.get("expected_outcome")
        name_value = str(name) if name is not None else ""
        outcome_value = str(outcome) if outcome is not None else ""
        if not name_value.strip():
            failures.append(f"{label} scenario 必须为非空字符串")
        elif name_value not in KNOWN_RECOVERY_SCENARIOS:
            failures.append(
                f"未知恢复场景名：{name_value}（已知场景：{sorted(KNOWN_RECOVERY_SCENARIOS)}）"
            )
        if not outcome_value.strip():
            failures.append(f"{label} expected_outcome 必须为非空字符串")
        elif outcome_value not in _VALID_RECOVERY_OUTCOMES:
            failures.append(
                f"场景 {name_value} 的 expected_outcome 非法：{outcome_value}"
                f"（只允许六态或 no_duplicate_submission）"
            )

    details = {
        "checked_scenarios": len(scenarios),
        "known_scenarios": sorted(KNOWN_RECOVERY_SCENARIOS),
        "valid_outcomes": sorted(_VALID_RECOVERY_OUTCOMES),
    }
    return _verifier_result(not failures, failures, details)


def _resolve_artifact_path(report_path: str) -> Path:
    """解析报告路径（相对仓库根 artifacts/ 优先，其次相对 api-service 根）。

    :param report_path: 绝对路径或相对仓库根的路径（如 artifacts/phase4-retrieval-eval.json）。
    :return: 解析后的 Path（不保证存在）。
    """
    candidate = Path(report_path)
    if candidate.is_absolute():
        return candidate
    for base in (_REPO_ROOT, _API_SERVICE_ROOT):
        resolved = base / candidate
        if resolved.exists():
            return resolved
    return _REPO_ROOT / candidate


def _extract_rag_summary(data: Any) -> dict[str, Any] | None:
    """从报告 JSON 中提取 summary 节点。

    优先级：cleaned_snapshot.summary（版本清理后的口径）→ raw_snapshot.summary →
    顶层 summary。

    :param data: 报告 JSON 反序列化结果。
    :return: summary dict；无法提取返回 None。
    """
    if not isinstance(data, dict):
        return None
    cleaned = data.get("cleaned_snapshot")
    if isinstance(cleaned, dict) and isinstance(cleaned.get("summary"), dict):
        return cleaned["summary"]
    raw = data.get("raw_snapshot")
    if isinstance(raw, dict) and isinstance(raw.get("summary"), dict):
        return raw["summary"]
    if isinstance(data.get("summary"), dict):
        return data["summary"]
    return None


def verify_rag_cases(case: EvalCase) -> dict[str, Any]:
    """校验 RAG 检索 Eval 报告的指标齐全性与泄漏上限。

    规则（input 为 ``{"rag_report_path": str}`` 或 ``{"rag_summary": dict}``）：
    - summary 必须含六键：recall_at_k / mrr / leak_count / empty_rate /
      latency_p50_ms / latency_p95_ms；
    - ``leak_count`` 必须 ≤ 设计内暴露上限（amb 类样本数，input.leak_limit 可覆盖，
      默认 1）；数据集 7 类齐全性由 rag-service 的 eval_dataset 自身断言，本函数
      不重复检查；
    - 指定 rag_report_path 而文件不存在 → failed，failures 给出修复指引；
    - rag_summary 与 rag_report_path 同时存在时优先使用内联 rag_summary。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``；details 标明指标来源与解析路径。
    :raises: 本函数不抛出异常；JSON 解析失败按失败说明降级处理。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    details: dict[str, Any] = {}
    summary: dict[str, Any] | None = None

    inline_summary = payload.get("rag_summary")
    report_path = payload.get("rag_report_path")
    if isinstance(inline_summary, dict):
        summary = inline_summary
        details["summary_source"] = "inline_rag_summary"
    elif isinstance(report_path, str) and report_path.strip():
        resolved = _resolve_artifact_path(report_path)
        details["summary_source"] = "report_file"
        details["resolved_path"] = str(resolved)
        if not resolved.exists():
            failures.append(
                f"RAG Eval 报告文件不存在：{resolved}（输入路径：{report_path}）。"
                f"修复指引：先运行 rag-service 离线检索评测生成报告（数据集见 "
                f"rag-service/app/eval_dataset.py，评测入口见 rag-service/app/retrieval_eval.py），"
                f"或将阶段 4 报告放回 artifacts/phase4-retrieval-eval.json，"
                f"或在样本 input 内联 rag_summary"
            )
        else:
            try:
                with open(resolved, "r", encoding="utf-8") as handle:
                    data = json.load(handle)
            except (OSError, ValueError) as exc:
                failures.append(f"RAG Eval 报告 JSON 解析失败：{resolved}（{exc}）")
                data = None
            summary = _extract_rag_summary(data) if data is not None else None
            if summary is None and not failures:
                failures.append(
                    f"RAG Eval 报告缺少 summary 节点：{resolved}"
                    f"（期望 cleaned_snapshot.summary / raw_snapshot.summary / summary 之一）"
                )
    else:
        failures.append("input 必须提供 rag_report_path（相对仓库根）或 rag_summary（内联 dict）")

    if summary is not None:
        missing = sorted(_RAG_REQUIRED_METRIC_KEYS - set(summary))
        if missing:
            failures.append(f"RAG summary 缺少指标键：{missing}（要求六键齐全）")
        leak_count = _num(summary.get("leak_count"))
        leak_limit = _num(payload.get("leak_limit")) or float(_RAG_DEFAULT_LEAK_LIMIT)
        details["leak_limit"] = leak_limit
        if leak_count is None:
            failures.append("leak_count 必须为数值")
            details["leak_count"] = summary.get("leak_count")
        else:
            details["leak_count"] = leak_count
            if leak_count > leak_limit:
                failures.append(
                    f"leak_count={leak_count} 超过设计内暴露上限 {leak_limit}"
                    f"（上限 = 数据集 amb 类样本数，可用 input.leak_limit 覆盖）"
                )
        details["summary_keys_present"] = sorted(set(summary) & _RAG_REQUIRED_METRIC_KEYS)

    return _verifier_result(not failures, failures, details)


def _iter_url_values(node: Any):
    """递归收集结构中所有媒体 URL 字段值（键名含 url 的非空字符串）。

    :param node: 任意 JSON 值。
    :yields: 命中的 URL 字符串。
    """
    if isinstance(node, dict):
        for key, value in node.items():
            if (
                isinstance(key, str)
                and "url" in key.lower()
                and isinstance(value, str)
                and value.strip()
            ):
                yield value
            else:
                yield from _iter_url_values(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_url_values(item)


def verify_api_compatibility(case: EvalCase) -> dict[str, Any]:
    """校验 API envelope 形态与错误码约定。

    规则（对 input.samples = [{path,method,expected_status,expected_envelope}, ...]）：
    - path/method 非空；
    - envelope 三键齐全：code / message / data；
    - ``code`` 必须为 int（bool 不算）；
    - ``code`` 必须命中错误码约定表（401 未登录 / 4010 token 失效 / 403 权限 /
      404 不存在 / 409 冲突状态 / 2xx ↔ 0），其中 401↔4010 为允许特例；
      expected_status 不在约定表内判 fail；
    - envelope 内媒体 URL 字段（键名含 url 的非空字符串，递归收集）必须以
      ``http://``、``https://`` 或相对 ``/`` 开头。

    :param case: 样本。
    :returns: ``{"passed","failures","details"}``。
    :raises: 本函数不抛出异常。
    """
    failures: list[str] = []
    payload = _payload_dict(case, failures)
    samples = payload.get("samples")
    if not isinstance(samples, list) or not samples:
        failures.append("samples 必须是非空列表")
        samples = []

    for position, sample in enumerate(samples):
        label = f"sample[{position}]"
        if not isinstance(sample, dict):
            failures.append(f"{label} 必须是 dict（含 path/method/expected_status/expected_envelope）")
            continue
        path_value = str(sample.get("path") or "")
        method_value = str(sample.get("method") or "")
        if not path_value.strip() or not method_value.strip():
            failures.append(f"{label} path/method 必须为非空字符串")
        envelope = sample.get("expected_envelope")
        status = sample.get("expected_status")
        if not isinstance(envelope, dict):
            failures.append(f"{label} expected_envelope 必须是 dict")
            envelope = {}
        missing_keys = sorted({"code", "message", "data"} - set(envelope))
        if missing_keys:
            failures.append(f"{label} envelope 缺少键：{missing_keys}（要求 code/message/data 三键齐全）")
        code = envelope.get("code")
        if not isinstance(code, int) or isinstance(code, bool):
            failures.append(f"{label} envelope code 必须为 int，当前 {code!r}")
        else:
            allowed = _STATUS_ALLOWED_CODES.get(status) if isinstance(status, int) and not isinstance(status, bool) else None
            if allowed is None:
                failures.append(f"{label} expected_status={status} 无错误码约定（无法校验 code 匹配）")
            elif code not in allowed:
                failures.append(
                    f"{label} expected_status={status} 与 code={code} 不匹配"
                    f"（约定允许 {sorted(allowed)}；401↔4010 为特例）"
                )
        for url in _iter_url_values(envelope):
            if not url.startswith(("http://", "https://", "/")):
                failures.append(
                    f"{label} media URL 非法：{url}（必须以 http://、https:// 或相对 / 开头）"
                )

    details = {
        "checked_samples": len(samples),
        "status_code_convention": {str(status): sorted(codes) for status, codes in _STATUS_ALLOWED_CODES.items()},
    }
    return _verifier_result(not failures, failures, details)


#: verifier 名 → 校验器函数注册表（runner 按样本 verifier 名查表执行）。
VERIFIERS: dict[str, Callable[[EvalCase], dict[str, Any]]] = {
    "verify_storyboard_duration": verify_storyboard_duration,
    "verify_asset_mentions": verify_asset_mentions,
    "verify_character_consistency": verify_character_consistency,
    "verify_prompt_classification": verify_prompt_classification,
    "verify_action_sound_cues": verify_action_sound_cues,
    "verify_failure_recovery": verify_failure_recovery,
    "verify_rag_cases": verify_rag_cases,
    "verify_api_compatibility": verify_api_compatibility,
}
