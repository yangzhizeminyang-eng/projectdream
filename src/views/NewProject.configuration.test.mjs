import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./NewProject.vue', import.meta.url), 'utf8')

test('new project only collects a project name and routes to the studio', () => {
  assert.match(source, /const form = reactive\(\{ name: '阿尔法项目' \}\)/)
  assert.match(source, /createProject\(\{ name \}\)/)
  assert.match(source, /path: '\/workspace\/studio'/)
  assert.doesNotMatch(source, /categoryOptions|aspectRatioOptions|visualStylePresets/)
  assert.doesNotMatch(source, /targetDuration|narrativeVision|visualStyle/)
})
