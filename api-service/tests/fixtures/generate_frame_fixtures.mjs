/**
 * @file frameCharacterContext 期望 fixture 生成脚本（一次性 Node 脚本，CI 零依赖）。
 *
 * 直接 import Node 真实实现 `server/services/frame-character-consistency.mjs`
 * （该模块仅依赖 ./voice-profiles.mjs，无 DB / 网络 / 进程副作用），
 * 对 10 种输入形态产出 resolveFrameCharacterContext 的期望 JSON，
 * 写入本目录 `frame_character_fixtures.json`，供
 * `tests/test_frame_character_fixtures.py` 做逐字段对照。
 *
 * 重新生成命令（在仓库根目录执行）：
 *
 *   node api-service/tests/fixtures/generate_frame_fixtures.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveFrameCharacterContext } from '../../../server/services/frame-character-consistency.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// 覆盖 ≥8 种形态：无角色/空值、单角色已确认、声音角色绑定（屏幕文字）、
// 声音角色可见人物未点名、画外音显式离屏、缺定妆图、多角色同框、
// 绑定 id 直连、角色名无法匹配、角色标签多义。
const cases = [
  {
    name: 'empty_storyboard_no_characters',
    description: '边界空值：分镜全空 + 角色库为空 → characterFree',
    storyboard: {
      id: 101, scene_id: 11, shot_no: '01', character_id: null,
      character_name: null, action_text: null, visual_prompt: null,
      duration_seconds: 4,
    },
    characters: [],
  },
  {
    name: 'single_character_confirmed',
    description: '单角色已确认：character_name 精确命中，档案齐全 + 定妆图 URL',
    storyboard: {
      id: 102, scene_id: 11, shot_no: '02', character_id: null,
      character_name: '林知夏',
      action_text: '林知夏站在值班台前，盯住异常信号灯。',
      visual_prompt: '固定中景，林知夏在监控室里转身看向屏幕。',
      duration_seconds: 5,
    },
    characters: [
      {
        id: 9, name: '林知夏', role_tag: '主角', personality: '克制冷静',
        appearance: '黑色短发，灰色风衣', age_group: 'young_adult', gender: 'female',
        reference_image_url: 'https://media.example.com/character-9.png', status: 'confirmed',
      },
      {
        id: 12, name: '陈默', role_tag: '配角', personality: '沉默寡言',
        appearance: '寸头，深色夹克', age_group: 'middle_aged', gender: 'male',
        reference_image_url: 'https://media.example.com/character-12.png', status: 'confirmed',
      },
    ],
  },
  {
    name: 'audio_only_identity_screen_mention',
    description: '声音角色绑定：AI 终端仅以屏幕文字出现 → 降级为无角色（characterFree）',
    storyboard: {
      id: 103, scene_id: 11, shot_no: '03', character_id: null,
      character_name: 'AI终端',
      action_text: '电脑屏幕显示AI终端的警告文字。',
      visual_prompt: '特写键盘与屏幕，冷色轮廓光。',
      duration_seconds: 4,
    },
    characters: [
      {
        id: 20, name: 'AI终端', role_tag: '系统终端', personality: '无情绪',
        appearance: '无实体', age_group: null, gender: 'neutral',
        reference_image_url: null, status: 'confirmed',
      },
    ],
  },
  {
    name: 'audio_identity_visual_presence_unnamed',
    description: '声音角色绑定：画面出现可见人物但未点名 → blocker',
    storyboard: {
      id: 104, scene_id: 11, shot_no: '04', character_id: null,
      character_name: 'AI终端',
      action_text: '人物站在终端前盯着屏幕。',
      visual_prompt: '中景，冷色光影。',
      duration_seconds: 4,
    },
    characters: [
      {
        id: 20, name: 'AI终端', role_tag: '系统终端', personality: '无情绪',
        appearance: '无实体', age_group: null, gender: 'neutral',
        reference_image_url: null, status: 'confirmed',
      },
    ],
  },
  {
    name: 'explicit_offscreen_voiceover',
    description: '画外音：镜头明确不出现人物且仅有画外音 → characterFree',
    storyboard: {
      id: 105, scene_id: 11, shot_no: '05', character_id: null,
      character_name: '温叙',
      action_text: '温叙的画外音响起。',
      visual_prompt: '温叙的画外音响起，镜头中没有任何人物出现，空荡走廊。',
      duration_seconds: 6,
    },
    characters: [
      {
        id: 31, name: '温叙', role_tag: '旁白', personality: '低沉',
        appearance: '不出现正脸', age_group: 'young_adult', gender: 'male',
        reference_image_url: null, status: 'confirmed',
      },
    ],
  },
  {
    name: 'missing_reference_image',
    description: '缺定妆图：档案齐全但无 reference_image_url → blocker',
    storyboard: {
      id: 106, scene_id: 11, shot_no: '06', character_id: null,
      character_name: '陈默',
      action_text: '陈默走进机房，扫视主节点日志。',
      visual_prompt: '中景，机房冷光。',
      duration_seconds: 5,
    },
    characters: [
      {
        id: 12, name: '陈默', role_tag: '配角', personality: '沉默寡言',
        appearance: '寸头，深色夹克', age_group: 'middle_aged', gender: 'male',
        reference_image_url: null, status: 'confirmed',
      },
    ],
  },
  {
    name: 'multiple_characters_same_frame',
    description: '多角色：主角色绑定 + 另一角色在动作文本被同屏提及',
    storyboard: {
      id: 107, scene_id: 11, shot_no: '07', character_id: null,
      character_name: '林知夏',
      action_text: '林知夏把档案递给陈默，两人对视。',
      visual_prompt: '过肩镜头，两人隔桌对坐。',
      duration_seconds: 6,
    },
    characters: [
      {
        id: 9, name: '林知夏', role_tag: '主角', personality: '克制冷静',
        appearance: '黑色短发，灰色风衣', age_group: 'young_adult', gender: 'female',
        reference_image_url: 'https://media.example.com/character-9.png', status: 'confirmed',
      },
      {
        id: 12, name: '陈默', role_tag: '配角', personality: '沉默寡言',
        appearance: '寸头，深色夹克', age_group: 'middle_aged', gender: 'male',
        reference_image_url: 'https://media.example.com/character-12.png', status: 'confirmed',
      },
    ],
  },
  {
    name: 'bound_by_character_id',
    description: '绑定 id 直连：character_id 命中角色库 → primaryCharacterId',
    storyboard: {
      id: 108, scene_id: 11, shot_no: '08', character_id: 12,
      character_name: '陈默（旧名）',
      action_text: '陈默坐进值班椅。',
      visual_prompt: '近景，侧光。',
      duration_seconds: 4,
    },
    characters: [
      {
        id: 12, name: '陈默', role_tag: '配角', personality: '沉默寡言',
        appearance: '寸头，深色夹克', age_group: 'middle_aged', gender: 'male',
        reference_image_url: 'https://media.example.com/character-12.png', status: 'confirmed',
      },
    ],
  },
  {
    name: 'unmatched_character_name',
    description: '角色未确认绑定：character_name 无法匹配角色库 → blocker',
    storyboard: {
      id: 109, scene_id: 11, shot_no: '09', character_id: null,
      character_name: '无名路人',
      action_text: '无名路人走过大厅。',
      visual_prompt: '全景。',
      duration_seconds: 4,
    },
    characters: [
      {
        id: 9, name: '林知夏', role_tag: '主角', personality: '克制冷静',
        appearance: '黑色短发', age_group: 'young_adult', gender: 'female',
        reference_image_url: 'https://media.example.com/character-9.png', status: 'confirmed',
      },
    ],
  },
  {
    name: 'ambiguous_role_label',
    description: '角色标签多义：character_name=配角 命中多个配角 → blocker',
    storyboard: {
      id: 110, scene_id: 11, shot_no: '10', character_id: null,
      character_name: '配角',
      action_text: '配角接起电话。',
      visual_prompt: '近景。',
      duration_seconds: 4,
    },
    characters: [
      {
        id: 12, name: '陈默', role_tag: '配角', personality: '沉默寡言',
        appearance: '寸头', age_group: 'middle_aged', gender: 'male',
        reference_image_url: 'https://media.example.com/character-12.png', status: 'confirmed',
      },
      {
        id: 15, name: '苏禾', role_tag: '配角', personality: '机敏',
        appearance: '马尾辫', age_group: 'young_adult', gender: 'female',
        reference_image_url: 'https://media.example.com/character-15.png', status: 'confirmed',
      },
    ],
  },
]

const fixtures = cases.map((item) => ({
  name: item.name,
  description: item.description,
  storyboard: item.storyboard,
  characters: item.characters,
  expected: resolveFrameCharacterContext(item.storyboard, item.characters),
}))

const target = join(here, 'frame_character_fixtures.json')
writeFileSync(target, `${JSON.stringify({ generator: 'node server/services/frame-character-consistency.mjs', cases: fixtures }, null, 2)}\n`, 'utf8')
console.log(`wrote ${fixtures.length} frame character fixtures -> ${target}`)
