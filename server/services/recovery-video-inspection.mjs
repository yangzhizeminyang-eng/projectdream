const MINIMUM_SAMPLE_FRAMES = 3
const RELEASE_PROFILE = {
  width: 1080,
  height: 1920,
  frameRate: 24,
  videoCodec: 'h264',
  audioCodec: 'aac',
}

function toPositiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function normalizedSamples(sampleFrames) {
  if (!Array.isArray(sampleFrames)) return []
  const seenStorageKeys = new Set()
  return sampleFrames
    .map((sample) => ({
      second: Number(sample?.second) || 0,
      storageKey: String(sample?.storageKey || '').trim(),
    }))
    .filter((sample) => {
      if (sample.second < 0 || !sample.storageKey || seenStorageKeys.has(sample.storageKey)) {
        return false
      }
      seenStorageKeys.add(sample.storageKey)
      return true
    })
}

function toPositiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function toText(value) {
  return String(value || '').trim()
}

function buildCharacterChecklist(characterSnapshot) {
  const characters = Array.isArray(characterSnapshot?.characters)
    ? characterSnapshot.characters
    : []
  return characters
    .map((character) => {
      const characterId = toPositiveInteger(character?.characterId ?? character?.character_id)
      const name = toText(character?.name)
      if (!characterId || !name) return null
      const referenceImageStorageKey = toText(
        character?.referenceImageStorageKey ?? character?.reference_image_storage_key,
      ) || null
      return {
        characterId,
        versionNo: toPositiveInteger(
          character?.characterVersionNo ??
            character?.character_version_no ??
            character?.versionNo ??
            character?.version_no,
        ),
        name,
        appearance: toText(character?.appearance) || null,
        costume: toText(character?.costume) || null,
        referenceImageStorageKey,
        referenceImageUrl: referenceImageStorageKey
          ? null
          : toText(character?.referenceImageUrl ?? character?.reference_image_url) || null,
        isPrimary: character?.isPrimary === true,
      }
    })
    .filter(Boolean)
}

export function resolveRecoveryCharacterChecklist(recoveryInspection, characterSnapshot) {
  const persistedChecklist = buildCharacterChecklist({
    characters: recoveryInspection?.characterChecklist,
  })
  return persistedChecklist.length ? persistedChecklist : buildCharacterChecklist(characterSnapshot)
}

export function resolveRecoveryManualFocus(recoveryInspection, characterSnapshot) {
  const persistedFocus = Array.isArray(recoveryInspection?.manualFocus)
    ? recoveryInspection.manualFocus.map(toText).filter(Boolean)
    : []
  const generatedFocus = buildRecoveryVideoInspectionReport({
    characterSnapshot,
  }).manualFocus
  return [...new Set([...persistedFocus, ...generatedFocus])]
}

export function buildRecoveryVideoInspectionReport({
  media = {},
  expectedDurationSeconds,
  characterFree = false,
  characterSnapshot,
  sampleFrames = [],
  inspectionError,
} = {}) {
  const width = toPositiveNumber(media.width)
  const height = toPositiveNumber(media.height)
  const durationSeconds = toPositiveNumber(media.durationSeconds)
  const samples = normalizedSamples(sampleFrames)
  const characterChecklist = buildCharacterChecklist(characterSnapshot)
  const isCharacterFree = characterFree === true || characterSnapshot?.characterFree === true
  const blockingIssues = []
  const warnings = []
  const manualFocus = []

  if (!width || !height || !String(media.videoCodec || '').trim() || !String(media.formatName || '').trim()) {
    blockingIssues.push({
      code: 'recovery-video-metadata-missing',
      message: '候选视频缺少完整技术规格，不能进入人工复核。',
    })
  }
  if (samples.length < MINIMUM_SAMPLE_FRAMES) {
    blockingIssues.push({
      code: 'recovery-review-samples-incomplete',
      message: `恢复视频必须保存至少 ${MINIMUM_SAMPLE_FRAMES} 张抽帧证据。`,
    })
  }
  if (inspectionError) {
    blockingIssues.push({
      code: 'recovery-video-inspection-failed',
      message: String(inspectionError).trim() || '恢复视频自动检查失败。',
    })
  }
  if (width && height && width >= height) {
    warnings.push({
      code: 'requires-vertical-final-edit',
      message: '候选视频为横版或方形素材，必须进入 1080x1920 / 24fps 竖屏终剪，不能直接发布。',
    })
  }
  const expectedDuration = toPositiveNumber(expectedDurationSeconds)
  if (expectedDuration && durationSeconds && Math.abs(expectedDuration - durationSeconds) > 1) {
    warnings.push({
      code: 'duration-drift',
      message: `候选视频时长 ${durationSeconds.toFixed(1)} 秒，与目标 ${expectedDuration.toFixed(1)} 秒存在明显偏差。`,
    })
  }
  if (isCharacterFree) {
    manualFocus.push('空景抽帧中不得出现新增人物、脸、人体轮廓、倒影或影子。')
  } else {
    manualFocus.push('对照起始帧检查人物脸部、服装、发型和主体数量是否保持一致。')
  }
  if (characterChecklist.length) {
    manualFocus.push('逐人按角色版本、固定外貌、服装和定妆参考图核对，任何一人不一致都应返工。')
  }
  manualFocus.push('检查动作收尾、镜头运动和场景光线是否连续。')

  return {
    status: blockingIssues.length ? 'failed' : 'ready',
    media: {
      width,
      height,
      frameRate: toPositiveNumber(media.frameRate),
      durationSeconds,
      videoCodec: String(media.videoCodec || '').trim().toLowerCase(),
      audioCodec: String(media.audioCodec || '').trim().toLowerCase() || null,
      formatName: String(media.formatName || '').trim().toLowerCase(),
    },
    sampleFrames: samples,
    characterChecklist,
    blockingIssues,
    warnings,
    manualFocus,
  }
}

export function isRecoveryVideoInspectionReady(report) {
  const validated = buildRecoveryVideoInspectionReport({
    media: report?.media,
    sampleFrames: report?.sampleFrames,
  })
  return (
    report?.status === 'ready' &&
    validated.status === 'ready'
  )
}

export function resolveRecoveryReleaseReadiness(report) {
  if (!isRecoveryVideoInspectionReady(report)) {
    return {
      status: 'needs-technical-check',
      canPublishDirectly: false,
      message: '候选视频必须先完成自动技术检查和三张抽帧证据，不能直接发布到平台。',
      blockingIssues: Array.isArray(report?.blockingIssues) ? report.blockingIssues : [],
    }
  }

  const media = report?.media || {}
  const blockingIssues = []
  const width = Number(media.width) || 0
  const height = Number(media.height) || 0
  const frameRate = Number(media.frameRate) || 0
  const videoCodec = String(media.videoCodec || '').trim().toLowerCase()
  const audioCodec = String(media.audioCodec || '').trim().toLowerCase()
  const formatName = String(media.formatName || '').trim().toLowerCase()

  if (width !== RELEASE_PROFILE.width || height !== RELEASE_PROFILE.height) {
    blockingIssues.push({
      code: 'invalid-vertical-resolution',
      message: `成片规格为 ${width}x${height}，必须是 ${RELEASE_PROFILE.width}x${RELEASE_PROFILE.height} 的竖屏视频。`,
    })
  }
  if (frameRate !== RELEASE_PROFILE.frameRate) {
    blockingIssues.push({
      code: 'invalid-frame-rate',
      message: `成片帧率为 ${frameRate || 0}fps，必须是 ${RELEASE_PROFILE.frameRate}fps。`,
    })
  }
  if (videoCodec !== RELEASE_PROFILE.videoCodec) {
    blockingIssues.push({
      code: 'invalid-video-codec',
      message: '成片视频编码必须为 H.264。',
    })
  }
  if (audioCodec !== RELEASE_PROFILE.audioCodec) {
    blockingIssues.push({
      code: 'invalid-audio-codec',
      message: '成片音频编码必须为 AAC。',
    })
  }
  if (!formatName.includes('mp4')) {
    blockingIssues.push({
      code: 'invalid-container-format',
      message: '成片容器必须为 MP4。',
    })
  }

  if (blockingIssues.length) {
    return {
      status: 'needs-vertical-final-edit',
      canPublishDirectly: false,
      message: '候选视频仍需进入 1080x1920 / 24fps 竖屏终剪，不能直接发布到平台。',
      blockingIssues,
    }
  }

  return {
    status: 'release-format-ready',
    canPublishDirectly: true,
    message: '候选视频符合 1080x1920 / 24fps / H.264 + AAC / MP4 发布技术规格。',
    blockingIssues: [],
  }
}
