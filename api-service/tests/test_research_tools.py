"""受限只读工具测试：命中/未命中/空 query、跨项目越权、预算联动与负面清单。"""

from __future__ import annotations

import json

import pytest

from app.agent.errors import PermissionDeniedError
from app.agent.research.budget import BudgetGuard, ResearchBudget
from app.agent.research.tools import bind_research_tools
from app.agent.schemas import ToolContext


def _context(project_id: int = 5) -> ToolContext:
    """构造最小工具上下文。

    :param project_id: 项目 ID。
    :return: ToolContext 实例（只读范围声明）。
    """
    return ToolContext(
        project_id=project_id,
        run_id="run-research-tools",
        trace_id="trace-research-tools",
        granted_scopes=["project:read"],
    )


def _lookup(context: ToolContext, budget: BudgetGuard | None = None):
    """获取绑定上下文的知识检索工具。

    :param context: 工具上下文。
    :param budget: 预算守卫（缺省新建默认配置）。
    :return: project_knowledge_lookup 工具实例。
    """
    guard = budget or BudgetGuard(ResearchBudget())
    tools = bind_research_tools(context, guard)
    return next(t for t in tools if t.name == "project_knowledge_lookup")


def test_lookup_hits_expected_entry() -> None:
    """关键词命中：返回命中列表且每项含可回查 source（id+title）。

    :return: 无返回值。
    :raises AssertionError: 命中结果或 source 结构不符时抛出。
    """
    tool = _lookup(_context(5))

    payload = json.loads(tool.invoke({"query": "角色设定", "project_id": 5}))

    assert payload["ok"] is True
    assert payload["results"]
    for item in payload["results"]:
        assert item["source"]["id"]
        assert item["source"]["title"]
    assert any("林晚霞" in item["content"] for item in payload["results"])


def test_lookup_miss_returns_empty_list() -> None:
    """未命中：返回 results=[]（不报错、不抛异常）。

    :return: 无返回值。
    :raises AssertionError: 结果非空时抛出。
    """
    tool = _lookup(_context(5))

    payload = json.loads(tool.invoke({"query": "完全无关的词xyzq", "project_id": 5}))

    assert payload["ok"] is True
    assert payload["results"] == []


def test_lookup_empty_query_returns_error_message() -> None:
    """空 query：工具内返回错误说明（不抛断言）。

    :return: 无返回值。
    :raises AssertionError: 未返回 empty_query 错误时抛出。
    """
    tool = _lookup(_context(5))

    payload = json.loads(tool.invoke({"query": "   ", "project_id": 5}))

    assert payload["ok"] is False
    assert payload["error"] == "empty_query"


def test_cross_project_access_denied() -> None:
    """跨项目越权：ctx.project_id=5 传 project_id=7 必须抛 PermissionDeniedError。

    :return: 无返回值。
    :raises PermissionDeniedError: 越权调用被正确拒绝。
    """
    tool = _lookup(_context(5))

    with pytest.raises(PermissionDeniedError):
        tool.invoke({"query": "角色设定", "project_id": 7})


def test_asset_version_found_and_not_found() -> None:
    """资产版本查询：命中返回版本信息与 source；未命中返回 not_found 说明。

    :return: 无返回值。
    :raises AssertionError: 返回结构不符时抛出。
    """
    tools = bind_research_tools(_context(5), BudgetGuard(ResearchBudget()))
    asset_tool = next(t for t in tools if t.name == "project_asset_version")

    found = json.loads(asset_tool.invoke({"asset_id": 901, "project_id": 5}))
    missing = json.loads(asset_tool.invoke({"asset_id": 999999, "project_id": 5}))

    assert found["ok"] is True
    assert found["asset"]["version"] == 2
    assert found["source"]["id"]
    assert missing["ok"] is False
    assert missing["error"] == "not_found"


def test_asset_version_cross_project_denied() -> None:
    """资产版本跨项目越权：project_id 与上下文不一致必须拒绝。

    :return: 无返回值。
    :raises PermissionDeniedError: 越权调用被正确拒绝。
    """
    tools = bind_research_tools(_context(5), BudgetGuard(ResearchBudget()))
    asset_tool = next(t for t in tools if t.name == "project_asset_version")

    with pytest.raises(PermissionDeniedError):
        asset_tool.invoke({"asset_id": 951, "project_id": 7})


def test_tool_calls_counted_into_budget() -> None:
    """工具调用计数与预算联动：每次调用在 BudgetGuard 上累加。

    :return: 无返回值。
    :raises AssertionError: 计数不符时抛出。
    """
    context = _context(5)
    guard = BudgetGuard(ResearchBudget())
    tool = _lookup(context, guard)

    tool.invoke({"query": "角色", "project_id": 5})
    tool.invoke({"query": "场景", "project_id": 5})

    assert guard.snapshot()["tool_calls"]["used"] == 2


def test_negative_list_no_write_edit_shell_tools() -> None:
    """负面清单：工具名集合不含任何 write/edit/delete/shell/execute 语义。

    :return: 无返回值。
    :raises AssertionError: 出现禁用语义的工具名时抛出。
    """
    tools = bind_research_tools(_context(5), BudgetGuard(ResearchBudget()))
    names = {t.name for t in tools}

    assert names == {"project_knowledge_lookup", "project_asset_version"}
    forbidden = ("write", "edit", "delete", "shell", "execute", "bash", "rm", "fetch", "http")
    assert not any(any(word in name.lower() for word in forbidden) for name in names)
