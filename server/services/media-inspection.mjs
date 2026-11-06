function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || '')
    .split('/')
    .map((part) => Number(part))
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0
  }
  return numerator / denominator
}

export function buildMediaInspectionSummary(payload = {}) {
  const streams = Array.isArray(payload.streams) ? payload.streams : []
  const video = streams.find((stream) => stream?.codec_type === 'video') || {}
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || {}

  return {
    width: finiteNumber(video.width),
    height: finiteNumber(video.height),
    frameRate: parseFrameRate(video.r_frame_rate),
    durationSeconds: finiteNumber(payload.format?.duration),
    videoCodec: String(video.codec_name || '').trim().toLowerCase(),
    audioCodec: String(audio.codec_name || '').trim().toLowerCase(),
    audioSampleRate: finiteNumber(audio.sample_rate),
    formatName: String(payload.format?.format_name || '').trim().toLowerCase(),
  }
}
