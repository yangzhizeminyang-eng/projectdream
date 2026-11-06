import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildVideoCharacterEvidence,
  buildCharacterSnapshotPrompt,
  buildAudioCharacterSnapshot,
  compareCharacterSnapshotVersions,
  parseCharacterAssetSnapshot,
} from './asset-version-consistency.mjs'

test('parses JSON and object character snapshots consistently', () => {
  const snapshot = {
    version: 1,
    characters: [
      { characterId: 11, characterVersionNo: 3, name: '沈砚' },
    ],
  }

  assert.deepEqual(parseCharacterAssetSnapshot(JSON.stringify(snapshot)), snapshot)
  assert.deepEqual(parseCharacterAssetSnapshot(snapshot), snapshot)
  assert.equal(parseCharacterAssetSnapshot('invalid-json'), null)
})

test('accepts a frame snapshot when every character uses the active version', () => {
  const result = compareCharacterSnapshotVersions(
    {
      version: 1,
      characters: [
        { characterId: 11, characterVersionNo: 3 },
        { characterId: 12, characterVersionNo: 2 },
      ],
    },
    new Map([
      [11, 3],
      [12, 2],
    ]),
  )

  assert.equal(result.ready, true)
  assert.deepEqual(result.stale, [])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.characterVersionNos, { 11: 3, 12: 2 })
})

test('blocks a frame snapshot when one character version is stale', () => {
  const result = compareCharacterSnapshotVersions(
    {
      version: 1,
      characters: [{ characterId: 11, characterVersionNo: 3, name: '沈砚' }],
    },
    new Map([[11, 4]]),
  )

  assert.equal(result.ready, false)
  assert.equal(result.stale.length, 1)
  assert.match(result.stale[0].message, /沈砚/)
  assert.match(result.stale[0].message, /v3/)
  assert.match(result.stale[0].message, /v4/)
})

test('allows legacy snapshots without version numbers but records a warning', () => {
  const result = compareCharacterSnapshotVersions(
    {
      version: 1,
      characters: [{ characterId: 11, name: '沈砚' }],
    },
    new Map([[11, 4]]),
  )

  assert.equal(result.ready, true)
  assert.deepEqual(result.stale, [])
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /缺少角色版本号/)
})

test('audio snapshots preserve the locked character baseline and version', () => {
  const snapshot = buildAudioCharacterSnapshot(
    {
      id: 11,
      project_id: 7,
      name: '沈砚',
      role_tag: '女主角',
      personality: '克制、敏锐',
      appearance: '黑色短发，右眉细疤',
      costume: '深灰制服，银色识别牌',
      age_group: 'young_adult',
      gender: 'female',
      voice_style: '低沉克制',
      voice_profile_key: 'female_calm_01',
      voice_setting: '清晰女声',
      appearance_locked: 1,
      costume_locked: 1,
      voice_locked: 1,
      reference_image_url: 'https://example.com/shenyan.png',
    },
    5,
  )

  assert.equal(snapshot.characterVersionNo, 5)
  assert.equal(snapshot.costume, '深灰制服，银色识别牌')
  assert.equal(snapshot.voiceProfileKey, 'female_calm_01')
  assert.equal(snapshot.productionReady, true)
})

test('video prompt includes the confirmed frame character constraints', () => {
  const prompt = buildCharacterSnapshotPrompt({
    version: 1,
    characters: [
      {
        characterId: 11,
        characterVersionNo: 5,
        name: '沈砚',
        isPrimary: true,
        genderLabel: '女性',
        ageGroupLabel: '青年（19-35岁）',
        appearance: '黑色短发，右眉细疤',
        costume: '深灰制服，银色识别牌',
      },
    ],
  })

  assert.match(prompt, /沈砚/)
  assert.match(prompt, /角色版本=v5/)
  assert.match(prompt, /固定服装与随身物件=深灰制服，银色识别牌/)
  assert.match(prompt, /只能沿用静帧中的角色身份/)
})

test('video evidence keeps the source snapshot and explicit version map', () => {
  const result = buildVideoCharacterEvidence({
    characterSnapshot: {
      version: 1,
      characters: [
        { characterId: 11, characterVersionNo: 5, name: '沈砚' },
        { characterId: 12, characterVersionNo: 2, name: '林夏' },
      ],
    },
    characterVersionNos: { 11: 5, 12: 2 },
  })

  assert.deepEqual(result.characterVersionNos, { 11: 5, 12: 2 })
  assert.deepEqual(result.characterSnapshot.characters, [
    { characterId: 11, characterVersionNo: 5, name: '沈砚' },
    { characterId: 12, characterVersionNo: 2, name: '林夏' },
  ])
})

test('video evidence does not invent version numbers for legacy snapshots', () => {
  const result = buildVideoCharacterEvidence({
    characterSnapshot: {
      version: 1,
      characters: [{ characterId: 11, name: '沈砚' }],
    },
    characterVersionNos: { 11: 7 },
  })

  assert.deepEqual(result.characterVersionNos, {})
  assert.equal(result.characterSnapshot.characters[0].characterVersionNo, undefined)
})
