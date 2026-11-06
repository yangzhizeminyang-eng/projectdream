/**
 * @file 内容实验领域服务
 * @description 把题材机会卡转换为三集试制实验草稿。
 */

function requiredText(value) {
  return String(value ?? '').trim()
}

function fallbackText(value, fallback) {
  return requiredText(value) || fallback
}

function parseOpportunityId(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

export function buildThreeEpisodeExperimentDraft(opportunity) {
  const sourceOpportunityId = parseOpportunityId(opportunity?.id)
  if (!sourceOpportunityId) throw new Error('题材机会缺少有效 ID')

  const topic = requiredText(opportunity?.topic)
  if (!topic) throw new Error('题材机会缺少题材方向')

  const title = fallbackText(opportunity?.title, `${topic}试制`)
  const platform = fallbackText(opportunity?.platform, '红果')
  const audience = fallbackText(opportunity?.audience, '移动端短剧观众')
  const logline = fallbackText(
    opportunity?.logline,
    `围绕“${topic}”制作三集原创竖屏漫剧样片，验证开头、角色和连续追更潜力。`,
  )
  const hypothesis = fallbackText(
    opportunity?.hypothesis,
    '先用三集连续样片验证题材、开头、角色稳定性和生产成本，再决定是否扩展为十集小季。',
  )
  const differentiation = requiredText(opportunity?.differentiation)
  const risk = requiredText(opportunity?.risk)
  const visualStyle = fallbackText(opportunity?.recommendedFormat, '9:16 3D 漫系列')
  const episodePlan = ['第1集', '第2集', '第3集']

  return {
    sourceOpportunityId,
    idempotencyKey: `topic-opportunity:${sourceOpportunityId}:three-episode-pilot`,
    experiment: {
      name: `${title} · 三集试制`,
      platform,
      audience,
      topic,
      promise: logline,
      hypothesis,
      budget: null,
      status: 'draft',
      decision: null,
      notes: [
        differentiation ? `原创差异：${differentiation}` : '',
        risk ? `主要风险：${risk}` : '',
        '系统默认生成两个开头版本，用三集连续样片验证，不代表平台收益承诺。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    variants: [
      {
        label: '开头 A · 危机先行',
        openingType: '危机先行',
        coverVersion: '封面 A',
        titleVersion: `${title}｜危机版`,
        visualStyle,
        episodePlan,
      },
      {
        label: '开头 B · 身份揭露',
        openingType: '身份揭露',
        coverVersion: '封面 B',
        titleVersion: `${title}｜身份版`,
        visualStyle,
        episodePlan,
      },
    ],
  }
}

