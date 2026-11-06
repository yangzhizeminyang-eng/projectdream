<script setup lang="ts">
/** 右侧 Inspector：连续性契约 + 声音锁定 + 质量门禁 + 资产/Agent（真实部分实数据，缺口标待接入）。 */
import { computed } from 'vue'
import type { ShotProductionDetail } from '@/api/production-studio'

const props = defineProps<{
  detail: ShotProductionDetail | null
  shotLabel?: string | null
}>()

const activeLen = computed(
  () => props.detail?.quality.filter((q) => q.passed === true).length ?? 0,
)

function cue(url: string | null | undefined): string {
  return url ? '有帧' : '未接入'
}
</script>

<template>
  <aside class="inspector flex flex-col border-l border-outline-variant bg-surface-container-lowest">
    <div class="inspector-head">
      <div>
        <span class="inspector-title">生产证据</span>
        <span class="inspector-shot">跟随当前镜头实时读取</span>
      </div>
      <span class="inspector-meta">只读</span>
    </div>

    <div class="inspector-scroll no-scrollbar">
      <template v-if="detail">
        <section class="diagnosis-summary">
          <div class="diagnosis-summary-top">
            <span class="diagnosis-kicker">当前判断</span>
            <span class="diagnosis-state" :class="detail.blockingItems.length ? 'is-blocked' : 'is-clear'">
              {{ detail.blockingItems.length ? `${detail.blockingItems.length} 项待处理` : '没有阻塞' }}
            </span>
          </div>
          <div class="diagnosis-summary-label">下一步</div>
          <strong>{{ detail.nextAction.label }}</strong>
          <p>{{ detail.nextAction.description }}</p>
        </section>

        <section v-if="detail.blockingItems.length" class="section blocker-section">
          <div class="section-heading">
            <div>
              <span class="section-eyebrow">需要处理</span>
              <h3 class="section-title">先处理这些</h3>
            </div>
            <span class="section-count font-mono">{{ String(detail.blockingItems.length).padStart(2, '0') }}</span>
          </div>
          <div v-for="item in detail.blockingItems" :key="item.key" class="blocker-row">
            <span class="blocker-mark">
              <span class="material-symbols-outlined text-sm">{{ item.severity === 'blocking' ? 'error' : 'warning' }}</span>
            </span>
            <span>
              <strong>{{ item.label }}</strong>
              <small>{{ item.detail }}</small>
            </span>
          </div>
        </section>

        <details class="evidence-section" open>
          <summary>
            <span>连续性证据</span>
            <b :class="detail.continuity.hasPrevEndFrame && detail.continuity.currentStartFrame && detail.continuity.currentEndFrame ? 'ok' : 'warn'">
              {{ detail.continuity.hasPrevEndFrame && detail.continuity.currentStartFrame && detail.continuity.currentEndFrame ? '已闭合' : '未闭合' }}
            </b>
          </summary>
          <div class="evidence-grid evidence-grid--continuity">
            <div class="evidence-item"><span>上一镜尾帧</span><strong>{{ detail.continuity.hasPrevEndFrame ? '已继承' : '未接入' }}</strong></div>
            <div class="evidence-item"><span>本镜首帧</span><strong>{{ cue(detail.continuity.currentStartFrame) }}</strong></div>
            <div class="evidence-item"><span>本镜尾帧</span><strong>{{ cue(detail.continuity.currentEndFrame) }}</strong></div>
          </div>
          <p v-if="detail.continuity.suppliesNote" class="note">{{ detail.continuity.suppliesNote }}</p>
        </details>

        <details class="evidence-section">
          <summary>
            <span>声音锁定</span>
            <b :class="detail.voice.locked ? 'ok' : 'warn'">{{ detail.voice.locked ? '已锁定' : '未锁定' }}</b>
          </summary>
          <div class="evidence-grid evidence-grid--two">
            <div class="evidence-item"><span>角色</span><strong>{{ detail.voice.characterName || '—' }}</strong></div>
            <div class="evidence-item"><span>音色</span><strong>{{ detail.voice.voiceName || '—' }}</strong></div>
            <div class="evidence-item"><span>语言</span><strong>{{ detail.voice.languageType || '—' }}</strong></div>
            <div class="evidence-item"><span>角色版本</span><strong class="font-mono">v{{ detail.voice.characterVersionNo ?? '—' }}</strong></div>
          </div>
        </details>

        <details class="evidence-section">
          <summary>
            <span>质量门禁</span>
            <b :class="activeLen === detail.quality.length ? 'ok' : 'warn'">{{ activeLen }}/{{ detail.quality.length }}</b>
          </summary>
          <div class="quality-list">
            <div v-for="g in detail.quality" :key="g.label" class="quality-row">
              <span :class="g.passed === true ? 'quality-dot ok' : g.passed === false ? 'quality-dot warn' : 'quality-dot'"></span>
              <span>{{ g.label }}</span>
              <strong :class="g.passed === true ? 'ok' : g.passed === false ? 'warn' : ''">
                {{ g.passed === true ? '通过' : g.passed === false ? '未达' : '待接入' }}
              </strong>
            </div>
          </div>
        </details>

        <section class="asset-proof">
          <div class="section-heading">
            <div>
              <span class="section-eyebrow">版本来源</span>
              <h3 class="section-title">资产快照</h3>
            </div>
            <span class="section-count font-mono">AUDIT</span>
          </div>
          <div class="asset-proof-row"><span>角色生产基线</span><strong class="font-mono">{{ detail.roleVersion ? `v${detail.roleVersion}` : '未接入' }}</strong></div>
          <div class="asset-proof-row"><span>当前音频版本</span><strong class="font-mono">{{ detail.currentAudio ? `v${detail.currentAudio.versionNo}` : '未确认' }}</strong></div>
          <div class="asset-proof-row"><span>Agent 执行</span><strong>仅展示 · 未接入</strong></div>
        </section>
      </template>

      <div v-else class="empty-state">
        <span class="material-symbols-outlined text-3xl text-on-surface-variant">select_all</span>
        <p>请在故事板中选择一个镜头查看生产卡与连续性详情。</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.inspector {
  width: 20rem;
  min-height: 0;
  color: #d9d1c6;
  --inspector-line: rgba(255, 255, 255, 0.09);
  --inspector-muted: #928b82;
  --inspector-soft: #b9b1a7;
  --inspector-strong: #f1e9de;
}
.inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 3.85rem;
  border-bottom: 1px solid var(--inspector-line);
  padding: 0.8rem 1.05rem 0.75rem;
}
.inspector-title {
  display: block;
  color: var(--inspector-strong);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.inspector-shot {
  display: block;
  margin-top: 0.15rem;
  color: var(--inspector-muted);
  font-size: 0.6rem;
}
.inspector-meta {
  border: 1px solid rgba(255, 255, 255, 0.14);
  padding: 0.3rem 0.45rem;
  color: #aaa197;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.55rem;
  letter-spacing: 0.04em;
}
.inspector-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0.85rem 1.05rem 1.4rem;
}
.diagnosis-summary {
  position: relative;
  margin-bottom: 1.25rem;
  border: 1px solid rgba(255, 183, 125, 0.28);
  border-radius: 0.2rem;
  background:
    linear-gradient(135deg, rgba(255, 183, 125, 0.13), rgba(255, 183, 125, 0.035)),
    #151814;
  padding: 0.85rem 0.9rem 0.95rem;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
}
.diagnosis-summary-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.diagnosis-kicker {
  color: #ffb77d;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.12em;
}
.diagnosis-summary-label {
  margin-top: 0.78rem;
  color: #a7a097;
  font-size: 0.57rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.diagnosis-state {
  color: #8d857c;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.58rem;
}
.diagnosis-state.is-blocked {
  color: #ff9d94;
}
.diagnosis-state.is-clear {
  color: #83c68c;
}
.diagnosis-summary strong {
  display: block;
  margin-top: 0.18rem;
  color: var(--inspector-strong);
  font-size: 0.86rem;
  line-height: 1.3;
}
.diagnosis-summary p {
  max-width: 34ch;
  margin-top: 0.38rem;
  color: #b8b0a5;
  font-size: 0.66rem;
  line-height: 1.55;
}
.blocker-section {
  margin-bottom: 0.55rem;
  border-bottom: 1px solid rgba(190, 112, 104, 0.3);
  padding-bottom: 1rem;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.section-eyebrow {
  display: block;
  margin-bottom: 0.22rem;
  color: #9b9388;
  font-size: 0.54rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.section-count {
  color: #8d857c;
  font-size: 0.62rem;
}
.blocker-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.6rem;
  margin-top: 0.72rem;
  color: #ff9d94;
}
.blocker-mark {
  display: inline-flex;
  width: 1.35rem;
  height: 1.35rem;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 157, 148, 0.25);
  background: rgba(202, 84, 74, 0.11);
  color: #ff9d94;
}
.blocker-row span:last-child {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.blocker-row strong {
  color: #f0d3cc;
  font-size: 0.69rem;
  line-height: 1.35;
}
.blocker-row small {
  color: #b69b94;
  font-size: 0.64rem;
  line-height: 1.5;
}
.section {
  margin-bottom: 1.1rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  color: var(--inspector-strong);
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.evidence-section {
  border-bottom: 1px solid var(--inspector-line);
  padding: 1rem 0;
}
.evidence-section > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 1.4rem;
  color: var(--inspector-strong);
  cursor: pointer;
  font-size: 0.72rem;
  font-weight: 800;
  list-style: none;
}
.evidence-section > summary::-webkit-details-marker {
  display: none;
}
.evidence-section > summary::after {
  margin-left: auto;
  color: #837c73;
  content: 'expand_more';
  font-family: 'Material Symbols Outlined';
  font-size: 1rem;
  transition: transform 180ms ease, color 180ms ease;
}
.evidence-section[open] > summary::after {
  transform: rotate(180deg);
  color: #b9a07e;
}
.evidence-section > summary b {
  margin-right: 0.55rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6rem;
  font-weight: 600;
}
.evidence-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
  margin-top: 0.8rem;
}
.evidence-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.evidence-grid--continuity .evidence-item:first-child {
  grid-column: 1 / -1;
}
.evidence-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 0.28rem;
  min-height: 3.15rem;
  border: 1px solid rgba(255, 255, 255, 0.065);
  background: rgba(255, 255, 255, 0.025);
  padding: 0.55rem 0.6rem;
}
.evidence-item span {
  color: var(--inspector-muted);
  font-size: 0.58rem;
}
.evidence-item strong {
  overflow-wrap: anywhere;
  color: #d4ccc1;
  font-size: 0.65rem;
  line-height: 1.35;
}
.quality-list {
  display: grid;
  gap: 0.05rem;
  margin-top: 0.8rem;
}
.quality-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.4rem;
  min-height: 2rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  color: #b2aaa0;
  font-size: 0.64rem;
}
.quality-row:last-child {
  border-bottom: 0;
}
.quality-row strong {
  color: #837c73;
  font-size: 0.58rem;
  font-weight: 600;
}
.quality-dot {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: #5c5953;
}
.quality-dot.ok {
  background: #83b68c;
}
.quality-dot.warn {
  background: #d6a65f;
}
.asset-proof {
  border-top: 1px solid var(--inspector-line);
  padding: 1.1rem 0 0.2rem;
}
.asset-proof-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  padding: 0.52rem 0;
  color: var(--inspector-muted);
  font-size: 0.65rem;
}
.asset-proof-row strong {
  max-width: 58%;
  color: #d1c9be;
  font-size: 0.63rem;
  font-weight: 600;
  text-align: right;
}
.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.28rem 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
  font-size: 0.7rem;
  color: #8d857c;
}
.row .v {
  color: #c7c0b6;
  text-align: right;
  white-space: normal;
  word-break: break-word;
}
.v.ok {
  color: #83c68c;
}
.v.warn {
  color: #d6a65f;
}
.v .src {
  display: block;
  color: #716b63;
  font-size: 0.58rem;
  font-style: normal;
}
.note {
  margin-top: 0.7rem;
  color: #aaa197;
  font-size: 0.66rem;
  line-height: 1.6;
}
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.7rem;
  min-height: 15rem;
  border: 1px dashed rgba(255, 255, 255, 0.1);
  padding: 1.5rem 1rem;
  text-align: center;
  color: #8d857c;
  font-size: 0.74rem;
  line-height: 1.5;
}

@media (max-width: 360px) {
  .inspector-scroll {
    padding-right: 0.8rem;
    padding-left: 0.8rem;
  }

  .evidence-grid--continuity {
    grid-template-columns: 1fr;
  }

  .evidence-grid--continuity .evidence-item:first-child {
    grid-column: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .evidence-section > summary::after {
    transition: none;
  }
}
</style>
