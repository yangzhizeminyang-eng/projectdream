import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMentionContextPrompt,
  normalizeStoryboardMentionContext,
} from './storyboard-mention-context.mjs'

test('normalizes character, scene, prop, tool and voice mentions into executable context', () => {
  const context = normalizeStoryboardMentionContext({
    referencedAssets: [
      {
        kind: 'character',
        name: '唐宁',
        imageUrl: 'https://cdn.test/tangning-full.png',
        promptText: '浅蓝衬衫、米色西装外套',
        viewKeys: ['front', 'side', 'back'],
        viewSetVersion: 2,
        voiceProfileKey: 'female-calm',
        voiceLocked: true,
      },
      { kind: 'scene', name: '合规办公室', imageUrl: 'https://cdn.test/office-panorama.png' },
      { kind: 'prop', name: '离职协议', imageUrl: 'https://cdn.test/agreement.png' },
    ],
    tools: [{ name: '首尾帧参考' }, { name: '环境音' }],
    voiceBindings: [{ characterName: '唐宁', voiceProfileKey: 'female-calm', voiceLocked: true }],
  })

  const prompt = buildMentionContextPrompt(context)
  assert.match(prompt, /@唐宁（角色）/)
  assert.match(prompt, /@合规办公室（场景）/)
  assert.match(prompt, /@离职协议（道具）/)
  assert.match(prompt, /必须读取并保持一致/)
  assert.match(prompt, /@首尾帧参考（工具）/)
  assert.match(prompt, /@音色\[唐宁\]/)
})

test('unknown tool mentions do not silently become executable instructions', () => {
  const context = normalizeStoryboardMentionContext({ tools: [{ name: '未知工具' }] })
  assert.deepEqual(context.tools, [])
  assert.equal(buildMentionContextPrompt(context), '')
})

test('片段衔接 keeps the selected source shot instead of becoming an unscoped trailing tool', () => {
  const context = normalizeStoryboardMentionContext({
    prompt: '唐宁抬眼 @片段衔接[镜头02]',
    tools: [{ name: '片段衔接' }],
  })
  assert.equal(context.tools[0].from, '镜头02')
  assert.match(buildMentionContextPrompt(context), /@片段衔接\[镜头02\]/)
})

test('video mention context never expands asset-generation templates into the video prompt', () => {
  const prompt = buildMentionContextPrompt(normalizeStoryboardMentionContext({
    referencedAssets: [{
      kind: 'scene',
      name: '夜班值班台',
      imageUrl: 'https://cdn.test/scene.png',
      promptText: '完整资产板布局 '.repeat(5000),
    }],
  }))

  assert.match(prompt, /资产外观只读取已确认参考图/)
  assert.doesNotMatch(prompt, /完整资产板布局/u)
  assert.ok(prompt.length < 1000)
})
