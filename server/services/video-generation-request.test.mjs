import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStoryboardVideoPromptParts,
  buildStoryboardDirectionPrompt,
  buildPerformanceVideoPrompt,
  buildVideoReferenceImageGuide,
  hasUnifiedStoryboardPrompt,
  withVideoGenerationProjectId,
} from './video-generation-request.mjs'

test('video generation request snapshot carries the owning project id', () => {
  const request = withVideoGenerationProjectId(
    {
      storyboardId: 186,
      imageAssetId: 324,
      versionNo: 1,
    },
    12,
  )

  assert.equal(request.projectId, 12)
  assert.equal(request.storyboardId, 186)
  assert.equal(request.imageAssetId, 324)
})

test('video generation request rejects an invalid project id', () => {
  assert.throws(
    () => withVideoGenerationProjectId({ storyboardId: 186 }, 0),
    /invalid video generation project id/i,
  )
})

test('video reference guide maps image order to asset identity and motion scope', () => {
  const guide = buildVideoReferenceImageGuide([
    { node_type: 'character', label: '林知夏', version_no: 4, costume: '绿色短夹克、灰色连帽卫衣、黑色斜挎包' },
    { node_type: 'scene', label: '夜班值班台', view_key: 'left-front', version_no: 2 },
    { node_type: 'prop', label: '红色发卡' },
  ])
  assert.match(guide, /参考图1.*角色.*林知夏.*身份/u)
  assert.match(guide, /参考图2.*场景.*夜班值班台.*空间/u)
  assert.match(guide, /参考图3.*道具.*红色发卡.*只锁定道具外观/u)
  assert.match(guide, /位置和移动以本镜动作与时间轴为准/u)
  assert.match(guide, /角色「林知夏」版本4服装锁定/u)
  assert.match(guide, /绿色短夹克、灰色连帽卫衣、黑色斜挎包/u)
  assert.match(guide, /视角left-front/u)
  assert.match(guide, /遮挡、手与道具的接触点及移动路径/u)
})

test('detects the unified storyboard editor format without misclassifying legacy prose', () => {
  assert.equal(hasUnifiedStoryboardPrompt('画面与资产：@林夏 @地铁站\n\n动作与表演：她抬头。'), true)
  assert.equal(hasUnifiedStoryboardPrompt('时间轴：0-2秒，她看向门口。；镜头：中近景。；位置：画面右侧。；动作：抬眼。；要求：停住。；声音：脚步声。'), true)
  assert.equal(hasUnifiedStoryboardPrompt('冷色调，镜头缓慢推进。'), false)
  assert.equal(hasUnifiedStoryboardPrompt(''), false)
})

test('compact shot sheets do not receive duplicate legacy action and dialogue fields', () => {
  assert.deepEqual(buildStoryboardVideoPromptParts({
    prompt: '时间轴：0-2秒，她看向门口。；镜头：中近景。；位置：画面右侧。；动作：抬眼。；要求：停住。；对白：别回头。；声音：脚步声。',
    contextParts: ['已确认资产约束：角色和场景参考图锁定身份与布局。'],
    legacyFieldParts: ['镜头动作：她抬眼。', '对白与声音：别回头。'],
  }), [
    '时间轴：0-2秒，她看向门口。；镜头：中近景。；位置：画面右侧。；动作：抬眼。；要求：停住。；对白：别回头。；声音：脚步声。',
    '已确认资产约束：角色和场景参考图锁定身份与布局。',
  ])
})

test('unified prompt is not duplicated with stored action and dialogue fields', () => {
  const parts = buildStoryboardVideoPromptParts({
    prompt: '画面与资产：@林夏\n\n动作与表演：她抬头。\n\n对白与声音：林夏：我听见了。',
    contextParts: ['场景锁定：地铁站。', '音画同步：逐字对齐。'],
    legacyFieldParts: ['镜头动作：她抬头。', '对白与声音：林夏：我听见了。'],
  })

  assert.deepEqual(parts, [
    '画面与资产：@林夏\n\n动作与表演：她抬头。\n\n对白与声音：林夏：我听见了。',
    '场景锁定：地铁站。',
    '音画同步：逐字对齐。',
  ])
})

test('legacy prompt still receives stored action and dialogue fields', () => {
  assert.deepEqual(buildStoryboardVideoPromptParts({
    prompt: '地铁站冷色调。',
    contextParts: ['场景锁定：地铁站。'],
    legacyFieldParts: ['镜头动作：她抬头。', '对白与声音：我听见了。'],
  }), [
    '地铁站冷色调。',
    '场景锁定：地铁站。',
    '镜头动作：她抬头。',
    '对白与声音：我听见了。',
  ])
})

test('video prompt carries the action process and acting beat instead of only the still image prompt', () => {
  const prompt = buildPerformanceVideoPrompt({
    basePrompt: '废弃地铁站，林夏站在广播机前。',
    actionText: '林夏抬头看向广播机，手里的测试笔停在半空。',
    actingBeat: '先让视线移动，再让肩背收紧，最后停住半拍。',
    startVisualPrompt: '林夏仍低头看测试笔。',
    endVisualPrompt: '林夏抬头锁定红灯，呼吸收住。',
  })

  assert.match(prompt, /动作过程：林夏抬头看向广播机，手里的测试笔停在半空。/)
  assert.match(prompt, /表演节拍：先让视线移动，再让肩背收紧，最后停住半拍。/)
  assert.match(prompt, /从起始状态连续完成动作/)
  assert.match(prompt, /不要静止摆拍/)
  assert.match(prompt, /本镜只演完一个主事件/u)
  assert.match(prompt, /明确的画内目标/u)
})

test('video prompt carries the shot continuity contract as a hard generation boundary', () => {
  const prompt = buildPerformanceVideoPrompt({
    basePrompt: '林夏大特写，背景只有红灯虚化。',
    actionText: '林夏的手指向画面外靠近后停住。',
    continuityContract: {
      primaryAction: '林夏用视线和手部动作预告下一镜广播机的出现。',
      visibleEntities: ['林夏', '红灯', '绝缘手套'],
      forbiddenEntities: ['广播机主体', '新增人物', '英文对白或字幕'],
      nextShotForeshadow: {
        entities: ['广播机'],
        prompt: '林夏的视线先锁定画外广播机，手部向画面外靠近。',
      },
    },
  })

  assert.match(prompt, /镜头连续性契约/)
  assert.match(prompt, /广播机主体/)
  assert.match(prompt, /画外广播机/)
  assert.match(prompt, /不得新增未声明道具/)
})

test('video prompt always carries structured gaze and sound contracts', () => {
  const prompt = buildStoryboardDirectionPrompt({
    gazePlan: {
      startTarget: '@电脑屏幕',
      transitions: [
        { fromSecond: 0, toSecond: 3, target: '@红色发卡', observable: '眼睛先落到发卡' },
        { fromSecond: 3, toSecond: 8, target: '@绿色安全出口灯', observable: '抬眼并停住' },
      ],
      endTarget: '@绿色安全出口灯',
      eyeLead: '眼睛先动，头部延迟半拍跟随',
    },
    soundPlan: {
      bed: '连续夜班空间底噪',
      cues: [{ atSecond: 2, sound: '传送窗口机械滑动声', syncAction: '托盘滑出' }],
      silencePolicy: '无对白不等于无声',
    },
  })

  assert.match(prompt, /视线执行合同/u)
  assert.match(prompt, /0-3秒视线落到@红色发卡/u)
  assert.match(prompt, /结束锁定@绿色安全出口灯/u)
  assert.match(prompt, /声音执行合同/u)
  assert.match(prompt, /2秒传送窗口机械滑动声/u)
  assert.match(prompt, /连续夜班空间底噪/u)
})
