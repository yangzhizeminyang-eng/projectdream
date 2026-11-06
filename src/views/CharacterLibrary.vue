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
  deleteCharacter,
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
const deletingCharacterId = ref(0)
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

async function onDeleteCharacter(ch: CharacterDTO): Promise<void> {
  if (!projectId.value || deletingCharacterId.value) return
  const confirmed = window.confirm(
    `确认删除角色“${ch.name}”吗？\n删除后会从角色库隐藏，但历史分镜和音频引用会保留。`,
  )
  if (!confirmed) return
  deletingCharacterId.value = ch.id
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    await deleteCharacter(ch.id)
    await loadCharacters()
    infoMsg.value = `角色“${ch.name}”已删除`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '删除角色失败'
  } finally {
    deletingCharacterId.value = 0
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
  <WorkspaceLayout
    :show-side="true"
    :show-inspector="false"
    :no-padding="true"
    :self-managed-scroll="true"
  >
    <!-- 缺 projectId：整页友好提示，不静默失败 -->
    <section
      v-if="missingProjectId"
      class="flex h-full min-h-0 items-center justify-center bg-surface-dim p-8"
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

    <section v-else class="character-library-page flex h-full min-h-0 flex-col">
      <div class="character-library-scroll custom-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain">
        <div class="character-library-content mx-auto w-full max-w-[1640px]">
          <!-- 页面标题和核心操作 -->
          <header class="border-b border-outline-variant px-5 pb-5 pt-7 sm:px-8 sm:pt-8">
            <div class="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div class="min-w-0">
                <nav class="mb-3 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
                  <span>项目工作区</span>
                  <span class="material-symbols-outlined text-xs">chevron_right</span>
                  <span class="text-primary">角色库</span>
                </nav>
                <div class="flex items-end gap-3">
                  <h2 class="font-display-lg tracking-tight text-headline-lg text-on-surface">角色库</h2>
                  <span class="pb-1 font-label-md text-on-surface-variant">
                    {{ totalCount }} 个角色档案
                  </span>
                </div>
                <p class="mt-2 max-w-2xl text-sm leading-relaxed text-on-surface-variant">
                  统一维护角色形象、性格和声音基线，保证后续分镜与生成结果保持一致。
                </p>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  class="inline-flex min-h-10 items-center gap-2 border border-primary/70 bg-primary/10 px-4 font-label-md text-label-md text-primary transition-[background-color,border-color,transform] hover:border-primary hover:bg-primary/20 active:translate-y-px disabled:cursor-wait disabled:opacity-50"
                  :disabled="aiGenerating || creating"
                  @click="onGenerateCharacters"
                >
                  <span
                    class="material-symbols-outlined text-[18px]"
                    :class="{ 'animate-spin': aiGenerating }"
                  >{{ aiGenerating ? 'progress_activity' : 'auto_awesome' }}</span>
                  {{ aiGenerating ? '正在分析剧本' : '从剧本同步' }}
                </button>
                <button
                  type="button"
                  class="inline-flex min-h-10 items-center gap-2 bg-primary-container px-4 font-label-md text-label-md text-on-primary-container transition-[background-color,transform] hover:bg-primary-container/90 active:translate-y-px disabled:cursor-wait disabled:opacity-50"
                  :disabled="creating || aiGenerating"
                  @click="onCreateCharacter"
                >
                  <span class="material-symbols-outlined text-[18px]">person_add</span>
                  新建角色
                </button>
              </div>
            </div>

            <!-- 原右侧工作流信息收进这里，避免形成第二个滚动上下文 -->
            <dl class="character-summary mt-6 grid grid-cols-2 border-y border-outline-variant sm:grid-cols-4">
              <div class="border-b border-outline-variant px-3 py-3 sm:border-b-0 sm:border-r">
                <dt>角色档案</dt>
                <dd>{{ totalCount }}</dd>
              </div>
              <div class="border-b border-outline-variant px-3 py-3 sm:border-b-0 sm:border-r">
                <dt>已有定妆图</dt>
                <dd>{{ characters.filter((item) => item.referenceImageUrl).length }}</dd>
              </div>
              <div class="px-3 py-3 sm:border-r sm:border-outline-variant">
                <dt>已锁定音色</dt>
                <dd>{{ characters.filter((item) => item.voiceLocked && item.voiceProfileKey).length }}</dd>
              </div>
              <div class="px-3 py-3">
                <dt>当前视图</dt>
                <dd>{{ filteredCharacters.length }} 条结果</dd>
              </div>
            </dl>
          </header>

          <!-- 搜索和筛选 -->
          <section class="border-b border-outline-variant bg-surface-container-lowest px-5 py-4 sm:px-8">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-center">
              <label class="group relative min-w-0 flex-1">
                <span class="sr-only">搜索角色</span>
                <span class="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-on-surface-variant">search</span>
                <input
                  v-model="searchKeyword"
                  class="w-full border border-outline-variant bg-surface-container-low px-10 py-2.5 font-label-md text-label-md text-on-surface outline-none transition-[border-color,background-color] placeholder:text-outline-variant focus:border-primary focus:bg-surface-container"
                  placeholder="搜索角色名或角色标签"
                  type="search"
                />
              </label>
              <div class="custom-scrollbar flex items-center gap-2 overflow-x-auto overscroll-x-contain pb-1 lg:pb-0">
                <span class="mr-1 flex shrink-0 items-center gap-1.5 font-label-sm text-on-surface-variant">
                  <span class="material-symbols-outlined text-[17px]">filter_list</span>
                  筛选
                </span>
                <button
                  v-for="filter in filters"
                  :key="filter.key"
                  type="button"
                  class="shrink-0 px-3 py-1.5 font-label-sm transition-[background-color,border-color,color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  :class="
                    activeFilter === filter.key
                      ? 'border border-primary bg-primary/10 text-primary'
                      : 'border border-outline-variant text-on-surface-variant hover:border-on-surface hover:text-on-surface'
                  "
                  @click="activeFilter = filter.key"
                >
                  {{ filter.label }}
                </button>
              </div>
            </div>
          </section>

          <!-- 错误提示条 -->
          <div
            v-if="errorMsg"
            class="mx-5 my-4 flex items-center justify-between gap-4 border border-danger-red/40 bg-danger-red/5 px-4 py-3 sm:mx-8"
            role="alert"
          >
            <div class="flex min-w-0 items-center gap-3 text-sm text-on-surface">
              <span class="material-symbols-outlined shrink-0 text-danger-red">error</span>
              <span class="truncate">{{ errorMsg }}</span>
            </div>
            <button
              type="button"
              class="shrink-0 border border-outline-variant bg-surface-container-low px-3 py-1 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
              @click="retry"
            >
              重试
            </button>
          </div>

          <!-- 成功提示条 -->
          <div
            v-if="infoMsg"
            class="mx-5 my-4 flex items-center gap-3 border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-on-surface sm:mx-8"
            role="status"
          >
            <span class="material-symbols-outlined shrink-0 text-primary">check_circle</span>
            <span>{{ infoMsg }}</span>
          </div>

          <!-- 主体：loading / empty / ready 三态 -->
          <div v-if="pageState === 'loading'" class="flex min-h-[360px] items-center justify-center px-5 text-on-surface-variant sm:px-8">
            <div class="flex items-center gap-3">
              <span class="material-symbols-outlined animate-spin">progress_activity</span>
              <span>正在加载角色列表…</span>
            </div>
          </div>

          <div
            v-else-if="pageState === 'empty'"
            class="mx-5 my-6 flex min-h-[360px] flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container px-6 py-12 text-center sm:mx-8"
          >
            <div class="mb-4 flex h-14 w-14 items-center justify-center border border-outline-variant">
              <span class="material-symbols-outlined text-3xl text-on-surface-variant">person</span>
            </div>
            <p class="mb-2 font-label-md text-on-surface">该项目下还没有角色</p>
            <p class="mb-6 max-w-md text-sm leading-relaxed text-on-surface-variant">
              从项目总纲和剧本自动生成角色档案，或手工新建角色。
            </p>
            <div class="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                class="flex items-center gap-2 border border-primary bg-primary px-4 py-2 text-xs font-bold tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
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
                class="flex items-center gap-2 border border-outline-variant px-4 py-2 text-xs tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
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
            class="mx-5 my-6 flex min-h-[300px] flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container px-6 py-12 text-center sm:mx-8"
          >
            <div class="mb-4 flex h-14 w-14 items-center justify-center border border-outline-variant">
              <span class="material-symbols-outlined text-3xl text-on-surface-variant">filter_list_off</span>
            </div>
            <p class="font-label-md text-on-surface">没有匹配的角色</p>
            <p class="mt-2 text-sm text-on-surface-variant">尝试调整搜索关键字或筛选条件</p>
          </div>

          <div
            v-else
            class="grid grid-cols-1 gap-4 px-5 pb-16 pt-5 sm:grid-cols-2 sm:px-8 lg:grid-cols-3 2xl:grid-cols-4"
          >
            <article
              v-for="char in filteredCharacters"
              :key="char.id"
              class="character-card cv-auto group relative flex min-h-[370px] cursor-pointer flex-col overflow-hidden border border-outline-variant bg-surface-charcoal transition-[border-color,transform,background-color] duration-300 hover:-translate-y-0.5 hover:border-primary hover:bg-surface-container"
              @click="openDetail(char)"
            >
              <div class="relative aspect-[1.35] shrink-0 overflow-hidden bg-surface-slate">
                <img
                  v-if="char.referenceImageUrl"
                  class="h-full w-full object-cover grayscale transition-[filter,transform] duration-500 group-hover:scale-[1.02] group-hover:grayscale-0"
                  :src="char.referenceImageUrl"
                  :alt="`${char.name} 的角色参考图`"
                />
                <div v-else class="flex h-full w-full items-center justify-center text-outline">
                  <span class="material-symbols-outlined text-5xl">person</span>
                </div>
                <div class="character-overlay absolute inset-0 bg-gradient-to-t from-surface-charcoal via-transparent to-transparent opacity-75"></div>
                <div
                  class="absolute left-3 top-3 border border-white/15 bg-black/35 px-2 py-1 text-[10px] font-semibold tracking-wide text-white backdrop-blur-sm"
                >
                  {{ char.roleTag || '未指定角色' }}
                </div>
              </div>
              <div class="flex flex-1 flex-col p-4 sm:p-5">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h3 class="truncate font-headline-md text-on-surface">{{ char.name }}</h3>
                    <p class="mt-1 font-label-sm text-on-surface-variant">角色档案</p>
                  </div>
                  <span class="material-symbols-outlined shrink-0 text-[20px] text-primary" style="font-variation-settings: 'FILL' 1;">person</span>
                </div>
                <p
                  v-if="char.personality"
                  class="mt-4 line-clamp-2 min-h-[42px] text-sm leading-relaxed text-on-surface-variant"
                >
                  {{ char.personality }}
                </p>
                <p v-else class="mt-4 min-h-[42px] text-sm italic leading-relaxed text-outline">
                  暂无性格描述
                </p>
                <div class="mt-auto flex items-center justify-between gap-3 border-t border-outline-variant/40 pt-3">
                  <div class="flex min-w-0 flex-col">
                    <span class="text-[10px] text-on-surface-variant">状态</span>
                    <span :class="['font-label-md', statusClass(char.status)]">
                      {{ statusLabel(char.status) }}
                    </span>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      class="flex h-9 w-9 items-center justify-center border border-outline-variant text-on-surface-variant transition-[background-color,border-color,color] hover:border-primary hover:bg-primary/10 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      title="编辑角色"
                      aria-label="编辑角色"
                      @click.stop="openDetail(char)"
                    >
                      <span class="material-symbols-outlined text-[19px]">edit_note</span>
                    </button>
                    <button
                      type="button"
                      class="flex h-9 w-9 items-center justify-center border border-danger-red/40 text-danger-red transition-[background-color,border-color] hover:bg-danger-red/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger-red disabled:opacity-50"
                      title="删除角色"
                      aria-label="删除角色"
                      :disabled="deletingCharacterId === char.id"
                      @click.stop="onDeleteCharacter(char)"
                    >
                      <span
                        class="material-symbols-outlined text-[19px]"
                        :class="{ 'animate-spin': deletingCharacterId === char.id }"
                      >{{ deletingCharacterId === char.id ? 'progress_activity' : 'delete' }}</span>
                    </button>
                  </div>
                </div>
              </div>
            </article>

            <!-- 创建新角色卡保持与角色卡同一视觉节奏 -->
            <button
              type="button"
              class="character-create-card group flex min-h-[370px] cursor-pointer flex-col items-center justify-center border border-dashed border-outline-variant px-6 text-center transition-[background-color,border-color] hover:border-primary hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              :disabled="creating || aiGenerating"
              @click="onCreateCharacter"
            >
              <span class="material-symbols-outlined mb-4 text-3xl text-on-surface-variant transition-colors group-hover:text-primary">add</span>
              <span class="font-label-md text-on-surface-variant transition-colors group-hover:text-on-surface">创建新角色</span>
              <span class="mt-2 max-w-[220px] text-sm leading-relaxed text-outline-variant">
                为当前项目补充新的角色设定、肖像和性格标签
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>
  </WorkspaceLayout>
</template>

<style scoped>
.character-library-page {
  background:
    linear-gradient(180deg, rgba(255, 183, 125, 0.025), transparent 18rem),
    var(--pd-bg);
}

.character-library-scroll {
  scrollbar-gutter: stable;
}

.character-summary dt {
  color: var(--pd-muted);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
}

.character-summary dd {
  margin-top: 0.35rem;
  color: var(--pd-ink);
  font-size: 0.88rem;
  font-variant-numeric: tabular-nums;
}

.character-card,
.character-create-card {
  min-height: 370px;
}

.character-card:focus-within {
  border-color: var(--pd-accent);
}

@media (max-width: 639px) {
  .character-summary > div:nth-child(2) {
    border-right: 0;
  }

  .character-summary > div:nth-child(3) {
    border-top: 1px solid rgba(164, 132, 84, 0.28);
  }

  .character-summary > div:nth-child(4) {
    border-top: 1px solid rgba(164, 132, 84, 0.28);
  }
}
</style>
