import { normalizeObjectKey } from './object-storage.mjs'

function requireProjectId(projectId, errorMessage) {
  const normalizedProjectId = Number(projectId)
  if (!Number.isSafeInteger(normalizedProjectId) || normalizedProjectId <= 0) {
    throw new Error(errorMessage)
  }
  return normalizedProjectId
}

function buildMediaStorageKey({
  projectId,
  parts,
  extension,
  errorMessage,
}) {
  const normalizedProjectId = Number(projectId)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedProjectId) ||
    normalizedProjectId <= 0 ||
    !Array.isArray(parts) ||
    parts.some((part) => !String(part || '').trim()) ||
    !['.mp4', '.srt'].includes(normalizedExtension)
  ) {
    throw new Error(errorMessage)
  }

  return normalizeObjectKey(
    `projects/${normalizedProjectId}/${parts.join('/')}${normalizedExtension}`,
  )
}

export function buildGeneratedVideoStorageKey({
  projectId,
  storyboardId,
  versionNo,
  candidateNo,
}) {
  const normalizedStoryboardId = Number(storyboardId)
  const normalizedVersionNo = Number(versionNo)
  const normalizedCandidateNo = Number(candidateNo)
  if (
    !Number.isSafeInteger(normalizedStoryboardId) ||
    normalizedStoryboardId <= 0 ||
    !Number.isSafeInteger(normalizedVersionNo) ||
    normalizedVersionNo <= 0 ||
    !Number.isSafeInteger(normalizedCandidateNo) ||
    normalizedCandidateNo <= 0
  ) {
    throw new Error('invalid generated video storage key')
  }
  return buildMediaStorageKey({
    projectId,
    parts: [
      'videos',
      'storyboards',
      String(normalizedStoryboardId),
      `v${normalizedVersionNo}`,
      `c${normalizedCandidateNo}`,
    ],
    extension: '.mp4',
    errorMessage: 'invalid generated video storage key',
  })
}

export function buildGeneratedVideoEndFrameStorageKey({
  projectId,
  storyboardId,
  versionNo,
  candidateNo,
  extension = '.jpg',
}) {
  const normalizedProjectId = requireProjectId(projectId, 'invalid generated video end frame storage key')
  const normalizedStoryboardId = Number(storyboardId)
  const normalizedVersionNo = Number(versionNo)
  const normalizedCandidateNo = Number(candidateNo)
  if (
    !Number.isSafeInteger(normalizedStoryboardId) || normalizedStoryboardId <= 0
    || !Number.isSafeInteger(normalizedVersionNo) || normalizedVersionNo <= 0
    || !Number.isSafeInteger(normalizedCandidateNo) || normalizedCandidateNo <= 0
  ) {
    throw new Error('invalid generated video end frame storage key')
  }
  const suffix = /^\.[a-z0-9]+$/i.test(String(extension || '')) ? String(extension) : '.jpg'
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/videos/storyboards/${normalizedStoryboardId}/v${normalizedVersionNo}/c${normalizedCandidateNo}-end${suffix}`,
  )
}

export function buildSubtitleCleanedVideoStorageKey({ projectId, storyboardId, sourceVideoId }) {
  const normalizedProjectId = requireProjectId(projectId, 'invalid subtitle-cleaned video storage key')
  const normalizedStoryboardId = Number(storyboardId)
  const normalizedSourceVideoId = Number(sourceVideoId)
  if (
    !Number.isSafeInteger(normalizedStoryboardId) || normalizedStoryboardId <= 0
    || !Number.isSafeInteger(normalizedSourceVideoId) || normalizedSourceVideoId <= 0
  ) {
    throw new Error('invalid subtitle-cleaned video storage key')
  }
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/videos/storyboards/${normalizedStoryboardId}/subtitle-cleaned/source-${normalizedSourceVideoId}.mp4`,
  )
}

export function buildRecoveryVideoReviewFrameStorageKey({
  projectId,
  storyboardId,
  versionNo,
  candidateNo,
  sampleNo,
}) {
  const normalizedStoryboardId = Number(storyboardId)
  const normalizedVersionNo = Number(versionNo)
  const normalizedCandidateNo = Number(candidateNo)
  const normalizedSampleNo = Number(sampleNo)
  if (
    !Number.isSafeInteger(normalizedStoryboardId) ||
    normalizedStoryboardId <= 0 ||
    !Number.isSafeInteger(normalizedVersionNo) ||
    normalizedVersionNo <= 0 ||
    !Number.isSafeInteger(normalizedCandidateNo) ||
    normalizedCandidateNo <= 0 ||
    !Number.isSafeInteger(normalizedSampleNo) ||
    normalizedSampleNo <= 0
  ) {
    throw new Error('invalid recovery video review frame storage key')
  }
  const normalizedProjectId = Number(projectId)
  if (!Number.isSafeInteger(normalizedProjectId) || normalizedProjectId <= 0) {
    throw new Error('invalid recovery video review frame storage key')
  }
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/videos/storyboards/${normalizedStoryboardId}/v${normalizedVersionNo}/review/c${normalizedCandidateNo}-s${normalizedSampleNo}.jpg`,
  )
}

export function buildLipSyncVideoStorageKey({ projectId, storyboardId, versionNo }) {
  const normalizedStoryboardId = Number(storyboardId)
  const normalizedVersionNo = Number(versionNo)
  if (
    !Number.isSafeInteger(normalizedStoryboardId) ||
    normalizedStoryboardId <= 0 ||
    !Number.isSafeInteger(normalizedVersionNo) ||
    normalizedVersionNo <= 0
  ) {
    throw new Error('invalid lip-sync video storage key')
  }
  return buildMediaStorageKey({
    projectId,
    parts: [
      'videos',
      'lip-sync',
      'storyboards',
      String(normalizedStoryboardId),
      `v${normalizedVersionNo}`,
      'c1',
    ],
    extension: '.mp4',
    errorMessage: 'invalid lip-sync video storage key',
  })
}

export function buildCharacterReferenceStorageKey({ projectId, characterId, extension = '.jpg' }) {
  const normalizedCharacterId = Number(characterId)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedCharacterId) ||
    normalizedCharacterId <= 0 ||
    !['.png', '.jpg', '.jpeg', '.webp'].includes(normalizedExtension)
  ) {
    throw new Error('invalid character reference storage key')
  }
  const normalizedProjectId = Number(projectId)
  if (!Number.isSafeInteger(normalizedProjectId) || normalizedProjectId <= 0) {
    throw new Error('invalid character reference storage key')
  }
  return normalizeObjectKey(
    `projects/${normalizedProjectId}/frames/characters/${normalizedCharacterId}/reference${normalizedExtension}`,
  )
}

export function buildExportStorageKey({ projectId, exportId, extension = '.mp4' }) {
  const normalizedExportId = Number(exportId)
  const normalizedExtension = String(extension || '').trim().toLowerCase()
  if (
    !Number.isSafeInteger(normalizedExportId) ||
    normalizedExportId <= 0 ||
    !['.mp4', '.srt'].includes(normalizedExtension)
  ) {
    throw new Error('invalid export storage key')
  }
  return buildMediaStorageKey({
    projectId,
    parts: [
      'exports',
      String(normalizedExportId),
      normalizedExtension === '.srt' ? 'subtitles' : 'final',
    ],
    extension: normalizedExtension,
    errorMessage: 'invalid export storage key',
  })
}
