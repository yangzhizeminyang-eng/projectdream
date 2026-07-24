<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkspaceLayout from '@/components/WorkspaceLayout.vue'
import {
  createProjectExport,
  getProjectExportPackage,
  listProjectExports,
  type ExportPackageDTO,
  type ExportPackageItemDTO,
  type ExportRecordDTO,
} from '@/api/project'
import { getWorkspaceContext, setWorkspaceContext } from '@/lib/context'

type PageState = 'missing-project' | 'loading' | 'empty' | 'ready' | 'exporting' | 'error'
type ExportFormat = 'H.264 / MP4' | 'HEVC (H.265)' | 'ProRes 422 HQ'
type Resolution = '1920 x 1080 (FHD)' | '3840 x 2160 (4K UHD)' | '4096 x 1716 (DCI 4K Scope)'

const route = useRoute()
const router = useRouter()

const formats: ExportFormat[] = ['H.264 / MP4', 'HEVC (H.265)', 'ProRes 422 HQ']
const resolutions: Resolution[] = [
  '1920 x 1080 (FHD)',
  '3840 x 2160 (4K UHD)',
  '4096 x 1716 (DCI 4K Scope)',
]

const selectedFormat = ref<ExportFormat>('H.264 / MP4')
const selectedResolution = ref<Resolution>('1920 x 1080 (FHD)')
const frameRate = ref(24)
const burnSubtitle = ref(true)

const pageState = ref<PageState>('loading')
const exportPackage = ref<ExportPackageDTO | null>(null)
const exportHistory = ref<ExportRecordDTO[]>([])
const historyErrorMsg = ref('')
const errorMsg = ref('')
const infoMsg = ref('')
let exportPollTimer: number | null = null

const projectId = computed(() => {
  const fromQuery = Number(route.query.projectId) || 0
  if (fromQuery > 0) return fromQuery
  return getWorkspaceContext()?.projectId || 0
})

const latestExport = computed<ExportRecordDTO | null>(() => exportHistory.value[0] || null)
const readyItems = computed(() =>
  exportPackage.value?.items.filter((item) => item.exportStatus === 'ready') || [],
)
const missingItems = computed(() =>
  exportPackage.value?.items.filter((item) => item.exportStatus !== 'ready') || [],
)
const canExport = computed(() => exportPackage.value?.canExport === true)
const exportButtonText = computed(() => {
  if (pageState.value === 'exporting') return '导出生成中...'
  return '开始生成导出包'
})
const exportHint = computed(() => {
  if (pageState.value === 'exporting') return '正在写入 mock 导出记录，请稍候'
  if ((exportPackage.value?.missingStoryboardScenes || 0) > 0) {
    return `还有 ${exportPackage.value?.missingStoryboardScenes || 0} 个场景未生成分镜`
  }
  if ((exportPackage.value?.missingShots || 0) > 0) {
    return `还有 ${exportPackage.value?.missingShots || 0} 个分镜未确认最终视频`
  }
  return `已就绪 ${exportPackage.value?.readyShots || 0} / ${exportPackage.value?.totalShots || 0} 个分镜`
})

function formatDuration(seconds?: number | null): string {
  const total = Number(seconds) || 0
  if (total <= 0) return '0s'
  const mins = Math.floor(total / 60)
  const rest = total % 60
  if (mins <= 0) return `${rest}s`
  if (rest === 0) return `${mins}m`
  return `${mins}m ${rest}s`
}

function resolveShotLabel(item: ExportPackageItemDTO): string {
  return item.shotNo || `SHOT ${item.storyboardId}`
}

function goDashboard(): void {
  router.push('/dashboard')
}

function goWorkspace(): void {
  if (!projectId.value) {
    router.push('/dashboard')
    return
  }
  router.push({
    path: '/workspace/scenes',
    query: { projectId: String(projectId.value) },
  })
}

async function loadPage(): Promise<void> {
  if (!projectId.value) {
    pageState.value = 'missing-project'
    return
  }

  pageState.value = 'loading'
  errorMsg.value = ''
  infoMsg.value = ''
  historyErrorMsg.value = ''

  try {
    setWorkspaceContext({ projectId: projectId.value })
    const pkg = await getProjectExportPackage(projectId.value)
    exportPackage.value = pkg
    pageState.value = pkg.totalShots > 0 && pkg.readyShots > 0 ? 'ready' : 'empty'
    try {
      exportHistory.value = await listProjectExports(projectId.value)
    } catch (error) {
      exportHistory.value = []
      historyErrorMsg.value = error instanceof Error ? error.message : '导出历史加载失败'
    }
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '导出模块加载失败'
    pageState.value = 'error'
  }
}

async function refreshHistory(): Promise<void> {
  if (!projectId.value) return
    try {
      exportHistory.value = await listProjectExports(projectId.value)
      historyErrorMsg.value = ''
      if (['queued', 'running'].includes(exportHistory.value[0]?.status || '')) {
        startExportPolling()
      }
  } catch (error) {
    historyErrorMsg.value = error instanceof Error ? error.message : '导出历史加载失败'
  }
}

function stopExportPolling(): void {
  if (exportPollTimer !== null) {
    window.clearInterval(exportPollTimer)
    exportPollTimer = null
  }
}

function startExportPolling(): void {
  stopExportPolling()
  exportPollTimer = window.setInterval(async () => {
    await refreshHistory()
    const status = latestExport.value?.status
    if (status === 'completed' || status === 'failed') {
      stopExportPolling()
      pageState.value = 'ready'
      infoMsg.value = status === 'completed' ? '混合成片已完成，可直接播放或下载。' : '混合成片失败，请重试。'
    }
  }, 2000)
}

async function handleExport(): Promise<void> {
  if (!projectId.value || !canExport.value || pageState.value === 'exporting') return

  pageState.value = 'exporting'
  errorMsg.value = ''
  infoMsg.value = ''

  try {
    const record = await createProjectExport(projectId.value, {
      format: selectedFormat.value,
      resolution: selectedResolution.value,
      frameRate: frameRate.value,
      burnSubtitle: burnSubtitle.value,
    })
    exportHistory.value = [record, ...exportHistory.value.filter((item) => item.id !== record.id)]
    await refreshHistory()
    infoMsg.value = `导出已生成，记录 #${record.id} 已写入历史`
    pageState.value = 'ready'
    startExportPolling()
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : '导出失败'
    pageState.value =
      exportPackage.value && exportPackage.value.totalShots > 0 && exportPackage.value.readyShots > 0
        ? 'ready'
        : 'empty'
  }
}

function statusClass(status: ExportPackageItemDTO['exportStatus']): string {
  return status === 'missing-video' ? 'status-chip missing' : 'status-chip ready'
}

function exportRecordStatusClass(status: string): string {
  if (status === 'completed') return 'ready'
  if (status === 'failed') return 'missing'
  return 'pending'
}

function statusLabel(status: ExportPackageItemDTO['exportStatus']): string {
  return status === 'ready' ? '已就绪' : '缺少最终视频'
}

watch(
  () => route.query.projectId,
  () => {
    void loadPage()
  },
)

onMounted(() => {
  void loadPage()
})

onBeforeUnmount(() => {
  stopExportPolling()
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
        <p class="state-desc">导出模块是项目级页面，请从具体项目工作区进入。</p>
        <button class="primary-btn" type="button" @click="goDashboard">返回项目页</button>
      </div>
    </section>

    <div
      v-else-if="pageState === 'loading'"
      class="flex h-full items-center justify-center bg-[#111210] text-sm text-[#c7b39a]"
    >
      正在加载导出模块...
    </div>

    <section
      v-else-if="pageState === 'error'"
      class="flex h-full items-center justify-center bg-[#111210] p-8"
    >
      <div class="state-card border-red-500/40">
        <h2 class="state-title text-red-300">导出模块加载失败</h2>
        <p class="state-desc">{{ errorMsg || '请稍后重试。' }}</p>
        <div class="flex flex-wrap gap-3">
          <button class="ghost-btn" type="button" @click="loadPage">重新加载</button>
          <button class="primary-btn" type="button" @click="goWorkspace">返回工作区</button>
        </div>
      </div>
    </section>

    <div v-else class="export-page">
      <div class="page-top">
        <div>
          <p class="eyebrow">PROJECT {{ projectId }}</p>
          <h1 class="page-title">合成与导出</h1>
          <p class="page-subtitle">
            扫描当前项目下所有分镜，识别哪些分镜已经确认最终视频，并生成一期 mock 导出记录。
          </p>
        </div>
        <div class="top-actions">
          <button class="ghost-btn" type="button" @click="goWorkspace">返回工作区</button>
          <button class="ghost-btn" type="button" @click="loadPage">刷新清单</button>
        </div>
      </div>

      <div v-if="errorMsg" class="message error">{{ errorMsg }}</div>
      <div v-if="infoMsg" class="message success">{{ infoMsg }}</div>
      <div v-if="exportPackage && !exportPackage.canExport" class="message error">
        {{ exportPackage.blockingIssues[0]?.message || '当前项目素材尚未补齐，暂时不能导出。' }}
      </div>

      <div class="summary-grid">
        <section class="summary-card highlight">
          <span class="summary-label">导出覆盖分镜</span>
          <strong class="summary-value">{{ exportPackage?.readyShots || 0 }} / {{ exportPackage?.totalShots || 0 }}</strong>
          <p class="summary-help">只有已确认最终视频的分镜会进入本次导出。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">缺失分镜</span>
          <strong class="summary-value">{{ exportPackage?.missingShots || 0 }}</strong>
          <p class="summary-help">所有分镜都确认最终视频后才能导出。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">预计时长</span>
          <strong class="summary-value">{{ formatDuration(exportPackage?.totalDurationSeconds) }}</strong>
          <p class="summary-help">按当前已就绪分镜的时长合计估算。</p>
        </section>
        <section class="summary-card">
          <span class="summary-label">未拆分镜场景</span>
          <strong class="summary-value">{{ exportPackage?.missingStoryboardScenes || 0 }}</strong>
          <p class="summary-help">场景需先完成拆镜，才能进入完整导出清单。</p>
        </section>
      </div>

      <section v-if="exportPackage?.incompleteScenes.length" class="panel scene-gap-panel">
        <div class="panel-head">
          <div>
            <h2>尚未拆分镜的场景</h2>
            <p class="panel-sub">这些场景不完整，当前导出已被阻止。</p>
          </div>
          <span class="panel-tag">{{ exportPackage.incompleteScenes.length }} 个</span>
        </div>
        <div class="scene-gap-list">
          <span v-for="scene in exportPackage.incompleteScenes" :key="scene.sceneId" class="scene-gap-item">
            Scene {{ scene.sceneNo }} · {{ scene.sceneTitle || '未命名场景' }}
          </span>
        </div>
      </section>

      <div class="main-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>导出参数</h2>
              <p class="panel-sub">一期继续走 mock 链路，不接真实渲染引擎。</p>
            </div>
            <span class="panel-tag">Mock v1</span>
          </div>

          <div class="field-grid">
            <label class="field">
              <span>导出格式</span>
              <select v-model="selectedFormat" class="field-input">
                <option v-for="fmt in formats" :key="fmt" :value="fmt">{{ fmt }}</option>
              </select>
            </label>

            <label class="field">
              <span>分辨率</span>
              <select v-model="selectedResolution" class="field-input">
                <option v-for="resolution in resolutions" :key="resolution" :value="resolution">
                  {{ resolution }}
                </option>
              </select>
            </label>

            <label class="field">
              <span>帧率</span>
              <input v-model.number="frameRate" min="1" type="number" class="field-input" />
            </label>

            <label class="field field-toggle">
              <span>字幕烧录</span>
              <button
                class="toggle-btn"
                :class="{ active: burnSubtitle }"
                type="button"
                @click="burnSubtitle = !burnSubtitle"
              >
                <span class="toggle-dot"></span>
              </button>
            </label>
          </div>

          <div class="export-action">
            <div>
              <strong class="export-action-title">{{ exportButtonText }}</strong>
              <p class="export-action-sub">{{ exportHint }}</p>
            </div>
            <button class="primary-btn wide" type="button" :disabled="!canExport || pageState === 'exporting'" @click="handleExport">
              {{ exportButtonText }}
            </button>
          </div>

          <div v-if="pageState === 'empty'" class="empty-box">
            <h3>当前项目还没有可导出的最终视频</h3>
            <p>
              你可以先回到场景 / 分镜工作区，继续补完静帧和最终视频，再回来发起导出。
            </p>
            <button class="ghost-btn" type="button" @click="goWorkspace">回到工作区继续处理</button>
          </div>

          <div v-if="latestExport" class="latest-export">
            <div class="latest-export-head">
              <h3>最近一次导出</h3>
              <span class="status-chip" :class="exportRecordStatusClass(latestExport.status)">{{ latestExport.status }}</span>
            </div>
            <video
              v-if="latestExport.status === 'completed'"
              :src="latestExport.videoUrl"
              controls
              playsinline
              class="latest-video"
            ></video>
            <p v-else class="history-sub">后台任务状态：{{ latestExport.status }}，完成后会自动出现播放器。</p>
            <div class="latest-meta">
              <span>记录 #{{ latestExport.id }}</span>
              <span>{{ formatDuration(latestExport.durationSeconds) }}</span>
              <span>{{ latestExport.config?.resolution || '-' }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>导出历史</h2>
              <p class="panel-sub">每次 mock 导出都会落一条记录，方便后续替换成真实导出链路。</p>
            </div>
            <span class="panel-tag">{{ exportHistory.length }} 条</span>
          </div>

          <div v-if="historyErrorMsg" class="message error">
            导出清单可正常使用，但历史记录暂时加载失败：{{ historyErrorMsg }}
          </div>

          <div v-if="exportHistory.length === 0" class="history-empty">还没有导出记录。</div>

          <div v-else class="history-list">
            <article v-for="record in exportHistory" :key="record.id" class="history-item">
              <div class="history-main">
                <div class="history-title">
                  <strong>导出 #{{ record.id }}</strong>
                  <span class="status-chip" :class="exportRecordStatusClass(record.status)">{{ record.status }}</span>
                </div>
                <p class="history-sub">
                  {{ record.config?.format || '-' }} · {{ record.config?.resolution || '-' }} ·
                  {{ formatDuration(record.durationSeconds) }}
                </p>
                <p class="history-sub">
                  覆盖 {{ record.readyCount }} / {{ record.sourceCount }} 个分镜
                </p>
              </div>
              <a v-if="record.status === 'completed'" class="history-link" :href="record.videoUrl" target="_blank" rel="noreferrer">
                查看文件
              </a>
              <span v-if="record.status !== 'completed'" class="history-link muted">后台处理中</span>
            </article>
          </div>
        </section>
      </div>

      <div class="list-grid">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>已就绪分镜</h2>
              <p class="panel-sub">这些分镜已经确认最终视频，会进入本次导出包。</p>
            </div>
            <span class="panel-tag">{{ readyItems.length }} 条</span>
          </div>

          <div v-if="readyItems.length === 0" class="shot-empty">还没有可导出的分镜。</div>

          <div v-else class="shot-list">
            <article v-for="item in readyItems" :key="item.storyboardId" class="shot-item">
              <img v-if="item.imageUrl" :src="item.imageUrl" alt="shot cover" class="shot-cover" />
              <div v-else class="shot-cover placeholder">NO COVER</div>
              <div class="shot-main">
                <div class="shot-title-row">
                  <strong>场景 {{ item.sceneNo }} · {{ resolveShotLabel(item) }}</strong>
                  <span :class="statusClass(item.exportStatus)">{{ item.exportStatus === 'static-ready' ? '可用静帧' : statusLabel(item.exportStatus) }}</span>
                </div>
                <p class="shot-sub">{{ item.sceneTitle || '未命名场景' }}</p>
                <p class="shot-sub">{{ item.shotType || '未填写景别' }} · {{ formatDuration(item.durationSeconds) }}</p>
              </div>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>待补完分镜</h2>
              <p class="panel-sub">这些分镜还没有确认最终视频，暂时不会进入导出包。</p>
            </div>
            <span class="panel-tag">{{ missingItems.length }} 条</span>
          </div>

          <div v-if="missingItems.length === 0" class="shot-empty">当前没有缺失项。</div>

          <div v-else class="shot-list">
            <article v-for="item in missingItems" :key="item.storyboardId" class="shot-item">
              <img v-if="item.imageUrl" :src="item.imageUrl" alt="shot cover" class="shot-cover" />
              <div v-else class="shot-cover placeholder">PENDING</div>
              <div class="shot-main">
                <div class="shot-title-row">
                  <strong>场景 {{ item.sceneNo }} · {{ resolveShotLabel(item) }}</strong>
                  <span :class="statusClass(item.exportStatus)">{{ statusLabel(item.exportStatus) }}</span>
                </div>
                <p class="shot-sub">{{ item.sceneTitle || '未命名场景' }}</p>
                <p class="shot-sub">{{ item.shotType || '未填写景别' }} · {{ formatDuration(item.durationSeconds) }}</p>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </WorkspaceLayout>
</template>

<style scoped>
.export-page {
  min-height: 100vh;
  background:
    radial-gradient(circle at top right, rgba(217, 119, 6, 0.16), transparent 24%),
    linear-gradient(180deg, #111210 0%, #090909 100%);
  color: #f4ede5;
  padding: 24px;
}

.page-top,
.summary-grid,
.main-grid,
.list-grid,
.field-grid,
.shot-title-row,
.history-title,
.latest-meta,
.top-actions {
  display: flex;
}

.page-top,
.shot-title-row,
.history-title,
.latest-meta,
.top-actions {
  align-items: center;
}

.page-top {
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

.page-subtitle,
.panel-sub,
.summary-help,
.shot-sub,
.history-sub,
.export-action-sub,
.state-desc,
.history-empty,
.shot-empty {
  color: #c7b39a;
}

.page-subtitle {
  margin-top: 8px;
  font-size: 14px;
  line-height: 1.7;
  max-width: 760px;
}

.top-actions {
  gap: 12px;
  flex-wrap: wrap;
}

.summary-grid {
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.scene-gap-panel {
  margin-bottom: 20px;
}

.scene-gap-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.scene-gap-item {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 7px 11px;
  border: 1px solid rgba(248, 113, 113, 0.24);
  border-radius: 8px;
  background: rgba(127, 29, 29, 0.16);
  color: #fecaca;
  font-size: 13px;
}

.summary-card,
.panel,
.state-card,
.message,
.empty-box {
  border: 1px solid rgba(201, 163, 113, 0.18);
  background: rgba(17, 18, 16, 0.84);
  backdrop-filter: blur(10px);
}

.summary-card {
  flex: 1 1 220px;
  padding: 18px;
  border-radius: 18px;
}

.summary-card.highlight {
  border-color: rgba(240, 181, 111, 0.45);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
}

.summary-label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #f0b56f;
  margin-bottom: 12px;
}

.summary-value {
  display: block;
  font-size: 28px;
  margin-bottom: 8px;
}

.summary-help {
  margin: 0;
  line-height: 1.6;
  font-size: 13px;
}

.main-grid,
.list-grid {
  gap: 20px;
}

.main-grid {
  margin-bottom: 20px;
  align-items: start;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
}

.list-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel {
  border-radius: 22px;
  padding: 20px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 18px;
}

.panel-head h2,
.latest-export-head h3,
.empty-box h3,
.state-title {
  margin: 0;
}

.panel-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.panel-tag,
.status-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.panel-tag {
  background: rgba(240, 181, 111, 0.12);
  color: #f0b56f;
  border: 1px solid rgba(240, 181, 111, 0.24);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field span {
  font-size: 12px;
  color: #cfb390;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.field-input {
  min-height: 46px;
  border-radius: 14px;
  border: 1px solid rgba(201, 163, 113, 0.22);
  background: rgba(9, 10, 8, 0.78);
  color: #f4ede5;
  padding: 0 14px;
  outline: none;
}

.field-input:focus {
  border-color: rgba(240, 181, 111, 0.8);
  box-shadow: 0 0 0 2px rgba(240, 181, 111, 0.12);
}

.field-toggle {
  justify-content: flex-end;
}

.toggle-btn {
  width: 58px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid rgba(201, 163, 113, 0.2);
  background: rgba(78, 59, 37, 0.35);
  position: relative;
  transition: all 0.2s ease;
}

.toggle-btn.active {
  background: rgba(240, 181, 111, 0.22);
  border-color: rgba(240, 181, 111, 0.45);
}

.toggle-dot {
  position: absolute;
  top: 4px;
  left: 5px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #f4ede5;
  transition: transform 0.2s ease;
}

.toggle-btn.active .toggle-dot {
  transform: translateX(24px);
}

.export-action,
.latest-export,
.empty-box,
.state-card {
  display: flex;
  flex-direction: column;
}

.export-action {
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  background: linear-gradient(135deg, rgba(240, 181, 111, 0.1), rgba(17, 18, 16, 0.4));
  border: 1px solid rgba(240, 181, 111, 0.2);
}

.export-action-title {
  display: block;
  font-size: 18px;
  margin-bottom: 6px;
}

.export-action-sub {
  margin: 0;
  font-size: 13px;
}

.wide {
  width: 100%;
}

.latest-export {
  margin-top: 18px;
  gap: 12px;
}

.latest-export-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.latest-video {
  width: 100%;
  border-radius: 18px;
  border: 1px solid rgba(201, 163, 113, 0.18);
  background: #080808;
}

.latest-meta {
  gap: 10px;
  flex-wrap: wrap;
  color: #cfb390;
  font-size: 12px;
}

.history-list,
.shot-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-item,
.shot-item {
  display: flex;
  gap: 14px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid rgba(201, 163, 113, 0.16);
  background: rgba(10, 10, 10, 0.62);
}

.history-item {
  justify-content: space-between;
  align-items: center;
}

.history-main {
  min-width: 0;
}

.history-sub {
  margin: 6px 0 0;
  font-size: 12px;
}

.history-link {
  color: #f0b56f;
  text-decoration: none;
  white-space: nowrap;
}

.shot-cover {
  width: 112px;
  height: 72px;
  border-radius: 12px;
  object-fit: cover;
  background: #090909;
  border: 1px solid rgba(201, 163, 113, 0.16);
}

.shot-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8d7558;
  font-size: 11px;
  letter-spacing: 0.18em;
}

.shot-main {
  min-width: 0;
  flex: 1;
}

.shot-title-row,
.history-title {
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.shot-sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.status-chip.ready {
  background: rgba(87, 205, 145, 0.12);
  color: #8fe3b0;
  border: 1px solid rgba(87, 205, 145, 0.24);
}

.status-chip.missing {
  background: rgba(255, 154, 139, 0.12);
  color: #ffb0a3;
  border: 1px solid rgba(255, 154, 139, 0.24);
}

.status-chip.pending {
  background: rgba(240, 181, 111, 0.12);
  color: #f0b56f;
  border: 1px solid rgba(240, 181, 111, 0.24);
}

.history-link.muted {
  color: #8d8174;
}

.message,
.empty-box,
.state-card,
.history-empty,
.shot-empty {
  border-radius: 18px;
}

.message {
  padding: 12px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.message.success {
  color: #8fe3b0;
  border-color: rgba(87, 205, 145, 0.24);
}

.message.error {
  color: #ffb0a3;
  border-color: rgba(255, 154, 139, 0.24);
}

.empty-box,
.state-card {
  gap: 12px;
  padding: 20px;
}

.history-empty,
.shot-empty {
  padding: 18px;
  border: 1px dashed rgba(201, 163, 113, 0.2);
  background: rgba(10, 10, 10, 0.45);
}

.primary-btn,
.ghost-btn {
  min-height: 44px;
  border-radius: 14px;
  padding: 0 18px;
  font-weight: 700;
  transition: all 0.2s ease;
}

.primary-btn {
  border: 1px solid rgba(240, 181, 111, 0.52);
  background: linear-gradient(135deg, #f0b56f, #d97706);
  color: #1d1206;
  box-shadow: 0 16px 36px rgba(217, 119, 6, 0.24);
}

.primary-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
  box-shadow: none;
}

.ghost-btn {
  border: 1px solid rgba(201, 163, 113, 0.24);
  background: rgba(9, 10, 8, 0.5);
  color: #f4ede5;
}

@media (max-width: 1100px) {
  .main-grid,
  .list-grid,
  .field-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .export-page {
    padding: 16px;
  }

  .page-top {
    flex-direction: column;
  }

  .history-item,
  .shot-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .shot-cover {
    width: 100%;
    height: 180px;
  }
}
</style>
