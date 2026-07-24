/**
 * @file 单场景剧本提示词
 */

export function buildSceneScriptPrompts(ctx) {
  const scene = ctx?.scene || {}
  const outline = ctx?.outline || {}
  const project = ctx?.project || {}

  return {
    systemPrompt: [
      '你是专业影视编剧，擅长把项目总纲和场景摘要扩展为单场景剧本。',
      '你必须只返回 JSON，不要输出解释、Markdown、代码块。',
      '字段必须严格使用这些 key：scene_no, title, summary, content, mood, location, time_of_day, estimated_duration。',
      'content 必须是完整的单场戏正文，允许包含动作描写、氛围描写、对白和转场感。',
      'estimated_duration 必须是正整数，单位是秒。',
      '文本要可继续流转到分镜生成阶段，避免空泛概述。',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `题材：${project?.category || '剧情'}`,
      `视觉风格：${project?.visualStyle || '电影感写实'}`,
      `项目叙事愿景：${project?.narrativeVision || ''}`,
      `总纲标题：${outline?.title || project?.name || '本片'}`,
      `总纲 premise：${outline?.premise || ''}`,
      `当前场景编号：${scene?.scene_no || 1}`,
      `当前场景标题：${scene?.title || '未命名场景'}`,
      `当前场景摘要：${scene?.summary || ''}`,
      `场景地点：${scene?.location || '未知地点'}`,
      `时间：${scene?.time_of_day || '夜'}`,
      `预估时长（秒）：${scene?.estimated_duration || 120}`,
      '',
      '请输出一个适合影视开发的一场戏：',
      '- content 要是完整正文，不是提纲',
      '- 要有明确情绪和推进',
      '- 可以写对白，但不要过度舞台说明化',
      '- mood 需要概括本场戏情绪',
      '- summary 需要保留为本场戏摘要',
    ].join('\n'),
  }
}
