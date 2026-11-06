/**
 * A speaking character can still be intentionally off-camera. Keep that
 * distinction explicit so voice/action references do not imply a face asset.
 */
const NO_FACE_PATTERN = /不露脸|不露面|不出镜|不直接露脸|不直接露面|不出现正脸|正脸不呈现|脸部(?:不可见|不入镜)|只拍到[^。；\n]{0,24}(?:袖口|手部|身体)|仅(?:有)?声音|画外音/u

export function hasExplicitNoFaceConstraint(...values) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .some((value) => NO_FACE_PATTERN.test(value))
}

export function requiresCharacterFaceReference(character = {}, ...scriptValues) {
  const explicit = String(character?.face_visibility ?? character?.faceVisibility ?? '').trim().toLowerCase()
  if (['not_visible', 'not-visible', 'off_camera', 'off-camera'].includes(explicit)) return false
  if (['visible', 'partial'].includes(explicit)) return true
  return !hasExplicitNoFaceConstraint(
    character?.appearance,
    character?.costume,
    character?.role_tag,
    ...scriptValues,
  )
}

export function faceReferenceRequirementFromPrompt(prompt = '') {
  return !hasExplicitNoFaceConstraint(prompt)
}
