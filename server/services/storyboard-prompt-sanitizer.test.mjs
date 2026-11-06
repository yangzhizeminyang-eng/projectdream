import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeStoryboardPrompt } from './storyboard-prompt-sanitizer.mjs'

test('removes an accidentally appended character asset-generation template', () => {
  const clean = sanitizeStoryboardPrompt([
    '@唐宁、@赵衡、@场景01；赵衡把签字笔推到协议旁并说“签了，对大家都好”。',
    '提示词模板技能：prompt-template-skill-v1',
    '参考模板来源：角色生成提示词模板.txt + 角色三视图.txt',
    '角色资产板必须一次生成横向16:9的一张完整母板。',
    '纯白背景，无场景，无对白。',
  ].join('\n'))

  assert.equal(clean, '@唐宁、@赵衡、@场景01；赵衡把签字笔推到协议旁并说“签了，对大家都好”。')
})

test('keeps ordinary shot prompts, dialogue, mentions and intentional white-background shots', () => {
  const prompt = '@道具：白色协议放在桌面。@赵衡说“签了，对大家都好”，镜头缓慢推进。'
  assert.equal(sanitizeStoryboardPrompt(prompt), prompt)
})

test('removes older asset-scope tails without requiring a version marker', () => {
  const clean = sanitizeStoryboardPrompt(
    '镜头中唐宁抬眼看向赵衡。对白：签了，对大家都好。\n资产范围：只输出角色外貌、发型、妆容、身体、服装和配饰的可复现规则。',
  )
  assert.equal(clean, '镜头中唐宁抬眼看向赵衡。对白：签了，对大家都好。')
})

test('removes role-specific appearance prose when the shot is bound to a confirmed character asset', () => {
  const prompt = sanitizeStoryboardPrompt(
    '@唐宁；唐宁抬眼看向赵衡，手停在桌沿。唐宁（28岁女性，鹅蛋脸，黑色长发低马尾，浅蓝衬衫、米色西装外套）冷静克制。',
    { characterNames: ['唐宁'] },
  )
  assert.match(prompt, /^@唐宁；唐宁抬眼看向赵衡，手停在桌沿。/u)
  assert.doesNotMatch(prompt, /28岁女性|鹅蛋脸|长发低马尾|浅蓝衬衫|西装外套/u)
})
