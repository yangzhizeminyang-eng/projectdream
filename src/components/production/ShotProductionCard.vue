<script setup lang="ts">
/** 单镜头生产卡：完整展示一个镜头的连续帧、主动作、实体、声音与候选。 */
import { computed, ref } from 'vue'
import type {
  CandidateSummary,
  ShotActionRoute,
  ShotProductionDetail,
  ShotSummary,
} from '@/api/production-studio'

type CandidateKind = 'video' | 'audio'

const props = defineProps<{
  detail: ShotProductionDetail
  shot: ShotSummary
  prevShotLabel?: string | null
  pendingCandidateKey?: string | null
  candidateFeedback?: {
    assetKey: string
    tone: 'success' | 'warning' | 'error'
    message: string
  } | null
}>()

const emit = defineEmits<{
  (e: 'action', route: ShotActionRoute): void
  (e: 'candidate-focus', assetKey: string): void
  (e: 'confirm-candidate', payload: { kind: CandidateKind; candidate: CandidateSummary }): void
  (e: 'archive-candidates', payload: { kind: CandidateKind; candidates: CandidateSummary[] }): void
}>()

const selectedKind = ref<CandidateKind | null>(null)
const selectedCandidateId = ref<number | null>(null)
const previewSide = ref<'candidate' | 'current'>('candidate')
const reviewQueue = ref<Set<string>>(new Set())

const selectedCandidate = computed(() => {
  if (selectedKind.value === 'video') {
    return props.detail.videoCandidates.find((item) => item.id === selectedCandidateId.value) ?? null
  }
  if (selectedKind.value === 'audio') {
    return props.detail.audioCandidates.find((item) => item.id === selectedCandidateId.value) ?? null
  }
  return null
})

const currentCandidate = computed(() => {
  if (selectedKind.value === 'video') return props.detail.currentVideo ?? null
  if (selectedKind.value === 'audio') return props.detail.currentAudio ?? null
  return null
})

const previewCandidate = computed(() =>
  previewSide.value === 'current' && currentCandidate.value
    ? currentCandidate.value
    : selectedCandidate.value,
)

const selectedAssetKey = computed(() =>
  selectedKind.value && selectedCandidateId.value
    ? `${selectedKind.value}:${selectedCandidateId.value}`
    : null,
)

const activeFeedback = computed(() =>
  props.candidateFeedback?.assetKey === selectedAssetKey.value || props.candidateFeedback?.assetKey === 'batch'
    ? props.candidateFeedback
    : null,
)

const queuedCandidates = computed(() => {
  const candidates: Array<{ kind: CandidateKind; candidate: CandidateSummary }> = []
  for (const kind of ['video', 'audio'] as const) {
    const source = kind === 'video' ? props.detail.videoCandidates : props.detail.audioCandidates
    for (const candidate of source) {
      if (reviewQueue.value.has(candidateKey(kind, candidate))) candidates.push({ kind, candidate })
    }
  }
  return candidates
})

const canCompareCurrent = computed(
  () => !!currentCandidate.value && currentCandidate.value.id !== selectedCandidate.value?.id,
)

function fmt(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.round(sec)
  return `${s}s`
}

function cueUrl(u: string | null | undefined): string {
  return u || ''
}

function statusLabel(status: string): string {
  if (status === 'done') return '已完成'
  if (status === 'current') return '现在处理'
  if (status === 'blocked') return '被阻塞'
  if (status === 'waiting') return '待后续'
  return '未开始'
}

function routeLabel(route: ShotActionRoute): string {
  if (route === 'frame') return '静帧'
  if (route === 'video') return '视频'
  if (route === 'audio') return '声音'
  if (route === 'edit') return '剪辑'
  if (route === 'storyboard') return '分镜'
  return '当前工作台'
}

function candidateKey(kind: CandidateKind, candidate: CandidateSummary): string {
  return `${kind}:${candidate.id}`
}

function selectCandidate(kind: CandidateKind, candidate: CandidateSummary): void {
  selectedKind.value = kind
  selectedCandidateId.value = candidate.id
  previewSide.value = 'candidate'
  emit('candidate-focus', candidateKey(kind, candidate))
}

function handleCandidateKeydown(event: KeyboardEvent, kind: CandidateKind, candidate: CandidateSummary): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectCandidate(kind, candidate)
}

function candidateStatusLabel(status: string): string {
  if (status === 'confirmed') return '主版本'
  if (status === 'candidate') return '待复核'
  if (status === 'archived') return '历史版本'
  if (status === 'failed') return '生成失败'
  return status || '状态未知'
}

function isPending(kind: CandidateKind, candidate: CandidateSummary): boolean {
  return props.pendingCandidateKey === candidateKey(kind, candidate) || props.pendingCandidateKey === 'batch'
}

function isQueued(kind: CandidateKind, candidate: CandidateSummary): boolean {
  return reviewQueue.value.has(candidateKey(kind, candidate))
}

function toggleQueue(kind: CandidateKind, candidate: CandidateSummary): void {
  if (candidate.confirmed || candidate.status === 'archived' || isPending(kind, candidate)) return
  const next = new Set(reviewQueue.value)
  const key = candidateKey(kind, candidate)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  reviewQueue.value = next
}

function selectAllPending(): void {
  const next = new Set<string>()
  for (const kind of ['video', 'audio'] as const) {
    const source = kind === 'video' ? props.detail.videoCandidates : props.detail.audioCandidates
    for (const candidate of source) {
      if (!candidate.confirmed && candidate.status === 'candidate') next.add(candidateKey(kind, candidate))
    }
  }
  reviewQueue.value = next
}

function clearQueue(): void {
  reviewQueue.value = new Set()
}

function archiveQueued(kind: CandidateKind): void {
  const candidates = queuedCandidates.value
    .filter((item) => item.kind === kind)
    .map((item) => item.candidate)
  if (candidates.length > 0) {
    emit('archive-candidates', { kind, candidates })
  }
}

function confirmSelectedCandidate(): void {
  if (!selectedKind.value || !selectedCandidate.value || selectedCandidate.value.confirmed) return
  emit('confirm-candidate', {
    kind: selectedKind.value,
    candidate: selectedCandidate.value,
  })
}
</script>

<template>
  <section class="prod-card" aria-label="单镜头生产卡">
    <div class="card-titlebar">
      <div>
        <div class="text-[10px] font-bold uppercase tracking-[0.18em] text-secondary">单镜头生产卡</div>
        <h2 class="text-primary font-display-lg text-base">
          Scene {{ String(shot.sceneNo).padStart(2, '0') }} / {{ String(shot.shotNo).padStart(2, '0') }}
        </h2>
      </div>
      <div class="divider-note">
        本镜头只完成一件事
        <strong class="block text-primary">{{ detail.continuity.primaryAction || '主动作待接入' }}</strong>
      </div>
    </div>

    <section class="workflow-guide" aria-labelledby="shot-workflow-title">
      <div class="workflow-guide-head">
        <div>
          <div class="workflow-kicker">这个镜头怎么做</div>
          <h3 id="shot-workflow-title">{{ detail.nextAction.label }}</h3>
          <p>{{ detail.nextAction.description }}</p>
        </div>
        <button
          v-if="detail.nextAction.ready && detail.nextAction.route !== 'none'"
          type="button"
          class="workflow-primary"
          :aria-label="`${detail.nextAction.label}，进入${routeLabel(detail.nextAction.route)}模块`"
          @click="emit('action', detail.nextAction.route)"
        >
          <span class="material-symbols-outlined text-base">arrow_forward</span>
          {{ detail.nextAction.label }}
        </button>
      </div>

      <ol class="workflow-steps" aria-label="镜头生产步骤">
        <li
          v-for="(step, index) in detail.workflowSteps"
          :key="step.key"
          class="workflow-step"
          :class="`workflow-step--${step.status}`"
        >
          <button
            v-if="step.route !== 'none' && step.status !== 'done'"
            type="button"
            class="workflow-step-button"
            :aria-label="`${step.label}：${statusLabel(step.status)}`"
            @click="emit('action', step.route)"
          >
            <span class="workflow-step-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="workflow-step-copy">
              <strong>{{ step.label }}</strong>
              <small>{{ step.evidence }}</small>
            </span>
            <span class="workflow-step-status">{{ statusLabel(step.status) }}</span>
          </button>
          <div v-else class="workflow-step-button">
            <span class="workflow-step-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="workflow-step-copy">
              <strong>{{ step.label }}</strong>
              <small>{{ step.evidence }}</small>
            </span>
            <span class="workflow-step-status">{{ statusLabel(step.status) }}</span>
          </div>
        </li>
      </ol>
    </section>

    <section v-if="detail.blockingItems.length" class="blocker-summary" aria-labelledby="shot-blockers-title">
      <div class="blocker-summary-head">
        <h3 id="shot-blockers-title">完成前需要处理</h3>
        <span>{{ detail.blockingItems.length }} 项</span>
      </div>
      <ul>
        <li v-for="item in detail.blockingItems" :key="item.key" :class="`blocker--${item.severity}`">
          <span class="material-symbols-outlined text-base">{{ item.severity === 'blocking' ? 'error' : 'warning' }}</span>
          <span>
            <strong>{{ item.label }}</strong>
            <small>{{ item.detail }}</small>
          </span>
          <button
            type="button"
            :aria-label="`处理：${item.label}`"
            @click="emit('action', item.route)"
          >
            处理 {{ routeLabel(item.route) }}
          </button>
        </li>
      </ul>
    </section>

    <!-- 连续帧 -->
    <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
      <figure class="frame-box">
        <figcaption>上一镜结束帧{{ prevShotLabel ? ` · ${prevShotLabel}` : '' }}</figcaption>
        <img v-if="cueUrl(detail.continuity.prevEndFrame)" :src="cueUrl(detail.continuity.prevEndFrame)" alt="上一镜结束帧" loading="lazy" />
        <span v-else class="frame-empty">{{ detail.continuity.hasPrevEndFrame ? '有帧' : '未接入' }}</span>
      </figure>
      <figure class="frame-box">
        <figcaption>当前镜头开始帧</figcaption>
        <img v-if="cueUrl(detail.continuity.currentStartFrame)" :src="cueUrl(detail.continuity.currentStartFrame)" alt="当前镜头开始帧" loading="lazy" />
        <span v-else class="frame-empty">待生成 / 未接入</span>
      </figure>
      <figure class="frame-box">
        <figcaption>当前镜头结束帧</figcaption>
        <img v-if="cueUrl(detail.continuity.currentEndFrame)" :src="cueUrl(detail.continuity.currentEndFrame)" alt="当前镜头结束帧" loading="lazy" />
        <span v-else class="frame-empty">待生成 / 未接入</span>
      </figure>
    </div>

    <details class="detail-disclosure" open>
      <summary>动作与实体</summary>
      <!-- 动作与实体 -->
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
      <div class="field-block">
        <div class="field-label">本镜头唯一主动作 · 时长 {{ fmt(detail.durationSeconds) }}</div>
        <div class="field-value">{{ detail.continuity.primaryAction || '待接入' }}</div>
        <div v-if="detail.continuity.prevPrimaryAction" class="field-sub">
          上一镜动作：{{ detail.continuity.prevPrimaryAction }}
        </div>
        <div v-if="detail.continuity.suppliesNote" class="field-note">{{ detail.continuity.suppliesNote }}</div>
      </div>
      <div class="field-block">
        <div class="field-label">允许出现的实体</div>
        <div v-if="detail.continuity.allowedEntities.length" class="entity-tags">
          <span v-for="e in detail.continuity.allowedEntities" :key="e" class="entity-tag">{{ e }}</span>
        </div>
        <div v-else class="field-sub">未有结构化实体清单（待接入）</div>
        <div class="field-label field-label--sm">禁止出现的实体</div>
        <div class="field-sub">新物体需先预告再揭示；列表待接入连续性契约</div>
      </div>
      </div>
    </details>

    <details class="detail-disclosure">
      <summary>声音与情绪</summary>
      <!-- 声音 -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-5">
      <div class="field-block">
        <div class="field-label">对白</div>
        <div class="field-value field-value--sm">{{ detail.dialogueText || '—' }}</div>
      </div>
      <div class="field-block">
        <div class="field-label">角色声线</div>
        <div v-if="detail.voice.locked" class="field-value field-value--sm">{{ detail.voice.voiceName || '已锁定' }}</div>
        <div v-else class="field-sub">未锁定</div>
      </div>
      <div class="field-block">
        <div class="field-label">当前情绪</div>
        <div class="field-value field-value--sm">{{ detail.actingBeat || '待接入' }}</div>
      </div>
      <div class="field-block">
        <div class="field-label">环境声</div>
        <div class="field-sub">待接入</div>
      </div>
      <div class="field-block">
        <div class="field-label">SFX · BGM</div>
        <div class="field-sub">待接入</div>
      </div>
      </div>
    </details>

    <details class="detail-disclosure">
      <summary>候选版本</summary>
      <div class="review-toolbar" aria-label="批量候选筛选工具">
        <div class="review-toolbar-copy">
          <span class="material-symbols-outlined" aria-hidden="true">playlist_add_check</span>
          <div>
            <strong>候选复核台</strong>
            <small>{{ queuedCandidates.length ? `已选 ${queuedCandidates.length} 个候选` : '先选中需要处理的候选' }}</small>
          </div>
        </div>
        <div class="review-toolbar-actions">
          <button type="button" class="review-tool-button" @click="selectAllPending">
            全选待复核
          </button>
          <button
            type="button"
            class="review-tool-button"
            :disabled="queuedCandidates.length === 0"
            @click="clearQueue"
          >
            清空
          </button>
        </div>
      </div>
      <div class="candidate-shelf">
        <section class="cand-block" aria-label="视频候选版本">
          <div class="candidate-shelf-heading">
            <div>
              <h3>视频</h3>
              <span>{{ detail.videoCandidates.length }} 个版本</span>
            </div>
            <button class="candidate-route" type="button" @click="emit('action', 'video')">
              生成 / 返工
              <span class="material-symbols-outlined" aria-hidden="true">arrow_outward</span>
            </button>
          </div>
          <div v-if="detail.videoCandidates.length" class="cand-thumbs">
            <div
              v-for="v in detail.videoCandidates"
              :key="'v' + v.id"
              class="cand-thumb"
              role="button"
              tabindex="0"
              :class="{
                'cand-thumb--confirmed': v.confirmed,
                'cand-thumb--selected': selectedKind === 'video' && selectedCandidateId === v.id,
              }"
              :aria-label="`视频候选 v${v.versionNo} · ${candidateStatusLabel(v.status)}`"
              :title="`v${v.versionNo} · ${candidateStatusLabel(v.status)}`"
              @click="selectCandidate('video', v)"
              @keydown="handleCandidateKeydown($event, 'video', v)"
            >
              <video v-if="v.url" :src="v.url" class="h-full w-full object-cover" muted preload="metadata"></video>
              <span v-else class="frame-empty">无预览</span>
              <span class="cand-ver font-mono">v{{ v.versionNo }}</span>
              <span class="cand-state" :class="{ 'cand-state--confirmed': v.confirmed }">
                {{ candidateStatusLabel(v.status) }}
              </span>
              <label class="cand-select" :class="{ 'cand-select--checked': isQueued('video', v) }" @click.stop>
                <input
                  type="checkbox"
                  :checked="isQueued('video', v)"
                  :disabled="v.confirmed || v.status === 'archived' || isPending('video', v)"
                  :aria-label="`加入视频候选复核队列 v${v.versionNo}`"
                  @change="toggleQueue('video', v)"
                />
                <span class="material-symbols-outlined" aria-hidden="true">check</span>
              </label>
            </div>
          </div>
          <p v-else class="field-sub">还没有视频版本。先完成静帧与动作提示词，再生成镜头动作。</p>
          <p v-if="detail.currentVideo" class="candidate-current-note">
            当前主版本 <strong>v{{ detail.currentVideo.versionNo }}</strong>
          </p>
          <button
            v-if="queuedCandidates.some((item) => item.kind === 'video')"
            type="button"
            class="candidate-batch-action"
            :disabled="pendingCandidateKey === 'batch'"
            @click="archiveQueued('video')"
          >
            <span class="material-symbols-outlined" aria-hidden="true">archive</span>
            {{ pendingCandidateKey === 'batch' ? '正在归档…' : '归档选中视频' }}
          </button>
        </section>

        <section class="cand-block" aria-label="音频候选版本">
          <div class="candidate-shelf-heading">
            <div>
              <h3>声音</h3>
              <span>{{ detail.audioCandidates.length }} 个版本</span>
            </div>
            <button class="candidate-route" type="button" @click="emit('action', 'audio')">
              生成 / 返工
              <span class="material-symbols-outlined" aria-hidden="true">arrow_outward</span>
            </button>
          </div>
          <div v-if="detail.audioCandidates.length" class="cand-thumbs">
            <div
              v-for="a in detail.audioCandidates"
              :key="'a' + a.id"
              class="cand-thumb cand-thumb--audio"
              role="button"
              tabindex="0"
              :class="{
                'cand-thumb--confirmed': a.confirmed,
                'cand-thumb--selected': selectedKind === 'audio' && selectedCandidateId === a.id,
              }"
              :aria-label="`音频候选 v${a.versionNo} · ${candidateStatusLabel(a.status)}`"
              :title="`${a.versionNo} · ${candidateStatusLabel(a.status)}`"
              @click="selectCandidate('audio', a)"
              @keydown="handleCandidateKeydown($event, 'audio', a)"
            >
              <span class="material-symbols-outlined text-xl" aria-hidden="true">
                {{ a.status === 'confirmed' ? 'music_note' : 'graphic_eq' }}
              </span>
              <span class="cand-ver font-mono">v{{ a.versionNo }}</span>
              <span class="cand-state" :class="{ 'cand-state--confirmed': a.confirmed }">
                {{ candidateStatusLabel(a.status) }}
              </span>
              <label class="cand-select" :class="{ 'cand-select--checked': isQueued('audio', a) }" @click.stop>
                <input
                  type="checkbox"
                  :checked="isQueued('audio', a)"
                  :disabled="a.confirmed || a.status === 'archived' || isPending('audio', a)"
                  :aria-label="`加入音频候选复核队列 v${a.versionNo}`"
                  @change="toggleQueue('audio', a)"
                />
                <span class="material-symbols-outlined" aria-hidden="true">check</span>
              </label>
            </div>
          </div>
          <p v-else class="field-sub">还没有声音版本。生成后可在这里试听并确认。</p>
          <p v-if="detail.currentAudio" class="candidate-current-note">
            当前主版本 <strong>v{{ detail.currentAudio.versionNo }}</strong>
          </p>
          <button
            v-if="queuedCandidates.some((item) => item.kind === 'audio')"
            type="button"
            class="candidate-batch-action"
            :disabled="pendingCandidateKey === 'batch'"
            @click="archiveQueued('audio')"
          >
            <span class="material-symbols-outlined" aria-hidden="true">archive</span>
            {{ pendingCandidateKey === 'batch' ? '正在归档…' : '归档选中声音' }}
          </button>
        </section>
      </div>

      <Transition name="candidate-review">
        <section
          v-if="selectedCandidate && selectedKind"
          class="candidate-review"
          :aria-label="selectedKind === 'video' ? '视频候选复核' : '音频候选复核'"
        >
          <header class="candidate-review-head">
            <div>
              <span class="candidate-review-label">{{ selectedKind === 'video' ? '视频候选' : '声音候选' }}</span>
              <h3>
                {{ selectedCandidate.title || (selectedKind === 'video' ? '动作视频' : selectedCandidate.trackType || '音频') }}
                <span>v{{ selectedCandidate.versionNo }}</span>
              </h3>
            </div>
            <div v-if="canCompareCurrent" class="candidate-compare" role="group" aria-label="切换对照版本">
              <button
                type="button"
                :aria-pressed="previewSide === 'candidate'"
                @click="previewSide = 'candidate'"
              >
                待选 v{{ selectedCandidate.versionNo }}
              </button>
              <button
                type="button"
                :aria-pressed="previewSide === 'current'"
                @click="previewSide = 'current'"
              >
                主版本 v{{ currentCandidate?.versionNo }}
              </button>
            </div>
          </header>

          <div class="candidate-review-body">
            <div class="candidate-player" :class="`candidate-player--${selectedKind}`">
              <video
                v-if="selectedKind === 'video' && previewCandidate?.url"
                :key="`video-${previewCandidate.id}`"
                :src="previewCandidate.url"
                controls
                playsinline
                preload="metadata"
                :aria-label="`${previewSide === 'current' ? '当前主版本' : '待选版本'}视频 v${previewCandidate.versionNo}`"
              ></video>
              <audio
                v-else-if="selectedKind === 'audio' && previewCandidate?.url"
                :key="`audio-${previewCandidate.id}`"
                :src="previewCandidate.url"
                controls
                preload="none"
                :aria-label="`${previewSide === 'current' ? '当前主版本' : '待选版本'}音频 v${previewCandidate.versionNo}`"
              ></audio>
              <div v-else class="candidate-player-empty">
                <span class="material-symbols-outlined" aria-hidden="true">error_outline</span>
                该版本没有可播放的媒体地址
              </div>
            </div>

            <div class="candidate-review-info">
              <div class="candidate-meta">
                <span>状态</span>
                <strong>{{ candidateStatusLabel(previewCandidate?.status || '') }}</strong>
                <span>时长</span>
                <strong>{{ fmt(previewCandidate?.durationSeconds) }}</strong>
                <template v-if="selectedKind === 'audio'">
                  <span>角色 / 声线</span>
                  <strong>{{ previewCandidate?.characterName || '未绑定角色' }} · {{ previewCandidate?.voiceName || '未记录声线' }}</strong>
                </template>
                <template v-if="previewCandidate?.modelName">
                  <span>生成模型</span>
                  <strong>{{ previewCandidate.modelName }}</strong>
                </template>
                <template v-if="previewCandidate?.motionMode">
                  <span>动作模式</span>
                  <strong>{{ previewCandidate.motionMode }}</strong>
                </template>
                <template v-if="previewCandidate?.generationJobId">
                  <span>生成任务</span>
                  <strong class="font-mono">#{{ previewCandidate.generationJobId }}</strong>
                </template>
                <template v-if="previewCandidate?.voiceProfileKey">
                  <span>声线配置</span>
                  <strong>{{ previewCandidate.voiceProfileKey }}</strong>
                </template>
                <template v-if="previewCandidate?.estimatedCost != null">
                  <span>估算成本</span>
                  <strong>
                    {{ previewCandidate.costCurrency || 'CNY' }} {{ previewCandidate.estimatedCost.toFixed(4) }}
                    <small v-if="previewCandidate.costStatus">· {{ previewCandidate.costStatus }}</small>
                  </strong>
                </template>
              </div>
              <p class="candidate-review-hint">
                {{ selectedKind === 'video'
                  ? '逐条播放检查动作、人物与道具连续性；确认后会成为该镜头采用的视频。'
                  : '试听对白内容、角色声线与情绪；确认后会成为对应音轨范围的主版本。' }}
              </p>
              <button
                v-if="!selectedCandidate.confirmed"
                type="button"
                class="candidate-confirm"
                :disabled="!selectedCandidate.url || isPending(selectedKind, selectedCandidate)"
                @click="confirmSelectedCandidate"
              >
                <span class="material-symbols-outlined" aria-hidden="true">
                  {{ isPending(selectedKind, selectedCandidate) ? 'progress_activity' : 'check_circle' }}
                </span>
                {{
                  isPending(selectedKind, selectedCandidate)
                    ? '正在确认…'
                    : selectedKind === 'video'
                      ? '确认采用此视频'
                      : '确认采用此音频'
                }}
              </button>
              <p v-else class="candidate-confirmed-note">
                <span class="material-symbols-outlined" aria-hidden="true">verified</span>
                这是当前主版本
              </p>
              <p
                v-if="activeFeedback"
                class="candidate-feedback"
                :class="`candidate-feedback--${activeFeedback.tone}`"
                role="status"
                aria-live="polite"
              >
                {{ activeFeedback.message }}
              </p>
            </div>
          </div>
        </section>
      </Transition>
    </details>

    <div class="field-note">
      返工原因：待接入 · 候选筛选状态：当前候选与历史候选按 status / versionNo 区分，未经确认不会进入终剪。
    </div>
  </section>
</template>

<style scoped>
.prod-card {
  border: 1px solid rgba(255, 183, 125, 0.18);
  background: #161817;
  padding: 1.25rem 1.35rem 1.4rem;
}

.workflow-guide {
  margin-bottom: 1.25rem;
  border: 1px solid rgba(255, 183, 125, 0.28);
  background: #111411;
  padding: 1.1rem 1.15rem 1.2rem;
}
.workflow-guide-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
  padding-bottom: 1rem;
}
.workflow-kicker {
  color: #ffb77d;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.workflow-guide h3 {
  margin-top: 0.35rem;
  color: #f4ede3;
  font-size: 1.08rem;
  font-weight: 800;
}
.workflow-guide p {
  max-width: 48rem;
  margin-top: 0.25rem;
  color: #aaa39a;
  font-size: 0.72rem;
  line-height: 1.5;
}
.workflow-primary {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.35rem;
  min-height: 2.55rem;
  border: 1px solid #d97707;
  background: #d97707;
  padding: 0 0.75rem;
  color: #1a1408;
  font-size: 0.7rem;
  font-weight: 800;
  transition: background-color 160ms ease, border-color 160ms ease;
}
.workflow-primary:hover {
  border-color: #ffb77d;
  background: #ffb77d;
}
.workflow-primary:focus-visible,
.blocker-summary button:focus-visible,
.workflow-step-button:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.workflow-steps {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 0.7rem;
  margin: 0;
  padding: 0.75rem 0 0;
  list-style: none;
}
.workflow-step {
  min-width: 0;
  border-top: 2px solid #383b36;
  padding-top: 0.15rem;
}
.workflow-step--done {
  border-top-color: #83b68c;
}
.workflow-step--current {
  border-top-color: #ffb77d;
}
.workflow-step--blocked {
  border-top-color: #be7068;
}
.workflow-step-button {
  display: flex;
  width: 100%;
  min-height: 4.8rem;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.25rem;
  padding: 0.55rem 0.25rem 0;
  color: #d5cec4;
  text-align: left;
}
button.workflow-step-button {
  cursor: pointer;
}
.workflow-step-index {
  color: #837c73;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.58rem;
}
.workflow-step--done .workflow-step-index {
  color: #83b68c;
}
.workflow-step--current .workflow-step-index {
  color: #ffb77d;
}
.workflow-step--blocked .workflow-step-index {
  color: #ff9d94;
}
.workflow-step-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.18rem;
}
.workflow-step-copy strong {
  color: #e7e0d6;
  font-size: 0.68rem;
}
.workflow-step-copy small {
  overflow: hidden;
  color: #8d857c;
  font-size: 0.6rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-step-status {
  color: #777269;
  font-size: 0.58rem;
}
.workflow-step--done .workflow-step-status {
  color: #83c68c;
}
.workflow-step--current .workflow-step-status {
  color: #ffd9b0;
}
.workflow-step--blocked .workflow-step-status {
  color: #ff9d94;
}
.blocker-summary {
  margin-bottom: 1.25rem;
  border-left: 2px solid #be7068;
  background: rgba(202, 84, 74, 0.07);
  padding: 0.9rem 1rem 1rem;
}
.blocker-summary-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.blocker-summary-head h3 {
  color: #f0d3cc;
  font-size: 0.72rem;
  font-weight: 800;
}
.blocker-summary-head span {
  color: #ff9d94;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.62rem;
}
.blocker-summary ul {
  display: grid;
  gap: 0.65rem;
  margin: 0.7rem 0 0;
  padding: 0;
  list-style: none;
}
.blocker-summary li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  color: #ffb2aa;
}
.blocker-summary li > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.15rem;
}
.blocker-summary li strong {
  color: #f0d3cc;
  font-size: 0.68rem;
}
.blocker-summary li small {
  color: #b69b94;
  font-size: 0.64rem;
  line-height: 1.4;
}
.blocker-summary li button {
  border-bottom: 1px solid rgba(255, 183, 125, 0.5);
  color: #ffd9b0;
  font-size: 0.62rem;
  font-weight: 800;
}
.blocker--warning {
  color: #d6a65f !important;
}
.blocker--warning strong {
  color: #e8c98f !important;
}
.blocker--warning small {
  color: #b7a782 !important;
}

.detail-disclosure {
  border-top: 1px solid rgba(255, 183, 125, 0.12);
  padding: 0.7rem 0;
}

.detail-disclosure > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #e7e0d6;
  cursor: pointer;
  font-size: 0.72rem;
  font-weight: 800;
  list-style: none;
}

.detail-disclosure > summary::-webkit-details-marker { display: none; }
.detail-disclosure > summary::after {
  color: #8d857c;
  content: 'expand_more';
  font-family: 'Material Symbols Outlined';
  font-size: 1rem;
  transition: transform 160ms ease;
}
.detail-disclosure[open] > summary::after {
  transform: rotate(180deg);
}
.detail-disclosure > summary + * {
  margin-top: 0.7rem;
}
.card-titlebar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.9rem;
  padding-bottom: 0.8rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
}
.divider-note {
  color: #a29a90;
  font-size: 0.7rem;
  text-align: right;
}
.frame-box {
  border: 1px solid #2c2c28;
  background: #0f110f;
  overflow: hidden;
}
.frame-box figcaption {
  padding: 0.35rem 0.55rem;
  color: #a9a29a;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  border-bottom: 1px solid #232522;
}
.frame-box img {
  display: block;
  width: 100%;
  aspect-ratio: 9 / 16;
  object-fit: cover;
}
.frame-empty {
  display: flex;
  min-height: 6rem;
  align-items: center;
  justify-content: center;
  color: #6c6760;
  font-size: 0.7rem;
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.field-label {
  color: #a9a29a;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  margin-bottom: 0.15rem;
}
.field-label--sm {
  margin-top: 0.5rem;
}
.field-value {
  color: #e7e0d6;
  font-size: 0.82rem;
  line-height: 1.45;
}
.field-value--sm {
  font-size: 0.74rem;
  line-height: 1.4;
}
.field-sub {
  color: #8d857c;
  font-size: 0.7rem;
  line-height: 1.4;
}
.field-note {
  margin-top: 0.6rem;
  color: #8d857c;
  font-size: 0.66rem;
  line-height: 1.5;
}
.entity-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.entity-tag {
  border: 1px solid rgba(255, 183, 125, 0.4);
  padding: 0.1rem 0.5rem;
  color: #ffd9b0;
  font-size: 0.7rem;
}
.cand-block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.7rem;
  padding: 0.85rem 0;
  border-top: 1px solid rgba(255, 183, 125, 0.13);
}
.candidate-shelf {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.9rem 1.4rem;
}
.review-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin: 0.8rem 0 0.2rem;
  border: 1px solid rgba(255, 183, 125, 0.18);
  background: rgba(10, 12, 10, 0.48);
  padding: 0.65rem 0.75rem;
}
.review-toolbar-copy {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.5rem;
  color: #ffcf9f;
}
.review-toolbar-copy > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.1rem;
}
.review-toolbar-copy strong {
  color: #f1ece4;
  font-size: 0.68rem;
}
.review-toolbar-copy small {
  color: #9f968b;
  font-size: 0.62rem;
}
.review-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 0.35rem;
}
.review-tool-button,
.candidate-batch-action {
  display: inline-flex;
  min-height: 1.85rem;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
  border: 1px solid rgba(255, 183, 125, 0.28);
  padding: 0 0.5rem;
  color: #d8c2ad;
  font-size: 0.61rem;
  font-weight: 750;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}
.review-tool-button:hover:not(:disabled),
.review-tool-button:focus-visible,
.candidate-batch-action:hover:not(:disabled),
.candidate-batch-action:focus-visible {
  border-color: rgba(255, 183, 125, 0.68);
  background: rgba(255, 183, 125, 0.1);
  color: #ffdfc0;
}
.review-tool-button:disabled,
.candidate-batch-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.candidate-batch-action {
  align-self: flex-start;
  margin-top: 0.05rem;
  color: #c9b29a;
}
.candidate-shelf-heading {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
}
.candidate-shelf-heading > div {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 0.55rem;
}
.candidate-shelf-heading h3 {
  margin: 0;
  color: #f1ece4;
  font-size: 0.78rem;
  font-weight: 800;
}
.candidate-shelf-heading span:not(.material-symbols-outlined) {
  color: #b6ada1;
  font-size: 0.65rem;
}
.candidate-route {
  display: inline-flex;
  min-height: 1.9rem;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid rgba(255, 183, 125, 0.24);
  padding: 0 0.5rem;
  color: #e8c6a6;
  font-size: 0.64rem;
  font-weight: 700;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}
.candidate-route:hover {
  border-color: rgba(255, 183, 125, 0.62);
  background: rgba(255, 183, 125, 0.07);
  color: #ffdfc0;
}
.candidate-route:focus-visible,
.candidate-compare button:focus-visible,
.candidate-confirm:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.cand-thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
}
.cand-thumb {
  position: relative;
  display: flex;
  width: 4.65rem;
  aspect-ratio: 9 / 16;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid #33332f;
  background: #0f110f;
  color: #8d857c;
  transition: border-color 150ms ease, transform 150ms ease;
  cursor: pointer;
}
.cand-thumb:hover {
  border-color: rgba(255, 183, 125, 0.6);
  transform: translateY(-1px);
}
.cand-thumb:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.cand-select {
  position: absolute;
  right: 0.28rem;
  top: 0.28rem;
  z-index: 2;
  display: inline-flex;
  width: 1.15rem;
  height: 1.15rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 236, 215, 0.44);
  background: rgba(7, 9, 7, 0.72);
  color: transparent;
  cursor: pointer;
}
.cand-select input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.cand-select .material-symbols-outlined {
  font-size: 0.82rem;
}
.cand-select--checked {
  border-color: #ffb77d;
  background: #b87443;
  color: #120f0c;
}
.cand-select:focus-within {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.cand-thumb--confirmed {
  border-color: #ffb77d;
}
.cand-thumb--selected {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.cand-ver {
  position: absolute;
  right: 0.25rem;
  bottom: 0.3rem;
  background: rgba(0, 0, 0, 0.78);
  padding: 0.12rem 0.3rem;
  color: #e7e0d6;
  font-size: 0.58rem;
  line-height: 1;
}
.cand-state {
  position: absolute;
  top: 0.25rem;
  left: 0.25rem;
  max-width: calc(100% - 0.5rem);
  overflow: hidden;
  background: rgba(10, 12, 10, 0.9);
  padding: 0.15rem 0.28rem;
  color: #ded5c8;
  font-size: 0.52rem;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand-state--confirmed {
  color: #ffcf9f;
}
.candidate-current-note {
  margin: 0;
  color: #c2b8aa;
  font-size: 0.64rem;
}
.candidate-current-note strong {
  margin-left: 0.2rem;
  color: #ffcf9f;
  font-variant-numeric: tabular-nums;
}
.candidate-review {
  margin-top: 0.4rem;
  border: 1px solid rgba(255, 183, 125, 0.2);
  background: #111411;
  padding: 1rem;
}
.candidate-review-head {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
  padding-bottom: 0.8rem;
}
.candidate-review-label {
  color: #d4a97f;
  font-size: 0.61rem;
  font-weight: 800;
}
.candidate-review-head h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.45rem;
  margin: 0.18rem 0 0;
  color: #f1ece4;
  font-size: 0.9rem;
  font-weight: 750;
}
.candidate-review-head h3 span {
  color: #c8b09a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
}
.candidate-compare {
  display: inline-flex;
  flex: 0 0 auto;
  border: 1px solid #3b3933;
}
.candidate-compare button {
  min-height: 2rem;
  padding: 0 0.6rem;
  color: #c2b8aa;
  font-size: 0.63rem;
  transition: background-color 150ms ease, color 150ms ease;
}
.candidate-compare button + button {
  border-left: 1px solid #3b3933;
}
.candidate-compare button[aria-pressed='true'] {
  background: rgba(255, 183, 125, 0.12);
  color: #ffdbb8;
}
.candidate-review-body {
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(15rem, 0.88fr);
  gap: 1rem;
  padding-top: 0.9rem;
}
.candidate-player {
  display: flex;
  min-width: 0;
  min-height: 5rem;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #080a08;
}
.candidate-player--video {
  aspect-ratio: 16 / 9;
  max-height: 22rem;
}
.candidate-player video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.candidate-player audio {
  display: block;
  width: calc(100% - 1.25rem);
  min-height: 2.8rem;
}
.candidate-player-empty {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 1rem;
  color: #c2b8aa;
  font-size: 0.68rem;
}
.candidate-review-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: stretch;
  gap: 0.75rem;
}
.candidate-meta {
  display: grid;
  grid-template-columns: minmax(5.5rem, 0.65fr) minmax(0, 1fr);
  gap: 0.45rem 0.65rem;
  align-content: start;
  color: #c2b8aa;
  font-size: 0.65rem;
}
.candidate-meta strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: #f1ece4;
  font-size: 0.67rem;
  font-weight: 650;
}
.candidate-review-hint {
  margin: 0;
  color: #c2b8aa;
  font-size: 0.67rem;
  line-height: 1.55;
}
.candidate-confirm {
  display: inline-flex;
  min-height: 2.45rem;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  border: 1px solid #e3a36e;
  background: #b87443;
  padding: 0 0.85rem;
  color: #120f0c;
  font-size: 0.7rem;
  font-weight: 800;
  transition: background-color 150ms ease, border-color 150ms ease;
}
.candidate-confirm:hover:not(:disabled) {
  border-color: #ffd1a8;
  background: #d1915e;
}
.candidate-confirm:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.candidate-confirmed-note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0;
  color: #ffcf9f;
  font-size: 0.69rem;
}
.candidate-feedback {
  margin: 0;
  font-size: 0.66rem;
  line-height: 1.5;
}
.candidate-feedback--success {
  color: #a8d7b2;
}
.candidate-feedback--warning {
  color: #f2c78f;
}
.candidate-feedback--error {
  color: #ffaaa2;
}
.candidate-review-enter-active,
.candidate-review-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.candidate-review-enter-from,
.candidate-review-leave-to {
  opacity: 0;
  transform: translateY(0.35rem);
}

@media (max-width: 767px) {
  .prod-card {
    padding: 1rem 0.8rem 1.15rem;
  }

  .workflow-guide-head {
    flex-direction: column;
  }
  .workflow-primary {
    width: 100%;
    justify-content: center;
  }
  .workflow-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .workflow-step-copy small {
    white-space: normal;
  }
  .blocker-summary li {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .blocker-summary li button {
    grid-column: 2;
    justify-self: start;
  }
  .candidate-shelf {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.3rem;
  }
  .candidate-review {
    padding: 0.8rem;
  }
  .candidate-review-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .candidate-review-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.8rem;
  }
  .candidate-player--video {
    aspect-ratio: 4 / 3;
    max-height: 17rem;
  }
  .candidate-confirm {
    width: 100%;
  }
}

@media (min-width: 768px) and (max-width: 1240px) {
  .workflow-steps {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    row-gap: 0.9rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .candidate-review-enter-active,
  .candidate-review-leave-active,
  .cand-thumb,
  .candidate-route,
  .candidate-compare button,
  .candidate-confirm {
    transition: none;
  }
}
</style>
