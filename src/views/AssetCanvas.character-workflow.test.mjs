import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./AssetCanvas.vue', import.meta.url), 'utf8')

test('character canvas exposes a chat-style prompt composer for the base image workflow', () => {
  assert.match(source, /class="ac-character-creator"/)
  assert.match(source, /class="ac-chat-composer"/)
  assert.match(source, /剧本角色提示词 · 可编辑/)
  assert.match(source, /剧本角色提示词 · 可编辑/)
  assert.match(source, /生成角色资产板/)
  assert.match(source, /完整角色资产板/)
})

test('character canvas waits for the complete asset board inspection', () => {
  assert.match(source, /视觉检查中/)
  assert.match(source, /viewType === 'single'/)
  assert.match(source, /async function generateCharacterBaseCandidate/)
  assert.match(source, /viewType: 'single'/)
  assert.match(source, /重新生成完整资产板/)
})

test('character generation uses one complete board rather than split derivatives', () => {
  assert.match(source, /viewType: 'single'/)
  assert.match(source, /assetPackEnabled: true/)
  assert.match(source, /角色完整资产板已生成，检查通过后自动替换当前版本/)
  assert.match(source, /const viewType = isSelectedCharacter\.value\s*\? 'single'/)
})

test('group execution keeps scene batching separate from character board generation', () => {
  assert.match(source, /assetPackEnabled: true/)
  assert.match(source, /if \(node\.nodeType === 'character'\) \{[\s\S]*assetPackEnabled: true/)
})

test('selected scene assets use one panorama-anchored nine-grid batch', () => {
  assert.match(source, /if \(plan\.kind === 'scene-views'\)[\s\S]*generateSceneNineGridBatch\(node\.id, base\)/)
  assert.match(source, /selectionProgress\.value\.completed \+= plan\.views\?\.length \|\| 0/)
})

test('scene group execution completes panorama then generates nine independent views in one run', () => {
  assert.match(source, /const panorama = items\.find\(\(item\) => item\.viewSetType === 'single'\)/)
  assert.match(source, /const confirmedPanorama = panorama\.status === 'confirmed'/)
  assert.match(source, /const viewItems = await generateSceneNineGridBatch\(node\.id, confirmedPanorama\)/)
  assert.match(source, /viewItems\.length/)
  assert.doesNotMatch(source, /if \(node\.nodeType === 'scene' && !confirmedPanorama\) \{[\s\S]*continue\n      \}/)
})

test('scene group execution uses only the just-confirmed panorama for nine-grid generation', () => {
  assert.match(source, /if \(!confirmedPanorama \|\| confirmedPanorama\.status !== 'confirmed'\)/)
  assert.match(source, /generateSceneNineGridBatch\(node\.id, confirmedPanorama\)/)
  assert.match(source, /referenceImageId: panorama\.id/)
})

test('character results are automatically adopted after board inspection', () => {
  assert.match(source, /视觉检查通过 · 已自动采用/)
  assert.match(source, /自动替换当前资产并供分镜调用/)
})

test('character results render as one complete asset board', () => {
  assert.match(source, /group\.key === 'character-asset-pack'/)
  assert.doesNotMatch(source, /character-face-closeup|character-turnaround/)
})

test('a character asset board is kept whole and does not launch the legacy closeup follow-up', () => {
  assert.match(source, /const isCharacterAssetPackResult = completedItems\.some\(\(item\) => item\.viewSetType === 'character-asset-pack'\)/)
  assert.doesNotMatch(source, /const shouldAutoGenerateFace/)
  assert.doesNotMatch(source, /autoFaceGenerated/)
  assert.match(source, /角色完整资产板已生成，检查通过后自动替换当前版本/)
  assert.doesNotMatch(source, /角色资产板已生成并拆分为五个独立资产/)
})

test('character board readiness is a single passed-and-adopted contract', () => {
  assert.match(source, /完整角色资产已采用，可供分镜调用/)
})

test('asset board regeneration always releases the loading lock', () => {
  assert.match(source, /async function generateCharacterBaseCandidate\(\)[\s\S]*?finally \{[\s\S]*generatingNodeId\.value = null[\s\S]*generationHint\.value = ''/)
})

test('asset board progress uses one generation status instead of hidden dependent jobs', () => {
  assert.match(source, /正在一次生成角色完整资产板/)
  assert.doesNotMatch(source, /正在定位当前基础图的完整头部/)
  assert.doesNotMatch(source, /face-closeup follow-up/)
})

test('character group execution regenerates one complete asset board without manual adoption', () => {
  const groupFlow = source.slice(source.indexOf('async function onGenerateGroup'))
  assert.match(groupFlow, /assetPackEnabled: node\.nodeType === 'character'/)
  assert.match(groupFlow, /重新生成整组/)
  assert.doesNotMatch(groupFlow, /await confirmAssetNodeImage\(assetPack\.id\)/)
})

test('legacy split character previews are removed from the active character workflow', () => {
  assert.doesNotMatch(source, /viewImageFor|openViewPreview|ac-turnaround-views|ac-face-closeup-result/)
  assert.doesNotMatch(source, /character-face-closeup|character-turnaround/)
})

test('character board exposes automatic adoption status', () => {
  assert.match(source, /视觉检查通过 · 已自动采用/)
  assert.match(source, /重新生成完整资产板/)
})

test('character generation has no independent angle retry entry', () => {
  assert.match(source, /角色资产板生成中/)
  assert.doesNotMatch(source, /async function generateCharacterFaceCloseup\(/)
  assert.doesNotMatch(source, /async function generateCharacterTurnaroundFromBase\(/)
  assert.doesNotMatch(source, /async function regenerateCharacterView\(/)
  assert.doesNotMatch(source, /group\.key === 'character-turnaround'/)
  assert.doesNotMatch(source, /group\.key === 'character-face-closeup'/)
})

test('character generation action label reflects the asset-board workflow', () => {
  assert.match(source, /角色资产板生成中/)
  assert.match(source, /九宫格生成中/)
  assert.doesNotMatch(source, /正在生成角色三视图/)
  assert.doesNotMatch(source, /正在定位当前基础图的完整头部/)
})

test('asset group execution has only character board, scene panorama/views, and prop single-image branches', () => {
  const start = source.indexOf('async function onGenerateGroup')
  const end = source.indexOf('async function onGenerateSelectedNodes', start)
  const flow = source.slice(start, end)
  assert.match(flow, /assetPackEnabled: true/)
  assert.match(flow, /generateSceneNineGridBatch\(node\.id, confirmedPanorama\)/)
  assert.match(flow, /viewType: 'single'/)
  assert.doesNotMatch(flow, /character-turnaround|character-face-closeup|prop-turnaround/)
  assert.doesNotMatch(flow, /generateFaceCloseupFromBase|refreshAssetNodeSnapshot/)
})

test('selected-node batch treats prop-base as a single-image generation plan', () => {
  const start = source.indexOf('async function onGenerateSelectedNodes')
  const end = source.indexOf('\nfunction selectNode', start)
  const flow = source.slice(start, end)
  assert.match(flow, /\['base', 'panorama', 'single', 'prop-base'\]\.includes\(plan\.kind\)/)
  assert.match(flow, /assetPackEnabled: node\.nodeType === 'character'/)
  assert.doesNotMatch(flow, /prop-base[\s\S]{0,500}selectLatestPassedScenePanorama/)
})

test('selected-node batch does not run split character asset derivations', () => {
  const start = source.indexOf('async function onGenerateSelectedNodes')
  const end = source.indexOf('\nfunction selectNode', start)
  const flow = source.slice(start, end)
  assert.doesNotMatch(flow, /character-views|character-turnaround|character-face-closeup/)
})

test('asset results do not render legacy split character or prop-turnaround groups', () => {
  assert.doesNotMatch(source, /ac-turnaround-views/)
  assert.doesNotMatch(source, /ac-face-closeup-result/)
  assert.doesNotMatch(source, /ac-prop-turnaround-results/)
})

test('group actions communicate that they replace the current asset set', () => {
  assert.match(source, /重建整组场景母图与九角度/)
  assert.match(source, /重建每个全景基准及其九角度/)
})

test('character first generation uses one asset-pack action and explains the five derived assets', () => {
  assert.match(source, /完整角色资产板/)
  assert.match(source, /assetPackEnabled: true/)
  assert.match(source, /角色资产板生成中/)
  assert.match(source, /isCharacterAssetPackResult/)
})

test('character asset board renders as one wide non-cropped result with automatic adoption', () => {
  assert.match(source, /group\.key === 'character-asset-pack'/)
  assert.match(source, /ac-character-asset-pack__preview/)
  assert.match(source, /object-fit: contain/)
  assert.match(source, /视觉检查通过 · 已自动采用/)
})

test('character asset board exposes a manual adoption fallback for an already-passed candidate', () => {
  assert.match(source, /采用当前角色资产板/)
  assert.match(source, /group\.latest\.visionStatus === 'passed'/)
  assert.match(source, /@click="adoptAssetImage\(group\.latest\)"/)
})

test('prop results auto-adopt after inspection instead of exposing a second adoption button', () => {
  const propResult = source.slice(source.indexOf('v-else-if="groupPreviewImage(group)"'))
  const propActions = propResult.slice(0, propResult.indexOf("v-if=\"group.key === 'scene-nine-grid'"))
  const reviewStatus = source.slice(source.indexOf('function assetReviewStatus'), source.indexOf('async function retryAssetImageInspection'))
  assert.match(reviewStatus, /视觉检查通过 · 已自动采用/)
  assert.doesNotMatch(propActions, /visionStatus === 'passed'[\s\S]{0,220}@click="adoptAssetImage/)
  assert.doesNotMatch(propActions, /采用当前版本/)
})

test('already adopted prop results do not render a second adoption action', () => {
  const propResult = source.slice(source.indexOf('v-else-if="groupPreviewImage(group)"'))
  const propActions = propResult.slice(0, propResult.indexOf("v-if=\"group.key === 'scene-nine-grid'"))
  assert.doesNotMatch(propActions, /adoptAssetImage/)
  assert.match(propActions, /retryAssetImageInspection/)
})

test('blank inspector gives a direct route to pending scene panorama adoption', () => {
  assert.match(source, /pendingScenePanoramaAdoption/)
  assert.match(source, /查看场景全景并采用/)
  assert.match(source, /selectNode\(pendingScenePanoramaAdoption\.node\)/)
})

test('prop group actions use prop terminology', () => {
  assert.match(source, /const selectedGroupTypeLabel = computed\(\(\) => \{[\s\S]*return '道具组'/)
  assert.match(source, /重新生成整组道具资产/)
})

test('character canvas maps explicitly labelled legacy boards into the current asset-board workflow', () => {
  assert.match(source, /isCharacterAssetPackImage/)
  assert.doesNotMatch(source, /基础图视觉检查中/)
  assert.doesNotMatch(source, /三视图\s*[·•]/)
})

test('asset-pack completion does not launch the legacy face-closeup follow-up', () => {
  assert.match(source, /const isCharacterAssetPackResult =/)
  assert.match(source, /selectedCharacterAssetPackReady/)
})

test('asset-pack readiness requires only the adopted passed board', () => {
  const start = source.indexOf('const selectedCharacterAssetPackReady')
  const block = source.slice(start, source.indexOf('const selectedSceneNineGridImages', start))
  assert.match(block, /image\.status === 'confirmed'/)
  assert.match(block, /image\.visionStatus === 'passed'/)
  assert.match(block, /character-asset-pack/)
})

test('confirmed base image can be regenerated and replaces the current image', () => {
  assert.match(source, /重新生成完整资产板/)
  assert.doesNotMatch(source, /不能重复生成基础图/)
})

test('scene panorama exposes an independent retry action after a candidate or confirmation', () => {
  assert.match(source, /async function regenerateScenePanorama\(\)/)
  assert.match(source, /重新生成全景基准图/)
  assert.match(source, /viewType: 'single'/)
  assert.match(source, /group\.key === 'single' && isSelectedScene/)
})

test('scene panorama retry keeps the previous adopted version and never auto-generates nine angles', () => {
  const start = source.indexOf('async function regenerateScenePanorama()')
  const end = source.indexOf('async function regenerateSceneView(', start)
  const flow = source.slice(start, end)
  assert.match(flow, /旧全景基准保留/)
  assert.match(flow, /确认采用后才会替换/)
  assert.doesNotMatch(flow, /confirmAssetNodeImage\(/)
  assert.doesNotMatch(flow, /generateSceneNineGridBatch\(/)
})

test('scene nine-grid has one batch action, a locked state, and per-angle retries', () => {
  assert.match(source, /async function regenerateSceneView\(/)
  assert.match(source, /重新生成此角度/)
  assert.match(source, /九个角度已生成/)
  assert.match(source, /ac-scene-nine-grid-view__retry/)
  assert.doesNotMatch(source, /class="ac-derivative-action"[\s\S]{0,1000}class="burning-orange-btn ac-primary-btn w-full justify-center"/)
})

test('asset canvas exposes explicit derivative actions after base results', () => {
  assert.match(source, /生成九宫格/)
  assert.match(source, /根据已采用全景生成九个独立机位/)
  assert.match(source, /场景结构提示词/)
  assert.match(source, /场景结构提示词/)
})

test('scene inspector treats the old placeholder as missing and hydrates the Agent prompt', () => {
  assert.match(source, /scenePromptPlaceholder/)
  assert.match(source, /node\.promptText\.trim\(\) === scenePromptPlaceholder/)
  assert.match(source, /hydrateAssetNodePrompt\(node\.id\)/)
  assert.doesNotMatch(source, /return '场景空间结构待补充：请描述地点、时代、建筑结构、主要物件位置、门窗方向、光线方向和剧情功能。'/)
})

test('scene prompt recovery has a backend read-time fallback for stale nodes', () => {
  assert.match(source, /hydrateAssetNodePrompt\(node\.id\)/)
})

test('character nodes hydrate stale costume placeholders without overwriting edits', () => {
  assert.match(source, /characterPromptPlaceholder/)
  assert.match(source, /node\.promptText\.includes\(characterPromptPlaceholder\)/)
  assert.match(source, /node\.nodeType === 'character'/)
})

test('character turnaround flow sends one missing view key at a time', () => {
  assert.match(source, /const viewType = isSelectedCharacter\.value\s*\? 'single'/)
  assert.doesNotMatch(source, /viewKeys: missingViews|viewType: 'character-turnaround'/)
})

test('character group header exposes a state selection action beside the grouped assets', () => {
  assert.match(source, /ac-group__action/)
  assert.match(source, /选中状态/)
  assert.match(source, /handleGroupTurnaroundClick/)
})

test('asset canvas delegates voice binding to the storyboard instead of exposing asset voice controls', () => {
  assert.doesNotMatch(source, /角色音色/)
  assert.doesNotMatch(source, /绑定并锁定/)
  assert.doesNotMatch(source, /上传参考音频/)
  assert.doesNotMatch(source, /listVoiceProfiles/)
})

test('asset canvas exposes a repeatable tidy layout action for grouped nodes', () => {
  assert.match(source, /async function autoArrangeCanvas/)
  assert.match(source, /updateAssetNode\(position\.id, \{[\s\S]*?x: position\.x/)
  assert.match(source, /autoArrangeCanvas/)
  assert.match(source, /整齐排版/)
})

test('scene nine-grid renders the mother image and nine independent view cards', () => {
  assert.match(source, /groupPreviewImage\(group\)/)
  assert.match(source, /selectedSceneNineGridSlots/)
  assert.match(source, /aria-label="场景九宫格九个独立视角"/)
  assert.doesNotMatch(source, /确认此视角/)
  assert.match(source, /重新生成此角度/)
})

test('scene nine-grid canvas keeps the source and views compact and the result cards resilient', () => {
  assert.match(source, /const originX = node\.x \+ node\.width \+ 120/)
  assert.match(source, /originX \+ 244 \+ \(index % 3\) \* 176/)
  assert.match(source, /grid-template-columns: repeat\(3, minmax\(150px, 1fr\)\)/)
  assert.match(source, /\.ac-scene-nine-grid-view__retry \{[\s\S]*?width: 100%[\s\S]*?white-space: normal/)
  assert.match(source, /@media \(max-width: 900px\)[\s\S]*?\.ac-scene-nine-grid-results[\s\S]*?repeat\(2, minmax\(0, 1fr\)/)
})

test('asset canvas is limited to project assets and links to the episode video workflow', () => {
  assert.doesNotMatch(source, /storyboardNodes = computed/)
  assert.doesNotMatch(source, /ac-storyboard-node/)
  assert.doesNotMatch(source, /openStoryboardNode/)
  assert.match(source, /function openEpisodeWorkbench\(\)/)
  assert.match(source, /@click="openEpisodeWorkbench"/)
  assert.match(source, /分镜与视频/)
  assert.match(source, /workspace\/episodes/)
})
