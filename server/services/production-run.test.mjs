import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PRODUCTION_RUN_STAGES,
  buildEpisodeBlueprint,
  buildProductionRunSeed,
  evaluateEpisodeBlueprint,
  normalizeCandidatePolicy,
  normalizeProductionRunInput,
} from './production-run.mjs'

test('production run uses the confirmed douyin pilot pipeline and candidate policy', () => {
  const input = normalizeProductionRunInput({
    projectId: 12,
    platform: '抖音',
    episodeNo: 1,
    budget: 88,
    pilotSceneCount: 2,
    candidatePolicy: {
      keyShotVideoCandidates: 3,
      normalShotVideoCandidates: 2,
    },
  })

  assert.equal(input.platform, '抖音')
  assert.equal(input.episodeNo, 1)
  assert.equal(input.pilotSceneCount, 2)
  assert.equal(input.candidatePolicy.keyShotVideoCandidates, 3)
  assert.equal(input.candidatePolicy.normalShotVideoCandidates, 2)
  assert.equal(input.candidatePolicy.imageCandidates, 3)
  assert.equal(input.candidatePolicy.audioCandidates, 2)
})

test('production run rejects a multi-platform first pilot', () => {
  assert.throws(
    () => normalizeProductionRunInput({ projectId: 12, platform: '红果' }),
    /第一阶段只允许使用抖音/,
  )
})

test('episode blueprint preserves story promises and has production-ready emotion beats', () => {
  const blueprint = buildEpisodeBlueprint({
    projectId: 12,
    episodeNo: 1,
    episode: {
      title: '零点来电',
      logline: '停运十年的广播机在零点响起。',
      openingHook: '零点整，断电十年的广播机突然亮起红灯。',
      goal: '确认声音是否真来自母亲。',
      coreConflict: '周衡冲进站厅拔掉电源，阻止林夏保住原始轨道。',
      irreversibleChange: '林夏撬开封锁检修门并录下广播。',
      protagonistChoice: '林夏选择冒险重启控制台并保存原始录音。',
      reversal: '声音正在回应林夏此刻的动作。',
      endingHook: '录音出现七声金属敲击，苏岚点名周衡。',
      visualSetPieces: ['红灯亮起的广播控制台', '轨道尽头掠过的无车灯光'],
    },
    bible: {
      emotionalPromise: '倒计时压迫、母女情感和下一秒反转。',
      locations: ['废弃地铁站站厅与广播控制台'],
      lockedFacts: ['林夏始终穿深灰检修工装和橙色反光背心。'],
      characters: [{ name: '林夏' }, { name: '周衡' }, { name: '苏岚' }],
    },
    candidatePolicy: normalizeCandidatePolicy(),
  })

  assert.equal(blueprint.platform, '抖音')
  assert.equal(blueprint.episodeNo, 1)
  assert.equal(blueprint.targetDurationSeconds, 24)
  assert.equal(blueprint.emotionBeats.length, 5)
  assert.equal(blueprint.emotionBeats[0].phase, 'hook')
  assert.equal(blueprint.emotionBeats.at(-1).phase, 'cliffhanger')
  assert.match(blueprint.emotionBeats[0].soundPlan, /广播|底噪/)
  assert.match(blueprint.emotionBeats[3].actionProcess, /重启|保存|质问/)
  assert.ok(blueprint.continuityConstraints.length >= 3)
})

test('episode blueprint quality gate blocks missing action, sound, or hook continuity', () => {
  const report = evaluateEpisodeBlueprint({
    targetDurationSeconds: 24,
    emotionBeats: [
      {
        phase: 'hook',
        emotionStart: '异常',
        emotionProcess: '',
        emotionEnd: '异常',
        actionStart: '站在控制台前',
        actionProcess: '',
        actionEnd: '',
        dialoguePlan: '',
        soundPlan: '',
        continuity: '',
      },
    ],
    continuityConstraints: [],
    shotPlan: [],
  })

  assert.equal(report.canApprove, false)
  assert.ok(report.blockers.some((item) => item.code === 'emotion-beats-incomplete'))
  assert.ok(report.blockers.some((item) => item.code === 'missing-continuity-constraints'))
  assert.ok(report.blockers.some((item) => item.code === 'missing-shot-plan'))
})

test('episode blueprint uses the detailed script and preserves the voice hard constraints', () => {
  const sourceScript = {
    scenes: [
      { sceneNo: 1, title: '广播机第一次启动' },
      { sceneNo: 2, title: '六。别怕，小夏' },
    ],
    shots: [
      ...Array.from({ length: 16 }, (_, index) => ({
        storyboardId: 100 + index,
        sceneNo: index < 4 ? 1 : 2,
        shotNo: String(index + 1).padStart(2, '0'),
        durationSeconds: 1,
        shotPurpose: index === 0 ? 'hook' : index === 15 ? 'cliffhanger' : 'reaction',
        actionText: `动作 ${index + 1}`,
        dialogueText: '',
        actingBeat: `表演节拍 ${index + 1}`,
        audioDirection: `声音方向 ${index + 1}`,
      })),
      {
        storyboardId: 117,
        sceneNo: 2,
        shotNo: '17',
        durationSeconds: 2,
        shotPurpose: 'dialogue',
        actionText: '扬声器贴近耳边',
        dialogueText: '苏岚（广播）：六。别怕，小夏。',
        actingBeat: '六先是倒数，别怕小夏转为私人安抚。',
        audioDirection: '六和别怕小夏必须完整清晰。',
      },
      {
        storyboardId: 118,
        sceneNo: 2,
        shotNo: '18',
        durationSeconds: 2,
        shotPurpose: 'dialogue',
        actionText: '扬声器报出最后一个数字',
        dialogueText: '苏岚（广播）：四。',
        actingBeat: '四独立落下，后面接反应镜头。',
        audioDirection: '四单独成句，句后保留环境余波。',
      },
    ],
  }

  const blueprint = buildEpisodeBlueprint({
    projectId: 12,
    episodeNo: 1,
    episode: {
      title: '零点来电',
      openingHook: '广播机突然亮起红灯。',
      goal: '确认声音是否来自母亲。',
      coreConflict: '周衡阻止林夏保存证据。',
      irreversibleChange: '林夏开始录音。',
      protagonistChoice: '林夏主动靠近控制台。',
      reversal: '声音回应的是现在。',
      endingHook: '新的声音从隧道深处传来。',
    },
    bible: {
      emotionalPromise: '倒计时压迫和母女反转。',
      locations: ['废弃地铁站'],
      lockedFacts: ['林夏服装锁定。'],
      characters: [{ name: '林夏' }, { name: '苏岚' }],
    },
    sourceScript,
  })

  assert.equal(blueprint.sourceEvidence.sourceType, 'detailed-script')
  assert.equal(blueprint.sourceEvidence.shotCount, 18)
  assert.deepEqual(blueprint.shotPlan.map((shot) => shot.sourceStoryboardId), [
    ...Array.from({ length: 16 }, (_, index) => 100 + index),
    117,
    118,
  ])
  assert.match(blueprint.shotPlan.find((shot) => shot.dialogueText.includes('六'))?.dialogueText || '', /六。别怕，小夏。/)
  assert.equal(blueprint.shotPlan.filter((shot) => shot.dialogueText.includes('五')).length, 0)
  assert.match(blueprint.sourceEvidence.voiceHardConstraints.required.join('|'), /苏岚（广播）：四。/)
  assert.match(blueprint.sourceEvidence.voiceHardConstraints.forbidden.join('|'), /五/)
})

test('new project blueprints use their own script duration and do not inherit project 12 voice constraints', () => {
  const blueprint = buildEpisodeBlueprint({
    projectId: 28,
    episodeNo: 1,
    episode: {
      title: '别签字',
      openingHook: '手机亮起“赵启明：别签字”。',
      goal: '找到U盘并确认邮件来源。',
      coreConflict: '赵衡阻止唐宁读取证据。',
      irreversibleChange: '唐宁听见父亲事故不是意外。',
      protagonistChoice: '唐宁选择读取U盘而不是签字。',
      reversal: '邮件来自唐宁自己的电脑。',
      endingHook: '发件设备显示为唐宁电脑。',
    },
    bible: {
      emotionalPromise: '职场压迫和证据反转。',
      locations: ['公司办公室'],
      lockedFacts: ['赵启明不露脸。'],
      characters: [{ name: '唐宁' }, { name: '赵衡' }, { name: '赵启明' }],
    },
    sourceScript: {
      scenes: [{ sceneNo: 1, title: '办公室' }, { sceneNo: 2, title: '电脑' }],
      shots: Array.from({ length: 9 }, (_, index) => ({
        storyboardId: 500 + index,
        sceneNo: index < 5 ? 1 : 2,
        shotNo: String(index + 1).padStart(2, '0'),
        durationSeconds: [3, 5, 8, 8, 9, 10, 9, 5, 3][index],
        shotPurpose: index === 0 ? 'hook' : index === 8 ? 'cliffhanger' : 'dialogue',
        actionText: `动作 ${index + 1}`,
        dialogueText: index === 1 ? '赵衡：签了，责任归你。' : '',
        actingBeat: `节拍 ${index + 1}`,
        audioDirection: `声音 ${index + 1}`,
      })),
    },
  })

  assert.equal(blueprint.targetDurationSeconds, 60)
  assert.equal(blueprint.sourceEvidence.voiceHardConstraints, null)
  assert.equal(blueprint.sourceEvidence.shotCount, 9)
})

test('episode blueprint quality gate blocks forbidden countdown dialogue in the detailed script', () => {
  const report = evaluateEpisodeBlueprint({
    targetDurationSeconds: 24,
    openingHook: '开场异常',
    endingHook: '结尾钩子',
    emotionBeats: [
      {
        phase: 'hook',
        emotionStart: '平静',
        emotionProcess: '异常出现',
        emotionEnd: '异常',
        actionStart: '检修',
        actionProcess: '停下',
        actionEnd: '抬头',
        dialoguePlan: '短句',
        soundPlan: '底噪',
        continuity: '道具连续',
      },
      {
        phase: 'cliffhanger',
        emotionStart: '不安',
        emotionProcess: '新威胁出现',
        emotionEnd: '追更',
        actionStart: '等待',
        actionProcess: '靠近',
        actionEnd: '停住',
        dialoguePlan: '问题',
        soundPlan: '余响',
        continuity: '视线连续',
      },
    ],
    continuityConstraints: ['a', 'b', 'c'],
    shotPlan: [
      { candidateTier: 'key', dialogueText: '苏岚（广播）：六。别怕，小夏。' },
      { candidateTier: 'normal', dialogueText: '苏岚（广播）：五。' },
      { candidateTier: 'key', dialogueText: '苏岚（广播）：四。' },
    ],
    sourceEvidence: {
      sourceType: 'detailed-script',
      voiceHardConstraints: {
        required: ['苏岚（广播）：六。别怕，小夏。', '苏岚（广播）：四。'],
        forbidden: ['苏岚（广播）：五。'],
      },
    },
  })

  assert.equal(report.canApprove, false)
  assert.ok(report.blockers.some((item) => item.code === 'forbidden-dialogue'))
})

test('production run seed creates ordered stages and approval checkpoints', () => {
  const seed = buildProductionRunSeed({
    projectId: 12,
    platform: '抖音',
    episodeNo: 1,
    budget: 88,
    pilotSceneCount: 2,
    candidatePolicy: normalizeCandidatePolicy(),
    blueprint: {
      title: '零点来电',
      episodeNo: 1,
      targetDurationSeconds: 24,
      emotionBeats: [{ phase: 'hook' }],
    },
  })

  assert.deepEqual(
    seed.stages.map((stage) => stage.stageKey),
    PRODUCTION_RUN_STAGES.map((stage) => stage.key),
  )
  assert.deepEqual(
    seed.checkpoints.map((checkpoint) => checkpoint.checkpointKey),
    ['market-validation', 'blueprint', 'candidate-selection', 'pilot-release'],
  )
  assert.equal(seed.run.status, 'waiting_approval')
  assert.equal(seed.run.currentStage, 'market-validation')
  assert.equal(seed.stages[0].status, 'waiting_approval')
  assert.equal(seed.stages[1].status, 'blocked')
})
