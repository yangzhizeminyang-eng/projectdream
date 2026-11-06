import test from 'node:test'
import assert from 'node:assert/strict'

const source = await import('./studio-script-agent-commands.ts')

test('routes concrete script commands to executable workflow actions', () => {
  assert.deepEqual(source.resolveAgentCommand('请生成故事设定'), { type: 'generate-bible' })
  assert.deepEqual(source.resolveAgentCommand('把内容整理成分集大纲'), { type: 'generate-season' })
  assert.deepEqual(source.resolveAgentCommand('直接生成全剧正文'), { type: 'generate-script' })
  assert.deepEqual(source.resolveAgentCommand('解析角色和场景'), { type: 'parse-assets' })
  assert.deepEqual(source.resolveAgentCommand('保存当前剧本'), { type: 'save-script' })
})

test('keeps ordinary creative feedback as contextual guidance', () => {
  assert.deepEqual(source.resolveAgentCommand('把第三集的结尾改得更悬疑'), {
    type: 'guidance',
    text: '把第三集的结尾改得更悬疑',
  })
})
