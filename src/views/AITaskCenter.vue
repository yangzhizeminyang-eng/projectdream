<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  cancelProjectTask,
  executeRecoveryVideoFinalEdit,
  getProject,
  getProjectTasks,
  getRecoveryVideoReviewQueue,
  getRecoveryVideoFinalEditPlan,
  rollbackRecoveryVideoFinalEdit,
  retryProjectTask,
  type ProjectDTO,
  type ProjectTaskItemDTO,
  type ProjectTasksDTO,
  type RecoveryVideoReviewQueueDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'
import { formatShotDuration } from '@/lib/episode-clips.mjs'

type PageState = 'missing-project' | 'loading' | 'empty' | 'error' | 'ready'
type TaskTypeFilter = 'all' | 'image' | 'video' | 'audio' | 'export'
type RuntimeStatusFilter = 'all' | 'queued' | 'running' | 'success' | 'failed' | 'canceled'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const taskPayload = ref<ProjectTasksDTO | null>(null)
const recoveryReviewQueue = ref<RecoveryVideoReviewQueueDTO | null>(null)
const selectedTaskKey = ref<string | null>(null)
const taskTypeFilter = ref<TaskTypeFilter>('all')
const runtimeStatusFilter = ref<RuntimeStatusFilter>('all')
const errorMsg = ref('')
const infoMsg = ref('')
const actionTaskKey = ref<string | null>(null)
const refreshing = ref(false)

let refreshTimer: ReturnType<typeof setTimeout> | null = null

const items = computed(() => taskPayload.value?.items || [])
const summary = computed(() => taskPayload.value?.summary || null)
const recoveryReviewItems = computed(() => recoveryReviewQueue.value?.items || [])
const recoveryReviewSummary = computed(() => recoveryReviewQueue.value?.summary || null)
const recoveryInspectionSummary = computed(() => ({
  readyCount: recoveryReviewItems.value.filter((item) => item.inspectionReadiness === 'ready').length,
  pendingInspectionCount: recoveryReviewItems.value.filter(
    (item) => item.inspectionReadiness === 'pending-inspection',
  ).length,
  blockedCount: recoveryReviewItems.value.filter((item) => item.inspectionReadiness === 'blocked').length,
}))

const taskTypeOptions = computed(() => [
  { key: 'all' as const, label: '全部', count: items.value.length },
  { key: 'image' as const, label: '静帧', count: summary.value?.imageCount || 0 },
  { key: 'video' as const, label: '视频', count: summary.value?.videoCount || 0 },
  { key: 'audio' as const, label: '音频', count: summary.value?.audioCount || 0 },
  { key: 'export' as const, label: '导出', count: summary.value?.exportCount || 0 },
])

const runtimeStatusOptions = computed(() => [
  { key: 'all' as const, label: '全部状态', count: items.value.length },
  { key: 'queued' as const, label: '排队中', count: summary.value?.queuedCount || 0 },
  { key: 'running' as const, label: '执行中', count: summary.value?.runningCount || 0 },
  { key: 'success' as const, label: '已完成', count: summary.value?.successCount || 0 },
  { key: 'failed' as const, label: '失败', count: summary.value?.failedCount || 0 },
  { key: 'canceled' as const, label: '已取消', count: summary.value?.canceledCount || 0 },
])

const filteredItems = computed<ProjectTaskItemDTO[]>(() =>
  items.value.filter((item) => {
    if (taskTypeFilter.value !== 'all' && item.taskType !== taskTypeFilter.value) return false
    if (runtimeStatusFilter.value !== 'all' && item.runtimeStatus !== runtimeStatusFilter.value)
      return false
    return true
  }),
)

const selectedTask = computed<ProjectTaskItemDTO | null>(
  () => items.value.find((item) => item.taskKey === selectedTaskKey.value) || null,
)

const hasActiveRuntime = computed(() =>
  items.value.some((item) => item.runtimeStatus === 'queued' || item.runtimeStatus === 'running'),
)

const statCards = computed(() => {
  const stats = summary.value
  if (!stats) return []
  return [
    { label: '任务总数', value: String(stats.totalCount), tone: 'primary' },
    { label: '执行中', value: String(stats.runningCount), tone: 'warning' },
    { label: '排队中', value: String(stats.queuedCount), tone: 'default' },
    { label: '已完成', value: String(stats.successCount), tone: 'success' },
    { label: '失败 / 取消', value: String((stats.failedCount || 0) + (stats.canceledCount || 0)), tone: 'danger' },
  ]
})

function clearRefreshTimer(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleAutoRefresh(): void {
  // 只有存在 queued/running 任务时才自动刷新，避免页面空闲时不断请求后端。
  clearRefreshTimer()
  if (pageState.value !== 'ready' || !hasActiveRuntime.value) return
  refreshTimer = setTimeout(() => {
    void loadPage({ preferredTaskKey: selectedTaskKey.value, silent: true })
  }, 2500)
}

function syncSelectedTask(preferredKey?: string | null): void {
  // 刷新任务列表后保持当前选中任务；如果选中项消失，优先选正在执行的任务。
  if (preferredKey && filteredItems.value.some((item) => item.taskKey === preferredKey)) {
    selectedTaskKey.value = preferredKey
    return
  }

  const running = filteredItems.value.find(
    (item) => item.runtimeStatus === 'running' || item.runtimeStatus === 'queued',
  )
  if (running) {
    selectedTaskKey.value = running.taskKey
    return
  }

  const confirmed = filteredItems.value.find((item) => item.status === 'confirmed')
  if (confirmed) {
    selectedTaskKey.value = confirmed.taskKey
    return
  }

  selectedTaskKey.value = filteredItems.value[0]?.taskKey || items.value[0]?.taskKey || null
}

function formatDateTime(value?: string | null): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function taskTypeLabel(taskType: ProjectTaskItemDTO['taskType']): string {
  if (taskType === 'image') return '静帧'
  if (taskType === 'video') return '视频'
  if (taskType === 'audio') return '音频'
  return '导出'
}

function taskTypeIcon(taskType: ProjectTaskItemDTO['taskType']): string {
  if (taskType === 'image') return 'image'
  if (taskType === 'video') return 'videocam'
  if (taskType === 'audio') return 'audio_file'
  return 'ios_share'
}

function runtimeStatusLabel(status?: ProjectTaskItemDTO['runtimeStatus']): string {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '执行中'
  if (status === 'success') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已取消'
  return '未知状态'
}

function runtimeStatusClass(status?: ProjectTaskItemDTO['runtimeStatus']): string {
  if (status === 'queued') return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  if (status === 'running') return 'border-sky-400/30 bg-sky-400/10 text-sky-200'
  if (status === 'success') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  if (status === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-200'
  if (status === 'canceled') return 'border-slate-400/30 bg-slate-400/10 text-slate-200'
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function businessStatusLabel(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'candidate') return '候选'
  if (status === 'completed') return '已导出'
  if (status === 'archived') return '已归档'
  return status || '未知'
}

function businessStatusClass(status: string): string {
  if (status === 'confirmed' || status === 'completed') {
    return 'border-primary/30 bg-primary/10 text-primary'
  }
  if (status === 'candidate') {
    return 'border-outline-variant bg-surface-container text-on-surface-variant'
  }
  if (status === 'archived') {
    return 'border-slate-400/30 bg-slate-400/10 text-slate-200'
  }
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function taskTypeClass(taskType: ProjectTaskItemDTO['taskType']): string {
  if (taskType === 'image') return 'border-primary/30 bg-primary/10 text-primary'
  if (taskType === 'video') return 'border-secondary/40 bg-secondary/10 text-secondary'
  if (taskType === 'audio') return 'border-tertiary/40 bg-tertiary/10 text-tertiary'
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function sceneShotLabel(item: ProjectTaskItemDTO): string {
  if (item.sceneNo && item.shotNo) return `Scene ${String(item.sceneNo).padStart(2, '0')} / ${item.shotNo}`
  if (item.sceneNo) return `Scene ${String(item.sceneNo).padStart(2, '0')}`
  return '项目级任务'
}

function versionLabel(item: ProjectTaskItemDTO): string {
  if (!item.versionNo) return '无版本号'
  return `V${item.versionNo}`
}

function progressValue(item: ProjectTaskItemDTO | null): number {
  if (!item) return 0
  return Math.max(0, Math.min(100, Number(item.progressPercent || 0)))
}

function isBusy(taskKey: string): boolean {
  return actionTaskKey.value === taskKey
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goSource(task: ProjectTaskItemDTO): void {
  if (task.taskType === 'image' && task.characterId) {
    router.push({
      path: '/workspace/character/detail',
      query: {
        projectId: String(task.projectId),
        characterId: String(task.characterId),
      },
    })
    return
  }

  if ((task.taskType === 'image' || task.taskType === 'video') && task.projectId) {
    router.push({
      path: '/workspace/episodes/studio',
      query: {
        projectId: String(task.projectId),
        ...(task.sceneId ? { sceneId: String(task.sceneId) } : {}),
        ...(task.storyboardId ? { storyboardId: String(task.storyboardId) } : {}),
      },
    })
    return
  }

  if (task.taskType === 'audio') {
    router.push({
      path: '/workspace/audio',
      query: {
        projectId: String(task.projectId),
        ...(task.sceneId ? { sceneId: String(task.sceneId) } : {}),
      },
    })
    return
  }

  router.push({
    path: '/workspace/episodes',
    query: { projectId: String(task.projectId) },
  })
}

function goRecoveryReview(item: RecoveryVideoReviewQueueDTO['items'][number]): void {
  router.push({
    path: '/workspace/episodes/studio',
    query: {
      projectId: String(projectId.value),
      sceneId: String(item.sceneId),
      storyboardId: String(item.storyboardId),
    },
  })
}

async function startRecoveryFinalEdit(
  item: RecoveryVideoReviewQueueDTO['items'][number],
): Promise<void> {
  if (item.finalEditReadiness.status !== 'ready-for-final-edit') return
  const actionKey = `recovery-final-edit-${item.id}`
  if (actionTaskKey.value === actionKey) return

  const token = window.prompt(
    '请输入 START_RECOVERY_FINAL_EDIT，确认只对这一条恢复候选执行竖屏终剪：',
  )
  if (token !== 'START_RECOVERY_FINAL_EDIT') {
    infoMsg.value = '已取消终剪，未创建任务。'
    return
  }

  actionTaskKey.value = actionKey
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const plan = await getRecoveryVideoFinalEditPlan(item.id)
    if (!plan.canStart || plan.finalEditPlan.status !== 'ready') {
      throw new Error('服务端复核发现该视频已不满足终剪前置条件，请刷新后重试。')
    }
    const result = await executeRecoveryVideoFinalEdit(item.id, {
      planId: plan.finalEditPlan.planId,
      confirm: true,
      confirmationToken: 'START_RECOVERY_FINAL_EDIT',
    })
    infoMsg.value = result.execution.reused
      ? `已复用单条终剪任务 #${result.export.id}。`
      : `单条竖屏终剪任务 #${result.export.id} 已入队，原恢复候选保持不变。`
    await loadPage({ preferredTaskKey: selectedTaskKey.value, silent: true })
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '终剪任务创建失败'
  } finally {
    actionTaskKey.value = null
  }
}

function recoveryReviewStatusLabel(status: RecoveryVideoReviewQueueDTO['items'][number]['reviewStatus']): string {
  if (status === 'approved') return '已批准'
  if (status === 'rework') return '需返工'
  return '待复核'
}

function recoveryReviewStatusClass(status: RecoveryVideoReviewQueueDTO['items'][number]['reviewStatus']): string {
  if (status === 'approved') return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  if (status === 'rework') return 'border-red-400/35 bg-red-400/10 text-red-200'
  return 'border-amber-400/35 bg-amber-400/10 text-amber-100'
}

function inspectionReadinessLabel(
  readiness: RecoveryVideoReviewQueueDTO['items'][number]['inspectionReadiness'],
): string {
  if (readiness === 'ready') return '可人工复核'
  if (readiness === 'blocked') return '技术阻塞'
  return '待技术检查'
}

function inspectionReadinessClass(
  readiness: RecoveryVideoReviewQueueDTO['items'][number]['inspectionReadiness'],
): string {
  if (readiness === 'ready') return 'border-sky-400/35 bg-sky-400/10 text-sky-100'
  if (readiness === 'blocked') return 'border-red-400/35 bg-red-400/10 text-red-200'
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function releaseReadinessLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  if (item.releaseReadiness.status === 'release-format-ready') return '发布规格就绪'
  if (item.releaseReadiness.status === 'needs-vertical-final-edit') return '需竖屏终剪'
  return '待技术检查'
}

function releaseReadinessClass(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  if (item.releaseReadiness.status === 'release-format-ready') {
    return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  }
  if (item.releaseReadiness.status === 'needs-vertical-final-edit') {
    return 'border-purple-300/35 bg-purple-300/10 text-purple-100'
  }
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function finalEditReadinessLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  if (item.finalEditReadiness.status === 'ready-for-final-edit') return '可进终剪'
  if (item.finalEditReadiness.status === 'waiting-manual-review') return '复核后终剪'
  if (item.finalEditReadiness.status === 'blocked-by-rework') return '返工阻塞'
  if (item.finalEditReadiness.status === 'not-required') return '无需终剪'
  return '技术检查后终剪'
}

function finalEditReadinessClass(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  if (item.finalEditReadiness.status === 'ready-for-final-edit') {
    return 'border-sky-400/35 bg-sky-400/10 text-sky-100'
  }
  if (item.finalEditReadiness.status === 'waiting-manual-review') {
    return 'border-amber-400/35 bg-amber-400/10 text-amber-100'
  }
  if (item.finalEditReadiness.status === 'blocked-by-rework') {
    return 'border-red-400/35 bg-red-400/10 text-red-200'
  }
  if (item.finalEditReadiness.status === 'not-required') {
    return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  }
  return 'border-outline-variant bg-surface-container text-on-surface-variant'
}

function finalEditTargetLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  const target = item.finalEditPlan.target
  return `${target.width}x${target.height} · ${target.frameRate}fps · ${target.videoCodec.toUpperCase()} + ${target.audioCodec.toUpperCase()} · ${target.container.toUpperCase()}`
}

function recoveryReviewActionLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  if (item.nextAction.code === 'regenerate-recovery-candidate') return '重新生成候选'
  return item.nextAction.label
}

function recoveryReworkReasonLabel(
  reason: RecoveryVideoReviewQueueDTO['items'][number]['reworkReasons'][number],
): string {
  if (reason.scope === 'character' && reason.characterId) {
    return `角色 #${reason.characterId}：${reason.message}`
  }
  return reason.message
}

function characterReviewProgressLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string | null {
  const summary = item.characterReviewSummary
  if (!summary.expectedCount) return null
  return `角色复核 ${summary.matchedCount}/${summary.expectedCount}`
}

function characterReviewStateLabel(item: RecoveryVideoReviewQueueDTO['items'][number]): string | null {
  const summary = item.characterReviewSummary
  if (!summary.expectedCount) return null
  if (!item.canStartManualReview) return '先完成技术检查'
  if (summary.reworkCount) return `返工 ${summary.reworkCount}`
  if (summary.pendingCount) return `待补 ${summary.pendingCount}`
  return '已完成'
}

function characterReviewStateClass(item: RecoveryVideoReviewQueueDTO['items'][number]): string {
  const summary = item.characterReviewSummary
  if (!item.canStartManualReview) {
    return 'border-outline-variant bg-surface-container text-on-surface-variant'
  }
  if (summary.reworkCount) return 'border-red-400/35 bg-red-400/10 text-red-200'
  if (summary.pendingCount) return 'border-amber-400/35 bg-amber-400/10 text-amber-100'
  return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
}

async function handleRecoveryFinalEditRollback(task: ProjectTaskItemDTO): Promise<void> {
  if (
    task.taskType !== 'export' ||
    !task.isRecoveryFinalEdit ||
    !task.canRollback ||
    isBusy(task.taskKey)
  ) {
    return
  }

  const confirmed = window.confirm(
    `确认回滚单条恢复终剪任务 #${task.sourceId}？\n\n任务会变为“已取消”，原恢复候选和已生成媒体都会保留。`,
  )
  if (!confirmed) {
    infoMsg.value = '已取消回滚，任务和媒体均未修改。'
    return
  }

  actionTaskKey.value = task.taskKey
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await rollbackRecoveryVideoFinalEdit(task.sourceId, {
      confirm: true,
      confirmationToken: 'ROLLBACK_RECOVERY_FINAL_EDIT',
    })
    infoMsg.value = result.rollback.idempotent
      ? `终剪任务 #${task.sourceId} 已经是回滚状态。`
      : `终剪任务 #${task.sourceId} 已回滚，原候选和媒体已保留。`
    await loadPage({ preferredTaskKey: task.taskKey, silent: true })
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '终剪回滚失败'
  } finally {
    actionTaskKey.value = null
  }
}

function openFile(task: ProjectTaskItemDTO): void {
  if (!task.fileUrl) return
  window.open(task.fileUrl, '_blank', 'noopener')
}

async function loadPage(options?: { preferredTaskKey?: string | null; silent?: boolean }): Promise<void> {
  // 任务中心同时读取项目基本信息和任务汇总。
  // silent=true 用于后台刷新，不覆盖用户当前的错误/提示文案。
  if (!projectId.value) {
    clearRefreshTimer()
    pageState.value = 'missing-project'
    project.value = null
    taskPayload.value = null
    recoveryReviewQueue.value = null
    selectedTaskKey.value = null
    return
  }

  const silent = Boolean(options?.silent && pageState.value === 'ready')
  if (silent) {
    refreshing.value = true
  } else {
    pageState.value = 'loading'
  }
  errorMsg.value = ''

  try {
    const [projectData, taskData, recoveryQueueData] = await Promise.all([
      getProject(projectId.value),
      getProjectTasks(projectId.value),
      getRecoveryVideoReviewQueue(projectId.value),
    ])

    project.value = projectData
    taskPayload.value = taskData
    recoveryReviewQueue.value = recoveryQueueData
    setWorkspaceContext({ projectId: projectId.value })
    pageState.value = taskData.items.length ? 'ready' : 'empty'
    syncSelectedTask(options?.preferredTaskKey ?? selectedTaskKey.value)
  } catch (error) {
    project.value = null
    taskPayload.value = null
    recoveryReviewQueue.value = null
    selectedTaskKey.value = null
    errorMsg.value = error instanceof Error ? error.message : '任务中心加载失败'
    pageState.value = 'error'
  } finally {
    refreshing.value = false
    scheduleAutoRefresh()
  }
}

async function handleRetry(task: ProjectTaskItemDTO): Promise<void> {
  if (isBusy(task.taskKey)) return
  actionTaskKey.value = task.taskKey
  infoMsg.value = ''
  try {
    await retryProjectTask(task.taskKey)
    infoMsg.value = `${task.title} 已重新加入队列`
    await loadPage({ preferredTaskKey: task.taskKey, silent: true })
  } catch (error) {
    infoMsg.value = error instanceof Error ? error.message : '重试失败'
  } finally {
    actionTaskKey.value = null
  }
}

async function handleCancel(task: ProjectTaskItemDTO): Promise<void> {
  if (isBusy(task.taskKey) || !task.canCancel) return
  actionTaskKey.value = task.taskKey
  infoMsg.value = ''
  try {
    await cancelProjectTask(task.taskKey)
    infoMsg.value = `${task.title} 已取消`
    await loadPage({ preferredTaskKey: task.taskKey, silent: true })
  } catch (error) {
    infoMsg.value = error instanceof Error ? error.message : '取消失败'
  } finally {
    actionTaskKey.value = null
  }
}

watch(
  () => route.query.projectId,
  () => {
    void loadPage({ preferredTaskKey: null })
  },
)

watch([taskTypeFilter, runtimeStatusFilter], () => {
  syncSelectedTask(selectedTaskKey.value)
})

watch(
  filteredItems,
  (list) => {
    if (!list.length) {
      selectedTaskKey.value = null
      return
    }
    if (!selectedTask.value || !list.some((item) => item.taskKey === selectedTask.value?.taskKey)) {
      syncSelectedTask(list[0]?.taskKey || null)
    }
  },
  { immediate: true },
)

watch(hasActiveRuntime, () => {
  scheduleAutoRefresh()
})

onMounted(() => {
  void loadPage({ preferredTaskKey: null })
})

onUnmounted(() => {
  clearRefreshTimer()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="false">
    <div class="grid min-h-full gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section class="min-w-0 space-y-6">
        <header
          class="rounded-[28px] border border-outline-variant bg-surface-container-low px-6 py-6 shadow-[0_18px_60px_rgba(0,0,0,0.18)]"
        >
          <div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div class="space-y-2">
              <p class="text-xs uppercase tracking-[0.28em] text-primary">Task Center Phase 2</p>
              <h1 class="font-display-lg text-3xl text-on-surface md:text-4xl">任务中心</h1>
              <p class="max-w-3xl text-sm leading-6 text-on-surface-variant">
                在项目级视角统一查看静帧、视频、音频和导出任务，并补上排队、执行、完成、取消等运行态。
              </p>
              <p v-if="project" class="text-sm text-on-surface">
                当前项目：<span class="font-semibold text-primary">{{ project.name }}</span>
              </p>
            </div>

            <div class="flex flex-wrap gap-3">
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant transition hover:border-primary/40 hover:text-primary"
                type="button"
                @click="goDashboard"
              >
                返回项目总览
              </button>
              <button
                class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                type="button"
                @click="loadPage({ preferredTaskKey: selectedTaskKey, silent: true })"
              >
                {{ refreshing ? '刷新中...' : '刷新任务' }}
              </button>
            </div>
          </div>
        </header>

        <section
          v-if="pageState === 'missing-project'"
          class="rounded-[24px] border border-dashed border-outline bg-surface-container-low px-6 py-10 text-center"
        >
          <span class="material-symbols-outlined text-5xl text-primary/70">folder_off</span>
          <h2 class="mt-4 text-2xl text-on-surface">缺少项目上下文</h2>
          <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-on-surface-variant">
            当前任务中心需要依赖 `projectId`。请先从项目总览进入某个项目，再打开任务中心。
          </p>
          <button
            class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold"
            type="button"
            @click="goDashboard"
          >
            去项目总览
          </button>
        </section>

        <section
          v-else-if="pageState === 'loading'"
          class="rounded-[24px] border border-outline-variant bg-surface-container-low px-6 py-12 text-center"
        >
          <span class="material-symbols-outlined animate-spin text-5xl text-primary">
            progress_activity
          </span>
          <p class="mt-4 text-sm text-on-surface-variant">正在汇总项目任务记录...</p>
        </section>

        <section
          v-else-if="pageState === 'error'"
          class="rounded-[24px] border border-danger-red/40 bg-danger-red/5 px-6 py-10 text-center"
        >
          <span class="material-symbols-outlined text-5xl text-danger-red">error</span>
          <h2 class="mt-4 text-2xl text-on-surface">任务中心加载失败</h2>
          <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-on-surface-variant">
            {{ errorMsg || '请稍后重试，或回到项目页确认当前项目数据是否正常。' }}
          </p>
          <button
            class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold"
            type="button"
            @click="loadPage({ preferredTaskKey: null })"
          >
            重新加载
          </button>
        </section>

        <template v-else>
          <section v-if="infoMsg" class="rounded-[20px] border border-primary/20 bg-primary/8 px-5 py-4">
            <p class="text-sm text-primary">{{ infoMsg }}</p>
          </section>

          <section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <article
              v-for="stat in statCards"
              :key="stat.label"
              class="rounded-[22px] border border-outline-variant bg-surface-container-low px-5 py-5"
            >
              <p class="text-xs uppercase tracking-[0.18em] text-on-surface-variant">
                {{ stat.label }}
              </p>
              <p
                class="mt-3 text-3xl font-semibold"
                :class="{
                  'text-primary': stat.tone === 'primary',
                  'text-amber-200': stat.tone === 'warning',
                  'text-tertiary': stat.tone === 'success',
                  'text-red-200': stat.tone === 'danger',
                  'text-on-surface': stat.tone === 'default',
                }"
              >
                {{ stat.value }}
              </p>
            </article>
          </section>

          <section
            v-if="recoveryReviewSummary?.total"
            class="border border-amber-400/25 bg-amber-400/5 px-5 py-5"
          >
            <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 class="text-lg font-semibold text-on-surface">恢复视频复核清单</h2>
                <p class="mt-1 text-sm leading-6 text-on-surface-variant">
                  仅列出过期链接恢复的视频；可人工复核的候选优先显示，技术阻塞项需先处理。
                </p>
              </div>
              <div class="flex flex-wrap gap-2 text-xs">
                <span class="border border-sky-400/35 bg-sky-400/10 px-3 py-1.5 text-sky-100">
                  可人工复核 {{ recoveryInspectionSummary.readyCount }}
                </span>
                <span class="border border-outline-variant bg-surface-container px-3 py-1.5 text-on-surface-variant">
                  待技术检查 {{ recoveryInspectionSummary.pendingInspectionCount }}
                </span>
                <span class="border border-red-400/35 bg-red-400/10 px-3 py-1.5 text-red-200">
                  技术阻塞 {{ recoveryInspectionSummary.blockedCount }}
                </span>
                <span class="border border-amber-400/35 bg-amber-400/10 px-3 py-1.5 text-amber-100">
                  待复核 {{ recoveryReviewSummary.pendingCount }}
                </span>
                <span class="border border-red-400/35 bg-red-400/10 px-3 py-1.5 text-red-200">
                  返工 {{ recoveryReviewSummary.reworkCount }}
                </span>
                <span class="border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-emerald-200">
                  已批准 {{ recoveryReviewSummary.approvedCount }}
                </span>
                <span class="border border-purple-300/35 bg-purple-300/10 px-3 py-1.5 text-purple-100">
                  需终剪 {{ recoveryReviewSummary.finalEditRequiredCount }}
                </span>
                <span class="border border-sky-400/35 bg-sky-400/10 px-3 py-1.5 text-sky-100">
                  可进终剪 {{ recoveryReviewSummary.readyForFinalEditCount }}
                </span>
                <span class="border border-amber-400/35 bg-amber-400/10 px-3 py-1.5 text-amber-100">
                  复核后终剪 {{ recoveryReviewSummary.waitingManualReviewBeforeFinalEditCount }}
                </span>
                <span class="border border-red-400/35 bg-red-400/10 px-3 py-1.5 text-red-200">
                  终剪阻塞 {{ recoveryReviewSummary.finalEditBlockedCount }}
                </span>
                <span class="border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-emerald-200">
                  发布规格 {{ recoveryReviewSummary.publishFormatReadyCount }}
                </span>
              </div>
            </div>

            <div class="mt-4 divide-y divide-amber-100/10 border-y border-amber-100/10">
              <div
                v-for="item in recoveryReviewItems"
                :key="item.id"
                class="flex w-full cursor-pointer flex-col gap-3 py-4 text-left transition hover:bg-white/[0.025] sm:flex-row sm:items-center sm:justify-between"
                role="button"
                tabindex="0"
                @click="goRecoveryReview(item)"
                @keydown.enter="goRecoveryReview(item)"
              >
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class="inline-flex border px-2.5 py-1 text-xs"
                      :class="recoveryReviewStatusClass(item.reviewStatus)"
                    >
                      {{ recoveryReviewStatusLabel(item.reviewStatus) }}
                    </span>
                    <span
                      class="inline-flex border px-2.5 py-1 text-xs"
                      :class="inspectionReadinessClass(item.inspectionReadiness)"
                    >
                      {{ inspectionReadinessLabel(item.inspectionReadiness) }}
                    </span>
                    <span
                      class="inline-flex border px-2.5 py-1 text-xs"
                      :class="releaseReadinessClass(item)"
                    >
                      {{ releaseReadinessLabel(item) }}
                    </span>
                    <span
                      class="inline-flex border px-2.5 py-1 text-xs"
                      :class="finalEditReadinessClass(item)"
                    >
                      {{ finalEditReadinessLabel(item) }}
                    </span>
                    <span class="text-sm font-semibold text-on-surface">
                      场景 {{ item.sceneNo || '-' }} / 镜头 {{ item.shotNo || '-' }} / V{{ item.versionNo || '-' }}
                    </span>
                  </div>
                  <p class="mt-2 truncate text-sm text-on-surface-variant">
                    {{ item.modelName || '模型未知' }} · {{ formatShotDuration(item.durationSeconds) }}
                    <template v-if="item.reviewNote"> · {{ item.reviewNote }}</template>
                  </p>
                  <p
                    v-if="item.inspectionReadiness === 'blocked' && item.inspectionBlockingReason"
                    class="mt-2 text-sm leading-6 text-red-200"
                  >
                    技术阻塞：{{ item.inspectionBlockingReason }}
                  </p>
                  <p
                    v-if="item.inspectionGuidance"
                    class="mt-2 text-sm leading-6 text-on-surface-variant"
                  >
                    下一步：{{ item.inspectionGuidance }}
                  </p>
                  <p
                    v-if="item.releaseReadiness.message && item.inspectionReadiness === 'ready'"
                    class="mt-2 text-sm leading-6 text-purple-100"
                  >
                    发布规格：{{ item.releaseReadiness.message }}
                  </p>
                  <p class="mt-2 text-sm leading-6 text-sky-100">
                    下一步：{{ item.nextAction.message }}
                  </p>
                  <div v-if="item.reworkReasons.length" class="mt-3 space-y-1.5 text-sm text-red-100">
                    <p class="font-medium text-red-200">返工原因</p>
                    <p
                      v-for="reason in item.reworkReasons"
                      :key="`${reason.scope}-${reason.characterId || 'video'}-${reason.message}`"
                      class="leading-6"
                    >
                      · {{ recoveryReworkReasonLabel(reason) }}
                    </p>
                  </div>
                  <p class="mt-2 text-xs leading-5 text-on-surface-variant">
                    终剪计划：{{ item.finalEditReadiness.message }}
                  </p>
                  <p class="mt-2 text-xs leading-5 text-on-surface-variant">
                    终剪目标：{{ finalEditTargetLabel(item) }} · 字幕{{ item.finalEditPlan.target.burnSubtitle ? '烧录' : '不烧录' }}
                  </p>
                  <div
                    v-if="characterReviewProgressLabel(item)"
                    class="mt-3 flex flex-wrap items-center gap-2 text-xs"
                  >
                    <span class="border border-outline-variant px-2.5 py-1 text-on-surface-variant">
                      {{ characterReviewProgressLabel(item) }}
                    </span>
                    <span
                      class="border px-2.5 py-1"
                      :class="characterReviewStateClass(item)"
                    >
                      {{ characterReviewStateLabel(item) }}
                    </span>
                  </div>
                </div>
                <div class="flex shrink-0 flex-wrap items-center gap-3">
                  <button
                    v-if="item.finalEditReadiness.status === 'ready-for-final-edit'"
                    class="inline-flex items-center gap-1 border border-sky-400/35 bg-sky-400/10 px-3 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-400/20 disabled:cursor-wait disabled:opacity-60"
                    type="button"
                    :disabled="actionTaskKey === `recovery-final-edit-${item.id}`"
                    @click.stop="startRecoveryFinalEdit(item)"
                  >
                    <span class="material-symbols-outlined text-base">movie_edit</span>
                    {{ actionTaskKey === `recovery-final-edit-${item.id}` ? '创建中...' : '执行终剪' }}
                  </button>
                  <span class="inline-flex items-center gap-1 text-sm font-medium text-primary">
                    {{ recoveryReviewActionLabel(item) }}
                    <span class="material-symbols-outlined text-base">arrow_forward</span>
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section class="rounded-[24px] border border-outline-variant bg-surface-container-low px-5 py-5">
            <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="option in taskTypeOptions"
                  :key="option.key"
                  class="rounded-full border px-4 py-2 text-sm transition-colors"
                  :class="
                    taskTypeFilter === option.key
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary'
                  "
                  type="button"
                  @click="taskTypeFilter = option.key"
                >
                  {{ option.label }} · {{ option.count }}
                </button>
              </div>

              <div class="flex flex-wrap gap-2">
                <button
                  v-for="option in runtimeStatusOptions"
                  :key="option.key"
                  class="rounded-full border px-4 py-2 text-sm transition-colors"
                  :class="
                    runtimeStatusFilter === option.key
                      ? 'border-tertiary bg-tertiary/10 text-tertiary'
                      : 'border-outline-variant text-on-surface-variant hover:border-tertiary hover:text-tertiary'
                  "
                  type="button"
                  @click="runtimeStatusFilter = option.key"
                >
                  {{ option.label }} · {{ option.count }}
                </button>
              </div>
            </div>
          </section>

          <section
            v-if="pageState === 'empty'"
            class="rounded-[24px] border border-dashed border-outline bg-surface-container-low px-6 py-10 text-center"
          >
            <span class="material-symbols-outlined text-5xl text-primary/70">inbox</span>
            <h2 class="mt-4 text-2xl text-on-surface">当前项目还没有任务记录</h2>
            <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-on-surface-variant">
              先去静帧、视频、音频或导出模块跑通闭环，任务中心就会自动聚合这些真实记录。
            </p>
          </section>

          <section
            v-else-if="!filteredItems.length"
            class="rounded-[24px] border border-dashed border-outline bg-surface-container-low px-6 py-10 text-center"
          >
            <span class="material-symbols-outlined text-5xl text-primary/70">filter_alt_off</span>
            <h2 class="mt-4 text-2xl text-on-surface">当前筛选下没有结果</h2>
            <p class="mx-auto mt-3 max-w-xl text-sm leading-6 text-on-surface-variant">
              可以切换任务类型或运行状态筛选，查看更多任务记录。
            </p>
          </section>

          <section v-else class="space-y-4">
            <button
              v-for="item in filteredItems"
              :key="item.taskKey"
              class="group block w-full rounded-[26px] border bg-surface-container-low px-5 py-5 text-left transition-all hover:-translate-y-[1px]"
              :class="
                selectedTaskKey === item.taskKey
                  ? 'border-primary/45 shadow-[0_18px_45px_rgba(240,181,111,0.12)]'
                  : 'border-outline-variant hover:border-primary/25'
              "
              type="button"
              @click="selectedTaskKey = item.taskKey"
            >
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span
                      class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                      :class="taskTypeClass(item.taskType)"
                    >
                      <span class="material-symbols-outlined text-base leading-none">
                        {{ taskTypeIcon(item.taskType) }}
                      </span>
                      {{ taskTypeLabel(item.taskType) }}
                    </span>
                    <span
                      class="inline-flex items-center rounded-full border px-3 py-1 text-xs"
                      :class="runtimeStatusClass(item.runtimeStatus)"
                    >
                      {{ runtimeStatusLabel(item.runtimeStatus) }}
                    </span>
                    <span
                      class="inline-flex items-center rounded-full border px-3 py-1 text-xs"
                      :class="businessStatusClass(item.status)"
                    >
                      {{ businessStatusLabel(item.status) }}
                    </span>
                  </div>

                  <h3 class="mt-4 truncate text-xl font-semibold text-on-surface">{{ item.title }}</h3>
                  <p class="mt-2 text-sm leading-6 text-on-surface-variant">
                    {{ item.subtitle || item.runtimeMessage || '任务详情待补充' }}
                  </p>

                  <div class="mt-4 flex flex-wrap gap-2 text-xs text-on-surface-variant">
                    <span class="rounded-full border border-outline-variant px-3 py-1">
                      {{ sceneShotLabel(item) }}
                    </span>
                    <span class="rounded-full border border-outline-variant px-3 py-1">
                      {{ versionLabel(item) }}
                    </span>
                    <span
                      v-if="item.maxAttempts"
                      class="rounded-full border border-outline-variant px-3 py-1"
                    >
                      第 {{ item.attemptCount || 0 }}/{{ item.maxAttempts }} 次
                    </span>
                    <span
                      v-if="item.nextRunAt"
                      class="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-amber-200"
                    >
                      下次重试：{{ formatDateTime(item.nextRunAt) }}
                    </span>
                    <span class="rounded-full border border-outline-variant px-3 py-1">
                      更新时间：{{ formatDateTime(item.updatedAt || item.createdAt) }}
                    </span>
                  </div>
                </div>

                <div class="w-full max-w-[220px] space-y-2">
                  <div class="flex items-center justify-between text-xs text-on-surface-variant">
                    <span>运行进度</span>
                    <strong class="text-on-surface">{{ progressValue(item) }}%</strong>
                  </div>
                  <div class="h-2 rounded-full bg-black/25">
                    <div
                      class="h-full rounded-full transition-all"
                      :class="
                        item.runtimeStatus === 'failed'
                          ? 'bg-red-400'
                          : item.runtimeStatus === 'canceled'
                            ? 'bg-slate-400'
                            : item.runtimeStatus === 'running'
                              ? 'bg-sky-400'
                              : item.runtimeStatus === 'queued'
                                ? 'bg-amber-400'
                                : 'bg-emerald-400'
                      "
                      :style="{ width: `${progressValue(item)}%` }"
                    />
                  </div>
                </div>
              </div>
            </button>
          </section>
        </template>
      </section>

      <aside class="min-w-0">
        <section class="sticky top-6 rounded-[28px] border border-outline-variant bg-surface-container-low p-6 shadow-[0_18px_60px_rgba(0,0,0,0.18)]">
          <template v-if="selectedTask">
            <div class="flex flex-wrap gap-2">
              <span
                class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
                :class="taskTypeClass(selectedTask.taskType)"
              >
                <span class="material-symbols-outlined text-base leading-none">
                  {{ taskTypeIcon(selectedTask.taskType) }}
                </span>
                {{ taskTypeLabel(selectedTask.taskType) }}
              </span>
              <span
                class="inline-flex items-center rounded-full border px-3 py-1 text-xs"
                :class="runtimeStatusClass(selectedTask.runtimeStatus)"
              >
                {{ runtimeStatusLabel(selectedTask.runtimeStatus) }}
              </span>
            </div>

            <h2 class="mt-4 text-2xl font-semibold text-on-surface">{{ selectedTask.title }}</h2>
            <p class="mt-3 text-sm leading-6 text-on-surface-variant">
              {{ selectedTask.runtimeMessage || selectedTask.subtitle || '当前任务暂无额外说明。' }}
            </p>

            <div class="mt-5 space-y-2">
              <div class="flex items-center justify-between text-xs text-on-surface-variant">
                <span>当前进度</span>
                <strong class="text-on-surface">{{ progressValue(selectedTask) }}%</strong>
              </div>
              <div class="h-2 rounded-full bg-black/25">
                <div
                  class="h-full rounded-full transition-all"
                  :class="
                    selectedTask.runtimeStatus === 'failed'
                      ? 'bg-red-400'
                      : selectedTask.runtimeStatus === 'canceled'
                        ? 'bg-slate-400'
                        : selectedTask.runtimeStatus === 'running'
                          ? 'bg-sky-400'
                          : selectedTask.runtimeStatus === 'queued'
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                  "
                  :style="{ width: `${progressValue(selectedTask)}%` }"
                />
              </div>
            </div>

            <dl class="mt-6 space-y-4 text-sm">
              <div class="rounded-[18px] border border-outline-variant bg-black/10 px-4 py-4">
                <dt class="text-xs uppercase tracking-[0.16em] text-on-surface-variant">来源位置</dt>
                <dd class="mt-2 text-on-surface">{{ sceneShotLabel(selectedTask) }}</dd>
              </div>
              <div class="rounded-[18px] border border-outline-variant bg-black/10 px-4 py-4">
                <dt class="text-xs uppercase tracking-[0.16em] text-on-surface-variant">业务状态</dt>
                <dd class="mt-2 text-on-surface">{{ businessStatusLabel(selectedTask.status) }}</dd>
              </div>
              <div
                v-if="selectedTask.maxAttempts"
                class="rounded-[18px] border border-outline-variant bg-black/10 px-4 py-4"
              >
                <dt class="text-xs uppercase tracking-[0.16em] text-on-surface-variant">执行策略</dt>
                <dd class="mt-2 space-y-1 leading-6 text-on-surface-variant">
                  <p class="text-on-surface">
                    当前第 {{ selectedTask.attemptCount || 0 }}/{{ selectedTask.maxAttempts }} 次执行
                  </p>
                  <p v-if="selectedTask.nextRunAt">
                    下次重试：{{ formatDateTime(selectedTask.nextRunAt) }}
                  </p>
                  <p v-else-if="selectedTask.runtimeStatus === 'queued'">等待 Worker 可用槽位</p>
                  <p v-else-if="selectedTask.lastStartedAt">
                    最近启动：{{ formatDateTime(selectedTask.lastStartedAt) }}
                  </p>
                </dd>
              </div>
              <div class="rounded-[18px] border border-outline-variant bg-black/10 px-4 py-4">
                <dt class="text-xs uppercase tracking-[0.16em] text-on-surface-variant">详情说明</dt>
                <dd class="mt-2 whitespace-pre-wrap leading-6 text-on-surface-variant">
                  {{ selectedTask.detailText || '暂无额外详情。' }}
                </dd>
              </div>
              <div
                v-if="selectedTask.errorText"
                class="rounded-[18px] border border-red-500/25 bg-red-500/5 px-4 py-4"
              >
                <dt class="text-xs uppercase tracking-[0.16em] text-red-200">失败原因 / 提示</dt>
                <dd class="mt-2 whitespace-pre-wrap leading-6 text-red-100">
                  {{ selectedTask.errorText }}
                </dd>
              </div>
              <div class="rounded-[18px] border border-outline-variant bg-black/10 px-4 py-4">
                <dt class="text-xs uppercase tracking-[0.16em] text-on-surface-variant">时间记录</dt>
                <dd class="mt-2 space-y-1 text-on-surface-variant">
                  <p>创建：{{ formatDateTime(selectedTask.createdAt) }}</p>
                  <p>更新：{{ formatDateTime(selectedTask.updatedAt || selectedTask.createdAt) }}</p>
                  <p v-if="selectedTask.confirmedAt">确认：{{ formatDateTime(selectedTask.confirmedAt) }}</p>
                </dd>
              </div>
            </dl>

            <div class="mt-6 flex flex-wrap gap-3">
              <button
                class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                type="button"
                :disabled="!!selectedTask.canRetry === false || isBusy(selectedTask.taskKey)"
                @click="handleRetry(selectedTask)"
              >
                {{ isBusy(selectedTask.taskKey) ? '处理中...' : '重试任务' }}
              </button>
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                :disabled="!selectedTask.canCancel || isBusy(selectedTask.taskKey)"
                @click="handleCancel(selectedTask)"
              >
                取消任务
              </button>
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5"
                type="button"
                @click="goSource(selectedTask)"
              >
                回到来源模块
              </button>
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                :disabled="!selectedTask.fileUrl"
                @click="openFile(selectedTask)"
              >
                打开结果文件
              </button>
              <button
                v-if="selectedTask.isRecoveryFinalEdit && selectedTask.canRollback"
                class="rounded-[14px] border border-red-400/35 bg-red-400/10 px-4 py-2 text-sm text-red-100 transition hover:bg-red-400/20 disabled:cursor-wait disabled:opacity-50"
                type="button"
                :disabled="isBusy(selectedTask.taskKey)"
                @click="handleRecoveryFinalEditRollback(selectedTask)"
              >
                {{ isBusy(selectedTask.taskKey) ? '回滚中...' : '回滚终剪' }}
              </button>
            </div>
          </template>

          <template v-else>
            <div class="flex min-h-[360px] flex-col items-center justify-center text-center">
              <span class="material-symbols-outlined text-5xl text-primary/70">pending_actions</span>
              <h2 class="mt-4 text-2xl text-on-surface">选择一条任务记录</h2>
              <p class="mt-3 max-w-xs text-sm leading-6 text-on-surface-variant">
                左侧会显示当前项目的任务聚合结果，选中后可以查看运行态、进度和可执行操作。
              </p>
            </div>
          </template>
        </section>
      </aside>
    </div>
  </WorkspaceLayout>
</template>
