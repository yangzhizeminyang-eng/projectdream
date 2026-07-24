<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  confirmVideo,
  generateStoryboardLipSync,
  generateStoryboardVideos,
  getGenerationJob,
  getModelSettings,
  getStoryboard,
  listShotImages,
  listStoryboardVideos,
  type ImageAssetDTO,
  type StoryboardDTO,
  type VideoAssetDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

type PageState =
  | 'missing-project'
  | 'missing-scene'
  | 'missing-shot'
  | 'loading'
  | 'missing-image'
  | 'error'
  | 'ready'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)
const storyboardId = computed(() => Number(route.query.storyboardId) || 0)

const pageState = ref<PageState>('loading')
const storyboard = ref<StoryboardDTO | null>(null)
const confirmedImage = ref<ImageAssetDTO | null>(null)
const confirmedStartFrame = ref<ImageAssetDTO | null>(null)
const confirmedEndFrame = ref<ImageAssetDTO | null>(null)
const videos = ref<VideoAssetDTO[]>([])
const selectedVideoId = ref<number | null>(null)

const motionMode = ref('PAN')
const motionPrompt = ref('')
const durationSeconds = ref(5)
const modelName = ref('cogvideox-flash')
const lipSyncProvider = ref('')
const isFixedDurationModel = computed(() => /^cogvideox(?:-|$)/i.test(modelName.value.trim()))

const loadingVideos = ref(false)
const generating = ref(false)
const lipSyncing = ref(false)
const lipSyncProgress = ref(0)
const confirmingVideoId = ref<number | null>(null)
const errorMsg = ref('')
const infoMsg = ref('')
let lipSyncTimer: ReturnType<typeof setTimeout> | null = null

const selectedVideo = computed<VideoAssetDTO | null>(
  () => videos.value.find((item) => item.id === selectedVideoId.value) || null,
)

const confirmedVideo = computed<VideoAssetDTO | null>(
  () => videos.value.find((item) => item.status === 'confirmed') || null,
)

const motionBaseVideo = computed<VideoAssetDTO | null>(
  () =>
    videos.value.find(
      (item) =>
        (item.status === 'confirmed' || item.status === 'archived') &&
        item.sourceType !== 'lip_sync' &&
        !!item.videoUrl,
    ) || null,
)

const canLipSyncMotionVideo = computed(() => lipSyncProvider.value.toLowerCase() === 'dashscope')

const lipSyncHelperText = computed(() => {
  if (!motionBaseVideo.value) {
    return '想要人物有动作：先生成普通动作视频，并确认其中一条为最终版本，再给它加口型。'
  }
  if (!canLipSyncMotionVideo.value) {
    return '已确认动作视频，但当前口型服务不支持视频底片。请在 AI 设置里把口型服务切换为 DashScope。'
  }
  return '将使用当前已确认动作视频作为底片，只替换对白口型，保留原视频里的动作。'
})

const keyframeHelperText = computed(() => {
  if (confirmedStartFrame.value && confirmedEndFrame.value) {
    return '本次普通视频会从已确认起始帧出发，并用结束帧提示词约束动作终点。'
  }
  if (confirmedStartFrame.value) {
    return '本次普通视频会优先使用起始帧作为底图；建议再补一张结束帧，让动作收尾更稳定。'
  }
  return '当前使用普通静帧作为底图；如果动作容易跑偏，先到画面结果页生成起始帧和结束帧。'
})

function normalizeFrameRole(value?: string | null): 'primary' | 'start' | 'end' {
  if (value === 'start' || value === 'end') return value
  return 'primary'
}

watch(isFixedDurationModel, (fixed) => {
  if (fixed) durationSeconds.value = 5
})

function buildQuery(nextStoryboardId = storyboardId.value) {
  return {
    projectId: String(projectId.value),
    sceneId: String(sceneId.value),
    storyboardId: String(nextStoryboardId),
  }
}

function backToStoryboardEditor(): void {
  router.push({
    path: '/workspace/storyboard/editor',
    query: buildQuery(),
  })
}

function goToFrameModule(): void {
  router.push({
    path: '/workspace/frame/result',
    query: buildQuery(),
  })
}

function syncSelectedVideo(): void {
  const confirmed = videos.value.find((item) => item.status === 'confirmed')
  if (confirmed) {
    selectedVideoId.value = confirmed.id
    return
  }
  const firstVideo = videos.value[0]
  if (firstVideo) {
    selectedVideoId.value = firstVideo.id
    return
  }
  selectedVideoId.value = null
}

async function refreshVideos(): Promise<void> {
  loadingVideos.value = true
  try {
    const items = await listStoryboardVideos(storyboardId.value)
    videos.value = items
    syncSelectedVideo()
  } finally {
    loadingVideos.value = false
  }
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
  infoMsg.value = ''

  try {
    const shot = await getStoryboard(storyboardId.value)
    if (shot.sceneId !== sceneId.value) {
      throw new Error('当前分镜与场景上下文不一致，请检查页面参数')
    }

    storyboard.value = shot
    motionPrompt.value = shot.actionText || ''
    setWorkspaceContext({
      projectId: projectId.value,
      sceneId: shot.sceneId,
      storyboardId: shot.id,
    })

    const images = await listShotImages(storyboardId.value)
    confirmedStartFrame.value =
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'start') || null
    confirmedEndFrame.value =
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'end') || null
    const confirmed =
      confirmedStartFrame.value ||
      images.find((item) => item.status === 'confirmed' && normalizeFrameRole(item.frameRole) === 'primary') ||
      null
    confirmedImage.value = confirmed

    if (!confirmed) {
      videos.value = []
      selectedVideoId.value = null
      pageState.value = 'missing-image'
      return
    }

    await refreshVideos()
    pageState.value = 'ready'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '视频模块加载失败'
    pageState.value = 'error'
  }
}

async function loadModelDefaults(): Promise<void> {
  try {
    const settings = await getModelSettings()
    modelName.value = settings.effective.video.defaultModel || modelName.value
    lipSyncProvider.value = settings.effective.video.lipSyncProvider || ''
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerate(): Promise<void> {
  if (!storyboardId.value || !confirmedImage.value || generating.value) return

  generating.value = true
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    await generateStoryboardVideos(storyboardId.value, {
      prompt: motionPrompt.value.trim() || undefined,
      motionMode: motionMode.value,
      durationSeconds: durationSeconds.value,
      modelName: modelName.value,
      candidateCount: 1,
    })
    await refreshVideos()
    pageState.value = 'ready'
    infoMsg.value = '已生成 1 条候选视频'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '视频生成失败'
  } finally {
    generating.value = false
  }
}

async function pollLipSyncJob(jobId: number): Promise<void> {
  try {
    const job = await getGenerationJob(jobId)
    lipSyncProgress.value = job.progressPercent
    if (job.status === 'success') {
      lipSyncing.value = false
      lipSyncProgress.value = 100
      await refreshVideos()
      infoMsg.value = '对白口型视频已生成并设为当前主版本'
      return
    }
    if (job.status === 'failed' || job.status === 'canceled') {
      lipSyncing.value = false
      errorMsg.value = job.errorText || '对白口型同步失败'
      return
    }
    lipSyncTimer = setTimeout(() => void pollLipSyncJob(jobId), 5000)
  } catch (error) {
    lipSyncing.value = false
    errorMsg.value = error instanceof Error ? error.message : '口型任务状态查询失败'
  }
}

async function onGenerateLipSync(): Promise<void> {
  if (!storyboardId.value || !confirmedImage.value || lipSyncing.value) return
  if (motionBaseVideo.value && !canLipSyncMotionVideo.value) {
    errorMsg.value = '当前口型服务不支持给动作视频加口型，请在 AI 设置里把口型服务切换为 DashScope。'
    return
  }
  lipSyncing.value = true
  lipSyncProgress.value = 0
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const job = await generateStoryboardLipSync(storyboardId.value, { autoConfirm: true })
    infoMsg.value = '对白口型任务已进入后台队列，可以离开此页'
    void pollLipSyncJob(job.id)
  } catch (error) {
    lipSyncing.value = false
    errorMsg.value = error instanceof Error ? error.message : '对白口型任务提交失败'
  }
}

async function onConfirm(videoId: number): Promise<void> {
  if (confirmingVideoId.value) return

  confirmingVideoId.value = videoId
  errorMsg.value = ''
  infoMsg.value = ''
  try {
    const confirmed = await confirmVideo(videoId)
    await refreshVideos()
    selectedVideoId.value = confirmed.id
    infoMsg.value = '最终视频已确认'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '确认最终视频失败'
  } finally {
    confirmingVideoId.value = null
  }
}

function statusLabel(status: string): string {
  if (status === 'confirmed') return '已确认'
  if (status === 'archived') return '已归档'
  return '候选'
}

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

onBeforeUnmount(() => {
  if (lipSyncTimer) clearTimeout(lipSyncTimer)
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
        <p class="state-desc">视频生成依赖具体项目，请从项目工作区进入当前分镜。</p>
        <button class="primary-btn" type="button" @click="router.push('/dashboard')">返回项目台</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少场景上下文</h2>
        <p class="state-desc">视频生成必须知道当前分镜属于哪个场景。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-shot'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少分镜上下文</h2>
        <p class="state-desc">请先选中一个具体分镜，再进入视频生成页。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载视频模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">视频模块加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-image'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">当前分镜还没有已确认静帧</h2>
        <p class="state-desc">请先在静帧模块确认一张最终静帧，再生成视频。</p>
        <div class="flex flex-wrap gap-3">
          <button class="primary-btn" type="button" @click="goToFrameModule">前往静帧模块</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <div v-else class="video-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">
            场景 {{ sceneId }} / 分镜 {{ storyboard?.shotNo || storyboardId }}
          </p>
          <h1 class="page-title">视频生成</h1>
          <p class="page-subtitle">确认起始帧和结束帧 -> 生成 1 条动作视频 -> 确认动作版本 -> 加对白口型</p>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goToFrameModule">回到静帧模块</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>

      <div class="main-grid">
        <section class="panel preview-panel">
          <div class="panel-head">
            <h2>当前预览</h2>
            <span v-if="confirmedVideo" class="status-badge confirmed">已确认主版本</span>
          </div>

          <div v-if="selectedVideo" class="video-stage">
            <video :src="selectedVideo.videoUrl" controls playsinline class="video-player"></video>
          </div>
          <div v-else class="empty-stage">还没有候选视频，先生成一批看看。</div>

          <div class="meta-grid">
            <div class="meta-card">
              <span class="meta-label">视频底图</span>
              <img
                v-if="confirmedImage"
                :src="confirmedImage.thumbnailUrl || confirmedImage.imageUrl"
                alt="confirmed frame"
                class="frame-thumb"
              />
            </div>
            <div class="meta-card">
              <span class="meta-label">当前分镜</span>
              <p class="meta-value">镜头 {{ storyboard?.shotNo || '-' }}</p>
              <p class="meta-sub">{{ storyboard?.shotType || '未填写景别' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">结束帧</span>
              <p class="meta-value">{{ confirmedEndFrame ? '已确认' : '未确认' }}</p>
              <p class="meta-sub">{{ confirmedEndFrame ? '作为动作终点约束' : '可先去画面结果页补齐' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">口型底片</span>
              <p class="meta-value">
                {{ motionBaseVideo ? `V${motionBaseVideo.versionNo}` : '未确认' }}
              </p>
              <p class="meta-sub">
                {{ motionBaseVideo ? '使用动作视频' : '将退回静帧口型' }}
              </p>
            </div>
          </div>
        </section>

        <section class="panel control-panel">
          <div class="panel-head">
            <h2>生成参数</h2>
            <span class="status-badge">{{ modelName }}</span>
          </div>

          <label class="field">
            <span>运动模式</span>
            <select v-model="motionMode" class="field-input">
              <option value="PAN">平移</option>
              <option value="ZOOM">推拉变焦</option>
              <option value="DOLLY">轨道推进</option>
            </select>
          </label>

          <label class="field">
            <span>视频动作提示词</span>
            <textarea
              v-model="motionPrompt"
              rows="5"
              class="field-input resize-y"
              placeholder="描述人物动作、环境变化，以及需要排除的错误效果"
            ></textarea>
          </label>

          <label class="field">
            <span>时长（秒）</span>
            <input
              v-model.number="durationSeconds"
              type="number"
              min="1"
              class="field-input"
              :disabled="isFixedDurationModel"
            />
          </label>

          <label class="field">
            <span>模型名</span>
            <input v-model="modelName" type="text" class="field-input" />
          </label>

          <button class="primary-btn w-full" type="button" :disabled="generating" @click="onGenerate">
            {{ generating ? '生成中...' : '开始生成视频' }}
          </button>

          <button
            class="ghost-btn mt-3 w-full"
            type="button"
            :disabled="lipSyncing"
            @click="onGenerateLipSync"
          >
            {{
              lipSyncing
                ? `口型同步 ${lipSyncProgress}%`
                : motionBaseVideo
                  ? '给动作视频加对白口型'
                  : '生成静帧对白口型'
            }}
          </button>

          <p class="helper-text">每次只为当前分镜生成 1 条候选视频，并绑定当前已确认的普通静帧或起始帧。</p>
          <p class="helper-text keyframe-note">{{ keyframeHelperText }}</p>
          <p class="helper-text lip-sync-note">{{ lipSyncHelperText }}</p>
        </section>
      </div>

      <section class="panel result-panel">
        <div class="panel-head">
          <h2>候选视频列表</h2>
          <span class="status-badge">{{ loadingVideos ? '刷新中' : `${videos.length} 条记录` }}</span>
        </div>

        <div v-if="!videos.length" class="empty-stage small">当前分镜还没有候选视频。</div>

        <div v-else class="result-list">
          <article
            v-for="item in videos"
            :key="item.id"
            class="result-card"
            :class="{ active: item.id === selectedVideoId, confirmed: item.status === 'confirmed' }"
            @click="selectedVideoId = item.id"
          >
            <div class="result-thumb-wrap">
              <img
                :src="item.thumbnailUrl || confirmedImage?.imageUrl"
                alt="video thumbnail"
                class="result-thumb"
              />
              <span class="result-play">播放</span>
            </div>

            <div class="result-body">
              <div class="result-title-row">
                <strong>V{{ item.versionNo }}</strong>
                <span class="status-badge" :class="{ confirmed: item.status === 'confirmed' }">
                  {{ statusLabel(item.status) }}
                </span>
              </div>
              <p class="result-meta">{{ item.motionMode || '未设置运动模式' }}</p>
              <p class="result-meta">{{ item.durationSeconds || 0 }} 秒 / {{ item.modelName || '-' }}</p>
              <button
                class="confirm-btn"
                type="button"
                :disabled="item.status === 'confirmed' || confirmingVideoId === item.id"
                @click.stop="onConfirm(item.id)"
              >
                {{
                  item.status === 'confirmed'
                    ? '当前主版本'
                    : confirmingVideoId === item.id
                      ? '确认中...'
                      : '确认最终版本'
                }}
              </button>
            </div>
          </article>
        </div>
      </section>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.video-page {
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
  grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr);
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

.video-stage,
.empty-stage {
  border: 1px solid #5a4938;
  background: #090909;
  min-height: 300px;
}

.video-player {
  width: 100%;
  height: 100%;
  min-height: 300px;
  background: #000;
}

.empty-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #b79f84;
  font-size: 14px;
  text-align: center;
  padding: 24px;
}

.empty-stage.small {
  min-height: 120px;
}

.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
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

.frame-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border: 1px solid #5a4938;
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

.field-input {
  width: 100%;
  background: #0f100f;
  border: 1px solid #5a4938;
  color: #f4ede5;
  padding: 10px 12px;
  outline: none;
}

.field-input:focus {
  border-color: #f0b56f;
}

.helper-text {
  margin-top: 12px;
  color: #b79f84;
  font-size: 13px;
  line-height: 1.6;
}

.result-panel {
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

.result-thumb-wrap {
  position: relative;
}

.result-thumb {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.result-play {
  position: absolute;
  right: 10px;
  top: 10px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 4px 8px;
  font-size: 11px;
  text-transform: uppercase;
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
  .video-page {
    padding: 16px;
  }

  .page-top,
  .panel-head {
    flex-direction: column;
    align-items: flex-start;
  }

  .main-grid {
    grid-template-columns: 1fr;
  }

  .meta-grid {
    grid-template-columns: 1fr;
  }
}
</style>
