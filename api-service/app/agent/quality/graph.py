"""分镜质量分析的 LangGraph 编排图（阶段 1 试点）。

图结构::

    START -> load_storyboard -> rule_gate -> (model_review)? -> aggregate -> END

- ``load_storyboard``：校验 payload 中的分镜记录，非法输入置 ``blocked``；
- ``rule_gate``：执行资产引用门禁与生成上下文质检（纯规则，无外部调用）；
- ``model_review``：可选的模型复核节点，provider 由调用方注入
  （图本身不依赖任何付费服务，也不 import 运行时模块，保证独立可测）；
- ``aggregate``：汇总 ``validated_output`` 并落定最终状态。

状态约定：编译图 ``.invoke(state)`` 的输入与输出是同构 dict；
状态六态取值与 :mod:`app.agent.schemas` 的 ``AgentRunStatus`` 一致
（本图只会产生 completed / blocked / retryable_failed）。
"""

from __future__ import annotations

import json
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field, ValidationError

from ..errors import InvalidInputError, ModelOutputError
from .rules import inspect_storyboard_asset_reference_gate, inspect_storyboard_generation_context


class StoryboardReviewIssue(BaseModel):
    """模型复核问题条目。

    :param code: 机器可读问题码。
    :param message: 中文问题描述。
    :param severity: 问题级别，仅允许 blocker / warning。
    """

    code: str = Field(min_length=1, description="机器可读问题码")
    message: str = Field(min_length=1, description="问题描述")
    severity: Literal["blocker", "warning"] = Field(description="问题级别")


class StoryboardReviewVerdict(BaseModel):
    """模型复核结论的 schema（供 ``provider.complete_structured`` 校验输出）。

    :param overall_pass: 模型对分镜质量的总体判定。
    :param issues: 模型识别出的具体问题列表；severity=blocker 的项会并入图状态 blockers。
    """

    overall_pass: bool = Field(description="总体质量判定")
    issues: list[StoryboardReviewIssue] = Field(default_factory=list, description="问题列表")


class StoryboardQualityState(TypedDict, total=False):
    """分镜质量图的状态容器。

    :param payload: 任务输入负载，必须包含 dict 类型的 storyboard。
    :param require_character: 是否执行角色引用检查。
    :param require_scene: 是否执行场景引用检查。
    :param require_confirmed_assets: 资产检查模式（True=strict / False=draft）。
    :param rule_results: 两个规则检查报告的聚合。
    :param blockers: 规则与模型复核产生的 blocker 集合。
    :param model_verdict: 模型复核结论（未启用或失败时为 None）。
    :param status: 六态运行状态（本图为 completed/blocked/retryable_failed）。
    :param error: 脱敏错误说明（成功时为 None）。
    :param usage: 模型调用用量记录。
    :param validated_output: 汇总后的结构化输出（blocked 时为 None）。
        注意：LangGraph 以 TypedDict 注解为 state schema，未声明的键会被静默丢弃，
        因此本键必须显式声明。
    """

    payload: dict[str, Any]
    require_character: bool
    require_scene: bool
    require_confirmed_assets: bool
    rule_results: dict[str, Any]
    blockers: list[dict[str, Any]]
    model_verdict: dict[str, Any] | None
    status: str
    error: str | None
    usage: dict[str, Any]
    validated_output: dict[str, Any] | None


# 模型复核的系统提示：要求只输出可解释问题，不做开放式聊天。
_REVIEW_SYSTEM_PROMPT = (
    "你是分镜视频生成前的质量复核员。基于给定的规则质检报告，"
    "识别规则未覆盖的质量风险（如构图冲突、动作与镜头时长不匹配）。"
    "只输出可解释的结构化问题，不要闲聊；每个问题给出 code、message 与 severity。"
)


def _normalize_verdict(raw: Any) -> dict[str, Any]:
    """把 provider 返回值归一化为 ``StoryboardReviewVerdict`` 的 dict。

    :param raw: provider.complete_structured 的返回值（模型实例或 dict）。
    :return: 校验通过后的 dict（含 overall_pass / issues）。
    :raises ModelOutputError: 返回值既不是模型实例也不是合法 dict 时抛出。
    """
    if isinstance(raw, StoryboardReviewVerdict):
        return raw.model_dump()
    if isinstance(raw, dict):
        try:
            return StoryboardReviewVerdict.model_validate(raw).model_dump()
        except ValidationError as exc:
            raise ModelOutputError("模型复核输出未通过 schema 校验") from exc
    raise ModelOutputError("模型复核输出类型无法识别")


def build_storyboard_quality_graph(provider: Any, *, enable_model_review: bool = False) -> Any:
    """构建分镜质量分析编排图。

    :param provider: 结构化输出模型提供方，需实现
        ``complete_structured(system=..., user=..., schema_model=...)``；
        由调用方注入，测试可传入本地 Fake。
    :param enable_model_review: 是否启用模型复核节点；False 时规则通过后直达汇总。
    :return: 编译后的 LangGraph 图；``.invoke(state)`` 输入输出均为同构 dict。
    :raises Exception: LangGraph 构建配置错误时原样抛出（属编程错误，不静默）。
    """

    def load_storyboard(state: StoryboardQualityState) -> dict[str, Any]:
        """加载并校验分镜负载。

        :param state: 当前图状态。
        :return: 状态增量；payload 非法时置 status=blocked 并记录脱敏错误。
        :raises InvalidInputError: payload 缺少 dict 类型 storyboard 时抛出（节点内捕获）。
        """
        try:
            payload = state.get("payload")
            if not isinstance(payload, dict) or not isinstance(payload.get("storyboard"), dict):
                raise InvalidInputError("payload 必须包含 dict 类型的 storyboard 字段")
        except InvalidInputError as exc:
            return {"status": "blocked", "error": exc.message}
        return {}

    def rule_gate(state: StoryboardQualityState) -> dict[str, Any]:
        """执行两项纯规则质检并聚合 blockers。

        :param state: 当前图状态。
        :return: 状态增量，含 rule_results 与 blockers；blocked 状态下直通不处理。
        :raises: 规则函数本身不抛异常。
        """
        if state.get("status") == "blocked":
            return {}
        payload = state.get("payload") or {}
        storyboard = payload.get("storyboard") or {}
        assets = payload.get("assets")
        if not isinstance(assets, list):
            assets = []
        voices = payload.get("characterVoices")
        if voices is None:
            voices = payload.get("character_voices")
        if not isinstance(voices, list):
            voices = []
        asset_report = inspect_storyboard_asset_reference_gate(
            storyboard,
            require_character=bool(state.get("require_character", True)),
            require_scene=bool(state.get("require_scene", True)),
        )
        context_report = inspect_storyboard_generation_context(
            storyboard,
            assets,
            voices,
            require_confirmed_assets=bool(state.get("require_confirmed_assets", True)),
        )
        return {
            "rule_results": {
                "asset_reference": asset_report,
                "generation_context": context_report,
            },
            "blockers": list(asset_report["blockers"]) + list(context_report["blockers"]),
        }

    def model_review(state: StoryboardQualityState) -> dict[str, Any]:
        """可选的模型复核节点：调用注入的 provider 并合并 blocker 级问题。

        :param state: 当前图状态。
        :return: 状态增量，含 model_verdict / blockers / usage；
            模型输出不可解析时置 status=retryable_failed 并记录脱敏错误。
        :raises ModelOutputError: provider 输出不满足 schema 时抛出（节点内捕获）。
        """
        if state.get("status") == "blocked":
            return {}
        try:
            raw_verdict = provider.complete_structured(
                system=_REVIEW_SYSTEM_PROMPT,
                user=json.dumps(
                    {"rule_results": state.get("rule_results") or {}},
                    ensure_ascii=False,
                ),
                schema_model=StoryboardReviewVerdict,
            )
            verdict = _normalize_verdict(raw_verdict)
        except ModelOutputError as exc:
            return {
                "status": "retryable_failed",
                "error": exc.message,
                "usage": {**state.get("usage", {}), "model_calls": 1},
            }
        model_blockers = [
            issue for issue in verdict.get("issues", []) if issue.get("severity") == "blocker"
        ]
        return {
            "model_verdict": verdict,
            "blockers": list(state.get("blockers", [])) + model_blockers,
            "usage": {**state.get("usage", {}), "model_calls": 1},
        }

    def aggregate(state: StoryboardQualityState) -> dict[str, Any]:
        """汇总最终状态与 validated_output。

        :param state: 当前图状态。
        :return: 状态增量；blocked / retryable_failed 保留原状态，其余落定为 completed。
        :raises: 本节点不抛出异常。
        """
        status = state.get("status")
        if status not in ("blocked", "retryable_failed"):
            status = "completed"
        validated_output: dict[str, Any] | None = None
        if status != "blocked":
            rule_results = state.get("rule_results") or {}
            validated_output = {
                "asset_reference": rule_results.get("asset_reference"),
                "generation_context": rule_results.get("generation_context"),
                "model_review": state.get("model_verdict"),
            }
        return {"status": status, "validated_output": validated_output}

    def route_after_load(state: StoryboardQualityState) -> str:
        """load 之后路由：负载非法时跳过规则节点直达汇总。

        :param state: 当前图状态。
        :return: 下一节点名。
        """
        return "aggregate" if state.get("status") == "blocked" else "rule_gate"

    def route_after_rules(state: StoryboardQualityState) -> str:
        """规则之后路由：仅在启用模型复核且规则无 blocker 时进入 model_review。

        :param state: 当前图状态。
        :return: 下一节点名。
        """
        if enable_model_review and state.get("status") != "blocked" and not state.get("blockers"):
            return "model_review"
        return "aggregate"

    builder: StateGraph = StateGraph(StoryboardQualityState)
    builder.add_node("load_storyboard", load_storyboard)
    builder.add_node("rule_gate", rule_gate)
    builder.add_node("model_review", model_review)
    builder.add_node("aggregate", aggregate)
    builder.add_edge(START, "load_storyboard")
    builder.add_conditional_edges(
        "load_storyboard",
        route_after_load,
        {"aggregate": "aggregate", "rule_gate": "rule_gate"},
    )
    builder.add_conditional_edges(
        "rule_gate",
        route_after_rules,
        {"model_review": "model_review", "aggregate": "aggregate"},
    )
    builder.add_edge("model_review", "aggregate")
    builder.add_edge("aggregate", END)
    return builder.compile()
