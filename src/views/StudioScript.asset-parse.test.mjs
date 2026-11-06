import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = await readFile(new URL('./StudioScript.vue', import.meta.url), 'utf8')
const routerSource = await readFile(new URL('../router/index.ts', import.meta.url), 'utf8')

test('script footer exposes parse script beside the asset library action', () => {
  const footer = source.match(/<footer class="workspace-bottom-bar">([\s\S]*?)<\/footer>/)?.[1] || ''
  assert.match(footer, /解析剧本/)
  assert.match(footer, /进入资产管理/)
  assert.ok(footer.indexOf('解析剧本') < footer.indexOf('进入资产管理'))
  assert.match(source, /parseScriptAssets/)
})

test('script parsing exposes processing and completion feedback', () => {
  assert.match(source, /正在解析剧本/)
  assert.match(source, /剧本解析完成/)
  assert.match(source, /解析失败/)
})

test('asset access is not locked by an unsuccessful script parse', () => {
  const gate = source.match(/const canEnterAssets = computed\(\(\) => ([\s\S]*?)\nconst parseError/)?.[1] || ''
  assert.match(gate, /sceneDrafts\.value\.length > 0/)
  assert.match(gate, /scene\.content\.trim\(\)/)
  assert.doesNotMatch(gate, /scriptParseReady/)
})

test('asset navigation saves the script first and gives an explicit incomplete-workflow override', () => {
  const openAssets = source.match(/function openAssets\(\): Promise<void> \{([\s\S]*?)\n\}/)?.[1] || ''
  assert.match(openAssets, /await saveScripts\(\)/)
  assert.match(openAssets, /if \(!saved\) \{[\s\S]*?return/)
  assert.match(openAssets, /const parsedBeforeSave = scriptParseReady\.value/)
  assert.match(openAssets, /allowIncomplete: '1'/)
  assert.match(openAssets, /!parsedBeforeSave/)
  assert.match(openAssets, /router\.push/)
})

test('the incomplete-workflow override applies to assets only, never storyboard routes', () => {
  assert.match(routerSource, /const explicitAssetRecovery = gatedStage === 'assets' && to\.query\.allowIncomplete === '1'/)
  assert.match(routerSource, /if \(authenticated && gatedStage && !explicitAssetRecovery\)/)
})

test('a FastAPI 501 parse failure explains the manual recovery path', () => {
  assert.match(source, /尚未迁移到当前后端（HTTP 501）/)
  assert.match(source, /手动添加角色和场景/)
})
