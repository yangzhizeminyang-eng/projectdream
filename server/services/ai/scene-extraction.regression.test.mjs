import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeExtractedSceneSpecs } from './scene-extraction.mjs'

test('recovers a concrete apartment location from full screenplay content', () => {
  const [scene] = normalizeExtractedSceneSpecs([
    {
      scene_no: 1,
      title: '死后三天',
      location: '死后三天',
      content: '深夜，公寓里没有开灯。林默陷在沙发里，窗外城市霓虹透过百叶窗落在茶几上的冷咖啡上。冰箱发出嗡鸣。',
    },
  ])

  assert.equal(scene.location, '深夜公寓客厅')
  assert.equal(scene.title, '深夜公寓客厅')
  assert.equal(scene.time_of_day, '深夜')
})

test('keeps an explicit concrete location and time', () => {
  const [scene] = normalizeExtractedSceneSpecs([
    {
      scene_no: 2,
      title: '办公室',
      location: '公司顶层办公室',
      time_of_day: '夜晚',
      content: '陈志远坐在办公椅前。',
    },
  ])

  assert.equal(scene.location, '公司顶层办公室')
  assert.equal(scene.time_of_day, '夜晚')
})
