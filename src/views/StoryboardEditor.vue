<script setup lang="ts">
/**
 * @file 单分镜编辑器
 * @description 从 query.projectId / query.sceneId / query.storyboardId 读取上下文；
 *              可编辑景别 / 机位 / 构图 / 时长 / 角色 / 动作 / 对白 / 提示词 / 图片URL / 状态，
 *              并可在同场景的镜头间切换。
 *
 *              状态机：missing-project / missing-scene / missing-shot / loading / error / ready
 *
 *              核心保护：
 *                1) 三 fetch 拆成纯 getter，loadAll 是唯一的状态提交入口
 *                2) shot 归属校验：storyboard.sceneId === sceneId，scene 来自 shot.sceneId 的 list
 *                3) isDraftDirty 比较 9 个字段
 *                4) 切镜头前未保存确认（pendingSwitchShotId + 二次弹窗）
 *                5) snapshot 三参数（projectId / sceneId / storyboardId）防御过期回包
 *                6) in-flight 保护：saving 或 markDone 进行中禁止切镜头
 *                7) watch 三 query 任一变化触发 loadAll
 *                8) onSave / markDone 三同步：shot / draft / siblingShots
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  copyPreviousFrameToStoryboard,
  getStoryboard,
  listCharacters,
  listStoryboards,
  optimizeStoryboardKeyframes,
  splitStoryboard,
  splitStoryboardDialogue,
  updateStoryboard,
  type CharacterDTO,
  type StoryboardDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)
const storyboardId = computed(() => Number(route.query.storyboardId) || 0)

/**
 * @description 页面状态机
 *              - missing-project  缺 projectId
 *              - missing-scene    缺 sceneId
 *              - missing-shot     缺 storyboardId
 *              - loading          首次加载
 *              - error            接口失败 / 归属校验失败
 *              - ready            详情就绪
 */
type PageState =
  | 'missing-project'
  | 'missing-scene'
  | 'missing-shot'
  | 'loading'
  | 'error'
  | 'ready'
const pageState = ref<PageState>('loading')

const shot = ref<StoryboardDTO | null>(null)
const siblingShots = ref<StoryboardDTO[]>([])
const characters = ref<CharacterDTO[]>([])

/**
 * @description 草稿字段：覆盖白名单 9 个字段 + 内部状态
 *              与 shot 的基线对比计算 isDraftDirty
 */
interface ShotDraft {
  shotType: string
  cameraAngle: string
  composition: string
  durationSeconds: number
  characterId: number | null
  characterName: string
  actionText: string
  dialogueText: string
  visualPrompt: string
  startVisualPrompt: string
  endVisualPrompt: string
  imageUrl: string
  endImageUrl: string
  status: string
}
const draft = ref<ShotDraft>({
  shotType: '',
  cameraAngle: '',
  composition: '',
  durationSeconds: 0,
  characterId: null,
  characterName: '',
  actionText: '',
  dialogueText: '',
  visualPrompt: '',
  startVisualPrompt: '',
  endVisualPrompt: '',
  imageUrl: '',
  endImageUrl: '',
  status: 'pending',
})

const saving = ref(false)
const markingDone = ref(false)
const optimizingKeyframes = ref(false)
const copyingContinuity = ref(false)
const splittingDialogue = ref(false)
const splittingSubShots = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')

// 切镜头前的"丢弃修改"确认弹窗（pendingSwitchShotId 与 pendingRouteChange 互斥）
const pendingSwitchShotId = ref<number | null>(null)

/**
 * @description 路由回滚标志位
 *              - 我们自己 router.replace 回滚 URL 会触发 watch 二次执行
 *              - 如果没有这个标志，第二次 watch 会把"oldQ"误判为"新目标"，再回滚一次，形成 A/B 反复横跳的死循环
 *              - 流程：
 *                  1) dirty → 暂存目标到 pendingRouteChange
 *                  2) set isRollingBack=true
 *                  3) router.replace 回滚 URL
 *                  4) 回滚触发的 watch 看到 isRollingBack=true → 清标志 + 早退
 *              - 用户连续按浏览器前进/后退（极快多次）：每次都会被拦截（每次都会重置标志）
 */
const isRollingBack = ref(false)

/**
 * @description 路由变化前的"丢弃修改"待定目标
 *              - 浏览器前进/后退 / 外部改 query / SideNav 跳入等场景都会触发 route.query 变化
 *              - watch 在检测到 query 变化时如果当前 dirty，会暂存目标到此
 *              - 同时 router.replace 把 URL 回滚到旧值，避免页面被悄悄覆盖
 *              - 用户选"丢弃"才真正跳到目标；选"取消"则留在当前镜头
 *              - 与 pendingSwitchShotId 互斥：同一时刻只能有一种"待切换"
 */
interface PendingRouteChange {
  projectId: number
  sceneId: number
  storyboardId: number
}
const pendingRouteChange = ref<PendingRouteChange | null>(null)

/**
 * @description 把当前的 projectId / sceneId / storyboardId 拍一张快照
 *              用于拦截"用户中途切换镜头 / 路由 / 上下文导致过期回包覆盖正确状态"
 * @returns {{ projectId: number; sceneId: number; storyboardId: number }}
 */
function snapshotContext(): { projectId: number; sceneId: number; storyboardId: number } {
  return {
    projectId: projectId.value,
    sceneId: sceneId.value,
    storyboardId: storyboardId.value,
  }
}

/**
 * @description 比对当前上下文与快照是否一致
 * @param {{ projectId: number; sceneId: number; storyboardId: number }} snap
 * @returns {boolean} true 表示已过期
 */
function isContextChanged(snap: {
  projectId: number
  sceneId: number
  storyboardId: number
}): boolean {
  return (
    snap.projectId !== projectId.value ||
    snap.sceneId !== sceneId.value ||
    snap.storyboardId !== storyboardId.value
  )
}

/**
 * @description dirty 检测：9 个字段任一与 shot 基线不同即为脏
 *              status / durationSeconds 数字字段严格相等；其他字符串 trim 后比较
 */
const isDraftDirty = computed<boolean>(() => {
  const s = shot.value
  if (!s) return false
  if ((draft.value.shotType || '') !== (s.shotType || '')) return true
  if ((draft.value.cameraAngle || '') !== (s.cameraAngle || '')) return true
  if ((draft.value.composition || '') !== (s.composition || '')) return true
  if ((draft.value.characterId || null) !== (s.characterId || null)) return true
  if ((draft.value.characterName || '') !== (s.characterName || '')) return true
  if ((draft.value.actionText || '') !== (s.actionText || '')) return true
  if ((draft.value.dialogueText || '') !== (s.dialogueText || '')) return true
  if ((draft.value.visualPrompt || '') !== (s.visualPrompt || '')) return true
  if ((draft.value.startVisualPrompt || '') !== (s.startVisualPrompt || '')) return true
  if ((draft.value.endVisualPrompt || '') !== (s.endVisualPrompt || '')) return true
  if ((draft.value.imageUrl || '') !== (s.imageUrl || '')) return true
  if ((draft.value.endImageUrl || '') !== (s.endImageUrl || '')) return true
  if ((draft.value.status || '') !== (s.status || '')) return true
  if (Number(draft.value.durationSeconds || 0) !== Number(s.durationSeconds || 0)) return true
  return false
})

/**
 * @description 把 shot 同步到 draft 基线
 *              入口：loadAll 完成 / onSave 成功 / markDone 成功 / 切镜头确认丢弃之后
 *              不要在 watch 触发 loadAll 的中途调用，避免中间态被误覆盖
 */
function syncDraftFromShot(s: StoryboardDTO): void {
  draft.value = {
    shotType: s.shotType || '',
    cameraAngle: s.cameraAngle || '',
    composition: s.composition || '',
    durationSeconds: s.durationSeconds || 0,
    characterId: s.characterId || null,
    characterName: s.characterName || '',
    actionText: s.actionText || '',
    dialogueText: s.dialogueText || '',
    visualPrompt: s.visualPrompt || '',
    startVisualPrompt: s.startVisualPrompt || '',
    endVisualPrompt: s.endVisualPrompt || '',
    imageUrl: s.imageUrl || '',
    endImageUrl: s.endImageUrl || '',
    status: s.status || 'pending',
  }
}

/**
 * @description 拉取单分镜详情（纯 getter，不写 ref）
 * @returns {Promise<StoryboardDTO>}
 * @throws {Error} 接口失败 / 缺 storyboardId
 */
async function fetchShot(): Promise<StoryboardDTO> {
  if (!storyboardId.value) throw new Error('缺少 storyboardId 参数')
  const s = await getStoryboard(storyboardId.value)
  if (!s) throw new Error('分镜不存在或无权访问')
  return s
}

/**
 * @description 拉取同场景的兄弟分镜列表（纯 getter，不写 ref）
 * @param {number} sceneId
 * @returns {Promise<StoryboardDTO[]>}
 */
async function fetchShots(sceneId: number): Promise<StoryboardDTO[]> {
  const list = await listStoryboards(sceneId)
  return Array.isArray(list) ? list : []
}

/**
 * @description 完整加载：分镜详情 + 兄弟列表
 *              1) fetchShot / fetchShots 都是纯函数，不写 ref
 *              2) 本函数是唯一的状态提交入口，snapshot 校验通过后原子提交
 *              3) 校验 shot.sceneId === sceneId，防止手改 URL 把别场景的分镜拿来当 current
 * @returns {Promise<void>}
 */
async function loadAll(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }
  if (!sceneId.value) {
    pageState.value = 'missing-scene'
    return
  }
  if (!storyboardId.value) {
    pageState.value = 'missing-shot'
    return
  }
  const snap = snapshotContext()
  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const s = await fetchShot()
    if (isContextChanged(snap)) return
    // 归属校验：shot 必须属于当前 sceneId
    if (s.sceneId !== sceneId.value) {
      throw new Error('该分镜不属于当前场景，请检查 URL 参数')
    }
    const [list, projectCharacters] = await Promise.all([
      fetchShots(s.sceneId),
      listCharacters(projectId.value),
    ])
    if (isContextChanged(snap)) return
    // 一次性原子提交
    shot.value = s
    siblingShots.value = list
    characters.value = projectCharacters
    syncDraftFromShot(s)
    pageState.value = 'ready'
    setWorkspaceContext({
      projectId: projectId.value,
      sceneId: s.sceneId,
      storyboardId: s.id,
    })
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '分镜加载失败'
    pageState.value = 'error'
  }
}

/**
 * @description 切换到另一个镜头
 *              保护两段：
 *              1) in-flight 保护：saving 或 markingDone 为 true → 禁止切换（防止 A 镜头保存/标记的回包污染 B 镜头）
 *              2) dirty 保护：有未保存修改 → 弹确认，用户选"丢弃"才真正切换
 * @param {number} id
 * @returns {void}
 */
function selectShot(id: number): void {
  if (storyboardId.value === id) return
  if (saving.value || markingDone.value) {
    errorMsg.value = '当前操作进行中，请稍候再切换镜头'
    infoMsg.value = ''
    return
  }
  if (isDraftDirty.value) {
    pendingSwitchShotId.value = id
    // 同一时刻只能有一种"待切换"
    pendingRouteChange.value = null
    return
  }
  router.replace({
    path: '/workspace/storyboard/editor',
    query: {
      projectId: String(projectId.value),
      sceneId: String(sceneId.value),
      storyboardId: String(id),
    },
  })
}

/**
 * @description 确认丢弃修改并切换到目标（统一收口：处理 pendingSwitchShotId 和 pendingRouteChange）
 *              优先处理 pendingRouteChange（路由变化场景），其次 pendingSwitchShotId（同页镜头列表）
 *              切走前必须先清掉三个 ref 的草稿基线，避免 watch 触发 loadAll 中间态被 isDraftDirty 反向误判
 * @returns {void}
 */
function confirmDiscardAndSwitch(): void {
  const routeTarget = pendingRouteChange.value
  const switchTarget = pendingSwitchShotId.value
  pendingRouteChange.value = null
  pendingSwitchShotId.value = null

  if (routeTarget) {
    if (shot.value) {
      syncDraftFromShot(shot.value)
    } else {
      resetDraftToEmpty()
    }
    // 跳到目标（用户已确认丢弃）
    void router.replace({
      path: '/workspace/storyboard/editor',
      query: {
        projectId: String(routeTarget.projectId),
        sceneId: String(routeTarget.sceneId),
        storyboardId: String(routeTarget.storyboardId),
      },
    })
    return
  }

  if (switchTarget != null) {
    if (shot.value) {
      syncDraftFromShot(shot.value)
    } else {
      resetDraftToEmpty()
    }
    void router.replace({
      path: '/workspace/storyboard/editor',
      query: {
        projectId: String(projectId.value),
        sceneId: String(sceneId.value),
        storyboardId: String(switchTarget),
      },
    })
    return
  }
}

/**
 * @description 重置 draft 到空白（confirmDiscardAndSwitch / syncDraftFromShot 不可用时兜底）
 * @returns {void}
 */
function resetDraftToEmpty(): void {
  draft.value = {
    shotType: '',
    cameraAngle: '',
    composition: '',
    durationSeconds: 0,
    characterId: null,
    characterName: '',
    actionText: '',
    dialogueText: '',
    visualPrompt: '',
    startVisualPrompt: '',
    endVisualPrompt: '',
    imageUrl: '',
    endImageUrl: '',
    status: 'pending',
  }
}

/**
 * @description 取消切换，留在当前镜头（同时清两种 pending）
 * @returns {void}
 */
function cancelSwitchShot(): void {
  pendingSwitchShotId.value = null
  pendingRouteChange.value = null
}

function buildDraftPayload() {
  return {
    shotType: draft.value.shotType,
    cameraAngle: draft.value.cameraAngle,
    composition: draft.value.composition,
    durationSeconds: Number(draft.value.durationSeconds) || 0,
    characterId: draft.value.characterId,
    characterName: draft.value.characterName,
    actionText: draft.value.actionText,
    dialogueText: draft.value.dialogueText,
    visualPrompt: draft.value.visualPrompt,
    startVisualPrompt: draft.value.startVisualPrompt,
    endVisualPrompt: draft.value.endVisualPrompt,
    imageUrl: draft.value.imageUrl,
    endImageUrl: draft.value.endImageUrl,
    status: draft.value.status,
  }
}

/**
 * @description 保存分镜修改
 *              1) snapshot 防御：保存中切换镜头或路由，旧回包不污染 shot
 *              2) 三同步：shot / draft / siblingShots
 *              3) saving 状态期间 selectShot 已被 in-flight 拦掉，这里不再加 dirty 二次提示
 * @returns {Promise<void>}
 */
async function onSave(): Promise<void> {
  if (saving.value || markingDone.value || !shot.value) return
  if (!isDraftDirty.value) {
    infoMsg.value = '未检测到修改'
    return
  }
  const snap = snapshotContext()
  const targetShotId = shot.value.id
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await updateStoryboard(shot.value.id, buildDraftPayload())
    if (isContextChanged(snap)) return
    // 二次保险：比对更新项的 id 与发请求时的 id
    if (updated.id !== targetShotId) return
    shot.value = updated
    syncDraftFromShot(updated)
    siblingShots.value = siblingShots.value.map((s) => (s.id === updated.id ? updated : s))
    infoMsg.value = '分镜已保存'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

/**
 * @description 标记为完成（方案 A）
 *              "完成" 本质是 "保存当前编辑 + status=done"
 *              - 如果有未保存草稿：把整份 draft（除 status 外）连同 status:done 一起提交
 *              - 如果没有草稿但 status 不是 done：只提交 status:done
 *              - 如果已经是 done：infoMsg 提示，早退
 *              关键修复：旧实现只提交 { status: 'done' } 然后 syncDraftFromShot(updated)，
 *              这会把 shotType / visualPrompt / imageUrl / actionText / dialogueText 等草稿覆盖
 *              （因为服务端返回的 updated 不包含用户未保存的本地草稿）。
 *              走与 onSave 同一组保护：saving / markingDone 互斥、snapshot 拦截过期回包、shot / draft / siblingShots 三同步。
 * @returns {Promise<void>}
 */
async function markDone(): Promise<void> {
  if (saving.value || markingDone.value || !shot.value) return
  if (shot.value.status === 'done' && draft.value.status === 'done' && !isDraftDirty.value) {
    infoMsg.value = '当前镜头已经是已完成状态'
    return
  }
  const snap = snapshotContext()
  const targetShotId = shot.value.id
  // 关键：在修改任何 ref 之前抓一份草稿快照（基于当前 draft，而不是 shot 基线）
  const dirty = isDraftDirty.value
  const payload: {
    status: 'done'
    shotType?: string
    cameraAngle?: string
    composition?: string
    durationSeconds?: number
    characterId?: number | null
    characterName?: string
    actionText?: string
    dialogueText?: string
    visualPrompt?: string
    startVisualPrompt?: string
    endVisualPrompt?: string
    imageUrl?: string
    endImageUrl?: string
    // 注意：status 不参与用户编辑（markDone 强制覆盖），不进 draft 兜底
  } = { status: 'done' }
  if (dirty) {
    payload.shotType = draft.value.shotType
    payload.cameraAngle = draft.value.cameraAngle
    payload.composition = draft.value.composition
    payload.durationSeconds = Number(draft.value.durationSeconds) || 0
    payload.characterId = draft.value.characterId
    payload.characterName = draft.value.characterName
    payload.actionText = draft.value.actionText
    payload.dialogueText = draft.value.dialogueText
    payload.visualPrompt = draft.value.visualPrompt
    payload.startVisualPrompt = draft.value.startVisualPrompt
    payload.endVisualPrompt = draft.value.endVisualPrompt
    payload.imageUrl = draft.value.imageUrl
    payload.endImageUrl = draft.value.endImageUrl
  }
  markingDone.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await updateStoryboard(shot.value.id, payload)
    if (isContextChanged(snap)) return
    if (updated.id !== targetShotId) return
    shot.value = updated
    syncDraftFromShot(updated)
    siblingShots.value = siblingShots.value.map((s) => (s.id === updated.id ? updated : s))
    infoMsg.value = dirty ? '已保存修改并标记为已完成' : '已标记为已完成'
  } catch (e) {
    if (isContextChanged(snap)) return
    errorMsg.value = e instanceof Error ? e.message : '标记失败'
  } finally {
    markingDone.value = false
  }
}

async function onOptimizeKeyframes(): Promise<void> {
  if (!shot.value || saving.value || markingDone.value || optimizingKeyframes.value) return
  const snap = snapshotContext()
  const targetShotId = shot.value.id
  optimizingKeyframes.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    if (isDraftDirty.value) {
      const saved = await updateStoryboard(targetShotId, buildDraftPayload())
      if (isContextChanged(snap) || saved.id !== targetShotId) return
      shot.value = saved
      syncDraftFromShot(saved)
      siblingShots.value = siblingShots.value.map((s) => (s.id === saved.id ? saved : s))
    }
    const result = await optimizeStoryboardKeyframes(targetShotId)
    if (isContextChanged(snap) || result.storyboard.id !== targetShotId) return
    shot.value = result.storyboard
    syncDraftFromShot(result.storyboard)
    siblingShots.value = siblingShots.value.map((s) => (s.id === result.storyboard.id ? result.storyboard : s))
    infoMsg.value = result.notes || '已保存当前分镜，并根据动作自动生成起始帧和结束帧提示词'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'AI 优化两帧提示词失败'
  } finally {
    optimizingKeyframes.value = false
  }
}

async function onCopyPreviousFrame(): Promise<void> {
  if (!shot.value || saving.value || markingDone.value || copyingContinuity.value) return
  copyingContinuity.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await copyPreviousFrameToStoryboard(shot.value.id)
    shot.value = result.storyboard
    syncDraftFromShot(result.storyboard)
    siblingShots.value = siblingShots.value.map((s) => (s.id === result.storyboard.id ? result.storyboard : s))
    infoMsg.value = result.sourceShotNo
      ? `已把上一镜头 ${result.sourceShotNo} 的确认图作为当前起始帧`
      : '已把上一镜头确认图作为当前起始帧'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '承接上一镜头失败'
  } finally {
    copyingContinuity.value = false
  }
}

async function onSplitSubShots(): Promise<void> {
  if (!shot.value || saving.value || markingDone.value || splittingSubShots.value || splittingDialogue.value) return
  if (isDraftDirty.value) {
    errorMsg.value = '拆分子分镜前请先保存当前修改'
    infoMsg.value = ''
    return
  }
  splittingSubShots.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await splitStoryboard(shot.value.id)
    siblingShots.value = result.items
    const current = result.current || result.items.find((item) => item.id === shot.value?.id) || null
    if (current) {
      shot.value = current
      syncDraftFromShot(current)
    }
    infoMsg.value = `已拆成 ${result.createdCount} 个短子分镜，后续生成视频会更稳定、更省钱`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'AI 拆分子分镜失败'
  } finally {
    splittingSubShots.value = false
  }
}

async function onSplitDialogueTurns(): Promise<void> {
  if (!shot.value || saving.value || markingDone.value || splittingDialogue.value || splittingSubShots.value) return
  if (isDraftDirty.value) {
    errorMsg.value = '拆分多人对白前请先保存当前修改'
    infoMsg.value = ''
    return
  }
  splittingDialogue.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await splitStoryboardDialogue(shot.value.id)
    siblingShots.value = result.items
    const current = result.current || result.items.find((item) => item.id === shot.value?.id) || null
    if (current) {
      shot.value = current
      syncDraftFromShot(current)
    }
    const speakerText = result.speakers?.length ? result.speakers.join('、') : '多个角色'
    infoMsg.value = `已按 ${speakerText} 的对白拆成 ${result.createdCount} 个口型分镜`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'AI 拆分多人对白失败'
  } finally {
    splittingDialogue.value = false
  }
}

const compositionOptions = [
  { id: 'low', icon: 'south_east', label: '低角度' },
  { id: 'center', icon: 'center_focus_strong', label: '中心构图' },
  { id: 'wide', icon: 'zoom_out_map', label: '大全景' },
  { id: 'mid', icon: 'person', label: '中景' },
]

const statusOptions = [
  { value: 'pending', label: '等待生成' },
  { value: 'generating', label: '生成中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' },
]

function onCharacterChanged(): void {
  const selected = characters.value.find((item) => item.id === Number(draft.value.characterId))
  if (selected) draft.value.characterName = selected.name
}

const isComposing = (id: string) => {
  return draft.value.composition && draft.value.composition.includes(id)
}

/**
 * @description 跳到项目总览
 * @returns {void}
 */
function backToDashboard(): void {
  router.push('/dashboard')
}

/**
 * @description 跳到当前场景的分镜列表页
 * @returns {void}
 */
function backToStoryboardList(): void {
  if (projectId.value && sceneId.value) {
    router.push({
      path: '/workspace/storyboard',
      query: { projectId: String(projectId.value), sceneId: String(sceneId.value) },
    })
  } else if (projectId.value) {
    router.push({
      path: '/workspace/script/ai',
      query: { projectId: String(projectId.value), needScene: '1' },
    })
  } else {
    router.push('/dashboard')
  }
}

function openVideoGenerate(): void {
  if (!projectId.value || !sceneId.value || !storyboardId.value) return
  router.push({
    path: '/workspace/video',
    query: {
      projectId: String(projectId.value),
      sceneId: String(sceneId.value),
      storyboardId: String(storyboardId.value),
    },
  })
}

function openFrameGenerate(): void {
  if (!projectId.value || !sceneId.value || !storyboardId.value) return
  router.push({
    path: '/workspace/frame',
    query: {
      projectId: String(projectId.value),
      sceneId: String(sceneId.value),
      storyboardId: String(storyboardId.value),
    },
  })
}

/**
 * @description 错误态重试
 * @returns {Promise<void>}
 */
async function retry(): Promise<void> {
  await loadAll()
}

/**
 * @description 路由参数变化时重新加载
 *              监听 projectId / sceneId / storyboardId 三个 query，任一变化触发以下逻辑：
 *              0) isRollingBack === true → 清标志 + 早退（我们自己回滚触发的二次 watch，避免死循环）
 *              1) pageState === 'loading'  → 直通 loadAll（首次进入或上一次 loadAll 进行中）
 *              2) pageState 是 missing-*   → 直通 loadAll（缺上下文，shot 都没渲染，无 dirty 可丢）
 *              3) 否则：
 *                 a) isDraftDirty === false → 直通 loadAll
 *                 b) isDraftDirty === true  → 暂存目标到 pendingRouteChange，
 *                                            set isRollingBack=true，
 *                                            router.replace 把 URL 回滚到旧值，
 *                                            让用户通过弹窗决定是否丢弃修改
 *              死循环防御：没有 isRollingBack 时，回滚触发的第二次 watch 会把 oldQ 误判为新目标
 *              再回滚一次，A/B 反复横跳，URL 永不稳定。
 */
watch(
  () => [route.query.projectId, route.query.sceneId, route.query.storyboardId],
  (_newQ, oldQ) => {
    // 0) 我们自己回滚触发的二次 watch：清标志 + 早退（不做 dirty 检查、不 loadAll、不回滚）
    if (isRollingBack.value) {
      isRollingBack.value = false
      return
    }
    if (pageState.value === 'loading') {
      void loadAll()
      return
    }
    if (
      pageState.value === 'missing-project' ||
      pageState.value === 'missing-scene' ||
      pageState.value === 'missing-shot'
    ) {
      void loadAll()
      return
    }
    if (!isDraftDirty.value) {
      void loadAll()
      return
    }
    // dirty：暂存目标，路由回滚
    const oldArr = (oldQ as Array<string | null>) || []
    const prevProjectId = Number(oldArr[0]) || 0
    const prevSceneId = Number(oldArr[1]) || 0
    const prevStoryboardId = Number(oldArr[2]) || 0
    pendingRouteChange.value = {
      projectId: projectId.value,
      sceneId: sceneId.value,
      storyboardId: storyboardId.value,
    }
    // 同一时刻只能有一种"待切换"
    pendingSwitchShotId.value = null
    // 死循环防御：先 set 标志，再 router.replace
    isRollingBack.value = true
    // 关键：用旧值替换 route.query，阻止 watch 二次触发 loadAll
    // （如果不回滚，watch 会再跑一次，这次的 oldQ 也会变成新值，无法再保护）
    void router.replace({
      path: '/workspace/storyboard/editor',
      query: {
        ...(prevProjectId ? { projectId: String(prevProjectId) } : {}),
        ...(prevSceneId ? { sceneId: String(prevSceneId) } : {}),
        ...(prevStoryboardId ? { storyboardId: String(prevStoryboardId) } : {}),
      },
    })
  },
)

onMounted(() => {
  void loadAll()
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <!-- 缺 projectId：整页友好提示 -->
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">dashboard</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少项目上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          单镜头编辑依附于具体项目。请先进入一个项目，并为其中的场景生成分镜。
        </p>
        <button
          type="button"
          class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
          @click="backToDashboard"
        >
          <span class="material-symbols-outlined text-sm">dashboard</span>
          前往项目总览
        </button>
      </div>
    </section>

    <!-- 缺 sceneId：整页友好提示 -->
    <section
      v-else-if="pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">edit_note</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少场景上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          单镜头编辑依附于具体场景。请先选择一个场景，再为它生成或选择一个镜头。
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="backToDashboard"
          >
            <span class="material-symbols-outlined text-sm">dashboard</span>
            返回项目总览
          </button>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
            @click="backToStoryboardList"
          >
            <span class="material-symbols-outlined text-sm">auto_stories</span>
            回到分镜列表
          </button>
        </div>
      </div>
    </section>

    <!-- 缺 storyboardId：整页友好提示 -->
    <section
      v-else-if="pageState === 'missing-shot'"
      class="flex h-full items-center justify-center bg-surface-dim p-8"
    >
      <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
        <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
          <span class="material-symbols-outlined text-3xl text-primary">movie</span>
        </div>
        <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少镜头上下文</h2>
        <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
          单镜头编辑需要一个具体镜头。请先到分镜列表选择一个镜头。
        </p>
        <button
          type="button"
          class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
          @click="backToStoryboardList"
        >
          <span class="material-symbols-outlined text-sm">auto_stories</span>
          回到分镜列表
        </button>
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
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="retry"
          >
            <span class="material-symbols-outlined text-sm">refresh</span>
            重新加载
          </button>
          <button
            v-if="projectId && sceneId"
            type="button"
            class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="backToStoryboardList"
          >
            <span class="material-symbols-outlined text-sm">auto_stories</span>
            回到分镜列表
          </button>
        </div>
      </div>
    </section>

    <!-- 主界面：ready -->
    <div v-else-if="pageState === 'ready'" class="flex h-screen flex-col bg-background">
      <div class="flex flex-1 flex-col gap-6 overflow-hidden p-6">
        <!-- Header -->
        <div class="flex flex-col gap-3 border-b border-outline-variant pb-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p class="text-[10px] font-bold uppercase tracking-widest text-primary">
              分镜编辑器
              <span v-if="shot" class="ml-2 text-on-surface-variant">镜头 {{ shot.shotNo }}</span>
            </p>
            <h1 class="mt-1 font-headline-md text-headline-md text-on-surface">
              镜头 {{ shot?.shotNo || '' }}
              <span v-if="isDraftDirty" class="ml-2 text-xs text-yellow-400">· 有未保存修改</span>
            </h1>
          </div>
          <div class="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              class="flex items-center gap-2 border border-outline-variant bg-surface px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface hover:border-primary hover:text-primary"
              :disabled="saving || markingDone || !shot"
              @click="openVideoGenerate"
            >
              <span class="material-symbols-outlined text-sm">movie</span>
              视频生成
            </button>
            <button
              type="button"
              class="flex items-center gap-2 border border-outline-variant bg-surface px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface hover:border-primary hover:text-primary"
              :disabled="saving || markingDone || !shot"
              @click="openFrameGenerate"
            >
              <span class="material-symbols-outlined text-sm">image</span>
              画面生成
            </button>
            <select
              v-model="draft.status"
              class="border border-outline-variant bg-surface px-3 py-2 text-xs uppercase text-on-surface"
              :disabled="saving || markingDone"
            >
              <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <button
              type="button"
              class="flex items-center gap-2 border border-primary/40 bg-primary/5 px-4 py-2 text-xs font-bold uppercase tracking-widest text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="saving || markingDone || draft.status === 'done'"
              :title="draft.status === 'done' ? '当前状态已是已完成' : '标记为已完成'"
              @click="markDone"
            >
              <span class="material-symbols-outlined text-sm">check_circle</span>
              标记为已完成
            </button>
            <button
              type="button"
              class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="saving || markingDone"
              :title="isDraftDirty ? '保存当前修改' : '未检测到修改'"
              @click="onSave"
            >
              <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': saving }">
                {{ saving ? 'progress_activity' : 'save' }}
              </span>
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>

        <div v-if="errorMsg" class="border border-red-500/40 bg-red-500/10 px-4 py-2 text-xs text-red-400">
          {{ errorMsg }}
        </div>
        <div v-if="infoMsg" class="border border-green-500/40 bg-green-500/10 px-4 py-2 text-xs text-green-400">
          {{ infoMsg }}
        </div>

        <div class="grid min-h-0 flex-1 grid-cols-12 gap-6 overflow-y-auto lg:overflow-hidden">
          <!-- 左侧：预览 + 视觉提示词 -->
          <div class="col-span-12 flex flex-col gap-4 lg:col-span-7 lg:min-h-0 lg:overflow-y-auto xl:col-span-8">
            <div class="group relative aspect-video w-full shrink-0 overflow-hidden border border-outline-variant bg-surface-charcoal">
              <img
                v-if="draft.imageUrl"
                :src="draft.imageUrl"
                :alt="`镜头 ${shot?.shotNo || ''} 画面预览`"
                class="absolute inset-0 h-full w-full object-contain"
              />
              <div v-else class="flex h-full w-full items-center justify-center bg-surface-container-high text-on-surface-variant">
                <div class="text-center">
                  <span class="material-symbols-outlined text-5xl">image</span>
                  <p class="mt-2 text-xs">尚未配置图片（image_url）</p>
                </div>
              </div>
            </div>

            <div class="border border-outline-variant bg-surface-container p-4">
              <label class="mb-2 block text-[10px] font-bold tracking-widest text-secondary">视觉提示词</label>
              <textarea
                v-model="draft.visualPrompt"
                rows="4"
                class="w-full resize-none border-none bg-transparent p-0 font-mono text-sm text-on-surface focus:ring-0"
                placeholder="例：cinemascope 2.39:1，雨夜，全景，低机位..."
              ></textarea>
            </div>

            <div class="border border-primary/30 bg-surface-container p-4">
              <div class="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p class="text-[10px] font-bold uppercase tracking-widest text-primary">导演关键帧</p>
                  <h2 class="mt-1 text-base font-bold text-on-surface">用起始帧和结束帧控制普通视频动作</h2>
                  <p class="mt-1 text-xs leading-relaxed text-on-surface-variant">
                    用户只写动作即可，AI 会把动作整理成首尾两帧；生成视频时优先使用起始帧，结束帧作为动作终点约束。
                  </p>
                  <p class="mt-1 text-xs leading-relaxed text-amber-200/80">
                    推荐顺序：先拆分多人对白 / 子分镜，再承接上一镜头或生成静帧，最后生成动作视频、对白音频和口型。
                  </p>
                </div>
                <div class="flex flex-wrap gap-2 xl:justify-end">
                  <button
                    type="button"
                    class="flex items-center gap-2 border border-outline-variant bg-surface px-3 py-2 text-xs font-bold text-on-surface hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="optimizingKeyframes || saving || markingDone"
                    @click="onOptimizeKeyframes"
                  >
                    <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': optimizingKeyframes }">
                      {{ optimizingKeyframes ? 'progress_activity' : 'auto_fix_high' }}
                    </span>
                    {{ optimizingKeyframes ? '优化中...' : 'AI 优化两帧提示词' }}
                  </button>
                  <button
                    type="button"
                    class="flex items-center gap-2 border border-outline-variant bg-surface px-3 py-2 text-xs font-bold text-on-surface hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="copyingContinuity || saving || markingDone"
                    @click="onCopyPreviousFrame"
                  >
                    <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': copyingContinuity }">
                      {{ copyingContinuity ? 'progress_activity' : 'content_copy' }}
                    </span>
                    {{ copyingContinuity ? '承接中...' : '承接上一镜头' }}
                  </button>
                  <button
                    type="button"
                    class="flex items-center gap-2 border border-primary/50 bg-primary/10 px-3 py-2 text-xs font-bold text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="splittingDialogue || splittingSubShots || saving || markingDone"
                    @click="onSplitDialogueTurns"
                  >
                    <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': splittingDialogue }">
                      {{ splittingDialogue ? 'progress_activity' : 'forum' }}
                    </span>
                    {{ splittingDialogue ? '拆分中...' : 'AI 拆分多人对白' }}
                  </button>
                  <button
                    type="button"
                    class="flex items-center gap-2 border border-primary/50 bg-primary/10 px-3 py-2 text-xs font-bold text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
                    :disabled="splittingSubShots || splittingDialogue || saving || markingDone"
                    @click="onSplitSubShots"
                  >
                    <span class="material-symbols-outlined text-sm" :class="{ 'animate-spin': splittingSubShots }">
                      {{ splittingSubShots ? 'progress_activity' : 'splitscreen' }}
                    </span>
                    {{ splittingSubShots ? '拆分中...' : 'AI 拆分子分镜' }}
                  </button>
                </div>
              </div>

              <div class="grid gap-3 xl:grid-cols-2">
                <label class="border border-outline-variant bg-surface-container-low p-3">
                  <span class="text-[10px] font-bold uppercase tracking-widest text-secondary">起始帧提示词</span>
                  <textarea
                    v-model="draft.startVisualPrompt"
                    rows="5"
                    class="mt-2 w-full resize-y border-none bg-transparent p-0 text-sm leading-relaxed text-on-surface focus:ring-0"
                    placeholder="AI 会写清动作开始前的人物姿态、站位、表情、构图和光线。"
                  ></textarea>
                </label>
                <label class="border border-outline-variant bg-surface-container-low p-3">
                  <span class="text-[10px] font-bold uppercase tracking-widest text-secondary">结束帧提示词</span>
                  <textarea
                    v-model="draft.endVisualPrompt"
                    rows="5"
                    class="mt-2 w-full resize-y border-none bg-transparent p-0 text-sm leading-relaxed text-on-surface focus:ring-0"
                    placeholder="AI 会写清动作完成后的最终姿态、情绪变化、位置和连续性。"
                  ></textarea>
                </label>
              </div>

              <div class="mt-3 grid gap-3 xl:grid-cols-2">
                <label class="flex flex-col gap-2 border border-outline-variant bg-surface-container-low p-3">
                  <span class="text-[10px] font-bold tracking-widest text-secondary">起始帧地址</span>
                  <input
                    v-model="draft.imageUrl"
                    type="text"
                    class="border-b border-outline-variant bg-transparent p-1 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
                    placeholder="确认起始帧后自动回写"
                  />
                </label>
                <label class="flex flex-col gap-2 border border-outline-variant bg-surface-container-low p-3">
                  <span class="text-[10px] font-bold tracking-widest text-secondary">结束帧地址</span>
                  <input
                    v-model="draft.endImageUrl"
                    type="text"
                    class="border-b border-outline-variant bg-transparent p-1 font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
                    placeholder="确认结束帧后自动回写"
                  />
                </label>
              </div>
            </div>

            <!--
              图片 URL 编辑区（P2 补全）
              - 直接绑定 draft.imageUrl，输入后预览区实时跟随
              - 风格与上方 visualPrompt 卡一致
              - 空时仍由上方预览区显示占位态
            -->
            <label class="flex flex-col gap-2 border border-outline-variant bg-surface-container p-3 sm:flex-row sm:items-center">
              <span class="shrink-0 text-[10px] font-bold tracking-widest text-secondary">图片地址</span>
              <input
                v-model="draft.imageUrl"
                type="text"
                class="min-w-0 flex-1 border-b border-outline-variant bg-transparent p-1 font-mono text-sm text-on-surface focus:border-primary focus:outline-none"
                placeholder="粘贴图片 URL 后回车预览（可选）"
              />
            </label>

            <div class="grid grid-cols-2 gap-4">
              <label class="border border-outline-variant bg-surface-container p-3">
                <span class="text-[10px] font-bold tracking-widest text-on-surface-variant">景别</span>
                <input
                  v-model="draft.shotType"
                  class="mt-1 w-full border-b border-outline-variant bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                  placeholder="全景 / 中景 / 特写 ..."
                />
              </label>
              <label class="border border-outline-variant bg-surface-container p-3">
                <span class="text-[10px] font-bold tracking-widest text-on-surface-variant">机位</span>
                <input
                  v-model="draft.cameraAngle"
                  class="mt-1 w-full border-b border-outline-variant bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                  placeholder="平视 / 低机位 / 俯拍 ..."
                />
              </label>
              <label class="border border-outline-variant bg-surface-container p-3">
                <span class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">构图 / Composition</span>
                <input
                  v-model="draft.composition"
                  class="mt-1 w-full border-b border-outline-variant bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                  placeholder="居中构图 / 三分构图 ..."
                />
              </label>
              <label class="border border-outline-variant bg-surface-container p-3">
                <span class="text-[10px] font-bold tracking-widest text-on-surface-variant">时长（秒）</span>
                <input
                  v-model.number="draft.durationSeconds"
                  type="number"
                  min="0"
                  class="mt-1 w-full border-b border-outline-variant bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                />
              </label>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="relative border border-outline-variant bg-surface-container p-4">
                <div class="absolute -top-3 left-4 bg-background px-2 text-[10px] font-bold tracking-widest text-secondary">动作</div>
                <textarea
                  v-model="draft.actionText"
                  rows="4"
                  class="custom-scrollbar h-full w-full resize-none border-none bg-transparent p-0 font-body-md text-on-surface focus:ring-0"
                ></textarea>
              </div>
              <div class="relative border border-outline-variant bg-surface-container p-4">
                <div class="absolute -top-3 left-4 bg-background px-2 text-[10px] font-bold tracking-widest text-secondary">对白</div>
                <textarea
                  v-model="draft.dialogueText"
                  rows="4"
                  class="custom-scrollbar h-full w-full resize-none border-none bg-transparent p-0 font-body-md text-on-surface focus:ring-0"
                ></textarea>
              </div>
            </div>
          </div>

          <!-- 右侧：角色 / 构图选择 / 镜头列表 -->
          <div class="col-span-12 flex flex-col gap-4 lg:col-span-5 lg:min-h-0 lg:overflow-y-auto xl:col-span-4">
            <div class="border border-outline-variant bg-surface-container p-4">
              <label class="mb-2 block text-[10px] font-bold tracking-widest text-secondary">角色</label>
              <select
                v-model="draft.characterId"
                class="mb-3 h-10 w-full border border-outline-variant bg-surface-container-lowest px-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                @change="onCharacterChanged"
              >
                <option :value="null">未关联角色</option>
                <option v-for="character in characters" :key="character.id" :value="character.id">
                  {{ character.name }}{{ character.roleTag ? ` / ${character.roleTag}` : '' }}
                </option>
              </select>
              <input
                v-model="draft.characterName"
                class="w-full border-b border-outline-variant bg-transparent p-1 text-sm focus:border-primary focus:outline-none"
                placeholder="画面中显示的角色名"
              />
            </div>

            <div class="border border-outline-variant bg-surface-container p-4">
              <p class="mb-3 text-[10px] font-bold tracking-widest text-secondary">构图快捷</p>
              <div class="grid grid-cols-2 gap-2">
                <button
                  v-for="opt in compositionOptions"
                  :key="opt.id"
                  type="button"
                  class="flex items-center gap-2 border px-3 py-2 text-xs transition-colors"
                  :class="
                    isComposing(opt.label)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-outline-variant bg-surface/80 text-on-surface-variant hover:border-primary hover:text-primary'
                  "
                  @click="draft.composition = opt.label"
                >
                  <span class="material-symbols-outlined text-sm">{{ opt.icon }}</span>
                  {{ opt.label }}
                </button>
              </div>
            </div>

            <div class="border border-outline-variant bg-surface-container p-4">
              <p class="mb-3 text-[10px] font-bold uppercase tracking-widest text-secondary">场景镜头列表</p>
              <div class="space-y-1 max-h-[40vh] overflow-y-auto">
                <button
                  v-for="s in siblingShots"
                  :key="s.id"
                  type="button"
                  class="flex w-full items-center justify-between border p-2 text-left text-xs"
                  :class="
                    s.id === shot?.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-outline-variant bg-surface text-on-surface hover:border-primary'
                  "
                  @click="selectShot(s.id)"
                >
                  <span class="font-bold">镜头 {{ s.shotNo }}</span>
                  <span>{{ s.shotType || '—' }}</span>
                  <span
                    class="uppercase text-[10px]"
                    :class="{
                      'text-green-400': s.status === 'done',
                      'text-primary': s.status === 'generating',
                      'text-red-400': s.status === 'failed',
                      'text-on-surface-variant': s.status === 'pending',
                    }"
                  >{{ s.status }}</span>
                </button>
                <div v-if="!siblingShots.length" class="text-xs text-on-surface-variant">暂无兄弟镜头</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!--
      切镜头 / 切路由前的"丢弃修改"确认弹窗
      - pendingSwitchShotId !== null：同页镜头列表点击
      - pendingRouteChange !== null：浏览器前进/后退 / 外部改 query / SideNav 跳入
      - 两种 pending 互斥（设置一个时清另一个）
      - 标题与确认按钮文案根据 pending 类型动态切换
    -->
    <div
      v-if="pendingSwitchShotId !== null || pendingRouteChange !== null"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-discard-shot-title"
      @click.self="cancelSwitchShot"
    >
      <div class="w-full max-w-lg border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-3 flex items-center gap-3">
          <span class="material-symbols-outlined text-3xl text-yellow-400">warning</span>
          <h2 id="confirm-discard-shot-title" class="font-headline-md text-headline-md text-on-surface">
            {{ pendingRouteChange !== null ? '放弃当前修改并切换上下文？' : '放弃当前修改？' }}
          </h2>
        </div>
        <div class="mb-6 space-y-3 text-sm leading-relaxed text-on-surface-variant">
          <p>
            当前镜头还有未保存的修改（景别 / 机位 / 构图 / 时长 / 角色 / 动作 / 对白 / 提示词 / 图片URL / 状态 任一项被改动）。
          </p>
          <p class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-400">
            {{ pendingRouteChange !== null
              ? '即将切换到其他项目 / 场景 / 镜头，确认后这些修改会不可恢复地丢失。如要保留，请先点"保存"。'
              : '切换后这些修改会不可恢复地丢失。如要保留，请先点"保存"。' }}
          </p>
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
            @click="cancelSwitchShot"
          >
            取消
          </button>
          <button
            type="button"
            class="flex items-center gap-2 border border-red-500 bg-red-500 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-all hover:brightness-110"
            @click="confirmDiscardAndSwitch"
          >
            <span class="material-symbols-outlined text-sm">delete</span>
            丢弃修改并切换
          </button>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: #121412;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #a38c7c;
}
</style>
