import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDefaultSubtitleCues,
  buildSubtitleCuesFromAudioTracks,
  buildSubtitleForceStyle,
  buildSubtitleTextFromCues,
  normalizeSubtitleCues,
  shiftDialogueSubtitleCues,
} from './subtitle-cues.mjs'
import { buildMediaTimeline } from './media-timeline.mjs'

test('builds editable default cues from enabled storyboard dialogue', () => {
  assert.deepEqual(
    buildDefaultSubtitleCues([
      { storyboardId: 8, dialogueText: '  别回头。  ', durationSeconds: 3 },
      { storyboardId: 9, dialogueText: '无对白', durationSeconds: 4 },
      { storyboardId: 10, dialogueText: '被禁用的台词', enabled: false, durationSeconds: 5 },
    ]),
    [
      {
        cueId: 'sb-8-1',
        storyboardId: 8,
        enabled: true,
        startOffsetSeconds: 0,
        durationSeconds: 3,
        text: '别回头。',
      },
    ],
  )
})

test('builds separate subtitle cues from speech track timing', () => {
  const cues = buildSubtitleCuesFromAudioTracks(
    [
      {
        storyboardId: 186,
        dialogueText: '林夏：……妈？苏岚（广播）：五。',
        durationSeconds: 5,
      },
    ],
    {
      dialogue: [
        {
          id: 170,
          storyboardId: 186,
          trackType: 'dialogue',
          characterName: '林夏',
          startOffsetSeconds: 0,
          durationSeconds: 0.56,
        },
      ],
      narration: [
        {
          id: 171,
          storyboardId: 186,
          trackType: 'narration',
          startOffsetSeconds: 1.1,
          durationSeconds: 0.56,
        },
      ],
      music: [],
      sfx: [],
    },
  )

  assert.deepEqual(cues, [
    {
      cueId: 'audio-170',
      storyboardId: 186,
      enabled: true,
      startOffsetSeconds: 0,
      durationSeconds: 0.56,
      text: '林夏：……妈？',
    },
    {
      cueId: 'audio-171',
      storyboardId: 186,
      enabled: true,
      startOffsetSeconds: 1.1,
      durationSeconds: 0.56,
      text: '苏岚（广播）：五。',
    },
  ])
})

test('normalizes editable subtitle cues against the current final timeline', () => {
  const result = normalizeSubtitleCues(
    [
      {
        cueId: 'custom-cue',
        storyboardId: 8,
        enabled: true,
        startOffsetSeconds: -2,
        durationSeconds: 99,
        text: '  第一行\n第二行  ',
      },
      {
        cueId: 'removed-shot',
        storyboardId: 99,
        enabled: true,
        startOffsetSeconds: 0,
        durationSeconds: 1,
        text: '不应保留',
      },
    ],
    [{ storyboardId: 8, durationSeconds: 3 }],
  )

  assert.deepEqual(result, [
    {
      cueId: 'custom-cue',
      storyboardId: 8,
      enabled: true,
      startOffsetSeconds: 0,
      durationSeconds: 3,
      text: '第一行\n第二行',
    },
  ])
})

test('removes subtitle cues whose storyboard clips are disabled', () => {
  const result = normalizeSubtitleCues(
    [
      {
        cueId: 'sb-8-1',
        storyboardId: 8,
        enabled: true,
        startOffsetSeconds: 0,
        durationSeconds: 1,
        text: '这条字幕跟随已禁用镜头',
      },
    ],
    [{ storyboardId: 8, enabled: false, durationSeconds: 3 }],
  )

  assert.deepEqual(result, [])
})

test('renders SRT from edited cues instead of the original storyboard dialogue', () => {
  const timeline = buildMediaTimeline([{ storyboardId: 8, durationSeconds: 3 }])
  const srt = buildSubtitleTextFromCues(
    [
      {
        cueId: 'sb-8-1',
        storyboardId: 8,
        enabled: true,
        startOffsetSeconds: 0.5,
        durationSeconds: 1.25,
        text: '已人工改写的字幕',
      },
    ],
    timeline,
  )

  assert.equal(srt, '1\n00:00:00,500 --> 00:00:01,750\n已人工改写的字幕\n')
})

test('hides speaker labels from burned-in subtitles while keeping the dialogue text', () => {
  const timeline = buildMediaTimeline([{ storyboardId: 8, durationSeconds: 3 }])
  const srt = buildSubtitleTextFromCues(
    [
      {
        cueId: 'audio-1',
        storyboardId: 8,
        startOffsetSeconds: 0,
        durationSeconds: 0.56,
        text: '林夏：……妈？',
      },
      {
        cueId: 'audio-2',
        storyboardId: 8,
        startOffsetSeconds: 1.1,
        durationSeconds: 0.56,
        text: '苏岚（广播）：五。',
      },
    ],
    timeline,
  )

  assert.equal(
    srt,
    '1\n00:00:00,000 --> 00:00:00,560\n……妈？\n\n' +
      '2\n00:00:01,100 --> 00:00:01,660\n五。\n',
  )
})

test('builds a vertical-safe subtitle style with bottom platform margin', () => {
  assert.equal(
    buildSubtitleForceStyle(),
    'FontName=Microsoft YaHei UI,FontSize=64,Bold=1,Outline=5,BorderStyle=1,Shadow=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,ShadowColour=&H80000000,Alignment=2,MarginL=72,MarginR=72,MarginV=300,WrapStyle=2,PlayResX=1080,PlayResY=1920',
  )
})

test('shifts only dialogue subtitles when lip-sync compensation is enabled', () => {
  assert.deepEqual(
    shiftDialogueSubtitleCues(
      [
        {
          cueId: 'audio-170',
          storyboardId: 186,
          enabled: true,
          startOffsetSeconds: 0,
          durationSeconds: 0.56,
          text: '林夏：……妈？',
        },
        {
          cueId: 'audio-171',
          storyboardId: 186,
          enabled: true,
          startOffsetSeconds: 1.1,
          durationSeconds: 0.56,
          text: '苏岚（广播）：五。',
        },
      ],
      [{ id: 170 }],
      0.16,
    ),
    [
      {
        cueId: 'audio-170',
        storyboardId: 186,
        enabled: true,
        startOffsetSeconds: 0.16,
        durationSeconds: 0.56,
        text: '林夏：……妈？',
      },
      {
        cueId: 'audio-171',
        storyboardId: 186,
        enabled: true,
        startOffsetSeconds: 1.1,
        durationSeconds: 0.56,
        text: '苏岚（广播）：五。',
      },
    ],
  )
})
