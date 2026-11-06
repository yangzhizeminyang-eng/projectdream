import {
  normalizeSceneSpaceManifest,
} from '../scene-space-manifest.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback
}

function inferEpisodeNo(item, fallback = 1) {
  const explicit = positiveInt(item?.episode_no ?? item?.episodeNo, 0)
  if (explicit) return explicit
  const source = [item?.episode_no, item?.episodeNo, item?.title, item?.summary, item?.content]
    .map(text)
    .join(' ')
  const match = source.match(/(?:第\s*)?(\d{1,3})\s*集/u)
  return positiveInt(match?.[1], positiveInt(fallback, 1))
}

const ABSTRACT_LOCATION_LABELS = new Set([
  '悬疑场景',
  '剧情场景',
  '故事场景',
  '死后三天',
  '未知地点',
  '未提供',
])

export function inferLocationFromSceneText(item) {
  const current = text(item?.location)
  if (current && !ABSTRACT_LOCATION_LABELS.has(current)) return current

  const source = [item?.content, item?.summary].map(text).filter(Boolean).join('\n')
  if (!source) return ''

  if (/公寓/.test(source) && /沙发|茶几|客厅|冰箱|百叶窗|冷咖啡/.test(source)) {
    return '深夜公寓客厅'
  }
  if (/办公室/.test(source) && /书架|办公椅|办公桌|摄像头/.test(source)) {
    return '陈志远办公室（视频画面）'
  }
  if (/机房|主节点|核心日志/.test(source)) return '公司核心机房'
  if (/葬礼|遗照|花圈|灵堂/.test(source)) return '葬礼现场回忆'
  return ''
}

export function inferTimeOfDayFromSceneText(item) {
  const current = text(item?.time_of_day ?? item?.timeOfDay)
  if (current) return current
  const source = [item?.content, item?.summary].map(text).filter(Boolean).join('\n')
  if (/深夜|凌晨|00:00|午夜/.test(source)) return '深夜'
  if (/清晨|早晨|日出/.test(source)) return '清晨'
  if (/夜晚|晚上|夜里/.test(source)) return '夜晚'
  if (/白天|下午|午后|上午/.test(source)) return '白天'
  return ''
}

/**
 * Convert structured scene data returned by the script agent into the rows
 * consumed by the scene-generation flow. Episode summaries are intentionally
 * not accepted here: they do not contain enough spatial information.
 */
export function normalizeExtractedSceneSpecs(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const location = inferLocationFromSceneText(item)
      const rawTitle = text(item?.title)
      const title = ABSTRACT_LOCATION_LABELS.has(rawTitle)
        ? location || `场景 ${String(index + 1).padStart(2, '0')}`
        : rawTitle || location || `场景 ${String(index + 1).padStart(2, '0')}`
      return {
        episode_no: inferEpisodeNo(item, 1),
        scene_no: positiveInt(item?.scene_no ?? item?.sceneNo, index + 1),
        title,
        summary: text(item?.summary),
        location,
        time_of_day: inferTimeOfDayFromSceneText(item),
        content: text(item?.content),
        spatial_anchors: item?.spatial_anchors || item?.spatialAnchors || item?.spatial_anchors_json
          ? normalizeSceneSpaceManifest(item.spatial_anchors || item.spatialAnchors || item.spatial_anchors_json)
          : null,
        estimated_duration: positiveInt(item?.estimated_duration ?? item?.estimatedDuration, 30),
      }
    })
    .filter((item) =>
      item.location
      && !ABSTRACT_LOCATION_LABELS.has(item.location)
      && (item.summary || item.content),
    )
}

export function extractSceneSpecsFromScriptScenes(scenes = []) {
  return normalizeExtractedSceneSpecs(scenes)
}

export function buildSceneExtractionPrompts({ projectName = '', scriptText = '' } = {}) {
  return {
    systemPrompt: [
      '你是影视剧本空间连续性分析 Agent。',
      '请从完整剧本文本中识别所有可拍摄的空间场景，不按集数或剧情标题粗暴合并。',
      '项目层统一角色与世界观；每一集按连续戏剧行动拆分片段，每个片段再绑定唯一主要场景资产。',
      '同一地点且时间连续、人物目标连续、动作承接的戏剧行动归为同一片段；仅因景别、机位或镜头切换不得拆片段。',
      '地点、时间段、现实/回忆/屏幕空间发生切换，或出现明确场次转场时必须拆成新片段；不得把不同空间塞入同一片段。',
      '同一地点只要发生功能区、现实层级或镜头世界切换，就拆成独立场景。',
      '同一建筑内的值班台、监控回放区、档案柜前、走廊/储物柜等功能区，如果剧情分别发生且需要切换人物行动位置，必须拆成独立 scene；每条 scene 的 content 只保留该连续片段真正使用的空间证据，不得把全集的地点清单复制进每条 scene。',
      '场景标题与 location 必须描述当前连续戏的主要拍摄空间；若该段从一个功能区移动到另一区域，按明确的转场拆分，不得为满足九宫格而把多个不相连空间硬拼成一个大房间。',
      '必须识别现实空间、视频/监控画面空间、回忆/闪回空间，并明确写入 location。',
      '每个 scene 都必须带完整 spatial_anchors JSON；锚点类别只能是 architecture、opening、fixed_furniture、material、light；每个锚点必须有稳定 id、description、relative_position、evidence、origin，material/light 还必须有 narrative_reason。',
      '九个 view_bindings（front-left、front、front-right、left、center、right、back-left、back、back-right）必须只引用真实存在且该机位可见的 architecture/opening/fixed_furniture 锚点，每格至少两个；剧本未明确的空间补足标 origin=inference 并说明依据。',
      '场景图提示词只允许空场建筑、固定物件、材质、实体光源和色彩；剧本中的人物、服装、动作、对白、声音、回忆、遗像、屏幕内容和文字只能作为空间推理证据，不能写入场景资产。',
      '只返回紧凑 JSON，不要 Markdown 或解释。格式：{"scenes":[{"episode_no":1,"scene_no":1,"title":"","summary":"","location":"","time_of_day":"","content":"","estimated_duration":30,"spatial_anchors":{"version":1,"anchors":[],"view_bindings":{}}}]}。',
      '多集剧本必须识别集标题或集数标记并写入 episode_no；每一集的 scene_no 从 1 重新编号，同一项目允许不同集出现相同 scene_no，不能把所有场景默认写入第 1 集。',
      'location 必须是具体可拍摄空间，例如“深夜公寓客厅”“公寓电脑工作区”“陈志远办公室（视频画面）”，不能写“死后三天”“悬疑场景”等抽象概念。',
      'content 要保留该空间的构图锚点、固定建筑结构、主要道具、光线方向和人物动作。',
      '材质与光线按各场剧情分别设计：材质反映地点功能、使用历史和情绪；光源说明实体来源、方向、色温、范围与衰减，不能复用一套固定色板。',
      '不得凭空增加正文没有依据的地点；正文未写明但为了镜头连续性必须补足的空间细节，要放入 content 并标注为基于上下文推断。',
    ].join('\n'),
    userPrompt: [
      `项目名：${text(projectName) || '未命名项目'}`,
      '',
      '完整剧本文本：',
      text(scriptText),
      '',
      '请按集 → 连续片段 → 可拍摄空间输出场景列表；每条记录对应一个片段的主要场景，片段正文仅包含该连续戏剧行动。',
    ].join('\n'),
  }
}

export function normalizeSceneExtractionPayload(payload = {}) {
  // Different OpenAI-compatible gateways occasionally unwrap the object and
  // return the array directly. Accept both shapes, but keep validation strict
  // so an episode summary can never silently become a scene.
  const items = Array.isArray(payload)
    ? payload
    : payload?.scenes
      ?? payload?.scene_specs
      ?? payload?.sceneSpecs
      ?? payload?.data?.scenes
      ?? payload?.result?.scenes
  return normalizeExtractedSceneSpecs(items)
}
