function finite(value, fallback = Number.NaN) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function validateCharacterFaceCropLayout({
  imageWidth,
  imageHeight,
  headBox,
  crop,
} = {}) {
  const width = Math.trunc(finite(imageWidth, 0))
  const height = Math.trunc(finite(imageHeight, 0))
  const left = finite(headBox?.left)
  const top = finite(headBox?.top)
  const right = finite(headBox?.right)
  const bottom = finite(headBox?.bottom)
  const cropX = finite(crop?.cropX, finite(crop?.x))
  const cropY = finite(crop?.cropY, finite(crop?.y))
  const cropWidth = finite(crop?.width)
  const cropHeight = finite(crop?.height)
  const padLeft = Math.max(0, finite(crop?.padLeft, 0))
  const padTop = Math.max(0, finite(crop?.padTop, 0))
  if (
    width < 1 || height < 1
    || ![left, top, right, bottom, cropX, cropY, cropWidth, cropHeight].every(Number.isFinite)
    || right <= left || bottom <= top || cropWidth <= 0 || cropHeight <= 0
  ) {
    return { ok: false, reason: '脸部特写裁切布局参数无效' }
  }
  const headLeft = left * width + padLeft
  const headTop = top * height + padTop
  const headRight = right * width + padLeft
  const headBottom = bottom * height + padTop
  const margins = {
    left: headLeft - cropX,
    top: headTop - cropY,
    right: cropX + cropWidth - headRight,
    bottom: cropY + cropHeight - headBottom,
  }
  const headWidth = (right - left) * width
  const headHeight = (bottom - top) * height
  const required = {
    left: Math.max(8, headWidth * 0.06),
    top: Math.max(12, headHeight * 0.08),
    right: Math.max(8, headWidth * 0.06),
    bottom: Math.max(16, headHeight * 0.12),
  }
  const safe = Object.keys(required).every((key) => margins[key] >= required[key])
  return {
    ok: safe,
    margins,
    required,
    reason: safe ? '' : '当前裁切框没有为头发、双耳、下颌和下巴保留足够安全留白',
  }
}

/**
 * Convert normalized visual-detection bounds into a square crop that contains
 * the complete head. The extra room is biased below the chin for a little
 * neck, while every coordinate remains specific to the current source image.
 */
export function calculateCharacterFaceCrop({
  imageWidth,
  imageHeight,
  headBox,
  headMargin = 1.7,
  outputSize = 1024,
} = {}) {
  const width = Math.trunc(finite(imageWidth, 0))
  const height = Math.trunc(finite(imageHeight, 0))
  if (width < 480 || height < 480) {
    throw new Error('原图尺寸不足，无法可靠生成完整脸部特写')
  }

  const left = finite(headBox?.left)
  const top = finite(headBox?.top)
  const right = finite(headBox?.right)
  const bottom = finite(headBox?.bottom)
  if (
    ![left, top, right, bottom].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || right <= left
    || bottom <= top
    || right - left < 0.02
    || bottom - top < 0.025
  ) {
    throw new Error('视觉模型没有返回有效的角色头部定位框')
  }
  if (left <= 0 || top <= 0 || right >= 1 || bottom >= 1) {
    throw new Error('角色头部本身贴住基础图边缘，无法确认头发和下巴完整；请重新生成留有安全边距的基础图')
  }

  const boxLeft = Math.floor(left * width)
  const boxTop = Math.floor(top * height)
  const boxRight = Math.ceil(right * width)
  const boxBottom = Math.ceil(bottom * height)
  const headWidth = boxRight - boxLeft
  const headHeight = boxBottom - boxTop
  const margin = clamp(finite(headMargin, 1.7), 1.45, 2.1)
  const requestedSquare = Math.max(
    256,
    Math.ceil(Math.max(headWidth, headHeight) * margin / 2) * 2,
  )
  const square = requestedSquare

  if (square < headWidth || square < headHeight) {
    throw new Error('头部定位范围大于原图可用裁切区域，不能保证完整保留下颌')
  }

  const horizontalCenter = (boxLeft + boxRight) / 2
  const desiredX = Math.round(horizontalCenter - square / 2)

  const verticalExtra = square - headHeight
  const desiredY = Math.round(boxTop - verticalExtra * 0.35)

  // A complete head can still be close to the source edge. Expand the white
  // canvas before cropping instead of clamping the crop inward and cutting the
  // chin. The vision gate above rejects a head that is actually clipped.
  const padLeft = Math.max(0, -desiredX)
  const padTop = Math.max(0, -desiredY)
  const padRight = Math.max(0, desiredX + square - width)
  const padBottom = Math.max(0, desiredY + square - height)
  const cropX = desiredX + padLeft
  const cropY = desiredY + padTop
  const paddedWidth = width + padLeft + padRight
  const paddedHeight = height + padTop + padBottom
  const layout = validateCharacterFaceCropLayout({
    imageWidth: width,
    imageHeight: height,
    headBox: { left, top, right, bottom },
    crop: { cropX, cropY, width: square, height: square, padLeft, padTop },
  })
  if (!layout.ok) {
    throw new Error(`${layout.reason}，已停止生成以免输出残缺特写`)
  }

  const size = Math.min(2048, Math.max(512, Math.round(finite(outputSize, 1024))))
  return {
    x: desiredX,
    y: desiredY,
    cropX,
    cropY,
    width: square,
    height: square,
    padLeft,
    padTop,
    padRight,
    padBottom,
    paddedWidth,
    paddedHeight,
    outputSize: size,
  }
}

/** Build a deterministic filter from the current image's detected head bounds. */
export function buildCharacterFaceCropFilter(options = {}) {
  const crop = calculateCharacterFaceCrop(options)
  return [
    `pad=${crop.paddedWidth}:${crop.paddedHeight}:${crop.padLeft}:${crop.padTop}:color=white`,
    `crop=${crop.width}:${crop.height}:${crop.cropX}:${crop.cropY}`,
    `scale=${crop.outputSize}:${crop.outputSize}:force_original_aspect_ratio=decrease`,
    `pad=${crop.outputSize}:${crop.outputSize}:(ow-iw)/2:(oh-ih)/2:color=white`,
  ].join(',')
}

export function characterDerivedQualityAttempts(value, fallback = 3) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(4, Math.max(1, parsed))
}

export function buildCharacterQualityRepairPrompt({
  viewKey,
  previousReason,
  attempt,
} = {}) {
  const angle = viewKey === 'side'
    ? '严格90度左侧面'
    : viewKey === 'back' ? '严格背面' : viewKey === 'front' ? '严格正面' : '脸部正面特写'
  const reason = String(previousReason || '').trim()
  return [
    `这是同一角色${angle}资产的自动质量修复轮次 ${Number(attempt) || 1}。`,
    '不要重新设计人物，不要改变脸、发型、妆容、服装、鞋子、配饰、年龄或身体比例。',
    reason ? `上一轮视觉门禁失败原因：${reason}。只修复上述失败，不要引入新元素。` : '',
    '禁止道具、手持物、第二个人、场景背景、文字、水印、拼贴和多视图排版。',
  ].filter(Boolean).join('\n')
}
