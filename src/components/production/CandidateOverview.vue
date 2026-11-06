<script setup lang="ts">
/** 跨镜头候选总览：把所有场景的候选压缩成可扫描、可批量决策的 contact sheet。 */
import { computed, ref } from 'vue'
import type { CandidateOverviewItem } from '@/api/production-studio'

const props = defineProps<{
  items: CandidateOverviewItem[]
  pending?: boolean
}>()

const emit = defineEmits<{
  (e: 'open', item: CandidateOverviewItem): void
  (e: 'archive', items: CandidateOverviewItem[]): void
  (e: 'rework', items: CandidateOverviewItem[]): void
}>()

type OverviewFilter = 'all' | 'video' | 'audio' | 'candidate' | 'confirmed'

const filter = ref<OverviewFilter>('all')
const selectedKeys = ref<Set<string>>(new Set())

const visibleItems = computed(() => {
  return props.items.filter((item) => {
    if (filter.value === 'video' || filter.value === 'audio') return item.kind === filter.value
    if (filter.value === 'candidate') return item.candidate.status === 'candidate'
    if (filter.value === 'confirmed') return item.candidate.confirmed
    return true
  })
})

const selectedItems = computed(() =>
  props.items.filter((item) => selectedKeys.value.has(item.key)),
)

const counts = computed(() => ({
  total: props.items.length,
  video: props.items.filter((item) => item.kind === 'video').length,
  audio: props.items.filter((item) => item.kind === 'audio').length,
  candidate: props.items.filter((item) => item.candidate.status === 'candidate').length,
  confirmed: props.items.filter((item) => item.candidate.confirmed).length,
}))

function statusLabel(item: CandidateOverviewItem): string {
  if (item.candidate.confirmed) return '主版本'
  if (item.candidate.status === 'candidate') return '待复核'
  return item.candidate.status || '未知'
}

function toggle(item: CandidateOverviewItem): void {
  if (item.candidate.confirmed || item.candidate.status !== 'candidate') return
  const next = new Set(selectedKeys.value)
  if (next.has(item.key)) next.delete(item.key)
  else next.add(item.key)
  selectedKeys.value = next
}

function selectVisible(): void {
  const next = new Set(selectedKeys.value)
  for (const item of visibleItems.value) {
    if (!item.candidate.confirmed && item.candidate.status === 'candidate') next.add(item.key)
  }
  selectedKeys.value = next
}

function clearSelection(): void {
  selectedKeys.value = new Set()
}

function submitArchive(): void {
  const items = selectedItems.value.filter((item) => !item.candidate.confirmed)
  if (items.length) emit('archive', items)
}

function submitRework(): void {
  const items = selectedItems.value.filter((item) => !item.candidate.confirmed)
  if (items.length) emit('rework', items)
}

function handleKeydown(event: KeyboardEvent, item: CandidateOverviewItem): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('open', item)
}
</script>

<template>
  <section class="candidate-overview" aria-labelledby="candidate-overview-title">
    <header class="overview-head">
      <div>
        <span class="overview-kicker">CANDIDATE REVIEW / ALL SHOTS</span>
        <h2 id="candidate-overview-title">跨镜头候选总览</h2>
        <p>把当前单集的候选放在一张接触表里，先做筛选，再进入逐镜返工。</p>
      </div>
      <div class="overview-summary" aria-label="候选统计">
        <strong>{{ counts.total }}</strong>
        <span>个候选</span>
        <small>{{ counts.candidate }} 待复核 · {{ counts.confirmed }} 主版本</small>
      </div>
    </header>

    <div class="overview-toolbar">
      <div class="filter-tabs" role="tablist" aria-label="候选筛选">
        <button type="button" :aria-selected="filter === 'all'" @click="filter = 'all'">全部 {{ counts.total }}</button>
        <button type="button" :aria-selected="filter === 'video'" @click="filter = 'video'">视频 {{ counts.video }}</button>
        <button type="button" :aria-selected="filter === 'audio'" @click="filter = 'audio'">声音 {{ counts.audio }}</button>
        <button type="button" :aria-selected="filter === 'candidate'" @click="filter = 'candidate'">待复核 {{ counts.candidate }}</button>
        <button type="button" :aria-selected="filter === 'confirmed'" @click="filter = 'confirmed'">主版本 {{ counts.confirmed }}</button>
      </div>
      <div class="overview-actions">
        <span v-if="selectedItems.length" class="selection-count">已选 {{ selectedItems.length }}</span>
        <button type="button" class="overview-action" @click="selectVisible">全选当前</button>
        <button type="button" class="overview-action" :disabled="!selectedItems.length" @click="clearSelection">清空</button>
      </div>
    </div>

    <div v-if="pending" class="overview-status" role="status">
      正在同步所有镜头候选…
    </div>

    <div v-else-if="visibleItems.length" class="contact-sheet">
      <article
        v-for="item in visibleItems"
        :key="item.key"
        class="candidate-tile"
        :class="{
          'candidate-tile--selected': selectedKeys.has(item.key),
          'candidate-tile--confirmed': item.candidate.confirmed,
        }"
        tabindex="0"
        @click="emit('open', item)"
        @keydown="handleKeydown($event, item)"
      >
        <div class="tile-media">
          <video
            v-if="item.kind === 'video' && item.candidate.url"
            :src="item.candidate.url"
            muted
            preload="metadata"
            aria-hidden="true"
          ></video>
          <audio
            v-else-if="item.kind === 'audio' && item.candidate.url"
            :src="item.candidate.url"
            controls
            preload="none"
            :aria-label="`试听 Scene ${item.sceneNo} / ${item.shotNo} v${item.candidate.versionNo}`"
            @click.stop
          ></audio>
          <span v-else class="tile-empty">
            <span class="material-symbols-outlined" aria-hidden="true">
              {{ item.kind === 'video' ? 'movie' : 'graphic_eq' }}
            </span>
            暂无媒体
          </span>
          <span class="tile-kind">{{ item.kind === 'video' ? 'VIDEO' : 'AUDIO' }}</span>
          <span class="tile-status" :class="{ 'tile-status--confirmed': item.candidate.confirmed }">
            {{ statusLabel(item) }}
          </span>
          <label class="tile-select" @click.stop>
            <input
              type="checkbox"
              :checked="selectedKeys.has(item.key)"
              :disabled="item.candidate.confirmed || item.candidate.status !== 'candidate'"
              :aria-label="`选择 Scene ${item.sceneNo} / ${item.shotNo} v${item.candidate.versionNo}`"
              @change="toggle(item)"
            />
            <span class="material-symbols-outlined" aria-hidden="true">check</span>
          </label>
        </div>
        <div class="tile-copy">
          <div class="tile-location">
            <span class="font-mono">SCENE {{ String(item.sceneNo).padStart(2, '0') }} / {{ String(item.shotNo).padStart(2, '0') }}</span>
            <strong>v{{ item.candidate.versionNo }}</strong>
          </div>
          <p>{{ item.primaryAction || item.dialogueText || '镜头动作待接入' }}</p>
          <small>
            {{ item.candidate.modelName || '模型未记录' }}
            <template v-if="item.candidate.estimatedCost != null">
              · {{ item.candidate.costCurrency || 'CNY' }} {{ item.candidate.estimatedCost.toFixed(4) }}
            </template>
          </small>
        </div>
      </article>
    </div>

    <div v-else class="overview-empty">
      <span class="material-symbols-outlined" aria-hidden="true">collections_bookmark</span>
      <strong>当前筛选没有候选</strong>
      <span>先在视频或声音模块生成候选，回到这里统一复核。</span>
    </div>

    <footer v-if="selectedItems.length" class="overview-batch-bar" role="region" aria-label="批量候选操作">
      <div>
        <strong>已选 {{ selectedItems.length }} 个待复核候选</strong>
        <span>原始媒体保留；返工会带着镜头上下文进入对应生成模块。</span>
      </div>
      <div class="overview-batch-actions">
        <button type="button" class="batch-secondary" @click="submitArchive">
          <span class="material-symbols-outlined" aria-hidden="true">archive</span>
          归档淘汰
        </button>
        <button type="button" class="batch-primary" @click="submitRework">
          <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
          加入返工队列
        </button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.candidate-overview {
  border-top: 1px solid rgba(255, 183, 125, 0.16);
  background: #101310;
  padding: 1.35rem 1.35rem 1.1rem;
}
.overview-head,
.overview-toolbar,
.overview-batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.overview-head {
  align-items: flex-start;
  padding-bottom: 1rem;
}
.overview-kicker {
  color: #d4a97f;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.15em;
}
.overview-head h2 {
  margin: 0.28rem 0 0;
  color: #f2ece3;
  font-size: 1.02rem;
  font-weight: 800;
}
.overview-head p {
  margin: 0.28rem 0 0;
  color: #918a81;
  font-size: 0.68rem;
}
.overview-summary {
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  column-gap: 0.35rem;
  color: #988f84;
  white-space: nowrap;
}
.overview-summary strong {
  color: #ffb77d;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.35rem;
}
.overview-summary span {
  font-size: 0.66rem;
}
.overview-summary small {
  grid-column: 1 / -1;
  color: #706a62;
  font-size: 0.58rem;
}
.overview-toolbar {
  border-top: 1px solid rgba(255, 183, 125, 0.12);
  border-bottom: 1px solid rgba(255, 183, 125, 0.12);
  padding: 0.65rem 0;
}
.filter-tabs,
.overview-actions,
.overview-batch-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.32rem;
}
.filter-tabs button,
.overview-action {
  min-height: 1.85rem;
  border: 1px solid transparent;
  padding: 0 0.55rem;
  color: #978f85;
  font-size: 0.62rem;
  transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
}
.filter-tabs button:hover,
.filter-tabs button[aria-selected='true'],
.overview-action:hover:not(:disabled) {
  border-color: rgba(255, 183, 125, 0.4);
  background: rgba(255, 183, 125, 0.08);
  color: #ffdbb8;
}
.overview-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.selection-count {
  align-self: center;
  color: #ffcf9f;
  font-size: 0.61rem;
  font-weight: 800;
}
.overview-status {
  padding: 1.4rem 0;
  color: #bca895;
  font-size: 0.7rem;
}
.contact-sheet {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 0.7rem;
  padding: 1rem 0 0.25rem;
}
.candidate-tile {
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: #151815;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
}
.candidate-tile:hover {
  border-color: rgba(255, 183, 125, 0.48);
  background: #191b17;
  transform: translateY(-1px);
}
.candidate-tile:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.candidate-tile--selected {
  border-color: #ffb77d;
  box-shadow: inset 0 0 0 1px rgba(255, 183, 125, 0.24);
}
.candidate-tile--confirmed {
  border-color: rgba(131, 182, 140, 0.38);
}
.tile-media {
  position: relative;
  display: flex;
  aspect-ratio: 16 / 9;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #0b0d0b;
}
.tile-media video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile-media audio {
  width: calc(100% - 1rem);
}
.tile-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  color: #6c6760;
  font-size: 0.62rem;
}
.tile-kind,
.tile-status {
  position: absolute;
  top: 0.35rem;
  background: rgba(7, 9, 7, 0.78);
  padding: 0.16rem 0.3rem;
  color: #d5cec4;
  font-size: 0.52rem;
  font-weight: 800;
  letter-spacing: 0.08em;
}
.tile-kind {
  left: 0.35rem;
}
.tile-status {
  right: 0.35rem;
  letter-spacing: 0;
}
.tile-status--confirmed {
  color: #a8d7b2;
}
.tile-select {
  position: absolute;
  right: 0.35rem;
  bottom: 0.35rem;
  display: inline-flex;
  width: 1.2rem;
  height: 1.2rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 236, 215, 0.48);
  background: rgba(7, 9, 7, 0.78);
  color: transparent;
  cursor: pointer;
}
.tile-select input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.tile-select input:checked + .material-symbols-outlined {
  color: #17110b;
}
.tile-select:has(input:checked) {
  border-color: #ffb77d;
  background: #b87443;
}
.tile-select:focus-within {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.tile-copy {
  display: flex;
  min-height: 5rem;
  flex-direction: column;
  gap: 0.3rem;
  border-top: 1px solid #242524;
  padding: 0.62rem 0.7rem 0.7rem;
}
.tile-location {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  color: #ffb77d;
  font-size: 0.62rem;
}
.tile-location strong {
  color: #d7c4b1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6rem;
}
.tile-copy p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: #d5cec4;
  font-size: 0.65rem;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.tile-copy small {
  overflow: hidden;
  color: #777169;
  font-size: 0.56rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.overview-empty {
  display: flex;
  min-height: 10rem;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  color: #7e776f;
  font-size: 0.68rem;
}
.overview-empty .material-symbols-outlined {
  color: #aa815f;
  font-size: 1.5rem;
}
.overview-empty strong {
  color: #d6c6b6;
  font-size: 0.78rem;
}
.overview-batch-bar {
  position: sticky;
  bottom: 0;
  z-index: 3;
  margin: 0.85rem -0.2rem 0;
  border-top: 1px solid rgba(255, 183, 125, 0.26);
  background: rgba(16, 19, 16, 0.96);
  padding: 0.7rem 0.2rem 0.1rem;
  backdrop-filter: blur(8px);
}
.overview-batch-bar > div:first-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.18rem;
}
.overview-batch-bar strong {
  color: #f0e6db;
  font-size: 0.68rem;
}
.overview-batch-bar span {
  color: #91877d;
  font-size: 0.58rem;
}
.batch-secondary,
.batch-primary {
  display: inline-flex;
  min-height: 2.2rem;
  align-items: center;
  gap: 0.3rem;
  padding: 0 0.65rem;
  font-size: 0.63rem;
  font-weight: 800;
}
.batch-secondary {
  border: 1px solid rgba(255, 183, 125, 0.3);
  color: #d8c0aa;
}
.batch-primary {
  border: 1px solid #e3a36e;
  background: #b87443;
  color: #120f0c;
}
.batch-secondary:hover {
  border-color: rgba(255, 183, 125, 0.7);
  background: rgba(255, 183, 125, 0.08);
}
.batch-primary:hover {
  background: #d1915e;
}
.batch-secondary:focus-visible,
.batch-primary:focus-visible,
.filter-tabs button:focus-visible,
.overview-action:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}

@media (max-width: 767px) {
  .candidate-overview {
    padding: 1.1rem 0.8rem 0.9rem;
  }
  .overview-head,
  .overview-toolbar,
  .overview-batch-bar {
    align-items: flex-start;
    flex-direction: column;
  }
  .overview-summary {
    align-self: flex-start;
  }
  .overview-actions,
  .filter-tabs {
    width: 100%;
  }
  .overview-action,
  .filter-tabs button {
    flex: 1;
  }
  .contact-sheet {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.55rem;
  }
  .tile-copy {
    min-height: 4.75rem;
    padding-inline: 0.55rem;
  }
  .overview-batch-actions {
    width: 100%;
  }
  .batch-secondary,
  .batch-primary {
    flex: 1;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .candidate-tile,
  .filter-tabs button,
  .overview-action {
    transition: none;
  }
}
</style>
