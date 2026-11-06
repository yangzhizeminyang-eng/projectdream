<script setup lang="ts">
/** 单集生产视图头部：集信息 + 目标时长 + 完成比例 + 质量状态 + 下一步。 */
import { computed } from 'vue'
import type { ProductionContext } from '@/api/production-studio'
import type { FinalEditDTO, ProductionReadinessDTO } from '@/api/project'

const props = defineProps<{
  context: ProductionContext
  readiness: ProductionReadinessDTO | null
  finalEdit: FinalEditDTO | null
  completionPercent: number | null
  selectedShotLabel?: string | null
  nextActionLabel?: string | null
  nextActionDescription?: string | null
}>()

const emit = defineEmits<{ (e: 'next'): void }>()

const nextActionLabel = computed(() => {
  if (props.nextActionLabel) return props.nextActionLabel
  if (props.readiness?.actionQueue?.length) {
    return props.readiness.actionQueue[0]?.label || props.readiness.actionQueue[0]?.message || '处理下一个阻塞'
  }
  if (props.context.runStatus === 'running') {
    return props.selectedShotLabel ? `继续处理 ${props.selectedShotLabel}` : '继续当前生产'
  }
  if (!props.context.run) return '启动 / 选择 ProductionRun'
  return '进入生产运行'
})

const nextActionDescription = computed(() => {
  if (props.nextActionDescription) return props.nextActionDescription
  if (props.readiness?.actionQueue?.length) return props.readiness.actionQueue[0]?.message || '处理当前生产中最重要的阻塞项。'
  return '按当前镜头的生产顺序继续。'
})

const qualityStatusLabel = computed(() => {
  if (props.readiness?.status === 'ready-for-controlled-publish') return '可受控发布'
  if (props.readiness?.status === 'stable-revenue-evidence-ready') return '稳定收入证据就绪'
  if (props.readiness?.blockers?.length) return `被阻塞（${props.readiness.blockers.length}）`
  return '待接入'
})

const episodeLabel = computed(() => {
  if (!props.context.episodeNo) return '未选择单集'
  return `第 ${props.context.episodeNo} 集${props.context.episodeTitle ? ` · ${props.context.episodeTitle}` : ''}`
})

function fmt(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}` : `${s}s`
}
</script>

<template>
  <section class="heading-block">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div class="min-w-0">
        <div class="text-[10px] font-bold uppercase tracking-[0.2em] text-secondary">单集生产视图</div>
        <h1 class="mt-1 font-display-lg text-lg leading-tight text-primary">
          {{ episodeLabel }}
        </h1>
        <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-on-surface-variant">
          <span>目标时长 {{ fmt(context.targetDuration) }}</span>
          <span>当前完成 {{ completionPercent === null ? '待接入' : completionPercent + '%' }}</span>
          <span class="flex items-center gap-1">
            全局质量 <span class="font-semibold" :class="qualityStatusLabel.startsWith('被阻塞') ? 'text-danger-red' : 'text-primary'">{{ qualityStatusLabel }}</span>
          </span>
        </div>
      </div>
      <button type="button" class="next-btn" :title="nextActionDescription" @click="emit('next')">
        <span class="material-symbols-outlined">flag</span>
        {{ nextActionLabel }}
        <span class="material-symbols-outlined text-sm">arrow_forward</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.heading-block {
  position: relative;
  border-bottom: 1px solid rgba(255, 183, 125, 0.16);
  background: #111411;
  padding: 1.25rem 1.35rem 1.2rem;
}
.heading-block::after {
  position: absolute;
  right: 1.35rem;
  bottom: -1px;
  left: 1.35rem;
  height: 1px;
  background: rgba(255, 183, 125, 0.08);
  content: '';
}
.heading-block h1 {
  font-size: 1.25rem;
  letter-spacing: 0.01em;
}
.next-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.65rem;
  border: 1px solid rgba(255, 183, 125, 0.55);
  background: rgba(217, 119, 7, 0.14);
  padding: 0 1rem;
  color: #ffd9b0;
  font-size: 0.78rem;
  font-weight: 700;
  transition:
    background-color 160ms ease,
    border-color 160ms ease;
}
.next-btn:hover {
  border-color: #ffb77d;
  background: rgba(255, 183, 125, 0.22);
}
.next-btn:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.next-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 767px) {
  .heading-block {
    padding: 1rem 0.8rem 1.05rem;
  }

  .heading-block::after {
    right: 0.8rem;
    left: 0.8rem;
  }
}
</style>
