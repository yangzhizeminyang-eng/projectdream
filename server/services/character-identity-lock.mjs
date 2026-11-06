function text(value) {
  return String(value ?? '').trim()
}

function idOf(image) {
  const id = Number(image?.id ?? image?.image_id)
  return Number.isFinite(id) && id > 0 ? id : null
}

function imageUrlOf(image) {
  return text(image?.imageUrl ?? image?.image_url ?? image?.thumbnailUrl ?? image?.thumbnail_url)
}

function storageKeyOf(image) {
  return text(image?.storageKey ?? image?.storage_key)
}

function isConfirmedPassed(image) {
  return text(image?.status) === 'confirmed'
    && text(image?.visionStatus ?? image?.vision_status) === 'passed'
    && Boolean(imageUrlOf(image) || storageKeyOf(image))
}

/**
 * The provider-facing reference order is intentionally stable. The base image
 * anchors clothing and silhouette, the face close-up anchors facial identity,
 * and the three angles constrain the unseen sides of the same person.
 */
export function resolveCharacterReferenceSet(images = []) {
  const usable = (Array.isArray(images) ? images : []).filter(isConfirmedPassed)
  const byType = (viewSetType, viewKey = null) => usable
    .filter((image) => text(image?.viewSetType ?? image?.view_set_type) === viewSetType
      && (viewKey === null || text(image?.viewKey ?? image?.view_key) === viewKey))
    .sort((left, right) => (idOf(right) || 0) - (idOf(left) || 0))[0] || null
  const ordered = [
    byType('single'),
    byType('character-face-closeup', 'face'),
    byType('character-turnaround', 'front'),
    byType('character-turnaround', 'side'),
    byType('character-turnaround', 'back'),
  ].filter(Boolean)
  const seen = new Set()
  const unique = ordered.filter((image) => {
    const id = idOf(image)
    const key = id ? `id:${id}` : `url:${imageUrlOf(image)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    images: unique,
    imageIds: unique.map(idOf).filter(Boolean),
    imageUrls: unique.map(imageUrlOf).filter((url) => /^https?:\/\//i.test(url)),
    storageKeys: unique.map(storageKeyOf).filter(Boolean),
    baseImage: byType('single'),
    faceImage: byType('character-face-closeup', 'face'),
  }
}

export function buildCharacterIdentityLockSnapshot({ character = {}, baseImage = null, referenceSet = {} } = {}) {
  const name = text(character.name ?? character.characterName) || '未命名角色'
  const appearance = text(character.appearance)
  const wardrobe = text(character.costume ?? character.costume_description ?? character.costumeDescription)
  const faceImage = referenceSet.faceImage || null
  const baseImageId = idOf(baseImage)
  const prompt = [
    `角色身份锁：${name}`,
    appearance ? `基础外貌证据：${appearance}` : '',
    wardrobe ? `基础图服装与配饰证据：${wardrobe}` : '',
    '基础正面全身图是唯一的身体轮廓、发型、服装、鞋子和配饰基准。',
    faceImage ? '已确认脸部特写是五官和脸型基准。' : '尚未确认脸部特写，不得声称已完成脸部身份锁。',
    '派生图必须同时保持脸型、五官相对位置、肤色、发型轮廓、发长、服装颜色与版型、鞋子和固定配饰；服装、鞋子、发型和配饰不得变化；禁止换脸、换装、发长漂移或新增服装细节。',
  ].filter(Boolean).join('\n')
  return {
    schemaVersion: 1,
    identityMode: 'multi-reference-visual-lock',
    faceEmbeddingStatus: 'not-configured',
    characterId: Number(character.id) || null,
    name,
    appearance: appearance || null,
    wardrobe: wardrobe || null,
    baseImageId,
    faceReferenceImageId: idOf(faceImage),
    referenceImageIds: referenceSet.imageIds || [],
    referenceImageUrls: referenceSet.imageUrls || [],
    referenceStorageKeys: referenceSet.storageKeys || [],
    prompt,
  }
}

export function buildCharacterIdentityLockPrompt(snapshot = {}, requestedAngle = '') {
  return [
    '角色身份与穿搭锁定（只用于角色资产，不读取任何场景或表演上下文）：',
    text(snapshot.prompt),
    requestedAngle ? `当前输出视角：${requestedAngle}` : '',
    '所有参考图属于同一个已确认角色，只改变摄影机视角，不改变人物身份、发型、妆容、衣服、鞋子、配饰、比例或年龄感。',
    '没有真实 FaceID/人脸向量服务时，不得把文本描述当作 FaceID；必须依赖这些已确认多参考图并接受视觉一致性检查。',
  ].filter(Boolean).join('\n')
}

export function parseCharacterIdentityLock(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
