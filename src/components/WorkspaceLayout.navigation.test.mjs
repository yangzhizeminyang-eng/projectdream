import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('workspace shell renders a logical back button without using browser history', async () => {
  const layout = await readFile(new URL('./WorkspaceLayout.vue', import.meta.url), 'utf8')
  const navigation = await readFile(new URL('../lib/navigation.ts', import.meta.url), 'utf8')
  const studioContext = await readFile(new URL('./production/ProductionContextBar.vue', import.meta.url), 'utf8')

  assert.match(layout, /WorkspaceBackButton/)
  assert.match(layout, /resolveWorkspaceBackTarget/)
  assert.doesNotMatch(layout, /router\.back\(\)/)
  assert.doesNotMatch(navigation, /route\.path === '\/workspace\/export'/)
  assert.doesNotMatch(navigation, /label: '返回成片编辑'/)
  assert.match(studioContext, /class="context-return"/)
  assert.match(studioContext, /path: '\/dashboard'/)
  assert.match(studioContext, /context-project-mark[\s\S]*display: grid/)
})

test('workspace sidebar removes task center shortcut and exposes model settings only once', async () => {
  const sideNav = await readFile(new URL('./SideNav.vue', import.meta.url), 'utf8')
  const quickLinks = sideNav.match(/class="workspace-nav-list space-y-1 side-quick-links"[\s\S]*?<\/ul>/)?.[0] || ''
  const accountMenu = sideNav.match(/class="workspace-account-menu"[\s\S]*?<\/div>\s*<\/Transition>/)?.[0] || ''
  assert.match(sideNav, /快捷入口/)
  assert.doesNotMatch(quickLinks, /任务中心|workspace\/ai-tasks/)
  assert.match(quickLinks, /模型设置/)
  assert.match(quickLinks, /go\('\/settings\/ai'\)/)
  assert.doesNotMatch(accountMenu, /模型设置|settings\/ai/)
})
