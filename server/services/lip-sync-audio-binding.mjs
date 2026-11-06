function positiveInteger(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeSourceType(clip) {
  return String(clip?.syncSourceType || clip?.sourceType || '').trim().toLowerCase()
}

function buildIssue(code, message, clip, extra = {}) {
  return {
    code,
    message,
    videoAssetId: positiveInteger(clip?.id),
    storyboardId: positiveInteger(clip?.storyboardId),
    ...extra,
  }
}

export function validateLipSyncAudioBindings({
  clips = [],
  audioTracks = {},
} = {}) {
  const dialogueTracks = Array.isArray(audioTracks?.dialogue) ? audioTracks.dialogue : []
  const bindings = []
  const blockingIssues = []

  for (const clip of Array.isArray(clips) ? clips : []) {
    if (normalizeSourceType(clip) !== 'lip_sync') continue

    const videoAssetId = positiveInteger(clip?.id)
    const storyboardId = positiveInteger(clip?.storyboardId)
    const syncAudioAssetId = positiveInteger(
      clip?.syncAudioAssetId ?? clip?.audioAssetId,
    )

    if (!syncAudioAssetId) {
      blockingIssues.push(
        buildIssue(
          'lip-sync-audio-source-missing',
          `lip-sync 视频 ${videoAssetId || 'unknown'} 缺少生成时绑定的对白音频 ID，已阻断终剪。`,
          clip,
        ),
      )
      continue
    }

    const dialogueAudio = dialogueTracks.find(
      (item) =>
        positiveInteger(item?.id) === syncAudioAssetId &&
        positiveInteger(item?.storyboardId) === storyboardId &&
        item?.status !== 'failed',
    )
    if (!dialogueAudio) {
      blockingIssues.push(
        buildIssue(
          'lip-sync-audio-source-mismatch',
          `lip-sync 视频 ${videoAssetId || 'unknown'} 的绑定对白音频 ${syncAudioAssetId} 未出现在同一分镜的终剪对白轨中，已阻断终剪。`,
          clip,
          { syncAudioAssetId },
        ),
      )
      continue
    }

    bindings.push({
      videoAssetId,
      storyboardId,
      syncAudioAssetId,
      renderedDialogueAudioAssetId: positiveInteger(dialogueAudio.id),
      sameSource: true,
    })
  }

  return {
    passed: blockingIssues.length === 0,
    bindings,
    blockingIssues,
  }
}

export function restrictDialogueTracksToLipSyncBindings({
  audioTracks = {},
  bindings = [],
} = {}) {
  const allowedAudioIdsByStoryboard = new Map()
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const storyboardId = positiveInteger(binding?.storyboardId)
    const audioAssetId = positiveInteger(
      binding?.syncAudioAssetId ?? binding?.renderedDialogueAudioAssetId,
    )
    if (!storyboardId || !audioAssetId) continue
    const allowedAudioIds = allowedAudioIdsByStoryboard.get(storyboardId) || new Set()
    allowedAudioIds.add(audioAssetId)
    allowedAudioIdsByStoryboard.set(storyboardId, allowedAudioIds)
  }

  if (!allowedAudioIdsByStoryboard.size) return audioTracks

  const dialogue = Array.isArray(audioTracks?.dialogue)
    ? audioTracks.dialogue.filter((item) => {
        const storyboardId = positiveInteger(item?.storyboardId)
        const allowedAudioIds = allowedAudioIdsByStoryboard.get(storyboardId)
        if (!allowedAudioIds) return true
        return allowedAudioIds.has(positiveInteger(item?.id))
      })
    : []

  return {
    ...audioTracks,
    dialogue,
  }
}
