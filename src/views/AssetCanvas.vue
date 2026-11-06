<script setup lang="ts">
/**
 * @file 资产画布
 * @description
 * 一张可平移缩放的无限画布，承载角色、场景、道具与素材组。
 *
 * 组和节点都来自后端同一份资产画布 DTO：
 * - 组负责表达稳定分类与整组操作
 * - 节点负责承载具体时空状态、三视图、全景和九宫格结果
 * - 没有图的节点仍保留为待补充，不把声明状态冒充成生成完成
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import AssetNodeCard from '@/components/canvas/AssetNodeCard.vue'
import {
  createAssetNode,
  confirmAssetNodeImage,
  inspectAssetNodeImage,
  deleteAssetNode,
  generateAssetNodeImages,
  getAssetCanvas,
  getGenerationJob,
  hydrateAssetNodePrompt,
  getProject,
  listCharacters,
  updateAssetNode,
  type AssetCanvasDTO,
  type AssetNodeDTO,
  type AssetNodeImageDTO,
  type AssetNodeType,
  type CharacterDTO,
  type ProjectDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'
import {
  groupAssetNodeImages,
  hasCompleteSceneNineGridBatch,
  selectSceneNineGridBatch,
  selectSceneNineGridAttempts,
  type AssetImageGroup,
} from '@/lib/asset-image-groups'
import { countAssetImageGroupResults, countAssetImageGroupsResults } from '@/lib/asset-result-counts'
import { getAssetNodeGenerationPlan, nodesIntersectingSelection } from '@/lib/asset-canvas-selection'

function selectLatestPassedScenePanorama(images: AssetNodeImageDTO[]): AssetNodeImageDTO | null {
  return images
    .filter((image) => image.viewSetType === 'single')
    .filter((image) => image.status !== 'failed' && image.status !== 'superseded')
    .filter((image) => image.visionStatus !== 'failed')
    .filter((image) => ['passed', 'skipped', ''].includes(image.visionStatus || ''))
    .sort((left, right) => right.id - left.id)[0] || null
}

type PageState = 'missing-project' | 'loading' | 'empty' | 'ready' | 'error'
type TypeFilter = 'all' | AssetNodeType
type ToastTone = 'info' | 'error'
type CanvasMode = 'pan' | 'select'

const MIN_SCALE = 0.35
const MAX_SCALE = 2.4
const NODE_DEFAULT_WIDTH = 220
const NODE_DEFAULT_HEIGHT = 260
const GROUP_PADDING = 26
const GROUP_HEADER_HEIGHT = 88
const TYPE_LAYOUT_ORDER: Record<string, number> = {
  character: 0,
  scene: 1,
  prop: 2,
  material: 2,
}
const TYPE_SECTION_GAP = 148

const TYPE_LABELS: Record<AssetNodeType, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  material: '素材',
}

const route = useRoute()
const router = useRouter()

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const canvas = ref<AssetCanvasDTO | null>(null)
const characters = ref<CharacterDTO[]>([])
const errorMsg = ref('')
const activeType = ref<TypeFilter>('all')
const selectedNodeId = ref<number | null>(null)
const selectedNodeIds = ref<number[]>([])
const canvasMode = ref<CanvasMode>('pan')
const creating = ref(false)
const characterPickerOpen = ref(false)
const deletingNode = ref(false)

/** 正在生成形象的节点 ID */
const generatingNodeId = ref<number | null>(null)
const generatingGroup = ref(false)
const generatingSelection = ref(false)
const selectionProgress = ref({ completed: 0, total: 0 })
const generatingViewSet = ref<'scene-nine-grid' | null>(null)
const generationProgress = ref(0)
const generationHint = ref('')
let generationTimer: ReturnType<typeof setTimeout> | null = null

const toast = ref<{ text: string; tone: ToastTone } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null
const previewImage = ref<AssetNodeImageDTO | null>(null)

/** 检查器的保存状态，避免出现「看起来保存了其实没保存」 */
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')

const stageEl = ref<HTMLElement | null>(null)
const labelInput = ref<HTMLInputElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)

const view = reactive({ x: 40, y: 40, scale: 1 })
const panState = ref<{ clientX: number; clientY: number; originX: number; originY: number } | null>(
  null,
)
const dragState = ref<{
  nodeId: number
  clientX: number
  clientY: number
  originX: number
  originY: number
  moved: boolean
} | null>(null)
const selectionRect = ref<{
  startX: number
  startY: number
  currentX: number
  currentY: number
} | null>(null)

const inspectorForm = reactive({
  label: '',
  appearanceLabel: '',
  promptText: '',
  turnaroundPromptText: '',
  negativePrompt: '',
})

const scenePromptPlaceholder = '场景空间结构待补充：请描述地点、时代、建筑结构、主要物件位置、门窗方向、光线方向和剧情功能。'
const sceneNineGridViewKeys = ['front-left', 'front', 'front-right', 'left', 'center', 'right', 'back-left', 'back', 'back-right'] as const
const sceneNineGridViewLabels = ['左前方', '正前方', '右前方', '左侧面', '正中', '右侧面', '左后方', '正后方', '右后方'] as const
const characterPromptPlaceholder = '固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理，生成前必须补齐'
const failedCandidateImages = ref<Record<number, boolean>>({})
const candidateImageSources = ref<Record<number, string[]>>({})
const inspectingAssetImageIds = ref<number[]>([])

const allNodes = computed<AssetNodeDTO[]>(() => canvas.value?.nodes || [])

const tabs = computed(() => {
  const byType = canvas.value?.summary.byType
  return [
    { key: 'all' as TypeFilter, label: '全部', count: canvas.value?.summary.total || 0 },
    { key: 'character' as TypeFilter, label: '角色', count: byType?.character || 0 },
    { key: 'scene' as TypeFilter, label: '场景', count: byType?.scene || 0 },
    { key: 'prop' as TypeFilter, label: '道具', count: byType?.prop || 0 },
    { key: 'material' as TypeFilter, label: '素材', count: byType?.material || 0 },
  ]
})

const visibleNodes = computed(() =>
  activeType.value === 'all'
    ? allNodes.value
    : allNodes.value.filter((node) => node.nodeType === activeType.value),
)

const assetRelations = computed(() => {
  const nodeMap = new Map<number, { x: number; y: number; width: number; height: number }>(
    visibleNodes.value.map((node) => [node.id, node]),
  )
  return (canvas.value?.relations || []).flatMap((relation) => {
    const from = nodeMap.get(relation.fromNodeId)
    const to = nodeMap.get(relation.toNodeId)
    if (!from || !to) return []
    return [{
      ...relation,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x + to.width / 2,
      y2: to.y + to.height / 2,
    }]
  })
})

const canvasNodesForFit = computed(() => visibleNodes.value)

const selectedNode = computed<AssetNodeDTO | null>(
  () => allNodes.value.find((node) => node.id === selectedNodeId.value) || null,
)
const pendingScenePanoramaAdoption = computed(() => {
  for (const node of allNodes.value) {
    if (node.nodeType !== 'scene') continue
    const panorama = groupAssetNodeImages(node.images, node.nodeType)
      .find((group) => group.key === 'single')?.latest || null
    if (panorama && panorama.status !== 'confirmed' && panorama.visionStatus === 'skipped'
      && (panorama.imageUrl || panorama.thumbnailUrl)) {
      return { node, image: panorama }
    }
  }
  return null
})
const selectedCanvasNodes = computed(() =>
  allNodes.value.filter((node) => selectedNodeIds.value.includes(node.id)),
)
const selectionBoxStyle = computed(() => {
  const rect = selectionRect.value
  if (!rect) return {}
  const left = Math.min(rect.startX, rect.currentX)
  const top = Math.min(rect.startY, rect.currentY)
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.abs(rect.currentX - rect.startX)}px`,
    height: `${Math.abs(rect.currentY - rect.startY)}px`,
  }
})
const selectedCharacter = computed(() =>
  selectedNode.value?.refId ? characters.value.find((item) => item.id === selectedNode.value?.refId) || null : null,
)

function isCharacterAssetPackImage(image: AssetNodeImageDTO | null | undefined): boolean {
  if (!image) return false
  if (image.viewSetType === 'character-asset-pack') return true
  if (image.viewSetType !== 'single') return false
  const marker = `${image.viewLabel || ''}\n${image.promptSnapshot || ''}`
  return /角色资产板|完整角色资产板|character\s+asset\s+board/i.test(marker)
}

function normalizeCharacterAssetPackImage(image: AssetNodeImageDTO): AssetNodeImageDTO {
  return isCharacterAssetPackImage(image)
    ? { ...image, viewSetType: 'character-asset-pack', viewKey: null, viewIndex: null, viewLabel: '角色资产板' }
    : image
}

const selectedResultGroups = computed(() =>
  selectedNode.value
    ? groupAssetNodeImages(
        selectedNode.value.images.map((image) =>
          selectedNode.value?.nodeType === 'character' ? normalizeCharacterAssetPackImage(image) : image,
        ),
        selectedNode.value.nodeType,
        selectedNode.value.confirmedImage,
      ).filter((group) => selectedNode.value?.nodeType !== 'character'
        || group.key === 'character-asset-pack')
        .filter((group) => !['prop', 'material'].includes(String(selectedNode.value?.nodeType))
          || group.key === 'single')
    : [],
)
const selectedPanoramaImage = computed(() => {
  return selectedResultGroups.value.find((group) => group.key === 'single')?.latest || null
})
const selectedConfirmedPanorama = computed(() => {
  return selectedResultGroups.value.find((group) => group.key === 'single')?.confirmed || null
})
const selectedNineGridImage = computed(() => {
  return selectedResultGroups.value.find((group) => group.key === 'scene-nine-grid')?.latest || null
})
const selectedCharacterAssetPackGroup = computed(() =>
  selectedResultGroups.value.find((group) => group.key === 'character-asset-pack') || null,
)
const selectedCharacterAssetPackImage = computed(() =>
  selectedCharacterAssetPackGroup.value?.latest
  || selectedCharacterAssetPackGroup.value?.confirmed
  || null,
)
const selectedCharacterAssetPackReady = computed(() => {
  if (!isSelectedCharacter.value) return false
  const images = selectedNode.value?.images || []
  return images.some((image) => (image.viewSetType === 'character-asset-pack' || isCharacterAssetPackImage(image))
    && image.status === 'confirmed'
    && image.visionStatus === 'passed'
    && Boolean(image.imageUrl || image.thumbnailUrl))
})
const selectedSceneNineGridImages = computed(() =>
  selectSceneNineGridAttempts(
    selectSceneNineGridBatch(
      selectedNode.value?.images,
      selectedConfirmedPanorama.value?.id,
    ),
  ),
)
const selectedSceneNineGridSlots = computed(() => Array.from({ length: 9 }, (_, index) =>
  selectedSceneNineGridImages.value.find((image) => Number(image.viewIndex) === index + 1) || null,
))
const selectedSceneNineGridGenerated = computed(() => hasCompleteSceneNineGridBatch(
  selectedNode.value?.images,
  selectedConfirmedPanorama.value?.id,
))

function resolvedAssetImageUrl(image: AssetNodeImageDTO | null | undefined): string {
  if (!image) return ''
  if (image.status === 'failed' || image.visionStatus === 'failed') return ''
  return image.imageUrl || image.thumbnailUrl || ''
}

function sceneNineGridAttemptLabel(image: AssetNodeImageDTO | null | undefined): string {
  if (!image) return '待生成'
  if (image.status === 'failed' || image.visionStatus === 'failed') return '生成失败'
  if (!resolvedAssetImageUrl(image)) return '等待图片'
  if (image.visionStatus === 'skipped') return image.status === 'confirmed' ? '已采用 · 未检查' : '未检查 · 待采用'
  if (image.visionStatus !== 'passed') return '视觉检查中'
  return image.status === 'confirmed' ? '已采用' : '待采用'
}

function canAdoptCurrentAsset(image: AssetNodeImageDTO | null | undefined): boolean {
  if (image?.visionStatus === 'passed') return true
  return selectedNode.value?.nodeType === 'scene' && image?.visionStatus === 'skipped'
}

function assetReviewStatus(image: AssetNodeImageDTO): string {
  if (image.status === 'confirmed' && image.visionStatus === 'passed') return '视觉检查通过 · 已自动采用'
  if (image.visionStatus === 'pending') return '视觉检查中 · 可重试'
  if (image.visionStatus === 'failed') return '视觉检查失败 · 重新检查或生成'
  if (selectedNode.value?.nodeType === 'scene' && image.visionStatus === 'skipped') {
    return image.status === 'confirmed' ? '已采用 · 视觉检查未运行' : '未检查 · 待人工采用'
  }
  return image.visionStatus === 'passed'
    ? ['prop', 'material'].includes(String(selectedNode.value?.nodeType || ''))
      ? '视觉检查通过 · 已自动采用'
      : image.status === 'confirmed' ? '视觉检查通过 · 已采用' : '视觉检查通过 · 待采用'
    : '等待视觉检查'
}

async function retryAssetImageInspection(image: AssetNodeImageDTO): Promise<void> {
  if (!image?.id || inspectingAssetImageIds.value.includes(image.id)) return
  inspectingAssetImageIds.value = [...inspectingAssetImageIds.value, image.id]
  try {
    const updated = await inspectAssetNodeImage(image.id)
    await loadCanvas()
    selectedNodeId.value = image.assetNodeId
    if (updated.status === 'confirmed' && updated.visionStatus === 'passed') {
      showToast(image.viewSetType === 'character-asset-pack'
        ? '角色资产板检查通过，已自动替换并采用完整角色资产'
        : '视觉检查通过，道具已自动采用')
    } else if (updated.visionStatus === 'failed') {
      showToast(updated.visionReason || '视觉检查未通过，请重新生成', 'error')
    } else {
      showToast('视觉检查仍在处理中，可稍后重试检查')
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : '视觉检查重试失败', 'error')
  } finally {
    inspectingAssetImageIds.value = inspectingAssetImageIds.value.filter((id) => id !== image.id)
  }
}

const sceneNineGridCanvasGroups = computed(() => visibleNodes.value
  .filter((node) => node.nodeType === 'scene')
  .flatMap((node) => {
    const groups = groupAssetNodeImages(node.images, node.nodeType)
    const panorama = groups.find((group) => group.key === 'single')?.confirmed
      || groups.find((group) => group.key === 'single')?.latest
      || null
    const views = selectSceneNineGridAttempts(
      groups.find((group) => group.key === 'scene-nine-grid')?.images,
    )
    if (!panorama && !views.length) return []
    const originX = node.x + node.width + 120
    const originY = node.y
    return [{
      nodeId: node.id,
      label: node.label,
      source: panorama,
      views: sceneNineGridViewKeys.map((viewKey, index) => {
        const image = views.find((item) => item.viewKey === viewKey) || null
        return {
          image,
          viewKey,
          label: sceneNineGridViewLabels[index],
          x: originX + 244 + (index % 3) * 176,
          y: originY + (Math.floor(index / 3) * 168),
        }
      }),
      sourceX: originX,
      sourceY: originY + 140,
    }]
  }))
const sceneNineGridCanvasRelations = computed(() => sceneNineGridCanvasGroups.value.flatMap((group) =>
  group.views.map((view) => ({
    id: `${group.nodeId}:${view.viewKey}`,
    sourceImageId: group.source?.id || null,
    viewImageId: view.image?.id || null,
    viewKey: view.viewKey,
    x1: group.sourceX + 108,
    y1: group.sourceY,
    x2: view.x + 82,
    y2: view.y + 76,
  })),
))
const selectedCharacterPreviewImage = computed(() =>
  selectedCharacterAssetPackGroup.value?.confirmed
  || selectedCharacterAssetPackGroup.value?.latest
  || null,
)
const sceneViewSetHint = computed(() => {
  if (!isSelectedScene.value) return ''
  if (selectedConfirmedPanorama.value) {
    return selectedSceneNineGridGenerated.value
      ? '全景基准已采用，九宫格已生成；问题角度可单独重试。'
      : '全景基准已采用，可以生成同一空间的九宫格多角度图。'
  }
   if (selectedPanoramaImage.value) return '全景基准已生成，可继续生成同一空间的九宫格。'
   return '先生成一张场景全景基准图，确认后生成九宫格。'
})
const isSelectedScene = computed(() => selectedNode.value?.nodeType === 'scene')
const isSelectedCharacter = computed(() => selectedNode.value?.nodeType === 'character')
const isSelectedProp = computed(() => ['prop', 'material'].includes(selectedNode.value?.nodeType || ''))
const selectedNodeModeLabel = computed(() => {
  if (isSelectedScene.value) return '场景锁定'
  if (isSelectedCharacter.value) return '角色状态'
  return '资产提示'
})
const characterWorkflowLabel = computed(() => {
  if (!isSelectedCharacter.value) return ''
  if (selectedCharacterAssetPackReady.value) return '完整角色资产已采用，可供分镜调用'
  if (selectedCharacterAssetPackImage.value?.visionStatus === 'failed') return '资产板检查未通过，当前采用版本未变'
  if (selectedCharacterAssetPackImage.value) return '正在检查资产板，通过后自动采用'
  return '生成包含全身、脸部和三视图的角色资产板'
})

function candidateSources(image: { id: number; thumbnailUrl?: string | null; imageUrl?: string | null }) {
  const current = candidateImageSources.value[image.id]
  if (current?.length) return current
  return [...new Set([image.imageUrl, image.thumbnailUrl].filter((value): value is string => Boolean(value)))]
}

function onCandidateImageError(image: { id: number; thumbnailUrl?: string | null; imageUrl?: string | null }): void {
  const sources = candidateSources(image)
  if (sources.length > 1) {
    candidateImageSources.value[image.id] = sources.slice(1)
    return
  }
  failedCandidateImages.value[image.id] = true
}

function groupPreviewImage(group: AssetImageGroup<AssetNodeImageDTO>): AssetNodeImageDTO | null {
  if (group.key === 'scene-nine-grid') {
    return group.images.find((image) => !image.viewKey && image.viewLabel === '九宫格母图')
      || group.images.find((image) => !image.viewKey)
      || group.latest
      || null
  }
  return group.latest || null
}

function groupStatusText(group: AssetImageGroup): string {
  if (!group.latest) return '待生成'
  if (selectedNode.value?.nodeType === 'scene' && group.latest.visionStatus === 'skipped') {
    const allAdopted = group.key === 'scene-nine-grid'
      ? group.images.length === 9 && group.images.every((image) => image.status === 'confirmed')
      : Boolean(group.confirmed)
    return allAdopted ? '已采用 · 未检查' : '未检查 · 待人工采用'
  }
  if (group.confirmed) return '已采用'
  return group.images.some((image) => String(image.visionStatus || '').toLowerCase() === 'pending')
    ? '视觉检查中'
    : '当前版本'
}

function groupStatusTone(group: AssetImageGroup): string {
  if (!group.latest) return 'is-pending'
  if (selectedNode.value?.nodeType === 'scene' && group.key === 'scene-nine-grid'
    && group.images.length === 9 && group.images.every((image) => image.status === 'confirmed')) return 'is-confirmed'
  if (group.confirmed) return 'is-confirmed'
  return 'is-ready'
}

function resultGroupImageCount(group: AssetImageGroup<AssetNodeImageDTO>): number {
  return countAssetImageGroupResults(group)
}

function scrollToResults(): void {
  void nextTick(() => {
    resultsEl.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

async function adoptAssetImage(image: AssetNodeImageDTO): Promise<void> {
  if (!image?.id || image.status === 'confirmed' || !canAdoptCurrentAsset(image)) return
  try {
    await confirmAssetNodeImage(image.id)
    await loadCanvas()
    selectedNodeId.value = image.assetNodeId
    showToast(image.visionStatus === 'skipped'
      ? '已人工采用场景版本；该图未经过视觉模型检查'
      : '已采用当前版本，旧版本仍保留在后台历史记录')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '采用当前版本失败', 'error')
  }
}

async function generateCharacterBaseCandidate(): Promise<void> {
  const node = selectedNode.value
  if (!node || !isSelectedCharacter.value || generatingNodeId.value) return

  await saveInspector()
  generatingNodeId.value = node.id
  generatingViewSet.value = null
  generationProgress.value = 0
    generationHint.value = '正在根据最新提示词重新生成完整角色资产板'
  try {
    const job = await generateAssetNodeImages(node.id, {
      prompt: inspectorForm.promptText,
      candidateCount: 1,
      viewType: 'single',
      assetPackEnabled: true,
    })
    generationProgress.value = job.progressPercent
    generationHint.value = '基础图重生成任务已进入后台队列'
    const completed = await waitForGenerationJob(job.id, (progressJob) => {
      generationProgress.value = progressJob.progressPercent
      generationHint.value = progressJob.status === 'queued'
      ? '完整角色资产板重生成任务排队中'
        : `正在生成完整角色资产板 · ${progressJob.progressPercent}%`
    })
    await loadCanvas()
    selectedNodeId.value = node.id
    const completedItems = (completed.result?.items || []) as AssetNodeImageDTO[]
    await loadCanvas()
    selectedNodeId.value = node.id
    scrollToResults()
    const isCharacterAssetPackResult = completedItems.some((item) => item.viewSetType === 'character-asset-pack')
    if (isCharacterAssetPackResult) showToast('角色资产板已生成并自动开始完整性检查；通过后会替换当前采用版本')
    else showToast('角色资产板已生成，正在等待完整性检查')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '重新生成基础图失败', 'error')
  } finally {
    generatingNodeId.value = null
    generatingViewSet.value = null
    generationHint.value = ''
  }
}

async function refreshAssetNodeSnapshot(nodeId: number): Promise<AssetNodeDTO | null> {
  const latestCanvas = await getAssetCanvas(projectId.value)
  canvas.value = latestCanvas
  return latestCanvas.nodes.find((item) => item.id === nodeId) || null
}

const SCENE_NINE_GRID_KEYS = [
  'front-left', 'front', 'front-right',
  'left', 'center', 'right',
  'back-left', 'back', 'back-right',
] as const

async function generateSceneNineGridBatch(
  nodeId: number,
  panorama: AssetNodeImageDTO,
): Promise<AssetNodeImageDTO[]> {
  const referenceImageUrl = panorama.imageUrl || panorama.thumbnailUrl || null
  if (!referenceImageUrl) throw new Error('场景全景基准没有可用图片地址，无法生成九宫格')
  const job = await generateAssetNodeImages(nodeId, {
    prompt: '',
    candidateCount: 1,
    viewType: 'scene-nine-grid',
    referenceImageUrl,
    referenceImageId: panorama.id,
  })
  const completed = await waitForGenerationJob(job.id)
  const items = (completed.result?.items || []) as AssetNodeImageDTO[]
  const views = items.filter((item) => item.viewSetType === 'scene-nine-grid' && item.viewKey)
  const sourceMismatch = views.filter((item) => Number(item.sourceImageId || 0) !== Number(panorama.id))
  const versions = new Set(views.map((item) => Number(item.viewSetVersion || item.versionNo || 0)))
  const keys = new Set(views.map((item) => item.viewKey))
  const missing = SCENE_NINE_GRID_KEYS.filter((key) => !keys.has(key))
  const failed = views.filter((item) => !['passed', 'skipped'].includes(item.visionStatus || ''))
  if (views.length !== SCENE_NINE_GRID_KEYS.length || keys.size !== SCENE_NINE_GRID_KEYS.length || versions.size !== 1 || sourceMismatch.length || missing.length || failed.length) {
    const details = [
      missing.length ? `缺少 ${missing.join('、')}` : '',
      failed.length ? `视觉未通过 ${failed.map((item) => item.viewKey).join('、')}` : '',
      sourceMismatch.length ? '母图绑定不一致' : '',
      versions.size !== 1 ? '批次号不一致' : '',
    ].filter(Boolean).join('；')
    throw new Error(`场景「九宫格」未完成 9/9${details ? `：${details}` : ''}`)
  }
  return views
}

function latestPassedCharacterBase(nodeId: number): AssetNodeImageDTO | null {
  const node = allNodes.value.find((item) => item.id === nodeId)
  if (!node || node.nodeType !== 'character') return null
  const base = groupAssetNodeImages<AssetNodeImageDTO>(node.images, node.nodeType)
    .find((group) => group.key === 'single')
  const latest = base?.latest || null
  if (latest && ['passed', 'skipped'].includes(latest.visionStatus || '') && (latest.imageUrl || latest.thumbnailUrl)) return latest
  const confirmed = base?.confirmed || null
  return confirmed && ['passed', 'skipped'].includes(confirmed.visionStatus || '') && (confirmed.imageUrl || confirmed.thumbnailUrl)
    ? confirmed
    : null
}

async function regenerateScenePanorama(): Promise<void> {
  const node = selectedNode.value
  if (!node || !isSelectedScene.value || generatingNodeId.value) return

  await saveInspector()
  generatingNodeId.value = node.id
  generatingViewSet.value = null
  generationProgress.value = 0
  generationHint.value = '正在生成新的场景全景候选；旧全景基准保留'
  try {
    const job = await generateAssetNodeImages(node.id, {
      prompt: inspectorForm.promptText,
      candidateCount: 1,
      viewType: 'single',
    })
    generationProgress.value = job.progressPercent
    generationHint.value = '新的全景候选已进入后台队列，确认采用后才会替换当前基准'
    await waitForGenerationJob(job.id)
    await loadCanvas()
    selectedNodeId.value = node.id
    showToast('新全景候选已生成；当前基准保持不变，采用后再生成所需机位')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '重新生成场景全景失败', 'error')
  } finally {
    generatingNodeId.value = null
    generatingViewSet.value = null
    generationHint.value = ''
  }
}

async function regenerateSceneView(viewKey: typeof sceneNineGridViewKeys[number]): Promise<void> {
  const node = selectedNode.value
  const panorama = selectedConfirmedPanorama.value
  if (!node || !isSelectedScene.value || !panorama || generatingNodeId.value) return

  generatingNodeId.value = node.id
  generatingViewSet.value = 'scene-nine-grid'
  generationProgress.value = 0
  const label = sceneNineGridViewLabels[sceneNineGridViewKeys.indexOf(viewKey)]
  generationHint.value = `正在根据已锁定全景重新生成${label}场景角度`
  try {
    const job = await generateAssetNodeImages(node.id, {
      prompt: '',
      candidateCount: 1,
      viewType: 'scene-nine-grid',
      viewKey,
      referenceImageUrl: panorama.imageUrl || panorama.thumbnailUrl || null,
      referenceImageId: panorama.id,
    })
    generationProgress.value = job.progressPercent
    await waitForGenerationJob(job.id)
    await loadCanvas()
    selectedNodeId.value = node.id
     showToast(`${label}角度已重新生成，可在当前版本中采用`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '场景角度重试失败', 'error')
  } finally {
    generatingNodeId.value = null
    generatingViewSet.value = null
    generationHint.value = ''
  }
}

/**
 * 同一角色的多个形象归成一组，用铜色细框圈起来。
 * 只有 2 个以上才画框：一个节点的框只是噪音。
 */
const groups = computed(() => {
  const visibleNodeMap = new Map(visibleNodes.value.map((node) => [node.id, node]))

  return (canvas.value?.groups || []).flatMap((group) => {
    const list = group.nodeIds
      .map((nodeId) => visibleNodeMap.get(nodeId))
      .filter((node): node is AssetNodeDTO => Boolean(node))
    if (!list.length) return []

    const minX = Math.min(...list.map((node) => node.x)) - GROUP_PADDING
    const minY = Math.min(...list.map((node) => node.y)) - GROUP_PADDING - GROUP_HEADER_HEIGHT
    const maxX = Math.max(...list.map((node) => node.x + node.width)) + GROUP_PADDING
    const maxY = Math.max(...list.map((node) => node.y + node.height)) + GROUP_PADDING

    return [{
      ...group,
      nodeCount: list.length,
      label: `${group.typeLabel}组 · ${group.label}`,
      detail: `${list.length} 个${group.nodeType === 'scene' ? '固定视角' : group.nodeType === 'character' ? '状态节点' : '资产节点'}`,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    }]
  })
})

const selectedGroup = computed(() => {
  const nodeId = selectedNode.value?.id
  if (!nodeId) return null
  return (canvas.value?.groups || []).find((group) => group.nodeIds.includes(nodeId)) || null
})

const selectedGroupNodes = computed(() => {
  const node = selectedNode.value
  if (!node) return []
  const groupNodeIds = selectedGroup.value?.nodeIds
  if (!groupNodeIds?.length) return [node]
  return allNodes.value
    .filter((item) => groupNodeIds.includes(item.id))
    .sort((left, right) => left.id - right.id)
})

const selectedGroupImageCount = computed(() =>
  selectedGroupNodes.value.reduce(
    (total, node) => total + countAssetImageGroupsResults(groupAssetNodeImages(node.images, node.nodeType)),
    0,
  ),
)
const selectedActiveImageCount = computed(() => selectedNode.value
  ? countAssetImageGroupsResults(groupAssetNodeImages(
      selectedNode.value.images,
      selectedNode.value.nodeType,
      selectedNode.value.confirmedImage,
    ))
  : 0)

const selectedGroupLabel = computed(() => selectedGroup.value?.label || selectedNode.value?.label || '')
const selectedGroupTypeLabel = computed(() => {
  if (isSelectedScene.value) return '场景时空组'
  if (isSelectedCharacter.value) return '角色时空组'
  return '道具组'
})

function handleGroupTurnaroundClick(nodeIds: number[]): void {
  const target =
    allNodes.value.find((node) =>
      nodeIds.includes(node.id)
      && node.images.some((image) => image.viewSetType === 'single' && image.status === 'confirmed'),
    )
    || allNodes.value.find((node) => nodeIds.includes(node.id))
  if (!target) return
  selectNode(target)
  void nextTick(() => {
    showToast(`已选中${target.label}，可在右侧生成完整角色资产板`)
  })
}

const worldStyle = computed(() => ({
  transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
  transformOrigin: '0 0',
}))

const gridStyle = computed(() => {
  const fine = 24 * view.scale
  const layers: string[] = []
  const sizes: string[] = []
  const positions: string[] = []

  // 缩得太小时细网格会变成摩尔纹，直接撤掉这一层
  if (fine >= 11) {
    layers.push('radial-gradient(circle at 1px 1px, rgba(164, 132, 84, 0.13) 1px, transparent 0)')
    sizes.push(`${fine}px ${fine}px`)
    positions.push(`${view.x}px ${view.y}px`)
  }

  const major = fine * 5
  layers.push('radial-gradient(circle at 1px 1px, rgba(164, 132, 84, 0.26) 1px, transparent 0)')
  sizes.push(`${major}px ${major}px`)
  positions.push(`${view.x}px ${view.y}px`)

  return {
    backgroundImage: layers.join(', '),
    backgroundSize: sizes.join(', '),
    backgroundPosition: positions.join(', '),
  }
})

const zoomPercent = computed(() => Math.round(view.scale * 100))

const canvasStateLabel = computed(() => {
  const summary = canvas.value?.summary
  if (!summary || !summary.total) return '还没有节点'
  return `${summary.total} 个节点 · ${summary.confirmedCount} 个已采用 · ${summary.pendingCount} 个待补充`
})

const autoLayoutNodes = computed(() => {
  const layoutById = new Map(allNodes.value.map((node) => [node.id, node] as const))
  const result: Array<{ id: number; x: number; y: number }> = []
  const groupsByKey = new Map(
    (canvas.value?.groups || []).map((group) => [
      group.key,
      group.nodeIds.map((id) => layoutById.get(id)).filter((node): node is AssetNodeDTO => Boolean(node)),
    ]),
  )

  // One source of truth: every persisted node is placed exactly once.
  let x = 48
  let previousType = ''
  const orderedGroups = [...groupsByKey.entries()].sort(([, left], [, right]) => {
    const leftType = left[0]?.nodeType || ''
    const rightType = right[0]?.nodeType || ''
    return (TYPE_LAYOUT_ORDER[leftType] ?? 99) - (TYPE_LAYOUT_ORDER[rightType] ?? 99)
      || String(left[0]?.label || '').localeCompare(String(right[0]?.label || ''), 'zh-CN')
  })
  for (const [, nodes] of orderedGroups) {
    const currentType = nodes[0]?.nodeType || ''
    if (previousType && currentType !== previousType) x += TYPE_SECTION_GAP
    const width = Math.max(...nodes.map((node) => node.width))
    let y = 48 + GROUP_HEADER_HEIGHT
    for (const node of nodes.sort((a, b) =>
      String(a.appearanceLabel || '').localeCompare(String(b.appearanceLabel || ''), 'zh-CN')
        || a.id - b.id,
    )) {
      result.push({ id: node.id, x, y })
      y += node.height + 56
    }
    x += width + 72
    previousType = currentType
  }
  return result
})

async function autoArrangeCanvas(): Promise<void> {
  if (!autoLayoutNodes.value.length) return
  try {
    for (const position of autoLayoutNodes.value) {
      await updateAssetNode(position.id, {
        x: position.x,
        y: position.y,
        width: NODE_DEFAULT_WIDTH,
        height: NODE_DEFAULT_HEIGHT,
      })
    }
    await loadCanvas()
    showToast('资产已按角色组和状态重新排版')
  } catch (error) {
    showToast(error instanceof Error ? error.message : '自动排版失败', 'error')
  }
}

function showToast(text: string, tone: ToastTone = 'info'): void {
  toast.value = { text, tone }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, tone === 'error' ? 5200 : 3200)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/* ------------------------------ 数据加载 ------------------------------ */

async function loadCanvas(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }

  try {
    const [projectData, canvasData, characterList] = await Promise.all([
      getProject(projectId.value),
      getAssetCanvas(projectId.value),
      listCharacters(projectId.value).catch(() => [] as CharacterDTO[]),
    ])
    project.value = projectData
    characters.value = characterList
    canvas.value = canvasData
    // 解析剧本后节点通常仍是创建时的默认坐标；首次加载自动归一化一次，
    // 但已存在合理布局时不覆盖用户手动拖动的位置。
    if (canvasData.nodes.length && shouldNormalizeInitialLayout(canvasData.nodes)) {
      await autoArrangeCanvas()
      return
    }
    setWorkspaceContext({ projectId: projectId.value })
    errorMsg.value = ''

    if (!canvasData.nodes.length) {
      pageState.value = 'empty'
    } else {
      pageState.value = 'ready'
      // 首次进入把整张画布收进视口，避免节点落在看不见的地方
      await nextTick()
      fitToView()
    }

    if (selectedNodeId.value && !canvasData.nodes.some((n) => n.id === selectedNodeId.value)) {
      selectedNodeId.value = null
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '资产画布加载失败'
    pageState.value = 'error'
  }
}

function shouldNormalizeInitialLayout(nodes: AssetNodeDTO[]): boolean {
  if (nodes.length < 2) return false
  const uniquePositions = new Set(nodes.map((node) => `${Math.round(node.x)}:${Math.round(node.y)}`))
  const hasDefaultCascade = nodes.every((node) =>
    node.width === NODE_DEFAULT_WIDTH
    && node.height === NODE_DEFAULT_HEIGHT
    && node.x >= 0
    && node.y >= 0
    && node.x <= 220
    && node.y <= 220,
  )
  return uniquePositions.size < nodes.length || hasDefaultCascade
}

onMounted(() => {
  void loadCanvas()
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  if (generationTimer) clearTimeout(generationTimer)
  if (toastTimer) clearTimeout(toastTimer)
  window.removeEventListener('keydown', onWindowKeydown)
})

/* ------------------------------ 视图变换 ------------------------------ */

function zoomAround(clientX: number, clientY: number, factor: number): void {
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return
  const px = clientX - rect.left
  const py = clientY - rect.top
  const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE)
  if (next === view.scale) return
  // 以指针为锚点缩放：指针下的那个点在屏幕上保持不动
  view.x = px - ((px - view.x) * next) / view.scale
  view.y = py - ((py - view.y) * next) / view.scale
  view.scale = next
}

function zoomByStep(factor: number): void {
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return
  zoomAround(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function fitToView(): void {
  const list = canvasNodesForFit.value
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return

  if (!list.length) {
    view.x = 40
    view.y = 40
    view.scale = 1
    return
  }

  const pad = 72
  const minX = Math.min(...list.map((node) => node.x))
  const minY = Math.min(...list.map((node) => node.y))
  const maxX = Math.max(...list.map((node) => node.x + node.width))
  const maxY = Math.max(...list.map((node) => node.y + node.height))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)

  // 适应视口但不要放大超过 100%：放大会让节点看起来像被拉糊了
  const scale = clamp(
    Math.min((rect.width - pad * 2) / spanX, (rect.height - pad * 2) / spanY),
    MIN_SCALE,
    1,
  )
  view.scale = scale
  view.x = (rect.width - spanX * scale) / 2 - minX * scale
  view.y = (rect.height - spanY * scale) / 2 - minY * scale
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  if (event.ctrlKey || event.metaKey) {
    // 触控板捏合与 Ctrl+滚轮都走缩放
    zoomAround(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0022))
    return
  }
  view.x -= event.deltaX
  view.y -= event.deltaY
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return Boolean(el.closest('.ac-node, .ac-zoom, .ac-picker, .ac-empty, .ac-group__action, button, input, textarea'))
}

function setCanvasMode(mode: CanvasMode): void {
  canvasMode.value = mode
  panState.value = null
  dragState.value = null
  selectionRect.value = null
  if (mode === 'pan') selectedNodeIds.value = []
}

function stagePoint(event: PointerEvent): { x: number; y: number } {
  const rect = stageEl.value?.getBoundingClientRect()
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0),
  }
}

function stageToWorld(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale,
  }
}

function onStagePointerDown(event: PointerEvent): void {
  if (dragState.value) return
  if (event.button !== 0 && event.button !== 1) return
  if (isInteractiveTarget(event.target)) return
  if (canvasMode.value === 'select') {
    const point = stagePoint(event)
    selectionRect.value = { startX: point.x, startY: point.y, currentX: point.x, currentY: point.y }
    selectedNodeIds.value = []
    selectedNodeId.value = null
    stageEl.value?.setPointerCapture(event.pointerId)
    return
  }
  // 点空白处取消选中，同时开始平移
  selectedNodeId.value = null
  selectedNodeIds.value = []
  characterPickerOpen.value = false
  panState.value = {
    clientX: event.clientX,
    clientY: event.clientY,
    originX: view.x,
    originY: view.y,
  }
  stageEl.value?.setPointerCapture(event.pointerId)
}

function onNodeDragStart(payload: { node: AssetNodeDTO; event: PointerEvent }): void {
  const { node, event } = payload
  if (event.button !== 0) return
  if (generatingNodeId.value === node.id) return
  if (canvasMode.value === 'select') return
  selectedNodeId.value = node.id
  characterPickerOpen.value = false
  dragState.value = {
    nodeId: node.id,
    clientX: event.clientX,
    clientY: event.clientY,
    originX: node.x,
    originY: node.y,
    moved: false,
  }
  stageEl.value?.setPointerCapture(event.pointerId)
}

function onStagePointerMove(event: PointerEvent): void {
  const selection = selectionRect.value
  if (selection) {
    const point = stagePoint(event)
    selection.currentX = point.x
    selection.currentY = point.y
    const start = stageToWorld({ x: selection.startX, y: selection.startY })
    const current = stageToWorld(point)
    selectedNodeIds.value = nodesIntersectingSelection(visibleNodes.value, {
      left: start.x,
      top: start.y,
      right: current.x,
      bottom: current.y,
    })
    return
  }
  const pan = panState.value
  if (pan) {
    view.x = pan.originX + (event.clientX - pan.clientX)
    view.y = pan.originY + (event.clientY - pan.clientY)
    return
  }

  const drag = dragState.value
  if (!drag) return
  const node = allNodes.value.find((item) => item.id === drag.nodeId)
  if (!node) return

  const dx = (event.clientX - drag.clientX) / view.scale
  const dy = (event.clientY - drag.clientY) / view.scale
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true
  // 拖动期间只改本地坐标，松手才落库，避免每帧一次请求
  node.x = Math.round((drag.originX + dx) * 100) / 100
  node.y = Math.round((drag.originY + dy) * 100) / 100
}

function onStagePointerUp(event: PointerEvent): void {
  if (selectionRect.value) {
    const selection = selectionRect.value
    const small = Math.abs(selection.currentX - selection.startX) < 6
      && Math.abs(selection.currentY - selection.startY) < 6
    selectionRect.value = null
    stageEl.value?.releasePointerCapture?.(event.pointerId)
    if (small) selectedNodeIds.value = []
    return
  }
  if (panState.value) {
    panState.value = null
    stageEl.value?.releasePointerCapture?.(event.pointerId)
  }

  const drag = dragState.value
  if (!drag) return
  dragState.value = null
  stageEl.value?.releasePointerCapture?.(event.pointerId)
  if (!drag.moved) return

  const node = allNodes.value.find((item) => item.id === drag.nodeId)
  if (!node) return
  const { x, y } = node
  void updateAssetNode(node.id, { x, y }).catch((error) => {
    // 落库失败就把位置还原，不能让画布显示一个后端并不认可的位置
    node.x = drag.originX
    node.y = drag.originY
    showToast(error instanceof Error ? error.message : '节点位置保存失败', 'error')
  })
}

function onStageKeydown(event: KeyboardEvent): void {
  const step = event.shiftKey ? 160 : 48
  switch (event.key) {
    case 'ArrowLeft':
      view.x += step
      break
    case 'ArrowRight':
      view.x -= step
      break
    case 'ArrowUp':
      view.y += step
      break
    case 'ArrowDown':
      view.y -= step
      break
    case '+':
    case '=':
      zoomByStep(1.2)
      break
    case '-':
    case '_':
      zoomByStep(1 / 1.2)
      break
    case '0':
      view.scale = 1
      break
    case 'f':
    case 'F':
      fitToView()
      break
    default:
      return
  }
  event.preventDefault()
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (characterPickerOpen.value) {
    characterPickerOpen.value = false
    return
  }
  selectedNodeId.value = null
  selectedNodeIds.value = []
}

/* ------------------------------ 节点操作 ------------------------------ */

function nextNodePosition(): { x: number; y: number } {
  const rect = stageEl.value?.getBoundingClientRect()
  // 错开摆放，连续新建时不会完全叠在一起
  const cascade = (allNodes.value.length % 6) * 26

  // 画布还没布局出来时不能按公式算：此时宽高为 0、scale 会被钳到最小值，
  // 算出来的是远离原点的天文数字，节点一建出来就飞到看不见的地方。
  // 这种情况直接退到已有内容的右侧，或者世界原点附近。
  if (!rect || rect.width < 1 || rect.height < 1 || view.scale <= 0) {
    if (allNodes.value.length) {
      const maxRight = Math.max(...allNodes.value.map((node) => node.x + node.width))
      const minTop = Math.min(...allNodes.value.map((node) => node.y))
      return { x: Math.round(maxRight + 60 + cascade), y: Math.round(minTop + cascade) }
    }
    return { x: 40 + cascade, y: 40 + cascade }
  }

  const centerX = (rect.width / 2 - view.x) / view.scale - NODE_DEFAULT_WIDTH / 2
  const centerY = (rect.height / 2 - view.y) / view.scale - NODE_DEFAULT_HEIGHT / 2
  return { x: Math.round(centerX + cascade), y: Math.round(centerY + cascade) }
}

async function createBlankNode(): Promise<void> {
  if (creating.value || !projectId.value) return
  creating.value = true
  characterPickerOpen.value = false
  const nodeType: AssetNodeType = activeType.value === 'all' ? 'scene' : activeType.value
  try {
    const position = nextNodePosition()
    const node = await createAssetNode(projectId.value, {
      nodeType,
      label: `未命名${TYPE_LABELS[nodeType]}节点`,
      ...position,
    })
    await loadCanvas()
    activeType.value = 'all'
    selectedNodeId.value = node.id
    showToast(`已新建${TYPE_LABELS[nodeType]}节点，先给它起个名字`)
    await nextTick()
    labelInput.value?.focus()
    labelInput.value?.select()
  } catch (error) {
    showToast(error instanceof Error ? error.message : '新建节点失败', 'error')
  } finally {
    creating.value = false
  }
}

async function createCharacterNode(character: CharacterDTO): Promise<void> {
  if (creating.value || !projectId.value) return
  creating.value = true
  try {
    const position = nextNodePosition()
    const existing = allNodes.value.filter((node) => node.refId === character.id).length
    const node = await createAssetNode(projectId.value, {
      nodeType: 'character',
      refId: character.id,
      label: character.name,
      // 同一角色的节点共用一个分组，画布上会连成一个时空框架
      groupKey: `character-${character.id}`,
      ...position,
    })
    await loadCanvas()
    activeType.value = 'all'
    selectedNodeId.value = node.id
    characterPickerOpen.value = false
    showToast(
      existing > 0
        ? `${character.name}已有 ${existing} 个时空形象，这是第 ${existing + 1} 个`
        : `已把${character.name}放到画布上，Agent 会根据剧本自动整理时空状态`,
    )
  } catch (error) {
    showToast(error instanceof Error ? error.message : '新建角色节点失败', 'error')
  } finally {
    creating.value = false
  }
}

async function removeSelectedNode(): Promise<void> {
  const node = selectedNode.value
  if (!node || deletingNode.value) return
  deletingNode.value = true
  try {
    await deleteAssetNode(node.id)
    selectedNodeId.value = null
    await loadCanvas()
    showToast(`已把${node.label}移出画布，已生成的形象图仍保留在记录里`)
  } catch (error) {
    showToast(error instanceof Error ? error.message : '移除节点失败', 'error')
  } finally {
    deletingNode.value = false
  }
}

/* ------------------------------ 检查器 ------------------------------ */

watch(
  () => selectedNode.value?.id,
  async () => {
    const node = selectedNode.value
    if (!node) {
      saveState.value = 'idle'
      return
    }
    inspectorForm.label = node.label
    inspectorForm.appearanceLabel = ''
    inspectorForm.promptText = node.promptText
    inspectorForm.turnaroundPromptText = node.turnaroundPromptText || ''
    inspectorForm.negativePrompt = node.negativePrompt
    saveState.value = 'idle'
    const shouldHydratePrompt = node.refId && (
      (node.nodeType === 'scene'
        && (!node.promptText.trim() || node.promptText.trim() === scenePromptPlaceholder))
      || (node.nodeType === 'character'
        && (!node.promptText.trim() || node.promptText.includes(characterPromptPlaceholder)))
    )
    if (shouldHydratePrompt) {
      try {
        const updated = await hydrateAssetNodePrompt(node.id)
        const index = allNodes.value.findIndex((item) => item.id === node.id)
        if (index >= 0) allNodes.value[index] = updated
        inspectorForm.promptText = updated.promptText
      } catch {
        // 旧节点没有关联剧本时保留可编辑的空提示词状态。
      }
    }
  },
  { immediate: true },
)

async function saveInspector(): Promise<void> {
  const node = selectedNode.value
  if (!node) return

  const payload: Record<string, string> = {}
  if (inspectorForm.label.trim() && inspectorForm.label !== node.label) {
    payload.label = inspectorForm.label.trim()
  }
  if (inspectorForm.promptText !== node.promptText) payload.promptText = inspectorForm.promptText
  if (inspectorForm.turnaroundPromptText !== (node.turnaroundPromptText || '')) {
    payload.turnaroundPromptText = inspectorForm.turnaroundPromptText
  }
  if (inspectorForm.negativePrompt !== node.negativePrompt) {
    payload.negativePrompt = inspectorForm.negativePrompt
  }
  if (!Object.keys(payload).length) return

  saveState.value = 'saving'
  try {
    const updated = await updateAssetNode(node.id, payload)
    const index = allNodes.value.findIndex((item) => item.id === node.id)
    if (index >= 0) allNodes.value[index] = updated
    saveState.value = 'saved'
  } catch (error) {
    saveState.value = 'error'
    showToast(error instanceof Error ? error.message : '提示词保存失败', 'error')
  }
}

const generateDisabledReason = computed(() => {
  const node = selectedNode.value
  if (!node) return '先选中一个节点'
  if (generatingNodeId.value) return '已有形象在生成中'
  if (!node.promptText.trim() && !node.refId) return '先写好这个资产的生成提示词'
  return ''
})

const derivativeActionHint = computed(() => {
  if (isSelectedCharacter.value) return '生成完整角色资产板；检查通过后自动替换当前采用版本。'
  if (isSelectedScene.value) {
    if (selectedConfirmedPanorama.value) {
      return selectedNineGridImage.value
        ? '九个独立角度已生成；可针对单个角度重新生成。'
        : '全景基准已采用，可以据此生成九张独立机位图。'
    }
    return selectedPanoramaImage.value
      ? '先确认全景基准，再生成九个场景角度。'
      : '先生成并确认场景全景基准，再生成九个角度。'
  }
  if (isSelectedProp.value) return '生成完整道具单图；检查通过后自动替换当前采用版本。'
  return ''
})

const scenePromptPreview = computed(() => {
  if (!isSelectedScene.value) return ''
  const prompt = inspectorForm.promptText.trim()
  if (prompt) return prompt
  return '正在等待 Agent 补齐场景结构提示词…'
})


async function onGenerate(): Promise<void> {
  const node = selectedNode.value
  if (!node || generatingNodeId.value) return
  const viewType = isSelectedCharacter.value
    ? 'single'
    : isSelectedScene.value
      ? selectedConfirmedPanorama.value
        ? 'scene-nine-grid'
        : 'single'
      : isSelectedProp.value
        ? 'single'
        : 'single'
  if (isSelectedScene.value && viewType === 'scene-nine-grid' && selectedSceneNineGridGenerated.value) {
    showToast('九宫格已生成，请在对应视角卡片中单独重试', 'error')
    return
  }
   if (isSelectedScene.value && viewType === 'single' && selectedPanoramaImage.value) {
     showToast('请先采用当前全景基准图，再生成九宫格', 'error')
     return
   }
  // 把未保存的提示词一起提交，避免「改了但按旧提示词生成」
  await saveInspector()

  generatingNodeId.value = node.id
  generatingViewSet.value = viewType === 'single' ? null : viewType
  generationProgress.value = 0
  generationHint.value = isSelectedCharacter.value
    ? '正在一次生成角色完整资产板，并检查全身、脸部特写和三视图'
    : viewType === 'scene-nine-grid'
      ? '正在根据已采用全景生成九个独立机位'
      : isSelectedCharacter.value
        ? '正在生成角色基础正面全身图'
        : isSelectedProp.value
          ? '正在生成道具基础图'
          : '正在生成资产图'
  try {
    const job = await generateAssetNodeImages(node.id, {
      prompt: inspectorForm.promptText,
      candidateCount: 1,
      viewType,
      viewKey: undefined,
      assetPackEnabled: isSelectedCharacter.value && viewType === 'single',
      referenceImageUrl: viewType === 'scene-nine-grid'
        ? selectedConfirmedPanorama.value?.imageUrl || null
        : null,
    })
    generationProgress.value = job.progressPercent
    generationHint.value = '任务已进入后台队列'
    pollGenerationJob(job.id, node.id)
  } catch (error) {
    generatingNodeId.value = null
    generatingViewSet.value = null
    generationHint.value = ''
    showToast(error instanceof Error ? error.message : '提交生成失败', 'error')
  }
}

function pollGenerationJob(jobId: number, nodeId: number): void {
  if (generationTimer) clearTimeout(generationTimer)
  generationTimer = setTimeout(() => {
    void (async () => {
      try {
        const job = await getGenerationJob(jobId)
        generationProgress.value = job.progressPercent
        if (job.status === 'success') {
          const completedViewSet = generatingViewSet.value
          const sourceNode = allNodes.value.find((item) => item.id === nodeId) || null
          const resultItems = (job.result?.items || []) as AssetNodeImageDTO[]
          const isCharacterAssetPackResult = completedViewSet === null
            && sourceNode?.nodeType === 'character'
            && resultItems.some((item) => item.viewSetType === 'character-asset-pack')
          await loadCanvas()
          selectedNodeId.value = nodeId
          generatingNodeId.value = null
          generatingViewSet.value = null
          generationHint.value = ''
          scrollToResults()
          showToast(completedViewSet === 'scene-nine-grid'
            ? '场景九宫格已生成，已显示在结果区'
            : isSelectedCharacter.value
              ? isCharacterAssetPackResult
                ? '角色完整资产板已生成，检查通过后自动替换当前版本'
                : '角色资产板已生成，正在等待完整性检查'
              : isSelectedScene.value
                ? '场景全景基准图已生成，请确认后继续生成九个角度'
                : '道具图片已生成，检查通过后自动替换当前版本')
          return
        }
        if (job.status === 'failed' || job.status === 'canceled') {
          generatingNodeId.value = null
          generatingViewSet.value = null
          generationHint.value = ''
          showToast(job.errorText || '形象生成失败，请检查提示词后重试', 'error')
          return
        }
        generationHint.value = job.status === 'queued'
          ? '生成任务正在排队'
          : `图片模型生成中 ${job.progressPercent}%`
        pollGenerationJob(jobId, nodeId)
      } catch (error) {
        generatingNodeId.value = null
        generatingViewSet.value = null
        generationHint.value = ''
        showToast(error instanceof Error ? error.message : '生成状态查询失败', 'error')
      }
    })()
  }, 2500)
}

async function waitForGenerationJob(
  jobId: number,
  onProgress?: (job: Awaited<ReturnType<typeof getGenerationJob>>) => void,
): Promise<Awaited<ReturnType<typeof getGenerationJob>>> {
  for (;;) {
    const job = await getGenerationJob(jobId)
    onProgress?.(job)
    if (job.status === 'success') return job
    if (job.status === 'failed' || job.status === 'canceled') {
      throw new Error(job.errorText || '状态形象生成失败')
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1800))
  }
}

async function onGenerateGroup(): Promise<void> {
  if (
    generatingGroup.value
    || generatingNodeId.value
    || !selectedGroupNodes.value.length
  ) return

  generatingGroup.value = true
  try {
    let generatedImageCount = 0
    for (const node of selectedGroupNodes.value) {
      const prompt = node.id === selectedNode.value?.id ? inspectorForm.promptText : node.promptText
      if (!prompt.trim() && !node.refId) continue
      if (node.nodeType === 'character') {
        const job = await generateAssetNodeImages(node.id, {
          prompt,
          candidateCount: 1,
          viewType: 'single',
          assetPackEnabled: true,
        })
        const completed = await waitForGenerationJob(job.id)
        const items = (completed.result?.items || []) as AssetNodeImageDTO[]
        const assetPack = items.find((item) => item.viewSetType === 'character-asset-pack') || null
        if (!assetPack || assetPack.status !== 'confirmed' || assetPack.visionStatus !== 'passed') {
          throw new Error(`角色「${node.label}」资产板未通过检查，当前采用版本保持不变`)
        }
        generatedImageCount += 1
        continue
      }
      if (node.nodeType === 'scene') {
        const job = await generateAssetNodeImages(node.id, {
          prompt,
          candidateCount: 1,
          viewType: 'single',
        })
        const completed = await waitForGenerationJob(job.id)
        const items = (completed.result?.items || []) as AssetNodeImageDTO[]
        const panorama = items.find((item) => item.viewSetType === 'single') || null
        if (!panorama || (panorama.visionStatus && panorama.visionStatus !== 'passed')) {
          throw new Error(`场景「${node.label}」全景基准未通过检查`)
        }
        const confirmedPanorama = panorama.status === 'confirmed'
          ? panorama
          : await confirmAssetNodeImage(panorama.id)
        if (!confirmedPanorama || confirmedPanorama.status !== 'confirmed') {
          throw new Error(`场景「${node.label}」全景基准未能确认，已停止九角度生成`)
        }
        const viewItems = await generateSceneNineGridBatch(node.id, confirmedPanorama)
        generatedImageCount += 1 + viewItems.length
        continue
      }
      if (['prop', 'material'].includes(String(node.nodeType))) {
        const job = await generateAssetNodeImages(node.id, {
          prompt,
          candidateCount: 1,
          viewType: 'single',
        })
        const completed = await waitForGenerationJob(job.id)
        const item = ((completed.result?.items || []) as AssetNodeImageDTO[])
          .find((image) => image.viewSetType === 'single')
        if (!item || item.status !== 'confirmed' || item.visionStatus !== 'passed') {
          throw new Error(`道具「${node.label}」图片未通过检查，当前采用版本保持不变`)
        }
        generatedImageCount += 1
        continue
      }
    }
    await loadCanvas()
    const currentImageCount = selectedGroupNodes.value.reduce(
      (total, node) => total + countAssetImageGroupsResults(groupAssetNodeImages(node.images, node.nodeType)),
      0,
    )
    if (!currentImageCount) {
      throw new Error('整组任务已结束，但服务器没有返回任何可展示的图片记录，请查看任务错误后重试')
    }
    showToast(
      isSelectedScene.value
        ? `${selectedGroupLabel.value} 已整组生成 ${generatedImageCount || currentImageCount} 张，当前记录 ${currentImageCount} 张`
        : `${selectedGroupLabel.value} 已整组生成，当前记录 ${currentImageCount} 张`,
    )
  } catch (error) {
    // 批量任务失败时仍刷新一次，展示服务器已真实落库的角度状态，
    // 避免页面停留在“只有全景母图”的旧快照而掩盖具体失败视角。
    try {
      await loadCanvas()
      selectedNodeId.value = selectedNode.value?.id || null
    } catch {
      // 保留原始任务错误；刷新失败不能覆盖真正的生成失败原因。
    }
    showToast(error instanceof Error ? error.message : '整组生成失败', 'error')
  } finally {
    generatingGroup.value = false
  }
}

async function onGenerateSelectedNodes(): Promise<void> {
  if (generatingSelection.value || generatingGroup.value || generatingNodeId.value) return
  const nodes = selectedCanvasNodes.value.slice()
  if (!nodes.length) return

  const plans = nodes.map((node) => ({ node, plan: getAssetNodeGenerationPlan(node) }))
  const total = plans.reduce((count, item) => {
    if (item.plan.kind === 'scene-views') return count + (item.plan.views?.length || 0)
    if (item.plan.kind === 'panorama') return count + 10
    if (item.plan.kind === 'base') return count + 1
    return count + (item.plan.kind === 'skip' ? 0 : 1)
  }, 0)
  if (!total) {
    showToast('所选资产都已有当前图，请单独重试需要替换的视角', 'error')
    return
  }

  generatingSelection.value = true
  selectionProgress.value = { completed: 0, total }
  const skipped: string[] = []
  try {
    for (const { node, plan } of plans) {
      const prompt = node.id === selectedNode.value?.id ? inspectorForm.promptText : node.promptText
      if (plan.kind === 'skip') {
        skipped.push(`${node.label}：${plan.reason}`)
        continue
      }
      if (['base', 'panorama', 'single', 'prop-base'].includes(plan.kind)) {
        const job = await generateAssetNodeImages(node.id, {
          prompt,
          candidateCount: 1,
          viewType: 'single',
          assetPackEnabled: node.nodeType === 'character',
        })
        const completed = await waitForGenerationJob(job.id)
        const items = (completed.result?.items || []) as AssetNodeImageDTO[]
        const assetPack = items.find((item) => item.viewSetType === 'character-asset-pack') || null
        const base = assetPack || items.find((item) => item.viewSetType === 'single') || null
        if (!base || base.visionStatus !== 'passed') {
          throw new Error(`${node.label} 的资产图未通过视觉检查，当前采用版本保持不变`)
        }
        if (plan.kind === 'base' && node.nodeType === 'character') {
          selectionProgress.value.completed += 1
        } else if (plan.kind === 'panorama') {
          const confirmedPanorama = base.status === 'confirmed'
            ? base
            : await confirmAssetNodeImage(base.id)
          if (!confirmedPanorama || confirmedPanorama.status !== 'confirmed') {
            throw new Error(`${node.label} 的全景基准未能确认，已停止九角度生成`)
          }
          await generateSceneNineGridBatch(node.id, confirmedPanorama)
          selectionProgress.value.completed += 10
        } else {
          selectionProgress.value.completed += 1
        }
        continue
      }
      let base = selectLatestPassedScenePanorama(node.images)
      if (!base || (base.visionStatus && base.visionStatus !== 'passed')) {
        throw new Error(`${node.label} 的基础图尚未通过视觉检查，不能生成派生视角`)
      }
      if (base.status !== 'confirmed') base = await confirmAssetNodeImage(base.id)
      if (plan.kind === 'scene-views') {
        await generateSceneNineGridBatch(node.id, base)
        selectionProgress.value.completed += plan.views?.length || 0
      }
    }
    await loadCanvas()
    showToast(
      skipped.length
        ? `批量生成完成；${skipped.length} 个节点已有结果，已跳过`
        : `已完成 ${selectionProgress.value.total} 个资产生成任务`,
    )
  } catch (error) {
    showToast(error instanceof Error ? error.message : '批量生成失败，已保留已完成结果', 'error')
  } finally {
    generatingSelection.value = false
  }
}

function selectNode(node: AssetNodeDTO): void {
  if (canvasMode.value === 'select') {
    selectedNodeIds.value = selectedNodeIds.value.includes(node.id)
      ? selectedNodeIds.value.filter((id) => id !== node.id)
      : [...selectedNodeIds.value, node.id]
    selectedNodeId.value = node.id
    return
  }
  selectedNodeId.value = node.id
}

/** 切分类后重新把节点收进视口，避免切过去看到一片空白 */
async function selectType(key: TypeFilter): Promise<void> {
  activeType.value = key
  await nextTick()
  fitToView()
}

function goAssets(): void {
  void router.push({
    path: '/workspace/assets',
    query: {
      projectId: String(projectId.value),
      ...(route.query.pipelineRunId
        ? { pipelineRunId: String(route.query.pipelineRunId) }
        : {}),
    },
  })
}

function openEpisodeWorkbench(): void {
  void router.push({ path: '/workspace/episodes', query: { projectId: String(projectId.value) } })
}

function goDashboard(): void {
  void router.push('/dashboard')
}
</script>

<template>
  <WorkspaceLayout
    :show-side="true"
    :show-inspector="false"
    :no-padding="true"
    :self-managed-scroll="true"
  >
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container-low p-8 text-center">
        <h2 class="font-headline-md text-2xl font-semibold text-on-surface">缺少项目上下文</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          资产画布是项目级页面，先进入某个项目，画布才知道要摆哪一套角色和场景。
        </p>
        <button
          class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold"
          type="button"
          @click="goDashboard"
        >
          返回项目页
        </button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="ac-boot"
      role="status"
      aria-live="polite"
    >
      <div class="ac-boot__dots" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <p>正在读取资产画布…</p>
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="max-w-xl border border-red-500/30 bg-red-500/5 p-8 text-center">
        <h2 class="font-headline-md text-2xl font-semibold text-red-300">画布没能打开</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          {{ errorMsg || '请稍后重试。' }}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <button
            class="border border-outline-variant px-4 py-2 text-sm text-on-surface-variant transition-colors hover:border-bronze hover:text-on-surface"
            type="button"
            @click="loadCanvas"
          >
            重新加载
          </button>
          <button
            class="burning-orange-btn px-5 py-2 text-sm font-semibold"
            type="button"
            @click="goAssets"
          >
            去资产中心
          </button>
        </div>
      </div>
    </section>

    <div v-else class="ac-shell">
      <header class="ac-head">
        <div class="ac-head__identity">
          <button class="ac-icon-btn" type="button" aria-label="返回资产中心" @click="goAssets">
            <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          </button>
          <div class="ac-head__copy">
            <h1 class="ac-head__title">资产画布</h1>
            <p class="ac-head__sub">{{ project?.name || '当前项目' }} · {{ canvasStateLabel }}</p>
          </div>
        </div>

        <nav class="ac-tabs no-scrollbar" aria-label="节点分类">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="ac-tab"
            :class="{ 'is-active': activeType === tab.key }"
            type="button"
            :aria-current="activeType === tab.key ? 'true' : undefined"
            @click="selectType(tab.key)"
          >
            {{ tab.label }}
            <span class="ac-tab__count">{{ tab.count }}</span>
          </button>
        </nav>

        <div class="ac-head__actions">
          <button
            class="ac-ghost-btn"
            type="button"
            @click="openEpisodeWorkbench"
          >
            <span class="material-symbols-outlined" aria-hidden="true">movie</span>
            分镜与视频
          </button>
          <button
            class="ac-ghost-btn"
            type="button"
            :disabled="!allNodes.length || Boolean(generatingNodeId)"
            @click="autoArrangeCanvas"
          >
            <span class="material-symbols-outlined" aria-hidden="true">auto_awesome_mosaic</span>
            整齐排版
          </button>
          <div class="ac-picker-anchor">
            <button
              class="ac-ghost-btn"
              type="button"
              :aria-expanded="characterPickerOpen"
              aria-haspopup="true"
              @click="characterPickerOpen = !characterPickerOpen"
            >
              <span class="material-symbols-outlined" aria-hidden="true">person_add</span>
              从角色建节点
            </button>

            <div v-if="characterPickerOpen" class="ac-picker" role="dialog" aria-label="选择角色">
              <p class="ac-picker__hint">
                一个角色可以放多个节点，Agent 会根据剧本自动识别并整理不同时间状态。
              </p>
              <p v-if="!characters.length" class="ac-picker__empty">
                这个项目还没有角色。先去角色库从剧本里识别角色，再回来搭画布。
              </p>
              <ul v-else class="ac-picker__list custom-scrollbar">
                <li v-for="character in characters" :key="character.id">
                  <button class="ac-picker__row" type="button" @click="createCharacterNode(character)">
                    <span class="ac-picker__avatar">
                      <img
                        v-if="character.referenceImageUrl"
                        :src="character.referenceImageUrl"
                        :alt="`${character.name} 的参考图`"
                        loading="lazy"
                      />
                      <span v-else>{{ character.name.slice(0, 1) }}</span>
                    </span>
                    <span class="ac-picker__meta">
                      <span class="ac-picker__name">{{ character.name }}</span>
                      <span class="ac-picker__role">{{ character.roleTag || '未设定位' }}</span>
                    </span>
                    <span class="ac-picker__count">
                      {{
                        allNodes.filter((node) => node.refId === character.id).length
                          ? `${allNodes.filter((node) => node.refId === character.id).length} 个时空`
                          : '加入画布'
                      }}
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>

          <button
            class="burning-orange-btn ac-primary-btn"
            type="button"
            :disabled="creating"
            @click="createBlankNode"
          >
            <span class="material-symbols-outlined" aria-hidden="true">add</span>
            新建节点
          </button>
        </div>
      </header>

      <div class="ac-body">
        <section class="ac-stage-wrap">
          <div
            ref="stageEl"
            class="ac-stage"
            :class="{ 'is-panning': panState, 'is-dragging-node': dragState, 'is-select-mode': canvasMode === 'select' }"
            role="application"
            aria-label="资产画布，可拖拽平移、滚轮滚动、Ctrl 加滚轮缩放"
            tabindex="0"
            @wheel="onWheel"
            @pointerdown="onStagePointerDown"
            @pointermove="onStagePointerMove"
            @pointerup="onStagePointerUp"
            @pointercancel="onStagePointerUp"
            @keydown="onStageKeydown"
          >
            <div class="ac-grid" :style="gridStyle" aria-hidden="true"></div>
            <div class="ac-canvas-tools" @pointerdown.stop>
              <button
                class="ac-canvas-tools__button"
                :class="{ 'is-active': canvasMode === 'pan' }"
                type="button"
                title="拖动画布"
                @click="setCanvasMode('pan')"
              >
                <span class="material-symbols-outlined" aria-hidden="true">pan_tool</span>
                拖动
              </button>
              <button
                class="ac-canvas-tools__button"
                :class="{ 'is-active': canvasMode === 'select' }"
                type="button"
                title="框选多个资产"
                @click="setCanvasMode('select')"
              >
                <span class="material-symbols-outlined" aria-hidden="true">select_all</span>
                选择
              </button>
              <span class="ac-canvas-tools__mode">{{ canvasMode === 'select' ? '框选模式' : '拖动模式' }}</span>
            </div>
            <div
              v-if="selectionRect"
              class="ac-selection-rect"
              :style="selectionBoxStyle"
              aria-hidden="true"
            ></div>
            <div v-if="selectedCanvasNodes.length" class="ac-selection-actions" @pointerdown.stop>
              <span>{{ selectedCanvasNodes.length }} 个资产已选中</span>
              <button
                class="burning-orange-btn ac-selection-actions__button"
                type="button"
                :disabled="generatingSelection || Boolean(generatingNodeId) || generatingGroup"
                @click="onGenerateSelectedNodes"
              >
                <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
                {{ generatingSelection
                  ? `批量生成中 ${selectionProgress.completed}/${selectionProgress.total}`
                  : '整组生成' }}
              </button>
              <button class="ac-selection-actions__clear" type="button" title="清除选择" @click="selectedNodeIds = []">
                <span class="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>

            <div v-if="pageState === 'empty'" class="ac-empty">
              <h2 class="ac-empty__title">画布还是空的</h2>
              <p class="ac-empty__text">
                角色节点会自动按角色和剧本时空归组。同一个角色的多个时空形象可以并存，
                比如「5 岁的小光」和「现在的小光」，互不覆盖。
              </p>
              <div class="ac-empty__actions">
                <button
                  class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                  type="button"
                  @click="characterPickerOpen = true"
                >
                  从角色建节点
                </button>
                <button class="ac-ghost-btn" type="button" @click="createBlankNode">
                  新建空白节点
                </button>
              </div>
            </div>

            <div
              v-else-if="!visibleNodes.length"
              class="ac-empty"
              role="status"
            >
              <h2 class="ac-empty__title">
                这个分类下还没有节点
              </h2>
              <p class="ac-empty__text">
                画布上有 {{ allNodes.length }} 个节点，只是不属于「{{
                  TYPE_LABELS[activeType as AssetNodeType] || '当前分类'
                }}」。
              </p>
              <button class="ac-ghost-btn" type="button" @click="activeType = 'all'">
                查看全部节点
              </button>
            </div>

            <div class="ac-world" :style="worldStyle">
              <svg class="ac-world__relations" aria-hidden="true">
                <g v-for="relation in assetRelations" :key="relation.id" :class="`is-${relation.kind}`">
                  <line
                    :x1="relation.x1"
                    :y1="relation.y1"
                    :x2="relation.x2"
                    :y2="relation.y2"
                  />
                  <title>{{ relation.label }}</title>
                </g>
                <g
                  v-for="relation in sceneNineGridCanvasRelations"
                  :key="relation.id"
                  class="is-scene-nine-grid"
                >
                  <line
                    :x1="relation.x1"
                    :y1="relation.y1"
                    :x2="relation.x2"
                    :y2="relation.y2"
                  />
                  <title>{{ relation.viewKey }} · 母图 {{ relation.sourceImageId || '待生成' }} · 视角 {{ relation.viewImageId || '待生成' }}</title>
                </g>
              </svg>
              <section
                v-for="gridGroup in sceneNineGridCanvasGroups"
                :key="`scene-nine-grid-canvas-${gridGroup.nodeId}`"
                class="ac-scene-nine-grid-canvas"
                aria-label="场景九宫格画布组"
              >
                <div
                  class="ac-scene-nine-grid-canvas__source"
                  :style="{ transform: `translate3d(${gridGroup.sourceX}px, ${gridGroup.sourceY - 140}px, 0)` }"
                >
                  <button
                    class="ac-scene-nine-grid-canvas__image ac-scene-nine-grid-canvas__image--source"
                    :class="{ 'is-empty': !resolvedAssetImageUrl(gridGroup.source) }"
                    type="button"
                    :aria-label="`${gridGroup.label} 全景母图`"
                    @pointerdown.stop
                    @click.stop="gridGroup.source && (previewImage = gridGroup.source)"
                  >
                    <img
                      v-if="resolvedAssetImageUrl(gridGroup.source)"
                      :src="resolvedAssetImageUrl(gridGroup.source)"
                      :alt="`${gridGroup.label} 全景母图`"
                      draggable="false"
                    />
                    <span v-else class="ac-scene-nine-grid-canvas__empty-state">
                      {{ gridGroup.source ? sceneNineGridAttemptLabel(gridGroup.source) : '待生成' }}
                    </span>
                  </button>
                  <strong>{{ gridGroup.label }} · 全景母图</strong>
                  <small>{{ gridGroup.source ? `图像 #${gridGroup.source.id}` : '等待全景基准' }}</small>
                </div>
                <div
                  v-for="view in gridGroup.views"
                  :key="`${gridGroup.nodeId}-${view.viewKey}`"
                  class="ac-scene-nine-grid-canvas__view"
                  :style="{ transform: `translate3d(${view.x}px, ${view.y}px, 0)` }"
                >
                  <button
                    class="ac-scene-nine-grid-canvas__image"
                    :class="{ 'is-empty': !resolvedAssetImageUrl(view.image) }"
                    type="button"
                    :aria-label="`${gridGroup.label} ${view.label}`"
                    @pointerdown.stop
                    @click.stop="view.image && (previewImage = view.image)"
                  >
                    <img
                      v-if="resolvedAssetImageUrl(view.image)"
                      :src="resolvedAssetImageUrl(view.image)"
                      :alt="`${gridGroup.label} ${view.label}`"
                      draggable="false"
                    />
                    <span v-else class="ac-scene-nine-grid-canvas__empty-state">
                      {{ sceneNineGridAttemptLabel(view.image) }}
                    </span>
                  </button>
                  <strong>{{ view.label }}</strong>
                  <small>
                    {{ view.image && resolvedAssetImageUrl(view.image) ? `图像 #${view.image.id}` : sceneNineGridAttemptLabel(view.image) }}
                    <template v-if="view.image?.visionReason"> · {{ view.image.visionReason }}</template>
                  </small>
                </div>
              </section>
              <div
                v-for="group in groups"
                :key="group.key"
                class="ac-group"
                :style="{
                  transform: `translate3d(${group.x}px, ${group.y}px, 0)`,
                  width: `${group.width}px`,
                  height: `${group.height}px`,
                }"
              >
                <span class="ac-group__label">
                  <strong>{{ group.label }}</strong>
                  <small>{{ group.detail }}</small>
                  <button
                    v-if="group.nodeType === 'character'"
                    class="ac-group__action"
                    type="button"
                    :disabled="generatingGroup || Boolean(generatingNodeId)"
                    @click.stop="handleGroupTurnaroundClick(group.nodeIds)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">view_column</span>
                    选中状态
                  </button>
                </span>
              </div>

              <div
                v-for="(node, index) in visibleNodes"
                :key="node.id"
                class="ac-slot"
                :style="{
                  transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                  width: `${node.width}px`,
                  height: `${node.height}px`,
                }"
              >
                <AssetNodeCard
                   :node="node"
                   :selected="selectedNodeId === node.id"
                   :multi-selected="selectedNodeIds.includes(node.id)"
                  :generating="generatingNodeId === node.id"
                  :dragging="dragState?.nodeId === node.id"
                  :entrance-index="index"
                  @select="selectNode"
                  @dragstart="onNodeDragStart"
                  @adopt-image="adoptAssetImage"
                />
              </div>

            </div>

            <div class="ac-zoom" @pointerdown.stop>
              <button
                class="ac-zoom__btn"
                type="button"
                aria-label="缩小画布"
                @click="zoomByStep(1 / 1.2)"
              >
                <span class="material-symbols-outlined" aria-hidden="true">remove</span>
              </button>
              <button
                class="ac-zoom__level"
                type="button"
                aria-label="重置为 100%"
                @click="view.scale = 1"
              >
                {{ zoomPercent }}%
              </button>
              <button
                class="ac-zoom__btn"
                type="button"
                aria-label="放大画布"
                @click="zoomByStep(1.2)"
              >
                <span class="material-symbols-outlined" aria-hidden="true">add</span>
              </button>
              <span class="ac-zoom__divider" aria-hidden="true"></span>
              <button class="ac-zoom__btn" type="button" aria-label="适应全部节点" @click="fitToView">
                <span class="material-symbols-outlined" aria-hidden="true">fit_screen</span>
              </button>
            </div>

            <p class="ac-stage__hint no-scrollbar">
              {{ canvasMode === 'select' ? '拖出框选区域，或点击多个资产 · 选择后可整组生成' : '拖空白处平移 · Ctrl/⌘ + 滚轮缩放 · 方向键微调 · F 适应全部' }}
            </p>
          </div>
        </section>

        <aside class="ac-inspector" aria-label="节点检查器">
          <Transition name="ac-panel" mode="out-in">
            <div v-if="!selectedNode" key="blank" class="ac-inspector__blank">
              <h2 class="ac-inspector__blank-title">还没有选中节点</h2>
              <p class="ac-inspector__blank-text">
                在画布上点一个状态节点，编辑它的提示词并生成这一阶段的最终形象。
              </p>
              <div v-if="pendingScenePanoramaAdoption" class="ac-pending-action">
                <strong>场景全景基准等待采用</strong>
                <small>{{ pendingScenePanoramaAdoption.node.label }} 已生成，场景视觉检查未运行，请先人工确认。</small>
                <button
                  class="burning-orange-btn ac-pending-action__button"
                  type="button"
                  @click="selectNode(pendingScenePanoramaAdoption.node)"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">check</span>
                  查看场景全景并采用
                </button>
              </div>
            </div>

            <div v-else :key="selectedNode.id" class="ac-inspector__body custom-scrollbar">
              <div class="ac-inspector__head">
                <input
                  ref="labelInput"
                  v-model="inspectorForm.label"
                  class="ac-input ac-input--title"
                  aria-label="节点名称"
                  placeholder="给这个节点起个名字"
                  @blur="saveInspector"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <span class="ac-inspector__type">{{ TYPE_LABELS[selectedNode.nodeType] }}</span>
              </div>

              <p class="ac-inspector__role" v-if="selectedNode.refId && isSelectedCharacter">
                绑定角色：{{
                  characters.find((item) => item.id === selectedNode?.refId)?.name || '角色已删除'
                }}
              </p>

              <section v-if="isSelectedCharacter" class="ac-character-creator" aria-labelledby="character-creator-title">
                <div class="ac-character-creator__preview">
                  <div class="ac-character-creator__portrait">
                    <img
                      v-if="selectedCharacterPreviewImage?.imageUrl"
                      :src="selectedCharacterPreviewImage.imageUrl"
                      :alt="`${selectedNode.label} 基础正面图`"
                    />
                    <span v-else class="material-symbols-outlined" aria-hidden="true">person</span>
                  </div>
                  <div class="ac-character-creator__status">
                    <span class="ac-field__label">角色资产进度</span>
                    <strong id="character-creator-title">{{ characterWorkflowLabel }}</strong>
                    <div class="ac-character-steps">
                        <span :class="{ 'is-done': Boolean(selectedCharacterAssetPackImage) }"><i aria-hidden="true"></i>整板生成</span>
                        <span :class="{ 'is-done': selectedCharacterAssetPackImage?.visionStatus === 'passed' }"><i aria-hidden="true"></i>完整性检查</span>
                        <span :class="{ 'is-done': selectedCharacterAssetPackImage?.status === 'confirmed' }"><i aria-hidden="true"></i>自动替换</span>
                        <span :class="{ 'is-done': selectedCharacterAssetPackReady }"><i aria-hidden="true"></i>分镜可调用</span>
                    </div>
                  </div>
                </div>

                <div class="ac-chat-thread">
                  <div class="ac-chat-message">
                    <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
                    <p>
                      <template v-if="selectedNode.promptText.trim()">
                        已根据剧本角色档案整理完整角色资产板提示词。一次生成同源母板，检查基础全身、脸部特写及正面/侧面/背面；全部通过后自动替换当前资产并供分镜调用。
                      </template>
                      <template v-else>
                        描述角色外观、固定服装和气质，一次生成包含全身、脸部特写和三视图的完整资产板。
                      </template>
                    </p>
                  </div>
                  <label class="ac-chat-composer">
                    <span class="ac-field__label">剧本角色提示词 · 可编辑</span>
                    <textarea
                      v-model="inspectorForm.promptText"
                      class="ac-chat-composer__input"
                      rows="5"
                      placeholder="例：28 岁女性，浅蓝衬衫、米色西装外套、银色腕表，黑色长发低马尾，冷静克制，都市职场写实感"
                      @blur="saveInspector"
                    ></textarea>
                    <div class="ac-chat-composer__footer">
                      <span>自动整理的提示词已保存；修改后离开输入框自动更新</span>
                      <button
                        class="burning-orange-btn ac-chat-send"
                        type="button"
                        :disabled="Boolean(generatingNodeId) || Boolean(generateDisabledReason)"
                        :title="generateDisabledReason || undefined"
                        @click="selectedCharacterAssetPackImage ? generateCharacterBaseCandidate() : onGenerate()"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">
                          {{ generatingNodeId === selectedNode.id ? 'hourglass_top' : 'arrow_upward' }}
                        </span>
                            {{ generatingNodeId === selectedNode.id
                            ? '角色资产板生成中'
                          : selectedCharacterAssetPackImage
                              ? '重新生成完整资产板'
                              : '生成完整资产板' }}
                      </button>
                    </div>
                  </label>
                  <p v-if="selectedCharacterAssetPackImage" class="ac-field__hint ac-asset-pack-flow-hint">
                    {{ selectedCharacterAssetPackImage.status === 'confirmed' && selectedCharacterAssetPackImage.visionStatus === 'passed'
                      ? '当前完整资产已采用；重新生成并通过检查后会直接覆盖当前版本，分镜 Agent 将读取最新资产板。'
                      : selectedCharacterAssetPackImage.visionStatus === 'failed'
                        ? '资产板检查未通过。重新生成不会影响当前已采用版本。'
                        : '正在检查资产板中的全身、脸部特写和三个视角；通过后自动采用。' }}
                  </p>
                  <p v-if="generatingNodeId === selectedNode.id" class="ac-progress" role="status">
                    <span
                      class="ac-progress__bar"
                      :style="{ '--progress': generationProgress / 100 }"
                    ></span>
                    <span class="ac-progress__text">{{ generationHint }}</span>
                  </p>
                  <p v-else-if="generateDisabledReason" class="ac-field__hint">
                    {{ generateDisabledReason }}
                  </p>
                  <p class="ac-save" :class="`is-${saveState}`" aria-live="polite">
                    <template v-if="saveState === 'saving'">正在保存…</template>
                    <template v-else-if="saveState === 'saved'">已保存</template>
                    <template v-else-if="saveState === 'error'">保存失败，请重试</template>
                    <template v-else>改动会在离开输入框时自动保存</template>
                  </p>
                </div>
              </section>

              <label v-else class="ac-field">
                <span class="ac-field__label">{{ isSelectedScene ? '场景结构提示词' : '资产提示词' }}</span>
                <textarea
                  v-model="inspectorForm.promptText"
                  class="ac-input ac-input--area"
                  rows="7"
                  :placeholder="isSelectedScene
                    ? '例：老城区临河茶馆室内，木梁、长桌、窗外河面和后厨入口的位置关系，午后侧光，固定建筑结构与材质'
                    : '写清楚资产的外观、材质、结构与光线'"
                  @blur="saveInspector"
                ></textarea>
                <span class="ac-field__hint" v-if="isSelectedScene">
                  这是场景的空间基准描述，会同时用于生成全景基准图和后续九宫格多角度图。
                </span>
                <p v-if="isSelectedScene && !inspectorForm.promptText.trim()" class="ac-field__hint ac-field__hint--attention">
                  {{ scenePromptPreview }}
                </p>
              </label>

              <label class="ac-field">
                <span class="ac-field__label">负面提示词</span>
                <textarea
                  v-model="inspectorForm.negativePrompt"
                  class="ac-input ac-input--area ac-input--short"
                  rows="3"
                  placeholder="留空则用模型默认的负面词"
                  @blur="saveInspector"
                ></textarea>
              </label>

              <div v-if="!isSelectedCharacter" class="ac-actions">
                <button
                  v-if="!isSelectedScene || !selectedConfirmedPanorama"
                  class="burning-orange-btn ac-primary-btn w-full justify-center"
                  type="button"
                  :disabled="Boolean(generateDisabledReason) || Boolean(generatingNodeId)"
                  :title="generateDisabledReason || undefined"
                  @click="onGenerate"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">
                    {{ generatingNodeId === selectedNode.id ? 'hourglass_top' : 'auto_awesome' }}
                  </span>
                  {{ generatingNodeId === selectedNode.id
                    ? (generatingViewSet === 'scene-nine-grid'
                        ? '正在生成场景九宫格'
                        : isSelectedScene ? '正在生成全景基准图' : '正在生成资产')
                    : (isSelectedScene
                        ? (selectedConfirmedPanorama ? '根据全景生成九宫格' : '生成全景基准图')
                        : '生成资产图片') }}
                </button>
                <div v-else class="ac-primary-lock" role="status">
                  <span class="material-symbols-outlined" aria-hidden="true">lock</span>
                  <span>场景全景基准已锁定</span>
                </div>

                <button
                  v-if="isSelectedScene && selectedPanoramaImage && !selectedConfirmedPanorama"
                  class="ac-ghost-btn ac-panorama-retry"
                  type="button"
                  :disabled="Boolean(generatingNodeId)"
                  @click="regenerateScenePanorama"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                  重新生成全景
                </button>

                <p v-if="generatingNodeId === selectedNode.id" class="ac-progress" role="status">
                  <span
                    class="ac-progress__bar"
                    :style="{ '--progress': generationProgress / 100 }"
                  ></span>
                  <span class="ac-progress__text">{{ generationHint }}</span>
                </p>
                <p v-else-if="generateDisabledReason" class="ac-field__hint">
                  {{ generateDisabledReason }}
                </p>
                <p v-if="isSelectedScene" class="ac-viewset-hint">
                  <span class="material-symbols-outlined" aria-hidden="true">info</span>
                     {{ sceneViewSetHint }}
                </p>
                <div v-if="isSelectedScene && selectedConfirmedPanorama" class="ac-derivative-action">
                  <div>
                    <span class="ac-field__label">下一步：场景九宫格</span>
                    <p>{{ derivativeActionHint }}</p>
                  </div>
                  <button
                    class="burning-orange-btn ac-derivative-action__button"
                    type="button"
                    :disabled="Boolean(generatingNodeId) || selectedSceneNineGridGenerated"
                    @click="onGenerate"
                  >
                    <span v-if="generatingViewSet === 'scene-nine-grid'" class="studio-spinner" aria-hidden="true"></span>
                    <span v-else class="material-symbols-outlined" aria-hidden="true">{{ selectedSceneNineGridGenerated ? 'lock' : 'grid_view' }}</span>
                    {{ generatingViewSet === 'scene-nine-grid'
                      ? '九宫格生成中'
                      : selectedSceneNineGridGenerated ? '九个角度已生成' : '生成九个独立角度' }}
                  </button>
                  <small class="ac-scene-action__note">“采用此角度”会锁定该图为当前场景视角，供分镜引用；每张图都需要单独采用。</small>
                </div>

                <p class="ac-save" :class="`is-${saveState}`" aria-live="polite">
                  <template v-if="saveState === 'saving'">正在保存…</template>
                  <template v-else-if="saveState === 'saved'">已保存</template>
                  <template v-else-if="saveState === 'error'">保存失败，请重试</template>
                  <template v-else>改动会在离开输入框时自动保存</template>
                </p>
              </div>

              <section ref="resultsEl" class="ac-results" aria-labelledby="asset-results-title">
                <div class="ac-results__head">
                  <div>
                    <h3 id="asset-results-title" class="ac-field__label">生成结果</h3>
                    <p class="ac-results__hint">
                      重新生成通过检查后会直接替换同一视角的旧图，历史版本仅保留在后台。
                    </p>
                  </div>
                    <span class="ac-results__count">{{ selectedActiveImageCount }} 张当前图</span>
                </div>

                <p v-if="!selectedResultGroups.length" class="ac-candidates__empty">
                     {{ isSelectedScene
                      ? '还没有生成场景组图。先生成并确认全景基准，再生成九个角度。'
                     : isSelectedCharacter
                       ? '还没有生成完整角色资产板。写好提示词后开始生成。'
                       : '还没有生成资产图片。写好提示词后开始生成。' }}
                </p>

                <div v-else class="ac-results__groups">
                  <article
                    v-for="group in selectedResultGroups"
                    :key="group.key"
                    class="ac-result-group"
                    :class="{ 'is-confirmed': group.confirmed, 'is-empty': !group.latest }"
                  >
                    <div class="ac-result-group__head">
                      <div>
                        <h4 class="ac-result-group__title">{{ group.label }}</h4>
                      <p class="ac-result-group__meta">
                        {{ resultGroupImageCount(group) }} 个当前版本 ·
                        <span :class="groupStatusTone(group)">{{ groupStatusText(group) }}</span>
                        </p>
                      </div>
                      <span v-if="group.confirmed" class="ac-result-group__verified">
                        <span class="material-symbols-outlined" aria-hidden="true">verified</span>
                        已采用
                      </span>
                    </div>

                    <div
                      v-if="group.key === 'single' && isSelectedScene"
                      class="ac-base-candidates"
                      aria-label="基础图及视觉检查结果"
                    >
                      <article
                        v-for="candidate in group.images"
                        :key="`base-candidate-${candidate.id}`"
                        class="ac-base-candidate"
                      >
                        <button
                          class="ac-base-candidate__preview"
                          type="button"
                          :aria-label="`放大查看${group.label} ${candidate.id}`"
                          @click="previewImage = candidate"
                        >
                          <img
                            :src="candidateSources(candidate)[0]"
                            :alt="`${selectedNode.label} ${group.label}`"
                            @error="onCandidateImageError(candidate)"
                          />
                          <span class="material-symbols-outlined" aria-hidden="true">zoom_in</span>
                        </button>
                        <div class="ac-base-candidate__info">
                          <span class="ac-state-image__tag">{{ candidate.status === 'confirmed' ? '当前已采用' : candidate.visionStatus === 'skipped' ? '待人工采用' : '待检查' }} · #{{ candidate.id }}</span>
                          <span
                            class="ac-result-status"
                            :class="{ 'is-confirmed': candidate.status === 'confirmed' && (candidate.visionStatus === 'passed' || (isSelectedScene && candidate.visionStatus === 'skipped')) }"
                          >
                            {{ assetReviewStatus(candidate) }}
                          </span>
                          <small v-if="candidate.visionReason" class="ac-result-vision-reason">{{ candidate.visionReason }}</small>
                          <button
                            v-if="candidate.status !== 'confirmed' && canAdoptCurrentAsset(candidate)"
                            class="ac-ghost-btn ac-candidate__adopt"
                            type="button"
                            :disabled="Boolean(generatingNodeId)"
                            @click="adoptAssetImage(candidate)"
                          >
                            <span class="material-symbols-outlined" aria-hidden="true">check</span>
                            {{ candidate.visionStatus === 'skipped' ? '人工确认并采用' : '采用当前版本' }}
                          </button>
                        </div>
                      </article>
                    </div>
                    <div
                      v-else-if="group.key === 'character-asset-pack' && group.latest"
                      class="ac-character-asset-pack"
                    >
                      <button
                        class="ac-character-asset-pack__preview"
                        type="button"
                        aria-label="放大查看完整角色资产板"
                        @click="previewImage = group.latest"
                      >
                        <img
                          :src="candidateSources(group.latest)[0]"
                          :alt="`${selectedNode.label} 完整角色资产板`"
                          @error="onCandidateImageError(group.latest)"
                        />
                        <span class="material-symbols-outlined" aria-hidden="true">zoom_in</span>
                      </button>
                      <div class="ac-character-asset-pack__meta">
                        <span class="ac-state-image__tag">完整同源母板 · 不裁切</span>
                        <span
                          class="ac-result-status"
                          :class="{ 'is-confirmed': group.latest.status === 'confirmed' && group.latest.visionStatus === 'passed' }"
                        >
                           {{ group.latest.status === 'confirmed' && group.latest.visionStatus === 'passed'
                             ? '视觉检查通过 · 已采用'
                            : group.latest.visionStatus === 'failed' ? '视觉检查失败 · 重新检查或生成'
                              : group.latest.visionStatus === 'passed' ? '视觉检查通过 · 待采用'
                                : '视觉检查中 · 可重试' }}
                        </span>
                        <small v-if="group.latest.visionReason" class="ac-result-vision-reason">
                          {{ group.latest.visionReason }}
                        </small>
                        <button
                          v-if="group.latest.status !== 'confirmed' && group.latest.visionStatus === 'passed'"
                          class="ac-ghost-btn ac-candidate__adopt"
                          type="button"
                          :disabled="Boolean(generatingNodeId)"
                          @click="adoptAssetImage(group.latest)"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">check</span>
                          采用当前角色资产板
                        </button>
                        <button
                          v-if="group.latest.status !== 'confirmed' && group.latest.visionStatus !== 'passed'"
                          class="ac-ghost-btn ac-candidate__adopt"
                          type="button"
                          :disabled="Boolean(generatingNodeId) || inspectingAssetImageIds.includes(group.latest.id)"
                          @click="retryAssetImageInspection(group.latest)"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">fact_check</span>
                          {{ inspectingAssetImageIds.includes(group.latest.id) ? '检查中…' : '重新检查' }}
                        </button>
                        <button
                          v-if="group.latest.status === 'confirmed'"
                          class="ac-ghost-btn ac-candidate__adopt"
                          type="button"
                          :disabled="Boolean(generatingNodeId)"
                          @click="generateCharacterBaseCandidate"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                          重新生成角色资产板
                        </button>
                      </div>
                    </div>
                    <div
                      v-else-if="groupPreviewImage(group)"
                      class="ac-state-image"
                    >
                      <img
                        v-if="!failedCandidateImages[groupPreviewImage(group)!.id] && candidateSources(groupPreviewImage(group)!).length"
                        class="ac-state-image__img"
                        :src="candidateSources(groupPreviewImage(group)!)[0]"
                        :alt="`${selectedNode.label} ${group.label}`"
                        @error="onCandidateImageError(groupPreviewImage(group)!)"
                      />
                      <div v-else class="ac-candidate__fallback">
                        <span class="material-symbols-outlined" aria-hidden="true">broken_image</span>
                        <span>图片暂不可访问</span>
                        <small>请检查对象存储地址后重新生成</small>
                      </div>
                      <span class="ac-state-image__tag">{{ group.key === 'scene-nine-grid' ? '九宫格母图' : group.label }}</span>
                      <span v-if="['prop', 'material'].includes(String(selectedNode.nodeType))" class="ac-result-status">
                        {{ assetReviewStatus((group.latest || group.images[0])!) }}
                      </span>
                      <small
                        v-if="['prop', 'material'].includes(String(selectedNode.nodeType)) && (group.latest || group.images[0])?.visionReason"
                        class="ac-result-vision-reason"
                      >
                        {{ (group.latest || group.images[0])?.visionReason }}
                      </small>
                      <button
                        v-if="['prop', 'material'].includes(String(selectedNode.nodeType))
                          && (group.latest || group.images[0])?.status !== 'confirmed'
                          && (group.latest || group.images[0])?.visionStatus !== 'passed'"
                        class="ac-ghost-btn ac-candidate__adopt"
                        type="button"
                        :disabled="Boolean(generatingNodeId) || inspectingAssetImageIds.includes((group.latest || group.images[0])!.id)"
                        @click="retryAssetImageInspection((group.latest || group.images[0])!)"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">fact_check</span>
                        {{ inspectingAssetImageIds.includes((group.latest || group.images[0])!.id) ? '检查中…' : '重新检查' }}
                      </button>
                    </div>

                    <div
                      v-if="group.key === 'scene-nine-grid' && selectedSceneNineGridImages.length"
                      class="ac-scene-nine-grid-results"
                      aria-label="场景九宫格九个独立视角"
                    >
                      <div
                        v-for="(slot, index) in selectedSceneNineGridSlots"
                        :key="slot?.id || `scene-view-missing-${index}`"
                        class="ac-scene-nine-grid-view"
                        :class="{ 'is-missing': !slot }"
                      >
                        <button
                          v-if="slot && resolvedAssetImageUrl(slot)"
                          class="ac-scene-nine-grid-view__preview"
                          type="button"
                          :aria-label="`放大查看${slot.viewLabel || `视角 ${index + 1}`}`"
                          @click="previewImage = slot"
                        >
                          <img
                            :src="resolvedAssetImageUrl(slot)"
                            :alt="`${selectedNode.label} ${slot.viewLabel || `视角 ${index + 1}`}`"
                          />
                          <span class="material-symbols-outlined" aria-hidden="true">zoom_in</span>
                        </button>
                        <div v-else class="ac-scene-nine-grid-view__empty">
                          <strong>{{ sceneNineGridAttemptLabel(slot) }}</strong>
                          <small>{{ slot?.visionReason || '暂无可展示的真实图片' }}</small>
                        </div>
                        <span class="ac-scene-nine-grid-view__label">
                          {{ slot?.viewLabel || `视角 ${index + 1}` }}
                        </span>
                        <span
                          v-if="slot"
                          class="ac-scene-nine-grid-view__status"
                          :class="{ 'is-confirmed': slot.status === 'confirmed' }"
                        >
                           {{ sceneNineGridAttemptLabel(slot) }}
                        </span>
                        <small v-if="slot?.visionReason" class="ac-scene-nine-grid-view__reason">
                          {{ slot.visionReason }}
                        </small>
                        <button
                          v-if="slot?.status !== 'confirmed' && canAdoptCurrentAsset(slot)"
                          class="ac-ghost-btn ac-scene-nine-grid-view__adopt"
                          type="button"
                          :disabled="Boolean(generatingNodeId)"
                          @click="adoptAssetImage(slot!)"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">check</span>
                          {{ slot?.visionStatus === 'skipped' ? '采用此角度' : '采用当前版本' }}
                        </button>
                        <button
                          class="ac-ghost-btn ac-scene-nine-grid-view__retry"
                          type="button"
                          :disabled="Boolean(generatingNodeId) || !selectedConfirmedPanorama"
                          @click="regenerateSceneView(sceneNineGridViewKeys[index] || 'center')"
                        >
                          <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                          {{ slot?.status === 'confirmed' ? '替换此角度' : '重新生成此角度' }}
                        </button>
                      </div>
                    </div>

                    <p
                      v-if="group.key === 'character-asset-pack' && isSelectedCharacter"
                      class="ac-result-group__note"
                    >
                      这张资产板包含全身、脸部特写和正面/侧面/背面，整板通过检查后自动替换当前采用版本。
                    </p>
                    <p
                      v-else-if="group.key === 'scene-nine-grid'"
                      class="ac-result-group__note"
                    >
                         九个独立场景角度会继承同一张全景母图的空间锚点，可在分镜中按具体角度引用。
                    </p>

                    <div class="ac-result-group__actions">
                      <button
                        v-if="group.key === 'single' && isSelectedScene && group.latest"
                        class="ac-ghost-btn"
                        type="button"
                        :disabled="Boolean(generatingNodeId)"
                        @click="regenerateScenePanorama"
                      >
                        <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
                        重新生成全景基准图
                      </button>
                    </div>

                    <p
                      v-if="group.key === 'single' && isSelectedScene && group.latest"
                      class="ac-result-group__note"
                    >
                       可反复重生成；新的全景会替换当前基准，并使旧全景派生的九宫格失效。
                    </p>
                    <p
                      v-else-if="group.key === 'single' && isSelectedCharacter && group.latest && !group.confirmed"
                      class="ac-result-group__note"
                    >
                      旧版基础图记录不会进入新流程。请生成一张完整角色资产板；检查通过后会自动采用并替换旧版本。
                    </p>
                  </article>
                </div>
              </section>

              <div v-if="selectedGroup" class="ac-group-actions">
                <div class="ac-group-actions__copy">
                  <span class="ac-field__label">{{ selectedGroupTypeLabel }}</span>
                  <strong>{{ selectedGroupLabel }}</strong>
                  <small>
                    {{ isSelectedScene
                      ? `${selectedGroupNodes.length} 个场景状态 · 重建每个全景基准及其九角度；全景自动采用，九角度需逐张人工采用`
                      : isSelectedCharacter
                        ? `${selectedGroupNodes.length} 个角色状态 · 新结果失败时保留当前已采用版本`
                        : `${selectedGroupNodes.length} 个道具状态 · 新结果通过检查后直接替换当前版本` }}
                  </small>
                </div>
                <button
                  class="ac-ghost-btn ac-group-actions__button"
                  type="button"
                  :title="isSelectedScene
                    ? '为这组全部场景状态重建全景母图与九个独立角度；全景自动采用，九角度待人工采用，旧版本保留在历史中'
                  : isSelectedCharacter
                    ? '重新生成整组角色资产；失败时保留当前已采用版本'
                    : '重新生成整组道具资产；失败时保留当前已采用版本'"
                  :disabled="generatingGroup || Boolean(generatingNodeId) || !selectedGroupNodes.length"
                  @click="onGenerateGroup"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">grid_view</span>
                  {{ generatingGroup
                    ? '整组重建中…'
                    : isSelectedScene
                      ? '重建整组场景母图与九角度'
                      : isSelectedCharacter
                        ? '重新生成整组角色资产'
                        : '重新生成整组道具资产' }}
                </button>
              </div>

              <div class="ac-danger">
                <button
                  class="ac-danger__btn"
                  type="button"
                  :disabled="deletingNode"
                  @click="removeSelectedNode"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                  {{ deletingNode ? '正在移出…' : '把这个节点移出画布' }}
                </button>
                <p class="ac-field__hint">
                  只是从画布上摘掉，已生成的形象图仍作为生成记录保留。
                </p>
              </div>
            </div>
          </Transition>
        </aside>
      </div>

      <Transition name="ac-toast">
        <div v-if="toast" class="ac-toast" :class="`is-${toast.tone}`" role="status">
          <span class="material-symbols-outlined" aria-hidden="true">
            {{ toast.tone === 'error' ? 'error' : 'check_circle' }}
          </span>
          {{ toast.text }}
        </div>
      </Transition>
    </div>
    <Teleport to="body">
      <div
        v-if="previewImage"
        class="ac-image-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="`${selectedNode?.label || '角色'} ${previewImage.viewLabel || previewImage.viewKey || ''}预览`"
        @click.self="previewImage = null"
      >
        <button
          class="ac-image-preview__close"
          type="button"
          aria-label="关闭预览"
          @click="previewImage = null"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
        <img
          :src="previewImage.imageUrl || previewImage.thumbnailUrl || ''"
          :alt="`${selectedNode?.label || '角色'} ${previewImage.viewLabel || previewImage.viewKey || ''}`"
        />
        <p>{{ selectedNode?.label }} · {{ previewImage.viewLabel || previewImage.viewKey }}</p>
      </div>
    </Teleport>
  </WorkspaceLayout>
</template>

<style scoped>
.ac-shell {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  background: #0d0f0d;
}

/* ------------------------------- 顶栏 ------------------------------- */

.ac-head {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
  border-bottom: 1px solid rgba(164, 132, 84, 0.28);
  padding: 0.85rem 1.25rem;
  background: #111210;
}

.ac-head__identity {
  display: flex;
  min-width: 0;
  flex: 1 1 240px;
  align-items: center;
  gap: 0.7rem;
}

.ac-head__copy {
  min-width: 0;
}

.ac-head__title {
  color: #e2e3df;
  font-family: 'Noto Serif SC', 'Playfair Display', serif;
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.25;
}

.ac-head__sub {
  margin-top: 0.15rem;
  overflow: hidden;
  color: #a38c7c;
  font-size: 0.7rem;
  letter-spacing: 0.03em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-icon-btn {
  display: inline-flex;
  height: 2.1rem;
  width: 2.1rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(164, 132, 84, 0.3);
  color: #cfc6bb;
  transition:
    border-color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-icon-btn:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.06);
  color: #ffb77d;
}

.ac-tabs {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  gap: 0.15rem;
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.ac-tab {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border-bottom: 2px solid transparent;
  padding: 0.45rem 0.7rem;
  color: #a38c7c;
  font-size: 0.8rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  transition:
    color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-tab:hover {
  color: #e2e3df;
}

.ac-tab.is-active {
  border-bottom-color: #ffb77d;
  color: #ffb77d;
}

.ac-tab__count {
  color: #6d5740;
  font-size: 0.68rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.ac-tab.is-active .ac-tab__count {
  color: rgba(255, 183, 125, 0.8);
}

.ac-head__actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}

.ac-ghost-btn,
.ac-primary-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.85rem;
  font-size: 0.8rem;
  font-weight: 600;
  white-space: nowrap;
  transition:
    border-color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    color 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-ghost-btn {
  border: 1px solid rgba(164, 132, 84, 0.34);
  color: #cfc6bb;
}

.ac-ghost-btn:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.06);
  color: #ffb77d;
}

.ac-primary-btn:disabled,
.ac-ghost-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.ac-primary-lock {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border: 1px solid rgba(146, 188, 126, 0.34);
  border-radius: 6px;
  background: rgba(67, 94, 59, 0.16);
  color: #b4d49f;
  font-size: 0.78rem;
  font-weight: 650;
}

.ac-primary-lock .material-symbols-outlined {
  font-size: 1rem;
}

.ac-derivative-action {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.55rem;
  padding: 0.65rem 0;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.ac-derivative-action > div > p {
  margin-top: 0.2rem;
  color: #a9a197;
  font-size: 0.68rem;
  line-height: 1.45;
}

.ac-derivative-action__button {
  display: inline-flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 650;
}

.ac-derivative-action__button:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.ac-scene-action__note {
  display: block;
  color: #aaa69d;
  font-size: 0.68rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.ac-ghost-btn .material-symbols-outlined,
.ac-primary-btn .material-symbols-outlined {
  font-size: 1.05rem;
}

/* ------------------------------ 角色浮层 ------------------------------ */

.ac-picker-anchor {
  position: relative;
}

.ac-picker {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 30;
  width: min(340px, calc(100vw - 2rem));
  border: 1px solid rgba(164, 132, 84, 0.4);
  background: #191a18;
  padding: 0.6rem;
  box-shadow:
    0 18px 40px rgba(0, 0, 0, 0.46),
    0 4px 10px rgba(0, 0, 0, 0.2);
}

.ac-picker__hint,
.ac-picker__empty {
  padding: 0.2rem 0.35rem 0.5rem;
  color: #8f877d;
  font-size: 0.7rem;
  line-height: 1.5;
}

.ac-picker__list {
  max-height: 300px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ac-picker__row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.4rem;
  text-align: left;
  transition: background-color 180ms ease;
}

.ac-picker__row:hover {
  background: rgba(255, 183, 125, 0.07);
}

.ac-picker__avatar {
  display: inline-flex;
  height: 2rem;
  width: 2rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(164, 132, 84, 0.36);
  background: rgba(255, 183, 125, 0.05);
  color: #ffb77d;
  font-size: 0.8rem;
  font-weight: 700;
}

.ac-picker__avatar img {
  height: 100%;
  width: 100%;
  object-fit: cover;
}

.ac-picker__meta {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.ac-picker__name {
  color: #e2e3df;
  font-size: 0.8rem;
  font-weight: 600;
}

.ac-picker__role {
  color: #8f877d;
  font-size: 0.66rem;
}

.ac-picker__count {
  flex: 0 0 auto;
  color: #a38c7c;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
}

/* ------------------------------- 主体 ------------------------------- */

.ac-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

.ac-stage-wrap {
  position: relative;
  display: flex;
  min-height: 420px;
  flex: 1 1 auto;
  flex-direction: column;
}

.ac-stage {
  position: relative;
  flex: 1 1 auto;
  overflow: hidden;
  background: #0d0f0d;
  cursor: grab;
  touch-action: none;
  outline: none;
}

.ac-stage.is-panning {
  cursor: grabbing;
}

.ac-stage.is-select-mode {
  cursor: crosshair;
}

.ac-stage.is-select-mode .ac-node {
  cursor: crosshair;
}

.ac-stage:focus-visible {
  box-shadow: inset 0 0 0 2px rgba(255, 183, 125, 0.4);
}

.ac-grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.ac-canvas-tools,
.ac-selection-actions {
  position: absolute;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid rgba(164, 132, 84, 0.34);
  background: rgba(17, 18, 16, 0.96);
  padding: 5px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.3);
}

.ac-canvas-tools {
  top: 14px;
  left: 14px;
}

.ac-canvas-tools__button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 5px;
  border: 1px solid transparent;
  padding: 0 9px;
  color: #aeb0aa;
  font-size: 0.72rem;
}

.ac-canvas-tools__button .material-symbols-outlined,
.ac-selection-actions__button .material-symbols-outlined {
  font-size: 17px;
}

.ac-canvas-tools__button:hover,
.ac-canvas-tools__button.is-active {
  border-color: rgba(139, 200, 178, 0.42);
  background: rgba(139, 200, 178, 0.12);
  color: #a9dbc7;
}

.ac-canvas-tools__mode {
  border-left: 1px solid rgba(164, 132, 84, 0.28);
  padding: 0 8px;
  color: #82796f;
  font-size: 0.64rem;
}

.ac-selection-actions {
  top: 14px;
  right: 14px;
  color: #d8ded9;
  font-size: 0.72rem;
}

.ac-selection-actions__button {
  min-height: 32px;
  padding: 0 10px;
  font-size: 0.72rem;
}

.ac-selection-actions__clear {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  color: #aeb0aa;
}

.ac-selection-rect {
  position: absolute;
  z-index: 6;
  border: 1px solid #8bc8b2;
  background: rgba(139, 200, 178, 0.12);
  pointer-events: none;
}

.ac-world {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
}

.ac-world__relations {
  position: absolute;
  top: 0;
  left: 0;
  width: 3200px;
  height: 3200px;
  overflow: visible;
  pointer-events: none;
}

.ac-world__relations line {
  stroke: rgba(139, 200, 178, 0.46);
  stroke-width: 2;
  stroke-dasharray: 7 6;
  vector-effect: non-scaling-stroke;
}

.ac-world__relations g.is-storyboard-asset line {
  stroke: rgba(255, 183, 125, 0.58);
  stroke-dasharray: 4 5;
}

.ac-world__relations g.is-storyboard-continuity line {
  stroke: #d9a86c;
  stroke-width: 2.5;
  stroke-dasharray: none;
}

.ac-world__relations g.is-scene-nine-grid line {
  stroke: rgba(116, 196, 190, 0.68);
  stroke-width: 1.6;
  stroke-dasharray: 5 5;
}

.ac-scene-nine-grid-canvas {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.ac-scene-nine-grid-canvas__source,
.ac-scene-nine-grid-canvas__view {
  position: absolute;
  display: flex;
  width: 220px;
  flex-direction: column;
  gap: 5px;
  pointer-events: auto;
  border: 1px solid rgba(116, 196, 190, 0.46);
  background: rgba(19, 26, 25, 0.96);
  padding: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.25);
}

.ac-scene-nine-grid-canvas__view {
  width: 156px;
}

.ac-scene-nine-grid-canvas__source strong,
.ac-scene-nine-grid-canvas__view strong,
.ac-scene-nine-grid-canvas__source small,
.ac-scene-nine-grid-canvas__view small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-scene-nine-grid-canvas__source strong,
.ac-scene-nine-grid-canvas__view strong {
  color: #d7eee7;
  font-size: 0.68rem;
}

.ac-scene-nine-grid-canvas__source small,
.ac-scene-nine-grid-canvas__view small {
  color: #8bb8ae;
  font-size: 0.58rem;
}

.ac-scene-nine-grid-canvas__image {
  display: grid;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  place-items: center;
  border: 1px solid rgba(116, 196, 190, 0.22);
  background: #151b19;
  color: #75847d;
  cursor: zoom-in;
}

.ac-scene-nine-grid-canvas__image.is-empty {
  cursor: default;
  background: #111614;
  border-style: dashed;
  border-color: rgba(232, 177, 113, 0.38);
}

.ac-scene-nine-grid-canvas__empty-state {
  max-width: 90%;
  color: #d9b17d;
  font-size: 0.68rem;
  line-height: 1.35;
  text-align: center;
  overflow-wrap: anywhere;
}

.ac-scene-nine-grid-canvas__image--source {
  aspect-ratio: 16 / 10;
}

.ac-scene-nine-grid-canvas__image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.ac-scene-nine-grid-canvas__image:hover,
.ac-scene-nine-grid-canvas__image:focus-visible {
  border-color: #8ed9cd;
  outline: none;
  box-shadow: 0 0 0 2px rgba(116, 196, 190, 0.2);
}

/* 拖动或平移期间禁止选中文字，否则会拖出一片蓝色选区 */
.ac-stage.is-panning,
.ac-stage.is-dragging-node {
  user-select: none;
}

/* -------------------------- 时空分组框架 -------------------------- */

.ac-group {
  position: absolute;
  top: 0;
  left: 0;
  /* A child z-index cannot escape a lower parent stacking context. The group
     itself must sit above node slots or its label will be painted underneath
     the image card. Its background stays transparent so it does not veil the
     card contents below it. */
  z-index: 3;
  border: 1px dashed rgba(164, 132, 84, 0.42);
  background: transparent;
  pointer-events: none;
  animation: ac-group-in 460ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-group__label {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 0.45rem;
  position: absolute;
  top: 10px;
  left: 12px;
  transform: none;
  border: 1px solid rgba(164, 132, 84, 0.42);
  background: #0d0f0d;
  padding: 0.1rem 0.5rem;
  box-sizing: border-box;
  max-width: calc(100% - 24px);
  max-height: 96px;
  min-width: 0;
  color: #e6c18c;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: normal;
  z-index: 2;
}

.ac-group__action {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
  border: 1px solid rgba(255, 183, 125, 0.42);
  background: rgba(255, 183, 125, 0.08);
  padding: 0.16rem 0.36rem;
  color: #ffb77d;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  pointer-events: auto;
  flex: 0 1 auto;
  max-width: 100%;
  white-space: normal;
}

.ac-group__action:hover:not(:disabled) {
  background: rgba(255, 183, 125, 0.16);
}

.ac-group__action:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

.ac-group__action .material-symbols-outlined {
  font-size: 0.76rem;
}

.ac-group__label strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #f0d4a9;
  font-size: 0.66rem;
}

.ac-group__label small {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #aa9b89;
  font-size: 0.58rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.ac-slot {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1;
  will-change: transform;
}

/* ------------------------------ 空态 ------------------------------ */

.ac-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 5;
  width: min(460px, calc(100% - 2.5rem));
  transform: translate(-50%, -50%);
  border: 1px solid rgba(164, 132, 84, 0.3);
  background: rgba(17, 18, 16, 0.9);
  padding: 1.6rem 1.5rem;
  text-align: center;
  animation: ac-empty-in 400ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-empty__title {
  color: #e2e3df;
  font-family: 'Noto Serif SC', 'Playfair Display', serif;
  font-size: 1.2rem;
  font-weight: 600;
}

.ac-empty__text {
  margin-top: 0.6rem;
  color: #a38c7c;
  font-size: 0.8rem;
  line-height: 1.7;
}

.ac-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.6rem;
  margin-top: 1.1rem;
}

/* ------------------------------ 缩放工具 ------------------------------ */

.ac-zoom {
  position: absolute;
  bottom: 1rem;
  left: 1rem;
  z-index: 10;
  display: flex;
  align-items: center;
  border: 1px solid rgba(164, 132, 84, 0.34);
  background: rgba(17, 18, 16, 0.92);
  padding: 0.2rem;
  backdrop-filter: blur(6px);
}

.ac-zoom__btn {
  display: inline-flex;
  height: 1.85rem;
  width: 1.85rem;
  align-items: center;
  justify-content: center;
  color: #cfc6bb;
  transition:
    color 180ms ease,
    background-color 180ms ease;
}

.ac-zoom__btn:hover {
  background: rgba(255, 183, 125, 0.08);
  color: #ffb77d;
}

.ac-zoom__btn .material-symbols-outlined {
  font-size: 1rem;
}

.ac-zoom__level {
  min-width: 3.4rem;
  padding: 0 0.2rem;
  color: #e2e3df;
  font-size: 0.7rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  transition: color 180ms ease;
}

.ac-zoom__level:hover {
  color: #ffb77d;
}

.ac-zoom__divider {
  height: 1.1rem;
  width: 1px;
  margin: 0 0.15rem;
  background: rgba(164, 132, 84, 0.3);
}

.ac-stage__hint {
  position: absolute;
  bottom: 1.3rem;
  left: 50%;
  z-index: 9;
  transform: translateX(-50%);
  overflow: hidden;
  max-width: calc(100% - 12rem);
  color: #6d5740;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}

/* ------------------------------ 检查器 ------------------------------ */

.ac-inspector {
  display: flex;
  min-height: 0;
  flex: 0 0 320px;
  flex-direction: column;
  border-top: 1px solid rgba(164, 132, 84, 0.28);
  background: #111210;
}

.ac-inspector__blank {
  padding: 1.75rem 1.25rem;
}

.ac-inspector__blank-title {
  color: #e2e3df;
  font-family: 'Noto Serif SC', 'Playfair Display', serif;
  font-size: 1rem;
  font-weight: 600;
}

.ac-inspector__blank-text {
  margin-top: 0.5rem;
  color: #8f877d;
  font-size: 0.76rem;
  line-height: 1.7;
}

.ac-pending-action {
  display: grid;
  gap: 0.45rem;
  margin-top: 1rem;
  border: 1px solid rgba(230, 193, 140, 0.3);
  background: rgba(230, 193, 140, 0.05);
  padding: 0.8rem;
}

.ac-pending-action strong {
  color: #e6c18c;
  font-size: 0.74rem;
}

.ac-pending-action small {
  color: #a38c7c;
  font-size: 0.66rem;
  line-height: 1.55;
}

.ac-pending-action__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-height: 2rem;
  padding: 0.3rem 0.55rem;
  font-size: 0.68rem;
}

.ac-pending-action__button .material-symbols-outlined {
  font-size: 0.9rem;
}

.ac-inspector__body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 1.1rem 1.1rem 1.6rem;
}

.ac-inspector__head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.ac-inspector__type {
  flex: 0 0 auto;
  border: 1px solid rgba(164, 132, 84, 0.36);
  padding: 0.12rem 0.4rem;
  color: #a38c7c;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.ac-inspector__role {
  color: #e6c18c;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
}

.ac-character-creator {
  display: grid;
  gap: 0.85rem;
  border: 1px solid rgba(164, 132, 84, 0.3);
  background:
    linear-gradient(145deg, rgba(255, 183, 125, 0.08), transparent 46%),
    rgba(23, 24, 21, 0.86);
  padding: 0.8rem;
}

.ac-character-creator__preview {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.75rem;
}

.ac-character-creator__portrait {
  display: grid;
  height: 5.2rem;
  width: 4rem;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(255, 183, 125, 0.38);
  background: #0d0f0d;
  color: #9d8c78;
}

.ac-character-creator__portrait img {
  height: 100%;
  width: 100%;
  object-fit: cover;
}

.ac-character-creator__portrait .material-symbols-outlined {
  font-size: 1.6rem;
}

.ac-character-creator__status {
  display: grid;
  min-width: 0;
  gap: 0.28rem;
}

.ac-character-creator__status .ac-field__label {
  margin-bottom: 0;
}

.ac-character-creator__status strong {
  overflow: hidden;
  color: #f2eee6;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-character-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 0.38rem 0.55rem;
  color: #81776c;
  font-size: 0.62rem;
}

.ac-character-steps span {
  display: inline-flex;
  align-items: center;
  gap: 0.22rem;
}

.ac-character-steps i {
  height: 0.38rem;
  width: 0.38rem;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.ac-character-steps span.is-done {
  color: #9bbf78;
}

.ac-character-steps span.is-done i {
  border-color: #9bbf78;
  background: #9bbf78;
}

.ac-chat-thread {
  display: grid;
  gap: 0.55rem;
}

.ac-chat-message {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  border-left: 2px solid rgba(255, 183, 125, 0.65);
  padding: 0.1rem 0.25rem 0.1rem 0.55rem;
  color: #b9b1a7;
  font-size: 0.68rem;
  line-height: 1.55;
}

.ac-chat-message .material-symbols-outlined {
  flex: 0 0 auto;
  color: #ffb77d;
  font-size: 0.95rem;
}

.ac-chat-message p {
  margin: 0;
}

.ac-chat-composer {
  display: grid;
  gap: 0.45rem;
  border: 1px solid rgba(164, 132, 84, 0.35);
  background: #101210;
  padding: 0.7rem;
}

.ac-chat-composer .ac-field__label {
  margin-bottom: 0;
}

.ac-chat-composer__input {
  display: block;
  min-height: 6.6rem;
  width: 100%;
  resize: vertical;
  border: 0;
  outline: none;
  background: transparent;
  color: #f2eee6;
  font-size: 0.78rem;
  line-height: 1.7;
}

.ac-chat-composer__input::placeholder {
  color: #746c63;
}

.ac-chat-composer__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.55rem;
  border-top: 1px solid rgba(164, 132, 84, 0.2);
  padding-top: 0.55rem;
}

.ac-chat-composer__footer > span {
  color: #746c63;
  font-size: 0.61rem;
  line-height: 1.4;
}

.ac-chat-send {
  display: inline-flex;
  min-height: 2rem;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.28rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.68rem;
  font-weight: 700;
}

.ac-chat-send .material-symbols-outlined {
  font-size: 0.9rem;
}

.ac-field {
  display: block;
}

.ac-field__label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
  color: #a38c7c;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.13em;
}

.ac-field__hint {
  display: block;
  margin-top: 0.35rem;
  color: #7d746a;
  font-size: 0.68rem;
  line-height: 1.6;
}

.ac-input {
  width: 100%;
  border: 1px solid rgba(164, 132, 84, 0.3);
  background: #0d0f0d;
  padding: 0.5rem 0.6rem;
  color: #e2e3df;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.8rem;
  line-height: 1.6;
  transition: border-color 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-input::placeholder {
  /* 占位文字也要过 4.5:1，不能用更暗的灰 */
  color: #8f877d;
}

.ac-input:hover {
  border-color: rgba(164, 132, 84, 0.5);
}

.ac-input--title {
  font-size: 0.95rem;
  font-weight: 600;
}

.ac-input--area {
  resize: vertical;
  min-height: 4.5rem;
}

.ac-input--short {
  min-height: 3rem;
}

.ac-segment {
  display: inline-flex;
  border: 1px solid rgba(164, 132, 84, 0.3);
}

.ac-segment__btn {
  padding: 0.35rem 0.75rem;
  color: #a38c7c;
  font-size: 0.72rem;
  font-weight: 600;
  transition:
    color 180ms ease,
    background-color 180ms ease;
}

.ac-segment__btn + .ac-segment__btn {
  border-left: 1px solid rgba(164, 132, 84, 0.3);
}

.ac-segment__btn.is-active {
  background: rgba(255, 183, 125, 0.1);
  color: #ffb77d;
}

.ac-actions {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  border-top: 1px solid rgba(164, 132, 84, 0.22);
  padding-top: 1rem;
}

.ac-progress {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(255, 183, 125, 0.3);
  background: rgba(255, 183, 125, 0.06);
  padding: 0.32rem 0.5rem;
}

.ac-progress__bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  background: rgba(255, 183, 125, 0.16);
  /* 用 scaleX 而不是 width：宽度动画会触发布局重排，
     在生成轮询期间每 2.5 秒抖一次整个检查器 */
  transform: scaleX(var(--progress, 0));
  transform-origin: left center;
  will-change: transform;
  transition: transform 400ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-progress__text {
  position: relative;
  color: #ffb77d;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
}

.ac-save {
  color: #6d5740;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
}

.ac-save.is-saving {
  color: #e6c18c;
}

.ac-save.is-saved {
  color: #9bbf78;
}

.ac-save.is-error {
  color: #fca5a5;
}

.ac-candidates {
  border-top: 1px solid rgba(164, 132, 84, 0.22);
  padding-top: 1rem;
}

.ac-candidates__count {
  color: #e6c18c;
  font-variant-numeric: tabular-nums;
}

.ac-candidates__empty {
  color: #7d746a;
  font-size: 0.72rem;
  line-height: 1.6;
}

.ac-results {
  border-top: 1px solid rgba(164, 132, 84, 0.22);
  padding-top: 1rem;
  scroll-margin-block: 1rem;
}

.ac-results__head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.7rem;
}

.ac-results__hint {
  margin-top: 0.25rem;
  color: #8f877d;
  font-size: 0.68rem;
  line-height: 1.5;
}

.ac-results__count {
  flex: 0 0 auto;
  color: #e6c18c;
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}

.ac-results__groups {
  display: grid;
  gap: 0.8rem;
  margin-top: 0.8rem;
}

.ac-result-group {
  border: 1px solid rgba(164, 132, 84, 0.28);
  background: rgba(23, 24, 21, 0.76);
  padding: 0.7rem;
  animation: ac-voice-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-result-group.is-confirmed {
  border-color: rgba(155, 191, 120, 0.38);
}

.ac-result-group__head {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.65rem;
  margin-bottom: 0.6rem;
}

.ac-result-group__title {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #e2e3df;
  font-size: 0.78rem;
  font-weight: 700;
}

.ac-result-group__meta {
  min-width: 0;
  overflow-wrap: anywhere;
  margin-top: 0.22rem;
  color: #8f877d;
  font-size: 0.66rem;
  line-height: 1.4;
}

.ac-result-group__meta .is-confirmed {
  color: #9bbf78;
}

.ac-result-group__meta .is-ready {
  color: #e6c18c;
}

.ac-result-group__meta .is-pending {
  color: #ffb77d;
}

.ac-result-group__verified {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.2rem;
  color: #9bbf78;
  font-size: 0.62rem;
  font-weight: 700;
}

.ac-result-group__verified .material-symbols-outlined,
.ac-result-group__locked .material-symbols-outlined {
  font-size: 0.85rem;
}

.ac-result-group__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.ac-result-group__locked {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: #9bbf78;
  font-size: 0.66rem;
}

.ac-result-group__note {
  min-width: 0;
  overflow-wrap: anywhere;
  margin-top: 0.55rem;
  color: #a38c7c;
  font-size: 0.66rem;
  line-height: 1.55;
}

.ac-view-audit {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.ac-result-status {
  color: #e6c18c;
  font-size: 0.62rem;
}

.ac-result-status.is-confirmed {
  color: #9bbf78;
}

.ac-result-vision-reason {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  color: #d9a0a0;
  font-size: 0.58rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.ac-scene-nine-grid-results {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, 1fr));
  gap: 8px;
  min-width: 0;
  margin-top: 10px;
}

.ac-scene-nine-grid-view {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: #10110f;
  padding: 5px;
}

.ac-scene-nine-grid-view.is-missing {
  border-style: dashed;
}

.ac-scene-nine-grid-view__preview {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  place-items: center;
  background: #fff;
}

.ac-scene-nine-grid-view__preview img {
  height: 100%;
  width: 100%;
  object-fit: cover;
}

.ac-scene-nine-grid-view__preview > span {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  background: rgba(15, 16, 14, 0.78);
  color: #fff;
  font-size: 15px;
}

.ac-scene-nine-grid-view__label {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  color: #e2e3df;
  font-size: 0.64rem;
  font-weight: 700;
  overflow-wrap: anywhere;
  text-overflow: ellipsis;
  white-space: normal;
}

.ac-scene-nine-grid-view__status,
.ac-scene-nine-grid-view__reason {
  min-width: 0;
  max-width: 100%;
  color: #e6c18c;
  font-size: 0.58rem;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: normal;
}

.ac-scene-nine-grid-view__status.is-confirmed {
  color: #9bbf78;
}

.ac-scene-nine-grid-view__reason {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  color: #d9a0a0;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.ac-scene-nine-grid-view__confirm {
  min-height: 28px;
  justify-content: center;
  padding: 0.25rem;
  font-size: 0.58rem;
}

.ac-scene-nine-grid-view__retry {
  display: inline-flex;
  width: 100%;
  min-width: 0;
  min-height: 28px;
  justify-content: center;
  padding: 0.25rem;
  font-size: 0.58rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
  white-space: normal;
}

@media (max-width: 900px) {
  .ac-scene-nine-grid-results {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.ac-scene-nine-grid-view__empty {
  display: grid;
  aspect-ratio: 1 / 1;
  place-items: center;
  align-content: center;
  gap: 5px;
  color: #a38c7c;
  font-size: 0.58rem;
  text-align: center;
}

.ac-scene-nine-grid-view__empty strong,
.ac-scene-nine-grid-view__empty small {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ac-scene-nine-grid-view__empty strong {
  color: #e0b27b;
}

.ac-view-audit__item {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  cursor: pointer;
  padding: 6px 7px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  color: #a38c7c;
  font-size: 11px;
}

.ac-view-audit__item:hover,
.ac-view-audit__item:focus-visible {
  border-color: rgba(255, 183, 125, 0.58);
  outline: none;
}

.ac-view-audit__item.is-confirmed {
  border-color: rgba(52, 211, 153, 0.38);
  color: #a7f3d0;
}

.ac-view-audit__index {
  display: inline-grid;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  background: rgba(148, 163, 184, 0.16);
  color: inherit;
  font-size: 10px;
}

.ac-view-audit__item > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-view-audit__thumb {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  border: 1px solid rgba(164, 132, 84, 0.35);
  object-fit: cover;
}

.ac-view-audit__item .material-symbols-outlined {
  margin-left: auto;
  font-size: 15px;
}

.ac-image-preview {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  gap: 0.8rem;
  background: rgba(5, 6, 5, 0.9);
  padding: 2rem;
}

.ac-image-preview img {
  max-height: min(82vh, 900px);
  max-width: min(88vw, 1100px);
  object-fit: contain;
  border: 1px solid rgba(230, 193, 140, 0.35);
  background: #fff;
}

.ac-image-preview p {
  margin: 0;
  color: #e6c18c;
  font-size: 0.78rem;
}

.ac-image-preview__close {
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: grid;
  width: 2.2rem;
  height: 2.2rem;
  place-items: center;
  border: 1px solid rgba(230, 193, 140, 0.4);
  color: #f0d4a9;
}

.ac-viewset-hint {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  margin-top: 0.3rem;
  color: #a38c7c;
  font-size: 0.68rem;
  line-height: 1.55;
}

.ac-viewset-hint .material-symbols-outlined {
  flex: 0 0 auto;
  color: #e6c18c;
  font-size: 0.9rem;
}

.ac-panorama-check {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  margin-top: 0.8rem;
  border: 1px solid rgba(164, 132, 84, 0.28);
  background: rgba(255, 183, 125, 0.04);
  padding: 0.7rem;
  animation: ac-voice-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-panorama-check__copy {
  min-width: 0;
}

.ac-panorama-check__copy .ac-field__label {
  margin-bottom: 0.2rem;
}

.ac-panorama-check__copy small {
  display: block;
  color: #8f877d;
  font-size: 0.66rem;
  line-height: 1.5;
}

.ac-panorama-check__status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.25rem;
  color: #9ed4aa;
  font-size: 0.68rem;
  font-weight: 700;
}

.ac-panorama-check__status .material-symbols-outlined {
  font-size: 0.9rem;
}

.ac-candidates__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.ac-candidate {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(164, 132, 84, 0.3);
  background: #0d0f0d;
  aspect-ratio: 3 / 4;
}

.ac-candidate__img {
  height: 100%;
  width: 100%;
  object-fit: cover;
  animation: ac-fade-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-candidate__fallback {
  display: grid;
  height: 100%;
  place-items: center;
  align-content: center;
  gap: 0.35rem;
  padding: 0.75rem;
  color: #b7a995;
  text-align: center;
}

.ac-candidate__fallback .material-symbols-outlined {
  color: #d68b68;
  font-size: 1.8rem;
}

.ac-candidate__fallback small {
  color: #7d746a;
  font-size: 0.6rem;
  line-height: 1.4;
}

.ac-candidate__badge {
  position: absolute;
  top: 0.3rem;
  left: 0.3rem;
  border: 1px solid rgba(255, 183, 125, 0.5);
  background: rgba(13, 15, 13, 0.85);
  padding: 0.08rem 0.32rem;
  color: #ffb77d;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.ac-candidate__adopt {
  position: static;
  display: inline-flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  border: 1px solid rgba(164, 132, 84, 0.5);
  background: rgba(13, 15, 13, 0.88);
  padding: 0.28rem;
  color: #ffb77d;
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
  white-space: normal;
  transition:
    background-color 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}

.ac-candidate__adopt:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.16);
}

.ac-candidate__adopt:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.ac-state-image {
  position: relative;
  display: grid;
  gap: 0.45rem;
  overflow: hidden;
  border: 1px solid rgba(164, 132, 84, 0.3);
  background: #0d0f0d;
}

.ac-state-image__img {
  display: block;
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  animation: ac-fade-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.ac-state-image__tag {
  position: static;
  width: fit-content;
  max-width: 100%;
  margin: 0.45rem 0.45rem 0;
  border: 1px solid rgba(255, 183, 125, 0.5);
  background: rgba(13, 15, 13, 0.86);
  padding: 0.18rem 0.42rem;
  color: #ffb77d;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.ac-character-asset-pack {
  display: grid;
  min-width: 0;
  gap: 0.65rem;
}

.ac-character-asset-pack__preview {
  position: relative;
  display: grid;
  width: 100%;
  min-width: 0;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  place-items: center;
  border: 1px solid rgba(164, 132, 84, 0.3);
  background: #fff;
}

.ac-character-asset-pack__preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.ac-character-asset-pack__preview > span {
  position: absolute;
  right: 0.45rem;
  bottom: 0.45rem;
  display: grid;
  width: 1.55rem;
  height: 1.55rem;
  place-items: center;
  background: rgba(15, 16, 14, 0.78);
  color: #fff;
  font-size: 1rem;
}

.ac-character-asset-pack__meta {
  display: grid;
  min-width: 0;
  gap: 0.4rem;
}

.ac-character-asset-pack__meta .ac-state-image__tag {
  position: static;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ac-danger {
  border-top: 1px solid rgba(164, 132, 84, 0.22);
  padding-top: 1rem;
}

.ac-danger__btn {
  display: inline-flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border: 1px solid rgba(185, 28, 28, 0.4);
  padding: 0.45rem;
  color: #fca5a5;
  font-size: 0.74rem;
  font-weight: 600;
  transition:
    background-color 180ms ease,
    border-color 180ms ease;
}

.ac-danger__btn:hover {
  border-color: rgba(185, 28, 28, 0.7);
  background: rgba(127, 29, 29, 0.18);
}

.ac-danger__btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ac-danger__btn .material-symbols-outlined {
  font-size: 1rem;
}

/* ------------------------------ 提示与启动 ------------------------------ */

.ac-toast {
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  z-index: 60;
  display: flex;
  max-width: min(520px, calc(100vw - 2rem));
  transform: translateX(-50%);
  align-items: center;
  gap: 0.5rem;
  border: 1px solid rgba(164, 132, 84, 0.44);
  background: #191a18;
  padding: 0.6rem 0.9rem;
  color: #e2e3df;
  font-size: 0.78rem;
  line-height: 1.5;
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.44);
}

.ac-toast.is-error {
  border-color: rgba(185, 28, 28, 0.55);
  color: #fecaca;
}

.ac-toast .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 1.05rem;
  color: #ffb77d;
}

.ac-toast.is-error .material-symbols-outlined {
  color: #fca5a5;
}

.ac-boot {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.9rem;
  background: #0d0f0d;
  color: #8f877d;
  font-size: 0.8rem;
  letter-spacing: 0.05em;
}

.ac-boot__dots {
  display: inline-flex;
  gap: 0.35rem;
}

.ac-boot__dots span {
  height: 0.35rem;
  width: 0.35rem;
  background: #ffb77d;
  animation: ac-boot-pulse 1.1s ease-in-out infinite;
}

.ac-boot__dots span:nth-child(2) {
  animation-delay: 140ms;
}

.ac-boot__dots span:nth-child(3) {
  animation-delay: 280ms;
}

/* ------------------------------ 过渡 ------------------------------ */

.ac-panel-enter-active,
.ac-panel-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-panel-enter-from {
  opacity: 0;
  transform: translateX(10px);
}

.ac-panel-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}

.ac-toast-enter-active,
.ac-toast-leave-active {
  transition:
    opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 260ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-toast-enter-from,
.ac-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 0.6rem);
}

@keyframes ac-node-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes ac-group-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes ac-empty-in {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-50% + 8px));
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}


@keyframes ac-audio-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes ac-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes ac-boot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.2;
  }
}

/* --------------------------- 响应式 --------------------------- */

@media (min-width: 1024px) {
  .ac-body {
    flex-direction: row;
  }

  .ac-inspector {
    border-top: 0;
    border-left: 1px solid rgba(164, 132, 84, 0.28);
  }
}

@media (max-width: 1023px) {
  .ac-stage-wrap {
    min-height: 58vh;
  }

  .ac-inspector {
    max-height: 60vh;
  }

  .ac-stage__hint {
    display: none;
  }
}

@media (max-width: 640px) {
  .ac-head {
    gap: 0.6rem;
    padding: 0.7rem 0.85rem;
  }

  .ac-head__actions {
    width: 100%;
    margin-left: 0;
  }

  .ac-canvas-tools {
    top: 8px;
    left: 8px;
  }

  .ac-canvas-tools__mode {
    display: none;
  }

  .ac-selection-actions {
    top: 8px;
    right: 8px;
    max-width: calc(100% - 150px);
  }

  .ac-selection-actions > span {
    display: none;
  }

  .ac-head__actions > * {
    flex: 1 1 auto;
  }

  .ac-ghost-btn,
  .ac-primary-btn {
    justify-content: center;
  }

  .ac-picker {
    right: auto;
    left: 0;
  }

  .ac-zoom {
    bottom: 0.7rem;
    left: 0.7rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ac-empty,
  .ac-group,
  .ac-candidate__img,
  .ac-boot__dots span {
    animation: none !important;
  }
}
</style>
