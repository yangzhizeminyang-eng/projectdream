"""离线检索评测种子数据集：7 类场景 × 每类 2 条，共 14 条评测样本。

构建说明：
- :func:`_seed_documents` 返回可直接通过 ``POST /v1/index/documents`` 提交的
  文档集合（``text`` + 完整 metadata），覆盖两个漫剧项目（21《星海拾光》、
  22《雾都夜行》）的角色 / 场景 / 分镜资产，以及同名角色、新旧版本等冲突样本；
- 线上评测时的 ``query_fn`` 参考实现：按 case 的 ``required_filters`` 调用
  ``POST /v1/query``（携带 X-RAG-Internal-Token 与 X-RAG-Caller-Id），从返回
  items 中按顺序提取 ``metadata.asset_id``；
- 资产 ID 约定形如 ``p{project_id}-{asset_type}-{slug}``，
  :func:`app.retrieval_eval.evaluate_retrieval_metrics` 据此前缀解析项目归属、
  判定跨项目泄漏；版本差异用独立后缀（``-v1``/``-v2``）表达，使过期版本资产
  能被 ``forbid_asset_ids`` 单独禁止（query_fn 只依赖 asset_id 即可判定）。

场景口径：
- ``positive``：常规查询应命中本项目唯一期望资产；
- ``hard_negative``：跨项目同名角色干扰下仍应命中本项目资产、禁止他项目同名；
- ``isolation_project``：语义相近内容跨项目存在时，检索必须锁定 case 项目；
- ``isolation_episode``：同项目内其他分集资产不得出现在命中列表；
- ``stale_version``：查询应返回最新版本资产，过期版本禁止出现；
- ``empty``：语料中完全无关的查询应返回空结果；
- ``ambiguous``：短 query / 多候选竞争场景，期望主候选优先且竞争性禁止资产
  不被带出（MRR 反映排序质量）。
"""

from typing import Any

#: 评测场景类型全集（顺序即分组输出顺序参考）。
CASE_TYPES: tuple[str, ...] = (
    "positive",
    "hard_negative",
    "isolation_project",
    "isolation_episode",
    "stale_version",
    "empty",
    "ambiguous",
)

#: 种子文档统一的 source 标记（与 documents.build_metadata 的必填字段一致）。
_SEED_SOURCE = "confirmed_asset"


def _doc(
    *,
    project_id: int,
    episode_id: int | None,
    asset_type: str,
    asset_id: str,
    asset_version: int,
    text: str,
) -> dict[str, Any]:
    """构造一条与 /v1/index/documents 请求结构一致的种子文档。

    :param project_id: 项目 ID。
    :param episode_id: 分集 ID（可为 None 表示项目级）。
    :param asset_type: 资产类型（character/scene/storyboard）。
    :param asset_id: 资产 ID（含项目前缀与版本后缀约定）。
    :param asset_version: 资产版本号（与 asset_id 后缀保持一致）。
    :param text: 文档正文（包含 query 设计所依赖的关键词）。
    :return: ``{"text": ..., "metadata": {...}}`` 文档字典。
    """
    return {
        "text": text,
        "metadata": {
            "project_id": project_id,
            "episode_id": episode_id,
            "asset_type": asset_type,
            "asset_id": asset_id,
            "asset_version": asset_version,
            "source": _SEED_SOURCE,
        },
    }


def _seed_documents() -> list[dict[str, Any]]:
    """返回评测用 fixture 文档集合（与 14 条 case 的期望/禁止引用一致）。

    :return: 11 条种子文档，可直接交给 normalize_documents / 索引端点。
    """
    return [
        # 项目 21《星海拾光》：角色（新旧两版）、场景、两个分集的分镜、雨夜场景。
        _doc(
            project_id=21,
            episode_id=1,
            asset_type="character",
            asset_id="p21-char-linwanxia-v2",
            asset_version=2,
            text="林晚霞角色设定：17 岁高二学生，蓝色双马尾与星形发饰，战斗形态可召唤星光护盾，新增星空礼服形态。",
        ),
        _doc(
            project_id=21,
            episode_id=1,
            asset_type="character",
            asset_id="p21-char-linwanxia-v1",
            asset_version=1,
            text="林晚霞角色设定（旧版）：17 岁学生，蓝发造型，性格外冷内热。",
        ),
        _doc(
            project_id=21,
            episode_id=1,
            asset_type="scene",
            asset_id="p21-scene-tiantai",
            asset_version=1,
            text="云海学园天台场景：夕阳主光源，围栏为前景元素，远景为云海与浮空岛。",
        ),
        _doc(
            project_id=21,
            episode_id=1,
            asset_type="storyboard",
            asset_id="p21-storyboard-ep1",
            asset_version=1,
            text="第一集分镜：开场在天台，林晚霞与同学发生冲突铺垫。",
        ),
        _doc(
            project_id=21,
            episode_id=2,
            asset_type="storyboard",
            asset_id="p21-storyboard-ep2",
            asset_version=1,
            text="第二集分镜：星光护盾首次展开，冲突升级进入高潮。",
        ),
        _doc(
            project_id=21,
            episode_id=1,
            asset_type="scene",
            asset_id="p21-scene-nightmarket",
            asset_version=1,
            text="夜市雨幕场景：雨夜灯光穿过摊位棚顶，湿滑地面反光。",
        ),
        # 项目 22《雾都夜行》：侦探角色、旧城区场景（新旧两版）、同名客串角色、分镜。
        _doc(
            project_id=22,
            episode_id=1,
            asset_type="character",
            asset_id="p22-char-shenmo",
            asset_version=1,
            text="沈墨角色设定：中年侦探，风衣与圆顶礼帽，左眼旧伤疤，口头禅是雨夜独白。",
        ),
        _doc(
            project_id=22,
            episode_id=1,
            asset_type="scene",
            asset_id="p22-scene-oldtown-v1",
            asset_version=1,
            text="旧城区雨夜街景（旧版）：霓虹招牌与湿滑石板路构成冷暖对比。",
        ),
        _doc(
            project_id=22,
            episode_id=1,
            asset_type="scene",
            asset_id="p22-scene-oldtown-v2",
            asset_version=2,
            text="旧城区雨夜街景：霓虹招牌与湿滑石板路，新增马车动线分层控制。",
        ),
        _doc(
            project_id=22,
            episode_id=1,
            asset_type="character",
            asset_id="p22-char-linwanxia",
            asset_version=1,
            text="林晚霞（平行世界客串角色）：来自星海的转学生，深蓝制服造型。",
        ),
        _doc(
            project_id=22,
            episode_id=1,
            asset_type="storyboard",
            asset_id="p22-storyboard-ep1",
            asset_version=1,
            text="第一集分镜：雨夜旧城区，沈墨跟踪嫌疑人。",
        ),
    ]


def _case(
    *,
    case_id: str,
    case_type: str,
    project_id: int,
    episode_id: int | None,
    query: str,
    expect_hit_asset_ids: list[str],
    forbid_asset_ids: list[str],
) -> dict[str, Any]:
    """构造字段完整的评测样本。

    :param case_id: 全局唯一样本 ID。
    :param case_type: 场景类型（必须属于 CASE_TYPES）。
    :param project_id: 评测绑定的项目 ID。
    :param episode_id: 评测绑定的分集 ID（可为 None）。
    :param query: 评测查询文本。
    :param expect_hit_asset_ids: 期望命中的资产 ID 列表。
    :param forbid_asset_ids: 禁止出现的资产 ID 列表。
    :return: 含 required_filters 的完整 case 字典。
    """
    return {
        "case_id": case_id,
        "type": case_type,
        "project_id": project_id,
        "episode_id": episode_id,
        "query": query,
        "expect_hit_asset_ids": expect_hit_asset_ids,
        "forbid_asset_ids": forbid_asset_ids,
        "required_filters": {"project_id": project_id, "episode_id": episode_id},
    }


def evaluation_cases() -> list[dict[str, Any]]:
    """返回全部评测样本（7 类 × 2 条 = 14 条）。

    :return: case 列表，字段：case_id/type/project_id/episode_id/query/
        expect_hit_asset_ids/forbid_asset_ids/required_filters。
    """
    return [
        # positive：常规命中。
        _case(
            case_id="pos-01",
            case_type="positive",
            project_id=21,
            episode_id=1,
            query="林晚霞 蓝色双马尾 星形发饰 角色设定",
            expect_hit_asset_ids=["p21-char-linwanxia-v2"],
            forbid_asset_ids=[],
        ),
        _case(
            case_id="pos-02",
            case_type="positive",
            project_id=22,
            episode_id=1,
            query="沈墨 侦探 风衣 礼帽 角色设定",
            expect_hit_asset_ids=["p22-char-shenmo"],
            forbid_asset_ids=[],
        ),
        # hard_negative：跨项目同名角色。
        _case(
            case_id="hard-01",
            case_type="hard_negative",
            project_id=21,
            episode_id=1,
            query="林晚霞 角色设定",
            expect_hit_asset_ids=["p21-char-linwanxia-v2"],
            forbid_asset_ids=["p22-char-linwanxia"],
        ),
        _case(
            case_id="hard-02",
            case_type="hard_negative",
            project_id=22,
            episode_id=1,
            query="林晚霞 平行世界 客串角色",
            expect_hit_asset_ids=["p22-char-linwanxia"],
            forbid_asset_ids=["p21-char-linwanxia-v1", "p21-char-linwanxia-v2"],
        ),
        # isolation_project：语义相近内容跨项目存在，必须锁定项目。
        _case(
            case_id="iso-project-01",
            case_type="isolation_project",
            project_id=21,
            episode_id=None,
            query="雨夜 灯光 街道 场景设定",
            expect_hit_asset_ids=["p21-scene-nightmarket"],
            forbid_asset_ids=["p22-scene-oldtown-v2"],
        ),
        _case(
            case_id="iso-project-02",
            case_type="isolation_project",
            project_id=22,
            episode_id=None,
            query="雨夜 街景 霓虹 场景",
            expect_hit_asset_ids=["p22-scene-oldtown-v2"],
            forbid_asset_ids=["p21-scene-nightmarket"],
        ),
        # isolation_episode：同项目内其他分集资产不得出现。
        _case(
            case_id="iso-episode-01",
            case_type="isolation_episode",
            project_id=21,
            episode_id=1,
            query="分镜 冲突 开场",
            expect_hit_asset_ids=["p21-storyboard-ep1"],
            forbid_asset_ids=["p21-storyboard-ep2"],
        ),
        _case(
            case_id="iso-episode-02",
            case_type="isolation_episode",
            project_id=21,
            episode_id=2,
            query="分镜 星光护盾 冲突升级",
            expect_hit_asset_ids=["p21-storyboard-ep2"],
            forbid_asset_ids=["p21-storyboard-ep1"],
        ),
        # stale_version：过期版本禁止出现。
        _case(
            case_id="stale-01",
            case_type="stale_version",
            project_id=21,
            episode_id=1,
            query="林晚霞 最新版 角色设定",
            expect_hit_asset_ids=["p21-char-linwanxia-v2"],
            forbid_asset_ids=["p21-char-linwanxia-v1"],
        ),
        _case(
            case_id="stale-02",
            case_type="stale_version",
            project_id=22,
            episode_id=1,
            query="旧城区 街景 马车动线 最新版",
            expect_hit_asset_ids=["p22-scene-oldtown-v2"],
            forbid_asset_ids=["p22-scene-oldtown-v1"],
        ),
        # empty：语料中完全无关的查询。
        _case(
            case_id="empty-01",
            case_type="empty",
            project_id=21,
            episode_id=1,
            query="量子纠缠实验记录",
            expect_hit_asset_ids=[],
            forbid_asset_ids=[],
        ),
        _case(
            case_id="empty-02",
            case_type="empty",
            project_id=22,
            episode_id=1,
            query="校园篮球联赛战绩",
            expect_hit_asset_ids=[],
            forbid_asset_ids=[],
        ),
        # ambiguous：短 query 多候选竞争，期望主候选优先且禁止资产不被带出。
        _case(
            case_id="amb-01",
            case_type="ambiguous",
            project_id=21,
            episode_id=1,
            query="护盾",
            expect_hit_asset_ids=["p21-storyboard-ep2"],
            forbid_asset_ids=["p21-char-linwanxia-v1"],
        ),
        _case(
            case_id="amb-02",
            case_type="ambiguous",
            project_id=22,
            episode_id=1,
            query="雨夜",
            expect_hit_asset_ids=["p22-scene-oldtown-v2"],
            forbid_asset_ids=["p22-storyboard-ep1"],
        ),
    ]
