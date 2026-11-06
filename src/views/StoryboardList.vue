<script setup lang="ts">
/**
 * @file 单场景分镜列表
 * @description 从 query.projectId / query.sceneId 读取上下文，
 *              加载当前场景的分镜列表（GET /api/scenes/:id/storyboards），
 *              支持生成分镜 / 重新生成分镜（POST /api/scenes/:id/storyboards/generate），
 *              点击镜头卡片跳到当前分镜视频创作工作台。
 *
 *              状态机：missing-project / missing-scene / loading / error / empty / ready
 *              核心保护：
 *                1) scene.content 为空时禁用生成分镜（前置依赖）
 *                2) 重新生成分镜前弹二次确认（后端是 DELETE + 重建，不是追加）
 *                3) 校验 scene.projectId === projectId.value（防手改 URL）
 *                4) snapshot 防御：进行中切换场景时回包不污染状态
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  generateStoryboards,
  getProject,
  getScene,
  listStoryboards,
  type ProjectDTO,
  type SceneDTO,
  type StoryboardDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'
import { formatAggregateDuration, formatShotDuration } from '@/lib/episode-clips.mjs'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)

/**
 * @description 页面状态机
 *              - missing-project  query 缺 projectId
 *              - missing-scene    query 缺 sceneId
 *              - loading          首次加载
 *              - error            接口失败
 *              - empty            scene 已加载但 shots.length === 0（仍可生成分镜）
 *              - ready            有分镜数据
 */
type PageState = 'missing-project' | 'missing-scene' | 'loading' | 'error' | 'empty' | 'ready'
const pageState = ref<PageState>('loading')

const project = ref<ProjectDTO | null>(null)
const scene = ref<SceneDTO | null>(null)
const shots = ref<StoryboardDTO[]>([])

const errorMsg = ref('')
const infoMsg = ref('')
const generating = ref(false)

// 重新生成分镜的二次确认弹窗
const confirmRegenerate = ref(false)

/**
 * @description 把当前的 projectId / sceneId 拍一张快照
 *              用于拦截"用户中途切换场景导致过期回包覆盖正确状态"
 * @returns {{ projectId: number; sceneId: number }}
 */
function snapshotContext(): { projectId: number; sceneId: number } {
  return { projectId: projectId.value, sceneId: sceneId.value }
}

/**
 * @description 比对当前上下文与快照是否一致
 * @param {{ projectId: number; sceneId: number }} snap
 * @returns {boolean} true 表示已过期
 */
function isContextChanged(snap: { projectId: number; sceneId: number }): boolean {
  return snap.projectId !== projectId.value || snap.sceneId !== sceneId.value
}

/**
 * @description 当前场景是否已有剧本正文
 *              一期硬要求：scene.content 为空时禁止生成分镜
 */
const sceneHasContent = computed<boolean>(() => Boolean((scene.value?.content || '').trim()))

/**
 * @description 分镜预计总时长（秒）
 */
const totalDuration = computed<number>(() =>
  shots.value.reduce((sum, s) => sum + (s.durationSeconds || 0), 0),
)

/**
 * @description 把后端 status 翻译成中文/颜色
 *              status 取值：pending / generating / done / failed
 */
function statusMeta(status: string): { text: string; cls: string } {
  switch (status) {
    case 'done':
      return { text: '已完成', cls: 'bg-green-900/80 text-green-400' }
    case 'generating':
      return { text: '生成中', cls: 'bg-primary-container/80 text-black' }
    case 'failed':
      return { text: '失败', cls: 'bg-red-900/80 text-red-400' }
    case 'pending':
    default:
      return { text: '等待生成', cls: 'bg-on-surface-variant/20 text-on-surface-variant' }
  }
}

/**
 * @description 拉取项目（纯 getter，不写 ref）
 * @returns {Promise<ProjectDTO>}
 * @throws {Error}
 */
async function fetchProject(): Promise<ProjectDTO> {
  if (!projectId.value) throw new Error('缺少 projectId 参数')
  const p = await getProject(projectId.value)
  if (!p) throw new Error('项目不存在或无权访问')
  return p
}

/**
 * @description 拉取当前场景（纯 getter，不写 ref）
 *              校验：scene.projectId === projectId.value
 * @returns {Promise<SceneDTO>}
 * @throws {Error} 接口失败 / scene 不属于当前项目
 */
async function fetchScene(): Promise<SceneDTO> {
  if (!sceneId.value) throw new Error('缺少 sceneId 参数')
  const s = await getScene(sceneId.value)
  if (!s) throw new Error('场景不存在或无权访问')
  if (projectId.value && s.projectId !== projectId.value) {
    throw new Error('该场景不属于当前项目，请检查 URL 参数')
  }
  return s
}

/**
 * @description 拉取分镜列表（纯 getter，不写 ref）
 * @returns {Promise<StoryboardDTO[]>}
 * @throws {Error}
 */
async function fetchShots(): Promise<StoryboardDTO[]> {
  if (!sceneId.value) throw new Error('缺少 sceneId 参数')
  const list = await listStoryboards(sceneId.value)
  return Array.isArray(list) ? list : []
}

/**
 * @description 完整加载：项目 + 场景 + 分镜
 *              fetchXxx 都是纯函数，本函数是唯一的状态提交入口
 * @returns {Promise<void>}
 */
async function loadAll(): Promise<void> {
  // 项目、场景、分镜要作为同一页面快照提交，避免不同场景的数据拼到一起。
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }
  if (!sceneId.value) {
    pageState.value = 'missing-scene'
    return
  }
  const snap = snapshotContext()
  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const proj = await fetchProject()
    if (isContextChanged(snap)) return
    const sc = await fetchScene()
    if (isContextChanged(snap)) return
    const list = await fetchShots()
    if (isContextChanged(snap)) return
    // 一次性原子提交
    project.value = proj
    scene.value = sc
    shots.value = list
    pageState.value = list.length ? 'ready' : 'empty'
    setWorkspaceContext({ projectId: proj.id, sceneId: sc.id })
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '分镜加载失败'
    pageState.value = 'error'
  }
}

/**
 * @description 点击"生成分镜"或"重新生成分镜"的入口
 *              - 无分镜：直接调
 *              - 已有分镜：弹二次确认
 * @returns {void}
 */
function onRequestGenerate(): void {
  // 用户点击按钮时先判断依赖和是否已有分镜，再决定直接生成还是弹确认框。
  if (generating.value || !sceneId.value) return
  // 前置依赖：当前场景必须有剧本正文
  if (!sceneHasContent.value) {
    errorMsg.value = '当前场景还没有剧本内容，请先回到单场剧本页编辑或生成剧本'
    infoMsg.value = ''
    return
  }
  if (shots.value.length > 0) {
    confirmRegenerate.value = true
    return
  }
  void doGenerate()
}

/**
 * @description 取消重新生成分镜
 * @returns {void}
 */
function cancelRegenerate(): void {
  confirmRegenerate.value = false
}

/**
 * @description 真正执行生成分镜 / 重新生成分镜
 *              后端语义：DELETE FROM storyboards WHERE scene_id = ?，再生成新的
 *              不会追加，是覆盖
 * @returns {Promise<void>}
 */
async function doGenerate(): Promise<void> {
  // 重新生成采用覆盖语义：服务端会先删除当前场景旧分镜，再写入新结果。
  if (generating.value || !sceneId.value) return
  confirmRegenerate.value = false
  const snap = snapshotContext()
  const targetSceneId = sceneId.value
  generating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const list = await generateStoryboards(targetSceneId)
    if (isContextChanged(snap)) return
    shots.value = Array.isArray(list) ? list : []
    pageState.value = shots.value.length ? 'ready' : 'empty'
    infoMsg.value = shots.value.length ? '分镜已重新生成' : '分镜已清空'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '分镜生成失败'
  } finally {
    generating.value = false
  }
}

/**
 * @description 跳到单镜头编辑页
 * @param {number} shotId
 * @returns {void}
 */
function openShot(shotId: number): void {
  if (generating.value) return
  router.push({
    path: '/workspace/episodes/studio',
    query: {
      projectId: String(projectId.value),
      sceneId: String(sceneId.value),
      episodeNo: String(scene.value?.episodeNo || 1),
      storyboardId: String(shotId),
    },
  })
}

/**
 * @description 返回项目总览
 * @returns {void}
 */
function backToDashboard(): void {
  router.push('/dashboard')
}

/**
 * @description 跳到 AI 剧本页（带 projectId 引导选场景）
 * @returns {void}
 */
function backToAIScript(): void {
  if (projectId.value) {
    router.push({
      path: '/workspace/script/ai',
      query: { projectId: String(projectId.value), needScene: '1' },
    })
  } else {
    router.push('/dashboard')
  }
}

/**
 * @description 跳到当前场景的单场剧本页（用于"剧本为空"引导）
 * @returns {void}
 */
function backToScriptEditor(): void {
  if (projectId.value && sceneId.value) {
    router.push({
      path: '/workspace/script',
      query: { projectId: String(projectId.value), sceneId: String(sceneId.value) },
    })
  } else if (projectId.value) {
    router.push({ path: '/workspace/scenes', query: { projectId: String(projectId.value) } })
  } else {
    router.push('/dashboard')
  }
}

/**
 * @description 重新加载（错误态重试用）
 * @returns {Promise<void>}
 */
async function retry(): Promise<void> {
  await loadAll()
}

// 路由参数变化时重新加载
watch(
  () => [route.query.projectId, route.query.sceneId],
  () => {
    void loadAll()
  },
)

onMounted(() => {
  void loadAll()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <!-- 缺 projectId / sceneId：整页友好提示 -->
    <section
      v-if="pageState === 'missing-project' || pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">movie_filter</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">
          缺少{{ pageState === 'missing-project' ? '项目' : '场景' }}上下文
        </h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          <template v-if="pageState === 'missing-scene'">
            分镜依附于具体场景。请先到 AI 剧本页选择一个场景，再为它生成分镜。
          </template>
          <template v-else>
            分镜依附于具体项目。请先进入一个项目，并为其中的场景生成分镜。
          </template>
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface hover:border-primary hover:text-primary"
            @click="backToDashboard"
          >
            <span class="material-symbols-outlined text-sm">dashboard</span>
            返回项目总览
          </button>
          <button
            v-if="pageState === 'missing-scene' && projectId"
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="backToAIScript"
          >
            <span class="material-symbols-outlined text-sm">edit_note</span>
            去 AI 剧本页选场景
          </button>
        </div>
      </div>
    </section>

    <!-- 加载中 -->
    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center text-sm text-on-surface-variant"
    >
      加载分镜中...
    </div>

    <!-- 错误态 -->
    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-red-500/40 bg-red-500/5 p-6">
        <h3 class="mb-2 font-bold text-red-400">分镜加载失败</h3>
        <p class="mb-4 text-sm text-on-surface-variant">{{ errorMsg || '请稍后重试' }}</p>
        <button
          type="button"
          class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
          @click="retry"
        >
          <span class="material-symbols-outlined text-sm">refresh</span>
          重新加载
        </button>
      </div>
    </section>

    <!-- 主界面：ready / empty 共用布局 -->
    <main
      v-else
      class="custom-scrollbar scroll-optimized h-full overflow-y-auto overscroll-y-contain bg-surface-dim p-margin-md pb-32"
    >
      <!-- 顶部信息区 -->
      <header class="mb-6 flex items-end justify-between border-b border-outline-variant pb-6">
        <div>
          <h1 class="mb-1 font-headline-lg text-headline-lg text-on-surface">
            分镜看板
            <span v-if="scene" class="ml-2 font-body-md text-body-md text-primary-container">
              · 场次 {{ String(scene.sceneNo).padStart(2, '0') }}：{{ scene.title || '未命名场景' }}
            </span>
          </h1>
          <p class="text-body-md text-on-surface-variant">
            <span v-if="project">项目：{{ project.name }} · </span>
            共 {{ shots.length }} 个镜头 · 预计总时长 {{ formatAggregateDuration(totalDuration) }}
          </p>
        </div>
        <div class="flex gap-2">
          <button
            type="button"
            class="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
            :class="shots.length
              ? 'border border-yellow-500/40 bg-yellow-500/5 text-yellow-400 hover:border-yellow-500 hover:bg-yellow-500/10'
              : 'border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'"
            :disabled="generating || !sceneHasContent"
            :title="!sceneHasContent
              ? '当前场景没有剧本内容，请先编辑或生成剧本'
              : (shots.length ? '重新生成分镜（会覆盖旧分镜）' : '生成分镜')"
            @click="onRequestGenerate"
          >
            <span
              class="material-symbols-outlined text-sm"
              :class="{ 'animate-spin': generating }"
            >
              {{ generating ? 'progress_activity' : (shots.length ? 'refresh' : 'auto_awesome') }}
            </span>
            {{ generating ? '生成中...' : (shots.length ? '重新生成分镜' : '生成分镜') }}
          </button>
        </div>
      </header>

      <div v-if="errorMsg" class="mb-4 border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-400">
        {{ errorMsg }}
      </div>
      <div v-if="infoMsg" class="mb-4 border border-green-500/40 bg-green-500/10 px-4 py-2 text-sm text-green-400">
        {{ infoMsg }}
      </div>

      <!-- 剧本为空提示（即便 shots 为空也单独展示，禁用"生成分镜"按钮） -->
      <div
        v-if="!sceneHasContent"
        class="mb-4 flex items-center justify-between border border-yellow-500/40 bg-yellow-500/5 px-4 py-3"
      >
        <div class="flex items-center gap-3 text-sm text-on-surface">
          <span class="material-symbols-outlined text-yellow-400">edit_note</span>
          <div>
            <p class="font-bold text-on-surface">当前场景还没有剧本内容</p>
            <p class="text-xs text-on-surface-variant">
              分镜必须基于剧本生成。请先回到单场剧本页编辑或生成剧本，再来生成分镜。
            </p>
          </div>
        </div>
        <button
          type="button"
          class="flex items-center gap-2 bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
          @click="backToScriptEditor"
        >
          <span class="material-symbols-outlined text-sm">edit_note</span>
          去编辑剧本
        </button>
      </div>

      <!-- 列表区 -->
      <div v-if="pageState === 'ready'" class="grid grid-cols-1 gap-8 lg:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="shot in shots"
          :key="shot.id"
          class="shot-card cv-auto group relative cursor-pointer border border-outline-variant bg-surface-charcoal transition-all duration-300 hover:border-primary"
          @click="openShot(shot.id)"
        >
          <div class="shot-card-header flex items-start justify-between gap-3 border-b border-outline-variant/70 bg-surface-container px-4 py-3">
            <div class="bg-black/80 px-2 py-1 text-[10px] font-bold tracking-widest text-primary">
              SHOT {{ shot.shotNo }}
            </div>
            <span :class="['shrink-0 whitespace-nowrap px-2 py-0.5 text-[10px] font-bold', statusMeta(shot.status).cls]">
              {{ statusMeta(shot.status).text }}
            </span>
          </div>
          <div class="bg-surface-container-low p-4">
            <div class="mb-2 flex items-start justify-between">
              <div>
                <div class="mb-1 text-[10px] uppercase tracking-tighter text-on-surface-variant">景别 / 时长</div>
                <div class="flex gap-2">
                  <span class="font-bold text-label-md text-on-surface">{{ shot.shotType || '—' }}</span>
                  <span class="font-bold text-label-md text-primary-container">{{ formatShotDuration(shot.durationSeconds) }}</span>
                </div>
              </div>
              <div class="text-right">
                <div class="mb-1 text-[10px] uppercase tracking-tighter text-on-surface-variant">角色</div>
                <div class="font-bold text-label-md text-on-surface">{{ shot.characterName || '—' }}</div>
              </div>
            </div>
            <div class="mb-2 text-[10px] uppercase tracking-tighter text-on-surface-variant">机位 / 构图</div>
            <div class="mb-3 flex gap-2 text-xs text-on-surface-variant">
              <span>{{ shot.cameraAngle || '—' }}</span>
              <span class="text-outline-variant">·</span>
              <span>{{ shot.composition || '—' }}</span>
            </div>
            <div class="line-clamp-2 text-label-md italic leading-relaxed text-on-surface-variant">
              {{ shot.actionText || '—' }}
            </div>
            <div v-if="shot.dialogueText" class="mt-2 border-l-2 border-primary/40 pl-2 text-[11px] italic text-on-surface-variant">
              "{{ shot.dialogueText }}"
            </div>
            <div v-if="shot.visualPrompt" class="mt-2 text-[10px] text-on-surface-variant/70 line-clamp-2">
              <span class="font-bold">PROMPT:</span> {{ shot.visualPrompt }}
            </div>
          </div>
        </div>
      </div>

      <!-- empty 态 -->
      <div
        v-else-if="pageState === 'empty'"
        class="flex min-h-[300px] flex-col items-center justify-center border border-dashed border-outline-variant bg-surface-container-lowest/50 text-on-surface-variant"
      >
        <span class="material-symbols-outlined mb-2 text-4xl">movie</span>
        <p class="font-bold uppercase tracking-widest text-label-md">分镜为空</p>
        <p class="mt-1 text-sm">
          {{ sceneHasContent ? '点击右上角「生成分镜」开始自动拆分' : '请先编辑或生成剧本，再生成分镜' }}
        </p>
      </div>
    </main>

    <!--
      重新生成分镜的二次确认弹窗
      - 后端语义是 DELETE 旧 + 重建，不是追加
      - 文案明确写清楚"覆盖"
    -->
    <div
      v-if="confirmRegenerate"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-regen-storyboard-title"
      @click.self="cancelRegenerate"
    >
      <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-3 flex items-center gap-3">
          <span class="material-symbols-outlined text-3xl text-yellow-400">warning</span>
          <h2 id="confirm-regen-storyboard-title" class="font-headline-md text-headline-md text-on-surface">
            确认重新生成分镜？
          </h2>
        </div>
        <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
          <p>
            此操作会基于当前场景的剧本重新生成分镜。当前场景下已有
            <span class="font-bold text-on-surface">{{ shots.length }}</span>
            个镜头将被清空，并替换为新生成的分镜。
          </p>
          <p class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-400">
            重新生成会<strong>覆盖</strong>当前分镜，不是追加。
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="cancelRegenerate"
          >
            取消
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="generating"
            @click="doGenerate"
          >
            <span v-if="generating" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            继续覆盖
          </button>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>
