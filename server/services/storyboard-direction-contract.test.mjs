import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeGazePlan,
  normalizeSoundPlan,
  validateStoryboardDirectionContract,
} from './storyboard-direction-contract.mjs'

test('normalizes an ordered gaze plan with eye-leading head coordination', () => {
  const result = normalizeGazePlan({
    duration_seconds: 8,
    gaze_plan: {
      start_target: '@电脑屏幕',
      transitions: [
        { from_second: 0, to_second: 3, target: '@红色发卡', hold_seconds: 1 },
        { from_second: 3, to_second: 8, target: '@绿色安全出口灯', hold_seconds: 2 },
      ],
      end_target: '@绿色安全出口灯',
      eye_lead: '眼睛先动，头部延迟半拍跟随',
    },
  })

  assert.equal(result.transitions.length, 2)
  assert.equal(result.transitions[1].target, '@绿色安全出口灯')
  assert.match(result.promptText, /红色发卡/u)
  assert.match(result.eyeLead, /眼睛先动/u)
})

test('builds a continuous sound bed and action cue when only legacy fields exist', () => {
  const result = normalizeSoundPlan({
    action_text: '传送窗口滑出红色发卡',
    audio_direction: '打印机走纸、窗口机械滑动声、通风低鸣',
    dialogue_text: '（无对白）',
  })

  assert.match(result.bed, /打印机/u)
  assert.equal(result.cues.length, 1)
  assert.match(result.silencePolicy, /不等于无声/u)
})

test('direction contract accepts the first-shot reveal pattern', () => {
  const result = validateStoryboardDirectionContract({
    duration_seconds: 8,
    action_text: '林知夏先看屏幕，传送窗口滑出红色发卡，再抬眼看向绿色安全出口灯',
    audio_direction: '窗口滑动声、打印机轻响、通风低鸣',
    gaze_plan: {
      start_target: '@电脑屏幕',
      transitions: [
        { from_second: 0, to_second: 3, target: '@红色发卡' },
        { from_second: 3, to_second: 8, target: '@绿色安全出口灯' },
      ],
      end_target: '@绿色安全出口灯',
    },
    sound_plan: {
      bed: '持续夜班值班台空间底噪',
      cues: [{ at_second: 2, sound: '传送窗口机械滑动声', sync_action: '托盘滑出' }],
      silence_policy: '仅允许结尾半拍停顿，底噪不断',
    },
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.blockers, [])
})
