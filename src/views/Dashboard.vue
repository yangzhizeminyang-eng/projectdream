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
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import { listProjects, type ProjectDTO } from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

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
const loadState = ref<LoadState>('loading')
const errorMsg = ref('')
const activeFilter = ref<StatusFilter>('all')
const showNeedProjectHint = computed<boolean>(() => route.query.reason === 'need-project')

/**
 * @description 异步加载项目列表
 * @returns {Promise<void>}
 */
async function loadProjects(): Promise<void> {
  loadState.value = 'loading'
  errorMsg.value = ''
  try {
    const list = await listProjects()
    projects.value = list
    loadState.value = list.length ? 'ok' : 'empty'
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
  setWorkspaceContext({ projectId: project.id })
  router.push({
    path: '/workspace/script/ai',
    query: { projectId: String(project.id) },
  })
}

function openExport(project: ProjectDTO): void {
  setWorkspaceContext({ projectId: project.id })
  router.push({
    path: '/workspace/export',
    query: { projectId: String(project.id) },
  })
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
  return `分镜 ${details.storyboardCount} · 静帧 ${details.confirmedImageCount} · 视频 ${details.confirmedVideoCount} · 音频 ${details.confirmedAudioCount}`
}

/**
 * @description 根据当前筛选过滤项目
 */
const filteredProjects = computed<ProjectDTO[]>(() => {
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
const recentProjects = computed<ProjectDTO[]>(() => {
  return [...projects.value]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .slice(0, 3)
})

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
      class="mb-4 flex items-center justify-between border border-primary/40 bg-primary/5 px-4 py-3"
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

    <div class="px-margin-md pb-32 pt-margin-md">
      <!-- 工具条 -->
      <header class="console-toolbar mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-outline-variant pb-6">
        <div>
          <p class="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            <span class="material-symbols-outlined text-sm">folder_open</span>
            Project Console
            <span class="text-on-surface-variant">/ 项目控制台</span>
          </p>
          <h1 class="font-headline-lg text-headline-lg text-on-surface">
            你的项目
          </h1>
          <p class="mt-1 text-body-md text-on-surface-variant">
            <template v-if="loadState === 'ok'">
              共 {{ weekly.total }} 个项目 · {{ weekly.active }} 个进行中 · {{ weekly.done }} 个已完成
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
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex border border-outline-variant" role="tablist" aria-label="状态筛选">
            <button
              v-for="opt in filterOptions"
              :key="opt.value"
              type="button"
              role="tab"
              :aria-selected="activeFilter === opt.value"
              class="border-r border-outline-variant px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant last:border-r-0 hover:text-primary"
              :class="{ 'bg-primary/10 text-primary': activeFilter === opt.value }"
              @click="activeFilter = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="goNewProject"
          >
            <span class="material-symbols-outlined text-sm">add</span>
            新建项目
          </button>
        </div>
      </header>

      <!-- 主体：双栏（项目流 + Studio Note） -->
      <div class="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <!-- 左侧：项目流 -->
        <section class="lg:col-span-8" aria-label="项目流">
          <!-- 错误态 -->
          <div
            v-if="loadState === 'error'"
            class="flex flex-col items-center justify-center border border-danger-red/40 bg-danger-red/10 px-6 py-16 text-center"
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
            class="space-y-4"
            aria-busy="true"
            aria-label="加载中"
          >
            <div
              v-for="i in 3"
              :key="i"
              class="flex animate-pulse items-center gap-6 border border-outline-variant bg-surface-container p-6"
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
            class="flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-20 text-center"
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
          <ul
            v-else-if="filteredProjects.length"
            class="console-list space-y-4"
            aria-label="项目列表"
          >
            <li
              v-for="p in filteredProjects"
              :key="p.id"
              class="group relative cursor-pointer border border-outline-variant bg-surface-container p-6 transition-all duration-200 hover:border-primary hover:bg-surface-container-high focus-within:border-primary"
              tabindex="0"
              role="button"
              :aria-label="`进入项目 ${displayText(p.name, `未命名项目 ${projectCode(p.id)}`)}`"
              @click="openProject(p)"
              @keydown.enter.prevent="openProject(p)"
              @keydown.space.prevent="openProject(p)"
            >
              <div class="flex items-start gap-6">
                <!-- 代号 + 圆弧进度（signature 元素） -->
                <div class="relative h-20 w-20 shrink-0">
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
                    <span class="font-mono text-sm font-bold text-primary">
                      {{ projectProgress(p) }}
                    </span>
                  </div>
                </div>

                <!-- 中部信息 -->
                <div class="min-w-0 flex-1">
                  <div class="mb-2 flex flex-wrap items-center gap-2">
                    <h3 class="truncate font-headline-md text-headline-md text-on-surface group-hover:text-primary">
                      {{ displayText(p.name, `未命名项目 ${projectCode(p.id)}`) }}
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
                  </div>
                  <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                    <span class="font-bold uppercase tracking-widest">{{ displayText(p.category, '未分类') }}</span>
                    <span v-if="!isCorruptedText(p.aspectRatio)" class="font-mono">{{ p.aspectRatio }}</span>
                    <span v-if="!isCorruptedText(p.visualStyle)">{{ p.visualStyle }}</span>
                    <span v-if="p.targetDuration" class="font-mono">{{ p.targetDuration }} min</span>
                  </div>
                  <p class="mb-3 line-clamp-2 text-sm leading-relaxed text-on-surface-variant">
                    {{ excerpt(displayText(p.narrativeVision, '暂无项目简介'), 100) }}
                  </p>
                  <!-- 进度条 -->
                  <div class="flex items-center gap-3">
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
                    class="mt-4 border border-outline-variant bg-surface-container-low p-3"
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
                        @click.stop="openExport(p)"
                      >
                        查看导出
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
                <div class="hidden shrink-0 flex-col items-end justify-between text-right sm:flex">
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
              <!-- 底部装饰：hover 时进度条延伸 -->
              <div
                class="absolute bottom-0 left-0 h-[2px] w-0 bg-primary transition-all duration-300 group-hover:w-full"
                aria-hidden="true"
              ></div>
            </li>
          </ul>

          <!-- 筛选后无结果 -->
          <div
            v-else
            class="flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-16 text-center"
          >
            <span class="material-symbols-outlined mb-2 text-4xl text-on-surface-variant">filter_alt_off</span>
            <p class="mb-1 font-bold text-on-surface">没有符合筛选条件的项目</p>
            <p class="mb-4 text-sm text-on-surface-variant">试试切换其他状态</p>
            <button
              type="button"
              class="border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
              @click="activeFilter = 'all'"
            >
              全部项目
            </button>
          </div>
        </section>

        <!-- 右侧：Studio Note 制片助理摘要 -->
        <aside class="lg:col-span-4" aria-label="制片助理摘要">
          <div class="sticky top-6 space-y-4 console-side">
            <!-- 本周摘要 -->
            <div class="border border-outline-variant bg-surface-container p-5">
              <div class="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                <span class="material-symbols-outlined text-sm">analytics</span>
                Studio Note · 本周
              </div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div class="border border-outline-variant bg-surface-container-low p-3">
                  <div class="font-headline-md text-headline-md text-on-surface">{{ weekly.total }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">总项目</div>
                </div>
                <div class="border border-outline-variant bg-surface-container-low p-3">
                  <div class="font-headline-md text-headline-md text-primary">{{ weekly.active }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">进行中</div>
                </div>
                <div class="border border-outline-variant bg-surface-container-low p-3">
                  <div class="font-headline-md text-headline-md text-tertiary">{{ weekly.done }}</div>
                  <div class="mt-1 text-[10px] uppercase tracking-widest text-on-surface-variant">已完成</div>
                </div>
              </div>
            </div>

            <!-- 最近活动 -->
            <div class="border border-outline-variant bg-surface-container p-5">
              <div class="mb-3 flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                <span class="flex items-center gap-2">
                  <span class="material-symbols-outlined text-sm">history</span>
                  最近活动
                </span>
                <span class="font-mono text-on-surface-variant">RECENT</span>
              </div>
              <ul v-if="recentProjects.length" class="space-y-3">
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
              <p v-else class="text-sm text-on-surface-variant">暂无活动</p>
            </div>

            <!-- 快捷操作 -->
            <div class="border border-outline-variant bg-surface-container p-5">
              <div class="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">
                快捷操作
              </div>
              <div class="flex flex-col gap-2">
                <button
                  type="button"
                  class="flex items-center gap-2 border border-primary bg-primary/10 px-3 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20"
                  @click="goNewProject"
                >
                  <span class="material-symbols-outlined text-sm">add</span>
                  新建项目
                </button>
                <button
                  type="button"
                  class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  @click="
                    router.push(
                      recentProjects[0]
                        ? {
                            path: '/workspace/ai-tasks',
                            query: { projectId: String(recentProjects[0].id) },
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
                  class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-3 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  :disabled="!recentProjects[0]"
                  @click="recentProjects[0] && openProject(recentProjects[0])"
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
  </WorkspaceLayout>
</template>

<style scoped>
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
