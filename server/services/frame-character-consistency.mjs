import {
  inferCharacterVoiceTraits,
  normalizeCharacterAgeGroup,
  normalizeCharacterGender,
} from './voice-profiles.mjs'

const AGE_GROUP_LABELS = {
  child: '儿童（12岁及以下）',
  teen: '少年（13-18岁）',
  young_adult: '青年（19-35岁）',
  middle_aged: '中年（36-55岁）',
  senior: '老年（56岁以上）',
}

const GENDER_LABELS = {
  male: '男性',
  female: '女性',
  neutral: '中性 / 无实体',
}

const CHARACTER_FREE_PATTERN = /^(?:无角色|无人|空镜|环境|场景|旁白|none)$/i
const HUMAN_SUBJECT_PATTERN = /人物|角色|主角|配角|女人|男人|女孩|男孩|女童|男童|少女|少年|老人|(?:^|[，。；、\s])[她他](?:们)?(?:[，。；、\s]|$)|woman|man|girl|boy|character|protagonist/i
const AUDIO_ONLY_IDENTITY_PATTERN = /旁白|画外音|系统声|终端声|广播声|通讯声|声音|男声|女声/i
const VISUAL_PRESENCE_PATTERN = /人物|角色|身影|背影|全息|轮廓|脸|面部|身体|目光|眼神|站立|站着|站在|伫立|坐在|坐着|落座|行走|走进|走出|跑动|跑向|抬头|转身|出现|现身|入镜|出镜/i
const EXPLICIT_OFFSCREEN_PATTERN = /(?:画面|镜头)(?:中|内|里)?(?:明确)?(?:不|没有|无)(?:会)?(?:出现|呈现|展示|包含)?(?:任何)?(?:实体)?(?:人物|人像|角色)|(?:仅|只)(?:以|通过)?.{0,12}(?:声音|广播|画外音)(?:存在|出现|呈现)?/i

const AUDIO_ONLY_IDENTITY_HINT_PATTERN =
  /广播(?:中|里的)?(?:的)?(?:声音|回应者)|主要通过广播|仅(?:以|通过).*声音|无实体/i

function normalizedText(value) {
  return String(value || '').trim()
}

function normalizedName(value) {
  return normalizedText(value).toLocaleLowerCase('zh-CN')
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isViewpointOnlyMention(character, storyboard) {
  const name = normalizedName(character?.name)
  if (!name) return false

  const actionText = normalizedName(storyboard.action_text ?? storyboard.actionText)
  const visualPrompt = normalizedName(storyboard.visual_prompt ?? storyboard.visualPrompt)
  if (!actionText.includes(name) || visualPrompt.includes(name)) return false

  const escapedName = escapeRegExp(name)
  return new RegExp(
    `${escapedName}(?:的)?(?:视线|视角|眼中|所见|主观镜头)(?:中|里|内)?`,
    'i',
  ).test(actionText)
}

function uniqueCharacters(items) {
  const seen = new Set()
  return items.filter((item) => {
    const id = Number(item?.id)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function inferIdentityGender(character) {
  const name = normalizedText(character?.name)
  const role = normalizedText(character?.role_tag ?? character?.roleTag)
  const malePattern = /男性|男人|男主|男配|男孩|男童|少年|哥哥|弟弟|父亲|丈夫|爷爷|老者|男声|监护男性/
  const femalePattern = /女性|女人|女主|女配|女孩|女童|少女|姐姐|妹妹|母亲|妻子|奶奶|女声|监护女性/
  const neutralPattern = /系统|终端|机械|无实体|中性/
  if (malePattern.test(name)) return 'male'
  if (femalePattern.test(name)) return 'female'
  if (neutralPattern.test(name)) return 'neutral'
  if (/父亲|丈夫|爷爷|哥哥|弟弟|男主|男配|男声|监护男性/.test(role)) return 'male'
  if (/母亲|妻子|奶奶|姐姐|妹妹|女主|女配|女声|监护女性/.test(role)) return 'female'
  if (neutralPattern.test(role)) return 'neutral'
  return null
}

function isAudioOnlyIdentity(character) {
  const identityText = [
    character?.name,
    character?.role_tag ?? character?.roleTag,
    character?.appearance,
  ].filter(Boolean).join('\n')
  return (
    AUDIO_ONLY_IDENTITY_PATTERN.test(identityText) ||
    AUDIO_ONLY_IDENTITY_HINT_PATTERN.test(identityText)
  )
}

function visualSourceFor(storyboard) {
  return [
    storyboard.action_text ?? storyboard.actionText,
    storyboard.visual_prompt ?? storyboard.visualPrompt,
  ].filter(Boolean).join('\n')
}

function explicitlyKeepsAudioOffscreen(segment, name) {
  if (EXPLICIT_OFFSCREEN_PATTERN.test(segment)) return true
  if (!name) return false
  const escapedName = escapeRegExp(name)
  return new RegExp(
    `(?:画面|镜头)(?:中|内|里)?(?:明确)?(?:不|没有|无)(?:会)?(?:出现|呈现|展示|包含)?(?:任何)?(?:实体)?${escapedName}`,
    'i',
  ).test(normalizedName(segment))
}

function hasExplicitOffscreenInstruction(character, storyboard) {
  const name = normalizedName(character?.name)
  return visualSourceFor(storyboard)
    .split(/[。！？；\n]/)
    .some((segment) =>
      (!name || normalizedName(segment).includes(name)) && explicitlyKeepsAudioOffscreen(segment, name),
    )
}

function isVisuallyPresent(character, storyboard) {
  if (!isAudioOnlyIdentity(character)) return true
  const source = visualSourceFor(storyboard)
  const name = normalizedName(character.name)
  const visibleSegments = source
    .split(/[。！？；\n]/)
    .filter((segment) => normalizedName(segment).includes(name))
    .filter((segment) => !explicitlyKeepsAudioOffscreen(segment, name))
  return visibleSegments.some((segment) => VISUAL_PRESENCE_PATTERN.test(segment))
}

function inferVisualTraits(character) {
  const inferred = inferCharacterVoiceTraits(character)
  const explicitGender = normalizeCharacterGender(character.gender)
  const explicitAgeGroup = normalizeCharacterAgeGroup(character.age_group ?? character.ageGroup)
  const identityGender = inferIdentityGender(character)
  return {
    gender: explicitGender || identityGender || inferred.gender || null,
    ageGroup: explicitAgeGroup || inferred.ageGroup || null,
    inferredGender: !explicitGender && Boolean(identityGender || inferred.gender),
    inferredAge: !explicitAgeGroup && Boolean(inferred.ageGroup),
  }
}

function roleCandidates(label, characters) {
  const normalizedLabel = normalizedName(label)
  if (!normalizedLabel) return []
  const requestedGender = /女主|女配/.test(normalizedLabel)
    ? 'female'
    : /男主|男配/.test(normalizedLabel)
      ? 'male'
      : null
  const roleKeyword = /主角|主人公|女主|男主/.test(normalizedLabel)
    ? /主角|主人公|女主|男主/
    : /配角|女配|男配/.test(normalizedLabel)
      ? /配角|女配|男配/
      : null
  if (!roleKeyword) return []
  return characters.filter((character) => {
    const role = normalizedText(character.role_tag ?? character.roleTag)
    if (!roleKeyword.test(role)) return false
    if (!requestedGender) return true
    return inferVisualTraits(character).gender === requestedGender
  })
}

function resolvePrimaryCharacter(storyboard, characters) {
  const boundId = Number(storyboard.character_id ?? storyboard.characterId) || 0
  if (boundId) {
    const bound = characters.find((character) => Number(character.id) === boundId)
    if (bound) return { character: bound, blocker: null }
    return { character: null, blocker: '分镜绑定的角色已不存在，请返回分镜编辑器重新选择角色' }
  }

  const label = normalizedText(storyboard.character_name ?? storyboard.characterName)
  if (!label || CHARACTER_FREE_PATTERN.test(label)) return { character: null, blocker: null }
  const exact = characters.filter((character) => normalizedName(character.name) === normalizedName(label))
  if (exact.length === 1) return { character: exact[0], blocker: null }

  const byRole = roleCandidates(label, characters)
  if (byRole.length === 1) return { character: byRole[0], blocker: null }
  if (byRole.length > 1) {
    return {
      character: null,
      blocker: `分镜角色“${label}”对应多个角色，请在分镜编辑器中选择准确姓名`,
    }
  }

  const partial = characters.filter((character) => {
    const name = normalizedName(character.name)
    const normalizedLabel = normalizedName(label)
    return name && normalizedLabel && (name.includes(normalizedLabel) || normalizedLabel.includes(name))
  })
  if (partial.length === 1) return { character: partial[0], blocker: null }
  return {
    character: null,
    blocker: `分镜角色“${label}”无法匹配角色库，请先在分镜编辑器中绑定真实角色`,
  }
}

function mentionedCharacters(storyboard, characters) {
  const visualSource = [
    storyboard.character_name ?? storyboard.characterName,
    storyboard.action_text ?? storyboard.actionText,
    storyboard.visual_prompt ?? storyboard.visualPrompt,
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase('zh-CN')
  return characters.filter((character) => {
    const name = normalizedName(character.name)
    return (
      name &&
      visualSource.includes(name) &&
      !isViewpointOnlyMention(character, storyboard) &&
      isVisuallyPresent(character, storyboard)
    )
  })
}

function characterConstraint(character, primaryCharacterId) {
  const traits = inferVisualTraits(character)
  return {
    characterId: Number(character.id),
    name: normalizedText(character.name),
    roleTag: normalizedText(character.role_tag ?? character.roleTag) || null,
    gender: traits.gender,
    genderLabel: GENDER_LABELS[traits.gender] || '未明确',
    ageGroup: traits.ageGroup,
    ageGroupLabel: AGE_GROUP_LABELS[traits.ageGroup] || '未明确',
    appearance: normalizedText(character.appearance) || null,
    personality: normalizedText(character.personality) || null,
    referenceImageUrl: normalizedText(character.reference_image_url ?? character.referenceImageUrl) || null,
    hasReferenceImage: Boolean(character.reference_image_url ?? character.referenceImageUrl),
    isPrimary: Number(character.id) === Number(primaryCharacterId),
    inferredGender: traits.inferredGender,
    inferredAge: traits.inferredAge,
  }
}

export function resolveFrameCharacterContext(storyboard = {}, characters = []) {
  const availableCharacters = Array.isArray(characters) ? characters.filter((item) => item?.id && item?.name) : []
  const resolvedPrimary = resolvePrimaryCharacter(storyboard, availableCharacters)
  let primaryCharacter = resolvedPrimary.character
  let blocker = resolvedPrimary.blocker
  let offscreenAudioIdentity = false
  const label = normalizedText(storyboard.character_name ?? storyboard.characterName)
  const mentioned = mentionedCharacters(storyboard, availableCharacters)
  if (primaryCharacter && !isVisuallyPresent(primaryCharacter, storyboard)) {
    const audioOnlyIdentity = isAudioOnlyIdentity(primaryCharacter)
    const explicitlyOffscreen = hasExplicitOffscreenInstruction(primaryCharacter, storyboard)
    offscreenAudioIdentity = audioOnlyIdentity
    if (audioOnlyIdentity && !explicitlyOffscreen && VISUAL_PRESENCE_PATTERN.test(visualSourceFor(storyboard))) {
      blocker = `声音角色“${primaryCharacter.name}”的镜头出现了可见人物，但画面描述没有明确点名；请确认其是否实体出镜并写入准确姓名`
    } else {
      blocker = null
    }
    primaryCharacter = null
  }
  if (!primaryCharacter && mentioned.length === 1) {
    primaryCharacter = mentioned[0]
    blocker = null
  }
  const resolvedCharacters = uniqueCharacters([
    ...(primaryCharacter ? [primaryCharacter] : []),
    ...mentioned,
  ])
  const constraints = resolvedCharacters.map((character) =>
    characterConstraint(character, primaryCharacter?.id || null),
  )
  const blockers = blocker ? [blocker] : []
  const warnings = []
  const visualSource = visualSourceFor(storyboard)
  const characterFree =
    !blocker &&
    constraints.length === 0 &&
    (offscreenAudioIdentity || !HUMAN_SUBJECT_PATTERN.test(visualSource))

  if (!blocker && !constraints.length && !characterFree) {
    blockers.push('当前分镜包含人物，但没有绑定到角色库，请先在分镜编辑器中选择真实角色')
  }

  for (const character of constraints) {
    if (!character.gender) {
      blockers.push(`角色“${character.name}”缺少明确性别，请先在角色详情中补全`)
    }
    if (!character.ageGroup) {
      blockers.push(`角色“${character.name}”缺少年龄段，请先在角色详情中补全`)
    }
    if (!character.appearance) {
      blockers.push(`角色“${character.name}”缺少固定外貌设定，请先在角色详情中补全`)
    }
    if (!character.hasReferenceImage) {
      blockers.push(`角色“${character.name}”尚未确认定妆图，请先生成并确认角色定妆图`)
    }
  }

  return {
    ready: blockers.length === 0,
    characterFree,
    primaryCharacterId: primaryCharacter ? Number(primaryCharacter.id) : null,
    characters: constraints,
    blockers,
    warnings: [...new Set(warnings)],
  }
}

function characterGenderRule(character) {
  if (character.gender === 'female') return '必须呈现为女性，禁止替换成男性或男性化主体'
  if (character.gender === 'male') return '必须呈现为男性，禁止替换成女性或女性化主体'
  if (character.gender === 'neutral') return '保持中性或无实体设定，不得擅自改成人类男性或女性'
  return '不得擅自改变角色身份'
}

function genderNegativeTerms(characters) {
  const terms = []
  if (characters.some((item) => item.gender === 'female')) {
    terms.push('male protagonist', 'man replacing female character', 'gender swap', '男性主角替代女主角', '把女性画成男性')
  }
  if (characters.some((item) => item.gender === 'male')) {
    terms.push('female protagonist replacing male character', 'gender swap', '女性主角替代男主角', '把男性画成女性')
  }
  return terms
}

export function buildFrameConsistencyPrompt({
  prompt,
  negativePrompt,
  storyboard = {},
  context,
  projectVisualStyle,
}) {
  const safeContext = context || resolveFrameCharacterContext(storyboard, [])
  const basePrompt = normalizedText(prompt || storyboard.visual_prompt || storyboard.visualPrompt)
  const referenceCharacters = safeContext.characters
    .filter((character) => character.referenceImageUrl)
    .slice(0, 3)
  const referenceOrder = new Map(
    referenceCharacters.map((character, index) => [character.characterId, index + 1]),
  )
  const characterLines = safeContext.characters.map((character, index) =>
    [
      `${index + 1}. ${character.name}${character.isPrimary ? '（主要主体）' : '（同框角色）'}`,
      `性别=${character.genderLabel}，${characterGenderRule(character)}`,
      `年龄=${character.ageGroupLabel}`,
      character.roleTag ? `身份=${character.roleTag}` : '',
      character.appearance ? `固定外貌与服装=${character.appearance}` : '',
      referenceOrder.has(character.characterId)
        ? `定妆参考图序号=${referenceOrder.get(character.characterId)}，这是该角色唯一身份参考；脸型、五官比例、发型、体态、服装和随身物件必须严格以参考图为准`
        : '',
    ]
      .filter(Boolean)
      .join('；'),
  )
  const promptParts = [
    basePrompt,
    normalizedText(storyboard.action_text ?? storyboard.actionText)
      ? `镜头动作：${normalizedText(storyboard.action_text ?? storyboard.actionText)}`
      : '',
    [
      normalizedText(storyboard.shot_type ?? storyboard.shotType),
      normalizedText(storyboard.camera_angle ?? storyboard.cameraAngle),
      normalizedText(storyboard.composition),
    ].filter(Boolean).length
      ? `镜头要求：${[
          normalizedText(storyboard.shot_type ?? storyboard.shotType),
          normalizedText(storyboard.camera_angle ?? storyboard.cameraAngle),
          normalizedText(storyboard.composition),
        ].filter(Boolean).join('，')}`
      : '',
    projectVisualStyle ? `项目固定视觉风格：${normalizedText(projectVisualStyle)}` : '',
    characterLines.length ? `【角色一致性硬约束】\n${characterLines.join('\n')}` : '',
    characterLines.length
      ? '必须保持以上角色同一张脸、同一脸型、同一五官比例、同一发型、同一体态、同一固定服装和同一随身物件；不得改变姓名对应关系、性别、年龄层、脸部、发型、体态或固定服装；不得换脸，不得年轻化或老化，不得用其他人物替代主要主体；每张定妆参考图只用于对应序号的角色。'
      : '',
  ].filter(Boolean)
  const negativeTerms = [
    normalizedText(negativePrompt),
    ...genderNegativeTerms(safeContext.characters),
    ...(characterLines.length
      ? [
          'wrong character identity',
          'inconsistent face',
          'inconsistent age',
          'inconsistent costume',
          'duplicate main character',
          '换脸',
          '五官不一致',
          '脸型变化',
          '发型变化',
          '服装变化',
          '年龄变化',
          '体态不一致',
        ]
      : []),
  ].filter(Boolean)

  return {
    prompt: promptParts.join('\n'),
    negativePrompt: [...new Set(negativeTerms)].join(', '),
    referenceImageUrls: referenceCharacters.map((character) => character.referenceImageUrl),
  }
}

export function createFrameCharacterSnapshot(context) {
  return {
    version: 1,
    primaryCharacterId: context?.primaryCharacterId || null,
    characterFree: Boolean(context?.characterFree),
    characters: (context?.characters || []).map((character) => ({
      characterId: character.characterId,
      name: character.name,
      roleTag: character.roleTag,
      gender: character.gender,
      genderLabel: character.genderLabel,
      ageGroup: character.ageGroup,
      ageGroupLabel: character.ageGroupLabel,
      appearance: character.appearance,
      referenceImageUrl: character.referenceImageUrl,
      isPrimary: character.isPrimary,
      inferredGender: character.inferredGender,
      inferredAge: character.inferredAge,
    })),
  }
}
