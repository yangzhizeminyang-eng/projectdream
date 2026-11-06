import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDeliveryCsv,
  buildDeliveryManifest,
  buildDeliverySrt,
  buildDeliveryTimeline,
  formatSrtTimestamp,
  resolveDeliveryCanvas,
  sanitizeDeliveryName,
} from './delivery-package.mjs'

const videoClips = [
  {
    clipId: 'storyboard-11',
    storyboardId: 11,
    sceneNo: 1,
    shotNo: '01',
    sceneTitle: '办公室：别签字与U盘',
    enabled: true,
    durationSeconds: 3,
    sourceDurationSeconds: 5,
    trimStartSeconds: 0.5,
    trimEndSeconds: 3.5,
    videoUrl: 'https://example.com/v11.mp4',
  },
  {
    clipId: 'storyboard-12',
    storyboardId: 12,
    sceneNo: 1,
    shotNo: '02',
    sceneTitle: '楼道/追?',
    enabled: false,
    durationSeconds: 4,
    videoUrl: 'https://example.com/v12.mp4',
  },
  {
    clipId: 'storyboard-13',
    storyboardId: 13,
    sceneNo: 2,
    shotNo: '06',
    sceneTitle: '广播机启动',
    enabled: true,
    durationSeconds: 2.5,
    videoUrl: 'https://example.com/v13.mp4',
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
      audioUrl: 'https://example.com/a501.mp3',
    },
    { id: 502, storyboardId: 11, title: '被停用', enabled: false, durationSeconds: 1, audioUrl: '' },
  ],
  narration: [],
  music: [
    {
      id: 601,
      storyboardId: null,
      title: 'BGM 主题',
      enabled: true,
      startOffsetSeconds: 0,
      durationSeconds: 12,
      audioUrl: 'https://example.com/m601.wav',
    },
  ],
  sfx: [],
}

const subtitleCues = [
  { storyboardId: 13, startOffsetSeconds: 0.2, durationSeconds: 1.5, text: '六。别怕，小夏。', enabled: true },
  { storyboardId: 11, startOffsetSeconds: 0.5, durationSeconds: 2, text: '别签字。', enabled: true },
  { storyboardId: 11, startOffsetSeconds: 3, durationSeconds: 1, text: '   ', enabled: true },
  { storyboardId: 12, startOffsetSeconds: 0, durationSeconds: 1, text: '停用镜头的字幕', enabled: true },
]

function buildManifest(overrides = {}) {
  return buildDeliveryManifest({
    projectId: 12,
    projectName: '零点回声',
    episodeNo: 1,
    aspectRatio: '9:16',
    generatedAt: '2026-09-29T10:00:00.000Z',
    videoClips,
    audioTracks,
    subtitleCues,
    ...overrides,
  })
}

test('delivery timeline follows the draft order and skips disabled shots', () => {
  const timeline = buildDeliveryTimeline(videoClips)
  assert.deepEqual(
    timeline.ordered.map((entry) => [entry.clipId, entry.startSeconds, entry.endSeconds]),
    [
      ['storyboard-11', 0, 3],
      ['storyboard-13', 3, 5.5],
    ],
  )
  assert.equal(timeline.totalDurationSeconds, 5.5)
  assert.equal(timeline.startsByClipId.get('storyboard-13'), 3)
})

test('delivery names are ordered, readable and filesystem safe', () => {
  assert.equal(sanitizeDeliveryName('楼道/追?'), '楼道 追')
  assert.equal(sanitizeDeliveryName('   '), 'clip')

  const manifest = buildManifest()
  assert.equal(manifest.clips.length, 2)
  assert.equal(manifest.clips[0].fileName, '01_E01-S01-01_办公室：别签字与U盘.mp4')
  assert.equal(manifest.clips[1].fileName, '02_E01-S02-06_广播机启动.mp4')
  assert.equal(manifest.clips[0].archivePath, `materials/${manifest.clips[0].fileName}`)
  assert.equal(manifest.clips[0].trimStartSeconds, 0.5)
})

test('delivery audio keeps track folders and anchors to the matching shot', () => {
  const manifest = buildManifest()
  const dialogue = manifest.audioTracks.find((track) => track.key === 'dialogue')
  const music = manifest.audioTracks.find((track) => track.key === 'music')

  assert.equal(dialogue.items.length, 1, '停用的音频不应该出现在交付包里')
  // 对白挂在 storyboard-13，时间线起点 3s，加 0.4s 偏移
  assert.equal(dialogue.items[0].startSeconds, 3.4)
  assert.equal(dialogue.items[0].endSeconds, 5.2)
  assert.equal(dialogue.items[0].archivePath, 'audio/对白/01_E01_DLG_赵衡：别签.mp3')

  // BGM 没有绑定镜头，落在 0s
  assert.equal(music.items[0].startSeconds, 0)
  assert.equal(music.items[0].fileName, '01_E01_MUS_BGM 主题.wav')
})

test('delivery subtitles are sorted, trimmed and aligned to the timeline', () => {
  const manifest = buildManifest()
  assert.deepEqual(
    manifest.subtitles.map((cue) => [cue.startSeconds, cue.endSeconds, cue.text]),
    [
      [0.5, 2.5, '别签字。'],
      [3.2, 4.7, '六。别怕，小夏。'],
    ],
  )
  // 停用镜头的字幕不能落到 0 秒，只能如实剔除并报数
  assert.equal(manifest.orphanSubtitleCount, 1)
  assert.equal(manifest.orphanAudioCount, 0)
})

test('delivery srt uses standard timecodes', () => {
  assert.equal(formatSrtTimestamp(0), '00:00:00,000')
  assert.equal(formatSrtTimestamp(5.5), '00:00:05,500')
  assert.equal(formatSrtTimestamp(3725.25), '01:02:05,250')

  const srt = buildDeliverySrt([{ startSeconds: 0, endSeconds: 1.25, text: '第一句' }])
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,250\n第一句\n')
  assert.equal(buildDeliverySrt([]), '')
})

test('delivery csv lists video, audio and subtitle rows for the editor', () => {
  const manifest = buildManifest()
  const csv = buildDeliveryCsv(manifest)
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv, /类型,序号,文件名,场景,镜头,时间线起点\(秒\)/)
  assert.match(csv, /视频,1,01_E01-S01-01_办公室：别签字与U盘\.mp4,S01,01,0,3,3,0\.5,3\.5/)
  assert.match(csv, /音频-对白,1,01_E01_DLG_赵衡：别签\.mp3,,,3\.4,5\.2,1\.8,,,赵衡：别签/)
  assert.match(csv, /字幕,1,subtitles\.srt,,,0\.5,2\.5,2,,,别签字。/)
  assert.doesNotMatch(csv, /停用镜头的字幕/)
})

test('delivery drops audio bound to shots that are not on the timeline', () => {
  const manifest = buildDeliveryManifest({
    videoClips,
    audioTracks: {
      dialogue: [
        {
          id: 503,
          storyboardId: 12,
          title: '停用镜头的对白',
          enabled: true,
          startOffsetSeconds: 0,
          durationSeconds: 1.2,
          audioUrl: 'https://example.com/a503.mp3',
        },
      ],
      narration: [],
      music: [],
      sfx: [],
    },
    subtitleCues: [],
  })

  assert.equal(manifest.totals.audioCount, 0)
  assert.equal(manifest.orphanAudioCount, 1)
  assert.match(manifest.readme, /有 1 条音频挂在没进时间线的镜头上/)
})

test('delivery readme explains the import steps and the canvas', () => {
  const manifest = buildManifest()
  assert.equal(manifest.canvas.ratio, '9:16')
  assert.equal(manifest.canvas.width, 1080)
  assert.match(manifest.readme, /画布比例：9:16（1080×1920）/)
  assert.match(manifest.readme, /在剪映里怎么用/)
  assert.match(manifest.readme, /materials\//)
  assert.match(manifest.readme, /subtitles\.srt/)
  assert.equal(resolveDeliveryCanvas('16:9').width, 1920)
  assert.equal(resolveDeliveryCanvas(null).ratio, '9:16')
})

test('delivery readme carries the unmatched audio and overlay caveats', () => {
  const manifest = buildManifest({ unmatchedAudioCount: 2, overlayClipCount: 1 })
  assert.match(manifest.readme, /还有 2 条对白\/旁白没有对应的已确认画面/)
  assert.match(manifest.readme, /画中画轨道有 1 个片段/)
  assert.equal(manifest.unmatchedAudioCount, 2)
  assert.equal(manifest.overlayClipCount, 1)
})

test('delivery keeps the real extension when a shot is a still frame, not a video', () => {
  // 项目 12 真实情况：24 个镜头里 23 个是静帧 PNG。
  // 早先按 videoUrl 一律推断成 .mp4，交付包里就出现了「后缀 mp4、内容 PNG」的文件。
  const manifest = buildDeliveryManifest({
    projectId: 12,
    projectName: '零点回声',
    episodeNo: 1,
    videoClips: [
      { storyboardId: 11, sceneNo: 1, shotNo: '01', enabled: true, durationSeconds: 3, videoUrl: 'https://example.com/a/v1.mp4?sig=x' },
      { storyboardId: 12, sceneNo: 1, shotNo: '02', enabled: true, durationSeconds: 3, imageUrl: 'https://example.com/b/frames/c1.png?sig=x' },
      { storyboardId: 13, sceneNo: 2, shotNo: '03', enabled: true, durationSeconds: 3, imageUrl: 'https://example.com/b/frames/c2.jpeg' },
    ],
    audioTracks: {},
    subtitleCues: [],
  })

  assert.deepEqual(
    manifest.clips.map((clip) => clip.fileName),
    ['01_E01-S01-01.mp4', '02_E01-S01-02.png', '03_E01-S02-03.jpeg'],
  )
  assert.deepEqual(
    manifest.clips.map((clip) => clip.sourceKind),
    ['video', 'image', 'image'],
  )
  assert.equal(manifest.totals.videoClipCount, 1)
  assert.equal(manifest.totals.imageClipCount, 2)

  // CSV 里要能一眼看出哪条是静帧
  const csv = buildDeliveryCsv(manifest)
  assert.match(csv, /静帧,2,02_E01-S01-02\.png/)
  assert.match(csv, /视频,1,01_E01-S01-01\.mp4/)
})

test('delivery falls back safely when a shot has neither video nor image', () => {
  const manifest = buildDeliveryManifest({
    projectId: 12,
    projectName: '零点回声',
    episodeNo: 1,
    videoClips: [{ storyboardId: 11, sceneNo: 1, shotNo: '01', enabled: true, durationSeconds: 2 }],
    audioTracks: {},
    subtitleCues: [],
  })
  assert.equal(manifest.clips[0].sourceKind, 'unknown')
  assert.equal(manifest.clips[0].fileName, '01_E01-S01-01.mp4')
  assert.equal(manifest.clips[0].sourceUrl, null)
})

test('delivery manifest never mutates the draft it reads', () => {
  const snapshot = JSON.stringify(videoClips)
  buildManifest()
  assert.equal(JSON.stringify(videoClips), snapshot)
})
