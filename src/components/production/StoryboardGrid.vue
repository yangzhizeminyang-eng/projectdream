<script setup lang="ts">
/** 分镜选择带：用紧凑缩略图快速切换镜头，详细生产字段进入下方生产卡。 */
import { computed } from 'vue'
import type { ShotSummary } from '@/api/production-studio'

const props = defineProps<{
  shots: ShotSummary[]
  selectedShotId: number | null
}>()

const confirmedVisualCount = computed(() => props.shots.filter((shot) => shot.imageUrl || shot.videoUrl).length)
const blockedCount = computed(() => props.shots.filter((shot) => shot.blocked).length)

const emit = defineEmits<{
  (e: 'select', storyboardId: number): void
}>()
</script>

<template>
  <section class="board" aria-label="分镜故事板">
    <div class="board-head">
      <div>
        <span class="board-title">分镜故事板</span>
        <span class="board-subtitle">先选镜头，再按生产卡逐项完成</span>
      </div>
      <div class="board-count">
        <span class="font-mono">{{ shots.length }} 镜头</span>
        <span class="board-count-detail">
          画面 {{ confirmedVisualCount }}/{{ shots.length }}
          <template v-if="blockedCount"> · 阻塞 {{ blockedCount }}</template>
        </span>
      </div>
    </div>
    <div v-if="shots.length" class="board-strip">
      <button
        v-for="shot in shots"
        :key="shot.storyboardId"
        type="button"
        class="shot-cell"
        :class="{ 'shot-cell--active': shot.storyboardId === selectedShotId, 'shot-cell--blocked': shot.blocked }"
        @click="emit('select', shot.storyboardId)"
      >
        <div class="shot-thumb">
          <img v-if="shot.videoUrl" :src="shot.videoUrl" :alt="`镜头 ${shot.shotNo} 视频`" loading="lazy" />
          <img v-else-if="shot.imageUrl" :src="shot.imageUrl" :alt="`镜头 ${shot.shotNo}`" loading="lazy" />
          <span v-else class="shot-empty">
            <span class="material-symbols-outlined" aria-hidden="true">image</span>
            尚未生成静帧
          </span>
          <span class="shot-duration font-mono">{{ shot.durationSeconds ? shot.durationSeconds + 's' : '—' }}</span>
          <span v-if="shot.blocked" class="shot-blocked">阻塞</span>
        </div>
        <div class="shot-info">
          <span class="shot-no font-mono" title="Scene / Shot">
            {{ String(shot.sceneNo).padStart(2, '0') }} / {{ String(shot.shotNo).padStart(2, '0') }}
          </span>
          <div class="shot-badges">
            <span v-if="shot.hasDialogue" class="badge badge--dg" title="含对白">对白</span>
            <span v-if="shot.hasVoice" class="badge badge--vo" title="已有声音方向，不代表音频候选已确认">声音方向</span>
            <span v-if="shot.videoUrl" class="badge badge--vd" title="已确认视频">视频</span>
            <span v-if="shot.imageUrl" class="badge badge--im" title="已确认静帧">帧</span>
          </div>
          <span class="shot-mood" :title="shot.actingBeat || ''">{{ shot.mood || '情绪待接入' }}</span>
        </div>
      </button>
    </div>
    <p v-else class="empty-hint">当前场景暂无分镜（待接入）</p>
  </section>
</template>

<style scoped>
.board {
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
  background: #0f120f;
  padding: 1.2rem 1.35rem 1.45rem;
}
.board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.board-title {
  color: #a9a29a;
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.14em;
}
.board-subtitle {
  margin-left: 0.65rem;
  color: #6f6a62;
  font-size: 0.62rem;
}
.board-count {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  gap: 0.14rem;
  color: #8d857c;
  font-size: 0.66rem;
}
.board-count-detail {
  color: #6f6a62;
  font-size: 0.58rem;
}
.board-strip {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding: 0.15rem 0.05rem 0.6rem;
  scrollbar-width: thin;
}
.shot-cell {
  flex: 0 0 10.5rem;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: #141714;
  overflow: hidden;
  text-align: left;
  transition:
    border-color 150ms ease,
    transform 150ms ease,
    box-shadow 150ms ease;
}
.shot-cell:hover {
  border-color: rgba(255, 183, 125, 0.5);
  background: #181b17;
  transform: translateY(-1px);
}
.shot-cell:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 1px;
}
.shot-cell--active {
  border-color: rgba(255, 183, 125, 0.82);
  box-shadow: 0 0 0 1px rgba(255, 183, 125, 0.42) inset, 0 10px 26px rgba(0, 0, 0, 0.24);
}
.shot-cell--blocked .shot-no {
  color: #ff9d94;
}
.shot-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  width: 100%;
  background:
    linear-gradient(135deg, rgba(255, 183, 125, 0.035), transparent 46%),
    #0b0d0b;
  overflow: hidden;
}
.shot-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.shot-empty {
  display: flex;
  flex-direction: column;
  height: 100%;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  color: #6c6760;
  font-size: 0.62rem;
}
.shot-empty .material-symbols-outlined {
  color: #4f514b;
  font-size: 1.1rem;
}
.shot-duration {
  position: absolute;
  right: 0.35rem;
  bottom: 0.35rem;
  background: rgba(0, 0, 0, 0.62);
  padding: 0.05rem 0.35rem;
  color: #e7e0d6;
  font-size: 0.62rem;
}
.shot-blocked {
  position: absolute;
  top: 0.35rem;
  left: 0.35rem;
  background: rgba(202, 84, 74, 0.85);
  padding: 0.05rem 0.4rem;
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
}
.shot-info {
  display: flex;
  min-height: 5rem;
  flex-direction: column;
  gap: 0.25rem;
  border-top: 1px solid #242524;
  padding: 0.65rem 0.7rem 0.7rem;
}
.shot-no {
  color: #ffb77d;
  font-size: 0.7rem;
  font-weight: 700;
}
.shot-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.badge {
  padding: 0.02rem 0.32rem;
  font-size: 0.56rem;
  font-weight: 700;
}
.badge--dg {
  color: #e6c18c;
  background: rgba(230, 193, 140, 0.12);
}
.badge--vo {
  color: #96ccff;
  background: rgba(150, 204, 255, 0.1);
}
.badge--vd {
  color: #83b68c;
  background: rgba(131, 182, 140, 0.12);
}
.badge--im {
  color: #ffb77d;
  background: rgba(255, 183, 125, 0.1);
}
.shot-mood {
  color: #8d857c;
  font-size: 0.62rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-hint {
  color: #837c73;
  font-size: 0.78rem;
  padding: 0.6rem 0;
}

@media (max-width: 767px) {
  .board {
    padding: 1rem 0.8rem 1.2rem;
  }

  .board-strip {
    margin-right: -0.8rem;
    padding-right: 0.8rem;
  }

  .shot-cell {
    flex-basis: 9.4rem;
  }

  .board-subtitle {
    display: block;
    margin: 0.25rem 0 0;
  }
}
</style>
