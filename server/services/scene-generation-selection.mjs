function idOf(image) {
  const id = Number(image?.id)
  return Number.isInteger(id) && id > 0 ? id : 0
}

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Pick the panorama that a scene generation action is actually operating on.
 * A passed candidate newer than the current confirmed image must win; otherwise
 * a regenerate-then-nine-grid action silently reuses the old scene.
 */
export function selectLatestPassedScenePanorama(images = []) {
  return (Array.isArray(images) ? images : [])
    .filter((image) => text(image?.viewSetType ?? image?.view_set_type) === 'single')
    .filter((image) => !['failed', 'superseded'].includes(text(image?.status)))
    .filter((image) => text(image?.visionStatus ?? image?.vision_status) !== 'failed')
    .filter((image) => ['passed', 'skipped'].includes(text(image?.visionStatus ?? image?.vision_status))
      || !text(image?.visionStatus ?? image?.vision_status))
    .sort((left, right) => idOf(right) - idOf(left))[0] || null
}

export function hasCompleteSceneNineGridBatch(images = [], sourceImageId) {
  const sourceId = idOf({ id: sourceImageId })
  if (!sourceId) return false
  const groups = new Map()
  const expectedKeys = new Set([
    'front-left', 'front', 'front-right', 'left', 'center', 'right',
    'back-left', 'back', 'back-right',
  ])
  for (const image of Array.isArray(images) ? images : []) {
    if (text(image?.viewSetType ?? image?.view_set_type) !== 'scene-nine-grid') continue
    if (idOf({ id: image?.sourceImageId ?? image?.source_image_id }) !== sourceId) continue
    if (['failed', 'superseded'].includes(text(image?.status))) continue
    if (!['passed', 'skipped'].includes(text(image?.visionStatus ?? image?.vision_status))) continue
    const version = Number(image?.viewSetVersion ?? image?.view_set_version ?? image?.versionNo ?? image?.version_no)
    const key = text(image?.viewKey ?? image?.view_key)
    if (!Number.isInteger(version) || !expectedKeys.has(key)) continue
    const keys = groups.get(version) || new Set()
    keys.add(key)
    groups.set(version, keys)
  }
  return [...groups.values()].some((keys) => keys.size === expectedKeys.size
    && [...expectedKeys].every((key) => keys.has(key)))
}
