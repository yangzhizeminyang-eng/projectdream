import mysql from 'mysql2/promise'

const db = await mysql.createConnection({
  host: process.env.DB_HOST || 'mysql',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'projectdream',
  password: process.env.DB_PASSWORD || 'Zemin520626',
  database: process.env.DB_NAME || 'projectdream',
})
const base = process.env.PUBLIC_BASE_URL || 'http://<YOUR_SERVER_IP>:8002'
const projectId = 2
const sceneId = 13

const shots = [
  ['01', 6, 3, '唐宁', '冷白灯下，唐宁坐在合规办公室，离职协议摊在桌上，赵衡把笔推到她面前。', '赵衡：签了，今天就能走。', '中景', '正面'],
  ['02', 6, 3, '唐宁', '唐宁翻到协议最后一页，手指停在签名栏，银色腕表在冷光下反光。', '', '近景', '右前'],
  ['03', 6, 4, '唐宁', '唐宁的电脑和手机同时亮起，新邮件弹出，屏幕上出现发件人赵启明。', '', '特写', '正面'],
  ['04', 6, 5, '唐宁', '唐宁抬眼，意识到赵启明已经去世三天，邮件正文只有三个字：别签字。', '', '近景', '左前'],
  ['05', 8, 5, '赵启明', '老板留下的视频自动播放，只拍到桌面和半截袖口，赵启明的声音传来。', '赵启明：你父亲五年前的事故，不是意外。', '特写', '俯拍'],
  ['06', 10, 3, '唐宁', '唐宁呼吸一滞，画面切到旧事故档案，文件角落出现公司内部编号。', '', '特写', '右侧'],
  ['07', 10, 4, '赵衡', '赵衡保持微笑，伸手合上唐宁的电脑，办公室玻璃隔断映出两人的压迫距离。', '赵衡：唐小姐，伪造邮件、泄露数据，责任已经很清楚。', '中景', '左侧'],
  ['08', 9, 4, '赵衡', '赵衡俯身看向邮件详情，语气很轻，却把压力推到极限。', '赵衡：你可以查一下，邮件是从哪台电脑发出的。', '近景', '右前'],
  ['09', 4, 3, '唐宁', '唐宁点击查看来源，屏幕反光映出她自己的电脑名，画面骤然黑屏。', '邮件来自唐宁自己的电脑。', '特写', '正面'],
]

const [characters] = await db.query('SELECT id, name FROM characters WHERE project_id = ? ORDER BY id', [projectId])
const characterByName = new Map(characters.map((row) => [row.name, Number(row.id)]))
const sceneNodeLabel = '公司合规办公室'

async function ensureNode(nodeType, refId, label, prompt) {
  const [rows] = await db.query(
    'SELECT * FROM asset_nodes WHERE project_id = ? AND node_type = ? AND label = ? AND status <> ? LIMIT 1',
    [projectId, nodeType, label, 'archived'],
  )
  if (rows[0]) return rows[0]
  const [result] = await db.query(
    `INSERT INTO asset_nodes
      (project_id, node_type, ref_id, label, appearance_label, prompt_text, x, y, width, height, group_key, status)
     VALUES (?, ?, ?, ?, ?, ?, 80, 80, 260, 220, ?, 'active')`,
    [projectId, nodeType, refId, label, label, prompt, nodeType === 'character' ? '角色' : '场景'],
  )
  const [created] = await db.query('SELECT * FROM asset_nodes WHERE id = ?', [result.insertId])
  return created[0]
}

async function ensureImage(nodeId, versionNo, viewSetType, viewSetVersion, viewIndex, viewKey, viewLabel) {
  const url = `${base}/mock-assets/project-28/node-${nodeId}/v${versionNo}-${viewIndex}.png`
  const [rows] = await db.query(
    'SELECT * FROM asset_node_images WHERE asset_node_id = ? AND view_key = ? AND status = ? LIMIT 1',
    [nodeId, viewKey, 'confirmed'],
  )
  if (rows[0]) return rows[0]
  const [result] = await db.query(
    `INSERT INTO asset_node_images
      (asset_node_id, version_no, image_url, thumbnail_url, prompt_snapshot, model_name,
       view_set_type, view_set_version, view_index, view_key, view_label, status, confirmed_at)
     VALUES (?, ?, ?, ?, ?, 'projectdream-reference', ?, ?, ?, ?, ?, 'confirmed', NOW())`,
    [nodeId, versionNo, url, url, JSON.stringify({ source: 'dead-boss-episode-one', viewKey }), viewSetType, viewSetVersion, viewIndex, viewKey, viewLabel],
  )
  const [created] = await db.query('SELECT * FROM asset_node_images WHERE id = ?', [result.insertId])
  return created[0]
}

const characterAssets = {}
for (const character of characters) {
  const node = await ensureNode('character', character.id, character.name, '固定角色造型，保证三视图一致')
  const views = [
    ['front', '正面三视图', 1],
    ['side', '侧面三视图', 2],
    ['back', '背面三视图', 3],
  ]
  const images = []
  for (const [key, label, index] of views) images.push(await ensureImage(node.id, 1, 'character-turnaround', 1, index, key, label))
  characterAssets[character.name] = { node, images }
}

const sceneNode = await ensureNode('scene', null, sceneNodeLabel, '公司合规办公室，玻璃隔断，冷白荧光灯，夜晚')
const sceneViews = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right']
const sceneImages = []
for (let index = 0; index < sceneViews.length; index += 1) {
  sceneImages.push(await ensureImage(sceneNode.id, 1, 'scene-nine-grid', 1, index + 1, sceneViews[index], `场景九宫格 ${sceneViews[index]}`))
}

const [existing] = await db.query('SELECT id FROM storyboards WHERE scene_id = ? ORDER BY sort_order, id', [sceneId])
const ids = []
for (let index = 0; index < shots.length; index += 1) {
  const [shotNo, duration, characterViewIndex, characterName, action, dialogue, shotType, cameraAngle] = shots[index]
  const character = characterAssets[characterName]
  const characterImage = character.images[(characterViewIndex - 1) % character.images.length]
  const sceneImage = sceneImages[index % sceneImages.length]
  const reference = {
    characterId: Number(character.node.ref_id),
    characterVersionNo: 1,
    characterAssetId: Number(characterImage.id),
    characterViewSetVersion: 1,
    characterViewKeys: character.images.map((item) => item.view_key),
    sceneAssetId: Number(sceneImage.id),
    scenePanoramaVersion: 1,
    sceneViewSetVersion: 1,
    sceneViewKey: sceneImage.view_key,
    sceneViewIndex: Number(sceneImage.view_index),
  }
  const prompt = `竖屏9:16，都市职场悬疑，冷白荧光灯，压迫克制，公司合规办公室。${action} 固定角色造型：${characterName}。镜头角度：${cameraAngle}。禁止改变角色发型、服装、年龄和脸部特征。`
  if (existing[index]) {
    await db.query(
      `UPDATE storyboards SET shot_no=?, duration_seconds=?, character_id=?, character_name=?, action_text=?,
       dialogue_text=?, shot_type=?, camera_angle=?, visual_prompt=?, asset_reference_json=?, status='pending', sort_order=? WHERE id=?`,
      [shotNo, duration, character.node.ref_id, characterName, action, dialogue, shotType, cameraAngle, prompt, JSON.stringify(reference), index, existing[index].id],
    )
    ids.push(Number(existing[index].id))
  } else {
    const [result] = await db.query(
      `INSERT INTO storyboards
       (scene_id, shot_no, shot_type, camera_angle, composition, duration_seconds, character_id, character_name,
        action_text, dialogue_text, visual_prompt, asset_reference_json, sort_order, status)
       VALUES (?, ?, ?, ?, '稳定构图', ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [sceneId, shotNo, shotType, cameraAngle, duration, character.node.ref_id, characterName, action, dialogue, prompt, JSON.stringify(reference), index],
    )
    ids.push(Number(result.insertId))
  }
}
console.log(JSON.stringify({ projectId, sceneId, characterNodes: Object.fromEntries(Object.entries(characterAssets).map(([name, value]) => [name, value.node.id])), sceneNode: sceneNode.id, storyboardIds: ids }, null, 2))
