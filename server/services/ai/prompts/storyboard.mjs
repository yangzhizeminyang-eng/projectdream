import {
  SCREENPLAY_SKILL_RULES,
  STORYBOARD_SKILL_RULES,
  joinProductionPromptRules,
} from '../skills/production-prompt-rules.mjs'
import { buildGenrePromptContext } from '../genre-skill-profile.mjs'
import { buildPromptTemplateContext } from '../prompt-template-skill.mjs'
import {
  buildProjectKnowledgeChunks,
  formatRetrievedProjectContext,
  retrieveProjectContext,
} from '../../project-knowledge.mjs'
import { formatRagRetrievedContext } from '../../rag-client.mjs'

/**
 * @file Storyboard prompts
 */

export function buildStoryboardPrompts(ctx) {
  const scene = ctx?.scene || {}
  const outline = ctx?.outline || {}
  const project = ctx?.project || {}
  const scriptContent = String(ctx?.scriptContent || scene?.content || '').trim()
  const characters = Array.isArray(ctx?.characters) ? ctx.characters : []
  const assetCatalog = ctx?.assetCatalog || {}
  const videoDurationRange = ctx?.videoDurationRange || { min: 4, max: 15 }
  const sceneCatalog = Array.isArray(assetCatalog.scenes) ? assetCatalog.scenes : []
  const propCatalog = Array.isArray(assetCatalog.props) ? assetCatalog.props : []
  const toolCatalog = Array.isArray(assetCatalog.tools) ? assetCatalog.tools : []
  const localProjectContext = formatRetrievedProjectContext(retrieveProjectContext(
    buildProjectKnowledgeChunks({ scene, characters, assetCatalog }),
    [scene.title, scene.summary, scriptContent].join(' '),
    8,
    { episodeNo: scene?.episode_no ?? scene?.episodeNo },
  ))
  const retrievedProjectContext = formatRagRetrievedContext(ctx?.ragContext) || localProjectContext
  const genreContext = buildGenrePromptContext(project?.category)
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
      buildPromptTemplateContext('storyboard'),
      joinProductionPromptRules(SCREENPLAY_SKILL_RULES, STORYBOARD_SKILL_RULES),
      genreContext,
      '你必须只返回 JSON，不要输出解释、Markdown、代码块或额外说明。',
      '返回的顶层 key 必须只有 scene_id 和 shots。',
      'shots 必须是数组，每一项必须包含这些 key：shot_no, shot_type, camera_angle, composition, duration_seconds, duration_breakdown, duration_basis, character_name, action_text, dialogue_text, visual_prompt, shot_purpose, acting_beat, audio_direction, gaze_plan, sound_plan, speech_duration_policy, reaction_shot, emotional_change, emotion, emotion_intensity, emotion_start, emotion_trigger, emotion_end, micro_expression, breath_action, body_action, voice_tone, voice_volume, speech_rate, speech_pauses, lip_sync, continuity_from_previous, start_state, end_state, character_assets, scene_assets, prop_assets, tools, start_visual_prompt, end_visual_prompt, scene_view_key。',
      'shot_no 必须从 01 开始递增。',
      '先在内部为每镜完成时长规划：分析可见动作的准备、执行、结果停留，按自然语速估算对白时长，并为必要的表演停顿留空间；对白时长策略为 preserve，禁止压缩语速。复杂动作、信息揭示和反应需要可见完成时间，不能按平均值机械分配。',
      `面向当前视频生成链路时，单镜规划为 ${videoDurationRange.min} 到 ${videoDurationRange.max} 秒整数；不足最小时长的动作应与相邻动作合理组合，超过最大时长或包含多个主事件的内容必须拆成连续镜头。不得把无法在模型时长范围内执行的镜头交给视频生成。`,
      '输出 duration_seconds 为最终正整数秒数；同时输出仅供系统校验的 duration_breakdown 数组，每段包含 phase、seconds（正整数）、observable（该段画面可见结果），各段 seconds 之和必须严格等于 duration_seconds。duration_basis 用一句话记录内部决策依据。第一镜同样必须有有效规划，禁止 0 秒。',
      'duration_breakdown 和 duration_basis 只用于系统内部校验，绝对不得写入 visual_prompt、对白、声音或任何用户可见文案。校验不出可信时长时不要伪造默认值，返回缺失规划，由系统拒绝本次结果并要求重试。',
      '用户可见的 visual_prompt 必须直接采用分镜单排版，固定栏目名为“时间轴：”“镜头：”“位置：”“动作：”“要求：”，对白/旁白和声音栏目按剧情需要添加；剧中时刻（如深夜23:40）写在位置或要求中，不和镜头内时间轴混用。时间轴从本镜0秒起算，所有时间段连续、不重叠，末尾必须等于duration_seconds；时间段只写可见动作节拍，不写时长选择依据。',
      '镜头设计要真正服务剧情推进，避免空泛、重复、只有氛围没有动作的信息。',
      '每镜只设一个可见主事件，并把事件拆成可拍摄的起点、动作过程、结果和收尾状态；辅助动作最多一个。动作事件超过两个或无法在镜头时长内完成时必须拆镜；跨越多个空间也必须拆成连续镜头，不得把整段剧情压成一条提示词。景别和时长须服务信息揭示与情绪节拍，避免连续镜头机械重复同一景别或平均时长。',
      '动作必须可从画面验证，写清主体、动作对象、方向或位置变化、结束时的可见结果；避免只写“注意到、意识到、感到紧张”等不可见心理结论。视线变化要写明确目标物和屏幕方位。',
      'gaze_plan 是内部视线执行合同：必须写 start_target、transitions、end_target、eye_lead；每个 transition 必须包含 from_second、to_second、target、observable，目标必须是本镜真实存在的角色、场景锚点或道具资产。复杂镜头最多两次视线转移，必须明确“眼睛先动、头部延迟半拍跟随”和最终锁定；只写“看向/注意到”视为不合格。',
      '音频意图必须区分对白、环境声、拟音与静默；明确需要生成的声音及其进入/退出时机。写“无对白”不等于无声，若剧本要求环境声必须明确列出。',
      'sound_plan 是内部声音执行合同：必须写 bed、cues、silence_policy、mix_priority；bed 从0秒持续到镜头结束，cues 要把可见动作绑定到具体拟音及时间点；无对白不等于无声，除非剧本明确要求静默，否则禁止数字静音。',
      'visual_prompt 是用户可见、可编辑并直接交给视频模型的唯一镜头执行单；开头保留准确的@角色、@场景、@道具、@音色引用，随后按分镜单栏目清楚编排信息。写具体可见行为、动作对象和画面结果，不写泛化心理总结。',
      'emotion、emotion_start/trigger/end、micro_expression、breath_action、body_action、voice_tone/volume/rate/pauses、lip_sync、continuity_from_previous 等结构化字段用于系统内部分析与质检；除非某项是视频模型执行所必需且未在分镜单体现，否则不得把这些字段再次逐项追加到visual_prompt。对白、表演、动作和声音在可见分镜单中各表达一次，不得换标签重复复述。',
      '资产库母版与剧情镜头是不同任务：资产参考图只锁定角色/道具身份、外观和可识别细节；剧情镜头必须根据剧本写场景、人物或道具动作、空间关系、机位和景别，禁止继承资产图的白底、居中陈列、安全边距、完整产品展示等构图约束。',
      '当剧情展示邮件、协议、档案标签或屏幕内容时，镜头提示词描述角色观看/操作与界面区域层级；精确可读的中文正文、账号、编号交由后期合成，不要求生图或视频模型生成准确文字。',
      '角色、场景和道具的外貌、服装、材质与布局以已确认资产参考图和资产版本为唯一视觉来源；visual_prompt 只能引用资产名称并描述本镜如何拍摄，不得复制或生成角色资产模板、资产板布局、全身照、脸部特写、三视图、纯白背景或资产生成负面词。',
      'shot_purpose 只能描述本镜头的叙事目的，例如 hook、dialogue、reaction、insert、establishing、transition、story。',
      'acting_beat 必须写清本镜头中的表演节拍，例如停顿、吸气、视线变化、动作结果，不要只写“自然表演”。',
      'audio_direction 必须写清语速、停顿、情绪、重音或环境声关系；没有对白时写环境声或静默。',
      'speech_duration_policy 固定写 preserve，禁止为了塞进镜头而加速对白。',
      'reaction_shot 为布尔值；非说话镜头优先用 reaction 或 insert 承接，不要让一个口型镜头撑完整段台词。',
      'emotional_change 必须说明本镜头开始到结束的情绪变化；start_state 和 end_state 必须写清人物、道具和空间的连续状态。',
      'emotion 必须写当前情绪，emotion_intensity 必须是 0 到 100 的整数；emotion_start、emotion_trigger、emotion_end 必须分别写情绪起点、触发原因和结束状态。',
      'micro_expression 必须具体写眼神、眉心、眼睑、嘴角、下颌等可拍摄的细节；不要只写“表情自然”。',
      'breath_action 和 body_action 必须写吸气、呼气、吞咽、停顿、手指、肩颈、重心等可执行动作；voice_tone、voice_volume、speech_rate、speech_pauses 和 lip_sync 必须共同约束声音、对白与口型逐字同步。',
      'continuity_from_previous 必须写与上一镜头的情绪、视线、姿态和动作衔接；第一镜头写“开场建立状态”。',
      'character_assets、scene_assets、prop_assets 必须是数组，元素只能使用项目资产清单中的准确名称；本镜画面实际出现、被操作或被镜头明确展示的资产必须逐项引用，不能为了省事留空。',
      '所有资产引用名称必须严格从下方清单选择，禁止只写普通文本名、别名或自行创造资产；如果清单没有该道具，prop_assets 必须留空并由后端阻断补资产。',
      'tools 必须是数组，只能使用“添加时间”“片段衔接”“首尾帧参考”“环境音”；镜头需要承接上一镜的尾帧、人物姿态、视线、道具位置或空间布局时必须同时填写“片段衔接”和“首尾帧参考”，不要只在普通文字里描述承接。',
      'start_visual_prompt 和 end_visual_prompt 必须分别写清动作起点和收尾状态；需要承接上一镜时在 tools 中写“片段衔接”或“首尾帧参考”。',
      'scene_view_key 必须从已确认场景视角中选择，例如 front-left、front、front-right、left、center、right、back-left、back、back-right；没有场景资产时返回空字符串。',
      '人物出镜时，visual_prompt 必须写准确角色姓名并使用 @角色引用；身份、性别、年龄、脸型、发型、服装和配饰由已确认角色资产提供，提示词只补充本镜的姿态、表演、空间关系和镜头语言。绝对不能改变角色性别或用其他人物替代。character_name 只能填写当前镜头实际出镜的角色；纯道具、环境或插入镜头必须填写空字符串，不能填未出镜角色。',
      '如果某一镜没有对白，dialogue_text 写“（无对白）”。',
      characters.length
        ? '项目已经建立角色档案。character_name 必须优先使用角色清单中的准确姓名，不要用“主角”“配角”等泛称替代已有姓名。'
        : '',
      characters.length
        ? '当前场景角色清单就是唯一允许出镜的人物集合；正文只提及但没有出镜动作的角色，不得填写 character_name。任何不在清单中的姓名、简称、姓氏、代号或后续剧情人物都不得写入镜头。'
        : '当前场景没有可确认的出镜角色，所有镜头的 character_name 必须为空字符串。',
    ].join(' '),
    userPrompt: [
      `项目名：${project?.name || '未命名项目'}`,
      `项目题材：${project?.category || '剧情'}`,
      `项目视觉风格：${project?.visualStyle || '电影感写实风格'}`,
      genreContext,
      `项目叙事愿景：${project?.narrativeVision || ''}`,
      retrievedProjectContext ? `项目记忆检索上下文（仅用于保持设定，已确认资产优先）：\n${retrievedProjectContext}` : '',
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
      '当前可执行资产清单（分镜 Agent 必须按本镜需要逐镜选择）：',
      `场景资产清单：${sceneCatalog.length ? sceneCatalog.map((item) => `${item.name}${item.sceneViewKeys?.length ? `（可用角度：${item.sceneViewKeys.join('、')}）` : ''}`).join('；') : '无已确认场景资产'}`,
      `道具资产清单：${propCatalog.length ? propCatalog.map((item) => item.name).join('；') : '无已确认道具资产'}`,
      `工具清单：${toolCatalog.length ? toolCatalog.join('、') : '添加时间、片段衔接、首尾帧参考、环境音'}`,
      '',
      '下面是当前场景剧本正文，请基于正文做分镜拆解：',
      scriptContent,
      '',
      '输出要求：',
      '1. 拆成 4 到 12 个镜头。',
      '2. 每个镜头都要体现明确的叙事功能，不要只做重复景别切换。',
      '3. action_text 要写镜头里真正发生的动作或信息变化。',
      '4. dialogue_text 要和剧本内容一致，可摘关键一句。',
      '5. visual_prompt 要适合后续视频生成，按时间轴、镜头、位置、动作、要求、对白/旁白、声音排版；信息精确而非堆砌形容词，禁止把角色/场景/道具 Agent 的生成模板粘进来。角色说话时必须在分镜单中保留 @音色[角色名]、逐字对白和可执行声音/口型要求。',
      '5.1. 情绪字段必须来自当前剧情，不要给所有镜头套同一种情绪；口型同步字段必须与对白逐字对应，不得凭空添加台词。',
      '6. 保持整体风格统一，但镜头节奏要有变化。',
      '7. 一段对白较长时，拆成说话、反应、道具或环境镜头；不要把所有对白压在同一个正面口型镜头。',
      characters.length
        ? '8. 角色出镜时，在 visual_prompt 中逐一使用准确的 @角色姓名；固定外观和服装由已确认角色资产读取，不要复制角色资产生成说明。多人同框时必须逐一引用，禁止性别互换或串脸。'
        : '',
      '9. 每个镜头必须输出角色、场景、道具资产数组；visual_prompt 中也必须以内联 @角色、@场景、@道具写出实际引用，后端会把这些引用传给视频 Agent。',
      '10. 有对白或需要角色发声的镜头，visual_prompt 或 dialogue_text 必须写 @音色[角色准确姓名]；音色只能绑定当前实际说话角色。',
      '11. 道具必须按本镜实际出镜或被操作的物件逐镜引用，例如笔、离职协议、手机、电脑、邮件、旧事故档案；不能把全场道具堆到每个镜头。',
      '11. 只能把当前场景正文中明确发生出镜动作的角色写入 character_name；仅在台词、回忆、邮件、视频内容或警告中被提及的人物不算当前镜头出镜。',
    ].join('\n'),
  }
}
