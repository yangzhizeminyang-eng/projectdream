<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  analyzeMarketSamples,
  createExperimentFromOpportunity,
  createContentExperiment,
  createExperimentMetric,
  createExperimentVariant,
  createMarketObservation,
  createTopicOpportunity,
  getMarketWorkspace,
  listExperimentMetrics,
  listExperimentVariants,
  type ContentExperimentDTO,
  type ExperimentMetricDTO,
  type ExperimentVariantDTO,
  type MarketAnalysisDTO,
  type MarketObservationDTO,
  type MarketPlatform,
  type ObservationConfidence,
  type TopicOpportunityDTO,
} from '@/api/market'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type TabKey = 'observations' | 'opportunities' | 'experiments'
type PageState = 'loading' | 'ready' | 'error'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  return fromQuery > 0 ? fromQuery : getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const errorMsg = ref('')
const infoMsg = ref('')
const activeTab = ref<TabKey>('observations')
const observations = ref<MarketObservationDTO[]>([])
const opportunities = ref<TopicOpportunityDTO[]>([])
const experiments = ref<ContentExperimentDTO[]>([])
const selectedExperimentId = ref(0)
const variants = ref<ExperimentVariantDTO[]>([])
const metrics = ref<ExperimentMetricDTO[]>([])
const saving = ref(false)
const analyzing = ref(false)
const creatingExperimentId = ref(0)
const latestAnalysis = ref<MarketAnalysisDTO | null>(null)

const platformOptions: MarketPlatform[] = ['红果', '抖音', '快手', '视频号', '其他']
const confidenceOptions: Array<{ value: ObservationConfidence; label: string }> = [
  { value: 'fact', label: '事实观察' },
  { value: 'reported', label: '公开资料转述' },
  { value: 'inference', label: '模型归纳' },
  { value: 'hypothesis', label: '人工假设' },
]

const observationForm = ref({
  workTitle: '',
  platform: '红果',
  topic: '',
  visualStyle: '3D 漫',
  protagonistIdentity: '',
  openingType: '危机先行',
  endingHook: '',
  titlePattern: '',
  coverPattern: '',
  commentNotes: '',
  sourceNote: '',
  rightsStatus: '仅做结构观察',
  confidence: 'fact' as ObservationConfidence,
  tags: '',
})

const opportunityForm = ref({
  title: '',
  platform: '红果',
  audience: '',
  topic: '',
  logline: '',
  hypothesis: '',
  differentiation: '',
  risk: '',
  recommendedFormat: '9:16 竖屏系列漫剧',
  score: '',
})

const experimentForm = ref({
  name: '',
  platform: '红果',
  audience: '',
  topic: '',
  promise: '',
  hypothesis: '',
  budget: '',
})

const variantForm = ref({
  label: '',
  openingType: '危机先行',
  coverVersion: '封面 A',
  titleVersion: '',
  visualStyle: '3D 漫',
  episodePlan: '第1集\n第2集\n第3集',
})

const metricForm = ref({
  platform: '红果',
  metricName: '平均观看时长',
  metricValue: '',
  metricUnit: '秒',
  notes: '',
})

const selectedExperiment = computed(
  () => experiments.value.find((item) => item.id === selectedExperimentId.value) || null,
)

const summary = computed(() => ({
  observations: observations.value.length,
  opportunities: opportunities.value.length,
  activeExperiments: experiments.value.filter((item) =>
    ['draft', 'running', 'reviewing'].includes(item.status),
  ).length,
  selectedTopics: opportunities.value.filter((item) => item.status === 'selected').length,
}))

function resetMessages(): void {
  errorMsg.value = ''
  infoMsg.value = ''
}

function showError(error: unknown, fallback: string): void {
  errorMsg.value = error instanceof Error ? error.message : fallback
}

async function loadWorkspace(): Promise<void> {
  pageState.value = 'loading'
  resetMessages()

  try {
    const payload = await getMarketWorkspace(projectId.value || undefined)
    observations.value = payload.observations
    opportunities.value = payload.opportunities
    experiments.value = payload.experiments

    if (!selectedExperimentId.value || !experiments.value.some((item) => item.id === selectedExperimentId.value)) {
      selectedExperimentId.value = experiments.value[0]?.id || 0
    }

    if (selectedExperimentId.value) {
      await loadExperimentDetails(selectedExperimentId.value)
    } else {
      variants.value = []
      metrics.value = []
    }

    pageState.value = 'ready'
  } catch (error) {
    pageState.value = 'error'
    showError(error, '市场工作台加载失败')
  }
}

async function runMarketAnalysis(): Promise<void> {
  if (!observations.value.length) {
    errorMsg.value = '请先录入至少 1 个市场样本'
    return
  }

  analyzing.value = true
  resetMessages()
  try {
    latestAnalysis.value = await analyzeMarketSamples({
      projectId: projectId.value || null,
      observationIds: observations.value.map((item) => item.id).slice(0, 50),
      platform: '红果和抖音',
    })
    infoMsg.value = `市场研究 Agent 已完成分析，并生成 ${latestAnalysis.value.opportunities.length} 张题材机会卡`
    await loadWorkspace()
    activeTab.value = 'opportunities'
  } catch (error) {
    showError(error, '市场研究 Agent 执行失败')
  } finally {
    analyzing.value = false
  }
}

async function loadExperimentDetails(experimentId: number): Promise<void> {
  const [variantPayload, metricPayload] = await Promise.all([
    listExperimentVariants(experimentId),
    listExperimentMetrics(experimentId),
  ])
  variants.value = variantPayload.items
  metrics.value = metricPayload.items
}

function selectExperiment(experimentId: number): void {
  selectedExperimentId.value = experimentId
  void loadExperimentDetails(experimentId).catch((error) => showError(error, '实验详情加载失败'))
}

function experimentForOpportunity(opportunityId: number): ContentExperimentDTO | null {
  return (
    experiments.value.find((item) => item.sourceOpportunityId === opportunityId) || null
  )
}

async function createPilotFromOpportunity(opportunity: TopicOpportunityDTO): Promise<void> {
  if (creatingExperimentId.value) return

  creatingExperimentId.value = opportunity.id
  resetMessages()
  try {
    const result = await createExperimentFromOpportunity(opportunity.id)
    selectedExperimentId.value = result.experiment.id
    activeTab.value = 'experiments'
    infoMsg.value = `已创建“${result.experiment.name}”，包含 ${result.variants.length} 个开头版本和 3 集试制计划`
    await loadWorkspace()
  } catch (error) {
    showError(error, '三集试制实验创建失败')
  } finally {
    creatingExperimentId.value = 0
  }
}

async function saveObservation(): Promise<void> {
  if (!observationForm.value.workTitle.trim()) {
    errorMsg.value = '请先填写样本作品名称'
    return
  }

  saving.value = true
  resetMessages()
  try {
    await createMarketObservation({
      projectId: projectId.value || null,
      observedAt: new Date().toISOString(),
      workTitle: observationForm.value.workTitle.trim(),
      platform: observationForm.value.platform,
      topic: observationForm.value.topic.trim() || null,
      visualStyle: observationForm.value.visualStyle.trim() || null,
      protagonistIdentity: observationForm.value.protagonistIdentity.trim() || null,
      openingType: observationForm.value.openingType.trim() || null,
      endingHook: observationForm.value.endingHook.trim() || null,
      titlePattern: observationForm.value.titlePattern.trim() || null,
      coverPattern: observationForm.value.coverPattern.trim() || null,
      commentNotes: observationForm.value.commentNotes.trim() || null,
      sourceNote: observationForm.value.sourceNote.trim() || null,
      rightsStatus: observationForm.value.rightsStatus.trim() || null,
      confidence: observationForm.value.confidence,
      tags: observationForm.value.tags
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    })
    observationForm.value.workTitle = ''
    observationForm.value.topic = ''
    observationForm.value.endingHook = ''
    observationForm.value.commentNotes = ''
    infoMsg.value = '市场样本已保存'
    await loadWorkspace()
  } catch (error) {
    showError(error, '市场样本保存失败')
  } finally {
    saving.value = false
  }
}

async function saveOpportunity(): Promise<void> {
  const form = opportunityForm.value
  if (!form.title.trim() || !form.topic.trim() || !form.audience.trim()) {
    errorMsg.value = '请填写题材名称、题材方向和目标受众'
    return
  }

  saving.value = true
  resetMessages()
  try {
    await createTopicOpportunity({
      projectId: projectId.value || null,
      title: form.title.trim(),
      platform: form.platform,
      audience: form.audience.trim(),
      topic: form.topic.trim(),
      logline: form.logline.trim() || null,
      hypothesis: form.hypothesis.trim() || null,
      differentiation: form.differentiation.trim() || null,
      risk: form.risk.trim() || null,
      recommendedFormat: form.recommendedFormat.trim() || null,
      score: form.score ? Number(form.score) : null,
      status: 'draft',
    })
    opportunityForm.value.title = ''
    opportunityForm.value.topic = ''
    opportunityForm.value.logline = ''
    opportunityForm.value.hypothesis = ''
    infoMsg.value = '题材机会卡已保存'
    await loadWorkspace()
  } catch (error) {
    showError(error, '题材机会保存失败')
  } finally {
    saving.value = false
  }
}

async function saveExperiment(): Promise<void> {
  const form = experimentForm.value
  if (!form.name.trim() || !form.audience.trim() || !form.topic.trim() || !form.promise.trim()) {
    errorMsg.value = '请填写实验名称、受众、题材和一句话卖点'
    return
  }

  saving.value = true
  resetMessages()
  try {
    const experiment = await createContentExperiment({
      projectId: projectId.value || null,
      name: form.name.trim(),
      platform: form.platform,
      audience: form.audience.trim(),
      topic: form.topic.trim(),
      promise: form.promise.trim(),
      hypothesis: form.hypothesis.trim() || null,
      budget: form.budget ? Number(form.budget) : null,
      status: 'draft',
      decision: null,
      notes: null,
    })
    experimentForm.value.name = ''
    experimentForm.value.topic = ''
    experimentForm.value.promise = ''
    selectedExperimentId.value = experiment.id
    activeTab.value = 'experiments'
    infoMsg.value = '内容实验已创建'
    await loadWorkspace()
  } catch (error) {
    showError(error, '内容实验创建失败')
  } finally {
    saving.value = false
  }
}

async function saveVariant(): Promise<void> {
  if (!selectedExperimentId.value || !variantForm.value.label.trim()) {
    errorMsg.value = '请先选择实验并填写版本名称'
    return
  }

  saving.value = true
  resetMessages()
  try {
    await createExperimentVariant(selectedExperimentId.value, {
      label: variantForm.value.label.trim(),
      openingType: variantForm.value.openingType.trim() || null,
      coverVersion: variantForm.value.coverVersion.trim() || null,
      titleVersion: variantForm.value.titleVersion.trim() || null,
      visualStyle: variantForm.value.visualStyle.trim() || null,
      episodePlan: variantForm.value.episodePlan
        .split(/\n|[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    })
    variantForm.value.label = ''
    infoMsg.value = '实验版本已保存'
    await loadExperimentDetails(selectedExperimentId.value)
    await loadWorkspace()
  } catch (error) {
    showError(error, '实验版本保存失败')
  } finally {
    saving.value = false
  }
}

async function saveMetric(): Promise<void> {
  if (!selectedExperimentId.value || !metricForm.value.metricName.trim() || !metricForm.value.metricValue) {
    errorMsg.value = '请先选择实验并填写指标数据'
    return
  }

  saving.value = true
  resetMessages()
  try {
    await createExperimentMetric(selectedExperimentId.value, {
      variantId: null,
      platform: metricForm.value.platform,
      metricName: metricForm.value.metricName.trim(),
      metricValue: Number(metricForm.value.metricValue),
      metricUnit: metricForm.value.metricUnit.trim() || null,
      notes: metricForm.value.notes.trim() || null,
    })
    metricForm.value.metricValue = ''
    metricForm.value.notes = ''
    infoMsg.value = '实验指标已保存'
    await loadExperimentDetails(selectedExperimentId.value)
    await loadWorkspace()
  } catch (error) {
    showError(error, '实验指标保存失败')
  } finally {
    saving.value = false
  }
}

function goDashboard(): void {
  router.push('/dashboard')
}

watch(
  () => route.query.projectId,
  () => {
    if (projectId.value) setWorkspaceContext({ projectId: projectId.value })
    void loadWorkspace()
  },
)

onMounted(() => {
  if (projectId.value) setWorkspaceContext({ projectId: projectId.value })
  void loadWorkspace()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <div class="min-h-full bg-[#111210] px-5 py-6 text-on-surface md:px-8">
      <div class="mx-auto max-w-[1500px]">
        <header class="flex flex-col gap-5 border-b border-outline-variant pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p class="text-[11px] uppercase tracking-[0.25em] text-primary">Content Intelligence / Experiment Lab</p>
            <h1 class="mt-3 text-3xl font-semibold tracking-tight">市场与内容实验</h1>
            <p class="mt-3 max-w-3xl text-sm leading-6 text-on-surface-variant">
              先把公开观察、题材假设和三集试制记录下来，再决定是否扩大生产。这里记录的是研究和实验，不是对平台流量的承诺。
            </p>
          </div>
          <button
            class="border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary hover:text-primary"
            type="button"
            @click="goDashboard"
          >
            返回项目总览
          </button>
        </header>

        <div v-if="pageState === 'loading'" class="flex min-h-[420px] items-center justify-center text-sm text-on-surface-variant">
          正在加载市场实验数据...
        </div>

        <div v-else-if="pageState === 'error'" class="mt-8 border border-red-400/30 bg-red-400/5 p-6">
          <h2 class="text-lg font-semibold text-red-200">市场工作台加载失败</h2>
          <p class="mt-2 text-sm text-on-surface-variant">{{ errorMsg }}</p>
          <button class="mt-4 border border-outline-variant px-4 py-2 text-sm" type="button" @click="loadWorkspace">
            重新加载
          </button>
        </div>

        <template v-else>
          <div v-if="errorMsg || infoMsg" class="mt-6 border px-4 py-3 text-sm" :class="errorMsg ? 'border-red-400/30 bg-red-400/5 text-red-200' : 'border-emerald-400/30 bg-emerald-400/5 text-emerald-200'">
            {{ errorMsg || infoMsg }}
          </div>

          <section class="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">市场样本</p>
              <p class="mt-2 text-3xl font-semibold">{{ summary.observations }}</p>
              <p class="mt-1 text-xs text-on-surface-variant">目标：先完成 20-30 个结构化样本</p>
            </article>
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">题材机会</p>
              <p class="mt-2 text-3xl font-semibold">{{ summary.opportunities }}</p>
              <p class="mt-1 text-xs text-on-surface-variant">从观察提炼原创差异点</p>
            </article>
            <article class="border border-outline-variant bg-surface-container-low px-5 py-4">
              <p class="text-xs text-on-surface-variant">进行中的实验</p>
              <p class="mt-2 text-3xl font-semibold">{{ summary.activeExperiments }}</p>
              <p class="mt-1 text-xs text-on-surface-variant">以三集连续样片为最小单元</p>
            </article>
            <article class="border border-primary/30 bg-primary/10 px-5 py-4">
              <p class="text-xs text-primary">已选题材</p>
              <p class="mt-2 text-3xl font-semibold">{{ summary.selectedTopics }}</p>
              <p class="mt-1 text-xs text-on-surface-variant">通过验证后再进入量产</p>
            </article>
          </section>

          <div class="mt-8 flex gap-1 border-b border-outline-variant">
            <button
              v-for="tab in [
                { key: 'observations', label: '市场观察' },
                { key: 'opportunities', label: '题材机会' },
                { key: 'experiments', label: '内容实验' },
              ]"
              :key="tab.key"
              class="border-b-2 px-4 py-3 text-sm transition"
              :class="activeTab === tab.key ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'"
              type="button"
              @click="activeTab = tab.key as TabKey"
            >
              {{ tab.label }}
            </button>
          </div>

          <section v-if="activeTab === 'observations'" class="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3 border border-primary/30 bg-primary/5 px-5 py-4">
                <div>
                  <h2 class="font-semibold text-primary">市场研究 Agent</h2>
                  <p class="mt-1 text-xs leading-5 text-on-surface-variant">
                    读取当前样本，提炼题材模式并生成待人工审核的机会卡，不会自动发布。
                  </p>
                </div>
                <button
                  class="burning-orange-btn px-4 py-2 text-sm font-semibold"
                  type="button"
                  :disabled="analyzing || !observations.length"
                  @click="runMarketAnalysis"
                >
                  {{ analyzing ? '分析中...' : '分析当前样本' }}
                </button>
              </div>

              <article v-if="latestAnalysis" class="border border-emerald-400/30 bg-emerald-400/5 p-5">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p class="text-[11px] uppercase tracking-[0.2em] text-emerald-200">Latest Agent Run</p>
                    <h2 class="mt-2 text-lg font-semibold">分析结果摘要</h2>
                  </div>
                  <span class="border border-emerald-400/30 px-2 py-1 text-xs text-emerald-200">
                    证据质量：{{ latestAnalysis.analysis.evidenceQuality }}
                  </span>
                </div>
                <p class="mt-4 text-sm leading-6 text-on-surface-variant">
                  {{ latestAnalysis.analysis.analysisSummary }}
                </p>
                <div class="mt-4 grid gap-3 md:grid-cols-3">
                  <div v-for="pattern in latestAnalysis.analysis.patterns" :key="pattern.name" class="border border-outline-variant bg-black/15 p-3">
                    <p class="text-xs text-primary">{{ pattern.name }}</p>
                    <p class="mt-2 text-sm leading-5">{{ pattern.evidence }}</p>
                    <p class="mt-2 text-xs text-on-surface-variant">可信度：{{ pattern.confidence }}</p>
                  </div>
                </div>
                <div v-if="latestAnalysis.analysis.experimentPlan.length" class="mt-4 border-t border-outline-variant pt-4">
                  <p class="text-xs text-primary">建议实验</p>
                  <div v-for="plan in latestAnalysis.analysis.experimentPlan" :key="plan.topicTitle" class="mt-2 text-sm text-on-surface-variant">
                    {{ plan.topicTitle }} · {{ plan.openingVariants.join(' / ') }} · {{ plan.episodeCount }} 集 · {{ plan.reason }}
                  </div>
                </div>
              </article>

              <div v-if="!observations.length" class="border border-dashed border-outline-variant px-6 py-12 text-center text-sm text-on-surface-variant">
                还没有市场观察。先录入你实际看过的热门样本，不要凭印象填写。
              </div>
              <article v-for="item in observations" :key="item.id" class="border border-outline-variant bg-surface-container-low p-5">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="flex flex-wrap items-center gap-2">
                      <h2 class="text-lg font-semibold">{{ item.workTitle }}</h2>
                      <span class="border border-primary/30 bg-primary/10 px-2 py-1 text-xs text-primary">{{ item.platform }}</span>
                      <span class="border border-outline-variant px-2 py-1 text-xs text-on-surface-variant">{{ item.confidence }}</span>
                    </div>
                    <p class="mt-2 text-sm text-on-surface-variant">
                      {{ item.topic || '未填写题材' }} · {{ item.visualStyle || '未填写视觉风格' }} · {{ item.openingType || '未填写开头' }}
                    </p>
                  </div>
                  <span class="text-xs text-on-surface-variant">{{ new Date(item.observedAt).toLocaleDateString('zh-CN') }}</span>
                </div>
                <div class="mt-4 grid gap-4 md:grid-cols-3">
                  <div>
                    <p class="text-xs text-on-surface-variant">主角身份</p>
                    <p class="mt-1 text-sm">{{ item.protagonistIdentity || '未记录' }}</p>
                  </div>
                  <div>
                    <p class="text-xs text-on-surface-variant">结尾钩子</p>
                    <p class="mt-1 text-sm">{{ item.endingHook || '未记录' }}</p>
                  </div>
                  <div>
                    <p class="text-xs text-on-surface-variant">版权状态</p>
                    <p class="mt-1 text-sm">{{ item.rightsStatus || '未记录' }}</p>
                  </div>
                </div>
                <p v-if="item.commentNotes" class="mt-4 border-t border-outline-variant pt-3 text-sm leading-6 text-on-surface-variant">
                  评论观察：{{ item.commentNotes }}
                </p>
              </article>
            </div>

            <form class="border border-outline-variant bg-surface-container-low p-5" @submit.prevent="saveObservation">
              <h2 class="text-lg font-semibold">新增市场样本</h2>
              <p class="mt-2 text-xs leading-5 text-on-surface-variant">只记录你实际观察到的内容，来源和版权状态要写清楚。</p>
              <div class="mt-5 space-y-4">
                <input v-model="observationForm.workTitle" class="field" placeholder="作品名称 *" />
                <div class="grid grid-cols-2 gap-3">
                  <select v-model="observationForm.platform" class="field">
                    <option v-for="item in platformOptions" :key="item" :value="item">{{ item }}</option>
                  </select>
                  <select v-model="observationForm.confidence" class="field">
                    <option v-for="item in confidenceOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
                  </select>
                </div>
                <input v-model="observationForm.topic" class="field" placeholder="题材，例如：重生逆袭" />
                <div class="grid grid-cols-2 gap-3">
                  <input v-model="observationForm.visualStyle" class="field" placeholder="视觉风格" />
                  <input v-model="observationForm.openingType" class="field" placeholder="开头类型" />
                </div>
                <input v-model="observationForm.protagonistIdentity" class="field" placeholder="主角身份" />
                <textarea v-model="observationForm.endingHook" class="field min-h-20" placeholder="结尾钩子"></textarea>
                <textarea v-model="observationForm.titlePattern" class="field min-h-20" placeholder="标题结构观察"></textarea>
                <textarea v-model="observationForm.coverPattern" class="field min-h-20" placeholder="封面结构观察"></textarea>
                <textarea v-model="observationForm.commentNotes" class="field min-h-20" placeholder="评论区和观众反馈"></textarea>
                <input v-model="observationForm.sourceNote" class="field" placeholder="来源备注/观察链接/截图位置" />
                <input v-model="observationForm.tags" class="field" placeholder="标签，用逗号分隔" />
                <button class="burning-orange-btn w-full py-3 text-sm font-semibold" type="submit" :disabled="saving">
                  {{ saving ? '保存中...' : '保存市场样本' }}
                </button>
              </div>
            </form>
          </section>

          <section v-else-if="activeTab === 'opportunities'" class="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div class="grid gap-3 lg:grid-cols-2">
              <div v-if="!opportunities.length" class="border border-dashed border-outline-variant px-6 py-12 text-center text-sm text-on-surface-variant lg:col-span-2">
                还没有题材机会卡。先从市场观察中提炼原创方向。
              </div>
              <article v-for="item in opportunities" :key="item.id" class="border border-outline-variant bg-surface-container-low p-5">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h2 class="text-lg font-semibold">{{ item.title }}</h2>
                    <p class="mt-1 text-sm text-primary">{{ item.topic }} · {{ item.platform }}</p>
                  </div>
                  <span class="border border-outline-variant px-2 py-1 text-xs text-on-surface-variant">{{ item.status }}</span>
                </div>
                <p class="mt-4 text-sm leading-6 text-on-surface-variant">{{ item.logline || '还没有一句话卖点' }}</p>
                <dl class="mt-4 space-y-3 text-sm">
                  <div>
                    <dt class="text-xs text-on-surface-variant">目标受众</dt>
                    <dd class="mt-1">{{ item.audience }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-on-surface-variant">原创差异</dt>
                    <dd class="mt-1 text-on-surface-variant">{{ item.differentiation || '待补充' }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-on-surface-variant">风险</dt>
                    <dd class="mt-1 text-on-surface-variant">{{ item.risk || '待补充' }}</dd>
                  </div>
                </dl>
                <div class="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant pt-4">
                  <span v-if="experimentForOpportunity(item.id)" class="text-xs text-emerald-200">
                    已创建三集试制实验
                  </span>
                  <span v-else class="text-xs text-on-surface-variant">下一步：验证 3 集连续样片</span>
                  <button
                    class="border border-primary px-3 py-2 text-sm text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                    type="button"
                    :disabled="creatingExperimentId !== 0"
                    @click="createPilotFromOpportunity(item)"
                  >
                    {{
                      creatingExperimentId === item.id
                        ? '创建中...'
                        : experimentForOpportunity(item.id)
                          ? '查看试制实验'
                          : '创建三集试制'
                    }}
                  </button>
                </div>
              </article>
            </div>

            <form class="border border-outline-variant bg-surface-container-low p-5" @submit.prevent="saveOpportunity">
              <h2 class="text-lg font-semibold">新增题材机会卡</h2>
              <p class="mt-2 text-xs leading-5 text-on-surface-variant">这是原创试制方向，不是直接复制某个热门作品。</p>
              <div class="mt-5 space-y-4">
                <input v-model="opportunityForm.title" class="field" placeholder="机会卡名称 *" />
                <div class="grid grid-cols-2 gap-3">
                  <select v-model="opportunityForm.platform" class="field">
                    <option v-for="item in platformOptions" :key="item" :value="item">{{ item }}</option>
                  </select>
                  <input v-model="opportunityForm.audience" class="field" placeholder="目标受众 *" />
                </div>
                <input v-model="opportunityForm.topic" class="field" placeholder="题材方向 *" />
                <textarea v-model="opportunityForm.logline" class="field min-h-20" placeholder="一句话卖点"></textarea>
                <textarea v-model="opportunityForm.hypothesis" class="field min-h-20" placeholder="为什么值得试制"></textarea>
                <textarea v-model="opportunityForm.differentiation" class="field min-h-20" placeholder="原创差异化"></textarea>
                <textarea v-model="opportunityForm.risk" class="field min-h-20" placeholder="同质化/版权/生产风险"></textarea>
                <div class="grid grid-cols-2 gap-3">
                  <input v-model="opportunityForm.recommendedFormat" class="field" placeholder="推荐形式" />
                  <input v-model="opportunityForm.score" class="field" type="number" min="0" max="100" placeholder="内部评分" />
                </div>
                <button class="burning-orange-btn w-full py-3 text-sm font-semibold" type="submit" :disabled="saving">
                  {{ saving ? '保存中...' : '保存题材机会' }}
                </button>
              </div>
            </form>
          </section>

          <section v-else class="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div class="space-y-3">
              <div v-if="!experiments.length" class="border border-dashed border-outline-variant px-6 py-12 text-center text-sm text-on-surface-variant">
                还没有内容实验。建议先创建一个三集连续样片实验。
              </div>
              <article
                v-for="item in experiments"
                :key="item.id"
                class="cursor-pointer border bg-surface-container-low p-5 transition"
                :class="selectedExperimentId === item.id ? 'border-primary/70' : 'border-outline-variant hover:border-primary/40'"
                @click="selectExperiment(item.id)"
              >
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h2 class="text-lg font-semibold">{{ item.name }}</h2>
                    <p class="mt-1 text-sm text-primary">{{ item.topic }} · {{ item.platform }}</p>
                  </div>
                  <span class="border border-outline-variant px-2 py-1 text-xs text-on-surface-variant">{{ item.status }}</span>
                </div>
                <p class="mt-3 text-sm leading-6 text-on-surface-variant">{{ item.promise }}</p>
                <div class="mt-4 flex flex-wrap gap-4 text-xs text-on-surface-variant">
                  <span>版本 {{ item.variantCount }}</span>
                  <span>指标 {{ item.metricCount }}</span>
                  <span>预算 {{ item.budget ?? '未设置' }}</span>
                </div>
              </article>

              <div v-if="selectedExperiment" class="border border-primary/30 bg-primary/5 p-5">
                <div class="flex items-center justify-between">
                  <h2 class="text-lg font-semibold">实验版本</h2>
                  <span class="text-xs text-on-surface-variant">{{ selectedExperiment.name }}</span>
                </div>
                <div v-if="!variants.length" class="mt-4 text-sm text-on-surface-variant">还没有版本，至少建立两个开头/封面版本再开始比较。</div>
                <div v-for="item in variants" :key="item.id" class="mt-3 border border-outline-variant bg-black/15 p-4">
                  <div class="flex items-center justify-between">
                    <strong>{{ item.label }}</strong>
                    <span class="text-xs text-on-surface-variant">{{ item.openingType || '未设置开头' }}</span>
                  </div>
                  <p class="mt-2 text-sm text-on-surface-variant">{{ item.titleVersion || '未设置标题版本' }} · {{ item.visualStyle || '未设置视觉风格' }}</p>
                  <p class="mt-2 text-xs text-on-surface-variant">{{ item.episodePlan.join(' / ') || '未设置分集计划' }}</p>
                </div>

                <form class="mt-5 grid gap-3 md:grid-cols-2" @submit.prevent="saveVariant">
                  <input v-model="variantForm.label" class="field" placeholder="版本名称，例如：开头 A" />
                  <input v-model="variantForm.openingType" class="field" placeholder="开头类型" />
                  <input v-model="variantForm.coverVersion" class="field" placeholder="封面版本" />
                  <input v-model="variantForm.titleVersion" class="field" placeholder="标题版本" />
                  <input v-model="variantForm.visualStyle" class="field" placeholder="视觉风格" />
                  <textarea v-model="variantForm.episodePlan" class="field min-h-20" placeholder="分集计划，一行一集"></textarea>
                  <button class="burning-orange-btn py-3 text-sm font-semibold md:col-span-2" type="submit" :disabled="saving">保存实验版本</button>
                </form>

                <div class="mt-8 border-t border-outline-variant pt-5">
                  <h2 class="text-lg font-semibold">发布数据</h2>
                  <div v-if="!metrics.length" class="mt-3 text-sm text-on-surface-variant">还没有录入数据。发布后把真实后台指标写回来。</div>
                  <div v-for="item in metrics" :key="item.id" class="mt-3 flex items-center justify-between border border-outline-variant bg-black/15 p-3 text-sm">
                    <span>{{ item.platform }} · {{ item.metricName }}</span>
                    <strong>{{ item.metricValue }} {{ item.metricUnit || '' }}</strong>
                  </div>
                  <form class="mt-4 grid gap-3 md:grid-cols-2" @submit.prevent="saveMetric">
                    <select v-model="metricForm.platform" class="field">
                      <option v-for="item in platformOptions" :key="item" :value="item">{{ item }}</option>
                    </select>
                    <input v-model="metricForm.metricName" class="field" placeholder="指标名称" />
                    <input v-model="metricForm.metricValue" class="field" type="number" step="0.01" placeholder="指标数值" />
                    <input v-model="metricForm.metricUnit" class="field" placeholder="单位，例如：秒/%" />
                    <input v-model="metricForm.notes" class="field md:col-span-2" placeholder="备注" />
                    <button class="border border-primary px-4 py-3 text-sm text-primary hover:bg-primary/10 md:col-span-2" type="submit" :disabled="saving">保存发布指标</button>
                  </form>
                </div>
              </div>
            </div>

            <form class="border border-outline-variant bg-surface-container-low p-5" @submit.prevent="saveExperiment">
              <h2 class="text-lg font-semibold">创建内容实验</h2>
              <p class="mt-2 text-xs leading-5 text-on-surface-variant">建议一个实验只验证一个主要变量，例如开头或封面。</p>
              <div class="mt-5 space-y-4">
                <input v-model="experimentForm.name" class="field" placeholder="实验名称 *" />
                <div class="grid grid-cols-2 gap-3">
                  <select v-model="experimentForm.platform" class="field">
                    <option v-for="item in platformOptions" :key="item" :value="item">{{ item }}</option>
                  </select>
                  <input v-model="experimentForm.audience" class="field" placeholder="目标受众 *" />
                </div>
                <input v-model="experimentForm.topic" class="field" placeholder="题材方向 *" />
                <textarea v-model="experimentForm.promise" class="field min-h-24" placeholder="一句话卖点 *"></textarea>
                <textarea v-model="experimentForm.hypothesis" class="field min-h-24" placeholder="实验假设"></textarea>
                <input v-model="experimentForm.budget" class="field" type="number" min="0" step="0.01" placeholder="预算上限" />
                <button class="burning-orange-btn w-full py-3 text-sm font-semibold" type="submit" :disabled="saving">
                  {{ saving ? '创建中...' : '创建三集试制实验' }}
                </button>
              </div>
            </form>
          </section>
        </template>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.field {
  width: 100%;
  border: 1px solid rgb(74 70 62);
  background: rgb(18 18 16 / 0.8);
  padding: 0.7rem 0.8rem;
  color: rgb(245 239 229);
  outline: none;
  font-size: 0.875rem;
}

.field:focus {
  border-color: rgb(240 181 111);
  box-shadow: 0 0 0 1px rgb(240 181 111 / 0.2);
}

.field::placeholder {
  color: rgb(163 151 137);
}

select.field {
  appearance: auto;
}
</style>
