import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const editorSource = await readFile(new URL('./StoryboardEditor.vue', import.meta.url), 'utf8')
const apiSource = await readFile(new URL('../api/project.ts', import.meta.url), 'utf8')

test('storyboard editor previews a read-only performance plan before applying a split', () => {
  assert.match(apiSource, /getStoryboardPerformancePlan/)
  assert.match(editorSource, /performancePlan/)
  assert.match(editorSource, /loadingPerformancePlan/)
  assert.match(editorSource, /applyingPerformancePlan/)
  assert.match(editorSource, /performancePlanVisible/)
  assert.match(editorSource, /AI 拆分表演节拍/)
  assert.match(editorSource, /确认执行拆分/)
  assert.match(editorSource, /applyAllowed/)
  assert.match(editorSource, /不会启动模型/)
  assert.doesNotMatch(editorSource, /fetch\(/)
  assert.doesNotMatch(editorSource, /INSERT INTO|UPDATE storyboards|DELETE FROM/)
})

test('storyboard duration cannot be silently defaulted or saved outside the video model range', () => {
  assert.match(editorSource, /validateStoryboardDurationDraft/u)
  assert.match(editorSource, /min="4"/u)
  assert.match(editorSource, /max="15"/u)
  assert.doesNotMatch(editorSource, /Number\(draft\.value\.durationSeconds\)\s*\|\|\s*4/u)
})
