import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDeadBossGenerationPlan,
  buildDeadBossPilotCandidatePlan,
  parseDeadBossDialogueSegments,
  validateDeadBossPilotCandidatePlan,
} from './dead-boss-episode-one-pilot-plan.mjs'

const storyboardIds = Object.fromEntries(
  ['s1-01', 's1-02', 's1-03', 's1-04', 's2-01', 's2-02', 's2-03', 's2-04', 's2-05']
    .map((key, index) => [key, 295 + index]),
)

const characterIds = {
  'tang-ning': 29,
  'zhao-heng': 30,
  'zhao-qiming': 31,
}

test('builds a nine-shot candidate-only plan for the dead-boss episode', () => {
  const plan = buildDeadBossPilotCandidatePlan({
    storyboardIds,
    characterIds,
    candidatePolicy: {
      keyShotVideoCandidates: 3,
      normalShotVideoCandidates: 2,
      imageCandidates: 3,
      audioCandidates: 2,
    },
  })

  assert.deepEqual(plan.sceneKeys, ['dead-boss-scene-1', 'dead-boss-scene-2'])
  assert.equal(plan.shots.length, 9)
  assert.equal(plan.shots.every((shot) => shot.autoConfirm === false), true)
  assert.equal(plan.shots.every((shot) => shot.requiresHumanSelection === true), true)
  assert.equal(plan.shots.find((shot) => shot.shotKey === 's1-01').candidateTier, 'key')
  assert.equal(plan.shots.find((shot) => shot.shotKey === 's1-02').candidateTier, 'normal')
  assert.equal(plan.audioSegments.length, 10)
  assert.equal(plan.audioSegments.some((segment) => segment.text.includes('签了')), true)
  assert.equal(plan.audioSegments.some((segment) => segment.speakerKey === 'zhao-qiming'), true)
  assert.equal(
    plan.audioSegments.some((segment) => /[A-Za-z]/.test(segment.text.replaceAll('U盘', '盘'))),
    false,
  )
})

test('splits multi-speaker dialogue into clean voice-locked lines', () => {
  const segments = parseDeadBossDialogueSegments({
    shot: {
      key: 's1-04',
      shotNo: '04',
      dialogueText: '赵衡：你在找什么？\n唐宁：找一个能让我签字的理由。',
    },
    characterIds,
  })

  assert.deepEqual(
    segments.map((segment) => ({
      speakerKey: segment.speakerKey,
      characterId: segment.characterId,
      text: segment.text,
    })),
    [
      { speakerKey: 'zhao-heng', characterId: 30, text: '你在找什么？' },
      { speakerKey: 'tang-ning', characterId: 29, text: '找一个能让我签字的理由。' },
    ],
  )
})

test('generation plan keeps images before selection, videos after confirmed images, and audio per line', () => {
  const candidatePlan = buildDeadBossPilotCandidatePlan({
    storyboardIds,
    characterIds,
  })
  const plan = buildDeadBossGenerationPlan({ candidatePlan })

  assert.deepEqual(plan.stages, ['images', 'selection', 'videos', 'audio', 'selection'])
  assert.equal(plan.jobs.length, 9)
  assert.equal(plan.audioJobs.length, 10)
  assert.equal(plan.jobs.every((job) => job.image.autoConfirm === false), true)
  assert.equal(plan.jobs.every((job) => job.video.autoConfirm === false), true)
  assert.equal(plan.audioJobs.every((job) => job.autoConfirm === false), true)
})

test('rejects missing storyboard ids and old-story content', () => {
  const plan = buildDeadBossPilotCandidatePlan({
    storyboardIds: { ...storyboardIds, 's2-05': null },
    characterIds,
  })
  plan.shots[0].dialogueText = '苏岚（广播）：五。'

  const report = validateDeadBossPilotCandidatePlan(plan)

  assert.equal(report.valid, false)
  assert.equal(report.errors.some((error) => error.includes('storyboardId')), true)
  assert.equal(report.errors.some((error) => error.includes('旧故事')), true)
})

test('allows an explicitly scoped retry without weakening the full-episode plan', () => {
  const plan = buildDeadBossPilotCandidatePlan({
    storyboardIds,
    characterIds,
  })
  plan.shots = plan.shots.slice(0, 2)
  plan.audioSegments = plan.audioSegments.filter((segment) =>
    ['s1-01', 's1-02'].includes(segment.shotKey),
  )

  const report = validateDeadBossPilotCandidatePlan(plan, { allowPartial: true })

  assert.equal(report.valid, true)
  assert.equal(report.summary.shotCount, 2)
})
