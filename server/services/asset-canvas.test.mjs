import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_NODE_DEFAULT_HEIGHT,
  ASSET_NODE_DEFAULT_WIDTH,
  buildAssetCanvasView,
  normalizeAssetNodeLayout,
  normalizeAssetNodeType,
  summarizeAssetCanvas,
  assetNodeImageRow,
  buildAssetCanvasLayout,
  buildAssetCanvasGroupBounds,
  ASSET_CANVAS_GROUP_HEADER_HEIGHT,
  ASSET_CANVAS_GROUP_PADDING,
  findSceneNodeMatch,
  deriveAssetNodeState,
} from './asset-canvas.mjs'

test('asset node image falls back to the durable image URL when thumbnail is absent', () => {
  const image = assetNodeImageRow({
    id: 9,
    asset_node_id: 4,
    image_url: 'http://127.0.0.1:3001/storage/projects/12/asset-nodes/4/v1-1.png',
    thumbnail_url: null,
  })
  assert.equal(image.imageUrl, image.thumbnailUrl)
})

test('asset node image exposes scene cell provenance', () => {
  const image = assetNodeImageRow({
    id: 21,
    asset_node_id: 4,
    image_url: 'https://cdn.test/front-right.png',
    source_image_id: 20,
    source_image_url: 'https://cdn.test/mother.png',
    crop_json: JSON.stringify({ x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 }),
  })

  assert.equal(image.sourceImageId, 20)
  assert.equal(image.sourceImageUrl, 'https://cdn.test/mother.png')
  assert.deepEqual(image.crop, { x: 2 / 3, y: 0, width: 1 / 3, height: 1 / 3 })
})

test('asset node type only accepts the four canvas categories', () => {
  for (const type of ['character', 'scene', 'prop', 'material']) {
    assert.equal(normalizeAssetNodeType(type), type)
  }
  // 大小写与空白要归一化，避免前端传 'Character ' 建出第二类节点
  assert.equal(normalizeAssetNodeType('  Character '), 'character')
  // 未知类型必须拒绝，而不是回落到某个默认分类
  assert.equal(normalizeAssetNodeType('storyboard'), null)
  assert.equal(normalizeAssetNodeType(''), null)
  assert.equal(normalizeAssetNodeType(null), null)
  assert.equal(normalizeAssetNodeType(undefined), null)
})

test('asset canvas preserves the isolated scene environment prompt', () => {
  const view = buildAssetCanvasView({
    projectId: 4,
    nodes: [{
      id: 101,
      project_id: 4,
      node_type: 'scene',
      ref_id: 25,
      label: '死后三天',
      prompt_text: 'full screenplay prompt',
      environment_prompt_text: 'environment-only prompt',
    }],
  })
  assert.equal(view.nodes[0].environmentPromptText, 'environment-only prompt')
})

test('matches a legacy scene node to exactly one script scene by title', () => {
  const match = findSceneNodeMatch(
    { nodeType: 'scene', label: '死后三天', refId: null },
    [
      { id: 66, title: '死后三天', time_of_day: '深夜' },
      { id: 67, title: '机房', time_of_day: '夜间' },
    ],
  )
  assert.equal(match?.id, 66)
})

test('matches a scene node by its persisted scene group key when its label is stale', () => {
  const match = findSceneNodeMatch(
    { nodeType: 'scene', groupKey: 'scene:67:default', label: '旧场景标题' },
    [
      { id: 66, title: '死后三天' },
      { id: 67, title: '机房' },
    ],
  )
  assert.equal(match?.id, 67)
})

test('refreshes a linked scene node by its durable script scene reference', () => {
  const match = findSceneNodeMatch(
    { nodeType: 'scene', refId: 66, label: '旧标题' },
    [{ id: 66, title: '新标题' }],
  )
  assert.equal(match?.title, '新标题')
})

test('relinks a stale scene reference by a unique scene number after script reparse', () => {
  const match = findSceneNodeMatch(
    { node_type: 'scene', ref_id: 43, label: '场景01 · 夜 · 电脑异常启动' },
    [
      { id: 44, scene_no: 1, title: '明日凌晨遗失标签' },
      { id: 45, scene_no: 2, title: '后门归还箱便签' },
    ],
  )
  assert.equal(match?.id, 44)
})

test('does not relink a stale scene reference when scene number repeats across episodes', () => {
  const match = findSceneNodeMatch(
    { node_type: 'scene', ref_id: 43, label: '场景01 · 夜 · 旧钩子' },
    [
      { id: 44, episode_no: 1, scene_no: 1, title: '第一集场景' },
      { id: 54, episode_no: 2, scene_no: 1, title: '第二集场景' },
    ],
  )
  assert.equal(match, null)
})

test('does not guess when legacy scene labels are ambiguous', () => {
  const match = findSceneNodeMatch(
    { node_type: 'scene', label: '办公室' },
    [
      { id: 66, title: '办公室' },
      { id: 67, title: '办公室' },
    ],
  )
  assert.equal(match, null)
})

test('asset node layout falls back to defaults instead of storing NaN', () => {
  const layout = normalizeAssetNodeLayout({})
  assert.equal(layout.x, 0)
  assert.equal(layout.y, 0)
  assert.equal(layout.width, ASSET_NODE_DEFAULT_WIDTH)
  assert.equal(layout.height, ASSET_NODE_DEFAULT_HEIGHT)

  // NaN / Infinity / 字符串垃圾都不能写进数据库
  const dirty = normalizeAssetNodeLayout({
    x: Number.NaN,
    y: '不是数字',
    width: Number.POSITIVE_INFINITY,
    height: -10,
  })
  assert.equal(dirty.x, 0)
  assert.equal(dirty.y, 0)
  assert.equal(dirty.width, ASSET_NODE_DEFAULT_WIDTH)
  assert.equal(dirty.height, ASSET_NODE_DEFAULT_HEIGHT)
})

test('mock asset images cannot make a character or scene node confirmed', () => {
  const state = deriveAssetNodeState([
    {
      status: 'confirmed',
      modelName: 'mock-asset-lock-v1',
      imageUrl: 'http://example.test/mock-assets/project-28/node-21/v1-1.png',
      visionStatus: 'pending',
    },
  ])

  assert.equal(state, 'ready')
})

test('a real adopted scene remains confirmed when visual inspection was skipped', () => {
  assert.equal(deriveAssetNodeState([{
    status: 'confirmed',
    modelName: 'real-image-provider',
    imageUrl: 'https://cdn.test/scene.png',
    visionStatus: 'skipped',
  }], 'scene'), 'confirmed')
  assert.equal(deriveAssetNodeState([{
    status: 'confirmed',
    modelName: 'real-image-provider',
    imageUrl: 'https://cdn.test/character.png',
    visionStatus: 'skipped',
  }], 'character'), 'ready')
})

test('asset node layout clamps size and rounds coordinates', () => {
  const clamped = normalizeAssetNodeLayout({
    x: 1234.5678,
    y: -987.6543,
    width: 99999,
    height: 1,
  })
  // 坐标保留两位小数，画布不存浮点噪声
  assert.equal(clamped.x, 1234.57)
  assert.equal(clamped.y, -987.65)
  // 尺寸钳制在可读区间内，防止节点被缩成一条线或撑爆画布
  assert.ok(clamped.width <= 640 && clamped.width >= 160)
  assert.ok(clamped.height <= 640 && clamped.height >= 160)
})

test('asset canvas layout places entity groups in columns and states in rows', () => {
  const layout = buildAssetCanvasLayout([
    { id: 3, node_type: 'character', ref_id: 20, label: '陈志远', appearance_label: '夜间' , x: 900, y: 900 },
    { id: 1, node_type: 'character', ref_id: 10, label: '林默', appearance_label: '白天', x: 0, y: 0 },
    { id: 2, node_type: 'character', ref_id: 10, label: '林默', appearance_label: '夜间', x: 800, y: 20 },
  ])
  const first = layout.find((item) => item.id === 1)
  const second = layout.find((item) => item.id === 2)
  const third = layout.find((item) => item.id === 3)
  assert.ok(first && second && third)
  assert.equal(first.x, second.x)
  assert.ok(second.y > first.y)
  assert.ok(new Set(layout.map((item) => item.x)).size === 2)
})

test('asset group bounds wrap the actual node coordinates and reserve header space', () => {
  const nodes = [
    { id: 1, node_type: 'character', ref_id: 10, label: '林默', x: 48, y: 48, width: 220, height: 260 },
    { id: 2, node_type: 'character', ref_id: 10, label: '林默', appearance_label: '夜间', x: 48, y: 364, width: 220, height: 260 },
    { id: 3, node_type: 'scene', label: '机房', x: 340, y: 48, width: 220, height: 260 },
  ]
  const bounds = buildAssetCanvasGroupBounds(nodes)
  const character = bounds.find((group) => group.nodeType === 'character')
  const scene = bounds.find((group) => group.nodeType === 'scene')

  assert.deepEqual(character.bounds, { x: 22, y: -66, width: 272, height: 716 })
  assert.deepEqual(scene.bounds, { x: 314, y: -66, width: 272, height: 400 })
})

test('asset group layout reserves a non-overlapping label track above its nodes', () => {
  const layout = buildAssetCanvasLayout([
    { id: 1, node_type: 'prop', label: '三张便签', width: 220, height: 260 },
  ])
  const bounds = buildAssetCanvasGroupBounds(layout)
  const group = bounds[0]
  const node = layout[0]

  assert.equal(node.y, 48 + ASSET_CANVAS_GROUP_HEADER_HEIGHT)
  assert.ok(
    group.bounds.y + ASSET_CANVAS_GROUP_HEADER_HEIGHT + ASSET_CANVAS_GROUP_PADDING <= node.y,
  )
  assert.ok(group.bounds.y + group.bounds.height >= node.y + node.height)
})

test('asset canvas view derives node state from real images, not a stored flag', () => {
  const view = buildAssetCanvasView({
    projectId: 12,
    nodes: [
      { id: 1, project_id: 12, node_type: 'character', ref_id: 30, label: '小光', status: 'active' },
      { id: 2, project_id: 12, node_type: 'character', ref_id: 30, label: '小光', appearance_label: '5 岁的小光', status: 'active' },
      { id: 3, project_id: 12, node_type: 'scene', label: '县城医院病房', status: 'active' },
    ],
    images: [
      { id: 11, asset_node_id: 2, image_url: 'https://cdn.test/a.png', status: 'candidate' },
      {
        id: 12,
        asset_node_id: 2,
        image_url: 'https://cdn.test/b.png',
        model_name: 'real-image-provider',
        vision_status: 'passed',
        status: 'confirmed',
      },
    ],
  })

  assert.equal(view.projectId, 12)
  assert.equal(view.nodes.length, 3)
  assert.equal(view.groups.length, 2)
  assert.deepEqual(view.groups.map((group) => group.key), ['character:30', 'scene:3'])
  assert.equal(view.groups[0].nodeCount, 2)
  assert.equal(view.groups[1].nodeCount, 1)

  const emptyNode = view.nodes.find((node) => node.id === 1)
  // 没有图 = 待补充，不能因为节点存在就显示成已完成
  assert.equal(emptyNode.state, 'draft')
  assert.equal(emptyNode.confirmedImage, null)
  assert.equal(emptyNode.images.length, 0)

  const readyNode = view.nodes.find((node) => node.id === 2)
  assert.equal(readyNode.state, 'confirmed')
  assert.equal(readyNode.confirmedImage.id, 12)
  assert.equal(readyNode.images.length, 2)
  assert.equal(readyNode.appearanceLabel, '5 岁的小光')

  const sceneNode = view.nodes.find((node) => node.id === 3)
  assert.equal(sceneNode.state, 'draft')
})

test('asset canvas summary counts categories the way the library tabs read', () => {
  const summary = summarizeAssetCanvas([
    { nodeType: 'character', state: 'confirmed' },
    { nodeType: 'character', state: 'draft' },
    { nodeType: 'scene', state: 'draft' },
    { nodeType: 'scene', state: 'ready' },
    { nodeType: 'prop', state: 'draft' },
    { nodeType: 'material', state: 'confirmed' },
  ])

  assert.equal(summary.total, 6)
  assert.deepEqual(summary.byType, { character: 2, scene: 2, prop: 1, material: 1 })
  // 「待补充」是图 3 卡片上那个橙色数字，只统计完全没有图的节点
  assert.equal(summary.pendingCount, 3)
  assert.equal(summary.confirmedCount, 2)
  assert.equal(summary.readyCount, 1)
})

test('asset canvas exposes view-level validation for turnaround and nine-grid assets', () => {
  const view = buildAssetCanvasView({
    projectId: 12,
    nodes: [
      { id: 1, project_id: 12, node_type: 'character', label: '唐宁', status: 'active' },
      { id: 2, project_id: 12, node_type: 'scene', label: '合规办公室', status: 'active' },
    ],
    images: [
      { id: 11, asset_node_id: 1, image_url: 'https://cdn.test/t.png', view_set_type: 'character-turnaround', view_index: 1, view_key: 'front', status: 'confirmed' },
      { id: 12, asset_node_id: 1, image_url: 'https://cdn.test/t.png', view_set_type: 'character-turnaround', view_index: 2, view_key: 'side', status: 'confirmed' },
      { id: 13, asset_node_id: 1, image_url: 'https://cdn.test/t.png', view_set_type: 'character-turnaround', view_index: 3, view_key: 'back', status: 'confirmed' },
      { id: 21, asset_node_id: 2, image_url: 'https://cdn.test/s.png', view_set_type: 'scene-nine-grid', view_index: 1, view_key: 'front-left', status: 'confirmed' },
    ],
  })

  const character = view.nodes.find((node) => node.id === 1)
  const scene = view.nodes.find((node) => node.id === 2)
  assert.equal(character.viewSetValidation[0].ready, true)
  assert.equal(scene.viewSetValidation[0].ready, false)
  assert.equal(scene.viewSetValidation[0].missing.length, 8)
})

test('asset canvas displays only the newest candidate for each character angle', () => {
  const view = buildAssetCanvasView({
    projectId: 12,
    nodes: [{ id: 1, project_id: 12, node_type: 'character', label: '唐宁', status: 'active' }],
    images: [
      { id: 11, asset_node_id: 1, image_url: 'https://cdn.test/front-old.png', view_set_type: 'character-turnaround', view_index: 1, view_key: 'front', status: 'candidate' },
      { id: 12, asset_node_id: 1, image_url: 'https://cdn.test/side.png', view_set_type: 'character-turnaround', view_index: 2, view_key: 'side', status: 'confirmed' },
      { id: 13, asset_node_id: 1, image_url: 'https://cdn.test/back.png', view_set_type: 'character-turnaround', view_index: 3, view_key: 'back', status: 'candidate' },
      { id: 14, asset_node_id: 1, image_url: 'https://cdn.test/front-new.png', view_set_type: 'character-turnaround', view_index: 1, view_key: 'front', status: 'candidate' },
    ],
  })

  const character = view.nodes[0]
  assert.deepEqual(
    character.viewItems.map((item) => item.viewKey),
    ['front', 'side', 'back'],
  )
  const front = character.viewItems.find((item) => item.viewKey === 'front')
  assert.equal(front.imageId, 14)
})
