<script setup lang="ts">
/** 顶部上下文栏：始终呈现 项目 / 集 / 场景 / 镜头 / 制作状态。 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { ProductionContext } from '@/api/production-studio'
import type { ProductionReadinessDTO } from '@/api/project'

const props = defineProps<{
  context: ProductionContext
  sceneLabel?: string | null
  shotLabel?: string | null
  readiness: ProductionReadinessDTO | null
  sceneId?: number | null
  storyboardId?: number | null
}>()

const router = useRouter()

const runStatusLabel = computed(() => {
  const s = props.context.runStatus
  if (!s) return '未启动 ProductionRun'
  if (s === 'running') return '运行中'
  if (s === 'waiting_approval') return '等待确认'
  if (s === 'completed') return '已完成'
  if (s === 'planning') return '规划中'
  return s
})

const blockerCount = computed(() => props.readiness?.blockers?.length ?? 0)

const productionStatusLabel = computed(() => {
  if (props.context.runStatus === 'running') return '生产运行中'
  if (props.context.runStatus === 'waiting_approval') return '等待确认'
  if (props.context.runStatus === 'completed') return '生产运行已完成'
  if (props.context.runStatus === 'planning') return '生产计划中'
  if (blockerCount.value > 0) return `有 ${blockerCount.value} 项阻塞`
  return '尚未启动生产运行'
})

function openEdit() {
  const query: Record<string, string> = {
    projectId: String(props.context.projectId),
  }
  if (props.sceneId) query.sceneId = String(props.sceneId)
  if (props.storyboardId) query.storyboardId = String(props.storyboardId)
  router.push({
    path: '/workspace/edit',
    query,
  })
}

function goDashboard() {
  router.push({
    path: '/dashboard',
    query: { projectId: String(props.context.projectId) },
  })
}

</script>

<template>
  <header class="context-bar">
    <div class="context-main">
      <div class="context-project">
        <button type="button" class="context-return" @click="goDashboard">
          <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
          <span>项目总览</span>
        </button>
        <span class="context-project-mark material-symbols-outlined" aria-hidden="true">movie_filter</span>
        <div class="min-w-0">
          <div class="context-eyebrow">当前制作上下文</div>
          <strong>{{ context.projectName }}</strong>
          <span v-if="context.category">{{ context.category }}</span>
        </div>
      </div>

      <div class="context-location" aria-label="当前制作位置">
        <div class="context-location-item">
          <span>单集</span>
          <strong>
            {{ context.episodeNo ? `第 ${context.episodeNo} 集${context.episodeTitle ? ` · ${context.episodeTitle}` : ''}` : (context.episodeTitle || '未选择单集') }}
          </strong>
        </div>
        <span class="context-separator" aria-hidden="true">/</span>
        <div class="context-location-item">
          <span>场景</span>
          <strong>{{ sceneLabel || '—' }}</strong>
        </div>
        <span class="context-separator" aria-hidden="true">/</span>
        <div class="context-location-item">
          <span>镜头</span>
          <strong class="font-mono">{{ shotLabel || '—' }}</strong>
        </div>
      </div>
    </div>

    <div class="context-status">
      <span
        class="context-status-dot"
        :class="context.runStatus === 'running' ? 'is-live' : blockerCount > 0 ? 'is-blocked' : ''"
        aria-hidden="true"
      ></span>
      <div class="context-status-copy">
        <strong>{{ productionStatusLabel }}</strong>
        <span>{{ runStatusLabel }}<template v-if="context.runCurrentStage"> · {{ context.runCurrentStage }}</template></span>
      </div>
      <span class="context-blockers" :class="{ 'has-blockers': blockerCount > 0 }">
        {{ blockerCount }} 项阻塞
      </span>
      <button type="button" class="context-btn" @click="openEdit">
        <span class="material-symbols-outlined text-sm">movie_edit</span>
        高级剪辑
      </button>
    </div>
  </header>
</template>

<style scoped>
.context-bar {
  display: flex;
  min-height: 4.1rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid rgba(255, 183, 125, 0.18);
  background: #101310;
  padding: 0.7rem 1rem;
}
.context-main {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 1.4rem;
}
.context-project {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.65rem;
}
.context-project-mark {
  display: grid;
  flex: 0 0 2rem;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid rgba(255, 183, 125, 0.35);
  color: #ffb77d;
  font-size: 1rem;
  line-height: 1;
}
.context-project > .min-w-0 > strong,
.context-project > .min-w-0 > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.context-project > .context-project-mark {
  display: grid;
}
.context-return {
  display: inline-flex;
  flex: 0 0 auto;
  min-height: 2rem;
  align-items: center;
  gap: 0.32rem;
  border: 1px solid rgba(255, 183, 125, 0.22);
  padding: 0 0.55rem;
  color: #c9b9a8;
  font-size: 0.66rem;
  font-weight: 650;
  white-space: nowrap;
  transition:
    border-color 160ms ease,
    background-color 160ms ease,
    color 160ms ease;
}
.context-return .material-symbols-outlined {
  font-size: 0.95rem;
  line-height: 1;
}
.context-return:hover {
  border-color: rgba(255, 183, 125, 0.55);
  background: rgba(255, 183, 125, 0.08);
  color: #ffb77d;
}
.context-return:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.context-project strong {
  max-width: 17rem;
  color: #f1ece4;
  font-size: 0.82rem;
}
.context-project > .min-w-0 > span {
  max-width: 17rem;
  margin-top: 0.13rem;
  color: #8d857c;
  font-size: 0.63rem;
}
.context-eyebrow {
  margin-bottom: 0.18rem;
  color: #ffb77d !important;
  font-size: 0.54rem !important;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.context-location {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.7rem;
  border-left: 1px solid rgba(255, 183, 125, 0.22);
  padding-left: 1.1rem;
}
.context-location-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.14rem;
}
.context-location-item span {
  color: #8d857c;
  font-size: 0.58rem;
  font-weight: 700;
}
.context-location-item strong {
  max-width: 10rem;
  overflow: hidden;
  color: #e7e0d6;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.context-separator {
  color: #5e5a53;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
.context-status {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 0.6rem;
}
.context-status-dot {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 50%;
  background: #79736b;
}
.context-status-dot.is-live {
  background: #ffb77d;
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.12);
}
.context-status-dot.is-blocked {
  background: #c8776f;
}
.context-status-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.13rem;
}
.context-status-copy strong {
  color: #e7e0d6;
  font-size: 0.7rem;
}
.context-status-copy span {
  max-width: 14rem;
  overflow: hidden;
  color: #8d857c;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.context-blockers {
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 0.34rem 0.5rem;
  color: #969087;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.58rem;
  white-space: nowrap;
}
.context-blockers.has-blockers {
  border-color: rgba(190, 112, 104, 0.45);
  color: #ff9d94;
}
.context-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2rem;
  border: 1px solid rgba(255, 183, 125, 0.45);
  padding: 0 0.7rem;
  color: #e7e0d6;
  font-size: 0.72rem;
  font-weight: 700;
  background: rgba(255, 183, 125, 0.05);
  transition:
    background-color 160ms ease,
    border-color 160ms ease;
}
.context-btn:hover {
  background: rgba(255, 183, 125, 0.12);
  border-color: #ffb77d;
}
.context-btn:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 2px;
}
.context-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 1100px) {
  .context-bar {
    align-items: flex-start;
    flex-direction: column;
  }
  .context-status {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (max-width: 767px) {
  .context-bar {
    padding: 0.65rem 0.8rem;
  }
  .context-main {
    width: 100%;
    align-items: flex-start;
    flex-direction: column;
    gap: 0.6rem;
  }
  .context-location {
    width: 100%;
    padding-left: 0;
    border-left: 0;
    border-top: 1px solid rgba(255, 183, 125, 0.16);
    padding-top: 0.55rem;
  }
  .context-location-item {
    flex: 1;
  }
  .context-location-item strong {
    max-width: 100%;
  }
  .context-status {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .context-status-copy {
    flex: 1;
  }
  .context-btn {
    margin-left: auto;
  }
}
</style>
