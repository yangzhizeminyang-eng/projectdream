import assert from 'node:assert/strict'
import test from 'node:test'

import { validateStoryboardShotContract } from './storyboard-shot-contract.mjs'

test('accepts a director-grade shot with asset bindings and continuity states', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '唐宁位于画面右侧，办公桌和人事文件形成前后景',
    duration_seconds: 5,
    duration_breakdown: [{ phase: '动作', seconds: 3, observable: '完成抬眼和手部动作' }, { phase: '结果停顿', seconds: 2, observable: '保留决定不落笔的状态' }],
    duration_basis: '动作完成后需要保留结果停顿。',
    action_text: '唐宁捏紧离职协议，抬眼看向赵衡',
    acting_beat: '先停顿吸气，再收紧手指，最后抬眼完成主动反应',
    dialogue_text: '（无对白）',
    audio_direction: '纸张摩擦声，空调底噪，抬眼时短暂静默',
    emotional_change: '从被动压抑转为警觉',
    shot_purpose: 'reaction',
    start_state: '唐宁坐在办公桌前，离职协议尚未签字',
    end_state: '唐宁抬眼，明确决定暂不落笔',
    character_assets: ['唐宁'],
    scene_assets: ['合规办公室'],
    prop_assets: ['离职协议'],
    scene_view_key: 'front-right',
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.shot.propAssets, ['离职协议'])
})

test('normalizes direction plans for persistence and API consumption', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '值班台与走廊同框',
    duration_seconds: 8,
    duration_breakdown: [
      { phase: '观察', seconds: 3, observable: '角色看向发卡' },
      { phase: '锁定', seconds: 5, observable: '角色看向安全出口灯' },
    ],
    duration_basis: '两个视线落点和结尾停顿需要八秒。',
    action_text: '发卡滑出，角色抬头。',
    acting_beat: '眼睛先动，头部后跟。',
    shot_purpose: 'story',
    start_state: '低头看屏幕。',
    end_state: '抬头锁定安全出口灯。',
    gaze_plan: {
      start_target: '@电脑屏幕',
      transitions: [
        { from_second: 0, to_second: 3, target: '@红色发卡', observable: '视线先落到发卡' },
        { from_second: 3, to_second: 8, target: '@绿色安全出口灯', observable: '抬眼停住' },
      ],
      end_target: '@绿色安全出口灯',
    },
    sound_plan: {
      bed: '连续值班台空间底噪',
      cues: [{ at_second: 2, sound: '传送窗口滑动声', sync_action: '发卡滑出' }],
      silence_policy: '无对白不等于无声',
    },
  })

  assert.equal(result.passed, true)
  assert.equal(result.shot.gazePlan.endTarget, '@绿色安全出口灯')
  assert.equal(result.shot.soundPlan.cues[0].sound, '传送窗口滑动声')
})

test('accepts a scene-bound shot with only the confirmed panorama baseline', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '办公室内',
    duration_seconds: 4,
    duration_breakdown: [{ phase: '动作', seconds: 2, observable: '完成抬头' }, { phase: '结果停顿', seconds: 2, observable: '视线停在门口' }],
    duration_basis: '抬头动作需要完成并留下承接停顿。',
    action_text: '唐宁抬头',
    acting_beat: '短暂停顿后抬头',
    shot_purpose: 'reaction',
    start_state: '坐在桌前',
    end_state: '抬头看向门口',
    scene_assets: ['合规办公室'],
  })

  assert.equal(result.passed, true)
})

test('rejects an unknown scene angle when one is provided', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '办公室内',
    duration_seconds: 4,
    duration_breakdown: [{ phase: '动作', seconds: 2, observable: '完成抬头' }, { phase: '结果停顿', seconds: 2, observable: '视线停在门口' }],
    duration_basis: '抬头动作需要完成并留下承接停顿。',
    action_text: '唐宁抬头',
    acting_beat: '短暂停顿后抬头',
    shot_purpose: 'reaction',
    start_state: '坐在桌前',
    end_state: '抬头看向门口',
    scene_assets: ['合规办公室'],
    scene_view_key: 'random-angle',
  })

  assert.equal(result.passed, false)
  assert.match(result.blockers.join('、'), /角度标识无效/)
})

test('normalizes executable tool and keyframe fields from an agent shot', () => {
  const result = validateStoryboardShotContract({
    shot_no: '02',
    shot_type: '近景',
    camera_angle: '平视',
    composition: '手机与电脑同框，唐宁位于右侧',
    duration_seconds: 6,
    duration_breakdown: [{ phase: '动作', seconds: 4, observable: '屏幕亮起' }, { phase: '结果停顿', seconds: 2, observable: '信息停留' }],
    duration_basis: '屏幕亮起后需要保留信息落点。',
    action_text: '手机与电脑同时亮起',
    acting_beat: '先停顿，再看向屏幕',
    shot_purpose: 'reveal',
    start_state: '唐宁手指停在签名栏',
    end_state: '邮件通知覆盖屏幕',
    tools: ['首尾帧参考'],
    start_visual_prompt: '动作开始前，手指停在签名栏。',
    end_visual_prompt: '邮件通知出现，镜头停住。',
  })

  assert.equal(result.passed, true)
  assert.deepEqual(result.shot.tools, ['首尾帧参考'])
  assert.equal(result.shot.startVisualPrompt, '动作开始前，手指停在签名栏。')
  assert.equal(result.shot.endVisualPrompt, '邮件通知出现，镜头停住。')
})

test('rejects a shot without an agent-owned duration plan', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '值班台与走廊形成前后景',
    duration_seconds: 5,
    action_text: '林知夏抬头看向绿色安全出口灯。',
    acting_beat: '先停顿，再抬眼，最后停住半拍。',
    shot_purpose: 'hook',
    start_state: '林知夏低头看屏幕。',
    end_state: '她的视线锁定绿色安全出口灯。',
  })

  assert.equal(result.passed, false)
  assert.match(result.blockers.join('、'), /缺少内部时长拆解/u)
})

test('accepts a duration plan only when it exactly matches the shot duration', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '近景',
    camera_angle: '平视',
    composition: '发卡与登记标签在前景，人物在后景',
    duration_seconds: 5,
    duration_breakdown: [
      { phase: '准备', seconds: 1, observable: '手指停在窗口边缘' },
      { phase: '动作', seconds: 2, observable: '发卡和标签向外移动' },
      { phase: '结果与停顿', seconds: 2, observable: '视线锁定发卡' },
    ],
    duration_basis: '动作包含传送窗口滑出、标签吐出和视线锁定，需保留结果停顿。',
    action_text: '红色发卡从传送窗口滑出，登记标签吐出，林知夏抬头锁定发卡。',
    acting_beat: '先被声音牵引，再抬头，最后停住半拍。',
    shot_purpose: 'hook',
    start_state: '屏幕显示23:40，林知夏低头。',
    end_state: '发卡停在窗口，标签吐出一半。',
  })

  assert.equal(result.passed, true)
  assert.equal(result.shot.durationSeconds, 5)
  assert.equal(result.shot.durationBreakdown.length, 3)
})

test('validates visible shot timeline ranges against the exact shot duration', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01', shot_type: '中景', camera_angle: '平视', composition: '人物与窗口同框',
    duration_seconds: 5,
    duration_breakdown: [
      { phase: '动作', seconds: 3, observable: '窗口滑出发卡' },
      { phase: '反应', seconds: 2, observable: '人物抬眼锁定发卡' },
    ],
    duration_basis: '滑出动作后保留人物反应时间。',
    action_text: '窗口滑出发卡，人物抬眼。', acting_beat: '听见滑动声后抬眼。',
    shot_purpose: 'hook', start_state: '人物低头看屏幕。', end_state: '人物锁定发卡。',
    visual_prompt: '时间轴：0-3秒，窗口滑出发卡；3-5秒，人物抬眼锁定发卡。',
  })

  assert.equal(result.passed, true)
})

test('rejects visible shot timelines with gaps or an endpoint that differs from shot duration', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01', shot_type: '中景', camera_angle: '平视', composition: '人物与窗口同框',
    duration_seconds: 5,
    duration_breakdown: [{ phase: '动作', seconds: 5, observable: '发卡滑出并停住' }],
    duration_basis: '动作需完整呈现。',
    action_text: '发卡滑出并停住。', acting_beat: '人物抬眼。', shot_purpose: 'hook',
    start_state: '窗口关闭。', end_state: '发卡停在窗口。',
    visual_prompt: '时间轴：0-2秒，窗口滑出；3-4秒，人物抬眼。',
  })

  assert.equal(result.passed, false)
  assert.match(result.blockers.join('、'), /镜头内时间轴必须连续覆盖0到镜头时长/u)
})

test('rejects a duration plan whose parts do not add up to the shot duration', () => {
  const result = validateStoryboardShotContract({
    shot_no: '01',
    shot_type: '中景',
    camera_angle: '平视',
    composition: '值班台',
    duration_seconds: 5,
    duration_breakdown: [
      { phase: '动作', seconds: 2 },
      { phase: '结果', seconds: 2 },
    ],
    duration_basis: '动作和结果需要完整呈现。',
    action_text: '发卡滑出并停住。',
    acting_beat: '先看向窗口，再停住。',
    shot_purpose: 'story',
    start_state: '窗口关闭。',
    end_state: '发卡停在窗口。',
  })

  assert.equal(result.passed, false)
  assert.match(result.blockers.join('、'), /时长拆解总和必须等于镜头时长/u)
})
