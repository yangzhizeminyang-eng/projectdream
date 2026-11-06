export function resolveStoredMediaUrl(row, options = {}) {
  const storageKey = options.reference
    ? row?.reference_image_storage_key || row?.referenceImageStorageKey
    : row?.storage_key || row?.storageKey

  if (storageKey && typeof options.createSignedUrl === 'function') {
    try {
      return options.createSignedUrl({ key: storageKey })
    } catch {
      // Fall back to the historical URL when old data contains a bad key.
    }
  }

  if (options.kind === 'video' || options.kind === 'export') {
    return row?.video_url || row?.videoUrl || null
  }
  if (options.reference) {
    return row?.reference_image_url || row?.referenceImageUrl || null
  }
  if (options.thumbnail) {
    return row?.thumbnail_url || row?.thumbnailUrl || null
  }
  return row?.image_url || row?.imageUrl || null
}

export function resolveVideoConfirmationSource({
  storageKey,
  videoUrl,
  localPath,
  createSignedUrl,
} = {}) {
  const key = String(storageKey || '').trim()
  if (key) {
    if (typeof createSignedUrl !== 'function') {
      throw new Error('object storage URL signer is unavailable')
    }
    return { videoUrl: createSignedUrl({ key }), shouldPersist: false }
  }

  const sourceUrl = String(videoUrl || '').trim()
  return {
    videoUrl: sourceUrl || null,
    shouldPersist: !localPath && !key,
  }
}
