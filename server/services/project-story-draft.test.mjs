import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildProjectStoryDraft,
  PROJECT_STORY_DRAFT_VERSION,
} from './project-story-draft.mjs'
import { evaluateSeasonStructure, evaluateStoryBible } from './story-quality.mjs'

test('project 12 story draft preserves the existing cast and clears both quality gates', () => {
  const draft = buildProjectStoryDraft(12)
  const bibleReport = evaluateStoryBible(draft.bible)
  const seasonReport = evaluateSeasonStructure(draft.season)

  assert.equal(draft.version, PROJECT_STORY_DRAFT_VERSION)
  assert.equal(draft.projectId, 12)
  assert.equal(draft.bible.title, '零点回声')
  assert.deepEqual(
    draft.bible.characters.map((character) => character.name),
    ['林夏', '苏岚', '周衡'],
  )
  assert.equal(draft.season.episodeCount, 3)
  assert.equal(draft.season.episodes.length, 3)
  assert.equal(bibleReport.canLock, true)
  assert.equal(seasonReport.canLock, true)
  assert.equal(seasonReport.marketQuality.canPass, true)
})

test('project 12 story draft keeps the one-scene production constraint visible', () => {
  const draft = buildProjectStoryDraft(12)

  assert.ok(draft.bible.lockedFacts.some((item) => item.includes('核心生产场景')))
  assert.ok(draft.bible.locations.includes('废弃地铁站站厅与广播控制台'))
  assert.ok(draft.season.episodes.every((episode) => episode.visualSetPieces.length >= 2))
  assert.ok(draft.season.foreshadowingPlan.length >= 2)
})

test('unsupported project ids fail instead of silently inventing story canon', () => {
  assert.throws(
    () => buildProjectStoryDraft(99),
    /没有预置的原创故事草稿/,
  )
})
