export function buildDefaultVerticalProductionTemplate() {
  return {
    id: 'vertical-1080x1920-v1',
    aspectRatio: '9:16',
    resolution: { width: 1080, height: 1920 },
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    subtitleSafeArea: {
      top: 154,
      right: 65,
      bottom: 346,
      left: 65,
    },
  }
}

export function normalizeVerticalExportConfig() {
  const template = buildDefaultVerticalProductionTemplate()
  return {
    format: 'H.264 / MP4',
    resolution: `${template.resolution.width} x ${template.resolution.height} (vertical)`,
    frameRate: template.frameRate,
    videoCodec: template.videoCodec,
    audioCodec: template.audioCodec,
    templateId: template.id,
  }
}

export function resolveVerticalSubtitleBurnIn() {
  return true
}

export function buildVerticalCoverFilter({ width, height } = {}) {
  const targetWidth = Math.max(2, Math.floor(Number(width) || 0))
  const targetHeight = Math.max(2, Math.floor(Number(height) || 0))
  if (!targetWidth || !targetHeight) {
    throw new Error('vertical cover filter requires a positive target size')
  }
  return `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}:(iw-ow)/2:(ih-oh)/2`
}

function hasPersistentLetterboxBars(edgeLuma = {}) {
  const top = Number(edgeLuma.top)
  const middle = Number(edgeLuma.middle)
  const bottom = Number(edgeLuma.bottom)
  if (![top, middle, bottom].every(Number.isFinite)) return false

  const borderAverage = (top + bottom) / 2
  return borderAverage <= 20 && middle >= 30 && borderAverage / middle <= 0.55
}

export function evaluateRenderedMediaSpec({
  width,
  height,
  frameRate,
  videoCodec,
  audioCodec,
  audioSignal,
  edgeLuma,
  formatName,
} = {}) {
  const template = buildDefaultVerticalProductionTemplate()
  const blockingIssues = []

  if (
    Number(width) !== template.resolution.width ||
    Number(height) !== template.resolution.height
  ) {
    blockingIssues.push({
      code: 'invalid-vertical-resolution',
      message: `成片规格为 ${Number(width) || 0}x${Number(height) || 0}，必须是 ${template.resolution.width}x${template.resolution.height} 的竖屏视频。`,
    })
  }
  const normalizedFrameRate = Number(frameRate)
  if (
    !Number.isFinite(normalizedFrameRate) ||
    Math.abs(normalizedFrameRate - template.frameRate) > 0.01
  ) {
    blockingIssues.push({
      code: 'invalid-frame-rate',
      message: `成片帧率为 ${Number.isFinite(normalizedFrameRate) ? `${normalizedFrameRate}fps` : '未知'}，必须是 ${template.frameRate}fps。`,
    })
  }
  if (String(videoCodec || '').trim().toLowerCase() !== template.videoCodec) {
    blockingIssues.push({
      code: 'invalid-video-codec',
      message: '成片视频编码必须为 H.264。',
    })
  }
  if (String(audioCodec || '').trim().toLowerCase() !== template.audioCodec) {
    blockingIssues.push({
      code: 'invalid-audio-codec',
      message: '成片音频编码必须为 AAC。',
    })
  }
  if (String(audioSignal || '').trim().toLowerCase() === 'silent') {
    blockingIssues.push({
      code: 'silent-audio-signal',
      message: '成片音轨检测为静音，不能进入人工签核或发布候选。',
    })
  }
  if (hasPersistentLetterboxBars(edgeLuma)) {
    blockingIssues.push({
      code: 'persistent-letterbox-bars',
      message: '成片检测到明显上下黑边，不能作为合格竖屏成片进入人工签核或发布候选。',
    })
  }
  if (!String(formatName || '').toLowerCase().includes('mp4')) {
    blockingIssues.push({
      code: 'invalid-container-format',
      message: '成片容器必须为 MP4。',
    })
  }

  return {
    passed: blockingIssues.length === 0,
    blockingIssues,
  }
}

export function evaluateVerticalProductionPreflight({
  template,
  audioTracks = {},
  hasSpeech = false,
  subtitleCues = [],
} = {}) {
  const blockingIssues = []
  const supportedTracks = ['music', 'sfx']
  const allowedLicenseStatuses = new Set(['authorized', 'owned', 'public-domain'])

  for (const trackKey of supportedTracks) {
    for (const asset of Array.isArray(audioTracks[trackKey]) ? audioTracks[trackKey] : []) {
      if (allowedLicenseStatuses.has(String(asset?.licenseStatus || '').trim())) continue

      blockingIssues.push({
        code: 'unlicensed-audio-source',
        message: `BGM/SFX「${String(asset?.title || asset?.id || '未命名素材')}」缺少可用授权记录，不能进入正式导出。`,
        assetId: Number(asset?.id) || null,
      })
    }
  }

  const hasSubtitleCues = Array.isArray(subtitleCues) && subtitleCues.some(
    (cue) => cue?.enabled !== false && String(cue?.text || '').trim(),
  )
  if (hasSpeech && !hasSubtitleCues) {
    blockingIssues.push({
      code: 'missing-subtitles',
      message: '当前成片存在对白或旁白，必须生成并确认字幕后才能导出。',
    })
  }

  return {
    passed: Boolean(template) && blockingIssues.length === 0,
    blockingIssues,
  }
}

export function evaluateFinalEditVerticalPreflight({
  template,
  audioTracks = {},
  audioMix = {},
  subtitleCues = [],
} = {}) {
  const enabledAudioTracks = Object.fromEntries(
    ['dialogue', 'narration', 'music', 'sfx'].map((trackKey) => [
      trackKey,
      audioMix?.[trackKey]?.enabled === false
        ? []
        : (Array.isArray(audioTracks?.[trackKey]) ? audioTracks[trackKey] : []),
    ]),
  )
  const hasSpeech =
    enabledAudioTracks.dialogue.length > 0 ||
    enabledAudioTracks.narration.length > 0

  return evaluateVerticalProductionPreflight({
    template,
    audioTracks: enabledAudioTracks,
    hasSpeech,
    subtitleCues,
  })
}
