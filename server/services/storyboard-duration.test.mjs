import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeStoryboardDurationSeconds } from './storyboard-duration.mjs'
import { validateStoryboardDurationContracts } from './storyboard-duration-contract.mjs'
import { normalizeGazePlan, validateStoryboardDirectionContract } from './storyboard-direction-contract.mjs'

test('rejects missing or non-positive storyboard durations instead of applying a fallback', () => {
  for (const value of [undefined, null, 0, -2, '0', 5.6, 'bad']) {
    assert.throws(() => normalizeStoryboardDurationSeconds(value), /时长必须是有效整数/u)
  }
})

test('preserves valid storyboard duration without rounding', () => {
  assert.equal(normalizeStoryboardDurationSeconds(5), 5)
})

test('storyboard generation can require a visible timeline aligned to the duration plan', () => {
  const shot = {
    shot_no: '01',
    duration_seconds: 5,
    duration_breakdown: [
      { phase: '动作', seconds: 3, observable: '窗口滑出发卡' },
      { phase: '反应', seconds: 2, observable: '人物抬眼锁定发卡' },
    ],
    duration_basis: '动作完成后保留反应时间。',
    dialogue_text: '（无对白）',
    visual_prompt: '时间轴：0-3秒，窗口滑出发卡；3-5秒，人物抬眼锁定发卡。',
  }
  assert.equal(validateStoryboardDurationContracts([shot], { requireVisibleTimeline: true }).passed, true)
})

test('strict storyboard generation rejects a missing or discontinuous visible timeline', () => {
  const base = {
    shot_no: '01', duration_seconds: 5,
    duration_breakdown: [{ phase: '动作', seconds: 5, observable: '发卡滑出并停住' }],
    duration_basis: '动作需完整呈现。', dialogue_text: '（无对白）',
  }
  for (const visualPrompt of [
    '镜头：中景；动作：发卡滑出。',
    '时间轴：0-2秒，发卡滑出；3-4秒，人物抬眼。',
  ]) {
    const result = validateStoryboardDurationContracts([{
      ...base,
      visual_prompt: visualPrompt,
    }], { requireVisibleTimeline: true })
    assert.equal(result.passed, false)
    assert.match(result.blockers.join('、'), /镜头内时间轴/u)
  }
})

test('timeline validation ignores repeated timing details outside the timeline section', () => {
  const result = validateStoryboardDurationContracts([{
    shot_no: '01',
    duration_seconds: 5,
    duration_breakdown: [{ phase: '动作', seconds: 5, observable: '手机亮起后人物抬眼' }],
    duration_basis: '单一动作链需要完整呈现。',
    dialogue_text: '（无对白）',
    visual_prompt: '时间轴：0-2秒，手机亮起；2-5秒，人物抬眼；镜头：中景；动作：0-2秒完成触发，2-5秒完成反应。',
  }], { requireVisibleTimeline: true })

  assert.equal(result.passed, true)
})

test('gaze normalization fills uncovered start and end holds before video submission', () => {
  const gaze = normalizeGazePlan({
    duration_seconds: 10,
    gaze_plan: {
      start_target: '柜台抽屉',
      transitions: [{
        from_second: 4,
        to_second: 7,
        target: '亮起的手机',
        observable: '眼睛先动，头部延迟跟随',
      }],
      end_target: '亮起的手机',
    },
  })
  assert.deepEqual(gaze.transitions.map((item) => [item.fromSecond, item.toSecond, item.target]), [
    [0, 4, '柜台抽屉'],
    [4, 7, '亮起的手机'],
    [7, 10, '亮起的手机'],
  ])
  assert.equal(validateStoryboardDirectionContract({
    duration_seconds: 10,
    dialogue_text: '（无对白）',
    action_text: '看向亮起的手机。',
    audio_direction: '排风扇低鸣。',
    gaze_plan: gaze,
    sound_plan: { bed: '排风扇低鸣', cues: [], silence_policy: '不静音' },
  }).passed, true)
})
