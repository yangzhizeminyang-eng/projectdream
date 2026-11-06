import { createHash } from 'node:crypto'

const text = (value) => String(value ?? '').trim()

export function createScriptFingerprint(scenes = []) {
  const snapshot = (Array.isArray(scenes) ? scenes : [])
    .map((scene) => ({
      id: Number(scene.id) || 0,
      episodeNo: Number(scene.episode_no ?? scene.episodeNo) || 1,
      sceneNo: Number(scene.scene_no ?? scene.sceneNo) || 0,
      title: text(scene.title),
      summary: text(scene.summary),
      content: text(scene.content),
    }))
    .sort((left, right) => left.episodeNo - right.episodeNo || left.sceneNo - right.sceneNo || left.id - right.id)
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export function evaluateCreativeWorkflowGates({ scenes = [], parsedFingerprint = '', requiredAssets = [] } = {}) {
  const sceneRows = Array.isArray(scenes) ? scenes : []
  const assets = Array.isArray(requiredAssets) ? requiredAssets : []
  const incompleteScenes = sceneRows.filter((scene) => !text(scene.content))
  const scriptComplete = sceneRows.length > 0 && incompleteScenes.length === 0
  const parseCurrent = scriptComplete && Boolean(parsedFingerprint)
    && createScriptFingerprint(sceneRows) === parsedFingerprint

  let assetsCode = 'script_incomplete'
  let assetsReason = '请先生成并保存全部场景的剧本正文。'
  if (scriptComplete) {
    assetsCode = 'script_parse_required'
    assetsReason = '请先完成当前版本剧本的角色与场景解析。'
    if (parsedFingerprint && !parseCurrent) {
      assetsCode = 'script_parse_stale'
      assetsReason = '剧本已发生变化，请重新解析后再进入资产管理。'
    }
    if (parseCurrent) {
      assetsCode = 'assets_ready'
      assetsReason = ''
    }
  }

  const missingAssets = assets.filter((asset) => asset.exists === false)
  const pendingAssets = assets.filter((asset) => asset.exists !== false && asset.state !== 'confirmed')
  const assetsReady = scriptComplete && parseCurrent
  const storyboardAllowed = assetsReady && assets.length > 0 && missingAssets.length === 0 && pendingAssets.length === 0

  return {
    script: {
      complete: scriptComplete,
      sceneCount: sceneRows.length,
      incompleteCount: incompleteScenes.length,
    },
    assets: {
      allowed: assetsReady,
      code: assetsReady ? 'assets_ready' : assetsCode,
      reason: assetsReady ? '' : assetsReason,
      requiredCount: assets.length,
      missingCount: missingAssets.length,
      pendingCount: pendingAssets.length,
    },
    storyboard: {
      allowed: storyboardAllowed,
      code: storyboardAllowed ? 'storyboard_ready' : !assetsReady ? assetsCode : assets.length === 0 ? 'assets_missing' : 'assets_unconfirmed',
      reason: storyboardAllowed
        ? ''
        : !assetsReady
          ? assetsReason
          : assets.length === 0
            ? '尚未解析出必需资产，请返回剧本重新解析。'
            : `还有 ${missingAssets.length + pendingAssets.length} 项必需资产未完成确认。`,
      requiredCount: assets.length,
      missingCount: missingAssets.length,
      pendingCount: pendingAssets.length,
    },
  }
}
