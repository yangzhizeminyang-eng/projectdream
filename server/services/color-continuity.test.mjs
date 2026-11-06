import assert from 'node:assert/strict'
import test from 'node:test'

import { buildColorContinuityConstraints } from './color-continuity.mjs'

test('color continuity turns a cold-blue sci-fi style into a locked color bible', () => {
  const prompt = buildColorContinuityConstraints({
    visualStyle: '冷峻科幻，冷蓝金属与红色警示灯',
    scenePrompt: '深夜公寓客厅，百叶窗投下冷蓝色光条，电脑冷白屏幕光。',
  })

  assert.match(prompt, /主色锚点：冷蓝、青蓝、低饱和金属灰/)
  assert.match(prompt, /红色仅限局部警示灯/)
  assert.match(prompt, /肤色、黑色服装和眼镜材质不得被强烈染色/)
  assert.match(prompt, /禁止全画面蓝染、红染/)
  assert.match(prompt, /起始帧到结束帧保持同一白平衡、曝光和饱和度关系/)
})

test('color continuity preserves explicit scene color evidence without inventing a new palette', () => {
  const prompt = buildColorContinuityConstraints({
    visualStyle: '写实电影感',
    scenePrompt: '暖黄色台灯为主光，墙面是灰绿色，窗外只有微弱中性月光。',
    shotPrompt: '镜头缓慢推进，人物保持自然肤色。',
  })

  assert.match(prompt, /项目与场景中的既有色彩设定是唯一调色来源/)
  assert.match(prompt, /暖黄色台灯/)
  assert.match(prompt, /灰绿色/)
  assert.match(prompt, /不得擅自加入青橙、紫色或霓虹渐变/)
  assert.match(prompt, /镜头运动不能造成色温跳变、闪烁或曝光呼吸/)
})

test('color continuity stays useful when no explicit palette exists', () => {
  const prompt = buildColorContinuityConstraints({
    visualStyle: '',
    scenePrompt: '',
    shotPrompt: '室内对白，中景。',
  })

  assert.match(prompt, /没有明确色板时，保持参考资产的真实颜色和中性白平衡/)
  assert.match(prompt, /禁止全画面单色滤镜/)
})

test('color continuity extracts bounded color evidence from long asset prompts', () => {
  const prompt = buildColorContinuityConstraints({
    visualStyle: '悬疑短剧',
    scenePrompt: `${'资产生成模板与排版要求。'.repeat(5000)}夜班值班台，唯一主光为台灯暖黄色，走廊尽头是绿色安全出口灯。`,
    shotPrompt: '角色抬头看向走廊。',
  })

  assert.ok(prompt.length < 2500)
  assert.match(prompt, /暖黄色/)
  assert.match(prompt, /绿色安全出口灯/)
  assert.doesNotMatch(prompt, /资产生成模板与排版要求/u)
})
