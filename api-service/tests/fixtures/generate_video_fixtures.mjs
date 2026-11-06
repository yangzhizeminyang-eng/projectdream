/**
 * @file 视频生成入队快照构建器期望 fixture 生成脚本（一次性 Node 脚本，CI 零依赖）。
 *
 * 直接 import Node 真实实现（server/services/*，均为纯函数模块，无 DB / 网络 /
 * 进程副作用），对约 50 种输入形态产出入队快照构建器的期望 JSON，写入本目录
 * `video_generation_fixtures.json`，供 `tests/test_generation_native_compat.py`
 * 做逐字段对照（锁定 Python 复刻 `app/domain/video_generation.py`）。
 *
 * 不覆盖项（Node 实现在 index.mjs 内部，import 会启动服务器，fixture 无法直调）：
 * buildTwoKeyframeVideoPrompt / buildReferenceAudioPromptContext /
 * resolveReferenceAudioUrl——由 pytest 侧手工对照用例锁定。
 *
 * 重新生成命令（在仓库根目录执行）：
 *
 *   node api-service/tests/fixtures/generate_video_fixtures.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  shouldUseStoryboardContinuity,
  resolveContinuitySourceShotNo,
  buildStoryboardFrameReference,
  buildStoryboardContinuityPrompt,
} from '../../../server/services/storyboard-continuity.mjs'
import {
  normalizeStoryboardMentionContext,
  buildMentionContextPrompt,
} from '../../../server/services/storyboard-mention-context.mjs'
import {
  buildReferencedAssetPromptContext,
  buildStoryboardReferenceSnapshot,
  validateStoryboardReferenceSnapshot,
} from '../../../server/services/storyboard-asset-references.mjs'
import {
  hasUnifiedStoryboardPrompt,
  buildStoryboardVideoPromptParts,
  buildVideoReferenceImageGuide,
  buildStoryboardDirectionPrompt,
} from '../../../server/services/video-generation-request.mjs'
import { buildStoryboardPerformancePrompt } from '../../../server/services/storyboard-performance.mjs'
import {
  assertVideoModelProvider,
  buildVideoContinuityConstraints,
} from '../../../server/services/video.mjs'
import { buildColorContinuityConstraints } from '../../../server/services/color-continuity.mjs'
import { inspectStoryboardGenerationContext } from '../../../server/services/agent/quality-gate.mjs'
import { inferVideoCandidateExpectations } from '../../../server/services/video-candidate-inspection.mjs'
import {
  buildLipSyncPrompt,
  resolveLipSyncDuration,
  resolveDashScopeLipSyncDuration,
} from '../../../server/services/lip-sync.mjs'
import { sanitizeStoryboardPrompt } from '../../../server/services/storyboard-prompt-sanitizer.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 统一去掉时间戳字段（Node/Python 执行时钟不同，不参与对照）。 */
function stripCheckedAt(report) {
  const { checkedAt, ...rest } = report
  void checkedAt
  return rest
}

/** 断言类 case：捕获 Node 抛错文案；无抛错时 value 为 null。 */
function attempt(fn) {
  try {
    return { raised: null, value: fn() }
  } catch (error) {
    return { raised: error instanceof Error ? error.message : String(error), value: null }
  }
}

const cases = []

// -- storyboard-prompt-sanitizer.mjs ---------------------------------------
cases.push(
  {
    name: 'sanitize_prompt_strips_template_tail',
    group: 'sanitizeStoryboardPrompt',
    input: { value: '中景固定镜头，林知夏转身看向屏幕。\n\n参考模板来源：角色生成提示词模板（自动生成）', characterNames: ['林知夏'] },
    expected: sanitizeStoryboardPrompt('中景固定镜头，林知夏转身看向屏幕。\n\n参考模板来源：角色生成提示词模板（自动生成）', { characterNames: ['林知夏'] }),
  },
  {
    name: 'sanitize_prompt_strips_character_profile_note',
    group: 'sanitizeStoryboardPrompt',
    input: { value: '近景，林知夏（28岁女性，短发瓜子脸，灰色风衣）站在值班台前。', characterNames: ['林知夏'] },
    expected: sanitizeStoryboardPrompt('近景，林知夏（28岁女性，短发瓜子脸，灰色风衣）站在值班台前。', { characterNames: ['林知夏'] }),
  },
  {
    name: 'sanitize_prompt_empty',
    group: 'sanitizeStoryboardPrompt',
    input: { value: '', characterNames: [] },
    expected: sanitizeStoryboardPrompt('', { characterNames: [] }),
  },
)

// -- storyboard-continuity.mjs ----------------------------------------------
cases.push(
  {
    name: 'continuity_enabled_by_tool_name',
    group: 'shouldUseStoryboardContinuity',
    input: { tools: ['片段衔接'], prompt: '林知夏走向走廊尽头。', assetReference: { tools: [] } },
    expected: shouldUseStoryboardContinuity({ tools: ['片段衔接'], prompt: '林知夏走向走廊尽头。', assetReference: { tools: [] } }),
  },
  {
    name: 'continuity_enabled_by_prompt_keyword',
    group: 'shouldUseStoryboardContinuity',
    input: { tools: [], prompt: '承接上一镜，林知夏继续往前走。', assetReference: {} },
    expected: shouldUseStoryboardContinuity({ tools: [], prompt: '承接上一镜，林知夏继续往前走。', assetReference: {} }),
  },
  {
    name: 'continuity_source_shot_no_bracket',
    group: 'resolveContinuitySourceShotNo',
    input: { prompt: '@片段衔接[镜头03] 继续动作。', assetReference: {} },
    expected: resolveContinuitySourceShotNo({ prompt: '@片段衔接[镜头03] 继续动作。', assetReference: {} }),
  },
  {
    name: 'continuity_source_shot_no_paren_and_reference',
    group: 'resolveContinuitySourceShotNo',
    input: { prompt: '', assetReference: { continuityFromShot: '镜头07B' } },
    expected: resolveContinuitySourceShotNo({ prompt: '', assetReference: { continuityFromShot: '镜头07B' } }),
  },
  {
    name: 'frame_reference_with_previous_end_frame',
    group: 'buildStoryboardFrameReference',
    input: {
      continuityEnabled: true,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: 'https://media.example.com/end-88.jpg', end_frame_storage_key: 'videos/end-88.jpg' },
      currentShot: { end_image_url: null },
      currentEndFrame: { image_url: 'https://media.example.com/current-end.jpg', storage_key: null },
    },
    expected: buildStoryboardFrameReference({
      continuityEnabled: true,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: 'https://media.example.com/end-88.jpg', end_frame_storage_key: 'videos/end-88.jpg' },
      currentShot: { end_image_url: null },
      currentEndFrame: { image_url: 'https://media.example.com/current-end.jpg', storage_key: null },
    }),
  },
  {
    name: 'frame_reference_missing_start_frame',
    group: 'buildStoryboardFrameReference',
    input: {
      continuityEnabled: true,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: null, end_frame_storage_key: null },
      currentShot: {},
      currentEndFrame: null,
    },
    expected: buildStoryboardFrameReference({
      continuityEnabled: true,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: null, end_frame_storage_key: null },
      currentShot: {},
      currentEndFrame: null,
    }),
  },
  {
    name: 'frame_reference_disabled',
    group: 'buildStoryboardFrameReference',
    input: {
      continuityEnabled: false,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: 'https://media.example.com/end-88.jpg' },
      currentShot: {},
      currentEndFrame: { image_url: 'https://media.example.com/current-end.jpg' },
    },
    expected: buildStoryboardFrameReference({
      continuityEnabled: false,
      previousShot: { id: 88, shot_no: '03' },
      previousVideo: { end_frame_url: 'https://media.example.com/end-88.jpg' },
      currentShot: {},
      currentEndFrame: { image_url: 'https://media.example.com/current-end.jpg' },
    }),
  },
  {
    name: 'continuity_prompt_enabled',
    group: 'buildStoryboardContinuityPrompt',
    input: {
      frameReference: {
        enabled: true, sourceShotNo: '03', sourceStoryboardId: 88, missingStartFrame: false,
      },
    },
    expected: buildStoryboardContinuityPrompt({
      enabled: true, sourceShotNo: '03', sourceStoryboardId: 88, missingStartFrame: false,
    }),
  },
  {
    name: 'continuity_prompt_missing_start',
    group: 'buildStoryboardContinuityPrompt',
    input: { frameReference: { enabled: false, missingStartFrame: true } },
    expected: buildStoryboardContinuityPrompt({ enabled: false, missingStartFrame: true }),
  },
)

// -- storyboard-mention-context.mjs -----------------------------------------
cases.push(
  {
    name: 'mention_context_full',
    group: 'normalizeStoryboardMentionContext',
    input: {
      referencedAssets: [
        { id: 5, refId: 9, characterId: 9, kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/char-9.png', viewKeys: ['front', 'side', 'back'], viewSetVersion: 2, voiceProfileKey: 'female-calm', voiceLocked: true, referenceAudioUrl: 'https://media.example.com/ref-9.wav' },
        { ref_id: 3, type: 'scene', label: '监控室', image_url: 'https://media.example.com/scene-3.png', scene_view_key: 'wide', promptText: '冷蓝色调机房' },
      ],
      tools: ['片段衔接', '添加时间'],
      voiceBindings: [{ characterId: 9, characterName: '林知夏', voiceProfileKey: 'female-calm', voiceLocked: true }],
      prompt: '@片段衔接[镜头03] 林知夏转身。',
    },
    expected: normalizeStoryboardMentionContext({
      referencedAssets: [
        { id: 5, refId: 9, characterId: 9, kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/char-9.png', viewKeys: ['front', 'side', 'back'], viewSetVersion: 2, voiceProfileKey: 'female-calm', voiceLocked: true, referenceAudioUrl: 'https://media.example.com/ref-9.wav' },
        { ref_id: 3, type: 'scene', label: '监控室', image_url: 'https://media.example.com/scene-3.png', scene_view_key: 'wide', promptText: '冷蓝色调机房' },
      ],
      tools: ['片段衔接', '添加时间'],
      voiceBindings: [{ characterId: 9, characterName: '林知夏', voiceProfileKey: 'female-calm', voiceLocked: true }],
      prompt: '@片段衔接[镜头03] 林知夏转身。',
    }),
  },
  {
    name: 'mention_context_empty_inputs',
    group: 'normalizeStoryboardMentionContext',
    input: { referencedAssets: [], tools: [], voiceBindings: [], prompt: '' },
    expected: normalizeStoryboardMentionContext({ referencedAssets: [], tools: [], voiceBindings: [], prompt: '' }),
  },
  {
    name: 'mention_context_prompt_full',
    group: 'buildMentionContextPrompt',
    input: {
      context: normalizeStoryboardMentionContext({
        referencedAssets: [
          { kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/char-9.png', viewKeys: ['front', 'side', 'back'], voiceProfileKey: 'female-calm', voiceLocked: true },
          { kind: 'scene', name: '监控室', promptText: '冷蓝机房', imageUrl: '' },
        ],
        tools: [{ key: 'tool-continuity', name: '片段衔接' }],
        voiceBindings: [{ characterName: '林知夏', voiceProfileKey: 'female-calm', voiceLocked: false }],
        prompt: '@片段衔接(镜头02)',
      }),
    },
    expected: buildMentionContextPrompt(normalizeStoryboardMentionContext({
      referencedAssets: [
        { kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/char-9.png', viewKeys: ['front', 'side', 'back'], voiceProfileKey: 'female-calm', voiceLocked: true },
        { kind: 'scene', name: '监控室', promptText: '冷蓝机房', imageUrl: '' },
      ],
      tools: [{ key: 'tool-continuity', name: '片段衔接' }],
      voiceBindings: [{ characterName: '林知夏', voiceProfileKey: 'female-calm', voiceLocked: false }],
      prompt: '@片段衔接(镜头02)',
    })),
  },
  {
    name: 'mention_context_prompt_empty',
    group: 'buildMentionContextPrompt',
    input: { context: { assets: [], tools: [], voices: [] } },
    expected: buildMentionContextPrompt({ assets: [], tools: [], voices: [] }),
  },
)

// -- storyboard-asset-references.mjs ----------------------------------------
const REFERENCE_JSON = {
  characterId: 9,
  characterVersionNo: 3,
  characterViewSetVersion: 2,
  characterViewKeys: ['front', 'side', 'back'],
  characterBaseImageId: 101,
  characterBaseVersionNo: 4,
  characterFaceImageId: 105,
  characterFaceVersionNo: 4,
  sceneAssetId: 3,
  scenePanoramaVersion: 2,
  scenePanoramaImageId: 201,
  sceneViewKey: 'wide',
  voiceProfileKey: 'female-calm',
  voiceLocked: true,
  characterName: '林知夏',
  continuityFromShot: '镜头03',
  propAssetRefs: [{ assetNodeId: 7, imageId: 301, name: '终端平板', versionNo: 1 }],
}
cases.push(
  {
    name: 'reference_snapshot_full',
    group: 'buildStoryboardReferenceSnapshot',
    input: {
      storyboard: { asset_reference_json: JSON.stringify(REFERENCE_JSON) },
      referenceImages: ['https://media.example.com/a.png', 'https://media.example.com/a.png', 'https://media.example.com/b.png'],
      referencedAssets: [{ kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/a.png', viewSetVersion: '2', versionNo: 3 }],
    },
    expected: buildStoryboardReferenceSnapshot({
      storyboard: { asset_reference_json: JSON.stringify(REFERENCE_JSON) },
      referenceImages: ['https://media.example.com/a.png', 'https://media.example.com/a.png', 'https://media.example.com/b.png'],
      referencedAssets: [{ kind: 'character', name: '林知夏', imageUrl: 'https://media.example.com/a.png', viewSetVersion: '2', versionNo: 3 }],
    }),
  },
  {
    name: 'reference_snapshot_empty_reference',
    group: 'buildStoryboardReferenceSnapshot',
    input: { storyboard: {}, referenceImages: [], referencedAssets: [] },
    expected: buildStoryboardReferenceSnapshot({ storyboard: {}, referenceImages: [], referencedAssets: [] }),
  },
  {
    name: 'reference_validation_passed',
    group: 'validateStoryboardReferenceSnapshot',
    input: { snapshot: buildStoryboardReferenceSnapshot({ storyboard: { asset_reference_json: JSON.stringify(REFERENCE_JSON) }, referenceImages: ['https://media.example.com/a.png'], referencedAssets: [] }) },
    expected: validateStoryboardReferenceSnapshot(buildStoryboardReferenceSnapshot({ storyboard: { asset_reference_json: JSON.stringify(REFERENCE_JSON) }, referenceImages: ['https://media.example.com/a.png'], referencedAssets: [] })),
  },
  {
    name: 'reference_validation_missing_scene_and_images',
    group: 'validateStoryboardReferenceSnapshot',
    input: {
      snapshot: {
        character: null,
        scene: { assetId: null, panoramaVersion: null },
        props: [{ assetNodeId: null, imageId: 301, name: '终端平板', versionNo: null }],
        referenceImages: [],
      },
    },
    expected: validateStoryboardReferenceSnapshot({
      character: null,
      scene: { assetId: null, panoramaVersion: null },
      props: [{ assetNodeId: null, imageId: 301, name: '终端平板', versionNo: null }],
      referenceImages: [],
    }),
  },
  {
    name: 'reference_validation_incomplete_view_keys',
    group: 'validateStoryboardReferenceSnapshot',
    input: {
      snapshot: {
        character: { id: 9, versionNo: 3, viewSetVersion: 2, viewKeys: ['front', 'side'], baseImageId: 101, baseVersionNo: 4, faceImageId: 105, faceVersionNo: 4, faceRequired: true },
        scene: { assetId: 3, panoramaVersion: 2 },
        props: [],
        referenceImages: ['https://media.example.com/a.png'],
      },
    },
    expected: validateStoryboardReferenceSnapshot({
      character: { id: 9, versionNo: 3, viewSetVersion: 2, viewKeys: ['front', 'side'], baseImageId: 101, baseVersionNo: 4, faceImageId: 105, faceVersionNo: 4, faceRequired: true },
      scene: { assetId: 3, panoramaVersion: 2 },
      props: [],
      referenceImages: ['https://media.example.com/a.png'],
    }),
  },
)

// -- video-generation-request.mjs -------------------------------------------
const UNIFIED_PROMPT = '画面与资产：冷蓝机房。\n\n动作与表演：林知夏转身看向屏幕。\n\n对白与声音：（无对白）'
cases.push(
  {
    name: 'unified_prompt_detected',
    group: 'hasUnifiedStoryboardPrompt',
    input: { prompt: UNIFIED_PROMPT },
    expected: hasUnifiedStoryboardPrompt(UNIFIED_PROMPT),
  },
  {
    name: 'unified_prompt_legacy_text',
    group: 'hasUnifiedStoryboardPrompt',
    input: { prompt: '近景，林知夏转身。' },
    expected: hasUnifiedStoryboardPrompt('近景，林知夏转身。'),
  },
  {
    name: 'video_prompt_parts_unified_skips_legacy',
    group: 'buildStoryboardVideoPromptParts',
    input: { prompt: UNIFIED_PROMPT, contextParts: ['【视线执行合同】x'], legacyFieldParts: ['景别：中景'] },
    expected: buildStoryboardVideoPromptParts({ prompt: UNIFIED_PROMPT, contextParts: ['【视线执行合同】x'], legacyFieldParts: ['景别：中景'] }),
  },
  {
    name: 'video_prompt_parts_legacy_appended',
    group: 'buildStoryboardVideoPromptParts',
    input: { prompt: '近景，林知夏转身。', contextParts: ['', '参考图1（角色）：x'], legacyFieldParts: ['景别：中景', '   '] },
    expected: buildStoryboardVideoPromptParts({ prompt: '近景，林知夏转身。', contextParts: ['', '参考图1（角色）：x'], legacyFieldParts: ['景别：中景', '   '] }),
  },
  {
    name: 'video_reference_image_guide_mixed',
    group: 'buildVideoReferenceImageGuide',
    input: { assetRows: [{ node_type: 'character', label: '林知夏' }, { node_type: 'scene', label: '监控室' }, { node_type: 'prop', label: '终端平板' }], transitionImageCount: 2 },
    expected: buildVideoReferenceImageGuide([{ node_type: 'character', label: '林知夏' }, { node_type: 'scene', label: '监控室' }, { node_type: 'prop', label: '终端平板' }], 2),
  },
  {
    name: 'video_reference_image_guide_empty',
    group: 'buildVideoReferenceImageGuide',
    input: { assetRows: [], transitionImageCount: 0 },
    expected: buildVideoReferenceImageGuide([], 0),
  },
  {
    name: 'direction_prompt_full',
    group: 'buildStoryboardDirectionPrompt',
    input: {
      gazePlan: { startTarget: '屏幕', transitions: [{ fromSecond: 0, toSecond: 5, target: '屏幕', observable: '视线保持在屏幕' }], eyeLead: '眼睛先动', endTarget: '屏幕', promptText: '视线保持' },
      soundPlan: { bed: '机房低频底噪', cues: [{ atSecond: 1.5, sound: '打印声', syncAction: '打印机吐纸' }], silencePolicy: '无对白不等于无声', promptText: '拟音同步' },
    },
    expected: buildStoryboardDirectionPrompt({
      gazePlan: { startTarget: '屏幕', transitions: [{ fromSecond: 0, toSecond: 5, target: '屏幕', observable: '视线保持在屏幕' }], eyeLead: '眼睛先动', endTarget: '屏幕', promptText: '视线保持' },
      soundPlan: { bed: '机房低频底噪', cues: [{ atSecond: 1.5, sound: '打印声', syncAction: '打印机吐纸' }], silencePolicy: '无对白不等于无声', promptText: '拟音同步' },
    }),
  },
  {
    name: 'direction_prompt_empty_plans',
    group: 'buildStoryboardDirectionPrompt',
    input: { gazePlan: null, soundPlan: null },
    expected: buildStoryboardDirectionPrompt({ gazePlan: null, soundPlan: null }),
  },
)

// -- storyboard-performance.mjs ----------------------------------------------
cases.push(
  {
    name: 'performance_prompt_full_fields',
    group: 'buildStoryboardPerformancePrompt',
    input: {
      input: {
        emotion: '克制紧张', emotion_intensity: 70,
        emotion_start: '镜头开始时手指悬停', emotion_trigger: '异常信号灯亮起',
        emotion_change: '从压抑到警觉', emotion_end: '警觉收束',
        micro_expression: '眉眼收紧', breath_action: '短促吸气',
        body_action: '肩膀微沉', voice_tone: '低声', voice_volume: '轻',
        speech_rate: '慢', speech_pauses: '句中停半拍', lip_sync: '逐字对应',
        continuity_from_previous: '承接上一镜转身', current_emotion: '',
        gaze_plan: { startTarget: '屏幕', transitions: [{ fromSecond: 0, toSecond: 5, target: '屏幕' }], eyeLead: '眼睛先动', endTarget: '屏幕', promptText: '视线保持在屏幕' },
        sound_plan: { bed: '机房底噪', cues: [], silencePolicy: '无对白不等于无声', promptText: '拟音与画面同步' },
      },
    },
    expected: buildStoryboardPerformancePrompt({
      emotion: '克制紧张', emotion_intensity: 70,
      emotion_start: '镜头开始时手指悬停', emotion_trigger: '异常信号灯亮起',
      emotion_change: '从压抑到警觉', emotion_end: '警觉收束',
      micro_expression: '眉眼收紧', breath_action: '短促吸气',
      body_action: '肩膀微沉', voice_tone: '低声', voice_volume: '轻',
      speech_rate: '慢', speech_pauses: '句中停半拍', lip_sync: '逐字对应',
      continuity_from_previous: '承接上一镜转身', current_emotion: '',
      gaze_plan: { startTarget: '屏幕', transitions: [{ fromSecond: 0, toSecond: 5, target: '屏幕' }], eyeLead: '眼睛先动', endTarget: '屏幕', promptText: '视线保持在屏幕' },
      sound_plan: { bed: '机房底噪', cues: [], silencePolicy: '无对白不等于无声', promptText: '拟音与画面同步' },
    }),
  },
  {
    name: 'performance_prompt_defaults',
    group: 'buildStoryboardPerformancePrompt',
    input: { input: {} },
    expected: buildStoryboardPerformancePrompt({}),
  },
)

// -- video.mjs / color-continuity.mjs ----------------------------------------
cases.push(
  {
    name: 'video_continuity_constraints_with_character',
    group: 'buildVideoContinuityConstraints',
    input: { characterName: '林知夏', sceneAssetPrompt: '冷蓝机房；金属墙面' },
    expected: buildVideoContinuityConstraints({ characterName: '林知夏', sceneAssetPrompt: '冷蓝机房；金属墙面' }),
  },
  {
    name: 'video_continuity_constraints_empty',
    group: 'buildVideoContinuityConstraints',
    input: { characterName: '', sceneAssetPrompt: '' },
    expected: buildVideoContinuityConstraints({ characterName: '', sceneAssetPrompt: '' }),
  },
  {
    name: 'color_continuity_cold_blue',
    group: 'buildColorContinuityConstraints',
    input: { visualStyle: '冷蓝色调科幻风', scenePrompt: '机房冷蓝灯光、金属材质', shotPrompt: '林知夏转身看向屏幕，冷光打脸' },
    expected: buildColorContinuityConstraints({ visualStyle: '冷蓝色调科幻风', scenePrompt: '机房冷蓝灯光、金属材质', shotPrompt: '林知夏转身看向屏幕，冷光打脸' }),
  },
  {
    name: 'color_continuity_warm_and_red',
    group: 'buildColorContinuityConstraints',
    input: { visualStyle: '', scenePrompt: '', shotPrompt: '暖黄色台灯与红色警示灯交替闪烁' },
    expected: buildColorContinuityConstraints({ visualStyle: '', scenePrompt: '', shotPrompt: '暖黄色台灯与红色警示灯交替闪烁' }),
  },
  {
    name: 'color_continuity_no_palette',
    group: 'buildColorContinuityConstraints',
    input: { visualStyle: '', scenePrompt: '', shotPrompt: '' },
    expected: buildColorContinuityConstraints({ visualStyle: '', scenePrompt: '', shotPrompt: '' }),
  },
)

// -- agent/quality-gate.mjs ---------------------------------------------------
const GEN_SHOT = {
  id: 21,
  visual_prompt: '固定中景，林知夏在监控室里转身看向屏幕。',
  shot_type: '中景',
  camera_angle: '平视',
  action_text: '林知夏转身看向屏幕。',
  dialogue_text: '（无对白）',
}
cases.push(
  {
    name: 'generation_context_passed',
    group: 'inspectStoryboardGenerationContext',
    input: {
      storyboard: GEN_SHOT,
      assets: [{ id: 3, label: '监控室', status: 'confirmed', image_url: 'https://media.example.com/scene-3.png' }],
      characterVoices: [],
      requireConfirmedAssets: true,
    },
    expected: stripCheckedAt(inspectStoryboardGenerationContext({
      storyboard: GEN_SHOT,
      assets: [{ id: 3, label: '监控室', status: 'confirmed', image_url: 'https://media.example.com/scene-3.png' }],
      characterVoices: [],
      requireConfirmedAssets: true,
    })),
  },
  {
    name: 'generation_context_dialogue_without_voice',
    group: 'inspectStoryboardGenerationContext',
    input: {
      storyboard: { ...GEN_SHOT, dialogue_text: '林知夏：谁在机房？' },
      assets: [{ id: 3, label: '监控室', status: 'confirmed', image_url: 'https://media.example.com/scene-3.png' }],
      characterVoices: [],
      requireConfirmedAssets: true,
    },
    expected: stripCheckedAt(inspectStoryboardGenerationContext({
      storyboard: { ...GEN_SHOT, dialogue_text: '林知夏：谁在机房？' },
      assets: [{ id: 3, label: '监控室', status: 'confirmed', image_url: 'https://media.example.com/scene-3.png' }],
      characterVoices: [],
      requireConfirmedAssets: true,
    })),
  },
  {
    name: 'generation_context_unconfirmed_assets_and_private_url',
    group: 'inspectStoryboardGenerationContext',
    input: {
      storyboard: GEN_SHOT,
      assets: [
        { id: 3, label: '监控室', status: 'candidate', image_url: 'http://127.0.0.1:8000/storage/x.png' },
        { id: 4, label: '终端平板', status: 'confirmed', image_url: null },
      ],
      characterVoices: [{ character_id: 9, character_name: '林知夏', voice_profile_key: '', reference_audio_url: '' }],
      requireConfirmedAssets: true,
    },
    expected: stripCheckedAt(inspectStoryboardGenerationContext({
      storyboard: GEN_SHOT,
      assets: [
        { id: 3, label: '监控室', status: 'candidate', image_url: 'http://127.0.0.1:8000/storage/x.png' },
        { id: 4, label: '终端平板', status: 'confirmed', image_url: null },
      ],
      characterVoices: [{ character_id: 9, character_name: '林知夏', voice_profile_key: '', reference_audio_url: '' }],
      requireConfirmedAssets: true,
    })),
  },
)

// -- video-candidate-inspection.mjs ------------------------------------------
cases.push(
  {
    name: 'candidate_expectations_motion_and_dialogue',
    group: 'inferVideoCandidateExpectations',
    input: {
      durationSeconds: 5, actionText: '林知夏转身走向机房深处', actingBeat: '先看屏幕再回头',
      dialogueText: '谁在机房？', audioDirection: '环境声继续', gazePlan: { transitions: [{ target: '屏幕' }, { target: '门口' }, { target: '屏幕' }] },
      soundPlan: { bed: '机房低频底噪', cues: [{ sound: '打印声' }, { sound: '脚步声' }] },
    },
    expected: inferVideoCandidateExpectations({
      durationSeconds: 5, actionText: '林知夏转身走向机房深处', actingBeat: '先看屏幕再回头',
      dialogueText: '谁在机房？', audioDirection: '环境声继续', gazePlan: { transitions: [{ target: '屏幕' }, { target: '门口' }, { target: '屏幕' }] },
      soundPlan: { bed: '机房低频底噪', cues: [{ sound: '打印声' }, { sound: '脚步声' }] },
    }),
  },
  {
    name: 'candidate_expectations_explicit_silence',
    group: 'inferVideoCandidateExpectations',
    input: {
      durationSeconds: '4', actionText: '静止镜头缓缓推进', dialogueText: '', audioDirection: '完全静音',
      gazePlan: null, soundPlan: null,
    },
    expected: inferVideoCandidateExpectations({
      durationSeconds: '4', actionText: '静止镜头缓缓推进', dialogueText: '', audioDirection: '完全静音',
      gazePlan: null, soundPlan: null,
    }),
  },
  {
    name: 'candidate_expectations_defaults',
    group: 'inferVideoCandidateExpectations',
    input: { durationSeconds: null },
    expected: inferVideoCandidateExpectations({ durationSeconds: null }),
  },
)

// -- video.mjs（模型/服务商断言） ---------------------------------------------
cases.push(
  {
    name: 'assert_model_provider_minimax_ok',
    group: 'assertVideoModelProvider',
    input: { modelName: 'MiniMax-H3', provider: 'minimax' },
    expected: attempt(() => assertVideoModelProvider('MiniMax-H3', { provider: 'minimax' })),
  },
  {
    name: 'assert_model_provider_agnes_model_on_minimax',
    group: 'assertVideoModelProvider',
    input: { modelName: 'agnes-video-2.5-flash', provider: 'minimax' },
    expected: attempt(() => assertVideoModelProvider('agnes-video-2.5-flash', { provider: 'minimax' })),
  },
  {
    name: 'assert_model_provider_unknown_model_ok',
    group: 'assertVideoModelProvider',
    input: { modelName: 'cogvideox-flash', provider: 'bigmodel' },
    expected: attempt(() => assertVideoModelProvider('cogvideox-flash', { provider: 'bigmodel' })),
  },
)

// -- lip-sync.mjs -------------------------------------------------------------
cases.push(
  {
    name: 'lip_sync_prompt_full',
    group: 'buildLipSyncPrompt',
    input: { characterName: '林知夏', dialogueText: '谁在机房？', actionText: '林知夏盯着屏幕轻声问。' },
    expected: buildLipSyncPrompt({ characterName: '林知夏', dialogueText: '谁在机房？', actionText: '林知夏盯着屏幕轻声问。' }),
  },
  {
    name: 'lip_sync_prompt_defaults_and_clip',
    group: 'buildLipSyncPrompt',
    input: { characterName: '', dialogueText: '', actionText: '动作'.repeat(600) },
    expected: buildLipSyncPrompt({ characterName: '', dialogueText: '', actionText: '动作'.repeat(600) }),
  },
  {
    name: 'lip_sync_duration_floor',
    group: 'resolveLipSyncDuration',
    input: { audioDurationSeconds: 2, storyboardDurationSeconds: 3 },
    expected: resolveLipSyncDuration(2, 3),
  },
  {
    name: 'lip_sync_duration_cap',
    group: 'resolveLipSyncDuration',
    input: { audioDurationSeconds: 22, storyboardDurationSeconds: 6 },
    expected: resolveLipSyncDuration(22, 6),
  },
  {
    name: 'dashscope_lip_sync_duration_floor',
    group: 'resolveDashScopeLipSyncDuration',
    input: { audioDurationSeconds: 1, storyboardDurationSeconds: 2 },
    expected: resolveDashScopeLipSyncDuration(1, 2),
  },
  {
    name: 'dashscope_lip_sync_duration_cap',
    group: 'resolveDashScopeLipSyncDuration',
    input: { audioDurationSeconds: 300, storyboardDurationSeconds: 4 },
    expected: resolveDashScopeLipSyncDuration(300, 4),
  },
)

const fixtures = cases.map((item) => ({
  name: item.name,
  group: item.group,
  input: item.input,
  expected: item.expected,
}))

const target = join(here, 'video_generation_fixtures.json')
writeFileSync(
  target,
  `${JSON.stringify({ generator: 'node server/services/*.mjs（纯函数子集）', cases: fixtures }, null, 2)}\n`,
  'utf8',
)
console.log(`wrote ${fixtures.length} video generation fixtures -> ${target}`)
