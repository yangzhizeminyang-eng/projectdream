import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPromptTemplateContext,
  PROMPT_TEMPLATE_SKILL_VERSION,
} from './prompt-template-skill.mjs'

test('character template skill exposes the supplied identity-sheet constraints', () => {
  const context = buildPromptTemplateContext('character')

  assert.match(context, new RegExp(PROMPT_TEMPLATE_SKILL_VERSION))
  assert.match(context, /头部细节/)
  assert.match(context, /脸型、眉毛、眼睛、鼻子、嘴唇、耳廓和下颌线/)
  assert.match(context, /纯白纯色背景/)
  assert.match(context, /从头到脚完整呈现/)
  assert.match(context, /A-Pose/)
})

test('scene template skill keeps environment prompts spatial and character-free', () => {
  const context = buildPromptTemplateContext('scene')

  assert.match(context, /architecture、opening、fixed_furniture、material、light/u)
  assert.match(context, /全景阶段必须输出可持久化的 spatial_anchors JSON/u)
  assert.match(context, /光源结合时间天气、剧情氛围和实体灯具/u)
  assert.match(context, /禁止角色.*动作.*对白.*声音.*水印/u)
  assert.match(context, /唯一空场母版/u)
  assert.match(context, /spatial_anchors.*JSON/u)
  assert.match(context, /材质与光源必须根据本场剧情设计/u)
  assert.match(context, /子机位只写母版继承声明/u)
  assert.doesNotMatch(context, /固定采用冷蓝.*暖黄.*红色/u)
  assert.match(context, /普通宽幅母图.*参考图引导候选/u)
  assert.doesNotMatch(context, /只改变摄像机位置/u)
  assert.ok(context.length < 2200, 'scene skill should stay compact and avoid repeated contracts')
})

test('prop template skill stays focused on one reusable object', () => {
  const context = buildPromptTemplateContext('prop')

  assert.match(context, /道具身份与剧情用途/)
  assert.match(context, /开口、按钮、接口、可动部位/)
  assert.match(context, /默认只生成一件完整道具/)
  assert.match(context, /正面、严格侧面、背面和俯视/)
  assert.match(context, /禁止角色、手持、人体、场景/)
  assert.match(context, /外观必须从剧情提取/)
  assert.match(context, /可固化在本体上的剧情线索/u)
  assert.match(context, /事实与推断/u)
  assert.match(context, /避免生成只有通用外形的商品图/u)
  assert.match(context, /只生成资产库白底单体母版\/视角参考/u)
  assert.match(context, /道具被发现、观看、拿取和操作的剧情画面由分镜 Agent 按当前剧本生成/u)
  assert.doesNotMatch(context, /门窗方向、固定物件位置/)
})

test('storyboard template skill keeps visible shot sheets separate from internal performance analysis', () => {
  const context = buildPromptTemplateContext('storyboard')

  assert.match(context, /紧凑分镜单/u)
  assert.match(context, /时间段总长严格等于本镜duration_seconds/u)
  assert.match(context, /避免平均分配和固定频率套模板/u)
  assert.match(context, /不要重复粘贴整组分析字段/u)
  assert.match(context, /不在对白和声音栏目重复台词/u)
  assert.match(context, /@角色、@场景、@道具和@音色/)
  assert.match(context, /资产库母版与剧情镜头是不同任务/u)
  assert.match(context, /精确可读文字交由后期合成/u)
  assert.match(context, /gaze_plan/u)
  assert.match(context, /sound_plan/u)
})

test('video template skill locks wardrobe construction and physical screen-space interactions', () => {
  const context = buildPromptTemplateContext('video')

  assert.match(context, /服装结构锁定/u)
  assert.match(context, /衣领、前襟、闭合方式/u)
  assert.match(context, /遮挡顺序/u)
  assert.match(context, /接触点/u)
  assert.match(context, /单一主运动/u)
  assert.match(context, /一轮只修一个主要问题/u)
  assert.match(context, /180度轴线/u)
  assert.match(context, /道具归属与交接状态/u)
  assert.match(context, /新角色入场/u)
})

test('scoped template skills do not leak another asset domain', () => {
  const character = buildPromptTemplateContext('character')
  const scene = buildPromptTemplateContext('scene')

  assert.doesNotMatch(character, /禁止角色、动作、对白和表演/)
  assert.doesNotMatch(scene, /A-Pose/)
})
