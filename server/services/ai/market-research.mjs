/**
 * @file 市场研究 Agent
 * @description 根据人工录入的市场样本提炼题材模式、差异化方向和低成本试制计划。
 *              Agent 只生成研究建议，不直接决定发布，也不复制样本内容。
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { generateStructuredJson } from './provider.mjs'

const ALLOWED_PLATFORMS = new Set(['红果', '抖音', '快手', '视频号', '其他'])

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function number(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeSample(sample, index) {
  return {
    id: number(sample.id, index + 1),
    platform: ALLOWED_PLATFORMS.has(text(sample.platform)) ? text(sample.platform) : '其他',
    workTitle: text(sample.workTitle, `样本 ${index + 1}`),
    topic: text(sample.topic, '未分类'),
    visualStyle: text(sample.visualStyle, '未记录'),
    protagonistIdentity: text(sample.protagonistIdentity, '未记录'),
    openingType: text(sample.openingType, '未记录'),
    endingHook: text(sample.endingHook, '未记录'),
    titlePattern: text(sample.titlePattern, '未记录'),
    coverPattern: text(sample.coverPattern, '未记录'),
    commentNotes: text(sample.commentNotes, '未记录'),
    confidence: text(sample.confidence, 'fact'),
    tags: normalizeArray(sample.tags).map((item) => text(item)).filter(Boolean).slice(0, 20),
  }
}

function countValues(samples, key) {
  const counts = new Map()
  for (const sample of samples) {
    const value = text(sample[key], '未记录')
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .map(([value, count]) => ({ value, count }))
}

function buildMockResearch(samples) {
  const topics = countValues(samples, 'topic')
  const openings = countValues(samples, 'openingType')
  const styles = countValues(samples, 'visualStyle')
  const platforms = countValues(samples, 'platform')
  const leadTopic = topics[0]?.value || '原创身份反转'
  const leadPlatform = platforms[0]?.value || '红果'
  const leadStyle = styles[0]?.value || '3D 漫'
  const openingA = openings[0]?.value || '危机先行'
  const openingB = openings[1]?.value || '身份揭露'

  return {
    analysisSummary: `本次分析基于 ${samples.length} 个人工录入样本。当前样本最集中的方向是“${leadTopic}”，常见开头为“${openingA}”，视觉方向以“${leadStyle}”为主。该结论只能作为第一轮试制假设，不能直接视为平台收益预测。`,
    evidenceQuality: samples.every((sample) => sample.confidence === 'fact' || sample.confidence === 'reported')
      ? 'medium'
      : 'low',
    patterns: [
      {
        name: '高频题材',
        evidence: topics.slice(0, 5).map((item) => `${item.value}（${item.count}个样本）`).join('、'),
        confidence: topics.length ? 'medium' : 'low',
      },
      {
        name: '开头模式',
        evidence: openings.slice(0, 5).map((item) => `${item.value}（${item.count}个样本）`).join('、'),
        confidence: openings.length ? 'medium' : 'low',
      },
      {
        name: '视觉模式',
        evidence: styles.slice(0, 5).map((item) => `${item.value}（${item.count}个样本）`).join('、'),
        confidence: styles.length ? 'medium' : 'low',
      },
    ],
    topicOpportunities: [
      {
        title: `${leadTopic}·原创身份差异化试制`,
        platform: leadPlatform,
        audience: '喜欢强冲突、身份反转和连续追更的移动端观众',
        topic: leadTopic,
        logline: `一个被低估的普通人，在${leadTopic}背景下被迫公开隐藏身份，并用一次选择改变关系秩序。`,
        hypothesis: `保留“${leadTopic}”的情绪承诺，但把主角职业、核心秘密和视觉符号改成原创组合，先验证三集连续样片。`,
        differentiation: '采用原创主角职业、原创关键道具和原创世界规则，避免复刻样本人物关系。',
        risk: '题材同质化；如果角色动机和视觉符号不够独特，容易被观众认为是换皮内容。',
        recommendedFormat: `9:16 ${leadStyle}系列漫剧`,
        score: 78,
      },
      {
        title: `${leadTopic}·双开头对照实验`,
        platform: leadPlatform,
        audience: '偏好快速进入冲突的短视频观众',
        topic: leadTopic,
        logline: '同一原创故事分别使用危机先行和身份揭露开头，比较首段留存和评论反馈。',
        hypothesis: `用“${openingA}”和“${openingB}”各做一个开头版本，只改变开头，不同时改动人物和结局。`,
        differentiation: '通过实验验证开头变量，而不是凭感觉决定整部剧结构。',
        risk: '样本量过小会造成误判；两个开头必须保证后续内容质量一致。',
        recommendedFormat: '3集连续样片 + 2个开头版本',
        score: 74,
      },
    ],
    experimentPlan: [
      {
        topicTitle: `${leadTopic}·原创身份差异化试制`,
        openingVariants: [openingA, openingB],
        visualStyle: leadStyle,
        episodeCount: 3,
        reason: '先验证连续性、人物稳定性和开头差异，不直接扩展整季。',
      },
    ],
  }
}

function buildPrompts(samples, options = {}) {
  const platform = text(options.platform, '红果和抖音')
  const sampleJson = JSON.stringify(samples, null, 2)

  return {
    systemPrompt: [
      '你是 AI 漫剧内容工厂的市场研究 Agent。',
      '你的任务是从人工录入的公开样本中提炼可验证的创作假设，不复制具体作品。',
      '不要声称任何平台保证流量、签约或收益。',
      '不要把样本中的人物、剧情、标题或画面直接改写成新作品。',
      '必须区分事实观察、归纳推断和待验证假设。',
      '只返回合法 JSON，不要输出 Markdown、解释或代码块。',
      'JSON 顶层字段必须包含 analysisSummary、evidenceQuality、patterns、topicOpportunities、experimentPlan。',
    ].join('\n'),
    userPrompt: [
      `目标平台：${platform}`,
      `样本数量：${samples.length}`,
      '请完成以下任务：',
      '1. 提炼不超过 6 个可解释的题材、开头、视觉或评论模式。',
      '2. 输出 2-5 个原创题材机会卡，每张卡必须包含 title、platform、audience、topic、logline、hypothesis、differentiation、risk、recommendedFormat、score。',
      '3. 输出第一轮低成本实验计划，每个计划包含 topicTitle、openingVariants、visualStyle、episodeCount、reason。',
      '4. score 只能代表内部试制优先级，不代表播放量或收益预测。',
      '5. 如果样本不足，要明确降低 evidenceQuality，并在 analysisSummary 中说明。',
      `样本数据：\n${sampleJson}`,
    ].join('\n'),
  }
}

function normalizeResearchPayload(payload, samples) {
  const sourceCount = samples.length
  const patterns = normalizeArray(payload?.patterns)
    .map((item) => ({
      name: text(item?.name, '未命名模式'),
      evidence: text(item?.evidence, '未提供证据'),
      confidence: text(item?.confidence, 'low'),
    }))
    .slice(0, 6)

  const topicOpportunities = normalizeArray(payload?.topicOpportunities)
    .map((item, index) => ({
      title: text(item?.title, `原创试制方向 ${index + 1}`),
      platform: text(item?.platform, '红果'),
      audience: text(item?.audience, '移动端短剧观众'),
      topic: text(item?.topic, '原创身份反转'),
      logline: text(item?.logline),
      hypothesis: text(item?.hypothesis),
      differentiation: text(item?.differentiation),
      risk: text(item?.risk),
      recommendedFormat: text(item?.recommendedFormat, '9:16 竖屏系列漫剧'),
      score: Math.max(0, Math.min(100, number(item?.score, 0))),
      sourceObservationCount: sourceCount,
    }))
    .slice(0, 5)

  const experimentPlan = normalizeArray(payload?.experimentPlan)
    .map((item) => ({
      topicTitle: text(item?.topicTitle, '未命名题材'),
      openingVariants: normalizeArray(item?.openingVariants)
        .map((entry) => text(entry))
        .filter(Boolean)
        .slice(0, 4),
      visualStyle: text(item?.visualStyle, '3D 漫'),
      episodeCount: Math.max(1, Math.min(10, Math.round(number(item?.episodeCount, 3)))),
      reason: text(item?.reason, '先用小规模连续样片验证'),
    }))
    .slice(0, 5)

  return {
    analysisSummary: text(
      payload?.analysisSummary,
      `基于 ${sourceCount} 个样本生成的市场研究结果。`,
    ),
    evidenceQuality: text(payload?.evidenceQuality, sourceCount >= 10 ? 'medium' : 'low'),
    patterns,
    topicOpportunities,
    experimentPlan,
  }
}

export async function analyzeMarketSamples(samples, options = {}) {
  const normalizedSamples = normalizeArray(samples).map(normalizeSample).slice(0, 50)
  if (!normalizedSamples.length) {
    throw new Error('至少录入 1 个市场样本后才能分析')
  }

  const config = getAiConfig()
  if (isMockProvider(config)) {
    return {
      ...buildMockResearch(normalizedSamples),
      provider: 'mock',
      model: 'mock-market-research',
      inputCount: normalizedSamples.length,
      inputSamples: normalizedSamples,
      rawOutput: null,
    }
  }

  const { systemPrompt, userPrompt } = buildPrompts(normalizedSamples, options)
  const result = await generateStructuredJson({
    task: 'market-research',
    systemPrompt,
    userPrompt,
    model: config.defaultModel,
    temperature: 0.35,
  })
  const normalized = normalizeResearchPayload(result.json, normalizedSamples)

  return {
    ...normalized,
    provider: config.provider,
    model: config.defaultModel,
    inputCount: normalizedSamples.length,
    inputSamples: normalizedSamples,
    rawOutput: result.json,
  }
}

