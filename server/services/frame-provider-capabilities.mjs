const CAPABILITIES = {
  agnes: { supportsReferenceImages: true, maxReferenceImages: 8, supportsImageToImage: true, supportsFaceIdentity: false },
  toapi: { supportsReferenceImages: true, maxReferenceImages: 8, supportsImageToImage: true, supportsFaceIdentity: false },
  volcengine: { supportsReferenceImages: true, maxReferenceImages: 8, supportsImageToImage: true, supportsFaceIdentity: true, supportsAssetPack: true },
  bigmodel: { supportsReferenceImages: false, maxReferenceImages: 0, supportsImageToImage: false, supportsFaceIdentity: false },
  zhipu: { supportsReferenceImages: false, maxReferenceImages: 0, supportsImageToImage: false, supportsFaceIdentity: false },
  'trae-url': { supportsReferenceImages: false, maxReferenceImages: 0, supportsImageToImage: false, supportsFaceIdentity: false },
  mock: { supportsReferenceImages: false, maxReferenceImages: 0, supportsImageToImage: false, supportsFaceIdentity: false },
}

export function getFrameProviderCapabilities(provider = '') {
  return CAPABILITIES[String(provider || '').trim().toLowerCase()] || {
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsImageToImage: false,
    supportsFaceIdentity: false,
    supportsAssetPack: false,
  }
}

export function assertFrameReferenceImageSupport({
  provider = '', modelName = '', referenceImageUrls = [], referenceImageStorageKeys = [],
} = {}) {
  const references = (Array.isArray(referenceImageUrls) ? referenceImageUrls : [])
    .map((value) => String(value || '').trim())
    .filter((value) => /^https?:\/\//i.test(value) || /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value))
  const storageKeys = (Array.isArray(referenceImageStorageKeys) ? referenceImageStorageKeys : [])
    .map((value) => String(value || '').trim()).filter(Boolean)
  if (!references.length && !storageKeys.length) return references
  const capabilities = getFrameProviderCapabilities(provider)
  if (!capabilities.supportsReferenceImages) {
    const error = new Error(`当前图片生成通道 ${provider}${modelName ? ` / ${modelName}` : ''} 不支持定妆参考图输入，不能保证角色同脸和穿搭一致。请切换到支持 reference_images 的图片模型。`)
    error.code = 'FRAME_REFERENCE_UNSUPPORTED'
    error.statusCode = 409
    throw error
  }
  return references.slice(0, capabilities.maxReferenceImages)
}
