import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeCharactersPayload,
  normalizeStoryboardPayload,
} from './parsers.mjs'
import { buildStoryboardPrompts } from './prompts/storyboard.mjs'

test('storyboard character labels resolve to an existing project character name', () => {
  const result = normalizeStoryboardPayload(
    {
      scene_id: 9,
      shots: [
        {
          shot_no: 1,
          character_name: '主角',
          visual_prompt: '主角站在走廊尽头',
        },
      ],
    },
    {
      sceneId: 9,
      scene: { id: 9, estimated_duration: 60 },
      project: { visualStyle: '电影感写实风格' },
      characters: [
        { id: 5, name: '沈砚', role_tag: '主角｜记忆修复师' },
        { id: 6, name: '程默', role_tag: '关键配角' },
      ],
    },
  )

  assert.equal(result.shots[0].character_name, '沈砚')
})

test('character payload removes duplicate names and normalizes voice traits', () => {
  const result = normalizeCharactersPayload({
    characters: [
      { name: '沈砚', role_tag: '主角', voice_setting: 'unknown', age_group: 'middle_aged', gender: 'female' },
      { name: '沈砚', role_tag: '重复角色', voice_setting: 'Cherry' },
      { name: '程默', role_tag: '配角', voice_setting: 'ethan' },
    ],
  })

  assert.deepEqual(
    result.characters.map((item) => item.name),
    ['沈砚', '程默'],
  )
  assert.equal(result.characters[0].voice_setting, null)
  assert.equal(result.characters[0].age_group, 'middle_aged')
  assert.equal(result.characters[0].gender, 'female')
  assert.equal(result.characters[1].voice_setting, 'Ethan')
})

test('storyboard prompts include the established character bible', () => {
  const prompts = buildStoryboardPrompts({
    project: { name: '记忆修复', visualStyle: '冷色电影感' },
    scene: { scene_no: 1, title: '走廊', content: '沈砚走进走廊。' },
    scriptContent: '沈砚走进走廊。',
    characters: [
      {
        name: '沈砚',
        role_tag: '主角｜记忆修复师',
        gender: 'female',
        age_group: 'young_adult',
        appearance: '黑色短发，深灰制服，右眉有细疤。',
      },
    ],
  })

  assert.match(prompts.systemPrompt, /准确姓名/)
  assert.match(prompts.userPrompt, /姓名=沈砚/)
  assert.match(prompts.userPrompt, /右眉有细疤/)
  assert.match(prompts.userPrompt, /性别=female/)
  assert.match(prompts.userPrompt, /年龄段=young_adult/)
  assert.match(prompts.systemPrompt, /绝对不能改变角色性别/)
})
