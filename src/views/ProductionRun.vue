<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  completeProductionStage,
  createProductionRun,
  decideProductionCheckpoint,
  getProductionRun,
  listProductionRuns,
  type ProductionRunDTO,
  type ProductionRunViewDTO,
} from '@/api/production'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  return fromQuery > 0 ? fromQuery : getWorkspaceContext()?.projectId || 0
})

const pageState = ref<'loading' | 'ready' | 'error'>('loading')
const errorMsg = ref('')
const infoMsg = ref('')
const runs = ref<ProductionRunDTO[]>([])
const selectedRunId = ref(0)
const detail = ref<ProductionRunViewDTO | null>(null)
const busy = ref(false)
const note = ref('')
const form = ref({
  episodeNo: 1,
  budget: 0,
  keyShotVideoCandidates: 3,
  normalShotVideoCandidates: 2,
  imageCandidates: 3,
  audioCandidates: 2,
})

const stageLabels: Record<string, string> = {
  'market-validation': '市场验证',
  'episode-blueprint': '单集蓝图',
  'emotion-design': '情绪设计',
  'candidate-generation': '多候选生成',
  'candidate-selection': '候选筛选',
  'continuous-edit': '连续剪辑',
  'pilot-release': '小样本发布',
  'data-review': '数据复盘',
  'scale-decision': '扩大决策',
}

const currentCheckpoint = computed(() =>
  detail.value?.checkpoints.find(
    (item) => item.checkpointKey === detail.value?.run.currentCheckpoint,
  ) || null,
)

const currentStage = computed(() =>
  detail.value?.stages.find((item) => item.stageKey === detail.value?.run.currentStage) || null,
)

const emotionBeats = computed(() => detail.value?.blueprint?.emotionBeats || [])
const blueprintQuality = computed(() => detail.value?.blueprint?.qualityReport || null)

function resetMessage(): void {
  errorMsg.value = ''
  infoMsg.value = ''
}

function showError(error: unknown, fallback: string): void {
  errorMsg.value = error instanceof Error ? error.message : fallback
}

async function loadRuns(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'error'
    errorMsg.value = '缺少项目上下文'
    return
  }

  pageState.value = 'loading'
  resetMessage()
  try {
    const payload = await listProductionRuns(projectId.value)
    runs.value = payload.items
    if (!selectedRunId.value || !runs.value.some((item) => item.id === selectedRunId.value)) {
      selectedRunId.value = runs.value[0]?.id || 0
    }
    if (selectedRunId.value) {
      detail.value = await getProductionRun(selectedRunId.value)
    } else {
      detail.value = null
    }
    pageState.value = 'ready'
  } catch (error) {
    pageState.value = 'error'
    showError(error, '生产运行加载失败')
  }
}

async function selectRun(runId: number): Promise<void> {
  selectedRunId.value = runId
  resetMessage()
  try {
    detail.value = await getProductionRun(runId)
  } catch (error) {
    showError(error, '生产运行详情加载失败')
  }
}

async function startRun(): Promise<void> {
  if (!projectId.value || busy.value) return
  busy.value = true
  resetMessage()
  try {
    detail.value = await createProductionRun(projectId.value, {
      platform: '抖音',
      episodeNo: form.value.episodeNo,
      budget: form.value.budget > 0 ? form.value.budget : null,
      pilotSceneCount: 2,
      pilotMode: 'two-scenes-golden-sample',
      candidatePolicy: {
        keyShotVideoCandidates: form.value.keyShotVideoCandidates,
        normalShotVideoCandidates: form.value.normalShotVideoCandidates,
        imageCandidates: form.value.imageCandidates,
        audioCandidates: form.value.audioCandidates,
        maxCandidateCostMultiplier: 3,
      },
      successMetrics: ['3秒留存', '完播率', '评论与关注意愿'],
      idempotencyKey: `project:${projectId.value}:episode:${form.value.episodeNo}:golden-sample-v1`,
    })
    selectedRunId.value = detail.value.run.id
    infoMsg.value = '黄金样片 ProductionRun 已创建，当前等待市场验证审批'
    await loadRuns()
  } catch (error) {
    showError(error, '创建 ProductionRun 失败')
  } finally {
    busy.value = false
  }
}

async function decideCheckpoint(decision: 'approve' | 'reject'): Promise<void> {
  if (!detail.value?.run.currentCheckpoint || busy.value) return
  busy.value = true
  resetMessage()
  try {
    detail.value = await decideProductionCheckpoint(
      detail.value.run.id,
      detail.value.run.currentCheckpoint,
      decision,
      note.value.trim(),
    )
    note.value = ''
    infoMsg.value = decision === 'approve' ? '检查点已批准，生产运行已推进' : '检查点已拒绝，运行已暂停'
    await loadRuns()
  } catch (error) {
    showError(error, '保存检查点决定失败')
  } finally {
    busy.value = false
  }
}

async function completeCurrentStage(): Promise<void> {
  if (!detail.value?.run.currentStage || detail.value.run.currentCheckpoint || busy.value) return
  busy.value = true
  resetMessage()
  try {
    detail.value = await completeProductionStage(
      detail.value.run.id,
      detail.value.run.currentStage,
      {
        completedBy: 'workspace-user',
        stageKey: detail.value.run.currentStage,
      },
      note.value.trim(),
    )
    note.value = ''
    infoMsg.value = '当前阶段已完成，生产运行已推进'
    await loadRuns()
  } catch (error) {
    showError(error, '完成生产阶段失败')
  } finally {
    busy.value = false
  }
}

function goMarket(): void {
  router.push({ path: '/workspace/market', query: { projectId: String(projectId.value) } })
}

watch(
  () => route.query.projectId,
  () => {
    if (projectId.value) setWorkspaceContext({ projectId: projectId.value })
    void loadRuns()
  },
)

onMounted(() => {
  if (projectId.value) setWorkspaceContext({ projectId: projectId.value })
  void loadRuns()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <div class="min-h-full bg-[#111210] px-5 py-6 text-on-surface md:px-8">
      <div class="mx-auto max-w-[1600px]">
        <header class="flex flex-col gap-5 border-b border-outline-variant pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="text-[11px] uppercase tracking-[0.25em] text-primary">Production Control / Multi-Agent</p>
            <h1 class="mt-3 text-3xl font-semibold tracking-tight">生产运行</h1>
            <p class="mt-3 max-w-3xl text-sm leading-6 text-on-surface-variant">
              从现有小说剧本启动第 1 集抖音黄金样片。先经过市场验证、蓝图和情绪节拍审批，再允许进入候选生成。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="border border-outline-variant px-4 py-2 text-sm text-on-surface-variant hover:border-primary hover:text-primary"
              @click="goMarket"
            >
              查看市场实验
            </button>
            <button
              type="button"
              class="burning-orange-btn px-4 py-2 text-sm font-semibold"
              :disabled="busy"
              @click="startRun"
            >
              {{ busy ? '处理中...' : '启动黄金样片' }}
            </button>
          </div>
        </header>

        <div v-if="errorMsg || infoMsg" class="mt-6 border px-4 py-3 text-sm" :class="errorMsg ? 'border-red-400/30 bg-red-400/5 text-red-200' : 'border-emerald-400/30 bg-emerald-400/5 text-emerald-200'">
          {{ errorMsg || infoMsg }}
        </div>

        <div v-if="pageState === 'loading'" class="flex min-h-[420px] items-center justify-center text-sm text-on-surface-variant">
          正在读取生产运行...
        </div>

        <div v-else-if="pageState === 'error'" class="mt-8 border border-red-400/30 bg-red-400/5 p-6">
          <h2 class="text-lg font-semibold text-red-200">生产运行加载失败</h2>
          <p class="mt-2 text-sm text-on-surface-variant">{{ errorMsg }}</p>
          <button type="button" class="mt-4 border border-outline-variant px-4 py-2 text-sm" @click="loadRuns">
            重新加载
          </button>
        </div>

        <template v-else>
          <section class="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article class="border border-primary/30 bg-primary/5 px-5 py-4">
              <p class="text-xs text-primary">目标平台</p>
              <p class="mt-2 text-2xl font-semibold">抖音</p>
              <p class="mt-1 text-xs text-on-surface-variant">第一阶段固定单平台验证</p>
            </article>
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">验证范围</p>
              <p class="mt-2 text-2xl font-semibold">2 场景</p>
              <p class="mt-1 text-xs text-on-surface-variant">黄金样片通过后再扩展整集</p>
            </article>
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">关键镜头候选</p>
              <p class="mt-2 text-2xl font-semibold">3 条视频</p>
              <p class="mt-1 text-xs text-on-surface-variant">普通镜头默认 2 条视频</p>
            </article>
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">当前运行</p>
              <p class="mt-2 text-2xl font-semibold">{{ runs.length }}</p>
              <p class="mt-1 text-xs text-on-surface-variant">历史运行保留，失败不覆盖</p>
            </article>
          </section>

          <section class="mt-8 grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
            <aside class="space-y-4">
              <div class="border border-outline-variant bg-surface-container p-4">
                <div class="mb-3 flex items-center justify-between">
                  <h2 class="font-semibold">运行记录</h2>
                  <span class="font-mono text-xs text-on-surface-variant">{{ runs.length }}</span>
                </div>
                <div v-if="runs.length" class="space-y-2">
                  <button
                    v-for="run in runs"
                    :key="run.id"
                    type="button"
                    class="w-full border px-3 py-3 text-left transition"
                    :class="selectedRunId === run.id ? 'border-primary bg-primary/10' : 'border-outline-variant hover:border-primary/60'"
                    @click="selectRun(run.id)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate text-sm font-semibold">{{ run.name }}</span>
                      <span class="font-mono text-[10px] text-primary">#{{ run.id }}</span>
                    </div>
                    <p class="mt-2 text-xs text-on-surface-variant">
                      第 {{ run.episodeNo }} 集 · {{ stageLabels[run.currentStage] || run.currentStage }}
                    </p>
                    <p class="mt-1 text-[11px]" :class="run.status === 'paused' ? 'text-red-200' : 'text-primary'">
                      {{ run.status }}
                    </p>
                  </button>
                </div>
                <div v-else class="border border-dashed border-outline-variant px-4 py-6 text-center text-xs leading-5 text-on-surface-variant">
                  还没有生产运行。点击右上角启动第 1 集黄金样片。
                </div>
              </div>

              <div class="border border-outline-variant bg-surface-container p-4">
                <h2 class="font-semibold">候选策略</h2>
                <div class="mt-4 grid grid-cols-2 gap-2 text-center text-xs">
                  <label class="border border-outline-variant bg-surface-container-low p-3">
                    <span class="block text-on-surface-variant">关键视频</span>
                    <input v-model.number="form.keyShotVideoCandidates" class="mt-2 w-full bg-transparent text-center text-lg text-primary outline-none" type="number" min="1" max="3" />
                  </label>
                  <label class="border border-outline-variant bg-surface-container-low p-3">
                    <span class="block text-on-surface-variant">普通视频</span>
                    <input v-model.number="form.normalShotVideoCandidates" class="mt-2 w-full bg-transparent text-center text-lg text-primary outline-none" type="number" min="1" max="3" />
                  </label>
                  <label class="border border-outline-variant bg-surface-container-low p-3">
                    <span class="block text-on-surface-variant">静帧</span>
                    <input v-model.number="form.imageCandidates" class="mt-2 w-full bg-transparent text-center text-lg text-primary outline-none" type="number" min="1" max="3" />
                  </label>
                  <label class="border border-outline-variant bg-surface-container-low p-3">
                    <span class="block text-on-surface-variant">声音</span>
                    <input v-model.number="form.audioCandidates" class="mt-2 w-full bg-transparent text-center text-lg text-primary outline-none" type="number" min="1" max="3" />
                  </label>
                </div>
              </div>
            </aside>

            <main v-if="detail" class="space-y-6">
              <section class="border border-primary/30 bg-primary/5 p-5">
                <div class="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p class="text-[11px] uppercase tracking-[0.2em] text-primary">Active ProductionRun #{{ detail.run.id }}</p>
                    <h2 class="mt-2 text-2xl font-semibold">{{ detail.run.name }}</h2>
                    <p class="mt-2 max-w-3xl text-sm leading-6 text-on-surface-variant">
                      当前阶段：{{ stageLabels[detail.run.currentStage] || detail.run.currentStage }}
                      <span v-if="detail.run.currentCheckpoint"> · 等待 {{ detail.run.currentCheckpoint }} 审批</span>
                    </p>
                  </div>
                  <span class="border border-primary/40 px-3 py-1 text-xs text-primary">{{ detail.run.status }}</span>
                </div>

                <div class="mt-6 grid gap-2 md:grid-cols-3">
                  <div class="border border-outline-variant bg-black/15 p-3">
                    <p class="text-[11px] text-on-surface-variant">来源</p>
                    <p class="mt-2 text-sm">当前故事圣经 + 整季结构</p>
                  </div>
                  <div class="border border-outline-variant bg-black/15 p-3">
                    <p class="text-[11px] text-on-surface-variant">成功指标</p>
                    <p class="mt-2 text-sm">{{ detail.run.successMetrics.join(' · ') }}</p>
                  </div>
                  <div class="border border-outline-variant bg-black/15 p-3">
                    <p class="text-[11px] text-on-surface-variant">验证模式</p>
                    <p class="mt-2 text-sm">两场景黄金样片</p>
                  </div>
                </div>
              </section>

              <section class="border border-outline-variant bg-surface-container p-5">
                <div class="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h2 class="font-semibold">生产阶段</h2>
                    <p class="mt-1 text-xs text-on-surface-variant">未通过当前闸门的阶段不会进入模型生成。</p>
                  </div>
                  <span class="font-mono text-xs text-on-surface-variant">{{ detail.stages.length }} stages</span>
                </div>
                <div class="grid gap-2 md:grid-cols-3">
                  <div
                    v-for="stage in detail.stages"
                    :key="stage.stageKey"
                    class="border p-3"
                    :class="{
                      'border-primary bg-primary/10': stage.stageKey === detail.run.currentStage,
                      'border-emerald-400/30 bg-emerald-400/5': stage.status === 'completed',
                      'border-red-400/30 bg-red-400/5': stage.status === 'blocked',
                      'border-outline-variant bg-surface-container-low': stage.stageKey !== detail.run.currentStage && stage.status !== 'completed' && stage.status !== 'blocked',
                    }"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-mono text-[10px] text-on-surface-variant">0{{ stage.sequenceNo }}</span>
                      <span class="text-[10px] uppercase tracking-widest text-primary">{{ stage.status }}</span>
                    </div>
                    <p class="mt-3 text-sm font-semibold">{{ stageLabels[stage.stageKey] || stage.stageKey }}</p>
                    <p class="mt-1 text-xs text-on-surface-variant">{{ stage.agentKey }}</p>
                  </div>
                </div>
              </section>

              <section class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div class="border border-outline-variant bg-surface-container p-5">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 class="font-semibold">第 {{ detail.run.episodeNo }} 集高转化蓝图</h2>
                      <p class="mt-1 text-xs text-on-surface-variant">
                        {{ detail.blueprint?.blueprint?.title || '蓝图尚未生成' }} · {{ detail.blueprint?.blueprint?.targetDurationSeconds || '—' }} 秒
                      </p>
                    </div>
                    <span class="border px-2 py-1 text-xs" :class="blueprintQuality?.canApprove ? 'border-emerald-400/30 text-emerald-200' : 'border-amber-400/30 text-amber-200'">
                      {{ blueprintQuality?.canApprove ? '可审批' : '需要返工' }}
                    </span>
                  </div>
                  <div v-if="emotionBeats.length" class="mt-5 space-y-3">
                    <article v-for="beat in emotionBeats" :key="beat.beatKey" class="border border-outline-variant bg-surface-container-low p-4">
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                          <span class="font-mono text-xs text-primary">0{{ beat.sequenceNo }}</span>
                          <h3 class="text-sm font-semibold">{{ beat.label }}</h3>
                        </div>
                        <span class="text-xs text-on-surface-variant">{{ beat.durationSeconds }}s · 场景 {{ beat.sceneNo }}</span>
                      </div>
                      <div class="mt-3 grid gap-3 md:grid-cols-3">
                        <div>
                          <p class="text-[11px] text-primary">情绪</p>
                          <p class="mt-1 text-xs leading-5 text-on-surface-variant">{{ beat.emotionStart }} → {{ beat.emotionEnd }}</p>
                          <p class="mt-1 text-xs leading-5">{{ beat.emotionProcess }}</p>
                        </div>
                        <div>
                          <p class="text-[11px] text-primary">动作</p>
                          <p class="mt-1 text-xs leading-5 text-on-surface-variant">{{ beat.actionStart }}</p>
                          <p class="mt-1 text-xs leading-5">{{ beat.actionProcess }}</p>
                          <p class="mt-1 text-xs leading-5 text-on-surface-variant">{{ beat.actionEnd }}</p>
                        </div>
                        <div>
                          <p class="text-[11px] text-primary">声音与连续性</p>
                          <p class="mt-1 text-xs leading-5">{{ beat.soundPlan }}</p>
                          <p class="mt-1 text-xs leading-5 text-on-surface-variant">{{ beat.continuity }}</p>
                        </div>
                      </div>
                    </article>
                  </div>
                  <div v-else class="mt-5 border border-dashed border-outline-variant px-4 py-8 text-center text-sm text-on-surface-variant">
                    当前运行还没有蓝图。
                  </div>
                </div>

                <aside class="space-y-6">
                  <div class="border border-primary/30 bg-primary/5 p-5">
                    <p class="text-[11px] uppercase tracking-[0.2em] text-primary">Human Checkpoint</p>
                    <h2 class="mt-2 text-lg font-semibold">
                      {{ currentCheckpoint ? `审批：${currentCheckpoint.checkpointKey}` : '当前无需审批' }}
                    </h2>
                    <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                      {{ currentStage ? `当前 Agent：${currentStage.agentKey}` : '等待生产运行状态更新' }}
                    </p>
                    <textarea
                      v-if="currentCheckpoint"
                      v-model="note"
                      class="mt-4 min-h-[100px] w-full border border-outline-variant bg-surface-container-low p-3 text-sm outline-none focus:border-primary"
                      placeholder="填写本次审批依据、返工原因或预算说明"
                    ></textarea>
                    <div v-if="currentCheckpoint" class="mt-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        class="border border-red-400/30 px-3 py-2 text-sm text-red-200 hover:bg-red-400/10"
                        :disabled="busy"
                        @click="decideCheckpoint('reject')"
                      >
                        暂停并返工
                      </button>
                      <button
                        type="button"
                        class="burning-orange-btn px-3 py-2 text-sm font-semibold"
                        :disabled="busy"
                        @click="decideCheckpoint('approve')"
                      >
                        批准推进
                      </button>
                    </div>
                    <button
                      v-else-if="currentStage && ['ready', 'running'].includes(currentStage.status)"
                      type="button"
                      class="burning-orange-btn mt-4 w-full px-3 py-2 text-sm font-semibold"
                      :disabled="busy"
                      @click="completeCurrentStage"
                    >
                      {{ busy ? '处理中...' : `完成${stageLabels[currentStage.stageKey] || '当前阶段'}` }}
                    </button>
                  </div>

                  <div class="border border-outline-variant bg-surface-container p-5">
                    <h2 class="font-semibold">蓝图质量门禁</h2>
                    <div class="mt-4 space-y-2 text-xs">
                      <div class="flex items-center justify-between border-b border-outline-variant pb-2">
                        <span class="text-on-surface-variant">情绪段落</span>
                        <span>{{ blueprintQuality?.summary?.emotionBeatCount || 0 }}</span>
                      </div>
                      <div class="flex items-center justify-between border-b border-outline-variant pb-2">
                        <span class="text-on-surface-variant">镜头计划</span>
                        <span>{{ blueprintQuality?.summary?.shotCount || 0 }}</span>
                      </div>
                      <div class="flex items-center justify-between border-b border-outline-variant pb-2">
                        <span class="text-on-surface-variant">关键镜头</span>
                        <span>{{ blueprintQuality?.summary?.keyShotCount || 0 }}</span>
                      </div>
                      <div v-if="blueprintQuality?.blockers?.length" class="mt-4 space-y-2 text-red-200">
                        <p v-for="blocker in blueprintQuality.blockers" :key="blocker.code">
                          {{ blocker.message }}
                        </p>
                      </div>
                      <p v-else class="mt-4 text-emerald-200">当前蓝图结构满足第一轮审批条件。</p>
                    </div>
                  </div>
                </aside>
              </section>
            </main>

            <main v-else class="border border-dashed border-outline-variant bg-surface-container-low px-6 py-20 text-center">
              <span class="material-symbols-outlined text-5xl text-primary">account_tree</span>
              <h2 class="mt-4 text-xl font-semibold">还没有黄金样片运行</h2>
              <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-on-surface-variant">
                当前入口会读取项目里的小说剧本内容，生成一份带情绪段落、动作节拍和声音约束的第 1 集蓝图。
              </p>
              <button type="button" class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold" :disabled="busy" @click="startRun">
                启动第 1 集黄金样片
              </button>
            </main>
          </section>
        </template>
      </div>
    </div>
  </WorkspaceLayout>
</template>
