import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSceneSpecsFromScriptScenes } from './scene-extraction.mjs'

test('scene extraction keeps distinct spaces from detailed script instead of collapsing an episode', () => {
  const specs = extractSceneSpecsFromScriptScenes([
    {
      scene_no: 1,
      title: '深夜公寓客厅',
      summary: '林默在没有开灯的公寓里收到死者邮件。',
      location: '深夜公寓客厅',
      time_of_day: '深夜',
      content: '百叶窗投下冷蓝光，电脑自动亮起。',
      estimated_duration: 12,
    },
    {
      scene_no: 2,
      title: '公寓电脑工作区',
      summary: '林默打开附件并切换手机热点。',
      location: '公寓电脑工作区',
      time_of_day: '深夜',
      content: '屏幕冷白光照亮他的脸。',
      estimated_duration: 14,
    },
    {
      scene_no: 3,
      title: '陈志远办公室视频',
      summary: '视频播放陈志远留下的遗言。',
      location: '陈志远办公室',
      time_of_day: '未知时间·视频画面',
      content: '书架顶端俯拍，陈志远走向摄像头。',
      estimated_duration: 20,
    },
  ])

  assert.equal(specs.length, 3)
  assert.deepEqual(specs.map((item) => item.location), [
    '深夜公寓客厅',
    '公寓电脑工作区',
    '陈志远办公室',
  ])
})

test('scene extraction rejects episode-only summaries without a concrete location', () => {
  assert.deepEqual(
    extractSceneSpecsFromScriptScenes([
      { scene_no: 1, title: '死后三天', summary: '林默收到来自死者的邮件。' },
    ]),
    [],
  )
})

test('scene extraction preserves episode identity when scene numbers repeat', () => {
  const specs = extractSceneSpecsFromScriptScenes([
    {
      episode_no: 1,
      scene_no: 1,
      title: '第一集值班室',
      location: '失物招领处值班室',
      content: '冷白灯照亮登记台。',
    },
    {
      episode_no: 2,
      scene_no: 1,
      title: '第二集后门走廊',
      location: '失物招领处后门走廊',
      content: '声控灯没有亮。',
    },
  ])

  assert.deepEqual(specs.map((item) => [item.episode_no, item.scene_no]), [[1, 1], [2, 1]])
})
