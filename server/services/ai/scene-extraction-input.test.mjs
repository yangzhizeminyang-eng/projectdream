import assert from 'node:assert/strict'
import test from 'node:test'

function buildFallbackScriptText(rows) {
  return rows
    .map((item) => [
      `【第${item.scene_no || '?'}场｜${item.title || '未命名场景'}】`,
      item.summary,
      item.content,
    ].filter(Boolean).join('\n'))
    .join('\n\n')
    .trim()
}

test('reuses saved scene screenplay content when extraction input is omitted', () => {
  const scriptText = buildFallbackScriptText([
    {
      scene_no: 1,
      title: '死后三天',
      summary: '林默收到一封来自亡者的邮件。',
      content: '深夜，公寓里没有开灯。窗外霓虹透过百叶窗落在茶几上的冷咖啡上。',
    },
  ])

  assert.match(scriptText, /第1场｜死后三天/)
  assert.match(scriptText, /深夜，公寓里没有开灯/)
  assert.match(scriptText, /冷咖啡/)
})
