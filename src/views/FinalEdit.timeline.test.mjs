import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./FinalEdit.vue', import.meta.url), 'utf8')

test('final edit saves a non-destructive timeline draft with trim and replacement choices', () => {
  assert.match(source, /function buildDraftPayload\(\)/)
  assert.match(source, /videoAssetId: item\.videoAssetId \|\| item\.id \|\| null/)
  assert.match(source, /trimStartSeconds: Math\.max\(0, Number\(item\.trimStartSeconds\) \|\| 0\)/)
  assert.match(source, /trimEndSeconds: Math\.max\(0\.25, Number\(item\.trimEndSeconds\) \|\| clipSourceDuration\(item\)\)/)
  assert.match(source, /updateProjectFinalEditDraft\(projectId\.value, buildDraftPayload\(\), selectedEpisodeNo\.value\)/)
})

test('final edit exposes candidate replacement without overwriting source assets', () => {
  assert.match(source, /listStoryboardVideos/)
  assert.match(source, /const selectedVideoCandidates = ref<VideoAssetDTO\[\]>\(\[\]\)/)
  assert.match(source, /function applyVideoCandidate\(candidate: VideoAssetDTO\)/)
  assert.match(source, /原候选未被覆盖/)
  assert.match(source, /videoAssetId: candidate\.id/)
})

test('final edit provides per-clip audio and subtitle alignment controls', () => {
  assert.match(source, /audioClips: audioTrackMeta\.flatMap/)
  assert.match(source, /function updateAudioClip/)
  assert.match(source, /startOffsetSeconds/)
  assert.match(source, /function updateSubtitleCue/)
  assert.match(source, /selectedSubtitleCues/)
  assert.match(source, /fe-mini-subtitle/)
})

test('final edit refreshes the selected shot candidate list after draft sync', () => {
  assert.match(source, /syncSelectedVideo\(preferredStoryboardId\)/)
  assert.match(source, /void loadSelectedVideoCandidates\(\)/)
  assert.match(source, /if \(selectedStoryboardId\.value === storyboardId\)/)
})

test('final edit exposes split, drag reorder, transitions, audio lead, beats, emotion, undo, and rollback controls', () => {
  assert.match(source, /function splitSelectedClip\(\)/)
  assert.match(source, /function onClipDragStart/)
  assert.match(source, /function onClipDrop/)
  assert.match(source, /transition: cloneClipTransition/)
  assert.match(source, /function nudgeSelectedAudioLead/)
  assert.match(source, /const beatMarkers = ref/)
  assert.match(source, /const emotionCurve = ref/)
  assert.match(source, /function addBeatMarker\(\)/)
  assert.match(source, /function updateEmotionPoint/)
  assert.match(source, /function undoEdit\(\)/)
  assert.match(source, /function redoEdit\(\)/)
  assert.match(source, /function rollbackToVersion/)
  assert.match(source, /@pointerdown\.stop="startClipPointerDrag\(\$event, clip\)"/)
  assert.match(source, /fe-edit-overlays/)
  assert.match(source, /aria-label="节拍点名称"/)
  assert.match(source, /aria-label="情绪强度"/)
})

test('final edit positions split clips by clip identity and shows audio lead-in offsets', () => {
  assert.match(source, /return timelineClipStyle\(clipStartSeconds\(clip\), clip\.durationSeconds\)/)
  assert.match(source, /clipStartSeconds\(item\.storyboardId\) \+ \(Number\(item\.startOffsetSeconds\) \|\| 0\)/)
  assert.match(source, /function formatSignedSeconds\(value\?: number \| null\)/)
  assert.match(source, /formatSignedSeconds\(item\.startOffsetSeconds\)/)
})

test('final edit keeps the professional editor four-zone information architecture', () => {
  assert.match(source, /class="fe-material-bin"/)
  assert.match(source, /class="fe-preview-panel"/)
  assert.match(source, /class="final-edit-inspector"/)
  assert.match(source, /class="fe-section fe-timeline-dock"/)
  assert.match(source, /class="fe-inspector-tabs"/)
  assert.match(source, /activeInspectorTab === 'picture'/)
  assert.match(source, /activeMaterialPanel === 'media'/)
})

test('final edit exposes a shared timeline playhead with scrubbing and timecode sync', () => {
  assert.match(source, /const timelinePositionSeconds = ref\(0\)/)
  assert.match(source, /function syncTimelineToVideoTime\(\)/)
  assert.match(source, /function seekTimeline\(seconds: number\)/)
  assert.match(source, /function onTimelinePointerDown/)
  assert.match(source, /function onTimelineKeydown/)
  assert.match(source, /class="fe-timeline-playhead"/)
  assert.match(source, /class="fe-preview-timecode"/)
  assert.match(source, /@timeupdate="handlePreviewTimeUpdate"/)
  assert.match(source, /aria-label="时间线播放位置"/)
})

test('final edit splits at the active playhead instead of an implicit midpoint', () => {
  assert.match(source, /const playheadClip = editableVideoClips\.value\.find/)
  assert.match(source, /timelinePositionSeconds\.value - clipStart/)
  assert.match(source, /在播放头处分割/)
  assert.doesNotMatch(source, /trimStart \+ availableDuration \/ 2/)
})

test('replan query applies only semantic transition suggestions and persists the episode draft', () => {
  assert.match(source, /route\.query\.replan === '1'/)
  assert.match(source, /function applyRecommendedTransitionReplan\(/)
  assert.match(source, /sameScene \? \{ type: 'cut', durationSeconds: 0, manual: false \} : \{ type: 'fade', durationSeconds: 0\.18, manual: false \}/)
  assert.match(source, /await handleSaveDraft\(true\)/)
  assert.match(source, /replan: undefined/)
})

test('final edit keeps a usable preview canvas for the selected media', () => {
  assert.match(source, /class="fe-preview-frame"/)
  assert.match(source, /aspect-ratio: 16 \/ 9/)
  assert.match(source, /\.fe-preview-frame video,\n\.fe-preview-frame img \{[\s\S]*?width: 100% !important/)
})

test('final edit keeps operation feedback floating and exposes every timeline track through an inner scroller', () => {
  assert.match(source, /class="fe-toast-layer"/)
  assert.match(source, /function showInfo\(message: string/)
  assert.match(source, /function showError\(message: string/)
  assert.match(source, /class="fe-timeline-scroll-body"/)
  assert.match(source, /\.fe-timeline-scroll-body \{[\s\S]*?overflow: auto;/)
  assert.match(source, /grid-template-rows: minmax\(var\(--fe-preview-min-height, 380px\), 1fr\) minmax\(180px, var\(--fe-timeline-height, 22vh\)\)/)
  assert.match(source, /\.fe-timeline-dock \{[\s\S]*?min-height: 180px;/)
})

test('final edit keeps the preview footer inside the clipped player panel', () => {
  // 底栏三行网格只有在面板内部才可点击：画布是唯一可伸缩子项，
  // 头和尾都不收缩，否则面板 overflow:hidden 会把播放按钮裁掉并被时间线盖住。
  const blockWith = (selector, marker) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const blocks = Array.from(
      source.matchAll(new RegExp(`${escaped} \\{([^}]*)\\}`, 'g')),
      (match) => match[1],
    )
    return blocks.find((block) => block.includes(marker)) || ''
  }

  const panelBlock = blockWith('.fe-preview-panel', 'flex-direction: column')
  assert.ok(panelBlock, 'expected the column player panel rule')
  assert.match(panelBlock, /display: flex;/)
  assert.match(panelBlock, /flex-direction: column;/)
  assert.match(panelBlock, /overflow: hidden;/)

  const frameBlock = blockWith('.fe-preview-frame', 'aspect-ratio: 16 / 9')
  assert.ok(frameBlock, 'expected the 16:9 preview frame rule')
  assert.match(frameBlock, /flex: 1 1 auto;/)
  assert.match(frameBlock, /min-height: 0;/)

  const footerBlock = blockWith('.fe-preview-footer', 'grid-template-areas')
  assert.ok(footerBlock, 'expected the three-row preview footer rule')
  assert.match(footerBlock, /flex: 0 0 auto;/)
  assert.match(footerBlock, /"main time"\s*"main sync"\s*"volume volume";/)
  assert.match(source, /\.fe-preview-footer > \.fe-preview-timecode \{\n  grid-area: time;/)
  assert.match(source, /\.fe-preview-footer > \.fe-preview-sync-state \{\n  grid-area: sync;/)
  assert.match(source, /\.fe-preview-footer > \.fe-inline-control \{\n  grid-area: volume;/)
})

test('final edit exposes a zoomable, snap-aware timeline with non-destructive edge trimming', () => {
  assert.match(source, /const timelinePixelsPerSecond = ref\(/)
  assert.match(source, /function setTimelineZoom\(value: number\)/)
  assert.match(source, /function toggleTimelineSnap\(\)/)
  assert.match(source, /function startTrimDrag\(/)
  assert.match(source, /function onTrimPointerMove\(/)
  assert.match(source, /function resolveSnapPosition\(/)
  assert.match(source, /fe-clip-handle-start/)
  assert.match(source, /fe-clip-handle-end/)
  assert.match(source, /aria-label="缩小时间线"/)
  assert.match(source, /aria-label="放大时间线"/)
  assert.match(source, /class="fe-timeline-resize-handle"/)
  assert.match(source, /function startTimelineResize\(/)
  assert.match(source, /timelinePixelsPerSecond\.value/)
  assert.match(source, /function startClipPointerDrag\(/)
  assert.match(source, /function onClipPointerMove\(/)
  assert.match(source, /function handleTimelineClipClick\(/)
  assert.match(source, /data-clip-id/)
  assert.match(source, /fe-edit-clip-dragging/)
})

test('final edit exposes a program monitor that can play the enabled timeline as one sequence', () => {
  assert.match(source, /type PreviewMode = 'program' \| 'clip'/)
  assert.match(source, /const previewMode = ref<PreviewMode>\('program'\)/)
  assert.match(source, /function startProgramPlayback\(\)/)
  assert.match(source, /function handlePreviewEnded\(\)/)
  assert.match(source, /function setPreviewMode\(mode: PreviewMode\)/)
  assert.match(source, /@ended="handlePreviewEnded"/)
  assert.match(source, /@timeupdate="handlePreviewTimeUpdate"/)
  assert.match(source, /aria-label="整集预览"/)
  assert.match(source, /aria-label="当前镜头预览"/)
  assert.match(source, /class="fe-preview-mode-switch"/)
})

test('final edit schedules mixed audio against the shared timeline clock', () => {
  assert.match(source, /const previewAudioElements = new Map<number, HTMLAudioElement>\(\)/)
  assert.match(source, /function syncPreviewAudioToTimeline\(autoplay = false\)/)
  assert.match(source, /function startPreviewAudioSyncTimer\(\)/)
  assert.match(source, /clipStartSeconds\(item\.storyboardId\) \+ \(Number\(item\.startOffsetSeconds\) \|\| 0\)/)
  assert.match(source, /audioMixState\.value\[entry\.trackKey\]\.volume/)
  assert.match(source, /audioPreviewEntries/)
  assert.match(source, /@loadedmetadata="syncPreviewAudioToTimeline\(isPlaying\)"/)
})

test('final edit explains audio that is waiting for its matching video clip', () => {
  assert.match(source, /const unmatchedAudioItems = computed\(\(\) => finalEdit\.value\?\.unmatchedAudio \|\| \[\]\)/)
  assert.match(source, /audio-without-video-clip/)
  assert.match(source, /待对应画面/)
  assert.match(source, /避免声音跑到错误镜头/)
  // 只有“确实一条已确认音频都没有”时才提示缺音频，否则会误导用户去重新生成音频。
  assert.match(source, /const unmatchedAudioCount = unmatchedAudioItems\.value\.length/)
  assert.match(source, /if \(availableAudioTrackCount === 0 && unmatchedAudioCount === 0\)/)
  assert.match(source, /else if \(availableAudioTrackCount > 0 && enabledAudioTrackCount === 0\)/)
})

test('final edit keeps subtitles visible in the program monitor and syncs seeks', () => {
  assert.match(source, /const activePreviewSubtitleCues = computed/)
  assert.match(source, /class="fe-preview-subtitles"/)
  assert.match(source, /v-for="cue in activePreviewSubtitleCues"/)
  assert.match(source, /syncPreviewAudioToTimeline\(isPlaying\.value\)/)
  assert.match(source, /@play="handlePreviewPlay"/)
  assert.match(source, /@pause="handlePreviewPause"/)
})

test('final edit keeps the preview large and stops the timeline from eating it', () => {
  assert.match(
    source,
    /grid-template-rows: minmax\(var\(--fe-preview-min-height, 380px\), 1fr\) minmax\(180px, var\(--fe-timeline-height, 22vh\)\)/,
  )
  assert.match(source, /const timelineDockHeight = ref\(200\)/)
  assert.match(source, /Math\.max\(180, Math\.min\(620, Math\.round\(nextHeight\)\)\)/)
})

test('final edit lets creators search the media bin and drag a card into the timeline', () => {
  assert.match(source, /const binQuery = ref\(''\)/)
  assert.match(source, /const filteredVideoClips = computed/)
  assert.match(source, /v-model\.trim="binQuery"/)
  assert.match(source, /draggable="true"/)
  assert.match(source, /@dragstart="onBinTileDragStart\(\$event, clip\)"/)
  assert.match(source, /function onBinTileDragStart\(event: DragEvent, clip: FinalEditVideoClipDTO\)/)
  assert.match(source, /function onMainLaneDragOver\(event: DragEvent\)/)
  assert.match(source, /function onMainLaneDrop\(event: DragEvent\)/)
  assert.match(source, /function resolveMainDropIndex\(clientX: number\)/)
  assert.match(source, /fe-edit-clip-drop-before/)
  assert.match(source, /fe-edit-lane-drop-end/)
})

test('final edit keeps picture-in-picture overlays on their own track', () => {
  assert.match(source, /const overlayClips = ref<FinalEditOverlayClipDTO\[\]>\(\[\]\)/)
  assert.match(source, /class="fe-edit-row fe-edit-row-overlay"/)
  assert.match(source, /@drop="onOverlayLaneDrop"/)
  assert.match(source, /function addOverlayClip\(storyboardId: number, startSeconds: number\)/)
  assert.match(source, /function removeOverlayClip\(clipId: string\)/)
  assert.match(source, /const activeOverlayClips = computed/)
  assert.match(source, /class="fe-preview-overlay"/)
  assert.match(source, /function overlayPreviewStyle\(clip: FinalEditOverlayClipDTO\)/)
  assert.match(source, /overlay-not-rendered/)
  assert.match(source, /function normalizeLocalOverlayClip/)
})

test('final edit shows hover tips and moves the playhead without repainting track text', () => {
  assert.match(source, /content: attr\(aria-label\)/)
  assert.match(
    source,
    /transform: `translate3d\(\$\{122 \+ timelinePositionSeconds\.value \* timelinePixelsPerSecond\.value\}px, 0, 0\)`/,
  )
  assert.match(source, /\.fe-timeline-playhead \{[\s\S]*?will-change: transform;/)
  assert.match(source, /\.fe-edit-timeline,\n\.fe-bin-body \{\n  user-select: none;/)
})

test('final edit hands the cut off as a delivery package for an external NLE', () => {
  assert.match(source, /const isDeliveryPanelOpen = ref\(false\)/)
  assert.match(source, /async function openDeliveryPanel\(\)/)
  assert.match(source, /async function downloadDeliveryArchive\(includeMedia: boolean\)/)
  assert.match(source, /downloadProjectDeliveryArchive\(/)
  assert.match(source, /getProjectDeliveryPackage\(projectId\.value, episodeNo\.value\)/)
  assert.match(source, /class="fe-delivery-layer"/)
  assert.match(source, /@click="downloadDeliveryTextFile\('srt'\)"/)
  assert.match(source, /materials\//)
  assert.match(source, /subtitles\.srt/)
})

test('final edit can hand the cut to capcut and blocks export while capcut is running', () => {
  assert.match(source, /type JianyingDraftPlanDTO/)
  assert.match(source, /type JianyingExportResultDTO/)
  assert.match(source, /type JianyingStatusDTO/)
  assert.match(source, /async function openJianyingPanel\(\)/)
  assert.match(source, /async function refreshJianyingPanel\(\)/)
  assert.match(source, /async function exportToJianying\(install: boolean\)/)
  assert.match(source, /async function removeJianyingDraft\(folder: string\)/)
  assert.match(source, /getProjectJianyingPlan\(projectId\.value, episodeNo\.value\)/)
  assert.match(source, /getProjectJianyingStatus\(projectId\.value\)/)
  assert.match(source, /uninstallProjectJianyingDraft\(projectId\.value, folder\)/)
  assert.match(source, /class="fe-jy-status"/)
  // 剪映运行中/草稿库不存在时必须禁用安装按钮
  assert.match(
    source,
    /:disabled="isJianyingExporting \|\| jianyingStatus\?\.jianyingRunning === true \|\| !jianyingStatus\?\.rootReady"/,
  )
  assert.match(source, /@click="exportToJianying\(true\)"/)
  assert.match(source, /@click="exportToJianying\(false\)"/)
  // 转场按硬切导出这件事必须如实告诉用户
  assert.match(source, /按\*\*硬切\*\*导出/)
  assert.match(source, /剪映转场要用它内置的特效 ID/)
  // 静帧数量要对用户可见
  assert.match(source, /stillFrameClipCount/)
  assert.match(source, /导出到剪映/)
  // 画布来源要说清楚：声明比例和真实素材不一致时以素材为准
  assert.match(source, /jianyingPlan\.canvas\.width }}×\{\{ jianyingPlan\.canvas\.height/)
  assert.match(source, /canvasSource === 'media'/)
  assert.match(source, /canvasSource === 'fallback'/)
  assert.match(source, /以素材为准/)
  assert.match(source, /避免横屏素材被塞进竖屏画布/)
  assert.match(source, /请在剪映里确认画布比例/)
})
