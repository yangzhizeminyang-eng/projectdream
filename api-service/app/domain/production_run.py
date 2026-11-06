"""Production Run 输入、单集蓝图和阶段种子领域规则。"""

from __future__ import annotations

from typing import Any

PRODUCTION_RUN_STAGES = (
    ("market-validation", "市场题材与用户验证", "market-research", "market-validation"),
    ("episode-blueprint", "单集高转化蓝图", "blueprint-writer", "blueprint"),
    ("emotion-design", "情绪段落设计", "emotion-storyboard", None),
    ("candidate-generation", "多候选生成", "generation-orchestrator", None),
    ("candidate-selection", "人工与 Agent 筛选", "candidate-review", "candidate-selection"),
    ("continuous-edit", "连续声音与时间线剪辑", "audio-edit", None),
    ("pilot-release", "小样本发布", "release-package", "pilot-release"),
    ("data-review", "平台数据复盘", "retrospective", None),
    ("scale-decision", "扩大生产决策", "scale-decision", None),
)
CHECKPOINT_KEYS = tuple(stage[3] for stage in PRODUCTION_RUN_STAGES if stage[3])
BEAT_FIELDS = (
    "emotionStart", "emotionProcess", "emotionEnd", "actionStart", "actionProcess",
    "actionEnd", "dialoguePlan", "soundPlan", "continuity",
)


def _text(value: Any, fallback: str = "") -> str:
    return str(value if value is not None else "").strip() or fallback


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 and str(value).strip() not in ("",) else fallback
    except (TypeError, ValueError):
        return fallback


def _clamp_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, _positive_int(value, fallback)))


def normalize_candidate_policy(value: Any = None) -> dict[str, Any]:
    value = value if isinstance(value, dict) else {}
    try:
        multiplier = float(value.get("maxCandidateCostMultiplier", 3))
        if not multiplier == multiplier or multiplier in (float("inf"), float("-inf")):
            multiplier = 3
    except (TypeError, ValueError):
        multiplier = 3
    return {
        "keyShotVideoCandidates": _clamp_int(value.get("keyShotVideoCandidates"), 3, 1, 3),
        "normalShotVideoCandidates": _clamp_int(value.get("normalShotVideoCandidates"), 2, 1, 3),
        "imageCandidates": _clamp_int(value.get("imageCandidates"), 3, 1, 3),
        "audioCandidates": _clamp_int(value.get("audioCandidates"), 2, 1, 3),
        "maxCandidateCostMultiplier": max(1, min(5, multiplier)),
    }


def normalize_production_run_input(value: dict[str, Any]) -> dict[str, Any]:
    project_id = _positive_int(value.get("projectId"), 0)
    if not project_id:
        raise ValueError("ProductionRun 缺少有效 projectId")
    platform = _text(value.get("platform"), "抖音")
    if platform != "抖音":
        raise ValueError("第一阶段只允许使用抖音，先收敛平台变量")
    budget = value.get("budget")
    try:
        budget = float(budget) if budget is not None and budget != "" else None
        if budget is not None and (budget < 0 or budget != budget or abs(budget) == float("inf")):
            budget = None
    except (TypeError, ValueError):
        budget = None
    metrics = value.get("successMetrics")
    metrics = [_text(item) for item in metrics if _text(item)][:8] if isinstance(metrics, list) else []
    return {
        "projectId": project_id,
        "platform": platform,
        "episodeNo": _positive_int(value.get("episodeNo"), 1),
        "budget": budget,
        "pilotSceneCount": _clamp_int(value.get("pilotSceneCount"), 2, 1, 2),
        "pilotMode": _text(value.get("pilotMode"), "two-scenes-golden-sample"),
        "candidatePolicy": normalize_candidate_policy(value.get("candidatePolicy")),
        "successMetrics": metrics or ["3秒留存", "完播率", "评论与关注意愿"],
    }


def build_production_run_seed(value: dict[str, Any], blueprint: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = normalize_production_run_input(value)
    stages = [
        {
            "stageKey": stage[0], "label": stage[1], "agentKey": stage[2], "sequenceNo": index + 1,
            "status": "waiting_approval" if index == 0 else "blocked",
            "inputSnapshot": ({"platform": normalized["platform"], "episodeNo": normalized["episodeNo"],
                               "successMetrics": normalized["successMetrics"]} if index == 0 else None),
            "outputSnapshot": None, "errorText": None,
        }
        for index, stage in enumerate(PRODUCTION_RUN_STAGES)
    ]
    checkpoints = [
        {"checkpointKey": key, "stageKey": next(stage[0] for stage in PRODUCTION_RUN_STAGES if stage[3] == key),
         "status": "pending" if index == 0 else "blocked", "decisionNote": None}
        for index, key in enumerate(CHECKPOINT_KEYS)
    ]
    return {
        "run": {
            **{key: normalized[key] for key in ("projectId", "platform", "episodeNo", "budget", "pilotSceneCount",
                                                "pilotMode", "candidatePolicy", "successMetrics")},
            "status": "waiting_approval", "currentStage": PRODUCTION_RUN_STAGES[0][0],
            "currentCheckpoint": CHECKPOINT_KEYS[0],
            "inputSnapshot": {key: normalized[key] for key in ("platform", "episodeNo", "budget", "pilotSceneCount",
                                                                 "pilotMode", "candidatePolicy", "successMetrics")},
            "outputSnapshot": {"blueprint": blueprint} if blueprint else None,
        },
        "stages": stages,
        "checkpoints": checkpoints,
    }


def build_production_checkpoint_transition(*, run: dict[str, Any], stages: list[dict[str, Any]],
                                          checkpoints: list[dict[str, Any]], checkpoint_key: str,
                                          decision: str, note: str = "") -> dict[str, Any]:
    if decision not in {"approve", "reject"}:
        raise ValueError("检查点决定无效")
    if checkpoint_key != run.get("currentCheckpoint"):
        raise ValueError("当前检查点不可审批，请先完成前置阶段")
    checkpoint = next((item for item in checkpoints if item.get("checkpointKey") == checkpoint_key), None)
    if not checkpoint or checkpoint.get("status") != "pending":
        raise ValueError("当前检查点不可审批，请先完成前置阶段")
    stage_index = next((i for i, item in enumerate(PRODUCTION_RUN_STAGES) if item[0] == run.get("currentStage")), -1)
    if stage_index < 0:
        raise ValueError("当前生产阶段无效")
    current = next((item for item in stages if item.get("stageKey") == run.get("currentStage")), None)
    if current is None:
        raise ValueError("生产阶段记录不存在")
    next_stage = PRODUCTION_RUN_STAGES[stage_index + 1] if stage_index + 1 < len(PRODUCTION_RUN_STAGES) else None
    checkpoint_update = {"checkpointKey": checkpoint_key,
                         "status": "approved" if decision == "approve" else "rejected",
                         "decisionNote": _text(note) or None}
    if decision == "reject":
        return {"expectedCurrentStage": run.get("currentStage"), "expectedCurrentCheckpoint": run.get("currentCheckpoint"),
                "checkpointUpdate": checkpoint_update,
                "stageUpdates": [],
                "runUpdate": {"status": "paused", "failureCode": "checkpoint-rejected",
                              "failureText": _text(note, "检查点被拒绝")}}
    if next_stage is None:
        return {"expectedCurrentStage": run.get("currentStage"), "expectedCurrentCheckpoint": run.get("currentCheckpoint"),
                "checkpointUpdate": checkpoint_update, "stageUpdates": [{"stageKey": current["stageKey"], "status": "completed"}],
                "runUpdate": {"status": "completed", "currentStage": current["stageKey"], "currentCheckpoint": None}}
    next_record = next((item for item in stages if item.get("stageKey") == next_stage[0]), None)
    if next_record is None:
        raise ValueError(f"生产阶段记录不存在：{next_stage[0]}")
    next_checkpoint = next((item for item in checkpoints if item.get("checkpointKey") == next_stage[3]), None) if next_stage[3] else None
    if next_stage[3] and next_checkpoint is None:
        raise ValueError(f"生产检查点记录不存在：{next_stage[3]}")
    return {
        "expectedCurrentStage": run.get("currentStage"), "expectedCurrentCheckpoint": run.get("currentCheckpoint"),
        "checkpointUpdate": checkpoint_update,
        "stageUpdates": [{"stageKey": current["stageKey"], "status": "completed"},
                         {"stageKey": next_stage[0], "status": "waiting_approval" if next_checkpoint else "ready"}],
        "nextCheckpoint": {"checkpointKey": next_checkpoint["checkpointKey"], "status": "pending"} if next_checkpoint else None,
        "runUpdate": {"status": "waiting_approval" if next_checkpoint else "running",
                      "currentStage": next_stage[0], "currentCheckpoint": next_checkpoint["checkpointKey"] if next_checkpoint else None,
                      "failureCode": None, "failureText": None},
    }


def build_production_stage_completion_transition(*, run: dict[str, Any], stages: list[dict[str, Any]],
                                                  checkpoints: list[dict[str, Any]], completed_stage_key: str,
                                                  output_snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    if not completed_stage_key or completed_stage_key != run.get("currentStage"):
        raise ValueError("只能完成当前阶段")
    if run.get("currentCheckpoint"):
        raise ValueError("当前阶段存在待审批检查点，不能直接完成")
    stage_index = next((i for i, item in enumerate(PRODUCTION_RUN_STAGES) if item[0] == completed_stage_key), -1)
    if stage_index < 0:
        raise ValueError(f"未知生产阶段：{completed_stage_key}")
    current = next((item for item in stages if item.get("stageKey") == completed_stage_key), None)
    if current is None:
        raise ValueError(f"生产阶段记录不存在：{completed_stage_key}")
    if current.get("status") not in {"ready", "running"}:
        raise ValueError(f"当前阶段状态不可完成：{current.get('status')}")
    updates = [{"stageKey": completed_stage_key, "status": "completed", "outputSnapshot": output_snapshot or {}}]
    if stage_index + 1 == len(PRODUCTION_RUN_STAGES):
        return {"expectedCurrentStage": run.get("currentStage"), "expectedCurrentCheckpoint": run.get("currentCheckpoint"),
                "runUpdate": {"status": "completed", "currentStage": completed_stage_key, "currentCheckpoint": None},
                "stageUpdates": updates, "checkpointUpdates": []}
    next_stage = PRODUCTION_RUN_STAGES[stage_index + 1]
    next_record = next((item for item in stages if item.get("stageKey") == next_stage[0]), None)
    if next_record is None:
        raise ValueError(f"生产阶段记录不存在：{next_stage[0]}")
    next_checkpoint = next((item for item in checkpoints if item.get("checkpointKey") == next_stage[3]), None) if next_stage[3] else None
    if next_stage[3] and not next_checkpoint:
        raise ValueError(f"生产检查点记录不存在：{next_stage[3]}")
    updates.append({"stageKey": next_stage[0], "status": "waiting_approval" if next_checkpoint else "ready", "outputSnapshot": None})
    return {"expectedCurrentStage": run.get("currentStage"), "expectedCurrentCheckpoint": run.get("currentCheckpoint"),
            "runUpdate": {"status": "waiting_approval" if next_checkpoint else "running",
                           "currentStage": next_stage[0], "currentCheckpoint": next_checkpoint.get("checkpointKey") if next_checkpoint else None},
            "stageUpdates": updates,
            "checkpointUpdates": ([{"checkpointKey": next_checkpoint["checkpointKey"], "status": "pending"}] if next_checkpoint else [])}


def _build_beats(episode: dict[str, Any]) -> list[dict[str, Any]]:
    hook = _text(episode.get("openingHook"), "异常事件在第一秒发生")
    conflict = _text(episode.get("coreConflict"), "阻力逼近，主角必须做出选择")
    reversal = _text(episode.get("reversal"), "线索指向与观众预期不同")
    choice = _text(episode.get("protagonistChoice"), "主角主动保存证据并质问阻拦者")
    ending = _text(episode.get("endingHook"), "新的证据或威胁在结尾出现")
    visual = (episode.get("visualSetPieces") or []) if isinstance(episode.get("visualSetPieces"), list) else []
    first = _text(visual[0] if visual else None, "关键道具或异常画面出现")
    second = _text(visual[1] if len(visual) > 1 else None, "空间深处出现新的视觉变化")
    rows = [
        ("hook", "异常钩子", "平静即将被打破", "异常信号突然进入日常空间，观众先看到结果再追问原因", "异常",
         "主角正在执行原本的检修或观察动作", f"她停下动作，视线被{first}吸引，身体出现可见的迟疑", "主角转身确认异常来源",
         f"开场短句或呼吸反应：{hook}", "持续空间底噪 + 继电器/广播启动声 + 极短的低频压迫，不使用无设计长静音",
         "必须保留主角手中道具、服装和站位，下一镜从确认异常的视线方向接入", 1, 2, 3),
        ("pressure", "迟疑与压力", "异常", "主角试图用理性解释，但外部阻力快速逼近", "迟疑转为恐惧", "主角靠近控制台或证据源",
         f"阻拦者进入空间，{conflict}；主角一边后退一边保护证据", "主角被迫在继续观察和立即逃离之间停顿",
         "对白必须拆成短句，保留阻拦者打断、主角吸气和半拍停顿", "脚步/金属触碰进入前景；环境底噪持续；对白出现时 BGM 自动避让",
         "阻拦者从上一镜主角视线方向进入，主角和控制台之间的空间关系不能跳变", 1, 2, 5),
        ("reveal", "记忆击中与反转", "恐惧", "证据触发旧记忆，观众得到一条改变解释方向的新信息", "记忆击中", "主角伸手触碰证据或旧设备",
         f"{reversal}；主角表情从防备变成确认，手部动作短暂失控后重新抓紧道具", "主角意识到这不是普通故障",
         "保留一句能被声音表演的反应台词，避免用旁白解释反转", "加入带距离感的广播/录音声，低频底噪与七声金属敲击形成记忆指纹",
         f"必须从{second}或上一镜道具特写切入，音效先于画面半拍进入", 1, 2, 5),
        ("choice", "主动选择与质问", "记忆击中", "主角停止等待解释，承担风险把证据留存并正面对抗阻拦者", "恐惧转为主动质问",
         "主角握紧关键道具并重新站稳", f"{choice}；她完成重启/保存/质问中的连续动作，不用摆 pose 代替过程",
         "主角把证据举到阻拦者面前，要求对方回答", "对白、呼吸和动作分开标注，主角最后一句必须落在镜头切点前",
         "动作音效跟随手部和机械动作；BGM 从压迫转为推进；不覆盖关键对白",
         "主角的手套、钥匙、磁带或手机状态必须与上一镜一致，动作结束后才能切反应镜头", 2, 2, 6),
        ("cliffhanger", "证据钩子", "主动质问", "主角以为获得答案，新的声音或威胁立即推翻安全感", "不安与追更冲动",
         "主角保持质问姿态，空间暂时安静", f"录音/广播给出新的证据：{ending}；主角的视线移向画外，不直接解释后果",
         "镜头停在证据、倒计时或阻拦者反应上", "结尾只保留能引发下一集的问题，最后一个字后留极短呼吸尾音",
         "环境底噪继续，关键提示音收紧，BGM 在钩子落点处截断或反向拉起",
         "结尾画面必须留下可在下一集接续的物件/视线/声音，不得回到普通状态", 2, 2, 5),
    ]
    fields = ("phase", "label", "emotionStart", "emotionProcess", "emotionEnd", "actionStart", "actionProcess",
              "actionEnd", "dialoguePlan", "soundPlan", "continuity", "sceneNo", "shotCount", "durationSeconds")
    return [dict(zip(fields, row)) for row in rows]


def build_episode_blueprint(*, project_id: int, episode_no: int, episode: dict[str, Any], bible: dict[str, Any],
                            platform: str, candidate_policy: dict[str, Any], source_script: dict[str, Any] | None = None) -> dict[str, Any]:
    beats = _build_beats(episode)
    source_script = source_script if isinstance(source_script, dict) else {}
    scenes = source_script.get("scenes") if isinstance(source_script.get("scenes"), list) else []
    shots = source_script.get("shots") if isinstance(source_script.get("shots"), list) else []
    source_shots = []
    for index, shot in enumerate(shots):
        action = _text(shot.get("actionText"))
        dialogue = _text(shot.get("dialogueText"))
        prompt = _text(shot.get("visualPrompt"))
        if not action and not dialogue and not prompt:
            continue
        purpose = _text(shot.get("shotPurpose"), "story")
        if "hook" in purpose.lower() or index == 0:
            beat = "beat-01"
        elif "cliffhanger" in purpose.lower() or index == len(shots) - 1:
            beat = "beat-05"
        elif any(word in purpose.lower() for word in ("dialogue", "reveal")):
            beat = "beat-03" if index < len(shots) * 0.6 else "beat-04"
        elif "choice" in purpose.lower():
            beat = "beat-04"
        else:
            beat = "beat-02" if index < len(shots) * 0.4 else "beat-03"
        source_shots.append({
            "shotKey": f"scene-{_positive_int(shot.get('sceneNo'), 1)}-shot-{_text(shot.get('shotNo'), str(index + 1).zfill(2))}",
            "sceneNo": _positive_int(shot.get("sceneNo"), 1), "beatId": beat, "shotNo": len(source_shots) + 1,
            "sourceStoryboardId": _positive_int(shot.get("storyboardId", shot.get("sourceStoryboardId")), 0) or None,
            "sourceShotNo": _text(shot.get("shotNo"), str(index + 1).zfill(2)),
            "shotType": _text(shot.get("shotType")), "purpose": purpose,
            "durationSeconds": max(1, float(shot.get("durationSeconds") or 1)),
            "motionRequirement": "必须完成动作起点、过程和结束状态；不可用静帧停留替代表演。",
            "dialogueRequirement": dialogue or "无对白镜头只保留动作、环境声和明确的反应节拍。",
            "dialogueText": dialogue,
            "audioRequirement": _text(shot.get("audioDirection"), beats[0]["soundPlan"]),
            "actingBeat": _text(shot.get("actingBeat")), "actionText": action,
            "visualPrompt": prompt, "startVisualPrompt": _text(shot.get("startVisualPrompt")),
            "endVisualPrompt": _text(shot.get("endVisualPrompt")),
            "candidateTier": "key" if purpose in {"hook", "dialogue", "reveal", "choice", "cliffhanger"} else "normal",
        })
    if not source_shots:
        source_shots = [
            {"shotKey": f"{beat['phase']}-{index + 1}", "sceneNo": beat["sceneNo"], "beatId": f"beat-{beat_index + 1:02d}",
             "shotNo": beat_index * 2 + index + 1, "purpose": beat["label"],
             "durationSeconds": max(2, round(beat["durationSeconds"] / beat["shotCount"])),
             "motionRequirement": "必须有动作起点、过程和结束状态", "dialogueRequirement": beat["dialoguePlan"],
             "audioRequirement": beat["soundPlan"],
             "candidateTier": "key" if beat["phase"] in {"hook", "reveal", "choice", "cliffhanger"} else "normal"}
            for beat_index, beat in enumerate(beats) for index in range(beat["shotCount"])
        ]
    voice_constraints = None
    if source_shots and int(project_id) == 12 and int(episode_no) == 1:
        voice_constraints = {"required": ["苏岚（广播）：六。别怕，小夏。", "苏岚（广播）：四。"],
                             "forbidden": ["苏岚（广播）：五。", "苏岚（广播）：五"],
                             "notes": ["六。别怕，小夏。必须完整保留。", "五不生成、不读出。", "四独立清楚，后接反应镜头。"]}
    visual = episode.get("visualSetPieces") if isinstance(episode.get("visualSetPieces"), list) else []
    total_duration = sum(float(shot.get("durationSeconds") or 0) for shot in shots)
    source_type = "detailed-script" if source_shots else "season-structure"
    return {
        "projectId": _positive_int(project_id, 0), "platform": _text(platform, "抖音"),
        "episodeNo": _positive_int(episode_no, 1), "title": _text(episode.get("title"), f"第 {episode_no} 集"),
        "promise": _text(bible.get("emotionalPromise"), "强冲突、连续声音和结尾追更钩子"),
        "logline": _text(episode.get("logline")),
        "targetDurationSeconds": _positive_int(episode.get("targetDurationSeconds"), int(total_duration) or 24),
        "pilotSceneCount": 2, "pilotMode": "two-scenes-golden-sample",
        **{key: _text(episode.get(key)) for key in ("openingHook", "goal", "coreConflict", "irreversibleChange", "protagonistChoice", "reversal", "endingHook")},
        "visualSetPieces": [_text(item) for item in visual if _text(item)], "emotionBeats": beats,
        "shotPlan": source_shots,
        "continuityConstraints": ["主角服装、发型、关键道具和角色版本必须锁定；新候选不得污染已确认主版本。",
                                  "每个镜头都要记录起始帧、动作过程、结束帧，禁止用静帧回退伪装连续表演。",
                                  "对白、嘴型、字幕和声音效果必须来自同一时间轴，广播声音需要保留空间距离感。",
                                  "上一镜的视线、站位和道具状态必须能解释下一镜的动作，不允许无因果跳变。",
                                  "验证片必须持续有环境底噪；静默只能作为蓝图中的明确设计。"],
        "soundDesign": {"tracks": ["dialogue", "environment", "sfx", "music", "subtitle"],
                        "dialoguePolicy": "对白先锁时钟，再生成嘴型和字幕；关键对白不得被 BGM 覆盖",
                        "environmentPolicy": "持续空间底噪，按镜头空间变化做渐变",
                        "musicPolicy": "按情绪段进入、避让对白，在结尾钩子落点做截断或拉起",
                        "sfxPolicy": "继电器、脚步、金属触碰、磁带/广播提示音必须绑定动作时间点",
                        "designedSilencePolicy": "只允许蓝图明确标记的短静默，不允许生成失败导致长静音"},
        "candidatePolicy": normalize_candidate_policy(candidate_policy),
        "sourceEvidence": {"episodeFields": ["openingHook", "coreConflict", "protagonistChoice", "irreversibleChange", "reversal", "endingHook"],
                           "lockedFacts": bible.get("lockedFacts", [])[:20] if isinstance(bible.get("lockedFacts"), list) else [],
                           "locations": bible.get("locations", [])[:10] if isinstance(bible.get("locations"), list) else [],
                           "characters": [_text(c.get("name")) for c in bible.get("characters", []) if isinstance(c, dict) and _text(c.get("name"))][:20],
                           "sourceType": source_type, "scriptVersion": _text(source_script.get("version"), "database-script"),
                           "sceneCount": len(scenes), "shotCount": len(source_shots),
                           "sourceStoryboardIds": [shot["sourceStoryboardId"] for shot in source_shots if shot.get("sourceStoryboardId")],
                           "dialogueLines": [shot["dialogueText"] for shot in source_shots if shot.get("dialogueText")],
                           "voiceHardConstraints": voice_constraints},
    }


def evaluate_episode_blueprint(blueprint: dict[str, Any]) -> dict[str, Any]:
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    try:
        duration = float(blueprint.get("targetDurationSeconds"))
        valid_duration = duration == duration and 15 <= duration <= 60 and abs(duration) != float("inf")
    except (TypeError, ValueError):
        duration, valid_duration = 0.0, False
    beats = blueprint.get("emotionBeats") if isinstance(blueprint.get("emotionBeats"), list) else []
    shots = blueprint.get("shotPlan") if isinstance(blueprint.get("shotPlan"), list) else []
    continuity = [item for item in blueprint.get("continuityConstraints", []) if _text(item)] if isinstance(blueprint.get("continuityConstraints"), list) else []
    evidence = blueprint.get("sourceEvidence") if isinstance(blueprint.get("sourceEvidence"), dict) else None
    if not valid_duration:
        blockers.append({"code": "invalid-duration", "message": "验证蓝图时长必须在 15～60 秒之间。"})
    if len(beats) < 4 or any(
        not isinstance(beat, dict) or any(not _text(beat.get(field)) for field in BEAT_FIELDS)
        for beat in beats
    ):
        blockers.append({"code": "emotion-beats-incomplete", "message": "每个情绪段必须具备情绪起点、过程、终点，动作起点、过程、终点，对白、声音和连续性。"})
    phases = {_text(beat.get("phase")) for beat in beats if isinstance(beat, dict)}
    if "hook" not in phases:
        blockers.append({"code": "missing-hook-beat", "message": "缺少开场钩子情绪段。"})
    if "cliffhanger" not in phases:
        blockers.append({"code": "missing-cliffhanger-beat", "message": "缺少结尾追更钩子情绪段。"})
    if len(continuity) < 3:
        blockers.append({"code": "missing-continuity-constraints", "message": "至少需要 3 条跨镜头连续性约束。"})
    if not shots:
        blockers.append({"code": "missing-shot-plan", "message": "情绪段必须进一步落成镜头计划，不能直接进入素材生成。"})
    if evidence and evidence.get("sourceType") == "detailed-script":
        expected = evidence.get("shotCount")
        if isinstance(expected, int) and expected > 0 and len(shots) != expected:
            blockers.append({"code": "source-shot-plan-mismatch", "message": f"详细剧本要求 {expected} 个镜头，当前蓝图只有 {len(shots)} 个。"})
        dialogue = "\n".join(_text(shot.get("dialogueText") or shot.get("dialogueRequirement")) for shot in shots if isinstance(shot, dict))
        constraints = evidence.get("voiceHardConstraints") or {}
        for item in constraints.get("required", []) if isinstance(constraints, dict) else []:
            if _text(item) not in dialogue:
                blockers.append({"code": "required-dialogue-missing", "message": f"缺少硬约束对白：{item}"})
        for item in constraints.get("forbidden", []) if isinstance(constraints, dict) else []:
            if _text(item) in dialogue:
                blockers.append({"code": "forbidden-dialogue", "message": f"禁止对白出现在蓝图中：{item}"})
    if not _text(blueprint.get("openingHook")) or not _text(blueprint.get("endingHook")):
        blockers.append({"code": "missing-story-hook", "message": "单集蓝图必须保留开场钩子和结尾追更钩子。"})
    key_count = sum(1 for shot in shots if isinstance(shot, dict) and shot.get("candidateTier") == "key")
    normal_count = sum(1 for shot in shots if isinstance(shot, dict) and shot.get("candidateTier") == "normal")
    if not key_count or not normal_count:
        blockers.append({"code": "candidate-tier-incomplete", "message": "镜头计划必须同时包含关键镜头和普通镜头，才能执行差异化候选策略。"})
    if any("静音" in _text(beat.get("soundPlan")) and "设计" not in _text(beat.get("soundPlan")) for beat in beats if isinstance(beat, dict)):
        warnings.append({"code": "unplanned-silence-risk", "message": "声音计划出现静音描述，请确认是有意设计而不是生成失败。"})
    return {"type": "episode-blueprint", "canApprove": not blockers, "blockers": blockers, "warnings": warnings,
            "summary": {"targetDurationSeconds": duration if valid_duration else None, "emotionBeatCount": len(beats),
                        "shotCount": len(shots), "keyShotCount": key_count, "normalShotCount": normal_count,
                        "continuityConstraintCount": len(continuity)}}
