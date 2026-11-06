import test from 'node:test'
import assert from 'node:assert/strict'
import { buildThreeEpisodeExperimentDraft } from './content-experiment.mjs'

test('builds a three-episode experiment with two opening variants from a topic opportunity', () => {
  const draft = buildThreeEpisodeExperimentDraft({
    id: 12,
    title: '重生逆袭·原创身份差异化试制',
    platform: '红果',
    audience: '喜欢强冲突和连续追更的移动端观众',
    topic: '重生逆袭',
    logline: '被低估的主角公开隐藏身份，改变关系秩序。',
    hypothesis: '先用三集验证连续性和开头留存。',
    differentiation: '原创职业、原创道具和原创世界规则。',
    recommendedFormat: '9:16 3D 漫系列',
  })

  assert.equal(draft.sourceOpportunityId, 12)
  assert.equal(draft.experiment.platform, '红果')
  assert.equal(draft.experiment.topic, '重生逆袭')
  assert.equal(draft.experiment.promise, '被低估的主角公开隐藏身份，改变关系秩序。')
  assert.equal(draft.experiment.status, 'draft')
  assert.equal(draft.variants.length, 2)
  assert.deepEqual(draft.variants[0].episodePlan, ['第1集', '第2集', '第3集'])
  assert.deepEqual(draft.variants[1].episodePlan, ['第1集', '第2集', '第3集'])
  assert.notEqual(draft.variants[0].openingType, draft.variants[1].openingType)
  assert.match(draft.experiment.notes, /原创职业/)
})

test('uses a stable idempotency key for the same opportunity', () => {
  const first = buildThreeEpisodeExperimentDraft({ id: 99, title: '题材卡', topic: '都市反转' })
  const second = buildThreeEpisodeExperimentDraft({ id: 99, title: '题材卡', topic: '都市反转' })

  assert.equal(first.idempotencyKey, 'topic-opportunity:99:three-episode-pilot')
  assert.equal(second.idempotencyKey, first.idempotencyKey)
})

test('rejects an opportunity without an id or topic', () => {
  assert.throws(
    () => buildThreeEpisodeExperimentDraft({ title: '缺少来源', topic: '都市' }),
    /题材机会缺少有效 ID/,
  )
  assert.throws(
    () => buildThreeEpisodeExperimentDraft({ id: 1, title: '缺少题材' }),
    /题材机会缺少题材方向/,
  )
})
