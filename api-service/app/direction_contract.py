from __future__ import annotations

import math
import re
from typing import Any

SILENT_DIALOGUE = re.compile(r"^(?:（无对白）|\(无对白\)|无对白|无台词|none|no dialogue)$", re.I)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _number(value: Any, fallback: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _is_silent(value: Any) -> bool:
    normalized = _text(value)
    return not normalized or bool(SILENT_DIALOGUE.fullmatch(normalized))


def _infer_gaze_target(action: Any, beat: Any) -> str:
    match = re.search(r"(?:看向|望向|看着|盯住|锁定|注视|转向)([^，。；;、]+)", f"{_text(action)} {_text(beat)}")
    return _text(match.group(1) if match else "") or "当前动作对象"


def _infer_gaze(input_data: dict[str, Any]) -> dict[str, Any]:
    duration = max(1, math.ceil(_number(input_data.get("durationSeconds", input_data.get("duration_seconds")), 4) or 4))
    target = _infer_gaze_target(input_data.get("actionText", input_data.get("action_text")), input_data.get("actingBeat", input_data.get("acting_beat")))
    return {
        "version": "gaze-control-v1",
        "startTarget": "镜头起始时的当前注视目标",
        "transitions": [{"fromSecond": 0, "toSecond": duration, "target": target, "observable": f"视线保持在{target}，眼睛和头部动作不跳变", "holdSeconds": duration}],
        "endTarget": target if target != "当前动作对象" else "本镜动作结果",
        "eyeLead": "若发生转移，眼睛先动，头部延迟半拍跟随；没有转移时保持目标稳定",
        "promptText": f"视线保持在{target}，动作结果出现后停住半拍",
        "inferred": True,
    }


def normalize_gaze(input_data: dict[str, Any]) -> dict[str, Any]:
    raw = input_data.get("gazePlan", input_data.get("gaze_plan"))
    fallback = _infer_gaze(input_data)
    if not isinstance(raw, dict):
        return fallback
    duration = max(1, math.ceil(_number(input_data.get("durationSeconds", input_data.get("duration_seconds")), 4) or 4))
    transitions = []
    for item in raw.get("transitions", raw.get("beats", raw.get("targets", []))):
        if not isinstance(item, dict):
            continue
        target = _text(item.get("target", item.get("ref", item.get("reference"))))
        if not target:
            continue
        transitions.append({
            "fromSecond": max(0, _number(item.get("fromSecond", item.get("from_second", item.get("atSeconds", item.get("at_seconds", 0)))), 0) or 0),
            "toSecond": max(0, _number(item.get("toSecond", item.get("to_second")), 0) or 0),
            "target": target,
            "observable": _text(item.get("observable", item.get("result"))),
            "holdSeconds": max(0, _number(item.get("holdSeconds", item.get("hold_seconds")), 0) or 0),
        })
    transitions.sort(key=lambda item: item["fromSecond"])
    if not transitions:
        return fallback
    normalized = []
    cursor = 0
    start_target = _text(raw.get("startTarget", raw.get("start_target"))) or fallback["startTarget"]
    for item in transitions:
        start = min(duration, max(cursor, item["fromSecond"]))
        end = min(duration, max(start, item["toSecond"]))
        if start > cursor:
            normalized.append({"fromSecond": cursor, "toSecond": start, "target": normalized[-1]["target"] if normalized else start_target, "observable": "视线保持在当前目标，等待下一次视线转移", "holdSeconds": start - cursor})
        if end > start:
            normalized.append({**item, "fromSecond": start, "toSecond": end})
            cursor = end
    if not normalized:
        return fallback
    if cursor < duration:
        normalized.append({"fromSecond": cursor, "toSecond": duration, "target": normalized[-1]["target"], "observable": "视线保持在最终目标直到镜头结束", "holdSeconds": duration - cursor})
    return {
        "version": _text(raw.get("version")) or "gaze-control-v1",
        "startTarget": start_target,
        "transitions": normalized,
        "endTarget": _text(raw.get("endTarget", raw.get("end_target"))) or normalized[-1]["target"],
        "eyeLead": _text(raw.get("eyeLead", raw.get("eye_lead"))) or fallback["eyeLead"],
        "promptText": _text(raw.get("promptText", raw.get("prompt_text"))) or "；".join(f"{item['fromSecond']}-{item['toSecond']}秒视线转向{item['target']}并停住" for item in normalized),
        "inferred": False,
    }


def _infer_sound(input_data: dict[str, Any]) -> dict[str, Any]:
    dialogue = _text(input_data.get("dialogueText", input_data.get("dialogue_text")))
    direction = _text(input_data.get("audioDirection", input_data.get("audio_direction")))
    action = _text(input_data.get("actionText", input_data.get("action_text")))
    has_dialogue = not _is_silent(dialogue)
    bed = direction or ("对白间隙保持连续的空间底噪，不掉入数字静音" if has_dialogue else "从0秒到镜头结束保持连续空间底噪")
    cues = []
    if action:
        cues.append({"atSecond": 0, "sound": "与主要动作同步的现场拟音", "syncAction": action})
    if has_dialogue:
        cues.append({"atSecond": 0, "sound": "对白清晰进入，环境底床压低但不断", "syncAction": dialogue})
    return {"version": "sound-design-v1", "bed": bed, "cues": cues, "silencePolicy": "只允许剧本明确要求的短暂停顿；无对白不等于无声", "mixPriority": ["动作拟音", "对白", "空间底床"] if has_dialogue else ["动作拟音", "空间底床"], "promptText": bed, "inferred": True}


def normalize_sound(input_data: dict[str, Any]) -> dict[str, Any]:
    raw = input_data.get("soundPlan", input_data.get("sound_plan"))
    fallback = _infer_sound(input_data)
    if not isinstance(raw, dict):
        return fallback
    cues = []
    for item in raw.get("cues", raw.get("events", [])):
        if not isinstance(item, dict):
            continue
        sound = _text(item.get("sound", item.get("label", item.get("name"))))
        if sound:
            cues.append({"atSecond": max(0, _number(item.get("atSecond", item.get("at_second", item.get("atSeconds", item.get("at_seconds", 0)))), 0) or 0), "sound": sound, "syncAction": _text(item.get("syncAction", item.get("sync_action", item.get("action"))))})
    bed = _text(raw.get("bed", raw.get("ambientBed", raw.get("ambient_bed")))) or fallback["bed"]
    return {"version": _text(raw.get("version")) or "sound-design-v1", "bed": bed, "cues": cues or fallback["cues"], "silencePolicy": _text(raw.get("silencePolicy", raw.get("silence_policy"))) or fallback["silencePolicy"], "mixPriority": [str(item).strip() for item in raw.get("mixPriority", raw.get("mix_priority", [])) if str(item).strip()] or fallback["mixPriority"], "promptText": _text(raw.get("promptText", raw.get("prompt_text"))) or bed, "inferred": False}


def validate_direction(input_data: dict[str, Any]) -> dict[str, Any]:
    gaze = normalize_gaze(input_data)
    sound = normalize_sound(input_data)
    duration = _number(input_data.get("durationSeconds", input_data.get("duration_seconds")))
    blockers = []
    if not gaze["transitions"]:
        blockers.append("缺少可执行视线转移或停留计划")
    if duration and any(item["toSecond"] > duration or item["fromSecond"] < 0 for item in gaze["transitions"]):
        blockers.append("视线时间段超出镜头时长")
    if any(item["toSecond"] <= item["fromSecond"] for item in gaze["transitions"]):
        blockers.append("视线时间段起止顺序无效")
    if duration and (gaze["transitions"][0]["fromSecond"] != 0 or any(item["fromSecond"] != gaze["transitions"][index - 1]["toSecond"] for index, item in enumerate(gaze["transitions"]) if index > 0) or gaze["transitions"][-1]["toSecond"] != duration):
        blockers.append("视线时间轴必须从0秒连续覆盖到镜头结束")
    if duration and any(item["atSecond"] > duration or item["atSecond"] < 0 for item in sound["cues"]):
        blockers.append("声音 cue 时间点超出镜头时长")
    if not gaze["endTarget"]:
        blockers.append("缺少镜头结束视线目标")
    if not sound["bed"]:
        blockers.append("缺少连续环境底床")
    if not sound["silencePolicy"]:
        blockers.append("缺少静音策略")
    return {"passed": not blockers, "blockers": blockers, "gaze": gaze, "sound": sound}
