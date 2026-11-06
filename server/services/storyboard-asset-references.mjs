function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function buildReferencedAssetPromptContext(referencedAssets = []) {
  if (!Array.isArray(referencedAssets) || !referencedAssets.length) return ''
  const lines = referencedAssets
    .filter((asset) => asset && text(asset.name))
    .map((asset) => {
      const kind = asset.kind === 'character' ? '角色' : asset.kind === 'scene' ? '场景' : '道具'
      return [
        `${kind}「${text(asset.name)}」`,
        asset.kind === 'character' ? '身份、外貌、服装与配饰只以已确认角色参考图为准，不重新设计角色。' : '',
        asset.kind !== 'character' && asset.appearance ? `外观/状态：${text(asset.appearance)}` : '',
        asset.kind !== 'character' && asset.costume ? `服装/固定物件：${text(asset.costume)}` : '',
        asset.imageUrl ? '已有已确认资产参考图，只锁定主体身份、可识别外观和材质；镜头构图、场景与动作以本镜提示词为准。' : '当前没有可用参考图，只按本镜提示词表现。',
      ].filter(Boolean).join('；')
    })
  return lines.length ? `本镜引用资产约束（@ 引用已展开）：${lines.join('\n')}` : ''
}

function parseJson(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function buildStoryboardReferenceSnapshot({
  storyboard = {},
  referenceImages = [],
  referencedAssets = [],
} = {}) {
  const reference = parseJson(
    storyboard.asset_reference_json ?? storyboard.assetReference ?? storyboard.asset_reference,
  )
  const images = (Array.isArray(referenceImages) ? referenceImages : []).map(text).filter(Boolean)
  const assets = (Array.isArray(referencedAssets) ? referencedAssets : []).map((asset) => ({
    key: text(asset?.key),
    kind: text(asset?.kind || asset?.type || asset?.nodeType),
    name: text(asset?.name || asset?.label),
    imageUrl: text(asset?.imageUrl || asset?.image_url),
    viewKey: text(asset?.sceneViewKey || asset?.viewKey),
    viewSetVersion: positiveInt(asset?.viewSetVersion),
    versionNo: positiveInt(asset?.versionNo),
  }))
  const props = Array.isArray(reference.propAssetRefs)
    ? reference.propAssetRefs.map((item) => ({
      assetNodeId: positiveInt(item?.assetNodeId),
      imageId: positiveInt(item?.imageId),
      name: text(item?.name),
      versionNo: positiveInt(item?.versionNo),
    })).filter((item) => item.name)
    : []

  return {
    schemaVersion: 1,
    character: {
      id: positiveInt(reference.characterId),
      versionNo: positiveInt(reference.characterVersionNo),
      viewSetVersion: positiveInt(reference.characterViewSetVersion),
      viewKeys: Array.isArray(reference.characterViewKeys)
        ? reference.characterViewKeys.map(text).filter(Boolean)
        : [],
      baseImageId: positiveInt(reference.characterBaseImageId),
      baseVersionNo: positiveInt(reference.characterBaseVersionNo),
      faceImageId: positiveInt(reference.characterFaceImageId),
      faceVersionNo: positiveInt(reference.characterFaceVersionNo),
      faceRequired: reference.characterFaceRequired !== false,
    },
    scene: {
      assetId: positiveInt(reference.sceneAssetId),
      panoramaVersion: positiveInt(reference.scenePanoramaVersion),
      panoramaImageId: positiveInt(reference.scenePanoramaImageId),
      viewSetVersion: positiveInt(reference.sceneViewSetVersion),
      viewKey: text(reference.sceneViewKey) || null,
      viewIndex: positiveInt(reference.sceneViewIndex),
    },
    props,
    referenceImages: [...new Set(images)],
    referencedAssets: assets,
    voice: {
      profileKey: text(reference.voiceProfileKey),
      locked: reference.voiceLocked === true,
      characterName: text(reference.characterName),
    },
    performance: reference.performance && typeof reference.performance === 'object'
      ? { ...reference.performance }
      : null,
    continuity: {
      fromShot: text(reference.continuityFromShot) || null,
    },
  }
}

export function validateStoryboardReferenceSnapshot(snapshot = {}) {
  const blockers = []
  const hasCharacter = Boolean(
    snapshot.character?.id
      || snapshot.character?.versionNo
      || snapshot.character?.viewSetVersion
      || snapshot.character?.viewKeys?.length,
  )
  if (hasCharacter && (!snapshot.character?.id || !snapshot.character?.versionNo)) {
    blockers.push('视频缺少已确认角色版本引用')
  }
  if (hasCharacter && (!snapshot.character?.viewSetVersion || snapshot.character?.viewKeys?.length < 3)) {
    blockers.push('视频缺少已确认角色三视图引用')
  }
  if (hasCharacter && (!snapshot.character?.baseImageId || !snapshot.character?.baseVersionNo)) {
    blockers.push('视频缺少已确认角色基础正面全身图引用')
  }
  if (hasCharacter
    && snapshot.character?.faceRequired !== false
    && (!snapshot.character?.faceImageId || !snapshot.character?.faceVersionNo)) {
    blockers.push('视频缺少已确认角色脸部特写引用')
  }
  if (hasCharacter && !['front', 'side', 'back'].every((key) => snapshot.character?.viewKeys?.includes(key))) {
    blockers.push('视频缺少已确认角色正面、侧面、背面引用')
  }
  if (!snapshot.scene?.assetId || !snapshot.scene?.panoramaVersion) {
    blockers.push('视频缺少已确认场景全景引用')
  }
  for (const prop of Array.isArray(snapshot.props) ? snapshot.props : []) {
    if (!prop.assetNodeId || !prop.imageId || !prop.versionNo) {
      blockers.push(`视频缺少已确认道具「${prop.name || '未命名'}」引用`)
    }
  }
  if (!snapshot.referenceImages.length) {
    blockers.push('视频缺少可供模型读取的角色或场景参考图')
  }
  return { passed: blockers.length === 0, blockers }
}
