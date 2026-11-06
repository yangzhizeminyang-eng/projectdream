import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EPISODE_ONE_VALIDATION_SCENES,
  validateEpisodeOneValidationScenes,
} from './episode-one-validation-scenes.mjs'

test('validation scenes stay within the two-scene quality gate', () => {
  const result = validateEpisodeOneValidationScenes()

  assert.equal(result.valid, true)
  assert.equal(result.scenes.length, 2)
  assert.equal(result.scenes[0].storyboardIds.length, 5)
  assert.equal(result.scenes[1].storyboardIds.length, 10)
  assert.deepEqual(
    result.scenes.map((scene) => scene.durationSeconds),
    [13, 24],
  )
})

test('memory-hit scene keeps six and four while omitting five', () => {
  const scene = validateEpisodeOneValidationScenes().scenes.find(
    (item) => item.key === 'scene-two-memory-hit',
  )

  assert.ok(scene)
  assert.match(scene.dialogue, /苏岚（广播）：六。别怕，小夏。/)
  assert.doesNotMatch(scene.dialogue, /苏岚（广播）：五/)
  assert.match(scene.dialogue, /苏岚（广播）：四。/)
  assert.deepEqual(scene.storyboardIds, [187, 284, 285, 286, 287, 288, 289, 290, 291, 292])
})

test('validation scene definitions expose quality focus for manual review', () => {
  assert.deepEqual(
    EPISODE_ONE_VALIDATION_SCENES.map((scene) => scene.qualityFocus.length),
    [3, 4],
  )
})
