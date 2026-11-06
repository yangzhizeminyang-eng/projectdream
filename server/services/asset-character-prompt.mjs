import {
  CHARACTER_ASSET_SKILL_RULES,
  joinProductionPromptRules,
} from './ai/skills/production-prompt-rules.mjs'
import { buildGenrePromptContext } from './ai/genre-skill-profile.mjs'
import { buildPromptTemplateContext } from './ai/prompt-template-skill.mjs'
import { extractExplicitSceneFixtures } from './scene-space-manifest.mjs'

const NEGATIVE_PROMPT =
  '换脸、改变年龄、改变性别、第二个人、多人、半身裁切、缺失手脚、畸形手指、错误服装、文字、水印、Logo、低清晰度、过度模糊、重复角色'

function text(value) {
  return String(value ?? '').trim()
}

function firstValue(...values) {
  return values.map(text).find(Boolean) || ''
}

function characterMustNotShowFace(character = {}) {
  return /不露脸|正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(
    `${text(character.appearance)} ${text(character.costume)}`,
  )
}

function sceneMatchesCharacter(scene, characterName) {
  const haystack = [
    scene?.title,
    scene?.summary,
    scene?.content,
    scene?.location,
  ]
    .map(text)
    .join(' ')
  return characterName && haystack.includes(characterName)
}

function formatScene(scene) {
  const no = scene?.sceneNo ?? scene?.scene_no ?? '?'
  const title = firstValue(scene?.title, '未命名场景')
  const location = inferSceneLocation(scene) || '地点未提供'
  const timeOfDay = inferSceneTimeOfDay(scene) || '时间未提供'
  const summary = firstValue(scene?.summary, scene?.content)
  return `第${no}场《${title}》：${location}，${timeOfDay}${summary ? `；${summary.slice(0, 260)}` : ''}`
}

function sceneEvidence(scene = {}) {
  return [
    scene?.title,
    scene?.summary,
    scene?.content,
    scene?.location,
    scene?.timeOfDay,
    scene?.time_of_day,
  ].map(text).filter(Boolean).join(' ')
}

function activeScreenplayLocation(scene = {}) {
  const heading = text(scene.content).match(/【([^】]+)】/u)?.[1]
  if (!heading) return ''
  return heading
    .replace(/^\s*\d{1,2}:\d{2}\s*/u, '')
    .replace(/[·|｜]\s*\d{1,2}:\d{2}\s*$/u, '')
    .trim()
}

function uniqueTexts(values) {
  return [...new Set(values.map(text).filter(Boolean))]
}

/**
 * Pull clothing and carried-object evidence from the scenes matched to a
 * character. This is evidence extraction, not story invention: when the
 * script has no such evidence the caller keeps the explicit missing-data
 * state and generation remains reviewable instead of silently guessing.
 */
export function inferCharacterCostumeFromScenes(scenes, characterName) {
  const name = text(characterName)
  if (!name) return ''
  const source = (Array.isArray(scenes) ? scenes : [])
    .filter((scene) => sceneMatchesCharacter(scene, name))
    .map((scene) => [scene?.title, scene?.summary, scene?.content].map(text).filter(Boolean).join(' '))
    .join('\n')
  if (!source) return ''

  const normalizeFragment = (value) => text(value)
    .replace(/^(?:但|而且|然而|只是|他|她|林默|唐宁|赵衡|苏晓)\s*/u, '')
    .replace(/^(?:一枚|一只|一个|一张|那张|这张|有|戴着|戴有)\s*/u, '')
    .replace(/的手(?:开始|突然|微微).*$/u, '')
    .trim()

  const clothing = []
  for (const match of source.matchAll(/(?:穿着|身穿|穿了|穿上|穿)\s*([^，。！？\n；;]{1,80})/gu)) {
    const fragment = normalizeFragment(match[1])
    if (fragment && !/(?:的手|开始|突然|正在)/u.test(fragment)) clothing.push(fragment)
  }

  // “领带松垮地挂在脖子上”这类句子没有“穿/戴”动词，但仍是稳定服饰证据。
  for (const match of source.matchAll(/((?:领带|领结|围巾)\s*(?:松垮地|紧紧地|随意地)?(?:挂在|系在)[^，。！？\n；;]*)/gu)) {
    const fragment = normalizeFragment(match[1])
    if (fragment) clothing.push(fragment)
  }

  const carried = []
  for (const match of source.matchAll(/(?:戴着|戴|佩戴)\s*([^，。！？\n；;]{1,30})/gu)) {
    const fragment = normalizeFragment(match[1])
    if (fragment && !/(?:的手|开始|突然|正在)/u.test(fragment)) carried.push(fragment)
  }
  for (const match of source.matchAll(/无名指上(?:有|戴着|戴有)?\s*(?:一枚|一只|一个)?\s*([^，。！？\n；;]{1,30})/gu)) {
    const fragment = normalizeFragment(match[1])
    if (fragment && !/(?:翻找|握着|拿着|寻找|查看|点击)/u.test(fragment)) carried.push(fragment)
  }

  // 只接受带有“留存/携带”语义的物件，避免把“握着手机的手”“翻找杯垫”误判为固定物件。
  for (const match of source.matchAll(/([^\s，。！？；;]{1,20}(?:杯垫|戒指|手表|项链|钥匙|手机|眼镜))(?=[^。！？；;]{0,24}(?:至今|一直|仍然)?(?:留着|保留|保存着|随身携带|带着))/gu)) {
    const fragment = normalizeFragment(match[1])
    if (fragment && !/(?:翻找|握着|拿着|寻找|查看|点击)/u.test(fragment)) carried.push(fragment)
  }

  return uniqueTexts([...clothing, ...carried]).join('；')
}

/**
 * Identify only the known legacy extraction poisonings. This deliberately does
 * not compare the whole prompt with a newly generated prompt, so a real user
 * edit remains authoritative and is never silently overwritten.
 */
export function isLegacyCharacterPrompt(prompt) {
  return /固定服装与随身物件：[^\n]*(?:手机的手|翻找|似乎也捏着|捏着一枚同款)/u.test(text(prompt))
}

export function inferSceneLocation(scene = {}) {
  const explicit = firstValue(scene.location)
  if (explicit) return explicit
  const source = sceneEvidence(scene)
  const rules = [
    [/会议室|离职协议|人事流程|警示灯/u, '公司合规会议室（根据正文中的离职签字、会议桌和警示灯推断）'],
    [/公寓|沙发|百叶窗|冷咖啡|冰箱嗡鸣/u, '深夜公寓客厅与电脑工作区（根据正文中的沙发、百叶窗和电脑互动推断）'],
    [/办公室|书架顶端|办公椅|摄像头俯拍/u, '公司老板办公室（视频画面，根据书架、办公椅和俯拍摄像头推断）'],
    [/机房|主节点|服务器机柜/u, '公司核心机房（根据主节点、日志或服务器机柜推断）'],
    [/葬礼|灵堂|花圈|遗照/u, '葬礼灵堂（根据悼词、花圈或遗照推断）'],
  ]
  return rules.find(([pattern]) => pattern.test(source))?.[1] || ''
}

export function inferSceneTimeOfDay(scene = {}) {
  const explicit = firstValue(scene.timeOfDay, scene.time_of_day)
  if (explicit) return explicit
  const source = sceneEvidence(scene)
  if (/深夜|凌晨|午夜|00:00|夜里|夜晚|夜[。！？，,\s]/u.test(source)) return '深夜（根据正文光线与时间线推断）'
  if (/傍晚|黄昏/u.test(source)) return '傍晚（根据正文光线推断）'
  if (/清晨|早晨|黎明/u.test(source)) return '清晨（根据正文光线推断）'
  if (/白天|上午|下午/u.test(source)) return '白天（根据正文时间线推断）'
  return ''
}

function sanitizeSceneEnvironmentEvidence(value, characterNames = []) {
  const source = text(value)
  if (!source) return ''

  const names = (Array.isArray(characterNames) ? characterNames : [characterNames])
    .map(text)
    .filter((name) => name.length >= 2)
  const characterPattern = names.length
    ? new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'u')
    : null

  // 场景 Agent 的正文证据同时包含空间和表演信息。空场生图只允许读取
  // 空间事实；按标点拆成短证据后剔除动作、服装、对白和声音片段，保留
  // 沙发、门窗、设备、材质、光线等可复核锚点。完整正文仍保存在剧本和
  // scene prompt 中，供分镜 Agent 使用。
  const excludedClause = /(?:^|：)(?:动作|表演|对白|台词|声音|同期声|音效|回忆|人物动作)\s*[:：]?/u
  const excludedEvidence = /(?:穿着|身穿|服装|衣服|丧服|领带|西装|衬衫|袖口|腕表|手表|半陷|陷在|盯住|盯着|起身|走向|回头|输入|点击|解压|观看|拿着|握着|咽下|说出|悼词|同期声|对白|声音|语音|电流失真|屏幕|显示器.*(?:亮|显示|停|出现)|邮件|邮箱|发件|主题|账号|登录|字段|文字|字幕|代码|视频|遗言|人影|脸|手|手指|手臂|身体|倒影|标签朝上|登记簿|失主栏|红色发卡|发卡滑出|发卡停在|腰间钥匙|钥匙轻响|无名指|戒指|划痕|刮痕|去湖边|刮的|空白|倒计时)/u
  const actionEvidence = /(?:把|将|拿|放|敲|翻|站|走|起身|回头|盯|看|打开|接|问|回答|停住|握|摸|输入|点击|发现|来到|跑|坐|听|呼吸|抬|低|转身|投|开口|微笑|沉默|说)/u
  const namedPerformance = /(?:[\u4e00-\u9fff]{2,4})(?:把|将|站|跟|没|说|问|答|走|拿|坐|来到|赶到|停在|的手|的眼|的脸|的声音|：)/u
  const spatialLead = /^(?:深夜|凌晨|公寓|客厅|卧室|房间|室内|窗外|墙上|桌面|地面|天花板|门口|走廊|值班室|登记台|归还箱|办公室|会议室|机房|屏幕|电脑|冰箱|茶几|百叶窗)/u
  const explicitFixtures = extractExplicitSceneFixtures({ content: source }).map(({ label }) => label)
  const fixtureClauses = explicitFixtures.map((label) => `剧本明确固定设施：${label}`)
  const cleanEvidence = source
    .replace(/[“”][^“”]*[“”]/gu, '。')
    .split(/[。！？\n]/u)
    .flatMap((sentence) => sentence.split(/[；;]/u))
    .flatMap((clause) => clause.split(/[，,]/u))
    .map((clause) => clause.trim())
    .filter((clause) => clause && !excludedClause.test(clause))
    .filter((clause) => !characterPattern || !characterPattern.test(clause))
    .filter((clause) => !excludedEvidence.test(clause))
    .filter((clause) => spatialLead.test(clause) || !namedPerformance.test(clause))
    .filter((clause) => !actionEvidence.test(clause) || /(?:位于|靠近|朝向|沿着|固定|安装|悬挂|铺设|排列|延伸|墙面|地面|天花板|门|窗|走廊|房间|值班室|登记台|归还箱)/u.test(clause))
    .join('，')
  return [...fixtureClauses, cleanEvidence].filter(Boolean).join('，')
}

export function extractTemporalStates(scenes, characterName) {
  const states = []
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!sceneMatchesCharacter(scene, characterName)) continue
    // 只从场景标题、地点和明确的时间字段识别资产时空。
    // 正文常会提到“父亲五年前的事故”这类历史事实，不能因此把当前角色
    // 错误拆成“五年前”的角色资产组。
    const source = [
      scene?.title,
      scene?.location,
      scene?.timeOfDay,
      scene?.time_of_day,
    ].map(text).join(' ')
    const match = source.match(/(?:五年前|5年前|十八年前|18年前|童年|小时候|幼年|当前|现在|职场)/)
    if (match) {
      const label = match[0]
      if (!states.includes(label)) states.push(label)
    }
  }
  return states
}

export function buildCharacterTurnaroundPrompt({ character = {} } = {}) {
  const name = firstValue(character.name, character.characterName, '未命名角色')
  const appearance = firstValue(character.appearance)
  const costume = firstValue(character.costume, character.costume_description, character.costumeDescription)
  const age = firstValue(character.age_group, character.ageGroup)
  const gender = firstValue(character.gender)
  const noFace = characterMustNotShowFace(character)

  return [
    '任务类型：角色三视图专用资产生成。',
    `角色身份：${name}`,
    gender ? `性别：${gender}` : '',
    age ? `年龄呈现：${age}` : '',
    appearance ? `基础外貌锁定：${appearance}` : '',
    costume ? `固定服装与随身物件锁定：${costume}` : '',
    '只读取已确认基础正面全身图和本段角色资产约束，不读取剧情场景、分镜动作、对白、环境或项目背景风格。',
    '基于同一张已确认基础正面全身图，生成同一角色的三张独立全身照片：正面、严格90度侧面、背面；保持同一张脸、发型、妆容、发长、发量、体态、服装、鞋子和全部配饰完全一致。',
    '纯白背景（#FFFFFF）、均匀柔光、无地面环境、无道具、无文字、无水印、无其他人物；从头顶到鞋底完整入镜，人物居中并留安全边距。',
    noFace
      ? '该角色剧情约束为不直接露脸：所有视角都不得出现可辨识正脸或清晰五官；以肩线、袖口、手部、后脑勺或遮挡构图保持身份连续，不能为了满足正面视角而生成清晰肖像。'
      : '正面必须看清双眼、鼻子、嘴巴和胸前服装；侧面必须严格90度，只显示一个侧脸轮廓，不能出现正面双眼或三分之四侧面；背面必须只看到后脑勺、后颈、背部和鞋后跟，不出现脸部和胸前衣物。',
    '手指数量正确，手掌、手臂、肩膀、腿部和鞋子结构真实自然；禁止半身、膝上裁切、脚部裁切、拼贴、九宫格、三联画和背景图。',
    '真人细节约束：保留自然轻微面部不对称；眼睛、瞳孔、虹膜高光、鼻梁鼻翼、嘴唇、耳廓耳垂、发际线和鬓角必须符合真实人体结构；皮肤呈现自然肤色变化和适度细微纹理，不要蜡像或塑料皮肤。',
    '四肢约束：每只手五根手指，关节、指甲和掌纹清楚；肩膀、肘部、腕部、锁骨、膝盖和脚踝连接自然；鞋子成对、左右对应、鞋底完整，不出现融合脚、额外肢体或漂浮配饰。',
    '服装连续性约束：领口、接缝、袖口、纽扣、布料褶皱、腰线、鞋面纹理和配饰位置必须以基础图为唯一依据，不能因为换视角改变衣服穿搭或发型长度。',
  ].filter(Boolean).join('\n')
}

/**
 * Prompt for providers that can render a single, deterministic character
 * reference board. The board is an interchange artifact: the application
 * still stores the full-body, face and three angle assets independently.
 */
export function buildCharacterAssetPackPrompt({
  character = {},
  projectVisualStyle = '',
  projectCategory = '',
} = {}) {
  const name = firstValue(character.name, character.characterName, '未命名角色')
  const appearance = firstValue(character.appearance)
  const costume = firstValue(character.costume, character.costume_description, character.costumeDescription)
  const role = firstValue(character.role_tag, character.roleTag)
  return [
    '任务类型：同一角色资产包基准板（完整角色资产板），只生成一张可直接展示、引用和一致性锁定的母板；不要输出拆分后的单张裁片。',
    `角色名：${name}`,
    role ? `叙事身份：${role}` : '',
    appearance ? `固定外貌：${appearance}` : '',
    costume ? `固定服装与配饰：${costume}` : '',
    projectVisualStyle ? `项目视觉风格：${projectVisualStyle}` : '',
    projectCategory ? buildGenrePromptContext(projectCategory, 'character') : '',
    '白色背景，均匀柔光，真实摄影棚资产参考图；同一张脸、发型、发长、发量、妆容、体态、服装、鞋子和配饰贯穿全部区域，禁止任何区域换脸、换衣、改发型或改变年龄。',
    '身份一致性优先级：右上脸部特写是五官、脸型、耳朵、发际线和发型的唯一身份基准；左侧正面全身照是身高比例、肩宽体态、服装版型、鞋子和固定配饰的唯一身体基准；右下三视图必须同时回看这两个基准逐一复现，不得分别凭空设计三个新人物。',
    '三视图一致性硬约束：正面、严格90度侧面、背面必须属于同一张脸和同一套服装。侧面重点保持鼻梁、鼻尖、嘴唇、下颌线、耳廓、发际线和发长与正面/脸部特写连续；背面重点保持后脑勺轮廓、头发长度、肩线、衣服后片、裤型和鞋子与正面全身连续。任何一个视图五官变形、脸型漂移、发型漂移、体态比例改变或服装配饰变化都视为整板失败。',
    '固定排版，不得改变区域位置：画布必须是16:9横向资产板，禁止竖屏、长条竖图和单人海报。按坐标分成左列和右列；左列占画布约48%，从x=0到x=48%、y=0到y=100%，左列只允许一张正面完整全身照，从头顶到鞋底全部入镜。右列占画布约48%，从x=52%到x=100%；右上区域固定占右列上方约42%，只允许一张独立正面脸部特写，脸部必须是该区域主体并占该区域宽度约70%至90%，必须包含头发顶部、双耳、完整下颌和锁骨上缘；右下区域固定从y约47%开始，占右列下方约51%，必须横向三等分为三个独立小格，依次只放正面、严格90度侧面、背面三张完整全身视图。右上脸部特写与右下三视图不得合并、不得被三视图挤占；区域之间留白约4%，五个区域不可合并、不可重复、不可交换位置；缺少脸部特写或任一全身区域都视为失败。',
    '资产板直接作为完整视觉参考，禁止输出海报、标题、标签、文字、数字、水印、边框装饰、九宫格或多余人物；各区域之间只使用清晰白色间隔，不要用文字标注视图名称，不让人物跨越区域。脸部特写必须是右上独立区域内真正可辨认的头肩近景，不得用三视图中缩小的人脸代替。',
    '所有全身视图都必须从头顶到鞋底完整可见，脚、鞋、头发、双耳和下巴不能被裁切；侧面只允许严格90度单侧轮廓，背面不能出现脸部。',
    '真人结构约束：自然轻微面部不对称，真实眼睑、瞳孔、虹膜、鼻梁鼻翼、嘴唇、耳廓、皮肤纹理、手指和关节；禁止塑料皮肤、畸形肢体、额外手指、重复人物、半身裁切和透视变形。三视图中的头部必须足够清晰可比，不能把人物缩到无法确认脸型和发型的尺寸；画布留白不能牺牲身份可读性。',
    '负面约束：换脸、服装漂移、发型漂移、配饰缺失、裁切脚部、裁切下巴、缺失耳朵、三分之四侧脸、多人、场景背景、道具、文字、字幕、Logo、水印。',
  ].filter(Boolean).join('\n')
}

export function buildTemporalVariantPrompt(basePrompt, stateLabel) {
  const state = text(stateLabel)
  if (!state) return text(basePrompt)
  return [
    text(basePrompt),
    `本资产时空状态：${state}`,
    '本状态的年龄呈现、固定服饰、鞋履、配饰和随身物件必须根据对应时空的剧本场景、人物身份与动作重新整理；不得沿用与该状态冲突的服饰。',
    '保持角色身份、脸部特征和发型可识别；本时空状态单独成组，不与其他年龄或时间状态合并。',
  ].filter(Boolean).join('\n')
}

export function buildScriptCharacterPrompt({ character = {}, scenes = [], projectVisualStyle = '', projectCategory = '' } = {}) {
  const name = firstValue(character.name, character.characterName, '未命名角色')
  const role = firstValue(character.role_tag, character.roleTag)
  const age = firstValue(character.age_group, character.ageGroup)
  const gender = firstValue(character.gender)
  const appearance = firstValue(character.appearance)
  const costume = firstValue(character.costume, character.costume_description, character.costumeDescription)
  const noFace = characterMustNotShowFace(character)
  const resolvedCostume = costume || inferCharacterCostumeFromScenes(scenes, name)
  const personality = firstValue(character.personality)
  const voiceStyle = firstValue(character.voice_style, character.voiceStyle)
  const temporalStates = extractTemporalStates(scenes, name)

  const lines = [
    buildPromptTemplateContext('character'),
    joinProductionPromptRules(CHARACTER_ASSET_SKILL_RULES),
    `角色名：${name}`,
    role ? `叙事身份：${role}` : '叙事身份：未提供',
    age ? `年龄段：${age}` : '年龄段：未提供',
    gender ? `性别：${gender}` : '性别：未提供',
    appearance ? `固定外貌：${appearance}` : '固定外貌：未提供，等待人工补充',
    resolvedCostume ? `固定服装与随身物件：${resolvedCostume}` : '固定服装与随身物件：由 Agent 根据剧本场景、时代、身份和动作自动整理，生成前必须补齐',
    personality ? `性格与表演气质：${personality}` : '性格与表演气质：未提供',
    voiceStyle ? `声线参考：${voiceStyle}` : '声线参考：未提供，沿用角色音色绑定',
    projectVisualStyle ? `项目视觉风格：${projectVisualStyle}` : '项目视觉风格：未提供',
    buildGenrePromptContext(projectCategory, 'character'),
    temporalStates.length
      ? `Agent 已识别时空状态：${temporalStates.join('、')}；每个状态单独排版为一组资产`
      : 'Agent 暂未识别多个时空状态；按当前状态生成默认资产组',
    '',
    '生成要求：',
    '优先一次生成完整角色资产板：左侧基础正面全身、右上完整脸部特写、右下正面/严格侧面/背面三张全身视图；五个区域必须来自同一角色和同一套服装；统一使用纯白背景和均匀柔光。',
    noFace
      ? '本角色在剧情中明确不直接露脸：基础正面全身图也必须保持脸部不可辨识，不得生成清晰正脸肖像；优先使用背对镜头、遮挡或肩手构图，同时保持从头到鞋的身体和固定服饰可复核。'
      : '',
    '如果剧本存在多个时空状态，先按状态拆成独立资产组；每组分别生成对应服饰、随身物件、年龄呈现和场景环境，不把不同状态混在一张图里。',
    '资产板将作为角色身份基准；后续视频、静帧和分镜统一引用这张已确认母板，保持同一张脸、同一体态、同一服装和同一配饰。',
    '整张资产板为横向16:9；每个全身区域内部的人物从头顶到鞋底完整可见，脸部特写独立位于右上区域，不添加其他人物和无关道具。',
    '真人结构细节：面部保留自然轻微不对称，眼睛、鼻翼、嘴唇、耳朵、发际线、皮肤细纹和肤色变化真实；手指五根且关节、指甲、掌纹自然，四肢关节连接正确，鞋子成对完整。禁止蜡像皮肤、塑料皮肤、六指、融合手、额外肢体、发型长度漂移和服装细节漂移。',
    '当图片模型支持资产板时，必须优先使用资产板模式；应用直接保存并展示这张完整同源母板，不按固定坐标裁切，不把局部裁片当作独立角色资产。',
  ]

  return {
    prompt: lines.join('\n'),
    turnaroundPrompt: buildCharacterTurnaroundPrompt({ character: { ...character, costume: resolvedCostume } }),
    negativePrompt: NEGATIVE_PROMPT,
    source: 'script-agent',
    version: 'script-character-prompt-v1',
  }
}

export function buildScriptScenePrompt({ scene = {}, projectVisualStyle = '', projectCategory = '', characterNames = [] } = {}) {
  const title = firstValue(scene.title, '未命名场景')
  const location = activeScreenplayLocation(scene) || inferSceneLocation(scene)
    || '地点未明确，须根据本场动作与剧情功能推断最小必要空间'
  const timeOfDay = inferSceneTimeOfDay(scene)
    || '时间未明确，须根据剧情事件、光线需求和人物行动推断并标注为推断'
  const screenplay = firstValue(scene.content, scene.summary, '')
  const environmentEvidence = sanitizeSceneEnvironmentEvidence(screenplay, characterNames)
  const explicitFixtures = extractExplicitSceneFixtures(scene)
    .map(({ label }) => label)
  const fixtureRequirement = explicitFixtures.length
    ? `剧本明确固定设施（必须在场景资产中出现）：${explicitFixtures.join('、')}`
    : '剧本明确固定设施：当前文本未识别到专用设施；不得凭空增加剧情道具。'
  const visualStyle = text(projectVisualStyle)

  return [
    buildPromptTemplateContext('scene'),
    `场景：${title}`,
    `时空：${timeOfDay}`,
    `地点：${location}`,
    `环境空间证据：${environmentEvidence.slice(0, 5000) || '剧本没有明确空间细节；根据场景地点、时间和固定物件建立可复核的最小空间布局。'}`,
    visualStyle ? `项目视觉风格：${visualStyle}` : '',
    projectCategory ? buildGenrePromptContext(projectCategory, 'scene') : '',
    '规划输出按空间功能与尺度、建筑/开口方位、固定物件关系、材质磨损、实体光源与衰减、构图可见范围组织；没有剧本依据的补足标记为推断。',
    '本节点提示词用于全景空场母版。先生成并采用唯一母版，再由后续流程基于同一空间锚点生成九个独立视角候选；不在本提示词中重复描述九个镜头或重写房间。',
    '空间缺少剧本事实时，标记推断依据并补足服务于镜头的最小可拍摄布局。',
    '地点或时间不同的场景必须独立归组，不覆盖其他场景资产。',
  ].filter(Boolean).join('\n')
}

function buildSceneEnvironmentPrompt({ scene = {}, projectVisualStyle = '', projectCategory = '', characterNames = [] } = {}) {
  const title = firstValue(scene.title, '未命名场景')
  const location = activeScreenplayLocation(scene) || inferSceneLocation(scene)
    || '根据本场动作与关键道具推断的最小可用空间；若剧本未明确，默认建立能容纳全部动作的单一室内空间'
  const panoramaLocation = /视频|监控|回忆|闪回/u.test(`${title} ${location}`)
    ? '对应视频/监控/回忆内容所在的完整室内空间空场全景（忽略原文中的肩手近景、局部特写和镜头景别）'
    : location
  const timeOfDay = inferSceneTimeOfDay(scene)
    || '根据剧本光线、声音和事件节奏推断的时间状态'
  const screenplay = firstValue(scene.content, scene.summary, '')
  const environmentEvidence = sanitizeSceneEnvironmentEvidence(screenplay, characterNames)
  const explicitFixtures = extractExplicitSceneFixtures(scene).map(({ label }) => label)
  const fixtureRequirement = explicitFixtures.length
    ? `剧本明确固定设施（必须在场景资产中出现）：${explicitFixtures.join('、')}`
    : '剧本明确固定设施：当前文本未识别到专用设施；不得凭空增加剧情道具。'
  const style = text(projectVisualStyle)
  const spatialAnchorsValue = scene.spatial_anchors || scene.spatialAnchors || scene.spatial_anchors_json || null
  let spatialAnchors = spatialAnchorsValue
  if (typeof spatialAnchorsValue === 'string') {
    try {
      spatialAnchors = JSON.parse(spatialAnchorsValue)
    } catch {
      spatialAnchors = null
    }
  }
  const spatialAnchorsJson = spatialAnchors
    ? JSON.stringify(spatialAnchors)
    : '尚未生成；场景规划 Agent 必须先依据本场剧情结构化生成后再提交图片任务。'

  return [
    buildPromptTemplateContext('scene'),
    `环境资产场景：${title}`,
    `空间类型与功能：${panoramaLocation}`,
    `时间与光线状态：${timeOfDay}`,
    '只提取并锁定环境信息：建筑结构、空间尺度、前后左右关系、中心轴、入口出口、门窗方向、固定家具、固定设备、主要环境道具、地面、天花板、材质、光线方向、色彩关系和镜头可见范围。',
    `剧本环境证据（Agent 提取的空间事实）：${environmentEvidence.slice(0, 5000)}`,
    fixtureRequirement,
    `空间锚点 JSON（唯一结构来源）：${spatialAnchorsJson}`,
    '材质与光线必须回扣本场证据：材质写物理表面和磨损依据，光源写实体来源、方向、色温、范围及衰减，并说明 narrative_reason；不套用其他场景的固定色板。',
    '这是空场环境资产，不是剧情镜头。人物姓名、外貌、服装、动作、表演、对白、声音和剧情事件只可作为空间推理证据，不得出现在图像提示词或画面中。',
    '画面禁止人物、剪影、照片/遗像、人体倒影、屏幕内容、邮件、乱码、字幕、文字和水印；纸张与屏幕如属空间物件，只呈现无字状态。',
    '遵守可信建筑比例、家具尺度、接触阴影、材质粗糙度、自然曝光和真实光线衰减；禁止悬浮物、重复家具、无来源泛光、塑料表面和概念图式布景。',
    '九机位由独立流程读取同一全景母图和 spatial_anchors；当前图片模型只会进行参考图引导重绘，不代表确定性三维采样。',
    style ? `项目视觉风格：${style}` : '',
    projectCategory ? buildGenrePromptContext(projectCategory, 'scene') : '',
  ].filter(Boolean).join('\n')
}

export { NEGATIVE_PROMPT, buildSceneEnvironmentPrompt }
