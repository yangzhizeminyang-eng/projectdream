/**
 * @file 静帧视觉提示词重写
 * @description 基于项目、场景、剧本、分镜和角色上下文生成可用于静帧的场景/动作/镜头提示词。
 */

import { getAiConfig, isMockProvider } from './config.mjs'
import { generateStructuredJson } from './provider.mjs'

function text(value, fallback = '') {
  const normalized = String(value == null ? '' : value).trim()
  return normalized || fallback
}

function clip(value, maxLength) {
  return text(value).slice(0, maxLength)
}

function characterLine(character) {
  return [
    `姓名=${character?.name || ''}`,
    `身份=${character?.role_tag || character?.roleTag || ''}`,
    `性别=${character?.gender || '未明确'}`,
    `年龄段=${character?.age_group || character?.ageGroup || '未明确'}`,
    character?.reference_image_url || character?.referenceImageUrl ? '已确认定妆图=是' : '已确认定妆图=否',
    character?.appearance ? `固定外貌已存在，禁止在视觉提示词中重新描述脸、发型、服装` : '',
  ]
    .filter(Boolean)
    .join('；')
}

function shotBrief(storyboard = {}) {
  return [
    storyboard.shot_no || storyboard.shotNo ? `分镜号：${storyboard.shot_no || storyboard.shotNo}` : '',
    storyboard.shot_type || storyboard.shotType ? `景别：${storyboard.shot_type || storyboard.shotType}` : '',
    storyboard.camera_angle || storyboard.cameraAngle ? `机位：${storyboard.camera_angle || storyboard.cameraAngle}` : '',
    storyboard.composition ? `构图：${storyboard.composition}` : '',
    storyboard.character_name || storyboard.characterName ? `出镜角色：${storyboard.character_name || storyboard.characterName}` : '',
    storyboard.action_text || storyboard.actionText ? `原动作：${storyboard.action_text || storyboard.actionText}` : '',
    storyboard.dialogue_text || storyboard.dialogueText ? `对白：${storyboard.dialogue_text || storyboard.dialogueText}` : '',
    storyboard.visual_prompt || storyboard.visualPrompt ? `原视觉提示词：${clip(storyboard.visual_prompt || storyboard.visualPrompt, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function buildMockVisualPrompt(ctx = {}) {
  const project = ctx.project || {}
  const scene = ctx.scene || {}
  const storyboard = ctx.storyboard || {}
  const characterName = text(storyboard.character_name || storyboard.characterName)
  const action = text(
    storyboard.action_text || storyboard.actionText,
    characterName ? `${characterName}根据剧情推进做出克制而明确的动作` : '镜头捕捉场景中的关键变化',
  )
  const shotType = text(storyboard.shot_type || storyboard.shotType, '中景')
  const cameraAngle = text(storyboard.camera_angle || storyboard.cameraAngle, '平视机位')
  const composition = text(storyboard.composition, '电影感构图')
  return [
    text(project.visual_style || project.visualStyle, '电影感写实风格'),
    `${text(scene.location, '当前场景')}，${text(scene.time_of_day || scene.timeOfDay, '夜')}，${shotType}，${cameraAngle}，${composition}`,
    text(scene.summary, ''),
    action,
    characterName ? `${characterName}出现在画面中，但人物脸部、发型、体态、服装和随身物件严格交由定妆图与角色一致性约束决定，视觉提示词不重新改写外貌` : '',
    '强调环境信息、叙事动作、光线方向、空间层次、道具关系和情绪氛围，避免写入新的角色长相设定',
  ]
    .filter(Boolean)
    .join('，')
}

function normalizePayload(payload, ctx) {
  const visualPrompt = text(payload?.visual_prompt || payload?.visualPrompt)
  return {
    visualPrompt: visualPrompt || buildMockVisualPrompt(ctx),
    notes: text(payload?.notes),
  }
}

export function buildFramePromptRewritePrompts(ctx = {}) {
  const project = ctx.project || {}
  const outline = ctx.outline || {}
  const scene = ctx.scene || {}
  const storyboard = ctx.storyboard || {}
  const characters = Array.isArray(ctx.characters) ? ctx.characters : []

  return {
    systemPrompt: [
      '你是电影分镜导演和静帧提示词设计师，擅长根据剧情上下文生成可执行的图像生成提示词。',
      '你必须只返回 JSON，不要输出解释、Markdown、代码块或额外说明。',
      '返回顶层 key 只能包含 visual_prompt 和 notes。',
      'visual_prompt 必须是中文为主，可直接用于静帧生成。',
      'visual_prompt 只负责场景、动作、情绪、机位、构图、光线、道具、空间层次和画面重点。',
      '严禁在 visual_prompt 中重新发明或改写角色脸型、五官、发型、服装、年龄、体态、随身物件。',
      '角色外貌由系统后续的定妆图和角色一致性硬约束接管。你只可以使用准确角色姓名来指代人物。',
      '如果原视觉提示词里包含角色外貌，必须剥离这些外貌细节，只保留剧情动作和场景调度。',
      '不要输出“保持同一张脸”等一致性硬约束，这部分由系统自动追加。',
    ].join(' '),
    userPrompt: [
      `项目名：${text(project.name, '未命名项目')}`,
      `项目题材：${text(project.category, '剧情')}`,
      `项目固定视觉风格：${text(project.visual_style || project.visualStyle, '电影感写实风格')}`,
      `叙事愿景：${clip(project.narrative_vision || project.narrativeVision, 500)}`,
      `总纲标题：${text(outline.title, project.name || '本片')}`,
      `总纲概要：${clip(outline.summary || outline.premise || outline.content, 800)}`,
      '',
      `场景编号：${scene.scene_no || scene.sceneNo || 1}`,
      `场景标题：${text(scene.title, '未命名场景')}`,
      `场景地点：${text(scene.location, '未知地点')}`,
      `时间：${text(scene.time_of_day || scene.timeOfDay, '夜')}`,
      `场景摘要：${clip(scene.summary, 800)}`,
      `场景剧本正文：${clip(scene.content, 1400)}`,
      '',
      '当前分镜：',
      shotBrief(storyboard),
      '',
      characters.length ? '项目角色清单（仅用于姓名和身份理解，不要改写外貌）：' : '',
      characters.map(characterLine).join('\n'),
      '',
      '输出要求：',
      '1. 生成 1 段完整 visual_prompt，长度建议 120 到 260 个中文字符。',
      '2. 必须体现这一镜真正发生的动作或信息变化，不要只写氛围。',
      '3. 必须包含景别、机位、构图、环境、光线和情绪。',
      '4. 人物出镜时只写准确角色姓名和动作，不写新的脸、发型、服装等外貌描述。',
      '5. 画面应适合直接生成静帧，不要写抽象导演说明。',
    ].join('\n'),
  }
}

export async function rewriteFrameVisualPrompt(ctx = {}) {
  const config = getAiConfig()
  if (isMockProvider(config)) {
    return {
      visualPrompt: buildMockVisualPrompt(ctx),
      notes: '当前为 mock 模式，已按上下文生成兜底视觉提示词。',
    }
  }

  const { systemPrompt, userPrompt } = buildFramePromptRewritePrompts(ctx)
  try {
    const result = await generateStructuredJson({
      task: 'frame-prompt-rewrite',
      systemPrompt,
      userPrompt,
      model: config.storyboardModel || config.defaultModel,
      temperature: 0.62,
    })
    return normalizePayload(result.json, ctx)
  } catch (error) {
    if (config.fallbackToMock) {
      return {
        visualPrompt: buildMockVisualPrompt(ctx),
        notes: `真实模型重写失败，已使用兜底提示词：${error instanceof Error ? error.message : '未知错误'}`,
      }
    }
    throw error
  }
}
