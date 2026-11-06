import { normalizeSceneSpaceManifest } from './scene-space-manifest.mjs'

const SCENE_GRID_ANGLES = Object.freeze([
  { key: 'front-left', label: '左前', yaw: -45, pitch: -4, fov: 76, index: 1 },
  { key: 'front', label: '正前', yaw: 0, pitch: 0, fov: 70, index: 2 },
  { key: 'front-right', label: '右前', yaw: 45, pitch: -4, fov: 76, index: 3 },
  { key: 'left', label: '左侧', yaw: -90, pitch: 0, fov: 66, index: 4 },
  { key: 'center', label: '正中', yaw: 90, pitch: 0, fov: 62, index: 5 },
  { key: 'right', label: '右侧', yaw: 110, pitch: 0, fov: 66, index: 6 },
  { key: 'back-left', label: '左后', yaw: 145, pitch: 4, fov: 76, index: 7 },
  { key: 'back', label: '正后', yaw: 180, pitch: 0, fov: 70, index: 8 },
  { key: 'back-right', label: '右后', yaw: 215, pitch: 4, fov: 76, index: 9 },
])

function resolveSceneGridAngle(value) {
  const key = typeof value === 'string' ? value : value?.key
  return SCENE_GRID_ANGLES.find((angle) => angle.key === text(key)) || null
}

function positiveInt(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function sceneNineGridQualityAttempts(value, fallback = 5) {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) return parsed
  return fallback
}

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Build one reference-guided view request. Ordinary generated panoramas are
 * not guaranteed equirectangular, so this prompt must not claim deterministic
 * 3D reprojection.
 */
export function buildSceneNineGridAnglePrompt({ angle = '', panorama = '', spatialAnchors = null } = {}) {
  const descriptor = resolveSceneGridAngle(angle)
  if (!descriptor) throw new Error(`unknown scene nine-grid view: ${text(angle)}`)
  const reference = text(panorama)
  if (!reference) throw new Error('confirmed panorama reference is required')
  const manifest = normalizeSceneSpaceManifest(spatialAnchors)
  const anchorIds = manifest.view_bindings[descriptor.key]
  const anchorLabels = anchorIds.map((id) => {
    const anchor = manifest.anchors.find((item) => item.id === id)
    return `${anchor.id}「${anchor.label}」`
  })

  return [
    '任务类型：使用已确认全景母版生成一个参考图引导的空场视角候选。',
    `同一张已确认的场景全景基准图 / 全景母版参考：${reference}`,
    '母版是唯一空间来源。继承其中已确认的建筑、开口、固定家具、材质、光线和相对位置；禁止重构、增删、移动、镜像或改变这些内容。',
    `相机参数（唯一变化）：固定全景原点 origin=(0,1.55,0)；yaw=${descriptor.yaw}°；pitch=${descriptor.pitch}°；FOV=${descriptor.fov}°。坐标系固定，不进行平移。`,
    `目标机位：${descriptor.label}（view_key=${descriptor.key}）。本视角必须保留并可辨认的空间锚点：${anchorLabels.join('、')}。`,
    '只根据相机参数改变投影视角，不补写房间、家具、材质、灯光或剧情描述；按母版原有遮挡关系表现，锚点不合理可见时应阻断该机位计划，不得临时虚构。',
    '只输出单张空场环境视角，不生成角色、人物剪影、人物照片、遗像、人体倒影、文字、字幕、水印、九宫格或拼贴。',
    '能力标记：这是参考图引导生成，不是确定性三维采样。只有有效360°等距柱状母版走确定性投影时，才可称为几何锁定视角。',
  ].join('\n')
}

export function buildSceneNineGridQualityRepairPrompt({ angle = '', previousReason = '', attempt = 2 } = {}) {
  const descriptor = resolveSceneGridAngle(angle)
  if (!descriptor) throw new Error(`unknown scene nine-grid view: ${text(angle)}`)
  return [
    `这是同一场景九宫格 ${descriptor.label} 视角的第 ${Number(attempt) || 2} 次质量修复。`,
    '继续使用同一张已确认全景基准图和同一套空间锚点；只修复视觉检查指出的问题，不得改动机位语义、空间布局、固定物件、材质、光线方向或色彩关系。',
    previousReason ? `上一次检查反馈：${text(previousReason)}` : '',
    '必须输出一张完整、真实摄影质感的单一环境视角，不能输出母图、白板、空白图、九宫格、拼贴或局部裁切。',
  ].filter(Boolean).join('\n')
}

/**
 * Keep the stable nine-angle order and legacy crop metadata for old records.
 * New generation never uses the crop as an image source: each descriptor is
 * rendered independently from the confirmed panorama.
 */
export function buildSceneNineGridViewDescriptors({
  sourceImageId = null,
  sourceImageUrl = null,
  viewSetVersion = 1,
  status = 'candidate',
} = {}) {
  return SCENE_GRID_ANGLES.map((angle) => {
    const zeroBased = angle.index - 1
    const column = zeroBased % 3
    const row = Math.floor(zeroBased / 3)
    return {
      sourceImageId: positiveInt(sourceImageId),
      sourceImageUrl: text(sourceImageUrl) || null,
      viewSetType: 'scene-nine-grid',
      viewSetVersion: positiveInt(viewSetVersion) || 1,
      viewIndex: angle.index,
      viewKey: angle.key,
      viewLabel: angle.label,
      status: text(status) || 'candidate',
      crop: {
        x: column / 3,
        y: row / 3,
        width: 1 / 3,
        height: 1 / 3,
      },
    }
  })
}

export function buildSceneNineGridCropFilter(viewKey) {
  const descriptor = SCENE_GRID_ANGLES.find((angle) => angle.key === text(viewKey))
  if (!descriptor) throw new Error(`unknown scene nine-grid view: ${viewKey}`)
  const zeroBased = descriptor.index - 1
  const column = zeroBased % 3
  const row = Math.floor(zeroBased / 3)
  return `crop=iw/3:ih/3:${column}*iw/3:${row}*ih/3`
}

function isRealAssetImage({ imageUrl, modelName } = {}) {
  const url = text(imageUrl)
  const model = text(modelName).toLowerCase()
  return Boolean(url) && !url.includes('/mock-assets/') && !model.startsWith('mock-')
}

export function validateSceneNineGridViewConfirmation({
  viewKey,
  crop,
  sourceImageId,
  imageStatus,
  visionStatus,
  imageUrl,
  modelName,
} = {}) {
  const angle = SCENE_GRID_ANGLES.find((item) => item.key === text(viewKey))
  if (!angle || !positiveInt(sourceImageId)) {
    return {
      ready: false,
      code: 'scene-view-angle-required',
      message: '九宫格母图不能直接确认，请先生成并检查具体场景视角',
    }
  }
  if (text(imageStatus) === 'failed') {
    return {
      ready: false,
      code: 'scene-view-generation-failed',
      message: '生成失败的场景视角不能确认',
    }
  }
  if (text(imageStatus) === 'superseded') {
    return {
      ready: false,
      code: 'scene-view-superseded',
      message: '该场景视角已被新候选替代，不能确认',
    }
  }
  if (!['passed', 'skipped'].includes(text(visionStatus))) {
    return {
      ready: false,
      code: 'scene-view-vision-pending',
      message: text(visionStatus) === 'failed'
        ? '该场景视角未通过视觉检查，请重新生成'
        : '该场景视角尚未完成视觉检查，请稍后重试',
    }
  }
  if (!isRealAssetImage({ imageUrl, modelName })) {
    return {
      ready: false,
      code: 'scene-view-not-real',
      message: '该场景视角不是来自真实图片生成服务，不能确认；请重新生成',
    }
  }
  if (text(visionStatus) === 'skipped') {
    return {
      ready: true,
      code: null,
      message: '视觉检查未运行；请按全景基准人工确认此角度',
      visionSkipped: true,
    }
  }
  return { ready: true, code: null, message: '' }
}

export function getSceneNineGridAngles() {
  return SCENE_GRID_ANGLES
}
