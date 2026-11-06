import assert from 'node:assert/strict'
import test from 'node:test'

import {
  JIANYING_DRAFT_FORMAT_VERSION,
  OVERLAY_ANCHORS,
  buildJianyingDraft,
  buildJianyingTimeline,
  collectJianyingMediaRequests,
  resolveJianyingCanvas,
  resolveJianyingCanvasFor,
} from './jianying-draft.mjs'

const SECOND = 1_000_000

const clips = [
  {
    storyboardId: 11,
    sceneNo: 1,
    shotNo: '01',
    enabled: true,
    order: 1,
    durationSeconds: 3,
    sourceDurationSeconds: 5,
    trimStartSeconds: 0.5,
    videoUrl: 'https://cdn.example.com/v11.mp4',
  },
  {
    storyboardId: 12,
    sceneNo: 1,
    shotNo: '02',
    enabled: false,
    order: 2,
    durationSeconds: 4,
    videoUrl: 'https://cdn.example.com/v12.mp4',
  },
  {
    storyboardId: 13,
    sceneNo: 2,
    shotNo: '06',
    enabled: true,
    order: 3,
    durationSeconds: 2.5,
    sourceDurationSeconds: 4,
    transition: { type: 'fade', durationSeconds: 0.4 },
    videoUrl: 'https://cdn.example.com/v13.mp4',
  },
]

const overlayClips = [
  {
    clipId: 'pip-1',
    storyboardId: 13,
    startSeconds: 1,
    durationSeconds: 2,
    trimStartSeconds: 0.25,
    enabled: true,
    position: 'bottom-right',
    scale: 0.34,
    opacity: 80,
  },
  {
    clipId: 'pip-2',
    storyboardId: 12,
    startSeconds: 0,
    durationSeconds: 1,
    enabled: true,
    position: 'center',
    scale: 0.5,
    opacity: 100,
  },
]

const audioTracks = {
  dialogue: [
    {
      id: 501,
      storyboardId: 13,
      title: '赵衡：别签',
      enabled: true,
      startOffsetSeconds: 0.4,
      durationSeconds: 1.8,
      volume: 80,
      audioUrl: 'https://cdn.example.com/a501.mp3',
    },
    {
      id: 502,
      storyboardId: 11,
      title: '停用',
      enabled: false,
      durationSeconds: 1,
      audioUrl: 'https://cdn.example.com/a502.mp3',
    },
  ],
  narration: [],
  music: [
    {
      id: 601,
      storyboardId: null,
      title: 'BGM 主题',
      enabled: true,
      startOffsetSeconds: 0.5,
      durationSeconds: 6,
      audioUrl: 'https://cdn.example.com/m601.wav',
    },
  ],
  sfx: [],
}

const subtitleCues = [
  { storyboardId: 11, startOffsetSeconds: 0.2, durationSeconds: 2, text: '别签字。', enabled: true },
  { storyboardId: 13, startOffsetSeconds: 0, durationSeconds: 1.5, text: '六。别怕，小夏。', enabled: true },
  { storyboardId: 12, startOffsetSeconds: 0, durationSeconds: 1, text: '停用镜头的字幕', enabled: true },
  { storyboardId: 11, startOffsetSeconds: 0, durationSeconds: 1, text: '   ', enabled: true },
]

function buildDraft(overrides = {}) {
  let counter = 0
  return buildJianyingDraft({
    projectName: '零点回声',
    episodeNo: 1,
    aspectRatio: '9:16',
    clips,
    overlayClips,
    audioTracks,
    subtitleCues,
    mediaPathFor: (url) => (url ? `C:\\media\\${url.split('/').pop()}` : null),
    idFactory: () => `id-${(counter += 1)}`,
    ...overrides,
  })
}

function trackTypes(draft) {
  return draft.draftContent.tracks.map((track) => track.type)
}

test('jianying draft keeps the microsecond timeline and the trim in point', () => {
  const draft = buildDraft()
  const videoTrack = draft.draftContent.tracks.find((track) => track.type === 'video')
  assert.equal(videoTrack.segments.length, 2, '停用镜头不进入主轨')

  const [first, second] = videoTrack.segments
  assert.deepEqual(first.target_timerange, { start: 0, duration: 3 * SECOND })
  assert.deepEqual(first.source_timerange, { start: 0.5 * SECOND, duration: 3 * SECOND })
  assert.deepEqual(second.target_timerange, { start: 3 * SECOND, duration: 2.5 * SECOND })
  assert.equal(draft.draftContent.duration, 5.5 * SECOND)
  assert.equal(draft.totalDurationSeconds, 5.5)
})

test('jianying overlay puts bottom-right at negative Y (real-machine verified)', () => {
  assert.deepEqual(OVERLAY_ANCHORS['bottom-right'], { x: 0.6, y: -0.6 })
  assert.deepEqual(OVERLAY_ANCHORS['top-right'], { x: 0.6, y: 0.6 })

  const draft = buildDraft()
  const overlayTrack = draft.draftContent.tracks.filter((track) => track.type === 'video')[1]
  assert.ok(overlayTrack, '画中画是独立的上层视频轨')
  assert.equal(overlayTrack.name, '画中画')
  assert.equal(overlayTrack.segments.length, 1, '挂在不存在的镜头上的画中画要被跳过')

  const segment = overlayTrack.segments[0]
  assert.deepEqual(segment.target_timerange, { start: 1 * SECOND, duration: 2 * SECOND })
  assert.deepEqual(segment.source_timerange, { start: 0.25 * SECOND, duration: 2 * SECOND })
  assert.deepEqual(segment.clip.transform, { x: 0.6, y: -0.6 })
  assert.deepEqual(segment.clip.scale, { x: 0.34, y: 0.34 })
  assert.equal(segment.clip.alpha, 0.8, '不透明度映射到 clip.alpha')
})

test('jianying audio anchors shot-bound tracks and keeps global music at its own offset', () => {
  const draft = buildDraft()
  const audioTypes = draft.draftContent.tracks.filter((track) => track.type === 'audio')
  assert.equal(audioTypes.length, 2, '对白轨 + 音乐轨')
  assert.deepEqual(
    audioTypes.map((track) => track.name),
    ['对白', '音乐'],
  )

  // 对白挂在 storyboard 13，时间线起点 3s，加 0.4s 偏移
  const dialogue = audioTypes[0].segments[0]
  assert.deepEqual(dialogue.target_timerange, { start: 3.4 * SECOND, duration: 1.8 * SECOND })
  assert.equal(dialogue.volume, 0.8)

  const music = audioTypes[1].segments[0]
  assert.deepEqual(music.target_timerange, { start: 0.5 * SECOND, duration: 6 * SECOND })
  assert.equal(music.volume, 1)

  assert.equal(draft.draftContent.materials.audios.length, 2)
  assert.equal(draft.draftContent.materials.audios[0].type, 'music')
})

test('jianying subtitles become an absolutely timed text track', () => {
  const draft = buildDraft()
  const textTrack = draft.draftContent.tracks.find((track) => track.type === 'text')
  assert.equal(textTrack.segments.length, 2, '停用镜头字幕与空白字幕都被剔除')

  const starts = textTrack.segments.map((segment) => segment.target_timerange.start / SECOND)
  assert.deepEqual(starts, [0.2, 3])
  assert.equal(draft.draftContent.materials.texts[0].content, '别签字。')
})

test('jianying draft refuses to fake transitions and reports them instead', () => {
  const draft = buildDraft()
  assert.equal(draft.draftContent.materials.transitions.length, 0, '不写占位转场')
  assert.deepEqual(draft.stats.unsupportedTransitions, [
    { storyboardId: 13, type: 'fade', durationSeconds: 0.4 },
  ])
})

test('jianying draft records media that never landed instead of writing a broken path', () => {
  const draft = buildDraft({ mediaPathFor: (url) => (url?.includes('v13') ? null : `C:\\media\\${url.split('/').pop()}`) })
  // v13 既在主轨又在画中画里，两处都要如实记为缺失
  assert.deepEqual(
    draft.stats.missingMedia.map((item) => item.kind),
    ['video', 'overlay'],
  )
  // 缺素材的镜头不进主轨，剩下的片段仍然从 0 开始
  const videoTracks = draft.draftContent.tracks.filter((track) => track.type === 'video')
  assert.deepEqual(videoTracks[0].segments.map((segment) => segment.target_timerange.start), [0])
  assert.equal(videoTracks.length, 1, '画中画全缺素材时不留空轨')
  assert.equal(draft.draftContent.materials.videos.length, 1, '只写入真正落地的素材')
})

test('jianying draft is deterministic and does not mutate its input', () => {
  const snapshot = JSON.stringify({ clips, overlayClips, audioTracks, subtitleCues })
  const first = JSON.stringify(buildDraft().draftContent)
  const second = JSON.stringify(buildDraft().draftContent)
  assert.equal(first, second)
  assert.equal(JSON.stringify({ clips, overlayClips, audioTracks, subtitleCues }), snapshot)
})

test('jianying canvas presets follow the project aspect ratio', () => {
  assert.deepEqual(resolveJianyingCanvas('16:9'), { ratio: '16:9', width: 1920, height: 1080 })
  assert.deepEqual(resolveJianyingCanvas(null), { ratio: '9:16', width: 1080, height: 1920 })
  const draft = buildDraft({ aspectRatio: '16:9' })
  assert.equal(draft.draftContent.canvas_config.width, 1920)
  assert.equal(draft.draftContent.canvas_config.height, 1080)
})

const stillFrameInput = {
  clips: [
    { storyboardId: 11, sceneNo: 1, shotNo: '01', enabled: true, durationSeconds: 3, videoUrl: 'https://cdn.example.com/v11.mp4' },
    { storyboardId: 12, sceneNo: 1, shotNo: '02', enabled: true, durationSeconds: 3, imageUrl: 'https://cdn.example.com/frames/c1.png' },
  ],
  overlayClips: [],
  audioTracks: {},
  subtitleCues: [],
}

test('jianying draft writes still frames as video materials by default (real-machine verified)', () => {
  // 真机实测：用户那套剪映 6.0.1 会把 materials.images 里的静帧段**全部丢掉**，
  // 时间线只剩真 mp4。所以默认把静帧当视频素材写（导出前已编码成短 mp4）。
  const draft = buildDraft(stillFrameInput)

  assert.equal(draft.stats.videoMaterials, 2)
  assert.equal(draft.stats.imageMaterials, 0)
  assert.equal(draft.stats.stillsAsVideo, 1)
  assert.equal(draft.draftContent.materials.videos.length, 2)
  assert.equal(draft.draftContent.materials.images.length, 0)

  // 生成器只认 mediaPathFor 给的路径；真实导出时这里已经是编码好的 .still.mp4
  const still = draft.draftContent.materials.videos[1]
  assert.equal(still.type, 'video')
  // 静帧素材时长要容得下展示时长，否则剪映会截断
  assert.ok(still.duration >= 3 * SECOND)

  // 两条都在同一条主轨上，顺序不变
  const videoTrack = draft.draftContent.tracks.find((track) => track.type === 'video')
  assert.equal(videoTrack.segments.length, 2)
  assert.deepEqual(videoTrack.segments.map((segment) => segment.target_timerange.start), [0, 3 * SECOND])
  assert.equal(videoTrack.segments[1].material_id, still.id)
})

test('jianying draft can still write photo materials for capcut versions that support them', () => {
  const draft = buildDraft({ ...stillFrameInput, imageAsVideo: false })

  assert.equal(draft.stats.videoMaterials, 1)
  assert.equal(draft.stats.imageMaterials, 1)
  assert.equal(draft.stats.stillsAsVideo, 0)
  assert.equal(draft.draftContent.materials.images.length, 1)

  const photo = draft.draftContent.materials.images[0]
  assert.equal(photo.type, 'photo')
  assert.match(photo.path, /c1\.png$/)
  assert.ok(photo.duration >= 3 * SECOND)
})

test('jianying media requests keep the still-frame extension so files land as .png', () => {
  const { requests } = collectJianyingMediaRequests({
    clips: [
      { storyboardId: 11, sceneNo: 1, shotNo: '01', enabled: true, durationSeconds: 3, videoUrl: 'https://cdn.example.com/v11.mp4' },
      { storyboardId: 12, sceneNo: 1, shotNo: '02', enabled: true, durationSeconds: 3, imageUrl: 'https://cdn.example.com/frames/c1.png' },
    ],
    overlayClips: [],
    audioTracks: {},
    subtitleCues: [],
    projectName: '零点回声',
    episodeNo: 1,
  })
  assert.deepEqual(
    requests.map((item) => [item.kind, item.fileName]),
    [
      ['video', '01_S1-01.mp4'],
      ['image', '02_S1-02.png'],
    ],
  )
})

test('jianying canvas prefers real pixels over the declared ratio', () => {
  // 项目 12：声明 2.39:1、素材实际 16:9。按声明走会静默变成 9:16 竖屏。
  assert.deepEqual(
    resolveJianyingCanvasFor({ aspectRatio: '2.39:1', mediaDimensions: { width: 1312, height: 736 } }),
    { ratio: '16:9', width: 1312, height: 736, source: 'media' },
  )
  assert.deepEqual(resolveJianyingCanvasFor({ aspectRatio: '16:9' }), {
    ratio: '16:9',
    width: 1920,
    height: 1080,
    source: 'declared',
  })
  // 可解析但不在预置表里的比例（2.39:1）也要实算，不能静默变成 9:16
  assert.deepEqual(resolveJianyingCanvasFor({ aspectRatio: '2.39:1' }), {
    ratio: '2.39:1',
    width: 2582,
    height: 1080,
    source: 'declared',
  })
  // 完全认不出来的比例才兜底，并且留痕
  assert.deepEqual(resolveJianyingCanvasFor({ aspectRatio: '自适应' }), {
    ratio: '9:16',
    width: 1080,
    height: 1920,
    source: 'fallback',
    declaredRatio: '自适应',
  })
  // 奇数尺寸补成偶数，避免编码器裁剪
  assert.equal(resolveJianyingCanvasFor({ mediaDimensions: { width: 1313, height: 737 } }).width, 1314)
})

test('jianying draft applies the media-derived canvas to the draft body', () => {
  const draft = buildDraft({ aspectRatio: '2.39:1', mediaDimensions: { width: 1280, height: 720 } })
  assert.equal(draft.canvas.source, 'media')
  assert.equal(draft.draftContent.canvas_config.width, 1280)
  assert.equal(draft.draftContent.canvas_config.height, 720)
  // 素材声明宽高也要跟着走，避免剪映再按比例缩放一次
  assert.ok(draft.draftContent.materials.videos.every((m) => m.width === 1280 && m.height === 720))
})

test('jianying draft declares a format version the user app can actually open', () => {
  // 这条是有意锁死的。取值依据见常量注释：小泽实际用的是破解版 6.0.1（较旧），
  // 它能打开 110.0.0；写成官方 11.5 的 164.0.0 会让它弹「草稿版本较新，是否升级」
  // ——那个升级按钮对破解版用户是危险的。改这个常量必须是有意识的行为。
  assert.equal(JIANYING_DRAFT_FORMAT_VERSION, '110.0.0')
  const draft = buildDraft()
  assert.equal(draft.draftContent.new_version, JIANYING_DRAFT_FORMAT_VERSION)
  // meta 里也要写，剪映归一化时两个字段都会写
  assert.equal(draft.draftMetaInfo.draft_new_version, JIANYING_DRAFT_FORMAT_VERSION)
})

test('jianying timeline starts skip disabled shots', () => {
  const timeline = buildJianyingTimeline(clips)
  assert.deepEqual(
    timeline.ordered.map((entry) => [entry.storyboardId, entry.startSeconds]),
    [
      [11, 0],
      [13, 3],
    ],
  )
  assert.equal(timeline.totalDurationSeconds, 5.5)
})

test('jianying draft requires a media path resolver', () => {
  assert.throws(() => buildJianyingDraft({ clips: [] }), /mediaPathFor/)
})
