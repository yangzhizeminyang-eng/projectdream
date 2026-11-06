import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
const studioSource = await readFile(new URL('../src/views/StoryboardVideoStudio.vue', import.meta.url), 'utf8')

test('storyboard video enqueue runs the quality agent before creating a job', () => {
  const enqueueStart = serverSource.indexOf('async function enqueueStoryboardVideoJob')
  const enqueueEnd = serverSource.indexOf('async function buildFramePromptRewriteContext', enqueueStart)
  const block = serverSource.slice(enqueueStart, enqueueEnd)

  assert.match(block, /inspectStoryboardGenerationContext/)
  assert.match(block, /qualityReport/)
  assert.match(block, /error\.statusCode = 409/)
  assert.match(block, /error\.qualityReport = qualityReport/)
})

test('storyboard studio renders quality agent blockers instead of a generic failure only', () => {
  assert.match(studioSource, /qualityReport/)
  assert.match(studioSource, /质检 Agent/)
  assert.match(studioSource, /qualityReport\.blockers/)
  assert.match(studioSource, /qualityReport\.warnings/)
})
