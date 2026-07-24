<script setup lang="ts">
/**
 * @file 角色详情页
 * @description 支持创建模式 / 编辑模式：
 *              - 缺 characterId → 创建模式：填 name 后保存即新建
 *              - 有 characterId → 编辑模式：先 getCharacter 拉详情，所有字段可改，保存走 updateCharacter
 *              字段：name / roleTag / personality / appearance / voiceSetting / referenceImageUrl
 *              已接入：AI 档案补全、角色定妆图候选与确认、TTS 音色试听
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  bindCharacterVoice,
  confirmCharacterImage,
  createCharacter,
  generateCharacterImages,
  generateCharacterProfile,
  getGenerationJob,
  getCharacter,
  getCharacterVoiceRecommendations,
  listCharacterImages,
  previewCharacterRename,
  previewCharacterVoice,
  updateCharacter,
  type CharacterDTO,
  type CharacterImageDTO,
  type CharacterRenameImpactDTO,
  type CharacterVoiceTraitsDTO,
  type VoiceProfileDTO,
  type VoiceRecommendationDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

const route = useRoute()
const router = useRouter()

/**
 * @description 项目上下文 ID（从 query.projectId 读）
 */
const projectId = computed(() => Number(route.query.projectId) || 0)

/**
 * @description 角色上下文 ID（从 query.characterId 读）
 *              - 0 表示"创建模式"
 *              - >0 表示"编辑模式"
 */
const characterId = computed(() => Number(route.query.characterId) || 0)

/**
 * @description 是否创建模式
 */
const isCreateMode = computed<boolean>(() => !characterId.value)

/**
 * @description 缺 projectId：整页友好提示
 */
const missingProjectId = computed<boolean>(() => !projectId.value)

/**
 * @description 页面状态机
 *              - loading    正在请求 getCharacter
 *              - error      接口失败
 *              - mismatch   返回的角色 projectId 与当前 route.query.projectId 不一致
 *                           （防止跨项目上下文错位：旧链接 / 手动改 URL / 错误入口）
 *              - create     缺 characterId（创建模式）
 *              - ready      有角色数据（编辑模式）
 */
type PageState = 'loading' | 'error' | 'mismatch' | 'create' | 'ready'
const pageState = ref<PageState>('loading')
const errorMsg = ref('')
/**
 * @description mismatch 态下记录"该角色真正所属的项目 ID"
 *              用于渲染"返回正确项目列表"按钮
 */
const actualProjectId = ref<number>(0)

/**
 * @description 角色数据（编辑模式用）
 *              服务端拿回来的基线，保存前不修改
 */
const character = ref<CharacterDTO | null>(null)

/**
 * @description 草稿（与 character 字段对应，可编辑）
 *              - 在编辑模式：与 character 同步作为基线，用户改动只影响 draft
 *              - 在创建模式：用户填写的内容，保存时通过 createCharacter 提交
 */
interface CharacterDraft {
  name: string
  roleTag: string
  personality: string
  appearance: string
  voiceSetting: string
  ageGroup: string
  gender: string
  voiceStyle: string
  referenceImageUrl: string
}

const emptyDraft = (): CharacterDraft => ({
  name: '',
  roleTag: '',
  personality: '',
  appearance: '',
  voiceSetting: '',
  ageGroup: '',
  gender: '',
  voiceStyle: '',
  referenceImageUrl: '',
})

const draft = ref<CharacterDraft>(emptyDraft())

/**
 * @description 编辑模式开关
 *              - 编辑模式默认进入"查看"态（只读），用户点"编辑"才解锁
 *              - 创建模式始终为编辑态（创建就是编辑）
 */
const editing = ref<boolean>(false)

/**
 * @description 提交状态
 */
const saving = ref(false)
const infoMsg = ref('')
const profileGenerating = ref(false)
const imageGenerating = ref(false)
const imageGenerationProgress = ref(0)
let imageGenerationTimer: ReturnType<typeof setTimeout> | null = null
const confirmingImageId = ref(0)
const voiceGenerating = ref(false)
const voiceLoading = ref(false)
const voiceBinding = ref(false)
const characterImages = ref<CharacterImageDTO[]>([])
const voicePreviewUrl = ref('')
const voicePreviewText = ref('')
const voiceRecommendations = ref<VoiceRecommendationDTO[]>([])
const selectedVoiceProfile = ref<VoiceProfileDTO | null>(null)
const selectedVoiceProfileKey = ref('')
const voiceTraits = ref<CharacterVoiceTraitsDTO | null>(null)
const ageGroupOptions = [
  { value: 'child', label: '儿童（12 岁及以下）' },
  { value: 'teen', label: '少年（13-18 岁）' },
  { value: 'young_adult', label: '青年（19-35 岁）' },
  { value: 'middle_aged', label: '中年（36-55 岁）' },
  { value: 'senior', label: '老年（56 岁以上）' },
]
const genderOptions = [
  { value: 'male', label: '男性声线' },
  { value: 'female', label: '女性声线' },
  { value: 'neutral', label: '中性 / 系统声线' },
]
const effectiveAgeGroup = computed(() => draft.value.ageGroup || voiceTraits.value?.ageGroup || '')
const effectiveGender = computed(() => draft.value.gender || voiceTraits.value?.gender || '')
const voiceProfileChoices = computed(() => {
  const items: Array<VoiceProfileDTO | VoiceRecommendationDTO> = []
  if (selectedVoiceProfile.value) items.push(selectedVoiceProfile.value)
  for (const profile of voiceRecommendations.value) {
    if (!items.some((item) => item.profileKey === profile.profileKey)) items.push(profile)
  }
  return items
})
const renameImpact = ref<CharacterRenameImpactDTO | null>(null)
const renameConfirmOpen = ref(false)
const historicalMediaCount = computed(() => {
  const media = renameImpact.value?.historicalMedia
  if (!media) return 0
  return media.characterImages + media.imageAssets + media.videoAssets + media.audioAssets
})
const historicalRenameSourceNames = computed(() => {
  const impact = renameImpact.value
  if (!impact) return []
  return impact.sourceNames.filter((name) => name !== impact.oldName)
})

/**
 * @description 是否脏数据（用于保存按钮 disabled / 路由 dirty 保护）
 */
const isDraftDirty = computed<boolean>(() => {
  if (pageState.value === 'create') {
    return draft.value.name.trim() !== '' || hasAnyField(draft.value)
  }
  if (!character.value) return false
  return (
    draft.value.name !== (character.value.name || '') ||
    draft.value.roleTag !== (character.value.roleTag || '') ||
    draft.value.personality !== (character.value.personality || '') ||
    draft.value.appearance !== (character.value.appearance || '') ||
    draft.value.voiceSetting !== (character.value.voiceSetting || '') ||
    draft.value.ageGroup !== (character.value.ageGroup || '') ||
    draft.value.gender !== (character.value.gender || '') ||
    draft.value.voiceStyle !== (character.value.voiceStyle || '') ||
    draft.value.referenceImageUrl !== (character.value.referenceImageUrl || '')
  )
})

/**
 * @description 任一字段有内容
 * @param {CharacterDraft} d
 * @returns {boolean}
 */
function hasAnyField(d: CharacterDraft): boolean {
  return Boolean(
    d.roleTag.trim() ||
      d.personality.trim() ||
      d.appearance.trim() ||
      d.voiceSetting.trim() ||
      d.ageGroup.trim() ||
      d.gender.trim() ||
      d.voiceStyle.trim() ||
      d.referenceImageUrl.trim(),
  )
}

/**
 * @description 从服务端角色同步草稿基线
 * @param {CharacterDTO} ch
 * @returns {void}
 */
function syncDraftFromCharacter(ch: CharacterDTO): void {
  draft.value = {
    name: ch.name || '',
    roleTag: ch.roleTag || '',
    personality: ch.personality || '',
    appearance: ch.appearance || '',
    voiceSetting: ch.voiceSetting || '',
    ageGroup: ch.ageGroup || '',
    gender: ch.gender || '',
    voiceStyle: ch.voiceStyle || '',
    referenceImageUrl: ch.referenceImageUrl || '',
  }
}

/**
 * @description 拉取角色详情
 *              - 缺 characterId：进入 create 态
 *              - 有 characterId：调 getCharacter
 *                  成功：再次校验 character.projectId 与当前 route.query.projectId 是否一致
 *                        - 一致 → ready
 *                        - 不一致 → mismatch（防止跨项目上下文错位）
 *                  失败 → error
 *              - 整个 await 期间携带 projectId+characterId snapshot，回包后校验上下文未变
 * @returns {Promise<void>}
 */
async function loadCharacter(): Promise<void> {
  if (!projectId.value) return
  // 入口快照：异步回包时与当前路由对比，不一致则丢弃
  const snapshot = {
    projectId: projectId.value,
    characterId: characterId.value,
  }
  errorMsg.value = ''
  if (isCreateMode.value) {
    character.value = null
    actualProjectId.value = 0
    draft.value = emptyDraft()
    characterImages.value = []
    voiceRecommendations.value = []
    selectedVoiceProfile.value = null
    selectedVoiceProfileKey.value = ''
    voiceTraits.value = null
    voicePreviewUrl.value = ''
    editing.value = true
    pageState.value = 'create'
    return
  }
  pageState.value = 'loading'
  try {
    const ch = await getCharacter(snapshot.characterId)
    // snapshot 校验：路由已切换 / characterId 已变 → 丢弃过期回包
    if (
      projectId.value !== snapshot.projectId ||
      characterId.value !== snapshot.characterId
    ) {
      return
    }
    // 跨项目校验：返回的 character.projectId 必须等于当前 route.query.projectId
    // 不一致 → 进入 mismatch 态，不渲染任何角色数据
    if (ch.projectId !== snapshot.projectId) {
      character.value = null
      actualProjectId.value = ch.projectId
      pageState.value = 'mismatch'
      errorMsg.value = `该角色属于项目 #${ch.projectId}，与当前项目 #${snapshot.projectId} 不一致。已阻止加载，避免数据错位。`
      return
    }
    character.value = ch
    syncDraftFromCharacter(ch)
    editing.value = false
    pageState.value = 'ready'
    voicePreviewText.value = `我是${ch.name}。故事已经开始，我会做出自己的选择。`
    voicePreviewUrl.value = ''
    try {
      characterImages.value = await listCharacterImages(ch.id)
    } catch {
      characterImages.value = []
    }
    await loadVoiceRecommendations()
  } catch (e) {
    // snapshot 校验：失败也校验一下，避免过期错误污染当前态
    if (
      projectId.value !== snapshot.projectId ||
      characterId.value !== snapshot.characterId
    ) {
      return
    }
    character.value = null
    pageState.value = 'error'
    errorMsg.value = e instanceof Error ? e.message : '角色详情加载失败'
  }
}

async function loadVoiceRecommendations(): Promise<void> {
  if (!characterId.value) return
  voiceLoading.value = true
  try {
    const result = await getCharacterVoiceRecommendations(characterId.value)
    voiceRecommendations.value = result.items
    selectedVoiceProfile.value = result.selectedProfile || null
    selectedVoiceProfileKey.value =
      result.selectedProfile?.profileKey || result.items[0]?.profileKey || ''
    voiceTraits.value = result.traits
  } catch (e) {
    voiceRecommendations.value = []
    selectedVoiceProfile.value = null
    selectedVoiceProfileKey.value = ''
    voiceTraits.value = null
    errorMsg.value = e instanceof Error ? e.message : '角色音色推荐加载失败'
  } finally {
    voiceLoading.value = false
  }
}

/**
 * @description 重试加载
 * @returns {Promise<void>}
 */
async function retry(): Promise<void> {
  await loadCharacter()
}

function characterDraftPayload(syncNameReferences?: boolean) {
  return {
    name: draft.value.name.trim(),
    roleTag: draft.value.roleTag.trim() || null,
    personality: draft.value.personality.trim() || null,
    appearance: draft.value.appearance.trim() || null,
    voiceSetting: draft.value.voiceSetting.trim() || null,
    ageGroup: draft.value.ageGroup || null,
    gender: draft.value.gender || null,
    voiceStyle: draft.value.voiceStyle.trim() || null,
    referenceImageUrl: draft.value.referenceImageUrl.trim() || null,
    ...(syncNameReferences === undefined ? {} : { syncNameReferences }),
  }
}

async function saveExistingCharacter(syncNameReferences?: boolean): Promise<void> {
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await updateCharacter(
      characterId.value,
      characterDraftPayload(syncNameReferences),
    )
    character.value = updated
    syncDraftFromCharacter(updated)
    voicePreviewText.value = `我是${updated.name}。故事已经开始，我会做出自己的选择。`
    editing.value = false
    renameConfirmOpen.value = false
    renameImpact.value = null
    await loadVoiceRecommendations()
    infoMsg.value = syncNameReferences
      ? '角色名与当前项目文本已同步更新'
      : syncNameReferences === false
        ? '角色档案已改名，项目正文保留原名'
        : '已保存'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function onSave(): Promise<void> {
  if (saving.value) return
  const name = draft.value.name.trim()
  if (!name) {
    errorMsg.value = '角色名不能为空'
    return
  }

  if (isCreateMode.value) {
    saving.value = true
    errorMsg.value = ''
    infoMsg.value = ''
    try {
      const created = await createCharacter(projectId.value, characterDraftPayload())
      infoMsg.value = '角色已创建'
      router.replace({
        path: '/workspace/character/detail',
        query: {
          projectId: String(projectId.value),
          characterId: String(created.id),
        },
      })
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '创建角色失败'
    } finally {
      saving.value = false
    }
    return
  }

  if (character.value && name !== character.value.name) {
    saving.value = true
    errorMsg.value = ''
    infoMsg.value = ''
    try {
      renameImpact.value = await previewCharacterRename(characterId.value, name)
      renameConfirmOpen.value = true
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : '角色改名影响检查失败'
    } finally {
      saving.value = false
    }
    return
  }

  await saveExistingCharacter()
}

function cancelRename(): void {
  if (saving.value) return
  renameConfirmOpen.value = false
  renameImpact.value = null
}

async function confirmRename(syncNameReferences: boolean): Promise<void> {
  if (saving.value) return
  await saveExistingCharacter(syncNameReferences)
}

async function checkNameReferences(): Promise<void> {
  if (!character.value || saving.value) return
  saving.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const impact = await previewCharacterRename(characterId.value, character.value.name)
    if (!impact.totalRecords) {
      renameImpact.value = null
      infoMsg.value = '未检测到需要同步的历史姓名引用'
      return
    }
    renameImpact.value = impact
    renameConfirmOpen.value = true
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '姓名引用检查失败'
  } finally {
    saving.value = false
  }
}

async function onGenerateProfile(): Promise<void> {
  if (!characterId.value || profileGenerating.value || editing.value) return
  profileGenerating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const updated = await generateCharacterProfile(characterId.value)
    character.value = updated
    syncDraftFromCharacter(updated)
    voicePreviewText.value = `我是${updated.name}。故事已经开始，我会做出自己的选择。`
    await loadVoiceRecommendations()
    infoMsg.value = 'AI 已补全角色档案，请重新试听并确认音色'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '角色档案生成失败'
  } finally {
    profileGenerating.value = false
  }
}

async function onGenerateImages(): Promise<void> {
  if (!characterId.value || imageGenerating.value || editing.value) return
  imageGenerating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const job = await generateCharacterImages(characterId.value, { candidateCount: 1 })
    imageGenerationProgress.value = job.progressPercent
    infoMsg.value = '定妆图任务已进入后台生成，可离开页面后在任务中心查看'
    await pollCharacterImageJob(job.id)
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '定妆图生成失败'
    imageGenerating.value = false
  }
}

async function pollCharacterImageJob(jobId: number): Promise<void> {
  if (imageGenerationTimer) clearTimeout(imageGenerationTimer)
  try {
    const job = await getGenerationJob(jobId)
    imageGenerationProgress.value = job.progressPercent
    if (job.status === 'success') {
      characterImages.value = await listCharacterImages(characterId.value)
      imageGenerating.value = false
      infoMsg.value = `已生成 ${job.result?.items?.length || 0} 张定妆图候选`
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      imageGenerating.value = false
      errorMsg.value = job.errorText || '定妆图生成失败，请稍后重试'
      return
    }
    infoMsg.value = job.status === 'queued'
      ? '定妆图任务正在排队'
      : `图片模型生成中 ${job.progressPercent}%（繁忙时自动切换备用模型）`
    imageGenerationTimer = setTimeout(() => void pollCharacterImageJob(jobId), 2500)
  } catch (e) {
    imageGenerating.value = false
    errorMsg.value = e instanceof Error ? e.message : '定妆图任务状态查询失败'
  }
}

async function onConfirmImage(image: CharacterImageDTO): Promise<void> {
  if (confirmingImageId.value) return
  confirmingImageId.value = image.id
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const confirmed = await confirmCharacterImage(image.id)
    characterImages.value = characterImages.value.map((item) => ({
      ...item,
      status: item.id === confirmed.id ? 'confirmed' : item.status === 'confirmed' ? 'candidate' : item.status,
      confirmedAt: item.id === confirmed.id ? confirmed.confirmedAt : null,
    }))
    const refreshed = await getCharacter(characterId.value)
    character.value = refreshed
    syncDraftFromCharacter(refreshed)
    infoMsg.value = '定妆图已确认，后续分镜将自动引用'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '定妆图确认失败'
  } finally {
    confirmingImageId.value = 0
  }
}

async function onPreviewVoice(profileKey = selectedVoiceProfileKey.value): Promise<void> {
  if (!characterId.value || voiceGenerating.value) return
  if (!profileKey) {
    errorMsg.value = '请先选择一个音色方案'
    return
  }
  voiceGenerating.value = true
  selectedVoiceProfileKey.value = profileKey
  voicePreviewUrl.value = ''
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const preview = await previewCharacterVoice(characterId.value, {
      text: voicePreviewText.value.trim() || undefined,
      voiceProfileKey: profileKey,
    })
    voicePreviewUrl.value = preview.audioUrl
    selectedVoiceProfileKey.value = profileKey
    infoMsg.value = `音色试听已生成：${preview.voiceProfileName || preview.voiceName}`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '音色试听生成失败'
  } finally {
    voiceGenerating.value = false
  }
}

async function onBindVoice(profileKey = selectedVoiceProfileKey.value): Promise<void> {
  if (!characterId.value || voiceBinding.value || !profileKey) return
  if (editing.value && isDraftDirty.value) {
    errorMsg.value = '请先保存年龄、性别和声音气质，再确认音色'
    return
  }
  voiceBinding.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const result = await bindCharacterVoice(characterId.value, {
      voiceProfileKey: profileKey,
      ageGroup: effectiveAgeGroup.value || null,
      gender: effectiveGender.value || null,
      voiceStyle: draft.value.voiceStyle.trim() || null,
      locked: true,
    })
    character.value = result.character
    syncDraftFromCharacter(result.character)
    selectedVoiceProfile.value = result.selectedProfile
    selectedVoiceProfileKey.value = result.selectedProfile.profileKey
    voiceTraits.value = result.traits
    editing.value = false
    await loadVoiceRecommendations()
    infoMsg.value = `已锁定：${result.selectedProfile.displayName}`
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : '角色音色绑定失败'
  } finally {
    voiceBinding.value = false
  }
}

function ageGroupLabel(value?: string | null): string {
  return ageGroupOptions.find((item) => item.value === value)?.label || '未识别'
}

function genderLabel(value?: string | null): string {
  return genderOptions.find((item) => item.value === value)?.label || '未识别'
}

function profileMatchReasons(profile: VoiceProfileDTO | VoiceRecommendationDTO): string[] {
  return 'matchReasons' in profile ? profile.matchReasons : ['当前已绑定音色']
}

/**
 * @description 取消编辑：把草稿回滚到 character 基线，退出编辑态
 * @returns {void}
 */
function onCancel(): void {
  renameConfirmOpen.value = false
  renameImpact.value = null
  if (character.value) {
    syncDraftFromCharacter(character.value)
  } else {
    draft.value = emptyDraft()
  }
  editing.value = false
  errorMsg.value = ''
  infoMsg.value = ''
}

/**
 * @description 进入编辑模式（仅在 ready 态有效）
 * @returns {void}
 */
function startEdit(): void {
  renameConfirmOpen.value = false
  renameImpact.value = null
  editing.value = true
  infoMsg.value = ''
  errorMsg.value = ''
}

/**
 * @description 返回列表
 * @returns {void}
 */
function goBack(): void {
  router.push({
    path: '/workspace/character',
    query: { projectId: String(projectId.value) },
  })
}

/**
 * @description 缺 projectId 时跳到项目总览
 * @returns {void}
 */
function goDashboard(): void {
  router.push('/dashboard')
}

/**
 * @description mismatch 态专用：跳到该角色真正所属项目的列表页
 * @returns {void}
 */
function goToActualProject(): void {
  const target = actualProjectId.value
  if (!target) {
    goDashboard()
    return
  }
  router.push({
    path: '/workspace/character',
    query: { projectId: String(target) },
  })
}

watch(
  () => [route.query.projectId, route.query.characterId],
  () => {
    if (!missingProjectId.value) void loadCharacter()
  },
)

onMounted(() => {
  if (missingProjectId.value) {
    pageState.value = 'create' // 用 create 态渲染"缺上下文"提示
    return
  }
  setWorkspaceContext({ projectId: projectId.value })
  void loadCharacter()
})

onUnmounted(() => {
  if (imageGenerationTimer) clearTimeout(imageGenerationTimer)
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <div class="flex h-full">
      <!-- 缺 projectId：整页友好提示，不静默失败 -->
      <section
        v-if="missingProjectId"
        class="flex h-full w-full items-center justify-center bg-surface-dim p-8"
      >
        <div class="max-w-xl border border-outline-variant bg-surface-container p-10 text-center">
          <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-primary/40 bg-primary/5">
            <span class="material-symbols-outlined text-3xl text-primary">person_off</span>
          </div>
          <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">缺少项目上下文</h2>
          <p class="mb-6 text-sm leading-relaxed text-on-surface-variant">
            角色详情依附于具体项目。请先从项目控制台选择一个项目。
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
        <!-- 顶部条：返回 + 标题 + 操作按钮 -->
        <div class="flex h-full flex-1 flex-col">
          <header
            class="flex flex-shrink-0 items-center justify-between gap-4 border-b border-outline-variant bg-surface-container-lowest px-margin-md py-4"
          >
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="flex items-center gap-1 border border-outline-variant bg-surface-container-low px-3 py-1.5 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                @click="goBack"
              >
                <span class="material-symbols-outlined text-sm">arrow_back</span>
                返回列表
              </button>
              <nav class="flex items-center gap-2 font-label-sm text-on-surface-variant">
                <span>角色库</span>
                <span class="material-symbols-outlined text-xs">chevron_right</span>
                <span class="text-primary">
                  {{ isCreateMode ? '新建角色' : draft.name || '角色详情' }}
                </span>
              </nav>
            </div>

            <div class="flex flex-wrap items-center justify-end gap-2">
              <!-- 编辑模式按钮组 -->
              <template v-if="pageState === 'ready'">
                <button
                  v-if="!editing"
                  type="button"
                  class="flex items-center gap-1 border border-primary bg-primary/10 px-4 py-1.5 text-xs uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
                  :disabled="profileGenerating || imageGenerating"
                  @click="onGenerateProfile"
                >
                  <span
                    class="material-symbols-outlined text-sm"
                    :class="{ 'animate-spin': profileGenerating }"
                  >{{ profileGenerating ? 'progress_activity' : 'auto_awesome' }}</span>
                  {{ profileGenerating ? '生成中' : 'AI 补全档案' }}
                </button>
                <button
                  v-if="!editing"
                  type="button"
                  class="flex items-center gap-1 border border-outline-variant bg-surface-container-low px-4 py-1.5 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
                  :disabled="saving || profileGenerating || imageGenerating"
                  @click="checkNameReferences"
                >
                  <span class="material-symbols-outlined text-sm">sync_alt</span>
                  检查姓名引用
                </button>
                <button
                  v-if="!editing"
                  type="button"
                  class="flex items-center gap-1 border border-outline-variant bg-surface-container-low px-4 py-1.5 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  @click="startEdit"
                >
                  <span class="material-symbols-outlined text-sm">edit</span>
                  编辑
                </button>
                <template v-else>
                  <button
                    type="button"
                    class="flex items-center gap-1 border border-outline-variant bg-surface-container-low px-4 py-1.5 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
                    :disabled="saving"
                    @click="onCancel"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    class="flex items-center gap-1 bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
                    :disabled="saving || !isDraftDirty || !draft.name.trim()"
                    @click="onSave"
                  >
                    <span
                      v-if="saving"
                      class="material-symbols-outlined animate-spin text-sm"
                    >progress_activity</span>
                    <span v-else class="material-symbols-outlined text-sm">save</span>
                    保存
                  </button>
                </template>
              </template>

              <!-- 创建模式按钮组：只有保存（name 必填） -->
              <button
                v-if="pageState === 'create'"
                type="button"
                class="flex items-center gap-1 bg-primary px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
                :disabled="saving || !draft.name.trim()"
                @click="onSave"
              >
                <span
                  v-if="saving"
                  class="material-symbols-outlined animate-spin text-sm"
                >progress_activity</span>
                <span v-else class="material-symbols-outlined text-sm">save</span>
                创建角色
              </button>

              <!-- mismatch 态：禁用所有数据操作按钮，只在主区提供导航入口 -->
            </div>
          </header>

          <!-- 状态消息条 -->
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
              v-if="pageState === 'error'"
              type="button"
              class="border border-outline-variant bg-surface-container-low px-3 py-1 text-xs text-on-surface-variant hover:border-primary hover:text-primary"
              @click="retry"
            >
              重试
            </button>
          </div>

          <div
            v-if="infoMsg"
            class="mx-margin-md my-3 flex items-center gap-3 border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-on-surface"
            role="status"
          >
            <span class="material-symbols-outlined text-primary">check_circle</span>
            <span>{{ infoMsg }}</span>
          </div>

          <!-- 主区：loading / error / mismatch / 详情 / 创建 -->
          <main
            class="custom-scrollbar flex-1 overflow-y-auto overscroll-y-contain bg-background p-margin-md"
          >
            <!-- loading -->
            <div
              v-if="pageState === 'loading'"
              class="flex h-64 items-center justify-center text-on-surface-variant"
            >
              <div class="flex items-center gap-3">
                <span class="material-symbols-outlined animate-spin">progress_activity</span>
                <span>正在加载角色详情…</span>
              </div>
            </div>

            <!-- mismatch：跨项目上下文错位 -->
            <div
              v-else-if="pageState === 'mismatch'"
              class="mx-auto flex max-w-2xl flex-col items-center justify-center border border-danger-red/40 bg-danger-red/5 p-10 text-center"
            >
              <div class="mb-4 flex h-14 w-14 items-center justify-center border border-danger-red/40 bg-danger-red/10">
                <span class="material-symbols-outlined text-3xl text-danger-red">link_off</span>
              </div>
              <h2 class="mb-2 font-headline-md text-headline-md text-on-surface">跨项目上下文冲突</h2>
              <p class="mb-2 text-sm leading-relaxed text-on-surface-variant">
                {{ errorMsg }}
              </p>
              <p class="mb-6 text-xs leading-relaxed text-outline">
                为了避免数据展示和操作错位，系统已拒绝加载该角色。请选择前往正确的项目，或返回当前项目的角色库。
              </p>
              <div class="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  class="flex items-center gap-2 border border-primary bg-primary px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-secondary-fixed hover:brightness-110"
                  @click="goToActualProject"
                >
                  <span class="material-symbols-outlined text-sm">open_in_new</span>
                  前往项目 #{{ actualProjectId }} 角色库
                </button>
                <button
                  type="button"
                  class="flex items-center gap-2 border border-outline-variant bg-surface-container-low px-4 py-2 text-xs uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary"
                  @click="goBack"
                >
                  <span class="material-symbols-outlined text-sm">arrow_back</span>
                  返回当前项目角色库
                </button>
              </div>
            </div>

            <!-- 表单（create / ready 通用：data 来自 draft） -->
            <form
              v-else-if="pageState === 'create' || pageState === 'ready'"
              class="mx-auto max-w-4xl space-y-6"
              @submit.prevent="onSave"
            >
              <!-- 基础信息卡 -->
              <section class="border border-outline-variant bg-surface-container p-6">
                <div class="mb-6 flex items-center justify-between border-b border-outline-variant pb-4">
                  <h2 class="font-headline-md uppercase text-primary">基础信息</h2>
                  <span class="font-label-sm uppercase tracking-widest text-outline">
                    {{ isCreateMode ? 'CREATE' : `ID #${character?.id ?? '-'}` }}
                  </span>
                </div>

                <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <label class="block">
                    <span class="mb-2 block font-label-sm uppercase tracking-widest text-on-surface-variant">
                      角色名 <span class="text-danger-red">*</span>
                    </span>
                    <input
                      v-model="draft.name"
                      type="text"
                      :readonly="!editing"
                      :class="[
                        'w-full border bg-surface-container-lowest px-3 py-2 font-label-md text-on-surface',
                        'focus:border-primary focus:outline-none focus:ring-0',
                        editing ? 'border-outline' : 'border-transparent',
                        !draft.name.trim() && editing ? 'border-danger-red/60' : '',
                      ]"
                      placeholder="例如：林岚 / Karen"
                      maxlength="200"
                    />
                  </label>

                  <label class="block">
                    <span class="mb-2 block font-label-sm uppercase tracking-widest text-on-surface-variant">
                      角色标签（主角 / 配角 / 反派…）
                    </span>
                    <input
                      v-model="draft.roleTag"
                      type="text"
                      :readonly="!editing"
                      :class="[
                        'w-full border bg-surface-container-lowest px-3 py-2 font-label-md text-on-surface',
                        'focus:border-primary focus:outline-none focus:ring-0',
                        editing ? 'border-outline' : 'border-transparent',
                      ]"
                      placeholder="例如：主角 / 导师 / 反派"
                      maxlength="80"
                    />
                  </label>
                </div>
              </section>

              <!-- 外貌与声音 -->
              <section class="border border-outline-variant bg-surface-container p-6">
                <div class="mb-6 flex items-center justify-between border-b border-outline-variant pb-4">
                  <h2 class="font-headline-md uppercase text-primary">外貌描述</h2>
                  <span class="font-label-sm uppercase tracking-widest text-outline">Appearance</span>
                </div>
                <textarea
                  v-model="draft.appearance"
                  :readonly="!editing"
                  rows="5"
                  :class="[
                    'w-full resize-y border bg-surface-container-lowest px-3 py-2 font-body-md text-on-surface',
                    'focus:border-primary focus:outline-none focus:ring-0',
                    editing ? 'border-outline' : 'border-transparent',
                  ]"
                  placeholder="例如：身高 175cm，黑色短发，右眉骨有一道细长疤痕，眼神锐利。"
                ></textarea>
              </section>

              <section class="border border-outline-variant bg-surface-container p-6">
                <div class="mb-6 flex items-center justify-between border-b border-outline-variant pb-4">
                  <h2 class="font-headline-md uppercase text-primary">性格特征</h2>
                  <span class="font-label-sm uppercase tracking-widest text-outline">Personality</span>
                </div>
                <textarea
                  v-model="draft.personality"
                  :readonly="!editing"
                  rows="4"
                  :class="[
                    'w-full resize-y border bg-surface-container-lowest px-3 py-2 font-body-md text-on-surface',
                    'focus:border-primary focus:outline-none focus:ring-0',
                    editing ? 'border-outline' : 'border-transparent',
                  ]"
                  placeholder="例如：克制、冷静、锋利；在任何场景都优先观察出口与威胁。"
                ></textarea>
              </section>

              <section class="border border-outline-variant bg-surface-container p-6">
                <div class="mb-6 flex items-center justify-between border-b border-outline-variant pb-4">
                  <div>
                    <h2 class="font-headline-md uppercase text-primary">角色音色</h2>
                    <span class="mt-1 block font-label-sm uppercase tracking-widest text-outline">Voice Casting</span>
                  </div>
                  <span
                    class="border px-3 py-1 text-xs"
                    :class="character?.voiceLocked && selectedVoiceProfile
                      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/40 bg-amber-400/10 text-amber-200'"
                  >
                    {{ character?.voiceLocked && selectedVoiceProfile ? '已锁定' : '待确认' }}
                  </span>
                </div>

                <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <label class="block">
                    <span class="mb-2 block text-xs uppercase tracking-widest text-on-surface-variant">角色年龄段</span>
                    <select
                      v-model="draft.ageGroup"
                      :disabled="!editing"
                      class="h-10 w-full border border-outline bg-surface-container-lowest px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:border-transparent disabled:opacity-80"
                    >
                      <option value="">{{ voiceTraits?.ageGroup ? `自动识别：${ageGroupLabel(voiceTraits.ageGroup)}` : '请选择年龄段' }}</option>
                      <option v-for="option in ageGroupOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="mb-2 block text-xs uppercase tracking-widest text-on-surface-variant">声线性别</span>
                    <select
                      v-model="draft.gender"
                      :disabled="!editing"
                      class="h-10 w-full border border-outline bg-surface-container-lowest px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:border-transparent disabled:opacity-80"
                    >
                      <option value="">{{ voiceTraits?.gender ? `自动识别：${genderLabel(voiceTraits.gender)}` : '请选择声线性别' }}</option>
                      <option v-for="option in genderOptions" :key="option.value" :value="option.value">
                        {{ option.label }}
                      </option>
                    </select>
                  </label>
                  <label class="block">
                    <span class="mb-2 block text-xs uppercase tracking-widest text-on-surface-variant">声音气质</span>
                    <input
                      v-model="draft.voiceStyle"
                      type="text"
                      :readonly="!editing"
                      class="h-10 w-full border border-outline bg-surface-container-lowest px-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      maxlength="160"
                      placeholder="例如：低沉、克制、带管理者压迫感"
                    />
                  </label>
                </div>

                <div class="mt-5 border-t border-outline-variant pt-5">
                  <label class="block">
                    <span class="mb-2 block text-xs uppercase tracking-widest text-on-surface-variant">试听台词</span>
                    <input
                      v-model="voicePreviewText"
                      type="text"
                      class="h-10 w-full border border-outline bg-surface-container-lowest px-3 text-sm text-on-surface focus:border-primary focus:outline-none"
                      maxlength="160"
                    />
                  </label>
                </div>

                <div v-if="voiceLoading" class="mt-5 border border-outline-variant p-5 text-sm text-on-surface-variant">
                  正在分析角色并匹配音色...
                </div>
                <div v-else-if="voiceProfileChoices.length" class="mt-5 divide-y divide-outline-variant border border-outline-variant">
                  <div
                    v-for="profile in voiceProfileChoices"
                    :key="profile.profileKey"
                    class="p-4"
                    :class="selectedVoiceProfileKey === profile.profileKey ? 'bg-primary/5' : 'bg-surface-container-lowest'"
                  >
                    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <strong class="text-sm text-on-surface">{{ profile.displayName }}</strong>
                          <span class="border border-outline-variant px-2 py-0.5 text-[11px] text-on-surface-variant">
                            {{ profile.voiceId }} · {{ profile.modelName }}
                          </span>
                          <span
                            v-if="character?.voiceLocked && character.voiceProfileKey === profile.profileKey"
                            class="border border-emerald-400/40 px-2 py-0.5 text-[11px] text-emerald-200"
                          >当前主音色</span>
                        </div>
                        <p class="mt-2 text-sm leading-6 text-on-surface-variant">{{ profile.description }}</p>
                        <div class="mt-2 flex flex-wrap gap-2">
                          <span
                            v-for="reason in profileMatchReasons(profile)"
                            :key="reason"
                            class="border border-primary/25 bg-primary/5 px-2 py-1 text-[11px] text-primary"
                          >{{ reason }}</span>
                        </div>
                      </div>
                      <div class="flex shrink-0 gap-2">
                        <button
                          type="button"
                          class="flex h-9 items-center gap-2 border border-outline px-3 text-xs text-on-surface hover:border-primary disabled:opacity-50"
                          :disabled="isCreateMode || voiceGenerating"
                          @click="onPreviewVoice(profile.profileKey)"
                        >
                          <span class="material-symbols-outlined text-base">volume_up</span>
                          {{ voiceGenerating && selectedVoiceProfileKey === profile.profileKey ? '生成中' : '试听' }}
                        </button>
                        <button
                          type="button"
                          class="flex h-9 items-center gap-2 border border-primary bg-primary/10 px-3 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
                          :disabled="isCreateMode || voiceBinding || (editing && isDraftDirty) || (character?.voiceLocked && character.voiceProfileKey === profile.profileKey)"
                          @click="onBindVoice(profile.profileKey)"
                        >
                          <span class="material-symbols-outlined text-base">lock</span>
                          {{ character?.voiceLocked && character.voiceProfileKey === profile.profileKey ? '已锁定' : '确认绑定' }}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <p v-else class="mt-5 border border-amber-400/30 bg-amber-400/5 p-4 text-sm text-amber-200">
                  暂无可用音色推荐，请先完善角色年龄、性别和外观设定。
                </p>
                <audio
                  v-if="voicePreviewUrl"
                  class="mt-4 h-10 w-full"
                  :src="voicePreviewUrl"
                  controls
                  preload="metadata"
                ></audio>
              </section>

              <section class="border border-outline-variant bg-surface-container p-6">
                <div class="mb-6 flex items-center justify-between border-b border-outline-variant pb-4">
                  <div>
                    <h2 class="font-headline-md uppercase text-primary">角色定妆图</h2>
                    <span class="mt-1 block font-label-sm uppercase tracking-widest text-outline">Character Reference</span>
                  </div>
                  <button
                    type="button"
                    class="flex items-center gap-2 border border-primary bg-primary/10 px-4 py-2 text-xs uppercase tracking-widest text-primary hover:bg-primary/20 disabled:opacity-50"
                    :disabled="isCreateMode || editing || imageGenerating || !draft.appearance.trim()"
                    @click="onGenerateImages"
                  >
                    <span class="material-symbols-outlined text-base" :class="{ 'animate-spin': imageGenerating }">
                      {{ imageGenerating ? 'progress_activity' : 'add_photo_alternate' }}
                    </span>
                    {{ imageGenerating ? `后台生成中 ${imageGenerationProgress}%` : '生成候选' }}
                  </button>
                </div>
                <img
                  v-if="draft.referenceImageUrl"
                  :src="draft.referenceImageUrl"
                  :alt="`${draft.name} 已确认定妆图`"
                  class="mb-5 aspect-[16/9] w-full border border-primary/40 object-contain bg-surface-container-lowest"
                />
                <input
                  v-model="draft.referenceImageUrl"
                  type="text"
                  :readonly="!editing"
                  :class="[
                    'w-full border bg-surface-container-lowest px-3 py-2 font-label-md text-on-surface',
                    'focus:border-primary focus:outline-none focus:ring-0',
                    editing ? 'border-outline' : 'border-transparent',
                  ]"
                  placeholder="https://…"
                  maxlength="500"
                />
                <div
                  v-if="characterImages.length"
                  class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                >
                  <div
                    v-for="image in characterImages"
                    :key="image.id"
                    class="overflow-hidden border bg-surface-container-lowest"
                    :class="image.status === 'confirmed' ? 'border-primary' : 'border-outline-variant'"
                  >
                    <img
                      :src="image.thumbnailUrl || image.imageUrl"
                      :alt="`${draft.name} 定妆候选`"
                      class="aspect-[3/4] w-full object-cover"
                    />
                    <div class="flex h-12 items-center justify-between gap-2 border-t border-outline-variant px-3">
                      <span class="text-[10px] uppercase tracking-widest text-outline">V{{ image.versionNo }}</span>
                      <span v-if="image.status === 'confirmed'" class="flex items-center gap-1 text-xs text-primary">
                        <span class="material-symbols-outlined text-sm">verified</span>
                        已确认
                      </span>
                      <button
                        v-else
                        type="button"
                        class="flex items-center gap-1 text-xs text-on-surface-variant hover:text-primary disabled:opacity-50"
                        :disabled="Boolean(confirmingImageId)"
                        @click="onConfirmImage(image)"
                      >
                        <span
                          class="material-symbols-outlined text-sm"
                          :class="{ 'animate-spin': confirmingImageId === image.id }"
                        >{{ confirmingImageId === image.id ? 'progress_activity' : 'check' }}</span>
                        采用
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <!-- 元信息（只读） -->
              <section
                v-if="pageState === 'ready' && character"
                class="border border-outline-variant bg-surface-container-low p-4 text-xs text-on-surface-variant"
              >
                <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div>
                    <div class="font-label-sm uppercase tracking-widest text-outline">状态</div>
                    <div class="mt-1 font-label-md text-on-surface">{{ character.status }}</div>
                  </div>
                  <div>
                    <div class="font-label-sm uppercase tracking-widest text-outline">所属项目</div>
                    <div class="mt-1 font-label-md text-on-surface">#{{ character.projectId }}</div>
                  </div>
                  <div>
                    <div class="font-label-sm uppercase tracking-widest text-outline">创建时间</div>
                    <div class="mt-1 font-label-md text-on-surface">{{ character.createdAt }}</div>
                  </div>
                  <div>
                    <div class="font-label-sm uppercase tracking-widest text-outline">最近更新</div>
                    <div class="mt-1 font-label-md text-on-surface">{{ character.updatedAt }}</div>
                  </div>
                </div>
              </section>
            </form>
          </main>
        </div>
      </template>
    </div>

    <div
      v-if="renameConfirmOpen && renameImpact"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-character-rename-title"
      @click.self="cancelRename"
    >
      <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-outline-variant bg-surface-container p-6 shadow-2xl">
        <div class="mb-4 flex items-start gap-3">
          <span class="material-symbols-outlined mt-0.5 text-3xl text-primary">manage_accounts</span>
          <div class="min-w-0">
            <h2 id="confirm-character-rename-title" class="font-headline-md text-headline-md text-on-surface">
              {{ renameImpact.oldName === renameImpact.newName ? '统一历史姓名引用？' : '同步角色改名？' }}
            </h2>
            <p class="mt-1 break-words text-sm text-on-surface-variant">
              <template v-if="renameImpact.oldName !== renameImpact.newName">
                <span class="text-outline">{{ renameImpact.oldName }}</span>
                <span class="mx-2 text-primary">→</span>
                <span class="font-bold text-on-surface">{{ renameImpact.newName }}</span>
              </template>
              <template v-else>
                统一使用：<span class="font-bold text-on-surface">{{ renameImpact.newName }}</span>
              </template>
            </p>
            <p
              v-if="renameImpact.sourceNames.length > 1"
              class="mt-2 text-xs leading-relaxed text-outline"
            >
              同时检测到历史姓名：{{ historicalRenameSourceNames.join('、') }}
            </p>
          </div>
        </div>

        <p class="mb-4 text-sm leading-relaxed text-on-surface-variant">
          检测到当前项目共有
          <span class="font-bold text-on-surface">{{ renameImpact.totalRecords }}</span>
          条记录、
          <span class="font-bold text-on-surface">{{ renameImpact.totalOccurrences }}</span>
          处姓名引用可以同步更新。
        </p>

        <div class="mb-4 divide-y divide-outline-variant border-y border-outline-variant text-sm">
          <div class="grid grid-cols-[1fr_auto_auto] gap-4 py-3">
            <span class="text-on-surface">项目简介</span>
            <span class="text-on-surface-variant">{{ renameImpact.sections.project.records }} 条</span>
            <span class="w-16 text-right text-primary">{{ renameImpact.sections.project.occurrences }} 处</span>
          </div>
          <div class="grid grid-cols-[1fr_auto_auto] gap-4 py-3">
            <span class="text-on-surface">最新故事总纲</span>
            <span class="text-on-surface-variant">{{ renameImpact.sections.outline.records }} 条</span>
            <span class="w-16 text-right text-primary">{{ renameImpact.sections.outline.occurrences }} 处</span>
          </div>
          <div class="grid grid-cols-[1fr_auto_auto] gap-4 py-3">
            <span class="text-on-surface">场景与小说正文</span>
            <span class="text-on-surface-variant">{{ renameImpact.sections.scenes.records }} 条</span>
            <span class="w-16 text-right text-primary">{{ renameImpact.sections.scenes.occurrences }} 处</span>
          </div>
          <div class="grid grid-cols-[1fr_auto_auto] gap-4 py-3">
            <span class="text-on-surface">分镜角色、动作、对白与提示词</span>
            <span class="text-on-surface-variant">{{ renameImpact.sections.storyboards.records }} 条</span>
            <span class="w-16 text-right text-primary">{{ renameImpact.sections.storyboards.occurrences }} 处</span>
          </div>
        </div>

        <div class="mb-5 space-y-2 text-xs leading-relaxed">
          <p class="border border-primary/30 bg-primary/5 px-3 py-2 text-on-surface-variant">
            同步操作在一个事务中执行；任一步失败都会整体回滚。分镜和音频后续会根据角色 ID 显示新名字。
          </p>
          <p
            v-if="historicalMediaCount"
            class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-300"
          >
            已有 {{ historicalMediaCount }} 个历史媒体资产不会被改写。若音频或画面内容直接包含旧名字，需要重新生成对应资产。
          </p>
          <p
            v-if="renameImpact.warnings.invalidOutlineJson"
            class="border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-yellow-300"
          >
            最新总纲的结构化数据格式异常，该结构化字段将保持原样，其他文本仍可同步。
          </p>
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <button
            v-if="renameImpact.oldName !== renameImpact.newName"
            type="button"
            class="border border-outline-variant bg-surface-container-low px-4 py-2 text-xs font-bold uppercase tracking-widest text-on-surface-variant hover:border-primary hover:text-primary disabled:opacity-50"
            :disabled="saving"
            @click="cancelRename"
          >
            返回检查
          </button>
          <button
            type="button"
            class="border border-yellow-500/60 bg-yellow-500/10 px-4 py-2 text-xs font-bold text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
            :disabled="saving"
            @click="confirmRename(false)"
          >
            仅改角色档案
          </button>
          <button
            type="button"
            class="flex items-center gap-2 bg-primary px-4 py-2 text-xs font-bold text-on-secondary-fixed hover:brightness-110 disabled:opacity-50"
            :disabled="saving"
            @click="confirmRename(true)"
          >
            <span v-if="saving" class="material-symbols-outlined animate-spin text-sm">progress_activity</span>
            <span v-else class="material-symbols-outlined text-sm">sync</span>
            {{ renameImpact.oldName === renameImpact.newName ? '同步历史引用' : '同步项目文本并保存' }}
          </button>
        </div>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: #0d0f0d;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #554336;
}
</style>
