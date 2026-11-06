import assert from 'node:assert/strict'
import test from 'node:test'

import { buildUnifiedStoryboardPrompt, parseUnifiedStoryboardPrompt } from './storyboard-prompt.mjs'

test('unified storyboard prompt round-trips visual, action, dialogue and frame continuity fields', () => {
  const source = {
    visualPrompt: '@唐宁 @审讯室 冷蓝灯光下，她盯着桌面。',
    actionText: '她先攥紧手指，再缓慢抬眼。',
    dialogueText: '压低声音，停顿半秒：我没有签。',
    startVisualPrompt: '手指压住协议边缘。',
    endVisualPrompt: '视线越过对方肩膀。',
  }

  const prompt = buildUnifiedStoryboardPrompt(source)
  assert.match(prompt, /画面与资产：@唐宁 @审讯室/)
  assert.match(prompt, /动作与表演：她先攥紧手指/)
  assert.match(prompt, /对白与声音：压低声音/)
  assert.deepEqual(parseUnifiedStoryboardPrompt(prompt), source)
})

test('unified storyboard prompt preserves freeform text and reads older unstructured prompts', () => {
  assert.deepEqual(parseUnifiedStoryboardPrompt('冷色调，镜头缓慢推进。'), {
    visualPrompt: '冷色调，镜头缓慢推进。',
    actionText: '',
    dialogueText: '',
    startVisualPrompt: '',
    endVisualPrompt: '',
  })
})

test('unified storyboard prompt keeps a stable section order and omits empty sections', () => {
  assert.equal(buildUnifiedStoryboardPrompt({
    visualPrompt: '夜间办公室。',
    actionText: '',
    dialogueText: '赵衡：签字。',
    startVisualPrompt: '',
    endVisualPrompt: '唐宁没有抬头。',
  }), [
    '画面与资产：夜间办公室。',
    '对白与声音：赵衡：签字。',
    '结束帧衔接：唐宁没有抬头。',
  ].join('\n\n'))
})
