import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAudioSourceTitle,
  isMalformedAudioTitle,
  resolveAudioSourceTitle,
} from './audio-title.mjs'

test('detects titles whose Chinese text was replaced by question marks', () => {
  assert.equal(isMalformedAudioTitle('????? ? 06 - ??'), true)
  assert.equal(isMalformedAudioTitle('音乐轨 - ?????-1784607108949'), true)
  assert.equal(isMalformedAudioTitle('对白轨 · 06 - 林夏'), false)
  assert.equal(isMalformedAudioTitle('What?? now'), false)
  assert.equal(isMalformedAudioTitle('为什么？'), false)
})

test('builds a dialogue title from relational metadata', () => {
  assert.equal(
    buildAudioSourceTitle({
      trackType: 'dialogue',
      sceneNo: 1,
      sceneTitle: '零点检修',
      shotNo: '06',
      characterName: '林夏',
    }),
    '对白轨 · 06 - 林夏',
  )
})

test('replaces a malformed stored title but keeps a valid custom title', () => {
  const row = {
    title: '????? ? 06 - ??',
    track_type: 'dialogue',
    scene_no: 1,
    scene_title: '零点检修',
    shot_no: '06',
    character_name: '林夏',
  }
  assert.equal(resolveAudioSourceTitle(row), '对白轨 · 06 - 林夏')
  assert.equal(resolveAudioSourceTitle({ ...row, title: '紧急呼叫' }), '紧急呼叫')
  assert.equal(
    resolveAudioSourceTitle({
      title: '音乐轨 - ?????-1784607108949',
      track_type: 'music',
      project_name: '?????-1784607108949',
    }),
    '音乐轨 - 项目',
  )
})
