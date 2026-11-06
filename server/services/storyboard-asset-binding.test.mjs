import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bindStoryboardShotAssets,
  resolveStoryboardSceneViewKey,
} from './storyboard-asset-binding.mjs'

const confirmedRows = [
  { id: 11, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 2, view_set_version: 2, view_key: null, view_set_type: 'single', view_index: null, status: 'confirmed', vision_status: 'passed' },
  { id: 12, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 2, view_set_version: 2, view_key: 'front', view_set_type: 'character-turnaround', view_index: 1, status: 'confirmed', vision_status: 'passed' },
  { id: 13, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 2, view_set_version: 2, view_key: 'side', view_set_type: 'character-turnaround', view_index: 2, status: 'confirmed', vision_status: 'passed' },
  { id: 14, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 2, view_set_version: 2, view_key: 'back', view_set_type: 'character-turnaround', view_index: 3, status: 'confirmed', vision_status: 'passed' },
  { id: 15, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 1, view_set_version: 1, view_key: 'face', view_set_type: 'character-face-closeup', view_index: 1, status: 'confirmed', vision_status: 'passed' },
  { id: 21, asset_node_id: 2, node_type: 'scene', ref_id: 936, label: '深夜公寓客厅', version_no: 4, view_set_version: 4, view_key: null, view_set_type: 'single', view_index: null, status: 'confirmed', vision_status: 'passed' },
  { id: 22, asset_node_id: 2, node_type: 'scene', ref_id: 936, label: '深夜公寓客厅', version_no: 4, view_set_version: 4, view_key: 'front', view_set_type: 'scene-nine-grid', view_index: 5, status: 'confirmed', vision_status: 'passed' },
  { id: 23, asset_node_id: 2, node_type: 'scene', ref_id: 936, label: '深夜公寓客厅', version_no: 4, view_set_version: 4, view_key: 'right', view_set_type: 'scene-nine-grid', view_index: 6, status: 'confirmed', vision_status: 'passed' },
]

test('pipeline binds confirmed character turnaround and scene panorama/view when agent omits arrays', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '01',
      character_name: '唐宁',
      character_assets: [],
      scene_assets: [],
      scene_view_key: '',
      camera_angle: '右侧三分之二侧面',
      visual_prompt: '唐宁坐在深夜公寓客厅的电脑前',
    },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: [
      ...confirmedRows.filter((row) => row.node_type !== 'character'),
      { id: 16, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 3, view_set_version: 3, view_key: null, view_set_type: 'character-asset-pack', status: 'confirmed', vision_status: 'passed' },
    ],
  })

  assert.deepEqual(result.blockers, [])
  assert.equal(result.assetReference.characterId, 1)
  assert.deepEqual(result.assetReference.characterViewKeys, ['front', 'side', 'back'])
  assert.equal(result.assetReference.sceneAssetId, 2)
  assert.equal(result.assetReference.sceneViewKey, 'right')
  assert.equal(result.assetReference.sceneViewIndex, 6)
})

test('pipeline allows storyboard creation from a confirmed scene panorama before nine-angle views exist', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '01',
      character_name: '',
      camera_angle: '全景建立鏡頭',
    },
    sceneId: 936,
    characters: [],
    assetRows: confirmedRows.filter((row) => row.node_type === 'scene' && row.view_set_type === 'single'),
  })

  assert.deepEqual(result.blockers, [])
  assert.equal(result.assetReference.sceneAssetId, 2)
  assert.equal(result.assetReference.scenePanoramaImageId, 21)
  assert.equal(result.assetReference.scenePanoramaVersion, 4)
  assert.equal(result.assetReference.sceneViewKey, null)
})

test('scene view selection preserves an explicit valid agent choice', () => {
  assert.equal(
    resolveStoryboardSceneViewKey({ requested: 'back-left', cameraAngle: '正面' }, ['front', 'back-left']),
    'back-left',
  )
})

test('a manually adopted scene angle with skipped inspection remains bindable to a shot', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '02',
      scene_view_key: 'back-left',
      camera_angle: '左后方全景',
      scene_assets: ['深夜公寓客厅'],
    },
    sceneId: 936,
    characters: [],
    assetRows: [
      ...confirmedRows,
      { id: 24, asset_node_id: 2, node_type: 'scene', ref_id: 936, label: '深夜公寓客厅', version_no: 4, view_set_version: 4, view_key: 'back-left', view_set_type: 'scene-nine-grid', view_index: 7, status: 'confirmed', vision_status: 'skipped' },
    ],
  })

  assert.deepEqual(result.blockers, [])
  assert.equal(result.assetReference.sceneViewKey, 'back-left')
})

test('pipeline treats a confirmed character asset board as the complete identity reference', () => {
  const result = bindStoryboardShotAssets({
    shot: { shot_no: '01', character_name: '唐宁', scene_view_key: 'front', camera_angle: '正面' },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: [
      { id: 101, asset_node_id: 1, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 3, view_set_version: 3, view_key: null, view_set_type: 'character-asset-pack', status: 'confirmed', vision_status: 'passed' },
      ...confirmedRows.filter((row) => row.node_type === 'scene'),
    ],
  })

  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.assetReference.characterViewKeys, ['front', 'side', 'back'])
  assert.equal(result.assetReference.characterAssetPackImageId, 101)
  assert.equal(result.assetReference.characterFaceRequired, false)
})

test('pipeline rejects the legacy split-image character chain and requires one adopted asset board', () => {
  const result = bindStoryboardShotAssets({
    shot: { shot_no: '02', character_name: '唐宁' },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: confirmedRows.filter((row) => row.node_type === 'scene'
      || row.node_type === 'character'),
  })

  assert.ok(result.blockers.some((item) => /没有已采用的完整角色资产板/.test(item)))
  assert.ok(result.blockers.every((item) => !/缺少已确认三视图|缺少已确认基础正面|缺少已确认脸部/.test(item)))
})

test('pipeline resolves a confirmed asset board when storyboard SQL rows expose asset_node_id and a separate image_id', () => {
  const result = bindStoryboardShotAssets({
    shot: { shot_no: '01', character_name: '唐宁' },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: [
      { asset_node_id: 7, image_id: 701, node_type: 'character', ref_id: 101, label: '唐宁', version_no: 5, view_set_version: 5, view_set_type: 'character-asset-pack', view_key: null, status: 'confirmed', vision_status: 'passed' },
      { asset_node_id: 8, image_id: 801, node_type: 'scene', ref_id: 936, label: '审讯室', version_no: 2, view_set_type: 'single', status: 'confirmed', vision_status: 'skipped' },
    ],
  })

  assert.deepEqual(result.blockers, [])
  assert.equal(result.assetReference.characterId, 7)
  assert.equal(result.assetReference.characterAssetPackImageId, 701)
  assert.equal(result.assetReference.sceneAssetId, 8)
})

test('binding blocks a character shot unless the complete asset board is adopted', () => {
  const result = bindStoryboardShotAssets({
    shot: { shot_no: '02', character_name: '唐宁', camera_angle: '正面' },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: confirmedRows.filter((row) => row.view_key !== 'back'),
  })

  assert.equal(result.blockers.length, 1)
  assert.match(result.blockers[0], /没有已采用的完整角色资产板/)
})

test('binding resolves only confirmed prop assets and exposes executable prop references', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '03',
      character_name: '唐宁',
      scene_view_key: 'front',
      prop_assets: ['离职协议', '手机'],
      camera_angle: '正面',
    },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: [
      ...confirmedRows,
      { id: 31, asset_node_id: 3, node_type: 'prop', label: '离职协议', version_no: 1, view_set_version: 1, view_set_type: 'single', view_key: null, image_url: 'https://cdn.test/agreement.png', status: 'confirmed', vision_status: 'passed' },
      { id: 32, asset_node_id: 4, node_type: 'prop', label: '手机', version_no: 1, view_set_version: 1, view_set_type: 'single', view_key: null, image_url: 'https://cdn.test/phone.png', status: 'pending', vision_status: 'pending' },
    ],
  })

  assert.match(result.blockers.join('、'), /手机.*没有已确认道具资产/)
  assert.deepEqual(result.assetReference.propAssetNames, ['离职协议', '手机'])
  assert.deepEqual(result.assetReference.propAssetRefs, [
    { assetNodeId: 3, imageId: 31, name: '离职协议', versionNo: 1 },
  ])
})

test('pipeline binds a confirmed prop whose canvas label appends the script description', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '03',
      character_name: '',
      prop_assets: ['离职协议'],
    },
    sceneId: 936,
    characters: [],
    assetRows: [
      ...confirmedRows.filter((row) => row.node_type === 'scene'),
      {
        id: 31,
        asset_node_id: 3,
        node_type: 'prop',
        label: '离职协议：A4纸打印，最后一页有签名栏',
        version_no: 2,
        view_set_version: 2,
        view_set_type: 'single',
        view_key: null,
        status: 'confirmed',
        vision_status: 'passed',
      },
    ],
  })

  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.assetReference.propAssetIds, [3])
  assert.deepEqual(result.assetReference.propImageIds, [31])
})

test('binding carries agent-selected tools and keyframe prompts into the reference contract', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '04',
      character_name: '唐宁',
      scene_view_key: 'front',
      character_assets: ['唐宁'],
      scene_assets: ['深夜公寓客厅'],
      prop_assets: [],
      tools: ['片段衔接', '首尾帧参考'],
      start_visual_prompt: '承接上一镜唐宁抬眼前一瞬间。',
      end_visual_prompt: '邮件来源信息出现后停住。',
      camera_angle: '正面',
    },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: confirmedRows,
  })

  assert.deepEqual(result.assetReference.tools, ['片段衔接', '首尾帧参考'])
  assert.equal(result.assetReference.startVisualPrompt, '承接上一镜唐宁抬眼前一瞬间。')
  assert.equal(result.assetReference.endVisualPrompt, '邮件来源信息出现后停住。')
})

test('binding persists structured performance context for video generation', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '05',
      character_name: '唐宁',
      scene_view_key: 'front',
      camera_angle: '近景',
      emotion: '压抑的警觉',
      intensity: 84,
      micro_expression: '瞳孔收紧，眉心下压，嘴角抿住',
      breath_action: '屏息半拍后缓慢呼气',
      voice_tone: '低声克制',
      speech_rate: '偏慢',
      lip_sync: '逐字对应对白',
    },
    sceneId: 936,
    characters: [{ id: 101, name: '唐宁' }],
    assetRows: confirmedRows,
  })

  assert.equal(result.assetReference.performance.emotion, '压抑的警觉')
  assert.equal(result.assetReference.performance.intensity, 84)
  assert.equal(result.assetReference.performance.microExpression, '瞳孔收紧，眉心下压，嘴角抿住')
  assert.equal(result.assetReference.performance.lipSync, '逐字对应对白')
})

test('binding keeps an off-camera speaking character without requiring a face closeup', () => {
  const result = bindStoryboardShotAssets({
    shot: {
      shot_no: '06',
      character_name: '赵启明',
      camera_angle: '桌面与半截袖口，不露脸',
      visual_prompt: '只拍到桌面和半截袖口，赵启明的声音来自画外。',
    },
    sceneId: 936,
    characters: [{ id: 101, name: '赵启明', appearance: '只通过声音出现，不直接露脸。' }],
    assetRows: confirmedRows.map((row) => ({
      ...row,
      label: row.node_type === 'character' ? '赵启明' : row.label,
      ref_id: row.node_type === 'character' ? 101 : row.ref_id,
    })),
  })

  assert.equal(result.assetReference.characterFaceRequired, false)
  assert.equal(result.blockers.some((item) => item.includes('脸部特写')), false)
})
