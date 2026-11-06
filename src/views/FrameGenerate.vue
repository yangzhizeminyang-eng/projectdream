<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  generateShotImages,
  getGenerationJob,
  getModelSettings,
  getStoryboard,
  rewriteStoryboardFramePrompt,
  type StoryboardDTO,
} from '@/api/project'
import { setWorkspaceContext } from '@/lib/context'

type FrameRole = 'primary' | 'start' | 'end'

type PageState =
  | 'missing-project'
  | 'missing-scene'
  | 'missing-shot'
  | 'loading'
  | 'error'
  | 'ready'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => Number(route.query.projectId) || 0)
const sceneId = computed(() => Number(route.query.sceneId) || 0)
const storyboardId = computed(() => Number(route.query.storyboardId) || 0)

const pageState = ref<PageState>('loading')
const storyboard = ref<StoryboardDTO | null>(null)
const selectedFrameRole = ref<FrameRole>('primary')
const promptText = ref('')
const negativePrompt = ref('')
const modelName = ref('agnes-image-2.1-flash')
const generating = ref(false)
const rewritingPrompt = ref(false)
const errorMsg = ref('')
const infoMsg = ref('')
const generationProgress = ref(0)
let generationTimer: ReturnType<typeof setTimeout> | null = null

const promptTokens = computed(() => promptText.value.trim().length)
const previewImageUrl = computed(() => storyboard.value?.imageUrl || '')
const frameCharacterContext = computed(() => storyboard.value?.frameCharacterContext || null)
const canGenerate = computed(() => frameCharacterContext.value?.ready !== false)

const frameRoleOptions: Array<{ value: FrameRole; label: string; hint: string }> = [
  { value: 'primary', label: '普通静帧', hint: '适合静态画面或简单动作底图' },
  { value: 'start', label: '起始帧', hint: '控制普通视频从哪里开始' },
  { value: 'end', label: '结束帧', hint: '约束普通视频最后到哪里' },
]

function frameRoleLabel(role: FrameRole): string {
  if (role === 'start') return '起始帧'
  if (role === 'end') return '结束帧'
  return '普通静帧'
}

function defaultPromptForRole(role: FrameRole, shot: StoryboardDTO | null): string {
  // 普通静帧、起始帧、结束帧共用一个页面，但默认提示词来源不同。
  // 起始帧/结束帧用于控制后续视频动作的开始和收尾。
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

function goToResult(): void {
  router.push({
    path: '/workspace/episodes/studio',
    query: buildQuery(),
  })
}

async function loadPage(): Promise<void> {
  // 页面加载时必须同时拿到项目、场景、分镜三个上下文。
  // 少任何一个，后端都无法判断应该给哪条分镜生成图片。
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
    pageState.value = 'ready'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '画面生成页加载失败'
    pageState.value = 'error'
  }
}

async function loadModelDefaults(): Promise<void> {
  // 模型默认值来自“模型设置中心”。
  // 如果设置接口暂时不可用，页面保留内置默认模型，避免直接崩掉。
  try {
    const settings = await getModelSettings()
    modelName.value = settings.effective.frame.defaultModel || modelName.value
  } catch {
    // 设置中心不可用时保留页面内置默认值。
  }
}

async function onGenerate(): Promise<void> {
  // 用户点击生成时，只是提交一个后台任务。
  // 真正调用图片模型、下载图片、入库都在后端 generation job 中完成。
  if (!storyboardId.value || generating.value) return
  if (!canGenerate.value) {
    errorMsg.value = frameCharacterContext.value?.blockers[0] || '请先完善分镜角色信息'
    return
  }

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
    infoMsg.value = '静帧任务已进入后台生成，可离开页面后在任务中心查看'
    await pollGenerationJob(job.id)
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '画面生成失败'
    generating.value = false
  }
}

async function onRewritePrompt(): Promise<void> {
  // 让文本模型根据项目/场景/分镜/角色上下文重写视觉提示词。
  // 注意：这里改的是提示词，不直接生成图片。
  if (!storyboardId.value || rewritingPrompt.value) return
  rewritingPrompt.value = true
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const result = await rewriteStoryboardFramePrompt(storyboardId.value)
    promptText.value = result.visualPrompt
    if (storyboard.value && result.frameCharacterContext) {
      storyboard.value = {
        ...storyboard.value,
        frameCharacterContext: result.frameCharacterContext,
      }
    }
    infoMsg.value = result.notes || 'AI 已根据剧情上下文重写视觉提示词，角色外貌仍由定妆图锁定'
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '视觉提示词重写失败'
  } finally {
    rewritingPrompt.value = false
  }
}

async function pollGenerationJob(jobId: number): Promise<void> {
  // 轮询后台任务状态。
  // success 后跳结果页；failed/canceled 则停在当前页展示错误。
  if (generationTimer) clearTimeout(generationTimer)
  try {
    const job = await getGenerationJob(jobId)
    generationProgress.value = job.progressPercent
    if (job.status === 'success') {
      generating.value = false
      infoMsg.value = `已生成 ${job.result?.items?.length || 0} 张候选画面`
      goToResult()
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

watch(
  () => [route.query.projectId, route.query.sceneId, route.query.storyboardId],
  () => {
    void loadPage()
  },
)

watch(selectedFrameRole, (role) => {
  promptText.value = defaultPromptForRole(role, storyboard.value)
})

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
        <p class="state-desc">画面生成必须依赖当前项目，请从项目工作区进入具体分镜。</p>
        <button class="primary-btn" type="button" @click="router.push('/dashboard')">返回项目页</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-scene'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少场景上下文</h2>
        <p class="state-desc">请先定位到具体场景，再为该场景下的分镜生成画面。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <section
      v-else-if="pageState === 'missing-shot'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card">
        <h2 class="state-title">缺少分镜上下文</h2>
        <p class="state-desc">请先选择一个具体分镜，再进入画面生成页面。</p>
        <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载画面生成模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">画面生成页加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>
    </section>

    <div v-else class="frame-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">场景 {{ sceneId }} / 分镜 {{ storyboard?.shotNo || storyboardId }}</p>
          <h1 class="page-title">画面生成</h1>
          <p class="page-subtitle">基于当前分镜提示词生成 1 张候选静帧。有人物出镜时，必须先绑定角色并确认定妆图。</p>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goToResult">查看结果页</button>
          <button class="ghost-btn" type="button" @click="backToStoryboardEditor">返回分镜编辑</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>

      <div class="main-grid">
        <section class="preview-shell">
          <div class="preview-stage">
            <img v-if="previewImageUrl" :src="previewImageUrl" alt="分镜预览图" class="preview-image" />
            <div v-else class="preview-empty">
              <span class="material-symbols-outlined text-6xl">image</span>
              <p>当前分镜还没有已回写画面，生成后会在结果页出现候选图。</p>
            </div>
          </div>
          <div class="shot-meta">
            <div class="meta-card">
              <span class="meta-label">当前分镜</span>
              <p class="meta-value">分镜 {{ storyboard?.shotNo || '-' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">景别</span>
              <p class="meta-value">{{ storyboard?.shotType || '未填写' }}</p>
            </div>
            <div class="meta-card">
              <span class="meta-label">角色</span>
              <p class="meta-value">{{ storyboard?.characterName || '未填写' }}</p>
            </div>
          </div>
        </section>

        <section class="control-panel">
          <div class="panel-head">
            <h2>生成参数</h2>
            <span class="panel-tag">{{ modelName }}</span>
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
              <small>{{ option.hint }}</small>
            </button>
          </div>

          <label class="field">
            <span>{{ frameRoleLabel(selectedFrameRole) }}提示词</span>
            <small>只写这一镜的场景、动作、镜头和氛围；人物长相由下方定妆图自动锁定。</small>
            <textarea
              v-model="promptText"
              rows="8"
              class="field-textarea"
              placeholder="不会写可以直接点下面的 AI 重写视觉提示词"
            ></textarea>
          </label>
          <div class="prompt-tools">
            <button class="ghost-btn" type="button" :disabled="rewritingPrompt || generating" @click="onRewritePrompt">
              <span class="material-symbols-outlined">auto_awesome</span>
              {{ rewritingPrompt ? 'AI 重写中' : 'AI 重写视觉提示词' }}
            </button>
            <p>自动读取总纲、场景、剧本和分镜，补齐这一镜该出现的动作、道具、光线和构图；不会改写角色外貌。</p>
          </div>

          <section
            class="character-check"
            :class="frameCharacterContext?.ready ? 'ready' : 'blocked'"
          >
            <div class="character-check-head">
              <div>
                <span class="character-check-label">角色一致性检查</span>
                <strong>{{ frameCharacterContext?.ready ? '生成约束已就绪' : '需要先修正角色信息' }}</strong>
              </div>
              <span class="material-symbols-outlined">
                {{ frameCharacterContext?.ready ? 'verified' : 'warning' }}
              </span>
            </div>

            <p v-if="frameCharacterContext?.characterFree" class="character-empty">
              当前识别为空镜，不注入人物设定。
            </p>
            <div v-else-if="frameCharacterContext?.characters.length" class="character-list">
              <article
                v-for="character in frameCharacterContext.characters"
                :key="character.characterId"
                class="character-item"
              >
                <img
                  v-if="character.referenceImageUrl"
                  :src="character.referenceImageUrl"
                  :alt="`${character.name} 定妆参考`"
                  class="character-reference"
                />
                <div v-else class="character-reference missing">
                  <span class="material-symbols-outlined">person</span>
                </div>
                <div class="character-copy">
                  <div class="character-name-line">
                    <strong>{{ character.name }}</strong>
                    <span v-if="character.isPrimary">主要主体</span>
                  </div>
                  <p>{{ character.genderLabel }} · {{ character.ageGroupLabel }}</p>
                  <p class="character-appearance">{{ character.appearance || '尚未填写固定外貌' }}</p>
                  <small>{{ character.hasReferenceImage ? '已使用确认定妆图' : '需先确认定妆图' }}</small>
                </div>
              </article>
            </div>

            <ul v-if="frameCharacterContext?.blockers.length" class="check-messages blockers">
              <li v-for="message in frameCharacterContext.blockers" :key="message">{{ message }}</li>
            </ul>
            <ul v-if="frameCharacterContext?.warnings.length" class="check-messages warnings">
              <li v-for="message in frameCharacterContext.warnings" :key="message">{{ message }}</li>
            </ul>
          </section>

          <div class="field-row">
            <label class="field">
              <span>负向提示词</span>
              <input v-model="negativePrompt" type="text" class="field-input" placeholder="可选" />
            </label>
            <label class="field">
              <span>模型名</span>
              <input v-model="modelName" type="text" class="field-input" />
            </label>
          </div>

          <div class="token-line">
            <span>提示词长度</span>
            <strong>{{ promptTokens }}</strong>
          </div>

          <button class="primary-btn wide" type="button" :disabled="generating || rewritingPrompt || !canGenerate" @click="onGenerate">
            {{ generating ? `后台生成中 ${generationProgress}%` : `开始生成 1 张${frameRoleLabel(selectedFrameRole)}` }}
          </button>

          <p class="helper-text">
            生成完成后进入结果页查看候选画面，确认的版本会同步回写到当前分镜；人物画面会强制使用角色定妆图和固定外貌设定。
          </p>
        </section>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.frame-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(217, 119, 6, 0.14), transparent 26%),
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
  line-height: 1.7;
}

.top-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
  gap: 20px;
}

.preview-shell,
.control-panel {
  border: 1px solid #8d6f4a;
  background: rgba(20, 21, 19, 0.94);
  padding: 18px;
}

.preview-stage {
  min-height: 420px;
  border: 1px solid #5a4938;
  background: #090909;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-empty {
  max-width: 320px;
  text-align: center;
  color: #b79f84;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.shot-meta {
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
  font-size: 16px;
  font-weight: 700;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.panel-head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.panel-tag {
  border: 1px solid #5a4938;
  background: #171816;
  color: #c9ab83;
  font-size: 11px;
  padding: 4px 8px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
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

.field small {
  display: block;
  margin: -2px 0 8px;
  color: #a9957e;
  font-size: 12px;
  line-height: 1.5;
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
  min-height: 180px;
}

.field-textarea:focus,
.field-input:focus {
  border-color: #f0b56f;
}

.frame-role-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}

.role-tab {
  min-height: 68px;
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
  line-height: 1.4;
}

.role-tab.active {
  border-color: #f0b56f;
  background: rgba(217, 119, 6, 0.14);
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.prompt-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #5a4938;
  background: rgba(15, 16, 15, 0.72);
  padding: 10px 12px;
  margin: -4px 0 14px;
}

.prompt-tools .ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.prompt-tools .material-symbols-outlined {
  font-size: 18px;
}

.prompt-tools p {
  margin: 0;
  color: #b79f84;
  font-size: 12px;
  line-height: 1.5;
}

.character-check {
  border: 1px solid #5a4938;
  background: #111210;
  padding: 14px;
  margin-bottom: 14px;
}

.character-check.ready {
  border-color: rgba(74, 222, 128, 0.45);
}

.character-check.blocked {
  border-color: rgba(248, 113, 113, 0.5);
}

.character-check-head,
.character-name-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.character-check-head strong,
.character-check-label {
  display: block;
}

.character-check-label {
  color: #c9ab83;
  font-size: 10px;
  letter-spacing: 0.12em;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.character-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.character-item {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 12px;
  border-top: 1px solid #3f352b;
  padding-top: 10px;
}

.character-reference {
  width: 68px;
  height: 84px;
  object-fit: cover;
  border: 1px solid #5a4938;
  background: #090909;
}

.character-reference.missing {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8d7a64;
}

.character-copy {
  min-width: 0;
}

.character-name-line span {
  border: 1px solid rgba(240, 181, 111, 0.45);
  color: #f0b56f;
  font-size: 10px;
  padding: 2px 6px;
}

.character-copy p {
  color: #c7b39a;
  font-size: 12px;
  margin: 5px 0 0;
}

.character-copy .character-appearance {
  color: #e6d7c5;
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.character-copy small {
  color: #8fbf9a;
  display: block;
  margin-top: 6px;
}

.character-empty,
.check-messages {
  color: #c7b39a;
  font-size: 12px;
  line-height: 1.6;
  margin: 12px 0 0;
}

.check-messages {
  padding-left: 18px;
}

.check-messages.blockers {
  color: #fecaca;
}

.check-messages.warnings {
  color: #fde68a;
}

.token-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border: 1px solid #5a4938;
  background: #161715;
  padding: 10px 12px;
  margin-bottom: 14px;
  color: #b79f84;
  font-size: 13px;
}

.wide {
  width: 100%;
}

.helper-text {
  margin-top: 12px;
  color: #b79f84;
  font-size: 13px;
  line-height: 1.7;
}

.primary-btn,
.ghost-btn {
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

.ghost-btn:hover {
  border-color: #f0b56f;
  color: #f0b56f;
}

.primary-btn:disabled,
.ghost-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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
  .frame-page {
    padding: 16px;
  }

  .page-top {
    flex-direction: column;
    align-items: flex-start;
  }

  .main-grid,
  .field-row,
  .frame-role-tabs,
  .shot-meta {
    grid-template-columns: 1fr;
  }

  .prompt-tools {
    align-items: flex-start;
    flex-direction: column;
  }

  .preview-stage {
    min-height: 260px;
  }
}
</style>
