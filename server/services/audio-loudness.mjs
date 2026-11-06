export const TARGET_FINAL_MIX_LOUDNESS = {
  integratedLufs: -16,
  loudnessRange: 11,
  truePeakDbtp: -1.5,
}

export const FINAL_MIX_SPEECH_GAIN = 1

export function parseLoudnormMetrics(output = '') {
  const source = String(output || '')
  const readMetric = (name) => {
    const value = Number(source.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`))?.[1])
    return Number.isFinite(value) ? value : null
  }

  return {
    integratedLufs: readMetric('input_i'),
    truePeakDbtp: readMetric('input_tp'),
    loudnessRange: readMetric('input_lra'),
  }
}

export function resolveFinalMixGainDb(
  integratedLufs,
  targetLufs = TARGET_FINAL_MIX_LOUDNESS.integratedLufs,
) {
  const measured = Number(integratedLufs)
  const target = Number(targetLufs)
  if (!Number.isFinite(measured) || !Number.isFinite(target)) return 0
  const correction = Math.max(-6, Math.min(6, target - measured))
  return Math.abs(correction) < 0.05 ? 0 : Number(correction.toFixed(2))
}

export function buildFinalMixOutputArgs() {
  return [
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-b:a',
    '128k',
  ]
}

export function buildFinalMixPostProcessFilter(durationSeconds, finalMixGainDb = 0) {
  const duration = Math.max(0.25, Number(durationSeconds) || 0.25)
  const gain = Number(finalMixGainDb)
  const filters = [
    'aresample=48000',
    `loudnorm=I=${TARGET_FINAL_MIX_LOUDNESS.integratedLufs}:LRA=${TARGET_FINAL_MIX_LOUDNESS.loudnessRange}:TP=${TARGET_FINAL_MIX_LOUDNESS.truePeakDbtp}:linear=true`,
    'aresample=48000',
    'aresample=async=1:first_pts=0',
    'apad',
    `atrim=0:${duration}`,
  ]
  if (Number.isFinite(gain) && Math.abs(gain) >= 0.05) {
    filters.push(`volume=${gain.toFixed(2)}dB`)
  }
  return filters.join(',')
}
