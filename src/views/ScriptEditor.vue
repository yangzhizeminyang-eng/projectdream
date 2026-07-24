<script setup lang="ts">
/**
 * @file 单场剧本编辑器
 * @description 从 query.projectId / query.sceneId 读取上下文，
 *              加载场景列表 + 当前剧本，支持：
 *              - 首次生成剧本 / 重写当前场景剧本（二次确认）
 *              - 手动编辑 content / mood / title 并保存
 *              - 进入分镜模块（要求剧本非空）
 *              状态机：loading / error / no-project / no-scene / ready
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  generateSceneScript,
  generateStoryboards,
  getProject,
  getScene,
  listScenes,
  saveSceneScript,
  type ProjectDTO,
  type SceneDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)

/**
 * @description 页面状态机
 *              - loading     初次加载
 *              - error       任一接口失败
 *              - no-project  query 缺 projectId
 *              - no-scene    query 缺 sceneId
 *              - ready       进入可编辑 / 可操作的工作台
 */
type PageState = 'loading' | 'error' | 'no-project' | 'no-scene' | 'ready'
const pageState = ref<PageState>('loading')

const project = ref<ProjectDTO | null>(null)
const scenes = ref<SceneDTO[]>([])
const currentScene = ref<SceneDTO | null>(null)

// 编辑器草稿（与 currentScene 分离：dirty 判定 + 切场景保护都依赖它）
const draftTitle = ref('')
const draftContent = ref('')
const draftMood = ref('')
const contentTextarea = ref<HTMLTextAreaElement | null>(null)

const saving = ref(false)
const generating = ref(false)
const generatingStoryboard = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')

// 重写剧本的二次确认：把目标 sceneId 暂存，避免直接覆盖 draft
const confirmRewriteScript = ref(false)

// 切换场景的脏数据确认：待切换的目标 sceneId
const pendingSwitchSceneId = ref<number | null>(null)

/**
 * @description 表单是否处于 dirty 状态（与 currentScene 基线对比）
 *              用于：禁用"重写"/"生成分镜"时的提示；切换场景前的事前确认
 */
const isDraftDirty = computed<boolean>(() => {
  const s = currentScene.value
  if (!s) return false
  const baseTitle = s.title || ''
  const baseContent = s.content || ''
  const baseMood = s.mood || ''
  return draftTitle.value !== baseTitle || draftContent.value !== baseContent || draftMood.value !== baseMood
})

/**
 * @description 当前场景是否已有正文（用于决定按钮文案 + 走哪条生成路径）
 */
const hasContent = computed<boolean>(() => Boolean((currentScene.value?.content || '').trim()))

/**
 * @description 同步编辑器草稿 ← currentScene 基线
 *              切场景、保存成功、生成成功后都会调一次
 * @returns {void}
 */
function syncDraftFromScene(): void {
  const s = currentScene.value
  draftTitle.value = s?.title || ''
  draftContent.value = s?.content || ''
  draftMood.value = s?.mood || ''
}

function syncContentTextareaHeight(): void {
  const el = contentTextarea.value
  if (!el) return
  el.style.height = 'auto'
  const minHeight = Math.round(window.innerHeight * 0.5)
  el.style.height = `${Math.max(el.scrollHeight, minHeight)}px`
}

/**
 * @description 拉取项目 + 场景列表（纯函数 / getter）
 *              不写任何 ref；返回的数据由 loadAll 在 snapshot 校验通过后统一提交
 *              防止旧请求 await 返回后先写 ref 再被判定过期，造成脏数据已经落库
 *              任一接口失败必须抛错，不能本地吞；否则 loadAll 不知道发生了异常
 * @returns {Promise<{ fetched: ProjectDTO; list: SceneDTO[] }>}
 * @throws {Error} 接口失败 / 缺 projectId
 */
async function loadBase(): Promise<{ fetched: ProjectDTO; list: SceneDTO[] }> {
  if (!projectId.value) throw new Error('缺少 projectId 参数')
  const fetched = await getProject(projectId.value)
  if (!fetched) {
    throw new Error('项目不存在或无权访问')
  }
  const list = await listScenes(projectId.value)
  return { fetched, list: Array.isArray(list) ? list : [] }
}

/**
 * @description 加载当前场景详情（纯函数 / getter）
 *              不写任何 ref；返回的数据由 loadAll 在 snapshot 校验通过后统一提交
 *              注意：必须校验 scene.projectId === projectId.value
 *              防御场景：用户手改 URL（?projectId=1&sceneId=999）或前端路由 bug
 *              把别项目的 scene 拿过来当 currentScene
 * @returns {Promise<SceneDTO>}
 * @throws {Error} 接口失败 / scene 不属于当前项目 / 缺 sceneId
 */
async function loadScene(): Promise<SceneDTO> {
  if (!sceneId.value) throw new Error('缺少 sceneId 参数')
  const scene = await getScene(sceneId.value)
  if (!scene) throw new Error('场景不存在或无权访问')
  if (projectId.value && scene.projectId !== projectId.value) {
    throw new Error('该场景不属于当前项目，请检查 URL 参数')
  }
  return scene
}

/**
 * @description 完整加载：项目 + 列表 + 当前场景；任一阶段失败切 error
 *              关键：loadBase / loadScene 都是纯函数，不写 ref。
 *              本函数是唯一的状态提交入口：snapshot 校验通过后才一次性写 ref。
 *              这把"过期回包已写 ref 再 return"这个时序坑彻底堵上。
 * @returns {Promise<void>}
 */
async function loadAll(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'no-project'
    return
  }
  if (!sceneId.value) {
    pageState.value = 'no-scene'
    return
  }
  const snap = snapshotContext()
  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const base = await loadBase()
    if (isContextChanged(snap)) return
    const scene = await loadScene()
    if (isContextChanged(snap)) return
    // 一次性原子提交：所有 ref 写操作都在 snapshot 通过后集中执行
    project.value = base.fetched
    scenes.value = base.list
    currentScene.value = scene
    syncDraftFromScene()
    setWorkspaceContext({ projectId: projectId.value || scene.projectId, sceneId: scene.id })
    pageState.value = 'ready'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '页面加载失败'
    pageState.value = 'error'
  }
}

/**
 * @description 把当前的 projectId / sceneId 拍一张快照
 *              用于拦截"用户中途切换场景导致过期回包覆盖正确状态"
 *              这是 requestToken 方案的变体，能直接看出是哪个参数变了
 * @returns {{ projectId: number; sceneId: number }}
 */
function snapshotContext(): { projectId: number; sceneId: number } {
  return { projectId: projectId.value, sceneId: sceneId.value }
}

/**
 * @description 比对当前上下文与快照是否一致；不一致说明用户已切换场景
 * @param {{ projectId: number; sceneId: number }} snap
 * @returns {boolean} true 表示已过期
 */
function isContextChanged(snap: { projectId: number; sceneId: number }): boolean {
  return snap.projectId !== projectId.value || snap.sceneId !== sceneId.value
}

/**
 * @description 切换场景
 *              保护分两段：
 *              1) in-flight 保护：saving / generating / generatingStoryboard 任一为 true → 禁止切换
 *                 避免 A 场景发起的请求回包污染 B 场景
 *              2) dirty 保护：编辑器有未保存修改 → 弹确认，用户选"丢弃"才真正切换
 * @param {number} id
 * @returns {void}
 */
function selectScene(id: number): void {
  if (sceneId.value === id) return
  if (saving.value || generating.value || generatingStoryboard.value) {
    errorMsg.value = '当前操作进行中，请稍候再切换场景'
    infoMsg.value = ''
    return
  }
  if (isDraftDirty.value) {
    pendingSwitchSceneId.value = id
    return
  }
  router.replace({
    path: '/workspace/script',
    query: { projectId: String(projectId.value), sceneId: String(id) },
  })
}

/**
 * @description 确认丢弃修改并切换到目标场景
 *              必须把三个 draft 都显式重置到 currentScene 基线（别让注释吞掉某一行）
 *              之后再 router.replace，由 watch 触发 loadAll 重新拉取
 * @returns {void}
 */
function confirmDiscardAndSwitch(): void {
  const target = pendingSwitchSceneId.value
  pendingSwitchSceneId.value = null
  if (target == null) return
  // 三条赋值独立成行，避免被同行注释吞掉导致部分字段漏重置
  draftTitle.value = currentScene.value?.title || ''
  draftContent.value = currentScene.value?.content || ''
  draftMood.value = currentScene.value?.mood || ''
  router.replace({
    path: '/workspace/script',
    query: { projectId: String(projectId.value), sceneId: String(target) },
  })
}

/**
 * @description 取消切换
 * @returns {void}
 */
function cancelSwitchScene(): void {
  pendingSwitchSceneId.value = null
}

/**
 * @description 保存剧本：content / mood / title
 *              未检测到变化时静默不请求，给个 info 提示
 *              snapshot 防御：保存中切换场景，A 的回包不会污染 B
 * @returns {Promise<void>}
 */
async function onSave(): Promise<void> {
  if (saving.value || !currentScene.value) return
  if (!isDraftDirty.value) {
    infoMsg.value = '未检测到修改'
    return
  }
  const snap = snapshotContext()
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await saveSceneScript(currentScene.value.id, {
      content: draftContent.value,
      mood: draftMood.value,
      title: draftTitle.value,
    })
    if (isContextChanged(snap)) return
    currentScene.value = updated
    syncDraftFromScene()
    scenes.value = scenes.value.map((s) => (s.id === updated.id ? updated : s))
    infoMsg.value = '剧本已保存'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

/**
 * @description AI 生成 / 重写剧本的入口
 *              任何 dirty（标题 / 正文 / 情绪 改动）都要走二次确认：
 *              - 有正文：本来就该二次确认（重写）
 *              - 无正文：用户可能改了 title / mood，AI 生成会覆盖 currentScene 并 sync 草稿，
 *                        dirty 部分会被静默吞掉，所以也走确认
 *              只有"无正文 + 无任何 dirty"才是真正的"首次生成"，才直接调接口
 * @returns {void}
 */
function onRequestGenerate(): void {
  if (generating.value || !currentScene.value) return
  if (hasContent.value || isDraftDirty.value) {
    confirmRewriteScript.value = true
    return
  }
  void doGenerateScript()
}

/**
 * @description 取消重写确认
 * @returns {void}
 */
function cancelRewriteScript(): void {
  confirmRewriteScript.value = false
}

/**
 * @description 真正执行 AI 生成 / 重写剧本
 *              成功后用 server 返回的更新项替换 currentScene，并把 status 改回 'generated'
 *              snapshot 防御：生成中切换场景，A 的回包不会污染 B
 * @returns {Promise<void>}
 */
async function doGenerateScript(): Promise<void> {
  if (generating.value || !currentScene.value) return
  confirmRewriteScript.value = false
  const snap = snapshotContext()
  generating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await generateSceneScript(currentScene.value.id)
    if (isContextChanged(snap)) return
    currentScene.value = updated
    syncDraftFromScene()
    scenes.value = scenes.value.map((s) => (s.id === updated.id ? updated : s))
    infoMsg.value = '剧本已重新生成'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '剧本生成失败'
  } finally {
    generating.value = false
  }
}

/**
 * @description 生成分镜，跳转到分镜列表
 *              要求当前场景已有剧本内容；没有时给错误提示并阻断
 *              两道快照防御：
 *              1) 发起请求前 snap1：生成中切场景，回包不污染 currentScene（虽然该函数不回写 currentScene，但
 *                 防止未来扩展误写）
 *              2) 跳转前 snap2：再校验一次当前 scene 还是发请求时那个 scene
 *                 避免用户中途切到 B 场景后，又跳到 B 的分镜页（应该是 A 的）
 * @returns {Promise<void>}
 */
async function onGenerateStoryboard(): Promise<void> {
  if (generatingStoryboard.value || !currentScene.value) return
  if (!hasContent.value) {
    errorMsg.value = '请先生成或编辑当前场景剧本，再生成分镜'
    infoMsg.value = ''
    return
  }
  if (isDraftDirty.value) {
    errorMsg.value = '当前有未保存的剧本修改，请先保存'
    infoMsg.value = ''
    return
  }
  const snap = snapshotContext()
  const targetSceneId = currentScene.value.id
  const targetProjectId = projectId.value
  generatingStoryboard.value = true
  errorMsg.value = ''
  try {
    await generateStoryboards(targetSceneId)
    if (isContextChanged(snap)) {
      // 期间用户已切换场景，不再跳转；避免进入错误分镜页
      return
    }
    // 二次保险：再比对一次 currentScene
    if (currentScene.value?.id !== targetSceneId || projectId.value !== targetProjectId) {
      return
    }
    router.push({
      path: '/workspace/storyboard',
      query: {
        projectId: String(targetProjectId),
        sceneId: String(targetSceneId),
      },
    })
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '分镜生成失败'
  } finally {
    generatingStoryboard.value = false
  }
}

/**
 * @description 把场景状态枚举翻译成中文标签（用于列表角标）
 */
function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'generated':
      return '已生成'
    case 'revised':
      return '已修订'
    case 'storyboard_ready':
      return '分镜已就绪'
    default:
      return status
  }
}

/**
 * @description 监听 projectId + sceneId 双路由参数
 *              任意一个变 → 重新跑 loadAll，避免从其他入口复用同一页实例时
 *              项目 / 场景列表 / 工作区上下文还停留在上一个项目
 *              之前只 watch sceneId，projectId 变化不会被感知
 * @returns {void}
 */
watch(
  () => [route.query.projectId, route.query.sceneId],
  () => {
    void loadAll()
  },
)

watch(
  draftContent,
  async () => {
    await nextTick()
    syncContentTextareaHeight()
  },
  { flush: 'post' },
)

onMounted(() => {
  void loadAll()
  void nextTick(syncContentTextareaHeight)
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true" :self-managed-scroll="true">
    <div class="relative flex h-full min-h-0 overflow-hidden bg-surface">
      <!-- 主工作区 -->
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <!-- Top Actions -->
        <div class="flex items-center justify-between border-b border-outline-variant bg-surface-container px-8 py-3">
          <div class="text-sm text-on-surface-variant">
            <span v-if="currentScene">
              场景 {{ String(currentScene.sceneNo).padStart(2, '0') }} ·
              {{ currentScene.title || '未命名场景' }} ·
              <span class="text-primary">{{ statusLabel(currentScene.status) }}</span>
            </span>
            <span v-else-if="pageState === 'ready'">请在右侧选择一个场次</span>
            <span v-else>—</span>
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              class="flex items-center gap-1 border px-3 py-1.5 text-xs font-bold uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              :class="hasContent
                ? 'border-yellow-500/40 bg-yellow-500/5 text-yellow-400 hover:border-yellow-500 hover:bg-yellow-500/10'
                : 'border-outline text-on-surface-variant hover:border-primary hover:text-primary'"
              :disabled="generating || !currentScene"
              :title="hasContent ? '重写当前场景剧本（会覆盖现有正文）' : '首次生成当前场景剧本'"
              @click="onRequestGenerate"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generating }">
                {{ generating ? 'progress_activity' : (hasContent ? 'refresh' : 'auto_awesome') }}
              </span>
              {{ generating ? '生成中...' : (hasContent ? '重写当前场景剧本' : '生成剧本') }}
            </button>
            <button
              type="button"
              class="flex items-center gap-1 border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="saving || !currentScene || !isDraftDirty"
              :title="!isDraftDirty ? '未检测到修改' : '保存当前剧本修改'"
              @click="onSave"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': saving }">
                {{ saving ? 'progress_activity' : 'save' }}
              </span>
              {{ saving ? '保存中...' : '保存剧本' }}
            </button>
            <button
              type="button"
              class="flex items-center gap-1 bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="generatingStoryboard || !currentScene || !hasContent || isDraftDirty"
              :title="!hasContent ? '请先生成或编辑当前场景剧本' : (isDraftDirty ? '有未保存修改，请先保存' : '进入当前场景的分镜模块')"
              @click="onGenerateStoryboard"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': generatingStoryboard }">
                {{ generatingStoryboard ? 'progress_activity' : 'movie_filter' }}
              </span>
              {{ generatingStoryboard ? '生成中...' : '进入分镜' }}
            </button>
          </div>
        </div>

        <div v-if="errorMsg" class="mx-8 mt-3 border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-400">
          {{ errorMsg }}
        </div>
        <div v-if="infoMsg" class="mx-8 mt-3 border border-green-500/40 bg-green-500/10 px-4 py-2 text-xs text-green-400">
          {{ infoMsg }}
        </div>

        <!-- 状态分支 -->
        <div v-if="pageState === 'loading'" class="flex flex-1 items-center justify-center text-sm text-on-surface-variant">
          加载剧本工作台...
        </div>

        <div
          v-else-if="pageState === 'error'"
          class="mx-8 mt-8 max-w-xl border border-red-500/40 bg-red-500/5 p-6"
        >
          <h3 class="mb-2 font-bold text-red-400">页面加载失败</h3>
          <p class="mb-4 text-sm text-on-surface-variant">{{ errorMsg || '请稍后重试' }}</p>
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="loadAll"
          >
            <span class="material-symbols-outlined text-sm">refresh</span>
            重新加载
          </button>
        </div>

        <div
          v-else-if="pageState === 'no-project'"
          class="mx-8 mt-8 max-w-xl border border-outline-variant bg-surface-container p-6"
        >
          <h3 class="mb-2 font-bold text-on-surface">缺少项目上下文</h3>
          <p class="mb-4 text-sm text-on-surface-variant">单场剧本依附于具体项目。请先从项目控制台进入。</p>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="router.push('/dashboard')"
          >
            <span class="material-symbols-outlined text-sm">dashboard</span>
            前往项目控制台
          </button>
        </div>

        <div
          v-else-if="pageState === 'no-scene'"
          class="mx-8 mt-8 max-w-xl border border-outline-variant bg-surface-container p-6"
        >
          <h3 class="mb-2 font-bold text-on-surface">缺少场景上下文</h3>
          <p class="mb-4 text-sm text-on-surface-variant">单场剧本依附于具体场景。请先在项目下选择一个场次。</p>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            :disabled="!projectId"
            @click="router.push({ path: '/workspace/scenes', query: { projectId: String(projectId) } })"
          >
            <span class="material-symbols-outlined text-sm">list</span>
            前往场景列表
          </button>
        </div>

        <!-- ready: 编辑区 -->
        <div
          v-else-if="pageState === 'ready' && currentScene"
          class="script-canvas flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-background p-12 overscroll-y-contain"
        >
          <div class="w-full max-w-[850px] self-start bg-surface-paper paper-texture p-12 text-[#2b2b2b] shadow-xl brutalist-border">
            <div class="mb-6 font-mono text-[16px] leading-[1.2] uppercase">
              场景 {{ String(currentScene.sceneNo).padStart(2, '0') }} - {{ currentScene.location || '—' }} - {{ currentScene.timeOfDay || '—' }}
            </div>

            <div class="mb-6">
              <label class="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[#2b2b2b]/60">标题 / Title</label>
              <input
                v-model="draftTitle"
                class="w-full border-b border-[#2b2b2b]/30 bg-transparent p-1 font-mono text-[18px] focus:border-primary focus:outline-none"
                placeholder="如：钩子开场"
              />
            </div>

            <div class="mb-6">
              <label class="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[#2b2b2b]/60">摘要 / Summary（参考）</label>
              <p class="text-sm leading-relaxed text-[#2b2b2b]/70">
                {{ currentScene.summary || '— 暂无摘要 —' }}
              </p>
            </div>

            <div class="mb-6">
              <label class="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[#2b2b2b]/60">剧本正文 / Script</label>
              <textarea
                v-model="draftContent"
                ref="contentTextarea"
                class="block min-h-[50vh] w-full resize-none overflow-hidden border-none bg-transparent p-0 font-mono text-[16px] leading-relaxed text-[#2b2b2b] focus:ring-0"
                placeholder="开始写剧本... 点击上方「保存剧本」按钮保存修改"
              ></textarea>
            </div>

            <div class="border-t border-[#2b2b2b]/20 pt-4">
              <label class="mb-1 block text-[10px] font-bold uppercase tracking-widest text-[#2b2b2b]/60">情绪 / Mood</label>
              <input
                v-model="draftMood"
                class="w-full border-b border-[#2b2b2b]/30 bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                placeholder="如：压迫、悬疑"
              />
            </div>
          </div>
        </div>

        <div
          v-else-if="pageState === 'ready' && !currentScene"
          class="flex flex-1 items-center justify-center text-sm text-on-surface-variant"
        >
          加载场景中...
        </div>
      </div>

      <!-- Right Inspector / Scene Index -->
      <aside class="flex min-h-0 w-[320px] shrink-0 flex-col border-l border-outline-variant bg-surface-charcoal">
        <div class="p-6 border-b border-outline-variant">
          <h3 class="font-headline-md text-headline-md text-primary mb-1">场次索引</h3>
          <p class="font-label-md text-on-surface-variant">共 {{ scenes.length }} 个场次</p>
        </div>
        <div class="flex-1 overflow-y-auto overscroll-y-contain">
          <button
            v-for="scene in scenes"
            :key="scene.id"
            type="button"
            class="block w-full cursor-pointer border-b border-outline-variant p-4 text-left transition-colors"
            :class="
              currentScene?.id === scene.id
                ? 'bg-surface-container-low active-tab-glow'
                : 'hover:bg-surface-container-low'
            "
            @click="selectScene(scene.id)"
          >
            <div class="flex justify-between items-start mb-2">
              <span class="font-label-sm" :class="currentScene?.id === scene.id ? 'text-primary' : 'text-on-surface-variant'">
                场景 {{ String(scene.sceneNo).padStart(2, '0') }}
              </span>
              <span class="text-[10px] uppercase" :class="{
                'text-green-400': scene.status === 'storyboard_ready',
                'text-primary': scene.status === 'generated',
                'text-on-surface-variant': scene.status === 'draft',
                'text-yellow-400': scene.status === 'revised',
              }">
                {{ statusLabel(scene.status) }}
              </span>
            </div>
            <div class="font-label-md mb-1" :class="currentScene?.id === scene.id ? 'text-on-surface' : 'text-on-surface-variant'">
              {{ scene.title || '未命名场景' }}
            </div>
            <div class="text-[12px] text-on-surface-variant line-clamp-2">{{ scene.summary || '—' }}</div>
          </button>
          <div v-if="!scenes.length" class="p-8 text-center text-sm text-on-surface-variant">
            场景为空，请先在 AI 剧本页生成
          </div>
        </div>
      </aside>
    </div>

    <!--
      重写当前场景剧本的二次确认弹窗
      - 提示：会覆盖现有正文 + 当前编辑区未保存修改
      - 用户主动选择"继续覆盖"才真正调 AI
    -->
    <div
      v-if="confirmRewriteScript"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-rewrite-script-title"
      @click.self="cancelRewriteScript"
    >
      <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-3 flex items-center gap-3">
          <span class="material-symbols-outlined text-3xl text-yellow-400">edit_note</span>
          <h2 id="confirm-rewrite-script-title" class="font-headline-md text-headline-md text-on-surface">
            确认重写当前场景剧本？
          </h2>
        </div>
        <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
          <p>
            此操作会基于当前总纲重新生成该场剧本正文与情绪。已有正文、AI 已生成的内容都会被覆盖。
          </p>
          <p v-if="isDraftDirty" class="border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-400">
            当前还有未保存的人工修改，继续重写后这些修改将被丢弃。
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="cancelRewriteScript"
          >
            取消
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110"
            :disabled="generating"
            @click="doGenerateScript"
          >
            <span v-if="generating" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
            继续覆盖
          </button>
        </div>
      </div>
    </div>

    <!--
      切换场景前的脏数据确认弹窗（与 Scenes.vue 同款）
    -->
    <div
      v-if="pendingSwitchSceneId != null"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-discard-script-title"
      @click.self="cancelSwitchScene"
    >
      <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-3 flex items-center gap-3">
          <span class="material-symbols-outlined text-3xl text-yellow-400">edit_note</span>
          <h2 id="confirm-discard-script-title" class="font-headline-md text-headline-md text-on-surface">
            当前场景有未保存的修改
          </h2>
        </div>
        <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
          <p>
            切换到其他场景前需要确认。已修改的字段（标题、正文、情绪）尚未保存到数据库。
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
  </WorkspaceLayout>
</template>
