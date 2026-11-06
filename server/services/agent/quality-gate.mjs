/**
 * 分镜视频生成前的受控质检 Agent。
 * 这是业务门禁，不是聊天提示：只返回可解释的 blockers / warnings，
 * 调用方据此决定是否允许视频任务入队。
 */

function text(value) {
  return String(value ?? '').trim()
}

function hasSpokenDialogue(value) {
  const dialogue = text(value)
  if (!dialogue) return false
  return !/^(?:[（(]\s*)?(?:无对白|无台词|no\s+dialogue)(?:\s*[）)])?$/i.test(dialogue)
}

function issue(code, message, severity = 'blocker') {
  return { code, message, severity }
}

function hasImage(asset = {}) {
  return Boolean(text(asset.imageUrl ?? asset.image_url ?? asset.thumbnailUrl ?? asset.thumbnail_url))
}

function isPublicHttpImageUrl(value) {
  try {
    const url = new URL(text(value))
    if (!['http:', 'https:'].includes(url.protocol)) return false
    const hostname = url.hostname.toLowerCase()
    return !(
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname.startsWith('169.254.')
    )
  } catch {
    return false
  }
}

function parseJson(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function requiresCharacterFaceReference(reference) {
  // Old snapshots did not carry the flag; keep their existing strict gate.
  return reference?.characterFaceRequired !== false
}

export function inspectStoryboardAssetReferenceGate({
  storyboard = {},
  requireCharacter = true,
  requireScene = true,
} = {}) {
  const blockers = []
  const reference = parseJson(
    storyboard.asset_reference_json ??
      storyboard.assetReference ??
      storyboard.asset_reference,
  ) || {}

  if (requireCharacter) {
    const hasCharacterAssetPack = Number(reference.characterAssetPackImageId) > 0
      && Number(reference.characterAssetPackVersionNo) > 0
    if (!Number(reference.characterId || storyboard.character_id)) {
      blockers.push(issue('character-asset-reference-missing', '分镜缺少角色资产引用'))
    }
    if (!Number(reference.characterVersionNo)) {
      blockers.push(issue('character-version-reference-missing', '分镜缺少角色版本引用'))
    }
    if (!Number(reference.characterViewSetVersion) || !Array.isArray(reference.characterViewKeys) || reference.characterViewKeys.length < 3) {
      blockers.push(issue('character-view-set-reference-missing', '分镜缺少角色三视图版本引用'))
    }
    if (!['front', 'side', 'back'].every((key) => reference.characterViewKeys?.includes(key))) {
      blockers.push(issue('character-view-angle-reference-incomplete', '分镜角色三视图缺少正面、侧面或背面引用'))
    }
    if (!hasCharacterAssetPack && (!Number(reference.characterBaseImageId) || !Number(reference.characterBaseVersionNo))) {
      blockers.push(issue('character-base-image-reference-missing', '分镜缺少角色基础正面全身图引用'))
    }
    if (!hasCharacterAssetPack && requiresCharacterFaceReference(reference)
      && (!Number(reference.characterFaceImageId) || !Number(reference.characterFaceVersionNo))) {
      blockers.push(issue('character-face-closeup-reference-missing', '分镜缺少角色脸部特写引用'))
    }
  }

  if (requireScene) {
    if (!Number(reference.sceneAssetId)) {
      blockers.push(issue('scene-asset-reference-missing', '分镜缺少场景资产引用'))
    }
    if (!Number(reference.scenePanoramaVersion)) {
      blockers.push(issue('scene-panorama-reference-missing', '分镜缺少场景全景版本引用'))
    }
  }

  return {
    passed: blockers.length === 0,
    blockers,
    reference,
    summary: blockers.length
      ? `资产引用门禁未通过：${blockers.length} 个问题需要处理`
      : '资产引用门禁通过',
  }
}

export function inspectStoryboardGenerationContext({
  storyboard = {},
  assets = [],
  characterVoices = [],
  requireConfirmedAssets = true,
  requirePublicAssets = true,
} = {}) {
  const blockers = []
  const warnings = []
  const prompt = text(storyboard.visualPrompt ?? storyboard.visual_prompt)
  const actionText = text(storyboard.actionText ?? storyboard.action_text)
  const dialogue = text(storyboard.dialogueText ?? storyboard.dialogue_text)
  const assetList = Array.isArray(assets) ? assets : []
  const voiceList = Array.isArray(characterVoices) ? characterVoices : []

  if (!text(storyboard.id)) {
    blockers.push(issue('storyboard-missing', '缺少分镜记录，无法建立视频生成任务'))
  }
  if (!prompt) {
    blockers.push(issue('visual-prompt-missing', '当前分镜还没有镜头提示词'))
  }
  if (!text(storyboard.shotType ?? storyboard.shot_type)) {
    warnings.push(issue('shot-type-missing', '未填写景别，视频模型将自行推断', 'warning'))
  }
  if (!text(storyboard.cameraAngle ?? storyboard.camera_angle)) {
    warnings.push(issue('camera-angle-missing', '未填写机位，视频模型将自行推断', 'warning'))
  }
  const actionEvents = actionText.match(/(?:然后|随后|接着|同时|并且|再|之后|继而|滑出|滑入|打印|抬头|低头|转身|望向|看向|打开|关闭|伸手|拿起|放下|递出|接过|走向|推开|拉开|按下|点击)/gu) || []
  if (actionEvents.length >= 4) {
    warnings.push(issue(
      'shot-action-overloaded',
      '本镜动作事件较多，建议拆成“线索出现”和“角色反应”等连续镜头，避免短时长内事件被模型省略。',
      'warning',
    ))
  }

  for (const asset of assetList) {
    const label = text(asset.label) || `资产 ${asset.id || ''}`.trim()
    if (!hasImage(asset)) {
      const missing = issue('asset-image-missing', `资产「${label}」还没有可用图片`)
      if (requireConfirmedAssets) blockers.push(missing)
      else warnings.push({ ...missing, severity: 'warning' })
    }
    if (
      requireConfirmedAssets
      && requirePublicAssets
      && hasImage(asset)
      && !isPublicHttpImageUrl(asset.imageUrl ?? asset.image_url ?? asset.thumbnailUrl ?? asset.thumbnail_url)
    ) {
      blockers.push(issue('asset-image-not-public', `资产「${label}」图片地址不是供应商可访问的公网地址`))
    }
    const status = text(asset.status)
    if (requireConfirmedAssets && status && status !== 'confirmed') {
      blockers.push(issue('asset-not-confirmed', `资产「${label}」还没有确认，不能用于生成视频`))
    } else if (!requireConfirmedAssets && status && status !== 'confirmed') {
      warnings.push(issue('asset-not-confirmed', `资产「${label}」尚未确认，将按候选资产尝试生成`, 'warning'))
    }
  }

  const requiresVoice = hasSpokenDialogue(dialogue)
  if (requiresVoice && !voiceList.length) {
    blockers.push(issue('voice-binding-missing', '当前分镜包含对白，但没有绑定角色音色'))
  }
  if (requiresVoice) {
    for (const voice of voiceList) {
      if (!text(voice.voiceProfileKey ?? voice.voice_profile_key) && !text(voice.referenceAudioUrl ?? voice.reference_audio_url)) {
        const label = text(voice.characterName ?? voice.character_name) || `角色 ${voice.characterId ?? ''}`.trim()
        blockers.push(issue('voice-binding-missing', `角色「${label}」没有绑定系统音色或参考音频`))
      }
    }
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    checkedAt: new Date().toISOString(),
    summary: blockers.length
      ? `质检未通过：${blockers.length} 个问题需要处理`
      : warnings.length
        ? `质检通过，但有 ${warnings.length} 个提示`
        : '质检通过，可以提交视频生成',
  }
}

export function inspectGeneratedVideoResult({ items = [], expectedCandidateCount = 1 } = {}) {
  const candidates = Array.isArray(items) ? items : []
  const blockers = []
  const warnings = []
  const usable = candidates.filter((item) =>
    text(item.videoUrl ?? item.video_url) && text(item.status) !== 'failed',
  )

  if (!usable.length) {
    blockers.push(issue('video-result-missing', '视频任务完成，但没有可供预览的视频地址'))
  }
  if (usable.length < Math.max(1, Number(expectedCandidateCount) || 1)) {
    warnings.push(issue(
      'video-candidate-count-short',
      `请求 ${Math.max(1, Number(expectedCandidateCount) || 1)} 个候选，实际得到 ${usable.length} 个`,
      'warning',
    ))
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
    checkedAt: new Date().toISOString(),
    summary: blockers.length
      ? '视频结果质检未通过，请检查生成任务和媒体存储'
      : warnings.length
        ? '视频结果可用，但候选数量少于请求数量'
        : '视频结果已通过基础完整性检查',
  }
}

export function inspectVideoConfirmationEligibility({ qualityReport = null } = {}) {
  if (!qualityReport) {
    return { passed: true, blockers: [], summary: '旧视频没有技术质检报告，保留人工确认兼容' }
  }

  if (text(qualityReport.technicalStatus) === 'passed') {
    return { passed: true, blockers: [], summary: '视频技术质检通过' }
  }

  const blocker = issue(
    'video-technical-inspection-not-passed',
    '该视频的媒体技术质检未通过或未完成；请处理报告中的问题后重新生成，不能设为最终版本',
  )
  return { passed: false, blockers: [blocker], summary: blocker.message }
}
