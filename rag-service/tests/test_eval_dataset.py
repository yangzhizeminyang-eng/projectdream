"""种子评测数据集测试：7 类样本齐全、字段完整、种子文档与期望/禁止引用一致。"""

from app.eval_dataset import CASE_TYPES, _seed_documents, evaluation_cases
from app.documents import normalize_documents


def test_dataset_covers_seven_case_types_with_two_each():
    """7 类场景齐全且每类至少 2 条；case_id 全局唯一。

    :return: 无返回值。
    :raises AssertionError: 类型缺失、数量不足或 ID 重复时抛出。
    """
    cases = evaluation_cases()
    by_type: dict[str, list] = {}
    for case in cases:
        by_type.setdefault(case["type"], []).append(case)

    assert set(CASE_TYPES) == {
        "positive",
        "hard_negative",
        "isolation_project",
        "isolation_episode",
        "stale_version",
        "empty",
        "ambiguous",
    }
    for case_type in CASE_TYPES:
        assert len(by_type.get(case_type, [])) >= 2, f"场景 {case_type} 样本不足 2 条"

    case_ids = [case["case_id"] for case in cases]
    assert len(case_ids) == len(set(case_ids))


def test_every_case_has_complete_fields():
    """每条 case 字段完整且类型正确，required_filters 与 project/episode 一致。

    :return: 无返回值。
    :raises AssertionError: 字段缺失或 required_filters 不一致时抛出。
    """
    for case in evaluation_cases():
        assert case["case_id"]
        assert case["type"] in CASE_TYPES
        assert isinstance(case["project_id"], int) and case["project_id"] > 0
        assert case["episode_id"] is None or (isinstance(case["episode_id"], int) and case["episode_id"] > 0)
        assert case["query"].strip()
        assert isinstance(case["expect_hit_asset_ids"], list)
        assert isinstance(case["forbid_asset_ids"], list)
        assert case["required_filters"] == {"project_id": case["project_id"], "episode_id": case["episode_id"]}


def test_expected_and_forbidden_assets_exist_in_seed_documents():
    """expect/forbid 引用的资产必须存在于种子文档；expect 资产归属 case 项目。

    :return: 无返回值。
    :raises AssertionError: 引用缺失或项目归属不符时抛出。
    """
    documents = _seed_documents()
    assets = {doc["metadata"]["asset_id"]: doc["metadata"] for doc in documents}

    for case in evaluation_cases():
        for asset_id in case["expect_hit_asset_ids"]:
            assert asset_id in assets, f"{case['case_id']} 期望资产 {asset_id} 不在种子文档"
            assert assets[asset_id]["project_id"] == case["project_id"], (
                f"{case['case_id']} 期望资产 {asset_id} 项目归属与 case 不一致"
            )
        for asset_id in case["forbid_asset_ids"]:
            assert asset_id in assets, f"{case['case_id']} 禁止资产 {asset_id} 不在种子文档"


def test_empty_cases_expect_no_hits_and_no_forbidden():
    """empty 场景样本的期望与禁止列表均为空（纯无关查询）。

    :return: 无返回值。
    :raises AssertionError: empty 样本引用了资产时抛出。
    """
    for case in evaluation_cases():
        if case["type"] == "empty":
            assert case["expect_hit_asset_ids"] == []
            assert case["forbid_asset_ids"] == []


def test_seed_documents_pass_normalization():
    """种子文档可直接通过 normalize_documents 校验（metadata 字段完整合法）。

    :return: 无返回值。
    :raises ValueError: metadata 缺失必填字段或类型非法时抛出。
    """
    normalized = normalize_documents(_seed_documents())

    assert len(normalized) >= 11
    for document in normalized:
        assert document["text"].strip()
        assert document["metadata"]["project_id"] in (21, 22)


def test_hard_negative_and_stale_cases_reference_same_name_variants():
    """同名角色与版本对样本确实构成冲突对（hard_negative 引他项目同名、stale 引旧版本）。

    :return: 无返回值。
    :raises AssertionError: 冲突设计不成立时抛出。
    """
    cases = {case["case_id"]: case for case in evaluation_cases()}

    hard = cases["hard-01"]
    assert "p22-char-linwanxia" in hard["forbid_asset_ids"]
    assert hard["expect_hit_asset_ids"] == ["p21-char-linwanxia-v2"]

    stale = cases["stale-01"]
    assert "p21-char-linwanxia-v1" in stale["forbid_asset_ids"]
    assert stale["expect_hit_asset_ids"] == ["p21-char-linwanxia-v2"]
