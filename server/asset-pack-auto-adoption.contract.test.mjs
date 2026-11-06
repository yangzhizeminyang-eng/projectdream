import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const server = await readFile(new URL('./index.mjs', import.meta.url), 'utf8')
const canvas = await readFile(new URL('../src/views/AssetCanvas.vue', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api/project.ts', import.meta.url), 'utf8')

test('worker automatically adopts a passed character board and replaces active versions atomically', () => {
  const worker = server.slice(
    server.indexOf('async function processAssetNodeImageGenerationJob('),
    server.indexOf('async function resolveLipSyncAvatarProfile(', server.indexOf('async function processAssetNodeImageGenerationJob(')),
  )
  assert.match(worker, /planAssetPackAdoption/)
  assert.match(worker, /autoAdoptAssetPack\(request\.assetNodeId, insertedIds\)/)
  assert.match(server, /const CHARACTER_PACK_LEGACY_TYPES/)
  assert.match(server, /UPDATE asset_node_images SET status = 'superseded'/)
})

test('worker automatically adopts a passed prop single image and replaces its current version', () => {
  const worker = server.slice(
    server.indexOf('async function processAssetNodeImageGenerationJob('),
    server.indexOf('async function resolveLipSyncAvatarProfile(', server.indexOf('async function processAssetNodeImageGenerationJob(')),
  )
  assert.match(worker, /planSingleAssetAdoption/)
  assert.match(worker, /autoAdoptSingleAsset\(insertedId\)/)
})

test('asset canvas exposes retry inspection but no manual adoption for character boards', () => {
  assert.match(api, /function inspectAssetNodeImage/)
  assert.match(canvas, /inspectAssetNodeImage\(image\.id\)/)
  assert.match(canvas, /检查中 · 可重试/)
  assert.match(canvas, /检查失败 · 重新检查/)
  assert.match(canvas, /检查通过 · 已自动采用/)
})

test('legacy split generation requests are blocked before the compatibility code path', () => {
  const guard = server.indexOf("const requestedViewType = String(body.viewType || '').trim()")
  const legacyCharacterPath = server.indexOf("if (['character-turnaround', 'character-face-closeup'].includes(requestedViewType)")
  const legacyPropPath = server.indexOf("if (requestedViewType === 'prop-turnaround'")
  assert.ok(guard >= 0)
  assert.ok(legacyCharacterPath > guard)
  assert.ok(legacyPropPath > guard)
  assert.match(server, /error\.code = 'CHARACTER_ASSET_PACK_REQUIRED'/)
  assert.match(server, /error\.code = 'PROP_SINGLE_IMAGE_REQUIRED'/)
})

test('explicitly labelled legacy character boards can be promoted to the current asset-pack type', () => {
  assert.match(server, /isCharacterAssetPackRow\(image\)/)
  assert.match(server, /view_label = '角色资产板'/)
  assert.match(server, /SET view_set_type = 'character-asset-pack'/)
  assert.match(server, /view_set_type IN \(\$\{CHARACTER_PACK_LEGACY_TYPES\}\)/)
  assert.match(server, /采用当前角色资产板|形象已采用/)
})
