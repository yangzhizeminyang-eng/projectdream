import assert from 'node:assert/strict'
import test from 'node:test'

import { assetNodeRowId } from './storyboard-asset-row.mjs'

test('resolves asset node identity from the SQL alias used by storyboard queries', () => {
  assert.equal(assetNodeRowId({ asset_node_id: 41, image_id: 902 }), 41)
})

test('accepts DTO rows and legacy rows without confusing image ids for asset node ids', () => {
  assert.equal(assetNodeRowId({ assetNodeId: 42, id: 903 }), 42)
  assert.equal(assetNodeRowId({ id: 43 }), 43)
  assert.equal(assetNodeRowId({ image_id: 904 }), null)
})
