import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFramePromptRewritePrompts, rewriteFrameVisualPrompt } from './frame-prompt.mjs'

const ctx = {
  project: {
    name: '雨夜档案',
    category: '悬疑',
    visualStyle: '黑色电影风格，低照度，高反差，冷色霓虹反光',
    narrativeVision: '围绕失踪病历与家族秘密推进。',
  },
  outline: {
    title: '雨夜档案',
    summary: '女主在旧档案室找到关键遗物。',
  },
  scene: {
    scene_no: 3,
    title: '旧档案室',
    location: '城市医院旧档案室',
    time_of_day: '夜',
    summary: '温叙独自进入旧档案室，找到被水渍浸湿的遗物箱。',
    content: '暴雨敲打窗户。温叙翻开病历，发现夹层里藏着一张旧照片。',
  },
  storyboard: {
    shot_no: '03',
    shot_type: '中景',
    camera_angle: '平视机位',
    composition: '单点透视构图',
    character_name: '温叙',
    action_text: '温叙在旧木桌前翻开病历夹层。',
    dialogue_text: '（无对白）',
    visual_prompt: '温叙，鹅蛋脸，黑色长发，站在档案室里。',
  },
  characters: [
    {
      name: '温叙',
      role_tag: '女主角',
      gender: 'female',
      age_group: 'young_adult',
      appearance: '黑色长发，浅色风衣，米白针织衫。',
      reference_image_url: 'https://example.com/wenxu.png',
    },
  ],
}

test('frame prompt rewrite prompt tells model not to rewrite appearance', () => {
  const prompts = buildFramePromptRewritePrompts(ctx)

  assert.match(prompts.systemPrompt, /严禁/)
  assert.match(prompts.systemPrompt, /角色外貌由系统后续的定妆图/)
  assert.match(prompts.userPrompt, /不要改写外貌/)
})

test('mock frame prompt rewrite focuses on action and leaves appearance to constraints', async () => {
  const previousProvider = process.env.AI_PROVIDER
  process.env.AI_PROVIDER = 'mock'
  try {
    const result = await rewriteFrameVisualPrompt(ctx)

    assert.match(result.visualPrompt, /温叙/)
    assert.match(result.visualPrompt, /定妆图与角色一致性约束/)
    assert.doesNotMatch(result.visualPrompt, /鹅蛋脸/)
    assert.doesNotMatch(result.visualPrompt, /黑色长发/)
    assert.doesNotMatch(result.visualPrompt, /浅色风衣/)
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_PROVIDER
    } else {
      process.env.AI_PROVIDER = previousProvider
    }
  }
})
