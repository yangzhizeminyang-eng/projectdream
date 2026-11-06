<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { buildTextModelHistory } from '@/lib/model-history'
import { dedupeRunningActivities } from '@/lib/script-agent-activities'
import { canReuseCurrentScriptAssets } from '@/lib/script-parse-fallback.mjs'
import { resolveAgentCommand } from './studio-script-agent-commands'
import {
  finishScriptAgentActivity,
  listScriptAgentActivities,
  startScriptAgentActivity,
  type ScriptAgentActivityDTO,
  type ScriptAgentSource,
  type ScriptAgentStage,
} from '@/api/script-agent'
import {
  generateScenes,
  generateStoryBible,
  generateSeasonStructure,
  getProject,
  getSeasonStructure,
  getStoryBible,
  getAssetCanvas,
  listCharacters,
  listScenes,
  generateProjectCharacters,
  getCreativeWorkflowGates,
  confirmProjectScriptParsed,
  createAssetNode,
  saveSeasonStructure,
  saveSceneScript,
  saveStoryBible,
  updateScene,
  getModelSettings,
  updateModelSettings,
  type ProjectDTO,
  type SeasonEpisodeDTO,
  type SeasonStructureDTO,
  type StoryBibleDTO,
} from '@/api/project'

type Stage = 'bible' | 'season' | 'script'
const route = useRoute()
const router = useRouter()
const projectId = computed(() => Number(route.query.projectId) || 0)
const project = ref<ProjectDTO | null>(null)
const stage = ref<Stage>('bible')
const bible = ref<StoryBibleDTO | null>(null)
const season = ref<SeasonStructureDTO | null>(null)
const scenes = ref<Array<{ id: number; sceneNo: number; title?: string | null; summary?: string | null; content?: string | null }>>([])
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null
const idea = ref('')

const bibleForm = reactive({
  title: '',
  logline: '',
  audience: '',
  emotionalPromise: '',
  mainPlot: '',
  characters: [] as StoryBibleDTO['characters'],
})
const episodeCount = ref(6)
const seasonForm = reactive({
  seasonTheme: '',
  coreConflict: '',
  episodes: [] as SeasonEpisodeDTO[],
})
const sceneDrafts = ref<SceneDraft[]>([])
const generatingSceneId = ref<number | null>(null)
const isAiError = computed(() => /模型|AI|接口|超时|额度|密钥|连接/.test(error.value))
const agentInput = ref('')
const agentMenuOpen = ref(false)
const agentMessages = ref<Array<{ role: 'user' | 'assistant'; text: string }>>([])
const agentBusy = ref(false)
const modelMenuOpen = ref(false)
const modelLoading = ref(false)
const modelSaving = ref(false)
const textModel = ref('')
const textModelHistory = ref<string[]>([])
const modelError = ref('')
const agentActivities = ref<ScriptAgentActivityDTO[]>([])
const showFailedAgentActivities = ref(false)
const hiddenAgentActivityIds = ref<number[]>([])
const batchScriptState = reactive({
  running: false,
  current: 0,
  total: 0,
  completed: 0,
  skipped: 0,
  failedSceneIds: [] as number[],
})
const agentActivityError = ref('')
const agentScroll = ref<HTMLElement | null>(null)
const activeAgentSource = ref<ScriptAgentSource>('button')
let agentActivitySequence = 0
const parsingAssets = ref(false)
const parseResult = ref<{ characters: number; scenes: number } | null>(null)
const scriptParseReady = ref(false)
const canEnterAssets = computed(() => !busy.value && !parsingAssets.value
  && sceneDrafts.value.length > 0 && sceneDrafts.value.every((scene) => Boolean(scene.content.trim())))
const parseError = ref('')
const bibleEditMode = ref(false)
const seasonEditMode = ref(false)
const scriptEditMode = ref(false)
const activeSceneId = ref<number | null>(null)

type SceneDraft = {
  id: number
  sceneNo: number
  title: string
  summary: string
  content: string
  mood: string
  location: string
  timeOfDay: string
  estimatedDuration: number | null
}

const activeScene = computed(() => sceneDrafts.value.find((scene) => scene.id === activeSceneId.value) || sceneDrafts.value[0] || null)
const activeSceneBlocks = computed(() => {
  const content = activeScene.value?.content?.trim() || ''
  return content ? content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean) : []
})

function isScriptHeading(block: string): boolean {
  return /^(?:【[^】]+】|场景\s*\d+|内景|外景|人物|地点|时间|对白|旁白|动作)/.test(block.trim())
}

function isScriptDialogue(block: string): boolean {
  return /^(?:对白|台词|旁白|[\u4e00-\u9fffA-Za-z0-9·]{1,12}[（(][^）)]*[）)]\s*[：:])/.test(block.trim())
}

function isScriptAction(block: string): boolean {
  return /^(?:动作|表演|镜头|画面|音效|声音|\*\*?动作)/.test(block.trim())
}

function cleanScriptBlock(block: string): string {
  return block.replace(/^【场景\s*\d+】\s*/i, '').trim()
}

function selectScene(sceneId: number): void {
  activeSceneId.value = sceneId
  scriptEditMode.value = false
}

function readEpisodeCount(value: unknown): number | null {
  const parsed = Number(value)
  return [1, 3, 6, 10, 12].includes(parsed) ? parsed : null
}

const stageIndex = computed(() => (stage.value === 'bible' ? 0 : stage.value === 'season' ? 1 : 2))
const canAdvanceBible = computed(() => Boolean(bibleForm.logline.trim() && bibleForm.mainPlot.trim() && bibleForm.characters.length))
const canAdvanceSeason = computed(() => seasonForm.episodes.length > 0 && seasonForm.episodes.every((episode) => episode.title.trim() && episode.logline.trim()))
const storyBodyCount = computed(() => [bibleForm.logline, bibleForm.mainPlot, ...bibleForm.characters.map((character) => `${character.name}${character.role}${character.goal}${character.visualDescription}`)].join('').replace(/\s/g, '').length)
const storyTypeLabel = computed(() => String(project.value?.category || '剧情漫剧').replace(/漫剧$/, ''))
const storyPitchLabel = computed(() => bibleForm.emotionalPromise || bibleForm.mainPlot || '等待补充核心表达')
const agentStageLabel = computed(() => stage.value === 'bible' ? '故事设定' : stage.value === 'season' ? '分集大纲' : '剧本正文')
const agentWorking = computed(() => agentActivities.value.some((activity) => activity.status === 'running'))
const modelLabel = computed(() => textModel.value || '当前模型')
const visibleAgentActivities = computed(() => {
  const displayed = dedupeRunningActivities(agentActivities.value)
    .filter((activity) => !hiddenAgentActivityIds.value.includes(activity.id))
  const active = displayed.filter((activity) => activity.status === 'running' || activity.status === 'blocked')
  const recentCompleted = displayed.filter((activity) => activity.status === 'completed').slice(-6)
  const failures = displayed.filter((activity) => activity.status === 'failed')
  const visibleFailures = showFailedAgentActivities.value ? failures : failures.slice(-1)
  return [...active, ...recentCompleted, ...visibleFailures].sort((a, b) => Number(a.id) - Number(b.id))
})
const hiddenFailureCount = computed(() =>
  agentActivities.value.filter((activity) => activity.status === 'failed' && !hiddenAgentActivityIds.value.includes(activity.id)).length,
)

function clearNoticeTimer(): void {
  if (!noticeTimer) return
  clearTimeout(noticeTimer)
  noticeTimer = null
}

function dismissNotice(): void {
  clearNoticeTimer()
  notice.value = ''
}

watch(notice, (value) => {
  clearNoticeTimer()
  if (!value) return
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = null
  }, 5000)
})

function truncateText(value: string, max = 42): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized || '待补充'
}

function addCharacter(): void {
  bibleForm.characters.push({
    name: '',
    role: '',
    goal: '',
    fear: '',
    secret: '',
    growthArc: '',
    visualDescription: '',
  })
}

function removeCharacter(index: number): void {
  bibleForm.characters.splice(index, 1)
}

function syncBible(value: StoryBibleDTO | null): void {
  bible.value = value
  if (!value) return
  bibleForm.title = value.title
  bibleForm.logline = value.logline
  bibleForm.audience = value.audience
  bibleForm.emotionalPromise = value.emotionalPromise
  bibleForm.mainPlot = value.mainPlot
  bibleForm.characters = value.characters.map((character) => ({ ...character }))
}

function syncSeason(value: SeasonStructureDTO | null): void {
  season.value = value
  if (!value) return
  episodeCount.value = value.episodeCount
  seasonForm.seasonTheme = value.seasonTheme
  seasonForm.coreConflict = value.coreConflict
  seasonForm.episodes = value.episodes.map((episode) => ({ ...episode, visualSetPieces: [...(episode.visualSetPieces || [])] }))
}

function upsertAgentActivity(activity: ScriptAgentActivityDTO): void {
  const existingIndex = agentActivities.value.findIndex((item) => item.id === activity.id)
  if (existingIndex >= 0) {
    agentActivities.value.splice(existingIndex, 1, activity)
  } else {
    agentActivities.value.unshift(activity)
  }
  agentActivities.value.sort((a, b) => Number(a.id) - Number(b.id))
  void nextTick(() => {
    if (agentScroll.value) agentScroll.value.scrollTop = agentScroll.value.scrollHeight
  })
}

function activityContext(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage: stage.value,
    stageLabel: agentStageLabel.value,
    episodeCount: episodeCount.value,
    projectId: projectId.value,
    ...extra,
  }
}

async function startAgentActivity(
  actionKey: string,
  stageKey: ScriptAgentStage,
  context: Record<string, unknown> = {},
): Promise<number | null> {
  agentActivityError.value = ''
  const idempotencyKey = `script-${projectId.value}-${actionKey}-${Date.now()}-${agentActivitySequence += 1}`
  try {
    const result = await startScriptAgentActivity(projectId.value, {
      actionKey,
      stageKey,
      source: activeAgentSource.value,
      context: activityContext(context),
      idempotencyKey,
    })
    upsertAgentActivity(result.item)
    return result.item.id
  } catch (cause) {
    agentActivityError.value = cause instanceof Error ? cause.message : 'Script Agent 状态同步失败'
    return null
  }
}

async function finishAgentActivity(
  activityId: number | null,
  phase: 'complete' | 'fail' | 'blocked',
  payload: {
    summary?: string
    context?: Record<string, unknown>
    result?: Record<string, unknown>
    errorText?: string
  } = {},
): Promise<void> {
  if (!activityId) return
  try {
    const response = await finishScriptAgentActivity(projectId.value, activityId, {
      phase,
      ...payload,
    })
    upsertAgentActivity(response.item)
  } catch (cause) {
    agentActivityError.value = cause instanceof Error ? cause.message : 'Script Agent 结果同步失败'
  }
}

async function runScriptAgentAction<T>(
  actionKey: string,
  stageKey: ScriptAgentStage,
  execute: () => Promise<T>,
  resultBuilder: (value: T) => Record<string, unknown> = () => ({}),
  context: Record<string, unknown> = {},
): Promise<T> {
  const activityId = await startAgentActivity(actionKey, stageKey, context)
  try {
    const value = await execute()
    await finishAgentActivity(activityId, 'complete', {
      summary: '真实结果已经写回当前项目，Agent 已整理出下一步检查项。',
      context: activityContext(context),
      result: resultBuilder(value),
    })
    return value
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '操作失败'
    await finishAgentActivity(activityId, 'fail', {
      errorText: message,
      context: activityContext(context),
    })
    throw cause
  }
}

async function runAgentNextAction(actionKey: string | null | undefined): Promise<void> {
  if (!actionKey || busy.value || agentBusy.value) return
  if (actionKey === 'save-bible') return saveBibleAndAdvance()
  if (actionKey === 'generate-season') {
    stage.value = 'season'
    return createSeason()
  }
  if (actionKey === 'save-season') return saveSeasonAndOpenScript()
  if (actionKey === 'generate-script') {
    stage.value = 'script'
    return createScripts()
  }
  if (actionKey === 'generate-scene' && activeScene.value) return generateScene(activeScene.value)
  if (actionKey === 'save-script') {
    await saveScripts()
    return
  }
  if (actionKey === 'parse-assets') return parseScriptAssets()
  if (actionKey === 'open-assets') {
    return openAssets()
  }
}

async function openAssets(): Promise<void> {
  if (!canEnterAssets.value) {
    parseError.value = '请先补齐全部场景正文，等待当前操作结束后再进入资产管理。'
    return
  }
  const parsedBeforeSave = scriptParseReady.value
  const saved = await saveScripts()
  if (!saved) {
    parseError.value = error.value || '剧本保存失败，未离开当前页面。请修复保存问题后重试。'
    return
  }
  void router.push({
    path: '/workspace/assets',
    query: {
      projectId: String(projectId.value),
      ...(!parsedBeforeSave ? { allowIncomplete: '1' } : {}),
      ...(route.query.pipelineRunId
        ? { pipelineRunId: String(route.query.pipelineRunId) }
        : {}),
    },
  })
}

async function load(): Promise<void> {
  if (!projectId.value) {
    error.value = '缺少项目上下文，请从创意输入进入。'
    loading.value = false
    return
  }
  try {
    const [projectData, bibleData, seasonData, sceneData, workflowGates] = await Promise.all([
      getProject(projectId.value),
      getStoryBible(projectId.value),
      getSeasonStructure(projectId.value),
      listScenes(projectId.value),
      getCreativeWorkflowGates(projectId.value).catch(() => null),
    ])
    project.value = projectData
    idea.value = projectData.narrativeVision || ''
    const requestedEpisodeCount = readEpisodeCount(route.query.episodeCount)
    if (requestedEpisodeCount) episodeCount.value = requestedEpisodeCount
    syncBible(bibleData)
    syncSeason(seasonData)
    try {
      const activities = await listScriptAgentActivities(projectId.value)
      agentActivities.value = dedupeRunningActivities(activities)
    } catch (cause) {
      agentActivityError.value = cause instanceof Error ? cause.message : 'Script Agent 活动记录暂时不可用'
    }
    scenes.value = sceneData
    sceneDrafts.value = sceneData.map((scene) => ({
      id: scene.id,
      sceneNo: scene.sceneNo,
      title: scene.title || '',
      summary: scene.summary || '',
      content: scene.content || '',
      mood: scene.mood || '',
      location: scene.location || '',
      timeOfDay: scene.timeOfDay || '',
      estimatedDuration: scene.estimatedDuration ?? null,
    }))
    scriptParseReady.value = workflowGates?.assets.allowed === true
    activeSceneId.value = sceneData[0]?.id || null
    if (sceneData.some((scene) => scene.content?.trim())) stage.value = 'script'
    else if (seasonData) stage.value = 'season'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '剧本页加载失败'
  } finally {
    loading.value = false
  }
}

async function generateBible(): Promise<void> {
  if (busy.value || !idea.value.trim()) {
    error.value = '创意内容为空，请返回创意输入页补充。'
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await runScriptAgentAction(
      'generate-bible',
      'bible',
      () => generateStoryBible(projectId.value, {
        idea: idea.value,
        episodeCount: episodeCount.value,
      }),
      (value) => ({
        versionNo: value.item.versionNo,
        characterCount: value.item.characters.length,
        locationCount: value.item.locations.length,
        changed: ['故事主线', '人物设定', '世界观与场景约束'],
      }),
      { target: '故事设定', ideaLength: idea.value.trim().length },
    )
    syncBible(result.item)
    notice.value = '故事设定已生成，可以继续编辑。'
    agentMessages.value.push({
      role: 'assistant',
      text: '故事设定已经生成。你可以直接修改左侧内容，确认后再进入分集大纲。',
    })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '故事设定生成失败，请检查模型设置后重试。'
  } finally {
    busy.value = false
  }
}

async function sendAgentMessage(): Promise<void> {
  const message = agentInput.value.trim()
  if (!message || busy.value || agentBusy.value) return
  agentMessages.value.push({ role: 'user', text: message })
  agentInput.value = ''
  agentMenuOpen.value = false

  agentBusy.value = true
  error.value = ''
  const previousSource = activeAgentSource.value
  activeAgentSource.value = 'chat'
  try {
    const command = resolveAgentCommand(message)
    if (command.type === 'generate-bible') {
      stage.value = 'bible'
      await generateBible()
      agentMessages.value.push({ role: 'assistant', text: '故事设定已更新。请在左侧检查人物、主线和情绪承诺，再确认进入分集大纲。' })
    } else if (command.type === 'generate-season') {
      if (!bible.value || !canAdvanceBible.value) {
        error.value = '还不能生成分集大纲：请先补齐并确认故事设定。'
        agentMessages.value.push({ role: 'assistant', text: '我还缺少完整的故事设定。请先补齐一句话故事、主线和人物，再让我整理分集大纲。' })
      } else {
        stage.value = 'season'
        await createSeason()
        agentMessages.value.push({ role: 'assistant', text: '分集大纲已生成。你可以直接修改每集标题、冲突和结尾钩子。' })
      }
    } else if (command.type === 'generate-script') {
      if (!seasonForm.episodes.length) {
        error.value = '还没有分集大纲，暂时不能生成剧本正文。'
        agentMessages.value.push({ role: 'assistant', text: '请先生成或补齐分集大纲，我才能按集生成剧本正文。' })
      } else {
        stage.value = 'script'
        await createScripts()
        agentMessages.value.push({ role: 'assistant', text: '剧本场景已生成。接下来可以逐场生成正文，或者直接在场景编辑器里微调。' })
      }
    } else if (command.type === 'parse-assets') {
      stage.value = 'script'
      if (!sceneDrafts.value.length) {
        error.value = '当前还没有剧本场景，解析资产前请先生成剧本正文。'
        agentMessages.value.push({ role: 'assistant', text: '当前没有可解析的剧本场景。先生成剧本正文，我再提取角色和场景资产。' })
      } else {
        await saveScripts()
        if (!error.value) await parseScriptAssets()
        agentMessages.value.push({ role: 'assistant', text: parseResult.value ? `解析完成，已提取 ${parseResult.value.characters} 个角色和 ${parseResult.value.scenes} 个场景。现在可以进入资产管理。` : '解析已结束，请查看底部提示。' })
      }
    } else if (command.type === 'save-script') {
      if (!sceneDrafts.value.length) {
        error.value = '当前没有可保存的剧本正文。'
        agentMessages.value.push({ role: 'assistant', text: '当前还没有剧本场景，暂时没有可保存的内容。' })
      } else {
        await saveScripts()
        agentMessages.value.push({ role: 'assistant', text: '当前剧本修改已保存，后续解析和分镜都会以这版内容为准。' })
      }
    } else {
      agentMessages.value.push({
        role: 'assistant',
        text: `已收到这条创作意见：“${message}”。我会把它作为当前剧本的修改约束。你也可以直接说“生成故事设定”“生成分集大纲”“生成全剧正文”“解析角色和场景”或“保存当前剧本”。`,
      })
    }
  } finally {
    activeAgentSource.value = previousSource
    agentBusy.value = false
  }
}

function insertAgentPrompt(prompt: string): void {
  agentInput.value = prompt
  agentMenuOpen.value = false
}

async function loadTextModels(): Promise<void> {
  if (modelLoading.value) return
  modelLoading.value = true
  modelError.value = ''
  try {
    const settings = await getModelSettings()
    textModel.value = settings.effective.text.defaultModel
    const stored = (() => {
      try {
        return JSON.parse(localStorage.getItem('projectdream.text-model-history') || '[]')
      } catch {
        return []
      }
    })()
    textModelHistory.value = buildTextModelHistory(
      textModel.value,
      settings.fields,
      Array.isArray(stored) ? stored : [],
    )
  } catch (cause) {
    modelError.value = cause instanceof Error ? cause.message : '模型列表加载失败'
  } finally {
    modelLoading.value = false
  }
}

async function selectTextModel(model: string): Promise<void> {
  const normalized = model.trim()
  if (!normalized || modelSaving.value || normalized === textModel.value) {
    modelMenuOpen.value = false
    return
  }
  modelSaving.value = true
  modelError.value = ''
  try {
    const settings = await getModelSettings()
    const payload = settings.fields.map((field) => ({
      key: field.key,
      value: field.key === 'AI_MODEL'
        ? normalized
        : field.type === 'boolean'
          ? field.value === 'true'
          : field.value || '',
    }))
    const updated = await updateModelSettings(payload)
    textModel.value = updated.effective.text.defaultModel
    textModelHistory.value = buildTextModelHistory(
      textModel.value,
      updated.fields,
      [normalized, ...textModelHistory.value],
    )
    localStorage.setItem('projectdream.text-model-history', JSON.stringify(textModelHistory.value.slice(0, 12)))
    modelMenuOpen.value = false
  } catch (cause) {
    modelError.value = cause instanceof Error ? cause.message : '模型切换失败，请检查 Key、接口权限或账户额度。'
    error.value = modelError.value
  } finally {
    modelSaving.value = false
  }
}

function toggleModelMenu(): void {
  modelMenuOpen.value = !modelMenuOpen.value
  if (modelMenuOpen.value && !textModelHistory.value.length) void loadTextModels()
}

async function saveBibleAndAdvance(): Promise<void> {
  if (busy.value || !canAdvanceBible.value) {
    error.value = '请至少补齐故事主线、人物和一句话故事。'
    return
  }
  busy.value = true
  try {
    const result = await runScriptAgentAction(
      'save-bible',
      'bible',
      () => saveStoryBible(projectId.value, {
        title: bibleForm.title,
        logline: bibleForm.logline,
        audience: bibleForm.audience,
        emotionalPromise: bibleForm.emotionalPromise,
        worldRules: bible.value?.worldRules || [],
        timeline: bible.value?.timeline || [],
        locations: bible.value?.locations || [],
        characters: bibleForm.characters,
        relationships: bible.value?.relationships || [],
        props: bible.value?.props || [],
        mainPlot: bibleForm.mainPlot,
        subplots: bible.value?.subplots || [],
        foreshadowing: bible.value?.foreshadowing || [],
        lockedFacts: bible.value?.lockedFacts || [],
        flexibleFacts: bible.value?.flexibleFacts || [],
        visualSymbols: bible.value?.visualSymbols || [],
      }),
      (value) => ({
        versionNo: value.item.versionNo,
        characterCount: value.item.characters.length,
        locationCount: value.item.locations.length,
        changed: ['手动修改已保存', '后续生成将以这版故事设定为准'],
      }),
      { target: '确认故事设定' },
    )
    syncBible(result.item)
    stage.value = 'season'
    notice.value = '故事设定已保存，接下来整理分集大纲。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '故事设定保存失败'
  } finally {
    busy.value = false
  }
}

async function createSeason(): Promise<void> {
  if (busy.value || !bible.value) {
    error.value = '请先完成故事设定。'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const result = await runScriptAgentAction(
      'generate-season',
      'season',
      () => generateSeasonStructure(projectId.value, {
        episodeCount: episodeCount.value,
        seasonTheme: bibleForm.logline,
        coreConflict: bibleForm.mainPlot,
        episodes: seasonForm.episodes,
      }),
      (value) => ({
        versionNo: value.item.versionNo,
        episodeCount: value.item.episodes.length,
        changed: ['集标题', '集目标', '冲突推进', '结尾钩子'],
      }),
      { target: '分集大纲' },
    )
    syncSeason(result.item)
    notice.value = '分集大纲已生成，可以逐集修改。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '分集大纲生成失败'
  } finally {
    busy.value = false
  }
}

async function saveSeasonAndOpenScript(): Promise<void> {
  if (busy.value || !canAdvanceSeason.value) {
    error.value = '请补齐每集标题和一句话大纲。'
    return
  }
  busy.value = true
  try {
    const result = await runScriptAgentAction(
      'save-season',
      'season',
      () => saveSeasonStructure(projectId.value, {
        seasonTheme: seasonForm.seasonTheme,
        coreConflict: seasonForm.coreConflict,
        structureType: 'linear',
        episodeCount: seasonForm.episodes.length,
        episodes: seasonForm.episodes,
        foreshadowingPlan: season.value?.foreshadowingPlan || [],
        characterArcs: season.value?.characterArcs || [],
      }),
      (value) => ({
        versionNo: value.item.versionNo,
        episodeCount: value.item.episodes.length,
        changed: ['分集大纲手动修改已保存'],
      }),
      { target: '确认分集大纲' },
    )
    syncSeason(result.item)
    stage.value = 'script'
    notice.value = '分集大纲已保存，现在可以编辑剧本正文。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '分集大纲保存失败'
  } finally {
    busy.value = false
  }
}

async function createScripts(): Promise<void> {
  if (busy.value) return
  if (sceneDrafts.value.length && !window.confirm('重新生成场景会覆盖当前场景列表、剧本和分镜，确定继续吗？')) return
  busy.value = true
  error.value = ''
  try {
    const generated = await runScriptAgentAction(
      'generate-script',
      'script',
      () => generateScenes(projectId.value, {
        confirmRegenerate: sceneDrafts.value.length > 0,
      }),
      (value) => ({
        sceneCount: value.length,
        changed: ['场景顺序', '场景摘要', '剧本正文待生成状态'],
      }),
      { target: '剧本正文', regenerate: sceneDrafts.value.length > 0 },
    )
    sceneDrafts.value = generated.map((scene) => ({
      id: scene.id,
      sceneNo: scene.sceneNo,
      title: scene.title || '',
      summary: scene.summary || '',
      content: scene.content || '',
      mood: scene.mood || '',
      location: scene.location || '',
      timeOfDay: scene.timeOfDay || '',
      estimatedDuration: scene.estimatedDuration ?? null,
    }))
    scenes.value = generated
    activeSceneId.value = generated[0]?.id || null
    notice.value = generated.length ? '场景列表已生成，可以逐场生成正文。' : '当前分集大纲没有生成场景。'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '场景列表生成失败'
  } finally {
    busy.value = false
  }
}

async function generateScene(
  scene: (typeof sceneDrafts.value)[number],
): Promise<void> {
  if (busy.value || generatingSceneId.value) return
  generatingSceneId.value = scene.id
  error.value = ''
  try {
    const generated = await runScriptAgentAction(
      'generate-scene',
      'script',
      () => import('@/api/project').then(({ generateSceneScript }) =>
        generateSceneScript(scene.id),
      ),
      (value) => ({
        sceneCount: 1,
        changed: [`场景 ${String(scene.sceneNo).padStart(2, '0')} 正文`],
      }),
      { target: `场景 ${String(scene.sceneNo).padStart(2, '0')}`, sceneId: scene.id },
    )
    scene.title = generated.title || scene.title
    scene.summary = generated.summary || scene.summary
    scene.content = generated.content || ''
    scene.mood = generated.mood || scene.mood
    scene.location = generated.location || scene.location
    scene.timeOfDay = generated.timeOfDay || scene.timeOfDay
    scene.estimatedDuration = generated.estimatedDuration ?? scene.estimatedDuration
    notice.value = `场景 ${String(scene.sceneNo).padStart(2, '0')} 正文已生成。`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '场景正文生成失败'
  } finally {
    generatingSceneId.value = null
  }
}

async function generateAllSceneScripts(): Promise<void> {
  if (busy.value || batchScriptState.running || generatingSceneId.value) return
  const pendingScenes = sceneDrafts.value.filter((scene) => !scene.content.trim())
  if (!pendingScenes.length) {
    notice.value = '所有场景都已有正文，无需重复生成。'
    return
  }

  const failedIds = new Set(batchScriptState.failedSceneIds)
  const queue = failedIds.size
    ? pendingScenes.filter((scene) => failedIds.has(scene.id))
    : pendingScenes
  batchScriptState.running = true
  batchScriptState.total = queue.length
  batchScriptState.current = 0
  batchScriptState.completed = 0
  batchScriptState.skipped = sceneDrafts.value.length - pendingScenes.length
  batchScriptState.failedSceneIds = []
  error.value = ''
  let activityId: number | null = null

  try {
    activityId = await startAgentActivity('generate-all-scenes', 'script', {
      totalScenes: queue.length,
      skippedScenes: batchScriptState.skipped,
      resume: failedIds.size > 0,
    })
    for (let index = 0; index < queue.length; index += 1) {
      const scene = queue[index]
      if (!scene) continue
      batchScriptState.current = index + 1
      generatingSceneId.value = scene.id
      try {
        const generated = await import('@/api/project').then(({ generateSceneScript }) =>
          generateSceneScript(scene.id),
        )
        scene.title = generated.title || scene.title
        scene.summary = generated.summary || scene.summary
        scene.content = generated.content || ''
        scene.mood = generated.mood || scene.mood
        scene.location = generated.location || scene.location
        scene.timeOfDay = generated.timeOfDay || scene.timeOfDay
        scene.estimatedDuration = generated.estimatedDuration ?? scene.estimatedDuration
        batchScriptState.completed += 1
      } catch (cause) {
        batchScriptState.failedSceneIds.push(scene.id)
        const message = cause instanceof Error ? cause.message : '正文生成失败'
        await finishAgentActivity(activityId, 'fail', {
          errorText: `场景 ${String(scene.sceneNo).padStart(2, '0')}：${message}`,
          context: activityContext({
            completedScenes: batchScriptState.completed,
            failedSceneIds: [...batchScriptState.failedSceneIds],
            nextSceneId: scene.id,
            totalScenes: queue.length,
          }),
        })
        activityId = null
        error.value = `批量生成在场景 ${String(scene.sceneNo).padStart(2, '0')} 暂停：${message}`
        return
      } finally {
        generatingSceneId.value = null
      }
    }

    await finishAgentActivity(activityId, 'complete', {
      summary: `已逐场生成 ${batchScriptState.completed} 场正文。`,
      context: activityContext({
        completedScenes: batchScriptState.completed,
        skippedScenes: batchScriptState.skipped,
        totalScenes: queue.length,
      }),
      result: {
        sceneCount: batchScriptState.completed,
        changed: [`逐场生成 ${batchScriptState.completed} 场正文`, `跳过 ${batchScriptState.skipped} 场已有正文`],
      },
    })
    notice.value = `批量生成完成：新增 ${batchScriptState.completed} 场正文，跳过 ${batchScriptState.skipped} 场已有正文。`
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '批量生成失败'
    error.value = message
    if (activityId) {
      await finishAgentActivity(activityId, 'fail', {
        errorText: message,
        context: activityContext({ completedScenes: batchScriptState.completed, totalScenes: queue.length }),
      })
    }
  } finally {
    batchScriptState.running = false
    generatingSceneId.value = null
  }
}

async function saveScripts(): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  error.value = ''
  try {
    await runScriptAgentAction(
      'save-script',
      'script',
      async () => {
        for (const scene of sceneDrafts.value) {
          await updateScene(scene.id, {
            title: scene.title,
            summary: scene.summary,
            location: scene.location || null,
            timeOfDay: scene.timeOfDay || null,
            estimatedDuration: scene.estimatedDuration,
          })
          await saveSceneScript(scene.id, { title: scene.title, content: scene.content, mood: scene.mood })
        }
        return { sceneCount: sceneDrafts.value.length }
      },
      (value) => ({
        sceneCount: value.sceneCount,
        changed: ['场景元数据', '剧本正文', '手动修改'],
      }),
      { target: '全部剧本正文', sceneCount: sceneDrafts.value.length },
    )
    scriptParseReady.value = false
    parseResult.value = null
    notice.value = '剧本草稿已保存。'
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '剧本保存失败'
    return false
  } finally {
    busy.value = false
  }
}

async function parseScriptAssets(): Promise<void> {
  if (parsingAssets.value || !projectId.value || !sceneDrafts.value.length) return
  parsingAssets.value = true
  parseError.value = ''
  notice.value = ''
  try {
    const result = await runScriptAgentAction(
      'parse-assets',
      'script',
      async () => {
        const [scenes, existingCanvas, currentCharacters] = await Promise.all([
          listScenes(projectId.value),
          getAssetCanvas(projectId.value),
          listCharacters(projectId.value),
        ])
        let characters = currentCharacters
        const reusedExistingCharacters = canReuseCurrentScriptAssets({
          characters: currentCharacters,
          scenes,
          nodes: existingCanvas.nodes,
        })
        if (!reusedExistingCharacters) {
          characters = await generateProjectCharacters(projectId.value)
        }
        const existingCharacterRefs = new Set(
          existingCanvas.nodes.filter((node) => node.nodeType === 'character').map((node) => node.refId),
        )
        await Promise.all(
          characters
            .filter((character) => character.id && !existingCharacterRefs.has(character.id))
            .map((character, index) =>
              createAssetNode(projectId.value, {
                nodeType: 'character',
                refId: character.id,
                label: character.name,
                groupKey: `character:${character.id}`,
                x: 80 + (index % 4) * 260,
                y: 80 + Math.floor(index / 4) * 320,
              }),
            ),
        )
        const existingSceneNodes = existingCanvas.nodes.filter((node) => node.nodeType === 'scene')
        const sceneTitleCounts = new Map<string, number>()
        for (const scene of scenes) {
          const title = scene.title?.trim() || ''
          if (title) sceneTitleCounts.set(title, (sceneTitleCounts.get(title) || 0) + 1)
        }
        await Promise.all(
          scenes
            .filter((scene) => !existingSceneNodes.some((node) =>
              node.refId === scene.id
              || node.groupKey === `scene:${scene.id}`
              || node.groupKey === `scene:${scene.id}:default`
              || (sceneTitleCounts.get(scene.title?.trim() || '') === 1 && node.label.trim() === scene.title?.trim()),
            ))
            .map((scene, index) =>
              createAssetNode(projectId.value, {
                nodeType: 'scene',
                refId: scene.id,
                groupKey: `scene:${scene.id}`,
                label: scene.title?.trim() || `场景 ${scene.sceneNo}`,
                appearanceLabel: [scene.location, scene.timeOfDay].filter(Boolean).join(' · ') || null,
                x: 80 + (index % 4) * 260,
                y: 520 + Math.floor(index / 4) * 320,
              }),
            ),
        )
        await confirmProjectScriptParsed(projectId.value)
        return { characters: characters.length, scenes: scenes.length, reusedExistingCharacters }
      },
      (value) => ({
        characterCount: value.characters,
        sceneCount: value.scenes,
        changed: value.reusedExistingCharacters
          ? ['复用现有角色与场景资产节点', '校验并记录当前剧本版本']
          : ['角色资产节点', '场景资产节点', '剧本出场关系'],
      }),
      { target: '资产管理', sourceScriptScenes: sceneDrafts.value.length },
    )
    parseResult.value = { characters: result.characters, scenes: result.scenes }
    scriptParseReady.value = true
    notice.value = result.reusedExistingCharacters
      ? `已复用现有 ${result.characters} 个角色、${result.scenes} 个场景，并校验当前剧本版本。现在可以进入资产管理继续整理。`
      : `剧本解析完成，已提取 ${result.characters} 个角色、${result.scenes} 个场景。现在可以进入资产管理继续整理。`
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '剧本解析失败，请稍后重试。'
    parseError.value = /501|尚未在 FastAPI 网关实现/.test(message)
      ? '角色自动解析接口尚未迁移到当前后端（HTTP 501）。剧本不会丢失；保存成功后可继续进入资产管理，手动添加角色和场景。'
      : message
  } finally {
    parsingAssets.value = false
  }
}

function goIdea(): void {
  router.push({
    path: '/workspace/studio/idea',
    query: {
      projectId: String(projectId.value),
      episodeCount: String(episodeCount.value),
    },
  })
}

onMounted(() => {
  if (typeof route.query.gateReason === 'string') notice.value = route.query.gateReason
  if (route.query.gateCheckFailed === '1') {
    notice.value = '暂时无法核验项目流程状态，已为安全起见锁定后续阶段。请刷新后重试。'
  }
  void load()
  void loadTextModels()
})
onBeforeUnmount(() => {
  clearNoticeTimer()
})
</script>

<template>
  <WorkspaceLayout :show-side="false" :show-inspector="false" :no-padding="true">
    <div v-if="true" class="script-shell">
      <section class="script-workspace">
        <header class="workbench-header">
          <div class="workbench-title">
            <span class="workbench-eyebrow">剧本</span>
            <h1>{{ project?.name || '剧本' }}</h1>
          </div>
          <span class="workbench-count">剧本累计生成{{ bibleForm.mainPlot.length + bibleForm.logline.length }}字</span>
        </header>

        <nav class="workbench-tabs" aria-label="剧本阶段">
          <button
            v-for="(item, index) in [
              { key: 'bible', label: '故事设定', icon: 'account_tree' },
              { key: 'season', label: '分集大纲', icon: 'view_list' },
              { key: 'script', label: '剧本正文', icon: 'description' },
            ]"
            :key="item.key"
            type="button"
            class="workbench-tab"
            :class="{ active: stage === item.key, done: index < stageIndex }"
            @click="stage = item.key as Stage"
          >
            <span class="material-symbols-outlined">{{ stage === item.key ? item.icon : index < stageIndex ? 'check' : 'add' }}</span>
            {{ item.label }}
          </button>
        </nav>

        <div v-if="error || notice" class="workbench-feedback" :class="{ 'feedback-error': Boolean(error), 'feedback-success': !error && Boolean(notice) }">
          <div v-if="error" class="workbench-alert" role="alert">
            <span class="material-symbols-outlined">error</span>
            <div>
              <strong>{{ error }}</strong>
              <small v-if="busy">当前任务仍在处理，请不要重复提交。</small>
              <small v-else-if="isAiError">创意内容已保留，可以检查模型设置后重新生成。</small>
            </div>
            <button v-if="!busy && isAiError" type="button" class="alert-link" @click="router.push({ path: '/settings/ai', query: { from: route.fullPath } })">打开模型设置</button>
          </div>
          <div v-else-if="notice" class="workbench-notice" role="status" aria-live="polite">
            <span class="material-symbols-outlined">check_circle</span>
            <span>{{ notice }}</span>
            <button type="button" class="notice-dismiss" aria-label="关闭提示" title="关闭提示" @click="dismissNotice">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>

        <div class="workspace-canvas">
          <section v-if="!loading && stage === 'bible'" class="stage-pane">
            <div v-if="!bible" class="stage-empty">
              <div class="empty-mark"><span class="material-symbols-outlined">auto_stories</span></div>
              <span class="empty-stage-label">STORY BIBLE · 等待建立</span>
              <p>故事档案还没有内容</p>
              <small>可以在右侧和 Agent 描述人物、世界与核心冲突，或直接从创意生成故事设定。</small>
              <button type="button" class="empty-action" :disabled="busy || !idea.trim()" @click="generateBible">
                <span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '正在生成故事设定' : '生成故事设定' }}
              </button>
            </div>
            <div v-else class="story-dossier">
              <header class="dossier-heading">
                <div>
                  <span class="pane-kicker">Story bible · v{{ bible?.versionNo || 1 }}</span>
                  <h2>{{ bibleForm.title || '未命名故事' }}</h2>
                  <p>一份可以继续修改、也可以交给后续 Agent 生产的故事档案。</p>
                </div>
                <div class="dossier-heading-actions">
                  <span class="saved-state"><span class="material-symbols-outlined">cloud_done</span>已保存草稿</span>
                  <button type="button" class="dossier-edit-button" @click="bibleEditMode = !bibleEditMode">
                    <span class="material-symbols-outlined">{{ bibleEditMode ? 'visibility' : 'edit' }}</span>{{ bibleEditMode ? '回到阅读' : '编辑设定' }}
                  </button>
                </div>
              </header>

              <div class="dossier-meta-grid">
                <div class="dossier-meta-item"><span>集数</span><strong>{{ episodeCount }}</strong><small>集连续叙事</small></div>
                <div class="dossier-meta-item"><span>目标受众</span><strong>{{ truncateText(bibleForm.audience, 22) }}</strong><small>内容定位</small></div>
                <div class="dossier-meta-item"><span>核心基调</span><strong>{{ truncateText(storyPitchLabel, 22) }}</strong><small>情绪方向</small></div>
                <div class="dossier-meta-item"><span>故事类型</span><strong>{{ storyTypeLabel }}</strong><small>{{ storyBodyCount }} 字设定内容</small></div>
              </div>

              <section class="dossier-section dossier-lead-section">
                <div class="dossier-section-label"><span>01</span><strong>一句话故事</strong></div>
                <textarea v-if="bibleEditMode" v-model="bibleForm.logline" class="dossier-editable dossier-lead-copy" rows="3" placeholder="主角、困境和钩子"></textarea>
                <p v-else class="dossier-lead-copy">{{ bibleForm.logline || '还没有一句话故事，点击“编辑设定”补充。' }}</p>
              </section>

              <section class="dossier-section">
                <div class="dossier-section-label"><span>02</span><strong>故事梗概</strong></div>
                <textarea v-if="bibleEditMode" v-model="bibleForm.mainPlot" class="dossier-editable dossier-body-copy" rows="12" placeholder="完整描述主线冲突和推进"></textarea>
                <div v-else class="dossier-body-copy dossier-prose">
                  <p v-for="(paragraph, index) in bibleForm.mainPlot.split(/\n+/).filter(Boolean)" :key="index">{{ paragraph }}</p>
                  <p v-if="!bibleForm.mainPlot">还没有故事梗概，点击“编辑设定”补充。</p>
                </div>
              </section>

              <section class="dossier-anchor-strip">
                <div>
                  <span>叙事锚点</span>
                  <strong>{{ bibleForm.emotionalPromise || '让观众知道这部故事会带他们走向哪里。' }}</strong>
                </div>
                <div class="dossier-tags">
                  <span v-for="item in (bible?.visualSymbols || []).slice(0, 4)" :key="item">{{ item }}</span>
                  <span v-if="!(bible?.visualSymbols || []).length">待补充视觉符号</span>
                </div>
              </section>

              <section class="dossier-section dossier-characters">
                <div class="dossier-section-label dossier-section-label-row">
                  <div><span>03</span><strong>人物小传</strong></div>
                  <div class="dossier-section-tools"><span>{{ bibleForm.characters.length }} 位角色</span><button type="button" class="section-link" @click="addCharacter"><span class="material-symbols-outlined">person_add</span>添加角色</button></div>
                </div>
                <article v-for="(character, index) in bibleForm.characters" :key="index" class="dossier-character">
                  <header class="character-heading">
                    <div><span class="character-number">{{ String(index + 1).padStart(2, '0') }}</span><h3 v-if="!bibleEditMode">{{ character.name || '未命名角色' }}</h3><input v-else v-model="character.name" aria-label="角色姓名" placeholder="姓名" /></div>
                    <button type="button" class="icon-action" aria-label="删除角色" title="删除角色" @click="removeCharacter(index)"><span class="material-symbols-outlined">delete</span></button>
                  </header>
                  <p v-if="!bibleEditMode" class="character-role">{{ character.role || '角色定位待补充' }}</p>
                  <input v-else v-model="character.role" class="dossier-editable character-role-input" aria-label="角色定位" placeholder="角色定位" />
                  <div class="character-detail-grid">
                    <div><span>视觉形象</span><p v-if="!bibleEditMode">{{ character.visualDescription || '待补充' }}</p><textarea v-else v-model="character.visualDescription" class="dossier-editable" rows="3" aria-label="角色外貌" placeholder="外貌与服装"></textarea></div>
                    <div><span>核心目标</span><p v-if="!bibleEditMode">{{ character.goal || '待补充' }}</p><textarea v-else v-model="character.goal" class="dossier-editable" rows="3" aria-label="角色目标" placeholder="角色目标"></textarea></div>
                    <div><span>恐惧与秘密</span><p v-if="!bibleEditMode">{{ [character.fear, character.secret].filter(Boolean).join('；') || '待补充' }}</p><textarea v-else v-model="character.fear" class="dossier-editable" rows="3" aria-label="角色恐惧" placeholder="角色恐惧"></textarea></div>
                    <div><span>成长弧线</span><p v-if="!bibleEditMode">{{ character.growthArc || '待补充' }}</p><textarea v-else v-model="character.growthArc" class="dossier-editable" rows="3" aria-label="角色成长" placeholder="成长弧线"></textarea></div>
                  </div>
                </article>
                <p v-if="!bibleForm.characters.length" class="compact-empty">点击“添加角色”建立人物档案。</p>
              </section>
            </div>
          </section>

          <section v-else-if="!loading && stage === 'season'" class="stage-pane">
            <div class="season-reader">
              <header class="season-reader-head">
                <div>
                  <div class="reader-title-line">
                    <span class="reader-mark">DRAFT / {{ String(season?.versionNo || 1).padStart(2, '0') }}</span>
                    <span class="reader-status"><span class="material-symbols-outlined">auto_awesome</span>{{ season?.status === 'locked' ? '已确认' : '可继续修改' }}</span>
                  </div>
                  <h2>分集大纲</h2>
                  <p>把整季故事拆成一段段会发生变化的旅程。先读一遍，再决定哪里需要重新落笔。</p>
                </div>
                <div class="reader-actions">
                  <button type="button" class="reader-secondary" :disabled="busy" @click="createSeason"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : '重新生成' }}</button>
                  <button type="button" class="reader-primary" @click="seasonEditMode = !seasonEditMode"><span class="material-symbols-outlined">{{ seasonEditMode ? 'visibility' : 'edit' }}</span>{{ seasonEditMode ? '阅读大纲' : '编辑大纲' }}</button>
                </div>
              </header>

              <div v-if="seasonEditMode" class="season-edit-panel">
                <div class="compact-grid">
                  <label class="compact-field"><span>整季主题</span><textarea v-model="seasonForm.seasonTheme" rows="4" placeholder="这一季真正想讲什么"></textarea></label>
                  <label class="compact-field"><span>核心冲突</span><textarea v-model="seasonForm.coreConflict" rows="4" placeholder="什么力量会持续把人物推向选择"></textarea></label>
                </div>
                <div class="compact-section">
                  <div class="section-heading"><strong>分集推进</strong><span>{{ seasonForm.episodes.length }} 集</span></div>
                  <article v-for="episode in seasonForm.episodes" :key="episode.episodeNo" class="compact-episode">
                    <div class="episode-index">EP {{ String(episode.episodeNo).padStart(2, '0') }}</div>
                    <input v-model="episode.title" placeholder="本集标题" />
                    <textarea v-model="episode.logline" rows="2" placeholder="本集一句话大纲"></textarea>
                    <textarea v-model="episode.coreConflict" rows="2" placeholder="本集核心冲突"></textarea>
                    <textarea v-model="episode.endingHook" rows="2" placeholder="结尾钩子"></textarea>
                  </article>
                  <p v-if="!seasonForm.episodes.length" class="compact-empty">从右侧告诉 Agent “生成分集大纲”。</p>
                </div>
              </div>

              <div v-else-if="seasonForm.episodes.length" class="outline-reader">
                <section class="outline-context">
                  <div><span>整季主题</span><strong>{{ seasonForm.seasonTheme || '待补充整季主题' }}</strong></div>
                  <div><span>核心冲突</span><strong>{{ seasonForm.coreConflict || '待补充核心冲突' }}</strong></div>
                </section>
                <div class="outline-episode-list">
                  <article v-for="episode in seasonForm.episodes" :key="episode.episodeNo" class="outline-episode">
                    <div class="outline-episode-index">{{ String(episode.episodeNo).padStart(2, '0') }}</div>
                    <div class="outline-episode-copy">
                      <div class="outline-episode-heading">
                        <span>第 {{ episode.episodeNo }} 集</span>
                        <h3>{{ episode.title || '未命名章节' }}</h3>
                      </div>
                      <p class="outline-logline">{{ episode.logline || '这一集还没有一句话大纲。' }}</p>
                      <div class="outline-narrative-grid">
                        <div><span>本集目标</span><p>{{ episode.goal || '待补充' }}</p></div>
                        <div><span>核心冲突</span><p>{{ episode.coreConflict || '待补充' }}</p></div>
                        <div><span>不可逆变化</span><p>{{ episode.irreversibleChange || '待补充' }}</p></div>
                        <div><span>主角选择</span><p>{{ episode.protagonistChoice || '待补充' }}</p></div>
                      </div>
                      <div class="outline-hook"><span class="material-symbols-outlined">south</span><div><span>结尾钩子</span><strong>{{ episode.endingHook || '待补充' }}</strong></div></div>
                    </div>
                  </article>
                </div>
              </div>
            <div v-else class="stage-empty stage-empty-inline">
                <div class="empty-mark"><span class="material-symbols-outlined">view_list</span></div>
                <span class="empty-stage-label">SEASON OUTLINE · 等待展开</span>
                <p>还没有分集大纲</p>
                <small>{{ bible ? '点击下方生成，或从右侧告诉 Agent 开始拆分故事。' : '先完成故事设定，再回来生成分集大纲。你仍然可以提前查看这个阶段。' }}</small>
                <button type="button" class="empty-action" :disabled="busy || !bible" @click="createSeason">
                  <span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '正在生成分集大纲' : bible ? '生成分集大纲' : '等待故事设定' }}
                </button>
              </div>
            </div>
          </section>

          <section v-else-if="!loading" class="stage-pane">
            <div class="script-reader">
              <header class="script-reader-head">
                <div>
                  <div class="reader-title-line">
                    <span class="reader-mark">MANUSCRIPT / {{ String(sceneDrafts.length).padStart(2, '0') }} SCENES</span>
                    <span class="reader-status"><span class="material-symbols-outlined">edit_note</span>{{ sceneDrafts.length ? '正式草稿' : '等待生成' }}</span>
                  </div>
                  <h2>剧本正文</h2>
                  <p>从场景顺序读完整部故事，也可以只打开一场戏，调整它的节奏、氛围和对白。</p>
                </div>
                <div class="reader-actions">
                  <button type="button" class="reader-secondary" :disabled="busy" @click="createScripts"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : sceneDrafts.length ? '重新生成场景' : '生成场景' }}</button>
                  <button v-if="sceneDrafts.length" type="button" class="reader-secondary" :disabled="busy || batchScriptState.running || !sceneDrafts.some((scene) => !scene.content.trim())" @click="generateAllSceneScripts">
                    <span v-if="batchScriptState.running" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">playlist_play</span>
                    {{ batchScriptState.running ? `生成第 ${batchScriptState.current} / ${batchScriptState.total} 场` : '生成全部正文' }}
                  </button>
                  <button v-if="scriptEditMode" type="button" class="reader-secondary" :disabled="busy || !sceneDrafts.length" @click="saveScripts"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">save</span>{{ busy ? '保存中' : '保存正文' }}</button>
                  <button type="button" class="reader-primary" :disabled="busy || !sceneDrafts.length" @click="scriptEditMode = !scriptEditMode"><span class="material-symbols-outlined">{{ scriptEditMode ? 'visibility' : 'edit' }}</span>{{ scriptEditMode ? '阅读正文' : '编辑正文' }}</button>
                </div>
              </header>

              <div v-if="scriptEditMode && activeScene" class="script-edit-panel">
                 <div class="script-edit-heading"><div><span>正在编辑</span><strong>场景 {{ String(activeScene.sceneNo).padStart(2, '0') }} · {{ activeScene.title || '未命名场景' }}</strong></div><button type="button" class="inline-secondary" :disabled="busy || generatingSceneId !== null" @click="generateScene(activeScene)"><span v-if="generatingSceneId === activeScene.id" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ generatingSceneId === activeScene.id ? '生成中' : '让 Agent 重写本场' }}</button></div>
                <div class="script-edit-grid">
                  <label><span>场景标题</span><input v-model="activeScene.title" placeholder="场景标题" /></label>
                  <label><span>场景摘要</span><textarea v-model="activeScene.summary" rows="3" placeholder="这一场戏发生了什么"></textarea></label>
                  <label><span>地点</span><input v-model="activeScene.location" placeholder="地点"></label>
                  <label><span>时间</span><input v-model="activeScene.timeOfDay" placeholder="时间段"></label>
                  <label><span>氛围</span><input v-model="activeScene.mood" placeholder="氛围与情绪"></label>
                  <label><span>预计时长（秒）</span><input v-model.number="activeScene.estimatedDuration" type="number" min="1" placeholder="例如 30"></label>
                </div>
                <label class="script-edit-content"><span>剧本正文</span><textarea v-model="activeScene.content" rows="18" placeholder="按场景、动作、对白和旁白写下正文"></textarea></label>
              </div>

              <div v-else-if="sceneDrafts.length" class="manuscript-layout">
                <aside class="script-reader-sidebar">
                  <div class="sidebar-heading"><span>分集剧本</span><strong>{{ sceneDrafts.length }} 场</strong></div>
                  <div class="scene-nav-list">
                    <button v-for="scene in sceneDrafts" :key="scene.id" type="button" class="scene-nav-item" :class="{ active: activeScene?.id === scene.id }" @click="selectScene(scene.id)">
                      <span class="scene-nav-number">{{ String(scene.sceneNo).padStart(2, '0') }}</span>
                      <span class="scene-nav-copy"><strong>{{ scene.title || '未命名场景' }}</strong><small>{{ truncateText(scene.summary, 32) }}</small></span>
                      <span class="material-symbols-outlined">chevron_right</span>
                    </button>
                  </div>
                </aside>
                <article v-if="activeScene" class="manuscript-paper">
                  <header class="manuscript-header">
                    <div>
                      <span class="manuscript-scene-label">场景 {{ String(activeScene.sceneNo).padStart(2, '0') }}</span>
                      <h3>{{ activeScene.title || '未命名场景' }}</h3>
                      <p>{{ activeScene.summary || '这场戏还没有摘要。' }}</p>
                    </div>
                    <button type="button" class="paper-edit-button" @click="scriptEditMode = true"><span class="material-symbols-outlined">edit</span>编辑本场</button>
                  </header>
                  <div class="manuscript-meta">
                    <span><i class="material-symbols-outlined">location_on</i>{{ activeScene.location || '地点待补充' }}</span>
                    <span><i class="material-symbols-outlined">schedule</i>{{ activeScene.timeOfDay || '时间待补充' }}</span>
                    <span><i class="material-symbols-outlined">graphic_eq</i>{{ activeScene.mood || '氛围待补充' }}</span>
                    <span><i class="material-symbols-outlined">timer</i>{{ activeScene.estimatedDuration ? `${activeScene.estimatedDuration} 秒` : '时长待补充' }}</span>
                  </div>
          <div v-if="activeSceneBlocks.length" class="manuscript-body">
                    <p v-for="(block, index) in activeSceneBlocks" :key="index" :class="{ 'script-line-heading': isScriptHeading(block), 'script-line-dialogue': isScriptDialogue(block), 'script-line-action': isScriptAction(block) }">{{ cleanScriptBlock(block) }}</p>
                  </div>
                   <div v-else class="manuscript-empty"><span class="material-symbols-outlined">edit_note</span><strong>这场戏还没有正文</strong><button type="button" class="reader-primary" :disabled="busy || generatingSceneId !== null" @click="generateScene(activeScene)"><span v-if="generatingSceneId === activeScene.id" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ generatingSceneId === activeScene.id ? '生成中' : '生成本场正文' }}</button></div>
                </article>
              </div>
              <div v-else class="stage-empty stage-empty-inline">
                <div class="empty-mark"><span class="material-symbols-outlined">description</span></div>
                <span class="empty-stage-label">MANUSCRIPT · 等待落笔</span>
                <p>还没有剧本场景</p>
                <small>{{ seasonForm.episodes.length ? '点击下方生成场景，让 Agent 依据分集大纲拆解剧本。' : '先完成分集大纲，再回来生成剧本正文。你仍然可以提前查看这个阶段。' }}</small>
                <button type="button" class="empty-action" :disabled="busy || !seasonForm.episodes.length" @click="createScripts">
                  <span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '正在生成场景' : seasonForm.episodes.length ? '生成场景' : '等待分集大纲' }}
                </button>
              </div>
            </div>
          </section>
          <div v-else class="stage-loading">正在读取剧本工作区…</div>
        </div>

        <footer class="workspace-bottom-bar">
          <div class="bottom-copy">
            <strong>{{ stage === 'bible' ? (bible ? '故事设定已建立，可以继续回看或修改。' : '先建立故事设定，再让 Agent 展开后续创作。') : stage === 'season' ? (seasonForm.episodes.length ? '分集大纲可以继续微调，确认后进入剧本正文。' : '分集大纲暂为空，可以先查看结构，再开始生成。') : (sceneDrafts.length ? '剧本正文可以逐场回看、修改和保存。' : '剧本正文暂为空，可以先查看阅读器，再开始生成。') }}</strong>
            <small>{{ parsingAssets ? '正在解析剧本中的角色、场景和叙事关系，请稍候。' : parseError ? `解析失败：${parseError}` : parseResult ? `剧本解析完成：${parseResult.characters} 个角色 · ${parseResult.scenes} 个场景` : busy ? 'Agent 正在处理，请稍候。' : '三个阶段都可以随时查看，内容生成后仍可手动修改。' }}</small>
          </div>
          <div class="bottom-actions">
            <button v-if="stage === 'bible'" type="button" class="bottom-primary" :disabled="busy || !idea.trim()" @click="generateBible"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : bible ? '重新生成故事设定' : '生成故事设定' }}</button>
            <button v-else-if="stage === 'season' && !seasonForm.episodes.length" type="button" class="bottom-primary" :disabled="busy || !bible" @click="createSeason"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : '生成分集大纲' }}</button>
            <button v-else-if="stage === 'season'" type="button" class="bottom-primary" :disabled="busy || !canAdvanceSeason" @click="saveSeasonAndOpenScript"><span class="material-symbols-outlined">arrow_forward</span>确认并进入剧本正文</button>
            <button v-else-if="stage === 'script' && !sceneDrafts.length" type="button" class="bottom-primary" :disabled="busy || !seasonForm.episodes.length" @click="createScripts"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : '生成场景' }}</button>
            <template v-else>
              <button type="button" class="bottom-secondary bottom-parse" :disabled="parsingAssets" @click="parseScriptAssets">
                <span v-if="parsingAssets" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">{{ parseResult ? 'check_circle' : 'account_tree' }}</span>
                {{ parsingAssets ? '正在解析剧本' : parseResult ? '剧本解析完成' : parseError ? '重新解析剧本' : '解析剧本' }}
              </button>
              <button type="button" class="bottom-primary" :disabled="!canEnterAssets" :title="canEnterAssets ? '进入前自动保存；解析失败不阻断资产管理' : '请补齐全部剧本正文并等待当前操作结束'" @click="openAssets"><span class="material-symbols-outlined">{{ canEnterAssets ? 'arrow_forward' : 'lock' }}</span>进入资产管理</button>
            </template>
            <button v-if="stage === 'bible' && bible" type="button" class="bottom-secondary" :disabled="busy || !canAdvanceBible" @click="saveBibleAndAdvance">确认故事设定 <span class="material-symbols-outlined">arrow_forward</span></button>
          </div>
        </footer>
      </section>

      <aside class="agent-dock">
        <header class="agent-header">
          <div class="agent-identity"><span class="agent-badge">镜</span><strong>镜语编导</strong><small>实时编排 Agent</small></div>
          <button type="button" class="agent-icon-button" aria-label="模型设置" title="模型设置" @click="router.push({ path: '/settings/ai', query: { from: route.fullPath } })"><span class="material-symbols-outlined">tune</span></button>
        </header>
        <div ref="agentScroll" class="agent-scroll">
          <div class="agent-welcome">
            <span class="agent-credit">{{ project?.name || '当前项目' }}</span>
            <p>我会读取当前项目的版本和页面动作。你点击生成、保存或解析后，我会同步记录、检查结果，并把下一步操作放回这里。</p>
            <p>这里展示的是实际执行轨迹，不是普通聊天记录：</p>
            <ul>
              <li>动作开始时显示正在处理</li>
              <li>完成后显示版本、数量和变更项</li>
              <li>失败时保留原因，并提供重试</li>
            </ul>
            <p class="agent-context-line"><span class="material-symbols-outlined">hub</span>当前上下文：{{ agentStageLabel }} · {{ episodeCount }} 集目标 <span v-if="agentWorking" class="agent-live-dot">执行中</span></p>
          </div>
          <p v-if="agentActivityError" class="agent-sync-warning"><span class="material-symbols-outlined">cloud_off</span>{{ agentActivityError }}</p>
          <section v-if="agentActivities.length" class="agent-activity-section" aria-live="polite">
                  <div class="agent-section-heading">
                   <span>执行轨迹</span>
                   <div class="agent-section-actions">
                     <small>{{ agentActivities.length }} 条记录</small>
                     <button v-if="hiddenFailureCount > 1" type="button" class="agent-tool-button" @click="showFailedAgentActivities = !showFailedAgentActivities">
                       {{ showFailedAgentActivities ? '收起失败记录' : `展开失败记录（${hiddenFailureCount}）` }}
                     </button>
                     <button v-if="agentActivities.some((activity) => activity.status === 'failed')" type="button" class="agent-tool-button" @click="hiddenAgentActivityIds = [...new Set([...hiddenAgentActivityIds, ...agentActivities.filter((activity) => activity.status === 'failed').map((activity) => activity.id)])]">
                       清理失败展示
                     </button>
                   </div>
                 </div>
                 <TransitionGroup name="agent-activity" tag="div" class="agent-activity-feed">
               <article v-for="activity in visibleAgentActivities" :key="activity.id" class="agent-activity-card" :class="[`agent-activity-${activity.status}`, `agent-tone-${activity.reaction.tone}`]">
                <div class="agent-activity-heading">
                  <span class="agent-activity-state"><span v-if="activity.status === 'running'" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">{{ activity.status === 'completed' ? 'check_circle' : activity.status === 'failed' ? 'error' : 'pause_circle' }}</span>{{ activity.status === 'running' ? '执行中' : activity.status === 'completed' ? '已完成' : activity.status === 'failed' ? '失败' : '需处理' }}</span>
                  <time>{{ activity.agentKey }}</time>
                </div>
                <strong>{{ activity.reaction.headline || activity.title }}</strong>
                <p>{{ activity.reaction.message || activity.summary }}</p>
                <ul v-if="activity.reaction.facts?.length" class="agent-activity-facts">
                  <li v-for="fact in activity.reaction.facts.slice(0, 4)" :key="fact">{{ fact }}</li>
                </ul>
                <div v-if="activity.reaction.nextActions?.length" class="agent-next-actions">
                  <button v-for="action in activity.reaction.nextActions.slice(0, 3)" :key="action.key" type="button" @click="runAgentNextAction(action.actionKey)">
                    {{ action.label }}<span class="material-symbols-outlined">arrow_forward</span>
                  </button>
                </div>
              </article>
            </TransitionGroup>
          </section>
          <div v-for="(message, index) in agentMessages" :key="`${message.role}-${index}`" class="agent-message" :class="`agent-message-${message.role}`">
            <span v-if="message.role === 'assistant'" class="agent-mini-avatar">短</span>
            <p>{{ message.text }}</p>
          </div>
        </div>
        <form class="agent-composer" @submit.prevent="sendAgentMessage">
          <div v-if="agentMenuOpen" class="agent-command-menu">
            <button type="button" @click="insertAgentPrompt('请生成故事设定')"><span class="material-symbols-outlined">auto_awesome</span>生成故事设定</button>
            <button type="button" @click="insertAgentPrompt('请生成分集大纲')"><span class="material-symbols-outlined">view_list</span>生成分集大纲</button>
            <button type="button" @click="insertAgentPrompt('请修改当前故事设定')"><span class="material-symbols-outlined">edit</span>修改当前设定</button>
          </div>
          <textarea v-model="agentInput" rows="2" placeholder="例如：生成分集大纲，或把第三集结尾改得更悬疑"></textarea>
          <div class="composer-toolbar">
             <button type="button" class="composer-pill" @click="agentMenuOpen = !agentMenuOpen"><span class="material-symbols-outlined">auto_awesome</span>指令</button>
             <div class="composer-model-wrap">
               <button type="button" class="composer-model" @click="toggleModelMenu"><span class="material-symbols-outlined">model_training</span>{{ modelLabel }} <span class="material-symbols-outlined">expand_more</span></button>
               <div v-if="modelMenuOpen" class="composer-model-menu">
                 <button v-for="model in textModelHistory" :key="model" type="button" :class="{ active: model === textModel }" @click="selectTextModel(model)">
                   <span>{{ model }}</span><span v-if="model === textModel" class="material-symbols-outlined">check</span>
                 </button>
                 <p v-if="modelLoading">正在读取模型…</p>
                 <p v-else-if="modelError">{{ modelError }}</p>
                 <button type="button" class="composer-model-settings" @click="router.push({ path: '/settings/ai', query: { from: route.fullPath } })">打开模型设置</button>
               </div>
             </div>
            <button type="submit" class="composer-send" aria-label="发送指令" title="发送指令" :disabled="!agentInput.trim() || busy || agentBusy"><span v-if="agentBusy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">arrow_upward</span></button>
          </div>
        </form>
      </aside>
    </div>
    <div v-else class="script-page min-h-full overflow-y-auto">
      <header class="script-topbar border-b border-outline-variant">
        <button class="icon-button" type="button" aria-label="返回创意输入" title="返回创意输入" @click="goIdea">
          <span class="material-symbols-outlined">arrow_back</span>
        </button>
        <div class="script-title"><span class="material-symbols-outlined text-primary">edit_document</span><strong>{{ project?.name || '剧本生成' }}</strong></div>
        <span class="script-state">{{ stage === 'script' ? '剧本正文' : stage === 'season' ? '分集大纲' : '故事设定' }}</span>
      </header>

      <div class="stage-rail">
        <button v-for="(item, index) in [{ key: 'bible', label: '故事设定' }, { key: 'season', label: '分集大纲' }, { key: 'script', label: '剧本正文' }]" :key="item.key" type="button" class="stage-step" :class="{ active: stage === item.key, done: index < stageIndex }" @click="stage = item.key as Stage">
          <span>{{ String(index + 1).padStart(2, '0') }}</span><b>{{ item.label }}</b>
        </button>
      </div>

      <main v-if="!loading" class="script-main">
        <div v-if="error" class="message message-error" role="alert">
          <div class="message-copy">
            <span class="material-symbols-outlined">error</span>
            <div>
              <strong>{{ error }}</strong>
              <small v-if="busy">当前生成任务仍在处理，请不要重复提交。</small>
              <small v-else-if="isAiError">你的创意内容已保留，可以检查模型设置后重新生成。</small>
            </div>
          </div>
          <div v-if="!busy && isAiError" class="message-actions">
            <button type="button" class="message-action" @click="router.push({ path: '/settings/ai', query: { from: route.fullPath } })">
              <span class="material-symbols-outlined">tune</span>打开模型设置
            </button>
            <button type="button" class="message-action message-action-muted" @click="generateBible">
              <span class="material-symbols-outlined">refresh</span>重新生成
            </button>
          </div>
        </div>
        <div v-if="notice" class="message message-ok"><span class="material-symbols-outlined">check_circle</span>{{ notice }}</div>

        <section v-if="stage === 'bible'" class="stage-content">
          <div class="content-heading"><div><p class="kicker">Story bible</p><h1>先让人物站稳。</h1><p>故事设定是剧本生成的约束。可以改到满意，再进入分集大纲。</p></div><button class="ghost-action" type="button" :disabled="busy" @click="generateBible"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中，请稍候' : bible ? '重新生成设定' : '生成故事设定' }}</button></div>
          <p v-if="busy" class="generation-note"><span class="material-symbols-outlined">schedule</span>正在整理世界观、人物关系和主线冲突，首次生成可能需要一两分钟。</p>
          <div class="editor-grid">
            <label class="field wide"><span>作品名</span><input v-model="bibleForm.title" placeholder="故事标题" /></label>
            <label class="field wide"><span>一句话故事</span><textarea v-model="bibleForm.logline" rows="3" placeholder="主角、困境和钩子"></textarea></label>
            <label class="field"><span>目标观众</span><textarea v-model="bibleForm.audience" rows="4"></textarea></label>
            <label class="field"><span>情绪承诺</span><textarea v-model="bibleForm.emotionalPromise" rows="4"></textarea></label>
            <label class="field wide"><span>故事主线</span><textarea v-model="bibleForm.mainPlot" rows="7" placeholder="完整描述主线冲突和推进"></textarea></label>
          </div>
          <div class="character-board">
            <div class="subheading"><span>人物小传</span><div class="subheading-actions"><small>{{ bibleForm.characters.length }} 位角色</small><button class="text-action" type="button" @click="addCharacter"><span class="material-symbols-outlined">person_add</span>添加角色</button></div></div>
            <article v-for="(character, index) in bibleForm.characters" :key="index" class="character-row">
              <input v-model="character.name" aria-label="角色姓名" placeholder="姓名" />
              <input v-model="character.role" aria-label="角色定位" placeholder="角色定位" />
              <textarea v-model="character.goal" aria-label="角色目标" rows="2" placeholder="目标"></textarea>
              <textarea v-model="character.fear" aria-label="角色恐惧" rows="2" placeholder="恐惧"></textarea>
              <textarea v-model="character.secret" aria-label="角色秘密" rows="2" placeholder="秘密"></textarea>
              <textarea v-model="character.growthArc" aria-label="角色成长" rows="2" placeholder="成长弧线"></textarea>
              <textarea v-model="character.visualDescription" aria-label="角色外貌" rows="2" placeholder="外貌与服装"></textarea>
              <button class="remove-action" type="button" aria-label="删除角色" title="删除角色" @click="removeCharacter(index)"><span class="material-symbols-outlined">delete</span></button>
            </article>
            <p v-if="!bibleForm.characters.length" class="empty-hint">先生成故事设定，或点击“添加角色”建立人物小传。</p>
          </div>
        </section>

        <section v-else-if="stage === 'season'" class="stage-content">
          <div class="content-heading"><div><p class="kicker">Season outline</p><h1>把故事分成可推进的章节。</h1><p>每一集都要有目标、冲突和不可逆的变化。</p></div><button class="ghost-action" type="button" :disabled="busy" @click="createSeason"><span v-if="busy" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : '生成分集大纲' }}</button></div>
          <div class="editor-grid">
            <label class="field"><span>整季主题</span><textarea v-model="seasonForm.seasonTheme" rows="4"></textarea></label>
            <label class="field"><span>核心冲突</span><textarea v-model="seasonForm.coreConflict" rows="4"></textarea></label>
          </div>
          <div class="episode-list">
            <article v-for="episode in seasonForm.episodes" :key="episode.episodeNo" class="episode-row">
              <div class="episode-no">EP {{ String(episode.episodeNo).padStart(2, '0') }}</div>
              <input v-model="episode.title" placeholder="本集标题" />
              <textarea v-model="episode.logline" rows="2" placeholder="本集一句话大纲"></textarea>
              <textarea v-model="episode.coreConflict" rows="2" placeholder="本集核心冲突"></textarea>
              <textarea v-model="episode.endingHook" rows="2" placeholder="结尾钩子"></textarea>
            </article>
            <p v-if="!seasonForm.episodes.length" class="empty-hint">点击“生成分集大纲”开始。</p>
          </div>
        </section>

        <section v-else class="stage-content">
          <div class="content-heading"><div><p class="kicker">Script draft</p><h1>剧本正文，留给你的最后一遍呼吸。</h1><p>生成后的正文仍然可以逐场修改。你改的是正式草稿，不是展示用文本。</p></div><div class="heading-actions"><button class="ghost-action" type="button" :disabled="busy" @click="createScripts"><span class="material-symbols-outlined">auto_awesome</span>{{ busy ? '生成中' : sceneDrafts.length ? '重新生成场景' : '生成场景' }}</button><button class="ghost-action" type="button" :disabled="busy || !sceneDrafts.length" @click="saveScripts"><span class="material-symbols-outlined">save</span>保存草稿</button></div></div>
          <div class="script-list">
            <article v-for="scene in sceneDrafts" :key="scene.id" class="scene-editor">
              <header><span>场景 {{ String(scene.sceneNo).padStart(2, '0') }}</span><input v-model="scene.title" placeholder="场景标题" /></header>
              <textarea v-model="scene.summary" rows="3" placeholder="场景摘要"></textarea>
              <textarea v-model="scene.content" rows="12" placeholder="剧本正文"></textarea>
               <button class="inline-action" type="button" :disabled="busy || generatingSceneId !== null" @click="generateScene(scene)"><span v-if="generatingSceneId === scene.id" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">auto_awesome</span>{{ generatingSceneId === scene.id ? '生成中' : scene.content ? '重新生成正文' : '生成本场正文' }}</button>
            </article>
            <div v-if="!sceneDrafts.length" class="empty-panel">点击“生成场景”后，这里会出现可以逐场生成和编辑的正式剧本。</div>
          </div>
        </section>
      </main>
      <div v-else class="page-loading">正在读取剧本工作区…</div>

      <footer class="script-actionbar">
        <span>{{ stage === 'bible' ? '确认故事设定后，再进入分集大纲。' : stage === 'season' ? '确认分集大纲后，进入剧本正文。' : '剧本正文可以继续微调。' }}</span>
        <button v-if="stage === 'bible'" class="primary-action" type="button" :disabled="busy || !canAdvanceBible" @click="saveBibleAndAdvance">确认设定并进入分集大纲 <span class="material-symbols-outlined">arrow_forward</span></button>
        <button v-else-if="stage === 'season' && !seasonForm.episodes.length" class="primary-action" type="button" :disabled="busy || !bible" @click="createSeason">生成分集大纲 <span class="material-symbols-outlined">auto_awesome</span></button>
        <button v-else-if="stage === 'season'" class="primary-action" type="button" :disabled="busy || !canAdvanceSeason" @click="saveSeasonAndOpenScript">确认大纲并进入剧本正文 <span class="material-symbols-outlined">arrow_forward</span></button>
        <button v-else-if="stage === 'script' && !sceneDrafts.length" class="primary-action" type="button" :disabled="busy || !seasonForm.episodes.length" @click="createScripts">生成场景 <span class="material-symbols-outlined">auto_awesome</span></button>
        <template v-else>
          <button class="secondary-action" type="button" :disabled="parsingAssets" @click="parseScriptAssets">
            <span v-if="parsingAssets" class="studio-spinner" aria-hidden="true"></span><span v-else class="material-symbols-outlined">{{ parseResult ? 'check_circle' : 'account_tree' }}</span>
            {{ parsingAssets ? '正在解析剧本' : parseResult ? '剧本解析完成' : parseError ? '重新解析剧本' : '解析剧本' }}
          </button>
          <button class="primary-action" type="button" :disabled="!canEnterAssets" :title="canEnterAssets ? '进入前自动保存；解析失败不阻断资产管理' : '请补齐全部剧本正文并等待当前操作结束'" @click="openAssets">进入资产管理 <span class="material-symbols-outlined">{{ canEnterAssets ? 'arrow_forward' : 'lock' }}</span></button>
        </template>
      </footer>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.script-page { background:#0d100e; color:#f0e9df; }
.script-topbar { display:flex; align-items:center; gap:1rem; min-height:4.5rem; padding:0 2rem; background:#111511; }
.icon-button { display:grid; place-items:center; width:2.5rem; height:2.5rem; border:1px solid #393c34; color:#aaa99f; transition:all .2s ease; }.icon-button:hover { border-color:#ffb77d; color:#ffb77d; transform:translateX(-2px); }
.script-title { display:flex; align-items:center; gap:.6rem; font-size:.95rem; }.script-state { margin-left:auto; color:#8d9186; font-size:.75rem; }
.stage-rail { display:flex; gap:0; border-bottom:1px solid #393c34; padding:0 2rem; background:#111511; }.stage-step { position:relative; display:flex; gap:.8rem; align-items:center; min-height:4rem; padding:0 1.4rem; color:#6f776b; transition:color .2s ease; }.stage-step::after { position:absolute; right:0; bottom:-1px; left:0; height:2px; background:#ffb77d; content:''; transform:scaleX(0); transition:transform .25s ease; }.stage-step.active,.stage-step.done { color:#ffb77d; }.stage-step.active::after { transform:scaleX(1); }.stage-step span { font-family:monospace; font-size:.7rem; }.stage-step b { font-size:.82rem; }
.script-main { max-width:76rem; margin:0 auto; padding:2.5rem 2rem 8rem; }.message { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:1rem; border:1px solid; padding:.8rem 1rem; font-size:.8rem; }.message-copy { display:flex; align-items:flex-start; gap:.7rem; min-width:0; }.message-copy > .material-symbols-outlined { color:#ff9b91; font-size:1.15rem; }.message-copy strong { display:block; color:#ffd0ca; font-size:.8rem; line-height:1.5; }.message-copy small { display:block; margin-top:.25rem; color:#c59c97; line-height:1.5; }.message-error { border-color:#f87171a0; color:#fca5a5; background:#7f1d1d1b; }.message-ok { border-color:#86efac70; color:#bbf7d0; background:#14532d18; }.message-actions { display:flex; flex:0 0 auto; gap:.5rem; }.message-action { display:inline-flex; align-items:center; gap:.35rem; min-height:2.2rem; border:1px solid #f5b8ad66; padding:0 .7rem; color:#ffd0ca; font-size:.72rem; transition:background .2s ease, border-color .2s ease, transform .2s ease; }.message-action:hover { border-color:#ffd0ca; background:#f8717118; transform:translateY(-1px); }.message-action-muted { border-color:#5b4b47; color:#b9aaa5; }.message-action .material-symbols-outlined { font-size:1rem; }.generation-note { display:flex; align-items:center; gap:.45rem; margin:-.8rem 0 1.2rem; color:#b5a28f; font-size:.75rem; }.generation-note .material-symbols-outlined { color:#ffb77d; font-size:1rem; }
.content-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:2rem; margin-bottom:2rem; }.kicker { color:#ffb77d; font-family:monospace; font-size:.65rem; letter-spacing:.18em; text-transform:uppercase; }.content-heading h1 { margin-top:.8rem; font-size:2rem; line-height:1.2; }.content-heading p:last-child { max-width:42rem; margin-top:.75rem; color:#92988c; font-size:.85rem; line-height:1.7; }.ghost-action { display:inline-flex; flex:0 0 auto; align-items:center; gap:.5rem; border:1px solid #ffb77d80; padding:.7rem .9rem; color:#ffb77d; font-size:.75rem; transition:all .2s ease; }.ghost-action:hover:not(:disabled) { background:#ffb77d12; transform:translateY(-1px); }.ghost-action:disabled { opacity:.45; }
.editor-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }.field { display:flex; flex-direction:column; gap:.55rem; }.field.wide { grid-column:1 / -1; }.field span,.subheading span { font-size:.8rem; font-weight:700; }.field input,.field textarea,.character-row input,.character-row textarea,.episode-row input,.episode-row textarea,.scene-editor input,.scene-editor textarea { width:100%; border:1px solid #363b34; background:#111611; padding:.7rem .8rem; color:#eee7dc; outline:none; resize:vertical; transition:border-color .2s ease, box-shadow .2s ease; }.field input:focus,.field textarea:focus,.character-row input:focus,.character-row textarea:focus,.episode-row input:focus,.episode-row textarea:focus,.scene-editor input:focus,.scene-editor textarea:focus { border-color:#ffb77d; box-shadow:0 0 0 3px #ffb77d12; }
.character-board,.episode-list,.script-list { margin-top:2rem; border-top:1px solid #45483f; }.subheading { display:flex; justify-content:space-between; align-items:center; padding:1rem 0; }.subheading-actions { display:flex; align-items:center; gap:1rem; }.subheading small { color:#858a80; font-size:.7rem; }.text-action,.remove-action { display:inline-flex; align-items:center; gap:.35rem; color:#ffb77d; font-size:.72rem; transition:color .2s ease, transform .2s ease; }.text-action .material-symbols-outlined,.remove-action .material-symbols-outlined { font-size:1rem; }.text-action:hover,.remove-action:hover { color:#ffd0aa; transform:translateY(-1px); }.character-row { position:relative; display:grid; grid-template-columns:1fr 1fr; gap:.7rem; padding:1rem 2.2rem 1rem 0; border-top:1px solid #292d28; }.character-row textarea:nth-of-type(1),.character-row textarea:nth-of-type(2) { grid-column:span 1; }.remove-action { position:absolute; top:1rem; right:0; color:#a9aca2; }
.episode-row { display:grid; grid-template-columns:5rem 1fr 1.5fr 1.5fr 1.5fr; gap:.7rem; align-items:start; padding:1rem 0; border-bottom:1px solid #292d28; }.episode-no { padding-top:.75rem; color:#ffb77d; font-family:monospace; font-size:.7rem; }.empty-hint,.empty-panel { padding:2rem 0; color:#737b70; font-size:.8rem; }.scene-editor { margin-top:1rem; border:1px solid #363b34; padding:1rem; }.scene-editor header { display:flex; align-items:center; gap:.8rem; margin-bottom:.8rem; }.scene-editor header span { color:#ffb77d; font-family:monospace; font-size:.7rem; }.scene-editor textarea + textarea { margin-top:.8rem; }
.script-actionbar { position:sticky; bottom:0; z-index:10; display:flex; align-items:center; justify-content:space-between; gap:1rem; min-height:4.5rem; border-top:1px solid #49483e; background:#111511ee; padding:0 2rem; backdrop-filter:blur(12px); color:#8d9186; font-size:.75rem; }.primary-action { display:inline-flex; align-items:center; gap:.55rem; min-height:2.75rem; padding:0 1rem; background:#ffb77d; color:#22170e; font-weight:700; transition:all .2s ease; }.primary-action:hover:not(:disabled) { filter:brightness(1.08); transform:translateY(-1px); }.primary-action:disabled { cursor:not-allowed; opacity:.45; }.page-loading { display:grid; min-height:60vh; place-items:center; color:#858a80; }
@media (max-width:800px) { .script-topbar,.script-actionbar { padding-right:1rem; padding-left:1rem; }.stage-rail { padding:0 .5rem; overflow-x:auto; }.stage-step { padding:0 .75rem; white-space:nowrap; }.script-main { padding:2rem 1rem 7rem; }.content-heading { flex-direction:column; }.editor-grid,.character-row { grid-template-columns:1fr; }.field.wide { grid-column:auto; }.episode-row { grid-template-columns:1fr; }.episode-no { padding-top:0; }.script-actionbar { align-items:stretch; flex-direction:column; justify-content:center; padding-top:.75rem; padding-bottom:.75rem; }.primary-action { justify-content:center; }.message { align-items:flex-start; flex-direction:column; }.message-actions { width:100%; }.message-action { flex:1; justify-content:center; } }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { transition-duration:.01ms !important; animation-duration:.01ms !important; } }

.script-shell { --shell-bg:#1f2020; --shell-panel:#191a1a; --shell-line:#383b3b; --shell-muted:#858b8c; --shell-text:#f4f3ee; --shell-accent:#72e2dc; --shell-warm:#f3eee5; display:grid; height:100%; min-height:0; grid-template-columns:minmax(0,1fr) minmax(300px,clamp(300px,24vw,340px)); overflow:hidden; background:var(--shell-bg); color:var(--shell-text); }
.script-workspace { position:relative; display:flex; min-width:0; min-height:0; flex-direction:column; overflow:hidden; background:var(--shell-bg); }
.workbench-header { display:flex; align-items:flex-end; justify-content:space-between; gap:1.5rem; margin:0 7.5%; padding:3.6rem 0 1.2rem; border-bottom:1px solid var(--shell-line); }
.workbench-title { display:flex; align-items:baseline; gap:1.1rem; min-width:0; }
.workbench-eyebrow { color:var(--shell-text); font-size:2rem; font-weight:800; letter-spacing:-.04em; }
.workbench-title h1 { max-width:28rem; overflow:hidden; color:#d6d8d4; font-size:.95rem; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
.workbench-count { flex:0 0 auto; color:#9da4a3; font-size:.78rem; }
.workbench-tabs { display:flex; gap:2rem; margin:0 7.5%; border-bottom:1px solid transparent; }
.workbench-tab { position:relative; display:inline-flex; align-items:center; gap:.45rem; min-height:4.5rem; padding:0; color:#afb4b3; font-size:1rem; transition:color .2s ease; }
.workbench-tab::after { position:absolute; right:0; bottom:-1px; left:0; height:2px; background:var(--shell-warm); content:''; transform:scaleX(0); transform-origin:left; transition:transform .22s ease; }
.workbench-tab:hover,.workbench-tab.active { color:var(--shell-text); }
.workbench-tab.active::after { transform:scaleX(1); }
.workbench-tab:focus-visible { outline:2px solid var(--shell-accent); outline-offset:5px; }
.workbench-tab .material-symbols-outlined { font-size:1.1rem; }
.workbench-feedback { position:absolute; top:0; right:0; left:0; z-index:5; display:flex; justify-content:center; padding:1rem 7.5%; pointer-events:none; }
.workbench-feedback.feedback-error { padding-top:.8rem; }
.workbench-feedback.feedback-success .workbench-notice { margin-bottom:0; pointer-events:auto; box-shadow:0 8px 24px #00000025; animation:feedback-enter .22s ease-out both; }
.workbench-feedback .workbench-alert { width:min(100%, 54rem); margin-bottom:0; pointer-events:auto; box-shadow:0 8px 24px #00000025; }
.workbench-feedback .workbench-notice { width:min(100%, 54rem); pointer-events:auto; }
.workspace-canvas { min-height:0; flex:1; overflow-y:auto; padding:1.5rem 7.5%; scrollbar-color:#4a4d4d transparent; scrollbar-width:thin; }
.workspace-canvas::-webkit-scrollbar,.agent-scroll::-webkit-scrollbar { width:7px; }
.workspace-canvas::-webkit-scrollbar-thumb,.agent-scroll::-webkit-scrollbar-thumb { border-radius:999px; background:#4a4d4d; }
.workbench-alert,.workbench-notice { display:flex; align-items:center; gap:.65rem; margin-bottom:1rem; border:1px solid #c06e6870; padding:.75rem .9rem; background:#472b2b66; color:#ffd4cf; font-size:.75rem; }
.workbench-alert strong { display:block; line-height:1.5; }
.workbench-alert small { display:block; margin-top:.15rem; color:#d7a6a1; }
.workbench-alert > .material-symbols-outlined { color:#ffaaa0; }
.alert-link { margin-left:auto; color:#ffb5ad; text-decoration:underline; text-underline-offset:3px; white-space:nowrap; }
.workbench-notice { border-color:#5dbdb770; background:#24454255; color:#b9f5ef; }
.notice-dismiss { display:grid; width:1.6rem; height:1.6rem; flex:0 0 auto; place-items:center; margin-left:auto; border:1px solid transparent; border-radius:50%; color:inherit; opacity:.72; transition:background-color .2s ease, opacity .2s ease, border-color .2s ease; }
.notice-dismiss:hover { border-color:currentColor; background:#ffffff12; opacity:1; }
.notice-dismiss .material-symbols-outlined { font-size:1rem; }
.workbench-notice .material-symbols-outlined { font-size:1rem; }
@keyframes feedback-enter { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:translateY(0); } }
.stage-pane { min-height:100%; }
.stage-empty { display:flex; min-height:clamp(24rem,62vh,40rem); flex-direction:column; align-items:center; justify-content:center; color:#92999a; text-align:center; }
.empty-mark { display:grid; width:7rem; height:7rem; place-items:center; margin-bottom:1.1rem; color:#3e4141; }
.empty-mark .material-symbols-outlined { font-size:7rem; font-variation-settings:'FILL' 0,'wght' 300,'GRAD' 0,'opsz' 48; }
.empty-stage-label { color:#78c8c3; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.64rem; letter-spacing:.11em; }
.stage-empty p { margin:0; color:#8f9696; font-size:1.1rem; }
.stage-empty small { max-width:28rem; margin-top:.55rem; color:#858e8c; font-size:.75rem; line-height:1.6; }
.empty-action { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; min-height:2.55rem; margin-top:1.15rem; border:1px solid #667976; border-radius:999px; padding:0 .95rem; color:#d2f2ef; font-size:.74rem; transition:background-color .2s ease,border-color .2s ease,transform .2s ease,opacity .2s ease; }
.empty-action:hover:not(:disabled) { transform:translateY(-1px); border-color:var(--shell-accent); background:#72e2dc12; }
.empty-action:disabled { cursor:not-allowed; opacity:.52; }
.empty-action .material-symbols-outlined { color:var(--shell-accent); font-size:1rem; }
.compact-editor { padding-top:1.25rem; }
.pane-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:1rem; margin-bottom:1.5rem; }
.pane-kicker { color:#72c9c4; font-size:.66rem; letter-spacing:.14em; text-transform:uppercase; }
.pane-heading h2 { margin-top:.35rem; font-size:1.8rem; font-weight:750; letter-spacing:-.03em; }
.saved-state { display:inline-flex; align-items:center; gap:.35rem; color:#8ed4ce; font-size:.72rem; }
.saved-state .material-symbols-outlined { font-size:1rem; }
.compact-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.8rem 1rem; }
.compact-field { display:flex; min-width:0; flex-direction:column; gap:.45rem; }
.compact-field-wide { grid-column:1 / -1; }
.compact-field > span { color:#aeb4b3; font-size:.72rem; }
.compact-field input,.compact-field textarea,.compact-character input,.compact-character textarea,.compact-episode input,.compact-episode textarea,.compact-scene input,.compact-scene textarea { width:100%; border:1px solid #3a3e3e; background:#292b2b; padding:.72rem .8rem; color:var(--shell-text); outline:none; resize:vertical; transition:border-color .2s ease,box-shadow .2s ease,background-color .2s ease; }
.compact-field input:focus,.compact-field textarea:focus,.compact-character input:focus,.compact-character textarea:focus,.compact-episode input:focus,.compact-episode textarea:focus,.compact-scene input:focus,.compact-scene textarea:focus { border-color:var(--shell-accent); background:#303333; box-shadow:0 0 0 3px #72e2dc16; }
.compact-section { margin-top:2rem; border-top:1px solid #3b3e3e; }
.section-heading { display:flex; align-items:center; gap:.8rem; min-height:3.5rem; color:#e6e6e1; }
.section-heading > span { color:#8c9291; font-size:.72rem; }
.section-link { display:inline-flex; align-items:center; gap:.35rem; margin-left:auto; color:#a5e5e0; font-size:.72rem; transition:color .2s ease,transform .2s ease; }
.section-link:hover:not(:disabled) { color:#e2fffc; transform:translateY(-1px); }
.section-link:disabled { cursor:not-allowed; opacity:.45; }
.section-link .material-symbols-outlined { font-size:1rem; }
.compact-character { position:relative; display:grid; grid-template-columns:1fr 1fr 1.4fr 1.6fr; gap:.65rem; padding:.85rem 2.3rem .85rem 0; border-top:1px solid #303333; }
.icon-action { position:absolute; top:.9rem; right:.25rem; color:#7d8584; transition:color .2s ease,transform .2s ease; }
.icon-action:hover { color:#ffaaa0; transform:translateY(-1px); }
.compact-episode { display:grid; grid-template-columns:4rem 1fr 1.65fr 1.35fr; gap:.65rem; align-items:start; padding:.85rem 0; border-top:1px solid #303333; }
.episode-index { padding-top:.75rem; color:#83d4cf; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.7rem; }
.compact-empty { padding:2.5rem 0; color:#717978; font-size:.8rem; text-align:center; }
.pane-actions { display:flex; gap:.55rem; }
.inline-generate,.inline-secondary { display:inline-flex; align-items:center; gap:.35rem; min-height:2.2rem; border:1px solid #7bdcd680; padding:0 .75rem; color:#b7f4ef; font-size:.72rem; transition:background-color .2s ease,border-color .2s ease,transform .2s ease; }
.inline-generate:hover:not(:disabled),.inline-secondary:hover:not(:disabled) { border-color:var(--shell-accent); background:#72e2dc15; transform:translateY(-1px); }
.inline-secondary { border-color:#5a5e5e; color:#c4c8c5; }
.inline-generate:disabled,.inline-secondary:disabled { cursor:not-allowed; opacity:.45; }
.inline-generate .material-symbols-outlined,.inline-secondary .material-symbols-outlined { font-size:1rem; }
.compact-scene { border-top:1px solid #303333; padding:1rem 0; }
.compact-scene header { display:flex; align-items:center; gap:.75rem; margin-bottom:.65rem; }
.compact-scene header span { color:#83d4cf; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.7rem; white-space:nowrap; }
.compact-scene textarea + textarea { margin-top:.65rem; }
.compact-scene .section-link { margin-top:.65rem; margin-left:0; }
.stage-loading { display:grid; min-height:40vh; place-items:center; color:#8c9492; }
.season-reader,.script-reader { max-width:72rem; padding:1.25rem 0 2.5rem; }
.season-reader-head,.script-reader-head { display:flex; align-items:flex-start; justify-content:space-between; gap:1.8rem; padding:1rem 0 1.7rem; border-bottom:1px solid #3b3e3e; }
.reader-title-line { display:flex; align-items:center; flex-wrap:wrap; gap:.65rem; }
.reader-mark { color:#73d8d2; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.66rem; letter-spacing:.12em; }
.reader-status { display:inline-flex; align-items:center; gap:.3rem; color:#909997; font-size:.68rem; }
.reader-status .material-symbols-outlined { color:#72e2dc; font-size:.95rem; }
.season-reader-head h2,.script-reader-head h2 { margin-top:.65rem; color:#f5f3ed; font-size:2.25rem; font-weight:760; letter-spacing:-.045em; }
.season-reader-head p,.script-reader-head p { max-width:38rem; margin-top:.65rem; color:#8f9896; font-size:.8rem; line-height:1.8; }
.reader-actions { display:flex; flex:0 0 auto; align-items:center; gap:.55rem; padding-top:.2rem; }
.reader-primary,.reader-secondary,.paper-edit-button { display:inline-flex; align-items:center; justify-content:center; gap:.4rem; min-height:2.35rem; border-radius:.5rem; padding:0 .8rem; font-size:.72rem; transition:background-color .2s ease,border-color .2s ease,color .2s ease,transform .2s ease,opacity .2s ease; }
.reader-primary { background:var(--shell-warm); color:#242625; font-weight:700; }
.reader-primary:hover:not(:disabled) { background:#fffdf7; transform:translateY(-1px); }
.reader-secondary,.paper-edit-button { border:1px solid #4a5554; color:#b8ebe7; }
.reader-secondary:hover:not(:disabled),.paper-edit-button:hover:not(:disabled) { border-color:var(--shell-accent); background:#72e2dc12; transform:translateY(-1px); }
.reader-primary:disabled,.reader-secondary:disabled,.paper-edit-button:disabled { cursor:not-allowed; opacity:.45; }
.reader-primary .material-symbols-outlined,.reader-secondary .material-symbols-outlined,.paper-edit-button .material-symbols-outlined { font-size:1rem; }
.season-edit-panel { animation:reader-rise .34s cubic-bezier(.22,.8,.25,1) both; }
.outline-context { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.4rem; margin:1.35rem 0 1rem; border-bottom:1px solid #353939; padding:0 0 1.35rem; }
.outline-context > div { min-width:0; }
.outline-context span,.outline-narrative-grid span,.outline-hook span { display:block; margin-bottom:.38rem; color:#75817f; font-size:.66rem; letter-spacing:.04em; }
.outline-context strong { display:block; max-width:34rem; color:#dce0db; font-size:.82rem; font-weight:500; line-height:1.7; }
.outline-episode { display:grid; grid-template-columns:3.4rem minmax(0,1fr); gap:1.2rem; padding:2.2rem 0 2.45rem; border-bottom:1px solid #353939; animation:reader-rise .45s cubic-bezier(.22,.8,.25,1) both; }
.outline-episode:nth-child(2) { animation-delay:.04s; }.outline-episode:nth-child(3) { animation-delay:.08s; }.outline-episode:nth-child(4) { animation-delay:.12s; }
.outline-episode-index { color:#72e2dc; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:1.05rem; font-weight:600; }
.outline-episode-heading { display:flex; align-items:baseline; gap:.8rem; }
.outline-episode-heading > span { color:#7e8886; font-size:.68rem; }
.outline-episode-heading h3 { color:#f1eee7; font-size:1.32rem; font-weight:650; letter-spacing:-.02em; }
.outline-logline { max-width:62ch; margin-top:1rem; color:#e4e3dc; font-size:1rem; line-height:1.95; }
.outline-narrative-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1.1rem 1.5rem; max-width:62rem; margin-top:1.65rem; }
.outline-narrative-grid > div { min-width:0; }
.outline-narrative-grid p { color:#adb6b2; font-size:.77rem; line-height:1.75; }
.outline-hook { display:flex; align-items:flex-start; gap:.7rem; max-width:62ch; margin-top:1.7rem; border-top:1px solid #3c5554; padding-top:1rem; }
.outline-hook > .material-symbols-outlined { color:#72e2dc; font-size:1.05rem; }
.outline-hook strong { color:#c9eeeb; font-size:.8rem; font-weight:500; line-height:1.7; }
.stage-empty-inline { min-height:28rem; }
.manuscript-layout { display:grid; grid-template-columns:minmax(12rem,16rem) minmax(0,1fr); gap:1.4rem; margin-top:1.35rem; align-items:start; animation:reader-rise .34s cubic-bezier(.22,.8,.25,1) both; }
.script-reader-sidebar { position:sticky; top:0; min-width:0; border-right:1px solid #353939; padding:0 1rem 0 0; }
.sidebar-heading { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:0 0 .8rem; border-bottom:1px solid #353939; color:#e8e9e3; font-size:.78rem; }
.sidebar-heading strong { color:#76817f; font-size:.66rem; font-weight:500; }
.scene-nav-list { display:grid; gap:.2rem; padding-top:.55rem; }
.scene-nav-item { display:grid; grid-template-columns:1.7rem minmax(0,1fr) 1rem; gap:.5rem; align-items:center; width:100%; border-radius:.4rem; padding:.65rem .5rem; color:#9ca7a4; text-align:left; transition:background-color .2s ease,color .2s ease,transform .2s ease; }
.scene-nav-item:hover { background:#ffffff08; color:#e9ebe4; transform:translateX(2px); }
.scene-nav-item.active { background:#2b3534; color:#f2f2ec; }
.scene-nav-item > .material-symbols-outlined { color:#66716f; font-size:1rem; transition:transform .2s ease,color .2s ease; }
.scene-nav-item.active > .material-symbols-outlined { color:var(--shell-accent); transform:translateX(2px); }
.scene-nav-number { align-self:start; padding-top:.1rem; color:#72c9c4; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.66rem; }
.scene-nav-copy { min-width:0; }
.scene-nav-copy strong,.scene-nav-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.scene-nav-copy strong { color:inherit; font-size:.73rem; font-weight:600; }
.scene-nav-copy small { margin-top:.25rem; color:#778381; font-size:.62rem; }
.manuscript-paper { min-width:0; padding:0 1rem .5rem; }
.manuscript-header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; border-bottom:1px solid #353939; padding:0 0 1.15rem; }
.manuscript-scene-label { color:#72e2dc; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.68rem; }
.manuscript-header h3 { margin-top:.45rem; color:#f4f2eb; font-size:1.65rem; font-weight:700; letter-spacing:-.03em; }
.manuscript-header p { max-width:52ch; margin-top:.55rem; color:#939d9a; font-size:.76rem; line-height:1.7; }
.paper-edit-button { flex:0 0 auto; margin-top:.15rem; }
.manuscript-meta { display:flex; flex-wrap:wrap; gap:.65rem 1.1rem; padding:1rem 0; border-bottom:1px solid #353939; }
.manuscript-meta span { display:inline-flex; align-items:center; gap:.3rem; color:#aeb8b4; font-size:.68rem; }
.manuscript-meta .material-symbols-outlined { color:#72c9c4; font-size:.95rem; }
.manuscript-body { max-width:66ch; padding:2.1rem 0 1rem; }
.manuscript-body p { margin:0 0 1.35rem; color:#e4e3dc; font-size:.93rem; line-height:2.05; white-space:pre-wrap; }
.manuscript-body p.script-line-heading { margin-top:2rem; margin-bottom:.7rem; color:#f5f2eb; font-size:.76rem; font-weight:700; line-height:1.5; letter-spacing:.07em; text-transform:none; }
.manuscript-body p.script-line-action { border-left:2px solid #59615d; padding-left:.85rem; color:#b5beb8; font-size:.84rem; line-height:1.85; }
.manuscript-body p.script-line-dialogue { margin-left:clamp(0rem,4vw,3rem); color:#f0dfc8; font-size:1rem; line-height:1.9; }
.manuscript-body p:first-child { margin-top:0; }
.manuscript-empty { display:flex; min-height:22rem; flex-direction:column; align-items:center; justify-content:center; gap:.65rem; color:#76817f; text-align:center; }
.manuscript-empty .material-symbols-outlined { color:#566260; font-size:2.5rem; }
.manuscript-empty strong { color:#b5bfbb; font-size:.85rem; font-weight:500; }
.script-edit-panel { animation:reader-rise .34s cubic-bezier(.22,.8,.25,1) both; }
.script-edit-heading { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin:1.35rem 0 1rem; border-bottom:1px solid #353939; padding-bottom:1rem; }
.script-edit-heading span,.script-edit-grid label > span,.script-edit-content > span { display:block; margin-bottom:.38rem; color:#75817f; font-size:.66rem; }
.script-edit-heading strong { color:#eef0e9; font-size:.9rem; font-weight:600; }
.script-edit-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
.script-edit-grid label,.script-edit-content { display:block; min-width:0; }
.script-edit-grid input,.script-edit-grid textarea,.script-edit-content textarea { width:100%; border:1px solid #3a4241; background:#252b2a; padding:.75rem .8rem; color:#eef0e9; outline:none; resize:vertical; transition:border-color .2s ease,box-shadow .2s ease,background-color .2s ease; }
.script-edit-grid input:focus,.script-edit-grid textarea:focus,.script-edit-content textarea:focus { border-color:var(--shell-accent); background:#2b3331; box-shadow:0 0 0 3px #72e2dc16; }
.script-edit-content { margin-top:1rem; }
.script-edit-content textarea { line-height:1.8; }
@keyframes reader-rise { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
.story-dossier { max-width:58rem; padding:1.25rem 0 2rem; }
.dossier-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:1.5rem; padding-bottom:1.4rem; border-bottom:1px solid #3b3e3e; }
.dossier-heading h2 { margin-top:.45rem; color:#f3f1ea; font-size:2rem; font-weight:760; letter-spacing:-.04em; }
.dossier-heading p { max-width:34rem; margin-top:.55rem; color:#8b9290; font-size:.78rem; line-height:1.65; }
.dossier-heading-actions { display:flex; align-items:flex-end; flex-direction:column; gap:.8rem; }
.dossier-edit-button { display:inline-flex; align-items:center; gap:.35rem; border:1px solid #52605f; border-radius:999px; padding:.45rem .75rem; color:#b8ebe7; font-size:.72rem; transition:background-color .2s ease,border-color .2s ease,transform .2s ease; }
.dossier-edit-button:hover { border-color:var(--shell-accent); background:#72e2dc12; transform:translateY(-1px); }
.dossier-edit-button .material-symbols-outlined { font-size:1rem; }
.dossier-meta-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1rem; padding:1.5rem 0 1.25rem; }
.dossier-meta-item { min-width:0; padding-right:1rem; border-right:1px solid #363939; }
.dossier-meta-item:last-child { border-right:0; }
.dossier-meta-item > span,.dossier-meta-item small { display:block; color:#8e9694; font-size:.7rem; }
.dossier-meta-item strong { display:block; overflow:hidden; margin:.55rem 0 .35rem; color:#f3f2ec; font-size:1rem; font-weight:650; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
.dossier-meta-item small { color:#65706f; }
.dossier-section { padding:1.6rem 0; border-top:1px solid #363939; }
.dossier-section-label { display:flex; align-items:center; gap:.6rem; margin-bottom:1rem; color:#96a09d; }
.dossier-section-label > span { color:#73d8d2; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.68rem; }
.dossier-section-label strong { color:#d4d8d4; font-size:.78rem; font-weight:600; letter-spacing:.03em; }
.dossier-lead-copy { display:block; width:100%; color:#f1f0ea; font-size:1.32rem; font-weight:550; line-height:1.7; letter-spacing:-.02em; }
.dossier-body-copy { color:#dedfda; font-size:.94rem; line-height:2; }
.dossier-prose p { margin:0 0 1.2rem; }
.dossier-prose p:last-child { margin-bottom:0; }
.dossier-editable { border:1px solid #4a5352 !important; border-radius:.45rem; background:#292e2d !important; padding:.8rem .9rem !important; color:#f3f3ec !important; outline:none; resize:vertical; transition:border-color .2s ease,box-shadow .2s ease; }
.dossier-editable:focus { border-color:var(--shell-accent) !important; box-shadow:0 0 0 3px #72e2dc16; }
.dossier-anchor-strip { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; margin:1rem 0; border-top:1px solid #363939; border-bottom:1px solid #363939; padding:1.15rem 0; }
.dossier-anchor-strip > div:first-child { min-width:0; }
.dossier-anchor-strip > div:first-child span { display:block; margin-bottom:.4rem; color:#7f8987; font-size:.68rem; }
.dossier-anchor-strip strong { display:block; max-width:32rem; color:#e4e5df; font-size:.8rem; font-weight:500; line-height:1.7; }
.dossier-tags { display:flex; max-width:16rem; flex-wrap:wrap; justify-content:flex-end; gap:.35rem; }
.dossier-tags span { border:1px solid #4b5958; border-radius:999px; padding:.28rem .55rem; color:#a6dad6; font-size:.65rem; }
.dossier-section-label-row { justify-content:space-between; }
.dossier-section-label-row > div:first-child { display:flex; align-items:center; gap:.6rem; }
.dossier-section-tools { display:flex; align-items:center; gap:.75rem; }
.dossier-section-tools > span { color:#788381; font-size:.68rem; }
.dossier-character { position:relative; border-top:1px solid #303535; padding:1.2rem 0 1.3rem; }
.character-heading { display:flex; align-items:center; justify-content:space-between; gap:.8rem; }
.character-heading > div { display:flex; min-width:0; align-items:center; gap:.7rem; }
.character-number { color:#6dbcb7; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.68rem; }
.character-heading h3 { overflow:hidden; color:#f1f0e9; font-size:1.12rem; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
.character-heading input { min-width:0; color:#f1f0e9; font-size:1.12rem; font-weight:650; }
.character-role { margin:.45rem 0 1rem 1.8rem; color:#99a5a2; font-size:.74rem; }
.character-role-input { display:block; width:calc(100% - 1.8rem); margin:.45rem 0 1rem 1.8rem; padding:.5rem .65rem !important; }
.character-detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem 1.4rem; padding-left:1.8rem; }
.character-detail-grid > div > span { display:block; margin-bottom:.4rem; color:#6e7b78; font-size:.68rem; }
.character-detail-grid > div > p { color:#d5d9d4; font-size:.78rem; line-height:1.75; }
.character-detail-grid textarea { width:100%; }
.workspace-bottom-bar { position:relative; z-index:4; display:flex; align-items:center; justify-content:space-between; gap:1.2rem; margin:0 7.5% 1.7rem; border:1px solid #3b3e3e; border-radius:2.5rem; background:#242626f2; padding:.7rem .8rem .7rem 1.5rem; box-shadow:0 12px 32px #00000036; backdrop-filter:blur(14px); }
.bottom-copy { min-width:0; }
.bottom-copy strong { display:block; overflow:hidden; color:#eeece5; font-size:.8rem; text-overflow:ellipsis; white-space:nowrap; }
.bottom-copy small { display:block; margin-top:.2rem; overflow:hidden; color:#858d8d; font-size:.68rem; text-overflow:ellipsis; white-space:nowrap; }
.bottom-actions { display:flex; flex:0 0 auto; gap:.55rem; }
.bottom-primary,.bottom-secondary { display:inline-flex; align-items:center; gap:.35rem; min-height:2.65rem; border-radius:1.5rem; padding:0 1.15rem; font-size:.76rem; transition:background-color .2s ease,color .2s ease,transform .2s ease,opacity .2s ease; }
.bottom-primary { background:var(--shell-warm); color:#252625; font-weight:700; }
.bottom-primary:hover:not(:disabled) { background:#fffdf7; transform:translateY(-1px); }
.bottom-secondary { border:1px solid #4c5050; color:#e1e2dd; }
.bottom-secondary:hover:not(:disabled) { border-color:#9da4a3; background:#ffffff0d; transform:translateY(-1px); }
.bottom-primary:disabled,.bottom-secondary:disabled { cursor:not-allowed; opacity:.42; }
.bottom-primary .material-symbols-outlined,.bottom-secondary .material-symbols-outlined { font-size:1rem; }
.bottom-parse { border-color:#6d8d87; color:#d2e1dc; }
.bottom-parse:hover:not(:disabled) { border-color:#a9d0c6; background:#7eaaa30f; color:#f0fff9; }
 .studio-spinner { display:inline-block; flex:0 0 auto; width:1rem; height:1rem; border:.14rem solid currentColor; border-right-color:transparent; border-radius:50%; animation:studio-spinner-spin .7s linear infinite !important; transform-origin:center; vertical-align:-.12rem; will-change:transform; }
 .spin-icon { animation: script-spin .9s linear infinite; }
 @keyframes studio-spinner-spin { to { transform:rotate(360deg); } }
 @keyframes script-spin { to { transform:rotate(360deg); } }
.secondary-action { display:inline-flex; align-items:center; gap:.35rem; min-height:2.65rem; border:1px solid #4c5050; border-radius:1.5rem; padding:0 1.15rem; color:#e1e2dd; font-size:.76rem; transition:background-color .2s ease,color .2s ease,transform .2s ease,border-color .2s ease; }
.secondary-action:hover:not(:disabled) { border-color:#9da4a3; background:#ffffff0d; transform:translateY(-1px); }
.secondary-action:disabled { cursor:not-allowed; opacity:.42; }
.secondary-action .material-symbols-outlined { font-size:1rem; }
.agent-dock { display:flex; min-width:0; min-height:0; flex-direction:column; border-left:1px solid #3b3e3e; background:var(--shell-panel); }
.agent-header { display:flex; align-items:center; justify-content:space-between; min-height:4.5rem; border-bottom:1px solid #303333; padding:0 1.35rem; }
.agent-identity { display:flex; align-items:center; gap:.7rem; font-size:1rem; }
.agent-identity small { margin-left:-.35rem; color:#7c8885; font-size:.62rem; }
.agent-badge,.agent-mini-avatar { display:grid; place-items:center; width:2rem; height:2rem; border-radius:.55rem; background:#292c2c; color:#c8cbca; font-size:.75rem; }
.agent-icon-button { display:grid; width:2.25rem; height:2.25rem; place-items:center; border:1px solid #444848; border-radius:50%; color:#adb3b2; transition:border-color .2s ease,color .2s ease,transform .2s ease; }
.agent-icon-button:hover { border-color:var(--shell-accent); color:var(--shell-accent); transform:translateY(-1px); }
.agent-icon-button .material-symbols-outlined { font-size:1.1rem; }
.agent-scroll { min-height:0; flex:1; overflow-y:auto; padding:2.4rem 1.35rem 1.5rem; scrollbar-color:#4a4d4d transparent; scrollbar-width:thin; scroll-behavior:smooth; }
.agent-welcome { color:#f2f0e9; font-size:.92rem; line-height:1.8; }
.agent-welcome p { margin:0 0 1.15rem; }
.agent-context-line { display:flex; align-items:center; gap:.35rem; border-top:1px solid #353939; padding-top:.8rem; color:#a9d9d3 !important; font-size:.72rem !important; }
.agent-context-line .material-symbols-outlined { font-size:1rem; }
.agent-live-dot { display:inline-flex; align-items:center; gap:.3rem; margin-left:auto; color:#e3c08d; }
.agent-live-dot::before { width:.35rem; height:.35rem; border-radius:50%; background:#e3c08d; box-shadow:0 0 0 .25rem #e3c08d1e; content:""; animation:agent-pulse 1.15s ease-in-out infinite; }
.agent-welcome ul { margin:0 0 1.15rem; padding-left:1.1rem; color:#d4d7d3; }
.agent-welcome li { margin:.35rem 0; }
.agent-credit { display:inline-flex; margin-bottom:1.1rem; border:1px solid #4a5050; border-radius:999px; padding:.25rem .65rem; color:#9da5a4; font-size:.66rem; }
.agent-message { display:flex; gap:.6rem; margin-top:1.25rem; font-size:.8rem; line-height:1.6; }
.agent-message p { margin:0; }
.agent-message-user { justify-content:flex-end; }
.agent-message-user p { max-width:85%; border-radius:1rem 1rem .25rem 1rem; background:#313535; padding:.6rem .75rem; color:#f0f1eb; }
.agent-mini-avatar { flex:0 0 auto; width:1.65rem; height:1.65rem; border-radius:50%; font-size:.62rem; }
.agent-sync-warning { display:flex; align-items:flex-start; gap:.45rem; margin:1rem 0 0; border:1px solid #795957; border-radius:.7rem; background:#552d2c22; padding:.65rem .7rem; color:#e9aaa2; font-size:.7rem; line-height:1.5; }
.agent-sync-warning .material-symbols-outlined { flex:0 0 auto; font-size:1rem; }
.agent-activity-section { margin-top:1.55rem; border-top:1px solid #353939; padding-top:1rem; }
.agent-section-heading { display:flex; align-items:center; justify-content:space-between; margin-bottom:.7rem; color:#b9c4c0; font-size:.7rem; letter-spacing:.04em; }
.agent-section-heading small { color:#6f7b79; font-size:.62rem; }
.agent-section-actions { display:flex; align-items:center; gap:.55rem; }
.agent-tool-button { border:1px solid #4c5c59; border-radius:.45rem; padding:.28rem .45rem; color:#9fd8d0; font-size:.6rem; }
.agent-tool-button:hover { border-color:#72e2dc; background:#72e2dc12; color:#eafffb; }
.agent-activity-feed { display:grid; gap:.7rem; }
.agent-activity-card { border:1px solid #3c4645; border-radius:.8rem; background:#202625; padding:.75rem .8rem; box-shadow:0 12px 28px #0000001d; animation:agent-card-in .34s cubic-bezier(.22,.8,.25,1) both; }
.agent-activity-card strong { display:block; margin-top:.45rem; color:#eef0e9; font-size:.78rem; font-weight:650; line-height:1.45; }
.agent-activity-card p { margin:.35rem 0 0; color:#aab5b1; font-size:.7rem; line-height:1.6; }
.agent-activity-heading { display:flex; align-items:center; justify-content:space-between; gap:.75rem; }
.agent-activity-heading time { overflow:hidden; color:#6f7d79; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.58rem; text-overflow:ellipsis; white-space:nowrap; }
.agent-activity-state { display:inline-flex; align-items:center; gap:.32rem; color:#a8b6b2; font-size:.62rem; }
.agent-activity-state .material-symbols-outlined { font-size:.92rem; }
.agent-activity-running { border-color:#8a7653; }
.agent-activity-running .agent-activity-state { color:#e5c28f; }
 .agent-activity-running .agent-activity-state .studio-spinner { width:.92rem; height:.92rem; border-width:.12rem; }
.agent-tone-success { border-color:#426962; }
.agent-tone-success .agent-activity-state { color:#8bd9cf; }
.agent-tone-danger { border-color:#7a4e4b; }
.agent-tone-danger .agent-activity-state { color:#e9aaa2; }
.agent-tone-warning { border-color:#7e6846; }
.agent-tone-warning .agent-activity-state { color:#e6c18e; }
.agent-activity-facts { margin:.55rem 0 0; padding-left:1rem; color:#c0cbc6; font-size:.66rem; line-height:1.55; }
.agent-next-actions { display:grid; gap:.35rem; margin-top:.7rem; border-top:1px solid #ffffff0d; padding-top:.65rem; }
.agent-next-actions button { display:flex; align-items:center; justify-content:space-between; gap:.5rem; border-radius:.45rem; padding:.45rem .5rem; color:#b9e5df; font-size:.66rem; text-align:left; transition:background-color .2s ease,color .2s ease,transform .2s ease; }
.agent-next-actions button:hover { background:#72e2dc12; color:#effffc; transform:translateX(2px); }
.agent-next-actions .material-symbols-outlined { font-size:.9rem; }
.agent-activity-enter-active,.agent-activity-leave-active { transition:opacity .25s ease,transform .25s ease; }
.agent-activity-enter-from,.agent-activity-leave-to { opacity:0; transform:translateY(8px); }
@keyframes agent-card-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
@keyframes agent-pulse { 0%,100% { opacity:.55; transform:scale(.85); } 50% { opacity:1; transform:scale(1.1); } }
.agent-composer { position:relative; margin:.75rem 1rem 1rem; border:1px solid #363a3a; border-radius:1.2rem; background:#242727; box-shadow:0 8px 24px #00000026; }
.agent-composer textarea { display:block; width:100%; min-height:4.2rem; border:0; border-radius:1.2rem 1.2rem 0 0; background:transparent; padding:1rem 1rem .35rem; color:#f0f2ec; outline:none; resize:none; }
.agent-composer textarea::placeholder { color:#747d7c; }
.composer-toolbar { display:flex; align-items:center; gap:.45rem; padding:.35rem .5rem .5rem; }
.composer-tool,.composer-send { display:grid; width:2.2rem; height:2.2rem; place-items:center; border:1px solid #4a4f4f; border-radius:50%; color:#b4b9b7; transition:background-color .2s ease,color .2s ease,transform .2s ease; }
.composer-tool:hover,.composer-send:hover:not(:disabled) { background:#ffffff0d; color:#f3f4ef; transform:translateY(-1px); }
.composer-tool .material-symbols-outlined,.composer-send .material-symbols-outlined { font-size:1.15rem; }
.composer-pill,.composer-model { display:inline-flex; align-items:center; gap:.3rem; min-height:2.15rem; border-radius:1.25rem; padding:0 .75rem; color:#d7d9d4; font-size:.7rem; transition:background-color .2s ease,color .2s ease; }
.composer-pill { background:#000; color:#f2f1ec; }
.composer-model { margin-left:auto; color:#b4bbba; }
.composer-pill:hover,.composer-model:hover { background:#343838; color:#fff; }
.composer-model .material-symbols-outlined { font-size:1rem; }
.composer-model-wrap { position:relative; margin-left:auto; }
.composer-model-menu { position:absolute; right:0; bottom:calc(100% + .55rem); z-index:8; display:grid; width:min(18rem, calc(100vw - 2rem)); gap:.25rem; border:1px solid #46514f; border-radius:.8rem; background:#1e2322; padding:.45rem; box-shadow:0 1rem 2.5rem #0008; }
.composer-model-menu button { display:flex; align-items:center; justify-content:space-between; gap:.6rem; width:100%; border-radius:.5rem; padding:.55rem .6rem; color:#cbd5d1; font-size:.68rem; text-align:left; }
.composer-model-menu button:hover,.composer-model-menu button.active { background:#72e2dc16; color:#effffc; }
.composer-model-menu p { margin:.35rem .55rem; color:#e5b29f; font-size:.64rem; line-height:1.5; }
.composer-model-menu .material-symbols-outlined { font-size:.9rem; }
.composer-model-menu .composer-model-settings { border-top:1px solid #ffffff12; border-radius:0; color:#9fd8d0; }
.composer-send { margin-left:.1rem; background:#484c4c; color:#1c1e1e; }
.composer-send:not(:disabled) { background:#d7d8d2; color:#222423; }
.composer-send:disabled { cursor:not-allowed; opacity:.5; }
.agent-command-menu { position:absolute; right:.6rem; bottom:4.1rem; left:.6rem; z-index:5; display:grid; gap:.25rem; border:1px solid #4a4e4e; border-radius:.8rem; background:#2b2e2e; padding:.35rem; box-shadow:0 16px 32px #0000004a; }
.agent-command-menu button { display:flex; align-items:center; gap:.55rem; border-radius:.45rem; padding:.55rem .65rem; color:#dfe1dc; font-size:.72rem; text-align:left; transition:background-color .2s ease,color .2s ease; }
.agent-command-menu button:hover { background:#ffffff0c; color:#fff; }
.agent-command-menu .material-symbols-outlined { color:var(--shell-accent); font-size:1rem; }

@media (max-width:1050px) {
  .script-shell { grid-template-columns:minmax(0,1fr) minmax(300px,340px); }
  .workbench-header,.workbench-tabs { margin-right:5%; margin-left:5%; }
  .workbench-feedback { padding-right:5%; padding-left:5%; }
  .workspace-canvas { padding-right:5%; padding-left:5%; }
  .workspace-bottom-bar { right:5%; left:5%; }
}
@media (max-width:760px) {
  .script-shell { display:flex; height:auto; min-height:100%; flex-direction:column; overflow:visible; }
  .script-workspace { height:auto; min-height:calc(100dvh - 64px); overflow:visible; }
  .workbench-header { align-items:flex-start; flex-direction:column; gap:.35rem; margin:0 1rem; padding:1.5rem 0 .9rem; }
  .workbench-eyebrow { font-size:1.6rem; }
  .workbench-tabs { gap:1.4rem; margin:0 1rem; overflow-x:auto; }
  .workbench-tab { min-height:3.4rem; white-space:nowrap; }
  .workbench-feedback { position:fixed; top:4.5rem; right:0; left:0; padding:.65rem 1rem; }
  .workbench-feedback.feedback-error { padding-top:.65rem; }
  .workspace-canvas { flex:none; overflow:visible; padding:1rem 1rem 1.5rem; }
  .compact-grid,.compact-character,.compact-episode { grid-template-columns:1fr; }
  .compact-field-wide { grid-column:auto; }
  .compact-character { padding-right:2.3rem; }
  .compact-episode { gap:.5rem; }
  .story-dossier { padding-top:.8rem; }
  .dossier-heading { flex-direction:column; gap:1rem; }
  .dossier-heading h2 { font-size:1.65rem; }
  .dossier-heading-actions { align-items:flex-start; flex-direction:row; }
  .dossier-meta-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem .8rem; }
  .dossier-meta-item:nth-child(2) { border-right:0; }
  .dossier-meta-item strong { font-size:.88rem; }
  .dossier-lead-copy { font-size:1.05rem; }
  .dossier-body-copy { font-size:.86rem; line-height:1.85; }
  .dossier-anchor-strip { flex-direction:column; }
  .dossier-tags { max-width:none; justify-content:flex-start; }
  .dossier-section-label-row { align-items:flex-start; flex-direction:column; gap:.7rem; }
  .dossier-section-tools { margin-left:1.8rem; }
  .character-detail-grid { grid-template-columns:1fr; gap:.85rem; }
  .season-reader,.script-reader { padding-top:.8rem; }
  .season-reader-head,.script-reader-head { flex-direction:column; gap:1rem; }
  .season-reader-head h2,.script-reader-head h2 { font-size:1.75rem; }
  .reader-actions { width:100%; }
  .reader-primary,.reader-secondary { flex:1; }
  .outline-context { grid-template-columns:1fr; gap:.9rem; }
  .outline-episode { grid-template-columns:2.2rem minmax(0,1fr); gap:.7rem; padding:1.55rem 0 1.8rem; }
  .outline-episode-heading { display:block; }
  .outline-episode-heading h3 { margin-top:.35rem; font-size:1.1rem; }
  .outline-logline { font-size:.88rem; line-height:1.8; }
  .outline-narrative-grid { grid-template-columns:1fr; gap:.8rem; margin-top:1.2rem; }
  .manuscript-layout { display:flex; flex-direction:column; gap:1rem; }
  .script-reader-sidebar { position:static; width:100%; border-right:0; border-bottom:1px solid #353939; padding:0 0 .8rem; }
  .scene-nav-list { display:flex; max-width:100%; overflow-x:auto; padding-bottom:.15rem; scrollbar-width:thin; }
  .scene-nav-item { min-width:13rem; }
  .manuscript-paper { padding:0; }
  .manuscript-header { flex-direction:column; }
  .paper-edit-button { align-self:flex-start; }
  .manuscript-body { padding-top:1.5rem; }
  .script-edit-heading { align-items:flex-start; flex-direction:column; }
  .script-edit-grid { grid-template-columns:1fr; }
  .workspace-bottom-bar { align-items:stretch; flex-direction:column; margin:0 1rem 1rem; border-radius:1.2rem; padding:.9rem; }
  .bottom-actions { width:100%; }
  .bottom-primary,.bottom-secondary,.secondary-action { flex:1; justify-content:center; padding:0 .7rem; text-align:center; }
  .agent-dock { min-height:38rem; border-top:1px solid #3b3e3e; border-left:0; }
  .agent-scroll { min-height:22rem; padding-top:2rem; }
}
@media (prefers-reduced-motion: reduce) {
  .script-shell *, .script-shell *::before, .script-shell *::after { scroll-behavior:auto !important; transition-duration:.01ms !important; animation-duration:.01ms !important; }
}
</style>
