/**
 * Project-memory retrieval seam.
 *
 * This is deliberately provider-neutral: it gives agents a deterministic
 * local/SQL fallback today and leaves the embedding store behind one stable
 * interface for a later LlamaIndex/Milvus adapter. Confirmed asset snapshots
 * remain authoritative and are never replaced by retrieved text.
 */
function text(value) {
  return String(value ?? '').trim()
}

export function buildProjectKnowledgeChunks({ scene = {}, characters = [], assetCatalog = {} } = {}) {
  const episodeNo = Number(scene.episode_no || scene.episodeNo) || 1
  const chunks = [
    {
      kind: 'scene',
      key: `scene:${scene.id || scene.scene_id || scene.scene_no || scene.sceneNo || 1}`,
      assetId: String(scene.id || scene.scene_id || scene.scene_no || scene.sceneNo || 1),
      assetVersion: Number(scene.version_no || scene.versionNo) || 1,
      episodeNo,
      text: [scene.title, scene.summary, scene.location, scene.time_of_day, scene.content].filter(Boolean).join('；'),
    },
    ...characters.map((character) => ({
      kind: 'character',
      key: `character:${character?.id || text(character?.name)}`,
      assetId: String(character?.id || text(character?.name)),
      assetVersion: Number(character?.asset_version || character?.assetVersion || character?.version_no) || 1,
      episodeNo,
      text: [character?.name, character?.personality, character?.appearance, character?.costume, character?.voice_style, character?.voice_setting, character?.voice_profile_key, character?.confirmed_image_id ? `confirmed-image:${character.confirmed_image_id}` : ''].filter(Boolean).join('；'),
    })),
    ...(Array.isArray(assetCatalog.scenes) ? assetCatalog.scenes : []).map((asset) => ({
      kind: 'scene-asset',
      key: `scene-asset:${asset?.assetNodeId || text(asset?.name)}:v${Number(asset?.versionNo) || 1}:views:${Number(asset?.viewSetVersion) || 1}`,
      assetId: String(asset?.assetNodeId || text(asset?.name)),
      assetVersion: Number(asset?.versionNo) || 1,
      episodeNo,
      text: [asset?.name, asset?.assetPrompt || asset?.promptText, ...(asset?.sceneViewKeys || []), ...(asset?.confirmedImages || []).map((image) => `image:${image.imageId}`)].filter(Boolean).join('；'),
    })),
    ...(Array.isArray(assetCatalog.props) ? assetCatalog.props : []).map((asset) => ({
      kind: 'prop-asset',
      key: `prop-asset:${asset?.assetNodeId || text(asset?.name)}:v${Number(asset?.versionNo) || 1}:views:${Number(asset?.viewSetVersion) || 1}`,
      assetId: String(asset?.assetNodeId || text(asset?.name)),
      assetVersion: Number(asset?.versionNo) || 1,
      episodeNo,
      text: [asset?.name, asset?.assetPrompt || asset?.promptText, ...(asset?.confirmedImages || []).map((image) => `image:${image.imageId}`)].filter(Boolean).join('；'),
    })),
  ]
  return chunks.filter((chunk) => chunk.text)
}

export function buildRagDocuments({ projectId, episodeNo, chunks = [] } = {}) {
  const normalizedProjectId = Number(projectId) || 0
  const normalizedEpisodeNo = Number(episodeNo) || null
  if (normalizedProjectId <= 0) return []
  return (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => text(chunk?.text))
    .map((chunk) => ({
      text: text(chunk.text),
      metadata: {
        project_id: normalizedProjectId,
        episode_id: Number(chunk.episodeNo) || normalizedEpisodeNo,
        asset_type: text(chunk.kind) || 'project-memory',
        asset_id: text(chunk.assetId) || text(chunk.key) || 'project-memory',
        asset_version: Number(chunk.assetVersion) > 0 ? Number(chunk.assetVersion) : 1,
        source: 'node-project-knowledge',
      },
    }))
}

export function retrieveProjectContext(chunks = [], query = '', limit = 8, options = {}) {
  const terms = text(query).toLocaleLowerCase('zh-CN').split(/\s+|[，。；：、“”！？,.!?]/u).filter(Boolean)
  const episodeNo = Number(options?.episodeNo) || 0
  return (Array.isArray(chunks) ? chunks : [])
    .filter((chunk) => !episodeNo || !chunk?.episodeNo || Number(chunk.episodeNo) === episodeNo)
    .map((chunk, index) => {
      const haystack = text(chunk?.text).toLocaleLowerCase('zh-CN')
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
      return { ...chunk, score, index }
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Number(limit) || 8))
    .filter((chunk) => chunk.score > 0 || terms.length === 0)
}

export function formatRetrievedProjectContext(chunks = []) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => `[${text(chunk?.kind)}] ${text(chunk?.text)}`)
    .filter(Boolean)
    .join('\n')
}
