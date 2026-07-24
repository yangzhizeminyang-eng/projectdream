<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  confirmImage,
  generateShotImages,
  getGenerationJob,
  getModelSettings,
  getStoryboard,
  listShotImages,
  type ImageAssetDTO,
  type StoryboardDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

type FrameRole = 'primary' | 'start' | 'end'

type PageState =
  | 'missing-project'
  | 'missing-scene'
  | 'missing-shot'
  | 'loading'
  | 'empty'
  | 'error'
  | 'ready'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)
const storyboardId = computed(() => Number(route.query.storyboardId) || 0)

const pageState = ref<PageState>('loading')
const storyboard = ref<StoryboardDTO | null>(null)
const images = ref<ImageAssetDTO[]>([])
const selectedImageId = ref<number | null>(null)
const selectedFrameRole = ref<FrameRole>('primary')
const promptText = ref('')
const negativePrompt = ref('')
const modelName = ref('cogview-3-flash')
const generating = ref(false)
const confirmingImageId = ref<number | null>(null)
const errorMsg = ref('')
const infoMsg = ref('')
const generationProgress = ref(0)
let generationTimer: ReturnType<typeof setTimeout> | null = null

const selectedImage = computed<ImageAssetDTO | null>(
  () => images.value.find((item) => item.id === selectedImageId.value) || null,
)

const confirmedImage = computed<ImageAssetDTO | null>(
  () =>
    images.value.find(
      (item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === selectedFrameRole.value,
    ) || null,
)

const confirmedVideoSourceImage = computed<ImageAssetDTO | null>(
  () =>
    images.value.find(
      (item) =>
        item.status === 'confirmed' &&
        (normalizeFrameRole(item.frameRole) === 'start' || normalizeFrameRole(item.frameRole) === 'primary'),
    ) || null,
)

const startFrameImage = computed<ImageAssetDTO | null>(
  () => images.value.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'start') || null,
)

const endFrameImage = computed<ImageAssetDTO | null>(
  () => images.value.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'end') || null,
)

const frameRoleOptions: Array<{ value: FrameRole; label: string; hint: string }> = [
  { value: 'primary', label: '普通静帧', hint: '适合静态画面或没有复杂动作的视频底图' },
  { value: 'start', label: '起始帧', hint: '控制普通视频从哪里开始' },
  { value: 'end', label: '结束帧', hint: '约束普通视频动作最后到哪里' },
]

function normalizeFrameRole(value?: string | null): FrameRole {
  if (value === 'start' || value === 'end') return value
  return 'primary'
}

function frameRoleLabel(value?: string | null): string {
  const role = normalizeFrameRole(value)
  if (role === 'start') return '起始帧'
  if (role === 'end') return '结束帧'
  return '普通静帧'
}

function frameRoleStatusText(role: FrameRole): string {
  if (role === 'start') return startFrameImage.value ? '已确认' : '未确认'
  if (role === 'end') return endFrameImage.value ? '已确认' : '未确认'
  return images.value.some((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'primary')
    ? '已确认'
    : '未确认'
}

function defaultPromptForRole(role: FrameRole, shot: StoryboardDTO | null): string {
  if (!shot) return ''
  if (role === 'start') return shot.startVisualPrompt || shot.visualPrompt || ''
  if (role === 'end') return shot.endVisualPrompt || shot.visualPrompt || ''
  return shot.visualPrompt || ''
}

function buildQuery() {
  return {
    projectId: String(projectId.value),
    sceneId: String(sceneId.value),
    storyboardId: String(storyboardId.value),
  }
}

function backToStoryboardEditor(): void {
  router.push({
    path: '/workspace/storyboard/editor',
    query: buildQuery(),
  })
}

function backToGenerate(): void {
  router.push({
    path: '/workspace/frame',
    query: buildQuery(),
  })
}

function goToVideoModule(): void {
  router.push({
    path: '/workspace/video',
    query: buildQuery(),
  })
}

function syncSelectedImage(preferredId?: number | null): void {
  if (preferredId && images.value.some((item) => item.id === preferredId)) {
    selectedImageId.value = preferredId
    return
  }

  const confirmed = images.value.find((item) => item.status === 'confirmed')
  const confirmedForRole = images.value.find(
    (item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === selectedFrameRole.value,
  )
  if (confirmedForRole) {
    selectedImageId.value = confirmedForRole.id
    return
  }

  const firstForRole = images.value.find((item) => normalizeFrameRole(item.frameRole) === selectedFrameRole.value)
  if (firstForRole) {
    selectedImageId.value = firstForRole.id
    return
  }

  if (confirmed) {
    selectedImageId.value = confirmed.id
    return
  }

  const first = images.value[0]
  selectedImageId.value = first ? first.id : null
}

async function refreshImages(preferredId?: number | null): Promise<void> {
  const items = await listShotImages(storyboardId.value)
  images.value = items

  if (!items.length) {
    selectedImageId.value = null
    pageState.value = 'empty'
    return
  }

  syncSelectedImage(preferredId)
  pageState.value = 'ready'
}

async function loadPage(): Promise<void> {
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

  pageState.value = 'loading'
  errorMsg.value = ''

  try {
    const shot = await getStoryboard(storyboardId.value)
    if (shot.sceneId !== sceneId.value) {
      throw new Error('当前分镜与场景上下文不一致，请重新从分镜编辑页进入')
    }

    storyboard.value = shot
    promptText.value = defaultPromptForRole(selectedFrameRole.value, shot)
    setWorkspaceContext({
      projectId: projectId.value,
      sceneId: shot.sceneId,
      storyboardId: shot.id,
    })

    await refreshImages()
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '画面结果页加载失败'
    pageState.value = 'error'
  }
}

async function loadModelDefaults(): Promise<void> {
  try {
    const settings = await getModelSettings()
    modelName.value = settings.effective.frame.defaultModel || modelName.value
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerateMore(): Promise<void> {
  if (!storyboardId.value || generating.value) return

  generating.value = true
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const job = await generateShotImages(storyboardId.value, {
      prompt: promptText.value.trim() || undefined,
      negativePrompt: negativePrompt.value.trim() || undefined,
      modelName: modelName.value.trim() || undefined,
      candidateCount: 1,
      frameRole: selectedFrameRole.value,
    })
    generationProgress.value = job.progressPercent
    infoMsg.value = '新一轮静帧任务已进入后台生成'
    await pollGenerationJob(job.id)
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '重新生成画面失败'
    generating.value = false
  }
}

async function pollGenerationJob(jobId: number): Promise<void> {
  if (generationTimer) clearTimeout(generationTimer)
  try {
    const job = await getGenerationJob(jobId)
    generationProgress.value = job.progressPercent
    if (job.status === 'success') {
      generating.value = false
      await refreshImages()
      infoMsg.value = `已新增 ${job.result?.items?.length || 0} 张候选画面`
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      generating.value = false
      errorMsg.value = job.errorText || '图片模型生成失败，请稍后重试'
      return
    }
    infoMsg.value = job.status === 'queued'
      ? '静帧任务正在排队'
      : `图片模型生成中 ${job.progressPercent}%（繁忙时自动切换备用模型）`
    generationTimer = setTimeout(() => void pollGenerationJob(jobId), 2500)
  } catch (error) {
    generating.value = false
    errorMsg.value = error instanceof Error ? error.message : '生成任务状态查询失败'
  }
}

async function onConfirm(imageId: number): Promise<void> {
  if (confirmingImageId.value) return

  confirmingImageId.value = imageId
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const confirmed = await confirmImage(imageId)
    await refreshImages(confirmed.id)
    infoMsg.value = `${frameRoleLabel(confirmed.frameRole)}已确认并回写到分镜`
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '确认静帧失败'
  } finally {
    confirmingImageId.value = null
  }
}

function statusLabel(status: string): string {
  return status === 'confirmed' ? '已确认' : '候选'
}

watch(selectedFrameRole, (role) => {
  promptText.value = defaultPromptForRole(role, storyboard.value)
  syncSelectedImage()
})

watch(
  () => [route.query.projectId, route.query.sceneId, route.query.storyboardId],
  () => {
    void loadPage()
  },
)

onMounted(() => {
  void loadModelDefaults()
  void loadPage()
})

onUnmounted(() => {
  if (generationTimer) clearTimeout(generationTimer)
})
</script>

<template>
  <WorkspaceLayout :show-side="true" :show-inspector="false" :no-padding="true">
    <section
      v-if="pageState === 'missing-project'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少项目上下文</h2>
        <p class="state-desc">画面结果页必须依赖当前项目，请从具体分镜进入。</p>
        <button class="primary-btn" type="button" @click="router.push('/dashboard')">返回项目页</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少场景上下文</h2>
        <p class="state-desc">请先定位到具体场景，再查看该分镜的画面结果。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-shot'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少分镜上下文</h2>
        <p class="state-desc">请先选择一个具体分镜，再进入画面结果页。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载画面结果...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">画面结果页加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <section
      v-else-if="pageState === 'empty'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">当前分镜还没有候选画面</h2>
        <p class="state-desc">先生成一组静帧候选，结果页才会显示可确认版本。</p>
        <div class="flex flex-wrap gap-3">
          <button class="primary-btn" type="button" @click="backToGenerate">去生成画面</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <div v-else class="result-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">场景 {{ sceneId }} / 分镜 {{ storyboard?.shotNo || storyboardId }}</p>
          <h1 class="page-title">画面结果</h1>
          <p class="page-subtitle">按普通静帧、起始帧、结束帧管理候选图，为普通视频生成准备稳定首尾参考。</p>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="backToGenerate">继续生成</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
          <button class="primary-btn" type="button" :disabled="!confirmedVideoSourceImage" @click="goToVideoModule">进入视频生成</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>

      <div class="main-grid">
        <section class="panel preview-panel">
          <div class="panel-head">
            <h2>当前预览</h2>
            <span v-if="confirmedImage" class="status-badge confirmed">{{ frameRoleLabel(selectedFrameRole) }}已确认</span>
          </div>

          <div class="preview-stage">
            <img v-if="selectedImage" :src="selectedImage.imageUrl" alt="selected frame" class="preview-image" />
            <div v-else class="preview-empty">暂无可预览画面</div>
          </div>

          <div class="meta-grid">
            <div class="meta-card">
              <span class="meta-label">当前分镜</span>
              <p class="meta-value">镜头 {{ storyboard?.shotNo || '-' }}</p>
              <p class="meta-sub">{{ storyboard?.shotType || '未填写景别' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">当前版本</span>
              <p class="meta-value">V{{ selectedImage?.versionNo || '-' }}</p>
              <p class="meta-sub">{{ frameRoleLabel(selectedImage?.frameRole) }} / {{ statusLabel(selectedImage?.status || 'candidate') }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">生成模型</span>
              <p class="meta-value">{{ selectedImage?.modelName || '-' }}</p>
              <p class="meta-sub">{{ selectedImage?.createdAt || '-' }}</p>
            </div>
          </div>
        </section>

        <section class="panel control-panel">
          <div class="panel-head">
            <h2>追加生成</h2>
            <span class="status-badge">{{ modelName }}</span>
          </div>

          <div class="frame-role-tabs" role="tablist" aria-label="选择画面类型">
            <button
              v-for="option in frameRoleOptions"
              :key="option.value"
              type="button"
              class="role-tab"
              :class="{ active: selectedFrameRole === option.value }"
              @click="selectedFrameRole = option.value"
            >
              <span>{{ option.label }}</span>
              <small>{{ frameRoleStatusText(option.value) }}</small>
            </button>
          </div>
          <p class="helper-text role-helper">
            {{ frameRoleOptions.find((item) => item.value === selectedFrameRole)?.hint }}
          </p>

          <label class="field">
            <span>{{ frameRoleLabel(selectedFrameRole) }}提示词</span>
            <textarea
              v-model="promptText"
              rows="7"
              class="field-textarea"
              placeholder="输入当前分镜的画面提示词..."
            ></textarea>
          </label>

          <label class="field">
            <span>负向提示词</span>
            <input v-model="negativePrompt" type="text" class="field-input" placeholder="可选" />
          </label>

          <label class="field">
            <span>模型名</span>
            <input v-model="modelName" type="text" class="field-input" />
          </label>

          <button class="primary-btn wide" type="button" :disabled="generating" @click="onGenerateMore">
            {{ generating ? `后台生成中 ${generationProgress}%` : `生成 1 张${frameRoleLabel(selectedFrameRole)}` }}
          </button>

          <p class="helper-text">
            每次只生成 1 张候选图。每种画面类型各自只能确认 1 张，确认后会同步回写到当前分镜。
          </p>
        </section>
      </div>

      <section class="panel result-panel">
        <div class="panel-head">
          <h2>候选版本</h2>
          <span class="status-badge">{{ images.length }} 张记录</span>
        </div>

        <div class="result-list">
          <article
            v-for="item in images"
            :key="item.id"
            class="result-card"
            :class="{ active: item.id === selectedImageId, confirmed: item.status === 'confirmed' }"
            @click="selectedImageId = item.id"
          >
            <img :src="item.thumbnailUrl || item.imageUrl" alt="candidate frame" class="result-thumb" />
            <div class="result-body">
              <div class="result-title-row">
                <strong>V{{ item.versionNo }}</strong>
                <span class="status-badge" :class="{ confirmed: item.status === 'confirmed' }">
                  {{ statusLabel(item.status) }}
                </span>
              </div>
              <p class="result-meta">{{ frameRoleLabel(item.frameRole) }}</p>
              <p class="result-meta">{{ item.modelName || 'cogview-3-flash' }}</p>
              <p class="result-meta line-clamp">{{ item.promptSnapshot || '未记录提示词快照' }}</p>
              <button
                class="confirm-btn"
                type="button"
                :disabled="item.status === 'confirmed' || confirmingImageId === item.id"
                @click.stop="onConfirm(item.id)"
              >
                {{
                  item.status === 'confirmed'
                    ? `当前${frameRoleLabel(item.frameRole)}`
                    : confirmingImageId === item.id
                      ? '确认中...'
                      : `确认${frameRoleLabel(item.frameRole)}`
                }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <section class="panel history-panel">
        <div class="panel-head">
          <h2>生成历史</h2>
          <span class="status-badge">{{ images.length }} 条记录</span>
        </div>
        <div class="history-strip">
          <button
            v-for="item in images"
            :key="`history-${item.id}`"
            type="button"
            class="history-item"
            :class="{ active: item.id === selectedImageId }"
            @click="selectedImageId = item.id"
          >
            <img :src="item.thumbnailUrl || item.imageUrl" alt="history frame" class="history-thumb" />
            <span class="history-label">#{{ item.id }}</span>
          </button>
        </div>
      </section>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.result-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(217, 119, 6, 0.12), transparent 28%),
    linear-gradient(180deg, #111210 0%, #0a0b0a 100%);
  color: #f4ede5;
  padding: 24px;
}

.page-top {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 20px;
}

.eyebrow {
  color: #f0b56f;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.page-title {
  font-size: 32px;
  font-weight: 800;
  margin: 0;
}

.page-subtitle {
  margin-top: 8px;
  color: #c7b39a;
  font-size: 14px;
}

.top-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.95fr);
  gap: 20px;
  margin-bottom: 20px;
}

.panel {
  background: rgba(20, 21, 19, 0.94);
  border: 1px solid #8d6f4a;
  padding: 18px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
}

.panel-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.preview-stage {
  border: 1px solid #5a4938;
  background: #090909;
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.preview-image {
  width: 100%;
  height: 100%;
  min-height: 320px;
  object-fit: cover;
  background: #000;
}

.preview-empty {
  color: #b79f84;
  font-size: 14px;
  text-align: center;
  padding: 24px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.meta-card {
  border: 1px solid #5a4938;
  background: #161715;
  padding: 12px;
}

.meta-label {
  display: block;
  color: #c9ab83;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.meta-value {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.meta-sub {
  margin-top: 6px;
  color: #b79f84;
  font-size: 13px;
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field span {
  display: block;
  margin-bottom: 6px;
  color: #c9ab83;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.field-textarea,
.field-input {
  width: 100%;
  background: #0f100f;
  border: 1px solid #5a4938;
  color: #f4ede5;
  padding: 10px 12px;
  outline: none;
}

.field-textarea {
  resize: vertical;
}

.field-textarea:focus,
.field-input:focus {
  border-color: #f0b56f;
}

.frame-role-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.role-tab {
  min-height: 62px;
  border: 1px solid #5a4938;
  background: #10110f;
  color: #f4ede5;
  padding: 10px;
  text-align: left;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.role-tab span,
.role-tab small {
  display: block;
}

.role-tab span {
  font-size: 13px;
  font-weight: 800;
}

.role-tab small {
  margin-top: 6px;
  color: #b79f84;
  font-size: 11px;
}

.role-tab.active {
  border-color: #f0b56f;
  background: rgba(217, 119, 6, 0.14);
}

.role-tab.active small {
  color: #f0b56f;
}

.role-helper {
  margin-bottom: 14px;
}

.helper-text {
  margin-top: 12px;
  color: #b79f84;
  font-size: 13px;
  line-height: 1.6;
}

.result-panel,
.history-panel {
  margin-top: 4px;
}

.result-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.result-card {
  border: 1px solid #5a4938;
  background: #151614;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.result-card:hover,
.result-card.active {
  border-color: #f0b56f;
  transform: translateY(-2px);
}

.result-card.confirmed {
  box-shadow: 0 0 0 1px rgba(240, 181, 111, 0.4);
}

.result-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.result-body {
  padding: 12px;
}

.result-title-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}

.result-meta {
  margin: 4px 0;
  color: #b79f84;
  font-size: 13px;
}

.line-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.history-strip {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.history-item {
  flex: 0 0 148px;
  border: 1px solid #5a4938;
  background: #151614;
  padding: 0;
  cursor: pointer;
}

.history-item.active {
  border-color: #f0b56f;
}

.history-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.history-label {
  display: block;
  padding: 8px 10px;
  color: #c9ab83;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.primary-btn,
.ghost-btn,
.confirm-btn {
  border: 1px solid #8d6f4a;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 700;
  transition: 0.2s ease;
}

.primary-btn {
  background: #d97706;
  color: #111210;
}

.primary-btn:hover {
  filter: brightness(1.08);
}

.ghost-btn {
  background: transparent;
  color: #f4ede5;
}

.ghost-btn:hover,
.confirm-btn:hover {
  border-color: #f0b56f;
  color: #f0b56f;
}

.confirm-btn {
  width: 100%;
  margin-top: 12px;
  background: #10110f;
  color: #f4ede5;
}

.wide {
  width: 100%;
}

.primary-btn:disabled,
.ghost-btn:disabled,
.confirm-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid #5a4938;
  background: #171816;
  color: #c9ab83;
  font-size: 11px;
  padding: 4px 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.status-badge.confirmed {
  border-color: #f0b56f;
  color: #f0b56f;
}

.message {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid;
  font-size: 13px;
}

.message.error {
  border-color: rgba(248, 113, 113, 0.5);
  background: rgba(127, 29, 29, 0.15);
  color: #fecaca;
}

.message.success {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(20, 83, 45, 0.18);
  color: #bbf7d0;
}

.state-card {
  width: min(560px, 100%);
  border: 1px solid #8d6f4a;
  background: rgba(20, 21, 19, 0.96);
  padding: 28px;
}

.state-title {
  margin: 0 0 10px;
  font-size: 24px;
  font-weight: 800;
  color: #f4ede5;
}

.state-desc {
  margin: 0 0 18px;
  color: #c7b39a;
  line-height: 1.7;
}

@media (max-width: 960px) {
  .result-page {
    padding: 16px;
  }

  .page-top,
  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .main-grid,
  .frame-role-tabs,
  .meta-grid {
    grid-template-columns: 1fr;
  }
}
</style>
