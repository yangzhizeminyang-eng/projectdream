<script setup lang="ts">
/**
 * @file 角色库列表页
 * @description 按 projectId 加载当前项目下角色，支持搜索 / 筛选 / 新建 / 点击进入详情
 *              - 缺 projectId：整页友好提示，引导回项目总览
 *              - 数据从后端拉，listCharacters(projectId)
 *              - 筛选按 status 字段做（不再依赖硬编码 badge）
 *              - 搜索按 name / roleTag 模糊匹配（前端层，不发请求）
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  createCharacter,
  generateProjectCharacters,
  listCharacters,
  type CharacterDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

/**
 * @description 项目上下文 ID（从 query.projectId 读）
 */
const projectId = computed(() => Number(route.query.projectId) || 0)

/**
 * @description 缺 projectId：整页友好提示
 */
const missingProjectId = computed<boolean>(() => !projectId.value)

/**
 * @description 页面状态机
 *              - loading  正在请求 GET /api/projects/:id/characters
 *              - error    接口失败
 *              - empty    接口成功但当前项目下没有角色
 *              - ready    有数据
 */
type PageState = 'loading' | 'error' | 'empty' | 'ready'
const pageState = ref<PageState>('loading')
const errorMsg = ref('')

/**
 * @description 角色列表（已加载的真实数据）
 */
const characters = ref<CharacterDTO[]>([])

/**
 * @description 搜索关键字（按 name / roleTag 前端模糊匹配，不发请求）
 */
const searchKeyword = ref('')

/**
 * @description 筛选：all / draft / finalized
 *              后端 status 当前只用到 draft（一期最小集）；finalized 后续按业务启用
 */
type FilterKey = 'all' | 'draft' | 'finalized' | 'unfinished'
const activeFilter = ref<FilterKey>('all')

const filters: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'draft', label: '草稿' },
  { key: 'finalized', label: '已就绪' },
  { key: 'unfinished', label: '未完成' },
]

/**
 * @description 列表提交 / 状态机切换中
 */
const creating = ref(false)
const aiGenerating = ref(false)
const infoMsg = ref('')

/**
 * @description 当前项目下的角色数（顶部标题旁展示）
 */
const totalCount = computed(() => characters.value.length)

/**
 * @description 过滤后的角色列表（按 activeFilter + searchKeyword）
 *              - activeFilter：all 全显；draft 显 status='draft'；finalized 显 status='finalized'；unfinished 显 status NOT IN ('finalized') 的
 *              - searchKeyword：name / roleTag 包含匹配（不区分大小写）
 */
const filteredCharacters = computed<CharacterDTO[]>(() => {
  const kw = searchKeyword.value.trim().toLowerCase()
  return characters.value.filter((c) => {
    if (activeFilter.value === 'draft' && c.status !== 'draft') return false
    if (activeFilter.value === 'finalized' && c.status !== 'finalized') return false
    if (activeFilter.value === 'unfinished' && c.status === 'finalized') return false
    if (!kw) return true
    return (
      String(c.name || '').toLowerCase().includes(kw) ||
      String(c.roleTag || '').toLowerCase().includes(kw)
    )
  })
})

/**
 * @description 拉取当前 projectId 下的角色列表
 *              失败：进 error 态；成功：empty/ready
 * @returns {Promise<void>}
 */
async function loadCharacters(): Promise<void> {
  if (!projectId.value) return
  pageState.value = 'loading'
  errorMsg.value = ''
  try {
    const list = await listCharacters(projectId.value)
    characters.value = list
    pageState.value = list.length ? 'ready' : 'empty'
  } catch (e) {
    characters.value = []
    pageState.value = 'error'
    errorMsg.value = e instanceof Error ? e.message : '角色列表加载失败'
  }
}

/**
 * @description 重试加载
 * @returns {Promise<void>}
 */
async function retry(): Promise<void> {
  await loadCharacters()
}

/**
 * @description 新建角色（最小闭环：只填 name，其他字段空）
 *              成功后跳到详情页继续编辑
 * @returns {Promise<void>}
 */
async function onCreateCharacter(): Promise<void> {
  if (creating.value || !projectId.value) return
  creating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const created = await createCharacter(projectId.value, { name: '新角色' })
    characters.value = [...characters.value, created]
    pageState.value = 'ready'
    // 跳到详情页进入编辑模式
    router.push({
      path: '/workspace/character/detail',
      query: { projectId: String(projectId.value), characterId: String(created.id) },
    })
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '新建角色失败'
  } finally {
    creating.value = false
  }
}

async function onGenerateCharacters(): Promise<void> {
  if (aiGenerating.value || !projectId.value) return
  aiGenerating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const generated = await generateProjectCharacters(projectId.value)
    characters.value = generated
    pageState.value = generated.length ? 'ready' : 'empty'
    infoMsg.value = `已生成并同步 ${generated.length} 个角色档案`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'AI 角色生成失败'
  } finally {
    aiGenerating.value = false
  }
}

/**
 * @description 点击角色卡片：进入详情页
 * @param {CharacterDTO} ch
 * @returns {void}
 */
function openDetail(ch: CharacterDTO): void {
  if (!projectId.value) return
  router.push({
    path: '/workspace/character/detail',
    query: { projectId: String(projectId.value), characterId: String(ch.id) },
  })
}

/**
 * @description 状态徽章颜色（与状态字段绑定，未来加新状态时统一改这里）
 * @param {string} status
 * @returns {string}
 */
function statusClass(status: string): string {
  if (status === 'finalized') return 'text-primary'
  if (status === 'draft') return 'text-on-surface-variant'
  return 'text-danger-red'
}

function statusLabel(status: string): string {
  if (status === 'finalized') return '已就绪'
  if (status === 'draft') return '草稿'
  return status || '未知'
}

/**
 * @description 缺失项目时点击"前往项目总览"
 * @returns {void}
 */
function goDashboard(): void {
  router.push('/dashboard')
}

watch(
  () => route.query.projectId,
  () => {
    if (!missingProjectId.value) void loadCharacters()
  },
)

onMounted(() => {
  if (missingProjectId.value) {
    pageState.value = 'empty' // 走缺失上下文提示分支
    return
  }
  // 写入最近项目上下文，供其他入口读取
  setWorkspaceContext({ projectId: projectId.value })
  void loadCharacters()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <!-- 缺 projectId：整页友好提示，不静默失败 -->
    <section
      v-if="missingProjectId"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">person_off</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少项目上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          角色库依附于具体项目。请先从项目控制台选择一个项目，或新建一个项目。
        </p>
        <button
          type="button"
          class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
          @click="goDashboard"
        >
          <span class="material-symbols-outlined text-sm">dashboard</span>
          前往项目控制台
        </button>
      </div>
    </section>

    <template v-else>
    <div class="flex h-full">
      <div class="custom-scrollbar flex-1 overflow-y-auto bg-background">
        <!-- 顶部信息区 -->
        <div class="flex flex-col gap-6 border-b border-outline-variant px-margin-md py-8">
          <div>
            <nav class="mb-2 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
              <span>项目工作区</span>
              <span class="material-symbols-outlined text-xs">chevron_right</span>
              <span class="text-primary">角色库</span>
            </nav>
            <h2 class="flex items-start gap-2 whitespace-nowrap font-display-lg uppercase tracking-tight text-headline-lg text-on-surface">
              角色库<span class="pt-1 text-2xl text-outline">/ {{ totalCount }}</span>
            </h2>
          </div>
          <div class="grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
            <div class="group relative">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
              <input
                v-model="searchKeyword"
                class="w-full border border-outline-variant bg-surface-container-low px-10 py-2 font-label-md text-label-md text-on-surface transition-all focus:border-primary focus:ring-0"
                placeholder="搜索角色 / 角色标签..."
                type="text"
              />
            </div>
            <button
              type="button"
              class="flex items-center gap-2 border border-primary bg-primary/10 px-5 py-2 font-label-md text-label-md text-primary transition-all hover:bg-primary/20 disabled:opacity-50"
              :disabled="aiGenerating || creating"
              @click="onGenerateCharacters"
            >
              <span
                class="material-symbols-outlined"
                :class="{ 'animate-spin': aiGenerating }"
              >{{ aiGenerating ? 'progress_activity' : 'auto_awesome' }}</span>
              {{ aiGenerating ? '正在分析剧本' : 'AI 生成角色' }}
            </button>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary-container px-6 py-2 font-label-md text-label-md text-on-primary-container transition-all hover:bg-primary-container/90 active:scale-95 disabled:opacity-50"
              :disabled="creating || aiGenerating"
              @click="onCreateCharacter"
            >
              <span class="material-symbols-outlined">person_add</span>
              新建角色
            </button>
          </div>
        </div>

        <!-- 错误提示条 -->
        <div
          v-if="errorMsg"
          class="mx-margin-md my-3 flex items-center justify-between border border-danger-red/40 bg-danger-red/5 px-4 py-3"
          role="alert"
        >
          <div class="flex items-center gap-3 text-sm text-on-surface">
            <span class="material-symbols-outlined text-danger-red">error</span>
            <span>{{ errorMsg }}</span>
          </div>
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-3 py-1 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
            @click="retry"
          >
            重试
          </button>
        </div>

        <!-- 成功提示条 -->
        <div
          v-if="infoMsg"
          class="mx-margin-md my-3 flex items-center gap-3 border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-on-surface"
          role="status"
        >
          <span class="material-symbols-outlined text-primary">check_circle</span>
          <span>{{ infoMsg }}</span>
        </div>

        <!-- 筛选条 -->
        <div class="custom-scrollbar scroll-optimized flex items-center gap-6 overflow-x-auto overscroll-x-contain border-b border-outline-variant bg-surface-container-lowest px-margin-md py-4">
          <div class="flex items-center gap-2 font-label-md text-primary">
            <span class="material-symbols-outlined">filter_list</span>
            <span>筛选</span>
          </div>
          <button
            v-for="filter in filters"
            :key="filter.key"
            class="px-4 py-1 font-label-sm uppercase tracking-wider transition-all"
            :class="
              activeFilter === filter.key
                ? 'border border-primary text-primary'
                : 'border border-outline-variant text-on-surface-variant hover:border-on-surface hover:text-on-surface'
            "
            @click="activeFilter = filter.key"
          >
            {{ filter.label }}
          </button>
        </div>

        <!-- 主体：loading / empty / ready 三态 -->
        <div v-if="pageState === 'loading'" class="flex h-64 items-center justify-center text-on-surface-variant">
          <div class="flex items-center gap-3">
            <span class="material-symbols-outlined animate-spin">progress_activity</span>
            <span>正在加载角色列表…</span>
          </div>
        </div>

        <div
          v-else-if="pageState === 'empty'"
          class="flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container p-margin-md text-center"
        >
          <div class="mb-4 flex h-16 w-16 items-center justify-center border border-outline-variant">
            <span class="material-symbols-outlined text-3xl text-on-surface-variant">person</span>
          </div>
          <p class="mb-2 font-label-md uppercase tracking-widest text-on-surface">该项目下还没有角色</p>
          <p class="mb-6 max-w-md px-8 text-center text-sm text-on-surface-variant">
            从项目总纲和剧本自动生成角色档案，或手工新建角色。
          </p>
          <div class="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              class="flex items-center gap-2 border border-primary bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
              :disabled="aiGenerating"
              @click="onGenerateCharacters"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': aiGenerating }">
                {{ aiGenerating ? 'progress_activity' : 'auto_awesome' }}
              </span>
              AI 生成角色
            </button>
            <button
              type="button"
              class="flex items-center gap-2 border border-outline-variant px-4 py-2 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
              :disabled="creating || aiGenerating"
              @click="onCreateCharacter"
            >
              <span class="material-symbols-outlined text-sm">person_add</span>
              手工新建
            </button>
          </div>
        </div>

        <div
          v-else-if="pageState === 'ready' && !filteredCharacters.length"
          class="flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container p-margin-md text-center"
        >
          <div class="mb-4 flex h-16 w-16 items-center justify-center border border-outline-variant">
            <span class="material-symbols-outlined text-3xl text-on-surface-variant">filter_list_off</span>
          </div>
          <p class="font-label-md uppercase tracking-widest text-on-surface">没有匹配的角色</p>
          <p class="mt-2 text-sm text-on-surface-variant">尝试调整搜索关键字或筛选条件</p>
        </div>

        <div v-else class="grid grid-cols-1 gap-margin-md p-margin-md pb-24 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          <div
            v-for="char in filteredCharacters"
            :key="char.id"
            class="character-card cv-auto group relative flex h-full cursor-pointer flex-col overflow-hidden border border-outline-variant bg-surface-charcoal transition-all duration-300 hover:-translate-y-1 hover:border-primary"
            @click="openDetail(char)"
          >
            <div class="relative h-64 overflow-hidden bg-surface-slate">
              <img
                v-if="char.referenceImageUrl"
                class="h-full w-full object-cover grayscale transition-all duration-700 group-hover:grayscale-0"
                :src="char.referenceImageUrl"
                :alt="char.name"
              />
              <div v-else class="flex h-full w-full items-center justify-center text-outline">
                <span class="material-symbols-outlined text-5xl">person</span>
              </div>
              <div class="character-overlay absolute inset-0 bg-gradient-to-t from-surface-charcoal via-transparent to-transparent opacity-60"></div>
              <div
                v-if="char.roleTag"
                class="absolute left-4 top-4 bg-primary px-2 py-0.5 text-[10px] font-bold uppercase text-on-primary-fixed-variant"
              >
                {{ char.roleTag }}
              </div>
            </div>
            <div class="flex flex-1 flex-col p-6">
              <div class="mb-4 flex items-start justify-between">
                <div>
                  <h3 class="font-headline-md text-on-surface">
                    {{ char.name }}
                  </h3>
                  <p class="mt-1 font-label-sm uppercase tracking-widest text-label-sm text-on-surface-variant">
                    {{ char.roleTag || '未指定角色' }}
                  </p>
                </div>
                <span class="material-symbols-outlined text-primary" style="font-variation-settings: 'FILL' 1;">person</span>
              </div>
              <p
                v-if="char.personality"
                class="mb-6 line-clamp-3 text-sm leading-relaxed text-on-surface-variant"
              >
                {{ char.personality }}
              </p>
              <p v-else class="mb-6 text-sm italic text-outline">暂无性格描述</p>
              <div class="mt-auto flex items-center justify-between border-t border-outline-variant/30 pt-4">
                <div class="flex flex-col">
                  <span class="text-[10px] font-label-sm uppercase text-on-surface-variant">状态</span>
                  <span :class="['font-label-md', statusClass(char.status)]">
                    {{ statusLabel(char.status) }}
                  </span>
                </div>
                <button
                  type="button"
                  class="flex h-10 w-10 items-center justify-center border border-outline-variant text-on-surface-variant transition-all hover:border-primary hover:text-primary"
                  @click.stop="openDetail(char)"
                >
                  <span class="material-symbols-outlined">edit_note</span>
                </button>
              </div>
            </div>
          </div>

          <!-- 创建新角色虚线卡 -->
          <div
            class="group flex min-h-[400px] cursor-pointer flex-col items-center justify-center border border-dashed border-outline-variant transition-all hover:bg-surface-container"
            @click="onCreateCharacter"
          >
            <div class="mb-4 flex h-16 w-16 items-center justify-center border border-outline-variant transition-all group-hover:border-primary group-hover:text-primary">
              <span class="material-symbols-outlined text-3xl">add</span>
            </div>
            <p class="font-label-md uppercase tracking-widest text-on-surface-variant group-hover:text-on-surface">创建新角色</p>
            <p class="mt-2 px-8 text-center font-label-sm text-outline-variant">点击这里为当前项目补充新的角色设定、肖像和性格标签。</p>
          </div>
        </div>
      </div>

      <!-- 右侧角色工作流 -->
      <aside class="custom-scrollbar hidden w-[320px] flex-shrink-0 flex-col overflow-y-auto overscroll-y-contain border-l border-outline-variant bg-surface-charcoal xl:flex">
        <div class="border-b border-outline-variant bg-surface-container-low p-6">
          <h4 class="flex items-center gap-2 font-label-md uppercase tracking-widest text-on-surface">
            <span class="material-symbols-outlined text-sm text-primary">psychology</span>
            角色工作流
          </h4>
        </div>
        <div class="flex-1 space-y-5 p-6 text-sm leading-relaxed text-on-surface-variant">
          <div class="border border-outline-variant bg-surface-container-low p-4">
            <span class="text-[10px] uppercase tracking-widest text-outline">项目角色</span>
            <strong class="mt-1 block text-2xl font-normal text-on-surface">{{ totalCount }}</strong>
          </div>
          <button
            type="button"
            class="flex w-full items-center justify-center gap-2 border border-primary bg-primary/10 px-4 py-3 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
            :disabled="aiGenerating || creating"
            @click="onGenerateCharacters"
          >
            <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': aiGenerating }">
              {{ aiGenerating ? 'progress_activity' : 'auto_awesome' }}
            </span>
            {{ aiGenerating ? '正在提取角色' : '从剧本同步角色' }}
          </button>
          <div class="space-y-3 border-t border-outline-variant pt-5 text-xs">
            <div class="flex items-center justify-between">
              <span>已有定妆图</span>
              <span class="text-on-surface">{{ characters.filter((item) => item.referenceImageUrl).length }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span>已锁定音色</span>
              <span class="text-on-surface">{{ characters.filter((item) => item.voiceLocked && item.voiceProfileKey).length }}</span>
            </div>
          </div>
        </div>
      </aside>
    </div>
    </template>
  </WorkspaceLayout>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: #0d0f0d;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #554336;
}
</style>
