import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countAssetImageGroupResults,
  countAssetImageGroupsResults,
} from './asset-result-counts.ts'

const image = (id, extra = {}) => ({
  id,
  imageUrl: `https://cdn.test/${id}.png`,
  thumbnailUrl: `https://cdn.test/${id}-thumb.png`,
  status: 'candidate',
  visionStatus: 'passed',
  ...extra,
})

test('single prop result counts one displayable image instead of zero', () => {
  assert.equal(countAssetImageGroupResults({ key: 'single', images: [image(1)] }), 1)
})

test('failed and superseded records do not count as current results', () => {
  assert.equal(countAssetImageGroupResults({
    key: 'single',
    images: [
      image(1, { status: 'failed', imageUrl: null }),
      image(2, { status: 'superseded' }),
      image(3, { visionStatus: 'failed' }),
    ],
  }), 0)
})

test('scene nine-grid counts nine independent cells and never the mother image', () => {
  const views = Array.from({ length: 9 }, (_, index) => image(index + 1, {
    viewSetType: 'scene-nine-grid',
    viewKey: `view-${index + 1}`,
    viewIndex: index + 1,
  }))
  assert.equal(countAssetImageGroupResults({
    key: 'scene-nine-grid',
    images: [image(99, { viewSetType: 'scene-nine-grid', viewKey: null, viewIndex: null }), ...views],
  }), 9)
})

test('group and single counts share the same displayability rule', () => {
  assert.equal(countAssetImageGroupsResults([
    { key: 'single', images: [image(1)] },
    { key: 'scene-nine-grid', images: [image(2, { viewSetType: 'scene-nine-grid', viewKey: 'front', viewIndex: 1 })] },
  ]), 2)
})
