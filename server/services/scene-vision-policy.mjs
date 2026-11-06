const humanSubjectPattern = /人物|人影|人像|男性|女性|男孩|女孩|身影|肖像|人体|遗像|人形/u
const negativeContextPattern = /(?:没有|无|未见|未出现|禁止|不含|未包含|不存在)[^，。；;.!！？?]{0,12}$/u
const watermarkPattern = /水印|logo|标识|角标|平台标记|AI生成标记/u
const readableTextPattern = /可读文字|文字内容|中文文字|英文文字|字母|数字|字幕|按钮标签|屏幕文字|邮件内容|账号|乱码/u
const negativeContentPattern = /(?:没有|无|未见|未出现|禁止|不含|未包含|不存在|空白|无文字|无水印)[^，。；;.!！？?]{0,18}$/u
const allowedNarrativeTextPattern = /剧情(?:指定|需要|允许)(?:的)?标签|指定标签|道具标签|故事标签/u

// 场景图采用全景母图 + 固定空间提示词作为生产约束，不再调用视觉模型
// 阻断或重复生成。角色身份和道具内容仍继续使用各自的视觉门禁。
export const SCENE_VISION_CHECK_ENABLED = false

export function isSceneVisionCheckEnabled() {
  return SCENE_VISION_CHECK_ENABLED
}

/**
 * The scene contract is an empty environment. Vision models sometimes return
 * passed=true while describing a person in the reason; that contradiction is
 * a hard failure, not a warning.
 */
export function enforceEmptySceneVision(result = {}) {
  const reason = String(result.reason ?? '').trim()
  if (!result.passed || !humanSubjectPattern.test(reason)) return result
  const clauses = reason.split(/[，。；;.!！？?]/u)
  const positiveHumanClause = clauses.some((clause) =>
    humanSubjectPattern.test(clause) && !negativeContextPattern.test(clause.trim().slice(0, 40)),
  )
  if (!positiveHumanClause) return result
  return {
    ...result,
    passed: false,
    reason: `场景空场门禁拒绝人物污染：${reason}`,
  }
}

/**
 * Providers can return passed=true while their explanation still admits a
 * watermark or readable generated text. These are hard asset failures: the
 * image cannot become a production reference and retrying the same prompt
 * forever only burns image quota.
 */
export function enforceAssetContentVision(result = {}, { nodeType = '', scene = false } = {}) {
  const reason = String(result.reason ?? '').trim()
  if (!result.passed || !reason) return result

  const clauses = reason.split(/[，。；;.!！？?]/u)
  const hasPositive = (pattern) => clauses.some((clause) =>
    pattern.test(clause) && !negativeContentPattern.test(clause.trim().slice(0, 44)),
  )
  if (hasPositive(watermarkPattern)) {
    return {
      ...result,
      passed: false,
      contentIssue: 'watermark',
      reason: `资产内容门禁拒绝水印：${reason}`,
    }
  }
  const narrativeLabelIsAllowed = ['prop', 'material'].includes(String(nodeType))
    && allowedNarrativeTextPattern.test(reason)
    && !/乱码|随机文字|错误文字|水印|Logo|平台标记/u.test(reason)
  if (['scene', 'prop', 'material'].includes(String(nodeType))
    && hasPositive(readableTextPattern)
    && !narrativeLabelIsAllowed) {
    return {
      ...result,
      passed: false,
      contentIssue: 'readable-text',
      reason: `${scene ? '场景' : '道具'}内容门禁拒绝可读文字：${reason}`,
    }
  }
  return result
}

export function shouldStopAssetRetry(result = {}) {
  return ['watermark', 'readable-text'].includes(String(result.contentIssue || '').trim())
}
