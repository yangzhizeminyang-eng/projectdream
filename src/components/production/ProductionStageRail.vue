<script setup lang="ts">
/** 左侧制作阶段栏：将真实生产阶段收敛为 3 个用户可理解的主阶段。 */
import { computed, ref } from 'vue'
import { groupStageSummary, type StageSummary } from '@/api/production-studio'

const props = defineProps<{
  stages: StageSummary[]
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'open-stage', stageKey: string): void
}>()

const collapsed = ref(false)
const activeKey = ref<string | null>(null)

const groupedStages = computed(() => groupStageSummary(props.stages))

const doneCount = computed(() => groupedStages.value.filter((stage) => stage.status === 'completed').length)
const blockedCount = computed(() => groupedStages.value.reduce((total, stage) => total + stage.blockedCount, 0))
const currentStage = computed(() => groupedStages.value.find((stage) => stage.current) || groupedStages.value.find((stage) => stage.status === 'in-progress'))

function statusLabel(status: string): string {
  if (status === 'completed') return '已完成'
  if (status === 'in-progress') return '进行中'
  if (status === 'waiting-approval') return '等待确认'
  if (status === 'blocked') return '被阻塞'
  if (status === 'rework') return '需返工'
  return '未开始'
}

function toggle() {
  collapsed.value = !collapsed.value
  emit('toggle')
}
</script>

<template>
  <aside
    class="stage-rail flex shrink-0 flex-col border-r border-outline-variant bg-surface-container-lowest"
    :class="collapsed ? 'stage-rail--collapsed' : ''"
  >
    <div class="stage-rail-head">
      <div class="stage-rail-head-copy" :class="{ 'stage-rail-head-copy--hidden': collapsed }">
        <span class="stage-rail-title">制作路径</span>
        <span class="stage-rail-subtitle">按顺序完成一集</span>
      </div>
      <button type="button" class="stage-rail-collapse" :aria-expanded="!collapsed" aria-label="折叠阶段栏" @click="toggle">
        <span class="material-symbols-outlined">chevron_left</span>
      </button>
    </div>

    <div v-if="collapsed" class="stage-rail-compact" aria-hidden="true">
      <span class="stage-rail-compact-line"></span>
      <span
        v-for="s in groupedStages"
        :key="`compact-${s.key}`"
        class="stage-rail-compact-step"
        :class="[`is-${s.status}`, { 'is-current': s.current }]"
      >
        <span class="stage-rail-compact-dot"></span>
      </span>
    </div>

    <div class="stage-rail-content" :class="{ 'stage-rail-content--collapsed': collapsed }">
      <nav class="stage-rail-list">
        <button
          v-for="(s, index) in groupedStages"
          :key="s.key"
          type="button"
          class="stage-item"
          :class="[{ 'stage-item--active': s.current || activeKey === s.key }, s.status === 'blocked' ? 'stage-item--blocked' : '']"
          :aria-current="s.current ? 'step' : undefined"
          @click="activeKey = s.key; emit('open-stage', s.key)"
        >
          <span class="stage-item-marker" :class="s.status">
            <span class="stage-item-no font-mono">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="stage-item-dot" aria-hidden="true"></span>
          </span>
          <span class="stage-item-copy">
            <strong class="stage-item-label">{{ s.label }}</strong>
            <small>{{ statusLabel(s.status) }}</small>
          </span>
          <span v-if="s.blockedCount > 0" class="stage-item-blocked" :title="`${s.blockedCount} 个阻塞`">{{ s.blockedCount }}</span>
        </button>
      </nav>

      <div class="stage-rail-note">
        <div class="stage-rail-current">
          <span class="stage-rail-note-label">当前工作</span>
          <strong>{{ currentStage?.label || '尚未开始' }}</strong>
          <span>{{ currentStage ? statusLabel(currentStage.status) : '等待生产运行' }}</span>
        </div>
        <div class="stage-rail-summary">
          <span><b>{{ doneCount }}/{{ groupedStages.length }}</b> 阶段完成</span>
          <span v-if="blockedCount"><b class="is-danger">{{ blockedCount }}</b> 个阶段阻塞</span>
          <span v-else>暂无阻塞</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.stage-rail {
  box-sizing: border-box;
  width: 13rem;
  flex: 0 0 13rem;
  align-self: flex-start;
  overflow: hidden;
  background: #101310;
  transition:
    width 260ms cubic-bezier(0.22, 1, 0.36, 1),
    flex-basis 260ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 180ms ease;
  will-change: width, flex-basis;
}
.stage-rail--collapsed {
  width: 3.25rem;
  flex-basis: 3.25rem;
  align-self: stretch;
}
.stage-rail-head {
  display: flex;
  box-sizing: border-box;
  min-height: 4.1rem;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(255, 183, 125, 0.18);
  padding: 0.8rem 0.8rem 0.75rem 0.9rem;
  transition:
    padding 220ms ease,
    justify-content 220ms ease;
}
.stage-rail--collapsed .stage-rail-head {
  justify-content: center;
  padding-inline: 0.45rem;
}
.stage-rail-head-copy {
  min-width: 0;
  max-width: 10rem;
  overflow: hidden;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-width 220ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 150ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.stage-rail-head-copy--hidden {
  max-width: 0;
  opacity: 0;
  transform: translateX(-0.5rem);
  pointer-events: none;
}
.stage-rail-title {
  display: block;
  white-space: nowrap;
  color: #e7e0d6;
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.stage-rail-subtitle {
  display: block;
  margin-top: 0.18rem;
  color: #837c73;
  font-size: 0.58rem;
}
.stage-rail-collapse {
  display: inline-flex;
  width: 1.9rem;
  height: 1.9rem;
  flex: 0 0 1.9rem;
  align-items: center;
  justify-content: center;
  color: #a9a29a;
  line-height: 1;
  transition:
    transform 240ms cubic-bezier(0.22, 1, 0.36, 1),
    color 160ms ease,
    background-color 160ms ease;
}
.stage-rail-collapse:hover {
  background: rgba(255, 183, 125, 0.08);
  color: #ffd9b0;
}
.stage-rail--collapsed .stage-rail-collapse .material-symbols-outlined {
  transform: rotate(180deg);
}
.stage-rail-content {
  display: flex;
  min-width: 0;
  max-height: 38rem;
  flex-direction: column;
  overflow: hidden;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-height 260ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 150ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.stage-rail-content--collapsed {
  max-height: 0;
  visibility: hidden;
  opacity: 0;
  transform: translateX(-0.65rem);
  pointer-events: none;
}
.stage-rail-compact {
  position: relative;
  display: none;
  min-height: 12rem;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 1.8rem;
  padding: 1.35rem 0 1.5rem;
}
.stage-rail--collapsed .stage-rail-compact {
  display: flex;
}
.stage-rail-compact-line {
  position: absolute;
  top: 1.55rem;
  bottom: 1.7rem;
  left: 50%;
  width: 1px;
  background: linear-gradient(to bottom, transparent, rgba(255, 183, 125, 0.3) 12%, rgba(255, 183, 125, 0.3) 88%, transparent);
  transform: translateX(-50%);
}
.stage-rail-compact-step {
  position: relative;
  z-index: 1;
  display: inline-flex;
  width: 1rem;
  height: 1rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: #101310;
}
.stage-rail-compact-dot {
  width: 0.32rem;
  height: 0.32rem;
  border-radius: 50%;
  background: #5c5953;
}
.stage-rail-compact-step.is-completed {
  border-color: rgba(131, 182, 140, 0.55);
}
.stage-rail-compact-step.is-completed .stage-rail-compact-dot {
  background: #83b68c;
}
.stage-rail-compact-step.is-in-progress,
.stage-rail-compact-step.is-waiting-approval,
.stage-rail-compact-step.is-current {
  border-color: rgba(255, 183, 125, 0.72);
}
.stage-rail-compact-step.is-in-progress .stage-rail-compact-dot,
.stage-rail-compact-step.is-waiting-approval .stage-rail-compact-dot,
.stage-rail-compact-step.is-current .stage-rail-compact-dot {
  background: #ffb77d;
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.12);
}
.stage-rail-compact-step.is-blocked,
.stage-rail-compact-step.is-rework {
  border-color: rgba(190, 112, 104, 0.62);
}
.stage-rail-compact-step.is-blocked .stage-rail-compact-dot,
.stage-rail-compact-step.is-rework .stage-rail-compact-dot {
  background: #be7068;
}
.stage-rail-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.75rem 0.55rem;
}
.stage-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 3.1rem;
  border: 1px solid transparent;
  padding: 0.35rem 0.5rem;
  color: #cfc8be;
  font-size: 0.76rem;
  font-weight: 600;
  text-align: left;
  background: transparent;
  transition:
    border-color 160ms ease,
    background-color 160ms ease;
}
.stage-item:hover {
  background: rgba(255, 183, 125, 0.06);
  color: #fff;
}
.stage-item:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 1px;
}
.stage-item--active {
  border-color: rgba(255, 183, 125, 0.42);
  background: rgba(255, 183, 125, 0.12);
  color: #ffd9b0;
}
.stage-item--blocked .stage-item-label {
  color: #ff9d94;
}
.stage-item-marker {
  display: flex;
  width: 1.3rem;
  flex: 0 0 1.3rem;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
}
.stage-item-no {
  color: #8d857c;
  font-size: 0.58rem;
}
.stage-item--active .stage-item-no {
  color: #ffb77d;
}
.stage-item-marker .stage-item-dot {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 50%;
  background: #5c5953;
}
.stage-item-marker.completed .stage-item-dot {
  background: #83b68c;
}
.stage-item-marker.in-progress .stage-item-dot,
.stage-item-marker.waiting-approval .stage-item-dot {
  background: #ffb77d;
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.12);
}
.stage-item-marker.blocked .stage-item-dot,
.stage-item-marker.rework .stage-item-dot {
  background: #be7068;
}
.stage-item-label {
  display: block;
  white-space: nowrap;
}
.stage-item-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.18rem;
}
.stage-item-copy small {
  color: #837c73;
  font-size: 0.58rem;
}
.stage-item--active .stage-item-copy small {
  color: #d8b06a;
}
.stage-item-blocked {
  display: inline-flex;
  min-width: 1.1rem;
  height: 1.1rem;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(202, 84, 74, 0.18);
  color: #ff9d94;
  font-size: 0.6rem;
  font-weight: 800;
}
.stage-rail-note {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  margin-top: 0.45rem;
  border-top: 1px solid rgba(255, 183, 125, 0.14);
  padding: 0.8rem 0.85rem 1rem;
}
.stage-rail-current {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  border: 1px solid rgba(255, 183, 125, 0.18);
  background: #151915;
  padding: 0.65rem;
}
.stage-rail-note-label {
  color: #ffb77d;
  font-size: 0.55rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.stage-rail-current strong {
  color: #e7e0d6;
  font-size: 0.72rem;
}
.stage-rail-current span:last-child {
  color: #8d857c;
  font-size: 0.6rem;
}
.stage-rail-summary {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: #837c73;
  font-size: 0.6rem;
}
.stage-rail-summary b {
  color: #e7e0d6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.stage-rail-summary b.is-danger {
  color: #ff9d94;
}

@media (prefers-reduced-motion: reduce) {
  .stage-rail,
  .stage-rail-head,
  .stage-rail-head-copy,
  .stage-rail-collapse,
  .stage-rail-content {
    transition: none;
  }
}
</style>
