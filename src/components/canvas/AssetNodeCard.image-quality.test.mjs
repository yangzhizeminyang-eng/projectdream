import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AssetNodeCard.vue', import.meta.url), 'utf8')

test('asset node cards prefer the original image over the thumbnail', () => {
  assert.match(source, /previewImage\.value\?\.imageUrl \|\| previewImage\.value\?\.thumbnailUrl/)
})

test('scene cards expose all nine independent scene views in a fixed grid', () => {
  assert.match(source, /selectSceneNineGridImages\(props\.node\.images\)/)
  assert.match(source, /ac-node__nine-grid/)
  assert.match(source, /v-for="\(image, index\) in sceneNineGridSlots"/)
  assert.match(source, /aria-label="场景九宫格九个独立视角"/)
  assert.match(source, /displayedGroupImageCount\(group\)/)
  assert.match(source, /group\.key === 'scene-nine-grid' \? sceneNineGridImages\.value\.length/)
})

test('character cards preserve the complete reference image instead of cropping head and feet', () => {
  assert.match(source, /'is-character': node\.nodeType === 'character'/)
  assert.match(source, /\.ac-node\.is-character \.ac-node__image[\s\S]*object-fit: contain/)
})
