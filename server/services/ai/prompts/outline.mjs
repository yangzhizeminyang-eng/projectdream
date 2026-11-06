/**
 * @file 总纲提示词
 */

import { buildGenrePromptContext } from '../genre-skill-profile.mjs'

export function buildOutlinePrompts(project) {
  const projectName = project?.name || '未命名项目'
  const category = project?.category || '剧情 / 科幻'
  const targetDuration = project?.targetDuration || 90
  const narrativeVision = project?.narrativeVision || '请自行补足完整世界观和故事矛盾'
  const visualStyle = project?.visualStyle || '电影感、写实、可视化明确'
  const genreContext = buildGenrePromptContext(category)

  return {
    systemPrompt: [
      '你是专业影视策划与编剧顾问。',
      '你的任务是根据项目信息输出一个适合影视开发的故事总纲。',
      '你必须只返回 JSON，不要输出解释、标题、Markdown、代码块。',
      '字段必须严格使用这些 key：title, logline, premise, visual_style, acts, scenes。',
      'acts 必须是 3 项数组，每项包含：act, title, summary。',
      'scenes 必须是数组，每项包含：scene_no, title, summary, location, time_of_day, estimated_duration。',
      'estimated_duration 必须是正整数，单位是秒。',
      '内容要尽量具体，可拍摄，可继续流转到场景拆解和单场景剧本阶段。',
      genreContext,
    ].join(' '),
    userPrompt: [
      `项目名：${projectName}`,
      `题材：${category}`,
      `目标时长（分钟）：${targetDuration}`,
      `世界观 / 叙事愿景：${narrativeVision}`,
      `视觉风格：${visualStyle}`,
      genreContext,
      '',
      '请生成：',
      '1. 一句话 logline',
      '2. premise（完整故事前提）',
      '3. 三幕结构',
      '4. 4 到 12 个场景预览',
      '',
      '输出要求：',
      '- scene_no 从 1 递增',
      '- 场景摘要要体现冲突推进',
      '- location 和 time_of_day 不能空',
      '- estimated_duration 用秒表示',
      '- 整体风格要贴合该项目题材与视觉风格',
    ].join('\n'),
  }
}
