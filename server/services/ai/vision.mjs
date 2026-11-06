import { getAiConfig, isMockProvider } from './config.mjs'
import { enforceAssetContentVision, enforceEmptySceneVision } from '../scene-vision-policy.mjs'

function text(value) {
  return String(value ?? '').trim()
}

export function buildVisionRequestPayload({
  model,
  imageUrl,
  referenceImageUrl,
  referenceImageUrls = [],
  viewKey,
  scene = false,
  assetPack = false,
  nodeType = '',
  noFace = false,
  identityLock = false,
} = {}) {
  const angle = {
    front: '正面',
    side: '严格90度左侧面',
    back: '背面',
  }[text(viewKey)] || '指定视角'
  const normalizedViewKey = text(viewKey)
  // “不露脸”是角色正面资产的剧情约束；侧面和背面仍必须按请求的几何视角
  // 检查，否则视觉模型会忽略 back/side，导致错误正面图被误判为合格。
  const useNoFaceConstraint = noFace && !['side', 'back'].includes(normalizedViewKey)
  const prop = ['prop', 'material', 'tool'].includes(text(nodeType))
  const target = prop
    ? `这是单件道具资产。检查图片中是否为一个完整、可识别、可实际使用的道具本体：主体完整入镜，完整边缘可见，最左到最右边缘、最高点到底部接触面、把手、底座、开口、按钮、接口、线缆和附属结构均清晰可见；道具居中，四周有安全留白，背景干净中性，禁止人物、手持、场景、拼贴、重复道具和水印。若提示词明确写出“剧情指定标签/道具标签”，只允许该标签原样存在；除此之外的随机文字、乱码、错误数字、平台Logo和水印必须拒绝。不要使用人物全身或人体比例判定标准。`
    : assetPack
      ? '这是角色资产板母图，不是单张角色图，也不是一张只检查排版的网页缩略图。检查原始横向白底资产板是否按固定排版包含五个语义区域：左侧完整正面全身图；右上独立且明显可辨的正面脸部特写；右下依次为正面、严格90度侧面、背面三张完整全身图。脸部特写是五官、脸型、发际线和发型的身份主参考；左侧正面全身图是体态、身高比例、服装、鞋子和配饰的基准；右下三视图必须逐一同时回看这两个基准，不能只看“像一个人”或只看衣服。必须核对正面全身、脸部特写、三视图正面/侧面/背面的眼距、眉眼形状、鼻梁鼻尖、嘴唇、下颌轮廓、耳朵、发际线、发长发量、肩宽体态、服装版型颜色和固定配饰是否属于同一角色。侧面必须是严格90度且鼻梁、嘴唇、下颌轮廓自然连续；背面不得出现脸，但发型长度、后脑勺轮廓、肩线、衣服后片和鞋子必须与正面基准一致。优先判断区域是否存在、顺序是否正确、脸部特写是否独立、三视图是否齐全；不要因为网页缩略图、区域人物较小或自然留白而判缺失。只要任一视图出现换脸、五官明显变形、脸型不一致、发型漂移、年龄性别改变、体态比例明显漂移、服装/配饰不一致、错误侧面/背面，就必须 passed=false。不要把模型的不确定性当作通过；无法清楚比较时也必须 passed=false。'
    : scene
    ? text(viewKey)
      ? `这是九宫格单格中的${text(viewKey)}独立机位图。检查该图是否与第二张全景母图保持同一空间的固定布局、建筑结构、门窗方向、固定道具位置和光线关系；允许因摄影机角度变化出现透视变化、自然遮挡和画面比例变化，不要因为只显示单一机位而判失败，也不要要求该机位重复呈现全景中所有物件`
      : '这是场景全景母版图。检查是否为完整可用的环境空间全景，空间布局、建筑结构、门窗方向、固定道具位置和光线关系是否清晰稳定；禁止角色主体、多人、字幕、文字和水印'
    : normalizedViewKey === 'face'
      ? '这是角色脸部特写资产。检查是否为同一角色的正面脸部特写，脸部应占画面宽度约35%至70%，眼睛、鼻子和嘴唇清晰可辨；头发顶部、双耳、下颌线和锁骨上方完整可见，画面不能出现膝盖、腰部以下或大段躯干；禁止全身、半身动作、侧面、背面、三分之四侧脸、场景、道具、文字和水印。'
      : useNoFaceConstraint
      ? `这是剧情明确要求不直接露脸的角色资产。检查是否为单人、从头到鞋完整全身、纯白背景；脸部必须保持不可辨识或被构图/阴影/遮挡隐藏，不得把该角色生成成清晰正脸肖像`
      : `角色是否为${angle}、单人、从头到鞋完整全身、白色背景，并且没有错误视角特征。若目标为严格90度左侧面，必须拒绝仍能看到双眼、胸口正面或两只鞋正面的正面图；若目标为背面，必须拒绝可见脸部`
  const references = [
    ...(Array.isArray(referenceImageUrls) ? referenceImageUrls : []),
    referenceImageUrl,
  ].map(text).filter(Boolean).filter((value, index, values) => values.indexOf(value) === index)
  const content = [
    {
      type: 'input_text',
      text: [
        '你是资产图片视觉质检器。',
        '第一张图片是唯一需要判定的当前候选原图，不是网页截图、缩略图或候选列表；不要根据界面布局、裁切预览或其它历史图片推断。',
        target,
        identityLock ? '身份一致性与服装一致性检查：当前候选必须与后续参考图属于同一张脸、同一发型和同一套服装；如果脸型、五官相对位置、发长、衣服颜色/版型、鞋子或固定配饰明显变化，必须 passed=false，并在 reason 中指出具体差异。不要因为参考图中某个角度被遮挡而臆测不一致。' : '',
        '如果图片主体符合目标但网页预览可能被裁切，按原图主体判定，不因UI显示区域缺少头脚而拒绝；只有原图本身确实缺失头脚、角度错误、出现人物/场景污染或结构错误时才拒绝。',
        assetPack
          ? '资产板必须只返回JSON，不要Markdown，格式为：{"passed":false,"reason":"指出具体不一致区域和差异","face_closeup_consistent":false,"base_full_body_consistent":false,"turnaround_consistent":false,"region_checks":{"face":{"consistent":false,"reason":""},"base":{"consistent":false,"reason":""},"front":{"consistent":false,"reason":""},"side":{"consistent":false,"reason":""},"back":{"consistent":false,"reason":""}},"layout_complete":false,"identity_similarity_score":0,"wardrobe_consistency_score":0}。五个 region_checks 必须全部返回；任一无法确认必须 consistent=false、passed=false。'
          : '只返回JSON，不要Markdown，格式为：{"passed":true,"reason":"简短且可操作的原因"}',
      ].join(' '),
    },
    {
      type: 'input_image',
      image_url: text(imageUrl),
    },
  ]
  if (references.length) {
    content.push({
      type: 'input_text',
      text: scene
        ? '后续图片是同一空间的全景母图，只用于比对固定布局和空间锚点，不把它们当成待检查的目标视角。'
        : identityLock
          ? '后续图片是已确认的同一角色身份参考图，依次用于比对基础全身、脸部特写和各个角度；它们不是待检查的目标。'
          : '后续图片是参考图，只用于辅助比对，不把它们当成待检查的目标。',
    })
    for (const reference of references) {
      content.push({ type: 'input_image', image_url: reference })
    }
  }
  return {
    model: text(model),
    input: [{
      role: 'user',
      content,
    }],
    temperature: 0,
    // 资产板需要返回五个区域的逐项一致性结论；256 tokens 会在 back
    // 区域尚未闭合时截断 JSON，导致合格图片被误报为“无法解析”。
    max_output_tokens: assetPack ? 768 : 256,
    reasoning: { effort: 'minimal' },
  }
}

function extractText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  if (typeof payload?.choices?.[0]?.message?.content === 'string') {
    return payload.choices[0].message.content
  }
  const values = []
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (typeof item?.text === 'string') values.push(item.text)
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') values.push(content.text)
      if (typeof content?.value === 'string') values.push(content.value)
      if (typeof content?.content === 'string') values.push(content.content)
    }
  }
  return values.join('\n')
}

export function buildCharacterHeadLocalizationPayload({ model, imageUrl, imageWidth, imageHeight } = {}) {
  return {
    model: text(model),
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            '你是角色基础全身参考图的头部定位器，不要生成或编辑图像。',
            `原图像素尺寸为 ${Math.trunc(Number(imageWidth) || 0)} × ${Math.trunc(Number(imageHeight) || 0)}。坐标原点在左上角，x 向右增加，y 向下增加。`,
            '只检测唯一人物的完整头部区域：边界从最高处的头发顶部到下巴最底端，左右包含完整头发轮廓和双耳；不要把脖子、肩膀或衣服算进 head_box。',
            '必须先确认头顶、双耳、下颌和下巴都在原图内完整可见；任一部分被画面边缘截断、被物体遮挡、脸部过小或无法确定时，complete 必须为 false。',
            '图片中不是恰好一个清晰人物时也必须 complete=false。不要猜测图片外的区域。',
            '同时返回 person_box（人物从头顶到鞋底的完整外接框）和 head_box（完整头部框），用二者比例交叉核验，不能把眼鼻嘴局部当成头部。',
            '同时返回 head_landmarks：hair_top（头发最高点）、left_ear（左耳最外侧）、right_ear（右耳最外侧）、chin_bottom（下巴最低点）；这些关键点必须落在人物框内，不能猜测被裁掉的下巴。',
            '返回单行 JSON，不要 Markdown：{"person_count":1,"complete":true,"confidence":0.0,"coordinate_space":"grid_1000","person_box":{"left":0,"top":0,"right":0,"bottom":0},"head_box":{"left":0,"top":0,"right":0,"bottom":0},"head_landmarks":{"hair_top":{"x":0,"y":0},"left_ear":{"x":0,"y":0},"right_ear":{"x":0,"y":0},"chin_bottom":{"x":0,"y":0}},"reason":""}。',
            '两个框都必须使用整张原图映射到0到1000的整数网格坐标：图像左边为x=0、右边为x=1000，顶部为y=0、底部为y=1000；禁止返回原始像素、百分数或局部裁切坐标。confidence 是0到1。若无法定位，两个框都为 null。',
          ].join(' '),
        },
        { type: 'input_image', image_url: text(imageUrl) },
      ],
    }],
    temperature: 0,
    max_output_tokens: 320,
    reasoning: { effort: 'minimal' },
  }
}

export function parseCharacterHeadLocalization(payload, { imageWidth, imageHeight, requireLandmarks = false } = {}) {
  const raw = extractText(payload).trim()
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { ok: false, reason: '视觉模型没有返回可解析的头部定位结果' }

  let value
  try {
    value = JSON.parse(match[0])
  } catch {
    return { ok: false, reason: '视觉模型返回的头部定位 JSON 无法解析' }
  }

  const confidence = Number(value?.confidence)
  const normalizeBox = (box) => {
    if (!box || typeof box !== 'object') return null
    const coordinates = Object.fromEntries(['left', 'top', 'right', 'bottom'].map((key) => [key, Number(box[key])]))
    const values = Object.values(coordinates)
    if (value?.coordinate_space === 'grid_1000') {
      return Object.fromEntries(Object.entries(coordinates).map(([key, coordinate]) => [key, coordinate / 1000]))
    }
    if (value?.coordinate_space === 'pixels' && values.every((coordinate) => coordinate >= 0 && coordinate <= 1000) && values.some((coordinate) => coordinate > 1)) {
      return Object.fromEntries(Object.entries(coordinates).map(([key, coordinate]) => [key, coordinate / 1000]))
    }
    if (value?.coordinate_space === 'pixels' && !values.every((coordinate) => coordinate >= 0 && coordinate <= 1)) {
      const width = Number(imageWidth)
      const height = Number(imageHeight)
      if (!(width > 0) || !(height > 0)) return null
      return {
        left: coordinates.left / width,
        top: coordinates.top / height,
        right: coordinates.right / width,
        bottom: coordinates.bottom / height,
      }
    }
    return Object.fromEntries(Object.entries(coordinates).map(([key, coordinate]) => [
      key,
      Number.isFinite(coordinate) && coordinate > 1 && coordinate <= 100 ? coordinate / 100 : coordinate,
    ]))
  }
  const headBox = normalizeBox(value?.head_box ?? value?.headBox)
  const personBox = normalizeBox(value?.person_box ?? value?.personBox)
  const normalizePoint = (point) => {
    if (!point || typeof point !== 'object') return null
    const x = Number(point.x)
    const y = Number(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (value?.coordinate_space === 'grid_1000') return { x: x / 1000, y: y / 1000 }
    if (value?.coordinate_space === 'pixels' && (x > 1 || y > 1)) {
      if (x <= 1000 && y <= 1000) return { x: x / 1000, y: y / 1000 }
      const width = Number(imageWidth)
      const height = Number(imageHeight)
      if (!(width > 0) || !(height > 0)) return null
      return { x: x / width, y: y / height }
    }
    return {
      x: Number.isFinite(x) && x > 1 && x <= 100 ? x / 100 : x,
      y: Number.isFinite(y) && y > 1 && y <= 100 ? y / 100 : y,
    }
  }
  const landmarkSource = value?.head_landmarks ?? value?.headLandmarks
  const headLandmarks = landmarkSource && typeof landmarkSource === 'object'
    ? {
        hairTop: normalizePoint(landmarkSource.hair_top ?? landmarkSource.hairTop),
        leftEar: normalizePoint(landmarkSource.left_ear ?? landmarkSource.leftEar),
        rightEar: normalizePoint(landmarkSource.right_ear ?? landmarkSource.rightEar),
        chinBottom: normalizePoint(landmarkSource.chin_bottom ?? landmarkSource.chinBottom),
      }
    : null
  if (value?.person_count !== 1) {
    return { ok: false, reason: '基准图中没有确认到且仅有一个清晰角色，无法安全裁切脸部特写' }
  }
  if (value?.complete !== true) {
    return { ok: false, reason: text(value?.reason) || '视觉模型无法确认头顶、双耳和下巴完整可见' }
  }
  if (!Number.isFinite(confidence) || confidence < 0.65) {
    return { ok: false, reason: '头部定位置信度不足，已停止自动裁切以避免切掉下巴' }
  }
  if (
    !headBox
    || !Object.values(headBox).every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
    || headBox.right <= headBox.left
    || headBox.bottom <= headBox.top
    || headBox.right - headBox.left < 0.02
    || headBox.bottom - headBox.top < 0.025
    || headBox.right - headBox.left > 0.9
    || headBox.bottom - headBox.top > 0.9
  ) {
    return { ok: false, reason: '视觉模型返回的头部定位框无效，已停止自动裁切' }
  }
  if (
    !personBox
    || !Object.values(personBox).every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1)
    || personBox.right <= personBox.left
    || personBox.bottom <= personBox.top
    || personBox.bottom - personBox.top < 0.25
  ) {
    return { ok: false, reason: '视觉模型没有返回可信的全身人物框，无法校验头部比例' }
  }
  const completeLandmarks = headLandmarks && Object.values(headLandmarks).every(Boolean)
    ? headLandmarks
    : null
  if (requireLandmarks && !completeLandmarks) {
    return { ok: false, reason: '视觉模型没有返回头发顶部、双耳和下巴最低点等完整关键点，已停止裁切' }
  }
  if (headLandmarks && !completeLandmarks) {
    return { ok: false, reason: '视觉模型返回的头部关键点不完整，无法确认头发、双耳或下巴完整，已停止裁切' }
  }
  if (completeLandmarks) {
    const landmarkValues = Object.values(completeLandmarks)
    if (landmarkValues.some((point) =>
      point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1
      || point.x < personBox.left - 0.005
      || point.x > personBox.right + 0.005
      || point.y < personBox.top - 0.005
      || point.y > personBox.bottom + 0.005
    )) {
      return { ok: false, reason: '头部关键点超出人物框，无法确认头发、双耳或下巴完整，已停止裁切' }
    }
    if (
      completeLandmarks.hairTop.y > completeLandmarks.chinBottom.y
      || completeLandmarks.leftEar.x >= completeLandmarks.rightEar.x
      || completeLandmarks.hairTop.y > headBox.bottom
      || completeLandmarks.chinBottom.y < headBox.top
    ) {
      return { ok: false, reason: '头部关键点顺序与头部框矛盾，无法确认完整脸部范围，已停止裁切' }
    }
  }
  const expandedHeadBox = completeLandmarks
    ? {
        left: Math.min(headBox.left, completeLandmarks.leftEar.x),
        top: Math.min(headBox.top, completeLandmarks.hairTop.y),
        right: Math.max(headBox.right, completeLandmarks.rightEar.x),
        bottom: Math.max(headBox.bottom, completeLandmarks.chinBottom.y),
      }
    : headBox
  if (
    expandedHeadBox.left < personBox.left - 0.02
    || expandedHeadBox.right > personBox.right + 0.02
    || expandedHeadBox.top < personBox.top - 0.015
    || expandedHeadBox.bottom > personBox.bottom
  ) {
    return { ok: false, reason: '头部关键点扩展后的完整范围与人物框矛盾，已停止裁切' }
  }
  const personHeight = personBox.bottom - personBox.top
  const headHeightRatio = (expandedHeadBox.bottom - expandedHeadBox.top) / personHeight
  const headTopOffsetRatio = (expandedHeadBox.top - personBox.top) / personHeight
  const headCenterX = (expandedHeadBox.left + expandedHeadBox.right) / 2
  if (
    expandedHeadBox.left < personBox.left - 0.02
    || expandedHeadBox.right > personBox.right + 0.02
    || expandedHeadBox.top < personBox.top - 0.015
    || expandedHeadBox.bottom > personBox.bottom
    || headCenterX < personBox.left
    || headCenterX > personBox.right
    || headHeightRatio < 0.06
    || headHeightRatio > 0.42
    || headTopOffsetRatio > 0.12
  ) {
    return { ok: false, reason: '头部框与人物全身框比例矛盾，疑似只框到局部脸或定位偏移，已停止裁切' }
  }
  if (expandedHeadBox.left < 0.005 || expandedHeadBox.top < 0.005 || expandedHeadBox.right > 0.995 || expandedHeadBox.bottom > 0.995) {
    return { ok: false, reason: '头部定位框贴近原图边缘，无法确认头顶或下巴完整，已停止自动裁切' }
  }
  return {
    ok: true,
    confidence,
    headBox: expandedHeadBox,
    headLandmarks,
    personBox,
    reason: text(value?.reason) || '头顶至下巴定位完整',
  }
}

function imageMimeType(bytes) {
  if (bytes?.[0] === 0x89 && bytes?.[1] === 0x50 && bytes?.[2] === 0x4e && bytes?.[3] === 0x47) return 'image/png'
  if (bytes?.[0] === 0xff && bytes?.[1] === 0xd8) return 'image/jpeg'
  if (bytes?.toString?.('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/png'
}

export async function locateCharacterHeadBounds({ imageBytes, imageUrl, imageWidth, imageHeight } = {}) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return { ok: false, reason: '当前文本模型处于 mock 模式，不能对真实角色图片执行头部定位' }
  }
  const baseUrl = text(
    process.env.VISION_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses',
  ).replace(/\/+$/, '')
  const apiKey = text(process.env.VISION_API_KEY || '')
  const model = text(process.env.VISION_MODEL || 'doubao-seed-2-1-lite-260915')
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, reason: '未配置视觉模型，无法安全定位角色头部' }
  }
  const imageData = imageBytes?.length
    ? `data:${imageMimeType(imageBytes)};base64,${Buffer.from(imageBytes).toString('base64')}`
    : text(imageUrl)
  if (!imageData) return { ok: false, reason: '头部定位缺少基础全身图' }

  const requestPayload = JSON.stringify(buildCharacterHeadLocalizationPayload({
    model,
    imageUrl: imageData,
    imageWidth,
    imageHeight,
  }))
  const timeoutMs = Number(process.env.VISION_TIMEOUT_MS || 60000)
  const retryDelayMs = Math.max(0, Number(process.env.VISION_RETRY_DELAY_MS || 300))
  let lastFailure = '视觉服务暂时不可用'
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestPayload,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      lastFailure = `头部定位请求失败：${error instanceof Error ? error.message : '未知错误'}`
      if (attempt < 2) {
        if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        continue
      }
      return { ok: false, reason: lastFailure }
    }
    const responseText = await response.text()
    let payload = null
    try {
      payload = responseText ? JSON.parse(responseText) : null
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = text(payload?.error?.message || payload?.message || payload?.detail || responseText.slice(0, 300))
      lastFailure = `头部定位视觉接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`
      const transientResponse = [408, 425, 429].includes(response.status) || response.status >= 500
      if (attempt < 2 && transientResponse) {
        if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        continue
      }
      return { ok: false, reason: lastFailure }
    }
    return parseCharacterHeadLocalization(
      { output_text: extractChatContent(payload) },
      { imageWidth, imageHeight, requireLandmarks: true },
    )
  }
  return { ok: false, reason: lastFailure }
}

export function parseVisionResult(payload, { assetPack = false } = {}) {
  const raw = extractText(payload).trim()
  const match = raw.match(/\{[\s\S]*\}/) || raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (!match) {
    const shape = {
      topLevelKeys: Object.keys(payload || {}).slice(0, 20),
      outputTypes: Array.isArray(payload?.output)
        ? payload.output.map((item) => ({
          type: item?.type || null,
          contentTypes: Array.isArray(item?.content)
            ? item.content.map((content) => content?.type || typeof content)
            : [],
        })).slice(0, 10)
        : [],
      rawPreview: raw.slice(0, 500),
    }
    return {
      passed: false,
      reason: `视觉模型没有返回合法JSON（响应结构：${JSON.stringify(shape)}）`,
      raw,
    }
  }
  try {
    const result = JSON.parse(match[1] || match[0])
    const identitySimilarityScore = Number.isFinite(Number(result.identity_similarity_score))
      ? Number(result.identity_similarity_score)
      : null
    const wardrobeConsistencyScore = Number.isFinite(Number(result.wardrobe_consistency_score))
      ? Number(result.wardrobe_consistency_score)
      : null
    if (!assetPack) {
      return {
        passed: result.passed === true,
        reason: text(result.reason) || (result.passed === true ? '视觉检查通过' : '视觉检查未通过'),
        identitySimilarityScore,
        wardrobeConsistencyScore,
        raw,
      }
    }

    const regionKeys = ['face', 'base', 'front', 'side', 'back']
    const checks = result.region_checks && typeof result.region_checks === 'object'
      ? result.region_checks
      : null
    const missingChecks = regionKeys.filter((key) => !checks?.[key] || typeof checks[key].consistent !== 'boolean')
    const inconsistentRegions = regionKeys.filter((key) => checks?.[key]?.consistent !== true)
    const boardConsistent = result.layout_complete === true
      && result.face_closeup_consistent === true
      && result.base_full_body_consistent === true
      && result.turnaround_consistent === true
      && missingChecks.length === 0
      && inconsistentRegions.length === 0
    if (!boardConsistent) {
      const regionReasons = inconsistentRegions
        .map((key) => text(checks?.[key]?.reason))
        .filter(Boolean)
      const detail = missingChecks.length
        ? `五区身份一致性结论缺失：${missingChecks.join('、')}`
        : `不一致区域：${inconsistentRegions.join('、')}${regionReasons.length ? `（${regionReasons.join('；')}）` : ''}`
      return {
        passed: false,
        reason: `角色资产板一致性检查未通过：${detail}${text(result.reason) ? `；视觉模型说明：${text(result.reason)}` : ''}`,
        identitySimilarityScore,
        wardrobeConsistencyScore,
        assetPackConsistency: {
          faceCloseup: result.face_closeup_consistent === true,
          baseFullBody: result.base_full_body_consistent === true,
          turnaround: result.turnaround_consistent === true,
          missingChecks,
          inconsistentRegions,
        },
        raw,
      }
    }
    return {
      passed: result.passed === true,
      reason: text(result.reason) || (result.passed === true ? '角色资产板五区一致性检查通过' : '视觉检查未通过'),
      identitySimilarityScore,
      wardrobeConsistencyScore,
      assetPackConsistency: {
        faceCloseup: true,
        baseFullBody: true,
        turnaround: true,
        missingChecks: [],
        inconsistentRegions: [],
      },
      raw,
    }
  } catch {
    return { passed: false, reason: '视觉模型返回内容无法解析', raw }
  }
}

export function enforceVisionViewConsistency({ viewKey, result = {} } = {}) {
  const normalizedKey = text(viewKey)
  const reason = text(result.reason)
  if (!result.passed || !reason || !['side', 'back'].includes(normalizedKey)) {
    return result
  }

  const explicitlyNegative = /(?:不是|非|无|未见|看不到|不可见)[^。；，,]{0,8}(?:正面|双眼|脸|面部)/u.test(reason)
  const contradiction = normalizedKey === 'back'
    ? !explicitlyNegative && /正面(?:形象|照|视角|朝向)|可见脸|看到脸|露脸|面部清晰/u.test(reason)
    : !explicitlyNegative && /正面(?:形象|照|视角|朝向)|双眼|胸口正面|可见脸|看到脸/u.test(reason)

  if (!contradiction) return result
  return {
    ...result,
    passed: false,
    reason: `视觉模型结果与请求视角判定自相矛盾：${reason}`,
  }
}

function extractChatContent(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item?.text === 'string' ? item.text : '')
      .filter(Boolean)
      .join('\n')
  }
  return extractText(payload)
}

export async function inspectAssetImage({
  imageUrl,
  imageBytes,
  referenceImageUrl,
  referenceImageUrls = [],
  referenceImageBytes,
  referenceImageBytesList = [],
  viewKey,
  scene = false,
  assetPack = false,
  nodeType = '',
  noFace = false,
  identityLock = false,
} = {}) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return { passed: true, reason: 'mock 模式跳过视觉检查', skipped: true }
  }
  const baseUrl = text(
    process.env.VISION_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3/responses',
  ).replace(/\/+$/, '')
  const apiKey = text(process.env.VISION_API_KEY || '')
  const model = text(process.env.VISION_MODEL || 'doubao-seed-2-1-lite-260915')
  if (!baseUrl || !apiKey || !model) {
    return { passed: false, reason: '未配置视觉模型，等待视觉检查', pending: true }
  }
  const normalizedImageUrl = text(imageUrl)
  const dataUrl = imageBytes
    ? `data:image/png;base64,${Buffer.from(imageBytes).toString('base64')}`
    : normalizedImageUrl
  if (!dataUrl) return { passed: false, reason: '视觉检查缺少可读取的图片' }
  const referenceDataUrls = [
    ...(Array.isArray(referenceImageBytesList) ? referenceImageBytesList : []),
    ...(Array.isArray(referenceImageUrls) ? referenceImageUrls : []),
  ].map((value) => value instanceof Uint8Array
    ? `data:image/png;base64,${Buffer.from(value).toString('base64')}`
    : text(value)).filter(Boolean)
  const referenceDataUrl = referenceImageBytes
    ? `data:image/png;base64,${Buffer.from(referenceImageBytes).toString('base64')}`
    : text(referenceImageUrl)
  let response
  try {
    response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildVisionRequestPayload({
        model,
        imageUrl: dataUrl,
        referenceImageUrl: referenceDataUrl,
        referenceImageUrls: referenceDataUrls,
        viewKey,
        scene,
        assetPack,
        nodeType,
        noFace,
        identityLock,
      })),
      signal: AbortSignal.timeout(Number(process.env.VISION_TIMEOUT_MS || 60000)),
    })
  } catch (error) {
    return { passed: false, reason: `视觉检查请求失败：${error instanceof Error ? error.message : '未知错误'}` }
  }
  const responseText = await response.text()
  let payload = null
  try {
    payload = responseText ? JSON.parse(responseText) : null
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail = text(
      payload?.error?.message
      || payload?.message
      || payload?.detail
      || responseText.slice(0, 300),
    )
    return {
      passed: false,
      reason: `视觉接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      detail: payload,
    }
  }
  console.info('[vision] response shape', JSON.stringify({
    topLevelKeys: Object.keys(payload || {}).slice(0, 20),
    outputTypes: Array.isArray(payload?.output)
      ? payload.output.map((item) => ({
        type: item?.type || null,
        contentTypes: Array.isArray(item?.content)
          ? item.content.map((content) => content?.type || typeof content)
          : [],
      })).slice(0, 10)
      : [],
    outputTextLength: typeof payload?.output_text === 'string' ? payload.output_text.length : 0,
  }))
  const contentChecked = enforceAssetContentVision(
    parseVisionResult({ output_text: extractChatContent(payload) }, { assetPack }),
    { nodeType, scene },
  )
  const sceneChecked = scene ? enforceEmptySceneVision(contentChecked) : contentChecked
  return enforceVisionViewConsistency({
    viewKey,
    result: sceneChecked,
  })
}
