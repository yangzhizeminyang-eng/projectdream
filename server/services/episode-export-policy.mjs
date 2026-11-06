export function normalizeEpisodeExportRequest({ episodeNo, preserveSourceAudio = false } = {}) {
  if (episodeNo === undefined || episodeNo === null || episodeNo === '') {
    return { episodeNo: null, preserveSourceAudio: preserveSourceAudio === true }
  }
  const parsed = Number(episodeNo)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error('无效的 episodeNo')
  }
  return { episodeNo: parsed, preserveSourceAudio: preserveSourceAudio === true }
}

export function resolveEpisodeExportPolicy({ episodeNo } = {}) {
  if (!(Number(episodeNo) > 0)) return null
  return {
    preserveClipBoundaries: true,
    transition: 'cut',
    burnSubtitle: false,
    includeAudioTracks: true,
    generateSubtitleSidecar: false,
  }
}
