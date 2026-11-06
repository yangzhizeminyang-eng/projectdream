export const MARKET_QUALITY_BENCHMARK_VERSION = 'market-viral-v1'

const TARGET = {
  width: 1080,
  height: 1920,
  frameRate: 24,
  videoCodec: 'h264',
  audioCodec: 'aac',
  minFontSize: 42,
  minMarginV: 300,
  idealLufsMin: -18,
  idealLufsMax: -14,
  acceptableLufsMin: -24,
  acceptableLufsMax: -12,
  maxTruePeakDbtp: -1,
  maxOnsetErrorSeconds: 0.15,
  minOverlapRatio: 0.6,
  maxFirstSpeechStartSeconds: 1.5,
  maxShotDurationSeconds: 8,
  minShotDensityPerTenSeconds: 2,
  maxSubtitleTimelineDriftSeconds: 0.15,
}

function finiteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100
}

function parseTimestamp(value) {
  const match = String(value || '').trim().match(
    /^(\d+):(\d{2}):(\d{2}),(\d{3})$/,
  )
  if (!match) return null
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  )
}

export function parseSrtCues(value) {
  const source = String(value || '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []

  return source
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n')
      const index = Number(lines[0])
      const timing = String(lines[1] || '').match(
        /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/,
      )
      if (!Number.isSafeInteger(index) || !timing) return null
      const startSeconds = parseTimestamp(timing[1])
      const endSeconds = parseTimestamp(timing[2])
      const text = lines
        .slice(2)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')
      if (
        startSeconds === null ||
        endSeconds === null ||
        endSeconds <= startSeconds ||
        !text
      ) {
        return null
      }
      return {
        index,
        startSeconds: round(startSeconds),
        endSeconds: round(endSeconds),
        text,
      }
    })
    .filter(Boolean)
}

function addBlocker(blockers, code, message, details = {}) {
  blockers.push({ code, message, ...details })
}

function normalizeSubtitleText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function compareSubtitleCues(cues, expectedCues, blockers) {
  if (!Array.isArray(expectedCues)) {
    return {
      passed: true,
      compared: false,
      textMismatchCount: 0,
      timelineDriftCount: 0,
    }
  }

  const expected = expectedCues.filter(Boolean)
  let textMismatchCount = 0
  let timelineDriftCount = 0
  if (cues.length !== expected.length) {
    addBlocker(
      blockers,
      'subtitle-cue-count-mismatch',
      '烧录字幕与编辑时间线的 cue 数量不一致。',
      { actualCueCount: cues.length, expectedCueCount: expected.length },
    )
  }

  const count = Math.max(cues.length, expected.length)
  for (let index = 0; index < count; index += 1) {
    const actual = cues[index]
    const wanted = expected[index]
    if (!actual || !wanted) continue
    if (normalizeSubtitleText(actual.text) !== normalizeSubtitleText(wanted.text)) {
      textMismatchCount += 1
    }
    const startDrift = Math.abs(Number(actual.startSeconds) - Number(wanted.startSeconds))
    const endDrift = Math.abs(Number(actual.endSeconds) - Number(wanted.endSeconds))
    if (
      !Number.isFinite(startDrift) ||
      !Number.isFinite(endDrift) ||
      startDrift > TARGET.maxSubtitleTimelineDriftSeconds ||
      endDrift > TARGET.maxSubtitleTimelineDriftSeconds
    ) {
      timelineDriftCount += 1
    }
  }

  if (textMismatchCount > 0) {
    addBlocker(
      blockers,
      'subtitle-text-mismatch',
      '烧录字幕文字与编辑时间线不一致，必须先修正字幕文本。',
      { mismatchCount: textMismatchCount },
    )
  }
  if (timelineDriftCount > 0) {
    addBlocker(
      blockers,
      'subtitle-timeline-drift',
      '烧录字幕时间轴与编辑时间线偏差超过内部容差。',
      { driftCount: timelineDriftCount },
    )
  }

  return {
    passed: textMismatchCount === 0 && timelineDriftCount === 0 && cues.length === expected.length,
    compared: true,
    textMismatchCount,
    timelineDriftCount,
  }
}

function evaluateMedia(media = {}, blockers, warnings) {
  const width = finiteNumber(media.width)
  const height = finiteNumber(media.height)
  const frameRate = finiteNumber(media.frameRate)
  const audioSampleRate = finiteNumber(media.audioSampleRate)
  const validVertical =
    width === TARGET.width &&
    height === TARGET.height &&
    frameRate === TARGET.frameRate &&
    String(media.videoCodec || '').toLowerCase() === TARGET.videoCodec &&
    String(media.audioCodec || '').toLowerCase() === TARGET.audioCodec &&
    String(media.formatName || '').toLowerCase().includes('mp4')

  if (!validVertical) {
    addBlocker(
      blockers,
      'invalid-vertical-spec',
      '未达到爆款漫剧竖屏交付规格：1080x1920、24fps、H.264、AAC、MP4。',
      { observed: { width, height, frameRate, videoCodec: media.videoCodec, audioCodec: media.audioCodec } },
    )
  }

  if (audioSampleRate !== 48000) {
    addBlocker(
      blockers,
      'audio-sample-rate',
      '终剪音轨采样率必须固定为 48kHz，避免不同平台转码后出现响度或同步漂移。',
      { audioSampleRate, expected: 48000 },
    )
  }

  if (media.blackBarDetected === true) {
    addBlocker(
      blockers,
      'black-bars-detected',
      '成片检测到明显黑边，不能作为合格竖屏成片进入发布候选。',
    )
  }
  if (media.freezeDetected === true) {
    addBlocker(
      blockers,
      'freeze-frame-risk',
      '成片检测到疑似冻结帧或长时间无画面变化，需要人工复核或返工。',
    )
  }
  if (media.droppedFrameRisk === true) {
    addBlocker(
      blockers,
      'dropped-frame-risk',
      '成片检测到疑似跳帧或时间戳不连续，需要人工复核或返工。',
    )
  }

  return {
    passed:
      validVertical &&
      audioSampleRate === 48000 &&
      media.blackBarDetected !== true &&
      media.freezeDetected !== true &&
      media.droppedFrameRisk !== true,
    blackBarPassed: media.blackBarDetected !== true,
    frameIntegrityPassed:
      media.freezeDetected !== true && media.droppedFrameRisk !== true,
    score:
      validVertical &&
      audioSampleRate === 48000 &&
      media.blackBarDetected !== true &&
      media.freezeDetected !== true &&
      media.droppedFrameRisk !== true
        ? 20
        : 0,
    observed: {
      width,
      height,
      frameRate,
      audioSampleRate,
      blackBarDetected: media.blackBarDetected === true,
      freezeDetected: media.freezeDetected === true,
      droppedFrameRisk: media.droppedFrameRisk === true,
    },
  }
}

function evaluateAudio(audio = {}, blockers, warnings) {
  const integratedLufs = finiteNumber(audio.integratedLufs)
  const truePeakDbtp = finiteNumber(audio.truePeakDbtp)
  const clippedSamples = Math.max(0, Number(audio.clippedSamples) || 0)
  const measurable = audio.measurable === true
  let score = 25

  if (!measurable) {
    addBlocker(blockers, 'audio-not-measurable', '音轨没有可测量的有效声音信号。')
    score = 0
  }
  if (integratedLufs === null || integratedLufs < TARGET.acceptableLufsMin || integratedLufs > TARGET.acceptableLufsMax) {
    addBlocker(blockers, 'audio-too-quiet', '对白响度不在移动端可接受范围内，不能按爆款标准交付。', { integratedLufs })
    score = Math.min(score, 5)
  } else if (integratedLufs < TARGET.idealLufsMin || integratedLufs > TARGET.idealLufsMax) {
    warnings.push({
      code: 'audio-loudness-outside-ideal',
      message: '对白有声音，但响度未落在移动端短视频的内部目标区间。',
      integratedLufs,
    })
    score -= 4
  }
  if (truePeakDbtp === null || truePeakDbtp > TARGET.maxTruePeakDbtp) {
    addBlocker(blockers, 'audio-true-peak-risk', '音频峰值距离削波过近或已超过安全上限。', { truePeakDbtp })
    score = Math.min(score, 8)
  }
  if (clippedSamples > 0) {
    addBlocker(blockers, 'audio-clipping', '检测到削波样本，存在爆音或失真风险。', { clippedSamples })
    score = Math.min(score, 4)
  }
  if (audio.speechCoverageRatio !== undefined && Number(audio.speechCoverageRatio) < 0.03) {
    warnings.push({
      code: 'low-speech-coverage',
      message: '有效对白活动占比偏低，需要确认是否存在过长静音或对白断裂。',
      speechCoverageRatio: round(audio.speechCoverageRatio),
    })
    score -= 3
  }

  return {
    passed: !blockers.some((item) => item.code.startsWith('audio-')),
    score: Math.max(0, score),
    observed: { integratedLufs, truePeakDbtp, clippedSamples, measurable },
  }
}

function evaluateSubtitle(subtitle = {}, durationSeconds, blockers, warnings) {
  const cues = Array.isArray(subtitle.cues) ? subtitle.cues : []
  let score = 20
  let valid = cues.length > 0

  if (!valid) {
    addBlocker(blockers, 'subtitle-missing', '存在对白内容但没有有效字幕 cue。')
    score = 0
  }

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]
    if (cue.startSeconds < 0 || cue.endSeconds > durationSeconds || cue.endSeconds <= cue.startSeconds) {
      addBlocker(blockers, 'subtitle-out-of-range', '字幕时间轴超出成片范围或时长非法。', { cueIndex: cue.index })
      score = Math.min(score, 5)
    }
    const next = cues[index + 1]
    if (next && cue.endSeconds > next.startSeconds) {
      addBlocker(blockers, 'subtitle-overlap', '字幕 cue 发生重叠，移动端阅读会产生抢字。', { cueIndex: cue.index })
      score = Math.min(score, 8)
    }
  }

  const fontSize = finiteNumber(subtitle.fontSize)
  const marginV = finiteNumber(subtitle.marginV)
  if (fontSize === null || fontSize < TARGET.minFontSize || marginV === null || marginV < TARGET.minMarginV) {
    addBlocker(blockers, 'subtitle-unsafe-area', '字幕字号或底部安全距离不足，容易被平台操作区遮挡。', { fontSize, marginV })
    score = Math.min(score, 8)
  }

  const textTimeline = compareSubtitleCues(cues, subtitle.expectedCues, blockers)

  if (cues.length > 0 && cues[0].startSeconds > TARGET.maxFirstSpeechStartSeconds) {
    warnings.push({
      code: 'late-opening-subtitle',
      message: '首条对白出现较晚，可能削弱短视频开场抓人能力。',
      firstCueStartSeconds: cues[0].startSeconds,
    })
    score -= 3
  }

  return {
    passed: !blockers.some((item) => item.code.startsWith('subtitle-')),
    score: Math.max(0, score),
    cueCount: cues.length,
    fontSize,
    marginV,
    textTimelinePassed: textTimeline.passed,
    textTimelineCompared: textTimeline.compared,
    textMismatchCount: textTimeline.textMismatchCount,
    timelineDriftCount: textTimeline.timelineDriftCount,
  }
}

function evaluateCharacters(characters, blockers, warnings) {
  if (!characters || typeof characters !== 'object') {
    return {
      passed: true,
      notAvailable: true,
      score: 15,
      checkedClipCount: 0,
      mismatchCount: 0,
      missingBaselineCount: 0,
    }
  }

  const clips = Array.isArray(characters.clips) ? characters.clips : []
  const baselines = Array.isArray(characters.baselines) ? characters.baselines : []
  const baselineByCharacterId = new Map(
    baselines.map((baseline) => [Number(baseline?.characterId), baseline]),
  )
  let mismatchCount = 0
  let missingBaselineCount = 0
  let missingVersionCount = 0

  for (const clip of clips) {
    const characterId = Number(clip?.characterId) || 0
    if (!characterId) continue
    const baseline = baselineByCharacterId.get(characterId)
    if (!baseline) {
      missingBaselineCount += 1
      continue
    }
    if (!Number.isInteger(Number(clip?.characterVersionNo)) || Number(clip?.characterVersionNo) <= 0) {
      missingVersionCount += 1
      continue
    }
    if (Number(clip?.characterVersionNo) !== Number(baseline?.versionNo)) {
      mismatchCount += 1
    }
    if (
      !String(baseline?.appearance || '').trim() ||
      !String(baseline?.costume || '').trim() ||
      !String(baseline?.referenceImageUrl || '').trim()
    ) {
      addBlocker(
        blockers,
        'character-baseline-incomplete',
        '角色一致性基线缺少外貌、服装或定妆参考图，不能证明可稳定批量生产。',
        { characterId },
      )
    }
  }

  if (missingBaselineCount > 0) {
    addBlocker(
      blockers,
      'character-baseline-missing',
      '部分出镜角色没有可核验的一致性生产基线。',
      { missingBaselineCount },
    )
  }
  if (mismatchCount > 0) {
    addBlocker(
      blockers,
      'character-version-mismatch',
      '成片使用的角色版本与当前生产基线不一致，不能进入稳定生产。',
      { mismatchCount },
    )
  }
  if (missingVersionCount > 0) {
    addBlocker(
      blockers,
      'character-version-evidence-missing',
      '成片角色元数据缺少明确生产版本号，不能证明使用的是当前角色基线。',
      { missingVersionCount },
    )
  }
  if (!clips.length) {
    warnings.push({
      code: 'character-evidence-empty',
      message: '当前样本没有可核验的出镜角色元数据；人物一致性仍需人工确认。',
    })
  }

  return {
    passed: missingBaselineCount === 0 && mismatchCount === 0,
    notAvailable: false,
    score: missingBaselineCount === 0 && mismatchCount === 0 ? 15 : 0,
    checkedClipCount: clips.length,
    mismatchCount,
    missingBaselineCount,
    missingVersionCount,
  }
}

function evaluatePacing(pacing, blockers, warnings) {
  if (!pacing || typeof pacing !== 'object') {
    return {
      passed: true,
      notAvailable: true,
      score: 10,
      shotCount: 0,
      shotDensityPerTenSeconds: null,
      maxShotDurationSeconds: null,
    }
  }

  const clips = Array.isArray(pacing.clips) ? pacing.clips.filter(Boolean) : []
  const totalDurationSeconds = finiteNumber(pacing.totalDurationSeconds) || 0
  const durations = clips
    .map((clip) => finiteNumber(clip?.durationSeconds))
    .filter((value) => value !== null && value > 0)
  const maxShotDurationSeconds = durations.length ? Math.max(...durations) : null
  const shotDensityPerTenSeconds =
    totalDurationSeconds > 0 ? (clips.length / totalDurationSeconds) * 10 : null
  if (maxShotDurationSeconds !== null && maxShotDurationSeconds > TARGET.maxShotDurationSeconds) {
    addBlocker(
      blockers,
      'pacing-shot-too-long',
      '存在超过内部节奏上限的长镜头，可能削弱短剧追更节奏。',
      { maxShotDurationSeconds },
    )
  }
  if (
    shotDensityPerTenSeconds !== null &&
    shotDensityPerTenSeconds < TARGET.minShotDensityPerTenSeconds
  ) {
    addBlocker(
      blockers,
      'pacing-shot-density-low',
      '镜头密度低于内部短剧代理阈值，需要人工确认开头钩子和冲突推进是否足够快。',
      { shotDensityPerTenSeconds: round(shotDensityPerTenSeconds) },
    )
  }
  if (clips.length && clips.every((clip) => String(clip?.sourceType || '') === 'static')) {
    warnings.push({
      code: 'pacing-all-static',
      message: '当前样本全部由静帧承载，动作连续性和镜头动势仍需人工确认。',
    })
  }

  return {
    passed: !blockers.some((item) => item.code.startsWith('pacing-')),
    notAvailable: false,
    score: blockers.some((item) => item.code.startsWith('pacing-')) ? 0 : 10,
    shotCount: clips.length,
    shotDensityPerTenSeconds:
      shotDensityPerTenSeconds === null ? null : round(shotDensityPerTenSeconds),
    maxShotDurationSeconds,
  }
}

function evaluateSync(sync = {}, blockers) {
  const alignments = Array.isArray(sync.cueAlignment) ? sync.cueAlignment : []
  if (!alignments.length) {
    addBlocker(blockers, 'speech-sync-evidence-missing', '没有对白活动与字幕 cue 的同步证据。')
    return { passed: false, score: 0, cueCount: 0 }
  }

  const unsafe = alignments.filter((item) =>
    Number(item.onsetErrorSeconds) > TARGET.maxOnsetErrorSeconds ||
    Number(item.overlapRatio) < TARGET.minOverlapRatio,
  )
  if (unsafe.length) {
    addBlocker(blockers, 'speech-sync-out-of-tolerance', '对白活动与字幕时间轴偏差超过内部容差。', {
      failedCueCount: unsafe.length,
    })
  }

  return {
    passed: unsafe.length === 0,
    score: unsafe.length === 0 ? 20 : Math.max(0, 20 - unsafe.length * 6),
    cueCount: alignments.length,
  }
}

function evaluateHook(hook = {}, warnings) {
  const firstSpeechStartSeconds = finiteNumber(hook.firstSpeechStartSeconds)
  const maxShotDurationSeconds = finiteNumber(hook.maxShotDurationSeconds)
  let score = 15

  if (firstSpeechStartSeconds === null || firstSpeechStartSeconds > TARGET.maxFirstSpeechStartSeconds) {
    warnings.push({
      code: 'hook-not-strong-enough',
      message: '代理检查无法证明开场在 1.5 秒内形成有效信息点。',
      firstSpeechStartSeconds,
    })
    score -= 7
  }
  if (maxShotDurationSeconds !== null && maxShotDurationSeconds > TARGET.maxShotDurationSeconds) {
    warnings.push({
      code: 'pacing-too-slow',
      message: '单镜头持续时间偏长，可能不符合短剧短视频的快速节奏。',
      maxShotDurationSeconds,
    })
    score -= 5
  }

  return { score: Math.max(0, score), firstSpeechStartSeconds, maxShotDurationSeconds }
}

function evaluatePlatform(platform = {}, blockers) {
  const complete =
    platform.aiDisclosureConfigured === true &&
    platform.copyrightEvidenceConfigured === true
  if (!complete) {
    addBlocker(
      blockers,
      'platform-evidence-incomplete',
      'AI 标识或版权/投稿证据未完整配置，不能进入平台发布候选。',
    )
  }
  return { passed: complete, score: complete ? 10 : 0 }
}

export function evaluateMarketQuality(input = {}) {
  const blockers = []
  const warnings = []
  const media = evaluateMedia(input.media, blockers, warnings)
  const audio = evaluateAudio(input.audio, blockers, warnings)
  const subtitle = evaluateSubtitle(
    input.subtitle,
    finiteNumber(input.media?.durationSeconds) || 0,
    blockers,
    warnings,
  )
  const sync = evaluateSync(input.sync, blockers)
  const hook = evaluateHook(input.hook, warnings)
  const characters = evaluateCharacters(input.characters, blockers, warnings)
  const pacing = evaluatePacing(input.pacing, blockers, warnings)
  const platform = evaluatePlatform(input.platform, blockers)
  const overallScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        media.score +
          audio.score +
          subtitle.score +
          sync.score +
          hook.score +
          characters.score +
          pacing.score +
          platform.score,
      ),
    ),
  )
  const proxyPassed = blockers.length === 0
  const technicalBlockers = blockers.filter(
    (item) => item.code !== 'platform-evidence-incomplete',
  )
  const technicalProxyPassed = technicalBlockers.length === 0

  return {
    benchmarkVersion: MARKET_QUALITY_BENCHMARK_VERSION,
    target: TARGET,
    proxyPassed,
    technicalProxyPassed,
    technicalBlockers,
    releaseEligible: false,
    overallScore,
    tier: proxyPassed
      ? overallScore >= 90
        ? 'A'
        : overallScore >= 80
          ? 'B'
          : 'C'
      : 'blocked',
    hardBlockers: blockers,
    warnings,
    dimensions: { media, audio, subtitle, sync, hook, characters, pacing, platform },
    publishCandidate: {
      status: blockers.length === 0 ? 'ready-for-human-review' : 'blocked',
      machinePassed: blockers.length === 0,
      requiresHumanReview: true,
      manualChecks: [
        '完整播放后的音质、响度平衡、爆音/失真和对白同步',
        '画面审美、人物表演、动作连续性和字幕可读性',
        '开头钩子、冲突节奏和内容是否值得发布',
        '发布当天平台 AI 标识、版权与投稿字段',
      ],
    },
    disclaimer:
      '这是机器代理质检，不等于真人听感、内容审美、平台审核或实际收入验证。',
  }
}
