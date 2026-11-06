import mysql from 'mysql2/promise'

const projectId = Number(process.env.PROJECT_ID || 28)
const apiOrigin = process.env.PROJECTDREAM_API_ORIGIN || 'http://127.0.0.1:3011'
const apiBase = `${apiOrigin}/api`
const shotIds = [308, 309, 310, 311, 312, 300, 301, 302, 303]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) || fallback } catch { return fallback }
}

async function api(token, path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.code) throw new Error(`${options.method || 'GET'} ${path}: ${body.message || response.status}`)
  return body.data
}

async function main() {
  const db = await mysql.createConnection(dbConfig)
  try {
    const [sessions] = await db.execute(
      `SELECT token FROM sessions
       WHERE user_id = (SELECT user_id FROM projects WHERE id = ? LIMIT 1)
         AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    )
    const token = sessions[0]?.token
    if (!token) throw new Error(`项目 ${projectId} 没有可用登录会话`)

    const placeholders = shotIds.map(() => '?').join(',')
    const [shots] = await db.execute(
      `SELECT id, shot_no, duration_seconds, visual_prompt, action_text, camera_angle,
              shot_type, composition, dialogue_text, asset_reference_json
       FROM storyboards WHERE id IN (${placeholders}) ORDER BY FIELD(id, ${shotIds.join(',')})`,
      shotIds,
    )
    if (shots.length !== shotIds.length) throw new Error(`分镜数量不完整：${shots.length}/${shotIds.length}`)

    const results = []
    for (const shot of shots) {
      const reference = parseJson(shot.asset_reference_json)
      for (const key of ['characterId', 'characterVersionNo', 'characterViewSetVersion', 'sceneAssetId', 'scenePanoramaVersion', 'sceneViewSetVersion', 'sceneViewKey']) {
        if (!reference[key]) throw new Error(`镜头 ${shot.shot_no} 缺少硬引用 ${key}`)
      }
      const [assetRows] = await db.execute(
        `SELECT ai.id, an.node_type, an.label, an.prompt_text, ai.image_url,
                ai.view_key, ai.view_set_version, ai.version_no
         FROM asset_node_images ai
         INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
         WHERE ai.id IN (?, ?)
           AND ai.status = 'confirmed'
         ORDER BY ai.id ASC`,
        [Number(reference.characterAssetId), Number(reference.sceneAssetId)],
      )
      const referencedAssets = assetRows.map((asset) => ({
        id: Number(asset.id),
        assetId: Number(asset.id),
        kind: asset.node_type === 'character' ? 'character' : 'scene',
        nodeType: asset.node_type,
        name: asset.label,
        imageUrl: asset.image_url,
        promptText: asset.prompt_text,
        sceneViewKey: asset.view_key,
        versionNo: Number(asset.version_no),
        viewSetVersion: Number(asset.view_set_version),
      }))
      if (referencedAssets.length !== 2) {
        throw new Error(`镜头 ${shot.shot_no} 的角色/场景参考图未找到`)
      }
      const job = await api(token, `/storyboards/${shot.id}/videos/generate`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: [
            shot.visual_prompt,
            `景别：${shot.shot_type}`,
            `机位：${shot.camera_angle}`,
            `构图：${shot.composition}`,
            `动作：${shot.action_text}`,
            `对白：${shot.dialogue_text || '无对白'}`,
          ].filter(Boolean).join('\n'),
          candidateCount: 1,
          durationSeconds: Number(shot.duration_seconds) || 5,
          autoConfirm: true,
          referencedAssets,
        }),
      })
      let completed
      for (;;) {
        const current = await api(token, `/generation-jobs/${job.id}`)
        if (current.status === 'success') { completed = current; break }
        if (['failed', 'canceled'].includes(current.status)) throw new Error(`镜头 ${shot.shot_no} 任务失败：${current.errorText || current.lastErrorCode}`)
        await sleep(100)
      }
      results.push({
        shotNo: shot.shot_no,
        storyboardId: shot.id,
        jobId: job.id,
        videoId: completed.result?.items?.[0]?.id || null,
        status: completed.status,
      })
      console.log(JSON.stringify(results.at(-1)))
    }
    console.log(JSON.stringify({ projectId, mode: 'direct-text-to-video', shotCount: results.length, results }, null, 2))
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
