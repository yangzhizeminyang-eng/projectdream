function text(value) {
  return String(value ?? '').trim()
}

function isRealAssetImage({ imageUrl, modelName } = {}) {
  const url = text(imageUrl)
  const model = text(modelName).toLowerCase()
  return Boolean(url)
    && !url.includes('/mock-assets/')
    && !model.startsWith('mock-')
}

export function resolveCharacterReferenceImageUrls(urls = []) {
  return (Array.isArray(urls) ? urls : [])
    .map((value) => text(value))
    .filter((value) => /^https?:\/\//i.test(value) && !value.includes('/mock-assets/'))
}

function imageId(image) {
  const value = Number(image?.id ?? image?.image_id)
  return Number.isFinite(value) ? value : 0
}

export function validateCharacterAssetPackConfirmation({
  viewType,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
} = {}) {
  if (text(viewType) !== 'character-asset-pack') {
    return { ready: true, code: null, message: '' }
  }
  if (text(imageStatus) === 'failed' || text(imageStatus) === 'superseded') {
    return { ready: false, code: 'character-asset-pack-not-active', message: '失效或已替代的角色资产板不能确认' }
  }
  if (text(visionStatus) !== 'passed') {
    return {
      ready: false,
      code: 'character-asset-pack-vision-pending',
      message: text(visionStatus) === 'failed'
        ? '角色资产板未通过视觉检查，请重新生成'
        : '角色资产板尚未完成视觉检查，请稍后重试',
    }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return { ready: false, code: 'character-asset-pack-not-real', message: '角色资产板不是来自真实图片生成服务，不能确认' }
  }
  return { ready: true, code: null, message: '' }
}

/**
 * 角色三视图的唯一基础来源：
 * 已确认的 single 图，也就是角色基础正面全身图。
 * 角色身份层的 reference_image_url 不参与这个门禁，避免新流程绕过基础图确认。
 */
export function getConfirmedCharacterBaseImage(images = []) {
  return (Array.isArray(images) ? images : [])
    .filter((image) =>
      ['single', 'character-asset-pack'].includes(text(image?.viewSetType ?? image?.view_set_type))
      && text(image?.status) === 'confirmed',
    )
    .sort((left, right) => imageId(right) - imageId(left))[0] || null
}

/**
 * A passed retry can be used as the immutable reference for derived images,
 * while it still remains a candidate until the user adopts it. Production
 * queries must continue to use getConfirmedCharacterBaseImage().
 */
export function getCharacterBaseReferenceImage(images = []) {
  return (Array.isArray(images) ? images : [])
    .filter((image) =>
      ['single', 'character-asset-pack'].includes(text(image?.viewSetType ?? image?.view_set_type))
      && text(image?.status) !== 'failed'
      && text(image?.status) !== 'superseded'
      && (
        text(image?.visionStatus ?? image?.vision_status) === 'passed'
        || (
          text(image?.status) === 'confirmed'
          && !text(image?.visionStatus ?? image?.vision_status)
        )
      ),
    )
    .sort((left, right) => imageId(right) - imageId(left))[0] || null
}

export function getConfirmedCharacterFaceCloseupImage(images = []) {
  return (Array.isArray(images) ? images : [])
    .filter((image) =>
      text(image?.viewSetType ?? image?.view_set_type) === 'character-face-closeup'
      && text(image?.viewKey ?? image?.view_key) === 'face'
      && text(image?.status) === 'confirmed'
      && text(image?.visionStatus ?? image?.vision_status) === 'passed',
    )
    .sort((left, right) => imageId(right) - imageId(left))[0] || null
}

export function validateCharacterViewGeneration({
  nodeType,
  viewType,
  images = [],
} = {}) {
  if (nodeType !== 'character' || !['character-turnaround', 'character-face-closeup'].includes(viewType)) {
    return {
      ready: true,
      code: null,
      message: '',
      baseImage: null,
    }
  }

  const baseImage = getCharacterBaseReferenceImage(images)
  if (!baseImage) {
    return {
      ready: false,
      code: 'character-base-image-required',
      message: '请先生成并确认角色基础正面全身图',
      baseImage: null,
    }
  }

  if (viewType === 'character-turnaround' && !getConfirmedCharacterFaceCloseupImage(images)) {
    return {
      ready: false,
      code: 'character-face-closeup-required',
      message: '请先生成、通过视觉检查并确认角色脸部特写，再生成三视图',
      baseImage,
    }
  }

  return {
    ready: true,
    code: null,
    message: '',
    baseImage,
  }
}

export function validateCharacterFaceCloseupConfirmation({
  viewType,
  viewKey,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
  identityStatus,
  identityReason,
} = {}) {
  if (text(viewType) !== 'character-face-closeup') {
    return { ready: true, code: null, message: '' }
  }
  if (text(viewKey) !== 'face') {
    return { ready: false, code: 'character-face-closeup-required', message: '脸部特写必须是独立的 face 视图' }
  }
  if (text(imageStatus) === 'failed') {
    return { ready: false, code: 'character-face-closeup-generation-failed', message: '生成失败的脸部特写不能确认' }
  }
  if (text(imageStatus) === 'superseded') {
    return { ready: false, code: 'character-face-closeup-superseded', message: '该脸部特写已被新候选替代，不能确认' }
  }
  if (text(visionStatus) !== 'passed') {
    return {
      ready: false,
      code: 'character-face-closeup-vision-pending',
      message: text(visionStatus) === 'failed'
        ? '脸部特写未通过视觉检查，请重新生成'
        : '脸部特写尚未完成视觉检查，请稍后重试',
    }
  }
  if (text(identityStatus) === 'failed') {
    return { ready: false, code: 'character-identity-inconsistent', message: text(identityReason) || '脸部特写与基础角色身份或穿搭不一致，请重新生成' }
  }
  if (text(identityStatus) === 'pending') {
    return { ready: false, code: 'character-identity-pending', message: '脸部特写尚未完成身份与穿搭一致性检查，请稍后重试' }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return { ready: false, code: 'character-face-closeup-not-real', message: '脸部特写不是来自真实图片生成服务，不能确认' }
  }
  return { ready: true, code: null, message: '' }
}

export function validateCharacterTurnaroundConfirmation({
  viewType,
  viewKey,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
  identityStatus,
  identityReason,
} = {}) {
  if (text(viewType) !== 'character-turnaround') {
    return { ready: true, code: null, message: '' }
  }
  if (!['front', 'side', 'back'].includes(text(viewKey))) {
    return {
      ready: false,
      code: 'character-view-angle-required',
      message: '该旧三视图是单张拼贴结果，不能作为独立视角确认；请重新分别生成正面、侧面和背面',
    }
  }
  if (text(imageStatus) === 'failed') {
    return {
      ready: false,
      code: 'character-view-generation-failed',
      message: '生成失败的角色视角不能确认',
    }
  }
  if (text(imageStatus) === 'superseded') {
    return {
      ready: false,
      code: 'character-view-superseded',
      message: '该角色视角已被新候选替代，不能确认',
    }
  }
  if (text(visionStatus) !== 'passed') {
    return {
      ready: false,
      code: 'character-view-vision-pending',
      message: text(visionStatus) === 'failed'
        ? '该视角未通过视觉检查，请重新生成'
        : '该视角尚未完成视觉检查，请稍后重试',
    }
  }
  if (text(identityStatus) === 'failed') {
    return { ready: false, code: 'character-identity-inconsistent', message: text(identityReason) || '三视图与基础角色身份或穿搭不一致，请重新生成' }
  }
  if (text(identityStatus) === 'pending') {
    return { ready: false, code: 'character-identity-pending', message: '三视图尚未完成身份与穿搭一致性检查，请稍后重试' }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return {
      ready: false,
      code: 'character-view-not-real',
      message: '该视角不是来自真实图片生成服务，不能确认；请重新生成',
    }
  }
  return { ready: true, code: null, message: '' }
}

export function validateAssetImageConfirmation({
  nodeType,
  viewType,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
} = {}) {
  const type = text(nodeType)
  const isBaseAsset = ['single', 'character-asset-pack'].includes(text(viewType))
    && ['character', 'scene', 'prop', 'material'].includes(type)
  if (!isBaseAsset) return { ready: true, code: null, message: '' }
  if (text(imageStatus) === 'failed') {
    return { ready: false, code: 'asset-image-generation-failed', message: '生成失败的资产不能确认' }
  }
  if (text(imageStatus) === 'superseded') {
    return { ready: false, code: 'asset-image-superseded', message: '该资产已被新候选替代，不能确认' }
  }
  if (type === 'scene' && text(visionStatus) === 'skipped') {
    if (!isRealAssetImage({ imageUrl, modelName })) {
      return { ready: false, code: 'asset-image-not-real', message: '该资产不是来自真实图片生成服务，不能确认' }
    }
    return { ready: true, code: null, message: '视觉检查未运行；请人工确认场景全景基准' }
  }
  if (text(visionStatus) !== 'passed') {
    return {
      ready: false,
      code: 'asset-image-vision-pending',
      message: text(visionStatus) === 'failed'
        ? '该资产未通过视觉检查，请重新生成'
        : '该资产尚未完成视觉检查，请稍后重试',
    }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return { ready: false, code: 'asset-image-not-real', message: '该资产不是来自真实图片生成服务，不能确认' }
  }
  return { ready: true, code: null, message: '' }
}

export function validatePropTurnaroundConfirmation({
  nodeType,
  viewType,
  viewKey,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
} = {}) {
  if (!['prop', 'material'].includes(text(nodeType)) || text(viewType) !== 'prop-turnaround') {
    return { ready: true, code: null, message: '' }
  }
  if (!['front', 'side', 'back', 'top'].includes(text(viewKey))) {
    return { ready: false, code: 'prop-view-angle-required', message: '道具多视角必须是正面、侧面、背面或俯视独立视角' }
  }
  if (text(imageStatus) === 'failed' || text(imageStatus) === 'superseded') {
    return { ready: false, code: 'prop-view-not-active', message: '失效或已替代的道具视角不能确认' }
  }
  if (text(visionStatus) !== 'passed') {
    return {
      ready: false,
      code: 'prop-view-vision-pending',
      message: text(visionStatus) === 'failed' ? '道具视角未通过视觉检查，请重新生成' : '道具视角尚未完成视觉检查，请稍后重试',
    }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return { ready: false, code: 'prop-view-not-real', message: '道具视角不是来自真实图片生成服务，不能确认' }
  }
  return { ready: true, code: null, message: '' }
}
