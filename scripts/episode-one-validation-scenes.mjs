import { REFERENCE_REMAKE_PLAN } from './episode-one-reference-plan.mjs'

export const EPISODE_ONE_VALIDATION_SCENES = [
  {
    key: 'scene-one-broadcast-awakening',
    title: '场景一：广播机第一次启动',
    shotKeys: ['s1-01', 's1-02', 's1-03', 's1-04', 's1-05'],
    storyboardIdOverrides: {
      's1-01': 267,
      's1-02': 283,
      's1-03': 268,
      's1-04': 269,
      's1-05': 270,
    },
    durationRangeSeconds: [12, 18],
    qualityFocus: ['1～3 秒异常钩子', '动作连续', '冷静到警觉'],
  },
  {
    key: 'scene-two-memory-hit',
    title: '场景二：六。别怕，小夏',
    shotKeys: ['s2-08', 's2-09', 's2-10', 's2-11', 's2-12', 's2-13', 's2-14', 's2-15', 's2-16', 's2-17'],
    storyboardIdOverrides: {
      's2-08': 187,
      's2-09': 284,
      's2-10': 285,
      's2-11': 286,
      's2-12': 287,
      's2-13': 288,
      's2-14': 289,
      's2-15': 290,
      's2-16': 291,
      's2-17': 292,
    },
    durationRangeSeconds: [20, 28],
    qualityFocus: ['六完整可听', '五明确省略', '四独立可听', '恐惧到主动靠近'],
  },
]

export function resolveValidationScene(scene, plan = REFERENCE_REMAKE_PLAN) {
  const byKey = new Map(plan.map((shot) => [shot.key, shot]))
  const shots = scene.shotKeys.map((key) => byKey.get(key)).filter(Boolean)
  const missingShotKeys = scene.shotKeys.filter((key) => !byKey.has(key))
  const storyboardIds = shots
    .map((shot) => Number(shot.storyboardId || scene.storyboardIdOverrides?.[shot.key]))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  const durationSeconds = shots.reduce(
    (sum, shot) => sum + Number(shot.durationSeconds || 0),
    0,
  )
  const dialogue = shots.map((shot) => String(shot.dialogueText || '')).join('\n')

  return {
    ...scene,
    shots,
    missingShotKeys,
    storyboardIds,
    durationSeconds,
    dialogue,
    valid:
      missingShotKeys.length === 0 &&
      shots.length === scene.shotKeys.length &&
      durationSeconds >= scene.durationRangeSeconds[0] &&
      durationSeconds <= scene.durationRangeSeconds[1],
  }
}

export function validateEpisodeOneValidationScenes(
  scenes = EPISODE_ONE_VALIDATION_SCENES,
  plan = REFERENCE_REMAKE_PLAN,
) {
  const errors = []
  const resolved = scenes.map((scene) => resolveValidationScene(scene, plan))

  for (const scene of resolved) {
    if (!scene.valid) {
      errors.push(
        `${scene.key} 不满足镜头或时长约束：缺失 ${scene.missingShotKeys.join(', ') || '无'}，时长 ${scene.durationSeconds}s`,
      )
    }
  }

  const memoryScene = resolved.find((scene) => scene.key === 'scene-two-memory-hit')
  if (memoryScene) {
    if (!memoryScene.dialogue.includes('苏岚（广播）：六。别怕，小夏。')) {
      errors.push('场景二必须包含完整的“六。别怕，小夏。”')
    }
    if (/苏岚（广播）：五/.test(memoryScene.dialogue)) {
      errors.push('场景二不能生成苏岚广播“五”')
    }
    if (!memoryScene.dialogue.includes('苏岚（广播）：四。')) {
      errors.push('场景二必须包含独立的广播“四”')
    }
  }

  return { valid: errors.length === 0, errors, scenes: resolved }
}

const validation = validateEpisodeOneValidationScenes()
if (!validation.valid) {
  throw new Error(`第一集验证场景无效：${validation.errors.join('；')}`)
}
