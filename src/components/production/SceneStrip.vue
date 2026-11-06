<script setup lang="ts">
/** 片段导航：每个可拍摄场次作为一个片段，横向展示时长、镜头数与阻塞状态。 */
import type { SceneSummary } from '@/api/production-studio'

defineProps<{
  scenes: SceneSummary[]
  selectedSceneId: number | null
}>()

const emit = defineEmits<{
  (e: 'select', sceneId: number): void
}>()
</script>

<template>
  <section class="scene-strip" aria-label="本集片段">
    <div class="strip-label">本集片段</div>
    <div class="strip-scroll no-scrollbar">
      <button
        v-for="scene in scenes"
        :key="scene.id"
        type="button"
        class="scene-cell"
        :class="{ 'scene-cell--active': scene.id === selectedSceneId, 'scene-cell--blocked': scene.blocked }"
        @click="emit('select', scene.id)"
      >
        <span class="scene-no font-mono">片段 {{ String(scene.sceneNo).padStart(2, '0') }}</span>
        <span class="scene-title">{{ scene.title || scene.location || '未命名片段' }}</span>
        <span class="scene-meta">
          <span class="font-mono">{{ scene.estimatedDuration ? scene.estimatedDuration + 's' : '—' }}</span>
          <span class="dot" aria-hidden="true"></span>
          <span class="font-mono">{{ scene.shotCount }} 镜头</span>
        </span>
        <span v-if="scene.blocked" class="scene-blocked" title="存在阻塞镜头">阻塞</span>
      </button>
      <p v-if="scenes.length === 0" class="empty-hint">本集暂无片段。先完成剧本拆分，再生成分镜。</p>
    </div>
  </section>
</template>

<style scoped>
.scene-strip {
  background: #101310;
  border-bottom: 1px solid rgba(255, 183, 125, 0.14);
  padding: 1rem 1.35rem 1.15rem;
}
.strip-label {
  color: #a9a29a;
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  margin-bottom: 0.7rem;
}
.strip-scroll {
  display: flex;
  gap: 0.75rem;
  overflow-x: auto;
  padding: 0.1rem 0.05rem 0.45rem;
}
.scene-cell {
  position: relative;
  display: flex;
  min-width: 13rem;
  min-height: 5.8rem;
  flex-direction: column;
  gap: 0.34rem;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background: #151815;
  padding: 0.82rem 0.85rem 0.75rem;
  text-align: left;
  transition:
    border-color 150ms ease,
    background-color 150ms ease,
    transform 150ms ease;
}
.scene-cell:hover {
  border-color: rgba(255, 183, 125, 0.46);
  background: #191b17;
  transform: translateY(-1px);
}
.scene-cell:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 1px;
}
.scene-cell--active {
  border-color: rgba(255, 183, 125, 0.68);
  background: #1b1c17;
  box-shadow: inset 0 0 0 1px rgba(255, 183, 125, 0.08), 0 8px 24px rgba(0, 0, 0, 0.14);
}
.scene-cell--active::before {
  position: absolute;
  top: -1px;
  right: 0.85rem;
  left: 0.85rem;
  height: 2px;
  background: #ffb77d;
  content: '';
}
.scene-cell--blocked .scene-no {
  color: #ff9d94;
}
.scene-no {
  color: #ffb77d;
  font-size: 0.72rem;
  font-weight: 700;
}
.scene-title {
  color: #e7e0d6;
  font-size: 0.8rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-meta {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  color: #8d857c;
  font-size: 0.62rem;
}
.scene-meta .dot {
  width: 0.28rem;
  height: 0.28rem;
  border-radius: 999px;
  background: #55524b;
}
.scene-blocked {
  color: #ff9d94;
  font-size: 0.6rem;
  font-weight: 700;
}
.empty-hint {
  color: #837c73;
  font-size: 0.76rem;
  padding: 0.5rem 0;
}

@media (max-width: 767px) {
  .scene-strip {
    padding-inline: 0.8rem;
  }
}
</style>
