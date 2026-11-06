<script setup lang="ts">
/**
 * @file 资产画布节点卡片
 * @description
 * 纯展示 + 事件上抛。位置与尺寸由父级的 slot 负责（拖动时要跟手），
 * 卡片本身只管「这张形象现在是什么状态」。
 *
 * 状态全部来自真实数据：没有图就是「待补充」，生成中只显示当前版本，
 * 有已采用的图才显示「已采用」。不存任何可以撒谎的标记。
 */
import { computed, ref, watch } from 'vue'
import type { AssetNodeDTO, AssetNodeImageDTO, AssetNodeType } from '@/api/project'
import {
  groupAssetNodeImages,
  hasCompleteSceneNineGrid,
  selectAssetPreviewImage,
  selectSceneNineGridImages,
} from '@/lib/asset-image-groups'

const props = defineProps<{
  /** 节点数据 */
  node: AssetNodeDTO
  /** 是否是当前选中节点 */
  selected: boolean
  /** 是否处于画布多选集合 */
  multiSelected?: boolean
  /** 是否正在生成形象 */
  generating: boolean
  /** 是否正在被拖动 */
  dragging: boolean
  /** 入场动画的错峰序号 */
  entranceIndex: number
}>()

const emit = defineEmits<{
  /** 选中该节点 */
  (event: 'select', node: AssetNodeDTO): void
  /** 开始拖动该节点 */
  (event: 'dragstart', payload: { node: AssetNodeDTO; event: PointerEvent }): void
  /** 采用场景全景候选 */
  (event: 'adopt-image', image: AssetNodeImageDTO): void
}>()

const imageFailed = ref(false)

const TYPE_LABELS: Record<AssetNodeType, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  material: '素材',
}

const typeLabel = computed(() => TYPE_LABELS[props.node.nodeType] || '节点')

const imageGroups = computed(() => groupAssetNodeImages(
  props.node.images,
  props.node.nodeType,
  props.node.confirmedImage,
))
const sceneNineGridImages = computed(() => selectSceneNineGridImages(props.node.images))
const sceneNineGridSlots = computed(() => Array.from({ length: 9 }, (_, index) =>
  sceneNineGridImages.value.find((image) => Number(image.viewIndex) === index + 1) || null,
))
const hasSceneNineGrid = computed(() => props.node.nodeType === 'scene' && hasCompleteSceneNineGrid(props.node.images))
const pendingScenePanorama = computed(() => {
  if (props.node.nodeType !== 'scene') return null
  return imageGroups.value.find((group) => group.key === 'single')?.latest || null
})
const canAdoptScenePanorama = computed(() => Boolean(
  pendingScenePanorama.value
    && pendingScenePanorama.value.status !== 'confirmed'
    && pendingScenePanorama.value.visionStatus === 'skipped'
    && (pendingScenePanorama.value.imageUrl || pendingScenePanorama.value.thumbnailUrl),
))

function displayedGroupImageCount(group: { key: string; images: unknown[] }): number {
  // The panorama is a separate source card; a scene nine-grid always means
  // the nine independent angle cells only.
  return group.key === 'scene-nine-grid' ? sceneNineGridImages.value.length : group.images.length
}

/** 角色卡片优先显示基础正面全身图，旧数据再回退到三视图。 */
const previewImage = computed(() =>
  selectAssetPreviewImage(imageGroups.value, props.node.nodeType)
  || props.node.confirmedImage
  || props.node.images[props.node.images.length - 1]
  || null,
)

const previewImageUrl = computed(() => previewImage.value?.imageUrl || previewImage.value?.thumbnailUrl || '')

const previewUrl = computed(
  () => previewImage.value
    && previewImage.value.status !== 'failed'
    && previewImage.value.visionStatus !== 'failed'
    ? previewImageUrl.value
    : '',
)

// 换了图要允许重新尝试加载，否则一次失败会永久卡在失败态
watch(previewUrl, () => {
  imageFailed.value = false
})

const statusText = computed(() => {
  if (props.generating) return '正在生成'
  if (props.node.state === 'confirmed') {
    const confirmedGroups = imageGroups.value.filter((group) => group.confirmed)
    return confirmedGroups.length > 1
      ? `已采用 · ${confirmedGroups.map((group) => group.label.replace('场景', '')).join('、')}`
      : '已采用'
  }
  if (props.node.state === 'ready') {
    const currentImageCount = imageGroups.value.reduce((total, group) => total + displayedGroupImageCount(group), 0)
    return `${imageGroups.value.length} 组结果 · ${currentImageCount} 张当前图`
  }
  return '待补充'
})

const statusTone = computed(() => {
  if (props.generating) return 'is-working'
  if (props.node.state === 'confirmed') return 'is-confirmed'
  if (props.node.state === 'ready') return 'is-ready'
  return 'is-pending'
})

const ariaLabel = computed(() => {
  const era = props.node.appearanceLabel ? `${props.node.appearanceLabel}，` : ''
  return `${typeLabel.value}节点 ${props.node.label}，${era}${statusText.value}`
})
</script>

<template>
  <article
    class="ac-node"
    :class="{
      'is-character': node.nodeType === 'character',
      'is-prop': node.nodeType === 'prop',
      'is-material': node.nodeType === 'material',
      'is-selected': selected,
      'is-multi-selected': multiSelected,
      'is-dragging': dragging,
      'is-empty': !previewUrl,
    }"
    :style="{ '--enter-index': entranceIndex }"
    role="button"
    tabindex="0"
    :aria-pressed="selected"
    :aria-label="ariaLabel"
    @click="emit('select', node)"
    @keydown.enter.prevent="emit('select', node)"
    @keydown.space.prevent="emit('select', node)"
    @pointerdown="emit('dragstart', { node, event: $event })"
  >
    <div class="ac-node__media">
      <div v-if="hasSceneNineGrid" class="ac-node__nine-grid" aria-label="场景九宫格九个独立视角">
        <div
          v-for="(image, index) in sceneNineGridSlots"
          :key="image?.id || `missing-${index}`"
          class="ac-node__nine-grid-cell"
        >
          <img
            v-if="image?.imageUrl || image?.thumbnailUrl"
            class="ac-node__nine-grid-image"
            :src="image.imageUrl || image.thumbnailUrl || ''"
            :alt="`${node.label} ${image.viewLabel || `视角 ${index + 1}`}`"
            draggable="false"
            loading="lazy"
          />
          <span v-else class="material-symbols-outlined" aria-hidden="true">image</span>
          <small>{{ image?.viewLabel || `视角 ${index + 1}` }}</small>
        </div>
      </div>
      <img
        v-else-if="previewUrl && !imageFailed"
        class="ac-node__image"
        :src="previewUrl"
        :alt="`${node.label} 的形象`"
        draggable="false"
        loading="lazy"
        @error="imageFailed = true"
      />

      <div v-else-if="imageFailed" class="ac-node__fallback">
        <span class="material-symbols-outlined" aria-hidden="true">broken_image</span>
        <span>图片加载失败</span>
      </div>

      <div v-else class="ac-node__placeholder">
        <span class="material-symbols-outlined" aria-hidden="true">add_photo_alternate</span>
        <span>还没有形象图</span>
      </div>

      <div v-if="generating" class="ac-node__working" role="status">
        <span class="ac-node__pulse" aria-hidden="true"></span>
        <span>正在生成</span>
      </div>

      <span v-else-if="node.state === 'confirmed'" class="ac-node__stamp">已采用</span>
      <button
        v-if="canAdoptScenePanorama"
        class="ac-node__adopt"
        type="button"
        @pointerdown.stop
        @click.stop="emit('adopt-image', pendingScenePanorama!)"
      >
        <span class="material-symbols-outlined" aria-hidden="true">check</span>
        采用全景基准
      </button>
      <div v-if="imageGroups.length" class="ac-node__viewsets">
        <span
          v-for="group in imageGroups"
          :key="group.key"
          class="ac-node__viewset"
          :class="{ 'is-confirmed': group.confirmed }"
        >
          {{ group.label.replace('场景', '') }}
          <strong>{{ displayedGroupImageCount(group) }}</strong>
        </span>
      </div>
    </div>

    <div class="ac-node__meta">
      <div class="ac-node__title-row">
        <h3 class="ac-node__name">{{ node.label }}</h3>
        <span class="ac-node__type">{{ typeLabel }}</span>
      </div>
      <p v-if="node.appearanceLabel" class="ac-node__era">{{ node.appearanceLabel }}</p>
      <p class="ac-node__status" :class="statusTone">{{ statusText }}</p>
    </div>
  </article>
</template>

<style scoped>
.ac-node {
  display: flex;
  height: 100%;
  width: 100%;
  flex-direction: column;
  border: 1px solid #554336;
  background: #1a1c1a;
  cursor: grab;
  /* 入场落位：唯一的编排时刻，从已可见的默认态缓出，不做弹跳 */
  animation: ac-node-land 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: calc(var(--enter-index, 0) * 26ms);
  transition:
    border-color 200ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 220ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.ac-node:hover {
  border-color: #a48454;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.34);
  transform: translateY(-2px);
}

.ac-node:focus-visible {
  outline: none;
  border-color: #ffb77d;
  box-shadow: 0 0 0 2px rgba(255, 183, 125, 0.45);
}

.ac-node.is-selected {
  border-color: #ffb77d;
  box-shadow:
    0 0 0 1px #ffb77d,
    0 14px 30px rgba(0, 0, 0, 0.42);
}

.ac-node.is-multi-selected {
  border-color: #8bc8b2;
  box-shadow: 0 0 0 2px rgba(139, 200, 178, 0.48), 0 12px 28px rgba(0, 0, 0, 0.34);
}

.ac-node.is-dragging {
  cursor: grabbing;
  border-color: #ffb77d;
  /* 拖动时用有偏移的真实阴影表示「被拎起来」，不是零偏移光晕 */
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.45);
  transform: scale(1.02);
}

.ac-node__media {
  position: relative;
  flex: 0 0 62%;
  height: 62%;
  max-height: 62%;
  min-height: 0;
  overflow: hidden;
  background: #0f100e;
}

.ac-node__image {
  height: 100%;
  width: 100%;
  object-fit: cover;
  user-select: none;
  -webkit-user-drag: none;
}

/* 角色和道具都是资产基准图，卡片预览不能用 cover 把头部、鞋子或道具边缘裁掉。 */
.ac-node.is-character .ac-node__image,
.ac-node.is-prop .ac-node__image,
.ac-node.is-material .ac-node__image {
  object-fit: contain;
  background: #fff;
}

.ac-node__nine-grid {
  display: grid;
  height: 100%;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  padding: 6px;
  background: #0a0b0a;
}

.ac-node__nine-grid-cell {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #171916;
}

.ac-node__nine-grid-image {
  height: 100%;
  width: 100%;
  object-fit: cover;
  user-select: none;
  -webkit-user-drag: none;
}

.ac-node__nine-grid-cell > span {
  display: grid;
  height: 100%;
  place-items: center;
  color: #6d5740;
  font-size: 0.8rem;
}

.ac-node__nine-grid-cell small {
  position: absolute;
  right: 2px;
  bottom: 2px;
  left: 2px;
  overflow: hidden;
  background: rgba(10, 11, 10, 0.76);
  padding: 1px 2px;
  color: #eee8df;
  font-size: 0.46rem;
  line-height: 1.2;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-node__placeholder,
.ac-node__fallback {
  display: flex;
  height: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  color: #8f877d;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
}

.ac-node__placeholder .material-symbols-outlined,
.ac-node__fallback .material-symbols-outlined {
  font-size: 1.5rem;
  color: #6d5740;
}

.ac-node__fallback {
  color: #d9a0a0;
}

.ac-node__fallback .material-symbols-outlined {
  color: #b06a6a;
}

/* 待补充的节点用内层虚线区分「这里还没有东西」，和已出图的实心卡片拉开层级 */
.ac-node.is-empty .ac-node__media::after {
  position: absolute;
  inset: 10px;
  border: 1px dashed rgba(164, 132, 84, 0.3);
  content: '';
  pointer-events: none;
}

.ac-node__working {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: rgba(13, 15, 13, 0.76);
  color: #ffb77d;
  font-size: 0.76rem;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.ac-node__pulse {
  height: 0.5rem;
  width: 0.5rem;
  background: #ffb77d;
  animation: ac-pulse 1.2s ease-in-out infinite;
}

.ac-node__stamp {
  position: absolute;
  top: 10px;
  left: 10px;
  border: 1px solid rgba(255, 183, 125, 0.5);
  background: rgba(13, 15, 13, 0.82);
  padding: 0.12rem 0.4rem;
  color: #ffb77d;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.ac-node__adopt {
  position: absolute;
  right: 0.55rem;
  bottom: 0.55rem;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 0.24rem;
  min-height: 1.8rem;
  border: 1px solid rgba(155, 191, 120, 0.58);
  background: rgba(13, 15, 13, 0.92);
  padding: 0.24rem 0.46rem;
  color: #b6d795;
  font-size: 0.62rem;
  font-weight: 700;
}

.ac-node__adopt:hover {
  border-color: #b6d795;
  background: rgba(155, 191, 120, 0.16);
}

.ac-node__adopt .material-symbols-outlined {
  font-size: 0.88rem;
}

.ac-node__viewsets {
  position: absolute;
  right: 0.45rem;
  bottom: 0.45rem;
  left: 0.45rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  pointer-events: none;
}

.ac-node__viewset {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  border: 1px solid rgba(164, 132, 84, 0.45);
  background: rgba(13, 15, 13, 0.86);
  padding: 0.14rem 0.32rem;
  color: #cfc6bb;
  font-size: 0.58rem;
  line-height: 1.2;
}

.ac-node__viewset strong {
  color: #e6c18c;
  font-variant-numeric: tabular-nums;
}

.ac-node__viewset.is-confirmed {
  border-color: rgba(155, 191, 120, 0.45);
  color: #9bbf78;
}

.ac-node__viewset.is-confirmed strong {
  color: #b6d795;
}

.ac-node__meta {
  position: relative;
  z-index: 2;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid rgba(164, 132, 84, 0.24);
  background: #1a1c1a;
  padding: 0.55rem 0.7rem 0.6rem;
}

.ac-node__title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.ac-node__title-row > * {
  min-width: 0;
  max-width: 100%;
}

.ac-node__name {
  min-width: 0;
  overflow: hidden;
  color: #e2e3df;
  font-size: 0.84rem;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-node__type {
  flex: 0 0 auto;
  color: #8f877d;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  white-space: nowrap;
}

.ac-node__era {
  max-width: 100%;
  margin-top: 0.2rem;
  overflow: hidden;
  color: #e6c18c;
  font-family: 'Noto Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.ac-node__status {
  max-width: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 0.3rem;
  color: #a38c7c;
  font-size: 0.68rem;
  letter-spacing: 0.03em;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.ac-node__status.is-pending {
  /* 待补充要在深底上读得清：用 primary 而不是更暗的 primary-container */
  color: #ffb77d;
}

.ac-node__status.is-ready {
  color: #e6c18c;
}

.ac-node__status.is-confirmed {
  color: #9bbf78;
}

.ac-node__status.is-working {
  color: #ffb77d;
}

@keyframes ac-node-land {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes ac-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.28;
  }
}

/* 全局减动效只把 animation-duration 压到 0.01ms，不会清掉 animation-delay，
   留着错峰延迟会让节点在「backwards」填充态里持续不可见。这里必须把动画整个关掉。 */
@media (prefers-reduced-motion: reduce) {
  .ac-node {
    animation: none !important;
  }
  .ac-node__pulse {
    animation: none !important;
  }
}
</style>
