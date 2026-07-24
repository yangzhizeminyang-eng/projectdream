import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMediaCompleteness } from './export-validation.mjs'

test('partial confirmed videos block export', () => {
  const result = buildMediaCompleteness({
    totalStoryboardCount: 9,
    confirmedVideoCount: 1,
    missingStoryboardSceneCount: 0,
  })

  assert.equal(result.isComplete, false)
  assert.equal(result.missingVideoCount, 8)
  assert.equal(result.blockingIssues[0].code, 'missing-confirmed-videos')
})

test('scenes without storyboards block export', () => {
  const result = buildMediaCompleteness({
    totalStoryboardCount: 9,
    confirmedVideoCount: 9,
    missingStoryboardSceneCount: 5,
  })

  assert.equal(result.isComplete, false)
  assert.equal(result.missingStoryboardSceneCount, 5)
  assert.equal(result.blockingIssues[0].code, 'missing-storyboards')
})

test('all storyboards with confirmed videos pass completeness validation', () => {
  const result = buildMediaCompleteness({
    totalStoryboardCount: 9,
    confirmedVideoCount: 9,
    missingStoryboardSceneCount: 0,
  })

  assert.equal(result.isComplete, true)
  assert.equal(result.missingVideoCount, 0)
  assert.deepEqual(result.blockingIssues, [])
})
