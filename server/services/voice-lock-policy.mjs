function text(value) {
  return String(value ?? '').trim()
}

export function buildVoiceLockSnapshot({
  character = {},
  voiceProfile = {},
  languageType = 'Chinese',
} = {}) {
  const characterId = Number(character.id || character.characterId || 0) || null
  const characterVersionNo =
    Number(character.characterVersionNo || character.versionNo || character.version_no || 0) || null
  const profileKey = text(voiceProfile.profileKey || voiceProfile.profile_key)
  const voiceName = text(voiceProfile.voiceId || voiceProfile.voice_id || character.voice_setting)
  const modelName = text(voiceProfile.modelName || voiceProfile.model_name)
  const language = text(voiceProfile.languageType || voiceProfile.language_type || languageType) || 'Chinese'

  return {
    version: 'voice-lock-v1',
    characterId,
    characterName: text(character.name) || null,
    characterVersionNo,
    voiceProfileKey: profileKey || null,
    voiceName: voiceName || null,
    modelName: modelName || null,
    languageType: language,
    voiceStyle: text(character.voice_style || character.voiceStyle) || null,
    locked: Boolean(character.voice_locked ?? character.voiceLocked),
  }
}

export function buildNarrationVoiceLockSnapshot({
  characterName = '苏岚',
  voiceProfile = {},
  languageType = 'Chinese',
  voiceStyle = '',
} = {}) {
  return buildVoiceLockSnapshot({
    character: {
      id: null,
      name: characterName,
      characterVersionNo: null,
      voice_locked: true,
      voice_style: voiceStyle,
    },
    voiceProfile,
    languageType,
  })
}

export function buildLockedVoiceInstructions(snapshot = {}, extraInstructions = '') {
  return [
    `锁定角色：${text(snapshot.characterName) || '当前角色'}`,
    `锁定音色 Profile：${text(snapshot.voiceProfileKey) || '未命名'}`,
    `锁定 voice：${text(snapshot.voiceName) || '未命名'}`,
    '只使用中文普通话完成对白，不得输出英文、英文字幕、英文数字或其他语言。',
    '不得切换声线、年龄、性别、说话距离或播音风格；保持同一角色的音色身份稳定。',
    text(snapshot.voiceStyle) ? `角色声音表演：${text(snapshot.voiceStyle)}` : '',
    text(extraInstructions),
  ]
    .filter(Boolean)
    .join('；')
}

export function validateVoiceLockSnapshot({
  snapshot = {},
  characterId,
  characterVersionNo,
  voiceProfileKey,
  voiceName,
  modelName,
  languageType = 'Chinese',
} = {}) {
  const errors = []
  if (!snapshot.locked) errors.push('角色音色尚未锁定')
  if (Number(snapshot.characterId) !== Number(characterId)) errors.push('角色 ID 与声音快照不一致')
  if (
    characterVersionNo != null &&
    Number(snapshot.characterVersionNo) !== Number(characterVersionNo)
  ) {
    errors.push('角色版本与声音快照不一致')
  }
  if (text(snapshot.voiceProfileKey) !== text(voiceProfileKey)) {
    errors.push('音色 Profile 与声音快照不一致')
  }
  if (text(snapshot.voiceName) !== text(voiceName)) {
    errors.push('voice 与声音快照不一致')
  }
  if (text(snapshot.modelName) !== text(modelName)) {
    errors.push('模型与声音快照不一致')
  }
  if (text(snapshot.languageType).toLowerCase() !== text(languageType).toLowerCase()) {
    errors.push('语言参数与声音快照不一致')
  }
  if (!/^chinese$/i.test(text(snapshot.languageType))) {
    errors.push('第一集对白语言必须锁定为 Chinese')
  }
  return {
    valid: errors.length === 0,
    errors,
  }
}
