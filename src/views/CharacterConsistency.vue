<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getProjectCharacterConsistency,
  saveProjectCharacterConsistencyReport,
  setCharacterLock,
  type CharacterConsistencyReportDTO,
  type CharacterDTO,
  type CharacterRegressionSampleDTO,
  type CharacterVersionDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => Number(route.query.projectId) || 0)

const loading = ref(false)
const saving = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')
const report = ref<CharacterConsistencyReportDTO | null>(null)
const characters = ref<CharacterDTO[]>([])
const versions = ref<CharacterVersionDTO[]>([])
const samples = ref<CharacterRegressionSampleDTO[]>([])

const currentVersions = computed(() => {
  const map = new Map<number, CharacterVersionDTO>()
  for (const version of versions.value) {
    if (!map.has(version.characterId)) map.set(version.characterId, version)
  }
  return map
})

const staleSamples = computed(() => report.value?.samples.stale || [])
const readyPercent = computed(() => {
  const total = report.value?.summary.totalCharacters || 0
  return total ? Math.round(((report.value?.summary.readyCharacters || 0) / total) * 100) : 0
})

function characterReport(characterId: number) {
  return report.value?.characters.find((item) => item.characterId === characterId) || null
}

function characterName(characterId: number) {
  return characters.value.find((item) => item.id === characterId)?.name || `角色 #${characterId}`
}

function openCharacter(characterId: number) {
  router.push({
    path: '/workspace/character/detail',
    query: { projectId: String(projectId.value), characterId: String(characterId) },
  })
}

async function load(): Promise<void> {
  if (!projectId.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const result = await getProjectCharacterConsistency(projectId.value)
    report.value = result.report
    characters.value = result.characters
    versions.value = result.versions
    samples.value = result.samples
    setWorkspaceContext({ projectId: projectId.value })
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '角色一致性报告加载失败'
  } finally {
    loading.value = false
  }
}

async function saveReport(): Promise<void> {
  if (!projectId.value || saving.value) return
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await saveProjectCharacterConsistencyReport(projectId.value)
    report.value = result.report
    infoMsg.value = '一致性报告已保存，可作为本轮生产验收记录'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '一致性报告保存失败'
  } finally {
    saving.value = false
  }
}

async function toggleLock(
  character: CharacterDTO,
  group: 'appearance' | 'costume',
): Promise<void> {
  const locked = group === 'appearance' ? character.appearanceLocked : character.costumeLocked
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await setCharacterLock(character.id, group, !locked)
    const index = characters.value.findIndex((item) => item.id === character.id)
    if (index >= 0) characters.value[index] = result.character
    infoMsg.value = `${character.name}的${group === 'appearance' ? '外貌' : '服装'}状态已更新`
    await load()
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '锁定状态更新失败'
  }
}

watch(projectId, () => void load())
onMounted(() => void load())
</script>

<template>
  <WorkspaceLayout
    :show-side="true"
    :show-inspector="false"
    :no-padding="true"
    :self-managed-scroll="true"
  >
    <div class="consistency-page flex h-full min-h-0 flex-col bg-background">
      <header class="consistency-header flex flex-wrap items-center justify-between gap-4 border-b border-outline-variant bg-surface-container-lowest px-margin-md py-4">
        <div>
          <div class="consistency-breadcrumb flex items-center gap-2 text-xs text-on-surface-variant">
            <span>角色库</span>
            <span class="material-symbols-outlined text-xs">chevron_right</span>
            <span class="text-primary">一致性工作台</span>
          </div>
          <h1 class="consistency-title mt-2 font-headline-lg text-on-surface">角色资产与版本基线</h1>
          <p class="mt-1 text-sm text-on-surface-variant">静帧、视频和对白音频都必须沿用这里的生产基线。</p>
        </div>
        <div class="consistency-header-actions flex items-center gap-2">
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
            :disabled="loading"
            @click="load"
          >
            <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': loading }">
              {{ loading ? 'progress_activity' : 'refresh' }}
            </span>
            刷新
          </button>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
            :disabled="saving || !report"
            @click="saveReport"
          >
            <span class="material-symbols-outlined text-sm">fact_check</span>
            {{ saving ? '保存中' : '保存报告' }}
          </button>
        </div>
      </header>

      <div class="consistency-content custom-scrollbar scroll-optimized min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain p-margin-md">
        <div v-if="errorMsg" class="mb-4 flex items-center gap-3 border border-danger-red/40 bg-danger-red/5 px-4 py-3 text-sm text-on-surface" role="alert">
          <span class="material-symbols-outlined text-danger-red">error</span>
          <span>{{ errorMsg }}</span>
        </div>
        <div v-if="infoMsg" class="mb-4 flex items-center gap-3 border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-on-surface" role="status">
          <span class="material-symbols-outlined text-primary">check_circle</span>
          <span>{{ infoMsg }}</span>
        </div>

        <div v-if="loading && !report" class="flex h-64 items-center justify-center text-on-surface-variant">
          <span class="material-symbols-outlined mr-2 animate-spin">progress_activity</span>
          正在检查角色生产基线…
        </div>

        <template v-else-if="report">
          <section class="consistency-summary mb-6 grid grid-cols-1 gap-3 md:grid-cols-4" aria-label="一致性摘要">
            <div class="consistency-summary-card bg-surface-container p-5">
              <div class="consistency-label text-xs text-on-surface-variant">生产状态</div>
              <div class="mt-3 flex items-center gap-2 text-xl font-semibold" :class="report.ready ? 'text-emerald-300' : 'text-amber-300'">
                <span class="material-symbols-outlined">{{ report.ready ? 'verified' : 'warning' }}</span>
                {{ report.ready ? '可进入生产' : '存在阻塞项' }}
              </div>
            </div>
            <div class="consistency-summary-card bg-surface-container p-5">
              <div class="consistency-label text-xs text-on-surface-variant">角色准备度</div>
              <div class="mt-3 text-xl font-semibold text-on-surface">{{ report.summary.readyCharacters }} / {{ report.summary.totalCharacters }}</div>
              <div class="mt-2 h-1 bg-surface-container-lowest">
                <div class="h-full bg-primary transition-all" :style="{ width: `${readyPercent}%` }"></div>
              </div>
            </div>
            <div class="consistency-summary-card bg-surface-container p-5">
              <div class="consistency-label text-xs text-on-surface-variant">阻塞项</div>
              <div class="mt-3 text-xl font-semibold text-amber-300">{{ report.blockers.length }}</div>
            </div>
            <div class="consistency-summary-card bg-surface-container p-5">
              <div class="consistency-label text-xs text-on-surface-variant">过期样例</div>
              <div class="mt-3 text-xl font-semibold" :class="staleSamples.length ? 'text-amber-300' : 'text-emerald-300'">{{ staleSamples.length }}</div>
            </div>
          </section>

          <section class="consistency-panel border border-outline-variant bg-surface-container">
            <div class="consistency-panel-head flex items-center justify-between border-b border-outline-variant px-5 py-4">
              <div>
                <h2 class="font-headline-md text-primary">角色基线</h2>
                <p class="mt-1 text-xs text-on-surface-variant">锁定后修改外貌、服装或音色会自动创建新版本，旧资产不会被覆盖。</p>
              </div>
              <span class="consistency-meta-label">VERSION HISTORY</span>
            </div>
            <div class="divide-y divide-outline-variant">
              <article v-for="character in characters" :key="character.id" class="consistency-character-card p-5">
                <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <button type="button" class="text-left text-lg font-semibold text-on-surface hover:text-primary" @click="openCharacter(character.id)">
                        {{ character.name }}
                      </button>
                      <span class="consistency-version border border-outline-variant px-2 py-1 text-xs text-on-surface-variant">v{{ currentVersions.get(character.id)?.versionNo || '-' }}</span>
                      <span v-if="character.roleTag" class="consistency-role text-xs text-on-surface-variant">{{ character.roleTag }}</span>
                    </div>
                    <div class="mt-3 grid grid-cols-1 gap-2 text-xs text-on-surface-variant md:grid-cols-3">
                      <span :class="character.appearanceLocked ? 'text-emerald-300' : 'text-amber-300'">
                        <span class="material-symbols-outlined mr-1 align-middle text-sm">{{ character.appearanceLocked ? 'lock' : 'lock_open' }}</span>
                        外貌 {{ character.appearanceLocked ? '已锁定' : '待锁定' }}
                      </span>
                      <span :class="character.costumeLocked ? 'text-emerald-300' : 'text-amber-300'">
                        <span class="material-symbols-outlined mr-1 align-middle text-sm">{{ character.costumeLocked ? 'lock' : 'lock_open' }}</span>
                        服装 {{ character.costumeLocked ? '已锁定' : '待锁定' }}
                      </span>
                      <span :class="character.voiceLocked ? 'text-emerald-300' : 'text-amber-300'">
                        <span class="material-symbols-outlined mr-1 align-middle text-sm">{{ character.voiceLocked ? 'lock' : 'lock_open' }}</span>
                        音色 {{ character.voiceLocked ? '已锁定' : '待锁定' }}
                      </span>
                    </div>
                    <div v-if="characterReport(character.id)" class="consistency-issues mt-4 space-y-1">
                      <p v-for="item in characterReport(character.id)?.blockers" :key="item.code" class="consistency-issue consistency-issue--blocker text-xs text-amber-300">
                        <span class="material-symbols-outlined text-sm" aria-hidden="true">priority_high</span>
                        {{ item.message }}
                      </p>
                      <p v-for="item in characterReport(character.id)?.warnings" :key="item.code" class="consistency-issue consistency-issue--warning text-xs text-on-surface-variant">
                        <span class="material-symbols-outlined text-sm" aria-hidden="true">info</span>
                        {{ item.message }}
                      </p>
                    </div>
                  </div>
                  <div class="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      class="border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
                      @click="toggleLock(character, 'appearance')"
                    >
                      {{ character.appearanceLocked ? '解锁外貌' : '锁定外貌' }}
                    </button>
                    <button
                      type="button"
                      class="border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
                      @click="toggleLock(character, 'costume')"
                    >
                      {{ character.costumeLocked ? '解锁服装' : '锁定服装' }}
                    </button>
                    <button
                      type="button"
                      class="bg-primary/10 px-3 py-1.5 text-xs text-primary hover:bg-primary/20"
                      @click="openCharacter(character.id)"
                    >
                      打开角色
                    </button>
                  </div>
                </div>
              </article>
              <div v-if="!characters.length" class="p-8 text-center text-sm text-on-surface-variant">当前项目还没有角色。</div>
            </div>
          </section>

          <section class="consistency-panel mt-6 border border-outline-variant bg-surface-container">
            <div class="border-b border-outline-variant px-5 py-4">
              <h2 class="font-headline-md text-primary">回归样例</h2>
              <p class="mt-1 text-xs text-on-surface-variant">角色版本升级后，旧样例必须重新确认，避免把历史人物外貌带入新生产。</p>
            </div>
            <div v-if="staleSamples.length" class="divide-y divide-outline-variant">
              <div v-for="sample in staleSamples" :key="sample.id" class="flex flex-col gap-2 px-5 py-4 text-sm md:flex-row md:items-center md:justify-between">
                <div>
                  <div class="text-on-surface">{{ characterName(sample.characterId) }} · {{ sample.sampleType }}</div>
                  <div class="mt-1 text-xs text-amber-300">样例 v{{ sample.versionNo }}，当前基线 v{{ report.characters.find((item) => item.characterId === sample.characterId)?.latestVersionNo }}</div>
                </div>
                <a class="text-xs text-primary hover:underline" :href="sample.assetUrl" target="_blank" rel="noreferrer">查看样例</a>
              </div>
            </div>
            <div v-else class="px-5 py-6 text-sm text-emerald-300">暂无过期回归样例。</div>
          </section>
        </template>
      </div>
  </div>
</WorkspaceLayout>
</template>

<style scoped>
.consistency-page {
  min-width: 0;
}

.consistency-header {
  position: relative;
  z-index: 2;
  background:
    linear-gradient(110deg, rgba(255, 183, 125, 0.055), transparent 38%),
    #0d0f0d;
}

.consistency-breadcrumb,
.consistency-label,
.consistency-meta-label {
  letter-spacing: 0.12em;
}

.consistency-breadcrumb {
  font-size: 0.7rem;
  font-weight: 600;
}

.consistency-title {
  font-size: clamp(1.55rem, 2.2vw, 2.35rem);
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.consistency-content {
  background:
    radial-gradient(circle at 88% 0%, rgba(164, 132, 84, 0.08), transparent 28rem),
    #121412;
}

.consistency-summary-card,
.consistency-panel {
  border-color: rgba(164, 132, 84, 0.3);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
}

.consistency-summary-card {
  min-height: 8.5rem;
  background: linear-gradient(145deg, rgba(255, 183, 125, 0.035), transparent 52%), #1a1c1a;
}

.consistency-label,
.consistency-meta-label {
  color: #a99685;
  font-size: 0.66rem;
  font-weight: 700;
  text-transform: uppercase;
}

.consistency-panel-head {
  background: rgba(13, 15, 13, 0.46);
}

.consistency-meta-label {
  color: #88796c;
  font-size: 0.58rem;
}

.consistency-character-card {
  background: rgba(26, 28, 26, 0.68);
  transition: background-color 220ms var(--pd-ease);
}

.consistency-character-card:hover {
  background: rgba(34, 36, 33, 0.82);
}

.consistency-version {
  border-color: rgba(164, 132, 84, 0.42);
  background: rgba(255, 255, 255, 0.025);
}

.consistency-role {
  max-width: 32rem;
}

.consistency-issues {
  display: grid;
  gap: 0.4rem;
  max-width: 56rem;
}

.consistency-issue {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  line-height: 1.5;
}

.consistency-issue .material-symbols-outlined {
  flex: 0 0 auto;
  margin-top: 0.1rem;
}

.consistency-issue--blocker {
  color: #f2bf56;
}

.consistency-issue--warning {
  color: #b7aa9c;
}

@media (max-width: 639px) {
  .consistency-content {
    padding: 1rem;
  }

  .consistency-header-actions {
    width: 100%;
  }

  .consistency-header-actions > button {
    flex: 1 1 0;
    justify-content: center;
  }
}
</style>
