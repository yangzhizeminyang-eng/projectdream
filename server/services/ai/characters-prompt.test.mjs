import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCharacterExtractionPrompts } from './prompts/characters.mjs'

test('character extraction receives the confirmed story bible visual baseline', () => {
  const result = buildCharacterExtractionPrompts({
    project: { name: '死去的老板给我发邮件', category: '都市职场悬疑', visualStyle: '冷峻科幻' },
    scenes: [{ scene_no: 1, title: '别签字', content: '唐宁拒绝签署离职协议。' }],
    storyBible: {
      characters: [{
        name: '唐宁',
        role: '主角',
        visualDescription: '浅蓝衬衫、米色西装外套、银色腕表、黑色长发低马尾',
      }],
    },
  })

  assert.match(result.userPrompt, /已确认故事设定中的角色视觉基线/)
  assert.match(result.userPrompt, /浅蓝衬衫、米色西装外套、银色腕表、黑色长发低马尾/)
  assert.match(result.systemPrompt, /costume 必须单独写出/)
  assert.match(result.systemPrompt, /图像提示词结构必须覆盖/)
  assert.match(result.systemPrompt, /角色资产先锁定单人正面全身基准/)
})
