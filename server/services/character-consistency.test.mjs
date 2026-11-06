import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCharacterConsistencyReport,
  buildCharacterProductionSnapshot,
  decideCharacterVersion,
  getCharacterMutationEffects,
  getCharacterProductionReadiness,
  getLockInvalidation,
  normalizeRegressionSampleInput,
} from './character-consistency.mjs'

const readyCharacter = {
  id: 7,
  project_id: 11,
  name: '沈砚',
  role_tag: '主角',
  personality: '克制、敏锐，在压力下仍然会做出选择。',
  appearance: '黑发，清瘦脸型，左眉有浅疤，冷静目光。',
  costume: '深灰长风衣，银色旧怀表固定挂在胸前。',
  age_group: 'young_adult',
  gender: 'male',
  voice_style: '低沉克制，语速稳定。',
  voice_profile_key: 'male_calm_01',
  voice_setting: 'Ethan',
  voice_locked: 1,
  appearance_locked: 1,
  costume_locked: 1,
  reference_image_url: 'https://example.com/shenyan.png',
  status: 'finalized',
}

test('builds a complete production snapshot with deterministic constraint text', () => {
  const snapshot = buildCharacterProductionSnapshot(readyCharacter, {
    versionNo: 3,
    changeReason: '确认新版定妆图和服装',
  })

  assert.equal(snapshot.versionNo, 3)
  assert.equal(snapshot.characterId, 7)
  assert.equal(snapshot.projectId, 11)
  assert.deepEqual(snapshot.locks, {
    appearance: true,
    costume: true,
    voice: true,
  })
  assert.equal(snapshot.productionReady, true)
  assert.match(snapshot.constraintText, /沈砚/)
  assert.match(snapshot.constraintText, /深灰长风衣/)
  assert.match(snapshot.constraintText, /male_calm_01/)
  assert.equal(snapshot.changeReason, '确认新版定妆图和服装')
})

test('reports every missing baseline requirement and only becomes ready when all locks are valid', () => {
  const report = getCharacterProductionReadiness({
    ...readyCharacter,
    appearance: '',
    costume_locked: 0,
    voice_profile_key: null,
  })

  assert.equal(report.ready, false)
  assert.ok(report.blockers.some((item) => item.code === 'APPEARANCE_MISSING'))
  assert.ok(report.blockers.some((item) => item.code === 'COSTUME_UNLOCKED'))
  assert.ok(report.blockers.some((item) => item.code === 'VOICE_PROFILE_MISSING'))

  const ready = getCharacterProductionReadiness(readyCharacter)
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.blockers, [])
})

test('invalidates only the affected lock groups when production fields change', () => {
  assert.deepEqual(
    getLockInvalidation(['appearance']),
    { appearanceLocked: false, costumeLocked: undefined, voiceLocked: undefined },
  )
  assert.deepEqual(
    getLockInvalidation(['costume']),
    { appearanceLocked: undefined, costumeLocked: false, voiceLocked: undefined },
  )
  assert.deepEqual(
    getLockInvalidation(['voiceProfileKey', 'voiceSetting']),
    { appearanceLocked: undefined, costumeLocked: undefined, voiceLocked: false },
  )
  assert.deepEqual(
    getLockInvalidation(['gender', 'name']),
    { appearanceLocked: false, costumeLocked: undefined, voiceLocked: undefined },
  )
})

test('classifies character mutations for lock invalidation and immutable version sync', () => {
  assert.deepEqual(
    getCharacterMutationEffects(['costume', 'voiceStyle', 'voiceStyle']),
    {
      fields: ['costume', 'voiceStyle'],
      affectedGroups: ['costume', 'voice'],
      invalidation: {
        appearanceLocked: undefined,
        costumeLocked: false,
        voiceLocked: false,
      },
      requiresVersionSync: true,
    },
  )

  assert.deepEqual(
    getCharacterMutationEffects(['name', 'personality']),
    {
      fields: ['name', 'personality'],
      affectedGroups: [],
      invalidation: {
        appearanceLocked: undefined,
        costumeLocked: undefined,
        voiceLocked: undefined,
      },
      requiresVersionSync: true,
    },
  )

  assert.deepEqual(getCharacterMutationEffects([]), {
    fields: [],
    affectedGroups: [],
    invalidation: {
      appearanceLocked: undefined,
      costumeLocked: undefined,
      voiceLocked: undefined,
    },
    requiresVersionSync: false,
  })
})

test('project consistency report blocks stale regression samples and summarizes readiness', () => {
  const report = buildCharacterConsistencyReport({
    characters: [
      readyCharacter,
      {
        ...readyCharacter,
        id: 8,
        name: '程默',
        voice_profile_key: null,
        voice_locked: 0,
      },
    ],
    versions: [
      { characterId: 7, versionNo: 3, productionReady: true },
      { characterId: 8, versionNo: 1, productionReady: false },
    ],
    samples: [
      {
        characterId: 7,
        versionNo: 2,
        sampleType: 'storyboard_image',
        assetUrl: 'https://example.com/old.png',
      },
      {
        characterId: 7,
        versionNo: 3,
        sampleType: 'character_image',
        assetUrl: 'https://example.com/base.png',
      },
    ],
  })

  assert.equal(report.ready, false)
  assert.deepEqual(report.summary, {
    totalCharacters: 2,
    readyCharacters: 1,
    blockedCharacters: 1,
    regressionSamples: 2,
    staleSamples: 1,
  })
  assert.ok(report.blockers.some((item) => item.code === 'STALE_REGRESSION_SAMPLE'))
  assert.ok(report.characters.find((item) => item.characterId === 8).blockers.some(
    (item) => item.code === 'VOICE_PROFILE_MISSING',
  ))
})

test('creates a new immutable version only when production-facing fields change', () => {
  const unchanged = decideCharacterVersion(readyCharacter, {
    versionNo: 3,
    snapshot: buildCharacterProductionSnapshot(readyCharacter, { versionNo: 3 }),
  })

  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.versionNo, 3)
  assert.equal(unchanged.snapshot.versionNo, 3)

  const changed = decideCharacterVersion(
    { ...readyCharacter, costume: '黑色短外套，银色旧怀表固定挂在胸前。' },
    {
      versionNo: 3,
      snapshot: buildCharacterProductionSnapshot(readyCharacter, { versionNo: 3 }),
    },
    { changeReason: '服装设定调整' },
  )

  assert.equal(changed.changed, true)
  assert.equal(changed.versionNo, 4)
  assert.equal(changed.snapshot.costume, '黑色短外套，银色旧怀表固定挂在胸前。')
  assert.equal(changed.snapshot.changeReason, '服装设定调整')
})

test('normalizes supported regression samples and rejects unsafe or unknown inputs', () => {
  assert.deepEqual(
    normalizeRegressionSampleInput({
      sampleType: 'storyboard_image',
      assetUrl: ' https://example.com/frame.png ',
      versionNo: '4',
      sourceId: '81',
      note: '主角正面半身',
    }),
    {
      sampleType: 'storyboard_image',
      assetUrl: 'https://example.com/frame.png',
      versionNo: 4,
      sourceId: 81,
      note: '主角正面半身',
    },
  )

  assert.throws(
    () => normalizeRegressionSampleInput({
      sampleType: 'unknown',
      assetUrl: 'https://example.com/frame.png',
      versionNo: 1,
    }),
    /回归样例类型无效/,
  )
  assert.throws(
    () => normalizeRegressionSampleInput({
      sampleType: 'video_frame',
      assetUrl: 'javascript:alert\(1\)',
      versionNo: 1,
    }),
    /回归样例地址无效/,
  )
})
