# ProjectDream RAG Service

第一阶段的旁路检索服务，负责 LlamaIndex、Milvus 和智谱 `embedding-3` 的接入。现有 Node API 和媒体 Worker 暂不切换。

## Configuration

所有密钥只从运行时环境变量读取：

```text
ZHIPU_MODEL=embedding-3
ZHIPU_API_KEY=replace-me
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
ZHIPU_DIMENSIONS=2048
INTERNAL_TOKEN=replace-with-a-random-service-token
RAG_MILVUS_URI=http://milvus:19530
RAG_MILVUS_TOKEN=replace-me
MILVUS_COLLECTION=projectdream_rag_v1
MILVUS_DIM=2048
RAG_CALLER_ALLOWLIST=api-service-agent
RAG_RATE_LIMIT_PER_MINUTE=0
```

`ZHIPU_DIMENSIONS` 和 `MILVUS_DIM` 必须一致。向量维度改变时，创建新 collection 并重建索引，不要原地修改旧 collection。

调用方网关（阶段 4 闭环增强）：

- `RAG_CALLER_ALLOWLIST`：逗号分隔的调用方 ID 名单（对应请求头 `X-RAG-Caller-Id`）。**留空表示不启用**（放行所有通过令牌校验的请求，兼容既有部署）；启用后缺失调用方头返回 401，不在名单返回 403。校验顺序固定：先内部令牌（401/403/503 语义不变），再 allowlist，最后限流。
- `RAG_RATE_LIMIT_PER_MINUTE`：每个调用方每分钟允许的请求数，`0` 表示不限流。实现为进程内存滑动窗口（60 秒，按 caller id 分桶），超出配额返回 429，`detail` 携带 `retry_after_seconds`；窗口滑出后自动恢复。
- 所有业务请求接受可选的 `X-Request-Id` 头（缺失时生成 uuid4 hex），并随响应头原样返回；该 ID 贯穿请求日志。
- 每次索引/查询输出一条结构化审计（`rag_request`：request_id/caller_id/endpoint/project_id/query_len/top_k/duration_ms/outcome）与一条摘要日志；query 全文不落日志，摘要最多保留前 32 字符加省略号，内部令牌绝不进入日志。

开发环境可以把 `RAG_MILVUS_URI` 设置为本地 `.db` 文件路径，使用 Milvus Lite；生产环境使用标准 Milvus URI 和 token。当前默认是容器持久卷中的 Milvus Lite 数据库，**不是已连接的远程 Milvus**。用户提供的密码本身不能确定远端连接地址；获得内网 URI/地址后再通过 `RAG_MILVUS_URI` 与 `RAG_MILVUS_TOKEN` 切换。服务的 `/health` 仅检查进程，`/ready` 会尝试初始化 Milvus collection，配置缺失或初始化失败时返回 HTTP 503，且不会回显密钥或底层异常。

索引使用稳定文档 ID 和 Milvus upsert：同一 `project_id + episode_id + asset_type + asset_id + asset_version` 会覆盖对应向量，不会因为重复生成分镜而无限追加相同文档。内容变更时应递增 `asset_version`。调用 `/v1/index/documents` 时传 `replace_scopes=true` 表示提交完整项目/分集快照，服务会在相同范围删除不属于当前快照的旧文档；部分场景提交必须保持 `false`，避免误删未参与本次任务的场景。

## Scope rules

每条文档必须包含 `project_id`、`episode_id`、`asset_type`、`asset_id`、`asset_version` 和 `source`。查询必须带 `project_id`，可选 `episode_id`；检索层强制添加 metadata filter，避免跨项目召回。

## Endpoints

- `GET /health`: 进程健康和非敏感配置摘要
- `GET /ready`: 配置就绪检查
- `POST /v1/index/documents`: 显式写入文档和 metadata，可选 `replace_scopes` 快照替换
- `POST /v1/query`: 项目范围内语义检索
- `GET /metrics`: 纯文本 `key value` 指标行（无 prometheus 依赖）：`rag_requests_total{endpoint,outcome}`、`rag_embedding_errors_total`、`rag_milvus_errors_total`、`rag_query_hits_total` 与 `rag_request_latency_seconds{quantile}`（P50/P95/P99，最近排名法，样本容量 512）

指标埋点位置：请求计数在网关层（含 denied/rate_limited 等结果口径）；embedding 调用异常与 Milvus 存储异常在 `app.rag` 内计数后原样重抛；索引/检索成功路径记录延迟采样，检索命中条数累计进 `rag_query_hits_total`。

检索评测可调用 `app.retrieval_eval.evaluate_retrieval` 对测试样本做离线检查：项目/分集范围、期望资产命中、禁止资产泄漏。评测结果必须保留失败原因，不能用"召回成功"替代资产确认或人工质量审核。

批量检索质量评测（阶段 4）使用 `app.retrieval_eval.evaluate_retrieval_metrics(cases, query_fn, top_k=5)`：`query_fn(case)` 返回命中 asset_id 有序列表，报告包含 Recall@K、MRR、空结果率、延迟 P50/P95（毫秒）与跨项目泄漏数，并输出 per_case 明细与按 case type 分组小计。Precision@K 因标注集不含全量负样本、不具统计意义而**暂不输出**。种子数据集见 `app.eval_dataset`：7 类场景（positive / hard_negative 同名角色 / isolation_project / isolation_episode / stale_version / empty / ambiguous）各 2 条，附可直接走索引端点的 fixture 文档集合 `_seed_documents` 与 `query_fn` 参考实现说明。

这组接口暂不接入现有用户鉴权；当前只作为内网旁路原型，不得接收公网流量或生产业务数据。写入/查询接口必须携带 `X-RAG-Internal-Token`，与 `INTERNAL_TOKEN` 做常量时间比较；缺少令牌返回 401，错误令牌返回 403，未配置服务令牌返回 503。阶段 4 已补齐调用方 allowlist（`RAG_CALLER_ALLOWLIST`）、按调用方滑动窗口限流（`RAG_RATE_LIMIT_PER_MINUTE`）、request_id 追踪与脱敏审计、进程内指标与离线检索质量评测；在切换到业务流量前仍必须完成项目隔离验证、幂等/版本更新演练与备份恢复验证。

## Current migration boundary

- Existing Node API and media workers remain the production path. This service does not replace them and is not yet called by the application.
- The pilot uses explicit document ingestion with required project/episode/asset/version metadata; it does not crawl the database or silently index user content.
- Rotate any credential previously pasted into chat before configuring the cloud service. Keep secrets in the deployment environment only.
- Validate `ZHIPU_DIMENSIONS` against the selected embedding model/API account before creating the production collection. A dimension change requires a new collection and reindex.
- 平台缺口：`milvus-lite` 在 Windows 无 wheel，本地无法运行依赖真实 Milvus Lite 文件库的集成用例（`tests/test_contracts.py::test_milvus_lite_collection_is_loaded_and_project_filtered` 在 Windows 预期失败，CI/容器内通过）。阶段 4 新增的网关、指标与评测测试均以 fake embedding / fake vector store 实现，不依赖真实 Milvus。
- api-service 侧的受控检索入口为 `api-service/app/rag_adapter.py`（`RagRetrieverAdapter` + LangChain `RagServiceRetriever`）：project_id 在构造时绑定、查询签名不暴露项目参数，且**绝不直连 Milvus**——所有访问经 rag-service 鉴权通道。
