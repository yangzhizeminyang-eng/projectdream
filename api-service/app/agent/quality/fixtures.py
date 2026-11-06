"""Node ``quality-gate.test.mjs`` 测试样例的结构化转译（fixture 数据源）。

每个 fixture 对应 Node 测试中的一个断言场景：``kwargs`` 为调用 Python 规则函数的
入参（snake_case 签名），``expected_*`` 字段记录 Node 测试期望（其中 Node 只断言
子集的 blocker/warning 集合，按 Node 规则源码语义补全为全集，用于更严格的
跨语言回归）。供 :mod:`tests.test_quality_rules_compat` 遍历执行。
"""

from __future__ import annotations

import json

# Node 测试中的完整角色+场景引用快照（fixture 2/3/6/7 共用骨架）。
_REFERENCE_FULL_JSON = json.dumps({
    "characterId": 9,
    "characterVersionNo": 2,
    "characterViewSetVersion": 1,
    "characterViewKeys": ["front", "side", "back"],
    "characterBaseImageId": 71,
    "characterBaseVersionNo": 1,
    "characterFaceImageId": 72,
    "characterFaceVersionNo": 1,
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "sceneViewSetVersion": 2,
    "sceneViewKey": "front-right",
}, ensure_ascii=False)

# 使用角色资产包整图替代拆分图 ID 的引用快照（fixture 3）。
_REFERENCE_ASSET_PACK_JSON = json.dumps({
    "characterId": 9,
    "characterVersionNo": 3,
    "characterAssetPackImageId": 91,
    "characterAssetPackVersionNo": 3,
    "characterViewSetVersion": 3,
    "characterViewKeys": ["front", "side", "back"],
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "sceneViewSetVersion": 2,
    "sceneViewKey": "front-right",
}, ensure_ascii=False)

# 场景-only 插入镜头引用（fixture 4/5）。
_REFERENCE_SCENE_ONLY_JSON = json.dumps({
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "sceneViewSetVersion": 2,
    "sceneViewKey": "front-right",
}, ensure_ascii=False)

_REFERENCE_PANORAMA_ONLY_JSON = json.dumps({
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "scenePanoramaImageId": 31,
}, ensure_ascii=False)

# 显式关闭脸部特写要求的引用快照（fixture 6）。
_REFERENCE_FACE_OFF_JSON = json.dumps({
    "characterId": 9,
    "characterVersionNo": 2,
    "characterViewSetVersion": 1,
    "characterViewKeys": ["front", "side", "back"],
    "characterBaseImageId": 71,
    "characterBaseVersionNo": 1,
    "characterFaceRequired": False,
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "sceneViewSetVersion": 2,
    "sceneViewKey": "front-right",
}, ensure_ascii=False)

# 三视图缺失侧面的引用快照（fixture 7）。
_REFERENCE_TURNAROUND_INCOMPLETE_JSON = json.dumps({
    "characterId": 9,
    "characterVersionNo": 2,
    "characterViewSetVersion": 1,
    "characterViewKeys": ["front", "back"],
    "sceneAssetId": 10,
    "scenePanoramaVersion": 3,
    "sceneViewSetVersion": 2,
    "sceneViewKey": "front-right",
}, ensure_ascii=False)

# 资产引用门禁全量 blocker 集（引用完全为空时的理论全集）。
_ASSET_GATE_ALL_BLOCKERS = [
    "character-asset-reference-missing",
    "character-version-reference-missing",
    "character-view-set-reference-missing",
    "character-view-angle-reference-incomplete",
    "character-base-image-reference-missing",
    "character-face-closeup-reference-missing",
    "scene-asset-reference-missing",
    "scene-panorama-reference-missing",
]

FIXTURES: list[dict] = [
    # ---------- Node test: asset reference gate blocks ... without locked references ----------
    {
        "name": "asset-gate-blocks-unlocked-character-and-scene-references",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"id": 1, "character_id": 9}},
        "expected_passed": False,
        "expected_blocker_codes": [
            "character-version-reference-missing",
            "character-view-set-reference-missing",
            "character-view-angle-reference-incomplete",
            "character-base-image-reference-missing",
            "character-face-closeup-reference-missing",
            "scene-asset-reference-missing",
            "scene-panorama-reference-missing",
        ],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁未通过：7 个问题需要处理",
    },
    # ---------- Node test: asset reference gate accepts a fully locked storyboard reference ----------
    {
        "name": "asset-gate-accepts-fully-locked-reference",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"asset_reference_json": _REFERENCE_FULL_JSON}},
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁通过",
        "expected_reference_items": {"sceneViewKey": "front-right"},
    },
    # ---------- Node test: asset gate accepts complete character asset board ----------
    {
        "name": "asset-gate-accepts-character-asset-board-without-split-ids",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"asset_reference_json": _REFERENCE_ASSET_PACK_JSON}},
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁通过",
    },
    # ---------- Node test: asset gate accepts a confirmed scene-only insert shot ----------
    {
        "name": "asset-gate-accepts-scene-only-insert-shot",
        "kind": "asset_reference",
        "kwargs": {
            "require_character": False,
            "storyboard": {"asset_reference_json": _REFERENCE_SCENE_ONLY_JSON},
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁通过",
    },
    # ---------- Node test: asset gate accepts scene panorama without nine-angle generation ----------
    {
        "name": "asset-gate-accepts-scene-panorama-only",
        "kind": "asset_reference",
        "kwargs": {
            "require_character": False,
            "storyboard": {"asset_reference_json": _REFERENCE_PANORAMA_ONLY_JSON},
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁通过",
        "expected_reference_items": {"scenePanoramaImageId": 31},
    },
    # ---------- Node test: no face closeup required for explicitly off-camera character ----------
    {
        "name": "asset-gate-skips-face-closeup-when-explicitly-off-camera",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"asset_reference_json": _REFERENCE_FACE_OFF_JSON}},
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁通过",
    },
    # ---------- Node test: asset gate rejects an incomplete character turnaround ----------
    {
        "name": "asset-gate-rejects-incomplete-character-turnaround",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"asset_reference_json": _REFERENCE_TURNAROUND_INCOMPLETE_JSON}},
        "expected_passed": False,
        "expected_blocker_codes": [
            "character-view-set-reference-missing",
            "character-view-angle-reference-incomplete",
            "character-base-image-reference-missing",
            "character-face-closeup-reference-missing",
        ],
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁未通过：4 个问题需要处理",
    },
    # ---------- Node test: quality gate blocks missing prompt, asset image and voice binding ----------
    {
        "name": "context-gate-blocks-missing-prompt-image-and-voice-binding",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {"id": 12, "dialogueText": "陈默：别过来。"},
            "assets": [{"id": 1, "label": "时间裂缝", "status": "confirmed"}],
        },
        "expected_passed": False,
        "expected_blocker_codes": [
            "visual-prompt-missing",
            "asset-image-missing",
            "voice-binding-missing",
        ],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检未通过：3 个问题需要处理",
    },
    # ---------- Node test: quality gate passes confirmed assets with locked voice context ----------
    {
        "name": "context-gate-passes-confirmed-assets-with-locked-voice",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "中景，陈默站在时间裂缝前，镜头缓慢推进",
                "shotType": "中景",
                "cameraAngle": "平视",
            },
            "assets": [
                {"id": 1, "label": "时间裂缝", "status": "confirmed", "imageUrl": "https://cdn.test/scene.png"}
            ],
            "character_voices": [{"characterName": "陈默", "voiceProfileKey": "male-calm"}],
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "质检通过，可以提交视频生成",
    },
    # ---------- Node test: warns when a single shot stacks too many action events ----------
    {
        "name": "context-gate-warns-on-overloaded-shot-actions",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "夜班值班台镜头",
                "actionText": "发卡滑出，标签打印，林知夏抬头，随后望向走廊。",
                "dialogueText": "（无对白）",
            },
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing", "shot-action-overloaded"],
        "expected_summary_fragment": "质检通过，但有 3 个提示",
    },
    # ---------- Node test: treats no-dialogue placeholders as silence（4 个占位符逐一覆盖） ----------
    {
        "name": "context-gate-treats-fullwidth-parenthesized-no-dialogue-as-silence",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "客厅全景，角色保持静默",
                "dialogueText": "（无对白）",
            },
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    {
        "name": "context-gate-treats-plain-no-dialogue-as-silence",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "客厅全景，角色保持静默",
                "dialogueText": "无对白",
            },
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    {
        "name": "context-gate-treats-no-lines-placeholder-as-silence",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "客厅全景，角色保持静默",
                "dialogueText": "无台词",
            },
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    {
        "name": "context-gate-treats-english-no-dialogue-as-silence",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "客厅全景，角色保持静默",
                "dialogueText": "no dialogue",
            },
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    # ---------- Node test: no voice binding validation for a no-dialogue shot ----------
    {
        "name": "context-gate-ignores-voice-bindings-for-no-dialogue-shot",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "中景，沈岚看向亮起的手机；声音：排风扇低鸣。",
                "dialogueText": "（无对白）",
            },
            "character_voices": [{"characterName": "沈岚"}],
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    # ---------- Node test: draft mode without blocking on candidate assets ----------
    {
        "name": "context-gate-draft-mode-downgrades-asset-issues-to-warnings",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {"id": 12, "visualPrompt": "远景，空旷车站"},
            "assets": [{"id": 1, "label": "车站", "status": "candidate"}],
            "require_confirmed_assets": False,
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [
            "shot-type-missing",
            "camera-angle-missing",
            "asset-image-missing",
            "asset-not-confirmed",
        ],
        "expected_summary_fragment": "质检通过，但有 4 个提示",
    },
    # ---------- Node test: accepts a reference audio binding without a preset voice ----------
    {
        "name": "context-gate-accepts-reference-audio-binding",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {
                "id": 12,
                "visualPrompt": "近景，角色压低声音说话",
                "dialogueText": "我在这里。",
            },
            "character_voices": [{"characterName": "陈默", "referenceAudioUrl": "https://cdn.test/reference.wav"}],
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    # ---------- Node test: video result gate blocks task without usable media URL ----------
    {
        "name": "video-result-gate-blocks-missing-usable-media",
        "kind": "video_result",
        "kwargs": {
            "items": [{"id": 1, "status": "candidate", "videoUrl": ""}],
            "expected_candidate_count": 1,
        },
        "expected_passed": False,
        "expected_blocker_codes": ["video-result-missing"],
        "expected_warning_codes": ["video-candidate-count-short"],
        "expected_summary_fragment": "视频结果质检未通过，请检查生成任务和媒体存储",
    },
    # ---------- Node test: video result gate records candidate shortage as warning ----------
    {
        "name": "video-result-gate-warns-on-candidate-shortage",
        "kind": "video_result",
        "kwargs": {
            "items": [{"id": 1, "status": "candidate", "videoUrl": "https://cdn.test/clip.mp4"}],
            "expected_candidate_count": 2,
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["video-candidate-count-short"],
        "expected_summary_fragment": "视频结果可用，但候选数量少于请求数量",
    },
    # ---------- 对抗样例 1：asset_reference_json 非法 JSON，解析失败降级为空引用 ----------
    {
        "name": "adversarial-invalid-asset-reference-json-falls-back-to-empty",
        "kind": "asset_reference",
        "kwargs": {"storyboard": {"asset_reference_json": "not-a-valid-json{"}},
        "expected_passed": False,
        "expected_blocker_codes": list(_ASSET_GATE_ALL_BLOCKERS),
        "expected_warning_codes": [],
        "expected_summary_fragment": "资产引用门禁未通过：8 个问题需要处理",
        "expected_reference_items": {},
    },
    # ---------- 对抗样例 2：strict 模式下私网图片地址（172.20.x.x 属 172.16-31 段）必须拒绝 ----------
    {
        "name": "adversarial-private-image-url-172-20-rejected-in-strict-mode",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {"id": 1, "visualPrompt": "内网资产镜头"},
            "assets": [
                {"id": 2, "label": "内网图", "status": "confirmed", "imageUrl": "http://172.20.1.5/img.png"}
            ],
        },
        "expected_passed": False,
        "expected_blocker_codes": ["asset-image-not-public"],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检未通过：1 个问题需要处理",
    },
    # ---------- 对抗样例 3：音色仅有 characterName 且无对白时不触发绑定检查 ----------
    {
        "name": "adversarial-voice-name-only-without-dialogue-skips-binding-check",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {"id": 3, "visualPrompt": "静默空镜"},
            "character_voices": [{"characterName": "陈默"}],
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检通过，但有 2 个提示",
    },
    # ---------- 对抗样例 3b（补充分支）：同样配置一旦出现对白则逐项阻塞 ----------
    {
        "name": "adversarial-voice-name-only-with-dialogue-blocks-per-item",
        "kind": "generation_context",
        "kwargs": {
            "storyboard": {"id": 3, "visualPrompt": "对白镜头", "dialogueText": "陈默：别过来。"},
            "character_voices": [{"characterName": "陈默"}],
        },
        "expected_passed": False,
        "expected_blocker_codes": ["voice-binding-missing"],
        "expected_warning_codes": ["shot-type-missing", "camera-angle-missing"],
        "expected_summary_fragment": "质检未通过：1 个问题需要处理",
    },
    # ---------- 对抗样例 4：expected_candidate_count=0 归一化为 1，单个可用结果即通过 ----------
    {
        "name": "adversarial-zero-expected-candidate-count-clamps-to-one",
        "kind": "video_result",
        "kwargs": {
            "items": [{"videoUrl": "https://cdn.test/v.mp4", "status": "candidate"}],
            "expected_candidate_count": 0,
        },
        "expected_passed": True,
        "expected_blocker_codes": [],
        "expected_warning_codes": [],
        "expected_summary_fragment": "视频结果已通过基础完整性检查",
    },
]
