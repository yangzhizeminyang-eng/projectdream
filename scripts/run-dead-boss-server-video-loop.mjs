// FastAPI-Only 迁移第六阶段：视频循环脚本默认上游由 Node API 切换为 FastAPI（api 服务，默认 8000，API_ORIGIN 可覆盖）。
import mysql from 'mysql2/promise'

const projectId = 2
const apiOrigin = process.env.API_ORIGIN || 'http://api:8000'
const shotIds = [13, 14, 15, 16, 17, 18, 19, 20, 21]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const db = await mysql.createConnection({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'projectdream',
  password: process.env.DB_PASSWORD || 'Zemin520626',
  database: process.env.DB_NAME || 'projectdream',
})
const parse = (value) => {
  try { return JSON.parse(value || '{}') } catch { return {} }
}
async function api(token, path, options = {}) {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code) {
    const detail = body.data?.qualityReport
      ? ` ${JSON.stringify(body.data.qualityReport)}`
      : ''
    throw new Error(`${options.method || 'GET'} ${path}: ${body.message || response.status}${detail}`)
  }
  return body.data
}

try {
  const [sessionRows] = await db.execute(
    `SELECT token FROM sessions WHERE user_id = (SELECT user_id FROM projects WHERE id = ?)
     AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  )
  const token = sessionRows[0]?.token
  if (!token) throw new Error('公网项目没有有效登录会话')
  const [shots] = await db.execute(
    `SELECT id, shot_no, duration_seconds, visual_prompt, action_text, camera_angle, shot_type, composition,
            dialogue_text, asset_reference_json, video_url
     FROM storyboards WHERE id IN (${shotIds.map(() => '?').join(',')})
     ORDER BY FIELD(id, ${shotIds.join(',')})`,
    shotIds,
  )
  if (shots.length !== shotIds.length) throw new Error(`镜头数量不完整 ${shots.length}/${shotIds.length}`)
  const results = []
  for (const shot of shots) {
    if (shot.video_url && !String(shot.video_url).startsWith('pending://')) {
      results.push({ shotNo: shot.shot_no, storyboardId: shot.id, reused: true, videoUrl: shot.video_url })
      continue
    }
    const ref = parse(shot.asset_reference_json)
    for (const key of ['characterId', 'characterVersionNo', 'characterViewSetVersion', 'sceneAssetId', 'scenePanoramaVersion', 'sceneViewSetVersion', 'sceneViewKey']) {
      if (!ref[key]) throw new Error(`镜头 ${shot.shot_no} 缺少硬引用 ${key}`)
    }
    const [assets] = await db.execute(
      `SELECT ai.id, an.node_type, an.label, an.prompt_text, ai.image_url, ai.view_key, ai.view_set_version, ai.version_no
       FROM asset_node_images ai JOIN asset_nodes an ON an.id = ai.asset_node_id
       WHERE ai.id IN (?, ?) AND ai.status = 'confirmed' ORDER BY ai.id`,
      [Number(ref.characterAssetId), Number(ref.sceneAssetId)],
    )
    if (assets.length !== 2) throw new Error(`镜头 ${shot.shot_no} 的参考资产不完整`)
    const referencedAssets = assets.map((asset) => ({
      id: Number(asset.id), assetId: Number(asset.id),
      kind: asset.node_type === 'character' ? 'character' : 'scene',
      type: asset.node_type === 'character' ? 'character' : 'scene',
      nodeType: asset.node_type, name: asset.label, imageUrl: asset.image_url,
      refId: asset.node_type === 'character' ? Number(ref.characterId) : null,
      characterId: asset.node_type === 'character' ? Number(ref.characterId) : null,
      promptText: asset.prompt_text, sceneViewKey: asset.view_key,
      versionNo: Number(asset.version_no), viewSetVersion: Number(asset.view_set_version),
    }))
    const job = await api(token, `/storyboards/${shot.id}/videos/generate`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: [shot.visual_prompt, `景别：${shot.shot_type}`, `机位：${shot.camera_angle}`,
          `构图：${shot.composition}`, `动作：${shot.action_text}`, `对白：${shot.dialogue_text || '无对白'}`].filter(Boolean).join('\n'),
        candidateCount: 1, durationSeconds: Number(shot.duration_seconds) || 5, autoConfirm: true, referencedAssets,
      }),
    })
    for (;;) {
      const current = await api(token, `/generation-jobs/${job.id}`)
      if (current.status === 'success') {
        results.push({ shotNo: shot.shot_no, storyboardId: shot.id, jobId: job.id, status: current.status, result: current.result })
        console.log(JSON.stringify(results.at(-1)))
        break
      }
      if (['failed', 'canceled'].includes(current.status)) throw new Error(`镜头 ${shot.shot_no} 失败：${current.errorText || current.lastErrorCode}`)
      await sleep(5000)
    }
  }
  console.log(JSON.stringify({ projectId, shotCount: results.length, results }, null, 2))
} finally {
  await db.end()
}
