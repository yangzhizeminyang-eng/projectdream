import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupAssetNodeImages,
  hasCompleteSceneNineGrid,
  selectSceneNineGridImages,
  selectSceneNineGridAttempts,
  hasCompleteSceneNineGridBatch,
  selectSceneNineGridBatch,
  selectAssetPreviewImage,
} from './asset-image-groups.ts'

const image = (id, viewSetType, status = 'candidate', createdAt = `2026-10-02T00:00:0${id}Z`) => ({
  id,
  assetNodeId: 8,
  versionNo: id,
  imageUrl: `https://cdn.test/${id}.png`,
  thumbnailUrl: `https://cdn.test/${id}-thumb.png`,
  promptSnapshot: '',
  viewSetType,
  status,
  createdAt,
})

const turnaroundImage = (id, viewKey, status = 'confirmed', visionStatus = 'passed') => ({
  ...image(id, 'character-turnaround', status),
  viewKey,
  visionStatus,
})

test('groups character turnaround images without collapsing them into a final image', () => {
  const groups = groupAssetNodeImages(
    [
      image(1, 'single'),
      turnaroundImage(2, 'front'),
      turnaroundImage(3, 'side'),
      turnaroundImage(4, 'back'),
    ],
    'character',
  )

  assert.deepEqual(groups.map((group) => group.key), ['single', 'character-turnaround'])
  const turnaround = groups.find((group) => group.key === 'character-turnaround')
  assert.equal(turnaround?.label, '角色三视图')
  assert.equal(turnaround?.confirmed?.id, 4)
  assert.equal(turnaround?.latest?.id, 4)
})

test('keeps scene panorama and nine-grid results in separate stable groups', () => {
  const groups = groupAssetNodeImages(
    [
      image(1, 'scene-nine-grid', 'candidate'),
      image(2, 'single', 'confirmed'),
      image(3, 'scene-nine-grid', 'confirmed'),
      image(4, 'single', 'candidate'),
    ],
    'scene',
  )

  assert.deepEqual(groups.map((group) => group.key), ['single', 'scene-nine-grid'])
  assert.equal(groups[0].label, '场景全景基准')
  assert.equal(groups[0].confirmed?.id, 2)
  assert.equal(groups[0].latest?.id, 4)
  assert.equal(groups[1].label, '场景九宫格')
  assert.equal(groups[1].confirmed?.id, 3)
  assert.equal(groups[1].latest?.id, 3)
})

test('returns empty groups for missing images and ignores unknown view types', () => {
  assert.deepEqual(groupAssetNodeImages([], 'scene'), [])
  assert.deepEqual(groupAssetNodeImages([image(1, 'mystery')], 'scene'), [])
})

test('keeps a passed retry visible without replacing the confirmed version', () => {
  const groups = groupAssetNodeImages(
    [
      image(1, 'single', 'candidate', '2026-10-02T00:00:00Z'),
      image(2, 'single', 'confirmed', '2026-10-02T00:00:00Z'),
      image(3, 'single', 'candidate', '2026-10-02T00:00:01Z'),
    ],
    'scene',
  )

  assert.equal(groups[0].confirmed?.id, 2)
  assert.equal(groups[0].latest?.id, 3)
})

test('does not treat a failed visual check as a confirmed base image', () => {
  const groups = groupAssetNodeImages([
    { ...image(1, 'single', 'confirmed'), visionStatus: 'failed' },
    { ...image(2, 'single', 'candidate'), visionStatus: 'passed' },
  ], 'scene')

  assert.equal(groups[0].confirmed, null)
  assert.equal(groups[0].latest?.id, 2)
})

test('treats a manually adopted scene panorama without vision as confirmed', () => {
  const groups = groupAssetNodeImages([{
    ...image(1, 'single', 'confirmed'),
    visionStatus: 'skipped',
  }], 'scene')

  assert.equal(groups[0].confirmed?.id, 1)
  assert.equal(groups[0].latest?.id, 1)
})

test('shows a passed retry as a candidate until explicit adoption', () => {
  const groups = groupAssetNodeImages([
    { ...image(1, 'single', 'confirmed'), visionStatus: 'passed' },
    { ...image(2, 'single', 'candidate'), visionStatus: 'passed' },
    { ...image(3, 'single', 'candidate'), visionStatus: 'failed' },
  ], 'scene')

  assert.deepEqual(groups[0].images.map((item) => item.id), [2])
  assert.equal(groups[0].confirmed?.id, 1)
  assert.equal(groups[0].latest?.id, 2)
})

test('chooses only the newest active confirmed base image after replacement', () => {
  const groups = groupAssetNodeImages([
    { ...image(1, 'single', 'superseded'), visionStatus: 'passed' },
    { ...image(2, 'single', 'confirmed'), visionStatus: 'passed' },
    { ...image(3, 'single', 'candidate'), visionStatus: 'failed' },
  ], 'scene')

  assert.equal(groups[0].confirmed?.id, 2)
  assert.equal(groups[0].latest?.id, 2)
})

test('character preview prefers the confirmed base full-body image over turnaround art', () => {
  const groups = groupAssetNodeImages(
    [
      image(1, 'character-turnaround', 'confirmed'),
      image(2, 'single', 'candidate'),
      image(3, 'single', 'confirmed'),
    ],
    'character',
  )

  assert.equal(selectAssetPreviewImage(groups, 'character')?.id, 3)
})

test('groups face closeup separately and keeps it pending adoption', () => {
  const groups = groupAssetNodeImages([
    image(1, 'single', 'confirmed'),
    { ...image(2, 'character-face-closeup', 'candidate'), viewKey: 'face', visionStatus: 'passed' },
  ], 'character')
  const closeup = groups.find((group) => group.key === 'character-face-closeup')
  assert.equal(closeup?.label, '角色脸部特写')
  assert.equal(closeup?.confirmed, null)
  assert.equal(closeup?.latest?.id, 2)
})

test('keeps the original character asset board as the primary visual result', () => {
  const groups = groupAssetNodeImages([
    { ...image(10, 'character-asset-pack', 'candidate'), viewLabel: '角色资产板' },
    image(11, 'single', 'confirmed'),
    { ...image(12, 'character-face-closeup', 'confirmed'), viewKey: 'face', visionStatus: 'passed' },
    turnaroundImage(13, 'front'),
    turnaroundImage(14, 'side'),
    turnaroundImage(15, 'back'),
  ], 'character')

  assert.deepEqual(groups.map((group) => group.key), [
    'character-asset-pack',
    'single',
    'character-turnaround',
    'character-face-closeup',
  ])
  assert.equal(groups[0].label, '角色资产板')
  assert.equal(groups[0].latest?.id, 10)
})

test('does not report a turnaround group locked when the newest retry failed', () => {
  const groups = groupAssetNodeImages([
    turnaroundImage(1, 'front'),
    turnaroundImage(2, 'side'),
    turnaroundImage(3, 'back'),
    turnaroundImage(4, 'side', 'candidate', 'failed'),
  ], 'character')

  const turnaround = groups.find((group) => group.key === 'character-turnaround')
  assert.equal(turnaround?.confirmed?.id, 3)
  assert.equal(turnaround?.latest?.id, 3)
})

test('reports turnaround locked only after all newest views pass vision', () => {
  const groups = groupAssetNodeImages([
    turnaroundImage(1, 'front'),
    turnaroundImage(2, 'side'),
    turnaroundImage(3, 'back'),
  ], 'character')

  assert.equal(groups.find((group) => group.key === 'character-turnaround')?.confirmed?.id, 3)
})

test('character preview falls back to a base candidate before legacy turnaround data', () => {
  const groups = groupAssetNodeImages(
    [
      image(1, 'character-turnaround', 'confirmed'),
      image(2, 'single', 'candidate'),
    ],
    'character',
  )

  assert.equal(selectAssetPreviewImage(groups, 'character')?.id, 2)
})

test('scene nine-grid returns nine newest independent cells and excludes the mother image', () => {
  const cells = Array.from({ length: 9 }, (_, index) => ({
    ...image(index + 1, 'scene-nine-grid', 'candidate'),
    viewIndex: index + 1,
    viewKey: ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right'][index],
  }))
  cells.push({ ...cells[4], id: 50 })
  const result = selectSceneNineGridImages([
    { ...image(60, 'scene-nine-grid'), viewKey: null, viewIndex: null },
    ...cells,
  ])
  assert.equal(result.length, 9)
  assert.equal(result[4].id, 50)
  assert.deepEqual(result.map((item) => item.viewIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9])
})

test('scene nine-grid is incomplete until all nine independent images are available and passed', () => {
  const cells = Array.from({ length: 8 }, (_, index) => ({
    ...image(index + 1, 'scene-nine-grid', 'candidate'),
    viewIndex: index + 1,
    viewKey: ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back'][index],
    visionStatus: 'passed',
  }))
  assert.equal(hasCompleteSceneNineGrid(cells), false)
  assert.equal(hasCompleteSceneNineGrid([
    ...cells,
    { ...image(9, 'scene-nine-grid', 'candidate'), viewIndex: 9, viewKey: 'back-right', visionStatus: 'passed' },
  ]), true)
})

test('scene nine-grid batches with vision skipped remain visible and adoptable without claiming a pass', () => {
  const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
  const cells = keys.map((viewKey, index) => ({
    ...image(index + 21, 'scene-nine-grid', index === 0 ? 'confirmed' : 'candidate'),
    viewKey,
    viewIndex: index + 1,
    sourceImageId: 88,
    viewSetVersion: 4,
    visionStatus: 'skipped',
  }))

  assert.equal(hasCompleteSceneNineGrid(cells), true)
  assert.equal(hasCompleteSceneNineGridBatch(cells, 88), true)
  assert.equal(selectSceneNineGridBatch(cells, 88).length, 9)
  assert.equal(groupAssetNodeImages(cells, 'scene').find((group) => group.key === 'scene-nine-grid')?.images.length, 9)
})

test('scene nine-grid never combines passed angles from different batch versions', () => {
  const keys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
  const split = keys.map((viewKey, index) => ({
    ...image(index + 1, 'scene-nine-grid', 'candidate'),
    viewKey,
    viewIndex: index + 1,
    sourceImageId: 77,
    viewSetVersion: index < 8 ? 2 : 3,
    visionStatus: 'passed',
  }))
  assert.equal(hasCompleteSceneNineGridBatch(split, 77), false)
  assert.equal(selectSceneNineGridBatch(split, 77).length, 8)
})

test('scene nine-grid exposes a failed-only attempt for truthful retry feedback', () => {
  const attempts = selectSceneNineGridAttempts([
    {
      ...image(10, 'scene-nine-grid', 'failed'),
      viewIndex: 1,
      viewKey: 'front-left',
      visionStatus: 'failed',
      visionReason: '上游图片接口达到免费额度限制',
    },
  ])

  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].status, 'failed')
  assert.equal(hasCompleteSceneNineGrid(attempts), false)
})

test('failed-only view remains visible as a failure state instead of a blank success card', () => {
  const groups = groupAssetNodeImages([
    {
      ...image(11, 'scene-nine-grid', 'failed'),
      viewIndex: 1,
      viewKey: 'front-left',
      visionStatus: 'failed',
    },
  ], 'scene')

  assert.equal(groups[0].images[0].status, 'failed')
  assert.equal(groups[0].confirmed, null)
})

test('grouping keeps a confirmed-image fallback visible when the image list is stale', () => {
  const confirmed = { ...image(21, 'single', 'confirmed'), visionStatus: 'passed' }
  const groups = groupAssetNodeImages([], 'prop', confirmed)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].images.length, 1)
  assert.equal(groups[0].images[0].id, 21)
})
