function positive(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
export function buildSubtitleCleanupFilter({ topRatio = 0.76, bottomRatio = 1, band = 12 } = {}) {
  const top = Math.max(0.5, Math.min(0.95, Number(topRatio) || 0.76))
  const bottom = Math.max(top + 0.01, Math.min(1, Number(bottomRatio) || 1))
  const safeBand = Math.max(1, Math.min(64, Math.round(positive(band, 12))))
  return `delogo=x=0:y=ih*${top.toFixed(3)}:w=iw:h=ih*${(bottom - top).toFixed(3)}:band=${safeBand}:show=0`
}

export function buildSubtitleCleanupFfmpegArgs({ inputPath, outputPath, filter } = {}) {
  if (!String(inputPath || '').trim() || !String(outputPath || '').trim()) {
    throw new Error('subtitle cleanup requires input and output paths')
  }
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-vf', filter || buildSubtitleCleanupFilter(),
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outputPath,
  ]
}
