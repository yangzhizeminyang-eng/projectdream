import secrets
import time

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from .config import Settings
from .documents import normalize_documents
from .gateway import CallerGate
from .metrics import REQUESTS_TOTAL, get_metrics
from .milvus_store import create_vector_store
from .rag import index_documents, query_documents
from .schemas import IndexRequest, QueryRequest


def create_app(runtime_settings: Settings | None = None) -> FastAPI:
    service_settings = runtime_settings or Settings()
    service = FastAPI(title="ProjectDream RAG Service", version="0.1.0")
    service.state.settings = service_settings
    gate = CallerGate(service_settings)
    service.state.gate = gate

    @service.middleware("http")
    async def attach_request_id(request: Request, call_next) -> JSONResponse:
        """把外部 X-Request-Id（或生成的 uuid4 hex）写入 state 并随响应头返回。

        :param request: 当前请求。
        :param call_next: 下游处理链。
        :return: 附带 ``X-Request-Id`` 响应头的响应；/health、/ready 与错误响应同样生效。
        """
        request_id = gate.resolve_request_id(request.headers.get("X-Request-Id"))
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        return response

    @service.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": service_settings.app_name,
            "config": service_settings.public_summary(),
        }

    @service.get("/ready")
    async def ready() -> dict[str, object]:
        checks = {
            "milvus_configured": bool(service_settings.milvus_uri),
            "embedding_configured": bool(service_settings.zhipu_api_key),
            "internal_auth_configured": bool(service_settings.internal_token),
            "milvus_store_initialized": False,
        }
        if not all(
            checks[name]
            for name in ("milvus_configured", "embedding_configured", "internal_auth_configured")
        ):
            return JSONResponse(
                status_code=503,
                content={"status": "not_configured", "checks": checks},
            )
        try:
            create_vector_store(service_settings, service_settings.milvus_dim)
            checks["milvus_store_initialized"] = True
        except Exception:
            return JSONResponse(
                status_code=503,
                content={"status": "dependency_unavailable", "checks": checks},
            )
        return {"status": "ready", "checks": checks}

    def require_runtime_configuration(internal_token: str | None) -> None:
        if not service_settings.milvus_uri or not service_settings.zhipu_api_key:
            raise HTTPException(status_code=503, detail="RAG dependencies are not configured")
        if not service_settings.internal_token:
            raise HTTPException(status_code=503, detail="RAG internal authentication is not configured")
        if not internal_token:
            raise HTTPException(status_code=401, detail="RAG service token is required")
        if not secrets.compare_digest(internal_token, service_settings.internal_token):
            raise HTTPException(status_code=403, detail="RAG service token is invalid")

    @service.get("/metrics")
    async def metrics() -> PlainTextResponse:
        """纯文本指标端点：``key value`` 行，无 prometheus 依赖。

        :return: 计数器与延迟分位的文本渲染结果。
        """
        return PlainTextResponse(get_metrics().render(), media_type="text/plain; version=0.0.4")

    def _outcome_for(exc: BaseException) -> str:
        """把端点异常映射为审计/指标的 outcome 取值。

        :param exc: 端点处理中捕获的异常。
        :return: denied（401/403）、rate_limited（429）或 error（其余）。
        """
        if isinstance(exc, HTTPException):
            if exc.status_code in (401, 403):
                return "denied"
            if exc.status_code == 429:
                return "rate_limited"
        return "error"

    @service.post("/v1/index/documents")
    async def index(
        request: IndexRequest,
        http_request: Request,
        internal_token: str | None = Header(default=None, alias="X-RAG-Internal-Token"),
        caller_id: str | None = Header(default=None, alias="X-RAG-Caller-Id"),
    ) -> dict[str, object]:
        started = time.perf_counter()
        request_id = getattr(http_request.state, "request_id", None) or gate.resolve_request_id(None)
        endpoint = "/v1/index/documents"
        outcome = "ok"
        try:
            # 校验顺序：先内部令牌（401/403/503 语义不变），再 allowlist，再限流。
            require_runtime_configuration(internal_token)
            gate.check_caller(caller_id)
            gate.check_rate_limit(caller_id)
            count = await index_documents(
                service_settings,
                normalize_documents([item.model_dump() for item in request.documents]),
                replace_scopes=request.replace_scopes,
            )
            return {**count, "collection": service_settings.milvus_collection}
        except Exception as exc:
            outcome = _outcome_for(exc)
            raise
        finally:
            # index 端点不绑定单一项目，也不含 query/top_k；仅记录文档条数口径外的网关字段。
            gate.audit(
                request_id=request_id,
                caller_id=caller_id,
                endpoint=endpoint,
                outcome=outcome,
                duration_ms=(time.perf_counter() - started) * 1000,
                project_id=None,
                query=None,
                query_len=None,
                top_k=None,
            )
            get_metrics().increment_counter(
                REQUESTS_TOTAL, {"endpoint": endpoint, "outcome": outcome}
            )

    @service.post("/v1/query")
    async def query(
        request: QueryRequest,
        http_request: Request,
        internal_token: str | None = Header(default=None, alias="X-RAG-Internal-Token"),
        caller_id: str | None = Header(default=None, alias="X-RAG-Caller-Id"),
    ) -> dict[str, object]:
        started = time.perf_counter()
        request_id = getattr(http_request.state, "request_id", None) or gate.resolve_request_id(None)
        endpoint = "/v1/query"
        outcome = "ok"
        try:
            # 校验顺序：先内部令牌（401/403/503 语义不变），再 allowlist，再限流。
            require_runtime_configuration(internal_token)
            gate.check_caller(caller_id)
            gate.check_rate_limit(caller_id)
            items = await query_documents(
                service_settings,
                project_id=request.project_id,
                episode_id=request.episode_id,
                query=request.query,
                top_k=request.top_k,
            )
            return {"items": items}
        except Exception as exc:
            outcome = _outcome_for(exc)
            raise
        finally:
            gate.audit(
                request_id=request_id,
                caller_id=caller_id,
                endpoint=endpoint,
                outcome=outcome,
                duration_ms=(time.perf_counter() - started) * 1000,
                project_id=request.project_id,
                query=request.query,
                query_len=len(request.query),
                top_k=request.top_k,
            )
            get_metrics().increment_counter(
                REQUESTS_TOTAL, {"endpoint": endpoint, "outcome": outcome}
            )

    return service

app = create_app()
