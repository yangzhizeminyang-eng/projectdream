import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildVerticalCoverFilter,
  buildDefaultVerticalProductionTemplate,
  evaluateFinalEditVerticalPreflight,
  evaluateRenderedMediaSpec,
  evaluateVerticalProductionPreflight,
  normalizeVerticalExportConfig,
  resolveVerticalSubtitleBurnIn,
} from './vertical-production-template.mjs'

test('builds a center-crop filter that fills the vertical production canvas', () => {
  assert.equal(
    buildVerticalCoverFilter({ width: 1080, height: 1920 }),
    'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)/2:(ih-oh)/2',
  )
})

test('builds the approved 1080x1920 vertical production template', () => {
  assert.deepEqual(buildDefaultVerticalProductionTemplate(), {
    id: 'vertical-1080x1920-v1',
    aspectRatio: '9:16',
    resolution: { width: 1080, height: 1920 },
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    subtitleSafeArea: {
      top: 154,
      right: 65,
      bottom: 346,
      left: 65,
    },
  })
})

test('blocks music without recorded authorization', () => {
  const result = evaluateVerticalProductionPreflight({
    template: buildDefaultVerticalProductionTemplate(),
    audioTracks: {
      music: [{ id: 31, title: '悬念氛围', licenseStatus: 'unknown' }],
      sfx: [],
    },
  })

  assert.equal(result.passed, false)
  assert.deepEqual(result.blockingIssues, [
    {
      code: 'unlicensed-audio-source',
      message: 'BGM/SFX「悬念氛围」缺少可用授权记录，不能进入正式导出。',
      assetId: 31,
    },
  ])
})

test('blocks an episode with spoken tracks but no subtitle cues', () => {
  const result = evaluateVerticalProductionPreflight({
    template: buildDefaultVerticalProductionTemplate(),
    hasSpeech: true,
    subtitleCues: [],
    audioTracks: { music: [], sfx: [] },
  })

  assert.equal(result.passed, false)
  assert.deepEqual(result.blockingIssues, [
    {
      code: 'missing-subtitles',
      message: '当前成片存在对白或旁白，必须生成并确认字幕后才能导出。',
    },
  ])
})

test('does not accept blank or disabled subtitle rows as a production subtitle', () => {
  const result = evaluateVerticalProductionPreflight({
    template: buildDefaultVerticalProductionTemplate(),
    hasSpeech: true,
    subtitleCues: [
      { enabled: false, text: '停用字幕' },
      { enabled: true, text: '   ' },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.blockingIssues[0].code, 'missing-subtitles')
})

test('checks only enabled final-edit tracks and requires editable subtitles for enabled speech', () => {
  const result = evaluateFinalEditVerticalPreflight({
    template: buildDefaultVerticalProductionTemplate(),
    audioTracks: {
      dialogue: [{ id: 12, title: '女主对白' }],
      narration: [],
      music: [{ id: 13, title: '未授权 BGM', licenseStatus: 'unknown' }],
      sfx: [{ id: 14, title: '已授权音效', licenseStatus: 'authorized' }],
    },
    audioMix: {
      dialogue: { enabled: true },
      narration: { enabled: false },
      music: { enabled: false },
      sfx: { enabled: true },
    },
    subtitleCues: [],
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'missing-subtitles',
      message: '当前成片存在对白或旁白，必须生成并确认字幕后才能导出。',
    },
  ])
})

test('always burns approved subtitles into a formal vertical export', () => {
  assert.equal(resolveVerticalSubtitleBurnIn(false), true)
  assert.equal(resolveVerticalSubtitleBurnIn(true), true)
})

test('normalizes an export request to the approved vertical codec profile', () => {
  assert.deepEqual(
    normalizeVerticalExportConfig({
      resolution: '1920 x 1080 (FHD)',
      frameRate: 60,
      format: 'mov',
    }),
    {
      format: 'H.264 / MP4',
      resolution: '1080 x 1920 (vertical)',
      frameRate: 24,
      videoCodec: 'h264',
      audioCodec: 'aac',
      templateId: 'vertical-1080x1920-v1',
    },
  )
})

test('rejects a rendered file with a non-vertical resolution', () => {
  const result = evaluateRenderedMediaSpec({
    width: 1920,
    height: 1080,
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'invalid-vertical-resolution',
      message: '成片规格为 1920x1080，必须是 1080x1920 的竖屏视频。',
    },
  ])
})

test('rejects a rendered file with a non-approved frame rate', () => {
  const result = evaluateRenderedMediaSpec({
    width: 1080,
    height: 1920,
    frameRate: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'invalid-frame-rate',
      message: '成片帧率为 30fps，必须是 24fps。',
    },
  ])
})

test('rejects a rendered file whose AAC track contains no measurable audio signal', () => {
  const result = evaluateRenderedMediaSpec({
    width: 1080,
    height: 1920,
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioSignal: 'silent',
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'silent-audio-signal',
      message: '成片音轨检测为静音，不能进入人工签核或发布候选。',
    },
  ])
})

test('rejects a vertical container with persistent top and bottom black bars', () => {
  const result = evaluateRenderedMediaSpec({
    width: 1080,
    height: 1920,
    frameRate: 24,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioSignal: 'measurable',
    edgeLuma: {
      top: 16,
      middle: 39.3,
      bottom: 17.7,
    },
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  })

  assert.deepEqual(result.blockingIssues, [
    {
      code: 'persistent-letterbox-bars',
      message: '成片检测到明显上下黑边，不能作为合格竖屏成片进入人工签核或发布候选。',
    },
  ])
})
