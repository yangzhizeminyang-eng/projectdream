import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSceneExtractionPrompts,
  normalizeSceneExtractionPayload,
} from './scene-extraction.mjs'

test('scene extraction prompt requires spatial splits and durable composition anchors', () => {
  const prompts = buildSceneExtractionPrompts({
    projectName: '死去的老板给我发邮件',
    scriptText: '深夜，公寓里没有开灯。电脑自动亮起。视频画面切到陈志远办公室。',
  })

  assert.match(prompts.systemPrompt, /不按集数或剧情标题粗暴合并/)
  assert.match(prompts.systemPrompt, /视频\/监控画面空间/)
  assert.match(prompts.systemPrompt, /构图锚点/)
  assert.match(prompts.systemPrompt, /episode_no/)
  assert.match(prompts.systemPrompt, /每一集的 scene_no 从 1 重新编号/)
  assert.match(prompts.systemPrompt, /同一地点且时间连续.*归为同一片段/)
  assert.match(prompts.systemPrompt, /地点、时间段.*必须拆成新片段/)
  assert.match(prompts.systemPrompt, /每个片段再绑定唯一主要场景资产/)
  assert.match(prompts.systemPrompt, /spatial_anchors/)
  assert.match(prompts.systemPrompt, /material\/light 还必须有 narrative_reason/u)
  assert.match(prompts.systemPrompt, /材质与光线按各场剧情分别设计/u)
  assert.match(prompts.systemPrompt, /不能复用一套固定色板/u)
  assert.match(prompts.userPrompt, /公寓里没有开灯/)
})

test('scene extraction preserves plot-specific spatial anchors and angle bindings', () => {
  const [scene] = normalizeSceneExtractionPayload({
    scenes: [{
      scene_no: 1,
      title: '深夜公寓客厅',
      summary: '林默收到邮件。',
      location: '公寓客厅',
      content: '冷白电脑光落在旧木桌上，百叶窗挡住窗外路灯。',
      spatial_anchors: {
        anchors: [
          { id: 'A1', category: 'architecture', label: '东侧落地窗', description: '客厅东侧落地窗', relative_position: '东侧', evidence: '百叶窗挡住窗外路灯', origin: 'script' },
          { id: 'A2', category: 'fixed_furniture', label: '旧木桌', description: '电脑所在的旧木桌', relative_position: '窗前', evidence: '冷白电脑光落在旧木桌上', origin: 'script' },
          { id: 'M1', category: 'material', label: '桌面木材', description: '磨损哑光木纹', relative_position: '窗前', evidence: '旧木桌', origin: 'inference', narrative_reason: '贴合角色长期独居的生活痕迹' },
          { id: 'L1', category: 'light', label: '电脑屏幕冷白光', description: '局部冷白光照亮桌前区域', relative_position: '桌面', evidence: '冷白电脑光', origin: 'script', narrative_reason: '突出深夜收到邮件时的孤立感' },
        ],
        view_bindings: {
          'front-left': ['A1', 'A2'], front: ['A1', 'A2'], 'front-right': ['A1', 'A2'],
          left: ['A1', 'A2'], center: ['A1', 'A2'], right: ['A1', 'A2'],
          'back-left': ['A1', 'A2'], back: ['A1', 'A2'], 'back-right': ['A1', 'A2'],
        },
      },
    }],
  })

  assert.equal(scene.spatial_anchors.anchors.length, 4)
  assert.equal(scene.spatial_anchors.anchors.find((item) => item.id === 'L1').narrative_reason,
    '突出深夜收到邮件时的孤立感')
  assert.deepEqual(scene.spatial_anchors.view_bindings['back-right'], ['A1', 'A2'])
})

test('scene extraction rejects camera bindings with fewer than two valid anchors', () => {
  assert.throws(() => normalizeSceneExtractionPayload({
    scenes: [{
      scene_no: 1,
      title: '值班室',
      summary: '夜班交接。',
      location: '值班室',
      content: '空场。',
      spatial_anchors: {
        anchors: [
          { id: 'A1', category: 'architecture', label: '入口门', description: '值班室入口', relative_position: '南侧', evidence: '推门进入', origin: 'script' },
          { id: 'A2', category: 'fixed_furniture', label: '登记台', description: '入口对面的登记台', relative_position: '北侧', evidence: '站在登记台旁', origin: 'script' },
        ],
        view_bindings: Object.fromEntries([
          'front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right',
        ].map((key) => [key, ['A1']])),
      },
    }],
  }), /必须包含根据剧情设计的 material 与 light/u)
})

test('scene extraction accepts array and common wrapped gateway response shapes', () => {
  const scene = {
    episodeNo: 2,
    sceneNo: 1,
    title: '深夜公寓客厅',
    summary: '林默在公寓收到邮件。',
    location: '公寓客厅',
    content: '沙发正对电脑桌，百叶窗在画面左侧。',
  }

  for (const payload of [
    { scenes: [scene] },
    [scene],
    { data: { scenes: [scene] } },
    { result: { scenes: [scene] } },
    { scene_specs: [scene] },
  ]) {
    const normalized = normalizeSceneExtractionPayload(payload)
    assert.equal(normalized.length, 1)
    assert.deepEqual([normalized[0].episode_no, normalized[0].scene_no], [2, 1])
  }
})

test('scene extraction rejects abstract headings without a shootable location', () => {
  assert.deepEqual(
    normalizeSceneExtractionPayload({
      scenes: [{
        scene_no: 1,
        title: '死后三天',
        summary: '亡者邮件出现。',
        location: '悬疑场景',
        content: '林默收到邮件。',
      }],
    }),
    [],
  )
})
