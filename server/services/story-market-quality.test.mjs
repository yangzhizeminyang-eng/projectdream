import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateMarketSeasonQuality,
  evaluateMarketEpisodeQuality,
} from './story-market-quality.mjs'

function strongEpisode(overrides = {}) {
  return {
    episodeNo: 1,
    title: '雨夜来信',
    logline: '失踪三年的弟弟突然发来一段录音。',
    openingHook: '停电的广播站里，已经失踪三年的弟弟突然开口求救。',
    goal: '确认录音是否来自弟弟并找到原始磁带。',
    coreConflict: '反派封锁广播站，逼主角在公开证据和救回弟弟之间选择。',
    irreversibleChange: '主角失去记者身份，且被全网指认为伪造证据。',
    endingHook: '录音底噪里传来主角从未说过的一句秘密。',
    protagonistChoice: '她拒绝交换证据，冒雨闯入封锁的地下档案库。',
    reversal: '线索从弟弟失踪案转向主角本人曾经删掉的采访。',
    visualSetPieces: ['停电广播站', '地下档案库追逐'],
    ...overrides,
  }
}

test('market episode quality requires a concrete hook, active choice, reversal and ending hook', () => {
  const report = evaluateMarketEpisodeQuality(strongEpisode())

  assert.equal(report.canPass, true)
  assert.ok(report.score >= 80)
  assert.equal(report.blockers.length, 0)
  assert.ok(report.dimensions.some((item) => item.key === 'opening-hook'))
})

test('market episode quality blocks vague opening and passive ending', () => {
  const report = evaluateMarketEpisodeQuality(
    strongEpisode({
      openingHook: '故事开始了。',
      protagonistChoice: '她等待事情发生。',
      reversal: '',
      endingHook: '这一集结束了。',
      visualSetPieces: [],
    }),
  )

  assert.equal(report.canPass, false)
  assert.ok(report.blockers.some((item) => item.field === 'openingHook'))
  assert.ok(report.blockers.some((item) => item.field === 'protagonistChoice'))
  assert.ok(report.blockers.some((item) => item.field === 'reversal'))
  assert.ok(report.blockers.some((item) => item.field === 'endingHook'))
})

test('market season quality requires every sampled episode to clear the content gate', () => {
  const report = evaluateMarketSeasonQuality({
    episodeCount: 2,
    episodes: [
      strongEpisode({ episodeNo: 1 }),
      strongEpisode({
        episodeNo: 2,
        title: '假证词',
        openingHook: '关键证人当众改口，反过来指认主角是凶手。',
        endingHook: '反派发来一张弟弟还活着的照片。',
      }),
    ],
  })

  assert.equal(report.canPass, true)
  assert.equal(report.episodeReports.length, 2)
  assert.equal(report.blockers.length, 0)
})
