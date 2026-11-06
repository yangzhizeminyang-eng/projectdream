const DEFAULT_CURRENCY = 'CNY'
const ENTRY_TYPE_BY_JOB_TYPE = {
  frame_image: 'image',
  character_image: 'image',
  video_image: 'video',
  lip_sync: 'lip_sync',
  audio: 'audio',
}

const UNIT_BY_ENTRY_TYPE = {
  image: 'candidate',
  video: 'video',
  lip_sync: 'video',
  audio: 'audio',
  export: 'export',
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000
}

function toPositiveQuantity(value, fallback = 1) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function resolveCatalogPrice({ pricingCatalog = {}, modelName, entryType }) {
  if (!pricingCatalog || typeof pricingCatalog !== 'object') return null
  const direct = pricingCatalog[modelName]
  const typed = pricingCatalog[entryType]
  const value = direct ?? typed
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function normalizeCostEntry(raw = {}) {
  const projectId = Number(raw.projectId ?? raw.project_id) || 0
  const entryType = String(raw.entryType || raw.entry_type || '').trim()
  const quantity = toPositiveQuantity(raw.quantity)
  const unitPriceRaw = raw.unitPrice ?? raw.unit_price
  const unitPrice =
    unitPriceRaw === null || unitPriceRaw === undefined || unitPriceRaw === ''
      ? null
      : Number(unitPriceRaw)
  const normalizedUnitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : null
  const currency = String(raw.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY

  return {
    projectId,
    entryType,
    modelName: String(raw.modelName || raw.model_name || '').trim() || null,
    quantity,
    unit: String(raw.unit || UNIT_BY_ENTRY_TYPE[entryType] || 'unit').trim(),
    unitPrice: normalizedUnitPrice,
    currency,
    estimatedCost: normalizedUnitPrice === null ? null : roundMoney(quantity * normalizedUnitPrice),
    pricingStatus: normalizedUnitPrice === null ? 'unpriced' : 'estimated',
    source: String(raw.source || '').trim() || null,
    generationJobId: Number(raw.generationJobId ?? raw.generation_job_id) || null,
    exportId: Number(raw.exportId ?? raw.export_id) || null,
    audioAssetId: Number(raw.audioAssetId ?? raw.audio_asset_id) || null,
    evidence: raw.evidence && typeof raw.evidence === 'object' ? raw.evidence : null,
    note: String(raw.note || '').trim() || null,
  }
}

export function buildGenerationJobCostEntry({
  job,
  request = {},
  result = {},
  pricingCatalog = {},
  currency = DEFAULT_CURRENCY,
} = {}) {
  const entryType = ENTRY_TYPE_BY_JOB_TYPE[job?.job_type] || 'generation'
  const modelName = String(
    request.modelName ||
      request.model_name ||
      result?.item?.modelName ||
      result?.items?.[0]?.modelName ||
      '',
  ).trim() || null
  const resultCount = Array.isArray(result?.items) ? result.items.length : result?.item ? 1 : 0
  const requestedCount = Number(request.candidateCount || request.candidate_count || 0)
  const quantity = toPositiveQuantity(resultCount || requestedCount || 1)
  const unitPrice = resolveCatalogPrice({ pricingCatalog, modelName, entryType })

  return normalizeCostEntry({
    projectId: job?.project_id ?? job?.projectId,
    entryType,
    modelName,
    quantity,
    unit: UNIT_BY_ENTRY_TYPE[entryType] || 'generation',
    unitPrice,
    currency,
    source: 'generation_job',
    generationJobId: job?.id,
    evidence: {
      jobKey: job?.job_key || job?.jobKey || null,
      jobType: job?.job_type || job?.jobType || null,
      status: job?.status || null,
      attemptCount: Number(job?.attempt_count ?? job?.attemptCount ?? 0),
    },
  })
}

export function buildExportCostEntry({
  exportRecord,
  unitPrice = null,
  pricingCatalog = {},
  currency = DEFAULT_CURRENCY,
} = {}) {
  const config = parseJsonObject(exportRecord?.config_json ?? exportRecord?.config, {})
  const modelName = config.exportEngine || config.pipeline || 'ffmpeg'
  const resolvedUnitPrice =
    unitPrice === null || unitPrice === undefined
      ? resolveCatalogPrice({ pricingCatalog, modelName, entryType: 'export' })
      : unitPrice
  return normalizeCostEntry({
    projectId: exportRecord?.project_id ?? exportRecord?.projectId,
    entryType: 'export',
    modelName,
    quantity: 1,
    unit: 'export',
    unitPrice: resolvedUnitPrice,
    currency,
    source: 'export_record',
    exportId: exportRecord?.id,
    evidence: {
      exportId: Number(exportRecord?.id) || null,
      status: exportRecord?.status || null,
    },
  })
}

export function buildAudioAssetCostEntry({
  audioAsset,
  pricingCatalog = {},
  currency = DEFAULT_CURRENCY,
} = {}) {
  const modelName = String(audioAsset?.model_name ?? audioAsset?.modelName ?? '').trim() || null
  const durationSeconds = Number(audioAsset?.duration_seconds ?? audioAsset?.durationSeconds)
  const unitPrice = resolveCatalogPrice({
    pricingCatalog,
    modelName,
    entryType: 'audio',
  })

  return normalizeCostEntry({
    projectId: audioAsset?.project_id ?? audioAsset?.projectId,
    entryType: 'audio',
    modelName,
    quantity: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 1,
    unit: Number.isFinite(durationSeconds) && durationSeconds > 0 ? 'second' : 'audio',
    unitPrice,
    currency,
    source: 'audio_asset',
    audioAssetId: audioAsset?.id,
    evidence: {
      audioAssetId: Number(audioAsset?.id) || null,
      trackType: audioAsset?.track_type || audioAsset?.trackType || null,
      status: audioAsset?.status || null,
    },
  })
}

export function aggregateCostEntries(entries = []) {
  const summary = {
    entryCount: 0,
    pricedEntryCount: 0,
    unpricedEntryCount: 0,
    totalEstimatedCostByCurrency: {},
    byType: {},
  }

  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = normalizeCostEntry(rawEntry)
    if (!entry.entryType) continue

    summary.entryCount += 1
    if (!summary.byType[entry.entryType]) {
      summary.byType[entry.entryType] = {
        entryCount: 0,
        quantity: 0,
        pricedEntryCount: 0,
        unpricedEntryCount: 0,
        estimatedCostByCurrency: {},
      }
    }
    const typed = summary.byType[entry.entryType]
    typed.entryCount += 1
    typed.quantity = roundMoney(typed.quantity + entry.quantity)

    if (entry.estimatedCost === null) {
      summary.unpricedEntryCount += 1
      typed.unpricedEntryCount += 1
      continue
    }

    summary.pricedEntryCount += 1
    typed.pricedEntryCount += 1
    summary.totalEstimatedCostByCurrency[entry.currency] = roundMoney(
      (summary.totalEstimatedCostByCurrency[entry.currency] || 0) + entry.estimatedCost,
    )
    typed.estimatedCostByCurrency[entry.currency] = roundMoney(
      (typed.estimatedCostByCurrency[entry.currency] || 0) + entry.estimatedCost,
    )
  }

  return summary
}

export function parseCostPricingCatalog(value) {
  return parseJsonObject(value, {})
}
