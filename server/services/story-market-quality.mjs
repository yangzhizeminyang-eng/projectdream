const GENERIC_TEXT = /^(故事开始了|这一集结束了|主角继续调查|事情发生了|等待事情发生)[。.!！?？\s]*$/i
const OPENING_EVENT_SIGNAL = /突然|发现|失踪|死亡|尸体|求救|被抓|曝光|倒计时|婚礼|直播|闯入|砸门|断电|改口|开口/
const CONFLICT_SIGNAL = /阻止|封锁|逼|威胁|追杀|对抗|争夺|反派|否则|代价|选择|陷阱|质问|指认|起诉|封锁/
const ACTIVE_CHOICE_SIGNAL = /选择|拒绝|决定|公开|闯入|追查|交换|揭开|救下|反击|逃离|承认|销毁|上传|报警|签下/
const IRREVERSIBLE_CHANGE_SIGNAL = /失去|暴露|公开|被捕|被起诉|决裂|死亡|受伤|身份|全网|彻底|再也|无法|代价/
const REVERSAL_SIGNAL = /反转|原来|其实|却|竟然|不是|真相|身份|转向|幕后|照片|录音/
const ENDING_HOOK_SIGNAL = /秘密|电话|照片|录音|来电|出现|活着|死亡|身份|真相|幕后|倒计时|敲门|威胁|发来|留下/

function text(value) {
  return String(value || '').trim()
}

function hasSignal(value, pattern) {
  return pattern.test(text(value))
}

function isConcrete(value, minimumLength = 12) {
  const normalized = text(value)
  return normalized.length >= minimumLength && !GENERIC_TEXT.test(normalized)
}

function blocker(field, message) {
  return { field, message, severity: 'blocker' }
}

function warning(field, message) {
  return { field, message, severity: 'warning' }
}

function dimension(key, label, weight, score, passed) {
  return { key, label, weight, score, passed }
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
}

export function evaluateMarketEpisodeQuality(episode = {}) {
  const blockers = []
  const warnings = []
  const openingHook = text(episode.openingHook)
  const coreConflict = text(episode.coreConflict)
  const protagonistChoice = text(episode.protagonistChoice)
  const irreversibleChange = text(episode.irreversibleChange)
  const reversal = text(episode.reversal)
  const endingHook = text(episode.endingHook)
  const visualSetPieces = Array.isArray(episode.visualSetPieces)
    ? episode.visualSetPieces.map(text).filter(Boolean)
    : []

  const openingPassed =
    isConcrete(openingHook) && hasSignal(openingHook, OPENING_EVENT_SIGNAL)
  if (!openingPassed) {
    blockers.push(
      blocker(
        'openingHook',
        '开场钩子必须在第一句交代具体异常事件、人物目标或立即风险，不能只写“故事开始了”。',
      ),
    )
  }

  const conflictPassed =
    isConcrete(coreConflict) && hasSignal(coreConflict, CONFLICT_SIGNAL)
  if (!conflictPassed) {
    blockers.push(
      blocker(
        'coreConflict',
        '核心冲突必须明确阻力、对手或代价，观众要知道主角正在和谁争什么。',
      ),
    )
  }

  const choicePassed =
    isConcrete(protagonistChoice, 10) && hasSignal(protagonistChoice, ACTIVE_CHOICE_SIGNAL)
  if (!choicePassed) {
    blockers.push(
      blocker(
        'protagonistChoice',
        '主角必须做出可拍摄的主动选择，不能只是等待、被动接受或继续调查。',
      ),
    )
  }

  const irreversiblePassed =
    isConcrete(irreversibleChange, 10) &&
    hasSignal(irreversibleChange, IRREVERSIBLE_CHANGE_SIGNAL)
  if (!irreversiblePassed) {
    blockers.push(
      blocker(
        'irreversibleChange',
        '每集必须产生不可逆后果，否则剧情会像流水账，无法支撑追更。',
      ),
    )
  }

  const reversalPassed = isConcrete(reversal, 8) && hasSignal(reversal, REVERSAL_SIGNAL)
  if (!reversalPassed) {
    blockers.push(
      blocker(
        'reversal',
        '每集至少需要一次信息反转、身份变化或线索方向变化。',
      ),
    )
  }

  const endingPassed =
    isConcrete(endingHook, 10) && hasSignal(endingHook, ENDING_HOOK_SIGNAL)
  if (!endingPassed) {
    blockers.push(
      blocker(
        'endingHook',
        '结尾必须留下新证据、新威胁或未解决问题，形成明确追更理由。',
      ),
    )
  }

  const visualPassed = visualSetPieces.length > 0
  if (!visualPassed) {
    blockers.push(
      blocker(
        'visualSetPieces',
        '至少配置一个可直接转成分镜的视觉场面，避免只有抽象对白没有画面记忆点。',
      ),
    )
  } else if (visualSetPieces.length < 2) {
    warnings.push(
      warning(
        'visualSetPieces',
        '当前只有一个可视化场面，建议增加第二个空间、道具或动作变化。',
      ),
    )
  }

  const dimensions = [
    dimension('opening-hook', '开场钩子', 25, openingPassed ? 25 : 0, openingPassed),
    dimension('conflict-and-stakes', '冲突与代价', 20, conflictPassed ? 20 : 0, conflictPassed),
    dimension('protagonist-agency', '主角主动性', 15, choicePassed ? 15 : 0, choicePassed),
    dimension('irreversible-change', '不可逆变化', 15, irreversiblePassed ? 15 : 0, irreversiblePassed),
    dimension('reversal', '信息反转', 15, reversalPassed ? 15 : 0, reversalPassed),
    dimension('ending-hook', '结尾追更钩子', 10, endingPassed ? 10 : 0, endingPassed),
  ]
  const score = clampScore(dimensions.reduce((total, item) => total + item.score, 0))

  return {
    type: 'market_episode',
    score,
    threshold: 80,
    canPass: blockers.length === 0 && score >= 80,
    blockers,
    warnings,
    dimensions,
    visualSetPieces,
  }
}

export function evaluateMarketSeasonQuality(season = {}) {
  const episodes = Array.isArray(season.episodes) ? season.episodes : []
  const episodeReports = episodes.map((episode) => evaluateMarketEpisodeQuality(episode))
  const blockers = []
  const warnings = []

  if (episodes.length === 0) {
    blockers.push(blocker('episodes', '至少需要一集内容才能进行爆款结构代理评估。'))
  }

  episodeReports.forEach((report, index) => {
    report.blockers.forEach((item) => {
      blockers.push({
        ...item,
        field: `episodes[${index}].${item.field}`,
      })
    })
    report.warnings.forEach((item) => {
      warnings.push({
        ...item,
        field: `episodes[${index}].${item.field}`,
      })
    })
  })

  const averageScore = episodeReports.length
    ? episodeReports.reduce((total, report) => total + report.score, 0) / episodeReports.length
    : 0
  const reversalCount = episodeReports.filter((report) =>
    report.dimensions.some((item) => item.key === 'reversal' && item.passed),
  ).length
  const endingHookCount = episodeReports.filter((report) =>
    report.dimensions.some((item) => item.key === 'ending-hook' && item.passed),
  ).length

  const dimensions = [
    dimension(
      'episode-average',
      '单集爆款结构平均分',
      70,
      Math.round(averageScore * 0.7),
      episodeReports.length > 0 && averageScore >= 80,
    ),
    dimension(
      'reversal-coverage',
      '反转覆盖率',
      15,
      episodeReports.length ? Math.round((reversalCount / episodeReports.length) * 15) : 0,
      episodeReports.length > 0 && reversalCount === episodeReports.length,
    ),
    dimension(
      'ending-hook-coverage',
      '结尾钩子覆盖率',
      15,
      episodeReports.length ? Math.round((endingHookCount / episodeReports.length) * 15) : 0,
      episodeReports.length > 0 && endingHookCount === episodeReports.length,
    ),
  ]
  const score = clampScore(dimensions.reduce((total, item) => total + item.score, 0))

  return {
    type: 'market_season',
    score,
    threshold: 80,
    canPass: blockers.length === 0 && score >= 80,
    blockers,
    warnings,
    dimensions,
    episodeReports,
    coverage: {
      episodeCount: episodes.length,
      reversalCount,
      endingHookCount,
    },
  }
}
