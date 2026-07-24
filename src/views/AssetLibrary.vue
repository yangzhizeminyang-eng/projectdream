<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  getProject,
  getProjectAssets,
  type ProjectAssetItemDTO,
  type ProjectAssetsDTO,
  type ProjectDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type PageState = 'missing-project' | 'loading' | 'empty' | 'error' | 'ready'
type ViewMode = 'grid' | 'list'
type SortKey = 'newest' | 'oldest' | 'name'
type TypeFilter = 'all' | 'character' | 'image' | 'video' | 'audio'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const pageState = ref<PageState>('loading')
const project = ref<ProjectDTO | null>(null)
const payload = ref<ProjectAssetsDTO | null>(null)
const errorMsg = ref('')
const searchKeyword = ref('')
const viewMode = ref<ViewMode>('grid')
const sortKey = ref<SortKey>('newest')
const activeType = ref<TypeFilter>('all')
const activeStatus = ref('all')

const summary = computed(() => payload.value?.summary || null)
const allItems = computed<ProjectAssetItemDTO[]>(() => payload.value?.items || [])

const statusOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const item of allItems.value) {
    counts.set(item.status, (counts.get(item.status) || 0) + 1)
  }

  return [
    { key: 'all', label: '全部状态', count: allItems.value.length },
    ...Array.from(counts.entries()).map(([key, count]) => ({
      key,
      label: statusLabel(key),
      count,
    })),
  ]
})

const typeOptions = computed(() => [
  { key: 'all' as const, label: '全部资产', count: allItems.value.length },
  { key: 'character' as const, label: '角色', count: summary.value?.characterCount || 0 },
  { key: 'image' as const, label: '静帧', count: summary.value?.imageCount || 0 },
  { key: 'video' as const, label: '视频', count: summary.value?.videoCount || 0 },
  { key: 'audio' as const, label: '音频', count: summary.value?.audioCount || 0 },
])

const filteredItems = computed<ProjectAssetItemDTO[]>(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()

  const items = allItems.value.filter((item) => {
    if (activeType.value !== 'all' && item.assetType !== activeType.value) return false
    if (activeStatus.value !== 'all' && item.status !== activeStatus.value) return false
    if (!keyword) return true

    const haystack = [
      item.name,
      item.subtitle,
      item.sceneTitle,
      item.shotNo,
      item.assetType,
      item.status,
      item.trackType,
      item.characterName,
      item.voiceName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(keyword)
  })

  return [...items].sort((a, b) => {
    if (sortKey.value === 'name') {
      return a.name.localeCompare(b.name, 'zh-CN')
    }

    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime()
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime()
    return sortKey.value === 'oldest' ? aTime - bTime : bTime - aTime
  })
})

const sortLabel = computed(() => {
  if (sortKey.value === 'newest') return '最新'
  if (sortKey.value === 'oldest') return '最早'
  return '名称'
})

const viewModeLabel = computed(() => (viewMode.value === 'grid' ? '切到列表' : '切到网格'))

function assetTypeLabel(type: ProjectAssetItemDTO['assetType']): string {
  if (type === 'character') return '角色'
  if (type === 'image') return '静帧'
  if (type === 'video') return '视频'
  return '音频'
}

function typeBadgeClass(type: ProjectAssetItemDTO['assetType']): string {
  if (type === 'character') {
    return 'border-sky-400/30 bg-sky-400/10 text-sky-200'
  }
  if (type === 'image') {
    return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  }
  if (type === 'video') {
    return 'border-rose-400/30 bg-rose-400/10 text-rose-200'
  }
  return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
}

function statusLabel(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'candidate') return '候选'
  if (status === 'archived') return '已归档'
  if (status === 'draft') return '草稿'
  if (status === 'finalized') return '已定稿'
  if (status === 'done') return '已完成'
  return status || '未知'
}

function statusClass(status: string): string {
  if (status === 'confirmed' || status === 'finalized' || status === 'done') {
    return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
  }
  if (status === 'candidate' || status === 'draft') {
    return 'border-amber-400/30 bg-amber-400/10 text-amber-200'
  }
  if (status === 'archived') {
    return 'border-slate-400/30 bg-slate-400/10 text-slate-200'
  }
  return 'border-outline-variant bg-white/5 text-on-surface-variant'
}

function filterButtonClass(active: boolean): string {
  return active
    ? 'border-primary/60 bg-primary/12 text-primary shadow-[0_0_0_1px_rgba(240,181,111,0.12)]'
    : 'border-outline-variant bg-black/15 text-on-surface hover:border-primary/40 hover:bg-white/5'
}

function formatUpdated(item: ProjectAssetItemDTO): string {
  const value = item.updatedAt || item.createdAt
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

function trackLabel(trackType?: string | null): string {
  if (trackType === 'dialogue') return '对白'
  if (trackType === 'narration') return '旁白'
  if (trackType === 'music') return '音乐'
  if (trackType === 'sfx') return '音效'
  return '音频'
}

function durationLabel(seconds?: number | null): string {
  if (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0) return '时长未设置'
  return `${Number(seconds)}s`
}

function sourceLabel(item: ProjectAssetItemDTO): string {
  if (item.assetType === 'character') return '项目级角色资产'

  if (item.assetType === 'audio') {
    const parts: string[] = [trackLabel(item.trackType)]
    if (item.sceneNo) parts.push(`Scene ${String(item.sceneNo).padStart(2, '0')}`)
    else parts.push('项目级')
    if (item.characterName) parts.push(item.characterName)
    if (item.versionNo) parts.push(`V${item.versionNo}`)
    return parts.join(' / ')
  }

  const parts: string[] = []
  if (item.sceneNo) parts.push(`Scene ${String(item.sceneNo).padStart(2, '0')}`)
  if (item.shotNo) parts.push(item.shotNo)
  if (item.versionNo) parts.push(`V${item.versionNo}`)
  return parts.join(' / ') || '来源信息待补全'
}

function detailChips(item: ProjectAssetItemDTO): string[] {
  const chips: string[] = [sourceLabel(item)]
  if (item.sceneTitle) chips.push(item.sceneTitle)
  if (item.assetType === 'audio' && item.voiceName) chips.push(`音色：${item.voiceName}`)
  if (item.assetType === 'audio' && item.durationSeconds) chips.push(`时长：${durationLabel(item.durationSeconds)}`)
  return chips
}

function mediaIconName(item: ProjectAssetItemDTO): string {
  if (item.assetType === 'character') return 'person'
  if (item.assetType === 'image') return 'image'
  if (item.assetType === 'video') return 'videocam'
  return 'graphic_eq'
}

function toggleSort(): void {
  sortKey.value =
    sortKey.value === 'newest' ? 'oldest' : sortKey.value === 'oldest' ? 'name' : 'newest'
}

function toggleViewMode(): void {
  viewMode.value = viewMode.value === 'grid' ? 'list' : 'grid'
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goScenes(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }

  router.push({
    path: '/workspace/scenes',
    query: { projectId: String(projectId.value) },
  })
}

function openAsset(item: ProjectAssetItemDTO): void {
  if (!projectId.value) return

  if (item.assetType === 'character' && item.characterId) {
    router.push({
      path: '/workspace/character/detail',
      query: {
        projectId: String(projectId.value),
        characterId: String(item.characterId),
      },
    })
    return
  }

  if (item.assetType === 'image' && item.sceneId && item.storyboardId) {
    router.push({
      path: '/workspace/frame/result',
      query: {
        projectId: String(projectId.value),
        sceneId: String(item.sceneId),
        storyboardId: String(item.storyboardId),
      },
    })
    return
  }

  if (item.assetType === 'video' && item.sceneId && item.storyboardId) {
    router.push({
      path: '/workspace/video',
      query: {
        projectId: String(projectId.value),
        sceneId: String(item.sceneId),
        storyboardId: String(item.storyboardId),
      },
    })
    return
  }

  if (item.assetType === 'audio') {
    router.push({
      path: '/workspace/audio',
      query: {
        projectId: String(projectId.value),
        ...(item.sceneId ? { sceneId: String(item.sceneId) } : {}),
      },
    })
    return
  }

  goScenes()
}

async function loadAssets(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    project.value = null
    payload.value = null
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''

  try {
    setWorkspaceContext({ projectId: projectId.value })
    const [projectData, result] = await Promise.all([
      getProject(projectId.value),
      getProjectAssets(projectId.value),
    ])

    project.value = projectData
    payload.value = result
    pageState.value = result.items.length ? 'ready' : 'empty'
  } catch (error) {
    project.value = null
    payload.value = null
    errorMsg.value = error instanceof Error ? error.message : '资产页加载失败'
    pageState.value = 'error'
  }
}

watch(
  () => route.query.projectId,
  () => {
    void loadAssets()
  },
)

onMounted(() => {
  void loadAssets()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div
        class="max-w-2xl rounded-[24px] border border-outline-variant bg-surface-container-low p-8 text-center"
      >
        <h2 class="text-2xl font-semibold text-on-surface">缺少项目上下文</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          资产中心是项目级页面，请先从某个项目工作区进入。
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
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载资产中心...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div
        class="max-w-2xl rounded-[24px] border border-red-500/30 bg-red-500/5 p-8 text-center"
      >
        <h2 class="text-2xl font-semibold text-red-300">资产页加载失败</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          {{ errorMsg || '请稍后重试。' }}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-3">
          <button
            class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
            type="button"
            @click="loadAssets"
          >
            重新加载
          </button>
          <button
            class="burning-orange-btn px-5 py-2 text-sm font-semibold"
            type="button"
            @click="goScenes"
          >
            返回工作区
          </button>
        </div>
      </div>
    </section>

    <section
      v-else-if="pageState === 'empty'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div
        class="max-w-2xl rounded-[24px] border border-outline-variant bg-surface-container-low p-8 text-center"
      >
        <h2 class="text-2xl font-semibold text-on-surface">当前项目还没有资产</h2>
        <p class="mt-3 text-sm leading-6 text-on-surface-variant">
          先去角色、静帧、视频或音频模块生成一些真实数据，再回到资产中心统一查看。
        </p>
        <button
          class="burning-orange-btn mt-6 px-5 py-2 text-sm font-semibold"
          type="button"
          @click="goScenes"
        >
          回到工作区继续处理
        </button>
      </div>
    </section>

    <div
      v-else
      class="min-h-full bg-[radial-gradient(circle_at_top_left,rgba(217,119,6,0.14),transparent_22%),linear-gradient(180deg,#111210_0%,#090909_100%)] text-on-surface"
    >
      <div class="grid min-h-full xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside
          class="border-b border-outline-variant bg-black/35 px-4 py-5 backdrop-blur xl:border-b-0 xl:border-r xl:px-5"
        >
          <div class="space-y-4 xl:sticky xl:top-5">
            <section
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-5"
            >
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">
                {{ project?.name || `Project ${projectId}` }}
              </p>
              <h1 class="mt-3 text-[28px] font-semibold text-on-surface">资产中心</h1>
              <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                把角色、静帧、视频和音频资产收拢到同一个项目级页面里统一查看和回跳。
              </p>
            </section>

            <section
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-4"
            >
              <div class="flex items-center justify-between">
                <span class="text-[11px] uppercase tracking-[0.22em] text-primary">资产类型</span>
                <span class="text-sm text-on-surface-variant">{{ allItems.length }}</span>
              </div>

              <div class="mt-3 space-y-2">
                <button
                  v-for="option in typeOptions"
                  :key="option.key"
                  class="flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm transition-all"
                  :class="filterButtonClass(activeType === option.key)"
                  type="button"
                  @click="activeType = option.key"
                >
                  <span>{{ option.label }}</span>
                  <strong class="text-sm font-semibold">{{ option.count }}</strong>
                </button>
              </div>
            </section>

            <section
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-4"
            >
              <div class="flex items-center justify-between">
                <span class="text-[11px] uppercase tracking-[0.22em] text-primary">状态筛选</span>
                <span class="text-sm text-on-surface-variant">{{ statusOptions.length - 1 }}</span>
              </div>

              <div class="mt-3 space-y-2">
                <button
                  v-for="option in statusOptions"
                  :key="option.key"
                  class="flex w-full items-center justify-between rounded-[14px] border px-4 py-3 text-left text-sm transition-all"
                  :class="filterButtonClass(activeStatus === option.key)"
                  type="button"
                  @click="activeStatus = option.key"
                >
                  <span>{{ option.label }}</span>
                  <strong class="text-sm font-semibold">{{ option.count }}</strong>
                </button>
              </div>
            </section>

            <section class="grid grid-cols-2 gap-3">
              <article
                class="rounded-[18px] border border-outline-variant bg-surface-container-low/85 px-4 py-4"
              >
                <p class="text-xs text-on-surface-variant">角色</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.characterCount || 0 }}
                </p>
              </article>
              <article
                class="rounded-[18px] border border-outline-variant bg-surface-container-low/85 px-4 py-4"
              >
                <p class="text-xs text-on-surface-variant">静帧</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.imageCount || 0 }}
                </p>
              </article>
              <article
                class="rounded-[18px] border border-outline-variant bg-surface-container-low/85 px-4 py-4"
              >
                <p class="text-xs text-on-surface-variant">视频</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.videoCount || 0 }}
                </p>
              </article>
              <article
                class="rounded-[18px] border border-outline-variant bg-surface-container-low/85 px-4 py-4"
              >
                <p class="text-xs text-on-surface-variant">音频</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.audioCount || 0 }}
                </p>
              </article>
              <article
                class="rounded-[18px] border border-primary/30 bg-primary/10 px-4 py-4"
              >
                <p class="text-xs text-primary">已确认视频</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.confirmedVideoCount || 0 }}
                </p>
              </article>
              <article
                class="rounded-[18px] border border-emerald-400/30 bg-emerald-400/10 px-4 py-4"
              >
                <p class="text-xs text-emerald-200">已确认音频</p>
                <p class="mt-2 text-2xl font-semibold text-on-surface">
                  {{ summary?.confirmedAudioCount || 0 }}
                </p>
              </article>
            </section>
          </div>
        </aside>

        <main class="min-w-0 px-4 py-5 xl:px-6">
          <section
            class="rounded-[24px] border border-outline-variant bg-surface-container-low/85 p-4 backdrop-blur"
          >
            <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div class="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  v-model="searchKeyword"
                  type="text"
                  class="h-11 w-full rounded-[14px] border border-outline-variant bg-black/25 px-4 text-sm text-on-surface outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/10 sm:max-w-[420px]"
                  placeholder="搜索资产、场景、分镜、角色或音色"
                />
                <span class="text-sm text-on-surface-variant">筛出 {{ filteredItems.length }} 条</span>
              </div>

              <div class="flex flex-wrap gap-3">
                <button
                  class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5"
                  type="button"
                  @click="toggleViewMode"
                >
                  {{ viewModeLabel }}
                </button>
                <button
                  class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5"
                  type="button"
                  @click="toggleSort"
                >
                  排序：{{ sortLabel }}
                </button>
                <button
                  class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                  type="button"
                  @click="goScenes"
                >
                  回到工作区
                </button>
              </div>
            </div>
          </section>

          <section class="mt-5 grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
            <article
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-5 backdrop-blur"
            >
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">项目总资产</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ summary?.totalCount || 0 }}
              </p>
              <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                当前项目下已经落库的角色、静帧、视频和音频资产总数。
              </p>
            </article>

            <article
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-5 backdrop-blur"
            >
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">已确认静帧</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ summary?.confirmedImageCount || 0 }}
              </p>
              <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                这些静帧通常是视频生成模块的上游输入。
              </p>
            </article>

            <article
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-5 backdrop-blur"
            >
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">已确认视频</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ summary?.confirmedVideoCount || 0 }}
              </p>
              <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                这些分镜已经具备进入导出和成片编辑模块的前置条件。
              </p>
            </article>

            <article
              class="rounded-[22px] border border-outline-variant bg-surface-container-low/85 p-5 backdrop-blur"
            >
              <p class="text-[11px] uppercase tracking-[0.22em] text-primary">已确认音频</p>
              <p class="mt-3 text-3xl font-semibold text-on-surface">
                {{ summary?.confirmedAudioCount || 0 }}
              </p>
              <p class="mt-3 text-sm leading-6 text-on-surface-variant">
                这些音频现在也能在资产中心统一检索，并回跳到对应场景的音频页。
              </p>
            </article>
          </section>

          <section v-if="filteredItems.length" class="mt-5">
            <div
              class="gap-4"
              :class="
                viewMode === 'grid'
                  ? 'grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3'
                  : 'flex flex-col'
              "
            >
              <article
                v-for="item in filteredItems"
                :key="`${item.assetType}-${item.id}`"
                class="overflow-hidden rounded-[24px] border border-outline-variant bg-surface-container-low/85 backdrop-blur"
                :class="viewMode === 'list' ? 'grid gap-0 md:grid-cols-[260px_minmax(0,1fr)]' : ''"
              >
                <div class="relative min-h-[210px] bg-black/50">
                  <img
                    v-if="item.previewUrl"
                    :src="item.previewUrl"
                    :alt="item.name"
                    class="h-full w-full object-cover"
                  />
                  <div
                    v-else-if="item.assetType === 'audio' && item.audioUrl"
                    class="flex min-h-[210px] flex-col items-center justify-center gap-5 px-6 text-[#8e775c]"
                  >
                    <span class="material-symbols-outlined text-6xl">graphic_eq</span>
                    <audio
                      class="w-full max-w-[220px]"
                      controls
                      preload="none"
                      :src="item.audioUrl"
                    />
                  </div>
                  <div
                    v-else
                    class="flex min-h-[210px] items-center justify-center text-[#8e775c]"
                  >
                    <span class="material-symbols-outlined text-5xl">
                      {{ mediaIconName(item) }}
                    </span>
                  </div>

                  <div class="absolute left-3 top-3 flex flex-wrap gap-2">
                    <span
                      class="inline-flex min-h-7 items-center rounded-full border px-3 text-[11px] uppercase tracking-[0.08em]"
                      :class="typeBadgeClass(item.assetType)"
                    >
                      {{ assetTypeLabel(item.assetType) }}
                    </span>
                    <span
                      class="inline-flex min-h-7 items-center rounded-full border px-3 text-[11px] uppercase tracking-[0.08em]"
                      :class="statusClass(item.status)"
                    >
                      {{ statusLabel(item.status) }}
                    </span>
                  </div>
                </div>

                <div class="flex min-w-0 flex-col gap-4 p-5">
                  <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0">
                      <h3 class="truncate text-xl font-semibold text-on-surface">{{ item.name }}</h3>
                      <p class="mt-2 text-sm leading-6 text-on-surface-variant">
                        {{ item.subtitle || sourceLabel(item) }}
                      </p>
                    </div>
                    <span class="text-xs text-[#9d886c]">{{ formatUpdated(item) }}</span>
                  </div>

                  <div class="flex flex-wrap gap-2 text-xs text-on-surface-variant">
                    <span
                      v-for="chip in detailChips(item)"
                      :key="`${item.assetType}-${item.id}-${chip}`"
                      class="rounded-full border border-outline-variant px-3 py-1"
                    >
                      {{ chip }}
                    </span>
                  </div>

                  <div class="flex flex-wrap gap-3">
                    <button
                      class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5"
                      type="button"
                      @click="openAsset(item)"
                    >
                      {{ item.assetType === 'character' ? '查看详情' : item.assetType === 'audio' ? '回到音频模块' : '回到来源' }}
                    </button>
                    <a
                      v-if="item.videoUrl"
                      class="rounded-[14px] border border-primary/30 px-4 py-2 text-sm text-primary transition hover:bg-primary/10"
                      :href="item.videoUrl"
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开视频
                    </a>
                    <a
                      v-if="item.audioUrl"
                      class="rounded-[14px] border border-emerald-400/30 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-400/10"
                      :href="item.audioUrl"
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开音频
                    </a>
                  </div>
                </div>
              </article>
            </div>
          </section>

          <section
            v-else
            class="mt-5 rounded-[24px] border border-dashed border-outline-variant bg-surface-container-low/70 p-8 text-center"
          >
            <h3 class="text-xl font-semibold text-on-surface">当前筛选条件下没有结果</h3>
            <p class="mt-3 text-sm leading-6 text-on-surface-variant">
              可以尝试清空关键词，或切换资产类型、状态筛选后再看。
            </p>
            <div class="mt-5 flex flex-wrap justify-center gap-3">
              <button
                class="rounded-[14px] border border-outline-variant px-4 py-2 text-sm text-on-surface transition hover:border-primary/40 hover:bg-white/5"
                type="button"
                @click="searchKeyword = ''"
              >
                清空搜索
              </button>
              <button
                class="burning-orange-btn px-5 py-2 text-sm font-semibold"
                type="button"
                @click="
                  activeType = 'all';
                  activeStatus = 'all';
                "
              >
                重置筛选
              </button>
            </div>
          </section>
        </main>
      </div>
    </div>
  </WorkspaceLayout>
</template>
