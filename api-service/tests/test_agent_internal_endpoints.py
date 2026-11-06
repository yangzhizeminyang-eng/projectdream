"""内部 Agent 端点（/internal/agent/*）测试。

通过 ``create_app(agent_runtime=...)`` 注入本地 Fake 运行时（invoke/get_status
闭包式记录），配合 ``_env_file=None`` 的 Settings，覆盖：无令牌 401、错令牌 403、
令牌未配置 503、试点开关关闭 503、invoke 成功 envelope、get_status 命中与 404。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.agent.schemas import AgentResult
from app.config import Settings
from app.main import create_app


class _StubDatabase:
    """内部端点测试的最小数据库桩：/internal 路由不触库，仅满足构造依赖。

    ``find_user_by_token`` 供既有 /api 原生路由（如 GET /api/projects）的
    鉴权降级使用：本测试只关心无效 token 返回 401/4010，因此恒返回 None。
    """

    def health(self) -> bool:
        """健康检查桩。

        :return: 恒为 True。
        """
        return True

    def find_user_by_token(self, token: str) -> None:
        """令牌查询桩。

        :param token: 请求携带的访问令牌（测试中恒为无效值）。
        :return: 恒为 None，表示令牌无效，触发 401/4010 envelope。
        """
        return None


class FakeAgentRuntime:
    """测试用 Fake Agent 运行时：记录 invoke 入参并提供可查状态。

    :ivar invoked: 每次 invoke 收到的 AgentRequest 列表。
    :ivar runs: 可查询的 run 状态表（缺省内置 run-1）。
    """

    def __init__(self) -> None:
        self.invoked: list = []
        self.runs: dict[str, dict] = {
            "run-1": {"runId": "run-1", "status": "completed", "projectId": 5},
        }

    def invoke(self, request):
        """同步执行一次 Agent run。

        :param request: AgentRequest 模型实例。
        :return: 固定的 completed AgentResult。
        """
        self.invoked.append(request)
        return AgentResult(
            run_id="run-1",
            status="completed",
            validated_output={"asset_reference": {"passed": True}},
            blockers=[],
            usage={"model_calls": 0},
            trace_id="trace-run-1",
            checkpoint_id="run-1",
        )

    def get_status(self, run_id: str):
        """查询运行状态。

        :param run_id: 运行 ID。
        :return: 命中时返回状态 dict；未命中返回 None。
        """
        return self.runs.get(run_id)


def make_client(**settings_kwargs):
    """构建带 Fake 运行时注入的测试客户端。

    :param settings_kwargs: 透传给 Settings 的额外配置项。
    :return: (TestClient, FakeAgentRuntime) 二元组。
    """
    settings = Settings(
        _env_file=None,
        **settings_kwargs,
    )
    runtime = FakeAgentRuntime()
    client = TestClient(create_app(settings, database=_StubDatabase(), agent_runtime=runtime))
    return client, runtime


_VALID_BODY = {
    "project_id": 5,
    "task_type": "storyboard_quality",
    "payload": {"storyboard": {"id": 21}},
    "idempotency_key": "storyboard-quality-21",
}


def test_internal_agent_run_requires_token_header():
    """未携带 X-Internal-Token 时返回 401 envelope。

    :return: 无返回值。
    :raises AssertionError: 状态码或 envelope 字段不符时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=True, internal_token="secret-token")

    response = client.post("/internal/agent/runs", json=_VALID_BODY)

    assert response.status_code == 401
    assert response.json() == {"code": 401, "message": "缺少内部调用令牌", "data": None}


def test_internal_agent_run_rejects_wrong_token():
    """令牌错误时返回 403 envelope。

    :return: 无返回值。
    :raises AssertionError: 状态码或 envelope 字段不符时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=True, internal_token="secret-token")

    response = client.post(
        "/internal/agent/runs",
        json=_VALID_BODY,
        headers={"X-Internal-Token": "wrong-token"},
    )

    assert response.status_code == 403
    assert response.json() == {"code": 403, "message": "内部调用令牌不正确", "data": None}


def test_internal_agent_run_returns_503_when_token_unconfigured():
    """试点开启但服务未配置令牌时返回 503 envelope。

    :return: 无返回值。
    :raises AssertionError: 状态码或 envelope 字段不符时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=True, internal_token="")

    response = client.post(
        "/internal/agent/runs",
        json=_VALID_BODY,
        headers={"X-Internal-Token": "anything"},
    )

    assert response.status_code == 503
    assert response.json() == {"code": 503, "message": "内部调用令牌未配置", "data": None}


def test_internal_agent_endpoints_disabled_when_pilot_switch_off():
    """agent_runtime_enabled=False 时两个端点都直接 503（标注试点未启用）。

    :return: 无返回值。
    :raises AssertionError: 任一端点状态码或文案不符时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=False, internal_token="secret-token")

    created = client.post(
        "/internal/agent/runs",
        json=_VALID_BODY,
        headers={"X-Internal-Token": "secret-token"},
    )
    queried = client.get(
        "/internal/agent/runs/run-1",
        headers={"X-Internal-Token": "secret-token"},
    )

    assert created.status_code == 503
    assert created.json() == {"code": 503, "message": "Agent 运行时试点未启用", "data": None}
    assert queried.status_code == 503
    assert queried.json()["message"] == "Agent 运行时试点未启用"


def test_internal_agent_run_returns_success_envelope_and_forwards_request():
    """invoke 成功时返回 code=0 envelope，并把 AgentRequest 原样交给 runtime。

    :return: 无返回值。
    :raises AssertionError: envelope 结构或转发的请求字段不符时抛出。
    """
    client, runtime = make_client(agent_runtime_enabled=True, internal_token="secret-token")

    response = client.post(
        "/internal/agent/runs",
        json=_VALID_BODY,
        headers={"X-Internal-Token": "secret-token"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["code"] == 0
    assert payload["data"]["run_id"] == "run-1"
    assert payload["data"]["status"] == "completed"
    assert payload["data"]["trace_id"] == "trace-run-1"
    assert len(runtime.invoked) == 1
    forwarded = runtime.invoked[0]
    assert forwarded.project_id == 5
    assert forwarded.task_type == "storyboard_quality"
    assert forwarded.payload == {"storyboard": {"id": 21}}
    assert forwarded.idempotency_key == "storyboard-quality-21"


def test_internal_agent_run_status_hit_and_miss():
    """get_status 命中返回 200 envelope；未命中返回 404 envelope。

    :return: 无返回值。
    :raises AssertionError: 状态码或 envelope 不符时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=True, internal_token="secret-token")
    headers = {"X-Internal-Token": "secret-token"}

    hit = client.get("/internal/agent/runs/run-1", headers=headers)
    miss = client.get("/internal/agent/runs/missing-run", headers=headers)

    assert hit.status_code == 200
    assert hit.json() == {
        "code": 0,
        "message": "success",
        "data": {"runId": "run-1", "status": "completed", "projectId": 5},
    }
    assert miss.status_code == 404
    assert miss.json() == {"code": 404, "message": "Agent run 不存在", "data": None}


def test_internal_agent_endpoints_do_not_shadow_api_proxy_routes():
    """/internal 前缀不影响既有 /api 代理路由的匹配。

    :return: 无返回值。
    :raises AssertionError: /api 路由行为改变时抛出。
    """
    client, _ = make_client(agent_runtime_enabled=True, internal_token="secret-token")

    response = client.get("/api/projects", headers={"Authorization": "Bearer missing"})

    assert response.status_code == 401
    assert response.json() == {"code": 4010, "message": "未登录或登录已过期", "data": None}
