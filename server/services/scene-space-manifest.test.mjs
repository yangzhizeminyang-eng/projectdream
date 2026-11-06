import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSceneSpaceAnchorPrompt,
  normalizeSceneSpaceManifest,
  resolveSceneSpaceManifest,
  validateSceneSpaceManifestAgainstScene,
} from './scene-space-manifest.mjs'

const viewKeys = [
  'front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right',
]

function manifest(overrides = {}) {
  const anchors = [
    { id: 'A1', category: 'architecture', label: '落地窗', description: '东侧落地窗', relative_position: '东侧', evidence: '剧本写明落地窗', origin: 'script' },
    { id: 'A2', category: 'fixed_furniture', label: '木桌', description: '窗前旧木桌', relative_position: '窗前', evidence: '角色在桌前收邮件', origin: 'script' },
    { id: 'M1', category: 'material', label: '桌面', description: '磨损哑光木材', relative_position: '窗前', evidence: '旧木桌', origin: 'inference', narrative_reason: '体现长期独居和缺少维护' },
    { id: 'L1', category: 'light', label: '屏幕光', description: '局部冷白光，近处明亮并快速衰减', relative_position: '木桌上', evidence: '电脑自动亮起', origin: 'script', narrative_reason: '突出角色深夜独处时收到信息的压迫感' },
  ]
  return {
    version: 1,
    anchors,
    view_bindings: Object.fromEntries(viewKeys.map((key) => [key, ['A1', 'A2']])),
    ...overrides,
  }
}

test('normalizes a plot-specific manifest with material and motivated lighting anchors', () => {
  const result = normalizeSceneSpaceManifest(manifest())

  assert.equal(result.version, 1)
  assert.deepEqual(result.anchors.map((anchor) => anchor.category), [
    'architecture', 'fixed_furniture', 'material', 'light',
  ])
  assert.equal(result.anchors.find((anchor) => anchor.id === 'L1').narrative_reason,
    '突出角色深夜独处时收到信息的压迫感')
})

test('detects a valid-shaped manifest that omits a plot-critical fixed fixture', () => {
  const scene = {
    location: '市失物招领处夜班值班台',
    content: '值班台右上方台灯照亮登记标签。传送窗口滑出一枚红色发卡。走廊尽头亮着绿色安全出口灯。',
  }
  const report = validateSceneSpaceManifestAgainstScene(manifest(), scene)
  assert.equal(report.passed, false)
  assert.ok(report.missingFixtures.includes('传送窗口'))
})

test('validates only the active screenplay location section when one scene contains multiple locations', () => {
  const scene = {
    title: '场景01 · 夜 · 电脑异常启动',
    location: '值班台、监控回放区、档案柜前、走廊尽头',
    content: '【23:40 夜班值班台】台灯照亮标签，传送窗口滑出红色发卡，走廊尽头有绿色安全出口灯。\n【监控回放·23:37】监控屏幕暂停。\n【档案柜前】周砚打开档案柜。\n【走廊尽头】旧储物柜门缝夹着毛线。',
  }
  const report = validateSceneSpaceManifestAgainstScene(manifest({
    anchors: [
      ...manifest().anchors,
      { id: 'A3', category: 'fixed_furniture', label: '传送窗口', description: '值班台内嵌滑动窗口', relative_position: '值班台正面', evidence: '本场空间明确出现', origin: 'script' },
      { id: 'A4', category: 'fixed_furniture', label: '值班台', description: '夜班工作台', relative_position: '室内中央', evidence: '本场空间明确出现', origin: 'script' },
      { id: 'L2', category: 'light', label: '台灯', description: '值班台台灯', relative_position: '值班台右上', evidence: '本场空间明确出现', origin: 'script', narrative_reason: '局部照亮工作区' },
      { id: 'L3', category: 'light', label: '绿色安全出口灯', description: '走廊尽头实体出口灯', relative_position: '走廊尽头', evidence: '本场空间明确出现', origin: 'script', narrative_reason: '提供远处空间参照' },
    ],
  }), scene)

  assert.equal(report.passed, true)
  assert.deepEqual(report.missingFixtures, [])
})

test('accepts a manifest that anchors every explicit fixed fixture from the scene', () => {
  const scene = {
    location: '市失物招领处夜班值班台',
    content: '值班台右上方台灯照亮登记标签。传送窗口滑出一枚红色发卡。走廊尽头亮着绿色安全出口灯。',
  }
  const fixtureManifest = manifest({
    anchors: [
      ...manifest().anchors,
      { id: 'A0', category: 'fixed_furniture', label: '值班台', description: '夜班值班台', relative_position: '空间中央', evidence: '剧本地点为值班台', origin: 'script' },
      { id: 'A3', category: 'fixed_furniture', label: '传送窗口', description: '值班台内嵌传送窗口，带水平滑轨及外侧托板', relative_position: '值班台正面偏左', evidence: '剧本明确写出传送窗口滑出发卡', origin: 'script' },
      { id: 'L2', category: 'light', label: '台灯', description: '值班台右上方的实体台灯', relative_position: '值班台右上方', evidence: '剧本明确台灯为主光', origin: 'script', narrative_reason: '局部照亮登记工作区并留下暗部信息差' },
      { id: 'L3', category: 'light', label: '绿色安全出口灯', description: '走廊尽头绿色安全出口灯', relative_position: '走廊尽头', evidence: '剧本明确出口灯位置与颜色', origin: 'script', narrative_reason: '提供远处唯一方向性环境光，形成空间纵深' },
    ],
    view_bindings: Object.fromEntries(viewKeys.map((key) => [key, ['A1', 'A3']])),
  })
  const report = validateSceneSpaceManifestAgainstScene(fixtureManifest, scene)
  assert.equal(report.passed, true)
  assert.deepEqual(report.missingFixtures, [])
})

test('repairs missing explicit fixture anchors deterministically before persisting an Agent result', async () => {
  let persisted = null
  const scene = {
    title: '场景01 · 夜 · 电脑异常启动',
    content: '【23:40 失物招领处·夜班值班台】值班台右上方的台灯是唯一主光。传送窗口滑出一枚红色发卡。窗外走廊只亮着尽头那盏绿色安全出口灯。\n【档案柜前】档案柜门打开。',
  }
  const result = await resolveSceneSpaceManifest({
    scene: { ...scene, spatial_anchors_json: JSON.stringify(manifest()) },
    extract: async () => manifest(),
    persist: async (value) => { persisted = value },
  })

  assert.deepEqual(result.anchors.filter((anchor) => ['传送窗口', '值班台', '台灯', '绿色安全出口灯'].includes(anchor.label)).map((anchor) => anchor.label),
    ['传送窗口', '值班台', '绿色安全出口灯', '台灯'])
  assert.equal(result.anchors.find((anchor) => anchor.label === '传送窗口').origin, 'script')
  assert.match(result.anchors.find((anchor) => anchor.label === '传送窗口').relative_position, /推断/u)
  assert.deepEqual(persisted, result)
  assert.equal(validateSceneSpaceManifestAgainstScene(result, scene).passed, true)
})

test('rejects a camera binding with fewer than two valid structural anchors', () => {
  const invalid = manifest({
    view_bindings: Object.fromEntries(viewKeys.map((key) => [key, ['A1', 'M1']])),
  })
  assert.throws(() => normalizeSceneSpaceManifest(invalid), /至少两个有效空间锚点/u)
})

test('rejects material or lighting choices without a plot-based design reason', () => {
  const invalid = manifest()
  invalid.anchors.find((anchor) => anchor.category === 'light').narrative_reason = ''
  assert.throws(() => normalizeSceneSpaceManifest(invalid), /材质和光源锚点必须说明剧情设计依据/u)
})

test('anchor agent prompt derives physical materials and light sources from scene evidence', () => {
  const { systemPrompt, userPrompt } = buildSceneSpaceAnchorPrompt({
    scene: {
      title: '深夜公寓客厅',
      location: '公寓客厅',
      time_of_day: '深夜',
      content: '角色在旧木桌前发现一封邮件，窗外路灯被百叶窗切碎。',
    },
  })

  assert.match(systemPrompt, /material/u)
  assert.match(systemPrompt, /light/u)
  assert.match(systemPrompt, /剧情依据/u)
  assert.match(systemPrompt, /view_bindings/u)
  assert.match(systemPrompt, /不得机械套用审讯室/u)
  assert.match(userPrompt, /旧木桌前发现一封邮件/u)
})

test('resolves and persists missing scene anchors once before image generation', async () => {
  let extracts = 0
  let persisted = null
  const scene = { title: '深夜公寓', content: '电脑亮起。' }
  const result = await resolveSceneSpaceManifest({
    scene,
    extract: async () => {
      extracts += 1
      return manifest()
    },
    persist: async (value) => { persisted = value },
  })

  assert.equal(extracts, 1)
  assert.deepEqual(persisted, result)
  assert.equal((await resolveSceneSpaceManifest({
    scene: { ...scene, spatial_anchors_json: JSON.stringify(result) },
    extract: async () => { extracts += 1; return manifest() },
    persist: async () => assert.fail('existing manifest must not be rewritten'),
  })).anchors.length, 4)
  assert.equal(extracts, 1)
})

test('rejects an invalid generated scene manifest without persisting it', async () => {
  let persisted = false
  await assert.rejects(resolveSceneSpaceManifest({
    scene: { title: '没有空间锚点' },
    extract: async () => ({ anchors: [], view_bindings: {} }),
    persist: async () => { persisted = true },
  }), /必须包含根据剧情设计的 material 与 light/u)
  assert.equal(persisted, false)
})

test('repairs a stale invalid manifest before image generation', async () => {
  let extracted = 0
  let persisted = null
  const stale = manifest({
    view_bindings: Object.fromEntries(viewKeys.map((key) => [key, ['A1']])),
  })
  const result = await resolveSceneSpaceManifest({
    scene: { title: '旧场景', spatial_anchors_json: JSON.stringify(stale) },
    extract: async (scene) => {
      extracted += 1
      assert.match(scene.spatial_anchor_repair_reason, /至少两个有效空间锚点/u)
      return manifest()
    },
    persist: async (value) => { persisted = value },
  })

  assert.equal(extracted, 1)
  assert.deepEqual(persisted, result)
  assert.deepEqual(result.view_bindings['front-left'], ['A1', 'A2'])
})

test('retries anchor extraction when a repaired manifest still has invalid bindings', async () => {
  let extracted = 0
  let persisted = null
  const stale = manifest({
    view_bindings: Object.fromEntries(viewKeys.map((key) => [key, ['A1']])),
  })
  const result = await resolveSceneSpaceManifest({
    scene: { title: '夜班值守', spatial_anchors_json: JSON.stringify(stale) },
    extract: async (scene) => {
      extracted += 1
      if (extracted === 1) return stale
      assert.match(scene.spatial_anchor_repair_reason, /至少两个有效空间锚点/u)
      return manifest()
    },
    persist: async (value) => { persisted = value },
  })

  assert.equal(extracted, 2)
  assert.deepEqual(persisted, result)
  assert.equal(result.view_bindings['front-left'].length, 2)
})
