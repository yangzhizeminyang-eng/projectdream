"""Agent Eval 固定数据集注册表：八类样本 × 正反例，离线、确定性、可版本化。

数据集纪律：
- 所有样本输入为**固定字面量**（不依赖网络、数据库、模型或随机源），同名版本下
  判定结果永远一致，可安全提交进版本库做回归门禁基线；
- 每条样本必须声明：输入（input）、上下文快照（context）、预期约束（expectations，
  其中 ``expected_verdict`` 为 runner 判定校验器行为是否符合预期的依据）、
  校验器名（verifier，必须已在 :data:`app.agent.eval.validators.VERIFIERS` 注册）、
  来源（source）与允许误差（allowable_error）；
- 不可机器判定的语义样本必须 ``pending_review=True`` 且 ``source=HUMAN_REVIEW``，
  runner 会把它们单独归入 pending_review 列表，**不混入通过率分母**；
- 样本发生任何增删改时必须递增 :data:`EVAL_DATASET_VERSION`，并同步更新
  ``artifacts/agent-eval-report.json`` 基线。

case_id 前缀约定（与 eval_type 一一对应，便于人工审阅与过滤）::

    sb-dur-*       分镜时长（storyboard_duration）
    asset-ref-*    @资产引用（asset_mention）
    char-cons-*    角色一致性（character_consistency）
    prompt-cls-*   Prompt 分类（prompt_classification）
    action-snd-*   动作与声音（action_sound_cues）
    fail-rec-*     故障恢复（failure_recovery）
    rag-*          RAG 检索（rag_cases）
    api-compat-*   API 兼容（api_compatibility）
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

#: 数据集版本号：样本增删改时递增（报告据此区分基线代际）。
EVAL_DATASET_VERSION = "v1"


class EvalType(str, Enum):
    """Agent Eval 样本的八大类型（顺序即报告 by_type 的输出顺序）。

    :cvar STORYBOARD_DURATION: 分镜时长连续性与总时长容差。
    :cvar ASSET_MENTION: @资产引用的存在性/归属/状态/能力一致性。
    :cvar CHARACTER_CONSISTENCY: 角色设定与约束文本的矛盾检测。
    :cvar PROMPT_CLASSIFICATION: 四类 Prompt 的职责边界与排版。
    :cvar ACTION_SOUND_CUES: 可观察动作五要素与声音 cue 结构。
    :cvar FAILURE_RECOVERY: 故障恢复场景名与期望结果合法性。
    :cvar RAG_CASES: 检索 Eval 报告指标齐全性与泄漏上限。
    :cvar API_COMPATIBILITY: API envelope 形态与错误码约定。
    """

    STORYBOARD_DURATION = "storyboard_duration"
    ASSET_MENTION = "asset_mention"
    CHARACTER_CONSISTENCY = "character_consistency"
    PROMPT_CLASSIFICATION = "prompt_classification"
    ACTION_SOUND_CUES = "action_sound_cues"
    FAILURE_RECOVERY = "failure_recovery"
    RAG_CASES = "rag_cases"
    API_COMPATIBILITY = "api_compatibility"


class EvalSource(str, Enum):
    """样本判定的信息来源（决定报告 sources 分组与人工介入程度）。

    :cvar RULE_CHECK: 纯规则/结构检查，机器可完全判定。
    :cvar LLM_JUDGE: 需模型评判的样本（当前数据集暂无，占位语义）。
    :cvar VISION_AUDIO_CHECK: 需视觉/音频模型检查的样本（占位语义）。
    :cvar HUMAN_REVIEW: 需人工复核的语义判定样本（pending_review）。
    """

    RULE_CHECK = "rule_check"
    LLM_JUDGE = "llm_judge"
    VISION_AUDIO_CHECK = "vision_audio_check"
    HUMAN_REVIEW = "human_review"


class EvalCase(BaseModel):
    """单条 Eval 样本。

    :param case_id: 全局唯一样本 ID，前缀与 eval_type 对应（见模块 docstring）。
    :param eval_type: 八类之一。
    :param name: 人类可读的样本名称。
    :param input: 校验器输入（任意 JSON 结构，由 verifier 约定 schema）。
    :param context: 上下文快照（业务背景、关联模块、口径说明等）。
    :param expectations: 预期约束 dict，必须含 ``expected_verdict``（"pass"/"fail"），
        runner 据此判定"校验器行为是否符合样本预期"。
    :param verifier: 校验器名，必须存在于 VERIFIERS 注册表。
    :param source: 判定信息来源。
    :param allowable_error: 允许误差/人工抽检说明（不可机器判定项在此标注理由）。
    :param pending_review: True 表示该样本包含不可机器判定的语义检查，
        不混入 pass_rate 分母，单独进入报告 pending_review 列表。
    """

    model_config = ConfigDict(extra="forbid")

    case_id: str = Field(min_length=1, description="全局唯一样本 ID")
    eval_type: EvalType = Field(description="样本类型（八类之一）")
    name: str = Field(min_length=1, description="人类可读样本名称")
    input: Any = Field(description="校验器输入（verifier 约定 schema）")
    context: Any = Field(description="上下文快照")
    expectations: Any = Field(description="预期约束（含 expected_verdict）")
    verifier: str = Field(min_length=1, description="校验器名（须在 VERIFIERS 注册）")
    source: EvalSource = Field(description="判定信息来源")
    allowable_error: Any = Field(default=None, description="允许误差/人工抽检说明")
    pending_review: bool = Field(default=False, description="是否为待人工复核样本")


def _case(
    *,
    case_id: str,
    eval_type: EvalType,
    name: str,
    verifier: str,
    payload: Any,
    context: Any,
    expectations: dict[str, Any],
    source: EvalSource = EvalSource.RULE_CHECK,
    allowable_error: Any = None,
    pending_review: bool = False,
) -> EvalCase:
    """构造字段完整的 Eval 样本（集中补默认值，保证每条样本字段齐全）。

    :param case_id: 全局唯一样本 ID。
    :param eval_type: 样本类型。
    :param name: 样本名称。
    :param verifier: 校验器名。
    :param payload: 校验器输入。
    :param context: 上下文快照。
    :param expectations: 预期约束 dict（必须含 expected_verdict）。
    :param source: 判定来源（默认 rule_check）。
    :param allowable_error: 允许误差说明。
    :param pending_review: 是否待人工复核。
    :return: :class:`EvalCase` 实例。
    :raises pydantic.ValidationError: 字段违反模型约束时由 pydantic 抛出。
    """
    return EvalCase(
        case_id=case_id,
        eval_type=eval_type,
        name=name,
        verifier=verifier,
        input=payload,
        context=context,
        expectations=expectations,
        source=source,
        allowable_error=allowable_error,
        pending_review=pending_review,
    )


# ---------------------------------------------------------------------------
# 共享资产目录（asset_mention 类样本的固定 catalog 快照）。
# 约定：p{project_id}-{asset_type}-{slug}；name 用于 @引用一致性检查。
# ---------------------------------------------------------------------------
_ASSET_CATALOG: tuple[dict[str, Any], ...] = (
    {"asset_id": "p8-char-linwan", "project_id": 8, "status": "confirmed", "asset_type": "character", "capabilities": ["image", "voice"], "name": "林晚"},
    {"asset_id": "p8-scene-rooftop", "project_id": 8, "status": "confirmed", "asset_type": "scene", "capabilities": ["image"], "name": "黄昏天台"},
    {"asset_id": "p8-prop-pocket-watch", "project_id": 8, "status": "ready", "asset_type": "prop", "capabilities": ["image"], "name": "生锈怀表"},
    {"asset_id": "p9-char-shadow", "project_id": 9, "status": "confirmed", "asset_type": "character", "capabilities": ["image", "voice"], "name": "影子客串"},
    {"asset_id": "p8-char-draft-hero", "project_id": 8, "status": "draft", "asset_type": "character", "capabilities": ["image"], "name": "未确认主角"},
    {"asset_id": "p8-video-novoice", "project_id": 8, "status": "confirmed", "asset_type": "video", "capabilities": ["voice"], "name": "无声样片"},
)


def _build_cases() -> tuple[EvalCase, ...]:
    """构造全部八类样本（每类 ≥3，正反例兼备）。

    :return: 32 条固定样本的元组。
    """
    cases: list[EvalCase] = []

    # ------------------------------------------------------------------
    # 一、分镜时长（sb-dur-*，5 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="sb-dur-01",
        eval_type=EvalType.STORYBOARD_DURATION,
        name="合法连续覆盖（正例）",
        verifier="verify_storyboard_duration",
        payload={
            "shots": [
                {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
                {"index": 2, "start_seconds": 2.0, "end_seconds": 5.0},
                {"index": 3, "start_seconds": 5.0, "end_seconds": 8.0},
            ],
            "target_total_seconds": 8.0,
            "tolerance_seconds": 0.5,
        },
        context={"background": "项目 8 第一集开场三镜头，从 0 秒连续铺满到 8 秒", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "镜头连续无缺口/重叠，总时长恰为目标值"},
        allowable_error=0.01,
    ))
    cases.append(_case(
        case_id="sb-dur-02",
        eval_type=EvalType.STORYBOARD_DURATION,
        name="负时长（反例）",
        verifier="verify_storyboard_duration",
        payload={
            "shots": [
                {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
                {"index": 2, "start_seconds": 2.0, "end_seconds": 1.0},
                {"index": 3, "start_seconds": 2.0, "end_seconds": 8.0},
            ],
            "target_total_seconds": 8.0,
            "tolerance_seconds": 0.5,
        },
        context={"background": "第二镜头被模型写出 end<start 的退化区间", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "主断言为负时长；第二/三镜头之间的连续性连带失败属预期"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="sb-dur-03",
        eval_type=EvalType.STORYBOARD_DURATION,
        name="中段缺口（反例）",
        verifier="verify_storyboard_duration",
        payload={
            "shots": [
                {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
                {"index": 2, "start_seconds": 2.5, "end_seconds": 5.0},
                {"index": 3, "start_seconds": 5.0, "end_seconds": 8.0},
            ],
            "target_total_seconds": 8.0,
            "tolerance_seconds": 0.5,
        },
        context={"background": "第二镜头起点被推迟 0.5 秒，造成时间轴缺口", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "相邻镜头 start 偏差 0.5s，远超 0.01s 容忍"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="sb-dur-04",
        eval_type=EvalType.STORYBOARD_DURATION,
        name="首镜头 0 秒时长（反例）",
        verifier="verify_storyboard_duration",
        payload={
            "shots": [
                {"index": 1, "start_seconds": 0.0, "end_seconds": 0.0},
                {"index": 2, "start_seconds": 0.0, "end_seconds": 2.0},
                {"index": 3, "start_seconds": 2.0, "end_seconds": 5.0},
            ],
            "target_total_seconds": 5.0,
            "tolerance_seconds": 0.5,
        },
        context={"background": "首镜头被意外写成 start==end 的 0 秒占位镜头", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "首镜头不得意外为 0 秒时长（end-start==0 判 fail）"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="sb-dur-05",
        eval_type=EvalType.STORYBOARD_DURATION,
        name="总时长超容差（反例）",
        verifier="verify_storyboard_duration",
        payload={
            "shots": [
                {"index": 1, "start_seconds": 0.0, "end_seconds": 2.0},
                {"index": 2, "start_seconds": 2.0, "end_seconds": 5.0},
                {"index": 3, "start_seconds": 5.0, "end_seconds": 9.0},
            ],
            "target_total_seconds": 8.0,
            "tolerance_seconds": 0.5,
        },
        context={"background": "第三镜头被拉长 1 秒，总时长偏离目标且超出容差", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "总时长偏差 1.0s > 容差 0.5s"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 二、@资产引用（asset-ref-*，4 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="asset-ref-01",
        eval_type=EvalType.ASSET_MENTION,
        name="全部确认资产引用（正例）",
        verifier="verify_asset_mentions",
        payload={
            "mentions": [
                {"asset_id": "p8-char-linwan", "text": "@林晚 抬手示意队友跟上", "purpose": "video"},
                {"asset_id": "p8-scene-rooftop", "text": "场景锁定 @黄昏天台，夕阳主光源", "purpose": "video"},
                {"asset_id": "p8-prop-pocket-watch", "text": "特写 @生锈怀表 的表盘", "purpose": "video"},
            ],
            "asset_catalog": list(_ASSET_CATALOG),
            "current_project_id": 8,
        },
        context={"background": "项目 8 分镜生成的三处 @引用，目录为固定快照", "related_modules": ["app.agent.pipeline.idempotency"]},
        expectations={"expected_verdict": "pass", "notes": "全部同项目 confirmed/ready，purpose=video 均具备 image 能力，@名称与目录一致"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="asset-ref-02",
        eval_type=EvalType.ASSET_MENTION,
        name="跨项目引用（反例）",
        verifier="verify_asset_mentions",
        payload={
            "mentions": [
                {"asset_id": "p9-char-shadow", "text": "@影子客串 从巷口走出", "purpose": "video"},
            ],
            "asset_catalog": list(_ASSET_CATALOG),
            "current_project_id": 8,
        },
        context={"background": "项目 9 的客串角色被误引入项目 8 的分镜", "related_modules": ["app.agent.pipeline.idempotency"]},
        expectations={"expected_verdict": "fail", "notes": "资产属于项目 9，与当前项目 8 不一致"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="asset-ref-03",
        eval_type=EvalType.ASSET_MENTION,
        name="draft 状态被当已确认（反例）",
        verifier="verify_asset_mentions",
        payload={
            "mentions": [
                {"asset_id": "p8-char-draft-hero", "text": "@未确认主角 挥拳反击", "purpose": "video"},
            ],
            "asset_catalog": list(_ASSET_CATALOG),
            "current_project_id": 8,
        },
        context={"background": "草稿角色尚未走完确认流程即被引用", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "仅 confirmed/ready 可作为已确认资产，draft 不可"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="asset-ref-04",
        eval_type=EvalType.ASSET_MENTION,
        name="类型能力不匹配（反例）",
        verifier="verify_asset_mentions",
        payload={
            "mentions": [
                {"asset_id": "p8-video-novoice", "text": "以 @无声样片 作为视频生成底片", "purpose": "video"},
            ],
            "asset_catalog": list(_ASSET_CATALOG),
            "current_project_id": 8,
        },
        context={"background": "video 生成引用的资产必须具备 image 能力，该资产仅有 voice 能力", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "purpose=video 要求 capabilities 含 image，实际缺失"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 三、角色一致性（char-cons-*，5 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="char-cons-01",
        eval_type=EvalType.CHARACTER_CONSISTENCY,
        name="设定与约束一致（正例）",
        verifier="verify_character_consistency",
        payload={
            "character": {
                "gender": "female",
                "age_range": "youth",
                "appearance": "蓝色双马尾少女，星形发饰，水手校服",
                "clothing": "水手校服",
                "identity": "学生",
                "voice_binding": "voice-soft-girl",
            },
            "constraints": [
                {"category": "action", "text": "她跑向天台，转身望向云海"},
            ],
        },
        context={"background": "项目 8 主角设定卡与其分镜动作约束", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "性别/年龄词与 appearance 同向，学生配校服无冲突，音色已绑定"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="char-cons-02",
        eval_type=EvalType.CHARACTER_CONSISTENCY,
        name="性别矛盾（反例）",
        verifier="verify_character_consistency",
        payload={
            "character": {
                "gender": "female",
                "age_range": "youth",
                "appearance": "短发男性侦探，身材高大，风衣",
                "clothing": "风衣",
                "identity": "侦探",
                "voice_binding": None,
            },
            "constraints": [
                {"category": "action", "text": "他蹲下检查脚印"},
            ],
        },
        context={"background": "设定卡写 female，但 appearance 与动作文本均为男性描述", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "矛盾词表（男/他 vs 女/她）触发"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="char-cons-03",
        eval_type=EvalType.CHARACTER_CONSISTENCY,
        name="年龄矛盾（反例）",
        verifier="verify_character_consistency",
        payload={
            "character": {
                "gender": "male",
                "age_range": "youth",
                "appearance": "少年感短发，校服打扮",
                "clothing": "校服",
                "identity": "学生",
                "voice_binding": None,
            },
            "constraints": [
                {"category": "action", "text": "中年侦探掏出证件盘问路人"},
            ],
        },
        context={"background": "age_range 标注 youth，动作约束却按中年侦探展开剧情", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "少年（youth 组）与中年（middle 组）词表冲突"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="char-cons-04",
        eval_type=EvalType.CHARACTER_CONSISTENCY,
        name="有对白需求但未绑定音色（反例）",
        verifier="verify_character_consistency",
        payload={
            "character": {
                "gender": "female",
                "age_range": "youth",
                "appearance": "蓝色双马尾少女",
                "clothing": "水手校服",
                "identity": "学生",
                "voice_binding": None,
            },
            "constraints": [
                {"category": "dialogue", "text": "她说：我们真的要在这里等到天亮吗"},
            ],
        },
        context={"background": "分镜包含台词但角色卡未绑定任何音色", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "存在 dialogue 类约束且 voice_binding 缺失"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="char-cons-05",
        eval_type=EvalType.CHARACTER_CONSISTENCY,
        name="asset_reference 约束不参与动作矛盾检查（正例）",
        verifier="verify_character_consistency",
        payload={
            "character": {
                "gender": "female",
                "age_range": "youth",
                "appearance": "蓝色双马尾少女，水手校服",
                "clothing": "水手校服",
                "identity": "学生",
                "voice_binding": "voice-soft-girl",
            },
            "constraints": [
                {"category": "asset_reference", "text": "参考图：中年男性侦探路人（仅作背景资产参考，不代表主角形象）"},
            ],
        },
        context={"background": "约束文本描述的是背景参考资产而非主角，若误入动作矛盾检查会误伤", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "asset_reference 类约束不参与性别/年龄矛盾检查"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 四、Prompt 分类（prompt-cls-*，4 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="prompt-cls-01",
        eval_type=EvalType.PROMPT_CLASSIFICATION,
        name="四类 Prompt 各就各位（正例）",
        verifier="verify_prompt_classification",
        payload={
            "prompts": [
                {"kind": "prop_asset", "text": "道具：生锈怀表静置于课桌，表面有划痕与红丝带", "mentions": ["p8-prop-pocket-watch"]},
                {"kind": "scene_asset", "text": "场景：黄昏天台全景，围栏前景，云海与浮空岛远景", "mentions": ["p8-scene-rooftop"]},
                {"kind": "storyboard_shot", "text": "分镜：@林晚 站在天台边缘眺望云海，风拂动发丝", "mentions": ["p8-char-linwan"]},
                {"kind": "video_action", "text": "林晚缓缓转身走向门口，镜头自下而上缓推", "mentions": []},
            ],
        },
        context={"background": "同一分镜的四类下游 Prompt，各自职责边界清晰", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "scene 无表演动词、video_action 无静态描述、storyboard 保留 mentions、排版干净"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="prompt-cls-02",
        eval_type=EvalType.PROMPT_CLASSIFICATION,
        name="场景图混入表演动词（反例）",
        verifier="verify_prompt_classification",
        payload={
            "prompts": [
                {"kind": "scene_asset", "text": "场景：空教室里主角说话并奔跑，课桌翻倒", "mentions": ["p8-scene-classroom"]},
            ],
        },
        context={"background": "场景资产 Prompt 应只描述环境，混入人物表演会导致场景图生成人物", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "命中表演动词词表（说话/奔跑）"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="prompt-cls-03",
        eval_type=EvalType.PROMPT_CLASSIFICATION,
        name="storyboard_shot 丢失 mentions（反例）",
        verifier="verify_prompt_classification",
        payload={
            "prompts": [
                {"kind": "storyboard_shot", "text": "分镜：角色站在天台边缘远眺", "mentions": []},
            ],
        },
        context={"background": "分镜 Prompt 丢失 @引用会导致执行阶段无法定位角色资产", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "storyboard_shot 必须保留非空 mentions"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="prompt-cls-04",
        eval_type=EvalType.PROMPT_CLASSIFICATION,
        name="video_action 混入道具静态描述（反例）",
        verifier="verify_prompt_classification",
        payload={
            "prompts": [
                {"kind": "video_action", "text": "道具特写，静止的怀表躺在桌面，红丝带垂落", "mentions": []},
            ],
        },
        context={"background": "视频动作 Prompt 混入 prop_asset 的静态描述模式会让视频模型失去动作目标", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "命中静态描述模式词表（道具特写/静止）"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 五、动作与声音（action-snd-*，4 条；第 4 条为人工复核样本）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="action-snd-01",
        eval_type=EvalType.ACTION_SOUND_CUES,
        name="结构完整五要素齐全（正例）",
        verifier="verify_action_sound_cues",
        payload={
            "shot_start_seconds": 0.0,
            "shot_end_seconds": 5.0,
            "cues": [
                {"kind": "environment", "start_seconds": 0.0, "end_seconds": 2.0, "subject": "晚风", "goal": "吹动天台风铃", "start_state": "风铃静止", "end_state": "风铃轻响"},
                {"kind": "dialogue", "start_seconds": 2.0, "end_seconds": 4.5, "subject": "林晚", "goal": "向队友表达疑惑", "start_state": "沉默注视", "end_state": "说出台词：我们真的要等吗"},
                {"kind": "music", "start_seconds": 0.0, "end_seconds": 5.0, "subject": "背景配乐", "goal": "铺垫悬念情绪", "start_state": "无声", "end_state": "弦乐渐强"},
            ],
        },
        context={"background": "5 秒开场镜头的三条声音 cue，五要素与区间全部合规", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "三类声音 kind 合法、区间落在镜头内、五要素齐全"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="action-snd-02",
        eval_type=EvalType.ACTION_SOUND_CUES,
        name="缺少 end_state（反例）",
        verifier="verify_action_sound_cues",
        payload={
            "shot_start_seconds": 0.0,
            "shot_end_seconds": 5.0,
            "cues": [
                {"kind": "environment", "start_seconds": 0.0, "end_seconds": 2.0, "subject": "晚风", "goal": "吹动天台风铃", "start_state": "风铃静止"},
                {"kind": "dialogue", "start_seconds": 2.0, "end_seconds": 4.0, "subject": "林晚", "goal": "表达疑惑", "start_state": "沉默注视", "end_state": "说出台词"},
            ],
        },
        context={"background": "第一条 cue 缺少 end_state，无法验证动作从何到何", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "可观察动作五要素（subject/goal/start_state/end_state/区间）缺失"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="action-snd-03",
        eval_type=EvalType.ACTION_SOUND_CUES,
        name="cue 越镜头区间（反例）",
        verifier="verify_action_sound_cues",
        payload={
            "shot_start_seconds": 0.0,
            "shot_end_seconds": 5.0,
            "cues": [
                {"kind": "dialogue", "start_seconds": 4.0, "end_seconds": 6.5, "subject": "林晚", "goal": "喊出警告", "start_state": "望向巷口", "end_state": "大声示警"},
            ],
        },
        context={"background": "台词 cue 拖到 6.5 秒，超出 5 秒的镜头边界", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "cue 区间必须完全落在镜头区间内且 end>start"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="action-snd-04",
        eval_type=EvalType.ACTION_SOUND_CUES,
        name="语义判定待人工复核（pending 样本）",
        verifier="verify_action_sound_cues",
        payload={
            "shot_start_seconds": 0.0,
            "shot_end_seconds": 4.0,
            "cues": [
                {"kind": "dialogue", "start_seconds": 0.5, "end_seconds": 3.5, "subject": "林晚", "goal": "表达不安", "start_state": "低头握紧衣角", "end_state": "抬头说出疑问"},
            ],
        },
        context={"background": "结构上五要素齐全，但『动作是否真的发生、音轨是否真的可听』无法用文本规则证明", "related_modules": ["app.agent.quality.rules"]},
        expectations={"expected_verdict": "pass", "notes": "结构检查应通过；语义判定交人工，details 标注 semantic_check=pending_human_review"},
        source=EvalSource.HUMAN_REVIEW,
        allowable_error="动作真实性与音轨可听性需人工抽检",
        pending_review=True,
    ))

    # ------------------------------------------------------------------
    # 六、故障恢复（fail-rec-*，3 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="fail-rec-01",
        eval_type=EvalType.FAILURE_RECOVERY,
        name="已知场景与合法期望结果（正例）",
        verifier="verify_failure_recovery",
        payload={
            "scenarios": [
                {"scenario": "node_pre_failure", "expected_outcome": "retryable_failed"},
                {"scenario": "execution_interrupted", "expected_outcome": "retryable_failed"},
                {"scenario": "provider_created_not_saved", "expected_outcome": "no_duplicate_submission"},
            ],
        },
        context={"background": "阶段 2/4 恢复语义：节点前置失败与执行中断落 retryable_failed；供应商已建任务未落库时靠幂等键防二次提交", "related_modules": ["app.agent.pipeline.paid_submission", "app.agent.pipeline.recovery"]},
        expectations={"expected_verdict": "pass", "notes": "场景名全部在 KNOWN_RECOVERY_SCENARIOS，期望结果合法"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="fail-rec-02",
        eval_type=EvalType.FAILURE_RECOVERY,
        name="未知场景名（反例）",
        verifier="verify_failure_recovery",
        payload={
            "scenarios": [
                {"scenario": "zombie_worker_hang", "expected_outcome": "retryable_failed"},
            ],
        },
        context={"background": "场景名拼写漂移（不在阶段 2 六类场景常量内）应被门禁拒绝", "related_modules": ["app.agent.pipeline.recovery"]},
        expectations={"expected_verdict": "fail", "notes": "未知场景名必须 fail"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="fail-rec-03",
        eval_type=EvalType.FAILURE_RECOVERY,
        name="非法 expected_outcome（反例）",
        verifier="verify_failure_recovery",
        payload={
            "scenarios": [
                {"scenario": "duplicate_callback", "expected_outcome": "success"},
                {"scenario": "worker_restart", "expected_outcome": "completed"},
            ],
        },
        context={"background": "duplicate_callback 的期望结果被写成自由文本 success，超出六态与 no_duplicate_submission 词表", "related_modules": ["app.agent.pipeline.paid_submission"]},
        expectations={"expected_verdict": "fail", "notes": "expected_outcome 只允许六态或 no_duplicate_submission"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 七、RAG 检索（rag-*，3 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="rag-01",
        eval_type=EvalType.RAG_CASES,
        name="阶段 4 报告指标齐全（正例）",
        verifier="verify_rag_cases",
        payload={"rag_report_path": "artifacts/phase4-retrieval-eval.json"},
        context={
            "background": "阶段 4 已产出的离线检索 Eval 报告（离线近似检索口径）",
            "summary_source": "cleaned_snapshot.summary",
            "phase4_cleaned_summary": {"recall_at_k": 0.75, "mrr": 0.7083333333333334, "leak_count": 1, "empty_rate": 0.2857142857142857, "latency_p50_ms": 0.067, "latency_p95_ms": 0.3},
        },
        expectations={"expected_verdict": "pass", "notes": "六指标齐全且 leak_count=1 未超设计内暴露上限（amb 类样本数）"},
        allowable_error=1,
    ))
    cases.append(_case(
        case_id="rag-02",
        eval_type=EvalType.RAG_CASES,
        name="泄漏超设计内上限（反例）",
        verifier="verify_rag_cases",
        payload={
            "rag_summary": {
                "recall_at_k": 0.75,
                "mrr": 0.7083,
                "leak_count": 99,
                "empty_rate": 0.2857,
                "latency_p50_ms": 0.067,
                "latency_p95_ms": 0.3,
            },
        },
        context={"background": "模拟版本清理/过滤失效后的口径：泄漏计数飙升至 99", "related_modules": ["rag-service/app/retrieval_eval.py"]},
        expectations={"expected_verdict": "fail", "notes": "leak_count=99 远超上限 1"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="rag-03",
        eval_type=EvalType.RAG_CASES,
        name="报告文件缺失（反例）",
        verifier="verify_rag_cases",
        payload={"rag_report_path": "artifacts/__missing__/phase4-retrieval-eval-not-exist.json"},
        context={"background": "报告尚未生成或被误删，校验器必须给出修复指引", "related_modules": ["rag-service/app/eval_dataset.py"]},
        expectations={"expected_verdict": "fail", "notes": "文件不存在 → failed，failures 中给出修复指引"},
        allowable_error=None,
    ))

    # ------------------------------------------------------------------
    # 八、API 兼容（api-compat-*，4 条；source=rule_check）
    # ------------------------------------------------------------------
    cases.append(_case(
        case_id="api-compat-01",
        eval_type=EvalType.API_COMPATIBILITY,
        name="合法 envelope 与错误码约定（正例）",
        verifier="verify_api_compatibility",
        payload={
            "samples": [
                {"path": "/api/projects", "method": "GET", "expected_status": 200, "expected_envelope": {"code": 0, "message": "success", "data": {"items": []}}},
                {"path": "/api/videos/12/submit", "method": "POST", "expected_status": 401, "expected_envelope": {"code": 401, "message": "未登录", "data": None}},
                {"path": "/api/videos/12/submit", "method": "POST", "expected_status": 401, "expected_envelope": {"code": 4010, "message": "token 失效", "data": None}},
                {"path": "/api/projects/999", "method": "GET", "expected_status": 404, "expected_envelope": {"code": 404, "message": "项目不存在", "data": None}},
            ],
        },
        context={"background": "{code,message,data} envelope 契约（app/envelope.py）；401↔4010 特例允许", "related_modules": ["app.envelope"]},
        expectations={"expected_verdict": "pass", "notes": "三键齐全、code 为 int、错误码与状态匹配（含 401/4010 特例）"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="api-compat-02",
        eval_type=EvalType.API_COMPATIBILITY,
        name="envelope 缺 data 键（反例）",
        verifier="verify_api_compatibility",
        payload={
            "samples": [
                {"path": "/api/projects", "method": "GET", "expected_status": 200, "expected_envelope": {"code": 0, "message": "success"}},
            ],
        },
        context={"background": "响应缺 data 键会破坏前端解构与统一拦截器", "related_modules": ["app.envelope"]},
        expectations={"expected_verdict": "fail", "notes": "envelope 必须 code/message/data 三键齐全"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="api-compat-03",
        eval_type=EvalType.API_COMPATIBILITY,
        name="401 与 code 不匹配（反例）",
        verifier="verify_api_compatibility",
        payload={
            "samples": [
                {"path": "/api/admin/settings", "method": "GET", "expected_status": 401, "expected_envelope": {"code": 403, "message": "无权限", "data": None}},
            ],
        },
        context={"background": "HTTP 401（未登录）只允许 code 401 或 4010（token 失效特例），403 属权限不足语义", "related_modules": ["app.envelope"]},
        expectations={"expected_verdict": "fail", "notes": "401 允许 {401,4010}，code=403 不匹配"},
        allowable_error=None,
    ))
    cases.append(_case(
        case_id="api-compat-04",
        eval_type=EvalType.API_COMPATIBILITY,
        name="media URL 协议非法（反例）",
        verifier="verify_api_compatibility",
        payload={
            "samples": [
                {"path": "/api/videos/12", "method": "GET", "expected_status": 200, "expected_envelope": {"code": 0, "message": "success", "data": {"video_url": "ftp://media.example.com/v12.mp4"}}},
            ],
        },
        context={"background": "媒体地址必须是 http(s) 公网地址或相对路径，ftp 等协议前端无法播放", "related_modules": ["app.envelope", "app.agent.quality.rules"]},
        expectations={"expected_verdict": "fail", "notes": "media URL 必须以 http://、https:// 或相对 / 开头"},
        allowable_error=None,
    ))

    return tuple(cases)


#: 全量固定样本（八类 × ≥3，正反例兼备；样本增删改必须递增 EVAL_DATASET_VERSION）。
AGENT_EVAL_CASES: tuple[EvalCase, ...] = _build_cases()


def get_cases_by_type(eval_type: "EvalType | str") -> list[EvalCase]:
    """按类型过滤数据集样本。

    :param eval_type: EvalType 枚举或其字符串值（如 ``"storyboard_duration"``）。
    :returns: 该类型的样本列表（保持注册顺序）；类型未知时返回空列表。
    :raises TypeError: eval_type 既非 EvalType 也非字符串时抛出。
    """
    if isinstance(eval_type, EvalType):
        key = eval_type.value
    elif isinstance(eval_type, str):
        key = eval_type
    else:
        raise TypeError("eval_type 必须是 EvalType 或其字符串值")
    return [case for case in AGENT_EVAL_CASES if case.eval_type.value == key]
