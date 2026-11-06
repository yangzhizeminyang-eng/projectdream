import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCinematicEditPlan,
  buildCinematicAudioFilter,
  buildCinematicVideoFilter,
  validateCinematicEditPlan,
} from './cinematic-edit-plan.mjs'

test('builds a non-destructive plan with semantic transitions', () => {
  const sources = [
    { storyboardId: 11, videoAssetId: 101, sceneId: 1, sourceDurationSeconds: 4 },
    { storyboardId: 12, videoAssetId: 102, sceneId: 1, sourceDurationSeconds: 4, actionContinuity: true },
    { storyboardId: 13, videoAssetId: 103, sceneId: 2, sourceDurationSeconds: 4, sceneChange: true },
  ]

  const plan = buildCinematicEditPlan({ sources })

  assert.equal(plan.sourceCandidatePreserved, true)
  assert.deepEqual(plan.clips.map((clip) => clip.sourceVideoAssetId), [101, 102, 103])
  assert.equal(plan.clips[1].transition.type, 'cut')
  assert.equal(plan.clips[1].transition.durationSeconds, 0)
  assert.equal(plan.clips[2].transition.type, 'fade')
  assert.ok(plan.clips[2].transition.durationSeconds > 0)
  assert.match(plan.clips[2].reason, /换场/)
})

test('rejects a plan that references an unconfirmed or unknown source', () => {
  const result = validateCinematicEditPlan({
    plan: {
      sourceCandidatePreserved: true,
      clips: [{ storyboardId: 11, sourceVideoAssetId: 999, transition: { type: 'cut', durationSeconds: 0 } }],
    },
    sources: [{ storyboardId: 11, videoAssetId: 101, confirmed: true, sourceDurationSeconds: 4 }],
  })

  assert.equal(result.passed, false)
  assert.ok(result.blockers.some((item) => item.code === 'source-video-mismatch'))
})

test('rejects raw transition durations outside the supported range instead of validating clamped values', () => {
  const result = validateCinematicEditPlan({
    plan: {
      sourceCandidatePreserved: true,
      clips: [
        { storyboardId: 11, sourceVideoAssetId: 101, transition: { type: 'cut', durationSeconds: 0.2 } },
        { storyboardId: 12, sourceVideoAssetId: 102, transition: { type: 'fade', durationSeconds: 99 } },
      ],
    },
    sources: [
      { storyboardId: 11, videoAssetId: 101, sourceDurationSeconds: 4 },
      { storyboardId: 12, videoAssetId: 102, sourceDurationSeconds: 4 },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.blockers.filter((item) => item.code === 'cut-transition-duration-invalid').length, 1)
  assert.equal(result.blockers.filter((item) => item.code === 'transition-duration-invalid').length, 1)
})

test('builds a mixed hard-cut and xfade graph instead of applying one transition globally', () => {
  const graph = buildCinematicVideoFilter({
    clips: [
      { durationSeconds: 4, transition: { type: 'cut', durationSeconds: 0 } },
      { durationSeconds: 4, transition: { type: 'fade', durationSeconds: 0.18 } },
      { durationSeconds: 3, transition: { type: 'cut', durationSeconds: 0 } },
    ],
  })

  assert.match(graph.filterComplex, /concat=n=2:v=1:a=0/)
  assert.match(graph.filterComplex, /xfade=transition=fade:duration=0\.18/)
  assert.equal(graph.durationSeconds, 10.82)

  const audio = buildCinematicAudioFilter({
    clips: [
      { durationSeconds: 4, transition: { type: 'cut', durationSeconds: 0 } },
      { durationSeconds: 4, transition: { type: 'fade', durationSeconds: 0.18 } },
      { durationSeconds: 3, transition: { type: 'cut', durationSeconds: 0 } },
    ],
  })
  assert.match(audio.filterComplex, /concat=n=2:v=0:a=1/)
  assert.match(audio.filterComplex, /acrossfade=d=0\.18/)
})

test('automatic planning can still choose a semantic transition when a draft only contains defaults', () => {
  const plan = buildCinematicEditPlan({
    sources: [
      { storyboardId: 11, sceneId: 1, durationSeconds: 4, transition: { type: 'cut', durationSeconds: 0 } },
      { storyboardId: 12, sceneId: 2, durationSeconds: 4, transition: { type: 'cut', durationSeconds: 0 } },
    ],
  })
  assert.equal(plan.clips[1].transition.type, 'fade')
  assert.equal(plan.clips[1].transitionManual, false)
})

test('manual transition selection is preserved as an explicit override', () => {
  const plan = buildCinematicEditPlan({
    sources: [
      { storyboardId: 11, sceneId: 1, durationSeconds: 4 },
      { storyboardId: 12, sceneId: 2, durationSeconds: 4, transitionManual: true, transition: { type: 'cut', durationSeconds: 0 } },
    ],
  })
  assert.equal(plan.clips[1].transition.type, 'cut')
  assert.equal(plan.clips[1].transitionManual, true)
})
