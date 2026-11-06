const SUBTITLE_PIXEL_THRESHOLDS = {
  // Short cues such as a single Chinese character occupy very few pixels.
  // Keep a low average threshold, but retain a bright-pixel floor to reject
  // unchanged frames and compression noise.
  // Short cues such as a single Chinese character occupy very few pixels.
  // Keep a low average threshold, but retain a bright-pixel floor to reject
  // unchanged frames and compression noise.
  lumaAverage: 0.4,
  lumaMax: 32,
}

function formatFilterNumber(value) {
  return Number(Number(value).toFixed(3)).toString()
}

export function buildSubtitleBurnInProbeFilter({
  second = 0,
  width = 2,
  cropHeight = 2,
  cropY = 0,
} = {}) {
  const sampleSecond = Number.isFinite(Number(second)) ? Number(second) : 0
  const start = Math.max(0, sampleSecond - 0.02)
  const end = Math.max(start + 0.04, sampleSecond + 0.02)
  const normalizedWidth = Math.max(2, Math.floor(Number(width) || 0))
  const normalizedCropHeight = Math.max(2, Math.floor(Number(cropHeight) || 0))
  const normalizedCropY = Math.max(0, Math.floor(Number(cropY) || 0))
  const trim = `start=${formatFilterNumber(start)}:end=${formatFilterNumber(end)}`

  return (
    `[0:v]trim=${trim},setpts=PTS-STARTPTS[base];` +
    `[1:v]trim=${trim},setpts=PTS-STARTPTS[final];` +
    `[base][final]blend=all_mode=difference,` +
    `crop=${normalizedWidth}:${normalizedCropHeight}:0:${normalizedCropY},` +
    'signalstats,metadata=print:file=-[probe]'
  )
}

export function parseSubtitleBurnInProbeOutput({ stdout = '', stderr = '' } = {}) {
  const output = `${String(stdout || '')}\n${String(stderr || '')}`
  const lumaAverage = Number(
    output.match(/lavfi\.signalstats\.YAVG=([0-9.+-]+)/)?.[1],
  )
  const lumaMax = Number(
    output.match(/lavfi\.signalstats\.YMAX=([0-9.+-]+)/)?.[1],
  )

  return {
    lumaAverage: Number.isFinite(lumaAverage) ? lumaAverage : 0,
    lumaMax: Number.isFinite(lumaMax) ? lumaMax : 0,
  }
}

function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function extractSubtitleCueMidpoints(subtitleText = '') {
  const source = String(subtitleText || '').replace(/\r\n?/g, '\n')
  const midpoints = []
  const cuePattern =
    /(?:^|\n)\s*\d+\s*\n\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|$)/g

  let match
  while ((match = cuePattern.exec(source)) !== null) {
    const text = String(match[9] || '').trim()
    if (!text) continue

    const start =
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / 1000
    const end =
      Number(match[5]) * 3600 +
      Number(match[6]) * 60 +
      Number(match[7]) +
      Number(match[8]) / 1000
    if (end <= start) continue
    midpoints.push(Number(((start + end) / 2).toFixed(3)))
  }

  return midpoints
}

export function evaluateSubtitleBurnInProbe({
  subtitleText = '',
  samples = [],
} = {}) {
  const hasSubtitleText = Boolean(String(subtitleText || '').trim())
  if (!hasSubtitleText) {
    return {
      passed: true,
      reason: 'no-subtitles',
      sampleCount: 0,
      failedSamples: [],
    }
  }

  const expectedSampleCount = extractSubtitleCueMidpoints(subtitleText).length
  const normalizedSamples = (Array.isArray(samples) ? samples : [])
    .map((sample) => ({
      second: Number(Number(sample?.second || 0).toFixed(3)),
      lumaAverage: positiveNumber(sample?.lumaAverage),
      lumaMax: positiveNumber(sample?.lumaMax),
    }))
    .filter((sample) => sample.second >= 0)
  const failedSamples = normalizedSamples
    .filter(
      (sample) =>
        sample.lumaAverage < SUBTITLE_PIXEL_THRESHOLDS.lumaAverage ||
        sample.lumaMax < SUBTITLE_PIXEL_THRESHOLDS.lumaMax,
    )
    .map((sample) => sample.second)

  const passed =
    expectedSampleCount > 0 &&
    normalizedSamples.length >= expectedSampleCount &&
    failedSamples.length === 0

  return {
    passed,
    reason: passed ? 'subtitle-pixels-detected' : 'subtitle-pixels-not-detected',
    sampleCount: normalizedSamples.length,
    expectedSampleCount,
    failedSamples,
    thresholds: { ...SUBTITLE_PIXEL_THRESHOLDS },
    samples: normalizedSamples,
  }
}
