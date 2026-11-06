"""Script Agent 活动域层（对齐 Node ``server/services/script-agent.mjs``）。

剧本页的真实业务变更（故事设定 / 分集大纲 / 剧本正文 / 资产解析）由各业务路由完成，
本模块为每次变更提供可持久化的动作身份（action identity）与确定性的结构化反应
（reaction），供右侧 Agent 面板展示。刻意不把「聊天回复」伪装成「执行」——与 Node
版本语义逐条一致。

对齐基线：``server/services/script-agent.mjs``（223 行，含 ACTIONS/STAGES/STATUSES/
SOURCES 常量与 normalize/reaction/payload 三个纯函数）。
"""

from __future__ import annotations

from typing import Any

# 动作注册表：key → label / stageKey / agentKey / nextAction。
# 对齐 Node ACTIONS 常量（script-agent.mjs L10-L65），键序即 Node 对象字面量序。
SCRIPT_AGENT_ACTIONS: dict[str, dict[str, Any]] = {
    "generate-bible": {
        "label": "重新生成故事设定",
        "stageKey": "bible",
        "agentKey": "script-agent",
        "nextAction": {"key": "confirm-bible", "label": "检查并确认故事设定", "actionKey": "save-bible"},
    },
    "save-bible": {
        "label": "保存故事设定",
        "stageKey": "bible",
        "agentKey": "script-agent",
        "nextAction": {"key": "generate-season", "label": "生成分集大纲", "actionKey": "generate-season"},
    },
    "generate-season": {
        "label": "生成分集大纲",
        "stageKey": "season",
        "agentKey": "script-agent",
        "nextAction": {"key": "confirm-season", "label": "检查并确认分集大纲", "actionKey": "save-season"},
    },
    "save-season": {
        "label": "保存分集大纲",
        "stageKey": "season",
        "agentKey": "script-agent",
        "nextAction": {"key": "generate-script", "label": "生成剧本正文", "actionKey": "generate-script"},
    },
    "generate-script": {
        "label": "生成剧本正文",
        "stageKey": "script",
        "agentKey": "script-agent",
        "nextAction": {"key": "parse-assets", "label": "解析角色与场景资产", "actionKey": "parse-assets"},
    },
    "generate-scene": {
        "label": "生成单场正文",
        "stageKey": "script",
        "agentKey": "script-agent",
        "nextAction": {"key": "save-script", "label": "保存本场修改", "actionKey": "save-script"},
    },
    "generate-all-scenes": {
        "label": "批量生成全部剧集正文",
        "stageKey": "script",
        "agentKey": "script-agent",
        "nextAction": {"key": "parse-assets", "label": "解析角色与场景资产", "actionKey": "parse-assets"},
    },
    "save-script": {
        "label": "保存剧本修改",
        "stageKey": "script",
        "agentKey": "script-agent",
        "nextAction": {"key": "parse-assets", "label": "解析角色与场景资产", "actionKey": "parse-assets"},
    },
    "parse-assets": {
        "label": "解析角色与场景资产",
        "stageKey": "script",
        "agentKey": "asset-parser-agent",
        "nextAction": {"key": "open-assets", "label": "进入资产管理", "actionKey": "open-assets"},
    },
}

# 合法阶段 / 状态 / 来源枚举（对齐 Node STAGES/STATUSES/SOURCES）。
SCRIPT_AGENT_STAGES = {"bible", "season", "script"}
SCRIPT_AGENT_STATUSES = {"running", "completed", "blocked", "failed"}
SCRIPT_AGENT_SOURCES = {"button", "chat", "system"}

# 阶段 key → 中文名（reaction 文案用，对齐 Node 三元条件表达式的取值）。
_STAGE_LABELS = {"bible": "故事设定", "season": "分集大纲", "script": "剧本正文"}


def _text(value: Any, fallback: str = "") -> str:
    """Node ``text()``：str(value).trim()，空串取 fallback。"""
    normalized = str(value if value is not None else "").strip()
    return normalized or fallback


def _object(value: Any) -> dict[str, Any]:
    """Node ``object()``：仅接受普通对象，其余一律回退空对象。"""
    return value if isinstance(value, dict) else {}


def _list(value: Any, limit: int = 12) -> list[str]:
    """Node ``list()``：字符串数组逐项 trim + 过滤空串 + 截断（默认 12 条）。"""
    if isinstance(value, list):
        items = [_text(item) for item in value]
        return [item for item in items if item][:limit]
    return []


def normalize_script_agent_activity_input(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """归一化 Script Agent 活动输入（对齐 Node normalizeScriptAgentActivityInput）。

    校验顺序与 Node 一致：actionKey 必须在注册表内 → status 枚举 → stageKey 枚举
    （缺省取动作默认阶段）→ source 枚举（缺省 button）。

    :param input_data: 原始输入（actionKey/status/stageKey/source/title/summary/
                       context/result/errorText/idempotencyKey）。
    :returns: 归一化后的字段字典。
    :raises ValueError: actionKey 未知 / status / stageKey / source 非法时抛出，
                        message 与 Node 逐字一致。
    """
    payload = input_data or {}
    action_key = _text(payload.get("actionKey"))
    action = SCRIPT_AGENT_ACTIONS.get(action_key)
    if action is None:
        raise ValueError(f"未知 Script Agent 动作：{action_key or '空'}")

    status = _text(payload.get("status"), "running")
    if status not in SCRIPT_AGENT_STATUSES:
        raise ValueError(f"无效 Script Agent 状态：{status}")

    stage_key = _text(payload.get("stageKey"), action["stageKey"])
    if stage_key not in SCRIPT_AGENT_STAGES:
        raise ValueError(f"无效 Script Agent 阶段：{stage_key}")

    source = _text(payload.get("source"), "button")
    if source not in SCRIPT_AGENT_SOURCES:
        raise ValueError(f"无效 Script Agent 来源：{source}")

    return {
        "actionKey": action_key,
        "agentKey": _text(payload.get("agentKey"), action["agentKey"]),
        "stageKey": stage_key,
        "source": source,
        "status": status,
        "title": _text(payload.get("title"), action["label"]),
        "summary": _text(payload.get("summary")),
        "context": _object(payload.get("context")),
        "result": _object(payload.get("result")),
        "errorText": _text(payload.get("errorText")),
        "idempotencyKey": _text(payload.get("idempotencyKey")),
    }


def _resolve_count(result: dict[str, Any], keys: tuple[str, ...]) -> float | int | None:
    """Node ``resolveCount``：按序取第一个有限数值键。

    :param result: 归一化后的 result 对象。
    :param keys: 依次尝试的键名元组。
    :returns: 第一个有限数值（整数值收敛为 int 以对齐 JS Number 的展示形态）；
              全部缺失/非有限时 None。
    """
    for key in keys:
        # 缺键（undefined）→ NaN 跳过；显式 null/''/false → 0，true → 1。
        if key not in result:
            continue
        raw = result[key]
        if raw is None:
            value = 0.0
        elif isinstance(raw, bool):
            value = 1.0 if raw else 0.0
        else:
            try:
                value = float(str(raw).strip() or "0")
            except ValueError:
                continue
        # Node Number.isFinite：NaN/±Infinity 均视为无效。
        if value == value and value not in (float("inf"), float("-inf")):
            return int(value) if value.is_integer() else value
    return None


def build_script_agent_reaction(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """构建右侧 Agent 面板的确定性反应（对齐 Node buildScriptAgentReaction）。

    分支顺序与 Node 一致：running → failed → blocked → 完成（按 actionKey 生成
    专项 nextActions，为空时回退动作注册表的 nextAction；facts 追加版本号提示）。

    :param input_data: 活动输入（先经 normalize 归一化）。
    :returns: ``{agentKey, tone, headline, message, facts, nextActions}``。
    """
    normalized = normalize_script_agent_activity_input(input_data)
    result = normalized["result"]
    action = SCRIPT_AGENT_ACTIONS[normalized["actionKey"]]
    next_actions: list[dict[str, Any]] = []

    if normalized["status"] == "running":
        return {
            "agentKey": normalized["agentKey"],
            "tone": "working",
            "headline": f"{normalized['title']}已开始",
            "message": normalized["summary"]
            or f"我正在读取当前{_STAGE_LABELS[normalized['stageKey']]}并执行这项操作。",
            "facts": [],
            "nextActions": [],
        }

    if normalized["status"] == "failed":
        return {
            "agentKey": normalized["agentKey"],
            "tone": "danger",
            "headline": f"{normalized['title']}失败",
            "message": normalized["errorText"] or "这次操作没有完成，当前内容没有被当作新版本写入。",
            "facts": [],
            "nextActions": [{"key": "retry", "label": "重试当前动作", "actionKey": normalized["actionKey"]}],
        }

    if normalized["status"] == "blocked":
        return {
            "agentKey": normalized["agentKey"],
            "tone": "warning",
            "headline": f"{normalized['title']}被阻塞",
            "message": normalized["summary"] or "当前阶段还有前置内容未完成，我没有继续写入后续结果。",
            "facts": _list(result.get("blockers") or result.get("blockingIssues")),
            "nextActions": [
                {"key": f"next-{index}", "label": label, "actionKey": None}
                for index, label in enumerate(_list(result.get("nextActions")))
            ],
        }

    if normalized["actionKey"] == "generate-bible":
        character_count = _resolve_count(result, ("characterCount", "characters"))
        location_count = _resolve_count(result, ("locationCount", "locations"))
        if character_count is not None:
            next_actions.append({"key": "bible-characters", "label": f"检查 {character_count} 个角色设定", "actionKey": "save-bible"})
        if location_count is not None:
            next_actions.append({"key": "bible-locations", "label": f"检查 {location_count} 个主要场景", "actionKey": "save-bible"})
    elif normalized["actionKey"] == "generate-season":
        episode_count = _resolve_count(result, ("episodeCount", "episodes"))
        if episode_count is not None:
            next_actions.append({"key": "season-episodes", "label": f"检查 {episode_count} 集结构", "actionKey": "save-season"})
    elif normalized["actionKey"] == "generate-script":
        scene_count = _resolve_count(result, ("sceneCount", "scenes"))
        if scene_count is not None:
            next_actions.append({"key": "script-scenes", "label": f"检查 {scene_count} 个场景正文", "actionKey": "parse-assets"})
    elif normalized["actionKey"] == "parse-assets":
        character_count = _resolve_count(result, ("characterCount", "characters"))
        scene_count = _resolve_count(result, ("sceneCount", "scenes"))
        if character_count is not None or scene_count is not None:
            next_actions.append(
                {
                    "key": "asset-review",
                    "label": f"复核 {character_count if character_count is not None else 0} 个角色 / "
                    f"{scene_count if scene_count is not None else 0} 个场景",
                    "actionKey": "open-assets",
                }
            )

    if not next_actions and action.get("nextAction"):
        next_actions.append(action["nextAction"])

    facts = [*_list(result.get("facts")), *_list(result.get("changed"))]
    # Node Number.isInteger(Number(result.versionNo))：仅正整数插入版本提示。
    try:
        version_no = float(result.get("versionNo"))
    except (TypeError, ValueError):
        version_no = 0.0
    if version_no.is_integer() and version_no > 0:
        facts.insert(0, f"已写入第 {int(version_no)} 版结果")

    return {
        "agentKey": normalized["agentKey"],
        "tone": "success",
        "headline": f"{normalized['title']}完成",
        "message": normalized["summary"] or "结果已经写回当前项目，右侧给出了下一步检查项。",
        "facts": facts,
        "nextActions": next_actions,
    }


def build_script_agent_activity_payload(input_data: dict[str, Any] | None = None) -> dict[str, Any]:
    """归一化输入并附带反应体（对齐 Node buildScriptAgentActivityPayload）。

    :param input_data: 活动输入。
    :returns: 归一化字段 + ``reaction`` 键（build_script_agent_reaction 结果）。
    """
    normalized = normalize_script_agent_activity_input(input_data)
    return {**normalized, "reaction": build_script_agent_reaction(normalized)}
