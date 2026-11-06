<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  evaluateSeasonStructure,
  evaluateStoryBible,
  getSeasonStructure,
  getStoryBible,
  lockSeasonStructure,
  lockStoryBible,
  saveSeasonStructure,
  saveStoryBible,
  type SeasonEpisodeDTO,
  type SeasonStructureDTO,
  type StoryBibleCharacterDTO,
  type StoryBibleDTO,
  type StoryQualityReportDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type TabKey = 'bible' | 'season'
type PageState = 'loading' | 'ready' | 'error'

const route = useRoute()
const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  return fromQuery > 0 ? fromQuery : getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const activeTab = ref<TabKey>('bible')
const errorMsg = ref('')
const infoMsg = ref('')
const saving = ref(false)
const evaluating = ref(false)
const locking = ref(false)
const bibleReport = ref<StoryQualityReportDTO | null>(null)
const seasonReport = ref<StoryQualityReportDTO | null>(null)
const bibleStatus = ref<'draft' | 'locked'>('draft')
const seasonStatus = ref<'draft' | 'locked'>('draft')

const bibleForm = ref({
  title: '',
  logline: '',
  audience: '',
  emotionalPromise: '',
  worldRules: '',
  timeline: '',
  locations: '',
  characters: '',
  relationships: '',
  props: '',
  mainPlot: '',
  subplots: '',
  foreshadowing: '',
  lockedFacts: '',
  flexibleFacts: '',
  visualSymbols: '',
})

const seasonForm = ref({
  seasonTheme: '',
  coreConflict: '',
  structureType: '三幕八集',
  episodeCount: 3,
  episodes: '',
  foreshadowingPlan: '',
  characterArcs: '',
})

const report = computed(() => (activeTab.value === 'bible' ? bibleReport.value : seasonReport.value))

function listToText(value: string[] | undefined | null): string {
  return Array.isArray(value) ? value.join('\n') : ''
}

function textToList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function defaultCharacter(): StoryBibleCharacterDTO {
  return {
    name: '',
    role: '',
    goal: '',
    fear: '',
    secret: '',
    growthArc: '',
    visualDescription: '',
  }
}

function defaultEpisode(episodeNo: number): SeasonEpisodeDTO {
  return {
    episodeNo,
    title: '',
    logline: '',
    openingHook: '',
    goal: '',
    coreConflict: '',
    irreversibleChange: '',
    endingHook: '',
    protagonistChoice: '',
    reversal: '',
    visualSetPieces: [],
  }
}

function applyBible(value: StoryBibleDTO | null): void {
  if (!value) return
  bibleStatus.value = value.status
  bibleForm.value = {
    title: value.title || '',
    logline: value.logline || '',
    audience: value.audience || '',
    emotionalPromise: value.emotionalPromise || '',
    worldRules: listToText(value.worldRules),
    timeline: listToText(value.timeline),
    locations: listToText(value.locations),
    characters: formatJson(value.characters || [defaultCharacter(), defaultCharacter()]),
    relationships: listToText(value.relationships),
    props: listToText(value.props),
    mainPlot: value.mainPlot || '',
    subplots: listToText(value.subplots),
    foreshadowing: listToText(value.foreshadowing),
    lockedFacts: listToText(value.lockedFacts),
    flexibleFacts: listToText(value.flexibleFacts),
    visualSymbols: listToText(value.visualSymbols),
  }
  bibleReport.value = value.qualityReport || null
}

function applySeason(value: SeasonStructureDTO | null): void {
  if (!value) return
  seasonStatus.value = value.status
  seasonForm.value = {
    seasonTheme: value.seasonTheme || '',
    coreConflict: value.coreConflict || '',
    structureType: value.structureType || '三幕八集',
    episodeCount: value.episodeCount || value.episodes.length || 3,
    episodes: formatJson(value.episodes || [defaultEpisode(1), defaultEpisode(2), defaultEpisode(3)]),
    foreshadowingPlan: listToText(value.foreshadowingPlan),
    characterArcs: listToText(value.characterArcs),
  }
  seasonReport.value = value.qualityReport || null
}

async function load(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'error'
    errorMsg.value = '缺少 projectId，请先从项目总览进入项目。'
    return
  }
  pageState.value = 'loading'
  errorMsg.value = ''
  try {
    setWorkspaceContext({ projectId: projectId.value })
    const [bible, season] = await Promise.all([
      getStoryBible(projectId.value),
      getSeasonStructure(projectId.value),
    ])
    applyBible(bible)
    applySeason(season)
    pageState.value = 'ready'
  } catch (error) {
    pageState.value = 'error'
    errorMsg.value = error instanceof Error ? error.message : '故事质量工作台加载失败'
  }
}

function buildBiblePayload() {
  return {
    title: bibleForm.value.title,
    logline: bibleForm.value.logline,
    audience: bibleForm.value.audience,
    emotionalPromise: bibleForm.value.emotionalPromise,
    worldRules: textToList(bibleForm.value.worldRules),
    timeline: textToList(bibleForm.value.timeline),
    locations: textToList(bibleForm.value.locations),
    characters: parseJson<StoryBibleCharacterDTO[]>(bibleForm.value.characters, []),
    relationships: textToList(bibleForm.value.relationships),
    props: textToList(bibleForm.value.props),
    mainPlot: bibleForm.value.mainPlot,
    subplots: textToList(bibleForm.value.subplots),
    foreshadowing: textToList(bibleForm.value.foreshadowing),
    lockedFacts: textToList(bibleForm.value.lockedFacts),
    flexibleFacts: textToList(bibleForm.value.flexibleFacts),
    visualSymbols: textToList(bibleForm.value.visualSymbols),
  }
}

function buildSeasonPayload() {
  return {
    seasonTheme: seasonForm.value.seasonTheme,
    coreConflict: seasonForm.value.coreConflict,
    structureType: seasonForm.value.structureType,
    episodeCount: Number(seasonForm.value.episodeCount) || 0,
    episodes: parseJson<SeasonEpisodeDTO[]>(seasonForm.value.episodes, []),
    foreshadowingPlan: textToList(seasonForm.value.foreshadowingPlan),
    characterArcs: textToList(seasonForm.value.characterArcs),
  }
}

function showSuccess(message: string): void {
  errorMsg.value = ''
  infoMsg.value = message
}

async function saveDraft(): Promise<void> {
  if (!projectId.value || saving.value) return
  saving.value = true
  try {
    const result =
      activeTab.value === 'bible'
        ? await saveStoryBible(projectId.value, buildBiblePayload())
        : await saveSeasonStructure(projectId.value, buildSeasonPayload())
    if (activeTab.value === 'bible') bibleStatus.value = result.item.status
    else seasonStatus.value = result.item.status
    if (activeTab.value === 'bible') bibleReport.value = result.report
    else seasonReport.value = result.report
    showSuccess(activeTab.value === 'bible' ? '故事圣经草稿已保存。' : '整季结构草稿已保存。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function evaluate(): Promise<void> {
  if (!projectId.value || evaluating.value) return
  evaluating.value = true
  try {
    const result =
      activeTab.value === 'bible'
        ? await evaluateStoryBible(projectId.value, buildBiblePayload())
        : await evaluateSeasonStructure(projectId.value, buildSeasonPayload())
    if (activeTab.value === 'bible') bibleReport.value = result.report
    else seasonReport.value = result.report
    showSuccess('质量评估完成，已更新门禁结果。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '质量评估失败'
  } finally {
    evaluating.value = false
  }
}

async function lock(): Promise<void> {
  if (!projectId.value || locking.value) return
  locking.value = true
  try {
    const result =
      activeTab.value === 'bible'
        ? await lockStoryBible(projectId.value, buildBiblePayload())
        : await lockSeasonStructure(projectId.value, buildSeasonPayload())
    if (activeTab.value === 'bible') bibleReport.value = result.report
    else seasonReport.value = result.report
    if (activeTab.value === 'bible') bibleStatus.value = result.item.status
    else seasonStatus.value = result.item.status
    showSuccess('版本已锁定，后续 Agent 只能基于此版本继续生产。')
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '锁定失败，请先修复质量门禁问题'
  } finally {
    locking.value = false
  }
}

function switchTab(tab: TabKey): void {
  activeTab.value = tab
  infoMsg.value = ''
  errorMsg.value = ''
}

const activeStatus = computed(() => (activeTab.value === 'bible' ? bibleStatus.value : seasonStatus.value))
const reportTone = computed(() => {
  if (!report.value) return 'border-outline-variant bg-surface-container'
  return report.value.canLock
    ? 'border-emerald-500/50 bg-emerald-500/10'
    : 'border-red-500/50 bg-red-500/10'
})

watch(projectId, () => {
  void load()
})

onMounted(() => {
  void load()
})
</script>

<template>
  <WorkspaceLayout :show-inspector="false" :no-padding="true" :self-managed-scroll="true">
    <div class="flex h-full min-h-0 flex-col bg-surface-dim">
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-outline-variant bg-surface-container-lowest px-6 py-5">
        <div>
          <p class="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-primary">Story Quality Gate</p>
          <h1 class="font-headline-lg text-headline-lg text-on-surface">故事圣经与整季结构</h1>
          <p class="mt-1 text-sm text-on-surface-variant">先锁定事实和节奏，再允许进入分集剧本、画面和音频生产。</p>
        </div>
        <div class="flex items-center gap-2">
          <span
            class="border px-3 py-1 text-xs font-bold uppercase tracking-widest"
            :class="activeStatus === 'locked' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' : 'border-amber-500/50 bg-amber-500/10 text-amber-300'"
          >
            {{ activeStatus === 'locked' ? '已锁定' : '草稿版本' }}
          </span>
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
            :disabled="saving"
            @click="saveDraft"
          >
            {{ saving ? '保存中...' : '保存草稿' }}
          </button>
          <button
            type="button"
            class="border border-primary/60 bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
            :disabled="evaluating"
            @click="evaluate"
          >
            {{ evaluating ? '评估中...' : '质量评估' }}
          </button>
          <button
            type="button"
            class="burning-orange-btn px-4 py-2 text-xs font-bold uppercase tracking-widest disabled:opacity-50"
            :disabled="locking"
            @click="lock"
          >
            {{ locking ? '锁定中...' : '锁定版本' }}
          </button>
        </div>
      </div>

      <div v-if="pageState === 'loading'" class="flex flex-1 items-center justify-center text-sm text-on-surface-variant">
        正在加载故事质量工作台...
      </div>

      <div v-else-if="pageState === 'error'" class="flex flex-1 items-center justify-center p-8">
        <div class="max-w-xl border border-red-500/40 bg-red-500/10 p-8 text-center text-red-300">
          {{ errorMsg }}
          <button type="button" class="mt-5 border border-red-300/50 px-4 py-2 text-xs font-bold" @click="load">重试</button>
        </div>
      </div>

      <div v-else class="min-h-0 flex-1 overflow-y-auto p-6 lg:p-8">
        <div v-if="infoMsg" class="mb-4 border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {{ infoMsg }}
        </div>
        <div v-if="errorMsg" class="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {{ errorMsg }}
        </div>

        <div class="mb-6 flex gap-1 border-b border-outline-variant">
          <button
            type="button"
            class="border-b-2 px-4 py-3 text-sm font-bold"
            :class="activeTab === 'bible' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'"
            @click="switchTab('bible')"
          >
            故事圣经
          </button>
          <button
            type="button"
            class="border-b-2 px-4 py-3 text-sm font-bold"
            :class="activeTab === 'season' ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'"
            @click="switchTab('season')"
          >
            整季结构
          </button>
        </div>

        <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section class="space-y-5">
            <template v-if="activeTab === 'bible'">
              <div class="grid gap-5 md:grid-cols-2">
                <label class="field-group">
                  <span>故事标题</span>
                  <input v-model="bibleForm.title" class="field" placeholder="例如：雨夜回声" />
                </label>
                <label class="field-group">
                  <span>目标受众</span>
                  <input v-model="bibleForm.audience" class="field" placeholder="题材、年龄和情绪偏好" />
                </label>
              </div>
              <label class="field-group">
                <span>一句话卖点</span>
                <textarea v-model="bibleForm.logline" class="field min-h-24" placeholder="主角、目标、阻力和代价"></textarea>
              </label>
              <label class="field-group">
                <span>情绪承诺</span>
                <textarea v-model="bibleForm.emotionalPromise" class="field min-h-20" placeholder="观众每集应获得什么情绪体验"></textarea>
              </label>
              <div class="grid gap-5 md:grid-cols-2">
                <label class="field-group"><span>世界观规则</span><textarea v-model="bibleForm.worldRules" class="field min-h-28" placeholder="一行一条"></textarea></label>
                <label class="field-group"><span>时间线</span><textarea v-model="bibleForm.timeline" class="field min-h-28" placeholder="一行一条"></textarea></label>
                <label class="field-group"><span>地点与空间</span><textarea v-model="bibleForm.locations" class="field min-h-28" placeholder="一行一处"></textarea></label>
                <label class="field-group"><span>人物关系</span><textarea v-model="bibleForm.relationships" class="field min-h-28" placeholder="一行一条"></textarea></label>
              </div>
              <label class="field-group">
                <span>人物档案 JSON</span>
                <textarea v-model="bibleForm.characters" class="field min-h-64 font-mono text-xs" placeholder="至少包含主角和反派，每个人物填写目标、恐惧、秘密、成长弧和视觉描述"></textarea>
              </label>
              <div class="grid gap-5 md:grid-cols-2">
                <label class="field-group"><span>主线</span><textarea v-model="bibleForm.mainPlot" class="field min-h-28"></textarea></label>
                <label class="field-group"><span>支线</span><textarea v-model="bibleForm.subplots" class="field min-h-28" placeholder="一行一条"></textarea></label>
                <label class="field-group"><span>伏笔与回收</span><textarea v-model="bibleForm.foreshadowing" class="field min-h-28" placeholder="一行一条"></textarea></label>
                <label class="field-group"><span>关键道具</span><textarea v-model="bibleForm.props" class="field min-h-28" placeholder="一行一件"></textarea></label>
                <label class="field-group"><span>禁止改变的事实</span><textarea v-model="bibleForm.lockedFacts" class="field min-h-28" placeholder="一行一条"></textarea></label>
                <label class="field-group"><span>可调整设定</span><textarea v-model="bibleForm.flexibleFacts" class="field min-h-28" placeholder="一行一条"></textarea></label>
              </div>
              <label class="field-group"><span>视觉符号</span><textarea v-model="bibleForm.visualSymbols" class="field min-h-20" placeholder="一行一个"></textarea></label>
            </template>

            <template v-else>
              <div class="grid gap-5 md:grid-cols-2">
                <label class="field-group"><span>季主题</span><input v-model="seasonForm.seasonTheme" class="field" placeholder="例如：真相的代价" /></label>
                <label class="field-group"><span>结构类型</span><input v-model="seasonForm.structureType" class="field" placeholder="例如：三幕八集" /></label>
              </div>
              <label class="field-group"><span>整季主线冲突</span><textarea v-model="seasonForm.coreConflict" class="field min-h-24"></textarea></label>
              <div class="grid gap-5 md:grid-cols-[180px_minmax(0,1fr)]">
                <label class="field-group"><span>计划集数</span><input v-model.number="seasonForm.episodeCount" type="number" min="1" max="100" class="field" /></label>
                <label class="field-group"><span>伏笔回收计划</span><textarea v-model="seasonForm.foreshadowingPlan" class="field min-h-24" placeholder="一行一条"></textarea></label>
              </div>
              <label class="field-group"><span>人物阶段性变化</span><textarea v-model="seasonForm.characterArcs" class="field min-h-24" placeholder="一行一条"></textarea></label>
              <label class="field-group">
                <span>分集结构 JSON</span>
                <textarea v-model="seasonForm.episodes" class="field min-h-[520px] font-mono text-xs" placeholder="每集必须包含开场钩子、目标、冲突、不可逆变化、结尾钩子和主角主动选择"></textarea>
              </label>
            </template>
          </section>

          <aside class="h-fit border border-outline-variant bg-surface-container-low p-5 xl:sticky xl:top-0">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <p class="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">Quality Report</p>
                <h2 class="mt-1 text-lg font-bold text-on-surface">质量门禁</h2>
              </div>
              <div v-if="report" class="text-right">
                <div class="text-3xl font-bold" :class="report.canLock ? 'text-emerald-400' : 'text-red-400'">{{ report.score }}</div>
                <div class="text-[10px] uppercase tracking-widest text-on-surface-variant">/ {{ report.threshold }}</div>
              </div>
            </div>
            <div class="mb-5 border px-4 py-3 text-sm" :class="reportTone">
              <template v-if="!report">先点击“质量评估”，再决定是否锁定。</template>
              <template v-else-if="report.canLock">已满足当前锁定门槛，可以进入下一阶段。</template>
              <template v-else>存在硬阻塞项，不能把当前版本交给生产 Agent。</template>
            </div>
            <template v-if="report">
              <div class="mb-5">
                <h3 class="mb-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant">评分维度</h3>
                <div class="space-y-2">
                  <div v-for="dimension in report.dimensions" :key="dimension.key" class="flex items-center justify-between border-b border-outline-variant/60 py-2 text-sm">
                    <span class="text-on-surface-variant">{{ dimension.label }}</span>
                    <span class="font-mono font-bold text-on-surface">{{ dimension.score }}/{{ dimension.weight }}</span>
                  </div>
                </div>
              </div>
              <div v-if="report.marketQuality" class="mb-5 border border-primary/30 bg-primary/5 p-4">
                <div class="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-xs font-bold uppercase tracking-widest text-primary">市场爆款结构代理</h3>
                    <p class="mt-1 text-xs leading-5 text-on-surface-variant">
                      这是内容结构门禁，不是爆款承诺；它只检查钩子、冲突、主动选择、反转和追更理由。
                    </p>
                  </div>
                  <div class="text-right">
                    <div class="font-mono text-xl font-bold" :class="report.marketQuality.canPass ? 'text-emerald-400' : 'text-red-300'">
                      {{ report.marketQuality.score }}
                    </div>
                    <div class="text-[10px] text-on-surface-variant">/ {{ report.marketQuality.threshold }}</div>
                  </div>
                </div>
                <div class="mb-3 grid grid-cols-3 gap-2 text-center text-xs">
                  <div class="border border-outline-variant/70 px-2 py-2">
                    <strong class="block text-on-surface">{{ report.marketQuality.coverage.episodeCount }}</strong>
                    <span class="text-on-surface-variant">集数</span>
                  </div>
                  <div class="border border-outline-variant/70 px-2 py-2">
                    <strong class="block text-on-surface">{{ report.marketQuality.coverage.reversalCount }}</strong>
                    <span class="text-on-surface-variant">反转覆盖</span>
                  </div>
                  <div class="border border-outline-variant/70 px-2 py-2">
                    <strong class="block text-on-surface">{{ report.marketQuality.coverage.endingHookCount }}</strong>
                    <span class="text-on-surface-variant">结尾钩子</span>
                  </div>
                </div>
                <div class="space-y-2">
                  <div v-for="dimension in report.marketQuality.dimensions" :key="dimension.key" class="flex items-center justify-between text-xs">
                    <span class="text-on-surface-variant">{{ dimension.label }}</span>
                    <span class="font-mono text-on-surface">{{ dimension.score }}/{{ dimension.weight }}</span>
                  </div>
                </div>
              </div>
              <div v-if="report.blockers.length" class="mb-5">
                <h3 class="mb-2 text-xs font-bold uppercase tracking-widest text-red-300">硬阻塞 {{ report.blockers.length }}</h3>
                <ul class="space-y-2 text-sm text-red-200">
                  <li v-for="item in report.blockers" :key="`${item.field}-${item.message}`">· {{ item.message }} <span class="font-mono text-[10px] text-red-300/70">{{ item.field }}</span></li>
                </ul>
              </div>
              <div v-if="report.warnings.length">
                <h3 class="mb-2 text-xs font-bold uppercase tracking-widest text-amber-300">改进建议 {{ report.warnings.length }}</h3>
                <ul class="space-y-2 text-sm text-amber-100/80">
                  <li v-for="item in report.warnings" :key="`${item.field}-${item.message}`">· {{ item.message }}</li>
                </ul>
              </div>
            </template>
          </aside>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.field-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.field-group > span {
  color: rgb(177 183 177);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field {
  width: 100%;
  border: 1px solid rgb(72 78 72);
  background: rgb(27 31 27);
  color: rgb(238 241 236);
  padding: 0.75rem 0.875rem;
  outline: none;
  resize: vertical;
}

.field:focus {
  border-color: rgb(221 111 52);
  box-shadow: 0 0 0 1px rgb(221 111 52 / 0.35);
}
</style>
