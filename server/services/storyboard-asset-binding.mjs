import { normalizeStoryboardPerformance } from './storyboard-performance.mjs'
const SCENE_VIEW_ORDER = [
  'front-left', 'front', 'front-right',
  'left', 'center', 'right',
  'back-left', 'back', 'back-right',
]

function text(value) {
  return String(value ?? '').trim()
}

function positiveInt(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function isUsableImage(row) {
  const type = text(row?.node_type)
  const visionStatus = text(row?.vision_status)
  return row && row.status === 'confirmed'
    && (!visionStatus || visionStatus === 'passed' || (type === 'scene' && visionStatus === 'skipped'))
}

function compareNewest(left, right) {
  return Number(right?.view_set_version || 0) - Number(left?.view_set_version || 0)
    || Number(right?.version_no || 0) - Number(left?.version_no || 0)
    || Number(right?.id || 0) - Number(left?.id || 0)
}

function latestRows(rows) {
  const result = new Map()
  for (const row of (Array.isArray(rows) ? rows : []).filter(isUsableImage)) {
    const nodeId = positiveInt(row.asset_node_id ?? row.node_id ?? row.id)
    if (!nodeId) continue
    const viewType = text(row.view_set_type) || 'single'
    const viewKey = text(row.view_key) || '__base__'
    const key = `${nodeId}:${viewType}:${viewKey}`
    const current = result.get(key)
    if (!current || compareNewest(row, current) < 0) result.set(key, row)
  }
  return [...result.values()]
}

function nodeRows(rows, nodeId) {
  return rows.filter((row) => positiveInt(row.asset_node_id ?? row.node_id) === nodeId)
}

function exactName(value, name) {
  return text(value) === text(name)
}

function matchesAssetLabel(label, requestedName) {
  const assetLabel = text(label)
  const requested = text(requestedName)
  if (!assetLabel || !requested) return false
  if (assetLabel === requested) return true

  // The canvas keeps the short asset name and may append the script
  // description after a colon. Keep this boundary explicit to avoid
  // accidentally binding similarly named assets.
  return assetLabel.startsWith(`${requested}：`)
    || assetLabel.startsWith(`${requested}:`)
}

function containsName(haystack, name) {
  const source = text(haystack)
  const needle = text(name)
  return Boolean(needle && source.includes(needle))
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function resolveCharacterName(shot, characters) {
  const names = (Array.isArray(characters) ? characters : [])
    .map((character) => text(character?.name))
    .filter(Boolean)
  const requested = [
    text(shot?.character_name ?? shot?.characterName),
    ...(Array.isArray(shot?.character_assets ?? shot?.characterAssets)
      ? (shot.character_assets ?? shot.characterAssets).map(text)
      : []),
  ].filter(Boolean)
  const exact = names.find((name) => requested.some((candidate) => exactName(candidate, name)))
  if (exact) return exact

  // Some model responses omit character_name but still put the exact name in the prompt.
  const semanticText = [shot?.visual_prompt, shot?.action_text, shot?.dialogue_text].map(text).join('\n')
  return names.find((name) => containsName(semanticText, name)) || text(shot?.character_name ?? shot?.characterName)
}

function resolveCharacterAsset(name, characters, rows) {
  if (!name) return null
  const character = (Array.isArray(characters) ? characters : []).find((item) => exactName(item?.name, name))
  const candidates = rows
    .filter((row) => row.node_type === 'character')
    .filter((row) => row.view_set_type === 'character-asset-pack')
    .filter((row) => isUsableImage(row))
    .filter((row) => exactName(row.label, name) || (character && positiveInt(row.ref_id) === positiveInt(character.id)))
    .sort(compareNewest)
  return candidates[0] || null
}

function resolveNodeBaseImage(rows, nodeId, type) {
  return nodeRows(rows, nodeId)
    .filter((row) => row.node_type === type)
    .filter((row) => !text(row.view_key))
    .filter((row) => row.view_set_type === 'single' || (type === 'scene' && row.view_set_type === 'scene-nine-grid'))
    .sort(compareNewest)[0] || null
}

function availableSceneViews(rows, nodeId) {
  return nodeRows(rows, nodeId)
    .filter((row) => row.node_type === 'scene' && row.view_set_type === 'scene-nine-grid' && text(row.view_key))
    .sort((left, right) => SCENE_VIEW_ORDER.indexOf(text(left.view_key)) - SCENE_VIEW_ORDER.indexOf(text(right.view_key)) || compareNewest(left, right))
}

export function resolveStoryboardSceneViewKey({ requested, cameraAngle } = {}, availableKeys = []) {
  const keys = [...new Set((Array.isArray(availableKeys) ? availableKeys : []).map(text).filter(Boolean))]
  if (!keys.length) return ''
  if (keys.includes(text(requested))) return text(requested)

  const angle = text(cameraAngle).toLowerCase()
  const preferred = angle.includes('背') || angle.includes('后') || angle.includes('back')
    ? ['back', 'back-right', 'back-left']
    : angle.includes('左') || angle.includes('left')
      ? ['left', 'front-left', 'back-left']
      : angle.includes('右') || angle.includes('right')
        ? ['right', 'front-right', 'back-right']
        : ['front', 'center', 'front-right', 'front-left']
  return preferred.find((key) => keys.includes(key))
    || SCENE_VIEW_ORDER.find((key) => keys.includes(key))
    || keys[0]
}

export function bindStoryboardShotAssets({ shot = {}, sceneId, characters = [], assetRows = [] } = {}) {
  const rows = latestRows(assetRows)
  const blockers = []
  const characterName = resolveCharacterName(shot, characters)
  const character = (Array.isArray(characters) ? characters : []).find((item) => exactName(item?.name, characterName))
  const characterAsset = resolveCharacterAsset(characterName, characters, rows)
  const characterRows = characterAsset ? [characterAsset] : []
  const characterNodeId = positiveInt(characterAsset?.asset_node_id ?? characterAsset?.node_id ?? characterAsset?.id)
  const characterAssetPack = characterNodeId
    ? nodeRows(rows, characterNodeId)
      .filter((row) => row.node_type === 'character' && row.view_set_type === 'character-asset-pack')
      .sort(compareNewest)[0] || null
    : null
  const characterFaceRequired = false

  const sceneAsset = rows
    .filter((row) => row.node_type === 'scene' && positiveInt(row.ref_id) === positiveInt(sceneId))
    .sort(compareNewest)[0] || null
  const sceneAssetId = positiveInt(sceneAsset?.asset_node_id ?? sceneAsset?.node_id ?? sceneAsset?.id)
  const scenePanorama = sceneAssetId ? resolveNodeBaseImage(rows, sceneAssetId, 'scene') : null
  const sceneViews = sceneAssetId ? availableSceneViews(rows, sceneAssetId) : []
  const sceneViewKey = resolveStoryboardSceneViewKey(
    { requested: shot.scene_view_key ?? shot.sceneViewKey, cameraAngle: shot.camera_angle ?? shot.cameraAngle },
    sceneViews.map((row) => row.view_key),
  )
  const sceneView = sceneViews.find((row) => text(row.view_key) === sceneViewKey) || null

  if (characterName && !character) blockers.push(`镜头 ${text(shot.shot_no) || '?'} 引用了不存在的角色「${characterName}」`)
  if (characterName && !characterAssetPack) {
    blockers.push(`镜头 ${text(shot.shot_no) || '?'} 的角色「${characterName}」没有已采用的完整角色资产板，请在资产页等待整板视觉检查通过`)
  }
  if (!sceneAsset) blockers.push(`镜头 ${text(shot.shot_no) || '?'} 没有绑定当前场景全景资产`)
  if (!scenePanorama) blockers.push(`镜头 ${text(shot.shot_no) || '?'} 当前场景缺少已确认全景图`)

  const props = list(shot.prop_assets ?? shot.propAssets)
  const propRows = props
    .map((name) => rows
      .filter((row) => ['prop', 'tool', 'material'].includes(text(row.node_type)))
      .filter((row) => row.view_set_type === 'single' && !text(row.view_key))
      .filter((row) => matchesAssetLabel(row.label, name))
      .sort(compareNewest)[0] || null)
    .filter(Boolean)
  const missingProps = props.filter((name) => !propRows.some((row) => matchesAssetLabel(row.label, name)))
  for (const name of missingProps) blockers.push(`镜头 ${text(shot.shot_no) || '?'} 引用的道具「${name}」没有已确认道具资产`)
  const tools = list(shot.tools ?? shot.mention_tools ?? shot.mentionTools)
  const performance = normalizeStoryboardPerformance(shot)
  const assetReference = {
    schemaVersion: 1,
    source: 'storyboard-agent-pipeline',
    characterId: positiveInt(characterAsset?.asset_node_id ?? characterAsset?.node_id ?? characterAsset?.id),
    characterVersionNo: positiveInt(characterAssetPack?.version_no || characterAsset?.version_no),
    characterViewSetVersion: positiveInt(characterAssetPack?.view_set_version || characterAssetPack?.version_no),
    characterViewKeys: ['front', 'side', 'back'],
    characterBaseImageId: positiveInt(characterAssetPack?.image_id ?? characterAssetPack?.id),
    characterBaseVersionNo: positiveInt(characterAssetPack?.version_no),
    characterFaceImageId: positiveInt(characterAssetPack?.image_id ?? characterAssetPack?.id),
    characterFaceVersionNo: positiveInt(characterAssetPack?.version_no),
    characterAssetPackImageId: positiveInt(characterAssetPack?.image_id ?? characterAssetPack?.id),
    characterAssetPackVersionNo: positiveInt(characterAssetPack?.version_no),
    characterFaceRequired,
    characterName: characterName || null,
    voiceProfileKey: text(character?.voice_profile_key),
    voiceLocked: character?.voice_locked === 1 || character?.voice_locked === true,
    sceneAssetId,
    scenePanoramaVersion: positiveInt(scenePanorama?.version_no || sceneAsset?.version_no),
    sceneViewSetVersion: positiveInt(sceneView?.view_set_version),
    sceneAssetNames: [text(sceneAsset?.label)].filter(Boolean),
    scenePanoramaImageId: positiveInt(scenePanorama?.image_id ?? scenePanorama?.id),
    sceneViewKey: sceneViewKey || null,
    sceneViewIndex: positiveInt(sceneView?.view_index),
    propAssetNames: props,
    propAssetIds: propRows.map((row) => positiveInt(row.asset_node_id ?? row.node_id ?? row.id)).filter(Boolean),
    propImageIds: propRows.map((row) => positiveInt(row.image_id ?? row.id)).filter(Boolean),
    propAssetRefs: propRows.map((row) => ({
      assetNodeId: positiveInt(row.asset_node_id ?? row.node_id ?? row.id),
      imageId: positiveInt(row.image_id ?? row.id),
      name: text(row.label),
      versionNo: positiveInt(row.version_no),
    })),
    tools,
    continuityFromShot: null,
    emotionalChange: performance.emotionChange,
    performance,
    startState: text(shot.start_state ?? shot.startState),
    endState: text(shot.end_state ?? shot.endState),
    startVisualPrompt: text(shot.start_visual_prompt ?? shot.startVisualPrompt),
    endVisualPrompt: text(shot.end_visual_prompt ?? shot.endVisualPrompt),
  }

  return {
    blockers,
    assetReference,
    character,
    characterAsset,
    characterRows,
    sceneAsset,
    scenePanorama,
    sceneView,
    propRows,
  }
}

export function buildStoryboardMentionedPrompt(prompt, assetReference = {}) {
  const source = text(prompt)
  const assetNames = [
    assetReference.characterName,
    ...(Array.isArray(assetReference.sceneAssetNames) ? assetReference.sceneAssetNames : []),
    ...(Array.isArray(assetReference.propAssetNames) ? assetReference.propAssetNames : []),
  ].map(text).filter(Boolean)
  const mentions = assetNames.map((name) => `@${name}`)
  const tools = (Array.isArray(assetReference.tools) ? assetReference.tools : [])
    .map(text)
    .filter(Boolean)
    .map((name) => name === '片段衔接' && assetReference.continuityFromShot
      ? `@片段衔接[镜头${text(assetReference.continuityFromShot)}]`
      : `@${name}`)
  const voiceMention = assetReference.characterName && (assetReference.voiceProfileKey || assetReference.voiceLocked)
    ? `@音色[${assetReference.characterName}]`
    : ''
  const tokens = [...mentions, voiceMention, ...tools].filter(Boolean)
  let result = source
  const missing = []
  for (const token of tokens) {
    if (result.includes(token)) continue
    const name = token.startsWith('@片段衔接[')
      ? '片段衔接'
      : token.startsWith('@音色[')
        ? ''
        : token.slice(1)
    if (name && new RegExp(`(^|[^@\\p{L}\\p{N}])${name}(?=$|[^\\p{L}\\p{N}])`, 'u').test(result)) {
      result = result.replace(
        new RegExp(`(^|[^@\\p{L}\\p{N}])${name}(?=$|[^\\p{L}\\p{N}])`, 'u'),
        `$1${token}`,
      )
    } else {
      missing.push(token)
    }
  }
  return missing.length
    ? `【执行引用】${missing.join(' ')}\n${result}`.trim()
    : result
}
