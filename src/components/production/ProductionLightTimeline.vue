<script setup lang="ts">
/** 底部时间线预览：把真实 FinalEditDTO 转成可读的剪辑结构，只读，不伪造编辑能力。 */
import { computed, ref } from 'vue'
import type { FinalEditAudioClipDTO, FinalEditDTO, FinalEditSubtitleCueDTO, FinalEditVideoClipDTO } from '@/api/project'

const props = defineProps<{
  finalEdit: FinalEditDTO | null
  projectId: number
}>()

const emit = defineEmits<{ (e: 'openEdit'): void }>()

interface Clip {
  label: string
  sub: string
  start: number
  duration: number
  muted: boolean
  hasAsset: boolean
  tone: string
}

const playhead = ref(0)

function clip(
  label: string,
  duration: number | null | undefined,
  start: number,
  tone: string,
  sub = '',
  muted = false,
): Clip {
  const safeDuration = Math.max(0.25, Number(duration) || 0)
  return {
    label,
    sub: sub || `${safeDuration}s`,
    start: Math.max(0, start),
    duration: safeDuration,
    muted,
    hasAsset: !muted,
    tone,
  }
}

function videoClips(items: FinalEditVideoClipDTO[]): Clip[] {
  let cursor = 0
  return items.map((item) => {
    const result = clip(
      item.shotNo ? `镜头 ${item.shotNo}` : `镜头 ${item.storyboardId}`,
      item.durationSeconds,
      cursor,
      item.sourceType === 'static' ? 'tone-static' : 'tone-video',
      `${item.sourceType === 'static' ? '静帧回退' : '视频'} · ${item.durationSeconds}s`,
      item.enabled === false,
    )
    cursor += Number(item.durationSeconds) || 0
    return result
  })
}

function audioClips(items: FinalEditAudioClipDTO[], tone: string): Clip[] {
  return items.map((item) => clip(
    item.title || (item.shotNo ? `镜头 ${item.shotNo}` : `音频 ${item.id}`),
    item.durationSeconds,
    item.startOffsetSeconds || 0,
    tone,
    `${item.voiceName || item.trackType} · ${item.durationSeconds ?? '—'}s`,
  ))
}

function subtitleClips(items: FinalEditSubtitleCueDTO[], videoItems: FinalEditVideoClipDTO[]): Clip[] {
  const startByStoryboard = new Map<number, number>()
  let cursor = 0
  for (const item of videoItems) {
    startByStoryboard.set(item.storyboardId, cursor)
    cursor += Number(item.durationSeconds) || 0
  }
  return items.map((item) => clip(
    '字幕',
    item.durationSeconds,
    (startByStoryboard.get(item.storyboardId) || 0) + (item.startOffsetSeconds || 0),
    'tone-subtitle',
    item.text || '字幕',
    item.enabled === false,
  ))
}

function placeholder(label: string): Clip[] {
  return [clip(label, 0.25, 0, 'tone-empty', '', true)]
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

function percent(value: number, total: number): string {
  return `${Math.max(0, Math.min(100, (value / Math.max(total, 0.01)) * 100))}%`
}

function setPlayhead(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0
  playhead.value = Math.max(0, Math.min(totalSeconds.value, ratio * totalSeconds.value))
}

const ticks = computed(() => {
  const total = totalSeconds.value
  if (!total) return []
  const step = total <= 30 ? 5 : total <= 90 ? 10 : 15
  const values: number[] = []
  for (let value = 0; value <= total; value += step) values.push(value)
  if (values.at(-1) !== total) values.push(total)
  return values
})

const tracks = computed(() => {
  const fe = props.finalEdit
  if (!fe) return []
  const video = fe.videoTrack.items || []
  return [
    { key: 'V1', label: 'V1 画面', hint: `${fe.videoTrack.enabledCount}/${fe.videoTrack.totalCount} 启用`, clips: videoClips(video) },
    { key: 'dl', label: '对白', hint: `${fe.audioTracks.dialogue.length} 段`, clips: audioClips(fe.audioTracks.dialogue, 'tone-dialogue') },
    { key: 'nb', label: '旁白', hint: `${fe.audioTracks.narration.length} 段`, clips: audioClips(fe.audioTracks.narration, 'tone-narration') },
    { key: 'sfx', label: 'SFX', hint: `${fe.audioTracks.sfx.length} 段`, clips: audioClips(fe.audioTracks.sfx, 'tone-sfx') },
    { key: 'bgm', label: 'BGM', hint: `${fe.audioTracks.music.length} 段`, clips: audioClips(fe.audioTracks.music, 'tone-bgm') },
    { key: 'amb', label: '环境声', hint: '待接入', clips: placeholder('待接入') },
    { key: 'sub', label: '字幕', hint: `${fe.draft?.subtitleCues?.length || 0} 条`, clips: fe.draft?.subtitleCues?.length ? subtitleClips(fe.draft.subtitleCues, video) : placeholder('无字幕') },
  ]
})

const totalSeconds = computed(() => {
  const fe = props.finalEdit
  if (!fe) return 0

  const declared = Number(fe.videoTrack.totalDurationSeconds) || Number(fe.summary?.totalDurationSeconds) || 0
  const clipEnd = tracks.value.reduce((latest, track) => {
    const trackLatest = track.clips.reduce((end, item) => Math.max(end, item.start + item.duration), 0)
    return Math.max(latest, trackLatest)
  }, 0)

  return Math.max(declared, clipEnd)
})
const playheadLabel = computed(() => formatTime(playhead.value))
const activeTrackCount = computed(() => tracks.value.filter((track) => track.clips.some((item) => !item.muted)).length)
const subtitleCount = computed(() => props.finalEdit?.draft?.subtitleCues?.length || 0)
</script>

<template>
  <section class="timeline" aria-label="成片时间线预览">
    <div class="timeline-head">
      <div class="timeline-heading">
        <span class="timeline-kicker">剪辑预览</span>
        <div class="timeline-heading-line">
          <strong class="timeline-title">成片时间线</strong>
          <span class="timeline-mode">只读结构</span>
        </div>
        <span class="timeline-subtitle">点击轨道定位播放头 · 原始候选不会被覆盖</span>
      </div>
      <div class="timeline-head-side">
        <div class="timeline-stat-strip" aria-label="时间线轨道摘要">
          <span><b>{{ activeTrackCount }}</b> 条轨道</span>
          <span><b>{{ subtitleCount }}</b> 条字幕</span>
          <span><b>{{ formatTime(totalSeconds) }}</b> 时长</span>
        </div>
        <div class="timeline-readout">
          <span class="playhead-readout">{{ playheadLabel }}</span>
          <span>/ {{ formatTime(totalSeconds) }}</span>
        </div>
      </div>
      <div class="timeline-actions">
        <span class="timeline-cursor-note">
          <span class="timeline-cursor-dot"></span>
          播放头
        </span>
        <button type="button" class="timeline-goto" @click="emit('openEdit')">
          <span class="material-symbols-outlined text-sm">open_in_new</span>
          打开剪辑器
        </button>
      </div>
    </div>

    <div v-if="finalEdit" class="timeline-tracks">
      <div class="timeline-ruler">
        <span class="ruler-spacer"></span>
        <div class="ruler-lane">
          <span v-for="tick in ticks" :key="tick" class="ruler-tick" :style="{ left: percent(tick, totalSeconds) }">
            <b>{{ formatTime(tick) }}</b>
          </span>
        </div>
      </div>
      <div v-for="track in tracks" :key="track.key" class="track-row">
        <div class="track-label">
          <strong>{{ track.label }}</strong>
          <span>{{ track.hint }}</span>
        </div>
        <div class="track-lane" @click="setPlayhead">
          <div class="playhead" :style="{ left: percent(playhead, totalSeconds) }" aria-hidden="true"></div>
          <div
            v-for="(c, i) in track.clips"
            :key="track.key + '-' + i"
            class="track-clip"
            :class="[c.tone, { 'track-clip--muted': c.muted }]"
            :style="{ left: percent(c.start, totalSeconds), width: percent(c.duration, totalSeconds) }"
            :title="c.sub"
          >
            {{ c.label }}
          </div>
        </div>
      </div>
    </div>
    <p v-else class="timeline-empty">
      <span class="material-symbols-outlined text-base">timeline</span>
      时间线待接入（final-edit 接口不可用）
    </p>
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: #101211;
  padding: 0.78rem 1rem 0.72rem;
}
.timeline-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.7rem;
}
.timeline-heading {
  min-width: 15rem;
  flex: 1 1 15rem;
}
.timeline-kicker {
  display: block;
  margin-bottom: 0.2rem;
  color: #ffb77d;
  font-size: 0.52rem;
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.timeline-heading-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.timeline-title {
  color: #eee7dc;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.02em;
}
.timeline-mode {
  border: 1px solid rgba(255, 255, 255, 0.12);
  padding: 0.16rem 0.34rem;
  color: #989087;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.52rem;
}
.timeline-subtitle {
  display: block;
  margin-top: 0.25rem;
  color: #777168;
  font-size: 0.6rem;
}
.timeline-head-side {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-left: auto;
}
.timeline-stat-strip {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  color: #777168;
  font-size: 0.56rem;
}
.timeline-stat-strip span {
  padding-left: 0.65rem;
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.timeline-stat-strip span:first-child {
  padding-left: 0;
  border-left: 0;
}
.timeline-stat-strip b {
  color: #c7c0b6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.64rem;
  font-variant-numeric: tabular-nums;
}
.timeline-readout {
  display: inline-flex;
  align-items: baseline;
  gap: 0.3rem;
  margin-left: auto;
  color: #777168;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}
.playhead-readout {
  color: #ffd9b0;
  font-size: 0.84rem;
  font-weight: 700;
}
.timeline-actions {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin-left: auto;
}
.timeline-cursor-note {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  color: #9e968c;
  font-size: 0.58rem;
}
.timeline-cursor-dot {
  width: 0.42rem;
  height: 0.42rem;
  border-radius: 50%;
  background: #ffb77d;
  box-shadow: 0 0 0 3px rgba(255, 183, 125, 0.12);
}
.timeline-goto {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid rgba(255, 183, 125, 0.45);
  padding: 0.25rem 0.6rem;
  color: #ffd9b0;
  font-size: 0.7rem;
  font-weight: 700;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}
.timeline-goto:hover {
  border-color: rgba(255, 183, 125, 0.72);
  background: rgba(255, 183, 125, 0.1);
}
.timeline-goto:focus-visible {
  outline: 2px solid #ffb77d;
  outline-offset: 1px;
}
.timeline-tracks {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 0.18rem;
  overflow: auto;
  min-height: 0;
  padding: 0 0.22rem 0.1rem 0;
  overscroll-behavior: contain;
  scrollbar-color: #5e5a52 #171a18;
  scrollbar-width: thin;
}
.timeline-tracks::-webkit-scrollbar {
  width: 0.35rem;
  height: 0.35rem;
}
.timeline-tracks::-webkit-scrollbar-track {
  background: #171a18;
}
.timeline-tracks::-webkit-scrollbar-thumb {
  border: 0;
  background: #5e5a52;
}
.timeline-ruler {
  display: flex;
  min-width: 34rem;
  height: 1.35rem;
  align-items: flex-end;
  gap: 0.6rem;
}
.ruler-spacer,
.track-label {
  flex: 0 0 5.5rem;
}
.ruler-lane {
  position: relative;
  height: 100%;
  flex: 1;
  border-bottom: 1px solid #2a2c29;
}
.ruler-tick {
  position: absolute;
  bottom: 0;
  height: 0.55rem;
  border-left: 1px solid #69635a;
  color: #777168;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.53rem;
  transform: translateX(-0.5px);
}
.ruler-tick b {
  position: absolute;
  bottom: 0.65rem;
  left: 0.22rem;
  font-weight: 500;
  white-space: nowrap;
}
.track-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 34rem;
}
.track-lane {
  position: relative;
  height: 1.28rem;
  flex: 1;
  overflow: hidden;
  border: 1px solid #242623;
  background:
    repeating-linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.035) 0,
      rgba(255, 255, 255, 0.035) 1px,
      transparent 1px,
      transparent 10%
    ),
    #171a18;
  cursor: crosshair;
}
.track-lane:hover {
  border-color: rgba(255, 183, 125, 0.35);
}
.track-label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.1rem;
  justify-content: center;
  color: #8d857c;
}
.track-label strong {
  color: #c7c0b6;
  font-size: 0.62rem;
  font-weight: 700;
}
.track-label span {
  overflow: hidden;
  color: #666159;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playhead {
  position: absolute;
  top: -0.25rem;
  bottom: -0.25rem;
  z-index: 2;
  width: 1px;
  background: #ffb77d;
  box-shadow: 0 0 0 1px rgba(255, 183, 125, 0.12);
  pointer-events: none;
}
.playhead::before {
  position: absolute;
  top: 0;
  left: -0.22rem;
  width: 0.45rem;
  height: 0.3rem;
  background: #ffb77d;
  content: '';
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}
.track-clip {
  position: absolute;
  top: 0.13rem;
  bottom: 0.13rem;
  z-index: 1;
  display: flex;
  align-items: center;
  border-right: 1px solid rgba(0, 0, 0, 0.5);
  padding: 0 0.35rem;
  overflow: hidden;
  color: #e7e0d6;
  font-size: 0.56rem;
  font-weight: 650;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.track-clip.tone-video {
  background: rgba(255, 183, 125, 0.42);
}
.track-clip.tone-static {
  background: rgba(211, 166, 95, 0.34);
}
.track-clip.tone-dialogue {
  background: rgba(131, 182, 140, 0.34);
}
.track-clip.tone-narration {
  background: rgba(150, 204, 255, 0.27);
}
.track-clip.tone-sfx {
  background: rgba(221, 148, 102, 0.36);
}
.track-clip.tone-bgm {
  background: rgba(173, 142, 213, 0.28);
}
.track-clip.tone-subtitle {
  background: rgba(231, 224, 214, 0.24);
}
.track-clip.tone-empty {
  background: rgba(255, 255, 255, 0.04);
  color: #6c6760;
  border-right: 0;
}
.track-clip--muted {
  filter: saturate(0.35);
  opacity: 0.68;
}
.timeline-empty {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  color: #8d857c;
  font-size: 0.74rem;
  padding: 0.4rem 0;
}

@media (max-width: 767px) {
  .timeline {
    padding: 0.7rem 0.8rem;
  }
  .timeline-head {
    align-items: flex-start;
  }
  .timeline-heading {
    min-width: 11rem;
    flex-basis: 11rem;
  }
  .timeline-subtitle {
    display: block;
    margin: 0.28rem 0 0;
  }
  .timeline-head-side {
    width: 100%;
    justify-content: space-between;
    margin-left: 0;
  }
  .timeline-stat-strip {
    gap: 0.45rem;
  }
  .timeline-actions {
    width: 100%;
    justify-content: space-between;
    margin-left: 0;
  }
  .timeline-readout {
    margin-left: 0;
  }
  .timeline-goto {
    margin-left: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .timeline-goto {
    transition: none;
  }
}
</style>
