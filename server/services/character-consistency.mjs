const APPEARANCE_FIELDS = new Set([
  'appearance',
  'ageGroup',
  'age_group',
  'gender',
  'referenceImageUrl',
  'reference_image_url',
])

const COSTUME_FIELDS = new Set([
  'costume',
  'costumeDescription',
  'costume_description',
])

const VOICE_FIELDS = new Set([
  'voiceProfileKey',
  'voice_profile_key',
  'voiceSetting',
  'voice_setting',
  'voiceStyle',
  'voice_style',
])

const VERSION_FIELDS = new Set([
  'name',
  'roleTag',
  'role_tag',
  'personality',
  ...APPEARANCE_FIELDS,
  ...COSTUME_FIELDS,
  ...VOICE_FIELDS,
])

const REGRESSION_SAMPLE_TYPES = new Set([
  'character_image',
  'storyboard_image',
  'video_frame',
])

function text(value) {
  return String(value ?? '').trim()
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function firstValue(source, ...keys) {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key]
  }
  return null
}

function characterValue(character, camelKey, snakeKey = camelKey) {
  return firstValue(character, camelKey, snakeKey)
}

function lockValue(character, camelKey, snakeKey) {
  return bool(characterValue(character, camelKey, snakeKey))
}

function blocker(code, message) {
  return { code, message, severity: 'blocker' }
}

function warning(code, message) {
  return { code, message, severity: 'warning' }
}

export function getCharacterProductionReadiness(character = {}) {
  const name = text(characterValue(character, 'name'))
  const appearance = text(characterValue(character, 'appearance'))
  const costume = text(characterValue(character, 'costume', 'costume_description'))
  const ageGroup = text(characterValue(character, 'ageGroup', 'age_group'))
  const gender = text(characterValue(character, 'gender'))
  const referenceImageUrl = text(
    characterValue(character, 'referenceImageUrl', 'reference_image_url'),
  )
  const voiceProfileKey = text(
    characterValue(character, 'voiceProfileKey', 'voice_profile_key'),
  )
  const blockers = []
  const warnings = []

  if (!name) blockers.push(blocker('NAME_MISSING', '角色缺少名称'))
  if (!appearance) blockers.push(blocker('APPEARANCE_MISSING', '角色缺少固定外貌设定'))
  if (!lockValue(character, 'appearanceLocked', 'appearance_locked')) {
    blockers.push(blocker('APPEARANCE_UNLOCKED', '角色外貌尚未锁定'))
  }
  if (!referenceImageUrl) {
    blockers.push(blocker('REFERENCE_IMAGE_MISSING', '角色尚未确认定妆图'))
  }
  if (!costume) blockers.push(blocker('COSTUME_MISSING', '角色缺少固定服装设定'))
  if (!lockValue(character, 'costumeLocked', 'costume_locked')) {
    blockers.push(blocker('COSTUME_UNLOCKED', '角色服装尚未锁定'))
  }
  if (!ageGroup) blockers.push(blocker('AGE_GROUP_MISSING', '角色缺少年龄段'))
  if (!gender) blockers.push(blocker('GENDER_MISSING', '角色缺少性别'))
  if (!voiceProfileKey) {
    blockers.push(blocker('VOICE_PROFILE_MISSING', '角色尚未绑定有效音色'))
  }
  if (!lockValue(character, 'voiceLocked', 'voice_locked')) {
    blockers.push(blocker('VOICE_UNLOCKED', '角色音色尚未锁定'))
  }
  if (text(characterValue(character, 'status')) === 'archived') {
    blockers.push(blocker('CHARACTER_ARCHIVED', '角色已归档，不能进入生产'))
  }
  if (!text(characterValue(character, 'personality'))) {
    warnings.push(warning('PERSONALITY_MISSING', '角色缺少性格描述，可能影响表演一致性'))
  }
  if (!text(characterValue(character, 'voiceStyle', 'voice_style'))) {
    warnings.push(warning('VOICE_STYLE_MISSING', '角色缺少声音表演风格描述'))
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    locks: {
      appearance: lockValue(character, 'appearanceLocked', 'appearance_locked'),
      costume: lockValue(character, 'costumeLocked', 'costume_locked'),
      voice: lockValue(character, 'voiceLocked', 'voice_locked'),
    },
  }
}

function buildConstraintText(character) {
  const name = text(characterValue(character, 'name')) || '未命名角色'
  const roleTag = text(characterValue(character, 'roleTag', 'role_tag'))
  const appearance = text(characterValue(character, 'appearance'))
  const costume = text(characterValue(character, 'costume', 'costume_description'))
  const ageGroup = text(characterValue(character, 'ageGroup', 'age_group'))
  const gender = text(characterValue(character, 'gender'))
  const referenceImageUrl = text(
    characterValue(character, 'referenceImageUrl', 'reference_image_url'),
  )
  const voiceProfileKey = text(
    characterValue(character, 'voiceProfileKey', 'voice_profile_key'),
  )
  const voiceStyle = text(characterValue(character, 'voiceStyle', 'voice_style'))

  return [
    `角色姓名：${name}`,
    roleTag ? `角色身份：${roleTag}` : '',
    gender ? `性别：${gender}` : '',
    ageGroup ? `年龄段：${ageGroup}` : '',
    appearance ? `固定外貌：${appearance}` : '',
    costume ? `固定服装与随身物件：${costume}` : '',
    referenceImageUrl ? `唯一身份参考图：${referenceImageUrl}` : '',
    voiceProfileKey ? `锁定音色 Profile：${voiceProfileKey}` : '',
    voiceStyle ? `声音表演风格：${voiceStyle}` : '',
    '生成时必须保持同一张脸、同一发型、同一体态、同一固定服装、同一随身物件和同一声音身份，不得换脸、改龄、改性别或用其他人物替代。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildCharacterProductionSnapshot(character = {}, options = {}) {
  const readiness = getCharacterProductionReadiness(character)
  const versionNo = Number(options.versionNo || character.versionNo || character.version_no || 1)
  const snapshot = {
    schemaVersion: 1,
    characterId: Number(characterValue(character, 'id')) || null,
    projectId: Number(characterValue(character, 'projectId', 'project_id')) || null,
    versionNo,
    name: text(characterValue(character, 'name')),
    roleTag: text(characterValue(character, 'roleTag', 'role_tag')) || null,
    personality: text(characterValue(character, 'personality')) || null,
    appearance: text(characterValue(character, 'appearance')) || null,
    costume: text(characterValue(character, 'costume', 'costume_description')) || null,
    ageGroup: text(characterValue(character, 'ageGroup', 'age_group')) || null,
    gender: text(characterValue(character, 'gender')) || null,
    voiceStyle: text(characterValue(character, 'voiceStyle', 'voice_style')) || null,
    voiceProfileKey: text(
      characterValue(character, 'voiceProfileKey', 'voice_profile_key'),
    ) || null,
    voiceSetting: text(characterValue(character, 'voiceSetting', 'voice_setting')) || null,
    referenceImageUrl: text(
      characterValue(character, 'referenceImageUrl', 'reference_image_url'),
    ) || null,
    locks: readiness.locks,
    productionReady: readiness.ready,
    constraintText: buildConstraintText(character),
    changeReason: text(options.changeReason) || null,
    sourceUpdatedAt: characterValue(character, 'updatedAt', 'updated_at'),
    createdAt: options.createdAt || null,
  }
  return snapshot
}

function comparableSnapshot(snapshot = {}) {
  return {
    schemaVersion: Number(snapshot.schemaVersion || 1),
    characterId: Number(snapshot.characterId) || null,
    projectId: Number(snapshot.projectId) || null,
    name: text(snapshot.name),
    roleTag: text(snapshot.roleTag) || null,
    personality: text(snapshot.personality) || null,
    appearance: text(snapshot.appearance) || null,
    costume: text(snapshot.costume) || null,
    ageGroup: text(snapshot.ageGroup) || null,
    gender: text(snapshot.gender) || null,
    voiceStyle: text(snapshot.voiceStyle) || null,
    voiceProfileKey: text(snapshot.voiceProfileKey) || null,
    voiceSetting: text(snapshot.voiceSetting) || null,
    referenceImageUrl: text(snapshot.referenceImageUrl) || null,
    locks: {
      appearance: Boolean(snapshot.locks?.appearance),
      costume: Boolean(snapshot.locks?.costume),
      voice: Boolean(snapshot.locks?.voice),
    },
    constraintText: text(snapshot.constraintText),
    productionReady: Boolean(snapshot.productionReady),
  }
}

export function decideCharacterVersion(character = {}, options = {}, snapshotOptions = {}) {
  const currentVersionNo = Math.max(
    1,
    Number(options.versionNo || character.versionNo || character.version_no || 1),
  )
  const previousSnapshot = options.snapshot || null
  const nextSnapshot = buildCharacterProductionSnapshot(character, {
    ...snapshotOptions,
    versionNo: currentVersionNo + 1,
  })

  if (
    previousSnapshot &&
    JSON.stringify(comparableSnapshot(previousSnapshot)) ===
      JSON.stringify(comparableSnapshot(nextSnapshot))
  ) {
    return {
      changed: false,
      versionNo: currentVersionNo,
      snapshot: {
        ...previousSnapshot,
        versionNo: currentVersionNo,
      },
    }
  }

  return {
    changed: true,
    versionNo: currentVersionNo + 1,
    snapshot: nextSnapshot,
  }
}

export function normalizeRegressionSampleInput(input = {}) {
  const sampleType = text(input.sampleType || input.sample_type)
  if (!REGRESSION_SAMPLE_TYPES.has(sampleType)) {
    throw new Error('回归样例类型无效')
  }

  const assetUrl = text(input.assetUrl || input.asset_url)
  let parsedUrl
  try {
    parsedUrl = new URL(assetUrl)
  } catch {
    parsedUrl = null
  }
  if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('回归样例地址无效')
  }

  const versionNo = Number(input.versionNo ?? input.version_no)
  if (!Number.isInteger(versionNo) || versionNo < 1) {
    throw new Error('回归样例版本无效')
  }

  const sourceIdValue = input.sourceId ?? input.source_id
  const sourceId = sourceIdValue === undefined || sourceIdValue === null || sourceIdValue === ''
    ? null
    : Number(sourceIdValue)
  if (sourceId !== null && (!Number.isInteger(sourceId) || sourceId < 1)) {
    throw new Error('回归样例来源无效')
  }

  return {
    sampleType,
    assetUrl,
    versionNo,
    sourceId,
    note: text(input.note) || null,
  }
}

export function getLockInvalidation(fields = []) {
  const normalizedFields = new Set(Array.isArray(fields) ? fields : [])
  const invalidation = {
    appearanceLocked: undefined,
    costumeLocked: undefined,
    voiceLocked: undefined,
  }
  if ([...normalizedFields].some((field) => APPEARANCE_FIELDS.has(field))) {
    invalidation.appearanceLocked = false
  }
  if ([...normalizedFields].some((field) => COSTUME_FIELDS.has(field))) {
    invalidation.costumeLocked = false
  }
  if ([...normalizedFields].some((field) => VOICE_FIELDS.has(field))) {
    invalidation.voiceLocked = false
  }
  return invalidation
}

export function getCharacterMutationEffects(fields = []) {
  const normalizedFields = [
    ...new Set(
      (Array.isArray(fields) ? fields : [])
        .map((field) => String(field))
        .filter((field) => VERSION_FIELDS.has(field)),
    ),
  ]
  const invalidation = getLockInvalidation(normalizedFields)
  const affectedGroups = [
    ['appearance', invalidation.appearanceLocked === false],
    ['costume', invalidation.costumeLocked === false],
    ['voice', invalidation.voiceLocked === false],
  ]
    .filter(([, affected]) => affected)
    .map(([group]) => group)

  return {
    fields: normalizedFields,
    affectedGroups,
    invalidation,
    requiresVersionSync: normalizedFields.length > 0,
  }
}

function latestVersionFor(characterId, versionsByCharacter) {
  const versions = versionsByCharacter.get(Number(characterId)) || []
  return versions.reduce((max, version) => Math.max(max, Number(version.versionNo || version.version_no || 0)), 0)
}

export function buildCharacterConsistencyReport(input = {}) {
  const characters = Array.isArray(input.characters) ? input.characters : []
  const versions = Array.isArray(input.versions) ? input.versions : []
  const samples = Array.isArray(input.samples) ? input.samples : []
  const versionsByCharacter = new Map()
  for (const version of versions) {
    const characterId = Number(version.characterId ?? version.character_id)
    if (!characterId) continue
    const items = versionsByCharacter.get(characterId) || []
    items.push(version)
    versionsByCharacter.set(characterId, items)
  }

  const characterReports = characters.map((character) => {
    const readiness = getCharacterProductionReadiness(character)
    const characterId = Number(characterValue(character, 'id')) || null
    const latestVersionNo = latestVersionFor(characterId, versionsByCharacter)
    return {
      characterId,
      name: text(characterValue(character, 'name')),
      ready: readiness.ready,
      blockers: readiness.blockers,
      warnings: readiness.warnings,
      locks: readiness.locks,
      latestVersionNo: latestVersionNo || null,
    }
  })

  const staleSamples = samples
    .map((sample) => {
      const characterId = Number(sample.characterId ?? sample.character_id)
      const sampleVersionNo = Number(sample.versionNo ?? sample.version_no)
      const currentVersionNo = latestVersionFor(characterId, versionsByCharacter)
      if (!characterId || !sampleVersionNo || !currentVersionNo || sampleVersionNo === currentVersionNo) {
        return null
      }
      return {
        ...sample,
        characterId,
        versionNo: sampleVersionNo,
        currentVersionNo,
        blocker: blocker(
          'STALE_REGRESSION_SAMPLE',
          `回归样例使用角色版本 v${sampleVersionNo}，当前生产基线为 v${currentVersionNo}`,
        ),
      }
    })
    .filter(Boolean)

  const characterBlockers = characterReports.reduce((count, item) => count + item.blockers.length, 0)
  const blockers = [
    ...characterReports.flatMap((item) => item.blockers.map((entry) => ({
      ...entry,
      characterId: item.characterId,
      characterName: item.name,
    }))),
    ...staleSamples.map((sample) => ({
      ...sample.blocker,
      characterId: sample.characterId,
      sampleType: sample.sampleType ?? sample.sample_type ?? null,
      assetUrl: sample.assetUrl ?? sample.asset_url ?? null,
    })),
  ]
  const warnings = characterReports.flatMap((item) => item.warnings.map((entry) => ({
    ...entry,
    characterId: item.characterId,
    characterName: item.name,
  })))
  const readyCharacters = characterReports.filter((item) => item.ready).length

  return {
    ready: characterBlockers === 0 && staleSamples.length === 0,
    summary: {
      totalCharacters: characters.length,
      readyCharacters,
      blockedCharacters: characterReports.filter((item) => !item.ready).length,
      regressionSamples: samples.length,
      staleSamples: staleSamples.length,
    },
    characters: characterReports,
    samples: {
      total: samples.length,
      stale: staleSamples,
      current: samples.filter((sample) => !staleSamples.includes(sample)),
    },
    blockers,
    warnings,
  }
}
