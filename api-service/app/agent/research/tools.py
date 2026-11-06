"""受限只读项目范围内工具：DeepAgents 试点与 LangGraph 对照共用的数据源与工具集。

负面清单（明确**不提供**，docstring 与测试双重锁定）：

- 任何文件写入 / 编辑 / 删除工具（``write_file`` / ``edit_file`` / ``delete`` 等）；
- 任何 shell / 命令执行工具（``execute`` / ``bash`` 等）；
- 任意 URL 抓取 / 网络请求工具；
- 任何跨项目读取通道：每个工具签名强制携带 ``project_id``，与
  :class:`app.agent.schemas.ToolContext` 绑定的项目不一致即抛
  :class:`app.agent.errors.PermissionDeniedError`。

数据源为模块级内置 ``_PROJECT_KNOWLEDGE``（纯内存只读，id=5 与 id=7 两个
漫剧项目各 3 条知识：角色设定 / 场景设定 / 市场反馈），不访问数据库或外网。
"""

from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import BaseTool, tool

from ..errors import PermissionDeniedError
from ..schemas import ToolContext
from .budget import BudgetGuard

#: 内置项目知识库：{project_id: [知识条目]}。
#: 条目字段：id（知识条目 ID，citations 的 source）、title、content、
#: asset_id（关联资产 ID）、version（资产版本号）。
_PROJECT_KNOWLEDGE: dict[int, list[dict[str, Any]]] = {
    5: [
        {
            "id": 501,
            "title": "《星海拾光》主角林晚霞角色设定 v2",
            "content": "主角林晚霞：17 岁高二学生，性格外冷内热，标志性蓝色双马尾与星形发饰；"
            "战斗形态可召唤星光护盾。第二季设定新增星空礼服形态（角色资产 v2 变更）。",
            "asset_id": 901,
            "version": 2,
        },
        {
            "id": 502,
            "title": "《星海拾光》云海学园天台场景设定",
            "content": "云海学园天台：夕阳主光源，围栏为关键前景元素，远景为云海与浮空岛；"
            "夜景变体需切换月光冷色调（场景资产 v3 变更）。",
            "asset_id": 910,
            "version": 3,
        },
        {
            "id": 503,
            "title": "《星海拾光》第一集市场反馈摘要",
            "content": "第一集上线后观众正面反馈集中在角色塑造与作画质量，负面反馈集中在节奏偏慢；"
            "建议第二集前 3 分钟加强冲突铺垫。",
            "asset_id": 930,
            "version": 1,
        },
    ],
    7: [
        {
            "id": 701,
            "title": "《雾都夜行》侦探沈墨角色设定",
            "content": "侦探沈墨：中年男性，风衣与圆顶礼帽为标志装束，左眼有旧伤疤；"
            "口头禅为雨夜独白。角色资产 v1。",
            "asset_id": 951,
            "version": 1,
        },
        {
            "id": 702,
            "title": "《雾都夜行》旧城区雨夜街景设定",
            "content": "旧城区雨夜街景：霓虹招牌与湿滑石板路构成冷暖对比，雾气浓度分层控制；"
            "场景资产 v2 变更新增马车动线。",
            "asset_id": 960,
            "version": 2,
        },
        {
            "id": 703,
            "title": "《雾都夜行》海外发行市场反馈",
            "content": "海外试映反馈显示悬疑氛围接受度高，但字幕术语需本地化校准；"
            "建议保留雨夜意象作为视觉记忆点。",
            "asset_id": 980,
            "version": 1,
        },
    ],
}


def _iter_project_knowledge(project_id: int) -> list[dict[str, Any]]:
    """只读获取指定项目的知识条目列表（内部辅助）。

    :param project_id: 项目 ID。
    :return: 该项目的知识条目列表（未知项目返回空列表）。
    """
    return _PROJECT_KNOWLEDGE.get(project_id, [])


def _citation(entry: dict[str, Any]) -> dict[str, Any]:
    """由知识条目构造可回查的 citation 结构。

    :param entry: 知识条目 dict（含 id 与 title）。
    :return: ``{"source": 条目 id, "title": 条目标题}``。
    """
    return {"source": entry["id"], "title": entry["title"]}


@tool
def project_knowledge_lookup(query: str, project_id: int) -> str:
    """只读检索当前项目的知识库（角色设定/场景设定/市场反馈），返回命中条目与可回查来源。

    负面清单：本工具不可写文件、不可编辑、不可删除、不可执行 shell、
    不可抓取任意 URL，仅能在 ToolContext 绑定的项目范围内查询。
    query 为空时返回错误说明（不抛断言）；project_id 与上下文不一致时抛权限异常。
    """
    # 权限校验与预算计数由 bind_research_tools 的闭包包装层完成，
    # 本函数体只做数据查询（保持单一职责，包装层见 bind_research_tools）。
    raise NotImplementedError("请通过 bind_research_tools 获取包装后的工具实例")


@tool
def project_asset_version(asset_id: int, project_id: int) -> str:
    """只读查询当前项目内指定资产的版本信息，未找到时返回 not_found 说明。

    负面清单：本工具不可写文件、不可编辑、不可删除、不可执行 shell、
    不可抓取任意 URL，仅能在 ToolContext 绑定的项目范围内查询。
    project_id 与上下文不一致时抛权限异常。
    """
    # 同上：实际逻辑由 bind_research_tools 的闭包包装层提供。
    raise NotImplementedError("请通过 bind_research_tools 获取包装后的工具实例")


def bind_research_tools(context: ToolContext, budget: BudgetGuard) -> list[BaseTool]:
    """构造绑定项目上下文与预算守卫的受限只读工具列表（闭包共享）。

    每次工具调用依次执行：``budget.consume_tool_call()``（预算计数，触顶抛
    :class:`BudgetExceededError`）→ ``project_id`` 权限校验（越权抛
    :class:`PermissionDeniedError`）→ 只读查询并返回 JSON 字符串。
    DeepAgents 试点与 LangGraph 对照共用同一批闭包工具，保证计数口径一致。

    :param context: 工具执行上下文（绑定项目 / run / trace）。
    :param budget: 预算守卫（工具调用与成本估算计数）。
    :return: 两个受限只读工具：``project_knowledge_lookup`` 与
        ``project_asset_version``；不包含任何写 / 删 / shell / URL 抓取工具。
    :raises BudgetExceededError: 由包装层在预算触顶时原样传播（由图执行侧
        捕获并安全停止）。
    :raises PermissionDeniedError: 入参 project_id 与 context.project_id
        不一致时抛出。
    """

    def _lookup(query: str, project_id: int) -> str:
        """project_knowledge_lookup 的受控实现。

        :param query: 检索关键词（空白分词，任一词命中即返回该条）。
        :param project_id: 目标项目 ID，必须与上下文一致。
        :return: JSON 字符串；命中时 ``{"ok": true, "results": [...]}``，
            每项含 title/content/asset_id/version 与 source（知识条目 id+title）；
            query 为空时 ``{"ok": false, "error": "empty_query", ...}``。
        :raises BudgetExceededError: 预算触顶。
        :raises PermissionDeniedError: project_id 越权。
        """
        budget.consume_tool_call()
        if project_id != context.project_id:
            raise PermissionDeniedError(
                f"project_knowledge_lookup 拒绝跨项目访问：上下文项目为 "
                f"p{context.project_id}，请求项目为 p{project_id}"
            )
        if not query or not query.strip():
            return json.dumps(
                {"ok": False, "error": "empty_query", "message": "query 不能为空", "results": []},
                ensure_ascii=False,
            )
        keywords = [kw.casefold() for kw in query.strip().split() if kw.strip()]
        # 中文检索词通常无空白分词（如"主角林晚霞的角色设定"），整串匹配会漏检；
        # 以 2-gram 滑窗做轻量近似分词（不引入分词依赖），与整词匹配取并集。
        extra: set[str] = set()
        for keyword in keywords:
            if len(keyword) > 2:
                extra.update(keyword[i : i + 2] for i in range(len(keyword) - 1))
        keywords.extend(extra)
        results: list[dict[str, Any]] = []
        for entry in _iter_project_knowledge(project_id):
            haystack = f"{entry['title']}{entry['content']}".casefold()
            if any(kw in haystack for kw in keywords):
                results.append(
                    {
                        "title": entry["title"],
                        "content": entry["content"],
                        "asset_id": entry["asset_id"],
                        "version": entry["version"],
                        "source": {"id": entry["id"], "title": entry["title"]},
                    }
                )
        return json.dumps({"ok": True, "query": query, "results": results}, ensure_ascii=False)

    def _asset_version(asset_id: int, project_id: int) -> str:
        """project_asset_version 的受控实现。

        :param asset_id: 目标资产 ID。
        :param project_id: 目标项目 ID，必须与上下文一致。
        :return: JSON 字符串；找到时 ``{"ok": true, "asset": {...}, "source": {...}}``，
            未找到时 ``{"ok": false, "error": "not_found", ...}``。
        :raises BudgetExceededError: 预算触顶。
        :raises PermissionDeniedError: project_id 越权。
        """
        budget.consume_tool_call()
        if project_id != context.project_id:
            raise PermissionDeniedError(
                f"project_asset_version 拒绝跨项目访问：上下文项目为 "
                f"p{context.project_id}，请求项目为 p{project_id}"
            )
        for entry in _iter_project_knowledge(project_id):
            if entry["asset_id"] == asset_id:
                return json.dumps(
                    {
                        "ok": True,
                        "asset": {
                            "asset_id": entry["asset_id"],
                            "version": entry["version"],
                            "title": entry["title"],
                        },
                        "source": {"id": entry["id"], "title": entry["title"]},
                    },
                    ensure_ascii=False,
                )
        return json.dumps(
            {
                "ok": False,
                "error": "not_found",
                "message": "资产不存在或不在当前项目范围内",
                "asset_id": asset_id,
            },
            ensure_ascii=False,
        )

    # 以同名占位工具的 args_schema 为准重建受控实现，保持工具名 / 描述 /
    # 参数 schema 与模块级声明一致，同时把闭包（context/budget）注入其中。
    lookup_tool: BaseTool = _rebind(
        prototype=project_knowledge_lookup, name="project_knowledge_lookup", func=_lookup
    )
    asset_tool: BaseTool = _rebind(
        prototype=project_asset_version, name="project_asset_version", func=_asset_version
    )
    return [lookup_tool, asset_tool]


def _rebind(*, prototype: BaseTool, name: str, func: Any) -> BaseTool:
    """以占位工具为模板重建一个绑定具体实现的 StructuredTool。

    :param prototype: 模块级占位工具（提供名称 / 描述 / 参数 schema 模板）。
    :param name: 工具名（与占位工具一致）。
    :param func: 实际执行的闭包函数。
    :return: 绑定实现后的 BaseTool 实例。
    """
    from langchain_core.tools import StructuredTool

    return StructuredTool.from_function(
        name=name,
        description=prototype.description or "",
        func=func,
        args_schema=prototype.args_schema,
    )
