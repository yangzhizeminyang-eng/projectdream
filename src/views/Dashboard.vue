<!--
  @file 项目控制台（Project Console）
  @description 真实项目列表页：
                 - 左侧：项目流（Project Stream），每张项目卡含代号 + 圆弧进度 + 状态
                 - 右侧：Studio Note 制片助理摘要（本周 / 最近活动 / 快捷操作）
                 - 4 个状态：loading skeleton / error 可重试 / empty 引导新建 / normal
                 - 点击项目卡 → 写入 workspace context → 跳 /workspace/script/ai
  @author PanelFlow Studio
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { archiveProject, deleteProject, listProjects, restoreProject, type ProjectDTO } from '@/api/project'
import { clearWorkspaceContext, getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

const router = useRouter()
const route = useRoute()

type LoadState = 'loading' | 'error' | 'empty' | 'ok'
type StatusFilter = 'all' | 'active' | 'draft' | 'done'

/**
 * @description 项目状态字面量联合（与后端 projects.status 枚举对齐）
 */
type ProjectStatus = 'draft' | 'outlined' | 'scripting' | 'storyboarding' | 'done'

/** 后端实际可能返回但未在前台展示的状态（落入 fallback） */
type ProjectStatusLike = ProjectStatus | string

interface StatusMeta {
  /** 中文标签 */
  label: string
  /** Tailwind 颜色 class（用于徽章 / 圆点） */
  tone: 'mute' | 'draft' | 'active' | 'done'
  /** 阶段数字（用于进度弧） */
  progress: number
  /** 阶段文案 */
  step: string
}

/**
 * @description 状态 → 元信息映射表
 *              键类型锁定为 ProjectStatus 联合，TypeScript 会强制要求所有状态都有定义；
 *              缺失键时编译即报错，避免运行时再兜底。
 */
const STATUS_META: Record<ProjectStatus, StatusMeta> = {
  draft: { label: '草稿', tone: 'draft', progress: 10, step: '已创建 · 待生成总纲' },
  outlined: { label: '总纲已就绪', tone: 'active', progress: 30, step: '已完成总纲 · 待拆场景' },
  scripting: { label: '剧本生成中', tone: 'active', progress: 60, step: '剧本生成中 · 待拆镜头' },
  storyboarding: { label: '分镜制作中', tone: 'active', progress: 85, step: '分镜制作中 · 待完成' },
  done: { label: '已完成', tone: 'done', progress: 100, step: '全流程已交付' },
}

const projects = ref<ProjectDTO[]>([])
const projectCoverIndexes = ref<Record<number, number>>({})
const loadState = ref<LoadState>('loading')
const errorMsg = ref('')
const activeFilter = ref<StatusFilter>('all')
const showArchived = ref(false)
const openActionsProjectId = ref<number | null>(null)
const lifecycleBusyProjectId = ref<number | null>(null)
const lifecycleMessage = ref('')
const lifecycleError = ref('')
const deleteDialog = ref<HTMLDialogElement | null>(null)
const deleteTarget = ref<ProjectDTO | null>(null)
const deleteConfirmName = ref('')
const deleteDialogError = ref('')
const deletingProject = ref(false)
let lifecycleFeedbackTimer: number | null = null
const canDeleteProject = computed(
  () =>
    Boolean(deleteTarget.value) &&
    deleteConfirmName.value.trim() === projectDisplayName(deleteTarget.value),
)
const showNeedProjectHint = computed<boolean>(() => route.query.reason === 'need-project')

function clearLifecycleFeedbackTimer(): void {
  if (lifecycleFeedbackTimer !== null) {
    window.clearTimeout(lifecycleFeedbackTimer)
    lifecycleFeedbackTimer = null
  }
}

function scheduleLifecycleFeedbackDismissal(): void {
  clearLifecycleFeedbackTimer()
  if (!lifecycleMessage.value && !lifecycleError.value) return
  lifecycleFeedbackTimer = window.setTimeout(() => {
    lifecycleMessage.value = ''
    lifecycleError.value = ''
    lifecycleFeedbackTimer = null
  }, 4000)
}

watch([lifecycleMessage, lifecycleError], scheduleLifecycleFeedbackDismissal)
onUnmounted(clearLifecycleFeedbackTimer)

/**
 * @description 异步加载项目列表
 * @returns {Promise<void>}
 */
async function loadProjects(): Promise<void> {
  // 进入项目总览时拉取当前用户的所有项目。
  // 后端会顺带返回进度统计，比如分镜数量、已确认视频数量、最新导出结果。
  loadState.value = 'loading'
  errorMsg.value = ''
  try {
    const list = await listProjects({ includeArchived: showArchived.value })
    projects.value = [...new Map(list.map((project) => [project.id, project])).values()]
    loadState.value = projects.value.length ? 'ok' : 'empty'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '项目列表加载失败'
    loadState.value = 'error'
  }
}

/**
 * @description 重试加载
 * @returns {Promise<void>}
 */
async function retry(): Promise<void> {
  await loadProjects()
}

/**
 * @description 跳到新建项目
 * @returns {void}
 */
function goNewProject(): void {
  router.push('/new')
}

async function toggleArchivedProjects(): Promise<void> {
  showArchived.value = !showArchived.value
  activeFilter.value = 'all'
  openActionsProjectId.value = null
  lifecycleError.value = ''
  lifecycleMessage.value = ''
  await loadProjects()
}

/**
 * @description 关闭 reason 提示横幅
 * @returns {void}
 */
function dismissHint(): void {
  router.replace({ path: '/dashboard' })
}

/**
 * @description 进入项目工作台（AI 剧本页）
 * @param {ProjectDTO} project 项目
 * @returns {void}
 */
function openProject(project: ProjectDTO): void {
  // 进入工作台前先把 projectId 写入 sessionStorage。
  // 之后左侧菜单跳转时即使 URL 缺少 query，也能找到当前项目。
  setWorkspaceContext({ projectId: project.id })
  openStudio(project)
}

function openStudio(project: ProjectDTO): void {
  setWorkspaceContext({ projectId: project.id })
  router.push({
    path: '/workspace/studio',
    query: { projectId: String(project.id) },
  })
}

function projectDisplayName(project: ProjectDTO | null): string {
  if (!project) return ''
  return displayText(project.name, `未命名项目 ${projectCode(project.id)}`)
}

function projectTitle(project: ProjectDTO | null): string {
  return projectDisplayName(project).replace(/[・·]\s*\d{10,}$/, '').trim()
}

function projectTitleKey(project: ProjectDTO): string {
  return projectTitle(project).replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function toggleProjectActions(projectId: number): void {
  openActionsProjectId.value = openActionsProjectId.value === projectId ? null : projectId
  lifecycleError.value = ''
}

async function onArchiveProject(project: ProjectDTO): Promise<void> {
  if (lifecycleBusyProjectId.value) return

  lifecycleBusyProjectId.value = project.id
  lifecycleError.value = ''
  lifecycleMessage.value = ''
  try {
    await archiveProject(project.id)
    openActionsProjectId.value = null
    lifecycleMessage.value = `“${projectDisplayName(project)}”已归档`
    await loadProjects()
  } catch (error) {
    lifecycleError.value = error instanceof Error ? error.message : '项目归档失败'
  } finally {
    lifecycleBusyProjectId.value = null
  }
}

async function onRestoreProject(project: ProjectDTO): Promise<void> {
  if (lifecycleBusyProjectId.value) return

  lifecycleBusyProjectId.value = project.id
  lifecycleError.value = ''
  lifecycleMessage.value = ''
  try {
    await restoreProject(project.id)
    openActionsProjectId.value = null
    lifecycleMessage.value = `“${projectDisplayName(project)}”已恢复到项目列表`
    await loadProjects()
  } catch (error) {
    lifecycleError.value = error instanceof Error ? error.message : '项目恢复失败'
  } finally {
    lifecycleBusyProjectId.value = null
  }
}

function openDeleteDialog(project: ProjectDTO): void {
  deleteTarget.value = project
  deleteConfirmName.value = ''
  deleteDialogError.value = ''
  lifecycleError.value = ''
  deleteDialog.value?.showModal()
}

function closeDeleteDialog(): void {
  if (deletingProject.value) return
  deleteDialog.value?.close()
  deleteTarget.value = null
  deleteConfirmName.value = ''
  deleteDialogError.value = ''
}

async function onDeleteProject(): Promise<void> {
  const project = deleteTarget.value
  if (!project || deleteConfirmName.value.trim() !== projectDisplayName(project)) return

  deletingProject.value = true
  deleteDialogError.value = ''
  lifecycleError.value = ''
  lifecycleMessage.value = ''
  try {
    await deleteProject(project.id, deleteConfirmName.value.trim())
    if (getWorkspaceContext()?.projectId === project.id) clearWorkspaceContext()
    openActionsProjectId.value = null
    lifecycleMessage.value = `“${projectDisplayName(project)}”已删除`
    deleteDialog.value?.close()
    deleteTarget.value = null
    deleteConfirmName.value = ''
    await loadProjects()
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    deleteDialogError.value =
      message === '接口不存在'
        ? '删除接口暂不可用，请刷新页面后重试'
        : message || '项目删除失败'
  } finally {
    deletingProject.value = false
  }
}

/**
 * @description 项目代号（PF-007），对应制片现场"镜号"语言
 * @param {number} id 项目 ID
 * @returns {string}
 */
function projectCode(id: number): string {
  return `PF-${String(id).padStart(3, '0')}`
}

/**
 * @description 相对时间格式化：刚刚 / N 分钟前 / N 小时前 / N 天前 / 直接日期
 * @param {string} iso ISO 时间字符串
 * @returns {string}
 */
function formatRelativeTime(iso: string): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const diff = Math.max(0, Date.now() - t)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day} 天前`
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * @description 提取 narrativeVision 前 N 字作为列表摘要
 * @param {string | null | undefined} text
 * @param {number} max
 * @returns {string}
 */
function excerpt(text: string | null | undefined, max = 60): string {
  if (!text) return ''
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function isCorruptedText(value: string | null | undefined): boolean {
  const text = String(value || '').trim()
  return !text || text.includes('\ufffd') || /\?{2,}/.test(text)
}

function displayText(value: string | null | undefined, fallback: string): string {
  return isCorruptedText(value) ? fallback : String(value).trim()
}

/**
 * @description 状态 → 元信息（label / tone / progress / step）
 *              参数为宽松 string（与后端字段类型一致），内部用 `in` 收窄为已知 ProjectStatus；
 *              未知状态安全回落至 draft，保证返回类型恒为 StatusMeta。
 * @param {ProjectStatusLike} status 项目状态
 * @returns {StatusMeta}
 */
function metaOf(status: ProjectStatusLike): StatusMeta {
  if (status in STATUS_META) {
    return STATUS_META[status as ProjectStatus]
  }
  return STATUS_META.draft
}

function projectProgress(project: ProjectDTO): number {
  // 优先使用后端计算好的真实进度；没有时才退回本地按 status 估算。
  const value = Number(project.progressPercent)
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)))
  return metaOf(project.status).progress
}

function projectStage(project: ProjectDTO): string {
  return displayText(project.progressStage, metaOf(project.status).step)
}

function projectTone(project: ProjectDTO): StatusMeta['tone'] {
  if (project.progressComplete || projectProgress(project) >= 100) return 'done'
  if (project.status === 'draft') return 'draft'
  return 'active'
}

function progressSummary(project: ProjectDTO): string {
  const details = project.progressDetails
  if (!details) return '按项目阶段估算'
  return `分镜 ${details.storyboardCount} · 已确认视频 ${details.confirmedVideoCount} · 导出 ${details.completedExportCount}`
}

function isPristineProject(project: ProjectDTO): boolean {
  // Missing or nullable metrics are not proof that the project has no work.
  const details = project.progressDetails
  return Boolean(
    !showArchived.value &&
    project.status === 'draft' &&
    typeof project.progressPercent === 'number' &&
    project.progressPercent === 0 &&
    details &&
    Object.values(details).every((value) => typeof value === 'number' && value === 0),
  )
}

function formatDuration(seconds: number | null | undefined): string {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '未设置时长'
  if (value < 60) return `${Math.round(value)} 秒`
  const minutes = Math.floor(value / 60)
  const remaining = Math.round(value % 60)
  return remaining ? `${minutes} 分 ${remaining} 秒` : `${minutes} 分钟`
}

/**
 * @description 根据当前筛选过滤项目
 */
const filteredProjects = computed<ProjectDTO[]>(() => {
  // 顶部筛选器只影响前端展示，不会重新请求后端。
  const list = projects.value
  if (activeFilter.value === 'all') return list
  if (activeFilter.value === 'draft') return list.filter((p) => p.status === 'draft')
  if (activeFilter.value === 'done') return list.filter((p) => projectProgress(p) >= 100)
  // active
  return list.filter((p) => p.status !== 'draft' && projectProgress(p) < 100)
})

/**
 * @description 本周统计
 */
const weekly = computed(() => {
  const total = projects.value.length
  const active = projects.value.filter((p) => p.status !== 'draft' && projectProgress(p) < 100).length
  const done = projects.value.filter((p) => projectProgress(p) >= 100).length
  const draft = projects.value.filter((p) => p.status === 'draft').length
  return { total, active, done, draft }
})

/**
 * @description 最近 3 个项目（按 updatedAt 倒序，体现最近编辑活跃度而非创建时间）
 */
const latestProjects = computed<ProjectDTO[]>(() => {
  return [...projects.value]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
})

const continueProject = computed<ProjectDTO | null>(() => {
  const active = projects.value
    .filter((project) => !project.archivedAt && projectProgress(project) < 100)
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
  return active[0] || null
})

const featuredProject = computed<ProjectDTO | null>(() =>
  activeFilter.value === 'all' || activeFilter.value === 'active' ? continueProject.value : null,
)

const featuredTitleProjects = computed<ProjectDTO[]>(() => {
  if (!featuredProject.value) return []
  return filteredProjects.value.filter((project) =>
    project.id !== featuredProject.value?.id &&
    projectTitleKey(project) === projectTitleKey(featuredProject.value!),
  )
})

const recentProjects = computed<ProjectDTO[]>(() => latestProjects.value
  .filter((project) => project.id !== featuredProject.value?.id &&
    (!featuredProject.value || projectTitleKey(project) !== projectTitleKey(featuredProject.value)))
  .slice(0, 3))

function projectCoverCandidates(project: ProjectDTO): string[] {
  return [...new Set([project.coverUrl, project.latestVideo?.coverUrl]
    .filter((url): url is string => Boolean(url?.trim())))]
}

function projectCoverUrl(project: ProjectDTO): string | null {
  const candidates = projectCoverCandidates(project)
  const index = Math.min(projectCoverIndexes.value[project.id] || 0, candidates.length)
  return candidates[index] || null
}

function advanceProjectCover(project: ProjectDTO): void {
  const candidates = projectCoverCandidates(project)
  const current = projectCoverIndexes.value[project.id] || 0
  projectCoverIndexes.value = { ...projectCoverIndexes.value, [project.id]: Math.min(current + 1, candidates.length) }
}

const listedProjects = computed<ProjectDTO[]>(() => filteredProjects.value.filter(
  (project) => project.id !== featuredProject.value?.id &&
    (!featuredProject.value || projectTitleKey(project) !== projectTitleKey(featuredProject.value)),
))

const emptyProjects = computed<ProjectDTO[]>(() => listedProjects.value.filter(isPristineProject))
const activeListedProjects = computed<ProjectDTO[]>(() => listedProjects.value.filter((project) => !isPristineProject(project)))

const latestVideoProjectId = computed<number>(() => {
  return (
    [...projects.value]
      .filter((project) => project.latestVideo?.videoUrl)
      .sort(
        (a, b) =>
          +new Date(b.latestVideo?.createdAt || b.updatedAt) -
          +new Date(a.latestVideo?.createdAt || a.updatedAt),
      )[0]?.id || 0
  )
})

/**
 * @description 状态筛选 chip 配置
 */
const filterOptions: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'draft', label: '草稿' },
  { value: 'done', label: '已完成' },
]

onMounted(loadProjects)
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <!-- 上下文缺失提示横幅（从 SideNav 带 ?reason=need-project 跳过来时显示） -->
    <div
      v-if="showNeedProjectHint"
      class="context-hint mb-4 flex items-center justify-between border border-primary/40 bg-primary/5 px-4 py-3"
      role="status"
    >
      <div class="flex items-center gap-3 text-sm text-on-surface">
        <span class="material-symbols-outlined text-primary">info</span>
        <div>
          <p class="font-bold text-on-surface">需要先选择或创建一个项目</p>
          <p class="text-xs text-on-surface-variant">
            分镜和剧本模块都依附于具体项目。请从下方项目列表中选择，或新建一个项目。
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
          @click="goNewProject"
        >
          新建项目
        </button>
        <button
          type="button"
          class="border border-outline-variant bg-surface-container-low px-2 py-1 text-on-surface-variant hover:border-primary hover:text-primary"
          aria-label="关闭提示"
          @click="dismissHint"
        >
          <span class="material-symbols-outlined text-sm">close</span>
        </button>
      </div>
    </div>

    <div class="dashboard-content dashboard-content--scroll-safe px-margin-md pb-32 pt-margin-md">
      <!-- 工具条 -->
      <header class="console-toolbar dashboard-header mb-8 flex flex-wrap items-end justify-between gap-4 pb-6">
        <div class="dashboard-heading">
          <p class="dashboard-kicker mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            <span class="material-symbols-outlined text-sm">folder_open</span>
            Project Console
            <span class="text-on-surface-variant">/ 项目控制台</span>
          </p>
          <h1 class="dashboard-title font-headline-lg text-headline-lg text-on-surface">
            你的项目
          </h1>
          <p class="dashboard-summary mt-1 text-body-md text-on-surface-variant">
            <template v-if="loadState === 'ok'">
              <template v-if="showArchived">
                共 {{ weekly.total }} 个已归档项目
              </template>
              <template v-else>
                共 {{ weekly.total }} 个项目 · {{ weekly.active }} 个进行中 · {{ weekly.done }} 个已完成
              </template>
            </template>
            <template v-else-if="loadState === 'empty'">
              还没有项目，从新建项目开始你的第一场戏
            </template>
            <template v-else-if="loadState === 'loading'">
              正在读取项目…
            </template>
            <template v-else>
              暂时读不到项目
            </template>
          </p>
        </div>
          <div class="dashboard-controls flex flex-wrap items-center gap-3">
          <div class="filter-strip flex border border-outline-variant" role="tablist" aria-label="状态筛选">
            <button
              v-for="opt in filterOptions"
              :key="opt.value"
              type="button"
              role="tab"
              :aria-selected="activeFilter === opt.value"
              class="filter-option border-r border-outline-variant px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant last:border-r-0 hover:text-primary"
              :class="{ 'bg-primary/10 text-primary': activeFilter === opt.value }"
              @click="activeFilter = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <button
            type="button"
            class="archive-list-toggle flex items-center gap-2 border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-bold text-on-surface-variant hover:border-primary hover:text-primary"
            :aria-pressed="showArchived"
            @click="toggleArchivedProjects"
          >
            <span class="material-symbols-outlined text-base">{{ showArchived ? 'folder_open' : 'inventory_2' }}</span>
            {{ showArchived ? '返回项目' : '归档项目' }}
          </button>
          <button
            type="button"
            class="dashboard-create flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="goNewProject"
          >
            <span class="material-symbols-outlined text-sm">add</span>
            新建项目
          </button>
        </div>
      </header>

      <div
        v-if="lifecycleMessage || lifecycleError"
        class="lifecycle-feedback flex items-start justify-between gap-3 border px-4 py-3 text-sm"
        :class="lifecycleError ? 'lifecycle-feedback--error' : 'lifecycle-feedback--success'"
        role="status"
        aria-live="polite"
      >
        <span class="lifecycle-feedback-copy">{{ lifecycleError || lifecycleMessage }}</span>
        <button
          type="button"
          class="lifecycle-feedback-close material-symbols-outlined text-base"
          aria-label="关闭提示"
          @click="lifecycleMessage = ''; lifecycleError = ''; clearLifecycleFeedbackTimer()"
        >
          close
        </button>
      </div>

      <section v-if="featuredProject" class="continue-panel" aria-label="继续制作">
        <div class="continue-cover" :class="{ 'continue-cover--empty': !projectCoverUrl(featuredProject) }">
          <img
            v-if="projectCoverUrl(featuredProject)"
            :key="projectCoverUrl(featuredProject) || 'featured-cover'"
            :src="projectCoverUrl(featuredProject) || ''"
            :alt="`${projectTitle(featuredProject)} 项目封面`"
            @error="advanceProjectCover(featuredProject)"
          />
          <span v-else class="material-symbols-outlined" aria-hidden="true">movie</span>
        </div>
        <div class="continue-panel-copy">
          <span class="continue-panel-label">
            <span class="material-symbols-outlined" aria-hidden="true">play_circle</span>
            继续制作
          </span>
          <h2 :title="projectDisplayName(featuredProject)">{{ projectTitle(featuredProject) }}</h2>
          <p>
            {{ projectStage(featuredProject) }} · {{ progressSummary(featuredProject) }}
            · 最近修改 {{ formatRelativeTime(featuredProject.updatedAt) }}
          </p>
        </div>
        <div class="continue-panel-actions">
          <span class="continue-progress font-mono">{{ projectProgress(featuredProject) }}%</span>
          <button type="button" class="continue-button" @click="openStudio(featuredProject)">
            <span class="material-symbols-outlined text-sm">play_arrow</span>
            继续制作
          </button>
        </div>
      </section>

      <details v-if="featuredTitleProjects.length" class="featured-title-group">
        <summary>
          <span class="material-symbols-outlined" aria-hidden="true">library_books</span>
          <span>同名项目</span>
          <span class="featured-title-count">{{ featuredTitleProjects.length + 1 }} 个版本</span>
          <span class="material-symbols-outlined featured-title-chevron" aria-hidden="true">expand_more</span>
        </summary>
        <ul aria-label="同名项目版本">
          <li v-for="project in featuredTitleProjects" :key="project.id">
            <button type="button" @click="openStudio(project)">
              <span class="featured-title-code">{{ projectCode(project.id) }}</span>
              <span class="featured-title-status">{{ projectProgress(project) >= 100 ? '已完成' : projectStage(project) }}</span>
              <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
            </button>
          </li>
        </ul>
      </details>

      <!-- 项目总览只负责选择项目和继续制作；详细生产进入漫剧工作台。 -->
      <div class="dashboard-grid grid grid-cols-1 gap-8 lg:grid-cols-12">
        <!-- 左侧：项目流 -->
        <section class="project-section lg:col-span-8" aria-label="项目流">
          <!-- 错误态 -->
          <div
            v-if="loadState === 'error'"
            class="state-panel state-panel--error flex flex-col items-center justify-center border border-danger-red/40 bg-danger-red/10 px-6 py-16 text-center"
          >
            <span class="material-symbols-outlined mb-3 text-5xl text-danger-red">error</span>
            <p class="mb-1 font-bold text-on-surface">项目读取失败</p>
            <p class="mb-6 max-w-md text-sm text-on-surface-variant">{{ errorMsg }}</p>
            <button
              type="button"
              class="flex items-center gap-2 border border-primary bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20"
              @click="retry"
            >
              <span class="material-symbols-outlined text-sm">refresh</span>
              重试
            </button>
          </div>

          <!-- 加载态：skeleton -->
          <div
            v-else-if="loadState === 'loading'"
            class="loading-list space-y-4"
            aria-busy="true"
            aria-label="加载中"
          >
            <div
              v-for="i in 3"
              :key="i"
              class="loading-row flex animate-pulse items-center gap-6 border border-outline-variant bg-surface-container p-6"
            >
              <div class="h-20 w-20 rounded-full bg-surface-container-high"></div>
              <div class="flex-1 space-y-3">
                <div class="h-3 w-24 bg-surface-container-high"></div>
                <div class="h-5 w-1/2 bg-surface-container-high"></div>
                <div class="h-3 w-3/4 bg-surface-container-high"></div>
                <div class="h-1.5 w-full bg-surface-container-high"></div>
              </div>
            </div>
          </div>

          <!-- 空态 -->
          <div
            v-else-if="loadState === 'empty'"
            class="state-panel state-panel--empty flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-20 text-center"
          >
            <span class="material-symbols-outlined mb-3 text-5xl text-primary">movie_filter</span>
            <p class="mb-2 font-headline-md text-headline-md text-on-surface">还没有项目</p>
            <p class="mb-6 max-w-md text-sm text-on-surface-variant">
              从新建项目开始，设定题材和时长，AI 会帮你生成故事总纲、场景与分镜。
            </p>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
              @click="goNewProject"
            >
              <span class="material-symbols-outlined text-sm">add</span>
              新建项目
            </button>
          </div>

          <!-- 正常态：项目卡列表 -->
          <template v-else-if="activeListedProjects.length || emptyProjects.length">
          <ul
            v-if="activeListedProjects.length"
            class="console-list project-list"
            aria-label="项目列表"
          >
            <li
              v-for="p in activeListedProjects"
              :key="p.id"
              class="project-card group relative cursor-pointer border border-outline-variant bg-surface-container p-6 transition-all duration-200 hover:border-primary hover:bg-surface-container-high focus-within:border-primary"
              tabindex="0"
              role="button"
              :aria-label="`进入项目 ${displayText(p.name, `未命名项目 ${projectCode(p.id)}`)}`"
              @click="openStudio(p)"
              @keydown.enter.prevent="openStudio(p)"
              @keydown.space.prevent="openStudio(p)"
            >
              <div class="project-card-inner flex items-start gap-6">
                <div class="project-cover" :class="{ 'project-cover--empty': !projectCoverUrl(p) }">
                  <img
                    v-if="projectCoverUrl(p)"
                    :key="projectCoverUrl(p) || `project-cover-${p.id}`"
                    :src="projectCoverUrl(p) || ''"
                    :alt="`${displayText(p.name, '项目')} 视觉封面`"
                    loading="lazy"
                    @error="advanceProjectCover(p)"
                  />
                  <span v-else class="material-symbols-outlined" aria-hidden="true">movie</span>
                  <span class="project-cover-code">{{ projectCode(p.id) }}</span>
                </div>
                <!-- 代号 + 圆弧进度（signature 元素） -->
                <div class="project-progress-ring relative h-20 w-20 shrink-0">
                  <svg class="h-full w-full -rotate-90" viewBox="0 0 80 80" aria-hidden="true">
                    <circle
                      cx="40"
                      cy="40"
                      r="34"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      class="text-outline-variant"
                    />
                    <circle
                      cx="40"
                      cy="40"
                      r="34"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="4"
                      stroke-linecap="round"
                      :stroke-dasharray="2 * Math.PI * 34"
                      :stroke-dashoffset="2 * Math.PI * 34 * (1 - projectProgress(p) / 100)"
                      class="text-primary transition-all duration-500"
                    />
                  </svg>
                  <div class="absolute inset-0 flex flex-col items-center justify-center">
                    <span class="font-mono text-[10px] font-bold tracking-tight text-on-surface-variant">
                      {{ projectCode(p.id) }}
                    </span>
                    <span class="project-progress-value">
                      <span class="font-mono text-lg font-bold text-primary">{{ projectProgress(p) }}</span>
                      <span class="font-mono text-[9px] text-on-surface-variant">%</span>
                    </span>
                  </div>
                </div>

                <!-- 中部信息 -->
                <div class="project-card-body min-w-0 flex-1">
                  <div class="mb-2 flex flex-wrap items-center gap-2">
                    <h3 class="project-card-title truncate font-headline-md text-headline-md text-on-surface group-hover:text-primary" :title="projectDisplayName(p)">
                      {{ projectTitle(p) }}
                    </h3>
                    <span
                      class="border px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
                      :class="{
                        'border-outline-variant text-on-surface-variant': projectTone(p) === 'draft',
                        'border-primary/40 bg-primary/5 text-primary': projectTone(p) === 'active',
                        'border-tertiary/40 bg-tertiary/10 text-tertiary': projectTone(p) === 'done',
                        'border-on-surface-variant/40 text-on-surface-variant': projectTone(p) === 'mute',
                      }"
                    >
                      {{ projectProgress(p) >= 100 ? '已完成' : projectStage(p) }}
                    </span>
                    <span
                      v-if="p.archivedAt"
                      class="border border-on-surface-variant/40 px-2 py-0.5 text-[10px] font-bold text-on-surface-variant"
                    >
                      已归档
                    </span>
                  </div>
                  <div class="project-card-meta mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                    <span class="font-bold uppercase tracking-widest">{{ displayText(p.category, '未分类') }}</span>
                    <span v-if="!isCorruptedText(p.aspectRatio)" class="font-mono">{{ p.aspectRatio }}</span>
                    <span v-if="!isCorruptedText(p.visualStyle)">{{ p.visualStyle }}</span>
                    <span class="font-mono">{{ formatDuration(p.targetDuration) }}</span>
                  </div>
                  <p class="mb-3 line-clamp-2 text-sm leading-relaxed text-on-surface-variant">
                    {{ excerpt(displayText(p.narrativeVision, '暂无项目简介'), 100) }}
                  </p>
                  <!-- 进度条 -->
                  <div class="project-card-progress flex items-center gap-3">
                    <div
                      class="relative h-1.5 flex-1 bg-outline-variant"
                      title="进度由总纲、场景、分镜、静帧、视频、音频和导出七个环节加权计算"
                    >
                      <div
                        class="absolute inset-y-0 left-0 bg-primary transition-all duration-500"
                        :style="`width: ${projectProgress(p)}%;`"
                      ></div>
                    </div>
                    <span class="font-mono text-xs font-bold text-primary">{{ projectProgress(p) }}%</span>
                  </div>
                  <p class="mt-2 text-[11px] uppercase tracking-widest text-on-surface-variant">
                    {{ projectStage(p) }} · {{ progressSummary(p) }}
                  </p>

                  <div
                    v-if="p.id === latestVideoProjectId && p.latestVideo?.videoUrl"
                    class="project-latest-video mt-4 border border-outline-variant bg-surface-container-low p-3"
                    @click.stop
                  >
                    <div class="mb-2 flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-widest text-secondary">
                      <span class="flex items-center gap-1">
                        <span class="material-symbols-outlined text-sm">movie</span>
                        最新成片
                      </span>
                      <button
                        type="button"
                        class="text-primary hover:underline"
                        @click.stop="openStudio(p)"
                      >
                        进入创作
                      </button>
                    </div>
                    <video
                      class="aspect-video w-full bg-black object-cover"
                      controls
                      preload="metadata"
                      :src="p.latestVideo.videoUrl"
                      :aria-label="`${displayText(p.name, '项目')} 最新成片`"
                    ></video>
                  </div>
                </div>

                <!-- 右侧时间 + 进入 -->
                <div class="project-card-aside hidden shrink-0 flex-col items-end justify-between text-right sm:flex">
                  <span class="font-mono text-[10px] text-on-surface-variant">
                    {{ formatRelativeTime(p.updatedAt) }}
                  </span>
                  <span class="font-mono text-[10px] text-on-surface-variant">
                    #{{ p.id }}
                  </span>
                  <span class="mt-auto flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    进入工作台
                    <span class="material-symbols-outlined text-sm">arrow_forward</span>
                  </span>
                </div>
              </div>
              <div
                class="project-card-actions mt-4 flex flex-wrap items-center justify-end gap-2"
                @click.stop
                @keydown.stop
              >
                <button
                  v-if="!p.archivedAt"
                  type="button"
                  class="flex items-center gap-1.5 border border-primary/60 px-3 py-1.5 text-xs font-bold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
                  :aria-label="`进入 ${projectDisplayName(p)} 一体化工作台`"
                  title="进入漫剧一体化工作台"
                  @click.stop="openStudio(p)"
                >
                  <span class="material-symbols-outlined text-sm">theaters</span>
                  继续制作
                </button>
                <button
                  type="button"
                  class="project-action-icon material-symbols-outlined"
                  :aria-label="`管理项目 ${projectDisplayName(p)}`"
                  :aria-expanded="openActionsProjectId === p.id"
                  :title="`管理项目 ${projectDisplayName(p)}`"
                  @click.stop="toggleProjectActions(p.id)"
                >
                  more_horiz
                </button>
              </div>
              <div
                v-if="openActionsProjectId === p.id"
                class="project-lifecycle-bar flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant pt-4"
                @click.stop
                @keydown.stop
              >
                <p class="text-xs text-on-surface-variant">
                  {{ p.archivedAt ? '恢复后会重新显示在项目列表中。' : '归档后仍会保留项目内容，可随时恢复。' }}
                </p>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    v-if="p.archivedAt"
                    type="button"
                    class="lifecycle-action flex items-center gap-1.5 border border-primary/50 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/10"
                    :disabled="lifecycleBusyProjectId === p.id"
                    @click.stop="onRestoreProject(p)"
                  >
                    <span class="material-symbols-outlined text-sm">unarchive</span>
                    {{ lifecycleBusyProjectId === p.id ? '恢复中' : '恢复项目' }}
                  </button>
                  <button
                    v-else
                    type="button"
                    class="lifecycle-action flex items-center gap-1.5 border border-outline-variant px-3 py-1.5 text-xs font-bold text-on-surface hover:border-primary hover:text-primary"
                    :disabled="lifecycleBusyProjectId === p.id"
                    @click.stop="onArchiveProject(p)"
                  >
                    <span class="material-symbols-outlined text-sm">inventory_2</span>
                    {{ lifecycleBusyProjectId === p.id ? '归档中' : '归档项目' }}
                  </button>
                  <button
                    type="button"
                    class="lifecycle-action lifecycle-action--danger flex items-center gap-1.5 border px-3 py-1.5 text-xs font-bold"
                    @click.stop="openDeleteDialog(p)"
                  >
                    <span class="material-symbols-outlined text-sm">delete</span>
                    删除
                  </button>
                </div>
              </div>
              <!-- 底部装饰：hover 时进度条延伸 -->
              <div
                class="project-card-rule absolute bottom-0 left-0 h-[2px] w-full origin-left scale-x-0 bg-primary transition-transform duration-300 group-hover:scale-x-100"
                aria-hidden="true"
              ></div>
            </li>
          </ul>

          <details v-if="emptyProjects.length" class="empty-projects-group">
            <summary class="empty-projects-summary">
              <span class="material-symbols-outlined" aria-hidden="true">inventory_2</span>
              <span class="empty-projects-title">尚未开始</span>
              <span class="empty-projects-count">{{ emptyProjects.length }}</span>
              <span class="empty-projects-caption">0% · 尚无大纲、场景或制作资产</span>
              <span class="material-symbols-outlined empty-projects-chevron" aria-hidden="true">expand_more</span>
            </summary>
            <ul class="empty-project-list" aria-label="尚未开始的项目">
              <li v-for="p in emptyProjects" :key="p.id" class="empty-project-row">
                <button
                  type="button"
                  class="empty-project-open"
                  :aria-label="`开始制作 ${projectDisplayName(p)}`"
                  @click="openStudio(p)"
                >
                  <span class="empty-project-cover" aria-hidden="true">
                    <span class="material-symbols-outlined">movie</span>
                    <span>{{ projectCode(p.id) }}</span>
                  </span>
                  <span class="empty-project-copy">
                    <strong :title="projectDisplayName(p)">{{ projectTitle(p) }}</strong>
                    <span>{{ projectCode(p.id) }} · {{ displayText(p.category, '未分类') }} · {{ formatRelativeTime(p.updatedAt) }}</span>
                  </span>
                  <span class="empty-project-cta">
                    开始制作
                    <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  </span>
                </button>
                <div class="empty-project-actions" @click.stop>
                  <button
                    type="button"
                    :disabled="lifecycleBusyProjectId === p.id"
                    :aria-label="`归档 ${projectDisplayName(p)}`"
                    title="归档项目"
                    @click="onArchiveProject(p)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">inventory_2</span>
                  </button>
                  <button
                    type="button"
                    :aria-label="`删除 ${projectDisplayName(p)}`"
                    title="删除项目"
                    @click="openDeleteDialog(p)"
                  >
                    <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                  </button>
                </div>
              </li>
            </ul>
          </details>
          </template>

          <div v-else-if="featuredProject && filteredProjects.length" class="state-panel state-panel--filtered border border-dashed border-outline-variant bg-surface-container-low px-6 py-10 text-center">
            <span class="material-symbols-outlined text-3xl text-primary">done_all</span>
            <p class="mt-2 font-bold text-on-surface">当前项目已置于“继续制作”</p>
            <p class="mt-1 text-sm text-on-surface-variant">项目列表只展示其余项目，避免同一项目重复出现。</p>
          </div>

          <!-- 筛选后无结果 -->
          <div
            v-else
            class="state-panel state-panel--filtered flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-16 text-center"
          >
            <span class="material-symbols-outlined mb-2 text-4xl text-on-surface-variant">filter_alt_off</span>
            <p class="mb-1 font-bold text-on-surface">
              {{ showArchived ? '还没有归档项目' : '没有符合筛选条件的项目' }}
            </p>
            <p class="mb-4 text-sm text-on-surface-variant">
              {{ showArchived ? '归档后的项目会出现在这里。' : '试试切换其他状态' }}
            </p>
            <button
              type="button"
              class="border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
              @click="showArchived ? toggleArchivedProjects() : (activeFilter = 'all')"
            >
              {{ showArchived ? '返回项目列表' : '全部项目' }}
            </button>
          </div>
        </section>

        <!-- 右侧：Studio Note 制片助理摘要 -->
        <aside class="studio-sidebar lg:col-span-4" aria-label="制片助理摘要">
          <div class="space-y-4 console-side">
            <!-- 本周摘要 -->
            <div class="studio-card studio-card--summary border border-outline-variant bg-surface-container p-5">
              <div class="studio-card-heading mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                <span class="material-symbols-outlined text-sm">analytics</span>
                Studio Note · 本周
              </div>
              <div class="stats-grid grid grid-cols-3 gap-2 text-center">
                <div class="stat-cell border border-outline-variant bg-surface-container-low p-3">
                  <div class="stat-value text-on-surface">{{ weekly.total }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">总项目</div>
                </div>
                <div class="stat-cell border border-outline-variant bg-surface-container-low p-3">
                  <div class="stat-value text-primary">{{ weekly.active }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">进行中</div>
                </div>
                <div class="stat-cell border border-outline-variant bg-surface-container-low p-3">
                  <div class="stat-value text-tertiary">{{ weekly.done }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">已完成</div>
                </div>
              </div>
            </div>

            <!-- 最近活动 -->
            <div class="studio-card studio-card--activity border border-outline-variant bg-surface-container p-5">
              <div class="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                <span class="flex items-center gap-2">
                  <span class="material-symbols-outlined text-sm">history</span>
                  最近活动
                </span>
                <span class="font-mono text-on-surface-variant">RECENT</span>
              </div>
              <ul v-if="recentProjects.length" class="activity-list space-y-3">
                <li
                  v-for="p in recentProjects"
                  :key="p.id"
                  class="group flex cursor-pointer items-start gap-3 border-l-2 border-outline-variant pl-3 transition-colors hover:border-primary"
                  @click="openProject(p)"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-bold text-on-surface group-hover:text-primary">
                      {{ displayText(p.name, `未命名项目 ${projectCode(p.id)}`) }}
                    </p>
                    <p class="mt-0.5 font-mono text-[10px] text-on-surface-variant">
                      {{ projectCode(p.id) }} · {{ formatRelativeTime(p.updatedAt) }}
                    </p>
                  </div>
                  <span
                    class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    :class="{
                      'bg-on-surface-variant': projectTone(p) === 'draft',
                      'bg-primary': projectTone(p) === 'active',
                      'bg-tertiary': projectTone(p) === 'done',
                      'bg-outline': projectTone(p) === 'mute',
                    }"
                    aria-hidden="true"
                  ></span>
                </li>
              </ul>
              <p v-else class="text-sm text-on-surface-variant">{{ featuredProject ? '当前重点项目已置顶' : '暂无活动' }}</p>
            </div>

            <!-- 快捷操作 -->
            <div class="studio-card studio-card--actions border border-outline-variant bg-surface-container p-5">
              <div class="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                快捷操作
              </div>
              <div class="quick-actions flex flex-col gap-2">
                <button
                  type="button"
                  class="quick-action quick-action--primary flex items-center gap-2 border border-primary bg-primary/10 px-3 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20"
                  @click="goNewProject"
                >
                  <span class="material-symbols-outlined text-sm">add</span>
                  新建项目
                </button>
                <button
                  type="button"
                  class="quick-action flex items-center gap-2 border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  @click="
                    router.push(
                      latestProjects[0]
                        ? {
                            path: '/workspace/ai-tasks',
                            query: { projectId: String(latestProjects[0].id) },
                          }
                        : '/workspace/ai-tasks',
                    )
                  "
                >
                  <span class="material-symbols-outlined text-sm">pending_actions</span>
                  任务中心
                </button>
                <button
                  type="button"
                  class="quick-action flex items-center gap-2 border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  :disabled="!latestProjects[0]"
                  @click="latestProjects[0] && openProject(latestProjects[0])"
                >
                  <span class="material-symbols-outlined text-sm">play_arrow</span>
                  继续最近项目
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>

    <dialog
      ref="deleteDialog"
      class="delete-project-dialog border border-outline-variant bg-surface-container p-0 text-on-surface"
      @close="deleteTarget = null; deleteConfirmName = ''; deleteDialogError = ''"
    >
      <form class="delete-project-form" @submit.prevent="onDeleteProject">
        <div class="delete-project-dialog-head">
          <span class="material-symbols-outlined text-danger-red">delete_forever</span>
          <div>
            <h2>删除项目</h2>
            <p>此操作不可恢复。</p>
          </div>
        </div>

        <div class="delete-project-scope">
          <p>将删除以下内容：</p>
          <ul>
            <li>项目设定、总纲、剧本与分镜</li>
            <li>角色、静帧、视频、音频与导出记录</li>
            <li>项目任务、质量报告与成本记录</li>
          </ul>
        </div>

        <label class="delete-project-confirm">
          <span>请输入页面显示的完整项目名称以确认：{{ projectDisplayName(deleteTarget) }}</span>
          <input
            v-model="deleteConfirmName"
            type="text"
            :placeholder="`请输入：${projectDisplayName(deleteTarget)}`"
            autocomplete="off"
            @input="deleteDialogError = ''"
          />
        </label>

        <p v-if="deleteDialogError" class="delete-project-dialog-error" role="alert">
          <span class="material-symbols-outlined" aria-hidden="true">error</span>
          {{ deleteDialogError }}
        </p>

        <div class="delete-project-actions">
          <button type="button" class="dialog-cancel" :disabled="deletingProject" @click="closeDeleteDialog">
            取消
          </button>
          <button
            type="submit"
            class="dialog-delete"
            :disabled="deletingProject || !canDeleteProject"
          >
            {{ deletingProject ? '删除中' : '永久删除' }}
          </button>
        </div>
      </form>
    </dialog>
  </WorkspaceLayout>
</template>

<style scoped>
/* ============================================================
 * 帧心帧意工作台视觉层
 * - 只负责展示、层级和响应式，不触碰项目加载与路由行为
 * - 保持硬边界和铜橙单色强调，避免卡片堆叠成模板感
 * ============================================================ */
.dashboard-content {
  position: relative;
  isolation: isolate;
  min-height: 100%;
  --project-cover-fallback: linear-gradient(155deg, #292923, #111412 68%);
  background:
    radial-gradient(circle at 78% 0%, rgba(164, 132, 84, 0.09), transparent 28rem),
    linear-gradient(180deg, rgba(255, 183, 125, 0.025), transparent 18rem);
}

.dashboard-content::before {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image: linear-gradient(rgba(255, 183, 125, 0.018) 1px, transparent 1px);
  background-size: 100% 72px;
  content: '';
  pointer-events: none;
}

.dashboard-grid {
  align-items: start;
}

.project-section {
  width: 100%;
}

.continue-panel {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  margin-bottom: 1.5rem;
  border: 1px solid rgba(230, 193, 140, 0.28);
  background: #171916;
  padding: 1.15rem 1.25rem;
  overflow: hidden;
}

.continue-cover {
  position: relative;
  display: grid;
  width: 4rem;
  height: 6.5rem;
  flex: 0 0 auto;
  overflow: hidden;
  place-items: center;
  border: 1px solid rgba(230, 193, 140, 0.26);
  background: var(--project-cover-fallback);
  color: rgba(255, 183, 125, 0.7);
}

.continue-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.continue-cover--empty::after { position: absolute; inset: 45% 0 0; background: linear-gradient(transparent, #0c0f0dcc); content: ''; }
.continue-cover > .material-symbols-outlined { font-size: 1.35rem; }
.continue-panel-copy { min-width: 0; flex: 1; }

.featured-title-group {
  margin: -0.6rem 0 1.5rem 5.25rem;
  color: #c7b8a6;
}
.featured-title-group > summary {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.45rem;
  color: #bca98f;
  cursor: pointer;
  font-size: 0.7rem;
  list-style: none;
}
.featured-title-group > summary::-webkit-details-marker { display: none; }
.featured-title-group > summary > .material-symbols-outlined:first-child { color: #d9ad7b; font-size: 1rem; }
.featured-title-count { color: #948675; }
.featured-title-chevron { font-size: 1rem; transition: transform 180ms ease; }
.featured-title-group[open] .featured-title-chevron { transform: rotate(180deg); }
.featured-title-group ul { display: grid; max-width: 36rem; gap: 0.35rem; padding: 0.35rem 0 0.6rem; }
.featured-title-group li { border-bottom: 1px solid rgba(164, 132, 84, 0.18); }
.featured-title-group li button {
  display: grid;
  width: 100%;
  min-height: 2.5rem;
  grid-template-columns: 5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.35rem 0.5rem;
  text-align: left;
  transition: color 180ms ease, background-color 180ms ease;
}
.featured-title-group li button:hover { background: rgba(255, 183, 125, 0.05); color: #f2d5b3; }
.featured-title-code { color: #e3b985; font: 0.68rem ui-monospace, monospace; }
.featured-title-status { overflow: hidden; color: #a59a8b; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
.featured-title-group li button > .material-symbols-outlined { font-size: 1rem; }

.continue-panel-label {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: #ffb77d;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.continue-panel-label .material-symbols-outlined {
  font-size: 0.95rem;
}

.continue-panel h2 {
  max-width: 100%;
  overflow-wrap: anywhere;
  margin-top: 0.3rem;
  color: #f1ece4;
  font-size: 1.25rem;
  line-height: 1.3;
  font-weight: 700;
}

.continue-panel p {
  max-width: 68ch;
  margin-top: 0.35rem;
  color: #a6a49d;
  font-size: 0.75rem;
  line-height: 1.5;
}

.continue-panel-actions {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex: 0 0 auto;
}

.continue-progress {
  color: #ffb77d;
  font-size: 0.85rem;
  font-weight: 700;
}

.continue-button {
  display: inline-flex;
  min-height: 2.35rem;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid #ffb77d;
  background: #d97707;
  padding: 0 0.85rem;
  color: #1b1309;
  font-size: 0.75rem;
  font-weight: 800;
  transition: transform 180ms ease, background-color 180ms ease;
}

.continue-button:hover {
  background: #ffb77d;
  transform: translateY(-1px);
}

.project-card {
  cursor: default;
  padding: 1.15rem 1.25rem;
  border-radius: 0;
}

.project-card-inner {
  min-height: 7.5rem;
}

.project-cover {
  position: relative;
  display: grid;
  width: 4.6rem;
  height: 7.5rem;
  flex: 0 0 auto;
  overflow: hidden;
  place-items: center;
  border: 1px solid rgba(230, 193, 140, 0.22);
  background: var(--project-cover-fallback);
  color: rgba(255, 183, 125, 0.65);
}

.project-cover img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 400ms cubic-bezier(0.16, 1, 0.3, 1);
}

.project-card:hover .project-cover img { transform: scale(1.04); }
.project-cover--empty::after { position: absolute; inset: 45% 0 0; background: linear-gradient(transparent, #0c0f0dcc); content: ''; }
.project-cover > .material-symbols-outlined { font-size: 1.5rem; }
.project-cover-code { position: absolute; z-index: 1; right: .3rem; bottom: .25rem; color: #f0d5b4; font: .52rem ui-monospace, monospace; }
.project-progress-value { display: flex; align-items: baseline; gap: .1rem; }

.project-card-actions {
  margin-top: 0.85rem;
  border-top: 1px solid rgba(164, 132, 84, 0.18);
  padding-top: 0.75rem;
}

.project-card-actions button:first-child {
  background: rgba(255, 183, 125, 0.08);
}

.project-card-actions button:first-child:hover {
  background: rgba(255, 183, 125, 0.15);
}

.dashboard-header {
  position: relative;
  border-bottom: 0;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
}

.dashboard-header::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(164, 132, 84, 0.24),
    rgba(164, 132, 84, 0.14) 62%,
    rgba(164, 132, 84, 0)
  );
  content: '';
  pointer-events: none;
}

.dashboard-heading {
  max-width: 44rem;
}

.dashboard-kicker {
  color: #ffb77d;
}

.dashboard-title {
  font-size: clamp(2rem, 3.2vw, 3rem);
  letter-spacing: 0;
  line-height: 1.05;
}

.dashboard-summary {
  max-width: 42rem;
  color: #b7aa9c;
}

.filter-strip {
  border-color: rgba(164, 132, 84, 0.42);
  background: rgba(13, 15, 13, 0.62);
}

.filter-option {
  min-height: 2.25rem;
  transition:
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.filter-option[aria-selected='true'] {
  background: rgba(255, 183, 125, 0.12);
  color: #ffb77d;
}

.dashboard-create {
  min-height: 2.25rem;
  box-shadow: 0 10px 24px rgba(217, 119, 7, 0.14);
  transition:
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.dashboard-create:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 30px rgba(217, 119, 7, 0.22);
}

.archive-list-toggle {
  min-height: 2.25rem;
  transition:
    border-color 180ms ease,
    color 180ms ease,
    background-color 180ms ease;
}

.archive-list-toggle[aria-pressed='true'] {
  border-color: rgba(255, 183, 125, 0.55);
  background: rgba(255, 183, 125, 0.08);
  color: #ffb77d;
}

.lifecycle-feedback {
  position: fixed;
  top: calc(64px + 1rem);
  left: max(1rem, calc(220px + 1.5rem));
  right: max(1rem, calc(320px + 1.5rem));
  z-index: 80;
  min-height: 3rem;
  margin: 0;
  align-items: center;
  pointer-events: auto;
  background: #24231f;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
  animation: lifecycle-feedback-in 180ms ease-out;
}

.lifecycle-feedback-copy {
  min-width: 0;
  overflow-wrap: anywhere;
}

.lifecycle-feedback--success {
  border-color: rgba(164, 132, 84, 0.42);
  background: rgba(255, 183, 125, 0.06);
  color: #f5dfc7;
}

.lifecycle-feedback--error {
  border-color: rgba(248, 113, 113, 0.5);
  background: rgba(127, 29, 29, 0.18);
  color: #fecaca;
}

.lifecycle-feedback-close {
  flex: 0 0 auto;
  color: inherit;
  opacity: 0.75;
}

.lifecycle-feedback-close:hover {
  opacity: 1;
}

@keyframes lifecycle-feedback-in {
  from {
    opacity: 0;
    transform: translateY(-0.35rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 1279px) {
  .lifecycle-feedback {
    right: 1rem;
  }
}

@media (max-width: 1023px) {
  .lifecycle-feedback {
    left: 1rem;
  }
}

@media (max-width: 639px) {
  .continue-panel {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.75rem;
  }

  .continue-cover { width: 3.5rem; height: 5.75rem; }
  .continue-panel-actions { grid-column: 2; width: 100%; justify-content: space-between; }
  .lifecycle-feedback {
    top: calc(64px + 0.75rem);
    left: 0.75rem;
    right: 0.75rem;
    padding: 0.75rem;
  }
}

.context-hint {
  margin: 1.5rem 1.5rem 0;
  border-color: rgba(255, 183, 125, 0.38);
  background: rgba(255, 183, 125, 0.05);
}

.project-card {
  overflow: hidden;
  border-color: rgba(164, 132, 84, 0.34);
  background:
    linear-gradient(110deg, rgba(255, 255, 255, 0.035), transparent 45%),
    #171a18;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
  transition:
    border-color 260ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 260ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 260ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 260ms cubic-bezier(0.16, 1, 0.3, 1);
}

.dashboard-content--scroll-safe {
  padding-bottom: max(8rem, env(safe-area-inset-bottom));
}

.project-list {
  display: flex;
  flex-direction: column;
  gap: 1.75rem;
  padding-bottom: 2rem;
}

.empty-projects-group {
  margin-top: 0.5rem;
  border-top: 1px solid rgba(164, 132, 84, 0.2);
  border-bottom: 1px solid rgba(164, 132, 84, 0.2);
}
.empty-projects-summary {
  display: grid;
  min-height: 4rem;
  grid-template-columns: auto auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  color: #b7aa9c;
  cursor: pointer;
  list-style: none;
}
.empty-projects-summary::-webkit-details-marker { display: none; }
.empty-projects-summary > .material-symbols-outlined:first-child { color: #d4a66f; }
.empty-projects-title { color: #eee5d9; font-size: 0.9rem; font-weight: 650; }
.empty-projects-count {
  display: inline-grid;
  min-width: 1.5rem;
  height: 1.5rem;
  place-items: center;
  border: 1px solid rgba(164, 132, 84, 0.36);
  color: #e4ba8b;
  font: 600 0.72rem ui-monospace, monospace;
}
.empty-projects-caption { color: #968c80; font-size: 0.75rem; }
.empty-projects-chevron { transition: transform 180ms ease; }
.empty-projects-group[open] .empty-projects-chevron { transform: rotate(180deg); }
.empty-project-list { display: grid; gap: 0.5rem; padding: 0 0 0.85rem; }
.empty-project-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  border: 1px solid rgba(164, 132, 84, 0.2);
  background: linear-gradient(100deg, rgba(255, 255, 255, 0.025), transparent 72%), #141715;
  transition: border-color 180ms ease;
}
.empty-project-row:hover { border-color: rgba(255, 183, 125, 0.45); }
.empty-project-open {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.9rem;
  padding: 0.65rem 0.85rem;
  text-align: left;
}
.empty-project-cover {
  position: relative;
  display: grid;
  width: 2.5rem;
  height: 3.5rem;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(230, 193, 140, 0.2);
  background: var(--project-cover-fallback);
  color: #d5ad7b;
}
.empty-project-cover .material-symbols-outlined { font-size: 1.1rem; }
.empty-project-cover > span:last-child {
  position: absolute;
  right: 0.15rem;
  bottom: 0.1rem;
  color: #e6d2b6;
  font: 0.42rem ui-monospace, monospace;
}
.empty-project-copy { display: grid; min-width: 0; gap: 0.25rem; }
.empty-project-copy strong { overflow: hidden; color: #eee5d9; font-size: 0.88rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.empty-project-copy > span { overflow: hidden; color: #968c80; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }
.empty-project-cta { display: inline-flex; align-items: center; gap: 0.3rem; color: #e7b883; font-size: 0.72rem; font-weight: 650; white-space: nowrap; }
.empty-project-cta .material-symbols-outlined { font-size: 1rem; transition: transform 180ms ease; }
.empty-project-open:hover .empty-project-cta .material-symbols-outlined { transform: translateX(2px); }
.empty-project-actions { display: flex; gap: 0.35rem; padding-right: 0.65rem; }
.empty-project-actions button {
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid rgba(164, 132, 84, 0.25);
  color: #a99a88;
  transition: border-color 180ms ease, color 180ms ease, background-color 180ms ease;
}
.empty-project-actions button:hover { border-color: rgba(255, 183, 125, 0.55); background: rgba(255, 183, 125, 0.06); color: #ffb77d; }
.empty-project-actions button:disabled { cursor: wait; opacity: 0.5; }

.project-card:hover,
.project-card:focus-visible {
  border-color: rgba(255, 183, 125, 0.72);
  background:
    linear-gradient(110deg, rgba(255, 183, 125, 0.065), transparent 48%),
    #1e201e;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 16px 36px rgba(0, 0, 0, 0.18);
  transform: translateY(-2px);
}

.project-card:focus-visible {
  outline: 2px solid rgba(255, 183, 125, 0.72);
  outline-offset: 3px;
}

.project-card-inner {
  min-height: 9rem;
}

.project-progress-ring {
  color: #ffb77d;
}

.project-progress-ring svg circle:first-child {
  color: rgba(164, 132, 84, 0.34);
}

.project-card-title {
  letter-spacing: 0;
  transition: color 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.project-card-title { max-width: min(100%, 32rem); }

.project-card-meta {
  color: #a38c7c;
}

.project-card-progress > div {
  background: rgba(164, 132, 84, 0.32);
}

.project-card-progress > div > div {
  box-shadow: 0 0 12px rgba(217, 119, 7, 0.24);
}

.project-card-aside {
  min-height: 8rem;
  color: #8f877d;
}

.project-card-actions {
  border-top: 1px solid rgba(164, 132, 84, 0.18);
  padding-top: 0.75rem;
}

.project-action-icon {
  display: inline-grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid rgba(164, 132, 84, 0.32);
  color: #a38c7c;
  transition:
    border-color 180ms ease,
    color 180ms ease,
    background-color 180ms ease;
}

.project-action-icon:hover,
.project-action-icon[aria-expanded='true'] {
  border-color: rgba(255, 183, 125, 0.64);
  background: rgba(255, 183, 125, 0.07);
  color: #ffb77d;
}

.project-lifecycle-bar {
  margin-top: 0.75rem;
  border-color: rgba(164, 132, 84, 0.26);
}

.project-lifecycle-bar p {
  margin: 0;
}

.lifecycle-action {
  min-height: 2.25rem;
  transition:
    border-color 180ms ease,
    color 180ms ease,
    background-color 180ms ease;
}

.lifecycle-action:disabled {
  cursor: wait;
  opacity: 0.58;
}

.lifecycle-action--danger {
  border-color: rgba(248, 113, 113, 0.46);
  color: #fca5a5;
}

.lifecycle-action--danger:hover {
  border-color: rgba(248, 113, 113, 0.82);
  background: rgba(127, 29, 29, 0.2);
  color: #fee2e2;
}

.project-card-rule {
  box-shadow: 0 0 18px rgba(217, 119, 7, 0.5);
  transition: transform 420ms cubic-bezier(0.16, 1, 0.3, 1);
}

.studio-sidebar {
  min-width: 0;
  position: sticky;
  top: 1rem;
}

.studio-card {
  border-color: rgba(164, 132, 84, 0.34);
  background:
    linear-gradient(145deg, rgba(255, 183, 125, 0.04), transparent 46%),
    #141715;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.studio-card-heading {
  color: #e6c18c;
}

.stat-cell {
  border-color: rgba(164, 132, 84, 0.25);
  background: rgba(13, 15, 13, 0.45);
}

.activity-list li {
  border-color: rgba(164, 132, 84, 0.32);
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.activity-list li:hover {
  transform: translateX(2px);
}

.quick-action {
  min-height: 2.5rem;
  transition:
    border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    background-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    color 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.quick-action:hover:not(:disabled) {
  transform: translateX(2px);
}

.quick-action:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.state-panel {
  min-height: 18rem;
  border-color: rgba(164, 132, 84, 0.34);
}

.state-panel--error {
  background: rgba(185, 28, 28, 0.08);
}

.state-panel--empty,
.state-panel--filtered {
  background: rgba(26, 28, 26, 0.72);
}

.studio-sidebar .studio-card + .studio-card {
  margin-top: 0.9rem;
}

.stats-grid {
  gap: 0;
  border-top: 1px solid rgba(164, 132, 84, 0.22);
  border-bottom: 1px solid rgba(164, 132, 84, 0.22);
}

.stat-cell {
  min-width: 0;
  border: 0;
  border-right: 1px solid rgba(164, 132, 84, 0.22);
  background: transparent;
}

.stat-cell:last-child { border-right: 0; }

.stat-cell > div:first-child {
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.stat-value {
  font-size: 2rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.activity-list li {
  padding: 0.2rem 0 0.2rem 0.8rem;
}

.quick-action {
  justify-content: flex-start;
}

.delete-project-dialog {
  width: min(32rem, calc(100vw - 2rem));
  max-width: none;
  color: #f4ede5;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.52);
}

.delete-project-dialog::backdrop {
  background: rgba(4, 5, 4, 0.72);
}

.delete-project-form {
  display: grid;
  gap: 1.25rem;
  padding: 1.5rem;
}

.delete-project-dialog-head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.delete-project-dialog-head h2 {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
}

.delete-project-dialog-head p,
.delete-project-scope p {
  margin: 0.25rem 0 0;
  color: #b8a899;
  font-size: 0.875rem;
  line-height: 1.55;
}

.delete-project-scope {
  border: 1px solid rgba(248, 113, 113, 0.3);
  background: rgba(127, 29, 29, 0.16);
  padding: 0.875rem 1rem;
}

.delete-project-scope ul {
  display: grid;
  gap: 0.4rem;
  margin: 0.625rem 0 0;
  padding-left: 1.125rem;
  color: #e7d1c8;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.delete-project-confirm {
  display: grid;
  gap: 0.5rem;
  color: #d8c1aa;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.delete-project-confirm input {
  min-height: 2.5rem;
  border: 1px solid rgba(164, 132, 84, 0.42);
  background: #111310;
  padding: 0.5rem 0.75rem;
  color: #f4ede5;
  outline: none;
}

.delete-project-confirm input:focus {
  border-color: rgba(255, 183, 125, 0.78);
  box-shadow: 0 0 0 2px rgba(255, 183, 125, 0.12);
}

.delete-project-dialog-error {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: -0.25rem 0 0;
  border: 1px solid rgba(248, 113, 113, 0.42);
  background: rgba(127, 29, 29, 0.18);
  padding: 0.65rem 0.75rem;
  color: #fecaca;
  font-size: 0.8125rem;
  line-height: 1.45;
}

.delete-project-dialog-error .material-symbols-outlined {
  flex: 0 0 auto;
  font-size: 1rem;
}

.delete-project-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.dialog-cancel,
.dialog-delete {
  min-height: 2.375rem;
  padding: 0 1rem;
  font-size: 0.8125rem;
  font-weight: 700;
  transition:
    border-color 180ms ease,
    color 180ms ease,
    background-color 180ms ease;
}

.dialog-cancel {
  border: 1px solid rgba(164, 132, 84, 0.38);
  color: #d8c1aa;
}

.dialog-cancel:hover:not(:disabled) {
  border-color: rgba(255, 183, 125, 0.64);
  color: #ffb77d;
}

.dialog-delete {
  background: #b91c1c;
  color: #fff7ed;
}

.dialog-delete:hover:not(:disabled) {
  background: #dc2626;
}

.dialog-cancel:disabled,
.dialog-delete:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.loading-row {
  border-color: rgba(164, 132, 84, 0.28);
  background: #171917;
}

@media (max-width: 1023px) {
  .dashboard-content { padding-top: 1.25rem; }
  .context-hint { margin: 1rem 1rem 0; }
  .dashboard-grid { gap: 2rem; }
  .studio-sidebar { position: static; }
}

@media (max-width: 639px) {
  .continue-panel {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.9rem;
  }

  .continue-panel-actions {
    width: 100%;
    justify-content: space-between;
  }

  .dashboard-content {
    padding-right: 1rem;
    padding-left: 1rem;
  }

  .dashboard-grid { gap: 1.5rem; }
  .studio-sidebar { display: grid; grid-template-columns: 1fr; gap: 0.85rem; }
  .studio-sidebar .studio-card + .studio-card { margin-top: 0; }
  .featured-title-group { margin: -0.5rem 0 1.25rem 4.25rem; }
  .featured-title-group li button { grid-template-columns: 4.25rem minmax(0, 1fr) auto; gap: 0.45rem; }

  .dashboard-header {
    align-items: flex-start;
    padding-bottom: 1rem;
  }

  .dashboard-controls {
    width: 100%;
    align-items: stretch;
  }

  .filter-strip {
    flex: 1 1 auto;
    min-width: 0;
  }

  .filter-option {
    flex: 1 1 0;
    padding-right: 0.55rem;
    padding-left: 0.55rem;
    font-size: 0.625rem;
    letter-spacing: 0.08em;
  }

  .dashboard-create { flex: 0 0 auto; }

  .project-card { padding: 1rem; }
  .project-card-inner { gap: 0.75rem; }
  .project-cover { width: 3.5rem; height: 5.75rem; }
  .project-progress-ring { height: 4rem; width: 4rem; }
  .project-card-title { font-size: 1.1rem; line-height: 1.25; }
  .project-card-body { min-width: 0; }
  .empty-projects-summary { grid-template-columns: auto auto auto 1fr auto; gap: 0.45rem; }
  .empty-projects-caption { grid-column: 2 / 5; grid-row: 2; padding-bottom: 0.6rem; }
  .empty-projects-chevron { grid-column: 5; grid-row: 1; }
  .empty-project-cta { font-size: 0; }
  .empty-project-cta .material-symbols-outlined { font-size: 1.1rem; }
  .empty-project-open { gap: 0.6rem; padding-inline: 0.6rem; }
  .empty-project-copy strong { font-size: 0.8rem; }
  .empty-project-copy > span { max-width: 14rem; font-size: 0.64rem; }
  .empty-project-actions { gap: 0.2rem; padding-right: 0.4rem; }

  .project-lifecycle-bar {
    align-items: flex-start;
  }

  .delete-project-actions {
    flex-direction: column-reverse;
  }

  .dialog-cancel,
  .dialog-delete {
    width: 100%;
  }
}

/* ============================================================
 * 进场 stagger：与 App.vue 路由过渡配合
 * - 工具条 80ms → 列表 200ms（依次）
 * - 用 transform + opacity（GPU 友好）
 * - 尊重 prefers-reduced-motion
 * ============================================================ */
@keyframes stream-fade {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.console-toolbar {
  animation: stream-fade 420ms cubic-bezier(0.16, 1, 0.3, 1) 80ms both;
}

.console-list > li {
  animation: stream-fade 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.console-list > li:nth-child(1) { animation-delay: 200ms; }
.console-list > li:nth-child(2) { animation-delay: 280ms; }
.console-list > li:nth-child(3) { animation-delay: 360ms; }
.console-list > li:nth-child(4) { animation-delay: 440ms; }
.console-list > li:nth-child(5) { animation-delay: 520ms; }
.console-list > li:nth-child(6) { animation-delay: 600ms; }

.console-side > * {
  animation: stream-fade 420ms cubic-bezier(0.16, 1, 0.3, 1) 260ms both;
}

@media (prefers-reduced-motion: reduce) {
  .console-toolbar,
  .console-list > li,
  .console-side > * {
    animation: none;
  }
  .console-list > li {
    transition: none;
  }
}
</style>
