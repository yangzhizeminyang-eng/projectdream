import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSpokenDialogue } from './audio-dialogue.mjs'

test('removes the speaker and performance direction from spoken dialogue', () => {
  assert.equal(extractSpokenDialogue('苏岚（广播，轻而清晰）：十。', '苏岚'), '十。')
  assert.equal(
    extractSpokenDialogue('周衡（厉声）：“别动它，立刻切断！”', '周衡'),
    '别动它，立刻切断！',
  )
  assert.equal(extractSpokenDialogue('林夏：“你是谁？”', '林夏'), '你是谁？')
})

test('keeps dialogue without a matching speaker prefix unchanged', () => {
  assert.equal(extractSpokenDialogue('注意：列车即将进站。', '林夏'), '注意：列车即将进站。')
  assert.equal(extractSpokenDialogue('你终于来了。', '林夏'), '你终于来了。')
})

test('selects only the currently bound character from multiline dialogue', () => {
  const dialogue = ['林夏：“你是谁？”', '周衡（压低声音）：“别回头。”', '林夏：“为什么？”'].join('\n')
  assert.equal(extractSpokenDialogue(dialogue, '林夏'), '你是谁？\n为什么？')
  assert.equal(extractSpokenDialogue(dialogue, '周衡'), '别回头。')
})

test('selects the bound character when several speakers share one line', () => {
  const dialogue = '苏岚（广播）：八。林夏：停。别装神弄鬼。'
  assert.equal(extractSpokenDialogue(dialogue, '苏岚'), '八。')
  assert.equal(extractSpokenDialogue(dialogue, '林夏'), '停。别装神弄鬼。')
})

test('does not guess a speaker when multiple labelled roles exist without a character', () => {
  const dialogue = ['林夏：“你是谁？”', '周衡：“别回头。”'].join('\n')
  assert.equal(extractSpokenDialogue(dialogue), dialogue)
})
