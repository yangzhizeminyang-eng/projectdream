const AGE_GROUP_ORDER = ['child', 'teen', 'young_adult', 'middle_aged', 'senior']

export const CHARACTER_AGE_GROUPS = [
  { value: 'child', label: '儿童（12 岁及以下）' },
  { value: 'teen', label: '少年（13-18 岁）' },
  { value: 'young_adult', label: '青年（19-35 岁）' },
  { value: 'middle_aged', label: '中年（36-55 岁）' },
  { value: 'senior', label: '老年（56 岁以上）' },
]

export const CHARACTER_GENDERS = [
  { value: 'male', label: '男性声线' },
  { value: 'female', label: '女性声线' },
  { value: 'neutral', label: '中性 / 系统声线' },
]

export const VOICE_PROFILE_SEEDS = [
  {
    profileKey: 'male-child-clear',
    displayName: '清澈男童声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Mochi',
    gender: 'male',
    ageGroups: ['child'],
    styleTags: ['清澈', '童真', '早慧'],
    description: '适合 7-12 岁男童、早慧少年和记忆片段中的童年角色。',
    instructions: '请使用8至12岁男童的自然声线，音色清澈、童真但不幼稚，吐字清楚，避免成年男性的厚重感。',
    languageType: 'Chinese',
    sortOrder: 10,
  },
  {
    profileKey: 'male-teen-bright',
    displayName: '清爽少年音',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Ethan',
    gender: 'male',
    ageGroups: ['teen'],
    styleTags: ['清爽', '少年', '敏感'],
    description: '适合 13-18 岁少年，保留未完全成熟的轻薄声线。',
    instructions: '请使用14至18岁少年的自然声线，声音清爽偏轻，保留少年感，避免成熟中年男性的低沉和沧桑。',
    languageType: 'Chinese',
    sortOrder: 20,
  },
  {
    profileKey: 'male-young-warm',
    displayName: '温暖青年男声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-flash',
    voiceId: 'Ethan',
    gender: 'male',
    ageGroups: ['young_adult'],
    styleTags: ['阳光', '温暖', '活力'],
    description: '适合 19-35 岁、积极温暖或行动力强的青年男性。',
    instructions: '',
    languageType: 'Chinese',
    sortOrder: 30,
  },
  {
    profileKey: 'male-adult-calm',
    displayName: '冷静成年男声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Moon',
    gender: 'male',
    ageGroups: ['young_adult', 'middle_aged'],
    styleTags: ['冷静', '克制', '理性'],
    description: '适合 30-45 岁、冷静克制的执行者、医生或技术角色。',
    instructions: '请使用30至45岁成年男性的自然声线，语气冷静克制，音高适中偏低，语速稳定，不要表现出少年感。',
    languageType: 'Chinese',
    sortOrder: 40,
  },
  {
    profileKey: 'male-middle-authority',
    displayName: '沉稳中年男声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Kai',
    gender: 'male',
    ageGroups: ['middle_aged'],
    styleTags: ['沉稳', '低沉', '权威', '克制', '压迫'],
    description: '适合 40-55 岁管理者、父亲、监管者和具有压迫感的成熟男性。',
    instructions: '请使用45岁左右成熟男性的自然声线。声音低沉厚实、沉稳克制，带管理者的权威和轻微压迫感；语速稍慢，咬字清晰，避免阳光青年音、少年感和夸张播音腔。',
    languageType: 'Chinese',
    sortOrder: 50,
  },
  {
    profileKey: 'male-senior-wise',
    displayName: '沧桑老者男声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Eldric Sage',
    gender: 'male',
    ageGroups: ['senior'],
    styleTags: ['沧桑', '睿智', '低沉', '慈祥'],
    description: '适合 56 岁以上的长者、导师和经历丰富的权威角色。',
    instructions: '请使用60岁以上男性长者的自然声线，低沉、从容、略带沧桑，语速偏慢但吐字清楚，避免虚弱或戏剧化过度。',
    languageType: 'Chinese',
    sortOrder: 60,
  },
  {
    profileKey: 'male-senior-rural',
    displayName: '质朴大爷声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Arthur',
    gender: 'male',
    ageGroups: ['senior'],
    styleTags: ['质朴', '长者', '从容', '阅历'],
    description: '适合 60 岁以上的乡土长者、邻里大爷和生活阅历很重的男性角色。',
    instructions: '请使用60岁以上男性长者的质朴自然声线，嗓音有岁月感，语速不疾不徐，像经历很多事的老大爷在讲述往事；避免青年男声、播音腔和过度夸张。',
    languageType: 'Chinese',
    sortOrder: 62,
  },
  {
    profileKey: 'male-senior-hoarse',
    displayName: '沙哑长者男声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Vincent',
    gender: 'male',
    ageGroups: ['senior'],
    styleTags: ['沙哑', '沧桑', '烟嗓', '江湖'],
    description: '适合 60 岁以上、嗓音粗粝、江湖感或风霜感很强的男性长者。',
    instructions: '请使用60岁以上男性长者的沙哑烟嗓，声音粗粝、有风霜感，语速偏慢，停顿自然，带压低的气息感；避免年轻、清亮、阳光或甜润的音色。',
    languageType: 'Chinese',
    sortOrder: 64,
  },
  {
    profileKey: 'female-child-clear',
    displayName: '灵动女童声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Bella',
    gender: 'female',
    ageGroups: ['child'],
    styleTags: ['童真', '灵动', '清澈'],
    description: '适合 6-12 岁女童和童年记忆角色。',
    instructions: '请使用7至12岁女童的自然声线，清澈、灵动，保留真实儿童的呼吸和停顿，避免成年女性或二次元夸张腔调。',
    languageType: 'Chinese',
    sortOrder: 70,
  },
  {
    profileKey: 'female-teen-bright',
    displayName: '明亮少女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Chelsie',
    gender: 'female',
    ageGroups: ['teen'],
    styleTags: ['明亮', '少女', '活泼'],
    description: '适合 13-18 岁少女和轻快活泼的年轻角色。',
    instructions: '请使用14至18岁少女的自然声线，明亮但不过分甜腻，保持真实口语感，避免成年御姐音和二次元夸张表演。',
    languageType: 'Chinese',
    sortOrder: 80,
  },
  {
    profileKey: 'female-young-warm',
    displayName: '亲切青年女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-flash',
    voiceId: 'Cherry',
    gender: 'female',
    ageGroups: ['young_adult'],
    styleTags: ['阳光', '亲切', '自然'],
    description: '适合 19-35 岁、亲切自然的青年女性。',
    instructions: '',
    languageType: 'Chinese',
    sortOrder: 90,
  },
  {
    profileKey: 'female-adult-gentle',
    displayName: '温柔成年女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Serena',
    gender: 'female',
    ageGroups: ['young_adult', 'middle_aged'],
    styleTags: ['温柔', '舒缓', '成熟'],
    description: '适合 28-45 岁温柔、克制或专业的成年女性。',
    instructions: '请使用30至45岁成熟女性的自然声线，温柔克制、语速稳定，避免少女感和过分甜美的语气。',
    languageType: 'Chinese',
    sortOrder: 100,
  },
  {
    profileKey: 'female-middle-intellectual',
    displayName: '知性中年女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Maia',
    gender: 'female',
    ageGroups: ['middle_aged'],
    styleTags: ['知性', '成熟', '冷静', '权威'],
    description: '适合 40-55 岁管理者、研究者和成熟母亲角色。',
    instructions: '请使用45岁左右成熟女性的自然声线，知性、冷静、有阅历，音高适中，避免少女感和夸张御姐腔。',
    languageType: 'Chinese',
    sortOrder: 110,
  },
  {
    profileKey: 'female-senior-kind',
    displayName: '慈和长者女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Seren',
    gender: 'female',
    ageGroups: ['senior'],
    styleTags: ['慈和', '从容', '阅历', '舒缓'],
    description: '适合 56 岁以上的女性长者、导师和家族人物。',
    instructions: '请使用60岁以上女性长者的自然声线，从容、慈和、有阅历，语速稍慢，气息更稳更沉，带轻微岁月感；明确避免少女感、小姐姐音、甜美客服腔和年轻化处理。',
    languageType: 'Chinese',
    sortOrder: 120,
  },
  {
    profileKey: 'female-senior-mentor',
    displayName: '长者导师女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Elias',
    gender: 'female',
    ageGroups: ['senior'],
    styleTags: ['长者', '导师', '阅历', '冷静'],
    description: '适合 56 岁以上的女性导师、研究者、家族长辈和旁白型角色。',
    instructions: '请使用60岁以上女性导师的成熟长者声线，音色沉稳、有阅历，语速稍慢，吐字清楚，情绪克制；不要使用年轻女性、少女、小姐姐或甜美温柔客服的感觉。',
    languageType: 'Chinese',
    sortOrder: 118,
  },
  {
    profileKey: 'female-senior-commanding',
    displayName: '苍劲长者女声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Bellona',
    gender: 'female',
    ageGroups: ['senior'],
    styleTags: ['苍劲', '权威', '长者', '人物感'],
    description: '适合 56 岁以上、气场强、吐字清晰、有家族权威感的女性长辈。',
    instructions: '请使用60岁以上女性长辈的苍劲声线，声音有厚度、有压迫感，吐字清楚，停顿稳，像掌握局面的家族长辈；避免年轻甜美、二次元、少女感和轻飘的语气。',
    languageType: 'Chinese',
    sortOrder: 122,
  },
  {
    profileKey: 'neutral-system-calm',
    displayName: '冷静系统声',
    provider: 'dashscope',
    modelName: 'qwen3-tts-instruct-flash',
    voiceId: 'Serena',
    gender: 'neutral',
    ageGroups: AGE_GROUP_ORDER,
    styleTags: ['系统', '机械', '冷静', '无情绪'],
    description: '适合终端、系统播报和不具备明确年龄身份的声音角色。',
    instructions: '请使用中性、冷静的系统播报声线，音量和节奏稳定，情绪起伏很小，但仍保持自然清晰，不要使用甜美或亲切客服腔。',
    languageType: 'Chinese',
    sortOrder: 130,
  },
]

export function normalizeCharacterAgeGroup(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return AGE_GROUP_ORDER.includes(normalized) ? normalized : null
}

export function normalizeCharacterGender(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['male', 'female', 'neutral'].includes(normalized) ? normalized : null
}

function chineseNumberToInt(value) {
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const text = String(value || '')
  if (!text) return 0
  if (text === '十') return 10
  const tenIndex = text.indexOf('十')
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]] || 0
    const ones = tenIndex === text.length - 1 ? 0 : digits[text[tenIndex + 1]] || 0
    return tens * 10 + ones
  }
  return [...text].reduce((total, char) => total * 10 + (digits[char] ?? 0), 0)
}

function ageGroupFromAge(age) {
  if (!Number.isFinite(age) || age <= 0) return null
  if (age <= 12) return 'child'
  if (age <= 18) return 'teen'
  if (age <= 35) return 'young_adult'
  if (age <= 55) return 'middle_aged'
  return 'senior'
}

function inferAgeGroup(text) {
  const source = String(text || '')
  const rangeMatch = source.match(/(\d{1,2})\s*(?:至|到|[-~—])\s*(\d{1,2})\s*岁/)
  if (rangeMatch) return ageGroupFromAge((Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2)
  const ageMatch = source.match(/(\d{1,2})\s*岁/)
  if (ageMatch) return ageGroupFromAge(Number(ageMatch[1]))
  const chineseAgeMatch = source.match(/(?<![轻差小前后到至])([零一二两三四五六七八九十]{1,3})\s*岁/)
  if (chineseAgeMatch) return ageGroupFromAge(chineseNumberToInt(chineseAgeMatch[1]))
  if (/女童|男童|小女孩|小男孩|儿童|孩童|幼年/.test(source)) return 'child'
  if (/十几岁|少年|少女|中学生/.test(source)) return 'teen'
  if (/老年|老人|老者|长者|爷爷|奶奶|六十|七十|八十/.test(source)) return 'senior'
  if (/中年|四十|五十|成熟管理者|父亲|母亲/.test(source)) return 'middle_aged'
  if (/青年|年轻|二十|三十/.test(source)) return 'young_adult'
  return null
}

function inferGender(text) {
  const source = String(text || '')
  if (/女性|女人|女声|女孩|女童|少女|姐姐|妹妹|母亲|妻子|奶奶|御姐/.test(source)) return 'female'
  if (/男性|男人|男声|男孩|男童|少年|哥哥|弟弟|父亲|丈夫|爷爷|老者/.test(source)) return 'male'
  if (/系统|终端|机械|无实体|中性/.test(source)) return 'neutral'
  return null
}

const STYLE_RULES = [
  ['沉稳', /沉稳|稳重|厚重/],
  ['低沉', /低沉|压低|深沉/],
  ['权威', /权威|管理|主管|监管|官署|领导/],
  ['压迫', /压迫|审讯|冷酷|反派/],
  ['克制', /克制|收束|节制/],
  ['冷静', /冷静|冷淡|理性|稳定/],
  ['温柔', /温柔|舒缓|柔和/],
  ['亲切', /亲切|友善|温暖/],
  ['活力', /活力|活泼|阳光|朝气/],
  ['沧桑', /沧桑|疲惫|阅历|风霜/],
  ['沙哑', /沙哑|烟嗓|粗粝/],
  ['慈和', /慈和|慈祥|和蔼|长辈/],
  ['长者', /长者|老人|老年|老者|大爷|奶奶|婆婆/],
  ['从容', /从容|不疾不徐|沉静/],
  ['童真', /童真|童年|小女孩|小男孩|儿童/],
  ['系统', /系统|终端|机械|播报|无实体/],
]

export function inferCharacterVoiceTraits(character = {}) {
  const identitySource = [character.name, character.role_tag ?? character.roleTag]
    .filter(Boolean)
    .join('\n')
  const source = [
    character.name,
    character.role_tag ?? character.roleTag,
    character.appearance,
    character.personality,
    character.voice_style ?? character.voiceStyle,
  ]
    .filter(Boolean)
    .join('\n')
  const explicitAge = normalizeCharacterAgeGroup(character.age_group ?? character.ageGroup)
  const explicitGender = normalizeCharacterGender(character.gender)
  const styleTags = STYLE_RULES.filter(([, pattern]) => pattern.test(source)).map(([tag]) => tag)
  return {
    ageGroup: explicitAge || inferAgeGroup(source),
    gender: explicitGender || inferGender(identitySource) || inferGender(source),
    styleTags,
    inferredAge: !explicitAge,
    inferredGender: !explicitGender,
  }
}

function parseList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String)
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function voiceProfileRow(row) {
  return {
    profileKey: row.profile_key ?? row.profileKey,
    displayName: row.display_name ?? row.displayName,
    provider: row.provider,
    modelName: row.model_name ?? row.modelName,
    voiceId: row.voice_id ?? row.voiceId,
    gender: row.gender,
    ageGroups: parseList(row.age_groups ?? row.ageGroups),
    styleTags: parseList(row.style_tags ?? row.styleTags),
    description: row.description || '',
    instructions: row.instructions || '',
    languageType: row.language_type ?? row.languageType ?? 'Chinese',
    status: row.status || 'active',
    sortOrder: Number(row.sort_order ?? row.sortOrder) || 0,
  }
}

function ageDistance(ageGroup, profileAgeGroups) {
  const targetIndex = AGE_GROUP_ORDER.indexOf(ageGroup)
  if (targetIndex < 0 || !profileAgeGroups.length) return null
  return Math.min(
    ...profileAgeGroups.map((item) => Math.abs(targetIndex - AGE_GROUP_ORDER.indexOf(item))),
  )
}

export function recommendVoiceProfiles(character, profiles = VOICE_PROFILE_SEEDS, limit = 3) {
  const traits = inferCharacterVoiceTraits(character)
  const scored = profiles
    .map(voiceProfileRow)
    .filter((profile) => profile.status === 'active')
    .map((profile) => {
      let score = 0
      const reasons = []
      if (traits.gender) {
        if (profile.gender === traits.gender) {
          score += 55
          reasons.push('声线性别匹配')
        } else if (profile.gender === 'neutral') {
          score += 5
        } else {
          score -= 80
        }
      }
      if (traits.ageGroup) {
        const distance = ageDistance(traits.ageGroup, profile.ageGroups)
        if (distance === 0) {
          score += 45
          reasons.push('年龄段匹配')
        } else if (distance === 1) {
          score += 10
        } else if (distance != null) {
          score -= distance * 20
        }
      }
      const matchingTags = profile.styleTags.filter((tag) => traits.styleTags.includes(tag))
      score += matchingTags.length * 12
      if (matchingTags.length) reasons.push(`气质匹配：${matchingTags.slice(0, 3).join('、')}`)
      if (profile.instructions) score += 2
      return {
        ...profile,
        score,
        matchReasons: reasons.length ? reasons : ['通用声线候选'],
      }
    })
    .sort((a, b) => b.score - a.score || a.sortOrder - b.sortOrder)

  return {
    traits,
    items: scored.slice(0, Math.max(1, Math.min(6, Number(limit) || 3))),
  }
}
