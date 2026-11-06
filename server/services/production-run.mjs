/**
 * @file 内容工厂生产运行领域规则
 * @description 把“市场验证 -> 单集蓝图 -> 情绪段落 -> 候选筛选 -> 发布复盘”
 *              固化成可持久化、可审批、可恢复的结构化生产运行。
 */

export const PRODUCTION_RUN_STAGES = [
  {
    key: 'market-validation',
    label: '市场题材与用户验证',
    agentKey: 'market-research',
    checkpointKey: 'market-validation',
  },
  {
    key: 'episode-blueprint',
    label: '单集高转化蓝图',
    agentKey: 'blueprint-writer',
    checkpointKey: 'blueprint',
  },
  {
    key: 'emotion-design',
    label: '情绪段落设计',
    agentKey: 'emotion-storyboard',
    checkpointKey: null,
  },
  {
    key: 'candidate-generation',
    label: '多候选生成',
    agentKey: 'generation-orchestrator',
    checkpointKey: null,
  },
  {
    key: 'candidate-selection',
    label: '人工与 Agent 筛选',
    agentKey: 'candidate-review',
    checkpointKey: 'candidate-selection',
  },
  {
    key: 'continuous-edit',
    label: '连续声音与时间线剪辑',
    agentKey: 'audio-edit',
    checkpointKey: null,
  },
  {
    key: 'pilot-release',
    label: '小样本发布',
    agentKey: 'release-package',
    checkpointKey: 'pilot-release',
  },
  {
    key: 'data-review',
    label: '平台数据复盘',
    agentKey: 'retrospective',
    checkpointKey: null,
  },
  {
    key: 'scale-decision',
    label: '扩大生产决策',
    agentKey: 'scale-decision',
    checkpointKey: null,
  },
]

const CHECKPOINT_KEYS = new Set(
  PRODUCTION_RUN_STAGES.map((stage) => stage.checkpointKey).filter(Boolean),
)

const EMOTION_BEAT_FIELDS = [
  'emotionStart',
  'emotionProcess',
  'emotionEnd',
  'actionStart',
  'actionProcess',
  'actionEnd',
  'dialoguePlan',
  'soundPlan',
  'continuity',
]

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim()
  return normalized || fallback
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function clampInteger(value, fallback, min, max) {
  return Math.max(min, Math.min(max, positiveInteger(value, fallback)))
}

export function normalizeCandidatePolicy(input = {}) {
  return {
    keyShotVideoCandidates: clampInteger(input.keyShotVideoCandidates, 3, 1, 3),
    normalShotVideoCandidates: clampInteger(input.normalShotVideoCandidates, 2, 1, 3),
    imageCandidates: clampInteger(input.imageCandidates, 3, 1, 3),
    audioCandidates: clampInteger(input.audioCandidates, 2, 1, 3),
    maxCandidateCostMultiplier: Number.isFinite(Number(input.maxCandidateCostMultiplier))
      ? Math.max(1, Math.min(5, Number(input.maxCandidateCostMultiplier)))
      : 3,
  }
}

export function normalizeProductionRunInput(input = {}) {
  const projectId = positiveInteger(input.projectId, 0)
  if (!projectId) throw new Error('ProductionRun 缺少有效 projectId')

  const platform = text(input.platform, '抖音')
  if (platform !== '抖音') {
    throw new Error('第一阶段只允许使用抖音，先收敛平台变量')
  }

  return {
    projectId,
    platform,
    episodeNo: positiveInteger(input.episodeNo, 1),
    budget: nonNegativeNumber(input.budget),
    pilotSceneCount: clampInteger(input.pilotSceneCount, 2, 1, 2),
    pilotMode: text(input.pilotMode, 'two-scenes-golden-sample'),
    candidatePolicy: normalizeCandidatePolicy(input.candidatePolicy),
    successMetrics: Array.isArray(input.successMetrics) && input.successMetrics.length
      ? input.successMetrics.map((item) => text(item)).filter(Boolean).slice(0, 8)
      : ['3秒留存', '完播率', '评论与关注意愿'],
  }
}

function resolveEpisodeVisualSetPieces(episode) {
  return Array.isArray(episode?.visualSetPieces)
    ? episode.visualSetPieces.map((item) => text(item)).filter(Boolean)
    : []
}

function normalizeDetailedScript(sourceScript = {}) {
  const scenes = Array.isArray(sourceScript?.scenes)
    ? sourceScript.scenes
      .map((scene) => ({
        sceneNo: positiveInteger(scene?.sceneNo, 0),
        title: text(scene?.title),
      }))
      .filter((scene) => scene.sceneNo > 0 || scene.title)
    : []
  const shots = Array.isArray(sourceScript?.shots)
    ? sourceScript.shots
      .map((shot, index) => ({
        sourceStoryboardId: positiveInteger(
          shot?.storyboardId ?? shot?.sourceStoryboardId,
          0,
        ) || null,
        sceneNo: positiveInteger(shot?.sceneNo, 1),
        sourceShotNo: text(shot?.shotNo, String(index + 1).padStart(2, '0')),
        durationSeconds: Math.max(1, Number(shot?.durationSeconds) || 1),
        shotType: text(shot?.shotType),
        shotPurpose: text(shot?.shotPurpose, 'story'),
        actionText: text(shot?.actionText),
        dialogueText: text(shot?.dialogueText),
        actingBeat: text(shot?.actingBeat),
        audioDirection: text(shot?.audioDirection),
        visualPrompt: text(shot?.visualPrompt),
        startVisualPrompt: text(shot?.startVisualPrompt),
        endVisualPrompt: text(shot?.endVisualPrompt),
      }))
      .filter((shot) => shot.actionText || shot.dialogueText || shot.visualPrompt)
    : []

  return {
    scenes,
    shots,
    version: text(sourceScript?.version, 'database-script'),
  }
}

function buildVoiceHardConstraints(projectId, episodeNo, sourceShots, episode = {}) {
  if (!sourceShots.length) return null

  const configured = episode?.voiceHardConstraints
  if (configured && typeof configured === 'object') {
    return {
      required: Array.isArray(configured.required) ? configured.required.map((item) => text(item)).filter(Boolean) : [],
      forbidden: Array.isArray(configured.forbidden) ? configured.forbidden.map((item) => text(item)).filter(Boolean) : [],
      notes: Array.isArray(configured.notes) ? configured.notes.map((item) => text(item)).filter(Boolean) : [],
    }
  }

  // 项目 12 的旧故事仍需要倒计时广播兼容门禁；新项目必须从自己的剧本读取约束。
  if (Number(projectId) !== 12 || Number(episodeNo) !== 1) return null

  return {
    required: ['苏岚（广播）：六。别怕，小夏。', '苏岚（广播）：四。'],
    forbidden: ['苏岚（广播）：五。', '苏岚（广播）：五'],
    notes: [
      '“六。别怕，小夏。”必须作为完整一句可听对白进入声音时间轴。',
      '“五”不生成、不读出，用环境声和反应镜头承接等待。',
      '“四”必须独立清楚，后面先接反应/收束镜头。',
    ],
  }
}

function resolveBeatIdForSourceShot(shot, index, total) {
  const purpose = text(shot?.shotPurpose).toLowerCase()
  if (purpose.includes('hook') || index === 0) return 'beat-01'
  if (purpose.includes('cliffhanger') || index === total - 1) return 'beat-05'
  if (purpose.includes('dialogue') || purpose.includes('reveal')) return index < total * 0.6 ? 'beat-03' : 'beat-04'
  if (purpose.includes('choice')) return 'beat-04'
  return index < total * 0.4 ? 'beat-02' : 'beat-03'
}

function buildSourceShotPlan(sourceScript, emotionBeats) {
  const normalized = normalizeDetailedScript(sourceScript)
  if (!normalized.shots.length) return []

  return normalized.shots.map((shot, index) => {
    const beatId = resolveBeatIdForSourceShot(shot, index, normalized.shots.length)
    const beat = emotionBeats.find((item) => item.id === beatId) || emotionBeats[0]
    const keyPurpose = new Set(['hook', 'dialogue', 'reveal', 'choice', 'cliffhanger'])

    return {
      shotKey: `scene-${shot.sceneNo}-shot-${shot.sourceShotNo}`,
      sceneNo: shot.sceneNo,
      beatId,
      shotNo: index + 1,
      sourceStoryboardId: shot.sourceStoryboardId,
      sourceShotNo: shot.sourceShotNo,
      shotType: shot.shotType,
      purpose: shot.shotPurpose || beat?.label || '故事推进',
      durationSeconds: shot.durationSeconds,
      motionRequirement: '必须完成动作起点、过程和结束状态；不可用静帧停留替代表演。',
      dialogueRequirement: shot.dialogueText || '无对白镜头只保留动作、环境声和明确的反应节拍。',
      dialogueText: shot.dialogueText,
      audioRequirement: shot.audioDirection || beat?.soundPlan || '持续环境底噪，关键动作绑定音效。',
      actingBeat: shot.actingBeat,
      actionText: shot.actionText,
      visualPrompt: shot.visualPrompt,
      startVisualPrompt: shot.startVisualPrompt,
      endVisualPrompt: shot.endVisualPrompt,
      candidateTier: keyPurpose.has(shot.shotPurpose) ? 'key' : 'normal',
    }
  })
}

function buildEmotionBeats(episode, visualSetPieces) {
  const openingHook = text(episode?.openingHook, '异常事件在第一秒发生')
  const coreConflict = text(episode?.coreConflict, '阻力逼近，主角必须做出选择')
  const reversal = text(episode?.reversal, '线索指向与观众预期不同')
  const protagonistChoice = text(episode?.protagonistChoice, '主角主动保存证据并质问阻拦者')
  const endingHook = text(episode?.endingHook, '新的证据或威胁在结尾出现')
  const primaryVisual = visualSetPieces[0] || '关键道具或异常画面出现'
  const secondaryVisual = visualSetPieces[1] || '空间深处出现新的视觉变化'

  return [
    {
      id: 'beat-01',
      phase: 'hook',
      label: '异常钩子',
      durationSeconds: 3,
      emotionStart: '平静即将被打破',
      emotionProcess: '异常信号突然进入日常空间，观众先看到结果再追问原因',
      emotionEnd: '异常',
      actionStart: '主角正在执行原本的检修或观察动作',
      actionProcess: `她停下动作，视线被${primaryVisual}吸引，身体出现可见的迟疑`,
      actionEnd: '主角转身确认异常来源',
      dialoguePlan: `开场短句或呼吸反应：${openingHook}`,
      soundPlan: '持续空间底噪 + 继电器/广播启动声 + 极短的低频压迫，不使用无设计长静音',
      continuity: '必须保留主角手中道具、服装和站位，下一镜从确认异常的视线方向接入',
      sceneNo: 1,
      shotCount: 2,
    },
    {
      id: 'beat-02',
      phase: 'pressure',
      label: '迟疑与压力',
      durationSeconds: 5,
      emotionStart: '异常',
      emotionProcess: '主角试图用理性解释，但外部阻力快速逼近',
      emotionEnd: '迟疑转为恐惧',
      actionStart: '主角靠近控制台或证据源',
      actionProcess: `阻拦者进入空间，${coreConflict}；主角一边后退一边保护证据`,
      actionEnd: '主角被迫在继续观察和立即逃离之间停顿',
      dialoguePlan: '对白必须拆成短句，保留阻拦者打断、主角吸气和半拍停顿',
      soundPlan: '脚步/金属触碰进入前景；环境底噪持续；对白出现时 BGM 自动避让',
      continuity: '阻拦者从上一镜主角视线方向进入，主角和控制台之间的空间关系不能跳变',
      sceneNo: 1,
      shotCount: 2,
    },
    {
      id: 'beat-03',
      phase: 'reveal',
      label: '记忆击中与反转',
      durationSeconds: 5,
      emotionStart: '恐惧',
      emotionProcess: '证据触发旧记忆，观众得到一条改变解释方向的新信息',
      emotionEnd: '记忆击中',
      actionStart: '主角伸手触碰证据或旧设备',
      actionProcess: `${reversal}；主角表情从防备变成确认，手部动作短暂失控后重新抓紧道具`,
      actionEnd: '主角意识到这不是普通故障',
      dialoguePlan: '保留一句能被声音表演的反应台词，避免用旁白解释反转',
      soundPlan: '加入带距离感的广播/录音声，低频底噪与七声金属敲击形成记忆指纹',
      continuity: `必须从${secondaryVisual}或上一镜道具特写切入，音效先于画面半拍进入`,
      sceneNo: 1,
      shotCount: 2,
    },
    {
      id: 'beat-04',
      phase: 'choice',
      label: '主动选择与质问',
      durationSeconds: 6,
      emotionStart: '记忆击中',
      emotionProcess: '主角停止等待解释，承担风险把证据留存并正面对抗阻拦者',
      emotionEnd: '恐惧转为主动质问',
      actionStart: '主角握紧关键道具并重新站稳',
      actionProcess: `${protagonistChoice}；她完成重启/保存/质问中的连续动作，不用摆 pose 代替过程`,
      actionEnd: '主角把证据举到阻拦者面前，要求对方回答',
      dialoguePlan: '对白、呼吸和动作分开标注，主角最后一句必须落在镜头切点前',
      soundPlan: '动作音效跟随手部和机械动作；BGM 从压迫转为推进；不覆盖关键对白',
      continuity: '主角的手套、钥匙、磁带或手机状态必须与上一镜一致，动作结束后才能切反应镜头',
      sceneNo: 2,
      shotCount: 2,
    },
    {
      id: 'beat-05',
      phase: 'cliffhanger',
      label: '证据钩子',
      durationSeconds: 5,
      emotionStart: '主动质问',
      emotionProcess: '主角以为获得答案，新的声音或威胁立即推翻安全感',
      emotionEnd: '不安与追更冲动',
      actionStart: '主角保持质问姿态，空间暂时安静',
      actionProcess: `录音/广播给出新的证据：${endingHook}；主角的视线移向画外，不直接解释后果`,
      actionEnd: '镜头停在证据、倒计时或阻拦者反应上',
      dialoguePlan: '结尾只保留能引发下一集的问题，最后一个字后留极短呼吸尾音',
      soundPlan: '环境底噪继续，关键提示音收紧，BGM 在钩子落点处截断或反向拉起',
      continuity: '结尾画面必须留下可在下一集接续的物件/视线/声音，不得回到普通状态',
      sceneNo: 2,
      shotCount: 2,
    },
  ]
}

export function buildEpisodeBlueprint({
  projectId,
  episodeNo = 1,
  episode = {},
  bible = {},
  platform = '抖音',
  candidatePolicy = normalizeCandidatePolicy(),
  sourceScript = null,
} = {}) {
  const visualSetPieces = resolveEpisodeVisualSetPieces(episode)
  const emotionBeats = buildEmotionBeats(episode, visualSetPieces)
  const normalizedSourceScript = normalizeDetailedScript(sourceScript || {})
  const sourceShotPlan = buildSourceShotPlan(sourceScript, emotionBeats)
  const voiceHardConstraints = buildVoiceHardConstraints(
    projectId,
    episodeNo,
    normalizedSourceScript.shots,
    episode,
  )
  const fallbackShotPlan = emotionBeats.flatMap((beat, index) =>
    Array.from({ length: beat.shotCount }, (_, shotIndex) => ({
      shotKey: `${beat.id}-${shotIndex + 1}`,
      sceneNo: beat.sceneNo,
      beatId: beat.id,
      shotNo: index * 2 + shotIndex + 1,
      purpose: beat.label,
      durationSeconds: Math.max(2, Math.round(beat.durationSeconds / beat.shotCount)),
      motionRequirement: '必须有动作起点、过程和结束状态',
      dialogueRequirement: beat.dialoguePlan,
      audioRequirement: beat.soundPlan,
      candidateTier: ['hook', 'reveal', 'choice', 'cliffhanger'].includes(beat.phase)
        ? 'key'
        : 'normal',
    })),
  )

  return {
    projectId: positiveInteger(projectId, 0),
    platform: text(platform, '抖音'),
    episodeNo: positiveInteger(episodeNo, 1),
    title: text(episode.title, `第 ${episodeNo} 集`),
    promise: text(bible.emotionalPromise, '强冲突、连续声音和结尾追更钩子'),
    logline: text(episode.logline),
    targetDurationSeconds: positiveInteger(
      episode.targetDurationSeconds,
      normalizedSourceScript.shots.reduce(
        (total, shot) => total + Number(shot.durationSeconds || 0),
        0,
      ) || 24,
    ),
    pilotSceneCount: 2,
    pilotMode: 'two-scenes-golden-sample',
    openingHook: text(episode.openingHook),
    goal: text(episode.goal),
    coreConflict: text(episode.coreConflict),
    irreversibleChange: text(episode.irreversibleChange),
    protagonistChoice: text(episode.protagonistChoice),
    reversal: text(episode.reversal),
    endingHook: text(episode.endingHook),
    visualSetPieces,
    emotionBeats,
    shotPlan: sourceShotPlan.length ? sourceShotPlan : fallbackShotPlan,
    continuityConstraints: [
      '主角服装、发型、关键道具和角色版本必须锁定；新候选不得污染已确认主版本。',
      '每个镜头都要记录起始帧、动作过程、结束帧，禁止用静帧回退伪装连续表演。',
      '对白、嘴型、字幕和声音效果必须来自同一时间轴，广播声音需要保留空间距离感。',
      '上一镜的视线、站位和道具状态必须能解释下一镜的动作，不允许无因果跳变。',
      '验证片必须持续有环境底噪；静默只能作为蓝图中的明确设计。',
    ],
    soundDesign: {
      tracks: ['dialogue', 'environment', 'sfx', 'music', 'subtitle'],
      dialoguePolicy: '对白先锁时钟，再生成嘴型和字幕；关键对白不得被 BGM 覆盖',
      environmentPolicy: '持续空间底噪，按镜头空间变化做渐变',
      musicPolicy: '按情绪段进入、避让对白，在结尾钩子落点做截断或拉起',
      sfxPolicy: '继电器、脚步、金属触碰、磁带/广播提示音必须绑定动作时间点',
      designedSilencePolicy: '只允许蓝图明确标记的短静默，不允许生成失败导致长静音',
    },
    candidatePolicy: normalizeCandidatePolicy(candidatePolicy),
    sourceEvidence: {
      episodeFields: [
        'openingHook',
        'coreConflict',
        'protagonistChoice',
        'irreversibleChange',
        'reversal',
        'endingHook',
      ],
      lockedFacts: Array.isArray(bible.lockedFacts) ? bible.lockedFacts.slice(0, 20) : [],
      locations: Array.isArray(bible.locations) ? bible.locations.slice(0, 10) : [],
      characters: Array.isArray(bible.characters)
        ? bible.characters.map((character) => text(character?.name)).filter(Boolean).slice(0, 20)
        : [],
      sourceType: sourceShotPlan.length ? 'detailed-script' : 'season-structure',
      scriptVersion: normalizedSourceScript.version,
      sceneCount: normalizedSourceScript.scenes.length,
      shotCount: sourceShotPlan.length,
      sourceStoryboardIds: sourceShotPlan
        .map((shot) => shot.sourceStoryboardId)
        .filter((id) => Number.isSafeInteger(id) && id > 0),
      dialogueLines: sourceShotPlan
        .map((shot) => shot.dialogueText)
        .filter(Boolean),
      voiceHardConstraints,
    },
  }
}

export function evaluateEpisodeBlueprint(blueprint = {}) {
  const blockers = []
  const warnings = []
  const duration = Number(blueprint.targetDurationSeconds)
  const beats = Array.isArray(blueprint.emotionBeats) ? blueprint.emotionBeats : []
  const shotPlan = Array.isArray(blueprint.shotPlan) ? blueprint.shotPlan : []
  const continuity = Array.isArray(blueprint.continuityConstraints)
    ? blueprint.continuityConstraints.filter((item) => text(item))
    : []
  const sourceEvidence = blueprint.sourceEvidence && typeof blueprint.sourceEvidence === 'object'
    ? blueprint.sourceEvidence
    : null

  if (!Number.isFinite(duration) || duration < 15 || duration > 60) {
    blockers.push({
      code: 'invalid-duration',
      message: '验证蓝图时长必须在 15～60 秒之间。',
    })
  }

  if (beats.length < 4 || beats.some((beat) => EMOTION_BEAT_FIELDS.some((field) => !text(beat?.[field])))) {
    blockers.push({
      code: 'emotion-beats-incomplete',
      message: '每个情绪段必须具备情绪起点、过程、终点，动作起点、过程、终点，对白、声音和连续性。',
    })
  }

  const phases = new Set(beats.map((beat) => text(beat?.phase)))
  if (!phases.has('hook')) {
    blockers.push({ code: 'missing-hook-beat', message: '缺少开场钩子情绪段。' })
  }
  if (!phases.has('cliffhanger')) {
    blockers.push({ code: 'missing-cliffhanger-beat', message: '缺少结尾追更钩子情绪段。' })
  }

  if (continuity.length < 3) {
    blockers.push({
      code: 'missing-continuity-constraints',
      message: '至少需要 3 条跨镜头连续性约束。',
    })
  }

  if (!shotPlan.length) {
    blockers.push({
      code: 'missing-shot-plan',
      message: '情绪段必须进一步落成镜头计划，不能直接进入素材生成。',
    })
  }

  if (sourceEvidence?.sourceType === 'detailed-script') {
    const expectedShotCount = Number(sourceEvidence.shotCount)
    if (Number.isInteger(expectedShotCount) && expectedShotCount > 0 && shotPlan.length !== expectedShotCount) {
      blockers.push({
        code: 'source-shot-plan-mismatch',
        message: `详细剧本要求 ${expectedShotCount} 个镜头，当前蓝图只有 ${shotPlan.length} 个。`,
      })
    }

    const constraints = sourceEvidence.voiceHardConstraints || {}
    const dialogue = shotPlan.map((shot) => text(shot?.dialogueText || shot?.dialogueRequirement)).join('\n')
    for (const required of Array.isArray(constraints.required) ? constraints.required : []) {
      if (!dialogue.includes(text(required))) {
        blockers.push({
          code: 'required-dialogue-missing',
          message: `缺少硬约束对白：${required}`,
        })
      }
    }
    for (const forbidden of Array.isArray(constraints.forbidden) ? constraints.forbidden : []) {
      if (dialogue.includes(text(forbidden))) {
        blockers.push({
          code: 'forbidden-dialogue',
          message: `禁止对白出现在蓝图中：${forbidden}`,
        })
      }
    }
  }

  if (!text(blueprint.openingHook) || !text(blueprint.endingHook)) {
    blockers.push({
      code: 'missing-story-hook',
      message: '单集蓝图必须保留开场钩子和结尾追更钩子。',
    })
  }

  const keyShotCount = shotPlan.filter((shot) => shot?.candidateTier === 'key').length
  const normalShotCount = shotPlan.filter((shot) => shot?.candidateTier === 'normal').length
  if (keyShotCount === 0 || normalShotCount === 0) {
    blockers.push({
      code: 'candidate-tier-incomplete',
      message: '镜头计划必须同时包含关键镜头和普通镜头，才能执行差异化候选策略。',
    })
  }

  if (beats.some((beat) => text(beat?.soundPlan).includes('静音') && !text(beat?.soundPlan).includes('设计'))) {
    warnings.push({
      code: 'unplanned-silence-risk',
      message: '声音计划出现静音描述，请确认是有意设计而不是生成失败。',
    })
  }

  return {
    type: 'episode-blueprint',
    canApprove: blockers.length === 0,
    blockers,
    warnings,
    summary: {
      targetDurationSeconds: Number.isFinite(duration) ? duration : null,
      emotionBeatCount: beats.length,
      shotCount: shotPlan.length,
      keyShotCount,
      normalShotCount,
      continuityConstraintCount: continuity.length,
    },
  }
}

export function buildProductionRunSeed(input = {}) {
  const normalized = normalizeProductionRunInput(input)
  const blueprint = input.blueprint || null
  const stages = PRODUCTION_RUN_STAGES.map((stage, index) => ({
    stageKey: stage.key,
    label: stage.label,
    agentKey: stage.agentKey,
    sequenceNo: index + 1,
    status: index === 0 ? 'waiting_approval' : 'blocked',
    inputSnapshot: index === 0
      ? {
          platform: normalized.platform,
          episodeNo: normalized.episodeNo,
          successMetrics: normalized.successMetrics,
        }
      : null,
    outputSnapshot: null,
    errorText: null,
  }))

  const checkpoints = [...CHECKPOINT_KEYS].map((checkpointKey, index) => ({
    checkpointKey,
    stageKey: PRODUCTION_RUN_STAGES.find((stage) => stage.checkpointKey === checkpointKey)?.key || null,
    status: index === 0 ? 'pending' : 'blocked',
    decisionNote: null,
  }))

  return {
    run: {
      projectId: normalized.projectId,
      platform: normalized.platform,
      episodeNo: normalized.episodeNo,
      status: 'waiting_approval',
      currentStage: PRODUCTION_RUN_STAGES[0].key,
      currentCheckpoint: checkpoints[0]?.checkpointKey || null,
      budget: normalized.budget,
      pilotSceneCount: normalized.pilotSceneCount,
      pilotMode: normalized.pilotMode,
      candidatePolicy: normalized.candidatePolicy,
      successMetrics: normalized.successMetrics,
      inputSnapshot: {
        platform: normalized.platform,
        episodeNo: normalized.episodeNo,
        budget: normalized.budget,
        pilotSceneCount: normalized.pilotSceneCount,
        pilotMode: normalized.pilotMode,
        candidatePolicy: normalized.candidatePolicy,
        successMetrics: normalized.successMetrics,
      },
      outputSnapshot: blueprint ? { blueprint } : null,
    },
    stages,
    checkpoints,
  }
}
