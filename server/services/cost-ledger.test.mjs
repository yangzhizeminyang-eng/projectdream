import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateCostEntries,
  buildAudioAssetCostEntry,
  buildExportCostEntry,
  buildGenerationJobCostEntry,
  normalizeCostEntry,
} from './cost-ledger.mjs'

test('normalizes a priced cost entry and calculates the estimated amount', () => {
  assert.deepEqual(
    normalizeCostEntry({
      projectId: 12,
      entryType: 'image',
      modelName: 'image-model-v1',
      quantity: 3,
      unit: 'candidate',
      unitPrice: 0.18,
      currency: 'CNY',
      source: 'generation_job',
      generationJobId: 88,
    }),
    {
      projectId: 12,
      entryType: 'image',
      modelName: 'image-model-v1',
      quantity: 3,
      unit: 'candidate',
      unitPrice: 0.18,
      currency: 'CNY',
      estimatedCost: 0.54,
      pricingStatus: 'estimated',
      source: 'generation_job',
      generationJobId: 88,
      exportId: null,
      audioAssetId: null,
      evidence: null,
      note: null,
    },
  )
})

test('keeps a generation job in the ledger even when the provider price is not configured', () => {
  assert.deepEqual(
    buildGenerationJobCostEntry({
      job: {
        id: 88,
        project_id: 12,
        job_key: 'frame_image-31-test',
        job_type: 'frame_image',
        status: 'success',
        attempt_count: 1,
      },
      request: {
        modelName: 'image-model-v1',
        candidateCount: 2,
      },
      result: {
        items: [{ id: 1 }, { id: 2 }],
      },
    }),
    {
      projectId: 12,
      entryType: 'image',
      modelName: 'image-model-v1',
      quantity: 2,
      unit: 'candidate',
      unitPrice: null,
      currency: 'CNY',
      estimatedCost: null,
      pricingStatus: 'unpriced',
      source: 'generation_job',
      generationJobId: 88,
      exportId: null,
      audioAssetId: null,
      evidence: {
        jobKey: 'frame_image-31-test',
        jobType: 'frame_image',
        status: 'success',
        attemptCount: 1,
      },
      note: null,
    },
  )
})

test('maps export work to one auditable export cost entry', () => {
  assert.deepEqual(
    buildExportCostEntry({
      exportRecord: {
        id: 14,
        project_id: 12,
        status: 'completed',
        config_json: JSON.stringify({ exportEngine: 'ffmpeg' }),
      },
      unitPrice: 0,
    }),
    {
      projectId: 12,
      entryType: 'export',
      modelName: 'ffmpeg',
      quantity: 1,
      unit: 'export',
      unitPrice: 0,
      currency: 'CNY',
      estimatedCost: 0,
      pricingStatus: 'estimated',
      source: 'export_record',
      generationJobId: null,
      exportId: 14,
      audioAssetId: null,
      evidence: {
        exportId: 14,
        status: 'completed',
      },
      note: null,
    },
  )
})

test('maps a generated audio asset to an audio cost entry', () => {
  assert.deepEqual(
    buildAudioAssetCostEntry({
      audioAsset: {
        id: 51,
        project_id: 12,
        track_type: 'dialogue',
        model_name: 'tts-v1',
        duration_seconds: 3,
        status: 'confirmed',
      },
      pricingCatalog: { 'tts-v1': 0.03 },
    }),
    {
      projectId: 12,
      entryType: 'audio',
      modelName: 'tts-v1',
      quantity: 3,
      unit: 'second',
      unitPrice: 0.03,
      currency: 'CNY',
      estimatedCost: 0.09,
      pricingStatus: 'estimated',
      source: 'audio_asset',
      generationJobId: null,
      exportId: null,
      audioAssetId: 51,
      evidence: {
        audioAssetId: 51,
        trackType: 'dialogue',
        status: 'confirmed',
      },
      note: null,
    },
  )
})

test('aggregates priced and unpriced entries without hiding missing prices', () => {
  assert.deepEqual(
    aggregateCostEntries([
      {
        entryType: 'image',
        quantity: 2,
        unitPrice: 0.2,
        currency: 'CNY',
        estimatedCost: 0.4,
        pricingStatus: 'estimated',
      },
      {
        entryType: 'video',
        quantity: 1,
        unitPrice: null,
        currency: 'CNY',
        estimatedCost: null,
        pricingStatus: 'unpriced',
      },
      {
        entryType: 'audio',
        quantity: 1,
        unitPrice: 0.05,
        currency: 'USD',
        estimatedCost: 0.05,
        pricingStatus: 'estimated',
      },
    ]),
    {
      entryCount: 3,
      pricedEntryCount: 2,
      unpricedEntryCount: 1,
      totalEstimatedCostByCurrency: {
        CNY: 0.4,
        USD: 0.05,
      },
      byType: {
        image: {
          entryCount: 1,
          quantity: 2,
          pricedEntryCount: 1,
          unpricedEntryCount: 0,
          estimatedCostByCurrency: { CNY: 0.4 },
        },
        video: {
          entryCount: 1,
          quantity: 1,
          pricedEntryCount: 0,
          unpricedEntryCount: 1,
          estimatedCostByCurrency: {},
        },
        audio: {
          entryCount: 1,
          quantity: 1,
          pricedEntryCount: 1,
          unpricedEntryCount: 0,
          estimatedCostByCurrency: { USD: 0.05 },
        },
      },
    },
  )
})
