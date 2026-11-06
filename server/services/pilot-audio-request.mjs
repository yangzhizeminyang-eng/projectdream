import { resolveEpisodeAudioTrack } from '../../scripts/episode-production-options.mjs'

export function buildPilotAudioGenerationRequest(job = {}) {
  const track = resolveEpisodeAudioTrack({
    characterId: job.audioCharacterId,
  })

  return {
    trackType: track.trackType,
    characterId: track.characterId,
    voiceProfileKey: track.voiceProfileKey,
    voiceName: track.voiceName || null,
    modelName: track.modelName || null,
    languageType: track.languageType || 'Chinese',
    characterName: track.characterName || null,
    storyboardId: Number(job.storyboardId) || null,
    text: String(job.text || '').trim(),
    durationSeconds: Math.max(2, Number(job.durationSeconds) || 3),
    candidateCount: Math.max(1, Number(job.candidateCount) || 1),
  }
}
