import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8')
const visionSource = await readFile(new URL('./ai/vision.mjs', import.meta.url), 'utf8')

test('scene panorama candidates enter automatic visual inspection', () => {
  assert.match(source, /image\?\.view_set_type === 'single'[\s\S]{0,220}request\.nodeType/)
  assert.match(source, /scene: request\.nodeType === 'scene'/)
})

test('scene panorama vision prompt checks the environment mother image contract', () => {
  assert.match(visionSource, /场景全景母版图/)
  assert.match(visionSource, /禁止角色主体、多人、字幕、文字和水印/)
})
