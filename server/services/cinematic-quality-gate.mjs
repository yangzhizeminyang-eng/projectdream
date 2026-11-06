function text(value) {
  return String(value ?? '').trim()
}

function issue(code, message, severity = 'blocker') {
  return { code: text(code) || 'cinematic-quality-blocker', message: text(message) || '成片质量检查未通过', severity }
}

function recommendationFor(item) {
  const code = text(item?.code)
  if (code === 'frozen-frame') return '重新规划该镜头的裁切区间，或在剪辑页手动替换后再导出'
  if (code === 'missing-output') return '检查渲染任务和媒体存储后重新导出'
  if (code === 'source-video-mismatch') return '恢复原始确认视频引用，不要替换源资产'
  if (code === 'missing-storyboard') return '补齐问题分镜后重新规划成片'
  return '在剪辑页处理该问题镜头后再次导出'
}

const REQUIRED_AUDIO_BLOCKERS = new Set([
  'required-audio-missing',
  'required-audio-near-silent',
  'audio-level-inspection-incomplete',
])

export function resolveCinematicInspectionIssues({ inspection = {}, requiresAudio = false } = {}) {
  const blockers = []
  const warnings = []
  const issues = Array.isArray(inspection.issues) ? inspection.issues : []
  for (const item of issues) {
    const normalized = issue(item?.code, item?.message, item?.severity || 'warning')
    if (normalized.severity === 'blocker' || (requiresAudio && REQUIRED_AUDIO_BLOCKERS.has(normalized.code))) {
      blockers.push(normalized)
    } else {
      warnings.push(normalized)
    }
  }
  if (inspection.technicalStatus === 'unchecked'
    && !blockers.some((item) => item.code === 'media-inspection-incomplete')) {
    blockers.push(issue('media-inspection-incomplete', '成片媒体检查未完成，不能判定为通过'))
  }
  return { blockers, warnings }
}

export function resolveCinematicAudioRenderIssues({ skipped = [] } = {}) {
  const failures = (Array.isArray(skipped) ? skipped : [])
    .filter((item) => Number(item?.audioId) > 0)
  const blockers = failures.map((item) => issue(
    'enabled-audio-download-failed',
    `音频资产 ${Number(item.audioId)} 无法读取：${text(item.reason) || '未知媒体错误'}`,
  ))
  const issueShotsById = new Map()
  for (const item of failures) {
    const storyboardId = Number(item?.storyboardId) || 0
    if (storyboardId <= 0 || issueShotsById.has(storyboardId)) continue
    issueShotsById.set(storyboardId, {
      storyboardId,
      code: 'enabled-audio-download-failed',
      message: `分镜 ${storyboardId} 的已启用音频无法读取：${text(item.reason) || '未知媒体错误'}`,
    })
  }
  return { blockers, issueShots: [...issueShotsById.values()] }
}

export function evaluateCinematicQuality({ plan = {}, sources = [], rendered = {} } = {}) {
  const blockers = []
  const warnings = []
  const issueShots = Array.isArray(rendered.issueShots) ? rendered.issueShots.filter(Boolean) : []
  const planClips = Array.isArray(plan?.clips) ? plan.clips : []
  const sourceStoryboardIds = new Set(
    (Array.isArray(sources) ? sources : []).map((source) => Number(source?.storyboardId)).filter((id) => id > 0),
  )

  if (rendered.outputExists !== true) blockers.push(issue('missing-output', '成片文件不存在，不能标记为完成'))
  if (!(Number(rendered.durationSeconds) > 0)) blockers.push(issue('invalid-duration', '成片没有有效时长'))
  for (const clip of planClips) {
    const storyboardId = Number(clip?.storyboardId)
    if (storyboardId > 0 && !sourceStoryboardIds.has(storyboardId)) {
      blockers.push(issue('missing-storyboard', `成片计划中的分镜 ${storyboardId} 没有可追溯源素材`))
    }
  }
  for (const item of Array.isArray(rendered.blockingIssues) ? rendered.blockingIssues : []) {
    blockers.push(issue(item?.code, item?.message, item?.severity || 'blocker'))
  }
  for (const item of issueShots) {
    const shotIssue = issue(item.code || 'issue-shot', item.message || `分镜 ${item.storyboardId || ''} 存在质量问题`)
    if (!blockers.some((existing) => existing.code === shotIssue.code && existing.message === shotIssue.message)) {
      blockers.push(shotIssue)
    }
  }
  for (const item of Array.isArray(rendered.warnings) ? rendered.warnings : []) {
    warnings.push(issue(item?.code, item?.message, 'warning'))
  }

  const recommendations = [...new Set(blockers.map(recommendationFor))]
  return {
    passed: blockers.length === 0,
    status: blockers.length ? 'blocked' : 'passed',
    summary: blockers.length
      ? `成片质量门禁阻止完成：${blockers.length} 个问题需要处理`
      : warnings.length
        ? `成片质量门禁通过，但有 ${warnings.length} 个提示`
        : '成片质量门禁通过',
    blockers,
    warnings,
    issueShots,
    recommendations,
    checkedAt: new Date().toISOString(),
    evidence: {
      planVersion: text(plan?.planVersion),
      sourceStoryboardCount: sourceStoryboardIds.size,
      renderedDurationSeconds: Number(rendered.durationSeconds) || 0,
      outputExists: rendered.outputExists === true,
    },
  }
}
