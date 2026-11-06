"""资产图片视觉检查（Node services/ai/vision.mjs + scene-vision-policy.mjs 的 Python 复刻）。

``inspect_asset_image`` 保留 Node 的三级降级：mock 文本模型 → skipped（直接通过）；
未配置 VISION_API_KEY → pending（等待视觉检查）；已配置 → 调视觉模型并过内容/空场/
视角一致性门禁。离线测试覆盖前两级与门禁纯函数。
"""

from __future__ import annotations

import base64
import json
import re
from typing import Any

import httpx

# scene-vision-policy.mjs：场景图采用全景母图 + 固定空间提示词约束，不再调视觉模型。
SCENE_VISION_CHECK_ENABLED = False

_HUMAN_SUBJECT_PATTERN = re.compile(r"人物|人影|人像|男性|女性|男孩|女孩|身影|肖像|人体|遗像|人形")
_NEGATIVE_CONTEXT_PATTERN = re.compile(r"(?:没有|无|未见|未出现|禁止|不含|未包含|不存在)[^，。；;.!！？?]{0,12}$")
_WATERMARK_PATTERN = re.compile(r"水印|logo|标识|角标|平台标记|AI生成标记", re.I)
_READABLE_TEXT_PATTERN = re.compile(r"可读文字|文字内容|中文文字|英文文字|字母|数字|字幕|按钮标签|屏幕文字|邮件内容|账号|乱码")
_NEGATIVE_CONTENT_PATTERN = re.compile(r"(?:没有|无|未见|未出现|禁止|不含|未包含|不存在|空白|无文字|无水印)[^，。；;.!！？?]{0,18}$")
_ALLOWED_NARRATIVE_TEXT_PATTERN = re.compile(r"剧情(?:指定|需要|允许)(?:的)?标签|指定标签|道具标签|故事标签")

_NO_FACE_PROMPT_RE = re.compile(r"不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见")


def is_scene_vision_check_enabled() -> bool:
    """Node isSceneVisionCheckEnabled：场景视觉检查恒关（全景母图人工确认通道）。"""
    return SCENE_VISION_CHECK_ENABLED


def _text(value: Any) -> str:
    """Node text() 等价。"""
    if value is None:
        return ""
    return str(value).strip()


def build_vision_request_payload(
    *,
    model: Any,
    image_url: Any,
    reference_image_url: Any = None,
    reference_image_urls: list[Any] | None = None,
    view_key: Any = None,
    scene: bool = False,
    asset_pack: bool = False,
    node_type: Any = "",
    no_face: bool = False,
    identity_lock: bool = False,
) -> dict[str, Any]:
    """Node buildVisionRequestPayload：视觉质检请求体（prompt 逐字对齐）。"""
    view_key = _text(view_key)
    angle = {"front": "正面", "side": "严格90度左侧面", "back": "背面"}.get(view_key) or "指定视角"
    use_no_face_constraint = no_face and view_key not in ("side", "back")
    prop = _text(node_type) in ("prop", "material", "tool")
    if prop:
        target = (
            "这是单件道具资产。检查图片中是否为一个完整、可识别、可实际使用的道具本体：主体完整入镜，完整边缘可见，"
            "最左到最右边缘、最高点到底部接触面、把手、底座、开口、按钮、接口、线缆和附属结构均清晰可见；道具居中，"
            "四周有安全留白，背景干净中性，禁止人物、手持、场景、拼贴、重复道具和水印。若提示词明确写出“剧情指定标签/道具标签”，"
            "只允许该标签原样存在；除此之外的随机文字、乱码、错误数字、平台Logo和水印必须拒绝。不要使用人物全身或人体比例判定标准。"
        )
    elif asset_pack:
        target = (
            "这是角色资产板母图，不是单张角色图，也不是一张只检查排版的网页缩略图。检查原始横向白底资产板是否按固定排版包含五个语义区域："
            "左侧完整正面全身图；右上独立且明显可辨的正面脸部特写；右下依次为正面、严格90度侧面、背面三张完整全身图。"
            "脸部特写是五官、脸型、发际线和发型的身份主参考；左侧正面全身图是体态、身高比例、服装、鞋子和配饰的基准；"
            "右下三视图必须逐一同时回看这两个基准，不能只看“像一个人”或只看衣服。必须核对正面全身、脸部特写、三视图正面/侧面/背面的眼距、"
            "眉眼形状、鼻梁鼻尖、嘴唇、下颌轮廓、耳朵、发际线、发长发量、肩宽体态、服装版型颜色和固定配饰是否属于同一角色。"
            "侧面必须是严格90度且鼻梁、嘴唇、下颌轮廓自然连续；背面不得出现脸，但发型长度、后脑勺轮廓、肩线、衣服后片和鞋子必须与正面基准一致。"
            "优先判断区域是否存在、顺序是否正确、脸部特写是否独立、三视图是否齐全；不要因为网页缩略图、区域人物较小或自然留白而判缺失。"
            "只要任一视图出现换脸、五官明显变形、脸型不一致、发型漂移、年龄性别改变、体态比例明显漂移、服装/配饰不一致、错误侧面/背面，就必须 passed=false。"
            "不要把模型的不确定性当作通过；无法清楚比较时也必须 passed=false。"
        )
    elif scene:
        target = (
            f"这是九宫格单格中的{view_key}独立机位图。检查该图是否与第二张全景母图保持同一空间的固定布局、建筑结构、门窗方向、"
            "固定道具位置和光线关系；允许因摄影机角度变化出现透视变化、自然遮挡和画面比例变化，不要因为只显示单一机位而判失败，"
            "也不要要求该机位重复呈现全景中所有物件"
            if view_key
            else "这是场景全景母版图。检查是否为完整可用的环境空间全景，空间布局、建筑结构、门窗方向、固定道具位置和光线关系是否清晰稳定；禁止角色主体、多人、字幕、文字和水印"
        )
    elif view_key == "face":
        target = (
            "这是角色脸部特写资产。检查是否为同一角色的正面脸部特写，脸部应占画面宽度约35%至70%，眼睛、鼻子和嘴唇清晰可辨；"
            "头发顶部、双耳、下颌线和锁骨上方完整可见，画面不能出现膝盖、腰部以下或大段躯干；禁止全身、半身动作、侧面、背面、"
            "三分之四侧脸、场景、道具、文字和水印。"
        )
    elif use_no_face_constraint:
        target = (
            "这是剧情明确要求不直接露脸的角色资产。检查是否为单人、从头到鞋完整全身、纯白背景；脸部必须保持不可辨识或被构图/阴影/遮挡隐藏，"
            "不得把该角色生成成清晰正脸肖像"
        )
    else:
        target = (
            f"角色是否为{angle}、单人、从头到鞋完整全身、白色背景，并且没有错误视角特征。若目标为严格90度左侧面，必须拒绝仍能看到双眼、"
            "胸口正面或两只鞋正面的正面图；若目标为背面，必须拒绝可见脸部"
        )

    references = [
        _text(value)
        for value in [*(reference_image_urls or []), reference_image_url]
        if _text(value)
    ]
    references = list(dict.fromkeys(references))
    content: list[dict[str, Any]] = [
        {
            "type": "input_text",
            "text": " ".join(
                part
                for part in [
                    "你是资产图片视觉质检器。",
                    "第一张图片是唯一需要判定的当前候选原图，不是网页截图、缩略图或候选列表；不要根据界面布局、裁切预览或其它历史图片推断。",
                    target,
                    (
                        "身份一致性与服装一致性检查：当前候选必须与后续参考图属于同一张脸、同一发型和同一套服装；如果脸型、五官相对位置、发长、"
                        "衣服颜色/版型、鞋子或固定配饰明显变化，必须 passed=false，并在 reason 中指出具体差异。不要因为参考图中某个角度被遮挡而臆测不一致。"
                        if identity_lock
                        else ""
                    ),
                    "如果图片主体符合目标但网页预览可能被裁切，按原图主体判定，不因UI显示区域缺少头脚而拒绝；只有原图本身确实缺失头脚、角度错误、出现人物/场景污染或结构错误时才拒绝。",
                    (
                        "资产板必须只返回JSON，不要Markdown，格式为：{\"passed\":false,\"reason\":\"指出具体不一致区域和差异\",\"face_closeup_consistent\":false,"
                        "\"base_full_body_consistent\":false,\"turnaround_consistent\":false,\"region_checks\":{\"face\":{\"consistent\":false,\"reason\":\"\"},"
                        "\"base\":{\"consistent\":false,\"reason\":\"\"},\"front\":{\"consistent\":false,\"reason\":\"\"},\"side\":{\"consistent\":false,\"reason\":\"\"},"
                        "\"back\":{\"consistent\":false,\"reason\":\"\"}},\"layout_complete\":false,\"identity_similarity_score\":0,\"wardrobe_consistency_score\":0}。"
                        "五个 region_checks 必须全部返回；任一无法确认必须 consistent=false、passed=false。"
                        if asset_pack
                        else "只返回JSON，不要Markdown，格式为：{\"passed\":true,\"reason\":\"简短且可操作的原因\"}"
                    ),
                ]
                if part
            ),
        },
        {"type": "input_image", "image_url": _text(image_url)},
    ]
    if references:
        content.append(
            {
                "type": "input_text",
                "text": (
                    "后续图片是同一空间的全景母图，只用于比对固定布局和空间锚点，不把它们当成待检查的目标视角。"
                    if scene
                    else (
                        "后续图片是已确认的同一角色身份参考图，依次用于比对基础全身、脸部特写和各个角度；它们不是待检查的目标。"
                        if identity_lock
                        else "后续图片是参考图，只用于辅助比对，不把它们当成待检查的目标。"
                    )
                ),
            }
        )
        for reference in references:
            content.append({"type": "input_image", "image_url": reference})
    return {
        "model": _text(model),
        "input": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_output_tokens": 768 if asset_pack else 256,
        "reasoning": {"effort": "minimal"},
    }


def _extract_text(payload: Any) -> str:
    """Node extractText：多形态响应提取文本。"""
    if isinstance(payload, dict):
        if isinstance(payload.get("output_text"), str):
            return payload["output_text"]
        choices = payload.get("choices")
        if choices and isinstance(choices[0], dict):
            content = choices[0].get("message", {}).get("content")
            if isinstance(content, str):
                return content
    values: list[str] = []
    output = payload.get("output") if isinstance(payload, dict) else None
    for item in output or []:
        if isinstance(item, dict):
            if isinstance(item.get("text"), str):
                values.append(item["text"])
            content = item.get("content")
            for inner in content or []:
                if isinstance(inner, dict):
                    if isinstance(inner.get("text"), str):
                        values.append(inner["text"])
                    if isinstance(inner.get("value"), str):
                        values.append(inner["value"])
    return "\n".join(values)


def _extract_chat_content(payload: Any) -> str:
    """Node extractChatContent：chat completions 形态优先。"""
    if isinstance(payload, dict):
        choices = payload.get("choices")
        if choices and isinstance(choices[0], dict):
            content = choices[0].get("message", {}).get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return "\n".join(
                    item["text"] for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)
                )
    return _extract_text(payload)


def parse_vision_result(payload: Any, *, asset_pack: bool = False) -> dict[str, Any]:
    """Node parseVisionResult：视觉模型输出解析（资产板五区一致性聚合）。"""
    raw = _extract_text(payload).strip()
    match = re.search(r"\{[\s\S]*\}", raw) or re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw, re.I)
    if not match:
        shape = {
            "topLevelKeys": list(payload.keys())[:20] if isinstance(payload, dict) else [],
            "rawPreview": raw[:500],
        }
        return {
            "passed": False,
            "reason": f"视觉模型没有返回合法JSON（响应结构：{json.dumps(shape, ensure_ascii=False)}）",
            "raw": raw,
        }
    try:
        result = json.loads(match.group(1) if match.lastindex else match.group(0))
    except (TypeError, ValueError):
        return {"passed": False, "reason": "视觉模型返回内容无法解析", "raw": raw}
    identity_similarity_score = (
        float(result["identity_similarity_score"]) if _finite(result.get("identity_similarity_score")) else None
    )
    wardrobe_consistency_score = (
        float(result["wardrobe_consistency_score"]) if _finite(result.get("wardrobe_consistency_score")) else None
    )
    if not asset_pack:
        return {
            "passed": result.get("passed") is True,
            "reason": _text(result.get("reason")) or ("视觉检查通过" if result.get("passed") is True else "视觉检查未通过"),
            "identitySimilarityScore": identity_similarity_score,
            "wardrobeConsistencyScore": wardrobe_consistency_score,
            "raw": raw,
        }

    region_keys = ["face", "base", "front", "side", "back"]
    checks = result.get("region_checks") if isinstance(result.get("region_checks"), dict) else None
    missing_checks = [key for key in region_keys if not isinstance((checks or {}).get(key), dict) or not isinstance(checks[key].get("consistent"), bool)]
    inconsistent_regions = [key for key in region_keys if (checks or {}).get(key, {}).get("consistent") is not True]
    board_consistent = (
        result.get("layout_complete") is True
        and result.get("face_closeup_consistent") is True
        and result.get("base_full_body_consistent") is True
        and result.get("turnaround_consistent") is True
        and not missing_checks
        and not inconsistent_regions
    )
    if not board_consistent:
        region_reasons = [_text((checks or {}).get(key, {}).get("reason")) for key in inconsistent_regions]
        detail = (
            f"五区身份一致性结论缺失：{'、'.join(missing_checks)}"
            if missing_checks
            else f"不一致区域：{'、'.join(inconsistent_regions)}{'（' + '；'.join(filter(None, region_reasons)) + '）' if any(region_reasons) else ''}"
        )
        return {
            "passed": False,
            "reason": f"角色资产板一致性检查未通过：{detail}{'；视觉模型说明：' + _text(result.get('reason')) if _text(result.get('reason')) else ''}",
            "identitySimilarityScore": identity_similarity_score,
            "wardrobeConsistencyScore": wardrobe_consistency_score,
            "assetPackConsistency": {
                "faceCloseup": result.get("face_closeup_consistent") is True,
                "baseFullBody": result.get("base_full_body_consistent") is True,
                "turnaround": result.get("turnaround_consistent") is True,
                "missingChecks": missing_checks,
                "inconsistentRegions": inconsistent_regions,
            },
            "raw": raw,
        }
    return {
        "passed": result.get("passed") is True,
        "reason": _text(result.get("reason")) or ("角色资产板五区一致性检查通过" if result.get("passed") is True else "视觉检查未通过"),
        "identitySimilarityScore": identity_similarity_score,
        "wardrobeConsistencyScore": wardrobe_consistency_score,
        "assetPackConsistency": {
            "faceCloseup": True,
            "baseFullBody": True,
            "turnaround": True,
            "missingChecks": [],
            "inconsistentRegions": [],
        },
        "raw": raw,
    }


def _finite(value: Any) -> bool:
    """数值可转换判定。"""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return False
    return parsed == parsed and parsed not in (float("inf"), float("-inf"))


def enforce_empty_scene_vision(result: dict[str, Any]) -> dict[str, Any]:
    """Node enforceEmptySceneVision：空场通过理由里出现人物描述视为硬失败。"""
    reason = _text(result.get("reason"))
    if not result.get("passed") or not _HUMAN_SUBJECT_PATTERN.search(reason):
        return result
    clauses = re.split(r"[，。；;.!！？?]", reason)
    positive_human_clause = any(
        _HUMAN_SUBJECT_PATTERN.search(clause) and not _NEGATIVE_CONTEXT_PATTERN.search(clause.strip()[:40])
        for clause in clauses
    )
    if not positive_human_clause:
        return result
    return {**result, "passed": False, "reason": f"场景空场门禁拒绝人物污染：{reason}"}


def enforce_asset_content_vision(result: dict[str, Any], *, node_type: Any = "", scene: bool = False) -> dict[str, Any]:
    """Node enforceAssetContentVision：水印/可读文字硬失败门禁。"""
    reason = _text(result.get("reason"))
    if not result.get("passed") or not reason:
        return result
    clauses = re.split(r"[，。；;.!！？?]", reason)

    def has_positive(pattern: re.Pattern[str]) -> bool:
        """存在未带否定上下文的正向命中。"""
        return any(pattern.search(clause) and not _NEGATIVE_CONTENT_PATTERN.search(clause.strip()[:44]) for clause in clauses)

    if has_positive(_WATERMARK_PATTERN):
        return {**result, "passed": False, "contentIssue": "watermark", "reason": f"资产内容门禁拒绝水印：{reason}"}
    narrative_label_allowed = _text(node_type) in ("prop", "material") and bool(
        _ALLOWED_NARRATIVE_TEXT_PATTERN.search(reason)
    ) and not re.search(r"乱码|随机文字|错误文字|水印|Logo|平台标记", reason)
    if _text(node_type) in ("scene", "prop", "material") and has_positive(_READABLE_TEXT_PATTERN) and not narrative_label_allowed:
        return {
            **result,
            "passed": False,
            "contentIssue": "readable-text",
            "reason": f"{'场景' if scene else '道具'}内容门禁拒绝可读文字：{reason}",
        }
    return result


def enforce_vision_view_consistency(view_key: Any, result: dict[str, Any]) -> dict[str, Any]:
    """Node enforceVisionViewConsistency：side/back 结果与请求视角自相矛盾拒绝。"""
    normalized_key = _text(view_key)
    reason = _text(result.get("reason"))
    if not result.get("passed") or not reason or normalized_key not in ("side", "back"):
        return result
    explicitly_negative = bool(re.search(r"(?:不是|非|无|未见|看不到|不可见)[^。；，,]{0,8}(?:正面|双眼|脸|面部)", reason))
    if normalized_key == "back":
        contradiction = not explicitly_negative and bool(re.search(r"正面(?:形象|照|视角|朝向)|可见脸|看到脸|露脸|面部清晰", reason))
    else:
        contradiction = not explicitly_negative and bool(re.search(r"正面(?:形象|照|视角|朝向)|双眼|胸口正面|可见脸|看到脸", reason))
    if not contradiction:
        return result
    return {**result, "passed": False, "reason": f"视觉模型结果与请求视角判定自相矛盾：{reason}"}


def _image_mime_type(data: bytes) -> str:
    """Node imageMimeType：PNG/JPEG/WEBP 嗅探。"""
    if data[:4] == b"\x89PNG":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def inspect_asset_image(
    *,
    image_url: Any = None,
    image_bytes: bytes | None = None,
    reference_image_url: Any = None,
    reference_image_urls: list[Any] | None = None,
    reference_image_bytes: bytes | None = None,
    reference_image_bytes_list: list[bytes] | None = None,
    view_key: Any = None,
    scene: bool = False,
    asset_pack: bool = False,
    node_type: Any = "",
    no_face: bool = False,
    identity_lock: bool = False,
    http_client: Any = None,
) -> dict[str, Any]:
    """Node inspectAssetImage：资产图片视觉检查入口（三级降级语义对齐）。

    :param image_url: 当前候选图地址（无 bytes 时使用）。
    :param image_bytes: 当前候选图字节（优先于 URL）。
    :param reference_image_url: 单个参考图地址。
    :param reference_image_urls: 参考图地址列表。
    :param reference_image_bytes: 单个参考图字节。
    :param reference_image_bytes_list: 参考图字节列表。
    :param view_key: 视角键。
    :param scene: 是否场景资产。
    :param asset_pack: 是否角色资产板。
    :param node_type: 节点类型。
    :param no_face: 是否剧情不露脸角色。
    :param identity_lock: 是否身份锁检查。
    :param http_client: 可注入的 httpx 客户端（测试用）；缺省按需新建。
    :returns: ``{"passed", "reason", "skipped"?/"pending"?, "identitySimilarityScore"?, ...}``。
    """
    from ..ai_provider import get_ai_config, is_mock_provider

    config = get_ai_config()
    if is_mock_provider(config):
        return {"passed": True, "reason": "mock 模式跳过视觉检查", "skipped": True}
    base_url = _text(
        __import__("os").environ.get("VISION_BASE_URL") or "https://ark.cn-beijing.volces.com/api/v3/responses"
    ).rstrip("/")
    api_key = _text(__import__("os").environ.get("VISION_API_KEY") or "")
    model = _text(__import__("os").environ.get("VISION_MODEL") or "doubao-seed-2-1-lite-260915")
    if not base_url or not api_key or not model:
        return {"passed": False, "reason": "未配置视觉模型，等待视觉检查", "pending": True}

    normalized_image_url = _text(image_url)
    data_url = (
        f"data:image/png;base64,{base64.b64encode(image_bytes).decode()}"
        if image_bytes
        else normalized_image_url
    )
    if not data_url:
        return {"passed": False, "reason": "视觉检查缺少可读取的图片"}
    reference_data_urls = [
        (
            f"data:image/png;base64,{base64.b64encode(value).decode()}"
            if isinstance(value, (bytes, bytearray))
            else _text(value)
        )
        for value in [*(reference_image_bytes_list or []), *(reference_image_urls or [])]
    ]
    reference_data_urls = [value for value in reference_data_urls if value]
    reference_data_url = (
        f"data:image/png;base64,{base64.b64encode(reference_image_bytes).decode()}"
        if reference_image_bytes
        else _text(reference_image_url)
    )
    payload = build_vision_request_payload(
        model=model,
        image_url=data_url,
        reference_image_url=reference_data_url,
        reference_image_urls=reference_data_urls,
        view_key=view_key,
        scene=scene,
        asset_pack=asset_pack,
        node_type=node_type,
        no_face=no_face,
        identity_lock=identity_lock,
    )
    try:
        timeout = float(__import__("os").environ.get("VISION_TIMEOUT_MS") or 60000) / 1000
        if http_client is not None:
            response = http_client.post(
                base_url,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json=payload,
                timeout=timeout,
            )
        else:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(
                    base_url,
                    headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                    json=payload,
                )
    except Exception as error:
        return {"passed": False, "reason": f"视觉检查请求失败：{error}"}
    try:
        response_payload = response.json() if response.text else None
    except (ValueError, json.JSONDecodeError):
        response_payload = None
    if response.status_code >= 400 or (isinstance(response_payload, dict) and response_payload.get("error")):
        detail = ""
        if isinstance(response_payload, dict):
            detail = _text(
                (response_payload.get("error") or {}).get("message")
                if isinstance(response_payload.get("error"), dict)
                else response_payload.get("message") or response_payload.get("detail")
            )
        detail = detail or response.text[:300]
        return {
            "passed": False,
            "reason": f"视觉接口返回 HTTP {response.status_code}{('：' + detail) if detail else ''}",
            "detail": response_payload,
        }
    content_checked = enforce_asset_content_vision(
        parse_vision_result({"output_text": _extract_chat_content(response_payload)}, asset_pack=asset_pack),
        node_type=node_type,
        scene=scene,
    )
    scene_checked = enforce_empty_scene_vision(content_checked) if scene else content_checked
    return enforce_vision_view_consistency(view_key, scene_checked)
