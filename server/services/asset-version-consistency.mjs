import {
  buildCharacterProductionSnapshot,
} from './character-consistency.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function numberOrNull(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function parseCharacterAssetSnapshot(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function snapshotCharacters(snapshot) {
  return Array.isArray(snapshot?.characters) ? snapshot.characters : []
}

function activeVersionMap(currentVersions) {
  if (currentVersions instanceof Map) return currentVersions
  const map = new Map()
  for (const item of Array.isArray(currentVersions) ? currentVersions : []) {
    const characterId = numberOrNull(item?.characterId ?? item?.character_id ?? item?.id)
    const versionNo = numberOrNull(item?.versionNo ?? item?.version_no)
    if (characterId && versionNo) map.set(characterId, versionNo)
  }
  return map
}

function snapshotCharacterVersion(character) {
  return numberOrNull(
    character?.characterVersionNo ??
      character?.character_version_no ??
      character?.versionNo ??
      character?.version_no,
  )
}

export function buildVideoCharacterEvidence({
  characterSnapshot,
  characterVersionNos,
} = {}) {
  const snapshot = parseCharacterAssetSnapshot(characterSnapshot)
  const characters = snapshotCharacters(snapshot)
  const versionMap = {}
  const normalizedCharacters = characters.map((character) => {
    const versionNo = snapshotCharacterVersion(character)
    const normalized = { ...character }
    if (versionNo) {
      normalized.characterVersionNo = versionNo
      const characterId = numberOrNull(character?.characterId ?? character?.character_id)
      if (characterId) versionMap[characterId] = versionNo
    }
    return normalized
  })

  return {
    version: 1,
    source: snapshot ? 'confirmed-image-snapshot' : 'legacy-missing-snapshot',
    characterSnapshot: snapshot
      ? { ...snapshot, characters: normalizedCharacters }
      : null,
    characterVersionNos: versionMap,
    hasVersionEvidence: characters.length > 0 && characters.every((character) => {
      return Boolean(snapshotCharacterVersion(character))
    }),
    requestedCharacterVersionNos:
      characterVersionNos && typeof characterVersionNos === 'object'
        ? { ...characterVersionNos }
        : {},
  }
}

export function compareCharacterSnapshotVersions(snapshotValue, currentVersions) {
  const snapshot = parseCharacterAssetSnapshot(snapshotValue)
  if (!snapshot) {
    return {
      ready: true,
      stale: [],
      warnings: ['资产没有角色一致性快照，无法验证角色版本；历史资产暂按兼容模式处理'],
      characterVersionNos: {},
    }
  }

  const versions = activeVersionMap(currentVersions)
  const stale = []
  const warnings = []
  const characterVersionNos = {}

  for (const character of snapshotCharacters(snapshot)) {
    const characterId = numberOrNull(character?.characterId ?? character?.character_id)
    if (!characterId) continue
    const snapshotVersionNo = snapshotCharacterVersion(character)
    const currentVersionNo = versions.get(characterId)
    if (snapshotVersionNo) {
      characterVersionNos[characterId] = snapshotVersionNo
    }
    if (!currentVersionNo) {
      warnings.push(
        `角色“${text(character?.name) || characterId}”当前没有可用的 active 版本，无法完成版本比对`,
      )
      continue
    }
    if (!snapshotVersionNo) {
      warnings.push(
        `角色“${text(character?.name) || characterId}”的资产快照缺少角色版本号，历史资产暂按兼容模式处理`,
      )
      continue
    }
    if (snapshotVersionNo !== currentVersionNo) {
      stale.push({
        characterId,
        name: text(character?.name) || `角色 ${characterId}`,
        snapshotVersionNo,
        currentVersionNo,
        message: `角色“${text(character?.name) || characterId}”使用了旧角色版本 v${snapshotVersionNo}，当前生产基线为 v${currentVersionNo}，请重新生成静帧`,
      })
    }
  }

  return {
    ready: stale.length === 0,
    stale,
    warnings: [...new Set(warnings)],
    characterVersionNos,
  }
}

export function buildAudioCharacterSnapshot(character, characterVersionNo) {
  const snapshot = buildCharacterProductionSnapshot(character, {
    versionNo: numberOrNull(characterVersionNo) || 1,
    changeReason: '音频生成时锁定角色生产基线',
  })
  return {
    version: 1,
    assetType: 'audio',
    characterVersionNo: snapshot.versionNo,
    characterId: snapshot.characterId,
    projectId: snapshot.projectId,
    name: snapshot.name,
    roleTag: snapshot.roleTag,
    personality: snapshot.personality,
    appearance: snapshot.appearance,
    costume: snapshot.costume,
    ageGroup: snapshot.ageGroup,
    gender: snapshot.gender,
    voiceStyle: snapshot.voiceStyle,
    voiceProfileKey: snapshot.voiceProfileKey,
    voiceSetting: snapshot.voiceSetting,
    referenceImageUrl: snapshot.referenceImageUrl,
    locks: snapshot.locks,
    productionReady: snapshot.productionReady,
  }
}

export function buildCharacterSnapshotPrompt(snapshotValue) {
  const snapshot = parseCharacterAssetSnapshot(snapshotValue)
  const characters = snapshotCharacters(snapshot)
  if (!characters.length) return ''

  const lines = characters.map((character, index) => {
    const versionNo = snapshotCharacterVersion(character)
    return [
      `${index + 1}. ${text(character.name) || `角色 ${character.characterId}`}${character.isPrimary ? '（主要主体）' : '（同框角色）'}`,
      versionNo ? `角色版本=v${versionNo}` : '角色版本=历史快照未记录',
      character.genderLabel ? `性别=${character.genderLabel}` : '',
      character.ageGroupLabel ? `年龄=${character.ageGroupLabel}` : '',
      character.appearance ? `固定外貌=${character.appearance}` : '',
      character.costume ? `固定服装与随身物件=${character.costume}` : '',
      character.referenceImageUrl ? `定妆参考图=${character.referenceImageUrl}` : '',
    ]
      .filter(Boolean)
      .join('；')
  })

  return [
    '【确认静帧角色一致性约束】',
    lines.join('\n'),
    '视频只能沿用静帧中的角色身份、脸型、五官、发型、体态、固定服装和随身物件，只允许表现连续动作与镜头运动，不得新增、替换、换脸、改龄或改性别。',
  ].join('\n')
}
