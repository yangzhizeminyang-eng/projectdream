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

export function buildCharacterViewNegativePrompt(viewKey = '') {
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
          ? '正面硬约束：人物面向镜头，双眼、鼻子、嘴巴、眼镜和胸前衣物正面清晰可见；不能出现后脑勺、背部或背面构图。'
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
      '任务类型：已确认场景全景的环境资产九宫格锁定。',
      '只生成同一空间的空场环境，不生成任何人物或人物相关内容。',
      '只读取下面提示词中的空间结构、建筑、固定家具、固定设备、门窗、地面、天花板、材质、光线和色彩信息；忽略人物姓名、人物动作、服装、表情、对话、葬礼回忆、遗照、视频画面、邮件内容、代码内容和剧情事件。',
      '空间锚点提示词：',
      scenePrompt,
      '环境主体限定：深夜城市公寓客厅与电脑工作区的固定建筑和固定物件；画面中不得出现人物、人物剪影、人物照片、遗像、脸、手、腿、人形、人体倒影或任何角色主体。',
    ].join('\n')
    return {
      prompt: [
        environmentOnlyPrompt,
        `这是同一空间的九宫格多角度锁定图，必须以全景基准图为唯一空间参考：${panorama}`,
        '先读取节点中保存的完整场景锚点清单；全景图、场景结构提示词和九宫格必须视为同一套空间锁定数据。',
        '场景一致性硬约束：建筑结构、墙柱、门窗、出入口、楼梯、固定设备、主要道具、材质、空间尺度、光线方向和色彩关系必须保持完全一致；不得因机位变化重构空间。',
        '九宫格必须严格使用一张完整的严格 3×3 画布，九个画格必须同时出现，分别对应以下摄影机视角：',
        SCENE_NINE_GRID_ANGLES.map((angle, index) => `${index + 1}. ${angle}`).join('；'),
        '逐格摄影机提示：第1格左前方广角；第2格正前方中景；第3格右前方广角；第4格左侧面中景；第5格正中轴平视；第6格右侧面中景；第7格左后方广角；第8格正后方中景；第9格右后方广角。',
        '九个格子只能改变摄影机位置、朝向和景别，不能改变建筑结构、空间尺度、门窗方向、道具位置、材质、光线方向或色彩关系。',
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

  if (!shape.promptText && !identityLock) return null

  const sceneLock = shape.nodeType === 'scene'
    ? [
        '这是场景资产，不是角色肖像，不要生成人物主体或人物设定。',
        '这是场景全景基准图阶段，先输出一张完整空间全景图，明确固定空间结构，作为后续九宫格唯一空间来源。',
        '先建立一张可作为空间基准的全景环境图：固定建筑结构、空间结构、空间尺度、材质、主要物件位置、门窗方向、光线方向与色彩关系。',
        '后续多角度视图必须来自同一个空间，不得新增、删除或移动关键结构；不同视角只改变摄影机位置与朝向。',
        '输出适合生成九宫格多角度场景锁定组图的环境画面，保持透视、布局和细节连续。',
      ].join('\n')
    : ''

  return [
    shape.promptText,
    shape.nodeType === 'character' && shape.appearanceLabel ? `形象变体：${shape.appearanceLabel}` : '',
    shape.label ? `主体：${shape.label}` : '',
    style ? `画面风格：${style}` : '',
    identityLock,
    shape.nodeType === 'character'
      ? '角色基础形象要求：正面平视、单人站立、从头顶到鞋底完整全身照，头发、双手、双脚和鞋子全部入镜，人物占画面高度约80%至90%，四周留安全边距，白色背景，作为后续三视图的唯一基础形象；禁止半身、膝上、腰部以上和脚部裁切。'
      : '',
    sceneLock,
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
    shape.promptText,
    shape.nodeType === 'character' && shape.appearanceLabel ? `形象变体：${shape.appearanceLabel}` : '',
    shape.label ? `节点：${shape.label}` : '',
    shape.nodeType ? `资产类型：${shape.nodeType}` : '',
    style ? `项目视觉风格：${style}` : '',
    shape.negativePrompt ? `负面提示词：${shape.negativePrompt}` : '',
    identityLock,
    shape.nodeType === 'scene'
      ? '场景锁定要求：以全景基准图为源，生成九宫格固定视角组图；保持空间结构、材质、物件位置、光线方向与色彩关系一致，不生成角色肖像。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}
