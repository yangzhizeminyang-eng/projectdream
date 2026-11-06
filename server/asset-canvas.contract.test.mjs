import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const serverSource = (await readFile(new URL('./index.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

/** 截取某个路由处理块，用来做「这段代码里不许出现什么」的断言 */
function routeBlock(startMarker) {
  const start = serverSource.indexOf(startMarker)
  assert.notEqual(start, -1, `未找到路由起点：${startMarker}`)
  const rest = serverSource.slice(start + startMarker.length)
  // 到下一个同级路由声明为止；路由体内的语句缩进更深，不会被误当边界
  const nextMatch = rest.search(/\n {4}const /)
  const block = nextMatch === -1 ? rest : rest.slice(0, nextMatch)
  // 截取范围一旦失控就直接失败，不让测试因为「块太大」而假装通过
  assert.ok(block.length < 12000, `路由块截取异常（${block.length} 字符），断言范围不可信`)
  return block
}

test('asset canvas tables keep node images separate from the character identity layer', () => {
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS asset_nodes \(/)
  assert.match(serverSource, /CREATE TABLE IF NOT EXISTS asset_node_images \(/)
  // 节点表默认 active（生命周期），不是「已完成」这类会被误当结论的状态
  assert.match(
    serverSource,
    /group_key VARCHAR\(255\) DEFAULT NULL,\s+(?:character_identity_lock_json LONGTEXT DEFAULT NULL,\s+)?status VARCHAR\(20\) NOT NULL DEFAULT 'active'/,
  )
  assert.match(serverSource, /uk_scenes_project_episode_no \(project_id, episode_no, scene_no\)/)
  assert.match(serverSource, /ALTER TABLE script_scenes DROP INDEX uk_scenes_project_no/)
  assert.match(serverSource, /ALTER TABLE asset_nodes MODIFY COLUMN group_key VARCHAR\(255\) DEFAULT NULL/)
  assert.ok(
    serverSource.indexOf('ALTER TABLE script_scenes ADD UNIQUE KEY uk_scenes_project_episode_no')
      < serverSource.indexOf('ALTER TABLE script_scenes DROP INDEX uk_scenes_project_no'),
    '多集唯一索引必须先添加，再删除旧索引，避免旧库的外键索引依赖阻塞迁移',
  )
  assert.match(
    serverSource,
    /CONSTRAINT fk_asset_node_images_node_id FOREIGN KEY \(asset_node_id\) REFERENCES asset_nodes\(id\) ON DELETE CASCADE/,
  )
})

test('video assets can be created without a storyboard static frame', () => {
  assert.match(
    serverSource,
    /image_asset_id BIGINT UNSIGNED DEFAULT NULL/,
    '脚本直出视频必须允许没有对应的镜头静帧',
  )
  assert.match(
    serverSource,
    /ALTER TABLE video_assets MODIFY COLUMN image_asset_id BIGINT UNSIGNED DEFAULT NULL/,
  )
})

test('asset node images get their own storage key prefix instead of falling back to storyboards', () => {
  assert.match(
    serverSource,
    /import \{[\s\S]*buildAssetNodeImageStorageKey,[\s\S]*\} from '\.\/services\/frame\.mjs'/,
  )
  // 归属方必须是显式分支：漏一个分支就等于把图写到一个取不回来的键上
  assert.match(serverSource, /if \(ownerType === 'character'\) \{/)
  assert.match(serverSource, /else if \(ownerType === 'asset_node'\) \{/)
  assert.match(serverSource, /else if \(ownerType === 'storyboard'\) \{/)
  assert.match(serverSource, /throw new Error\(`unsupported generated image owner type: \$\{ownerType\}`\)/)
})

test('asset canvas API excludes storyboard nodes and reserves shot production for episode studio', () => {
  const start = serverSource.indexOf('const canvasView = buildAssetCanvasView({')
  const end = serverSource.indexOf('return', start)
  const canvasResponse = serverSource.slice(start, end)

  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.doesNotMatch(canvasResponse, /storyboardNodes|buildStoryboardCanvasNodes|buildStoryboardCanvasRelations/)
  assert.doesNotMatch(canvasResponse, /SELECT s\.id, s\.scene_id/)
})

test('asset node images persist the view set type and existing databases receive the column', () => {
  assert.match(
    serverSource,
    /model_name VARCHAR\(100\) DEFAULT NULL,\s+view_set_type VARCHAR\(40\) NOT NULL DEFAULT 'single',\s+status VARCHAR\(20\)/,
  )
  assert.match(
    serverSource,
    /viewSetType = request\.viewType \|\| 'single'[\s\S]*INSERT INTO asset_node_images[\s\S]*model_name,[\s\S]*view_set_type,[\s\S]*status\)/,
  )
  assert.match(
    serverSource,
    /sql:\s*'ALTER TABLE asset_node_images ADD COLUMN view_set_type VARCHAR\(40\) NOT NULL DEFAULT \\'single\\' AFTER model_name'/,
  )
})

test('character turnaround generation is guarded by the confirmed base image workflow', () => {
  assert.match(serverSource, /getCharacterBaseReferenceImage\(/)
  assert.match(serverSource, /validateCharacterViewGeneration\(/)
  assert.match(serverSource, /const gate = validateCharacterViewGeneration/)
  assert.match(serverSource, /baseReferenceImageUrl/)
  assert.match(serverSource, /error\.statusCode = 409/)
})

test('face closeup is dynamically localized from the confirmed base image before deterministic cropping', () => {
  assert.match(serverSource, /character-face-closeup/)
  assert.match(serverSource, /validateCharacterFaceCloseupConfirmation/)
  assert.match(serverSource, /baseReferenceImageUrl/)
  assert.match(serverSource, /vision-localized-face-crop-v3/)
  assert.match(serverSource, /locateCharacterHeadBounds\(\{[\s\S]*?imageBytes: source\.bytes,[\s\S]*?imageWidth: dimensions\.width,[\s\S]*?imageHeight: dimensions\.height/)
  assert.match(serverSource, /probeMediaDimensions\(sourcePath\)/)
  assert.match(serverSource, /headBox: localization\.headBox/)
  assert.match(serverSource, /脸部特写定位失败/)
  const workerStart = serverSource.indexOf('async function processAssetNodeImageGenerationJob(')
  const workerEnd = serverSource.indexOf('async function resolveLipSyncAvatarProfile(', workerStart)
  const worker = serverSource.slice(workerStart, workerEnd)
  assert.match(worker, /isCharacterDerivedSingle/)
  assert.match(worker, /generateCharacterDerivedCandidate\(/)
  assert.match(worker, /deterministic face closeups are deterministic crops|face closeups are deterministic crops/i)
})

test('scene nine-grid generation is anchored to the passed panorama, never a generated batch mother', () => {
  const sceneGenerationStart = serverSource.indexOf("if (requestedViewType === 'scene-nine-grid' && node.node_type === 'scene')")
  const sceneGenerationEnd = serverSource.indexOf('const requestedCharacterViewKeys', sceneGenerationStart)
  const sceneGeneration = serverSource.slice(sceneGenerationStart, sceneGenerationEnd)
  assert.match(sceneGeneration, /view_set_type = 'single'/)
  assert.match(sceneGeneration, /vision_status IN \('passed', 'skipped'\) OR vision_status IS NULL/)
  assert.match(sceneGeneration, /source_image_id = \?/)
  assert.match(serverSource, /sourceImageId: request\.panoramaImageId/)
})

test('scene space manifests are persisted and passed unchanged into panorama angle generation', () => {
  const normalizedSource = serverSource.replace(/\r\n/g, '\n')
  assert.match(normalizedSource, /spatial_anchors_json LONGTEXT DEFAULT NULL/)
  assert.match(normalizedSource, /column: 'spatial_anchors_json'/)
  assert.match(normalizedSource, /async function ensureSceneSpatialAnchors\(scene\)/)
  assert.match(normalizedSource, /extract: extractSceneSpaceAnchorsWithAgent/)
  assert.match(normalizedSource, /sceneSpatialAnchors = manifest/)
  assert.match(normalizedSource, /sceneSpatialAnchors,/)
  assert.equal(
    (normalizedSource.match(/spatialAnchors: request\.sceneSpatialAnchors/g) || []).length,
    2,
    'batch and individual view workers must both use the same persisted manifest',
  )
  assert.match(normalizedSource, /JSON\.stringify\(spec\.spatial_anchors\)/)
  assert.match(
    normalizedSource,
    /SELECT id, scene_no, title, summary, content, spatial_anchors_json, location, time_of_day[\s\S]{0,180}FROM script_scenes WHERE id = \? AND project_id = \?/u,
    'asset generation must read the persisted scene manifest before resolving anchors',
  )
})

test('failed character turnaround retries preserve the last usable angle while history remains auditable', () => {
  const workerStart = serverSource.indexOf('async function processAssetNodeImageGenerationJob(')
  const workerEnd = serverSource.indexOf('async function resolveLipSyncAvatarProfile(', workerStart)
  const worker = serverSource.slice(workerStart, workerEnd)
  assert.match(worker, /Vision approval only makes a generated image eligible for user adoption/)
  assert.doesNotMatch(
    worker,
    /SET status = 'superseded'[\s\S]*view_set_type = \?[\s\S]*status IN \('candidate', 'confirmed'\)/,
    '视觉检查阶段不能提前替换同一角度的旧确认图',
  )
})

test('the generation worker dispatches asset node image jobs', () => {
  assert.match(serverSource, /row\.job_type === 'asset_node_image'/)
  assert.match(serverSource, /async function enqueueAssetNodeImageJob\(/)
  assert.match(serverSource, /async function processAssetNodeImageGenerationJob\(/)
  assert.match(serverSource, /jobType: 'asset_node_image'/)
  // 任务中心按 job_type 决定 JOIN 哪张表，漏掉就会显示空名字
  assert.match(
    serverSource,
    /LEFT JOIN asset_nodes an ON gj\.job_type = 'asset_node_image' AND an\.id = gj\.source_id/,
  )
})

test('asset character jobs pass their portrait ratio to the actual image provider', () => {
  const worker = serverSource.slice(
    serverSource.indexOf('async function processAssetNodeImageGenerationJob('),
    serverSource.indexOf('async function resolveLipSyncAvatarProfile('),
  )
  assert.match(
    worker,
    /generateFrameCandidates\(\{[\s\S]*?imageRatio:\s*request\.imageRatio \|\| null,[\s\S]*?referenceImageUrls:/,
    '资产 worker 不能只在 request 中记录画幅，必须透传给图片供应商',
  )
  assert.match(
    serverSource,
    /imageRatio: assetPackEnabled[\s\S]*requestedViewType === 'character-face-closeup'[\s\S]*node\.node_type === 'character' \? '9:16' : null,/,
    '角色基础图和三视图都必须固定为竖屏资产画幅',
  )
})

test('character asset-pack requests are decided at enqueue time and survive into the worker contract', () => {
  const enqueueStart = serverSource.indexOf('async function enqueueAssetNodeImageJob(')
  const enqueueEnd = serverSource.indexOf('function seasonEpisodeSceneSpecs(', enqueueStart)
  const enqueue = serverSource.slice(enqueueStart, enqueueEnd)
  const workerStart = serverSource.indexOf('async function processAssetNodeImageGenerationJob(')
  const workerEnd = serverSource.indexOf('async function resolveLipSyncAvatarProfile(', workerStart)
  const worker = serverSource.slice(workerStart, workerEnd)

  assert.match(enqueue, /assetPackEnabled/)
  assert.match(enqueue, /assetPackModel/)
  assert.match(enqueue, /assetPackEnabled,/)
  assert.match(worker, /request\.assetPackEnabled/)
  assert.doesNotMatch(worker, /\bnode\.node_type\b|\bbody\.viewType\b|\bbody\.modelName\b/)
})

test('asset-pack identity checks exclude the crop currently being inspected', () => {
  const workerStart = serverSource.indexOf('async function processAssetNodeImageGenerationJob(')
  const workerEnd = serverSource.indexOf('async function resolveLipSyncAvatarProfile(', workerStart)
  const worker = serverSource.slice(workerStart, workerEnd)
  assert.match(worker, /assetPackReferenceBytesByView/)
  assert.match(worker, /filter\(\(\[key\]\) => key !== imageReferenceKey\)/)
})

test('mock character asset packs materialize a local raster board before splitting views', () => {
  const workerStart = serverSource.indexOf('async function processAssetNodeImageGenerationJob(')
  const workerEnd = serverSource.indexOf('async function resolveLipSyncAvatarProfile(', workerStart)
  const worker = serverSource.slice(workerStart, workerEnd)
  assert.match(worker, /materializeMockCharacterAssetPackBoard/)
  assert.match(worker, /filePath: await materializeMockCharacterAssetPackBoard/)
  assert.match(serverSource, /async function materializeMockCharacterAssetPackBoard\(/)
})

test('asset canvas routes are owner-scoped', () => {
  const routePatterns = [
    String.raw`/^\/api\/projects\/(\d+)\/asset-canvas$/`,
    String.raw`/^\/api\/projects\/(\d+)\/asset-nodes$/`,
    String.raw`/^\/api\/asset-nodes\/(\d+)$/`,
    String.raw`/^\/api\/asset-nodes\/(\d+)\/images$/`,
    String.raw`/^\/api\/asset-nodes\/(\d+)\/images\/generate$/`,
    String.raw`/^\/api\/asset-node-images\/(\d+)\/confirm$/`,
  ]
  for (const pattern of routePatterns) {
    assert.ok(serverSource.includes(pattern), `未找到资产画布路由：${pattern}`)
  }
  assert.match(serverSource, /fetchAssetNodeForUser\(/)
  assert.match(serverSource, /画布节点不存在或无权访问/)
})

test('confirming a canvas image never demotes siblings or rewrites the character identity', () => {
  const block = routeBlock('const assetNodeImageConfirmMatch = pathname.match(')

  // 这是画布存在的理由：同一角色的多个时空形象必须能同时被采用
  assert.doesNotMatch(
    block,
    /UPDATE asset_node_images\s+SET status = 'candidate'/,
    '确认画布形象时不能把同角色其它已确认形象降级',
  )
  // 也不能改写角色身份层：那会推高角色版本并使已确认镜头失效
  assert.doesNotMatch(block, /reference_image_url\s*=/)
  assert.doesNotMatch(block, /ensureCharacterVersion/)
  assert.match(block, /UPDATE asset_node_images SET status = 'confirmed'/)
})

test('confirming a newer panorama supersedes the old base and invalidates its nine-grid derivatives', () => {
  const block = routeBlock('const assetNodeImageConfirmMatch = pathname.match(')
  assert.match(block, /view_set_type = 'single'/)
  assert.match(block, /scene-nine-grid/)
  assert.match(block, /source_image_id/)
})

test('scene nine-grid can retry one failed angle against the confirmed panorama', () => {
  assert.match(serverSource, /requestedViewType === 'scene-nine-grid' && requestedViewKey/)
  assert.match(serverSource, /buildSceneNineGridAnglePrompt\(/)
  assert.match(serverSource, /view_set_type = 'scene-nine-grid'[\s\S]*view_key = \?/)
  assert.match(serverSource, /SCENE_NINE_GRID_ALREADY_GENERATED/)
  const sceneAngleStart = serverSource.indexOf("} else if (isSceneNineGridAngle)")
  const sceneAngleEnd = serverSource.indexOf("} else if (isCharacterDerivedSingle)", sceneAngleStart)
  const sceneAngleBlock = serverSource.slice(sceneAngleStart, sceneAngleEnd)
  assert.match(sceneAngleBlock, /generateFrameCandidates\(/)
  assert.doesNotMatch(sceneAngleBlock, /generateCharacterDerivedCandidate\(/)
  const confirmBlock = routeBlock('const assetNodeImageConfirmMatch = pathname.match(')
  assert.match(confirmBlock, /view_set_type = 'scene-nine-grid'[\s\S]*view_key = \?/)
  assert.match(confirmBlock, /status IN \('candidate', 'confirmed'\)/)
})

test('scene nine-grid batch jobs keep their view-set type when no angle key is supplied', () => {
  assert.match(
    serverSource,
    /viewType:\s*requestedViewType \|\| 'single'/,
    '九宫格整组请求不能因为没有 viewKey 被降级为全景 single 请求',
  )
  assert.doesNotMatch(
    serverSource,
    /viewType:\s*viewPrompt \|\| isCharacterTurnaroundBatch \? requestedViewType : 'single'/,
  )
})

test('scene generation does not block on the optional vision gate', () => {
  assert.match(serverSource, /isSceneVisionCheckEnabled\(\)/)
  assert.match(serverSource, /request\.nodeType !== 'scene'/)
  assert.doesNotMatch(serverSource, /if \(request\.viewType === 'scene-nine-grid' && generatedRows\.some\(.*vision_status === 'failed'/s)
})

test('scene nine-grid vision checks keep the panorama inline instead of falling back to a signed URL', () => {
  assert.match(serverSource, /let sceneReferenceImageBytes = null/)
  assert.match(serverSource, /request\.panoramaStorageKey/)
  assert.match(serverSource, /referenceImageUrl: null/)
  assert.match(serverSource, /referenceImageBytes: image\.view_set_type === 'scene-nine-grid'[\s\S]*sceneReferenceImageBytes/)
  assert.match(serverSource, /场景九宫格母图原始对象不存在，已阻止使用过期签名 URL/)
})

test('confirming a character retry replaces only the adopted angle after review', () => {
  const block = routeBlock('const assetNodeImageConfirmMatch = pathname.match(')
  assert.match(
    block,
    /view_set_type === 'character-turnaround'[\s\S]*view_key = \? AND id <> \? AND status IN \('candidate', 'confirmed'\)/,
  )
  assert.match(block, /A retry stays independent until this request explicitly adopts it/)
})

test('scene-lock readiness keeps the prior confirmed angle active until its retry is confirmed', () => {
  const start = serverSource.indexOf("key: 'scene-agent'")
  const block = serverSource.slice(start, serverSource.indexOf("key: '", start + 10))
  assert.match(block, /WHERE ai\.view_set_type = 'scene-nine-grid'[\s\S]*ai\.status = 'confirmed'[\s\S]*ai\.vision_status IN \('passed', 'skipped'\)/)
})

test('canvas node creation rejects unknown node types instead of guessing one', () => {
  assert.match(serverSource, /const nodeType = normalizeAssetNodeType\(body\.nodeType\)/)
  assert.match(serverSource, /无效的节点类型，只支持 character \/ scene \/ prop \/ material/)
})
