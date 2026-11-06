"""8 阶段 Pipeline 的 LangGraph 编排图（阶段 2 兼容层核心）。

与 Node 侧 ``server/services/agent/pipeline-stages.mjs`` 的契约：
- ``PIPELINE_STAGES`` 的 key/agent_key/label_cn 与 Node 的 AGENT_PIPELINE_STAGES 逐字一致，
  UI/Node 兼容字段原样保留，不做任何改名或翻译。
- ``SCRIPTING_STAGE_KEYS`` 对应 Node 的 SCRIPTING_PIPELINE_STAGE_KEYS（前 4 个阶段）。

图结构（线性 8 节点，节点名即 stage key，保证可追踪）::

    START -> asset-parse -> character-lock -> scene-lock -> storyboard
          -> voice -> video -> quality -> delivery -> END

条件边：每个节点之后检查 ``state["status"]``，命中六态中的任一暂停/失败态
（waiting_approval/blocked/retryable_failed/failed/canceled）即直达 END——
图暂停返回，等待外部 decision 后从 checkpoint 恢复 state 重新入图。

**经验教训（必须遵守）**：LangGraph 以 TypedDict 注解为 state schema，
未声明的键会被 LangGraph **静默丢弃**（不进输出 state），所有 state 键必须
在 :class:`StoryboardPipelineState` 中显式声明；同时，未被任何节点写入的键
也不会出现在输出 state（输入 state 中已有的键会原样保留）。
"""

from __future__ import annotations

from typing import Any, Callable, Literal, Mapping, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field

from ..errors import InvalidInputError

# 阶段副作用枚举：决定该阶段在编排层的执行策略。
# - model_only：只做模型推理/规则计算，不落业务库；
# - db_write：写业务库（如角色/场景锁定、音色绑定）；
# - paid_submission：付费提交（video），必须走 paid_submission 幂等决策层；
# - worker_submission：真实执行归 Worker（delivery 本地导出），编排层只做提交决策；
# - read_only：只读检查（quality 成片质检）。
StageSideEffect = Literal[
    "model_only",
    "db_write",
    "paid_submission",
    "worker_submission",
    "read_only",
]


class StageDefinition(BaseModel):
    """单个 Pipeline 阶段的声明。

    :param key: 阶段键（与 Node ``AGENT_PIPELINE_STAGES[].key`` 逐字一致）。
    :param agent_key: Agent 标识（与 Node ``agentKey`` 逐字一致，UI/Node 兼容字段）。
    :param label_cn: 中文展示名（与 Node ``label`` 逐字一致）。
    :param side_effect: 副作用边界枚举，决定编排层执行策略与是否需要幂等防护。
    :param paid: 是否付费节点（True 时必须"先创建幂等任务，再提交供应商"）。
    :param worker_owned: 是否由 Worker 真实执行（True 时编排层只做准备与提交决策，
        长耗时生成不进 FastAPI 请求线程）。

    :raises pydantic.ValidationError: 字段缺失或类型不满足约束时抛出（编程错误，不静默）。
    """

    model_config = ConfigDict(frozen=True)

    key: str = Field(min_length=1, description="阶段键，与 Node 侧逐字一致")
    agent_key: str = Field(min_length=1, description="Agent 标识，与 Node 侧逐字一致")
    label_cn: str = Field(min_length=1, description="中文展示名")
    side_effect: StageSideEffect = Field(description="副作用边界枚举")
    paid: bool = Field(description="是否付费节点")
    worker_owned: bool = Field(description="是否由 Worker 真实执行")


# 8 阶段定义：key/agent_key/label 与 Node 侧 pipeline-stages.mjs 逐字一致。
PIPELINE_STAGES: tuple[StageDefinition, ...] = (
    StageDefinition(
        key="asset-parse", agent_key="asset-parser-agent", label_cn="资产解析",
        side_effect="model_only", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="character-lock", agent_key="character-agent", label_cn="角色锁定",
        side_effect="db_write", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="scene-lock", agent_key="scene-agent", label_cn="场景锁定",
        side_effect="db_write", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="storyboard", agent_key="storyboard-agent", label_cn="分镜脚本",
        side_effect="model_only", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="voice", agent_key="voice-agent", label_cn="音色绑定",
        side_effect="db_write", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="video", agent_key="video-agent", label_cn="视频生成",
        side_effect="paid_submission", paid=True, worker_owned=True,
    ),
    StageDefinition(
        key="quality", agent_key="quality-agent", label_cn="成片质检",
        side_effect="read_only", paid=False, worker_owned=False,
    ),
    StageDefinition(
        key="delivery", agent_key="delivery-agent", label_cn="本地导出",
        side_effect="worker_submission", paid=False, worker_owned=True,
    ),
)

# 编排前四阶段（剧本化生成范围），对应 Node 的 SCRIPTING_PIPELINE_STAGE_KEYS。
SCRIPTING_STAGE_KEYS: frozenset[str] = frozenset(
    {"asset-parse", "character-lock", "scene-lock", "storyboard"}
)

# stage key -> 阶段定义 的索引（双射与顺序判断的基础）。
_STAGE_INDEX: dict[str, StageDefinition] = {stage.key: stage for stage in PIPELINE_STAGES}

# stage key -> 顺序下标 的索引（恢复重放时判断"是否已越过本节点"）。
_STAGE_ORDER: dict[str, int] = {stage.key: index for index, stage in enumerate(PIPELINE_STAGES)}

# 触发图暂停/终止的状态集合（六态语义的编排层子集）。
# waiting_approval：等待外部审批，恢复后从 current_stage 重放；
# blocked/retryable_failed/failed/canceled：终态/受控失败，直达 END。
_INTERRUPT_STATUSES: frozenset[str] = frozenset(
    {"waiting_approval", "blocked", "retryable_failed", "failed", "canceled"}
)


class StoryboardPipelineState(TypedDict, total=False):
    """8 阶段编排图的状态容器（LangGraph state schema）。

    **必须显式声明全部键**：LangGraph 以 TypedDict 注解为 schema，未声明的键会被
    静默丢弃（阶段 1 质检图已踩过此坑）；未写入的键也不会出现在输出 state。

    :param payload: 任务输入负载（由 load/asset-parse 层做 schema 校验）。
    :param project_id: 项目 ID（权限与幂等键范围锚点）。
    :param episode_no: 剧集号（分镜/集级业务主键的一部分）。
    :param current_stage: 当前执行（或暂停等待恢复）的阶段 key；
        节点执行时写入自身 key，恢复重放时据此跳过已越过的节点。
    :param status: 六态运行状态（completed/failed/retryable_failed/blocked/
        waiting_approval/canceled），缺省视为继续执行。
    :param blockers: 阻塞项列表（元素含 code/message/severity）。
    :param error: 脱敏错误说明（成功时为 None）。
    :param usage: 模型调用用量记录（各阶段透传合并）。
    :param stage_results: 各阶段输出增量记录（key 为 stage key，保持执行顺序）。
    :param validated_output: 通过校验的结构化输出（失败/暂停时可为 None）。
    :param approvals: 外部审批注入（恢复时由调用方合并进 state，如 {"scene-lock": {...}}）。
    """

    payload: dict[str, Any]
    project_id: int | None
    episode_no: int | None
    current_stage: str | None
    status: str | None
    blockers: list[dict[str, Any]]
    error: str | None
    usage: dict[str, Any]
    stage_results: dict[str, Any]
    validated_output: dict[str, Any] | None
    approvals: dict[str, Any]


def node_name_for_stage(stage_key: str) -> str:
    """把 stage key 映射为图节点名。

    节点名与 stage key 一致（恒等映射），保证图执行轨迹可直接对照业务阶段。

    :param stage_key: 阶段键。
    :returns: 图节点名（与 stage key 相同）。
    :raises InvalidInputError: stage_key 不在 8 阶段定义内时抛出。
    """
    if stage_key not in _STAGE_INDEX:
        raise InvalidInputError(f"未知 stage key: {stage_key}")
    return stage_key


def stage_key_for_node(node_name: str) -> str:
    """把图节点名反解析为 stage key（node_name_for_stage 的逆映射，保持双射）。

    :param node_name: 图节点名。
    :returns: 阶段键。
    :raises InvalidInputError: node_name 不在 8 阶段定义内时抛出。
    """
    if node_name not in _STAGE_INDEX:
        raise InvalidInputError(f"未知图节点名: {node_name}")
    return node_name


def _make_stage_node(
    stage: StageDefinition, handler: Callable[[dict], dict] | None
) -> Callable[[dict], dict]:
    """为指定阶段构造 LangGraph 节点包装函数。

    节点行为：
    - 恢复重放跳过：state["current_stage"] 排在本节点之后时直接透传返回 {}；
    - 调用注入的 handler（缺省透传节点返回 {}，供编排测试）；
    - 捕获 InvalidInputError 映射为 blocked（其余异常向外抛，由运行时映射 failed）；
    - 合并增量并记录 stage_results[stage.key]，current_stage 落为自身 key。

    :param stage: 阶段定义。
    :param handler: 业务处理器 ``(state: dict) -> dict``（状态增量）；None 时为默认透传。
    :returns: LangGraph 节点函数 ``(state: dict) -> dict``。
    """
    stage_index = _STAGE_ORDER[stage.key]

    def stage_node(state: dict) -> dict:
        """执行单个阶段节点。

        :param state: 当前图状态。
        :returns: 状态增量；恢复重放时已越过本节点则返回 {}（不产生任何写入）。
        :raises Exception: handler 抛出的非 InvalidInputError 异常原样向外传播
            （由 AgentRuntime._execute 统一映射为 failed 终态）。
        """
        incoming_stage = state.get("current_stage")
        if (
            incoming_stage is not None
            and _STAGE_ORDER.get(incoming_stage, -1) > stage_index
        ):
            # 恢复重放：本节点已在上次执行中越过，跳过以保留 checkpoint 现场产物。
            return {}
        try:
            delta = dict(handler(state) or {}) if handler is not None else {}
        except InvalidInputError as exc:
            delta = {"status": "blocked", "error": exc.message}
        delta["current_stage"] = stage.key
        stage_results = dict(state.get("stage_results") or {})
        stage_results[stage.key] = {
            key: value for key, value in delta.items()
            if key not in ("current_stage", "stage_results")
        }
        delta["stage_results"] = stage_results
        return delta

    return stage_node


def _make_route(next_node: str) -> Callable[[dict], str]:
    """构造节点后的条件路由函数。

    :param next_node: 正常情况下应进入的下一节点名（最后一个阶段传 END）。
    :returns: 路由函数 ``(state: dict) -> str``，返回下一节点名或 END。
    """
    def route_after_stage(state: dict) -> str:
        """按六态语义路由：暂停/失败态直达 END，否则进入下一节点。

        :param state: 当前图状态。
        :returns: 下一节点名或 END。
        """
        status = state.get("status")
        if status in _INTERRUPT_STATUSES:
            return END
        return next_node

    return route_after_stage


def build_pipeline_graph(handler_registry: Mapping[str, Callable[[dict], dict]]) -> Any:
    """构建线性 8 节点的 Pipeline 编排图。

    :param handler_registry: stage key -> 业务处理器 ``(state: dict) -> dict``；
        未注册的阶段使用默认透传节点（返回 {}，供编排测试与灰度接入）。
    :returns: 编译后的 LangGraph 图；``.invoke(state)`` 输入输出同构 dict，
        恢复重放时输入 state 携带 checkpoint 的 current_stage 即可从暂停节点继续。
        注意：经 :class:`~app.agent.runtime.AgentRuntime` 集成时，成功路径的六态
        ``status`` 应由业务 handler（如 delivery 收尾阶段）落定——透传节点不写 status，
        ``AgentResult.status`` 为六态 Literal，未落定时运行时会校验失败。
    :raises Exception: LangGraph 构建配置错误时原样抛出（属编程错误，不静默）。
    """
    builder: StateGraph = StateGraph(StoryboardPipelineState)
    for stage in PIPELINE_STAGES:
        builder.add_node(stage.key, _make_stage_node(stage, handler_registry.get(stage.key)))
    for index, stage in enumerate(PIPELINE_STAGES):
        next_node = PIPELINE_STAGES[index + 1].key if index + 1 < len(PIPELINE_STAGES) else END
        builder.add_conditional_edges(
            stage.key,
            _make_route(next_node),
            {END: END} if next_node == END else {next_node: next_node, END: END},
        )
    builder.add_edge(START, PIPELINE_STAGES[0].key)
    return builder.compile()
