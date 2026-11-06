<script setup lang="ts">
/**
 * @file AI 剧本页
 * @description 展示项目总纲 + 三幕结构 + 场景列表，
 *              提供：生成总纲 / 生成场景列表 / 进入单场剧本 / 生成单场剧本。
 *              上下文从 query.projectId 读。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  generateOutline,
  generateSceneScript,
  generateScenes,
  getLatestOutline,
  getProject,
  listScenes,
  type OutlineDTO,
  type ProjectDTO,
  type SceneDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)

/**
 * @description 是否从 SideNav 带 ?needScene=1 跳过来，提示用户去选场景
 */
const needSceneHint = computed<boolean>(() => route.query.needScene === '1')

/**
 * @description 关闭 needScene 提示
 * @returns {void}
 */
function dismissNeedSceneHint(): void {
  router.replace({ path: '/workspace/script/ai', query: { projectId: String(projectId.value) } })
}

const project = ref<ProjectDTO | null>(null)
const outline = ref<OutlineDTO | null>(null)
const scenes = ref<SceneDTO[]>([])

/**
 * @description 总纲独立状态机（与场景/项目状态解耦，仅服务总纲模块）
 *              - loading  正在请求 GET /api/projects/:id/outline
 *              - empty    接口返回 null：项目还没生成过总纲
 *              - ready    outline 已就绪，可正常展示
 *              - error    接口失败
 */
type OutlineState = 'loading' | 'empty' | 'ready' | 'error'
const outlineState = ref<OutlineState>('loading')
const outlineErrorMsg = ref('')

/**
 * @description 是否缺 projectId：用于整页友好提示
 */
const missingProjectId = computed<boolean>(() => !projectId.value)

const loading = ref({
  project: false,
  outline: false,
  scenes: false,
})
const generating = ref({
  outline: false,
  scenes: false,
  script: false,
})
const errorMsg = ref('')
const activeSceneId = ref<number | null>(null)

/**
 * @description 重做项目总纲的二次确认弹窗状态
 *              这是项目级危险操作：会清空当前所有正式场景，并把项目拉回总纲预览阶段。
 *              不允许"先看提示再说"，必须显式确认。
 */
const confirmRegenOpen = ref(false)

/**
 * @description 当前选中的"展示层场景"——把 formal / preview 两种数据源
 *              统一成模板可读的统一形状，避免模板里到处写 v-if。
 *              字段含义：
 *              - id: 数据库场景 ID（预览场景为 outline 数组下标）
 *              - sceneNo / title / location / timeOfDay: 显示用
 *              - content / mood: 仅 formal 有值；preview 留空字符串由模板处理
 *              - kind: 'formal' | 'preview'（用于控制"编辑剧本"等按钮可用性）
 */
interface ActiveSceneView {
  id: number
  sceneNo: number
  title: string
  location: string
  timeOfDay: string
  content: string
  mood: string
  kind: 'formal' | 'preview'
}

const activeScene = computed<ActiveSceneView | null>(() => {
  const item = activeViewItem.value
  if (!item) return null
  if (item.kind === 'formal') {
    const s = item.data
    return {
      id: s.id,
      sceneNo: s.sceneNo,
      title: s.title || '',
      location: s.location || '',
      timeOfDay: s.timeOfDay || '',
      content: s.content || '',
      mood: s.mood || '',
      kind: 'formal',
    }
  }
  const p = item.data
  return {
    id: activeSceneId.value ?? 0,
    sceneNo: p.scene_no,
    title: p.title,
    location: p.location,
    timeOfDay: p.time_of_day,
    content: '',
    mood: '',
    kind: 'preview',
  }
})

const acts = computed(() => {
  if (!outline.value) return []
  return outline.value.acts.length
    ? outline.value.acts
    : [
        { act: 1, summary: outline.value.act1Text || '' },
        { act: 2, summary: outline.value.act2Text || '' },
        { act: 3, summary: outline.value.act3Text || '' },
      ]
})

/**
 * @description 场景视图（P2）
 *              数据源优先级：数据库正式场景 > 总纲预览场景
 *              - isPreview=true  表示当前显示的是 outline.scenes（总纲阶段预览，未落库）
 *              - isPreview=false 表示当前显示的是数据库里 script_scenes（已生成正式场景）
 */
type SceneViewItem =
  | { kind: 'formal'; data: SceneDTO }
  | { kind: 'preview'; data: import('@/api/project').OutlineScene }

const sceneView = computed<{ items: SceneViewItem[]; isPreview: boolean }>(() => {
  if (scenes.value.length) {
    return {
      items: scenes.value.map((s) => ({ kind: 'formal' as const, data: s })),
      isPreview: false,
    }
  }
  if (outline.value?.scenes?.length) {
    return {
      items: outline.value.scenes.map((s) => ({ kind: 'preview' as const, data: s })),
      isPreview: true,
    }
  }
  return { items: [], isPreview: false }
})

/**
 * @description 三幕分组（视图用）：
 *              优先按 outline.scenes 的 scene_no 均匀分到 act1/2/3；
 *              正式场景也按 scene_no 切（同样取首尾规则保持一致）。
 */
const scenesByAct = computed(() => {
  const map: Record<number, SceneViewItem[]> = { 1: [], 2: [], 3: [] }
  const items = sceneView.value.items
  const total = Math.max(items.length, 1)
  items.forEach((item, idx) => {
    let act = 1
    if (total > 1) {
      if (idx === 0) act = 1
      else if (idx === total - 1) act = 3
      else act = 2
    }
    const bucket = map[act]
    if (bucket) bucket.push(item)
  })
  return map
})

/**
 * @description 当前选中的视图项（用于中间剧本预览区）
 *              正式场景：用 activeSceneId（即 scene.id）直接定位
 *              预览场景：activeSceneId 当作数组下标使用（preview 没有真实 id）
 *              正式场景：可读 title/content/mood
 *              预览场景：仅展示 title/summary/location/timeOfDay，没有正文
 */
const activeViewItem = computed<SceneViewItem | null>(() => {
  if (activeSceneId.value == null) {
    return sceneView.value.items[0] || null
  }
  if (sceneView.value.isPreview) {
    return sceneView.value.items[activeSceneId.value] || sceneView.value.items[0] || null
  }
  // formal 态：activeSceneId 是 scene.id，直接 find
  return (
    sceneView.value.items.find(
      (it) => it.kind === 'formal' && it.data.id === activeSceneId.value,
    ) || sceneView.value.items[0] || null
  )
})

/**
 * @description 仅拉取总纲。供页面初次加载和"重试"使用。
 *              状态机会驱动模板在 loading / empty / ready / error 之间切换。
 * @returns {Promise<void>}
 */
async function loadOutline(): Promise<void> {
  // 总纲是后续生成场景的前置数据；没有总纲时，页面会显示“待生成”而不是报错。
  if (!projectId.value) return
  outlineState.value = 'loading'
  outlineErrorMsg.value = ''
  loading.value.outline = true
  try {
    const result = await getLatestOutline(projectId.value)
    outline.value = result
    outlineState.value = result ? 'ready' : 'empty'
  } catch (e) {
    outline.value = null
    outlineState.value = 'error'
    outlineErrorMsg.value = e instanceof Error ? e.message : '总纲读取失败'
  } finally {
    loading.value.outline = false
  }
}

/**
 * @description 拉取项目 + 总纲 + 场景列表
 * @returns {Promise<void>}
 */
async function refreshAll() {
  // 页面初始化按“项目 -> 总纲 -> 正式场景”的顺序读取，方便模板准确判断当前阶段。
  if (!projectId.value) return
  errorMsg.value = ''

  loading.value.project = true
  try {
    project.value = await getProject(projectId.value)
    // 写入最近项目上下文，供 SideNav 等其他入口读取
    if (project.value) {
      setWorkspaceContext({ projectId: project.value.id })
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '项目加载失败'
  } finally {
    loading.value.project = false
  }

  await loadOutline()

  loading.value.scenes = true
  try {
    scenes.value = await listScenes(projectId.value)
    // 进入页面时若已有正式场景，激活态用首场 scene.id
    if (scenes.value.length) {
      activeSceneId.value = scenes.value[0]?.id ?? null
    }
  } catch {
    scenes.value = []
  } finally {
    loading.value.scenes = false
  }
}

/**
 * @description 用户点了"重做项目总纲"按钮 → 打开二次确认弹窗
 *              不在 onGenerateOutline 里直接执行，避免误点带来的全项目重置。
 * @returns {void}
 */
function requestRegenerateOutline(): void {
  if (generating.value.outline || !projectId.value) return
  confirmRegenOpen.value = true
}

/**
 * @description 取消重做总纲
 * @returns {void}
 */
function cancelRegenerateOutline(): void {
  if (generating.value.outline) return
  confirmRegenOpen.value = false
}

/**
 * @description 确认重做总纲（弹窗内点"继续重做"才真正进入生成）
 *              生成成功后切到 ready 态；失败时切到 error 态并保留重试入口；
 *              P1: 总纲版本号变化意味着场景拆解基础已改变，立即清空前端旧 scenes 与选中态，
 *                  避免用户拿旧场景继续生成剧本/分镜。
 * @returns {Promise<void>}
 */
async function onGenerateOutline() {
  // 重做总纲会改变后续场景的依据，所以生成成功后必须把旧场景视为过期数据。
  if (generating.value.outline || !projectId.value) return
  confirmRegenOpen.value = false
  generating.value.outline = true
  errorMsg.value = ''
  outlineErrorMsg.value = ''
  try {
    const result = await generateOutline(projectId.value)
    outline.value = result
    outlineState.value = 'ready'
    // P1 闭环：后端已 DELETE 旧 scenes，前端同步清空
    scenes.value = []
    activeSceneId.value = null
  } catch (e) {
    const msg = e instanceof Error ? e.message : '总纲生成失败'
    outlineErrorMsg.value = msg
    outlineState.value = 'error'
    errorMsg.value = msg
  } finally {
    generating.value.outline = false
  }
}

/**
 * @description 触发 AI 生成场景列表
 *              P2: 成功后从"预览场景"切到"正式场景"，选中态重置到第一场
 * @returns {Promise<void>}
 */
async function onGenerateScenes() {
  // 这里生成的是正式场景并写入数据库，和总纲里仅用于预览的 scenes 不是同一份数据。
  if (generating.value.scenes || !projectId.value) return
  if (!outline.value) {
    errorMsg.value = '请先生成总纲'
    return
  }
  generating.value.scenes = true
  errorMsg.value = ''
  try {
    scenes.value = await generateScenes(projectId.value)
    // P2: 切到正式场景视图后，激活态用首场 scene.id（与模板选择语义保持一致）
    activeSceneId.value = scenes.value[0]?.id ?? null
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '场景生成失败'
  } finally {
    generating.value.scenes = false
  }
}

/**
 * @description 对当前选中场景生成剧本
 *              仅对正式场景（已落库的 script_scenes）开放；
 *              预览态（outline.scenes）尚未生成 script_scenes，没有可写的目标，禁止调用。
 * @returns {Promise<void>}
 */
async function onGenerateScript() {
  // 只有正式场景才有数据库 id；预览场景的下标不能拿来调用剧本接口。
  // 双重保护：UI 按钮已 disabled，但脚本入口仍做 kind 校验，防止误用预览场景的"下标 id"调接口
  if (generating.value.script) return
  if (!activeScene.value || activeScene.value.kind !== 'formal') return
  generating.value.script = true
  errorMsg.value = ''
  try {
    const updated = await generateSceneScript(activeScene.value.id)
    scenes.value = scenes.value.map((s) => (s.id === updated.id ? updated : s))
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '剧本生成失败'
  } finally {
    generating.value.script = false
  }
}

/**
 * @description 选中态判断（模板用）
 *              formal：activeSceneId 存的是 scene.id，直接等值比较
 *              preview：activeSceneId 存的是数组下标，按 idx 比较
 * @param {SceneViewItem} item 视图项
 * @param {number} idx 项在 sceneView.items 中的下标
 * @returns {boolean}
 */
function isSceneSelected(item: SceneViewItem, idx: number): boolean {
  if (item.kind === 'formal') {
    return activeSceneId.value === item.data.id
  }
  return activeSceneId.value === idx
}

/**
 * @description 选中态赋值（模板用）
 *              formal：写入 scene.id
 *              preview：写入数组下标
 * @param {SceneViewItem} item 视图项
 * @param {number} idx 项在 sceneView.items 中的下标
 * @returns {void}
 */
function selectScene(item: SceneViewItem, idx: number): void {
  if (item.kind === 'formal') {
    activeSceneId.value = item.data.id
  } else {
    activeSceneId.value = idx
  }
}

/**
 * @description 进入单场剧本编辑器
 * @param {number} sceneId 场景 ID
 * @returns {void}
 */
function goScriptEditor(sceneId: number) {
  router.push({
    path: '/workspace/script',
    query: { projectId: String(projectId.value), sceneId: String(sceneId) },
  })
}

watch(
  () => route.query.projectId,
  () => {
    refreshAll()
  },
)

onMounted(() => {
  if (missingProjectId.value) {
    errorMsg.value = '缺少 projectId 参数'
    return
  }
  refreshAll()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true" :self-managed-scroll="true">
    <!-- 缺 projectId：整页友好提示，不静默失败 -->
    <section
      v-if="missingProjectId"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">error_outline</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少项目上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          故事总纲依附于具体项目。请先从项目控制台选择一个项目，或新建一个项目。
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="router.push('/dashboard')"
          >
            <span class="material-symbols-outlined text-sm">dashboard</span>
            前往项目控制台
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="router.push('/new')"
          >
            <span class="material-symbols-outlined text-sm">add</span>
            新建项目
          </button>
        </div>
      </div>
    </section>

    <template v-else>
    <!-- 上下文缺失时的引导横幅（从 SideNav 带 ?needScene=1 跳过来时显示） -->
    <div
      v-if="needSceneHint"
      class="mb-3 flex items-center justify-between border border-primary/40 bg-primary/5 px-4 py-3"
      role="status"
    >
      <div class="flex items-center gap-3 text-sm text-on-surface">
        <span class="material-symbols-outlined text-primary">edit_note</span>
        <div>
          <p class="font-bold text-on-surface">请先选择一个场景</p>
          <p class="text-xs text-on-surface-variant">
            分镜依附于具体场景。在右侧场景列表中选择一个场景，然后先进入剧本编辑；完成剧本后再生成分镜。
          </p>
        </div>
      </div>
      <button
        type="button"
        class="border border-outline-variant bg-surface-container-low px-2 py-1 text-on-surface-variant hover:border-primary hover:text-primary"
        aria-label="关闭提示"
        @click="dismissNeedSceneHint"
      >
        <span class="material-symbols-outlined text-sm">close</span>
      </button>
    </div>

    <div class="script-workspace flex min-h-0">
      <!-- 三幕结构侧栏 -->
      <aside class="script-act-sidebar flex min-h-0 w-80 shrink-0 flex-col border-r border-outline-variant bg-surface">
        <div class="border-b border-outline-variant bg-surface-container p-4">
          <h3 class="flex items-center gap-2 font-label-md uppercase tracking-widest text-primary">
            <span class="material-symbols-outlined text-sm">reorder</span>
            三幕式结构
          </h3>
        </div>
        <div class="script-act-list flex-1 space-y-6 p-4">
          <template v-if="outline && acts.length">
            <div v-for="act in acts" :key="act.act">
              <div class="mb-2 flex items-center gap-2">
                <span class="bg-primary px-1.5 text-[10px] font-bold text-on-primary-fixed-variant">第 {{ ['一', '二', '三'][act.act - 1] || act.act }} 幕</span>
                <span class="font-label-md text-on-surface">第 {{ act.act }} 幕</span>
                <span v-if="act.title" class="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">· {{ act.title }}</span>
              </div>
              <p class="text-sm leading-relaxed text-on-surface-variant">
                {{ act.summary || '— 暂无摘要 —' }}
              </p>
              <div v-if="scenesByAct[act.act]?.length" class="mt-2 space-y-2">
                <button
                  v-for="(item, idx) in scenesByAct[act.act]"
                  :key="item.kind + '-' + (item.kind === 'formal' ? item.data.id : idx)"
                  type="button"
                  class="block w-full cursor-pointer border p-3 text-left transition-all"
                  :class="
                    isSceneSelected(item, sceneView.items.indexOf(item))
                      ? 'bronze-border bg-surface-container-high opacity-100'
                      : 'border border-outline-variant/30 bg-surface-container-low opacity-80 hover:border-primary/50'
                  "
                  @click="selectScene(item, sceneView.items.indexOf(item))"
                >
                  <div class="mb-1 flex items-center justify-between">
                    <p class="text-xs" :class="isSceneSelected(item, sceneView.items.indexOf(item)) ? 'text-primary' : 'text-on-surface-variant'">
                      场景 {{ String(item.kind === 'formal' ? item.data.sceneNo : item.data.scene_no).padStart(2, '0') }}
                    </p>
                    <span
                      v-if="item.kind === 'preview'"
                      class="border border-primary/40 bg-primary/10 px-1 font-mono text-[8px] uppercase tracking-widest text-primary"
                    >预览</span>
                  </div>
                  <p
                    class="text-sm font-body-md"
                    :class="isSceneSelected(item, sceneView.items.indexOf(item)) ? 'text-on-surface' : 'text-on-surface-variant'"
                  >
                    {{ (item.kind === 'formal' ? item.data.title : item.data.title) || '未命名场景' }}
                  </p>
                </button>
              </div>
            </div>
          </template>
          <div v-else class="text-sm text-on-surface-variant">
            <p>尚未生成总纲。点击右上角「生成总纲」开始。</p>
          </div>
        </div>
      </aside>

      <!-- 中间：当前选中场景的剧本预览 -->
      <section class="script-content flex min-h-0 flex-1 flex-col bg-surface-dim p-8">
        <!-- 顶部操作条 -->
        <div class="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="font-headline-lg text-headline-lg text-on-surface">
              {{ project?.name || 'AI 剧本工作台' }}
            </h1>
            <p class="mt-1 text-sm text-on-surface-variant">
              <template v-if="outline">
                总纲 v{{ outline.versionNo }} ·
                <template v-if="sceneView.isPreview">
                  <span class="text-primary">预览 {{ sceneView.items.length }} 场</span>
                  <span class="ml-1">（点击「生成场景」落库）</span>
                </template>
                <template v-else>
                  正式 {{ sceneView.items.length }} 场
                </template>
                · 预计 {{ project?.targetDuration || 0 }} 分钟
                <template v-if="outline.visualStyle">
                  · 视觉基线：<span class="text-on-surface">{{ outline.visualStyle }}</span>
                </template>
              </template>
              <span v-else>尚未生成总纲</span>
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <!--
              重做项目总纲：项目级危险操作
              视觉上故意做成"警示红"，与次级的"生成场景（落库）"/"生成剧本"明显区分
              文案使用"重做项目总纲"而不是"重新生成总纲"，强调这是全项目重建，不是局部微调
            -->
            <button
              type="button"
              class="flex items-center gap-2 border border-red-500/60 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-400 transition-all hover:border-red-500 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="generating.outline || !projectId"
              :title="'项目级操作：会清空当前所有正式场景并重新生成总纲'"
              @click="requestRegenerateOutline"
            >
              <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': generating.outline }">
                {{ generating.outline ? 'progress_activity' : 'restart_alt' }}
              </span>
              {{ generating.outline ? '生成中...' : (outline ? '重做项目总纲' : '生成项目总纲') }}
            </button>
            <!--
              生成场景（落库）：把总纲预览场景写入正式场景
              与"重做项目总纲"同区域但视觉弱化，避免被误以为同一级危险操作
            -->
            <button
              type="button"
              class="flex items-center gap-2 border border-primary/40 bg-primary/5 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/10 disabled:opacity-50"
              :disabled="generating.scenes || !outline"
              :title="'把当前总纲里的预览场景写入正式场景'"
              @click="onGenerateScenes"
            >
              <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': generating.scenes }">
                {{ generating.scenes ? 'progress_activity' : 'movie' }}
              </span>
              {{ generating.scenes ? '生成中...' : (sceneView.isPreview ? '生成场景（落库）' : (scenes.length ? '重新生成场景' : '生成场景')) }}
            </button>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-4 py-2 text-sm font-bold text-on-secondary-fixed transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="generating.script || !activeScene || activeScene.kind !== 'formal'"
              :title="!activeScene || activeScene.kind !== 'formal' ? '请先生成正式场景' : ''"
              @click="onGenerateScript"
            >
              <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': generating.script }">
                {{ generating.script ? 'progress_activity' : 'edit_note' }}
              </span>
              {{ generating.script ? '生成中...' : '生成剧本' }}
            </button>
            <button
              type="button"
              class="flex items-center gap-2 border border-primary/60 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-all hover:border-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!activeScene || activeScene.kind !== 'formal'"
              :title="!activeScene || activeScene.kind !== 'formal' ? '请先生成正式场景' : '进入当前场景的剧本编辑器'"
              @click="activeScene && activeScene.kind === 'formal' && goScriptEditor(activeScene.id)"
            >
              <span class="material-symbols-outlined text-base">edit</span>
              编辑剧本
            </button>
          </div>
          <!-- 重做总纲后果短提示：让用户不用点开弹窗就知道这是项目级操作 -->
          <p class="mt-2 text-[11px] leading-relaxed text-on-surface-variant">
            <span class="text-red-400">重做项目总纲</span>会清空当前正式场景，并回到总纲预览阶段。
            <template v-if="scenes.length">
              当前已有 <span class="font-bold text-on-surface">{{ scenes.length }}</span> 个正式场景。
            </template>
          </p>
        </div>

        <div v-if="errorMsg" class="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
          {{ errorMsg }}
        </div>

        <!-- 总纲模块：4 态独立展示（loading / empty / ready / error） -->
        <!-- loading: 加载骨架 -->
        <div
          v-if="outlineState === 'loading'"
          class="mb-6 animate-pulse border border-outline-variant bg-surface-container p-6"
          aria-busy="true"
          aria-label="总纲加载中"
        >
          <div class="mb-3 flex items-center justify-between">
            <div class="h-5 w-32 bg-surface-container-high"></div>
            <div class="h-3 w-16 bg-surface-container-high"></div>
          </div>
          <div class="mb-2 h-4 w-full bg-surface-container-high"></div>
          <div class="mb-4 h-4 w-3/4 bg-surface-container-high"></div>
          <div class="h-3 w-full bg-surface-container-high"></div>
          <div class="mt-2 h-3 w-5/6 bg-surface-container-high"></div>
        </div>

        <!-- empty: 未生成总纲（独立空态卡片） -->
        <div
          v-else-if="outlineState === 'empty'"
          class="mb-6 flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-10 text-center"
        >
          <span class="material-symbols-outlined mb-3 text-5xl text-primary">auto_awesome</span>
          <p class="mb-1 font-headline-md text-headline-md text-on-surface">尚未生成故事总纲</p>
          <p class="mb-5 max-w-md text-sm text-on-surface-variant">
            AI 会根据项目的题材、世界观和目标时长，自动生成三幕结构 + 场景拆分预览。
          </p>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed transition-all hover:brightness-110 disabled:opacity-50"
            :disabled="generating.outline"
            @click="onGenerateOutline"
          >
            <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generating.outline }">
              {{ generating.outline ? 'progress_activity' : 'auto_awesome' }}
            </span>
            {{ generating.outline ? '生成中…' : '生成总纲' }}
          </button>
        </div>

        <!-- error: 加载或生成失败（独立错误卡 + 重试） -->
        <div
          v-else-if="outlineState === 'error'"
          class="mb-6 border border-danger-red/40 bg-danger-red/10 px-6 py-5"
        >
          <div class="mb-2 flex items-center gap-2 text-danger-red">
            <span class="material-symbols-outlined text-base">error</span>
            <span class="text-xs font-bold uppercase tracking-widest">总纲模块异常</span>
          </div>
          <p class="mb-4 text-sm text-on-surface">{{ outlineErrorMsg || '总纲读取失败' }}</p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="flex items-center gap-2 border border-primary bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20"
              @click="loadOutline"
            >
              <span class="material-symbols-outlined text-sm">refresh</span>
              重新读取
            </button>
            <!--
              错误态下的"再次生成 / 重做"按钮分流：
              - 已有 outline：属于项目级重做，必须走二次确认
              - 没有 outline：属于首次生成失败（空态），不弹窗，直接重试
              按钮视觉也按是否重做切换颜色，保持与顶部按钮组的语义一致
            -->
            <button
              v-if="outline"
              type="button"
              class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="generating.outline"
              @click="requestRegenerateOutline"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generating.outline }">
                {{ generating.outline ? 'progress_activity' : 'restart_alt' }}
              </span>
              {{ generating.outline ? '生成中…' : '重做项目总纲' }}
            </button>
            <button
              v-else
              type="button"
              class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
              :disabled="generating.outline"
              @click="onGenerateOutline"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generating.outline }">
                {{ generating.outline ? 'progress_activity' : 'auto_awesome' }}
              </span>
              {{ generating.outline ? '生成中…' : '再次生成总纲' }}
            </button>
          </div>
        </div>

        <!-- ready: 总纲已就绪，完整展示 title / logline / premise / 三幕 -->
        <div
          v-else-if="outlineState === 'ready' && outline"
          class="mb-6 border border-outline-variant bg-surface-container p-6"
        >
          <div class="mb-3 flex items-center justify-between">
            <h2 class="font-headline-md text-headline-md text-primary">
              {{ outline.title || '故事总纲' }}
            </h2>
            <span class="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              v{{ outline.versionNo }} · LOGLINE
            </span>
          </div>
          <p v-if="outline.logline" class="mb-2 text-base leading-relaxed text-on-surface">
            {{ outline.logline }}
          </p>
          <p v-if="outline.premise" class="text-sm leading-relaxed text-on-surface-variant">
            {{ outline.premise }}
          </p>
          <p v-if="!outline.logline && !outline.premise" class="text-sm text-on-surface-variant">
            （总纲正文为空）
          </p>
        </div>

        <!-- 当前选中场景的剧本预览 -->
        <!-- preview 场景：展示总纲摘要 + 提示落库 -->
        <div
          v-if="activeScene && activeScene.kind === 'preview'"
          class="border border-outline-variant bg-surface-container p-12"
        >
          <div class="mb-6 flex items-center justify-between">
            <span class="border border-primary/40 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
              总纲预览场景
            </span>
            <span class="font-mono text-[10px] uppercase tracking-widest text-on-surface-variant">
              场景 {{ String(activeScene.sceneNo).padStart(2, '0') }}
            </span>
          </div>
          <h2 class="mb-2 font-headline-lg text-headline-lg text-on-surface">
            {{ activeScene.title }}
          </h2>
          <p class="mb-4 text-sm uppercase tracking-widest text-on-surface-variant">
            {{ activeScene.location }} · {{ activeScene.timeOfDay || '—' }}
          </p>
          <p class="mb-6 text-sm leading-relaxed text-on-surface">
            {{ (activeViewItem && activeViewItem.kind === 'preview' && activeViewItem.data.summary) || '（总纲未提供场景摘要）' }}
          </p>
          <div class="border-t border-outline-variant pt-4 text-sm text-on-surface-variant">
            <p class="mb-1">这是总纲阶段的预览场景，尚未写入数据库。</p>
            <p>点击右上角「生成场景」可立即将所有预览场景落库为正式场景。</p>
          </div>
        </div>

        <!-- formal 场景：展示剧本正文 -->
        <div
          v-else-if="activeScene && activeScene.kind === 'formal'"
          class="border border-outline-variant bg-surface-paper p-12 font-serif text-black shadow-2xl"
          style="font-family: 'Noto Serif', 'Playfair Display', serif;"
        >
          <div class="mb-8 text-center">
            <p class="mb-2 text-sm uppercase tracking-[0.3em]">
              场景 {{ String(activeScene.sceneNo).padStart(2, '0') }}
            </p>
            <div class="mx-auto mb-4 h-px w-12 bg-black"></div>
            <h2 class="text-2xl font-headline-md" style="font-family: 'Playfair Display', serif;">
              {{ activeScene.title }}
            </h2>
            <p v-if="activeScene.location" class="mt-1 text-xs uppercase tracking-widest text-black/60">
              {{ activeScene.location }} · {{ activeScene.timeOfDay || '—' }}
            </p>
          </div>
          <div v-if="activeScene.content" class="whitespace-pre-line font-mono text-[14px] leading-relaxed text-black/85">
            {{ activeScene.content }}
          </div>
          <div v-else class="py-12 text-center text-sm text-black/50">
            尚未生成剧本正文。点击「生成剧本」或「编辑剧本」。
          </div>
          <div class="mt-8 flex items-center justify-between">
            <span class="text-xs text-black/60">
              <span v-if="activeScene.mood">情绪：{{ activeScene.mood }}</span>
            </span>
            <button
              type="button"
              class="flex items-center gap-2 border border-black/40 bg-white/40 px-4 py-2 text-xs font-bold text-black transition-all hover:bg-black hover:text-white"
              @click="goScriptEditor(activeScene.id)"
            >
              <span class="material-symbols-outlined text-sm">edit</span>
              编辑剧本
            </button>
          </div>
        </div>

        <!-- 总纲已生成但 outline.scenes 意外为空 -->
        <div
          v-else-if="outline && !sceneView.items.length"
          class="flex flex-1 items-center justify-center text-on-surface-variant"
        >
          <div class="text-center">
            <span class="material-symbols-outlined mb-4 text-5xl">movie</span>
            <p class="font-headline-md">总纲已生成，但未提供场景拆分</p>
            <p class="mt-2 text-sm">可以再次生成总纲，或重新尝试。</p>
          </div>
        </div>

        <!-- 总纲未生成 -->
        <div
          v-else-if="!outline"
          class="flex flex-1 items-center justify-center text-on-surface-variant"
        >
          <div class="text-center">
            <span class="material-symbols-outlined mb-4 text-5xl">auto_awesome</span>
            <p class="font-headline-md">尚未生成总纲</p>
            <p class="mt-2 text-sm">先生成总纲，AI 会同时给出场景拆分预览。</p>
          </div>
        </div>
      </section>

      <!-- 右侧：场景概览 -->
      <aside class="script-scene-sidebar flex w-[320px] flex-col border-l border-outline-variant bg-surface shrink-0">
        <div class="flex items-center justify-between border-b border-outline-variant bg-surface-container p-4">
          <h3 class="flex items-center gap-2 font-label-md uppercase tracking-widest text-primary">
            <span class="material-symbols-outlined text-sm">format_list_bulleted</span>
            {{ sceneView.isPreview ? '总纲预览' : '场景列表' }}
          </h3>
          <div class="flex items-center gap-2">
            <span
              v-if="sceneView.isPreview"
              class="border border-primary/40 bg-primary/10 px-1 font-mono text-[8px] uppercase tracking-widest text-primary"
            >预览</span>
            <span class="border border-primary/30 bg-primary-container/20 px-1.5 text-[10px] text-primary">{{ sceneView.items.length }}</span>
          </div>
        </div>
        <div class="script-scene-list flex-1 space-y-2 p-3">
          <button
            v-for="(item, idx) in sceneView.items"
            :key="(item.kind === 'formal' ? 'f-' + item.data.id : 'p-' + idx)"
            type="button"
            class="w-full border p-3 text-left transition-all"
            :class="
              isSceneSelected(item, idx)
                ? 'bronze-border bg-surface-container-high'
                : 'border-outline-variant/30 bg-surface-container-low hover:border-primary/50'
            "
            @click="selectScene(item, idx)"
          >
            <div class="mb-1 flex items-center justify-between">
              <span class="text-[10px] font-bold text-primary">场景 {{ String(item.kind === 'formal' ? item.data.sceneNo : item.data.scene_no).padStart(2, '0') }}</span>
              <span v-if="item.kind === 'formal'" class="text-[10px] uppercase" :class="{
                'text-green-400': item.data.status === 'storyboard_ready',
                'text-primary': item.data.status === 'generated',
                'text-on-surface-variant': item.data.status === 'draft',
                'text-yellow-400': item.data.status === 'revised',
              }">
                {{ item.data.status }}
              </span>
              <span
                v-else
                class="border border-primary/40 bg-primary/10 px-1 font-mono text-[8px] uppercase tracking-widest text-primary"
              >预览</span>
            </div>
            <p class="text-sm font-body-md text-on-surface">{{ (item.kind === 'formal' ? item.data.title : item.data.title) || '未命名场景' }}</p>
            <p v-if="(item.kind === 'formal' ? item.data.summary : item.data.summary)" class="mt-1 line-clamp-2 text-[12px] text-on-surface-variant">
              {{ item.kind === 'formal' ? item.data.summary : item.data.summary }}
            </p>
            <p v-if="(item.kind === 'formal' ? item.data.location : item.data.location)" class="mt-1 text-[10px] uppercase text-on-surface-variant">
              {{ item.kind === 'formal' ? item.data.location : item.data.location }} · {{ item.kind === 'formal' ? (item.data.timeOfDay || '—') : (item.data.time_of_day || '—') }}
            </p>
          </button>
          <div v-if="!sceneView.items.length && !loading.scenes" class="p-6 text-center text-sm text-on-surface-variant">
            <template v-if="!outline">先生成总纲查看预览</template>
            <template v-else>总纲未给出场景拆分，请重新生成</template>
          </div>
        </div>
      </aside>
    </div>
    </template>

    <!--
      重做项目总纲：二次确认弹窗
      关键文案：
      - 标题：明确"项目级"动作
      - 正文：先讲后果（清空正式场景、回到预览阶段），再讲需要的后续操作
      - 已有正式场景时，再追加一条"会被清空的数量"提示
      - 按钮：主按钮用危险色，与 cancel 视觉上明显不同
    -->
    <div
      v-if="confirmRegenOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-regen-title"
      @click.self="cancelRegenerateOutline"
    >
      <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-3 flex items-center gap-3">
          <span class="material-symbols-outlined text-3xl text-red-400">warning</span>
          <h2 id="confirm-regen-title" class="font-headline-md text-headline-md text-on-surface">
            确认重做项目总纲？
          </h2>
        </div>
        <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
          <p>
            此操作会基于当前项目重新生成整个故事总纲，并使现有正式场景失效。你需要重新生成场景后，才能继续后续剧本与分镜流程。
          </p>
          <p
            v-if="scenes.length"
            class="border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-400"
          >
            当前项目已有 <span class="font-bold">{{ scenes.length }}</span> 个正式场景，继续后这些场景将被清空。
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="cancelRegenerateOutline"
          >
            取消
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="generating.outline"
            @click="onGenerateOutline"
          >
            <span v-if="generating.outline" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            继续重做
          </button>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.script-workspace {
  background: #111311;
  min-height: 100%;
  height: 100%;
  align-items: stretch;
  width: 100%;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable both-edges;
  scroll-padding-block: 1rem;
}

.script-act-sidebar,
.script-scene-sidebar,
.script-content {
  overflow: visible;
}

.script-act-sidebar,
.script-scene-sidebar {
  align-self: stretch;
}

.script-act-sidebar {
  width: 280px;
}

.script-scene-sidebar {
  width: 280px;
}

@media (max-width: 1440px) {
  .script-workspace {
    flex-direction: column;
    height: auto;
  }

  .script-act-sidebar,
  .script-scene-sidebar {
    width: 100%;
    flex: 0 0 auto;
  }

  .script-act-sidebar {
    border-right: 0;
    border-bottom: 1px solid rgba(164, 132, 84, 0.3);
  }

  .script-scene-sidebar {
    border-top: 1px solid rgba(164, 132, 84, 0.3);
    border-left: 0;
  }

  .script-content {
    min-height: auto;
    padding: 1.25rem;
  }
}

@media (max-width: 1023px) {
  .script-workspace {
    flex-direction: column;
    height: auto;
    min-height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .script-act-sidebar,
  .script-scene-sidebar {
    width: 100%;
    flex: 0 0 auto;
  }

  .script-act-sidebar {
    border-right: 0;
    border-bottom: 1px solid rgba(164, 132, 84, 0.3);
  }

  .script-content {
    min-height: auto;
    padding: 1.25rem;
  }

  .script-scene-sidebar {
    border-top: 1px solid rgba(164, 132, 84, 0.3);
    border-left: 0;
  }
}

@media (max-width: 639px) {
  .script-content {
    padding: 1rem;
  }

  .script-content > div:first-child {
    align-items: flex-start;
  }

  .script-content > div:first-child > div:last-child {
    width: 100%;
  }

  .script-content > div:first-child > div:last-child button {
    flex: 1 1 auto;
    justify-content: center;
    padding-right: 0.7rem;
    padding-left: 0.7rem;
  }
}
</style>
