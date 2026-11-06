import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateSeasonStructure,
  evaluateStoryBible,
  normalizeSeasonStructureInput,
  normalizeStoryBibleInput,
} from './story-quality.mjs'

function buildStrongBible() {
  return normalizeStoryBibleInput({
    title: '雨夜回声',
    logline: '失去声音的女记者追查一段被掩盖的录音，必须在城市停电前揭开真相。',
    audience: '喜欢悬疑、女性成长和强情绪反转的短剧观众',
    emotionalPromise: '每集都有新证据和反击，结尾留下必须追更的悬念。',
    worldRules: ['录音可以被篡改，但原始磁带会留下不可复制的底噪。'],
    timeline: ['故事发生在连续七天的暴雨季。'],
    locations: ['旧广播站', '地下档案库'],
    characters: [
      {
        name: '林澜',
        role: '主角',
        goal: '找到弟弟失踪前留下的原始录音',
        fear: '再次因为相信错误的人而失去家人',
        secret: '她曾主动删掉一段关键采访',
        growthArc: '从回避责任到公开承担真相代价',
        visualDescription: '短黑发、左耳银色助听器、深灰风衣',
      },
      {
        name: '沈砚',
        role: '反派',
        goal: '销毁档案并控制舆论',
        fear: '过去的身份被揭穿',
        secret: '他亲手制造了第一份假录音',
        growthArc: '从操控者走向失控',
        visualDescription: '三十岁左右、黑框眼镜、深色衬衫',
      },
    ],
    relationships: ['林澜曾经信任沈砚，后来发现两人站在真相两侧。'],
    props: ['带红色标签的原始磁带'],
    mainPlot: '林澜沿着录音线索进入旧广播站，与沈砚争夺能够证明真相的原始磁带。',
    subplots: ['林澜修复与母亲之间的关系。'],
    foreshadowing: ['第一集出现的底噪在第六集证明录音被调包。'],
    lockedFacts: ['林澜左耳佩戴银色助听器。'],
    flexibleFacts: ['地下档案库的具体入口可以调整。'],
    visualSymbols: ['红色磁带标签', '雨夜霓虹'],
  })
}

function buildStrongSeason() {
  return normalizeSeasonStructureInput({
    seasonTheme: '真相的代价',
    coreConflict: '林澜必须公开真相，而沈砚会用失踪案和舆论反噬她。',
    structureType: '三幕八集',
    episodeCount: 3,
    episodes: [
      {
        episodeNo: 1,
        title: '雨夜来信',
        logline: '林澜收到弟弟留下的异常录音。',
        openingHook: '录音里传来已经失踪三年的弟弟声音。',
        goal: '确认录音是否来自弟弟。',
        coreConflict: '沈砚试图阻止她接触旧广播站。',
        irreversibleChange: '林澜公开宣布重新调查失踪案。',
        endingHook: '录音底噪里出现她自己的声音。',
        protagonistChoice: '她选择冒雨进入封锁的旧广播站。',
        reversal: '线索从弟弟转向林澜本人。',
        visualSetPieces: ['停电广播站', '雨幕中的追车'],
      },
      {
        episodeNo: 2,
        title: '假证词',
        logline: '林澜发现所有证人都收到过同一份假录音。',
        openingHook: '关键证人当众改口指认林澜。',
        goal: '找出假录音的传播源头。',
        coreConflict: '林澜必须在被起诉前拿到原始磁带。',
        irreversibleChange: '她失去记者身份并被全网质疑。',
        endingHook: '沈砚发来一张弟弟还活着的照片。',
        protagonistChoice: '她拒绝交换证据，转而追查照片来源。',
        reversal: '照片日期早于弟弟失踪日期。',
        visualSetPieces: ['新闻发布会', '地下档案库追逐'],
      },
      {
        episodeNo: 3,
        title: '原始底噪',
        logline: '林澜用底噪锁定沈砚伪造录音的证据。',
        openingHook: '原始磁带在直播前突然被调包。',
        goal: '在直播开始前恢复原始证据。',
        coreConflict: '沈砚封锁广播站并切断所有出口。',
        irreversibleChange: '林澜把证据上传到公开网络。',
        endingHook: '直播结束后，真正的幕后资助者来电。',
        protagonistChoice: '她接受继续追查而不是立即离开城市。',
        reversal: '沈砚只是替幕后资助者执行计划。',
        visualSetPieces: ['直播控制室', '暴雨天台对峙'],
      },
    ],
    foreshadowingPlan: ['第一集底噪在第三集回收并锁定伪造来源。'],
    characterArcs: ['林澜从回避责任走向公开承担代价。'],
  })
}

test('strong story bible passes the lock gate with a high score', () => {
  const report = evaluateStoryBible(buildStrongBible())

  assert.equal(report.canLock, true)
  assert.equal(report.blockers.length, 0)
  assert.ok(report.score >= 90)
})

test('story bible blocks locking when core narrative facts are missing', () => {
  const report = evaluateStoryBible(
    normalizeStoryBibleInput({
      title: '未完成故事',
      logline: '一个人等待事情发生。',
    }),
  )

  assert.equal(report.canLock, false)
  assert.ok(report.blockers.some((item) => item.field === 'audience'))
  assert.ok(report.blockers.some((item) => item.field === 'characters'))
  assert.ok(report.blockers.some((item) => item.field === 'mainPlot'))
})

test('season structure blocks duplicate episodes and missing ending hooks', () => {
  const structure = normalizeSeasonStructureInput({
    seasonTheme: '真相',
    coreConflict: '主角和反派争夺证据。',
    episodeCount: 2,
    episodes: [
      {
        episodeNo: 1,
        title: '第一集',
        logline: '主角发现线索。',
        openingHook: '线索突然出现。',
        goal: '确认线索。',
        coreConflict: '反派阻拦。',
        irreversibleChange: '主角决定调查。',
        endingHook: '',
        protagonistChoice: '主角选择追查。',
      },
      {
        episodeNo: 1,
        title: '第二集',
        logline: '主角继续调查。',
        openingHook: '新的证据出现。',
        goal: '找到证人。',
        coreConflict: '反派继续阻拦。',
        irreversibleChange: '证人失踪。',
        endingHook: '反派发来威胁。',
        protagonistChoice: '主角决定公开证据。',
      },
    ],
  })

  const report = evaluateSeasonStructure(structure)

  assert.equal(report.canLock, false)
  assert.ok(report.blockers.some((item) => item.field === 'episodes[0].endingHook'))
  assert.ok(report.blockers.some((item) => item.field === 'episodes'))
})

test('complete season structure passes the quality gate', () => {
  const report = evaluateSeasonStructure(buildStrongSeason())

  assert.equal(report.canLock, true)
  assert.equal(report.blockers.length, 0)
  assert.ok(report.score >= 90)
  assert.equal(report.marketQuality.canPass, true)
  assert.ok(report.marketQuality.score >= 80)
})
