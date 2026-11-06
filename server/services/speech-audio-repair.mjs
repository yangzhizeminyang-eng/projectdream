const APPLY_TOKEN = 'REGENERATE_MISSING_SPEECH_AUDIO'
const SPEECH_TRACKS = new Set(['dialogue', 'narration'])

function numberOption(args, name) {
  const prefix = `--${name}=`
  const raw = args.find((item) => item.startsWith(prefix))?.slice(prefix.length)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function normalizeMissingSpeechAudioRepairArgs(args = []) {
  const projectId = numberOption(args, 'project-id')
  const audioId = numberOption(args, 'audio-id')
  const apply = args.includes('--apply')
  const confirm = args.includes(`--confirm=${APPLY_TOKEN}`)
  if (apply && !confirm) {
    throw new Error(`--apply requires --confirm=${APPLY_TOKEN}`)
  }
  return {
    projectId,
    audioId,
    apply,
    confirm,
  }
}

function text(value) {
  return String(value || '').trim()
}

function positive(value) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function buildMissingSpeechAudioRepairPlan({
  sourceAudio = {},
  storageProbe = {},
  legacyProbe = {},
  runtime = {},
} = {}) {
  const blockers = []
  const trackType = text(sourceAudio.trackType)
  const projectId = positive(sourceAudio.projectId)
  const sourceAudioId = positive(sourceAudio.id)
  const storyboardId = positive(sourceAudio.storyboardId)
  const speechText = text(sourceAudio.speechText)
  const title = text(sourceAudio.title) || `音频 #${sourceAudioId || '未知'}`

  if (!projectId || !sourceAudioId) blockers.push('源音频 ID 或项目 ID 无效。')
  if (!SPEECH_TRACKS.has(trackType)) blockers.push('只允许修复对白或旁白音频。')
  if (text(sourceAudio.status) !== 'confirmed') blockers.push('只允许修复当前已确认主音频。')
  if (!storyboardId) blockers.push('缺失 storyboardId，不能作为单条终剪语音源修复。')
  if (!speechText) blockers.push('缺失可重新合成的对白/旁白文本。')
  if (storageProbe.status === 'present') blockers.push('原对象仍可读取，应优先复用或校验，不应重新生成。')
  if (legacyProbe.found) blockers.push('旧本地文件仍存在，应优先单条回填，不应重新生成。')
  if (runtime.mock) blockers.push('当前音频运行时是 mock，不能用于真实修复。')
  if (!runtime.ready) blockers.push('真实音频运行时未就绪。')

  return {
    action: 'regenerate-single-speech-audio',
    canApply: blockers.length === 0,
    projectId,
    sourceAudioId,
    trackType,
    storyboardId,
    title,
    speechText,
    voiceName: text(sourceAudio.voiceName) || null,
    modelName: text(sourceAudio.modelName) || null,
    blockers,
  }
}
