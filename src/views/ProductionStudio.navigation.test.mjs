import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const studio = await readFile(new URL('./ProductionStudio.vue', import.meta.url), 'utf8')
const sideNav = await readFile(new URL('../components/SideNav.vue', import.meta.url), 'utf8')
const dashboard = await readFile(new URL('./Dashboard.vue', import.meta.url), 'utf8')

test('existing projects open the script workspace directly from the script module', () => {
  assert.match(studio, /openLaunchModule/)
  assert.match(studio, /workspace\/studio\/script/)
  assert.match(studio, /project\.narrativeVision\?\.trim\(\)/)
  assert.match(studio, /nextPath = project\.narrativeVision/)
})

test('project overview keeps the three-stage creation desk as the single project entry', () => {
  assert.match(dashboard, /path: '\/workspace\/studio'/)
  assert.doesNotMatch(dashboard, /path: '\/workspace\/studio\/idea'/)
  assert.doesNotMatch(dashboard, /path: '\/workspace\/studio\/script'/)
  assert.match(studio, /key: 'script'/)
  assert.match(studio, /key: 'assets'/)
  assert.match(studio, /key: 'storyboard'/)
  assert.doesNotMatch(studio, /key: 'delivery'/)
  assert.doesNotMatch(studio, /高级生产运行/)
})

test('side navigation exposes only the project overview and three creation stages', () => {
  assert.match(sideNav, /label: '创作总览'/)
  assert.match(sideNav, /path: '\/workspace\/studio\/script', label: '剧本生成'/)
  assert.match(sideNav, /path: '\/workspace\/assets', label: '资产'/)
  assert.match(sideNav, /path: '\/workspace\/episodes', label: '分镜视频生成'/)
  assert.doesNotMatch(sideNav, /workspace\/production-run/)
  assert.doesNotMatch(sideNav, /workspace\/market/)
  assert.doesNotMatch(sideNav, /workspace\/edit/)
  assert.doesNotMatch(sideNav, /workspace\/export/)
  assert.doesNotMatch(sideNav, /path: '\/workspace\/script\/ai', label: '剧本'/)
  assert.doesNotMatch(sideNav, /label: '剧本编辑'/)
  assert.doesNotMatch(sideNav, /label: '角色'/)
assert.doesNotMatch(sideNav, /label: '一致性'/)
assert.doesNotMatch(sideNav, /label: '音频'/)
})

test('overview mode loads only project metadata instead of production/model endpoints', () => {
  assert.match(studio, /route\.query\.view === 'overview'/)
  assert.match(studio, /if \(!episodeNo && route\.query\.view === 'overview'\)/)
  assert.match(studio, /const project = await getProject\(projectId\)/)
  assert.match(studio, /return\s*\n\s*\}/)
})
