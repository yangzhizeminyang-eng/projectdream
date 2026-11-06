import mysql from 'mysql2/promise'

const publicBaseUrl = 'http://<YOUR_SERVER_IP>'
const projectId = 28
const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

try {
  const [rows] = await db.execute(
    `SELECT ai.id, ai.image_url, ai.thumbnail_url, an.project_id
     FROM asset_node_images ai
     INNER JOIN asset_nodes an ON an.id = ai.asset_node_id
     WHERE an.project_id = ?`,
    [projectId],
  )
  let updated = 0
  for (const row of rows) {
    const patch = (value) => {
      const source = String(value || '')
      if (!source.includes('/mock-assets/')) return source
      return `${publicBaseUrl}${new URL(source).pathname}`
    }
    const imageUrl = patch(row.image_url)
    const thumbnailUrl = patch(row.thumbnail_url)
    if (imageUrl === row.image_url && thumbnailUrl === row.thumbnail_url) continue
    await db.execute(
      `UPDATE asset_node_images
       SET image_url = ?, thumbnail_url = ?
       WHERE id = ?`,
      [imageUrl, thumbnailUrl, row.id],
    )
    updated += 1
  }
  console.log(JSON.stringify({ projectId, inspected: rows.length, updated, publicBaseUrl }, null, 2))
} finally {
  await db.end()
}
