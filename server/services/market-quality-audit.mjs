function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function normalizeBlocker(blocker = {}) {
  const code = String(blocker.code || 'unknown-blocker').trim() || 'unknown-blocker'
  return {
    code,
    message: String(blocker.message || '').trim() || code,
  }
}

export function buildMarketQualityAuditSummary({
  projectId,
  requiredSampleCount = 10,
  items = [],
} = {}) {
  const required = Math.max(1, positiveInteger(requiredSampleCount) || 10)
  const normalizedItems = (Array.isArray(items) ? items : []).map((item) => {
    const audit = item?.audit && typeof item.audit === 'object' ? item.audit : null
    const storageReadable = item?.storageReadable === true
    const auditable = storageReadable && Boolean(audit)
    const hardBlockers = (Array.isArray(audit?.hardBlockers) ? audit.hardBlockers : [])
      .map(normalizeBlocker)
    const humanBlockers = (Array.isArray(audit?.humanBlockers) ? audit.humanBlockers : [])
      .map(normalizeBlocker)
    return {
      ...item,
      exportId: positiveInteger(item?.exportId),
      storageReadable,
      auditable,
      proxyPassed: auditable && audit.proxyPassed === true,
      technicalProxyPassed: auditable && (
        audit.technicalProxyPassed === true ||
        audit.proxyPassed === true
      ),
      blockers: [...hardBlockers, ...humanBlockers],
      hardBlockers,
      humanBlockers,
    }
  })

  const auditableItems = normalizedItems.filter((item) => item.auditable)
  const proxyPassedItems = auditableItems.filter((item) => item.proxyPassed)
  const technicalProxyPassedItems = auditableItems.filter((item) => item.technicalProxyPassed)
  const missingExportIds = normalizedItems
    .filter((item) => !item.storageReadable)
    .map((item) => item.exportId)
    .filter(Boolean)
    .sort((left, right) => left - right)
  const blockerCounts = {}
  for (const item of auditableItems) {
    for (const blocker of item.blockers) {
      blockerCounts[blocker.code] = (blockerCounts[blocker.code] || 0) + 1
    }
  }

  const missingSampleCount = Math.max(0, required - auditableItems.length)
  const proxyFailureCount = Math.max(0, required - proxyPassedItems.length)
  const technicalProxyFailureCount = Math.max(0, required - technicalProxyPassedItems.length)
  const blockers = []
  if (missingSampleCount > 0) {
    blockers.push({
      code: 'insufficient-auditable-samples',
      message: `可审计竖屏终剪样本不足：需要 ${required} 条，当前只有 ${auditableItems.length} 条。`,
      count: missingSampleCount,
    })
  }
  if (proxyFailureCount > 0) {
    blockers.push({
      code: 'proxy-quality-failed',
      message: `机器代理质检通过样本不足：需要 ${required} 条，当前只有 ${proxyPassedItems.length} 条。`,
      count: proxyFailureCount,
    })
  }
  for (const [code, count] of Object.entries(blockerCounts)) {
    if (code === 'platform-evidence-incomplete') {
      blockers.push({
        code,
        message: `平台合规证据仍有 ${count} 条样本未完成，不能宣称可发布。`,
        count,
      })
    }
    if (code === 'human-listening-required') {
      blockers.push({
        code,
        message: `仍有 ${count} 条样本缺少完整播放后的真人听感确认。`,
        count,
      })
    }
  }

  const enoughSamples = auditableItems.length >= required
  const technicallyReady = proxyPassedItems.length >= required
  const tenSampleReadiness = {
    status: enoughSamples && technicallyReady ? 'ready-for-human-and-platform-validation' : 'blocked',
    enoughSamples,
    technicallyReady,
    technicalMachineReady: technicalProxyPassedItems.length >= required,
    requiredSampleCount: required,
    auditableSampleCount: auditableItems.length,
    proxyPassedCount: proxyPassedItems.length,
    technicalProxyPassedCount: technicalProxyPassedItems.length,
    missingSampleCount,
  }

  return {
    projectId: positiveInteger(projectId),
    requiredSampleCount: required,
    totalSelectedCount: normalizedItems.length,
    auditableSampleCount: auditableItems.length,
    proxyPassedCount: proxyPassedItems.length,
    technicalProxyPassedCount: technicalProxyPassedItems.length,
    missingSampleCount,
    proxyFailureCount,
    technicalProxyFailureCount,
    storage: {
      readableExportIds: normalizedItems
        .filter((item) => item.storageReadable)
        .map((item) => item.exportId)
        .filter(Boolean),
      missingExportIds,
      missingCount: missingExportIds.length,
    },
    blockerCounts,
    blockers,
    tenSampleReadiness,
    disclaimer:
      '这是基于真实媒体对象的机器代理审计，不等于真人完整播放听感、平台审核或收入验证。',
    items: normalizedItems,
  }
}
