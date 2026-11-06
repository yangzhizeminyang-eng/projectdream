﻿﻿﻿﻿﻿/**
 * @file 项目/资产组（阶段 3.5）提示词族/门禁/视图构建器期望 fixture 生成脚本（一次性 Node 脚本，CI 零依赖）。
 *
 * 直接 import Node 真实实现（server/services/*，均为纯函数模块，无 DB / 网络 /
 * 进程副作用），对多组输入形态产出期望 JSON，写入本目录 `asset_node_fixtures.json`，
 * 供 `tests/test_asset_canvas_native_compat.py` 做逐字段对照（锁定 Python 复刻
 * `app/domain/asset_prompts.py`、`app/domain/asset_canvas.py`、`app/domain/character_rename.py`）。
 *
 * 重新生成命令（在仓库根目录执行）：
 *
 *   node api-service/tests/fixtures/generate_asset_node_fixtures.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildScriptCharacterPrompt,
  buildScriptScenePrompt,
  buildSceneEnvironmentPrompt,
  buildCharacterTurnaroundPrompt,
  buildCharacterAssetPackPrompt,
  buildTemporalVariantPrompt,
  inferCharacterCostumeFromScenes,
  inferSceneLocation,
  inferSceneTimeOfDay,
  extractTemporalStates,
  isLegacyCharacterPrompt,
} from '../../../server/services/asset-character-prompt.mjs'
import {
  buildAssetNodeGenerationPrompt,
  buildAssetNodePromptSnapshot,
  buildAssetNodeViewPrompt,
  buildCharacterViewNegativePrompt,
  buildAssetNodeIdentityLock,
  resolveAssetNodeGenerationPrompt,
} from '../../../server/services/asset-node-prompt.mjs'
import {
  assetNodeImageRow,
  buildAssetCanvasView,
  deriveAssetNodeState,
  findSceneNodeMatch,
  normalizeAssetNodeLayout,
  normalizeAssetNodeType,
  summarizeAssetCanvas,
} from '../../../server/services/asset-canvas.mjs'
import {
  normalizeAssetViewItems,
  selectLatestAssetViewItems,
  validateAssetViewSet,
} from '../../../server/services/asset-view-contract.mjs'
import { buildAssetGroups } from '../../../server/services/asset-grouping.mjs'
import {
  isCharacterAssetPackRow,
  planAssetPackAdoption,
  planSingleAssetAdoption,
} from '../../../server/services/asset-pack-lifecycle.mjs'
import { buildActiveAssetNodeDedupPlan } from '../../../server/services/asset-parser-sync.mjs'
import { chooseSceneForRelink } from '../../../server/services/asset-node-relink.mjs'
import { buildSceneDisplayLabel } from '../../../server/services/scene-label.mjs'
import {
  buildPropAssetGroupKey,
  normalizeAssetGroupKey,
  resolveTemporalState,
} from '../../../server/services/asset-temporal-groups.mjs'
import {
  buildCharacterIdentityLockPrompt,
  buildCharacterIdentityLockSnapshot,
  parseCharacterIdentityLock,
  resolveCharacterReferenceSet,
} from '../../../server/services/character-identity-lock.mjs'
import {
  validateAssetImageConfirmation,
  validateCharacterAssetPackConfirmation,
  validateCharacterFaceCloseupConfirmation,
  validateCharacterTurnaroundConfirmation,
  validateCharacterViewGeneration,
  validatePropTurnaroundConfirmation,
} from '../../../server/services/asset-character-workflow.mjs'
import {
  buildSceneNineGridAnglePrompt,
  getSceneNineGridAngles,
  sceneNineGridQualityAttempts,
  validateSceneNineGridViewConfirmation,
} from '../../../server/services/scene-nine-grid.mjs'
import { buildPropAssetViewPrompt } from '../../../server/services/asset-props.mjs'
import { extractExplicitSceneFixtures } from '../../../server/services/scene-space-manifest.mjs'
import {
  extractRelatedSpeakerNames,
  transformCharacterNames,
  transformCharacterNamesJson,
} from '../../../server/services/character-rename.mjs'
import {
  inferCharacterVoiceTraits,
  normalizeCharacterAgeGroup,
  normalizeCharacterGender,
  recommendVoiceProfiles,
  resolveCharacterVoiceProfile,
  isCharacterVoiceReady,
} from '../../../server/services/voice-profiles.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 断言类 case：捕获 Node 抛错文案；无抛错时 value 为 null。 */
function attempt(fn) {
  try {
    return { raised: null, value: fn() }
  } catch (error) {
    return { raised: error instanceof Error ? error.message : String(error), value: null }
  }
}

const CHARACTER = {
  id: 9,
  project_id: 8,
  name: '林知夏',
  role_tag: '主角',
  personality: '冷静克制，观察力强',
  appearance: '28 岁女性，短发瓜子脸，灰色风衣',
  costume: '灰色长风衣，深色牛仔裤，白色运动鞋，左手无名指一枚素圈戒指',
  age_group: 'young_adult',
  gender: 'female',
  voice_style: '低沉克制的青年女声',
  status: 'draft',
}
const SCENES = [
  {
    id: 3,
    scene_no: 1,
    title: '深夜监控室',
    summary: '林知夏在合规会议室核对离职协议，随后回到深夜公寓客厅。',
    content: '【深夜 合规会议室】林知夏穿着灰色长风衣翻找档案柜。\n她佩戴着一枚同款戒指，至今留着。',
    location: null,
    time_of_day: null,
  },
]
const NINE_GRID_MANIFEST = {
  version: 1,
  anchors: [
    { id: 'A1', category: 'architecture', label: '主墙体', description: '承重主墙', relative_position: '北侧', evidence: '剧本明确', origin: 'script', narrative_reason: '' },
    { id: 'A2', category: 'fixed_furniture', label: '监控台', description: '回放设备桌', relative_position: '中西部', evidence: '剧本明确', origin: 'script', narrative_reason: '' },
    { id: 'M1', category: 'material', label: '金属墙面', description: '拉丝金属', relative_position: '墙面', evidence: '推断', origin: 'inference', narrative_reason: '机房质感' },
    { id: 'L1', category: 'light', label: '冷蓝灯带', description: '环境光', relative_position: '顶部', evidence: '推断', origin: 'inference', narrative_reason: '夜间氛围' },
  ],
  view_bindings: {
    'front-left': ['A1', 'A2'], front: ['A1', 'A2'], 'front-right': ['A1', 'A2'],
    left: ['A1', 'A2'], center: ['A1', 'A2'], right: ['A1', 'A2'],
    'back-left': ['A1', 'A2'], back: ['A1', 'A2'], 'back-right': ['A1', 'A2'],
  },
}

const cases = []

// -- asset-character-prompt.mjs ------------------------------------------------
cases.push(
  {
    name: 'script_character_prompt_full',
    group: 'buildScriptCharacterPrompt',
    input: { character: CHARACTER, scenes: SCENES, projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑' },
    expected: buildScriptCharacterPrompt({ character: CHARACTER, scenes: SCENES, projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑' }),
  },
  {
    name: 'script_character_prompt_minimal',
    group: 'buildScriptCharacterPrompt',
    input: { character: { name: '无名' }, scenes: [], projectVisualStyle: '', projectCategory: '' },
    expected: buildScriptCharacterPrompt({ character: { name: '无名' }, scenes: [], projectVisualStyle: '', projectCategory: '' }),
  },
  {
    name: 'character_turnaround_prompt',
    group: 'buildCharacterTurnaroundPrompt',
    input: { character: CHARACTER },
    expected: buildCharacterTurnaroundPrompt({ character: CHARACTER }),
  },
  {
    name: 'character_asset_pack_prompt',
    group: 'buildCharacterAssetPackPrompt',
    input: { character: CHARACTER, projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑' },
    expected: buildCharacterAssetPackPrompt({ character: CHARACTER, projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑' }),
  },
  {
    name: 'script_scene_prompt_full',
    group: 'buildScriptScenePrompt',
    input: { scene: SCENES[0], projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑', characterNames: ['林知夏'] },
    expected: buildScriptScenePrompt({ scene: SCENES[0], projectVisualStyle: '冷蓝色调科幻风', projectCategory: '都市悬疑', characterNames: ['林知夏'] }),
  },
  {
    name: 'scene_environment_prompt_full',
    group: 'buildSceneEnvironmentPrompt',
    input: { scene: { ...SCENES[0], spatial_anchors: NINE_GRID_MANIFEST }, projectVisualStyle: '冷蓝', projectCategory: '', characterNames: ['林知夏'] },
    expected: buildSceneEnvironmentPrompt({ scene: { ...SCENES[0], spatial_anchors: NINE_GRID_MANIFEST }, projectVisualStyle: '冷蓝', projectCategory: '', characterNames: ['林知夏'] }),
  },
  {
    name: 'infer_costume_from_scenes',
    group: 'inferCharacterCostumeFromScenes',
    input: { scenes: SCENES, characterName: '林知夏' },
    expected: inferCharacterCostumeFromScenes(SCENES, '林知夏'),
  },
  {
    name: 'infer_scene_location_explicit',
    group: 'inferSceneLocation',
    input: { scene: { location: '城西殡仪馆' } },
    expected: inferSceneLocation({ location: '城西殡仪馆' }),
  },
  {
    name: 'infer_scene_location_meeting_room',
    group: 'inferSceneLocation',
    input: { scene: { content: '会议室里摆着离职协议' } },
    expected: inferSceneLocation({ content: '会议室里摆着离职协议' }),
  },
  {
    name: 'infer_scene_time_deep_night',
    group: 'inferSceneTimeOfDay',
    input: { scene: { content: '深夜的机房嗡鸣' } },
    expected: inferSceneTimeOfDay({ content: '深夜的机房嗡鸣' }),
  },
  {
    name: 'temporal_states',
    group: 'extractTemporalStates',
    input: { scenes: SCENES, characterName: '林知夏' },
    expected: extractTemporalStates(SCENES, '林知夏'),
  },
  {
    name: 'temporal_variant_prompt',
    group: 'buildTemporalVariantPrompt',
    input: { basePrompt: '基础提示词', stateLabel: '五年前' },
    expected: buildTemporalVariantPrompt('基础提示词', '五年前'),
  },
  {
    name: 'legacy_prompt_true',
    group: 'isLegacyCharacterPrompt',
    input: { prompt: '固定服装与随身物件：手机的手，翻找杯垫' },
    expected: isLegacyCharacterPrompt('固定服装与随身物件：手机的手，翻找杯垫'),
  },
  {
    name: 'legacy_prompt_false_user_edit',
    group: 'isLegacyCharacterPrompt',
    input: { prompt: '自定义的外貌描述' },
    expected: isLegacyCharacterPrompt('自定义的外貌描述'),
  },
)

// -- asset-node-prompt.mjs ------------------------------------------------------
const PROMPT_NODE = {
  id: 12,
  node_type: 'character',
  label: '林知夏',
  appearance_label: '十八年前',
  prompt_text: '固定外貌：28 岁女性，短发瓜子脸。',
  turnaround_prompt_text: '',
  environment_prompt_text: '',
  negative_prompt: '剧情负面词：机房、代码',
}
cases.push(
  {
    name: 'node_generation_prompt_character',
    group: 'buildAssetNodeGenerationPrompt',
    input: { node: PROMPT_NODE, character: CHARACTER, projectVisualStyle: '冷蓝', appearanceLocked: false },
    expected: buildAssetNodeGenerationPrompt({
      node: { ...PROMPT_NODE, promptText: PROMPT_NODE.prompt_text },
      character: CHARACTER,
      projectVisualStyle: '冷蓝',
      appearanceLocked: false,
    }),
  },
  {
    name: 'node_generation_prompt_empty_returns_null',
    group: 'buildAssetNodeGenerationPrompt',
    input: { node: { node_type: 'character', label: '空' }, character: null, projectVisualStyle: '', appearanceLocked: false },
    expected: buildAssetNodeGenerationPrompt({
      node: { nodeType: 'character', label: '空', promptText: '', environmentPromptText: '', appearanceLabel: '', negativePrompt: '' },
      character: null,
      projectVisualStyle: '',
      appearanceLocked: false,
    }),
  },
  {
    name: 'node_generation_prompt_scene_uses_environment',
    group: 'buildAssetNodeGenerationPrompt',
    input: { node: { node_type: 'scene', prompt_text: '剧本提示词', environment_prompt_text: '环境提示词' }, character: null, projectVisualStyle: '', appearanceLocked: false },
    expected: buildAssetNodeGenerationPrompt({
      node: { nodeType: 'scene', promptText: '剧本提示词', environmentPromptText: '环境提示词', label: '', appearanceLabel: '', negativePrompt: '' },
      character: null,
      projectVisualStyle: '',
      appearanceLocked: false,
    }),
  },
  {
    name: 'node_prompt_snapshot',
    group: 'buildAssetNodePromptSnapshot',
    input: { node: PROMPT_NODE, character: CHARACTER, projectVisualStyle: '冷蓝', appearanceLocked: true },
    expected: buildAssetNodePromptSnapshot({
      node: { ...PROMPT_NODE, promptText: PROMPT_NODE.prompt_text },
      character: CHARACTER,
      projectVisualStyle: '冷蓝',
      appearanceLocked: true,
    }),
  },
  {
    name: 'node_identity_lock_locked',
    group: 'buildAssetNodeIdentityLock',
    input: { character: CHARACTER, appearanceLabel: '十八年前', appearanceLocked: true },
    expected: buildAssetNodeIdentityLock({ character: CHARACTER, appearanceLabel: '十八年前', appearanceLocked: true }),
  },
  {
    name: 'resolve_generation_prompt_scene_single_prefers_environment',
    group: 'resolveAssetNodeGenerationPrompt',
    input: { node: { nodeType: 'scene', promptText: '剧本', environmentPromptText: '环境' }, requestedViewType: 'single', promptOverride: '覆盖词' },
    expected: resolveAssetNodeGenerationPrompt({
      node: { nodeType: 'scene', promptText: '剧本', environmentPromptText: '环境' },
      requestedViewType: 'single',
      promptOverride: '覆盖词',
    }),
  },
  {
    name: 'view_prompt_turnaround_front',
    group: 'buildAssetNodeViewPrompt',
    input: { viewType: 'character-turnaround', viewKey: 'front' },
    expected: attempt(() => buildAssetNodeViewPrompt({
      node: { ...PROMPT_NODE, promptText: PROMPT_NODE.prompt_text },
      character: CHARACTER,
      projectVisualStyle: '冷蓝',
      appearanceLocked: false,
      viewType: 'character-turnaround',
      viewKey: 'front',
      referenceImageUrl: '',
      baseReferenceImageUrl: 'https://media.example.com/base.png',
    })),
  },
  {
    name: 'view_prompt_turnaround_requires_base',
    group: 'buildAssetNodeViewPrompt',
    input: { viewType: 'character-turnaround', viewKey: 'front', noBase: true },
    expected: attempt(() => buildAssetNodeViewPrompt({
      node: { ...PROMPT_NODE, promptText: PROMPT_NODE.prompt_text },
      character: CHARACTER,
      projectVisualStyle: '',
      appearanceLocked: false,
      viewType: 'character-turnaround',
      viewKey: 'front',
      referenceImageUrl: '',
      baseReferenceImageUrl: '',
    })),
  },
  {
    name: 'view_prompt_face_closeup',
    group: 'buildAssetNodeViewPrompt',
    input: { viewType: 'character-face-closeup' },
    expected: attempt(() => buildAssetNodeViewPrompt({
      node: { ...PROMPT_NODE, promptText: PROMPT_NODE.prompt_text },
      character: CHARACTER,
      projectVisualStyle: '',
      appearanceLocked: false,
      viewType: 'character-face-closeup',
      viewKey: '',
      referenceImageUrl: '',
      baseReferenceImageUrl: 'https://media.example.com/base.png',
    })),
  },
  {
    name: 'view_prompt_prop_turnaround_side',
    group: 'buildAssetNodeViewPrompt',
    input: { viewType: 'prop-turnaround', viewKey: 'side' },
    expected: attempt(() => buildAssetNodeViewPrompt({
      node: { nodeType: 'prop', label: '老式工牌', promptText: '塑料外壳的工牌' },
      character: null,
      projectVisualStyle: '',
      appearanceLocked: false,
      viewType: 'prop-turnaround',
      viewKey: 'side',
      referenceImageUrl: 'https://media.example.com/prop.png',
      baseReferenceImageUrl: '',
    })),
  },
  {
    name: 'view_prompt_scene_nine_grid_center',
    group: 'buildAssetNodeViewPrompt',
    input: { viewType: 'scene-nine-grid', viewKey: 'center' },
    expected: attempt(() => buildAssetNodeViewPrompt({
      node: { nodeType: 'scene', promptText: '空间结构', environmentPromptText: '环境锚点' },
      character: null,
      projectVisualStyle: '冷蓝',
      appearanceLocked: false,
      viewType: 'scene-nine-grid',
      viewKey: 'center',
      referenceImageUrl: 'https://media.example.com/panorama.png',
      baseReferenceImageUrl: '',
    })),
  },
  {
    name: 'character_view_negative_prompt_front_noface',
    group: 'buildCharacterViewNegativePrompt',
    input: { viewKey: 'front', noFace: true },
    expected: buildCharacterViewNegativePrompt('front', { noFace: true }),
  },
  {
    name: 'character_view_negative_prompt_back',
    group: 'buildCharacterViewNegativePrompt',
    input: { viewKey: 'back', noFace: false },
    expected: buildCharacterViewNegativePrompt('back', { noFace: false }),
  },
)

// -- scene-nine-grid / asset-props / scene-space-manifest ----------------------
cases.push(
  {
    name: 'scene_nine_grid_angle_prompt_front',
    group: 'buildSceneNineGridAnglePrompt',
    input: { angle: 'front-left' },
    expected: attempt(() => buildSceneNineGridAnglePrompt({
      angle: 'front-left',
      panorama: 'https://media.example.com/panorama.png',
      spatialAnchors: NINE_GRID_MANIFEST,
    })),
  },
  {
    name: 'scene_nine_grid_angles_order',
    group: 'getSceneNineGridAngles',
    input: {},
    expected: getSceneNineGridAngles(),
  },
  {
    name: 'scene_nine_grid_quality_attempts',
    group: 'sceneNineGridQualityAttempts',
    input: { value: 9, fallback: 5 },
    expected: sceneNineGridQualityAttempts(9, 5),
  },
  {
    name: 'prop_view_prompt_front',
    group: 'buildPropAssetViewPrompt',
    input: { prop: { name: '老式工牌', details: '塑料外壳' }, viewKey: 'top' },
    expected: attempt(() => buildPropAssetViewPrompt({ prop: { name: '老式工牌', details: '塑料外壳' }, viewKey: 'top' })),
  },
  {
    name: 'explicit_scene_fixtures',
    group: 'extractExplicitSceneFixtures',
    input: { scene: { title: '夜班', summary: '值班台右侧有台灯，走廊尽头是绿色安全出口灯。' } },
    expected: extractExplicitSceneFixtures({ title: '夜班', summary: '值班台右侧有台灯，走廊尽头是绿色安全出口灯。' }),
  },
)

// -- asset-canvas.mjs ----------------------------------------------------------
const NODE_ROW = {
  id: 12, project_id: 8, node_type: 'character', ref_id: 9, label: '林知夏',
  appearance_label: null, prompt_text: '提示词', turnaround_prompt_text: '',
  environment_prompt_text: '', negative_prompt: '', x: 10.567, y: -20,
  width: 999, height: 0, group_key: 'character:9', status: 'active',
}
const IMAGE_ROW = {
  id: 105, asset_node_id: 12, version_no: 3, image_url: 'https://media.example.com/char.png',
  storage_key: 'asset-nodes/12/v3.png', thumbnail_url: null, prompt_snapshot: '快照',
  model_name: 'agnes-image-2.1-flash', view_set_type: 'character-asset-pack',
  view_set_version: 2, view_index: null, view_key: null, view_label: null,
  source_image_id: null, source_image_url: null, crop_json: null,
  character_identity_lock_json: '{"schemaVersion":1}', identity_status: 'passed',
  identity_reason: null, identity_similarity_score: 0.87, wardrobe_consistency_score: 0.91,
  vision_status: 'passed', vision_reason: null, vision_checked_at: '2026-10-17T10:00:00',
  status: 'confirmed', confirmed_at: '2026-10-17T11:00:00', created_at: '2026-10-17T09:00:00',
}
cases.push(
  {
    name: 'asset_node_image_row',
    group: 'assetNodeImageRow',
    input: { row: IMAGE_ROW },
    expected: assetNodeImageRow(IMAGE_ROW),
  },
  {
    name: 'normalize_asset_node_type',
    group: 'normalizeAssetNodeType',
    input: { value: ' TOOL ' },
    expected: normalizeAssetNodeType(' TOOL '),
  },
  {
    name: 'normalize_asset_node_layout_clamps',
    group: 'normalizeAssetNodeLayout',
    input: { x: 10.567, y: -20, width: 999, height: 0 },
    expected: normalizeAssetNodeLayout({ x: 10.567, y: -20, width: 999, height: 0 }),
  },
  {
    name: 'derive_node_state_confirmed',
    group: 'deriveAssetNodeState',
    input: { images: [assetNodeImageRow(IMAGE_ROW)] },
    expected: deriveAssetNodeState([assetNodeImageRow(IMAGE_ROW)], 'character'),
  },
  {
    name: 'find_scene_node_match_by_label',
    group: 'findSceneNodeMatch',
    input: { node: { node_type: 'scene', label: '深夜监控室' }, scenes: SCENES },
    expected: findSceneNodeMatch({ nodeType: 'scene', label: '深夜监控室' }, SCENES),
  },
  {
    name: 'find_scene_node_match_ambiguous_scene_no',
    group: 'findSceneNodeMatch',
    input: { node: { node_type: 'scene', label: '场景01' }, scenes: [...SCENES, { ...SCENES[0], id: 4, scene_no: 1 }] },
    expected: findSceneNodeMatch({ nodeType: 'scene', label: '场景01' }, [...SCENES, { ...SCENES[0], id: 4, scene_no: 1 }]),
  },
  {
    name: 'summarize_asset_canvas',
    group: 'summarizeAssetCanvas',
    input: { nodes: [{ nodeType: 'character', state: 'confirmed' }, { nodeType: 'scene', state: 'ready' }, { nodeType: 'prop' }] },
    expected: summarizeAssetCanvas([{ nodeType: 'character', state: 'confirmed' }, { nodeType: 'scene', state: 'ready' }, { nodeType: 'prop' }]),
  },
  {
    name: 'build_asset_canvas_view_full',
    group: 'buildAssetCanvasView',
    input: { projectId: 8, nodes: [NODE_ROW], images: [assetNodeImageRow(IMAGE_ROW)] },
    expected: buildAssetCanvasView({ projectId: 8, nodes: [NODE_ROW], images: [assetNodeImageRow(IMAGE_ROW)] }),
  },
  {
    name: 'build_asset_groups',
    group: 'buildAssetGroups',
    input: { nodes: [NODE_ROW] },
    expected: buildAssetGroups([{ ...NODE_ROW, nodeType: 'character' }]),
  },
  {
    name: 'validate_view_set_turnaround_missing',
    group: 'validateAssetViewSet',
    input: { viewSetType: 'character-turnaround', items: [] },
    expected: (() => {
      const report = validateAssetViewSet({ viewSetType: 'character-turnaround', items: [], requireConfirmed: true })
      return { ready: report.ready, blockers: report.blockers, missing: report.missing }
    })(),
  },
  {
    name: 'select_latest_view_items_retry_preferred',
    group: 'selectLatestAssetViewItems',
    input: { items: [
      { imageId: 1, viewSetType: 'character-turnaround', viewSetVersion: 1, viewIndex: 1, viewKey: 'front', status: 'confirmed' },
      { imageId: 2, viewSetType: 'character-turnaround', viewSetVersion: 2, viewIndex: 1, viewKey: 'front', status: 'candidate' },
    ] },
    expected: selectLatestAssetViewItems([
      { imageId: 1, viewSetType: 'character-turnaround', viewSetVersion: 1, viewIndex: 1, viewKey: 'front', status: 'confirmed' },
      { imageId: 2, viewSetType: 'character-turnaround', viewSetVersion: 2, viewIndex: 1, viewKey: 'front', status: 'candidate' },
    ]),
  },
  {
    name: 'normalize_asset_view_items_drops_partial',
    group: 'normalizeAssetViewItems',
    input: { items: [{ imageId: 1, viewIndex: null, viewKey: 'front' }] },
    expected: normalizeAssetViewItems([{ imageId: 1, viewIndex: null, viewKey: 'front' }]),
  },
)

// -- asset-pack-lifecycle / asset-parser-sync / asset-node-relink ---------------
cases.push(
  {
    name: 'is_pack_row_single_label',
    group: 'isCharacterAssetPackRow',
    input: { view_set_type: 'single', view_label: '角色资产板' },
    expected: isCharacterAssetPackRow({ view_set_type: 'single', view_label: '角色资产板' }),
  },
  {
    name: 'is_pack_row_plain_single_false',
    group: 'isCharacterAssetPackRow',
    input: { view_set_type: 'single', view_label: '正面' },
    expected: isCharacterAssetPackRow({ view_set_type: 'single', view_label: '正面' }),
  },
  {
    name: 'plan_asset_pack_adoption_ready',
    group: 'planAssetPackAdoption',
    input: { candidates: [{ id: 105, view_set_type: 'character-asset-pack', status: 'candidate', vision_status: 'passed' }], existing: [{ id: 100, status: 'confirmed' }] },
    expected: planAssetPackAdoption(
      [{ id: 105, view_set_type: 'character-asset-pack', status: 'candidate', vision_status: 'passed' }],
      [{ id: 100, status: 'confirmed' }],
    ),
  },
  {
    name: 'plan_asset_pack_adoption_vision_pending',
    group: 'planAssetPackAdoption',
    input: { candidates: [{ id: 105, view_set_type: 'character-asset-pack', status: 'candidate', vision_status: 'pending' }], existing: [] },
    expected: planAssetPackAdoption([{ id: 105, view_set_type: 'character-asset-pack', status: 'candidate', vision_status: 'pending' }], []),
  },
  {
    name: 'plan_single_asset_adoption',
    group: 'planSingleAssetAdoption',
    input: { candidate: { id: 77, status: 'candidate', vision_status: 'passed' }, existing: [{ id: 70, status: 'confirmed' }] },
    expected: planSingleAssetAdoption({ id: 77, status: 'candidate', vision_status: 'passed' }, [{ id: 70, status: 'confirmed' }]),
  },
  {
    name: 'dedup_plan_keeps_image_heaviest',
    group: 'buildActiveAssetNodeDedupPlan',
    input: { nodes: [
      { id: 3, node_type: 'scene', ref_id: 5, status: 'active', imageCount: 0 },
      { id: 2, node_type: 'scene', ref_id: 5, status: 'active', imageCount: 4 },
      { id: 9, node_type: 'character', ref_id: null, group_key: '', status: 'active' },
    ] },
    expected: buildActiveAssetNodeDedupPlan([
      { id: 3, node_type: 'scene', ref_id: 5, status: 'active', imageCount: 0 },
      { id: 2, node_type: 'scene', ref_id: 5, status: 'active', imageCount: 4 },
      { id: 9, node_type: 'character', ref_id: null, group_key: '', status: 'active' },
    ]),
  },
  {
    name: 'choose_scene_for_relink_by_id',
    group: 'chooseSceneForRelink',
    input: { requestedSceneId: 3, scenes: SCENES },
    expected: chooseSceneForRelink({ requestedSceneId: 3, requestedLabel: '', scenes: SCENES }),
  },
  {
    name: 'choose_scene_for_relink_by_location',
    group: 'chooseSceneForRelink',
    input: { requestedLabel: '深夜公寓客厅', scenes: [...SCENES, { id: 4, title: '客厅', location: '深夜公寓客厅', summary: '' }] },
    expected: chooseSceneForRelink({ requestedSceneId: null, requestedLabel: '深夜公寓客厅', scenes: [...SCENES, { id: 4, title: '客厅', location: '深夜公寓客厅', summary: '' }] }),
  },
)

// -- scene-label / asset-temporal-groups ---------------------------------------
cases.push(
  {
    name: 'scene_display_label',
    group: 'buildSceneDisplayLabel',
    input: { scene: SCENES[0] },
    expected: buildSceneDisplayLabel(SCENES[0]),
  },
  {
    name: 'scene_display_label_unnumbered',
    group: 'buildSceneDisplayLabel',
    input: { scene: { title: '尾声', summary: '签字前，电脑屏幕亮起邮件。' } },
    expected: buildSceneDisplayLabel({ title: '尾声', summary: '签字前，电脑屏幕亮起邮件。' }),
  },
  {
    name: 'normalize_group_key_short',
    group: 'normalizeAssetGroupKey',
    input: { value: ' character:9 ' },
    expected: normalizeAssetGroupKey(' character:9 '),
  },
  {
    name: 'normalize_group_key_long_hashed',
    group: 'normalizeAssetGroupKey',
    input: { value: 'x'.repeat(300) },
    expected: normalizeAssetGroupKey('x'.repeat(300)),
  },
  {
    name: 'temporal_state_explicit_line',
    group: 'resolveTemporalState',
    input: { prompt: '角色提示词\n本资产时空状态：五年前的老陈' },
    expected: resolveTemporalState('角色提示词\n本资产时空状态：五年前的老陈'),
  },
  {
    name: 'prop_group_key',
    group: 'buildPropAssetGroupKey',
    input: { projectId: 8, name: '工牌' },
    expected: buildPropAssetGroupKey({ projectId: 8, name: '工牌' }),
  },
)

// -- character-identity-lock ----------------------------------------------------
const REFERENCE_IMAGES = [
  { id: 101, view_set_type: 'single', status: 'confirmed', vision_status: 'passed', image_url: 'https://media.example.com/base.png', storage_key: 'k1.png' },
  { id: 102, view_set_type: 'character-face-closeup', view_key: 'face', status: 'confirmed', vision_status: 'passed', image_url: 'https://media.example.com/face.png', storage_key: 'k2.png' },
  { id: 103, view_set_type: 'character-turnaround', view_key: 'front', status: 'confirmed', vision_status: 'passed', image_url: 'https://media.example.com/front.png', storage_key: 'k3.png' },
  { id: 104, view_set_type: 'character-turnaround', view_key: 'front', status: 'confirmed', vision_status: 'passed', image_url: 'https://media.example.com/front-old.png', storage_key: 'k4.png' },
  { id: 105, view_set_type: 'single', status: 'candidate', vision_status: 'pending', image_url: 'https://media.example.com/x.png', storage_key: '' },
]
cases.push(
  {
    name: 'character_reference_set_order',
    group: 'resolveCharacterReferenceSet',
    input: { images: REFERENCE_IMAGES },
    expected: resolveCharacterReferenceSet(REFERENCE_IMAGES),
  },
  {
    name: 'identity_lock_snapshot',
    group: 'buildCharacterIdentityLockSnapshot',
    input: { character: CHARACTER, baseImage: REFERENCE_IMAGES[0], referenceSet: resolveCharacterReferenceSet(REFERENCE_IMAGES) },
    expected: buildCharacterIdentityLockSnapshot({
      character: CHARACTER,
      baseImage: REFERENCE_IMAGES[0],
      referenceSet: resolveCharacterReferenceSet(REFERENCE_IMAGES),
    }),
  },
  {
    name: 'identity_lock_prompt',
    group: 'buildCharacterIdentityLockPrompt',
    input: { snapshot: buildCharacterIdentityLockSnapshot({ character: CHARACTER, baseImage: REFERENCE_IMAGES[0], referenceSet: resolveCharacterReferenceSet(REFERENCE_IMAGES) }), requestedAngle: '正面' },
    expected: buildCharacterIdentityLockPrompt(
      buildCharacterIdentityLockSnapshot({ character: CHARACTER, baseImage: REFERENCE_IMAGES[0], referenceSet: resolveCharacterReferenceSet(REFERENCE_IMAGES) }),
      '正面',
    ),
  },
  {
    name: 'identity_lock_parse_invalid',
    group: 'parseCharacterIdentityLock',
    input: { value: 'not-json' },
    expected: parseCharacterIdentityLock('not-json'),
  },
)

// -- asset-character-workflow 门禁 ------------------------------------------------
cases.push(
  {
    name: 'gate_pack_vision_pending',
    group: 'validateCharacterAssetPackConfirmation',
    input: { viewType: 'character-asset-pack', imageStatus: 'candidate', visionStatus: 'pending', imageUrl: 'https://x/y.png', modelName: 'agnes' },
    expected: validateCharacterAssetPackConfirmation({ viewType: 'character-asset-pack', imageStatus: 'candidate', visionStatus: 'pending', imageUrl: 'https://x/y.png', modelName: 'agnes' }),
  },
  {
    name: 'gate_pack_not_real',
    group: 'validateCharacterAssetPackConfirmation',
    input: { viewType: 'character-asset-pack', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/mock-assets/y.png', modelName: 'mock-frame-v1' },
    expected: validateCharacterAssetPackConfirmation({ viewType: 'character-asset-pack', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/mock-assets/y.png', modelName: 'mock-frame-v1' }),
  },
  {
    name: 'gate_turnaround_identity_failed',
    group: 'validateCharacterTurnaroundConfirmation',
    input: { viewType: 'character-turnaround', viewKey: 'side', imageStatus: 'candidate', visionStatus: 'passed', identityStatus: 'failed', identityReason: '发型漂移' },
    expected: validateCharacterTurnaroundConfirmation({ viewType: 'character-turnaround', viewKey: 'side', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes', identityStatus: 'failed', identityReason: '发型漂移' }),
  },
  {
    name: 'gate_turnaround_bad_angle',
    group: 'validateCharacterTurnaroundConfirmation',
    input: { viewType: 'character-turnaround', viewKey: 'three-quarter', imageStatus: 'candidate', visionStatus: 'passed' },
    expected: validateCharacterTurnaroundConfirmation({ viewType: 'character-turnaround', viewKey: 'three-quarter', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes', identityStatus: 'passed', identityReason: null }),
  },
  {
    name: 'gate_face_closeup_pending_identity',
    group: 'validateCharacterFaceCloseupConfirmation',
    input: { viewType: 'character-face-closeup', viewKey: 'face', imageStatus: 'candidate', visionStatus: 'passed', identityStatus: 'pending', identityReason: null },
    expected: validateCharacterFaceCloseupConfirmation({ viewType: 'character-face-closeup', viewKey: 'face', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes', identityStatus: 'pending', identityReason: null }),
  },
  {
    name: 'gate_asset_scene_skipped_requires_real',
    group: 'validateAssetImageConfirmation',
    input: { nodeType: 'scene', viewType: 'single', imageStatus: 'candidate', visionStatus: 'skipped', imageUrl: 'https://x/mock-assets/y.png', modelName: 'mock-frame-v1' },
    expected: validateAssetImageConfirmation({ nodeType: 'scene', viewType: 'single', imageStatus: 'candidate', visionStatus: 'skipped', imageUrl: 'https://x/mock-assets/y.png', modelName: 'mock-frame-v1' }),
  },
  {
    name: 'gate_asset_prop_vision_failed',
    group: 'validateAssetImageConfirmation',
    input: { nodeType: 'prop', viewType: 'single', imageStatus: 'candidate', visionStatus: 'failed', imageUrl: 'https://x/y.png', modelName: 'agnes' },
    expected: validateAssetImageConfirmation({ nodeType: 'prop', viewType: 'single', imageStatus: 'candidate', visionStatus: 'failed', imageUrl: 'https://x/y.png', modelName: 'agnes' }),
  },
  {
    name: 'gate_prop_turnaround_top',
    group: 'validatePropTurnaroundConfirmation',
    input: { nodeType: 'prop', viewType: 'prop-turnaround', viewKey: 'top', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes' },
    expected: validatePropTurnaroundConfirmation({ nodeType: 'prop', viewType: 'prop-turnaround', viewKey: 'top', imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes' }),
  },
  {
    name: 'gate_character_view_generation_no_base',
    group: 'validateCharacterViewGeneration',
    input: { nodeType: 'character', viewType: 'character-turnaround', images: [] },
    expected: validateCharacterViewGeneration({ nodeType: 'character', viewType: 'character-turnaround', images: [] }),
  },
  {
    name: 'gate_character_view_generation_no_face',
    group: 'validateCharacterViewGeneration',
    input: { nodeType: 'character', viewType: 'character-turnaround', images: REFERENCE_IMAGES },
    expected: validateCharacterViewGeneration({ nodeType: 'character', viewType: 'character-turnaround', images: REFERENCE_IMAGES }),
  },
  {
    name: 'gate_scene_nine_grid_view_ok',
    group: 'validateSceneNineGridViewConfirmation',
    input: { viewKey: 'center', sourceImageId: 201, imageStatus: 'candidate', visionStatus: 'skipped', imageUrl: 'https://x/y.png', modelName: 'agnes' },
    expected: validateSceneNineGridViewConfirmation({ viewKey: 'center', crop: null, sourceImageId: 201, imageStatus: 'candidate', visionStatus: 'skipped', imageUrl: 'https://x/y.png', modelName: 'agnes' }),
  },
  {
    name: 'gate_scene_nine_grid_view_missing_angle',
    group: 'validateSceneNineGridViewConfirmation',
    input: { viewKey: null, sourceImageId: null, imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes' },
    expected: validateSceneNineGridViewConfirmation({ viewKey: null, crop: null, sourceImageId: null, imageStatus: 'candidate', visionStatus: 'passed', imageUrl: 'https://x/y.png', modelName: 'agnes' }),
  },
)

// -- character-rename -----------------------------------------------------------
cases.push(
  {
    name: 'rename_transform_text',
    group: 'transformCharacterNames',
    input: { value: '林知夏走进监控室。林知夏看着屏幕。', sourceNames: ['林知夏', '林默'], newName: '夏知林' },
    expected: transformCharacterNames('林知夏走进监控室。林知夏看着屏幕。', ['林知夏', '林默'], '夏知林'),
  },
  {
    name: 'rename_transform_json_values_only',
    group: 'transformCharacterNamesJson',
    input: { rawJson: '{"a":"林知夏","林知夏":1,"b":["林默","林知夏"]}', sourceNames: ['林知夏', '林默'], newName: '夏知林' },
    expected: transformCharacterNamesJson('{"a":"林知夏","林知夏":1,"b":["林默","林知夏"]}', ['林知夏', '林默'], '夏知林'),
  },
  {
    name: 'rename_transform_invalid_json',
    group: 'transformCharacterNamesJson',
    input: { rawJson: '{oops', sourceNames: ['林知夏'], newName: '夏知林' },
    expected: transformCharacterNamesJson('{oops', ['林知夏'], '夏知林'),
  },
  {
    name: 'rename_related_speakers',
    group: 'extractRelatedSpeakerNames',
    input: { textValues: ['林知夏：进来。', '小林：好。', '陈默：不要。'], currentName: '林知夏', reservedNames: ['陈默'] },
    expected: extractRelatedSpeakerNames(['林知夏：进来。', '小林：好。', '陈默：不要。'], '林知夏', ['陈默']),
  },
)

// -- voice-profiles ---------------------------------------------------------------
const VOICE_ROW = {
  profile_key: 'female-young-warm', display_name: '亲切青年女声', provider: 'dashscope',
  model_name: 'qwen3-tts-flash', voice_id: 'Cherry', gender: 'female', age_groups: 'young_adult',
  style_tags: '阳光,亲切,自然', description: '适合 19-35 岁青年女性。', instructions: '',
  language_type: 'Chinese', status: 'active', sort_order: 90,
}
const VOICE_ROW_MALE = {
  profile_key: 'male-adult-calm', display_name: '冷静成年男声', provider: 'dashscope',
  model_name: 'qwen3-tts-instruct-flash', voice_id: 'Moon', gender: 'male', age_groups: 'young_adult,middle_aged',
  style_tags: '冷静,克制,理性', description: '', instructions: '请使用30至45岁成年男性的自然声线。',
  language_type: 'Chinese', status: 'active', sort_order: 40,
}
cases.push(
  {
    name: 'voice_traits',
    group: 'inferCharacterVoiceTraits',
    input: { character: CHARACTER },
    expected: inferCharacterVoiceTraits(CHARACTER),
  },
  {
    name: 'voice_recommend_top',
    group: 'recommendVoiceProfiles',
    input: { character: CHARACTER, profiles: [VOICE_ROW, VOICE_ROW_MALE], limit: 3 },
    expected: recommendVoiceProfiles(CHARACTER, [VOICE_ROW, VOICE_ROW_MALE], 3),
  },
  {
    name: 'voice_resolve_gender_conflict',
    group: 'resolveCharacterVoiceProfile',
    input: { character: CHARACTER, profiles: [VOICE_ROW_MALE], requestedProfileKey: 'male-adult-calm' },
    expected: resolveCharacterVoiceProfile({ character: CHARACTER, profiles: [VOICE_ROW_MALE], requestedProfileKey: 'male-adult-calm' }),
  },
  {
    name: 'voice_ready_profile',
    group: 'isCharacterVoiceReady',
    input: { character: { voice_locked: 1, voice_profile_key: 'female-young-warm' }, selectedProfile: VOICE_ROW },
    expected: isCharacterVoiceReady({ voice_locked: 1, voice_profile_key: 'female-young-warm' }, VOICE_ROW),
  },
  {
    name: 'voice_ready_designed',
    group: 'isCharacterVoiceReady',
    input: { character: { voice_locked: 1, voice_setting: 'v-custom', voice_design_json: '{"provider":"qwen","voiceId":"v-custom","targetModel":"voice-enrollment"}' }, selectedProfile: null },
    expected: isCharacterVoiceReady({ voice_locked: 1, voice_setting: 'v-custom', voice_design_json: '{"provider":"qwen","voiceId":"v-custom","targetModel":"voice-enrollment"}' }, null),
  },
  {
    name: 'normalize_age_group',
    group: 'normalizeCharacterAgeGroup',
    input: { value: ' TEEN ' },
    expected: normalizeCharacterAgeGroup(' TEEN '),
  },
  {
    name: 'normalize_gender_invalid',
    group: 'normalizeCharacterGender',
    input: { value: 'robot' },
    expected: normalizeCharacterGender('robot'),
  },
)

const output = { generatedAt: 'fixture', cases }
writeFileSync(join(here, 'asset_node_fixtures.json'), JSON.stringify(output, null, 2), 'utf8')
console.log(`wrote ${cases.length} cases to asset_node_fixtures.json`)
