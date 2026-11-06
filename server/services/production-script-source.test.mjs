import assert from 'node:assert/strict'
import test from 'node:test'

import { buildProductionScriptSource } from './production-script-source.mjs'

test('production script source deduplicates legacy storyboard rows by scene and shot number', () => {
  const source = buildProductionScriptSource(
    [
      {
        sceneNo: 1,
        sceneTitle: '零点检修',
        storyboardId: 267,
        shotNo: '01',
        actionText: '详细动作',
        dialogueText: '林夏：开始检修。',
        actingBeat: '先低头后抬眼',
        audioDirection: '保留滴水和电流底噪',
      },
      {
        sceneNo: 1,
        sceneTitle: '零点检修',
        storyboardId: 271,
        shotNo: '05',
        actionText: '旧占位动作',
        dialogueText: '这座城市的规则，今晚会被重写一次。',
      },
      {
        sceneNo: 1,
        sceneTitle: '零点检修',
        storyboardId: 270,
        shotNo: '05',
        actionText: '新版反应动作',
        dialogueText: '',
        actingBeat: '先移动视线，再收紧肩背',
        audioDirection: '保留短促吸气和环境底噪',
        startVisualPrompt: '冷静',
        endVisualPrompt: '警觉',
      },
      {
        sceneNo: 2,
        sceneTitle: '母亲的倒数',
        storyboardId: 180,
        shotNo: '06',
        actionText: '广播机亮起',
        dialogueText: '苏岚（广播）：十。',
        actingBeat: '红灯闪一下',
        audioDirection: '保持距离感',
      },
    ],
    { projectId: 12, episodeNo: 1 },
  )

  assert.equal(source.shots.length, 3)
  assert.deepEqual(source.shots.map((shot) => shot.sourceStoryboardId), [267, 270, 180])
  assert.equal(source.shots[1].dialogueText, '')
  assert.equal(source.shots[1].actingBeat, '先移动视线，再收紧肩背')
  assert.equal(source.scenes.length, 2)
  assert.equal(source.version, 'database-script-project-12-episode-1')
})

test('new projects keep scene two shot five instead of applying project 12 legacy filtering', () => {
  const source = buildProductionScriptSource(
    [
      {
        sceneNo: 1,
        sceneTitle: '办公室：别签字与U盘',
        storyboardId: 501,
        shotNo: '01',
        actionText: '手机亮起',
      },
      {
        sceneNo: 1,
        sceneTitle: '办公室：别签字与U盘',
        storyboardId: 505,
        shotNo: '05',
        actionText: 'U盘插入电脑',
      },
      {
        sceneNo: 2,
        sceneTitle: '办公室：父亲事故不是意外',
        storyboardId: 506,
        shotNo: '06',
        actionText: '视频卡顿',
      },
    ],
    { projectId: 99, episodeNo: 1 },
  )

  assert.deepEqual(source.shots.map((shot) => shot.shotNo), ['01', '05', '06'])
})
