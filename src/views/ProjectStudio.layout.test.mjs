import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./ProjectStudio.vue', import.meta.url), 'utf8')

test('project overview distinguishes active and pending production steps', () => {
  assert.match(source, /status: hasScriptPath\.value \? '进行中' : '待开始'/)
  assert.match(source, /status: sceneCount\.value > 0 \? '可进入' : '待开始'/)
  assert.match(source, /is-pending/)
  assert.match(source, /is-active/)
})

test('current idea has editorial emphasis and workflow numbering remains visible', () => {
  assert.match(source, /\.project-studio__brief p\s*\{[^}]*font:[^}]*1\.15rem/)
  assert.match(source, /:data-step="step\.number"/)
})
