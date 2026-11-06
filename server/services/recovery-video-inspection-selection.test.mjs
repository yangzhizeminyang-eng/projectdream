import assert from 'node:assert/strict'
import test from 'node:test'

import {
  summarizeRecoveryInspectionSelection,
} from './recovery-video-inspection-selection.mjs'

test('explains that already inspected recovery candidates were skipped', () => {
  const result = summarizeRecoveryInspectionSelection({
    rows: [
      {
        project_id: 12,
        video_asset_id: 193,
        storage_key: 'projects/12/videos/storyboards/180/v2/c1.mp4',
        recovery_inspection_json: '{"status":"ready"}',
      },
      {
        project_id: 12,
        video_asset_id: 194,
        storage_key: 'projects/12/videos/storyboards/183/v2/c1.mp4',
        recovery_inspection_json: null,
      },
      {
        project_id: 12,
        video_asset_id: 195,
        storage_key: null,
        recovery_inspection_json: null,
      },
    ],
    projectIds: [12],
  })

  assert.equal(result.selectedCount, 1)
  assert.deepEqual(result.selectedVideoAssetIds, [194])
  assert.equal(result.skippedByReason['already-inspected'], 1)
  assert.equal(result.skippedByReason['missing-storage-key'], 1)
})

test('applies the limit after eligible recovery candidates are selected', () => {
  const result = summarizeRecoveryInspectionSelection({
    rows: [
      { project_id: 12, id: 193, storage_key: 'a', recovery_inspection_json: '{"status":"ready"}' },
      { project_id: 12, id: 194, storage_key: 'b', recovery_inspection_json: null },
      { project_id: 12, id: 195, storage_key: 'c', recovery_inspection_json: null },
    ],
    projectIds: [12],
    limit: 1,
  })

  assert.equal(result.selectedCount, 1)
  assert.deepEqual(result.selectedVideoAssetIds, [194])
  assert.equal(result.eligibleCount, 2)
  assert.equal(result.skippedByReason['already-inspected'], 1)
})
