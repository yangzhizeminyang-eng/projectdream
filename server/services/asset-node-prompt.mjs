/**
 * @file 资产画布节点提示词组装（纯函数）
 * @description
 * 画布节点是「形象变体」，不是角色身份。这里最关键的规则是：
 *
 * 既有角色约束写的是「不得换脸、改龄、改性别」。但画布上真正要做的恰恰是
 * 「十八年前的老陈」「5 岁的小光」——同一条提示词里既禁止改龄又要求改年龄，
 * 模型拿到的是一段自相矛盾的指令，出图必然不稳。
 *
 * 所以变体有自己的一条规则：脸、发型、体态、身份参考图始终锁死；
 * 年龄呈现、服装和时代环境按变体声明放行。已锁定外貌的角色再收紧一层，
 * 变体必须在锁定基准上演绎，不能重新发明长相。
 */

import { buildColorContinuityConstraints } from './color-continuity.mjs'
import { PROP_ASSET_SKILL_RULES, joinProductionPromptRules } from './ai/skills/production-prompt-rules.mjs'
import { buildPromptTemplateContext } from './ai/prompt-template-skill.mjs'
import { buildPropAssetViewPrompt } from './asset-props.mjs'

function text(value) {
  return String(value ?? '').trim()
}

function readNode(node, camelKey, snakeKey) {
  return text(node?.[camelKey] ?? node?.[snakeKey])
}

/**
 * 组装角色身份锁文本。
 * 场景 / 道具节点没有角色身份，返回空字符串，由调用方决定后续拼装。
 */
export function buildAssetNodeIdentityLock({ character, appearanceLabel, appearanceLocked } = {}) {
  if (!character) return ''

  const name = text(character.name) || '未命名角色'
  const roleTag = text(character.role_tag ?? character.roleTag)
  const gender = text(character.gender)
  const appearance = text(character.appearance)
  const costume = text(character.costume)
  const referenceImageUrl = text(
    character.reference_image_url ?? character.referenceImageUrl,
  )
  const variantLabel = text(appearanceLabel)

  const baselineLine = appearanceLocked
    ? `外貌基准已锁定：${appearance || '见角色档案'}。变体只能在该基准上做年龄、服装与环境演绎，不得重新设计长相。`
    : appearance
      ? `固定外貌：${appearance}`
      : ''

  const variantClause = variantLabel
    ? `本次生成该角色的形象变体「${variantLabel}」：保持同一张脸、同一发型、同一体态，但按变体声明调整年龄呈现、服装与时代环境，仍不得换脸、改性别或用其他人物替代。`
    : '生成时必须保持同一张脸、同一发型、同一体态、同一固定服装、同一随身物件，不得换脸、改龄、改性别或用其他人物替代。'

  return [
    `角色身份：${name}`,
    roleTag ? `角色定位：${roleTag}` : '',
    gender ? `性别：${gender}` : '',
    baselineLine,
    variantLabel ? '' : costume ? `固定服装与随身物件：${costume}` : '',
    referenceImageUrl ? `唯一身份参考图：${referenceImageUrl}` : '',
    variantClause,
  ]
    .filter(Boolean)
    .join('\n')
}

function readNodeShape(node) {
  return {
    promptText: readNode(node, 'promptText', 'prompt_text'),
    turnaroundPromptText: readNode(node, 'turnaroundPromptText', 'turnaround_prompt_text'),
    environmentPromptText: readNode(node, 'environmentPromptText', 'environment_prompt_text'),
    negativePrompt: readNode(node, 'negativePrompt', 'negative_prompt'),
    label: readNode(node, 'label', 'label'),
    appearanceLabel: readNode(node, 'appearanceLabel', 'appearance_label'),
    nodeType: readNode(node, 'nodeType', 'node_type'),
  }
}

/**
 * Resolve the prompt for an asset-node image job.
 * A scene's full prompt is needed by storyboard/context features, but the
 * panorama image job must use the isolated environment prompt even when an
 * older client sends the full prompt as `body.prompt`.
 */
export function resolveAssetNodeGenerationPrompt({
  node,
  requestedViewType = 'single',
  promptOverride = '',
} = {}) {
  const shape = readNodeShape(node)
  const override = text(promptOverride)
  if (shape.nodeType === 'scene' && text(requestedViewType) === 'single') {
    return shape.environmentPromptText || override || shape.promptText
  }
  return override || shape.promptText
}

const SCENE_NINE_GRID_ANGLES = [
  '左前方广角',
  '正前方中景',
  '右前方广角',
  '左侧面中景',
  '正中轴平视',
  '右侧面中景',
  '左后方广角',
  '正后方中景',
  '右后方广角',
]

export function buildCharacterViewNegativePrompt(viewKey = '', options = {}) {
  const common = [
    '场景背景',
    '室内环境',
    '机房',
    '剧情画面',
    '多人',
    '拼贴',
    '九宫格',
    '文字',
    '水印',
    '半身',
    '裁切',
  ]
  const angleSpecific = {
    side: ['正面脸', '正面视角', '双眼同时可见', '胸口正对镜头', '三分之四侧面'],
    back: ['可见脸部', '正面脸', '正面视角', '眼睛', '鼻子', '嘴巴', '眼镜镜片', '胸前衣物正面'],
  }[String(viewKey || '').trim()] || []
  if (String(viewKey || '').trim() === 'front' && options?.noFace) {
    angleSpecific.push('清晰正脸', '可辨识脸部', '完整五官特写')
  }
  return [...common, ...angleSpecific].join('，')
}

/**
 * 为画布的锁定组生成明确的视图任务。
 * 角色三视图是一张包含正/侧/背的转面板；
 * 场景九宫格必须以已确认全景为参考，不能凭空生成九张互不相关的图。
 */
export function buildAssetNodeViewPrompt({
  node,
  character,
  projectVisualStyle,
  appearanceLocked,
  viewType = '',
  viewKey = '',
  referenceImageUrl = '',
  baseReferenceImageUrl = '',
} = {}) {
  const shape = readNodeShape(node)

  if (viewType === 'character-turnaround') {
    if (shape.nodeType !== 'character') throw new Error('只有角色节点可以生成三视图')
    const baseReference = text(baseReferenceImageUrl)
    if (!baseReference) throw new Error('请先确认角色基础正面全身图，再生成三视图')
    const angle = {
      front: '正面',
      side: '严格左侧面',
      back: '背面',
    }[text(viewKey)]
    if (!angle) throw new Error('三视图生成必须指定正面、侧面或背面视角')
    const characterIdentity = buildAssetNodeIdentityLock({
      character,
      appearanceLabel: shape.appearanceLabel,
      appearanceLocked,
    })
    const turnaroundPrompt = shape.turnaroundPromptText
      || '生成角色三视图专用提示词：基于已确认的基础正面全身图，严格保持同一张脸、发型、妆容、体态、服装、鞋子和配饰，分别输出正面、严格90度侧面和背面三个独立全身视角；纯白背景、均匀柔光、从头到鞋完整入镜，不读取剧情场景，不添加道具、文字、水印或其他人物。'
    const noFaceCharacter = /正脸不呈现|不直接露脸|不出现正脸|脸部.*不可见/u.test(
      [character?.appearance, character?.costume, characterIdentity, turnaroundPrompt].filter(Boolean).join('\n'),
    )
    if (!shape.promptText && !characterIdentity && !turnaroundPrompt) {
      throw new Error('请先填写角色外貌或角色资产提示词')
    }
    return {
      prompt: [
        '任务类型：角色资产转面单视图生成。',
        '只生成角色本身，不生成剧情画面，不生成场景，不生成故事分镜。',
        `角色名：${shape.label || text(character?.name) || '未命名角色'}`,
        // 三视图阶段只读取身份锁和已确认基础图，不能把剧情/项目风格提示词带入生图。
        turnaroundPrompt,
        characterIdentity,
        `以已确认的角色基础正面全身图为唯一形象基准（仅用于保持脸、发型、体态、服装和配饰一致）：${baseReference}`,
        '这是同一角色的设定参考图，不是三联画、九宫格或场景图；严禁把参考图里的场景、机房、灯光、背景或剧情画面复制到输出。',
        '身份一致性硬约束：正面基础图中的脸型、五官、妆容、眉形、眼妆、发际线、发色、发长、发量、发型轮廓、耳朵、身材比例、固定服装、鞋子和配饰必须在本视角完全一致；严禁长发变短发、短发变长发、换妆、换衣、换鞋或更换人物。',
        `本次只输出${angle}一个视角。画面中只能出现一个该角色，必须是从头顶到鞋底的完整全身照，头发、鞋子和脚底轮廓全部在画面内，人物上下左右留出安全边距，绝不裁切。`,
        '背景必须是无纹理纯白色摄影棚背景（#FFFFFF），均匀柔光，无地面场景、无室内环境、无道具。',
        '人物自然站立，双脚完整可见且落在画面内，双臂完整可见，手掌和五指自然成形，手指数量正确，手臂与肩膀连接自然，关节比例真实，避免融手、断指、额外手指、手臂畸变、腿部粘连和鞋子缺失。',
        '保持真实人体比例和摄影棚证件式资产参考图构图：全身人物占画面高度约80%至90%，镜头平视，人物居中，视角必须严格符合本次指定视角。',
        text(viewKey) === 'front'
          ? noFaceCharacter
            ? '正面身体硬约束：人物身体和固定服装正面对镜头，头部保持不可辨识（头部略低、背光或被阴影遮挡），不得出现清晰正脸、双眼、鼻子、嘴巴或可辨识五官；仍须从头顶到鞋底完整入镜。'
            : '正面硬约束：人物面向镜头，双眼、鼻子、嘴巴、眼镜和胸前衣物正面清晰可见；不能出现后脑勺、背部或背面构图。'
          : text(viewKey) === 'side'
            ? '侧面硬约束：人物身体和头部必须严格旋转到镜头左侧90度，肩线、胸口、骨盆和双脚都呈侧向；只能看到一个侧脸轮廓，远侧眼睛不可见，胸口不能正对镜头；如果画面仍能清楚看到双眼、鼻梁正面、胸前衣物正面或两只鞋的正面，视为错误正面图，必须拒绝；不能生成三分之四侧面、正面或背面；发型轮廓和发长必须与基础正面图一致。'
            : '背面硬约束：人物背对镜头，后脑勺和后颈可见，脸部、眼睛、鼻子、嘴巴、眼镜镜片和胸前衣物细节不可见；只能看到背部、后肩、后臂、后腰、臀部、腿部后侧和鞋后跟，绝对不能出现正面脸部；后脑勺发型、发长、发量和发尾必须与基础正面图一致。',
        '禁止半身照；不得输出膝上构图、腿部裁切、脚部裁切、不得输出拼贴、三联画、九宫格、电影场景、动作分镜、多人合影、第二个人、剧情道具、文字或水印。',
      ].join('\n'),
      candidateCount: 1,
      referenceImageUrls: [baseReference],
      viewIndex: { front: 1, side: 2, back: 3 }[text(viewKey)],
      viewKey: text(viewKey),
      viewLabel: { front: '正面', side: '严格侧面', back: '背面' }[text(viewKey)],
    }
  }

  if (viewType === 'character-face-closeup') {
    if (shape.nodeType !== 'character') throw new Error('只有角色节点可以生成脸部特写')
    const baseReference = text(baseReferenceImageUrl)
    if (!baseReference) throw new Error('请先确认角色基础正面全身图，再生成脸部特写')
    const characterIdentity = buildAssetNodeIdentityLock({
      character,
      appearanceLabel: shape.appearanceLabel,
      appearanceLocked,
    })
    const closeupPrompt = [
      '任务类型：角色脸部特写专用资产生成。',
      '只读取已确认基础正面全身图和角色身份锁，不读取剧情场景、分镜动作、对白、环境或项目背景风格。',
      '基于同一张已确认基础正面全身图，生成同一角色的正面脸部特写参考图；脸型、五官比例、妆容、肤色、皮肤纹理、发际线、发色、发长、耳朵和下颌线必须与基础图一致。',
      '纯白背景（#FFFFFF）、均匀柔光、无地面环境、无道具、无文字、无水印、无其他人物。',
      '画面从头顶发际线到锁骨上方完整入镜，双耳、下颌线和发型轮廓完整可见，不裁切头发、耳朵或下巴；正面平视，人物居中，保留安全边距。',
      '真实人体细节：眼睑、瞳孔、虹膜高光、眉毛、鼻梁鼻翼、嘴唇、耳廓耳垂和皮肤细纹自然，保留轻微自然不对称；禁止塑料皮肤、蜡像脸、磨皮过度、换脸、年龄漂移和发型漂移。',
      '禁止生成全身、半身动作、三视图、侧面、背面、三分之四侧脸、场景背景、剧情道具、字幕、文字和水印。',
    ].join('\n')
    return {
      prompt: [
        closeupPrompt,
        `角色名：${shape.label || text(character?.name) || '未命名角色'}`,
        characterIdentity,
        `以已确认的角色基础正面全身图为唯一形象基准：${baseReference}`,
        '身份一致性硬约束：基础图中的脸型、眼眉、眼距、鼻型、唇形、耳朵、下颌线、发际线、发长、发量、妆容和肤色必须完全一致。',
      ].filter(Boolean).join('\n'),
      candidateCount: 1,
      referenceImageUrls: [baseReference],
      viewIndex: 1,
      viewKey: 'face',
      viewLabel: '脸部特写',
    }
  }

  if (viewType === 'prop-turnaround') {
    if (!['prop', 'tool', 'material'].includes(shape.nodeType)) throw new Error('只有道具、工具或材料节点可以生成道具多视角')
    const reference = text(referenceImageUrl)
    if (!reference) throw new Error('请先确认道具基础图，再生成道具多视角')
    const key = text(viewKey)
    return {
      prompt: [
        buildPropAssetViewPrompt({ prop: { name: shape.label, details: shape.promptText }, viewKey: key }),
        `已确认道具基础图（唯一外观基准）：${reference}`,
      ].join('\n'),
      candidateCount: 1,
      referenceImageUrls: [reference],
      viewIndex: { front: 1, side: 2, back: 3, top: 4 }[key],
      viewKey: key,
      viewLabel: { front: '正面', side: '侧面', back: '背面', top: '俯视' }[key],
    }
  }

  if (viewType === 'scene-nine-grid') {
    if (shape.nodeType !== 'scene') throw new Error('只有场景节点可以生成九宫格')
    const panorama = String(referenceImageUrl || '').trim()
    if (!panorama) throw new Error('请先确认场景全景基准图，再生成九宫格')
    const scenePrompt = shape.environmentPromptText || shape.promptText
    if (!scenePrompt) throw new Error('请先填写场景提示词')
    // 九宫格是环境资产锁定阶段。不能把完整剧本动作、人物表演、
    // 葬礼回忆或视频内容继续原样交给生图模型，否则模型会把角色
    // 当成场景主体画进母图。这里保留节点里的空间锚点与道具信息，
    // 但用明确的环境-only边界隔离剧情层。
    const environmentOnlyPrompt = [
      '任务类型：已确认场景全景的环境资产单视角锁定候选。',
      '只生成同一空间的空场环境，不生成任何人物或人物相关内容。',
      '只读取下面提示词中的空间结构、建筑、固定家具、固定设备、门窗、地面、天花板、材质、光线和色彩信息；忽略人物姓名、人物动作、服装、表情、对话、葬礼回忆、遗照、视频画面、邮件内容、代码内容和剧情事件。',
      '空间锚点提示词：',
      scenePrompt,
      buildColorContinuityConstraints({
        visualStyle: projectVisualStyle,
        scenePrompt,
      }),
      '环境主体限定：严格依据上方场景锚点和已确认全景，不得补入其它示例场景或未出现的空间；画面中不得出现人物、人物剪影、人物照片、遗像、脸、手、腿、人形、人体倒影或任何角色主体。',
    ].join('\n')
    return {
      prompt: [
        environmentOnlyPrompt,
        `这是同一空间的单一环境视角候选，必须以全景基准图为唯一空间参考：${panorama}`,
        '先读取节点中保存的完整场景锚点清单；全景图、场景结构提示词和九宫格必须视为同一套空间锁定数据。',
        '场景一致性硬约束：建筑结构、墙柱、门窗、出入口、楼梯、固定设备、主要道具、材质、空间尺度、光线方向和色彩关系必须保持完全一致；不得因机位变化重构空间。',
        '只输出一张连续、完整、单一视角的环境图，不能输出九宫格、拼贴、分格、三联画或多幅不同视角。',
        '这是环境资产锁定图，不要添加角色主体、人物照片、遗像、对白、字幕、文字和水印。',
      ].join('\n'),
      candidateCount: 1,
      referenceImageUrls: [panorama],
    }
  }

  return { prompt: basePrompt, candidateCount: 1, referenceImageUrls: [] }
}

/**
 * 真正送给模型的提示词。
 * 既没有提示词、也没有角色身份时返回 null——不替创作者编内容，
 * 由路由如实报 400，而不是生成一张看起来成功但没有依据的图。
 */
export function buildAssetNodeGenerationPrompt({
  node,
  character,
  projectVisualStyle,
  appearanceLocked,
} = {}) {
  const shape = readNodeShape(node)
  const style = text(projectVisualStyle)
  const identityLock = buildAssetNodeIdentityLock({
    character,
    appearanceLabel: shape.appearanceLabel,
    appearanceLocked,
  })

  if (!shape.promptText && !shape.environmentPromptText && !identityLock) return null

  // 场景资产有两层提示词：完整剧本提示词用于剧情/分镜上下文，
  // environmentPromptText 才是发给空场生图模型的环境层。把两层混发会
  // 让模型把“人物坐在沙发上”等动作当成场景主体画出来。
  const generationPrompt = shape.nodeType === 'scene'
    ? (shape.environmentPromptText || shape.promptText)
    : shape.promptText

  const sceneLock = shape.nodeType === 'scene'
    ? [
        '这是场景资产，不是角色肖像，不要生成人物主体或人物设定。',
        '这是场景全景基准图阶段，先输出一张完整空间全景图，明确固定空间结构，作为后续九宫格唯一空间来源。',
        '场景提示词必须先写空间类型与功能，再写建筑结构、入口出口、门窗和墙柱方位，再写固定家具/设备的数量、位置、朝向、相对距离和遮挡关系，最后写材质、光源、色彩、机位和负面约束；不要用空泛的“电影感”替代空间事实。',
        '先建立一张可作为空间基准的全景环境图：固定建筑结构、空间结构、空间尺度、材质、主要物件位置、门窗方向、光线方向与色彩关系。',
        '后续多角度视图必须来自同一个空间，不得新增、删除或移动关键结构；不同视角只改变摄影机位置与朝向。',
        '输出适合生成九宫格多角度场景锁定组图的环境画面，保持透视、布局和细节连续。',
        '场景全景硬负面约束：不得出现人物、人物剪影、人物照片、遗像、人体倒影、手臂、手指、走廊人影、任何可读或不可读的屏幕界面、邮件、账号、字母、数字、乱码、字幕、Logo 或水印；电脑和显示器只能是无内容的黑屏或纯色屏幕，协议、文件、便签和纸张只能是空白无字版本；忽略剧本中的肩手近景、局部特写和人物动作，只生成完整空场全景。',
        '真实摄影质感：以现实场地勘景照片为目标，采用可信的建筑透视、自然曝光和真实镜头景深；材质具有各自真实的粗糙度、反射与细微使用痕迹，阴影必须落在接触面并服从实际灯具和窗户方向。冷蓝环境光、暖黄灯光和局部红色警示光必须分别对应真实光源并自然衰减，禁止全画面青蓝/红色滤镜。避免塑料表面、无来源泛光、过度锐化、重复摆件、悬浮物、完美对称的CG布景和游戏渲染感；不得牺牲剧本要求的具体空间锚点来套用通用氛围。',
        '现实空间校准：桌椅、门把手、插座、踢脚线、吊顶和门窗必须符合常见真实建筑尺度；门扇开启范围与通行宽度符合现实，家具必须落地并有接触阴影，墙面、地面和天花板的交界线保持建筑逻辑，镜头视点应让空间能被人真实进入和使用。',
        '禁止无来源的装饰性布景：只保留剧本明确要求或空间功能必需的物件；不为填满画面添加盆栽、摆件、霓虹灯、额外屏幕、标牌、海报或多余家具。未被剧本确定的细节采用克制、常见、低视觉权重的现实方案，不编造新的剧情线索。',
        '画面目标是可信的现实地点勘景照片，不是概念设计图、样板间、摄影棚、游戏场景或精修地产宣传图；保留轻微使用痕迹和合理的不完美，但不把磨损夸张成废墟。',
      ].join('\n')
    : ''
  const propRules = ['prop', 'tool', 'material'].includes(shape.nodeType)
    ? [
        '这是单件道具基础资产，不是角色资产，也不是场景概念图。只生成一个完整可识别的道具本体。',
        '道具从最左边缘到最右边缘、从最高点到底部接触面完整入镜；把手、底座、开口、按钮、接口、线缆和附属结构不得被裁切。道具居中，四周有安全留白，背景干净中性。',
        '禁止人物全身构图、人体比例要求、角色肖像、手持、人物、场景、局部微距、只显示细节、拼贴、九宫格、文字、水印和多件重复道具。',
        [buildPromptTemplateContext('prop'), joinProductionPromptRules(PROP_ASSET_SKILL_RULES)].join('\n'),
      ].join('\n')
    : ''
  const colorLock = shape.nodeType === 'scene'
    ? buildColorContinuityConstraints({
        visualStyle: projectVisualStyle,
        scenePrompt: generationPrompt,
      })
    : ''

  return [
    generationPrompt,
    shape.nodeType === 'character' && shape.appearanceLabel ? `形象变体：${shape.appearanceLabel}` : '',
    shape.label ? `主体：${shape.label}` : '',
    style ? `画面风格：${style}` : '',
    identityLock,
    shape.nodeType === 'character'
      ? '角色基础形象要求：生成基础正面全身图，正面平视、单人站立、从头顶到鞋底完整全身照，头发、双手、双脚、鞋子和固定服装全部入镜，鞋子全部入镜；人物占画面高度约80%至90%，四周留安全边距，纯白背景（#FFFFFF），这是后续三视图唯一的服装、发型、妆容、鞋子和配饰基准；禁止半身、四分之三身、膝上、腰部以上和脚部裁切。'
      : '',
    sceneLock,
    propRules,
    colorLock,
    '画面清晰，构图完整，无文字水印',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 落库的提示词快照：记录创作者当时写了什么、基于哪个身份约束。
 * 和历史候选一起留存，事后能回答「这张图当时是按什么生成的」。
 */
export function buildAssetNodePromptSnapshot({
  node,
  character,
  projectVisualStyle,
  appearanceLocked,
} = {}) {
  const shape = readNodeShape(node)
  const style = text(projectVisualStyle)
  const identityLock = buildAssetNodeIdentityLock({
    character,
    appearanceLabel: shape.appearanceLabel,
    appearanceLocked,
  })

  return [
    shape.nodeType === 'scene' ? (shape.environmentPromptText || shape.promptText) : shape.promptText,
    shape.nodeType === 'character' && shape.appearanceLabel ? `形象变体：${shape.appearanceLabel}` : '',
    shape.label ? `节点：${shape.label}` : '',
    shape.nodeType ? `资产类型：${shape.nodeType}` : '',
    style ? `项目视觉风格：${style}` : '',
    shape.negativePrompt ? `负面提示词：${shape.negativePrompt}` : '',
    ['prop', 'tool', 'material'].includes(shape.nodeType)
      ? [buildPromptTemplateContext('prop'), joinProductionPromptRules(PROP_ASSET_SKILL_RULES)].join('\n')
      : '',
    identityLock,
    shape.nodeType === 'scene'
      ? '场景锁定要求：以全景基准图为源，生成九宫格固定视角组图；保持空间结构、材质、物件位置、光线方向与色彩关系一致，不生成角色肖像。'
      : '',
    shape.nodeType === 'scene'
      ? buildColorContinuityConstraints({
          visualStyle: projectVisualStyle,
          scenePrompt: shape.environmentPromptText || shape.promptText,
        })
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
