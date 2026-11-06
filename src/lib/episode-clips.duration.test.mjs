import assert from 'node:assert/strict'
import test from 'node:test'

import { formatAggregateDuration, formatShotDuration } from './episode-clips.mjs'
import { readFile } from 'node:fs/promises'

test('does not present a missing storyboard duration as zero seconds', () => {
  assert.equal(formatShotDuration(null), '待设置')
  assert.equal(formatShotDuration(undefined), '待设置')
  assert.equal(formatShotDuration(0), '待设置')
  assert.equal(formatShotDuration(5), '5s')
})

test('aggregate duration uses a pending label when any view has no duration total', () => {
  assert.equal(formatAggregateDuration(0), '待统计')
  assert.equal(formatAggregateDuration(null), '待统计')
  assert.equal(formatAggregateDuration(24), '24 秒')
})

test('storyboard studio uses the missing-duration label in both shot navigators', async () => {
  const views = await Promise.all([
    'StoryboardVideoStudio.vue',
    'ProductionStudio.vue',
    'StoryboardList.vue',
    'AITaskCenter.vue',
    'VideoGenerate.vue',
    'EpisodeWorkbench.vue',
  ].map((name) => readFile(new URL(`../views/${name}`, import.meta.url), 'utf8')))
  assert.equal(views.reduce((total, view) => total + (view.match(/formatShotDuration\(shot\.durationSeconds\)/g) || []).length, 0), 5)
  assert.ok(views.every((view) => !/\{\{\s*shot\.durationSeconds \|\| 0\s*\}\}s/.test(view)))
  assert.ok(views.some((view) => view.includes('formatShotDuration(item.durationSeconds)')))
  assert.ok(views.some((view) => view.includes('formatAggregateDuration(episode.durationSeconds)')))
})

test('storyboard editor keeps missing duration unset and blocks invalid save values', async () => {
  const editor = await readFile(new URL('../views/StoryboardEditor.vue', import.meta.url), 'utf8')
  assert.match(editor, /durationSeconds: Number\(s\.durationSeconds\) > 0 \? Number\(s\.durationSeconds\) : null/)
  assert.match(editor, /payload\.durationSeconds = Number\(draft\.value\.durationSeconds\)/)
  assert.match(editor, /validateStoryboardDurationDraft\(\)/)
  assert.match(editor, /type="number"\s+min="4"\s+max="15"/)
  assert.doesNotMatch(editor, /payload\.durationSeconds = Math\.max\(1, Math\.round\(Number\(draft\.value\.durationSeconds\) \|\| 4\)\)/)
})
