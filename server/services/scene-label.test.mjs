import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSceneDisplayLabel } from './scene-label.mjs'

test('builds a stable, scan-friendly scene label from abstract titles and script evidence', () => {
  const label = buildSceneDisplayLabel({
    scene_no: 1,
    title: '死后三天',
    summary: '林默收到来自亡者的邮件。',
    content: '深夜，公寓里没有开灯。电脑屏幕自动亮起，邮件弹入收件箱。',
  })
  assert.equal(label, '场景01 · 深夜 · 收到亡者邮件')
  assert.doesNotMatch(label, /林默/)
})

test('prefers explicit location and time while keeping the hook deterministic', () => {
  assert.equal(
    buildSceneDisplayLabel({ sceneNo: 2, title: '别签字', location: '公司合规会议室', time_of_day: '白天', content: '唐宁翻到离职协议最后一页。' }),
    '场景02 · 白天 · 离职协议签字前',
  )
})
