import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildGenrePromptContext,
  resolveGenreSkillProfile,
} from './genre-skill-profile.mjs'

test('resolves the selected category to a deterministic skill profile', () => {
  assert.equal(resolveGenreSkillProfile('悬疑推理漫剧').key, 'mystery')
  assert.equal(resolveGenreSkillProfile('成长逆袭漫剧').key, 'growth')
  assert.equal(resolveGenreSkillProfile('未知类型').key, 'mystery')
})

test('prompt context contains auditable rules rather than UI-only labels', () => {
  const context = buildGenrePromptContext('科幻剧情片')
  assert.match(context, /题材技能配置：科幻剧情/)
  assert.match(context, /构图规则/)
  assert.match(context, /连续性规则/)
  assert.match(context, /禁止事项/)
  assert.match(context, /设备接口/)
})

test('asset prompt contexts are scoped so character and scene rules do not cross domains', () => {
  const character = buildGenrePromptContext('都市悬疑', 'character')
  const scene = buildGenrePromptContext('都市悬疑', 'scene')
  assert.match(character, /只输出角色外貌/)
  assert.doesNotMatch(character, /只输出空场空间/)
  assert.match(scene, /只输出空场空间/)
  assert.doesNotMatch(scene, /只输出角色外貌/)
})
