<script setup lang="ts">
/**
 * @file 场景拆解页
 * @description 独立于总纲页，专门管理"正式场景"：
 *                - 左侧：正式场景列表（sceneNo / title / summary / status）
 *                - 中间：当前选中场景的详情编辑（title / summary / location / timeOfDay / estimatedDuration）
 *                - 顶部：生成场景 / 重新生成场景 / 保存 / 进入剧本
 *              页面状态机：loading / error / empty（无正式场景）/ ready / no-outline（无总纲）
 *              跳转入口：query.projectId 必填；选中 sceneId 由内部维护。
 *              进入剧本：query.projectId + query.sceneId 跳 /workspace/script
 */

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  generateScenes,
  getLatestOutline,
  getProject,
  listScenes,
  updateScene,
  type OutlineDTO,
  type ProjectDTO,
  type SceneDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const missingProjectId = computed<boolean>(() => !projectId.value)

const project = ref<ProjectDTO | null>(null)
const outline = ref<OutlineDTO | null>(null)
const scenes = ref<SceneDTO[]>([])
const activeSceneId = ref<number | null>(null)

/**
 * @description 页面状态机
 *              - loading: 初次拉取项目+总纲+场景
 *              - error:   任一接口失败
 *              - no-outline: 接口成功但项目还没有总纲（无法生成场景）
 *              - empty:   有总纲但还没有正式场景（提示"生成场景"）
 *              - ready:   有正式场景，进入正常编辑流
 */
type PageState = 'loading' | 'error' | 'no-outline' | 'empty' | 'ready'
const pageState = ref<PageState>('loading')
const errorMsg = ref('')

const loading = ref({
  project: false,
  outline: false,
  scenes: false,
})
const generating = ref(false)
const saving = ref(false)
const confirmRegenScenes = ref(false)
const infoMsg = ref('')

/**
 * @description 待切换的目标 sceneId（formDirty 时使用）
 *              切场景前若有未保存修改，先弹确认窗；用户选"丢弃"才真正切换，选"取消"则保持当前编辑。
 *              避免之前"已切换场景，未保存的修改将被丢弃"的静默丢数据问题。
 */
const pendingSwitchSceneId = ref<number | null>(null)

/**
 * @description 当前选中的场景对象
 */
const activeScene = computed<SceneDTO | null>(() => {
  if (activeSceneId.value == null) return null
  return scenes.value.find((s) => s.id === activeSceneId.value) || null
})

/**
 * @description 表单本地草稿（编辑时改这里，保存时一次性提交）
 *              切换选中场景时从源数据重置，避免脏写。
 */
interface SceneFormDraft {
  title: string
  summary: string
  location: string
  timeOfDay: string
  estimatedDuration: number | null
}
const formDraft = ref<SceneFormDraft>({
  title: '',
  summary: '',
  location: '',
  timeOfDay: '',
  estimatedDuration: null,
})
const formDirty = ref(false)

/**
 * @description 把当前 activeScene 同步进表单草稿（重置 dirty）
 * @returns {void}
 */
function syncDraftFromActive(): void {
  const s = activeScene.value
  if (!s) return
  formDraft.value = {
    title: s.title || '',
    summary: s.summary || '',
    location: s.location || '',
    timeOfDay: s.timeOfDay || '',
    estimatedDuration: s.estimatedDuration ?? null,
  }
  formDirty.value = false
}

/**
 * @description 判断当前草稿与原始数据是否真的不同（避免空保存）
 */
function isDraftChanged(): boolean {
  const s = activeScene.value
  if (!s) return false
  return (
    (s.title || '') !== formDraft.value.title ||
    (s.summary || '') !== formDraft.value.summary ||
    (s.location || '') !== formDraft.value.location ||
    (s.timeOfDay || '') !== formDraft.value.timeOfDay ||
    (s.estimatedDuration ?? null) !== (formDraft.value.estimatedDuration ?? null)
  )
}

/**
 * @description 拉取项目 + 总纲 + 场景，组装出页面状态
 * @returns {Promise<void>}
 */
async function refreshAll(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'error'
    errorMsg.value = '缺少 projectId 参数'
    return
  }
  pageState.value = 'loading'
  errorMsg.value = ''

  // 项目
  loading.value.project = true
  try {
    project.value = await getProject(projectId.value)
    if (project.value) setWorkspaceContext({ projectId: project.value.id })
  } catch (e) {
    project.value = null
    errorMsg.value = e instanceof Error ? e.message : '项目加载失败'
    pageState.value = 'error'
    loading.value.project = false
    return
  } finally {
    loading.value.project = false
  }

  // 总纲
  // 注意：必须区分"接口成功但没数据（真没总纲）"和"接口失败（网络/鉴权/500）"
  // 之前的写法把 catch 静默成 outline=null，会被下游判定为"没总纲"，误导用户
  loading.value.outline = true
  try {
    outline.value = await getLatestOutline(projectId.value)
  } catch (e) {
    outline.value = null
    errorMsg.value = e instanceof Error ? e.message : '总纲读取失败'
    pageState.value = 'error'
    loading.value.outline = false
    return
  } finally {
    loading.value.outline = false
  }

  // 这里 outline === null 才表示"接口成功 + 真没总纲" → 走 no-outline
  if (!outline.value) {
    pageState.value = 'no-outline'
    return
  }

  // 场景
  loading.value.scenes = true
  try {
    scenes.value = await listScenes(projectId.value)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '场景加载失败'
    pageState.value = 'error'
    loading.value.scenes = false
    return
  } finally {
    loading.value.scenes = false
  }

  if (scenes.value.length === 0) {
    pageState.value = 'empty'
    return
  }

  // ready：默认选中第一场
  pageState.value = 'ready'
  activeSceneId.value = scenes.value[0]?.id ?? null
}

/**
 * @description 选场景：先检查是否有未保存修改
 *              - 无 dirty：直接切换
 *              - 有 dirty：把目标 sceneId 暂存到 pendingSwitchSceneId，弹确认窗；
 *                          不立即改 activeSceneId，避免草稿被 watch 静默覆盖
 * @param {number} sceneId
 * @returns {void}
 */
function selectScene(sceneId: number): void {
  if (activeSceneId.value === sceneId) return
  if (formDirty.value) {
    pendingSwitchSceneId.value = sceneId
    return
  }
  activeSceneId.value = sceneId
}

/**
 * @description 确认丢弃当前修改并切换到目标场景
 *              先把 formDirty 置 false，watch 后续同步草稿时不会被 isDraftChanged 误判
 * @returns {void}
 */
function confirmDiscardAndSwitch(): void {
  const target = pendingSwitchSceneId.value
  pendingSwitchSceneId.value = null
  if (target == null) return
  formDirty.value = false
  activeSceneId.value = target
}

/**
 * @description 取消切换目标场景，保留当前编辑
 * @returns {void}
 */
function cancelSwitchScene(): void {
  pendingSwitchSceneId.value = null
}

/**
 * @description 触发"生成场景"：从总纲预览场景写入正式场景
 *              二次确认：仅在已有正式场景时弹窗（覆盖风险）
 * @returns {void}
 */
function requestGenerateScenes(): void {
  if (generating.value || !projectId.value) return
  if (scenes.value.length > 0) {
    confirmRegenScenes.value = true
    return
  }
  void doGenerateScenes()
}

/**
 * @description 取消重新生成场景
 * @returns {void}
 */
function cancelRegenerateScenes(): void {
  if (generating.value) return
  confirmRegenScenes.value = false
}

/**
 * @description 真正执行生成场景
 *              恢复策略分三层（优先级从高到低）：
 *              1) 按 sceneNo 匹配 → 命中即停留原场次
 *              2) 按 previousIndex 兜底 → 用户停留的列表位置不变（适合总纲微调后场数不变但 sceneNo 漂移的场景）
 *              3) 都不命中才回退“场景 01”
 *              注意：不能用旧 scene.id 匹配，因为重新生成会清空旧场景记录，新场景是全新 id
 * @returns {Promise<void>}
 */
async function doGenerateScenes(): Promise<void> {
  if (generating.value || !projectId.value) return
  confirmRegenScenes.value = false
  generating.value = true
  errorMsg.value = ''

  // 生成前快照：用户视角的"第 N 场" + 列表位置
  // 两个维度都要记，因为：
  //   - 总纲扩缩容时，sceneNo 会变，但用户可能更看重"原来第几屏"
  //   - 总纲只微调时，sceneNo 不变，但用户可能已经按位置形成习惯
  const previousSceneNo = activeScene.value?.sceneNo ?? null
  const previousIndex = activeScene.value
    ? scenes.value.findIndex((s) => s.id === activeScene.value?.id)
    : -1

  try {
    scenes.value = await generateScenes(projectId.value)
    if (scenes.value.length) {
      pageState.value = 'ready'

      // 第一优先级：sceneNo 匹配
      const matchedBySceneNo =
        previousSceneNo != null
          ? scenes.value.find((s) => s.sceneNo === previousSceneNo)
          : null
      if (matchedBySceneNo) {
        activeSceneId.value = matchedBySceneNo.id
        infoMsg.value = '已重新生成场景，并定位到原场次'
        return
      }

      // 第二优先级：原列表位置兜底（边界：下标越界视为未命中）
      const matchedByIndex =
        previousIndex >= 0 && previousIndex < scenes.value.length
          ? scenes.value[previousIndex]
          : null
      if (matchedByIndex) {
        activeSceneId.value = matchedByIndex.id
        infoMsg.value = '原场次不存在，已定位到原位置'
        return
      }

      // 第三优先级：兜底回第一场
      activeSceneId.value = scenes.value[0]?.id ?? null
      infoMsg.value = '原场次和原位置都不存在，已回到第一场'
    } else {
      pageState.value = 'empty'
      activeSceneId.value = null
      infoMsg.value = ''
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '场景生成失败'
  } finally {
    generating.value = false
  }
}

/**
 * @description 保存当前场景基础信息
 *              校验草稿是否变化，无变化则不请求
 * @returns {Promise<void>}
 */
async function saveActiveScene(): Promise<void> {
  // 先比较草稿和原始场景，避免用户只是点了保存却额外发起一次更新请求。
  const s = activeScene.value
  if (!s || saving.value) return
  if (!isDraftChanged()) {
    infoMsg.value = '未检测到修改。'
    return
  }
  saving.value = true
  errorMsg.value = ''
  try {
    const updated = await updateScene(s.id, {
      title: formDraft.value.title,
      summary: formDraft.value.summary,
      location: formDraft.value.location,
      timeOfDay: formDraft.value.timeOfDay,
      estimatedDuration: formDraft.value.estimatedDuration,
    })
    // 用返回的最新对象替换本地项
    scenes.value = scenes.value.map((it) => (it.id === updated.id ? updated : it))
    formDirty.value = false
    infoMsg.value = '场景已保存'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '场景保存失败'
  } finally {
    saving.value = false
  }
}

/**
 * @description 跳到单场剧本编辑页
 * @returns {void}
 */
function goToScriptEditor(): void {
  // 把当前项目和场景 id 带到剧本页，剧本页据此加载对应的单场内容。
  const sid = activeSceneId.value
  if (!sid) return
  router.push({
    path: '/workspace/script',
    query: { projectId: String(projectId.value), sceneId: String(sid) },
  })
}

/**
 * @description 跳到 AI 总纲页（无总纲时引导用户去生成）
 * @returns {void}
 */
function goGenerateOutline(): void {
  router.push({ path: '/workspace/script/ai', query: { projectId: String(projectId.value) } })
}

// 选中场景变化 → 同步草稿
watch(activeSceneId, () => {
  syncDraftFromActive()
})

// 路由 projectId 变化 → 重新加载
watch(
  () => route.query.projectId,
  () => {
    refreshAll()
  },
)

onMounted(() => {
  refreshAll()
})

/**
 * @description 场景状态徽章配色
 * @param {string} status
 * @returns {string}
 */
function statusTone(status: string): string {
  switch (status) {
    case 'storyboard_ready':
      return 'text-green-400'
    case 'generated':
      return 'text-primary'
    case 'revised':
      return 'text-yellow-400'
    default:
      return 'text-on-surface-variant'
  }
}
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true" :self-managed-scroll="true">
    <!-- 缺 projectId：整页友好提示 -->
    <section
      v-if="missingProjectId"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">error_outline</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少项目上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          场景拆解依附于具体项目。请先从项目控制台选择一个项目，或新建一个项目。
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="router.push('/dashboard')"
          >
            <span class="material-symbols-outlined text-sm">dashboard</span>
            前往项目控制台
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="router.push('/new')"
          >
            <span class="material-symbols-outlined text-sm">add</span>
            新建项目
          </button>
        </div>
      </div>
    </section>

    <template v-else>
      <div class="flex h-full min-h-0 overflow-hidden">
        <!-- 左侧：场景列表 -->
        <aside class="flex min-h-0 w-80 shrink-0 flex-col border-r border-outline-variant bg-surface">
          <div class="border-b border-outline-variant bg-surface-container p-4">
            <h3 class="flex items-center gap-2 font-label-md uppercase tracking-widest text-primary">
              <span class="material-symbols-outlined text-sm">format_list_bulleted</span>
              正式场景
            </h3>
            <p v-if="scenes.length" class="mt-1 text-[11px] text-on-surface-variant">
              共 {{ scenes.length }} 场
            </p>
          </div>
          <div class="flex-1 space-y-2 overflow-y-auto overscroll-y-contain p-3">
            <template v-if="pageState === 'ready' && scenes.length">
              <button
                v-for="s in scenes"
                :key="s.id"
                type="button"
                class="block w-full border p-3 text-left transition-all"
                :class="
                  activeSceneId === s.id
                    ? 'bronze-border bg-surface-container-high'
                    : 'border-outline-variant/30 bg-surface-container-low hover:border-primary/50'
                "
                @click="selectScene(s.id)"
              >
                <div class="mb-1 flex items-center justify-between">
                  <span class="text-[10px] font-bold text-primary">场景 {{ String(s.sceneNo).padStart(2, '0') }}</span>
                  <span class="text-[10px] uppercase" :class="statusTone(s.status)">
                    {{ s.status }}
                  </span>
                </div>
                <p class="truncate text-sm font-body-md text-on-surface">
                  {{ s.title || '未命名场景' }}
                </p>
                <p v-if="s.summary" class="mt-1 line-clamp-2 text-[12px] text-on-surface-variant">
                  {{ s.summary }}
                </p>
                <p v-if="s.location" class="mt-1 text-[10px] uppercase text-on-surface-variant">
                  {{ s.location }} · {{ s.timeOfDay || '—' }}
                </p>
              </button>
            </template>
            <div v-else class="p-6 text-center text-sm text-on-surface-variant">
              <template v-if="pageState === 'loading'">加载中…</template>
              <template v-else-if="pageState === 'no-outline'">请先生成总纲</template>
              <template v-else-if="pageState === 'empty'">尚未生成正式场景</template>
              <template v-else>暂无场景</template>
            </div>
          </div>
        </aside>

        <!-- 中间：详情编辑 -->
        <section class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-y-contain bg-surface-dim">
          <!-- 顶部条 -->
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant bg-surface-container p-6">
            <div>
              <h1 class="font-headline-lg text-headline-lg text-on-surface">
                {{ project?.name || '场景拆解' }}
              </h1>
              <p class="mt-1 text-sm text-on-surface-variant">
                <template v-if="pageState === 'ready' && activeScene">
                  当前编辑：场景 {{ String(activeScene.sceneNo).padStart(2, '0') }} ·
                  {{ activeScene.title || '未命名场景' }}
                  <span v-if="formDirty" class="ml-2 text-yellow-400">· 有未保存修改</span>
                </template>
                <template v-else-if="pageState === 'empty'">尚未生成正式场景</template>
                <template v-else-if="pageState === 'no-outline'">尚未生成总纲</template>
                <template v-else-if="pageState === 'loading'">加载中…</template>
                <template v-else-if="pageState === 'error'">发生错误</template>
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-if="pageState === 'no-outline'"
                type="button"
                class="flex items-center gap-2 bg-primary px-4 py-2 text-sm font-bold text-on-secondary-fixed hover:brightness-110"
                @click="goGenerateOutline"
              >
                <span class="material-symbols-outlined text-base">auto_awesome</span>
                去生成项目总纲
              </button>
              <button
                v-else
                type="button"
                class="flex items-center gap-2 border border-primary/40 bg-primary/5 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/10 disabled:opacity-50"
                :disabled="generating"
                @click="requestGenerateScenes"
              >
                <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': generating }">
                  {{ generating ? 'progress_activity' : 'movie' }}
                </span>
                {{ generating ? '生成中…' : (scenes.length ? '重新生成场景' : '生成场景') }}
              </button>
              <button
                type="button"
                class="flex items-center gap-2 border border-primary bg-primary px-4 py-2 text-sm font-bold text-on-secondary-fixed transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="saving || !activeScene || !isDraftChanged()"
                @click="saveActiveScene"
              >
                <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': saving }">
                  {{ saving ? 'progress_activity' : 'save' }}
                </span>
                {{ saving ? '保存中…' : '保存场景' }}
              </button>
              <button
                type="button"
                class="flex items-center gap-2 bg-primary px-4 py-2 text-sm font-bold text-on-secondary-fixed transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!activeScene"
                @click="goToScriptEditor"
              >
                <span class="material-symbols-outlined text-base">edit_note</span>
                进入剧本
              </button>
            </div>
          </div>

          <!-- 提示条 -->
          <div
            v-if="errorMsg"
            class="m-6 border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400"
          >
            {{ errorMsg }}
          </div>
          <div
            v-else-if="infoMsg"
            class="m-6 border border-primary/40 bg-primary/5 px-4 py-2 text-sm text-primary"
          >
            {{ infoMsg }}
          </div>

          <!-- loading 骨架 -->
          <div
            v-if="pageState === 'loading'"
            class="m-6 animate-pulse space-y-3"
            aria-busy="true"
            aria-label="场景拆解页加载中"
          >
            <div class="h-6 w-40 bg-surface-container-high"></div>
            <div class="h-3 w-full bg-surface-container-high"></div>
            <div class="h-3 w-2/3 bg-surface-container-high"></div>
            <div class="h-3 w-1/2 bg-surface-container-high"></div>
          </div>

          <!-- error 卡片 -->
          <div
            v-else-if="pageState === 'error'"
            class="m-6 border border-red-500/40 bg-red-500/10 p-6"
          >
            <div class="mb-2 flex items-center gap-2 text-red-400">
              <span class="material-symbols-outlined text-base">error</span>
              <span class="text-xs font-bold uppercase tracking-widest">场景模块异常</span>
            </div>
            <p class="mb-4 text-sm text-on-surface">{{ errorMsg || '加载失败' }}</p>
            <button
              type="button"
              class="flex items-center gap-2 border border-primary bg-primary/10 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/20"
              @click="refreshAll"
            >
              <span class="material-symbols-outlined text-sm">refresh</span>
              重新加载
            </button>
          </div>

          <!-- no-outline 空态 -->
          <div
            v-else-if="pageState === 'no-outline'"
            class="m-6 flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-10 text-center"
          >
            <span class="material-symbols-outlined mb-3 text-5xl text-primary">auto_awesome</span>
            <p class="mb-1 font-headline-md text-headline-md text-on-surface">请先生成项目总纲</p>
            <p class="mb-5 max-w-md text-sm text-on-surface-variant">
              正式场景必须基于已落地的总纲生成。点击下方按钮跳到总纲页，先完成"重做项目总纲"。
            </p>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed transition-all hover:brightness-110"
              @click="goGenerateOutline"
            >
              <span class="material-symbols-outlined text-sm">auto_awesome</span>
              去生成项目总纲
            </button>
          </div>

          <!-- empty 空态：有总纲但还没正式场景 -->
          <div
            v-else-if="pageState === 'empty'"
            class="m-6 flex flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-low px-6 py-10 text-center"
          >
            <span class="material-symbols-outlined mb-3 text-5xl text-primary">movie</span>
            <p class="mb-1 font-headline-md text-headline-md text-on-surface">尚未生成正式场景</p>
            <p class="mb-5 max-w-md text-sm text-on-surface-variant">
              总纲已就绪，点击下方按钮把总纲预览场景写入正式场景表。
            </p>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed transition-all hover:brightness-110 disabled:opacity-50"
              :disabled="generating"
              @click="requestGenerateScenes"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generating }">
                {{ generating ? 'progress_activity' : 'movie' }}
              </span>
              {{ generating ? '生成中…' : '生成场景' }}
            </button>
          </div>

          <!-- ready：场景详情编辑 -->
          <div
            v-else-if="pageState === 'ready' && activeScene"
            class="m-6 border border-outline-variant bg-surface-container p-6"
          >
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label class="block md:col-span-2">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  场景标题
                </span>
                <input
                  v-model="formDraft.title"
                  type="text"
                  class="w-full border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                  placeholder="例：霓虹走廊的对峙"
                  @input="formDirty = true"
                />
              </label>

              <label class="block md:col-span-2">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  场景摘要
                </span>
                <textarea
                  v-model="formDraft.summary"
                  rows="4"
                  class="w-full border border-outline-variant bg-surface-container-low px-3 py-2 text-sm leading-relaxed text-on-surface focus:border-primary focus:outline-none"
                  placeholder="描述这一场戏要发生什么、目标、冲突……"
                  @input="formDirty = true"
                />
              </label>

              <label class="block">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  地点
                </span>
                <input
                  v-model="formDraft.location"
                  type="text"
                  class="w-full border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                  placeholder="例：废弃实验室"
                  @input="formDirty = true"
                />
              </label>

              <label class="block">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  时间
                </span>
                <input
                  v-model="formDraft.timeOfDay"
                  type="text"
                  class="w-full border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                  placeholder="例：夜 / 黄昏"
                  @input="formDirty = true"
                />
              </label>

              <label class="block">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  预估时长（秒）
                </span>
                <input
                  v-model.number="formDraft.estimatedDuration"
                  type="number"
                  min="1"
                  class="w-full border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none"
                  placeholder="例：120"
                  @input="formDirty = true"
                />
              </label>

              <label class="block">
                <span class="mb-1 block text-xs font-bold uppercase tracking-widest text-on-surface-variant">
                  状态
                </span>
                <div class="flex h-[42px] items-center border border-outline-variant bg-surface-container-low/50 px-3 text-sm text-on-surface-variant">
                  <span class="uppercase" :class="statusTone(activeScene.status)">
                    {{ activeScene.status }}
                  </span>
                  <span class="ml-2 text-[10px] text-on-surface-variant">
                    （由系统维护，不可在本页修改）
                  </span>
                </div>
              </label>
            </div>

            <div class="mt-6 flex items-center justify-between text-xs text-on-surface-variant">
              <span>
                场景 ID：<span class="font-mono text-on-surface">#{{ activeScene.id }}</span>
                · 序号：<span class="font-mono text-on-surface">{{ String(activeScene.sceneNo).padStart(2, '0') }}</span>
              </span>
              <span v-if="formDirty" class="text-yellow-400">有未保存的修改</span>
            </div>
          </div>
        </section>
      </div>

      <!--
        重新生成场景的二次确认弹窗
      -->
      <div
        v-if="confirmRegenScenes"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-regen-scenes-title"
        @click.self="cancelRegenerateScenes"
      >
        <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
          <div class="mb-3 flex items-center gap-3">
            <span class="material-symbols-outlined text-3xl text-yellow-400">warning</span>
            <h2 id="confirm-regen-scenes-title" class="font-headline-md text-headline-md text-on-surface">
              确认重新生成场景？
            </h2>
          </div>
          <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
            <p>
              此操作会基于当前总纲覆盖项目下所有正式场景。所有手工修改（标题、摘要、地点、时间、时长）都会被清空。
            </p>
            <p class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-400">
              当前项目已有 <span class="font-bold">{{ scenes.length }}</span> 个正式场景，继续后这些场景将被覆盖。
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
              @click="cancelRegenerateScenes"
            >
              取消
            </button>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="generating"
              @click="doGenerateScenes"
            >
              <span v-if="generating" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
              继续覆盖
            </button>
          </div>
        </div>
      </div>

      <!--
        切换场景前：未保存修改确认弹窗
        - 标题：未保存的修改
        - 正文：明确告诉用户"切换会丢哪些字段"
        - 按钮：先给"取消"（用户最可能想做的），
                再给"丢弃并切换"（强调是不可逆操作）
      -->
      <div
        v-if="pendingSwitchSceneId != null"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-discard-title"
        @click.self="cancelSwitchScene"
      >
        <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
          <div class="mb-3 flex items-center gap-3">
            <span class="material-symbols-outlined text-3xl text-yellow-400">edit_note</span>
            <h2 id="confirm-discard-title" class="font-headline-md text-headline-md text-on-surface">
              当前场景有未保存的修改
            </h2>
          </div>
          <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
            <p>
              切换到其他场景前需要确认。已修改的字段（标题、摘要、地点、时间、预估时长）尚未保存到数据库。
            </p>
            <p class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-400">
              如果继续切换，这些修改将被丢弃，且无法恢复。
            </p>
          </div>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
              @click="cancelSwitchScene"
            >
              取消
            </button>
            <button
              type="button"
              class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110"
              @click="confirmDiscardAndSwitch"
            >
              <span class="material-symbols-outlined text-sm">delete_sweep</span>
              丢弃修改并切换
            </button>
          </div>
        </div>
      </div>
    </template>
  </WorkspaceLayout>
</template>
