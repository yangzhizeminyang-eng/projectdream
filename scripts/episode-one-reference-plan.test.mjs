import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REFERENCE_REMAKE_PLAN,
  referenceRemakeDialogueItems,
  referenceRemakeStoryboardIds,
  validateReferenceRemakePlan,
} from './episode-one-reference-plan.mjs'

test('reference remake plan stays within the agreed 18-30 shot range', () => {
  assert.equal(REFERENCE_REMAKE_PLAN.length, 24)
  assert.equal(validateReferenceRemakePlan(REFERENCE_REMAKE_PLAN).valid, true)
})

test('reference remake plan keeps six audible, omits five, and isolates four', () => {
  const dialogue = referenceRemakeDialogueItems().map((item) => item.dialogueText)
  assert.ok(dialogue.includes('苏岚（广播）：六。别怕，小夏。'))
  assert.ok(!dialogue.some((text) => /苏岚（广播）：五/.test(text)))
  const fourIndex = dialogue.findIndex((text) => text === '苏岚（广播）：四。')
  assert.ok(fourIndex >= 0)
  assert.equal(dialogue[fourIndex + 1], undefined)
})

test('reference remake uses unique storyboard ids while preserving the ordered 24-shot plan', () => {
  const ids = referenceRemakeStoryboardIds()
  assert.equal(ids.length, 13)
  assert.equal(ids[0], 267)
  assert.equal(ids.at(-1), 187)
  assert.equal(
    REFERENCE_REMAKE_PLAN.filter((item) => item.storyboardKey).length,
    11,
  )
})
