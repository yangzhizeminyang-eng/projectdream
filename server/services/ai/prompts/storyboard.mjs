/**
 * @file Storyboard prompts
 */

export function buildStoryboardPrompts(ctx) {
  const scene = ctx?.scene || {}
  const outline = ctx?.outline || {}
  const project = ctx?.project || {}
  const scriptContent = String(ctx?.scriptContent || scene?.content || '').trim()
  const characters = Array.isArray(ctx?.characters) ? ctx.characters : []
  const characterContext = characters
    .slice(0, 20)
    .map((character) =>
      [
        `姓名=${character?.name || ''}`,
        `身份=${character?.role_tag || character?.roleTag || ''}`,
        `性别=${character?.gender || '未明确'}`,
        `年龄段=${character?.age_group || character?.ageGroup || '未明确'}`,
        `外观=${String(character?.appearance || '').slice(0, 500)}`,
      ].join('；'),
    )
    .join('\n')

  return {
    systemPrompt: [
      '你是专业影视分镜导演与镜头设计顾问，擅长把单场景剧本拆成可执行的镜头清单。',
      '你必须只返回 JSON，不要输出解释、Markdown、代码块或额外说明。',
      '返回的顶层 key 必须只有 scene_id 和 shots。',
      'shots 必须是数组，每一项必须包含这些 key：shot_no, shot_type, camera_angle, composition, duration_seconds, character_name, action_text, dialogue_text, visual_prompt。',
      'shot_no 必须从 01 开始递增。',
      'duration_seconds 必须是正整数，单镜头建议 2 到 8 秒。',
      '镜头设计要真正服务剧情推进，避免空泛、重复、只有氛围没有动作的信息。',
      'visual_prompt 必须可直接用于后续静帧生成，包含主体、景别、机位、构图、环境和风格信息。',
      '人物出镜时，visual_prompt 必须写准确角色姓名，并明确其性别、年龄段、固定外貌与服装；绝对不能改变角色性别或用其他人物替代。',
      '如果某一镜没有对白，dialogue_text 写“（无对白）”。',
      characters.length
        ? '项目已经建立角色档案。character_name 必须优先使用角色清单中的准确姓名，不要用“主角”“配角”等泛称替代已有姓名。'
        : '',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `项目题材：${project?.category || '剧情'}`,
      `项目视觉风格：${project?.visualStyle || '电影感写实风格'}`,
      `项目叙事愿景：${project?.narrativeVision || ''}`,
      `总纲标题：${outline?.title || project?.name || '本片'}`,
      `总纲 premise：${outline?.premise || ''}`,
      `场景编号：${scene?.scene_no || 1}`,
      `场景标题：${scene?.title || '未命名场景'}`,
      `场景摘要：${scene?.summary || ''}`,
      `场景地点：${scene?.location || '未知地点'}`,
      `时间：${scene?.time_of_day || '夜'}`,
      `预估场景时长（秒）：${scene?.estimated_duration || 120}`,
      '',
      characters.length ? '项目角色档案：' : '',
      characterContext,
      '',
      '下面是当前场景剧本正文，请基于正文做分镜拆解：',
      scriptContent,
      '',
      '输出要求：',
      '1. 拆成 4 到 12 个镜头。',
      '2. 每个镜头都要体现明确的叙事功能，不要只做重复景别切换。',
      '3. action_text 要写镜头里真正发生的动作或信息变化。',
      '4. dialogue_text 要和剧本内容一致，可摘关键一句。',
      '5. visual_prompt 要适合后续图像生成，信息具体。',
      '6. 保持整体风格统一，但镜头节奏要有变化。',
      characters.length
        ? '7. 角色出镜时，在 visual_prompt 中逐一写明准确姓名、性别、年龄段、固定外观和服装；多人同框时必须逐一描述，禁止性别互换或串脸。'
        : '',
    ].join('\n'),
  }
}
