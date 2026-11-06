import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMarketSamples } from './market-research.mjs'

test('market research agent returns auditable mock analysis from observations', async () => {
  const previousProvider = process.env.AI_PROVIDER
  process.env.AI_PROVIDER = 'mock'

  try {
    const result = await analyzeMarketSamples([
      {
        id: 11,
        platform: '红果',
        workTitle: '样本一',
        topic: '重生逆袭',
        visualStyle: '3D 漫',
        openingType: '危机先行',
        confidence: 'fact',
        tags: ['逆袭'],
      },
      {
        id: 12,
        platform: '抖音',
        workTitle: '样本二',
        topic: '重生逆袭',
        visualStyle: '3D 漫',
        openingType: '身份揭露',
        confidence: 'reported',
        tags: ['反转'],
      },
    ])

    assert.equal(result.provider, 'mock')
    assert.equal(result.inputCount, 2)
    assert.equal(result.inputSamples.length, 2)
    assert.ok(result.analysisSummary.includes('2 个人工录入样本'))
    assert.ok(result.topicOpportunities.length >= 1)
    assert.ok(result.experimentPlan.length >= 1)
  } finally {
    if (previousProvider === undefined) delete process.env.AI_PROVIDER
    else process.env.AI_PROVIDER = previousProvider
  }
})

test('market research agent rejects empty observation input', async () => {
  await assert.rejects(() => analyzeMarketSamples([]), /至少录入 1 个市场样本/)
})
