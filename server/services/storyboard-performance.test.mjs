import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPerformanceSubShots,
  buildStoryboardPerformancePlan,
  ensurePerformanceBeatCoverage,
  normalizeStoryboardPerformance,
  shouldUseReactionShot,
} from './storyboard-performance.mjs'

test('normalizes a performance-aware storyboard shot with explicit production fields', () => {
  const result = normalizeStoryboardPerformance({
    shot_purpose: 'reaction',
    acting_beat: '林夏听到广播后先屏住呼吸，再抬头确认声音来源。',
    audio_direction: '压低声音，句中停顿，结尾带一点迟疑。',
    speech_duration_policy: 'preserve',
    reaction_shot: true,
    emotion: '压抑的警觉',
    intensity: 72,
    emotion_start: '先压住恐惧',
    emotion_trigger: '听见广播中的名字',
    emotion_change: '从克制转为警觉',
    emotion_end: '保持警觉并等待下一信息',
    micro_expression: '眼神收紧，眉心轻微下压，嘴角抿住',
    breath_action: '屏息半拍后缓慢呼气',
    body_action: '肩颈先僵住，再抬头',
    voice_tone: '低声、克制、带迟疑',
    voice_volume: '偏低',
    speech_rate: '偏慢',
    speech_pauses: '关键词前停顿半拍',
    lip_sync: '逐字对应对白，停顿时闭唇并保留呼吸动作',
    continuity_from_previous: '承接上一镜头低头阅读的视线方向',
  })

  assert.deepEqual(result, {
    shotPurpose: 'reaction',
    actingBeat: '林夏听到广播后先屏住呼吸，再抬头确认声音来源。',
    audioDirection: '压低声音，句中停顿，结尾带一点迟疑。',
    speechDurationPolicy: 'preserve',
    reactionShot: true,
    emotion: '压抑的警觉',
    intensity: 72,
    emotionStart: '先压住恐惧',
    emotionTrigger: '听见广播中的名字',
    emotionChange: '从克制转为警觉',
    emotionEnd: '保持警觉并等待下一信息',
    microExpression: '眼神收紧，眉心轻微下压，嘴角抿住',
    breathAction: '屏息半拍后缓慢呼气',
    bodyAction: '肩颈先僵住，再抬头',
    voiceTone: '低声、克制、带迟疑',
    voiceVolume: '偏低',
    speechRate: '偏慢',
    speechPauses: '关键词前停顿半拍',
    lipSync: '逐字对应对白，停顿时闭唇并保留呼吸动作',
    continuityFromPrevious: '承接上一镜头低头阅读的视线方向',
    gazePlan: {
      version: 'gaze-control-v1',
      startTarget: '镜头起始时的当前注视目标',
      transitions: [{
        fromSecond: 0,
        toSecond: 4,
        target: '当前动作对象',
        observable: '视线保持在当前动作对象，眼睛和头部动作不跳变',
        holdSeconds: 4,
      }],
      endTarget: '本镜动作结果',
      eyeLead: '若发生转移，眼睛先动，头部延迟半拍跟随；没有转移时保持目标稳定',
      promptText: '视线保持在当前动作对象，动作结果出现后停住半拍',
      inferred: true,
    },
    soundPlan: {
      version: 'sound-design-v1',
      bed: '压低声音，句中停顿，结尾带一点迟疑。',
      cues: [],
      silencePolicy: '只允许剧本明确要求的短暂停顿；无对白不等于无声',
      mixPriority: ['动作拟音', '空间底床'],
      promptText: '压低声音，句中停顿，结尾带一点迟疑。',
      inferred: true,
    },
  })
})

test('uses a reaction shot for non-speaking visual beats instead of stretching one talking shot', () => {
  assert.equal(
    shouldUseReactionShot({
      dialogueText: '（无对白）',
      actionText: '林夏抬头看向远处，手指收紧。',
      shotPurpose: 'reaction',
    }),
    true,
  )
})

test('builds a speaking beat followed by a reaction beat for a long dialogue shot', () => {
  const result = buildPerformanceSubShots({
    shot: {
      shot_type: '近景',
      camera_angle: '平视',
      composition: '三分构图',
      duration_seconds: 4,
      character_name: '林夏',
      action_text: '林夏抬头，压低声音说出关键消息。',
      dialogue_text: '林夏：妈妈，五年前那场火不是意外，我已经找到证据了。',
      visual_prompt: '室内近景，林夏靠近窗边，夜色压迫。',
    },
  })

  assert.equal(result.length, 2)
  assert.equal(result[0].shotPurpose, 'dialogue')
  assert.equal(result[0].speechDurationPolicy, 'preserve')
  assert.match(result[0].dialogueText, /^林夏：/)
  assert.equal(result[1].shotPurpose, 'reaction')
  assert.equal(result[1].reactionShot, true)
  assert.equal(result[1].dialogueText, '')
  assert.ok(result[0].durationSeconds >= 4)
  assert.ok(result[1].durationSeconds >= 1)
})

test('keeps a silent visual beat as a reaction or insert shot without inventing dialogue', () => {
  const result = buildPerformanceSubShots({
    shot: {
      duration_seconds: 3,
      action_text: '林夏的手指慢慢收紧。',
      dialogue_text: '（无对白）',
      visual_prompt: '手部特写，桌面上的证物被灯光切开。',
    },
  })

  assert.equal(result.length, 2)
  assert.equal(result[0].dialogueText, '')
  assert.equal(result[0].shotPurpose, 'insert')
  assert.equal(result[0].reactionShot, true)
  assert.equal(result[1].dialogueText, '')
  assert.equal(result[1].shotPurpose, 'reaction')
  assert.equal(result[1].reactionShot, true)
})

test('adds a reaction beat when a model returns dialogue-only sub-shots', () => {
  const result = ensurePerformanceBeatCoverage(
    [
      {
        shotType: '近景',
        cameraAngle: '平视',
        composition: '三分构图',
        durationSeconds: 5,
        actionText: '林夏压低声音说话。',
        dialogueText: '林夏：我已经找到证据了。',
        visualPrompt: '林夏近景。',
        shotPurpose: 'dialogue',
        speechDurationPolicy: 'preserve',
        reactionShot: false,
      },
    ],
    {
      duration_seconds: 5,
      character_name: '林夏',
      dialogue_text: '林夏：我已经找到证据了。',
      visual_prompt: '林夏近景。',
    },
  )

  assert.equal(result.length, 2)
  assert.equal(result[1].dialogueText, '')
  assert.equal(result[1].shotPurpose, 'reaction')
  assert.equal(result[1].reactionShot, true)
})

test('builds an auditable performance plan without calling a model', () => {
  const result = buildStoryboardPerformancePlan({
    shot: {
      id: 267,
      scene_id: 882,
      shot_no: '01',
      duration_seconds: 3,
      character_id: 18,
      character_name: '林夏',
      action_text: '林夏压低声音说出关键消息。',
      dialogue_text: '没人应该在这里活过今晚。',
      visual_prompt: '夜间检修站近景，林夏看向广播机。',
    },
  })

  assert.equal(result.version, 'storyboard-performance-v1')
  assert.equal(result.source.storyboardId, 267)
  assert.equal(result.hasDialogue, true)
  assert.equal(result.speechTimingPreserved, true)
  assert.equal(result.subShots.length, 2)
  assert.equal(result.subShots[0].shotPurpose, 'dialogue')
  assert.equal(result.subShots[1].shotPurpose, 'reaction')
  assert.equal(result.totalDurationSeconds, 5)
  assert.equal(result.durationDeltaSeconds, 2)
  assert.deepEqual(result.blockingIssues, [])
})
