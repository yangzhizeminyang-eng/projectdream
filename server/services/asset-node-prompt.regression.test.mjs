import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAssetNodeViewPrompt } from './asset-node-prompt.mjs'

test('character turnaround prompt is isolated from scene and story context', () => {
  const result = buildAssetNodeViewPrompt({
    node: {
      nodeType: 'character',
      label: '唐宁',
      promptText: '深夜回到家，电脑屏幕亮起，冷蓝金属机房，红色警示灯',
    },
    character: {
      name: '唐宁',
      appearance: '黑色长发，浅蓝衬衫，米色西装外套',
      costume: '银色腕表',
    },
    projectVisualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
    viewType: 'character-turnaround',
    viewKey: 'back',
    baseReferenceImageUrl: 'https://cdn.test/tangning-base.png',
  })

  assert.doesNotMatch(result.prompt, /深夜回到家|电脑屏幕|冷峻科幻/)
  assert.match(result.prompt, /纯白色摄影棚背景/)
  assert.match(result.prompt, /背面硬约束/)
  assert.match(result.prompt, /从头顶到鞋底的完整全身照/)
  assert.deepEqual(result.referenceImageUrls, ['https://cdn.test/tangning-base.png'])
})
