"""跨阶段统一的幂等键构造与反解析。

幂等键格式（与 ``agent_runs.idempotency_key``/``agent_paid_submissions.idempotency_key``
的 VARCHAR(160) 列宽对齐）::

    {task_type}:p{project_id}[:{stage_key}]:{business_ref}

约定：
- ``business_ref`` 必填且为稳定业务主键（分镜 ID/集号等），**拒绝包含 ":"**，
  保证键到字段的反解析无歧义；
- 同一业务重试（相同 task_type/project/stage/business_ref）构造出**同一个键**，
  不同 project/stage/business_ref 必然得到不同键。
"""

from __future__ import annotations

import re

from ..errors import InvalidInputError

# 幂等键列宽上限（agent_runs.idempotency_key 为 VARCHAR(160)）。
_IDEMPOTENCY_KEY_MAX_LENGTH = 160
# 匹配 "p{project_id}" 段的正则（project_id 为正整数）。
_PROJECT_SEGMENT_PATTERN = re.compile(r"^p([1-9]\d*)$")


def build_idempotency_key(
    *, task_type: str, project_id: int, stage_key: str | None, business_ref: str
) -> str:
    """按统一格式构造幂等键。

    :param task_type: 任务类型（如 ``storyboard_pipeline``）；不得包含 ":"。
    :param project_id: 项目 ID（正整数）。
    :param stage_key: 阶段键（如 ``video``）；可为 None（无阶段范围的幂等场景），
        非 None 时不得包含 ":"。
    :param business_ref: 稳定业务主键（分镜 ID/集号等）；必填非空白，拒绝包含 ":"
        （防止与分隔符混淆导致反解析歧义）。
    :returns: 形如 ``storyboard_pipeline:p8:video:ep-12`` 的幂等键字符串。
    :raises InvalidInputError: task_type 为空或含 ":"、project_id 非正整数、
        stage_key 为空串或含 ":"、business_ref 为空白或含 ":"、拼接结果超过
        160 字符（列宽上限）时抛出。
    """
    if not task_type or ":" in task_type:
        raise InvalidInputError("task_type 必须非空且不能包含 ':'")
    if not isinstance(project_id, int) or isinstance(project_id, bool) or project_id < 1:
        raise InvalidInputError("project_id 必须为正整数")
    if stage_key is not None and (not stage_key or ":" in stage_key):
        raise InvalidInputError("stage_key 必须非空且不能包含 ':'")
    if not business_ref or not business_ref.strip() or ":" in business_ref:
        raise InvalidInputError("business_ref 必填非空白，且不能包含 ':'（防反解析歧义）")
    key = f"{task_type}:p{project_id}"
    if stage_key is not None:
        key += f":{stage_key}"
    key += f":{business_ref}"
    if len(key) > _IDEMPOTENCY_KEY_MAX_LENGTH:
        raise InvalidInputError(
            f"幂等键长度超过列宽上限 {_IDEMPOTENCY_KEY_MAX_LENGTH}，请缩短 business_ref"
        )
    return key


def parse_idempotency_key(key: str) -> dict:
    """反解析幂等键为组成字段（build_idempotency_key 的逆操作）。

    :param key: 幂等键字符串。
    :returns: 字段 dict，含 ``task_type``/``project_id``/``stage_key``（可为 None）/
        ``business_ref``。
    :raises InvalidInputError: 键为空、段数不是 3（无 stage）或 4（含 stage）、
        存在空段、第二段不是 ``p{正整数}`` 形式时抛出。
    """
    if not key or ":" not in key:
        raise InvalidInputError("幂等键必须包含 ':' 分隔的多个段")
    parts = key.split(":")
    if len(parts) not in (3, 4):
        raise InvalidInputError("幂等键段数必须为 3（无 stage_key）或 4（含 stage_key）")
    if any(part == "" for part in parts):
        raise InvalidInputError("幂等键不允许出现空段")
    task_type = parts[0]
    matched = _PROJECT_SEGMENT_PATTERN.match(parts[1])
    if matched is None:
        raise InvalidInputError("幂等键第二段必须是 p{project_id} 形式（project_id 为正整数）")
    business_ref = parts[-1]
    stage_key = parts[2] if len(parts) == 4 else None
    return {
        "task_type": task_type,
        "project_id": int(matched.group(1)),
        "stage_key": stage_key,
        "business_ref": business_ref,
    }
