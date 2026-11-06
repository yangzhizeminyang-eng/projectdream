import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AssetLibrary.vue', import.meta.url), 'utf8')

test('asset library uses the script asset canvas as its single source of truth', () => {
  assert.match(source, /getAssetCanvas/)
  assert.match(source, /asset-library-shell/)
  assert.match(source, /self-managed-scroll="true"/)
  assert.match(source, /asset-category-list/)
  assert.match(source, /asset-card-grid/)
})

test('asset library exposes the four script asset categories', () => {
  assert.match(source, /角色/)
  assert.match(source, /场景/)
  assert.match(source, /道具/)
  assert.match(source, /素材/)
  assert.match(source, /parsedType/)
  assert.match(source, /parsedTabs/)
})

test('clicking an asset opens its canvas node directly', () => {
  assert.match(source, /function openParsedNode/)
  assert.match(source, /path: '\/workspace\/assets\/canvas'/)
  assert.match(source, /nodeId: String\(node\.id\)/)
  assert.match(source, /@click="openParsedNode\(node\)"/)
})

test('asset board thumbnails preserve the full image instead of cropping its views', () => {
  assert.match(source, /\.asset-node-preview\s*\{[\s\S]*aspect-ratio:\s*16\s*\/\s*9/u)
  assert.match(source, /\.asset-node-preview img\s*\{[\s\S]*object-fit:\s*contain/u)
  assert.doesNotMatch(source, /\.asset-node-preview img\s*\{[^}]*object-fit:\s*cover/u)
  assert.doesNotMatch(source, /\.asset-node-card:hover \.asset-node-preview img/u)
  assert.match(source, /asset-node-labels/u)
})

test('redundant production asset controls are removed from the main asset view', () => {
  assert.doesNotMatch(source, /制作素材/)
  assert.doesNotMatch(source, /可用素材/)
  assert.doesNotMatch(source, /进入画布/)
  assert.doesNotMatch(source, /剧本资产拆解/)
  assert.doesNotMatch(source, /archiveProjectAsset/)
})
