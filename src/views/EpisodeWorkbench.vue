<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getProject,
  listScenes,
  createProjectExport,
  listProjectExports,
  type ExportRecordDTO,
  type ProjectDTO,
  type SceneDTO,
} from '@/api/project'
import {
  decideAgentPipelineStage,
  listAgentPipelines,
  startAgentPipeline,
  type AgentPipelineViewDTO,
} from '@/api/agent-pipeline'
import {
  loadEpisodeProductionCards,
  type EpisodeProductionCard,
} from '@/api/production-studio'
import { formatAggregateDuration } from '@/lib/episode-clips.mjs'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => Number(route.query.projectId) || 0)
const allEpisodesReady = computed(() => episodes.value.length > 0 && episodes.value.every((episode) => episode.status === 'ready'))

const project = ref<ProjectDTO | null>(null)
const episodes = ref<EpisodeProductionCard[]>([])
const episodeExports = ref<ExportRecordDTO[]>([])
const renderingEpisode = ref<number | null>(null)
const previewEpisode = ref<number | null>(null)
const loading = ref(true)
const error = ref('')
const generatingEpisode = ref<number | null>(null)
const notice = ref('')
const dataNotice = ref('')
const generationError = ref('')
const pipelineBusy = ref(false)
const pipelineNotice = ref('')
const pipelineRun = ref<AgentPipelineViewDTO | null>(null)
const checkpointDialog = ref<HTMLDialogElement | null>(null)
const dismissedCheckpointKey = ref('')
let pipelineRefreshTimer: number | null = null
let exportRefreshTimer: number | null = null

const pipelineActive = computed(() => pipelineBusy.value || ['queued', 'running'].includes(pipelineRun.value?.run.status || ''))
const checkpointKey = computed(() => {
  const run = pipelineRun.value?.run
  return run?.status === 'waiting_approval' ? `${run.id}:${run.currentStage}` : ''
})
const showCheckpointDialog = computed(() => Boolean(checkpointKey.value) && checkpointKey.value !== dismissedCheckpointKey.value)
const trackedPipelineStatuses = ['queued', 'running', 'waiting_approval', 'retryable_failed']

watch(showCheckpointDialog, async (visible) => {
  await nextTick()
  const dialog = checkpointDialog.value
  if (!dialog) return
  if (visible && !dialog.open) dialog.showModal()
  else if (!visible && dialog.open) dialog.close()
}, { flush: 'post' })

function selectLatestActivePipeline(items: AgentPipelineViewDTO[]): AgentPipelineViewDTO | null {
  const latest = [...items].sort((left, right) => right.run.id - left.run.id)[0]
  return latest && trackedPipelineStatuses.includes(latest.run.status) ? latest : null
}

const pipelineStageLabels: Record<string, string> = {
  'asset-parse': '资产解析',
  'character-lock': '角色锁定',
  'scene-lock': '场景锁定',
  storyboard: '分镜脚本',
  voice: '音色绑定',
  video: '视频生成',
  quality: '成片质检',
  delivery: '本地导出',
}

const episodeStatusLabel: Record<EpisodeProductionCard['status'], string> = {
  empty: '待拆解',
  storyboard: '分镜已生成',
  'in-progress': '制作中',
  ready: '已完成',
}

const episodeNextAction: Record<EpisodeProductionCard['status'], string> = {
  empty: '先生成分镜脚本',
  storyboard: '进入创作页检查镜头',
  'in-progress': '继续处理未完成镜头',
  ready: '查看已完成成片',
}

function episodeProgressPercent(episode: EpisodeProductionCard): number {
  if (episode.status === 'ready') return 100
  if (!episode.shotCount) return 0
  return Math.min(99, Math.round((episode.generatedVideoCount / episode.shotCount) * 100))
}

async function loadPage(): Promise<void> {
  if (!projectId.value) {
    error.value = '缺少项目参数，请从工作台进入。'
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  dataNotice.value = ''
  try {
    // 项目身份和分集卡片分开加载：模型服务异常时不能把整个分集工作台打成错误页。
    project.value = await getProject(projectId.value)
    await refreshEpisodeExports(true)
    try {
      episodes.value = await loadEpisodeProductionCards(projectId.value)
    } catch (cause) {
      episodes.value = []
      dataNotice.value = cause instanceof Error ? cause.message : '分集数据暂时不可用'
    }
    try {
      const pipelines = await listAgentPipelines(projectId.value)
      pipelineRun.value = selectLatestActivePipeline(pipelines.items)
    } catch {
      pipelineRun.value = null
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '分集数据加载失败'
  } finally {
    loading.value = false
  }
}

async function refreshEpisodeExports(force = false): Promise<void> {
  if (!projectId.value) return
  if (!force && !episodeExports.value.some((item) => ['queued', 'running'].includes(item.status))) return
  try {
    episodeExports.value = await listProjectExports(projectId.value)
  } catch {
    // Export history is secondary to episode progress; keep the page usable when it is unavailable.
  }
}

function episodeExport(episodeNo: number): ExportRecordDTO | null {
  return episodeExports.value.find((item) => Number(item.config?.episodeNo) === episodeNo) || null
}

function episodeQualityIssues(episodeNo: number) {
  const report = episodeExport(episodeNo)?.config?.cinematicQualityReport
  const uniqueIssues = new Map<string, { code?: string; message?: string; storyboardId?: number }>()
  const reportIssues: Array<{ code?: string; message?: string; storyboardId?: number }> = [
    ...(report?.blockers || []).map((issue) => ({ code: issue.code, message: issue.message })),
    ...(report?.issueShots || []),
  ]
  for (const issue of reportIssues) {
    const key = `${issue.code || 'quality-issue'}\u0000${issue.message || ''}`
    const existing = uniqueIssues.get(key)
    if (!existing || (!existing.storyboardId && issue.storyboardId)) {
      uniqueIssues.set(key, { ...existing, ...issue })
    }
  }
  return [...uniqueIssues.values()]
}

function episodeExportUrl(record: ExportRecordDTO): string {
  return record.playbackUrl || record.videoUrl
}

function openFinalEdit(episodeNo: number, mode: 'manual' | 'replan' = 'manual'): void {
  router.push({
    path: '/workspace/edit',
    query: {
      projectId: String(projectId.value),
      episodeNo: String(episodeNo),
      ...(mode === 'replan' ? { replan: '1' } : {}),
    },
  })
}

async function generateEpisodeFilm(episode: EpisodeProductionCard): Promise<void> {
  if (renderingEpisode.value !== null || episode.status !== 'ready') return
  renderingEpisode.value = episode.episodeNo
  previewEpisode.value = null
  notice.value = ''
  generationError.value = ''
  try {
    const record = await createProjectExport(projectId.value, {
      episodeNo: episode.episodeNo,
      format: 'H.264 / MP4',
      frameRate: 30,
      // 分集成片必须保留每个镜头的真实视频，不能把超出默认上限的镜头降级成静帧。
      hybridVideoPerScene: 6,
      preserveSourceAudio: true,
    })
    episodeExports.value = [record, ...episodeExports.value.filter((item) => item.id !== record.id)]
    notice.value = `第 ${episode.episodeNo} 集已加入后台成片队列`
  } catch (cause) {
    generationError.value = cause instanceof Error ? cause.message : '成片任务提交失败'
  } finally {
    renderingEpisode.value = null
    void refreshEpisodeExports(true)
  }
}

async function refreshPipelineRun(): Promise<void> {
  if (!projectId.value) return
  try {
    const pipelines = await listAgentPipelines(projectId.value)
    pipelineRun.value = selectLatestActivePipeline(pipelines.items)
  } catch {
    // Refresh is advisory. A transient poll failure must not replace a valid checkpoint with an error page.
  }
}

function openStudio(episodeNo: number, runId = pipelineRun.value?.run.id): void {
  router.push({
    path: '/workspace/episodes/studio',
    query: {
      projectId: String(projectId.value),
      episodeNo: String(episodeNo),
      ...(runId ? { pipelineRunId: String(runId) } : {}),
    },
  })
}

async function openStudioWhenStoryboardExists(episodeNo: number, runId?: number): Promise<void> {
  const cards = await loadEpisodeProductionCards(projectId.value)
  episodes.value = cards
  const episode = cards.find((item) => item.episodeNo === episodeNo)
  if (!episode?.shotCount) {
    throw new Error(`第 ${episodeNo} 集的 Agent 阶段已结束，但数据库中没有已保存的分镜；创作页未打开。请重试分镜阶段。`)
  }
  openStudio(episodeNo, runId)
}

function episodeActionLabel(episode: EpisodeProductionCard): string {
  if (generatingEpisode.value === episode.episodeNo) return 'Agent 执行中…'
  if (pipelineActive.value) return 'Agent 执行中…'
  return episode.shotCount ? '重新生成分镜脚本' : '生成分镜脚本'
}

function episodeActionIcon(): string {
  return 'auto_awesome'
}

function pipelineStageLabel(stage: string): string {
  return pipelineStageLabels[stage] || stage
}

async function generateEpisode(episodeNo: number): Promise<void> {
  if (generatingEpisode.value || pipelineActive.value || !projectId.value) return
  generatingEpisode.value = episodeNo
  notice.value = ''
  generationError.value = ''
  pipelineNotice.value = ''
  try {
    const scenes = await listScenes(projectId.value)
    const targetScenes: SceneDTO[] = scenes.filter((scene) => (scene.episodeNo ?? 1) === episodeNo)
    if (!targetScenes.length) {
      throw new Error('这一集还没有可生成分镜的场景')
    }
    pipelineBusy.value = true
    const run = await startAgentPipeline(projectId.value, {
      episodeNo,
      regenerate: targetScenes.some((scene) => scene.status === 'storyboard_ready'),
      idempotencyKey: `project:${projectId.value}:episode:${episodeNo}:agent-pipeline:${Date.now()}`,
    })
    pipelineRun.value = run
    if (run.run.status === 'waiting_approval' && run.run.currentStage === 'storyboard') {
      notice.value = `第 ${episodeNo} 集分镜脚本已生成，正在进入创作页`
      await new Promise((resolve) => window.setTimeout(resolve, 260))
      await openStudioWhenStoryboardExists(episodeNo, run.run.id)
    } else if (run.run.status === 'waiting_approval') {
      pipelineNotice.value = `第 ${episodeNo} 集${pipelineStageLabel(run.run.currentStage)}已完成，请确认后继续下一阶段。`
      notice.value = '资产解析完成，等待人工确认'
    } else if (run.run.status === 'completed') {
      notice.value = `第 ${episodeNo} 集分镜脚本已确认，正在进入创作页`
      await openStudioWhenStoryboardExists(episodeNo, run.run.id)
    } else {
      generationError.value = run.run.errorText || 'Agent Pipeline 没有完成，请查看当前阶段状态'
    }
  } catch (cause) {
    generationError.value = cause instanceof Error ? cause.message : '分镜脚本生成失败'
  } finally {
    generatingEpisode.value = null
    pipelineBusy.value = false
  }
}

async function approvePipelineStage(): Promise<void> {
  const run = pipelineRun.value
  if (!run || pipelineBusy.value || run.run.status !== 'waiting_approval') return
  const approvedCheckpointKey = checkpointKey.value
  pipelineBusy.value = true
  generationError.value = ''
  pipelineNotice.value = ''
  try {
    const result = await decideAgentPipelineStage(
      run.run.id,
      run.run.currentStage,
      'approve',
      '已在资产与分镜检查点确认',
    )
    dismissedCheckpointKey.value = approvedCheckpointKey
    pipelineRun.value = result
    if (result.run.status === 'waiting_approval') {
      notice.value = `第 ${result.run.episodeNo} 集${pipelineStageLabel(result.run.currentStage)}已生成，正在进入下一步`
      await new Promise((resolve) => window.setTimeout(resolve, 260))
      if (result.run.currentStage === 'storyboard') await openStudioWhenStoryboardExists(result.run.episodeNo, result.run.id)
    } else if (result.run.status === 'completed') {
      notice.value = `第 ${result.run.episodeNo} 集 Agent 闭环已完成`
      await openStudioWhenStoryboardExists(result.run.episodeNo, result.run.id)
    } else {
      pipelineNotice.value = result.run.errorText || '当前阶段已更新，请查看 Agent 执行轨迹'
    }
  } catch (cause) {
    generationError.value = cause instanceof Error ? cause.message : '确认 Agent 阶段失败'
  } finally {
    pipelineBusy.value = false
  }
}

function goBack(): void {
  router.push({
    path: '/workspace/episodes',
    query: { projectId: String(projectId.value), view: 'overview' },
  })
}

onMounted(() => {
  void loadPage()
  pipelineRefreshTimer = window.setInterval(() => void refreshPipelineRun(), 1200)
  exportRefreshTimer = window.setInterval(() => void refreshEpisodeExports(), 2500)
})

onUnmounted(() => {
  if (pipelineRefreshTimer !== null) window.clearInterval(pipelineRefreshTimer)
  if (exportRefreshTimer !== null) window.clearInterval(exportRefreshTimer)
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <main class="episode-workbench">
      <header class="episode-workbench__topbar">
        <button class="episode-workbench__back" type="button" @click="goBack">
          <span class="material-symbols-outlined">arrow_back</span>
          返回创作总览
        </button>
        <div class="episode-workbench__project">
          <span class="episode-workbench__eyebrow">PROJECTDREAM / EPISODES</span>
          <strong>{{ project?.name || '分集制作' }}</strong>
        </div>
        <span class="episode-workbench__step">
          <span class="episode-workbench__step-dot">03</span>
          分镜视频生成
        </span>
      </header>

      <section class="episode-workbench__hero">
        <div class="episode-workbench__hero-copy">
          <span class="episode-workbench__eyebrow">EPISODE WORKBENCH</span>
          <h1>按集推进分镜与视频</h1>
          <p>先选择一集生成分镜脚本，再进入创作页逐镜检查资产、提示词和视频。</p>
        </div>
        <div class="episode-workbench__summary">
          <div class="episode-workbench__summary-line">
            <strong>{{ episodes.length }}</strong>
            <span>集剧本已同步</span>
          </div>
          <div class="episode-workbench__summary-track">
            <span
              :style="{
                '--progress-ratio': String(
                  episodes.length
                    ? Math.min(1, episodes.filter((item) => item.status === 'ready').length / episodes.length)
                    : 0,
                ),
              }"
            ></span>
          </div>
          <small>{{ episodes.filter((item) => item.status === 'ready').length }} 集已完成</small>
        </div>
      </section>

      <nav class="episode-workbench__flow" aria-label="制作阶段">
        <div class="episode-workbench__flow-label">PRODUCTION FLOW</div>
        <ol>
          <li class="is-done"><span>01</span>剧本</li>
          <li class="is-done"><span>02</span>资产</li>
          <li :class="{ 'is-current': !allEpisodesReady, 'is-done': allEpisodesReady }" :aria-current="!allEpisodesReady ? 'step' : undefined"><span>03</span>分镜视频</li>
          <li :class="{ 'is-current': allEpisodesReady }" :aria-current="allEpisodesReady ? 'step' : undefined"><span>04</span>成片与导出</li>
        </ol>
      </nav>

      <div v-if="loading" class="episode-workbench__state" role="status">
        <span class="episode-spinner" aria-hidden="true"></span>
        正在同步分集与镜头进度…
      </div>
      <div v-else-if="error" class="episode-workbench__state is-error" role="alert">
        <span class="material-symbols-outlined">error</span>
        {{ error }}
        <button type="button" @click="loadPage">重新加载</button>
      </div>
      <div v-else class="episode-workbench__grid">
        <div v-if="dataNotice" class="episode-workbench__data-notice" role="status">
          <span class="material-symbols-outlined">info</span>
          <span>{{ dataNotice }}</span>
          <button type="button" @click="loadPage">重新同步</button>
        </div>
        <article
          v-for="episode in episodes"
          :key="episode.episodeNo"
          class="episode-card"
          :class="{ 'is-delivery': episode.status === 'ready' }"
        >
          <div class="episode-card__number">{{ String(episode.episodeNo).padStart(2, '0') }}</div>
          <div class="episode-card__content">
            <div class="episode-card__heading">
              <div>
                <span class="episode-workbench__eyebrow">EPISODE {{ String(episode.episodeNo).padStart(2, '0') }}</span>
                <h2>{{ episode.title }}</h2>
              </div>
              <span class="episode-card__status">{{ episodeStatusLabel[episode.status] }}</span>
            </div>
            <p class="episode-card__logline">{{ episode.logline || '这一集还没有剧情摘要。' }}</p>
            <div class="episode-card__meta" aria-label="本集制作数据">
              <span><b>{{ episode.sceneCount }}</b><em>场景</em></span>
              <span><b>{{ episode.shotCount }}</b><em>镜头</em></span>
              <span><b>{{ episode.generatedVideoCount }}/{{ episode.shotCount || 0 }}</b><em>视频</em></span>
              <span><b>{{ formatAggregateDuration(episode.durationSeconds) }}</b><em>时长</em></span>
            </div>
            <div class="episode-card__progress" :aria-label="`本集完成度 ${episodeProgressPercent(episode)}%`">
              <div class="episode-card__progress-copy">
                <span>镜头完成度</span>
                <strong>{{ episodeProgressPercent(episode) }}%</strong>
              </div>
              <div class="episode-card__progress-track" aria-hidden="true">
                <span :style="{ '--progress-ratio': `${episodeProgressPercent(episode) / 100}` }"></span>
              </div>
            </div>
            <p class="episode-card__next">
              <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
              下一步：{{ episodeNextAction[episode.status] }}
            </p>
            <div class="episode-card__actions">
              <template v-if="episode.status !== 'ready'">
                <button type="button" class="episode-card__secondary" @click="openStudio(episode.episodeNo)">
                  <span class="material-symbols-outlined">movie</span>
                  进入创作页
                </button>
                <button
                  type="button"
                  class="episode-card__primary"
                  :disabled="generatingEpisode === episode.episodeNo || pipelineActive"
                  @click="generateEpisode(episode.episodeNo)"
                >
                  <span
                    v-if="generatingEpisode === episode.episodeNo || pipelineActive"
                    class="episode-spinner"
                    aria-hidden="true"
                  ></span>
                  <span v-else class="material-symbols-outlined">{{ episodeActionIcon() }}</span>
                  {{ episodeActionLabel(episode) }}
                </button>
              </template>
              <template v-else>
                <div v-if="episodeExport(episode.episodeNo)?.status === 'queued' || episodeExport(episode.episodeNo)?.status === 'running' || renderingEpisode === episode.episodeNo" class="episode-delivery-state" role="status">
                  <span class="episode-spinner" aria-hidden="true"></span>
                  <span><strong>正在后台生成成片</strong><small>完成后可直接预览并导出</small></span>
                </div>
                <template v-else-if="episodeExport(episode.episodeNo)?.status === 'completed'">
                  <div class="episode-delivery-row">
                    <button
                      type="button"
                      class="episode-delivery-row__poster"
                      :aria-label="previewEpisode === episode.episodeNo ? '关闭成片预览' : `预览第 ${episode.episodeNo} 集成片`"
                      @click="previewEpisode = previewEpisode === episode.episodeNo ? null : episode.episodeNo"
                    >
                      <img v-if="episodeExport(episode.episodeNo)?.coverUrl" :src="episodeExport(episode.episodeNo)?.coverUrl || ''" :alt="`${episode.title}封面`" loading="lazy" />
                      <span class="material-symbols-outlined">{{ previewEpisode === episode.episodeNo ? 'pause' : 'play_arrow' }}</span>
                    </button>
                    <div class="episode-delivery-row__info">
                      <strong>{{ episode.title }}</strong>
                      <span>{{ episode.generatedVideoCount }} 个分镜 · {{ formatAggregateDuration(episodeExport(episode.episodeNo)?.durationSeconds || episode.durationSeconds) }}</span>
                      <div class="episode-delivery-row__actions">
                        <button type="button" class="episode-card__secondary" @click="previewEpisode = previewEpisode === episode.episodeNo ? null : episode.episodeNo">
                          <span class="material-symbols-outlined">play_circle</span>预览
                        </button>
                        <button type="button" class="episode-card__secondary" @click="openFinalEdit(episode.episodeNo)">
                          <span class="material-symbols-outlined">movie_edit</span>打开剪辑
                        </button>
                        <a class="episode-card__primary" :href="episodeExportUrl(episodeExport(episode.episodeNo)!)" target="_blank" rel="noreferrer" :download="`第${episode.episodeNo}集.mp4`">
                          <span class="material-symbols-outlined">download</span>导出
                        </a>
                        <button type="button" class="episode-card__secondary" :disabled="renderingEpisode !== null" @click="generateEpisodeFilm(episode)">
                          <span class="material-symbols-outlined">refresh</span>
                          {{ renderingEpisode === episode.episodeNo ? '提交中' : '重新生成成片' }}
                        </button>
                      </div>
                    </div>
                  </div>
                  <video
                    v-if="previewEpisode === episode.episodeNo"
                    class="episode-delivery-preview"
                    :src="episodeExportUrl(episodeExport(episode.episodeNo)!)"
                    controls
                    playsinline
                    preload="metadata"
                  ></video>
                </template>
                <div v-else-if="episodeExport(episode.episodeNo)?.status === 'blocked'" class="episode-delivery-error" role="alert">
                  <strong>成片质检阻止完成</strong>
                  <span>{{ episodeExport(episode.episodeNo)?.config?.cinematicQualityReport?.summary || '请查看问题镜头并重新规划。' }}</span>
                  <small
                    v-for="issue in episodeQualityIssues(episode.episodeNo)"
                    :key="`${issue.storyboardId || 'episode'}-${issue.code}-${issue.message}`"
                  >{{ issue.storyboardId ? `分镜 ${issue.storyboardId}：` : '' }}{{ issue.message || '质检未通过，请打开报告查看详情。' }}</small>
                  <div class="episode-delivery-error__actions">
                    <button type="button" class="episode-card__primary" @click="openFinalEdit(episode.episodeNo, 'replan')">
                      <span class="material-symbols-outlined">auto_fix_high</span>按建议重新规划
                    </button>
                    <button type="button" class="episode-card__secondary" @click="openFinalEdit(episode.episodeNo)">
                      <span class="material-symbols-outlined">tune</span>在剪辑页手动调整后重新导出
                    </button>
                  </div>
                </div>
                <div v-else-if="episodeExport(episode.episodeNo)?.status === 'failed'" class="episode-delivery-error" role="alert">
                  <span>成片生成失败，请重试</span>
                  <button type="button" class="episode-card__primary" :disabled="renderingEpisode !== null" @click="generateEpisodeFilm(episode)">
                    <span class="material-symbols-outlined">refresh</span>重新生成成片
                  </button>
                </div>
                <button v-else type="button" class="episode-card__primary episode-card__render" :disabled="renderingEpisode !== null" @click="generateEpisodeFilm(episode)">
                  <span v-if="renderingEpisode === episode.episodeNo" class="episode-spinner" aria-hidden="true"></span>
                  <span v-else class="material-symbols-outlined">movie_edit</span>
                  {{ renderingEpisode === episode.episodeNo ? '正在提交' : '生成成片' }}
                </button>
              </template>
            </div>
          </div>
        </article>
        <div v-if="!episodes.length && !dataNotice" class="episode-workbench__state">
          <span class="material-symbols-outlined">movie_filter</span>
          暂未同步到分集剧本，请先完成剧本生成。
        </div>
      </div>

      <p v-if="notice" class="episode-workbench__notice" role="status">
        <span class="material-symbols-outlined">check_circle</span>
        {{ notice }}
      </p>
      <p v-if="generationError" class="episode-workbench__notice is-error" role="alert">
        <span class="material-symbols-outlined">error</span>
        {{ generationError }}
        <button type="button" @click="generationError = ''">知道了</button>
      </p>
      <p v-if="pipelineNotice" class="episode-workbench__notice" role="status">
        <span class="material-symbols-outlined">account_tree</span>
        {{ pipelineNotice }}
      </p>
    </main>
    <Teleport to="body">
      <dialog
        ref="checkpointDialog"
        class="episode-workbench__checkpoint"
        aria-labelledby="episode-checkpoint-title"
        @cancel.prevent
      >
        <div v-if="pipelineRun?.run.status === 'waiting_approval'" class="episode-workbench__checkpoint-body">
          <span class="episode-workbench__checkpoint-icon material-symbols-outlined" aria-hidden="true">task_alt</span>
          <div class="episode-workbench__checkpoint-copy">
            <span class="episode-workbench__eyebrow">AGENT CHECKPOINT</span>
            <h2 id="episode-checkpoint-title">{{ pipelineStageLabel(pipelineRun.run.currentStage) }}已完成</h2>
            <p>
              {{ pipelineRun.run.currentStage === 'asset-parse'
                ? '角色、场景和出场关系已经写入资产库。'
                : pipelineRun.run.currentStage === 'storyboard'
                  ? '分镜脚本已经写入当前集，确认后进入创作页继续检查。'
                  : '当前阶段结果已经登记。确认后将继续下一阶段。' }}
            </p>
            <button type="button" class="episode-card__primary episode-workbench__checkpoint-confirm" :disabled="pipelineBusy" @click="approvePipelineStage">
              <span v-if="pipelineBusy" class="episode-spinner" aria-hidden="true"></span>
              <span v-else class="material-symbols-outlined">task_alt</span>
              {{ pipelineBusy ? '确认中…' : pipelineRun.run.currentStage === 'storyboard' ? '进入分镜创作' : `确认${pipelineStageLabel(pipelineRun.run.currentStage)}并继续` }}
            </button>
          </div>
        </div>
      </dialog>
    </Teleport>
  </WorkspaceLayout>
</template>

<style scoped>
.episode-workbench {
  --ink: #f1e9dd;
  --muted: #9f9b92;
  --quiet: #77766f;
  --line: rgba(242, 218, 189, .15);
  --line-strong: rgba(242, 178, 125, .42);
  --accent: #f3a66f;
  min-height: 100%;
  box-sizing: border-box;
  background:
    radial-gradient(circle at 86% 8%, rgba(137, 74, 38, .12), transparent 25rem),
    #0d100e;
  color: var(--ink);
  padding: .85rem clamp(1rem, 4vw, 4.8rem) 5.5rem;
}

.episode-workbench__topbar {
  display: flex;
  min-height: 3rem;
  align-items: center;
  gap: 1rem;
  border-bottom: 1px solid var(--line);
}

.episode-workbench__back,
.episode-card__secondary,
.episode-card__primary {
  display: inline-flex;
  min-height: 2.45rem;
  align-items: center;
  gap: .42rem;
  border: 1px solid rgba(241, 213, 184, .28);
  padding: .55rem .78rem;
  color: #e9ded2;
  font-size: .72rem;
  transition: transform 180ms ease, border-color 180ms ease, background-color 180ms ease, box-shadow 180ms ease;
}

.episode-workbench__back:hover,
.episode-card__secondary:hover {
  border-color: var(--accent);
  background: rgba(243, 166, 111, .08);
  transform: translateY(-1px);
}

.episode-workbench__project { display: flex; min-width: 0; flex-direction: column; gap: .12rem; }
.episode-workbench__project strong { overflow: hidden; color: #ded3c6; font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.episode-workbench__step { margin-left: auto; color: var(--accent); font-size: .72rem; }
.episode-workbench__step-dot { display: inline-grid; width: 1.45rem; height: 1.45rem; margin-right: .3rem; place-items: center; border: 1px solid var(--accent); border-radius: 50%; font-size: .6rem; }
.episode-workbench__eyebrow { color: #c28e6d; font-family: ui-monospace, monospace; font-size: .6rem; letter-spacing: .14em; }

.episode-workbench__hero {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 2rem;
  padding: 3.4rem 0 2.1rem;
}

.episode-workbench__hero h1 {
  margin-top: .45rem;
  color: #eee5d9;
  font-family: 'Noto Serif SC', serif;
  font-size: clamp(2rem, 4vw, 3.2rem);
  font-weight: 600;
  letter-spacing: -.02em;
  line-height: 1.12;
}

.episode-workbench__hero p { max-width: 38rem; margin-top: .72rem; color: var(--muted); font-size: .78rem; line-height: 1.7; }
.episode-workbench__summary { width: min(14rem, 100%); color: var(--muted); }
.episode-workbench__summary-line { display: flex; align-items: end; justify-content: space-between; gap: 1rem; }
.episode-workbench__summary strong { color: var(--accent); font-family: ui-monospace, monospace; font-size: 2.2rem; line-height: .9; }
.episode-workbench__summary-line span { padding-bottom: .12rem; font-size: .68rem; }
.episode-workbench__summary-track { height: .25rem; margin-top: .8rem; overflow: hidden; background: rgba(242, 218, 189, .12); }
.episode-workbench__summary-track span {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--accent);
  transform: scaleX(var(--progress-ratio, 0));
  transform-origin: left center;
  transition: transform 420ms cubic-bezier(.2, .75, .25, 1);
}
.episode-workbench__summary small { display: block; margin-top: .42rem; color: var(--quiet); font-size: .65rem; text-align: right; }

.episode-workbench__flow {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.15rem;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  padding: .75rem 0;
}
.episode-workbench__flow-label { color: var(--quiet); font: .58rem ui-monospace, monospace; letter-spacing: .14em; white-space: nowrap; }
.episode-workbench__flow ol { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .35rem; margin: 0; padding: 0; list-style: none; }
.episode-workbench__flow li { position: relative; display: flex; align-items: center; gap: .45rem; min-width: 0; color: #767770; font-size: .67rem; }
.episode-workbench__flow li:not(:last-child)::after { content: ''; height: 1px; flex: 1; margin-left: .4rem; background: rgba(242, 218, 189, .12); }
.episode-workbench__flow li span { display: grid; width: 1.45rem; height: 1.45rem; flex: 0 0 auto; place-items: center; border: 1px solid rgba(242, 218, 189, .16); color: #8e887e; font: .58rem ui-monospace, monospace; }
.episode-workbench__flow li.is-done { color: #b9c8b5; }
.episode-workbench__flow li.is-done span { border-color: rgba(159, 198, 165, .45); color: #b7d8bd; }
.episode-workbench__flow li.is-current { color: var(--accent); }
.episode-workbench__flow li.is-current span { border-color: var(--accent); background: rgba(243, 166, 111, .12); color: var(--accent); }

.episode-workbench__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr));
  gap: .8rem;
  align-items: stretch;
}

.episode-card {
  position: relative;
  display: flex;
  min-height: 20rem;
  flex-direction: column;
  border: 1px solid var(--line);
  background: linear-gradient(155deg, rgba(25, 29, 25, .96), rgba(16, 19, 16, .96));
  box-shadow: 0 18px 34px rgba(0, 0, 0, .1);
  opacity: 0;
  animation: episode-card-in 500ms cubic-bezier(.2, .75, .25, 1) forwards;
  transition: border-color 180ms ease, transform 180ms ease, background-color 180ms ease, box-shadow 180ms ease;
}

.episode-card:nth-child(2) { animation-delay: 70ms; }
.episode-card:nth-child(3) { animation-delay: 140ms; }
.episode-card:hover { border-color: var(--line-strong); background: #171c18; box-shadow: 0 22px 42px rgba(0, 0, 0, .2); transform: translateY(-3px); }
.episode-card__number { display: flex; min-height: 2.8rem; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding: 0 1.05rem; color: var(--accent); font-family: ui-monospace, monospace; font-size: .72rem; }
.episode-card__number::after { content: 'EPISODE'; color: var(--quiet); font-family: ui-monospace, monospace; font-size: .55rem; letter-spacing: .12em; }
.episode-card__content { display: flex; flex: 1; flex-direction: column; padding: 1.05rem; }
.episode-card__heading { display: flex; align-items: start; justify-content: space-between; gap: .7rem; }
.episode-card__heading h2 { margin-top: .4rem; color: #eee5d9; font-family: 'Noto Serif SC', serif; font-size: 1.15rem; font-weight: 600; line-height: 1.35; }
.episode-card__status { border: 1px solid rgba(243, 166, 111, .25); padding: .24rem .4rem; color: var(--accent); font-size: .6rem; white-space: nowrap; }
.episode-card__logline { display: -webkit-box; min-height: 4.1rem; margin-top: .8rem; overflow: hidden; color: var(--muted); font-size: .74rem; line-height: 1.7; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.episode-card__meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .35rem; margin-top: auto; padding: 1.15rem 0 .95rem; border-top: 1px solid rgba(242, 218, 189, .1); color: var(--quiet); font-size: .62rem; }
.episode-card__meta span { display: flex; min-width: 0; flex-direction: column; gap: .22rem; }
.episode-card__meta b { color: #e1d3c5; font-family: ui-monospace, monospace; font-size: .8rem; font-weight: 600; }
.episode-card__meta em { font-style: normal; }
.episode-card__progress { margin-top: .1rem; padding: .75rem 0 .55rem; border-top: 1px solid rgba(242, 218, 189, .1); }
.episode-card__progress-copy { display: flex; align-items: center; justify-content: space-between; color: var(--quiet); font-size: .6rem; }
.episode-card__progress-copy strong { color: #ded2c5; font: .62rem ui-monospace, monospace; }
.episode-card__progress-track { height: .2rem; margin-top: .45rem; overflow: hidden; background: rgba(242, 218, 189, .1); }
.episode-card__progress-track span { display: block; width: 100%; height: 100%; background: var(--accent); transform: scaleX(var(--progress-ratio, 0)); transform-origin: left center; transition: transform 420ms cubic-bezier(.2, .75, .25, 1); }
.episode-card__next { display: flex; min-height: 1.2rem; align-items: center; gap: .3rem; margin: .15rem 0 .8rem; color: #c5b9ac; font-size: .63rem; line-height: 1.4; }
.episode-card__next .material-symbols-outlined { color: var(--accent); font-size: .9rem; }
.episode-card__actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.episode-card__actions button { justify-content: center; white-space: nowrap; }
.episode-card__actions .episode-card__primary { grid-column: auto; }
.episode-card.is-delivery { min-height: 0; }
.episode-card.is-delivery:hover { transform: none; }
.episode-card.is-delivery .episode-card__number,
.episode-card.is-delivery .episode-card__logline,
.episode-card.is-delivery .episode-card__meta,
.episode-card.is-delivery .episode-card__progress,
.episode-card.is-delivery .episode-card__next { display: none; }
.episode-card.is-delivery .episode-card__content { padding: .8rem .9rem; }
.episode-card.is-delivery .episode-card__heading h2 { margin-top: 0; font-family: inherit; font-size: .88rem; font-weight: 650; }
.episode-delivery-row { display: grid; grid-template-columns: 5.4rem minmax(0, 1fr); align-items: center; gap: .8rem; margin-top: .75rem; }
.episode-delivery-row__poster { position: relative; display: grid; width: 5.4rem; aspect-ratio: 9 / 14; overflow: hidden; place-items: center; background: #181b18; color: white; }
.episode-delivery-row__poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.episode-delivery-row__poster .material-symbols-outlined { position: relative; display: grid; width: 2rem; height: 2rem; place-items: center; border: 1px solid rgba(255,255,255,.75); border-radius: 50%; background: rgba(0,0,0,.38); font-size: 1.2rem; }
.episode-delivery-row__info { display: grid; min-width: 0; gap: .35rem; align-content: center; }
.episode-delivery-row__info > strong { overflow: hidden; color: var(--ink); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.episode-delivery-row__info > span { color: var(--muted); font-size: .65rem; }
.episode-delivery-row__actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .25rem; }
.episode-delivery-row__actions button,
.episode-delivery-row__actions a { min-height: 2rem; padding: .38rem .55rem; font-size: .64rem; text-decoration: none; }
.episode-delivery-preview { display: block; width: min(100%, 28rem); max-height: 24rem; margin: .75rem auto 0; background: #050605; object-fit: contain; }
.episode-delivery-state { display: flex; min-height: 4rem; align-items: center; gap: .65rem; margin-top: .6rem; border-top: 1px solid var(--line); color: var(--accent); }
.episode-delivery-state,
.episode-delivery-error { grid-column: 1 / -1; }
.episode-delivery-state > span:last-child { display: grid; gap: .2rem; }
.episode-delivery-state strong { font-size: .74rem; }
.episode-delivery-state small { color: var(--muted); font-size: .64rem; }
.episode-delivery-error { display: grid; gap: .55rem; margin-top: .7rem; color: #f0b2a5; font-size: .7rem; }
.episode-delivery-error__actions { display: flex; flex-wrap: wrap; gap: .45rem; align-items: center; margin-top: .2rem; }
.episode-delivery-error__actions button { min-height: 2.2rem; padding: .42rem .7rem; font-size: .68rem; }
.episode-card__render { min-height: 2.6rem; margin-top: .6rem; }
.episode-card__primary { border-color: var(--accent); background: var(--accent); color: #291910; font-weight: 700; }
.episode-card__primary:hover { background: #ffc08b; box-shadow: 0 8px 22px rgba(243, 166, 111, .16); transform: translateY(-1px); }
.episode-card__primary:disabled { cursor: progress; opacity: .65; }
.episode-workbench button:focus-visible { outline: 2px solid #f6c39a; outline-offset: 3px; }
.episode-spinner {
  display: inline-block;
  width: 1.15rem;
  height: 1.15rem;
  box-sizing: border-box;
  flex: 0 0 auto;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: episode-spinner-spin 680ms linear infinite;
}
.episode-workbench__state { display: flex; min-height: 12rem; align-items: center; justify-content: center; gap: .55rem; border: 1px dashed rgba(255, 183, 125, .25); color: var(--muted); font-size: .8rem; }
.episode-workbench__state.is-error { color: #ee9a8b; }
.episode-workbench__state button { border-bottom: 1px solid currentColor; }
.episode-workbench__data-notice {
  grid-column: 1 / -1;
  display: flex;
  min-height: 4.5rem;
  align-items: center;
  gap: .65rem;
  border: 1px solid rgba(243, 166, 111, .24);
  background: rgba(243, 166, 111, .055);
  padding: .9rem 1rem;
  color: #d5bca7;
  font-size: .72rem;
}
.episode-workbench__data-notice .material-symbols-outlined { color: var(--accent); font-size: 1.15rem; }
.episode-workbench__data-notice span:nth-child(2) { flex: 1; }
.episode-workbench__data-notice button {
  border: 1px solid rgba(243, 166, 111, .35);
  padding: .45rem .65rem;
  color: var(--accent);
  transition: background-color 180ms ease, border-color 180ms ease;
}
.episode-workbench__data-notice button:hover { border-color: var(--accent); background: rgba(243, 166, 111, .08); }
.episode-workbench__notice {
  display: flex;
  width: fit-content;
  max-width: min(100%, 48rem);
  align-items: center;
  gap: .45rem;
  margin: .85rem 0 0 auto;
  border: 1px solid rgba(159, 198, 165, .45);
  background: #152019;
  padding: .75rem 1rem;
  color: #b7d8bd;
  font-size: .72rem;
  box-shadow: 0 16px 40px rgba(0,0,0,.3);
  animation: notice-in 260ms cubic-bezier(.2, .75, .25, 1) both;
}
.episode-workbench__notice.is-error { border-color: rgba(238, 154, 139, .45); background: #241716; color: #f0b2a5; }
.episode-workbench__notice button { margin-left: .35rem; border-bottom: 1px solid currentColor; }
.episode-workbench__checkpoint {
  --ink: #f1e9dd;
  --muted: #9f9b92;
  --accent: #f3a66f;
  width: min(34rem, calc(100vw - 2rem));
  max-width: none;
  border: 1px solid rgba(243, 166, 111, .48);
  background: #171a17;
  padding: 0;
  color: var(--ink);
  box-shadow: 0 24px 80px rgba(0, 0, 0, .48);
}
.episode-workbench__checkpoint::backdrop { background: rgba(5, 7, 5, .76); }
.episode-workbench__checkpoint-body { display: grid; grid-template-columns: 2.8rem minmax(0, 1fr); align-items: start; gap: 1rem; padding: 1.4rem; }
.episode-workbench__checkpoint-icon { display: grid; width: 2.8rem; height: 2.8rem; place-items: center; border: 1px solid rgba(243, 166, 111, .4); color: var(--accent); font-size: 1.35rem; }
.episode-workbench__checkpoint-copy { display: grid; justify-items: start; gap: .55rem; min-width: 0; }
.episode-workbench__checkpoint-copy h2 { color: #f1e1d2; font-size: 1rem; font-weight: 650; }
.episode-workbench__checkpoint-copy p { color: var(--muted); font-size: .76rem; line-height: 1.65; }
.episode-workbench__checkpoint-confirm { min-height: 2.5rem; margin-top: .35rem; }
.episode-workbench__checkpoint-confirm:focus-visible { outline: 2px solid #f6c39a; outline-offset: 3px; }

@keyframes episode-card-in {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes notice-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes episode-spinner-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .episode-card { animation: none; opacity: 1; }
  .episode-card, .episode-card__primary, .episode-card__secondary, .episode-card__progress-track span { transition: none; }
  .episode-workbench__notice { animation: none; }
  .episode-spinner { animation: none; }
}

@media (max-width: 1120px) {
  .episode-workbench__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 820px) {
  .episode-workbench__grid { grid-template-columns: 1fr; }
  .episode-workbench__hero { align-items: start; flex-direction: column; padding-top: 2.5rem; }
  .episode-workbench__summary { width: 100%; }
  .episode-workbench__summary small { text-align: left; }
  .episode-workbench__step { display: none; }
  .episode-workbench__flow { grid-template-columns: 1fr; gap: .6rem; }
  .episode-workbench__flow ol { gap: .25rem; }
  .episode-workbench__flow li { flex-direction: column; align-items: flex-start; gap: .3rem; }
  .episode-workbench__flow li:not(:last-child)::after { position: absolute; top: .72rem; right: -.15rem; left: 1.7rem; width: auto; }
  .episode-workbench__checkpoint-body { grid-template-columns: 2.3rem minmax(0, 1fr); gap: .75rem; padding: 1rem; }
  .episode-workbench__checkpoint-icon { width: 2.3rem; height: 2.3rem; }
  .episode-workbench__checkpoint-confirm { white-space: normal; text-align: center; }
}

@media (max-width: 520px) {
  .episode-workbench { padding-inline: .8rem; }
  .episode-workbench__hero h1 { font-size: 2rem; }
  .episode-card__actions { align-items: stretch; }
  .episode-delivery-row { grid-template-columns: 4.4rem minmax(0, 1fr); gap: .65rem; }
  .episode-delivery-row__poster { width: 4.4rem; }
}
</style>
